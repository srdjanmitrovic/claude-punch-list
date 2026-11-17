/**
 * Capture: the region overlay, the crop, the panel's side of an arm, and the
 * worker's checks on who may ask it for what.
 *
 * The overlay and the bridge run here for real, in a node:vm realm against a
 * stub of the few DOM calls they make. The stub keeps a tree, attributes,
 * listeners, a top layer, the focused element, the page's open shadow roots
 * and the slots their hosts' children are drawn in, and lays nothing out, so what these prove is where the overlay puts
 * its host, what it listens to and what it sends, not how it looks. How it
 * looks under a modal dialog (one in a shadow root, one opened, closed or
 * removed while armed), a transformed body, a pinch zoom and a touch drag was
 * checked in Chrome.
 *
 * The crop is lifted out of sidepanel/panel.js and run against a canvas that
 * records what it was asked to draw. The panel and the worker run in the
 * realms of test/support/.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { FakePage, PANEL_SENDER, flush, loadWorker } from './support/worker-realm.mjs';
import { defaultWorker, loadPanel } from './support/panel-realm.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const OVERLAY = read('content/overlay.js');
const PICKER = read('content/picker.js');
const BRIDGE = read('content/collector-bridge.js');
const PANEL = read('sidepanel/panel.js');

const ARMED_DURING_SCREEN =
  'A capture mode was armed while this screenshot waited, so its overlay may show in it.';

// ------------------------------------------------------------ a stub DOM --

class StubElement {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.ownerDocument = doc;
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.style = {};
    this.className = '';
    this.textContent = '';
    this.modal = false;
    this.popoverOpen = false;
    this.shadowRoot = null; // an open shadow root of the page's, see StubShadowRoot
    this.assignedSlot = null; // the slot in a shadow tree this child of its host is drawn in
  }
  get parentElement() {
    return this.parentNode instanceof StubElement ? this.parentNode : null;
  }
  getRootNode() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node === this.ownerDocument.documentElement ? this.ownerDocument : node;
  }
  /** What showModal() does, as far as the overlay can see: modal, in the top layer, focus inside. */
  showModal(focus = this) {
    this.modal = true;
    this.ownerDocument.topLayer.push(this);
    this.ownerDocument.focus(focus);
  }
  /** What close() does: not modal, out of the top layer, and a close event later. */
  close() {
    this.modal = false;
    const layer = this.ownerDocument.topLayer;
    if (layer.includes(this)) layer.splice(layer.indexOf(this), 1);
    this.ownerDocument.focus(null);
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  removeChild(node) {
    this.children = this.children.filter((child) => child !== node);
    node.parentNode = null;
    // Taken out of the tree, a popover leaves the top layer, and so does one
    // inside what was taken out, shadow roots included.
    for (const one of composed(node)) if (one.popoverOpen) one.hidePopover();
    return node;
  }
  get isConnected() {
    let node = this;
    for (;;) {
      while (node.parentNode) node = node.parentNode;
      // Through a shadow root to its host, as the composed tree goes.
      if (node instanceof StubShadowRoot) node = node.host;
      else break;
    }
    return node === this.ownerDocument.documentElement;
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  removeEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    const at = list.indexOf(listener);
    if (at !== -1) list.splice(at, 1);
  }
  listening(type) {
    return (this.listeners.get(type) || []).length > 0;
  }
  /** Dispatches to this element's own listeners; returns whether propagation was stopped. */
  dispatch(type, init = {}) {
    let stopped = false;
    const event = {
      type,
      target: this,
      button: 0,
      pointerId: 1,
      preventDefault() {
        event.defaultPrevented = true;
      },
      stopPropagation() {
        stopped = true;
      },
      ...init,
    };
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
    return { stopped, defaultPrevented: Boolean(event.defaultPrevented) };
  }
  setPointerCapture() {}
  matches(selector) {
    if (selector === ':popover-open') return this.popoverOpen;
    // Taken out of the document, a modal dialog is modal no longer.
    if (selector === 'dialog:modal') return this.tagName === 'DIALOG' && this.modal && this.isConnected;
    return false;
  }
  showPopover() {
    if (!this.hasAttribute('popover')) throw new Error('NotSupportedError: not a popover');
    if (!this.isConnected) throw new Error('InvalidStateError: not connected');
    this.popoverOpen = true;
    this.ownerDocument.topLayer.push(this);
  }
  hidePopover() {
    this.popoverOpen = false;
    const layer = this.ownerDocument.topLayer;
    if (layer.includes(this)) layer.splice(layer.indexOf(this), 1);
  }
  /** The stub lays nothing out: every box is the same point (see hitTest). */
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  attachShadow() {
    const shadow = { classes: new Map(), styleText: '' };
    Object.defineProperty(shadow, 'innerHTML', {
      set: (html) => {
        shadow.styleText = (/<style>([\s\S]*?)<\/style>/.exec(html) || [])[1] || '';
        for (const [, name] of html.matchAll(/class="([\w-]+)"/g)) {
          const node = new StubElement('div', this.ownerDocument);
          node.className = name;
          shadow.classes.set(name, node);
        }
      },
    });
    shadow.querySelector = (selector) => shadow.classes.get(selector.replace(/^\./, '')) || null;
    this.shadow = shadow;
    return shadow;
  }
  /** Every descendant, depth first, in the light DOM only, as querySelectorAll goes. */
  *walk() {
    for (const child of this.children) {
      yield child;
      yield* child.walk();
    }
  }
}

/** A node and every node under it, through open shadow roots too. */
function* composed(node) {
  yield node;
  for (const child of [...(node.shadowRoot?.children || []), ...node.children]) yield* composed(child);
}

/** Whether node is ancestor or inside it, through shadow roots to their hosts. */
function within(ancestor, node) {
  for (let at = node; at; at = at.parentNode || (at instanceof StubShadowRoot ? at.host : null)) {
    if (at === ancestor) return true;
  }
  return false;
}

/**
 * querySelectorAll in one scope (a document or a shadow root), its own tree
 * only, for the selectors the overlay asks: dialog:modal and :popover-open,
 * alone or in a list.
 */
function queryScope(nodes, selector) {
  const parts = selector.split(',').map((part) => part.trim());
  for (const part of parts) if (part !== 'dialog:modal' && part !== ':popover-open') throw new Error(`stub cannot answer ${selector}`);
  return nodes.filter((node) => parts.some((part) => node.matches(part)));
}

/**
 * Hit testing, as Chrome was seen to do it under a modal dialog: the last
 * thing in the top layer that is not inert is hit, everything outside the
 * last modal dialog there being inert, and the modal's ::backdrop, which
 * covers the viewport, is hit as the dialog. With nothing in the top layer,
 * the body. Retargeted to `scope`, as document.elementFromPoint and a shadow
 * root's are. The stub lays nothing out, so every point is the same point.
 */
function hitTest(document, scope) {
  const layer = document.topLayer;
  const modal = [...layer].reverse().find((node) => node.tagName === 'DIALOG' && node.modal) || null;
  let hit = null;
  for (let i = layer.length - 1; i >= 0 && !hit; i -= 1) if (!modal || within(modal, layer[i])) hit = layer[i];
  if (!hit && !modal) hit = document.body;
  while (hit && hit.getRootNode() !== scope && hit.getRootNode() instanceof StubShadowRoot) hit = hit.getRootNode().host;
  return hit;
}

/**
 * An open shadow root of the page's, such as a component library's dialog
 * lives in. Its nodes are out of the document's querySelectorAll, and its
 * activeElement is the focused node inside it.
 */
class StubShadowRoot {
  constructor(host) {
    this.host = host;
    this.children = [];
    this.activeElement = null;
    host.shadowRoot = this;
  }
  appendChild(node) {
    return StubElement.prototype.appendChild.call(this, node);
  }
  removeChild(node) {
    return StubElement.prototype.removeChild.call(this, node);
  }
  querySelectorAll(selector) {
    return queryScope(this.children.flatMap((child) => [child, ...child.walk()]), selector);
  }
  elementFromPoint() {
    return hitTest(this.host.ownerDocument, this);
  }
}

/**
 * A page for a content script: a document with a body, a window with the
 * listeners and frames a test drives, and a runtime that records what is
 * sent. `popovers: false` is a browser without them.
 */
function makePage({ popovers = true, visual = null, width = 1000, height = 700 } = {}) {
  const document = {
    topLayer: [],
    activeElement: null,
    /** Focus a node, or none: retargeted to the host at each shadow root, as Chrome reports it. */
    focus(node) {
      let at = node;
      while (at && at.getRootNode() instanceof StubShadowRoot) {
        const root = at.getRootNode();
        root.activeElement = at;
        at = root.host;
      }
      document.activeElement = at || document.body;
    },
    createElement(tag) {
      const node = new StubElement(tag, document);
      if (!popovers) {
        node.showPopover = undefined;
        node.hidePopover = undefined;
      }
      return node;
    },
    querySelectorAll(selector) {
      return queryScope([...document.documentElement.walk()], selector);
    },
    elementFromPoint() {
      return hitTest(document, document);
    },
  };
  document.documentElement = new StubElement('html', document);
  document.body = document.documentElement.appendChild(new StubElement('body', document));

  const sent = [];
  const frames = [];
  const windowListeners = new Map();
  const window = {
    document,
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio: 2,
    visualViewport: visual,
    chrome: {
      runtime: {
        id: 'ext',
        sendMessage: (message) => {
          sent.push(JSON.parse(JSON.stringify(message)));
          return Promise.resolve();
        },
      },
    },
    requestAnimationFrame: (callback) => frames.push(callback),
    addEventListener(type, listener) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(listener);
    },
    removeEventListener(type, listener) {
      const list = windowListeners.get(type) || [];
      const at = list.indexOf(listener);
      if (at !== -1) list.splice(at, 1);
    },
  };
  window.window = window;
  const realm = vm.createContext(window);

  return {
    window,
    document,
    sent,
    /** Run a content script as executeScript does; returns its completion value. */
    inject(source, filename = 'content/overlay.js') {
      return vm.runInContext(source, realm, { filename });
    },
    /** Run every animation frame queued so far, and the ones they queue, `n` deep. */
    frames(n = 2) {
      for (let i = 0; i < n; i += 1) for (const callback of frames.splice(0)) callback();
    },
    key(key, init = {}) {
      let prevented = false;
      const event = {
        type: 'keydown',
        key,
        preventDefault() {
          prevented = true;
        },
        stopPropagation() {},
        stopImmediatePropagation() {},
        ...init,
      };
      for (const listener of [...(windowListeners.get('keydown') || [])]) listener(event);
      return prevented;
    },
    /** The overlay's host, wherever it was put in the document, shadow roots included. */
    host() {
      return [...composed(document.documentElement)].find((node) => node.hasAttribute?.('data-cdr-overlay')) || null;
    },
    /** An event that reaches the window's own listeners, as focusin and a light DOM dialog's close do. */
    event(type, target, init = {}) {
      for (const listener of [...(windowListeners.get(type) || [])]) listener({ type, target, ...init });
    },
  };
}

