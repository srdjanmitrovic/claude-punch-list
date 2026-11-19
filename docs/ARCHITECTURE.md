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
   |                         items, lets the user mark a capture up, builds
   |                         and copies the prompt.
   |
   +-- background.js ....... service worker. Side panel behaviour, the keyboard
   |                         command, injecting the capture scripts, starting
   |                         the collector on a tab open from before, and a
   |                         map of which tab is currently armed.
   |
   +-- content/overlay.js .. drag a rectangle (injected on demand)
   +-- content/page-shot.js  ISOLATED world, injected by the panel itself for
   |                         Page. Scrolls the page between screenshots, hides
   |                         what is fixed to the window, then puts it back.
   +-- content/press-gate.js ISOLATED world, always on. Hands the picker
   |                         the presses and keys first, while it picks.
   +-- content/picker.js ... hover and click an element (injected on demand),
   |                         and asks the main world what rendered it
   |                              |
   +-- content/collector-bridge.js .. ISOLATED world, always on. Relays,
        ^                             and posts the counts on a port to the panel.
        | channel events              |
        | (the log, the counts)       | window.postMessage (inspect, from the picker)
        |                             | an event on the node (the name, while hovering)
        v                             v
       content/collector-main.js .... MAIN world, always on. Wraps console,
                                      fetch and XHR from document_start, and
                                      reads React, Vue, Svelte and Angular
                                      internals on request.
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
over it and answer in the collector's place. It can send `__cdr_name` on a node of its own and
learn from the reply that the extension is there, hear the picker's `__cdr_name` while Element is
armed and learn which element is highlighted (the arrow keys' included), and answer it before the
collector does or keep the answer back (see [The name while hovering](#the-name-while-hovering)),
which changes the name on the tag and nothing else. None of this lets it put anything into a
prompt that it could not put there by logging made up lines, which any page can do, and what it
can read is the page's own console and network activity, which it could record anyway by
wrapping the same functions.

While the side panel is open and shown on a tab, it also holds a port to that tab's bridge,
`cdr:counts`, opened with `chrome.tabs.connect` to the top frame once a read has found the
collector (`watchCounts` in `sidepanel/panel.js`), with no relay through the worker. The bridge
asks the collector over its channel to `watch` (`watchCounts` in `content/collector-bridge.js`).
From then on a ring that grows says so once, with an empty `<channel>:changed` event
(`countsChanged`), and says it again only after the bridge has asked for the `counts`. The bridge
asks on a timer of its own world, at once after a quiet spell and then at most every 250 ms
(`COUNTS_GAP_MS`), and posts the two counts to the port only when they change, checked as whole
numbers and capped at 90 and 30. The gap's timer is set before the ask (`countsTick`), so a change
said while the ask is answered waits for the gap too: a page that answered in the collector's
place and said a change as it answered had each ask start a timer of its own, about 350,000 port
posts in 5 s in Chrome. No log content crosses. With no port open the collector is not
watching, and recording an entry costs one comparison more. A full ring does not grow, so a page
that logs without pause past it costs nothing either. The signal is sent while an entry is
recorded, never while a request is answered, so it gives a page script no moment with the
channel's name on `window.event`, and a channel a page watches is marked on its own.

A channel is marked as told only once its event has gone out, and the event is sent only when
1,600 more calls fit on the page's stack (`roomToTell`), about 13 to 16 percent of what Chrome for
Testing 156 gives a page's main thread (10,295 calls of a one line function cold, 12,351 warm).
A page that logged on its way back from a stack overflow had the event sent with almost no stack
left: Chrome could not call the bridge's listener at all, reported an uncaught `RangeError` of the
extension's in the tab, and the chips stood still until the port closed. Below that headroom, or
when the event throws, the change is owed (`owed`) and told with the next entry the page logs,
also when that entry goes into a ring that is already full: a ring filled during an overflow
otherwise kept the chips at 0 until the next read. The probe costs about 13 microseconds warm and
runs at most four times a second, only while a panel watches. While a change is owed, each
console call into a full ring runs it again until the event goes out, about 25 microseconds more
a call: 20,000 calls within about 200 frames of the stack limit, with the panel open, took about
2.2 s against 1.7 s before. A page that only ever logs within 1,600 calls of its stack limit
leaves the chips standing until the panel reads. Every read of the log the panel makes, and every
Clear, also has the bridge ask `watch` again and post the counts it finds, whether or not they
changed (`recount`), so a signal lost any other way, or an `unwatch` a page sent on the channel of
a late start, holds the chips back only until the next read. That post travels on the port, so it
stays in order with the port's other posts. A read's reply and the port's posts are not kept in
order between them, so once the port has posted, its numbers are the chips' and a read's reply
leaves them alone (`countsFollowed`). Chrome 156 tells the bridge nothing when a port ends
because the page went into the back/forward cache, or because the extension was reloaded. So the
bridge closes its ports on the browser's own `pagehide` (one a page script sends is ignored), and
a bridge whose extension context has gone asks the collector to stop at its first signal. That
check is made when the signal's timer fires, not when the signal comes: on a late start a page
that sent the `<channel>:changed` event itself, before the panel connected, had the port that
opened meanwhile dropped, and the chips froze. When the bridge stops watching it closes every
port it holds (`unwatchCounts`), so the panel hears it and takes the counts from its reads
again. The panel closes the port on a change of tab or page and while it is hidden, and opens it
again when it is shown.

The picker still asks what rendered a node over `window.postMessage`, and that answer is about
the node alone. The same boundary is why the element picker cannot read a React fiber itself.
React hangs the fiber off the DOM node as a `__reactFiber$<random>` property, Vue 3 hangs
`__vnode` and `__vueParentComponent`, Vue 2 `__vue__` and Svelte `__svelte_meta`, and those
properties live on each world's own wrapper of the node, so an isolated world script sees a node
with none of them. The same goes for the `window.ng` Angular publishes. The DOM itself **is** shared, which is
what the handoff uses: the picker sets a random `data-cdr-pick` attribute on the clicked
element, asks for it by that value, and the main world finds the node with `querySelector`, and
inside open shadow roots when that finds nothing (`findMarked`, which walks at most 20 000
elements looking for them). Both sides remove the attribute, because the timeout path is a page
where nobody over there ever saw it. A node inside a closed shadow root is out of the main world's
reach, so the picker marks the host of the outermost closed root on its way up instead, the
deepest node that world can reach (`reachOf`), and nothing is written inside a closed tree, where
the component's own `MutationObserver` would see it. What comes back is counted through that
host: the hops of the component and of the handlers include the steps from the picked element up
to it, and `component.closedHost` names it (`throughHost`). The prompt then says the element is
inside that host's closed shadow root and that this is the component nearest the host, and makes
no claim about whether the framework rendered the element itself, which the page's world cannot
know.

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

The component comes from `componentOf`, which asks one reader per framework in turn: React, Vue
3, Vue 2, Svelte, then Angular. Each answers null for a node it does not know, and each reads only
what the framework itself keeps in the page, with no code of the extension's left behind.

* **Vue 2** puts `__vue__`, the instance, on the element each component's render made its root,
  in a production build too. An element inside the root carries nothing, so `vue2Summary` climbs
  to the nearest root, passes through any component that renders another as its own root (both
  share the element, and the outer one holds it) to the innermost, and walks that instance's
  render tree, at most `SUBTREE_LIMIT` vnodes and never into a child component, for the vnode of
  the element nearest the picked one. That vnode's `context` is the instance whose template made
  it, which is how slot content is credited to the template that wrote it, as Vue 3's
  `__vnode.ctx` is. A walk that stops short of the picked element names the root's component with
  no steps counted, rather than an element two up that is no answer. A development build is told
  from a production one by `_renderProxy`, a `Proxy` in the first and the instance itself in the
  second, and only the first is claimed.
* **Svelte**'s development build puts `__svelte_meta` on each element it creates from a template:
  where the element is written (`loc`, from Svelte 3), the blocks and components it was rendered
  inside (`parent`, from 5.36), and the context of the component that rendered it (`component`,
  with its props as `s` and its function, from 5.58). Svelte 5 also defines `__svelte_meta` as
  null on `Element.prototype`, so only a meta the element holds itself counts. The component is
  named after its file, as the compiler names it, and printed as where the element is written
  (`Element written at`); Svelte 3 and 4 count lines from 0, so the reader adds one to theirs.
  Props are read only when the context's function was compiled from the element's own file (its
  `Symbol('filename')`, found by description, since the symbol is not exported), because a
  snippet's element is written in one file and rendered with another component's context.
* **Angular** keeps nothing on an element that says which component rendered it, so
  `angularSummary` calls the functions a development build publishes for Angular DevTools on
  `window.ng` (`getOwningComponent`, `getHostElement`, `getDirectiveMetadata`, `isSignal`). It is
  the one reader that runs the page's code, every call goes through `ask()` in a try, and only an
  object answer is kept. `getOwningComponent` and `getHostElement` go through Angular's
  `getLContext`, which caches what it finds in `__ngContext__`, a property of Angular's own that it
  reads back in either form: an LContext on each element asked about that Angular rendered, and on
  each component instance asked about and its host element, or the LContext the host already holds
  with its component filled in. A component instance, its host and the root elements of each
  template hold their view's number there from render, and an LContext refers back to the instance
  and the host, so the page's own code that serialises an instance (`JSON.stringify(this)`) would
  meet a cycle after a pick that it did not meet before. (Asked about a directive, `getLContext`
  would write on every directive of its element too, but the reader asks only about elements and
  about the components `getOwningComponent` answers.) So the reader puts all of it back. Before
  each call it notes the own `__ngContext__` of what the call can change (`noteContext`): each
  element it climbs through, and each instance before `getHostElement`. A host is known only from
  `getHostElement`'s answer, by which time the call has changed it, so the reader notes ahead the
  elements where the hosts usually are (`noteAbove`): before the first `getHostElement`, the
  elements above the one the climb stopped at, and after each `getHostElement`, the elements above
  the host it answered, before anything asks about them. Each step goes past a shadow root to its
  host (`parentOrHost`, through the native `parentNode` and `ShadowRoot.prototype.host` getters),
  so the host of a component whose template `ViewEncapsulation.ShadowDom` puts in a shadow root is
  among them. That leaves a host above none of those: the host of a component whose elements an
  overlay or a portal moved away from it. `noteHost` works out what such a host held from what
  `getLContext` does: the number its instance held, when the instance and the host now share an
  LContext with nothing but its component filled in, and otherwise what it holds now. In
  `finally`, `putBack` defines each member that is not as it was back as it was, and deletes one
  that was absent, through `Object.defineProperty`, `Object.getOwnPropertyDescriptor` and
  `Reflect.deleteProperty` taken as the file loads, each step in its own try, and writes nothing
  that is as it was. So a number stays that number, an absent one stays absent, an LContext
  Angular DevTools made first stays the same object with its component as it was, and an accessor
  the page put there is neither run nor replaced. Three things are not put back. What Angular's own
  write hands to such an accessor's setter stays with the page's code. A member the page's own code
  made unwritable while a call ran (an object it froze, or a proxy that refuses the write) stays as
  the call left it. And on a host that only a call's answer names, an LContext made before the pick
  with nothing filled in (by `getOwningComponent`, `getContext` or `getInjector` asked about that
  host, for instance) cannot be told from one the call made, and is given its number back. Angular
  reads either form the same way. The name and the file and line come from the `debugInfo` the
  compiler gives a component's definition from Angular 17.1, read only when `ɵcmp` is a value of
  the class's own; a component compiled in the browser has a getter there that compiles it, which
  is not called, so it is named by its class with no file. The version is the root host's
  `ng-version`, and the props are the inputs `getDirectiveMetadata` lists, a signal input called
  for its value and one that throws (a required input not yet set) left out. An input has two
  names, the one a template binds and its class property, and is filed under the first unless only
  the second looks secret (`@Input('value') password`), so that the name rule withholds it.

A production build of Svelte or Angular leaves nothing to read, and no reader guesses: the item
has no component, as on a page with no framework.

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
secret name is withheld. When a component is inspected, the collector also reads the live values of
the page's secret controls (`reactGuard`, `vueGuard`): the controls the component renders, up to
3,000 nodes, and the document's own (`documentValues`). Svelte, Vue 2 and Angular keep no tree of
what a component rendered that this file reads, so for them `domGuard` takes the elements under the
component's element in the page instead, through the native `getElementsByTagName` and no further
than 3,000: Vue 2's `$el`, Angular's host, or, for Svelte, whose component has no element of its
own, the first ancestor it did not render, counting under it only what the component or one inside
it rendered (by the meta's context chain) and what has no meta, as `{@html}` writes. A field such a
component renders outside that element, in an overlay or a portal, is not counted as its own. Those are elements of type password,
elements whose autocomplete says `current-password`, `new-password`, `one-time-code`, `cc-number`
or `cc-csc`, and form controls whose name or id is a secret name such as `csrf_token`. In the
document it reads at most 32 of each kind, judging the names of the first 256 inputs, text areas
and selects, and looks one level into the open shadow root of a design system's own element. It
also looks into the document's open shadow roots (`shadowValues`): the first 100,000 elements of
the document are asked for an open root (`SHADOW_LIGHT`), at most 512 of those roots are kept, and
each is looked into with every root inside it, the first first, before the next (`shadowTree`), so
the roots are taken depth first in document order. At most 512 roots are looked into, 10,000
elements inside them asked for roots of their own, 10,000 controls judged and 32 read. The roots of
the light DOM are collected before any is looked into: looking into each as the scan found it gave
the same order and cost 1.5 ms more a pick on a page of 60,000 elements. A string or number prop is
withheld when it equals one of those values, contains one of four characters or more, or is a piece
of four characters or more that covers at least half of one, so a seed the user typed on the end of
still matches (`holdsSecret`). It is also withheld when it differs from one in a single place (a
run of characters put in, taken out or replaced), what the two share at their ends is four
characters or more and three quarters of the longer, and the value reads as a passphrase or a seed:
it holds white space or has 12 characters or more (`SEED_LENGTH`), and it is not a number of fewer
than 12 digits however it is grouped, with white space, dashes, dots, slashes, parentheses or a
plus (`editedFrom`, `seedLike`). So a passphrase the user changed in the middle matches, and so
does a card number changed in one digit (`4111 1111 1111 1112` beside a card field holding `4111
1111 1111 1111`), while a label `Password` beside the password `Passw0rd`, a period `January 2024`
beside the password `January2024`, and an order number or a card security code one digit away from
a one time code print, as they did in 0.6.0. A value of 12 digits or more written with nothing but
white space, dashes, dots, slashes, parentheses or a plus between them is also compared by its
digits alone with a prop of 64 characters or fewer of that shape (`cardDigits`, `cardForms`), so a
card preview handed the raw digits `4111111111111111` beside a field that shows them in groups
loses them, as do the same digits in dashes, slashes or groups of 4, 6 and 5. Only such numbers are
compared by their digits: a four digit PIN found in the joined digits of a reference number is no
copy of it. The digits of such a held number run together are also looked for in every prop as
written (`holdsSecret`), so `Card 4111111111111111 declined`, a JSON payload or a URL holding them
loses them beside a field that groups them. A card number grouped inside a longer prop is caught
only when it is grouped as the field groups it (`Card 4111-1111-1111-1111 declined` beside a field
holding `4111 1111 1111 1111` prints), and so is a prop holding fewer than 12 of its digits. A
phone number of 12 digits or more counts as a card number does. `value`, `defaultValue` and
`modelValue` of a component that renders a secret control, or whose own `type` or `autoComplete`
says it is one, are always withheld. A hidden input is what a form carries along (a product id, a
CSRF token beside a search box), so its value is held only when it is the pick itself or its name
or id is a secret name, and rendering one does not make a component's value props secret, though a
component whose own `type` is hidden has them withheld. `cc-name` and `cc-exp` alone mark nothing:
they hold nothing secret, and a form whose card number sits in a payment provider's frame has only
those. All the text and number props of a component that rendered a password field used to be
withheld, its title, its error message and its total included, while a strength meter handed the
password without rendering the field still printed it.

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
that renders no password, code or card control, and a password under 12 characters with no space
that was seeded and then changed in one place (`Xk9#mQ2z` beside the seed `Xk9#mQ2p`), which 0.6.0
did not catch either, though a component that renders the field withholds it by its shape. In a
component the shape rule applies to, ordinary strings of that shape are withheld too, such as a
coupon code or an order number like `ORD-2024-00123`, and anywhere on the page a string that shares
three quarters of a held passphrase or seed at its ends is withheld, such as an e-mail address one
character away from the one in a field named `email`. A field in a closed shadow root, in a root
past the first 512 in that order, in one whose host comes after the first 100,000 elements, or in a
frame is not found, so an app shell whose own root holds more than 511 roots ahead of its form
hides that form. One two shadow roots deep inside what a component renders brings neither the shape
rule nor the component's value props. Measured in Chrome for Testing on a page of 60,000 elements,
20,000 of them inputs, the document scan costs about 3 ms a pick, nearly all of it the selector,
which has to look at every element. With the shadow walk, a pick took (Chrome for Testing 156,
median of 7) 16.1 to 17.1 ms on a page of 300,000 elements with no shadow root, against 13.0 ms in
0.6.0; 5.3 to 5.4 ms on 60,000 elements with 202 open roots, against 2.7 ms; and 1.1 ms on 5,000
elements with 600 hosts that each nest two roots, against 0.4 ms in 0.6.0, which looked into none
of the nested ones. The bounds are on roots (512), on the elements asked for a root of their own
(10,000) and on the controls read (32), not on the elements a root's selector looks at: each root
looked into is searched whole, at about 60 nanoseconds an element, about what the document's own
selector costs an element of the light DOM. So 300 roots of 1,000 elements each took 17.9 ms, and
512 roots of 2,000 elements each 58.9 ms, where 0.6.0 took 0.1 and 0.2 ms. A budget of elements
shared by the roots would cap that, but one root of 10,000 elements or more, such as a data grid,
would then hide a password field in every root after it.

#### The name while hovering

While Element is armed, the tag over the highlight names the component as well, and that question
takes another road than a pick's, because it is asked as often as once a frame for as long as the
pointer moves. It writes nothing into the page and posts nothing. The picker sends a `__cdr_name`
event on the highlighted node itself (on the outermost closed host through `reachOf`, as at a
pick), composed, so that it gets out of an open shadow root, and not bubbling. The collector hears
it in a capture listener on the window and answers with `__cdr_name:reply` on the window:
`{ name, renamed }`, or `null` when no component is found. Dispatch is synchronous and crosses the
two worlds, so the reply is in before the picker's `dispatchEvent` returns, in the frame the box
is drawn in, and its detail reaches the picker as a copy its world makes as it reads it. The
collector reads the node off `composedPath()[0]`, through the native it took at `document_start`,
because the target a listener on the window sees is the shadow host. The picker asks once for
each element an arm highlights (a `WeakMap`), asks before it draws, so page code that runs during
the answer cannot leave the box and the tag on different elements, and stops asking for the rest
of the arm when no reply comes at all (a tab with no collector, or a collector of 0.6.1 or earlier
left from before an update).

The name comes from `componentOf(node, true)`, the brief path, whose contract is stated on the
function and in CONTRIBUTING.md: the walk a pick makes for the names, and nothing after it. No
props, so none of the guard's look through the document and its shadow roots for secret fields,
and no owner or call site. Svelte's brief path is the climb to the nearest meta and its file's
name. Vue 2's keeps the render tree walk, bounded at `SUBTREE_LIMIT` vnodes, since without it the
name would be the root's and not the one the pick reports, and skips the build, the file, the
version and the props. Angular's reader is not asked at all: it can learn nothing without calling
`window.ng`, once for each element climbed, so `componentOf` answers null for it and the tag on an
Angular page gives the element alone. A pick's round trip, guard included, took 1.24 ms at 20 000 elements
and 8.5 ms at 100 000 (Chrome 157), and a name about 4 microseconds, at 20 000 elements or
100 000. The two can disagree in one case: the hover reaches a node in an open shadow root
wherever it is, while a pick looks for its marked node there with `findMarked`, which gives up
after 20 000 elements, so on a very large page the tag can name a component the pick then does
not report.

The type is public, not one of the bridge's random channels, on purpose. Page code can run while
the name is read (a getter on a fiber's type, or on `Element.prototype.parentElement`), and while
it runs `window.event` is the request. On a channel it would hand the page the channel's name,
and with it the log. What crosses on `__cdr_name` is the name of one of the page's own
components, and a request sent from inside an answer gets none.

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
On a zone.js page the collector takes `setTimeout`, `addEventListener` and `Error` from the
natives zone.js kept under its own names (`beforeZone`), so recording a request adds no change
detection pass in Angular, and zone.js's error plugin (`zone.js/plugins/zone-error`) does not run
at every request. Its `ZoneAwareError` read the stack as it was made, ran the page's
`prepareStackTrace` and zone.js's own rewriting, and wrote the zone's name after every frame, so a
collector that made its stacks with it recorded no caller. Measured in Chrome for Testing 156 with
zone.js 0.15, 200 requests had made 200 calls of the page's `String.prototype.split`; now they
make none, and the caller is named. Anything else that replaced these before a late start (fake
timers, a listener tracker) leaves no untouched copy in the page's realm, so the collector uses
it as it is.

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

It also means nothing stored ever holds a full image. Each item holds a WebP thumbnail no
wider than the frame can display, and the original data URL is released once the download
has started. The one full image kept is the clean capture as a `Blob`, in the memory of the
panel that took it, so that it can be marked up (see
[Marking up a capture](#marking-up-a-capture)): for that panel's 10 newest captures, about
100 MB together at most, never written to storage and gone when the panel closes. That is what
makes the report safe to persist: `cdrReport` in
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
| `cdr:region-selected` | overlay | panel | A rectangle was dragged, or selected with the keys. Carries `moved: true` when the host, put into the element shown fullscreen, moved that element's last children while armed, so the panel says the crop may be off |
| `cdr:element-picked` | picker | panel | An element was picked |
| `cdr:capture-cancelled` | overlay, picker | panel | The user pressed Escape, or a pick failed on the way |
| `cdr:get-context` | panel | bridge | Read the collected buffers plus page info |
| `cdr:clear-context` | panel | bridge | Empty the buffers |
| port `cdr:counts` | panel | bridge | Opened with `chrome.tabs.connect` to the top frame of the tab in view once a read has found its collector, and closed on a change of tab or page and while the panel is hidden. The bridge posts `cdr:counts` with `{ console, network }` when the two counts change, at most four times a second, and again at every read and Clear, and nothing else. It closes the port itself on the browser's own `pagehide` (see [The collector is split in two](#the-collector-is-split-in-two)) |

Two things go from the panel to the page without a message and without the worker, through
`chrome.scripting.executeScript` into the tab's isolated world. The keys handed to an armed mode
(`handKeyToPage`) call the overlay's or the picker's controller. A whole page capture injects
`content/page-shot.js` as a file, then calls its controller, `window.__cdrPageShot`, with a
function and serialised arguments, and Chrome hands back what the function returns, awaited:

| Call | Answer |
| :--- | :--- |
| `begin()` | `{ ok: true, scroller: 'document' \| 'inner', locked?, rect, client, viewport, scrollHeight, screens, background }`, `locked: true` only for a document the page has locked, which the run leaves as it is; or `{ ok: false, reason: 'zoom' \| 'error' }` with nothing on the page changed |
| `step(index)` | `{ active: true, top, scrollHeight, atEnd, viewport, before }`, where `top` is where the page actually is and `before` where it was when the step began; or `{ active: false, stopped }`, `stopped` being `'user'`, `'pagehide'`, `'lease'`, `'error'` or `'ended'` |
| `end()` | `{ restored: true }` when a run was still going; otherwise `{ restored: false, stopped }`, `stopped` being why the page ended it by itself (`'user'`, `'pagehide'`, `'lease'` or `'error'`) or null |

A document loaded since the file was injected has no controller and answers `{ missing: true }`.
None of this is in `PANEL_MESSAGES`, since the worker never hears it.

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
| `inspect` | picker | Return the React, Vue, Svelte or Angular component behind a marked node, and the handlers bound to it |

`snapshot` and `clear` go over the bridge's channel instead. Over `window.postMessage` they
answer `null`, like any action this build does not recognise (the picker's `ping` among them,
which only waits for an answer). That is load bearing rather than tidiness. Reloading the
extension does **not** re-inject the declared content scripts into tabs that are already open,
so an old main world script keeps running there while a freshly injected picker talks to it,
and a script that answered every unknown action with the snapshot would hand the picker a console
buffer to present as a component. The bridge, when it falls back to an old collector, and the
picker keep their ids apart by type, numbers from the bridge and strings from the picker, so
each ignores the other's replies on a window they both listen to.

While Element is armed the picker asks one thing more, with a pair of DOM events rather than
messages (see [The name while hovering](#the-name-while-hovering)):

| Event | Sent on | Purpose |
| :--- | :--- | :--- |
| `__cdr_name` | the highlighted node, by the picker, composed and not bubbling | Asks for the name of the component behind the node. No detail |
| `__cdr_name:reply` | the window, by the collector, before the request's dispatch returns | `{ name, renamed }`: the nearest component's name, and `renamed: true` when a bundler made it up, or `null` when there is none. The picker takes the first reply, cuts the name to 60 characters and writes it as text |

Both are public by design. A page can send, answer or stop them (see the end of
`collector-main.js`), and what it changes is the name on the tag, which reaches no prompt.

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
request that is just finishing (a retry in `ontimeout`, the next long poll in `onload`), and Chrome
still dispatches that request's `loadend` afterwards, with the status already reset by the reopen.
So each `open()` starts a record of its own, a reopen parks the finishing record with the status it
ended on, and late events are credited to it. They are told apart by `readyState`: the finishing
request's own events arrive while the object is DONE, the late ones after the reopen has moved it
back to OPENED. An `abort()` on a finished request parks it the same way, because Chrome fires no
event for it and drops the object to UNSENT with status 0 before the `loadend` arrives. A park is
only committed once the native call has gone through, so an `open()` the browser refuses (a bad
method or URL) leaves the bookkeeping as it was. Parks can nest: a handler of a parked request can
finish a second request synchronously and reopen again, and Chrome then delivers the inner
request's late events before the outer one's, so the parked slot is a stack. A handler can also run
a synchronous request to the end without reopening, leaving the object DONE for a request that has
already settled; a settled record gets no more events of its own, so what arrives next goes to the
parked one. If no late event ever comes, a zero delay timer settles the parked record. Chrome can
also deliver a `loadend` before the abort or timeout event, when a handler runs a synchronous
request to the end, so a parked request that ended with no response and has no label yet is left to
that timer and recorded a task later. That timer, and the collector's own listeners, go through the
`setTimeout` and `addEventListener` the page had at `document_start`, not whatever zone.js or a
fake clock has put in their place since, so an Angular page does not run change detection for them.
A collector started after zone.js takes the natives zone.js kept (see [A tab that was open
before](#a-tab-that-was-open-before)).

The bookkeeping lives in a `WeakMap` inside the collector, not on the object, so the page never
sees it in `Object.keys` or `JSON.stringify`, and nothing is written onto a `this` that is not an
`XMLHttpRequest`. An `open()` over a request still in flight records that request as aborted,
because Chrome cancels it without dispatching any event, `loadend` included. An `abort()` labels
its request before the native call and settles it after, so a page listener that stops the abort
or `loadend` event cannot hide it. The listeners go on at the first `open()` rather than the first
`send()`, so a listener the page adds between the two cannot stop an event before it reaches
them. One added before the first `open()` runs ahead of them, since listeners on one target run
in the order they were added, whatever their capture flag (checked in Chrome for Testing 156). So
a failure is also caught at each event before `loadend`: the `readystatechange` to DONE, then
`load`, `error`, `timeout` or `abort`. The first of them to reach the collector sets a zero delay
timer, one per request (the record's `backstop`), that records the failure a task later unless
its `loadend` has. Such a listener hides a failed request only by stopping every event the
request ends with, and then until the object is opened again.

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
its name and length read as the native's and its `toString` says `[native code]`, though with no
name, as V8 prints any callable proxy (`function () { [native code] }`, where the native's reads
`function fetch() { [native code] }`). Only replacing `Function.prototype.toString`, which every
page uses, could hide that, and such a replacement prints that text for itself unless it lies about
itself too, and adds its own frame to every error it passes on. `callerFrames()` recognises the
collector's own frames by its address rather than by function names. It matches the whole address,
so a page file that happens to be called `collector-main.js` is still the page's.

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
abort, a timeout it set, an `open()` over it) before any real failure, so a type-ahead that cancels
a request per keystroke cannot push out the failure the report is for. Each ring counts what it
drops, and the snapshot carries the counts, so the prompt can say the log is the tail of a longer
one. A push that runs out of stack between adding its entry and dropping the oldest leaves its ring
one long, since the console wrapper swallows the throw, so the next push drops as many as it takes
to get back to 30, counting each, and the live counts read a ring as 30 at most (`push`, `counts`).
It drops them in one pass, requests the page ended itself first and then the oldest: dropping one
at a time, each found by a search of the whole ring, froze a page that had made thousands of such
pushes for 1 to 11 s at its next console call (Chrome for Testing 156), where one pass takes under
a millisecond. If that pass runs out of stack itself, what it has not looked at moves up behind
what it kept, so no entry is left twice, and the next push finishes the cut. Every entry gets `t`,
milliseconds since the collector started (`armedAt` in the snapshot), and `seq`, one count across
all four rings: a failed request, the warning it causes and the throw after it routinely share a
millisecond, and only the count keeps them in the order they happened. Both clocks the collector
reads, `Date.now` and `performance.now`, are the ones the page had at `document_start`. MockDate,
sinon's fake timers and Playwright's `page.clock` replace them later, and `t` is compared with the
panel's own clock.

The template merges the rings by `t` and then `seq` and prints a clock time in front of each
entry, built by hand rather than with `toLocaleTimeString` so every line of a prompt has the same
width, with the date in front when the entry falls on another day than the report. The page
section gives its times year first with the machine's offset from UTC
(`2026-08-07 20:51:33 UTC+02:00`), so they read the same in every locale and can be set beside a
server's log. The zone is given by the Captured line when the page prints, and by a line that
names the zone and the day of the entries that carry no date (`clockNotice`) wherever no Captured
line comes before the first log line. With the page toggle off, a single report gives that line
under Console and network. A list that prints a log under any item gives it above the first item,
so before the first log line it qualifies, whether or not the page prints, and not again at the
end. With the page on, the page section's Items captured line still gives the zone of its own
times. The frames printed under errors and requests, and a component's call site
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
own. The capture before it means before it in time, whichever row of the sheet it now stands
on: the template sorts the captures by `capturedAt` itself (`splitLog`), because the user can
reorder the sheet and the items arrive in its order. A moved item so keeps what was logged before
its own capture, and its log names the capture before it by that capture's number, which can be
higher than its own ("Logged since item 3:"). The earliest capture is the one whose share is
headed as logged on this page load before it. An item from another page, or from another load of
the same address, says its entries were not read. Another load is not called a reload, because a
second tab open on the same address looks the same. An item with no `armedAt` (stored by an older
build, or captured on a page too busy to answer) is judged by its page and its capture time, and
only when both are known: the panel passes the url it read the log on as `readUrl`, which is
compared and never printed, so the page toggle off does not leave the template guessing. Before
a log that started late (see
[A tab that was open before](#a-tab-that-was-open-before)), an item captured earlier says it was
captured before collection began rather than before the page last loaded, since no reload came
between, and the earliest capture's share of such a log is headed "Logged since collection began,
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
last listed item's own rather than the tab in view, and the block is headed "Page the last item
was captured on" instead. The items carry the sheet's numbers when every item sends one and they rise
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

## Whole page capture

Page (`capturePage` in `sidepanel/panel.js`) scrolls the tab one screen at a time, takes a
`captureVisibleTab` screenshot of each, and puts them together into one PNG in the panel. The
page's half is `content/page-shot.js`, which the panel injects and calls itself (see
[Message protocol](#message-protocol)).

**The loop.** It first clears the tab the way Screen does (`clearForShot`): an armed overlay is
cancelled and the page given time to repaint, within `ARM_TIMEOUT_MS`. Where a mode was armed on
the tab while it waited, Page does not start, since it would scroll the page out from under the
overlay the user just armed. Then it injects the file, calls `begin()`, and for each screen calls
`step(index)`, waits until `PAGE_PACE_MS` (520 ms) have passed since the previous screenshot, takes
the next one, checks that the tab in view is still the one it is scrolling, and keeps the PNG as a
`Blob`. Chrome allows an extension two screenshots a second, and `captureViewport` keeps its quota
retry for another window's panel capturing at the same moment. The run ends at the end of the
page, when the frames reach `PAGE_MAX_HEIGHT` device pixels (10,000) or `PAGE_MAX_AREA` pixels in
all (2^26), after `PAGE_MAX_SCREENS`, or when the page does not scroll any further, which the item
says rather than that the page was too long. `end()` is called in a `finally`, whatever happened,
and what it answers is read: no step follows the last screenshot to say the page ended the run by
itself before it was taken (the user scrolled just as the page reached its end), and by then the
page is back where it was, which that screenshot would show at the bottom of the image, so such a
run files nothing either. Every call into the page, and each screenshot, is raced against a
stop (`untilStopped`), so Stop, Esc and a tab switch end the run in the panel at once rather than
after a call in flight, and every call into the page is bounded at `PAGE_CALL_MS` (5 s), past which
the page is taken as gone. Then the frames are put together. Each `Blob` is decoded with
`createImageBitmap` only for its own draws and closed, so one decoded screenshot is held beside the
canvas at a time. The canvas is encoded with `toBlob`, where `null`, which Chrome hands over past its
canvas limits rather than throwing, is an error; the thumbnail is made from the canvas at up to
1600 pixels tall (`PAGE_THUMB_MAX_HEIGHT`, since `cdrThumbs` is written again on every add and
remove and reaches every window); and the canvas is released. The item goes through `addItem` like
any other, with `capture.blob` and `capture.thumb`, as mode `page`, named `_page.png`, with
`stitched` saying how it was made. Its time is the last screenshot's, so what the scrolling made
the page log sorts to it.

**Where each screenshot goes** is the pure `pagePlan`, tested on its own in
`test/capture.test.mjs`. It works in device pixels, `base` to a CSS pixel, read off the screenshot's
width as `cropCapture` reads it, so browser zoom and a device pixel ratio that is not a whole number
come out right. Each frame is placed by the offset the page reports it reached, not the one asked
for, so the last screen, clamped to the end of the page, overlaps the one before and is drawn over
it. The page steps a CSS pixel short of a screen, and each frame is drawn `ceil(height × base)` rows
tall at `round(top × base)`, so no row is left between two frames however the rounding falls. The
document's scrollbar is cut away by drawing only its client width. When an inner element scrolls
instead, the first screen is drawn whole down to that element's bottom edge, what was below it is
drawn moved down by how much further the element reached, and each frame's view of the element goes
at its own offset; beside the element, below the first screen, nothing was photographed, and the
page's background colour fills it. The image is held to the height and area limits at full
resolution, and says `cut` when it was, or when the frames stopped before the end of the page.

**What the page script changes.** `begin()` refuses pinch zoom (`visualViewport.scale` not 1),
because the screenshot is then only part of the layout viewport. It picks what scrolls: the
document, unless an element whose `overflow-y` is `auto`, `scroll` or `overlay` and which covers at
least a quarter of the view scrolls further. Candidates come from one walk of at most 20,000
elements, through open shadow roots and, where `chrome.dom.openOrClosedShadowRoot` exists, closed
ones; the stage has no `chrome.dom`, and walks open roots only. Unlike the overlay, which asks only
custom elements, the walk asks every element that can host a root (a custom element, or one of the
built in elements `attachShadow` accepts, such as `div`), because a widget's loader puts a closed
root on a plain `div` and a chat button fixed inside it repeated down the stitched page in Chrome
for Testing 156. Asking took about 15 ms over 20,000 divs there, so each element is asked once a run
and the answer kept in a `WeakMap`. The document counts only when the user can scroll it: one the
page has locked (`overflow-y` `hidden` or `clip` on the root, or on the body while the root's is
`visible`, as an open dialog, a cookie wall or a menu sets) can still be scrolled by a script when
it is `hidden`, so a run would go through every screen under the lock, loading and logging what the
user never reached, and with `clip` it would not move at all. Where nothing else qualifies, the run
is still: it neither scrolls nor touches a style, is the one screen in view as the user sees it,
and the item says the page locked its scrolling. Otherwise `begin()` records where the page was
scrolled, turns scroll snapping off on the scroller (mandatory snapping moved a programmatic scroll
from 600 to 409 in Chrome), and scrolls to the top with `behavior: 'instant'`, because a page's
`scroll-behavior: smooth` makes a plain `scrollTo` an animation that has not moved yet when the
screenshot is taken. Each `step()` scrolls, then walks the page again. A sticky element becomes
`position: relative` with its insets `auto`, so it shows once in its own place and still holds its
absolutely positioned children. A fixed element that overlaps the scroller and is shorter than 90%
of it shows on the first screen when its middle is in the upper half, on the last when it is in the
lower half, and is hidden on every other with both `visibility: hidden` and `opacity: 0`: a
descendant can set `visibility: visible` and still paint, and nothing undoes an ancestor's opacity.
A taller one, a sidebar or a backdrop, is left alone and repeats. Then the step waits two animation
frames (each at most 100 ms, since a tab that is not painting runs none) and for the images in view
to finish, at most 800 ms, since a lazy image starts loading only once it is scrolled near. Then it
walks the page once more: a page's scroll handlers run with the frame after a scroll, so a header a
script fixes once the page is scrolled is fixed only now, and lazy content may have lengthened the
page, which the bottom bar follows. When that walk changed anything, it waits two more frames.

Every style is set through the CSSOM, `setProperty` with `important`, never the style attribute, so
a page's CSP does not apply, though a page's `MutationObserver` sees it. For each property the
page's own value and priority are kept, and put back only where what is there is still the script's
own value: a value the page wrote during the run (a framework rendering its header again) stays the
page's. Such a write is hidden again on the next step. An element that had no style attribute is
left without one, not with an empty one a selector could see.

**How the page is put back.** This is the one script that changes a host page on purpose, so it puts
the page back by itself as well as when asked. `end()` restores the scroll position and then every
style. It also runs on its own, and the next step reports why: when no call has come for 4 s (the
lease, renewed at both ends of each step, so what it covers is the gap between two steps, the
pacing plus `captureViewport`'s quota retries, 1.8 s at most; the 800 ms image wait falls inside a
step); on `pagehide`; and on a trusted `wheel`, `touchstart`, `keydown` or `pointerdown` on the
window, heard in the capture phase and passively (`stopped: 'user'`). A `begin()` puts back a run
the panel lost track of before it starts another. Every handler the page can reach is wrapped in
`try`, so nothing throws into page code. The file is injected again for every capture, so, like the
overlay, it declares nothing at the top level with `const`, `let` or `class` and caches its
controller on `window`. `test/page-shot.test.mjs` runs it in a `node:vm` realm against a model of a
page (`test/support/page-realm.mjs`), on its own and with the real panel on one clock.

**When it stops early.** Stop and Esc (after the row tooltip and an open markup, and before an
armed mode) cancel it, file nothing and only tell a screen reader "Page capture cancelled. Nothing
was filed." The
banner says why for the others: input on the page; a switch to another tab, found by `resolveTab`
or by the tab in view after a screenshot; the tab leaving or reloading the page, which the page's
own `pagehide` or a document without the controller shows; a viewport of another size than at
`begin()`, or a screenshot whose height disagrees with its width by more than 3% (as
`cropCapture` checks); a `cdr:armed` for the tab, the shortcut arming Region over it; and a page
that stopped answering. Each of the page's own stops (input, `pagehide`, the lease) is heard from
the next step, or from `end()` after the last screenshot. `tabs.onUpdated` is not used to stop it,
since Chrome reports `pushState`, `replaceState` and a hash change as `loading` (see
[Message protocol](#message-protocol)), and an endless feed changes its URL as it scrolls.
Closing the panel sends `end()` without waiting
(`flushOnClose`), and the lease is there for a call that never leaves. Once every screenshot is in
and the page is back, only Stop or Esc throws the result away (`composing`), since a tab switch or
an arm then has nothing left to spoil, and the item is filed under the tab, address and title the
run started on, not whatever tab is in view by the time it is added.

**Why not `chrome.debugger`.** The DevTools protocol's `Page.captureScreenshot` with
`captureBeyondViewport` takes one tall image without scrolling, and it was rejected on two grounds.
The `debugger` permission cannot be optional, so adding it would disable the extension on update
until the user accepted "Access the page debugger backend", and while it is attached Chrome shows
an infobar on every window, which shortens the tab's view and fires a resize. And it draws a
different page: in a probe of that call in Chrome 157 for the 0.7.0 design, a bar fixed to the
bottom was drawn once at the bottom of the first screen, over the content, an image with
`loading="lazy"` further down was never requested and came out blank, an inner scroller showed
only its first screen, and a virtualised list renders only its visible rows. Scroll and stitch
costs half a second a screen, visibly moves the page, and can leave a seam where the page moves
during the capture, but it needs no permission and no infobar, renders what loads on a scroll,
follows an inner scroller, and runs on the stage.

**What it costs the page.** The page sees real scrolling. Its scroll handlers and
`IntersectionObserver`s run, lazy images load, an endless feed fetches its next page, analytics
record the scroll depth, and whatever of that fails lands in the log, sorted to this item.
PRIVACY.md says so. The collector, in the main world, is not touched.

**Memory.** At the cap on a 2x display a run holds about seven screenshots as PNG `Blob`s, a few MB
each, and while they are put together a canvas of up to about 100 MB and one decoded screenshot.
For that reason a page item is never held for marking up (`markupBlocked` says why), which would
need the decoded page and the markup's canvas as well.

**Not handled.** Only vertical scrolling is captured. An inner scroller under a quarter of the view,
such as a dialog's body, is not chosen; Region or Element covers it better. A modal that leaves the
page scrollable has its backdrop repeat on every screen (one that locks the page makes the run
still). A video or an animation differs from screen to screen, and a page
that moves between a screenshot and the next step leaves a seam. So does a header a script takes
out of the flow once the page is scrolled, which moves everything below it up inside the step: in
Chrome for Testing 156 a 56 px nav cut 56 px out of the page at the first seam, and scroll anchoring
did not make up for it. The item says so when the page's scroll position changed between a screenshot
and the next step, or its height changed then or during a step. A feed that grows as it is scrolled
gets that notice too, though its seams may well line up.

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
Otherwise the overlay looks for open modal dialogs in the document and in the page's shadow roots
(`collectRoots`). A closed shadow root answers null to `shadowRoot`, but a content script can ask
Chrome for it with `chrome.dom.openOrClosedShadowRoot`, which needs no permission and costs about
half a microsecond (`shadowOf`). The focus walk and the hit test below ask it of every host they
pass. The walk asks it only of custom elements, each once per arm (`closedRootOf`), since asking
every element cost 15 ms a walk at 24 000 elements. So a dialog in a closed root is found, and
the host put inside it, as in an open one. The walk is a tree walker over at most 20 000 elements
(`ROOT_SCAN`): half of them forward from the start of the page and half backward from its end,
each shadow tree walked where its host stands, until the two meet. A page under the budget is
walked whole, and a larger one has its first and its last 10 000 elements walked, so a toast stack
or a dialog portal appended to the body is found as well as a component near the top. It takes
about 1.4 ms over 20 000 elements in Chrome for Testing 156, closed roots included, where reading
each element's children for open roots took 8 ms. Of
several it takes the one on top by hit testing the middle of each (`modalOnTop`): Chrome passes
over inert nodes, and the top dialog's backdrop answers for the rest of the viewport (checked in
Chrome for Testing 156). Going by document order put the host into an older dialog underneath, or
on the body under a shadow root's dialog, where it was inert. While Region is armed the host is
kept there. Every animation frame the overlay checks that the host is still in the document, that
the dialog it is in is still modal and that its popover is still shown, and every fifteenth frame,
or at once on `focusin`, `toggle`, `close` and `fullscreenchange`, that no other modal dialog has
opened and that no element has gone fullscreen or left it. When any of
that has changed it takes the host out and mounts it again, so a dialog the page closes or
removes, or one it opens after the arm, no longer leaves the overlay invisible or inert while the
panel shows Region armed. A popover the page shows while Region is armed (a toast) goes above the
host in the top layer, so on its `toggle` the host is hidden and shown again, which puts it last
in the top layer, above the toast. A popover a component shows from its shadow root sends its
`toggle` no further than that root, so the same fifteenth frame check also compares what is in the
top layer, in the document and in the shadow roots known, with what was there when the host was
last raised, and raises it over anything new. Of the shadow roots, only those the last walk found
holding a popover or a dialog are queried (`holdsLayer`, `queryAll`), whether or not the page has
changed since: querying every known root once anything had changed cost a page that changes all
the time 10 to 13 times what 0.6.0 spent with closed roots. Pressing the shortcut again raises the
host over whatever covers it at once. A page that removes or covers the host every time it comes
back is answered a hundred times per arm and then left alone; arming Region again answers once
more.

The walk runs each time the host is placed, when the shortcut is pressed again, and at a fifteenth
frame check when the page has changed since the last walk, at most once a second by the clock
(`ROOT_WALK_MS`, against `performance.now`), whatever the display's frame rate. A bound of 60
frames, as before, was half a second at 120 Hz. The check at the first frame after an arm does not
walk, since the arm has just walked. A `MutationObserver` on the document and on every shadow root
walked says whether the page has changed (`watchChanges`): it watches child lists and the
`popover` attribute, ignores the host's own moves, and disconnects at the first change until the
next walk reconnects it, so a page that changes all the time pays for one batch of records per
walk. A live count of the document's elements is cheaper to read, but sees no change inside a
shadow root and none to a `popover` attribute. So a popover put into a root that held a popover or
a dialog at the last walk covers the overlay until the next check, a quarter of a second at most
at 60 Hz. One put into a root that held neither, or into a root attached since the last walk, waits
for the next walk, which that change brings at the next check when the last walk was a second or
more before, and otherwise within a second and a check (1.25 s at 60 Hz). Some are not found that
way. A component in the middle of a page larger than the budget is never walked. A shadow root
attached to an element already in the page (a component defined after the arm, or `attachShadow`
on an existing element) changes no child list, so it waits for a walk something else causes, the
next placement or the shortcut. A closed root attached during the arm to a custom element the walk
has already asked about waits for the next arm. And a modal dialog in a closed root on a built in
element (a `div`) is reached only through the focus, so not while nothing in that root has focus.

Measured as the overlay's CPU over 3 s armed at 60 Hz (Chrome for Testing 156, a CDP profile, two
runs of 0.6.0 and three of this release), a quiet page costs 13.6 to 14.2 ms at 51 000 elements
against 12.3 to 13.6 in 0.6.0, 4.2 to 7.3 ms with 2,000 or 6,000 closed roots against 2.5 to 6.7,
and 4.3 to 7.8 ms with 2,000 or 6,000 open roots, where 0.6.0, which queried every known root at
every check, took 21 to 47 ms. Its longest check took 1.1 ms. A page that changes its tree every
frame costs 18 to 19 ms at 51 000 elements against 12 to 14, and 11 to 13 ms with 2,000 open roots
and 22 to 24 ms with 6,000, about half of 0.6.0's 22 to 23 and 45 to 48. With closed roots it costs
about three times 0.6.0: 11 to 12 ms with 2,000 against 4, and 23 to 24 ms with 6,000 against 6.5
to 6.7. That is the walk itself, about 6 to 7 ms over 6,000 roots once a second, which is also the
longest single stretch there; 0.6.0 walked only when it placed the host, and saw no closed root.
Asking Chrome about each custom element once makes an arm cost 20 to 29 ms of CPU on a page of
20 000 custom elements (its longest stretch 8 to 14 ms), against 11 to 13 ms in 0.6.0.

An element shown fullscreen makes everything outside it inert, as a modal dialog does: the host,
shown after it, was drawn above it, and every press passed through it to the page (seen in Chrome
for Testing 156). So with no modal dialog open the host goes inside the fullscreen element, found
through shadow roots (`fullscreenHolder`), unless that element holds the body, as when the whole
page is shown fullscreen. Which element may take it is decided from its type before anything in the
page is touched. One that draws no children, or whose children are what it shows or loads (audio,
canvas, embed, fencedframe, frame, iframe, img, input, object, optgroup, option, script, select,
style, template, textarea and video, `NO_HOST`), and any element outside the HTML namespace (svg,
math), never gets it: Chrome loads an `<object>`'s document again when a child is added to it, so a
host put there and taken out again reloaded a fullscreen PDF on every arm. Over such an element the
host stays on the body, drawn above the element and inert, and Region cannot be used until the page
leaves fullscreen. When the fullscreen element has a shadow root, open or closed, the host goes
into that root, where the element's light children, its slots and its own `:last-child` rules never
see it, no `slotchange` fires, and a component with no default slot draws it all the same. Without
one the host is the element's last child, since every position is seen by some selector and last
trips the fewest (`:last-child`, `:nth-last-child`, `:last-of-type`, `:only-child`, `:empty`). On a
slide laid out with Tailwind's `space-y` the cards moved up 20 px while armed, and the screenshot,
taken once the host is gone and the slide has moved back, was 20 px off what was selected. So the
overlay reads the boxes of up to the last 64 children before and after placing the host
(`childBoxes`, `movedSince`), and when any moved or resized by more than half a pixel,
`cdr:region-selected` carries `moved: true` and the panel says the crop may be off
(`MOVED_UNDER_OVERLAY` in `sidepanel/panel.js`). That costs one more forced layout per placement,
about 0.1 ms with 64 children. Only direct children are measured. Any other element in which the
host gets no box (one hidden with `display: none`) is found by asking (`drawn`), and the host goes
back on the body until fullscreen changes or the shortcut is pressed again. Looking for a box
forces a layout, so it is done only in a fullscreen element. When an element goes fullscreen while
the host stays outside it or is already in it (the body), the host is raised above it on
`fullscreenchange`, and the fifteenth frame check counts a new fullscreen element as new in the top
layer. While the host is inside the element shown fullscreen (directly, in its shadow root, or in a
modal dialog inside it), the overlay's root also stops `mousemove`, `mouseover`, `mouseout`,
`pointerover`, `pointerout`, `wheel` and the touch events at itself, with passive listeners
(`swallowInFullscreen`), since the element's own handlers would hear them there. `pointerenter` and
`mouseenter` go to each element the pointer enters and cannot be stopped. On the body, or in a
modal dialog when nothing is fullscreen, those events reach the page as in 0.6.0, on purpose:
smooth scrolling libraries and document `mousemove` listeners rely on them. In a dialog or a
fullscreen element the host is a child the page's own code can see, as it is on the body, and the
page's elements are around it. So a click, a double click and a middle click (`auxclick`) on the
overlay are cancelled as well as stopped there (`cancel`): inside a fullscreen element nested in a
link, a label or a form's button, a press too short to select followed the link, toggled the
checkbox or submitted the form, and a touch tap did the same, while the page's own handler that
would have prevented it never ran. The page's capture listeners still hear such a click first, and
its bubble listeners do not. In a fullscreen component's shadow root the component's own rules
apply to the host and beat its `:host` reset, so the host's inline style also sets
`pointer-events: auto`, `visibility: visible` and `opacity: 1`, which beat any rule of the page's
but an `!important` one: a `* { pointer-events: none }` there left the overlay drawn while every
press went through to the component. Not `display`, which would override the rule that hides a
popover that is not shown, so a component rule such as `div { display: none }` still leaves the
host without a box, and `drawn` puts it back on the body. Other properties a component's rules set
on every element, such as a transform, a filter or a clip path, still apply to it. On disarm the
overlay lets go of every page node it held, the shadow roots of its last walk, the top layer it
last saw, the fullscreen element it gave up on and its observer's registrations (`stop`), so a
component removed after a disarm can be collected.

Each frame the overlay also checks that the extension is still there: a reload or a removal
leaves the script running with no extension id, and nothing it sends would arrive, so it stops
itself and the page gets its pointer back. A browser without popovers gets a fixed position host
on the body. The root sets `touch-action: none`, so a finger drag selects instead of panning, and
a cancelled pointer (`pointercancel`, or lost pointer capture) ends the drag without sending
anything.

The overlay also takes keys, heard on the page's window, and from the panel, which hands the
arrows and Enter to it through the controller's `key()` while Region is armed. The first arrow
puts a box of half the visible area in its middle, measured against the visual viewport. The
arrows move it by ten pixels, Shift with an arrow moves its right or bottom edge instead, Alt
makes each step one pixel, and Enter captures it once there is a box to capture.

**The picker.** The picker draws on a host whose own style is set inline with `!important`, so
page CSS cannot move, hide or fade it. When the top layer is in use (a modal dialog, an open
popover, a fullscreen element), the host is made a manual popover and shown, which puts it above
what is there, and it is shown again whenever something enters or leaves the top layer. A
popover or a dialog that the page shows or closes inside a shadow root fires a `toggle` or a
`close` that goes no further than that root. So the picker listens for both on every shadow root
it has found, open or closed (`addRoot`), and raises the host as soon as one comes, a task after
the change, also for one the page hides and shows again at once (checked in Chrome 156). Every
fifteenth frame it also compares what is in the top layer, in the document and in those roots,
with what was there when it last raised the host, and raises it over anything new. That covers a
root it has not found yet: a popover in one can cover the highlight for about a quarter of a
second. Every frame, and every frame of the tail
after a pick, the picker also checks that the extension is still there (`orphaned`): a picker left
by a reloaded or removed extension stops itself, takes its sheet out of the page and gives the page
its pointer back.

A frame (an iframe, frame, embed or object) takes every pointer event over it, so left alone the
page never hears the pointer there and a press goes into the framed page, for real. While the
picker is armed, and through the tail after a pick, frames let the pointer through instead. The
picker adopts one constructed style sheet into the document's `adoptedStyleSheets`, and into those
of every shadow root, open or closed, that holds a frame. It gives each frame tag
`pointer-events: none !important` under a selector with the specificity of eight ids,
`iframe:is(*, #\:#\:#\:#\:#\:#\:#\:#\:)` and the same for frame, embed and object
(`PASS_SELECTOR`). `:is()` counts as its most specific argument, and `*` makes it match every
frame, so a page's own `!important` rule on a frame by id no longer beats the sheet, and each
selector still names its tag, so only frames are matched against it on a restyle (checked in Chrome
156). A move or a press over a frame then reaches the page, where the capture listeners keep it,
and nothing goes into the frame. What the page draws over a frame (a hover menu, a tooltip) keeps
the pointer and its hover, as it would with no picker. A frame is still picked whole, since what is
inside it is another document, and the picker finds it in two steps (`frameAt`). With the sheet on,
the hit test passes through every frame, so where the pointer is inside no frame's box, which is
nearly every move, no frame is there and nothing on the page is restyled. Where it is inside one,
the picker takes the sheet off for a single hit test and lets the browser say what is drawn there,
which accounts for clipping, stacking, visibility, rounded corners and fixed frames as drawing
does: a carousel's slide out of view, the lower of two frames, and an `<object>` showing its
fallback are not picked where they are not seen. That restyles the whole page, 28 ms a move at
100 000 elements (measured in Chrome), as every move once did, but only while the pointer is over a
frame. A menu drawn over a frame is what that hit test finds, so the menu is picked. The boxes of
up to 2,000 frames are read, after the hit test has brought the layout up to date. The box is taken
a pixel wider on each side, since a frame at a fractional offset is drawn and hit tested on a pixel
row its box starts just past. At a press the frames are looked for again, so one the page put in
since the last survey (every 15 animation frames) is picked too. The children of an `<object>`,
drawn only as its fallback, inherit `none` from it and show no hover while picking, but the lifted
hit test finds them, so a missing PDF's link can be picked. Giving them `auto` back would take a
`none` from them that the page meant: `:where(object > *) { pointer-events: auto }` costs no
restyle time that can be measured at 100 000 elements, and keeps a `none` the page sets on the
fallback or inside it, but a `none` the page sets above the object reaches the fallback only by
inheriting through the object, and that rule cuts it off, so the fallback took the pointer where
Chrome finds what lies under it (checked in Chrome 156). No CSS inherits past the object. An
earlier note here said the rule slowed every restyle by a quarter; that did not reproduce. A page
that sets its own adopted style sheets while you pick drops the sheet. The picker puts it back on
the next animation frame, again just after the page's own animation frame callbacks, at a survey
before any style is read, at every press, and as soon as the pointer enters a frame
(`keepPassing`). It puts it back directly, with nothing held and before anything restyles, so the
frames, which still hold `none` from their last restyle, start no transition: putting it back under
the hold below, after a hit test that restyled the tree without the sheet, made a page that resets
its own lists in an animation frame loop hear 363 transition events in a second (6 in 0.6.0, and
now). If the page's change is restyled before the sheet goes back (it reads a style right after
setting its list, or sets it in an animation frame callback added after the picker's), its frames
run their own `pointer-events` transition and the page hears it, as in 0.6.0. A press made in the
same frame as such an assignment, with no pointer movement since, can still reach the frame. A page
script that reads `adoptedStyleSheets` while the sheet is there can see it. When picking ends the
sheet is taken out of every list and emptied, so a copy of the list that the page kept and puts
back later holds a sheet that does nothing.

A frame inside a closed shadow root is handled as one in an open root. A page script gets null
for a closed root, but a content script can ask Chrome for it (`chrome.dom.openOrClosedShadowRoot`,
about a microsecond an element, `shadowOf`). Only the elements that can hold a shadow root are
asked: custom elements and the eighteen built in ones `attachShadow` takes (`SHADOW_HOSTS`). The
survey asks about each element once an arm, about 14 ms at 20 000 elements (measured in Chrome),
and asks again each time about a custom element not defined yet (`surveyedShadowOf`). The pick,
the top layer check and the focus walks go into closed roots the same way, and the pointer's own
paths ask Chrome afresh. A frame in a shadow root attached after the arm is found by the next
survey, or as soon as the pointer enters it; in a closed root attached after the arm, only by the
pointer. On a page of 20 000 elements with 60 shadow roots, half of them closed, an arm took 21 to
45 ms against 6 to 22 ms before, and frame pacing while armed did not change.

A page rule can give a frame a discrete transition of `pointer-events` (`transition: all .3s
allow-discrete`, or one naming `pointer-events` with `allow-discrete` and a duration or delay above
0). Such a frame kept its old value for half the transition as the sheet came in and as it was
lifted, so the lifted hit test passed through it and picked what lay under it, and the page heard
transition events on every move over it (66 over four picks in 0.6.0). So on a page where some
frame's own computed style gives `pointer-events` such a transition (`transitionsPointer`), the
picker holds discrete transitions back, with `transition-behavior: normal !important`, but only for
the moments its sheet changes a frame's `pointer-events` (`holding`): when the sheet is adopted
into a tree for the first time in an arm, when it is lifted for the hit test and put back, and when
it is removed at the end. Each time it first brings the page's own pending style changes up to date
with a hit test, so they run with the page's transitions, then swaps in the held rule (`HELD_RULE`,
or `LIFT_RULE` for the lift), makes its change, restyles at once (`restyle`, a read of the html
element's computed style, which restyles every tree whose adopted sheets changed, closed roots
included), and goes back to the plain rule before any script of the page's runs. The page's own
fades of a frame (`display`, `overlay`, `opacity`) run as written and fire all their events, and
such a frame is picked where it is drawn. Whether some frame has such a transition is asked of
every frame found and drawn, up to 2,000 (`FRAME_BOXES`), at the arm and at each survey until one
answers yes, and of the frame under the pointer at each lift and of a frame the pointer enters. A
frame not drawn (`display: none`, or in content the browser skips: `content-visibility: auto` off
screen) is passed over, since reading the style of one in skipped content lays it out, and so does
`checkVisibility()` with no options. The frames passed over are kept and asked again before each
change of the sheet (`drawnSince`, with `checkVisibility({ contentVisibilityAuto: true })`, which
costs no layout), so one shown or scrolled into view while armed is held from the first change
after it, not from the next survey. Once found it stays found until the next arm (`discrete`), so a
frame seen once keeps the hold through Escape. Asking only the first 100 frames at each survey left
a frame past them unheld at the arm, where a press right after it went into the framed page in 2 of
3 tries. Holding back discrete transitions for the whole arm, as a first attempt did, cut the
page's fade of a chat frame short: it snapped to `display: none`, fired nothing, and the
`transitionend` that removed the frame never ran. On a page with no such frame nothing is held, and
a lift is the sheet's `disabled` toggle as before (median 4.1 to 4.2 ms at 60 000 elements with 100
frames); with one, each lift takes one more full restyle (8.5 to 8.7 ms). Asking every frame costs
a page with more than 100 and none such: on 2,000 plain iframes a survey took a median of 1.0 to
1.2 ms against 0.3 ms when only 100 were asked, about four times a second, and the one at the arm
up to 3.8 to 6 ms against 2.6 to 2.8 ms (Chrome 156). Once one is found the surveys skip the
question, and on that page each lift then took 5.4 to 7 ms against 3.2 to 3.7 ms. Past 2,000
frames, when none of the first 2,000 has such a transition, a frame beyond them is adopted without
a hold: the page hears its transition at the arm, and for half of it the frame takes a press; once
the pointer has been over that frame, the hold stays for the rest of the arm. A frame that gains
such a transition after the arm, while none had one, is found by the next survey (within 15 frames)
or by the pointer, and picking that ends before then removes the sheet without a hold.

Before the sheet, a transparent shield over every frame kept the pointer from it, and took the
hover from whatever the page drew over a frame; one put up only once the pointer reached a frame
would come too late, since a cross site frame tells its parent nothing when the pointer goes into
it (checked in Chrome 156). Shields are left only for a frame whose own `pointer-events` beats the
sheet: an inline `!important`, an `!important` in a cascade layer of the page's, or one whose
selector holds more than eight ids. A survey every fifteenth frame finds such a frame by its
computed `pointer-events`, and a menu drawn over it loses its hover while the picker is armed.
Nothing in the page's own origin beats the first two, whatever its specificity: an inline
`!important` beats every other author `!important`, and for `!important` the layer declared first
wins, while the page's sheets come before the picker's (CSS Cascade 5; seen in Chrome 156). A
sheet the extension inserts with user origin (`chrome.scripting.insertCSS`) would beat them, but
only the worker can insert or remove one, asynchronously, and `frameAt` lifts the sheet in the
middle of a move. The sheet has no layer of its own: a layer would beat an unlayered `!important`,
as the eight ids do, but a sheet holding one made every lift six times slower (194 to 375 ms
against 28 to 35 ms, measured in Chrome).

Only a frame with a shield puts the host inside a modal dialog, where everything outside is inert
and a shield from outside let the pointer through to the frame. Otherwise the host stays at the
end of the body, in the top layer above the dialog when there is one, since the box, the tag and
the hint take no pointer. As body's last child it takes `:last-child` from the page's own last
element, so a page that spaces body's children by margin (Tailwind's `space-y`) moves while the
picker is armed (4 px on a vertically centred test page), which is undone before the element is
read and photographed. No other place is better. After body, as the html element's last child,
the host took `:last-child` from body itself, so a page's `body:last-child` or `html >
:last-child` rule stopped matching body while armed (a background of `rgb(1, 2, 3)` went
transparent in Chrome 156). Before head it changes body's `:nth-child` and takes head's
`:first-child`, and to be drawn above the page from there it would have to be a popover all the
time, which a page hears as `toggle` events and matches with `:popover-open`. No place under the
html element leaves every structural pseudo class of body unchanged. In a dialog the host is its
last child, and the same rule moves the dialog while the picker is armed, which only a frame that
needs a shield there brings about.

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

What it keeps from the page's own listeners. Window is the first node on the capture path, and
Chrome runs the listeners on one target in the order they were added, across worlds. So a page
script that put a capture listener on the window before the picker was armed heard the press that
picks, every press of a double click included, and the keys, before the picker could stop them.
A small content script declared first in the bridge's entry, at document_start,
`content/press-gate.js`, adds capture listeners on the window for the 17 event types the picker
keeps (presses, clicks, pointer and touch events, pointer capture, `contextmenu`, the keys and
`selectstart`; the touch ones passive) before any script of the page's own runs. It hands each
event to the picker through a hook the picker sets at its first arm in the page
(`window.__cdrPressGate.hook`, set to `route`), and calls nothing before that. `route` acts on an
event only while the picker is armed, through the tail, and while the Enter that picked is held,
and otherwise returns without reading it. The picker keeps its own listeners for a tab
where the gate came too late or not at all, and handles each event once, whichever listener hears
it first (`seen`). Those tabs are one open from before the extension was installed or enabled,
since Chrome does not inject declared content scripts into open tabs, and a site the narrowed
`matches` leave out. A tab open across an update or reload of the extension keeps the old
version's gate, and whether the new picker is handed its events there was not checked. On such a
tab a page capture listener on the window added before the arm runs first. One that only listens
hears the press and the keys; the picker still gets them after it, picks, and cancels the default
action of the mouse events and of the keys it takes, and no listener below the window hears them.
One that calls `stopImmediatePropagation` keeps the press from the picker entirely: nothing is
picked, and the press does what it would with no picker (a link is followed). Keys stopped that
way, Escape, the arrows and Enter among them, do not reach the picker either. The gate is not
injected into open tabs at install, since that would touch every tab the user has open, and it
would come after the listeners those pages already have.

Chrome also grants the page transient user activation as it dispatches a press or a key, before
any listener runs: on a mouse's `pointerdown`, a finger's `pointerup` and `touchend` and the
`mousedown` its tap makes, and on every `keydown` but Escape's (checked in Chrome 156). Neither
`preventDefault` nor `stopImmediatePropagation` takes it back, and no API withdraws it. So the
picker spends it on every such event it keeps (`spend`): `showPicker()` on a button input that is
in no document spends it and shows nothing (checked in Chrome 156). After a pick the page can no
longer open a popup or start playback as if it had been clicked. An activation the page already
had from a click of its own in the five seconds before the pick is spent with it. What stays is
sticky activation (`navigator.userActivation.hasBeenActive`), which nothing takes back, so a page
that was never clicked reads as clicked once after a pick, and some features ask for that, such as
audio that plays with sound.

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
its release are kept from the page until it is let go, past the tail too (`holdEnter`), since
each repeat sent the form whose field had focus (62 submits in three seconds in 0.6.0). The hold
ends at the key's release, at a press of Enter that is no repeat (the key was let go where the
page could not see), or when the window loses focus or the page is hidden. Any other key reaches
the page. The highlight goes at once, and so does the host, unless it shields a
frame the sheet does not reach, which would otherwise take the rest of the press for real. The
payload is read with the host taken out of the page and put back in the same task, so the host
never shows up in the markup, the text or the selector.

The selector is tested with `querySelectorAll` as levels are added, up to eight tests, and stops at
the first one that is unique. No CSS selector crosses a shadow boundary, so inside a shadow root,
open or closed, the path stops at the root and the host's own path goes in front of it, joined with
` >>> `, the deep combinator Puppeteer and WebdriverIO read. When the whole is longer than 200
characters, ancestor classes are dropped, and the selector is then sent whole; only one longer than
4,000 characters, which is no path a page builds, is cut to the element's own level in the picker.
The template prints at most 200 characters (`formatSelector`). It leaves out leading steps first
and then the element's own classes, never the element's own step, and says what it left out; when a
step it left out is a shadow host, it says the selector starts inside a shadow root and does not
match from the document. The picker leaves the shortening to the template so that the template
knows which hosts were left out.

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

## Marking up a capture

**Mark up** draws arrows and ellipses on the capture in the frame and saves them as a copy that
takes the item's file over. It is offered only by the panel that took the capture, and only while
it stays open, because only that panel holds the capture without marks: the `Blob` the save was
given, kept on the item as `item.full` (`holdFull`). A `Blob` lives in Chrome's blob store rather
than on the page's heap, and Chrome may page a large one out to a temporary file in the profile.
The panel keeps those of its 10 newest captures, about 100 MB together at most, letting the oldest
go first (`trimFulls`), never the newest and never the one being marked up, and lets one go as soon
as its item is copied, its discard is final, its first save fails, or it leaves the sheet in another
window. Whether an
item can be marked up is decided in one place, `markupBlocked`, which returns the reason it cannot
or null. An item that cannot still shows the button, dimmed with `aria-disabled` rather than
disabled, so that a press can say why: it came from storage, from another window, or was let go
to keep within the bound. A whole page is never held at all (`holdFull` skips mode `page`), since
at the cap it decodes to about 100 MB and the canvas needs as much again; its reason says to
capture the part with Region. Mark up also waits while a copy or a capture runs, while the item's
previous marked copy is being saved, and while its own capture is being decoded.

Opening decodes `item.full` with `createImageBitmap` and puts a canvas in the image's place, sized
to show the whole capture as large as the frame's width and 70% of the panel's height allow, with
as many canvas pixels as the screen has under it, and sized and drawn again when the panel is
resized. The canvas draws in the capture's own pixels through a transform. The marking tools take the place of the capture buttons, which are hidden and
disabled meanwhile, also against a tab event (`applyModesDisabled`). `renderFrame` runs on every
move and every adopted write, and leaves an open markup alone: only the readout and the buttons
follow the item. Each mark is a record of a tool and two points as shares of the capture's width
and height, and `drawMarks` is the only code that draws one, on the canvas through its transform
and on the saved copy at full size, so what is seen while marking is what is saved. The marks are
one fixed magenta over a white edge, whatever the theme, because the prompt names that colour; the
stroke is a 200th of the capture's longer side and never under 4 pixels.

A drag draws: the canvas takes pointer capture, so a drag that leaves it ends on its edge, and a
shape shorter than 4 CSS pixels is not drawn. From the keyboard, on the model Region teaches, the
first arrow key or Enter shows a crosshair in the middle, the arrows move it by a fiftieth of the
capture (with Alt, one CSS pixel of the canvas as shown), Enter fixes the first point, and Enter again draws the shape;
each step is announced. Cmd or Ctrl+Z takes back the last mark and nothing else: one listener
handles both undos, and while a markup is open a discard waiting to be undone is left alone, and in
the description field the key is the text's own. Esc closes the row tooltip first, then drops a
shape half drawn, then closes the markup, and only after that reaches an armed mode. `forwardsKey`
hands no key to the page while marking. Closing the markup by Esc, Done, another row, + New item or
a capture arriving saves marks that changed (`commitMarks`), so a stray key never loses them; only
Cancel closes without saving, and a discard takes the item with its marks unsaved. A ticked item
being marked up holds Copy back, and so does Cmd or Ctrl+Enter, through `blocked`.

**Saving the marked copy.** Done draws the capture and the marks on a canvas of the capture's own
size, and `canvas.toBlob` hands the PNG to `saveScreenshot` as a `Blob`, with no data URL in
between. It is named for the capture's own time and mode with `_marked`, so it sits beside the
capture it replaces; with every mark taken back it is the clean capture again, takes the capture's
own name without `_marked`, and leaves the item no longer `marked`. Done with the marks as they
were last saved saves nothing, and drops marks kept from a failed save that were taken back since.
Meanwhile the item says SAVING and Copy waits for it, as for a first save. When
Chrome has the path, `swapFile` points the item at the copy, stamps it with `fileAt`, stores it with
its thumbnail, and only then deletes the file it replaced. In the other order the old file's
removal reaches `downloads.onChanged` while the item still names it, and marks it missing. The old
file stays when the prompt being copied by hand names it (`state.handCopy`). An item discarded
while its copy saves is swapped where it waits in the discard, so Undo brings it back marked and a
lapse deletes both files once each. An item that has left for good meanwhile, copied here or in
another window or its discard settled, keeps the file it had, which a prompt may name, and the copy
nothing names is deleted. A save that fails, or is cancelled in a "Save as" dialog, changes
nothing on the item, says so, and keeps the marks for the next Done. On `pagehide` a marked copy
still saving is taken back like any save in flight, and the stored item keeps the file it had.

## The sheet in storage

**Keys.** `cdrReport` holds `{ items, removed, updatedAt, writer }`. Each stored item keeps `id`,
`mode`, `width`, `height`, `url`, `title`, `intent`, `description`, `included`, `element`,
`capturedAt`, `armedAt`, `rank` (only once it has been moved, see Order below), `editedAt`,
`wordsAt`, `path` and `downloadId`, once it has been marked up, `marked` (only as `true`) and
`fileAt`, and for a whole page (mode `page`), `stitched`: `{ screens, cssWidth, cssHeight }` and
`cut: true` when the page went on below the image (`storedForm` in `sidepanel/panel.js`); its tab,
its thumbnail, whether its file is missing, its clean capture and its marks are not stored. A
version without `marked` and `fileAt` drops them on its next write: the item goes on naming its
marked file and loses its MARKED label and the prompt's sentence about the marks. A version
without the `page` mode reads a page item as `other`, shown as CAPTURE, drops `stitched`, and
still copies the item with its file; the prompt then says nothing of how the image was made.
`cdrThumbs` holds `{ items, writer }`, the thumbnails by id. `cdrIntent` and `cdrInclude` are
keys of their own, each written only when that setting changes, and every panel adopts both.

**Reading it back.** Whatever the panel reads from storage is treated as data from outside:
an older or a newer build wrote it, or something else did. It is validated before use (`readItem`
and `readReport`): known fields only, ids of at most 100 characters and no two alike, at most 500
items and 50 000 characters per description, paths without control characters or line breaks
(the prompt prints each on a line of its own), an unknown mode shown as `other`, element data only
for element items, stamps (`editedAt`, `wordsAt`, `fileAt` and each removal's time) only as far as
two days ahead of the clock, a stamp further ahead read as none and a removal so stamped dropped
(see Merging, below), a rank only as a finite number no further than 2^52 from zero (past 2^53
adding one changes nothing, and a capture could no longer land after it), `marked` only as
`true`, `stitched` only on a page item and only as whole numbers above 0 (at most 100 screens and
100,000 CSS pixels a side, `cut` only as `true`), since the prompt prints them as facts, and
thumbnails only as base64 WebP, PNG or JPEG data URLs,
since anything else in an
`img` would be a request to the network. Content scripts can write an extension's local storage
unless it says otherwise, so the worker restricts `chrome.storage.local` to trusted contexts at
every start.

**Merging.** Every panel merges another panel's write into its own sheet item by item, instead of
replacing the sheet. Each item carries two stamps: `wordsAt` for the description, and `editedAt`
for the intent, the tick and the place on the sheet. Each field keeps whichever copy was changed
last, and a side holding something newer writes it back. An item marked up carries a third,
`fileAt`, for its file: `path`, `downloadId` and `marked` go together to the side that marked it
up last, whose panel has deleted the file before, so a write that crossed the swap cannot store
the deleted path again. A file taken over this way is checked afresh, as any file this session has
not asked about. A page item's `stitched` is set once, at the capture, and never changes, so it
needs no stamp: a panel takes it from a write only when its own copy of the item has none (one read
from an older version's write). Which window has focus decides nothing.
When an item leaves the sheet through a discard or a copy, its id and time go into `removed`,
kept for ten minutes and capped at 200 entries, so a write that crossed the removal cannot bring
the item back. An edit made after the removal, an undo included, does bring it back. A removal of
the whole report (another panel's weekly expiry) is ignored by a panel that is still showing it.
A change that keeps the sheet's shape updates rows in place, with no storage read, list rebuild
or page read.

The stamps come from the clock, and a change is stamped after the last change or removal of the
item this panel knows of (`touch`, `leftAt`), so a change made after the clock was set back still
counts as the newest, and a discard or a copy as coming after the item's last change. Something
other than a panel can write a stamp into storage, and one far ahead would outrank every later
change (from 2^53 on, adding one changes nothing, so for good). So a stamp more than two days
ahead of the clock (`STAMP_AHEAD_MS`) is not believed: it counts as none, and a removal so stamped
is dropped. The rule holds on both sides of a merge, for what storage holds and for the panel's
own copy (`forgetFarSheet`), and a side writes back only what is newer by it. No write carries
such a stamp, and a panel that reads one, on opening too, writes the sheet back at once, so every
open panel forgets it at the same write. Forgotten by one panel only, it would live on in storage
and in the panels that had not merged since, and count again once the clock came back within two
days of it, over the changes made since in the window that forgot it. 0.6.1 capped what it
read at the clock and kept its own stamps as they were, so once the clock went back each of two
open panels found its own copy newer than the one it read and wrote it to the other, until the
clock caught up, and a change made after the set back was lost to the other windows. Within two
days every stamp keeps its worth and every change crosses. Past that, the stamps from before the
set back count as none in every window: the next change to an item wins, and a removal from
before is forgotten, so a write that crossed it as the clock went back brings the item back. A
stamp counts as none rather than capped at two days ahead: capped, it would be worth the moment
each panel came to it, and the panel that came last would put its copy back over a change made
in between.

The marked copy has two cross window races of the same shape as two writes crossing, and neither
is closed. Whether an item's marked copy is still saving is not stored, so another window does not
hold Copy back for it. When window B copies the item in the milliseconds between window A's copy
reaching the disk and A hearing of B's copy, A has not yet seen the removal, swaps, and deletes the
capture that the prompt on B's clipboard names. Once A has heard of the removal it keeps that file
and deletes its copy instead.

The other is a discard in B in the same gap, after A has swapped but before B has heard of the
swap. B's discard holds the item as B knew it, naming the capture and its download id, and A,
hearing of the removal, leaves the files to that discard, as it leaves any discard made in another
window. When B's undo lapses, B asks to delete the capture, which A has already deleted and erased
from Chrome's list, so `recordFor` finds no record naming it and refuses. Nothing deletes the
marked copy, which stays on disk with no item naming it. If B's undo is pressed instead, the item
comes back in every window naming the capture A deleted, without its marks, and it cannot be
marked up again, since A let its clean capture go with the removal.

In both, the window is the storage delivery gap, which in Chrome was not measured. Holding the
delete back until a round trip through storage, or storing that a save is under way, would close
them, though an undo in B would still bring the item back without its marks.

**Order.** Every panel sorts the sheet the same way (`bySheetOrder`), at every open and on every
write it adopts: by each item's place, which is its `rank` once it has been moved and its
`capturedAt` until then, and two items at one place by `capturedAt`. A sheet nobody reordered
carries no rank at all, so a sheet stored by an earlier version needs nothing done to it and
shows in capture order, as it did. The stored array is written in sheet order too, but no panel
relies on it, and rearranging `state.items` alone does not last: the next write adopted sorts it
back. A move (`moveItem`, by a drag or by Alt with an up or down arrow) sets the moved item's
rank halfway between the places of its new neighbours, or one past the place at the end it went
to, and stamps it with `editedAt`, so another window takes the newer place as it takes the newer
tick. A move and a tick of the same item in two windows within one crossing write keep only the
newer of the two, the trade the intent and the tick already make. At today's timestamps a double
has about twelve halvings between two captures a millisecond apart, so about twelve moves in a
row into the same gap; when no number is left strictly between the neighbours, or two rows share
a place, every row takes its index as its rank and is stamped. A capture joins at the end: its
time puts it there, and when that time is at or below a place already taken (the clock was set
back, or rows were moved to the end within the same millisecond), it gets the highest place plus
one. An item still saving is not stored yet, so it keeps its place in this panel's memory
through writes from other windows, and its rank is stored with it once its file is. The frame's
item after an open or a copy is the newest capture (`newestItem`), wherever it stands, and the
page that stands in when nothing was read is the last item listed. A version without `rank`
ignores it and drops it on its next write, so going back to it puts the sheet in capture order
again and breaks nothing.

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
since a value set by script is not on its undo stack. An undo puts an item back at the index it
left and then sorts the sheet, so when rows were moved in the meantime it goes where its own place
puts it, as every other panel and the next open put it. Cmd or Ctrl+Z undoes a discard and nothing
else: a move is undone by moving the row back, and while a markup is open the key takes back the
last mark instead, and the discard waits on. When the time is up, the files are deleted with
`downloads.removeFile` and their history entries with `downloads.erase`. On `pagehide` the
panel settles the pending discard and takes back any save still in flight, a marked copy included,
by sending `cancel`,
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
| `scripting` | Inject the region overlay and element picker on demand, and the collector into a tab where nothing collects and the `content_scripts` matches would have run it, or a bridge to a collector already running on a site they name. From the panel itself: hand an armed mode the keys pressed in the panel, and for Page inject `content/page-shot.js`, which scrolls the page and hides what is fixed to the window while the capture runs |
| `downloads` | Save each PNG as it is captured, read back its absolute path, delete it again if the item is discarded or its sheet expires, and learn if it has since gone missing |
| `storage` | Keep the report (items, descriptions, thumbnails) between panel sessions, plus the toggle settings |
| `sidePanel` | The panel itself |

At every start the worker restricts `storage.local` to trusted contexts, so a content script
cannot write a report for the panel to adopt. The messages only the panel sends (`cdr:arm`,
`cdr:disarm`, `cdr:verify`, `cdr:check-tab` and `cdr:collect`, listed in `PANEL_MESSAGES`) and the
`cdr:panel` port are accepted only from the extension's own pages, so a content script, which runs
in a page that may be hostile, cannot ask the worker to inject anything into any tab.

Note what is **not** in that table. The collector arms via the two `content_scripts` entries
(the isolated world one also carries `content/press-gate.js`, ahead of the bridge)
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

The banner says so for as long as such a page is in view. Asked to say nothing there,
`showBanner` puts the restriction back instead of hiding, so a copy, or a missing file's banner
going, does not leave it away until the next tab event.

Note that Chrome withholds `tab.url` entirely for any page the extension has no host
permission for, so an absent URL is itself the signal that a page is off limits. That is also
the only observable signal for a blocked `file://` tab, which is why the "enable Allow access
to file URLs" hint lives in the missing URL branch rather than in a `file://` branch.

## Running the panel outside Chrome

`tools/panel-stage.html` loads the panel as an ordinary web page next to the demo page, with
`tools/chrome-shim.js` standing in for `chrome.*`. The shim answers the real message protocol
the way the worker and content scripts would: `cdr:arm` injects the real overlay or picker
into the demo frame, `cdr:get-context` reaches the real collector through the real bridge,
`captureVisibleTab` asks the stage for a screenshot of the demo frame, and
`scripting.executeScript` runs the panel's own calls in the demo frame: a file from `content/` is
added as a script, and a function is rebuilt there from its source and called with a copy of its
arguments, its answer copied back, as Chrome serialises both. That is how Page scrolls the demo
page, and how the keys pressed in the panel reach an armed mode there, which they did not before
0.7.0. Everything on screen is the actual code; only the platform is faked. What it does not
reproduce:

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
  there is no isolated world here: the bridge, the overlay, the picker and the page shot share
  globals and prototypes with the page and with the collector. A picker that read a React fiber off
  a node by itself would work on the stage and find nothing in Chrome. There is no `chrome.dom`
  either, so the page shot walks open shadow roots only. The name the picker asks for while
  hovering crosses no world here either: its reply's detail is the collector's own object, not
  the copy Chrome makes, so a reply that would not survive that copy still shows there.
* **Messages.** A broadcast from the page reaches the panel synchronously, inside the call that
  sent it, and the panel receives the very object that was sent. Chrome serialises every message
  and delivers it in a later task, so a value that does not survive serialisation, or code that
  depends on the order of delivery, behaves differently there. Every sender is tab 1, with no
  frame, URL or origin.
* **The screenshot.** `captureVisibleTab` is the stage drawing the demo frame, not Chrome's
  compositor, so device pixel ratio, zoom and the visual viewport play no part, and no capture
  quota applies. Without a driver's screenshots it is a grey placeholder that does not follow
  scrolling, so a whole page on the stage is that placeholder stitched together: it shows Page's
  flow, the scrolling, the count and the item, and not its pixels.
* **Downloads.** They complete instantly unless `?save=<ms>` slows them, and there is no "Save as"
  dialog to take focus away. No file is written: the path is made up, and
  `conflictAction: 'uniquify'` is ignored, so two captures in the same second get the same path
  where Chrome would add ` (1)` to the second, and so does a capture marked up twice, whose second
  marked copy is written while the first is still there. Nothing removes a file behind the panel's back
  unless a driver says so through `__shim.downloadChanged`. Download ids and records live on the
  stage, beside storage, so they survive the panel frame reloading, as Chrome's download history
  survives the side panel closing, and start again when the stage itself reloads.
* **The counts port.** The panel's shim has no `tabs.connect` and the demo tab's has no
  `runtime.onConnect`, so on the stage the console and network chips are read on focus and at
  each read, as before 0.6.1, and do not follow the page live.
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
  keyboard with the page, and `window.focus()`, `chrome.sidePanel.open` and
  `chrome.windows.update` with `focused` changed nothing, though the panel heard the drag's
  message with transient user activation; a click into the panel moved it.
  So the panel reads `document.hasFocus()` and says under the field that the page still has the
  keyboard. On the stage both share one document, so that line never shows there.

It exists for two reasons. Working on the panel's design no longer means reloading an
extension for every change, and the README's screenshots and GIF are produced from it by
`tools/make-media.mjs`, so they can be regenerated rather than redrawn. Nothing under
`tools/` is included in the release zip.

## The build

`tools/build.mjs` refuses a zip Chrome could not load, and CONTRIBUTING.md says what it checks.
Two choices in how it checks are design rather than detail.

It asks V8, not a pattern, which places in a script are imports. The text search finds every
`import` followed by `(`, with any comment JavaScript allows between them (a line comment ends at
any line terminator, and an HTML like comment counts anywhere on a line, which can only add a place
for V8 to rule out), and `inCode` keeps a place only when the file parses as it is and stops
parsing once that `import` is spelled `class `. The pattern is tried at each keyword `import` on
its own (`starts`). Matches read one after another never overlap, so one that started at an earlier
`import` (a property named `import` followed by `-->`, or `"import //"` in a string) ran on to a
later parenthesis and hid the real `import()` it ran through. So a method named `import`, a private
`#import` and an `import(` in a string, a comment or a regular expression build, and on the
checker's 63 shapes that parse the build agrees with what Chrome 156 requests, on Node 22 and 24.
The search finds nothing in the shipped scripts, in 0.9 ms. On input written against it, it is
quadratic: a line of 20,000 keywords that each match takes 0.7 to 1.8 s, and 20,000 `import` each
followed by a comment opener on one line 3 to 6 s. Phase imports, which Chrome 156 refuses as a
SyntaxError while Node 24 parses the source phase, fail the build on Node 22 and 24: a static one
read from V8's record of the module's imports (its `phase`), in a module the build follows and in
one nothing imports, and a dynamic `import.source()` or `import.defer()` found as `import()` is
(`PHASE_CALL`, `phaseCalls`). Line numbers in its messages count line feeds only, and a file under
`content/` that a module also imports is parsed only as a module, where Chrome's classic injection
would read it as a script; no shipped file is both.

Its children take no input through a pipe (`runNode`). Data handed to a child on stdin through
`spawnSync`'s `input` now and then never arrived on macOS: the child waited on its stdin for good
while the build waited for the child, in 7 of 2,880 children across Node 22 and 24. So the import
check (`node --experimental-vm-modules tools/build.mjs --link`) reads every script from a JSON
file in a new folder under the system's temp directory and writes its answer to a file there,
with stdin and stdout not connected and its error output to a file in that folder, which is
removed when the check ends (`checkImports`, `inScratch`). Every child has a limit of 120 s
(`CHILD_TIMEOUT_MS`), after which it is killed and the build fails saying which check did not
finish. V8 parses every module in the import check, and Node's own syntax check (`node --check`,
on a copy named `module.mjs`) runs only for a module V8 refused, to find the line, or for every
module when the import check could not run; V8's verdict stands if they differ. A clean build
starts one child instead of four, and the real tree builds in 0.13 s instead of 0.18 to 0.19 s.

So the build needs a temp directory it can write to, which 0.6.0 did not. A folder that cannot be
made (`TMPDIR` names one that does not exist) or written (a full disk) fails the build with one
line per check and no stack: the import check, then the syntax check of each module, each saying it
could not run and why. A build stopped by a signal (Ctrl+C, `SIGTERM`, `SIGKILL`) never reaches the
code that removes its folder, which holds a copy of every shipped script (about 0.8 MB). So before
it makes one, each build removes the folders in the temp directory named `punch-list-build-` and
six letters or digits that were last changed over an hour ago, skipping any it may not remove
(`sweepScratch`). A stopped build's folder therefore stays until the next build at least an hour
later. With an empty temp directory that costs nothing measurable, and 8 to 10 ms with one of
21,365 entries. When the build alone is killed while a child is stuck, and not its process group,
the child keeps running with no limit.

`tools/release-check.mjs` runs each `git` and `gh` call with stdin not connected and a limit of 60
s, after which the call is killed and the run fails naming it (`run`). On CI (`GITHUB_ACTIONS` is
`true`, or `CI` is `true` or `1`, as CI services set it; `CI=false` is a local run) the call leads
a process group of its own (`spawnSync` with `detached`, which Node 22 and 24 honour), and the
whole group is killed with it, so a `git` that `gh` started goes too. Locally it stays in the
terminal's foreground group, where Ctrl+C reaches it: in a group of its own, Ctrl+C stopped the
check and left a hung call running with nothing to enforce its limit. So locally a call that runs
out of time is stopped while what it started keeps running, as in 0.6.0. On Windows, which has no
process groups, only the call itself is stopped. A call that failed or ran out of time prints its
message alone, since that names the call (`CallFailed`); any other error keeps its type and stack,
and a `manifest.json` or `package.json` that is not valid JSON is named as a `SyntaxError`. The tag
lookup takes only exit 1 from `git rev-parse -q --verify` as no tag (`tagCommitOf`). Any other
failure, such as exit 128 outside a repository, fails the run; read as no tag, it had a run on
`main` decide to release.

## Conventions in the code

Both capture scripts are injected repeatedly by `executeScript`, which re-runs the entire file
every time. They cache a controller on `window` and call `start()` again, so they must stay
free of top level `const`, `let` and `class`: a redeclaration throws at parse time and the
whole file fails to run. `content/stop.js`, which a disarm injects, is re-run the same way and
keeps to the same rule, and so is `content/page-shot.js`, which the panel injects for every whole
page capture and which keeps one controller on `window` across injections.

The collector wrappers must never break a host page. Every one of them preserves `this`, passes
return values through unchanged, re-rejects rejections, and swallows its own errors. Each is made
with `wrapNative()`, a Proxy of the native with only an `apply` trap, so the page sees the
native's name and length, and a `toString` that says `[native code]` with no name, as for any
callable proxy.
