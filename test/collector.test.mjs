/**
 * content/collector-main.js, run for real in a fresh JavaScript realm.
 *
 * The collector runs on every page the user visits, so CONTRIBUTING.md holds
 * every wrapper to four rules: preserve `this`, pass return values through,
 * re-reject rejections, and swallow its own errors. These tests hold it to
 * them. The window here is the smallest one the file arms against; nothing in
 * it is a browser, so what it proves is the wrapping, not Chrome.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../content/collector-main.js', import.meta.url), 'utf8');

// Values made in the other realm have that realm's prototypes, which strict
// deep equality would reject. Everything the collector hands out has to
// survive structured clone anyway, so a JSON round trip loses nothing here.
const plain = (value) => JSON.parse(JSON.stringify(value));

/**
 * Elements with as much of the DOM as the collector reads from one: a tag,
 * attributes, and an input's value behind a getter on its prototype, as
 * Chrome has them. Only for the tests that pass { dom: true }; the others
 * keep the bare Element the file has always armed against.
 */
function domClasses() {
  // Every element made is in the document, as a rendered one is, unless it
  // is put in a shadow root.
  const all = [];
  class Element {
    constructor(tag, attributes = {}) {
      this.tag = tag;
      this.attributes = { ...attributes };
      this.parentElement = null;
      all.push(this);
    }
    get tagName() {
      return this.tag.toUpperCase();
    }
    getAttribute(name) {
      return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
    }
    getAttributeNames() {
      return Object.keys(this.attributes);
    }
    removeAttribute(name) {
      delete this.attributes[name];
    }
    // An open shadow root, when a test gives the element one.
    get shadowRoot() {
      return this.shadow ?? null;
    }
    // A child put under this one, for a test that builds a tree. Returns the
    // child, as appendChild does.
    append(child) {
      child.parentElement = this;
      (this.kids ||= []).push(child);
      return child;
    }
    // The elements under this one, in document order, as Chrome's live list
    // has them: '*' or a tag.
    getElementsByTagName(tag) {
      const found = [];
      const visit = (element) => {
        for (const child of element.kids || []) {
          if (tag === '*' || child.tag === tag) found.push(child);
          visit(child);
        }
      };
      visit(this);
      return found;
    }
  }
  // querySelector and querySelectorAll, for the selectors the collector
  // uses: tag, tag[name], and tag[name="value" i] with =, *=, ^= or ~=, the
  // tag optional, joined by commas. Anything else throws, so that a
  // selector this does not understand cannot pass for one that matched
  // nothing.
  const matches = (element, selector) =>
    selector.split(',').some((part) => {
      const match = /^([a-z-]*)(?:\[([a-z-]+)(?:(\*=|\^=|~=|=)"([^"]*)" i)?\])?$/.exec(part.trim());
      if (!match || (!match[1] && !match[2])) throw new Error(`selector not understood: ${part}`);
      const [, tag, name, operator, wanted] = match;
      if (tag && element.tag !== tag) return false;
      if (!name) return true;
      const raw = element.getAttribute(name);
      if (!operator) return raw !== null;
      const value = (raw ?? '').toLowerCase();
      if (operator === '=') return value === wanted;
      if (operator === '~=') return value.split(/\s+/).includes(wanted);
      return operator === '*=' ? value.includes(wanted) : value.startsWith(wanted);
    });
  class DocumentFragment {
    constructor(children = []) {
      this.children = children;
      for (const child of children) child.inShadow = true;
    }
    querySelector(selector) {
      return this.children.find((child) => matches(child, selector)) ?? null;
    }
    // '*' too, for every element of the root.
    querySelectorAll(selector) {
      return selector === '*' ? [...this.children] : this.children.filter((child) => matches(child, selector));
    }
  }
  // The document's querySelectorAll and getElementsByTagName, over every
  // element not in a shadow root, in the order they were made. A test sets
  // querySelector itself.
  class Document {
    querySelector() {
      return null;
    }
    querySelectorAll(selector) {
      return all.filter((element) => !element.inShadow && matches(element, selector));
    }
    getElementsByTagName(tag) {
      return all.filter((element) => !element.inShadow && (tag === '*' || element.tag === tag));
    }
  }
  const valued = () =>
    class extends Element {
      get value() {
        return this.current ?? '';
      }
      set value(text) {
        this.current = String(text);
      }
    };
  return {
    Element,
    DocumentFragment,
    Document,
    document: new Document(),
    HTMLInputElement: valued(),
    HTMLTextAreaElement: valued(),
    HTMLSelectElement: valued(),
  };
}

function arm({ fetch, before, dom = false, loading = false } = {}) {
  const nativeCalls = [];
  const listeners = new Map();
  const posted = [];

  // The collector takes addEventListener from here at load, as it does in
  // Chrome, so a page that patches it later is not involved.
  class FakeEventTarget {
    addEventListener(type, handler) {
      (this.handlers[type] ||= []).push(handler);
    }
  }

  // What Chrome says to a method of XMLHttpRequest called on anything else,
  // before it looks at the arguments.
  const brand = (self) => {
    if (!(self instanceof FakeXHR)) throw new TypeError('Illegal invocation');
  };

  // Only as much of XMLHttpRequest as the collector touches, behaving as
  // Chrome was observed to (Chrome for Testing 156): open() moves the object
  // back to OPENED, clears the status and fires readystatechange on the way,
  // and events keep being dispatched to every listener even after a handler
  // has reopened or aborted the object.
  class FakeXHR extends FakeEventTarget {
    constructor() {
      super();
      this.readyState = 0;
      this.status = 0;
      this.statusText = '';
      this.handlers = {};
      this.sends = 0;
      this.inFlight = false;
      this.async = true;
      // Chrome's own error flag: raised by an end with no response, and
      // lowered by a request that completes, a nested synchronous one included.
      this.error = false;
      // Set by a test to make the next synchronous send() fail at the network
      // level, which in Chrome throws and fires no event at all.
      this.syncNetworkFailure = false;
      // What a synchronous send() answers with, set by a test that needs another.
      this.syncResponse = { status: 200, statusText: 'OK' };
    }
    open(method, url, async = true) {
      brand(this);
      // A call Chrome refuses throws before anything on the object changes.
      if (arguments.length < 2) {
        throw new TypeError(
          `Failed to execute 'open' on 'XMLHttpRequest': 2 arguments required, but only ${arguments.length} present.`
        );
      }
      if (/\s/.test(method)) throw new SyntaxError(`'${method}' is not a valid HTTP method.`);
      const wasOpened = this.readyState === 1;
      this.opened = [method, url];
      this.async = async !== false;
      this.readyState = 1;
      this.status = 0;
      this.statusText = '';
      this.inFlight = false;
      if (!wasOpened) this.dispatch('readystatechange');
      return 'native-open';
    }
    send() {
      brand(this);
      if (this.readyState !== 1 || this.inFlight) {
        throw new DOMException(
          "Failed to execute 'send' on 'XMLHttpRequest': The object's state must be OPENED.",
          'InvalidStateError'
        );
      }
      this.sends += 1;
      if (!this.async) {
        if (this.syncNetworkFailure) {
          this.syncNetworkFailure = false;
          this.readyState = 4;
          this.status = 0;
          this.error = true;
          throw new DOMException("Failed to execute 'send' on 'XMLHttpRequest'.", 'NetworkError');
        }
        // A synchronous request runs to the end inside send(): readystatechange,
        // load and loadend all fire before it returns.
        const { status, statusText } = this.syncResponse;
        this.finish(status, statusText, ['readystatechange', 'load']);
        return 'native-send';
      }
      this.inFlight = true;
      return 'native-send';
    }
    abort() {
      brand(this);
      // In flight, the request ends here: abort, then loadend, while DONE.
      if (this.inFlight && this.readyState !== 4) this.finish(0, '', ['readystatechange', 'abort']);
      // Then UNSENT with no status, unless a handler of that abort has
      // reopened the object meanwhile. For a request that had already
      // finished, this is all that happens: no event at all, and whatever of
      // its own dispatch is still to come arrives afterwards.
      this.inFlight = false;
      if (this.readyState === 4) {
        this.readyState = 0;
        this.status = 0;
        this.statusText = '';
      }
      return 'native-abort';
    }
    // To the listeners there when the dispatch starts, in the order they
    // were added, until one stops it. Chrome 156 keeps that order on a target
    // outside the DOM whatever the capture flag says, so a capturing
    // listener of the collector's would not run first either.
    dispatch(type) {
      const event = {
        type,
        stopped: false,
        stopImmediatePropagation() {
          this.stopped = true;
        },
      };
      for (const handler of [...(this.handlers[type] || [])]) {
        handler(event);
        if (event.stopped) break;
      }
    }
    // Chrome's order: readystatechange, then load, abort, timeout or error,
    // then loadend, all while the object is DONE.
    finish(status, statusText = '', before = [], { loadend = true } = {}) {
      this.inFlight = false;
      this.readyState = 4;
      this.status = status;
      this.statusText = statusText;
      const failed = before.some((type) => type === 'abort' || type === 'timeout' || type === 'error');
      this.error = failed;
      for (const type of loadend ? [...before, 'loadend'] : before) {
        this.dispatch(type);
        // After the readystatechange of a request that failed, Chrome reads
        // its error flag again. If a handler has run a synchronous request to
        // the end meanwhile, the flag is down and the object DONE, and Chrome
        // dispatches load and loadend once more before the failed request's
        // own events (seen on 156 after an abort and after a timeout).
        if (type === 'readystatechange' && failed && this.readyState === 4 && !this.error) {
          this.dispatch('load');
          this.dispatch('loadend');
        }
      }
    }
  }

  // Milliseconds, moved by a test that checks how long a request took.
  const clock = { now: 0 };

  const page = {
    console: {
      error(...args) {
        nativeCalls.push({ level: 'error', args, self: this });
        return 'native-error';
      },
      warn(...args) {
        nativeCalls.push({ level: 'warn', args, self: this });
        return 'native-warn';
      },
    },
    fetch,
    XMLHttpRequest: FakeXHR,
    EventTarget: FakeEventTarget,
    setTimeout,
    performance: { now: () => clock.now },
    Element: class Element {},
    document: { querySelector: () => null },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    // Synchronous, as DOM dispatch is: the collector's guard and the
    // channel the bridge reads the log over both depend on that.
    dispatchEvent(event) {
      for (const listener of [...(listeners.get(event.type) || [])]) listener(event);
      return !event.defaultPrevented;
    },
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail ?? null;
        this.cancelable = Boolean(init.cancelable);
        this.defaultPrevented = false;
      }
      preventDefault() {
        if (this.cancelable) this.defaultPrevented = true;
      }
    },
    postMessage(data) {
      posted.push(data);
    },
  };
  if (dom) Object.assign(page, domClasses());
  // A document still loading is a start at document_start, before any of
  // the page's scripts; any other is a late start (see startedLate).
  if (loading) page.document.readyState = 'loading';
  page.window = page;
  vm.createContext(page);

  const run = () => vm.runInContext(SOURCE, page, { filename: 'collector-main.js' });
  // Code of the page's own that ran first, which no page can do in Chrome
  // but a test can, to watch what the collector calls.
  if (before) vm.runInContext(before, page);
  run();

  // Inside the realm `window` is the context's global proxy, not `page`
  // itself, and the collector only answers messages whose source is its own
  // window. So the request has to name the window the collector sees.
  const self = vm.runInContext('window', page);

  // The log is read over the channel the bridge opens with a HELLO, as
  // content/collector-bridge.js does; the picker's inspect still goes over
  // window.postMessage.
  const channel = `__cdr_${'0123456789abcdef'.repeat(2)}`;
  let opened = false;
  function overChannel(action) {
    if (!opened) {
      opened = true;
      page.dispatchEvent(new page.CustomEvent('__cdr_hello', { detail: `bridge ${channel}` }));
    }
    let reply;
    const take = (event) => {
      reply = event.detail;
    };
    page.addEventListener(`${channel}:reply`, take);
    page.dispatchEvent(new page.CustomEvent(channel, { detail: action }));
    listeners.set(`${channel}:reply`, listeners.get(`${channel}:reply`).filter((one) => one !== take));
    return reply === undefined ? undefined : plain(reply);
  }

  let nextId = 0;
  function request(action, extra = {}) {
    if (['snapshot', 'clear', 'watch', 'unwatch', 'counts'].includes(action)) return overChannel(action);
    nextId += 1;
    const data = { __cdr: 'request', action, id: nextId, ...extra };
    for (const listener of listeners.get('message') || []) listener({ source: self, data });
    const reply = posted.findLast((message) => message.id === nextId);
    return reply ? plain(reply.payload) : undefined;
  }

  function dispatch(type, event) {
    for (const listener of listeners.get(type) || []) listener(event);
  }

  /**
   * The picker's question while it hovers, sent on node (see the name
   * request in collector-main.js), through the page's dispatchEvent: the
   * reply's detail, plain, null for a reply that names nothing, or
   * undefined when nothing answered. This window has no Event, so the
   * collector reads the node off event.target.
   */
  function name(node) {
    let heard = false;
    let detail;
    const take = (event) => {
      heard = true;
      detail = event.detail;
    };
    // Straight into the list, as the picker's listener in its own world is
    // out of reach of what the page replaces in this one.
    if (!listeners.has('__cdr_name:reply')) listeners.set('__cdr_name:reply', []);
    listeners.get('__cdr_name:reply').push(take);
    try {
      page.dispatchEvent({ type: '__cdr_name', target: node });
    } finally {
      listeners.set('__cdr_name:reply', listeners.get('__cdr_name:reply').filter((one) => one !== take));
    }
    if (!heard) return undefined;
    return detail === null ? null : plain(detail);
  }

  return {
    page,
    self,
    clock,
    nativeCalls,
    run,
    request,
    dispatch,
    name,
    snapshot: () => request('snapshot'),
    realm: (code) => vm.runInContext(code, page),
    posted,
    /** The name of the channel request() opens, once it has. */
    channel,
  };
}

const response = (status, statusText = '') => ({ ok: status >= 200 && status < 300, status, statusText });

// ---------------------------------------------------------------- console --

test('collector: console wrappers keep this, arguments and return value', () => {
  const page = arm();
  const result = page.page.console.error('boom', { a: 1 });

  assert.equal(result, 'native-error');
  assert.equal(page.nativeCalls.length, 1);
  assert.equal(page.nativeCalls[0].self, page.page.console);
  assert.deepEqual(plain(page.nativeCalls[0].args), ['boom', { a: 1 }]);
  assert.deepEqual(
    page.snapshot().console.map(({ level, text }) => ({ level, text })),
    [{ level: 'error', text: 'boom {"a":1}' }]
  );
});

test('collector: a value that cannot be serialized still reaches the real console', () => {
  const page = arm();
  // The collector no longer calls a toJSON of the page's, so this one prints
  // as the object it is. A proxy whose traps throw is what still cannot be
  // read at all.
  const hostile = {
    toJSON() {
      throw new Error('nope');
    },
  };
  const unreadable = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('nope');
      },
    }
  );
  assert.equal(page.page.console.warn(hostile), 'native-warn');
  assert.equal(page.nativeCalls[0].args[0], hostile);
  assert.equal(page.page.console.warn(unreadable), 'native-warn');
  assert.equal(page.nativeCalls[1].args[0], unreadable);
  assert.deepEqual(
    page.snapshot().warnings.map((entry) => entry.text),
    ['{}', '[unserializable]']
  );
});

test('collector: warnings have a ring of their own, so a flood of them cannot push out an error', () => {
  const page = arm();
  page.page.console.error('the one that matters');
  for (let i = 1; i <= 50; i += 1) page.page.console.warn(`noise ${i}`);
  const snap = page.snapshot();
  assert.deepEqual(plain(snap.console.map((entry) => entry.text)), ['the one that matters']);
  assert.equal(snap.warnings.length, 30);
  assert.equal(snap.warnings[0].text, 'noise 21');
  assert.deepEqual(plain(snap.dropped), { console: 0, warnings: 20, errors: 0, network: 0 });
});

test('collector: entries carry one count across every ring, so a single millisecond keeps its order', () => {
  const page = arm();
  page.page.console.warn('first');
  page.page.console.error('second');
  page.page.console.warn('third');
  const snap = page.snapshot();
  const order = [...snap.warnings, ...snap.console]
    .sort((a, b) => a.seq - b.seq)
    .map((entry) => entry.text);
  assert.deepEqual(plain(order), ['first', 'second', 'third']);
});

test('collector: times come from the clock the page had at document_start, not one it mocked later', () => {
  const page = arm();
  // MockDate and fake timers replace the global after the page's own scripts
  // start, which is after the collector has armed.
  page.realm('Date.now = () => 0;');
  page.page.console.error('after the page froze its clock');
  const [entry] = page.snapshot().console;
  assert.ok(entry.t >= 0 && entry.t < 5000, `t was ${entry.t}`);
});

test('collector: clear empties every ring and forgets what was dropped', async () => {
  const page = arm();
  for (let i = 1; i <= 35; i += 1) page.page.console.warn(`w ${i}`);
  assert.equal(page.snapshot().dropped.warnings, 5);
  await page.request('clear');
  const snap = page.snapshot();
  assert.equal(snap.warnings.length, 0);
  assert.equal(snap.dropped.warnings, 0);
});

test('collector: a logged object keeps its shape and loses the values of secret looking keys', () => {
  const page = arm();
  page.page.console.error('login failed', {
    user: { name: 'ada', password: 'hunter2', hasPassword: true },
    headers: { Authorization: 'Bearer abc', Accept: 'json' },
    className: 'row',
    passHref: true,
    apiKey: null,
  });
  assert.equal(
    page.snapshot().console[0].text,
    'login failed {"user":{"name":"ada","password":"<redacted>","hasPassword":true},' +
      '"headers":{"Authorization":"<redacted>","Accept":"json"},"className":"row","passHref":true,"apiKey":null}'
  );
});

test('collector: a logged payment nonce loses its value, under any spelling of the name (F43)', () => {
  const page = arm();
  page.page.console.error('tokenize failed', {
    nonce: 'tokencc_bh_F43A',
    details: { paymentMethodNonce: 'F43B', payment_method_nonce: 'F43C', cardNonce: 'F43D' },
    announcement: 'Sale',
  });
  assert.equal(
    page.snapshot().console[0].text,
    'tokenize failed {"nonce":"<redacted>","details":{"paymentMethodNonce":"<redacted>",' +
      '"payment_method_nonce":"<redacted>","cardNonce":"<redacted>"},"announcement":"Sale"}'
  );
});

/**
 * How long a run takes, timed once more if the first run is over the limit,
 * so that a pause of the machine's own (a collection, a busy core) does not
 * fail a test, while work that grows out of bounds is over it both times.
 */
function timed(run, limit) {
  const once = () => {
    const started = performance.now();
    run();
    return performance.now() - started;
  };
  const first = once();
  return first < limit ? first : Math.min(first, once());
}

test('collector: a long key is judged like a short one, and a full cache still judges new keys', () => {
  const page = arm();
  // A cache keyed by url, past the length the per key cache keeps.
  const long = `https://api.test/v1/session/refresh_token?${'x'.repeat(90)}`;
  page.page.console.error({ [long]: 'LONGKEYVAL' });
  assert.ok(!page.snapshot().console[0].text.includes('LONGKEYVAL'));
  // More distinct keys than the cache holds, then a secret one on its own,
  // where the 600 character cut cannot hide it either way.
  page.page.console.error(Object.fromEntries(Array.from({ length: 2100 }, (_, i) => [`field${i}x`, i])));
  page.page.console.error({ sessionToken: 'LATETOKEN' });
  assert.equal(page.snapshot().console[2].text, '{"sessionToken":"<redacted>"}');
  // A very long key is judged by its ends, and costs the same whatever its length.
  const huge = `refresh_token_${'aB'.repeat(50000)}`;
  const hugeRows = Array.from({ length: 200 }, () => ({ [huge]: 'HUGEVAL' }));
  const hugeTook = timed(() => page.page.console.error(hugeRows), 500);
  assert.ok(hugeTook < 500, `took ${Math.round(hugeTook)} ms`);
  assert.ok(!page.snapshot().console.at(-1).text.includes('HUGEVAL'));
  // A long array's indexes do not fill the cache, so a key logged after it
  // is still judged once rather than once a row.
  const fresh = arm();
  fresh.page.console.error(Array.from({ length: 2100 }, (_, i) => i));
  const key = 'aB'.repeat(200);
  const rows = Array.from({ length: 2000 }, () => ({ [key]: 1 }));
  const rowsTook = timed(() => fresh.page.console.error(rows), 100);
  assert.ok(rowsTook < 100, `took ${Math.round(rowsTook)} ms`);
  // A key of digits alone is read no further than the name test would read
  // it, even under a value that prints nothing, which the character budget
  // never counts.
  const digits = '7'.repeat(200000);
  const silent = Array.from({ length: 1900 }, () => ({ [digits]: () => 1 }));
  const numbered = arm();
  const silentTook = timed(() => numbered.page.console.error(silent), 100);
  assert.ok(silentTook < 100, `took ${Math.round(silentTook)} ms`);
  assert.equal(numbered.snapshot().console.at(-1).text, JSON.stringify(silent).slice(0, 600) + ' …[truncated]');
});

// A seeded generator (mulberry32), so that a failure names the same input on
// every run.
function random(seed) {
  return (n) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
}

/** Whether the collector withholds the value logged under each name, read off its log. */
function withheldUnder(page, names) {
  const batches = [[]];
  let size = 0;
  for (const name of new Set(names)) {
    const length = JSON.stringify(name).length + 16;
    if (batches.at(-1).length === 10 || (batches.at(-1).length && size + length > 500)) {
      batches.push([]);
      size = 0;
    }
    batches.at(-1).push(name);
    size += length;
  }
  const verdicts = new Map();
  for (const batch of batches) {
    page.page.console.error(Object.fromEntries(batch.map((name) => [name, 'V'])));
    const logged = JSON.parse(page.snapshot().console.at(-1).text);
    for (const name of batch) verdicts.set(name, logged[name] === '<redacted>');
  }
  return verdicts;
}

test('collector: its name test answers as isSecretName does, the copy the picker and the template share', () => {
  const from = SOURCE.indexOf('// SECRET NAMES BEGIN');
  const to = SOURCE.indexOf('// SECRET NAMES END');
  const { isSecretName, SECRET_WORDS } = new Function(
    `${SOURCE.slice(from, to)}\nreturn { isSecretName, SECRET_WORDS };`
  )();
  // As the collector applies it to a key: an index is never a field name, and
  // every key whose value can show is judged whole, however long (F21).
  const expected = (name) => (/^\d+$/.test(name) ? false : isSecretName(name));

  const rand = random(1);
  const pick = (list) => list[rand(list.length)];
  const word = () => {
    const secret = pick(SECRET_WORDS);
    return pick([
      secret,
      secret.toUpperCase(),
      secret[0].toUpperCase() + secret.slice(1),
      `${secret}s`,
      `${secret}${rand(99)}`,
      secret.slice(0, rand(secret.length)),
      secret.slice(rand(secret.length)),
    ]);
  };
  // Pieces that split, join and turn: camel humps, capital runs, digits, and
  // separators inside and outside ASCII.
  const PIECES = [
    'pass', 'Word', 'PIN', 'code', 'Number', 'cc', 'Auth', 'oken', 'HTTP', 'Server', 'Id', 'ID',
    'x', 'A', '1', '22', '_', '-', ' ', '.', '$', 'é', 'ÉMAIL', '\u{1F511}', 'Sess', 'Api', 'Phones',
  ];
  const name = (length, piece) => {
    let text = '';
    while (text.length < length) text += piece();
    return text;
  };
  const names = [];
  for (const secret of SECRET_WORDS) {
    names.push(secret, secret.toUpperCase(), `my${secret[0].toUpperCase()}${secret.slice(1)}`, `${secret}2`);
  }
  // Digits alone, longer than any array index and either side of 400
  // characters, and long keys with digits at both ends: a word at one end,
  // in the middle, or no word at all.
  const digits = (count) => '7'.repeat(count);
  names.push(
    '12345678901',
    digits(17),
    digits(400),
    digits(450),
    `${digits(195)}token${digits(300)}`,
    `${digits(300)}token${digits(195)}`,
    `${digits(250)}password${digits(250)}`,
    `${digits(200)}x${digits(250)}`
  );
  for (let i = 0; i < 6000; i += 1) {
    names.push(name(1 + rand(30), () => (rand(3) ? pick(PIECES) : word())));
  }
  for (let i = 0; i < 300; i += 1) {
    let text = name(401 + rand(120), () => (rand(4) ? pick(PIECES) : word()));
    // A word across one of the two cuts.
    const piece = word();
    const at = (rand(2) ? 200 : text.length - 200) - rand(piece.length + 1);
    text = text.slice(0, at) + piece + text.slice(at + piece.length);
    names.push(text);
  }

  const verdicts = withheldUnder(arm(), names);
  const wrong = names.filter((one) => verdicts.get(one) !== expected(one));
  assert.deepEqual(wrong.slice(0, 5), []);
  const secret = names.filter(expected).length;
  assert.ok(secret > 1000 && names.length - secret > 1000, `${secret} of ${names.length} secret`);
});

test('collector: a page that replaces a builtin after it armed cannot make a secret key read as harmless', () => {
  const long = `refresh_token_${'q'.repeat(400)}`;
  const logged = { user: 'ada', authtoken: 'T1', my_pin_code: 'T2', [long]: 'T3' };
  const expected =
    `{"user":"ada","authtoken":"<redacted>","my_pin_code":"<redacted>","${long}":"<redacted>"}`;
  for (const code of [
    'String.prototype.split = function () { return []; };',
    'RegExp.prototype[Symbol.split] = function () { return []; };',
    'RegExp.prototype.exec = function () { return null; };',
    'RegExp.prototype.test = function () { return true; };',
    "String.prototype.toLowerCase = function () { return ''; };",
    "String.prototype.replace = function () { return ''; };",
    'String.prototype.startsWith = String.prototype.endsWith = function () { return false; };',
    "String.prototype.slice = function () { return ''; };",
    'Array.prototype.some = function () { return false; };',
    'Array.prototype.filter = function () { return []; };',
    'Map.prototype.get = function () { return false; };',
    'Map = class { get() { return false; } set() { return this; } };',
    'JSON.stringify = ((stringify) => (value) => stringify(value))(JSON.stringify);',
  ]) {
    const page = arm();
    page.realm(code);
    page.page.console.error(logged);
    assert.equal(page.snapshot().console[0].text, expected, code);
  }
});

test('collector: a logged value stops adding members once far more than the cut is printed, and reads the same', () => {
  const page = arm({
    before: `
      const stringify = JSON.stringify;
      globalThis.printedLengths = [];
      JSON.stringify = function (...args) {
        const text = stringify.apply(this, args);
        printedLengths.push(typeof text === 'string' ? text.length : 0);
        return text;
      };
    `,
  });
  // Fifty rows of ten keys 20 000 characters long, ten million characters in
  // all, and one string of a million.
  const keys = Array.from({ length: 10 }, (_, k) => `column${k}_${'q'.repeat(20000)}`);
  const rows = Array.from({ length: 50 }, () => Object.fromEntries(keys.map((key) => [key, 'cell'])));
  const blob = { blob: 'z'.repeat(1000000) };
  // The same with keys of digits alone, which an object prints as it does
  // any other name, unlike an array its indexes.
  const numbered = Array.from({ length: 10 }, (_, k) => `${k + 1}${'0'.repeat(20000)}`);
  const numberedRows = Array.from({ length: 50 }, () =>
    Object.fromEntries(numbered.map((key) => [key, 1]))
  );
  page.page.console.error(rows);
  page.page.console.error(blob);
  page.page.console.error(numberedRows);
  const cut = (value) => `${JSON.stringify(value).slice(0, 600)} …[truncated]`;
  assert.deepEqual(
    page.snapshot().console.map((entry) => entry.text),
    [cut(rows), cut(blob), cut(numberedRows)]
  );
  const printed = [...page.realm('printedLengths')];
  assert.ok(Math.max(...printed) < 40000, `printed ${printed.join(', ')} characters`);

  // A getter is never called, so one that throws, beside the value that
  // filled the line or anywhere else, changes nothing.
  const fresh = arm();
  fresh.page.console.error({
    a: 'x'.repeat(7000),
    b: {
      get c() {
        throw new Error('never read');
      },
    },
  });
  fresh.page.console.error({
    a: 'x'.repeat(7000),
    get b() {
      throw new Error('read');
    },
  });
  // A proxy of an array that the page revokes from its own trap, halfway
  // through the walk, prints as it would with no budget at all.
  const { proxy, revoke } = Proxy.revocable(['a', 'b'], {
    get(target, key) {
      if (key === '1') revoke();
      return target[key];
    },
  });
  fresh.page.console.error(proxy);
  assert.deepEqual(
    fresh.snapshot().console.map((entry) => entry.text),
    [`{"a":"${'x'.repeat(594)} …[truncated]`, `{"a":"${'x'.repeat(594)} …[truncated]`, '["a","b"]']
  );
});

test('collector: under its budgets, a value with no secret in it reads as JSON.stringify prints it', () => {
  const rand = random(3);
  // Letters that spell no secret word, and digits.
  const name = () =>
    Array.from({ length: 1 + rand(rand(8) ? 12 : 700) }, () => 'qvwxyzkj_0123456789'[rand(19)]).join('');
  const make = (depth) => {
    switch (rand(depth > 2 ? 4 : 7)) {
      case 0:
        return 'qv'.repeat(rand(rand(6) ? 20 : 4000));
      case 1:
        return rand(1000) - 500;
      case 2:
        return rand(2) === 0;
      case 3:
        return null;
      case 4:
        return Array.from({ length: rand(6) }, () => make(depth + 1));
      default:
        return Object.fromEntries(Array.from({ length: rand(6) }, () => [name(), make(depth + 1)]));
    }
  };
  const page = arm();
  for (let i = 0; i < 400; i += 1) {
    const value = Object.fromEntries(Array.from({ length: 1 + rand(4) }, () => [name(), make(0)]));
    page.page.console.error(value);
    const json = JSON.stringify(value);
    assert.equal(
      page.snapshot().console.at(-1).text,
      json.length > 600 ? `${json.slice(0, 600)} …[truncated]` : json
    );
  }
});

test('collector: each ring keeps the last 30 entries', () => {
  const page = arm();
  for (let i = 1; i <= 35; i += 1) page.page.console.error(`error ${i}`);
  const texts = page.snapshot().console.map((entry) => entry.text);
  assert.equal(texts.length, 30);
  assert.equal(texts[0], 'error 6');
  assert.equal(texts.at(-1), 'error 35');
  assert.equal(page.snapshot().dropped.console, 5);
});

// ------------------------------------------------------------------ fetch --

test('collector: fetch passes the response and this through, and records a 500', async () => {
  let receiver;
  const served = response(500, 'Internal Server Error');
  const page = arm({
    fetch(...args) {
      receiver = this;
      return Promise.resolve(served);
    },
  });

  const returned = await page.page.fetch('/api/coupons', { method: 'post' });
  assert.equal(returned, served);
  assert.equal(receiver, page.page);

  const [entry] = page.snapshot().network;
  assert.equal(entry.method, 'POST');
  assert.equal(entry.url, '/api/coupons');
  assert.equal(entry.status, 500);
  assert.equal(entry.statusText, 'Internal Server Error');
  assert.equal(entry.via, 'fetch');
});

test('collector: fetch records nothing for a successful response', async () => {
  const page = arm({ fetch: () => Promise.resolve(response(200, 'OK')) });
  await page.page.fetch('/api/cart');
  assert.deepEqual(page.snapshot().network, []);
});

test('collector: a fetch rejection reaches the page as the same error', async () => {
  const failure = new TypeError('Failed to fetch');
  const page = arm({ fetch: () => Promise.reject(failure) });

  await assert.rejects(page.page.fetch('/api/cart'), (error) => error === failure);
  const [entry] = page.snapshot().network;
  assert.equal(entry.status, 0);
  assert.equal(entry.statusText, 'Network failure: Failed to fetch');
});

test('collector: fetch does not list responses that did not fail', async () => {
  // What Chrome hands back for a no-cors request, a redirect: 'manual' request
  // and a conditional request. All three have ok false; none of them failed.
  const served = [
    { ok: false, status: 0, statusText: '', type: 'opaque' },
    { ok: false, status: 0, statusText: '', type: 'opaqueredirect' },
    { ok: false, status: 304, statusText: 'Not Modified', type: 'basic' },
  ];
  const page = arm({ fetch: () => Promise.resolve(served.shift()) });
  for (let i = 0; i < 3; i += 1) await page.page.fetch(`/asset/${i}`);
  assert.deepEqual(page.snapshot().network, []);
});

test('collector: a fetch the page aborted is labelled, whatever it was aborted with', async () => {
  for (const reason of [undefined, 'effect cleanup', new Error('superseded')]) {
    const controller = new AbortController();
    const page = arm({
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        }),
    });
    const pending = page.page.fetch('/api/search?q=ab', { signal: controller.signal });
    controller.abort(reason);
    await assert.rejects(pending);

    const [entry] = page.snapshot().network;
    assert.equal(entry.outcome, 'aborted', `abort(${String(reason)})`);
    assert.equal(entry.statusText, '');
    assert.equal(entry.status, 0);
  }
});

test('collector: requests the page cancelled leave the ring before a real failure does', async () => {
  let call = 0;
  const page = arm({
    fetch: (_url, init) => {
      call += 1;
      if (call === 1) return Promise.reject(new TypeError('Failed to fetch'));
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      });
    },
  });
  await assert.rejects(page.page.fetch('/api/checkout'));
  // A type-ahead: one request per keystroke, each cancelled by the next.
  for (let i = 0; i < 40; i += 1) {
    const controller = new AbortController();
    const pending = page.page.fetch(`/api/search?q=${i}`, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending);
  }
  const { network } = page.snapshot();
  assert.equal(network.length, 30);
  assert.equal(network[0].url, '/api/checkout', 'the real failure was pushed out by cancelled requests');
  assert.equal(network.at(-1).url, '/api/search?q=39');
});

test('collector: a fetch that hit its own timeout is labelled as one', async () => {
  const controller = new AbortController();
  const page = arm({ fetch: (_url, init) => Promise.reject(init.signal.reason) });
  controller.abort(new DOMException('signal timed out', 'TimeoutError'));
  await assert.rejects(page.page.fetch('/api/slow', { signal: controller.signal }));
  assert.equal(page.snapshot().network[0].outcome, 'timeout');
});

test('collector: an explicit signal: null overrides the Request signal, as fetch itself does', async () => {
  const controller = new AbortController();
  controller.abort();
  const failure = new TypeError('Failed to fetch');
  const page = arm({ fetch: () => Promise.reject(failure) });
  const request = { url: '/api/cart', method: 'GET', signal: controller.signal };

  await assert.rejects(page.page.fetch(request, { signal: null }), (error) => error === failure);
  const [entry] = page.snapshot().network;
  assert.equal(entry.outcome, undefined);
  assert.equal(entry.statusText, 'Network failure: Failed to fetch');
});

