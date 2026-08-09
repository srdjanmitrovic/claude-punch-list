/**
 * Side panel controller.
 *
 * The side panel is a full extension page, so it can call chrome.tabs,
 * chrome.downloads and canvas APIs itself. That matters: cropping needs a
 * canvas and saving needs URL.createObjectURL, and neither is available in an
 * MV3 service worker. Doing this work here keeps the worker thin and avoids
 * shuttling multi-megabyte data URLs across the message boundary.
 */

import { buildPrompt } from '../shared/prompt-template.js';

const SAVE_FOLDER = 'claude-debug';
const SLOW_DOWNLOAD_HINT_MS = 2500;
const ARM_TIMEOUT_MS = 3000; // cap on waiting for an in-flight arm to settle
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000; // how long an uncopied description survives

const el = {
  statusDot: document.getElementById('status-dot'),
  targetUrl: document.getElementById('target-url'),
  banner: document.getElementById('banner'),

  modeRegion: document.getElementById('mode-region'),
  modeElement: document.getElementById('mode-element'),
  modeVisible: document.getElementById('mode-visible'),

  preview: document.getElementById('preview'),
  previewEmpty: document.getElementById('preview-empty'),
  previewImg: document.getElementById('preview-img'),
  previewClear: document.getElementById('preview-clear'),
  previewMeta: document.getElementById('preview-meta'),

  description: document.getElementById('description'),

  incConsole: document.getElementById('inc-console'),
  incNetwork: document.getElementById('inc-network'),
  incElement: document.getElementById('inc-element'),
  incPage: document.getElementById('inc-page'),
  countConsole: document.getElementById('count-console'),
  countNetwork: document.getElementById('count-network'),
  countElement: document.getElementById('count-element'),
  collectorWarning: document.getElementById('collector-warning'),
  refreshContext: document.getElementById('refresh-context'),

  submit: document.getElementById('submit'),
  submitLabel: document.getElementById('submit-label'),
  result: document.getElementById('result'),
  resultText: document.getElementById('result-text'),
  resultPath: document.getElementById('result-path'),
  copyAgain: document.getElementById('copy-again'),
  reveal: document.getElementById('reveal'),
  previewPromptBtn: document.getElementById('preview-prompt'),
  promptPreview: document.getElementById('prompt-preview'),

  clearBuffers: document.getElementById('clear-buffers'),
  version: document.getElementById('version'),
};

const state = {
  tab: null,
  restriction: null,
  armedMode: null, // 'region' | 'element' | null
  armedTabId: null, // which tab that arm was issued against
  armPending: null, // in-flight cdr:arm, so a fast cancel cannot overtake it
  capture: null, // { dataUrl, width, height, mode }
  captureUrl: '', // page URL at capture time, to detect navigation before save
  captureTabId: null,
  element: null, // payload from picker.js
  context: null, // { page, collected }
  lastDownloadId: null,
  lastPrompt: '',
  busy: false,
};

// ---------------------------------------------------------------- helpers --

function showBanner(message, kind = 'warn') {
  if (!message) {
    el.banner.hidden = true;
    return;
  }
  el.banner.textContent = message;
  el.banner.className = kind === 'error' ? 'notice error' : 'notice';
  el.banner.hidden = false;
}

function setCount(node, value) {
  node.textContent = value === 0 || value ? String(value) : '–';
  node.classList.toggle('has', Boolean(value));
}

/**
 * Single source of truth for which capture mode is waiting on which tab.
 *
 * The tab id matters because arming is per-tab but the panel is per-window: a
 * mode armed on tab A must not read as armed once the user switches to tab B.
 */
function setArmed(mode, tabId = null) {
  state.armedMode = mode;
  state.armedTabId = mode ? tabId : null;
  for (const [name, node] of [
    ['region', el.modeRegion],
    ['element', el.modeElement],
  ]) {
    node.classList.toggle('armed', name === mode);
  }
}

function timestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

/**
 * Copy text, with fallbacks.
 *
 * The only precondition Chromium enforces for a sanitized clipboard write from
 * an extension page is document.hasFocus(); there is no transient-activation
 * gate, so awaiting the file save beforehand is fine. What does break it is a
 * "Save as" dialog having stolen focus from the panel, hence the wait below.
 * execCommand('copy') needs focus too, so it only covers a different set of
 * failures; showing the text for a manual copy is the real backstop.
 *
 * @returns {Promise<'clipboard'|'execCommand'|null>}
 */
async function copyText(text) {
  if (!document.hasFocus()) {
    await new Promise((resolve) => {
      const done = () => {
        window.removeEventListener('focus', done);
        resolve();
      };
      window.addEventListener('focus', done);
      setTimeout(done, 3000); // do not hang forever if focus never returns
    });
  }

  try {
    await navigator.clipboard.writeText(text);
    return 'clipboard';
  } catch {
    /* activation expired or focus is elsewhere; try the legacy path */
  }

  try {
    const scratch = document.createElement('textarea');
    scratch.value = text;
    scratch.setAttribute('readonly', '');
    scratch.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0';
    document.body.appendChild(scratch);
    scratch.select();
    scratch.setSelectionRange(0, text.length);
    const copied = document.execCommand('copy');
    document.body.removeChild(scratch);
    if (copied) return 'execCommand';
  } catch {
    /* fall through to manual */
  }

  return null;
}

function slugFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, '');
    const path = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean).slice(-1)[0] || '';
    return `${host}${path ? '-' + path : ''}`
      .replace(/[^a-z0-9._-]+/gi, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'page';
  } catch {
    return 'page';
  }
}

// ------------------------------------------------------------------- tab --

async function resolveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab || null;

  // Arming is per-tab. Switching tabs would otherwise leave the button lit for
  // an overlay that is still live on a page no longer in view, and the next
  // click on it would be swallowed by the cancel branch.
  if (state.armedMode && state.armedTabId !== (tab?.id ?? null)) {
    const stale = state.armedTabId;
    const inFlight = state.armPending;
    setArmed(null);
    if (stale != null) {
      // Chain behind any arm still in flight for that tab. Sending the disarm
      // immediately can beat the arm's injection, stopping a controller that
      // does not exist yet and orphaning the overlay on the page the user just
      // left, where only Esc would clear it.
      Promise.resolve(inFlight)
        .catch(() => {})
        .then(() => chrome.runtime.sendMessage({ type: 'cdr:disarm', tabId: stale }))
        .catch(() => {});
    }
  }

  if (!tab) {
    el.targetUrl.textContent = 'No active tab';
    el.statusDot.className = 'dot blocked';
    return;
  }

  el.targetUrl.textContent = tab.url || tab.pendingUrl || '(no url)';
  el.targetUrl.title = tab.url || '';

  const response = await chrome.runtime.sendMessage({ type: 'cdr:check-tab', tabId: tab.id });
  state.restriction = response?.restriction || null;

  // The worker tracks which tab has an overlay waiting. Adopting it here covers
  // the case a one-shot broadcast cannot: Alt+Shift+C arms the page and opens
  // the panel together, so the cdr:armed message can be sent before this
  // document exists to hear it.
  if (response?.armedMode && !state.armedMode) {
    setArmed(response.armedMode, tab.id);
  }

  el.statusDot.className = state.restriction ? 'dot blocked' : 'dot ready';
  showBanner(state.restriction, state.restriction ? 'error' : 'warn');

  const disabled = Boolean(state.restriction);
  el.modeRegion.disabled = disabled;
  el.modeElement.disabled = disabled;
  el.modeVisible.disabled = disabled;

  refreshContext();
}

// --------------------------------------------------------------- capture --

