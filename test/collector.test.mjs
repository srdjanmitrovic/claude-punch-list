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

function arm({ fetch, before } = {}) {
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
    postMessage(data) {
      posted.push(data);
    },
  };
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

  let nextId = 0;
  function request(action, extra = {}) {
    nextId += 1;
    const data = { __cdr: 'request', action, id: nextId, ...extra };
    for (const listener of listeners.get('message') || []) listener({ source: self, data });
    const reply = posted.findLast((message) => message.id === nextId);
    return reply ? plain(reply.payload) : undefined;
  }

  function dispatch(type, event) {
    for (const listener of listeners.get(type) || []) listener(event);
  }

  return {
    page,
    self,
    clock,
    nativeCalls,
    run,
    request,
    dispatch,
    snapshot: () => request('snapshot'),
    realm: (code) => vm.runInContext(code, page),
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
  const hostile = {
    toJSON() {
      throw new Error('nope');
    },
  };
  assert.equal(page.page.console.warn(hostile), 'native-warn');
  assert.equal(page.nativeCalls[0].args[0], hostile);
  assert.equal(page.snapshot().warnings[0].text, '[unserializable]');
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
  // a key over 400 characters is judged by its two ends.
  const expected = (name) =>
    /^\d+$/.test(name)
      ? false
      : name.length <= 400
        ? isSecretName(name)
        : isSecretName(name.slice(0, 200)) || isSecretName(name.slice(-200));

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

  // A member left out is still read, so a getter that throws beside the
  // value that ran the budget out still makes it unserializable, while one
  // inside a member left out is never reached.
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
    [`{"a":"${'x'.repeat(594)} …[truncated]`, '[unserializable]', '["a","b"]']
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

test('collector: messages from other windows are ignored', () => {
  const page = arm();
  let answered = false;
  page.page.postMessage = () => {
    answered = true;
  };
  page.dispatch('message', { source: {}, data: { __cdr: 'request', action: 'snapshot', id: 1 } });
  assert.equal(answered, false);
});
