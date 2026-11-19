/**
 * background.js, run for real in a fresh node:vm realm, against fakes of the
 * chrome APIs it calls and of the pages it injects into.
 *
 * The page is a model of how Chrome was observed to run injections, not a
 * browser. An injection runs when the page's main thread is free, in the order
 * it arrived; one without injectImmediately waits for document_idle as well. A
 * file injection arrives a turn after it was asked for, because Chrome reads
 * the file from the package first, and a function injection arrives at once,
 * so a function asked for straight after a file can overtake it. The capture
 * scripts are stood in for by controllers with the start(), stop() and
 * isActive() the real ones expose. The functions the worker injects (the stop
 * and the probe) are the worker's own, serialised and run in a realm of the
 * page's, as executeScript does. The stop it queues is a file, content/stop.js,
 * and arrives in order with the other files; the collector's files are only
 * recorded, unless the page is given both of its worlds (FakePage's `worlds`,
 * see makeWorlds), where they run for real in the world each is injected
 * into, as do the functions.
 *
 * Time is a fake clock the test moves, and Chrome stopping the worker is
 * kill(): nothing reaches the worker after it, while the pages carry on.
 *
 * Chrome's download list (makeDownloads) and storage.local (a Map) outlive a
 * worker, so a test can hand the same ones to the worker started after one
 * was stopped.
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../../background.js', import.meta.url), 'utf8');
const MANIFEST = readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8');
const COLLECTOR_FILES = {
  'content/collector-main.js': readFileSync(new URL('../../content/collector-main.js', import.meta.url), 'utf8'),
  'content/collector-bridge.js': readFileSync(new URL('../../content/collector-bridge.js', import.meta.url), 'utf8'),
};

// Values made in the worker's realm have that realm's prototypes, which strict
// deep equality would reject. Every reply crosses a message channel in Chrome
// anyway, so a JSON round trip loses nothing here.
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/** Let every promise chain and every turn queued with setImmediate run out. */
export async function flush(turns = 20) {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

export function makeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms = 0, ...args) {
      const id = nextId++;
      timers.set(id, { at: now + Math.max(0, ms), fn, args });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    /** Move time on by `ms`, running each timer that falls due, in order. */
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await flush();
        let due = null;
        for (const [id, timer] of timers) {
          if (timer.at <= end && (!due || timer.at < due[1].at)) due = [id, timer];
        }
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn(...due[1].args);
      }
      now = end;
      await flush();
    },
    get now() {
      return now;
    },
  };
}

/**
 * A tab's two JavaScript worlds, the page's (main) and an extension's
 * (isolated), as far as the collector and its bridge can tell them apart.
 * Each is a realm of its own, with its own globals and prototypes, so what a
 * page script replaces in its world stays as it was in the other, and they
 * share the window's events: an event dispatched in either reaches the
 * listeners of both, synchronously, capture listeners first, each in the
 * order added, and each world sees it through its own prototypes. An init
 * dictionary is read as WebIDL reads one, member by member through the
 * object's prototype chain; a detail read in another world than the one
 * that set it is a structured clone, as Chrome makes it; and while a
 * listener runs, its world's window.event is the event. A message posted to
 * the window reaches every message listener a task later.
 *
 * The isolated world's chrome.runtime has no id unless `extensionId` is
 * given, so every bridge injected is one after a reload of the extension, and
 * ask() goes to the last of them. With an id the first bridge is the live
 * one, and a second injection beside it adds nothing, as in Chrome; deleting
 * the id is the extension being reloaded under it.
 *
 * An event can also be sent on a node both worlds share (node()), as the
 * picker asks the component's name while it hovers: the window's capture
 * listeners of both worlds hear it at once, and its bubbling ones only if it
 * bubbles. Each world's event has that world's own wrapper of the node first
 * in its composedPath() and, as its target, that wrapper or, for a node in a
 * shadow root, its host's, and window.event is set as for one on the window.
 *
 * `clock` (makeClock) runs both worlds' timers, for a test that times what
 * the bridge does; without one they are node's. `dispatched` lists the type
 * of every event dispatched on the window or a node, in order, whichever
 * world sent it.
 */
