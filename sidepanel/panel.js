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
const SLOW_SAVE_HINT =
  'Waiting on Chrome. If a "Save as" dialog opened, confirm it, or turn off ' +
  '"Ask where to save each file" in chrome://settings/downloads.';

const ARM_TIMEOUT_MS = 3000; // cap on waiting for a page to take a capture overlay down
const CONTEXT_TIMEOUT_MS = 2000; // cap on reading the log; the bridge gives the page 1000 of it
const REPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // how long an uncopied report survives
const THUMB_MAX_WIDTH = 800; // the frame is never wider than this in device pixels
const THUMB_MAX_HEIGHT = 800; // and a tall element crop should not cost a megabyte
const THUMB_QUALITY = 0.85;
// Marking up a capture (see openMarkup). The marks are drawn into the saved
// image in one fixed magenta over a white edge, whatever the theme, because
// the prompt names that colour as the user's own (MARKS in the template).
const MARK_COLOR = '#e6007e';
const MARK_EDGE = 'rgba(255, 255, 255, 0.85)';
const MARK_MIN_DRAG_PX = 4; // a shape shorter than this, in CSS pixels, is not drawn
const MARK_STEP = 0.02; // how far an arrow key moves a point, as a share of the image
// The clean captures the panel keeps for marking up (holdFull): those of its
// newest captures, this many at most and about this many bytes together.
const FULL_KEEP_COUNT = 10;
const FULL_KEEP_BYTES = 100 * 1024 * 1024;
// A whole page capture (the Page mode, see capturePage). PAGE_MAX_HEIGHT is
// the tallest stitched PNG it makes, in device pixels: about five screens at
// 2x. A longer page stops there at full resolution, and the item says so.
// Claude reads an image at most 2576 px on its long edge, so a taller one
// reaches it scaled down; raise this for a longer overview, lower it for
// legible text.
const PAGE_MAX_HEIGHT = 10000;
const PAGE_MAX_AREA = 2 ** 26; // and never more pixels than this, whatever the width
const PAGE_MAX_SCREENS = 100; // a safety stop for a view only a few pixels tall
const PAGE_THUMB_MAX_HEIGHT = 1600; // its thumbnail: cdrThumbs is rewritten on every change
const PAGE_PACE_MS = 520; // captureVisibleTab allows two calls a second per extension
// How long one call into the page may take. A step answers in about a second
// at most (two frames, the image wait, two frames), so a page silent for this
// long is not painting or has gone; its own lease (4 s) puts it back.
const PAGE_CALL_MS = 5000;
const PAGE_SCRIPT = 'content/page-shot.js';
const UNDO_MS = 6000; // how long a discard can be taken back before its files go
const REMOVED_TTL_MS = 10 * 60 * 1000; // how long the sheet remembers what left it, see state.removed
const REMOVED_MAX = 200;
// How far ahead of the clock a stamp on the sheet may be and still count (see
// tooFarAhead): after the clock is set back, every stamp made before is ahead
// of it, and edits go on from them. Two days rides out a set back of a full
// day with room to spare.
const STAMP_AHEAD_MS = 2 * 24 * 60 * 60 * 1000;
const CHIPS_MIN_GAP_MS = 1000; // the least time between two chip reads the panel starts on its own
// How long a copy with no page to read waits for Chrome to report a file
// gone, counted from the ask (copyReport). Chrome 156 answered in 0.3 to 1.4
// ms with no other downloads listed, up to 5 ms with 300 and up to 30 ms with
// 2000, and up to 27 ms in a panel busy with captures.
const FILE_ANSWER_MS = 150;
const COPY_ANSWER_MS = 1000; // how long after the receipt such an answer is still said on it, see copyReport

/**
 * Said instead of capturing on an incognito tab. The extension's storage is
 * shared with the regular profile (Chrome's documentation says so for every
 * incognito mode), so a sheet started here would outlive the window, and so
 * would its entries in the download history.
 */
const INCOGNITO_RESTRICTION =
  'Capture is off in incognito windows: the sheet and its screenshots would be kept after the window closes.';

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

// Terse, like a viewfinder readout rather than a sentence. 'other' is any
// mode this build does not know, read from a sheet a newer build stored.
const MODE_LABEL = { region: 'REGION', element: 'ELEMENT', visible: 'SCREEN', page: 'PAGE', other: 'CAPTURE' };

const el = {
  statusDot: document.getElementById('status-dot'),
  targetUrl: document.getElementById('target-url'),
  bannerLive: document.getElementById('banner-live'),
  banner: document.getElementById('banner'),
  shortcutKeys: document.getElementById('shortcut-keys'),

  modes: document.getElementById('modes'),
  modeRegion: document.getElementById('mode-region'),
  modeElement: document.getElementById('mode-element'),
  modeVisible: document.getElementById('mode-visible'),
  modePage: document.getElementById('mode-page'),
  modePageLabel: document.getElementById('mode-page-label'),
  modePageCount: document.getElementById('mode-page-count'),

  preview: document.getElementById('preview'),
  previewEmpty: document.getElementById('preview-empty'),
  previewScroll: document.getElementById('preview-scroll'),
  previewImg: document.getElementById('preview-img'),
  previewClear: document.getElementById('preview-clear'),
  previewMeta: document.getElementById('preview-meta'),
  markUp: document.getElementById('mark-up'),
  markupCanvas: document.getElementById('markup-canvas'),
  marks: document.getElementById('marks'),
  markArrow: document.getElementById('mark-arrow'),
  markEllipse: document.getElementById('mark-ellipse'),
  markUndo: document.getElementById('mark-undo'),
  markCancel: document.getElementById('mark-cancel'),
  markDone: document.getElementById('mark-done'),
  sheet: document.getElementById('sheet'),
  list: document.getElementById('list'),
  rowMoveHint: document.getElementById('row-move-hint'),
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
  itemMissing: document.getElementById('item-missing'),
  descriptionHint: document.getElementById('description-hint'),

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
  submitNote: document.getElementById('submit-note'),
  announce: document.getElementById('announce'),
  result: document.getElementById('result'),
  resultText: document.getElementById('result-text'),
  resultPath: document.getElementById('result-path'),
  resultNote: document.getElementById('result-note'),
  copyAgain: document.getElementById('copy-again'),
  clearCopied: document.getElementById('clear-copied'),
  reveal: document.getElementById('reveal'),
  previewPromptBtn: document.getElementById('preview-prompt'),
  promptPreview: document.getElementById('prompt-preview'),

  clearBuffers: document.getElementById('clear-buffers'),
  discardAll: document.getElementById('discard-all'),
  undo: document.getElementById('undo'),
  version: document.getElementById('version'),
};

/**
 * @typedef {Object} Item
 * @property {string}  id
 * @property {'region'|'element'|'visible'|'page'|'other'} mode
 * @property {number}  width        Captured size, in device pixels.
 * @property {number}  height
 * @property {string}  url          Page the item was captured on.
 * @property {string}  title        That page's title, which the prompt names
 *                                  when the page itself could not be read.
 * @property {number|null} tabId    The tab it was captured on. Only meaningful
 *                                  while the capture is in hand, so not stored:
 *                                  tab ids do not survive a restart.
 * @property {'bug'|'change'} intent
 * @property {string}  description
 * @property {boolean} included     Ticked: goes into the next prompt.
 * @property {Object|null} element  Payload from picker.js, element mode only.
 * @property {number}  capturedAt   Epoch ms.
 * @property {number=} rank         The item's place on the sheet once it has
 *                                  been moved (see moveItem). Absent, it stands
 *                                  at capturedAt, so a sheet nobody reordered
 *                                  carries none. Merged with the intent and the
 *                                  tick, under editedAt.
 * @property {number}  editedAt     Epoch ms of the last change to the intent,
 *                                  the tick or the place, from any panel. A
 *                                  merge of two panels' sheets keeps the newer
 *                                  of each.
 * @property {number=} wordsAt      The same for the description. Apart from
 *                                  editedAt, so a tick written by a panel that
 *                                  had not yet seen the latest words does not
 *                                  carry its older sentence back with it.
 * @property {string|null} thumb    Downscaled image for the frame and the strip.
 *                                  The only copy of the pixels the panel keeps;
 *                                  the full PNG is on disk.
 * @property {string|null} path     Absolute path of that PNG. Null while saving,
 *                                  and an item is only persisted once it is set.
 * @property {number|null} downloadId  Known from the moment Chrome starts the
 *                                  download, so a panel closed mid save can
 *                                  take the file back.
 * @property {boolean=} missing     Chrome reports the file gone from the disk.
 *                                  Asked again rather than stored.
 * @property {boolean=} unchecked   Chrome no longer lists the file under that
 *                                  id, so whether it exists cannot be asked.
 * @property {boolean=} verified    The id is known this session to name this
 *                                  item's own file: this panel saved it, or
 *                                  recordFor found it so. Chrome does not
 *                                  reissue an id within a session. Not stored.
 * @property {boolean=} marked      Its file is a copy with marks drawn on it
 *                                  (see commitMarks). Stored only when true.
 * @property {number=} fileAt       Epoch ms of the last time marking up gave
 *                                  the item another file, in any panel. A
 *                                  merge takes path, downloadId and marked
 *                                  from the side with the newer stamp. Stored
 *                                  only once set.
 * @property {Blob|null=} full      The clean capture, kept for marking up by
 *                                  the panel that took it, while it stays
 *                                  open, for its newest captures (holdFull).
 *                                  Never stored.
 * @property {boolean=} fullReleased  That capture was let go to keep within
 *                                  the bound, so the item says why it can no
 *                                  longer be marked up. Not stored.
 * @property {Mark[]|null=} marks   The marks drawn on its file in this panel,
 *                                  which marking up again starts from. Not
 *                                  stored.
 * @property {Mark[]|null=} unsaved Marks whose save failed, which marking up
 *                                  again starts from instead. Not stored.
 * @property {{ downloadId: number|null }|null=} markSave  A marked copy on its
 *                                  way to disk. Copy waits for it. Not stored.
 * @property {Stitched=} stitched   How a page item (mode 'page') was put
 *                                  together, which the prompt says. Stored.
 */

/**
 * @typedef {Object} Stitched
 * @property {number} screens    How many screenshots it was put together from.
 * @property {number} cssWidth   What it shows of the page, in CSS pixels.
 * @property {number} cssHeight
 * @property {true=}  cut        The page went on below what it shows
 *                               (PAGE_MAX_HEIGHT). Present only when true.
 */

/**
 * @typedef {Object} Mark
 * One arrow or ellipse drawn on a screenshot. Its two points are shares of
 * the image's width and height (0 to 1), so one record draws the same at the
 * frame's scale and at full size.
 * @property {'arrow'|'ellipse'} tool
 * @property {number} x1  Where the drag began: the arrow's tail, or a corner
 *                        of the box the ellipse fills.
 * @property {number} y1
 * @property {number} x2  Where it ended: the arrow's head, or the opposite
 *                        corner.
 * @property {number} y2
 */