async function captureViewport() {
  // captureVisibleTab is rate limited to roughly two calls per second across
  // the whole extension. Captures here are user-initiated so collisions are
  // rare, but a double-click on a mode button would hit it.
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await chrome.tabs.captureVisibleTab(state.tab.windowId, { format: 'png' });
    } catch (error) {
      lastError = error;
      if (!/MAX_CAPTURE|quota|too many/i.test(String(error?.message))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  }
  throw lastError;
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not decode the captured image.'));
    image.src = dataUrl;
  });
}

/**
 * Crop a viewport screenshot down to a CSS-pixel rect.
 *
 * The scale factor is derived from the captured bitmap rather than trusting
 * devicePixelRatio, because browser zoom also changes the ratio between CSS
 * pixels and captured pixels and devicePixelRatio alone would be wrong.
 */
async function cropCapture(fullDataUrl, rect, viewport) {
  const image = await loadImage(fullDataUrl);
  const scale = viewport?.width ? image.naturalWidth / viewport.width : 1;

  const sx = Math.max(0, Math.round(rect.x * scale));
  const sy = Math.max(0, Math.round(rect.y * scale));
  const sw = Math.max(1, Math.min(Math.round(rect.width * scale), image.naturalWidth - sx));
  const sh = Math.max(1, Math.min(Math.round(rect.height * scale), image.naturalHeight - sy));

  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  canvas.getContext('2d').drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);

  return { dataUrl: canvas.toDataURL('image/png'), width: sw, height: sh };
}

function setCapture(capture) {
  // An element payload only belongs to the capture it was picked with. Left in
  // place, a later Region or Screen shot would ship someone else's element
  // markup alongside an unrelated screenshot.
  if (capture.mode !== 'element') state.element = null;

  // Remember where and when this was taken, so saveAndCopy can tell whether the
  // page has moved on since.
  state.captureUrl = state.tab?.url || '';
  state.captureTabId = state.tab?.id ?? null;

  state.capture = capture;
  el.previewImg.src = capture.dataUrl;
  el.previewImg.hidden = false;
  el.previewEmpty.hidden = true;
  el.previewClear.hidden = false;
  el.preview.classList.add('filled');

  // Terse, like a viewfinder readout rather than a sentence.
  const label = { region: 'REGION', element: 'ELEMENT', visible: 'SCREEN' }[capture.mode];
  el.previewMeta.textContent = `${label} ${capture.width}×${capture.height}`;
  el.previewMeta.hidden = false;

  setArmed(null);
  updateSubmitState();
  refreshContext();
}

/**
 * Empty the frame, leaving the receipt alone.
 *
 * Split out because the two callers disagree about the receipt. The × on the
 * frame means "start over", so it takes the receipt down with it; the reset
 * after a copy must not, since the saved path and Copy again are the only
 * handles left on the report that just went out.
 */
function clearCapture() {
  state.capture = null;
  state.element = null;
  state.captureUrl = '';
  state.captureTabId = null;
  el.previewImg.hidden = true;
  el.previewImg.removeAttribute('src');
  el.previewEmpty.hidden = false;
  el.previewClear.hidden = true;
  el.previewMeta.hidden = true;
  el.preview.classList.remove('filled');
  setCount(el.countElement, null);
  updateSubmitState();
}

function discardCapture() {
  clearCapture();
  el.result.hidden = true;
  el.promptPreview.hidden = true;
}

/**
 * Retire the inputs once a report has actually reached the clipboard.
 *
 * The draft is written to storage on every keystroke so that closing the panel
 * cannot lose it, and a side panel is closed constantly. The cost of that
 * durability is that a description outlives the report it was written for and
 * comes back, stale, against an unrelated screenshot days later. A successful
 * copy is the moment it has served its purpose, so that is where it is dropped.
 *
 * Deliberately not called when the clipboard was blocked, nor when the save
 * failed: in both cases the user is still mid-report and may need to retry, and
 * clearing the inputs out from under them would destroy the work.
 */
