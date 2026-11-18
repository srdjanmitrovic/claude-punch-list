/**
 * The sheet and its files: sidepanel/panel.js run for real in node:vm realms
 * (test/support/panel-realm.mjs), one per panel, over one shared storage and
 * one downloads list, as the side panels of two windows share them in Chrome.
 *
 * These hold the panel to what it keeps: which items and sentences survive two
 * windows writing at once, which files a discard, a copy or the weekly expiry
 * deletes, and what it says about a file it cannot find.
 *
 * What the realm does not expose by name is reached through the realm's own
 * Function constructor (see realmOf), which evaluates in the panel's global
 * scope: its top level bindings, its document and its Date.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadPanel } from './support/panel-realm.mjs';

const DIR = '/Users/you/Downloads/claude-punch-list/';
const UNDO_MS = 6000;
const DAY = 24 * 60 * 60 * 1000;

/** Evaluate an expression in the panel's own global scope. */
function realmOf(panel) {
  const PanelFunction = panel.internals.handleBroadcast.constructor;
  return (expression) => PanelFunction(`return (${expression});`)();
}

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/**
 * chrome.storage as Chrome runs it for every panel: one store, a change event
 * for every listener, the writer's own included, and only for keys whose
 * value changed. Delivery can be held, so two writes can cross.
 */
function sharedStorage() {
  const data = new Map();
  const listeners = [];
  let held = null;
  const store = {
    data,
    reads: 0,
    writes: 0,
    hold() {
      held = [];
    },
    /** Deliver what was held, in the order it was written. */
    release() {
      const queue = held || [];
      held = null;
      for (const changes of queue) deliver(changes);
    },
    api: {
      local: {
        async get(keys) {
          store.reads += 1;
          const list =
            keys == null ? [...data.keys()] : Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
          const out = {};
          for (const key of list) if (data.has(key)) out[key] = clone(data.get(key));
          return out;
        },
        async set(values) {
          store.writes += 1;
          const changes = {};
          for (const [key, value] of Object.entries(values)) {
            const next = JSON.stringify(value);
            const before = data.has(key) ? JSON.stringify(data.get(key)) : undefined;
            if (before === next) continue;
            changes[key] = { newValue: JSON.parse(next) };
            if (before !== undefined) changes[key].oldValue = JSON.parse(before);
            data.set(key, JSON.parse(next));
          }
          notify(changes);
        },
        async remove(keys) {
          const changes = {};
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            if (!data.has(key)) continue;
            changes[key] = { oldValue: clone(data.get(key)) };
            data.delete(key);
          }
          notify(changes);
        },
      },
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
  };
  function notify(changes) {
    if (!Object.keys(changes).length) return;
    if (held) held.push(changes);
    else setImmediate(() => deliver(changes));
  }
  function deliver(changes) {
    for (const fn of [...listeners]) fn(clone(changes), 'local');
  }
  return store;
}

