/**
 * Service worker.
 *
 * Deliberately thin. The side panel is a real document, so it can call
 * chrome.tabs, chrome.downloads and canvas APIs directly; routing those through
 * here would only add a hop. What lives here is the work that must survive the
 * panel being closed: side-panel behaviour, the keyboard command, and injecting
 * the capture scripts.
 *
 * Message protocol
 * ----------------
 * panel      -> worker   cdr:arm            { mode: 'region'|'element', tabId, armId }
 * worker     -> panel    cdr:armed          { mode, tabId, armId } (armId absent for the shortcut)
 * panel      -> worker   cdr:disarm         { tabId } -> { ok, superseded }
 * panel      -> worker   cdr:verify         { tabId } -> { ok, mode }
 * panel      -> worker   cdr:check-tab      { tabId } -> { ok, restriction, armedMode, armId }
 * content    -> *        cdr:region-selected { rect, viewport }
 * content    -> *        cdr:element-picked  { rect, viewport, element }
 * content    -> *        cdr:capture-cancelled { mode }
 * panel      -> content  cdr:get-context     (handled by collector-bridge.js)
 * panel      -> content  cdr:clear-context   (handled by collector-bridge.js)
 *
 * The cdr:* messages sent by content scripts are broadcast to every extension
 * context, so the side panel listens for them directly instead of having the
 * worker relay them.
 */

const CAPTURE_SCRIPTS = {
  region: 'content/overlay.js',
  element: 'content/picker.js',
};

// Pages where Chrome forbids script injection and tab capture. Detecting these
// up front produces a clear message instead of an opaque platform error.
const RESTRICTED = /^(chrome|edge|brave|about|devtools|chrome-extension|moz-extension|view-source|data):/i;
const RESTRICTED_HOSTS = ['chrome.google.com/webstore', 'chromewebstore.google.com'];

/**
 * Why this takes the tab rather than a URL: Chrome withholds tab.url entirely
 * for pages the extension has no host permission for, so an absent URL is
 * itself the signal that the page is off limits. Telling the user to reload
 * (the obvious reading of "no URL yet") would send them in a loop.
 *
 * @returns {Promise<string|null>} a user-facing explanation, or null if fine
 */
async function restrictionFor(tab) {
  const url = tab?.url || tab?.pendingUrl;

  if (!url) {
    // A withheld URL is the ONLY signal a blocked file:// tab gives: without
    // file access the extension has no host permission for it, so tab.url and
    // tab.pendingUrl are both empty and it is indistinguishable from a
    // chrome:// page. That makes this, not the file:// branch below, the place
    // the "enable file access" hint has to live.
    const fileAccess = await chrome.extension.isAllowedFileSchemeAccess();
    return fileAccess
      ? 'Chrome does not let extensions read this page. Open a normal http(s) page.'
      : 'Chrome does not let extensions read this page. If it is a local file, enable ' +
          '"Allow access to file URLs" for this extension on chrome://extensions. ' +
          'Otherwise open a normal http(s) page.';
  }
  if (RESTRICTED.test(url)) {
    return 'Chrome blocks extensions on internal pages. Open a normal http(s) page.';
  }
  if (RESTRICTED_HOSTS.some((host) => url.includes(host))) {
    return 'Chrome blocks extensions on the Web Store. Open a normal http(s) page.';
  }
  // A visible file:// URL means access is already granted, so nothing to warn
  // about; the ungranted case is handled by the !url branch above.
  return null;
}

/**
 * Which tab currently has a capture overlay waiting, so a side panel opening
 * after the fact can show it.
 *
 * A one-shot broadcast is not enough on its own: Alt+Shift+C opens the panel
 * and arms the page together, and the panel document may not exist yet when the
 * broadcast goes out. The panel reads this during its normal cdr:check-tab call.
 *
 * If the worker is evicted this map is lost, which degrades correctly: the
 * button simply shows unarmed, and clicking it arms afresh rather than
 * cancelling.
 *
 * Each entry is { mode, armId }, the armId being the panel's for that arm (none
 * for the shortcut), so a panel can refuse to adopt an arm it has cancelled.
 */
const armedByTab = new Map();