export function makeWorlds({
  url = 'https://example.test/',
  title = 'Example',
  readyState = 'loading',
  extensionId,
  clock,
} = {}) {
  const listeners = new Map(); // type -> [{ world, fn, capture }]
  const STATE = new WeakMap(); // an event, in either world -> what both worlds see of it
  const posted = [];
  const errors = []; // thrown by listeners, which Chrome reports and goes on
  const dispatched = [];
  const worlds = {};
  let onMessage = null;
  let onConnect = null;
  const timers = clock ? { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout } : { setTimeout, clearTimeout };

  const listFor = (type) => {
    if (!listeners.has(type)) listeners.set(type, []);
    return listeners.get(type);
  };
  const clone = (value) => (value !== null && typeof value === 'object' ? structuredClone(value) : value);

  /** The event as `name`'s world sees it. */
  function wrap(state, name) {
    let wrapper = state.wrappers.get(name);
    if (!wrapper) {
      const classes = worlds[name].classes;
      wrapper = Object.create((state.custom ? classes.CustomEvent : classes.Event).prototype);
      STATE.set(wrapper, state);
      state.wrappers.set(name, wrapper);
    }
    return wrapper;
  }

  function classesFor(name) {
    const stateOf = (event) => {
      const state = STATE.get(event);
      if (!state) throw new TypeError('Illegal invocation');
      return state;
    };
    const member = (init, key) => (init === undefined || init === null ? undefined : init[key]);
    class Event {
      constructor(type, init) {
        const state = {
          type: String(type),
          bubbles: Boolean(member(init, 'bubbles')),
          cancelable: Boolean(member(init, 'cancelable')),
          composed: Boolean(member(init, 'composed')),
          detail: null,
          world: name,
          custom: false,
          defaultPrevented: false,
          trusted: false, // only an event fire() sends, as the browser's own
          stopped: false,
          dispatching: false,
          on: null, // the node it is sent on, if not the window
          wrappers: new Map(),
        };
        state.wrappers.set(name, this);
        STATE.set(this, state);
      }
      get type() {
        return stateOf(this).type;
      }
      get cancelable() {
        return stateOf(this).cancelable;
      }
      get defaultPrevented() {
        return stateOf(this).defaultPrevented;
      }
      get isTrusted() {
        return stateOf(this).trusted;
      }
      // For one sent on a node (see node()): the node as this world wraps
      // it, or the host of the shadow root it is in, as retargeting gives it
      // to a listener on the window. For one sent on the window, the window.
      get target() {
        const state = stateOf(this);
        if (!state.on) return worlds[name].self;
        return (state.on.host || state.on).wrappers[name];
      }
      // The node first, then its host if it has one, then the window, while
      // the event is being dispatched; empty after, as in Chrome.
      composedPath() {
        const state = stateOf(this);
        if (!state.dispatching) return [];
        const path = [];
        for (let at = state.on; at; at = at.host) path.push(at.wrappers[name]);
        path.push(worlds[name].self);
        return path;
      }
      preventDefault() {
        const state = stateOf(this);
        if (state.cancelable) state.defaultPrevented = true;
      }
      stopPropagation() {}
      stopImmediatePropagation() {
        stateOf(this).stopped = true;
      }
    }
    class CustomEvent extends Event {
      constructor(type, init) {
        super(type, init);
        const state = stateOf(this);
        state.custom = true;
        const detail = member(init, 'detail');
        state.detail = detail === undefined ? null : detail;
      }
      get detail() {
        const state = stateOf(this);
        return state.world === name ? state.detail : clone(state.detail);
      }
    }
    return { Event, CustomEvent };
  }

  /**
   * An event sent on the window (`on` null) or on a node of node(). Sent on
   * a node, it meets the window's capture listeners on its way down and its
   * bubbling ones only if it bubbles, and one in a shadow root that is not
   * composed stays there and meets none.
   */
  function dispatch(event, on) {
    const state = STATE.get(event);
    if (!state) throw new TypeError("Failed to execute 'dispatchEvent': parameter 1 is not of type 'Event'.");
    if (state.dispatching) throw new Error('InvalidStateError: the event is already being dispatched.');
    dispatched.push(state.type);
    if (on && on.host && !state.composed) return !state.defaultPrevented;
    state.on = on;
    state.dispatching = true;
    state.stopped = false;
    const all = [...listFor(state.type)];
    const bubbling = !on || state.bubbles ? all.filter((one) => !one.capture) : [];
    try {
      for (const entry of [...all.filter((one) => one.capture), ...bubbling]) {
        if (state.stopped) break;
        if (!listFor(state.type).includes(entry)) continue;
        const target = worlds[entry.world].window;
        const seen = wrap(state, entry.world);
        const previous = target.event;
        target.event = seen;
        try {
          entry.fn.call(worlds[entry.world].self, seen);
        } catch (error) {
          errors.push(error);
        } finally {
          target.event = previous;
        }
      }
    } finally {
      state.dispatching = false;
    }
    return !state.defaultPrevented;
  }

  function eventsFor(name, win) {
    const capturing = (options) => options === true || Boolean(options && typeof options === 'object' && options.capture);
    return {
      addEventListener(type, fn, options) {
        const capture = capturing(options);
        const list = listFor(String(type));
        if (list.some((one) => one.world === name && one.fn === fn && one.capture === capture)) return;
        list.push({ world: name, fn, capture });
      },
      removeEventListener(type, fn, options) {
        const capture = capturing(options);
        const list = listFor(String(type));
        const at = list.findIndex((one) => one.world === name && one.fn === fn && one.capture === capture);
        if (at !== -1) list.splice(at, 1);
      },
      dispatchEvent(event) {
        return dispatch(event, null);
      },
      postMessage(data) {
        posted.push(JSON.parse(JSON.stringify(data)));
        setTimeout(() => {
          for (const entry of [...listFor('message')]) {
            const self = worlds[entry.world].self;
            try {
              entry.fn.call(self, { source: self, data: clone(data) });
            } catch (error) {
              errors.push(error);
            }
          }
        }, 0);
      },
    };
  }

  const document = { title, readyState, scripts: [], querySelector: () => null };
  const location = { href: url };
  const shared = {
    document,
    location,
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 2,
    scrollX: 0,
    scrollY: 0,
    navigator: { userAgent: 'Mozilla/5.0 (test)' },
    crypto: globalThis.crypto,
  };
  class FakeEventTarget {
    addEventListener() {}
  }
  for (const name of ['main', 'isolated']) {
    const win = { ...shared };
    const classes = classesFor(name);
    Object.assign(win, classes, eventsFor(name, win), timers);
    if (name === 'main') {
      Object.assign(win, {
        console: { error() {}, warn() {}, log() {}, info() {}, debug() {} },
        XMLHttpRequest: class extends FakeEventTarget {
          open() {}
          send() {}
          abort() {}
        },
        EventTarget: FakeEventTarget,
        performance: { now: () => 0 },
        Element: class Element {},
      });
    } else {
      win.chrome = {
        runtime: {
          ...(extensionId === undefined ? {} : { id: extensionId }),
          lastError: undefined,
          onMessage: {
            addListener(listener) {
              onMessage = listener;
            },
          },
          onConnect: {
            addListener(listener) {
              onConnect = listener;
            },
          },
        },
      };
    }
    win.window = win;
    win.event = undefined;
    const realm = vm.createContext(win);
    // What the world's own code sees as window: node hands its scripts the
    // realm's global proxy rather than the object it was made from.
    worlds[name] = { window: win, classes, realm, self: vm.runInContext('window', realm) };
  }

  return {
    main: worlds.main,
    isolated: worlds.isolated,
    document,
    posted,
    errors,
    dispatched,
    /** An event the browser fires on the window (pagehide, say), trusted in every world. */
    fire(type) {
      const event = new worlds.isolated.classes.Event(type);
      STATE.get(event).trusted = true;
      return worlds.isolated.window.dispatchEvent(event);
    },
    /**
     * A port the panel opens to the last bridge that listened, as
     * chrome.tabs.connect does. posted holds what the bridge posted on it
     * (at, the clock's time of each, when there is a clock); close() is the
     * panel going away or disconnecting; closed says whether the bridge
     * shut it.
     */
    connect(name, sender = { id: extensionId, url: 'chrome-extension://test-extension/sidepanel/panel.html' }) {
      if (!onConnect) throw new Error('no bridge ever listened for a port');
      const onDisconnect = [];
      const panel = { posted: [], at: [], closed: false, gone: false };
      const port = {
        name,
        sender,
        postMessage(message) {
          if (panel.gone || panel.closed) throw new Error('Attempting to use a disconnected port object');
          panel.posted.push(JSON.parse(JSON.stringify(message)));
          panel.at.push(clock ? clock.now : null);
        },
        disconnect() {
          panel.closed = true;
        },
        onDisconnect: { addListener: (fn) => onDisconnect.push(fn) },
        onMessage: { addListener() {} },
      };
      onConnect(port);
      panel.close = () => {
        if (panel.gone || panel.closed) return;
        panel.gone = true;
        for (const fn of onDisconnect) fn(port);
      };
      return panel;
    },
    /**
     * A node of the document, which both worlds share as they share the
     * window's events, each through a wrapper of its own, made in its realm:
     * an expando one world sets on its wrapper (React's __reactFiber$) is not
     * on the other's. With `host` (another node's record) it is in that
     * node's open shadow root. dispatchEvent on either wrapper sends the
     * event on it (see dispatch()). Returns { main, isolated, record }.
     */
    node({ host = null } = {}) {
      const record = { host, wrappers: {} };
      for (const name of ['main', 'isolated']) {
        const wrapper = vm.runInContext('({ parentElement: null })', worlds[name].realm);
        wrapper.dispatchEvent = (event) => dispatch(event, record);
        record.wrappers[name] = wrapper;
      }
      return { main: record.wrappers.main, isolated: record.wrappers.isolated, record };
    },
    /** Run code in a world: 'main' (the page's, and the collector's) or 'isolated'. */
    run(name, code, filename) {
      return vm.runInContext(code, worlds[name].realm, filename ? { filename } : undefined);
    },
    /** What a message from the panel to the tab is answered with, by the last bridge. */
    ask(type) {
      return new Promise((resolve, reject) => {
        if (!onMessage) reject(new Error('no bridge ever listened'));
        else onMessage({ type }, {}, (reply) => resolve(JSON.parse(JSON.stringify(reply))));
      });
    },
  };
}