const state = {
  tab: null,
  restriction: null,
  restrictionShown: false, // whether the banner is the restriction's, so resolveTab clears only its own
  bannerScope: null, // what the banner is about, see showBanner
  slowSaves: 0, // saves still waiting that have shown the slow save hint
  settledTabId: null, // the tab, and its url, of the last resolveTab to finish
  settledUrl: null,
  intent: 'bug', // what the NEXT item starts as; sticky, like the toggles
  armedMode: null, // 'region' | 'element' | null
  armedTabId: null, // which tab that arm was issued against
  armedId: null, // the armId behind that arm, when it has one (the shortcut's has none)
  armedRun: null, // the page's name for the start() that arm made, once a cdr:armed has said it
  armedChanges: 0, // bumped by every change to the three above, so a reply can tell it is older
  cancelledArmIds: new Set(), // arms this panel cancelled or replaced, whose late cdr:armed is ignored
  cancels: new Map(), // tabId -> a disarm on its way there, so a capture on that tab can wait
  resolving: 0, // bumped by each resolveTab(), so an older one that answers late gives way
  capturing: false, // a Screen or Page capture in flight, so a second click cannot start another
  // The whole page capture in progress, see capturePage: { tabId, tab,
  // cancelled, reason, screens, expected, composing, stopped, stop }. Null
  // while none runs.
  pageShot: null,
  reads: 0, // bumped by each refreshContext(), so an older read that answers late leaves the chips alone
  countsRead: 0, // the read the chips show
  /** @type {Item[]} */
  items: [],
  // The item in the frame, whose description the field edits. Distinct from
  // the ticks: any number of items can be ticked, one at most is in the frame.
  selectedId: null,
  // id -> when it left the sheet, by a discard or a copy, in any panel. A
  // write from another panel that crossed that removal still lists the item;
  // this is how it stays gone. Stored with the report, kept for
  // REMOVED_TTL_MS, which outlasts any write that could have crossed it.
  removed: new Map(),
  // The last discard, held back for UNDO_MS before its files are deleted:
  // { entries: [{ item, index }], timer, field, typed, receipt }, see discard.
  trash: null,
  // The items of a prompt the clipboard refused, which the user is copying by
  // hand. Clearing them must not delete the files that prompt names.
  handCopy: null,
  copies: 0, // bumped by each copy that writes a receipt, so an undo can tell the receipt it would bring back is old
  chipsReadAt: 0, // when the panel last read the chips on its own (focus, pointer)
  lastDownloadId: null,
  lastPrompt: '',
  // The items the receipt is about, as { items, numbers, until }, so an answer
  // from Chrome about one of their files just after the copy reaches it
  // (writeReceiptNote).
  lastCopy: null,
  busy: false,
  // The markup open on the item in the frame, see openMarkup: { item, bitmap,
  // width, height, tool, saved, marks, pending, cursor, pointerId }. Null
  // while nothing is being marked up.
  markup: null,
  markupOpening: null, // a markup whose screenshot is being decoded, so a second press waits
  markTool: 'arrow', // the tool a markup starts with; sticks for the life of the panel
  fulls: [], // the items holding their clean capture, oldest first, see holdFull
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

/**
 * @param {string|null} message  null hides the banner
 * @param {'warn'|'error'} kind
 * @param {'page'|'capture'|'report'|'missing'} scope  what the message is
 *   about, which decides when resolveTab takes it down: the page in view
 *   (goes when that page changes), one capture (goes when the tab changes),
 *   or the report (stays until its cause is dealt with). 'missing' is the
 *   report's missing file, which a discard recounts.
 *
 * Nothing to say, on a tab the panel may not capture, still says that: the
 * restriction holds for as long as the tab is in view, and this line is the
 * only place it is said. Hidden instead, it stayed away after a copy, or
 * after a missing file's banner went, until the next tab event.
 */
function showBanner(message, kind = 'warn', scope = 'capture') {
  if (!message && state.restriction) {
    // Already up: set again, its text would be read out again.
    if (state.restrictionShown) return;
    message = state.restriction;
    kind = 'error';
    scope = 'page';
  }
  // Whether the banner is the restriction's, so resolveTab takes down only
  // its own. Any other banner has replaced it, and is not resolveTab's to
  // clear.
  state.restrictionShown = Boolean(message) && message === state.restriction;
  if (!message) {
    el.banner.hidden = true;
    state.bannerScope = null;
    return;
  }
  state.bannerScope = scope;
  // Set before the text, so the region already has the politeness the text
  // is announced with: an error interrupts, a notice waits its turn.
  el.bannerLive.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
  el.banner.textContent = message;
  el.banner.className = kind === 'error' ? 'notice error' : 'notice';
  el.banner.hidden = false;
}

/**
 * Read a line out to a screen reader, through a status region that is always
 * in the page. For what appears along with its own text, like the receipt,
 * which a region of its own would not announce.
 */
function announce(message) {
  el.announce.textContent = message;
}

/** The timer that puts announceAnew's line back, see there. */
let announceTimer = null;

/**
 * Announce a line that may be the one the status region already holds, as
 * "Item 1 is already first." is on a second press at the top. A screen
 * reader may not read a region set to the text it has, so the region is
 * emptied and the line put back a moment later, unless something else was
 * said in between. Any other line is announced at once, as announce() does.
 */
function announceAnew(message) {
  clearTimeout(announceTimer);
  if (el.announce.textContent !== message) {
    announce(message);
    return;
  }
  announce('');
  announceTimer = setTimeout(() => {
    if (!el.announce.textContent) announce(message);
  }, 100);
}

function setCount(node, value) {
  node.textContent = value === 0 || value ? String(value) : '–';
  node.classList.toggle('has', Boolean(value));
}

/**
 * What the console and network chips show until the first read of the tab in
 * view comes back, as panel.html has them: neither a count, which a 0 claims
 * of a page nothing has read yet, nor the dash, which says the read failed.
 * Put back on a change of tab, which left the counts of the tab before up
 * for as long as a slow read took.
 */
const UNREAD_COUNT = '…';

function clearCounts() {
  for (const node of [el.countConsole, el.countNetwork]) {
    node.textContent = UNREAD_COUNT;
    node.classList.remove('has');
  }
}

/**
 * Single source of truth for which capture mode is waiting on which tab.
 *
 * The tab id matters because arming is per-tab but the panel is per-window: a
 * mode armed on tab A must not read as armed once the user switches to tab B.
 */
function setArmed(mode, tabId = null, armId = null, run = null) {
  const before = [state.armedMode, state.armedTabId, state.armedId];
  state.armedMode = mode;
  state.armedTabId = mode ? tabId : null;
  state.armedId = mode ? armId : null;
  state.armedRun = mode ? run : null;
  if ([state.armedMode, state.armedTabId, state.armedId].some((value, i) => value !== before[i])) {
    state.armedChanges += 1;
  }
  for (const [name, node] of [
    ['region', el.modeRegion],
    ['element', el.modeElement],
  ]) {
    node.classList.toggle('armed', name === mode);
    // The lit button is the only sign of an arm; a screen reader gets it here.
    node.setAttribute('aria-pressed', String(name === mode));
  }
  holdArm();
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
  state.tab = tab || null;
  // The chips are the tab's before, or nothing's yet, until this one's read.
  if (tab && tab.id !== state.settledTabId) clearCounts();
  // And no longer follow the tab before.
  if (countsPort && countsPort.tabId !== tab?.id) unwatchCounts();

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
  // A page shot photographs whatever tab is in view, so it ends with the
  // switch, and the page it scrolled is put back.
  if (state.pageShot && state.pageShot.tabId !== (tab?.id ?? null)) stopPageShot('tab');

  if (!tab) {
    el.targetUrl.textContent = 'No active tab';
    el.statusDot.className = 'dot blocked';
    return;
  }

  el.targetUrl.textContent = tab.url || tab.pendingUrl || '(no url)';
  el.targetUrl.title = tab.url || '';

  // What the panel knew of the arm when it asked, so an answer the worker read
  // before a change the panel has seen since (see the adoption below) is not
  // taken for news.
  const armedChanges = state.armedChanges;
  let response = null;
  try {
    response = await chrome.runtime.sendMessage({ type: 'cdr:check-tab', tabId: tab.id });
  } catch {
    // The worker did not answer, as when the extension is reloaded under the
    // panel. Read as a tab nothing is known about rather than thrown on: at
    // startup the throw would leave `ready` rejected, and every broadcast for
    // the life of the panel dropped. The next call asks again.
  }
  // A newer call, for the tab now in view, owns the panel. This answer is
  // about a tab the user has left, and would light its mode or carry its
  // restriction over.
  if (call !== state.resolving) return;
  // An incognito tab is treated as a page the panel may not capture. Nothing
  // told it apart before, and with incognito access on, a capture there went
  // to the shared storage and the regular download history.
  state.restriction = response?.restriction || (tab.incognito ? INCOGNITO_RESTRICTION : null);

  // Measured against the last call that got this far, not against state.tab,
  // which calls overtaken on the way here have written too: opening a tab
  // fires onActivated and onUpdated together, and only the first of those
  // calls would otherwise have seen the switch. The panel's first call is no
  // switch.
  const switched = state.settledTabId != null && state.settledTabId !== tab.id;
  const moved = switched || (state.settledUrl != null && state.settledUrl !== (tab.url || ''));
  state.settledTabId = tab.id;
  state.settledUrl = tab.url || '';
  // A new page has a bridge of its own, which the read below connects to.
  // Chrome closes the port when its page is unloaded, and from Chrome 123
  // when its page goes into the back/forward cache; before that a cached
  // page kept its port, and the chips would have gone on following it.
  if (moved) unwatchCounts();

  // The worker tracks which tab has an overlay waiting. Adopting it here covers
  // the case a one-shot broadcast cannot: Alt+Shift+C arms the page and opens
  // the panel together, so the cdr:armed message can be sent before this
  // document exists to hear it. Not an arm this panel has cancelled, though:
  // the worker records an arm when it lands, which can be after the cancel.
  // Nor one whose end the panel has seen since it asked, such as Esc on the
  // shortcut's arm, which has no armId to refuse it by: the worker may have
  // read the answer before that disarm reached it.
  if (
    response?.armedMode &&
    !state.armedMode &&
    state.armedChanges === armedChanges &&
    !(response.armId && state.cancelledArmIds.has(response.armId))
  ) {
    setArmed(response.armedMode, tab.id, response.armId || null);
  }

  el.statusDot.className = state.restriction ? 'dot blocked' : 'dot ready';
  // Only a banner this sets, unless what it is about has gone. A busy page
  // sends its 'complete' or a new URL just after it frees, which is when a
  // notice about the capture taken while it was busy matters most, so that
  // stays until the tab changes. An error about the page goes with the page.
  // One about the report (a missing file, a failed copy) is left alone. A
  // restriction does replace any banner, and once it goes, a missing file,
  // which still holds the copy back, is said again.
  const scope = state.bannerScope;
  if (state.restriction) showBanner(state.restriction, 'error', 'page');
  else if (
    state.restrictionShown ||
    (moved && scope === 'page') ||
    (switched && scope === 'capture')
  ) {
    showBanner(null);
  }
  state.restrictionShown = Boolean(state.restriction);
  if (el.banner.hidden) sayMissing();

  applyModesDisabled();

  refreshContext();
}

/**
 * The capture buttons can be pressed unless the tab in view may not be
 * captured, or a markup has taken their row's place (see showMarking). A
 * tab change while marking leaves them off. While a page shot runs, Page is
 * its Stop and the other three wait.
 */
function applyModesDisabled() {
  const disabled = Boolean(state.restriction) || Boolean(state.markup);
  el.modeRegion.disabled = disabled || Boolean(state.pageShot);
  el.modeElement.disabled = disabled || Boolean(state.pageShot);
  el.modeVisible.disabled = disabled || Boolean(state.pageShot);
  el.modePage.disabled = disabled;
}

// --------------------------------------------------------------- capture --

/**
 * The visible tab as a PNG data url, and when it was taken. The time is read
 * just before the call that takes the pixels, not when the item is added
 * after decoding and cropping: a list sorts each logged entry to the
 * capture it came before, and one logged in that gap came after the image.
 *
 * @returns {Promise<{ dataUrl: string, takenAt: number }>}
 */
async function captureViewport() {
  // captureVisibleTab is rate limited to roughly two calls per second across
  // the whole extension. Captures here are user-initiated so collisions are
  // rare, but a double-click on a mode button would hit it.
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const takenAt = Date.now();
      const dataUrl = await chrome.tabs.captureVisibleTab(state.tab.windowId, { format: 'png' });
      return { dataUrl, takenAt };
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

const RESIZED_DURING_CAPTURE =
  'The tab changed size between the selection and the screenshot, so this crop may be off.';

// The overlay's host, put into the element shown fullscreen, moved the page's
// layout there while Region was armed (a :last-child rule), and the page moved
// back once it was gone, before the screenshot (content/overlay.js, childBoxes).
const MOVED_UNDER_OVERLAY =
  'The page moved its fullscreen content while Region was armed and moved it back for the screenshot, so this crop may be off.';

/**
 * Crop a viewport screenshot down to a CSS-pixel rect.
 *
 * The scale factor is derived from the captured bitmap rather than trusting
 * devicePixelRatio, because browser zoom also changes the ratio between CSS
 * pixels and captured pixels and devicePixelRatio alone would be wrong.
 *
 * The rect is in layout viewport pixels, and the screenshot is the visual
 * viewport: under pinch zoom that is a magnified part of the layout viewport,
 * starting at the visual viewport's offset, and a crop that ignored it was a
 * different, smaller patch of the page. So the rect is moved by that offset
 * and scaled by the pinch zoom on top of the bitmap's own scale. With no pinch
 * zoom the scale is 1 and the offset 0, and the arithmetic is the same as
 * without it, to the pixel. What part of the rect lies outside the visible
 * area is not in the picture, and is cut off rather than shifting the crop.
 *
 * The height is measured against the bitmap too. The two scales agree unless
 * the tab changed size between the measurement and the screenshot (the panel
 * opening or closing, a window resized), and then the result says so.
 *
 * @returns {Promise<{ dataUrl: string, width: number, height: number, notice: string|null }>}
 */
async function cropCapture(fullDataUrl, rect, viewport) {
  const image = await loadImage(fullDataUrl);
  const base = viewport?.width ? image.naturalWidth / viewport.width : 1;

  const visual = viewport?.visual;
  const zoom = Number.isFinite(visual?.scale) && visual.scale > 0 ? visual.scale : 1;
  const offsetX = Number.isFinite(visual?.x) ? visual.x : 0;
  const offsetY = Number.isFinite(visual?.y) ? visual.y : 0;
  const scale = base * zoom;

  let x = rect.x - offsetX;
  let y = rect.y - offsetY;
  let { width, height } = rect;
  if (x < 0) [width, x] = [width + x, 0];
  if (y < 0) [height, y] = [height + y, 0];

  const sx = Math.max(0, Math.round(x * scale));
  const sy = Math.max(0, Math.round(y * scale));
  const sw = Math.max(1, Math.min(Math.round(width * scale), image.naturalWidth - sx));
  const sh = Math.max(1, Math.min(Math.round(height * scale), image.naturalHeight - sy));

  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  canvas.getContext('2d').drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);

  // A device pixel ratio that is not a whole number rounds each side of the
  // bitmap on its own, so a few percent apart is still the same size.
  const baseY = viewport?.height ? image.naturalHeight / viewport.height : base;
  const resized = Math.abs(baseY - base) > base * 0.03;

  return {
    dataUrl: canvas.toDataURL('image/png'),
    width: sw,
    height: sh,
    notice: resized ? RESIZED_DURING_CAPTURE : null,
  };
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
 *
 * `source` is a data URL, an image or a canvas: a capture arrives as a data
 * URL, and a marked copy is drawn on a canvas (see commitMarks), which is cut
 * down as it is rather than encoded and decoded again first. `maxHeight` is
 * the item's own bound, from thumbMaxHeight, so the thumbnail made at the
 * capture and the one made after marking it up agree.
 */
async function makeThumb(source, maxHeight = THUMB_MAX_HEIGHT) {
  const image = typeof source === 'string' ? await loadImage(source) : source;
  // An image has a natural size; a canvas and a decoded bitmap have only theirs.
  const width = image.naturalWidth ?? image.width;
  const height = image.naturalHeight ?? image.height;
  const scale = Math.min(1, THUMB_MAX_WIDTH / width, maxHeight / height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/webp', THUMB_QUALITY);
}

/**
 * The tallest a thumbnail of an item of this mode may be. Every mode shares
 * THUMB_MAX_HEIGHT. A mode whose captures run far taller than the frame is
 * wide gets a bound of its own here, the one place every thumbnail of an item
 * asks, whoever makes it.
 */
function thumbMaxHeight(mode) {
  switch (mode) {
    // A whole page is many screens tall, and shown in a frame that scrolls.
    case 'page':
      return PAGE_THUMB_MAX_HEIGHT;
    default:
      return THUMB_MAX_HEIGHT;
  }
}

/** The bytes behind a data URL, as a Blob. */
async function blobOf(dataUrl) {
  return (await fetch(dataUrl)).blob();
}

// ----------------------------------------------------------------- items --

function selectedItem() {
  return state.items.find((item) => item.id === state.selectedId) || null;
}

/**
 * Show the item in the frame. Called again whenever anything about the sheet
 * changes, a move of any row and every write adopted from another window
 * included, so it sets what the item says and nothing more: called twice
 * with nothing changed, it leaves the frame as it was. An open markup has
 * its canvas in the image's place, and that stays as it is: only the
 * readout and the buttons follow the item.
 */
function renderFrame() {
  const item = selectedItem();
  // Kept with the item rather than only in the shared banner, which other
  // news replaces: why this item holds Copy back, and what lifts it.
  el.itemMissing.hidden = !item?.missing;
  updateMarkUp();

  // A whole page is shown at the frame's width in a wrapper that scrolls,
  // which takes focus so the arrow keys scroll it too.
  const tall = item?.mode === 'page';
  el.preview.classList.toggle('tall', tall);
  if (tall) {
    el.previewScroll.setAttribute('tabindex', '0');
    el.previewScroll.setAttribute('aria-label', 'Whole page screenshot. Scroll to see all of it.');
  } else {
    el.previewScroll.removeAttribute('tabindex');
    el.previewScroll.removeAttribute('aria-label');
  }
  el.previewScroll.hidden = !item;

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
  // alt text and a broken-image glyph while it fails. While the item is marked
  // up, the markup's canvas stands in the image's place (showMarking).
  if (markingUp(item)) {
    el.previewImg.hidden = true;
    // Only its label, which names the item by its number.
    showMarkTool();
  } else if (item.thumb) {
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
  // The size of the saved PNG, which is in the screen's own pixels: twice the
  // page's CSS pixels on a Retina display, and more again when zoomed in.
  // Named as such, because the prompt's viewport line is in CSS pixels and
  // two bare sizes side by side read as one measure that disagrees.
  el.previewMeta.textContent = `${position}${MODE_LABEL[item.mode]} · PNG ${item.width}×${item.height}${statusOf(item)}`;
  el.previewMeta.hidden = false;
}

/**
 * What the frame's readout and a row's head say after the item's kind: why
 * it holds Copy back (its file gone, or a file still being written), that it
 * is being marked up, or that its screenshot carries marks.
 */
function statusOf(item) {
  if (item.missing) return ' · FILE MISSING';
  if (!item.path || item.markSave) return ' · SAVING';
  if (markingUp(item)) return ' · MARKING';
  if (item.marked) return ' · MARKED';
  // A whole page that went on below what it shows (PAGE_MAX_HEIGHT).
  return item.stitched?.cut ? ' · CUT SHORT' : '';
}

/**
 * What a screen reader gets for a row's pick button; the number alone says
 * nothing. The sentence itself rides along, cut short.
 */
function describeRow(item, index) {
  const head =
    `Item ${index + 1}, ${MODE_LABEL[item.mode].toLowerCase()}` +
    `${item.marked ? ', marked' : ''}${item.stitched?.cut ? ', cut short' : ''}`;
  if (item.missing) return `${head}, file missing`;
  const words = item.description.trim();
  if (!words) return `${head}, no description yet`;
  return `${head}: ${words.length > 90 ? `${words.slice(0, 90)}…` : words}`;
}

/** The small readout above a row's sentence. */
function rowHead(item, index) {
  return `${index + 1} · ${MODE_LABEL[item.mode]}${statusOf(item)}`;
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
  cancelHideTip();
  tipAnchor = button;
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

/** Take the tooltip down, and call off a click on it still waiting to go on. */
function hideTip() {
  cancelTipClick();
  closeTip();
}

/**
 * Take the tooltip down and nothing else: the pointer has wandered off it
 * (scheduleHideTip), or a click on it has waited its turn (clickThroughTip).
 * A click on the tooltip just before the pointer left still goes on.
 */
function closeTip() {
  cancelHideTip();
  tipAnchor = null;
  el.tip.hidden = true;
}

/**
 * How long a click on the tooltip waits for a second press before it is
 * acted on, and the tooltip stays for it, until the user's own double clicks
 * say to wait longer (tipClickMs). A second press makes it a double click,
 * which selects a word of the tooltip as a double click on any text does
 * (see holdTipRun). The double click time macOS and Windows set unless the
 * user slows it: at 300 ms, a double click of 380 ms picked the row.
 */
const TIP_CLICK_MS = 500;
/**
 * The most the wait grows to (see learnClickTime). Windows lets the user slow
 * a double click to 900 ms, and macOS further still; a click on the tooltip
 * that waited seconds would read as lost.
 */
const TIP_CLICK_MAX_MS = 1000;
/** The wait now: TIP_CLICK_MS, or longer once the user's double clicks are. */
let tipClickMs = TIP_CLICK_MS;
/** When the last press in the panel went down, see learnClickTime. */
let lastPressAt = null;
/** The click on the tooltip that is waiting, see clickThroughTip. */
let tipClickTimer = null;

/**
 * Learn how slow a double click the system allows, from the double clicks it
 * counts. No web API tells the system's double click time, but the browser
 * counts a press as the next click of a run (event.detail) only inside it, so
 * every such press, anywhere in the panel, is a gap the system allows. The
 * wait grows to the slowest one seen, with a fifth to spare, so a user who
 * has slowed their double click waits longer, and nobody else does. Kept for
 * the life of the panel. The first slow double click, before any is seen,
 * still picks the row.
 */
function learnClickTime(event) {
  if (event.detail > 1 && lastPressAt != null) {
    const gap = event.timeStamp - lastPressAt;
    if (gap > 0) tipClickMs = Math.min(TIP_CLICK_MAX_MS, Math.max(tipClickMs, Math.round(gap * 1.2)));
  }
  lastPressAt = event.timeStamp;
}

function cancelTipClick() {
  clearTimeout(tipClickTimer);
  tipClickTimer = null;
}

/**
 * A click on the tooltip, where it covers the sheet's rows, is a click on the
 * row under it; anywhere else it only takes the tooltip down.
 *
 * It takes the pointer so it can be read at length, and it sits over the row
 * above its own (or below, near the top). A click there used to land on the
 * tooltip and do nothing, so picking the row under it took a second try, and
 * that one was swallowed too while the tooltip stayed. So the click goes on
 * to the row under that point, with its detail, so a row picked this way puts
 * the caret in its field as any pointer click does.
 *
 * Only a row. Placed below its row, or near the top of the sheet, the tooltip
 * covers Copy, the Attach chips, Clear selection and + New item, and a click
 * passed on to those pressed Copy (overwriting a prompt not yet pasted, and
 * emptying the sheet) or unticked a chip for every later prompt, while the
 * user was looking at the tooltip and not at what it hid.
 *
 * Not at once: a press that follows within tipClickMs makes a double click,
 * which selects the word under it. Nor a drag that selected the tooltip's
 * words: that is reading it.
 */
function clickThroughTip(event) {
  const selection = document.getSelection?.();
  if (selection && !selection.isCollapsed && el.tip.contains(selection.anchorNode)) return;
  // The second click of a double click, whose press called the first off.
  if (event.detail > 1) return;
  cancelTipClick();
  // Found now, while the user can see where they clicked. The first element
  // at that point that is not the tooltip's own.
  const under = [...(document.elementsFromPoint?.(event.clientX, event.clientY) || [])].find(
    (node) => !el.tip.contains(node)
  );
  const row = under && under !== el.list && el.list.contains(under) ? under : null;
  const init = {
    bubbles: true,
    cancelable: true,
    view: window,
    detail: event.detail,
    clientX: event.clientX,
    clientY: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY,
    button: event.button,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
  };
  const anchor = tipAnchor;
  tipClickTimer = setTimeout(() => {
    tipClickTimer = null;
    // Not another row's tooltip, opened since by the pointer moving on.
    if (tipAnchor === anchor) closeTip();
    // Still on the sheet: a rebuild of the rows meanwhile took the tooltip
    // down with hideTip, which called this off.
    if (!row || !el.list.contains(row)) return;
    // A press focuses the control under it before the click; this press went
    // to the tooltip, which cannot take focus.
    row.closest?.('button, input, textarea, select, a[href]')?.focus?.({ preventScroll: true });
    row.dispatchEvent(new MouseEvent('click', init));
  }, tipClickMs);
}

/**
 * The press that began the run of clicks now under way, when it was on the
 * tooltip: its time and the box the tooltip had. The browser counts a press
 * that follows soon after, close by, as the next click of the same run
 * (event.detail), whatever is under it.
 */
let tipRun = null;
/** Whether the press now under way is kept from what it landed on. */
let tipHeld = false;

/**
 * Follow a run of clicks that began on the tooltip.
 *
 * Its second press (detail 2) calls the first click off: the user is
 * selecting a word, and the browser does that for them. On the tooltip, or
 * where it was, as when the pointer slipped off it and it closed: such a
 * press is also kept from the control it lands on there, Copy perhaps, while
 * it is inside tipClickMs. Not later: by then the tooltip has gone, and a
 * press on what it uncovered is one the user aimed there, which the system
 * may still count as the second click.
 */
function holdTipRun(event) {
  const onTip = el.tip.contains(event.target);
  if (event.type === 'mousedown') {
    tipHeld = false;
    if (event.detail <= 1) {
      tipRun = onTip ? { at: event.timeStamp, box: el.tip.getBoundingClientRect() } : null;
    } else if (onTip) {
      cancelTipClick();
    } else if (tipRun) {
      const { at, box } = tipRun;
      const where =
        event.clientX >= box.left &&
        event.clientX <= box.right &&
        event.clientY >= box.top &&
        event.clientY <= box.bottom;
      if (where) cancelTipClick();
      tipHeld = where && event.timeStamp - at < tipClickMs;
    }
    // After: this press is judged by the wait its run began under.
    learnClickTime(event);
  }
  if (event.detail > 1 && tipHeld) {
    event.preventDefault();
    event.stopPropagation();
  }
}

/**
 * The pointer has left the row or the tooltip. Close a moment later, unless
 * it arrives on the other one first: the tooltip sits 6 px off the row, and
 * it has to stay open for the pointer to cross that gap and read it.
 */
const TIP_GRACE_MS = 150;
let tipHideTimer = null;
/** The row button the open tooltip is about. */
let tipAnchor = null;

function scheduleHideTip() {
  cancelHideTip();
  tipHideTimer = setTimeout(closeTip, TIP_GRACE_MS);
}

function cancelHideTip() {
  clearTimeout(tipHideTimer);
  tipHideTimer = null;
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
/** Whether the last press went down on the tooltip, see tipPressed. */
let pressedTip = false;
document.addEventListener(
  'pointerdown',
  (event) => {
    lastInput = 'pointer';
    pressedTip = el.tip.contains(event.target);
  },
  true
);
document.addEventListener(
  'keydown',
  (event) => {
    lastInput = 'keyboard';
    // A key calls off a click on the tooltip still waiting to go on, Esc
    // included once the tooltip has closed: the user has moved on, and the
    // click would take focus from under their keys. Not a key held down since
    // before the click, such as Shift, which repeats on Windows.
    if (!event.repeat) cancelTipClick();
  },
  true
);

/**
 * Whether focus is moving because the open tooltip was pressed. A press on
 * something that cannot take focus takes it off whatever had it, the row
 * whose tooltip it is included. The click that follows goes on to the row the
 * tooltip covers (clickThroughTip), so the tooltip has to stay for it: taken
 * down at the press, it left the click to land between two elements, on
 * neither.
 */
function tipPressed() {
  return lastInput === 'pointer' && pressedTip && !el.tip.hidden;
}

/** Fill a row's text from its item, on build and on every keystroke. */
function fillRowText(row, item, index) {
  const words = item.description.trim();
  row.querySelector('.row-head').textContent = rowHead(item, index);
  const body = row.querySelector('.row-body');
  body.textContent = words || 'No description yet.';
  body.classList.toggle('quiet', !words);
  row.querySelector('.row-pick').setAttribute('aria-label', describeRow(item, index));
}

/**
 * The row being dragged to another place on the sheet, by its item's id,
 * while that drag is under way.
 *
 * A drag carries a type of the panel's own and no data (see renderSheet), so
 * a drop on the page, or anywhere but the list, gets nothing it can read. The
 * list takes no drag but one of its own rows: not a file, not the frame's
 * image, and not a row dragged from another window's panel, whose `dragged`
 * is that panel's.
 */
let dragged = null;
const ROW_DRAG = 'application/x-punch-list-row';
/** The gap the drop line is drawn in now, see markSlot. */
let dropMarked = null;

function ownDrag(event) {
  return dragged != null && Array.from(event.dataTransfer?.types || []).includes(ROW_DRAG);
}

/**
 * The gap under the pointer, counted in rows: 0 above the first row, the row
 * count below the last. The upper half of a row is the gap above it.
 */
function dropSlot(y) {
  const rows = [...el.list.children];
  const index = rows.findIndex((row) => {
    const box = row.getBoundingClientRect();
    return y < box.top + box.height / 2;
  });
  return index === -1 ? rows.length : index;
}

/**
 * Draw the line where the row would land: above the row at `slot`, or below
 * the last row, or nowhere for null. Classes change only when the gap does,
 * so a dragover, which Chrome fires every few milliseconds, costs no style
 * work while the pointer stays over one gap.
 */
function markSlot(slot) {
  if (slot === dropMarked) return;
  dropMarked = slot;
  const rows = [...el.list.children];
  rows.forEach((row, index) => {
    row.classList.toggle('drop-before', index === slot);
    row.classList.toggle('drop-after', slot === rows.length && index === rows.length - 1);
  });
}

/** The drag is over, dropped or not: nothing stays dimmed or marked. */
function endDrag() {
  dragged = null;
  markSlot(null);
  for (const row of el.list.children) row.classList.remove('dragging');
}

/**
 * Build the sheet's rows afresh. `focus` is the item whose row gets the
 * keyboard back if a row had it: the one in the frame, unless a move took
 * the row the keys were on elsewhere.
 */
function renderSheet({ focus = state.selectedId } = {}) {
  // The rebuild destroys the button that has focus. Putting focus back on the
  // row in the frame keeps a keyboard user where they were.
  const hadFocus = el.list.contains(document.activeElement);
  hideTip();
  // The new rows carry no drop line; the next dragover draws it again.
  dropMarked = null;
  // One item alone has nowhere to go.
  const movable = state.items.length > 1;

  el.sheet.hidden = state.items.length === 0;
  el.list.replaceChildren(
    ...state.items.map((item, index) => {
      const row = document.createElement('li');
      row.className = 'row';
      row.classList.toggle('on', item.id === state.selectedId);
      row.classList.toggle('included', item.included);
      row.classList.toggle('missing', Boolean(item.missing));
      // A write from another window can rebuild the list mid drag.
      row.classList.toggle('dragging', item.id === dragged);
      row.draggable = movable;

      const tick = document.createElement('label');
      tick.className = 'row-tick';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = item.included;
      box.setAttribute('aria-label', `Include item ${index + 1} in the prompt`);
      box.addEventListener('change', () => {
        item.included = box.checked;
        touch(item);
        row.classList.toggle('included', item.included);
        persist();
        updateSubmitState();
        // Unticking a missing item is one of the two ways to lift the block
        // the banner explains, so the banner is recounted.
        if (state.bannerScope === 'missing') {
          showBanner(null);
          sayMissing();
        }
      });
      tick.append(box);

      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'row-pick';
      pick.setAttribute('aria-pressed', String(item.id === state.selectedId));
      // The keys that move the row (see the keydown listener), and the one
      // hint that names them on this platform.
      if (movable) {
        pick.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
        pick.setAttribute('aria-describedby', 'row-move-hint');
      }

      const thumb = document.createElement('span');
      thumb.className = 'row-thumb';
      const img = document.createElement('img');
      img.alt = '';
      // The row drags, not the picture: an image dragged on its own carries
      // its data URL, and a drop on the page would hand the page the pixels.
      img.draggable = false;
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
      pick.addEventListener('click', (event) => {
        selectItem(item.id);
        // Someone who clicked a row is about to type into it, and the click
        // left focus on the row. A key press (detail 0) keeps a keyboard user
        // on the sheet, where Tab still walks the rows.
        if (event.detail > 0) focusDescription();
      });

      // Only a row that cut its sentence short has anything to add on hover;
      // the tooltip reads live from the item, so a sentence typed after the
      // row was built is what shows.
      const show = () => {
        if (body.scrollHeight > body.clientHeight + 1) {
          showTip(pick, item, state.items.indexOf(item));
        }
      };
      pick.addEventListener('mouseenter', show);
      // Not at once: the pointer may be on its way to the tooltip.
      pick.addEventListener('mouseleave', scheduleHideTip);
      // A click focuses a button too, and would otherwise pin the tooltip
      // open until focus moved on. Only keyboard focus earns it.
      pick.addEventListener('focus', () => {
        if (lastInput === 'keyboard') show();
      });
      pick.addEventListener('blur', () => {
        if (!tipPressed()) hideTip();
      });

      row.addEventListener('dragstart', (event) => {
        dragged = item.id;
        hideTip();
        // The panel's own type and no data, see `dragged`.
        event.dataTransfer?.setData(ROW_DRAG, '');
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        // Dimmed a moment later, once Chrome has taken the drag image from
        // the row as it looks now.
        setTimeout(() => {
          if (dragged === item.id) row.classList.add('dragging');
        }, 0);
      });
      row.addEventListener('dragend', endDrag);

      row.append(tick, pick);
      fillRowText(row, item, index);
      return row;
    })
  );

  const on = el.list.querySelector('.row.on');
  if (on) revealRow(on);
  // The row the keys were on, wherever a move took it. For every other
  // rebuild that is the row in the frame, revealed above.
  const kept = el.list.children[state.items.findIndex((item) => item.id === focus)];
  if (kept && kept !== on) revealRow(kept);
  if (hadFocus) kept?.querySelector('.row-pick').focus({ preventScroll: true });
}

/**
 * Scroll the list, and only the list, until the row is in it.
 *
 * scrollIntoView scrolls every scrolling ancestor, and the panel document is
 * one once the sheet grows: three captures in a 700 px panel scrolled the top
 * of the frame off screen, and any banner with it.
 */
function revealRow(row) {
  const list = el.list.getBoundingClientRect();
  const box = row.getBoundingClientRect();
  if (box.top < list.top) el.list.scrollTop -= list.top - box.top;
  else if (box.bottom > list.bottom) el.list.scrollTop += box.bottom - list.bottom;
}

/**
 * Tick or untick every row. The ticks decide what the next prompt carries;
 * unticked items stay on the sheet for a later one.
 */
function setAllIncluded(included) {
  for (const item of state.items) {
    if (item.included === included) continue;
    item.included = included;
    touch(item);
  }
  renderSheet();
  persist();
  updateSubmitState();
}

/**
 * Stamp a change to an item, so a merge with another panel's sheet can tell
 * whose copy is newer: { words: true } for the description, otherwise the
 * intent or the tick. Later than any change or removal of it this panel knows
 * of, so taking a discard back brings the item back in every panel, and an
 * edit made after the clock was set back still counts as the newest. Counted
 * from the stamps a merge believes (forgetFarStamps), or past a larger set
 * back the edit would be as far ahead as they are, and believed by no panel.
 */
function touch(item, { words = false } = {}) {
  const now = Date.now();
  forgetFarStamps(item, now);
  const removedAt = state.removed.get(item.id) || 0;
  const at = Math.max(now, lastChange(item) + 1, (tooFarAhead(removedAt, now) ? 0 : removedAt) + 1);
  if (words) item.wordsAt = at;
  else item.editedAt = at;
}

/** When anything about an item last changed, in any panel. */
function lastChange(item) {
  return Math.max(item.editedAt || 0, item.wordsAt || 0);
}

/**
 * Whether a stamp is further ahead of the clock than STAMP_AHEAD_MS. A merge
 * counts such a stamp as none, wherever it comes from (readItem and
 * forgetFarStamps). It was not made by this browser since the clock was last
 * set back by less than that: something else wrote it into storage (content
 * scripts can), or the clock went back further. Taken as it is, it would
 * outrank every edit made with the clock as it is now, and at 2^53 and past,
 * where adding one changes nothing, every edit for good. None rather than
 * capped at the limit: capped, it would be worth the moment each panel came
 * to it, and the panel that came to it last would win over a change made in
 * between.
 */
function tooFarAhead(stamp, now) {
  return stamp > now + STAMP_AHEAD_MS;
}

/**
 * Drop the stamps of an item this panel holds that are too far ahead, as
 * readItem drops them from what it reads. The same rule on both sides of a
 * merge is what ends the write loop 0.6.1 had. It read stored stamps capped at
 * the clock and kept its own as they were, so once the clock went back each
 * of two panels found its own copy newer than the one it read, and wrote it
 * back to the other, until the clock passed the newest stamp. A panel that
 * only compared its stamps capped would keep them: their worth would rise
 * with the clock, and a panel holding one would keep winning over newer edits
 * from a window opened since. A stamp dropped here is dropped for good.
 */
function forgetFarStamps(item, now) {
  if (tooFarAhead(item.editedAt, now)) item.editedAt = 0;
  if (tooFarAhead(item.wordsAt, now)) item.wordsAt = 0;
  if (tooFarAhead(item.fileAt, now)) item.fileAt = undefined;
}

/**
 * Drop every stamp on the sheet this panel holds that is too far ahead, and
 * every removal so stamped, before a merge (adoptStored) and before a write
 * (persist). Forgotten in one panel only, a stamp would live on in storage
 * and in the panels that had not merged since, and count again once the
 * clock came back within STAMP_AHEAD_MS of it, over every change the panel
 * that forgot it had made since.
 */
function forgetFarSheet(now) {
  for (const item of state.items) forgetFarStamps(item, now);
  for (const [id, at] of state.removed) {
    if (tooFarAhead(at, now)) state.removed.delete(id);
  }
}

/**
 * The stamp of an item leaving the sheet, by a discard or a copy: now, or just
 * after its last change when that is later, as it is for a while after the
 * clock was set back. A removal stamped before the change it ends would not
 * count as after it (goneAfter in adoptStored): every other window would keep
 * the item and write it back, and this one would take it back too.
 */
function leftAt(item, now = Date.now()) {
  forgetFarStamps(item, now);
  return Math.max(now, lastChange(item) + 1);
}

/** Where an item stands on the sheet: where it was moved to, else when it was captured. */
function sheetKey(item) {
  return Number.isFinite(item.rank) ? item.rank : item.capturedAt || 0;
}

/**
 * The order of the sheet, the same in every panel, so that "item 3" is one
 * item: by place, and two items at one place by when they were captured.
 */
function bySheetOrder(a, b) {
  return sheetKey(a) - sheetKey(b) || (a.capturedAt || 0) - (b.capturedAt || 0);
}

/**
 * The item captured last, wherever it stands now: the one most likely to
 * still need its sentence. On a sheet nobody reordered it is the last row,
 * and of two captured in the same millisecond, the later row.
 */
function newestItem() {
  let newest = null;
  for (const item of state.items) {
    if (!newest || (item.capturedAt || 0) >= (newest.capturedAt || 0)) newest = item;
  }
  return newest;
}

/**
 * The rank a capture needs to land last, or undefined when its time already
 * puts it there. It does unless the clock went back, or a row was moved to
 * the end within the same millisecond: past every key on the sheet, by one.
 */
function rankAtEnd(capturedAt) {
  if (!state.items.length) return undefined;
  const highest = Math.max(...state.items.map(sheetKey));
  return capturedAt > highest ? undefined : highest + 1;
}

/**
 * Move an item to another place on the sheet, by a drag or by the keys.
 *
 * Only its rank changes: halfway between the keys of its new neighbours, or
 * one past the key at the end it went to. One number on one item, stamped
 * with touch() and so merged under editedAt like the tick: a window that
 * hears of the move takes the newer place as it takes the newer tick, and
 * every panel sorts by it (adoptStored). At today's timestamps a double holds
 * about twelve halvings of the gap between two captures a millisecond apart,
 * so about twelve moves in a row into one gap. Past that, or between two rows
 * at one place, every row takes its index as its rank.
 *
 * Not a selection: the frame and the field stay on the item being written.
 *
 * @returns {boolean} whether anything moved
 */
function moveItem(id, to) {
  const from = state.items.findIndex((item) => item.id === id);
  if (from === -1) return false;
  const count = state.items.length;
  to = Math.max(0, Math.min(count - 1, to));
  if (to === from) return false;
  const [item] = state.items.splice(from, 1);
  state.items.splice(to, 0, item);
  const before = state.items[to - 1];
  const after = state.items[to + 1];
  const rank = !before
    ? sheetKey(after) - 1
    : !after
      ? sheetKey(before) + 1
      : (sheetKey(before) + sheetKey(after)) / 2;
  if ((!before || sheetKey(before) < rank) && (!after || rank < sheetKey(after))) {
    item.rank = rank;
    touch(item);
  } else {
    state.items.forEach((each, index) => {
      if (each.rank === index) return;
      each.rank = index;
      touch(each);
    });
  }
  persist();
  renderFrame();
  renderSheet({ focus: id });
  // The worked example shows under the first item alone, and a move can
  // change which item that is.
  const selected = selectedItem();
  if (selected) showIntent(selected.intent, { example: state.items.indexOf(selected) === 0 });
  updateSubmitState();
  // The banner about a missing file names it by its number.
  if (state.bannerScope === 'missing') {
    showBanner(null);
    sayMissing();
  }
  // Two moves can read alike: row 1 down, then the new row 1 down too.
  announceAnew(`Item ${from + 1} is now item ${to + 1} of ${count}.`);
  return true;
}

/**
 * Bring one row up to date in place, for a change that leaves the sheet's
 * shape alone. Rebuilding the list for every keystroke typed in another
 * window cost every open panel a full render.
 */
function refreshRow(item) {
  const index = state.items.indexOf(item);
  const row = el.list.children[index];
  if (!row) return;
  row.classList.toggle('included', item.included);
  row.classList.toggle('missing', Boolean(item.missing));
  const box = row.querySelector('.row-tick')?.children?.[0];
  if (box) box.checked = item.included;
  const img = row.querySelector('.row-thumb')?.children?.[0];
  if (img && item.thumb && img.src !== item.thumb) img.src = item.thumb;
  fillRowText(row, item, index);
}

/**
 * Bring an item into the frame and its words into the field.
 *
 * The intent segments follow the item too: they show what this item is, and
 * pressing one changes this item. The sticky default for the next capture is
 * updated at the same time, in the click handler, on the theory that someone
 * who just marked an item as a suggestion is probably about to mark another.
 *
 * A markup open on the item leaving the frame is closed first, with its marks
 * saved (leaveMarkup): picking another row, + New item and a capture arriving
 * all come through here.
 */
function selectItem(id) {
  // A markup open on the frame's item ends before another item comes in.
  if (state.markup && state.markup.item.id !== id) leaveMarkup();
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
 * Put the caret in the description, and say so when the keys will not follow.
 *
 * focus() moves the panel's own focus, not the window's. After a drag or a
 * pick on the page, the page's tab still has the keyboard, and what is typed
 * goes there: into one of its fields, or to its shortcuts. Whether Chrome
 * lets a side panel take the keyboard back on its own is not something the
 * panel needs to know: document.hasFocus() says whether it has it, so the
 * hint shows exactly when typing would miss the field, and goes once the
 * panel is clicked.
 */
function focusDescription() {
  el.description.focus({ preventScroll: true });
  el.descriptionHint.hidden = document.hasFocus();
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
  // The tab the capture was taken on: the one in view, unless the capture
  // took long enough to bring its own (a whole page, see capturePage).
  const tab = capture.tab || state.tab;
  // The shortcut can arm an incognito tab without the panel, and its drag
  // still arrives here. Nothing from that window is written anywhere.
  if (tab?.incognito) {
    showBanner(INCOGNITO_RESTRICTION, 'error', 'page');
    return;
  }
  const capturedAt = Number.isFinite(capture.takenAt) ? capture.takenAt : Date.now();
  /** @type {Item} */
  const item = {
    id: makeId(),
    mode: capture.mode,
    width: capture.width,
    height: capture.height,
    url: tab?.url || '',
    title: tab?.title || '',
    tabId: tab?.id ?? null,
    intent: state.intent,
    description: '',
    included: true,
    // An element payload only belongs to the capture it was picked with.
    element: capture.mode === 'element' ? capture.element || null : null,
    // And how a whole page was put together, to a page.
    ...(capture.mode === 'page' && capture.stitched ? { stitched: capture.stitched } : {}),
    capturedAt,
    // A capture goes to the end of the sheet, in every panel and after a
    // reopen, which sort by place. Its time puts it there, unless that is at
    // or below a place already taken.
    rank: rankAtEnd(capturedAt),
    editedAt: Date.now(),
    // The full capture stands in until the thumbnail exists, so the frame is
    // never briefly empty. It is replaced before anything is persisted.
    thumb: capture.thumb ?? capture.dataUrl,
    path: null,
    downloadId: null,
  };

  // The armed state is not touched here. A region or element capture ended
  // its arm when the page sent it (handleBroadcast), and Screen cancelled
  // before it waited; a mode armed since then is the user's newer action.
  state.items.push(item);
  // The receipt is about the last prompt, and would otherwise sit under the
  // new sheet as if it were about this one. Unless that prompt is still being
  // copied by hand, when the proof block below it is the only copy there is.
  if (!state.handCopy) {
    el.result.hidden = true;
    el.promptPreview.hidden = true;
  }
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
  // Hands are on the mouse after a drag; the next thing to do is type. The
  // keys may still be the page's, which focusDescription says.
  focusDescription();
  // Something the user should know about this capture. Shown now and again
  // once the save is done, since the save clears the banner on its way out.
  if (capture.notice) showBanner(capture.notice);

  try {
    // A capture can bring its own thumbnail and its own Blob, when it was
    // put together from more than one screenshot; one screenshot brings its
    // data URL, and both are made from that.
    item.thumb = capture.thumb ?? (await makeThumb(capture.dataUrl, thumbMaxHeight(item.mode)));
    // Not selectItem: that resets the field's value and would throw the caret
    // to the end of whatever has been typed in the meantime.
    renderFrame();
    renderSheet();

    const blob = capture.blob ?? (await blobOf(capture.dataUrl));
    // Kept for marking up while this panel stays open; the data URL is let
    // go with this call, as before.
    holdFull(item, blob);
    // Named for the moment of the capture rather than of the save, so that
    // a marked copy of it, named the same way, shares its name.
    const saved = await saveScreenshot(
      blob,
      item.mode,
      (downloadId) => {
        item.downloadId = downloadId;
      },
      { at: item.capturedAt }
    );
    item.path = saved.path;
    item.downloadId = saved.downloadId;
    item.verified = true; // this session's own download, just completed

    // Discarded while the file was being written. The path is known only now,
    // so this is the first moment the orphan can be cleaned up. Unless the
    // discard can still be taken back, in which case the item now has what an
    // undo needs and the file goes when the undo lapses.
    if (!state.items.includes(item)) {
      if (!inTrash(item)) deleteFile(item);
      return;
    }

    persist({ thumbs: true });
    renderFrame();
    const row = el.list.children[state.items.indexOf(item)];
    if (row) fillRowText(row, item, state.items.indexOf(item));
    // A warning about this capture is shown again if the slow save hint
    // replaced it and went with the last slow save, but only over the tab it
    // is about: a switch to another tab took it down on purpose.
    if (capture.notice && el.banner.hidden && state.tab?.id === item.tabId) showBanner(capture.notice);
  } catch (error) {
    // Nothing reached the disk, so there is nothing to keep: the description
    // field has only been open for as long as the save took, and an item with
    // no screenshot would be a sentence about nothing. An item the user
    // already discarded while the dialog was open needs no explanation, and
    // leaves the discard too: it has no file, and an undo brought it back
    // marked SAVING for good, holding Copy back with it.
    releaseFull(item);
    if (!state.items.includes(item)) {
      dropFromTrash(item);
      return;
    }
    takeOff([item.id]);
    // About the report, not the page: it is all that is left of the item.
    showBanner(`${error?.message || error} Capture it again.`, 'error', 'report');
  } finally {
    updateSubmitState();
  }
}

/**
 * Take items off the sheet, and say where each one was, so an undo can put it
 * back.
 *
 * The frame moves only if its own item went. A failed save for an item that
 * was not in the frame used to move the selection, and the sentence being
 * typed carried on into another item.
 *
 * @returns {{ item: Item, index: number }[]}
 */
function takeOff(ids) {
  const wanted = new Set(ids);
  const before = state.items;
  const entries = [];
  state.items = before.filter((item, index) => {
    if (!wanted.has(item.id)) return true;
    entries.push({ item, index });
    return false;
  });
  if (!entries.length) return entries;

  if (state.selectedId != null && wanted.has(state.selectedId)) {
    // The next item that stayed, else the one before: what the user was
    // looking at moves as little as it can.
    const at = before.findIndex((item) => item.id === state.selectedId);
    const next =
      before.slice(at + 1).find((item) => !wanted.has(item.id)) ||
      before.slice(0, at).reverse().find((item) => !wanted.has(item.id)) ||
      null;
    selectItem(next?.id ?? null);
  } else {
    // Positions changed under the frame's "2/3" and the rows' numbers.
    renderFrame();
    renderSheet();
  }
  // The banner about a missing file names it by its number, which a discard
  // can change, and goes once no file is missing. Any other banner stays.
  if (state.bannerScope === 'missing') {
    showBanner(null);
    sayMissing();
  }
  updateSubmitState();
  updateElementCount();
  return entries;
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
  // An item discarded while it is marked up goes with its marks unsaved, and
  // Undo brings it back as it was saved.
  closeMarkup();
  discard([state.selectedId]);
  focusAfterDiscard();
}

/**
 * Discard every item. It sits with the sheet's own actions, away from "Clear
 * collected log", which it used to share a row with, styled alike, 12 px off.
 */
function discardAll() {
  if (!state.items.length) return;
  closeMarkup();
  // What the receipt showed, for an undo to put back. After a blocked
  // clipboard it is the prompt being copied by hand and Clear these items,
  // the one way to clear the sheet that keeps the files that prompt names.
  const receipt =
    el.result.hidden && !state.handCopy
      ? null
      : { handCopy: state.handCopy, prompt: !el.promptPreview.hidden, copy: state.copies };
  discard(state.items.map((item) => item.id));
  if (state.trash) state.trash.receipt = receipt;
  el.result.hidden = true;
  showPrompt(false);
  state.handCopy = null;
  focusAfterDiscard();
}

/**
 * Discard items, with a few seconds to take it back.
 *
 * The items leave the sheet, and every other panel's, at once. Their files are
 * deleted when the undo lapses, as discarding has always meant, only later: a
 * click a few pixels off used to delete every sentence and file there was. A
 * new discard settles the one before it, so Undo always means the last one.
 */
function discard(ids) {
  settleTrash();
  const entries = takeOff(ids);
  if (!entries.length) return;
  const now = Date.now();
  for (const { item } of entries) {
    state.removed.set(item.id, leftAt(item, now));
    // Asked now, while there is time to wait for the answer, so a panel
    // closed before the undo lapses can still delete the file (flushOnClose).
    if (item.path) recordFor(item).then((record) => (item.verified = Boolean(record)));
  }
  persist({ thumbs: true });
  // field: what the discard left in the description, the next item's words,
  // and typed: whether anything has been typed there since. Until then
  // Cmd/Ctrl+Z in the field means this discard (see untouchedSinceDiscard).
  state.trash = { entries, timer: null, field: el.description.value, typed: false, receipt: null };
  showUndo(entries);
  startUndoTimer();
}

function inTrash(item) {
  return Boolean(state.trash?.entries.some((entry) => entry.item === item));
}

/**
 * Whether the pointer is on the undo line, or the keyboard on its button.
 * Either holds the countdown: an Undo that went while it was being reached
 * for, or while focused, gave no way to take longer (WCAG 2.2.1), and took the
 * keyboard user's place with it.
 */
const undoHold = { pointer: false, focus: false };

/** Start the countdown to the last discard's files going, from the top. */
function startUndoTimer() {
  const trash = state.trash;
  if (!trash) return;
  clearTimeout(trash.timer);
  trash.timer = undoHold.pointer || undoHold.focus ? null : setTimeout(settleTrash, UNDO_MS);
}

/**
 * The pointer or the keyboard arrives on the undo line, or leaves it. The
 * countdown stops while either is there, and starts again from the top once
 * both have gone, so leaving it gives the full time again.
 */
function holdUndo(kind, on) {
  undoHold[kind] = on;
  const trash = state.trash;
  if (!trash) return;
  if (undoHold.pointer || undoHold.focus) {
    clearTimeout(trash.timer);
    trash.timer = null;
  } else if (trash.timer == null) {
    startUndoTimer();
  }
}

/**
 * Whether the description still holds what the last discard put there, the
 * next item's words, untouched. Cmd/Ctrl+Z there then means the discard: focus
 * goes to the field after every discard that leaves an item, so the key never
 * reached the discard in the common case, and the field has nothing of its
 * own to undo yet (a value set by script is not on its undo stack). Once
 * anything is typed, the key is the field's.
 */
function untouchedSinceDiscard() {
  const trash = state.trash;
  return Boolean(trash) && !trash.typed && el.description.value === trash.field;
}

/**
 * Take an item out of the last discard: its save failed while it waited
 * there, so it has no file, and an undo would bring it back as SAVING for
 * good, holding Copy back with it.
 */
function dropFromTrash(item) {
  const trash = state.trash;
  if (!trash) return;
  trash.entries = trash.entries.filter((entry) => entry.item !== item);
  if (trash.entries.length) {
    const text = el.undo.querySelector('.undo-text');
    if (text) text.textContent = undoWords(trash.entries);
    return;
  }
  clearTimeout(trash.timer);
  state.trash = null;
  showUndo(null);
}

/** Delete the files of the last discard, now. */
function settleTrash() {
  const trash = state.trash;
  if (!trash) return;
  clearTimeout(trash.timer);
  state.trash = null;
  showUndo(null);
  for (const { item } of trash.entries) {
    // Back on the sheet: another panel changed it after this discard, and a
    // merge keeps the newer word. Its file is in use again.
    if (state.items.some((candidate) => candidate.id === item.id)) continue;
    // Gone for good, so nothing will mark it up.
    releaseFull(item);
    // One still saving has no path yet; addItem deletes it once it has.
    if (item.path) deleteFile(item);
  }
}

/** Put the last discard back where it was. */
function undoDiscard() {
  const trash = state.trash;
  if (!trash) return;
  clearTimeout(trash.timer);
  state.trash = null;
  showUndo(null);
  const restored = [];
  for (const { item, index } of trash.entries) {
    if (state.items.some((candidate) => candidate.id === item.id)) continue;
    touch(item);
    state.removed.delete(item.id);
    state.items.splice(Math.min(index, state.items.length), 0, item);
    restored.push(item);
  }
  // Where its place puts it, which is where it was unless rows were moved
  // since, and where every other panel and the next reopen put it too.
  state.items.sort(bySheetOrder);
  restoreReceipt(trash);
  if (!restored.length) return;
  selectItem(restored.at(-1).id);
  persist({ thumbs: true });
  updateElementCount();
  if (el.banner.hidden) sayMissing();
  el.description.focus({ preventScroll: true });
}

/**
 * Put back the receipt Discard all took down, unless a newer copy has made
 * its own since. A receipt of a copy that reached the clipboard comes back
 * only over the sheet it sat under: a capture since would have taken it down.
 * One of a blocked copy comes back regardless, as a capture leaves it: it is
 * the only copy of a prompt still being copied by hand, and its Clear these
 * items the one way to clear the sheet that keeps the files it names.
 */
function restoreReceipt(trash) {
  const receipt = trash.receipt;
  if (!receipt || state.copies !== receipt.copy) return;
  const discarded = new Set(trash.entries.map((entry) => entry.item.id));
  if (!receipt.handCopy && !state.items.every((item) => discarded.has(item.id))) return;
  state.handCopy = receipt.handCopy;
  el.clearCopied.hidden = !receipt.handCopy;
  el.result.hidden = false;
  showPrompt(receipt.prompt);
}

function undoWords(entries) {
  return entries.length === 1 ? `Item ${entries[0].index + 1} discarded.` : `${entries.length} items discarded.`;
}

/**
 * The line that offers the undo. Its container stays in the layout, empty and
 * collapsed when there is nothing to undo, because it is a live region, and a
 * region that appears with its text already in it is not reliably announced.
 */
function showUndo(entries) {
  // Rebuilt or emptied, the line holds no focused button and, emptied, no
  // area for the pointer to be on. A removed button need not send focusout,
  // and the pointer sends no mouseleave until it moves, so the hold is reset
  // here rather than left to the events.
  const hadFocus = el.undo.contains(document.activeElement);
  undoHold.focus = false;
  if (!entries) {
    undoHold.pointer = false;
    el.undo.replaceChildren();
    // The button had the keyboard. Left to the removal, focus fell to the
    // page's body, and the next Tab started from the top of the panel.
    if (hadFocus) focusAfterDiscard();
    return;
  }
  const text = document.createElement('span');
  text.className = 'undo-text';
  text.textContent = undoWords(entries);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ghost-link';
  button.textContent = 'Undo';
  button.addEventListener('click', undoDiscard);
  el.undo.replaceChildren(text, button);
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
 * them would destroy the work. They clear it themselves once they have the
 * text, with "Clear these items", which leaves the files as this does.
 *
 * By id, not by object: a write adopted from another window during the copy
 * used to replace every item object, and the copied items stayed on the sheet.
 */
function resetAfterCopy(copied) {
  const ids = new Set(copied.map((item) => item.id));
  const now = Date.now();
  for (const item of copied) {
    // Its stamps as the sheet holds them now, should a write adopted during
    // the copy have put another object in its place.
    const live = state.items.find((each) => each.id === item.id) || item;
    state.removed.set(item.id, leftAt(live, now));
  }
  // Their clean captures and marks go: state.lastCopy and state.handCopy
  // keep these objects alive, and nothing marks a copied item up.
  for (const item of [...copied, ...state.items.filter((each) => ids.has(each.id))]) releaseFull(item);
  state.items = state.items.filter((item) => !ids.has(item.id));
  // What was left out of this prompt was left for the next one, so it is
  // ticked for it, as a capture arriving now would be. Not a missing item,
  // which is usually unticked so the rest could go.
  for (const item of state.items) {
    if (item.included || item.missing) continue;
    item.included = true;
    touch(item);
  }
  state.handCopy = null;
  el.clearCopied.hidden = true;
  // The newest capture left, wherever it stands on the sheet. Unless an item
  // left out of the copy is being marked up: the frame stays on it.
  const marking = state.markup && state.items.find((item) => item.id === state.markup.item.id);
  selectItem(marking ? marking.id : (newestItem()?.id ?? null));
  persist({ thumbs: true });
  updateSubmitState();
  // A missing file reported while the clipboard was written raised a banner
  // about an item that has now left the sheet. Recounted, as a discard does:
  // it stays only for a ticked item still here.
  if (state.bannerScope === 'missing') {
    showBanner(null);
    sayMissing();
  }
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

/** The port to the worker that holds an arm while this panel is open; see holdArm. */
let holdPort = null;
/** Whether the port just reopened was reopened for one shut straight after it opened. */
let holdRetried = false;
/** A reopen put off because the port kept being shut as it opened; see holdArm. */
let holdRetryTimer = 0;
/** How long the next such reopen waits. */
let holdRetryMs = 0;
const HOLD_RETRY_FIRST_MS = 100;
const HOLD_RETRY_MAX_MS = 2000;

/**
 * Tell the worker, over a port, which tab this panel has armed, so that
 * closing the panel disarms it. Only the panel takes the screenshot: with the
 * panel gone, a drag ended the overlay exactly as a capture does and left
 * nothing behind, and nothing said so. A panel that closes cannot send a
 * message on its way out, but its port closes with it, and the worker hears
 * that.
 *
 * Called on every change of the armed state. The port is opened on the first
 * arm and kept; with nothing armed it says so (null) and stays quiet. Chrome
 * stops an idle worker port or no port, which closes the port from that end;
 * a panel still armed then opens a new one, which starts the worker again,
 * and one with nothing armed waits for its next arm, so an idle panel does not
 * keep the worker awake.
 */
function holdArm() {
  const tabId = state.armedMode ? state.armedTabId : null;
  if (tabId == null && !holdPort) return;
  if (!holdPort) {
    let port;
    try {
      port = chrome.runtime.connect({ name: 'cdr:panel' });
    } catch {
      return; // no worker to hold it (the extension is being reloaded)
    }
    holdPort = port;
    const openedAt = Date.now();
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (holdPort !== port) return;
      holdPort = null;
      // A port that lived is reopened at once. One shut straight after it
      // opened is too, the first time, because a worker stopped just then
      // looks the same (in Chrome, an arm then a stop within the second left
      // the tab armed with nothing holding it). A second in a row may be a
      // worker that shuts it, where reopening at once would loop, or a worker
      // stopped twice within the second, where not reopening left the tab
      // armed with nothing holding it, and closing the panel then left the
      // overlay up. So it is reopened after a pause, which doubles each time
      // up to a bound: neither a loop nor giving up while the arm stands.
      const quick = Date.now() - openedAt < 1000;
      if (!state.armedMode) return;
      if (quick && holdRetried) {
        holdRetryMs = Math.min(HOLD_RETRY_MAX_MS, holdRetryMs ? holdRetryMs * 2 : HOLD_RETRY_FIRST_MS);
        clearTimeout(holdRetryTimer);
        holdRetryTimer = setTimeout(() => {
          holdRetryTimer = 0;
          if (!holdPort && state.armedMode) holdArm();
        }, holdRetryMs);
        return;
      }
      holdRetried = quick;
      if (!quick) holdRetryMs = 0;
      holdArm();
    });
  }
  try {
    holdPort.postMessage({ type: 'cdr:holding', tabId });
  } catch {
    holdPort = null;
  }
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
  const tabId = state.tab.id;
  setArmed(mode, tabId, armId);

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'cdr:arm',
      mode,
      tabId,
      armId,
    });
    // Only if the button still shows this arm: one that a later click has
    // replaced, or that was cancelled, must not turn off what came after it.
    if (!response?.ok && state.armedId === armId) {
      setArmed(null);
      showBanner(response?.error || 'Could not start capture on this tab.', 'error', 'page');
    }
  } catch (error) {
    // sendMessage rejects outright if the worker is torn down mid-request, for
    // instance when the extension is reloaded. Without this the button would
    // stay lit over a page with no overlay, and the next click would read as a
    // cancel rather than arming.
    //
    // But the injection may have gone out before the worker went: on a page
    // still loading it waits for document_idle, and lands after the button
    // has gone dark, an overlay nothing in the panel can cancel. So the arm
    // is cancelled as well, through a worker started afresh by the message.
    // That worker knows nothing of the arm, and its disarm puts a stop in the
    // page's queue behind it all the same.
    if (state.armedId === armId) {
      state.cancelledArmIds.add(armId);
      setArmed(null);
      sendDisarm(tabId);
      showBanner(error?.message || 'Could not start capture on this tab.', 'error', 'page');
    }
  }
}

const OVERLAY_TOO_BUSY =
  'The page was too busy to take the capture overlay down in time, so it may show in this screenshot.';

/**
 * Said when a capture mode was armed on the same tab while Screen was under
 * way: Region or Element clicked, or Alt+Shift+C pressed. That arm is the
 * user's newer action and stays armed, so its overlay may be drawn on the page
 * being photographed. Screen photographs it all the same, because the page as
 * it was is often the point, and says so, because the notice covers the
 * overlay that may be in it.
 */
const ARMED_DURING_SCREEN =
  'A capture mode was armed while this screenshot waited, so its overlay may show in it.';

/**
 * Clear the tab in view for a screenshot of it, which Screen and Page both
 * take. An armed overlay is drawn on the page itself. Photographing it would
 * bake the dim layer and the hint into the image and leave the overlay live,
 * so it is cancelled first and the capture waits for the page to repaint.
 *
 * Says what the capture should carry: OVERLAY_TOO_BUSY when the wait ran
 * out, and whether a mode was armed on the tab while it waited.
 *
 * @returns {Promise<{ notice: string|null, armedSince: boolean }>}
 */
async function clearForShot() {
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
  // A mode armed on this tab while the capture waited: Region or Element
  // clicked, or the shortcut, which the worker reports before this panel has
  // heard of it.
  return { notice, armedSince: Boolean(reply?.superseded) || armedHere() };
}

async function captureVisible() {
  // One capture in flight at a time. This covers the capture itself, which
  // can take a while on a busy page; the second click of a double click is
  // turned away where the click is handled.
  if (state.restriction || state.capturing) return;
  state.capturing = true;
  // Mark up waits while a capture is under way.
  updateMarkUp();
  try {
    showBanner(null);
    // A mode armed while Screen waited is photographed with a notice; see
    // ARMED_DURING_SCREEN.
    let { notice, armedSince } = await clearForShot();
    const { dataUrl, takenAt } = await captureViewport();
    // Asked again once the pixels are in. captureViewport waits out Chrome's
    // capture quota, up to 1.2 s, and a mode armed during that wait may be in
    // them too.
    armedSince ||= armedHere();
    if (armedSince) notice = ARMED_DURING_SCREEN;
    const image = await loadImage(dataUrl);
    addItem({
      dataUrl,
      width: image.naturalWidth,
      height: image.naturalHeight,
      mode: 'visible',
      notice,
      takenAt,
    });
  } catch (error) {
    showBanner(error?.message || 'Screenshot failed.', 'error');
  } finally {
    state.capturing = false;
    updateMarkUp();
  }
}

// ------------------------------------------------------------ whole page --

const PAGE_PROGRESS = 'Capturing the whole page by scrolling it. Press Esc or Stop to cancel.';
const PAGE_COMPOSING = 'Putting the page together.';
const PAGE_ARMED_FIRST = 'A capture mode was armed, so the page capture did not start.';
const PAGE_ZOOMED = 'Zoom back out to capture the whole page: a pinch zoomed page cannot be scrolled through.';
const PAGE_REFUSED = 'This page could not be scrolled through for a whole page capture.';
const PAGE_TOO_LARGE = 'The whole page was too large to put together, so nothing was filed.';
const PAGE_GREW =
  'The page changed height or moved while it was captured, so a seam in this screenshot may not line up.';
const PAGE_ONE_SCREEN = 'Nothing on this page scrolls, so this is the visible screen.';
const PAGE_LOCKED = 'The page has locked its scrolling, as an open dialog or menu does, so this is the visible screen.';
const PAGE_INNER =
  'The page scrolls inside one area, so only that area is shown in full, and what is beside it is from the first screen.';
const PAGE_CANCELLED = 'Page capture cancelled. Nothing was filed.';

/**
 * Why a page shot stopped before its end, by the reason stopPageShot was
 * given or the page reported, and said in the banner. 'user' (Stop or Esc)
 * is the user's own doing and only announced (PAGE_CANCELLED). None files
 * anything.
 */
const PAGE_STOPPED = {
  input: 'You scrolled, pressed a key or clicked on the page, so the page capture stopped. Nothing was filed.',
  tab: 'The tab changed, so the page capture stopped. Nothing was filed.',
  resized: 'The tab changed size, so the page capture stopped. Nothing was filed.',
  armed: 'A capture mode was armed, so the page capture stopped. Nothing was filed.',
  left: 'The tab left or reloaded the page, so the page capture stopped. Nothing was filed.',
  gone: 'The page went away or stopped answering, so the page capture stopped. Nothing was filed.',
};

/**
 * PAGE_STOPPED's reason for a step that answered without going on: the user
 * touched the page; the page was left, which its controller saw (pagehide)
 * or which a new document without one shows; or it stopped for itself (its
 * lease ran out, a step threw).
 */
function pageStopReason(reply) {
  if (reply?.stopped === 'user') return 'input';
  if (reply?.stopped === 'pagehide' || reply?.missing) return 'left';
  return 'gone';
}

/**
 * What a page item cut short says: that the page went on past what a capture
 * covers (PAGE_MAX_HEIGHT, PAGE_MAX_AREA or PAGE_MAX_SCREENS), or, when it
 * stopped scrolling before its end, that it did.
 */
function pageCutNotice(cssHeight, stuck) {
  const why = stuck ? 'The page would not scroll any further' : 'The page is longer than a whole page capture covers';
  return `${why}, so this shows its first ${cssHeight} CSS pixels.`;
}

/**
 * Call the page shot controller in the tab's isolated world (see
 * content/page-shot.js), as handKeyToPage calls into the overlay. Chrome
 * serialises the function and its arguments, and awaits what it returns. A
 * document without the controller, one loaded since the file was injected,
 * answers { missing: true }.
 */
async function callPage(tabId, name, args = []) {
  const [injected] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (method, params) => {
      const shot = window.__cdrPageShot;
      return shot ? shot[method](...params) : { missing: true };
    },
    args: [name, args],
  });
  return injected?.result;
}

/**
 * The Page button while a page shot runs: lit like an armed mode, so the
 * frame's marching ants run too, labelled Stop, with a count of the screens
 * taken in place of its icon (panel.css hides the icon). The count is drawn,
 * not announced: the banner said once what is going on, and a screen reader
 * is not interrupted every half second.
 */
function renderPageButton() {
  const shot = state.pageShot;
  const running = Boolean(shot);
  el.modePage.classList.toggle('armed', running);
  el.modePage.setAttribute('aria-pressed', String(running));
  if (running) el.modePage.setAttribute('aria-label', 'Stop the page capture');
  else el.modePage.removeAttribute('aria-label');
  el.modePageLabel.textContent = running ? 'Stop' : 'Page';
  el.modePageCount.textContent = running ? `${shot.screens}/${Math.max(shot.expected, shot.screens)}` : '';
  el.modePageCount.hidden = !running;
}

/**
 * End the page shot in progress, for `reason` (a key of PAGE_STOPPED, or
 * 'user' for Stop and Esc). The page is told at once, without waiting for a
 * step still in flight, and capturePage files nothing and says why once its
 * loop sees it. The lease in the page is the backstop for a call that never
 * arrives.
 */
function stopPageShot(reason) {
  const shot = state.pageShot;
  if (!shot || shot.cancelled) return;
  // Once every screenshot is in and the page is back, only the user's own
  // Stop or Esc throws the result away: a tab switch or an arm then has
  // nothing left to spoil.
  if (shot.composing && reason !== 'user') return;
  shot.cancelled = true;
  shot.reason = reason;
  shot.stop();
  callPage(shot.tabId, 'end').catch(() => {});
}

/**
 * What `call` (a call into the page, or a screenshot) comes to, or null as
 * soon as the run is stopped: the loop never waits on a call in flight once
 * stopPageShot has told the page to end. A call into the page that has not
 * answered in PAGE_CALL_MS stops the run as gone, rather than leave Page
 * reading Stop for a page that never answers.
 */
async function untilStopped(shot, call, { bounded = true } = {}) {
  try {
    return await Promise.race([bounded ? withTimeout(call, PAGE_CALL_MS) : call, shot.stopped]);
  } catch (error) {
    if (error !== TIMED_OUT) throw error;
    stopPageShot('gone');
    return null;
  }
}

/**
 * Say why a page shot stopped, once its loop has given the page back. A
 * second cancel finds the status region holding the line already, hence
 * announceAnew.
 */
function sayPageStopped(shot) {
  if (shot.reason === 'user' || !PAGE_STOPPED[shot.reason]) {
    showBanner(null);
    announceAnew(PAGE_CANCELLED);
    return;
  }
  showBanner(PAGE_STOPPED[shot.reason]);
}

/**
 * Where each screenshot of a whole page goes in the stitched image. Pure, so
 * the arithmetic is tested on its own (test/capture.test.mjs).
 *
 * Each frame is placed by the scroll offset the page actually reached, which
 * the page reports for each step, not the one asked for: the last screen is
 * clamped to the end of the page, overlaps the one before it, and is drawn
 * over it. Everything here is in device pixels, `base` of them to a CSS
 * pixel, read off the screenshot's width as cropCapture does, so browser
 * zoom and a device pixel ratio that is not a whole number come out right.
 * Each frame is drawn ceil(height × base) rows tall (as many as the
 * screenshot has) at round(top × base), and the page steps one CSS pixel
 * short of a screen (content/page-shot.js), so no row is left between two
 * frames however the rounding falls. The image ends at the lowest row drawn.
 *
 * The document's scrollbar is cut away by drawing only its client width.
 * For an inner scroller, the first frame is drawn whole, then its strip
 * below the scroller, moved down by how much further the scroller reached,
 * then each frame's scroller rect at its own offset. Beside the scroller,
 * below the first screen, no frame has anything, and `fill` says to paint
 * the page's background there.
 *
 * The image is at most maxHeight rows tall and maxArea pixels in all. A page
 * longer than that is cut there, at full resolution, and `cut` says so, as
 * it does when the frames stopped before the end of the page.
 *
 * @param {{ scroller: 'document'|'inner', rect: { x: number, y: number, width: number, height: number },
 *   client: { width: number, height: number }, frames: Array<{ top: number }>,
 *   frame: { width: number, height: number }, base: number, scrollHeight: number,
 *   maxHeight: number, maxArea: number }} input
 *   rect is the part of the view the scroller shows and client the
 *   document's client size, both in CSS pixels, as begin() reported them;
 *   frame is the size of every screenshot; scrollHeight is the scroller's at
 *   the last step.
 * @returns {{ width: number, height: number, fill: boolean, cut: boolean, cssWidth: number, cssHeight: number,
 *   draws: Array<{ frame: number, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number }> }}
 *   draws in order, each frame's together and the frames in turn.
 */
function pagePlan({ scroller, rect, client, frames, frame, base, scrollHeight, maxHeight, maxArea }) {
  const inner = scroller === 'inner';
  const width = Math.min(frame.width, Math.round(client.width * base));
  const limit = Math.max(1, Math.min(maxHeight, Math.floor(maxArea / Math.max(1, width))));
  const reached = frames[frames.length - 1].top + rect.height;
  const extra = inner ? Math.max(0, reached - rect.height) : 0;
  const box = {
    x: Math.round(rect.x * base),
    y: Math.round(rect.y * base),
    width: Math.ceil(rect.width * base),
    height: Math.ceil(rect.height * base),
  };
  const placed = [];
  const add = (index, sx, sy, sw, sh, dx, dy) => {
    const w = Math.min(sw, frame.width - sx, width - dx);
    const h = Math.min(sh, frame.height - sy);
    if (w > 0 && h > 0) placed.push({ frame: index, sx, sy, sw: w, sh: h, dx, dy });
  };
  frames.forEach((shot, index) => {
    if (!inner) {
      add(index, 0, 0, width, box.height, 0, Math.round(shot.top * base));
      return;
    }
    if (index === 0) {
      const below = Math.round((rect.y + rect.height) * base);
      add(0, 0, 0, width, below, 0, 0);
      add(0, 0, below, width, Math.round(client.height * base) - below, 0, Math.round((rect.y + rect.height + extra) * base));
    }
    add(index, box.x, box.y, box.width, box.height, box.x, Math.round((rect.y + shot.top) * base));
  });
  // As tall as the lowest row drawn, which no rounding can leave empty, and
  // then held to the limit.
  const full = Math.max(1, ...placed.map((draw) => draw.dy + draw.sh));
  const height = Math.min(full, limit);
  const draws = placed
    .map((draw) => ({ ...draw, sh: Math.min(draw.sh, height - draw.dy) }))
    .filter((draw) => draw.sh > 0);
  return {
    width,
    height,
    draws,
    fill: inner,
    cut: reached < scrollHeight - 1 || full > limit,
    cssWidth: Math.round(client.width),
    cssHeight: Math.round(height / base),
  };
}

/** The size of a screenshot, decoded once and let go. */
async function bitmapSize(blob) {
  const bitmap = await createImageBitmap(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

/**
 * Scroll the tab through and take a screenshot of each screen, then give the
 * page back. Null when it did not start or stopped before the end, having
 * said why; otherwise what composePage needs, and whether the page moved
 * under it or stopped scrolling before its end, for the notices.
 *
 * Chrome takes at most two screenshots a second per extension, so each
 * waits until PAGE_PACE_MS have passed since the one before, while the page
 * scrolls and paints in that time. captureViewport's quota retry stays, for
 * another window's panel capturing at the same moment. Each screenshot is
 * kept as a PNG Blob until all are in; they are decoded one at a time later.
 *
 * end() is called in finally, whatever happened, and the run stops on its
 * own: when the page reports it was stopped (the user touched it, it went
 * away, the lease ran out), by a step or by what end() answers, when the tab
 * changed size, when the page would not scroll further, at the end of the
 * page, and at PAGE_MAX_HEIGHT.
 */
async function scrollAndShoot(shot) {
  const { tabId } = shot;
  const notices = [];
  const { notice, armedSince } = await clearForShot();
  // Unlike Screen, which photographs what is there, Page would scroll the
  // page out from under the overlay the user just armed.
  if (armedSince) {
    showBanner(PAGE_ARMED_FIRST);
    return null;
  }
  if (notice) notices.push(notice);
  if (shot.cancelled) {
    sayPageStopped(shot);
    return null;
  }
  showBanner(PAGE_PROGRESS);

  let injected = false;
  let begun = null;
  let ended = null; // what end() answered, or null when it did not
  let last = null;
  let moved = false;
  let stuck = false; // the page stopped scrolling before its end
  let size = null;
  let limit = Infinity; // how far down the frames may reach, in CSS pixels
  const frames = [];
  try {
    // Counted as injected from the moment it is asked for: a call that
    // timed out may still land, and end() on a page with no run does nothing.
    injected = true;
    await untilStopped(shot, chrome.scripting.executeScript({ target: { tabId }, files: [PAGE_SCRIPT] }));
    // A stop from here on is said below, once the page has had its end().
    if (!shot.cancelled) begun = await untilStopped(shot, callPage(tabId, 'begin'));
    if (!shot.cancelled && !begun?.ok) throw new Error(begun?.reason === 'zoom' ? PAGE_ZOOMED : PAGE_REFUSED);
    shot.expected = begun?.screens || 1;
    renderPageButton();
    let gate = null;
    for (let index = 0; index < PAGE_MAX_SCREENS && !shot.cancelled; index += 1) {
      const reply = await untilStopped(shot, callPage(tabId, 'step', [index]));
      if (shot.cancelled) break;
      if (!reply?.active) {
        stopPageShot(pageStopReason(reply));
        break;
      }
      // A window resized, the panel opened beside the tab, or a browser
      // zoom: the frames would not line up.
      if (reply.viewport.width !== begun.viewport.width || reply.viewport.height !== begun.viewport.height) {
        stopPageShot('resized');
        break;
      }
      // The page moved or changed height since the last screenshot: while it
      // was taken, or during this step, as when a script takes a header out
      // of the flow once the page is scrolled and what is below moves up.
      if (
        last &&
        (reply.before.top !== last.top ||
          reply.before.scrollHeight !== last.scrollHeight ||
          reply.scrollHeight !== last.scrollHeight)
      ) {
        moved = true;
      }
      await gate;
      if (shot.cancelled) break;
      // Not bounded: captureViewport has its own end, its quota retries.
      const taken = await untilStopped(shot, captureViewport(), { bounded: false });
      if (shot.cancelled) break;
      const { dataUrl, takenAt } = taken;
      gate = new Promise((resolve) => setTimeout(resolve, PAGE_PACE_MS));
      // captureVisibleTab photographs whatever tab is in view by then.
      const [inView] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (shot.cancelled) break;
      if (inView?.id !== tabId) {
        stopPageShot('tab');
        break;
      }
      const blob = await blobOf(dataUrl);
      if (!size) {
        size = await bitmapSize(blob);
        const base = size.width / begun.viewport.width;
        // The tab's height and the screenshot's disagree, as cropCapture
        // checks: an infobar or the panel came or went since begin().
        if (Math.abs(size.height / begun.viewport.height - base) > base * 0.03) {
          stopPageShot('resized');
          break;
        }
        const width = Math.min(size.width, Math.round(begun.client.width * base));
        limit = Math.min(PAGE_MAX_HEIGHT, Math.floor(PAGE_MAX_AREA / Math.max(1, width))) / base;
      }
      frames.push({ blob, top: reply.top, takenAt });
      last = reply;
      shot.screens = frames.length;
      // The count's estimate, which grows with the page: a screen, then a
      // step (a CSS pixel short of one) for each further screen it reaches.
      const span = Math.min(reply.scrollHeight, limit - begun.rect.y) - begun.rect.height;
      shot.expected = Math.max(
        frames.length + (reply.atEnd ? 0 : 1),
        1 + Math.ceil(Math.max(0, span) / Math.max(1, begun.rect.height - 1))
      );
      renderPageButton();
      if (reply.atEnd) break;
      // A page that would not scroll further, though it says there is more.
      if (frames.length > 1 && reply.top <= frames[frames.length - 2].top) {
        stuck = true;
        break;
      }
      if (begun.rect.y + reply.top + begun.rect.height >= limit) break;
    }
  } finally {
    // The page is put back whatever happened: the end, a stop, a screenshot
    // that failed, a throw. Sent again after a stop, whose end() may have
    // reached the page before a call still in flight. Awaited, so the page is
    // back before the frames are composed, but bounded like every call.
    if (injected) ended = await withTimeout(callPage(tabId, 'end'), PAGE_CALL_MS).catch(() => null);
  }
  // A run the page ended by itself after the last step answered: the user
  // scrolled or clicked as the page reached its end, the tab left the page,
  // or the lease ran out. The next step would have said so for any other
  // screenshot, but this one may show the page already put back, drawn at
  // the bottom of the image, so it is filed no more than any other stop.
  if (!shot.cancelled && (ended?.missing || ended?.stopped)) {
    shot.cancelled = true;
    shot.reason = pageStopReason(ended);
  }
  if (shot.cancelled) {
    sayPageStopped(shot);
    return null;
  }
  return { begun, frames, last, moved, size, stuck, notices };
}

/**
 * Put the screenshots of a page together into one PNG and its thumbnail.
 * Each is decoded only for its own draws and let go, so at most one is held
 * beside the canvas, which itself goes as soon as the PNG and the thumbnail
 * are made from it. A screenshot of another size than the first (the tab
 * moved to another display) stops it.
 */
async function composePage({ begun, frames, last, size }) {
  const base = size.width / begun.viewport.width;
  const plan = pagePlan({
    scroller: begun.scroller,
    rect: begun.rect,
    client: begun.client,
    frames,
    frame: size,
    base,
    scrollHeight: last.scrollHeight,
    maxHeight: PAGE_MAX_HEIGHT,
    maxArea: PAGE_MAX_AREA,
  });
  const canvas = document.createElement('canvas');
  canvas.width = plan.width;
  canvas.height = plan.height;
  try {
    const context = canvas.getContext('2d');
    if (plan.fill) {
      context.fillStyle = begun.background || '#ffffff';
      context.fillRect(0, 0, plan.width, plan.height);
    }
    for (let index = 0; index < frames.length; index += 1) {
      const draws = plan.draws.filter((draw) => draw.frame === index);
      if (draws.length) {
        const bitmap = await createImageBitmap(frames[index].blob);
        try {
          if (bitmap.width !== size.width || bitmap.height !== size.height) throw new Error(PAGE_STOPPED.resized);
          for (const draw of draws) {
            context.drawImage(bitmap, draw.sx, draw.sy, draw.sw, draw.sh, draw.dx, draw.dy, draw.sw, draw.sh);
          }
        } finally {
          bitmap.close();
        }
      }
      frames[index].blob = null;
    }
    // Past Chrome's canvas limits toBlob hands over null rather than throw.
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error(PAGE_TOO_LARGE);
    const thumb = await makeThumb(canvas, thumbMaxHeight('page'));
    return { blob, thumb, plan };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * Page: the whole page, scrolled through and put together into one item,
 * mode 'page'. A second press, while it runs, is Stop. It cancels an armed
 * overlay and waits for the page as Screen does, and files nothing if it is
 * stopped. The item's time is its last screenshot's, so what the scrolling
 * made the page log sorts to it.
 */
async function capturePage() {
  if (state.pageShot) {
    stopPageShot('user');
    return;
  }
  // An incognito tab is a restriction too (resolveTab).
  if (state.restriction || state.capturing || state.markup || !state.tab) return;
  // The tab as it was when Page was pressed, which the item is filed under:
  // the page may change its address as it scrolls, and the tab in view may
  // change while the screenshots are put together.
  const { id, url, title, incognito } = state.tab;
  const shot = {
    tabId: id,
    tab: { id, url, title, incognito },
    cancelled: false,
    reason: null,
    screens: 0,
    expected: 1,
    composing: false,
  };
  // Settles with null when the shot is stopped, for untilStopped to race.
  shot.stopped = new Promise((resolve) => {
    shot.stop = () => resolve(null);
  });
  state.capturing = true;
  state.pageShot = shot;
  renderPageButton();
  applyModesDisabled();
  updateMarkUp();
  try {
    showBanner(null);
    const taken = await scrollAndShoot(shot);
    if (!taken) return;
    shot.composing = true;
    showBanner(PAGE_COMPOSING);
    const { blob, thumb, plan } = await composePage(taken);
    if (shot.cancelled) {
      sayPageStopped(shot);
      return;
    }
    const { begun, frames } = taken;
    const notices = [...taken.notices];
    if (begun.locked) notices.push(PAGE_LOCKED);
    else if (frames.length === 1 && !plan.cut) notices.push(PAGE_ONE_SCREEN);
    if (begun.scroller === 'inner') notices.push(PAGE_INNER);
    if (plan.cut) notices.push(pageCutNotice(plan.cssHeight, taken.stuck));
    if (taken.moved) notices.push(PAGE_GREW);
    showBanner(null);
    addItem({
      mode: 'page',
      blob,
      thumb,
      width: plan.width,
      height: plan.height,
      stitched: {
        screens: frames.length,
        cssWidth: plan.cssWidth,
        cssHeight: plan.cssHeight,
        ...(plan.cut ? { cut: true } : {}),
      },
      notice: notices.join(' ') || null,
      takenAt: frames[frames.length - 1].takenAt,
      tab: shot.tab,
    });
  } catch (error) {
    showBanner(error?.message || 'The page capture failed.', 'error');
  } finally {
    state.capturing = false;
    state.pageShot = null;
    renderPageButton();
    applyModesDisabled();
    updateMarkUp();
  }
}

// --------------------------------------------------------------- context --

/**
 * Read the page facts and the collected log from the tab in view, for the
 * chips and for a copy.
 *
 * Resolves to { context, error }: the bridge's reply or null, and why there is
 * none. 'timeout' means the page did not answer in time, which is a long task
 * or a breakpoint, or a collector still being started there; 'missing' means
 * nothing was collecting there. `unread` says nothing was asked at all: no
 * tab, or one Chrome keeps extensions out of.
 *
 * Bounded, because the reply has to come from the page's own thread. Unbounded,
 * Copy sat on "Copying…" for as long as the page stayed busy, and forever while
 * it was paused in the debugger.
 *
 * A tab where nothing collects gets a collector, and is read again; see
 * startCollector. The result says `lateStart` while the log is one that a
 * collector started on a page already open, which holds nothing from before.
 */
async function refreshContext() {
  const tab = state.tab;
  // Reads overlap (a capture, a tab event and the pointer coming back can all
  // start one), and a busy page answers them in no particular order.
  const read = ++state.reads;
  if (!tab || state.restriction) {
    state.countsRead = read;
    unwatchCounts();
    setCount(el.countConsole, null);
    setCount(el.countNetwork, null);
    // Nothing from an earlier read is handed on. It came from another tab, and
    // a copy made here would otherwise attach that tab's log.
    return { context: null, error: 'missing', unread: true };
  }

  let { context, error } = await readContext(tab.id);
  if (error === 'missing') {
    const started = await startCollector(tab);
    if (started === 'timeout') error = 'timeout';
    else if (started) ({ context, error } = await readContext(tab.id));
  }

  // The collector says whether it started after the page had begun to run.
  // Asked of it, not remembered here: this panel can be closed and opened
  // again, and the extension reloaded or updated, while the same collector
  // runs on in the page, and a reload of the page brings one that started
  // with it.
  const lateStart = !error && context?.collected?.late === true;

  // The user can change tabs while this is in flight. The reply then describes
  // the tab they left, so it goes back to whoever asked and not into the chips
  // for the tab now in view. Nor over what a newer read already showed.
  if (state.tab?.id === tab.id && read > state.countsRead) {
    state.countsRead = read;
    reloadAdvice ??= el.collectorWarning.textContent;
    const collected = context?.collected || {};
    const outside = collectorOutside.get(tab.id);
    el.collectorWarning.textContent = lateStart
      ? collectingSince(collected.armedAt)
      : outside?.url === (tab.url || '')
        ? outside.path
          ? OUTSIDE_PATH
          : OUTSIDE_MATCHES
        : reloadAdvice;
    el.collectorWarning.hidden = error !== 'missing' && !lateStart;
    if (!countsFollowed(tab.id)) {
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
  }
  // A collector answered: from here its counts come to the chips as they change.
  if (context && !error && state.tab?.id === tab.id && !state.restriction) watchCounts(tab.id);

  updateElementCount();
  return { context, error, tabId: tab.id, lateStart };
}

/** One bounded read of the tab's log, and why there is none. */
async function readContext(tabId) {
  try {
    const context = await withTimeout(
      chrome.tabs.sendMessage(tabId, { type: 'cdr:get-context' }),
      CONTEXT_TIMEOUT_MS
    );
    // The bridge answered for a page whose own half never armed.
    return { context, error: context?.collected?.unavailable ? 'missing' : null };
  } catch (failure) {
    // Either no content script in this tab, because it was loaded before the
    // extension was installed, enabled or reloaded (see startCollector); or a
    // page too busy to answer, where a reload would destroy the state being
    // reported.
    return { context: null, error: failure === TIMED_OUT ? 'timeout' : 'missing' };
  }
}

const COLLECTING_FROM_NOW =
  'Collecting from now. This tab was open before the extension could start here, so nothing it logged earlier is in the log.';

/**
 * The late start footnote. "From now" is true only just after the start: the
 * same collector answers a panel opened again later, or after the extension
 * reloads, and then the time it started is what the user needs.
 *
 * On a 24 hour clock in Latin digits, as the prompt prints it, and with the
 * date, year first as the prompt has it, once the start was on another day.
 * toLocaleTimeString gave "09:05 PM" in one locale, native digits in
 * another, and in a 24 hour one "21:05" read the next morning as a time
 * still to come today. Long lived tabs make that common.
 */
function collectingSince(startedAt) {
  if (!Number.isFinite(startedAt) || Date.now() - startedAt < RECENT_START_MS) return COLLECTING_FROM_NOW;
  const start = new Date(startedAt);
  // Past the range a Date can hold, which only a forged snapshot reaches.
  if (Number.isNaN(start.getTime())) return COLLECTING_FROM_NOW;
  const pad = (n) => String(n).padStart(2, '0');
  const day = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
  const when = day(start) === day(new Date(Date.now())) ? time : `${time} on ${day(start)}`;
  return `Collecting since ${when}. This tab was open before the extension could start here, so nothing it logged before then is in the log.`;
}

/** How long after a late start the footnote still says "from now". */
const RECENT_START_MS = 10_000;

const OUTSIDE_MATCHES =
  'No log on this tab. The collector is set to run only on other sites (the content_scripts entries in manifest.json).';
/** The same, where the matches name this site and leave out its path. */
const OUTSIDE_PATH =
  'No log on this tab. The collector is set to run only on other pages of this site (the content_scripts entries in manifest.json).';

/** The footnote's own words, which tell the user to reload; read from the page once. */
let reloadAdvice = null;

/** The url of each tab where starting a collector failed, so it is not tried on every read. */
const collectorRefused = new Map();

/**
 * The url of each tab the manifest's matches leave out, where a reload would
 * not help, and whether they leave out only its path.
 */
const collectorOutside = new Map();

/**
 * Start the collector on a tab where nothing answered, instead of telling the
 * user to reload: a reload throws away the very state they opened the panel
 * to report. Chrome injects the declared content scripts only into pages
 * loaded after the extension was installed, enabled or reloaded, so any tab
 * open from before has none, or has a bridge that can no longer hear the
 * extension.
 *
 * What it misses is said, not hidden: the log starts now, and a request made
 * through a reference the page took to fetch earlier is not seen. The
 * collector itself says so, in every snapshot (see refreshContext). After a
 * reload of the extension the old collector is usually still in the page with
 * everything since it loaded, and the worker only adds a bridge to reach it.
 *
 * Once per page per tab: a page that refuses it (a PDF, an error page) is not
 * asked again on every read, and the reload advice stays.
 *
 * Each read waits CONTEXT_TIMEOUT_MS at most, but the ask goes on: the worker
 * is still injecting into a busy page or out of a cold start, so a slow
 * answer is no refusal. That read says the page did not answer in time, as a
 * slow read of the log does, rather than advising a reload, and the next read
 * waits on the same ask instead of sending another. Its answer counts
 * whenever it comes, and an answer that comes late has the chips read again.
 *
 * @returns {Promise<boolean|'timeout'>} whether there is now something to
 *   read, or 'timeout' while the worker has not answered
 */
function startCollector(tab) {
  // One at a time per tab: a tab switch, a capture and the chips all read
  // the log within a few milliseconds of each other.
  let starting = collectorStarting.get(tab.id);
  if (!starting) {
    starting = askForCollector(tab).finally(() => collectorStarting.delete(tab.id));
    collectorStarting.set(tab.id, starting);
  }
  return withTimeout(starting, CONTEXT_TIMEOUT_MS).catch(() => {
    if (!collectorLate.has(starting)) {
      collectorLate.add(starting);
      // A refusal too, once: the footnote then says why there is no log,
      // where it was hidden as for a page merely slow to answer. That read
      // finds the refusal recorded and does not ask again.
      starting.then(() => {
        if (state.tab?.id === tab.id) refreshContext();
      });
    }
    return 'timeout';
  });
}

/** startCollector calls still waiting on the worker, by tab. */
const collectorStarting = new Map();
/** The asks some read gave up waiting on, which read again once they start. */
const collectorLate = new WeakSet();

async function askForCollector(tab) {
  const url = tab.url || '';
  if (collectorRefused.get(tab.id) === url) return false;
  let reply = null;
  try {
    reply = await chrome.runtime.sendMessage({ type: 'cdr:collect', tabId: tab.id });
  } catch {
    /* the worker failed to answer, with the port closed under it: read as refused */
  }
  if (!reply?.ok) {
    collectorRefused.set(tab.id, url);
    // 'path' when the matches name this site but not this page; 'site', or
    // true from a build before the two were told apart, otherwise.
    if (reply?.outside) collectorOutside.set(tab.id, { url, path: reply.outside === 'path' });
    else collectorOutside.delete(tab.id);
    return false;
  }
  collectorRefused.delete(tab.id);
  collectorOutside.delete(tab.id);
  return true;
}

/**
 * The element chip counts the sheet, not the page, so it needs no read of the
 * tab, and no element items is a 0. The dash means "could not read", and sent
 * people off to reload a page that was fine.
 */
function updateElementCount() {
  setCount(el.countElement, state.items.filter((item) => item.element).length);
}

/**
 * Read the chips again because the user has come back to the panel: its
 * window took focus, it was shown, or the pointer came into it. The counts are
 * otherwise read on a capture, a copy and a change of tab, and followed
 * between those through the port below where the tab's collector can; this
 * read is what keeps them current where it cannot (a collector of an earlier
 * build still running in the tab). Not on a timer: every read runs in the
 * page and hands it the log.
 */
function refreshChips() {
  if (!state.tab || state.restriction) return;
  if (Date.now() - state.chipsReadAt < CHIPS_MIN_GAP_MS) return;
  state.chipsReadAt = Date.now();
  refreshContext();
}

/**
 * The console and network chips follow the log of the tab in view for as
 * long as the panel is open and shown, through a port to that tab's bridge
 * (cdr:counts in collector-bridge.js), which posts the two counts when they
 * change, at most four times a second, and nothing else. The port is opened
 * once a read of the tab has found its collector, and closed on a change of
 * tab or of page, when the panel is hidden, and by Chrome when the panel
 * closes; with no port open the page does nothing for the chips.
 *
 * { tabId, port, counts }: counts says the port has posted, from when its
 * numbers are the chips'. A read's reply and a port's message travel on two
 * channels, which Chrome does not keep in order between them, so a read that
 * answers after a newer post would put the older counts back, and nothing
 * would correct them until the log changed. The port's own posts arrive in
 * order, and the bridge posts the counts it finds at each read there too
 * (recount in collector-bridge.js), so a read still sets the chips right
 * after a signal of the collector's was lost.
 */
let countsPort = null;
/** The tab whose counts the panel follows once it is shown again. */
let countsWaiting = null;

function watchCounts(tabId) {
  if (countsPort?.tabId === tabId) return;
  unwatchCounts();
  if (document.visibilityState === 'hidden') {
    countsWaiting = tabId;
    return;
  }
  if (typeof chrome.tabs.connect !== 'function') return;
  let port;
  try {
    port = chrome.tabs.connect(tabId, { name: 'cdr:counts', frameId: 0 });
  } catch {
    return; // the tab went away
  }
  const live = { tabId, port, counts: false };
  countsPort = live;
  port.onMessage.addListener((message) => {
    if (countsPort !== live || message?.type !== 'cdr:counts') return;
    const { console: consoleCount, network: networkCount } = message;
    if (!Number.isInteger(consoleCount) || !Number.isInteger(networkCount)) return;
    if (consoleCount < 0 || networkCount < 0) return;
    live.counts = true;
    if (state.tab?.id !== tabId || state.restriction) return;
    setCount(el.countConsole, consoleCount);
    setCount(el.countNetwork, networkCount);
  });
  port.onDisconnect.addListener(() => {
    // "Receiving end does not exist" for a page with no bridge, which a
    // later read that finds one tries again.
    void chrome.runtime.lastError;
    if (countsPort === live) countsPort = null;
  });
}

function unwatchCounts() {
  const live = countsPort;
  countsPort = null;
  countsWaiting = null;
  if (!live) return;
  try {
    live.port.disconnect();
  } catch {
    /* already closed */
  }
}

/**
 * Whether the chips are the port's for this tab. A read's reply then leaves
 * them alone, and the bridge posts what that read found on the port.
 */
function countsFollowed(tabId) {
  return countsPort?.tabId === tabId && countsPort.counts;
}

// ----------------------------------------------------------------- markup --

/*
 * Marking up a capture: arrows and ellipses drawn on an item's screenshot in
 * the frame, saved as a copy that takes the item's file over.
 *
 * Only the panel that took a capture can mark it up, and only while it stays
 * open, because only that panel holds the clean capture (holdFull), in
 * memory and never stored. Each mark is a record of two points (Mark), drawn
 * by drawMarks alone, on the frame's canvas and on the copy that is saved, so
 * what is seen while marking is what is saved. Done saves the copy through
 * saveScreenshot as `<capture time>_<mode>_marked.png` (without `_marked`
 * once every mark is taken back), points the item at it, and only then
 * deletes the file it replaced (swapFile). Every rule about files works on
 * one path and download id per item, and goes on working.
 */

const MARK_TOOLS = { arrow: 'Arrow', ellipse: 'Ellipse' };
const ARROW_STEPS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/** Whether the markup is open on this item. */
function markingUp(item) {
  return Boolean(state.markup && item && state.markup.item.id === item.id);
}

/**
 * Keep an item's clean capture, so it can be marked up while this panel
 * stays open. It is the Blob the save was given, held in memory and never
 * stored. A Blob lives in Chrome's blob store rather than in the page's heap,
 * and Chrome may page a large one out to a temporary file in the profile
 * while it is held (PRIVACY.md says so). Kept for the newest
 * FULL_KEEP_COUNT captures, in about FULL_KEEP_BYTES together, the oldest let
 * go first; and let go when the item is copied, its discard settles, or it
 * leaves the sheet in another window.
 */
function holdFull(item, blob) {
  // Never a whole page, which cannot be marked up (markupBlocked).
  if (!blob || item.mode === 'page') return;
  item.full = blob;
  item.fullReleased = false;
  state.fulls.push(item);
  trimFulls();
}

/** Let an item's clean capture go, and the marks only it could show again. */
function releaseFull(item) {
  if (!item) return;
  item.full = null;
  item.marks = null;
  item.unsaved = null;
  state.fulls = state.fulls.filter((held) => held !== item);
}

/**
 * Keep the clean captures within their bound. Never the one being marked up,
 * which its markup is drawing on, nor the newest, just taken and the likeliest
 * to be marked up next.
 */
function trimFulls() {
  for (const held of state.fulls) {
    if (!state.items.includes(held) && !inTrash(held)) releaseFull(held);
  }
  const bytes = () => state.fulls.reduce((sum, held) => sum + (held.full?.size || 0), 0);
  while (state.fulls.length > FULL_KEEP_COUNT || bytes() > FULL_KEEP_BYTES) {
    const oldest = state.fulls.slice(0, -1).find((held) => !markingUp(held));
    if (!oldest) break;
    releaseFull(oldest);
    oldest.fullReleased = true;
  }
  updateMarkUp();
}

/**
 * Why an item cannot be marked up, or null when it can. The one place that
 * decides it: an item can be marked up while this panel holds its clean
 * capture.
 */
function markupBlocked(item) {
  const number = state.items.indexOf(item) + 1;
  // At PAGE_MAX_HEIGHT a stitched page decodes to about 100 MB, and the
  // markup's canvas needs as much again, so a page is never held for it.
  if (item.mode === 'page') {
    return (
      `Item ${number} cannot be marked up: a whole page screenshot is too large to mark up in the panel. ` +
      'Capture the part you mean with Region to mark it up.'
    );
  }
  if (item.full) return null;
  if (item.fullReleased) {
    return (
      `Item ${number} can no longer be marked up: the panel keeps the full screenshots of its ` +
      `${FULL_KEEP_COUNT} newest captures only, about ${Math.round(FULL_KEEP_BYTES / 2 ** 20)} MB at most. ` +
      'Capture it again to mark it up.'
    );
  }
  return (
    `Item ${number} cannot be marked up: a panel keeps the full screenshot only of the captures it ` +
    'took, and only while it stays open. Capture it again to mark it up.'
  );
}

/**
 * The Mark up button on the frame, for the item in it. Shown once the item
 * has a file to replace, and not while it is being marked up. One that cannot
 * be marked up still takes focus and a press, which says why (aria-disabled,
 * not disabled). It waits while a copy or a capture runs, while a marked copy
 * of the item is being saved, and while a markup opens.
 */
function updateMarkUp() {
  const item = selectedItem();
  el.markUp.hidden = !item || !item.path || markingUp(item);
  if (el.markUp.hidden) return;
  if (markupBlocked(item)) el.markUp.setAttribute('aria-disabled', 'true');
  else el.markUp.removeAttribute('aria-disabled');
  el.markUp.disabled =
    state.busy || state.capturing || Boolean(item.markSave) || Boolean(state.markupOpening);
}

/** A mark's stroke in the image's own pixels: a 200th of its longer side, never under 4. */
function markStroke(width, height) {
  return Math.max(4, Math.round(Math.max(width, height) / 200));
}

/**
 * Draw marks on a 2D context whose units are the image's own pixels, for an
 * image `width` by `height`. The only code that draws a mark: the frame's
 * canvas calls it through a transform to its own scale, and the marked copy
 * at full size, so the two cannot differ.
 *
 * Each mark is drawn twice, a white edge and the magenta over it, so it holds
 * on a dark page and a light one alike, in the one colour the prompt names,
 * whatever the theme.
 */
function drawMarks(ctx, marks, width, height) {
  const stroke = markStroke(width, height);
  const edge = Math.max(1, Math.round(stroke / 4));
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const mark of marks) {
    const [x1, y1, x2, y2] = [mark.x1 * width, mark.y1 * height, mark.x2 * width, mark.y2 * height];
    for (const [color, outline] of [
      [MARK_EDGE, edge * 2],
      [MARK_COLOR, 0],
    ]) {
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = stroke + outline;
      ctx.beginPath();
      if (mark.tool === 'ellipse') {
        ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        drawArrow(ctx, x1, y1, x2, y2, stroke, outline);
      }
    }
  }
}

/**
 * An arrow from its tail to its head: a line, and a filled head about four
 * strokes long, never more than half the arrow. `outline` widens the head by
 * as much as the edge widens the line.
 */
function drawArrow(ctx, x1, y1, x2, y2, stroke, outline) {
  const length = Math.hypot(x2 - x1, y2 - y1);
  if (!length) return;
  const ux = (x2 - x1) / length;
  const uy = (y2 - y1) / length;
  const head = Math.min(stroke * 4, length / 2);
  const half = head * 0.6;
  const baseX = x2 - ux * head;
  const baseY = y2 - uy * head;
  // The line stops where the head begins, which covers its round end.
  ctx.moveTo(x1, y1);
  ctx.lineTo(baseX, baseY);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(baseX - uy * half, baseY + ux * half);
  ctx.lineTo(baseX + uy * half, baseY - ux * half);
  ctx.closePath();
  if (outline) {
    ctx.lineWidth = outline;
    ctx.stroke();
  }
  ctx.fill();
}

/** The keyboard's crosshair at its point, the same size on screen at any scale. */
function drawCursor(ctx, point, width, height, scale) {
  const unit = (window.devicePixelRatio || 1) / scale; // one CSS pixel, in the image's
  const x = point.x * width;
  const y = point.y * height;
  for (const [color, lineWidth] of [
    [MARK_EDGE, 4 * unit],
    [MARK_COLOR, 2 * unit],
  ]) {
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(x - 8 * unit, y);
    ctx.lineTo(x + 8 * unit, y);
    ctx.moveTo(x, y - 8 * unit);
    ctx.lineTo(x, y + 8 * unit);
    ctx.stroke();
  }
}

/** Whether the markup can open on this item now. */
function openable(item) {
  return Boolean(item.full && item.path && !item.markSave && !state.busy && !state.capturing);
}

/**
 * Mark up: open the markup on the item in the frame. Its clean capture is
 * decoded and shown on a canvas in the image's place, as large as the panel
 * allows, and the marking tools take the place of the capture buttons. Marks
 * saved before come back, still editable, over the clean capture, or the
 * marks whose save failed, which wait for the next Done. An item that cannot
 * be marked up says why instead (markupBlocked).
 */
async function openMarkup() {
  const item = selectedItem();
  if (!item || state.markup || state.markupOpening) return;
  const reason = markupBlocked(item);
  if (reason) {
    showBanner(reason, 'warn', 'capture');
    return;
  }
  if (!openable(item)) return;
  state.markupOpening = { item };
  updateMarkUp();
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(item.full);
  } catch {
    /* said below */
  }
  state.markupOpening = null;
  // Anything can have happened while it was decoded: another item came into
  // the frame, a copy or a capture began, or the item left the sheet.
  if (!bitmap || selectedItem() !== item || !openable(item) || state.markup) {
    bitmap?.close?.();
    updateMarkUp();
    if (!bitmap && selectedItem() === item) {
      showBanner(`Item ${state.items.indexOf(item) + 1}'s screenshot could not be opened to mark it up.`, 'error', 'capture');
    }
    return;
  }
  const copy = (marks) => (marks || []).map((mark) => ({ ...mark }));
  state.markup = {
    item,
    bitmap,
    width: item.width || bitmap.width,
    height: item.height || bitmap.height,
    tool: state.markTool,
    saved: copy(item.marks), // as they were last saved, which Cancel keeps
    marks: copy(item.unsaved || item.marks),
    pending: null, // a shape half drawn, by a drag or by the keys
    cursor: null, // the keyboard's crosshair, once an arrow key has shown it
    pointerId: null, // the pointer drawing, while a drag is under way
  };
  showMarking(true);
  showMarkTool();
  sizeMarkup();
  renderMarkup();
  renderFrame();
  refreshRow(item);
  updateSubmitState();
  el.markupCanvas.focus({ preventScroll: true });
}

/**
 * Swap the frame and the row under it between showing the item and marking
 * it up: the canvas in the image's place, and the marking tools in the place
 * of the capture buttons, which are off while hidden, so neither a click nor
 * a key reaches them (applyModesDisabled).
 */
function showMarking(on) {
  el.preview.classList.toggle('marking', on);
  el.markupCanvas.hidden = !on;
  el.marks.hidden = !on;
  el.modes.hidden = on;
  applyModesDisabled();
}

/** Light the tool in use, and say on the canvas what a drag draws. */
function showMarkTool() {
  for (const [name, node] of [
    ['arrow', el.markArrow],
    ['ellipse', el.markEllipse],
  ]) {
    node.classList.toggle('on', name === state.markTool);
    node.setAttribute('aria-pressed', String(name === state.markTool));
  }
  const markup = state.markup;
  if (!markup) return;
  el.markupCanvas.setAttribute(
    'aria-label',
    `Screenshot of item ${state.items.indexOf(markup.item) + 1}. Drag to draw an ${state.markTool}, ` +
      'or use the arrow keys and Enter.'
  );
}

/** Arrow or Ellipse pressed: the tool for the next shape, and for one half drawn. */
function setMarkTool(tool) {
  state.markTool = tool;
  const markup = state.markup;
  if (markup) {
    markup.tool = tool;
    if (markup.pending) {
      markup.pending.tool = tool;
      renderMarkup();
    }
  }
  showMarkTool();
  // Choosing the tool is the step before drawing with it.
  if (markup) el.markupCanvas.focus({ preventScroll: true });
}

/**
 * Size the canvas to show the whole capture as large as the frame's width
 * and 70% of the panel's height allow, small crops scaled up, with as many
 * canvas pixels as the screen has under it. The capture's own pixels are for
 * the saved copy (saveMarks), not for the screen.
 */
function sizeMarkup() {
  const markup = state.markup;
  if (!markup) return;
  const { width, height } = markup;
  const frame = el.preview.getBoundingClientRect();
  const fit = Math.min((frame.width || width) / width, ((window.innerHeight || height) * 0.7) / height);
  const shownWidth = Math.max(1, Math.round(width * fit));
  const shownHeight = Math.max(1, Math.round(height * fit));
  const ratio = window.devicePixelRatio || 1;
  el.markupCanvas.style.width = `${shownWidth}px`;
  el.markupCanvas.style.height = `${shownHeight}px`;
  el.markupCanvas.width = Math.max(1, Math.round(shownWidth * ratio));
  el.markupCanvas.height = Math.max(1, Math.round(shownHeight * ratio));
}

/** Draw the markup on its canvas: the capture, the marks, a shape half drawn, the crosshair. */
function renderMarkup() {
  const markup = state.markup;
  if (!markup) return;
  const canvas = el.markupCanvas;
  const ctx = canvas.getContext('2d');
  const { width, height } = markup;
  const scale = canvas.width / width;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.drawImage(markup.bitmap, 0, 0, width, height);
  drawMarks(ctx, markup.pending ? [...markup.marks, markup.pending] : markup.marks, width, height);
  if (markup.cursor) drawCursor(ctx, markup.cursor, width, height, scale);
}

/** The canvas's size on screen in CSS pixels, or the capture's own where it has none. */
function shownSize() {
  const box = el.markupCanvas.getBoundingClientRect();
  return { width: box.width || state.markup.width, height: box.height || state.markup.height };
}

/** Where a pointer event falls on the capture, as shares of it, held to its edges. */
function markPoint(event) {
  const box = el.markupCanvas.getBoundingClientRect();
  const share = (offset, size) => (size ? Math.min(1, Math.max(0, offset / size)) : 0);
  return { x: share(event.clientX - box.left, box.width), y: share(event.clientY - box.top, box.height) };
}

/** Whether a shape spans MARK_MIN_DRAG_PX on screen, which a stray click does not. */
function longEnough(shape) {
  const shown = shownSize();
  return Math.hypot((shape.x2 - shape.x1) * shown.width, (shape.y2 - shape.y1) * shown.height) >= MARK_MIN_DRAG_PX;
}

/** A shape drawn: kept, and said. */
function addMark(shape) {
  const markup = state.markup;
  markup.marks.push(shape);
  announceAnew(`${MARK_TOOLS[shape.tool]} ${markup.marks.length} drawn.`);
}

/**
 * A press on the canvas starts a shape, and the release ends it: an arrow
 * from the press to the release, its head at the release, or an ellipse that
 * fills the box the drag spans. The canvas holds the pointer meanwhile, so a
 * drag that leaves it still ends there, held to its edges.
 */
function markPointerDown(event) {
  const markup = state.markup;
  if (!markup || event.button !== 0 || markup.pointerId != null) return;
  // No text selection or drag of the canvas starts with the press. Focus is
  // given by hand, so the keys and Esc reach the markup after a drag too.
  event.preventDefault();
  el.markupCanvas.focus({ preventScroll: true });
  try {
    el.markupCanvas.setPointerCapture(event.pointerId);
  } catch {
    /* a pointer already gone; its release still ends the shape, or nothing does */
  }
  const { x, y } = markPoint(event);
  markup.pointerId = event.pointerId;
  // A drag takes over from the keys.
  markup.cursor = null;
  markup.pending = { tool: markup.tool, x1: x, y1: y, x2: x, y2: y };
  renderMarkup();
}

function markPointerMove(event) {
  const markup = state.markup;
  if (!markup || event.pointerId !== markup.pointerId || !markup.pending) return;
  const { x, y } = markPoint(event);
  markup.pending.x2 = x;
  markup.pending.y2 = y;
  renderMarkup();
}

function markPointerUp(event) {
  const markup = state.markup;
  if (!markup || event.pointerId !== markup.pointerId) return;
  const shape = markup.pending;
  const { x, y } = markPoint(event);
  markup.pointerId = null;
  markup.pending = null;
  try {
    el.markupCanvas.releasePointerCapture(event.pointerId);
  } catch {
    /* already released */
  }
  if (shape) {
    shape.x2 = x;
    shape.y2 = y;
    if (longEnough(shape)) addMark(shape);
  }
  renderMarkup();
}

/** The drag ended without a release of its own: nothing is drawn. */
function markPointerCancel(event) {
  const markup = state.markup;
  if (!markup || event.pointerId !== markup.pointerId) return;
  markup.pointerId = null;
  markup.pending = null;
  renderMarkup();
}

/**
 * The keys on the canvas, on the model Region teaches. The first arrow key,
 * or Enter, shows a crosshair in the middle. The arrows move it by MARK_STEP
 * of the capture, or with Alt by one CSS pixel of the canvas as shown. Enter
 * fixes the first point, the arrows then move the second, drawn as they go,
 * and Enter draws the shape. Esc drops a shape half drawn (escapeMarkup).
 */
function markKey(event) {
  const markup = state.markup;
  if (!markup || event.isComposing || event.metaKey || event.ctrlKey) return;
  const step = ARROW_STEPS[event.key];
  if (!step && event.key !== 'Enter') return;
  event.preventDefault();
  // A drag is under way, and the keys wait for it.
  if (markup.pointerId != null) return;
  if (!markup.cursor) {
    markup.cursor = { x: 0.5, y: 0.5 };
    renderMarkup();
    announceAnew('Crosshair in the middle. The arrow keys move it, and Enter sets the first point.');
    return;
  }
  if (step) {
    const shown = shownSize();
    const [dx, dy] = event.altKey ? [1 / shown.width, 1 / shown.height] : [MARK_STEP, MARK_STEP];
    const held = (value) => Math.min(1, Math.max(0, value));
    markup.cursor = { x: held(markup.cursor.x + step[0] * dx), y: held(markup.cursor.y + step[1] * dy) };
    if (markup.pending) Object.assign(markup.pending, { x2: markup.cursor.x, y2: markup.cursor.y });
    renderMarkup();
    return;
  }
  const { x, y } = markup.cursor;
  if (!markup.pending) {
    markup.pending = { tool: markup.tool, x1: x, y1: y, x2: x, y2: y };
    renderMarkup();
    announceAnew(`First point set. Move to where the ${markup.tool} ends, and press Enter.`);
    return;
  }
  if (!longEnough(markup.pending)) {
    announceAnew('Move the second point away from the first, then press Enter.');
    return;
  }
  addMark(markup.pending);
  markup.pending = null;
  renderMarkup();
}

/** Take back the last mark drawn: the Undo button, or Cmd/Ctrl+Z while marking. */
function undoMark() {
  const markup = state.markup;
  if (!markup) return;
  const mark = markup.marks.pop();
  if (!mark) {
    announceAnew('No marks to take back.');
    return;
  }
  renderMarkup();
  announceAnew(`${MARK_TOOLS[mark.tool]} ${markup.marks.length + 1} removed.`);
}

/**
 * Esc while marking, once the row tooltip is closed: a shape half drawn goes
 * first. Then the markup closes as Done closes it, saving marks that changed,
 * so that a stray Esc never loses them; Cancel is the way to drop them.
 */
function escapeMarkup() {
  const markup = state.markup;
  if (!markup) return;
  if (markup.pending) {
    if (markup.pointerId != null) {
      try {
        el.markupCanvas.releasePointerCapture(markup.pointerId);
      } catch {
        /* already released */
      }
      markup.pointerId = null;
    }
    const { tool } = markup.pending;
    markup.pending = null;
    renderMarkup();
    announceAnew(`The ${tool} being drawn was dropped.`);
    return;
  }
  commitMarks({ focus: true });
}

/** Cancel: close without saving. The item keeps its file, and the marks it was saved with. */
function cancelMarkup() {
  const markup = state.markup;
  if (!markup) return;
  const changed = marksChanged(markup);
  markup.item.unsaved = null;
  closeMarkup({ focus: el.markUp });
  if (changed) announceAnew('Marks not saved.');
}

function marksChanged(markup) {
  return JSON.stringify(markup.marks) !== JSON.stringify(markup.saved);
}

/**
 * The frame is about to show another item, or none, while a markup is open.
 * The marks are saved, as Done saves them, so a mark drawn is never silently
 * left out of the prompt. Not for an item that has left the sheet (copied or
 * discarded in another window), whose marks would go to nothing.
 */
function leaveMarkup() {
  const markup = state.markup;
  if (!markup) return;
  if (state.items.some((item) => item.id === markup.item.id)) commitMarks();
  else closeMarkup();
}

/**
 * Close the markup and give the frame and the row under it back. The decoded
 * capture goes with it, unless `keep` hands it on to the save (commitMarks).
 * Focus goes to `focus` when one is given, and is the caller's otherwise.
 *
 * @returns {Object|null} the markup that was open
 */
function closeMarkup({ focus = null, keep = false } = {}) {
  const markup = state.markup;
  if (!markup) return null;
  state.markup = null;
  if (markup.pointerId != null) {
    try {
      el.markupCanvas.releasePointerCapture(markup.pointerId);
    } catch {
      /* already released */
    }
  }
  if (!keep) markup.bitmap.close?.();
  // A closed canvas keeps no pixels.
  el.markupCanvas.width = 0;
  el.markupCanvas.height = 0;
  showMarking(false);
  renderFrame();
  refreshRow(markup.item);
  updateSubmitState();
  focus?.focus({ preventScroll: true });
  return markup;
}

/**
 * Done: close the markup and, when its marks changed, save them (saveMarks).
 * Every way out of a markup but Cancel and a discard ends here: Esc, another
 * row, + New item, a capture arriving. `focus` is for Done and Esc, which
 * give the keyboard to what comes next: the description while marks are
 * saved, Mark up again when nothing changed.
 */
function commitMarks({ focus = false } = {}) {
  const markup = state.markup;
  if (!markup) return;
  if (!marksChanged(markup)) {
    // Back at the marks last saved: those are the ones kept, and marks whose
    // save failed, taken back since, do not return at the next Mark up.
    markup.item.unsaved = null;
    closeMarkup({ focus: focus ? el.markUp : null });
    return;
  }
  // Copy waits from this moment, before anything is drawn.
  markup.item.markSave = { downloadId: null };
  closeMarkup({ keep: true, focus: focus ? el.description : null });
  saveMarks(markup);
}

/**
 * Draw the marks onto the clean capture at full size and save the result
 * beside the item's file, named for the capture's own time and mode with
 * `_marked`, or without it when every mark was taken back. The PNG goes from
 * the canvas to the save as a Blob, with no data URL in between. Meanwhile
 * the item says SAVING and Copy waits; once Chrome has the path, swapFile
 * points the item at it. A save that fails, or is cancelled in a "Save as"
 * dialog, leaves the item as it was and says so, and its marks wait for the
 * next Done.
 */
async function saveMarks({ item, marks, bitmap, width, height }) {
  const canvas = document.createElement('canvas');
  try {
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, width, height);
    drawMarks(ctx, marks, width, height);
    bitmap.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('The marks could not be drawn into the screenshot.');
    const thumb = await makeThumb(canvas, thumbMaxHeight(item.mode));
    // Let go before the wait on Chrome, which a dialog can make minutes long.
    canvas.width = 0;
    canvas.height = 0;
    const saved = await saveScreenshot(
      blob,
      item.mode,
      (downloadId) => {
        if (item.markSave) item.markSave.downloadId = downloadId;
      },
      // Named for what it holds: with every mark taken back it is the clean
      // capture again, and takes the capture's own name.
      { at: item.capturedAt, suffix: marks.length ? 'marked' : undefined }
    );
    swapFile(item, saved, marks, thumb);
  } catch (error) {
    item.unsaved = marks;
    const number = state.items.findIndex((each) => each.id === item.id) + 1;
    if (number > 0) {
      showBanner(
        `The marked screenshot was not saved: ${error?.message || error} Item ${number} keeps the ` +
          'screenshot it had. Press Mark up to try the same marks again.',
        'error',
        'report'
      );
    }
  } finally {
    bitmap.close?.();
    canvas.width = 0;
    canvas.height = 0;
    item.markSave = null;
    const live = state.items.find((each) => each.id === item.id);
    renderFrame();
    if (live) refreshRow(live);
    updateSubmitState();
  }
}

/**
 * Point an item at its marked copy, then delete the file it replaced.
 *
 * In that order: deleted first, the old file's removal reaches
 * downloads.onChanged while the item still names it, and marks the item's
 * file missing. The swap is stamped (fileAt) and stored with its thumbnail,
 * so every other window takes it over (adoptStored). The old file stays when
 * the prompt being copied by hand names it.
 *
 * An item discarded meanwhile is swapped where it waits, so Undo brings it
 * back with its marks, and the discard deletes the marked copy when it
 * lapses. One that has left for good, copied or its discard settled, here or
 * in another window, keeps the file it had, since a prompt may name it, and
 * the copy nothing names is deleted.
 */
function swapFile(item, saved, marks, thumb) {
  const live = state.items.find((each) => each.id === item.id) || (inTrash(item) ? item : null);
  if (!live) {
    deleteFile({ path: saved.path, downloadId: saved.downloadId });
    return;
  }
  const old = { path: live.path, downloadId: live.downloadId };
  live.path = saved.path;
  live.downloadId = saved.downloadId;
  live.marked = marks.length ? true : undefined;
  // After the last swap, from a stamp a merge believes, as touch() stamps.
  const now = Date.now();
  forgetFarStamps(live, now);
  live.fileAt = Math.max(now, (live.fileAt || 0) + 1);
  live.thumb = thumb;
  live.verified = true; // this session's own download, just completed
  live.unchecked = false;
  live.missing = false;
  live.marks = marks;
  live.unsaved = null;
  persist({ thumbs: true });
  if (!state.handCopy?.some((each) => each.id === live.id)) deleteFile(old);
  const number = state.items.indexOf(live) + 1;
  if (!number) return;
  // The banner about a missing file may have been about this one.
  if (state.bannerScope === 'missing') {
    showBanner(null);
    sayMissing();
  }
  announce(marks.length ? `Item ${number} is saved with its marks.` : `Item ${number} is saved without marks.`);
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

  try {
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
        state.slowSaves += 1;
        showBanner(SLOW_SAVE_HINT);
      }

      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  } finally {
    // The hint is shared by every save slow enough to show it, so it goes
    // when the last of them ends, however it ends: saved, failed, cancelled
    // in the dialog, or for an item already discarded.
    if (hintShown && --state.slowSaves === 0) clearSlowSaveHint();
  }
}

/** Take the slow save hint down, and nothing else that may be showing. */
function clearSlowSaveHint() {
  if (!el.banner.hidden && el.banner.textContent === SLOW_SAVE_HINT) showBanner(null);
}

/**
 * Write a screenshot to the save folder.
 *
 * Named by time and capture mode only. It used to carry the page's host and
 * last path segment, and every path is printed in the prompt, so the page
 * toggle could not keep the host out of it.
 *
 * @param {Blob|string} source  the PNG, as a Blob or a data URL
 * @param {(downloadId: number) => void} onStarted  told the id as soon as
 *   Chrome has one, which is before the file is written, so a panel closed
 *   while the save waits can still take it back.
 * @param {{ at?: number, suffix?: string }} [name]  `at` is the time the name
 *   gives, now unless said (a marked copy keeps its capture's time), and
 *   `suffix` a word after the mode, as in `_region_marked.png`.
 * @returns {Promise<{ path: string, downloadId: number }>}
 */
async function saveScreenshot(source, mode, onStarted = () => {}, { at, suffix } = {}) {
  const label = (MODE_LABEL[mode] || MODE_LABEL.other).toLowerCase();
  const when = Number.isFinite(at) ? new Date(at) : new Date();
  const filename = `${SAVE_FOLDER}/${timestamp(when)}_${label}${suffix ? `_${suffix}` : ''}.png`;
  const blob = typeof source === 'string' ? await blobOf(source) : source;

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

  onStarted(downloadId);
  const path = await waitForDownloadPath(downloadId);
  return { path, downloadId };
}

/**
 * The download record behind an item, if it is still that item's file.
 *
 * A download id is kept for up to a week, and Chrome hands ids out again: after
 * a restart the next one is one more than the highest row left in the
 * downloads list, so clearing the newest rows reissues their ids to whatever
 * is downloaded next. Deleting by the stored id alone then deletes someone
 * else's file, and asking it whether the file exists asks about that file.
 * So the record must still name this item's path, and must be one this
 * extension started. That second test also keeps a forged item in storage
 * from pointing a discard at any other download.
 *
 * @returns {Promise<Object|null>} null when Chrome no longer lists the file
 *   under that id, which leaves nothing that can be asked or deleted.
 */
async function recordFor(item) {
  if (item.downloadId == null || !item.path) return null;
  const [record] = await chrome.downloads.search({ id: item.downloadId }).catch(() => []);
  if (!record || record.filename !== item.path) return null;
  if (record.byExtensionId !== chrome.runtime.id) return null;
  return record;
}

/**
 * Take a discarded screenshot back off the disk, and out of the download
 * history with it, if the id still names it (see recordFor). Both calls fail
 * harmlessly if the user already moved or deleted the file by hand.
 */
async function deleteFile(item) {
  const record = await recordFor(item);
  if (!record) return;
  try {
    await chrome.downloads.removeFile(record.id);
  } catch {
    /* already gone */
  }
  try {
    await chrome.downloads.erase({ id: record.id });
  } catch {
    /* already gone */
  }
}

/**
 * The same, for a page on its way out, which cannot wait for an answer: the
 * calls are sent at once and Chrome carries them out after the panel has gone
 * (checked in Chrome, closing the panel's page during the calls). Only for an
 * id this session made or already checked, which Chrome cannot have reissued.
 * cancel() stops a download still waiting on a "Save as" dialog or writing;
 * removeFile() is refused for those and takes back a finished one.
 */
function deleteNow(downloadId) {
  chrome.downloads.cancel?.(downloadId)?.catch?.(() => {});
  chrome.downloads.removeFile(downloadId)?.catch?.(() => {});
  chrome.downloads.erase({ id: downloadId })?.catch?.(() => {});
}

// ---------------------------------------------------------------- report --

/**
 * @param {Item[]} items The items this prompt is about. Passed in rather than
 *   read from state, because a capture can land while the copy is in flight
 *   and must not leak into a prompt that was already decided.
 * @param {{ context: Object|null, error: string|null }} read What
 *   refreshContext() returned for this copy.
 * @param {number[]} [numbers] Each item's place on the sheet, counted from 1,
 *   as the caller found it once the read was back: the moment it also left
 *   out whatever had been discarded during the read.
 */
function assembleReport(items, read, numbers = items.map((item) => state.items.indexOf(item) + 1)) {
  const { context, error } = read;
  const collected = context?.collected || {};
  const includePage = el.incPage.checked;
  // Whether the prompt says anything about the log at all. With both toggles
  // off, a caution or a reason about entries nobody asked for is noise.
  const wantedLog = el.incConsole.checked || el.incNetwork.checked;
  const last = items.at(-1);
  return {
    items: items.map((item, index) => ({
      // The number the sheet shows. With an earlier row unticked, the prompt
      // would otherwise count the ticked items from 1 and call the sheet's
      // item 2 item 1. Left out for an item no longer on the sheet.
      number: numbers[index] > 0 ? numbers[index] : undefined,
      intent: item.intent,
      description: item.description,
      screenshotPath: item.path,
      // The file carries marks the user drew, which the prompt says are not
      // part of the page.
      marked: item.marked || undefined,
      // How a whole page was put together, which the prompt says, so that a
      // seam or a header shown once is not read as the page's own bug. Only
      // a page item has it, so no other item's prompt changes.
      stitched: item.mode === 'page' ? item.stitched : undefined,
      // Always passed: the template compares each item's page against the one
      // the buffers were read on, and counts pages for the opening line. It
      // prints a URL only when `page` is present, so the toggle still holds.
      url: item.url,
      capturedAt: item.capturedAt,
      armedAt: item.armedAt,
      element: el.incElement.checked ? item.element : null,
    })),
    // With nothing read, the last item listed has its own page stand in, as
    // the prompt's heading for it says. Each item recorded its page at
    // capture, and without it the prompt named no page at all.
    page: includePage
      ? context?.page || (last?.url ? { url: last.url, title: last.title || '' } : null)
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
    // The page the log was read on, compared with each item's page and never
    // printed, so the page toggle off still keeps an entry from another page
    // out of an item's log.
    readUrl: wantedLog ? context?.page?.url || undefined : undefined,
    contextError: wantedLog && error ? error : undefined,
    // The log began when a collector started on a page already open, which
    // the collector says itself (see refreshContext), and the prompt says so,
    // as the footnote does.
    startedLate: wantedLog && read.lateStart ? true : undefined,
  };
}

/** The items the next prompt carries: the ticked ones. */
function includedItems() {
  return state.items.filter((item) => item.included);
}

/**
 * Whether these items hold Copy back: one still being saved (its first file,
 * or a marked copy of it), one whose file is gone, or one being marked up,
 * whose marks would otherwise be left out of the prompt.
 */
function blocked(items) {
  return items.some((item) => !item.path || item.missing || item.markSave || markingUp(item));
}

async function copyReport() {
  // The report being copied: the ticked items, as they stand at this moment.
  // Anything that lands or is ticked after this line is the start of the
  // next one.
  const ticked = includedItems();
  if (state.busy || !ticked.length || blocked(ticked)) return;

  state.busy = true;
  // Whether the keyboard was in the panel: on Copy, or wherever the shortcut
  // was pressed, the field most often. Read before Copy is disabled, which in
  // Chrome takes the focus off it and leaves it on the body (see
  // focusAfterCopy).
  const hadFocus = document.activeElement != null && document.activeElement !== document.body;
  const copies = state.copies;
  el.submit.classList.add('busy');
  el.submit.disabled = true;
  // No markup opens while the copy runs, so no marked copy can take the
  // place of a file between the prompt naming it and the sheet letting go.
  updateMarkUp();
  el.submitLabel.textContent = 'Copying…';
  showBanner(null);

  try {
    // The files are asked about again here, alongside the read and no longer
    // than it: a prompt that names a file deleted since startup sends Claude
    // Code to open nothing, somewhere this panel cannot see. Asked first, so
    // Chrome starts looking before the page is asked. Its answer about a file
    // it finds gone comes through downloads.onChanged after search() has
    // returned, and counts if it comes before the read does. A fixed wait for
    // it cost every copy 120 ms and still missed a fresh deletion, which
    // Chrome looks for at most once every ten seconds.
    const answered = new Promise((resolve) => setTimeout(resolve, FILE_ANSWER_MS));
    const [, read] = await Promise.all([checkFiles(ticked), refreshContext()]);
    // With no page to read (a tab Chrome keeps extensions out of, or none),
    // the read is back at once, before Chrome's answer: the prompt went out
    // naming a file Chrome reported gone a few milliseconds later. So such a
    // copy waits for that answer, a short while counted from the ask.
    if (read.unread) await answered;
    // Only what is still on the sheet now, numbered as it now stands. An item
    // discarded while the page was read loses its file when the undo lapses,
    // and the prompt would send Claude Code to it. By id, as resetAfterCopy
    // goes, whatever a write adopted from another window did to the objects.
    // In the order of the sheet now, too: a row moved during the read is
    // listed where it went, and the numbers rise, as the template needs.
    const place = (item) => state.items.findIndex((candidate) => candidate.id === item.id) + 1;
    const items = ticked.filter((item) => place(item) > 0).sort((a, b) => place(a) - place(b));
    if (!items.length) return;
    if (blocked(items)) {
      sayMissing();
      return;
    }

    // Numbered as the sheet numbers them, before the copy takes them off it.
    const numbers = items.map(place);
    const prompt = buildPrompt(assembleReport(items, read, numbers));
    const paths = items.map((item) => item.path);
    state.lastPrompt = prompt;
    state.lastDownloadId = items.at(-1).downloadId;
    state.copies += 1;
    state.lastCopy = { items, numbers };

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
    // Chrome's answer to this copy's own ask, if it comes after the receipt,
    // comes within milliseconds. A file the user deletes later, once the
    // prompt is pasted, is theirs to delete, and "as the prompt was copied"
    // would not be true of it.
    state.lastCopy.until = Date.now() + COPY_ANSWER_MS;
    writeReceiptNote();
    el.result.hidden = false;
    announce(el.resultText.textContent);
    el.promptPreview.textContent = prompt;
    showPrompt(!method);

    // The prompt is already captured in state.lastPrompt and in the hidden
    // proof block, so Copy again and Read prompt keep working against an
    // emptied panel. A blocked clipboard leaves the sheet as it is, and these
    // items wait for the user to say the hand copy is done.
    if (method) resetAfterCopy(items);
    else {
      state.handCopy = items;
      el.clearCopied.hidden = false;
    }
  } catch (error) {
    showBanner(error?.message || String(error), 'error', 'report');
  } finally {
    state.busy = false;
    el.submit.classList.remove('busy');
    // Must match the label in panel.html: this runs after every copy.
    el.submitLabel.textContent = 'Copy for Claude Code';
    updateSubmitState();
    if (hadFocus) focusAfterCopy(state.copies !== copies);
  }
}

/**
 * Give the keyboard back after a copy started with it in the panel: Copy
 * pressed or clicked, or the shortcut pressed in the field.
 *
 * Chrome takes the focus off a control once it is disabled, as Copy is while
 * it works, or hidden, as the field is once the copy empties the sheet, and
 * leaves it on the body, from where the next Tab starts at the top of the
 * panel. A hidden control loses it a moment later, so one that is no longer
 * shown counts as lost already. Then it goes to Copy when Copy can be pressed
 * again. When a missing file holds Copy back, it goes to that item's tick,
 * since unticking is what lifts the block. When the copy emptied the sheet,
 * it goes to Copy again, the receipt's first action. A control that can
 * still take keys keeps them: the field after a copy that left items, or
 * wherever the user has put the focus since.
 */
function focusAfterCopy(copied) {
  const now = document.activeElement;
  const kept = now && now !== document.body && now !== el.submit && !now.disabled && now.checkVisibility?.() !== false;
  if (kept) return;
  const missing = state.items.findIndex((item) => item.missing && item.included);
  const target = !el.submit.disabled
    ? el.submit
    : missing !== -1
      ? el.list.children[missing]?.querySelector('.row-tick')?.children[0]
      : copied && !el.result.hidden
        ? el.copyAgain
        : null;
  target?.focus();
}

/**
 * The line under the receipt: what the last copy could not vouch for.
 *
 * A file whose download record is gone cannot be asked about at all, so the
 * copy goes ahead, and says which ones it could not vouch for. And Chrome's
 * answer about a file it finds gone can come after the prompt was settled:
 * a page read quicker than Chrome's look at the disk, which takes longer the
 * more downloads Chrome lists (30 ms with 2000). The banner such an answer
 * raises would be about items the copy has taken off the sheet, so the
 * receipt says it instead, when it comes during the copy or after.
 *
 * Numbered as the copied prompt numbers its items, and said to be, since
 * the sheet has been numbered afresh since: the banner and the line under
 * Copy, which number by the sheet, can name its new item 1 beside this.
 */
function writeReceiptNote() {
  const { items, numbers } = state.lastCopy;
  const unchecked = numbers.filter((_, index) => items[index].unchecked);
  const gone = numbers.filter((_, index) => items[index].missing);
  el.resultNote.textContent = [
    unchecked.length
      ? `Chrome no longer lists the ${unchecked.length === 1 ? 'file' : 'files'} of ` +
        `item ${unchecked.join(', ')} in the copied prompt among its downloads, so whether ` +
        `${unchecked.length === 1 ? 'it is' : 'they are'} still on disk was not checked.`
      : '',
    gone.length
      ? `Chrome reported the ${gone.length === 1 ? 'screenshot of item' : 'screenshots of items'} ` +
        `${gone.join(', ')} in the copied prompt gone from disk as the prompt was copied, so the ` +
        `prompt names ${gone.length === 1 ? 'a file' : 'files'} no longer there.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  el.resultNote.hidden = !el.resultNote.textContent;
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
  showSubmitNote(picked);
  updateMarkUp();
}

/**
 * The line under Copy: why it is held back, or the keys that press it.
 *
 * The banner says why too, but it is one line shared by everything, and a
 * click on Region, a tab switch or a capture notice replaces what it says.
 * This line is worked out afresh from the sheet on every change, so a
 * disabled Copy always has its reason next to it.
 */
function showSubmitNote(picked) {
  // Nothing to say on an empty sheet, where the frame invites a capture, or
  // while the button itself says Copying.
  el.submitNote.hidden = state.busy || state.items.length === 0;
  if (el.submitNote.hidden) return;

  const number = (item) => state.items.indexOf(item) + 1;
  // What waits on the user first: a save in progress ends by itself, a
  // missing file holds Copy back until the user acts, and so does a markup
  // until it is done.
  const missing = picked.find((item) => item.missing);
  const marking = picked.find((item) => markingUp(item));
  const saving = picked.find((item) => !item.path || item.markSave);
  const reason =
    picked.length === 0
      ? 'Tick an item to copy it.'
      : missing
        ? `Item ${number(missing)}'s screenshot is no longer on disk. Discard or untick it to copy.`
        : marking
          ? `Finish marking up item ${number(marking)} to copy it.`
          : saving
            ? `Item ${number(saving)} is still saving.`
            : null;
  el.submitNote.replaceChildren(
    // Copy is ready: say the keys that press it from anywhere in the panel.
    ...(reason ? [textSpan(reason)] : [textSpan('Or press'), ...keyCaps(copyKeys())])
  );
}

/** A span of text, so the note is built of elements alone. */
function textSpan(words) {
  const span = document.createElement('span');
  span.textContent = words;
  return span;
}

/** One <kbd> per key. */
function keyCaps(keys) {
  return keys.map((key) => {
    const cap = document.createElement('kbd');
    cap.textContent = key;
    return cap;
  });
}

/**
 * Whether the panel runs on a Mac, where Cmd stands in for Ctrl. The keydown
 * listener takes either on every platform; this only picks the one to show.
 */
function onMac() {
  try {
    return /mac/i.test(navigator.userAgentData?.platform || navigator.platform || '');
  } catch {
    return false;
  }
}

/** The keys the keydown listener below copies on, as this platform names them. */
function copyKeys() {
  return onMac() ? ['⌘', 'Return'] : ['Ctrl', 'Enter'];
}

/**
 * Show the region shortcut Chrome has actually bound.
 *
 * The manifest only suggests Alt+Shift+C. Chrome leaves it unbound when
 * another extension holds the keys, and the user can rebind or clear it at
 * chrome://extensions/shortcuts, so the key caps in the markup are only what
 * shows until Chrome has answered, and wherever chrome.commands is missing
 * (the stage).
 */
async function showShortcut() {
  let command;
  try {
    command = (await chrome.commands.getAll()).find((entry) => entry.name === 'capture-region');
  } catch {
    return;
  }
  if (!command) return;
  const label = textSpan('Region shortcut:');
  label.className = 'sr';
  const keys = shortcutKeys(command.shortcut);
  if (keys.length) {
    el.shortcutKeys.replaceChildren(label, ...keyCaps(keys));
    return;
  }
  const unset = textSpan('No shortcut set.');
  unset.className = 'invite-unset';
  const set = document.createElement('button');
  set.type = 'button';
  set.className = 'ghost-link';
  set.textContent = 'Set one';
  // chrome:// pages open from an extension through the tabs API, not a link.
  set.addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }).catch(() => {});
  });
  el.shortcutKeys.replaceChildren(unset, set);
}

