/**
 * A host page as content/page-shot.js sees it, in a fresh node:vm realm: a
 * document that scrolls, elements with inline styles, computed positions and
 * boxes, inner scrollers, shadow roots, images that load when a test says so,
 * and the window events that end a run.
 *
 * Nothing is laid out. Each element is given its box, and the model moves it
 * as Chrome would for what page-shot.js does to it: scrolling moves every box
 * in that scroller, a sticky element stays pinned at the top of its scroller
 * until it is made relative, and a fixed element stays where the view puts
 * it. What a test here proves is what the script sets, restores and reports,
 * not what Chrome paints.
 *
 * Each behaviour modelled was seen in Chrome (the probes for the 0.7.0 design):
 *
 * * a plain scrollTo on a page with `scroll-behavior: smooth` has not moved
 *   right after the call, and one with behavior 'instant' has;
 * * mandatory scroll snapping moves a programmatic scroll to the nearest snap
 *   point (600 landed on 409), unless scroll-snap-type is none;
 * * setProperty with an empty value removes the property, and the last
 *   property removed leaves an empty style attribute behind;
 * * TreeWalker does not enter shadow roots; shadowRoot is null for a closed
 *   one, which only chrome.dom.openOrClosedShadowRoot hands an extension;
 * * a background tab runs no animation frames;
 * * Locomotive Scroll 4 in smooth mode locks the root and the body (overflow
 *   hidden) and moves its container, taller than the view, with an inline
 *   matrix3d() transform, which getComputedStyle gives in its 2D form:
 *   matrix(1, 0, 0, 1, 0, 0) at load, matrix(1, 0, 0, 1, 0, -192) once the
 *   wheel has moved it 192 px (Chrome for Testing 156).
 *
 * The clock is the panel realm's makeClock, so a test can run the panel and
 * the page on one timeline (panelAndPage does).
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadPanel } from './panel-realm.mjs';
import { makeClock } from './worker-realm.mjs';

const SOURCE = readFileSync(new URL('../../content/page-shot.js', import.meta.url), 'utf8');

/** What crosses executeScript: Chrome serialises each argument and the result. */
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

class StyleDeclaration {
  constructor(owner) {
    this.owner = owner;
    this.props = new Map();
  }
  setProperty(name, value, priority = '') {
    const text = String(value ?? '');
    if (text === '') {
      this.removeProperty(name);
      return;
    }
    this.props.set(name, { value: text, priority: priority === 'important' ? 'important' : '' });
    this.owner.hasStyle = true;
    this.owner.writes += 1;
  }
  getPropertyValue(name) {
    return this.props.get(name)?.value ?? '';
  }
  getPropertyPriority(name) {
    return this.props.get(name)?.priority ?? '';
  }
  removeProperty(name) {
    const old = this.getPropertyValue(name);
    if (this.props.delete(name)) this.owner.writes += 1;
    return old;
  }
  get cssText() {
    return [...this.props]
      .map(([name, { value, priority }]) => `${name}: ${value}${priority ? ' !important' : ''};`)
      .join(' ');
  }
}

class ShadowRoot {
  constructor(host, mode) {
    this.host = host;
    this.mode = mode;
    this.children = [];
  }
}

