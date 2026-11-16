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
const ARM_TIMEOUT_MS = 3000; // cap on waiting for a page to take a capture overlay down
const CONTEXT_TIMEOUT_MS = 2000; // cap on reading the log; the bridge gives the page 1000 of it
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
  sheet: document.getElementById('sheet'),
  list: document.getElementById('list'),
  newItem: document.getElementById('new-item'),
  selectAll: document.getElementById('select-all'),
  clearSelection: document.getElementById('clear-selection'),
  tip: document.getElementById('thumb-tip'),
  tipHead: document.getElementById('thumb-tip-head'),
  tipBody: document.getElementById('thumb-tip-body'),

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
 * @property {boolean} included     Ticked: goes into the next prompt.
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
  restrictionShown: false, // whether the banner is the restriction's, so resolveTab clears only its own
  intent: 'bug', // what the NEXT item starts as; sticky, like the toggles
  armedMode: null, // 'region' | 'element' | null
  armedTabId: null, // which tab that arm was issued against
  armedId: null, // the armId behind that arm, when it has one (the shortcut's has none)
  cancelledArmIds: new Set(), // arms this panel cancelled or replaced, whose late cdr:armed is ignored
  cancels: new Map(), // tabId -> a disarm on its way there, so a capture on that tab can wait
  resolving: 0, // bumped by each resolveTab(), so an older one that answers late gives way
  capturing: false, // a Screen capture in flight, so a second click cannot start another
  /** @type {Item[]} */
  items: [],
  // The item in the frame, whose description the field edits. Distinct from
  // the ticks: any number of items can be ticked, one at most is in the frame.
  selectedId: null,
  lastDownloadId: null,
  lastPrompt: '',
  busy: false,
};

// ---------------------------------------------------------------- helpers --

const TIMED_OUT = Symbol('timed out');