const CONTROLLER = { 'content/overlay.js': 'region', 'content/picker.js': 'element' };

/** The file the worker queues a stop with, which takes either controller down. */
const STOP_FILE = 'content/stop.js';

/** The extension's own origin, which its pages send from and getURL('') names. */
export const EXTENSION_URL = 'chrome-extension://test-extension/';
export const PANEL_SENDER = { id: 'test-extension', url: `${EXTENSION_URL}sidepanel/panel.html` };

/** One tab's document, as far as the worker can see it. */
export class FakePage {
  /**
   * runs: each controller's start() makes a run id and the file injection
   * answers with it, as the real capture scripts do. Off by default, so a
   * test written before runs existed sees the entries it always saw.
   *
   * worlds: the page's two worlds (makeWorlds, given these options), where
   * the collector's files and the worker's functions run for real, each in
   * the world it is injected into. The capture controllers live in the
   * isolated one, as the capture scripts do.
   */
  constructor({ idle = true, url = 'https://example.test/', runs = false, worlds = null } = {}) {
    this.url = url;
    this.runs = runs;
    this.nextRun = 1;
    this.idle = idle; // has reached document_idle
    this.busy = false; // main thread blocked: nothing runs until resume()
    this.inbox = []; // arrived while busy, in arrival order
    this.waiting = []; // arrived, waiting for document_idle
    this.log = []; // what ran, in order
    if (worlds) {
      this.worlds = makeWorlds({ url, ...worlds });
      this.window = this.worlds.isolated.window;
      this.realm = this.worlds.isolated.realm;
      this.mainRealm = this.worlds.main.realm;
    } else {
      this.worlds = null;
      this.window = {};
      this.window.window = this.window;
      // Where the worker's listener for a late start goes (markLate), with
      // no collector here to hear it.
      this.window.addEventListener = () => {};
      this.window.removeEventListener = () => {};
      this.realm = vm.createContext(this.window);
      this.mainRealm = this.realm;
    }
    // A stop's promise settles on the second animation frame.
    this.window.requestAnimationFrame = (callback) => setImmediate(callback);
    this.window.setTimeout = () => 0;
  }

