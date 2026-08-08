/**
 * ISOLATED-world half of the collector.
 *
 * Has chrome.* access but cannot see the page's real console/fetch. Its whole
 * job is to relay: side panel -> here (chrome messaging) -> collector-main.js
 * (window.postMessage) -> back again.
 *
 * It also gathers the page facts that only need DOM access, which is available
 * in this world.
 */
(() => {
  'use strict';

  if (window.__cdrBridge) return;
  window.__cdrBridge = true;

  const REQUEST_TIMEOUT_MS = 1000;
  let nextId = 1;
  const pending = new Map();

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
   * Ask the MAIN world for its buffers. Resolves to null on timeout rather
   * than hanging, so a page where the MAIN script never ran (injected after
   * load, blocked, or a document type that does not execute scripts) still
   * produces a usable report instead of a spinner.
   */
  function askMainWorld(action) {
    return new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      window.postMessage({ __cdr: 'request', id, action }, '*');
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve(null);
        }
      }, REQUEST_TIMEOUT_MS);
    });
  }

  function pageInfo() {
    return {
      url: location.href,
      title: document.title,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
      },
      userAgent: navigator.userAgent,
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;

    if (message.type === 'cdr:get-context') {
      askMainWorld('snapshot').then((collected) => {
        sendResponse({
          ok: true,
          page: pageInfo(),
          collected: collected || { console: [], errors: [], network: [], unavailable: true },
        });
      });
      return true; // keep the response channel open for the async reply
    }

    if (message.type === 'cdr:clear-context') {
      askMainWorld('clear').then(() => sendResponse({ ok: true }));
      return true;
    }

    return false;
  });
})();