/**
 * Split Chrome's text for a shortcut into keys. Elsewhere it reads
 * "Alt+Shift+C"; on a Mac the modifiers are symbols run together, "⌥⇧C".
 */
function shortcutKeys(shortcut) {
  if (!shortcut) return [];
  if (shortcut.includes('+')) return shortcut.split('+').filter(Boolean);
  const keys = [];
  let rest = shortcut;
  while (rest && '⌃⌥⇧⌘'.includes(rest[0])) {
    keys.push(rest[0]);
    rest = rest.slice(1);
  }
  if (rest) keys.push(rest);
  return keys;
}

/** Show or hide the prompt under the receipt, and say which on Read prompt. */
function showPrompt(shown) {
  el.promptPreview.hidden = !shown;
  el.previewPromptBtn.setAttribute('aria-expanded', String(shown));
}

/**
 * Chrome has noticed that an item's PNG is no longer where it was saved.
 *
 * A report can sit for a week, and Downloads folders get emptied. Copying a
 * prompt that tells Claude Code to open a file that is not there would fail
 * somewhere it cannot be seen from here, so the item is marked and the copy
 * held while it is ticked.
 */
function markMissing(item) {
  if (item.missing) return;
  item.missing = true;
  renderFrame();
  renderSheet();
  updateSubmitState();
  sayMissing();
}

