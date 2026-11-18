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
 * panel      -> worker   cdr:arm            { mode: 'region'|'element', tabId, armId } -> { ok, error? }
 * worker     -> panel    cdr:armed          { mode, tabId, armId, run } (armId absent for the shortcut)
 * panel      -> worker   cdr:disarm         { tabId } -> { ok, superseded }
 * panel      -> worker   cdr:verify         { tabId } -> { ok, mode }
 * panel      -> worker   cdr:check-tab      { tabId } -> { ok, restriction, armedMode, armId, run }
 * panel      -> worker   cdr:collect        { tabId } -> { ok: true, fresh }
 *                                                      | { ok: false, outside: 'site'|'path' }
 *                                                      | { ok: false, error }
 * panel      => worker   port 'cdr:panel'   posts cdr:holding { tabId|null }; closing it disarms that tab
 * content    -> *        cdr:region-selected { rect, viewport, run, moved? }
 * content    -> *        cdr:element-picked  { rect, viewport, element, run }
 * content    -> *        cdr:capture-cancelled { mode, run }
 * panel      -> content  cdr:get-context     (handled by collector-bridge.js)
 * panel      -> content  cdr:clear-context   (handled by collector-bridge.js)
 * panel      => content  port 'cdr:counts'  to the tab in view; the bridge posts
 *                                            cdr:counts { console, network } as they change
 *                                            (no worker in between)
 *
 * The cdr:* messages sent by content scripts are broadcast to every extension
 * context, so the side panel listens for them directly instead of having the
 * worker relay them. The messages and the port meant for the panel are only
 * acted on when they come from one of this extension's own pages.
 *
 * `run` names one start() of a capture script: each start makes a new one,
 * returns it to the injection, and puts it on every message that run sends,
 * so a late message from an earlier run cannot end a newer arm of its mode.
 * `viewport` is { width, height, visual? }, the layout viewport in CSS pixels
 * and, where the page has one, its visualViewport as { x, y, width, height,
 * scale }, which is what a pinch zoomed screenshot shows. `moved` is true
 * when the overlay, inside the element shown fullscreen, moved the page's
 * layout while armed, so the crop may not match the selection.
 */

const CAPTURE_SCRIPTS = {
  region: 'content/overlay.js',
  element: 'content/picker.js',
};

/** Takes down either capture controller; see queueStop for why it is a file. */
const STOP_SCRIPT = 'content/stop.js';

/** The collector's two halves, for a tab that was open before they could be. */
const COLLECTOR_MAIN = 'content/collector-main.js';
const COLLECTOR_BRIDGE = 'content/collector-bridge.js';

// Pages where Chrome forbids script injection and tab capture. Detecting these
// up front produces a clear message instead of an opaque platform error.
//
// Under the shipped permissions this almost never matches: Chrome gives
// tab.url only for pages a host permission covers, <all_urls> covers http,
// https and file, and every scheme here is withheld and answered by the
// missing URL branch below. What reaches it is this extension's own pages,
// whose URLs it can always see. It stays as the guard it would become if a
// "tabs" permission were ever added, which shows every URL.
const RESTRICTED = /^(chrome|edge|brave|about|devtools|chrome-extension|moz-extension|view-source|data):/i;

/**
 * The Web Store, by host and path rather than by a substring of the whole
 * URL, which a search for the store's name in any query string matched.
 */
