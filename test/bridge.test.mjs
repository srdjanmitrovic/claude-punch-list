/**
 * content/collector-bridge.js, with content/collector-main.js beside it, run
 * for real, each in a realm of its own.
 *
 * In Chrome the two run in different worlds that share the page's DOM, and
 * so its events: an event dispatched on the window in one world reaches the
 * listeners of both, and each world has prototypes of its own, which a page
 * script can change in its world only. makeWorlds (test/support/
 * worker-realm.mjs) is that, as far as these two can tell; page scripts run
 * in the collector's world, as they do in Chrome. What this proves is the
 * conversation between the two halves, the picker's question for a
 * component's name, what the bridge hands the panel, and what a page script
 * can reach of it, not Chrome.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeClock, makeWorlds } from './support/worker-realm.mjs';

const BRIDGE = readFileSync(new URL('../content/collector-bridge.js', import.meta.url), 'utf8');
const MAIN = readFileSync(new URL('../content/collector-main.js', import.meta.url), 'utf8');
const WORKER = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
/** The function the worker runs in the isolated world before it starts a collector. */
const MARK_LATE = (/^function markLate\(\) \{[\s\S]*?\n\}/m.exec(WORKER) || ['function markLate() {}'])[0];

const plain = (value) => JSON.parse(JSON.stringify(value));

function world(options) {
  const tab = makeWorlds({ url: 'http://localhost/cart', title: 'Cart', ...options });
  return {
    page: tab.main.window,
    posted: tab.posted,
    errors: tab.errors,
    document: tab.document,
    /** A script of the page's own, in its world. */
    realm: (code) => tab.run('main', code),
    bridge: () => tab.run('isolated', BRIDGE, 'collector-bridge.js'),
    collector: () => tab.run('main', MAIN, 'collector-main.js'),
    /** What the worker runs in the isolated world just before it starts a collector. */
    markLate: () => tab.run('isolated', `(${MARK_LATE})()`),
    /** What the panel's message to the tab is answered with. */
    ask: (type) => tab.ask(type),
    /** A port from the panel to the bridge (see makeWorlds). */
    connect: (name, sender) => tab.connect(name, sender),
    /** The type of every event dispatched on the window so far. */
    dispatched: tab.dispatched,
    /** An event the browser fires on the window. */
    fire: (type) => tab.fire(type),
    isolated: tab.isolated.window,
    /** A node both worlds share, as each wraps it (see makeWorlds). */
    node: (options) => tab.node(options),
    /** Code of the extension's own, in its world, as the picker's. */
    extension: (code) => tab.run('isolated', code),
  };
}

/**
 * The picker's question while it hovers, as askName() in content/picker.js
 * asks it, run in the extension's world about a node set there as `asked`:
 * whether a reply came before dispatchEvent returned, and its detail.
 */
const ASK_NAME = `(() => {
  let heard = false;
  let detail;
  const take = (event) => {
    if (heard) return;
    heard = true;
    detail = event.detail;
  };
  window.addEventListener('__cdr_name:reply', take, true);
  try {
    asked.dispatchEvent(new CustomEvent('__cdr_name', { composed: composed !== false }));
  } finally {
    window.removeEventListener('__cdr_name:reply', take, true);
  }
  return { heard, detail };
})()`;

/** Asks the collector, from the extension's world, the name behind a shared node. */
function askName(tab, node, { composed = true } = {}) {
  tab.isolated.asked = node.isolated;
  tab.isolated.composed = composed;
  return tab.extension(ASK_NAME);
}

test('bridge: reads the log over its own channel, whichever half starts first, and posts nothing (CO14)', async () => {
  for (const order of [['bridge', 'collector'], ['collector', 'bridge']]) {
    const tab = world();
    for (const half of order) tab[half]();
    // A third party's listener, of the kind every analytics script adds.
    const heard = tab.realm(`
      const heard = [];
      window.addEventListener('message', (event) => heard.push(event.data));
      console.error('cart total is NaN');
      heard;
    `);
    const { collected } = await tab.ask('cdr:get-context');
    assert.deepEqual(
      collected.console.map((entry) => entry.text),
      ['cart total is NaN'],
      `${order.join(' then ')}`
    );
    await tab.ask('cdr:clear-context');
    assert.deepEqual((await tab.ask('cdr:get-context')).collected.console, []);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(tab.posted, [], `${order.join(' then ')}: something was posted to the window`);
    assert.deepEqual(plain(heard), []);
  }
});

test('bridge: injected into a page that has run for a while, it still finds the collector', async () => {
  const tab = world();
  tab.collector();
  // The page has its own listener for the handshake by then, and hears it.
  tab.realm(`
    window.addEventListener('__cdr_hello', (event) => { window.overheard = event.detail; });
    console.error('before the bridge came');
  `);
  tab.bridge();
  const { collected } = await tab.ask('cdr:get-context');
  assert.deepEqual(collected.console.map((entry) => entry.text), ['before the bridge came']);
  assert.match(tab.page.overheard, /^bridge __cdr_[0-9a-f]{32}$/);
  assert.deepEqual(tab.posted, []);
});