/** Chrome finds the file again, which it does after a restart. */
function clearMissing(item) {
  if (!item.missing) return;
  item.missing = false;
  renderFrame();
  renderSheet();
  updateSubmitState();
  if (state.bannerScope === 'missing') {
    showBanner(null);
    sayMissing();
  }
}

/**
 * The banner that explains a Copy held back by a missing file, if one is.
 *
 * Only a ticked item holds Copy back, so only a ticked one is named, and the
 * advice is what lifts the block. "Capture it again" did not: the new capture
 * is a new item, and the old one still held the copy. Numbered by the sheet,
 * and said to be: a receipt beside it numbers by the prompt it copied.
 */
function sayMissing() {
  const index = state.items.findIndex((item) => item.missing && item.included);
  if (index === -1) return;
  showBanner(
    `The screenshot for item ${index + 1} on the sheet is no longer on disk. Untick or discard it to copy the rest.`,
    'error',
    'missing'
  );
}

/**
 * Ask Chrome whether the files behind these items still exist.
 *
 * search() starts Chrome's existence check, whose answer, when a file has
 * gone, arrives through downloads.onChanged (handled below), a few
 * milliseconds later in Chrome 156 (see FILE_ANSWER_MS). Chrome runs that check at most once every ten seconds,
 * for every download at once, and the asks that wait out a save count too, so
 * a file deleted within ten seconds of the last ask, its capture included,
 * still reads as there. Nothing here makes Chrome look sooner. Each record is
 * first held to the item's own path (recordFor): an id Chrome has reissued
 * says nothing about this item's file.
 *
 * Asked at startup, when the panel is come back to, and with every copy.
 * The answer is never stored: a flag persisted once used to hold an item
 * missing for good.
 */