  /**
   * What Chrome does at document_start of a page the manifest declares the
   * collector for: both halves, each in its world, before any of the page's
   * own scripts.
   */
  declare() {
    this.worlds.run('isolated', COLLECTOR_FILES['content/collector-bridge.js'], 'content/collector-bridge.js');
    this.worlds.run('main', COLLECTOR_FILES['content/collector-main.js'], 'content/collector-main.js');
  }

  /** The mode live on the page, or null. */
  live() {
    if (this.window.__cdrRegionOverlay?.isActive()) return 'region';
    if (this.window.__cdrElementPicker?.isActive()) return 'element';
    return null;
  }

  controller(mode) {
    const key = mode === 'region' ? '__cdrRegionOverlay' : '__cdrElementPicker';
    const other = mode === 'region' ? '__cdrElementPicker' : '__cdrRegionOverlay';
    const page = this;
    this.window[key] ||= {
      active: false,
      run: undefined,
      start() {
        if (this.active) return this.run;
        page.window[other]?.stop();
        this.active = true;
        this.run = page.runs ? `run-${page.nextRun++}` : undefined;
        return this.run;
      },
      stop() {
        this.active = false;
      },
      isActive() {
        return this.active;
      },
    };
    return this.window[key];
  }

  arrive(injection) {
    if (this.busy) this.inbox.push(injection);
    else this.place(injection);
  }