class PageElement {
  constructor(page, spec = {}) {
    this.page = page;
    this.id = spec.id || '';
    this.localName = spec.tag || 'div';
    this.style = new StyleDeclaration(this);
    this.hasStyle = false;
    this.writes = 0;
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    // The stylesheet's word for each computed property this model reads.
    this.sheet = {
      position: spec.position || 'static',
      overflowY: spec.overflowY || 'visible',
      backgroundColor: spec.background || 'rgba(0, 0, 0, 0)',
      scrollSnapType: spec.snap ? 'y mandatory' : 'none',
      // As getComputedStyle serialises it: 'none', or matrix() or matrix3d().
      transform: spec.transform || 'none',
    };
    // Attributes other than style, which the model keeps apart.
    this.attributes = { ...spec.attributes };
    // A <dialog> opened with showModal(), which :modal matches.
    this.modal = Boolean(spec.modal);
    // The border box, in the coordinates of whatever it is laid out in: the
    // view for a fixed element, otherwise the content of its scroller (the
    // document or an inner element), unscrolled.
    this.box = { x: 0, y: 0, width: 0, height: 0, ...spec.rect };
    this.stickyTop = spec.stickyTop ?? 0;
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.scrollHeight = spec.scroll?.height ?? this.box.height;
    this.scrollbar = spec.scroll?.scrollbar ?? (spec.scroll ? 15 : 0);
    this.snapPoints = spec.snapPoints || null;
    this.complete = spec.complete ?? true;
    this._shadow = null;
    for (const [name, value] of Object.entries(spec.style || {})) {
      const [text, priority] = Array.isArray(value) ? value : [value, ''];
      this.style.setProperty(name, text, priority);
    }
    this.writes = 0;
  }
  get clientWidth() {
    return Math.max(0, this.box.width - this.scrollbar);
  }
  get clientHeight() {
    return this.box.height;
  }
  get clientLeft() {
    return 0;
  }
  get clientTop() {
    return 0;
  }
  get shadowRoot() {
    return this._shadow?.mode === 'open' ? this._shadow : null;
  }
  attachShadow({ mode }) {
    this._shadow = new ShadowRoot(this, mode);
    return this._shadow;
  }
  getAttribute(name) {
    if (name === 'style') return this.hasStyle ? this.style.cssText : null;
    return Object.hasOwn(this.attributes, name) ? String(this.attributes[name]) : null;
  }
  /** Only :modal, the one selector page-shot.js asks an element about. */
  matches(selector) {
    if (selector !== ':modal') throw new Error(`the model knows no selector ${selector}`);
    return this.modal;
  }
  removeAttribute(name) {
    if (name !== 'style') return;
    this.hasStyle = false;
    this.style.props.clear();
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  removeEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    const index = list.indexOf(listener);
    if (index !== -1) list.splice(index, 1);
  }
  dispatch(type) {
    for (const listener of [...(this.listeners.get(type) || [])]) listener({ type, target: this });
  }
  /** An image finishing, as Chrome reports it: complete, then the event. */
  load() {
    this.complete = true;
    this.dispatch('load');
  }
  /** The scroller this element is laid out in, or null for the document. */
  get container() {
    for (let node = this.parentNode; node; node = node.parentNode || node.host) {
      if (node instanceof PageElement && node.page.scrollers.has(node)) return node;
    }
    return null;
  }
  getBoundingClientRect() {
    const page = this.page;
    const position = page.computed(this).position;
    let { x, y } = this.box;
    if (position !== 'fixed') {
      const container = this.container;
      if (container) {
        const outer = container.getBoundingClientRect();
        x += outer.left;
        y += outer.top - container.scrollTop;
        if (position === 'sticky') y = Math.max(y, outer.top + this.stickyTop);
      } else {
        y -= page.root.scrollTop;
        if (position === 'sticky') y = Math.max(y, this.stickyTop);
      }
    }
    const { width, height } = this.box;
    return { left: x, top: y, right: x + width, bottom: y + height, width, height, x, y };
  }
  scrollTo(options) {
    this.page.scroll(this, options);
  }
}

/**
 * @param {object} options
 * @param {object} [options.clock] makeClock; the panel realm's to share one timeline.
 * @param {{ width: number, height: number }} [options.viewport] innerWidth and innerHeight.
 * @param {number} [options.height] the document's scrollHeight.
 * @param {number} [options.scrollbar] the document's vertical scrollbar, in CSS px.
 * @param {boolean} [options.smooth] html { scroll-behavior: smooth }.
 * @param {number[]} [options.snap] a mandatory snapping root's snap points.
 * @param {number} [options.scale] visualViewport.scale: pinch zoom when not 1.
 * @param {number} [options.ratio] devicePixelRatio.
 * @param {boolean} [options.dom] whether chrome.dom.openOrClosedShadowRoot exists.
 * @param {string} [options.overflow] the root's overflow-y.
 * @param {string} [options.bodyOverflow] the body's overflow-y.
 * @param {boolean} [options.painting] false for a tab that runs no frames.
 * @param {object[]} [options.elements] specs for page.add, in order.
 */