async function checkFiles(items = state.items) {
  await Promise.all(
    [...items].map(async (item) => {
      if (!item.path || item.downloadId == null) return;
      const record = await recordFor(item);
      if (!state.items.includes(item)) return;
      item.unchecked = !record;
      if (!record) return;
      item.verified = true;
      if (record.exists === false) markMissing(item);
      else if (item.missing) clearMissing(item);
    })
  );
}

// ------------------------------------------------------------ persistence --

const STORED_MODES = ['region', 'element', 'visible', 'page'];
const MAX_STORED_ITEMS = 500;
const MAX_DESCRIPTION = 50000;
// A place further out than this could not be passed: beyond 2^53 adding one
// changes nothing, and a capture would no longer land after it (rankAtEnd).
const MAX_RANK = 2 ** 52;

/** The fields of an item that are stored, and none a panel keeps for itself. */
function storedForm(item) {
  return {
    id: item.id,
    mode: item.mode,
    width: item.width,
    height: item.height,
    url: item.url,
    title: item.title,
    intent: item.intent,
    description: item.description,
    included: item.included,
    element: item.element,
    capturedAt: item.capturedAt,
    armedAt: item.armedAt,
    // Absent, as for every item nobody moved, it is left out of the write.
    rank: item.rank,
    editedAt: item.editedAt,
    wordsAt: item.wordsAt || 0,
    path: item.path,
    downloadId: item.downloadId,
    // Both left out of the write until marking up has given the item another
    // file, so an item never marked up is stored as before.
    marked: item.marked === true ? true : undefined,
    fileAt: item.fileAt || undefined,
    // A page item's only, as readItem takes it.
    stitched: item.mode === 'page' ? item.stitched : undefined,
  };
}