  place(injection) {
    if (injection.immediate || this.idle) this.run(injection);
    else this.waiting.push(injection);
  }

  run(injection) {
    let result = null;
    try {
      if (injection.file === STOP_FILE) {
        this.window.__cdrRegionOverlay?.stop();
        this.window.__cdrElementPicker?.stop();
        this.log.push('stop');
      } else if (injection.file && CONTROLLER[injection.file]) {
        result = this.controller(CONTROLLER[injection.file]).start() ?? null;
        this.log.push(injection.file);
      } else if (injection.file && this.worlds && COLLECTOR_FILES[injection.file]) {
        this.worlds.run(injection.world === 'MAIN' ? 'main' : 'isolated', COLLECTOR_FILES[injection.file], injection.file);
        this.log.push(injection.file);
      } else if (injection.file) {
        // Any other file (the collector's halves, without the worlds) is only recorded.
        this.log.push(injection.file);
      } else {
        result = vm.runInContext(`(${injection.func})()`, injection.world === 'MAIN' ? this.mainRealm : this.realm);
        this.log.push(injection.kind);
      }
    } catch (error) {
      injection.reject(error);
      return;
    }
    Promise.resolve(result).then((value) => injection.resolve([{ result: value }]));
  }

  reachIdle() {
    this.idle = true;
    if (!this.busy) for (const injection of this.waiting.splice(0)) this.run(injection);
  }

  /** A navigation to another document: what was queued for this one is dropped. */
  navigate(url = this.url) {
    for (const injection of [...this.inbox.splice(0), ...this.waiting.splice(0)]) {
      injection.reject(new Error('Frame with ID 0 was removed.'));
    }
    this.url = url;
    this.idle = false;
    for (const key of Object.keys(this.window)) {
      if (key.startsWith('__cdr')) delete this.window[key];
    }
  }

  pause() {
    this.busy = true;
  }

  resume() {
    this.busy = false;
    for (const injection of this.inbox.splice(0)) this.place(injection);
    if (this.idle) for (const injection of this.waiting.splice(0)) this.run(injection);
  }
}

/**
 * Chrome's download list, as the worker's chrome.downloads sees it. Each
 * record is { id, state, filename, exists, byExtensionId? }, filename being
 * '' while a "Save as" dialog waits, as in Chrome. As Chrome 156 does it:
 * cancel() ends a download in progress as interrupted (USER_CANCELED) and
 * leaves any other as it is, removeFile() is refused for a download that is
 * not complete and leaves its record marked gone, and erase() takes the
 * record out of the list. `calls` lists every call as [name, id], in order.
 */
