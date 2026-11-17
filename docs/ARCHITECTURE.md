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
   |                         command, injecting the capture scripts, starting
   |                         the collector on a tab open from before, and a
   |                         map of which tab is currently armed.
   |
   +-- content/overlay.js .. drag a rectangle (injected on demand)
   +-- content/picker.js ... hover and click an element (injected on demand),
   |                         and asks the main world what rendered it
   |                              |
   +-- content/collector-bridge.js .. ISOLATED world, always on. Relays.
        ^                             |
        | channel events (the log)    | window.postMessage (inspect, from the picker)
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
of the extension. The bridge exists purely to carry data across that boundary.

It reads the log over a channel of its own: a pair of event types on the window, named by the
bridge with 128 random bits, which it hands to the collector in one `__cdr_hello` event. A
message posted to the window reaches every message listener on the page, so reading the log over
`window.postMessage` would hand the page's console text, failed request URLs and stacks to every
third party script, and let any of them answer in the collector's place. Chrome does not
guarantee the injection order of the two entries, so whichever half starts second speaks first:
the bridge says `bridge <channel>` as it starts, and the collector says `main` as it starts, which
the bridge answers with its channel. The bridge then asks once over the channel (`ping`), and once
its channel has carried one answered request it no longer answers `main`. Event dispatch is
synchronous and crosses the two worlds, so a request is answered before `dispatchEvent` returns,
and the bridge rebuilds whatever comes back from the fields it knows, capped and type checked.
When nothing answers on the channel, which means a collector from 0.5.0 or earlier is still
running in a tab after an update, the bridge asks over `window.postMessage` as those did.

