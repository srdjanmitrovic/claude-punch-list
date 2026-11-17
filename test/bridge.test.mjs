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
 * conversation between the two halves, what the bridge hands the panel, and
 * what a page script can reach of it, not Chrome.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeWorlds } from './support/worker-realm.mjs';

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
  };
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

test('bridge: whatever answers in the collector\'s place is rebuilt to the shape the panel reads (CO11)', async () => {
  const hostile = {
    console: Array.from({ length: 500 }, (_, i) => ({
      level: 'error',
      text: 'x'.repeat(100000),
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
  const overMessage = world();
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