const root = (host) => host.shadow.querySelector('.root');
const shown = (node) => node.style.display === 'block';

// -------------------------------------------------------------- overlay --

// CW3. A modal dialog makes everything outside it inert and sits in the top
// layer, where no z-index reaches: the overlay drew under it and no drag got
// through.
test('overlay: with a modal dialog open, the host goes inside it and into the top layer', () => {
  const page = makePage();
  const dialog = page.document.body.appendChild(page.document.createElement('dialog'));
  dialog.modal = true;
  page.inject(OVERLAY);
  const host = page.host();
  assert.equal(host.parentNode, dialog, 'the host was put outside the modal dialog, where it is inert');
  assert.equal(host.getAttribute('popover'), 'manual');
  assert.deepEqual(page.document.topLayer, [host]);
});

test('overlay: with dialogs nested, the host goes into the inner one', () => {
  const page = makePage();
  const outer = page.document.body.appendChild(page.document.createElement('dialog'));
  const inner = outer.appendChild(page.document.createElement('dialog'));
  outer.modal = inner.modal = true;
  page.inject(OVERLAY);
  assert.equal(page.host().parentNode, inner);
});

/** Whether the overlay can be seen and used: in the document, and shown in the top layer. */
function usable(page) {
  const host = page.host();
  return Boolean(host && host.isConnected && host.popoverOpen && page.document.topLayer.at(-1) === host);
}

/** A drag the page cannot have taken: through the host, wherever it is. */
function drag(page) {
  const r = root(page.host());
  r.dispatch('pointerdown', { clientX: 10, clientY: 20 });
  r.dispatch('pointerup', { clientX: 110, clientY: 220 });
  page.frames();
  return page.sent.at(-1);
}

// Found in Chrome (verify V2): the host went into the modal dialog, and the
// page then closed or removed that dialog, as a loading modal or a framework
// unmounting one does. The host was left in a closed dialog, drawn at no size,
// or was gone with it, while the panel and the worker stayed armed.
test('overlay: a modal dialog the page closes while armed does not take the overlay with it', () => {
  const page = makePage();
  const dialog = page.document.body.appendChild(page.document.createElement('dialog'));
  dialog.showModal();
  page.inject(OVERLAY);
  assert.equal(page.host().parentNode, dialog);

  dialog.close();
  page.event('close', dialog); // a light DOM dialog's close reaches the window
  assert.equal(page.host().parentNode, page.document.body, 'the host stayed in the closed dialog');
  assert.equal(usable(page), true);
  assert.equal(drag(page)?.type, 'cdr:region-selected');
});

test('overlay: a modal dialog the page removes while armed does not take the overlay with it', () => {
  const page = makePage();
  const dialog = page.document.body.appendChild(page.document.createElement('dialog'));
  dialog.showModal();
  page.inject(OVERLAY);
  // Removing a dialog sends no event at all; the next frame finds it.
  page.document.body.removeChild(dialog);
  assert.equal(page.host(), null);
  page.frames(1);
  assert.equal(page.host()?.parentNode, page.document.body, 'the host went with the dialog');
  assert.equal(usable(page), true);
  assert.equal(page.window.__cdrRegionOverlay.isActive(), true);
  assert.equal(drag(page)?.type, 'cdr:region-selected');
});

test('overlay: the host is put back when the page takes it out of the document, or hides it', () => {
  const page = makePage();
  page.inject(OVERLAY);
  page.document.body.removeChild(page.host());
  page.frames(1);
  assert.equal(usable(page), true, 'a host the page removed stayed out');
  page.host().hidePopover(); // a page that hides every popover it finds
  page.frames(1);
  assert.equal(usable(page), true, 'a host the page hid stayed hidden');
});

// Low in verify V2, and in 0.5.0 too: a modal opened after the arm made the
// whole page inert, the overlay included.
test('overlay: a modal dialog opened after the arm gets the host, as it takes focus', () => {
  const page = makePage();
  page.inject(OVERLAY);
  const dialog = page.document.body.appendChild(page.document.createElement('dialog'));
  const button = dialog.appendChild(page.document.createElement('button'));
  dialog.showModal(button);
  page.event('focusin', button);
  assert.equal(page.host().parentNode, dialog, 'the host was left outside the new modal, where it is inert');
  assert.equal(usable(page), true);

  // One whose opening the listeners do not hear (a page that stops focusin
  // on its way to the window) is found within a few frames.
  const second = dialog.appendChild(page.document.createElement('dialog'));
  second.showModal();
  assert.equal(page.host().parentNode, dialog);
  page.frames(16);
  assert.equal(page.host().parentNode, second);
  assert.equal(usable(page), true);
});

// Medium in verify V2, and in 0.5.0 too: a component's dialog in a shadow
// root is out of the document's querySelectorAll, so the host went on the
// body, where the modal made it inert.
test('overlay: a modal dialog inside a shadow root is found through the focus', () => {
  const page = makePage();
  const component = page.document.body.appendChild(page.document.createElement('x-modal'));
  const shadow = new StubShadowRoot(component);
  const dialog = shadow.appendChild(page.document.createElement('dialog'));
  const button = dialog.appendChild(page.document.createElement('button'));
  dialog.showModal(button);
  assert.equal(page.document.activeElement, component, 'the stub does not retarget focus as Chrome does');
  assert.deepEqual(page.document.querySelectorAll('dialog:modal'), []);

  page.inject(OVERLAY);
  assert.equal(page.host().parentNode, dialog, 'the host went outside the shadow root\'s modal');
  assert.equal(usable(page), true);

  // Closed inside the shadow root, where its close event stays: found on
  // the next frame.
  dialog.close();
  page.frames(1);
  assert.equal(page.host().parentNode, page.document.body);
  assert.equal(usable(page), true);
});

// Medium in the second verification (R2), and in 0.5.0 too: a component
// whose own <dialog> is in its shadow root and wraps the content the page
// slots into it, as md-dialog does. The focus is on that content, in the
// light DOM, whose parents there never reach the dialog: the host went on
// the body, where the modal made it inert, and a drag reached the page.
test('overlay: a modal dialog in a shadow root around content slotted from the light DOM is found', () => {
  const page = makePage();
  const component = page.document.body.appendChild(page.document.createElement('x-dialog'));
  const shadow = new StubShadowRoot(component);
  const dialog = shadow.appendChild(page.document.createElement('dialog'));
  const slot = dialog.appendChild(page.document.createElement('slot'));
  const label = component.appendChild(page.document.createElement('label'));
  const input = label.appendChild(page.document.createElement('input'));
  label.assignedSlot = slot;
  dialog.showModal(input);
  assert.equal(page.document.activeElement, input, 'the focus is in the light DOM, as Chrome reports it');
  assert.deepEqual(page.document.querySelectorAll('dialog:modal'), []);

  page.inject(OVERLAY);
  assert.equal(page.host().parentNode, dialog, 'the host went outside the modal its focused content is slotted into');
  assert.equal(usable(page), true);
  page.frames(32);
  assert.equal(page.host().parentNode, dialog);
});

// Low in the second verification (R2), new in the fix round: a light DOM
// modal open, a shadow root's on top of it, and the page then drops the
// focus. The frame loop's query, which cannot see the shadow root's modal,
// answered with the light one underneath, and the host moved there, inert.
test('overlay: with the focus dropped, the host stays in the open modal it is in', () => {
  const page = makePage();
  const light = page.document.body.appendChild(page.document.createElement('dialog'));
  light.showModal();
  const component = page.document.body.appendChild(page.document.createElement('x-modal'));
  const shadow = new StubShadowRoot(component);
  const top = shadow.appendChild(page.document.createElement('dialog'));
  const button = top.appendChild(page.document.createElement('button'));
  top.showModal(button);
  page.inject(OVERLAY);
  assert.equal(page.host().parentNode, top);

  // blur(): nothing has focus.
  page.document.focus(null);
  shadow.activeElement = null;
  page.frames(32);
  assert.equal(page.host().parentNode, top, 'the host moved into the modal underneath');
  assert.equal(usable(page), true);

  // Taken out by the page, it goes back into the same one.
  top.removeChild(page.host());
  page.frames(1);
  assert.equal(page.host().parentNode, top);

  // And once that one closes, into the one left.
  top.close();
  page.frames(1);
  assert.equal(page.host().parentNode, light);
  assert.equal(usable(page), true);
});

// Medium in the third verification (T2), and in 0.5.0 too: Region armed with
// the focus already gone (a framework re-rendered the focused field away, or
// the page blurred it). With no focus to follow and no modal kept, the
// document's query decided: it does not look in shadow roots and goes by
// document order, so the host went on the body under a shadow root's modal,
// or into the lower of two, where it was inert and the drag reached the page.
test('overlay: armed with no focus, the host goes into the modal on top, in a shadow root too', () => {
  const component = (page) => {
    const element = page.document.body.appendChild(page.document.createElement('x-dialog'));
    const shadow = new StubShadowRoot(element);
    return { element, shadow, dialog: shadow.appendChild(page.document.createElement('dialog')) };
  };
  const dropFocus = (page, ...shadows) => {
    page.document.focus(null);
    for (const shadow of shadows) shadow.activeElement = null;
  };

  // One modal, in a shadow root.
  let page = makePage();
  let shadowed = component(page);
  shadowed.dialog.showModal();
  dropFocus(page, shadowed.shadow);
  page.inject(OVERLAY);
  assert.equal(page.host().parentNode, shadowed.dialog, 'the host went outside the shadow root\'s modal');
  page.frames(32);
  assert.equal(page.host().parentNode, shadowed.dialog);
  assert.equal(usable(page), true);

  // Two in the light DOM, the one on top earlier in the document.
  page = makePage();
  const top = page.document.body.appendChild(page.document.createElement('dialog'));
  const under = page.document.body.appendChild(page.document.createElement('dialog'));
  under.showModal();
  top.showModal();
  dropFocus(page);
  page.inject(OVERLAY);
  assert.equal(page.host().parentNode, top, 'the host went into the modal underneath');
  page.frames(32);
  assert.equal(page.host().parentNode, top);

  // A light DOM modal underneath, later in the document than a component
  // whose modal was opened after it.
  page = makePage();
  shadowed = component(page);
  const light = page.document.body.appendChild(page.document.createElement('dialog'));
  light.showModal();
  shadowed.dialog.showModal();
  dropFocus(page, shadowed.shadow);
  page.inject(OVERLAY);
  assert.equal(page.host().parentNode, shadowed.dialog, 'the host went into the light DOM modal underneath');
  page.frames(32);
  assert.equal(page.host().parentNode, shadowed.dialog);

  // Once that closes, into the one left.
  shadowed.dialog.close();
  page.frames(1);
  assert.equal(page.host().parentNode, light);
  assert.equal(usable(page), true);
});

