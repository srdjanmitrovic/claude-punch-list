# Architecture

How the extension is put together, and why it is put together that way. Read this before
changing the message flow or the collector.

## The pieces

```
Toolbar icon or Alt+Shift+C
   |
   v
sidepanel/panel.js ......... orchestrates everything. Captures the tab, crops
   |                         with a canvas, saves via chrome.downloads, builds
   |                         and copies the prompt.
   |
   +-- background.js ....... service worker. Side panel behaviour, the keyboard
   |                         command, injecting the capture scripts, and a map
   |                         of which tab is currently armed.
   |
   +-- content/overlay.js .. drag a rectangle (injected on demand)
   +-- content/picker.js ... hover and click an element (injected on demand)
   |
   +-- content/collector-bridge.js .. ISOLATED world, always on. Relays.
        ^
        | window.postMessage
        v
       content/collector-main.js .... MAIN world, always on. Wraps console,
                                      fetch and XHR from document_start.
```

## Two decisions worth understanding

### The collector is split in two

A normal content script runs in an **isolated world**. It shares the DOM with the page but
gets its own copies of `console`, `fetch` and `XMLHttpRequest`, so wrapping them there records
nothing the page actually does.

Only a script declared with `"world": "MAIN"` sees the page's real ones. The catch is that
main world scripts have no access to `chrome.*` APIs at all, so they cannot talk to the rest
of the extension. The bridge exists purely to carry data across that boundary over
`window.postMessage`.

This split has a subtle consequence that the design depends on. Chrome does not guarantee the
injection order of the two entries, and `postMessage` has no buffering, so a message sent one
tick early is lost silently. The protocol here is safe because **the bridge always initiates**:
the main world script only ever replies to a request. If you ever add a load time push from
main to isolated, you will need a readiness handshake.

### The heavy lifting is in the side panel, not the service worker

An MV3 service worker has no DOM, so there is no canvas to crop with, and
`URL.createObjectURL` is not exposed to it, so there is no way to hand a generated file to
`chrome.downloads`. A side panel is a full extension page and has both, plus direct access to
every `chrome.*` API it needs.

So the worker stays thin. It owns only what must survive the panel being closed: side panel
behaviour, the keyboard command, script injection, and the armed tab map.

One trap worth knowing. `activeTab` is **not** reliably granted to side panel contexts, which
is why `host_permissions: <all_urls>` is required rather than optional. Without it,
`captureVisibleTab` and `scripting.executeScript` called from the panel fail even though
`activeTab` is declared.

## Message protocol

Every message is a plain object with a `type` field prefixed `cdr:`.

| Message | From | To | Purpose |
| :--- | :--- | :--- | :--- |
| `cdr:arm` | panel | worker | Inject overlay or picker into a tab |
| `cdr:disarm` | panel | worker | Tear down whatever is armed there |
| `cdr:check-tab` | panel | worker | Ask whether a tab is usable, and what is armed on it |
| `cdr:armed` | worker | panel | A capture mode is now waiting on a tab |
| `cdr:region-selected` | overlay | panel | A rectangle was dragged |
| `cdr:element-picked` | picker | panel | An element was clicked |
| `cdr:capture-cancelled` | overlay, picker | panel | The user pressed Escape |
| `cdr:get-context` | panel | bridge | Read the collected buffers plus page info |
| `cdr:clear-context` | panel | bridge | Empty the buffers |

Two things about this table are load bearing.

**`chrome.runtime.sendMessage` has no addressing.** A content script's broadcast reaches every
open side panel, and side panels are per window. The panel therefore filters on
`sender.tab.id` before acting. Without that filter, dragging a region in one window makes a
second window's panel screenshot its own tab, crop it to the first window's rectangle, and
present the result as a valid capture, with no error anywhere.

**Armed state is tracked in two places on purpose.** The panel keeps it for the UI, and the
worker keeps a map so a panel that opens later can learn about it. The one shot `cdr:armed`
broadcast is not enough by itself, because `Alt+Shift+C` opens the panel and arms the page in
the same breath: the message can be sent before the panel document exists to hear it. The
panel picks the state up from the `cdr:check-tab` reply instead.