/** Forget removals old enough that no write can still be crossing them. */
function pruneRemoved() {
  const cutoff = Date.now() - REMOVED_TTL_MS;
  for (const [id, at] of state.removed) {
    if (at < cutoff) state.removed.delete(id);
  }
  if (state.removed.size <= REMOVED_MAX) return;
  const oldest = [...state.removed].sort((a, b) => a[1] - b[1]);
  for (const [id] of oldest.slice(0, state.removed.size - REMOVED_MAX)) state.removed.delete(id);
}

/**
 * Everything about the report except the pixels, and the thumbnails too when
 * `thumbs` says which items are on the sheet changed.
 *
 * Rewritten on every keystroke, like the draft before it, so closing the panel
 * cannot lose a sentence. That is cheap because the thumbnails live under a
 * separate key and are only rewritten when an item is added or removed, in
 * the same write as the report, so another panel hears of a new item and its
 * picture at once.
 *
 * Only items with a path are written. One still being saved has no file to
 * point at yet, and would come back after a restart as a description of
 * nothing. What left the sheet lately rides along (state.removed), so a panel
 * that wrote before hearing of the removal cannot bring the item back.
 *
 * Nothing but an item change calls this. The toggles and the intent default
 * have writes of their own, so a panel in another window that never captured
 * anything cannot overwrite this one's report by unticking a box.
 *
 * No stamp too far ahead of the clock is written (forgetFarSheet), so every
 * panel that hears the write drops its own copy of one at the same moment.
 */