/** The promise, or a rejection with TIMED_OUT once `ms` have passed. */
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(TIMED_OUT), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

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
function setArmed(mode, tabId = null, armId = null) {
  state.armedMode = mode;
  state.armedTabId = mode ? tabId : null;
  state.armedId = mode ? armId : null;
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
  const call = ++state.resolving;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (call !== state.resolving) return;
  const switched = (state.tab?.id ?? null) !== (tab?.id ?? null);
  state.tab = tab || null;

  // Arming is per-tab. Switching tabs would otherwise leave the button lit for
  // an overlay that is still live on a page no longer in view, and the next
  // click on it would be swallowed by the cancel branch.
  if (state.armedMode && state.armedTabId !== (tab?.id ?? null)) {
    const stale = state.armedTabId;
    if (state.armedId) state.cancelledArmIds.add(state.armedId);
    setArmed(null);
    // Sent at once, even if the arm is still on its way: the worker orders the
    // two (see cancelArmed), and an arm made on coming back to that tab comes
    // after this disarm, so it stands. Kept in state.cancels like any other,
    // so a Screen on coming back waits for the overlay to go.
    if (stale != null) sendDisarm(stale);
  }

  if (!tab) {
    el.targetUrl.textContent = 'No active tab';
    el.statusDot.className = 'dot blocked';
    return;
  }

  el.targetUrl.textContent = tab.url || tab.pendingUrl || '(no url)';
  el.targetUrl.title = tab.url || '';

  const response = await chrome.runtime.sendMessage({ type: 'cdr:check-tab', tabId: tab.id });
  // A newer call, for the tab now in view, owns the panel. This answer is
  // about a tab the user has left, and would light its mode or carry its
  // restriction over.
  if (call !== state.resolving) return;
  state.restriction = response?.restriction || null;

  // The worker tracks which tab has an overlay waiting. Adopting it here covers
  // the case a one-shot broadcast cannot: Alt+Shift+C arms the page and opens
  // the panel together, so the cdr:armed message can be sent before this
  // document exists to hear it. Not an arm this panel has cancelled, though:
  // the worker records an arm when it lands, which can be after the cancel.
  if (
    response?.armedMode &&
    !state.armedMode &&
    !(response.armId && state.cancelledArmIds.has(response.armId))
  ) {
    setArmed(response.armedMode, tab.id, response.armId || null);
  }

  el.statusDot.className = state.restriction ? 'dot blocked' : 'dot ready';
  // Only a banner this sets, unless the tab changed. A busy page sends its
  // 'complete' or a new URL just after it frees, which is when a notice about
  // the capture taken while it was busy matters most.
  if (state.restriction) showBanner(state.restriction, 'error');
  else if (switched || state.restrictionShown) showBanner(null);
  state.restrictionShown = Boolean(state.restriction);

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

/**
 * What a screen reader gets for a row's pick button; the number alone says
 * nothing. The sentence itself rides along, cut short.
 */
function describeRow(item, index) {
  const head = `Item ${index + 1}, ${MODE_LABEL[item.mode].toLowerCase()}`;
  if (item.missing) return `${head}, file missing`;
  const words = item.description.trim();
  if (!words) return `${head}, no description yet`;
  return `${head}: ${words.length > 90 ? `${words.slice(0, 90)}…` : words}`;
}

/** The small readout above a row's sentence. */
function rowHead(item, index) {
  const status = item.missing ? ' · FILE MISSING' : item.path ? '' : ' · SAVING';
  return `${index + 1} · ${MODE_LABEL[item.mode]}${status}`;
}

/**
 * Read an item's whole sentence back over its row, when the row cut it short.
 *
 * One element, positioned with fixed coordinates, because the list scrolls
 * and a scroll container clips anything positioned inside it. Above the row
 * when there is room, which there usually is now that the sheet sits near the
 * bottom of the panel; below it otherwise.
 */
function showTip(button, item, index) {
  const words = item.description.trim();
  el.tipHead.textContent = `${index + 1} · ${MODE_LABEL[item.mode]}${item.missing ? ' · FILE MISSING' : ''}`;
  el.tipBody.textContent = words || 'No description yet.';
  el.tipBody.classList.toggle('quiet', !words);

  // Measure before placing: the text decides the size.
  el.tip.style.visibility = 'hidden';
  el.tip.hidden = false;
  const size = el.tip.getBoundingClientRect();
  const anchor = button.getBoundingClientRect();
  const margin = 8;

  const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - size.width - margin));
  const above = anchor.top - size.height - 6;
  const top = above >= margin ? above : anchor.bottom + 6;

  el.tip.style.left = `${Math.round(left)}px`;
  el.tip.style.top = `${Math.round(top)}px`;
  el.tip.style.visibility = '';
}

function hideTip() {
  el.tip.hidden = true;
}

/**
 * How focus last arrived: from a key or from a pointer.
 *
 * A click focuses a row's button as surely as Tab does, and renderSheet puts
 * focus back on the rebuilt button afterwards. Browsers' own :focus-visible
 * heuristic treats that scripted focus inconsistently, so the panel keeps its
 * own answer: the tooltip opens on focus only when the last thing the user
 * touched was the keyboard. Pointer users already have hover.
 */
let lastInput = 'keyboard';
document.addEventListener('pointerdown', () => (lastInput = 'pointer'), true);
document.addEventListener('keydown', () => (lastInput = 'keyboard'), true);

/** Fill a row's text from its item, on build and on every keystroke. */
function fillRowText(row, item, index) {
  const words = item.description.trim();
  row.querySelector('.row-head').textContent = rowHead(item, index);
  const body = row.querySelector('.row-body');
  body.textContent = words || 'No description yet.';
  body.classList.toggle('quiet', !words);
  row.querySelector('.row-pick').setAttribute('aria-label', describeRow(item, index));
}