## Capture and cropping

`chrome.tabs.captureVisibleTab` returns the whole viewport at physical device pixels. The
overlay reports its rectangle in CSS pixels along with the viewport size measured at capture
time, and the cropper derives the scale as:

```js
const scale = image.naturalWidth / viewport.width;
```

That is deliberately not `devicePixelRatio`. Browser zoom also changes the ratio between CSS
pixels and captured pixels, and the measured value is correct under both zoom and a Retina
display, where the constant is not.

Two related details. Both capture scripts remove their overlay and then wait two animation
frames before signalling, because removing a node only queues the change and one frame does
not guarantee a paint has landed. And every rectangle clamps all four edges before deriving
width and height: clamping only the origin while keeping the raw drag delta silently widens
the selection when a drag leaves the viewport.

Opening the side panel shrinks the tab viewport, which is why the viewport is measured inside
the content script at capture time rather than assumed.

## Saving, and getting a real path back

`DownloadItem.filename` is the only source of truth for the absolute path, and it is empty
until the download completes. The panel polls `chrome.downloads.search({id})` rather than
listening to `onChanged`, because a blob download often finishes before a listener attached
after `download()` could observe the state change.

There is deliberately no overall timeout on that poll. If the user has "Ask where to save each
file before downloading" enabled, the dialog can sit open for minutes, and giving up would
throw away a path that is still coming. The loop ends on `complete` or `interrupted`, and
cancelling the dialog produces the latter with `USER_CANCELED`.

## Clipboard

The only precondition Chromium enforces for a sanitized clipboard write from an extension page
is `document.hasFocus()`. There is no transient activation gate, so awaiting the file save
first is fine. What does break it is a "Save as" dialog stealing focus, so `copyText` waits for
focus to return, falls back to `execCommand('copy')`, and finally reveals the prompt for a
manual copy.

## Permissions

| Permission | Why it is there |
| :--- | :--- |
| `host_permissions: <all_urls>` | Screenshot the tab, inject the overlay and picker, and read `tab.url`. Chrome withholds the URL entirely for any origin this does not cover. |
| `scripting` | Inject the region overlay and element picker on demand |
| `downloads` | Save the PNG and read back its absolute path |
| `storage` | Remember the draft text and toggle settings |
| `sidePanel` | The panel itself |

Note what is **not** in that table. The collector arms via the two `content_scripts` entries
and their own `"matches": ["<all_urls>"]`, which is a grant entirely separate from
`host_permissions`. A statically declared content script injects on its own match patterns, so
narrowing `host_permissions` alone does not stop the collector wrapping `console`, `fetch` and
`XMLHttpRequest` on every page. It also does not shrink the install warning, which is computed
from content script matches as well.

Anyone restricting this extension to specific origins therefore has to change `<all_urls>` in
three places, not one.

`activeTab` is not requested. It is not granted to side panel contexts, so it would be dead
weight next to `<all_urls>`. `clipboardWrite` is not requested either, for the reason given in
the README.

## Pages Chrome will not allow

`chrome://` pages, the Chrome Web Store, other extensions' pages and `view-source:` cannot be
captured or injected into at all. The panel detects these and explains rather than failing
obscurely.

Note that Chrome withholds `tab.url` entirely for any page the extension has no host
permission for, so an absent URL is itself the signal that a page is off limits. That is also
the only observable signal for a blocked `file://` tab, which is why the "enable Allow access
to file URLs" hint lives in the missing URL branch rather than in a `file://` branch.

## Conventions in the code

Both capture scripts are injected repeatedly by `executeScript`, which re-runs the entire file
every time. They cache a controller on `window` and call `start()` again, so they must stay
free of top level `const`, `let` and `class`: a redeclaration throws at parse time and the
whole file fails to run.

The collector wrappers must never break a host page. Every one of them preserves `this`, passes
return values through unchanged, re-rejects rejections, and swallows its own errors.