// Low in the third verification (T2), the limit the second fix round stated:
// a popover a component shows from its shadow root while armed sends its
// toggle no further than that root, so the host was never raised over it,
// and a drag that started on it went to the page.
test('overlay: a popover shown from a shadow root while armed is raised over within a few frames', () => {
  const page = makePage();
  const element = page.document.body.appendChild(page.document.createElement('x-toast'));
  const shadow = new StubShadowRoot(element);
  const toast = shadow.appendChild(page.document.createElement('div'));
  toast.setAttribute('popover', 'manual');
  page.inject(OVERLAY);
  page.frames(3);
  toast.showPopover();
  assert.equal(usable(page), false, 'the stub does not put a popover shown later above');
  page.frames(16);
  assert.equal(usable(page), true, 'the toast stayed over the overlay');
  assert.equal(drag(page)?.type, 'cdr:region-selected');

  // Hidden and shown again, it is raised over again.
  page.inject(OVERLAY);
  page.frames(16);
  toast.hidePopover();
  page.frames(16);
  toast.showPopover();
  page.frames(16);
  assert.equal(usable(page), true, 'the toast shown again stayed over the overlay');
});

// Low in the second verification (R2), and in 0.5.0 too: a popover the page
// shows while armed (a toast) goes into the top layer after the host, is
// drawn over it, and a drag that starts on it goes to the page.
test('overlay: a popover the page shows while armed is not left over the overlay', () => {
  const page = makePage();
  page.inject(OVERLAY);
  const toast = page.document.body.appendChild(page.document.createElement('div'));
  toast.setAttribute('popover', 'manual');
  toast.showPopover();
  assert.equal(usable(page), false, 'the stub does not put a popover shown later above');
  // Its toggle reaches the window's capture listeners from the light DOM.
  page.event('toggle', toast, { newState: 'open' });
  assert.equal(usable(page), true, 'the toast stayed over the overlay');
  assert.equal(drag(page)?.type, 'cdr:region-selected');

  // One going away moves nothing; one that the overlay does not hear (in a
  // shadow root, where its toggle stays) is raised over when the shortcut is
  // pressed again.
  page.inject(OVERLAY);
  const quiet = page.document.body.appendChild(page.document.createElement('div'));
  quiet.setAttribute('popover', 'manual');
  quiet.showPopover();
  page.event('toggle', quiet, { newState: 'closed' });
  assert.equal(usable(page), false);
  page.inject(OVERLAY);
  assert.equal(usable(page), true, 'pressing the shortcut again left the overlay covered');
});

test('overlay: a page that raises its popover whenever the host is raised is not chased for ever', () => {
  const page = makePage();
  page.inject(OVERLAY);
  const toast = page.document.body.appendChild(page.document.createElement('div'));
  toast.setAttribute('popover', 'manual');
  let raised = 0;
  for (let i = 0; i < 300; i += 1) {
    if (toast.popoverOpen) toast.hidePopover();
    toast.showPopover();
    page.event('toggle', toast, { newState: 'open' });
    if (usable(page)) raised += 1;
  }
  assert.ok(raised <= 100, `${raised} raises`);
  assert.ok(raised > 50, `only ${raised} raises`);
});

// The shortcut pressed again because the overlay is not to be seen: the arm
// stood, and start() returned before it looked.
test('overlay: armed again while armed, a host the page took away is put back', () => {
  const page = makePage();
  const run = page.inject(OVERLAY);
  page.document.body.removeChild(page.host());
  assert.equal(page.inject(OVERLAY), run, 'a second arm made another run');
  assert.equal(usable(page), true, 'the arm stood with nothing on the page');
});

// A page that removes whatever it did not put there would trade the host
// back and forth with the overlay every frame, for as long as it is armed.
test('overlay: a page that keeps taking the host away is not chased for ever', () => {
  const page = makePage();
  page.inject(OVERLAY);
  let removed = 0;
  for (let i = 0; i < 300; i += 1) {
    const host = page.host();
    if (host) {
      page.document.body.removeChild(host);
      removed += 1;
    }
    page.frames(1);
  }
  assert.ok(removed <= 101, `${removed} removals were each answered`);
  assert.ok(removed > 50, `only ${removed} removals were answered`);
  // The user asks again, and is answered.
  page.inject(OVERLAY);
  assert.equal(usable(page), true);
});

// M1. A transform or filter on the body made position: fixed relative to the
// body, so the box drew at document coordinates and scrolled away. The top
// layer is laid out against the viewport whatever the ancestors do.
test('overlay: without a modal dialog the host is still shown in the top layer, and leaves it on stop', () => {
  const page = makePage();
  page.inject(OVERLAY);
  const host = page.host();
  assert.equal(host.parentNode, page.document.body);
  assert.equal(host.getAttribute('popover'), 'manual');
  assert.deepEqual(page.document.topLayer, [host], 'the host is not in the top layer');
  // A popover's own defaults are undone, or it would be a small bordered box
  // in the middle of the page.
  assert.match(host.style.cssText, /width:auto/);
  assert.match(host.style.cssText, /background:transparent/);
  assert.match(host.style.cssText, /border:0/);

  page.key('Escape');
  assert.equal(page.host(), null);
  assert.deepEqual(page.document.topLayer, []);
  assert.equal(host.hasAttribute('popover'), false);
});

test('overlay: a browser without popovers gets the host on the body as before', () => {
  const page = makePage({ popovers: false });
  page.inject(OVERLAY);
  const host = page.host();
  assert.equal(host.parentNode, page.document.body);
  assert.equal(host.hasAttribute('popover'), false, 'a popover that is never shown is display: none');
  assert.match(host.style.cssText, /z-index:2147483647/);
});

// CW7. A finger drag was taken as a pan and ended in pointercancel, which
// nothing heard: dragging stayed on, and the next stray pointerup sent a
// capture from the stale origin.
test('overlay: a touch drag is not a pan, and a cancelled drag sends nothing', () => {
  const page = makePage();
  page.inject(OVERLAY);
  const host = page.host();
  assert.match(host.shadow.styleText, /\.root\s*\{[^}]*touch-action:\s*none/);

  const r = root(host);
  r.dispatch('pointerdown', { clientX: 100, clientY: 100 });
  r.dispatch('pointermove', { clientX: 400, clientY: 300 });
  r.dispatch('pointercancel', { clientX: 400, clientY: 300 });
  assert.equal(shown(host.shadow.querySelector('.sel')), false, 'the selection stayed up after the cancel');
  assert.equal(shown(host.shadow.querySelector('.hint')), true);

  r.dispatch('pointermove', { clientX: 600, clientY: 500 });
  assert.equal(shown(host.shadow.querySelector('.sel')), false, 'the box followed a pointer with no button held');
  r.dispatch('pointerup', { clientX: 600, clientY: 500 });
  page.frames();
  assert.deepEqual(page.sent, [], 'a stray pointerup sent a capture from the stale origin');

  // And it is still armed: a real drag after it captures.
  r.dispatch('pointerdown', { clientX: 10, clientY: 20 });
  r.dispatch('pointerup', { clientX: 110, clientY: 220 });
  page.frames();
  assert.equal(page.sent.length, 1);
  assert.deepEqual(page.sent[0].rect, { x: 10, y: 20, width: 100, height: 200 });
});

test('overlay: a lost pointer capture mid drag ends the drag the same way', () => {
  const page = makePage();
  page.inject(OVERLAY);
  const r = root(page.host());
  r.dispatch('pointerdown', { clientX: 100, clientY: 100 });
  r.dispatch('lostpointercapture');
  r.dispatch('pointerup', { clientX: 400, clientY: 300 });
  page.frames();
  assert.deepEqual(page.sent, []);
});

// Mounted inside a modal dialog, the drag's events would bubble to the
// dialog's own handlers, such as one that closes it on a click outside its box.
test('overlay: a drag does not reach the page as clicks and pointer events', () => {
  const page = makePage();
  page.inject(OVERLAY);
  const r = root(page.host());
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'click', 'mousedown', 'mouseup']) {
    const page2 = r.dispatch(type, { clientX: 5, clientY: 5 });
    assert.equal(page2.stopped, true, `${type} bubbled out to the page`);
  }
});

// UX14, the region side. The only key either capture mode heard was Escape.
test('overlay: a region can be selected and captured with the keyboard', () => {
  const page = makePage();
  page.inject(OVERLAY);
  const host = page.host();
  assert.match(OVERLAY, /class="hint">[^<]*arrow keys/, 'the hint does not say the keys work');

  // The first arrow key puts half the viewport in its middle; the next moves it.
  assert.equal(page.key('ArrowRight'), true, 'an arrow key was left to scroll the page');
  const sel = host.shadow.querySelector('.sel');
  assert.equal(shown(sel), true);
  assert.equal(sel.style.left, '250px');
  assert.equal(sel.style.top, '175px');
  page.key('ArrowRight');
  assert.equal(sel.style.left, '260px');
  page.key('ArrowDown', { shiftKey: true }); // taller by a step
  page.key('ArrowLeft', { altKey: true }); // one pixel left
  assert.equal(page.key('Enter'), true);
  page.frames();
  assert.equal(page.sent.length, 1);
  assert.equal(page.sent[0].type, 'cdr:region-selected');
  assert.deepEqual(page.sent[0].rect, { x: 259, y: 175, width: 500, height: 360 });
  assert.equal(page.host(), null, 'the overlay stayed up after the capture');
});

