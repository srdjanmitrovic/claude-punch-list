# Architecture

How the extension is put together, and why it is put together that way. Read this before
changing the message flow or the collector.

## The pieces

```
Toolbar icon or Alt+Shift+C
   |
   v
sidepanel/panel.js ......... orchestrates everything. Captures the tab, crops
   |                         with a canvas, saves each capture via
   |                         chrome.downloads as it happens, keeps the list of
   |                         items, builds and copies the prompt.
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

## Three decisions worth understanding

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

### Screenshots are saved when they are taken, not when the report is copied

A report is a list of items, and each item is one capture with its own description, intent,
page URL and, for the element picker, the node's payload. The moment a capture lands, the
panel writes its PNG to disk and waits for the absolute path before it considers the item
complete. Copying then only has to assemble text, which is why it is instant and why it can
be repeated.

The alternative, saving everything at copy time, was how the single capture version worked,
and it stops scaling the moment there is more than one file: a partial failure halfway
through a batch leaves a report that names some paths and not others, and every "Save as"
dialog stacks up at the end instead of appearing next to the capture that caused it.

Saving early has a consequence the code has to honour in two places. An item discarded
before it was copied never appears in any prompt, so its file is deleted again with
`downloads.removeFile` and its history entry with `downloads.erase`. The reset after a
successful copy must do the opposite and leave every file alone, because the prompt on the
clipboard names each one by path and Claude Code is about to open them.

It also means the panel never has to keep a full image. Each item holds a WebP thumbnail no
wider than the frame can display, and the original data URL is released once the download
has started. That is what makes the report safe to persist: `cdrReport` in
`chrome.storage.local` holds every item minus its pixels and is rewritten on every keystroke,
and `cdrThumbs` holds the thumbnails and is rewritten only when an item is added or removed.
An item is only written once it has a path, so a panel closed mid-save cannot come back
showing a description of a file that does not exist. A report untouched for a week is dropped
at startup; the files stay. Files can also go missing within that week, because Downloads
folders get emptied, so at startup the panel asks `chrome.downloads` whether each one still
exists and refuses to copy until a missing item is discarded.

Side panels are per window, and every one of them reads and writes the same keys. Rather
than let the last writer win, each write is stamped with the writing panel's id and every
panel listens to `chrome.storage.onChanged`: a change carrying another panel's id is adopted
into the local sheet, keeping only what the local panel alone knows (an item still being
saved, the sentence being typed). Two windows therefore show one report. The toggle settings
are written separately from the report, so a panel that never captured anything cannot
overwrite a report by unticking a box.

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

While the poll runs the item is already in the frame, marked SAVING, and the copy button
stays disabled until no item is in that state. If the save fails the item is removed again
rather than kept without a path: nothing reached the disk, and an item with no screenshot
would be a sentence about nothing. The banner says to capture it again.

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
| `downloads` | Save each PNG as it is captured, read back its absolute path, delete it again if the item is discarded, and learn if it has since gone missing |
| `storage` | Keep the report (items, descriptions, thumbnails) between panel sessions, plus the toggle settings |
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

## Running the panel outside Chrome

`tools/panel-stage.html` loads the panel as an ordinary web page next to the demo page, with
`tools/chrome-shim.js` standing in for `chrome.*`. The shim answers the real message protocol
the way the worker and content scripts would: `cdr:arm` injects the real overlay or picker
into the demo frame, `cdr:get-context` reaches the real collector through the real bridge,
and `captureVisibleTab` asks the stage for a screenshot of the demo frame. Everything on
screen is the actual code; only the platform is faked. Two things it does not reproduce:
downloads complete instantly unless `?save=<ms>` slows them, and there is only ever one
panel, so the cross window adoption above cannot be exercised there.

It exists for two reasons. Working on the panel's design no longer means reloading an
extension for every change, and the README's screenshots and GIF are produced from it by
`tools/make-media.mjs`, so they can be regenerated rather than redrawn. Nothing under
`tools/` is included in the release zip.

## Conventions in the code

Both capture scripts are injected repeatedly by `executeScript`, which re-runs the entire file
every time. They cache a controller on `window` and call `start()` again, so they must stay
free of top level `const`, `let` and `class`: a redeclaration throws at parse time and the
whole file fails to run.

The collector wrappers must never break a host page. Every one of them preserves `this`, passes
return values through unchanged, re-rejects rejections, and swallows its own errors.
