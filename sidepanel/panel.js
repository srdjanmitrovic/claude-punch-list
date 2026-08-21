/**
 * Side panel controller.
 *
 * The side panel is a full extension page, so it can call chrome.tabs,
 * chrome.downloads and canvas APIs itself. That matters: cropping needs a
 * canvas and saving needs URL.createObjectURL, and neither is available in an
 * MV3 service worker. Doing this work here keeps the worker thin and avoids
 * shuttling multi-megabyte data URLs across the message boundary.
 *
 * A report is a list of items. Each item is one capture with its own
 * description and intent, and the panel edits whichever one is in the frame.
 * Screenshots are written to disk the moment they are taken rather than when
 * the report is copied, so an item has a real path from the start, copying is
 * instant, and a half-built report survives the panel being closed.
 */

import { buildPrompt } from '../shared/prompt-template.js';

const SAVE_FOLDER = 'claude-punch-list';
const SLOW_DOWNLOAD_HINT_MS = 2500;
const ARM_TIMEOUT_MS = 3000; // cap on waiting for an in-flight arm to settle
const REPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // how long an uncopied report survives
const THUMB_MAX_WIDTH = 800; // the frame is never wider than this in device pixels
const THUMB_MAX_HEIGHT = 800; // and a tall element crop should not cost a megabyte
const THUMB_QUALITY = 0.85;

/**
 * Which panel wrote the report last.
 *
 * Side panels are per window, and every one of them persists to the same
 * storage keys. Each write is stamped with the writer so the others can tell
 * an echo of their own write from a change they need to adopt.
 */
const PANEL_ID = makeId();

function makeId() {
  // randomUUID is only defined in secure contexts. Extension pages always are;
  // the stage served over a LAN address is not.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * How the annotation field presents itself per intent.
 *
 * The prompt wording lives in shared/prompt-template.js; this is only the panel
 * asking the right question. Leaving it out would let someone answer "What's
 * wrong" while the prompt underneath says "What should change".
 *
 * The bug entry must match the markup in panel.html, which carries it as the
 * pre-restore default so the field is never briefly unlabelled.
 *
 * The worked example only appears under the first item. It teaches what a good
 * sentence looks like once; repeated under every empty item on a long sheet it
 * stops reading as a hint and starts reading as text somebody wrote.
 */
const INTENT_UI = {
  bug: {
    label: "What's wrong",
    example:
      'The total shows NaN once a coupon is applied. It should show the discounted price.',
    placeholder: 'What is wrong here, and what should happen instead?',
  },
  change: {
    label: 'What should change',
    example:
      'The coupon field should validate as you type instead of only on submit, so the ' +
      'discounted total updates inline.',
    placeholder: 'What should be different here?',
  },
};

// Terse, like a viewfinder readout rather than a sentence.
const MODE_LABEL = { region: 'REGION', element: 'ELEMENT', visible: 'SCREEN' };

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
  strip: document.getElementById('strip'),

  item: document.getElementById('item'),
  intentBug: document.getElementById('intent-bug'),
  intentChange: document.getElementById('intent-change'),
  descriptionLabel: document.getElementById('description-label'),
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
  submitCount: document.getElementById('submit-count'),
  result: document.getElementById('result'),
  resultText: document.getElementById('result-text'),
  resultPath: document.getElementById('result-path'),
  copyAgain: document.getElementById('copy-again'),
  reveal: document.getElementById('reveal'),
  previewPromptBtn: document.getElementById('preview-prompt'),
  promptPreview: document.getElementById('prompt-preview'),

  clearBuffers: document.getElementById('clear-buffers'),
  discardAll: document.getElementById('discard-all'),
  version: document.getElementById('version'),
};

/**
 * @typedef {Object} Item
 * @property {string}  id
 * @property {'region'|'element'|'visible'} mode
 * @property {number}  width        Captured size, in device pixels.
 * @property {number}  height
 * @property {string}  url          Page the item was captured on.
 * @property {string}  title
 * @property {number|null} tabId
 * @property {'bug'|'change'} intent
 * @property {string}  description
 * @property {Object|null} element  Payload from picker.js, element mode only.
 * @property {number}  capturedAt   Epoch ms.
 * @property {string|null} thumb    Downscaled image for the frame and the strip.
 *                                  The only copy of the pixels the panel keeps;
 *                                  the full PNG is on disk.
 * @property {string|null} path     Absolute path of that PNG. Null while saving,
 *                                  and an item is only persisted once it is set.
 * @property {number|null} downloadId
 * @property {boolean=} missing     Chrome reports the file gone from the disk.
 */

