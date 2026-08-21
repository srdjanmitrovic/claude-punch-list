/**
 * A stand-in for chrome.* so the side panel can run as an ordinary web page.
 *
 * Loaded by tools/panel-stage.html ahead of panel.js, inside the iframe that
 * hosts the panel. Nothing here ships with the extension; the build does not
 * include the tools directory.
 *
 * The shim keeps the real message protocol and answers it the way the worker
 * and content scripts would: cdr:arm injects the real overlay or picker into
 * the demo tab, cdr:get-context reaches the real collector through the real
 * bridge, captureVisibleTab asks the stage for a screenshot of the demo tab.
 * Only chrome.* itself is faked, so what the stage renders is the actual panel
 * doing its actual work.
 *
 * Storage writes fire storage.onChanged for the writer, as Chrome does. There
 * is only one panel on a stage, so a test that wants to play a second window's
 * panel writes to chrome.storage.local itself with a different writer id.
 */
(() => {
  'use strict';

  const TAB = { id: 1, windowId: 1 };
  const stage = window.parent !== window ? window.parent.__stage : null;
  const listeners = [];
  const storageListeners = [];
  const downloadListeners = [];
  const downloads = new Map();
  let nextDownloadId = 1;

  // getManifest is synchronous, so this has to be too.
  let manifest = { version: '0.0.0', name: 'Panel stage' };
  try {
    const request = new XMLHttpRequest();
    request.open('GET', new URL('../manifest.json', document.baseURI), false);
    request.send();
    if (request.status === 200) manifest = JSON.parse(request.responseText);
  } catch {
    /* stay with the placeholder */
  }

  // Survives the panel iframe being reloaded, which is how the stage simulates
  // the side panel being closed and reopened. Cleared by reloading the stage.
  const storage = stage ? stage.storage : {};

  function currentTab() {
    return {
      ...TAB,
      url: stage ? stage.tabUrl() : 'https://example.test/checkout',
      title: stage ? stage.tabTitle() : 'Example',
    };
  }

  function placeholderCapture() {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const context = canvas.getContext('2d');
    context.fillStyle = '#e8e8ec';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#6e6e78';
    context.font = '28px ui-monospace, Menlo, monospace';
    context.fillText('stage capture (no screenshot provider)', 40, 80);
    return canvas.toDataURL('image/png');
  }

  window.chrome = {
    runtime: {
      getManifest: () => manifest,
      onMessage: {
        addListener(fn) {
          listeners.push(fn);
        },
      },
      async sendMessage(message) {
        switch (message?.type) {
          case 'cdr:check-tab':
            return { ok: true, restriction: null, armedMode: null };
          case 'cdr:arm':
            if (stage) await stage.arm(message.mode);
            return { ok: true };
          case 'cdr:disarm':
            if (stage) await stage.disarm();
            return { ok: true };
          default:
            return undefined;
        }
      },
    },

    tabs: {
      async query() {
        return [currentTab()];
      },
      async sendMessage(_tabId, message) {
        if (!stage) throw new Error('Could not establish connection. Receiving end does not exist.');
        return stage.sendToTab(message);
      },
      async captureVisibleTab() {
        return stage ? stage.capture() : placeholderCapture();
      },
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
    },

    downloads: {
      async download({ filename }) {
        const id = nextDownloadId++;
        const dir = stage ? stage.downloadsDir() : '/Users/you/Downloads/';
        const record = { id, state: 'in_progress', filename: '', exists: true };
        downloads.set(id, record);
        // Real downloads take a moment, and a "Save as" dialog can take
        // minutes. The stage's delay makes the SAVING state visible.
        setTimeout(() => {
          record.state = 'complete';
          record.filename = `${dir}${filename}`;
        }, stage ? stage.saveDelay() : 0);
        return id;
      },
      async search({ id }) {
        return downloads.has(id) ? [{ ...downloads.get(id) }] : [];
      },
      show() {},
      async removeFile() {},
      async erase() {},
      onChanged: {
        addListener(fn) {
          downloadListeners.push(fn);
        },
      },
    },

    storage: {
      onChanged: {
        addListener(fn) {
          storageListeners.push(fn);
        },
      },
      local: {
        async get(keys) {
          const wanted = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of wanted) {
            if (key in storage) out[key] = JSON.parse(storage[key]);
          }
          return out;
        },
        async set(values) {
          const changes = {};
          for (const [key, value] of Object.entries(values)) {
            const next = JSON.stringify(value);
            if (storage[key] === next) continue;
            changes[key] = { newValue: value };
            if (key in storage) changes[key].oldValue = JSON.parse(storage[key]);
            storage[key] = next;
          }
          notifyStorage(changes);
        },
        async remove(keys) {
          const changes = {};
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            if (!(key in storage)) continue;
            changes[key] = { oldValue: JSON.parse(storage[key]) };
            delete storage[key];
          }
          notifyStorage(changes);
        },
      },
    },
  };

  // Like Chrome, the writer hears its own change too, asynchronously.
  function notifyStorage(changes) {
    if (!Object.keys(changes).length) return;
    setTimeout(() => {
      for (const fn of storageListeners) fn(changes, 'local');
    }, 0);
  }

  // What the stage uses to deliver a content script's broadcast to the panel,
  // and what a test uses to stand in for the rest of Chrome.
  window.__shim = {
    broadcast(message, sender = { tab: TAB }) {
      for (const fn of listeners) fn(message, sender, () => {});
    },
    /** Pretend Chrome noticed something about a download, e.g. { id, exists: { current: false } }. */
    downloadChanged(delta) {
      for (const fn of downloadListeners) fn(delta);
    },
  };
})();