export function makeDownloads(records = []) {
  const list = new Map(records.map((record) => [record.id, { exists: true, ...record }]));
  const calls = [];
  return {
    records: list,
    calls,
    /** The calls of one kind, by id. */
    made(name) {
      return calls.filter(([each]) => each === name).map(([, id]) => id);
    },
    api: {
      async search({ id }) {
        calls.push(['search', id]);
        return list.has(id) ? [plain(list.get(id))] : [];
      },
      async cancel(id) {
        calls.push(['cancel', id]);
        const record = list.get(id);
        if (!record) throw new Error(`Invalid download id ${id}`);
        if (record.state === 'in_progress') Object.assign(record, { state: 'interrupted', error: 'USER_CANCELED' });
      },
      async removeFile(id) {
        calls.push(['removeFile', id]);
        const record = list.get(id);
        if (!record) throw new Error(`Invalid download id ${id}`);
        if (record.state !== 'complete') throw new Error('Download must be complete');
        record.exists = false;
      },
      async erase({ id }) {
        calls.push(['erase', id]);
        return list.delete(id) ? [id] : [];
      },
    },
  };
}

/**
 * @param {{
 *   pages?: Record<number, FakePage>,
 *   tabsGet?: (tabId: number) => Promise<object>,
 *   holdFiles?: boolean,
 *   downloads?: ReturnType<typeof makeDownloads>,
 *   storage?: Map<string, any>,
 *   setup?: (chrome: object) => void,
 * }} options  holdFiles keeps every file injection in the package read until
 *   releaseFiles(), so a test can send a function injection past one.
 *   downloads and storage are Chrome's download list and storage.local, new
 *   ones unless given. setup can change the chrome fake before the worker
 *   starts.
 */