test("collector: fetch puts the page's Error.stackTraceLimit back", async () => {
  const page = arm({ fetch: () => Promise.resolve(response(404)) });
  page.realm('Error.stackTraceLimit = 42');
  await page.page.fetch('/missing');
  assert.equal(page.realm('Error.stackTraceLimit'), 42);
});

// -------------------------------------------------------------------- XHR --

test('collector: XHR open, send and abort return what the native methods return', () => {
  const page = arm();
  const xhr = new page.page.XMLHttpRequest();
  assert.equal(xhr.open('get', '/api/cart'), 'native-open');
  assert.deepEqual(xhr.opened, ['get', '/api/cart']);
  assert.equal(xhr.send(), 'native-send');
  assert.equal(xhr.abort(), 'native-abort');
  assert.equal(page.page.XMLHttpRequest.prototype.open.length, 2);
});

test('collector: open() with a url missing throws as it would without the collector', () => {
  const page = arm();
  const xhr = new page.page.XMLHttpRequest();
  // Forwarded as (method, undefined), this would succeed and request a page
  // called "undefined".
  assert.throws(() => xhr.open('GET'), TypeError);
  assert.equal(xhr.opened, undefined);
});

test('collector: a send() from the readystatechange that open() fires is recorded against that open()', () => {
  const page = arm();
  const xhr = new page.page.XMLHttpRequest();
  let sent = false;
  xhr.addEventListener('readystatechange', () => {
    if (xhr.readyState === 1 && !sent) {
      sent = true;
      xhr.send();
    }
  });
  xhr.open('POST', '/api/from-handler');
  assert.equal(sent, true);
  xhr.finish(500, 'Internal Server Error');
  assert.deepEqual(
    page.snapshot().network.map(({ method, url, status }) => [method, url, status]),
    [['POST', '/api/from-handler', 500]]
  );
});

test('collector: a synchronous request that fails at the network level is recorded once', () => {
  const page = arm();
  const xhr = new page.page.XMLHttpRequest();
  xhr.open('GET', 'http://127.0.0.1:1/refused', false);
  xhr.syncNetworkFailure = true;
  page.clock.now = 10;
  assert.throws(() => xhr.send(), (error) => error.name === 'NetworkError');
  let network = page.snapshot().network;
  assert.equal(network.length, 1);
  assert.equal(network[0].status, 0);
  assert.equal(network[0].statusText, 'Network failure');

  // Reusing the object later must not record it a second time, or at the
  // time of the reuse.
  page.clock.now = 400;
  xhr.open('GET', '/api/next');
  xhr.send();
  xhr.finish(200, 'OK');
  network = page.snapshot().network;
  assert.equal(network.length, 1);
  assert.equal(network[0].ms, 0);
});

test('collector: a send() the browser refuses throws as before and leaves the request its clock', () => {
  const page = arm();
  const xhr = new page.page.XMLHttpRequest();
  xhr.open('GET', '/api/slow');
  page.clock.now = 100;
  xhr.send();
  page.clock.now = 450;
  assert.throws(() => xhr.send(), (error) => error.name === 'InvalidStateError');
  page.clock.now = 502;
  xhr.finish(500, 'Internal Server Error');
  assert.equal(page.snapshot().network[0].ms, 402);
});

test('collector: a refused send() inside ontimeout leaves the timeout labelled a timeout', () => {
  const page = arm();
  const xhr = new page.page.XMLHttpRequest();
  // Added before the first open(), so it runs before the collector's listener.
  xhr.addEventListener('timeout', () => {
    try {
      xhr.send();
    } catch {
      /* the page's own */
    }
  });
  xhr.open('GET', '/api/rates');
  xhr.send();
  xhr.finish(0, '', ['timeout']);
  const network = page.snapshot().network;
  assert.equal(network.length, 1);
  assert.equal(network[0].outcome, 'timeout');
});

test('collector: its listeners do not go through an addEventListener the page patched later', () => {
  const page = arm();
  // What zone.js does after the collector has armed: every listener added
  // through it becomes a task in the page's zone.
  const proto = page.page.EventTarget.prototype;
  const original = proto.addEventListener;
  const seen = [];
  proto.addEventListener = function (type, handler) {
    seen.push(type);
    return original.call(this, type, handler);
  };
  const xhr = new page.page.XMLHttpRequest();
  xhr.open('GET', '/api/cart');
  xhr.send();
  xhr.finish(404, 'Not Found');
  assert.deepEqual(seen, []);
  assert.equal(page.snapshot().network.length, 1);
});

test('collector: parks nest, and each request keeps its own result', () => {
  const page = arm();
  const xhr = new page.page.XMLHttpRequest();
  let loads = 0;
  xhr.addEventListener('load', () => {
    loads += 1;
    if (loads === 1) {
      // A synchronous second request, run to the end inside the first one's
      // onload. Its own onload (this handler again) reopens for a third.
      xhr.open('GET', '/api/b', false);
      xhr.send();
    } else if (loads === 2) {
      xhr.open('GET', '/api/c');
      xhr.send();
    }
  });
  xhr.open('GET', '/api/a');
  xhr.send();
  xhr.finish(200, 'OK', ['load']);
  assert.deepEqual(page.snapshot().network, []);

  xhr.finish(503, 'Service Unavailable', ['load']);
  assert.deepEqual(
    page.snapshot().network.map(({ url, status, statusText }) => [url, status, statusText]),
    [['/api/c', 503, 'Service Unavailable']]
  );
});

test('collector: a request retried synchronously from ontimeout or onabort keeps its label', () => {
  for (const [type, end] of [
    ['timeout', (xhr) => xhr.finish(0, '', ['timeout'])],
    ['abort', (xhr) => xhr.abort()],
  ]) {
    const page = arm();
    const xhr = new page.page.XMLHttpRequest();
    // Added before the first open(), so it runs before the collector's
    // listener, and the retry has settled by the time that listener runs.
    xhr.addEventListener(type, () => {
      xhr.open('GET', '/api/retry', false);
      xhr.send();
    });
    xhr.open('GET', '/api/first');
    xhr.send();
    end(xhr);
    assert.deepEqual(
      page.snapshot().network.map(({ url, outcome, statusText }) => [url, outcome ?? null, statusText]),
      [['/api/first', type === 'timeout' ? 'timeout' : 'aborted', '']],
      type
    );
  }
});

test('collector: an abort inside a timeout, restarted from onabort, labels each request', () => {
  const page = arm();
  const xhr = new page.page.XMLHttpRequest();
  let aborts = 0;
  xhr.addEventListener('timeout', () => {
    xhr.open('GET', '/api/b');
    xhr.send();
    xhr.abort();
  });
  xhr.addEventListener('abort', () => {
    aborts += 1;
    if (aborts === 1) {
      xhr.open('GET', '/api/c');
      xhr.send();
    }
  });
  xhr.open('GET', '/api/a');
  xhr.send();
  xhr.finish(0, '', ['timeout']);
  xhr.finish(503, 'Service Unavailable', ['load']);
  assert.deepEqual(
    page.snapshot().network.map(({ url, status, outcome }) => [url, status, outcome ?? null]),
    [
      ['/api/b', 0, 'aborted'],
      ['/api/a', 0, 'timeout'],
      ['/api/c', 503, null],
    ]
  );
});

test('collector: an open() the browser refuses throws as before and leaves the request on the object alone', () => {
  const page = arm();
  const xhr = new page.page.XMLHttpRequest();
  xhr.open('GET', '/api/good');
  assert.throws(() => xhr.open('bad method', '/api/bad'), SyntaxError);
  xhr.send();
  xhr.finish(404, 'Not Found');
  assert.deepEqual(
    page.snapshot().network.map(({ method, url, status }) => [method, url, status]),
    [['GET', '/api/good', 404]]
  );

  // The same from inside a handler of a request that is just finishing: its
  // own loadend, which arrives next, still records it.
  xhr.addEventListener('load', () => {
    try {
      xhr.open('bad method', '/api/bad');
    } catch {
      /* the page's own */
    }
  });
  xhr.open('POST', '/api/save');
  xhr.send();
  xhr.finish(500, 'Internal Server Error', ['load']);
  assert.deepEqual(
    page.snapshot().network.map(({ method, url, status }) => [method, url, status]),
    [
      ['GET', '/api/good', 404],
      ['POST', '/api/save', 500],
    ]
  );
});

test('collector: a finished request aborted from its own onload keeps the status it ended on', () => {
  const page = arm();
  const xhr = new page.page.XMLHttpRequest();
  // Chrome fires no event for this and drops the status to 0 before the
  // loadend arrives, which read naively is a network failure.
  xhr.addEventListener('load', () => xhr.abort());
  xhr.open('GET', '/api/cart');
  xhr.send();
  xhr.finish(200, 'OK', ['load']);
  assert.deepEqual(page.snapshot().network, []);

  xhr.open('GET', '/api/cart');
  xhr.send();
  xhr.finish(503, 'Service Unavailable', ['load']);
  const network = page.snapshot().network;
  assert.equal(network.length, 1);
  assert.equal(network[0].status, 503);
  assert.equal(network[0].statusText, 'Service Unavailable');
  assert.equal(network[0].outcome, undefined);
});

test('collector: abort, reopen and send from onload credit each request with its own status', () => {
  const page = arm();
  const xhr = new page.page.XMLHttpRequest();
  let loads = 0;
  xhr.addEventListener('load', () => {
    loads += 1;
    if (loads > 1) return;
    xhr.abort();
    xhr.open('GET', '/api/second');
    xhr.send();
  });
  xhr.open('GET', '/api/first');
  xhr.send();

  // The first request succeeds. Its loadend lands on the object after the
  // reopen, and must not be taken for the second request failing.
  xhr.finish(200, 'OK', ['load']);
  assert.deepEqual(page.snapshot().network, []);

  xhr.finish(500, 'Internal Server Error', ['load']);
  assert.deepEqual(
    page.snapshot().network.map(({ url, status }) => [url, status]),
    [['/api/second', 500]]
  );
});

test('collector: an XHR aborted in flight is still labelled aborted', () => {
  const page = arm();
  const xhr = new page.page.XMLHttpRequest();
  xhr.open('GET', '/api/slow');
  xhr.send();
  xhr.abort();
  const network = page.snapshot().network;
  assert.equal(network.length, 1);
  assert.equal(network[0].outcome, 'aborted');
});

test('collector: the fallback for a missing loadend uses the timer the page started with', async () => {
  const page = arm();
  // What zone.js or a fake clock would do to it after the collector has armed.
  page.page.setTimeout = () => {
    throw new Error('a page timer of its own');
  };
  const xhr = new page.page.XMLHttpRequest();
  xhr.addEventListener('readystatechange', () => {
    if (xhr.readyState === 4) xhr.open('GET', '/api/next');
  });
  xhr.open('POST', '/api/save');
  xhr.send();
  xhr.finish(500, 'Internal Server Error', ['readystatechange'], { loadend: false });

  await new Promise((resolve) => setTimeout(resolve, 5));
  const network = page.snapshot().network;
  assert.equal(network.length, 1);
  assert.equal(network[0].url, '/api/save');
});

test('collector: an XHR whose readyState throws does not throw out of the collector', () => {
  const page = arm();
  const xhr = new page.page.XMLHttpRequest();
  xhr.open('GET', '/api/odd');
  xhr.send();
  Object.defineProperty(xhr, 'readyState', {
    configurable: true,
    get() {
      throw new Error('a getter of the page');
    },
  });
  assert.doesNotThrow(() => {
    for (const type of ['abort', 'timeout', 'loadend']) {
      for (const handler of xhr.handlers[type] || []) handler({ type });
    }
  });
});

test('collector: XHR records a 404 once, however often the object is reused', () => {
  const page = arm();
  const xhr = new page.page.XMLHttpRequest();
  for (let poll = 0; poll < 3; poll += 1) {
    xhr.open('get', '/api/poll');
    xhr.send();
    xhr.finish(200, 'OK');
  }
  xhr.open('get', '/api/poll');
  xhr.send();
  assert.equal(xhr.handlers.loadend.length, 1);

  xhr.finish(404, 'Not Found');
  const network = page.snapshot().network;
  assert.equal(network.length, 1);
  assert.equal(network[0].method, 'GET');
  assert.equal(network[0].status, 404);
  assert.equal(network[0].via, 'xhr');
});

test('collector: XHR tells an abort and a timeout from a failure, per send', () => {
  const page = arm();
  const xhr = new page.page.XMLHttpRequest();

  // A page has to reopen before each send; Chrome throws InvalidStateError
  // for a send on a finished request.
  xhr.open('GET', '/api/poll');
  xhr.send();
  xhr.finish(0, '', ['abort']);
  xhr.open('GET', '/api/poll');
  xhr.send();
  xhr.finish(0, '', ['timeout']);
  // The same object again, failing outright: the earlier timeout must not
  // stick to it.
  xhr.open('GET', '/api/poll');
  xhr.send();
  xhr.finish(0, '', ['error']);

  const network = page.snapshot().network;
  assert.deepEqual(
    network.map(({ outcome, statusText }) => [outcome ?? null, statusText]),
    [
      ['aborted', ''],
      ['timeout', ''],
      [null, 'Network failure'],
    ]
  );
});

test('collector: a retry sent from ontimeout is not labelled a timeout', () => {
  const page = arm();
  const xhr = new page.page.XMLHttpRequest();
  // Added before the first open(), so the page's handler runs before the
  // collector's and reopens the object first.
  xhr.addEventListener('timeout', () => {
    xhr.open('GET', '/api/rates?retry=1');
    xhr.send();
  });
  xhr.open('GET', '/api/rates');
  xhr.send();

  xhr.finish(0, '', ['timeout']); // the first request times out; its loadend lands after the reopen
  xhr.finish(0, '', ['error']); // the retry is refused outright

  assert.deepEqual(
    page.snapshot().network.map(({ url, outcome, statusText }) => [url, outcome ?? null, statusText]),
    [
      ['/api/rates', 'timeout', ''],
      ['/api/rates?retry=1', null, 'Network failure'],
    ]
  );
});

test('collector: a long poll that reopens from onload records nothing for a successful poll', () => {
  const page = arm();
  const xhr = new page.page.XMLHttpRequest();
  let polls = 0;
  xhr.addEventListener('load', () => {
    polls += 1;
    xhr.open('GET', `/api/poll?n=${polls}`);
    xhr.send();
  });
  xhr.open('GET', '/api/poll?n=0');
  xhr.send();

  xhr.finish(200, 'OK', ['load']);
  xhr.finish(200, 'OK', ['load']);
  assert.equal(polls, 2);
  assert.deepEqual(page.snapshot().network, []);

  // A real failure on the same object is still recorded, against its own url.
  xhr.finish(503, 'Service Unavailable', ['load']);
  const network = page.snapshot().network;
  assert.equal(network.length, 1);
  assert.equal(network[0].url, '/api/poll?n=2');
  assert.equal(network[0].status, 503);
});

test('collector: a request reopened before its loadend still gets recorded if no loadend comes', async () => {
  const page = arm();
  const xhr = new page.page.XMLHttpRequest();
  xhr.addEventListener('readystatechange', () => {
    if (xhr.readyState === 4) xhr.open('GET', '/api/next');
  });
  xhr.open('POST', '/api/save');
  xhr.send();
  xhr.finish(500, 'Internal Server Error', ['readystatechange'], { loadend: false });

  await new Promise((resolve) => setTimeout(resolve, 5));
  const network = page.snapshot().network;
  assert.equal(network.length, 1);
  assert.equal(network[0].url, '/api/save');
  assert.equal(network[0].status, 500);
});

test('collector: XHR records nothing for a 200', () => {
  const page = arm();
  const xhr = new page.page.XMLHttpRequest();
  xhr.open('GET', '/api/cart');
  xhr.send();
  xhr.finish(200, 'OK');
  assert.deepEqual(page.snapshot().network, []);
});

test('collector: its XHR bookkeeping is nowhere on the object, nor on a this that is not one', () => {
  const page = arm();
  const xhr = new page.page.XMLHttpRequest();
  const own = Object.getOwnPropertyNames(xhr);
  xhr.addEventListener('load', () => {
    xhr.open('GET', '/api/next');
    xhr.send();
  });
  xhr.open('POST', '/api/private/path');
  xhr.send();
  xhr.finish(200, 'OK', ['load']);
  xhr.abort();
  // The page's own fields, and the one the fake adds on open(), and nothing else.
  assert.deepEqual(Object.getOwnPropertyNames(xhr), [...own, 'opened']);

  // Called on something else, the native method refuses it, and the
  // collector has written nothing onto it on the way.
  const proto = page.page.XMLHttpRequest.prototype;
  for (const [method, args] of [
    ['open', ['GET', '/api/x']],
    ['send', []],
    ['abort', []],
  ]) {
    for (const other of [{}, { readyState: 1 }]) {
      const before = Object.getOwnPropertyNames(other);
      assert.throws(() => proto[method].apply(other, args), TypeError, method);
      assert.deepEqual(Object.getOwnPropertyNames(other), before, method);
    }
  }
});

test('collector: a field the page puts on Object.prototype stands in for none of a request', () => {
  const page = arm();
  // A query string parser that merges into a plain object can do this to a
  // page, long after the collector armed.
  page.realm('Object.prototype.fallback = true;');
  const failed = new page.page.XMLHttpRequest();
  failed.open('GET', '/api/cart');
  failed.send();
  failed.finish(500, 'Internal Server Error');
  const offline = new page.page.XMLHttpRequest();
  offline.open('GET', '/api/offline');
  offline.send();
  offline.finish(0, '', ['readystatechange', 'error']);
  assert.deepEqual(
    page.snapshot().network.map(({ url, status, statusText }) => [url, status, statusText]),
    [
      ['/api/cart', 500, 'Internal Server Error'],
      ['/api/offline', 0, 'Network failure'],
    ]
  );
});

test('collector: an open() over a request still in flight records that request as aborted', () => {
  // OPENED with the request sent, and LOADING. Chrome cancels it with no
  // event, not even loadend (seen on 156 for one still OPENED), and the
  // specification says the same of both.
  for (const readyState of [1, 3]) {
    const page = arm();
    const xhr = new page.page.XMLHttpRequest();
    page.clock.now = 10;
    xhr.open('GET', '/api/search?q=a');
    xhr.send();
    xhr.readyState = readyState;
    page.clock.now = 50;
    xhr.open('GET', '/api/search?q=ab');
    xhr.send();
    xhr.finish(200, 'OK');
    assert.deepEqual(
      page
        .snapshot()
        .network.map(({ url, status, outcome, statusText, ms }) => [url, status, outcome ?? null, statusText, ms]),
      [['/api/search?q=a', 0, 'aborted', '', 40]],
      `readyState ${readyState}`
    );
  }

  // Refused, the open() cancels nothing, and the request runs to its own end.
  const page = arm();
  const xhr = new page.page.XMLHttpRequest();
  xhr.open('GET', '/api/slow');
  xhr.send();
  assert.throws(() => xhr.open('bad method', '/api/x'), SyntaxError);
  xhr.finish(503, 'Service Unavailable');
  assert.deepEqual(
    page.snapshot().network.map(({ url, status }) => [url, status]),
    [['/api/slow', 503]]
  );
});

test('collector: a synchronous retry from onreadystatechange keeps the timeout or abort it retries', () => {
  for (const [outcome, end] of [
    ['timeout', (xhr) => xhr.finish(0, '', ['readystatechange', 'timeout'])],
    ['aborted', (xhr) => xhr.abort()],
  ]) {
    const page = arm();
    const xhr = new page.page.XMLHttpRequest();
    let retried = false;
    xhr.addEventListener('readystatechange', () => {
      if (xhr.readyState === 4 && !retried) {
        retried = true;
        // Chrome refuses a synchronous open() while a timeout is set.
        xhr.timeout = 0;
        xhr.open('GET', '/api/retry', false);
        xhr.send();
      }
    });
    xhr.open('GET', '/api/first');
    xhr.send();
    // The fake replays the retry's load and loadend ahead of the first
    // request's own events, as Chrome 156 does for both.
    end(xhr);
    assert.deepEqual(
      page.snapshot().network.map(({ url, outcome: label, statusText }) => [url, label ?? null, statusText]),
      [['/api/first', outcome, '']],
      outcome
    );
  }
});

test('collector: a request that failed with no response on a reopened object is still recorded, a task later', async () => {
  const page = arm();
  const xhr = new page.page.XMLHttpRequest();
  xhr.addEventListener('readystatechange', () => {
    if (xhr.readyState === 4 && xhr.opened[1] === '/api/first') xhr.open('GET', '/api/second');
  });
  page.clock.now = 10;
  xhr.open('GET', '/api/first');
  xhr.send();
  page.clock.now = 30;
  xhr.finish(0, '', ['readystatechange', 'error']);
  page.clock.now = 90;
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(
    page.snapshot().network.map(({ url, statusText, ms }) => [url, statusText, ms]),
    [['/api/first', 'Network failure', 20]]
  );
});

test('collector: a page listener that stops an event hides neither an abort nor a request opened before it', () => {
  // Added after open(), and so after the collector's own listeners.
  {
    const page = arm();
    const xhr = new page.page.XMLHttpRequest();
    xhr.open('GET', '/api/cart');
    xhr.addEventListener('loadend', (event) => event.stopImmediatePropagation());
    xhr.send();
    xhr.finish(500, 'Internal Server Error');
    assert.deepEqual(
      page.snapshot().network.map(({ url, status }) => [url, status]),
      [['/api/cart', 500]]
    );
  }
  // Added before the first open(), and so ahead of them: an abort is still
  // labelled and recorded, by abort() itself.
  {
    const page = arm();
    const xhr = new page.page.XMLHttpRequest();
    for (const type of ['abort', 'loadend']) {
      xhr.addEventListener(type, (event) => event.stopImmediatePropagation());
    }
    xhr.open('GET', '/api/search');
    xhr.send();
    xhr.abort();
    assert.deepEqual(
      page.snapshot().network.map(({ url, outcome }) => [url, outcome ?? null]),
      [['/api/search', 'aborted']]
    );
  }
});

// ---------------------------------------------------------------- runtime --

test('collector: uncaught errors and failed resources go to their own ring', () => {
  const page = arm();
  page.dispatch('error', { target: page.self, message: 'Uncaught Boom', filename: 'app.js', lineno: 3, colno: 9 });
  page.dispatch('error', { target: { tagName: 'IMG', src: 'http://localhost/logo.png' } });

  const errors = page.snapshot().errors;
  assert.equal(errors.length, 2);
  assert.equal(errors[0].kind, 'exception');
  assert.equal(errors[0].where, 'app.js:3:9');
  assert.equal(errors[1].kind, 'resource');
  assert.equal(errors[1].text, 'Failed to load <img>: http://localhost/logo.png');
});

// ---------------------------------------------------------------- inspect --

// A pick inside an open shadow root: the picker marks the element there,
// where document.querySelector does not look.
test('collector: an element the picker marked inside an open shadow root is found', () => {
  const page = arm();
  let removed = null;
  const node = {
    removeAttribute(name) {
      removed = name;
    },
    parentElement: null,
    __reactFiber$t: { tag: 0, type: function SaveButton() {}, memoizedProps: { label: 'Save' }, return: null },
  };
  const shadow = {
    querySelector: (selector) => (selector === '[data-cdr-pick="pick1"]' ? node : null),
    children: [],
  };
  const host = { shadowRoot: shadow, children: [] };
  const wrapper = { shadowRoot: null, children: [host] };
  page.page.document.querySelector = () => null;
  page.page.document.documentElement = { shadowRoot: null, children: [wrapper] };
  const reply = page.request('inspect', { marker: 'pick1' });
  assert.equal(removed, 'data-cdr-pick', 'the mark was left on the page');
  assert.deepEqual(reply?.component?.names, ['SaveButton']);
});

test('collector: props and handler text are withheld through builtins the page replaced', () => {
  const page = arm();
  // Never called: only its text is read.
  const handleSave = function handleSave() {
    send('abcdefghijklmnopqrstuvwxyz0123');
  };
  // A picked node as React leaves it, with the fiber and the host props on
  // the node as expandos.
  const node = {
    removeAttribute() {},
    parentElement: null,
    __reactFiber$t: {
      tag: 0,
      type: function LoginField() {},
      memoizedProps: { type: 'password', value: 'hunter2', password: 'hunter2', label: 'Password' },
      return: null,
    },
    __reactProps$t: { onClick: handleSave },
  };
  page.page.document.querySelector = () => node;
  page.realm(`
    String.prototype.split = function () { return []; };
    String.prototype.toLowerCase = function () { return ''; };
    Array.prototype.includes = function () { return false; };
    // Wrong only for the expression that looks for a quoted token.
    const test = RegExp.prototype.test;
    RegExp.prototype.test = function (text) {
      return this.source.includes('{20,}') ? false : test.call(this, text);
    };
  `);
  const { component, handlers } = page.request('inspect', { marker: 'pick1' });
  // A password field's own props: its value, and what holds it under a
  // secret name, withheld; its type and its label printed.
  assert.deepEqual(component.props, [
    'type="password"',
    'value=<redacted>',
    'password=<redacted>',
    'label="Password"',
  ]);
  assert.deepEqual(handlers.list, ['onClick=ƒ handleSave']);
  assert.equal(handlers.starts, '');
});

// ----------------------------------------------------------------- bridge --

test('collector: a second injection does not wrap twice', async () => {
  const page = arm({ fetch: () => Promise.resolve(response(500)) });
  page.run();
  await page.page.fetch('/api/once');
  assert.equal(page.snapshot().network.length, 1);
});

test('collector: an unknown action answers null, and clear empties every ring', async () => {
  const page = arm({ fetch: () => Promise.resolve(response(500)) });
  page.page.console.error('x');
  await page.page.fetch('/api/x');

  assert.equal(page.request('something-new'), null);
  page.request('clear');
  const after = page.snapshot();
  assert.deepEqual([after.console, after.errors, after.network], [[], [], []]);
});

// F46. The panel follows the counts while it is open, and the collector says
// when they change, so nothing has to ask it on a timer.
test('collector: a watched channel hears once that a ring grew, until the counts are asked; a full ring and an unwatched channel hear nothing (F46)', async () => {
  const page = arm({ fetch: () => Promise.resolve(response(500)) });
  page.page.console.error('before');
  page.snapshot(); // opens the channel
  let changed = 0;
  page.page.addEventListener(`${page.channel}:changed`, (event) => {
    changed += 1;
    assert.equal(event.detail, null, 'the signal carried something');
  });
  page.page.console.error('not watched yet');
  await page.page.fetch('/api/not-watched');
  assert.equal(changed, 0);

  assert.deepEqual(page.request('watch'), { console: 2, network: 1 });
  page.page.console.warn('first');
  page.page.console.error('second');
  await page.page.fetch('/api/third');
  assert.equal(changed, 1, 'told more than once before asking');
  assert.deepEqual(page.request('counts'), { console: 4, network: 2 });
  page.page.console.warn('after the ask');
  assert.equal(changed, 2);

  // The console ring full: one in, one out, the same count.
  page.request('counts');
  for (let i = 0; i < 40; i += 1) page.page.console.error(`fill ${i}`);
  assert.deepEqual(page.request('counts'), { console: 32, network: 2 });
  page.page.console.error('one more');
  assert.equal(changed, 3, 'only the filling said so');
  page.page.console.warn('a warning still grows its ring');
  assert.equal(changed, 4);

  page.request('counts');
  assert.equal(page.request('unwatch'), null);
  page.page.console.warn('unwatched');
  await page.page.fetch('/api/unwatched');
  assert.equal(changed, 4);
  // Clear answers as before, and says nothing of it: the bridge asks.
  page.request('watch');
  page.request('clear');
  assert.equal(changed, 4);
  assert.deepEqual(page.request('counts'), { console: 0, network: 0 });
  assert.deepEqual(page.posted, [], 'something went to window.postMessage');
});

// A page that logs on its way back from a stack overflow has the collector
// record, and say so, with all but no stack left (seen in Chrome for Testing
// 156). This fake's dispatchEvent lets a listener's throw out, which stands
// in for a dispatch that threw.
test('collector: a signal that could not go out is sent with the next entry, and a listener that logs again is not told of it (F46)', () => {
  const page = arm();
  page.snapshot(); // opens the channel
  let heard = 0;
  let fail = true;
  page.page.addEventListener(`${page.channel}:changed`, () => {
    if (fail) {
      fail = false;
      throw new RangeError('Maximum call stack size exceeded');
    }
    heard += 1;
    page.page.console.error('logged while told');
  });
  page.request('watch');
  page.page.console.error('lost');
  assert.equal(heard, 0);
  page.page.console.warn('next');
  assert.equal(heard, 1, 'a signal that never went out left the channel marked as told');
  page.page.console.warn('and the one after');
  assert.equal(heard, 1, 'told twice before the counts were asked');
  assert.deepEqual(page.request('counts'), { console: 4, network: 0 });
  page.page.console.warn('after the ask');
  assert.equal(heard, 2);
});

test('collector: a push that ran out of stack before it dropped an entry leaves its ring long only until the next, and counted at 30 (F46)', () => {
  // What runs out first, on a stack all but used up, stands in for it: the
  // look for a request the page ended, as the ring drops its oldest. The
  // console wrapper swallows the throw.
  const page = arm({
    before: `
      const hasOwn = Object.hasOwn;
      globalThis.outOfStack = false;
      Object.hasOwn = (object, key) => {
        if (globalThis.outOfStack && key === 'outcome') throw new RangeError('Maximum call stack size exceeded');
        return hasOwn(object, key);
      };`,
  });
  for (let i = 0; i < 30; i += 1) page.page.console.warn(`fill ${i}`);
  page.realm('outOfStack = true');
  for (let i = 0; i < 5; i += 1) page.page.console.warn(`deep ${i}`);
  assert.deepEqual(page.request('counts'), { console: 30, network: 0 }, 'counted past the 30 the bridge hands on');
  page.realm('outOfStack = false');
  page.page.console.warn('with the stack back');
  const after = page.snapshot();
  assert.equal(after.warnings.length, 30, 'the ring stayed long');
  assert.equal(after.warnings.at(-1).text, 'with the stack back');
  assert.equal(after.dropped.warnings, 6);
});

// Each entry the cut looks at is one Object.hasOwn(entry, 'outcome'), which
// is counted here instead of timed. Dropped one at a time, each looked for
// over the whole ring, a thousand such pushes cost half a million looks,
// which in Chrome froze the page for seconds at the next console call.
test('collector: a ring a thousand pushes left long is cut back in one pass at the next (F46)', () => {
  const page = arm({
    before: `
      const hasOwn = Object.hasOwn;
      globalThis.outOfStack = false;
      globalThis.looks = 0;
      Object.hasOwn = (object, key) => {
        if (key === 'outcome') {
          looks += 1;
          if (outOfStack) throw new RangeError('Maximum call stack size exceeded');
        }
        return hasOwn(object, key);
      };`,
  });
  for (let i = 0; i < 30; i += 1) page.page.console.warn(`fill ${i}`);
  page.realm('outOfStack = true');
  for (let i = 0; i < 1000; i += 1) page.page.console.warn(`deep ${i}`);
  page.realm('outOfStack = false; looks = 0');
  page.page.console.warn('with the stack back');
  const looks = page.realm('looks');
  assert.ok(looks <= 1031, `${looks} looks to cut 1,031 entries back to 30`);
  const after = page.snapshot();
  assert.deepEqual(
    after.warnings.map((entry) => entry.text),
    [...Array.from({ length: 29 }, (_, i) => `deep ${971 + i}`), 'with the stack back']
  );
  assert.equal(after.dropped.warnings, 1001);
});

test('collector: a cut that runs out of stack part way leaves no entry twice, and the next push finishes it, ended requests first (F46)', () => {
  const page = arm({
    before: `
      const hasOwn = Object.hasOwn;
      globalThis.looks = 0;
      globalThis.failAt = 0;
      Object.hasOwn = (object, key) => {
        if (key === 'outcome' && (looks += 1) === failAt) throw new RangeError('Maximum call stack size exceeded');
        return hasOwn(object, key);
      };`,
  });
  const xhr = new page.page.XMLHttpRequest();
  const request = (url, end) => {
    xhr.open('GET', url);
    xhr.send();
    xhr.finish(0, '', [end]);
  };
  const failures = (from, count) => Array.from({ length: count }, (_, i) => `/api/f${from + i}`);
  for (const url of failures(0, 10)) request(url, 'error');
  request('/api/aborted', 'abort');
  for (const url of failures(10, 19)) request(url, 'error');
  // Five pushes that run out of stack at their first look, then one that
  // runs out at its fourteenth: after dropping the aborted request and
  // moving the two failures behind it up.
  for (let i = 0; i < 5; i += 1) {
    page.realm('looks = 0; failAt = 1');
    request(`/api/deep${i}`, 'error');
  }
  page.realm('looks = 0; failAt = 14');
  request('/api/part', 'error');
  const part = page.snapshot();
  const urls = part.network.map((entry) => entry.url);
  assert.equal(new Set(urls).size, urls.length, 'an entry is in the ring twice');
  assert.deepEqual(urls, [...failures(0, 29), '/api/deep0', '/api/deep1', '/api/deep2', '/api/deep3', '/api/deep4', '/api/part']);
  assert.equal(part.dropped.network, 1);

  page.realm('looks = 0; failAt = 0');
  request('/api/after', 'error');
  const after = page.snapshot();
  assert.deepEqual(after.network.map((entry) => entry.url), [
    ...failures(6, 23),
    '/api/deep0', '/api/deep1', '/api/deep2', '/api/deep3', '/api/deep4', '/api/part', '/api/after',
  ]);
  assert.equal(after.dropped.network, 7);
});

// The ring the page logs to fills while there is no room to say so: then
// only an entry into a ring with room said anything, and the chips stood.
test('collector: a signal that could not go out is sent with the next entry into a full ring too (F46)', () => {
  const page = arm();
  page.snapshot(); // opens the channel
  let heard = 0;
  let fail = false;
  page.page.addEventListener(`${page.channel}:changed`, () => {
    if (fail) {
      fail = false;
      throw new RangeError('Maximum call stack size exceeded');
    }
    heard += 1;
  });
  page.request('watch');
  for (let i = 0; i < 29; i += 1) page.page.console.error(`fill ${i}`);
  assert.equal(heard, 1);
  page.request('counts');
  fail = true;
  page.page.console.error('the thirtieth, not told');
  assert.equal(heard, 1);
  page.page.console.error('into the full ring');
  assert.equal(heard, 2, 'the change was never told');
  assert.deepEqual(page.request('counts'), { console: 30, network: 0 });
  page.page.console.error('full, and nothing owed');
  assert.equal(heard, 2, 'a full ring said it grew');
});

test('collector: messages from other windows are ignored', () => {
  const page = arm();
  let answered = false;
  page.page.postMessage = () => {
    answered = true;
  };
  page.dispatch('message', { source: {}, data: { __cdr: 'request', action: 'snapshot', id: 1 } });
  assert.equal(answered, false);
});

// ------------------------------------------------- open items, area D --
// Each test below names the review item it holds the collector to.

