/**
 * sidepanel/panel.js, run for real in a fresh node:vm realm, against a stub of
 * the DOM it touches and fakes of the chrome APIs it calls.
 *
 * The stub is the least that lets the panel's own code run: elements keep
 * their classes, text, flags and listeners, and build a tree only as deep as
 * the sheet needs. Nothing is laid out or painted, so what a test here proves
 * is the panel's bookkeeping (which mode is lit, what the banner says, what is
 * sent to the worker and when), not how any of it looks. A canvas records
 * what is drawn on it instead (recordingContext), images and bitmaps decode
 * to the size a test sets for their source (imageSizes), and an element can
 * hold pointer capture, so the drawing code can be followed call by call.
 *
 * The worker is a function the test supplies, which answers each message the
 * panel sends or holds the answer back. Time is a fake clock the test moves.
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { flush, makeClock } from './worker-realm.mjs';

const SOURCE = readFileSync(new URL('../../sidepanel/panel.js', import.meta.url), 'utf8');
const IMPORT = "import { buildPrompt } from '../shared/prompt-template.js';";

class FakeClassList {
  constructor() {
    this.names = new Set();
  }
  add(...names) {
    for (const name of names) this.names.add(name);
  }
  remove(...names) {
    for (const name of names) this.names.delete(name);
  }
  contains(name) {
    return this.names.has(name);
  }
  toggle(name, force) {
    const on = force === undefined ? !this.names.has(name) : Boolean(force);
    if (on) this.names.add(name);
    else this.names.delete(name);
    return on;
  }
}

/** What a 2D context can be asked to do, each recorded with its arguments. */
const CONTEXT_METHODS = [
  'drawImage',
  'setTransform',
  'resetTransform',
  'transform',
  'scale',
  'translate',
  'rotate',
  'save',
  'restore',
  'beginPath',
  'closePath',
  'moveTo',
  'lineTo',
  'quadraticCurveTo',
  'bezierCurveTo',
  'arc',
  'arcTo',
  'ellipse',
  'rect',
  'stroke',
  'fill',
  'clearRect',
  'fillRect',
  'strokeRect',
  'setLineDash',
  'fillText',
  'strokeText',
];

/**
 * A 2D context that draws nothing and records everything: each call as
 * { op, args } and each property set as { set, value }, in order, in
 * `calls`. The property keeps the value set, as a real context does.
 */
function recordingContext(canvas) {
  const calls = [];
  const target = { canvas, calls };
  for (const name of CONTEXT_METHODS) {
    target[name] = (...args) => {
      calls.push({ op: name, args });
    };
  }
  target.measureText = (text) => {
    calls.push({ op: 'measureText', args: [text] });
    return { width: String(text).length * 6 };
  };
  target.getLineDash = () => [];
  return new Proxy(target, {
    set(object, name, value) {
      calls.push({ set: name, value });
      object[name] = value;
      return true;
    },
  });
}