function renderSheet() {
  // The rebuild destroys the button that has focus. Putting focus back on the
  // row in the frame keeps a keyboard user where they were.
  const hadFocus = el.list.contains(document.activeElement);
  hideTip();

  el.sheet.hidden = state.items.length === 0;
  el.list.replaceChildren(
    ...state.items.map((item, index) => {
      const row = document.createElement('li');
      row.className = 'row';
      row.classList.toggle('on', item.id === state.selectedId);
      row.classList.toggle('included', item.included);
      row.classList.toggle('missing', Boolean(item.missing));

      const tick = document.createElement('label');
      tick.className = 'row-tick';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = item.included;
      box.setAttribute('aria-label', `Include item ${index + 1} in the prompt`);
      box.addEventListener('change', () => {
        item.included = box.checked;
        row.classList.toggle('included', item.included);
        persist();
        updateSubmitState();
      });
      tick.append(box);

      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'row-pick';
      pick.setAttribute('aria-pressed', String(item.id === state.selectedId));

      const thumb = document.createElement('span');
      thumb.className = 'row-thumb';
      const img = document.createElement('img');
      img.alt = '';
      if (item.thumb) img.src = item.thumb;
      thumb.append(img);

      const text = document.createElement('span');
      text.className = 'row-text';
      const head = document.createElement('span');
      head.className = 'row-head';
      const body = document.createElement('span');
      body.className = 'row-body';
      text.append(head, body);

      pick.append(thumb, text);
      pick.addEventListener('click', () => selectItem(item.id));

      // Only a row that cut its sentence short has anything to add on hover;
      // the tooltip reads live from the item, so a sentence typed after the
      // row was built is what shows.
      const show = () => {
        if (body.scrollHeight > body.clientHeight + 1) {
          showTip(pick, item, state.items.indexOf(item));
        }
      };
      pick.addEventListener('mouseenter', show);
      pick.addEventListener('mouseleave', hideTip);
      // A click focuses a button too, and would otherwise pin the tooltip
      // open until focus moved on. Only keyboard focus earns it.
      pick.addEventListener('focus', () => {
        if (lastInput === 'keyboard') show();
      });
      pick.addEventListener('blur', hideTip);

      row.append(tick, pick);
      fillRowText(row, item, index);
      return row;
    })
  );

  const on = el.list.querySelector('.row.on');
  on?.scrollIntoView({ block: 'nearest' });
  if (hadFocus) on?.querySelector('.row-pick').focus({ preventScroll: true });
}

/**
 * Tick or untick every row. The ticks decide what the next prompt carries;
 * unticked items stay on the sheet for a later one.
 */
function setAllIncluded(included) {
  for (const item of state.items) item.included = included;
  renderSheet();
  persist();
  updateSubmitState();
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
  renderSheet();

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
  updateSubmitState();
}

/**
 * Take the frame back to empty without touching the sheet.
 *
 * Every capture already starts a new item, so this changes nothing about what
 * the next capture does. What it changes is what the panel shows while the
 * user lines that capture up: an empty frame and no sentence, rather than the
 * previous item looking like the one about to be replaced.
 */
