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
        if (attribute.name === 'class' || attribute.name === 'style') continue;
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

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          send({ type: 'cdr:element-picked', rect: captureRect, viewport, element: payload });
        });
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