class FakeElement {
  constructor(tag = 'div', id = null) {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.classList = new FakeClassList();
    this.attributes = new Map();
    this.listeners = new Map();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.checked = true;
    this.value = '';
    this.textContent = '';
    this.scrollHeight = 0;
    this.clientHeight = 0;
  }
  get className() {
    return [...this.classList.names].join(' ');
  }
  set className(value) {
    this.classList.names = new Set(String(value).split(/\s+/).filter(Boolean));
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
  dispatch(type, event = {}) {
    const full = { type, target: this, preventDefault() {}, stopPropagation() {}, ...event };
    for (const listener of [...(this.listeners.get(type) || [])]) listener(full);
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }
  appendChild(node) {
    if (node && typeof node === 'object') {
      node.parentNode = this;
      this.children.push(node);
    }
    return node;
  }
  removeChild(node) {
    this.children = this.children.filter((child) => child !== node);
    return node;
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  contains(node) {
    if (!node) return false;
    if (node === this) return true;
    return this.children.some((child) => child.contains?.(node));
  }
  /** Class selectors only, such as '.row' or '.row.on', which is all the panel asks. */
  querySelector(selector) {
    const wanted = selector.split('.').filter(Boolean);
    for (const child of this.children) {
      if (wanted.every((name) => child.classList.contains(name))) return child;
      const deeper = child.querySelector?.(selector);
      if (deeper) return deeper;
    }
    return null;
  }
  focus() {}
  select() {}
  setSelectionRange() {}
  scrollIntoView() {}
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  /** One recording context per canvas, as a real canvas hands back one context. */
  getContext() {
    this.context ??= recordingContext(this);
    return this.context;
  }
  toDataURL(type = 'image/png') {
    return `data:${type};base64,AAAA`;
  }
  /**
   * A PNG of the canvas, as a stand-in Blob that says which canvas made it,
   * handed over a task later, as Chrome encodes off the caller's turn. Each
   * one is kept in `blobs`. A test that wants the encoder to fail replaces
   * this on the prototype and hands over null.
   */
  toBlob(callback, type = 'image/png') {
    const blob = { type, size: Math.max(4, (this.width || 0) * (this.height || 0)), canvas: this };
    (this.blobs ??= []).push(blob);
    setImmediate(() => callback(blob));
  }
  /** Pointer capture, as far as a test can see it: which pointers this element holds. */
  setPointerCapture(pointerId) {
    (this.captured ??= new Set()).add(pointerId);
  }
  releasePointerCapture(pointerId) {
    this.captured?.delete(pointerId);
  }
  hasPointerCapture(pointerId) {
    return Boolean(this.captured?.has(pointerId));
  }
}

const DEFAULT_IMAGE = { width: 1280, height: 720 };

/**
 * The size an image or bitmap made from `source` decodes to: what the test
 * set for that source in `sizes`, or for the data URL a stand-in Blob was
 * made from; a canvas's own size; else 1280×720. A size of { error: true }
 * fails to decode.
 */
function sizeIn(sizes, source) {
  if (sizes.has(source)) return sizes.get(source);
  if (source && typeof source === 'object') {
    if (sizes.has(source.source)) return sizes.get(source.source);
    if (source instanceof FakeElement) return { width: source.width || 0, height: source.height || 0 };
  }
  return DEFAULT_IMAGE;
}

/** An Image whose natural size, once loaded, is the one `sizes` gives its src. */
function imageClass(sizes) {
  return class FakeImage {
    constructor() {
      this.naturalWidth = DEFAULT_IMAGE.width;
      this.naturalHeight = DEFAULT_IMAGE.height;
    }
    set src(value) {
      this.source = value;
      const size = sizeIn(sizes, value);
      setImmediate(() => {
        if (size.error) {
          this.onerror?.();
          return;
        }
        this.naturalWidth = size.width;
        this.naturalHeight = size.height;
        this.onload?.();
      });
    }
    get src() {
      return this.source;
    }
  };
}

/**
 * A DataTransfer as a drag event carries one: setData adds a type, and types
 * lists them, as Chrome lets the page read during a dragover. `types` is what
 * a drag from elsewhere brings, such as ['Files'] for a file.
 */
export function makeDataTransfer(types = []) {
  const data = new Map(types.map((type) => [type, '']));
  return {
    data,
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
    get types() {
      return [...data.keys()];
    },
    setData(type, value) {
      data.set(String(type).toLowerCase(), String(value));
    },
    getData(type) {
      return data.get(String(type).toLowerCase()) ?? '';
    },
  };
}

/** Answers the way the worker does when everything goes to plan. */
export function defaultWorker(message) {
  switch (message.type) {
    case 'cdr:check-tab':
      return { ok: true, restriction: null, armedMode: null, armId: null };
    case 'cdr:arm':
      return { ok: true };
    case 'cdr:disarm':
      return { ok: true, superseded: false };
    case 'cdr:verify':
      return { ok: true, mode: null };
    default:
      return undefined;
  }
}

/**
 * @param {{ worker?: (message: object) => any, tab?: object, setup?: (chrome: object) => void, globals?: object, scripting?: (details: object) => any }} options
 *   worker answers each runtime.sendMessage: a value, a promise of one, or a
 *   throw for a worker that did not answer. setup can change the chrome fake
 *   before the panel loads. globals are more names in the panel's global
 *   scope from its first line, such as a navigator. scripting answers each
 *   chrome.scripting.executeScript, as the page would (an array of
 *   { result }), or throws for a page that refused it.
 */
export function loadPanel({
  worker = defaultWorker,
  tab = { id: 7, windowId: 1, url: 'https://example.test/', title: 'Example' },
  setup = () => {},
  // The panel's fetch, in place before panel.js runs, so what it asks for
  // at load is seen too. Its Blob is a stand-in that says which URL it was
  // made from, so a size set for that URL in imageSizes holds for it too.
  fetch = async (url) => ({ blob: async () => ({ type: 'image/png', size: 4, source: url }) }),
  globals = {},
  scripting = () => [{ result: undefined }],
} = {}) {
  const clock = makeClock();
  const elements = new Map();
  const documentListeners = new Map();
  const windowListeners = new Map();
  const runtimeListeners = [];
  const sent = [];
  const shots = { next: [] };
  const ports = []; // every port the panel opened, with what it posted
  const tabPorts = []; // every port the panel opened to a tab (chrome.tabs.connect)
  // What an image or a bitmap made from a source decodes to, by source (see
  // sizeIn); a test sets it before the panel decodes that source.
  const imageSizes = new Map();
  const bitmaps = []; // every bitmap createImageBitmap made, with whether it was closed
  const objectUrls = []; // every { url, blob } URL.createObjectURL made, in order
  const scripted = []; // every chrome.scripting.executeScript call, as it was made

  const document = {
    // An open side panel is visible from its first line.
    visibilityState: 'visible',
    activeElement: null,
    body: new FakeElement('body'),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement('div', id));
      return elements.get(id);
    },
    createElement: (tag) => new FakeElement(tag),
    addEventListener(type, listener) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(listener);
    },
    hasFocus: () => true,
    execCommand: () => true,
  };

  class PanelURL extends URL {}
  PanelURL.createObjectURL = (blob) => {
    const url = `blob:panel/${objectUrls.length + 1}`;
    objectUrls.push({ url, blob, revoked: false });
    return url;
  };
  PanelURL.revokeObjectURL = (url) => {
    const made = objectUrls.find((entry) => entry.url === url);
    if (made) made.revoked = true;
  };

  /** A decoded bitmap of the size sizeIn gives its source, with close(). */
  async function createImageBitmap(source) {
    const size = sizeIn(imageSizes, source);
    if (size.error) throw new Error('The source image could not be decoded.');
    const bitmap = {
      width: size.width,
      height: size.height,
      source,
      closed: false,
      close() {
        bitmap.closed = true;
      },
    };
    bitmaps.push(bitmap);
    return bitmap;
  }

  const chrome = {
    runtime: {
      getManifest: () => ({ version: '0.0.0' }),
      onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
      sendMessage: (message) => {
        sent.push(message);
        try {
          return Promise.resolve(worker(message));
        } catch (error) {
          return Promise.reject(error);
        }
      },
      // A port to the worker. posted holds what the panel sent on it; the
      // test closes it from the worker's end with close().
      connect: ({ name } = {}) => {
        const onDisconnect = [];
        const port = {
          name,
          posted: [],
          disconnected: false,
          postMessage(message) {
            if (port.disconnected) throw new Error('Attempting to use a disconnected port object');
            port.posted.push(JSON.parse(JSON.stringify(message)));
          },
          disconnect() {
            port.disconnected = true;
          },
          onDisconnect: { addListener: (fn) => onDisconnect.push(fn) },
          onMessage: { addListener() {} },
          close() {
            port.disconnected = true;
            for (const fn of onDisconnect) fn(port);
          },
        };
        ports.push(port);
        return port;
      },
    },
    tabs: {
      query: async () => [tab],
      sendMessage: async () => {
        throw new Error('Could not establish connection. Receiving end does not exist.');
      },
      // A port to a tab's content scripts, which stays open and silent until
      // the test says otherwise: receive() is a message from the page's end,
      // close() that end going away. disconnected says the panel closed it.
      connect: (tabId, { name, frameId } = {}) => {
        const onMessage = [];
        const onDisconnect = [];
        const port = {
          tabId,
          name,
          frameId,
          disconnected: false,
          postMessage() {
            if (port.disconnected) throw new Error('Attempting to use a disconnected port object');
          },
          disconnect() {
            port.disconnected = true;
          },
          onMessage: { addListener: (fn) => onMessage.push(fn) },
          onDisconnect: { addListener: (fn) => onDisconnect.push(fn) },
          receive(message) {
            if (!port.disconnected) for (const fn of onMessage) fn(JSON.parse(JSON.stringify(message)), port);
          },
          close() {
            if (port.disconnected) return;
            port.disconnected = true;
            for (const fn of onDisconnect) fn(port);
          },
        };
        tabPorts.push(port);
        return port;
      },
      // A test can queue what the next calls do: a function that throws for
      // the quota, or one that runs something during the capture.
      captureVisibleTab: async () => {
        const next = shots.next.shift();
        if (next) await next();
        return 'data:image/png;base64,AAAA';
      },
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
    },
    storage: {
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      onChanged: { addListener() {} },
    },
    downloads: {
      download: async () => 1,
      search: async ({ id }) => [{ id, state: 'complete', filename: '/tmp/claude-punch-list/shot.png', exists: true }],
      removeFile: async () => {},
      erase: async () => {},
      show() {},
      onChanged: { addListener() {} },
    },
    // The page's half of executeScript: `scripting` answers, and every call
    // is kept in `scripted`.
    scripting: {
      executeScript: async (details) => {
        scripted.push(details);
        return scripting(details);
      },
    },
  };

  setup(chrome);

  const window = {
    innerWidth: 400,
    innerHeight: 800,
    addEventListener(type, listener) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(listener);
    },
    removeEventListener(type, listener) {
      const list = windowListeners.get(type) || [];
      const index = list.indexOf(listener);
      if (index !== -1) list.splice(index, 1);
    },
  };

  const context = vm.createContext({
    __panelImports: { buildPrompt: () => 'prompt' },
    chrome,
    document,
    window,
    console,
    crypto: globalThis.crypto,
    Image: imageClass(imageSizes),
    URL: PanelURL,
    createImageBitmap,
    fetch,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    ...globals,
  });

  // Same line count as the import it replaces, so stack traces point at the
  // real lines. Strict, as a module is.
  if (!SOURCE.includes(IMPORT)) throw new Error('panel.js no longer imports the template as expected');
  const source = `'use strict';${SOURCE.replace(IMPORT, 'const { buildPrompt } = __panelImports;')}`;
  const internals = vm.runInContext(
    `${source}\n;({ state, ready, captureVisible, capturePage, resolveTab, handleBroadcast })`,
    context,
    { filename: 'sidepanel/panel.js' }
  );

  const element = (id) => document.getElementById(id);

  return {
    chrome,
    clock,
    sent,
    shots,
    ports,
    tabPorts,
    imageSizes,
    bitmaps,
    objectUrls,
    scripted,
    internals,
    element,
    document,
    window,
    /** Which mode buttons are lit. */
    lit() {
      return ['region', 'element'].filter((mode) => element(`mode-${mode}`).classList.contains('armed'));
    },
    banner() {
      const node = element('banner');
      return node.hidden ? null : node.textContent;
    },
    click(id, event = { detail: 1 }) {
      element(id).dispatch('click', event);
    },
    key(key) {
      for (const listener of documentListeners.get('keydown') || []) {
        listener({ key, isComposing: false, metaKey: false, ctrlKey: false, preventDefault() {} });
      }
    },
    /** Fire the document's own listeners for `type` with `event`. */
    documentEvent(type, event = {}) {
      for (const listener of documentListeners.get(type) || []) listener(event);
    },
    /** Fire the window's listeners for `type`, such as 'resize' or 'pagehide'. */
    windowEvent(type, event = {}) {
      for (const listener of [...(windowListeners.get(type) || [])]) listener({ type, ...event });
    },
    /**
     * Lay the sheet's rows out for getBoundingClientRect, each `height` px
     * tall and `gap` px below the one before, from the top of the list, as
     * Chrome reports them; the stub lays nothing out by itself. A rebuild of
     * the list makes new rows, which need laying out again.
     */
    layOutRows({ height = 40, gap = 4 } = {}) {
      element('list').children.forEach((row, index) => {
        const top = index * (height + gap);
        row.getBoundingClientRect = () => ({ left: 0, right: 300, width: 300, top, bottom: top + height, height });
      });
    },
    /** A broadcast, from a content script on `tabId` or from the worker. */
    broadcast(message, sender = {}) {
      for (const listener of runtimeListeners) listener(message, sender);
    },
    flush,
  };
}