function startNewItem() {
  selectItem(null);
  el.modeRegion.focus({ preventScroll: true });
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
    included: true,
    // An element payload only belongs to the capture it was picked with.
    element: capture.mode === 'element' ? capture.element || null : null,
    capturedAt: Date.now(),
    // The full capture stands in until the thumbnail exists, so the frame is
    // never briefly empty. It is replaced before anything is persisted.
    thumb: capture.dataUrl,
    path: null,
    downloadId: null,
  };

  // The armed state is not touched here. A region or element capture ended
  // its arm when the page sent it (handleBroadcast), and Screen cancelled
  // before it waited; a mode armed since then is the user's newer action.
  state.items.push(item);
  selectItem(item.id);
  updateSubmitState();
  // The read that refreshes the chips also says which load of the page this
  // capture belongs to. Kept on the item, it lets a list print under each
  // item what was logged since the capture before it, and say so when a
  // reload has since thrown that away.
  refreshContext().then((read) => {
    const armedAt = read.context?.collected?.armedAt;
    if (!Number.isFinite(armedAt) || read.tabId !== item.tabId) return;
    // A collector that started after the capture is a page load that came
    // after it (a reload or a navigation in between), which holds nothing
    // that led up to it.
    if (armedAt > item.capturedAt) return;
    // By id: a sheet adopted from another window meanwhile holds new objects.
    const live = state.items.find((candidate) => candidate.id === item.id);
    if (!live || live.armedAt != null) return;
    live.armedAt = armedAt;
    if (live.path) persist();
  });
  // Hands are on the mouse after a drag; the next thing to do is type.
  el.description.focus({ preventScroll: true });
  // Something the user should know about this capture. Shown now and again
  // once the save is done, since the save clears the banner on its way out.
  if (capture.notice) showBanner(capture.notice);

  try {
    item.thumb = await makeThumb(capture.dataUrl);
    // Not selectItem: that resets the field's value and would throw the caret
    // to the end of whatever has been typed in the meantime.
    renderFrame();
    renderSheet();

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
    const row = el.list.children[state.items.indexOf(item)];
    if (row) fillRowText(row, item, state.items.indexOf(item));
    // Clears the slow save hint, but not a warning about this capture.
    showBanner(capture.notice || null);
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

/** Whether a capture mode is waiting on the tab in view. */
function armedHere() {
  return Boolean(state.armedMode) && state.armedTabId === state.tab?.id;
}

/**
 * After a navigation on the armed tab, ask the page whether the overlay is
 * still there, and go dark only if it is not.
 *
 * Chrome reports pushState, replaceState and a hash change as 'loading', the
 * same as a real navigation, and those leave the overlay live. Going dark on
 * them left the overlay on the page with nothing in the panel to cancel it,
 * and Screen photographing it. The worker waits for an arm still landing
 * before it asks, so an arm that lands in a document on its way out reads as
 * gone, and its late cdr:armed is refused like any cancelled arm's.
 */
async function verifyArmed() {
  const { armedTabId: tabId, armedId: armId } = state;
  if (tabId == null) return;
  const reply = await chrome.runtime
    .sendMessage({ type: 'cdr:verify', tabId })
    .catch(() => null);
  if (!reply?.ok || reply.mode) return;
  // Armed again, or cancelled, while the page was asked: that is newer news.
  if (state.armedTabId !== tabId || state.armedId !== armId) return;
  if (armId) state.cancelledArmIds.add(armId);
  setArmed(null);
}

/**
 * Cancel the armed mode, as clicking its lit button does. Settles once the
 * worker has answered, which it does after the page has painted a frame
 * without the overlay, so a caller about to photograph the page can wait.
 *
 * A cancel can come while the arm it cancels is still on its way to the page
 * (Esc or Screen pressed straight after a mode button, on a cold worker or a
 * busy page), and after the shortcut has armed the same tab without this panel
 * having heard of it yet. Both are the worker's to sort out: it sees every arm
 * and disarm in order, and a disarm cancels every arm asked for before it. The
 * cdr:armed broadcast a cancelled arm of this panel may still send is ignored
 * here by its armId.
 */
function cancelArmed() {
  const tabId = state.armedTabId;
  if (state.armedId) state.cancelledArmIds.add(state.armedId);
  setArmed(null);
  return sendDisarm(tabId);
}

/**
 * Send a disarm, and keep it in state.cancels until it settles, so a capture
 * on that tab, from a click rather than from the code that cancelled, waits
 * for the page to repaint without the overlay.
 */
function sendDisarm(tabId) {
  const promise = chrome.runtime.sendMessage({ type: 'cdr:disarm', tabId }).catch(() => undefined);
  state.cancels.set(tabId, promise);
  // Never rejects, so this chain cannot leave an unhandled rejection behind.
  promise.then(() => {
    if (state.cancels.get(tabId) === promise) state.cancels.delete(tabId);
  });
  return promise;
}

async function arm(mode) {
  if (state.restriction || !state.tab) return;
  showBanner(null);

  // Clicking the already-armed mode cancels it, which is what the highlighted
  // button reads as, even while that arm is still on its way. Only treat it as
  // a cancel when the arm belongs to the tab currently in view; otherwise it
  // is a fresh arm for a different page.
  if (state.armedMode === mode && armedHere()) {
    cancelArmed();
    return;
  }

  // An arm of this panel that this one replaces, in flight or landed, would
  // light its own mode over this one when its broadcast arrives. The worker
  // needs no word of it: this arm lands after it and takes the page over.
  if (state.armedId) state.cancelledArmIds.add(state.armedId);
  const armId = makeId();
  setArmed(mode, state.tab.id, armId);

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'cdr:arm',
      mode,
      tabId: state.tab.id,
      armId,
    });
    // Only if the button still shows this arm: one that a later click has
    // replaced, or that was cancelled, must not turn off what came after it.
    if (!response?.ok && state.armedId === armId) {
      setArmed(null);
      showBanner(response?.error || 'Could not start capture on this tab.', 'error');
    }
  } catch (error) {
    // sendMessage rejects outright if the worker is torn down mid-request, for
    // instance when the extension is reloaded. Without this the button would
    // stay lit over a page with no overlay, and the next click would read as a
    // cancel rather than arming.
    if (state.armedId === armId) {
      setArmed(null);
      showBanner(error?.message || 'Could not start capture on this tab.', 'error');
    }
  }
}