test('overlay: Enter with nothing selected is the page\'s, and a keyboard selection stays inside the viewport', () => {
  const page = makePage();
  page.inject(OVERLAY);
  assert.equal(page.key('Enter'), false, 'Enter was taken with nothing selected');
  assert.deepEqual(page.sent, []);
  for (let i = 0; i < 100; i += 1) page.key('ArrowRight');
  for (let i = 0; i < 100; i += 1) page.key('ArrowDown', { shiftKey: true });
  page.key('Enter');
  page.frames();
  const { rect } = page.sent[0];
  assert.ok(rect.x + rect.width <= 1000 && rect.y + rect.height <= 700, JSON.stringify(rect));
});

// UX14 from the panel. Clicking Region leaves the keyboard in the panel, which
// hands the arrows and Enter to the overlay through key().
test('overlay: the keys the panel hands on select and capture as the page\'s own do', () => {
  const page = makePage();
  page.inject(OVERLAY);
  const overlay = page.window.__cdrRegionOverlay;
  assert.equal(overlay.key('Enter'), false, 'Enter was taken with nothing selected');
  assert.equal(overlay.key('Tab'), false);
  assert.equal(overlay.key('ArrowRight'), true);
  assert.equal(overlay.key('ArrowRight'), true);
  assert.equal(overlay.key('ArrowDown', { shiftKey: true }), true);
  assert.equal(overlay.key('ArrowLeft', { altKey: true }), true);
  assert.equal(overlay.key('Enter'), true);
  page.frames();
  assert.deepEqual(page.sent[0].rect, { x: 259, y: 175, width: 500, height: 360 });
  assert.equal(overlay.key('ArrowRight'), false, 'a stopped overlay took a key');
});

test('overlay: a keyboard selection starts in the part of the page that is visible', () => {
  const visual = { offsetLeft: 250, offsetTop: 175, width: 500, height: 350, scale: 2 };
  const page = makePage({ visual });
  page.inject(OVERLAY);
  page.key('ArrowUp', { shiftKey: true });
  page.key('Enter');
  page.frames();
  // The first key only places it: 250 + 500 / 4, 175 + 350 / 4, half of each.
  assert.deepEqual(page.sent[0].rect, { x: 375, y: 263, width: 250, height: 175 });
});

// CW2. The rect is in layout viewport pixels and the screenshot shows the
// visual viewport; without its offset and scale the crop was another patch.
test('overlay: the viewport it sends carries the visual viewport', () => {
  const visual = { offsetLeft: 250, offsetTop: 175, width: 500, height: 350, scale: 2 };
  const page = makePage({ visual });
  page.inject(OVERLAY);
  const r = root(page.host());
  r.dispatch('pointerdown', { clientX: 300, clientY: 225 });
  r.dispatch('pointerup', { clientX: 400, clientY: 275 });
  page.frames();
  assert.deepEqual(page.sent[0].viewport, {
    width: 1000,
    height: 700,
    visual: { x: 250, y: 175, width: 500, height: 350, scale: 2 },
  });
});

// F28. A drag's message comes two frames after the release, and the shortcut
// can arm Region again in between. The late message must name the run it
// came from, not the one live when it is sent.
test('overlay: each start names its run, returns it to the injection, and its messages carry it', () => {
  const page = makePage();
  const first = page.inject(OVERLAY);
  assert.equal(typeof first, 'string', 'the injection does not answer with the run');
  assert.equal(page.inject(OVERLAY), first, 'a second injection while armed made another run');

  const r = root(page.host());
  r.dispatch('pointerdown', { clientX: 10, clientY: 10 });
  r.dispatch('pointerup', { clientX: 210, clientY: 110 });
  const second = page.inject(OVERLAY); // the shortcut, before the two frames
  assert.equal(typeof second, 'string');
  assert.notEqual(second, first);
  page.frames();
  assert.equal(page.sent.at(-1).type, 'cdr:region-selected');
  assert.equal(page.sent.at(-1).run, first, 'the late message named the newer run');

  page.key('Escape');
  assert.deepEqual(page.sent.at(-1), { run: second, type: 'cdr:capture-cancelled', mode: 'region' });
});

test('stop.js: takes down either controller, and survives being injected again', () => {
  const STOP = read('content/stop.js');
  const page = makePage();
  page.inject(OVERLAY);
  assert.equal(page.window.__cdrRegionOverlay.isActive(), true);
  page.inject(STOP, 'content/stop.js');
  page.inject(STOP, 'content/stop.js');
  assert.equal(page.window.__cdrRegionOverlay.isActive(), false);
  assert.equal(page.host(), null);
  assert.doesNotThrow(() => new vm.Script(`${STOP}\n;\n${STOP}`));
});

// The picker carries the same run, in the same way: see test/picker-events.test.mjs,
// whose page model is the one the picker needs.

// ---------------------------------------------------------------- bridge --

function bridgePage({ mark } = {}) {
  const listeners = [];
  const runtime = { id: 'ext', onMessage: { addListener: (fn) => listeners.push(fn) } };
  const window = {
    location: { href: 'https://example.test/' },
    document: { title: 'Example' },
    navigator: { userAgent: 'test' },
    innerWidth: 1000,
    innerHeight: 700,
    scrollX: 0,
    scrollY: 0,
    chrome: { runtime },
    crypto: globalThis.crypto,
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    dispatchEvent: () => true,
    addEventListener() {},
    removeEventListener() {},
    postMessage() {},
    setTimeout,
  };
  window.window = window;
  if (mark !== undefined) window.__cdrBridge = mark;
  const realm = vm.createContext(window);
  return {
    window,
    runtime,
    listeners,
    inject: () => vm.runInContext(BRIDGE, realm, { filename: 'content/collector-bridge.js' }),
  };
}

// Improvement 9. After a reload of the extension the old bridge can no longer
// hear it, and its mark on the window blocked the new one the panel injects.
test('bridge: a second injection beside a live bridge adds nothing', () => {
  const page = bridgePage();
  page.inject();
  page.inject();
  assert.equal(page.listeners.length, 1);
});

test('bridge: the mark of a bridge whose extension context has gone does not block a new one', () => {
  const page = bridgePage();
  page.inject();
  // What a reload of the extension does to the old bridge's chrome.runtime.
  page.runtime.id = undefined;
  page.window.chrome = { runtime: { id: 'ext', onMessage: { addListener: (fn) => page.listeners.push(fn) } } };
  page.inject();
  assert.equal(page.listeners.length, 2, 'the new bridge was blocked by the dead one');
  assert.equal(page.window.__cdrBridge.alive(), true);
});

test('bridge: a plain mark from an older build is replaced', () => {
  const page = bridgePage({ mark: true });
  page.inject();
  assert.equal(page.listeners.length, 1);
});

// ------------------------------------------------------------------ crop --

/** cropCapture and what it needs, lifted out of panel.js as written. */
function cropper({ width, height }) {
  const body = (name) => {
    const start = PANEL.search(new RegExp(`^(async )?function ${name}\\(`, 'm'));
    assert.ok(start !== -1, `panel.js has lost ${name}()`);
    return PANEL.slice(start, PANEL.indexOf('\n}\n', start) + 3);
  };
  const constant = (/^const RESIZED_DURING_CAPTURE =[\s\S]*?;\n/m.exec(PANEL) || [''])[0];
  const draws = [];
  class Image {
    constructor() {
      this.naturalWidth = width;
      this.naturalHeight = height;
    }
    set src(value) {
      queueMicrotask(() => this.onload());
    }
  }
  const document = {
    createElement: () => ({
      getContext: () => ({ drawImage: (...args) => draws.push(args.slice(1)) }),
      toDataURL: () => 'data:image/png;base64,AAAA',
    }),
  };
  const crop = new Function(
    'Image',
    'document',
    `${constant}${body('loadImage')}${body('cropCapture')}return cropCapture;`
  )(Image, document);
  return { crop, draws };
}

/** The crop as it was computed before the visual viewport was taken into account. */
function oldCrop(rect, viewport, image) {
  const scale = viewport?.width ? image.width / viewport.width : 1;
  const sx = Math.max(0, Math.round(rect.x * scale));
  const sy = Math.max(0, Math.round(rect.y * scale));
  const sw = Math.max(1, Math.min(Math.round(rect.width * scale), image.width - sx));
  const sh = Math.max(1, Math.min(Math.round(rect.height * scale), image.height - sy));
  return [sx, sy, sw, sh, 0, 0, sw, sh];
}

// CW2. The review's case: pinched to 2x at offset 250,175 on a 1000x700 page
// with a device pixel ratio of 2. The old crop took bitmap 600,450 200x100,
// screen area 300..400 by 225..275, a different and smaller patch.
test('crop: under pinch zoom the rect is found through the visual viewport', async () => {
  const { crop, draws } = cropper({ width: 2000, height: 1400 });
  const viewport = { width: 1000, height: 700, visual: { x: 250, y: 175, width: 500, height: 350, scale: 2 } };
  const result = await crop('data:', { x: 300, y: 225, width: 100, height: 50 }, viewport);
  // 50,50 into the visible area, at two device pixels per pixel, magnified 2x.
  assert.deepEqual(draws[0], [200, 200, 400, 200, 0, 0, 400, 200]);
  assert.equal(result.width, 400);
  assert.equal(result.height, 200);
  assert.equal(result.notice, null);
});

test('crop: the part of a rect outside the visible area is cut off, not shifted into it', async () => {
  const { crop, draws } = cropper({ width: 2000, height: 1400 });
  const viewport = { width: 1000, height: 700, visual: { x: 250, y: 175, width: 500, height: 350, scale: 2 } };
  await crop('data:', { x: 200, y: 175, width: 100, height: 40 }, viewport);
  // 50 of the 100 pixels are left of the visible area.
  assert.deepEqual(draws[0], [0, 0, 200, 160, 0, 0, 200, 160]);
});