/** A node as React leaves it, picked and marked, with fibers for expandos. */
function pickable(page, fiber, props) {
  const node = { removeAttribute() {}, parentElement: null, __reactFiber$t: fiber };
  if (props) node.__reactProps$t = props;
  page.page.document.querySelector = () => node;
  return () => page.request('inspect', { marker: 'pick1' });
}

test('collector: a failed request names the page behind a request library bundled with it (CO4)', () => {
  const page = arm();
  // One file, as a bundle is: the path cannot tell axios from the page, so
  // its frames are known by their names, and the capture has to be deep
  // enough to get past them at all.
  vm.runInContext(
    `
    class Axios {
      request(config) { return this._request(config); }
      _request(config) { return dispatchRequest(config); }
    }
    function dispatchRequest(config) { return xhrAdapter(config); }
    function xhrAdapter(config) {
      return new Promise(function dispatchXhrRequest(resolve) {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', config.url);
        xhr.send();
        globalThis.lastXhr = xhr;
        resolve(xhr);
      });
    }
    function loadCart() { return new Axios().request({ url: '/api/cart' }); }
    function onMount() { return loadCart(); }
    onMount();
    `,
    page.page,
    { filename: 'http://localhost/assets/index-4f2a.js' }
  );
  page.page.lastXhr.finish(500, 'Internal Server Error', ['readystatechange', 'load']);
  const [entry] = page.snapshot().network;
  assert.ok(entry.caller, 'no caller recorded');
  // The realm has no URL to take the origin off with, as Chrome does.
  assert.match(entry.caller[0], /^loadCart \((?:http:\/\/localhost)?\/assets\/index-4f2a\.js:\d+:\d+\)$/);
  assert.match(entry.caller[1], /^onMount \(/);
});

// Real compiler output, byte for byte, for one piece of page code: an
// ApiClient whose async request() calls fetch, an async loadCart() that
// awaits it, and onMount() calling loadCart(). In "direct" the request goes
// out before request()'s first await, in "resumed" after one, from the
// microtask that resumed it. Each compiler's helpers come first, as it
// emitted them, so the two variants share them here. Made with tsc 5.9.3
// (--target es2015 and es5), @babel/preset-env 7.19.3 (targets chrome 50,
// which compiles to generators, and ie 11, which adds regenerator) and
// esbuild 0.20.2 (--target=es2016). The source, for direct (resumed adds
// `await Promise.resolve();` before the fetch):
//
//   class ApiClient {
//     async request(url) { const response = await fetch(url); return response; }
//   }
//   const api = new ApiClient();
//   async function loadCart() { return await api.request('/api/cart'); }
//   function onMount() { return loadCart(); }
//   globalThis.onMount = onMount;
const COMPILED = {
  tsEs2015: {
    helpers: `var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
`,
    direct: `// The page's own code: an API client and the code calling it.
class ApiClient {
    request(url) {
        return __awaiter(this, void 0, void 0, function* () {
            const response = yield fetch(url);
            return response;
        });
    }
}
const api = new ApiClient();
function loadCart() {
    return __awaiter(this, void 0, void 0, function* () {
        return yield api.request('/api/cart');
    });
}
function onMount() { return loadCart(); }
globalThis.onMount = onMount;
`,
    resumed: `// The page's own code: an API client and the code calling it. The request
// goes out after an await, so it is sent from a resumed task.
class ApiClient {
    request(url) {
        return __awaiter(this, void 0, void 0, function* () {
            yield Promise.resolve();
            const response = yield fetch(url);
            return response;
        });
    }
}
const api = new ApiClient();
function loadCart() {
    return __awaiter(this, void 0, void 0, function* () {
        return yield api.request('/api/cart');
    });
}
function onMount() { return loadCart(); }
globalThis.onMount = onMount;
`,
  },
  tsEs5: {
    helpers: `var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
`,
    direct: `// The page's own code: an API client and the code calling it.
var ApiClient = /** @class */ (function () {
    function ApiClient() {
    }
    ApiClient.prototype.request = function (url) {
        return __awaiter(this, void 0, void 0, function () {
            var response;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, fetch(url)];
                    case 1:
                        response = _a.sent();
                        return [2 /*return*/, response];
                }
            });
        });
    };
    return ApiClient;
}());
var api = new ApiClient();
function loadCart() {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, api.request('/api/cart')];
                case 1: return [2 /*return*/, _a.sent()];
            }
        });
    });
}
function onMount() { return loadCart(); }
globalThis.onMount = onMount;
`,
    resumed: `// The page's own code: an API client and the code calling it. The request
// goes out after an await, so it is sent from a resumed task.
var ApiClient = /** @class */ (function () {
    function ApiClient() {
    }
    ApiClient.prototype.request = function (url) {
        return __awaiter(this, void 0, void 0, function () {
            var response;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, Promise.resolve()];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, fetch(url)];
                    case 2:
                        response = _a.sent();
                        return [2 /*return*/, response];
                }
            });
        });
    };
    return ApiClient;
}());
var api = new ApiClient();
function loadCart() {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, api.request('/api/cart')];
                case 1: return [2 /*return*/, _a.sent()];
            }
        });
    });
}
function onMount() { return loadCart(); }
globalThis.onMount = onMount;
`,
  },
  babelGenerator: {
    helpers: `function asyncGeneratorStep(gen, resolve, reject, _next, _throw, key, arg) { try { var info = gen[key](arg); var value = info.value; } catch (error) { reject(error); return; } if (info.done) { resolve(value); } else { Promise.resolve(value).then(_next, _throw); } }

function _asyncToGenerator(fn) { return function () { var self = this, args = arguments; return new Promise(function (resolve, reject) { var gen = fn.apply(self, args); function _next(value) { asyncGeneratorStep(gen, resolve, reject, _next, _throw, "next", value); } function _throw(err) { asyncGeneratorStep(gen, resolve, reject, _next, _throw, "throw", err); } _next(undefined); }); }; }

`,
    direct: `// The page's own code: an API client and the code calling it.
class ApiClient {
  request(url) {
    return _asyncToGenerator(function* () {
      const response = yield fetch(url);
      return response;
    })();
  }

}

const api = new ApiClient();

function loadCart() {
  return _loadCart.apply(this, arguments);
}

function _loadCart() {
  _loadCart = _asyncToGenerator(function* () {
    return yield api.request('/api/cart');
  });
  return _loadCart.apply(this, arguments);
}

function onMount() {
  return loadCart();
}

globalThis.onMount = onMount;`,
    resumed: `// The page's own code: an API client and the code calling it. The request
// goes out after an await, so it is sent from a resumed task.
class ApiClient {
  request(url) {
    return _asyncToGenerator(function* () {
      yield Promise.resolve();
      const response = yield fetch(url);
      return response;
    })();
  }

}

const api = new ApiClient();

function loadCart() {
  return _loadCart.apply(this, arguments);
}

function _loadCart() {
  _loadCart = _asyncToGenerator(function* () {
    return yield api.request('/api/cart');
  });
  return _loadCart.apply(this, arguments);
}

function onMount() {
  return loadCart();
}

globalThis.onMount = onMount;`,
  },
  babelRegenerator: {
    helpers: `function _typeof(obj) { "@babel/helpers - typeof"; return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (obj) { return typeof obj; } : function (obj) { return obj && "function" == typeof Symbol && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; }, _typeof(obj); }

function _regeneratorRuntime() { "use strict"; /*! regenerator-runtime -- Copyright (c) 2014-present, Facebook, Inc. -- license (MIT): https://github.com/facebook/regenerator/blob/main/LICENSE */ _regeneratorRuntime = function _regeneratorRuntime() { return exports; }; var exports = {}, Op = Object.prototype, hasOwn = Op.hasOwnProperty, $Symbol = "function" == typeof Symbol ? Symbol : {}, iteratorSymbol = $Symbol.iterator || "@@iterator", asyncIteratorSymbol = $Symbol.asyncIterator || "@@asyncIterator", toStringTagSymbol = $Symbol.toStringTag || "@@toStringTag"; function define(obj, key, value) { return Object.defineProperty(obj, key, { value: value, enumerable: !0, configurable: !0, writable: !0 }), obj[key]; } try { define({}, ""); } catch (err) { define = function define(obj, key, value) { return obj[key] = value; }; } function wrap(innerFn, outerFn, self, tryLocsList) { var protoGenerator = outerFn && outerFn.prototype instanceof Generator ? outerFn : Generator, generator = Object.create(protoGenerator.prototype), context = new Context(tryLocsList || []); return generator._invoke = function (innerFn, self, context) { var state = "suspendedStart"; return function (method, arg) { if ("executing" === state) throw new Error("Generator is already running"); if ("completed" === state) { if ("throw" === method) throw arg; return doneResult(); } for (context.method = method, context.arg = arg;;) { var delegate = context.delegate; if (delegate) { var delegateResult = maybeInvokeDelegate(delegate, context); if (delegateResult) { if (delegateResult === ContinueSentinel) continue; return delegateResult; } } if ("next" === context.method) context.sent = context._sent = context.arg;else if ("throw" === context.method) { if ("suspendedStart" === state) throw state = "completed", context.arg; context.dispatchException(context.arg); } else "return" === context.method && context.abrupt("return", context.arg); state = "executing"; var record = tryCatch(innerFn, self, context); if ("normal" === record.type) { if (state = context.done ? "completed" : "suspendedYield", record.arg === ContinueSentinel) continue; return { value: record.arg, done: context.done }; } "throw" === record.type && (state = "completed", context.method = "throw", context.arg = record.arg); } }; }(innerFn, self, context), generator; } function tryCatch(fn, obj, arg) { try { return { type: "normal", arg: fn.call(obj, arg) }; } catch (err) { return { type: "throw", arg: err }; } } exports.wrap = wrap; var ContinueSentinel = {}; function Generator() {} function GeneratorFunction() {} function GeneratorFunctionPrototype() {} var IteratorPrototype = {}; define(IteratorPrototype, iteratorSymbol, function () { return this; }); var getProto = Object.getPrototypeOf, NativeIteratorPrototype = getProto && getProto(getProto(values([]))); NativeIteratorPrototype && NativeIteratorPrototype !== Op && hasOwn.call(NativeIteratorPrototype, iteratorSymbol) && (IteratorPrototype = NativeIteratorPrototype); var Gp = GeneratorFunctionPrototype.prototype = Generator.prototype = Object.create(IteratorPrototype); function defineIteratorMethods(prototype) { ["next", "throw", "return"].forEach(function (method) { define(prototype, method, function (arg) { return this._invoke(method, arg); }); }); } function AsyncIterator(generator, PromiseImpl) { function invoke(method, arg, resolve, reject) { var record = tryCatch(generator[method], generator, arg); if ("throw" !== record.type) { var result = record.arg, value = result.value; return value && "object" == _typeof(value) && hasOwn.call(value, "__await") ? PromiseImpl.resolve(value.__await).then(function (value) { invoke("next", value, resolve, reject); }, function (err) { invoke("throw", err, resolve, reject); }) : PromiseImpl.resolve(value).then(function (unwrapped) { result.value = unwrapped, resolve(result); }, function (error) { return invoke("throw", error, resolve, reject); }); } reject(record.arg); } var previousPromise; this._invoke = function (method, arg) { function callInvokeWithMethodAndArg() { return new PromiseImpl(function (resolve, reject) { invoke(method, arg, resolve, reject); }); } return previousPromise = previousPromise ? previousPromise.then(callInvokeWithMethodAndArg, callInvokeWithMethodAndArg) : callInvokeWithMethodAndArg(); }; } function maybeInvokeDelegate(delegate, context) { var method = delegate.iterator[context.method]; if (undefined === method) { if (context.delegate = null, "throw" === context.method) { if (delegate.iterator.return && (context.method = "return", context.arg = undefined, maybeInvokeDelegate(delegate, context), "throw" === context.method)) return ContinueSentinel; context.method = "throw", context.arg = new TypeError("The iterator does not provide a 'throw' method"); } return ContinueSentinel; } var record = tryCatch(method, delegate.iterator, context.arg); if ("throw" === record.type) return context.method = "throw", context.arg = record.arg, context.delegate = null, ContinueSentinel; var info = record.arg; return info ? info.done ? (context[delegate.resultName] = info.value, context.next = delegate.nextLoc, "return" !== context.method && (context.method = "next", context.arg = undefined), context.delegate = null, ContinueSentinel) : info : (context.method = "throw", context.arg = new TypeError("iterator result is not an object"), context.delegate = null, ContinueSentinel); } function pushTryEntry(locs) { var entry = { tryLoc: locs[0] }; 1 in locs && (entry.catchLoc = locs[1]), 2 in locs && (entry.finallyLoc = locs[2], entry.afterLoc = locs[3]), this.tryEntries.push(entry); } function resetTryEntry(entry) { var record = entry.completion || {}; record.type = "normal", delete record.arg, entry.completion = record; } function Context(tryLocsList) { this.tryEntries = [{ tryLoc: "root" }], tryLocsList.forEach(pushTryEntry, this), this.reset(!0); } function values(iterable) { if (iterable) { var iteratorMethod = iterable[iteratorSymbol]; if (iteratorMethod) return iteratorMethod.call(iterable); if ("function" == typeof iterable.next) return iterable; if (!isNaN(iterable.length)) { var i = -1, next = function next() { for (; ++i < iterable.length;) { if (hasOwn.call(iterable, i)) return next.value = iterable[i], next.done = !1, next; } return next.value = undefined, next.done = !0, next; }; return next.next = next; } } return { next: doneResult }; } function doneResult() { return { value: undefined, done: !0 }; } return GeneratorFunction.prototype = GeneratorFunctionPrototype, define(Gp, "constructor", GeneratorFunctionPrototype), define(GeneratorFunctionPrototype, "constructor", GeneratorFunction), GeneratorFunction.displayName = define(GeneratorFunctionPrototype, toStringTagSymbol, "GeneratorFunction"), exports.isGeneratorFunction = function (genFun) { var ctor = "function" == typeof genFun && genFun.constructor; return !!ctor && (ctor === GeneratorFunction || "GeneratorFunction" === (ctor.displayName || ctor.name)); }, exports.mark = function (genFun) { return Object.setPrototypeOf ? Object.setPrototypeOf(genFun, GeneratorFunctionPrototype) : (genFun.__proto__ = GeneratorFunctionPrototype, define(genFun, toStringTagSymbol, "GeneratorFunction")), genFun.prototype = Object.create(Gp), genFun; }, exports.awrap = function (arg) { return { __await: arg }; }, defineIteratorMethods(AsyncIterator.prototype), define(AsyncIterator.prototype, asyncIteratorSymbol, function () { return this; }), exports.AsyncIterator = AsyncIterator, exports.async = function (innerFn, outerFn, self, tryLocsList, PromiseImpl) { void 0 === PromiseImpl && (PromiseImpl = Promise); var iter = new AsyncIterator(wrap(innerFn, outerFn, self, tryLocsList), PromiseImpl); return exports.isGeneratorFunction(outerFn) ? iter : iter.next().then(function (result) { return result.done ? result.value : iter.next(); }); }, defineIteratorMethods(Gp), define(Gp, toStringTagSymbol, "Generator"), define(Gp, iteratorSymbol, function () { return this; }), define(Gp, "toString", function () { return "[object Generator]"; }), exports.keys = function (object) { var keys = []; for (var key in object) { keys.push(key); } return keys.reverse(), function next() { for (; keys.length;) { var key = keys.pop(); if (key in object) return next.value = key, next.done = !1, next; } return next.done = !0, next; }; }, exports.values = values, Context.prototype = { constructor: Context, reset: function reset(skipTempReset) { if (this.prev = 0, this.next = 0, this.sent = this._sent = undefined, this.done = !1, this.delegate = null, this.method = "next", this.arg = undefined, this.tryEntries.forEach(resetTryEntry), !skipTempReset) for (var name in this) { "t" === name.charAt(0) && hasOwn.call(this, name) && !isNaN(+name.slice(1)) && (this[name] = undefined); } }, stop: function stop() { this.done = !0; var rootRecord = this.tryEntries[0].completion; if ("throw" === rootRecord.type) throw rootRecord.arg; return this.rval; }, dispatchException: function dispatchException(exception) { if (this.done) throw exception; var context = this; function handle(loc, caught) { return record.type = "throw", record.arg = exception, context.next = loc, caught && (context.method = "next", context.arg = undefined), !!caught; } for (var i = this.tryEntries.length - 1; i >= 0; --i) { var entry = this.tryEntries[i], record = entry.completion; if ("root" === entry.tryLoc) return handle("end"); if (entry.tryLoc <= this.prev) { var hasCatch = hasOwn.call(entry, "catchLoc"), hasFinally = hasOwn.call(entry, "finallyLoc"); if (hasCatch && hasFinally) { if (this.prev < entry.catchLoc) return handle(entry.catchLoc, !0); if (this.prev < entry.finallyLoc) return handle(entry.finallyLoc); } else if (hasCatch) { if (this.prev < entry.catchLoc) return handle(entry.catchLoc, !0); } else { if (!hasFinally) throw new Error("try statement without catch or finally"); if (this.prev < entry.finallyLoc) return handle(entry.finallyLoc); } } } }, abrupt: function abrupt(type, arg) { for (var i = this.tryEntries.length - 1; i >= 0; --i) { var entry = this.tryEntries[i]; if (entry.tryLoc <= this.prev && hasOwn.call(entry, "finallyLoc") && this.prev < entry.finallyLoc) { var finallyEntry = entry; break; } } finallyEntry && ("break" === type || "continue" === type) && finallyEntry.tryLoc <= arg && arg <= finallyEntry.finallyLoc && (finallyEntry = null); var record = finallyEntry ? finallyEntry.completion : {}; return record.type = type, record.arg = arg, finallyEntry ? (this.method = "next", this.next = finallyEntry.finallyLoc, ContinueSentinel) : this.complete(record); }, complete: function complete(record, afterLoc) { if ("throw" === record.type) throw record.arg; return "break" === record.type || "continue" === record.type ? this.next = record.arg : "return" === record.type ? (this.rval = this.arg = record.arg, this.method = "return", this.next = "end") : "normal" === record.type && afterLoc && (this.next = afterLoc), ContinueSentinel; }, finish: function finish(finallyLoc) { for (var i = this.tryEntries.length - 1; i >= 0; --i) { var entry = this.tryEntries[i]; if (entry.finallyLoc === finallyLoc) return this.complete(entry.completion, entry.afterLoc), resetTryEntry(entry), ContinueSentinel; } }, catch: function _catch(tryLoc) { for (var i = this.tryEntries.length - 1; i >= 0; --i) { var entry = this.tryEntries[i]; if (entry.tryLoc === tryLoc) { var record = entry.completion; if ("throw" === record.type) { var thrown = record.arg; resetTryEntry(entry); } return thrown; } } throw new Error("illegal catch attempt"); }, delegateYield: function delegateYield(iterable, resultName, nextLoc) { return this.delegate = { iterator: values(iterable), resultName: resultName, nextLoc: nextLoc }, "next" === this.method && (this.arg = undefined), ContinueSentinel; } }, exports; }

function asyncGeneratorStep(gen, resolve, reject, _next, _throw, key, arg) { try { var info = gen[key](arg); var value = info.value; } catch (error) { reject(error); return; } if (info.done) { resolve(value); } else { Promise.resolve(value).then(_next, _throw); } }

function _asyncToGenerator(fn) { return function () { var self = this, args = arguments; return new Promise(function (resolve, reject) { var gen = fn.apply(self, args); function _next(value) { asyncGeneratorStep(gen, resolve, reject, _next, _throw, "next", value); } function _throw(err) { asyncGeneratorStep(gen, resolve, reject, _next, _throw, "throw", err); } _next(undefined); }); }; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

function _defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } }

function _createClass(Constructor, protoProps, staticProps) { if (protoProps) _defineProperties(Constructor.prototype, protoProps); if (staticProps) _defineProperties(Constructor, staticProps); Object.defineProperty(Constructor, "prototype", { writable: false }); return Constructor; }

`,
    direct: `// The page's own code: an API client and the code calling it.
var ApiClient = /*#__PURE__*/function () {
  function ApiClient() {
    _classCallCheck(this, ApiClient);
  }

  _createClass(ApiClient, [{
    key: "request",
    value: function () {
      var _request = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee(url) {
        var response;
        return _regeneratorRuntime().wrap(function _callee$(_context) {
          while (1) {
            switch (_context.prev = _context.next) {
              case 0:
                _context.next = 2;
                return fetch(url);

              case 2:
                response = _context.sent;
                return _context.abrupt("return", response);

              case 4:
              case "end":
                return _context.stop();
            }
          }
        }, _callee);
      }));

      function request(_x) {
        return _request.apply(this, arguments);
      }

      return request;
    }()
  }]);

  return ApiClient;
}();

var api = new ApiClient();

function loadCart() {
  return _loadCart.apply(this, arguments);
}

function _loadCart() {
  _loadCart = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee2() {
    return _regeneratorRuntime().wrap(function _callee2$(_context2) {
      while (1) {
        switch (_context2.prev = _context2.next) {
          case 0:
            _context2.next = 2;
            return api.request('/api/cart');

          case 2:
            return _context2.abrupt("return", _context2.sent);

          case 3:
          case "end":
            return _context2.stop();
        }
      }
    }, _callee2);
  }));
  return _loadCart.apply(this, arguments);
}

function onMount() {
  return loadCart();
}

globalThis.onMount = onMount;`,
    resumed: `// The page's own code: an API client and the code calling it. The request
// goes out after an await, so it is sent from a resumed task.
var ApiClient = /*#__PURE__*/function () {
  function ApiClient() {
    _classCallCheck(this, ApiClient);
  }

  _createClass(ApiClient, [{
    key: "request",
    value: function () {
      var _request = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee(url) {
        var response;
        return _regeneratorRuntime().wrap(function _callee$(_context) {
          while (1) {
            switch (_context.prev = _context.next) {
              case 0:
                _context.next = 2;
                return Promise.resolve();

              case 2:
                _context.next = 4;
                return fetch(url);

              case 4:
                response = _context.sent;
                return _context.abrupt("return", response);

              case 6:
              case "end":
                return _context.stop();
            }
          }
        }, _callee);
      }));

      function request(_x) {
        return _request.apply(this, arguments);
      }

      return request;
    }()
  }]);

  return ApiClient;
}();

var api = new ApiClient();

function loadCart() {
  return _loadCart.apply(this, arguments);
}

function _loadCart() {
  _loadCart = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee2() {
    return _regeneratorRuntime().wrap(function _callee2$(_context2) {
      while (1) {
        switch (_context2.prev = _context2.next) {
          case 0:
            _context2.next = 2;
            return api.request('/api/cart');

          case 2:
            return _context2.abrupt("return", _context2.sent);

          case 3:
          case "end":
            return _context2.stop();
        }
      }
    }, _callee2);
  }));
  return _loadCart.apply(this, arguments);
}

function onMount() {
  return loadCart();
}

globalThis.onMount = onMount;`,
  },
  esbuild: {
    helpers: `var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};
`,
    direct: `class ApiClient {
  request(url) {
    return __async(this, null, function* () {
      const response = yield fetch(url);
      return response;
    });
  }
}
const api = new ApiClient();
function loadCart() {
  return __async(this, null, function* () {
    return yield api.request("/api/cart");
  });
}
function onMount() {
  return loadCart();
}
globalThis.onMount = onMount;
`,
    resumed: `class ApiClient {
  request(url) {
    return __async(this, null, function* () {
      yield Promise.resolve();
      const response = yield fetch(url);
      return response;
    });
  }
}
const api = new ApiClient();
function loadCart() {
  return __async(this, null, function* () {
    return yield api.request("/api/cart");
  });
}
function onMount() {
  return loadCart();
}
globalThis.onMount = onMount;
`,
  },
  // @swc/helpers 0.5.23, as SWC bundles them for an es5 target: the real
  // _async_to_generator and _ts_generator, whose iterator methods are
  // defined with Object.defineProperty. The page's part is written in SWC's
  // output shape.
  swc: {
    helpers: `function asyncGeneratorStep(gen, resolve, reject, _next, _throw, key, arg) {
    try {
        var info = gen[key](arg);
        var value = info.value;
    } catch (error) {
        reject(error);
        return;
    }
    if (info.done) resolve(value);
    else Promise.resolve(value).then(_next, _throw);
}
function _async_to_generator(fn) {
    return function() {
        var self = this, args = arguments;

        return new Promise(function(resolve, reject) {
            var gen = fn.apply(self, args);

            function _next(value) {
                asyncGeneratorStep(gen, resolve, reject, _next, _throw, "next", value);
            }

            function _throw(err) {
                asyncGeneratorStep(gen, resolve, reject, _next, _throw, "throw", err);
            }

            _next(undefined);
        });
    };
}

function _class_call_check(instance, Constructor) {
    if (!(instance instanceof Constructor)) throw new TypeError("Cannot call a class as a function");
}

function _ts_generator(thisArg, body) {
    var f, y, t, _ = { label: 0, sent: function () { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype), d = Object.defineProperty;
    return d(g, "next", { value: verb(0) }), d(g, "throw", { value: verb(1) }), d(g, "return", { value: verb(2) }), typeof Symbol === "function" && d(g, Symbol.iterator, { value: function () { return this; } }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
}


`,
    direct: `// The page's own code: an API client and the code calling it.
var ApiClient = /*#__PURE__*/ function() {
    "use strict";
    function ApiClient() {
        _class_call_check(this, ApiClient);
    }
    var _proto = ApiClient.prototype;
    _proto.request = function request(url) {
        return _async_to_generator(function() {
            var response;
            return _ts_generator(this, function(_state) {
                switch(_state.label){
                    case 0:
                        return [
                            4,
                            fetch(url)
                        ];
                    case 1:
                        response = _state.sent();
                        return [
                            2,
                            response
                        ];
                }
            });
        }).call(this);
    };
    return ApiClient;
}();
var api = new ApiClient();
function loadCart() {
    return _loadCart.apply(this, arguments);
}
function _loadCart() {
    _loadCart = _async_to_generator(function() {
        return _ts_generator(this, function(_state) {
            switch(_state.label){
                case 0:
                    return [
                        4,
                        api.request('/api/cart')
                    ];
                case 1:
                    return [
                        2,
                        _state.sent()
                    ];
            }
        });
    });
    return _loadCart.apply(this, arguments);
}
function onMount() {
    return loadCart();
}
globalThis.onMount = onMount;
`,
    resumed: `// The page's own code: an API client and the code calling it. The request
// goes out after an await, so it is sent from a resumed task.
var ApiClient = /*#__PURE__*/ function() {
    "use strict";
    function ApiClient() {
        _class_call_check(this, ApiClient);
    }
    var _proto = ApiClient.prototype;
    _proto.request = function request(url) {
        return _async_to_generator(function() {
            var response;
            return _ts_generator(this, function(_state) {
                switch(_state.label){
                    case 0:
                        return [
                            4,
                            Promise.resolve()
                        ];
                    case 1:
                        _state.sent();
                        return [
                            4,
                            fetch(url)
                        ];
                    case 2:
                        response = _state.sent();
                        return [
                            2,
                            response
                        ];
                }
            });
        }).call(this);
    };
    return ApiClient;
}();
var api = new ApiClient();
function loadCart() {
    return _loadCart.apply(this, arguments);
}
function _loadCart() {
    _loadCart = _async_to_generator(function() {
        return _ts_generator(this, function(_state) {
            switch(_state.label){
                case 0:
                    return [
                        4,
                        api.request('/api/cart')
                    ];
                case 1:
                    return [
                        2,
                        _state.sent()
                    ];
            }
        });
    });
    return _loadCart.apply(this, arguments);
}
function onMount() {
    return loadCart();
}
globalThis.onMount = onMount;
`,
  },
  // @babel/core 7.29.7 with plugin-transform-regenerator 7.18.6, which
  // reaches the 7.29 helpers through the regeneratorRuntime wrapper, as code
  // built against @babel/runtime 7.27 and later does. Real output.
  babelRegeneratorRuntime: {
    helpers: `function _regeneratorRuntime() { "use strict"; var r = _regenerator(), e = r.m(_regeneratorRuntime), t = (Object.getPrototypeOf ? Object.getPrototypeOf(e) : e.__proto__).constructor; function n(r) { var e = "function" == typeof r && r.constructor; return !!e && (e === t || "GeneratorFunction" === (e.displayName || e.name)); } var o = { throw: 1, return: 2, break: 3, continue: 3 }; function a(r) { var e, t; return function (n) { e || (e = { stop: function () { return t(n.a, 2); }, catch: function () { return n.v; }, abrupt: function (r, e) { return t(n.a, o[r], e); }, delegateYield: function (r, o, a) { return e.resultName = o, t(n.d, _regeneratorValues(r), a); }, finish: function (r) { return t(n.f, r); } }, t = function (r, t, o) { n.p = e.prev, n.n = e.next; try { return r(t, o); } finally { e.next = n.n; } }), e.resultName && (e[e.resultName] = n.v, e.resultName = void 0), e.sent = n.v, e.next = n.n; try { return r.call(this, e); } finally { n.p = e.prev, n.n = e.next; } }; } return (_regeneratorRuntime = function () { return { wrap: function (e, t, n, o) { return r.w(a(e), t, n, o && o.reverse()); }, isGeneratorFunction: n, mark: r.m, awrap: function (r, e) { return new _OverloadYield(r, e); }, AsyncIterator: _regeneratorAsyncIterator, async: function (r, e, t, o, u) { return (n(e) ? _regeneratorAsyncGen : _regeneratorAsync)(a(r), e, t, o, u); }, keys: _regeneratorKeys, values: _regeneratorValues }; })(); }
function _regeneratorValues(e) { if (null != e) { var t = e["function" == typeof Symbol && Symbol.iterator || "@@iterator"], r = 0; if (t) return t.call(e); if ("function" == typeof e.next) return e; if (!isNaN(e.length)) return { next: function () { return e && r >= e.length && (e = void 0), { value: e && e[r++], done: !e }; } }; } throw new TypeError(typeof e + " is not iterable"); }
function _regeneratorKeys(e) { var n = Object(e), r = []; for (var t in n) r.unshift(t); return function e() { for (; r.length;) if ((t = r.pop()) in n) return e.value = t, e.done = !1, e; return e.done = !0, e; }; }
function _regeneratorAsync(n, e, r, t, o) { var a = _regeneratorAsyncGen(n, e, r, t, o); return a.next().then(function (n) { return n.done ? n.value : a.next(); }); }
function _regeneratorAsyncGen(r, e, t, o, n) { return new _regeneratorAsyncIterator(_regenerator().w(r, e, t, o), n || Promise); }
function _regeneratorAsyncIterator(t, e) { function n(r, o, i, f) { try { var c = t[r](o), u = c.value; return u instanceof _OverloadYield ? e.resolve(u.v).then(function (t) { n("next", t, i, f); }, function (t) { n("throw", t, i, f); }) : e.resolve(u).then(function (t) { c.value = t, i(c); }, function (t) { return n("throw", t, i, f); }); } catch (t) { f(t); } } var r; this.next || (_regeneratorDefine(_regeneratorAsyncIterator.prototype), _regeneratorDefine(_regeneratorAsyncIterator.prototype, "function" == typeof Symbol && Symbol.asyncIterator || "@asyncIterator", function () { return this; })), _regeneratorDefine(this, "_invoke", function (t, o, i) { function f() { return new e(function (e, r) { n(t, i, e, r); }); } return r = r ? r.then(f, f) : f(); }, !0); }
function _regenerator() { /*! regenerator-runtime -- Copyright (c) 2014-present, Facebook, Inc. -- license (MIT): https://github.com/babel/babel/blob/main/packages/babel-helpers/LICENSE */ var e, t, r = "function" == typeof Symbol ? Symbol : {}, n = r.iterator || "@@iterator", o = r.toStringTag || "@@toStringTag"; function i(r, n, o, i) { var c = n && n.prototype instanceof Generator ? n : Generator, u = Object.create(c.prototype); return _regeneratorDefine(u, "_invoke", function (r, n, o) { var i, c, u, f = 0, p = o || [], y = !1, G = { p: 0, n: 0, v: e, a: d, f: d.bind(e, 4), d: function (t, r) { return i = t, c = 0, u = e, G.n = r, a; } }; function d(r, n) { for (c = r, u = n, t = 0; !y && f && !o && t < p.length; t++) { var o, i = p[t], d = G.p, l = i[2]; r > 3 ? (o = l === n) && (u = i[(c = i[4]) ? 5 : (c = 3, 3)], i[4] = i[5] = e) : i[0] <= d && ((o = r < 2 && d < i[1]) ? (c = 0, G.v = n, G.n = i[1]) : d < l && (o = r < 3 || i[0] > n || n > l) && (i[4] = r, i[5] = n, G.n = l, c = 0)); } if (o || r > 1) return a; throw y = !0, n; } return function (o, p, l) { if (f > 1) throw TypeError("Generator is already running"); for (y && 1 === p && d(p, l), c = p, u = l; (t = c < 2 ? e : u) || !y;) { i || (c ? c < 3 ? (c > 1 && (G.n = -1), d(c, u)) : G.n = u : G.v = u); try { if (f = 2, i) { if (c || (o = "next"), t = i[o]) { if (!(t = t.call(i, u))) throw TypeError("iterator result is not an object"); if (!t.done) return t; u = t.value, c < 2 && (c = 0); } else 1 === c && (t = i.return) && t.call(i), c < 2 && (u = TypeError("The iterator does not provide a '" + o + "' method"), c = 1); i = e; } else if ((t = (y = G.n < 0) ? u : r.call(n, G)) !== a) break; } catch (t) { i = e, c = 1, u = t; } finally { f = 1; } } return { value: t, done: y }; }; }(r, o, i), !0), u; } var a = {}; function Generator() {} function GeneratorFunction() {} function GeneratorFunctionPrototype() {} t = Object.getPrototypeOf; var c = [][n] ? t(t([][n]())) : (_regeneratorDefine(t = {}, n, function () { return this; }), t), u = GeneratorFunctionPrototype.prototype = Generator.prototype = Object.create(c); function f(e) { return Object.setPrototypeOf ? Object.setPrototypeOf(e, GeneratorFunctionPrototype) : (e.__proto__ = GeneratorFunctionPrototype, _regeneratorDefine(e, o, "GeneratorFunction")), e.prototype = Object.create(u), e; } return GeneratorFunction.prototype = GeneratorFunctionPrototype, _regeneratorDefine(u, "constructor", GeneratorFunctionPrototype), _regeneratorDefine(GeneratorFunctionPrototype, "constructor", GeneratorFunction), GeneratorFunction.displayName = "GeneratorFunction", _regeneratorDefine(GeneratorFunctionPrototype, o, "GeneratorFunction"), _regeneratorDefine(u), _regeneratorDefine(u, o, "Generator"), _regeneratorDefine(u, n, function () { return this; }), _regeneratorDefine(u, "toString", function () { return "[object Generator]"; }), (_regenerator = function () { return { w: i, m: f }; })(); }
function _regeneratorDefine(e, r, n, t) { var i = Object.defineProperty; try { i({}, "", {}); } catch (e) { i = 0; } _regeneratorDefine = function (e, r, n, t) { function o(r, n) { _regeneratorDefine(e, r, function (e) { return this._invoke(r, n, e); }); } r ? i ? i(e, r, { value: n, enumerable: !t, configurable: !t, writable: !t }) : e[r] = n : (o("next", 0), o("throw", 1), o("return", 2)); }, _regeneratorDefine(e, r, n, t); }
function _OverloadYield(e, d) { this.v = e, this.k = d; }
function asyncGeneratorStep(n, t, e, r, o, a, c) { try { var i = n[a](c), u = i.value; } catch (n) { return void e(n); } i.done ? t(u) : Promise.resolve(u).then(r, o); }
function _asyncToGenerator(n) { return function () { var t = this, e = arguments; return new Promise(function (r, o) { var a = n.apply(t, e); function _next(n) { asyncGeneratorStep(a, r, o, _next, _throw, "next", n); } function _throw(n) { asyncGeneratorStep(a, r, o, _next, _throw, "throw", n); } _next(void 0); }); }; }
`,
    direct: `// The page's own code: an API client and the code calling it.
class ApiClient {
  request(url) {
    return _asyncToGenerator(/*#__PURE__*/_regeneratorRuntime().mark(function _callee() {
      var response;
      return _regeneratorRuntime().wrap(function _callee$(_context) {
        while (1) switch (_context.prev = _context.next) {
          case 0:
            _context.next = 2;
            return fetch(url);
          case 2:
            response = _context.sent;
            return _context.abrupt("return", response);
          case 4:
          case "end":
            return _context.stop();
        }
      }, _callee);
    }))();
  }
}
const api = new ApiClient();
function loadCart() {
  return _loadCart.apply(this, arguments);
}
function _loadCart() {
  _loadCart = _asyncToGenerator(/*#__PURE__*/_regeneratorRuntime().mark(function _callee2() {
    return _regeneratorRuntime().wrap(function _callee2$(_context2) {
      while (1) switch (_context2.prev = _context2.next) {
        case 0:
          _context2.next = 2;
          return api.request('/api/cart');
        case 2:
          return _context2.abrupt("return", _context2.sent);
        case 3:
        case "end":
          return _context2.stop();
      }
    }, _callee2);
  }));
  return _loadCart.apply(this, arguments);
}
function onMount() {
  return loadCart();
}
globalThis.onMount = onMount;`,
    resumed: `// The page's own code: an API client and the code calling it. The request
// goes out after an await, so it is sent from a resumed task.
class ApiClient {
  request(url) {
    return _asyncToGenerator(/*#__PURE__*/_regeneratorRuntime().mark(function _callee() {
      var response;
      return _regeneratorRuntime().wrap(function _callee$(_context) {
        while (1) switch (_context.prev = _context.next) {
          case 0:
            _context.next = 2;
            return Promise.resolve();
          case 2:
            _context.next = 4;
            return fetch(url);
          case 4:
            response = _context.sent;
            return _context.abrupt("return", response);
          case 6:
          case "end":
            return _context.stop();
        }
      }, _callee);
    }))();
  }
}
const api = new ApiClient();
function loadCart() {
  return _loadCart.apply(this, arguments);
}
function _loadCart() {
  _loadCart = _asyncToGenerator(/*#__PURE__*/_regeneratorRuntime().mark(function _callee2() {
    return _regeneratorRuntime().wrap(function _callee2$(_context2) {
      while (1) switch (_context2.prev = _context2.next) {
        case 0:
          _context2.next = 2;
          return api.request('/api/cart');
        case 2:
          return _context2.abrupt("return", _context2.sent);
        case 3:
        case "end":
          return _context2.stop();
      }
    }, _callee2);
  }));
  return _loadCart.apply(this, arguments);
}
function onMount() {
  return loadCart();
}
globalThis.onMount = onMount;`,
  },
};

/** The caller recorded for the compiled page code's failed request. */
async function compiledCaller(compiler, variant) {
  const page = arm({ fetch: () => Promise.resolve(response(500)) });
  const code = COMPILED[compiler];
  vm.runInContext(code.helpers + code[variant], page.page, {
    filename: `http://localhost/assets/${compiler}.js`,
  });
  await page.realm('onMount()');
  const [entry] = page.snapshot().network;
  // The realm has no URL to take the origin off with, as Chrome does.
  return (entry.caller || []).map((frame) => frame.replaceAll('http://localhost/assets/', ''));
}

test('collector: a failed request names the page behind compiled async functions, not their helpers (CO4)', async () => {
  // Each async function is printed once, under its own name, at the line in
  // its body, as Chrome prints a native async function: the body above the
  // helper and the function below it are one function of the source.
  assert.deepEqual(await compiledCaller('tsEs2015', 'direct'), [
    'ApiClient.request (tsEs2015.js:14:36)',
    'loadCart (tsEs2015.js:22:26)',
    'onMount (tsEs2015.js:25:29)',
  ]);
  assert.deepEqual(await compiledCaller('tsEs5', 'direct'), [
    'ApiClient.request (tsEs5.js:46:50)',
    'loadCart (tsEs5.js:61:50)',
    'onMount (tsEs5.js:67:29)',
  ]);
  assert.deepEqual(await compiledCaller('babelGenerator', 'direct'), [
    'ApiClient.request (babelGenerator.js:9:30)',
    // Babel's loadCart() calls _loadCart(), which holds the helper.
    'loadCart (babelGenerator.js:24:22)',
    'onMount (babelGenerator.js:30:10)',
  ]);
  assert.deepEqual(await compiledCaller('babelRegenerator', 'direct'), [
    'ApiClient.request (babelRegenerator.js:31:24)',
    'loadCart (babelRegenerator.js:69:24)',
    'onMount (babelRegenerator.js:85:10)',
  ]);
  assert.deepEqual(await compiledCaller('esbuild', 'direct'), [
    'ApiClient.request (esbuild.js:24:30)',
    'loadCart (esbuild.js:32:22)',
    'onMount (esbuild.js:36:10)',
  ]);
  // Resumed from a microtask, nothing of the page is left below the body,
  // and none of the helper's frames take a slot in its place.
  assert.deepEqual(await compiledCaller('tsEs2015', 'resumed'), ['ApiClient.<anonymous> (tsEs2015.js:16:36)']);
  assert.deepEqual(await compiledCaller('tsEs5', 'resumed'), ['ApiClient.<anonymous> (tsEs5.js:50:46)']);
  assert.deepEqual(await compiledCaller('babelGenerator', 'resumed'), ['babelGenerator.js:11:30']);
  // regenerator's _callee$ is no name anybody wrote.
  assert.deepEqual(await compiledCaller('babelRegenerator', 'resumed'), ['babelRegenerator.js:36:24']);
  assert.deepEqual(await compiledCaller('esbuild', 'resumed'), ['ApiClient.<anonymous> (esbuild.js:25:30)']);
});

test('collector: a failed request names the page behind SWC and Babel regeneratorRuntime helpers, never a helper line under its name (CO4)', async () => {
  // SWC's next has no name V8 can give it ("Object.<anonymous>"), and the
  // regeneratorRuntime wrapper has none at all. Both sit between the body
  // and the helper frames already known, and the body's line was printed
  // under the function's name before: a line inside the helper.
  assert.deepEqual(await compiledCaller('swc', 'direct'), [
    'ApiClient.request (swc.js:80:29)',
    'loadCart (swc.js:105:29)',
    'onMount (swc.js:118:12)',
  ]);
  assert.deepEqual(await compiledCaller('babelRegeneratorRuntime', 'direct'), [
    'ApiClient.request (babelRegeneratorRuntime.js:21:20)',
    'loadCart (babelRegeneratorRuntime.js:43:22)',
    'onMount (babelRegeneratorRuntime.js:55:10)',
  ]);
  assert.deepEqual(await compiledCaller('swc', 'resumed'), ['ApiClient.<anonymous> (swc.js:87:29)']);
  assert.deepEqual(await compiledCaller('babelRegeneratorRuntime', 'resumed'), ['babelRegeneratorRuntime.js:25:20']);
});

test('collector: a frame of a helper it does not know is printed as it is, not under the function\'s name (CO4)', async () => {
  // Babel's generator helpers with one anonymous frame of a kind no
  // compiler is known to make, between Generator.next and asyncGeneratorStep.
  // Taken for the body, it printed its own line, inside the helper, under
  // ApiClient.request.
  const page = arm({ fetch: () => Promise.resolve(response(500)) });
  const code = COMPILED.babelGenerator;
  const helpers = code.helpers.replace('var info = gen[key](arg);', 'var info = (function (g, k, a) { return g[k](a); })(gen, key, arg);');
  assert.notEqual(helpers, code.helpers);
  vm.runInContext(helpers + code.direct, page.page, { filename: 'http://localhost/assets/unknown.js' });
  await page.realm('onMount()');
  const [entry] = page.snapshot().network;
  const caller = entry.caller.map((frame) => frame.replaceAll('http://localhost/assets/', ''));
  const helperLine = (frame) => /unknown\.js:1:/.test(frame);
  assert.ok(!caller.some((frame) => helperLine(frame) && /^\w+\.request|^loadCart|^onMount/.test(frame)), JSON.stringify(caller));
  // The body at its line, the unknown frame as it is, and the function at
  // its own line: three slots, none of them wrong.
  assert.deepEqual(caller, ['unknown.js:9:30', 'unknown.js:1:128', 'ApiClient.request (unknown.js:11:7)']);
});

test("collector: the page's own functions named like a helper's inner ones stay in its caller (CO4)", async () => {
  const page = arm({ fetch: () => Promise.resolve(response(500)) });
  vm.runInContext(
    `
    // A wizard's step and next, a tryCatch utility, and a _next of its own.
    const wizard = { next() { return step(2); } };
    function step(n) { return fetch('/api/step/' + n); }
    function tryCatch(run) { try { return run(); } catch (error) { return null; } }
    function load() { return fetch('/api/load'); }
    function _next() { return tryCatch(load); }
    function onNext() { return wizard.next(); }
    // A generator of the page's, driven by hand as a saga library drives one.
    function* fetchUser() { yield fetch('/api/user'); }
    function runSaga() { const saga = fetchUser(); return saga.next().value; }
    globalThis.calls = [onNext(), _next(), runSaga()];
    `,
    page.page,
    { filename: 'http://localhost/assets/wizard.js' }
  );
  await Promise.all(page.page.calls);
  const callers = page.snapshot().network.map((entry) =>
    entry.caller.map((frame) => frame.replace(/ \(.*\)$/, '').replace('http://localhost/assets/', ''))
  );
  assert.deepEqual(callers, [
    ['step', 'Object.next', 'onNext'],
    ['load', 'tryCatch', '_next'],
    // The saga's body is not taken for an async function's: it keeps its
    // name, and the script's own line follows.
    ['fetchUser', 'runSaga', 'wizard.js:12:44'],
  ]);
});

test("collector: a function of the page's named step, awaited in a compiled object literal method, names the request (CO4)", async () => {
  // TypeScript's es2015 output: the generator body of an object literal's
  // method reads "Object.<anonymous>" under the page's step, over the
  // engine's Generator.next, which SWC's next and step do too, over
  // asyncGeneratorStep.
  const page = arm({ fetch: () => Promise.resolve(response(500)) });
  vm.runInContext(
    `"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
// The page's own code: a wizard whose method awaits the page's step().
function step(url) { return fetch(url); }
const wizard = {
    advance(url) {
        return __awaiter(this, void 0, void 0, function* () {
            const response = yield step(url);
            return response;
        });
    }
};
function loadStep() {
    return __awaiter(this, void 0, void 0, function* () {
        return yield wizard.advance('/api/step');
    });
}
function onMount() { return loadStep(); }
globalThis.onMount = onMount;`,
    page.page,
    { filename: 'http://localhost/assets/wizard.js' }
  );
  await page.realm('onMount()');
  const [entry] = page.snapshot().network;
  assert.deepEqual(
    entry.caller.map((frame) => frame.replaceAll('http://localhost/assets/', '')),
    ['step (wizard.js:12:29)', 'Object.advance (wizard.js:16:36)', 'loadStep (wizard.js:23:29)']
  );
});

test('collector: a failed resource, method and status text are cut like every other text (CO7)', async () => {
  const page = arm({ fetch: () => Promise.resolve(response(500, 'R'.repeat(5000))) });
  page.dispatch('error', {
    target: { tagName: 'IMG', src: `data:image/png;base64,${'A'.repeat(5000)}` },
  });
  await page.page.fetch('/api/x', { method: 'M'.repeat(5000) });
  const { errors, network } = page.snapshot();
  assert.ok(errors[0].text.length <= 613, `resource text is ${errors[0].text.length} long`);
  assert.ok(errors[0].text.endsWith(' …[truncated]'));
  assert.ok(network[0].method.length <= 613, `method is ${network[0].method.length} long`);
  assert.ok(network[0].statusText.length <= 613, `status text is ${network[0].statusText.length} long`);
});

test('collector: console text fills in its format string, and an Error prints its header once (CO8)', () => {
  const page = arm();
  const { console: log } = page.page;
  // React's own warnings are written this way.
  log.error('Each child in a list should have a unique "key" prop.%s%s See https://react.dev/link/warning-keys', '\n\nCheck the render method of `CartList`.', '');
  log.error('%d items, %i left, %f each', '42.9', 7.8, '3.5x');
  log.error('%cStyled%c and plain', 'color: red', '', 'extra');
  log.error('100%', 'done');
  log.error('%o and %%s', { a: 1 });
  log.error(page.realm(`new Error('boom')`));
  const texts = page.snapshot().console.map((entry) => entry.text);
  assert.equal(
    texts[0],
    'Each child in a list should have a unique "key" prop.\n\nCheck the render method of `CartList`. See https://react.dev/link/warning-keys'
  );
  assert.equal(texts[1], '42 items, 7 left, 3.5 each');
  assert.equal(texts[2], 'Styled and plain extra');
  assert.equal(texts[3], '100% done');
  assert.equal(texts[4], '{"a":1} and %s');
  assert.match(texts[5], /^Error: boom\n {4}at /);
  assert.equal(texts[5].split('\n').filter((line) => line === 'Error: boom').length, 1);
});

test('collector: logging a value runs none of the page code it holds (CO12)', () => {
  const page = arm();
  const calls = page.realm(`
    const calls = { getter: 0, trap: 0, toJSON: 0 };
    String.prototype.toString = function () { return 'replaced'; };
    String.prototype.valueOf = function () { return 'replaced'; };
    console.error({ get lazy() { calls.getter += 1; return 1; }, a: 1 });
    console.error(new Proxy({ a: 1 }, { get() { calls.trap += 1; return 'trapped'; } }));
    console.error({ toJSON() { calls.toJSON += 1; return 'mine'; }, a: 1 });
    console.error({ s: new String('real'), n: 10n });
    console.error([new String('null'), new Date(NaN), new Number(Infinity), new Boolean(false)]);
    calls;
  `);
  assert.deepEqual(plain(calls), { getter: 0, trap: 0, toJSON: 0 });
  assert.deepEqual(
    page.snapshot().console.map((entry) => entry.text),
    ['{"lazy":"[Getter]","a":1}', '{"a":1}', '{"a":1}', '{"s":"real","n":10n}', '["null",null,null,false]']
  );
});

test('collector: a wide value costs only as much as is printed of it (F30)', () => {
  const page = arm();
  const elapsed = page.realm(`
    const sparse = [];
    sparse.length = 1e7;
    const wrappers = [];
    const long = 'x'.repeat(100000);
    for (let i = 0; i < 4000; i += 1) wrappers.push(new String(long));
    const started = Date.now();
    console.error(sparse);
    console.error(wrappers);
    Date.now() - started;
  `);
  // Measured at about 560 ms and 1 s with JSON.stringify, which no replacer
  // can stop; a fraction of a millisecond each now.
  assert.ok(elapsed < 150, `took ${elapsed} ms`);
  const [sparse, wrappers] = page.snapshot().console.map((entry) => entry.text);
  assert.ok(sparse.startsWith('[null,null,') && sparse.endsWith(' …[truncated]'));
  assert.ok(wrappers.startsWith('["xxx') && wrappers.endsWith(' …[truncated]'));
});

test('collector: a secret word in the middle of a long key withholds its value (F21)', () => {
  const page = arm();
  page.page.console.error({ [`${'x'.repeat(250)}_password_${'y'.repeat(250)}`]: 'hunter2' });
  const [entry] = page.snapshot().console;
  assert.ok(entry.text.includes('<redacted>'), entry.text);
  assert.ok(!entry.text.includes('hunter2'));
});

test('collector: its wrappers read as the natives they replace, and no global marks it (CO14)', () => {
  // A method has no prototype and refuses new, as the native fetch does.
  const page = arm({ fetch: { fetch(input) {} }.fetch });
  const described = page.realm(`
    const show = (fn) => [fn.name, fn.length, 'prototype' in fn, Function.prototype.toString.call(fn).includes('[native code]')];
    ({
      error: show(console.error),
      warn: show(console.warn),
      fetch: show(fetch),
      open: show(XMLHttpRequest.prototype.open),
      send: show(XMLHttpRequest.prototype.send),
      abort: show(XMLHttpRequest.prototype.abort),
      global: Object.getOwnPropertyNames(window).filter((name) => name.startsWith('__cdr')),
    });
  `);
  assert.deepEqual(plain(described), {
    error: ['error', 0, false, true],
    warn: ['warn', 0, false, true],
    fetch: ['fetch', 1, false, true],
    open: ['open', 2, false, true],
    send: ['send', 0, false, true],
    abort: ['abort', 0, false, true],
    global: [],
  });
  assert.throws(() => page.realm('new fetch("/x")'), { name: 'TypeError' });
});

test('collector: the log is not handed to whoever posts a request to the window (CO14)', () => {
  const page = arm();
  page.page.console.error('private to the page and the panel');
  assert.equal(page.request('inspect', { marker: 'none' }), null);
  // As the bridge of 0.5.0 asked, and as any script on the page can.
  for (const action of ['snapshot', 'clear']) {
    page.dispatch('message', { source: page.self, data: { __cdr: 'request', action, id: `x-${action}` } });
  }
  const answers = page.posted.filter((message) => String(message.id).startsWith('x-'));
  assert.deepEqual(plain(answers.map((message) => message.payload)), [null, null]);
  assert.equal(page.snapshot().console.length, 1);
});

test('collector: a failed resource keeps its address for srcset, SVG and object (M3)', () => {
  const page = arm();
  page.dispatch('error', { target: { tagName: 'IMG', src: '', currentSrc: 'http://localhost/hero@2x.png' } });
  page.dispatch('error', { target: { tagName: 'image', href: { baseVal: 'http://localhost/icons/cart.svg', animVal: '' } } });
  page.dispatch('error', { target: { tagName: 'OBJECT', data: 'http://localhost/manual.pdf' } });
  assert.deepEqual(
    page.snapshot().errors.map((entry) => entry.text),
    [
      'Failed to load <img>: http://localhost/hero@2x.png',
      'Failed to load <image>: http://localhost/icons/cart.svg',
      'Failed to load <object>: http://localhost/manual.pdf',
    ]
  );
});

test('collector: a request the page\'s CSP blocked says so, in either order of the two events (M4)', async () => {
  const page = arm({ fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
  const violation = (url) =>
    page.dispatch('securitypolicyviolation', {
      disposition: 'enforce',
      effectiveDirective: 'connect-src',
      blockedURI: url,
    });
  violation('http://tracker.test/first');
  await page.page.fetch('http://tracker.test/first').catch(() => {});
  await page.page.fetch('http://tracker.test/second').catch(() => {});
  violation('http://tracker.test/second');
  await page.page.fetch('http://api.test/down').catch(() => {});
  const lines = page.snapshot().network.map((entry) => entry.statusText);
  assert.match(lines[0], /^Blocked by the page's Content Security Policy/);
  assert.match(lines[1], /^Blocked by the page's Content Security Policy/);
  assert.match(lines[1], /punch-list/);
  assert.equal(lines[2], 'Network failure: Failed to fetch');
});

test('collector: props are read from the fiber on screen, not its alternate (M5)', () => {
  const page = arm();
  const fiberRoot = {};
  const root = { tag: 3, stateNode: fiberRoot, return: null };
  const rootNext = { tag: 3, stateNode: fiberRoot, return: null, alternate: root };
  root.alternate = rootNext;
  const Counter = function Counter() {};
  // The DOM node still points into the tree of the render before, as React
  // leaves it every other commit.
  const stale = { tag: 0, type: Counter, memoizedProps: { count: 1 }, return: root };
  const fresh = { tag: 0, type: Counter, memoizedProps: { count: 2 }, return: rootNext, alternate: stale };
  stale.alternate = fresh;
  root.child = stale;
  rootNext.child = fresh;
  const host = { tag: 5, type: 'span', memoizedProps: {}, return: stale };
  const inspect = pickable(page, host);
  fiberRoot.current = rootNext;
  assert.deepEqual(inspect().component.props, ['count=2']);
  fiberRoot.current = root;
  assert.deepEqual(inspect().component.props, ['count=1']);
});

test('collector: the owner is sent when it is the nearest component too (PI2)', () => {
  const page = arm();
  const button = { tag: 0, type: function CartButton() {}, memoizedProps: {}, return: null, _debugOwner: null };
  const host = { tag: 5, type: 'button', memoizedProps: {}, return: button, _debugOwner: button };
  const { component } = pickable(page, host)();
  assert.equal(component.names[0], 'CartButton');
  assert.equal(component.owner, 'CartButton');
});

test('collector: a call site read from a stack frame says so (PI9)', () => {
  const page = arm();
  const button = { tag: 0, type: function CartButton() {}, memoizedProps: {}, return: null, _debugOwner: null };
  const stack = [
    'Error: react-stack-top-frame',
    '    at exports.jsxDEV (http://localhost/node_modules/.vite/deps/react_jsx-dev-runtime.js:250:30)',
    '    at CartButton (http://localhost/src/Cart.jsx?t=1712:41:7)',
    '    at react-stack-bottom-frame (http://localhost/node_modules/.vite/deps/react-dom_client.js:1:1)',
  ].join('\n');
  const host = { tag: 5, type: 'button', memoizedProps: {}, return: button, _debugOwner: button, _debugStack: { stack } };
  const fromStack = pickable(page, host)().component;
  assert.match(fromStack.source, /^(?:http:\/\/localhost)?\/src\/Cart\.jsx:41:7$/);
  assert.equal(fromStack.sourceFrom, 'stack');
  host._debugSource = { fileName: '/src/Cart.jsx', lineNumber: 40, columnNumber: 5 };
  const fromSource = pickable(page, host)().component;
  assert.equal(fromSource.source, '/src/Cart.jsx:40:5');
  assert.equal(fromSource.sourceFrom, undefined);
});

test('collector: handler text skips minified bodies, keeps // in strings, and unbinds names (PI16)', () => {
  const page = arm();
  const component = { tag: 0, type: function Toolbar() {}, memoizedProps: {}, return: null, _debugOwner: null };
  const host = { tag: 5, type: 'button', memoizedProps: {}, return: component, _debugOwner: component };
  const [minified, withUrl, bound] = page.realm(`[
    (e)=>{e.preventDefault(),t(n.value),r.current.focus()},
    function openHelp() { window.open('https://docs.example.com/help'); track('help'); },
    (function handleClick() {}).bind(null),
  ]`);
  const starts = (fn) => pickable(page, host, { onClick: fn })().handlers;
  assert.equal(starts(minified).starts, '');
  assert.equal(
    starts(withUrl).starts,
    "window.open('https://docs.example.com/help'); track('help');"
  );
  assert.deepEqual(starts(bound).list, ['onClick=ƒ handleClick']);
});

test('collector: a Provider folded into its component prints the component\'s props (PI21)', () => {
  const page = arm();
  const TooltipProvider = function TooltipProvider() {};
  const Provider = function () {};
  Provider.displayName = 'TooltipProviderProvider';
  const outer = { tag: 0, type: TooltipProvider, memoizedProps: { delayDuration: 300 }, return: null };
  const inner = { tag: 0, type: Provider, memoizedProps: { isOpenDelayed: true, delayDuration: 700 }, return: outer };
  const host = { tag: 5, type: 'div', memoizedProps: {}, return: inner };
  const { component } = pickable(page, host)();
  assert.equal(component.names[0], 'TooltipProvider');
  assert.deepEqual(component.props, ['delayDuration=300']);
});

test('collector: a page listener that stops loadend or timeout ahead of the collector hides nothing (F10)', async () => {
  const page = arm();
  {
    const xhr = new page.page.XMLHttpRequest();
    xhr.addEventListener('loadend', (event) => event.stopImmediatePropagation());
    xhr.open('GET', '/api/cart');
    xhr.send();
    xhr.finish(500, 'Internal Server Error', ['readystatechange', 'load']);
  }
  {
    const xhr = new page.page.XMLHttpRequest();
    xhr.addEventListener('timeout', (event) => event.stopImmediatePropagation());
    xhr.timeout = 1000;
    page.clock.now = 5;
    xhr.open('GET', '/api/rates');
    xhr.send();
    page.clock.now += 1000;
    xhr.finish(0, '', ['readystatechange', 'timeout']);
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(
    page.snapshot().network.map(({ url, status, outcome }) => [url, status, outcome ?? null]),
    [
      ['/api/rates', 0, 'timeout'],
      ['/api/cart', 500, null],
    ]
  );
});

test('collector: a page listener that stops readystatechange and loadend ahead of the collector hides no failure (F10)', async () => {
  const page = arm();
  // Added before the first open(), and so ahead of every listener of the
  // collector's: each stops readystatechange and loadend, and lets the event
  // the request ends with through.
  const stopping = () => {
    const xhr = new page.page.XMLHttpRequest();
    for (const type of ['readystatechange', 'loadend']) {
      xhr.addEventListener(type, (event) => event.stopImmediatePropagation());
    }
    return xhr;
  };
  {
    const xhr = stopping();
    xhr.open('GET', '/api/cart');
    xhr.send();
    xhr.finish(500, 'Internal Server Error', ['readystatechange', 'load']);
  }
  {
    const xhr = stopping();
    xhr.open('GET', '/api/offline');
    xhr.send();
    xhr.finish(0, '', ['readystatechange', 'error']);
  }
  {
    const xhr = stopping();
    xhr.timeout = 1000;
    xhr.open('GET', '/api/rates');
    xhr.send();
    xhr.finish(0, '', ['readystatechange', 'timeout']);
  }
  // And nothing for one that succeeded behind such a listener.
  {
    const xhr = stopping();
    xhr.open('GET', '/api/ok');
    xhr.send();
    xhr.finish(200, 'OK', ['readystatechange', 'load']);
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(
    page.snapshot().network.map(({ url, status, statusText, outcome }) => [url, status, statusText, outcome ?? null]),
    [
      ['/api/cart', 500, 'Internal Server Error', null],
      ['/api/offline', 0, 'Network failure', null],
      ['/api/rates', 0, '', 'timeout'],
    ]
  );
});

test('collector: handler text keeps readable member calls and still drops minified ones (PI16)', () => {
  const page = arm();
  const component = { tag: 0, type: function Panel() {}, memoizedProps: {}, return: null, _debugOwner: null };
  const host = { tag: 5, type: 'button', memoizedProps: {}, return: component, _debugOwner: component };
  const starts = (fn) => pickable(page, host, { onClick: fn })().handlers.starts;
  // Never called: only their text is read.
  const readable = page.realm(`[
    () => this.toggle(),
    () => this.props.onClose(this.props.id),
    () => window.location.reload(),
    (ev) => { ev.preventDefault(); this.props.store.cart.clear(); },
    () => store.save(item),
    () => window.bump(),
    () => this?.props.onOpen(),
  ]`);
  assert.deepEqual(Array.from(readable, starts), [
    'this.toggle()',
    'this.props.onClose(this.props.id)',
    'window.location.reload()',
    'ev.preventDefault(); this.props.store.cart.clear();',
    'store.save(item)',
    'window.bump()',
    'this?.props.onOpen()',
  ]);
  const minified = page.realm(`[
    (e)=>{e.preventDefault(),t(n.value),r.current.focus()},
    ()=>Object.assign(t,n),
    function(){return this.t.apply(this,arguments)},
    e=>{a.window.open(e)},
    ()=>{window.t(n)},
  ]`);
  assert.deepEqual(Array.from(minified, starts), ['', '', '', '', '']);
});

test('collector: a minified handler body stays minified when it also calls a method off window or document (PI16)', () => {
  const page = arm();
  const component = { tag: 0, type: function Menu() {}, memoizedProps: {}, return: null, _debugOwner: null };
  const host = { tag: 5, type: 'button', memoizedProps: {}, return: component, _debugOwner: component };
  const starts = (fn) => pickable(page, host, { onClick: fn })().handlers.starts;
  // Never called: only their text is read. Each holds a readable member
  // call off window or document, and a shape only a minifier writes.
  const minified = page.realm(`[
    ()=>{document.body.style.overflow="hidden",n(!0)},
    e=>{e.preventDefault(),window.scrollTo({top:0}),o(!1)},
    ()=>{window.dispatchEvent(new Event("x")),r(void 0)},
    ()=>{document.activeElement.blur();t(e)},
  ]`);
  assert.deepEqual(Array.from(minified, starts), ['', '', '', '']);
  // Still readable: a one letter call with a string first (an i18n lookup),
  // jQuery's $, and member calls with no minified shape.
  const readable = page.realm(`[
    () => toast(t('cart.saved')),
    () => { $('#menu').toggle(); this.props.onToggle(); },
    () => document.getElementById('search').focus(),
    () => { window.scrollTo({ top: 0, behavior: 'smooth' }); },
  ]`);
  assert.deepEqual(Array.from(readable, starts), [
    "toast(t('cart.saved'))",
    "$('#menu').toggle(); this.props.onToggle();",
    "document.getElementById('search').focus()",
    "window.scrollTo({ top: 0, behavior: 'smooth' });",
  ]);
});

test('collector: handler text keeps readable bodies a minifier would not write, and drops minified ones that only read off window (PI16)', () => {
  const page = arm();
  const component = { tag: 0, type: function Editor() {}, memoizedProps: {}, return: null, _debugOwner: null };
  const host = { tag: 5, type: 'button', memoizedProps: {}, return: component, _debugOwner: component };
  const starts = (fn) => pickable(page, host, { onClick: fn })().handlers.starts;
  // Never called: only their text is read.
  const readable = page.realm(`[
    () => { showToast(t(errorKey)); },
    () => { let next = count + 1, max = 10; setCount(Math.min(next, max)); },
    () => { handleSave(), closeDialog() },
    () => x(item),
    (e) => window.open(e.target.href),
  ]`);
  assert.deepEqual(Array.from(readable, starts), [
    'showToast(t(errorKey));',
    'let next = count + 1, max = 10; setCount(Math.min(next, max));',
    'handleSave(), closeDialog()',
    'x(item)',
    'window.open(e.target.href)',
  ]);
  // A readable name read off window, document or self, and a name only a
  // minifier gives beside it.
  const minified = page.realm(`[
    ()=>{window.location.href=Bt(e.id)},
    ()=>{document.title=Qe(e.target.value)},
    ()=>{window.open(Hn(t),"_blank")},
    ()=>{self.postMessage(Gt)},
    async e=>{await window.fetch(Lt)},
  ]`);
  assert.deepEqual(Array.from(minified, starts), ['', '', '', '', '']);
});

// --------------------------------------------------- a secret control --

/**
 * A component that sets type itself, as a design system's PasswordInput
 * does, rendered inside another: the component's own props carry the value
 * and no type, and only the input it renders says it holds a password.
 */
function passwordForm(page, { attributes, hostProps, componentProps, tag = 'input' }) {
  const element = new page.page.HTMLInputElement(tag, attributes);
  element.value = 'hunter2-typed';
  const PasswordInput = function PasswordInput() {};
  const LoginForm = function LoginForm() {};
  const form = { tag: 0, type: LoginForm, memoizedProps: {}, return: null };
  const component = { tag: 0, type: PasswordInput, memoizedProps: componentProps, return: form };
  const host = { tag: 5, type: tag, stateNode: element, memoizedProps: hostProps, return: component };
  form.child = component;
  component.child = host;
  element.__reactFiber$t = host;
  return { element, component, host };
}

test('collector: a component that renders a password input withholds the value it was handed', () => {
  const page = arm({ dom: true });
  const onChange = function onChange() {};
  const { element } = passwordForm(page, {
    attributes: { type: 'password', autocomplete: 'current-password', id: 'pw' },
    hostProps: { id: 'pw', type: 'password', autoComplete: 'current-password', value: 'hunter2-typed', onChange },
    componentProps: { value: 'hunter2-typed', onChange },
  });
  page.page.document.querySelector = () => element;
  assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.props, [
    'value=<redacted>',
    'onChange=ƒ onChange',
  ]);
});

test('collector: what makes a control secret is read from the control, and its value is withheld under any name', () => {
  // A secret control, by its type, its autocomplete or its name, withholds
  // the component's value props and its value under any name; a hidden
  // input picked, its own value only; a card's name or expiry, nothing.
  const SECRET = ['text=<redacted>', 'defaultValue=<redacted>', 'label="Code"'];
  const cases = [
    // type="hidden": a CSRF token or an id the page keeps out of sight.
    {
      attributes: { type: 'hidden' },
      hostProps: { type: 'hidden' },
      expected: ['text=<redacted>', 'defaultValue="initial"', 'label="Code"'],
    },
    // Set on the element only, with no host props to say so.
    { attributes: { type: 'password' }, hostProps: {}, expected: SECRET },
    // An autocomplete for a password, a one-time code, a card's number or
    // its security code, among other tokens.
    { attributes: { autocomplete: 'new-password' }, hostProps: {}, expected: SECRET },
    { attributes: {}, hostProps: { autoComplete: 'one-time-code' }, expected: SECRET },
    { attributes: { autocomplete: 'billing cc-number' }, hostProps: {}, expected: SECRET },
    { attributes: { autocomplete: 'section-a cc-csc' }, hostProps: {}, expected: SECRET },
    // A secret name: the field's name or id, or an attribute's own name.
    { attributes: { name: 'pin' }, hostProps: {}, expected: SECRET },
    { attributes: {}, hostProps: { id: 'card-number' }, expected: SECRET },
    { attributes: { 'data-password-field': '' }, hostProps: {}, expected: SECRET },
    // The name on the card and its expiry hold nothing secret.
    {
      attributes: { autocomplete: 'billing cc-name' },
      hostProps: {},
      expected: ['text="hunter2-typed"', 'defaultValue="initial"', 'label="Code"'],
    },
    { attributes: {}, hostProps: { autoComplete: 'cc-exp' }, expected: ['text="hunter2-typed"', 'defaultValue="initial"', 'label="Code"'] },
  ];
  for (const { attributes, hostProps, expected } of cases) {
    const page = arm({ dom: true });
    const { element } = passwordForm(page, {
      attributes: { type: 'text', ...attributes },
      hostProps,
      // Under names the name test cannot catch, the value typed included.
      componentProps: { text: 'hunter2-typed', defaultValue: 'initial', label: 'Code' },
    });
    page.page.document.querySelector = () => element;
    assert.deepEqual(
      page.request('inspect', { marker: 'pick1' }).component.props,
      expected,
      JSON.stringify(attributes) + JSON.stringify(hostProps)
    );
  }
});

test('collector: a plain text field prints its value, and a secret one anywhere the component renders hides it', () => {
  {
    const page = arm({ dom: true });
    const { element } = passwordForm(page, {
      attributes: { type: 'text', name: 'city' },
      hostProps: { type: 'text', name: 'city' },
      componentProps: { value: 'hunter2-typed', label: 'City' },
    });
    page.page.document.querySelector = () => element;
    assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.props, [
      'value="hunter2-typed"',
      'label="City"',
    ]);
  }
  {
    // The label is picked, beside the password input the same component
    // renders: the component's props are printed, and the input decides.
    const page = arm({ dom: true });
    const { component, host } = passwordForm(page, {
      attributes: { type: 'password' },
      hostProps: { type: 'password' },
      componentProps: { value: 'hunter2-typed', label: 'Password' },
    });
    const label = new page.page.Element('label', {});
    const labelFiber = { tag: 5, type: 'label', stateNode: label, memoizedProps: {}, return: component, sibling: host };
    component.child = labelFiber;
    label.__reactFiber$t = labelFiber;
    page.page.document.querySelector = () => label;
    assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.props, [
      'value=<redacted>',
      'label="Password"',
    ]);
  }
});

test('collector: a Vue component rendering a password input withholds its v-model', () => {
  const page = arm({ dom: true });
  const element = new page.page.HTMLInputElement('input', { type: 'password' });
  element.value = 'hunter2-typed';
  const instance = {
    type: { name: 'PasswordInput' },
    props: { modelValue: 'hunter2-typed', placeholder: 'Your password' },
    parent: null,
    subTree: { type: 'input', el: element, props: { type: 'password' }, children: null },
  };
  element.__vnode = { ctx: instance, props: { type: 'password' } };
  page.page.document.querySelector = () => element;
  assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.props, [
    'modelValue=<redacted>',
    'placeholder="Your password"',
  ]);
});

/** A React component fiber over host fibers, linked as React links them. */
function reactTree(page, name, props, hosts) {
  const component = { tag: 0, type: { [name]: function () {} }[name], memoizedProps: props, return: null };
  let previous = null;
  for (const host of hosts) {
    host.tag = 5;
    host.return = component;
    if (previous) previous.sibling = host;
    else component.child = host;
    previous = host;
    if (host.stateNode) host.stateNode.__reactFiber$t = host;
  }
  return component;
}

/** A host fiber for an element of the fake DOM. */
function hostFiber(page, tag, attributes, memoizedProps = attributes, Kind = 'Element') {
  const element = new page.page[Kind](tag, attributes);
  return { type: tag, stateNode: element, memoizedProps };
}

test('collector: a prop holding what a secret control holds is withheld, and the other props print', () => {
  // A confirm field handed the first password, which its own field does not
  // hold; a copy trimmed before it was rendered; a code field seeded with a
  // number; a seed the user has typed on the end of.
  const cases = [
    {
      name: 'ConfirmField',
      props: { against: 'first-pass-456', label: 'Confirm', onChange: function onChange() {}, disabled: false },
      control: { type: 'password' },
      value: 'typed-other',
      // The first password field, elsewhere in the document.
      elsewhere: { attributes: { type: 'password', autocomplete: 'new-password' }, value: 'first-pass-456' },
      expected: ['against=<redacted>', 'label="Confirm"', 'onChange=ƒ onChange', 'disabled=false'],
    },
    {
      name: 'TrimmedPassword',
      props: { text: ' spaced-secret ' },
      control: { type: 'password' },
      value: 'spaced-secret',
      expected: ['text=<redacted>'],
    },
    {
      name: 'CodeField',
      props: { seed: 4321, digits: 6 },
      control: { type: 'text', autocomplete: 'one-time-code' },
      value: '4321',
      expected: ['seed=<redacted>', 'digits=6'],
    },
    {
      name: 'NewPassword',
      props: { initial: 'init-secret', type: 'password', autoComplete: 'new-password' },
      control: { autocomplete: 'new-password' },
      value: 'init-secret-more',
      expected: ['initial=<redacted>', 'type="password"', 'autoComplete="new-password"'],
    },
  ];
  for (const { name, props, control, value, elsewhere, expected } of cases) {
    const page = arm({ dom: true });
    if (elsewhere) new page.page.HTMLInputElement('input', elsewhere.attributes).value = elsewhere.value;
    const heading = hostFiber(page, 'h2', {});
    const input = hostFiber(page, 'input', control, {}, 'HTMLInputElement');
    input.stateNode.value = value;
    reactTree(page, name, props, [heading, input]);
    page.page.document.querySelector = () => heading.stateNode;
    assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.props, expected, name);
  }
});

test('collector: a component handed the password without rendering the field withholds it (a strength meter)', () => {
  // SignupForm keeps the password and renders the field; StrengthMeter and
  // RulesList are handed it and render none.
  const signup = (page) => {
    const field = hostFiber(page, 'input', { type: 'password', autocomplete: 'new-password' }, {}, 'HTMLInputElement');
    field.stateNode.value = 'meter-secret-1';
    const meter = hostFiber(page, 'div', { class: 'meter s4' });
    const rules = hostFiber(page, 'ul', {});
    reactTree(page, 'SignupForm', {}, [field]);
    reactTree(page, 'StrengthMeter', { value: 'meter-secret-1', max: 4 }, [meter]);
    reactTree(page, 'RulesList', { input: 'meter-secret-1', minimum: 8 }, [rules]);
    return { meter, rules };
  };
  for (const [which, expected] of [
    ['meter', ['value=<redacted>', 'max=4']],
    ['rules', ['input=<redacted>', 'minimum=8']],
  ]) {
    const page = arm({ dom: true });
    const picked = signup(page)[which];
    page.page.document.querySelector = () => picked.stateNode;
    assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.props, expected, which);
  }
  // The same in Vue.
  {
    const page = arm({ dom: true });
    new page.page.HTMLInputElement('input', { type: 'password' }).value = 'meter-secret-1';
    const bar = new page.page.Element('div', {});
    const instance = {
      type: { name: 'StrengthMeter' },
      props: { modelValue: 'meter-secret-1', label: 'Strength' },
      parent: null,
      subTree: { type: 'div', el: bar, props: {}, children: null },
    };
    bar.__vnode = { ctx: instance, props: {} };
    page.page.document.querySelector = () => bar;
    assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.props, [
      'modelValue=<redacted>',
      'label="Strength"',
    ]);
  }
});