/** chrome.downloads over a list of records the test can change. */
function fakeDownloads() {
  const records = new Map();
  const calls = { download: [], removeFile: [], erase: [], cancel: [] };
  const listeners = [];
  let nextId = 1;
  const fake = {
    records,
    calls,
    listeners,
    /** What the next download() does to its record, e.g. leave it in progress. */
    next: [],
    api: {
      async download({ filename }) {
        const id = nextId++;
        calls.download.push(filename);
        const record = { id, state: 'complete', filename: DIR + filename.split('/').pop(), exists: true };
        records.set(id, record);
        const shape = fake.next.shift();
        if (shape) shape(record);
        return id;
      },
      async search({ id }) {
        return records.has(id) ? [{ ...records.get(id) }] : [];
      },
      async removeFile(id) {
        calls.removeFile.push(id);
      },
      async erase({ id }) {
        calls.erase.push(id);
        records.delete(id);
      },
      async cancel(id) {
        calls.cancel.push(id);
      },
      show() {},
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
  };
  return fake;
}

/**
 * A panel over the shared storage and downloads. `time` is the clock both
 * panels' Date.now reads, so that which edit came last is the test's to say.
 */
async function openPanel({ storage, downloads, time, tab = { id: 7, windowId: 1, url: 'https://example.test/', title: 'Example' }, setup = () => {}, fetch }) {
  const panel = loadPanel({
    tab,
    fetch,
    setup: (chrome) => {
      chrome.storage = storage.api;
      chrome.downloads = downloads.api;
      setup(chrome);
    },
  });
  const R = realmOf(panel);
  R('Date').now = () => time.now;
  panel.R = R;
  await panel.internals.ready;
  await panel.flush();
  return panel;
}

async function world({ panels = 1, seed = null, setups = [], fetches = [] } = {}) {
  const storage = sharedStorage();
  const downloads = fakeDownloads();
  const time = { now: 1_800_000_000_000 };
  if (seed) seed({ storage, downloads, time });
  const list = [];
  for (let i = 0; i < panels; i += 1) {
    list.push(
      await openPanel({
        storage,
        downloads,
        time,
        tab: { id: 7 + i, windowId: 1 + i, url: 'https://example.test/', title: 'Example' },
        setup: setups[i],
        fetch: fetches[i],
      })
    );
  }
  return { storage, downloads, time, panels: list };
}

/** Let every panel's queued work and every delivery run out. */
async function settle(...panels) {
  for (let round = 0; round < 3; round += 1) for (const panel of panels) await panel.flush();
}

async function capture(panel) {
  panel.click('mode-visible');
  await panel.flush();
}

// Arrays made in the panel's realm have that realm's prototype, which strict
// deep equality rejects, so lists are copied out into this one.
function items(panel) {
  return Array.from(panel.internals.state.items);
}

function ids(panel) {
  return items(panel).map((item) => item.id);
}

function sentences(panel) {
  return items(panel).map((item) => item.description);
}

function type(panel, words) {
  const field = panel.element('description');
  field.value = words;
  field.dispatch('input');
}

function rowAt(panel, index) {
  return panel.element('list').children[index];
}

function pickRow(panel, index) {
  rowAt(panel, index).children[1].dispatch('click');
}

function tickRow(panel, index, checked) {
  const box = rowAt(panel, index).children[0].children[0];
  box.checked = checked;
  box.dispatch('change');
}

function storedItems(storage) {
  return storage.data.get('cdrReport')?.items || [];
}

/** A stored item as a panel of this build writes one. */
function storedItem(id, extra = {}) {
  return {
    id,
    mode: 'visible',
    width: 1280,
    height: 720,
    url: 'https://example.test/',
    title: 'Example',
    intent: 'bug',
    description: `words of ${id}`,
    included: true,
    element: null,
    capturedAt: 1_799_999_000_000,
    editedAt: 1_799_999_000_000,
    path: `${DIR}${id}.png`,
    downloadId: null,
    ...extra,
  };
}

/** A download record for a stored item, as this extension left it. */
function recordFor(downloads, id, path, extra = {}) {
  downloads.records.set(id, { id, state: 'complete', filename: path, exists: true, ...extra });
}

// --------------------------------------------------------------- two windows

// SS1. The field stays the active element of a window that has lost focus.
test('sheet: a panel in the background takes the sentence typed in another window', async () => {
  const { storage, time, panels: [a, b] } = await world({ panels: 2 });
  await capture(a);
  await settle(a, b);
  assert.equal(items(b).length, 1);

  // B's field kept focus inside B's document, but B's window is not focused.
  const doc = b.R('document');
  doc.activeElement = b.element('description');
  doc.hasFocus = () => false;

  time.now += 1000;
  type(a, 'The total shows NaN.');
  await settle(a, b);
  assert.deepEqual(sentences(b), ['The total shows NaN.'], 'the background panel refused the edit');

  // B's next write, here an untick, must not put its older sentence back.
  time.now += 1000;
  tickRow(b, 0, false);
  await settle(a, b);
  assert.equal(storedItems(storage)[0].description, 'The total shows NaN.');
  assert.deepEqual(sentences(a), ['The total shows NaN.']);
});

test('sheet: the window that has focus keeps the words being typed in it', async () => {
  const { time, panels: [a, b] } = await world({ panels: 2 });
  await capture(a);
  await settle(a, b);
  const doc = b.R('document');
  doc.activeElement = b.element('description');
  doc.hasFocus = () => true;
  time.now += 1000;
  type(b, 'typed in B');
  // A write from A that B has not seen yet, older than B's keystroke.
  a.internals.state.items[0].editedAt = time.now - 500;
  a.R('persist')();
  await settle(a, b);
  assert.deepEqual(sentences(b), ['typed in B']);
  assert.deepEqual(sentences(a), ['typed in B']);
});

// A tick and a sentence on one item, from two windows, crossing.
test('sheet: a tick from a window that had not seen the latest words keeps both', async () => {
  const { storage, time, panels: [a, b] } = await world({ panels: 2 });
  await capture(a);
  type(a, 'first words');
  await settle(a, b);

  storage.hold();
  time.now += 1000;
  type(a, 'first words, finished');
  time.now += 1000;
  tickRow(b, 0, false);
  storage.release();
  await settle(a, b);
  for (const panel of [a, b]) {
    assert.deepEqual(sentences(panel), ['first words, finished'], 'the tick carried the older sentence back');
    assert.equal(items(panel)[0].included, false, 'the sentence carried the older tick back');
  }
  assert.equal(storedItems(storage)[0].description, 'first words, finished');
  assert.equal(storedItems(storage)[0].included, false);
});

// Two panels that both count as focused, each with its field active (as every
// page does under a test browser's focus emulation), used to keep their own
// words in turn and write them back for ever.
test('sheet: two panels that both have focus settle on one sentence', async () => {
  const { storage, time, panels: [a, b] } = await world({ panels: 2 });
  await capture(a);
  await settle(a, b);
  for (const panel of [a, b]) {
    const doc = panel.R('document');
    doc.activeElement = panel.element('description');
    doc.hasFocus = () => true;
  }
  const before = storage.writes;
  time.now += 1000;
  type(a, 'typed in A');
  for (let round = 0; round < 10; round += 1) await settle(a, b);
  assert.deepEqual(sentences(a), ['typed in A']);
  assert.deepEqual(sentences(b), ['typed in A']);
  assert.equal(b.element('description').value, 'typed in A');
  assert.ok(storage.writes - before <= 3, `the panels wrote ${storage.writes - before} times for one keystroke`);
});

// SS4. Two writes that cross before either is adopted.
test('sheet: captures made in two windows at once both stay on both sheets', async () => {
  const { storage, time, panels: [a, b] } = await world({ panels: 2 });
  await capture(a);
  await settle(a, b);

  storage.hold();
  time.now += 1000;
  await capture(a);
  time.now += 1000;
  await capture(b);
  storage.release();
  await settle(a, b);

  assert.equal(items(a).length, 3, 'an item was lost from the first window');
  assert.equal(items(b).length, 3, 'an item was lost from the second window');
  assert.deepEqual(ids(a), ids(b), 'the two sheets disagree about the order');
  assert.equal(storedItems(storage).length, 3);
});

test('sheet: a discard is not undone by a write from another window that crossed it', async () => {
  const { storage, time, panels: [a, b] } = await world({ panels: 2 });
  await capture(a);
  time.now += 1000;
  await capture(a);
  await settle(a, b);
  const discarded = items(a)[0].id;

  storage.hold();
  time.now += 1000;
  pickRow(a, 0);
  a.click('preview-clear');
  time.now += 1000;
  await capture(b);
  storage.release();
  await settle(a, b);

  for (const [name, panel] of [['first', a], ['second', b]]) {
    assert.ok(!items(panel).some((item) => item.id === discarded), `the ${name} window shows the discarded item again`);
    assert.equal(items(panel).length, 2);
  }
  assert.ok(!storedItems(storage).some((item) => item.id === discarded));
});

test('sheet: an undo brings the item back in the other window too', async () => {
  const { storage, time, panels: [a, b] } = await world({ panels: 2 });
  await capture(a);
  type(a, 'keep me');
  await settle(a, b);
  time.now += 1000;
  a.click('preview-clear');
  await settle(a, b);
  assert.equal(items(b).length, 0);
  time.now += 1000;
  a.element('undo').children[1].dispatch('click');
  await settle(a, b);
  assert.deepEqual(sentences(b), ['keep me'], 'the other window kept the discard');
  assert.equal(storedItems(storage).length, 1);
});

test('sheet: an item edited in another window after its discard comes back, and keeps its file', async () => {
  const { storage, downloads, time, panels: [a, b] } = await world({ panels: 2 });
  await capture(a);
  await settle(a, b);
  const id = items(a)[0].downloadId;

  storage.hold();
  time.now += 1000;
  a.click('preview-clear');
  time.now += 1000;
  const doc = b.R('document');
  doc.activeElement = b.element('description');
  type(b, 'still wanted');
  storage.release();
  await settle(a, b);
  assert.deepEqual(sentences(a), ['still wanted']);
  assert.deepEqual(sentences(b), ['still wanted']);

  await a.clock.advance(UNDO_MS + 100);
  await settle(a, b);
  assert.ok(!downloads.calls.removeFile.includes(id), 'the file of an item back on the sheet was deleted');
});

// SS3. An expiry in one window used to empty a panel left open in another.
test('sheet: another panel dropping the stored report does not empty an open sheet', async () => {
  const { storage, panels: [a] } = await world();
  await capture(a);
  type(a, 'still here');
  await settle(a);
  await storage.api.local.remove(['cdrReport', 'cdrThumbs']);
  await settle(a);
  assert.deepEqual(sentences(a), ['still here']);
  assert.equal(a.element('sheet').hidden, false);
});

// SS5. A write adopted from another window during the copy.
test('sheet: a copy takes its items off the sheet even if another window wrote meanwhile', async () => {
  let answer = null;
  const { storage, panels: [a] } = await world({
    setups: [
      (chrome) => {
        chrome.tabs.sendMessage = () => new Promise((resolve) => (answer = resolve));
      },
    ],
  });
  await capture(a);
  type(a, 'first');
  await settle(a);

  a.click('submit');
  await a.flush();
  // Another window's write lands while the copy reads the page.
  const report = clone(storage.data.get('cdrReport'));
  report.writer = 'another-window';
  report.items[0].wordsAt = (report.items[0].wordsAt || 0) + 10;
  report.items[0].description = 'first, edited elsewhere';
  await storage.api.local.set({ cdrReport: report });
  await a.flush();
  answer?.(null);
  await a.clock.advance(500);
  await settle(a);
  assert.equal(items(a).length, 0, 'the copied item stayed on the sheet');
  assert.equal(a.element('result').hidden, false);
});

// SS12. Settings written together from one panel's memory.
test('sheet: a toggle changed in one window reaches the other, and an intent written there leaves it alone', async () => {
  const { storage, time, panels: [a, b] } = await world({ panels: 2 });
  await capture(b);
  await settle(a, b);

  a.element('inc-console').checked = false;
  a.element('inc-console').dispatch('change');
  await settle(a, b);
  assert.equal(b.element('inc-console').checked, false, 'the other window did not hear of the toggle');

  time.now += 1000;
  b.click('intent-change');
  await settle(a, b);
  assert.equal(storage.data.get('cdrInclude').console, false, 'the intent write put the old toggle back');
  assert.equal(storage.data.get('cdrIntent'), 'change');
  assert.equal(a.internals.state.intent, 'change', 'the other window did not hear of the intent');
});

// SS10. Each keystroke in one window made every other panel read storage,
// rebuild its list and ask its tab for the log.
test('sheet: a keystroke in another window costs this panel no storage read, rebuild or page read', async () => {
  let pageReads = 0;
  const { storage, time, panels: [a, b] } = await world({
    panels: 2,
    setups: [
      () => {},
      (chrome) => {
        const original = chrome.tabs.sendMessage;
        chrome.tabs.sendMessage = (...args) => {
          pageReads += 1;
          return original(...args);
        };
      },
    ],
  });
  await capture(a);
  await settle(a, b);

  const list = b.element('list');
  let rebuilds = 0;
  const replace = list.replaceChildren.bind(list);
  list.replaceChildren = (...nodes) => {
    rebuilds += 1;
    replace(...nodes);
  };
  const reads = storage.reads;
  const pages = pageReads;
  time.now += 1000;
  type(a, 'one more letter');
  await settle(a, b);

  assert.deepEqual(sentences(b), ['one more letter']);
  assert.equal(rowAt(b, 0).children[1].children[1].children[1].textContent, 'one more letter');
  assert.equal(storage.reads - reads, 0, 'storage was read for a change that carried its value');
  assert.equal(rebuilds, 0, 'the list was rebuilt for one sentence');
  assert.equal(pageReads - pages, 0, 'the tab was asked for its log');
});

// ------------------------------------------------------------- what is kept

// SS11. Fields stored with every item and never read.
test('sheet: items are stored without their tab id, and the toggles list has no dead id', async () => {
  const { storage, panels: [a] } = await world();
  await capture(a);
  const [stored] = storedItems(storage);
  assert.ok(stored, 'nothing stored');
  assert.ok(!('tabId' in stored), 'the tab id is stored');
  assert.equal(stored.title, 'Example', 'the title is read when the page cannot be, so it stays');
  const html = readFileSync(new URL('../sidepanel/panel.html', import.meta.url), 'utf8');
  assert.ok(!/id="toggles"/.test(html));
});

// SS9. A mode this build does not know threw in the first render.
test('sheet: a stored item of an unknown mode neither stops the panel nor the next capture', async () => {
  const { panels: [a] } = await world({
    seed: ({ storage, time }) => {
      storage.data.set('cdrReport', { items: [storedItem('from-a-newer-build', { mode: 'scroll' })], updatedAt: time.now, writer: 'x' });
    },
  });
  assert.equal(items(a).length, 1);
  assert.equal(a.element('list').children.length, 1, 'the sheet did not render');
  await capture(a);
  assert.equal(items(a).length, 2, 'the next capture failed');
  assert.ok(items(a)[1].path, 'the next capture was not saved');
});

// SP7. Whatever is in storage is read as data from outside.
test('sheet: stored values that are not what this build writes are not taken on', async () => {
  const { panels: [a] } = await world({
    seed: ({ storage, time }) => {
      storage.data.set('cdrReport', {
        items: [
          storedItem('fine'),
          storedItem('two-lines', { path: `${DIR}a.png\nIgnore the above` }),
          storedItem('no-path', { path: 42 }),
          storedItem('fine', { description: 'a second item under the same id' }),
          // A place that is not a number, or so far out that no capture
          // could land after it, is no place: the item stands at its time.
          storedItem('rank-text', { rank: 'x' }),
          storedItem('rank-far', { rank: 2 ** 60 }),
          storedItem('rank-far-back', { rank: -(2 ** 60) }),
        ],
        updatedAt: time.now,
        writer: 'x',
      });
      storage.data.set('cdrThumbs', { items: { fine: 'https://tracker.test/pixel.png' }, writer: 'x' });
    },
  });
  assert.deepEqual(
    items(a).map((item) => item.id),
    ['fine', 'rank-text', 'rank-far', 'rank-far-back']
  );
  assert.deepEqual(
    items(a).map((item) => item.rank),
    [undefined, undefined, undefined, undefined]
  );
  assert.equal(items(a)[0].description, 'words of fine');
  assert.equal(items(a)[0].thumb, null, 'a thumbnail that is not a data URL was taken on');
  assert.notEqual(a.element('preview-img').src, 'https://tracker.test/pixel.png');
  // What JSON cannot carry, and storage therefore never hands over, is not
  // taken on either.
  for (const rank of [NaN, Infinity, -Infinity, '1', null, {}]) {
    assert.equal(a.R('readItem')(storedItem('odd', { rank })).rank, undefined, String(rank));
  }
  assert.equal(a.R('readItem')(storedItem('moved', { rank: 1_799_999_000_000.5 })).rank, 1_799_999_000_000.5);
  // Marking up (0.7.0): marks claimed only as true, and a file stamp only as
  // a moment not yet to come, which would outrank every later file the item
  // is given.
  for (const marked of ['yes', 1, 'true', {}, null, false]) {
    assert.equal(a.R('readItem')(storedItem('odd', { marked })).marked, undefined, String(marked));
  }
  assert.equal(a.R('readItem')(storedItem('marked', { marked: true })).marked, true);
  for (const fileAt of [-5, 0, 'x', null, {}, NaN, Infinity]) {
    assert.equal(a.R('readItem')(storedItem('odd', { fileAt })).fileAt, undefined, String(fileAt));
  }
  const now = a.R('Date').now();
  assert.equal(a.R('readItem')(storedItem('ahead', { fileAt: now + DAY })).fileAt, now);
  assert.equal(a.R('readItem')(storedItem('stamped', { fileAt: now - 5 })).fileAt, now - 5);
});

// SP6. The page toggle could not keep the host out of the prompt.
test('sheet: a screenshot is named without the page it was taken on', async () => {
  const { downloads, panels: [a] } = await world();
  await capture(a);
  const [name] = downloads.calls.download;
  assert.match(name, /^claude-punch-list\/\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d_screen\.png$/);
  assert.ok(!name.includes('example'));
});

// SP10. Nothing told an incognito tab apart.
test('sheet: an incognito tab is not captured', async () => {
  const storage = sharedStorage();
  const downloads = fakeDownloads();
  const a = await openPanel({
    storage,
    downloads,
    time: { now: 1_800_000_000_000 },
    tab: { id: 9, windowId: 3, url: 'https://example.test/', title: 'Example', incognito: true },
  });
  assert.match(a.banner() || '', /incognito/i);
  assert.equal(a.element('mode-visible').disabled, true);
  await capture(a);
  // The shortcut can arm the page without the panel; its drag still arrives.
  a.broadcast(
    { type: 'cdr:region-selected', rect: { x: 0, y: 0, width: 50, height: 50 }, viewport: { width: 1280, height: 720 } },
    { tab: { id: 9 } }
  );
  await a.flush();
  assert.equal(items(a).length, 0);
  assert.equal(downloads.calls.download.length, 0);
  assert.equal(storage.data.has('cdrReport'), false);
});

// SS8. A failed save moved the frame off the item being typed in.
test('sheet: a failed save of another item leaves the frame on the item being typed in', async () => {
  const { downloads, time, panels: [a] } = await world();
  await capture(a);
  time.now += 1000;
  downloads.next.push((record) => {
    record.state = 'in_progress';
    record.filename = '';
  });
  await capture(a);
  time.now += 1000;
  await capture(a);
  assert.equal(items(a).length, 3);
  const [first, saving, third] = items(a);
  assert.equal(saving.path, null);

  pickRow(a, 0);
  assert.equal(a.internals.state.selectedId, first.id);
  downloads.records.get(saving.downloadId ?? 2).state = 'interrupted';
  downloads.records.get(saving.downloadId ?? 2).error = 'USER_CANCELED';
  await a.clock.advance(200);
  await a.flush();

  assert.deepEqual(
    items(a).map((item) => item.id),
    [first.id, third.id]
  );
  assert.equal(a.internals.state.selectedId, first.id, 'the frame moved to another item');
  type(a, 'meant for the first item');
  assert.equal(first.description, 'meant for the first item');
  assert.equal(third.description, '');
});

// ------------------------------------------------------------------ files

// RO6. Chrome reissues download ids after a restart.
test('sheet: a discard deletes nothing when the stored id now names another file', async () => {
  const { downloads, panels: [a] } = await world({
    seed: ({ storage, downloads, time }) => {
      storage.data.set('cdrReport', {
        items: [storedItem('reissued', { downloadId: 5 }), storedItem('other-extension', { downloadId: 6, capturedAt: 1_799_999_000_001 })],
        updatedAt: time.now,
        writer: 'x',
      });
      // Id 5 went to someone's own download; id 6 names the file, but another extension made it.
      recordFor(downloads, 5, '/Users/you/Downloads/tax-return.pdf');
      recordFor(downloads, 6, `${DIR}other-extension.png`, { byExtensionId: 'another-extension' });
    },
  });
  a.click('discard-all');
  await a.clock.advance(UNDO_MS + 100);
  await a.flush();
  assert.equal(items(a).length, 0);
  assert.deepEqual(downloads.calls.removeFile, []);
  assert.deepEqual(downloads.calls.erase, []);
});

test('sheet: an id that names another file is not asked whether the file exists', async () => {
  const { panels: [a] } = await world({
    seed: ({ storage, downloads, time }) => {
      storage.data.set('cdrReport', { items: [storedItem('reissued', { downloadId: 5 })], updatedAt: time.now, writer: 'x' });
      recordFor(downloads, 5, '/Users/you/Downloads/old.zip', { exists: false });
    },
  });
  await a.flush();
  assert.equal(items(a)[0].missing, undefined, 'a deleted stranger marked this item missing');
  assert.equal(a.element('submit').disabled, false);
});

// RO7 and SS7. Checked once at startup, flag stored, advice that did not help.
test('sheet: a file deleted after startup holds the copy back, and the advice lifts it', async () => {
  const { storage, downloads, time, panels: [a] } = await world();
  await capture(a);
  time.now += 1000;
  await capture(a);
  const [first] = items(a);
  downloads.records.get(first.downloadId).exists = false;

  a.click('submit');
  await a.clock.advance(500);
  await settle(a);
  assert.equal(items(a).length, 2, 'the copy went ahead with a file that is gone');
  assert.equal(a.element('result').hidden, true);
  assert.equal(first.missing, true);
  const banner = a.banner() || '';
  assert.match(banner, /item 1/);
  assert.match(banner, /untick/i);
  assert.ok(!/capture it again/i.test(banner), 'the banner still gives advice that does not lift the block');
  assert.ok(!storedItems(storage).some((item) => 'missing' in item), 'the missing flag is stored');

  pickRow(a, 0);
  assert.equal(a.element('item-missing').hidden, false, 'the item does not say why it holds Copy back');

  tickRow(a, 0, false);
  assert.equal(a.element('submit').disabled, false, 'unticking the missing item did not lift the block');
  assert.equal(a.banner(), null);
});

test('sheet: a file Chrome no longer lists is copied with a note that it was not checked', async () => {
  const { downloads, panels: [a] } = await world();
  await capture(a);
  downloads.records.clear(); // the downloads list was cleared by hand
  a.click('submit');
  await a.clock.advance(500);
  await settle(a);
  assert.equal(a.element('result').hidden, false);
  assert.equal(a.element('result-note').hidden, false);
  assert.match(a.element('result-note').textContent, /file of item 1 in the copied prompt among its downloads/);
});

// F31 and F45, as in 0.6.0. A release candidate asked the disk itself, through
// file URLs, where Chrome allows file access. On a volume that stopped
// answering, its opens stayed blocked in Chrome, one per screenshot for each
// panel page, until Chrome's file threads ran out across the whole browser
// (W5-1). A file that would not open, in a folder Chrome listed as empty, was
// called missing for good (W5-2). A deletion in a large folder was still
// missed (W5-3). Chrome's download records alone say whether a screenshot is
// there, with file access or without.

/**
 * File access as Chrome gives it to an extension loaded unpacked, and a fetch
 * in a panel's realm that records every file URL asked. `answer(path)` is
 * what an open does: by default nothing, ever, as on a volume gone quiet.
 */
function fileAccess(answer = () => new Promise(() => {})) {
  const access = {
    asked: [],
    setup: (chrome) => {
      chrome.extension = { isAllowedFileSchemeAccess: async () => true };
    },
    // The panel's own fetch from its first line, so opens at load count.
    fetch: async (url) => {
      if (!String(url).startsWith('file:')) return { blob: async () => ({}) };
      access.asked.push(String(url));
      return answer(decodeURIComponent(String(url).slice('file://'.length)));
    },
    install(panel) {
      panel.document.visibilityState = 'visible';
      const global = panel.R('globalThis');
      const own = global.fetch;
      global.fetch = async (url, ...rest) => {
        if (!String(url).startsWith('file:')) return own(url, ...rest);
        access.asked.push(String(url));
        return answer(decodeURIComponent(String(url).slice('file://'.length)));
      };
    },
  };
  return access;
}

/** Chrome 156's page for a folder: start("<folder>"), then one addRow per entry. */
function listing(folder, names) {
  return `<script>start(${JSON.stringify(folder)});</script>\n${names.map((name) => `<script>addRow(${JSON.stringify(name)},"",0,1,"1 B",0,"");</script>\n`).join('')}`;
}

test('sheet: with file access, three panels over a sheet on a volume that does not answer open no file', async () => {
  const quiet = fileAccess();
  const stored = Array.from({ length: 300 }, (_, index) => storedItem(`quiet-${index}`, { downloadId: 100 + index, included: index === 0 }));
  const { storage, downloads, time, panels } = await world({
    panels: 3,
    setups: [quiet.setup, quiet.setup, quiet.setup],
    fetches: [quiet.fetch, quiet.fetch, quiet.fetch],
    seed: ({ storage, downloads, time }) => {
      storage.data.set('cdrReport', { items: stored, updatedAt: time.now, writer: 'x' });
      for (const item of stored) recordFor(downloads, item.downloadId, item.path);
    },
  });
  for (const panel of panels) quiet.install(panel);
  // A reopened panel is a new page, which checks at load: three more.
  for (let i = 0; i < 3; i += 1) {
    const again = await openPanel({ storage, downloads, time, tab: { id: 20 + i, windowId: 9 + i, url: 'https://example.test/', title: 'Example' }, setup: quiet.setup, fetch: quiet.fetch });
    await again.clock.advance(30_000);
    await settle(again);
  }
  // Each panel shown again three times, as a reopened panel or a window
  // brought back is, with time for every check to give up on the volume.
  for (let round = 0; round < 3; round += 1) {
    for (const panel of panels) {
      panel.documentEvent('visibilitychange');
      await panel.clock.advance(30_000);
      await settle(panel);
    }
  }
  const [a] = panels;
  a.click('submit');
  await a.clock.advance(500);
  await settle(...panels);
  assert.equal(a.element('result').hidden, false, 'the copy waited on a volume that does not answer');
  assert.equal(quiet.asked.length, 0, `${quiet.asked.length} file opens left waiting on the volume`);
});

test('sheet: with file access, a screenshot Chrome says is there is not called missing though it will not open and its folder lists empty', async () => {
  // As a file set to mode 000 in a folder set to 311 is seen in Chrome 156:
  // the file does not open, and the folder's first listing is empty.
  const shut = fileAccess((path) => {
    if (path.endsWith('/')) return { ok: false, status: 0, body: null, text: async () => listing(path, []) };
    throw new TypeError('Failed to fetch');
  });
  const { panels: [a] } = await world({ setups: [shut.setup] });
  shut.install(a);
  await capture(a);
  for (let round = 0; round < 3; round += 1) {
    a.documentEvent('visibilitychange');
    await a.clock.advance(3000);
    await settle(a);
    assert.ok(!items(a)[0].missing, `a file Chrome says is there was called missing, check ${round + 1}`);
  }
  a.click('submit');
  await a.clock.advance(500);
  await settle(a);
  assert.equal(a.element('result').hidden, false, 'a file Chrome says is there held the copy back');
  assert.deepEqual(shut.asked, []);
});

test('sheet: with file access or without, a file deleted just before Copy is for Chrome to report', async () => {
  for (const allowed of [false, true]) {
    const disk = new Set();
    const access = fileAccess((path) => {
      if (path === DIR) return { ok: false, status: 0, body: null, text: async () => listing(DIR, [...disk].map((file) => file.slice(DIR.length))) };
      if (disk.has(path)) return { ok: true, status: 200, body: { cancel: async () => {} } };
      throw new TypeError('Failed to fetch');
    });
    const { downloads, time, panels: [a] } = await world({ setups: [allowed ? access.setup : () => {}] });
    access.install(a);
    // Two captures in one second get names of their own, as Chrome gives them.
    const download = downloads.api.download;
    downloads.api.download = async (options) => {
      const id = await download(options);
      const record = downloads.records.get(id);
      record.filename = record.filename.replace(/\.png$/, ` (${id}).png`);
      return id;
    };
    await capture(a);
    time.now += 1000;
    await capture(a);
    const [first, second] = items(a);
    assert.notEqual(first.path, second.path);
    for (const item of items(a)) disk.add(item.path);
    // Deleted a moment ago, in a folder of any size: Chrome's record still
    // says it is there, as it does until Chrome next looks.
    disk.delete(second.path);
    a.click('submit');
    await a.clock.advance(500);
    await settle(a);
    const which = allowed ? 'with file access' : 'without file access';
    assert.equal(a.element('result').hidden, false, `held back ${which}`);
    assert.equal(a.element('result-note').hidden, true, which);
    // Chrome's own look finds it gone: the receipt says so.
    downloads.records.get(second.downloadId).exists = false;
    for (const fn of downloads.listeners) fn({ id: second.downloadId, exists: { previous: true, current: false } });
    await settle(a);
    assert.match(a.element('result-note').textContent, /screenshot of item 2 in the copied prompt gone from disk/, which);
    assert.deepEqual(access.asked, [], which);
  }
});

test('sheet: a missing flag stored by an older build is asked again', async () => {
  const { panels: [a] } = await world({
    seed: ({ storage, downloads, time }) => {
      storage.data.set('cdrReport', { items: [storedItem('back', { downloadId: 3, missing: true })], updatedAt: time.now, writer: 'x' });
      recordFor(downloads, 3, `${DIR}back.png`);
    },
  });
  await a.flush();
  assert.ok(!items(a)[0].missing);
  assert.equal(a.element('submit').disabled, false);
});

// UX2. Discard all deleted every sentence and file on one click.
test('sheet: a discard can be undone, and its files go only once the undo lapses', async () => {
  const { storage, downloads, time, panels: [a] } = await world();
  await capture(a);
  type(a, 'one');
  time.now += 1000;
  await capture(a);
  type(a, 'two');
  const ids = items(a).map((item) => item.downloadId);

  a.click('discard-all');
  assert.equal(items(a).length, 0);
  assert.deepEqual(downloads.calls.removeFile, [], 'the files went before the undo could be used');
  const undo = a.element('undo');
  assert.match(undo.children.map((node) => node.textContent).join(' '), /2 items discarded/);
  undo.children[1].dispatch('click');
  await settle(a);
  assert.deepEqual(sentences(a), ['one', 'two']);
  assert.equal(storedItems(storage).length, 2);

  pickRow(a, 0);
  a.click('preview-clear');
  assert.deepEqual(sentences(a), ['two']);
  await a.clock.advance(UNDO_MS - 100);
  assert.deepEqual(downloads.calls.removeFile, []);
  await a.clock.advance(200);
  await a.flush();
  assert.deepEqual(downloads.calls.removeFile, [ids[0]]);
  assert.deepEqual(downloads.calls.erase, [ids[0]]);
  assert.equal(a.element('undo').children.length, 0);
});

test('sheet: Discard all sits with the sheet, away from Clear collected log', () => {
  const html = readFileSync(new URL('../sidepanel/panel.html', import.meta.url), 'utf8');
  const footer = html.slice(html.indexOf('<footer'));
  assert.ok(!footer.includes('id="discard-all"'), 'Discard all is still in the footer');
  const sheet = html.slice(html.indexOf('id="sheet"'), html.indexOf('id="list"'));
  assert.ok(sheet.includes('id="discard-all"'));
});

test('sheet: a panel closed before the undo lapses still deletes the discarded file', async () => {
  const { downloads, panels: [a] } = await world();
  await capture(a);
  const id = items(a)[0].downloadId;
  a.click('preview-clear');
  await a.flush();
  a.R('flushOnClose')();
  assert.ok(downloads.calls.removeFile.includes(id));
  assert.ok(downloads.calls.erase.includes(id));
});

// RO9. After a blocked clipboard, clearing the sheet deleted the files.
test('sheet: after a blocked clipboard the copied items can be cleared without deleting their files', async () => {
  const { downloads, time, panels: [a] } = await world();
  a.R('document').execCommand = () => false;
  await capture(a);
  time.now += 1000;
  await capture(a);
  a.click('submit');
  await a.clock.advance(500);
  await settle(a);
  assert.match(a.element('result-text').textContent, /blocked/);
  assert.equal(items(a).length, 2, 'a blocked copy should leave the sheet');
  assert.equal(a.element('clear-copied').hidden, false);

  a.click('clear-copied');
  await settle(a);
  assert.equal(items(a).length, 0);
  await a.clock.advance(UNDO_MS + 100);
  assert.deepEqual(downloads.calls.removeFile, []);
});

test('sheet: Copy again that reaches the clipboard after a blocked copy clears those items', async () => {
  const { panels: [a] } = await world();
  const doc = a.R('document');
  doc.execCommand = () => false;
  await capture(a);
  a.click('submit');
  await a.clock.advance(500);
  await settle(a);
  assert.equal(items(a).length, 1);
  doc.execCommand = () => true;
  a.click('copy-again');
  await settle(a);
  assert.equal(items(a).length, 0);
});

/**
 * Make focus() move the panel's document.activeElement, as it does in Chrome;
 * the realm's elements ignore it. Returns the undo of that.
 */
function trackFocus(panel) {
  const doc = panel.R('document');
  const proto = Object.getPrototypeOf(panel.element('description'));
  const original = proto.focus;
  proto.focus = function () {
    doc.activeElement = this;
  };
  return () => (proto.focus = original);
}

/** Cmd/Ctrl+Z through the panel's keydown listeners; whether one took it. */
function undoKey(panel, modifier = { ctrlKey: true }) {
  let taken = false;
  panel.documentEvent('keydown', {
    key: 'z',
    isComposing: false,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...modifier,
    preventDefault() {
      taken = true;
    },
  });
  return taken;
}

function undoLine(panel) {
  return panel
    .element('undo')
    .children.map((node) => node.textContent)
    .join(' ');
}

// Verification of UX2: the shortcut skipped the field, and every discard that
// leaves an item puts focus there.
test('sheet: Cmd/Ctrl+Z undoes a discard while the field holds what the discard left there', async () => {
  const { time, panels: [a] } = await world();
  const restore = trackFocus(a);
  try {
    await capture(a);
    type(a, 'one');
    time.now += 1000;
    await capture(a);
    type(a, 'two');
    time.now += 1000;
    await capture(a);
    type(a, 'three');

    a.click('preview-clear');
    assert.equal(a.R('document').activeElement, a.element('description'));
    assert.equal(a.element('description').value, 'two');
    assert.equal(undoKey(a, { ctrlKey: true }), true, 'Ctrl+Z in the untouched field was left to the field');
    assert.deepEqual(sentences(a), ['one', 'two', 'three']);

    // Typed into since: the key is the field's, even with the words put back.
    a.click('preview-clear');
    type(a, 'two!');
    type(a, 'two');
    assert.equal(undoKey(a, { metaKey: true }), false, 'Cmd+Z took typing back as a discard');
    assert.deepEqual(sentences(a), ['one', 'two']);

    // Another item's words in the field: not what the discard left there.
    a.element('undo').children[1].dispatch('click');
    a.click('preview-clear');
    pickRow(a, 0);
    a.R('document').activeElement = a.element('description');
    assert.equal(undoKey(a, { ctrlKey: true }), false);
    // Away from the field the key still undoes it.
    a.R('document').activeElement = null;
    assert.equal(undoKey(a, { ctrlKey: true }), true);
    assert.equal(items(a).length, 3);
  } finally {
    restore();
  }
});

test('sheet: the undo waits while the pointer or the keyboard is on it, and starts over when they leave', async () => {
  const { downloads, time, panels: [a] } = await world();
  const restore = trackFocus(a);
  try {
    await capture(a);
    time.now += 1000;
    await capture(a);
    const gone = items(a)[1].downloadId;
    a.click('preview-clear');
    const line = a.element('undo');
    const button = line.children[1];

    button.focus();
    line.dispatch('focusin', { target: button });
    await a.clock.advance(UNDO_MS * 3);
    assert.deepEqual(downloads.calls.removeFile, [], 'the files went while Undo had focus');
    assert.match(undoLine(a), /Item 2 discarded/);
    assert.equal(a.R('document').activeElement, button);

    line.dispatch('focusout', { target: button });
    a.R('document').activeElement = null;
    await a.clock.advance(UNDO_MS - 100);
    assert.deepEqual(downloads.calls.removeFile, []);
    line.dispatch('mouseenter');
    await a.clock.advance(UNDO_MS * 3);
    assert.deepEqual(downloads.calls.removeFile, [], 'the files went under the pointer');
    line.dispatch('mouseleave');
    await a.clock.advance(UNDO_MS - 100);
    assert.deepEqual(downloads.calls.removeFile, [], 'leaving did not give the full time again');
    await a.clock.advance(200);
    await settle(a);
    assert.deepEqual(downloads.calls.removeFile, [gone]);
    assert.equal(undoLine(a), '');
  } finally {
    restore();
  }
});

test('sheet: when the undo line goes from under the keyboard, focus stays in the panel', async () => {
  const { time, panels: [a] } = await world();
  const restore = trackFocus(a);
  try {
    await capture(a);
    time.now += 1000;
    await capture(a);
    a.click('preview-clear');
    const button = a.element('undo').children[1];
    button.focus();
    a.R('settleTrash')();
    const doc = a.R('document');
    assert.notEqual(doc.activeElement, button, 'focus was left on a button no longer in the page');
    assert.equal(doc.activeElement, a.element('description'));
  } finally {
    restore();
  }
});

/**
 * Chrome takes the focus off a control once it is disabled and leaves it on
 * the body: seen in Chrome 156 for Copy, pressed with a real click in a side
 * panel, in every copy, since Copy is disabled while it works.
 */
function dropFocusWhenDisabled(panel, id) {
  const doc = panel.R('document');
  const node = panel.element(id);
  let disabled = node.disabled;
  Object.defineProperty(node, 'disabled', {
    configurable: true,
    get: () => disabled,
    set(value) {
      disabled = Boolean(value);
      if (disabled && doc.activeElement === node) doc.activeElement = doc.body;
    },
  });
}

// F58. After a copy held back by a missing file, focus was on the body.
test('sheet: Copy held back by a missing file hands the keyboard to that item\'s tick', async () => {
  const { downloads, time, panels: [a] } = await world();
  const restore = trackFocus(a);
  try {
    dropFocusWhenDisabled(a, 'submit');
    await capture(a);
    time.now += 1000;
    await capture(a);
    const [, second] = items(a);
    downloads.records.get(second.downloadId).exists = false;
    a.element('submit').focus();
    a.click('submit');
    await a.clock.advance(500);
    await settle(a);
    assert.equal(second.missing, true);
    assert.equal(a.element('submit').disabled, true);
    const tick = rowAt(a, 1).children[0].children[0];
    assert.equal(a.R('document').activeElement, tick, 'focus was left on the body');
  } finally {
    restore();
  }
});

test('sheet: after a copy Copy keeps the keyboard, and once the sheet is empty Copy again has it', async () => {
  const { time, panels: [a] } = await world();
  const restore = trackFocus(a);
  try {
    dropFocusWhenDisabled(a, 'submit');
    const doc = a.R('document');
    await capture(a);
    time.now += 1000;
    await capture(a);
    // Item 1 is left out of this copy, and ticked for the next.
    tickRow(a, 0, false);
    a.element('submit').focus();
    a.click('submit');
    await a.clock.advance(500);
    await settle(a);
    assert.equal(items(a).length, 1);
    assert.equal(a.element('submit').disabled, false);
    assert.equal(doc.activeElement, a.element('submit'), 'focus was left on the body');

    a.click('submit');
    await a.clock.advance(500);
    await settle(a);
    assert.equal(items(a).length, 0);
    assert.equal(a.element('result').hidden, false);
    assert.equal(doc.activeElement, a.element('copy-again'), 'focus was left on the body');

    // Put somewhere else by the user while the copy worked: left there.
    await capture(a);
    a.element('submit').focus();
    a.click('submit');
    a.element('description').focus();
    await a.clock.advance(500);
    await settle(a);
    assert.equal(doc.activeElement, a.element('description'));
  } finally {
    restore();
  }
});

/** Cmd+Enter through the panel's keydown listeners, as pressed in the field. */
function copyKey(panel) {
  panel.documentEvent('keydown', {
    key: 'Enter',
    isComposing: false,
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault() {},
  });
}

// V5-5 (F58). Cmd+Enter in the field copied, the emptied sheet hid the field,
// and the keyboard was left on the body, as it was after Copy before F58.
test('sheet: Cmd+Enter in the field that empties the sheet hands the keyboard to Copy again', async () => {
  for (const when of ['a moment later', 'at once']) {
    const { time, panels: [a] } = await world();
    const restore = trackFocus(a);
    try {
      dropFocusWhenDisabled(a, 'submit');
      const doc = a.R('document');
      const field = a.element('description');
      const section = a.element('item');
      // Chrome takes the focus off a control once it is hidden, in a task of
      // its own after the next style update: until then the hidden field is
      // still the active element. Seen both ways, the copy must not care.
      field.checkVisibility = () => !section.hidden;
      let hidden = section.hidden;
      Object.defineProperty(section, 'hidden', {
        configurable: true,
        get: () => hidden,
        set(value) {
          hidden = Boolean(value);
          if (hidden && when === 'at once' && doc.activeElement === field) doc.activeElement = doc.body;
        },
      });
      await capture(a);
      time.now += 1000;
      await capture(a);
      field.focus();
      copyKey(a);
      await a.clock.advance(500);
      await settle(a);
      assert.equal(items(a).length, 0);
      assert.equal(a.element('result').hidden, false);
      assert.equal(doc.activeElement, a.element('copy-again'), `the keyboard was lost with the field hidden ${when}`);

      // A copy that leaves an item keeps the field shown, and the keyboard in it.
      await capture(a);
      time.now += 1000;
      await capture(a);
      tickRow(a, 0, false);
      field.focus();
      copyKey(a);
      await a.clock.advance(500);
      await settle(a);
      assert.equal(items(a).length, 1);
      assert.equal(section.hidden, false);
      assert.equal(doc.activeElement, field, 'the keyboard was taken out of the field');
    } finally {
      restore();
    }
  }
});

// Verification of UX2: a save that failed in the trash came back as SAVING.
test('sheet: an item whose save fails while discarded leaves the discard, and no SAVING row comes back', async () => {
  const { downloads, time, panels: [a] } = await world();
  await capture(a);
  time.now += 1000;
  let record = null;
  downloads.next.push((shape) => {
    shape.state = 'in_progress';
    shape.filename = '';
    record = shape;
  });
  await capture(a);
  assert.equal(items(a)[1].path, null);

  a.click('discard-all');
  assert.match(undoLine(a), /2 items discarded/);
  record.state = 'interrupted';
  record.error = 'USER_CANCELED';
  await a.clock.advance(200);
  await settle(a);
  assert.match(undoLine(a), /Item 1 discarded/);
  a.element('undo').children[1].dispatch('click');
  await settle(a);
  assert.equal(items(a).length, 1);
  assert.ok(items(a)[0].path, 'an item with no file came back');
  assert.equal(a.element('submit').disabled, false);

  // Alone in the discard, it takes the undo line with it.
  downloads.next.push((shape) => {
    shape.state = 'in_progress';
    shape.filename = '';
    record = shape;
  });
  time.now += 1000;
  await capture(a);
  a.click('preview-clear');
  record.state = 'interrupted';
  record.error = 'USER_CANCELED';
  await a.clock.advance(200);
  await settle(a);
  assert.equal(undoLine(a), '');
  assert.equal(undoKey(a), false);
  assert.equal(items(a).length, 1);
  assert.ok(items(a).every((item) => item.path));
});

// Verification of RO9: Discard all and Undo took Clear these items away.
test('sheet: Discard all taken back during a hand copy brings back Clear these items', async () => {
  const { downloads, time, panels: [a] } = await world();
  a.R('document').execCommand = () => false;
  await capture(a);
  time.now += 1000;
  await capture(a);
  a.click('submit');
  await a.clock.advance(500);
  await settle(a);
  assert.equal(a.element('clear-copied').hidden, false);
  const proof = a.element('prompt-preview').hidden;

  a.click('discard-all');
  assert.equal(a.element('result').hidden, true);
  a.element('undo').children[1].dispatch('click');
  await settle(a);
  assert.equal(items(a).length, 2);
  assert.equal(a.element('result').hidden, false, 'the receipt of the hand copy did not come back');
  assert.equal(a.element('clear-copied').hidden, false);
  assert.equal(a.element('prompt-preview').hidden, proof);

  a.click('clear-copied');
  await settle(a);
  assert.equal(items(a).length, 0);
  await a.clock.advance(UNDO_MS + 100);
  assert.deepEqual(downloads.calls.removeFile, [], 'the files the hand copied prompt names were deleted');
});

test('sheet: a receipt a newer copy replaced is not brought back by an undo', async () => {
  const { time, panels: [a] } = await world();
  const doc = a.R('document');
  doc.execCommand = () => false;
  await capture(a);
  a.click('submit');
  await a.clock.advance(500);
  await settle(a);
  a.click('discard-all');
  assert.equal(items(a).length, 0);
  time.now += 1000;
  await capture(a);
  doc.execCommand = () => true;
  a.click('submit');
  await a.clock.advance(500);
  await settle(a);
  const receipt = a.element('result-text').textContent;
  a.element('undo').children[1]?.dispatch('click');
  await settle(a);
  assert.equal(a.element('result-text').textContent, receipt);
  assert.equal(a.element('clear-copied').hidden, true);
});

// Verification of RO7: every copy waited a fixed 120 ms for an answer that a
// fresh deletion does not produce anyway.
test('sheet: Copy waits for the page read and no timer, and asks about the files alongside it', async () => {
  const answers = [];
  const { downloads, panels: [a] } = await world({
    setups: [(chrome) => (chrome.tabs.sendMessage = () => new Promise((resolve) => answers.push(resolve)))],
  });
  await capture(a);
  answers.splice(0).forEach((answer) => answer(null));
  await settle(a);
  const asked = [];
  const search = downloads.api.search;
  downloads.api.search = async (query) => {
    asked.push(query.id);
    return search(query);
  };

  a.click('submit');
  await settle(a);
  assert.ok(asked.includes(items(a)[0].downloadId), 'the file was not asked about while the page was read');
  assert.equal(a.element('result').hidden, true, 'copied before the page answered');
  answers.splice(0).forEach((answer) => answer(null));
  await settle(a);
  assert.equal(a.element('result').hidden, false, 'the copy waited on a timer after the read');
  assert.equal(items(a).length, 0);
});

// With no wait after the read, Chrome's answer has to count the moment it
// comes: asking whether the id is still the item's cost a round trip, and in
// Chrome the prompt reached the clipboard in that time.
test('sheet: Chrome reporting a file gone during the page read holds the copy back', async () => {
  const answers = [];
  let onSearch = null;
  const { downloads, time, panels: [a] } = await world({
    setups: [
      (chrome) => {
        chrome.tabs.sendMessage = () => new Promise((resolve) => answers.push(resolve));
        const search = chrome.downloads.search;
        // Chrome answers each call a task later.
        chrome.downloads.search = (query) => {
          const result = search(query);
          onSearch?.(query);
          return new Promise((resolve) => setImmediate(() => resolve(result)));
        };
      },
    ],
  });
  await capture(a);
  time.now += 1000;
  await capture(a);
  answers.splice(0).forEach((answer) => answer(null));
  await settle(a);
  const [first] = items(a);
  // The copy's ask makes Chrome look at the disk. Its answer comes two tasks
  // later, in the same task as the page's.
  onSearch = (query) => {
    if (query.id !== first.downloadId) return;
    onSearch = null;
    setImmediate(() =>
      setImmediate(() => {
        downloads.records.get(first.downloadId).exists = false;
        for (const fn of downloads.listeners) fn({ id: first.downloadId, exists: { previous: true, current: false } });
        answers.splice(0).forEach((answer) => answer(null));
      })
    );
  };
  a.click('submit');
  await settle(a);
  assert.equal(a.internals.state.busy, false, 'the copy is still waiting');
  assert.equal(a.element('result').hidden, true, 'the prompt went out naming a file Chrome had just reported gone');
  assert.equal(first.missing, true);
  assert.equal(items(a).length, 2);
});

/**
 * A panel whose tab in view can be made one Chrome keeps extensions out of,
 * and whose downloads report a file gone `after` ms (on the panel's clock)
 * after the copy's ask about it, as Chrome does through onChanged.
 */
async function restrictedWorld({ after }) {
  const tab = { restricted: false };
  const world_ = await world({
    setups: [
      (chrome) => {
        const send = chrome.runtime.sendMessage;
        chrome.runtime.sendMessage = (message) =>
          message.type === 'cdr:check-tab' && tab.restricted
            ? Promise.resolve({ ok: true, restriction: 'This page is closed to extensions.', armedMode: null, armId: null })
            : send(message);
      },
    ],
  });
  const { downloads, time, panels: [a] } = world_;
  await capture(a);
  time.now += 1000;
  await capture(a);
  await settle(a);
  tab.restricted = true;
  await a.internals.resolveTab();
  await settle(a);
  assert.match(a.banner() || '', /closed to extensions/);
  const [first] = items(a);
  const search = downloads.api.search;
  downloads.api.search = async (query) => {
    const result = await search(query);
    if (query.id === first.downloadId && downloads.records.get(first.downloadId).exists) {
      a.clock.setTimeout(() => {
        downloads.records.get(first.downloadId).exists = false;
        for (const fn of downloads.listeners) fn({ id: first.downloadId, exists: { previous: true, current: false } });
      }, after);
    }
    return result;
  };
  return { ...world_, a, first };
}

// Medium in verify R1: with a restricted tab in view the read is back at
// once, before Chrome's answer, and the prompt went out naming a file Chrome
// reported gone a few milliseconds later; a FILE MISSING banner then sat over
// the emptied sheet beside 'Copied'.
test('sheet: a copy with no page to read waits for Chrome to report a file gone', async () => {
  const { a, first } = await restrictedWorld({ after: 27 });
  a.click('submit');
  await settle(a);
  assert.equal(a.element('result').hidden, true, 'copied before Chrome could answer');
  await a.clock.advance(500);
  await settle(a);
  assert.equal(a.element('result').hidden, true, 'the prompt went out naming a file Chrome had just reported gone');
  assert.equal(a.internals.state.lastPrompt, '');
  assert.equal(first.missing, true);
  assert.equal(items(a).length, 2);
  assert.match(a.banner() || '', /item 1 on the sheet is no longer on disk/);
});

test('sheet: a copy with no page to read still goes once Chrome has had its time', async () => {
  const { a } = await restrictedWorld({ after: 10_000 });
  a.click('submit');
  await a.clock.advance(149);
  await settle(a);
  assert.equal(a.element('result').hidden, true);
  await a.clock.advance(2);
  await settle(a);
  assert.equal(a.element('result').hidden, false, 'the wait has no end');
  assert.equal(items(a).length, 0);
});

// F57. Copy took the banner down as it started, and on a restricted tab the
// restriction stayed away until the next tab event.
test('sheet: on a tab the panel may not capture, the restriction stays up through a copy', async () => {
  const { a } = await restrictedWorld({ after: 10_000 });
  a.click('submit');
  await a.clock.advance(500);
  await settle(a);
  assert.equal(a.element('result').hidden, false);
  assert.match(a.banner() || '', /closed to extensions/, 'the copy took the restriction down');
});

test('sheet: on a tab the panel may not capture, the restriction comes back once a missing file is dealt with', async () => {
  const { a } = await restrictedWorld({ after: 27 });
  a.click('submit');
  await a.clock.advance(500);
  await settle(a);
  assert.match(a.banner() || '', /item 1 on the sheet is no longer on disk/);
  tickRow(a, 0, false);
  assert.match(a.banner() || '', /closed to extensions/, 'the restriction stayed away with the missing file\'s banner');
  assert.equal(a.element('banner-live').getAttribute('aria-live'), 'assertive');
});

// The same answer can land while the clipboard is written, after the prompt
// was settled, when the page read is quicker than Chrome's look at the disk.
test('sheet: a file reported gone during the copy leaves no banner over the emptied sheet, and the receipt says it', async () => {
  let writing = null;
  const { downloads, time, panels: [a] } = await world();
  await capture(a);
  time.now += 1000;
  await capture(a);
  await settle(a);
  const [first] = items(a);
  a.R('globalThis').navigator = {
    clipboard: { writeText: () => new Promise((resolve) => (writing = resolve)) },
  };
  a.click('submit');
  await settle(a);
  assert.ok(writing, 'the clipboard was never written');
  downloads.records.get(first.downloadId).exists = false;
  for (const fn of downloads.listeners) fn({ id: first.downloadId, exists: { previous: true, current: false } });
  writing();
  await settle(a);
  assert.equal(items(a).length, 0);
  assert.equal(a.banner(), null, 'a banner about an item no longer on the sheet');
  assert.equal(a.element('result-note').hidden, false);
  assert.match(a.element('result-note').textContent, /screenshot of item 1 in the copied prompt gone from disk/);
});

test('sheet: a file reported gone just after the copy is said on the receipt, and one deleted later is not', async () => {
  const { downloads, time, panels: [a] } = await world();
  await capture(a);
  time.now += 1000;
  await capture(a);
  await settle(a);
  const [first, second] = items(a);
  a.click('submit');
  await a.clock.advance(500);
  await settle(a);
  assert.equal(items(a).length, 0);
  assert.equal(a.element('result-note').hidden, true);
  const gone = (item) => {
    downloads.records.get(item.downloadId).exists = false;
    for (const fn of downloads.listeners) fn({ id: item.downloadId, exists: { previous: true, current: false } });
  };
  gone(first);
  await settle(a);
  assert.equal(a.banner(), null);
  assert.equal(a.element('result-note').textContent.match(/screenshot of item 1 in the copied prompt gone from disk/)?.length, 1);
  // Deleted by the user once the prompt was pasted: not "as it was copied".
  time.now += 60_000;
  gone(second);
  await settle(a);
  assert.doesNotMatch(a.element('result-note').textContent, /item 2|items 1, 2/);
});

// Low in verify T1: an answer about the copied item 1 and the item 2 left on
// the sheet came after the receipt. The receipt said item 1, by the prompt,
// and the banner said item 1, by the sheet as now numbered, about another
// item, with nothing to tell the two apart.
test('sheet: after a late answer the receipt numbers by the copied prompt and the banner by the sheet, and each says so', async () => {
  const { downloads, time, panels: [a] } = await world();
  for (let i = 0; i < 3; i += 1) {
    await capture(a);
    time.now += 1000;
  }
  const [first, second] = items(a);
  tickRow(a, 1, false);
  a.click('submit');
  await a.clock.advance(500);
  await settle(a);
  assert.deepEqual(items(a), [second]);
  for (const item of [first, second]) {
    downloads.records.get(item.downloadId).exists = false;
    for (const fn of downloads.listeners) fn({ id: item.downloadId, exists: { previous: true, current: false } });
  }
  await settle(a);
  assert.equal(second.missing, true);
  assert.equal(
    a.element('result-note').textContent,
    'Chrome reported the screenshot of item 1 in the copied prompt gone from disk as the prompt was copied, ' +
      'so the prompt names a file no longer there.'
  );
  assert.equal(
    a.banner(),
    'The screenshot for item 1 on the sheet is no longer on disk. Untick or discard it to copy the rest.'
  );
});

// Verification of RO9 and UX2: an item discarded while Copy read the page was
// in the prompt, and its file was deleted when the undo lapsed.
test('sheet: an item discarded while Copy reads the page is left out of the prompt', async () => {
  const answers = [];
  const { downloads, time, panels: [a] } = await world({
    setups: [(chrome) => (chrome.tabs.sendMessage = () => new Promise((resolve) => answers.push(resolve)))],
  });
  for (const words of ['one', 'two', 'three']) {
    await capture(a);
    type(a, words);
    time.now += 1000;
  }
  answers.splice(0).forEach((answer) => answer(null));
  await settle(a);
  const [first, second, third] = items(a);
  const realm = a.R('globalThis');
  const assemble = realm.assembleReport;
  let report = null;
  realm.assembleReport = (...args) => (report = assemble(...args));

  pickRow(a, 1);
  a.click('submit');
  await a.flush();
  a.click('preview-clear'); // item 2, while the page has not answered
  answers.splice(0).forEach((answer) => answer(null));
  await a.clock.advance(500);
  await settle(a);
  assert.ok(report, 'Copy did not assemble a report');
  assert.deepEqual(
    [...report.items].map((item) => [item.number, item.description]),
    [
      [1, 'one'],
      [2, 'three'],
    ]
  );
  assert.equal(a.element('result-path').textContent, `2 screenshots in ${DIR}`);
  assert.equal(items(a).length, 0);

  // Its file goes when the undo lapses, and no prompt names it.
  await a.clock.advance(UNDO_MS + 100);
  await settle(a);
  assert.deepEqual(downloads.calls.removeFile, [second.downloadId]);
  assert.ok(![first, third].some((item) => downloads.calls.removeFile.includes(item.downloadId)));
});

// RO10. Files left behind by the weekly expiry and by a panel closed mid save.
test('sheet: the weekly expiry deletes the files of the sheet it drops', async () => {
  const { storage, downloads } = await world({
    seed: ({ storage, downloads, time }) => {
      storage.data.set('cdrReport', { items: [storedItem('stale', { downloadId: 4 })], updatedAt: time.now - 8 * DAY, writer: 'x' });
      recordFor(downloads, 4, `${DIR}stale.png`);
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(storage.data.has('cdrReport'), false);
  assert.deepEqual(downloads.calls.removeFile, [4]);
});

test('sheet: the weekly expiry leaves a sheet another open panel is showing', async () => {
  const { storage, downloads, panels: [a] } = await world({
    seed: ({ storage, downloads, time }) => {
      storage.data.set('cdrReport', { items: [storedItem('in-view', { downloadId: 4 })], updatedAt: time.now - 8 * DAY, writer: 'x' });
      recordFor(downloads, 4, `${DIR}in-view.png`);
    },
    setups: [
      (chrome) => {
        const page = 'chrome-extension://abc/sidepanel/panel.html';
        chrome.runtime.getURL = (path) => `chrome-extension://abc/${path}`;
        chrome.runtime.getContexts = async () => [
          { contextType: 'SIDE_PANEL', documentUrl: page },
          { contextType: 'SIDE_PANEL', documentUrl: page },
        ];
      },
    ],
  });
  assert.deepEqual(sentences(a), ['words of in-view']);
  assert.equal(storage.data.has('cdrReport'), true);
  assert.deepEqual(downloads.calls.removeFile, []);
});

test('sheet: a panel closed while a save waits takes the download back', async () => {
  const { downloads, panels: [a] } = await world();
  downloads.next.push((record) => {
    record.state = 'in_progress';
    record.filename = '';
  });
  await capture(a);
  const [item] = items(a);
  assert.equal(item.path, null);
  a.R('flushOnClose')();
  assert.ok(downloads.calls.cancel.includes(1), 'the download was left running');
  assert.ok(downloads.calls.erase.includes(1));
});

// ---------------------------------------------------------------- the frame

// RO11. The element chip showed the "could not read" dash for no items.
test('sheet: the element chip says 0 when no item was picked', async () => {
  const { panels: [a] } = await world();
  await capture(a);
  assert.equal(a.element('count-element').textContent, '0');
});

test('sheet: coming back to the panel reads the chips again, at most once a second', async () => {
  let reads = 0;
  const { time, panels: [a] } = await world({
    setups: [
      (chrome) => {
        chrome.tabs.sendMessage = async () => {
          reads += 1;
          return { collected: { console: [{}, {}], warnings: [], errors: [], network: [] }, page: null };
        };
      },
    ],
  });
  const before = reads;
  time.now += 5000;
  a.R('refreshChips')();
  a.R('refreshChips')();
  await a.flush();
  assert.equal(reads - before, 1);
  assert.equal(a.element('count-console').textContent, '2');
});

// UX8. After a partial copy the rows left over stayed unticked.
test('sheet: what a partial copy left out is ticked for the next one', async () => {
  const { time, panels: [a] } = await world();
  await capture(a);
  time.now += 1000;
  await capture(a);
  tickRow(a, 0, false);
  const left = items(a)[0];
  a.click('submit');
  await a.clock.advance(500);
  await settle(a);
  assert.deepEqual(items(a), [left]);
  assert.equal(left.included, true);
  assert.equal(a.element('submit').disabled, false);
});

// UX9. The receipt sat under the next sheet.
test('sheet: the receipt goes when the next item arrives', async () => {
  const { panels: [a] } = await world();
  await capture(a);
  a.click('submit');
  await a.clock.advance(500);
  await settle(a);
  assert.equal(a.element('result').hidden, false);
  await capture(a);
  assert.equal(a.element('result').hidden, true);
});

// ------------------------------------------------------- the order of the sheet

// REVIEW lead 8 and proposal 11 had the order as the stored array: an array
// move and persist(). Since SS4 every panel sorts what it adopts by capture
// time, at every open too, so such a move came back undone; the place has to
// be stored with the item and merged like the tick.

/** Captures, each typed into, a second apart: the sheet reads as its sentences. */
async function captures(panel, time, words = ['one', 'two', 'three']) {
  for (const word of words) {
    time.now += 1000;
    await capture(panel);
    type(panel, word);
  }
}

/** Alt+Up or Alt+Down with the keyboard on row `index`; whether a listener took it. */
function moveKey(panel, index, key) {
  panel.R('document').activeElement = rowAt(panel, index).children[1];
  let taken = false;
  panel.documentEvent('keydown', {
    key,
    altKey: true,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    isComposing: false,
    preventDefault() {
      taken = true;
    },
  });
  return taken;
}

function storedSentences(storage) {
  return storedItems(storage).map((item) => item.description);
}

test('sheet: a row moved with the keys keeps its place when the panel opens again', async () => {
  const { storage, downloads, time, panels: [a] } = await world();
  await captures(a, time);
  time.now += 1000;
  assert.equal(moveKey(a, 2, 'ArrowUp'), true);
  assert.equal(moveKey(a, 1, 'ArrowUp'), true);
  await settle(a);
  assert.deepEqual(sentences(a), ['three', 'one', 'two']);
  assert.deepEqual(storedSentences(storage), ['three', 'one', 'two']);
  // Only the moved item carries a place; the rest stand at their times, as
  // every item of a sheet stored by 0.6.1 does.
  assert.deepEqual(
    storedItems(storage).map((item) => 'rank' in item),
    [true, false, false]
  );
  const reopened = await openPanel({ storage, downloads, time });
  assert.deepEqual(sentences(reopened), ['three', 'one', 'two'], 'the reopened panel went back to capture order');
});

test('sheet: another window follows a move', async () => {
  const { time, panels: [a, b] } = await world({ panels: 2 });
  await captures(a, time);
  await settle(a, b);
  time.now += 1000;
  moveKey(a, 0, 'ArrowDown');
  await settle(a, b);
  assert.deepEqual(sentences(a), ['two', 'one', 'three']);
  assert.deepEqual(sentences(b), ['two', 'one', 'three'], 'the other window kept capture order');
});

test('sheet: a move that crosses a capture in another window leaves one order everywhere, the capture last', async () => {
  const { storage, time, panels: [a, b] } = await world({ panels: 2 });
  await captures(a, time);
  await settle(a, b);
  storage.hold();
  time.now += 1000;
  moveKey(a, 2, 'ArrowUp');
  moveKey(a, 1, 'ArrowUp');
  await captures(b, time, ['four']);
  storage.release();
  for (let round = 0; round < 3; round += 1) await settle(a, b);
  assert.deepEqual(sentences(a), ['three', 'one', 'two', 'four']);
  assert.deepEqual(sentences(b), ['three', 'one', 'two', 'four']);
  assert.deepEqual(storedSentences(storage), ['three', 'one', 'two', 'four']);
});

test('sheet: a move in one window and a tick of another item in the other, crossing, keep both', async () => {
  const { storage, time, panels: [a, b] } = await world({ panels: 2 });
  await captures(a, time);
  await settle(a, b);
  storage.hold();
  time.now += 1000;
  moveKey(a, 2, 'ArrowUp');
  time.now += 1000;
  tickRow(b, 0, false);
  storage.release();
  for (let round = 0; round < 3; round += 1) await settle(a, b);
  for (const panel of [a, b]) {
    assert.deepEqual(sentences(panel), ['one', 'three', 'two']);
    assert.equal(items(panel)[0].included, false, 'the move carried the older tick back');
  }
});

test('sheet: a capture after a move lands at the end', async () => {
  const { time, panels: [a, b] } = await world({ panels: 2 });
  await captures(a, time);
  time.now += 1000;
  moveKey(a, 0, 'ArrowDown');
  moveKey(a, 1, 'ArrowDown');
  assert.deepEqual(sentences(a), ['two', 'three', 'one']);
  await captures(a, time, ['four']);
  await settle(a, b);
  assert.deepEqual(sentences(a), ['two', 'three', 'one', 'four']);
  assert.deepEqual(sentences(b), ['two', 'three', 'one', 'four']);
});

// The critique's gap: a capture lands last only while its time is past every
// place on the sheet. A clock set back, or a row moved to the end within the
// millisecond of the capture, broke that in every panel but the capturing one.
test('sheet: a capture at or below a place on the sheet still lands last, in every window and after a reopen', async () => {
  const { storage, downloads, time, panels: [a, b] } = await world({ panels: 2 });
  await captures(a, time);
  const third = time.now;
  // Rows moved to the end within the millisecond of the last capture: each
  // goes one past the place before it, and so past the time of the next.
  for (const index of [0, 1, 0, 1]) moveKey(a, index, 'ArrowDown');
  assert.deepEqual(sentences(a), ['three', 'one', 'two']);
  assert.equal(items(a).at(-1).rank, third + 2);
  time.now = third + 1;
  await capture(a);
  type(a, 'four');
  for (let round = 0; round < 3; round += 1) await settle(a, b);
  const order = ['three', 'one', 'two', 'four'];
  assert.deepEqual(sentences(a), order);
  assert.deepEqual(sentences(b), order, 'the other window put the capture before the rows moved past its time');
  const reopened = await openPanel({ storage, downloads, time });
  assert.deepEqual(sentences(reopened), order);
});

// One panel, and a reopen once the capture is stored, rather than a second
// window open throughout: with the clock set back, two open panels that both
// hold an item stamped after the new time write the sheet back and forth
// until the clock passes the stamp, whatever the order (0.6.1 does it on a
// tick). A reopened panel adopts a write as another window does.
test('sheet: a capture after the clock was set back still lands last, also after a reopen', async () => {
  const { storage, downloads, time, panels: [a] } = await world();
  await captures(a, time);
  time.now += 1;
  moveKey(a, 0, 'ArrowDown');
  time.now += 1;
  moveKey(a, 1, 'ArrowDown');
  assert.deepEqual(sentences(a), ['two', 'three', 'one']);
  time.now -= 60 * 60 * 1000;
  await captures(a, time, ['four']);
  await settle(a);
  const order = ['two', 'three', 'one', 'four'];
  assert.deepEqual(sentences(a), order);
  const reopened = await openPanel({ storage, downloads, time });
  assert.deepEqual(sentences(reopened), order, 'the reopened panel put the capture first, by its time');
});

test('sheet: a capture on a sheet without moves carries no place', async () => {
  const { storage, time, panels: [a] } = await world();
  await captures(a, time);
  assert.ok(storedItems(storage).every((item) => !('rank' in item)), 'a place was stored with nothing moved');
});

test('sheet: moves into a gap a millisecond wide run out of halves, and the order still holds, also for the next capture', async () => {
  const { storage, downloads, time, panels: [a, b] } = await world({ panels: 2 });
  const words = ['a', 'b', 'c', 'd'];
  for (const word of words) {
    time.now += 1; // the narrowest gap there is
    await capture(a);
    type(a, word);
  }
  // The last row moved up into the gap after the first, two places at a
  // time, sixty times. A millisecond apart, as keys pressed by a person are:
  // a stamp ahead of the clock is read as now (readItem), so a second change
  // to one item within one millisecond would not reach the other window.
  const expected = [...words];
  const up = (index) => expected.splice(index - 1, 0, expected.splice(index, 1)[0]);
  for (let i = 0; i < 60; i += 1) {
    for (const index of [3, 2]) {
      time.now += 1;
      moveKey(a, index, 'ArrowUp');
      up(index);
    }
  }
  assert.deepEqual(sentences(a), expected);
  // The halves ran out, and every row took its index as its place.
  assert.ok(
    items(a).every((item) => Number.isFinite(item.rank) && Math.abs(item.rank) < 100),
    `no renumber: ${items(a).map((item) => item.rank).join(', ')}`
  );
  await settle(a, b);
  assert.deepEqual(sentences(b), expected);
  const reopened = await openPanel({ storage, downloads, time });
  assert.deepEqual(sentences(reopened), expected);
  // A capture after the renumber lands last, everywhere.
  time.now += 1000;
  await captures(a, time, ['e']);
  await settle(a, b);
  assert.deepEqual(sentences(a), [...expected, 'e']);
  assert.deepEqual(sentences(b), [...expected, 'e']);
  assert.deepEqual(storedSentences(storage), [...expected, 'e']);
});

test('sheet: an undo after a move puts the item where every window and a reopen put it', async () => {
  const { storage, downloads, time, panels: [a, b] } = await world({ panels: 2 });
  await captures(a, time);
  await settle(a, b);
  time.now += 1000;
  pickRow(a, 1);
  a.click('preview-clear'); // 'two'
  await settle(a, b);
  assert.deepEqual(sentences(a), ['one', 'three']);
  time.now += 1000;
  moveKey(a, 1, 'ArrowUp');
  await settle(a, b);
  assert.deepEqual(sentences(b), ['three', 'one']);
  time.now += 1000;
  a.element('undo').children[1].dispatch('click');
  for (let round = 0; round < 3; round += 1) await settle(a, b);
  // 'two' stands at its capture time, after 'one', not at the index it left.
  assert.deepEqual(sentences(a), ['three', 'one', 'two']);
  assert.deepEqual(sentences(b), ['three', 'one', 'two']);
  const reopened = await openPanel({ storage, downloads, time });
  assert.deepEqual(sentences(reopened), ['three', 'one', 'two']);
});

test('sheet: a sheet stored by 0.6.1, with no places, comes back in capture order', async () => {
  const { panels: [a] } = await world({
    seed: ({ storage }) =>
      storage.data.set('cdrReport', {
        items: [
          storedItem('second', { capturedAt: 1_799_999_000_002 }),
          storedItem('first', { capturedAt: 1_799_999_000_001 }),
          storedItem('third', { capturedAt: 1_799_999_000_003 }),
        ],
        removed: [],
        updatedAt: 1_799_999_000_000,
      }),
  });
  assert.deepEqual(ids(a), ['first', 'second', 'third']);
});

test('sheet: an item still saving can be moved, keeps its place through another window\'s write, and is stored there', async () => {
  const { storage, downloads, time, panels: [a, b] } = await world({ panels: 2 });
  await captures(a, time);
  await settle(a, b);
  let slow = null;
  downloads.next.push((record) => {
    record.state = 'in_progress';
    record.filename = '';
    slow = record;
  });
  await captures(a, time, ['four']);
  assert.equal(items(a)[3].path, null, 'the save finished at once');
  time.now += 1000;
  moveKey(a, 3, 'ArrowUp');
  moveKey(a, 2, 'ArrowUp');
  assert.deepEqual(sentences(a), ['one', 'four', 'two', 'three']);
  time.now += 1000;
  tickRow(b, 2, false);
  await settle(a, b);
  assert.deepEqual(sentences(a), ['one', 'four', 'two', 'three'], 'the saving item lost its place to a write from elsewhere');
  assert.deepEqual(sentences(b), ['one', 'two', 'three'], 'an item with no file reached another window');
  slow.state = 'complete';
  slow.filename = `${DIR}four.png`;
  await a.clock.advance(200);
  for (let round = 0; round < 3; round += 1) await settle(a, b);
  assert.deepEqual(storedSentences(storage), ['one', 'four', 'two', 'three']);
  assert.deepEqual(sentences(b), ['one', 'four', 'two', 'three']);
  assert.equal(items(b)[3].included, false);
});

test('sheet: a row moved while Copy reads the page is listed and numbered where it went', async () => {
  const answers = [];
  const { time, panels: [a] } = await world({
    setups: [(chrome) => (chrome.tabs.sendMessage = () => new Promise((resolve) => answers.push(resolve)))],
  });
  await captures(a, time);
  answers.splice(0).forEach((answer) => answer(null));
  await settle(a);
  const realm = a.R('globalThis');
  const assemble = realm.assembleReport;
  let report = null;
  realm.assembleReport = (...args) => (report = assemble(...args));
  a.click('submit');
  await a.flush();
  moveKey(a, 2, 'ArrowUp'); // while the page has not answered
  answers.splice(0).forEach((answer) => answer(null));
  await a.clock.advance(500);
  await settle(a);
  assert.ok(report, 'Copy did not assemble a report');
  assert.deepEqual(
    [...report.items].map((item) => [item.number, item.description]),
    [
      [1, 'one'],
      [2, 'three'],
      [3, 'two'],
    ]
  );
});

test('sheet: the newest capture comes into the frame on opening and after a copy, though moved to the top', async () => {
  const { storage, downloads, time, panels: [a] } = await world();
  await captures(a, time);
  time.now += 1000;
  moveKey(a, 2, 'ArrowUp');
  moveKey(a, 1, 'ArrowUp');
  await settle(a);
  const newest = items(a)[0];
  assert.equal(newest.description, 'three');
  const reopened = await openPanel({ storage, downloads, time });
  assert.equal(reopened.internals.state.selectedId, newest.id, 'the last row came into the frame, not the newest capture');
  // A copy of 'two' alone leaves 'three' and 'one'.
  tickRow(a, 0, false);
  tickRow(a, 1, false);
  pickRow(a, 2);
  a.click('submit');
  await a.clock.advance(500);
  await settle(a);
  assert.deepEqual(sentences(a), ['three', 'one']);
  assert.equal(a.internals.state.selectedId, newest.id);
  assert.equal(a.element('description').value, 'three');
});

// ------------------------------------------------------------- marking up

/** Draw one arrow on the open markup with the keys. */
function drawArrow(panel) {
  const canvas = panel.element('markup-canvas');
  const key = (name) =>
    canvas.dispatch('keydown', { key: name, isComposing: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false });
  if (!panel.internals.state.markup.cursor) key('Enter');
  key('Enter');
  for (let i = 0; i < 5; i += 1) key('ArrowRight');
  key('Enter');
}

/** Mark the item in the frame up with one arrow and press Done. */
async function markAndSave(panel) {
  panel.click('mark-up');
  await panel.flush();
  assert.ok(panel.internals.state.markup, 'the markup did not open');
  drawArrow(panel);
  panel.click('mark-done');
  await panel.flush();
}

/**
 * Hold the next download in progress, as a "Save as" dialog holds it, until
 * finish() writes it where Chrome would have, or fail() ends it as Chrome
 * reports a cancelled dialog.
 */
function holdNextDownload(downloads) {
  const held = {};
  downloads.next.push((record) => {
    held.record = record;
    held.filename = record.filename;
    record.state = 'in_progress';
    record.filename = '';
  });
  held.finish = async (...panels) => {
    held.record.state = 'complete';
    held.record.filename = held.filename;
    for (const panel of panels) await panel.clock.advance(200);
    await settle(...panels);
  };
  held.fail = async (panel, error = 'USER_CANCELED') => {
    held.record.state = 'interrupted';
    held.record.error = error;
    await panel.clock.advance(200);
    await settle(panel);
  };
  return held;
}

test('sheet: Done saves the marked copy beside the capture, points the item at it, and only then deletes the capture', async () => {
  const { storage, downloads, time, panels: [a] } = await world();
  await capture(a);
  const [item] = items(a);
  const first = { path: item.path, downloadId: item.downloadId };
  const [plain] = storedItems(storage);
  assert.ok(!('marked' in plain) && !('fileAt' in plain), 'an item never marked up is stored with keys it did not have');
  // What the item names at the moment its capture is deleted.
  const seen = [];
  const removeFile = downloads.api.removeFile;
  downloads.api.removeFile = async (id) => {
    seen.push({ id, path: items(a)[0]?.path });
    return removeFile(id);
  };
  time.now += 5000;
  await markAndSave(a);
  await settle(a);

  // Named for the capture's own time and mode, with _marked.
  const [name, marked] = downloads.calls.download;
  assert.equal(marked, name.replace(/\.png$/, '_marked.png'));
  assert.match(marked, /_screen_marked\.png$/);
  assert.equal(item.path, DIR + marked.split('/').pop());
  assert.equal(item.downloadId, 2);
  assert.equal(item.marked, true);
  assert.deepEqual(seen, [{ id: first.downloadId, path: item.path }], 'the capture went before the item named its marked copy');
  assert.deepEqual(downloads.calls.erase, [first.downloadId]);
  const [stored] = storedItems(storage);
  assert.equal(stored.path, item.path);
  assert.equal(stored.downloadId, 2);
  assert.equal(stored.marked, true);
  assert.equal(stored.fileAt, time.now);
  assert.equal(storage.data.get('cdrThumbs').items[item.id], item.thumb, 'the marked thumbnail was not stored');
  assert.equal(a.element('preview-meta').textContent, 'SCREEN · PNG 1280×720 · MARKED');
  assert.equal(a.element('announce').textContent, 'Item 1 is saved with its marks.');
  // Chrome's word that the capture is gone is about no item now.
  for (const listener of downloads.listeners) listener({ id: first.downloadId, exists: { previous: true, current: false } });
  await settle(a);
  assert.ok(!item.missing, 'the item was called missing for the file it replaced');
  assert.equal(a.element('submit').disabled, false);
});

test('sheet: Copy waits while the marked copy saves, and names it once saved', async () => {
  const { downloads, panels: [a] } = await world();
  await capture(a);
  a.click('mark-up');
  await a.flush();
  const note = () => a.element('submit-note');
  const said = () => note().children.map((node) => node.textContent).join('');
  assert.equal(a.element('submit').disabled, true);
  assert.equal(said(), 'Finish marking up item 1 to copy it.');
  drawArrow(a);
  const held = holdNextDownload(downloads);
  a.click('mark-done');
  await a.flush();
  assert.equal(a.internals.state.markup, null);
  assert.equal(a.element('submit').disabled, true, 'Copy could be pressed while the marked copy saved');
  assert.equal(said(), 'Item 1 is still saving.');
  assert.equal(a.element('preview-meta').textContent, 'SCREEN · PNG 1280×720 · SAVING');
  assert.equal(a.element('mark-up').disabled, true, 'Mark up could be pressed while its copy saved');
  await held.finish(a);
  assert.equal(a.element('submit').disabled, false);
  assert.match(said(), /^Or press/);
  assert.equal(a.element('mark-up').disabled, false);
});

test('sheet: a marked copy cancelled in the dialog leaves the item its capture, says so, and keeps the marks', async () => {
  const { downloads, panels: [a] } = await world();
  await capture(a);
  const [item] = items(a);
  const path = item.path;
  a.click('mark-up');
  await a.flush();
  drawArrow(a);
  const held = holdNextDownload(downloads);
  a.click('mark-done');
  await a.flush();
  await held.fail(a);
  assert.equal(item.path, path);
  assert.equal(item.downloadId, 1);
  assert.equal(item.marked, undefined);
  assert.deepEqual(downloads.calls.removeFile, []);
  assert.equal(
    a.banner(),
    'The marked screenshot was not saved: Download failed: USER_CANCELED. Item 1 keeps the screenshot it had. ' +
      'Press Mark up to try the same marks again.'
  );
  assert.equal(a.element('submit').disabled, false);
  a.click('mark-up');
  await a.flush();
  assert.equal(a.internals.state.markup.marks.length, 1, 'the marks were lost with the save');
  // The mark taken back, the marks are the ones last saved (none), and Done
  // saves nothing; the mark taken back stays taken back.
  a.click('mark-undo');
  a.click('mark-done');
  await settle(a);
  assert.equal(a.internals.state.markup, null);
  assert.equal(downloads.calls.download.length, 2, 'Done saved marks that had not changed');
  a.click('mark-up');
  await a.flush();
  assert.equal(a.internals.state.markup.marks.length, 0, 'a mark taken back came back');
  drawArrow(a);
  a.click('mark-done');
  await settle(a);
  assert.equal(item.marked, true);
  assert.deepEqual(downloads.calls.removeFile, [1]);
});

test('sheet: a capture marked up again with every mark taken back is saved under its own name, unmarked', async () => {
  const { storage, downloads, panels: [a] } = await world();
  await capture(a);
  const [item] = items(a);
  await markAndSave(a);
  await settle(a);
  assert.match(item.path, /_screen_marked\.png$/);
  a.click('mark-up');
  await a.flush();
  assert.equal(a.internals.state.markup.marks.length, 1);
  a.click('mark-undo');
  a.click('mark-done');
  await settle(a);
  const [first, , again] = downloads.calls.download;
  assert.equal(again, first, 'a copy with no marks was not named as the capture is');
  assert.doesNotMatch(item.path, /_marked/);
  assert.equal(item.downloadId, 3);
  assert.equal(item.marked, undefined);
  const [stored] = storedItems(storage);
  assert.equal(stored.path, item.path);
  assert.ok(!('marked' in stored), 'an item with no marks left is stored as marked');
  assert.deepEqual(downloads.calls.removeFile, [1, 2], 'the marked copy it replaced was kept');
  assert.equal(a.element('preview-meta').textContent, 'SCREEN · PNG 1280×720');
  assert.equal(a.element('announce').textContent, 'Item 1 is saved without marks.');
});

test('sheet: a discard that lapses lets the full screenshot go', async () => {
  const { panels: [a] } = await world();
  await capture(a);
  const [item] = items(a);
  assert.ok(item.full);
  a.click('preview-clear');
  // Undo can still bring it back, marked up or not.
  assert.ok(item.full, 'the full screenshot went before the discard was final');
  await a.clock.advance(UNDO_MS + 100);
  await settle(a);
  assert.equal(a.internals.state.trash, null);
  assert.equal(item.full, null, 'the full screenshot of a discarded item was kept');
  assert.deepEqual(Array.from(a.internals.state.fulls), []);
});

test('sheet: a capture whose first save fails lets its full screenshot go, discarded meanwhile or not', async () => {
  for (const discarded of [false, true]) {
    const { downloads, panels: [a] } = await world();
    const held = holdNextDownload(downloads);
    await capture(a);
    const [item] = items(a);
    assert.ok(item.full, `discarded ${discarded}`);
    if (discarded) a.click('preview-clear');
    await held.fail(a);
    assert.equal(items(a).length, 0);
    assert.equal(a.internals.state.trash, null);
    assert.equal(item.full, null, `discarded ${discarded}: the full screenshot of a capture never saved was kept`);
    assert.deepEqual(Array.from(a.internals.state.fulls), []);
  }
});

test('sheet: an item discarded while its marked copy saves comes back marked, or takes both files when the undo lapses', async () => {
  for (const undo of [true, false]) {
    const { downloads, panels: [a] } = await world();
    await capture(a);
    const [item] = items(a);
    const held = holdNextDownload(downloads);
    await markAndSave(a);
    a.click('preview-clear');
    assert.equal(items(a).length, 0);
    await held.finish(a);
    // The capture goes as soon as the marked copy is the item's.
    assert.deepEqual(downloads.calls.removeFile, [1], `undo ${undo}`);
    assert.equal(item.downloadId, 2);
    if (undo) {
      a.element('undo').children[1].dispatch('click');
      await settle(a);
      assert.equal(items(a)[0], item);
      assert.equal(item.marked, true);
      assert.match(item.path, /_marked\.png$/);
      await a.clock.advance(UNDO_MS + 100);
      assert.deepEqual(downloads.calls.removeFile, [1]);
    } else {
      await a.clock.advance(UNDO_MS + 100);
      await settle(a);
      assert.deepEqual(downloads.calls.removeFile, [1, 2]);
      assert.deepEqual(downloads.calls.erase, [1, 2]);
    }
  }
});

test('sheet: another window takes the marked copy over, and its own writes do not bring the capture back', async () => {
  const { storage, time, panels: [a, b] } = await world({ panels: 2 });
  await capture(a);
  await settle(a, b);
  const [theirs] = items(b);
  // B has asked Chrome about the capture's id, and knows it for the item's.
  await b.R('checkFiles')();
  assert.equal(theirs.verified, true);
  time.now += 1000;
  await markAndSave(a);
  await settle(a, b);
  const [mine] = items(a);
  assert.equal(theirs.path, mine.path);
  assert.equal(theirs.downloadId, 2);
  assert.equal(theirs.verified, false, 'B took the new id on trust');
  assert.equal(theirs.marked, true);
  assert.equal(theirs.fileAt, mine.fileAt);
  assert.equal(b.element('preview-meta').textContent, 'SCREEN · PNG 1280×720 · MARKED');
  assert.equal(theirs.thumb, mine.thumb);
  // Window B cannot mark it up: it never held the capture.
  assert.equal(b.element('mark-up').getAttribute('aria-disabled'), 'true');
  time.now += 1000;
  type(b, 'typed in B');
  await settle(a, b);
  assert.equal(storedItems(storage)[0].path, mine.path, 'B wrote the capture back');
  assert.equal(storedItems(storage)[0].marked, true);
  assert.equal(mine.path, storedItems(storage)[0].path);
  assert.equal(mine.description, 'typed in B');
});

test('sheet: an item from before this panel opened says why it cannot be marked up', async () => {
  const { panels: [a] } = await world({
    seed: ({ storage, time }) => {
      storage.data.set('cdrReport', { items: [storedItem('earlier')], updatedAt: time.now, writer: 'x' });
    },
  });
  const button = a.element('mark-up');
  assert.equal(button.hidden, false);
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  assert.equal(button.disabled, false, 'the reason cannot be reached with the button disabled');
  a.click('mark-up');
  await a.flush();
  assert.equal(a.internals.state.markup, null);
  assert.equal(
    a.banner(),
    'Item 1 cannot be marked up: a panel keeps the full screenshot only of the captures it took, and only while it ' +
      'stays open. Capture it again to mark it up.'
  );
  assert.equal(a.R('markupBlocked')(items(a)[0]), a.banner());
});

test('sheet: a panel closed while a marked copy saves takes that download back and keeps the capture', async () => {
  const { downloads, panels: [a] } = await world();
  await capture(a);
  const held = holdNextDownload(downloads);
  await markAndSave(a);
  assert.ok(held.record, 'the marked copy was not started');
  a.R('flushOnClose')();
  assert.deepEqual(downloads.calls.cancel, [2]);
  assert.ok(!downloads.calls.removeFile.includes(1), 'the capture the stored item names was deleted');
});

test('sheet: a panel closed while a discarded item\'s marked copy saves takes back both', async () => {
  const { downloads, panels: [a] } = await world();
  await capture(a);
  const held = holdNextDownload(downloads);
  await markAndSave(a);
  assert.ok(held.record);
  a.click('preview-clear');
  a.R('flushOnClose')();
  assert.ok(downloads.calls.cancel.includes(2), 'the marked copy was left running');
  assert.ok(downloads.calls.removeFile.includes(1), 'the discarded capture was left');
});

test('sheet: an item marked up after a blocked copy keeps the capture the copied prompt names', async () => {
  const { downloads, panels: [a] } = await world();
  a.R('document').execCommand = () => false;
  await capture(a);
  a.click('submit');
  await a.clock.advance(500);
  await settle(a);
  assert.match(a.element('result-text').textContent, /blocked/);
  const named = items(a)[0].path;
  assert.ok(a.internals.state.lastPrompt !== undefined);
  await markAndSave(a);
  await settle(a);
  assert.notEqual(items(a)[0].path, named);
  assert.deepEqual(downloads.calls.removeFile, [], 'the file the hand copied prompt names was deleted');
});

test('sheet: an item copied in another window while its marked copy saves keeps its capture, and the copy goes', async () => {
  const { storage, downloads, time, panels: [a, b] } = await world({ panels: 2 });
  await capture(a);
  await settle(a, b);
  const [item] = items(a);
  const held = holdNextDownload(downloads);
  await markAndSave(a);
  time.now += 1000;
  b.click('submit');
  await b.clock.advance(500);
  await settle(a, b);
  assert.equal(items(a).length, 0, 'the copy elsewhere did not take the item off this sheet');
  assert.equal(item.full, null, 'the full screenshot of an item gone elsewhere was kept');
  assert.deepEqual(Array.from(a.internals.state.fulls), []);
  await held.finish(a);
  assert.deepEqual(downloads.calls.removeFile, [2], 'the file the copied prompt names was deleted, or the copy kept');
  assert.equal(storedItems(storage).length, 0);
});

test('sheet: the panel keeps the full screenshots of its newest captures only, and says so of the others', async () => {
  const big = 40 * 1024 * 1024;
  const { time, panels: [a] } = await world({
    fetches: [async (url) => ({ blob: async () => ({ type: 'image/png', size: a?.big ? big : 4, source: url }) })],
  });
  for (let i = 0; i < 11; i += 1) {
    time.now += 1000;
    await capture(a);
  }
  const held = () => items(a).map((item) => Boolean(item.full));
  assert.deepEqual(held(), [false, ...Array(10).fill(true)]);
  pickRow(a, 0);
  assert.equal(a.element('mark-up').getAttribute('aria-disabled'), 'true');
  a.click('mark-up');
  await a.flush();
  assert.equal(
    a.banner(),
    'Item 1 can no longer be marked up: the panel keeps the full screenshots of its 10 newest captures only, ' +
      'about 100 MB at most. Capture it again to mark it up.'
  );
  pickRow(a, 10);
  assert.equal(a.element('mark-up').getAttribute('aria-disabled'), null);
  // Large captures: about 100 MB holds two of 40 MB, and the oldest go first
  // to make room for the third, small ones too.
  a.big = true;
  for (let i = 0; i < 2; i += 1) {
    time.now += 1000;
    await capture(a);
  }
  const sizes = () => items(a).filter((item) => item.full).map((item) => item.full.size);
  assert.deepEqual(sizes(), [4, 4, 4, 4, 4, 4, 4, 4, big, big]);
  time.now += 1000;
  await capture(a);
  assert.deepEqual(sizes(), [big, big]);
  assert.equal(items(a).at(-1).full.size, big, 'the newest capture was let go');
});

test('sheet: a copied item lets its full screenshot go', async () => {
  const { panels: [a] } = await world();
  await capture(a);
  const [item] = items(a);
  assert.ok(item.full);
  a.click('submit');
  await a.clock.advance(500);
  await settle(a);
  assert.equal(items(a).length, 0);
  assert.equal(item.full, null);
  assert.deepEqual(Array.from(a.internals.state.fulls), []);
});

test('sheet: a copy of other items leaves the markup open on its item, though a newer one is left', async () => {
  const { time, panels: [a] } = await world();
  await captures(a, time);
  tickRow(a, 0, false);
  tickRow(a, 2, false);
  pickRow(a, 0);
  a.click('mark-up');
  await a.flush();
  const markup = a.internals.state.markup;
  assert.ok(markup);
  drawArrow(a);
  a.click('submit');
  await a.clock.advance(500);
  await settle(a);
  assert.deepEqual(sentences(a), ['one', 'three']);
  assert.equal(a.internals.state.markup, markup, 'the copy closed the markup');
  assert.equal(a.internals.state.selectedId, items(a)[0].id);
  assert.equal(markup.marks.length, 1);
});

test('sheet: a write from a window closed before it heard of the marked copy does not leave the capture stored', async () => {
  // Window B stops hearing storage once it is closed.
  const closed = { b: false };
  const deaf = (chrome) => {
    const api = chrome.storage;
    chrome.storage = {
      ...api,
      onChanged: { addListener: (fn) => api.onChanged.addListener((...args) => closed.b || fn(...args)) },
    };
  };
  const { storage, downloads, time, panels: [a, b] } = await world({ panels: 2, setups: [undefined, deaf] });
  await capture(a);
  await settle(a, b);
  time.now += 1000;
  storage.hold();
  await markAndSave(a);
  await a.flush();
  const marked = items(a)[0].path;
  assert.match(marked, /_marked\.png$/);
  // B types before it has heard of the swap, writes the capture's path, and
  // its window is closed.
  time.now += 1000;
  type(b, 'typed in B');
  await b.flush();
  closed.b = true;
  assert.notEqual(storedItems(storage)[0].path, marked, 'the writes did not cross');
  storage.release();
  await settle(a, b);
  assert.equal(storedItems(storage)[0].path, marked, 'the deleted capture stayed in storage');
  assert.equal(storedItems(storage)[0].marked, true);
  assert.equal(storedItems(storage)[0].description, 'typed in B');
  assert.deepEqual(downloads.calls.removeFile, [1]);
});

test('sheet: an item whose file went missing is whole again once marked up, and the banner about it goes', async () => {
  const { panels: [a] } = await world();
  await capture(a);
  const [item] = items(a);
  a.R('markMissing')(item);
  assert.match(a.banner(), /no longer on disk/);
  assert.equal(a.element('submit').disabled, true);
  await markAndSave(a);
  await settle(a);
  assert.equal(item.missing, false);
  assert.equal(item.marked, true);
  assert.equal(a.banner(), null, 'the banner about the missing file stayed');
  assert.equal(a.element('item-missing').hidden, true);
  assert.equal(a.element('submit').disabled, false);
});