test('crop: with no pinch zoom it is the same crop as before, to the pixel', async () => {
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const [image, viewport] of [
    [{ width: 2000, height: 1400 }, { width: 1000, height: 700 }],
    [{ width: 2000, height: 1400 }, { width: 1000, height: 700, visual: { x: 0, y: 0, width: 985, height: 700, scale: 1 } }],
    [{ width: 1375, height: 963 }, { width: 1100, height: 770, visual: { x: 0, y: 0, width: 1100, height: 770, scale: 1 } }],
    [{ width: 1280, height: 720 }, null],
  ]) {
    const { crop, draws } = cropper(image);
    for (let i = 0; i < 200; i += 1) {
      const x = random() * 900;
      const y = random() * 650;
      const rect = { x, y, width: 10 + random() * (990 - x), height: 10 + random() * (690 - y) };
      await crop('data:', rect, viewport);
      assert.deepEqual(draws.at(-1), oldCrop(rect, viewport, image), JSON.stringify({ rect, viewport }));
    }
  }
});

// CW11. viewport.height was sent and never read. Read against the bitmap, it
// tells a tab that changed size between the selection and the screenshot.
test('crop: a tab that changed size before the screenshot is said, and one that did not is not', async () => {
  const { crop } = cropper({ width: 1400, height: 1400 });
  const narrowed = await crop('data:', { x: 0, y: 0, width: 50, height: 50 }, { width: 1000, height: 700 });
  assert.match(narrowed.notice || '', /changed size/);

  const { crop: same } = cropper({ width: 2000, height: 1401 });
  const fine = await same('data:', { x: 0, y: 0, width: 50, height: 50 }, { width: 1000, height: 700 });
  assert.equal(fine.notice, null);
});

// ---------------------------------------------------------------- worker --

// CW6. A substring match over the whole URL took a search for the store's
// name for the store, and disabled every capture on an ordinary page.
test('worker: only the Web Store itself is restricted as the Web Store', async () => {
  const urls = {
    1: 'https://www.google.com/search?q=chromewebstore.google.com+publish',
    2: 'https://developer.chrome.com/docs/webstore/?from=chrome.google.com/webstore',
    3: 'https://chromewebstore.google.com/detail/abc',
    4: 'https://chrome.google.com/webstore/detail/abc',
    5: 'https://chrome.google.com/webstorefront',
  };
  const pages = Object.fromEntries(Object.entries(urls).map(([id, url]) => [id, new FakePage({ url })]));
  const worker = loadWorker({ pages });
  const restriction = async (tabId) =>
    (await worker.settled(worker.send({ type: 'cdr:check-tab', tabId }))).restriction;
  assert.equal(await restriction(1), null);
  assert.equal(await restriction(2), null);
  assert.match(await restriction(3), /Web Store/);
  assert.match(await restriction(4), /Web Store/);
  assert.equal(await restriction(5), null);
});

const CONTENT_SCRIPT = { id: PANEL_SENDER.id, url: 'https://hostile.test/', tab: { id: 2 } };

// SP7. The worker ran panel only messages for any sender, with a tab id the
// sender chose.
test('worker: a content script cannot arm, disarm or start a collector in a tab', async () => {
  const worker = loadWorker({ pages: { 1: new FakePage() } });
  for (const message of [
    { type: 'cdr:arm', mode: 'region', tabId: 1, armId: 'x' },
    { type: 'cdr:collect', tabId: 1 },
    { type: 'cdr:verify', tabId: 1 },
    { type: 'cdr:check-tab', tabId: 1 },
    { type: 'cdr:disarm', tabId: 1 },
  ]) {
    assert.equal(await worker.settled(worker.send(message, CONTENT_SCRIPT)), undefined, message.type);
  }
  await flush();
  assert.deepEqual(worker.injections, [], 'a content script had a script injected into another tab');

  assert.deepEqual(await worker.settled(worker.send({ type: 'cdr:arm', mode: 'region', tabId: 1, armId: 'a' })), { ok: true });
  assert.equal(worker.pages[1].live(), 'region');
  // And one cannot end the user's arm either.
  await worker.settled(worker.send({ type: 'cdr:disarm', tabId: 1 }, CONTENT_SCRIPT));
  assert.equal(worker.pages[1].live(), 'region');
});

// SP7. storage.local is open to content scripts by default, and the panel
// adopts any report written there.
test('worker: storage is closed to content scripts at every start', () => {
  const worker = loadWorker();
  assert.deepEqual(worker.accessLevels, [{ accessLevel: 'TRUSTED_CONTEXTS' }]);
});

// CW4. Closing the panel left the overlay up, and a drag then ended it as a
// capture does, with nobody there to take the screenshot.
test('worker: closing the panel disarms the tab it was holding', async () => {
  const worker = loadWorker();
  const port = worker.connect('cdr:panel');
  assert.deepEqual(await worker.settled(worker.send({ type: 'cdr:arm', mode: 'region', tabId: 1, armId: 'a' })), { ok: true });
  port.post({ type: 'cdr:holding', tabId: 1 });
  assert.equal(worker.pages[1].live(), 'region');
  port.close();
  await flush();
  await worker.clock.advance(200);
  assert.equal(worker.pages[1].live(), null, 'the overlay outlived the panel');
});

test('worker: a panel that holds nothing disarms nothing when it closes', async () => {
  const worker = loadWorker();
  const port = worker.connect('cdr:panel');
  port.post({ type: 'cdr:holding', tabId: 1 });
  port.post({ type: 'cdr:holding', tabId: null });
  await worker.settled(worker.send({ type: 'cdr:arm', mode: 'region', tabId: 1 }));
  port.close();
  await worker.clock.advance(200);
  assert.equal(worker.pages[1].live(), 'region');
});

test('worker: a port from a content script is shut, and holds nothing', async () => {
  const worker = loadWorker();
  const port = worker.connect('cdr:panel', CONTENT_SCRIPT);
  assert.equal(port.closed, true);
});

test('worker: the shortcut takes its arm back down when the panel could not open', async () => {
  const commands = [];
  const worker = loadWorker({
    setup: (chrome) => {
      chrome.commands.onCommand.addListener = (fn) => commands.push(fn);
      chrome.sidePanel.open = () => Promise.reject(new Error('No active side panel for this window.'));
    },
  });
  for (const listener of commands) listener('capture-region', { id: 1 });
  await flush();
  await worker.clock.advance(1500);
  assert.equal(worker.pages[1].live(), null, 'the overlay stayed up with no panel to capture it');
});

// Improvement 9. A tab open from before the extension had no collector, and
// the only advice was to reload, which destroys what the user came to report.
test('worker: a collector is started on a tab that has none, both halves in their worlds', async () => {
  const worker = loadWorker();
  const reply = await worker.settled(worker.send({ type: 'cdr:collect', tabId: 1 }));
  assert.deepEqual(reply, { ok: true, fresh: true });
  const files = worker.injections.filter((i) => i.file).map((i) => [i.file, i.world, i.immediate]);
  assert.deepEqual(files, [
    ['content/collector-main.js', 'MAIN', true],
    ['content/collector-bridge.js', 'ISOLATED', true],
  ]);
  // The collector is told it starts late by a listener put in the isolated
  // world before it, which it could not be after.
  const order = worker.injections.map((i) => i.file || (/__cdr_late/.test(i.func) ? 'late' : 'probe'));
  assert.deepEqual(order.slice(2), ['late', 'content/collector-main.js', 'content/collector-bridge.js']);
});

/**
 * A FakePage running the real collector, as a tab does after a reload or an
 * update of the extension: both halves started at document_start, and the
 * collector stays in the page while the bridge that could reach it is cut
 * off. Its two worlds are makeWorlds' (test/support/worker-realm.mjs).
 */
function pageWithCollector({ url, scripts = [] } = {}) {
  const page = new FakePage({ url, worlds: {} });
  page.worlds.document.scripts = scripts;
  page.declare();
  return page;
}

// Medium in verify V2, V4 and V7. The worker asked for window.__cdrCollector,
// which only a collector of 0.5.0 sets, so after every reload or update of
// this build a tab whose collector had run since the page loaded was taken
// for one with none: the panel and the prompt said the log began now, and a
// second collector was injected (which its own guard stopped). The test
// before this one planted that global, which the real collector never sets.
test('worker: a collector of this build still running after a reload only gets a new bridge', async () => {
  const page = pageWithCollector();
  assert.equal(page.window.__cdrCollector, undefined, 'the collector sets a global after all');
  const worker = loadWorker({ pages: { 1: page } });
  const reply = await worker.settled(worker.send({ type: 'cdr:collect', tabId: 1 }));
  assert.deepEqual(reply, { ok: true, fresh: false });
  assert.deepEqual(worker.injections.filter((i) => i.file).map((i) => i.file), ['content/collector-bridge.js']);
});

test('worker: a collector of 0.5.0 still running after an update only gets a new bridge', async () => {
  const page = new FakePage();
  page.window.__cdrCollector = true; // what 0.5.0 marked itself with
  const worker = loadWorker({ pages: { 1: page } });
  const reply = await worker.settled(worker.send({ type: 'cdr:collect', tabId: 1 }));
  assert.deepEqual(reply, { ok: true, fresh: false });
  assert.deepEqual(worker.injections.filter((i) => i.file).map((i) => i.file), ['content/collector-bridge.js']);
});

// The event is sent from the extension's isolated world, whose
// dispatchEvent the page cannot replace; the global is read in the main
// world, the only one that sees it.
test('worker: the two probes for a running collector go to the worlds that can answer them', async () => {
  const worker = loadWorker();
  await worker.settled(worker.send({ type: 'cdr:collect', tabId: 1 }));
  const probes = worker.injections.filter((i) => i.func && !/__cdr_late/.test(i.func));
  assert.deepEqual(
    probes.map((i) => [/__cdr_probe/.test(i.func) ? 'event' : /__cdrCollector/.test(i.func) ? 'global' : '?', i.world, i.immediate]).sort(),
    [
      ['event', 'ISOLATED', true],
      ['global', 'MAIN', true],
    ]
  );
});