test('collector: a show password toggle that made the field type="text" still keeps its seed withheld', () => {
  // RevealBox seeds the field from initial, the user typed on the end, and
  // the toggle is on: the field's name still says what it holds.
  const page = arm({ dom: true });
  const label = hostFiber(page, 'label', {});
  const field = hostFiber(page, 'input', { name: 'password', type: 'text' }, { name: 'password', type: 'text' }, 'HTMLInputElement');
  field.stateNode.value = 'reveal-seed-secret-typed';
  reactTree(page, 'RevealBox', { initial: 'reveal-seed-secret', hint: 'Show' }, [label, field]);
  page.page.document.querySelector = () => label.stateNode;
  assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.props, ['initial=<redacted>', 'hint="Show"']);
});

test('collector: a seed the user changed in the middle is still withheld, and a prop that only begins like it prints', () => {
  // A passphrase has no secret's shape, so only the field's value can say
  // what it is. The user put a word in the middle of the seed, took one
  // out, or changed a character of a long one with no space in it; the
  // summary is handed the seed and renders no field.
  const cases = [
    ['correct horse battery', 'correct horse staple battery'],
    ['correct horse staple battery', 'correct staple battery'],
    ['Tr0ub4dor-and-2-more', 'Tr0ub4dor-and-3-more'],
  ];
  for (const [seed, typed] of cases) {
    const page = arm({ dom: true });
    new page.page.HTMLInputElement('input', { type: 'password' }).value = typed;
    const box = hostFiber(page, 'div', {});
    reactTree(page, 'SeedSummary', { initial: seed, title: 'correct answers only', note: 'Welcome back' }, [box]);
    page.page.document.querySelector = () => box.stateNode;
    assert.deepEqual(
      page.request('inspect', { marker: 'pick1' }).component.props,
      ['initial=<redacted>', 'title="correct answers only"', 'note="Welcome back"'],
      seed
    );
  }
  // What they share at the two ends has to be most of both: a greeting that
  // begins with the word the password begins with prints.
  const page = arm({ dom: true });
  new page.page.HTMLInputElement('input', { type: 'password' }).value = 'Welcome to the jungle';
  const box = hostFiber(page, 'div', {});
  reactTree(page, 'Greeting', { note: 'Welcome back' }, [box]);
  page.page.document.querySelector = () => box.stateNode;
  assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.props, ['note="Welcome back"']);
});

