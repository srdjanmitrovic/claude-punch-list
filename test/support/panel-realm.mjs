/**
 * sidepanel/panel.js, run for real in a fresh node:vm realm, against a stub of
 * the DOM it touches and fakes of the chrome APIs it calls.
 *
 * The stub is the least that lets the panel's own code run: elements keep
 * their classes, text, flags and listeners, and build a tree only as deep as
 * the sheet needs. Nothing is laid out or painted, so what a test here proves
 * is the panel's bookkeeping (which mode is lit, what the banner says, what is
 * sent to the worker and when), not how any of it looks.
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
  getContext() {
    return { drawImage() {} };
  }
  toDataURL(type = 'image/png') {
    return `data:${type};base64,AAAA`;
  }
}

class FakeImage {
  constructor() {
    this.naturalWidth = 1280;
    this.naturalHeight = 720;
  }
  set src(value) {
    this.source = value;
    setImmediate(() => this.onload?.());
  }
  get src() {
    return this.source;
  }
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
 * @param {{ worker?: (message: object) => any, tab?: object, setup?: (chrome: object) => void }} options
 *   worker answers each runtime.sendMessage: a value, a promise of one, or a
 *   throw for a worker that did not answer. setup can change the chrome fake
 *   before the panel loads.
 */
export function loadPanel({
  worker = defaultWorker,
  tab = { id: 7, windowId: 1, url: 'https://example.test/', title: 'Example' },
  setup = () => {},
} = {}) {
  const clock = makeClock();
  const elements = new Map();
  const documentListeners = new Map();
  const runtimeListeners = [];
  const sent = [];
  const shots = { next: [] };
  const ports = []; // every port the panel opened, with what it posted


  const document = {
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
  PanelURL.createObjectURL = () => 'blob:panel';
  PanelURL.revokeObjectURL = () => {};

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
  };

  setup(chrome);

  const window = {
    innerWidth: 400,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
  };

  const context = vm.createContext({
    __panelImports: { buildPrompt: () => 'prompt' },
    chrome,
    document,
    window,
    console,
    crypto: globalThis.crypto,
    Image: FakeImage,
    URL: PanelURL,
    fetch: async () => ({ blob: async () => ({}) }),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });

  // Same line count as the import it replaces, so stack traces point at the
  // real lines. Strict, as a module is.
  if (!SOURCE.includes(IMPORT)) throw new Error('panel.js no longer imports the template as expected');
  const source = `'use strict';${SOURCE.replace(IMPORT, 'const { buildPrompt } = __panelImports;')}`;
  const internals = vm.runInContext(
    `${source}\n;({ state, ready, captureVisible, resolveTab, handleBroadcast })`,
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
    internals,
    element,
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
    /** A broadcast, from a content script on `tabId` or from the worker. */
    broadcast(message, sender = {}) {
      for (const listener of runtimeListeners) listener(message, sender);
    },
    flush,
  };
}
