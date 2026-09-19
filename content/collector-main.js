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

  // ------------------------------------------------------------- call stack --
  // A failed request is fixed in the function that sent it, and the URL alone
  // never names that function. The only place it can be read is the call site,
  // so an Error is constructed there and formatted later, if the request fails.
  //
  // cleanPath() and STACK_FRAME are defined further down, in the inspect
  // section. Nothing here runs before the page's first request, which is long
  // after this file has finished executing, so the forward reference is safe.

  const STACK_CAPTURE_DEPTH = 6; // frames V8 is asked to record
  const CALLER_LIMIT = 3; // frames reported, nearest first
  const CALLER_MAX_STRING = 200; // characters kept from one formatted frame

  // This collector's own frames. The wrappers below are named functions purely
  // so that this can recognise them: an anonymous one is indistinguishable
  // from the page's code and would be reported to the user as the caller. The
  // file name is the backstop for any other frame of this file.
  const CDR_FRAME = /\b(?:cdrFetch|cdrXhrOpen)\b|collector-main\.js/;

  // "    at applyCoupon (https://host/src/Cart.jsx:70:36)". A frame with no
  // name ("    at https://host/src/main.jsx:12:5") does not match, and is
  // reported as its location alone.
  const STACK_NAME = /^\s*at\s+(?:async\s+)?(.+?)\s+\(/;

  /**
   * An Error built at the call site, for formatting only if the call fails.
   *
   * This is the one cost every request on every page the user visits pays, so
   * it stays at one allocation and no string work: V8 records the frames now
   * and only formats them when .stack is read.
   */
  function captureStack() {
    let saved;
    let restore = false;
    try {
      // The limit is global state belonging to the page, which may have raised
      // it for its own error reporting, so it is read first and put back
      // after. Only a value that was actually read is restored: writing
      // undefined back would stop V8 recording stacks for the page's errors
      // entirely, which is a worse bug than having no caller here.
      saved = Error.stackTraceLimit;
      restore = true;
      Error.stackTraceLimit = STACK_CAPTURE_DEPTH;
      return new Error();
    } catch {
      // A frozen Error, or a page accessor of its own that threw.
      return null;
    } finally {
      try {
        if (restore) Error.stackTraceLimit = saved;
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * The capture as at most three frames, nearest first.
   *
   * Only ever called on a request that has already failed, so a healthy page
   * never pays for the formatting, which is the expensive half.
   */
  // Frames belonging to a framework's own dispatch rather than to the page.
  // Deliberately short: over-matching would hide the page's own code, which is
  // the one thing these frames exist to name.
  const VENDOR_FRAME =
    /react-dom|react\.development|\/node_modules\/|zone\.js|vue\.(global|runtime|esm)/i;

  function callerFrames(error) {
    const frames = [];
    try {
      if (!error) return frames;
      let text;
      try {
        // Reading .stack runs Error.prepareStackTrace if the page installed
        // one, and that is page code: free to throw, or to hand back an object
        // rather than a string. sourceOf() below has the same guard.
        text = error.stack;
      } catch {
        return frames;
      }
      if (typeof text !== 'string') return frames;

      // Line 0 is the "Error" header, which is never a frame.
      for (const line of text.split('\n').slice(1)) {
        if (frames.length >= CALLER_LIMIT) break;
        if (CDR_FRAME.test(line)) continue;
        // Only three frames are kept, and a framework's own dispatch is never
        // the answer to "who sent this request". Measured on the React
        // fixture, the third slot went to react-dom's callCallback while the
        // page's own caller sat just below the cut.
        if (VENDOR_FRAME.test(line)) continue;
        const frame = line.match(STACK_FRAME);
        if (!frame) continue;
        const path = cleanPath(frame[1]);
        // Something that looks like a file, which means an extension on the
        // last segment. "at <anonymous>:1:1" and "at eval:3:9" name nowhere
        // the reader can open, and a bare document path such as /checkout is a
        // route rather than a file, so printing it sends the reader hunting
        // for a source file that never existed. Printing one is worse than
        // printing nothing, because the line around it claims otherwise.
        if (!path || !/\.[a-z0-9]{1,6}$/i.test(path.split('?')[0])) continue;
        const where = path + ':' + frame[2] + ':' + frame[3];
        const name = line.match(STACK_NAME);
        frames.push((name ? name[1] + ' (' + where + ')' : where).slice(0, CALLER_MAX_STRING));
      }
    } catch {
      /* ignore */
    }
    return frames;
  }

  // ----------------------------------------------------------------- fetch --
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    // Named so that callerFrames() can drop this frame from a capture.
    window.fetch = function cdrFetch(...args) {
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
      // Here, where the caller is still on the stack. By the time the promise
      // settles it is not, and the frames below this one are the microtask
      // queue rather than anybody's code.
      const stack = captureStack();

      return nativeFetch.apply(this, args).then(
        (response) => {
          try {
            if (!response.ok) {
              const entry = {
                method: String(method).toUpperCase(),
                url: truncate(url),
                status: response.status,
                statusText: response.statusText,
                ms: Math.round(performance.now() - started),
                via: 'fetch',
              };
              const caller = callerFrames(stack);
              if (caller.length) entry.caller = caller;
              push(buffers.network, entry);
            }
          } catch {
            /* ignore */
          }
          return response;
        },
        (error) => {
          try {
            const entry = {
              method: String(method).toUpperCase(),
              url: truncate(url),
              status: 0,
              statusText: `Network failure: ${error && error.message ? error.message : error}`,
              ms: Math.round(performance.now() - started),
              via: 'fetch',
            };
            const caller = callerFrames(stack);
            if (caller.length) entry.caller = caller;
            push(buffers.network, entry);
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

  // Named so that callerFrames() can drop this frame from a capture.
  XMLHttpRequest.prototype.open = function cdrXhrOpen(method, url, ...rest) {
    try {
      this.__cdrMethod = method;
      this.__cdrUrl = url;
      // Captured in open() rather than send(), because open() is where the
      // caller is. A library queues the send a tick later from a helper of its
      // own, and by then the stack names the library, not the page.
      this.__cdrStack = captureStack();
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
            // Read and release before the success early return below. An
            // unformatted V8 Error holds a strong reference to every recorded
            // frame's function and receiver, so a long lived XHR, which is how
            // a page long polls, would pin those objects for as long as it
            // lives. Two formatted strings are cheap; the Error is not.
            const caller = callerFrames(this.__cdrStack);
            this.__cdrStack = null;

            const failed = this.status === 0 || this.status >= 400;
            if (!failed) return;
            const entry = {
              method: String(this.__cdrMethod || 'GET').toUpperCase(),
              url: truncate(this.__cdrUrl || this.responseURL || ''),
              status: this.status,
              statusText: this.status === 0 ? 'Network failure or aborted' : this.statusText,
              ms: Math.round(performance.now() - (this.__cdrStarted || performance.now())),
              via: 'xhr',
            };
            if (caller.length) entry.caller = caller;
            push(buffers.network, entry);
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

  // ---------------------------------------------------------------- inspect --
  // The element picker runs in the ISOLATED world, where the framework internals
  // React and Vue hang off DOM nodes as expando properties are invisible. It
  // marks the node the user clicked with an attribute and asks this script to
  // describe it.
  //
  // Everything here formats as well as reads. The reply crosses postMessage, so
  // it has to survive structured clone: plain strings, numbers and arrays only,
  // never a fiber, a component instance or a live prop value. It also means the
  // prompt template only has to print strings.

  const CLIMB_LIMIT = 500; // parentElement steps before giving up
  const NAME_LIMIT = 5; // components reported, nearest first
  const PROP_LIMIT = 12; // props reported for the nearest component
  const PROP_MAX_STRING = 60; // characters kept from a string prop

  /**
   * One prop value as a short display string.
   *
   * serialize() above is for console arguments and has a different job: it
   * keeps stacks, walks whole object graphs and detects cycles. A prop list
   * wants one readable line per key, so nothing is expanded here.
   */
  function summariseValue(value) {
    try {
      if (typeof value === 'string') {
        const clipped =
          value.length > PROP_MAX_STRING ? value.slice(0, PROP_MAX_STRING) + '…' : value;
        // JSON.stringify quotes and escapes newlines, which is what keeps a
        // multi-line string prop on one line of the prompt.
        return JSON.stringify(clipped);
      }
      if (typeof value === 'function') {
        return value.name ? 'ƒ ' + value.name : 'ƒ';
      }
      if (value === null || value === undefined || typeof value !== 'object') {
        return String(value);
      }
      if (value.$$typeof) {
        const type = value.type;
        const label = typeof type === 'string' ? type : nameOf(type);
        return '<' + (label || 'Element') + ' />';
      }
      if (Array.isArray(value)) return 'Array(' + value.length + ')';
      return '{…}';
    } catch {
      return '{…}';
    }
  }

  /**
   * Prop names whose value must never be copied out of the application.
   *
   * This is the one place in the extension that reads live application state
   * rather than what is on the screen, and the value goes into the prompt and
   * into chrome.storage.local with it. A password, a bearer token or a card
   * number sitting in a prop would otherwise be captured whole and pasted
   * somewhere else entirely.
   *
   * The key is still reported, because knowing the prop exists is most of its
   * debugging value and the value rarely is. Deliberately over-broad: a
   * needlessly redacted prop costs one line, and the other kind of mistake
   * cannot be taken back.
   */
  const SECRET_KEY =
    /pass|secret|token|auth|jwt|cookie|session|credential|apikey|api_key|email|phone|card|cvv|ssn|iban|account|address|dob|birth/i;

  function summariseProps(props) {
    const out = [];
    try {
      if (!props || typeof props !== 'object') return out;
      for (const key of Object.keys(props)) {
        if (out.length >= PROP_LIMIT) break;
        // children is the subtree the user can already see, not a setting.
        if (key === 'children') continue;
        let value;
        try {
          // A prop can be a getter, and on a Vue reactive proxy reading one
          // runs framework code.
          value = props[key];
        } catch {
          continue;
        }
        out.push(key + '=' + (SECRET_KEY.test(key) ? '<redacted>' : summariseValue(value)));
      }
    } catch {
      /* ignore */
    }
    return out;
  }

  /**
   * Name a fiber by its type, never by its tag. React renumbered the tag table
   * inside 16.x (FunctionComponent was 1 and ClassComponent 2 before that), so
   * the same number means different things in two builds that both call
   * themselves React 16. The shapes below have been stable since.
   *
   * Returns null for anything with no useful name, including host elements,
   * symbols such as Fragment, context objects and an unresolved lazy.
   */
  /** A name only when it really is a non-empty string. */
  function text(value) {
    return typeof value === 'string' && value ? value : null;
  }

  function nameOf(type, depth) {
    try {
      const level = depth || 0;
      // memo(forwardRef(fn)) nests, and an object that referenced itself would
      // otherwise recurse forever.
      if (!type || level > 5) return null;
      if (typeof type === 'string') return null; // a host element: div, span
      // Guarded rather than returned raw: displayName is whatever the page
      // assigned, and a Symbol there would make the whole reply un-clonable,
      // so the picker would sit out its timeout for every pick on that page.
      if (typeof type === 'function') return text(type.displayName) || text(type.name);
      if (typeof type !== 'object') return null; // a symbol
      if (typeof type.render === 'function') {
        return (
          text(type.displayName) || text(type.render.displayName) || text(type.render.name)
        );
      }
      if (type.type) return text(type.displayName) || nameOf(type.type, level + 1);
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Find the nearest node React knows about, counting the steps taken.
   *
   * The climb is not decoration. A node produced by dangerouslySetInnerHTML, or
   * by a script the page runs itself, has no fiber of its own, and the user can
   * click one.
   *
   * React has an unreleased enableInternalInstanceMap flag that moves the fiber
   * off the node into a private WeakMap for production builds. When that ships
   * there will be nothing here to read, and returning null is the correct
   * degradation: no component reported, rather than a wrong one.
   */
  function fiberOf(node) {
    let element = node;
    let hops = 0;
    while (element && hops < CLIMB_LIMIT) {
      let keys;
      try {
        keys = Object.getOwnPropertyNames(element);
      } catch {
        keys = [];
      }
      for (const key of keys) {
        if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
          const fiber = element[key];
          if (fiber && typeof fiber.tag === 'number') return { fiber, hops };
        }
      }
      element = element.parentElement;
      hops += 1;
    }
    return null;
  }

  /**
   * Turn a path out of a stack frame or _debugSource into something worth
   * printing. Vite serves modules over http with a ?t=<timestamp> cache buster,
   * and Next.js reports webpack-internal URLs.
   */
  function cleanPath(raw) {
    try {
      let path = String(raw);
      if (path.startsWith('(')) path = path.slice(1);
      const query = path.indexOf('?');
      if (query > 0) path = path.slice(0, query);
      if (/^https?:\/\//.test(path)) {
        try {
          return new URL(path).pathname;
        } catch {
          return path;
        }
      }
      if (path.startsWith('webpack-internal:')) {
        const tail = path
          .replace(/^webpack-internal:\/{0,3}/, '')
          .replace(/^\([^)]*\)\//, '')
          .replace(/^\.\//, '');
        return tail || path;
      }
      return path;
    } catch {
      return '';
    }
  }

  // Frames belonging to React's own element factories. The JSX written by the
  // developer is the first frame below them.
  const STACK_NOISE =
    /jsx-dev-runtime|jsx-runtime|jsxDEV|createElement|react\.development|react-stack-top-frame/;
  const STACK_BOTTOM = /react[-_]stack[-_]bottom[-_]frame/;
  const STACK_FRAME = /(\S+?):(\d+):(\d+)\)?$/;

  /**
   * Where this node's JSX is written, which is the file of whoever rendered it
   * and not the file the component itself is defined in.
   *
   * React 16 to 18 record it as _debugSource. React 19.0 records nothing at
   * all. React 19.1 and later keep _debugStack, an Error constructed inside
   * jsxDEV whose trace has the answer a few frames down.
   */
  function sourceOf(fiber) {
    try {
      const source = fiber._debugSource;
      if (source && source.fileName) {
        const path = cleanPath(source.fileName);
        if (!path) return null;
        if (!source.lineNumber) return path;
        const column = source.columnNumber ? ':' + source.columnNumber : '';
        return path + ':' + source.lineNumber + column;
      }

      const stack = fiber._debugStack;
      if (!stack) return null;
      let text;
      try {
        // A page is free to install Error.prepareStackTrace, so reading .stack
        // can run page code that throws or hands back something else entirely.
        text = typeof stack === 'string' ? stack : stack.stack;
      } catch {
        return null;
      }
      if (typeof text !== 'string') return null;

      // Line 0 is the "Error: react-stack-top-frame" header and line 1 is the
      // factory React built the Error inside, so neither can be the answer. The
      // denylist below is still needed for the frames after them, but skipping
      // these two outright means a factory frame that is anonymous, or minified
      // into a generically named chunk, cannot slip past it and be reported as
      // the developer's own file.
      const lines = text.split('\n').slice(2);
      for (const line of lines) {
        if (STACK_BOTTOM.test(line)) break;
        if (STACK_NOISE.test(line)) continue;
        const frame = line.match(STACK_FRAME);
        if (!frame) continue;
        const path = cleanPath(frame[1]);
        // Something that looks like a file. A frame can be "at <anonymous>:1:1"
        // or "at eval:3:9", and pointing a reader at that is worse than saying
        // nothing, because the rest of the line claims it is where to look.
        if (!path || !/[/.]/.test(path)) continue;
        return path + ':' + frame[2] + ':' + frame[3];
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * React.
   *
   * __reactFiber$ can point at the alternate fiber rather than the one that is
   * currently mounted. The two alternates share a type and a return chain, so
   * the names are stable either way, but memoizedProps can be one commit old.
   */
  /**
   * Add a name to the chain, folding away the repeats React's own wrappers make.
   *
   * Two of them, and neither is cosmetic: only five names are kept, so a repeat
   * costs a real ancestor further up.
   *
   *   memo(Thing) and forwardRef(Thing) each add a fiber of their own carrying
   *   the same name, so the chain reads "Thing > Thing".
   *
   *   A context Provider is named after its context, so a library that calls
   *   both the context and the component TooltipProvider renders as
   *   "TooltipProviderProvider > TooltipProvider". The component is the one
   *   worth keeping, since it is the one written in the source.
   */
  function pushName(names, name) {
    const last = names[names.length - 1];
    if (last === name) return;
    if (last === name + 'Provider' || last === name + 'Context') {
      names[names.length - 1] = name;
      return;
    }
    names.push(name);
  }

  function reactSummary(node) {
    const found = fiberOf(node);
    if (!found) return null;
    const host = found.fiber;

    // Computed before the walk, because in a production build most of what the
    // walk finds is the bundler's naming rather than the author's.
    const development = '_debugOwner' in host;

    const names = [];
    let owning = null; // the nearest named fiber, whose props are reported
    let nearest = null; // what that fiber is called, even if a bundler named it
    let minified = 0; // named components the walk passed over as bundler output
    let fiber = host;
    let steps = 0;
    while (fiber && names.length < NAME_LIMIT && steps < CLIMB_LIMIT) {
      steps += 1;
      const name = nameOf(fiber.type);
      if (name) {
        const bundlerName = !development && name.length <= 2;
        if (!owning) {
          // The picked component's own name is kept whatever it is. Even a
          // bundler's `A` is worth printing, because it is the string React
          // DevTools shows for the same component and the reader may be
          // looking at both.
          owning = fiber;
          nearest = bundlerName ? name : null;
          pushName(names, name);
        } else if (bundlerName) {
          // An ancestor's bundler name is worse than no name: it cannot be
          // searched for in the source, and it spends one of the five slots a
          // real name further up could have used. Only ever applied to a
          // production build, where a name the minifier kept is three
          // characters or more anyway (App and Nav are real; A and tN are not).
          minified += 1;
        } else {
          pushName(names, name);
        }
      }
      fiber = fiber.return;
    }
    if (!names.length) return null;

    const summary = {
      framework: 'react',
      // The DEV FiberNode constructor defines every _debug* field on every
      // fiber and production defines none, so the presence of the key is the
      // test even when the value is null. __REACT_DEVTOOLS_GLOBAL_HOOK__ is
      // not: it is there whenever the extension is installed and says nothing
      // about which build the page shipped.
      build: development ? 'development' : 'production',
      names,
      hops: found.hops,
    };

    if (minified) summary.minified = minified;
    // Says that names[0] is the bundler's invention rather than a name that
    // appears anywhere in the source, which changes what the reader should do
    // with it: correlate it with React DevTools, do not grep for it.
    if (nearest) summary.renamed = true;

    try {
      // Read from the HOST fiber, and do not go looking for the owner in the
      // return chain. An element held in context, in a ref or in module scope
      // is rendered somewhere its author never appears as a parent, and after a
      // re-render the chain can reach owner.alternate instead of owner itself.
      const owner = host._debugOwner;
      if (owner) {
        // React 19 records a server component's owner as a ReactComponentInfo,
        // which carries a name and no tag.
        const name = typeof owner.tag === 'number' ? nameOf(owner.type) : owner.name;
        if (name && typeof name === 'string' && name !== names[0]) summary.owner = name;
      }
    } catch {
      /* ignore */
    }

    const source = sourceOf(host);
    if (source) summary.source = source;

    const props = summariseProps(owning.memoizedProps);
    if (props.length) summary.props = props;

    return summary;
  }

  // --------------------------------------------------------------- handlers --
  // React keeps a host element's own props, onClick included, on the DOM node
  // itself as a __reactProps$<random> expando, in a production build as well
  // as a development one, because event dispatch reads them back from there.
  //
  // That makes a handler name the most precise thing this whole file can
  // offer. Everything else it reports is a component name or a file the reader
  // then has to search; a handler name is the identifier they are looking for.

  const HANDLER_LIMIT = 6; // handler props reported
  const STARTS_MAX = 120; // characters kept from a handler body
  const LABEL_CLASSES = 2; // classes kept in an ancestor's label
  const HANDLER_PROP = /^on[A-Z]/;
  // Whose body is worth printing, most specific first. A node often carries
  // several, and onMouseEnter is rarely the one the user clicked for.
  const STARTS_PREFERENCE = ['onClick', 'onChange', 'onSubmit'];

  /** tag plus a class or two, enough to recognise which ancestor this was. */
  function elementLabel(element) {
    try {
      const tag = element.tagName ? element.tagName.toLowerCase() : '';
      const classes = [];
      const names = element.classList;
      for (let i = 0; names && i < names.length && classes.length < LABEL_CLASSES; i += 1) {
        const name = names[i];
        if (typeof name === 'string' && name) classes.push(name.slice(0, 40));
      }
      return classes.length ? tag + '.' + classes.join('.') : tag;
    } catch {
      return '';
    }
  }

  /**
   * The first statements of a handler, as something to search the source for.
   *
   * Whether the text is worth printing is decided further down by the text
   * itself rather than by the build label, because a minified body is
   * worthless as a search target however the build describes itself.
   */
  function handlerStarts(fn) {
    try {
      // The page is free to replace Function.prototype.toString.
      const source = String(fn);

      // The body starts at the first '{' or '=>' outside the parameter list,
      // which is not the same as the first one in the string: a default
      // parameter can hold braces of its own, as in (event = {}) => ….
      let depth = 0;
      let cut = -1;
      let arrow = false;
      for (let i = 0; i < source.length; i += 1) {
        const char = source[i];
        if (char === '(') depth += 1;
        else if (char === ')') depth -= 1;
        else if (depth === 0) {
          if (char === '=' && source[i + 1] === '>') {
            cut = i + 2;
            arrow = true;
            break;
          }
          if (char === '{') {
            cut = i + 1;
            break;
          }
        }
      }
      if (cut < 0) return '';

      let body = source.slice(cut).trimStart();
      // A block bodied arrow opens with its brace here. A concise one,
      // `event => send(event)`, has none and is already the body.
      if (arrow && body.startsWith('{')) body = body.slice(1);

      // Comments go before whitespace is collapsed, never after: a line
      // comment ends at its newline, and collapsing first would swallow that
      // newline and take the rest of the handler into the comment with it.
      // Development source opens with a comment often enough to matter, and
      // more than one of them in a row is common.
      for (let i = 0; i < 4; i += 1) {
        body = body.trimStart();
        if (body.startsWith('//')) {
          const end = body.indexOf('\n');
          if (end < 0) return '';
          body = body.slice(end + 1);
        } else if (body.startsWith('/*')) {
          const end = body.indexOf('*/');
          if (end < 0) return '';
          body = body.slice(end + 2);
        } else {
          break;
        }
      }

      // Comments are stripped wherever they fall, not only at the front. The
      // loop above handles a body that opens with one; this handles a body
      // whose second statement is followed by one, which on the React fixture
      // spent most of the budget on two lines of prose about why a promise is
      // not awaited. Line comments must go before the newlines are collapsed,
      // for the same reason as above.
      // The function's own closing brace is not one of its statements.
      const text = body
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\s*\}$/, '')
        .trim();
      // A bound method stringifies to "function () { [native code] }", and
      // there is nothing behind it to read.
      if (!text || text.includes('[native code]')) return '';
      // PRIVACY: a handler body can hold a hardcoded key, token or account
      // number, and this text goes into the prompt and into storage with it.
      // Same rule as the props above, except that here there is no key whose
      // value can be replaced: a secret in a statement has no boundary this
      // code could find, so the whole text is dropped rather than masked in
      // part. A needlessly dropped hint costs one line of the prompt.
      // Whether the source is worth printing is a question about the text,
      // not about the build label, and the text can answer it. Minified code
      // has nothing but one and two character identifiers, so a run of four
      // or more letters means the author's own names survived. This replaces
      // gating on a development build, which was both too strict (Vue's
      // development bundle sets no build flag the collector can read, so a
      // perfectly readable handler was dropped) and too loose (a production
      // build with keepNames has real names over a minified body).
      if (!/[A-Za-z_$]{4,}/.test(text)) return '';
      if (SECRET_KEY.test(text)) return '';
      // The keyword test above only catches a secret that happens to sit next
      // to a telling word. A bearer token pasted into a headers object has no
      // such word near it, so this second test is on the shape of the value:
      // any quoted run of 20 or more characters with nothing but token
      // characters in it. Anything that long is either a credential or a
      // string too unwieldy to be a useful grep target, so dropping it costs
      // the reader nothing in either case.
      if (/(['"`])[A-Za-z0-9_\-.]{20,}\1/.test(text)) return '';
      return text.length > STARTS_MAX ? text.slice(0, STARTS_MAX) + '…' : text;
    } catch {
      return '';
    }
  }

  /**
   * One handler as "onClick=ƒ handleApply", matching the props format above.
   *
   * A name equal to the prop name is dropped rather than repeated. JSX
   * compiles to an object literal, so `onChange={(event) => …}` reaches this
   * file as a function JavaScript's own name inference has already called
   * onChange. Nobody wrote that name and nobody can search for it, so
   * "onChange=ƒ" is the honest report: this handler is written inline.
   */
  function handlerLabel(entry) {
    try {
      if (entry.fn.name === entry.key) return entry.key + '=ƒ';
    } catch {
      /* ignore */
    }
    return entry.key + '=' + summariseValue(entry.fn);
  }

  /** The on* props of one React props object that are actually functions. */
  function handlerProps(props) {
    const found = [];
    try {
      for (const key of Object.keys(props)) {
        if (found.length >= HANDLER_LIMIT) break;
        if (!HANDLER_PROP.test(key)) continue;
        let value;
        try {
          value = props[key];
        } catch {
          continue;
        }
        // Only a function counts. A prop left at undefined, which is what
        // onClick={enabled ? submit : undefined} leaves behind, would
        // otherwise end the climb at a node with nothing to report and hide
        // the real handler on an ancestor.
        if (typeof value !== 'function') continue;
        found.push({ key, fn: value });
      }
    } catch {
      /* ignore */
    }
    return found;
  }

  /**
   * The nearest handlers at or above the picked node.
   *
   * The climb is here for the same reason fiberOf()'s is, only more so: a
   * click lands on the <span> inside the <button>, and the handler is on the
   * button. Reporting how far up it was found is what lets the reader tell
   * "this element" from "something wrapping it".
   */
  function handlersOf(node) {
    try {
      let element = node;
      let hops = 0;
      while (element && hops < CLIMB_LIMIT) {
        let keys;
        try {
          keys = Object.getOwnPropertyNames(element);
        } catch {
          keys = [];
        }

        let found = [];
        for (const key of keys) {
          // React 16 calls the same object __reactEventHandlers$, which is the
          // version pairing fiberOf() reads __reactInternalInstance$ for.
          if (!key.startsWith('__reactProps$') && !key.startsWith('__reactEventHandlers$')) {
            continue;
          }
          let props;
          try {
            props = element[key];
          } catch {
            continue;
          }
          if (props && typeof props === 'object') found = handlerProps(props);
          if (found.length) break;
        }

        // Vue puts the element's own props on its vnode under the same on*
        // names React uses, so the same reader works once it is pointed at
        // __vnode. It is defined with the same guard as __vueParentComponent,
        // so a plain production build has neither and this yields nothing.
        if (!found.length) {
          try {
            const vnode = element.__vnode;
            if (vnode && vnode.props && typeof vnode.props === 'object') {
              found = handlerProps(vnode.props);
            }
          } catch {
            /* ignore */
          }
        }

        if (found.length) {
          const handlers = {
            hops,
            label: hops ? elementLabel(element) : '',
            list: found.map(handlerLabel),
            starts: '',
            startsOf: '',
          };
          {
            let primary = null;
            for (const name of STARTS_PREFERENCE) {
              primary = found.find((entry) => entry.key === name);
              if (primary) break;
            }
            if (!primary) primary = found[0];
            const starts = handlerStarts(primary.fn);
            if (starts) {
              handlers.starts = starts;
              handlers.startsOf = primary.key;
            }
          }
          return handlers;
        }

        element = element.parentElement;
        hops += 1;
      }
      return null;
    } catch {
      return null;
    }
  }

  function vueName(type) {
    try {
      if (!type) return null;
      if (typeof type.name === 'string' && type.name) return type.name;
      // Single file components compiled by the Vue plugin carry __name, which
      // survives a production build where the options name does not exist.
      if (typeof type.__name === 'string' && type.__name) return type.__name;
      if (typeof type.__file !== 'string' || !type.__file) return null;
      const base = type.__file.split(/[\\/]/).pop() || '';
      const dot = base.lastIndexOf('.');
      return (dot > 0 ? base.slice(0, dot) : base) || null;
    } catch {
      return null;
    }
  }

  /**
   * Vue 3.
   *
   * __vueParentComponent is installed with Object.defineProperty and is not
   * enumerable, so the key scan the React side does would never see it. Vue
   * also only sets it under __DEV__ or __FEATURE_PROD_DEVTOOLS__, so a plain
   * production build offers nothing and null is the honest answer.
   */
  function vueSummary(node) {
    let element = node;
    let hops = 0;
    let instance = null;
    while (element && hops < CLIMB_LIMIT) {
      // __vnode.ctx before __vueParentComponent, and the difference only shows
      // up in slot content. For `<Card><b>hi</b></Card>`, the <b> is passed to
      // Card but written in the template of whoever used Card, and
      // __vueParentComponent names Card. Reporting Card would send a reader to
      // the wrong file, which is the one thing this feature exists to avoid.
      // ctx is the instance that was rendering when the vnode was created,
      // which is the file the element is actually in.
      let candidate = null;
      try {
        const ctx = element.__vnode && element.__vnode.ctx;
        if (ctx && ctx.type) candidate = ctx;
      } catch {
        /* ignore */
      }
      if (!candidate && element.__vueParentComponent && element.__vueParentComponent.type) {
        candidate = element.__vueParentComponent;
      }
      if (candidate) {
        instance = candidate;
        break;
      }
      element = element.parentElement;
      hops += 1;
    }
    if (!instance) return null;

    const names = [];
    let named = null; // the instance that gave names[0]
    let current = instance;
    let steps = 0;
    while (current && names.length < NAME_LIMIT && steps < CLIMB_LIMIT) {
      steps += 1;
      const name = vueName(current.type);
      if (name) {
        if (!named) named = current;
        names.push(name);
      }
      current = current.parent;
    }
    if (!named) return null;

    const summary = {
      framework: 'vue',
      names,
      hops,
    };

    // Vue cannot be asked which build it is, only which build it is not.
    //
    // __vueParentComponent is set under __DEV__ *or* __FEATURE_PROD_DEVTOOLS__,
    // so reaching this line already rules out a plain production build. It does
    // not tell development and production-with-devtools apart. __hmrId narrows
    // it one way: the SFC compiler stamps it, so its presence is a bundler's
    // development build for certain, while its absence proves nothing (Vue's
    // own vue.global.js development bundle has no HMR ids either, and reporting
    // that page as production was simply wrong).
    //
    // So the field is claimed only when it is known, and the prompt says
    // nothing about the build when it is not. Unlike React, Vue's names survive
    // minification anyway: they are author-written strings in the component
    // options, not function identifiers.
    try {
      if ('__hmrId' in named.type) summary.build = 'development';
    } catch {
      /* ignore */
    }

    try {
      if (typeof named.type.__file === 'string' && named.type.__file) {
        summary.source = named.type.__file;
      }
    } catch {
      /* ignore */
    }

    const props = summariseProps(named.props);
    if (props.length) summary.props = props;

    try {
      const version = named.appContext && named.appContext.app && named.appContext.app.version;
      if (typeof version === 'string' && version) summary.version = version;
    } catch {
      /* ignore */
    }

    return summary;
  }

  function inspect(marker) {
    try {
      if (typeof marker !== 'string' || !marker) return null;

      // The picker generates a [a-z0-9] marker, so this is normally a no-op.
      // It is done anyway because the value arrives over postMessage and any
      // script on the page can send one.
      let value = null;
      if (/^[\w-]+$/.test(marker)) {
        value = marker;
      } else if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
        value = CSS.escape(marker);
      }
      if (value === null) return null;

      const node = document.querySelector('[data-cdr-pick="' + value + '"]');
      if (!node) return null;

      // Removed before any other work. Anything below can throw, and an
      // exception must not leave the extension's attribute on the user's page.
      node.removeAttribute('data-cdr-pick');

      const component = reactSummary(node) || vueSummary(node);
      // Which build this is was decided from the fiber by reactSummary(), so
      // the fiber is not looked up a second time to ask again. No component
      // means no handler bodies are read, which is the same outcome as a
      // production build and the same reason: nothing worth grepping for.
      const handlers = handlersOf(node);

      // Two answers to one pick, so both travel under one object. Either can
      // be null.
      //
      // The shape change is safe in one direction only, which is the direction
      // that matters here. The picker rebuilds every reply from scratch and
      // keeps only fields it knows about, so an OLD picker handed this NEW
      // object finds no `names` on it and rejects the whole thing: the pick
      // still produces a capture, with no component reported. The other
      // direction, a NEW picker on a tab still running an OLD collector after
      // an extension reload, is the picker's to handle, since nothing in this
      // file is running there.
      return { component, handlers };
    } catch {
      return null;
    }
  }

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

    // Branch on the action rather than treating everything that is not 'clear'
    // as a request for the snapshot. Reloading the extension leaves this script
    // running in tabs that are already open while a newly injected picker talks
    // to it, so an action this build has never heard of has to answer null. The
    // alternative hands the picker a console snapshot and lets it present the
    // result as a component.
    let payload = null;
    if (data.action === 'snapshot') {
      payload = snapshot();
    } else if (data.action === 'clear') {
      buffers.console.length = 0;
      buffers.errors.length = 0;
      buffers.network.length = 0;
    } else if (data.action === 'inspect') {
      payload = inspect(data.marker);
    }

    try {
      window.postMessage({ __cdr: 'response', id: data.id, payload }, '*');
    } catch {
      // Structured clone refused the payload. The caller is waiting on this id
      // and would otherwise sit out its whole timeout, so it gets an empty
      // answer instead.
      try {
        window.postMessage({ __cdr: 'response', id: data.id, payload: null }, '*');
      } catch {
        /* ignore */
      }
    }
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