test('collector: a prop a character away from a short password or a code is no edit of it, and prints, and one a digit away from a card number is withheld (F48)', () => {
  // The edit rule is for a passphrase or a seed, a value with a space in it
  // or of twelve characters or more. An ordinary word is a letter away from
  // a short password, and an order number a digit away from a code: each
  // printed in 0.6.0, and was withheld for that. A number of twelve digits
  // or more is no code: a prop a digit away from the card in the field
  // holds fifteen of its sixteen digits, and 0.6.0 printed that.
  const cases = [
    { control: { type: 'password' }, value: 'January2024', props: { period: 'January 2024', title: 'Billing' }, expected: ['period="January 2024"', 'title="Billing"'] },
    { control: { type: 'password' }, value: 'Passw0rd', props: { label: 'Password', hint: 'At least 8 characters' }, expected: ['label="Password"', 'hint="At least 8 characters"'] },
    { control: { type: 'password' }, value: 'hunXer', props: { initial: 'hunter' }, expected: ['initial="hunter"'] },
    { control: { autocomplete: 'one-time-code' }, value: '482913', props: { orderNumber: 482918, items: 3 }, expected: ['orderNumber=482918', 'items=3'] },
    { control: { autocomplete: 'tel', name: 'phone' }, value: '+1 (555) 010-4477', props: { support: '+1 (555) 010-4478' }, expected: ['support="+1 (555) 010-4478"'] },
    { control: { autocomplete: 'cc-number' }, value: '4242 4242 4242 4242', props: { lastValid: '4242 4242 4242 4241', items: 3 }, expected: ['lastValid=<redacted>', 'items=3'] },
    { control: { autocomplete: 'cc-number' }, value: '4242424242424242', props: { lastValid: '4242424242424243' }, expected: ['lastValid=<redacted>'] },
    // However either is grouped: a card preview takes the raw digits a
    // formatter hands back, or groups them its own way. A number of as many
    // digits that is not the card's still prints.
    { control: { autocomplete: 'cc-number' }, value: '4242 4242 4242 4242', props: { number: '4242424242424242', invoice: '9999 8888 7777 6666' }, expected: ['number=<redacted>', 'invoice="9999 8888 7777 6666"'] },
    { control: { autocomplete: 'cc-number' }, value: '4242424242424242', props: { number: '4242-4242-4242-4242' }, expected: ['number=<redacted>'] },
    { control: { autocomplete: 'cc-number' }, value: '3782 822463 10005', props: { number: '378282246310005' }, expected: ['number=<redacted>'] },
    { control: { autocomplete: 'cc-number' }, value: '4242 4242 4242 4242', props: { draft: '424242424242424', near: '4242424242424241' }, expected: ['draft=<redacted>', 'near=<redacted>'] },
    { control: { autocomplete: 'cc-number' }, value: '4242424242424242', props: { slashed: '4242/4242/4242/4242', thin: '4242\u20094242\u20094242\u20094242' }, expected: ['slashed=<redacted>', 'thin=<redacted>'] },
    // The raw digits of a grouped card quoted whole in longer text: a
    // sentence, JSON, a URL. Another card's digits there still print.
    {
      control: { autocomplete: 'cc-number' },
      value: '4242 4242 4242 4242',
      props: {
        summary: 'Card 4242424242424242 declined',
        payload: '{"pan":"4242424242424242","exp":"12/27"}',
        url: '/pay?card=4242424242424242&cvc=1',
        other: 'Card 9999888877776666 on file',
      },
      expected: ['summary=<redacted>', 'payload=<redacted>', 'url=<redacted>', 'other="Card 9999888877776666 on file"'],
    },
    // Only a number as long is judged by its digits: a PIN found in the
    // joined digits of a reference number, across its dash, is no copy of it.
    { control: { type: 'password', name: 'pin' }, value: '1234', props: { ref: '9912-3488 7766' }, expected: ['ref="9912-3488 7766"'] },
  ];
  for (const { control, value, props, expected } of cases) {
    const page = arm({ dom: true });
    new page.page.HTMLInputElement('input', control).value = value;
    const box = hostFiber(page, 'div', {});
    reactTree(page, 'Summary', props, [box]);
    page.page.document.querySelector = () => box.stateNode;
    assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.props, expected, value);
  }
});

// A card's digits are worked out when a pick is judged, not held beside the
// values: held, they took two of the 64 places a pick has for values, and a
// passphrase after 32 grouped numbers was no longer held.
test('collector: a passphrase after 40 grouped numbers in fields of the same form is still withheld', () => {
  const page = arm({ dom: true });
  const fields = [];
  for (let index = 0; index < 40; index += 1) {
    const field = hostFiber(page, 'input', { name: `account${index}` }, {}, 'HTMLInputElement');
    field.stateNode.value = `1000 2000 ${String(3000 + index)}`;
    fields.push(field);
  }
  const password = hostFiber(page, 'input', { type: 'password' }, {}, 'HTMLInputElement');
  password.stateNode.value = 'correct horse battery staple';
  reactTree(page, 'AccountsForm', { hint: 'correct horse battery staple', items: 3 }, [...fields, password]);
  page.page.document.querySelector = () => fields[0].stateNode;
  assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.props, ['hint=<redacted>', 'items=3']);
});

test('collector: a field in an open shadow root whose host says nothing of it still keeps its value out of props', () => {
  // A <login-form> of the page's own keeps its field in its shadow root, or
  // in the shadow root of an element inside that one. A passphrase has no
  // secret's shape, and the summary is handed it and renders no field.
  const cases = [
    { attributes: { type: 'password' }, nested: false },
    { attributes: { autocomplete: 'current-password' }, nested: true },
    // After a show password toggle: its name still says what it holds.
    { attributes: { type: 'text', name: 'password' }, nested: false },
    // After a hundred icons with shadow roots of their own, earlier in the
    // document, as on a page of web components.
    { attributes: { type: 'password' }, nested: false, icons: 100 },
  ];
  for (const { attributes, nested, icons = 0 } of cases) {
    const page = arm({ dom: true });
    for (let i = 0; i < icons; i += 1) {
      new page.page.Element('x-icon', {}).shadow = new page.page.DocumentFragment([new page.page.Element('svg', {})]);
    }
    const input = new page.page.HTMLInputElement('input', attributes);
    input.value = 'shadow pass phrase';
    const host = new page.page.Element('login-form', {});
    if (nested) {
      const inner = new page.page.Element('x-field', {});
      inner.shadow = new page.page.DocumentFragment([input]);
      host.shadow = new page.page.DocumentFragment([inner]);
    } else {
      host.shadow = new page.page.DocumentFragment([input]);
    }
    const box = hostFiber(page, 'div', {});
    reactTree(page, 'Meter', { input: 'shadow pass phrase', label: 'Strength' }, [box]);
    page.page.document.querySelector = () => box.stateNode;
    assert.deepEqual(
      page.request('inspect', { marker: 'pick1' }).component.props,
      ['input=<redacted>', 'label="Strength"'],
      JSON.stringify({ attributes, nested, icons })
    );
  }
});

test('collector: a field two shadow roots down is found however many roots follow its shell in the document (F48)', () => {
  // An <app-shell> first in the body, its <login-form> in its root, the
  // field in the form's root, and 600 icons with roots of their own after
  // the shell. The roots are taken depth first in document order, so the
  // icons cannot use up the 512 before the form's root is reached.
  const page = arm({ dom: true });
  const input = new page.page.HTMLInputElement('input', { type: 'password' });
  input.value = 'nested pass phrase';
  const login = new page.page.Element('login-form', {});
  login.shadow = new page.page.DocumentFragment([input]);
  const shell = new page.page.Element('app-shell', {});
  shell.shadow = new page.page.DocumentFragment([login]);
  for (let i = 0; i < 600; i += 1) {
    new page.page.Element('x-icon', {}).shadow = new page.page.DocumentFragment([new page.page.Element('svg', {})]);
  }
  const box = hostFiber(page, 'div', {});
  reactTree(page, 'Meter', { input: 'nested pass phrase', label: 'Strength' }, [box]);
  page.page.document.querySelector = () => box.stateNode;
  assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.props, ['input=<redacted>', 'label="Strength"']);
});

test('collector: the document is asked for open shadow roots among its first 100,000 elements only (F48)', () => {
  // Every element asked costs the page's thread, on a page of any size.
  const page = arm({ dom: true });
  let asked = 0;
  Object.defineProperty(page.page.Element.prototype, 'shadow', {
    configurable: true,
    get() {
      asked += 1;
      return this.ownShadow;
    },
    set(root) {
      this.ownShadow = root;
    },
  });
  for (let i = 0; i < 150000; i += 1) new page.page.Element('span', {});
  const box = hostFiber(page, 'div', {});
  reactTree(page, 'Meter', { label: 'Strength' }, [box]);
  page.page.document.querySelector = () => box.stateNode;
  asked = 0;
  assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.props, ['label="Strength"']);
  assert.ok(asked >= 100000 && asked <= 100100, `${asked} elements asked for a shadow root`);
});

test('collector: a login form and a checkout form print their ordinary props', () => {
  const forms = [
    {
      name: 'LoginForm',
      props: { title: 'Sign in to Acme', errorMessage: 'Invalid username or password', attempts: 3, redirectTo: '/dashboard', remember: true },
      controls: [
        [{ name: 'username', autocomplete: 'username' }, 'alice'],
        [{ type: 'password', autocomplete: 'current-password' }, ''],
      ],
      expected: [
        'title="Sign in to Acme"',
        'errorMessage="Invalid username or password"',
        'attempts=3',
        'redirectTo="/dashboard"',
        'remember=true',
      ],
    },
    {
      name: 'CheckoutForm',
      props: { total: 129.95, currency: 'EUR', step: 2, shippingMethod: 'express', orderId: 'A-1001' },
      controls: [
        [{ name: 'cardname', autocomplete: 'cc-name' }, 'Ada Lovelace'],
        [{ name: 'cardnumber', autocomplete: 'cc-number' }, ''],
        [{ name: 'exp', autocomplete: 'cc-exp' }, ''],
        [{ name: 'cvc', autocomplete: 'cc-csc' }, ''],
      ],
      expected: ['total=129.95', 'currency="EUR"', 'step=2', 'shippingMethod="express"', 'orderId="A-1001"'],
    },
    {
      // The card number is in a payment provider's frame: the cardholder's
      // name is the only field on the page.
      name: 'HostedCheckout',
      props: { total: 49, currency: 'EUR', plan: 'Pro yearly' },
      controls: [[{ name: 'holder', autocomplete: 'cc-name' }, 'Ada Lovelace']],
      expected: ['total=49', 'currency="EUR"', 'plan="Pro yearly"'],
    },
  ];
  for (const { name, props, controls, expected } of forms) {
    const page = arm({ dom: true });
    const heading = hostFiber(page, 'h2', {});
    const inputs = controls.map(([attributes, value]) => {
      const fiber = hostFiber(page, 'input', attributes, {}, 'HTMLInputElement');
      fiber.stateNode.value = value;
      return fiber;
    });
    reactTree(page, name, props, [heading, ...inputs]);
    page.page.document.querySelector = () => heading.stateNode;
    assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.props, expected, name);
  }
});

test('collector: a component rendering a secret control withholds a prop shaped like a password that no field holds', () => {
  // A confirm field handed the first password after the step that held it
  // unmounted, and a seed for a password field in an open shadow root: no
  // control holds either value, and the prop's name says nothing.
  const passwordInput = (page) => hostFiber(page, 'input', { type: 'password' }, { type: 'password' }, 'HTMLInputElement');
  const shadowPassword = (page) => {
    const host = hostFiber(page, 'shadow-pw', { id: 'rshadow' }, { id: 'rshadow' });
    host.stateNode.shadow = new page.page.DocumentFragment([new page.page.HTMLInputElement('input', { type: 'password' })]);
    return host;
  };
  const cardNumber = (page) => hostFiber(page, 'input', { autocomplete: 'cc-number' }, {}, 'HTMLInputElement');
  const cardName = (page) => hostFiber(page, 'input', { autocomplete: 'cc-name' }, {}, 'HTMLInputElement');
  const cases = [
    {
      name: 'ConfirmField',
      control: passwordInput,
      props: { against: 'CONFIRMPW55', label: 'Confirm' },
      expected: ['against=<redacted>', 'label="Confirm"'],
    },
    {
      name: 'ShadowSeed',
      control: shadowPassword,
      props: { seed: 'SHADOWSEED42', caption: 'Shadow' },
      expected: ['seed=<redacted>', 'caption="Shadow"'],
    },
    {
      name: 'ConfirmField',
      control: passwordInput,
      props: { against: 'first-pass-456' },
      expected: ['against=<redacted>'],
    },
    {
      // 8 and 256 characters are withheld, and beside a card number control
      // a string of digits; 7 and 257, a space, no digit, a number, and the
      // names of the component's own element print.
      name: 'PasswordBox',
      control: cardNumber,
      props: {
        a: 'abcd1234',
        b: 'x'.repeat(255) + '1',
        c: 'abc1234',
        d: 'x'.repeat(256) + '1',
        e: 'Use 12 characters',
        f: 'letters-only',
        g: '12345678',
        h: 12345678,
        className: 'field2col',
        class: 'field2col',
        id: 'password2',
        htmlFor: 'password2',
      },
      expected: [
        'a=<redacted>',
        'b=<redacted>',
        'c="abc1234"',
        'd="' + 'x'.repeat(60) + '…"',
        'e="Use 12 characters"',
        'f="letters-only"',
        'g=<redacted>',
        'h=12345678',
        'className="field2col"',
        'class="field2col"',
        'id="password2"',
        'htmlFor="password2"',
      ],
    },
    // No password, code or card control: the same shapes print.
    {
      name: 'HostedCheckout',
      control: cardName,
      props: { against: 'CONFIRMPW55', ref: 'first-pass-456' },
      expected: ['against="CONFIRMPW55"', 'ref="first-pass-456"'],
    },
    {
      name: 'ProfileCard',
      control: (page) => hostFiber(page, 'input', { type: 'text', name: 'city' }, {}, 'HTMLInputElement'),
      props: { userId: 'u12345678' },
      expected: ['userId="u12345678"'],
    },
    // Medium in the check of the shape rule (L1): a field whose only mark is
    // a secret name (email, address, phone, account) brought the shape rule
    // with it, and the ids of every shipping, newsletter and profile form
    // were withheld. Such a field still has its own value withheld.
    {
      name: 'ShippingForm',
      control: (page) => hostFiber(page, 'input', { type: 'email', name: 'email' }, {}, 'HTMLInputElement'),
      props: { order: 'ORD-2024-00123', cart: 'c9f1e2a4-1b2c-4d5e-8f90-123456789abc', campaign: 'spring2026' },
      expected: ['order="ORD-2024-00123"', 'cart="c9f1e2a4-1b2c-4d5e-8f90-123456789abc"', 'campaign="spring2026"'],
    },
    {
      name: 'ProfileForm',
      control: (page) => hostFiber(page, 'input', { type: 'tel', name: 'phone' }, {}, 'HTMLInputElement'),
      props: { user: 'u12345678', account: 'Personal' },
      expected: ['user="u12345678"', 'account=<redacted>'],
    },
    // Medium in the same check: a code, a card number or a card code handed
    // in under an ordinary name to the component that renders that very
    // control, before the field holds it, printed: it has no letter.
    {
      name: 'OtpConfirm',
      control: (page) => hostFiber(page, 'input', { autocomplete: 'one-time-code' }, {}, 'HTMLInputElement'),
      props: { sent: '48392017', step: '2', amount: '12.00' },
      expected: ['sent=<redacted>', 'step="2"', 'amount="12.00"'],
    },
    {
      name: 'CardReview',
      control: cardNumber,
      props: { prefill: '4242424242424242', grouped: '4242 4242 4242 4242' },
      expected: ['prefill=<redacted>', 'grouped=<redacted>'],
    },
    // Medium in the last check (C1): the digit rule ran before the
    // exemptions, so a date beside a card field was withheld; and a blob:,
    // data: or mailto: URL, a bare ID and a UUID name were not exempt.
    {
      name: 'CheckoutExtras',
      control: cardNumber,
      props: {
        deliveryDate: '2026-11-20',
        isoMonth: '2026-11',
        previewUrl: 'blob:http://127.0.0.1:8891/c9f1e2a4-1b2c-4d5e-8f90-123456789abc',
        contactHref: 'mailto:help24@acme.com',
        ID: 'acct_12345678',
        requestUUID: 'c9f1e2a4-1b2c-4d5e-8f90-123456789abc',
        user_id: 'u12345678',
        ariaDescribedby: 'pw-hint-1',
        zip: '10115',
      },
      expected: [
        'deliveryDate="2026-11-20"',
        'isoMonth="2026-11"',
        'previewUrl="blob:http://127.0.0.1:8891/c9f1e2a4-1b2c-4d5e-8f90-123456789…"',
        'contactHref="mailto:help24@acme.com"',
        'ID="acct_12345678"',
        'requestUUID="c9f1e2a4-1b2c-4d5e-8f90-123456789abc"',
        'user_id="u12345678"',
        'ariaDescribedby="pw-hint-1"',
        'zip=<redacted>',
      ],
    },
    {
      name: 'CvcBox',
      control: (page) => hostFiber(page, 'input', { autocomplete: 'cc-csc' }, {}, 'HTMLInputElement'),
      props: { expected: '737' },
      expected: ['expected=<redacted>'],
    },
    // A password field's form: digits alone are not its secret's shape.
    {
      name: 'PinNote',
      control: passwordInput,
      props: { ticket: '48392017' },
      expected: ['ticket="48392017"'],
    },
    // Low in the same check: names that point at another element, and
    // values shaped like a path, a URL or a date, print beside a password.
    {
      name: 'LoginForm',
      control: passwordInput,
      props: {
        describedBy: 'pw-hint-1',
        inputId: 'password1',
        testId: 'login-form-2',
        'aria-describedby': 'pw-hint-1',
        'data-qa': 'login2',
        apiBase: 'https://api.acme.com/v2',
        redirectTo: '/account/orders/12345',
        lastLogin: '2026-11-16T09:12:00Z',
        couponCode: 'WELCOME10',
      },
      expected: [
        'describedBy="pw-hint-1"',
        'inputId="password1"',
        'testId="login-form-2"',
        'aria-describedby="pw-hint-1"',
        'data-qa="login2"',
        'apiBase="https://api.acme.com/v2"',
        'redirectTo="/account/orders/12345"',
        'lastLogin="2026-11-16T09:12:00Z"',
        'couponCode=<redacted>',
      ],
    },
  ];
  for (const { name, control, props, expected } of cases) {
    const page = arm({ dom: true });
    const heading = hostFiber(page, 'h2', {});
    reactTree(page, name, props, [heading, control(page)]);
    page.page.document.querySelector = () => heading.stateNode;
    assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.props, expected, name);
  }
  // The same in Vue.
  {
    const page = arm({ dom: true });
    const label = new page.page.Element('label', {});
    const input = new page.page.HTMLInputElement('input', { type: 'password' });
    const instance = {
      type: { name: 'ConfirmField' },
      props: { against: 'CONFIRMPW55', label: 'Confirm' },
      parent: null,
      subTree: {
        type: 'div',
        el: null,
        props: {},
        children: [
          { type: 'label', el: label, props: {}, children: 'Confirm' },
          { type: 'input', el: input, props: { type: 'password' }, children: null },
        ],
      },
    };
    label.__vnode = { ctx: instance, props: {} };
    page.page.document.querySelector = () => label;
    assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.props, [
      'against=<redacted>',
      'label="Confirm"',
    ]);
  }
});

test('collector: a Vue component seeding a password field it lets the user edit withholds the seed', () => {
  const page = arm({ dom: true });
  const label = new page.page.Element('label', {});
  const input = new page.page.HTMLInputElement('input', { type: 'password' });
  // Typed on the end of the seed.
  input.value = 'init-secret-more';
  const instance = {
    type: { name: 'LoginBox' },
    props: { initial: 'init-secret', remember: true },
    parent: null,
    subTree: {
      type: 'div',
      el: null,
      props: {},
      children: [
        { type: 'label', el: label, props: {}, children: 'Password' },
        { type: 'input', el: input, props: { type: 'password' }, children: null },
      ],
    },
  };
  label.__vnode = { ctx: instance, props: {} };
  page.page.document.querySelector = () => label;
  assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.props, [
    'initial=<redacted>',
    'remember=true',
  ]);
});

test('collector: a password field that is an element of a design system\'s own is seen by its type', () => {
  // <x-pw type="password" value={text}>, as React hands it its props.
  {
    const page = arm({ dom: true });
    const box = hostFiber(page, 'x-pw', { type: 'password' }, { type: 'password', value: 'webcomp-secret' });
    const heading = hostFiber(page, 'h3', {});
    reactTree(page, 'PwBox', { text: 'webcomp-secret', hint: 'Use 12 characters' }, [heading, box]);
    page.page.document.querySelector = () => heading.stateNode;
    assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.props, [
      'text=<redacted>',
      'hint="Use 12 characters"',
    ]);
  }
});

test('collector: a password field inside an element\'s open shadow root is seen', () => {
  // <sl-input> with no type of its own, whose open shadow root holds the
  // password input.
  {
    const page = arm({ dom: true });
    const field = hostFiber(page, 'sl-input', {}, {});
    const inner = new page.page.HTMLInputElement('input', { type: 'password' });
    inner.value = 'shadow-secret';
    field.stateNode.shadow = new page.page.DocumentFragment([inner]);
    reactTree(page, 'LoginBox', { given: 'shadow-secret', title: 'Sign in' }, [field]);
    page.page.document.querySelector = () => field.stateNode;
    assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.props, [
      'given=<redacted>',
      'title="Sign in"',
    ]);
  }
  // Neither: an element of its own with a text field in its shadow root.
  {
    const page = arm({ dom: true });
    const field = hostFiber(page, 'sl-input', { type: 'text' }, { type: 'text' });
    field.stateNode.shadow = new page.page.DocumentFragment([new page.page.HTMLInputElement('input', { type: 'text' })]);
    reactTree(page, 'CityBox', { city: 'Berlin' }, [field]);
    page.page.document.querySelector = () => field.stateNode;
    assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.props, ['city="Berlin"']);
  }
});

test('collector: the Vue guard walks into a <Suspense>, to the password field it shows', () => {
  const page = arm({ dom: true });
  const marker = new page.page.Element('b', { id: 'g' });
  const input = new page.page.HTMLInputElement('input', { type: 'password' });
  input.value = 'suspense-secret';
  const secretBox = {
    type: { name: 'SecretBox' },
    props: { given: 'suspense-secret' },
    subTree: { type: 'input', el: input, props: { type: 'password' }, children: null },
  };
  const content = { type: { name: 'SecretBox' }, component: secretBox, props: { given: 'suspense-secret' } };
  // A Suspense vnode keeps what it shows on its boundary, not as children.
  const suspense = { type: { name: 'Suspense', __isSuspense: true }, children: { default: () => [] }, ssContent: content, ssFallback: null, suspense: { activeBranch: content, pendingBranch: null } };
  const instance = {
    type: { name: 'Gate' },
    props: { given: 'suspense-secret' },
    parent: null,
    subTree: { type: 'div', el: null, props: {}, children: [{ type: 'b', el: marker, props: { id: 'g' }, children: null }, suspense] },
  };
  marker.__vnode = { ctx: instance, props: { id: 'g' } };
  page.page.document.querySelector = () => marker;
  assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.props, ['given=<redacted>']);
});

test('collector: a hidden input elsewhere in a component hides none of its props, and picked hides only its own value', () => {
  // A product card's form carries the product in hidden inputs.
  {
    const page = arm({ dom: true });
    const title = hostFiber(page, 'h3', {});
    const hidden = [
      ['product_id', '42'],
      ['quantity', '1'],
      ['variant', 'blue'],
    ].map(([name, value]) => {
      const fiber = hostFiber(page, 'input', { type: 'hidden', name }, { type: 'hidden', name, value }, 'HTMLInputElement');
      fiber.stateNode.value = value;
      return fiber;
    });
    reactTree(page, 'ProductCard', { productId: 42, quantity: 1, variant: 'blue' }, [title, ...hidden]);
    page.page.document.querySelector = () => title.stateNode;
    assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.props, [
      'productId=42',
      'quantity=1',
      'variant="blue"',
    ]);
  }
  // A search box whose form carries a CSRF token, a secret name and all.
  {
    const page = arm({ dom: true });
    const search = hostFiber(page, 'input', { type: 'search', name: 'q' }, { type: 'search', name: 'q', value: 'red shoes' }, 'HTMLInputElement');
    search.stateNode.value = 'red shoes';
    const token = hostFiber(page, 'input', { type: 'hidden', name: 'authenticity_token' }, { type: 'hidden', name: 'authenticity_token', value: 'tok-123' }, 'HTMLInputElement');
    token.stateNode.value = 'tok-123';
    reactTree(page, 'SearchBox', { value: 'red shoes', token: 'tok-123' }, [search, token]);
    page.page.document.querySelector = () => search.stateNode;
    // The token prop by its own name.
    assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.props, [
      'value="red shoes"',
      'token=<redacted>',
    ]);
  }
  // The hidden input picked itself: its own value, and nothing else.
  {
    const page = arm({ dom: true });
    const token = hostFiber(page, 'input', { type: 'hidden', name: 'ref' }, { type: 'hidden', name: 'ref', value: 'abc-987' }, 'HTMLInputElement');
    token.stateNode.value = 'abc-987';
    reactTree(page, 'Tracking', { code: 'abc-987', value: 'shown', step: 2 }, [token]);
    page.page.document.querySelector = () => token.stateNode;
    assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.props, [
      'code=<redacted>',
      'value="shown"',
      'step=2',
    ]);
  }
});

test('collector: a hidden input with a secret name keeps its value withheld under any prop name', () => {
  // A pay button's form carries a CSRF token, handed in as formKey.
  {
    const page = arm({ dom: true });
    const token = hostFiber(page, 'input', { type: 'hidden', name: 'csrf_token' }, { type: 'hidden', name: 'csrf_token', value: 'csrf-abc-999' }, 'HTMLInputElement');
    token.stateNode.value = 'csrf-abc-999';
    const button = hostFiber(page, 'button', { type: 'submit' });
    reactTree(page, 'PayButton', { amount: '12.00', formKey: 'csrf-abc-999', value: 'Pay' }, [token, button]);
    page.page.document.querySelector = () => button.stateNode;
    // Its value prop is the component's own, and prints.
    assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.props, [
      'amount="12.00"',
      'formKey=<redacted>',
      'value="Pay"',
    ]);
  }
  // The same token in the page's own form, not rendered by the component.
  {
    const page = arm({ dom: true });
    new page.page.HTMLInputElement('input', { type: 'hidden', id: 'authenticity_token' }).value = 'tok-777-xyz';
    const button = hostFiber(page, 'button', {});
    reactTree(page, 'SaveButton', { form: 'tok-777-xyz', label: 'Save' }, [button]);
    page.page.document.querySelector = () => button.stateNode;
    assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.props, ['form=<redacted>', 'label="Save"']);
  }
});

