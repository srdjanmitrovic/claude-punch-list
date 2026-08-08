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
 * panel      -> worker   cdr:arm            { mode: 'region'|'element', tabId }
 * panel      -> worker   cdr:disarm         { tabId }
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
 */
const armedByTab = new Map();

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('[cdr] setPanelBehavior failed', error));

async function arm(mode, tabId) {
  const file = CAPTURE_SCRIPTS[mode];
  if (!file) throw new Error(`Unknown capture mode: ${mode}`);

  const tab = await chrome.tabs.get(tabId);
  const restriction = await restrictionFor(tab);
  if (restriction) throw new Error(restriction);

  // executeScript re-runs the file on every call. Both capture scripts are
  // written to be idempotent: they cache their controller on window and only
  // call start() again.
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [file],
  });

  armedByTab.set(tabId, mode);

  // Tell any panel that is already listening. Without this the keyboard
  // shortcut would leave the page showing a crosshair while the panel's button
  // sits unlit, and the next click on that button would read as a cancel. A
  // panel that opens later picks the same state up via cdr:check-tab instead.
  chrome.runtime.sendMessage({ type: 'cdr:armed', mode, tabId }).catch(() => {});

  return { ok: true };
}

async function disarm(tabId) {
  armedByTab.delete(tabId);
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      window.__cdrRegionOverlay?.stop();
      window.__cdrElementPicker?.stop();
    },
  });
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  if (message.type === 'cdr:arm') {
    arm(message.mode, message.tabId).then(sendResponse, (error) =>
      sendResponse({ ok: false, error: error?.message || String(error) })
    );
    return true;
  }

  if (message.type === 'cdr:disarm') {
    disarm(message.tabId).then(sendResponse, () => sendResponse({ ok: false }));
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
            armedMode: armedByTab.get(message.tabId) || null,
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

// Keep armedByTab from going stale or growing without bound. A navigation
// destroys the injected overlay, and a closed tab can never be armed again.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') armedByTab.delete(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  armedByTab.delete(tabId);
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