const state = {
  tab: null,
  restriction: null,
  intent: 'bug', // what the NEXT item starts as; sticky, like the toggles
  armedMode: null, // 'region' | 'element' | null
  armedTabId: null, // which tab that arm was issued against
  armPending: null, // in-flight cdr:arm, so a fast cancel cannot overtake it
  /** @type {Item[]} */
  items: [],
  selectedId: null, // the item in the frame, whose description the field edits
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

/**
 * Named rather than looked up, so a stored value that happens to name an
 * Object.prototype member cannot pass a check and then read as undefined.
 * Anything unrecognised, including the absent key on a pre-upgrade install,
 * falls back to the mode this extension started life as.
 */
function normalizeIntent(intent) {
  return intent === 'change' ? 'change' : 'bug';
}

/** Light the matching segment and re-ask the question to match. */
function showIntent(intent, { example = true } = {}) {
  for (const [name, node] of [
    ['bug', el.intentBug],
    ['change', el.intentChange],
  ]) {
    const on = name === intent;
    node.classList.toggle('on', on);
    node.setAttribute('aria-pressed', String(on));
  }

  const ui = INTENT_UI[intent];
  el.descriptionLabel.textContent = ui.label;
  // Only ever visible against an empty field, so swapping it cannot disturb
  // anything already typed.
  el.description.placeholder = example ? ui.example : ui.placeholder;
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
    const path = (url.pathname.replace(/\/+$/, '').split('/').filter(Boolean).slice(-1)[0] || '')
      // Drop a file extension, or the PNG ends up called page.html.png.
      .replace(/\.[a-z0-9]{1,5}$/i, '');
    return `${host}${path ? '-' + path : ''}`
      .replace(/[^a-z0-9._-]+/gi, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'page';
  } catch {
    return 'page';
  }
}

/** The directory part of an absolute path, on either kind of slash. */
function folderOf(path) {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut === -1 ? path : path.slice(0, cut + 1);
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

/**
 * The copy of the image the panel keeps.
 *
 * A full-screen capture on a Retina display is several megabytes as a data
 * URL, and a report can hold a dozen of them. Nothing in the panel ever shows
 * one larger than the frame, so the pixels are cut down to that before being
 * kept, and the original is let go once it is on disk. WebP because it is
 * roughly half the size of JPEG at the same quality and the canvas encoder
 * supports it everywhere this extension runs.
 */
async function makeThumb(dataUrl) {
  const image = await loadImage(dataUrl);
  const scale = Math.min(
    1,
    THUMB_MAX_WIDTH / image.naturalWidth,
    THUMB_MAX_HEIGHT / image.naturalHeight
  );
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/webp', THUMB_QUALITY);
}

// ----------------------------------------------------------------- items --

function selectedItem() {
  return state.items.find((item) => item.id === state.selectedId) || null;
}

function renderFrame() {
  const item = selectedItem();

  if (!item) {
    el.previewImg.hidden = true;
    el.previewImg.removeAttribute('src');
    el.previewEmpty.hidden = false;
    el.previewClear.hidden = true;
    el.previewMeta.hidden = true;
    el.preview.classList.remove('filled');
    return;
  }

  // An empty src is a request for the document itself, and the image shows its
  // alt text and a broken-image glyph while it fails.
  if (item.thumb) {
    el.previewImg.src = item.thumb;
    el.previewImg.hidden = false;
  } else {
    el.previewImg.removeAttribute('src');
    el.previewImg.hidden = true;
  }
  el.previewEmpty.hidden = true;
  el.previewClear.hidden = false;
  el.preview.classList.add('filled');

  const index = state.items.indexOf(item) + 1;
  const position = state.items.length > 1 ? `${index}/${state.items.length} · ` : '';
  const status = item.missing ? ' · FILE MISSING' : item.path ? '' : ' · SAVING';
  el.previewMeta.textContent = `${position}${MODE_LABEL[item.mode]} ${item.width}×${item.height}${status}`;
  el.previewMeta.hidden = false;
}

/** What a screen reader gets for a thumbnail; the number alone says nothing. */
function describeThumb(item, index) {
  const status = item.missing
    ? 'file missing'
    : item.description.trim()
      ? 'described'
      : 'no description yet';
  return `Item ${index + 1}, ${MODE_LABEL[item.mode].toLowerCase()}, ${status}`;
}

function renderStrip() {
  // The rebuild destroys the button that has focus. Putting focus back on the
  // selected thumbnail keeps a keyboard user where they were.
  const hadFocus = el.strip.contains(document.activeElement);

  el.strip.hidden = state.items.length === 0;
  el.strip.replaceChildren(
    ...state.items.map((item, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'thumb';
      button.classList.toggle('on', item.id === state.selectedId);
      button.classList.toggle('noted', Boolean(item.description.trim()));
      button.classList.toggle('missing', Boolean(item.missing));
      button.setAttribute('aria-pressed', String(item.id === state.selectedId));
      button.setAttribute('aria-label', describeThumb(item, index));
      button.title = `Item ${index + 1}`;

      const img = document.createElement('img');
      img.alt = '';
      if (item.thumb) img.src = item.thumb;

      const number = document.createElement('span');
      number.className = 'thumb-n';
      number.textContent = String(index + 1);

      button.append(img, number);
      button.addEventListener('click', () => selectItem(item.id));
      return button;
    })
  );

  const on = el.strip.querySelector('.thumb.on');
  on?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (hadFocus) on?.focus({ preventScroll: true });
}

/**
 * Bring an item into the frame and its words into the field.
 *
 * The intent segments follow the item too: they show what this item is, and
 * pressing one changes this item. The sticky default for the next capture is
 * updated at the same time, in the click handler, on the theory that someone
 * who just marked an item as a suggestion is probably about to mark another.
 */
function selectItem(id) {
  state.selectedId = id;
  const item = selectedItem();

  renderFrame();
  renderStrip();

  if (item) {
    showIntent(item.intent, { example: state.items.indexOf(item) === 0 });
    // Assigning even an identical value throws the caret to the end, and this
    // runs while the user may be typing, when another panel's write is adopted.
    if (el.description.value !== item.description) el.description.value = item.description;
  } else {
    // Hidden, but not inert: a leftover value would flash into the next item's
    // field for the instant before selectItem overwrote it.
    el.description.value = '';
  }
  el.item.hidden = !item;
}

/**
 * Turn a fresh capture into an item and put it on disk.
 *
 * The item appears in the frame immediately, marked SAVING, so the capture is
 * visibly acknowledged while Chrome writes the file. The save can take a while
 * if a "Save as" dialog is involved, and the user may already be typing; only
 * once the path is known is the item persisted, because a stored item with no
 * file would come back after a restart as a description of nothing.
 */
async function addItem(capture) {
  /** @type {Item} */
  const item = {
    id: makeId(),
    mode: capture.mode,
    width: capture.width,
    height: capture.height,
    url: state.tab?.url || '',
    title: state.tab?.title || '',
    tabId: state.tab?.id ?? null,
    intent: state.intent,
    description: '',
    // An element payload only belongs to the capture it was picked with.
    element: capture.mode === 'element' ? capture.element || null : null,
    capturedAt: Date.now(),
    // The full capture stands in until the thumbnail exists, so the frame is
    // never briefly empty. It is replaced before anything is persisted.
    thumb: capture.dataUrl,
    path: null,
    downloadId: null,
  };

  state.items.push(item);
  setArmed(null);
  selectItem(item.id);
  updateSubmitState();
  refreshContext();
  // Hands are on the mouse after a drag; the next thing to do is type.
  el.description.focus({ preventScroll: true });

  try {
    item.thumb = await makeThumb(capture.dataUrl);
    // Not selectItem: that resets the field's value and would throw the caret
    // to the end of whatever has been typed in the meantime.
    renderFrame();
    renderStrip();

    const saved = await saveScreenshot(capture.dataUrl, item.url);

    // Discarded while the file was being written. The path is known only now,
    // so this is the first moment the orphan can be cleaned up.
    if (!state.items.includes(item)) {
      deleteFile(saved.downloadId);
      return;
    }

    item.path = saved.path;
    item.downloadId = saved.downloadId;
    persist();
    persistThumbs();
    renderFrame();
    showBanner(null);
  } catch (error) {
    // Nothing reached the disk, so there is nothing to keep: the description
    // field has only been open for as long as the save took, and an item with
    // no screenshot would be a sentence about nothing. An item the user
    // already discarded while the dialog was open needs no explanation.
    if (!state.items.includes(item)) return;
    removeItem(item.id, { deleteFile: false });
    showBanner(`${error?.message || error} Capture it again.`, 'error');
  } finally {
    updateSubmitState();
  }
}

function removeItem(id, { deleteFile: shouldDelete }) {
  const index = state.items.findIndex((item) => item.id === id);
  if (index === -1) return;

  const [item] = state.items.splice(index, 1);
  if (shouldDelete && item.downloadId != null) deleteFile(item.downloadId);
  // The banner about its missing file has done its job.
  if (item.missing && !state.items.some((other) => other.missing)) showBanner(null);

  const next = state.items[index] || state.items[index - 1] || null;
  selectItem(next?.id ?? null);
  persist();
  persistThumbs();
  updateSubmitState();
  refreshContext();
}

/**
 * Empty the sheet.
 *
 * The two callers disagree about the files. "Discard all" means none of this
 * was wanted, so the PNGs go too. The reset after a copy must leave them: the
 * prompt on the clipboard names every one of them by path, and Claude Code is
 * about to open them.
 */
function clearItems({ deleteFiles }) {
  if (deleteFiles) {
    for (const item of state.items) {
      if (item.downloadId != null) deleteFile(item.downloadId);
    }
  }
  if (state.items.some((item) => item.missing)) showBanner(null);
  state.items = [];
  selectItem(null);
  persist();
  persistThumbs();
  updateSubmitState();
  refreshContext();
}

/**
 * Both discard buttons hide themselves when they have nothing left to act on,
 * and a hidden element cannot keep focus. Move it somewhere that makes sense
 * before that happens: the next item's sentence, or the next capture.
 */
function focusAfterDiscard() {
  if (selectedItem()) el.description.focus({ preventScroll: true });
  else el.modeRegion.focus({ preventScroll: true });
}

function discardSelected() {
  if (state.selectedId == null) return;
  removeItem(state.selectedId, { deleteFile: true });
  focusAfterDiscard();
}

function discardAll() {
  clearItems({ deleteFiles: true });
  el.result.hidden = true;
  el.promptPreview.hidden = true;
  focusAfterDiscard();
}

/**
 * Retire a report once it has actually reached the clipboard.
 *
 * Items are persisted so that closing the panel cannot lose them, and a side
 * panel is closed constantly. The cost of that durability is that a report
 * outlives the moment it was written for and comes back, stale, days later. A
 * successful copy is the moment it has served its purpose, so that is where
 * it is dropped.
 *
 * Only the items that were in the copied prompt go. A capture that landed
 * while the copy was in flight is not in that prompt, so it stays on the
 * sheet for the next one; clearing everything would delete it unseen.
 *
 * Deliberately not called when the clipboard was blocked: the user is still
 * mid-report and about to copy by hand, and clearing the sheet out from under
 * them would destroy the work.
 */
function resetAfterCopy(copied) {
  state.items = state.items.filter((item) => !copied.includes(item));
  selectItem(state.items.at(-1)?.id ?? null);
  persist();
  persistThumbs();
  updateSubmitState();
  refreshContext();
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
    addItem({
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

  setCount(el.countElement, state.items.filter((item) => item.element).length || null);
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
      throw new Error(`Download failed: ${item.error || 'interrupted'}.`);
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

/** @returns {Promise<{ path: string, downloadId: number }>} */
async function saveScreenshot(dataUrl, pageUrl) {
  const filename = `${SAVE_FOLDER}/${timestamp()}_${slugFromUrl(pageUrl)}.png`;
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

  const path = await waitForDownloadPath(downloadId);
  return { path, downloadId };
}

/**
 * Take a discarded screenshot back off the disk, and out of the download
 * history with it. Both calls fail harmlessly if the user already moved or
 * deleted the file by hand.
 */
async function deleteFile(downloadId) {
  try {
    await chrome.downloads.removeFile(downloadId);
  } catch {
    /* already gone */
  }
  try {
    await chrome.downloads.erase({ id: downloadId });
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------- report --

/**
 * @param {Item[]} items The items this prompt is about. Passed in rather than
 *   read from state, because a capture can land while the copy is in flight
 *   and must not leak into a prompt that was already decided.
 */
function assembleReport(items) {
  const collected = state.context?.collected || {};
  const includePage = el.incPage.checked;
  return {
    items: items.map((item) => ({
      intent: item.intent,
      description: item.description,
      screenshotPath: item.path,
      // Always passed: the template compares each item's page against the one
      // the buffers were read on, and counts pages for the opening line. It
      // prints a URL only when `page` is present, so the toggle still holds.
      url: item.url,
      capturedAt: item.capturedAt,
      element: el.incElement.checked ? item.element : null,
    })),
    page: includePage ? state.context?.page : null,
    consoleLines: el.incConsole.checked ? collected.console || [] : [],
    errors: el.incConsole.checked ? collected.errors || [] : [],
    network: el.incNetwork.checked ? collected.network || [] : [],
    builtAt: Date.now(),
  };
}

function blocked() {
  return state.items.some((item) => !item.path || item.missing);
}

async function copyReport() {
  if (state.busy || !state.items.length || blocked()) return;
  // The report being copied. Anything that lands after this line is the
  // start of the next one.
  const items = state.items.slice();

  state.busy = true;
  el.submit.classList.add('busy');
  el.submit.disabled = true;
  el.submitLabel.textContent = 'Copying…';
  showBanner(null);

  try {
    await refreshContext();

    const prompt = buildPrompt(assembleReport(items));
    const paths = items.map((item) => item.path);
    state.lastPrompt = prompt;
    state.lastDownloadId = items.at(-1).downloadId;

    const method = await copyText(prompt);

    // The action keeps its name through the flow: the button says Copy, so the
    // confirmation says Copied.
    el.resultText.textContent = method
      ? 'Copied. Paste into Claude Code.'
      : 'The clipboard was blocked, so copy the prompt below.';
    el.resultPath.textContent =
      paths.length === 1 ? paths[0] : `${paths.length} screenshots in ${folderOf(paths[0])}`;
    el.result.hidden = false;
    el.promptPreview.textContent = prompt;
    el.promptPreview.hidden = Boolean(method);

    // The prompt is already captured in state.lastPrompt and in the hidden
    // proof block, so Copy again and Read prompt keep working against an
    // emptied panel.
    if (method) resetAfterCopy(items);
  } catch (error) {
    showBanner(error?.message || String(error), 'error');
  } finally {
    state.busy = false;
    el.submit.classList.remove('busy');
    // Must match the label in panel.html: this runs after every copy.
    el.submitLabel.textContent = 'Copy for Claude Code';
    updateSubmitState();
  }
}

function updateSubmitState() {
  const count = state.items.length;
  el.submit.disabled = state.busy || count === 0 || blocked();
  el.submitCount.hidden = count < 2;
  el.submitCount.textContent = count < 2 ? '' : `(${count})`;
  el.discardAll.hidden = count < 2;
}

/**
 * Chrome has noticed that an item's PNG is no longer where it was saved.
 *
 * A report can sit for a week, and Downloads folders get emptied. Copying a
 * prompt that tells Claude Code to open a file that is not there would fail
 * somewhere it cannot be seen from here, so the item is marked and the copy
 * held until it is discarded or the sheet is rebuilt.
 */
function markMissing(item) {
  if (item.missing) return;
  item.missing = true;
  renderFrame();
  renderStrip();
  updateSubmitState();
  const number = state.items.indexOf(item) + 1;
  showBanner(
    `The screenshot for item ${number} is no longer on disk. Discard it, or capture it again.`,
    'error'
  );
}

// ------------------------------------------------------------ persistence --

/**
 * Everything about the report except the pixels.
 *
 * Rewritten on every keystroke, like the draft before it, so closing the panel
 * cannot lose a sentence. That is cheap because the thumbnails live under a
 * separate key and are only rewritten when an item is added or removed.
 *
 * Only items with a path are written. One still being saved has no file to
 * point at yet, and would come back after a restart as a description of
 * nothing.
 *
 * Nothing but an item change calls this. The toggles and the intent default
 * have their own write, so a panel in another window that never captured
 * anything cannot overwrite this one's report by unticking a box.
 */
function persist() {
  const items = state.items.filter((item) => item.path).map(({ thumb, ...rest }) => rest);
  chrome.storage.local
    .set({
      cdrReport: {
        items,
        // Age is measured from the last edit, not from the first capture.
        updatedAt: Date.now(),
        writer: PANEL_ID,
      },
    })
    .catch((error) => {
      // The report itself is small; if even this fails, the sheet in front of
      // the user is still intact and the next edit tries again.
      console.warn('[cdr] could not persist the report', error);
    });
}

function persistThumbs() {
  const items = {};
  for (const item of state.items) {
    if (item.path && item.thumb) items[item.id] = item.thumb;
  }
  // A report large enough to hit the storage quota still has its paths and
  // descriptions under cdrReport; losing the thumbnails is cosmetic.
  chrome.storage.local.set({ cdrThumbs: { items, writer: PANEL_ID } }).catch(() => {});
}

/**
 * Sticky like the toggles rather than cleared with the report: someone who
 * files suggestions is usually about to file another one.
 */
function persistSettings() {
  chrome.storage.local
    .set({
      cdrIntent: state.intent,
      cdrInclude: {
        console: el.incConsole.checked,
        network: el.incNetwork.checked,
        element: el.incElement.checked,
        page: el.incPage.checked,
      },
    })
    .catch(() => {});
}

/**
 * Rebuild the sheet from storage, keeping anything only this panel knows.
 *
 * Used at startup and whenever a panel in another window writes the report,
 * so that every open panel shows the same sheet rather than the last one to
 * write winning. Items still being saved here have no path and are not in
 * storage yet; they stay. The sentence being typed here is kept too, since
 * the other panel's copy of it is at best one keystroke behind.
 */
function adoptStored(report, thumbs) {
  const typing = document.activeElement === el.description ? selectedItem() : null;
  const saving = state.items.filter((item) => !item.path);

  const stored = (Array.isArray(report?.items) ? report.items : [])
    .filter((item) => item && typeof item.id === 'string' && typeof item.path === 'string')
    .map((item) => ({
      ...item,
      intent: normalizeIntent(item.intent),
      description: typeof item.description === 'string' ? item.description : '',
      thumb:
        typeof thumbs?.items?.[item.id] === 'string'
          ? thumbs.items[item.id]
          : state.items.find((known) => known.id === item.id)?.thumb || null,
    }));

  if (typing) {
    const same = stored.find((item) => item.id === typing.id);
    if (same) same.description = typing.description;
  }

  state.items = [...stored, ...saving];
  const keep = state.items.some((item) => item.id === state.selectedId);
  selectItem(keep ? state.selectedId : (state.items.at(-1)?.id ?? null));
  updateSubmitState();
  refreshContext();
}

/**
 * Ask Chrome whether the files behind restored items still exist.
 *
 * search() triggers the existence check; the answer may arrive in the same
 * record or later through downloads.onChanged, which is handled below.
 */
async function checkFiles() {
  for (const item of state.items) {
    if (item.downloadId == null || item.missing) continue;
    const [record] = await chrome.downloads.search({ id: item.downloadId }).catch(() => []);
    if (record && record.exists === false) markMissing(item);
  }
}

/**
 * Restore the panel, dropping a report that has gone stale.
 *
 * resetAfterCopy retires the report that was used. This covers the one that
 * was not: captures made, never copied, still on the sheet against an
 * unrelated page later. A report is a bigger investment than the one-line
 * draft this extension used to keep, so the window is a week rather than a
 * day; past that it is far more likely to be forgotten debris than work in
 * progress. The files stay on disk either way.
 *
 * Only ever applied here, at startup. A panel left open for a week keeps its
 * items, because pulling a report out from under someone looking at it would
 * be worse than the staleness this is meant to fix.
 */
async function restore() {
  const stored = await chrome.storage.local.get([
    'cdrReport',
    'cdrThumbs',
    'cdrIntent',
    'cdrInclude',
    'cdrDraft',
    'cdrDraftAt',
  ]);

  state.intent = normalizeIntent(stored.cdrIntent);
  showIntent(state.intent);

  // Up to 0.2 the panel kept one description with no capture attached. There
  // is no item for it to belong to now, so it is dropped rather than carried.
  if ('cdrDraft' in stored || 'cdrDraftAt' in stored) {
    chrome.storage.local.remove(['cdrDraft', 'cdrDraftAt']);
  }

  const report = stored.cdrReport;
  const expired =
    typeof report?.updatedAt === 'number' && Date.now() - report.updatedAt > REPORT_TTL_MS;

  const include = stored.cdrInclude;
  if (include) {
    el.incConsole.checked = include.console !== false;
    el.incNetwork.checked = include.network !== false;
    el.incElement.checked = include.element !== false;
    el.incPage.checked = include.page !== false;
  }

  // Drop it from storage rather than merely declining to show it, so a stale
  // report cannot outlive the check that rejected it.
  if (expired) {
    chrome.storage.local.remove(['cdrReport', 'cdrThumbs']);
    selectItem(null);
    updateSubmitState();
    return;
  }

  // Selects the most recent item, which is the one most likely to still need
  // its sentence.
  adoptStored(report, stored.cdrThumbs);
  checkFiles();
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
      .then((cropped) => addItem({ ...cropped, mode: 'region' }))
      .catch((error) => {
        setArmed(null);
        showBanner(error?.message || 'Region capture failed.', 'error');
      });
  }

  if (message.type === 'cdr:element-picked') {
    captureViewport()
      .then((full) => cropCapture(full, message.rect, message.viewport))
      .then((cropped) => addItem({ ...cropped, mode: 'element', element: message.element }))
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
el.previewClear.addEventListener('click', discardSelected);
el.discardAll.addEventListener('click', discardAll);

for (const [intent, node] of [
  ['bug', el.intentBug],
  ['change', el.intentChange],
]) {
  node.addEventListener('click', () => {
    const item = selectedItem();
    if (!item) return;
    if (item.intent !== intent) {
      item.intent = intent;
      state.intent = intent;
      showIntent(intent, { example: state.items.indexOf(item) === 0 });
      persist();
      persistSettings();
    }
    // Choosing the kind of report is the step before describing it. Leaving
    // focus on the segment would send the next keystrokes nowhere.
    el.description.focus({ preventScroll: true });
  });
}

el.description.addEventListener('input', () => {
  const item = selectedItem();
  if (!item) return;
  item.description = el.description.value;
  // Cheaper than rebuilding the strip on every keystroke, and the only things
  // about it that a description changes.
  const index = state.items.indexOf(item);
  const thumb = el.strip.children[index];
  thumb?.classList.toggle('noted', Boolean(item.description.trim()));
  thumb?.setAttribute('aria-label', describeThumb(item, index));
  persist();
});

el.submit.addEventListener('click', copyReport);
el.refreshContext.addEventListener('click', refreshContext);

for (const toggle of [el.incConsole, el.incNetwork, el.incElement, el.incPage]) {
  toggle.addEventListener('change', persistSettings);
}

// Another window's panel wrote the report. Echoes of this panel's own writes
// carry its id and are ignored; everything else is adopted, so every open
// panel shows one sheet.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const report = changes.cdrReport?.newValue;
  const thumbs = changes.cdrThumbs?.newValue;
  const fromElsewhere =
    (changes.cdrReport && report?.writer !== PANEL_ID) ||
    (changes.cdrThumbs && thumbs?.writer !== PANEL_ID);
  if (!fromElsewhere) return;

  ready.then(async () => {
    const stored = await chrome.storage.local.get(['cdrReport', 'cdrThumbs']);
    adoptStored(report ?? stored.cdrReport, thumbs ?? stored.cdrThumbs);
  });
});

// The existence check that checkFiles() starts can finish after search() has
// returned; this is where Chrome reports the answer.
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.exists?.current !== false) return;
  const item = state.items.find((candidate) => candidate.downloadId === delta.id);
  if (item) markMissing(item);
});

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

// Cmd/Ctrl+Enter copies without reaching for the mouse.
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    copyReport();
  }
});

chrome.tabs.onActivated.addListener(resolveTab);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A navigation destroys any injected overlay, so the panel must stop claiming
  // this tab is armed. Otherwise the lit button would need two clicks to work.
  if (tabId === state.armedTabId && changeInfo.status === 'loading') setArmed(null);
  // A single page app changes its URL without ever reaching 'complete'. Items
  // record the tab's URL at capture time, so it has to be current.
  if (tabId === state.tab?.id && (changeInfo.status === 'complete' || changeInfo.url)) {
    resolveTab();
  }
});

el.version.textContent = `v${chrome.runtime.getManifest().version}`;

// Startup. Declared last so it runs after every listener is wired, but consumed
// by the onMessage handler above, which defers until this settles rather than
// comparing against a tab id that has not been resolved yet.
const ready = restore().then(resolveTab);