// ------------------------------------------ builtins the page replaced --

test('collector: a failed request, a full ring and a CSP violation call nothing the page replaced', async () => {
  // The page's own fetch, timer and addEventListener, made in its realm, so
  // that a .call looked up on them would reach its Function.prototype.
  const page = arm({
    before: `
      fetch = () => Promise.resolve({ status: 500, statusText: 'Server Error' });
      const outerTimeout = setTimeout;
      setTimeout = function setTimeout(fn, ms) { return outerTimeout(fn, ms); };
      const outerAdd = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function addEventListener(type, fn) {
        return outerAdd.apply(this, [type, fn]);
      };
    `,
  });
  page.realm(`
    globalThis.calls = {};
    const spy = (holder, key) => {
      const original = holder[key];
      holder[key] = function (...args) {
        calls[key] = (calls[key] || 0) + 1;
        return Reflect.apply(original, this, args);
      };
    };
    spy(Array.prototype, 'push');
    spy(Array.prototype, 'splice');
    spy(Array.prototype, 'slice');
    spy(String.prototype, 'split');
    spy(String.prototype, 'match');
    spy(String.prototype, 'slice');
    spy(String.prototype, 'startsWith');
    spy(String.prototype, 'replace');
    spy(RegExp.prototype, 'test');
    spy(RegExp.prototype, 'exec');
    spy(Math, 'round');
    spy(Function.prototype, 'call');
    spy(Promise.prototype, 'then');
    Error.prepareStackTrace = (error, frames) => {
      calls.prepareStackTrace = (calls.prepareStackTrace || 0) + 1;
      return 'Error\\n' + frames.map((frame) => '    at ' + frame).join('\\n');
    };
    globalThis.pagePrepare = Error.prepareStackTrace;
  `);
  // Awaited by waiting, not with await: awaiting the realm's promise would
  // call its then from here.
  const settled = () => new Promise((resolve) => setTimeout(resolve, 5));
  // In a file of the page's, which is what a caller frame has to name.
  const script = (code) => vm.runInContext(code, page.page, { filename: 'http://localhost/assets/cart.js' });
  script(`
    function loadCart() { return fetch('/api/cart'); }
    loadCart();
  `);
  const xhr = script(`
    function saveCart() { const xhr = new XMLHttpRequest(); xhr.open('POST', '/api/cart'); xhr.send(); return xhr; }
    saveCart();
  `);
  await settled();
  xhr.finish(500, 'Internal Server Error', ['readystatechange', 'load']);
  // A constructor of the page's own in place of Error, with no
  // prepareStackTrace on it. Chrome formats a stack with the one on the
  // Error V8 started with; Node asks window.Error, so it is left bare here.
  script(`
    const NativeError = Error;
    globalThis.Error = function Error(message) {
      calls.Error = (calls.Error || 0) + 1;
      return new NativeError(message);
    };
    function loadRates() { return fetch('/api/rates'); }
    loadRates();
  `);
  await settled();
  for (let i = 0; i < 35; i += 1) page.page.console.error('flood', i);
  page.dispatch('securitypolicyviolation', {
    disposition: 'enforce',
    effectiveDirective: 'connect-src',
    blockedURI: 'http://tracker.test/' + 'x'.repeat(10),
  });
  for (let i = 0; i < 35; i += 1) {
    page.dispatch('securitypolicyviolation', {
      disposition: 'enforce',
      effectiveDirective: 'connect-src',
      blockedURI: 'http://tracker.test/' + i,
    });
  }
  await settled();
  const calls = plain(page.realm('calls'));
  // Read before the snapshot, which goes through the bridge's channel.
  assert.deepEqual(calls, {});
  const { network, console: logged } = page.snapshot();
  assert.deepEqual(
    network.map((entry) => [entry.url, entry.status, entry.caller[0].replace(/ \(.*/, '')]),
    [
      ['/api/cart', 500, 'loadCart'],
      ['/api/cart', 500, 'saveCart'],
      ['/api/rates', 500, 'loadRates'],
    ]
  );
  assert.equal(logged.length, 30);
  // The page's prepareStackTrace is back where it was.
  assert.equal(page.realm('NativeError.prepareStackTrace === pagePrepare'), true);
});

// ------------------------------------------------------------ a late start --
// The worker injects the collector into a tab that was open before the
// extension could start there, after the page's own scripts have run. By
// then a framework may have replaced what the collector takes at the top.

// What zone.js (Angular) and Bluebird leave behind, written in the page's
// realm before the collector runs: window.Promise is a class whose then only
// works on its own promises, the engine's Promise.prototype.then is replaced
// with a counting copy, and the natives zone.js replaces are kept under its
// __zone_symbol__ names. Real zone.js and Bluebird pages are checked in
// Chrome; see the fix notes.
const LATE_PAGE = `
  globalThis.calls = {};
  const count = (name) => { calls[name] = (calls[name] || 0) + 1; };
  const EnginePromise = Promise;
  const engineThen = EnginePromise.prototype.then;
  // The page's fetch, before anything replaced it, as Chrome's would answer.
  fetch = function fetch(url) {
    return EnginePromise.resolve({ status: url === '/api/fail' ? 500 : 200, statusText: '' });
  };
  // Bluebird's then and ZoneAwarePromise's both read their own state off this.
  class LibraryPromise {
    constructor(executor) {
      this._state = [];
      executor((value) => { this._value = value; }, () => {});
    }
    then(onFulfilled) {
      this._state.push(onFulfilled);
      return this;
    }
  }
  globalThis.LibraryPromise = LibraryPromise;
  Promise = LibraryPromise;
  EnginePromise.prototype.then = function then(onFulfilled, onRejected) {
    count('then');
    return Reflect.apply(engineThen, this, [onFulfilled, onRejected]);
  };
  for (const [holder, key] of [[globalThis, 'setTimeout'], [EventTarget.prototype, 'addEventListener']]) {
    const native = holder[key];
    holder['__zone_symbol__' + key] = native;
    holder[key] = function (...args) {
      count(key);
      return Reflect.apply(native, this, args);
    };
  }
`;

test('collector: started after the page replaced Promise and its then, every fetch still works and is recorded', async () => {
  const page = arm({ before: LATE_PAGE });
  // Awaited inside the realm: an await from here would call the page's then.
  page.realm(`
    globalThis.results = [];
    globalThis.done = (async () => {
      for (const url of ['/api/ok', '/api/fail']) {
        try {
          const response = await fetch(url);
          results.push(url + ' ' + response.status);
        } catch (error) {
          results.push(url + ' threw ' + error);
        }
      }
    })();
  `);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(plain(page.realm('results')), ['/api/ok 200', '/api/fail 500']);
  // Not one call of the page's then on the way.
  assert.deepEqual(plain(page.realm('calls')), {});
  const network = page.snapshot().network;
  assert.deepEqual(
    network.map(({ url, status }) => [url, status]),
    [['/api/fail', 500]]
  );
});

test('collector: a fetch the page replaced before it started is chained with the page\'s own then', async () => {
  const page = arm({
    before: `
      ${LATE_PAGE}
      // zone.js's own fetch hands back a promise of its own kind.
      const engineFetch = fetch;
      fetch = function fetch(url) {
        const own = new LibraryPromise(() => {});
        engineFetch(url).then((response) => {
          own._value = response;
          for (const callback of own._state) callback(response);
        });
        return own;
      };
    `,
  });
  page.realm(`
    globalThis.chained = fetch('/api/fail');
    globalThis.status = null;
    chained.then((response) => { status = response.status; });
  `);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(page.realm('chained instanceof LibraryPromise'), true);
  assert.equal(page.realm('status'), 500);
  assert.deepEqual(
    page.snapshot().network.map(({ url, status }) => [url, status]),
    [['/api/fail', 500]]
  );
});

test('collector: started after zone.js, its timer and listeners are the natives zone.js kept, not its copies', async () => {
  const page = arm({ before: LATE_PAGE });
  // A failed request, and one reopened from its own readystatechange, which
  // is the path that sets a timer.
  const xhr = new page.page.XMLHttpRequest();
  xhr.open('GET', '/api/cart');
  xhr.send();
  xhr.finish(404, 'Not Found', ['readystatechange', 'load']);
  const again = new page.page.XMLHttpRequest();
  again.__zone_symbol__addEventListener('readystatechange', () => {
    if (again.readyState === 4) again.open('GET', '/api/next');
  });
  again.open('POST', '/api/save');
  again.send();
  again.finish(500, 'Internal Server Error', ['readystatechange'], { loadend: false });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(plain(page.realm('calls')), {});
  assert.deepEqual(
    page.snapshot().network.map(({ url, status }) => [url, status]),
    [
      ['/api/cart', 404],
      ['/api/save', 500],
    ]
  );
});

// What zone.js's error plugin (zone-error 0.15) leaves behind: window.Error
// is its ZoneAwareError, which reads the stack of every error it makes at
// once and writes the zone's name after every frame, and the native is kept
// under its __zone_symbol__ name. Checked against the real plugin in Chrome
// for Testing 156, where the collector of 0.6.0 recorded no caller at all.
test("collector: started after zone.js's error plugin, it makes its stacks with the Error zone.js kept, and names the caller", async () => {
  const page = arm({
    before: `
      globalThis.calls = {};
      fetch = () => Promise.resolve({ status: 500, statusText: 'Server Error' });
      const NativeError = Error;
      globalThis.__zone_symbol__Error = NativeError;
      function ZoneAwareError() {
        calls.Error = (calls.Error || 0) + 1;
        const error = NativeError.apply(this, arguments);
        const frames = String(error.stack).split('\\n');
        error.stack = frames.map((line, i) => (i ? line + ' [<root>]' : line)).join('\\n');
        return error;
      }
      ZoneAwareError.prototype = NativeError.prototype;
      Object.defineProperty(ZoneAwareError, 'stackTraceLimit', {
        get: () => NativeError.stackTraceLimit,
        set: (value) => { NativeError.stackTraceLimit = value; },
      });
      Error = ZoneAwareError;
    `,
  });
  const script = (code) => vm.runInContext(code, page.page, { filename: 'http://localhost/assets/cart.js' });
  script(`
    function loadCart() { return fetch('/api/cart'); }
    loadCart();
  `);
  const xhr = script(`
    function saveCart() { const xhr = new XMLHttpRequest(); xhr.open('POST', '/api/cart'); xhr.send(); return xhr; }
    saveCart();
  `);
  xhr.finish(500, 'Internal Server Error', ['readystatechange', 'load']);
  await new Promise((resolve) => setTimeout(resolve, 5));
  // Not one error made through the page's constructor.
  assert.deepEqual(plain(page.realm('calls')), {});
  assert.deepEqual(
    page.snapshot().network.map(({ url, caller }) => [url, (caller || [])[0]]),
    [
      ['/api/cart', 'saveCart (http://localhost/assets/cart.js:2:65)'],
      ['/api/cart', 'loadCart (http://localhost/assets/cart.js:2:34)'],
    ]
  );
});

test('collector: a fetch refused for its own arguments is recorded as not sent, not as a network failure', async () => {
  // Chrome's own words for a GET with a body, rejected before anything is sent.
  const page = arm({
    before: `
      fetch = function fetch(url) {
        return Promise.reject(
          url === '/api/down'
            ? new TypeError('Failed to fetch')
            : new TypeError("Failed to execute 'fetch' on 'Window': Request with GET/HEAD method cannot have body.")
        );
      };
    `,
  });
  page.realm(`
    globalThis.reasons = [];
    for (const url of ['/api/ok.json', '/api/down']) {
      (async () => {
        try { await fetch(url, { method: 'GET', body: 'x' }); } catch (error) { reasons.push(error.message); }
      })();
    }
  `);
  await new Promise((resolve) => setTimeout(resolve, 5));
  // The page still gets its own rejection.
  assert.equal(page.realm('reasons.length'), 2);
  assert.deepEqual(
    page.snapshot().network.map(({ url, status, statusText, notSent }) => [url, status, statusText, notSent ?? null]),
    [
      [
        '/api/ok.json',
        0,
        "Not sent: Failed to execute 'fetch' on 'Window': Request with GET/HEAD method cannot have body.",
        true,
      ],
      ['/api/down', 0, 'Network failure: Failed to fetch', null],
    ]
  );
});

test('collector: started after the page left something else where a native was, it wraps the rest and throws nothing into the page', () => {
  const cases = [
    // xhook: XMLHttpRequest is a constructor whose prototype has no open,
    // send or abort.
    'XMLHttpRequest = function XHook() {};',
    // A console method that is not a function any more.
    "console.warn = 'not a function';",
    // A fetch the page made read only.
    "Object.defineProperty(globalThis, 'fetch', { value: () => Promise.resolve({ status: 500 }), writable: false, configurable: true });",
  ];
  for (const before of cases) {
    const page = arm({ before });
    page.page.console.error('still recorded');
    // The guard answers a second copy, which wraps nothing again.
    page.run();
    page.page.console.error('once');
    assert.deepEqual(
      page.snapshot().console.map((entry) => entry.text),
      ['still recorded', 'once'],
      before
    );
  }
});

// Found while merging the last fix round: the listener for the picker's
// question was the one addEventListener call left without a guard, so a page
// whose own addEventListener throws saw the collector throw into it on a
// late start. Its log cannot be read then (every channel listener fails the
// same way), but the page runs as it did.
test('collector: started late on a page whose addEventListener throws, it throws nothing into the page', () => {
  let page;
  assert.doesNotThrow(() => {
    page = arm({ before: "addEventListener = function () { throw new Error('the page refuses'); };" });
  });
  assert.doesNotThrow(() => page.page.console.error('the page logs as before'));
});

test("collector: a promise the page's own fetch decorated is handed back as it is, and watched on the side", async () => {
  // An app's own wrapper, there before the collector started: every fetch
  // can be cancelled from the promise it returns.
  const page = arm({
    before: `
      const engineFetch = (url) =>
        url === '/api/down'
          ? Promise.reject(new TypeError('Failed to fetch'))
          : Promise.resolve({ status: url === '/api/fail' ? 500 : 200, statusText: '' });
      globalThis.made = [];
      fetch = function fetch(url) {
        const promise = engineFetch(url);
        promise.abort = () => 'aborted';
        promise.requestId = made.length + 1;
        made.push(promise);
        return promise;
      };
    `,
  });
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    page.realm(`
      globalThis.seen = [];
      for (const url of ['/api/fail', '/api/down']) {
        const promise = fetch(url);
        seen.push([promise === made[made.length - 1], typeof promise.abort, promise.requestId]);
        // The page handles its own rejection.
        promise.then(() => {}, () => {});
      }
    `);
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(plain(page.realm('seen')), [
    [true, 'function', 1],
    [true, 'function', 2],
  ]);
  // A rejection the page handled is reported nowhere.
  assert.equal(unhandled.length, 0);
  assert.deepEqual(
    page.snapshot().network.map(({ url, status, statusText }) => [url, status, statusText]),
    [
      ['/api/fail', 500, ''],
      ['/api/down', 0, 'Network failure: Failed to fetch'],
    ]
  );
});

test("collector: started at document_start, a fetch calls no then the page put on the engine's promises later (core-js)", async () => {
  const page = arm({
    loading: true,
    before: "fetch = () => Promise.resolve({ status: 500, statusText: 'Server Error' });",
  });
  page.realm(`
    globalThis.thenCalls = 0;
    const engineThen = Promise.prototype.then;
    // core-js forcing its own Promise: the engine's then replaced, and the
    // prototype's constructor deleted, which an await reads.
    Promise.prototype.then = function then(...args) {
      thenCalls += 1;
      return Reflect.apply(engineThen, this, args);
    };
    delete Promise.prototype.constructor;
    globalThis.bare = fetch('/api/fail');
  `);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(page.realm('thenCalls'), 0);
  // Still a promise of the engine's own.
  assert.equal(page.realm('Object.getPrototypeOf(bare) === Promise.prototype'), true);
  assert.deepEqual(
    page.snapshot().network.map(({ url, status }) => [url, status]),
    [['/api/fail', 500]]
  );
});

test('collector: accessors the page plants on Object.prototype and Array.prototype never reach an entry the bridge reads', async () => {
  const page = arm({
    before: `
      fetch = (url, init) => {
        if (url === '/api/down') return Promise.reject(new TypeError('Failed to fetch'));
        if (url === '/api/stop') return Promise.reject(Object.assign(new Error('stopped'), { name: 'AbortError' }));
        if (url === '/api/refused') {
          return Promise.reject(new TypeError("Failed to execute 'fetch' on 'Window': Request with GET/HEAD method cannot have body."));
        }
        return Promise.resolve({ status: 500, statusText: 'Server Error' });
      };
    `,
  });
  // A setter for each field the collector adds to an entry, which leaves a
  // getter of the page's on it, and a getter for a field read off one that
  // lacks it, both on Object.prototype; index setters on Array.prototype.
  // What ran is kept in a string: a list would go through those setters.
  page.realm(`
    globalThis.ran = '';
    const plant = (holder, key) =>
      Object.defineProperty(holder, key, {
        configurable: true,
        set(value) {
          ran += 'set ' + key + ';';
          Object.defineProperty(this, key, {
            configurable: true,
            enumerable: true,
            get() {
              ran += 'get ' + key + ';';
              return value;
            },
          });
        },
        get() {
          ran += 'read ' + key + ';';
          return undefined;
        },
      });
    for (const key of ['t', 'seq', 'caller', 'outcome', 'notSent', 'blocked', 'level', 'kind', 'text']) plant(Object.prototype, key);
    for (let i = 0; i < 40; i += 1) plant(Array.prototype, String(i));
  `);
  const script = (code) => vm.runInContext(code, page.page, { filename: 'http://localhost/assets/app.js' });
  script(`
    function load(url) { return fetch(url); }
    for (const url of ['/api/fail', '/api/down', '/api/stop', '/api/refused']) load(url).catch(() => {});
  `);
  const xhr = script(`
    function save() { const xhr = new XMLHttpRequest(); xhr.open('POST', '/api/save'); xhr.send(); return xhr; }
    save();
  `);
  xhr.finish(0, '', ['readystatechange', 'error']);
  await new Promise((resolve) => setTimeout(resolve, 10));
  // A full ring, and a request blocked by the page's policy.
  for (let i = 0; i < 35; i += 1) page.page.console.error('flood', i);
  page.dispatch('securitypolicyviolation', { disposition: 'enforce', effectiveDirective: 'connect-src', blockedURI: '/api/save' });
  // Nothing of the page's ran with an entry, nor runs while the reply is read.
  const planted = /^(?:set|read|get) (?:t|seq|caller|outcome|notSent|blocked|level|kind|text)$/;
  assert.deepEqual(page.realm('ran').split(';').filter((line) => planted.test(line)), []);
  const before = page.realm('ran');
  const snap = page.snapshot();
  assert.equal(page.realm('ran'), before);
  assert.equal(snap.console.length, 30);
  assert.ok(snap.console.every((entry) => typeof entry.t === 'number' && typeof entry.seq === 'number'));
  assert.deepEqual(
    snap.network.map(({ url, status, outcome, notSent, blocked, caller }) => [url, status, outcome ?? '', notSent ?? false, blocked ?? false, caller[0].replace(/ \(.*/, '')]),
    [
      // The XHR fails at once, the fetches a microtask later.
      ['/api/save', 0, '', false, true, 'save'],
      ['/api/fail', 500, '', false, false, 'load'],
      ['/api/down', 0, '', false, false, 'load'],
      ['/api/stop', 0, 'aborted', false, false, 'load'],
      ['/api/refused', 0, '', true, false, 'load'],
    ]
  );
  // Every field of the reply, at every depth, is its own data property.
  const channel = `__cdr_${'0123456789abcdef'.repeat(2)}`;
  let raw;
  page.page.addEventListener(`${channel}:reply`, (event) => {
    raw = event.detail;
  });
  page.page.dispatchEvent(new page.page.CustomEvent(channel, { detail: 'snapshot' }));
  const accessors = [];
  const walk = (value, path) => {
    if (value === null || typeof value !== 'object') return;
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!('value' in descriptor)) accessors.push(path + '.' + String(key));
      else walk(descriptor.value, path + '.' + String(key));
    }
  };
  walk(raw, 'reply');
  assert.deepEqual(accessors, []);
});

// ------------------------------------------------ the collector's address --

test('collector: its frames carry an address of its own scheme, not the extension\'s, so the console takes the page\'s path', () => {
  // Chrome reports a console message whose topmost frame is a chrome-extension
  // URL in detail, capturing and formatting the whole stack again: measured,
  // 148 microseconds a console.error, and 0.9 ms from 30 frames deep, against
  // 3 without the extension. V8 gives a script the address of its sourceURL.
  const lines = SOURCE.trimEnd().split('\n');
  const declared = lines.filter((line) => line.startsWith('//# sourceURL='));
  assert.equal(declared.length, 1, 'no sourceURL, or more than one');
  const address = new URL(declared[0].slice('//# sourceURL='.length));
  assert.equal(address.protocol, 'punch-list:');
  // A file name in the path, which is what DevTools names a script by. With
  // an empty path it named the collector "(index)", as it names the page's
  // own document, and every page console.error linked there when the source
  // map below was not applied.
  assert.equal(address.pathname.split('/').at(-1), 'collector-main.js');
  // Ahead of the source map, which test/static.test.mjs wants on the last line.
  assert.match(lines.at(-1), /^\/\/# sourceMappingURL=/);
  // In a stack the page can read, as V8 writes it.
  const page = arm();
  const stack = page.realm(`
    let stack = '';
    try { new XMLHttpRequest().open('GET'); } catch (error) { stack = error.stack; }
    stack;
  `);
  assert.match(stack, /\(punch-list:\/\/extension\/collector-main\.js:\d+:\d+\)/);
  // And its own frames are still known for its own when a caller is read,
  // by the whole address: a page file of the same name is still the page's.
  const xhr = page.realm(`
    function saveCart() { const xhr = new XMLHttpRequest(); xhr.open('POST', '/api/cart'); xhr.send(); return xhr; }
    saveCart();
  `);
  xhr.finish(500, 'Internal Server Error', ['readystatechange', 'load']);
  const [entry] = page.snapshot().network;
  assert.ok(!(entry.caller || []).some((frame) => frame.includes('punch-list:')), JSON.stringify(entry.caller));
  vm.runInContext(
    `function sendFromSameName() { const xhr = new XMLHttpRequest(); xhr.open('POST', '/api/same'); xhr.send(); return xhr; }
    globalThis.sameName = sendFromSameName();`,
    page.page,
    { filename: 'http://localhost/assets/collector-main.js' }
  );
  page.realm('sameName').finish(500, 'Internal Server Error', ['readystatechange', 'load']);
  const same = page.snapshot().network.find((one) => one.url === '/api/same');
  assert.equal(same.caller[0], 'sendFromSameName (http://localhost/assets/collector-main.js:1:69)');
});

// ------------------------------------------------------ the name on hover --
// While Element is armed, the picker's tag names the component behind the
// highlighted element, asked with an event sent on the node and answered on
// the window (the name request at the end of collector-main.js), through
// componentOf(node, true). Each test below holds that answer to the brief
// contract in componentOf's comment, or to the name a pick reports.

/** A plain node, as the bare realm's elements are, with a fiber or Vue's expandos on it. */
const nodeWith = (expandos = {}, parentElement = null) => ({ removeAttribute() {}, parentElement, ...expandos });

/** A React development tree: a host fiber under the named component fibers given, nearest first. */
function devFibers(...types) {
  let parent = null;
  for (const type of [...types].reverse()) {
    parent = { tag: 0, type, memoizedProps: {}, return: parent, _debugOwner: null };
  }
  return { tag: 5, type: 'button', memoizedProps: {}, return: parent, _debugOwner: parent };
}

// The shapes a Svelte development build leaves, as svelte@5.58.0 writes them
// (src/internal/client/dev/elements.js and context.js), svelte@5.57.0 (no
// component on the meta) and svelte@4.2.20 (add_location, with char and a
// line counted from 0). The compiler names the FILENAME symbol
// Symbol('filename') and keeps it to itself.
const FILENAME = Symbol('filename');

/** A component's function as the compiler leaves it, with the file it was compiled from. */
function svelteFunction(name, file) {
  const fn = { [name]: function () {} }[name];
  fn[FILENAME] = file;
  return fn;
}

/** A component's context as Svelte 5.58 pushes it: its props (s), its function, and the context it was made in (p). */
function svelteContext(fn, props, parent = null) {
  return { p: parent, i: true, c: null, e: null, s: props, x: null, r: null, l: null, function: fn };
}

/** What Svelte 5 puts on an element: where it is written, the stack it was rendered in, and from 5.58 the component's context. */
function svelteMeta(file, line, column, { parent = null, component } = {}) {
  const meta = { parent, loc: { file, line, column } };
  if (component !== undefined) meta.component = component;
  return meta;
}

test('collector: a name asked for while hovering is the name a pick reports, and says when the bundler made it up', () => {
  const page = arm();
  const named = (name, extra = {}) => Object.assign({ [name]: function () {} }[name], extra);
  const forwardRef = { $$typeof: Symbol.for('react.forward_ref'), render: function SaveButton() {} };
  const Row = function Row() {};
  const memo = { $$typeof: Symbol.for('react.memo'), type: Row };
  const provider = named('TooltipProviderProvider', { displayName: 'TooltipProviderProvider' });
  // Production: no _debug* key on any fiber.
  const production = (...types) => {
    let parent = null;
    for (const type of [...types].reverse()) parent = { tag: 0, type, memoizedProps: {}, return: parent };
    return { tag: 5, type: 'div', memoizedProps: {}, return: parent };
  };
  const cases = {
    'a development component': nodeWith({ __reactFiber$t: devFibers(named('Total'), named('CartSummary')) }),
    'a Provider folded into its component': nodeWith({ __reactFiber$t: devFibers(provider, named('TooltipProvider'), named('App')) }),
    'forwardRef': nodeWith({ __reactFiber$t: devFibers(forwardRef, named('Toolbar')) }),
    'memo over its function': nodeWith({ __reactFiber$t: devFibers(memo, Row, named('List')) }),
    'a bundler\'s name': nodeWith({ __reactFiber$t: production(named('A'), named('tN'), named('App')) }),
    'a production Provider folded': nodeWith({ __reactFiber$t: production(provider, named('TooltipProvider')) }),
    // A node from dangerouslySetInnerHTML: no fiber of its own, one up.
    'found by climbing': nodeWith({}, nodeWith({ __reactFiber$t: devFibers(named('Markdown')) })),
    'Vue 3': nodeWith({ __vnode: { ctx: { type: { name: 'CartSummary' }, props: {}, parent: null } } }),
    'Vue 3 slot content, named for whoever wrote it': nodeWith({
      __vnode: { ctx: { type: { __name: 'CheckoutPage' }, props: {}, parent: null } },
      __vueParentComponent: { type: { name: 'Card' }, props: {}, parent: null },
    }),
    'Vue 3 named by its file': nodeWith({ __vnode: { ctx: { type: { __file: '/src/components/PriceTag.vue' }, props: {}, parent: null } } }),
    'Svelte 5.58, inside another component': nodeWith({
      __svelte_meta: svelteMeta('src/lib/CouponField.svelte', 5, 2, {
        parent: { type: 'component', file: 'src/lib/CheckoutForm.svelte', line: 6, column: 2, parent: null },
        component: svelteContext(svelteFunction('CouponField', 'src/lib/CouponField.svelte'), { value: 'SUMMER25' }),
      }),
    }),
    'Svelte 4, found by climbing': nodeWith({}, nodeWith({ __svelte_meta: { loc: { file: 'src/routes/+page.svelte', line: 2, column: 0, char: 40 } } })),
    'a Svelte snippet, named for the file that writes it': nodeWith({
      __svelte_meta: svelteMeta('src/lib/CheckoutForm.svelte', 9, 4, {
        component: svelteContext(svelteFunction('CouponField', 'src/lib/CouponField.svelte'), {}),
      }),
    }),
  };
  const expected = {
    'a development component': { name: 'Total', renamed: false },
    'a Provider folded into its component': { name: 'TooltipProvider', renamed: false },
    'forwardRef': { name: 'SaveButton', renamed: false },
    'memo over its function': { name: 'Row', renamed: false },
    'a bundler\'s name': { name: 'A', renamed: true },
    'a production Provider folded': { name: 'TooltipProvider', renamed: false },
    'found by climbing': { name: 'Markdown', renamed: false },
    'Vue 3': { name: 'CartSummary', renamed: false },
    'Vue 3 slot content, named for whoever wrote it': { name: 'CheckoutPage', renamed: false },
    'Vue 3 named by its file': { name: 'PriceTag', renamed: false },
    'Svelte 5.58, inside another component': { name: 'CouponField', renamed: false },
    'Svelte 4, found by climbing': { name: '+page', renamed: false },
    'a Svelte snippet, named for the file that writes it': { name: 'CheckoutForm', renamed: false },
  };
  const names = {};
  for (const [label, node] of Object.entries(cases)) {
    names[label] = page.name(node);
    assert.deepEqual(names[label], expected[label], label);
  }
  assert.deepEqual(page.posted, [], 'a name went to window.postMessage');
  for (const [label, node] of Object.entries(cases)) {
    page.page.document.querySelector = () => node;
    const { component } = page.request('inspect', { marker: 'pick1' });
    assert.equal(names[label].name, component.names[0], `${label}: not the name the pick reports`);
    assert.equal(names[label].renamed, component.renamed === true, `${label}: renamed differs from the pick's`);
  }
});

test('collector: a name asked for while hovering reads no prop, no owner, no call site and nothing of the document', () => {
  const page = arm({
    dom: true,
    // Counted from before the collector starts, since it takes these then.
    before: `
      globalThis.documentWork = [];
      const count = (proto, key) => {
        const native = proto[key];
        proto[key] = function (...args) { documentWork.push(key); return native.apply(this, args); };
      };
      count(Document.prototype, 'querySelectorAll');
      count(Document.prototype, 'getElementsByTagName');
      count(DocumentFragment.prototype, 'querySelectorAll');
      count(DocumentFragment.prototype, 'querySelector');
      const shadow = Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot');
      Object.defineProperty(Element.prototype, 'shadowRoot', {
        configurable: true,
        get() { documentWork.push('shadowRoot'); return shadow.get.call(this); },
      });
    `,
  });
  const reads = [];
  const watch = (object, keys) => {
    for (const key of keys) {
      const value = object[key];
      Object.defineProperty(object, key, {
        configurable: true,
        enumerable: true,
        get() {
          reads.push(key);
          return value;
        },
      });
    }
    return object;
  };
  // A password field on the page, which a pick's guard reads.
  const secret = new page.page.HTMLInputElement('input', { type: 'password' });
  secret.value = 'hunter2';
  const Total = function Total() {};
  const component = watch({ tag: 0, type: Total, memoizedProps: { amount: 5 }, return: null, _debugOwner: null }, ['memoizedProps', 'alternate']);
  const host = watch(
    { tag: 5, type: 'button', memoizedProps: { id: 'pay' }, return: component, _debugOwner: component },
    ['memoizedProps', '_debugOwner', '_debugSource', '_debugStack']
  );
  const button = new page.page.Element('button', { id: 'pay' });
  button.__reactFiber$t = host;
  const field = new page.page.Element('input', {});
  const instance = watch(
    { type: watch({ name: 'CouponField', __file: '/src/CouponField.vue' }, ['__file']), props: { modelValue: 'x' }, parent: null, appContext: {}, subTree: null },
    ['props', 'appContext', 'subTree']
  );
  field.__vnode = { ctx: instance, props: {} };

  assert.deepEqual(page.name(button), { name: 'Total', renamed: false });
  assert.deepEqual(page.name(field), { name: 'CouponField', renamed: false });
  assert.deepEqual(reads, [], 'read for the name');
  assert.deepEqual(plain(page.realm('documentWork')), [], 'the document was searched for the name');

  // A pick reads all of it, so the counts above can see it.
  for (const node of [button, field]) {
    page.page.document.querySelector = () => node;
    page.request('inspect', { marker: 'pick1' });
  }
  assert.ok(reads.includes('memoizedProps') && reads.includes('_debugOwner') && reads.includes('props'), reads.join());
  assert.ok(page.realm('documentWork').includes('querySelectorAll'), 'a pick searched nothing either');
});

/**
 * Counts, in the page, every search of the document or under an element the
 * collector could make, and every shadow root it asks for: arm()'s `before`,
 * since the collector takes these at its start.
 */
const COUNT_DOCUMENT_WORK = `
  globalThis.documentWork = [];
  const count = (proto, key, label) => {
    const native = proto[key];
    proto[key] = function (...args) { documentWork.push(label); return native.apply(this, args); };
  };
  count(Document.prototype, 'querySelectorAll', 'querySelectorAll');
  count(Document.prototype, 'getElementsByTagName', 'getElementsByTagName');
  count(Element.prototype, 'getElementsByTagName', 'getElementsByTagName under an element');
  count(DocumentFragment.prototype, 'querySelectorAll', 'querySelectorAll in a shadow root');
  count(DocumentFragment.prototype, 'querySelector', 'querySelector in a shadow root');
  const shadow = Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot');
  Object.defineProperty(Element.prototype, 'shadowRoot', {
    configurable: true,
    get() { documentWork.push('shadowRoot'); return shadow.get.call(this); },
  });
`;

/**
 * A proxy over target that writes into touched each member asked of it (by
 * descriptor or by value), each listing of its keys and each call.
 */
function watchedProxy(touched, label, target) {
  return new Proxy(target, {
    get(object, key, receiver) {
      touched.push(`${label}.${String(key)}`);
      return Reflect.get(object, key, receiver);
    },
    getOwnPropertyDescriptor(object, key) {
      touched.push(`${label}.${String(key)}`);
      return Reflect.getOwnPropertyDescriptor(object, key);
    },
    ownKeys(object) {
      touched.push(`${label} keys`);
      return Reflect.ownKeys(object);
    },
    apply(fn, self, args) {
      touched.push(`${label}()`);
      return Reflect.apply(fn, self, args);
    },
  });
}

test('collector: a Svelte name asked for while hovering reads the file and nothing else, nothing of the document, and calls nothing', () => {
  const page = arm({ dom: true, before: COUNT_DOCUMENT_WORK });
  const touched = [];
  const watched = (label, target) => watchedProxy(touched, label, target);
  // A password field on the page, which a pick's guard reads.
  const field = new page.page.HTMLInputElement('input', { type: 'password' });
  field.value = 'correct horse battery';
  page.page.__svelte = watched('__svelte', { v: page.realm("new Set(['5'])") });
  const fn = watched('function', svelteFunction('CouponField', 'src/lib/CouponField.svelte'));
  const box = new page.page.Element('div', {});
  const button = box.append(new page.page.Element('button', {}));
  button.__svelte_meta = {
    parent: watched('stack', { type: 'component', file: 'src/lib/CheckoutForm.svelte', line: 6, column: 2, parent: null }),
    loc: watched('loc', { file: 'src/lib/CouponField.svelte', line: 5, column: 2 }),
    component: watched('context', svelteContext(fn, watched('props', { value: 'SUMMER25' }))),
  };

  assert.deepEqual(page.name(button), { name: 'CouponField', renamed: false });
  assert.deepEqual(touched, ['loc.file'], 'read for the name');
  assert.deepEqual(plain(page.realm('documentWork')), [], 'the document was searched for the name');

  // A pick reads all of it, so the counts above can see it.
  page.page.document.querySelector = () => button;
  const { component } = page.request('inspect', { marker: 'pick1' });
  assert.deepEqual([component.names, component.source, component.version, component.props], [['CouponField', 'CheckoutForm'], 'src/lib/CouponField.svelte:5:3', '5', ['value="SUMMER25"']]);
  for (const read of ['loc.line', 'stack.file', 'context.s', 'context.function', 'props keys', '__svelte.v']) {
    assert.ok(touched.includes(read), `a pick did not read ${read}`);
  }
  assert.ok(!touched.includes('function()'), "a pick called the component's function");
  assert.ok(page.realm('documentWork').includes('getElementsByTagName under an element'), 'a pick searched nothing either');
});

test('collector: a name asked for in a deep tree with no component climbs a bounded number of elements', () => {
  const page = arm();
  let climbed = 0;
  let node = null;
  for (let depth = 0; depth < 10000; depth += 1) {
    const parent = node;
    node = {};
    Object.defineProperty(node, 'parentElement', {
      get() {
        climbed += 1;
        return parent;
      },
    });
  }
  // node is the deepest, 10,000 elements from the top.
  assert.equal(page.name(node), null);
  // CLIMB_LIMIT (500) up for React, and as many again for Vue 3, for Vue 2
  // and for Svelte. Angular is not asked.
  assert.ok(climbed <= 2000, `${climbed} elements climbed`);
});

test('collector: a name asked for on a page with no component is answered with null, and one that throws too', () => {
  const page = arm();
  assert.equal(page.name(nodeWith()), null);
  assert.equal(page.name(null), null);
  const throwing = {
    'a fiber whose return throws': nodeWith({
      __reactFiber$t: {
        tag: 5,
        type: 'div',
        get return() {
          throw new Error('the page refuses');
        },
      },
    }),
    'an element whose parent throws': {
      get parentElement() {
        throw new Error('the page refuses');
      },
    },
  };
  for (const [label, node] of Object.entries(throwing)) {
    let reply;
    assert.doesNotThrow(() => {
      reply = page.name(node);
    }, label);
    assert.equal(reply, null, label);
  }
  // And it still answers after.
  assert.deepEqual(page.name(nodeWith({ __reactFiber$t: devFibers(function Total() {}) })), { name: 'Total', renamed: false });
});

test('collector: a name asked for again from inside an answer, by a getter of the page, gets none and does not recurse', () => {
  const page = arm();
  const other = nodeWith({ __reactFiber$t: devFibers(function Other() {}) });
  let calls = 0;
  let inner = 'not asked';
  const Total = function Total() {};
  Object.defineProperty(Total, 'displayName', {
    get() {
      calls += 1;
      inner = page.name(other);
      return undefined;
    },
  });
  assert.deepEqual(page.name(nodeWith({ __reactFiber$t: devFibers(Total) })), { name: 'Total', renamed: false });
  assert.equal(inner, undefined, 'the request sent from inside the answer was answered');
  assert.equal(calls, 1);
  assert.deepEqual(page.name(other), { name: 'Other', renamed: false });
});

test('collector: the name is answered through the natives taken at document_start, and a page whose addEventListener throws sees nothing thrown', () => {
  const page = arm();
  // Replaced after the collector started: the reply does not go through them.
  page.realm(`
    globalThis.sent = [];
    const dispatch = window.dispatchEvent;
    window.dispatchEvent = function (event) { sent.push(event.type); return dispatch.call(this, event); };
    window.addEventListener = function () { throw new Error('patched'); };
    CustomEvent = function () { throw new Error('patched'); };
  `);
  const node = nodeWith({ __reactFiber$t: devFibers(function Total() {}) });
  assert.deepEqual(page.name(node), { name: 'Total', renamed: false });
  assert.deepEqual(plain(page.realm('sent')), ['__cdr_name'], 'the reply went through the page\'s dispatchEvent');

  // Started late, where the page's own addEventListener throws: no answer,
  // and nothing thrown into the page.
  let late;
  assert.doesNotThrow(() => {
    late = arm({ before: "addEventListener = function () { throw new Error('the page refuses'); };" });
  });
  assert.equal(late.name(node), undefined);
});

// ----------------------------------------------------------------- Svelte --
// The shapes a Svelte development build leaves are built by svelteMeta and
// the helpers beside it, above the hover tests.

test('collector: a Svelte element is named after its file, and printed at its line, with its column counted from 1', () => {
  const page = arm({ dom: true });
  page.realm("window.__svelte = { v: new Set(['5']) }; Element.prototype.__svelte_meta = null;");
  const button = new page.page.Element('button', {});
  page.page.document.querySelector = () => button;
  const pick = () => page.request('inspect', { marker: 'pick1' }).component;

  // Svelte 5 counts lines from 1 and columns from 0.
  button.__svelte_meta = svelteMeta('src/lib/CouponField.svelte', 14, 4);
  assert.deepEqual(pick(), {
    framework: 'svelte',
    build: 'development',
    names: ['CouponField'],
    hops: 0,
    source: 'src/lib/CouponField.svelte:14:5',
    version: '5',
  });
  // Svelte 4 counts lines from 0 as well, and only it writes char.
  button.__svelte_meta = { loc: { file: 'src/lib/CouponField.svelte', line: 13, column: 4, char: 310 } };
  assert.equal(pick().source, 'src/lib/CouponField.svelte:14:5');
  // A path with Vite's cache buster prints without it.
  button.__svelte_meta = svelteMeta('/src/routes/+page.svelte?t=1731900000', 3, 0);
  assert.deepEqual([pick().names, pick().source], [['+page'], '/src/routes/+page.svelte:3:1']);
  // No file, no component: there is nothing to name it by.
  button.__svelte_meta = { loc: { line: 3, column: 0 } };
  assert.equal(pick(), null);

  // The version only when exactly one major is on the page.
  button.__svelte_meta = svelteMeta('src/lib/CouponField.svelte', 14, 4);
  for (const [versions, expected] of [["new Set(['4', '5'])", undefined], ["new Set(['4'])", '4'], ["['5']", undefined], ['null', undefined]]) {
    page.realm(`window.__svelte = { v: ${versions} };`);
    assert.equal(pick().version, expected, versions);
  }
  page.realm('delete window.__svelte;');
  assert.equal(pick().version, undefined);
});

test("collector: a Svelte element with no meta of its own climbs to the nearest that has one, and never takes Element.prototype's for one", () => {
  const page = arm({ dom: true });
  // Svelte 5 puts null there; a page could put anything.
  page.realm("Element.prototype.__svelte_meta = { loc: { file: 'src/lib/Wrong.svelte', line: 1, column: 0 } };");
  const card = new page.page.Element('div', { class: 'card' });
  card.__svelte_meta = svelteMeta('src/lib/Card.svelte', 2, 0);
  // What {@html} writes has no meta of its own.
  const inner = card.append(new page.page.Element('p', {})).append(new page.page.Element('em', {}));
  page.page.document.querySelector = () => inner;
  const { component } = page.request('inspect', { marker: 'pick1' });
  assert.deepEqual([component.names, component.hops, component.source], [['Card'], 2, 'src/lib/Card.svelte:2:1']);
  // With no element of its own holding one, there is no Svelte component.
  const loose = new page.page.Element('span', {});
  page.page.document.querySelector = () => loose;
  assert.equal(page.request('inspect', { marker: 'pick1' }).component, null);
});

test('collector: the blocks a Svelte element was rendered inside give the files it sits in, folded and at most five', () => {
  const page = arm({ dom: true });
  const stack = (entries) => entries.reduceRight((parent, [type, file]) => ({ type, file, line: 1, column: 0, parent }), null);
  const input = new page.page.Element('input', {});
  input.__svelte_meta = svelteMeta('src/lib/CouponField.svelte', 5, 2, {
    parent: stack([
      ['if', 'src/lib/CouponField.svelte'],
      ['component', 'src/lib/CheckoutForm.svelte'],
      ['each', 'src/lib/CheckoutForm.svelte'],
      ['component', 'src/routes/checkout/+page.svelte'],
      ['component', 'src/routes/+layout.svelte'],
      ['component', 'src/App.svelte'],
      ['component', 'src/Root.svelte'],
    ]),
  });
  page.page.document.querySelector = () => input;
  assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.names, ['CouponField', 'CheckoutForm', '+page', '+layout', 'App']);
});