export function makePage({
  clock = makeClock(),
  viewport = { width: 1000, height: 800 },
  height = 3000,
  scrollbar = 15,
  smooth = false,
  snap = null,
  scale = 1,
  ratio = 1,
  dom = true,
  overflow = 'visible',
  bodyOverflow = 'visible',
  background = 'rgb(255, 255, 255)',
  painting = true,
  elements = [],
} = {}) {
  const byId = new Map();
  const windowListeners = [];
  const page = { clock, scrollers: new Set(), smooth };

  const root = new PageElement(page, { tag: 'html', overflowY: overflow, snap: Boolean(snap) });
  const body = new PageElement(page, { tag: 'body', overflowY: bodyOverflow, background });
  root.children.push(body);
  body.parentNode = root;
  root.snapPoints = snap;
  Object.defineProperties(root, {
    scrollHeight: { get: () => page.height, set() {} },
    clientHeight: { get: () => win.innerHeight },
    clientWidth: { get: () => win.innerWidth - (page.height > win.innerHeight ? scrollbar : 0) },
  });
  page.height = height;
  page.root = root;
  page.body = body;

  page.computed = (element) => {
    const inline = (name) => element.style.getPropertyValue(name);
    const sheet = element.sheet;
    return {
      position: inline('position') || sheet.position,
      overflowY: inline('overflow-y') || sheet.overflowY,
      backgroundColor: inline('background-color') || sheet.backgroundColor,
      scrollSnapType: inline('scroll-snap-type') || sheet.scrollSnapType,
      transform: sheet.transform,
      visibility: inline('visibility') || 'visible',
      opacity: inline('opacity') || '1',
    };
  };

  /** A programmatic scroll of the document (root) or an inner scroller. */
  page.scroll = (target, { top, behavior } = {}) => {
    if (top === undefined) return;
    const max = Math.max(0, target.scrollHeight - target.clientHeight);
    let to = Math.min(max, Math.max(0, top));
    if (target.snapPoints && page.computed(target).scrollSnapType !== 'none') {
      to = target.snapPoints.reduce((best, point) => (Math.abs(point - to) < Math.abs(best - to) ? point : best));
    }
    page.scrolls.push({ target: target.id || target.localName, top, behavior, landed: to });
    if (page.smooth && behavior !== 'instant') {
      clock.setTimeout(() => {
        target.scrollTop = to;
      }, 300);
      return;
    }
    target.scrollTop = to;
  };
  page.scrolls = [];

  /**
   * Add an element: { id, tag, in, shadowIn, position, rect, overflowY,
   * scroll, style, shadow, transform, attributes, modal, ... }.
   */
  page.add = (spec) => {
    const element = new PageElement(page, spec);
    const parent = spec.shadowIn ? byId.get(spec.shadowIn)._shadow : spec.in ? byId.get(spec.in) : body;
    parent.children.push(element);
    element.parentNode = parent;
    if (spec.id) byId.set(spec.id, element);
    if (spec.scroll) page.scrollers.add(element);
    if (spec.shadow) element.attachShadow({ mode: spec.shadow });
    return element;
  };

  /** Elements in document order, light DOM only, as a TreeWalker yields them. */
  const descendants = function* (node) {
    for (const child of node.children) {
      yield child;
      yield* descendants(child);
    }
  };

  const document = {
    documentElement: root,
    body,
    scrollingElement: root,
    children: [root],
    createTreeWalker(start) {
      const order = [...descendants(start)];
      let index = 0;
      page.walked += 1;
      return { nextNode: () => order[index++] || null };
    },
    get images() {
      return [...descendants(document)].filter((element) => element.localName === 'img');
    },
  };
  page.walked = 0;

  const win = {
    document,
    console,
    innerWidth: viewport.width,
    innerHeight: viewport.height,
    NodeFilter: { SHOW_ELEMENT: 1 },
    visualViewport: { scale },
    devicePixelRatio: ratio,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    getComputedStyle: (element) => page.computed(element),
    requestAnimationFrame(fn) {
      if (painting) clock.setTimeout(fn, 16);
      return 1;
    },
    scrollTo(options) {
      page.scroll(root, options);
    },
    get scrollX() {
      return 0;
    },
    get scrollY() {
      return root.scrollTop;
    },
    addEventListener(type, listener, options) {
      const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
      windowListeners.push({ type, listener, capture, passive: Boolean(options?.passive) });
    },
    removeEventListener(type, listener, options) {
      const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
      const index = windowListeners.findIndex(
        (entry) => entry.type === type && entry.listener === listener && entry.capture === capture
      );
      if (index !== -1) windowListeners.splice(index, 1);
    },
  };
  if (dom) {
    win.chrome = {
      dom: {
        openOrClosedShadowRoot(element) {
          if (!(element instanceof PageElement)) throw new TypeError('Not an HTML element.');
          return element._shadow;
        },
      },
    };
  }
  win.window = win;
  const context = vm.createContext(win);

  for (const spec of elements) page.add(spec);

  return Object.assign(page, {
    window: win,
    document,
    /** The element with this id. */
    el: (id) => byId.get(id),
    /** Run content/page-shot.js in the page, as executeScript with files does. */
    inject() {
      vm.runInContext(SOURCE, context, { filename: 'content/page-shot.js' });
    },
    /** Call the controller, with the arguments and the result serialised. */
    async call(name, ...args) {
      return plain(await win.__cdrPageShot[name](...plain(args)));
    },
    /**
     * executeScript with a func, as the panel makes the call: the function's
     * source rebuilt in the page, called with serialised arguments, and its
     * result (awaited) serialised back.
     */
    async run(func, args = []) {
      const rebuilt = vm.runInContext(`(${func})`, context);
      return plain(await rebuilt(...plain(args)));
    },
    /** A window event, trusted unless said otherwise, capture listeners first. */
    input(type, { isTrusted = true } = {}) {
      const event = { type, isTrusted };
      const order = [...windowListeners.filter((entry) => entry.type === type)].sort(
        (a, b) => Number(b.capture) - Number(a.capture)
      );
      for (const { listener } of order) listener(event);
    },
    /** What the window listens for, as { type, capture, passive }. */
    listening: () => windowListeners.map(({ type, capture, passive }) => ({ type, capture, passive })),
    resize(width, height) {
      win.innerWidth = width;
      win.innerHeight = height;
    },
  });
}

