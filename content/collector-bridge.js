/**
 * ISOLATED-world half of the collector.
 *
 * Has chrome.* access but cannot see the page's real console/fetch. Its whole
 * job is to relay: side panel -> here (chrome messaging) -> collector-main.js
 * (a channel of events on the window, see below) -> back again.
 *
 * It also gathers the page facts that only need DOM access, which is available
 * in this world.
 */
(() => {
  'use strict';

  // Re-injection guard, which only a live bridge may hold. The worker injects
  // this file into a tab where nothing answers the panel (cdr:collect), and
  // the commonest such tab has a bridge from before the extension was
  // reloaded: Chrome does not run it again in open tabs, the old one can no
  // longer hear the extension, and its mark may still be on this window. So
  // the mark says whether its bridge is alive, by the extension context that
  // bridge was given, read when it was installed. A mark from an older build
  // is a plain true and says nothing, and is replaced.
  try {
    if (window.__cdrBridge?.alive?.()) return;
  } catch {
    /* a mark that cannot answer belongs to no live bridge */
  }
  const runtime = chrome.runtime;
  window.__cdrBridge = {
    alive: () => {
      try {
        return Boolean(runtime.id);
      } catch {
        return false;
      }
    },
  };

  // The log is read over a channel of this bridge's own: a pair of event
  // types on the window, named with a random part, so that only the collector
  // it is handed to listens for them. It used to be read over
  // window.postMessage, which hands every message to every message listener
  // on the page, a third party's included: each read gave all of them the
  // page's console text, failed request URLs and stacks, and let any of them
  // answer in the collector's place.
  //
  // The name is handed over in a HELLO event. Whichever half arrives second
  // speaks first: the bridge says HELLO as it starts, and again when the
  // collector says it has arrived, so the order Chrome runs the two in, at
  // document_start or when the extension injects them into an open tab,
  // does not matter. Dispatch is synchronous across the two worlds, so a
  // request is answered before dispatchEvent returns.
  //
  // The collector's HELLO is answered only until the channel has carried one
  // answered request, and the bridge asks once as it speaks, so the pair is
  // made at once. Any page script can say what the collector says, and was
  // told the channel every time it asked, then read every snapshot over it
  // and answer in the collector's place. At document_start the pair is made
  // before the page has run a line, so it is told nothing. Injected into a
  // page already open, the bridge has to say its HELLO where a page listener
  // can hear it; see the end of collector-main.js for what that leaves open.
  const HELLO = '__cdr_hello';
  const CHANNEL = (() => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    let hex = '';
    for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
    return `__cdr_${hex}`;
  })();
  let paired = false;

  function sayHello() {
    window.dispatchEvent(new CustomEvent(HELLO, { detail: `bridge ${CHANNEL}` }));
    // Answered with nothing by a collector of this build that heard it.
    try {
      askOverChannel('ping');
    } catch {
      /* unpaired, so the collector's HELLO is still answered */
    }
  }

  window.addEventListener(HELLO, (event) => {
    if (event.detail === 'main' && !paired) sayHello();
  });
  sayHello();

  /**
   * Ask the collector over the channel. Answers undefined when nothing
   * answered at all, which is a collector from 0.5.0 or earlier, or none.
   * The first answer is the one kept: the collector's listener went on at
   * document_start, before any of the page's could.
   */
  function askOverChannel(action) {
    let answered = false;
    let reply;
    const take = (event) => {
      if (answered) return;
      answered = true;
      reply = event.detail;
    };
    window.addEventListener(`${CHANNEL}:reply`, take);
    try {
      window.dispatchEvent(new CustomEvent(CHANNEL, { detail: action }));
    } finally {
      window.removeEventListener(`${CHANNEL}:reply`, take);
    }
    if (answered) paired = true;
    return answered ? reply : undefined;
  }

  // A collector from 0.5.0 or earlier keeps running in a tab that was open
  // when the extension updated, since Chrome does not take a MAIN world
  // script out of a page, and it answers only window.postMessage. It is
  // asked that way only when the channel is silent, so a page with a
  // collector of this build never has its log posted to the window.
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
   * Resolves to null on timeout rather than hanging, so a page where the MAIN
   * script never ran (injected after load, blocked, or a document type that
   * does not execute scripts) still produces a usable report instead of a
   * spinner.
   */
  function askOverMessage(action) {
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

  async function askMainWorld(action) {
    const reply = askOverChannel(action);
    return reply === undefined ? askOverMessage(action) : reply;
  }

  // ------------------------------------------------------------- rebuild ---
  // The reply comes from the page's world, where any script can answer for
  // the collector, and it goes into stored items and into a prompt. So it is
  // never forwarded as it came: it is rebuilt here from the fields the panel
  // and the template read, each checked for its type and cut to the most a
  // collector of this build ever sends, as picker.js does with the reply to
  // its inspect. A page can still put words in it, since it controls its own
  // console, but not a shape or a size the panel was not written for.
  const RING_LIMIT = 30; // LIMIT in collector-main.js
  const CALLER_LIMIT = 3; // CALLER_LIMIT in collector-main.js
  const CALLER_MAX = 200; // CALLER_MAX_STRING in collector-main.js
  // Longest string of each kind: MAX_STRING (600) with the cut marker, and a
  // console line, which joins up to ten arguments of MAX_STRING each.
  const STRING_FIELDS = {
    level: 8,
    kind: 32,
    text: 6100,
    where: 700,
    stack: 700,
    method: 700,
    url: 700,
    statusText: 700,
    via: 8,
    outcome: 16,
  };
  const NUMBER_FIELDS = ['status', 'ms', 't', 'seq'];
  const RINGS = ['console', 'warnings', 'errors', 'network'];

  function entryOf(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const entry = {};
    for (const [field, max] of Object.entries(STRING_FIELDS)) {
      const value = raw[field];
      if (typeof value === 'string') entry[field] = value.slice(0, max);
    }
    for (const field of NUMBER_FIELDS) {
      const value = raw[field];
      if (typeof value === 'number' && Number.isFinite(value)) entry[field] = value;
    }
    if (Array.isArray(raw.caller)) {
      const caller = raw.caller
        .slice(0, CALLER_LIMIT)
        .filter((frame) => typeof frame === 'string')
        .map((frame) => frame.slice(0, CALLER_MAX));
      if (caller.length) entry.caller = caller;
    }
    return entry;
  }

  function ringOf(raw) {
    if (!Array.isArray(raw)) return [];
    // The newest, as the collector's own ring keeps them.
    return raw.slice(-RING_LIMIT).map(entryOf).filter(Boolean);
  }

  function rebuild(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const collected = {};
    for (const ring of RINGS) collected[ring] = ringOf(raw[ring]);
    const dropped = {};
    for (const ring of RINGS) {
      const count = raw.dropped && typeof raw.dropped === 'object' ? raw.dropped[ring] : 0;
      dropped[ring] = typeof count === 'number' && Number.isFinite(count) && count > 0 ? count : 0;
    }
    collected.dropped = dropped;
    if (typeof raw.armedAt === 'number' && Number.isFinite(raw.armedAt)) {
      collected.armedAt = raw.armedAt;
    }
    // The collector started after the page had begun to run, so the log
    // holds nothing from before armedAt. Only a true is kept: a collector
    // that does not say so started at document_start, as every collector of
    // 0.5.0 and earlier did.
    if (raw.late === true) collected.late = true;
    return collected;
  }

  /**
   * What the prompt says about the page. The scroll position and the user
   * agent were collected here too, and stored with every item, and nothing
   * ever read them (TR12).
   */
  function pageInfo() {
    return {
      url: location.href,
      title: document.title,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
      },
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;

    if (message.type === 'cdr:get-context') {
      askMainWorld('snapshot')
        .catch(() => null)
        .then((reply) => {
          sendResponse({
            ok: true,
            page: pageInfo(),
            collected: rebuild(reply) || {
              console: [],
              errors: [],
              network: [],
              unavailable: true,
            },
          });
        });
      return true; // keep the response channel open for the async reply
    }

    if (message.type === 'cdr:clear-context') {
      askMainWorld('clear')
        .catch(() => null)
        .then(() => sendResponse({ ok: true }));
      return true;
    }

    return false;
  });
})();