function isWebStore(url) {
  try {
    const { hostname, pathname } = new URL(url);
    return (
      hostname === 'chromewebstore.google.com' ||
      (hostname === 'chrome.google.com' && /^\/webstore(\/|$)/.test(pathname))
    );
  } catch {
    return false;
  }
}

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
  if (isWebStore(url)) {
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
 * Each entry is { mode, armId, run }, the armId being the panel's for that arm
 * (none for the shortcut), so a panel can refuse to adopt an arm it has
 * cancelled, and run the start() the injection answered with (see the header),
 * absent when the script did not name one.
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

// storage.local is open to content scripts unless an extension says otherwise,
// and the bridge runs on every page. The panel adopts any report another
// writer puts there, and prints its sentences and paths into the prompt, so
// only the extension's own pages may touch it. No content script reads or
// writes storage. Asked at every start of the worker: it costs nothing, and it
// does not depend on Chrome having kept the setting.
chrome.storage.local
  .setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  .catch((error) => console.error('[cdr] could not restrict storage', error));

/**
 * Whether a message or a port comes from one of this extension's own pages
 * (the panel), rather than from a content script, which runs in a page that
 * may be hostile and always names that page as its URL.
 */
function fromExtensionPage(sender) {
  if (!sender || sender.id !== chrome.runtime.id || typeof sender.url !== 'string') return false;
  return sender.url.startsWith(chrome.runtime.getURL(''));
}

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
    // only call start() again. The file's last statement is that start(),
    // so the injection answers with the run it made, or the one already
    // live when the mode was armed already.
    const [injected] = await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
    return { run: typeof injected?.result === 'string' ? injected.result : null };
  })();
  trackLanding(tabId, landing);
  const landed = await landing;
  if (!landed) return { ok: true };
  const { run } = landed;

  // Cancelled while landing. The disarm's queued stops are files read after
  // this one, so they are behind it; this is the second line, for a page
  // that somehow ran them first, and a function stop the disarm answers on
  // can land before it. So it stops itself: the page has run it, so it is
  // past document_idle and runs the stop at once. Not when a newer arm was
  // asked for, whose start() takes the page over and which this stop could
  // otherwise end.
  if (disarmedSince(tabId, disarms)) {
    if (!replaced()) queueStop(tabId);
    return { ok: true };
  }

  // Replaced while landing. The newer arm lands after this one and records
  // itself; recording this one as well could only leave the older mode in
  // armedByTab, and light it in the panel, if Chrome answered the two
  // injections out of order.
  if (replaced()) return { ok: true };

  armedByTab.set(tabId, run ? { mode, armId, run } : { mode, armId });

  // Tell any panel that is already listening. Without this the keyboard
  // shortcut would leave the page showing a crosshair while the panel's button
  // sits unlit, and the next click on that button would read as a cancel. A
  // panel that opens later picks the same state up via cdr:check-tab instead.
  // The panel that asked hears this too. armId lets it tell the echo of an arm
  // it has since cancelled from a new one, and run lets it tell this arm's
  // capture messages from a late one of the run before it.
  chrome.runtime.sendMessage({ type: 'cdr:armed', mode, tabId, armId, run }).catch(() => {});

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
 *
 * A file, like the arms. A file injection is read from the package before it
 * is sent to the page and a function injection is not, so a function sent
 * straight after an arm could reach the page first and stop nothing, and the
 * overlay landing after it then stayed up unless this worker was still alive
 * to send another stop. Chrome reads the files of one extension in the order
 * they were asked for, so this one follows every arm sent before it.
 */
function queueStop(tabId) {
  chrome.scripting.executeScript({ target: { tabId }, files: [STOP_SCRIPT] }).catch(() => {});
}