// Found while merging the fix round. The README's way to keep the collector
// to your own sites is to narrow the content_scripts matches, and cdr:collect
// started one under host_permissions on any tab the panel read, so that
// recipe kept nothing off a tab that was already open.
test('worker: a collector is started only where the manifest declares one', async () => {
  const narrowed = (chrome) => {
    const real = chrome.runtime.getManifest();
    chrome.runtime.getManifest = () => ({
      ...real,
      content_scripts: real.content_scripts.map((entry) => ({ ...entry, matches: ['http://localhost/*', 'https://*.example.test/*'] })),
    });
  };
  const outside = loadWorker({ pages: { 1: new FakePage({ url: 'https://bank.test/account' }) }, setup: narrowed });
  assert.deepEqual(await outside.settled(outside.send({ type: 'cdr:collect', tabId: 1 })), { ok: false, outside: 'site' });
  // Not even asked whether a collector runs there: a page on a site the user
  // kept the collector off could answer as one and have a bridge put in.
  assert.deepEqual(outside.injections, [], 'something was injected into a site the matches leave out');

  // A page there that answers the probe as a collector gets nothing either.
  const faking = new FakePage({ url: 'https://bank.test/account' });
  faking.window.__cdrCollector = true;
  const faked = loadWorker({ pages: { 1: faking }, setup: narrowed });
  assert.deepEqual(await faked.settled(faked.send({ type: 'cdr:collect', tabId: 1 })), { ok: false, outside: 'site' });
  assert.deepEqual(faked.injections, []);

  const inside = loadWorker({ pages: { 1: new FakePage({ url: 'http://localhost:5173/app' }) }, setup: narrowed });
  assert.deepEqual(await inside.settled(inside.send({ type: 'cdr:collect', tabId: 1 })), { ok: true, fresh: true });
});

// Low in the second verification (R1). A single page app loaded under the
// matches and moved by its router to a path they leave out keeps the
// collector it loaded with. After a reload of the extension the worker
// looked at the URL first, called the tab outside the matches, and never
// bridged that collector, whose log held everything since the page loaded.
test('worker: a collector running on a page whose URL has since left the matches is bridged', async () => {
  const narrowed = (chrome) => {
    const real = chrome.runtime.getManifest();
    chrome.runtime.getManifest = () => ({
      ...real,
      content_scripts: real.content_scripts.map((entry) => ({ ...entry, matches: ['https://app.example/app/*'] })),
    });
  };
  const page = pageWithCollector({ url: 'https://app.example/app/' });
  page.worlds.run('main', `console.error('logged at /app/');`);
  page.url = 'https://app.example/settings'; // history.pushState
  const worker = loadWorker({ pages: { 1: page }, setup: narrowed });
  assert.deepEqual(await worker.settled(worker.send({ type: 'cdr:collect', tabId: 1 })), { ok: true, fresh: false });
  assert.deepEqual(worker.injections.filter((i) => i.file).map((i) => i.file), ['content/collector-bridge.js']);
  const { collected } = await page.worlds.ask('cdr:get-context');
  assert.deepEqual(collected.console.map((entry) => entry.text), ['logged at /app/']);
  assert.equal(collected.late, undefined);

  // On that site's other paths nothing is started where none runs.
  const empty = loadWorker({ pages: { 1: new FakePage({ url: 'https://app.example/settings' }) }, setup: narrowed });
  assert.deepEqual(await empty.settled(empty.send({ type: 'cdr:collect', tabId: 1 })), { ok: false, outside: 'path' });
  assert.deepEqual(empty.injections.filter((i) => i.file), []);
});

/** setup for loadWorker: the shipped content_scripts entries with `fields` put over each. */
const narrowedTo = (fields) => (chrome) => {
  const real = chrome.runtime.getManifest();
  chrome.runtime.getManifest = () => ({
    ...real,
    content_scripts: real.content_scripts.map((entry) => ({ ...entry, ...fields })),
  });
};

// Low in the third verification (T2, T6), and before it too: the site check
// did not read globs, so a host the manifest leaves out by a glob was still
// probed, and given a bridge by a page that answered as a collector, whose
// lines then reached the prompt; and it applied exclude_matches to the whole
// URL, so a single page app that moved into an excluded path lost its
// running collector's log after a reload of the extension.
test('worker: a site the globs leave out is not probed, and one an exclude names only paths of still is', async () => {
  const collect = async (fields, url, page = new FakePage({ url })) => {
    const worker = loadWorker({ pages: { 1: page }, setup: narrowedTo(fields) });
    const reply = await worker.settled(worker.send({ type: 'cdr:collect', tabId: 1 }));
    return { reply, injected: worker.injections.length, files: worker.injections.filter((i) => i.file).map((i) => i.file) };
  };
  const forger = (url) => {
    const page = new FakePage({ url });
    page.window.__cdrCollector = true; // answers the probe as a collector would
    return page;
  };
  const OUT = { reply: { ok: false, outside: 'site' }, injected: 0, files: [] };

  // Hosts left out by a glob, as the verifier's manifests did.
  assert.deepEqual(await collect({ exclude_globs: ['http://localhost:*'] }, 'http://localhost:8842/other'), OUT);
  assert.deepEqual(await collect({ include_globs: ['http://127.0.0.1:*'] }, 'http://localhost:8842/other'), OUT);
  assert.deepEqual(await collect({ exclude_globs: ['http://localhost:*'] }, null, forger('http://localhost:8842/forger')), OUT);
  assert.deepEqual(await collect({ include_globs: ['*://*.mine.test/*'] }, null, forger('https://bank.test/x')), OUT);
  assert.deepEqual(await collect({ exclude_globs: ['*bank*'] }, null, forger('https://mybank.test/x')), OUT);
  // A whole site in exclude_matches stays out too.
  assert.deepEqual(await collect({ exclude_matches: ['https://bank.test/*'] }, null, forger('https://bank.test/x')), OUT);

  // On a site they keep in, a URL the declared scripts miss is only asked.
  assert.deepEqual(await collect({ include_globs: ['http://127.0.0.1:*'] }, 'http://127.0.0.1:8842/x'), {
    reply: { ok: true, fresh: true },
    injected: 5,
    files: ['content/collector-main.js', 'content/collector-bridge.js'],
  });
  for (const fields of [
    { exclude_matches: ['https://app.example/admin/*'] },
    { exclude_globs: ['*/admin/*'] },
    { include_globs: ['*/home*'] },
  ]) {
    const result = await collect(fields, 'https://app.example/admin/x');
    assert.deepEqual(result, { reply: { ok: false, outside: 'path' }, injected: 2, files: [] }, JSON.stringify(fields));
  }

  // And a running collector there, from before the router moved, is bridged.
  for (const fields of [
    { exclude_matches: ['https://app.example/admin/*'] },
    { include_globs: ['*/home*'] },
    { include_globs: ['*home*'] },
  ]) {
    const page = pageWithCollector({ url: 'https://app.example/home' });
    page.worlds.run('main', `console.error('logged at /home');`);
    page.url = 'https://app.example/admin/x'; // history.pushState
    const result = await collect(fields, null, page);
    assert.deepEqual(result.reply, { ok: true, fresh: false }, JSON.stringify(fields));
    assert.deepEqual(result.files, ['content/collector-bridge.js']);
    const { collected } = await page.worlds.ask('cdr:get-context');
    assert.deepEqual(collected.console.map((entry) => entry.text), ['logged at /home']);
  }
});

test('worker: match patterns read as Chrome documents them', () => {
  const { matchesPattern } = loadWorker().internals;
  const cases = [
    ['<all_urls>', 'https://a.test/x?y', true],
    ['<all_urls>', 'file:///Users/me/page.html', true],
    ['<all_urls>', 'chrome://settings/', false],
    ['*://a.test/*', 'http://a.test/', true],
    ['*://a.test/*', 'https://a.test/deep/path?q=1', true],
    ['*://a.test/*', 'file:///a.test/x', false],
    ['https://a.test/*', 'http://a.test/', false],
    ['https://*.a.test/*', 'https://a.test/', true],
    ['https://*.a.test/*', 'https://x.y.a.test/', true],
    ['https://*.a.test/*', 'https://evil-a.test/', false],
    ['https://*.a.test/*', 'https://a.test.evil.test/', false],
    ['https://a.test/*', 'https://A.TEST/', true],
    ['http://localhost/*', 'http://localhost:5173/app', true],
    ['http://localhost:3000/*', 'http://localhost:5173/', false],
    ['http://localhost:3000/*', 'http://localhost:3000/', true],
    ['https://a.test:443/*', 'https://a.test/', true],
    ['http://127.0.0.1/*', 'http://127.0.0.1:8080/x', true],
    ['http://[::1]/*', 'http://[::1]:8080/', true],
    ['https://a.test/foo*', 'https://a.test/foobar', true],
    ['https://a.test/foo*', 'https://a.test/bar/foo', false],
    ['https://a.test/foo*bar', 'https://a.test/foo/baz/bar', true],
    ['https://a.test/app', 'https://a.test/app?x=1', false],
    ['https://a.test/app?x=*', 'https://a.test/app?x=1', true],
    ['https://a.test/a.b', 'https://a.test/aXb', false],
    ['file:///Users/*', 'file:///Users/me/x.html', true],
    ['https://*/*', 'https://anything.test/', true],
    ['not a pattern', 'https://a.test/', false],
    ['https://a.test/*', 'not a url', false],
  ];
  for (const [pattern, url, expected] of cases) {
    assert.equal(matchesPattern(pattern, url), expected, `${pattern} against ${url}`);
  }
});