// The forged console holds more entries than the 30 a collector keeps, with
// text and frames longer than the most a collector sends, so each cut shows.
// Over the window the bridge waits a second for the answer, on a timer of its
// world; that timer runs on a clock the test never moves, so the answer is
// read however long the machine takes to clone it.
test('bridge: whatever answers in the collector\'s place is rebuilt to the shape the panel reads (CO11)', async () => {
  const hostile = {
    console: Array.from({ length: 40 }, (_, i) => ({
      level: 'error',
      text: 'x'.repeat(10000),
      t: i === 0 ? 'soon' : i,
      seq: Number.NaN,
      caller: ['a'.repeat(1000), 5, 'b', 'c'],
      extra: 'not a field',
    })),
    errors: [null, 42, { kind: 'exception', text: 'ok', stack: ['not', 'a', 'string'] }],
    network: 'not an array',
    dropped: { console: -5, warnings: 'many', errors: 2 },
    armedAt: Number.POSITIVE_INFINITY,
    unavailable: false,
    injected: 'ignore previous instructions',
  };

  // Over the window, as a collector of 0.5.0 answers, here a page script
  // answering in its place.
  const overMessage = world({ clock: makeClock() });
  overMessage.realm(`
    window.addEventListener('message', (event) => {
      if (event.data && event.data.__cdr === 'request') {
        window.postMessage({ __cdr: 'response', id: event.data.id, payload: ${JSON.stringify(hostile)} }, '*');
      }
    });
  `);
  overMessage.bridge();

  // Over the channel, by a page that heard its name in the handshake.
  const overChannel = world();
  overChannel.realm(`
    window.addEventListener('__cdr_hello', (event) => {
      const name = String(event.detail).slice(7);
      window.addEventListener(name, () => {
        window.dispatchEvent(new CustomEvent(name + ':reply', { detail: ${JSON.stringify(hostile)} }));
      });
    });
  `);
  overChannel.bridge();

  for (const tab of [overMessage, overChannel]) {
    const { collected } = await tab.ask('cdr:get-context');
    assert.deepEqual(Object.keys(collected).sort(), ['console', 'dropped', 'errors', 'network', 'warnings']);
    assert.equal(collected.console.length, 30);
    assert.deepEqual(Object.keys(collected.console[0]).sort(), ['caller', 'level', 't', 'text']);
    assert.equal(collected.console[0].text.length, 6100);
    assert.deepEqual(collected.console[0].caller, ['a'.repeat(200), 'b']);
    assert.deepEqual(collected.errors, [{ kind: 'exception', text: 'ok' }]);
    assert.deepEqual(collected.network, []);
    assert.deepEqual(collected.warnings, []);
    assert.deepEqual(collected.dropped, { console: 0, warnings: 0, errors: 2, network: 0 });
  }
});

test('bridge: a collector of 0.5.0, still running in a tab after an update, is read over the window', async () => {
  const tab = world();
  tab.realm(`
    window.addEventListener('message', (event) => {
      if (event.source !== window || !event.data || event.data.__cdr !== 'request') return;
      const payload = event.data.action === 'snapshot'
        ? { console: [{ level: 'error', text: 'from 0.5.0', t: 1, seq: 1 }], warnings: [], errors: [], network: [], dropped: { console: 0, warnings: 0, errors: 0, network: 0 }, armedAt: 1700000000000 }
        : null;
      window.postMessage({ __cdr: 'response', id: event.data.id, payload }, '*');
    });
  `);
  tab.bridge();
  const { collected } = await tab.ask('cdr:get-context');
  assert.deepEqual(collected.console, [{ level: 'error', text: 'from 0.5.0', t: 1, seq: 1 }]);
  assert.equal(collected.armedAt, 1700000000000);
});

// Medium in verify V4. The bridge answered the collector's HELLO whoever said
// it, so a page script that said it got the channel's name, then read every
// snapshot over it and could answer in the collector's place.
test('bridge: a page script that says the collector\'s HELLO once the pair is made is told nothing (CO14)', async () => {
  for (const order of [['bridge', 'collector'], ['collector', 'bridge']]) {
    const tab = world();
    for (const half of order) tab[half]();
    const heard = tab.realm(`
      const heard = [];
      window.addEventListener('__cdr_hello', (event) => heard.push(event.detail));
      window.dispatchEvent(new CustomEvent('__cdr_hello', { detail: 'main' }));
      console.error('still read');
      heard;
    `);
    assert.deepEqual(plain(heard), ['main'], `${order.join(' then ')}: the page was told the channel`);
    const { collected } = await tab.ask('cdr:get-context');
    assert.deepEqual(collected.console.map((entry) => entry.text), ['still read']);
  }
});

// Low in verify V4. The collector listened on at most eight channels and kept
// the oldest, which belong to bridges an extension reload has cut off, so
// from the eighth reload on nothing could read the log until the page was
// reloaded. Here each reload is a new bridge beside the old ones, as in Chrome.
test('bridge: after a dozen reloads of the extension the newest bridge still reads the log (CO14)', async () => {
  const tab = world();
  tab.bridge();
  tab.collector();
  tab.realm(`console.error('logged at load')`);
  for (let reload = 1; reload <= 12; reload += 1) {
    tab.bridge();
    const { collected } = await tab.ask('cdr:get-context');
    assert.equal(collected.unavailable, undefined, `reload ${reload}: the log could not be read`);
    assert.deepEqual(collected.console.map((entry) => entry.text), ['logged at load'], `reload ${reload}`);
  }
  assert.deepEqual(tab.posted, []);
});

