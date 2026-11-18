/**
 * The panel's own interface: what it says, where, to whom, and where the
 * keyboard goes. sidepanel/panel.js runs for real in the node:vm realm of
 * test/support/panel-realm.mjs; panel.html and panel.css are read as text.
 *
 * The realm hands back a few of the panel's functions by name. Every other
 * top level function of panel.js lives on the realm's global object, which
 * realmOf() reaches through a function the panel created, so a test can call
 * or watch one without the realm having to list it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultWorker, loadPanel } from './support/panel-realm.mjs';

const TAB = 7;
const fromTab = { tab: { id: TAB } };
// Whitespace folded, so attributes on lines of their own read as on one.
const HTML = readFileSync(new URL('../sidepanel/panel.html', import.meta.url), 'utf8').replace(/\s+/g, ' ');
const CSS = readFileSync(new URL('../sidepanel/panel.css', import.meta.url), 'utf8');

async function started(options) {
  const panel = loadPanel(options);
  await panel.internals.ready;
  await panel.flush();
  return panel;
}

/** The realm's global object, where panel.js's top level functions are. */
function realmOf(panel) {
  return new panel.internals.handleBroadcast.constructor('return this')();
}

/** A region drag on the tab in view, carried through to a saved item. */
async function captureRegion(panel) {
  panel.broadcast(
    {
      type: 'cdr:region-selected',
      rect: { x: 0, y: 0, width: 50, height: 50 },
      viewport: { width: 1280, height: 720 },
    },
    fromTab
  );
  await panel.flush();
  await panel.flush();
}

/**
 * Click a copy button and let the copy finish. A copy asks Chrome again
 * whether each file is on disk, alongside the page read; the clock is moved on
 * in case a read is held up behind its timeout.
 */
async function copyWith(panel, id = 'submit') {
  panel.click(id);
  await panel.flush();
  await panel.clock.advance(500);
  await panel.flush();
}

/** A node's text and its children's, as a reader would get it. */
function text(node) {
  return [node.textContent || '', ...node.children.map(text)].join('');
}

/** The row for item `index` on the sheet, and its parts. */
function row(panel, index) {
  const node = panel.element('list').children[index];
  const pick = node.children[1];
  return { node, pick, body: pick.children[1].children[1] };
}

// ------------------------------------------------------------------ UX3 --

test('UX3: the banner sits in a live region that exists before any message', () => {
  // A region announces what is added inside it. One that is itself shown or
  // inserted along with its text is, for most screen readers, not announced.
  assert.match(
    HTML,
    /<div class="notice-live" id="banner-live" aria-live="polite" aria-atomic="true"> ?<div class="notice" id="banner" hidden><\/div> ?<\/div>/
  );
  assert.ok(!/id="banner-live"[^>]*hidden/.test(HTML), 'the live region itself must never be hidden');
});

test('UX3: an error is announced assertively, a notice politely', async () => {
  const panel = await started();
  const live = panel.element('banner-live');
  // Clear collected log on a tab with no collector is an error about the page.
  panel.click('clear-buffers');
  await panel.flush();
  assert.equal(panel.banner(), 'No log on this page to clear.');
  assert.equal(live.getAttribute('aria-live'), 'assertive');

  realmOf(panel).showBanner('A notice.');
  assert.equal(live.getAttribute('aria-live'), 'polite');
});

test('UX3: the banner stays on screen while the panel is scrolled', () => {
  const rule = cssRules().find((r) => r.selector === '.notice-live');
  assert.ok(rule, 'no rule for the banner region');
  assert.equal(rule.decls.position, 'sticky');
  assert.equal(rule.decls.top, '0');
});

test('UX3: the copy receipt is announced through a region that is always there', async () => {
  assert.match(HTML, /<p class="sr" id="announce" role="status"><\/p>/);
  const panel = await started();
  await captureRegion(panel);
  await copyWith(panel);
  assert.equal(panel.element('announce').textContent, 'Copied. Paste into Claude Code.');
  await copyWith(panel, 'copy-again');
  assert.equal(panel.element('announce').textContent, 'Copied again.');
});

// ------------------------------------------------------------------ UX4 --