The collector listens on at most eight channels (`CHANNEL_LIMIT`) and lets the oldest go when
another arrives: every reload or update of the extension leaves a bridge behind that can no longer
reach the extension, and the newest bridge is the live one. It sets no global, so a page cannot
read a name that says the extension is installed. A second copy of it asks whether one is already
running with a `__cdr_probe` event that carries a function of its own, which a running collector
calls. It used to go by whether the event was cancelled, so a page whose `dispatchEvent` cancelled
every event, or did not return what the native one returns, was taken for one with a collector,
and none ever started there. The worker's own check, sent from the extension's isolated world, is
answered by cancelling the same event, because a function cannot cross between the worlds (see
[A tab that was open before](#a-tab-that-was-open-before)). A page script written against this
extension can still call the function or cancel the event itself. A collector started late on
that page then does not start, and the panel finds no log there.

Every event the collector sends or reads on the window goes through natives it took at
`document_start`, before any page script ran: `dispatchEvent`, `addEventListener`, the
`CustomEvent` constructor, the `detail` getter and `preventDefault`. Each event it sends is built
from an init dictionary with no prototype and every member its own, and the lists it writes while
answering are written with `defineProperty`. Every field of a recorded entry is the entry's own
data property from the moment the entry is made, written by an object literal or with
`defineProperty`, so a setter or a getter the page planted on `Object.prototype` or
`Array.prototype` never runs with an entry. A plain `event.detail`, a dictionary member Chrome
looks up through `Object.prototype`, or an index assigned on an array, would run a getter or a
setter the page put there, in the middle of answering the bridge with the request on
`window.event`, and the page learned the channel that way, then read every snapshot and answered
in the collector's place. So a getter the page later puts on `CustomEvent.prototype`,
`Event.prototype`, `Object.prototype` or `Array.prototype` never runs while a request is
answered. A collector the worker starts on a tab that was already open takes these natives as
they are at that moment, so a page that has replaced them by then can still learn the channel of
that one collector.

The declared content scripts exchange the hello at `document_start`, before the page has run a
line, so a page script that says `main` later is told nothing. What a script written against this
extension can still do is said in the collector itself, at the end of `collector-main.js`. It can
tell the extension is installed, by sending `__cdr_probe` and seeing it cancelled, or the function
it carries called: the guard needs a signal that two copies of the collector can both see in the
main world, and the page sees it too. It can say a `__cdr_hello` of its own, naming a channel it
made up, and read the log over it, lines logged before it ran included. It can say eight of them
and push the live bridge's channel out, which leaves the page's log unread and the panel showing
the reload advice. And when the extension starts on a tab that was already open (see
[A tab that was open before](#a-tab-that-was-open-before)), the bridge has to announce its
channel where a page listener can hear it, and a script listening then can read every snapshot
over it and answer in the collector's place. None of this lets it put anything into a prompt that
it could not put there by logging made up lines, which any page can do, and what it can read is
the page's own console and network activity, which it could record anyway by wrapping the same
functions.

The picker still asks what rendered a node over `window.postMessage`, and that answer is about
the node alone. The same boundary is why the element picker cannot read a React fiber itself.
React hangs the fiber off the DOM node as a `__reactFiber$<random>` property and Vue hangs
`__vueParentComponent`, and those properties live on each world's own wrapper of the node, so
an isolated world script sees a node with none of them. The DOM itself **is** shared, which is
what the handoff uses: the picker sets a random `data-cdr-pick` attribute on the clicked
element, asks for it by that value, and the main world finds the node with `querySelector`, and
inside open shadow roots when that finds nothing (`findMarked`, which walks at most 20 000
elements looking for them). Both sides remove the attribute, because the timeout path is a page
where nobody over there ever saw it.

Two ordering constraints fall out of that. The attribute goes on **after** the picker has read
`outerHTML` and the node's attributes, or `data-cdr-pick` appears in the markup printed in the
user's prompt. And the round trip runs **concurrently** with the two animation frames the
picker already waits for, so the 300ms timeout costs nothing on a page that answers. A tab whose
main world never answers (one with no collector) waits it out once; after that the picker skips
the lookup until a ping it sends on each arm is answered.

The reply carries two things, `component` and `handlers`, either of which may be absent. Handlers
come from a different property than the component does: React keeps a host element's own props on
the node as `__reactProps$<random>`, in a production build as well as a development one because
event dispatch reads them back from there, and Vue keeps the same names on `__vnode.props`.
Neither is the fiber, so the two lookups climb independently and their hop counts can differ.
That is why the prompt never presents them as one number.

Whether a handler's body is worth printing is decided by the text itself rather than by the build
label. The test is whether the author's own names survived: an identifier of four characters or
more, outside a string, that is not one a minifier keeps, and not read after a dot unless what it
is read from is `this`, `super`, `window`, `document`, `globalThis` or `self` (`hasAuthorNames`).
Minified code still says `preventDefault`, `value` and `return`, as properties and keywords, so a
run of four letters anywhere passed a minified body as readable. A property read straight off
`this` or the window is the author's name in any build, so `this.toggle()` and
`window.location.reload()` count, where `e.preventDefault()` and `r.current.focus()` do not.
Gating on a development build was both too strict, because Vue's development bundle sets no flag
this code can read, and too loose, because a production build that keeps function names still
has a minified body behind a real name.

Props are printed unless they could carry a secret (`summariseProps`). A prop whose own name is a
secret name is withheld. When a component is inspected, the collector also reads the live values
of the page's secret controls (`reactGuard`, `vueGuard`): the controls the component renders, up to
3,000 nodes, and the document's own (`documentValues`). Those are elements of type password,
elements whose autocomplete says `current-password`, `new-password`, `one-time-code`, `cc-number`
or `cc-csc`, and form controls whose name or id is a secret name such as `csrf_token`. In the
document it reads at most 32 of each kind, judging the names of the first 256 inputs, text areas
and selects, and looks one level into the open shadow root of a design system's own element. A
string or number prop is withheld when it equals one of those values, contains one of four
characters or more, or is a piece of four characters or more that covers at least half of one, so
a seed the user typed on the end of still matches (`holdsSecret`). `value`, `defaultValue` and
`modelValue` of a component that renders a secret control, or whose own `type` or `autoComplete`
says it is one, are always withheld. A hidden input is what a form carries along (a product id, a
CSRF token beside a search box), so its value is held only when it is the pick itself or its name
or id is a secret name, and rendering one does not make a component's value props secret, though
a component whose own `type` is hidden has them withheld. `cc-name` and
`cc-exp` alone mark nothing: they hold nothing secret, and a form whose card number sits in a
payment provider's frame has only those. All the text and number props of a component that
rendered a password field used to be withheld, its title, its error message and its total
included, while a strength meter handed the password without rendering the field still printed it.

A component that renders a control taking a password, a one time code or a card's digits, known by
its type or autocomplete rather than by a name alone (`guard.password`), also has its string props
judged by shape (`secretShaped`): one of 8 to 256 characters with no whitespace that holds a letter
and a digit is withheld, and beside a code or card control (`guard.digits`) so is a run of three
digits or more, perhaps grouped. That catches what no field holds yet, such as a confirm field
handed the first password after the step that held it unmounted, or a card number handed to a
review step. Names that point at another element (`className`, `class`, `id`, `htmlFor`, `for`,
`key`, `ref`, `aria-*` and its camel case form, `data-*`, and any name ending in `Id`, `ID`, `_id`,
`UUID`, `For` or `By`) are exempt, and so are values shaped like a path, a URL (with `://`, or a
`blob:`, `data:`, `mailto:` or `tel:` one, which the prompt screens as a URL) or an ISO date or
month, checked before the digit rule, so a delivery date beside a card field prints. Numbers are
judged by value only. A field marked only by a secret name (an email, address or phone field) has
its own value withheld but brings no shape rule: the ids of every shipping, newsletter and profile
form were withheld when it did.

What that cannot catch is a value in no field with no secret's shape (a passphrase with spaces, a
password of letters only or shorter than eight characters), any such value handed to a component
that renders no password, code or card control, and a seed of that kind the user changed in the
middle rather than typed on the end of. In a component the shape rule applies to, ordinary strings
of that shape are withheld too, such as a coupon code or an order number like `ORD-2024-00123`. A
field inside a shadow root is found in the document only when its host element says it takes a
secret (type password or a secret autocomplete), and one in a frame is not found.
`payment_method_nonce` and other one time payment nonces are not secret names, so they print.
Measured in Chrome for Testing on a page of 60,000 elements, 20,000 of them inputs, the document
scan costs about 3 ms a pick, nearly all of it the selector, which has to look at every element.

#### A tab that was open before

Chrome injects the declared content scripts only into pages loaded after the extension was
installed, enabled or reloaded. A tab open from before has no collector, or one whose bridge can
no longer reach the extension, so the panel's read of it finds nothing to answer. Telling the user
to reload would throw away the very state they opened the panel to report, so the panel sends
`cdr:collect` instead, and the worker starts the collector itself.

It starts one only where the declared content scripts would have run. `host_permissions` lets
the worker script any page, but narrowing the `content_scripts` matches is how a user keeps the
collector to their own sites, and a collector started on any tab would quietly undo that. So the
worker reads the manifest's own `content_scripts` (`collectorDeclaredFor`) and starts one only
when both entries cover the tab's URL as Chrome decides it for a content script: in `matches`,
not in `exclude_matches`, in one of `include_globs` if there are any, and in none of
`exclude_globs`. `matchesPattern` reads a match pattern as Chrome does, with the pattern's host
canonicalized as a URL's is (lower case, an IDN in punycode, an IP address in its one written
form), a trailing dot dropped from both hosts, and the path matched against the URL's path and
query, and it was checked against Chrome for Testing 156's own matching. `matchesGlob` is a port
of the matcher Chrome uses for globs, run on the whole URL: `*` is any run of characters, `?` at
most one, and it does not backtrack.

A site the manifest leaves out gets nothing at all, not even the probes below: a page there could
answer them as a collector and have a bridge put in. The one exception is a URL on a site the
manifest declares, its scheme, host and port, at a path it leaves out (`collectorSiteDeclaredFor`).
The site is in when Chrome would run the collector on some URL of it. Every rule can be about hosts
as much as paths (a glob is matched against the whole URL), so rather than read the rules, the
worker asks `collectorDeclaredFor` about URLs of the site that the rules themselves suggest: the
URL, the site's root, and each `matches` pattern's and `include_globs` entry's own path put on the
site, and for a glob with no scheme its whole text as the path (`*app*` runs on
`https://any.site/app`). Each has its wildcards filled twice, left empty and given a letter no
exclude holds, so that an exclude naming only some paths (the root, any path ending in `/`, a
pattern's own path) cannot take out every URL tried while others still get the collector, and each
pattern's path is also tried next to each glob's, in either order (matches `/app/*` with
include_globs `*/admin*` runs on `/app/admin`, and matches `/*.html` with include_globs `*?x*` on
`/x.html`). A glob that names a scheme is taken to name a host and is not tried as a path, so a
host glob (`*://*.example.com/*`) declares no other site because of a path such as
`/.example.com/`; the cost is that `*://*app*` declares a site only at a URL that already matches
it, though Chrome would run it on any site's `/app`. Each is written as Chrome writes it before a
rule is tried on it (`café` as `caf%C3%A9`), and kept only if it is still on the site. Where none
of them would get the collector, the site is taken to be out: an include glob the same entry's
exclude glob cancels, or one whose text no URL holds as Chrome writes it, declares nothing. A
single page app can have moved to such a path from the one the declared collector started on, and
that collector's log is still the one the user came for, so the worker asks for it and bridges it,
but never starts one there. Where nothing is started or bridged, the reply says why:
`{ ok: false, outside: 'site' }` when the manifest keeps the collector off the whole site, and
`{ ok: false, outside: 'path' }` when it declares the site but not this URL and no collector was
found running. The panel then says "No log on this tab. The collector is set to run only on other
sites (the content_scripts entries in manifest.json).", or "only on other pages of this site" for a
path, instead of the advice to reload, which would not help there either.

The exception has a price. On a declared site, a page at a path the manifest leaves out can
answer the worker's probe itself, and the panel then reads whatever it answers: made up lines in
the log section of the prompt, as a page on a declared path could always put there by logging
them. The probe is also an event that page can listen for, which tells it the extension is
installed. Leaving a host out of `matches`, or an `exclude_matches` pattern for the whole site,
keeps the extension off it entirely.

Where it may, the worker first asks the page whether a collector is already running, in two
ways: from the extension's isolated world it sends the cancelable `__cdr_probe` event, which a
collector of 0.6.0 or later cancels, and in the main world it reads `window.__cdrCollector`, which
a collector of 0.5.0 or earlier set. After a reload or an update of the extension the old
collector is usually still in the page with everything it logged since the page loaded, so only
when neither answers, and the declared scripts cover the URL, does it inject
`content/collector-main.js`; a new bridge goes in either way. Both go in with
`injectImmediately`, so a page still loading starts collecting at once rather than at
`document_idle`. The panel asks once per page in each tab, so a page that refuses the collector
(a PDF, an error page) is not asked again on every read, and its notice keeps the advice to
reload. Each read waits two seconds at most for that answer, but the request goes on: the worker
may still be injecting into a busy page or starting up cold, so a slow answer is not taken for a
refusal. That read reports a timeout, as a slow read of the log does, with no advice to reload;
the next read waits on the same request rather than sending another; and the chips are read
again once it succeeds. A refusal that comes late still counts, and the footnote shows it when it
comes.

Whether the log is partial is neither the worker's guess nor the panel's memory, and the page
cannot tell it either. Only the worker knows it is starting a collector after the page began, so
just before it injects `content/collector-main.js` it puts a listener in the extension's isolated
world (`markLate`) that cancels the cancelable `__cdr_late` event the collector sends as it
starts. A declared collector sends the same event at `document_start`, in a document `markLate`
never ran in, so nothing cancels it there. A collector whose event was cancelled, or that finds
`document.readyState` past `loading` (where a declared one never starts), records `late: true`
and says so in every snapshot, which the bridge passes on only when it is exactly `true`. Before
the event, a late start was judged by whether a script was already in the document, and another
extension's `document_start` script adds one before the page has run a line, which made a
complete log look partial; a page still loading may also have run a script that removed itself.
Whether the event was cancelled is read off the event itself, through the native
`defaultPrevented` getter, not from what `dispatchEvent` returned: a wrapper of `dispatchEvent`
that drops the value (another extension's `document_start` script, say) said every event was
cancelled. Another extension whose `document_start` script makes `dispatchEvent` cancel every
event still makes a declared collector's log say it is partial. For as long as a collector that
started late runs, through a closed and reopened panel and through further reloads or updates of
the extension, the panel says so under the counts and the prompt says from when the log was
collected, so an empty stretch before that does not read as a quiet page. A page script can
listen for `__cdr_late` too, but only once it runs, so what it can change is what its own log
says about its start: on a late start into a page still loading, it can stop the event before
`markLate` hears it, or make `document.readyState` lie, and hide the caveat. That changes nothing
in the log itself.

The footnote says "Collecting from now" for the first ten seconds after the start, since a panel
opened again later would otherwise call an old start "now", and after that "Collecting since"
with the time it started (`collectingSince`). That time is on a 24 hour clock in Latin digits,
with the date, year first, when the start was on another day ("Collecting since 21:05 on
2026-11-16"), as the prompt prints its stamps: `toLocaleTimeString` gave "09:05 PM" in one locale
and native digits in another, and a bare "21:05" read the next morning as a time still to come.
The prompt gives the same moment to the second, with its offset from UTC. A reload of the page
brings a collector that started with it, and the note goes. What it cannot catch is said rather
than hidden: anything logged or requested before it started, and a request made through a
reference to `fetch` the page took before the wrapper was there.

On such a tab the collector also runs after the page's own scripts, which may have replaced what
it relies on. It wraps only what is still a function where it expects one, and leaves alone what
the page has made read only: a page that replaced `XMLHttpRequest` with a constructor of its own
(xhook), made `fetch` read only, or put something else where a console method was, keeps working,
and the collector records what it could wrap and throws nothing into the page. It never uses
`window.Promise`: a `then` taken from there made every fetch throw on a zone.js (Angular) or
Bluebird page. At `document_start` it settles a fetch through the engine's own `then`, taken
before any page script ran, so a page that later replaces `Promise.prototype.then` (core-js
forcing its own Promise) sees no extra calls. After a late start the `then` on the prototype is
whatever the page left there, so an `await` stands in, which reacts inside the engine where the
promise's constructor is still the engine's, as on zone.js and Bluebird pages. Where core-js has
replaced the engine's Promise, each failed or answered fetch costs one call of the page's `then`.
On a zone.js page the collector takes `setTimeout` and `addEventListener` from the natives
zone.js kept under its own names, so recording a request adds no change detection pass in
Angular.

### The heavy lifting is in the side panel, not the service worker

An MV3 service worker has no DOM, so there is no canvas to crop with, and
`URL.createObjectURL` is not exposed to it, so there is no way to hand a generated file to
`chrome.downloads`. A side panel is a full extension page and has both, plus direct access to
every `chrome.*` API it needs.

So the worker stays thin. It owns only what must survive the panel being closed, or hear it
close: side panel behaviour, the keyboard command, script injection, the armed tab map, and the
port that disarms a tab when the panel that armed it goes away.

The panel holds that port while a mode is armed. Chrome stopping the worker closes the port from
that end, and the panel opens a new one. A port shut within a second of opening is reopened at
once the first time. After that the panel waits 100 ms, and twice as long each time up to two
seconds, so a worker stopped twice in quick succession is held again before the panel is likely
to close, and a port that is always shut is not reopened in a loop.

One trap worth knowing. `activeTab` cannot stand in for `host_permissions: <all_urls>`, which is
why that is required rather than optional. Chrome grants `activeTab` for one tab when the user
invokes the extension (the shortcut, or a click on the toolbar icon) and takes it back when that
tab navigates, while the panel stays open across tabs and navigations and captures whichever tab
is in view. Here the toolbar icon opens the side panel (`openPanelOnActionClick`), and whether
that click still grants `activeTab` is not documented.
`captureVisibleTab` needs one or the other, so with neither it fails on every page.

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

Saving early has a consequence the code has to honour in three places. An item discarded
before it was copied never appears in any prompt, so its file is deleted again with
`downloads.removeFile` and its history entry with `downloads.erase`, once the few seconds in
which the discard can be undone have passed. A sheet dropped after a week untouched was never
copied either, so its files go the same way. The reset after a successful copy must do the
opposite and leave every file alone, because the prompt on the clipboard names each one by path
and Claude Code is about to open them.

It also means the panel never has to keep a full image. Each item holds a WebP thumbnail no
wider than the frame can display, and the original data URL is released once the download
has started. That is what makes the report safe to persist: `cdrReport` in
`chrome.storage.local` holds every item minus its pixels and is rewritten on every keystroke,
and `cdrThumbs` holds the thumbnails and is rewritten only when an item is added or removed.
An item is only written once it has a path, so a panel closed mid-save cannot come back
showing a description of a file that does not exist. A report untouched for a week is dropped
at startup, and the screenshots of its items are deleted from disk and erased from the download
list, because no copied prompt names them; a panel still showing that sheet in another window
keeps both. Files can also go missing within that week, because Downloads folders get emptied,
so the panel asks `chrome.downloads` whether each one still exists and holds Copy back while a
missing item is ticked (see [The sheet in storage](#the-sheet-in-storage)).

Side panels are per window, and every one of them reads and writes the same keys. Rather
than let the last writer win, each write is stamped with the writing panel's id and every
panel listens to `chrome.storage.onChanged`: a change carrying another panel's id is merged into
the local sheet item by item. Two windows therefore show one report. The toggle settings and the
intent are written separately from the report, so a panel that never captured anything cannot
overwrite a report by unticking a box. [The sheet in storage](#the-sheet-in-storage) has the
details.

## Message protocol

Every message is a plain object with a `type` field prefixed `cdr:`. The prefix, like the
`cdr*` storage keys and the `__cdr*` globals the isolated world scripts cache on their own
`window` (the collector, in the page's world, sets none), is the
initialism of the project's original name, Claude Debug Reporter. It stayed through the
rename because it is internal, and changing it would touch every file for nothing a user
could see.

| Message | From | To | Purpose |
| :--- | :--- | :--- | :--- |
| `cdr:arm` | panel | worker | Inject overlay or picker into a tab, under a fresh `armId` |
| `cdr:disarm` | panel | worker | Tear down whatever is armed there, and every arm asked for there so far, replying once the page has repainted without it, within about a second on a page that has not reached `document_idle` (the cancelled arms then come down as they land). The reply says `superseded` when an arm was asked for there meanwhile, whose overlay may be on the page |
| `cdr:verify` | panel | worker | After a navigation, ask the page which mode, if any, is still live on it |
| `cdr:check-tab` | panel | worker | Ask whether a tab is usable, and what is armed on it |
| `cdr:collect` | panel | worker | Start collecting on a tab where nothing answered the panel's read: bridge a collector already running there, or start one where the manifest's `content_scripts` would have run (see [A tab that was open before](#a-tab-that-was-open-before)). `{ tabId }` gets `{ ok: true, fresh }` once a collector and a bridge are in the tab, `{ ok: false, outside: 'site' }` when the manifest keeps the collector off the tab's whole site (nothing is injected), `{ ok: false, outside: 'path' }` when the site is declared, the tab's URL is not, and no collector was found running there, or `{ ok: false, error }` |
| port `cdr:panel` | panel | worker | Opened while a mode is armed. The panel posts `cdr:holding` with the tab it holds, or `null`. When the port closes because the panel closed, the worker disarms that tab. A panel still armed reopens the port when the worker is stopped, after a growing pause if it keeps being shut as it opens |
| `cdr:armed` | worker | panel | A capture mode is now waiting on a tab. Carries the `armId` of the `cdr:arm` behind it, or none for the shortcut, so a panel can ignore the echo of an arm it cancelled in flight, and the `run` the injection answered with |
| `cdr:region-selected` | overlay | panel | A rectangle was dragged, or selected with the keys |
| `cdr:element-picked` | picker | panel | An element was picked |
| `cdr:capture-cancelled` | overlay, picker | panel | The user pressed Escape, or a pick failed on the way |
| `cdr:get-context` | panel | bridge | Read the collected buffers plus page info |
| `cdr:clear-context` | panel | bridge | Empty the buffers |

Each start of the overlay or the picker names a run. The injection returns it, `cdr:armed` and
`cdr:check-tab` carry it, and every message from that start carries it, so a late message from
an earlier run cannot end a newer arm of the same mode. Runs are compared only when both sides
know one. A disarm always queues `content/stop.js` as a file, behind any arm file still being
read, so it lands after that arm even if the worker is stopped straight after.

Inside the page the picker uses a second, smaller protocol, carried on `window.postMessage`
rather than `chrome.runtime`. Every message is `{ __cdr: 'request' | 'response', id, ... }` and
the main world answers exactly one action per request.

| Action | From | Purpose |
| :--- | :--- | :--- |
| `inspect` | picker | Return the React or Vue component behind a marked node, and the handlers bound to it |

`snapshot` and `clear` go over the bridge's channel instead. Over `window.postMessage` they
answer `null`, like any action this build does not recognise (the picker's `ping` among them,
which only waits for an answer). That is load bearing rather than tidiness. Reloading the
extension does **not** re-inject the declared content scripts into tabs that are already open,
so an old main world script keeps running there while a freshly injected picker talks to it,
and a script that answered every unknown action with the snapshot would hand the picker a console
buffer to present as a component. The bridge, when it falls back to an old collector, and the
picker keep their ids apart by type, numbers from the bridge and strings from the picker, so
each ignores the other's replies on a window they both listen to.

A few things about the first table are load bearing.

**`chrome.runtime.sendMessage` has no addressing.** A content script's broadcast reaches every
open side panel, and side panels are per window. The panel therefore filters on
`sender.tab.id` before acting. Without that filter, dragging a region in one window makes a
second window's panel screenshot its own tab, crop it to the first window's rectangle, and
present the result as a valid capture, with no error anywhere.

**Armed state is tracked in two places on purpose.** The panel keeps it for the UI, and the
worker keeps a map so a panel that opens later can learn about it. The one shot `cdr:armed`
broadcast is not enough by itself, because `Alt+Shift+C` opens the panel and arms the page in
the same breath: the message can be sent before the panel document exists to hear it. The
panel picks the state up from the `cdr:check-tab` reply instead. A capture message ends the arm
in both places only when the mode armed is the one that sent it: a drag's message comes two
frames after the release, and the other mode armed in between is live on the page.

**The worker orders an arm and the disarm that cancels it.** A cancel can come while its arm is
still on the way (Esc straight after a mode button, on a cold worker or a busy page), and the
shortcut can arm the same tab in between. Only the worker sees all of these in the order they
were made. The panel hears of the shortcut only through the broadcast that goes out when that
arm lands, so a cancel it sends may know nothing of it. The panel therefore sends its disarm at
once, and the worker applies one rule, order alone: a disarm cancels every arm asked for on that
tab before it, and an arm asked for after it stands. In practice the worker:

* counts disarms per tab, and each arm takes the count when it is asked for. An arm whose count
  has moved before it injects drops out with nothing put on the page, and one whose count moves
  while it lands does not record itself as live;
* drops an arm before it injects when a newer arm was asked for on that tab, because each arm's
  lookups answer in their own time and an older one answered late would take the page back. An
  arm replaced while it lands neither records nor announces itself;
* puts a stop in the page's queue at once, where the page runs it at `document_idle` straight
  after every arm already sent there, so the cancel holds if Chrome stops the worker during the
  wait below;
* waits for every arm still landing before the stop it answers on, because a file injection is
  read from the package first and a function injection is not, so a stop sent second could reach
  the page first. The wait is bounded at a second, since a page that never reaches
  `document_idle` never lands an arm; when it runs out, the worker queues a second stop, which is
  behind every cancelled arm by then;
* skips the stop if an arm was asked for while it waited. That arm came after the cancel, lands
  after the ones cancelled, and its `start()` takes the page over, stopping the other mode if
  need be;
* otherwise answers once a stop that the page runs at once, rather than at `document_idle`, has
  run and the page has painted without the overlay.

An arm that finds, once it has landed, that a disarm came while it did queues a stop of its own,
unless a newer arm was asked for. The disarm's stops are usually behind it already, but a file
Chrome took longer than the bounded wait to read lands after all of them, and nothing else would
take it down.

Every arm from the panel carries an `armId`. The panel remembers the ids of the arms it
cancelled or replaced and refuses both their `cdr:armed` broadcast and a `cdr:check-tab` answer
that names one. The shortcut's arm has no id, so it is news unless the panel's armed state
changed while the `cdr:check-tab` that names it was asking, in which case the worker may have
read that answer before the change.

**A navigation is checked, not assumed.** Chrome reports `pushState`, `replaceState` and a hash
change as status `loading`, exactly as it does a real navigation, and only the real one takes
the overlay with it. So on `loading` and on `complete` for an armed tab, the worker asks the page
which controller is active (each exposes `isActive()`), after any arm still landing, and panel
and worker go dark only if neither is. An arm counts as landing from the moment it is asked for,
not from its injection: a check that arrived while the worker still looked the tab up would
otherwise ask a page the overlay had not reached, and turn the button dark over the overlay that
landed a moment later. One probe runs per tab at a time. A request that comes while one runs
waits for the next probe, which starts when that one ends and answers every request that came
meanwhile, so a URL change costs two injections rather than four, and no request takes an answer
read before the change it asks about. The overlay and the picker also stop themselves on
`pagehide`, so a page restored from the back/forward cache cannot come back with a live overlay
nothing outside it knows of.

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

What counts as failed is decided by status. A fetch is recorded at 400 or above, as an XHR
always was, because `response.ok` is also false for a no-cors response, a manual redirect and a
304, none of which failed. A rejection the page caused itself, through the request's
`AbortSignal` or an XHR `abort` or `timeout` event, is recorded with an `outcome` of `aborted` or
`timeout`, and the prompt prints it after the real failures under that label. The signal is
asked rather than the error, because `abort(reason)` rejects with whatever reason the page
passed. A fetch Chrome refuses for its own arguments (a body on a GET, credentials in the URL, a
URL it cannot parse, an invalid header name) never reached the network, so it is no failure of
the server or the connection. Chrome rejects it with a `TypeError` whose message starts "Failed to
execute 'fetch' on", where a request that failed after it was sent says "Failed to fetch"
(`refusedBy`). The collector records it with a status text of `Not sent: ` and that message, and
the prompt prints it as NEVER SENT with the message in parentheses, in its place in time, rather
than as FAILED, with no duration, since it spent no time on the network. The message is screened
like a URL, because Chrome's message about a URL it could not parse repeats the URL. For a URL
with credentials in it the line adds that they were removed from the URL as printed, since
Chrome's message still says the URL includes them.

A promise the page's own fetch returned that is not a plain engine promise (it has properties of
its own, such as an `abort` method, or another prototype, as a library's has) is handed back to
the page as the same object, and the collector watches it on a side chain (`watched`). A new
promise in its place lost those properties and that identity, and the page threw "p.abort is not
a function". Because any observer marks a promise as handled, a rejection of such a promise that
the page leaves unhandled is not reported by the browser as an unhandled rejection, though it is
still recorded as a failed request. Plain engine promises are unaffected.

An XHR object can carry two requests at once. A page may reopen it from inside a handler of the
request that is just finishing (a retry in `ontimeout`, the next long poll in `onload`), and
Chrome still dispatches that request's `loadend` afterwards, with the status already reset by
the reopen. So each `open()` starts a record of its own, a reopen parks the finishing record
with the status it ended on, and late events are credited to it. They are told apart by
`readyState`: the finishing request's own events arrive while the object is DONE, the late ones
after the reopen has moved it back to OPENED. An `abort()` on a finished request parks it the
same way, because Chrome fires no event for it and drops the object to UNSENT with status 0
before the `loadend` arrives. A park is only committed once the native call has gone through,
so an `open()` the browser refuses (a bad method or URL) leaves the bookkeeping as it was. Parks
can nest: a handler of a parked request can finish a second request synchronously and reopen
again, and Chrome then delivers the inner request's late events before the outer one's, so the
parked slot is a stack. A handler can also run a synchronous request to the end without
reopening, leaving the object DONE for a request that has already settled; a settled record
gets no more events of its own, so what arrives next goes to the parked one. If no late event
ever comes, a zero delay timer settles the parked record. Chrome can also deliver a `loadend`
before the abort or timeout event, when a handler runs a synchronous request to the end, so a
parked request that ended with no response and has no label yet is left to that timer and
recorded a task later. That timer, and the collector's own listeners, go through the `setTimeout` and
`addEventListener` the page had at `document_start`, not whatever zone.js or a fake clock has
put in their place since, so an Angular page does not run change detection for them. A collector
started after zone.js takes the natives zone.js kept (see
[A tab that was open before](#a-tab-that-was-open-before)).

The bookkeeping lives in a `WeakMap` inside the collector, not on the object, so the page never
sees it in `Object.keys` or `JSON.stringify`, and nothing is written onto a `this` that is not an
`XMLHttpRequest`. An `open()` over a request still in flight records that request as aborted,
because Chrome cancels it without dispatching any event, `loadend` included. An `abort()` labels
its request before the native call and settles it after, so a page listener that stops the abort
or `loadend` event cannot hide it. The listeners go on at the first `open()` rather than the first
`send()`, so a listener the page adds between the two cannot stop an event before it reaches
them; one added before the first `open()` still can.

A synchronous request that fails at the network level is the one case with no event at all:
Chrome throws `NetworkError` out of `send()` and fires nothing, `loadend` included. The send
wrapper settles that request in its catch, and only when the throw moved the object from OPENED
to DONE, which tells it apart from a `send()` the browser refused outright.

Frames are filtered down to the page's own code. A frame is kept only when its path ends in
something that looks like a file extension, since a bare document path is a route rather than a
file and printing one sends the reader hunting for source that never existed. Framework dispatch
frames are dropped too: only three frames are kept, and on the React fixture the third slot went
to `react-dom`'s internals while the page's own caller sat just below the cut.

Thirty frames are recorded to choose those three from, because axios alone puts seven between its
caller and `open()`. Frames are skipped by path (`node_modules`, `react-dom`, `zone.js`, Vue's
builds, and files named after axios, jQuery or superagent) and, for a library bundled into the
page's own file, by names only a library uses (axios's dispatch chain and its bound methods such
as `wrap [as get]`). A minified bundle keeps none of these names, and there the nearest frames can
still be the library's.

An async function compiled for an older browser runs through a helper of its compiler's:
TypeScript's `__awaiter` and `__generator`, Babel's `_asyncToGenerator` with or without
regenerator, esbuild's `__async`, and SWC's copies of these. Each puts four to nine frames of its
own between the line that awaits and the function's caller, and does it again for every compiled
async function further down, so the three slots went to the helpers (axios's own build is
compiled this way) and the page's caller was cut. Those frames are skipped too, by names only the
helpers use, and by their shape for the inner functions whose names a page's own function could
also carry (a wizard's `step`): such a frame counts as a helper's only next to one already known
to be (`helperFrames`). Two of them carry no telling name. SWC's `_ts_generator` defines its
iterator's `next` with `defineProperty`, so V8 calls that frame `Object.<anonymous>`, and Babel
7.27 and later put an anonymous wrapper just below regenerator's body when it is reached through
`regeneratorRuntime`; each is known by where it sits. A frame of a helper this file does not know
is printed as it is, never folded under the name of the page function below it, which would print
the helper's line under that name and send the reader to the wrong file.

Every wrapper is a Proxy of the native it replaces (`wrapNative`, with only an `apply` trap), so
its name, length and `toString` read as the native's, and `callerFrames()` recognises the
collector's own frames by its address rather than by function names. It matches the whole
address, so a page file that happens to be called `collector-main.js` is still the page's.

That address is `punch-list://extension/collector-main.js`, which the collector declares as its
`sourceURL`. V8 gives the script that address in stacks and console messages, and a CSP report
names its scheme, instead of `chrome-extension://<id>/content/collector-main.js`. Chrome reports
a console message whose topmost frame is in a `chrome-extension` URL in detail, capturing and
formatting the whole stack again, whether or not developer mode is on, and every `console.error`
and `console.warn` a page makes reaches the native from the collector's wrapper. Measured in
Chrome for Testing 156 with no DevTools attached, that cost about 148 microseconds a call, and
0.9 ms from a stack 30 frames deep, against 3 microseconds without the extension; under the
sourceURL the same calls cost what they cost with no extension at all. A stack the page reads
(an error monitor's, say) that passes through a wrapper no longer carries the extension's id
either. A scheme of its own still says whose frame it is, which a relative name would not: a CSP
report would then name no source at all, and the name could pass for one of the page's own
files. The file name goes in the path, not the host, because DevTools names a script by the last
segment of its path. Called `punch-list://collector-main.js`, whose path is empty, the collector
was named "(index)", the name DevTools gives the page's own document, so with source maps off
every page `console.error` linked to "(index)" and a line number. Now it links to
`collector-main.js`.

A request the page's Content Security Policy blocks is reported by the browser, to the page's own
`securitypolicyviolation` listeners and in the site's CSP reports with `punch-list` as its source,
because the topmost frame when the native is called is the wrapper. That cannot change without
delaying every request the page makes. The collector listens for enforced `connect-src`
violations instead and labels the matching failed request as blocked by the CSP, with that
explanation, next to the page's own caller.

### The log is a timeline, split by capture

The collector keeps four rings of `LIMIT` entries: console errors, warnings, uncaught errors and
failed loads, and failed requests. Warnings have their own because a development build can warn
dozens of times per render, and in a shared ring that pushed out the error the report was about.
For the same reason, a full ring of failed requests drops a request the page ended itself (an
abort, a timeout it set, an `open()` over it) before any real failure, so a type-ahead that
cancels a request per keystroke cannot push out the failure the report is for. Each ring counts
what it drops, and the snapshot carries the counts, so the prompt can say the
log is the tail of a longer one. Every entry gets `t`, milliseconds since the collector started
(`armedAt` in the snapshot), and `seq`, one count across all four rings: a failed request, the
warning it causes and the throw after it routinely share a millisecond, and only the count keeps
them in the order they happened. Both clocks the collector reads, `Date.now` and
`performance.now`, are the ones the page had at `document_start`. MockDate, sinon's fake timers
and Playwright's `page.clock` replace them later, and `t` is compared with the panel's own clock.

The template merges the rings by `t` and then `seq` and prints a clock time in front of each
entry, built by hand rather than with `toLocaleTimeString` so every line of a prompt has the same
width, with the date in front when the entry falls on another day than the report. The page
section gives its times year first with the machine's offset from UTC
(`2026-08-07 20:51:33 UTC+02:00`), so they read the same in every locale and can be set beside a
server's log. The zone is given once: by the Captured line when the page prints, and, with the
page toggle off, by a line that names the zone and the day of the entries that carry no date
(`clockNotice`). A single report gives that line under Console and network. A list that prints a
log under any item gives it above the first item, so before the first log line it qualifies, and
not again at the end. The frames printed under errors and requests, and a component's call site
read from a stack, are positions in the code the browser ran, and the prompt says so once, beside
the sentence that marks page text and screenshots as evidence rather than instructions
(`pageData`), rather than on every frame. The call site line says only that it was read from a
stack ("Call site read from a stack:"), since one React recorded is exact. A run of entries that
would print the same (the timing of a request aside) folds into the first, with a count and the
time of the last. A single item keeps the two sections it always had,
each in time order, with cancelled requests after the real failures.

A list splits the log by capture. Each item's `capturedAt` is read just before
`captureVisibleTab` takes the pixels, not when the item is added after decoding and cropping, so
an entry logged in between goes to the next capture. When an item is added, the panel's next
context read tells it which load of the page the capture belongs to, and the item keeps that
`armedAt`; a read whose collector started after the capture is ignored, since that load came
later. When the report is copied, an item whose `armedAt` matches the log's gets the entries
logged since the capture before it, and entries after the last capture get a section of their
own. An item from another page, or from another load of the same address, says its entries were
not read. Another load is not called a reload, because a second tab open on the same address
looks the same. An item with no `armedAt` (stored by an older build, or captured on a page too
busy to answer) is judged by its page and its capture time, and only when both are known: the
panel passes the url it read the log on as `readUrl`, which is compared and never printed, so
the page toggle off does not leave the template guessing. Before a log that started late (see
[A tab that was open before](#a-tab-that-was-open-before)), an item captured earlier says it was
captured before collection began rather than before the page last loaded, since no reload came
between, and the first item's share of such a log is headed "Logged since collection began,
before this capture" rather than "on this page load". When a ring dropped entries, each item
whose stretch of the log starts before the oldest entry that ring kept says its log may be
incomplete, since a quiet stretch would otherwise read as a clean one.

When no item comes from the load that was read, or nothing was read, a list falls back to the
global sections and cautions, as does a single item: in that layout the caution is the only line
that says where the screenshot was taken. With the page toggle off the caution still prints, at
the head of the Console and network section, and names neither page. A caution names the
screenshot only when the item has one, and the entries below only when some print
(`staleCaution`). When none print it still says what the empty log does not show, since an empty
log reads as a quiet page: that it says nothing about the capture, or, before a late start, that
nothing logged up to the capture was recorded.

In a list the page block is headed "Page when the report was copied", since it describes the tab
at that moment and not where each item was captured. When nothing could be read, the page is the
newest item's own rather than the tab in view, and the block is headed "Page the last item was
captured on" instead. The items carry the sheet's numbers when every item sends one and they rise
in order, and otherwise their places in the prompt, so an item called 3 in the panel is item 3 in
the prompt when items 1 and 2 were left out. When the extension
started the collector on a tab that was already open, the page section says from when the log
was collected (with the page toggle off, the Console and network section does), so the stretch
before it does not read as a quiet page.

## Capture and cropping

`chrome.tabs.captureVisibleTab` returns the whole viewport at physical device pixels. The
overlay reports its rectangle in CSS pixels along with the viewport size measured at capture
time, and the cropper derives the scale as:

```js
const base = image.naturalWidth / viewport.width;
```

That is deliberately not `devicePixelRatio`. Browser zoom also changes the ratio between CSS
pixels and captured pixels, and the measured value is correct under both zoom and a Retina
display, where the constant is not.

Pinch zoom adds a second viewport. The rectangle is measured in layout viewport pixels, while the
screenshot shows only the visual viewport, the part the pinch has magnified. So the overlay and the
picker also send `viewport.visual` (the visual viewport's offset, size and scale), and the cropper
subtracts that offset and multiplies by that scale as well as by `base`. Any part of the rectangle
outside the visible area is cut off rather than shifted into it. With no pinch zoom the offset is
zero and the scale is one, and the crop is the same to the pixel. The cropper also reads
`viewport.height`: when the bitmap's height ratio differs from its width ratio by more than three
percent, the tab changed size between the selection and the screenshot (the panel opening or
closing, a window resized), and the item says the crop may be off.

Two related details. Both capture scripts take down what they drew and then wait two animation
frames before signalling, because removing a node only queues the change and one frame does
not guarantee a paint has landed. (The picker goes on keeping presses from the page for about a
second longer, with listeners rather than anything drawn, while frames go on letting the pointer
through; see [Drawing over the page](#drawing-over-the-page).) And every rectangle clamps all
four edges before deriving width and height: clamping only the origin while keeping the raw drag
delta silently widens the selection when a drag leaves the viewport.

Opening the side panel shrinks the tab viewport, which is why the viewport is measured inside
the content script at capture time rather than assumed.

## Drawing over the page

Both capture scripts draw on pages they know nothing about, so each keeps its drawing in a closed
shadow root, where page CSS and page scripts cannot reach it, and keeps the events it handles from
the page, so a drag or a pick does nothing on the page or in a dialog's own handlers. (What the
picker cannot keep from the page is said under the picker below.)

**The overlay.** The region overlay stops every pointer and click event at its own root, and is
shown in the browser's top layer as a manual popover. The top layer is drawn above every
`z-index`, and it is laid out against the viewport whatever the page does to its ancestors. That
keeps the overlay visible on a page whose body has a transform or a filter, where
`position: fixed` would otherwise follow the body and scroll away. When a
modal dialog is open, everything outside it is inert, so the overlay's host goes inside the
topmost open modal dialog (`topModal`). The dialog that holds the focus is that one, found through
`document.activeElement`, then the `activeElement` of each open shadow root on the way down, then
up through the tree as it is drawn, so a node slotted from the light DOM goes up through its slot.
That also finds a dialog inside a component's shadow root around content the page hands it, as
`md-dialog` does. With nothing focused (a framework that re-rendered the focused field, or a page
that called `blur`), the dialog the host is already in stays the answer for as long as it is open.
Otherwise the overlay looks for open modal dialogs in the document and in the page's open shadow
roots, which it walks each time the host is placed, at most 20 000 elements (`collectRoots`). Of
several it takes the one on top by hit testing the middle of each (`modalOnTop`): Chrome passes
over inert nodes, and the top dialog's backdrop answers for the rest of the viewport (checked in
Chrome for Testing 156). Going by document order put the host into an older dialog underneath, or
on the body under a shadow root's dialog, where it was inert. While Region is armed the host is
kept there. Every animation frame the overlay checks that the host is still in the document, that
the dialog it is in is still modal and that its popover is still shown, and every fifteenth frame,
or at once on `focusin`, `toggle` and `close`, that no other modal dialog has opened. When any of
that has changed it takes the host out and mounts it again, so a dialog the page closes or
removes, or one it opens after the arm, no longer leaves the overlay invisible or inert while the
panel shows Region armed. A popover the page shows while Region is armed (a toast) goes above the
host in the top layer, so on its `toggle` the host is hidden and shown again, which puts it last
in the top layer, above the toast. A popover a component shows from its shadow root sends its
`toggle` no further than that root, so the same fifteenth frame check also compares what is in the
top layer, in the document and in the shadow roots known, with what was there when the host was
last raised, and raises it over anything new: such a popover covers the overlay for about a
quarter of a second. A shadow root attached after the host was placed is seen only when the host
is next placed. Pressing the shortcut again raises the host over whatever covers it. A page that
removes or covers the host every time it comes back is answered a hundred times per arm and then
left alone; arming Region again answers once more. A dialog in a closed shadow root cannot be
found, and the overlay is inert under it: a drag reaches the page, and a dialog that closes on a
click outside its box closes. While an element of the page is fullscreen, Region cannot be used:
Chrome draws a popover that is not inside the fullscreen element under it, even one shown after
it (seen in Chrome for Testing 156, armed before and after the element went fullscreen), and the
host cannot go inside the element, which may be a video whose children are never drawn. Each
frame the overlay also checks that the extension is still there: a reload or a removal leaves the
script running with no extension id, and nothing it sends would arrive, so it stops itself and the
page gets its pointer back. A browser without popovers gets a fixed position host on the
body. The root sets `touch-action: none`, so a finger drag selects instead of panning, and a
cancelled pointer (`pointercancel`, or lost pointer capture) ends the drag without sending
anything.

The overlay also takes keys, heard on the page's window, and from the panel, which hands the
arrows and Enter to it through the controller's `key()` while Region is armed. The first arrow
puts a box of half the visible area in its middle, measured against the visual viewport. The
arrows move it by ten pixels, Shift with an arrow moves its right or bottom edge instead, Alt
makes each step one pixel, and Enter captures it once there is a box to capture.

**The picker.** The picker draws on a host whose own style is set inline with `!important`, so
page CSS cannot move, hide or fade it. When the top layer is in use (a modal dialog, an open
popover, a fullscreen element), the host is made a manual popover and shown, which puts it above
what is there, and it is shown again whenever something enters or leaves the top layer. A popover
the page shows inside a shadow root fires a `toggle` that never reaches the window, so every
fifteenth frame the picker also compares what is in the top layer, in the document and in the
open shadow roots it knows, with what was there when it last raised the host, and raises it
again over anything new; such a popover can cover the highlight for about a quarter of a second.
One the page hides and shows again between two of those checks is nothing new to them, and can
cover the highlight until the next time it is shown. Every frame, and every frame of the tail
after a pick, the picker also checks that the extension is still there (`orphaned`): a picker left
by a reloaded or removed extension stops itself, takes its sheet out of the page and gives the page
its pointer back.

A frame (an iframe, frame, embed or object) takes every pointer event over it, so left alone the
page never hears the pointer there and a press goes into the framed page, for real. While the
picker is armed, and through the tail after a pick, frames let the pointer through instead. The
picker adopts one constructed style sheet,
`iframe, frame, embed, object { pointer-events: none !important }`, into the document's
`adoptedStyleSheets`, and into those of every open shadow root that holds a frame. A move or a
press over a frame then reaches the page, where the capture listeners keep it, and nothing goes
into the frame. What the page draws over a frame (a hover menu, a tooltip) keeps the pointer and
its hover, as it would with no picker. A frame is still picked whole, since what is inside it is
another document, and the picker finds it in two steps (`frameAt`). With the sheet on, the hit test
passes through every frame, so where the pointer is inside no frame's box, which is nearly every
move, no frame is there and nothing on the page is restyled. Where it is inside one, the picker
takes the sheet off for a single hit test and lets the browser say what is drawn there, which
accounts for clipping, stacking, visibility, rounded corners and fixed frames as drawing does: a
carousel's slide out of view, the lower of two frames, and an `<object>` showing its fallback are
not picked where they are not seen. That restyles the whole page, 28 ms a move at 100 000 elements
(measured in Chrome), as every move once did, but only while the pointer is over a frame. A menu
drawn over a frame is what that hit test finds, so the menu is picked. The boxes of up to 2,000
frames are read, after the hit test has brought the layout up to date. The box is taken a pixel
wider on each side, since a frame at a fractional offset is drawn and hit tested on a pixel row its
box starts just past. At a press the frames are looked for again, so one the page put in since the
last survey (every 15 animation frames) is picked too. The children of an `<object>`, drawn only as
its fallback, inherit `none` from it and show no hover while picking, but the lifted hit test finds
them, so a missing PDF's link can be picked. Giving them `auto` back took the page's own `none`
from them and slowed every restyle by a quarter (measured in Chrome). A page that sets its own
adopted style sheets while you pick drops the sheet. The picker puts it back on the next animation
frame, again just after the page's own animation frame callbacks, at every press, and as soon as
the pointer enters a frame (`keepPassing`). A press made in the same frame as such an assignment,
with no pointer movement since, can still reach the frame. A page script that reads
`adoptedStyleSheets` while the sheet is there can see it. When picking ends the sheet is taken out
of every list and emptied, so a copy of the list that the page kept and puts back later holds a
sheet that does nothing. A frame inside a closed shadow root is not seen at all: it keeps the
pointer, and a press on it goes into the frame and picks nothing. One in an open shadow root
attached after the arm is found by the next survey, or as soon as the pointer enters it.

Before the sheet, a transparent shield over every frame kept the pointer from it, and took the
hover from whatever the page drew over a frame; one put up only once the pointer reached a frame
would come too late, since a cross site frame tells its parent nothing when the pointer goes into
it (checked in Chrome 156). Shields are left only for a frame whose own style beats the sheet (an
id rule with `!important`, an inline `!important`), which a survey every fifteenth frame finds by
its computed `pointer-events`; a menu drawn over such a frame loses its hover while the picker is
armed. Only such a frame puts the host inside a modal dialog, where everything outside is inert
and a shield from outside let the pointer through to the frame. Otherwise the host stays at the
end of the body, in the top layer above the dialog, since the box, the tag and the hint take no
pointer. In the dialog the host would be its last child, which a `:last-child` rule (Tailwind's
`space-y`) then misses, and the dialog would move while the picker is armed.

A pick is committed on the pointerup of a primary press that went down while the picker was
armed, so a control Chrome sends no click to, such as a disabled button, can still be picked.
The picker acts only on events the browser dispatched (`isTrusted`); an event a page script
dispatches passes through to the page untouched. While it is armed, mouse and click events are
cancelled and pointer, touch, `contextmenu` and pointer capture events are stopped, so a menu that
opens on `pointerdown` stays shut. Only a press is kept from selecting text: `selectstart` is
cancelled while a button is down, because a right press, or a Ctrl+click on macOS, selects the
word under the pointer as the context menu opens, whatever became of its `mousedown`. Select all
from the keyboard, or a selection the page makes from its own script, works as usual. A finger's
press captures its pointer to what it pressed, which the page heard as `gotpointercapture` and
`lostpointercapture`, so the picker releases that capture as the press begins. The browser's own
context menu still opens, since its default is left alone.

Two things it cannot keep from the page. Window is the first node on the capture path, and
Chrome runs the listeners on one target in the order they were added, across worlds, so a page
script that put a capture listener on the window before the picker was armed hears the press that
picks, every press of a double click included, before the picker can stop it. The press still
does nothing on the page: its default action is cancelled, and no listener below the window hears
it. And Chrome grants the page transient user activation in the browser when it dispatches the
press, before any listener runs. Neither `preventDefault` nor `stopImmediatePropagation` takes it
back, and no API clears it short of one that spends it (`window.open`, `requestFullscreen`), which
would itself change the page, so for about five seconds after a pick the page may open a popup or
start playback as if it had been clicked.

Styles are read and the screenshot is taken at the pick, in whatever hover state the element is in
at that moment. Nothing is put over the page between the press and the screenshot, because a menu
that exists only while hovered closes as soon as anything takes the hover from it, a transparent
catcher included. The picker asks the element whether it matches `:hover` as it reads the rest,
and when it does the payload carries `hovered: true` and the item says "Styles and screenshot
show it hovered." (or "Styles show it hovered." when it has no screenshot). The rest of the
press, and the second press of a double click, are kept from the page by the same capture
listeners on the window as while armed, until a second after the payload is sent. A press that
begins in that second is kept from the page until the button is released, its click and a
`dblclick` too, however late the second runs out: the page heard the rest of such a press as a
click without its `pointerdown`, and followed a link. Each press begun in the tail has five
seconds from its own start. A press held longer is released to the page, which then sees how it
ends but not how it began. If the pick was made with Enter and the key is held, its repeats and
its release are kept from the page while the tail lasts; repeats after that reach the page, and
so does any other key. The highlight goes at once, and so does the host, unless it shields a
frame the sheet does not reach, which would otherwise take the rest of the press for real. The
payload is read with the host taken out of the page and put back in the same task, so the host
never shows up in the markup, the text or the selector.

The selector is tested with `querySelectorAll` as levels are added, up to eight tests, and stops
at the first one that is unique. No CSS selector crosses a shadow boundary, so inside an open
shadow root the path stops at the root and the host's own path goes in front of it, joined with
` >>> `, the deep combinator Puppeteer and WebdriverIO read. When the whole is longer than 200
characters, ancestor classes are dropped, and the selector is then sent whole; only one longer
than 4,000 characters, which is no path a page builds, is cut to the element's own level in the
picker. The template prints at most 200 characters (`formatSelector`). It leaves out leading
steps first and then the element's own classes, never the element's own step, and says what it
left out; when a step it left out is a shadow host, it says the selector starts inside a shadow
root and does not match from the document. The picker leaves the shortening to the template so
that the template knows which hosts were left out.

From the keyboard, the picker follows Tab focus. The first arrow key highlights the focused
element, or else the element under the middle of the viewport, under a point across it, or the
first in view in document order, taking only one the user can see: at least four pixels of it in
view each way, and neither `visibility: hidden` nor transparent (`checkVisibility`), since a skip
link clipped to one pixel came first in document order and the box was drawn around nothing. In
document order it also takes only one that is drawn where it stands, by hit testing the middle of
its part in view (`onTop`), so a link in a collapsed menu, one clipped away, or one under a cover
is passed over. At most 200 elements in view are tried. Up goes to the parent, down back along
the way up or to the first child, left and right to the siblings, and Enter picks the highlight.
So does a click on the element the pointer was over when the keys moved the highlight away from
it, and the panel hands the same keys on through the picker's `key()` while Element is armed.

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

## The sheet in storage

**Keys.** `cdrReport` holds `{ items, removed, updatedAt, writer }`. Each stored item keeps `id`,
`mode`, `width`, `height`, `url`, `title`, `intent`, `description`, `included`, `element`,
`capturedAt`, `armedAt`, `editedAt`, `wordsAt`, `path` and `downloadId` (`storedForm` in
`sidepanel/panel.js`); its tab, its thumbnail and whether its file is missing are not stored.
`cdrThumbs` holds `{ items, writer }`, the thumbnails by id. `cdrIntent` and `cdrInclude` are
keys of their own, each written only when that setting changes, and every panel adopts both.

**Reading it back.** Whatever the panel reads from storage is treated as data from outside:
an older or a newer build wrote it, or something else did. It is validated before use (`readItem`
and `readReport`): known fields only, ids of at most 100 characters and no two alike, at most 500
items and 50 000 characters per description, paths without control characters or line breaks
(the prompt prints each on a line of its own), an unknown mode shown as `other`, element data only
for element items, stamps capped at the current time, and thumbnails only as base64 WebP, PNG or
JPEG data URLs, since anything else in an `img` would be a request to the network. Content
scripts can write an extension's local storage unless it says otherwise, so the worker restricts
`chrome.storage.local` to trusted contexts at every start.

**Merging.** Every panel merges another panel's write into its own sheet item by item, instead of
replacing the sheet. Each item carries two stamps: `wordsAt` for the description, and `editedAt`
for the intent and the tick. Each field keeps whichever copy was changed last, and a side holding
something newer writes it back. Which window has focus decides nothing. When an item leaves the
sheet through a discard or a copy, its id and time go into `removed`, kept for ten minutes and
capped at 200 entries, so a write that crossed the removal cannot bring the item back. An edit
made after the removal, an undo included, does bring it back. A removal of the whole report
(another panel's weekly expiry) is ignored by a panel that is still showing it. A change that
keeps the sheet's shape updates rows in place, with no storage read, list rebuild or page read.

**Files.** Before the panel deletes a screenshot or trusts what Chrome says about whether it
exists, it looks up the download record and accepts it only if `record.filename` is the item's
path and `record.byExtensionId` is this extension (`recordFor`). Chrome hands download ids out
again: after a restart the next one is one more than the highest row left in the download list,
so clearing the newest rows reissues their ids to whatever is downloaded next, and the id alone
can name someone else's file. Existence is asked when the panel starts, when its window takes
focus, when it is shown again, and on every copy. A copy asks just before the page read. Chrome
answers a file found gone through `downloads.onChanged` after `search()` has returned: in Chrome
156, 0.3 to 1.4 ms after the question with no other downloads listed, up to 5 ms with 300 and up
to 30 ms with 2,000. An answer about an id the panel already knows to be the item's own is taken
at once, without looking the record up again, so it counts if it comes before the page's. On a
page it can read, the copy waits for nothing beyond that read. With no page to read (a page
Chrome keeps extensions out of, or no tab), the read is back at once, before Chrome's answer, and
the prompt went out naming a file Chrome reported gone a few milliseconds later, so such a copy
waits up to 150 ms from the question (`FILE_ANSWER_MS`). An answer that still comes after the
prompt was settled, within a second of the receipt, is said on the receipt, since a banner about
items the copy has taken off the sheet would sit over an emptied sheet. The note under the
receipt numbers items as the copied prompt does, and says so ("item 1 in the copied prompt"). The
banner and the line under Copy number by the sheet, which the copy has numbered afresh, and the
banner says so ("item 1 on the sheet"). No answer is stored, so a
file found again, as after a restart, loses its missing mark. Chrome looks at the disk at most
once every ten seconds, for all downloads together, and the panel's own questions while a capture
saves count as looks, so a screenshot deleted within about ten seconds of the last look can still
read as there and be copied. That is Chrome's limit, and the panel has no way to make it look
sooner.

**Discard, undo and close.** A discard takes the items off every sheet at once and holds their
files for six seconds so it can be undone. The countdown stops while the Undo control has focus or
the pointer is on it, and starts again from six once both have left. Cmd or Ctrl+Z also undoes, in
the description field too as long as nothing has been typed there since the discard: focus goes to
the field after a discard that leaves an item, and the field has nothing of its own to undo yet,
since a value set by script is not on its undo stack. When the time is up, the files are deleted
with `downloads.removeFile` and their history entries with `downloads.erase`. On `pagehide` the
panel settles the pending discard and takes back any save still in flight by sending `cancel`,
`removeFile` and `erase` without waiting for them; Chrome completes those calls after the page has
gone.

**Expiry.** A report whose `updatedAt` is more than a week old is removed when a panel starts,
and the files of its items with it, since nothing was copied and no prompt names them. That
happens only when no other panel is open (`chrome.runtime.getContexts`), because a panel in
another window is still showing the sheet, and pulling it out from under someone looking at it
would be worse than the staleness.

## Clipboard

The only precondition Chromium enforces for a sanitized clipboard write from an extension page
is `document.hasFocus()`. There is no transient activation gate, so awaiting the file save
first is fine. What does break it is a "Save as" dialog stealing focus, so `copyText` waits for
focus to return, falls back to `execCommand('copy')`, and finally reveals the prompt for a
manual copy.

## Permissions

| Permission | Why it is there |
| :--- | :--- |
| `host_permissions: <all_urls>` | Screenshot the tab, inject the overlay and picker, start the collector on a tab open from before (where the `content_scripts` matches cover it), and read `tab.url`. Chrome withholds the URL entirely for any origin this does not cover. |
| `scripting` | Inject the region overlay and element picker on demand, and the collector into a tab where nothing collects and the `content_scripts` matches would have run it, or a bridge to a collector already running on a site they name |
| `downloads` | Save each PNG as it is captured, read back its absolute path, delete it again if the item is discarded or its sheet expires, and learn if it has since gone missing |
| `storage` | Keep the report (items, descriptions, thumbnails) between panel sessions, plus the toggle settings |
| `sidePanel` | The panel itself |

At every start the worker restricts `storage.local` to trusted contexts, so a content script
cannot write a report for the panel to adopt. The messages only the panel sends (`cdr:arm`,
`cdr:disarm`, `cdr:verify`, `cdr:check-tab` and `cdr:collect`, listed in `PANEL_MESSAGES`) and the
`cdr:panel` port are accepted only from the extension's own pages, so a content script, which runs
in a page that may be hostile, cannot ask the worker to inject anything into any tab.

Note what is **not** in that table. The collector arms via the two `content_scripts` entries
and their own `"matches": ["<all_urls>"]`, which is a grant entirely separate from
`host_permissions`. A statically declared content script injects on its own match patterns, so
narrowing `host_permissions` alone does not stop the collector wrapping `console`, `fetch` and
`XMLHttpRequest` on every page. It also does not shrink the install warning, which is computed
from content script matches as well.

Narrowing those two `matches` lists keeps the collector off other origins, and that is the only
narrowing available: `host_permissions` has to stay `<all_urls>` for `captureVisibleTab`, as
above. Under `host_permissions` alone, `cdr:collect` could inject the collector into any tab the
panel reads and finds nothing collecting on, which outside narrowed lists would be every tab. So
the worker reads the two entries from its own manifest and starts a collector only where both
would have run at page load (`collectorDeclaredFor`, see
[A tab that was open before](#a-tab-that-was-open-before)). On a site the lists leave out it
injects nothing at all, not even a probe, so narrowing the lists keeps the collector off other
sites in tabs that were already open too. The README has the recipe.

`activeTab` is not requested. It cannot stand in for `<all_urls>`, as
[the trap under the side panel decision](#the-heavy-lifting-is-in-the-side-panel-not-the-service-worker)
explains, so next to `<all_urls>` it would add nothing. `clipboardWrite` is not requested
either, for the reason given in the README.

Narrowing either grant was checked in Chrome for Testing 156 with an edited manifest. With only
the two `matches` lists narrowed, Region and Screen still worked on a site outside them. With
`host_permissions` narrowed to one origin, `captureVisibleTab` refused on that origin too, with
"Either the '<all_urls>' or 'activeTab' permission is required."

The manifest sets `incognito` to `not_allowed`, so Chrome offers no switch to run the extension in
incognito windows. Its storage is shared with the regular profile, so a sheet started in an
incognito window, and its entries in the download history, would outlive the window.

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
screen is the actual code; only the platform is faked. What it does not reproduce:

* **The worker.** The shim answers `cdr:arm`, `cdr:disarm` and `cdr:verify` itself. It mirrors
  the ordering rule, but there is no service worker to be stopped, no keyboard command and no
  `sidePanel.open()`, and an arm lands as fast as the stage lets it.
* **Tabs.** There is one tab, `tabs.onActivated` and `tabs.onUpdated` never fire, and
  `cdr:check-tab` reports every page as usable, so switching tabs, navigating, restricted pages
  and file access cannot be exercised.
* **Worlds and timing.** The stage adds the collector and the bridge to the demo page as
  `<script>` elements once it has loaded, not at `document_start`. Nothing the page logged or
  requested before then is caught, and a reference to `fetch` or `console` the page kept from
  earlier escapes the wrappers. The collector therefore says it started late, and the stage
  drops that flag from its answers, so the late start footnote and its prompt line never show
  there. Every script runs in the page's own JavaScript world, because
  there is no isolated world here: the bridge, the overlay and the picker share globals and
  prototypes with the page and with the collector. A picker that read a React fiber off a node
  by itself would work on the stage and find nothing in Chrome.
* **Messages.** A broadcast from the page reaches the panel synchronously, inside the call that
  sent it, and the panel receives the very object that was sent. Chrome serialises every message
  and delivers it in a later task, so a value that does not survive serialisation, or code that
  depends on the order of delivery, behaves differently there. Every sender is tab 1, with no
  frame, URL or origin.
* **The screenshot.** `captureVisibleTab` is the stage drawing the demo frame, not Chrome's
  compositor, so device pixel ratio, zoom and the visual viewport play no part, and no capture
  quota applies.
* **Downloads.** They complete instantly unless `?save=<ms>` slows them, and there is no
  "Save as" dialog to take focus away. No file is written: the path is made up, and
  `conflictAction: 'uniquify'` is ignored, so two captures in the same second get the same path
  where Chrome would add ` (1)` to the second. Nothing removes a file behind the panel's back
  unless a driver says so through `__shim.downloadChanged`. Download ids and records live on the stage, beside storage,
  so they survive the panel frame reloading, as Chrome's download history survives the side
  panel closing, and start again when the stage itself reloads.
* **Storage.** It is held in memory by the stage page, so it too survives the panel frame
  reloading and is lost when the stage reloads. No quota applies, and only the one panel hears
  `storage.onChanged`.
* **Failures.** Chrome's own failures do not happen here: there is no capture quota, no
  interrupted download, no storage error, and no missing receiver except while the demo page is
  between documents. The panel's paths for those can be reached only through a driver.
* **Windows, focus and size.** There is only ever one panel, so the cross window adoption above
  cannot be exercised, and panel and page share one document, so focus moves between them as it
  does between frames, not as between a side panel and a tab. The clipboard follows the rules
  for a web page rather than those for an extension page. The panel frame is a fixed 380 pixels
  wide, where a real side panel is as wide as the user drags it. In Chrome for Testing 156, driven
  over CDP with a real side panel, the panel's `focus()` on its field after a drag left the
  keyboard with the page, and `window.focus()` changed nothing; a click into the panel moved it.
  So the panel reads `document.hasFocus()` and says under the field that the page still has the
  keyboard. On the stage both share one document, so that line never shows there.

It exists for two reasons. Working on the panel's design no longer means reloading an
extension for every change, and the README's screenshots and GIF are produced from it by
`tools/make-media.mjs`, so they can be regenerated rather than redrawn. Nothing under
`tools/` is included in the release zip.

## Conventions in the code

Both capture scripts are injected repeatedly by `executeScript`, which re-runs the entire file
every time. They cache a controller on `window` and call `start()` again, so they must stay
free of top level `const`, `let` and `class`: a redeclaration throws at parse time and the
whole file fails to run. `content/stop.js`, which a disarm injects, is re-run the same way and
keeps to the same rule.

The collector wrappers must never break a host page. Every one of them preserves `this`, passes
return values through unchanged, re-rejects rejections, and swallows its own errors. Each is made
with `wrapNative()`, a Proxy of the native with only an `apply` trap, so the page sees the
native's name, length and `toString`.
