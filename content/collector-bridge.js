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
  const alive = () => {
    try {
      return Boolean(runtime.id);
    } catch {
      return false;
    }
  };
  window.__cdrBridge = { alive };

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

  // The panel's ports for the counts (see watchCounts), and where they stand.
  const counting = new Set();
  let watched = false; // the collector said it is watching for this bridge
  let lastCounts = null; // the counts last posted, so the same are not posted again
  let countsTimer = 0;
  let countsDue = false; // a ring grew while the timer ran

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
    if (event.detail === 'main' && !paired) {
      sayHello();
      // A panel that connected before this collector arrived.
      if (paired) watchCounts();
    }
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

  // -------------------------------------------------------------- counts ---
  // The panel's console and network chips follow the log while the panel is
  // open on this tab. It holds a port here for as long as this tab is the one
  // in view (chrome.tabs.connect, named cdr:counts) and the panel is shown.
  // This end hears the panel close the port, or close with it, but not the
  // two other ways a port ends, which are seen to below: the page going into
  // the back/forward cache, and the extension being reloaded. With no port
  // open nothing below runs: the collector is not watching, and a log line
  // costs it one comparison more than before.
  //
  // With one open, the collector tells this bridge, over its channel, when a
  // ring has grown (see countsChanged in collector-main.js), and says it once
  // until this bridge has asked for the counts. This bridge asks on a timer
  // of its own world, at once and then at most every COUNTS_GAP_MS, and posts
  // two numbers to the port only when they differ from the last it posted.
  // Each read of the panel's asks too, and posts what it finds (recount). A
  // page that logs without pause costs four asks a second, and one whose
  // rings are full costs nothing, since a full ring does not grow. Nothing
  // but the two numbers is posted, so the port carries none of the log.
  const COUNTS_PORT = 'cdr:counts';
  const COUNTS_GAP_MS = 250;
  // The most each count can be: three rings of RING_LIMIT and one.
  const CONSOLE_MAX = 90;
  const NETWORK_MAX = 30;

  /** The two counts from the page's world, checked, or null. */
  function countsOf(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const consoleCount = raw.console;
    const networkCount = raw.network;
    if (!Number.isInteger(consoleCount) || !Number.isInteger(networkCount)) return null;
    if (consoleCount < 0 || networkCount < 0) return null;
    return { console: Math.min(consoleCount, CONSOLE_MAX), network: Math.min(networkCount, NETWORK_MAX) };
  }

  function postCounts(counts, ports) {
    lastCounts = counts;
    for (const port of ports) {
      try {
        port.postMessage({ type: 'cdr:counts', console: counts.console, network: counts.network });
      } catch {
        counting.delete(port); // closed under it
      }
    }
  }

  /** Ask for the counts and post them if they changed; null when nothing answered. */
  function sendCounts() {
    let counts = null;
    try {
      counts = countsOf(askOverChannel('counts'));
    } catch {
      /* posted at the next change */
    }
    if (counts && (!lastCounts || counts.console !== lastCounts.console || counts.network !== lastCounts.network)) {
      postCounts(counts, counting);
    }
  }

  /** Ask the collector to watch, once a port is open and a collector answers. */
  function watchCounts() {
    if (watched || !counting.size) return;
    let counts = null;
    try {
      counts = countsOf(askOverChannel('watch'));
    } catch {
      /* a collector of an earlier build, or none: the panel reads as it did */
    }
    if (!counts) return;
    watched = true;
    postCounts(counts, counting);
  }

  /**
   * At each of the panel's reads, and at Clear: the collector is asked to
   * 'watch' again, which also has it say the next change, and the counts go
   * to the ports as they are, whatever was posted last. The collector says a
   * change once until it is asked, so a signal lost on the way left the
   * chips standing for as long as the port lived, and the panel cannot take
   * them from a read's reply, which Chrome does not keep in order with the
   * port's posts. Posted here, they are. A signal is lost when the page logs
   * with its stack all but used up, and on a page already open when the
   * extension started there, a page script that heard this bridge's HELLO
   * can ask to 'unwatch' on this channel. Either way the next read sets the
   * chips right, and they follow the log again. Never throws: the read's
   * reply goes after it.
   */
  function recount() {
    try {
      if (!counting.size) return;
      if (!watched) {
        watchCounts();
        return;
      }
      const counts = countsOf(askOverChannel('watch'));
      if (counts) postCounts(counts, counting);
    } catch {
      /* posted at the next change, or the next read */
    }
  }

  function unwatchCounts() {
    // Closed, not only dropped: the panel hears it, and takes the counts
    // from its reads again, which no longer post here.
    for (const port of counting) {
      try {
        port.disconnect();
      } catch {
        /* already closed */
      }
    }
    counting.clear();
    clearTimeout(countsTimer);
    countsTimer = 0;
    countsDue = false;
    lastCounts = null;
    if (!watched) return;
    watched = false;
    try {
      askOverChannel('unwatch');
    } catch {
      /* the collector goes on saying so, to a bridge that does nothing with it */
    }
  }

  function countsTick() {
    countsTimer = 0;
    if (!counting.size) return;
    countsDue = false;
    // The gap, after which a change seen meanwhile is asked for. Set before
    // the ask, so that a change said during it waits for the gap too: a page
    // that answers in the collector's place and says a change as it answers
    // had each ask set a timer of its own, which this one then overwrote.
    countsTimer = setTimeout(() => {
      countsTimer = 0;
      if (countsDue) countsTick();
    }, COUNTS_GAP_MS);
    sendCounts();
  }

  // Nothing is asked from here: the collector is in the middle of recording.
  // Guarded: a page that logs on its way back from a stack overflow has the
  // collector say so with all but no stack left, and this failed in the
  // middle, which Chrome reported in the tab as an uncaught error of the
  // extension's. The change is then asked for at the panel's next read (see
  // recount).
  window.addEventListener(`${CHANNEL}:changed`, () => {
    try {
      if (countsTimer) countsDue = true;
      // A bridge the extension has been reloaded under can post to nobody,
      // and in Chrome 156 its ports' onDisconnect never fires. Seen to as
      // the timer fires, not now: a page that sends this event itself (on a
      // late start, see recount) had a port that opened meanwhile dropped.
      else countsTimer = setTimeout(() => (counting.size && alive() ? countsTick() : unwatchCounts()), 0);
    } catch {
      /* asked at the next read */
    }
  });

  // A page going into the back/forward cache has its ports closed by Chrome,
  // and in Chrome 156 this end hears nothing of it: no onDisconnect, and a
  // post to such a port does not throw. Kept, one went on making the
  // collector say every change, to nobody, after the panel closed. So they
  // are closed here first, which the panel hears at once, and which leaves
  // no port to a cached page in a Chrome before 123, where a message to one
  // evicted the page from the cache. Restored, the page is a new page to the
  // panel, which connects again. Only the browser's own pagehide: one a page
  // script sends would stop the counts.
  window.addEventListener('pagehide', (event) => {
    if (event.isTrusted) unwatchCounts();
  });

  try {
    runtime.onConnect.addListener((port) => {
      if (port.name !== COUNTS_PORT) return;
      // Only the extension's own pages can connect to a content script, but a
      // port from anything else would be asking for what it may not have.
      if (port.sender?.id !== runtime.id) {
        port.disconnect();
        return;
      }
      counting.add(port);
      port.onDisconnect.addListener(() => {
        void runtime.lastError;
        counting.delete(port);
        if (!counting.size) unwatchCounts();
      });
      if (!watched) {
        watchCounts();
        return;
      }
      // Asked again, not the counts last posted: those may have been posted
      // to a port that was gone.
      let counts = null;
      try {
        counts = countsOf(askOverChannel('counts'));
      } catch {
        /* posted at the next change */
      }
      if (counts) postCounts(counts, counting);
    });
  } catch {
    /* no ports here: the chips are read as they were before */
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
          recount();
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
        .then(() => {
          // The user's own click, so the zeros go out now.
          recount();
          sendResponse({ ok: true });
        });
      return true;
    }

    return false;
  });
})();