test('UX4: a disabled Copy says why under the button, whatever the banner does', async () => {
  const panel = await started();
  const note = panel.element('submit-note');
  assert.equal(note.hidden, true, 'nothing to explain on an empty sheet');

  await captureRegion(panel);
  const realm = realmOf(panel);
  realm.markMissing(panel.internals.state.items[0]);
  assert.equal(panel.element('submit').disabled, true);

  // Arming clears the shared banner, as a tab switch or a capture notice can.
  panel.click('mode-region');
  await panel.flush();
  assert.equal(panel.banner(), null);
  assert.equal(note.hidden, false);
  assert.match(text(note), /^Item 1's screenshot is no longer on disk\. Discard or untick it to copy\.$/);

  // Unticked, the item no longer holds Copy back, and nothing is ticked.
  const box = row(panel, 0).node.children[0].children[0];
  box.checked = false;
  box.dispatch('change');
  assert.equal(text(note), 'Tick an item to copy it.');
});

test('UX4: Copy waiting on a save says which item', async () => {
  const panel = await started({
    setup: (chrome) => {
      chrome.downloads.search = async ({ id }) => [{ id, state: 'in_progress', filename: '', exists: true }];
    },
  });
  await captureRegion(panel);
  assert.equal(panel.element('submit').disabled, true);
  assert.equal(text(panel.element('submit-note')), 'Item 1 is still saving.');
});

test('UX4: the reason is tied to the button for assistive technology', () => {
  assert.match(HTML, /<button class="send" id="submit" type="button"[^>]*aria-describedby="submit-note"/);
  assert.match(HTML, /<p class="send-note" id="submit-note" hidden><\/p>/);
});

// ------------------------------------------------------------------ M12 --

test('M12: selecting a row scrolls the list, not the panel', async () => {
  const panel = await started();
  const proto = Object.getPrototypeOf(panel.element('list'));
  const scrollIntoView = proto.scrollIntoView;
  const rect = proto.getBoundingClientRect;
  const calls = [];
  proto.scrollIntoView = function () {
    calls.push(this);
  };
  const list = panel.element('list');
  // The list shows 0 to 100; every row is drawn at 150 to 200 of its
  // content, below it until the list scrolls.
  proto.getBoundingClientRect = function () {
    const top = 150 - (list.scrollTop || 0);
    return this === list
      ? { top: 0, bottom: 100, left: 0, right: 300, width: 300, height: 100 }
      : { top, bottom: top + 50, left: 0, right: 300, width: 300, height: 50 };
  };
  try {
    list.scrollTop = 0;
    await captureRegion(panel);
    assert.equal(calls.length, 0, 'scrollIntoView scrolls the document too');
    assert.equal(list.scrollTop, 100, 'the list did not bring the new row into view');
  } finally {
    proto.scrollIntoView = scrollIntoView;
    proto.getBoundingClientRect = rect;
  }
});

// ------------------------------------------------------------------ UX5 --

test('UX5: after a capture the panel says when the page still has the keyboard', async () => {
  const panel = await started();
  const hint = panel.element('description-hint');
  const realm = realmOf(panel);

  // Screen is clicked in the panel, which has focus: the field takes the keys.
  await captureRegion(panel);
  assert.equal(hint.hidden, true);

  // A drag on the page leaves the window's focus there. focus() in the panel
  // moves only the panel's own focus, so the keys still go to the page.
  realm.document.hasFocus = () => false;
  await captureRegion(panel);
  assert.equal(hint.hidden, false);

  // Clicking the field brings the keyboard to the panel.
  panel.element('description').dispatch('focus');
  assert.equal(hint.hidden, true);
});

test('UX5: the hint is in the markup, hidden by default', () => {
  assert.match(HTML, /<p class="field-hint" id="description-hint" hidden>[^<]+<\/p>/);
});

// ------------------------------------------------------------------ UX7 --

test('UX7: a pointer click on a row puts the caret in its field, a key press does not', async () => {
  const panel = await started();
  await captureRegion(panel);
  await captureRegion(panel);
  const focused = [];
  panel.element('description').focus = () => focused.push('description');

  row(panel, 0).pick.dispatch('click', { detail: 1 });
  assert.equal(panel.internals.state.selectedId, panel.internals.state.items[0].id);
  assert.deepEqual(focused, ['description']);

  // Enter or Space on a row (detail 0) keeps the keyboard user on the sheet.
  focused.length = 0;
  row(panel, 1).pick.dispatch('click', { detail: 0 });
  assert.equal(panel.internals.state.selectedId, panel.internals.state.items[1].id);
  assert.deepEqual(focused, []);
});

// ----------------------------------------------------------------- UX11 --

function withCommands(commands) {
  return (chrome) => {
    chrome.commands = { getAll: async () => commands };
    chrome.tabs.create = async (options) => (chrome.created ||= []).push(options);
  };
}

test('UX11: the frame shows the shortcut Chrome has bound, not the suggested one', async () => {
  const panel = await started({
    setup: withCommands([
      { name: '_execute_action', shortcut: '' },
      { name: 'capture-region', shortcut: '⌥⇧R', description: 'Capture a region' },
    ]),
  });
  const keys = panel.element('shortcut-keys');
  assert.deepEqual(
    keys.children.filter((node) => node.tagName === 'KBD').map((node) => node.textContent),
    ['⌥', '⇧', 'R']
  );

  const other = await started({ setup: withCommands([{ name: 'capture-region', shortcut: 'Ctrl+Shift+Y' }]) });
  assert.deepEqual(
    other.element('shortcut-keys').children.filter((node) => node.tagName === 'KBD').map((node) => node.textContent),
    ['Ctrl', 'Shift', 'Y']
  );
});

test('UX11: with no shortcut bound the frame says so and offers to set one', async () => {
  let chrome;
  const panel = await started({
    setup: (fake) => {
      withCommands([{ name: 'capture-region', shortcut: '' }])(fake);
      chrome = fake;
    },
  });
  const keys = panel.element('shortcut-keys');
  assert.equal(keys.children.some((node) => node.tagName === 'KBD'), false);
  assert.match(text(keys), /No shortcut set/);
  const button = keys.children.find((node) => node.tagName === 'BUTTON');
  assert.ok(button, 'nothing to click to set one');
  button.dispatch('click');
  await panel.flush();
  // Through JSON: the options object was made in the panel's realm.
  assert.deepEqual(JSON.parse(JSON.stringify(chrome.created)), [{ url: 'chrome://extensions/shortcuts' }]);
});

test('UX11: the copy shortcut is shown under an enabled Copy', async () => {
  const panel = await started();
  await captureRegion(panel);
  const note = panel.element('submit-note');
  assert.equal(panel.element('submit').disabled, false);
  assert.equal(note.hidden, false);
  assert.deepEqual(
    note.children.filter((node) => node.tagName === 'KBD').map((node) => node.textContent),
    ['Ctrl', 'Enter']
  );
  assert.match(HTML, /aria-keyshortcuts="Control\+Enter Meta\+Enter"/);
});

// ----------------------------------------------------------------- UX12 --

/** Every rule outside @media, and the custom properties of each theme. */
function cssRules() {
  const source = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const outside = [];
  const media = [];
  let depth = 0;
  let start = 0;
  let mediaStart = -1;
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '{') {
      if (depth === 0 && source.slice(start, i).trim().startsWith('@media')) mediaStart = start;
      depth += 1;
    } else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        if (mediaStart !== -1) media.push(source.slice(mediaStart, i + 1));
        else outside.push(source.slice(start, i + 1));
        mediaStart = -1;
        start = i + 1;
      }
    }
  }
  const parse = (chunk) =>
    [...chunk.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(([, selectors, body]) => {
      const decls = Object.fromEntries(
        body
          .split(';')
          .map((decl) => decl.split(':'))
          .filter((parts) => parts.length >= 2)
          .map(([name, ...value]) => [name.trim(), value.join(':').trim()])
      );
      return selectors.split(',').map((selector) => ({ selector: selector.trim(), decls }));
    });
  const rules = outside.flatMap(parse);
  rules.media = media;
  return rules;
}

function themes() {
  const rules = cssRules();
  const light = { ...rules.find((r) => r.selector === ':root').decls };
  const darkBlock = rules.media.find((block) => /prefers-color-scheme:\s*dark/.test(block.split('{')[0]));
  const dark = { ...light };
  for (const rule of [...darkBlock.slice(darkBlock.indexOf('{') + 1).matchAll(/([^{}]+)\{([^{}]*)\}/g)]) {
    if (rule[1].trim() !== ':root') continue;
    for (const decl of rule[2].split(';')) {
      const [name, ...value] = decl.split(':');
      if (value.length) dark[name.trim()] = value.join(':').trim();
    }
  }
  return { light, dark, rules };
}

