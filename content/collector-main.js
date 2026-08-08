/**
 * MAIN-world collector.
 *
 * Runs in the page's own JavaScript world at document_start, before the page's
 * scripts execute. That is the only place where console, window.fetch and
 * XMLHttpRequest can be wrapped, because an ISOLATED-world content script sees
 * its own copies of those objects, not the page's.
 *
 * The price of living in the MAIN world is that chrome.* APIs are unavailable
 * here. Everything collected is buffered locally and handed to
 * collector-bridge.js (ISOLATED world) over window.postMessage on request.
 */
(() => {
  'use strict';

  // Re-injection guard. Wrapping fetch twice would record every request twice.
  if (window.__cdrCollector) return;

  const LIMIT = 30; // ring buffer size, per category
  const MAX_STRING = 600; // truncation budget for any single serialized value

  const buffers = {
    console: [],
    errors: [],
    network: [],
  };

  const startedAt = Date.now();

  function push(list, entry) {
    entry.t = Date.now() - startedAt; // ms since collector armed
    list.push(entry);
    if (list.length > LIMIT) list.shift();
  }

  function truncate(str) {
    if (typeof str !== 'string') str = String(str);
    return str.length > MAX_STRING ? str.slice(0, MAX_STRING) + ' …[truncated]' : str;
  }

  /**
   * Console arguments are arbitrary values, including objects with cyclic
   * references and DOM nodes. Anything thrown here would surface as a broken
   * console in the user's page, so every branch is defensive.
   */
  function serialize(value) {
    try {
      if (value instanceof Error) {
        return truncate(`${value.name}: ${value.message}\n${value.stack || ''}`);
      }
      if (value instanceof Element) {
        return truncate(`<${value.tagName.toLowerCase()}${value.id ? '#' + value.id : ''}>`);
      }
      if (typeof value === 'string') return truncate(value);
      if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
      if (value === null || value === undefined || typeof value !== 'object') {
        return String(value);
      }
      // Track the current ancestor chain, not every object ever visited. A
      // plain "seen" set would report the second reference to a shared object
      // as [Circular] even when the structure has no cycle at all, which hides
      // real data. JSON.stringify calls the replacer with `this` bound to the
      // holder, so the stack can be unwound to the current parent first.
      //
      // The node budget is not optional. Marking only true cycles means a
      // shared acyclic subgraph is re-expanded once per path that reaches it,
      // which is exponential in the worst case, and JSON.stringify builds the
      // entire string in memory before truncate() discards all but 600 chars.
      // On a page logging a large interlinked object graph that would hang the
      // page itself, since this runs in the page's own world.
      const ancestors = [];
      let budget = 4000;
      return truncate(
        JSON.stringify(value, function (_key, current) {
          if (budget <= 0) return '[…budget exceeded]';
          budget -= 1;
          if (typeof current === 'object' && current !== null) {
            while (ancestors.length && ancestors[ancestors.length - 1] !== this) {
              ancestors.pop();
            }
            if (ancestors.includes(current)) return '[Circular]';
            ancestors.push(current);
          }
          return current;
        })
      );
    } catch {
      return '[unserializable]';
    }
  }

  // ---------------------------------------------------------------- console --
  const nativeConsole = {};
  for (const level of ['error', 'warn']) {
    nativeConsole[level] = console[level];
    console[level] = function (...args) {
      try {
        push(buffers.console, {
          level,
          text: args.map(serialize).join(' '),
        });
      } catch {
        /* never let collection break the page's console */
      }
      return nativeConsole[level].apply(console, args);
    };
  }

  // --------------------------------------------------------------- runtime --
  // Capture phase catches two different things with one listener: uncaught
  // exceptions (which bubble) and resource load failures such as a 404 <img>
  // or <script> (which do not bubble and are only visible during capture).
  window.addEventListener(
    'error',
    (event) => {
      try {
        const target = event.target;
        if (target && target !== window && target.tagName) {
          push(buffers.errors, {
            kind: 'resource',
            text: `Failed to load <${target.tagName.toLowerCase()}>: ${
              target.src || target.href || '(unknown source)'
            }`,
          });
          return;
        }
        push(buffers.errors, {
          kind: 'exception',
          text: truncate(event.message || String(event.error || 'Unknown error')),
          where: event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : '',
          stack: event.error && event.error.stack ? truncate(event.error.stack) : '',
        });
      } catch {
        /* ignore */
      }
    },
    true
  );

  window.addEventListener('unhandledrejection', (event) => {
    try {
      const reason = event.reason;
      // serialize() folds an Error's stack into its text, which is right for a
      // console argument that has nowhere else to put it. Here there IS a
      // separate stack field, and a stack string already begins with
      // "Name: message", so reusing serialize() would print the message twice
      // and the whole trace twice over.
      const isError = reason instanceof Error;
      push(buffers.errors, {
        kind: 'unhandled-rejection',
        text: isError ? truncate(`${reason.name}: ${reason.message}`) : serialize(reason),
        stack: isError && reason.stack ? truncate(reason.stack) : '',
      });
    } catch {
      /* ignore */
    }
  });

  // ----------------------------------------------------------------- fetch --
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (...args) {
      let method = 'GET';
      let url = '';
      try {
        const [input, init] = args;
        url = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
        method = (init && init.method) || (input && input.method) || 'GET';
      } catch {
        /* ignore */
      }
      const started = performance.now();

      return nativeFetch.apply(this, args).then(
        (response) => {
          try {
            if (!response.ok) {
              push(buffers.network, {
                method: String(method).toUpperCase(),
                url: truncate(url),
                status: response.status,
                statusText: response.statusText,
                ms: Math.round(performance.now() - started),
                via: 'fetch',
              });
            }
          } catch {
            /* ignore */
          }
          return response;
        },
        (error) => {
          try {
            push(buffers.network, {
              method: String(method).toUpperCase(),
              url: truncate(url),
              status: 0,
              statusText: `Network failure: ${error && error.message ? error.message : error}`,
              ms: Math.round(performance.now() - started),
              via: 'fetch',
            });
          } catch {
            /* ignore */
          }
          throw error;
        }
      );
    };
  }

  // ------------------------------------------------------------------- XHR --
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      this.__cdrMethod = method;
      this.__cdrUrl = url;
    } catch {
      /* ignore */
    }
    return nativeOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    try {
      // Timing is per-send, so it is refreshed every call.
      this.__cdrStarted = performance.now();

      // The listener, however, must be attached only once per object. A page
      // that long-polls by reusing a single XMLHttpRequest would otherwise
      // accumulate one listener per send and record the same failure N times,
      // flushing every other entry out of the ring buffer.
      if (!this.__cdrHooked) {
        this.__cdrHooked = true;
        this.addEventListener('loadend', () => {
          try {
            // status 0 at loadend means the request failed outright: CORS
            // rejection, connection refused, or aborted.
            const failed = this.status === 0 || this.status >= 400;
            if (!failed) return;
            push(buffers.network, {
              method: String(this.__cdrMethod || 'GET').toUpperCase(),
              url: truncate(this.__cdrUrl || this.responseURL || ''),
              status: this.status,
              statusText: this.status === 0 ? 'Network failure or aborted' : this.statusText,
              ms: Math.round(performance.now() - (this.__cdrStarted || performance.now())),
              via: 'xhr',
            });
          } catch {
            /* ignore */
          }
        });
      }
    } catch {
      /* ignore */
    }
    return nativeSend.apply(this, args);
  };

  // --------------------------------------------------------------- bridge ---
  function snapshot() {
    return {
      console: buffers.console.slice(),
      errors: buffers.errors.slice(),
      network: buffers.network.slice(),
      armedAt: startedAt,
    };
  }

  window.addEventListener('message', (event) => {
    // Only accept messages this page sent to itself. Without this guard any
    // embedded iframe could ask for the buffer.
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__cdr !== 'request') return;

    if (data.action === 'clear') {
      buffers.console.length = 0;
      buffers.errors.length = 0;
      buffers.network.length = 0;
    }

    window.postMessage(
      { __cdr: 'response', id: data.id, payload: data.action === 'clear' ? null : snapshot() },
      '*'
    );
  });

  // Re-injection guard only. snapshot() deliberately stays inside this closure:
  // exposing it on window would hand every third-party script on the page a
  // one-call API for reading every console argument, stack trace and failed
  // request URL collected since document_start.
  //
  // Being honest about the limit of this: code running in the page can still
  // send itself a __cdr request and receive the buffer, because this script
  // shares the page's world by necessity. What it collects is the page's own
  // console and network activity, which any page script could already wrap for
  // itself, so nothing here is newly reachable. Removing the global just stops
  // it being trivially discoverable.
  try {
    Object.defineProperty(window, '__cdrCollector', {
      value: true,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  } catch {
    window.__cdrCollector = true;
  }
})();
