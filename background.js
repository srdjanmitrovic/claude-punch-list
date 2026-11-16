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

/**
 * How long a disarm waits for arms still landing before it answers anyway.
 * An arm lands when the page reaches document_idle, which a page still
 * streaming its HTML may not do for a long time, or at all, and a Screen
 * capture waiting on the answer would otherwise sit out its own 3 s bound and
 * warn about an overlay the page never drew. Well under that bound, so the
 * stop that follows still has time to answer within it.
 */
const LANDING_WAIT_MS = 1000;

/**
 * Probes of the page per tab: { running, next }, the probe asking the page
 * now and the one queued to start after it. See verifyArmed.
 */
const probesByTab = new Map();

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

/** Whether every one of the promises settled within `ms`. Never rejects. */
function settledWithin(promises, ms) {
  let timer;
  return Promise.race([
    Promise.allSettled(promises).then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function arm(mode, tabId, armId) {
  const file = CAPTURE_SCRIPTS[mode];
  if (!file) throw new Error(`Unknown capture mode: ${mode}`);
  const disarms = disarmsByTab.get(tabId) || 0;
  const request = Symbol('arm');
  latestArmByTab.set(tabId, request);
  const replaced = () => latestArmByTab.get(tabId) !== request;

  // Tracked from here, not from the injection. A verify that arrives while
  // this still looks the tab up would otherwise probe a page the overlay has
  // not reached yet, answer that nothing is armed, and turn the panel's button
  // dark over the overlay that lands a moment later.
  const landing = (async () => {
    const tab = await chrome.tabs.get(tabId);
    const restriction = await restrictionFor(tab);
    if (restriction) throw new Error(restriction);

    // Cancelled before anything reached the page, so there is nothing to put
    // there and nothing to take down.
    if (disarmedSince(tabId, disarms)) return false;

    // Replaced before anything reached the page. Each arm's lookups above
    // take as long as Chrome takes to answer them, so an older arm answered
    // late would otherwise inject after the newer one and take the page back
    // from it. The newer arm puts its own mode on the page, stopping the
    // other one if need be, so dropping this one loses nothing.
    if (replaced()) return false;

    // executeScript re-runs the file on every call. Both capture scripts are
    // written to be idempotent: they cache their controller on window and
    // only call start() again.
    await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
    return true;
  })();
  trackLanding(tabId, landing);
  if (!(await landing)) return { ok: true };

  // Cancelled while landing. The disarm's stops are usually behind it, but a
  // file Chrome took longer than the disarm's bounded wait to read from the
  // package lands after all of them, and nothing else would take it down. So
  // it stops itself: the page has run it, so it is past document_idle and
  // runs the stop at once. Not when a newer arm was asked for, whose start()
  // takes the page over and which this stop could otherwise end.
  if (disarmedSince(tabId, disarms)) {
    if (!replaced()) queueStop(tabId);
    return { ok: true };
  }

  // Replaced while landing. The newer arm lands after this one and records
  // itself; recording this one as well could only leave the older mode in
  // armedByTab, and light it in the panel, if Chrome answered the two
  // injections out of order.
  if (replaced()) return { ok: true };

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

/**
 * Runs in the page, serialised by executeScript: takes down either capture
 * controller there.
 */
function stopCapture() {
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
}

/**
 * Put a stop in the page's queue, where it runs at document_idle behind the
 * injections already sent there, and expect no answer. A page that never
 * gets there never answers, and one that navigates drops it.
 */
function queueStop(tabId) {
  chrome.scripting.executeScript({ target: { tabId }, func: stopCapture }).catch(() => {});
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
  let landed = true;
  if (landings?.size) {
    // A stop goes now as well. The wait below lives in this worker's memory,
    // which Chrome throws away if it stops the worker meanwhile, and nothing
    // would then send the stop after it. This one is already in the page's
    // queue, behind every arm whose injection has gone out, and the page runs
    // it straight after that arm. Only an arm still being read from the
    // package can overtake it, and that arm stops itself when it lands.
    queueStop(tabId);
    // Bounded, because a page that never reaches document_idle never lands
    // an arm, and every Screen there would wait the panel's bound out.
    landed = await settledWithin([...landings], LANDING_WAIT_MS);
  }

  // An arm asked for while this waited came after the cancel. It lands after
  // the ones cancelled, and its start() takes the page over, stopping the
  // other mode if need be, so the page is left to it. The reply says so: a
  // Screen capture waiting on it must not read it as a page without overlay.
  if (latestArmByTab.get(tabId) !== latest) return { ok: true, superseded: true };

  // Not landed in time: the page has not run that arm yet, so its overlay is
  // not drawn. Its file has almost always been read from the package by now,
  // so a stop queued now is behind it, and the page runs the stop straight
  // after it. One still being read stops itself when it lands (see arm).
  if (!landed) queueStop(tabId);

  // The answer waits for a stop the page runs now rather than at
  // document_idle. Every arm cancelled here has either landed or has the
  // queued stop behind it, and a page that has not reached document_idle,
  // or is a new document that the cancelled arms never reached, still
  // answers in a frame or two.
  await chrome.scripting.executeScript({
    target: { tabId },
    injectImmediately: true,
    func: stopCapture,
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
 * One probe per tab at a time. A URL change brings a request from the worker
 * and one from the panel, on 'loading' and again on 'complete', and a page
 * that rewrites its URL often would otherwise get a stream of injections. A
 * request that comes while a probe runs does not take that probe's answer,
 * which may have been read before the change it asks about. It waits for the
 * next one, which starts when the running one ends and answers every request
 * that came meanwhile.
 *
 * @returns {Promise<'region'|'element'|null>}
 */
function verifyArmed(tabId) {
  const probes = probesByTab.get(tabId);
  if (probes) {
    const again = () => verifyArmed(tabId);
    probes.next ||= probes.running.then(again, again);
    return probes.next;
  }
  const entry = { running: null, next: null };
  probesByTab.set(tabId, entry);
  entry.running = probeArmed(tabId).finally(() => {
    if (probesByTab.get(tabId) === entry) probesByTab.delete(tabId);
  });
  return entry.running;
}

/** The probe behind verifyArmed. */
async function probeArmed(tabId) {
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
  // armedByTab honest for a panel that opens later. Only the arm of the mode
  // that sent one has ended: a drag's comes two frames after the release, and
  // the other mode armed in between is the user's newer action, live on the
  // page.
  if (
    message.type === 'cdr:region-selected' ||
    message.type === 'cdr:element-picked' ||
    message.type === 'cdr:capture-cancelled'
  ) {
    const tabId = sender?.tab?.id;
    const mode = senderMode(message);
    if (tabId != null && (!mode || armedByTab.get(tabId)?.mode === mode)) armedByTab.delete(tabId);
    return false;
  }

  return false;
});

/**
 * The capture mode a content script's message comes from, by its type, or by
 * the mode a cancel names. Null when it names none, which ends any arm.
 */
function senderMode(message) {
  if (message.type === 'cdr:region-selected') return 'region';
  if (message.type === 'cdr:element-picked') return 'element';
  return message.mode === 'region' || message.mode === 'element' ? message.mode : null;
}

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
  probesByTab.delete(tabId);
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
