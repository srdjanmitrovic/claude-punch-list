/**
 * Element picker, injected on demand by background.js.
 *
 * Unlike overlay.js this does NOT put a click-catcher over the page, because a
 * catcher would become the answer to every elementFromPoint() query. Instead
 * the highlight box is pointer-events:none and the page's own mouse events are
 * suppressed with capture-phase listeners on window, which run before almost
 * anything the page registered.
 */
(() => {
  'use strict';

  /**
   * Which computed styles end up in the prompt.
   *
   * getComputedStyle returns ~340 properties. Dumping all of them buries the
   * signal and wastes Claude Code's context, so this is a deliberate shortlist
   * aimed at the bugs that actually show up in a screenshot: box model, layout
   * mode, stacking, overflow, and typography.
   *
   * TUNE THIS. If you mostly debug grid layouts, add grid-template-areas and
   * grid-auto-flow. If you fight z-index and sticky headers, add inset and
   * will-change. Properties whose value equals the CSS initial value are
   * filtered out below, so a longer list costs less than it looks.
   */
  const STYLE_PROPERTIES = [
    'display',
    'position',
    'inset',
    'width',
    'height',
    'max-width',
    'padding',
    'margin',
    'box-sizing',
    'flex-direction',
    'flex-wrap',
    'justify-content',
    'align-items',
    'gap',
    'grid-template-columns',
    'overflow',
    'z-index',
    'opacity',
    'visibility',
    'transform',
    'color',
    'background-color',
    'font-family',
    'font-size',
    'font-weight',
    'line-height',
    'text-align',
    'white-space',
    'border',
    'border-radius',
  ];

  // Values that carry no information whatever the property: reporting
  // `transform: none` on every element is noise.
  const UNINTERESTING = new Set([
    'none',
    'normal',
    'auto',
    'visible',
    '0px',
    'rgba(0, 0, 0, 0)',
    'static',
    '0px 0px 0px 0px',
  ]);

  /**
   * Per property initial values.
   *
   * The set above cannot catch these, because the same string is meaningful
   * elsewhere: `row` says nothing as a flex-direction but everything as a
   * grid-auto-flow, and `1` is a default opacity but never a default z-index.
   * Without this, every single element reports flex-direction, flex-wrap,
   * opacity and text-align, which is four lines of noise per capture.
   */
  const INITIAL_VALUE = {
    'flex-direction': 'row',
    'flex-wrap': 'nowrap',
    'justify-content': 'normal',
    'align-items': 'normal',
    opacity: '1',
    'text-align': 'start',
    'box-sizing': 'content-box',
    'font-weight': '400',
  };

  const MAX_HTML = 1600;

  function createController() {
    let host = null;
    let shadow = null;
    let box = null;
    let tag = null;
    let active = false;
    let current = null;

    const INSPECT_TIMEOUT_MS = 300;
    const pending = new Map();
    // Bumped by stop(). A pick that was cancelled while its inspect was still
    // in flight must not arrive afterwards as a capture.
    let generation = 0;
    // A page with no MAIN world collector never answers, and there is no point
    // making every subsequent pick on that tab wait out the timeout again. This
    // is the case after the extension is reloaded, because Chrome does not
    // re-inject declared content scripts into tabs that are already open.
    //
    // Cleared by start(), so this remembers a silent page rather than latching
    // on one slow answer. A single round trip that lost a race to a busy main
    // thread would otherwise turn the feature off for the life of the page.
    let mainWorldSilent = false;

    /**
     * Replies from the MAIN world collector.
     *
     * Registered once, when the controller is created, rather than in start():
     * start() runs again on every arm and would stack a listener per arm.
     *
     * collector-bridge.js listens for the same responses on this same window.
     * Its ids are numbers and these are strings, and a Map keys on
     * SameValueZero, so 1 and '1' can never collide: each side looks up the
     * other's id, finds nothing, and ignores the reply.
     */
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.__cdr !== 'response') return;
      const resolve = pending.get(data.id);
      if (!resolve) return;
      pending.delete(data.id);
      resolve(data.payload);
    });

    /**
     * Rebuild a reply from scratch, keeping only what the contract allows.
     *
     * Nothing that arrives here is trustworthy. The request is broadcast with
     * window.postMessage, so on a tab with no collector (one open from before
     * the extension was installed or reloaded) the page's own scripts are the
     * only listeners, and any of them can answer. Whatever comes back is
     * printed into a prompt the user pastes into Claude Code, so adopting the
     * object wholesale would let a page choose its own fields, nest objects the
     * template will stringify, or hand over an array of a million entries.
     *
     * Rebuilding rather than validating is the point: a field this version does
     * not know about cannot survive, whatever a future reply carries.
     */
    function adopt(payload) {
      if (!payload || typeof payload !== 'object') return null;

      const strings = (value, limit) =>
        (Array.isArray(value) ? value : [])
          .filter((entry) => typeof entry === 'string')
          .slice(0, limit)
          .map((entry) => entry.slice(0, 200));

      const names = strings(payload.names, 5);
      if (!names.length) return null;

      const component = {
        framework: payload.framework === 'vue' ? 'vue' : 'react',
        names,
        hops: Number.isFinite(payload.hops) && payload.hops > 0 ? Math.floor(payload.hops) : 0,
      };
      // Left absent rather than defaulted. The template says "development
      // build" only when this build said so, because that claim is what tells
      // a reader the names are the ones in their source.
      if (payload.build === 'development' || payload.build === 'production') {
        component.build = payload.build;
      }
      for (const key of ['owner', 'source', 'version']) {
        if (typeof payload[key] === 'string' && payload[key]) {
          component[key] = payload[key].slice(0, 200);
        }
      }
      if (Number.isFinite(payload.minified) && payload.minified > 0) {
        component.minified = Math.floor(payload.minified);
      }
      if (payload.renamed === true) component.renamed = true;
      const props = strings(payload.props, 12);
      if (props.length) component.props = props;

      return component;
    }

    /**
     * Ask the MAIN world which React or Vue component rendered this node.
     *
     * The picker runs in the ISOLATED world, where React's __reactFiber$ and
     * Vue's __vueParentComponent are invisible: expando properties live on each
     * world's own wrapper of a node. The DOM itself is shared, which is why the
     * node is handed over as an attribute rather than in the message.
     *
     * Resolves to null on timeout rather than hanging, so a page where the MAIN
     * script never ran still produces a capture.
     */
    function inspect(element) {
      if (mainWorldSilent) return Promise.resolve(null);
      return new Promise((resolve) => {
        // Random so that a marker left behind by an earlier pick that never
        // settled cannot be matched by this one. Not a security boundary.
        const marker = 'pick' + Math.random().toString(36).slice(2);
        let settled = false;

        function finish(component) {
          if (settled) return;
          settled = true;
          pending.delete(marker);
          // Idempotent: the MAIN world removes it too, and this is what covers
          // the timeout path, where nobody over there ever saw the node.
          element.removeAttribute('data-cdr-pick');
          resolve(component);
        }

        pending.set(marker, (payload) => finish(adopt(payload)));

        element.setAttribute('data-cdr-pick', marker);
        window.postMessage({ __cdr: 'request', id: marker, action: 'inspect', marker }, '*');
        setTimeout(() => {
          if (!settled) mainWorldSilent = true;
          finish(null);
        }, INSPECT_TIMEOUT_MS);
      });
    }

    function build() {
      host = document.createElement('div');
      host.setAttribute('data-cdr-picker', '');
      host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;margin:0;padding:0;border:0';

      shadow = host.attachShadow({ mode: 'closed' });
      shadow.innerHTML = `
        <style>
          :host { all: initial; }
          .box {
            position: fixed;
            border: 2px solid #d6157f;
            background: rgba(214, 21, 127, 0.12);
            pointer-events: none;
            display: none;
            border-radius: 2px;
            transition: all 60ms ease-out;
          }
          .tag {
            position: fixed;
            font: 600 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
            color: #fff;
            background: #d6157f;
            padding: 4px 7px;
            border-radius: 3px;
            display: none;
            pointer-events: none;
            white-space: nowrap;
            max-width: 60vw;
            overflow: hidden;
            text-overflow: ellipsis;
          }
          .hint {
            position: fixed;
            left: 50%;
            top: 20px;
            transform: translateX(-50%);
            font: 500 12px/1 ui-sans-serif, system-ui, -apple-system, sans-serif;
            color: #f5f5f4;
            background: rgba(20, 22, 28, 0.92);
            padding: 8px 14px;
            border-radius: 999px;
            pointer-events: none;
            box-shadow: 0 4px 16px rgba(0,0,0,0.35);
          }
          .hint b { color: #f7a8cf; font-weight: 600; }
        </style>
        <div class="box"></div>
        <div class="tag"></div>
        <div class="hint">Click an element to capture it &nbsp;·&nbsp; <b>Esc</b> to cancel</div>
      `;

      box = shadow.querySelector('.box');
      tag = shadow.querySelector('.tag');
    }

    function describe(element) {
      let text = element.tagName.toLowerCase();
      if (element.id) text += '#' + element.id;
      const classes = Array.from(element.classList).slice(0, 2);
      if (classes.length) text += '.' + classes.join('.');
      if (element.classList.length > 2) text += `.…+${element.classList.length - 2}`;
      const r = element.getBoundingClientRect();
      return `${text}  ${Math.round(r.width)}×${Math.round(r.height)}`;
    }

    function highlight(element) {
      current = element;
      const r = element.getBoundingClientRect();
      box.style.display = 'block';
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      box.style.width = r.width + 'px';
      box.style.height = r.height + 'px';

      tag.style.display = 'block';
      tag.textContent = describe(element);
      const above = r.top - 26;
      tag.style.top = (above < 4 ? Math.min(r.bottom + 6, window.innerHeight - 26) : above) + 'px';
      tag.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 200)) + 'px';
    }

    /**
     * Build a selector specific enough to find the element again.
     *
     * Stops at body: `html > body >` prefixes every path on every page and
     * helps nobody locate the code behind an element.
     */
    function cssPath(element) {
      const parts = [];
      let node = element;
      while (
        node &&
        node.nodeType === 1 &&
        node !== document.body &&
        node !== document.documentElement &&
        parts.length < 6
      ) {
        if (node.id) {
          try {
            if (document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
              parts.unshift('#' + CSS.escape(node.id));
              break;
            }
          } catch {
            /* exotic id, fall through to the class/index path */
          }
        }
        let part = node.tagName.toLowerCase();
        const classes = Array.from(node.classList)
          .filter((c) => c && !/^\d/.test(c))
          .slice(0, 3);
        if (classes.length) {
          part += '.' + classes.map((c) => CSS.escape(c)).join('.');
        }
        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
        parts.unshift(part);
        node = node.parentElement;
      }
      return parts.join(' > ');
    }

    /**
     * A deeply nested element's outerHTML can be hundreds of kilobytes. The
     * opening tag carries most of the debugging value (that is where classes,
     * data attributes and inline styles live), so it is always preserved and
     * only the children are cut.
     */
    function markup(element) {
      const full = element.outerHTML || '';
      if (full.length <= MAX_HTML) return { html: full, truncated: false };

      const openTagEnd = full.indexOf('>');
      const openTag = openTagEnd === -1 ? full.slice(0, 200) : full.slice(0, openTagEnd + 1);
      const budget = MAX_HTML - openTag.length - 60;
      const inner = (element.innerHTML || '').slice(0, Math.max(budget, 0));
      return {
        html: `${openTag}\n${inner}\n  <!-- …${element.children.length} child element(s), truncated -->\n</${element.tagName.toLowerCase()}>`,
        truncated: true,
      };
    }

    function styles(element) {
      const computed = getComputedStyle(element);
      const out = {};
      for (const property of STYLE_PROPERTIES) {
        const value = computed.getPropertyValue(property);
        if (!value) continue;
        const trimmed = value.trim();
        if (!trimmed || UNINTERESTING.has(trimmed)) continue;
        if (INITIAL_VALUE[property] === trimmed) continue;
        out[property] = trimmed;
      }
      return out;
    }

    function attributes(element) {
      const out = {};
      for (const attribute of Array.from(element.attributes || [])) {
        // data-cdr-pick is this extension's own, live only while a pick is in
        // flight. The payload is built before it is set, so this is belt and
        // braces against a page that re-serialises a subtree in that window.
        if (attribute.name === 'class' || attribute.name === 'style') continue;
        if (attribute.name === 'data-cdr-pick') continue;
        out[attribute.name] =
          attribute.value.length > 120 ? attribute.value.slice(0, 120) + '…' : attribute.value;
      }
      return out;
    }

    function onMouseMove(event) {
      const element = document.elementFromPoint(event.clientX, event.clientY);
      if (!element || element === current) return;
      if (element === document.documentElement || element === document.body) return;
      highlight(element);
    }

    function swallow(event) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    }

    function onClick(event) {
      swallow(event);
      if (!current) return;
      const element = current;
      const rect = element.getBoundingClientRect();

      const payload = {
        selector: cssPath(element),
        tagName: element.tagName.toLowerCase(),
        classes: Array.from(element.classList),
        attributes: attributes(element),
        inlineStyle: element.getAttribute('style') || '',
        text: (element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200),
        ...markup(element),
        styles: styles(element),
      };

      // Pad slightly so the element does not sit flush against the crop edge,
      // then clamp every edge before deriving the size. Clamping the origin
      // while keeping the element's full height would, for a card scrolled half
      // above the fold, produce a crop reaching far below the element and full
      // of unrelated content.
      const left = Math.max(0, rect.left - 4);
      const top = Math.max(0, rect.top - 4);
      const right = Math.min(window.innerWidth, rect.right + 4);
      const bottom = Math.min(window.innerHeight, rect.bottom + 4);

      const captureRect = {
        x: left,
        y: top,
        width: Math.max(1, right - left),
        height: Math.max(1, bottom - top),
      };

      const viewport = {
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
      };

      stop();

      // The marker attribute is set here, after the payload is built, because
      // attributes() and markup() read the live DOM and would otherwise print
      // data-cdr-pick into the user's prompt.
      const inspected = inspect(element);

      // Removing the highlight box only queues the change, and one frame does
      // not guarantee a paint has landed before the panel screenshots the tab,
      // hence two. The round trip runs alongside them, so its timeout is only
      // ever paid on a page where the MAIN world never answers at all.
      const painted = new Promise((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(resolve);
        });
      });

      // stop() ran above, so Escape is already unhooked; the panel's cancel
      // button is the route still open during the round trip. Without this the
      // cancelled pick would arrive anyway, and the panel would answer it with
      // a screenshot and a file on disk.
      const era = generation;
      Promise.all([inspected, painted]).then(([component]) => {
        if (era !== generation) return;
        if (component) payload.component = component;
        send({ type: 'cdr:element-picked', rect: captureRect, viewport, element: payload });
      });
    }

    function onKeyDown(event) {
      if (event.key !== 'Escape') return;
      swallow(event);
      stop();
      send({ type: 'cdr:capture-cancelled', mode: 'element' });
    }

    function send(message) {
      try {
        chrome.runtime.sendMessage(message).catch(() => {});
      } catch {
        /* extension context invalidated */
      }
    }

    function start() {
      if (active) return;
      // Mutually exclusive with the region overlay; see the matching comment
      // in overlay.js.
      try {
        window.__cdrRegionOverlay?.stop();
      } catch {
        /* ignore */
      }
      if (!host) build();
      active = true;
      current = null;
      mainWorldSilent = false;
      box.style.display = 'none';
      tag.style.display = 'none';
      shadow.querySelector('.hint').style.display = 'block';

      (document.body || document.documentElement).appendChild(host);

      window.addEventListener('mousemove', onMouseMove, true);
      window.addEventListener('click', onClick, true);
      window.addEventListener('mousedown', swallow, true);
      window.addEventListener('mouseup', swallow, true);
      window.addEventListener('keydown', onKeyDown, true);
    }

    function stop() {
      // Before the active guard, deliberately. onClick calls stop() itself and
      // then waits on the inspect round trip, so by the time the panel's cancel
      // button disarms the tab this controller is already inactive. Bumping
      // below the guard would make that call a no-op and let the cancelled pick
      // land anyway, as a capture and a PNG on disk.
      generation += 1;
      if (!active) return;
      active = false;
      window.removeEventListener('mousemove', onMouseMove, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('mousedown', swallow, true);
      window.removeEventListener('mouseup', swallow, true);
      window.removeEventListener('keydown', onKeyDown, true);
      if (host && host.parentNode) host.parentNode.removeChild(host);
    }

    return { start, stop };
  }

  if (!window.__cdrElementPicker) {
    window.__cdrElementPicker = createController();
  }
  window.__cdrElementPicker.start();
})();
