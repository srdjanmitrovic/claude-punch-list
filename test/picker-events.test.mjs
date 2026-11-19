/**
 * content/picker.js, run for real in a node:vm realm, against a small model of
 * the page it is injected into.
 *
 * The model lays nothing out. Elements have the rectangles a test gives them,
 * and a point hits the last of them in paint order: tree order, shadow content
 * before light content, then by the z-index a test gives, the top layer last.
 * Nothing clips a hit test, so a test leaves out the rectangle of what Chrome
 * would clip away. Around that it keeps to what was
 * observed in Chrome 156, as recorded in the picker's own comments: a frame
 * takes every pointer event over it and the page hears none, unless an
 * adopted stylesheet of its tree gives it pointer-events:none and no
 * important rule of the page's beats that (one inline, one in a cascade
 * layer, or one with more ids), a disabled
 * control gets pointer events and no mouse events, :hover moves at a frame,
 * everything outside an open modal dialog is inert, and a closed shadow root
 * hides what is inside it from the page, though a content script can ask for
 * it (chrome.dom). Window listeners run in the order they were added, and an
 * event no capture listener stopped is what "the page" saw. A mouse's
 * pointerdown, a finger's pointerup and the mousedown its tap makes, and
 * every keydown but Escape's give the page transient user activation before
 * any listener runs, and showPicker() spends it. A popover's toggle comes a
 * task after it is shown or hidden, and goes no further than its own tree. A
 * page rule that gives a frame a discrete transition (transition: all .3s
 * allow-discrete) holds the old pointer-events for half its time, and the
 * page hears its transition events, unless a sheet of its tree holds
 * discrete transitions back (transition-behavior: normal). Styles are worked
 * out again at each frame, at a hit test and at a read of any style, the
 * whole page at once; a change the page makes waits for that, and a fade it
 * asks for (opacity, display allow-discrete) begins there, cut short by a
 * sheet that holds discrete transitions back at that moment. An event sent on
 * an element meets window's capture listeners at once, before dispatchEvent
 * returns, and its bubbling ones only if it bubbles; from inside a shadow
 * root it gets out only if composed (seen in Chrome 157 with the picker's
 * name question, which got no answer from inside an open root without it).
 *
 * Time is a fake clock the test moves, a frame at a time.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { flush, makeClock } from './support/worker-realm.mjs';

const SOURCE = readFileSync(new URL('../content/picker.js', import.meta.url), 'utf8');
const GATE = new URL('../content/press-gate.js', import.meta.url);

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const FRAME_TAGS = new Set(['iframe', 'frame', 'embed', 'object']);
const CONTROLS = new Set(['button', 'input', 'select', 'textarea']);
const MOUSE_ONLY = new Set(['mousedown', 'mouseup', 'click', 'dblclick', 'auxclick']);

const box = (x, y, width, height) => ({ x, y, left: x, top: y, width, height, right: x + width, bottom: y + height });
const inside = (r, x, y) => r.width > 0 && r.height > 0 && x >= r.left && x < r.right && y >= r.top && y < r.bottom;
const px = (value) => Number.parseFloat(value) || 0;
const escapeText = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

class FakeNode {
  constructor(doc) {
    this.ownerDocument = doc;
    this.parentNode = null;
    this.childNodes = [];
  }
  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
  get children() {
    return this.childNodes.filter((node) => node.nodeType === 1);
  }
  get firstElementChild() {
    return this.children[0] || null;
  }
  get lastElementChild() {
    return this.children.at(-1) || null;
  }
  siblingAt(offset) {
    const list = this.parentNode ? this.parentNode.children : [];
    const index = list.indexOf(this);
    return index === -1 ? null : list[index + offset] || null;
  }
  get previousElementSibling() {
    return this.siblingAt(-1);
  }
  get nextElementSibling() {
    return this.siblingAt(1);
  }
  get nextSibling() {
    const list = this.parentNode ? this.parentNode.childNodes : [];
    return list[list.indexOf(this) + 1] || null;
  }
  appendChild(node) {
    return this.insertBefore(node, null);
  }
  insertBefore(node, before) {
    if (node.parentNode) node.parentNode.removeChild(node);
    const index = before ? this.childNodes.indexOf(before) : -1;
    if (index === -1) this.childNodes.push(node);
    else this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index !== -1) this.childNodes.splice(index, 1);
    node.parentNode = null;
    this.ownerDocument.detached(node);
    return node;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  replaceWith(node) {
    const parent = this.parentNode;
    parent.insertBefore(node, this);
    parent.removeChild(this);
  }
  getRootNode() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node;
  }
  // Through shadow roots, as in Chrome: what is in the shadow root of a
  // connected host is connected.
  get isConnected() {
    for (let root = this.getRootNode(); ; root = root.host.getRootNode()) {
      if (root === this.ownerDocument) return true;
      if (root.nodeType !== 11 || !root.host) return false;
    }
  }
  contains(node) {
    for (let at = node; at; at = at.parentNode) if (at === this) return true;
    return false;
  }
  get textContent() {
    return this.childNodes.map((node) => node.textContent).join('');
  }
  set textContent(value) {
    this.childNodes = [];
    this.appendChild(new FakeText(this.ownerDocument, String(value)));
  }
  querySelectorAll(selector) {
    const found = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (this.ownerDocument.matches(child, selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

class FakeText extends FakeNode {
  constructor(doc, data) {
    super(doc);
    this.nodeType = 3;
    this.data = data;
  }
  get textContent() {
    return this.data;
  }
}

class FakeStyle {
  set cssText(text) {
    for (const key of Object.keys(this)) delete this[key];
    for (const rule of String(text).split(';')) {
      const colon = rule.indexOf(':');
      if (colon === -1) continue;
      const name = rule
        .slice(0, colon)
        .trim()
        .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      this[name] = rule.slice(colon + 1).replace('!important', '').trim();
    }
  }
  get cssText() {
    return Object.entries(this)
      .map(([name, value]) => `${name}: ${value}`)
      .join('; ');
  }
}

class FakeElement extends FakeNode {
  constructor(doc, tag, attributes = {}) {
    super(doc);
    this.nodeType = 1;
    this.localName = tag.toLowerCase();
    this.namespaceURI = 'http://www.w3.org/1999/xhtml';
    this.attrs = new Map(Object.entries(attributes));
    this.style = new FakeStyle();
    this.rect = null; // [x, y, width, height], or a function giving one, set by a test
    this.shownWhile = null; // an element this one is rendered only while it is hovered (a CSS :hover menu)
    this.look = null; // (hovered) => computed style values, set by a test
    this.animations = [];
    this.attached = null;
    this.modal = false;
    this.popoverOpen = false;
    this.pageWins = false; // a page rule of its own (inline !important, or !important in a cascade layer) keeps a frame's pointer-events
    this.pageIds = 0; // a page rule of its own, !important outside a layer, naming the frame with this many ids (#player is 1)
    this.discreteMs = 0; // a page rule gives the frame transition: all <discreteMs>ms allow-discrete
    this.peState = null; // what a running transition of pointer-events holds
    this.fadeMs = 0; // a page rule gives the frame transition: opacity <fadeMs>ms, display <fadeMs>ms allow-discrete
    this.fading = null; // where a fade the page asked for is (see FakeDocument.fade())
    this.defined = true; // false: a custom element not upgraded yet
    this.z = 0; // a z-index: it and what is inside it paint above every lower one
    this.pageNone = false; // a page rule of its own gives it pointer-events:none
    this.captures = new Set(); // pointer ids captured to this element
  }
  hasPointerCapture(id) {
    return this.captures.has(id);
  }
  releasePointerCapture(id) {
    this.captures.delete(id);
  }
  // The region overlay listens on its own elements; nothing here sends them
  // events.
  addEventListener() {}
  removeEventListener() {}
  /** An event sent on this element, as the realm routes it (see makeRealm's onDispatch). */
  dispatchEvent(event) {
    return this.ownerDocument.onDispatch(this, event);
  }
  /** As Chrome answers it: display, then opacity 0 up the tree, then the visibility it inherits. */
  checkVisibility(options = {}) {
    if (!this.ownerDocument.rendered(this)) return false;
    // In skipped content (content-visibility: auto off screen): drawn, but
    // not laid out, and only contentVisibilityAuto says so. Asked without
    // it, Chrome lays the content out to answer (checked in Chrome 156).
    if (options.contentVisibilityAuto && this.skippedContent) return false;
    if (this.skippedContent) this.layouts = (this.layouts || 0) + 1;
    const looks = [];
    for (let at = this; at && at.nodeType === 1; at = up(at)) looks.push(at.look ? at.look(false) : {});
    if ((options.opacityProperty || options.checkOpacity) && looks.some((look) => look.opacity === '0')) return false;
    const visibility = looks.find((look) => look.visibility)?.visibility;
    return !((options.visibilityProperty || options.checkVisibilityCSS) && visibility === 'hidden');
  }
  get tagName() {
    return this.localName.toUpperCase();
  }
  get id() {
    return this.attrs.get('id') || '';
  }
  get className() {
    return this.attrs.get('class') || '';
  }
  set className(value) {
    this.attrs.set('class', String(value));
  }
  get classList() {
    const names = this.className.split(/\s+/).filter(Boolean);
    names.contains = (name) => names.includes(name);
    return names;
  }
  get attributes() {
    return [...this.attrs].map(([name, value]) => ({ name, value }));
  }
  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }
  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }
  removeAttribute(name) {
    this.attrs.delete(name);
    if (name === 'popover') this.ownerDocument.hidePopover(this, false);
  }
  hasAttribute(name) {
    return this.attrs.has(name);
  }
  attachShadow({ mode }) {
    this.attached = new FakeShadowRoot(this.ownerDocument, this, mode);
    return this.attached;
  }
  get shadowRoot() {
    return this.attached && this.attached.mode === 'open' ? this.attached : null;
  }
  getBoundingClientRect() {
    return this.ownerDocument.rectOf(this);
  }
  matches(selector) {
    return this.ownerDocument.matches(this, selector);
  }
  getAnimations() {
    return this.animations;
  }
  showPopover() {
    if (!this.isConnected || !this.hasAttribute('popover')) throw new Error('InvalidStateError');
    this.ownerDocument.showPopover(this);
  }
  hidePopover() {
    this.ownerDocument.hidePopover(this);
  }
  /** As Chrome answers it for an input in no document: spends the activation, or throws without one. */
  showPicker() {
    if (this.localName !== 'input') throw new TypeError('showPicker is not a function');
    if (!this.ownerDocument.activationActive()) throw new Error('NotAllowedError');
    this.ownerDocument.activation.until = 0;
  }
  get outerHTML() {
    const attributes = [...this.attrs]
      .map(([name, value]) => ` ${name}="${String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`)
      .join('');
    const open = `<${this.localName}${attributes}>`;
    if (VOID.has(this.localName)) return open;
    const inner = this.childNodes.map((node) => (node.nodeType === 1 ? node.outerHTML : escapeText(node.data))).join('');
    return `${open}${inner}</${this.localName}>`;
  }
}

class FakeShadowRoot extends FakeNode {
  constructor(doc, host, mode) {
    super(doc);
    this.nodeType = 11;
    this.host = host;
    this.mode = mode;
    this.activeElement = null;
    this.adoptedStyleSheets = [];
    this.listeners = [];
  }
  addEventListener(type, fn, capture) {
    if (!this.listeners.some((entry) => entry.type === type && entry.fn === fn)) this.listeners.push({ type, fn, capture: Boolean(capture) });
  }
  removeEventListener(type, fn) {
    this.listeners = this.listeners.filter((entry) => !(entry.type === type && entry.fn === fn));
  }
  // Only the picker sets this, to its own template: its divs, by class.
  set innerHTML(html) {
    this.html = html;
    this.childNodes = [];
    for (const [, name] of html.matchAll(/<div class="([^"]+)"/g)) {
      this.appendChild(new FakeElement(this.ownerDocument, 'div', { class: name }));
    }
  }
  elementFromPoint(x, y) {
    return this.ownerDocument.hits(x, y, this)[0] || null;
  }
  elementsFromPoint(x, y) {
    return this.ownerDocument.hits(x, y, this);
  }
}

/** The ancestor across shadow boundaries: a root's host, else the parent. */
const up = (node) => (node.nodeType === 11 ? node.host : node.parentNode);

/** Whether a node is inside a closed shadow root, at any depth. */
function insideClosed(node) {
  for (let root = node.getRootNode(); root.nodeType === 11; root = root.host.getRootNode()) {
    if (root.mode === 'closed') return true;
  }
  return false;
}