function persist({ thumbs = false } = {}) {
  const now = Date.now();
  forgetFarSheet(now);
  pruneRemoved();
  const report = {
    items: state.items.filter((item) => item.path).map(storedForm),
    removed: [...state.removed].map(([id, at]) => ({ id, at })),
    // Age is measured from the last edit, not from the first capture.
    updatedAt: now,
    writer: PANEL_ID,
  };
  const values = { cdrReport: report };
  if (thumbs) {
    const items = {};
    for (const item of state.items) {
      if (item.path && item.thumb) items[item.id] = item.thumb;
    }
    values.cdrThumbs = { items, writer: PANEL_ID };
  }
  chrome.storage.local
    .set(values)
    .catch((error) => {
      // A sheet large enough to hit the storage quota still keeps its paths
      // and descriptions; losing the thumbnails is cosmetic.
      if (thumbs) return chrome.storage.local.set({ cdrReport: report });
      throw error;
    })
    .catch((error) => {
      // The report itself is small; if even this fails, the sheet in front of
      // the user is still intact and the next edit tries again.
      console.warn('[cdr] could not persist the report', error);
    });
}

/**
 * The intent default and the toggles are sticky rather than cleared with the
 * report: someone who files suggestions is usually about to file another one.
 *
 * Each is written alone, and every panel takes on another's change as it is
 * made (adoptSettings). They used to be written together from one panel's
 * memory, with no panel listening, so a panel whose toggles were days old put
 * them back over another's, and its intent with them.
 */
function persistIntent() {
  chrome.storage.local.set({ cdrIntent: state.intent }).catch(() => {});
}

function persistInclude() {
  chrome.storage.local
    .set({
      cdrInclude: {
        console: el.incConsole.checked,
        network: el.incNetwork.checked,
        element: el.incElement.checked,
        page: el.incPage.checked,
      },
    })
    .catch(() => {});
}

function applyInclude(include) {
  if (!include || typeof include !== 'object') return;
  el.incConsole.checked = include.console !== false;
  el.incNetwork.checked = include.network !== false;
  el.incElement.checked = include.element !== false;
  el.incPage.checked = include.page !== false;
}

/** Another panel changed the intent default or a toggle. */
function adoptSettings(changes) {
  if (changes.cdrIntent && 'newValue' in changes.cdrIntent) {
    state.intent = normalizeIntent(changes.cdrIntent.newValue);
  }
  if (changes.cdrInclude?.newValue) applyInclude(changes.cdrInclude.newValue);
}

/**
 * One stored item, checked field by field, or null.
 *
 * What is in storage is read as data from outside the panel: an older or a
 * newer build wrote it, or something else did, since content script contexts
 * can write an extension's local storage by default. A mode this build does
 * not know used to throw in the first render and leave the panel inert on
 * every open. The path is printed in the prompt on a line of its own, so it
 * holds no line breaks. A stamp too far ahead of the clock (tooFarAhead) is
 * read as none, so any copy with a stamp the clock accounts for is newer, and
 * so is the next edit. `now` is the merge's one reading of the clock, which
 * holds its own stamps to the same moment.
 */
function readItem(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
  const number = (value) => (Number.isFinite(value) ? value : null);
  const stamp = (value) => (number(value) != null && !tooFarAhead(value, now) ? value : 0);
  if (typeof raw.id !== 'string' || !raw.id || raw.id.length > 100) return null;
  const { path } = raw;
  if (typeof path !== 'string' || !path || path.length > 4096) return null;
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(path)) return null;
  const mode = STORED_MODES.includes(raw.mode) ? raw.mode : 'other';
  const element =
    mode === 'element' && raw.element && typeof raw.element === 'object' && !Array.isArray(raw.element)
      ? raw.element
      : null;
  const rank = number(raw.rank);
  return {
    id: raw.id,
    mode,
    width: Math.max(0, Math.round(number(raw.width) ?? 0)),
    height: Math.max(0, Math.round(number(raw.height) ?? 0)),
    url: text(raw.url, 8192),
    title: text(raw.title, 1000),
    tabId: null,
    intent: normalizeIntent(raw.intent),
    description: text(raw.description, MAX_DESCRIPTION),
    included: raw.included !== false,
    element,
    capturedAt: number(raw.capturedAt) ?? 0,
    armedAt: number(raw.armedAt) ?? undefined,
    rank: rank != null && Math.abs(rank) <= MAX_RANK ? rank : undefined,
    editedAt: stamp(raw.editedAt),
    wordsAt: stamp(raw.wordsAt),
    thumb: null,
    path,
    downloadId: Number.isSafeInteger(raw.downloadId) && raw.downloadId >= 0 ? raw.downloadId : null,
    // The value true only: anything else claims marks the file may not have.
    marked: raw.marked === true ? true : undefined,
    // Not too far ahead either, where it would outrank every later file of
    // the item.
    fileAt: stamp(raw.fileAt) > 0 ? raw.fileAt : undefined,
    stitched: mode === 'page' ? readStitched(raw.stitched) : undefined,
  };
}

/**
 * How a stored page item was put together, only as this build writes it:
 * whole numbers above 0, at most PAGE_MAX_SCREENS screens and 100 000 CSS
 * pixels a side, and cut only as true. Anything else is dropped whole,
 * since the prompt prints these numbers as facts.
 */
function readStitched(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const whole = (number, max) => Number.isSafeInteger(number) && number > 0 && number <= max;
  if (!whole(value.screens, PAGE_MAX_SCREENS)) return undefined;
  if (!whole(value.cssWidth, 100000) || !whole(value.cssHeight, 100000)) return undefined;
  const stitched = { screens: value.screens, cssWidth: value.cssWidth, cssHeight: value.cssHeight };
  if (value.cut === true) stitched.cut = true;
  return stitched;
}

/**
 * A stored report, read with readItem, and its list of removals. `far` says
 * whether it held a stamp too far ahead of the clock, on an item it takes
 * (read as none) or on a removal (dropped).
 */
function readReport(report, now = Date.now()) {
  const items = [];
  const seen = new Set();
  const ahead = (stamp) => Number.isFinite(stamp) && tooFarAhead(stamp, now);
  let far = false;
  const rawItems = Array.isArray(report?.items) ? report.items.slice(0, MAX_STORED_ITEMS) : [];
  for (const raw of rawItems) {
    const item = readItem(raw, now);
    // Two items under one id would be one row that edits two.
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    if (ahead(raw.editedAt) || ahead(raw.wordsAt) || ahead(raw.fileAt)) far = true;
    items.push(item);
  }
  const removed = [];
  const rawRemoved = Array.isArray(report?.removed) ? report.removed.slice(0, REMOVED_MAX) : [];
  for (const entry of rawRemoved) {
    if (!entry || typeof entry.id !== 'string' || entry.id.length > 100) continue;
    if (!Number.isFinite(entry.at)) continue;
    // Not too far ahead, where it would outrank every later edit of the item.
    if (tooFarAhead(entry.at, now)) {
      far = true;
      continue;
    }
    removed.push([entry.id, entry.at]);
  }
  return { items, removed, far };
}

/**
 * A stored thumbnail, only if it is an image data URL. Anything else in an
 * img src would be a request to the network, which this extension never makes.
 */
function thumbFrom(thumbs, id) {
  const items = thumbs?.items;
  if (!items || typeof items !== 'object' || !Object.prototype.hasOwnProperty.call(items, id)) return null;
  const thumb = items[id];
  return typeof thumb === 'string' && /^data:image\/(?:webp|png|jpeg);base64,/.test(thumb) ? thumb : null;
}

/**
 * Merge a sheet another panel stored into this one, item by item.
 *
 * Used at startup and whenever a panel in another window writes the report.
 * It used to replace the sheet with what was stored, and two writes that
 * crossed lost an item on both panels, or brought a discarded one back. Now:
 *
 * - An item on one side only is kept, unless it is known to have left the
 *   sheet (a discard or a copy, in any panel) after its last edit. One this
 *   panel holds that the writer had not seen yet is written back, so storage
 *   holds it too.
 * - An item on both sides takes the newer words (wordsAt) and the newer
 *   intent, tick and place (editedAt), each from whichever side changed it
 *   last, and its file (path, download id and whether it is marked) from
 *   the side that marked it up last (fileAt). A side that holds something
 *   newer writes it back.
 * - Which window has focus decides nothing. The old rule kept the sentence of
 *   whichever panel had its field focused, and the field stays the active
 *   element of a window that has lost focus: a panel in the background
 *   refused the other window's edit, and later stored its own older sentence
 *   over it. One user types in one window at a time, so the newer stamp is
 *   always the sentence being typed.
 * - Items still being saved here are not in storage yet, and stay.
 * - Both sides' stamps are held to one rule: one too far ahead of the clock
 *   counts as none, whether storage holds it or this panel does (readItem
 *   and forgetFarStamps). A side writes back only what it holds newer by
 *   that rule, so the clock set back, by any amount, cannot set two panels
 *   writing to each other. A report that held such a stamp is written back
 *   at once, on opening too, while the stamp is still too far ahead: storage
 *   loses it, and every open panel drops its own copy at that write.
 *
 * A change that leaves the sheet's shape alone, such as a keystroke in another
 * window, updates the rows it touches and nothing more: no rebuild of the
 * list, no storage read and no message to the tab.
 */
function adoptStored(report, thumbs, { initial = false } = {}) {
  const now = Date.now();
  const incoming = readReport(report, now);
  forgetFarSheet(now);
  for (const [id, at] of incoming.removed) {
    if (!(state.removed.get(id) >= at)) state.removed.set(id, at);
  }
  pruneRemoved();
  const goneAfter = (id, editedAt) => {
    const at = state.removed.get(id);
    return at != null && at >= (editedAt || 0);
  };

  const local = new Map(state.items.map((item) => [item.id, item]));
  const seen = new Set();
  const next = [];
  const changed = new Set();
  let writeBack = incoming.far;
  let wantThumbs = false;

  for (const theirs of incoming.items) {
    seen.add(theirs.id);
    const mine = local.get(theirs.id);
    if (goneAfter(theirs.id, Math.max(lastChange(theirs), mine ? lastChange(mine) : 0))) {
      // Storage still lists an item that has left the sheet.
      writeBack = true;
      continue;
    }
    if (!mine) {
      theirs.thumb = thumbFrom(thumbs, theirs.id);
      if (!theirs.thumb) wantThumbs = true;
      next.push(theirs);
      continue;
    }
    if (mine.armedAt == null && theirs.armedAt != null) mine.armedAt = theirs.armedAt;
    // Set once, at the capture: only ever missing here, never different.
    if (!mine.stitched && theirs.stitched) mine.stitched = theirs.stitched;
    if (theirs.editedAt > (mine.editedAt || 0)) {
      mine.intent = theirs.intent;
      mine.included = theirs.included;
      mine.rank = theirs.rank;
      mine.editedAt = theirs.editedAt;
      changed.add(mine);
    } else if ((mine.editedAt || 0) > theirs.editedAt) {
      writeBack = true;
    }
    if (theirs.wordsAt > (mine.wordsAt || 0)) {
      mine.description = theirs.description;
      mine.wordsAt = theirs.wordsAt;
      changed.add(mine);
    } else if ((mine.wordsAt || 0) > theirs.wordsAt) {
      writeBack = true;
    }
    // The file follows its own stamp: a panel that marked the item up gave
    // it another file and deleted the one before, which this panel must not
    // copy, nor write back over the new one. Whether that file is there is
    // asked again, as for any file this session has not checked.
    if ((theirs.fileAt || 0) > (mine.fileAt || 0)) {
      mine.path = theirs.path;
      mine.downloadId = theirs.downloadId;
      mine.marked = theirs.marked;
      mine.fileAt = theirs.fileAt;
      mine.verified = false;
      mine.unchecked = false;
      mine.missing = false;
      // Marks remembered here describe a file that is no longer the item's.
      mine.marks = null;
      mine.unsaved = null;
      changed.add(mine);
    } else if ((mine.fileAt || 0) > (theirs.fileAt || 0)) {
      writeBack = true;
    }
    const thumb = thumbFrom(thumbs, mine.id);
    if (thumb && thumb !== mine.thumb) {
      mine.thumb = thumb;
      changed.add(mine);
    }
    next.push(mine);
  }
  for (const mine of state.items) {
    if (seen.has(mine.id)) continue;
    if (!mine.path) {
      next.push(mine); // still being saved here
      continue;
    }
    if (goneAfter(mine.id, lastChange(mine))) continue; // the writer's panel removed it
    next.push(mine);
    writeBack = true; // the writer had not seen it yet
  }
  // The order of the sheet, the same in every panel: where an item was moved
  // to, else when it was captured. An item still saving here stands at its
  // place in this panel's memory, so a move made while it saved holds. The
  // sort is stable, so a sheet already in order stays as it is.
  next.sort(bySheetOrder);

  const reshaped = next.length !== state.items.length || next.some((item, i) => item !== state.items[i]);
  const wasEmpty = state.items.length === 0;
  state.items = next;

  if (initial || reshaped) {
    // The frame keeps its item while that is on the sheet. At startup, or on
    // a sheet that was empty, the newest comes in, the one most likely to
    // still need its sentence; so does it when the frame's own item went
    // elsewhere. A frame emptied on purpose (New item) stays empty.
    const keep = state.items.some((item) => item.id === state.selectedId);
    const fallback =
      initial || wasEmpty || state.selectedId != null ? (newestItem()?.id ?? null) : null;
    selectItem(keep ? state.selectedId : fallback);
  } else {
    for (const item of changed) refreshRow(item);
    const selected = selectedItem();
    if (selected && changed.has(selected)) {
      renderFrame();
      showIntent(selected.intent, { example: state.items.indexOf(selected) === 0 });
      if (el.description.value !== selected.description) setFieldText(selected.description);
    }
  }
  // A clean capture kept for an item that has left the sheet elsewhere goes.
  if (reshaped) trimFulls();
  updateSubmitState();
  updateElementCount();
  // Numbers may have moved under the missing file banner.
  if (state.bannerScope === 'missing') {
    showBanner(null);
    sayMissing();
  }
  // A new item whose thumbnail did not come in the same write.
  if (wantThumbs && !thumbs) readThumbs();
  // Opening writes nothing, unless storage holds a stamp too far ahead: a
  // panel open since before the clock went back may still hold it too.
  if (writeBack && (!initial || incoming.far)) persist({ thumbs: true });
}

