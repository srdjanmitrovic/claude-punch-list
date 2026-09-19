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
   +-- content/picker.js ... hover and click an element (injected on demand),
   |                         and asks the main world what rendered it
   |                              |
   +-- content/collector-bridge.js .. ISOLATED world, always on. Relays.
        ^                             |
        | window.postMessage          | window.postMessage
        v                             v
       content/collector-main.js .... MAIN world, always on. Wraps console,
                                      fetch and XHR from document_start, and
                                      reads React and Vue internals on request.
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
tick early is lost silently. The protocol here is safe because **the isolated side always
initiates**, whether that is the bridge asking for the buffers or the picker asking what
rendered a node: the main world script only ever replies to a request. If you ever add a load
time push from main to isolated, you will need a readiness handshake.

The same boundary is why the element picker cannot read a React fiber itself. React hangs the
fiber off the DOM node as a `__reactFiber$<random>` property and Vue hangs
`__vueParentComponent`, and those properties live on each world's own wrapper of the node, so
an isolated world script sees a node with none of them. The DOM itself **is** shared, which is
what the handoff uses: the picker sets a random `data-cdr-pick` attribute on the clicked
element, asks for it by that value, and the main world finds the node with an ordinary
`querySelector`. Both sides remove the attribute, because the timeout path is a page where
nobody over there ever saw it.

Two ordering constraints fall out of that. The attribute goes on **after** the picker has read
`outerHTML` and the node's attributes, or `data-cdr-pick` appears in the markup printed in the
user's prompt. And the round trip runs **concurrently** with the two animation frames the
picker already waits for, so the 300ms timeout costs nothing on a page that answers and does
not delay the screenshot on a page that does not.

The reply carries two things, `component` and `handlers`, either of which may be absent. Handlers
come from a different property than the component does: React keeps a host element's own props on
the node as `__reactProps$<random>`, in a production build as well as a development one because
event dispatch reads them back from there, and Vue keeps the same names on `__vnode.props`.
Neither is the fiber, so the two lookups climb independently and their hop counts can differ.
That is why the prompt never presents them as one number.

Whether a handler's body is worth printing is decided by the text itself rather than by the build
label. Minified code has nothing but one and two character identifiers, so a run of four or more
letters is the test. Gating on a development build was both too strict, because Vue's development
bundle sets no flag this code can read, and too loose, because a production build that keeps
function names still has a minified body behind a real name.

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

Every message is a plain object with a `type` field prefixed `cdr:`. The prefix, like the
`cdr*` storage keys and the `__cdr*` globals the content scripts cache on `window`, is the
initialism of the project's original name, Claude Debug Reporter. It stayed through the
rename because it is internal, and changing it would touch every file for nothing a user
could see.

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

Inside the page there is a second, smaller protocol, carried on `window.postMessage` rather
than `chrome.runtime`. Every message is `{ __cdr: 'request' | 'response', id, ... }` and the
main world answers exactly one action per request.

| Action | From | Purpose |
| :--- | :--- | :--- |
| `snapshot` | bridge | Return the console, error and network buffers |
| `clear` | bridge | Empty them |
| `inspect` | picker | Return the React or Vue component behind a marked node, and the handlers bound to it |

An action this build does not recognise answers `null`, and that is load bearing rather than
tidiness. Reloading the extension does **not** re-inject the declared content scripts into tabs
that are already open, so an old main world script keeps running there while a freshly injected
picker talks to it. Before, anything that was not `clear` returned the snapshot, which would
have handed the picker a console buffer to present as a component. The two sides also keep
their ids apart by type, numbers from the bridge and strings from the picker, so each ignores
the other's replies on a window they both listen to.

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

### A failed request records who sent it

The URL of a request that failed says what broke. The function that sent it says where to look,
and that is only knowable at the moment of the call, so both wrappers construct an `Error` before
handing off to the native implementation and keep it until the request settles.

Three things make that affordable. `Error.stackTraceLimit` is lowered around the construction and
restored afterwards, and only restored to a value that was actually read, because writing
`undefined` back would stop V8 collecting stacks for the page's own errors. The stack is formatted
only on failure, so a healthy page pays one allocation per request and nothing else. And the XHR
wrapper releases its `Error` as soon as the request settles, because an unformatted one holds a
strong reference to every recorded frame's function and receiver, which a long polling request
would otherwise pin for its lifetime.

Frames are filtered down to the page's own code. A frame is kept only when its path ends in
something that looks like a file extension, since a bare document path is a route rather than a
file and printing one sends the reader hunting for source that never existed. Framework dispatch
frames are dropped too: only three frames are kept, and on the React fixture the third slot went
to `react-dom`'s internals while the page's own caller sat just below the cut.

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