/** A selector list split at its top level commas: iframe:is(*, #a) stays one selector. */
function splitTop(list) {
  const out = [];
  let depth = 0;
  let current = '';
  for (const c of list) {
    if (c === '(') depth += 1;
    if (c === ')') depth -= 1;
    if (c === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  return [...out, current];
}

function parseCompound(text) {
  const out = { tag: null, id: null, classes: [], pseudos: [] };
  let index = 0;
  const ident = () => {
    let value = '';
    while (index < text.length) {
      const c = text[index];
      if (c === '\\') {
        const hex = /^[0-9a-fA-F]{1,6} ?/.exec(text.slice(index + 1));
        if (hex) {
          value += String.fromCodePoint(Number.parseInt(hex[0].trim(), 16));
          index += 1 + hex[0].length;
        } else {
          value += text[index + 1];
          index += 2;
        }
      } else if ('.#:()'.includes(c)) {
        break;
      } else {
        value += c;
        index += 1;
      }
    }
    return value;
  };
  if (!'.#:'.includes(text[0])) out.tag = ident();
  while (index < text.length) {
    const c = text[index];
    index += 1;
    if (c === '.') out.classes.push(ident());
    else if (c === '#') out.id = ident();
    else if (c === ':') {
      const name = ident();
      let arg = null;
      if (text[index] === '(') {
        const close = text.indexOf(')', index);
        arg = text.slice(index + 1, close);
        index = close + 1;
      }
      out.pseudos.push({ name, arg });
    } else throw new SyntaxError(`cannot read ${text}`);
  }
  return out;
}

/** Compounds and the combinators between them, ' ' or '>'. */
function parseComplex(text) {
  const parts = [];
  let current = '';
  for (let index = 0; index < text.length; ) {
    const c = text[index];
    if (c === '\\') {
      const hex = /^[0-9a-fA-F]{1,6} ?/.exec(text.slice(index + 1));
      const length = hex ? 1 + hex[0].length : 2;
      current += text.slice(index, index + length);
      index += length;
    } else if (c === ' ' || c === '>') {
      let end = index;
      let child = false;
      while (end < text.length && (text[end] === ' ' || text[end] === '>')) {
        if (text[end] === '>') child = true;
        end += 1;
      }
      if (current) parts.push(current);
      current = '';
      if (parts.length) parts.push(child ? '>' : ' ');
      index = end;
    } else {
      current += c;
      index += 1;
    }
  }
  if (current) parts.push(current);
  return parts;
}

class FakeDocument extends FakeNode {
  constructor() {
    super(null);
    this.ownerDocument = this;
    this.nodeType = 9;
    this.documentElement = this.appendChild(new FakeElement(this, 'html'));
    this.head = this.documentElement.appendChild(new FakeElement(this, 'head'));
    this.body = this.documentElement.appendChild(new FakeElement(this, 'body'));
    this.viewport = { width: 1000, height: 800 };
    this.topLayer = [];
    this.focused = null;
    this.fullscreenElement = null;
    this.hoverChain = new Set();
    this.pointer = null;
    this.sticky = false;
    this.adoptedStyleSheets = [];
    // Transient user activation: until when it lasts, and whether the page
    // ever had it (sticky activation, never withdrawn).
    this.activation = { until: 0, sticky: false };
    // Set by the realm: the clock, a timer on it, a popover's toggle, a
    // transition event the page hears, and an event sent on an element.
    this.now = () => 0;
    this.later = () => {};
    this.onToggle = () => {};
    this.onTransition = () => {};
    this.onDispatch = () => true;
  }
  /**
   * A restyle, as Chrome makes one at each frame, at a hit test and at a
   * read of any style: every frame's pointer-events is worked out again,
   * and a transition of it started or not (see transitioned()), and a fade
   * the page asked for since the last one begins (see fade()). The page's
   * own changes wait for it; the picker's sheets are read as they stand
   * when it comes.
   */
  restyle() {
    const visit = (node) => {
      for (const child of [...(node.attached ? node.attached.childNodes : []), ...node.childNodes]) {
        if (child.nodeType !== 1) continue;
        if (FRAME_TAGS.has(child.localName)) {
          this.pointerEventsOf(child);
          this.startFade(child);
        }
        visit(child);
      }
    };
    visit(this);
  }
  /** Whether a sheet of an element's own tree holds its discrete transitions back. */
  holdsTransitions(element) {
    return this.sheetRules(element).some((rule) => /transition-behavior:\s*normal/.test(rule.body));
  }
  /** A frame's computed transition properties, as its page rule and the sheets give them. */
  transitionOf(element) {
    const held = this.holdsTransitions(element);
    if (element.discreteMs) {
      return {
        'transition-property': 'all',
        'transition-behavior': held ? 'normal' : 'allow-discrete',
        'transition-duration': `${element.discreteMs / 1000}s`,
        'transition-delay': '0s',
      };
    }
    if (element.fadeMs) {
      const time = `${element.fadeMs / 1000}s`;
      return {
        'transition-property': 'opacity, display',
        'transition-behavior': held ? 'normal' : 'normal, allow-discrete',
        'transition-duration': `${time}, ${time}`,
        'transition-delay': '0s',
      };
    }
    return { 'transition-property': 'all', 'transition-behavior': 'normal', 'transition-duration': '0s', 'transition-delay': '0s' };
  }
  /**
   * The page fades a frame out: a class that gives it opacity 0 and
   * display none, under its own transition of both (fadeMs), and it takes
   * the frame away on the transitionend of its opacity. That begins at the
   * next restyle. If a sheet of the frame's tree holds discrete transitions
   * back then, display is none at once, the opacity of a frame not drawn
   * does not run, no event comes, and the frame stays where it is. One that
   * has begun runs to its end whatever the sheets hold later. All seen in
   * Chrome 156.
   */
  fade(element) {
    element.fading = 'asked';
  }
  startFade(element) {
    if (element.fading !== 'asked') return;
    if (this.holdsTransitions(element)) {
      element.fading = 'cut';
      element.style.display = 'none';
      return;
    }
    element.fading = 'running';
    for (const type of ['transitionrun', 'transitionstart']) {
      this.onTransition(`${type}:display`);
      this.onTransition(`${type}:opacity`);
    }
    this.later(() => {
      element.style.display = 'none';
      this.onTransition('transitionend:display');
      this.onTransition('transitionend:opacity');
      element.remove();
      this.onTransition('removed');
    }, element.fadeMs);
  }
  activationActive() {
    return this.activation.until > this.now();
  }
  /**
   * The rules of the sheets an element's own tree adopted (the document, or
   * the shadow root it is in) that name its tag, and are not disabled: the
   * declarations, and how many ids the selector that names it holds, which
   * is its specificity as far as the page rules modelled here go.
   */
  sheetRules(element) {
    const found = [];
    for (const sheet of element.getRootNode().adoptedStyleSheets || []) {
      if (sheet.disabled) continue;
      for (const [, list, body] of String(sheet.rules).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        for (const selector of splitTop(list)) {
          if (/^[a-z]+/.exec(selector.trim())?.[0] === element.localName) found.push({ ids: (selector.match(/#/g) || []).length, body });
        }
      }
    }
    return found;
  }
  /**
   * What pointer-events an element computes to: none when a page rule of its
   * own says so; for a frame, none when a sheet of its own tree names its tag
   * with pointer-events:none !important, unless the page's own rule wins: an
   * inline !important or an !important in one of the page's cascade layers
   * always does (pageWins), and an !important outside a layer does when its
   * selector holds more ids than the sheet's (pageIds; at a tie the sheet,
   * adopted after the page's own, wins, and classes are not modelled). All as
   * seen in Chrome 156. Otherwise it inherits from its parent, the fallback
   * content of an <object> included. A frame's value can be held back by a
   * transition (see transitioned()).
   */
  pointerEventsOf(element) {
    if (element.pageNone) return 'none';
    const inherited = () => {
      const parent = element.parentNode;
      return parent && parent.nodeType === 1 ? this.pointerEventsOf(parent) : 'auto';
    };
    if (!FRAME_TAGS.has(element.localName)) return inherited();
    const rules = this.sheetRules(element);
    const page = element.pageWins || element.pageIds ? 'auto' : inherited();
    const passed =
      !element.pageWins && rules.some((rule) => /pointer-events:\s*none/.test(rule.body) && rule.ids >= element.pageIds);
    return this.transitioned(element, passed ? 'none' : page, page, this.holdsTransitions(element));
  }
  /**
   * A page rule's discrete transition of a frame's pointer-events: when the
   * value changes, the old one is kept for half the transition, and the page
   * hears transitionrun and transitionstart, and transitioncancel for one
   * replaced while running. transition-behavior: normal in a sheet that wins
   * starts none (all seen in Chrome 156).
   */
  transitioned(element, value, page, steady) {
    if (!element.discreteMs) return value;
    // A frame not drawn (display: none) has no style to change from, and
    // one in skipped content is passed by when the page is restyled: either
    // takes a new value at once, with no transition, and is drawn with the
    // value it last took (Chrome 156). A read of the frame's own style in
    // skipped content lays it out, which the tests count instead
    // (transitionReads, layouts).
    if (!this.rendered(element) || element.skippedContent) {
      element.peState = { from: value, to: value, start: -Infinity };
      return value;
    }
    const now = this.now();
    const state = (element.peState ||= { from: page, to: page, start: -Infinity });
    const shown = now - state.start < element.discreteMs / 2 ? state.from : state.to;
    if (value === state.to) return shown;
    if (now - state.start < element.discreteMs) this.onTransition('transitioncancel:pointer-events');
    if (steady || shown === value) {
      element.peState = { from: value, to: value, start: -Infinity };
      return value;
    }
    element.peState = { from: shown, to: value, start: now };
    this.onTransition('transitionrun:pointer-events');
    this.onTransition('transitionstart:pointer-events');
    return shown;
  }
  get activeElement() {
    return this.focused && this.focused.isConnected ? this.focused : this.body;
  }
  addEventListener() {}
  removeEventListener() {}
  createElement(tag) {
    return new FakeElement(this, tag);
  }
  createTreeWalker(root, what) {
    const nodes = [];
    const visit = (node) => {
      for (const child of node.childNodes) {
        if ((what & 1 && child.nodeType === 1) || (what & 4 && child.nodeType === 3)) nodes.push(child);
        visit(child);
      }
    };
    visit(root);
    let index = -1;
    return {
      currentNode: root,
      nextNode() {
        index += 1;
        this.currentNode = nodes[index] || null;
        return this.currentNode;
      },
    };
  }
  elementFromPoint(x, y) {
    return this.hits(x, y, this)[0] || null;
  }
  elementsFromPoint(x, y) {
    return this.hits(x, y, this);
  }
  /** Every element, in the order it paints: tree order, by z-index, the top layer last. */
  paintOrder() {
    const order = [];
    const layered = new Set(this.topLayer);
    const visit = (node) => {
      for (const child of [...(node.attached ? node.attached.childNodes : []), ...node.childNodes]) {
        if (child.nodeType !== 1 || layered.has(child)) continue;
        order.push(child);
        visit(child);
      }
    };
    visit(this);
    const zOf = (element) => {
      for (let at = element; at; at = up(at)) if (at.nodeType === 1 && at.z) return at.z;
      return 0;
    };
    order.sort((a, b) => zOf(a) - zOf(b));
    for (const element of this.topLayer) {
      if (!element.isConnected) continue;
      order.push(element);
      visit(element);
    }
    return order;
  }
  composedContains(ancestor, node) {
    for (let at = node; at; at = up(at)) if (at === ancestor) return true;
    return false;
  }
  rendered(element) {
    if (!element.isConnected && !this.composedContains(this, element)) return false;
    for (let at = element; at && at !== this; at = up(at)) {
      if (at.nodeType === 1 && at.style.display === 'none') return false;
      if (at.nodeType === 1 && at.shownWhile && !this.isHovered(at.shownWhile)) return false;
    }
    return true;
  }
  inPicker(element) {
    for (let at = element; at; at = up(at)) {
      if (at.nodeType === 11 && at.host.hasAttribute('data-cdr-picker')) return true;
    }
    return false;
  }
  rectOf(element) {
    if (element === this.documentElement || element === this.body) {
      return box(0, 0, this.viewport.width, this.viewport.height);
    }
    if (!this.rendered(element)) return box(0, 0, 0, 0);
    if (element.rect) return box(...(typeof element.rect === 'function' ? element.rect() : element.rect));
    if (this.inPicker(element)) {
      if (element.className === 'catcher') return box(0, 0, this.viewport.width, this.viewport.height);
      const s = element.style;
      if (s.left !== undefined) return box(px(s.left), px(s.top), px(s.width), px(s.height));
    }
    return box(0, 0, 0, 0);
  }
  topModal() {
    return [...this.topLayer].reverse().find((element) => element.modal && element.isConnected) || null;
  }
  hittable(element) {
    if (!this.rendered(element)) return false;
    if (element.hasAttribute('data-cdr-picker')) return false; // pointer-events: none
    if (this.inPicker(element)) {
      // .shield and .catcher take the pointer when shown; the rest is none.
      if (!['shield', 'catcher'].includes(element.className) || element.style.display !== 'block') return false;
    }
    if (element.passThrough) return false;
    if (this.pointerEventsOf(element) === 'none') return false;
    const modal = this.topModal();
    return !modal || this.composedContains(modal, element);
  }
  /** What a node is, seen from `scope`, as retargeting defines it. */
  retarget(node, scope) {
    let at = node;
    for (;;) {
      const root = at.getRootNode();
      if (root.nodeType !== 11 || root === scope) return at;
      if (scope !== this && this.composedContains(root, scope)) return at;
      at = root.host;
    }
  }
  // As Chrome hit tests: an element with visibility hidden is not hit, and
  // an ancestor whose overflow is hidden, or with a clip-path, clips it.
  drawnAt(element, x, y) {
    const look = (node) => (node.look ? node.look(this.isHovered(node)) : {});
    if (look(element).visibility === 'hidden') return false;
    for (let at = up(element); at && at.nodeType !== 9; at = up(at)) {
      if (at.nodeType !== 1) continue;
      const style = look(at);
      const clips =
        [style.overflow, style['overflow-x'], style['overflow-y']].includes('hidden') ||
        (style['clip-path'] && style['clip-path'] !== 'none');
      if (clips && at.rect && !inside(this.rectOf(at), x, y)) return false;
    }
    return true;
  }
  hits(x, y, scope) {
    this.restyle();
    const raw = this.paintOrder()
      .filter((element) => this.hittable(element) && inside(this.rectOf(element), x, y) && this.drawnAt(element, x, y))
      .reverse();
    const out = [];
    for (const element of raw) {
      const target = this.retarget(element, scope);
      if (!out.includes(target)) out.push(target);
    }
    return out;
  }
  rawTop(x, y) {
    return (
      this.paintOrder()
        .filter((element) => this.hittable(element) && inside(this.rectOf(element), x, y) && this.drawnAt(element, x, y))
        .at(-1) || null
    );
  }
  // What matches :hover is set at a frame: the node under the pointer and
  // its ancestors, up to an element in the top layer and no further (over a
  // modal dialog, the dialog is hovered and the body is not). After a tap,
  // Chrome leaves it on what was tapped, whatever covers it later, until the
  // next tap. All seen in Chrome 156.
  // Hit tested before the chain changes, so that what a hovered element
  // shows (a CSS :hover menu) is there to be hit.
  updateHover() {
    if (this.sticky) return;
    const chain = new Set();
    for (let at = this.pointer ? this.rawTop(this.pointer.x, this.pointer.y) : null; at; at = up(at)) {
      if (at.nodeType === 1) chain.add(at);
      if (this.topLayer.includes(at)) break;
    }
    this.hoverChain = chain;
  }
  isHovered(element) {
    return this.hoverChain.has(element);
  }
  // Each sends a toggle a task later, as Chrome does from 132 for a dialog
  // too; one taken out of the document, or out of the top layer by losing
  // its popover attribute, sends none.
  showModal(dialog) {
    dialog.setAttribute('open', '');
    dialog.modal = true;
    this.topLayer = this.topLayer.filter((element) => element !== dialog).concat(dialog);
    this.focused = dialog;
    this.onToggle(dialog);
  }
  showPopover(element) {
    const was = element.popoverOpen;
    this.topLayer = this.topLayer.filter((node) => node !== element).concat(element);
    element.popoverOpen = true;
    if (!was) this.onToggle(element);
  }
  hidePopover(element, events = true) {
    const was = element.popoverOpen;
    this.topLayer = this.topLayer.filter((node) => node !== element);
    element.popoverOpen = false;
    if (was && events) this.onToggle(element);
  }
  // A removed node stops matching :hover at once. What stays in the page
  // keeps whatever it matched until the next frame looks again: nothing
  // gains the hover the node had.
  detached(node) {
    for (const element of [...this.topLayer]) {
      if (this.composedContains(node, element)) this.hidePopover(element, false);
    }
    for (const element of [...this.hoverChain]) {
      if (this.composedContains(node, element)) this.hoverChain.delete(element);
    }
  }
  matches(element, selector) {
    return selector.split(/\s*,\s*/).some((one) => this.matchComplex(element, parseComplex(one.trim())));
  }
  matchCompound(element, compound) {
    if (compound.tag && compound.tag !== '*' && compound.tag !== element.localName) return false;
    if (compound.id !== null && compound.id !== element.id) return false;
    for (const name of compound.classes) if (!element.classList.includes(name)) return false;
    for (const { name, arg } of compound.pseudos) {
      if (name === 'nth-of-type') {
        const same = element.parentNode.children.filter((node) => node.localName === element.localName);
        if (same.indexOf(element) + 1 !== Number(arg)) return false;
      } else if (name === 'hover') {
        if (!this.isHovered(element)) return false;
      } else if (name === 'modal') {
        if (!(element.modal && this.topLayer.includes(element))) return false;
      } else if (name === 'popover-open') {
        if (!element.popoverOpen) return false;
      } else if (name === 'root') {
        if (element !== this.documentElement) return false;
      } else if (name === 'defined') {
        if (element.localName.includes('-') && !element.defined) return false;
      } else if (name === 'host') {
        return false;
      } else {
        throw new SyntaxError(`:${name} is not modelled`);
      }
    }
    return true;
  }
  matchComplex(element, parts) {
    const compounds = parts.filter((_, index) => index % 2 === 0).map(parseCompound);
    const combinators = parts.filter((_, index) => index % 2 === 1);
    const isHost = (compound) => compound.pseudos.length === 1 && compound.pseudos[0].name === 'host' && !compound.tag;
    const at = (node, index) => {
      if (!this.matchCompound(node, compounds[index])) return false;
      if (index === 0) return true;
      const combinator = combinators[index - 1];
      // A shadow root's querySelectorAll reads :host > as its own children.
      if (isHost(compounds[index - 1])) return index - 1 === 0 && combinator === '>' && node.parentNode?.nodeType === 11;
      if (combinator === '>') return Boolean(node.parentElement) && at(node.parentElement, index - 1);
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        if (at(parent, index - 1)) return true;
      }
      return false;
    };
    return at(element, compounds.length - 1);
  }
}

const fakeCSS = {
  escape: (value) =>
    String(value)
      .replace(/[^\w\-\u0080-￿]/g, (c) => '\\' + c)
      .replace(/^\d/, (digit) => `\\3${digit} `),
};

/**
 * A page with the picker's file run in it. `arm()` runs the file again, as
 * every arm does in Chrome.
 */
function makeRealm() {
  const clock = makeClock();
  const doc = new FakeDocument();
  const listeners = [];
  const frames = new Map();
  let nextFrame = 1;
  const sent = [];
  // What reached the page's own listeners, what went into a frame, and the
  // transition events the page heard.
  const page = { seen: [], framed: [], events: [], transitions: [] };
  // Every event sent on an element, { type, node }, in order.
  const sentOn = [];
  doc.now = () => clock.now;
  doc.later = (fn, ms) => clock.setTimeout(fn, ms);
  doc.onTransition = (type) => page.transitions.push(type);
  // A toggle goes no further than the tree its popover is in: from the
  // document it reaches window's listeners, from a shadow root only that
  // root's (seen in Chrome 156).
  doc.onToggle = (element) =>
    clock.setTimeout(() => {
      const root = element.getRootNode();
      if (root === doc) deliver('toggle', { target: element, deep: element, quiet: true });
      else if (root.nodeType === 11) {
        const event = { type: 'toggle', target: element, isTrusted: true, composedPath: () => [element] };
        for (const entry of root.listeners.filter((one) => one.type === 'toggle')) entry.fn.call(root, event);
      }
    }, 0);
  // An event sent on an element reaches window's capture listeners, and its
  // bubbling ones only if it bubbles. One not composed stays in the shadow
  // root it was sent in, and one sent on an element in no document goes
  // nowhere: in Chrome a request sent in an open root without composed got
  // no answer from the page's world. It is not a press, and the page's
  // count of what it saw leaves it out.
  doc.onDispatch = (node, event) => {
    sentOn.push({ type: event.type, node });
    if (!node.isConnected) return true;
    if (!event.composed && node.getRootNode() !== doc) return true;
    const seen = deliver(event.type, {
      target: doc.retarget(node, doc),
      deep: node,
      detail: event.detail,
      composed: Boolean(event.composed),
      quiet: true,
      captureOnly: !event.bubbles,
    });
    return !seen.defaultPrevented;
  };

  const window = {
    document: doc,
    innerWidth: 1000,
    innerHeight: 800,
    devicePixelRatio: 2,
    CSS: fakeCSS,
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4 },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    requestAnimationFrame(callback) {
      const id = nextFrame;
      nextFrame += 1;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
    getComputedStyle(element) {
      doc.restyle();
      const values = {
        visibility: 'visible',
        'overflow-x': 'visible',
        'overflow-y': 'visible',
        'clip-path': 'none',
        ...doc.transitionOf(element),
        ...(element.look ? element.look(doc.isHovered(element)) : {}),
      };
      return {
        getPropertyValue: (name) => {
          // A read of a transition property lays out skipped content.
          if (name.startsWith('transition')) element.transitionReads = (element.transitionReads || 0) + 1;
          return name === 'pointer-events' ? doc.pointerEventsOf(element) : values[name] || '';
        },
      };
    },
    // A constructable stylesheet: its text, and whether it is disabled,
    // with a count of the times it was switched while in use (disabled set,
    // or its rules replaced by other rules), each a restyle of the page.
    // Putting rules in an empty sheet, or emptying it, is not counted.
    // Every text it was given is kept in `texts`.
    CSSStyleSheet: class {
      constructor() {
        this.off = false;
        this.toggles = 0;
        this.rules = '';
        this.texts = [];
      }
      get disabled() {
        return this.off;
      }
      set disabled(value) {
        this.toggles += 1;
        this.off = Boolean(value);
      }
      replaceSync(text) {
        if (this.rules && String(text)) this.toggles += 1;
        this.rules = String(text);
        this.texts.push(this.rules);
      }
    },
    navigator: {
      userActivation: {
        get isActive() {
          return doc.activationActive();
        },
        get hasBeenActive() {
          return doc.activation.sticky;
        },
      },
    },
    addEventListener(type, fn, options) {
      const capture = typeof options === 'object' ? Boolean(options?.capture) : Boolean(options);
      if (!listeners.some((entry) => entry.type === type && entry.fn === fn && entry.capture === capture)) {
        listeners.push({ type, fn, capture });
      }
    },
    removeEventListener(type, fn, options) {
      const capture = typeof options === 'object' ? Boolean(options?.capture) : Boolean(options);
      const index = listeners.findIndex((entry) => entry.type === type && entry.fn === fn && entry.capture === capture);
      if (index !== -1) listeners.splice(index, 1);
    },
    postMessage(data) {
      setImmediate(() => deliver('message', { data }));
    },
    // Enough of one for the picker's question while it hovers: a type and
    // the init dictionary's detail, bubbles and composed.
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) {
        this.type = String(type);
        this.detail = init.detail === undefined ? null : init.detail;
        this.bubbles = Boolean(init.bubbles);
        this.composed = Boolean(init.composed);
      }
    },
    // An event sent on the window, by the picker's world or the page's:
    // heard at once by every listener for its type.
    dispatchEvent(event) {
      const seen = deliver(event.type, { detail: event.detail, quiet: true });
      return !seen.defaultPrevented;
    },
    chrome: {
      // A content script's way to a closed shadow root. Chrome refuses
      // anything but an HTML element.
      dom: {
        openOrClosedShadowRoot(element) {
          if (!(element instanceof FakeElement) || element.namespaceURI !== 'http://www.w3.org/1999/xhtml') {
            throw new TypeError('Error in invocation of dom.openOrClosedShadowRoot(HTMLElement element): ');
          }
          return element.attached || null;
        },
      },
      runtime: {
        // A reload of the extension takes this away from the old scripts.
        id: 'ext',
        sendMessage(message) {
          sent.push(JSON.parse(JSON.stringify(message)));
          if (realm.onSend) realm.onSend(message);
          return Promise.resolve();
        },
      },
    },
  };
  window.window = window;
  const context = vm.createContext(window);
  // Inside the realm, `window` is the context's global proxy and not the
  // object above, and the picker checks event.source against it.
  const self = vm.runInContext('this', context);

  // The events Chrome gives transient user activation with, before any
  // listener runs (seen in Chrome 156). A press that goes into a frame gives
  // it to the page too; that is not modelled.
  const activates = (type, init) =>
    init.isTrusted !== false &&
    ((type === 'pointerdown' && (init.pointerType ?? 'mouse') === 'mouse') ||
      (type === 'pointerup' && (init.pointerType ?? 'mouse') !== 'mouse') ||
      (type === 'mousedown' && init.fromTap) ||
      (type === 'keydown' && init.key !== 'Escape'));

  function deliver(type, init = {}) {
    if (activates(type, init)) doc.activation = { until: clock.now + 5000, sticky: true };
    let stopped = false;
    let immediate = false;
    const event = {
      type,
      isTrusted: true,
      clientX: 0,
      clientY: 0,
      button: 0,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      isComposing: false,
      defaultPrevented: false,
      source: self,
      ...init,
      preventDefault() {
        event.defaultPrevented = true;
      },
      stopPropagation() {
        stopped = true;
      },
      stopImmediatePropagation() {
        stopped = true;
        immediate = true;
      },
      // As a listener on window sees it: what is inside a closed shadow
      // root is left out, so the path starts at its host.
      composedPath() {
        const path = [];
        for (let at = init.deep || init.target; at; at = up(at)) {
          if (at.nodeType !== 11 && !insideClosed(at)) path.push(at);
        }
        return path;
      },
    };
    // A detail whose read throws, as one copied out of another world can
    // (a page's object Chrome cannot clone).
    if (init.lazyDetail) Object.defineProperty(event, 'detail', { get: init.lazyDetail });
    const run = (capture) => {
      for (const entry of listeners.filter((one) => one.type === type && one.capture === capture)) {
        if (immediate) return;
        if (listeners.includes(entry)) entry.fn.call(window, event);
      }
    };
    run(true);
    if (!stopped && type !== 'message' && !init.quiet) {
      page.seen.push(type);
      page.events.push(event);
    }
    // An event sent on an element that does not bubble meets window's
    // listeners only on its way down.
    if (!stopped && !init.captureOnly) run(false);
    return event;
  }

  /** A pointer or mouse event at a point, routed as Chrome routes it. */
  function pointerEvent(type, x, y, extra = {}) {
    const raw = doc.rawTop(x, y);
    if (raw && FRAME_TAGS.has(raw.localName)) {
      page.framed.push(type);
      return null;
    }
    if (raw && MOUSE_ONLY.has(type) && CONTROLS.has(raw.localName) && raw.hasAttribute('disabled')) return null;
    const target = raw ? doc.retarget(raw, doc) : doc.body;
    return deliver(type, { clientX: x, clientY: y, target, deep: raw, ...extra });
  }

  const realm = {
    doc,
    window,
    clock,
    sent,
    page,
    deliver,
    pointerEvent,
    /** Inject the picker as executeScript does; returns its completion value. */
    arm() {
      return vm.runInContext(SOURCE, context, { filename: 'content/picker.js' });
    },
    /** Inject another content script into the same page. */
    inject(source, filename) {
      return vm.runInContext(source, context, { filename });
    },
    get picker() {
      return window.__cdrElementPicker;
    },
    add(tag, attributes = {}, rect = null, parent = doc.body) {
      const element = new FakeElement(doc, tag, attributes);
      element.rect = rect;
      parent.appendChild(element);
      return element;
    },
    text(parent, data) {
      parent.appendChild(new FakeText(doc, data));
    },
    move(x, y) {
      doc.pointer = { x, y };
      doc.updateHover();
      pointerEvent('pointermove', x, y);
      pointerEvent('mousemove', x, y);
    },
    press(x, y, button = 0) {
      pointerEvent('pointerdown', x, y, { button });
      pointerEvent('mousedown', x, y, { button });
    },
    release(x, y, button = 0) {
      pointerEvent('pointerup', x, y, { button });
      pointerEvent('mouseup', x, y, { button });
      pointerEvent(button === 0 ? 'click' : 'auxclick', x, y, { button });
    },
    click(x, y) {
      realm.move(x, y);
      realm.press(x, y);
      realm.release(x, y);
    },
    /**
     * A finger: the pointer and touch events, then the tap gesture, which
     * moves the hover to whatever is at the point by then, and the mouse
     * events made for it. A mousedown nobody cancelled focuses what it hit.
     * The finger's pointer is captured to what it pressed before any
     * pointerdown listener runs, and the capture is announced after it,
     * unless something let it go (gotpointercapture, lostpointercapture).
     */
    tap(x, y) {
      const touch = { pointerType: 'touch', isPrimary: true, pointerId: 7 };
      const pressed = doc.rawTop(x, y);
      if (pressed) pressed.captures.add(touch.pointerId);
      pointerEvent('pointerdown', x, y, touch);
      const held = Boolean(pressed && pressed.hasPointerCapture(touch.pointerId));
      if (held) deliver('gotpointercapture', { ...touch, target: doc.retarget(pressed, doc), deep: pressed });
      pointerEvent('touchstart', x, y);
      pointerEvent('pointerup', x, y, touch);
      if (held) {
        pressed.releasePointerCapture(touch.pointerId);
        deliver('lostpointercapture', { ...touch, target: doc.retarget(pressed, doc), deep: pressed });
      }
      pointerEvent('touchend', x, y);
      doc.sticky = false;
      doc.pointer = { x, y };
      doc.updateHover();
      doc.sticky = true;
      pointerEvent('mousemove', x, y);
      const down = pointerEvent('mousedown', x, y, { fromTap: true });
      const hit = doc.rawTop(x, y);
      if (down && !down.defaultPrevented && hit && /^(button|input|select|textarea|a)$/.test(hit.localName)) doc.focused = hit;
      pointerEvent('mouseup', x, y);
      pointerEvent('click', x, y);
    },
    key(key, extra = {}) {
      deliver('keydown', { key, ...extra });
      deliver('keyup', { key, ...extra });
    },
    /** Run `count` frames: timers due by then, the hover, the frame callbacks, then a restyle. */
    async frame(count = 1) {
      for (let index = 0; index < count; index += 1) {
        await clock.advance(16);
        doc.updateHover();
        const due = [...frames.values()];
        frames.clear();
        for (const callback of due) callback(clock.now);
        doc.restyle();
        await flush();
      }
    },
    async idle(ms) {
      for (let spent = 0; spent < ms; spent += 16) await realm.frame();
    },
    picks() {
      return sent.filter((message) => message.type === 'cdr:element-picked');
    },
    host() {
      return doc.paintOrder().find((element) => element.hasAttribute('data-cdr-picker')) || null;
    },
    part(name) {
      const host = realm.host();
      return host ? host.attached.children.find((element) => element.className === name) : null;
    },
    /**
     * A MAIN world collector's answer to the name the picker asks for while
     * it hovers, as collector-main.js gives it: heard by a capture listener
     * on window, with the node read off the event's path, and answered on
     * the window before the picker's dispatchEvent returns. answer(node)
     * gives the reply's detail, or undefined for no reply at all. Returns
     * the nodes asked about, in order.
     */
    namer(answer) {
      const asked = [];
      window.addEventListener(
        '__cdr_name',
        (event) => {
          const node = event.composedPath()[0];
          asked.push(node);
          const detail = answer(node);
          if (detail !== undefined) deliver('__cdr_name:reply', { detail, quiet: true });
        },
        true
      );
      return asked;
    },
    /** The elements the picker sent its name question on, in order, answered or not. */
    asks() {
      return sentOn.filter((entry) => entry.type === '__cdr_name').map((entry) => entry.node);
    },
    /** A MAIN world collector that answers every request with reply(data). */
    collector(reply) {
      window.addEventListener('message', (event) => {
        const data = event.data;
        if (!data || data.__cdr !== 'request') return;
        const payload = reply(data);
        if (payload === undefined) return;
        setImmediate(() => deliver('message', { data: { __cdr: 'response', id: data.id, payload } }));
      });
    },
  };
  return realm;
}

/** What the page's own listeners saw of a press, the moves left out. */
const pressesSeen = (realm) => realm.page.seen.filter((type) => !/move$/.test(type));
/** What went into a frame of a press, the moves left out. */
const pressesFramed = (realm) => realm.page.framed.filter((type) => !/move$/.test(type));

test('picker events: a click picks the element under the pointer, as it always did', async () => {
  const realm = makeRealm();
  const card = realm.add('div', { class: 'card', 'data-testid': 'card' }, [100, 100, 200, 100]);
  realm.text(card, 'Hello');
  realm.arm();
  await realm.frame();
  realm.click(150, 150);
  await realm.idle(1000);
  const [pick] = realm.picks();
  assert.ok(pick, 'nothing was picked');
  assert.equal(pick.element.html, '<div class="card" data-testid="card">Hello</div>');
  assert.equal(pick.element.text, 'Hello');
  assert.equal(realm.picker.isActive(), false);
});

test('picker events: no part of a press reaches the page while armed, nor the second click of a double click', async () => {
  const realm = makeRealm();
  realm.add('button', { 'aria-haspopup': 'menu' }, [100, 100, 120, 40]);
  realm.arm();
  await realm.frame();
  realm.move(150, 120);
  // A trigger that opens on pointerdown, and a double click.
  realm.press(150, 120);
  realm.release(150, 120);
  realm.press(150, 120);
  realm.release(150, 120);
  realm.pointerEvent('dblclick', 150, 120);
  assert.deepEqual(pressesSeen(realm), []);
  await realm.idle(2000);
  assert.equal(realm.picks().length, 1);
  // Once the picture is taken, the page has its pointer back.
  realm.click(150, 120);
  assert.deepEqual(pressesSeen(realm), ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
});

test('picker events: a middle click and a right click are kept from the page; the browser menu stays', async () => {
  const realm = makeRealm();
  realm.add('a', { href: '/elsewhere' }, [100, 100, 120, 40]);
  realm.arm();
  await realm.frame();
  realm.move(150, 120);
  realm.press(150, 120, 1);
  realm.release(150, 120, 1);
  const menu = realm.pointerEvent('contextmenu', 150, 120, { button: 2 });
  assert.deepEqual(pressesSeen(realm), []);
  const auxclick = realm.page.events.find((event) => event.type === 'auxclick');
  assert.equal(auxclick, undefined);
  assert.equal(menu.defaultPrevented, false, 'the browser context menu was cancelled');
  assert.equal(realm.picks().length, 0);
  assert.equal(realm.picker.isActive(), true);
});

test('picker events: a disabled control is picked, though Chrome sends it no mouse events', async () => {
  const realm = makeRealm();
  const save = realm.add('button', { type: 'submit', disabled: '' }, [100, 100, 120, 40]);
  realm.text(save, 'Save');
  realm.arm();
  await realm.frame();
  realm.click(150, 120);
  await realm.idle(1000);
  const [pick] = realm.picks();
  assert.ok(pick, 'the disabled button could not be picked');
  assert.equal(pick.element.html, '<button type="submit" disabled="">Save</button>');
});

test('picker events: the press picks what is under the pointer now, not a node the page has since replaced', async () => {
  const realm = makeRealm();
  const old = realm.add('div', { 'data-version': 'old' }, [100, 100, 200, 100]);
  realm.arm();
  await realm.frame();
  realm.move(150, 150);
  // The page renders again under a still pointer, with no frame in between.
  const fresh = new FakeElement(realm.doc, 'div', { 'data-version': 'new' });
  fresh.rect = [100, 100, 200, 100];
  old.replaceWith(fresh);
  realm.press(150, 150);
  realm.release(150, 150);
  await realm.idle(1000);
  const [pick] = realm.picks();
  assert.ok(pick);
  assert.equal(pick.element.attributes['data-version'], 'new');
});

test('picker events: events a page script dispatched neither pick nor cancel, and still reach the page', async () => {
  const realm = makeRealm();
  realm.add('div', { id: 'target' }, [100, 100, 200, 100]);
  realm.arm();
  await realm.frame();
  realm.move(150, 150);
  const forged = { isTrusted: false, clientX: 150, clientY: 150 };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) realm.deliver(type, forged);
  realm.deliver('keydown', { isTrusted: false, key: 'Escape' });
  realm.deliver('keydown', { isTrusted: false, key: 'Enter' });
  await realm.idle(1000);
  assert.deepEqual(realm.sent, []);
  assert.equal(realm.picker.isActive(), true);
  assert.deepEqual(pressesSeen(realm), ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'keydown', 'keydown']);
  // The user's own click still picks.
  realm.click(150, 150);
  await realm.idle(1000);
  assert.equal(realm.picks().length, 1);
});

test('picker events: a tab with no collector waits out the lookup once, not on every pick', async () => {
  const realm = makeRealm();
  realm.add('div', { id: 'target' }, [100, 100, 200, 100]);
  const timeToPick = async () => {
    realm.arm();
    await realm.frame();
    const before = realm.picks().length;
    const started = realm.clock.now;
    realm.click(150, 150);
    for (let spent = 0; spent < 2000 && realm.picks().length === before; spent += 16) await realm.frame();
    assert.equal(realm.picks().length, before + 1, 'the pick never arrived');
    const took = realm.clock.now - started;
    await realm.idle(1200);
    return took;
  };
  assert.ok((await timeToPick()) >= 300, 'the first pick did not wait for an answer');
  const second = await timeToPick();
  assert.ok(second < 200, `the second pick waited ${second} ms for a collector that is not there`);
  // A collector that answers is heard again from the next arm on.
  realm.collector((data) => (data.action === 'inspect' ? { component: { framework: 'react', names: ['Card'] } } : null));
  realm.arm();
  await realm.frame();
  realm.picker.stop();
  await timeToPick();
  assert.deepEqual(realm.picks().at(-1).element.component, { framework: 'react', names: ['Card'], hops: 0 });
});

test('picker events: the payload carries no field that nothing reads', async () => {
  const realm = makeRealm();
  realm.add('div', { class: 'a b', style: `background: url(${'x'.repeat(5000)})` }, [100, 100, 200, 100]);
  realm.arm();
  await realm.frame();
  realm.click(150, 150);
  await realm.idle(1000);
  const [pick] = realm.picks();
  for (const unread of ['tagName', 'classes', 'inlineStyle']) {
    assert.equal(unread in pick.element, false, `${unread} is still sent`);
  }
});

test('picker events: a selector in a repeated structure matches its own element only', async () => {
  const realm = makeRealm();
  const build = (top) => {
    let node = realm.add('section', { class: 'card' }, null);
    for (let depth = 0; depth < 8; depth += 1) node = realm.add('div', { class: 'row' }, null, node);
    return realm.add('a', { class: 'link' }, [100, top, 50, 20], node);
  };
  build(100);
  const second = build(300);
  realm.arm();
  await realm.frame();
  realm.click(110, 310);
  await realm.idle(1000);
  const { selector } = realm.picks()[0].element;
  const found = realm.doc.querySelectorAll(selector);
  assert.equal(found.length, 1, `${selector} matches ${found.length} elements`);
  assert.equal(found[0], second);
});

test('picker events: a long selector fits what the template prints, and keeps the element\'s own level', async () => {
  const realm = makeRealm();
  const classes = (n) => `layout-column-${n}-xyz responsive-flex-${n}-abc theme-surface-${n}-def`;
  const make = (top) => {
    let node = realm.add('main', { class: classes(0) }, null);
    for (let depth = 1; depth < 8; depth += 1) node = realm.add('div', { class: classes(depth) }, null, node);
    return realm.add('button', { class: 'primary-action' }, [100, top, 80, 30], node);
  };
  make(100);
  make(300);
  realm.arm();
  await realm.frame();
  realm.click(110, 310);
  await realm.idle(1000);
  const { selector } = realm.picks()[0].element;
  assert.ok(selector.length <= 200, `${selector.length} characters: ${selector}`);
  assert.match(selector, /button\.primary-action$/);
});

test('picker events: a frame lets the pointer through to the page, is picked whole, and no event of the press goes into it', async () => {
  const realm = makeRealm();
  realm.add('iframe', { src: '/preview?token=T1', title: 'Preview' }, [0, 200, 600, 400]);
  realm.arm();
  await realm.frame();
  realm.move(300, 400);
  assert.equal(realm.part('box').style.display, 'block', 'nothing was highlighted over the frame');
  realm.press(300, 400);
  realm.release(300, 400);
  // The second press of a double click, while the pick is being sent: the
  // frame still lets the pointer through, though nothing of the picker's is
  // shown any more.
  await realm.frame();
  realm.press(300, 400);
  realm.release(300, 400);
  realm.pointerEvent('dblclick', 300, 400);
  await realm.idle(1000);
  assert.deepEqual(realm.page.framed, [], 'events went into the frame');
  assert.deepEqual(pressesSeen(realm), []);
  const [pick] = realm.picks();
  assert.ok(pick, 'the frame could not be picked');
  assert.match(pick.element.html, /^<iframe src="\/preview\?token=<redacted>" title="Preview">/);
  // No shield was needed, and once the tail is over the frame takes the
  // pointer again: the page's own sheets are as they were.
  assert.equal(realm.doc.adoptedStyleSheets.length, 1);
  await realm.idle(1500);
  assert.equal(realm.doc.adoptedStyleSheets.length, 0);
  realm.click(300, 400);
  assert.deepEqual(pressesFramed(realm), ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
});

// R3 (medium): the frame's shield lay above everything in the page, so a
// hover menu drawn over a frame lost its hover as the pointer reached the
// part over the frame, and the frame was picked instead of the item.
test('picker events: a hover menu drawn over a frame keeps its hover, and its item is picked, not the frame', async () => {
  const realm = makeRealm();
  // In tree order the frame comes first, so the menu paints above it.
  realm.add('iframe', { id: 'fr', src: '/embed' }, [0, 100, 600, 300]);
  const menu = realm.add('nav', { class: 'menu' }, [0, 40, 140, 40]);
  const sub = realm.add('div', { class: 'sub' }, [0, 80, 200, 120], menu);
  sub.shownWhile = menu;
  const item = realm.add('a', { id: 'c3', href: '#3' }, [0, 150, 200, 40], sub);
  item.look = (hovered) => ({ display: 'block', 'background-color': hovered ? 'rgb(0, 0, 200)' : 'rgb(255, 255, 255)' });
  realm.text(item, 'Item three');
  let atSend = null;
  realm.onSend = (message) => {
    if (message.type === 'cdr:element-picked') atSend = { top: realm.doc.rawTop(50, 170), shown: realm.doc.rendered(item) };
  };
  realm.arm();
  await realm.frame();
  realm.move(50, 60);
  await realm.frame();
  realm.move(50, 120);
  await realm.frame();
  realm.move(50, 170);
  await realm.frame();
  assert.equal(realm.doc.rendered(item), true, 'the menu closed as the pointer reached the part over the frame');
  assert.equal(realm.doc.rawTop(50, 170), item);
  realm.press(50, 170);
  realm.release(50, 170);
  await realm.idle(1000);
  const [pick] = realm.picks();
  assert.equal(pick?.element.selector, '#c3');
  assert.equal(pick.element.hovered, true);
  assert.equal(pick.element.styles['background-color'], 'rgb(0, 0, 200)');
  assert.deepEqual(atSend, { top: item, shown: true }, 'the menu was covered or closed when the panel photographed it');
  assert.deepEqual(realm.page.framed, []);
  assert.deepEqual(pressesSeen(realm), []);
  await realm.idle(1500);
  // Beside the menu, where nothing is drawn over it, the frame is picked
  // whole and hears nothing, a double click's second press included.
  realm.arm();
  await realm.frame();
  realm.move(400, 300);
  await realm.frame();
  realm.press(400, 300);
  realm.release(400, 300);
  await realm.frame();
  realm.press(400, 300);
  realm.release(400, 300);
  realm.pointerEvent('dblclick', 400, 300);
  await realm.idle(1000);
  assert.equal(realm.picks()[1]?.element.selector, '#fr');
  assert.deepEqual(realm.page.framed, []);
  assert.deepEqual(pressesSeen(realm), []);
});

test('picker events: a frame in an open shadow root lets the pointer through too, and its tree is left as it was', async () => {
  const realm = makeRealm();
  const widget = realm.add('x-player', {}, [100, 100, 400, 300]);
  const root = widget.attachShadow({ mode: 'open' });
  const own = new realm.window.CSSStyleSheet();
  root.adoptedStyleSheets = [own];
  const frame = new FakeElement(realm.doc, 'iframe', { class: 'video', src: '/v' });
  frame.rect = [100, 100, 400, 300];
  root.appendChild(frame);
  realm.arm();
  await realm.frame();
  realm.click(300, 250);
  await realm.idle(1000);
  assert.deepEqual(realm.page.framed, [], 'events went into the frame');
  assert.deepEqual(pressesSeen(realm), []);
  assert.equal(realm.picks()[0]?.element.selector, 'x-player >>> iframe.video');
  await realm.idle(1500);
  assert.equal(root.adoptedStyleSheets.length, 1);
  assert.equal(root.adoptedStyleSheets[0], own);
});

test('picker events: a frame whose own rule wins over the picker\'s sheet is shielded instead', async () => {
  const realm = makeRealm();
  const frame = realm.add('iframe', { id: 'stubborn', src: '/embed' }, [0, 200, 600, 400]);
  frame.pageWins = true;
  realm.arm();
  await realm.frame();
  const shields = realm.part('shields').children;
  assert.equal(shields.filter((shield) => shield.style.display === 'block').length, 1, 'the frame has no shield');
  realm.click(300, 400);
  await realm.frame();
  realm.press(300, 400);
  realm.release(300, 400);
  await realm.idle(1000);
  assert.deepEqual(realm.page.framed, [], 'events went into the frame');
  assert.equal(realm.picks()[0]?.element.selector, '#stubborn');
});

test('picker events: an element inside an open shadow root is picked, and the selector names its host', async () => {
  const realm = makeRealm();
  const card = realm.add('x-card', {}, [100, 100, 300, 100]);
  const root = card.attachShadow({ mode: 'open' });
  const save = new FakeElement(realm.doc, 'button', { class: 'save' });
  save.rect = [120, 120, 80, 30];
  root.appendChild(save);
  save.appendChild(new FakeText(realm.doc, 'Save'));
  realm.arm();
  await realm.frame();
  realm.click(150, 130);
  await realm.idle(1500);
  const [pick] = realm.picks();
  assert.equal(pick.element.html, '<button class="save">Save</button>');
  assert.equal(pick.element.selector, 'x-card >>> button.save');
});

// F37 (the picker's part): a closed shadow root stopped the pick at its
// host, and a frame inside one kept the pointer, so a press went into the
// frame and nothing was picked. A content script can ask Chrome for the
// root (chrome.dom.openOrClosedShadowRoot, checked in Chrome 156).
test('picker events: an element and a frame inside a closed shadow root are reached as in an open one', async () => {
  const realm = makeRealm();
  const sealed = realm.add('x-sealed', {}, [100, 100, 300, 100]);
  const closed = sealed.attachShadow({ mode: 'closed' });
  const hidden = new FakeElement(realm.doc, 'button', { class: 'pay' });
  hidden.rect = [120, 120, 80, 30];
  closed.appendChild(hidden);
  hidden.appendChild(new FakeText(realm.doc, 'Pay'));
  const player = realm.add('x-player', {}, [100, 300, 400, 200]);
  const inner = player.attachShadow({ mode: 'closed' });
  const frame = new FakeElement(realm.doc, 'iframe', { class: 'video', src: '/v' });
  frame.rect = [100, 300, 400, 200];
  inner.appendChild(frame);
  realm.arm();
  await realm.frame();
  realm.click(150, 130);
  await realm.idle(1500);
  assert.equal(realm.picks()[0]?.element.html, '<button class="pay">Pay</button>');
  assert.equal(realm.picks()[0].element.selector, 'x-sealed >>> button.pay');
  realm.arm();
  await realm.frame();
  realm.click(300, 400);
  await realm.idle(1500);
  assert.deepEqual(realm.page.framed, [], 'events went into the frame');
  assert.equal(realm.picks()[1]?.element.selector, 'x-player >>> iframe.video');
  assert.equal(inner.adoptedStyleSheets.length, 0, 'the closed root\'s own sheets were not left as they were');
  // A div's closed root attached after the arm: found as the pointer
  // reaches the frame in it, by the frame's mouseover, seen from window as
  // the host's, before the press.
  const late = realm.add('div', { id: 'late' }, [600, 100, 300, 300]);
  realm.arm();
  await realm.frame();
  const lateRoot = late.attachShadow({ mode: 'closed' });
  const lateFrame = new FakeElement(realm.doc, 'iframe', { id: 'chat', src: '/chat' });
  lateFrame.rect = [600, 100, 300, 300];
  lateRoot.appendChild(lateFrame);
  realm.move(700, 200);
  realm.deliver('mouseover', { target: late, deep: lateFrame, clientX: 700, clientY: 200 });
  realm.press(700, 200);
  realm.release(700, 200);
  await realm.idle(1500);
  assert.deepEqual(pressesFramed(realm), [], 'the press went into the frame');
  assert.equal(realm.picks()[2]?.element.selector, '#late >>> #chat');
});

// V3-picker-3 (F37): a pick inside a closed shadow root put its marker on the
// element, where the page's own world, which reads the component and the
// handlers, cannot look. The pick lost the component and handlers 0.6.0
// reported through the host, and the component's own observers saw the
// marker come and go inside its root. The marker goes on the host of the
// outermost closed root now, and what is read there is said to be the
// host's.
test('picker events: a pick inside a closed shadow root is inspected through its host, and nothing is written inside the root', async () => {
  const realm = makeRealm();
  const doc = realm.doc;
  const sealed = realm.add('x-sealed', { id: 'sealed', class: 'card wide extra' }, [100, 100, 300, 100]);
  const wrap = sealed.attachShadow({ mode: 'closed' }).appendChild(new FakeElement(doc, 'div', { class: 'wrap' }));
  const pay = wrap.appendChild(new FakeElement(doc, 'button', { class: 'pay' }));
  pay.rect = [120, 120, 80, 30];
  // A closed root holding an open one: x-outer (closed) > section > x-inner (open) > span.
  const outer = realm.add('x-outer', {}, [100, 300, 300, 100]);
  const section = outer.attachShadow({ mode: 'closed' }).appendChild(new FakeElement(doc, 'section'));
  const deep = section.appendChild(new FakeElement(doc, 'x-inner')).attachShadow({ mode: 'open' })
    .appendChild(new FakeElement(doc, 'span', { class: 'deep' }));
  deep.rect = [120, 320, 100, 40];
  // An element in no closed root, for the reply as it always was.
  realm.add('div', { id: 'plain' }, [600, 100, 200, 100]);
  const marked = [];
  const inspected = [];
  // The page's world finds a mark in the document and in open shadow roots,
  // and no further, as collector-main's findMarked does.
  const find = (scope, marker) => {
    for (const child of scope.children) {
      if (child.getAttribute('data-cdr-pick') === marker) return child;
      const found = (child.shadowRoot && find(child.shadowRoot, marker)) || find(child, marker);
      if (found) return found;
    }
    return null;
  };
  realm.collector((data) => {
    if (data.action !== 'inspect') return null;
    const node = find(doc, data.marker);
    inspected.push(node);
    if (!node) return null;
    return { component: { framework: 'react', names: ['PaymentCard'], hops: 0 }, handlers: { list: ['onClick=ƒ pay'], hops: 0 } };
  });
  const setAttribute = FakeElement.prototype.setAttribute;
  FakeElement.prototype.setAttribute = function (name, value) {
    if (name === 'data-cdr-pick') marked.push(this);
    return setAttribute.call(this, name, value);
  };
  try {
    for (const [x, y] of [[150, 130], [150, 330], [650, 150]]) {
      realm.arm();
      await realm.frame();
      realm.click(x, y);
      await realm.idle(1500);
    }
  } finally {
    FakeElement.prototype.setAttribute = setAttribute;
  }
  const [first, second, third] = realm.picks().map((pick) => pick.element);
  assert.equal(first.selector, '#sealed >>> button.pay');
  assert.deepEqual(first.component, { framework: 'react', names: ['PaymentCard'], hops: 2, closedHost: 'x-sealed.card.wide' });
  assert.deepEqual(first.handlers, { list: ['onClick=ƒ pay'], hops: 2, label: 'x-sealed.card.wide' });
  assert.equal(second.selector, 'x-outer >>> x-inner >>> span.deep');
  assert.deepEqual(second.component, { framework: 'react', names: ['PaymentCard'], hops: 3, closedHost: 'x-outer' });
  assert.deepEqual(second.handlers, { list: ['onClick=ƒ pay'], hops: 3, label: 'x-outer' });
  // Elsewhere the reply is taken as it comes.
  assert.deepEqual(third.component, { framework: 'react', names: ['PaymentCard'], hops: 0 });
  assert.deepEqual(third.handlers, { list: ['onClick=ƒ pay'], hops: 0 });
  assert.deepEqual(inspected.map((node) => node?.localName ?? null), ['x-sealed', 'x-outer', 'div']);
  assert.deepEqual(marked.filter(insideClosed), [], 'a mark was set inside a closed shadow root');
  assert.equal([sealed, outer, pay, deep].some((node) => node.hasAttribute('data-cdr-pick')), false, 'a mark was left behind');
});

test('picker events: an element is read in the hover state it was picked in, and the payload says so', async () => {
  const realm = makeRealm();
  const look = (on, off) => (hovered) => ({ display: 'inline-block', 'background-color': hovered ? on : off });
  const cta = realm.add('button', { class: 'cta' }, [100, 100, 120, 40]);
  cta.look = look('rgb(255, 0, 0)', 'rgb(0, 0, 255)');
  realm.add('p', { class: 'aside' }, [600, 100, 120, 40]);
  realm.arm();
  await realm.frame();
  realm.click(150, 120);
  await realm.idle(1000);
  const [pick] = realm.picks();
  assert.equal(pick.element.styles['background-color'], 'rgb(255, 0, 0)');
  assert.equal(pick.element.hovered, true);
  // A modal dialog clicked is hovered as anything else is.
  const dialog = realm.add('dialog', {}, [300, 300, 300, 200]);
  dialog.look = look('rgb(1, 1, 1)', 'rgb(2, 2, 2)');
  realm.doc.showModal(dialog);
  realm.arm();
  await realm.frame();
  realm.click(400, 400);
  await realm.idle(1000);
  assert.equal(realm.picks()[1].element.styles['background-color'], 'rgb(1, 1, 1)');
  assert.equal(realm.picks()[1].element.hovered, true);
  dialog.remove();
  // A tap that picks is read once the tap has moved the hover to it, which
  // is the state it is photographed in, and the page hears none of it.
  realm.arm();
  await realm.frame();
  realm.tap(150, 120);
  await realm.idle(1000);
  const tapped = realm.picks()[2];
  assert.ok(tapped, 'a tap picked nothing');
  assert.equal(tapped.element.styles['background-color'], 'rgb(255, 0, 0)');
  assert.equal(tapped.element.hovered, true);
  assert.deepEqual(realm.page.seen.filter((type) => !/move$/.test(type)), [], 'the page heard the tap');
  // Enter with the pointer elsewhere takes the resting state, and says
  // nothing of a hover. (The last pick's tail is let run out first.)
  await realm.idle(1500);
  realm.doc.sticky = false;
  realm.move(650, 120);
  realm.doc.focused = cta;
  realm.arm();
  await realm.frame();
  realm.key('Enter');
  realm.key('Enter');
  await realm.idle(1000);
  const keyed = realm.picks()[3];
  assert.ok(keyed, 'Enter picked nothing');
  assert.equal(keyed.element.styles['background-color'], 'rgb(0, 0, 255)');
  assert.equal('hovered' in keyed.element, false);
});

test('picker events: an element that exists only while its menu is hovered is read and left open for the screenshot', async () => {
  const realm = makeRealm();
  const menu = realm.add('nav', { class: 'menu' }, [100, 100, 140, 40]);
  const sub = realm.add('div', { class: 'sub' }, [100, 140, 200, 80], menu);
  sub.shownWhile = menu;
  const item = realm.add('a', { class: 'item', href: '/settings' }, [100, 140, 200, 40], sub);
  item.look = (hovered) => ({ display: 'block', 'background-color': hovered ? 'rgb(0, 0, 200)' : 'rgb(255, 255, 255)' });
  realm.text(item, 'Settings');
  let atSend = null;
  realm.onSend = (message) => {
    if (message.type !== 'cdr:element-picked') return;
    // What the panel photographs: is anything of the picker's still over
    // the item, and is the item still there?
    atSend = { top: realm.doc.rawTop(150, 160), rect: item.getBoundingClientRect() };
  };
  realm.arm();
  await realm.frame();
  realm.move(150, 120);
  await realm.frame();
  realm.move(150, 160);
  await realm.frame();
  realm.press(150, 160);
  realm.release(150, 160);
  // Nothing of the picker's covers the item between the press and the
  // screenshot, so a second press lands on the item and nothing else.
  assert.equal(realm.doc.rawTop(150, 160), item, 'something covers the picked element');
  await realm.idle(1000);
  const [pick] = realm.picks();
  assert.ok(pick, 'nothing was picked');
  assert.deepEqual(pick.rect, { x: 96, y: 136, width: 208, height: 48 });
  assert.equal(pick.element.text, 'Settings');
  assert.equal(pick.element.styles['background-color'], 'rgb(0, 0, 200)');
  assert.equal(pick.element.hovered, true);
  assert.equal(atSend.top, item, 'the item was covered or gone when the panel photographed it');
  assert.deepEqual([atSend.rect.left, atSend.rect.top], [100, 140]);
  assert.deepEqual(pressesSeen(realm), []);
});

test('picker events: the element is measured as the page stands when it is photographed', async () => {
  // A dialog whose rows are spaced by :not(:last-child), as Tailwind's
  // space-y does. With the host as its last child, the last row is no
  // longer the last child, and the centred dialog moves up.
  const make = (framed) => {
    const realm = makeRealm();
    const dialog = realm.add('dialog', { class: 'space-y-4' }, [200, 150, 400, 300]);
    if (framed) realm.add('iframe', { src: '/embed' }, [220, 160, 300, 100], dialog);
    realm.add('div', { class: 'row' }, [220, 300, 300, 40], dialog);
    const last = realm.add('div', { class: 'row' }, null, dialog);
    const hosted = () => dialog.children.some((child) => child.hasAttribute('data-cdr-picker'));
    last.rect = () => [220, hosted() ? 378 : 386, 300, 40];
    realm.doc.showModal(dialog);
    return { realm, dialog, last };
  };
  for (const [framed, stubborn] of [[false, false], [true, false], [true, true]]) {
    const { realm, dialog, last } = make(framed);
    if (stubborn) dialog.children.find((child) => child.localName === 'iframe').pageWins = true;
    let photographed = null;
    realm.onSend = (message) => {
      if (message.type === 'cdr:element-picked') photographed = last.getBoundingClientRect().top;
    };
    realm.arm();
    await realm.frame();
    // A dialog keeps its layout while armed, a frame in it too, since the
    // frame lets the pointer through and needs no shield in the dialog. Only
    // a frame the picker's sheet cannot reach puts the host there.
    if (!stubborn) assert.equal(last.getBoundingClientRect().top, 386, 'the dialog moved when armed');
    else assert.equal(realm.host().parentNode, dialog, 'the frame in the dialog has no shield that works');
    realm.click(300, 400);
    await realm.idle(1000);
    const [pick] = realm.picks();
    assert.ok(pick, 'nothing was picked');
    assert.equal(pick.rect.y + 4, photographed, `framed ${framed}: measured at ${pick.rect.y + 4}, photographed at ${photographed}`);
    assert.deepEqual(realm.page.framed, []);
  }
});

test('picker events: a modal dialog removed while armed does not take the highlight with it', async () => {
  const realm = makeRealm();
  realm.add('div', { id: 'card' }, [600, 100, 200, 100]);
  const dialog = realm.add('dialog', { id: 'dlg' }, [100, 300, 300, 200]);
  // A frame in the dialog that the picker's sheet cannot reach puts the
  // host in the dialog, for its shield.
  realm.add('iframe', { src: '/embed' }, [120, 320, 200, 100], dialog).pageWins = true;
  realm.doc.showModal(dialog);
  realm.arm();
  await realm.frame();
  assert.equal(realm.host()?.parentNode, dialog);
  // The page removes the dialog outright, which fires no close event.
  dialog.remove();
  await realm.frame();
  const host = realm.host();
  assert.ok(host && host.isConnected, 'the host went with the dialog');
  realm.move(650, 150);
  assert.equal(realm.part('box').style.display, 'block', 'nothing is highlighted');
  realm.click(650, 150);
  await realm.idle(1000);
  assert.equal(realm.picks()[0].element.selector, '#card');
});

test('picker events: the keyboard finds an element to start from when the middle of the page is its background', async () => {
  const realm = makeRealm();
  // Nothing is focused, and the only content is a header at the top.
  realm.add('header', { class: 'top' }, [0, 0, 1000, 60]);
  realm.arm();
  await realm.frame();
  realm.key('ArrowDown');
  assert.equal(realm.part('box').style.display, 'block', 'the first key highlighted nothing');
  assert.deepEqual(pressesSeen(realm), []);
  realm.key('Enter');
  await realm.idle(1000);
  assert.match(realm.picks()[0]?.element.html ?? '', /^<header class="top">/);
  // A page with nothing to highlight leaves the keys to the page.
  const empty = makeRealm();
  empty.arm();
  await empty.frame();
  empty.key('ArrowDown');
  empty.key('Enter');
  assert.deepEqual(pressesSeen(empty), ['keydown', 'keyup', 'keydown', 'keyup']);
  assert.equal(empty.picker.key('ArrowDown'), false);
  assert.equal(empty.picker.isActive(), true);
});

test('picker events: a selector through many nested shadow roots still finds the element from the document', async () => {
  const realm = makeRealm();
  const names = ['app-shell-layout', 'app-main-content', 'feature-settings-page', 'settings-panel-section',
    'account-preferences-form', 'preference-toggle-row', 'toggle-switch-control', 'switch-thumb'];
  const build = (top) => {
    let parent = realm.add('div', { class: 'mount' }, null);
    let host = null;
    for (const name of names) {
      host = new FakeElement(realm.doc, name);
      (parent.nodeType === 11 ? parent : parent).appendChild(host);
      parent = host.attachShadow({ mode: 'open' });
    }
    const knob = new FakeElement(realm.doc, 'button', { class: 'knob' });
    knob.rect = [100, top, 200, 30];
    parent.appendChild(knob);
    return knob;
  };
  build(100);
  const second = build(300);
  realm.arm();
  await realm.frame();
  realm.click(150, 310);
  await realm.idle(1000);
  const { selector } = realm.picks()[0].element;
  // As Puppeteer and WebdriverIO read >>>: each step inside the shadow root
  // of what the step before it found.
  let scopes = [realm.doc];
  let found = [];
  for (const part of selector.split(' >>> ')) {
    found = scopes.flatMap((scope) => scope.querySelectorAll(part));
    scopes = found.map((node) => node.shadowRoot).filter(Boolean);
  }
  assert.equal(found.length, 1, `${selector} finds ${found.length} elements`);
  assert.equal(found[0], second);
  assert.match(selector, /button\.knob$/);
});

test('picker events: a page ::backdrop rule cannot dim the page under the host', async () => {
  const realm = makeRealm();
  realm.arm();
  await realm.frame();
  const { html } = realm.host().attached;
  assert.match(html, /:host::backdrop\s*\{\s*display:\s*none\s*!important;?\s*\}/);
});

test('picker events: a second finger neither picks nor ends the first finger\'s press', async () => {
  const realm = makeRealm();
  realm.add('div', { id: 'target' }, [100, 100, 200, 100]);
  realm.arm();
  await realm.frame();
  const second = { pointerType: 'touch', isPrimary: false };
  realm.pointerEvent('pointerdown', 150, 150, { pointerType: 'touch', isPrimary: true });
  realm.pointerEvent('pointerdown', 250, 150, second);
  realm.pointerEvent('pointerup', 250, 150, second);
  await realm.idle(1000);
  assert.equal(realm.picks().length, 0, 'the second finger picked');
  assert.equal(realm.picker.isActive(), true);
  realm.pointerEvent('pointerup', 150, 150, { pointerType: 'touch', isPrimary: true });
  await realm.idle(1000);
  assert.equal(realm.picks().length, 1, 'the first finger no longer picks');
});

test('picker events: with a modal dialog open, the highlight is drawn in the top layer, above the dialog', async () => {
  const realm = makeRealm();
  realm.add('div', { id: 'behind' }, [0, 0, 1000, 800]);
  const dialog = realm.add('dialog', {}, [200, 150, 400, 300]);
  const ok = realm.add('button', { id: 'ok' }, [250, 200, 80, 30], dialog);
  realm.doc.showModal(dialog);
  realm.arm();
  await realm.frame();
  const host = realm.host();
  // Nothing in the dialog needs a shield, so the host stays out of it, where
  // it cannot change what the dialog's own rules match.
  assert.equal(host.parentNode, realm.doc.body);
  assert.equal(host.popoverOpen, true, 'the host is not in the top layer');
  assert.equal(realm.doc.topLayer.at(-1), host, 'the host is under the dialog');
  realm.click(260, 210);
  await realm.idle(1000);
  assert.equal(realm.picks()[0].element.selector, '#ok');
  assert.equal(realm.picks()[0].element.html, ok.outerHTML);
  // A frame in the dialog lets the pointer through, so the host stays out
  // of the dialog with it.
  const frame = realm.add('iframe', { id: 'embed', src: '/embed' }, [250, 300, 200, 100], dialog);
  realm.arm();
  await realm.frame();
  assert.equal(realm.host().parentNode, realm.doc.body);
  assert.equal(realm.doc.topLayer.at(-1), realm.host());
  realm.click(300, 350);
  await realm.idle(1000);
  assert.deepEqual(realm.page.framed, [], 'events went into the frame');
  assert.equal(realm.picks()[1].element.selector, '#embed');
  assert.equal(realm.picks()[1].element.html, frame.outerHTML);
  await realm.idle(1500);
  // One the sheet cannot reach is shielded, and outside the dialog a shield
  // would be inert and the press would go into the frame.
  frame.pageWins = true;
  realm.arm();
  await realm.frame();
  assert.equal(realm.host().parentNode, dialog, 'the host is outside the dialog, where everything is inert');
  assert.equal(realm.doc.topLayer.at(-1), realm.host());
  realm.click(300, 350);
  await realm.idle(1000);
  assert.deepEqual(realm.page.framed, [], 'events went into the frame');
  assert.equal(realm.picks()[2].element.selector, '#embed');
});

test('picker events: the arrow keys widen and narrow the pick, and Enter or a click takes it', async () => {
  const realm = makeRealm();
  const list = realm.add('ul', { class: 'menu' }, [100, 100, 200, 300]);
  const item = realm.add('li', { class: 'item' }, [100, 100, 200, 40], list);
  realm.add('a', { class: 'link' }, [110, 110, 50, 20], item);
  realm.arm();
  await realm.frame();
  realm.move(120, 115);
  realm.key('ArrowUp');
  realm.key('ArrowUp');
  realm.key('ArrowDown');
  assert.deepEqual(pressesSeen(realm), [], 'the page saw the keys the picker answered');
  // A shortcut is not the picker's.
  realm.key('ArrowUp', { metaKey: true });
  assert.deepEqual(pressesSeen(realm), ['keydown', 'keyup']);
  realm.key('Enter');
  await realm.idle(1000);
  assert.match(realm.picks()[0].element.html, /^<li class="item">/);
  // A click over the same element takes what the keys stepped to.
  realm.arm();
  await realm.frame();
  realm.move(120, 115);
  realm.key('ArrowUp');
  realm.key('ArrowUp');
  realm.press(120, 115);
  realm.release(120, 115);
  await realm.idle(1000);
  assert.match(realm.picks()[1].element.html, /^<ul class="menu">/);
});

test('picker events: the panel can hand the picker its keys', async () => {
  const realm = makeRealm();
  const list = realm.add('ul', {}, [100, 100, 200, 300]);
  realm.add('li', { class: 'item' }, [100, 100, 200, 40], list);
  realm.arm();
  await realm.frame();
  realm.move(120, 115);
  assert.equal(typeof realm.picker.key, 'function', 'the controller takes no keys');
  assert.equal(realm.picker.key('ArrowUp'), true);
  assert.equal(realm.picker.key('q'), false);
  assert.equal(realm.picker.key('Enter'), true);
  await realm.idle(1000);
  assert.match(realm.picks()[0].element.html, /^<ul>/);
  assert.equal(realm.picker.key('ArrowUp'), false, 'a disarmed picker took a key');
});

test('picker events: a call site read from a stack keeps saying so, and nothing else passes for it', async () => {
  for (const [sourceFrom, kept] of [['stack', true], ['STACK', false], [' stack', false], ['debugSource', false], [true, false]]) {
    const realm = makeRealm();
    realm.add('div', { id: 'target' }, [100, 100, 200, 100]);
    realm.collector((data) =>
      data.action === 'inspect'
        ? { component: { framework: 'react', names: ['Card'], source: '/src/Card.jsx:12:5', sourceFrom }, handlers: null }
        : null
    );
    realm.arm();
    await realm.frame();
    realm.click(150, 150);
    await realm.idle(1000);
    const { component } = realm.picks()[0].element;
    assert.equal(component.source, '/src/Card.jsx:12:5');
    assert.equal(component.sourceFrom, kept ? 'stack' : undefined, JSON.stringify(sourceFrom));
  }
});

// REVIEW lead 8: every framework but 'vue' was rebuilt as 'react', so a
// Svelte component would have printed as a React one. The four the collector
// reads are kept as they came, and a component of any other framework is
// dropped, rather than printed with another framework's wording.
test('picker events: a Svelte or an Angular component keeps its framework, and one of a framework no collector reads is dropped', async () => {
  const sent = {
    svelte: { framework: 'svelte', version: '5', build: 'development', names: ['CouponField', '+page'], source: 'src/lib/CouponField.svelte:14:5', props: ['value="SUMMER25"'] },
    angular: { framework: 'angular', version: '22.3.0', build: 'development', names: ['CouponFieldComponent'], source: 'src/app/coupon-field.component.ts:12', hops: 2 },
    vue: { framework: 'vue', version: '2.7.16', names: ['CouponField', 'App'], source: 'src/components/CouponField.vue' },
    solid: { framework: 'solid', names: ['Counter'] },
    toString: { framework: 'toString', names: ['Counter'] },
    missing: { names: ['Counter'] },
  };
  for (const [label, component] of Object.entries(sent)) {
    const realm = makeRealm();
    realm.add('div', { id: 'target' }, [100, 100, 200, 100]);
    realm.collector((data) => (data.action === 'inspect' ? { component, handlers: null } : null));
    realm.arm();
    await realm.frame();
    realm.click(150, 150);
    await realm.idle(1000);
    const picked = realm.picks()[0].element.component;
    if (['svelte', 'angular', 'vue'].includes(label)) {
      assert.deepEqual(picked, { hops: 0, ...component }, label);
    } else {
      // Absent, as on a page with no component.
      assert.equal(picked, undefined, `${label}: a component of a framework no collector reads was kept`);
    }
  }
});

// F28 and CW2. Each start names its run, answers the injection with it and
// puts it on every message, so a late message from an earlier run cannot end
// a newer arm; and a pick sends the visual viewport the panel crops through.
test('picker events: a start names its run, and its pick and its cancel carry it', async () => {
  const realm = makeRealm();
  realm.window.visualViewport = { offsetLeft: 40, offsetTop: 30, width: 500, height: 350, scale: 2 };
  realm.add('div', { class: 'card' }, [100, 100, 200, 100]);
  const first = realm.arm();
  assert.equal(typeof first, 'string', 'the injection does not answer with the run');
  assert.equal(realm.arm(), first, 'a start while armed began another run');
  await realm.frame();
  realm.click(150, 150);
  await realm.idle(1000);
  const [pick] = realm.picks();
  assert.equal(pick?.run, first);
  assert.deepEqual(pick.viewport.visual, { x: 40, y: 30, width: 500, height: 350, scale: 2 });

  const second = realm.arm();
  assert.notEqual(second, first);
  await realm.frame();
  realm.key('Escape');
  const cancel = realm.sent.find((message) => message.type === 'cdr:capture-cancelled');
  assert.equal(cancel?.run, second);
});

/** Frames until the clock reads `at`. */
async function until(realm, at) {
  while (realm.clock.now < at) await realm.frame();
}

// R3: the tail ended on its timer with a press still down, and the page
// heard the rest of it as a click without its pointerdown: a link was
// followed, a box ticked.
test('picker events: a press begun at the end of the tail is kept from the page to its end', async () => {
  const realm = makeRealm();
  realm.add('div', { id: 'neutral' }, [100, 100, 100, 40]);
  realm.add('a', { id: 'lnk', href: '/a' }, [100, 200, 100, 30]);
  let sentAt = null;
  realm.onSend = (message) => {
    if (message.type === 'cdr:element-picked') sentAt = realm.clock.now;
  };
  realm.arm();
  await realm.frame();
  realm.click(150, 120);
  while (sentAt === null) await realm.frame();
  // Pressed 950 ms after the pick was sent, released 200 ms later, after
  // the tail's 1000 ms.
  await until(realm, sentAt + 950);
  realm.move(150, 215);
  realm.press(150, 215);
  await until(realm, sentAt + 1150);
  realm.release(150, 215);
  realm.pointerEvent('dblclick', 150, 215);
  assert.deepEqual(pressesSeen(realm), [], 'the page heard the rest of a press begun in the tail');
  // Once it has ended, the page has its pointer back.
  await realm.idle(100);
  realm.click(150, 215);
  assert.deepEqual(pressesSeen(realm), ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
});

test('picker events: a press held in the tail does not keep the page from its pointer for ever', async () => {
  const realm = makeRealm();
  realm.add('div', { id: 'neutral' }, [100, 100, 100, 40]);
  realm.arm();
  await realm.frame();
  const begun = realm.clock.now;
  realm.click(150, 120);
  await realm.frame();
  realm.press(150, 120);
  await until(realm, begun + 6000);
  realm.release(150, 120);
  // Past TAIL_LIMIT_MS the rest of that press reaches the page.
  assert.deepEqual(pressesSeen(realm), ['pointerup', 'mouseup', 'click']);
  assert.equal(realm.picks().length, 1);
});

// R3: the walk for a start took the first element with any box at all in
// view, which was a skip link clipped to one pixel or a hidden banner.
test('picker events: the keyboard starts only from an element the user can see', async () => {
  const realm = makeRealm();
  realm.add('a', { id: 'skip', class: 'screen-reader-text', href: '#main' }, [0, 0, 1, 1]);
  realm.add('div', { id: 'ghost' }, [0, 0, 1000, 40]).look = () => ({ visibility: 'hidden' });
  realm.add('div', { id: 'faded' }, [0, 0, 1000, 40]).look = () => ({ opacity: '0' });
  const banner = realm.add('div', { id: 'banner' }, [0, 0, 1000, 40]);
  banner.look = () => ({ visibility: 'hidden' });
  realm.add('span', { id: 'inherits' }, [0, 0, 300, 20], banner);
  realm.add('div', { id: 'sliver' }, [0, -100, 1000, 102]);
  // A see through veil over every point the keyboard looks at first.
  realm.add('div', { id: 'veil' }, [0, 150, 1000, 650]).look = () => ({ opacity: '0' });
  realm.add('header', { id: 'hd' }, [0, 40, 1000, 60]);
  realm.arm();
  await realm.frame();
  realm.key('ArrowDown');
  realm.key('Enter');
  await realm.idle(1000);
  assert.equal(realm.picks()[0]?.element.selector, '#hd');
  assert.deepEqual(pressesSeen(realm), []);
});

// R3: a right press (or Ctrl+click on macOS) selected the word under the
// pointer, which the page heard as selectstart and selectionchange; a
// finger's press told the page of the pointer capture it took.
test('picker events: a right press selects no word, and a finger\'s pointer capture is neither kept nor heard', async () => {
  const realm = makeRealm();
  const words = realm.add('p', { id: 'txt' }, [100, 100, 300, 40]);
  realm.add('div', { id: 'neutral' }, [100, 300, 100, 40]);
  realm.arm();
  await realm.frame();
  realm.move(150, 120);
  realm.press(150, 120, 2);
  const select = realm.pointerEvent('selectstart', 150, 120);
  const menu = realm.pointerEvent('contextmenu', 150, 120, { button: 2 });
  realm.release(150, 120, 2);
  assert.equal(select.defaultPrevented, true, 'the word under the pointer was selected');
  assert.equal(menu.defaultPrevented, false, 'the browser context menu was cancelled');
  assert.deepEqual(pressesSeen(realm), []);
  // A finger picks: its capture is let go as the press begins, so it is
  // never announced, and a capture event that comes anyway is stopped.
  realm.tap(150, 320);
  assert.equal(realm.page.seen.includes('gotpointercapture'), false);
  assert.equal(realm.page.seen.includes('lostpointercapture'), false);
  realm.deliver('lostpointercapture', { target: words, pointerType: 'touch', pointerId: 3 });
  // And in the tail, the same.
  await realm.frame();
  realm.press(150, 120, 2);
  const late = realm.pointerEvent('selectstart', 150, 120);
  realm.release(150, 120, 2);
  assert.equal(late.defaultPrevented, true);
  assert.deepEqual(pressesSeen(realm), []);
  await realm.idle(1000);
  assert.equal(realm.picks().length, 1);
});

// r2-R2 found it for the overlay; here, a popover in a shadow root fires a
// toggle that never reaches window, so the host stayed under it.
test('picker events: a popover the page shows in a shadow root while armed does not cover the highlight', async () => {
  const realm = makeRealm();
  realm.add('div', { id: 'card' }, [100, 100, 200, 100]);
  const toaster = realm.add('x-toaster', {}, null);
  const root = toaster.attachShadow({ mode: 'open' });
  const toast = new FakeElement(realm.doc, 'div', { popover: 'manual', class: 'toast' });
  toast.rect = [500, 400, 400, 200];
  root.appendChild(toast);
  realm.arm();
  await realm.frame();
  assert.equal(realm.host().popoverOpen, false, 'with nothing in the top layer, the host is an ordinary element');
  realm.doc.showPopover(toast);
  await realm.idle(300);
  assert.equal(realm.doc.topLayer.at(-1), realm.host(), 'the popover covers the highlight');
  realm.move(600, 500);
  assert.equal(realm.part('box').style.display, 'block');
  realm.click(600, 500);
  await realm.idle(1000);
  assert.equal(realm.picks()[0]?.element.selector, 'x-toaster >>> div.toast');
});

// r3-T3 (medium): pickAt took the sheet off and put it back around every
// hit test, which restyled the whole page on each armed move: 28 ms a move
// at 100 000 elements, on a page with no frame too. Now only a point in a
// frame's box asks the browser, with the sheet off, what is drawn there
// (the check of the box test alone, L3, found frames picked where they are
// not drawn).
test('picker events: a move away from every frame restyles nothing, and over one the browser says what is there', async () => {
  const realm = makeRealm();
  realm.add('iframe', { id: 'fr', src: '/embed' }, [0, 200, 600, 400]);
  // Drawn over the frame, later in tree order.
  realm.add('div', { id: 'tip' }, [100, 300, 100, 40]);
  realm.add('div', { id: 'side' }, [700, 200, 200, 100]);
  realm.arm();
  await realm.frame();
  const sheet = realm.doc.adoptedStyleSheets[0];
  const boxed = [];
  const toggled = [];
  for (const [x, y] of [[750, 250], [300, 400], [150, 320], [300, 500]]) {
    const before = sheet.toggles;
    realm.move(x, y);
    await realm.frame();
    boxed.push(realm.part('tag').textContent.split(' ')[0]);
    toggled.push(sheet.toggles > before);
  }
  assert.deepEqual(boxed, ['div#side', 'iframe#fr', 'div#tip', 'iframe#fr']);
  assert.deepEqual(toggled, [false, true, true, true], 'the sheet came off only for a point in the frame');
  assert.equal(sheet.disabled, false, 'the sheet was left off');
  realm.click(150, 320);
  await realm.idle(1500);
  realm.arm();
  await realm.frame();
  realm.click(300, 500);
  await realm.idle(1500);
  assert.deepEqual(realm.picks().map((pick) => pick.element.selector), ['#tip', '#fr']);
  assert.deepEqual(realm.page.framed, []);
  assert.equal(sheet.disabled, false);
});

// r3-T3 (medium): a page that sets its own adoptedStyleSheets dropped the
// picker's sheet until the next survey, 15 frames on, and in the tail for
// good, so a press over a frame went into the frame and nothing was picked.
test('picker events: a page that sets its own sheets while armed or in the tail does not let a press into a frame', async () => {
  const realm = makeRealm();
  const frame = realm.add('iframe', { id: 'fr', src: '/embed' }, [0, 200, 600, 400]);
  realm.add('div', { id: 'side' }, [700, 100, 200, 100]);
  const own = new realm.window.CSSStyleSheet();
  realm.arm();
  await realm.frame(2);
  const sheet = realm.doc.adoptedStyleSheets[0];
  realm.doc.adoptedStyleSheets = [own];
  await realm.frame();
  realm.move(300, 400);
  realm.press(300, 400);
  realm.release(300, 400);
  // In the tail, once more, and a double click's second press a frame on.
  await realm.frame();
  realm.doc.adoptedStyleSheets = [own];
  await realm.frame();
  realm.press(300, 400);
  realm.release(300, 400);
  realm.pointerEvent('dblclick', 300, 400);
  await realm.idle(1500);
  assert.deepEqual(realm.page.framed, [], 'a press went into the frame');
  assert.equal(realm.picks()[0]?.element.selector, '#fr');
  assert.equal(realm.doc.adoptedStyleSheets.length, 1, 'the page\'s own list was not left as it set it');
  assert.equal(realm.doc.adoptedStyleSheets[0], own);
  // Before a frame has run: at a press, the sheet goes back with its
  // pointerdown; and when the pointer reaches the frame and the frame took
  // it, the page hears the frame's mouseover, and the sheet goes back
  // before the press.
  realm.arm();
  await realm.frame();
  realm.doc.adoptedStyleSheets = [own];
  realm.press(800, 150, 2);
  assert.ok(realm.doc.adoptedStyleSheets.includes(sheet), 'the sheet is not back at the pointerdown');
  realm.release(800, 150, 2);
  realm.doc.adoptedStyleSheets = [own];
  realm.move(300, 400);
  assert.deepEqual(realm.page.framed.filter((type) => !/move$/.test(type)), []);
  realm.deliver('mouseover', { target: frame, deep: frame });
  realm.press(300, 400);
  realm.release(300, 400);
  await realm.idle(1500);
  assert.deepEqual(pressesFramed(realm), []);
  assert.equal(realm.picks()[1]?.element.selector, '#fr');
});

// r3-T3: the sheet was only taken out of the lists, so a copy of the list
// the page kept while armed (a theme preview restoring its sheets) put it
// back for good, and no frame took the pointer again until a reload.
test('picker events: a copy of the page\'s sheets kept while armed and put back later holds a sheet that does nothing', async () => {
  const realm = makeRealm();
  realm.add('iframe', { id: 'fr', src: '/embed' }, [0, 200, 600, 400]);
  realm.add('div', { id: 'preview' }, [700, 100, 200, 100]);
  realm.arm();
  await realm.frame();
  const saved = [...realm.doc.adoptedStyleSheets];
  realm.click(800, 150);
  await realm.idle(2500);
  assert.equal(realm.picks()[0]?.element.selector, '#preview');
  realm.doc.adoptedStyleSheets = saved;
  realm.click(300, 400);
  assert.deepEqual(pressesFramed(realm), ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
  // The next arm gives the sheet its rule again.
  realm.page.framed = [];
  realm.arm();
  await realm.frame();
  realm.click(300, 400);
  await realm.idle(1500);
  assert.deepEqual(pressesFramed(realm), []);
  assert.equal(realm.picks()[1]?.element.selector, '#fr');
});

// r3-T3: cancelling every selectstart while armed and in the tail also
// kept Cmd+A in a field, and the page's own select all, from selecting.
test('picker events: a selection made from the keyboard or by the page\'s script is the page\'s, armed and in the tail', async () => {
  const realm = makeRealm();
  realm.add('p', { id: 'txt' }, [100, 100, 300, 40]);
  realm.arm();
  await realm.frame();
  realm.move(150, 120);
  const armed = realm.pointerEvent('selectstart', 150, 120);
  assert.equal(armed.defaultPrevented, false, 'a selection with no press was cancelled');
  realm.click(150, 120);
  await realm.frame();
  const tail = realm.pointerEvent('selectstart', 150, 120);
  assert.equal(tail.defaultPrevented, false, 'a selection with no press was cancelled in the tail');
  assert.deepEqual(pressesSeen(realm), ['selectstart', 'selectstart']);
  await realm.idle(1000);
  assert.equal(realm.picks().length, 1);
});

// r3-T3: the host was raised over a popover in a shadow root only the first
// time it showed: shown again while armed, it covered the highlight.
test('picker events: a popover in a shadow root shown a second time while armed does not cover the highlight', async () => {
  const realm = makeRealm();
  realm.add('div', { id: 'card' }, [100, 100, 200, 100]);
  const toaster = realm.add('x-toaster', {}, null);
  const root = toaster.attachShadow({ mode: 'open' });
  const toast = new FakeElement(realm.doc, 'div', { popover: 'manual', class: 'toast' });
  toast.rect = [500, 400, 400, 200];
  root.appendChild(toast);
  realm.arm();
  await realm.frame();
  realm.doc.showPopover(toast);
  await realm.idle(300);
  assert.equal(realm.doc.topLayer.at(-1), realm.host());
  realm.doc.hidePopover(toast);
  await realm.idle(300);
  realm.doc.showPopover(toast);
  await realm.idle(300);
  assert.equal(realm.doc.topLayer.at(-1), realm.host(), 'the popover shown again covers the highlight');
});

// r3-T3: the walk for a keyboard start took a link in a collapsed menu, an
// element clipped away, or one under a cover, each with a box in view.
test('picker events: the keyboard starts only from an element drawn where it stands', async () => {
  const realm = makeRealm();
  const nav = realm.add('nav', { id: 'nav' }, [0, 0, 1000, 0]);
  // Hit testing finds nothing of these: clipped by the nav's height 0 and
  // overflow hidden, or by a clip-path.
  realm.add('a', { id: 'm1', href: '#' }, [0, 0, 1000, 42], nav).passThrough = true;
  realm.add('div', { id: 'clipped' }, [0, 50, 1000, 40]).passThrough = true;
  realm.add('div', { id: 'under' }, [0, 100, 300, 40]);
  realm.add('div', { id: 'ft' }, [800, 760, 200, 40]);
  realm.add('div', { id: 'cover' }, [0, 100, 300, 40]);
  realm.arm();
  await realm.frame();
  realm.key('ArrowDown');
  realm.key('Enter');
  await realm.idle(1000);
  assert.equal(realm.picks()[0]?.element.selector, '#ft');
});

// r3-T3: holding Enter after a keyboard pick let its repeats reach the page
// in the tail, and a form whose field had focus was sent.
test('picker events: the repeats of the Enter that picked are kept from the page, and a new Enter is not', async () => {
  const realm = makeRealm();
  const field = realm.add('input', { id: 'q', name: 'q' }, [100, 100, 200, 30]);
  realm.arm();
  await realm.frame();
  realm.deliver('focusin', { target: field });
  realm.deliver('keydown', { key: 'Enter' });
  await realm.frame(10);
  for (let index = 0; index < 4; index += 1) {
    realm.deliver('keydown', { key: 'Enter', repeat: true });
    realm.deliver('keypress', { key: 'Enter', repeat: true });
    await realm.frame(2);
  }
  realm.deliver('keyup', { key: 'Enter' });
  await realm.idle(300);
  assert.equal(realm.picks().length, 1);
  assert.deepEqual(realm.page.seen.filter((type) => type.startsWith('key')), []);
  // Pressed again, still in the tail: the page's.
  realm.deliver('keydown', { key: 'Enter' });
  realm.deliver('keydown', { key: 'Enter', repeat: true });
  assert.deepEqual(realm.page.seen.filter((type) => type.startsWith('key')), ['keydown', 'keydown']);
});

// r3-T6: a reload of the extension while Element was armed left the old
// picker armed in the page for good: frames took no pointer, the highlight
// stayed, and the next click was swallowed.
test('picker events: an arm, or a tail, ends on its own once the extension is reloaded', async () => {
  const realm = makeRealm();
  realm.add('iframe', { id: 'fr', src: '/embed' }, [0, 200, 600, 400]);
  realm.add('button', { id: 'go' }, [700, 100, 100, 40]);
  realm.arm();
  await realm.frame();
  realm.move(300, 400);
  realm.window.chrome.runtime.id = undefined;
  await realm.frame();
  assert.equal(realm.picker.isActive(), false);
  assert.equal(realm.host(), null);
  assert.equal(realm.doc.adoptedStyleSheets.length, 0);
  realm.click(750, 120);
  assert.deepEqual(pressesSeen(realm), ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
  // In the tail.
  realm.window.chrome.runtime.id = 'ext';
  realm.page.seen = [];
  realm.arm();
  await realm.frame();
  realm.click(750, 120);
  realm.window.chrome.runtime.id = undefined;
  await realm.frame();
  realm.click(750, 120);
  assert.deepEqual(pressesSeen(realm), ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
  assert.equal(realm.doc.adoptedStyleSheets.length, 0);
});

test('picker events: the region overlay ends on its own once the extension is reloaded', async () => {
  const realm = makeRealm();
  realm.inject(readFileSync(new URL('../content/overlay.js', import.meta.url), 'utf8'), 'content/overlay.js');
  const overlay = realm.window.__cdrRegionOverlay;
  await realm.frame(2);
  assert.equal(overlay.isActive(), true);
  realm.window.chrome.runtime.id = undefined;
  await realm.frame(2);
  assert.equal(overlay.isActive(), false);
  assert.equal(realm.doc.paintOrder().some((element) => element.hasAttribute('data-cdr-overlay')), false);
});

// r3-T3: shadow roots were looked for once per arm, so a frame in one
// attached while armed took the press for real and nothing was picked.
test('picker events: a frame in a shadow root attached while armed does not take the press', async () => {
  const realm = makeRealm();
  const slot = realm.add('div', { id: 'slot' }, [0, 200, 600, 300]);
  const late = realm.add('div', { id: 'late' }, [0, 520, 600, 200]);
  realm.arm();
  await realm.frame();
  const attach = (host) => {
    const frame = new FakeElement(realm.doc, 'iframe', { class: 'video', src: '/v' });
    frame.rect = host.rect;
    host.attachShadow({ mode: 'open' }).appendChild(frame);
    return frame;
  };
  attach(slot);
  await realm.frame(16);
  realm.click(300, 350);
  await realm.idle(1500);
  assert.deepEqual(realm.page.framed, [], 'a press went into the frame');
  assert.equal(realm.picks()[0]?.element.selector, '#slot >>> iframe.video');
  // Sooner than the loop looks: the pointer reaching the frame finds it.
  realm.arm();
  await realm.frame();
  const frame = attach(late);
  await realm.frame();
  realm.move(300, 600);
  realm.deliver('mouseover', { target: late, deep: frame });
  realm.press(300, 600);
  realm.release(300, 600);
  await realm.idle(1500);
  assert.deepEqual(pressesFramed(realm), []);
  assert.equal(realm.picks()[1]?.element.selector, '#late >>> iframe.video');
});

// r3-T3: TAIL_LIMIT_MS counted from the pick, so a press begun late in the
// tail and held a few seconds was let go to the page, and a link followed.
test('picker events: a press begun late in the tail has the whole TAIL_LIMIT_MS from its own start', async () => {
  const realm = makeRealm();
  realm.add('div', { id: 'neutral' }, [100, 100, 100, 40]);
  realm.add('a', { id: 'lnk', href: '/a' }, [100, 200, 100, 30]);
  let sentAt = null;
  realm.onSend = (message) => {
    if (message.type === 'cdr:element-picked') sentAt = realm.clock.now;
  };
  realm.arm();
  await realm.frame();
  realm.click(150, 120);
  while (sentAt === null) await realm.frame();
  await until(realm, sentAt + 900);
  realm.move(150, 215);
  realm.press(150, 215);
  await until(realm, sentAt + 5400);
  realm.release(150, 215);
  assert.deepEqual(pressesSeen(realm), [], 'the page heard the rest of a press held for 4.5 s');
});

/**
 * Arms, hovers a point a frame on, and presses there: what was highlighted,
 * what was picked (undefined for nothing), and what went into a frame.
 */
async function pickOver(realm, x, y) {
  const before = realm.picks().length;
  realm.arm();
  await realm.frame();
  realm.move(x, y);
  await realm.frame();
  const shown = realm.part('box').style.display === 'block' ? realm.part('tag').textContent.split(' ')[0] : null;
  realm.press(x, y);
  realm.release(x, y);
  await realm.idle(1000);
  const picked = realm.picks()[before]?.element.selector;
  realm.picker.stop();
  await realm.idle(1500);
  return { shown, picked, framed: pressesFramed(realm) };
}

// z-Z2 (low): frames were found by their box alone, once the hit test
// stopped taking the sheet off. A carousel's slide out of view lies over the
// page beside the carousel, and was picked there.
test('picker events: a frame clipped away by an ancestor is not picked where it is not drawn', async () => {
  const realm = makeRealm();
  const carousel = realm.add('div', { id: 'car' }, [0, 0, 400, 200]);
  carousel.look = () => ({ overflow: 'hidden', 'overflow-x': 'hidden', 'overflow-y': 'hidden' });
  // The slides clip nothing, and the second one is clipped away whole, so
  // neither is given a rectangle to hit.
  const first = realm.add('div', { class: 'slide', id: 's1' }, null, carousel);
  const second = realm.add('div', { class: 'slide', id: 's2' }, null, carousel);
  realm.add('iframe', { id: 'f1', src: '/inner?1' }, [0, 0, 400, 200], first);
  realm.add('iframe', { id: 'f2', src: '/inner?2' }, [400, 0, 400, 200], second);
  realm.add('div', { id: 'beside' }, [400, 300, 200, 100]);
  assert.deepEqual(await pickOver(realm, 600, 100), { shown: null, picked: undefined, framed: [] });
  // In view, it is still picked; and so is one clipped by a clip-path where
  // it is inside the path's box.
  assert.equal((await pickOver(realm, 200, 100)).picked, '#f1');
  carousel.look = () => ({ 'clip-path': 'inset(0px)' });
  assert.equal((await pickOver(realm, 600, 100)).picked, undefined);
  assert.equal((await pickOver(realm, 200, 100)).picked, '#f1');
});

test('picker events: a frame with visibility hidden is not picked', async () => {
  const realm = makeRealm();
  const frame = realm.add('iframe', { id: 'f1', src: '/inner?1' }, [100, 100, 300, 200]);
  frame.look = () => ({ visibility: 'hidden' });
  realm.add('div', { id: 'card' }, [500, 100, 200, 100]);
  assert.deepEqual(await pickOver(realm, 200, 200), { shown: null, picked: undefined, framed: [] });
  frame.look = null;
  assert.equal((await pickOver(realm, 200, 200)).picked, '#f1');
});

// The frames were walked in tree order, so of two overlapping frames the
// later one was picked, though the earlier one has the higher z-index.
test('picker events: of two overlapping frames the one on top is picked', async () => {
  const realm = makeRealm();
  const upper = realm.add('iframe', { id: 'f1', src: '/inner?1' }, [100, 100, 300, 200]);
  upper.z = 2;
  const lower = realm.add('iframe', { id: 'f2', src: '/inner?2' }, [150, 150, 300, 200]);
  lower.z = 1;
  realm.arm();
  await realm.frame();
  const sheet = realm.doc.adoptedStyleSheets[0];
  // Away from both, no restyle.
  const before = sheet.toggles;
  realm.move(600, 50);
  await realm.frame();
  assert.equal(sheet.toggles, before);
  realm.picker.stop();
  await realm.idle(100);
  assert.equal((await pickOver(realm, 600, 50)).picked, undefined);
  assert.equal((await pickOver(realm, 420, 320)).picked, '#f2');
  const { shown, picked, framed } = await pickOver(realm, 300, 250);
  assert.deepEqual({ shown, picked, framed }, { shown: 'iframe#f1', picked: '#f1', framed: [] });
  assert.equal(sheet.disabled, false, 'the sheet was left off');
  assert.ok(sheet.toggles > 0);
  upper.z = 0;
  lower.z = 0;
  assert.equal((await pickOver(realm, 300, 250)).picked, '#f2');
});

// An <object> that shows its fallback content: the content inherited
// pointer-events:none from the sheet's rule for the object, and the object
// was picked over its own fallback link.
test('picker events: an object showing its fallback content has that content picked', async () => {
  const realm = makeRealm();
  const object = realm.add('object', { id: 'o1', data: '/missing.pdf', type: 'application/pdf' }, [20, 20, 400, 200]);
  const link = realm.add('a', { id: 'fb', href: '#x' }, [20, 20, 240, 58], object);
  realm.text(link, 'fallback link');
  assert.deepEqual(await pickOver(realm, 60, 40), { shown: 'a#fb', picked: '#fb', framed: [] });
  // Beside the fallback content, the object is picked whole, and so it is
  // over content the page itself gives pointer-events:none.
  assert.equal((await pickOver(realm, 300, 150)).picked, '#o1');
  link.pageNone = true;
  assert.equal((await pickOver(realm, 60, 40)).picked, '#o1');
  assert.deepEqual(realm.page.framed, []);
});

// Low in the last check (C3): the fallback content of an <object> got
// pointer-events:auto back from the picker's sheet, which beat the page's
// own none, inherited or in a layer, and slowed every restyle by a quarter.
// The lifted hit test finds the fallback now, and the page's none holds.
test('picker events: an object\'s fallback keeps a none the page gives it', async () => {
  const realm = makeRealm();
  realm.add('div', { id: 'bg' }, [0, 0, 800, 500]);
  const card = realm.add('div', { id: 'card' }, [20, 20, 400, 200]);
  card.pageNone = true;
  const object = realm.add('object', { id: 'o1', data: '/missing.pdf', type: 'application/pdf' }, [20, 20, 400, 200], card);
  realm.add('a', { id: 'fb', href: '#x' }, [20, 20, 300, 150], object);
  assert.equal((await pickOver(realm, 80, 60)).picked, '#bg');
  card.pageNone = false;
  assert.equal((await pickOver(realm, 80, 60)).picked, '#fb');
  assert.deepEqual(realm.page.framed, []);
});

// Low in the last check (C3), and in 0.5.0: a frame put in after the last
// survey was not among the boxes, so a press over it before the next one
// picked what lies under it.
test('picker events: a frame put in just before the press is picked', async () => {
  const realm = makeRealm();
  const slot = realm.add('div', { id: 'slot' }, [0, 0, 400, 300]);
  realm.arm();
  await realm.frame();
  realm.move(100, 100);
  await realm.frame();
  realm.add('iframe', { id: 'lf', src: '/inner?late' }, [0, 0, 400, 300], slot);
  realm.press(100, 100);
  realm.release(100, 100);
  await realm.idle(1000);
  assert.equal(realm.picks().at(-1)?.element.selector, '#lf');
  realm.picker.stop();
  await realm.idle(1500);
  assert.deepEqual(realm.page.framed, []);
});

// frameAt looked only at the first 100 frames that findFrames keeps.
test('picker events: a frame past the first hundred is picked, in the page and in a shadow root', async () => {
  const realm = makeRealm();
  const grid = realm.add('div', { id: 'g' }, [0, 0, 960, 400]);
  for (let index = 0; index < 120; index += 1) {
    realm.add('iframe', { id: `f${index + 1}`, src: `/inner?${index + 1}` }, [(index % 15) * 64, Math.floor(index / 15) * 44, 60, 40], grid);
  }
  const widget = realm.add('x-embed', { id: 'w' }, [0, 360, 200, 40], grid);
  const frame = new FakeElement(realm.doc, 'iframe', { id: 'deep', src: '/inner?deep' });
  frame.rect = [0, 360, 200, 40];
  widget.attachShadow({ mode: 'open' }).appendChild(frame);
  // #f110: row 7, column 4.
  assert.deepEqual(await pickOver(realm, 4 * 64 + 30, 7 * 44 + 20), { shown: 'iframe#f110', picked: '#f110', framed: [] });
  assert.equal((await pickOver(realm, 100, 380)).picked, '#w >>> #deep');
  assert.equal((await pickOver(realm, 30, 20)).picked, '#f1');
  // Between the frames, the grid.
  assert.equal((await pickOver(realm, 62, 20)).picked, '#g');
});

// What the last round kept: a plain frame, a menu drawn over a frame, and a
// rounded frame's corner, which counts as the frame (a stated limit).
test('picker events: a plain frame, a menu over a frame and a rounded frame\'s corner are picked as before', async () => {
  const realm = makeRealm();
  const wrap = realm.add('div', { id: 'wrap' }, [20, 20, 500, 300]);
  realm.add('iframe', { id: 'f1', src: '/inner?1' }, [20, 20, 500, 300], wrap);
  const menu = realm.add('div', { id: 'm' }, [40, 60, 200, 40]);
  menu.z = 5;
  realm.add('a', { id: 'mi', href: '#y' }, [40, 60, 200, 40], menu);
  const round = realm.add('iframe', { id: 'r1', src: '/inner?r' }, [600, 100, 300, 300]);
  round.look = () => ({ 'border-radius': '50%' });
  assert.equal((await pickOver(realm, 200, 150)).picked, '#f1');
  assert.equal((await pickOver(realm, 80, 80)).picked, '#mi');
  assert.equal((await pickOver(realm, 610, 110)).picked, '#r1');
  assert.deepEqual(realm.page.framed, []);
});

// Medium in the check of the box test (L3): a frame was taken to be drawn
// at a point only if the element found there was its ancestor and no
// ancestor with overflow clipped it, which is not how drawing goes: a fixed
// chat frame lies over a card that is not its ancestor, and an <object>
// showing its fallback draws the frame inside it. Over a frame's box the
// browser now says what is there.
test('picker events: a frame over content that is not its ancestor, and an object\'s fallback frame, are picked', async () => {
  const realm = makeRealm();
  realm.add('div', { id: 'card' }, [500, 300, 400, 300]);
  const chat = realm.add('iframe', { id: 'chat', src: '/chat' }, [700, 400, 200, 200]);
  chat.z = 5;
  assert.equal((await pickOver(realm, 800, 500)).picked, '#chat');
  assert.equal((await pickOver(realm, 600, 350)).picked, '#card');

  const object = realm.add('object', { id: 'o1', data: '/missing.pdf', type: 'application/pdf' }, [20, 20, 400, 200]);
  realm.add('iframe', { id: 'f1', src: '/viewer' }, [20, 20, 400, 200], object);
  const { picked, framed } = await pickOver(realm, 200, 100);
  assert.equal(picked, '#f1');
  assert.deepEqual(framed, []);
});

// F38: a pick gave the page transient user activation, which Chrome grants
// as it dispatches the press, before any listener runs: for five seconds
// the page could open a popup or start playback as if it had been clicked.
test('picker events: a pick by click, tap or key leaves the page no transient activation, and Escape spends none', async () => {
  const realm = makeRealm();
  const activation = realm.window.navigator.userActivation;
  realm.add('button', { id: 'go' }, [100, 100, 120, 40]);
  realm.add('a', { id: 'more', href: '#more' }, [100, 300, 120, 40]);
  realm.arm();
  await realm.frame();
  realm.click(150, 120);
  assert.equal(activation.isActive, false, 'the press that picked left the page activated');
  await realm.frame();
  // The second press of a double click, in the tail.
  realm.press(150, 120);
  realm.release(150, 120);
  assert.equal(activation.isActive, false, 'a press in the tail left the page activated');
  await realm.idle(1500);
  assert.equal(realm.picks().length, 1);
  realm.arm();
  await realm.frame();
  realm.tap(150, 320);
  assert.equal(activation.isActive, false, 'the tap that picked left the page activated');
  await realm.idle(1500);
  assert.equal(realm.picks().length, 2);
  realm.arm();
  await realm.frame();
  realm.deliver('focusin', { target: realm.doc.getRootNode().body.children[1] });
  realm.key('ArrowUp');
  assert.equal(activation.isActive, false, 'a key the picker answered left the page activated');
  realm.key('Enter');
  assert.equal(activation.isActive, false, 'the Enter that picked left the page activated');
  await realm.idle(1500);
  assert.equal(realm.picks().length, 3);
  // The page's own: a click once the pick is over, and a key the picker
  // leaves to the page. Escape grants nothing, and spends none of it.
  realm.click(150, 120);
  assert.equal(activation.isActive, true);
  realm.arm();
  await realm.frame();
  realm.key('Escape');
  assert.equal(realm.picker.isActive(), false);
  assert.equal(activation.isActive, true, 'Escape spent an activation the page had of its own');
  realm.arm();
  await realm.frame();
  realm.key('Tab');
  assert.equal(activation.isActive, true);
  // Sticky activation stays for the life of the page; nothing withdraws it.
  assert.equal(activation.hasBeenActive, true);
});

// F39: a page's capture listener on window added before the arm ran before
// the picker's, which is added only when it arms, and heard every press
// that picked, every press of a double click, and the keys. The press gate,
// declared at document_start, adds its listeners before the page's.
test('picker events: a page listener on window added before the arm hears nothing of a pick, with the press gate there first', async () => {
  const realm = makeRealm();
  realm.inject(readFileSync(GATE, 'utf8'), 'content/press-gate.js');
  // The page's own scripts, which run after document_start.
  const heard = [];
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'keydown', 'keyup', 'selectstart']) {
    realm.window.addEventListener(type, (event) => heard.push(event.type), true);
  }
  realm.add('div', { id: 'card' }, [100, 100, 200, 100]);
  realm.add('p', { id: 'aside' }, [100, 300, 200, 40]);
  realm.arm();
  await realm.frame();
  realm.click(150, 150);
  await realm.frame();
  realm.press(150, 150);
  realm.pointerEvent('selectstart', 150, 150);
  realm.release(150, 150);
  realm.pointerEvent('dblclick', 150, 150);
  await realm.idle(1500);
  assert.equal(realm.picks()[0]?.element.selector, '#card');
  realm.arm();
  await realm.frame();
  realm.key('ArrowDown');
  realm.key('Enter');
  await realm.idle(1500);
  assert.equal(realm.picks().length, 2);
  assert.deepEqual(heard, [], 'the page heard the pick');
  assert.deepEqual(pressesSeen(realm), []);
  // Once the pick is over, the page hears its presses again.
  realm.click(150, 320);
  assert.deepEqual(heard, ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
});

test('picker events: the press gate goes where the bridge goes, first, and hears every event the picker keeps', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const entry = manifest.content_scripts.find((one) => one.js.includes('content/press-gate.js'));
  assert.ok(entry, 'the gate is not declared');
  assert.deepEqual(entry.js, ['content/press-gate.js', 'content/collector-bridge.js']);
  assert.equal(entry.run_at, 'document_start');
  assert.equal(entry.world, 'ISOLATED');
  const list = (source, name) => JSON.parse(`[${new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(source)[1].replace(/'/g, '"').replace(/,\s*$/, '')}]`);
  const kept = [...list(SOURCE, 'CANCELLED'), ...list(SOURCE, 'STOPPED'), ...list(SOURCE, 'HELD_EVENTS'), 'selectstart'];
  assert.deepEqual([...list(readFileSync(GATE, 'utf8'), 'TYPES')].sort(), kept.sort());
});

// F50: a popover in a shadow root sends its toggle no further than the
// root, so the host was raised over it only by the survey every fifteenth
// frame, and one hidden and shown again between two surveys covered the
// highlight until it was next shown.
test('picker events: a popover in a shadow root hidden and shown again at once does not cover the highlight', async () => {
  const realm = makeRealm();
  realm.add('div', { id: 'card' }, [100, 100, 200, 100]);
  const toaster = realm.add('x-toaster', {}, null);
  const root = toaster.attachShadow({ mode: 'open' });
  const toast = new FakeElement(realm.doc, 'div', { popover: 'manual', class: 'toast' });
  toast.rect = [500, 400, 400, 200];
  root.appendChild(toast);
  realm.arm();
  await realm.frame();
  realm.doc.showPopover(toast);
  await realm.idle(300);
  assert.equal(realm.doc.topLayer.at(-1), realm.host());
  realm.doc.hidePopover(toast);
  realm.doc.showPopover(toast);
  await realm.idle(300);
  assert.equal(realm.doc.topLayer.at(-1), realm.host(), 'the popover hidden and shown again covers the highlight');
  // Raised a frame after it shows, not by the survey up to 15 frames on;
  // one in a closed root too.
  realm.doc.hidePopover(toast);
  await realm.frame();
  realm.doc.showPopover(toast);
  await realm.frame(2);
  assert.equal(realm.doc.topLayer.at(-1), realm.host(), 'a popover shown in a shadow root covers the highlight');
  const sealed = realm.add('x-sealed', {}, null);
  const closedRoot = sealed.attachShadow({ mode: 'closed' });
  const tip = new FakeElement(realm.doc, 'div', { popover: 'manual' });
  tip.rect = [0, 0, 100, 100];
  closedRoot.appendChild(tip);
  await realm.frame(16);
  realm.doc.showPopover(tip);
  await realm.frame(2);
  assert.equal(realm.doc.topLayer.at(-1), realm.host(), 'a popover shown in a closed shadow root covers the highlight');
});

// F50: the Enter that picked, held past the tail, repeated to the page, and
// sent the form whose field had focus once for each repeat.
test('picker events: the Enter that picked, held past the tail, does not repeat to the page', async () => {
  const realm = makeRealm();
  const field = realm.add('input', { id: 'q', name: 'q' }, [100, 100, 200, 30]);
  realm.arm();
  await realm.frame();
  realm.deliver('focusin', { target: field });
  realm.deliver('keydown', { key: 'Enter' });
  for (let index = 0; index < 100; index += 1) {
    realm.deliver('keydown', { key: 'Enter', repeat: true });
    realm.deliver('keypress', { key: 'Enter', repeat: true });
    await realm.frame(2);
  }
  assert.equal(realm.picks().length, 1);
  realm.deliver('keyup', { key: 'Enter' });
  assert.deepEqual(realm.page.seen.filter((type) => type.startsWith('key')), [], 'the page heard the held Enter');
  // A new press is the page's, its repeats too.
  realm.deliver('keydown', { key: 'Enter' });
  realm.deliver('keydown', { key: 'Enter', repeat: true });
  realm.deliver('keyup', { key: 'Enter' });
  assert.deepEqual(realm.page.seen.filter((type) => type.startsWith('key')), ['keydown', 'keydown', 'keyup']);
  // Let go unseen (its keyup went elsewhere): the next press of Enter, no
  // repeat, ends the hold and is the page's.
  realm.page.seen = [];
  realm.arm();
  await realm.frame();
  realm.deliver('focusin', { target: field });
  realm.deliver('keydown', { key: 'Enter' });
  await realm.idle(2500);
  assert.equal(realm.picks().length, 2);
  realm.deliver('keydown', { key: 'Enter' });
  realm.deliver('keyup', { key: 'Enter' });
  assert.deepEqual(realm.page.seen.filter((type) => type.startsWith('key')), ['keydown', 'keyup']);
});

// F50: a frame whose own important id rule beat the sheet got a shield,
// drawn above everything, so a hover menu over it lost its hover.
test('picker events: a frame with an important id rule of the page\'s lets the pointer through, and a menu over it keeps its hover', async () => {
  const realm = makeRealm();
  const frame = realm.add('iframe', { id: 'player', src: '/embed' }, [0, 100, 600, 300]);
  frame.pageIds = 3;
  const menu = realm.add('nav', { class: 'menu' }, [0, 40, 140, 40]);
  const sub = realm.add('div', { class: 'sub' }, [0, 80, 200, 120], menu);
  sub.shownWhile = menu;
  const item = realm.add('a', { id: 'c3', href: '#3' }, [0, 150, 200, 40], sub);
  realm.text(item, 'Item three');
  realm.arm();
  await realm.frame();
  const shields = realm.part('shields').children;
  assert.equal(shields.filter((shield) => shield.style.display === 'block').length, 0, 'the frame has a shield');
  realm.move(50, 60);
  await realm.frame();
  realm.move(50, 170);
  await realm.frame();
  assert.equal(realm.doc.rendered(item), true, 'the menu closed as the pointer reached the part over the frame');
  realm.press(50, 170);
  realm.release(50, 170);
  await realm.idle(1500);
  assert.equal(realm.picks()[0]?.element.selector, '#c3');
  assert.equal(realm.picks()[0].element.hovered, true);
  assert.equal((await pickOver(realm, 400, 300)).picked, '#player');
  assert.deepEqual(realm.page.framed, []);
});

// V3-picker-2 (F50e): appended after body, as the html element's last child,
// the host took :last-child from body itself, so a page's body:last-child
// or html > :last-child rule stopped matching body while armed (its
// background and an outline went, in Chrome 156). It goes at the end of
// body again, as in 0.6.0, where a page that spaces body's children by
// margin (space-y) still moves while armed.
test('picker events: body stays the last child of the html element while armed, so a body:last-child rule keeps matching', async () => {
  const realm = makeRealm();
  realm.add('div', { id: 'card' }, [100, 100, 200, 100]);
  const doc = realm.doc;
  // body:last-child { background: rgb(1, 2, 3) }
  const background = () => (doc.documentElement.lastElementChild === doc.body ? 'rgb(1, 2, 3)' : 'rgba(0, 0, 0, 0)');
  const before = background();
  realm.arm();
  await realm.frame();
  realm.move(150, 150);
  await realm.frame();
  assert.equal(background(), before, 'body stopped matching :last-child while armed');
  assert.equal(realm.host().parentNode, doc.body);
  realm.press(150, 150);
  realm.release(150, 150);
  await realm.idle(1500);
  assert.equal(realm.picks()[0]?.element.selector, '#card');
  assert.equal(background(), before);
});

// F50: a frame with a discrete transition of pointer-events (transition:
// all .3s allow-discrete) kept auto for half the transition as the sheet
// came in, and none as the sheet was lifted, so the lifted hit test passed
// through it and the element under it was picked, and the page heard
// transition events on every move over it.
test('picker events: a frame with a discrete transition of the page\'s is passed through at once and picked where it is drawn', async () => {
  const realm = makeRealm();
  realm.add('div', { id: 'under' }, [0, 0, 1000, 800]);
  const frame = realm.add('iframe', { id: 'fr', src: '/embed' }, [100, 100, 400, 300]);
  frame.discreteMs = 300;
  realm.arm();
  await realm.frame();
  realm.move(300, 250);
  await realm.frame();
  realm.move(310, 260);
  await realm.frame();
  assert.equal(realm.part('tag').textContent.split(' ')[0], 'iframe#fr');
  realm.press(310, 260);
  realm.release(310, 260);
  await realm.idle(1500);
  assert.deepEqual(realm.page.framed, [], 'events went into the frame');
  assert.equal(realm.picks()[0]?.element.selector, '#fr');
  assert.deepEqual(realm.page.transitions, [], 'the page heard transition events');
});

// V3-picker-1 (F50f): the sheet held every discrete transition of every
// frame back for the whole arm and tail (transition-behavior: normal
// !important), so a frame the page faded out with a display transition
// went at once, the page heard no transition event, and the transitionend
// it waited for to take the frame away never came. Nothing is held now
// unless a frame gives pointer-events a discrete transition of its own.
const FADED = [
  'transitionrun:display',
  'transitionrun:opacity',
  'transitionstart:display',
  'transitionstart:opacity',
  'transitionend:display',
  'transitionend:opacity',
  'removed',
];

test('picker events: a frame the page fades out while armed or just after a pick runs its transition to the end', async () => {
  const realm = makeRealm();
  realm.add('div', { id: 'card' }, [50, 50, 200, 100]);
  const chat = () => {
    const frame = realm.add('iframe', { class: 'chat', src: '/chat' }, [600, 400, 300, 300]);
    frame.fadeMs = 400;
    return frame;
  };
  const heard = () => realm.page.transitions.splice(0).sort();
  // Armed: the pointer on the card, and once over the frame, so the sheet
  // has come off and gone back on as well.
  let frame = chat();
  realm.arm();
  await realm.frame();
  const sheet = realm.doc.adoptedStyleSheets[0];
  realm.move(700, 500);
  await realm.frame();
  realm.move(100, 80);
  await realm.frame();
  realm.doc.fade(frame);
  await realm.idle(200);
  assert.equal(realm.doc.rendered(frame), true, 'the frame went at once');
  await realm.idle(400);
  assert.deepEqual(heard(), [...FADED].sort());
  assert.equal(frame.isConnected, false, 'the page never took the frame away');
  realm.key('Escape');
  await realm.idle(100);
  // In the tail: the card picked, the frame faded 100 ms later.
  frame = chat();
  realm.arm();
  await realm.frame();
  realm.click(100, 80);
  await realm.idle(100);
  realm.doc.fade(frame);
  await realm.idle(1500);
  assert.deepEqual(heard(), [...FADED].sort());
  assert.equal(frame.isConnected, false, 'the page never took the frame away');
  assert.deepEqual(realm.picks().map((pick) => pick.element.selector), ['#card']);
  assert.deepEqual(
    sheet.texts.filter((text) => text.includes('transition')),
    [],
    'the sheet held transitions back on a page with no frame that transitions pointer-events'
  );
});

// The hold that a frame of the page's own discrete transition of
// pointer-events needs (see the test above this one) comes only at the
// moments the sheet changes it, after what the page changed has been
// restyled, so a fade the page starts on that frame runs to its end too,
// the pointer moving over the frame all the while.
test('picker events: a frame that transitions pointer-events itself still runs a fade of the page\'s to the end', async () => {
  const realm = makeRealm();
  realm.add('div', { id: 'under' }, [0, 0, 1000, 800]);
  const frame = realm.add('iframe', { id: 'fr', src: '/embed' }, [100, 100, 400, 300]);
  frame.discreteMs = 400;
  frame.fadeMs = 400;
  realm.arm();
  await realm.frame();
  realm.move(300, 250);
  await realm.frame();
  assert.equal(realm.part('tag').textContent.split(' ')[0], 'iframe#fr');
  // The page fades it in the same frame as the next move over it.
  realm.doc.fade(frame);
  for (let step = 0; step < 12; step += 1) {
    realm.move(300 + step, 250);
    await realm.frame();
  }
  await realm.idle(400);
  assert.deepEqual(realm.page.transitions.slice().sort(), [...FADED].sort());
  assert.equal(frame.isConnected, false, 'the page never took the frame away');
  assert.deepEqual(realm.page.framed, []);
});

// The same, where the page asks for the fade in the very task that ends
// picking: what it changed is restyled with its own transitions before the
// sheet holds anything back to come off.
test('picker events: a fade the page asks for as picking ends runs to the end on a frame that transitions pointer-events', async () => {
  const realm = makeRealm();
  realm.add('div', { id: 'under' }, [0, 0, 1000, 800]);
  const frame = realm.add('iframe', { id: 'fr', src: '/embed' }, [100, 100, 400, 300]);
  frame.discreteMs = 400;
  frame.fadeMs = 400;
  realm.arm();
  await realm.frame();
  realm.move(300, 250);
  await realm.frame();
  realm.doc.fade(frame);
  realm.picker.stop();
  await realm.idle(600);
  assert.deepEqual(realm.page.transitions.slice().sort(), [...FADED].sort());
  assert.equal(frame.isConnected, false, 'the page never took the frame away');
  assert.equal(realm.doc.adoptedStyleSheets.length, 0);
});

// W3-picker-1 (F50f): a page that sets its own adoptedStyleSheets while
// armed (a framework that owns its lists) drops the sheet. It went back
// under a hold that first restyled the frames without it, so the page heard
// a transition of pointer-events begin and be cancelled at every reset, in
// the loop's frames and in a survey's. It goes back now before anything
// restyles, as in 0.6.0, and the frames never leave none.
test('picker events: a page that sets its own adopted sheets while armed hears no transition of a frame that transitions pointer-events', async () => {
  const realm = makeRealm();
  realm.add('div', { id: 'under' }, [0, 0, 1000, 800]);
  const frame = realm.add('iframe', { id: 'fr', src: '/embed' }, [100, 100, 400, 300]);
  frame.discreteMs = 300;
  const widget = realm.add('x-player', {}, [600, 100, 300, 200]);
  const root = widget.attachShadow({ mode: 'open' });
  const inner = new FakeElement(realm.doc, 'iframe', { class: 'video', src: '/v' });
  inner.rect = [600, 100, 300, 200];
  inner.discreteMs = 300;
  root.appendChild(inner);
  realm.arm();
  await realm.frame(20);
  assert.deepEqual(realm.page.transitions, [], 'the page heard transition events at the arm');
  const sheet = realm.doc.adoptedStyleSheets.at(-1);
  // Before each of 40 frames, two surveys among them.
  for (let step = 0; step < 40; step += 1) {
    realm.doc.adoptedStyleSheets = [];
    root.adoptedStyleSheets = [];
    await realm.frame();
  }
  assert.deepEqual(realm.page.transitions, [], 'the page heard transition events as it set its lists');
  assert.ok(realm.doc.adoptedStyleSheets.includes(sheet));
  assert.ok(root.adoptedStyleSheets.includes(sheet));
  realm.click(300, 250);
  await realm.idle(1500);
  assert.deepEqual(realm.page.framed, [], 'events went into the frame');
  assert.equal(realm.picks()[0]?.element.selector, '#fr');
  assert.deepEqual(realm.page.transitions, []);
});

// W3-picker-2 (F50f): only the first 100 frames were asked whether they
// transition pointer-events, afresh at each survey. A frame past them was
// passed through with no hold at the arm, so the page heard its transition
// and for half of it the frame still took a press, and Escape let it go
// with no hold once a survey had forgotten what a lift found. Every frame
// found is asked now, and what was found stays until the next arm.
test('picker events: a frame past the first 100 that transitions pointer-events is held at the arm, for a press right after it, and at Escape', async () => {
  const realm = makeRealm();
  for (let index = 0; index < 100; index += 1) realm.add('iframe', { src: `/f${index}` }, [index * 9, 700, 9, 9]);
  const last = realm.add('iframe', { id: 'last', src: '/last' }, [100, 100, 300, 200]);
  last.discreteMs = 300;
  // Pressed in the first frame after the arm.
  realm.move(200, 200);
  realm.arm();
  await realm.frame();
  realm.click(202, 201);
  await realm.idle(1500);
  assert.deepEqual(pressesFramed(realm), [], 'the press went into the frame');
  assert.equal(realm.picks()[0]?.element.selector, '#last');
  // Hovered, then Escape two surveys later.
  realm.arm();
  await realm.frame();
  for (let step = 0; step < 4; step += 1) {
    realm.move(200 + step * 4, 200);
    await realm.frame();
  }
  await realm.idle(600);
  realm.key('Escape');
  await realm.idle(500);
  assert.equal(realm.picker.isActive(), false);
  assert.deepEqual(realm.page.transitions, [], 'the page heard transition events');
});

// Round four's survey skipped every frame checkVisibility said no to, so a
// frame hidden (display: none) at the arm and shown while armed was not
// known to transition pointer-events until a later survey: a move over
// another frame in that window let the page hear the shown frame's
// transition. A frame the survey passed over is asked again before the
// sheet changes, once it is drawn.
test('picker events: a frame hidden at the arm and shown while armed is held as soon as it is shown', async () => {
  const realm = makeRealm();
  realm.add('div', { id: 'under' }, [0, 0, 1000, 800]);
  realm.add('iframe', { id: 'plain', src: '/plain' }, [500, 100, 300, 200]);
  const shown = realm.add('iframe', { id: 'shown', src: '/shown' }, [100, 100, 300, 200]);
  shown.discreteMs = 300;
  shown.style.display = 'none';
  realm.arm();
  await realm.frame();
  shown.style.display = '';
  for (let step = 0; step < 3; step += 1) {
    realm.move(600 + step * 4, 200);
    await realm.frame();
  }
  await realm.idle(600);
  realm.key('Escape');
  await realm.idle(500);
  assert.deepEqual(realm.page.transitions, [], 'the page heard transition events');
});

// X3 (round three's survey): every frame found was asked whether it
// transitions pointer-events, which in Chrome lays out a frame in skipped
// content (content-visibility: auto off screen): on a page of 1,000 such
// frames each arm took 37 to 51 ms and the first scroll after it froze the
// page for 0.3 s. Round five asked checkVisibility() with no options of
// each such frame instead, which lays it out as well, and cost the same.
// Such a frame is not asked until it is drawn, and nothing lays it out.
test('picker events: the survey asks no frame in skipped content whether it transitions pointer-events', async () => {
  const realm = makeRealm();
  realm.add('div', { id: 'under' }, [0, 0, 1000, 800]);
  const drawn = realm.add('iframe', { id: 'drawn', src: '/drawn' }, [100, 100, 300, 200]);
  const skipped = [];
  for (let index = 0; index < 200; index += 1) {
    const frame = realm.add('iframe', { src: `/s${index}` }, [index * 4, 900, 4, 4]);
    frame.skippedContent = true;
    skipped.push(frame);
  }
  realm.arm();
  for (let step = 0; step < 40; step += 1) {
    realm.move(10 + step, 10);
    await realm.frame();
  }
  assert.ok(drawn.transitionReads > 0, 'the drawn frame was never asked');
  assert.deepEqual(skipped.filter((frame) => frame.transitionReads).length, 0, 'frames in skipped content were asked');
  assert.deepEqual(skipped.filter((frame) => frame.layouts).length, 0, 'frames in skipped content were laid out');
  realm.key('Escape');
  await realm.idle(500);
});

// The same frame in skipped content at the arm, with a discrete transition
// of its own, scrolled into view while armed: held from the first move
// after, not from the next survey, so the page hears nothing of it.
test('picker events: a frame in skipped content at the arm and scrolled into view while armed is held as soon as it is drawn', async () => {
  const realm = makeRealm();
  realm.add('div', { id: 'under' }, [0, 0, 1000, 800]);
  realm.add('iframe', { id: 'plain', src: '/plain' }, [500, 100, 300, 200]);
  const later = realm.add('iframe', { id: 'later', src: '/later' }, [100, 100, 300, 200]);
  later.discreteMs = 300;
  later.skippedContent = true;
  realm.arm();
  await realm.frame();
  later.skippedContent = false;
  for (let step = 0; step < 3; step += 1) {
    realm.move(600 + step * 4, 200);
    await realm.frame();
  }
  await realm.idle(600);
  realm.key('Escape');
  await realm.idle(500);
  assert.deepEqual(realm.page.transitions, [], 'the page heard transition events');
  assert.equal(later.layouts || 0, 0, 'the frame was laid out while skipped');
});

// ------------------------------------------------------ the name on hover --
// The tag names the component behind the highlighted element, asked of the
// page's world with an event sent on the node and answered before the
// dispatch returns (see askName() in picker.js and the name request in
// collector-main.js). Lead 8 and proposal 15 of the review.

/** The tag's text, and its two parts. */
function tagOf(realm) {
  const tag = realm.part('tag');
  const [what, who] = tag.children;
  return { text: tag.textContent, what: what?.textContent, who: who?.textContent, shown: tag.style.display };
}

test('picker events: the tag names the component under the pointer, in the move that draws the box', async () => {
  const realm = makeRealm();
  const card = realm.add('div', { class: 'card' }, [100, 100, 200, 100]);
  realm.add('p', { class: 'aside' }, [600, 100, 120, 40]);
  realm.namer((node) => (node === card ? { name: 'Card', renamed: false } : null));
  realm.arm();
  await realm.frame();
  realm.move(150, 150);
  // No frame has run since the move.
  assert.equal(realm.part('box').style.display, 'block');
  assert.deepEqual(tagOf(realm), { text: 'div.card  200×100<Card>', what: 'div.card  200×100', who: '<Card>', shown: 'flex' });
  assert.equal(tagOf(realm).text.split(' ')[0], 'div.card');
  // An element with no component shows as it always did.
  realm.move(650, 120);
  assert.deepEqual(tagOf(realm), { text: 'p.aside  120×40', what: 'p.aside  120×40', who: '', shown: 'flex' });
  realm.key('Escape');
});

test('picker events: hovering writes no attribute into the page and posts nothing', async () => {
  const realm = makeRealm();
  const one = realm.add('button', { id: 'one' }, [100, 100, 100, 40]);
  const two = realm.add('button', { id: 'two' }, [300, 100, 100, 40]);
  realm.namer((node) => ({ name: node === one ? 'Save' : 'Cancel' }));
  realm.arm();
  await realm.frame();
  const written = [];
  const posted = [];
  const setAttribute = FakeElement.prototype.setAttribute;
  const postMessage = realm.window.postMessage;
  FakeElement.prototype.setAttribute = function (name, value) {
    if (!realm.doc.inPicker(this) && !this.hasAttribute('data-cdr-picker')) written.push(name);
    return setAttribute.call(this, name, value);
  };
  realm.window.postMessage = (data) => {
    posted.push(data);
    return postMessage(data);
  };
  try {
    for (const [x, y] of [[150, 120], [350, 120], [150, 120]]) {
      realm.move(x, y);
      await realm.frame();
    }
    realm.key('ArrowUp');
  } finally {
    FakeElement.prototype.setAttribute = setAttribute;
    realm.window.postMessage = postMessage;
  }
  assert.deepEqual(realm.asks(), [one, two]);
  assert.deepEqual(written, []);
  assert.deepEqual(posted, []);
  assert.equal([one, two].some((node) => node.hasAttribute('data-cdr-pick')), false);
  realm.key('Escape');
});

test('picker events: each element is asked once an arm, however often it is highlighted, and a moving one is not asked every frame', async () => {
  const realm = makeRealm();
  const still = realm.add('button', { id: 'still' }, [100, 100, 100, 40]);
  let shift = 0;
  const moving = realm.add('button', { id: 'moving' }, () => [300 + shift, 100, 100, 40]);
  const asked = realm.namer((node) => ({ name: node === still ? 'Still' : 'Moving' }));
  realm.arm();
  await realm.frame();
  for (const x of [150, 350, 150, 350]) {
    realm.move(x, 120);
    await realm.frame();
  }
  // tick() draws the box again wherever the element has gone.
  for (let index = 0; index < 10; index += 1) {
    shift += 1;
    await realm.frame();
  }
  assert.equal(realm.part('box').style.left, '310px', 'the box did not follow the element');
  assert.equal(tagOf(realm).who, '<Moving>');
  assert.deepEqual(asked, [still, moving]);
  assert.deepEqual(realm.asks(), [still, moving]);
  realm.key('Escape');
});

test('picker events: with nothing to answer, the tag is as it was, and the arm asks once', async () => {
  const realm = makeRealm();
  const one = realm.add('button', { id: 'one', class: 'save' }, [100, 100, 100, 40]);
  const two = realm.add('button', { id: 'two' }, [300, 100, 100, 40]);
  realm.arm();
  await realm.frame();
  realm.move(150, 120);
  assert.deepEqual(tagOf(realm), { text: 'button#one.save  100×40', what: 'button#one.save  100×40', who: '', shown: 'flex' });
  realm.move(350, 120);
  realm.key('ArrowUp');
  realm.move(150, 120);
  await realm.frame(3);
  assert.equal(tagOf(realm).text, 'button#one.save  100×40');
  assert.deepEqual(realm.asks(), [one], 'a silent page was asked again in the same arm');
  // The next arm asks again, and a collector that has come meanwhile is heard.
  realm.key('Escape');
  realm.namer(() => ({ name: 'SaveButton' }));
  realm.arm();
  await realm.frame();
  realm.move(152, 120);
  assert.equal(tagOf(realm).text, 'button#one.save  100×40<SaveButton>');
  assert.deepEqual(realm.asks(), [one, one]);
  realm.key('Escape');
});

test('picker events: an element the page\'s world finds no component for shows as it was, and the arm goes on asking', async () => {
  const realm = makeRealm();
  const plain = realm.add('div', { id: 'plain' }, [100, 100, 100, 40]);
  const card = realm.add('div', { id: 'card' }, [300, 100, 100, 40]);
  realm.namer((node) => (node === card ? { name: 'Card' } : null));
  realm.arm();
  await realm.frame();
  realm.move(150, 120);
  assert.equal(tagOf(realm).text, 'div#plain  100×40');
  realm.move(350, 120);
  assert.equal(tagOf(realm).text, 'div#card  100×40<Card>');
  realm.move(150, 120);
  assert.deepEqual(realm.asks(), [plain, card]);
  realm.key('Escape');
});

test('picker events: the name is asked of the outermost closed host inside a closed root, of the element inside an open one, and of a frame itself', async () => {
  const realm = makeRealm();
  const doc = realm.doc;
  const sealed = realm.add('x-sealed', { id: 'sealed' }, [100, 100, 300, 100]);
  const pay = sealed.attachShadow({ mode: 'closed' }).appendChild(new FakeElement(doc, 'button', { class: 'pay' }));
  pay.rect = [120, 120, 80, 30];
  const card = realm.add('x-card', {}, [100, 300, 300, 100]);
  const save = card.attachShadow({ mode: 'open' }).appendChild(new FakeElement(doc, 'button', { class: 'save' }));
  save.rect = [120, 320, 80, 30];
  realm.add('div', { id: 'under' }, [500, 100, 400, 300]);
  const frame = realm.add('iframe', { id: 'fr', src: '/embed' }, [550, 150, 300, 200]);
  const names = new Map([[sealed, 'PaymentCard'], [save, 'SaveButton'], [frame, 'Embed']]);
  const asked = realm.namer((node) => (names.has(node) ? { name: names.get(node) } : null));
  realm.arm();
  await realm.frame();
  realm.move(150, 130);
  assert.equal(tagOf(realm).text, 'button.pay  80×30<PaymentCard>');
  realm.move(150, 330);
  assert.equal(tagOf(realm).text, 'button.save  80×30<SaveButton>');
  realm.move(700, 250);
  await realm.frame();
  assert.equal(tagOf(realm).text, 'iframe#fr  300×200<Embed>');
  assert.deepEqual(asked, [sealed, save, frame]);
  // Sent on the host, not inside its closed root, where the component's own
  // listeners would have heard it.
  assert.deepEqual(realm.asks(), [sealed, save, frame]);
  assert.equal(realm.asks().filter(insideClosed).length, 0, 'asked inside a closed root');
  realm.key('Escape');
});

test('picker events: a reply that is not a name is dropped or rebuilt, and nothing it does throws', async () => {
  const realm = makeRealm();
  const replies = [
    ['long', { name: 'N'.repeat(10000) }, `<${'N'.repeat(59)}…>`],
    ['a number', 42, ''],
    ['an object with no name', { label: 'Card' }, ''],
    ['an array', ['Card'], ''],
    ['a name that is not a string', { name: { toString: () => 'Card' } }, ''],
    ['a name behind a getter that throws', { get name() { throw new Error('DataCloneError'); } }, ''],
    ['renamed that is not true', { name: 'Card', renamed: 'yes' }, '<Card>'],
    ['markup', { name: '<img src=x onerror=alert(1)>' }, '<<img src=x onerror=alert(1)>>'],
  ];
  const nodes = replies.map(([label], index) => realm.add('div', { id: `r${index}`, title: label }, [index * 110 + 10, 100, 100, 40]));
  // A detail that cannot be read, and two replies to one request.
  const unreadable = realm.add('div', { id: 'unreadable' }, [10, 300, 100, 40]);
  const twice = realm.add('div', { id: 'twice' }, [200, 300, 100, 40]);
  realm.window.addEventListener(
    '__cdr_name',
    (event) => {
      const node = event.composedPath()[0];
      const index = nodes.indexOf(node);
      if (index !== -1) realm.deliver('__cdr_name:reply', { detail: replies[index][1], quiet: true });
      if (node === unreadable) {
        realm.deliver('__cdr_name:reply', { quiet: true, lazyDetail: () => { throw new Error('DataCloneError'); } });
      }
      if (node === twice) {
        realm.deliver('__cdr_name:reply', { detail: { name: 'First' }, quiet: true });
        realm.deliver('__cdr_name:reply', { detail: { name: 'Second' }, quiet: true });
      }
    },
    true
  );
  realm.arm();
  await realm.frame();
  replies.forEach(([label, , shown], index) => {
    assert.doesNotThrow(() => realm.move(index * 110 + 60, 120), label);
    assert.equal(tagOf(realm).who, shown, label);
    assert.ok(tagOf(realm).who.length <= NAME_SHOWN_MAX, label);
  });
  realm.move(60, 320);
  assert.equal(tagOf(realm).who, '');
  realm.move(250, 320);
  assert.equal(tagOf(realm).who, '<First>');
  realm.key('Escape');

  // A reply that comes after the dispatch has returned is no reply: the
  // tag shows the element alone, and the arm asks no more.
  const late = makeRealm();
  const one = late.add('div', { id: 'one' }, [100, 100, 100, 40]);
  late.add('div', { id: 'two' }, [300, 100, 100, 40]);
  late.window.addEventListener(
    '__cdr_name',
    () => setImmediate(() => late.deliver('__cdr_name:reply', { detail: { name: 'Late' }, quiet: true })),
    true
  );
  late.arm();
  await late.frame();
  late.move(150, 120);
  await late.frame();
  assert.equal(tagOf(late).text, 'div#one  100×40');
  late.move(350, 120);
  await late.frame();
  assert.equal(tagOf(late).text, 'div#two  100×40');
  assert.deepEqual(late.asks(), [one]);
  late.key('Escape');
});

// The most a name takes in the tag: NAME_ROOM characters, the brackets and
// the word for a bundler's name.
const NAME_SHOWN_MAX = 60 + 2 + ' minified'.length;

test('picker events: the arrow keys, on the page and from the panel, show the parent\'s name', async () => {
  const realm = makeRealm();
  const form = realm.add('form', { class: 'coupon' }, [100, 100, 400, 200]);
  const input = realm.add('input', { id: 'coupon' }, [120, 120, 200, 40], form);
  const names = new Map([[form, 'CouponForm'], [input, 'CouponField']]);
  realm.namer((node) => (names.has(node) ? { name: names.get(node) } : null));
  realm.arm();
  await realm.frame();
  realm.move(150, 130);
  assert.equal(tagOf(realm).text, 'input#coupon  200×40<CouponField>');
  realm.key('ArrowUp');
  assert.equal(tagOf(realm).text, 'form.coupon  400×200<CouponForm>');
  realm.key('ArrowDown');
  assert.equal(tagOf(realm).who, '<CouponField>');
  realm.key('Escape');
  realm.arm();
  await realm.frame();
  realm.move(152, 130);
  assert.equal(realm.picker.key('ArrowUp'), true);
  assert.equal(tagOf(realm).text, 'form.coupon  400×200<CouponForm>');
  realm.key('Escape');
});

test('picker events: a name the bundler made up says so, and a tag as wide as a long name is kept inside the viewport', async () => {
  const realm = makeRealm();
  const edge = realm.add('button', { id: 'edge' }, [900, 100, 90, 40]);
  realm.add('button', { id: 'left' }, [10, 100, 90, 40]);
  realm.namer((node) => (node === edge ? { name: 'A', renamed: true } : { name: 'Toolbar', renamed: false }));
  realm.arm();
  await realm.frame();
  // As Chrome measures it, once it holds both parts.
  realm.part('tag').offsetWidth = 360;
  realm.move(940, 120);
  assert.equal(tagOf(realm).text, 'button#edge  90×40<A> minified');
  assert.equal(realm.part('tag').style.left, `${1000 - 360 - 4}px`);
  realm.move(50, 120);
  assert.equal(tagOf(realm).who, '<Toolbar>');
  assert.equal(realm.part('tag').style.left, '10px');
  realm.key('Escape');
});

test('picker events: the pick sends what it always sent, and the tag is gone before the screenshot', async () => {
  const realm = makeRealm();
  const card = realm.add('div', { class: 'card' }, [100, 100, 200, 100]);
  realm.text(card, 'Hello');
  realm.namer(() => ({ name: 'Card' }));
  realm.collector((data) => (data.action === 'inspect' ? { component: { framework: 'react', names: ['Card'], hops: 0 }, handlers: null } : null));
  realm.arm();
  await realm.frame();
  realm.move(150, 150);
  assert.equal(tagOf(realm).who, '<Card>');
  // Held, since the host leaves the page at the pick.
  const tag = realm.part('tag');
  realm.press(150, 150);
  realm.release(150, 150);
  assert.equal(tag.style.display, 'none', 'the tag was still shown at the pick');
  await realm.idle(1000);
  const [pick] = realm.picks();
  assert.deepEqual(pick.element.component, { framework: 'react', names: ['Card'], hops: 0 });
  assert.equal(pick.element.html, '<div class="card">Hello</div>');
});

// Page code can run while the page's world reads a name (a getter on a
// fiber's type), and focus() it calls there sends a trusted focusin, which
// the picker follows. Drawn before the name was asked, the box stayed on
// the focused element under the tag of the one hovered. And the question
// that nested highlight asked, which the collector leaves unanswered while
// it answers another, was taken for a page with no collector, so the rest
// of the arm showed no name.
test('picker events: a focus the page moves while a name is read leaves the box and the tag on one element', async () => {
  const realm = makeRealm();
  const card = realm.add('div', { id: 'card' }, [100, 100, 200, 100]);
  const field = realm.add('input', { id: 'field' }, [500, 100, 200, 40]);
  const note = realm.add('p', { id: 'note' }, [100, 400, 200, 40]);
  const names = new Map([[card, 'Card'], [field, 'Field'], [note, 'Note']]);
  let naming = false;
  realm.window.addEventListener(
    '__cdr_name',
    (event) => {
      // As the collector does, a request sent while one is answered gets none.
      if (naming) return;
      naming = true;
      try {
        const node = event.composedPath()[0];
        if (node === card) realm.deliver('focusin', { target: field, quiet: true });
        realm.deliver('__cdr_name:reply', { detail: { name: names.get(node) }, quiet: true });
      } finally {
        naming = false;
      }
    },
    true
  );
  realm.arm();
  await realm.frame();
  realm.move(150, 150);
  assert.equal(tagOf(realm).text, 'div#card  200×100<Card>');
  assert.equal(realm.part('box').style.left, '100px', 'the box is on another element than the tag');
  assert.deepEqual(realm.asks(), [card], 'the highlight the focus set off asked a question of its own');
  // And the element the keys move from is the one drawn, named as any other.
  realm.key('ArrowRight');
  assert.equal(tagOf(realm).what, 'input#field  200×40');
  assert.equal(tagOf(realm).who, '<Field>', 'the arm stopped asking after the focus');
  realm.move(150, 420);
  assert.equal(tagOf(realm).text, 'p#note  200×40<Note>');
  assert.deepEqual(realm.asks(), [card, field, note]);
  realm.key('Escape');
});

// The names are kept for one arm only: one read before the page hydrated,
// or before Fast Refresh renamed a component, is read again at the next.
test('picker events: a name is read again at the next arm, not kept from the last', async () => {
  const realm = makeRealm();
  const card = realm.add('div', { id: 'card' }, [100, 100, 200, 100]);
  let hydrated = false;
  realm.namer((node) => (hydrated && node === card ? { name: 'Card' } : null));
  realm.arm();
  await realm.frame();
  realm.move(150, 150);
  assert.equal(tagOf(realm).text, 'div#card  200×100');
  realm.key('Escape');
  hydrated = true;
  realm.arm();
  await realm.frame();
  realm.move(152, 150);
  assert.equal(tagOf(realm).text, 'div#card  200×100<Card>');
  assert.deepEqual(realm.asks(), [card, card]);
  realm.key('Escape');
});