const OVERLAY_TOO_BUSY =
  'The page was too busy to take the capture overlay down in time, so it may show in this screenshot.';

/**
 * Screen was clicked, and while it waited for the page to take the overlay
 * down, a capture mode was armed on the same tab again: Region or Element
 * clicked, or Alt+Shift+C pressed. That arm is the user's newer action and
 * stays armed whatever this returns, so its overlay may already be drawn on
 * the page the screenshot is about to be taken of.
 *
 * @param {'region'|'element'|null} mode  the mode now lit in this panel, or
 *   null when only the worker knows of the arm so far (the shortcut, whose
 *   broadcast has not arrived yet)
 * @returns {{ capture: boolean, notice: string|null }}  whether to take the
 *   screenshot anyway, and what the banner says either way (null for nothing)
 */
function screenAfterRearm(mode) {
  // TODO(you): decide. The placeholder below keeps the old behaviour plus a
  // warning: photograph the page anyway and say the overlay may show.
  return {
    capture: true,
    notice: 'A capture mode was armed while this screenshot waited, so its overlay may show in it.',
  };
}

async function captureVisible() {
  // One capture in flight at a time. This covers the capture itself, which
  // can take a while on a busy page; the second click of a double click is
  // turned away where the click is handled.
  if (state.restriction || state.capturing) return;
  state.capturing = true;
  try {
    showBanner(null);
    // An armed overlay is drawn on the page itself. Photographing it would bake
    // the dim layer and the hint into the image and leave the overlay live, so
    // it is cancelled first and the capture waits for the page to repaint.
    if (armedHere()) cancelArmed();
    // This cancel, or one sent for this tab a moment before the click: Esc,
    // or the disarm sent on leaving it. Bounded, like every wait on the page,
    // and said out loud when it runs out: a page too busy to take the overlay
    // down still gets photographed, since that page is often the bug, but
    // nobody should find the dim layer later without having been told.
    let notice = null;
    let reply = null;
    const pending = state.cancels.get(state.tab?.id);
    if (pending) {
      reply = await withTimeout(pending, ARM_TIMEOUT_MS).catch(() => {
        notice = OVERLAY_TOO_BUSY;
        return null;
      });
    }
    // A mode armed on this tab while Screen waited: Region or Element clicked,
    // or the shortcut, which the worker reports before this panel has heard of
    // it. That arm is the newer action and stands, and its overlay may be on
    // the page by now.
    if (reply?.superseded || armedHere()) {
      const decision = screenAfterRearm(armedHere() ? state.armedMode : null);
      if (!decision.capture) {
        showBanner(decision.notice);
        return;
      }
      notice = decision.notice || notice;
    }
    const dataUrl = await captureViewport();
    const image = await loadImage(dataUrl);
    addItem({
      dataUrl,
      width: image.naturalWidth,
      height: image.naturalHeight,
      mode: 'visible',
      notice,
    });
  } catch (error) {
    showBanner(error?.message || 'Screenshot failed.', 'error');
  } finally {
    state.capturing = false;
  }
}

// --------------------------------------------------------------- context --

/**
 * Read the page facts and the collected log from the tab in view, for the
 * chips and for a copy.
 *
 * Resolves to { context, error }: the bridge's reply or null, and why there is
 * none. 'timeout' means the page did not answer in time, which is a long task
 * or a breakpoint; 'missing' means nothing was collecting there.
 *
 * Bounded, because the reply has to come from the page's own thread. Unbounded,
 * Copy sat on "Copying…" for as long as the page stayed busy, and forever while
 * it was paused in the debugger.
 */