test("collector: a Svelte 5.58 element prints the props of the component it is written in, without Svelte's own keys, and withholds a secret one", () => {
  const page = arm({ dom: true });
  const CouponField = svelteFunction('CouponField', 'src/lib/CouponField.svelte');
  let reads = 0;
  const props = {
    // What the compiler hands a component for a reactive expression.
    get value() {
      reads += 1;
      return 'SUMMER25';
    },
    disabled: false,
    apiToken: 'tok_live_abc123',
    children() {},
    $$slots: { default: true },
    $$events: {},
  };
  const context = svelteContext(CouponField, props);
  const input = new page.page.Element('input', {});
  input.__svelte_meta = svelteMeta('src/lib/CouponField.svelte', 5, 2, { component: context });
  page.page.document.querySelector = () => input;
  const pick = () => page.request('inspect', { marker: 'pick1' }).component;
  assert.deepEqual(pick().props, ['value="SUMMER25"', 'disabled=false', 'apiToken=<redacted>']);
  assert.equal(reads, 1, 'a prop was read more than once');

  // A snippet's element, written in the parent's file and rendered with the
  // component's context: the props are not the parent's, so none print.
  input.__svelte_meta = svelteMeta('src/lib/CheckoutForm.svelte', 9, 4, { component: context });
  assert.deepEqual([pick().names, pick().props], [['CheckoutForm'], undefined]);
  // Svelte 5.57 and earlier put no context on the element.
  input.__svelte_meta = svelteMeta('src/lib/CouponField.svelte', 5, 2);
  assert.equal(pick().props, undefined);
  // Nor does a function compiled without a file (a production build) name one.
  input.__svelte_meta = svelteMeta('src/lib/CouponField.svelte', 5, 2, { component: svelteContext(function CouponField() {}, props) });
  assert.equal(pick().props, undefined);
});

test('collector: a Svelte component that renders a password field withholds its value prop, and a component beside it does not', () => {
  const page = arm({ dom: true });
  const Form = svelteFunction('CheckoutForm', 'src/lib/CheckoutForm.svelte');
  const Coupon = svelteFunction('PasswordBox', 'src/lib/PasswordBox.svelte');
  const Note = svelteFunction('Note', 'src/lib/Note.svelte');
  const form = svelteContext(Form, {});
  const coupon = svelteContext(Coupon, { value: 'abc', hint: 'Use 12 characters' }, form);
  const note = svelteContext(Note, { value: 'abc' }, form);
  // <div id="app"> > <form> > (<div> > <label>, <input type=password>), <p>
  const app = new page.page.Element('div', { id: 'app' });
  const formElement = app.append(new page.page.Element('form', {}));
  formElement.__svelte_meta = svelteMeta('src/lib/CheckoutForm.svelte', 4, 0, { component: form });
  const box = formElement.append(new page.page.Element('div', {}));
  box.__svelte_meta = svelteMeta('src/lib/PasswordBox.svelte', 3, 0, { component: coupon });
  const label = box.append(new page.page.Element('label', {}));
  label.__svelte_meta = svelteMeta('src/lib/PasswordBox.svelte', 4, 2, { component: coupon });
  const field = box.append(new page.page.HTMLInputElement('input', { type: 'password' }));
  field.__svelte_meta = svelteMeta('src/lib/PasswordBox.svelte', 5, 2, { component: coupon });
  field.value = 'correct horse battery';
  const aside = formElement.append(new page.page.Element('p', {}));
  aside.__svelte_meta = svelteMeta('src/lib/Note.svelte', 2, 0, { component: note });

  page.page.document.querySelector = () => label;
  assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.props, ['value=<redacted>', 'hint="Use 12 characters"']);
  // The field is under the same form, but Note did not render it.
  page.page.document.querySelector = () => aside;
  assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.props, ['value="abc"']);
});

test('collector: a Svelte pick calls no accessor planted on what it reads', () => {
  const page = arm({ dom: true });
  const calls = [];
  const planted = (object, key, value) =>
    Object.defineProperty(object, key, {
      configurable: true,
      enumerable: true,
      get() {
        calls.push(key);
        return value;
      },
    });
  const Coupon = svelteFunction('CouponField', 'src/lib/CouponField.svelte');
  const card = new page.page.Element('div', {});
  card.__svelte_meta = svelteMeta('src/lib/Card.svelte', 2, 0);
  // An accessor where the meta would be: passed over, as no meta.
  const child = card.append(new page.page.Element('span', {}));
  planted(child, '__svelte_meta', svelteMeta('src/lib/Wrong.svelte', 1, 0));
  page.page.document.querySelector = () => child;
  assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.names, ['Card']);

  // On the meta, its loc, the stack and the context.
  const meta = { parent: null, loc: { file: 'src/lib/CouponField.svelte' } };
  planted(meta.loc, 'line', 5);
  planted(meta.loc, 'column', 2);
  const entry = {};
  planted(entry, 'file', 'src/lib/Wrong.svelte');
  meta.parent = entry;
  const context = { p: null };
  planted(context, 's', { value: 'SUMMER25' });
  planted(context, 'function', Coupon);
  meta.component = context;
  card.__svelte_meta = meta;
  page.page.document.querySelector = () => card;
  assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component, {
    framework: 'svelte',
    build: 'development',
    names: ['CouponField'],
    hops: 0,
    source: 'src/lib/CouponField.svelte',
  });
  planted(page.page, '__svelte', { v: null });
  const loc = { file: 'src/lib/CouponField.svelte', line: 5, column: 2 };
  card.__svelte_meta = { loc };
  planted(card.__svelte_meta, 'component', svelteContext(Coupon, { value: 'SUMMER25' }));
  page.request('inspect', { marker: 'pick1' });
  planted(card.__svelte_meta, 'loc', loc);
  assert.equal(page.request('inspect', { marker: 'pick1' }).component, null);
  assert.deepEqual(calls, [], `called: ${calls.join(', ')}`);
});

// ---------------------------------------------------------------- Angular --
// window.ng as @angular/core@22.3.0 publishes it in a development build
// (publishDefaultGlobalUtils in _debug_node-chunk.mjs): getOwningComponent
// answers the component whose template holds an element, or null for one
// Angular did not render and for the root component's host; getHostElement
// the element a component is on; getDirectiveMetadata its inputs, as
// { public name: class property name }; isSignal whether a value is a signal.
// The compiler gives a component's definition (ɵcmp, a value of the class's
// own) a debugInfo in a development build (compiler-cli
// extractClassDebugInfo, with lineNumber counted from 1).
//
// getOwningComponent and getHostElement answer through getLContext, and
// write what it writes. At render (attachPatchData) each component instance,
// its host and the root elements of each template hold their view's number
// in __ngContext__, and other elements hold nothing. getLContext asked about
// an element caches a new LContext on it; asked about a component instance,
// on the instance and its host, or it reuses the LContext the host holds and
// fills in its component, caching it on the instance only then.

/** A signal as Angular makes one: a function to call for the value, or one that throws while a required input is unset. */
function signalOf(value, { unset = false } = {}) {
  const read = () => {
    if (unset) throw new Error('NG0950: Input is required but no value is available yet.');
    return value;
  };
  read.isSignal = true;
  return read;
}

/**
 * <app-root ng-version="22.3.0"> > <main> > <div class="layout"> >
 * <app-checkout> > <section> > <app-coupon-field> > <div class="coupon"> >
 * (<input>, <p> > <em>), where the <p> is a library's own markup that
 * Angular did not render, with each component of its own class. With `moved`, the coupon's <div> sits in an overlay of its own
 * instead, outside the app, as a CDK overlay or a portal moves an element,
 * so that its component's host is not above it. With `shadow`, it is the
 * top element of an open shadow root of its host, as
 * ViewEncapsulation.ShadowDom puts a template, so that a climb by
 * parentElement stops below the host; the realm needs SHADOW_NATIVES.
 *
 * calls counts every call of a window.ng function, written lists each
 * object a call wrote __ngContext__ on, filled each LContext a call found
 * already made and filled in the component of, and `inside` is set while a
 * call runs. lContext(target) is getLContext, as a test asks it to stand for
 * what Angular DevTools asked before the pick.
 */
function angularApp(page, { coupon = {}, info = true, publish = true, moved = false, shadow = false } = {}) {
  const { Element } = page.page;
  const calls = [];
  const written = [];
  const filled = [];
  const state = { inside: false };
  const component = (name, inputs, fields, debug) => {
    const Type = { [name]: class {} }[name];
    if (debug) Type.ɵcmp = { debugInfo: { className: name, ...debug } };
    Type.inputsMeta = inputs;
    return Object.assign(new Type(), fields);
  };
  const app = component('AppComponent', {}, {}, info && { filePath: 'src/app/app.component.ts', lineNumber: 9 });
  const checkout = component('CheckoutComponent', { step: 'step' }, { step: 2 }, info && { filePath: 'src/app/checkout/checkout.component.ts', lineNumber: 20 });
  const couponField = component(
    'CouponFieldComponent',
    { code: 'code', disabled: ['disabled', 0], apiToken: 'token', placeholder: 'placeholder', ...coupon.inputs },
    { code: 'SUMMER25', disabled: signalOf(false), token: 'tok_live_abc123', placeholder: signalOf('', { unset: true }), ...coupon.fields },
    info && { filePath: 'src/app/coupon-field/coupon-field.component.ts', lineNumber: 12 }
  );
  const root = new Element('app-root', { 'ng-version': '22.3.0' });
  // Each host sits some elements below the one above it, as in an app:
  // <main> is the root's template's top element and the <div> inside it a
  // plain one, and <section> the checkout's template's top element.
  const main = root.append(new Element('main', {}));
  const layout = main.append(new Element('div', { class: 'layout' }));
  const checkoutHost = layout.append(new Element('app-checkout', {}));
  const section = checkoutHost.append(new Element('section', {}));
  const couponHost = section.append(new Element('app-coupon-field', {}));
  const overlay = moved ? new Element('div', { class: 'cdk-overlay-container' }) : null;
  const box = shadow
    ? new Element('div', { class: 'coupon' })
    : (overlay ?? couponHost).append(new Element('div', { class: 'coupon' }));
  if (shadow) couponHost.shadow = new page.page.ShadowRoot(couponHost, [box]);
  const input = box.append(new page.page.HTMLInputElement('input', coupon.type ? { type: coupon.type } : {}));
  const note = box.append(new Element('p', {}));
  const emphasis = note.append(new Element('em', {}));

  // Each view by its number: the elements it holds, in order, and the
  // component whose template it is (none for the root view).
  class View {
    constructor(id, nodes, context) {
      Object.assign(this, { id, nodes, context });
    }
  }
  const views = new Map(
    [
      new View(0, [root], null),
      new View(1, [main, layout, checkoutHost], app),
      new View(2, [section, couponHost], checkout),
      new View(3, [box, input], couponField),
    ].map((view) => [view.id, view])
  );
  const hosts = new Map([
    [app, root],
    [checkout, checkoutHost],
    [couponField, couponHost],
  ]);
  // What render leaves: each instance and its host the number of the view
  // the host is in, and each template's top element its view's.
  root.__ngContext__ = app.__ngContext__ = 0;
  checkoutHost.__ngContext__ = checkout.__ngContext__ = main.__ngContext__ = 1;
  couponHost.__ngContext__ = couponField.__ngContext__ = section.__ngContext__ = 2;
  box.__ngContext__ = 3;
  // Angular climbs by parentNode: the parents as built, whatever a test
  // makes of parentElement later.
  const parents = new Map(
    [main, layout, checkoutHost, section, couponHost, box, input, note, emphasis].map((element) => [element, element.parentElement])
  );

  class LContext {
    constructor(lViewId, nodeIndex, native) {
      Object.assign(this, { lViewId, nodeIndex, native, component: undefined, directives: undefined, localRefs: undefined });
    }
  }
  // attachPatchData and readPatchedData: a plain write and a plain read.
  const write = (target, value) => {
    target.__ngContext__ = value;
    written.push(target);
  };
  const read = (target) => {
    const data = target.__ngContext__;
    return typeof data === 'number' ? (views.get(data) ?? null) : data || null;
  };
  // Angular tells a component instance by its class's ɵcmp, which is a
  // getter where a component is compiled just in time; this tells it by its
  // host, so that no test's getter runs on that account.
  function getLContext(target) {
    let found = read(target);
    if (found instanceof View) {
      const component = hosts.has(target) ? target : undefined;
      const native = component ? hosts.get(target) : target;
      const index = found.nodes.indexOf(native);
      if (index === -1) {
        if (component) throw new Error('The provided component was not found in the application');
        return null;
      }
      const existing = read(native);
      const context = existing && !(existing instanceof View) ? existing : new LContext(found.id, index, native);
      if (component && context.component === undefined) {
        if (context === existing) filled.push(context);
        context.component = component;
        write(component, context);
      }
      write(native, context);
      found = context;
    } else if (!found) {
      for (let parent = parents.get(target); parent; parent = parents.get(parent)) {
        const above = read(parent);
        if (!above) continue;
        const view = above instanceof View ? above : views.get(above.lViewId);
        if (!view) return null;
        const index = view.nodes.indexOf(target);
        if (index >= 0) {
          found = new LContext(view.id, index, target);
          write(target, found);
          break;
        }
      }
    }
    return found || null;
  }
  const call = (name, body) => (arg) => {
    calls.push(name);
    state.inside = true;
    try {
      return body(arg);
    } finally {
      state.inside = false;
    }
  };
  const ng = {
    // The component whose view holds the element, or null in the root view.
    getOwningComponent: call('getOwningComponent', (element) => {
      const context = getLContext(element);
      const view = context ? views.get(context.lViewId) : null;
      return view ? view.context : null;
    }),
    // Throws, as Angular does, for an instance it finds no view for.
    getHostElement: call('getHostElement', (instance) => getLContext(instance).native),
    getDirectiveMetadata: call('getDirectiveMetadata', (instance) => ({ inputs: instance.constructor.inputsMeta, outputs: {} })),
    isSignal: call('isSignal', (value) => typeof value === 'function' && value.isSignal === true),
  };
  if (publish) page.page.ng = ng;
  return {
    ng,
    calls,
    written,
    filled,
    state,
    lContext: getLContext,
    root,
    main,
    layout,
    checkoutHost,
    section,
    couponHost,
    overlay,
    box,
    input,
    note,
    emphasis,
    app,
    checkout,
    couponField,
  };
}

test('collector: an Angular element names the component whose template holds it, the file and line of its class, the components above, and the version', () => {
  const page = arm({ dom: true });
  const angular = angularApp(page);
  page.page.document.querySelector = () => angular.input;
  assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component, {
    framework: 'angular',
    build: 'development',
    names: ['CouponFieldComponent', 'CheckoutComponent', 'AppComponent'],
    hops: 0,
    source: 'src/app/coupon-field/coupon-field.component.ts:12',
    version: '22.3.0',
    // By public name. A signal is called, and the required one not set yet
    // is left out.
    props: ['code="SUMMER25"', 'disabled=false', 'apiToken=<redacted>'],
  });
  // The host element is written in the template of the component above it.
  page.page.document.querySelector = () => angular.couponHost;
  assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.names, ['CheckoutComponent', 'AppComponent']);
  // What a library wrote itself climbs to the nearest element Angular rendered.
  page.page.document.querySelector = () => angular.emphasis;
  const { component } = page.request('inspect', { marker: 'pick1' });
  assert.deepEqual([component.names[0], component.hops], ['CouponFieldComponent', 2]);
});

test('collector: an Angular component without debugInfo is named by its class, with no source, and a definition behind a getter is not read', () => {
  const page = arm({ dom: true });
  const angular = angularApp(page, { info: false });
  page.page.document.querySelector = () => angular.input;
  const { component } = page.request('inspect', { marker: 'pick1' });
  assert.deepEqual([component.names, component.source], [['CouponFieldComponent', 'CheckoutComponent', 'AppComponent'], undefined]);
  // A component compiled just in time: ɵcmp is a getter that compiles it.
  let compiled = 0;
  Object.defineProperty(angular.couponField.constructor, 'ɵcmp', {
    configurable: true,
    get() {
      compiled += 1;
      return { debugInfo: { className: 'Wrong', filePath: 'src/wrong.ts', lineNumber: 1 } };
    },
  });
  const again = page.request('inspect', { marker: 'pick1' }).component;
  assert.deepEqual([again.names[0], again.source, compiled], ['CouponFieldComponent', undefined, 0]);
});

test("collector: an Angular component that renders a password field withholds its value input, read under its host", () => {
  const page = arm({ dom: true });
  const angular = angularApp(page, {
    coupon: { type: 'password', inputs: { value: 'value', hint: 'hint' }, fields: { value: 'abc', hint: 'Use 12 characters' } },
  });
  angular.input.value = 'correct horse battery';
  page.page.document.querySelector = () => angular.note;
  assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.props, [
    // Shaped like a password, in a component that renders one (secretShaped).
    'code=<redacted>',
    'disabled=false',
    'apiToken=<redacted>',
    'value=<redacted>',
    'hint="Use 12 characters"',
  ]);
});

test('collector: an Angular input a template binds by a harmless alias is withheld for the secret name of its class property', () => {
  const page = arm({ dom: true });
  // @Input('value') password, and apiKey = input('', { alias: 'note' }): a
  // template binds them as value and note, and getDirectiveMetadata lists
  // them as { value: 'password', note: 'apiKey' }. No secret field anywhere.
  const angular = angularApp(page, {
    coupon: {
      inputs: { value: 'password', note: 'apiKey', label: 'label' },
      fields: { password: 'hunter2-blue-42', apiKey: signalOf('abcdEFGH1234ijkl'), label: 'Coupon' },
    },
  });
  page.page.document.querySelector = () => angular.input;
  assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.props, [
    'code="SUMMER25"',
    'disabled=false',
    'apiToken=<redacted>',
    // Filed under the class property, so the name rule withholds it.
    'password=<redacted>',
    'apiKey=<redacted>',
    'label="Coupon"',
  ]);

  // An alias that lands on another input's public name is listed once, and
  // the second is not read at all.
  const again = arm({ dom: true });
  let read = 0;
  const twice = angularApp(again, {
    coupon: { inputs: { value: 'password', password: 'pin' }, fields: { password: 'hunter2-blue-42' } },
  });
  Object.defineProperty(twice.couponField, 'pin', {
    get() {
      read += 1;
      return '4321';
    },
  });
  again.page.document.querySelector = () => twice.input;
  const props = again.request('inspect', { marker: 'pick1' }).component.props;
  assert.deepEqual([props.filter((prop) => prop.startsWith('password=')), read], [['password=<redacted>'], 0]);
});

test('collector: a window.ng that throws, answers nothing an object, or is not Angular\'s gives no component and throws nothing', () => {
  const cases = {
    'functions that throw': (ng) => {
      ng.getOwningComponent = () => {
        throw new Error('the page refuses');
      };
    },
    'answers of the wrong kind': (ng) => {
      ng.getOwningComponent = () => 'CouponFieldComponent';
    },
    'no getOwningComponent': (ng) => {
      delete ng.getOwningComponent;
    },
    'getOwningComponent behind a getter': (ng) => {
      const owning = ng.getOwningComponent;
      Object.defineProperty(ng, 'getOwningComponent', { get: () => owning });
    },
    'a window.ng of another kind': (ng, page) => {
      page.page.ng = 'ng';
    },
  };
  for (const [label, spoil] of Object.entries(cases)) {
    const page = arm({ dom: true });
    const angular = angularApp(page);
    spoil(angular.ng, page);
    page.page.document.querySelector = () => angular.input;
    let reply;
    assert.doesNotThrow(() => {
      reply = page.request('inspect', { marker: 'pick1' });
    }, label);
    assert.equal(reply.component, null, label);
  }
  // A getHostElement and a getDirectiveMetadata that throw leave the name.
  const page = arm({ dom: true });
  const angular = angularApp(page);
  angular.ng.getHostElement = angular.ng.getDirectiveMetadata = () => {
    throw new Error('the page refuses');
  };
  page.page.document.querySelector = () => angular.input;
  const { component } = page.request('inspect', { marker: 'pick1' });
  assert.deepEqual([component.names, component.props], [['CouponFieldComponent'], undefined]);
});

test("collector: Angular is never asked while hovering, and a page another framework rendered first never calls window.ng", () => {
  const page = arm({ dom: true, before: COUNT_DOCUMENT_WORK });
  const angular = angularApp(page);
  const touched = [];
  page.page.ng = watchedProxy(touched, 'ng', angular.ng);
  assert.equal(page.name(angular.input), null);
  assert.deepEqual([angular.calls, touched], [[], []], 'window.ng was asked for a name');
  assert.deepEqual(plain(page.realm('documentWork')), [], 'the document was searched for a name');
  // A pick asks it.
  page.page.document.querySelector = () => angular.input;
  assert.equal(page.request('inspect', { marker: 'pick1' }).component.names[0], 'CouponFieldComponent');
  assert.ok(angular.calls.includes('getOwningComponent'));

  // React found first: window.ng is not called.
  angular.calls.length = 0;
  touched.length = 0;
  angular.input.__reactFiber$t = devFibers(function CouponField() {});
  const { component } = page.request('inspect', { marker: 'pick1' });
  assert.deepEqual([component.framework, component.names[0]], ['react', 'CouponField']);
  assert.deepEqual([angular.calls, touched], [[], []], 'window.ng was asked on a React page');
});

// What an Angular pick changes in the page, and puts back.

/** The fixture's elements and component instances, by name. */
function angularObjects(angular) {
  const { root, main, layout, checkoutHost, section, couponHost, box, input, note, emphasis, app, checkout, couponField } = angular;
  return { root, main, layout, checkoutHost, section, couponHost, box, input, note, emphasis, app, checkout, couponField };
}

/** Each object's own __ngContext__, as its descriptor, by name. */
function ngContexts(objects) {
  return Object.fromEntries(
    Object.entries(objects).map(([name, object]) => [name, Object.getOwnPropertyDescriptor(object, '__ngContext__')])
  );
}

/** The names of the objects a list holds, each once, sorted. */
function namesIn(objects, list) {
  const names = new Map(Object.entries(objects).map(([name, object]) => [object, name]));
  return [...new Set(list.map((object) => names.get(object) ?? 'another'))].sort();
}

test('collector: an Angular pick puts back the __ngContext__ of every object its calls changed, so the page can still serialise its components', () => {
  const page = arm({ dom: true });
  const angular = angularApp(page);
  const objects = angularObjects(angular);
  const before = ngContexts(objects);
  // As render leaves them: a number on each instance, its host and each
  // template's top element, and nothing on the rest.
  assert.deepEqual(Object.fromEntries(Object.entries(before).map(([name, member]) => [name, member?.value])), {
    root: 0,
    main: 1,
    layout: undefined,
    checkoutHost: 1,
    section: 2,
    couponHost: 2,
    box: 3,
    input: undefined,
    note: undefined,
    emphasis: undefined,
    app: 0,
    checkout: 1,
    couponField: 2,
  });

  const picks = [
    // Asked about itself, then each instance up the chain and its host.
    ['input', ['app', 'checkout', 'checkoutHost', 'couponField', 'couponHost', 'input', 'root']],
    // A host, asked about as an element first.
    ['couponHost', ['app', 'checkout', 'checkoutHost', 'couponHost', 'root']],
    // A climb from markup Angular did not render to the template's root.
    ['emphasis', ['app', 'box', 'checkout', 'checkoutHost', 'couponField', 'couponHost', 'root']],
  ];
  for (const [picked, changed] of picks) {
    angular.written.length = 0;
    page.page.document.querySelector = () => objects[picked];
    const { component } = page.request('inspect', { marker: 'pick1' });
    assert.equal(component.framework, 'angular', picked);
    // The calls did write each of these while the pick ran...
    assert.deepEqual(namesIn(objects, angular.written), changed, picked);
    // ...and every one is as it was: a number the same number, and one that
    // was absent absent again.
    assert.deepEqual(ngContexts(objects), before, picked);
    for (const instance of [angular.app, angular.checkout, angular.couponField]) {
      assert.doesNotThrow(() => JSON.stringify(instance), `${picked}: ${instance.constructor.name}`);
    }
  }

  // The printout is the one a pick gave before anything was put back, and
  // the same at every pick.
  page.page.document.querySelector = () => angular.input;
  const expected = {
    framework: 'angular',
    build: 'development',
    names: ['CouponFieldComponent', 'CheckoutComponent', 'AppComponent'],
    hops: 0,
    source: 'src/app/coupon-field/coupon-field.component.ts:12',
    version: '22.3.0',
    props: ['code="SUMMER25"', 'disabled=false', 'apiToken=<redacted>'],
  };
  assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component, expected);
  assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component, expected);
});

