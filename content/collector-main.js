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

      return reactSummary(node) || vueSummary(node);
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