function resetAfterCopy() {
  el.description.value = '';
  clearCapture();
  persist();
}

async function arm(mode) {
  if (state.restriction || !state.tab) return;
  showBanner(null);

  // Wait for any arm/disarm already in flight. Without this, double-clicking a
  // mode button can land the disarm before the arm it was meant to cancel:
  // arm() awaits a tabs.get in the worker while disarm() does not, so on a cold
  // service worker the second click overtakes the first and the page is left
  // with a live overlay the panel thinks it cancelled.
  //
  // Bounded, because executeScript never settles against a wedged renderer.
  // That is precisely the kind of page this extension exists to report on, and
  // an unbounded await would leave both mode buttons dead with no explanation.
  if (state.armPending) {
    await Promise.race([
      state.armPending.catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, ARM_TIMEOUT_MS)),
    ]);
  }

  // Clicking the already-armed mode cancels it, which is what the highlighted
  // button reads as. Only treat it as a cancel when the arm belongs to the tab
  // currently in view; otherwise it is a fresh arm for a different page.
  if (state.armedMode === mode && state.armedTabId === state.tab.id) {
    const target = state.armedTabId;
    setArmed(null);
    chrome.runtime.sendMessage({ type: 'cdr:disarm', tabId: target }).catch(() => {});
    return;
  }

  setArmed(mode, state.tab.id);

  const request = chrome.runtime.sendMessage({
    type: 'cdr:arm',
    mode,
    tabId: state.tab.id,
  });
  state.armPending = request;

  try {
    const response = await request;
    if (!response?.ok) {
      setArmed(null);
      showBanner(response?.error || 'Could not start capture on this tab.', 'error');
    }
  } catch (error) {
    // sendMessage rejects outright if the worker is torn down mid-request, for
    // instance when the extension is reloaded. Without this the button would
    // stay lit over a page with no overlay, and the next click would read as a
    // cancel rather than arming.
    setArmed(null);
    showBanner(error?.message || 'Could not start capture on this tab.', 'error');
  } finally {
    if (state.armPending === request) state.armPending = null;
  }
}

async function captureVisible() {
  if (state.restriction) return;
  try {
    showBanner(null);
    const dataUrl = await captureViewport();
    const image = await loadImage(dataUrl);
    setCapture({
      dataUrl,
      width: image.naturalWidth,
      height: image.naturalHeight,
      mode: 'visible',
    });
  } catch (error) {
    showBanner(error?.message || 'Screenshot failed.', 'error');
  }
}

// --------------------------------------------------------------- context --

async function refreshContext() {
  if (!state.tab || state.restriction) {
    setCount(el.countConsole, null);
    setCount(el.countNetwork, null);
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(state.tab.id, { type: 'cdr:get-context' });
    state.context = response;
    el.collectorWarning.hidden = !response?.collected?.unavailable;

    const collected = response?.collected || {};
    setCount(
      el.countConsole,
      (collected.console?.length || 0) + (collected.errors?.length || 0)
    );
    setCount(el.countNetwork, collected.network?.length || 0);
  } catch {
    // No content script in this tab: it was loaded before the extension was
    // installed or enabled. A reload arms it.
    state.context = null;
    el.collectorWarning.hidden = false;
    setCount(el.countConsole, null);
    setCount(el.countNetwork, null);
  }

  setCount(el.countElement, state.element ? 1 : null);
}

// ----------------------------------------------------------------- saving --

/**
 * Wait for the download to finish and return its absolute path.
 *
 * Polls rather than listening to downloads.onChanged: a blob download often
 * completes before a listener attached after download() could ever observe the
 * state change, and polling has no such race.
 *
 * There is deliberately no overall timeout. If the user has "Ask where to save
 * each file" enabled, a dialog can sit open for minutes, and giving up would
 * throw away a path that is still coming. The loop ends when Chrome reports
 * 'complete' or 'interrupted'; cancelling the dialog produces the latter with
 * error USER_CANCELED. Closing the panel tears the whole page down anyway.
 */