/*
 * Ordering an arm against the disarm that cancels it happens here, because
 * only the worker sees every request in the order it was made. A panel hears
 * of the shortcut's arm only through a broadcast, which goes out when that arm
 * lands, so a cancel the panel sends may know nothing of it. The rule is order
 * alone: a disarm cancels every arm asked for on that tab before it, whichever
 * one the panel thought it was cancelling, and an arm asked for after it
 * stands.
 */

/** The newest arm asked for on each tab, so a disarm can tell if one came after it. */
const latestArmByTab = new Map();

/** Injections of capture scripts still on their way to each tab. */
const landingsByTab = new Map();

/**
 * Disarms per tab, counted. An arm takes the count when it is asked for; if
 * the count has moved by the time it would inject, or by the time it has
 * landed, a disarm came after it, and it neither goes ahead nor records
 * itself as live.
 */
const disarmsByTab = new Map();

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('[cdr] setPanelBehavior failed', error));

const disarmedSince = (tabId, count) => (disarmsByTab.get(tabId) || 0) !== count;

function trackLanding(tabId, landing) {
  let landings = landingsByTab.get(tabId);
  if (!landings) landingsByTab.set(tabId, (landings = new Set()));
  landings.add(landing);
  landing.finally(() => landings.delete(landing)).catch(() => {});
}

async function arm(mode, tabId, armId) {
  const file = CAPTURE_SCRIPTS[mode];
  if (!file) throw new Error(`Unknown capture mode: ${mode}`);
  const disarms = disarmsByTab.get(tabId) || 0;
  latestArmByTab.set(tabId, Symbol('arm'));

  const tab = await chrome.tabs.get(tabId);
  const restriction = await restrictionFor(tab);
  if (restriction) throw new Error(restriction);

  // Cancelled before anything reached the page, so there is nothing to put
  // there and nothing to take down.
  if (disarmedSince(tabId, disarms)) return { ok: true };

  // executeScript re-runs the file on every call. Both capture scripts are
  // written to be idempotent: they cache their controller on window and only
  // call start() again.
  const landing = chrome.scripting.executeScript({
    target: { tabId },
    files: [file],
  });
  trackLanding(tabId, landing);
  await landing;

  // Cancelled while landing. The disarm stops it now that it is there.
  if (disarmedSince(tabId, disarms)) return { ok: true };

  armedByTab.set(tabId, { mode, armId });

  // Tell any panel that is already listening. Without this the keyboard
  // shortcut would leave the page showing a crosshair while the panel's button
  // sits unlit, and the next click on that button would read as a cancel. A
  // panel that opens later picks the same state up via cdr:check-tab instead.
  // The panel that asked hears this too. armId lets it tell the echo of an arm
  // it has since cancelled from a new one.
  chrome.runtime.sendMessage({ type: 'cdr:armed', mode, tabId, armId }).catch(() => {});

  return { ok: true };
}

/** Take down whatever is armed on a tab, and every arm asked for there so far. */
async function disarm(tabId) {
  const latest = latestArmByTab.get(tabId);
  disarmsByTab.set(tabId, (disarmsByTab.get(tabId) || 0) + 1);
  armedByTab.delete(tabId);

  // Arms still landing go first. A file injection is read from the package
  // before it is sent to the page and a function injection is not, so a stop
  // sent now could reach the page ahead of the overlay it is meant to remove.
  const landings = landingsByTab.get(tabId);
  if (landings?.size) await Promise.allSettled([...landings]);

  // An arm asked for while this waited came after the cancel. It lands after
  // the ones cancelled, and its start() takes the page over, stopping the
  // other mode if need be, so the page is left to it. The reply says so: a
  // Screen capture waiting on it must not read it as a page without overlay.
  if (latestArmByTab.get(tabId) !== latest) return { ok: true, superseded: true };

  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      window.__cdrRegionOverlay?.stop();
      window.__cdrElementPicker?.stop();
      // Settles once the page has painted a frame without the overlay, so a
      // Screen capture that waits on this reply cannot photograph it.
      // executeScript waits for a returned promise. The timer is there for a
      // tab in the background, which runs no animation frames; Chrome may
      // stretch it to a second there, and a frozen tab runs neither. Nothing
      // waits on that case: the overlay is already gone, removed above.
      return new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
        setTimeout(() => resolve(true), 150);
      });
    },
  });
  // The stop ran, but an arm asked for since may be landing behind it.
  return { ok: true, superseded: latestArmByTab.get(tabId) !== latest };
}