test('collector: an LContext cached before an Angular pick, by Angular DevTools say, stays the same object, its component as it was', () => {
  const page = arm({ dom: true });
  const angular = angularApp(page);
  const { checkoutHost, couponHost, input, checkout, couponField } = angular;
  // DevTools asked about the coupon's host as an element, which caches an
  // LContext with no component on it, and about the checkout component,
  // which caches one with its component on it and on its host.
  const hostContext = angular.lContext(couponHost);
  const checkoutContext = angular.lContext(checkout);
  assert.deepEqual([hostContext.component, checkoutContext.component, checkoutHost.__ngContext__ === checkoutContext], [undefined, checkout, true]);
  angular.filled.length = 0;
  angular.written.length = 0;

  page.page.document.querySelector = () => input;
  assert.equal(page.request('inspect', { marker: 'pick1' }).component.names[0], 'CouponFieldComponent');
  // The pick found the host's LContext, filled in its component and cached
  // it on the instance...
  assert.deepEqual([angular.filled.length, angular.filled[0] === hostContext], [1, true]);
  assert.ok(angular.written.includes(couponField));
  // ...and both are as they were, as is what the checkout's was.
  assert.equal(couponHost.__ngContext__, hostContext);
  assert.deepEqual(Object.getOwnPropertyDescriptor(hostContext, 'component'), {
    value: undefined,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  assert.equal(couponField.__ngContext__, 2);
  assert.deepEqual(
    [checkout.__ngContext__ === checkoutContext, checkoutHost.__ngContext__ === checkoutContext, checkoutContext.component === checkout],
    [true, true, true]
  );
});

test('collector: an Angular pick puts back the host of a component whose elements an overlay moved elsewhere, which no climb from them reaches', () => {
  const page = arm({ dom: true });
  const angular = angularApp(page, { moved: true });
  const { couponHost, input, couponField } = angular;
  page.page.document.querySelector = () => input;
  const { component } = page.request('inspect', { marker: 'pick1' });
  assert.deepEqual([component.names, component.hops], [['CouponFieldComponent', 'CheckoutComponent', 'AppComponent'], 0]);
  // getHostElement changed the host before it named it, and the number it
  // held is the one its instance held.
  assert.ok(angular.written.includes(couponHost));
  assert.deepEqual(Object.getOwnPropertyDescriptor(couponHost, '__ngContext__'), {
    value: 2,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  assert.deepEqual([couponField.__ngContext__, Object.hasOwn(input, '__ngContext__')], [2, false]);

  // An LContext a caller cached on the host first, which the pick's call
  // reused, is told from one the call made by what else is filled in, and
  // stays, with its component as it was: filled in by getComponent, so the
  // call left the instance alone, or with its directives filled in by
  // getDirectives, or its local refs by a DebugElement's references (null
  // for a node with no local names, as getLocalRefs stores it), so the call
  // filled in its component.
  const fills = {
    'its component': (context, app) => {
      context.component = app.couponField;
    },
    'its directives': (context) => {
      context.directives = [];
    },
    'its local refs': (context) => {
      context.localRefs = null;
    },
  };
  for (const [label, fill] of Object.entries(fills)) {
    const again = arm({ dom: true });
    const app = angularApp(again, { moved: true });
    const context = app.lContext(app.couponHost);
    fill(context, app);
    const was = context.component;
    app.written.length = 0;
    again.page.document.querySelector = () => app.input;
    assert.equal(again.request('inspect', { marker: 'pick1' }).component.names[0], 'CouponFieldComponent', label);
    assert.ok(app.written.includes(app.couponHost), label);
    assert.deepEqual(
      [app.couponHost.__ngContext__ === context, context.component === was, app.couponField.__ngContext__],
      [true, true, 2],
      label
    );
  }

  // One with nothing filled in cannot be told from one the call made, and
  // the host is given back the number instead.
  const last = arm({ dom: true });
  const lone = angularApp(last, { moved: true });
  lone.lContext(lone.couponHost);
  last.page.document.querySelector = () => lone.input;
  last.request('inspect', { marker: 'pick1' });
  assert.deepEqual([lone.couponHost.__ngContext__, lone.couponField.__ngContext__], [2, 2]);
});

test('collector: an Angular pick notes the elements above a host only a call named before any call asks about them, so an LContext cached there first stays', () => {
  const page = arm({ dom: true });
  const angular = angularApp(page, { moved: true });
  const { root, checkoutHost, couponHost, input, app, checkout, couponField } = angular;
  // DevTools asked about the checkout's host and the root as elements, which
  // caches an LContext with nothing filled in on each. Both are above the
  // coupon's host, which the first getHostElement names, and above nothing
  // the pick climbed through, each with elements in between that are no
  // host, so a sweep that stops short of either leaves it to noteHost.
  const checkoutContext = angular.lContext(checkoutHost);
  const rootContext = angular.lContext(root);
  const objects = angularObjects(angular);
  const before = ngContexts(objects);
  angular.filled.length = 0;

  page.page.document.querySelector = () => input;
  const { component } = page.request('inspect', { marker: 'pick1' });
  assert.deepEqual([component.names, component.hops], [['CouponFieldComponent', 'CheckoutComponent', 'AppComponent'], 0]);
  // The calls filled in both LContexts and cached them on the instances...
  assert.deepEqual(
    [angular.filled.length, angular.filled.includes(checkoutContext), angular.filled.includes(rootContext)],
    [2, true, true]
  );
  // ...and every object is as it was: both hosts hold the same LContext,
  // with nothing filled in, rather than the number noteHost would give back,
  // and the coupon's host, which held a number, holds it again.
  assert.deepEqual(ngContexts(objects), before);
  assert.deepEqual(
    [checkoutHost.__ngContext__ === checkoutContext, root.__ngContext__ === rootContext, couponHost.__ngContext__],
    [true, true, 2]
  );
  assert.deepEqual([checkoutContext.component, rootContext.component], [undefined, undefined]);
  assert.deepEqual([app.__ngContext__, checkout.__ngContext__, couponField.__ngContext__], [0, 1, 2]);
});

// Node.prototype.parentNode and ShadowRoot.prototype.host, getters as Chrome
// has them, which the collector takes at its start. An element's parent node
// is its parent element, or the shadow root it is a top element of, and host
// throws for anything but a shadow root, as the native does.
const SHADOW_NATIVES = `
  globalThis.Node = class Node {};
  Object.defineProperty(Node.prototype, 'parentNode', {
    configurable: true,
    get() { return this.parentElement ?? this.root ?? null; },
  });
  globalThis.ShadowRoot = class ShadowRoot extends DocumentFragment {
    constructor(host, children) {
      super(children);
      this.attachedTo = host;
      for (const child of children) child.root = this;
    }
  };
  Object.defineProperty(ShadowRoot.prototype, 'host', {
    configurable: true,
    get() {
      if (!(this instanceof ShadowRoot)) throw new TypeError('Illegal invocation');
      return this.attachedTo;
    },
  });
`;

test('collector: an Angular pick notes the host of a component whose template is in a shadow root, and every host above it, before any call asks about them', () => {
  const page = arm({ dom: true, before: SHADOW_NATIVES });
  const angular = angularApp(page, { shadow: true });
  const { checkoutHost, couponHost, box, input, app, checkout, couponField } = angular;
  // DevTools asked about both hosts as elements, which caches an LContext
  // with nothing filled in on each: on a host only a call's answer named,
  // the one case noteHost cannot tell from a call's own.
  const couponContext = angular.lContext(couponHost);
  const checkoutContext = angular.lContext(checkoutHost);
  const objects = angularObjects(angular);
  const before = ngContexts(objects);
  // The page's own parentNode and host on the way up, which the climb must
  // not run: it steps through the natives.
  let outside = 0;
  for (const holder of [box, couponHost.shadowRoot]) {
    for (const key of ['parentNode', 'host']) {
      Object.defineProperty(holder, key, {
        configurable: true,
        get() {
          outside += 1;
          return null;
        },
      });
    }
  }

  // The input, whose climb stops at once, below the root's top element, and
  // the <em>, whose climb stops at that top element itself.
  for (const [picked, hops] of [
    [input, 0],
    [angular.emphasis, 2],
  ]) {
    const label = picked.tag;
    angular.filled.length = 0;
    page.page.document.querySelector = () => picked;
    const { component } = page.request('inspect', { marker: 'pick1' });
    assert.deepEqual([component.names, component.hops], [['CouponFieldComponent', 'CheckoutComponent', 'AppComponent'], hops], label);
    // The calls filled in both LContexts and cached them on the instances...
    assert.deepEqual(
      [angular.filled.length, angular.filled.includes(couponContext), angular.filled.includes(checkoutContext)],
      [2, true, true],
      label
    );
    // ...and every object is as it was, both hosts holding the same
    // LContext, with nothing filled in, rather than the number noteHost
    // would give back.
    assert.deepEqual(ngContexts(objects), before, label);
    assert.deepEqual(
      [couponHost.__ngContext__ === couponContext, checkoutHost.__ngContext__ === checkoutContext],
      [true, true],
      label
    );
    assert.deepEqual([couponContext.component, checkoutContext.component], [undefined, undefined], label);
    assert.deepEqual([app.__ngContext__, checkout.__ngContext__, couponField.__ngContext__], [0, 1, 2], label);
    for (const instance of [app, checkout, couponField]) {
      assert.doesNotThrow(() => JSON.stringify(instance), `${label}: ${instance.constructor.name}`);
    }
  }
  assert.equal(outside, 0, 'a parentNode or host of the page was run');
});

test('collector: an Angular pick neither runs nor replaces an accessor the page put on __ngContext__', () => {
  const page = arm({ dom: true });
  const angular = angularApp(page);
  const { input, couponField, state } = angular;
  // Each counts the reads and writes that come from anywhere but Angular's
  // own calls, which read and write __ngContext__ plainly.
  let outside = 0;
  const accessor = (initial) => {
    let kept = initial;
    return {
      configurable: true,
      enumerable: false,
      get() {
        if (!state.inside) outside += 1;
        return kept;
      },
      set(value) {
        if (!state.inside) outside += 1;
        kept = value;
      },
    };
  };
  const onInstance = accessor(2);
  const onInput = accessor(undefined);
  Object.defineProperty(couponField, '__ngContext__', onInstance);
  Object.defineProperty(input, '__ngContext__', onInput);
  // A call that replaces the one on the element with a value of its own.
  const owning = angular.ng.getOwningComponent;
  angular.ng.getOwningComponent = (element) => {
    const answer = owning(element);
    if (element === input) {
      Object.defineProperty(input, '__ngContext__', { value: 'replaced', writable: true, enumerable: true, configurable: true });
    }
    return answer;
  };

  page.page.document.querySelector = () => input;
  assert.equal(page.request('inspect', { marker: 'pick1' }).component.names[0], 'CouponFieldComponent');
  assert.equal(outside, 0, 'the collector ran an accessor of the page');
  // The instance's is still the page's, and the element's is the page's again.
  const instanceMember = Object.getOwnPropertyDescriptor(couponField, '__ngContext__');
  const inputMember = Object.getOwnPropertyDescriptor(input, '__ngContext__');
  assert.deepEqual(
    [instanceMember.get === onInstance.get, instanceMember.set === onInstance.set, inputMember.get === onInput.get, inputMember.set === onInput.set],
    [true, true, true, true]
  );
  assert.deepEqual([inputMember.enumerable, inputMember.configurable], [false, true]);
  // What Angular's own write handed the instance's setter is kept by the
  // page's code, where nothing is put back without running it.
  state.inside = true;
  assert.equal(couponField.__ngContext__.component, couponField);
  state.inside = false;
});

test('collector: an Angular pick whose window.ng throws partway still puts back everything its calls changed', () => {
  const page = arm({ dom: true });
  const angular = angularApp(page);
  const objects = angularObjects(angular);
  const before = ngContexts(objects);
  // Each throws once getLContext has written: getOwningComponent asked about
  // the input, getHostElement asked about the checkout component (on it and
  // its host), and getDirectiveMetadata, the last call, every time.
  const { getOwningComponent, getHostElement } = angular.ng;
  angular.ng.getOwningComponent = (element) => {
    const answer = getOwningComponent(element);
    if (element === angular.input) throw new Error('the page refuses');
    return answer;
  };
  angular.ng.getHostElement = (instance) => {
    const host = getHostElement(instance);
    if (instance === angular.checkout) throw new Error('the page refuses');
    return host;
  };
  angular.ng.getDirectiveMetadata = () => {
    throw new Error('the page refuses');
  };
  page.page.document.querySelector = () => angular.input;
  const { component } = page.request('inspect', { marker: 'pick1' });
  // One up to the template's root, and no further than the throw.
  assert.deepEqual([component.names, component.hops, component.props], [['CouponFieldComponent', 'CheckoutComponent'], 1, undefined]);
  assert.deepEqual(namesIn(objects, angular.written), ['box', 'checkout', 'checkoutHost', 'couponField', 'couponHost', 'input']);
  assert.deepEqual(ngContexts(objects), before);

  // A throw out of the reader itself, here from a Map.prototype.get the page
  // replaced before the collector started (as a late start finds it), at the
  // second component of the chain: the pick has no answer, and what the
  // calls before it changed is put back all the same.
  const late = arm({
    dom: true,
    before: `
      const get = Map.prototype.get;
      Map.prototype.get = function (key) {
        if (key !== null && typeof key === 'object' && Object.hasOwn(key, 'explodes')) throw new Error('the page broke Map');
        return get.call(this, key);
      };
    `,
  });
  const broken = angularApp(late);
  const brokenObjects = angularObjects(broken);
  const was = ngContexts(brokenObjects);
  broken.checkout.explodes = true;
  late.page.document.querySelector = () => broken.input;
  assert.equal(late.request('inspect', { marker: 'pick1' }), null);
  assert.deepEqual(namesIn(brokenObjects, broken.written), ['couponField', 'couponHost', 'input']);
  assert.deepEqual(ngContexts(brokenObjects), was);
});

test('collector: an Angular pick whose getHostElement answers something that is no element still names what it reached, and puts back what the calls changed', () => {
  // Chrome's parentElement getter, which the collector takes at its start,
  // throws for anything but a node. These elements keep their parent as a
  // value of their own.
  const page = arm({
    dom: true,
    before: `
      globalThis.Node = class Node {};
      Object.defineProperty(Node.prototype, 'parentElement', {
        configurable: true,
        get() {
          if (this === null || typeof this !== 'object' || !('tag' in this)) throw new TypeError('Illegal invocation');
          return Object.getOwnPropertyDescriptor(this, 'parentElement')?.value ?? null;
        },
      });
    `,
  });
  const angular = angularApp(page);
  const objects = angularObjects(angular);
  const before = ngContexts(objects);
  // A wrapper of the page's, which lets Angular answer for the checkout
  // component and then answers an object of its own.
  const { getHostElement } = angular.ng;
  angular.ng.getHostElement = (instance) => {
    const host = getHostElement(instance);
    return instance === angular.checkout ? { wraps: host } : host;
  };
  page.page.document.querySelector = () => angular.input;
  const { component } = page.request('inspect', { marker: 'pick1' });
  // That object has no owner, so the names stop at the checkout.
  assert.deepEqual([component.names, component.hops], [['CouponFieldComponent', 'CheckoutComponent'], 0]);
  assert.deepEqual(namesIn(objects, angular.written), ['checkout', 'checkoutHost', 'couponField', 'couponHost', 'input']);
  assert.deepEqual(ngContexts(objects), before);
});

test('collector: an Angular pick puts back what it changed though the page put get and value on Object.prototype', () => {
  const page = arm({ dom: true });
  const angular = angularApp(page);
  const objects = angularObjects(angular);
  // An accessor of the page's on the input, which the first call replaces.
  const accessor = { configurable: true, enumerable: false, get: () => undefined, set: () => {} };
  Object.defineProperty(angular.input, '__ngContext__', accessor);
  const before = ngContexts(objects);
  // Planted by the first call, once window.ng has been read: node's vm
  // aborts when its global is asked for a descriptor with these in place.
  // A descriptor that inherits either has both a value and a getter.
  const objectProto = page.realm('Object.prototype');
  const owning = angular.ng.getOwningComponent;
  angular.ng.getOwningComponent = (element) => {
    const answer = owning(element);
    if (element === angular.input) {
      Object.defineProperty(angular.input, '__ngContext__', { value: 'replaced', writable: true, enumerable: true, configurable: true });
      Object.defineProperty(objectProto, 'value', { configurable: true, writable: true, value: 'page' });
      Object.defineProperty(objectProto, 'get', { configurable: true, writable: true, value: () => 'page' });
    }
    return answer;
  };
  page.page.document.querySelector = () => angular.input;
  try {
    assert.equal(page.request('inspect', { marker: 'pick1' }).component.names[0], 'CouponFieldComponent');
    assert.equal(objectProto.get(), 'page');
  } finally {
    delete objectProto.value;
    delete objectProto.get;
  }
  assert.deepEqual(ngContexts(objects), before);
});

test('collector: an Angular pick writes back only what its calls changed, through the natives taken at the start, and a member that refuses leaves the rest put back', () => {
  // The page's defineProperty and deleteProperty as the collector found
  // them, counting its writes of __ngContext__ and of an LContext's component.
  const page = arm({
    dom: true,
    before: `
      globalThis.writes = [];
      const define = Object.defineProperty;
      Object.defineProperty = function (holder, key, descriptor) {
        if (key === '__ngContext__' || key === 'component') writes.push(holder);
        return define(holder, key, descriptor);
      };
      const remove = Reflect.deleteProperty;
      Reflect.deleteProperty = function (holder, key) {
        if (key === '__ngContext__' || key === 'component') writes.push(holder);
        return remove(holder, key);
      };
    `,
  });
  const angular = angularApp(page);
  const objects = angularObjects(angular);
  const before = ngContexts(objects);
  // Replaced since by the page, as a page can at any time.
  page.realm(`
    Object.defineProperty = Reflect.deleteProperty = Object.getOwnPropertyDescriptor = () => {
      throw new Error('the page replaced it');
    };
  `);
  page.page.document.querySelector = () => angular.input;
  assert.equal(page.request('inspect', { marker: 'pick1' }).component.names.length, 3);
  assert.deepEqual(ngContexts(objects), before);
  // Not the template's root, which no call changed, nor anything else.
  assert.deepEqual(namesIn(objects, page.realm('writes')), ['app', 'checkout', 'checkoutHost', 'couponField', 'couponHost', 'input', 'root']);
  assert.equal(page.realm('writes').length, 7);

  // The root component frozen by a call (the last), with its LContext on:
  // it cannot be put back, and stays so, and nothing else does.
  const again = arm({ dom: true });
  const frozen = angularApp(again);
  const all = angularObjects(frozen);
  const was = ngContexts(all);
  const { getDirectiveMetadata } = frozen.ng;
  frozen.ng.getDirectiveMetadata = (instance) => {
    Object.freeze(frozen.app);
    return getDirectiveMetadata(instance);
  };
  again.page.document.querySelector = () => frozen.input;
  let component;
  assert.doesNotThrow(() => {
    component = again.request('inspect', { marker: 'pick1' }).component;
  });
  assert.deepEqual([component.names[0], component.props.length], ['CouponFieldComponent', 3]);
  assert.equal(frozen.app.__ngContext__.component, frozen.app);
  const now = ngContexts(all);
  delete now.app;
  delete was.app;
  assert.deepEqual(now, was);
});

// ------------------------------------------------------------------ Vue 2 --
// A Vue 2 app as vue@2.7.16 leaves it (src/core/instance/lifecycle.js, init.js
// and vdom/vnode.js): __vue__ on each component's root element, set by each
// _update in turn so the outermost of components sharing a root holds it;
// $options made from the constructor's options (initInternalComponent), so
// name and __file sit on its prototype and _componentTag on it; $parent the
// component whose patch created it, which for slot content is the one that
// renders the slot; and vnodes holding elm, children, context and
// componentInstance as their own values.

/**
 * root (new Vue, no name) > App > CheckoutForm > (Card > (<label> slot
 * content, WithTracking > CouponField), <div class="terms"> with v-html),
 * as elements:
 *
 *   <div class="app"> > <form> > (<section class="card"> > (<label>,
 *   <div class="coupon"> > <input>), <div class="terms"> > <p> > <a>)
 *
 * dev false gives the production build's _renderProxy. watch, a list, makes
 * each instance a proxy that writes into it each member asked of it.
 */
function vue2App(page, { dev = true, password = false, watch = null } = {}) {
  const { Element, HTMLInputElement } = page.page;
  const counts = { child: 0, props: 0 };
  class VNode {
    constructor(fields) {
      this.tag = undefined;
      this.children = undefined;
      this.elm = undefined;
      this.context = undefined;
      this.componentInstance = undefined;
      Object.assign(this, fields);
    }
    // Vue's one accessor on a vnode: the old name of componentInstance.
    get child() {
      counts.child += 1;
      return this.componentInstance;
    }
  }
  function Vue() {}
  Vue.version = '2.7.16';
  Vue.options = {};
  const extend = (options) => {
    function VueComponent() {}
    VueComponent.prototype = Object.create(Vue.prototype);
    VueComponent.prototype.constructor = VueComponent;
    VueComponent.super = Vue;
    VueComponent.options = options;
    return VueComponent;
  };
  const instance = (Ctor, parent, { label, tag, props = {} } = {}) => {
    const target = Object.create(Ctor.prototype);
    const vm = watch ? watchedProxy(watch, label, target) : target;
    target._isVue = true;
    target.$options = Ctor === Vue ? {} : Object.create(Ctor.options);
    if (tag) target.$options._componentTag = tag;
    target.$parent = parent;
    target.$root = parent ? parent.$root : vm;
    // defineReactive: a getter for each prop.
    target._props = {};
    for (const [key, value] of Object.entries(props)) {
      Object.defineProperty(target._props, key, {
        enumerable: true,
        configurable: true,
        get() {
          counts.props += 1;
          return value;
        },
      });
    }
    target._renderProxy = dev ? new Proxy(vm, {}) : vm;
    return vm;
  };
  const mount = (vm, vnode) => {
    vm._vnode = vnode;
    vm.$el = vnode.elm;
    vnode.elm.__vue__ = vm;
  };

  const appElement = new Element('div', { class: 'app' });
  const form = appElement.append(new Element('form', {}));
  const section = form.append(new Element('section', { class: 'card' }));
  const label = section.append(new Element('label', {}));
  const coupon = section.append(new Element('div', { class: 'coupon' }));
  const input = coupon.append(new HTMLInputElement('input', password ? { type: 'password' } : {}));
  const terms = form.append(new Element('div', { class: 'terms' }));
  const link = terms.append(new Element('p', {})).append(new Element('a', {}));

  const root = instance(Vue, null, { label: 'root' });
  const App = instance(extend({ name: 'App', __file: 'src/App.vue' }), root, { label: 'App' });
  const Form = instance(extend({ __file: 'src/components/CheckoutForm.vue' }), App, { label: 'CheckoutForm' });
  const Card = instance(extend({ name: 'Card' }), Form, { label: 'Card', tag: 'card' });
  const Tracking = instance(extend({}), Card, { label: 'WithTracking', tag: 'with-tracking' });
  const Coupon = instance(extend({ __name: 'CouponField', __file: 'src/components/CouponField.vue' }), Tracking, {
    label: 'CouponField',
    tag: 'coupon-field',
    props: { value: 'SUMMER25', disabled: false },
  });

  // Inner before outer, as Vue patches them.
  mount(Coupon, new VNode({ tag: 'div', elm: coupon, context: Coupon, children: [new VNode({ tag: 'input', elm: input, context: Coupon })] }));
  mount(Tracking, new VNode({ tag: 'vue-component-5-CouponField', elm: coupon, context: Tracking, componentInstance: Coupon }));
  mount(
    Card,
    new VNode({
      tag: 'section',
      elm: section,
      context: Card,
      children: [
        // Written in CheckoutForm's template, rendered in Card's slot.
        new VNode({ tag: 'label', elm: label, context: Form, children: [new VNode({ elm: { nodeType: 3 }, context: Form })] }),
        new VNode({ tag: 'vue-component-4-with-tracking', elm: coupon, context: Form, componentInstance: Tracking }),
      ],
    })
  );
  mount(
    Form,
    new VNode({
      tag: 'form',
      elm: form,
      context: Form,
      children: [
        new VNode({ tag: 'vue-component-3-card', elm: section, context: Form, componentInstance: Card }),
        // v-html: what it writes has no vnode.
        new VNode({ tag: 'div', elm: terms, context: Form }),
      ],
    })
  );
  mount(App, new VNode({ tag: 'div', elm: appElement, context: App, children: [new VNode({ tag: 'vue-component-2', elm: form, context: App, componentInstance: Form })] }));
  mount(root, new VNode({ tag: 'vue-component-1-App', elm: appElement, context: root, componentInstance: App }));
  if (watch) watch.length = 0;
  return { counts, extend, Vue, VNode, instance, root, App, Form, Card, Tracking, Coupon, appElement, form, section, label, coupon, input, terms, link };
}

test('collector: a Vue 2 element names the component whose template wrote it, the components above, its file, the version and its props', () => {
  const page = arm({ dom: true });
  const app = vue2App(page);
  const pick = (node) => {
    page.page.document.querySelector = () => node;
    return page.request('inspect', { marker: 'pick1' }).component;
  };
  assert.deepEqual(pick(app.input), {
    framework: 'vue',
    // A name from __name (script setup), then the tag it was written as,
    // then the options' name, then the file.
    names: ['CouponField', 'with-tracking', 'Card', 'CheckoutForm', 'App'],
    hops: 0,
    build: 'development',
    source: 'src/components/CouponField.vue',
    version: '2.7.16',
    props: ['value="SUMMER25"', 'disabled=false'],
  });
  assert.equal(app.counts.props, 2, 'a prop was read more than once');
  // The root of a component that another renders as its own: the innermost.
  assert.deepEqual(pick(app.coupon).names[0], 'CouponField');
  // Slot content: rendered by Card, written by CheckoutForm.
  assert.deepEqual([pick(app.label).names, pick(app.label).hops], [['CheckoutForm', 'App'], 0]);
  assert.equal(pick(app.label).source, 'src/components/CheckoutForm.vue');
  // A component's own root.
  assert.deepEqual(pick(app.section).names, ['Card', 'CheckoutForm', 'App']);
  // What v-html wrote: two up to the element its template has.
  assert.deepEqual([pick(app.link).names[0], pick(app.link).hops], ['CheckoutForm', 2]);
  // The app's root element, which new Vue holds: App, and new Vue has no name.
  assert.deepEqual(pick(app.appElement).names, ['App']);
});

test('collector: a Vue 2 production build is read too, claims no build, and finds the version through Vue.extend', () => {
  const page = arm({ dom: true });
  const app = vue2App(page, { dev: false });
  // A root made with new (Vue.extend(options))().
  Object.setPrototypeOf(app.root, app.extend({}).prototype);
  page.page.document.querySelector = () => app.input;
  const { component } = page.request('inspect', { marker: 'pick1' });
  assert.deepEqual([component.names[0], component.build, component.version], ['CouponField', undefined, '2.7.16']);
  // No __vue__, no Vue 2.
  delete app.coupon.__vue__;
  delete app.section.__vue__;
  delete app.form.__vue__;
  delete app.appElement.__vue__;
  assert.equal(page.request('inspect', { marker: 'pick1' }).component, null);
});

test('collector: a Vue 2 component that renders a password field withholds its value prop', () => {
  const page = arm({ dom: true });
  const app = vue2App(page, { password: true });
  app.input.value = 'correct horse battery';
  page.page.document.querySelector = () => app.coupon;
  assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.props, ['value=<redacted>', 'disabled=false']);
});

test('collector: an element with a Vue 3 vnode and a __vue__ reads as Vue 3, and a Vue 2 pick calls no accessor planted on what it reads', () => {
  const page = arm({ dom: true });
  const app = vue2App(page);
  app.input.__vnode = { ctx: { type: { name: 'Three' }, props: {}, parent: null } };
  page.page.document.querySelector = () => app.input;
  assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.names, ['Three']);
  delete app.input.__vnode;

  const calls = [];
  const planted = (object, key) => {
    const value = object[key];
    delete object[key];
    Object.defineProperty(object, key, {
      configurable: true,
      get() {
        calls.push(key);
        return value;
      },
    });
  };
  // Where the climb looks first: passed over, as no instance.
  planted(app.coupon, '__vue__');
  planted(app.Card, '$parent');
  planted(app.Form.$options, '_componentTag');
  page.page.document.querySelector = () => app.label;
  const { component } = page.request('inspect', { marker: 'pick1' });
  assert.deepEqual(component.names, ['CheckoutForm', 'App']);
  page.page.document.querySelector = () => app.input;
  // The climb passes the coupon's root and reaches Card's, whose walk finds
  // the coupon's element as WithTracking, written in CheckoutForm.
  assert.deepEqual(page.request('inspect', { marker: 'pick1' }).component.names, ['CheckoutForm', 'App']);
  assert.deepEqual([calls, app.counts.child], [[], 0], `called: ${calls.join(', ')}`);
});

test('collector: a Vue 2 name asked for while hovering is the name a pick reports, and reads no prop, no version, nothing of the document, and calls nothing', () => {
  const page = arm({ dom: true, before: COUNT_DOCUMENT_WORK });
  const touched = [];
  const app = vue2App(page, { watch: touched });
  const elements = ['input', 'coupon', 'label', 'section', 'link', 'appElement'];
  const names = {};
  for (const key of elements) names[key] = page.name(app[key]);
  assert.deepEqual(
    elements.map((key) => names[key]?.name),
    ['CouponField', 'CouponField', 'CheckoutForm', 'Card', 'CheckoutForm', 'App']
  );
  const read = new Set(touched.map((entry) => entry.slice(entry.indexOf('.') + 1)));
  for (const key of ['_props', '$root', '_renderProxy', 'constructor']) assert.ok(!read.has(key), `read ${key} for a name`);
  assert.deepEqual([app.counts.props, app.counts.child], [0, 0], 'a getter was run for a name');
  assert.deepEqual(plain(page.realm('documentWork')), [], 'the document was searched for a name');

  for (const key of elements) {
    page.page.document.querySelector = () => app[key];
    const { component } = page.request('inspect', { marker: 'pick1' });
    assert.deepEqual([names[key].name, names[key].renamed], [component.names[0], false], `${key}: not the name the pick reports`);
  }
  const picked = new Set(touched.map((entry) => entry.slice(entry.indexOf('.') + 1)));
  assert.ok(picked.has('_props') && picked.has('$root'), [...picked].join());
  assert.ok(page.realm('documentWork').includes('getElementsByTagName under an element'), 'a pick searched nothing either');
});

test('collector: a Vue 2 render tree is walked no further than SUBTREE_LIMIT vnodes, and an element past that is named for the root', () => {
  const page = arm({ dom: true });
  const { Element } = page.page;
  const app = vue2App(page);
  let looked = 0;
  const counted = (vnode) =>
    new Proxy(vnode, {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'elm') looked += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
  const List = app.instance(app.extend({ name: 'LongList' }), app.App, { label: 'LongList' });
  const list = new Element('ul', {});
  const rows = [];
  const spans = [];
  for (let i = 0; i < 4000; i += 1) {
    const row = list.append(new Element('li', {}));
    const span = row.append(new Element('span', {}));
    spans.push(span);
    rows.push(counted(new app.VNode({ tag: 'li', elm: row, context: app.Form, children: [counted(new app.VNode({ tag: 'span', elm: span, context: app.Form }))] })));
  }
  // And each of the list's children taken from it, which is work too.
  let taken = 0;
  const children = new Proxy(rows, {
    getOwnPropertyDescriptor(target, key) {
      if (key !== 'length') taken += 1;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  List._vnode = counted(new app.VNode({ tag: 'ul', elm: list, context: List, children }));
  List.$el = list;
  list.__vue__ = List;

  const both = (node) => {
    looked = taken = 0;
    const name = page.name(node);
    const hover = looked + taken;
    page.page.document.querySelector = () => node;
    looked = taken = 0;
    const { component } = page.request('inspect', { marker: 'pick1' });
    return { name: name.name, names: component.names, hops: component.hops, hover, pick: looked + taken };
  };
  // Inside the walk: rows rendered from CheckoutForm's slot, found exactly.
  const near = both(spans[10]);
  assert.deepEqual([near.name, near.names[0], near.hops], ['CheckoutForm', 'CheckoutForm', 0]);
  // Past it: the list's element is two up, but the span may have a vnode
  // of its own that was never looked at, so the root's component is named
  // with no steps counted.
  const far = both(spans[3500]);
  assert.deepEqual([far.name, far.names[0], far.hops], ['LongList', 'LongList', 0]);
  // At most SUBTREE_LIMIT vnodes looked at, and as many taken from a list.
  assert.ok(far.hover <= 6000 && far.pick <= 6000, `${far.hover} and ${far.pick} vnodes looked at or taken`);
});

// ------------------------------------------------------- the step up a tree --

test('collector: the Svelte, Vue 2 and Angular climbs step up through the native parentElement, never one the page defined on an element', () => {
  // Chrome's parentElement is a getter on Node.prototype, which the
  // collector takes at its start. This one reads _parent.
  const page = arm({
    dom: true,
    before: `
      globalThis.Node = class Node {};
      Object.defineProperty(Node.prototype, 'parentElement', {
        configurable: true,
        get() { return this._parent ?? null; },
      });
    `,
  });
  const { Element, HTMLInputElement } = page.page;
  const pick = (node) => {
    page.page.document.querySelector = () => node;
    return page.request('inspect', { marker: 'pick1' }).component;
  };

  // Svelte: <form> > <div> > (<label> > <b>, <input type=password>), where
  // <b> has no meta and the rest is PasswordBox's but the form.
  const form = svelteContext(svelteFunction('CheckoutForm', 'src/lib/CheckoutForm.svelte'), {});
  const box = svelteContext(svelteFunction('PasswordBox', 'src/lib/PasswordBox.svelte'), { value: 'abc', hint: 'Use 12 characters' }, form);
  const formElement = new Element('form', {});
  formElement.__svelte_meta = svelteMeta('src/lib/CheckoutForm.svelte', 4, 0, { component: form });
  const boxElement = formElement.append(new Element('div', {}));
  boxElement.__svelte_meta = svelteMeta('src/lib/PasswordBox.svelte', 3, 0, { component: box });
  const label = boxElement.append(new Element('label', {}));
  label.__svelte_meta = svelteMeta('src/lib/PasswordBox.svelte', 4, 2, { component: box });
  const bold = label.append(new Element('b', {}));
  const field = boxElement.append(new HTMLInputElement('input', { type: 'password' }));
  field.__svelte_meta = svelteMeta('src/lib/PasswordBox.svelte', 5, 2, { component: box });
  field.value = 'correct horse battery';
  const vue = vue2App(page);
  const angular = angularApp(page);

  // Then every element's own parentElement becomes an accessor of the
  // page's that answers null, its real parent kept where the native reads
  // it, and each read of it notes the function in the collector that made it.
  const readers = new Set();
  for (const element of page.page.document.getElementsByTagName('*')) {
    element._parent = element.parentElement;
    Object.defineProperty(element, 'parentElement', {
      configurable: true,
      get() {
        const frame = new Error().stack.split('\n').find((line) => line.includes('collector-main.js'));
        readers.add(/at (\S+) /.exec(frame ?? '')?.[1] ?? 'outside the collector');
        return null;
      },
    });
  }

  // One up to its meta, and the password field found beside it, which only
  // the climb from the meta to the component's scope reaches.
  const svelte = pick(bold);
  assert.deepEqual([svelte.names, svelte.hops, svelte.props], [['PasswordBox'], 1, ['value=<redacted>', 'hint="Use 12 characters"']]);
  // One up to the coupon's root, and what v-html wrote two up.
  assert.deepEqual([pick(vue.input).names[0], pick(vue.input).hops], ['CouponField', 0]);
  assert.deepEqual([pick(vue.link).names[0], pick(vue.link).hops], ['CheckoutForm', 2]);
  // Two up to the nearest element Angular rendered.
  assert.deepEqual([pick(angular.emphasis).names[0], pick(angular.emphasis).hops], ['CouponFieldComponent', 2]);
  assert.deepEqual([pick(angular.input).props], [['code="SUMMER25"', 'disabled=false', 'apiToken=<redacted>']]);

  // The readers of React and Vue 3, asked first, read the element's own
  // parentElement as they always have, so the accessor was in reach.
  assert.deepEqual([...readers].sort(), ['fiberOf', 'handlersOf', 'vueSummary']);
});