// Low in the second verification (R2): 12 of 638 pairs disagreed with
// Chrome's own content script matching. Each pair here was checked in Chrome
// for Testing 156, by a probe extension with one content script per pattern
// (the verifier's compare-run.mjs, and a wider one with include_globs and
// exclude_globs, 1350 pairs; all agree now).
test('worker: match patterns agree with where Chrome runs a content script', () => {
  const { matchesPattern } = loadWorker().internals;
  const cases = [
    // The twelve.
    ['http://*.0.0.1/*', 'http://127.0.0.1:8832/', false],
    ['http://[0:0:0:0:0:0:0:1]/*', 'http://[::1]:8832/', true],
    ['http://example.test:8832/app/page', 'http://example.test:8832/app/page?', false],
    ['*://*.example.test/*', 'http://example.test.:8832/', true],
    ['http://example.test/*', 'http://example.test.:8832/', true],
    ['http://EXAMPLE.test/*', 'http://example.test.:8832/', true],
    ['http://example.test:*/*', 'http://example.test.:8832/', true],
    ['http://*.test/*', 'http://example.test.:8832/', true],
    ['http://localhost/*', 'http://localhost.:8832/', true],
    ['http://localhost:8832/*', 'http://localhost.:8832/', true],
    ['http://*.localhost/*', 'http://localhost.:8832/', true],
    ['http://bücher.test/*', 'http://xn--bcher-kva.test:8832/', true],
    // Around them.
    ['http://example.test./*', 'http://example.test:8832/', true],
    ['http://*.example.test./*', 'http://a.example.test:8832/', true],
    ['http://BÜCHER.test/*', 'http://xn--bcher-kva.test:8832/', true],
    ['http://LOCALHOST:8832/*', 'http://localhost:8832/', true],
    ['http://127.1/*', 'http://127.0.0.1:8832/', true],
    ['http://0x7f.0.0.1/*', 'http://127.0.0.1:8832/', true],
    ['http://*.127.0.0.1/*', 'http://127.0.0.1:8832/', true],
    ['http://[::1]:8832/*', 'http://[::1]:8832/', true],
    ['http://example.test/app/*', 'http://example.test:8832/app', true],
    ['http://example.test/app/*', 'http://example.test:8832/app?x=1', false],
    ['http://example.test/app/page?', 'http://example.test:8832/app/page?', true],
    ['http://example.test/app/page?', 'http://example.test:8832/app/page', false],
    ['http://example.test/a%20b*', 'http://example.test:8832/a%20b', true],
    ['http://example.test/a b*', 'http://example.test:8832/a%20b', false],
    // From the last verification (C2): a pattern's path is escaped as a URL's
    // is, but for the space above.
    ['http://*/café', 'http://example.test:8832/caf%C3%A9', true],
    ['http://*/a"b', 'http://example.test:8832/a%22b', true],
    ['http://*/a<b', 'http://example.test:8832/a%3Cb', true],
    ['http://*/x?é', 'http://example.test:8832/x?%C3%A9', true],
    ['http://127.0.0.1/ü/*', 'http://127.0.0.1:8892/%C3%BC/x', true],
    ['http://example.test/st*r', 'http://example.test:8832/st*r', true],
    ['file://*', 'file:///Users/me/a.html', true],
    ['file://*a.html', 'file:///Users/me/a.html', true],
    ['file://localhost/*', 'file:///Users/me/a.html', true],
    // Not patterns at all.
    ['http://user@a.test/*', 'http://a.test/', false],
    ['http://a.test:/*', 'http://a.test/', false],
    ['http://*./*', 'http://a.test/', false],
    ['http://a*b.test/*', 'http://axb.test/', false],
    ['http://*.a*b.test/*', 'http://x.axb.test/', false],
  ];
  const wrong = cases.filter(([pattern, url, expected]) => matchesPattern(pattern, url) !== expected);
  assert.deepEqual(wrong, []);
});

// Low in the second verification (R6), and before it too: the globs were not
// read, so with the collector narrowed by them, opening the panel started one
// on a page Chrome itself leaves alone, and said the tab was open from before.
// Chrome's glob was checked in Chrome for Testing 156 (see above): ? is one
// character or none, a backslash takes the next as it is, the URL's fragment
// is in what is matched, and it does not backtrack.
test('worker: include_globs and exclude_globs are read as Chrome reads them', async () => {
  const { matchesGlob } = loadWorker().internals;
  assert.equal(typeof matchesGlob, 'function', 'background.js does not read globs');
  const P = 'http://example.test:8832';
  const cases = [
    [`${P}/a?c`, `${P}/ac`, true],
    [`${P}/a?c`, `${P}/abc`, true],
    [`${P}/a?c`, `${P}/abbc`, false],
    [`${P}/a??c`, `${P}/abbc`, true],
    [`${P}/x*b?c`, `${P}/xabc`, true],
    [`${P}/x*b?c`, `${P}/xabxbc`, false],
    [`${P}/st\\*r`, `${P}/st*r`, true],
    [`${P}/st\\*r`, `${P}/stXr`, false],
    ['*#frag', `${P}/frag#frag`, true],
    ['*#frag', `${P}/frag2#fragment`, false],
    [`${P}/app/page?`, `${P}/app/page?`, true],
    [`${P}/app/page`, `${P}/app/page?`, false],
    ['*example.test:8832/app/*', `${P}/app`, false],
    ['*nothing*', `${P}/`, false],
  ];
  const wrong = cases.filter(([glob, url, expected]) => matchesGlob(glob, url) !== expected);
  assert.deepEqual(wrong, []);

  const globbed = (globs) => (chrome) => {
    const real = chrome.runtime.getManifest();
    chrome.runtime.getManifest = () => ({
      ...real,
      content_scripts: real.content_scripts.map((entry) => ({ ...entry, ...globs })),
    });
  };
  const collect = async (globs) => {
    const worker = loadWorker({ pages: { 1: new FakePage({ url: 'https://shop.test/cart' }) }, setup: globbed(globs) });
    return worker.settled(worker.send({ type: 'cdr:collect', tabId: 1 }));
  };
  // https://shop.test/nothing matches, so only this path is left out.
  assert.deepEqual(await collect({ include_globs: ['*nothing*'] }), { ok: false, outside: 'path' });
  assert.deepEqual(await collect({ include_globs: ['https://shop.test/*'] }), { ok: true, fresh: true });
  assert.deepEqual(await collect({ exclude_globs: ['*/cart'] }), { ok: false, outside: 'path' });
  assert.deepEqual(await collect({ exclude_globs: ['*/checkout'] }), { ok: true, fresh: true });
});

// Medium in the second verification (R4), and low (R2): the collector judged
// by the document. Another extension's document_start script adds a script
// element before the page has run a line, and the log then said it was
// partial; a page still loading whose script had removed itself had its log
// called complete when the worker started a collector there. The worker
// knows when it starts one, and says so; the collector keeps it through
// reloads of the extension.
test('worker: a collector it starts says it started late, and one Chrome started does not, through reloads of the extension', async () => {
  const late = new FakePage({ worlds: { readyState: 'loading' } });
  let worker = loadWorker({ pages: { 1: late } });
  assert.deepEqual(await worker.settled(worker.send({ type: 'cdr:collect', tabId: 1 })), { ok: true, fresh: true });
  assert.equal((await late.worlds.ask('cdr:get-context')).collected.late, true, 'started now, in a page still loading');
  worker = loadWorker({ pages: { 1: late } }); // the extension reloaded
  assert.deepEqual(await worker.settled(worker.send({ type: 'cdr:collect', tabId: 1 })), { ok: true, fresh: false });
  assert.equal((await late.worlds.ask('cdr:get-context')).collected.late, true, 'after a reload of the extension');

  const declared = pageWithCollector({ scripts: [{ src: 'chrome-extension://other/page-hook.js' }] });
  assert.equal((await declared.worlds.ask('cdr:get-context')).collected.late, undefined, 'beside another extension\'s script');
  worker = loadWorker({ pages: { 1: declared } });
  assert.deepEqual(await worker.settled(worker.send({ type: 'cdr:collect', tabId: 1 })), { ok: true, fresh: false });
  assert.equal((await declared.worlds.ask('cdr:get-context')).collected.late, undefined, 'after a reload of the extension');
});

test('worker: no collector is started where Chrome blocks extensions', async () => {
  const worker = loadWorker({ pages: { 1: new FakePage({ url: 'https://chromewebstore.google.com/' }) } });
  const reply = await worker.settled(worker.send({ type: 'cdr:collect', tabId: 1 }));
  assert.equal(reply.ok, false);
  assert.deepEqual(worker.injections, []);
});

// ----------------------------------------------------------------- panel --

const TAB = 7;
const fromTab = { tab: { id: TAB } };
const RECT = { x: 0, y: 0, width: 50, height: 50 };
const VIEWPORT = { width: 1280, height: 720 };

function answers(overrides = {}) {
  return (message) => (message.type in overrides ? overrides[message.type](message) : defaultWorker(message));
}

async function started(options) {
  const panel = loadPanel(options);
  await panel.internals.ready;
  await panel.flush();
  return panel;
}

// F27. Element clicked in the two frames between a drag's release and its
// message: the region was photographed with the picker already drawn.
test('panel: a region captured while another mode is lit says its overlay may show', async () => {
  const panel = await started();
  panel.click('mode-region');
  await panel.flush();
  panel.click('mode-element');
  await panel.flush();
  panel.broadcast({ type: 'cdr:region-selected', rect: RECT, viewport: VIEWPORT }, fromTab);
  await panel.flush();
  assert.deepEqual(panel.lit(), ['element']);
  assert.equal(panel.internals.state.items.length, 1);
  assert.equal(panel.banner(), ARMED_DURING_SCREEN);
});

test('panel: a region captured with nothing else lit says nothing', async () => {
  const panel = await started();
  panel.click('mode-region');
  await panel.flush();
  panel.broadcast({ type: 'cdr:region-selected', rect: RECT, viewport: VIEWPORT }, fromTab);
  await panel.flush();
  assert.equal(panel.internals.state.items.length, 1);
  assert.equal(panel.banner(), null);
});

// F28. The shortcut armed Region again in the two frames before a drag's late
// message, which turned the newer arm dark over its live overlay.
test('panel: a late message from an earlier run leaves the newer arm of its mode lit', async () => {
  const panel = await started();
  panel.broadcast({ type: 'cdr:armed', mode: 'region', tabId: TAB, run: 'r1' });
  await panel.flush();
  panel.broadcast({ type: 'cdr:armed', mode: 'region', tabId: TAB, run: 'r2' });
  await panel.flush();
  panel.broadcast({ type: 'cdr:region-selected', rect: RECT, viewport: VIEWPORT, run: 'r1' }, fromTab);
  await panel.flush();
  assert.deepEqual(panel.lit(), ['region'], 'the late drag turned the newer arm dark');
  assert.equal(panel.internals.state.items.length, 1, 'the drag itself was not filed');
  // The newer arm drew its overlay on the page photographed.
  assert.equal(panel.banner(), ARMED_DURING_SCREEN);

  panel.broadcast({ type: 'cdr:capture-cancelled', mode: 'region', run: 'r2' }, fromTab);
  await panel.flush();
  assert.deepEqual(panel.lit(), []);
});

test('panel: a message with no run, or an arm whose run is unknown, is judged by mode as before', async () => {
  const panel = await started();
  panel.broadcast({ type: 'cdr:armed', mode: 'region', tabId: TAB, run: 'r1' });
  await panel.flush();
  panel.broadcast({ type: 'cdr:capture-cancelled', mode: 'region' }, fromTab);
  await panel.flush();
  assert.deepEqual(panel.lit(), []);

  panel.click('mode-region'); // the panel's own arm, whose run no cdr:armed has named
  await panel.flush();
  panel.broadcast({ type: 'cdr:capture-cancelled', mode: 'region', run: 'r9' }, fromTab);
  await panel.flush();
  assert.deepEqual(panel.lit(), []);
});

