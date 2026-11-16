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
 * page's, as executeScript does.
 *
 * Time is a fake clock the test moves, and Chrome stopping the worker is
 * kill(): nothing reaches the worker after it, while the pages carry on.
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../../background.js', import.meta.url), 'utf8');

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

const CONTROLLER = { 'content/overlay.js': 'region', 'content/picker.js': 'element' };

/** One tab's document, as far as the worker can see it. */
export class FakePage {
  constructor({ idle = true, url = 'https://example.test/' } = {}) {
    this.url = url;
    this.idle = idle; // has reached document_idle
    this.busy = false; // main thread blocked: nothing runs until resume()
    this.inbox = []; // arrived while busy, in arrival order
    this.waiting = []; // arrived, waiting for document_idle
    this.log = []; // what ran, in order
    this.window = {};
    this.window.window = this.window;
    // A stop's promise settles on the second animation frame.
    this.window.requestAnimationFrame = (callback) => setImmediate(callback);
    this.window.setTimeout = () => 0;
    this.realm = vm.createContext(this.window);
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
      start() {
        if (this.active) return;
        page.window[other]?.stop();
        this.active = true;
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
      if (injection.file) {
        this.controller(CONTROLLER[injection.file]).start();
        this.log.push(injection.file);
      } else {
        result = vm.runInContext(`(${injection.func})()`, this.realm);
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
 * @param {{
 *   pages?: Record<number, FakePage>,
 *   tabsGet?: (tabId: number) => Promise<object>,
 *   holdFiles?: boolean,
 * }} options  holdFiles keeps every file injection in the package read until
 *   releaseFiles(), so a test can send a function injection past one.
 */
export function loadWorker({ pages = { 1: new FakePage() }, tabsGet, holdFiles = false } = {}) {
  const clock = makeClock();
  const listeners = { message: [], updated: [], removed: [], command: [] };
  const broadcasts = [];
  const injections = []; // every executeScript call, in order
  const heldFiles = [];
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
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      sendMessage: (message) => {
        if (!dead) broadcasts.push(message);
        return Promise.resolve();
      },
    },
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
          // By what the function does, which is all a test can rely on.
          kind: details.files
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

  const context = vm.createContext({
    chrome,
    console,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  // Strict, as a module is. The worker exports nothing, so the trailing
  // expression is the only way in to the state the tests look at.
  const internals = vm.runInContext(
    `'use strict';${SOURCE}\n;({ armedByTab, latestArmByTab, landingsByTab })`,
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
    /** A message from a panel or a content script; resolves to the reply, if any. */
    send(message, sender = {}) {
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
  };
}