async function refreshContext() {
  const tab = state.tab;
  if (!tab || state.restriction) {
    setCount(el.countConsole, null);
    setCount(el.countNetwork, null);
    // Nothing from an earlier read is handed on. It came from another tab, and
    // a copy made here would otherwise attach that tab's log.
    return { context: null, error: 'missing' };
  }

  let context = null;
  let error = null;
  try {
    context = await withTimeout(
      chrome.tabs.sendMessage(tab.id, { type: 'cdr:get-context' }),
      CONTEXT_TIMEOUT_MS
    );
    // The bridge answered for a page whose own half never armed.
    if (context?.collected?.unavailable) error = 'missing';
  } catch (failure) {
    // Either no content script in this tab, because it was loaded before the
    // extension was installed or enabled, and a reload arms it; or a page too
    // busy to answer, where a reload would destroy the state being reported.
    context = null;
    error = failure === TIMED_OUT ? 'timeout' : 'missing';
  }

  // The user can change tabs while this is in flight. The reply then describes
  // the tab they left, so it goes back to whoever asked and not into the chips
  // for the tab now in view.
  if (state.tab?.id === tab.id) {
    el.collectorWarning.hidden = error !== 'missing';
    const collected = context?.collected || {};
    setCount(
      el.countConsole,
      context
        ? (collected.console?.length || 0) +
            (collected.warnings?.length || 0) +
            (collected.errors?.length || 0)
        : null
    );
    setCount(el.countNetwork, context ? collected.network?.length || 0 : null);
  }

  setCount(el.countElement, state.items.filter((item) => item.element).length || null);
  return { context, error, tabId: tab.id };
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
 * @param {{ context: Object|null, error: string|null }} read What
 *   refreshContext() returned for this copy.
 */
function assembleReport(items, read) {
  const { context, error } = read;
  const collected = context?.collected || {};
  const includePage = el.incPage.checked;
  // Whether the prompt says anything about the log at all. With both toggles
  // off, a caution or a reason about entries nobody asked for is noise.
  const wantedLog = el.incConsole.checked || el.incNetwork.checked;
  const newest = items.at(-1);
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
      armedAt: item.armedAt,
      element: el.incElement.checked ? item.element : null,
    })),
    // With nothing read, the newest item's own page stands in. Each item
    // recorded it at capture, and without it the prompt named no page at all.
    page: includePage
      ? context?.page || (newest?.url ? { url: newest.url, title: newest.title || '' } : null)
      : null,
    // Warnings come from a ring of their own; the template merges every line
    // into the order it was logged in anyway.
    consoleLines: el.incConsole.checked
      ? [...(collected.console || []), ...(collected.warnings || [])]
      : [],
    errors: el.incConsole.checked ? collected.errors || [] : [],
    network: el.incNetwork.checked ? collected.network || [] : [],
    // Only for what the prompt carries: a note about dropped requests in a
    // prompt with the network toggle off would be about nothing it shows.
    dropped: {
      ...(el.incConsole.checked && {
        console: collected.dropped?.console,
        warnings: collected.dropped?.warnings,
        errors: collected.dropped?.errors,
      }),
      ...(el.incNetwork.checked && { network: collected.dropped?.network }),
    },
    builtAt: Date.now(),
    // Tells the template an item was captured on an earlier load of this page.
    armedAt: wantedLog && Number.isFinite(collected.armedAt) ? collected.armedAt : undefined,
    contextError: wantedLog && error ? error : undefined,
  };
}

/** The items the next prompt carries: the ticked ones. */
function includedItems() {
  return state.items.filter((item) => item.included);
}

function blocked(items) {
  return items.some((item) => !item.path || item.missing);
}