// F29. The arm's request failed because the worker went, but its injection
// had gone out: the button went dark and the overlay landed later.
test('panel: an arm whose request fails is cancelled as well as turned off', async () => {
  const panel = await started({
    worker: answers({
      'cdr:arm': () => {
        throw new Error('Could not establish connection. Receiving end does not exist.');
      },
    }),
  });
  panel.click('mode-region');
  await panel.flush();
  assert.deepEqual(panel.lit(), []);
  const arm = panel.sent.findIndex((m) => m.type === 'cdr:arm');
  const disarm = panel.sent.findIndex((m) => m.type === 'cdr:disarm' && m.tabId === TAB);
  assert.ok(disarm > arm, 'no disarm followed the failed arm');
});

test('panel: an arm the worker turns down is not followed by a disarm', async () => {
  const panel = await started({ worker: answers({ 'cdr:arm': () => ({ ok: false, error: 'No.' }) }) });
  panel.click('mode-region');
  await panel.flush();
  assert.deepEqual(panel.lit(), []);
  assert.equal(panel.sent.some((m) => m.type === 'cdr:disarm'), false);
});

// CW4, the panel side. The worker hears which tab the panel holds, and the
// port closing with the panel is what disarms it.
test('panel: while a mode is armed the panel holds that tab over a port, and lets go after', async () => {
  const panel = await started();
  assert.equal(panel.ports.length, 0, 'an idle panel opened a port');
  panel.click('mode-region');
  await panel.flush();
  assert.equal(panel.ports.length, 1);
  assert.equal(panel.ports[0].name, 'cdr:panel');
  assert.deepEqual(panel.ports[0].posted.at(-1), { type: 'cdr:holding', tabId: TAB });

  panel.key('Escape');
  await panel.flush();
  assert.deepEqual(panel.ports[0].posted.at(-1), { type: 'cdr:holding', tabId: null });
  assert.equal(panel.ports.length, 1, 'a second port for the same panel');

  // The worker stopped while nothing was armed: no new port until the next arm.
  panel.ports[0].close();
  await panel.flush();
  assert.equal(panel.ports.length, 1);
  panel.click('mode-element');
  await panel.flush();
  assert.equal(panel.ports.length, 2);
  assert.deepEqual(panel.ports[1].posted.at(-1), { type: 'cdr:holding', tabId: TAB });
});

// Found in Chrome: an arm, then the worker stopped within the second. The port
// was taken for one the worker shut on purpose and not reopened, so closing
// the panel then left the overlay up. Then (low in verify V2): the worker
// stopped twice within the second, and the second quick shut was taken the
// same way, with the same result.
test('panel: a port closed straight after an arm is reopened at once, then after a pause, and never in a loop', async () => {
  const panel = await started();
  panel.click('mode-region');
  await panel.flush();
  panel.ports[0].close(); // the worker stopped
  await panel.flush();
  assert.equal(panel.ports.length, 2, 'the armed panel let go of its tab');
  assert.deepEqual(panel.ports[1].posted.at(-1), { type: 'cdr:holding', tabId: TAB });

  panel.ports[1].close(); // and shut again at once
  await panel.flush();
  assert.equal(panel.ports.length, 2, 'the panel reopens at once a port that keeps being shut');
  // In Chrome the panel was closed 900 ms after the second stop.
  await panel.clock.advance(100);
  assert.equal(panel.ports.length, 3, 'the armed panel gave up holding its tab');
  assert.deepEqual(panel.ports[2].posted.at(-1), { type: 'cdr:holding', tabId: TAB });

  // A worker that shuts every port gets one after a pause that doubles up to
  // two seconds, not a loop.
  const waits = [];
  for (let i = 0; i < 7; i += 1) {
    const before = panel.ports.length;
    panel.ports.at(-1).close();
    await panel.flush();
    assert.equal(panel.ports.length, before, 'a port reopened at once in a row');
    let waited = 0;
    while (panel.ports.length === before && waited < 5000) {
      await panel.clock.advance(50);
      waited += 50;
    }
    waits.push(waited);
  }
  assert.deepEqual(waits, [200, 400, 800, 1600, 2000, 2000, 2000]);

  // Nothing armed by the time the pause is over: nothing to hold.
  const before = panel.ports.length;
  panel.ports.at(-1).close();
  await panel.flush();
  panel.key('Escape');
  await panel.flush();
  await panel.clock.advance(5000);
  assert.equal(panel.ports.length, before, 'a port was opened for an arm that had ended');
});

// Improvement 9, the panel side. `late` is what the collector says when it
// started after the page had begun to run, and the bridge passes on.
const COLLECTED = (armedAt, late = false) => ({
  ok: true,
  page: { url: 'https://example.test/', title: 'Example', viewport: {} },
  collected: { console: [], warnings: [], errors: [], network: [], armedAt, ...(late && { late: true }) },
});

test('panel: a tab with no collector gets one, and the panel says the log starts now', async () => {
  let collecting = false;
  let reloaded = false;
  const panel = await started({
    worker: answers({
      'cdr:collect': () => {
        collecting = true;
        return { ok: true, fresh: true };
      },
    }),
    setup: (chrome) => {
      chrome.tabs.sendMessage = async () => {
        if (!collecting) throw new Error('Could not establish connection. Receiving end does not exist.');
        return reloaded ? COLLECTED(5000) : COLLECTED(Date.now(), true);
      };
    },
  });
  await panel.flush();
  const warning = panel.element('collector-warning');
  assert.equal(panel.sent.filter((m) => m.type === 'cdr:collect').length, 1);
  assert.equal(warning.hidden, false);
  assert.match(warning.textContent, /^Collecting from now/);
  assert.equal(panel.element('count-console').textContent, '0');

  // The page reloads: the declared content scripts start a collector of their
  // own, from the page's start, and the note goes.
  reloaded = true;
  panel.click('refresh-context');
  await panel.flush();
  assert.equal(warning.hidden, true);
  assert.equal(panel.sent.filter((m) => m.type === 'cdr:collect').length, 1);
});

/** The report the next Copy hands the template, with one item on the sheet. */
async function reportOfCopy(panel) {
  panel.broadcast({ type: 'cdr:region-selected', rect: RECT, viewport: VIEWPORT }, fromTab);
  await panel.flush();
  await panel.flush();
  const realm = new panel.internals.handleBroadcast.constructor('return this')();
  const assemble = realm.assembleReport;
  let report = null;
  realm.assembleReport = (...args) => (report = assemble(...args));
  panel.click('submit');
  await panel.flush();
  await panel.clock.advance(500);
  await panel.flush();
  return report;
}

// Medium in verify V2. Whether the log started late lived in the panel's
// memory, which went with the panel: opened again on the same tab, with the
// same collector running, it said nothing, and neither did the prompt.
test('panel: the late start is still said after the panel is closed and opened again', async () => {
  // The bridge the first panel had the worker inject answers this one.
  const panel = await started({
    setup: (chrome) => {
      chrome.tabs.sendMessage = async () => COLLECTED(1000, true);
    },
  });
  await panel.flush();
  const warning = panel.element('collector-warning');
  assert.equal(warning.hidden, false, 'the reopened panel forgot that the log started late');
  // Started long before this panel opened, so "from now" would be false.
  assert.match(warning.textContent, /^Collecting since \d\d:\d\d[^.]*\. .* nothing it logged before then is in the log\.$/);
  assert.equal(panel.sent.some((m) => m.type === 'cdr:collect'), false);
  const report = await reportOfCopy(panel);
  assert.equal(report?.startedLate, true, 'the prompt forgot that the log started late');
  assert.equal(report.armedAt, 1000);
});

// Medium in verify V2, V4 and V7, the panel's half: it took the worker's
// fresh for a late start, and a worker can only guess (it guessed wrong after
// every reload of the extension). The collector knows when it started.
test('panel: a collector that started with the page is no late start, whatever the worker answered', async () => {
  let bridged = false;
  const panel = await started({
    worker: answers({
      'cdr:collect': () => {
        bridged = true;
        return { ok: true, fresh: true };
      },
    }),
    setup: (chrome) => {
      chrome.tabs.sendMessage = async () => {
        if (!bridged) throw new Error('Could not establish connection. Receiving end does not exist.');
        return COLLECTED(1000);
      };
    },
  });
  await panel.flush();
  assert.equal(panel.sent.filter((m) => m.type === 'cdr:collect').length, 1);
  assert.equal(panel.element('collector-warning').hidden, true, 'a log from the page\'s start was called late');
  const report = await reportOfCopy(panel);
  assert.equal(report?.startedLate, undefined);
});

test('panel: a tab that refuses a collector keeps the reload advice, and is not asked on every read', async () => {
  const panel = await started({ worker: answers({ 'cdr:collect': () => ({ ok: false, error: 'Cannot access contents of the page.' }) }) });
  const warning = panel.element('collector-warning');
  panel.click('refresh-context');
  await panel.flush();
  panel.click('refresh-context');
  await panel.flush();
  // The footnote's own text, the reload advice in panel.html, is left as it is.
  assert.equal(warning.hidden, false);
  assert.doesNotMatch(warning.textContent, /Collecting from now/);
  assert.equal(panel.sent.filter((m) => m.type === 'cdr:collect').length, 1);
});

// With the matches narrowed, the old advice to reload sent the user round in
// a circle: the reloaded page gets no collector either.
test('panel: a site the manifest leaves out says so, and is not told to reload', async () => {
  const panel = await started({ worker: answers({ 'cdr:collect': () => ({ ok: false, outside: 'site' }) }) });
  await panel.flush();
  const warning = panel.element('collector-warning');
  assert.equal(warning.hidden, false);
  assert.match(warning.textContent, /set to run only on other sites/);
  panel.click('refresh-context');
  await panel.flush();
  assert.match(warning.textContent, /set to run only on other sites/);
  assert.equal(panel.sent.filter((m) => m.type === 'cdr:collect').length, 1);
});

test('panel: a collector found running after an extension reload is no late start', async () => {
  let bridged = false;
  const panel = await started({
    worker: answers({
      'cdr:collect': () => {
        bridged = true;
        return { ok: true, fresh: false };
      },
    }),
    setup: (chrome) => {
      chrome.tabs.sendMessage = async () => {
        if (!bridged) throw new Error('Could not establish connection. Receiving end does not exist.');
        return COLLECTED(1000);
      };
    },
  });
  await panel.flush();
  assert.equal(panel.element('collector-warning').hidden, true);
});
