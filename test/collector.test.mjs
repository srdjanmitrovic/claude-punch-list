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

function arm({ fetch } = {}) {
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
      // Set by a test to make the next synchronous send() fail at the network
      // level, which in Chrome throws and fires no event at all.
      this.syncNetworkFailure = false;
      // What a synchronous send() answers with, set by a test that needs another.
      this.syncResponse = { status: 200, statusText: 'OK' };
    }
    open(method, url, async = true) {
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
    dispatch(type) {
      for (const handler of this.handlers[type] || []) handler({ type });
    }
    // Chrome's order: readystatechange, then load, abort, timeout or error,
    // then loadend, all while the object is DONE.
    finish(status, statusText = '', before = [], { loadend = true } = {}) {
      this.inFlight = false;
      this.readyState = 4;
      this.status = status;
      this.statusText = statusText;
      for (const type of loadend ? [...before, 'loadend'] : before) this.dispatch(type);
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
  assert.equal(page.snapshot().console[0].text, '[unserializable]');
});

test('collector: each ring keeps the last 30 entries', () => {
  const page = arm();
  for (let i = 1; i <= 35; i += 1) page.page.console.error(`error ${i}`);
  const texts = page.snapshot().console.map((entry) => entry.text);
  assert.equal(texts.length, 30);
  assert.equal(texts[0], 'error 6');
  assert.equal(texts.at(-1), 'error 35');
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
  // Added before the first send, so it runs before the collector's listener.
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
    // Added before the first send, so it runs before the collector's
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
  // Added before the first send, so the page's handler runs before the
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