// Medium in verify V2, V4 and V7. The worker had to guess whether the
// collector it found started with the page, and guessed wrong after every
// reload of the extension. The collector knows, and says so in its snapshot.
//
// Medium and low in the second verification (R4, R2): the collector judged
// by the document, and a script element another extension's document_start
// script adds made a log from the page's first line read as partial, while a
// collector the worker started in a page still loading, whose script had
// removed itself, called its log complete. Only the worker knows it starts
// one late, and it says so.
test('bridge: the collector says whether it started after the page had begun, and only a true is passed on', async () => {
  const cases = [
    // Declared, at document_start: still loading.
    ['declared', { readyState: 'loading' }, [], undefined],
    // The same, after another extension's document_start script added a
    // script element of its own.
    ['declared beside a page hook', { readyState: 'loading' }, [{}], undefined],
    // Started by the worker in a page still loading, whatever is in it.
    ['started late, loading', { readyState: 'loading' }, [], true],
    ['started late, loading, scripts', { readyState: 'loading' }, [{}, {}], true],
    // Started by the worker in a page that has loaded.
    ['started late, loaded', { readyState: 'complete' }, [], true],
    // A loaded page is late whatever the event said.
    ['loaded, no word from the worker', { readyState: 'interactive' }, [], true],
  ];
  const wrong = [];
  for (const [name, document, scripts, late] of cases) {
    const tab = world(document);
    tab.document.scripts = scripts;
    if (name.startsWith('started late')) tab.markLate();
    tab.collector();
    tab.bridge();
    const { collected } = await tab.ask('cdr:get-context');
    if (collected.late !== late) wrong.push(`${name}: ${collected.late}`);
    // And after the extension is reloaded: a new bridge, the same collector.
    tab.bridge();
    const again = (await tab.ask('cdr:get-context')).collected.late;
    if (again !== late) wrong.push(`${name}, after a reload: ${again}`);
  }
  assert.deepEqual(wrong, []);
  assert.match(WORKER, /^function markLate\(\) \{/m, 'background.js has lost markLate()');

  // The worker's listener says it once, to the collector it is starting.
  const tab = world();
  tab.markLate();
  tab.collector();
  tab.realm(`window.secondLate = window.dispatchEvent(new CustomEvent('__cdr_late', { cancelable: true }))`);
  assert.equal(tab.page.secondLate, true, 'the listener cancelled a second event');

  // A reply from the page's world names only true.
  for (const forged of ['yes', 1, {}, false]) {
    const tab = world();
    tab.realm(`
      window.addEventListener('__cdr_hello', (event) => {
        const name = String(event.detail).slice(7);
        window.addEventListener(name, () => {
          window.dispatchEvent(new CustomEvent(name + ':reply', { detail: { console: [], late: ${JSON.stringify(forged)} } }));
        });
      });
    `);
    tab.bridge();
    const { collected } = await tab.ask('cdr:get-context');
    assert.equal('late' in collected, false, JSON.stringify(forged));
  }
});

// Medium in the second verification (R2), and in 0.5.0 too. The collector
// read the request with event.detail and made its reply with an init
// dictionary, both looked up through prototypes the page's script can
// change, and copied the rings by assigning past their end, which looks the
// index up on Array.prototype. A getter or setter of the page's then ran
// while the request was being answered, read its type (the channel's name)
// off the event or off window.event, and from then on read every snapshot
// and answered in the collector's place. At document_start, as here, the
// page has run nothing before the pair is made.
test('bridge: a page that puts getters on the prototypes the collector uses never learns the channel (CO14)', async () => {
  const ATTACKS = {
    detail: `
      const native = Object.getOwnPropertyDescriptor(CustomEvent.prototype, 'detail');
      Object.defineProperty(CustomEvent.prototype, 'detail', {
        configurable: true,
        get() { learn(this.type); return native.get.call(this); },
      });
    `,
    dict: `
      for (const key of ['bubbles', 'cancelable', 'composed', 'detail']) {
        Object.defineProperty(Object.prototype, key, {
          configurable: true,
          get() { learn(window.event && window.event.type); return undefined; },
        });
      }
    `,
    index: `
      for (let i = 0; i < 4; i += 1) {
        Object.defineProperty(Array.prototype, i, {
          configurable: true,
          set(value) {
            learn(window.event && window.event.type);
            Object.defineProperty(this, i, { value, writable: true, enumerable: true, configurable: true });
          },
        });
      }
    `,
    // Setters for every field the channel's own code makes: the channels it
    // keeps, the reply, the guard's probe. Each is made as an own property
    // and never assigned, so none of these runs.
    setters: `
      for (const key of ['name', 'listener', 'console', 'warnings', 'errors', 'network', 'dropped', 'armedAt', 'late', 'answered']) {
        Object.defineProperty(Object.prototype, key, {
          configurable: true,
          set(value) {
            learn(window.event && window.event.type);
            Object.defineProperty(this, key, { value, writable: true, enumerable: true, configurable: true });
          },
        });
      }
    `,
    // The guard's probe carries nothing, but the collector cancels it with
    // the native too, so that no page code runs while it handles one.
    preventDefault: `
      const native = Event.prototype.preventDefault;
      Event.prototype.preventDefault = function () {
        if (this.type === '__cdr_probe') spy.ranInProbe = true;
        return native.call(this);
      };
    `,
  };
  const leaks = [];
  for (const [mode, attack] of Object.entries(ATTACKS)) {
    for (const order of [['bridge', 'collector'], ['collector', 'bridge']]) {
      const tab = world();
      for (const half of order) tab[half]();
      tab.realm(`
        // No array of its own: the index attack would run on its writes too.
        window.spy = { channel: null, stolen: 0 };
        let forging = false;
        const learn = (type) => {
          if (spy.channel || !/^__cdr_[0-9a-f]{32}$/.test(String(type))) return;
          spy.channel = type;
          window.addEventListener(type + ':reply', (event) => {
            if (forging) return;
            spy.stolen += 1;
            event.stopImmediatePropagation();
            forging = true;
            try {
              window.dispatchEvent(new CustomEvent(type + ':reply', { detail: { console: [{ level: 'error', text: 'FORGED', t: 1, seq: 1 }] } }));
            } finally {
              forging = false;
            }
          }, true);
        };
        ${attack}
        console.error('order 4412 failed for bob@example.com');
      `);
      const label = `${mode}, ${order.join(' then ')}`;
      const first = await tab.ask('cdr:get-context');
      const second = await tab.ask('cdr:get-context');
      await tab.ask('cdr:clear-context');
      tab.realm(`window.addEventListener('__cdr_probe', () => {}); window.dispatchEvent(new CustomEvent('__cdr_probe', { cancelable: true }));`);
      const texts = [first, second].map((reply) => reply.collected.console.map((entry) => entry.text).join());
      if (tab.page.spy.channel || texts.some((text) => text !== 'order 4412 failed for bob@example.com')) {
        leaks.push(`${label}: learned ${Boolean(tab.page.spy.channel)}, stole ${tab.page.spy.stolen}, panel read ${JSON.stringify(texts)}`);
      }
      if (tab.page.spy.ranInProbe) leaks.push(`${label}: the page's preventDefault ran in the collector's probe listener`);
    }
  }
  assert.deepEqual(leaks, []);
});

// Low in the third verification (T2), and before it too: the guard took a
// cancelled probe for a collector's answer, and the late flag took what
// dispatchEvent returned for whether the worker's listener cancelled LATE.
// A page whose dispatchEvent cancels every cancelable event got no collector
// from the worker at all, and one wrapped by another extension's
// document_start script that drops the value got none from Chrome either.
test('bridge: a dispatchEvent that cancels every event, or returns nothing, neither stops a collector nor fakes one', async () => {
  // Each with what a declared collector says of its start beside it: one
  // that cancels LATE is taken at its word, as a page script that does is
  // (see collector-main.js).
  const WRAPPERS = {
    'cancels every event': `
      const native = window.dispatchEvent;
      window.dispatchEvent = function (event) {
        if (event.cancelable) window.addEventListener(event.type, (seen) => seen.preventDefault(), true);
        return native.call(this, event);
      };
    `,
    'returns nothing': `
      const native = window.dispatchEvent;
      window.dispatchEvent = function (event) { native.call(this, event); };
    `,
  };
  const DECLARED_LATE = { 'cancels every event': true, 'returns nothing': undefined };
  const wrong = [];
  for (const [name, wrapper] of Object.entries(WRAPPERS)) {
    // Started by the worker after the page wrapped it.
    let tab = world({ readyState: 'complete' });
    tab.realm(wrapper);
    tab.markLate();
    tab.collector();
    tab.bridge();
    tab.realm(`console.error('logged after the late start')`);
    let { collected } = await tab.ask('cdr:get-context');
    if (collected.unavailable || collected.console.length !== 1 || collected.late !== true) {
      wrong.push(`${name}, late: ${JSON.stringify(collected)}`);
    }

    // Declared, after another extension's script wrapped it, and then a
    // second copy: one collector, which says it started with the page.
    tab = world({ readyState: 'loading' });
    tab.realm(wrapper);
    tab.collector();
    tab.bridge();
    tab.collector();
    tab.realm(`console.error('logged once')`);
    ({ collected } = await tab.ask('cdr:get-context'));
    if (collected.console.length !== 1 || collected.late !== DECLARED_LATE[name]) {
      wrong.push(`${name}, declared: ${JSON.stringify(collected)}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test('bridge: the page facts it sends are the ones the prompt prints (TR12)', async () => {
  const tab = world();
  tab.collector();
  tab.bridge();
  const { page } = await tab.ask('cdr:get-context');
  assert.deepEqual(page, {
    url: 'http://localhost/cart',
    title: 'Cart',
    viewport: { width: 1280, height: 800, dpr: 2 },
  });
});

// ---------------------------------------------------------------- F46 --
// The console and network chips were read on focus, when the panel was shown
// and when the pointer came back, so they stayed a snapshot while the panel
// was left alone. The panel now holds a port to the bridge of the tab in view,
// and the bridge posts the two counts as they change.

const EXTENSION = 'test-extension';
const CHANNEL_TYPE = /^__cdr_[0-9a-f]{32}$/;

/** A tab with both halves declared, whose timers the test moves. */
function counted() {
  const clock = makeClock();
  const tab = world({ extensionId: EXTENSION, clock });
  tab.bridge();
  tab.collector();
  return { tab, clock };
}

/** What the page has dispatched since `from`: the collector's signals, and the bridge's asks. */
function traffic(tab, from = 0) {
  const since = tab.dispatched.slice(from);
  return {
    changed: since.filter((type) => /^__cdr_[0-9a-f]{32}:changed$/.test(type)).length,
    asks: since.filter((type) => CHANNEL_TYPE.test(type)).length,
  };
}

test('bridge: a panel\'s port is told the console and network counts as they change, at most four times a second, and nothing else (F46)', async () => {
  const { tab, clock } = counted();
  tab.realm(`console.error('before the panel opened')`);
  const panel = tab.connect('cdr:counts');
  assert.deepEqual(panel.posted, [{ type: 'cdr:counts', console: 1, network: 0 }], 'the counts as the port opened');

  // A line after a quiet spell goes out at once, on the bridge's next turn.
  tab.realm(`console.warn('slow render'); console.error('cart total is NaN')`);
  assert.equal(panel.posted.length, 1, 'posted from inside the page\'s console call');
  await clock.advance(0);
  assert.deepEqual(panel.posted.at(-1), { type: 'cdr:counts', console: 3, network: 0 });

  // A page that logs every 20 ms for a second.
  const from = tab.dispatched.length;
  const firstChange = panel.posted.length - 1;
  for (let i = 0; i < 50; i += 1) {
    tab.realm(i % 2 ? `console.warn('w${i}')` : `console.error('e${i}')`);
    await clock.advance(20);
  }
  await clock.advance(300);
  const changes = panel.at.slice(firstChange);
  for (let i = 1; i < changes.length; i += 1) {
    assert.ok(changes[i] - changes[i - 1] >= 250, `two posts ${changes[i] - changes[i - 1]} ms apart`);
  }
  assert.ok(panel.posted.length <= 7, `${panel.posted.length} posts for a second of logging`);
  assert.ok(traffic(tab, from).asks <= 5, `${traffic(tab, from).asks} asks for a second of logging`);
  assert.deepEqual(panel.posted.at(-1), { type: 'cdr:counts', console: 53, network: 0 }, 'the last count');
  for (const message of panel.posted) assert.deepEqual(Object.keys(message).sort(), ['console', 'network', 'type']);

  // Nothing changed, nothing posted.
  const posts = panel.posted.length;
  await clock.advance(2000);
  assert.equal(panel.posted.length, posts);
  assert.deepEqual(tab.posted, [], 'something was posted to the window');
});

test('bridge: with no panel open on the tab, a page that logs costs nothing more, and closing the panel stops it (F46)', async () => {
  const { tab, clock } = counted();
  const paired = tab.dispatched.length;
  tab.realm(`for (let i = 0; i < 40; i += 1) console.error('before ' + i)`);
  await clock.advance(1000);
  assert.deepEqual(traffic(tab, paired), { changed: 0, asks: 0 }, 'the page did work for no panel');

  const panel = tab.connect('cdr:counts');
  tab.realm(`console.warn('while open')`);
  await clock.advance(1000);
  assert.equal(traffic(tab, paired).changed, 1);
  assert.deepEqual(panel.posted.at(-1), { type: 'cdr:counts', console: 31, network: 0 });

  panel.close();
  const closed = tab.dispatched.length;
  tab.realm(`for (let i = 0; i < 20; i += 1) console.warn('after ' + i)`);
  await clock.advance(1000);
  assert.deepEqual(traffic(tab, closed), { changed: 0, asks: 0 }, 'the page still did work for a closed panel');

  // A second panel later starts it again, from the counts as they are.
  const again = tab.connect('cdr:counts');
  assert.deepEqual(again.posted, [{ type: 'cdr:counts', console: 51, network: 0 }]);
});

test('bridge: Clear posts the zeros at once, and a port from anything but the extension gets nothing (F46)', async () => {
  const { tab, clock } = counted();
  tab.realm(`console.error('x'); console.error('y')`);
  const panel = tab.connect('cdr:counts');
  await tab.ask('cdr:clear-context');
  assert.deepEqual(panel.posted, [
    { type: 'cdr:counts', console: 2, network: 0 },
    { type: 'cdr:counts', console: 0, network: 0 },
  ]);

  const stranger = tab.connect('cdr:counts', { id: 'another-extension', url: 'chrome-extension://another-extension/x.html' });
  tab.realm(`console.error('z')`);
  await clock.advance(500);
  assert.equal(stranger.closed, true, 'the bridge kept a port it did not know');
  assert.deepEqual(stranger.posted, []);
  // Another name is no port of the bridge's, and is left for whoever asked for it.
  const other = tab.connect('cdr:other');
  assert.equal(other.closed, false);
  assert.deepEqual(other.posted, []);
  assert.deepEqual(panel.posted.at(-1), { type: 'cdr:counts', console: 1, network: 0 });
});

test('bridge: a bridge the extension has been reloaded under has the collector stop telling it (F46)', async () => {
  const { tab, clock } = counted();
  const panel = tab.connect('cdr:counts');
  // Its context is gone, and with it, here, the port's close.
  delete tab.isolated.chrome.runtime.id;
  tab.realm(`console.error('after the reload')`);
  await clock.advance(1000);
  const after = tab.dispatched.length;
  tab.realm(`for (let i = 0; i < 10; i += 1) console.error('later ' + i)`);
  await clock.advance(1000);
  assert.deepEqual(traffic(tab, after), { changed: 0, asks: 0 });
  assert.deepEqual(panel.posted, [{ type: 'cdr:counts', console: 0, network: 0 }]);
});

// Seen in Chrome 156: a page going into the back/forward cache has its ports
// closed with no onDisconnect at this end, and a post to one does not throw,
// so the collector went on saying every change after the panel had closed.
test('bridge: a page going into the back/forward cache keeps no port, and a pagehide a page script sends changes nothing (F46)', async () => {
  const { tab, clock } = counted();
  const panel = tab.connect('cdr:counts');
  tab.realm(`window.dispatchEvent(new Event('pagehide')); console.error('still followed')`);
  await clock.advance(300);
  assert.deepEqual(panel.posted.at(-1), { type: 'cdr:counts', console: 1, network: 0 }, 'a page script stopped the counts');

  // Into the cache: Chrome would close the port and say nothing here, so
  // the bridge closes it first, and the panel hears it.
  tab.fire('pagehide');
  assert.equal(panel.closed, true, 'the port to a page in the cache was left open');
  const hidden = tab.dispatched.length;
  const posts = panel.posted.length;
  tab.realm(`for (let i = 0; i < 10; i += 1) console.error('in the cache ' + i)`);
  await clock.advance(1000);
  assert.deepEqual(traffic(tab, hidden), { changed: 0, asks: 0 }, 'the collector went on saying so');
  assert.equal(panel.posted.length, posts);

  // Restored: the panel connects again, and is told the counts as they are.
  const again = tab.connect('cdr:counts');
  assert.deepEqual(again.posted, [{ type: 'cdr:counts', console: 11, network: 0 }]);
});

// The channel's rule (CO14) holds for the counts too: the events they add are
// typed by the channel's name, and none is sent while a request is answered.
test('bridge: a page never learns the channel from the counts, and a channel of its own cannot hold them back (F46, CO14)', async () => {
  const { tab, clock } = counted();
  tab.realm(`
    window.spy = { channel: null, heard: 0, changed: 0 };
    const learn = (type) => {
      const name = /^__cdr_[0-9a-f]{32}/.exec(String(type));
      if (name && name[0] !== '__cdr_${'f'.repeat(32)}') spy.channel = name[0];
    };
    const native = Object.getOwnPropertyDescriptor(CustomEvent.prototype, 'detail');
    Object.defineProperty(CustomEvent.prototype, 'detail', {
      configurable: true,
      get() { learn(this.type); return native.get.call(this); },
    });
    for (const key of ['bubbles', 'cancelable', 'composed', 'detail', 'watched', 'signalled', 'console', 'network', 'listener']) {
      Object.defineProperty(Object.prototype, key, {
        configurable: true,
        get() { learn(window.event && window.event.type); return undefined; },
        set(value) {
          learn(window.event && window.event.type);
          Object.defineProperty(this, key, { value, writable: true, enumerable: true, configurable: true });
        },
      });
    }
    for (const type of ['__cdr_hello', 'message', '__cdr_probe']) window.addEventListener(type, () => { spy.heard += 1; });
    // A channel of its own, which it watches and never asks the counts on,
    // and whose signal it answers by logging again.
    const own = '__cdr_${'f'.repeat(32)}';
    window.dispatchEvent(new CustomEvent('__cdr_hello', { detail: 'bridge ' + own }));
    window.addEventListener(own + ':changed', () => { spy.changed += 1; console.error('again'); });
    window.dispatchEvent(new CustomEvent(own, { detail: 'watch' }));
  `);
  const panel = tab.connect('cdr:counts');
  for (let i = 0; i < 6; i += 1) {
    tab.realm(`console.error('order 4412 failed for bob@example.com')`);
    await clock.advance(300);
  }
  await tab.ask('cdr:clear-context');
  tab.realm(`console.error('after the clear')`);
  await clock.advance(300);
  assert.equal(tab.page.spy.channel, null, 'the page learned the bridge\'s channel');
  assert.equal(tab.page.spy.heard, 1, 'a page listener heard more than its own HELLO');
  assert.equal(tab.page.spy.changed, 1, 'its own channel was told more than once without asking');
  // 1 before the first line, then the lines and the one 'again' its listener logged.
  assert.deepEqual(panel.posted.map((message) => message.console), [0, 2, 3, 4, 5, 6, 7, 0, 1]);
  assert.deepEqual(tab.errors, []);
});

// The collector says a change once until the bridge asks. A signal lost on
// the way, once, left the chips standing for as long as the port lived, and
// the panel cannot take the counts from a read's reply, which Chrome does not
// keep in order with the port's posts (seen in Chrome for Testing 156).
test('bridge: a change its listener failed to take is posted at the next read, which has the counts follow again, and nothing is reported in the tab (F46)', async () => {
  const { tab, clock } = counted();
  const panel = tab.connect('cdr:counts');
  // The listener runs with all but no stack left: its timer cannot be set.
  const setTimer = tab.isolated.setTimeout;
  let fail = true;
  tab.isolated.setTimeout = (...args) => {
    if (fail) {
      fail = false;
      throw new RangeError('Maximum call stack size exceeded');
    }
    return setTimer(...args);
  };
  tab.realm(`console.error('lost')`);
  await clock.advance(1000);
  tab.realm(`console.error('after it')`);
  await clock.advance(1000);
  assert.deepEqual(tab.errors, [], 'the failure was reported in the tab');
  assert.deepEqual(panel.posted, [{ type: 'cdr:counts', console: 0, network: 0 }], 'no signal was lost, so this shows nothing');

  const { collected } = await tab.ask('cdr:get-context');
  assert.equal(collected.console.length, 2);
  assert.deepEqual(panel.posted.at(-1), { type: 'cdr:counts', console: 2, network: 0 }, 'the read left the chips standing');
  tab.realm(`console.error('followed again')`);
  await clock.advance(300);
  assert.deepEqual(panel.posted.at(-1), { type: 'cdr:counts', console: 3, network: 0 }, 'the counts no longer follow the log');
});

// The page logs from the 1,600 calls nearest the stack's limit on its way
// back. From the nearest 400 nothing was recorded on x64 (Node 22, Linux),
// where recording takes more stack than on arm64: the first entries came
// between 400 and 500 calls from the limit there, and within 400 on arm64.
test('bridge: a page that logs on its way back from a stack overflow has nothing reported in the tab, and the counts match the log by its next line (F46)', async () => {
  const { tab, clock } = counted();
  const panel = tab.connect('cdr:counts');
  tab.realm(`
    let attempts = 0;
    function sweep() {
      try {
        sweep();
      } catch {}
      if (attempts < 1600) {
        attempts += 1;
        try {
          console.warn('deep');
        } catch {}
      }
    }
    sweep();
  `);
  await clock.advance(1000);
  tab.realm(`console.error('with the stack back')`);
  await clock.advance(1000);
  assert.deepEqual(tab.errors, [], 'a failure was reported in the tab');
  const { collected } = await tab.ask('cdr:get-context');
  const logged = collected.console.length + collected.warnings.length + collected.errors.length;
  assert.ok(collected.warnings.length > 0, 'nothing recorded on the way back');
  assert.deepEqual(panel.posted.at(-2), { type: 'cdr:counts', console: logged, network: 0 }, 'followed until the read');
  assert.deepEqual(panel.posted.at(-1), { type: 'cdr:counts', console: logged, network: 0 });
});

// On a page that was open before the extension could start there, the
// bridge says its HELLO where a page listener can hear it.
test('bridge: on a late start, a page that heard the HELLO and asks to unwatch holds the counts only until the next read (F46, F32)', async () => {
  const clock = makeClock();
  const tab = world({ extensionId: EXTENSION, clock });
  tab.realm(`
    window.addEventListener('__cdr_hello', (event) => {
      if (typeof event.detail === 'string' && event.detail.startsWith('bridge ')) window.channel = event.detail.slice(7);
    });
  `);
  tab.markLate();
  tab.collector();
  tab.bridge();
  const panel = tab.connect('cdr:counts');
  tab.realm(`console.error('one')`);
  await clock.advance(300);
  assert.deepEqual(panel.posted.at(-1), { type: 'cdr:counts', console: 1, network: 0 });

  tab.realm(`
    window.dispatchEvent(new CustomEvent(window.channel, { detail: 'unwatch' }));
    for (let i = 0; i < 4; i += 1) console.error('held back ' + i);
  `);
  await clock.advance(1000);
  assert.deepEqual(panel.posted.at(-1), { type: 'cdr:counts', console: 1, network: 0 }, 'the page did not hold the counts back');
  await tab.ask('cdr:get-context');
  assert.deepEqual(panel.posted.at(-1), { type: 'cdr:counts', console: 5, network: 0 }, 'the read left the chips standing');
  tab.realm(`console.error('followed again')`);
  await clock.advance(300);
  assert.deepEqual(panel.posted.at(-1), { type: 'cdr:counts', console: 6, network: 0 }, 'the read did not have the collector watch again');
});

// The same page, sending '<channel>:changed' itself before the panel opens:
// the bridge set a timer to stop watching, by the state it found then, and
// the panel's port opened before it fired. Dropped without being closed, the
// port told the panel nothing, its reads then posted nothing either, and the
// chips stood still until the tab changed.
test('bridge: on a late start, a change event the page sends before the panel connects does not drop the panel\'s port, and a port the bridge drops is closed (F46, F32)', async () => {
  const clock = makeClock();
  const tab = world({ extensionId: EXTENSION, clock });
  tab.realm(`
    window.addEventListener('__cdr_hello', (event) => {
      if (typeof event.detail === 'string' && event.detail.startsWith('bridge ')) window.channel = event.detail.slice(7);
    });
  `);
  tab.markLate();
  tab.collector();
  tab.bridge();
  tab.realm(`window.dispatchEvent(new CustomEvent(window.channel + ':changed'))`);
  const panel = tab.connect('cdr:counts');
  await clock.advance(0);
  tab.realm(`console.error('one')`);
  await clock.advance(300);
  assert.deepEqual(panel.posted.at(-1), { type: 'cdr:counts', console: 1, network: 0 }, 'the port was dropped');
  tab.realm(`console.error('two')`);
  await tab.ask('cdr:get-context');
  assert.deepEqual(panel.posted.at(-1), { type: 'cdr:counts', console: 2, network: 0 });

  // The extension reloaded under this bridge: the port it drops is closed,
  // so that the panel takes the counts from its reads again.
  await clock.advance(1000);
  delete tab.isolated.chrome.runtime.id;
  tab.realm(`console.error('three')`);
  await clock.advance(300);
  assert.equal(panel.closed, true, 'a port the bridge stopped posting to was left open');
});

// With the panel's port kept, the same page can answer every ask in the
// collector's place and say a change as it answers. The timer each such
// change set was overwritten by the gap's, and both ran: the bridge asked
// and posted to the panel tens of thousands of times a second in Chrome.
test('bridge: on a late start, a page that answers in the collector\'s place and says a change at every ask is still asked at most four times a second (F46, F32)', async () => {
  const clock = makeClock();
  const tab = world({ extensionId: EXTENSION, clock });
  tab.realm(`
    window.asks = 0;
    window.addEventListener('__cdr_hello', (event) => {
      if (typeof event.detail !== 'string' || !event.detail.startsWith('bridge ')) return;
      const channel = event.detail.slice(7);
      window.addEventListener(channel, (ask) => {
        if (ask.detail !== 'counts' && ask.detail !== 'watch') return;
        // Silent after 500, so that a bridge asking in a loop ends.
        if ((window.asks += 1) > 500) return;
        window.dispatchEvent(new CustomEvent(channel + ':reply', { detail: { console: window.asks % 90, network: 0 } }));
        window.dispatchEvent(new CustomEvent(channel + ':changed'));
      });
    });
  `);
  tab.markLate();
  tab.collector();
  tab.bridge();
  const panel = tab.connect('cdr:counts');
  const from = tab.page.asks;
  await clock.advance(1000);
  const asks = tab.page.asks - from;
  assert.ok(asks <= 6, `${asks} asks in a second`);
  assert.ok(panel.posted.length <= 7, `${panel.posted.length} posts in a second`);
});

// ------------------------------------------------------ the name on hover --
// While Element is armed the picker asks, from the extension's world, the
// name of the component behind the highlighted element, with an event sent
// on the node itself (see the name request in collector-main.js).

test('bridge: a name asked from the extension\'s world on a node is answered before dispatchEvent returns, from the page\'s own wrapper, as a copy', () => {
  const tab = world();
  tab.bridge();
  tab.collector();
  const button = tab.node();
  tab.page.button = button.main;
  // React's expando, which only the page's world can see.
  tab.realm(`
    button.__reactFiber$k = { tag: 5, type: 'button', return: { tag: 0, type: function Total() {}, return: null } };
  `);
  assert.deepEqual(Object.keys(button.isolated).filter((key) => key.startsWith('__react')), []);
  const { heard, detail } = askName(tab, button);
  assert.equal(heard, true, 'no answer before dispatchEvent returned');
  assert.deepEqual(plain(detail), { name: 'Total', renamed: false });
  assert.notEqual(Object.getPrototypeOf(detail), tab.realm('Object.prototype'), 'the page world\'s own object crossed');
  // Nothing posted, and nothing for a node with no component but a null.
  assert.deepEqual(tab.posted, []);
  const plainNode = askName(tab, tab.node());
  assert.equal(plainNode.heard, true);
  assert.equal(plainNode.detail, null);
  assert.deepEqual(tab.errors, []);
});

test('bridge: a name asked from inside an open shadow root is the node\'s own, read off the path, and only a composed question gets out', () => {
  const tab = world();
  tab.collector();
  const host = tab.node();
  const inner = tab.node({ host: host.record });
  tab.page.inner = inner.main;
  tab.page.host = host.main;
  tab.realm(`
    inner.__reactFiber$k = { tag: 5, type: 'button', return: { tag: 0, type: function SaveButton() {}, return: null } };
    host.__reactFiber$k = { tag: 5, type: 'x-card', return: { tag: 0, type: function Card() {}, return: null } };
  `);
  assert.deepEqual(plain(askName(tab, inner).detail), { name: 'SaveButton', renamed: false });
  assert.equal(askName(tab, inner, { composed: false }).heard, false, 'heard from inside the root without composed');
  // A page that replaced the path and the target later is not read through.
  tab.realm(`
    Event.prototype.composedPath = function () { return [host]; };
    Object.defineProperty(Event.prototype, 'target', { configurable: true, get() { return host; } });
  `);
  assert.deepEqual(plain(askName(tab, inner).detail), { name: 'SaveButton', renamed: false });
});

test('bridge: page code that runs while a name is read sees the name request, never the log channel, and gets no log', async () => {
  const tab = world();
  tab.bridge();
  tab.collector();
  const button = tab.node();
  tab.page.button = button.main;
  tab.realm(`
    window.seen = [];
    window.guessed = 0;
    const Total = function Total() {};
    // A getter of the page's on what the collector reads for the name.
    Object.defineProperty(Total, 'displayName', {
      get() {
        seen.push(window.event && window.event.type);
        return undefined;
      },
    });
    button.__reactFiber$k = { tag: 5, type: 'button', return: { tag: 0, type: Total, return: null } };
    console.error('order 4412 failed for bob@example.com');
  `);
  assert.deepEqual(plain(askName(tab, button).detail), { name: 'Total', renamed: false });
  const { collected } = await tab.ask('cdr:get-context');
  assert.deepEqual(collected.console.map((entry) => entry.text), ['order 4412 failed for bob@example.com']);
  const seen = plain(tab.page.seen);
  assert.ok(seen.length > 0, 'the getter never ran');
  assert.deepEqual([...new Set(seen)], ['__cdr_name']);
  // A channel the page makes up is not one the collector listens on.
  tab.realm(`
    const guess = '__cdr_' + '0123456789abcdef'.repeat(2);
    window.addEventListener(guess + ':reply', () => { guessed += 1; });
    window.dispatchEvent(new CustomEvent(guess, { detail: 'snapshot' }));
  `);
  assert.equal(tab.page.guessed, 0);
  assert.deepEqual(tab.posted, []);
});