/** Take down whatever is armed on a tab, and every arm asked for there so far. */
async function disarm(tabId) {
  const latest = latestArmByTab.get(tabId);
  disarmsByTab.set(tabId, (disarmsByTab.get(tabId) || 0) + 1);
  armedByTab.delete(tabId);

  // A stop goes in the page's queue first, whatever this worker knows. The
  // wait below lives in this worker's memory, which Chrome throws away if it
  // stops the worker meanwhile, and nothing would then send the stop after
  // it. This one is behind every arm whose injection has gone out, and the
  // page runs it straight after them. And this worker may be a new one,
  // started by this very message, that never heard of an arm a stopped one
  // sent: that arm may still be waiting for document_idle, with the panel
  // dark because its request failed, and only a queued stop comes after it.
  queueStop(tabId);

  // Arms still landing go first. A stop that the page runs at once could
  // reach it ahead of the overlay it is meant to remove.
  const landings = landingsByTab.get(tabId);
  let landed = true;
  if (landings?.size) {
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
  // not drawn, and the stop queued above is behind it. Another one costs
  // little, in case Chrome ever read the files out of order. One still being
  // read when its own worker is alive also stops itself (see arm).
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

/**
 * Start the collector on a tab where nothing answers for it: one that was
 * open before the extension was installed, enabled or reloaded, since Chrome
 * injects the declared content scripts only into pages loaded after that.
 *
 * The main world half has a guard of its own, so it never wraps twice; it is
 * asked first all the same, because a reload or an update of the extension
 * leaves the old one running in the page with everything it has logged since
 * the page loaded, and only a new bridge is then needed to reach it. A
 * collector of this build answers the event its guard sends, and one of 0.5.0
 * or earlier set a global, so both are asked. `fresh` says whether the
 * collector started now. The panel does not go by it: the collector says in
 * every snapshot whether it started late, which holds after the panel is
 * closed and opened again and after the next reload of the extension.
 * injectImmediately, so a page still loading starts collecting now rather
 * than at document_start.
 *
 * A new one is started only where the declared content scripts would have
 * run. host_permissions let the worker script any page, but narrowing the
 * content_scripts matches is how a user keeps the collector to their own
 * sites (README), and a collector started here on any tab would quietly undo
 * that. `outside` says why nothing was started, so the panel does not advise
 * a reload that would not help either: 'site' where the manifest keeps the
 * collector off the whole site, 'path' where it runs on the site but not on
 * this URL, and none was found running.
 *
 * A site the manifest leaves out gets nothing at all, not even the probes: a
 * page there could answer them as a collector and have a bridge put in (see
 * collectorSiteDeclaredFor). The one exception is a URL on a site the
 * manifest declares the collector for, on a path it does not. A single page
 * app can have moved there from the path the declared collector started on,
 * and that collector's log is still the one the user came for, so it is
 * asked for and bridged, though never started there.
 *
 * @returns {Promise<{ ok: true, fresh: boolean } | { ok: false, outside: 'site' | 'path' }>}
 */
async function startCollector(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const restriction = await restrictionFor(tab);
  if (restriction) throw new Error(restriction);
  const declared = collectorDeclaredFor(tab.url);
  if (!declared && !collectorSiteDeclaredFor(tab.url)) return { ok: false, outside: 'site' };
  const target = { tabId };
  const probes = await Promise.all([
    chrome.scripting.executeScript({ target, injectImmediately: true, func: collectorAnswers }),
    chrome.scripting.executeScript({ target, world: 'MAIN', injectImmediately: true, func: collectorMarked }),
  ]);
  const running = probes.some(([probe] = []) => probe?.result === true);
  if (!running) {
    if (!declared) return { ok: false, outside: 'path' };
    // The collector this starts did not start at document_start, and only
    // this worker knows it: see markLate.
    await chrome.scripting.executeScript({ target, injectImmediately: true, func: markLate });
    await chrome.scripting.executeScript({
      target,
      world: 'MAIN',
      injectImmediately: true,
      files: [COLLECTOR_MAIN],
    });
  }
  await chrome.scripting.executeScript({ target, injectImmediately: true, files: [COLLECTOR_BRIDGE] });
  return { ok: true, fresh: !running };
}

/**
 * Runs in the page, in this extension's isolated world, just before the
 * worker injects a collector into it: tells that collector it did not start
 * at document_start, by cancelling the event it sends as it starts (LATE in
 * collector-main.js), which reaches this world's listeners as any DOM event
 * does. A declared collector sends it too, at document_start, in a document
 * this has never run in, so nothing cancels it there. Once: the listener
 * goes with the first event it hears.
 */
function markLate() {
  const listener = (event) => {
    window.removeEventListener('__cdr_late', listener, true);
    event.preventDefault();
  };
  window.addEventListener('__cdr_late', listener, true);
}

/**
 * Runs in the page, in this extension's isolated world: whether a collector
 * of 0.6.0 or later is there, which answers the probe its guard sends by
 * cancelling it (see the guard in collector-main.js). The event reaches the
 * main world's listeners as any DOM event does, and is sent from this world
 * with a dispatchEvent and a CustomEvent the page cannot have replaced.
 */
function collectorAnswers() {
  try {
    return !window.dispatchEvent(new CustomEvent('__cdr_probe', { cancelable: true }));
  } catch {
    return false;
  }
}

/**
 * Whether the manifest declares both halves of the collector for this URL,
 * read from the manifest itself so the two cannot disagree: as Chrome
 * decides it for a content script, the URL is in matches and not in
 * exclude_matches, matches one of include_globs if there are any, and none
 * of exclude_globs.
 */
function collectorDeclaredFor(url) {
  const declared = chrome.runtime.getManifest().content_scripts || [];
  return [COLLECTOR_MAIN, COLLECTOR_BRIDGE].every((file) =>
    declared.some(
      (entry) =>
        entry.js?.includes(file) &&
        (entry.matches || []).some((pattern) => matchesPattern(pattern, url)) &&
        !(entry.exclude_matches || []).some((pattern) => matchesPattern(pattern, url)) &&
        (!entry.include_globs?.length || entry.include_globs.some((glob) => matchesGlob(glob, url))) &&
        !(entry.exclude_globs || []).some((glob) => matchesGlob(glob, url))
    )
  );
}

/**
 * Whether the manifest declares both halves of the collector for this URL's
 * site, its scheme, host and port, on some path if not on this one: whether
 * Chrome would run the collector on some URL of the site. A single page app
 * can have moved from the path its collector started on to one the manifest
 * leaves out, and its collector still runs there.
 *
 * Every rule can be about hosts as much as paths (a glob is matched against
 * the whole URL), so rather than read the rules, this asks
 * collectorDeclaredFor about URLs of this site the rules themselves suggest:
 * the URL, the site's root, and each matches pattern's and include glob's
 * own path put on the site, and for a glob that names no scheme its whole
 * text as the site's path ('*app*' runs on https://any.site/app), each with
 * its wildcards filled once empty and once with a letter no exclude holds,
 * alone and next to each glob's text in either order (matches /app/* with
 * include_globs *\/admin* runs on /app/admin). Each is written as Chrome writes it before
 * a rule is tried on it ('café' as 'caf%C3%A9'), and kept only if it is
 * still on this site. Where none of them is declared, the site is taken to
 * be out, and nothing is asked of the page.
 */
function collectorSiteDeclaredFor(url) {
  const site = /^[a-z][a-z0-9+.-]*:\/\/[^/]*\//is.exec(url)?.[0];
  if (!site) return false;
  const pathOf = (rule) => {
    const authority = rule.indexOf('://');
    const slash = rule.indexOf('/', authority === -1 ? 0 : authority + 3);
    return slash === -1 ? '' : rule.slice(slash + 1);
  };
  const rules = [];
  let excludes = '';
  for (const entry of chrome.runtime.getManifest().content_scripts || []) {
    if (!entry.js?.includes(COLLECTOR_MAIN) && !entry.js?.includes(COLLECTOR_BRIDGE)) continue;
    for (const pattern of entry.matches || []) rules.push({ text: pathOf(pattern), glob: false });
    for (const glob of entry.include_globs || []) {
      rules.push({ text: pathOf(glob), glob: true });
      // A glob that names no scheme may be about the path as a whole; one
      // that names a scheme is taken to name its host too, and is not tried
      // as a path, so that a host glob (*://*.example.com/*) declares no
      // other site on the strength of a path such as /.example.com/.
      if (!glob.includes('://')) rules.push({ text: glob, glob: true });
    }
    excludes += [...(entry.exclude_matches || []), ...(entry.exclude_globs || [])].join(' ').toLowerCase();
  }
  // Each wildcard is tried empty and as a letter no exclude holds, so that an
  // exclude naming only some paths (the home page, any path ending in /, a
  // pattern's own path) cannot take out every URL tried while others of the
  // site still get the collector. In a match pattern only * is a wildcard,
  // and a ? is the query's; in a glob ? is at most one character, and \
  // takes the next one as it is.
  const spare = [...'qzjxkvwy'].find((letter) => !excludes.includes(letter)) ?? 'q';
  const fill = ({ text, glob }, letter) =>
    glob
      ? text.replace(/\\([\s\S])|[*?]/g, (wild, kept) => kept ?? letter)
      : text.replace(/\*/g, letter);
  // The letter alone too: <all_urls> names no path to fill.
  const paths = ['', spare];
  const tails = [''];
  for (const rule of rules) {
    for (const letter of ['', spare]) {
      const path = fill(rule, letter);
      paths.push(path);
      if (rule.glob) tails.push(path);
    }
  }
  // A pattern's path and a glob can meet only on a longer URL, in either
  // order: matches /app/* with include_globs *\/admin* runs on /app/admin,
  // and matches /*.html with include_globs *?x* on /x.html.
  const candidates = [url];
  for (const path of paths) {
    for (const tail of tails) {
      for (const text of [path + tail, tail + path]) {
        try {
          const href = new URL(site + text).href;
          if (href.startsWith(site) && !candidates.includes(href)) candidates.push(href);
        } catch {
          /* not a URL Chrome would load */
        }
      }
    }
  }
  return candidates.some(collectorDeclaredFor);
}

/**
 * A Chrome match pattern, as the extension docs define it
 * (developer.chrome.com/docs/extensions/develop/concepts/match-patterns) and
 * as Chrome's URLPattern reads it: <scheme>://<host>[:<port>]<path>. A scheme
 * of * is http or https only. The pattern's host is canonicalized as a URL's
 * is (lower case, an IDN in punycode, an IPv4 or IPv6 address in its one
 * written form), and a trailing dot is dropped from both hosts before they
 * are compared. A host of *.example.com is example.com and every subdomain,
 * and no subdomain of an IP address. No port means any port. A file pattern
 * names no host. The path is a glob where only * is special, matched against
 * the URL's path and query, a bare ? included; a path ending in /* also
 * matches the path without that slash. <all_urls> is every scheme Chrome lets
 * an extension script. Checked against Chrome for Testing 156's own matching.
 */
function matchesPattern(pattern, href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  const scheme = url.protocol.slice(0, -1);
  if (pattern === '<all_urls>') return ['http', 'https', 'file', 'ftp', 'ws', 'wss'].includes(scheme);
  const parts = /^(\*|https?|file|ftp|wss?):\/\/(.*)$/s.exec(pattern);
  if (!parts) return false;
  const [, wantScheme, rest] = parts;
  if (wantScheme === '*' ? scheme !== 'http' && scheme !== 'https' : wantScheme !== scheme) return false;
  const slash = rest.indexOf('/');
  let wantPath;
  if (wantScheme === 'file') {
    // file://*, with no slash after the host, is file:///*, and a host
    // before the path is ignored.
    wantPath = slash === -1 ? `/${rest}` : rest.slice(slash);
  } else {
    if (slash <= 0) return false;
    wantPath = rest.slice(slash);
    const hostAndPort = rest.slice(0, slash);
    let wantHost = hostAndPort;
    let wantPort = '*';
    let colon = -1;
    if (hostAndPort[0] === '[') {
      const close = hostAndPort.indexOf(']');
      if (close <= 1) return false;
      if (close < hostAndPort.length - 1) {
        if (hostAndPort[close + 1] !== ':') return false;
        colon = close + 1;
      }
    } else {
      colon = hostAndPort.indexOf(':');
    }
    if (colon !== -1) {
      wantHost = hostAndPort.slice(0, colon);
      wantPort = hostAndPort.slice(colon + 1);
      if (wantPort !== '*' && !(/^\d+$/.test(wantPort) && Number(wantPort) <= 65535)) return false;
    }
    if (!wantHost) return false;
    let subdomains = false;
    if (wantHost === '*') {
      subdomains = true;
      wantHost = '';
    } else if (wantHost.startsWith('*.')) {
      if (wantHost.length === 2) return false;
      subdomains = true;
      wantHost = wantHost.slice(2);
    }
    if (wantHost.includes('*')) return false;
    if (wantHost) {
      // Canonicalized as Chrome does a pattern's host, here by the URL
      // parser, which must take all of it as the host.
      let parsed;
      try {
        parsed = new URL(`http://${wantHost}/`);
      } catch {
        return false;
      }
      if (parsed.username || parsed.password || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) {
        return false;
      }
      wantHost = parsed.hostname;
    }
    const host = url.hostname.replace(/\.$/, '');
    wantHost = wantHost.replace(/\.$/, '');
    if (host !== wantHost && !(subdomains && !wantHost)) {
      if (!subdomains) return false;
      // No subdomain of an IP address.
      if (/^\[.*\]$/s.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
      if (host.length <= wantHost.length + 1 || !host.endsWith(`.${wantHost}`)) return false;
    }
    const port = url.port || { http: '80', https: '443', ws: '80', wss: '443', ftp: '21' }[scheme] || '';
    if (wantPort !== '*' && wantPort !== port) return false;
  }
  // The path Chrome matches is the one a request is made for: the path, and
  // the query with its ? whenever the URL has one, empty or not.
  const query = url.search || (url.href.split('#')[0].endsWith('?') ? '?' : '');
  const path = url.pathname + query;
  // The pattern's path is compared as Chrome writes a URL's: a character
  // other than ASCII, and ", < and >, are escaped in it as in the URL
  // ('café' matches /caf%C3%A9, 'a"b' matches /a%22b, 'x?é' matches
  // /x?%C3%A9), though a space is not ('a b*' never matches /a%20b), all
  // checked in Chrome for Testing 156. Nothing else was found to differ.
  wantPath = Array.from(wantPath, (character) => {
    const code = character.codePointAt(0);
    if (code < 0x7f && !'"<>'.includes(character)) return character;
    try {
      return encodeURIComponent(character);
    } catch {
      return character;
    }
  }).join('');
  // Chrome lets a pattern's path ending in /* match the path without that
  // slash, compared with its \ and ? escaped as they are for the glob.
  if (wantPath.replace(/\\/g, '\\\\').replace(/\?/g, '\\?') === `${path}/*`) return true;
  const glob = wantPath.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${glob}$`, 's').test(path);
}

/**
 * An include_globs or exclude_globs entry against a URL, as Chrome matches
 * one (base::MatchPattern on the whole URL): * is any run of characters, ?
 * is at most one, and \ takes the character after it as it is. Ported as it
 * is written there, which does not backtrack: after a *, the rest of the
 * glob up to the next wildcard is matched at its first place in the URL.
 */
function matchesGlob(glob, href) {
  const pattern = Array.from(String(glob));
  const text = Array.from(String(href));
  let p = 0;
  let t = 0;
  do {
    // The wildcards in a row: how far the next part may start from here.
    let questions = 0;
    let star = false;
    while (p < pattern.length && (pattern[p] === '*' || pattern[p] === '?')) {
      if (pattern[p] === '*') star = true;
      else questions += 1;
      p += 1;
    }
    let distance = star ? -1 : questions;
    // The part up to the next wildcard, at the first place it fits.
    const partStart = p;
    let textStart = t;
    let escape = false;
    for (;;) {
      if (p === pattern.length) {
        if (t === text.length) break;
      } else {
        if (!escape && (pattern[p] === '*' || pattern[p] === '?')) break;
        if (!escape && pattern[p] === '\\') {
          escape = true;
          p += 1;
          continue;
        }
        escape = false;
        if (t === text.length) return false;
        if (pattern[p] === text[t]) {
          p += 1;
          t += 1;
          continue;
        }
      }
      if (distance === 0) return false;
      distance -= 1;
      p = partStart;
      textStart += 1;
      t = textStart;
    }
  } while (p < pattern.length);
  return true;
}

/** Runs in the page's main world: whether a collector of 0.5.0 or earlier marked it. */
function collectorMarked() {
  try {
    return Boolean(window.__cdrCollector);
  } catch {
    return false;
  }
}

/** Messages only the panel sends, acted on for nobody else. */
const PANEL_MESSAGES = new Set(['cdr:arm', 'cdr:disarm', 'cdr:verify', 'cdr:check-tab', 'cdr:collect']);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  // A content script runs in a page that may be hostile, and each of these
  // takes a tab id from its sender: an arm puts a capture script in that
  // tab, a disarm ends what the user armed there, and a collect injects the
  // collector. Chrome's messaging guide says to assume a content script's
  // message may have been crafted.
  if (PANEL_MESSAGES.has(message.type) && !fromExtensionPage(sender)) return false;

  if (message.type === 'cdr:collect') {
    startCollector(message.tabId).then(sendResponse, (error) =>
      sendResponse({ ok: false, error: error?.message || String(error) })
    );
    return true;
  }

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
            run: armedByTab.get(message.tabId)?.run || null,
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
  // page. And only the run that sent it: the shortcut can arm the same mode
  // again in those two frames, and that newer run is live too.
  if (
    message.type === 'cdr:region-selected' ||
    message.type === 'cdr:element-picked' ||
    message.type === 'cdr:capture-cancelled'
  ) {
    const tabId = sender?.tab?.id;
    const entry = tabId != null ? armedByTab.get(tabId) : null;
    if (entry && endsArm(message, entry.mode, entry.run)) armedByTab.delete(tabId);
    return false;
  }

  return false;
});

/**
 * Whether a content script's message ends the arm recorded as `mode` and
 * `run`. A message or an arm that names no run (a script from before runs
 * existed, or an arm whose run is not known) is judged by mode alone.
 */
function endsArm(message, mode, run) {
  const from = senderMode(message);
  if (from && from !== mode) return false;
  return !(typeof message.run === 'string' && run && message.run !== run);
}

/*
 * The panel holds a port open while a capture mode is armed, and says which
 * tab over it. Closing the panel closes the port, and that tab is disarmed:
 * with nobody left to take the screenshot, a drag would end the overlay
 * exactly as a capture does and leave nothing behind, with no word said.
 *
 * An idle worker is stopped with the port open, which closes it from this
 * end; a panel still armed then opens a new one, which starts the worker
 * again, so there is always one here to hear the panel go.
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'cdr:panel' || !fromExtensionPage(port.sender)) {
    port.disconnect();
    return;
  }
  let holding = null;
  port.onMessage.addListener((message) => {
    if (message?.type !== 'cdr:holding') return;
    holding = Number.isInteger(message.tabId) ? message.tabId : null;
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (holding != null) disarm(holding).catch(() => {});
  });
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
  // A panel that did not open leaves nobody to take the screenshot, and a
  // drag would end the overlay as a capture does with nothing to show for it,
  // so the arm is taken back down. The disarm comes after it, so it cancels
  // it however far it got.
  chrome.sidePanel.open({ tabId: tab.id }).catch((error) => {
    console.error('[cdr] could not open side panel', error);
    disarm(tab.id).catch(() => {});
  });

  // arm() may await freely: only open() depends on the gesture.
  arm('region', tab.id).catch((error) => console.error('[cdr] shortcut failed', error));
});