/**
 * Put words from another window into the field. A field that has focus keeps
 * its caret where it was, as far as the new text reaches, rather than jumping
 * to the end.
 */
function setFieldText(text) {
  const field = el.description;
  const focused = document.activeElement === field && typeof field.setSelectionRange === 'function';
  const start = focused ? field.selectionStart : 0;
  const end = focused ? field.selectionEnd : 0;
  field.value = text;
  if (focused) field.setSelectionRange(Math.min(start, text.length), Math.min(end, text.length));
}

function readThumbs() {
  chrome.storage.local
    .get(['cdrThumbs'])
    .then((stored) => adoptThumbs(stored?.cdrThumbs))
    .catch(() => {});
}

/** Thumbnails another panel wrote, for items already on the sheet. */
function adoptThumbs(thumbs) {
  for (const item of state.items) {
    const thumb = thumbFrom(thumbs, item.id);
    if (!thumb || thumb === item.thumb) continue;
    item.thumb = thumb;
    refreshRow(item);
    if (item.id === state.selectedId) renderFrame();
  }
}

/**
 * Whether a panel is open in another window, and so showing the stored sheet.
 * runtime.getContexts has been there since Chrome 116, this extension's
 * minimum; an answer that cannot be had counts as no.
 */
async function anotherPanelOpen() {
  try {
    const page = chrome.runtime.getURL('sidepanel/panel.html');
    const contexts = await chrome.runtime.getContexts({});
    const panels = contexts.filter((context) => String(context.documentUrl || '').split(/[?#]/)[0] === page);
    return panels.length > 1;
  } catch {
    return false;
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
 * progress. Its files go with it, as a discard's do: nothing was copied, so no
 * prompt names them, and they used to pile up in the Downloads folder.
 *
 * Only ever applied here, at startup, and not while a panel in another window
 * is open: that panel is showing the sheet, and a panel left open for a week
 * keeps its items, because pulling a report out from under someone looking at
 * it would be worse than the staleness this is meant to fix.
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

  applyInclude(stored.cdrInclude);

  const report = stored.cdrReport;
  const expired =
    typeof report?.updatedAt === 'number' && Date.now() - report.updatedAt > REPORT_TTL_MS;

  // Drop it from storage rather than merely declining to show it, so a stale
  // report cannot outlive the check that rejected it.
  if (expired && !(await anotherPanelOpen())) {
    chrome.storage.local.remove(['cdrReport', 'cdrThumbs']);
    for (const item of readReport(report).items) deleteFile(item);
    selectItem(null);
    updateSubmitState();
    updateElementCount();
    return;
  }

  // Selects the most recent item, which is the one most likely to still need
  // its sentence.
  adoptStored(report, stored.cdrThumbs, { initial: true });
  checkFiles();
}

// ---------------------------------------------------------------- wiring --

function handleBroadcast(message) {
  if (message.type === 'cdr:armed') {
    // The echo of an arm this panel has already cancelled; see cancelArmed().
    if (message.armId && state.cancelledArmIds.has(message.armId)) return;
    // The shortcut arming the tab a page shot is scrolling: the newer action
    // wins, and the page is put back under its overlay.
    if (state.pageShot && message.tabId === state.pageShot.tabId) stopPageShot('armed');
    setArmed(
      message.mode,
      message.tabId,
      message.armId || null,
      typeof message.run === 'string' ? message.run : null
    );
    return;
  }

  // The page has ended its arm by finishing it. The button goes dark now
  // rather than once the screenshot is in: a mode clicked in between is a new
  // arm, and must stay lit. So must the other mode clicked before this came,
  // since a drag's message comes two frames after the release: only the arm
  // of the mode that sent it has ended.
  if (message.type === 'cdr:region-selected' || message.type === 'cdr:element-picked') {
    endArm(message);
  }

  if (message.type === 'cdr:region-selected' || message.type === 'cdr:element-picked') {
    const region = message.type === 'cdr:region-selected';
    // A mode lit now is armed on the page being photographed: Element clicked
    // in the two frames between a drag's release and its message, or the
    // shortcut arming Region again in them (endArm left that newer run lit).
    // Its overlay may already be drawn, so the capture says so, as Screen
    // does. Asked again once the pixels are in, for a mode armed while the
    // capture waited out Chrome's quota.
    let armedSince = armedHere();
    captureViewport()
      .then(async ({ dataUrl, takenAt }) => {
        armedSince ||= armedHere();
        return { ...(await cropCapture(dataUrl, message.rect, message.viewport)), takenAt };
      })
      .then((cropped) => {
        const notices = [
          armedSince ? ARMED_DURING_SCREEN : null,
          cropped.notice,
          region && message.moved === true ? MOVED_UNDER_OVERLAY : null,
        ].filter(Boolean);
        addItem({
          ...cropped,
          notice: notices.join(' ') || null,
          mode: region ? 'region' : 'element',
          ...(!region && { element: message.element }),
        });
      })
      .catch((error) => {
        // The arm already ended when this message arrived (above); a mode
        // lit since is the user's newer action and stays.
        showBanner(error?.message || (region ? 'Region capture failed.' : 'Element capture failed.'), 'error');
      });
  }

  if (message.type === 'cdr:capture-cancelled') {
    endArm(message);
  }
}

/**
 * Go dark for a content script's message that ends its arm, unless the mode
 * lit is not the one it comes from, which the worker judges the same way.
 * A cancel that names no mode ends whatever is lit.
 *
 * Nor when it comes from another run of the same mode than the one lit: the
 * shortcut can arm Region again in the two frames between a drag's release
 * and its message, and that newer run is live on the page. The panel knows a
 * run once a cdr:armed has named it, and the shortcut's always does; with no
 * run known on either side, the mode alone decides, as it always did.
 */
function endArm(message) {
  const mode =
    message.type === 'cdr:region-selected'
      ? 'region'
      : message.type === 'cdr:element-picked'
        ? 'element'
        : message.mode === 'region' || message.mode === 'element'
          ? message.mode
          : null;
  if (mode && state.armedMode !== mode) return;
  if (typeof message.run === 'string' && state.armedRun && message.run !== state.armedRun) return;
  setArmed(null);
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
// Page, and Stop while it runs. The second click of a double click would
// stop the capture the first one started.
el.modePage.addEventListener('click', (event) => {
  if (event.detail > 1) return;
  capturePage();
});
el.previewClear.addEventListener('click', discardSelected);
el.discardAll.addEventListener('click', discardAll);

el.markUp.addEventListener('click', openMarkup);
el.markArrow.addEventListener('click', () => setMarkTool('arrow'));
el.markEllipse.addEventListener('click', () => setMarkTool('ellipse'));
el.markUndo.addEventListener('click', undoMark);
el.markCancel.addEventListener('click', cancelMarkup);
el.markDone.addEventListener('click', () => commitMarks({ focus: true }));
el.markupCanvas.addEventListener('pointerdown', markPointerDown);
el.markupCanvas.addEventListener('pointermove', markPointerMove);
el.markupCanvas.addEventListener('pointerup', markPointerUp);
el.markupCanvas.addEventListener('pointercancel', markPointerCancel);
// Capture taken away without a release (the canvas hidden mid drag, say)
// drops the shape, as a cancel does; after a release it has nothing to drop.
el.markupCanvas.addEventListener('lostpointercapture', markPointerCancel);
el.markupCanvas.addEventListener('keydown', markKey);
// A panel dragged wider or narrower while marking draws the canvas afresh at
// its new size.
window.addEventListener('resize', () => {
  if (!state.markup) return;
  sizeMarkup();
  renderMarkup();
});

for (const [intent, node] of [
  ['bug', el.intentBug],
  ['change', el.intentChange],
]) {
  node.addEventListener('click', () => {
    const item = selectedItem();
    if (!item) return;
    if (item.intent !== intent) {
      item.intent = intent;
      touch(item);
      state.intent = intent;
      showIntent(intent, { example: state.items.indexOf(item) === 0 });
      persist();
      persistIntent();
    }
    // Choosing the kind of report is the step before describing it. Leaving
    // focus on the segment would send the next keystrokes nowhere.
    el.description.focus({ preventScroll: true });
  });
}

el.description.addEventListener('input', () => {
  // From here Cmd/Ctrl+Z in the field undoes the typing, not the discard.
  if (state.trash) state.trash.typed = true;
  const item = selectedItem();
  if (!item) return;
  item.description = el.description.value;
  touch(item, { words: true });
  // Cheaper than rebuilding the sheet on every keystroke, and the only thing
  // about a row that a description changes.
  const index = state.items.indexOf(item);
  const row = el.list.children[index];
  if (row) fillRowText(row, item, index);
  persist();
});

// The keyboard has come to the panel: the hint saying it was the page's is
// no longer true. The field hears 'focus' again when the window gets the
// keyboard back with the caret still in it.
el.description.addEventListener('focus', () => (el.descriptionHint.hidden = true));
window.addEventListener('focus', () => {
  el.descriptionHint.hidden = true;
  // Back from chrome://extensions/shortcuts, perhaps, with a new binding.
  showShortcut();
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

// A row dragged over the list shows where it would land, and is moved there
// when dropped. Anything else dragged here is refused as before, by leaving
// the event alone (see ownDrag). Near the list's top or bottom edge Chrome
// scrolls the list itself.
el.list.addEventListener('dragover', (event) => {
  if (!ownDrag(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  markSlot(dropSlot(event.clientY));
});
el.list.addEventListener('drop', (event) => {
  if (!ownDrag(event)) return;
  event.preventDefault();
  const id = dragged;
  const slot = dropSlot(event.clientY);
  endDrag();
  // The gap above the row's own place, or below it, moves nothing.
  const from = state.items.findIndex((item) => item.id === id);
  if (from !== -1) moveItem(id, slot > from ? slot - 1 : slot);
});
// Out of the list, the line goes; a drop there, or Esc, moves nothing.
el.list.addEventListener('dragleave', (event) => {
  if (ownDrag(event) && !el.list.contains(event.relatedTarget)) markSlot(null);
});
// A press means no drag is under way: Chrome sends no pointer events during
// one. So a drag whose end never reached its row, rebuilt meanwhile, leaves
// nothing dimmed past the next press.
document.addEventListener('pointerdown', () => {
  if (dragged != null) endDrag();
});
// Open while the pointer is on it, so it can be read at length.
el.tip.addEventListener('mouseenter', cancelHideTip);
el.tip.addEventListener('mouseleave', scheduleHideTip);
el.tip.addEventListener('click', clickThroughTip);
for (const type of ['mousedown', 'mouseup', 'click', 'dblclick']) {
  document.addEventListener(type, holdTipRun, true);
}
// Focus that moves anywhere but the tooltip's own row takes it down. One left
// open by the pointer, or by focus on the row before, covers the next row up,
// and focus moving there would sit under it. The row that gets focus opens
// its own (see renderSheet), clear of itself.
document.addEventListener('focusin', (event) => {
  if (!el.tip.hidden && event.target !== tipAnchor && !tipPressed()) hideTip();
});

for (const toggle of [el.incConsole, el.incNetwork, el.incElement, el.incPage]) {
  toggle.addEventListener('change', persistInclude);
}

// Another window's panel wrote the report. Echoes of this panel's own writes
// carry its id and are ignored; everything else is merged in, so every open
// panel shows one sheet. The new value comes with the change, so nothing is
// read back from storage for it.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.cdrIntent || changes.cdrInclude) ready.then(() => adoptSettings(changes));

  // A change with no new value is a removal, and the only code that removes
  // the report is another panel's startup, dropping it as a week old. A panel
  // still showing it keeps it, as one left open for a week does; it used to
  // read the removal as an empty sheet.
  const value = (change) => (change && change.newValue && typeof change.newValue === 'object' ? change.newValue : null);
  const report = value(changes.cdrReport);
  const thumbs = value(changes.cdrThumbs);
  const reportFromElsewhere = Boolean(report) && report.writer !== PANEL_ID;
  const thumbsFromElsewhere = Boolean(thumbs) && thumbs.writer !== PANEL_ID;
  if (!reportFromElsewhere && !thumbsFromElsewhere) return;

  ready.then(() => {
    if (reportFromElsewhere) adoptStored(report, thumbsFromElsewhere ? thumbs : null);
    else adoptThumbs(thumbs);
  });
});

// The existence check that checkFiles() starts can finish after search() has
// returned; this is where Chrome reports the answer. Held to the item's own
// file like any other answer about it (recordFor), unless the id is already
// known to be the item's (verified), when it is taken at once: Chrome answers
// a copy's check within a few milliseconds (FILE_ANSWER_MS), usually inside
// the page read, and asking again took
// long enough for the prompt to reach the clipboard first. An item the last
// copy has just taken off the sheet is said on the receipt instead.
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.exists?.current !== false) return;
  const item = state.items.find((candidate) => candidate.downloadId === delta.id);
  const copied = item ? null : state.lastCopy?.items.find((candidate) => candidate.downloadId === delta.id);
  const gone = () => {
    if (item) {
      if (state.items.includes(item)) markMissing(item);
    } else if (copied && state.lastCopy?.items.includes(copied) && !copied.missing && Date.now() <= state.lastCopy.until) {
      copied.missing = true;
      writeReceiptNote();
    }
  };
  if (!item && !copied) return;
  if ((item || copied).verified) gone();
  else recordFor(item || copied).then((record) => record && gone());
});

el.copyAgain.addEventListener('click', async () => {
  if (!state.lastPrompt) return;
  const method = await copyText(state.lastPrompt);
  el.resultText.textContent = method ? 'Copied again.' : 'Clipboard blocked. Copy from below.';
  announce(el.resultText.textContent);
  if (!method) showPrompt(true);
  // The prompt the clipboard refused has now reached it, so its items go, as
  // they would have after a first copy that worked.
  else if (state.handCopy) resetAfterCopy(state.handCopy);
});

// The clipboard refused the prompt and the user copied it from the proof block
// by hand. Clearing the sheet used to mean Discard all, which deleted every
// file the copied prompt names.
el.clearCopied.addEventListener('click', () => {
  if (!state.handCopy) return;
  resetAfterCopy(state.handCopy);
  el.resultText.textContent = 'Cleared. The screenshots stay on disk for the prompt you copied.';
  focusAfterDiscard();
});

// Cmd/Ctrl+Z from the keyboard. While a markup is open it takes back the last
// mark and nothing else, so a discard still waiting is left alone: one press
// is one undo. Otherwise it undoes the last discard. In the description field
// the key belongs to the text while marking, and once something is typed
// there since the discard; until then it means the discard. One listener for
// both, so a press cannot reach the two.
document.addEventListener('keydown', (event) => {
  if (event.isComposing) return;
  if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
  if (String(event.key).toLowerCase() !== 'z') return;
  if (state.markup) {
    if (document.activeElement === el.description) return;
    event.preventDefault();
    undoMark();
    return;
  }
  if (!state.trash) return;
  if (document.activeElement === el.description && !untouchedSinceDiscard()) return;
  event.preventDefault();
  undoDiscard();
});

// The countdown waits while the pointer is on the undo line or the keyboard
// on its button (holdUndo).
el.undo.addEventListener('mouseenter', () => holdUndo('pointer', true));
el.undo.addEventListener('mouseleave', () => holdUndo('pointer', false));
el.undo.addEventListener('focusin', () => holdUndo('focus', true));
el.undo.addEventListener('focusout', () => holdUndo('focus', false));

// Coming back to the panel: the files are asked about again, since a
// Downloads folder can be emptied while the panel waits, and the chips are
// read again (see refreshChips). Pointer events from outside the document
// carry no relatedTarget.
window.addEventListener('focus', () => {
  checkFiles();
  refreshChips();
});
document.addEventListener('visibilitychange', () => {
  // Hidden (its window minimized, say), the panel shows nothing, so the page
  // has nothing to send it.
  if (document.visibilityState === 'hidden') {
    const tabId = countsPort?.tabId;
    unwatchCounts();
    if (tabId != null) countsWaiting = tabId;
    return;
  }
  if (document.visibilityState !== 'visible') return;
  checkFiles();
  refreshChips();
  // The port again, whether or not that read is held back by its gap.
  if (countsWaiting != null && countsWaiting === state.tab?.id && !state.restriction) watchCounts(countsWaiting);
});
document.addEventListener('pointerover', (event) => {
  if (!event.relatedTarget) refreshChips();
});

/**
 * The panel is closing: the side panel was shut, or the window. What was
 * waiting on this page is done now, since nothing will be left to do it.
 *
 * - The last discard is settled, so its files go as promised. Its ids were
 *   made this session or checked when it was discarded, so the calls go out
 *   without asking again (deleteNow).
 * - A save still in flight is taken back: its item was never stored, so its
 *   file would be left in the Downloads folder with nothing pointing at it.
 *   So is a marked copy still on its way: the stored item names the file it
 *   had, which stays, and marks not yet saved are lost with the panel.
 * - A page shot still scrolling is told to put the page back. The call may
 *   not get out of a closing page; the lease in page-shot.js is the
 *   backstop, and puts the page back 4 s after the last call.
 */
function flushOnClose() {
  if (state.pageShot) callPage(state.pageShot.tabId, 'end').catch(() => {});
  const trash = state.trash;
  state.trash = null;
  if (trash) {
    clearTimeout(trash.timer);
    for (const { item } of trash.entries) {
      if (item.markSave?.downloadId != null) deleteNow(item.markSave.downloadId);
      if (state.items.some((candidate) => candidate.id === item.id)) continue;
      if (item.downloadId != null && (item.verified || !item.path)) deleteNow(item.downloadId);
    }
  }
  for (const item of state.items) {
    if (!item.path && item.downloadId != null) deleteNow(item.downloadId);
    if (item.markSave?.downloadId != null) deleteNow(item.markSave.downloadId);
  }
}
window.addEventListener('pagehide', flushOnClose);

el.reveal.addEventListener('click', () => {
  if (state.lastDownloadId != null) chrome.downloads.show(state.lastDownloadId);
});

el.previewPromptBtn.addEventListener('click', () => {
  showPrompt(el.promptPreview.hidden);
});

el.clearBuffers.addEventListener('click', async () => {
  if (!state.tab) return;
  try {
    await chrome.tabs.sendMessage(state.tab.id, { type: 'cdr:clear-context' });
    await refreshContext();
    showBanner(null);
  } catch {
    // "Log", as the button and the footnote under the chips say it.
    showBanner('No log on this page to clear.', 'error', 'page');
  }
});

document.addEventListener('keydown', (event) => {
  // Cmd/Ctrl+Enter copies without reaching for the mouse. A ticked item being
  // marked up holds it back, as it holds Copy (blocked).
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    copyReport();
    return;
  }
  // Esc closes the row tooltip first, wherever the pointer and focus are: it
  // is the nearest thing open. A second Esc reaches the markup, and the one
  // after that an armed mode.
  if (event.key === 'Escape' && !event.isComposing && !el.tip.hidden) {
    event.preventDefault();
    hideTip();
    return;
  }
  // The markup: a shape half drawn first, then the markup itself, which
  // closes as Done does, its marks saved if they changed, so that a stray Esc
  // never loses them.
  if (event.key === 'Escape' && !event.isComposing && state.markup) {
    event.preventDefault();
    escapeMarkup();
    return;
  }
  // Then a page shot that is running, which files nothing, as Stop does.
  if (event.key === 'Escape' && !event.isComposing && state.pageShot) {
    event.preventDefault();
    stopPageShot('user');
    return;
  }
  // Esc cancels an armed mode from here too. Clicking a mode button leaves
  // focus in the panel, so the page's own Esc handler, which the hint on the
  // page names, never hears the key until the user clicks back into the page.
  if (event.key === 'Escape' && !event.isComposing && armedHere()) {
    event.preventDefault();
    cancelArmed();
    return;
  }
  // Alt (Option on a Mac) with the up or down arrow moves the row the
  // keyboard is on, on its button or its tick, one place. Checked before the
  // keys an armed mode takes: the row has the keyboard, and a one pixel nudge
  // of the region's box, or a step of the element highlight (the picker pays
  // no heed to Alt), is not what was meant. From anywhere else in the panel
  // the keys still go on to the page.
  if (
    event.altKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.isComposing &&
    (event.key === 'ArrowUp' || event.key === 'ArrowDown')
  ) {
    const index = [...el.list.children].findIndex((row) => row.contains(document.activeElement));
    if (index !== -1) {
      event.preventDefault();
      const to = index + (event.key === 'ArrowUp' ? -1 : 1);
      // Said again on every press at either end, see announceAnew.
      if (to < 0) announceAnew(`Item ${index + 1} is already first.`);
      else if (to >= state.items.length) announceAnew(`Item ${index + 1} is already last.`);
      else moveItem(state.items[index].id, to);
      return;
    }
  }
  if (forwardsKey(event)) {
    event.preventDefault();
    handKeyToPage(event);
  }
});

const PAGE_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'];

/**
 * Whether a key belongs to the armed overlay or picker rather than to the
 * panel. Clicking Region or Element leaves the keyboard here, and the page
 * hears no key until it is clicked, which for Element is the pick itself. So
 * the arrows and Enter go on to the page while a mode is armed: not from a
 * text field, where they move the caret, and Enter only from the lit mode
 * button or from nowhere in particular, so that Enter on another button still
 * presses it. Alt with the up or down arrow on a row of the sheet never gets
 * here: it moves the row (see the keydown listener). Nor does any key while
 * a markup is open: the arrows and Enter draw on its canvas (markKey), and
 * anywhere else in the panel they are the panel's.
 */
function forwardsKey(event) {
  if (!PAGE_KEYS.includes(event.key) || event.isComposing) return false;
  if (event.metaKey || event.ctrlKey) return false;
  if (state.markup) return false;
  if (!armedHere()) return false;
  const focused = document.activeElement;
  if (focused && (focused.tagName === 'TEXTAREA' || focused.tagName === 'INPUT')) return false;
  if (event.key !== 'Enter') return true;
  const lit = state.armedMode === 'element' ? el.modeElement : el.modeRegion;
  return !focused || focused === document.body || focused === lit;
}

/** The key, to the controller of the mode armed, in the world it runs in. */
function handKeyToPage(event) {
  const mode = state.armedMode;
  chrome.scripting
    ?.executeScript({
      target: { tabId: state.armedTabId },
      func: (mode, name, shiftKey, altKey) => {
        const controller = mode === 'element' ? window.__cdrElementPicker : window.__cdrRegionOverlay;
        try {
          return Boolean(controller?.isActive?.() && controller.key?.(name, { shiftKey, altKey }));
        } catch {
          return false;
        }
      },
      args: [mode, event.key, event.shiftKey, event.altKey],
    })
    .catch(() => {
      /* the page went away; the arm's own checks notice */
    });
}

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
showShortcut();
// What every row's description says about the keys that move it, named as
// this platform's keyboard names them.
el.rowMoveHint.textContent = `${onMac() ? 'Option' : 'Alt'} and the up or down arrow move this item.`;

// Startup. Declared last so it runs after every listener is wired, but consumed
// by the onMessage handler above, which defers until this settles rather than
// comparing against a tab id that has not been resolved yet. It must settle as
// fulfilled whatever fails on the way, or every broadcast after it is dropped.
const ready = restore()
  .catch((error) => console.error('[cdr] could not restore the report', error))
  .then(resolveTab)
  .catch((error) => console.error('[cdr] could not read the tab in view', error));