async function waitForDownloadPath(downloadId) {
  const started = Date.now();
  let hintShown = false;
  let missing = 0;

  for (;;) {
    const [item] = await chrome.downloads.search({ id: downloadId });

    if (item?.state === 'complete') return item.filename;
    if (item?.state === 'interrupted') {
      throw new Error(`Download failed: ${item.error || 'interrupted'}`);
    }

    if (!item) {
      // The record should always exist; if it has vanished (erased from
      // history mid-flight) nothing will ever resolve, so stop.
      missing += 1;
      if (missing > 20) throw new Error('Chrome lost track of the download.');
    } else {
      missing = 0;
    }

    if (!hintShown && Date.now() - started > SLOW_DOWNLOAD_HINT_MS) {
      hintShown = true;
      showBanner(
        'Waiting on Chrome. If a "Save as" dialog opened, confirm it, or turn off ' +
          '"Ask where to save each file" in chrome://settings/downloads.'
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function saveScreenshot(dataUrl) {
  const filename = `${SAVE_FOLDER}/${timestamp()}_${slugFromUrl(state.tab?.url || '')}.png`;
  const blob = await (await fetch(dataUrl)).blob();

  // URL.createObjectURL does not exist in an MV3 service worker, which is the
  // other reason this whole path lives in the panel rather than the worker.
  const objectUrl = URL.createObjectURL(blob);
  let downloadId;

  try {
    downloadId = await chrome.downloads.download({
      url: objectUrl,
      filename,
      conflictAction: 'uniquify',
      // saveAs is omitted deliberately: passing false is not the same as
      // leaving it out, and leaving it out respects the user's Chrome setting.
    });
  } finally {
    // Safe to revoke as soon as download() has resolved. Chrome captures a
    // strong reference to the blob while setting the download up, so the write
    // does not depend on the URL still being live, and holding it would leak
    // the whole image for the lifetime of the panel.
    URL.revokeObjectURL(objectUrl);
  }

  state.lastDownloadId = downloadId;
  return waitForDownloadPath(downloadId);
}

/**
 * Detect a screenshot that no longer describes the page it will be reported
 * against. The image is a moment in time; the console buffers and URL are read
 * at save time, so a reload or navigation in between makes them disagree.
 */
function staleCaptureUrl() {
  const current = state.context?.page?.url || state.tab?.url || '';
  if (!state.captureUrl || !current) return null;
  if (state.captureTabId !== null && state.captureTabId !== state.tab?.id) {
    return state.captureUrl;
  }
  return current === state.captureUrl ? null : state.captureUrl;
}

function assembleReport(screenshotPath) {
  const collected = state.context?.collected || {};
  return {
    description: el.description.value,
    screenshotPath,
    pageChangedFrom: staleCaptureUrl(),
    page: el.incPage.checked ? state.context?.page : null,
    consoleLines: el.incConsole.checked ? collected.console || [] : [],
    errors: el.incConsole.checked ? collected.errors || [] : [],
    network: el.incNetwork.checked ? collected.network || [] : [],
    element: el.incElement.checked ? state.element : null,
    capturedAt: new Date().toLocaleString(),
  };
}

async function saveAndCopy() {
  if (state.busy || !state.capture) return;
  state.busy = true;
  el.submit.classList.add('busy');
  el.submit.disabled = true;
  el.submitLabel.textContent = 'Saving…';
  showBanner(null);

  try {
    await refreshContext();

    const path = await saveScreenshot(state.capture.dataUrl);
    const prompt = buildPrompt(assembleReport(path));
    state.lastPrompt = prompt;

    const method = await copyText(prompt);

    // The action keeps its name through the flow: the button says Copy, so the
    // confirmation says Copied.
    el.resultText.textContent = method
      ? 'Copied. Paste into Claude Code.'
      : 'Saved. The clipboard was blocked, so copy the prompt below.';
    el.resultPath.textContent = path;
    el.result.hidden = false;
    el.promptPreview.textContent = prompt;
    el.promptPreview.hidden = Boolean(method);
    showBanner(null);

    // The prompt is already captured in state.lastPrompt and in the hidden
    // proof block, so Copy again and Read prompt keep working against an
    // emptied panel.
    if (method) resetAfterCopy();
  } catch (error) {
    // Saving the image failed, but the assembled text is still worth having,
    // so fall back to a prompt with no screenshot path rather than nothing.
    const prompt = buildPrompt(assembleReport(null));
    state.lastPrompt = prompt;
    const method = await copyText(prompt);

    showBanner(
      `${error?.message || error}${
        method ? ' Copied a prompt without the screenshot path instead.' : ''
      }`,
      'error'
    );
    el.resultText.textContent = method ? 'Copied without screenshot' : 'Copy the prompt below';
    el.resultPath.textContent = '(no file saved)';
    el.result.hidden = false;
    el.promptPreview.textContent = prompt;
    el.promptPreview.hidden = Boolean(method);
  } finally {
    state.busy = false;
    el.submit.classList.remove('busy');
    // Must match the label in panel.html: this runs after every save.
    el.submitLabel.textContent = 'Copy for Claude Code';
    updateSubmitState();
  }
}

function updateSubmitState() {
  el.submit.disabled = state.busy || !state.capture;
}

// ------------------------------------------------------------ persistence --

function persist() {
  chrome.storage.local.set({
    cdrDraft: el.description.value,
    // Rewritten on every keystroke, so age is measured from the last edit
    // rather than from whenever the description was started.
    cdrDraftAt: Date.now(),
    cdrInclude: {
      console: el.incConsole.checked,
      network: el.incNetwork.checked,
      element: el.incElement.checked,
      page: el.incPage.checked,
    },
  });
}

/**
 * Restore the panel, dropping a description that has gone stale.
 *
 * resetAfterCopy retires the draft that was used. This covers the one that was
 * not: text typed against a bug, never copied, still in the textarea against an
 * unrelated page later. Past a day that is far more likely to be forgotten
 * debris than work in progress.
 *
 * Only ever applied here, at startup. A panel left open for a week keeps its
 * text, because pulling a description out from under someone looking at it
 * would be worse than the staleness this is meant to fix.
 */
async function restore() {
  const stored = await chrome.storage.local.get(['cdrDraft', 'cdrDraftAt', 'cdrInclude']);

  const draft = typeof stored.cdrDraft === 'string' ? stored.cdrDraft : '';
  const savedAt = stored.cdrDraftAt;
  const expired = typeof savedAt === 'number' && Date.now() - savedAt > DRAFT_TTL_MS;

  // Drop it from storage rather than merely declining to show it, so a stale
  // draft cannot outlive the check that rejected it.
  if (expired) chrome.storage.local.remove(['cdrDraft', 'cdrDraftAt']);
  else el.description.value = draft;

  const include = stored.cdrInclude;
  if (include) {
    el.incConsole.checked = include.console !== false;
    el.incNetwork.checked = include.network !== false;
    el.incElement.checked = include.element !== false;
    el.incPage.checked = include.page !== false;
  }

  // A draft written before this build carries no stamp, so its real age is
  // unknown. Stamping it now starts the clock instead of discarding text that
  // may have been typed minutes before the extension updated. Runs after the
  // toggles are restored, since persist writes those too.
  if (el.description.value && savedAt === undefined) persist();
}

// ---------------------------------------------------------------- wiring --

function handleBroadcast(message) {
  if (message.type === 'cdr:armed') {
    setArmed(message.mode, message.tabId);
    return;
  }

  if (message.type === 'cdr:region-selected') {
    captureViewport()
      .then((full) => cropCapture(full, message.rect, message.viewport))
      .then((cropped) => setCapture({ ...cropped, mode: 'region' }))
      .catch((error) => {
        setArmed(null);
        showBanner(error?.message || 'Region capture failed.', 'error');
      });
  }

  if (message.type === 'cdr:element-picked') {
    state.element = message.element;
    captureViewport()
      .then((full) => cropCapture(full, message.rect, message.viewport))
      .then((cropped) => setCapture({ ...cropped, mode: 'element' }))
      .catch((error) => {
        setArmed(null);
        showBanner(error?.message || 'Element capture failed.', 'error');
      });
  }

  if (message.type === 'cdr:capture-cancelled') {
    setArmed(null);
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message.type !== 'string') return;

  // chrome.runtime.sendMessage has no addressing: a content script's broadcast
  // reaches EVERY open side panel, and side panels are per-window. Without a
  // guard, dragging a region in window 1 makes window 2's panel screenshot its
  // own tab, crop it to window 1's rectangle, and present that as a valid
  // capture. Nothing errors, so the mismatch is silent.
  //
  // cdr:armed comes from the service worker, which has no sender.tab, and
  // carries the tab id in its payload instead.
  const originTabId = sender?.tab?.id ?? message.tabId;

  // Compare only once the panel knows which tab it is looking at. Alt+Shift+C
  // opens the panel and arms the page in the same breath, so the first message
  // can beat resolveTab and would otherwise be dropped for not matching a tab
  // id that is still null.
  ready.then(() => {
    if (originTabId != null && originTabId !== state.tab?.id) return;
    handleBroadcast(message);
  });
});

el.modeRegion.addEventListener('click', () => arm('region'));
el.modeElement.addEventListener('click', () => arm('element'));
el.modeVisible.addEventListener('click', captureVisible);
el.previewClear.addEventListener('click', discardCapture);
el.submit.addEventListener('click', saveAndCopy);
el.refreshContext.addEventListener('click', refreshContext);
el.description.addEventListener('input', persist);

for (const toggle of [el.incConsole, el.incNetwork, el.incElement, el.incPage]) {
  toggle.addEventListener('change', persist);
}

el.copyAgain.addEventListener('click', async () => {
  if (!state.lastPrompt) return;
  const method = await copyText(state.lastPrompt);
  el.resultText.textContent = method ? 'Copied again.' : 'Clipboard blocked. Copy from below.';
  if (!method) el.promptPreview.hidden = false;
});

el.reveal.addEventListener('click', () => {
  if (state.lastDownloadId != null) chrome.downloads.show(state.lastDownloadId);
});

el.previewPromptBtn.addEventListener('click', () => {
  el.promptPreview.hidden = !el.promptPreview.hidden;
});

el.clearBuffers.addEventListener('click', async () => {
  if (!state.tab) return;
  try {
    await chrome.tabs.sendMessage(state.tab.id, { type: 'cdr:clear-context' });
    await refreshContext();
    showBanner(null);
  } catch {
    showBanner('No collector on this page to clear.', 'error');
  }
});

// Cmd/Ctrl+Enter submits without reaching for the mouse.
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    saveAndCopy();
  }
});

chrome.tabs.onActivated.addListener(resolveTab);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A navigation destroys any injected overlay, so the panel must stop claiming
  // this tab is armed. Otherwise the lit button would need two clicks to work.
  if (tabId === state.armedTabId && changeInfo.status === 'loading') setArmed(null);
  if (tabId === state.tab?.id && changeInfo.status === 'complete') resolveTab();
});

el.version.textContent = `v${chrome.runtime.getManifest().version}`;

// Startup. Declared last so it runs after every listener is wired, but consumed
// by the onMessage handler above, which defers until this settles rather than
// comparing against a tab id that has not been resolved yet.
const ready = restore().then(resolveTab);