function rgb(value, vars) {
  const v = value.match(/^var\((--[\w-]+)\)$/);
  if (v) return rgb(vars[v[1]], vars);
  const hex = value.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function contrast(a, b) {
  const lum = (c) =>
    c
      .map((x) => x / 255)
      .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
      .reduce((sum, x, i) => sum + x * [0.2126, 0.7152, 0.0722][i], 0);
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const over = (fg, bg, alpha) => fg.map((c, i) => c * alpha + bg[i] * (1 - alpha));
const decl = (rules, selector, name) => rules.find((r) => r.selector === selector && name in r.decls)?.decls[name];

test('UX12: muted text on the sunken surface meets 4.5:1 in both themes', () => {
  const { light, dark, rules } = themes();
  for (const [name, vars] of Object.entries({ light, dark })) {
    for (const selector of ['.notice', '.receipt-path']) {
      const fg = rgb(decl(rules, selector, 'color'), vars);
      const bg = rgb(vars['--bg-sunken'], vars);
      const ratio = contrast(fg, bg);
      assert.ok(ratio >= 4.5, `${selector} in ${name}: ${ratio.toFixed(2)}:1`);
    }
  }
});

test('UX12: the placeholder meets 4.5:1 in both themes', () => {
  const { light, dark, rules } = themes();
  for (const [name, vars] of Object.entries({ light, dark })) {
    const bg = rgb(decl(rules, 'textarea', 'background'), vars);
    const alpha = Number(decl(rules, 'textarea::placeholder', 'opacity') ?? 1);
    const fg = over(rgb(decl(rules, 'textarea::placeholder', 'color'), vars), bg, alpha);
    const ratio = contrast(fg, bg);
    assert.ok(ratio >= 4.5, `placeholder in ${name}: ${ratio.toFixed(2)}:1`);
  }
});

test('UX12: the text of an unticked row meets 4.5:1 in both themes', () => {
  const { light, dark, rules } = themes();
  const UNTICKED = '.row:not(.included)';
  for (const [name, vars] of Object.entries({ light, dark })) {
    const bg = rgb(decl(rules, '.row', 'background'), vars);
    for (const part of ['.row-head', '.row-body', '.row-body.quiet']) {
      // Every opacity between the row and the text multiplies in.
      const alpha = ['', ' .row-pick', ' .row-text', ` ${part}`]
        .map((path) => Number(decl(rules, `${UNTICKED}${path}`, 'opacity') ?? 1))
        .reduce((a, b) => a * b, 1);
      const color = decl(rules, `${UNTICKED} ${part}`, 'color') ?? decl(rules, part, 'color');
      const ratio = contrast(over(rgb(color, vars), bg, alpha), bg);
      assert.ok(ratio >= 4.5, `${part} of an unticked row in ${name}: ${ratio.toFixed(2)}:1`);
    }
  }
});

// ----------------------------------------------------------------- UX13 --

test('UX13: the mode buttons say whether they are armed', async () => {
  const panel = await started();
  assert.match(HTML, /id="mode-region" type="button" aria-pressed="false"/);
  assert.match(HTML, /id="mode-element" type="button" aria-pressed="false"/);
  panel.click('mode-region');
  await panel.flush();
  assert.equal(panel.element('mode-region').getAttribute('aria-pressed'), 'true');
  assert.equal(panel.element('mode-element').getAttribute('aria-pressed'), 'false');
  panel.click('mode-element');
  await panel.flush();
  assert.equal(panel.element('mode-region').getAttribute('aria-pressed'), 'false');
  assert.equal(panel.element('mode-element').getAttribute('aria-pressed'), 'true');
  panel.key('Escape');
  assert.equal(panel.element('mode-element').getAttribute('aria-pressed'), 'false');
});

test('UX13: Read prompt says whether the prompt is shown', async () => {
  assert.match(HTML, /id="preview-prompt" type="button" aria-expanded="false" aria-controls="prompt-preview" ?>/);
  const panel = await started();
  await captureRegion(panel);
  await copyWith(panel);
  const button = panel.element('preview-prompt');
  assert.equal(panel.element('prompt-preview').hidden, true);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  panel.click('preview-prompt');
  assert.equal(panel.element('prompt-preview').hidden, false);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  panel.click('preview-prompt');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
});

async function withTip() {
  const panel = await started();
  await captureRegion(panel);
  const { pick, body } = row(panel, 0);
  // The sentence did not fit in two lines.
  body.scrollHeight = 60;
  body.clientHeight = 34;
  pick.dispatch('mouseenter');
  assert.equal(panel.element('thumb-tip').hidden, false);
  return { panel, pick };
}

test('UX13: Esc dismisses the row tooltip without moving the pointer or focus', async () => {
  const { panel } = await withTip();
  panel.key('Escape');
  assert.equal(panel.element('thumb-tip').hidden, true);
});

test('UX13: the pointer can move onto the row tooltip without it going away', async () => {
  const { panel, pick } = await withTip();
  const tip = panel.element('thumb-tip');
  // Out of the row, across the gap, onto the tooltip.
  pick.dispatch('mouseleave', { relatedTarget: panel.element('list') });
  tip.dispatch('mouseenter');
  await panel.clock.advance(1000);
  assert.equal(tip.hidden, false, 'the tooltip went before the pointer reached it');
  // And off it again.
  tip.dispatch('mouseleave', { relatedTarget: null });
  await panel.clock.advance(1000);
  assert.equal(tip.hidden, true);
  assert.ok(!/\.tip\s*\{[^}]*pointer-events:\s*none/.test(CSS), 'a tooltip the pointer cannot reach');
});

/**
 * Two items, the frame on the second, and the second row's tooltip open over
 * the first row, as it opens above its own. The realm gets what a click passed
 * through needs: elementsFromPoint finds the first row under the tooltip (and
 * elementFromPoint, which builds before this round asked once the tooltip had
 * gone), and a MouseEvent dispatched on it reaches its listeners. `under`
 * says what lies under the tooltip, the first row unless a test changes it.
 */
async function withTipOverRow() {
  const panel = await started();
  await captureRegion(panel);
  await captureRegion(panel);
  const realm = realmOf(panel);
  const tip = panel.element('thumb-tip');
  const first = row(panel, 0).pick;
  const second = row(panel, 1);
  second.body.scrollHeight = 60;
  second.body.clientHeight = 34;
  realm.MouseEvent = class {
    constructor(type, init = {}) {
      Object.assign(this, init);
      this.type = type;
    }
  };
  const view = { under: first, passed: [] };
  // Every element a click could be passed to records it, and runs its own
  // click listeners as a real dispatch would.
  const passTo = (node) => {
    node.dispatchEvent = (event) => {
      view.passed.push(node.id || 'row');
      node.dispatch(event.type, event);
    };
  };
  passTo(first);
  for (const id of ['submit', 'inc-console', 'clear-selection', 'new-item']) passTo(panel.element(id));
  realm.document.elementFromPoint = () => (tip.hidden ? view.under : tip);
  realm.document.elementsFromPoint = () => (tip.hidden ? [view.under] : [tip, view.under]);
  // Where the tooltip is laid out; the presses below land at (120, 80).
  tip.getBoundingClientRect = () => ({ left: 100, top: 60, right: 300, bottom: 100, width: 200, height: 40 });
  return { panel, realm, tip, first, second: second.pick, view };
}

/**
 * The mouse events of a press on `target`, as the panel's document hears them.
 * `at` is the press's timeStamp and point, at (120, 80) and 0 ms unless given.
 */
function pressOn(panel, target, detail = 1, at = {}) {
  const event = {
    type: 'mousedown',
    target,
    detail,
    timeStamp: 0,
    clientX: 120,
    clientY: 80,
    ...at,
    stopped: false,
    prevented: false,
    stopPropagation() {
      event.stopped = true;
    },
    preventDefault() {
      event.prevented = true;
    },
  };
  panel.documentEvent('pointerdown', { target });
  panel.documentEvent('mousedown', event);
  return event;
}

/** A press and a click on the tooltip, as Chrome delivers them. */
function clickTip(panel, tip, detail = 1, at = {}) {
  pressOn(panel, tip, detail, at);
  tip.dispatch('click', { detail, clientX: 120, clientY: 80 });
}

/** The click that follows a press, as the panel's document hears it. */
function clickOn(panel, target, detail) {
  const event = { type: 'click', target, detail, stopped: false, prevented: false };
  event.stopPropagation = () => (event.stopped = true);
  event.preventDefault = () => (event.prevented = true);
  panel.documentEvent('click', event);
  return event;
}

test('UX13: a click on the row tooltip selects the row under it, in one click', async () => {
  const { panel, tip, second } = await withTipOverRow();
  const { state } = panel.internals;
  second.dispatch('mouseenter');
  assert.equal(tip.hidden, false);
  // Up off the row, onto the tooltip where it covers the first row, and click.
  second.dispatch('mouseleave', { relatedTarget: tip });
  tip.dispatch('mouseenter');
  clickTip(panel, tip);
  await panel.clock.advance(1000);
  assert.equal(state.selectedId, state.items[0].id, 'the click stayed on the tooltip');
  assert.equal(tip.hidden, true);
});

test('UX13: a click on a tooltip opened by keyboard focus is not lost when the row loses focus', async () => {
  const { panel, tip, second } = await withTipOverRow();
  const { state } = panel.internals;
  press(panel, 'Tab');
  second.dispatch('focus');
  assert.equal(tip.hidden, false);
  // A press on something that cannot take focus takes it off the row first.
  panel.documentEvent('pointerdown', { target: tip });
  second.dispatch('blur');
  assert.equal(tip.hidden, false, 'the tooltip went at the press, so the click landed on neither');
  tip.dispatch('click', { detail: 1, clientX: 120, clientY: 80 });
  await panel.clock.advance(1000);
  assert.equal(state.selectedId, state.items[0].id);
});

// Medium in verify R1: placed below its row, or near the top of the sheet,
// the tooltip covers Copy, the Attach chips, Clear selection and + New item.
// A click on its words was passed on to them: Copy overwrote a prompt not yet
// pasted and emptied the sheet, and an unticked chip was saved for every
// later prompt.
for (const id of ['submit', 'inc-console', 'clear-selection', 'new-item']) {
  test(`UX13: a click on the tooltip over #${id} only takes the tooltip down`, async () => {
    const { panel, tip, second, view } = await withTipOverRow();
    const { state } = panel.internals;
    view.under = panel.element(id);
    second.dispatch('mouseenter');
    clickTip(panel, tip);
    await panel.clock.advance(1000);
    await panel.flush();
    assert.deepEqual(view.passed, [], `the click went on to #${id}`);
    assert.equal(tip.hidden, true, 'the tooltip stayed');
    assert.equal(state.copies, 0);
    assert.equal(state.items.length, 2);
    assert.equal(state.selectedId, state.items[1].id);
  });
}

// Low in verify R1: the first click of a double click went through at once
// and took the tooltip with it, so the second landed on what it had covered
// and no word was selected.
test('UX13: a double click on the tooltip selects a word and passes nothing on', async () => {
  const { panel, tip, second, view } = await withTipOverRow();
  const { state } = panel.internals;
  second.dispatch('mouseenter');
  clickTip(panel, tip, 1);
  await panel.clock.advance(100);
  assert.deepEqual(view.passed, [], 'the first click of a double click went on to the row');
  assert.equal(tip.hidden, false);
  clickTip(panel, tip, 2);
  await panel.clock.advance(1000);
  assert.deepEqual(view.passed, []);
  assert.equal(tip.hidden, false, 'the tooltip went from under the word being selected');
  assert.equal(state.selectedId, state.items[1].id);
});

// Low in verify T1: a double click 380 ms apart, inside the system's double
// click time, found the click on the tooltip gone through at 300 ms, and the
// row picked, with no word selected.
test('UX13: a double click on the tooltip slower than 300 ms still selects a word and passes nothing on', async () => {
  const { panel, tip, second, view } = await withTipOverRow();
  const { state } = panel.internals;
  second.dispatch('mouseenter');
  clickTip(panel, tip, 1, { timeStamp: 0 });
  await panel.clock.advance(380);
  assert.deepEqual(view.passed, [], 'the first click of a slow double click went on to the row');
  assert.equal(tip.hidden, false);
  clickTip(panel, tip, 2, { timeStamp: 380 });
  await panel.clock.advance(1000);
  assert.deepEqual(view.passed, []);
  assert.equal(tip.hidden, false);
  assert.equal(state.selectedId, state.items[1].id);
});

// F41. With the system's double click time slowed past half a second, a
// double click on the tooltip as slow as that picked the row. The browser
// counts a press as a second click only inside that time, so a double click
// it counted anywhere in the panel says how long to wait.
test('UX13: once the panel has seen a slow double click, one as slow on the tooltip selects a word and passes nothing on', async () => {
  const { panel, tip, second, view } = await withTipOverRow();
  const { state } = panel.internals;
  const field = panel.element('description');
  // A word selected in the field, 700 ms between the presses.
  pressOn(panel, field, 1, { timeStamp: 10_000 });
  pressOn(panel, field, 2, { timeStamp: 10_700 });
  second.dispatch('mouseenter');
  clickTip(panel, tip, 1, { timeStamp: 20_000 });
  await panel.clock.advance(700);
  assert.deepEqual(view.passed, [], 'the first click of a slow double click went on to the row');
  assert.equal(tip.hidden, false);
  clickTip(panel, tip, 2, { timeStamp: 20_700 });
  await panel.clock.advance(2000);
  assert.deepEqual(view.passed, []);
  assert.equal(tip.hidden, false);
  assert.equal(state.selectedId, state.items[1].id);

  // A single click waits that long too, and no longer than a second however
  // slow the double clicks seen.
  pressOn(panel, field, 1, { timeStamp: 30_000 });
  pressOn(panel, field, 2, { timeStamp: 34_000 });
  clickTip(panel, tip, 1, { timeStamp: 40_000 });
  await panel.clock.advance(990);
  assert.deepEqual(view.passed, []);
  await panel.clock.advance(20);
  assert.deepEqual(view.passed, ['row']);
});

test('UX13: with no slow double click seen, a click on the tooltip still goes after half a second', async () => {
  const { panel, tip, second, view } = await withTipOverRow();
  const field = panel.element('description');
  // A quick double click teaches nothing.
  pressOn(panel, field, 1, { timeStamp: 10_000 });
  pressOn(panel, field, 2, { timeStamp: 10_200 });
  second.dispatch('mouseenter');
  clickTip(panel, tip, 1, { timeStamp: 20_000 });
  await panel.clock.advance(490);
  assert.deepEqual(view.passed, []);
  await panel.clock.advance(20);
  assert.deepEqual(view.passed, ['row']);
});

// Low in verify T1: the tooltip went 300 ms after a click on it, and the
// user's own press on the control it had covered, 450 ms after the first,
// was stopped because the system counted it as the second click.
test('UX13: a press on what the tooltip uncovered goes there, though the system counts it as the second click', async () => {
  const { panel, tip, second, view } = await withTipOverRow();
  view.under = panel.element('new-item');
  second.dispatch('mouseenter');
  clickTip(panel, tip, 1, { timeStamp: 0 });
  // Up for as long as a second press could still come, so the control under
  // it cannot be aimed at before then.
  await panel.clock.advance(450);
  assert.equal(tip.hidden, false, 'the tooltip went while a second press could still come');
  await panel.clock.advance(200);
  assert.equal(tip.hidden, true);
  const press = pressOn(panel, view.under, 2, { timeStamp: 700 });
  assert.equal(press.stopped || press.prevented, false, 'the press was kept from + New item');
  const click = clickOn(panel, view.under, 2);
  assert.equal(click.stopped || click.prevented, false, 'the click was kept from + New item');
  // A run that began on the control itself is the control's.
  const own = pressOn(panel, view.under, 1, { timeStamp: 2000 });
  const ownSecond = pressOn(panel, view.under, 2, { timeStamp: 2200 });
  assert.equal(own.stopped || ownSecond.stopped, false);
});

// The tooltip can go before its click does: the pointer slipped off it and it
// closed after TIP_GRACE_MS. The second press of the double click then lands
// on what it covered, and is kept from it.
test('UX13: the second press of a double click where the tooltip was calls the click off and reaches nothing there', async () => {
  const { panel, tip, first, second, view } = await withTipOverRow();
  const { state } = panel.internals;
  /** A click on the tooltip, the pointer slipping off it, and the close. */
  const clickAndSlip = async (timeStamp) => {
    second.dispatch('mouseenter');
    tip.dispatch('mouseenter');
    clickTip(panel, tip, 1, { timeStamp });
    tip.dispatch('mouseleave', { relatedTarget: null });
    await panel.clock.advance(200);
    assert.equal(tip.hidden, true);
  };
  // Over the first row: the double click neither picks it through the
  // waiting click nor with its own second press.
  await clickAndSlip(0);
  const onRow = pressOn(panel, first, 2, { timeStamp: 250 });
  assert.equal(onRow.stopped && onRow.prevented, true, 'the press went on to the row');
  assert.equal(clickOn(panel, first, 2).stopped, true, 'the click went on to the row');
  await panel.clock.advance(1000);
  assert.deepEqual(view.passed, [], 'the double click picked the row');
  assert.equal(state.selectedId, state.items[1].id);
  // Over Copy, the same.
  view.under = panel.element('submit');
  await clickAndSlip(3000);
  const onCopy = pressOn(panel, view.under, 2, { timeStamp: 3250 });
  assert.equal(onCopy.stopped && onCopy.prevented, true, 'the press went on to Copy');
  const click = clickOn(panel, view.under, 2);
  assert.equal(click.stopped && click.prevented, true, 'the click went on to Copy');
  // Away from where the tooltip was, a press is the user's, whatever the count.
  await clickAndSlip(6000);
  const away = pressOn(panel, view.under, 2, { timeStamp: 6200, clientX: 20, clientY: 300 });
  assert.equal(away.stopped || away.prevented, false);
});

test('UX13: a click passed to a row still goes when the pointer leaves the tooltip at once', async () => {
  const { panel, tip, second } = await withTipOverRow();
  const { state } = panel.internals;
  second.dispatch('mouseenter');
  tip.dispatch('mouseenter');
  clickTip(panel, tip);
  tip.dispatch('mouseleave', { relatedTarget: null });
  await panel.clock.advance(1000);
  assert.equal(state.selectedId, state.items[0].id);
});

test('UX13: Esc after a click on the tooltip calls the click off', async () => {
  const { panel, tip, second, view } = await withTipOverRow();
  second.dispatch('mouseenter');
  clickTip(panel, tip);
  panel.key('Escape');
  await panel.clock.advance(1000);
  assert.deepEqual(view.passed, []);
});

// Low in verify T1: Esc reached the click only while the tooltip was up, and
// the pointer leaving it closes it within TIP_GRACE_MS while the click waits.
for (const key of ['Escape', 'a']) {
  test(`UX13: ${key} after the tooltip closed calls a waiting click on it off`, async () => {
    const { panel, tip, second, view } = await withTipOverRow();
    const { state } = panel.internals;
    second.dispatch('mouseenter');
    tip.dispatch('mouseenter');
    clickTip(panel, tip);
    tip.dispatch('mouseleave', { relatedTarget: null });
    await panel.clock.advance(200);
    assert.equal(tip.hidden, true);
    assert.deepEqual(view.passed, []);
    panel.key(key);
    await panel.clock.advance(1000);
    assert.deepEqual(view.passed, [], `the click went on after ${key}`);
    assert.equal(state.selectedId, state.items[1].id);
  });
}

test('UX13: words selected in the tooltip keep it open', async () => {
  const { panel, realm, tip, second } = await withTipOverRow();
  const { state } = panel.internals;
  second.dispatch('mouseenter');
  tip.appendChild(panel.element('thumb-tip-body'));
  realm.document.getSelection = () => ({ isCollapsed: false, anchorNode: panel.element('thumb-tip-body') });
  clickTip(panel, tip);
  await panel.clock.advance(1000);
  assert.equal(tip.hidden, false);
  assert.equal(state.selectedId, state.items[1].id);
});

test('UX13: keyboard focus moving to another row takes the tooltip down', async () => {
  const { panel, tip, first, second } = await withTipOverRow();
  // Opened by the pointer on the second row, over the first.
  second.dispatch('mouseenter');
  press(panel, 'Tab');
  panel.documentEvent('focusin', { target: second });
  assert.equal(tip.hidden, false, 'focus on the row the tooltip is about closed it');
  panel.documentEvent('focusin', { target: first });
  assert.equal(tip.hidden, true, 'the tooltip stayed over the row focus moved to');
});

// ----------------------------------------------------------------- UX15 --

test('UX15: the gauge says it measures the saved image', async () => {
  const panel = await started();
  await captureRegion(panel);
  // FakeImage decodes every capture at 1280×720, so the crop keeps 50×50.
  assert.equal(panel.element('preview-meta').textContent, 'REGION · PNG 50×50');
  await captureRegion(panel);
  assert.equal(panel.element('preview-meta').textContent, '2/2 · REGION · PNG 50×50');
});

// ----------------------------------------------------------------- UX16 --

test('UX16: no dead markup in panel.html', () => {
  assert.ok(!HTML.includes('id="toggles"'), 'an id nothing reads');
  assert.ok(!/<em class="count"><\/em>/.test(HTML), 'an empty count');
  assert.match(HTML, /<p class="receipt-head" id="result-text"><\/p>/, 'default text that is never shown');
});

// ----------------------------------------------------------------- RO11 --

/** A page whose log the test sets, and which answers when the test says. */
function pageLog() {
  const page = { counts: { errors: 0, network: 0 }, hold: null, reads: 0 };
  page.setup = (chrome) => {
    chrome.tabs.sendMessage = async (_tabId, message) => {
      if (message.type !== 'cdr:get-context') throw new Error('Receiving end does not exist.');
      page.reads += 1;
      const answer = {
        ok: true,
        page: { url: 'https://example.test/', title: 'Example' },
        collected: {
          console: [],
          warnings: [],
          errors: Array.from({ length: page.counts.errors }, () => ({ message: 'x' })),
          network: Array.from({ length: page.counts.network }, () => ({ url: '/x' })),
        },
      };
      if (page.hold) {
        const gate = page.hold;
        page.hold = null;
        await gate;
      }
      return answer;
    };
  };
  return page;
}

test('RO11: the element chip counts element items, zero included', async () => {
  const panel = await started();
  assert.equal(panel.element('count-element').textContent, '0');
  await captureRegion(panel);
  assert.equal(panel.element('count-element').textContent, '0');
});

test('RO11: an older read that answers late does not overwrite a newer count', async () => {
  const page = pageLog();
  const panel = await started({ setup: page.setup });
  const realm = realmOf(panel);
  page.counts.errors = 1;
  let release;
  page.hold = new Promise((resolve) => (release = resolve));
  const older = realm.refreshContext();
  await panel.flush();
  page.counts.errors = 3;
  await realm.refreshContext();
  assert.equal(panel.element('count-console').textContent, '3');
  release();
  await older;
  assert.equal(panel.element('count-console').textContent, '3', 'the older answer won');
});

test('RO11: the counts are read again when the pointer comes back into the panel', async () => {
  const page = pageLog();
  const panel = await started({ setup: page.setup });
  assert.equal(panel.element('count-console').textContent, '0');
  // The user goes back to the page, which throws twice.
  page.counts.errors = 2;
  // Pointer events coming in from outside the panel carry no relatedTarget.
  panel.documentEvent('pointerover', { relatedTarget: null });
  await panel.flush();
  assert.equal(panel.element('count-console').textContent, '2');
});

// Low in verify T1: panel.html's chips said 0 until the first read came back,
// two seconds on a slow collector start, of a page nothing had read yet.
test('RO11: the chips show neither a count nor the dash until the first read of the tab comes back', async () => {
  for (const id of ['count-console', 'count-network']) {
    assert.match(HTML, new RegExp(`<em class="count" id="${id}">…</em>`), `${id} has a count before any read`);
  }
  const panel = await started({
    setup: (chrome) => {
      chrome.tabs.sendMessage = () => new Promise(() => {});
    },
  });
  for (const id of ['count-console', 'count-network']) {
    assert.equal(panel.element(id).textContent, '…');
    assert.equal(panel.element(id).classList.contains('has'), false);
  }
  // The page never answers: the read gives up, and says so.
  await panel.clock.advance(2100);
  assert.equal(panel.element('count-console').textContent, '–');
});

// Low in verify T6: after a switch to a tab whose read was slow, the chips
// went on showing the counts of the tab before until it came back.
test('RO11: a change of tab clears the counts of the tab before until the new one is read', async () => {
  const page = pageLog();
  const tab = { id: TAB, windowId: 1, url: 'https://example.test/', title: 'Example' };
  const panel = await started({
    tab,
    setup: (chrome) => {
      page.setup(chrome);
      chrome.tabs.query = async () => [tab];
    },
  });
  page.counts.errors = 4;
  page.counts.network = 5;
  await realmOf(panel).refreshContext();
  assert.equal(panel.element('count-console').textContent, '4');
  assert.equal(panel.element('count-network').textContent, '5');
  let release;
  page.hold = new Promise((resolve) => (release = resolve));
  page.counts.errors = 0;
  page.counts.network = 1;
  Object.assign(tab, { id: TAB + 1, url: 'https://other.test/' });
  const switching = panel.internals.resolveTab();
  await panel.flush();
  for (const id of ['count-console', 'count-network']) {
    assert.equal(panel.element(id).textContent, '…', `${id} kept the counts of the tab before`);
    assert.equal(panel.element(id).classList.contains('has'), false);
  }
  release();
  await switching;
  await panel.flush();
  assert.equal(panel.element('count-console').textContent, '0');
  assert.equal(panel.element('count-network').textContent, '1');
  // A page event on the same tab is no change of tab: the counts stay up.
  page.hold = new Promise(() => {});
  panel.internals.resolveTab();
  await panel.flush();
  assert.equal(panel.element('count-network').textContent, '1');
});

// ----------------------------------------------------------------- F46 --
// The chips were read on focus, when the panel was shown and when the pointer
// came back, so they stayed a snapshot while the panel was left alone. Once a
// read finds the tab's collector, the panel holds a port to its bridge, which
// posts the two counts as they change (see test/bridge.test.mjs).

test('F46: while the panel is open, the chips follow the tab in view through a port, and a read does not undo it', async () => {
  const page = pageLog();
  page.counts.errors = 1;
  const panel = await started({ setup: page.setup });
  assert.equal(panel.tabPorts.length, 1, 'no port to the tab once its collector answered');
  const [port] = panel.tabPorts;
  assert.deepEqual([port.tabId, port.name, port.frameId], [TAB, 'cdr:counts', 0]);
  assert.equal(panel.element('count-console').textContent, '1');

  // The page logs, and the chips follow with no read.
  const reads = page.reads;
  port.receive({ type: 'cdr:counts', console: 4, network: 2 });
  assert.equal(panel.element('count-console').textContent, '4');
  assert.equal(panel.element('count-network').textContent, '2');
  assert.equal(panel.element('count-network').classList.contains('has'), true);
  assert.equal(page.reads, reads, 'the page was read for it');

  // A read whose reply comes after a newer post, with what it read before it.
  await realmOf(panel).refreshContext();
  assert.equal(panel.element('count-console').textContent, '4', 'the read put an older count back');
  assert.equal(panel.tabPorts.length, 1, 'a second port to the same tab');

  // What is not two counts is not shown.
  for (const message of [
    { type: 'cdr:counts', console: -1, network: 2 },
    { type: 'cdr:counts', console: '9', network: 2 },
    { type: 'cdr:counts', console: 1.5, network: 2 },
    { type: 'cdr:other', console: 9, network: 9 },
  ]) {
    port.receive(message);
  }
  assert.equal(panel.element('count-console').textContent, '4');
  port.receive({ type: 'cdr:counts', console: 0, network: 0 });
  assert.equal(panel.element('count-console').textContent, '0');
  assert.equal(panel.element('count-console').classList.contains('has'), false);
});

test('F46: the port goes with the tab in view, the page, and the panel being shown', async () => {
  const page = pageLog();
  const tab = { id: TAB, windowId: 1, url: 'https://example.test/', title: 'Example' };
  const panel = await started({
    tab,
    setup: (chrome) => {
      page.setup(chrome);
      chrome.tabs.query = async () => [tab];
    },
  });
  const first = panel.tabPorts[0];

  // Another tab: the old port closes and says nothing more, a new one opens.
  Object.assign(tab, { id: TAB + 1, url: 'https://other.test/' });
  await panel.internals.resolveTab();
  await panel.flush();
  assert.equal(first.disconnected, true, 'the port to the tab before stayed open');
  first.receive({ type: 'cdr:counts', console: 9, network: 9 });
  assert.equal(panel.element('count-console').textContent, '0');
  const second = panel.tabPorts.at(-1);
  assert.equal(second.tabId, TAB + 1);
  second.receive({ type: 'cdr:counts', console: 3, network: 1 });
  assert.equal(panel.element('count-console').textContent, '3');

  // Hidden, it holds no port; shown again, it opens one at once.
  panel.document.visibilityState = 'hidden';
  panel.documentEvent('visibilitychange');
  assert.equal(second.disconnected, true, 'a hidden panel kept its port');
  const opened = panel.tabPorts.length;
  panel.document.visibilityState = 'visible';
  panel.documentEvent('visibilitychange');
  await panel.flush();
  assert.equal(panel.tabPorts.length, opened + 1);
  const third = panel.tabPorts.at(-1);
  assert.equal(third.tabId, TAB + 1);

  // The page went (a reload, a navigation): the next read connects again,
  // and until a post comes, the read's counts are the chips'.
  third.close();
  page.counts.errors = 2;
  await realmOf(panel).refreshContext();
  assert.equal(panel.element('count-console').textContent, '2');
  assert.equal(panel.tabPorts.at(-1).tabId, TAB + 1);
  assert.equal(panel.tabPorts.at(-1).disconnected, false);

  // A new page in the same tab: the port is the old page's, and closes.
  const fourth = panel.tabPorts.at(-1);
  tab.url = 'https://other.test/next';
  await panel.internals.resolveTab();
  await panel.flush();
  assert.equal(fourth.disconnected, true, 'the port of the page before stayed open');
  assert.equal(panel.tabPorts.at(-1).disconnected, false);
});

test('F46: no port to a tab where no collector answered, or one the panel may not read', async () => {
  // Nothing answers the read (the default page): nothing to follow.
  const panel = await started();
  assert.deepEqual(panel.tabPorts, []);

  // A tab that turns out to be restricted closes the port it had.
  const page = pageLog();
  const other = await started({ setup: page.setup });
  const [port] = other.tabPorts;
  other.internals.state.restriction = 'Chrome does not allow extensions on this page.';
  await realmOf(other).refreshContext();
  assert.equal(port.disconnected, true);
  port.receive({ type: 'cdr:counts', console: 5, network: 5 });
  assert.equal(other.element('count-console').textContent, '–');
});

// ------------------------------------------------------- late start note --

// Low in verify R1: 'Collecting since 09:05 PM.' had no date and followed
// the locale's clock and digits, while the prompt prints a dated 24 hour
// stamp. Read the next morning in a 24 hour locale, 'since 21:05' looked like
// a time still to come today.
test('late start: the footnote gives the start on a 24 hour clock, with the date once it was another day', async () => {
  const panel = await started();
  const realm = realmOf(panel);
  const at = (day, hours, minutes) => new Date(2026, 10, day, hours, minutes, 30).getTime();
  realm.Date.now = () => at(17, 8, 0);
  assert.match(realm.collectingSince(at(16, 21, 5)), /^Collecting since 21:05 on 2026-11-16\. /);
  assert.match(realm.collectingSince(at(17, 7, 4)), /^Collecting since 07:04\. /);
  // The year too, once it is not this one.
  assert.match(realm.collectingSince(new Date(2025, 11, 31, 23, 59).getTime()), /^Collecting since 23:59 on 2025-12-31\. /);
  // Just started, or a start the page's clock puts ahead: "from now".
  assert.match(realm.collectingSince(at(17, 8, 0) - 5000), /^Collecting from now\. /);
  assert.match(realm.collectingSince(at(17, 9, 0)), /^Collecting from now\. /);
});

// ------------------------------------------------- collector start timeout --

// Low in verify R6: a cdr:collect answer slower than CONTEXT_TIMEOUT_MS
// marked the tab refused while the worker went on injecting, so the footnote
// advised a reload and the tab was never asked again on that page.
test('collector: a slow start is no refusal; the next read waits on the same ask, and its late answer is read', async () => {
  let answer = null;
  let collecting = false;
  const panel = await started({
    worker: (message) =>
      message.type === 'cdr:collect' ? new Promise((resolve) => (answer = resolve)) : defaultWorker(message),
    setup: (chrome) => {
      chrome.tabs.sendMessage = async () => {
        if (!collecting) throw new Error('Could not establish connection. Receiving end does not exist.');
        return {
          ok: true,
          page: { url: 'https://example.test/', title: 'Example' },
          collected: { console: [{}], warnings: [], errors: [], network: [], armedAt: Date.now(), late: true },
        };
      };
    },
  });
  const warning = panel.element('collector-warning');
  const asks = () => panel.sent.filter((m) => m.type === 'cdr:collect').length;
  assert.equal(asks(), 1);
  await panel.clock.advance(2100);
  assert.equal(warning.hidden, true, 'a slow answer was taken for a refusal, and a reload advised');
  assert.equal(panel.element('count-console').textContent, '–');

  // The next read, while the worker is still at it: no second ask.
  panel.click('refresh-context');
  await panel.flush();
  assert.equal(asks(), 1, 'a second ask went out while the first was in flight');
  await panel.clock.advance(2100);
  assert.equal(warning.hidden, true);

  // The worker answers at last: the chips are read again without waiting
  // for the user.
  collecting = true;
  answer({ ok: true, fresh: true });
  await panel.flush();
  await panel.flush();
  assert.equal(warning.hidden, false);
  assert.match(warning.textContent, /^Collecting from now/);
  assert.equal(panel.element('count-console').textContent, '1');
});

test('collector: a refusal that comes late still counts', async () => {
  let answer = null;
  const panel = await started({
    worker: (message) =>
      message.type === 'cdr:collect' ? new Promise((resolve) => (answer = resolve)) : defaultWorker(message),
  });
  await panel.clock.advance(2100);
  answer({ ok: false, outside: true });
  await panel.flush();
  panel.click('refresh-context');
  await panel.flush();
  const warning = panel.element('collector-warning');
  assert.equal(warning.hidden, false);
  assert.match(warning.textContent, /set to run only on other sites/);
  assert.equal(panel.sent.filter((m) => m.type === 'cdr:collect').length, 1);
});

// Low in verify T1: a refusal that came after CONTEXT_TIMEOUT_MS was recorded
// but not shown, and the footnote stayed hidden, as for a page merely busy,
// until something else read the tab.
for (const [reply, words] of [
  [{ ok: false, outside: true }, /^No log on this tab\. The collector is set to run only on other sites /],
  [{ ok: false }, /^No log on this tab\. Reload the page to start collecting\.$/],
]) {
  test(`collector: a late refusal ${JSON.stringify(reply)} is shown when it comes`, async () => {
    let answer = null;
    const panel = await started({
      worker: (message) =>
        message.type === 'cdr:collect' ? new Promise((resolve) => (answer = resolve)) : defaultWorker(message),
    });
    const warning = panel.element('collector-warning');
    // The footnote's own words in panel.html, which the realm does not read.
    warning.textContent = 'No log on this tab. Reload the page to start collecting.';
    await panel.clock.advance(2100);
    assert.equal(warning.hidden, true);
    answer(reply);
    await panel.flush();
    await panel.flush();
    assert.equal(warning.hidden, false, 'the refusal waited for another read');
    assert.match(warning.textContent, words);
    assert.equal(panel.element('count-console').textContent, '–');
    assert.equal(panel.sent.filter((m) => m.type === 'cdr:collect').length, 1, 'the reread asked again');
  });
}

// Low in verify T6: with the matches naming this site and leaving out only
// its path, the footnote sent the user to look for a host in the manifest.
// And in the last regression check (Z1 note 5): it named the matches alone,
// where exclude_matches, include_globs or exclude_globs can give the answer.
for (const [outside, words] of [
  ['path', 'No log on this tab. The collector is set to run only on other pages of this site (the content_scripts entries in manifest.json).'],
  ['site', 'No log on this tab. The collector is set to run only on other sites (the content_scripts entries in manifest.json).'],
  [true, 'No log on this tab. The collector is set to run only on other sites (the content_scripts entries in manifest.json).'],
]) {
  test(`collector: a refusal with outside: ${JSON.stringify(outside)} says what the matches leave out`, async () => {
    const panel = await started({
      worker: (message) => (message.type === 'cdr:collect' ? { ok: false, outside } : defaultWorker(message)),
    });
    const warning = panel.element('collector-warning');
    assert.equal(warning.hidden, false);
    assert.equal(warning.textContent, words);
  });
}

// ------------------------------------------------------------------ SS6 --

test('SS6: every item passed to the template carries its number on the sheet', async () => {
  const panel = await started();
  await captureRegion(panel);
  await captureRegion(panel);
  await captureRegion(panel);
  const realm = realmOf(panel);
  const assemble = realm.assembleReport;
  let report = null;
  realm.assembleReport = (...args) => (report = assemble(...args));

  // Item 1 waits for a later prompt.
  const box = row(panel, 0).node.children[0].children[0];
  box.checked = false;
  box.dispatch('change');
  await copyWith(panel);
  assert.ok(report, 'Copy did not assemble a report');
  // Spread: the report's arrays were made in the panel's realm.
  assert.deepEqual(
    [...report.items].map((item) => item.number),
    [2, 3]
  );
});

// ----------------------------------------------------------------- UX14 --

/** A panel whose chrome.scripting records each key handed to the page. */
async function armedWithScripting(mode) {
  const handed = [];
  const panel = await started({
    setup: (chrome) => {
      chrome.scripting = {
        executeScript: async ({ target, args }) => {
          handed.push({ tabId: target.tabId, args });
          return [{ result: true }];
        },
      };
    },
  });
  panel.click(mode === 'element' ? 'mode-element' : 'mode-region');
  await panel.flush();
  await panel.flush();
  return { panel, handed };
}

function press(panel, key, extra = {}) {
  let prevented = false;
  panel.documentEvent('keydown', {
    key,
    isComposing: false,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault() {
      prevented = true;
    },
    ...extra,
  });
  return prevented;
}

test('UX14: while a mode is armed from the panel, the arrows and Enter go on to the page', async () => {
  const { panel, handed } = await armedWithScripting('element');
  const realm = realmOf(panel);
  realm.document.activeElement = panel.element('mode-element');
  assert.equal(press(panel, 'ArrowUp'), true);
  assert.equal(press(panel, 'ArrowLeft', { shiftKey: true }), true);
  assert.equal(press(panel, 'Enter'), true);
  await panel.flush();
  assert.deepEqual(
    handed.map(({ tabId, args }) => [tabId, ...args]),
    [
      [TAB, 'element', 'ArrowUp', false, false],
      [TAB, 'element', 'ArrowLeft', true, false],
      [TAB, 'element', 'Enter', false, false],
    ]
  );
});

test('UX14: the keys stay in the panel in a text field, on another button, or with nothing armed', async () => {
  const { panel, handed } = await armedWithScripting('region');
  const realm = realmOf(panel);
  realm.document.activeElement = panel.element('description');
  panel.element('description').tagName = 'TEXTAREA';
  assert.equal(press(panel, 'ArrowLeft'), false, 'an arrow in the field left the caret');
  realm.document.activeElement = panel.element('submit');
  assert.equal(press(panel, 'Enter'), false, 'Enter on another button did not press it');
  assert.equal(press(panel, 'ArrowDown', { metaKey: true }), false);
  realm.cancelArmed();
  await panel.flush();
  realm.document.activeElement = null;
  assert.equal(press(panel, 'ArrowDown'), false, 'a key went to a page with nothing armed');
  assert.deepEqual(handed, []);
});