export function loadWorker({
  pages = { 1: new FakePage() },
  tabsGet,
  holdFiles = false,
  downloads = makeDownloads(),
  storage = new Map(),
  setup = () => {},
} = {}) {
  const clock = makeClock();
  const listeners = { message: [], updated: [], removed: [], command: [], connect: [] };
  const broadcasts = [];
  const injections = []; // every executeScript call, in order
  const heldFiles = [];
  const accessLevels = []; // every storage.local.setAccessLevel call
  let dead = false;

  // After kill() nothing settles in the worker's realm: Chrome has thrown the
  // worker away, and the page goes on without anyone waiting on it.
  const toWorker = (promise) =>
    new Promise((resolve, reject) => {
      promise.then(
        (value) => !dead && resolve(value),
        (error) => !dead && reject(error)
      );
    });

  const chrome = {
    sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
    extension: { isAllowedFileSchemeAccess: async () => true },
    runtime: {
      id: PANEL_SENDER.id,
      // The real manifest, so a test sees the match patterns that ship.
      getManifest: () => JSON.parse(MANIFEST),
      getURL: (path = '') => `${EXTENSION_URL}${String(path).replace(/^\//, '')}`,
      lastError: undefined,
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onConnect: { addListener: (fn) => listeners.connect.push(fn) },
      sendMessage: (message) => {
        if (!dead) broadcasts.push(message);
        return Promise.resolve();
      },
    },
    storage: {
      local: {
        setAccessLevel: async (options) => {
          accessLevels.push(plain(options));
        },
        get: (keys) => {
          const out = {};
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            if (storage.has(key)) out[key] = plain(storage.get(key));
          }
          return toWorker(Promise.resolve(out));
        },
      },
    },
    // Every call answers only while the worker lives, as the others do.
    downloads: Object.fromEntries(
      Object.entries(downloads.api).map(([name, call]) => [name, (...args) => toWorker(call(...args))])
    ),
    tabs: {
      get: (tabId) =>
        toWorker(
          tabsGet
            ? tabsGet(tabId)
            : pages[tabId]
              ? Promise.resolve({ id: tabId, url: pages[tabId].url })
              : Promise.reject(new Error(`No tab with id: ${tabId}.`))
        ),
      onUpdated: { addListener: (fn) => listeners.updated.push(fn) },
      onRemoved: { addListener: (fn) => listeners.removed.push(fn) },
    },
    commands: { onCommand: { addListener: (fn) => listeners.command.push(fn) } },
    scripting: {
      executeScript: (details) => {
        const page = pages[details.target.tabId];
        const record = {
          tabId: details.target.tabId,
          file: details.files?.[0] || null,
          func: details.func || null,
          immediate: Boolean(details.injectImmediately),
          world: details.world || 'ISOLATED',
          // By what the function does, which is all a test can rely on.
          kind: details.files?.[0] === STOP_FILE
            ? 'stop'
            : details.files
            ? 'file'
            : /isActive/.test(String(details.func))
              ? 'probe'
              : /\.stop\(\)/.test(String(details.func))
                ? 'stop'
                : 'func',
        };
        injections.push(record);
        const done = new Promise((resolve, reject) => {
          if (!page) {
            reject(new Error(`No tab with id: ${details.target.tabId}.`));
            return;
          }
          const injection = { ...record, resolve, reject };
          if (!record.file) page.arrive(injection);
          else if (holdFiles) heldFiles.push(() => page.arrive(injection));
          else setImmediate(() => page.arrive(injection));
        });
        return toWorker(done);
      },
    },
  };

  setup(chrome);

  const context = vm.createContext({
    chrome,
    console,
    URL, // a worker has it, a bare node:vm realm does not
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  // Strict, as a module is. The worker exports nothing, so the trailing
  // expression is the only way in to the state the tests look at.
  const internals = vm.runInContext(
    `'use strict';${SOURCE}\n;({ armedByTab, latestArmByTab, landingsByTab, matchesPattern, ` +
      `matchesGlob: typeof matchesGlob === 'function' ? matchesGlob : undefined, ` +
      `collectorSiteDeclaredFor: typeof collectorSiteDeclaredFor === 'function' ? collectorSiteDeclaredFor : undefined })`,
    context,
    { filename: 'background.js' }
  );

  return {
    chrome,
    clock,
    pages,
    broadcasts,
    injections,
    internals,
    accessLevels,
    downloads,
    storage,
    /**
     * A message from a panel or a content script; resolves to the reply, if
     * any. From the panel unless a sender is given: a content script's names
     * its tab, and the page it runs on as its url.
     */
    send(message, sender = PANEL_SENDER) {
      return new Promise((resolve) => {
        let async = false;
        const reply = (value) => resolve(plain(value));
        for (const listener of listeners.message) {
          if (listener(message, sender, reply) === true) async = true;
        }
        if (!async) resolve(undefined);
      });
    },
    /** A reply, or 'pending' if it has not come by now. */
    async settled(promise) {
      const marker = Symbol('pending');
      const value = await Promise.race([promise, flush().then(() => marker)]);
      return value === marker ? 'pending' : value;
    },
    updated(tabId, changeInfo) {
      for (const listener of listeners.updated) listener(tabId, changeInfo, {});
    },
    releaseFiles() {
      for (const deliver of heldFiles.splice(0)) deliver();
    },
    kill() {
      dead = true;
    },
    /**
     * A port opened to the worker, as chrome.runtime.connect does from a
     * panel (or from `sender`). post() delivers a message to the worker's
     * side; close() is the panel going away; closed says whether the worker
     * shut it.
     */
    connect(name, sender = PANEL_SENDER) {
      const onMessage = [];
      const onDisconnect = [];
      const port = {
        name,
        sender,
        closed: false,
        onMessage: { addListener: (fn) => onMessage.push(fn) },
        onDisconnect: { addListener: (fn) => onDisconnect.push(fn) },
        postMessage() {},
        disconnect() {
          port.closed = true;
        },
      };
      for (const listener of listeners.connect) listener(port);
      return {
        get closed() {
          return port.closed;
        },
        post(message) {
          if (!dead && !port.closed) for (const fn of onMessage) fn(message, port);
        },
        close() {
          if (dead || port.closed) return;
          port.closed = true;
          for (const fn of onDisconnect) fn(port);
        },
      };
    },
  };
}