/**
 * Which capture mode is live on a tab, asked of the page rather than inferred.
 *
 * Chrome reports a same document navigation (pushState, replaceState, a hash
 * change) as status 'loading', just as it does a real one, and only the real
 * one takes the overlay with it. Arms still landing go first, so an arm that
 * lands in a document on its way out is seen to be gone, and one that lands in
 * the page that stays is seen to be live. injectImmediately, so a page that is
 * still loading answers now rather than at document_idle.
 *
 * Drops the tab's entry from armedByTab when nothing is live, unless an arm
 * has replaced it meanwhile.
 *
 * @returns {Promise<'region'|'element'|null>}
 */
async function verifyArmed(tabId) {
  const landings = landingsByTab.get(tabId);
  if (landings?.size) await Promise.allSettled([...landings]);
  const entry = armedByTab.get(tabId);

  let mode = null;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      injectImmediately: true,
      func: () => {
        if (window.__cdrRegionOverlay?.isActive?.()) return 'region';
        if (window.__cdrElementPicker?.isActive?.()) return 'element';
        return null;
      },
    });
    mode = result?.result ?? null;
  } catch {
    // A tab that is gone, or now shows a page Chrome will not script, has no
    // overlay on it either.
  }

  if (!mode && armedByTab.get(tabId) === entry) armedByTab.delete(tabId);
  return mode;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  if (message.type === 'cdr:arm') {
    arm(message.mode, message.tabId, message.armId).then(sendResponse, (error) =>
      sendResponse({ ok: false, error: error?.message || String(error) })
    );
    return true;
  }

  if (message.type === 'cdr:disarm') {
    disarm(message.tabId).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === 'cdr:verify') {
    verifyArmed(message.tabId).then(
      (mode) => sendResponse({ ok: true, mode }),
      () => sendResponse({ ok: false })
    );
    return true;
  }

  if (message.type === 'cdr:check-tab') {
    chrome.tabs
      .get(message.tabId)
      .then(restrictionFor)
      .then(
        (restriction) =>
          sendResponse({
            ok: true,
            restriction,
            armedMode: armedByTab.get(message.tabId)?.mode || null,
            armId: armedByTab.get(message.tabId)?.armId || null,
          }),
        (error) => sendResponse({ ok: false, error: error?.message || String(error) })
      );
    return true;
  }

  // A capture finishing or being cancelled ends the armed state. These are
  // broadcasts aimed at the panel; the worker only observes them to keep
  // armedByTab honest for a panel that opens later.
  if (
    message.type === 'cdr:region-selected' ||
    message.type === 'cdr:element-picked' ||
    message.type === 'cdr:capture-cancelled'
  ) {
    if (sender?.tab?.id != null) armedByTab.delete(sender.tab.id);
    return false;
  }

  return false;
});

// Keep armedByTab from going stale or growing without bound. A navigation to
// another document destroys the injected overlay, one within the document does
// not, and Chrome reports both as 'loading' (see verifyArmed). 'complete' is
// checked too, for a navigation whose old document answered the first check
// before it was replaced. A closed tab can never be armed again.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading' && changeInfo.status !== 'complete') return;
  if (!armedByTab.has(tabId) && !landingsByTab.get(tabId)?.size) return;
  verifyArmed(tabId).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  armedByTab.delete(tabId);
  disarmsByTab.delete(tabId);
  latestArmByTab.delete(tabId);
  landingsByTab.delete(tabId);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'capture-region' || !tab?.id) return;

  // sidePanel.open() must be the FIRST statement, before any await. A service
  // worker's user interaction scope ends at the first await, and open() throws
  // "may only be called in response to a user gesture" once it is gone. The tab
  // arrives as the listener's second argument precisely so no lookup is needed
  // here; awaiting chrome.tabs.query first would break the shortcut entirely.
  chrome.sidePanel
    .open({ tabId: tab.id })
    .catch((error) => console.error('[cdr] could not open side panel', error));

  // arm() may await freely: only open() depends on the gesture.
  arm('region', tab.id).catch((error) => console.error('[cdr] shortcut failed', error));
});