async function copyReport() {
  // The report being copied: the ticked items, as they stand at this moment.
  // Anything that lands or is ticked after this line is the start of the
  // next one.
  const items = includedItems();
  if (state.busy || !items.length || blocked(items)) return;

  state.busy = true;
  el.submit.classList.add('busy');
  el.submit.disabled = true;
  el.submitLabel.textContent = 'Copying…';
  showBanner(null);

  try {
    const read = await refreshContext();

    const prompt = buildPrompt(assembleReport(items, read));
    const paths = items.map((item) => item.path);
    state.lastPrompt = prompt;
    state.lastDownloadId = items.at(-1).downloadId;

    const method = await copyText(prompt);
    // Said here because nothing else would say it: the chips only show dashes,
    // and the reload hint under them is wrong advice for a page that is busy.
    const wantedLog = el.incConsole.checked || el.incNetwork.checked;

    // The action keeps its name through the flow: the button says Copy, so the
    // confirmation says Copied.
    el.resultText.textContent = !method
      ? 'The clipboard was blocked, so copy the prompt below.'
      : read.error === 'timeout' && wantedLog
        ? 'Copied without the log: the page did not answer in time. Paste into Claude Code.'
        : 'Copied. Paste into Claude Code.';
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
  const all = state.items.length;
  const picked = includedItems();
  el.submit.disabled = state.busy || picked.length === 0 || blocked(picked);

  // The count is news once there is more than one item, or once the ticks
  // have made the prompt smaller than the sheet.
  const partial = picked.length !== all;
  el.submitCount.hidden = all < 2 && !partial;
  el.submitCount.textContent = partial ? `(${picked.length} of ${all})` : `(${all})`;

  el.discardAll.hidden = all < 2;
  el.newItem.hidden = state.selectedId == null;
  el.selectAll.hidden = !partial;
  el.clearSelection.hidden = picked.length === 0;
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
  renderSheet();
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
      included: item.included !== false,
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
    // The echo of an arm this panel has already cancelled; see cancelArmed().
    if (message.armId && state.cancelledArmIds.has(message.armId)) return;
    setArmed(message.mode, message.tabId, message.armId || null);
    return;
  }

  // The page has ended its arm by finishing it. The button goes dark now
  // rather than once the screenshot is in: a mode clicked in between is a new
  // arm, and must stay lit.
  if (message.type === 'cdr:region-selected' || message.type === 'cdr:element-picked') {
    setArmed(null);
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
el.modeVisible.addEventListener('click', (event) => {
  // The second click of a double click (detail 2) would file the same screen
  // twice, and the first capture is often finished by the time it arrives.
  // A keyboard press has detail 0 and always counts.
  if (event.detail > 1) return;
  captureVisible();
});
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
  // Cheaper than rebuilding the sheet on every keystroke, and the only thing
  // about a row that a description changes.
  const index = state.items.indexOf(item);
  const row = el.list.children[index];
  if (row) fillRowText(row, item, index);
  persist();
});

el.newItem.addEventListener('click', startNewItem);
el.selectAll.addEventListener('click', () => setAllIncluded(true));
el.clearSelection.addEventListener('click', () => setAllIncluded(false));

el.submit.addEventListener('click', copyReport);
el.refreshContext.addEventListener('click', refreshContext);

// A tooltip pinned to a row that has scrolled away would float over nothing;
// the list and the panel both scroll under a hovering pointer.
el.list.addEventListener('scroll', hideTip, { passive: true });
document.addEventListener('scroll', hideTip, { passive: true, capture: true });

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

document.addEventListener('keydown', (event) => {
  // Cmd/Ctrl+Enter copies without reaching for the mouse.
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    copyReport();
    return;
  }
  // Esc cancels an armed mode from here too. Clicking a mode button leaves
  // focus in the panel, so the page's own Esc handler, which the hint on the
  // page names, never hears the key until the user clicks back into the page.
  if (event.key === 'Escape' && !event.isComposing && armedHere()) {
    event.preventDefault();
    cancelArmed();
  }
});

chrome.tabs.onActivated.addListener(resolveTab);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A navigation may have destroyed the overlay, and a lit button over a page
  // without one would need two clicks to work. May: see verifyArmed.
  if (
    tabId === state.armedTabId &&
    (changeInfo.status === 'loading' || changeInfo.status === 'complete')
  ) {
    verifyArmed();
  }
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