/**
 * The real panel (panel-realm.mjs) and a page on one clock, the panel's
 * executeScript reaching the page as Chrome would: the file run again in the
 * page, and each function rebuilt there and called with copies of its
 * arguments. `calls` names each call in order: 'inject', then the
 * controller's methods, and `downloads` holds what each
 * chrome.downloads.download was asked. The view is 1280 by 720 with no
 * scrollbar, and a screenshot decodes to 1280 by 720 (the panel realm's
 * default), so a CSS pixel is a device pixel unless a test sets imageSizes.
 *
 * @param {{ page?: object, panel?: object }} options  for makePage and loadPanel
 */
export async function panelAndPage({ page: options = {}, panel: panelOptions = {} } = {}) {
  let page = null;
  const calls = [];
  const downloads = [];
  const panel = loadPanel({
    setup: (chrome) => {
      const download = chrome.downloads.download;
      chrome.downloads.download = async (details) => {
        downloads.push(details);
        return download(details);
      };
    },
    ...panelOptions,
  });
  page = makePage({ clock: panel.clock, viewport: { width: 1280, height: 720 }, scrollbar: 0, ...options });
  reachPage(panel.chrome, page, calls);
  await panel.internals.ready;
  await panel.flush();
  return { panel, page, calls, downloads };
}

/**
 * Make a panel's chrome.scripting.executeScript reach `page` as Chrome would,
 * naming each call in `calls`: 'inject' for the file, then each method.
 */
export function reachPage(chrome, page, calls = []) {
  chrome.scripting.executeScript = async (details) => {
    if (details.files) {
      calls.push('inject');
      page.inject();
      return [{ result: undefined }];
    }
    calls.push(details.args[0]);
    return [{ result: await page.run(details.func, details.args) }];
  };
  return calls;
}

/** The item the panel filed last, and the PNG it saved for it. */
export function lastFiled(panel) {
  return { item: panel.internals.state.items.at(-1), saved: panel.objectUrls.at(-1)?.blob };
}
