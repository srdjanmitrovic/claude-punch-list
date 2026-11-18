# Review: Punch List for Claude Code 0.4.0

Reviewed at commit `a0c9335` on 2026-11-15. The analysis was made without changing code. Two
sections at the end, added on 2026-11-16, record what was implemented afterwards and what turned
up while doing it; the 0.6.0 round was recorded in them on 2026-11-17, and the 0.6.1 round on
2026-11-17 and 2026-11-18. Line references in the sections before them point at `a0c9335`.

This file sits under `docs/`, which the release zip does not include. `tools/build.mjs:32` packages
from an allowlist of six paths (`manifest.json`, `background.js`, `icons`, `content`, `shared`,
`sidepanel`), and a scratch build with this file present produced the same 14 files and the same
checksum as one without it.

## Summary

**What the extension does today.** A Manifest V3 side panel extension (`manifest.json:2`,
`manifest.json:31`). You frame something on a page in one of three ways (drag a region, click an
element, take the whole viewport), type one sentence, mark it as a bug or a suggestion, and repeat.
Each capture is written to Downloads as a PNG the moment it is taken (`sidepanel/panel.js:1015`) and
becomes a row on a sheet kept in `chrome.storage.local` (`sidepanel/panel.js:1205`). One click builds
a single markdown prompt (`shared/prompt-template.js:831`) that names every ticked item with the
absolute path of its screenshot, adds the console errors and failed requests an always on collector
recorded in the page (`content/collector-main.js:94`, `content/collector-main.js:275`,
`content/collector-main.js:339`), and puts it on the clipboard. Element captures also carry markup,
computed styles and, on React and Vue pages, the component, its props and its handlers
(`content/collector-main.js:1160`).

There is no backend. The only `fetch` in the shipped files turns a data URL into a blob
(`sidepanel/panel.js:1017`), and no shipped file contains a remote URL, `eval` or `new Function`.

**Where it stands.**

* The core flow is sound: mouse driven region capture, saving with a real path, the clipboard copy
  and the one item prompt all held up under test. The code is unusually well commented, and most
  oddities turned out to be deliberate and explained in `docs/ARCHITECTURE.md`.
* No issue is rated high after verification. 35 are medium and about 80 are low. Both findings a
  reviewer first rated high were downgraded by a second, skeptical pass.
* The weakest part is the evidence, which is the product's main promise. Console and network are
  read once, at copy time, from one tab (`sidepanel/panel.js:1115`), are never dated, and are
  polluted by requests that did not fail (`content/collector-main.js:294`) and requests the page
  cancelled on purpose (`content/collector-main.js:312`).
* The collector is felt on every page whether or not the panel is used: DevTools attributes every
  `console.error`, `console.warn` and failed request to `collector-main.js`
  (`content/collector-main.js:105`).
* Element captures print markup and attributes with no redaction (`content/picker.js:416`), while the
  README says props are the only data read out of the running application (`README.md:428`).
* The project's own rules (byte for byte output, wrappers that never break a page, no top level
  `const` in injected scripts) are enforced by nothing: there is no test and no CI on push
  (`CONTRIBUTING.md:61`).
* Versions 0.3.0 and 0.4.0 were never released, so the README's release zip path leads to a
  differently named 0.2.0 build (`README.md:345`).

## How this was checked

Two passes, both read only.

1. **Review.** Nine reviewers, each owning one subsystem or one lens (capture and worker, sheet
   state, report output, collector, picker and component lookup, the prompt, security and privacy,
   tooling and docs, panel usability). They produced 129 findings.
2. **Verification.** Duplicates were merged into 113 groups and handed to nine skeptics whose brief
   was to refute each one: confirm the quoted line, trace the path, look for the guard that prevents
   it, check whether `docs/ARCHITECTURE.md` documents it as deliberate, and run it where that was
   cheap. Outcome: 58 confirmed as reported, 53 confirmed with corrections (mostly lower severity or
   a narrower trigger), 1 refuted, 1 that cannot be settled without a real side panel. The skeptics
   reported 13 further defects of their own, 8 of them new. Those 8 were checked once, not twice,
   and carry the prefix `M`.

The lines behind the medium severity findings and the top recommendations were read again by hand
before this document was written.

**What "checked by" means in the tables.**

* **browser run**: headless Chrome. Either Chrome 157 with the real content scripts injected into a
  plain page, or Chrome for Testing 156 with a byte identical copy of the extension loaded unpacked,
  or the repository's own stage (`tools/panel-stage.html`). No run used a visible side panel. Where
  the panel was needed, `sidepanel/panel.html` was opened as a tab or on the stage.
* **Node run**: the repository's real source executed in Node. The template was imported directly;
  the content scripts and `panel.js` were evaluated in `node:vm` against fakes.
* **reading**: followed in the code only.
* **Chrome docs**: depends on documented Chrome behaviour, which was looked up and not recalled.

**Severity.** High: wrong or lost output, exposed data, or a broken core flow in ordinary use.
Medium: wrong in a realistic but less common situation, or silently degraded output. Low: cosmetic,
rare, or cleanup. The assumed user is a developer walking through their own app in desktop Chrome
with a mouse.

**Finding ids.** `CW` capture and worker, `SS` sheet state, `RO` report output, `CO` collector, `PI`
picker and component lookup, `PJ` prompt, `SP` security and privacy, `TR` tooling, release and docs,
`UX` panel usability, `M` found during verification.

## Feature inventory

| Feature | Files | Status | Why |
| :--- | :--- | :--- | :--- |
| Region capture | `content/overlay.js`, `background.js`, `sidepanel/panel.js` | fragile | Mouse path, clamping and Retina or browser zoom scaling are correct (`sidepanel/panel.js:407`). Breaks under pinch zoom (CW2), under a modal dialog (CW3), and Esc does not cancel from the panel (CW5). |
| Element picker | `content/picker.js`, `background.js` | fragile | Pointer events leak to the page (PI4), disabled controls cannot be picked (PI5), iframes and shadow roots are not handled (PI6, PI7), styles are read while hovered (PI10). |
| Element payload (selector, markup, styles) | `content/picker.js`, `shared/prompt-template.js` | fragile | No redaction (PI1), uncapped opening tag (PI13), selector cut from the wrong end (PI8). |
| Whole screen capture | `sidepanel/panel.js` | fragile | Needs no injection. Ignores an armed overlay and photographs it (CW1), and has no guard against a double click (CW12). |
| Alt+Shift+C command | `manifest.json`, `background.js` | solid | `sidePanel.open` is called before any await (`background.js:191`). It is the only command (lead 7). |
| Restricted page detection | `background.js`, `sidepanel/panel.js` | solid | Correct for every page class the README lists. One substring match is too loose (CW6). |
| Sheet: rows, ticks, selection, New item | `sidepanel/panel.js`, `sidepanel/panel.html` | solid | Only small frictions (UX7, UX8, SS6). |
| Bug or suggestion intent | `sidepanel/panel.js` | solid | Sticky as documented. Not shared between open panels (SS12). |
| Persistence across panel sessions | `sidepanel/panel.js` | solid | Items are stored only once they have a path (`sidepanel/panel.js:1206`). `restore()` has no failure path (SS9). |
| Cross window sync | `sidepanel/panel.js` | fragile | Whole sheet writes and whole sheet adoption lose edits and items when two windows are active (SS1, SS4, SS5). |
| One week expiry | `sidepanel/panel.js` | fragile | An expiry in one window empties a panel left open in another (SS3). Files are left behind (RO10). |
| FILE MISSING detection | `sidepanel/panel.js` | fragile | Checked once at startup, explained only in a banner that other events clear, and the flag is persisted (SS7, RO7). |
| Discard one, discard all | `sidepanel/panel.js`, `sidepanel/panel.html` | fragile | No confirmation or undo (UX2). Deletes by a stored download id that Chrome can reissue (RO6). |
| Saving to Downloads with a real path | `sidepanel/panel.js` | solid | Polling, `uniquify` and the "Save as" case all behave as documented (`sidepanel/panel.js:980`). |
| Clipboard copy and reset | `sidepanel/panel.js` | solid | Focus wait, `execCommand` fallback and manual reveal work. The sheet is reset only after a real copy (`sidepanel/panel.js:1138`). |
| Console capture | `content/collector-main.js` | fragile | Wrappers are safe for the page. They take over the source link in DevTools (CO6), and warnings share 30 slots with errors (M2). |
| Uncaught errors and rejections | `content/collector-main.js` | solid | Own ring, so console noise cannot evict them. |
| Failed fetch and XHR with caller | `content/collector-main.js` | fragile | Lists responses that did not fail (CO1) and requests the page aborted (CO2). The caller is lost behind a request library (CO4). |
| Failed resource loads | `content/collector-main.js` | fragile | URL is missing for `srcset`, SVG images and objects (M3) and is never truncated (CO7). |
| Attaching context at copy time | `sidepanel/panel.js`, `content/collector-bridge.js` | fragile | Lead 1. Also loses every URL when the read fails (RO4), can hang the copy (RO5) and can reuse another tab's read (RO1). |
| React component lookup | `content/collector-main.js`, `shared/prompt-template.js` | fragile | Works on React 16 to 19. Prints a false "defined elsewhere" in the commonest case (PI2), unmapped positions on 19.1 and later (PI9), and props that can be one commit old (M5). |
| Vue component lookup | `content/collector-main.js` | solid | Vue 3 development builds only, which is what the README claims. |
| Handlers and props with redaction | `content/collector-main.js` | fragile | The secret test is an unanchored substring match (PI3) and three text heuristics misfire (PI16). |
| Prompt: one bug | `shared/prompt-template.js` | solid | Structure held against hostile and degenerate input from an ordinary page (PJ15). |
| Prompt: change, mixed, several pages | `shared/prompt-template.js` | fragile | Change closing gives the evidence no role (PJ17). Page counting and page lines disagree (PJ9). The caution vanishes with the page toggle off (RO3). |
| Prompt: console and network sections | `shared/prompt-template.js` | fragile | Not in time order (PJ1), repeats not collapsed (PJ7), multi line messages print as frames (M8). |
| Attach toggles and chips | `sidepanel/panel.js`, `sidepanel/panel.html` | fragile | Chips are a snapshot, not a live count, and can show another tab's numbers (RO11). |
| Panel accessibility | `sidepanel/panel.html`, `sidepanel/panel.css` | fragile | No live region (UX3), three contrast failures (UX12), states not exposed (UX13). |
| Keyboard shortcuts | `manifest.json`, `sidepanel/panel.js` | incomplete | One command, one undocumented panel shortcut (`sidepanel/panel.js:1526`), Esc bound only on the page. |
| Release packaging | `tools/build.mjs` | fragile | Validates manifest paths only (TR2) and zips untracked files (TR6). |
| Release workflow | `.github/workflows/release.yml` | incomplete | 0.3.0 and 0.4.0 were never published (TR1). Manual dispatch cannot succeed from a branch (TR4). |
| Tests and CI | none | incomplete | No test of any kind (`CONTRIBUTING.md:61`). |
| Prompt preview tool | `tools/preview-prompt.mjs` | solid | Renders the real template. 49 of 467 code lines never run in any of the four modes (PJ12). |
| Panel stage and shim | `tools/panel-stage.html`, `tools/chrome-shim.js` | fragile | Useful and faithful for the panel. Download ids reset on reload (TR8); the docs understate what it cannot reproduce (TR9). |
| Roadmap: reorder, annotate, full page, more frameworks, component on hover | `README.md` | incomplete | None is built (lead 8). |

**Half built or unused.** No permission is unused: `scripting`, `downloads`, `storage` and
`sidePanel` each have call sites. What is unused is data: `userAgent` and scroll position
(`content/collector-bridge.js:62`), the picker's `tagName`, `classes` and `inlineStyle`
(`content/picker.js:567`), an item's `title` and `tabId` (`sidepanel/panel.js:710`), and each entry's
`t` plus the snapshot's `armedAt` (`content/collector-main.js:31`, `content/collector-main.js:1212`)
are collected, sent and stored, and nothing reads them (TR12). `styleFile()` can never match
(`shared/prompt-template.js:565`, PJ8) and `mainWorldSilent` can never be true when it is read
(`content/picker.js:661`, PI14).

## Verdict on each lead

**1. Console and network are read once at copy time from the active tab; the buffer is 30 entries
and resets on page load. Confirmed, with corrections.**
`copyReport` awaits `refreshContext()` (`sidepanel/panel.js:1115`), which messages only `state.tab`
(`sidepanel/panel.js:943`), and `assembleReport` reads that one snapshot
(`sidepanel/panel.js:1070`). Items carry no evidence: `addItem` reads the context for the chips and
keeps nothing (`sidepanel/panel.js:729`). What the lead gets wrong:

* It is 30 per category in three rings (`content/collector-main.js:19`,
  `content/collector-main.js:22`), so up to 90 entries, and uncaught errors cannot be evicted by
  console noise.
* The reset is per document, not per URL. A single page app that changes route keeps its buffer, so
  there the problem is the opposite one: entries from earlier routes, and from before a hot reloaded
  fix, print as current and undated (CO3).
* The template does caution about a mismatch, but by URL only (`shared/prompt-template.js:888`). A
  reload on the same URL passes silently (RO2), and the caution disappears when the page toggle is
  off (RO3).
* "From the active tab" is not always true. On a restricted tab nothing is read and the previous
  read, possibly from another tab, is copied (`sidepanel/panel.js:936`, RO1).
* A copy does not clear the buffers (`sidepanel/panel.js:850`), so the next prompt repeats entries
  the previous one delivered.

**2. The collector wraps only `console.error`, `console.warn`, `fetch` and XHR; iframes are not
covered. Confirmed.**
Wrapped at `content/collector-main.js:94`, `content/collector-main.js:275`,
`content/collector-main.js:339` and `content/collector-main.js:353`; `all_frames` is false at
`manifest.json:41` and `manifest.json:48`. The lead leaves out the two listeners
(`content/collector-main.js:113`, `content/collector-main.js:140`) that bring in uncaught errors,
rejections and failed element loads. Worth adding, cheapest first: a `securitypolicyviolation`
listener (wraps nothing, confirmed to receive violations from a main world script), failing
`console.assert`, and a `PerformanceObserver` for failed stylesheet images and fonts
(`responseStatus` exists from Chrome 109). `WebSocket` and `EventSource` need a constructor
replaced, which is the riskiest thing one can do under the "never break a host page" rule.
`sendBeacon` exposes no outcome and is not worth wrapping. Browser generated messages (the CORS
explanation, `net::ERR` codes) cannot be reached from a page script at all.

**3. The picker uses `document.elementFromPoint` with no shadow DOM or iframe handling; component
lookup covers React and Vue 3 only. Confirmed, and worse for iframes than stated.**
The only hit test is `content/picker.js:547`. Inside a shadow root the pick is the outermost host
with empty markup (PI7). Over an iframe the top frame receives no mouse events, so nothing is
highlighted and the click is delivered to the framed page for real, same origin or not
(`background.js:99`, PI6). "React" means 16 through 19; a call site exists on 16 to 18 with a
development JSX transform and on 19.1 and later, where it is an unmapped stack frame (PI9). "Vue 3"
means development builds. Svelte, Vue 2, Preact, Solid, Angular and web components get no component
and no handlers (`content/collector-main.js:1182`).

**4. The manifest says 0.4.0 but tags stop at v0.2.0, and the release workflow only runs on tags.
Confirmed, with one correction.**
`manifest.json:4` and `package.json:3` say 0.4.0. Local tags, remote tags and GitHub releases are
v0.1.0 and v0.2.0 only. The workflow also declares `workflow_dispatch`
(`.github/workflows/release.yml:15`), but its first step compares the ref name with the manifest
version (`.github/workflows/release.yml:32`), so a manual run from `main` always fails (TR4). The
lead leaves out the consequence: the v0.2.0 assets are named `claude-debug-reporter-v0.2.0.zip`, so
the file name in `README.md:345` matches nothing, and what a user gets is the old product with no
sheet and no component lookup (TR1). A `v0.4.0` tag at HEAD would pass the check; a clean export of
HEAD hashes to the same checksum as the local `dist`.

**5. There is no test suite; the stage and shim could host one. Confirmed, but the stage is the
weaker half.**
No test file, no test script, no push or pull request workflow (`CONTRIBUTING.md:61`,
`package.json:11`). `node:test` needs no browser and no dependency: a scratch proof of concept ran
24 tests in about 0.2 seconds covering golden files for the four previews, the collector in
`node:vm` (return values, `this`, rejections passed through, ring size, `stackTraceLimit` restored),
and the no top level `const` rule by compiling each injected file concatenated with itself. Goldens
must pin the locale, because `stamp()` uses `toLocaleString()` (`shared/prompt-template.js:194`).
The stage cannot test `background.js`, world isolation or `document_start`, and its download fake
needs fixes first (TR8).

**6. Screenshot paths only work when Claude Code runs on the same machine; files accumulate.
Confirmed.**
The prompt prints `DownloadItem.filename` verbatim (`sidepanel/panel.js:988`,
`shared/prompt-template.js:853`) under an instruction to read it. Nothing is hard coded to
`~/Downloads`, so a changed download folder works and Windows gets a correct path. What fails is any
setup where Claude Code sees a different filesystem: a remote session, a devcontainer, WSL (where
`C:\` needs `/mnt/c`). The prompt has no sentence for a path that cannot be opened. Only discards
delete files (`sidepanel/panel.js:775`); a copy and the weekly expiry leave them
(`sidepanel/panel.js:1350`, RO10). On this machine the folder held 13 files and 1.1 MB, the oldest
three months old, so the cost is clutter and old screenshots of app screens, not disk space.

**7. Only region capture has a keyboard shortcut. Confirmed.**
One command (`manifest.json:52`, `background.js:184`). The panel also handles Cmd or Ctrl plus
Enter for copy (`sidepanel/panel.js:1526`), which is shown nowhere. The lead leaves out that the one
shortcut arms a tool that cannot be finished from the keyboard, while Screen, the only mode that
needs no pointer and the only way to photograph a hover or an open menu, has no shortcut. A Screen
command is not a one line change: the capture runs in the panel, which may not exist yet when the
command fires. Chrome allows four suggested keys per extension, and `_execute_action` does not fire
`onCommand` (both checked in the commands reference).

**8. Roadmap items are not built. Confirmed for all five.**
No drag or reorder code in `sidepanel/`; the only canvas use is crop and thumbnail
(`sidepanel/panel.js:405`); capture is one `captureVisibleTab` call (`sidepanel/panel.js:379`); the
hover tag shows tag, id, classes and size (`content/picker.js:339`). Groundwork differs:

* **Reorder** is close. Order is already the persisted array order and the template numbers by
  index (`shared/prompt-template.js:871`). `adoptStored` appends items still saving after stored
  ones (`sidepanel/panel.js:1282`), which a reorder must respect.
* **Annotate** is blocked by design. The full image is released once the download starts and the
  panel keeps a thumbnail of at most 800 px (`sidepanel/panel.js:23`), so marking up has to happen
  before the save or produce a second file.
* **Full page** is called out of scope in `CONTRIBUTING.md:109` and roadmap in `README.md:559`.
* **More frameworks**: the framework field is a two way switch in three places, so a third would
  print as React unless all three change.
* **Component on hover**: the README's stated cost (a round trip per mouse move) is overstated,
  since `onMouseMove` returns early unless the element changed (`content/picker.js:548`). The real
  cost is writing a `data-cdr-pick` attribute onto every hovered node.

## Bugs and risks

### Medium severity

**Capture**

* **CW1. Whole screen capture photographs the armed overlay.** `sidepanel/panel.js:916`. Click
  Region or Element, then Screen. The saved PNG contains the dim layer and the hint pill,
  `addItem` darkens the button (`sidepanel/panel.js:726`), and the overlay stays live on the page
  while the worker still reports the tab as armed. Checked by browser run, including a real
  `captureVisibleTab`. Fix S.
* **CW2. Crops come from the wrong place under pinch zoom.** `sidepanel/panel.js:407`. The
  rectangle is in layout viewport pixels (`content/overlay.js:192`) while `captureVisibleTab`
  returns the magnified visual viewport. At 2x the crop was a different patch a quarter of the
  size, saved as a normal item. Checked by browser run. Fix S.
* **CW3. The region overlay is dead under a native modal dialog.** `content/overlay.js:227`. The
  host is appended to `body`, below the top layer, and is inert while `dialog.showModal()` is open.
  The button stays lit, nothing is selected, no error is shown. Checked by browser run. The
  fullscreen case rests on the top layer rules and was not observed. Fix M.
* **CW5. Esc does nothing after arming from the panel.** `sidepanel/panel.js:1526`. Both Escape
  listeners are on the page window (`content/overlay.js:233`, `content/picker.js:672`), while the
  panel holds focus and handles only the copy shortcut. The on page hints
  (`content/overlay.js:85`, `content/picker.js:332`) and `README.md:87` say Esc cancels. For
  Element the panel is the only way to arm, so the cancel is never reachable before the pick.
  Checked on the stage; focus in a real side panel was not observed. Fix S.

**Sheet**

* **SS1. A background window overwrites the sentence typed in another.** `sidepanel/panel.js:1261`.
  The typing guard tests `document.activeElement` without `document.hasFocus()`, and the field
  keeps being the active element after its window loses focus. The background panel refuses the
  other window's edit, and its next write stores its own older or empty sentence. Checked by
  browser run with two panels over one storage. Fix S.

**Context and saving**

* **RO2. A reload between capture and copy drops the evidence without a word.**
  `shared/prompt-template.js:888`. The only mismatch test compares URLs. `armedAt` would reveal the
  reload; it is sent (`content/collector-main.js:1212`) and dropped in `assembleReport`
  (`sidepanel/panel.js:1069`). Reading at copy time is documented (`README.md:415`); the blind spot
  is not. Checked by Node run. Fix S for the caution; the full fix is feature 1 below.
* **RO4. When the context read fails, the prompt loses every URL.** `sidepanel/panel.js:1084`. On
  a tab opened before the extension was installed or reloaded, `state.context` is null
  (`sidepanel/panel.js:956`), the template treats that as the page toggle being off, and the prompt
  reads "on the captured page" although each item recorded its own URL (`sidepanel/panel.js:709`).
  The receipt still says Copied. Checked with the extension copy loaded in Chrome. Fix S.
* **RO5. Copy hangs on a page that is busy or paused.** `sidepanel/panel.js:1115`. The read is an
  unbounded `tabs.sendMessage` awaited with the busy latch set (`sidepanel/panel.js:1108`). Against
  an 8 second busy loop the button sat on "Copying…" for 7.6 seconds; at a breakpoint it never
  returned. `arm()` already bounds the same kind of wait for the same reason
  (`sidepanel/panel.js:869`). Checked by browser run. Fix S.
* **RO6. Discarding an item can delete a different file.** `sidepanel/panel.js:1051`. `deleteFile`
  trusts a download id persisted up to a week earlier. Chromium reissues ids as one more than the
  highest remaining row after a restart, so removing the newest rows from the downloads list and
  restarting hands the id to the next download, which a discard then deletes. Rare trigger,
  permanent result. Checked in Chrome with a persistent profile. Fix S.

**Collector**

* **CO1. Responses that did not fail are listed as failed.** `content/collector-main.js:294`. The
  test is `!response.ok`, so a successful `no-cors` fetch, a manual redirect and a 304 each print
  under "Failed network requests" and take one of 30 slots. The XHR branch tests the status
  (`content/collector-main.js:376`) and the README says 4xx or 5xx (`README.md:411`). Checked with
  the extension copy in Chrome. Fix S.
* **CO2. Requests the page cancelled print as FAILED.** `content/collector-main.js:312`,
  `content/collector-main.js:382`. An `AbortController` cleanup, a typeahead that aborts per
  keystroke and an XHR timeout all produce "FAILED Network failure". Thirty of them push every real
  failure out. Checked in Chrome. Fix S. Note for the fix: `abort(reason)` rejects with the reason
  itself, so test the signal and not `error.name`.
* **CO3. Entries are never aged or dated.** `content/collector-main.js:31`. No route change, hot
  reload or copy empties the buffers, and the `t` on each entry is never printed. On a single page
  app the second prompt of a session repeats the first one's errors under a new page heading.
  Collecting from load is documented; the missing age is not. Checked in Chrome and by reading.
  Fix M.
* **CO4. The caller of a failed request is lost behind a request library.**
  `content/collector-main.js:168`. Six frames are captured, two of them the collector's own, which
  cannot reach page code through axios. In a development build the "called from" line is absent;
  in a bundle it names axios internals. This is a headline feature (`README.md:67`). Checked with
  real axios in Chrome. Fix S for development builds; bundles also need known library frames
  skipped.
* **CO6. DevTools attributes the page's console output to the extension.**
  `content/collector-main.js:105`. The wrapper is the top frame of every call, so the source link
  beside each warning and error reads `collector-main.js:105`, and failed requests link to
  `collector-main.js:291` and `collector-main.js:396`. This is the one finding every user meets on
  every page, panel open or not. Observed by opening DevTools on a page with the extension copy
  loaded. A static inline source map with an `ignoreList` restored the page's own file and line on
  a scratch copy and needs no build step. Fix S.
* **M2. Warnings share 30 slots with errors, and repeats are not folded.**
  `content/collector-main.js:33`, `content/collector-main.js:98`. Thirty identical warnings evict
  the one `console.error` that mattered. Checked by Node run on the real collector.

**Picker**

* **PI1 and SP1. Picked markup and attributes are printed and stored with no redaction.**
  `content/picker.js:416`, `content/picker.js:443`. React mirrors a controlled input's live value
  into the `value` attribute, so picking a password field or its form prints the typed password
  directly under "Props … password=<redacted>". A server rendered hidden CSRF input prints too. The
  payload is also written to `cdrReport` (`sidepanel/panel.js:1206`) for up to a week.
  `README.md:428` calls props "the one thing here that is read out of a running application".
  Rated medium, not high: it needs a secret in an attribute of the picked subtree, and the data
  stays local until pasted. Checked in Chrome against React 18.3.1 and 19.1.0. Fix M.
* **PI4. Pointer events reach the page while picking.** `content/picker.js:670`. Only `mousedown`,
  `mouseup` and `click` are swallowed. A trigger that opens on `pointerdown` (the Radix pattern)
  opens, and the payload then describes it as expanded. `stop()` also unhooks everything at once
  (`content/picker.js:604`), so the second click of a double click reaches the page. Checked in
  Chrome. Fix S.
* **PI5. A disabled control cannot be picked.** `content/picker.js:669`. Chrome dispatches no
  `click` on it, so the picker highlights it and never hears the click. The repository's own React
  fixture has one (`tools/demo-react.html:252`). Checked on the stage. Fix M (commit the pick on
  `pointerup`).
* **PI6. Nothing inside an iframe can be picked, and the click goes through.** `background.js:99`.
  See lead 3. Storybook style apps, where everything runs in a preview frame, are unusable with
  Element. Checked in Chrome for same origin and cross origin frames. Fix M for a shield that picks
  the frame as a whole.
* **PI7. Inside a shadow root the pick is the outermost host.** `content/picker.js:547`. See lead
  3. Checked in Chrome. Fix L.
* **PI10. Styles and the screenshot are always taken in the hover state.** `content/picker.js:573`.
  Nothing sits between the pointer and the page (a deliberate design, `content/picker.js:4`), so a
  button reported for its resting colour prints its hover colour. The prompt does not say so.
  Checked in Chrome. Fix S to disclose, M to wait until the element is no longer hovered.
* **PI13. One long attribute defeats the markup cap.** `content/picker.js:420`. The opening tag is
  exempt from `MAX_HTML` (`content/picker.js:92`), so an image with an inlined data URI enters the
  prompt whole and is rewritten to storage on every keystroke, while the markup is labelled
  truncated. Bundlers inline small images, so an ordinary pick can hit this. Keeping the opening
  tag is a commented decision that assumes a short tag. Checked in Chrome. Fix S.

**Component lookup**

* **PI2. The call site line says "defined elsewhere" when it is not.**
  `content/collector-main.js:758`, `shared/prompt-template.js:354`. When the picked element is
  written inside the component that renders it, the commonest case, the collector drops the owner
  and the template prints that the component is defined elsewhere while citing a line inside its
  own definition. Reproduced on `tools/demo-react.html` and on React 19.2.0. Fix S.
* **PI8. Long selectors are cut from the wrong end.** `shared/prompt-template.js:679`. The selector
  goes through `flatten()`, whose 200 character cap (`shared/prompt-template.js:181`) removes the
  picked element's own segment on utility class markup. A 228 character selector that matched one
  element printed as 200 characters that matched none, with no sign of the cut. Checked in Chrome
  and Node. Fix S.
* **PI9. On React 19.1 and later the call site is an unmapped stack position.**
  `content/collector-main.js:648`. The line and column are those of the module the browser
  executed, printed with the same confidence as an exact `_debugSource` location. Observed on a
  real React 19.2.0 development build; how large the drift is under Vite or Next was not measured.
  Fix M.
* **M5. Reported props can be one commit old.** `content/collector-main.js:767`. The DOM node can
  point at the alternate fiber, which the comment at `content/collector-main.js:659` acknowledges.
  On React 18.3.1 the printed props alternated between stale and fresh on each render, so a prop
  that just changed, often the bug being reported, is wrong about half the time. Checked in
  Chrome, single pass.

**Prompt**

* **PJ1. Console evidence prints out of order and undated.** `shared/prompt-template.js:200`.
  Every uncaught error prints before every console line, and requests sit in another section. The
  README's own run prints its three events in the reverse of the order the page produced them
  (`README.md:200`). Checked by Node run. Fix M. Fixing it reorders the default preview, which the
  byte for byte rule forbids unless decided on purpose.
* **PJ6 and CO13. URLs and console objects print with their secrets.**
  `shared/prompt-template.js:244`, `content/collector-main.js:297`. Page URLs keep query and
  fragment values (a commented choice, `shared/prompt-template.js:700`). Request URLs and resource
  error URLs skip even the credential strip in `safeUrl`, and a logged object prints its
  `password` and `Authorization` keys intact. An OAuth code, an access token and `user:pass@` all
  printed in a browser run. Fix M.
* **PJ7. Repeats print once each and evictions are silent.** `shared/prompt-template.js:240`. A
  poll that fails 30 times produced a 16,906 character prompt against 403 without it, and nothing
  says earlier entries were dropped. Checked by Node and browser run. Fix M.
* **M8. An error with a multi line message prints its message as frames.**
  `shared/prompt-template.js:210`. Frames are taken as lines 1 to 3 of the stack, so a `ZodError`
  or React's "Invalid hook call" prints message lines indented as frames and no real frame, and
  drops the location the collector recorded in `where`. Checked in Chrome, single pass.

**Release and docs**

* **TR1. The README's release zip path leads to the old product.** `README.md:345`. See lead 4.
  Rated medium because the first and recommended install path (clone) is unaffected. Fix S.
* **SP3. The README recipe for restricting the extension breaks capture everywhere.**
  `README.md:469`. It tells the reader to narrow `host_permissions` to an origin list.
  `captureVisibleTab` requires `<all_urls>` or `activeTab` (Chrome tabs reference, and Chromium's
  `CanCaptureVisiblePage`), so Region, Element and Screen then fail on every site, listed or not.
  Only the two `content_scripts` matches should be narrowed. Not run with an edited manifest.
  Fix S.

**Panel**

* **UX2. Discard all deletes every sentence and file on one click.** `sidepanel/panel.js:826`. No
  confirmation, no undo, and it sits 12 px from the identically styled "Clear collected log"
  (`sidepanel/panel.html:171`). Checked on the stage. Fix M.
* **UX3. Errors appear off screen and are not announced.** `sidepanel/panel.html:23`. The banner
  has no live region and sits in normal flow (`sidepanel/panel.css:165`). With three items the
  panel document is about 955 px tall, and a failed save rendered its banner above the viewport.
  Checked on the stage. Fix S.
* **M12. Every capture scrolls the whole panel.** `sidepanel/panel.js:636`. `scrollIntoView` on
  the selected row scrolls the document, not just the list, so after three captures in a 700 px
  panel the top of the frame is cut off and Copy is below the fold. This is what makes UX3 bite
  without the user scrolling. Checked on the stage, single pass.

### Low severity

| Id | Where | What | Checked by | Fix |
| :--- | :--- | :--- | :--- | :--- |
| CW4 | `content/overlay.js:183` | A region dragged while no panel is open is dropped silently; nothing disarms the page when the panel closes. | run and reading | M |
| CW6 | `background.js:62` | Any URL that merely contains a Web Store host string is treated as the Web Store. | browser run | S |
| CW7 | `content/overlay.js:230` | No `touch-action` and no `pointercancel` handler, so a touch drag pans the page and leaves dragging stuck on. | browser run | S |
| CW9 | `sidepanel/panel.js:1550` | `ready` has no rejection handler, so a failed startup makes the panel ignore every broadcast; a late `cdr:check-tab` reply is applied to whichever tab is current. | Node run | S |
| CW11 | `background.js:59` | The internal page regex branch is reached only on the extension's own pages, and a few message fields are never read. | browser run | S |
| CW12 | `sidepanel/panel.js:917` | No in flight guard, so a double click on Screen files two identical items. | run and reading | S |
| UX14 | `content/picker.js:668` | Region and Element are pointer only, and the picker cannot widen to a parent. | reading | M |
| M1 | `content/overlay.js:227` | On a page whose `body` has a transform or filter, the selection box and hint render at document coordinates and vanish once scrolled. The crop itself is still right. | browser run, single pass | S |
| SS3 | `sidepanel/panel.js:1481` | A storage removal has no `newValue`, so another panel's expiry is adopted as an empty sheet by a panel left open. | run and reading | S |
| SS4 | `sidepanel/panel.js:1282` | Two writes that cross before either is adopted lose an item on both panels or bring a discarded one back. | Node run | M |
| SS5 | `sidepanel/panel.js:851` | `resetAfterCopy` filters by object identity, so an adoption during the copy leaves the copied items on the sheet. | Node run | S |
| SS6 | `shared/prompt-template.js:873` | The prompt numbers the ticked subset from 1 while the sheet numbers by position, so they disagree when an earlier row is unticked. | Node run | S |
| SS7 | `sidepanel/panel.js:1183` | The FILE MISSING reason lives only in the shared banner, "capture it again" does not lift the block, and the flag is persisted and never rechecked. | run and reading | M |
| SS8 | `sidepanel/panel.js:779` | A failed save for an item not in the frame moves the selection, so the next keystrokes land in another item. | Node run | S |
| SS9 | `sidepanel/panel.js:1550` | `restore()` has no catch; a stored item with a mode this build does not know leaves the panel inert on every open. | Node run | S |
| SS10 | `sidepanel/panel.js:1486` | Each keystroke in one window makes every other panel read both storage keys, rebuild its list and query its tab. | run and reading | M |
| SS11 | `sidepanel/panel.js:710` | `title` and `tabId` are stored with every item and never read; `id="toggles"` is unreferenced. | reading | S |
| SS12 | `sidepanel/panel.js:1240` | Intent and toggles are written together from one panel's memory and no panel listens, so a stale panel overwrites the other's settings. | run and reading | S |
| RO1 | `sidepanel/panel.js:936` | On a restricted tab `refreshContext` returns without clearing `state.context`, so Copy attaches an earlier tab's read while the chips show dashes. | Node run | S |
| RO3 | `sidepanel/panel.js:1084` | With the page toggle off the only mismatch caution is never printed while console and network still are. | Node run | S |
| RO7 | `sidepanel/panel.js:1298` | File existence is checked once at startup, and an item whose download record was erased can never be flagged. | run and reading | S |
| RO9 | `sidepanel/panel.js:1138` | After a blocked clipboard the only ways to clear the sheet delete the files the hand copied prompt names. | Node run | S |
| RO10 | `sidepanel/panel.js:1350` | Screenshots are deleted only on discard; a copy, the weekly expiry and a panel closed mid save all leave the PNG. | reading | M |
| RO11 | `README.md:126` | The chips are a snapshot, replies are not matched to the current tab, and the element chip shows the "reload" dash when there are simply no element items. | Node run | S |
| SP6 | `sidepanel/panel.js:1016` | File names carry the page's host and last path segment, so the page toggle does not keep the host out of the prompt. | Node run | S |
| CO7 | `content/collector-main.js:121` | The URL in a failed resource entry is never truncated, nor are the method or status text. | browser run | S |
| CO8 | `content/collector-main.js:100` | Console text keeps raw printf specifiers, and an `Error` argument prints its header twice. | browser run | S |
| CO9 | `content/collector-main.js:285` | Two wrappers do not pass a call through unchanged: `fetch` throws synchronously if the page replaced `window.performance`, and `open()` with one argument no longer throws. | browser run | S |
| CO10 | `content/collector-main.js:373` | Every XHR, successful or not, formats its captured stack before the success return, contrary to the architecture note. | run and reading | S |
| CO11 | `content/collector-bridge.js:74` | The bridge forwards whatever answers its snapshot request without checking shape or size, and a page script can substitute that reply. | browser run | M |
| CO12 | `content/collector-main.js:74` | `serialize()` runs page getters and proxy traps, and its node budget does not bound wide values. | browser run | M |
| CO14 | `content/collector-main.js:275` | Any page can tell the extension is installed (`fetch.name`, `__cdrCollector`), and every message listener receives the buffer each time the panel polls. | browser run | M |
| M3 | `content/collector-main.js:122` | A failed resource loses its URL for `srcset` only images, SVG images and objects. | browser run, single pass | S |
| M4 | `content/collector-main.js:291` | A fetch blocked by the page's CSP is reported, in the violation event and in the site's CSP reports, as coming from the extension. | browser run, single pass | M |
| PI12 | `content/picker.js:562` | The click captures the last highlighted node, which can be gone if the page scrolled or rendered again under a still pointer. | browser run | S |
| PI14 | `content/picker.js:661` | `mainWorldSilent` is cleared before the single `inspect()` of each arm, so every pick on a tab without a collector waits the full 300 ms. | run and reading | S |
| PI15 | `content/picker.js:567` | The payload carries `tagName`, `classes` and an uncapped `inlineStyle` that nothing reads. | run and reading | S |
| PI18 | `content/picker.js:379` | `cssPath` stops at six levels and never tests the result, so elements in repeated structures share one selector. | browser run | S |
| PI20 | `content/picker.js:286` | The highlight is drawn under anything in the top layer, such as a modal dialog. | browser run | S |
| SP8 | `content/picker.js:559` | The picker acts on untrusted events, so a page script can force a pick or a cancel while Element is armed. | browser run | S |
| PI3 | `content/collector-main.js:464` | The secret test is an unanchored substring match: `className` (contains "ssn") is always redacted, while `pwd`, `pin` and `otp` pass. | Node run | S |
| PI11 | `shared/prompt-template.js:532` | `generatedId()` knows only the older `useId` shape, so React 19.1 and 19.2 ids and dashed UUIDs are offered as search targets. | run and reading | S |
| PI16 | `content/collector-main.js:898` | Three handler heuristics misfire: minified bodies pass the four letter test, string literals are cut at `//`, and "bound X" is offered as a search target. | run and reading | S |
| PI17 | `README.md:253` | The README's React sample shows a class hint the picker cannot produce, and `tools/preview-prompt.mjs:214` says frames are resolved through a source map that nothing applies. | run and reading | S |
| PI21 | `content/collector-main.js:680` | When "XProvider" is folded into "X", the inner provider's props are printed as the props of X. | Node run | S |
| PJ8 | `shared/prompt-template.js:565` | `styleFile()` only matches backticked tokens and the one producer writes none, so the stylesheet never reaches the Search line. | Node run | S |
| SP7 | `background.js:130` | The worker runs panel only messages for any sender, and the panel adopts any `cdrReport` written to `storage.local`, which content script contexts can write by default. | run and reading | S |
| SP10 | `sidepanel/panel.js:709` | Nothing distinguishes an incognito tab, so with incognito access enabled a capture there is written to shared storage and Downloads. | run and reading | S |
| SP11 | `docs/ARCHITECTURE.md:275` | The statement that `activeTab` is not granted to side panel contexts is absent from Chrome's documentation (Chromium's source supports it for the toolbar icon path only). | Chrome docs | S |
| SP12 | `manifest.json:3` | A Web Store submission would need a standalone privacy policy, data use disclosures and a line saying the extension is not affiliated with Anthropic. Not a defect while distribution stays on GitHub (`README.md:324`). | Chrome docs | M |
| PJ5 | `shared/prompt-template.js:648` | No sentence marks page content as data, and flattened page strings print on the template's own lines ("Search for", "Props of"). | run and reading | S |
| PJ9 | `shared/prompt-template.js:776` | "across N pages" counts raw URLs while the Page lines compare printed URLs, so two that print identically are announced as 2 pages. | run and reading | S |
| PJ10 | `shared/prompt-template.js:194` | Times print in the machine's locale, with no zone and an ambiguous day and month order. | Node run | S |
| PJ13 | `shared/prompt-template.js:244` | An empty status text (every HTTP/2 response) leaves two spaces in the request line. | run and reading | S |
| PJ15 | `shared/prompt-template.js:186` | Malformed report fields print "undefined" or throw; not reachable from an ordinary page, reachable through a forged bridge reply (CO11). | run and reading | S |
| PJ17 | `shared/prompt-template.js:117` | The change closing gives the console and network evidence no role, and the bug closing names the console even when none is printed. | Node run | S |
| PJ18 | `shared/prompt-template.js:824` | In a list the shared block is headed "## Page" at the level of the items and reads as one more item; its viewport is the tab's at copy time. | run and reading | M |
| SP2 | `shared/prompt-template.js:785` | The page title and computed style values skip `flatten()`, so they keep backticks and unlimited length. | run and reading | S |
| TR2 | `tools/build.mjs:185` | The build validates manifest paths only: a syntax error, a mistyped injected script path, a missing `panel.css` or a broken import all build clean. | Node run | M |
| TR3 | `CONTRIBUTING.md:87` | The byte for byte rule has no stored baseline and no check, and the one item output already changed at `1d96cdb`. | Node run | M |
| TR4 | `.github/workflows/release.yml:15` | A manual run from `main` always fails the tag check. | run and reading | S |
| TR5 | `.github/workflows/release.yml:60` | The reproducible checksum holds only for a Node with bundled zlib and an LF checkout. | Node run | S |
| TR6 | `tools/build.mjs:145` | The build zips whatever is on disk inside the included folders, so untracked files ship in a local build. | Node run | S |
| TR7 | `.github/workflows/release.yml:33` | Nothing reads `package.json`'s version, and 0.4.0 already covers two trees that differ at runtime (`9ded3b5` and `dfe2c89`). | Node run | S |
| TR8 | `tools/chrome-shim.js:27` | The shim's download ids reset when the panel frame reloads while stored items keep theirs (stage only). | browser run | S |
| TR9 | `docs/ARCHITECTURE.md:297` | The list of what the stage does not reproduce is short by at least eight items. | run and reading | S |
| TR10 | `tools/make-media.mjs:5` | Three setup notes in the media scripts are wrong. | run and reading | S |
| TR11 | `README.md:330` | The GitHub repository's description and homepage still describe the project under its old name. | run and reading | S |
| PJ12 | `tools/preview-prompt.mjs:137` | The four preview modes leave many template branches unrendered (Vue, two origins, FAILED requests, truncated markup, the single item caution). | Node run | M |
| TR12 | `content/collector-bridge.js:62` | Fields collected and stored but never read (listed under the feature inventory). | reading | S |
| TR13 | `background.js:10` | Small document mismatches; the protocol header in `background.js` omits `cdr:check-tab` and `cdr:armed`. | run and reading | S |
| M11 | `tools/build.mjs:32` | The release zip contains no LICENSE and no shipped file carries the MIT notice. | run, single pass | S |
| UX4 | `sidepanel/panel.js:360` | Every tab event clears the one shared banner, erasing the only explanation of a disabled Copy button. | run and reading | M |
| UX7 | `sidepanel/panel.js:637` | Clicking a row leaves focus on the row, so typing a correction costs a second click. | browser run | S |
| UX8 | `sidepanel/panel.js:851` | After a partial copy the leftover rows stay unticked while new captures arrive ticked. | browser run | S |
| UX9 | `sidepanel/panel.js:1131` | The Copied receipt is hidden only by Discard all, so it sits under the next sheet. | browser run | S |
| UX11 | `sidepanel/panel.html:36` | The shortcut hint is hardcoded and never asks `chrome.commands` what is bound; the copy shortcut is shown nowhere. | Chrome docs | S |
| UX12 | `sidepanel/panel.css:29` | Three text contrast failures against WCAG AA: muted text on the sunken surface (4.39:1), the placeholder (3.38:1 light), unticked rows (2.96:1 light). | Node run | S |
| UX13 | `sidepanel/panel.js:202` | Armed buttons and "Read prompt" expose no pressed or expanded state, and the row tooltip cannot be hovered or dismissed with Esc. | browser run | S |
| UX15 | `sidepanel/panel.html:133` | Loose labels: the gauge reports device pixels while the page readouts report CSS pixels, and "collector" appears once in a UI that otherwise says "log". | run and reading | S |
| UX16 | `sidepanel/panel.html:91` | Dead markup is limited to one unused id, one default text never shown and one empty count element. | Node run | S |

### Refuted, and not settled

* **CW8, refuted.** The claim was that an arm landing between navigation start and commit leaves
  the armed state stale. Chrome reports `status: 'loading'` at commit, not at navigation start, so
  the state is cleared with the outgoing document (`background.js:176`). Observed with the
  extension copy in Chrome.
* **UX5, not settled.** After a region or element capture the panel calls
  `el.description.focus()` (`sidepanel/panel.js:731`). Whether that takes keyboard focus away from
  the page the user just dragged on, in a panel that was already open, could not be run here: on
  the stage both frames share one page, and scripted input bypasses real window focus. To settle
  it: in current Chrome with the panel open, click Region, drag, and type at once. If the
  characters do not land in the field, this is medium. Settled for 0.6.0 with a real side panel
  in headless Chrome for Testing 156: they land in the page, so it is medium (F44).

## The prompt, read as the session that receives it

All four previews were rendered (`npm run prompt`, `change`, `mixed`, `minified`) and read as a
Claude Code session that must act in a codebase it has never seen.

**What works.** Numbered items with a closing that asks for each change to be attributed. The
"Search for" line, which is the most useful line in the element section. Caller frames under a
failed request. The structure also held: `fence()` and `flatten()` stopped page text from opening a
section in every hostile input tried.

**What is missing.**

* Which item an error belongs to, and when it happened. Nothing is dated (PJ1).
* What the server said. A failed request prints a status line and no body
  (`content/collector-main.js:295`), under a closing that asks for the root cause.
* The origin and port. `pathOf` strips the origin everywhere (`shared/prompt-template.js:707`), a
  documented choice. In the README's real run the origin survives only inside a stack frame
  (`README.md:201`). A session with browser tools cannot open `/checkout`, and localhost against
  staging is itself evidence.
* Why a section is absent. Toggle off, no collector, and nothing logged all print the same nothing
  (`shared/prompt-template.js:894`).
* What to do when the screenshot path cannot be opened (lead 6).
* The viewport at capture. The Page viewport is the tab's at copy time
  (`content/collector-bridge.js:55`).

**What costs characters for little gain** (measured on the real output).

* One item bug preview, 2,059 characters: Selected element 903 (44 percent), Console 311, Network
  265, Screenshot 168, closing 156, Page 118.
* Mixed preview, 3,352 characters: closing 571 plus preamble 214, together 23 percent.
* Minified preview, 2,013 characters: the two lines explaining the renamed component are 182 and
  178 characters, 18 percent, and "React DevTools shows the same name" is addressed to a person.
* The README's real run, 2,559 characters: the computed styles line is 364 characters (14 percent)
  on an input in a request about validation (`README.md:185`).
* The markup fence repeats the class, test id and label already printed on the Search, Classes and
  Selector lines.

The styles list is documented as tunable, so this is a cost argument and not a defect.

**What could mislead.** The false "defined elsewhere" (PI2). A change request that ships a
TypeError and a 500 with no instruction about them, so the model either fixes the bug unasked or
ignores a defect in the field it is changing (PJ17). "## Page" at the level of the items (PJ18).
Evidence from an earlier route under the current page's heading (CO3).

## Improvements to current features

Ranked by impact against effort. None of these adds a permission or changes the install warning.
Where one breaks a project rule, the entry says so.

| # | Improvement | Effort | Impact | Closes |
| :--- | :--- | :--- | :--- | :--- |
| 1 | Publish 0.4.0 and stop version bumps going untagged | S | high | TR1, TR4, TR7, TR11 |
| 2 | Count only real failures as failed requests | S | high | CO1, CO2 |
| 3 | Take the extension out of the DevTools console | S | high | CO6 |
| 4 | Make cancel and Screen behave while armed | S | high | CW5, CW1, CW12 |
| 5 | Keep the prompt honest when the context read fails or is stale | S | high | RO4, RO5, RO1, RO2, RO3 |
| 6 | Tests and CI that enforce the project's own rules | M | high | TR3, TR2, PJ12, lead 5 |
| 7 | Redact secrets where they are read | M | high | PI1, SP1, PJ6, CO13, PI3 |
| 8 | Console and network sections in time order, folded and counted | M | high | PJ1, PJ7, CO3, M2, M8, CO8 |
| 9 | Arm the collector on a tab that has none | M | high | cause of RO4 |
| 10 | Picker: swallow pointer events, pick disabled controls | S to M | med | PI4, PI5, PI12 |
| 11 | Element section correctness | S | med | PI2, PI8, PI13, PI9, PI11, PI16 |
| 12 | Banner that stays visible, is announced, and explains a disabled Copy | S | med | UX3, UX4, M12, SS7 |
| 13 | Correct the README restriction recipe and privacy text | S | med | SP3, SP11, TR9, TR13, PI17 |
| 14 | Cross window: require real focus, then merge per item | S, then M | med | SS1, SS4, SS5, SS3, SS12 |
| 15 | Check a download id still names the item's file | S | med | RO6, RO7 |
| 16 | Crop through the visual viewport | S | med | CW2 |
| 17 | Undo for discards, and move Discard all | M | med | UX2, RO9 |
| 18 | Deeper stack capture that skips known library frames | S | med | CO4, CO10 |
| 19 | Mount the overlay and picker above the top layer | M | med | CW3, PI20, M1 |
| 20 | Shield iframes while picking | M | med | PI6 |
| 21 | Say which lines are page data, and stop trusting the bridge reply | S | low to med | PJ5, SP2, CO11, SP7, PJ15 |
| 22 | Disclose the hover state; read props from the current fiber | S to M | med | PI10, M5 |
| 23 | Sheet frictions and accessibility | S | low to med | UX7, UX8, UX9, UX11, UX12, UX13, SS6 |
| 24 | Cleanup | S | low | TR12, SS11, PI15, UX16, CW6, SS9, CW9, M11, TR6, M3, PJ10, CO7 |

**1. Publish 0.4.0 and stop version bumps going untagged.**
Tag HEAD as `v0.4.0` and push; the workflow's check passes and publishes
`claude-punch-list-v0.4.0.zip`. Then make it self healing: a job on push to `main` that creates the
release when no tag exists for the manifest version, which also replaces the dispatch path that
cannot succeed. Update the repository description and homepage. Files:
`.github/workflows/release.yml`. Risk: none.

**2. Count only real failures as failed requests.**
Test `response.status >= 400` in the fetch wrapper, matching the XHR branch and the README. Tag a
rejection as aborted (the request's signal is aborted) or timeout (XHR `timeout` event) and have
the template print ABORTED or TIMEOUT for tagged entries, listed after real failures. Files:
`content/collector-main.js`, `shared/prompt-template.js`. Risk: this code runs on every page, so
the additions stay inside the existing `try` blocks. Dropping aborts entirely would hide a request
the page cancels by mistake, so label them. Rule: none, provided the template changes output only
for entries that carry the new tag.

**3. Take the extension out of the DevTools console.**
Append one static line to `content/collector-main.js`: an inline `data:` source map with a single
mapping and `ignoreList: [0]`. On a scratch copy DevTools then linked the page's own file and line.
Document the manual "Add script to ignore list" fallback. Files: `content/collector-main.js`,
`README.md`. Risk: observed in Chrome for Testing 156, so confirm on current stable. Rule: none;
the line is static, so there is still no build step. It does not change what the page's CSP
reports say (M4).

**4. Make cancel and Screen behave while armed.**
In the panel's `keydown` listener, Escape with a mode armed does what clicking the lit button does
(`sidepanel/panel.js:882`). In `captureVisible`, disarm and wait two frames before capturing, and
add an in flight guard. Files: `sidepanel/panel.js`, `background.js`. Risk: low.

**5. Keep the prompt honest when the context read fails or is stale.**
Fall back to the newest item's own URL and title when no context was read. Race the read in
`copyReport` against about 1.5 seconds and copy without context if it loses, saying so in the
receipt. Clear `state.context` in the early return at `sidepanel/panel.js:936` and ignore a reply
whose tab is no longer current. Pass `armedAt` through and print a caution when it is later than an
item's capture time. Files: `sidepanel/panel.js`, `shared/prompt-template.js`. Rule: one item
output changes only in cases that today print no page at all, or after a reload.

**6. Tests and CI that enforce the project's own rules.**
A `test/` folder run by `node --test`: golden files for the four previews plus the branches no
preview reaches; the collector in `node:vm`; a compile of `overlay.js` and `picker.js` concatenated
with themselves, which fails on any top level `const`, `let` or `class`; parse checks; existence
checks for the injected script paths, `panel.html` references and imports; manifest and package
version agreement. Add a workflow on push and pull request, and run the tests before the release
build. Files: `test/`, `package.json`, `tools/build.mjs`, `.github/workflows/ci.yml`,
`CONTRIBUTING.md`. Risk: goldens need a pinned locale or a locale independent `stamp()` (PJ10).
Rule: none. `node:test` ships with Node (experimental through the 18 line, stable from 20, and the
workflow already uses Node 20), and nothing under `test/` is packaged. It also means rewording
`CONTRIBUTING.md:87`, whose named baseline has been false since `1d96cdb`.

**7. Redact secrets where they are read.**
In `picker.js`, blank the value of password and hidden inputs and of any control or attribute
whose name matches the secret list, in both `attributes()` and the serialised markup. Match secret
words on word boundaries so `className` stops being redacted and `pwd`, `pin`, `otp` and `cvc` start
being. One helper in the template that strips credentials and masks query and fragment values
whose key matches, used wherever a URL prints. Test object keys inside `serialize()`. Files:
`content/picker.js`, `content/collector-main.js`, `shared/prompt-template.js`, `README.md`. Risk: a
false positive can hide an id that matters to the bug. Rule: none; the previews contain nothing
that would be masked. It is a name match and not a guarantee, which the README should keep saying.

**8. Console and network sections in time order, folded and counted.**
Merge errors and console lines by `t` and prefix a clock derived from `armedAt`. Fold consecutive
identical entries into one line with a count. Have `push()` count evictions and print "last 30, N
earlier dropped". Give warnings their own ring. Take frames from the lines that start with "at",
not from fixed positions. Files: `content/collector-main.js`, `shared/prompt-template.js`,
`sidepanel/panel.js`, `tools/preview-prompt.mjs`. Rule: **breaks the byte for byte rule.** Lines
19 to 23 of the default preview reorder and gain a clock. Worth doing once, on purpose, with the
goldens from item 6 updated in the same commit.

**9. Arm the collector on a tab that has none.**
When `cdr:get-context` finds no receiver, inject `collector-main.js` (world MAIN) and
`collector-bridge.js` with `chrome.scripting.executeScript`, and show "collecting from now". Today
the only advice is to reload (`sidepanel/panel.js:953`), which destroys the state the user was
about to capture. Files: `sidepanel/panel.js`, `background.js`, `content/collector-bridge.js`.
Risk: a late wrap misses everything before injection and any request made through a reference the
page saved earlier; after an extension reload the old bridge's guard may block the new one, which
needs a check in Chrome. Permission: none new; `scripting` and `<all_urls>` are already declared.

**10. Picker: swallow pointer events, pick disabled controls.**
Add capture phase listeners for `pointerdown`, `pointerup`, `auxclick` and `contextmenu`; commit
the pick from `pointerup`, which Chrome still dispatches on disabled controls; resolve the node at
click time; keep swallowing briefly after the pick. Files: `content/picker.js`. Rule: additions
must stay inside `createController`, since the file is injected repeatedly.

**11. Element section correctness.**
Keep the selector's own segment by bounding it in `cssPath` from the left. Send the owner even
when it equals the component and print "inside X" in that case. Rebuild the opening tag from
attributes with the 120 character cap `attributes()` already uses. Mark a call site that came from
`_debugStack` and stop printing its line as exact. Teach `generatedId()` the React 19 shapes. Drop
"bound " from handler names. Files: `content/picker.js`, `content/collector-main.js`,
`shared/prompt-template.js`. Rule: the PI2 and PI9 changes alter one item output for React picks.
That is a correction of a wrong sentence, and should land with updated goldens.

**12. Banner that stays visible, is announced, and explains a disabled Copy.**
`role="status"` on the banner and the receipt (`role="alert"` for errors), `position: sticky` on
`.notice`, a one line reason under the Copy button computed in `updateSubmitState`, and
`resolveTab` clearing only a banner it set. Scroll the list, not the document, when a row is
selected. Files: `sidepanel/panel.html`, `sidepanel/panel.css`, `sidepanel/panel.js`.

**13. Correct the README restriction recipe and privacy text.**
Tell the reader to narrow only the two `content_scripts` matches and leave `host_permissions`
alone. Replace the "one thing here" sentence with a list of what is and is not screened. Fix the
`activeTab` wording in `docs/ARCHITECTURE.md:275`. Files: `README.md`, `docs/ARCHITECTURE.md`.

**14. Cross window: require real focus, then merge per item.**
First add `document.hasFocus()` to the guard at `sidepanel/panel.js:1261`. Then, if two windows
matter, give each item an `editedAt` and the report a short list of removed ids, and merge in
`adoptStored` instead of replacing. Files: `sidepanel/panel.js`, `docs/ARCHITECTURE.md`.

**15. Check a download id still names the item's file.**
Before `removeFile` or `erase`, and before trusting `exists`, search the id and require
`record.filename === item.path`. Check files again at copy time. Files: `sidepanel/panel.js`.

**16. Crop through the visual viewport.**
Send `visualViewport` offset and scale with the rectangle and apply them in `cropCapture`.
Identical to today at scale 1. Files: `content/overlay.js`, `content/picker.js`,
`sidepanel/panel.js`.

**17. Undo for discards, and move Discard all.**
Hold discarded items in memory for a few seconds behind an Undo and call `deleteFile` when it
lapses; flush on `pagehide`. Move Discard all out of the footer row it shares with "Clear
collected log". Files: `sidepanel/panel.js`, `sidepanel/panel.html`, `sidepanel/panel.css`. Rule:
the documented behaviour (a discarded item's file is deleted) still holds, a few seconds later.

**18. Deeper stack capture that skips known library frames.**
Raise `STACK_CAPTURE_DEPTH` from 6 to about 30, keep three reported frames, skip frames by well
known library function names, and format the stack only when the request failed. Files:
`content/collector-main.js`, `docs/ARCHITECTURE.md`. Risk: about a microsecond more per request.

**19. Mount the overlay and picker above the top layer.**
Append the host to the topmost `:modal` element when one exists; for popovers that are not modal,
give the host `popover="manual"` and call `showPopover()`. Files: `content/overlay.js`,
`content/picker.js`.

**20. Shield iframes while picking.**
Place a transparent rectangle over each visible iframe inside the picker's shadow root so the
frame is picked as a whole and clicks cannot leak. Say so in the README. Files:
`content/picker.js`. Full frame support is a separate, larger job: it needs `allFrames` injection,
the parent's offset for the crop, and the collector in every frame.

**21. Say which lines are page data, and stop trusting the bridge reply.**
Rebuild the snapshot in the bridge from known fields (three arrays capped at 30, strings sliced),
as `picker.js` already does for the inspect reply. Pass the title and style values through
`flatten()`. Call `chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })`.
Optionally add one sentence above the evidence saying it was read from the page and is data, not
instructions. Files: `content/collector-bridge.js`, `shared/prompt-template.js`, `background.js`.
Rule: the optional sentence **breaks the byte for byte rule** (one added line in every report with
evidence). The threat is real in principle, since page text flows into a prompt for a tool with
shell access, but for a developer on their own app it is low. If it is done, do it in the same
golden update as item 8.

**22. Disclose the hover state; read props from the current fiber.**
Cheapest: have the template say styles were read while hovered. Better: raise a transparent
catcher after the click and wait until the element no longer matches `:hover`. For props, prefer
the fiber on the current tree over its alternate. Files: `content/picker.js`,
`content/collector-main.js`, `shared/prompt-template.js`.

**23. Sheet frictions and accessibility.**
Focus the field after a pointer click on a row. Tick what remains after a partial copy. Retire the
receipt when the next item is added. Read the bound shortcut from `chrome.commands.getAll()`. Fix
the three contrast values. Add `aria-pressed` and `aria-expanded`. Number the prompt as the sheet
does. Files: `sidepanel/panel.js`, `sidepanel/panel.html`, `sidepanel/panel.css`.

**24. Cleanup.**
Remove the fields nothing reads, match the Web Store by hostname, give `restore()` a failure path,
add LICENSE to the zip, build from tracked files, read `currentSrc` and `href.baseVal` for failed
resources, truncate the uncapped strings.

## New feature proposals

Ranked the same way. Each comes from a gap found in the code. None adds a permission.

| # | Feature | Effort | Impact | From |
| :--- | :--- | :--- | :--- | :--- |
| 1 | Evidence that belongs to each item and survives a reload | M to L | high | lead 1 |
| 2 | The server's answer for a failed request | M | high | prompt review |
| 3 | Commands for Element, Screen and opening the panel | M | high | lead 7 |
| 4 | Review before copy, with size and a secret scan | M | med to high | PI1, PJ6 |
| 5 | Path mapping for WSL, devcontainers and remote sessions | M | med | lead 6 |
| 6 | Delayed whole screen capture | S | med | lead 7 |
| 7 | Svelte, Vue 3 production handlers, Vue 2 | S each | med | leads 3 and 8 |
| 8 | CSP violations, and failed stylesheet images and fonts | S each | med | lead 2 |
| 9 | Clean up old screenshots | M | med | lead 6 |
| 10 | Keep the last copied prompt across a panel close | S to M | med | UX9, RO9 |
| 11 | Reorder the sheet | M | med | lead 8 |
| 12 | Pick inside shadow roots | L | med | lead 3 |
| 13 | Collector switch per site | L | med | CO6, CO14, SP3 |
| 14 | Keyboard operable picker with parent and child stepping | M to L | med | UX14 |
| 15 | Component name in the hover tag | M | low to med | lead 8 |
| 16 | Annotate a capture | L | med | lead 8 |
| 17 | Capture at full page width with the panel closed | L | low to med | CW4 |
| 18 | Full page capture | L | low | lead 8 |

**1. Evidence that belongs to each item and survives a reload.**
`addItem` already reads the context right after each capture and keeps nothing
(`sidepanel/panel.js:729`). Step one (M): store two numbers on the item from that read, `armedAt`
and the highest `t` seen, and have the list layout print under each item the entries logged since
the previous capture. If `armedAt` no longer matches at copy time, say that item's console was
lost to a reload. Step two (L): keep a capped copy of each item's entries so they survive the
reload. Files: `sidepanel/panel.js`, `shared/prompt-template.js`, later
`content/collector-main.js` and `content/collector-bridge.js`. Risk: storage. One snapshot at
every limit measured 101 KB against a 10 MB quota, and the limits do not actually bound it (a
1 MB resource URL produced a 1 MB entry, CO7), so the stored copy needs its own cap and its own
storage key; `cdrReport` is rewritten on every keystroke (`sidepanel/panel.js:1454`). Console text
from pages the user has left would sit on disk for up to a week, which belongs in the README
privacy section. Rule: none if the one item layout keeps its single console and network sections.

**2. The server's answer for a failed request.**
For a response with status 400 or above, read the first few hundred characters of a JSON or text
body, and keep the start of a string request body, printed as indented lines inside the fence with
the same secret redaction. A 500's body is usually the server's own statement of the cause. Files:
`content/collector-main.js`, `shared/prompt-template.js`, `sidepanel/panel.js`,
`sidepanel/panel.html`. Risk: this is the riskiest change one can make to the collector. In a
browser run, `response.clone()` on a 48 MB error body the page never read made Chrome pull all
48 MB into memory however the copy was consumed, so the size must be decided before cloning, from
`Content-Length` and the content type. The body also arrives after the entry is recorded, so a
copy pressed at once can miss it. Bodies can hold personal data, so it wants its own toggle, off
by default. Rule: no request is made, so "no network requests" holds. "Never break a host page" is
the rule to test hardest, which is a reason to do item 6 of the improvements first.

**3. Commands for Element, Screen and opening the panel.**
Declare `capture-element`, `capture-screen` and `_execute_action` (three more suggested keys,
reaching Chrome's limit of four). Element arms like Region does. Screen needs a pending flag the
panel collects from the `cdr:check-tab` reply, because the capture runs in the panel and the panel
may not exist yet when the command fires. Files: `manifest.json`, `background.js`,
`sidepanel/panel.js`, `README.md`. Risk: a suggested key that collides with another extension
silently does not register, so the hint must come from `chrome.commands.getAll()`. That
`_execute_action` opens the panel under `openPanelOnActionClick` is shown by Chrome's own sample
but was not observed here, and it is a toggle: a second press closes the panel.

**4. Review before copy, with size and a secret scan.**
"Read prompt" lives inside the receipt, which stays hidden until a copy has happened
(`sidepanel/panel.html:148`), so the first chance to read what was sent comes after it is on the
clipboard. Show the assembled prompt before the first copy with its size and a count of token
shaped strings, with a switch to mask them. Files: `sidepanel/panel.html`, `sidepanel/panel.js`,
`sidepanel/panel.css`. Risk: a false positive masks an id that matters. Apply the mask after
`buildPrompt` so an unmasked one item report is unchanged.

**5. Path mapping for WSL, devcontainers and remote sessions.**
One optional setting, "Claude Code sees this folder as", holding a from prefix and a to prefix,
applied in `assembleReport` where `screenshotPath` is set. Files: `sidepanel/panel.js`,
`sidepanel/panel.html`, `README.md`. Risk: the folder must really be mounted on the other side,
which the extension cannot check. With the setting empty the output is unchanged. Also worth one
sentence in the template for a path that cannot be opened.

**6. Delayed whole screen capture.**
A three second countdown on Screen. Clicking the button moves the pointer and focus off the page,
so a hover state or an open menu cannot be photographed today. Files: `sidepanel/panel.js`,
`sidepanel/panel.html`.

**7. Svelte, Vue 3 production handlers, Vue 2.**
Svelte development builds attach `__svelte_meta` with file, line and column in both Svelte 4 and 5
(read from source; the shapes differ). Vue 3 stores its event invokers on the element under a
`_vei` key (a symbol from 3.3) in production builds too, so handler names are readable where
`content/collector-main.js:995` says a production build yields nothing. Vue 2 hangs its instance
off `__vue__`. Files: `content/collector-main.js`, `content/picker.js`,
`shared/prompt-template.js`. Risk: all are internals, so read them defensively and add a fixture
each. The `framework` field is a two way switch in three places and must become a real value.
Neither was run against a real build.

**8. CSP violations, and failed stylesheet images and fonts.**
A passive `securitypolicyviolation` listener (confirmed to receive violations from a main world
script at `document_start`) and a `PerformanceObserver` for resource entries with a status of 400
or more. Both observe and wrap nothing, so neither can break a page. Files:
`content/collector-main.js`, `shared/prompt-template.js`. Risk: noisy policies could fill the ring
without the folding from improvement 8; `responseStatus` is 0 for cross origin resources without
CORS.

**9. Clean up old screenshots.**
A footer action that lists this extension's own downloads in the save folder, excludes anything on
the sheet, shows a count, and removes files older than the report lifetime. Files:
`sidepanel/panel.js`, `sidepanel/panel.html`. Risk: deleting a screenshot a Claude Code session
still needs, hence the age threshold. Files whose history rows were cleared cannot be found.

**10. Keep the last copied prompt across a panel close.**
The prompt lives only in `state.lastPrompt` (`sidepanel/panel.js:1119`). An overwritten clipboard
plus a closed panel loses every sentence. Persist it under its own key for a short time, and add
"Put back on the sheet" to the receipt. Files: `sidepanel/panel.js`.

**11. Reorder the sheet.**
See lead 8. An array move plus `persist()`, with care for items still saving and for the three
places that read "last" as "newest" (`sidepanel/panel.js:852`, `sidepanel/panel.js:1120`,
`sidepanel/panel.js:1284`). A reorder would sync across windows for free and inherit SS4.

**12. Pick inside shadow roots.**
Descend through open roots with `shadowRoot.elementFromPoint`; `chrome.dom.openOrClosedShadowRoot`
is callable from a content script with no extra permission, so closed roots are reachable too.
Print the selector as host path plus inner path, and hand the node to the main world with a
composed event, since `document.querySelector` cannot reach inside. Files: `content/picker.js`,
`content/collector-main.js`.

**13. Collector switch per site.**
Replace the two static `content_scripts` entries with `chrome.scripting.registerContentScripts`
driven by a stored origin list (default localhost) and a "collect on this site" switch. This
shrinks every cost that scales with `<all_urls>`: the DevTools attribution, the per request
overhead, the fingerprint, and the reach of any defect in a wrapper. Files: `manifest.json`,
`background.js`, `sidepanel/panel.js`, `sidepanel/panel.html`, `README.md`. Cost: it gives up
"collected from page load without being asked" (`README.md:74`) on the first visit to a new
origin, which is a product decision more than a fix. The install warning does not shrink while
`host_permissions` stays. Combine with improvement 9 so first use needs no reload.

**14. Keyboard operable picker with parent and child stepping.**
Arrow keys to widen to a parent or narrow to a child, Enter to pick. Useful with a mouse too, when
the element wanted is covered by a child. Files: `content/picker.js`, `sidepanel/panel.js`.

**15. Component name in the hover tag.**
See lead 8. Use an event based handoff so hovering does not write attributes onto the page.

**16. Annotate a capture.**
See lead 8. It has to run before the save, while the full image still exists.

**17. Capture at full page width with the panel closed.**
Opening the panel narrows the page, so a layout bug that exists only at full width cannot be
captured. Letting the worker capture goes against the stated decision that the worker stays thin
(`docs/ARCHITECTURE.md:82`), and the worker would hold a large image it loses if evicted. Worth it
only if full width capture turns out to matter.

**18. Full page capture.**
`CONTRIBUTING.md:109` calls it out of scope and `README.md:559` calls it roadmap. One of the two
should change. The README's own list of obstacles is accurate.

## Top 5 to do next

1. **Tag and publish v0.4.0** (improvement 1). Ten minutes, and it repairs an install path that
   today hands people a different product.
2. **Add the test suite and CI** (improvement 6). Everything after this touches the template or
   the collector, the two files the project's rules protect, and nothing enforces those rules
   today.
3. **Ship the small fixes that make ordinary output wrong** (improvements 2 to 5): real failures
   only, the DevTools attribution, Esc and Screen while armed, and an honest prompt when the
   context read fails. All small, all in ordinary use.
4. **Redact secrets and correct the privacy and restriction text** (improvements 7 and 13). The
   README currently promises more than the code does, and one of its recipes breaks capture.
5. **Tie evidence to items and put it in time order** (feature 1, step one, with improvement 8).
   This is the largest gain in what the pasted prompt is worth to Claude Code, and it is where the
   byte for byte rule gets changed once, on purpose, with goldens to show exactly how.

Items 2 and 3 can swap if visible fixes should come first: the `panel.js` parts of item 3 touch no
file the rules cover.

## Not verified in real Chrome

Stated here so nothing above reads as more certain than it is.

* No run used a visible side panel. Focus behaviour between the page and the panel (CW5, UX5)
  rests on the stage and on reading. For 0.6.0 a real side panel, opened in headless Chrome for
  Testing 156, settled UX5.
* The fullscreen half of CW3, and whether `_execute_action` opens the panel, come from
  documentation and Chrome's samples. The fullscreen half was observed for 0.6.0 and read wrongly
  then: the overlay was drawn above the fullscreen element, inert, so every press reached the page.
  Since 0.6.1 it goes inside a fullscreen element that can hold it (F36).
* The cross window races (SS4, SS5) reproduce with artificial delays of 5 to 40 ms; the real gap
  in Chrome was not measured. SS3 was run against a fake storage.
* SP3 was not run with an edited manifest; it rests on the tabs reference and Chromium's source.
  For 0.6.0 it was run both ways in Chrome for Testing 156: with `host_permissions` narrowed,
  `captureVisibleTab` refused even on the listed origin, as stated.
* PI9 was observed on React 19.2.0 from a CDN build; the size of the drift under Vite or Next was
  not measured.
* The Vue `_vei` and Svelte `__svelte_meta` claims were read from each project's source, not run.
* Whether tamper or bot checks on real sites react to the wrapped natives (CO14) was not tested.
* How a model actually behaves on the noisier prompts (PJ17, PJ18) is a reading of the output, not
  an experiment. Settling it means running the previews through Claude Code against a fixture
  repository.

## Implemented after the review

The first three subsections on 2026-11-16, on the branch `review-fixes`, and their line references
point at that branch. The fourth, for 0.6.0, on 2026-11-17, on the branch `open-items`; its line
references point at that tree. The fifth, for 0.6.1, on 2026-11-17 and 2026-11-18; its line
references, and those in the table after it, point at the 0.6.1 tree. A note in parentheses marked
"since 0.6.1" in an earlier subsection says what changed later.

### Items 2 and 3 of the top 5

**Tests and CI (improvement 6).** `npm test` runs `node:test` with no dependency: goldens for the
prompt in `test/golden/`, the real collector in a `node:vm` realm against a fake XMLHttpRequest
that behaves as Chrome 156 was observed to, and static checks on every path the manifest, the
worker and the panel name. `.github/workflows/ci.yml` runs it on Node 20 and 24, and `release.yml`
runs it before building. (Since 0.6.1, CI runs on Node 22 and 24, and the release on Node 24.)

**Small fixes (improvements 2 to 5).**

* CO1, CO2: only a status of 400 or above, or no response at all, is recorded. A request the page
  ended itself is labelled `ABORTED by the page` or `TIMEOUT set by the page` and printed after the
  real failures.
* CO6: an inline source map puts the collector on DevTools' ignore list, so console and network
  entries link to the page's own code again.
* CW1, CW5, CW12: Esc in the panel cancels an armed mode, Screen cancels it before photographing,
  and a double click on Screen files one item.
* RO1, RO2, RO4, RO5: the context read is bounded at 2 s and its failure is printed as such instead
  of as a clean page; a read from an earlier tab is never reused; the reload caution names the items
  it applies to.

**Found and fixed while verifying those.**

* The XHR wrapper keeps one record per `open()`, and credits late events to the request they
  belong to when a page reopens or aborts the object from its own handlers (retries, long polls,
  nested cases, synchronous retries). A synchronous network failure, which fires no event, is
  recorded. A refused `open()` or `send()` leaves the bookkeeping and the request's clock alone,
  `open('GET')` throws as it does natively, and the collector's timer and listeners are the ones
  the page had at `document_start`, so zone.js does not see them.
* Ordering an arm against the disarm that cancels it moved into the worker, under one rule: a
  disarm cancels every arm asked for on that tab before it, and an arm asked for after it stands
  (`docs/ARCHITECTURE.md`, "The worker orders an arm and the disarm that cancels it").
* A Screen capture waits for the cancel on its own tab, including the one sent on leaving the tab,
  and when a busy page outlasts the 3 s bound the item carries a notice that the overlay may show.
* `resolveTab` ignores a reply that a newer call has overtaken.

**How it was checked.** Six rounds in headless Chrome for Testing 156.0.8078.4, from the fourth on
with the real unpacked extension (the panel run as a tab, the shortcut stood in for by a `cdr:arm`
with no id), each followed by an adversarial review and skeptics on its findings. The last round
passed 46 scenario checks and its review found nothing new to that round.

### Items 4 and 5 of the top 5, and F1 to F4

**Navigation and Screen while armed.** These four were found while verifying items 2 and 3, and
first listed in the table below.

* F1. Chrome reports `pushState`, `replaceState` and a hash change as `loading`, as it does a real
  navigation, and panel and worker went dark while the overlay stayed live. A navigation is now
  checked rather than assumed: on `loading` and `complete` the worker asks the page which controller
  is active, after any arm still landing (`background.js:322`), and the panel asks the same before
  it goes dark (`sidepanel/panel.js:1009`). The overlay and the picker stop themselves on `pagehide`
  (`content/overlay.js:236`, `content/picker.js:1160`), so a page restored from the back/forward
  cache comes back without one.
* F2. A mode armed while Screen waits on its cancel stays armed. The disarm's reply says when an
  arm asked for since has taken the page over (`background.js:277`), and Screen then
  photographs the page and says the overlay may show (`sidepanel/panel.js:1113`).
  That is settled: the page as it was is often the point, and the notice covers the overlay that
  may be in it. The region and element failure handlers no longer turn off a mode armed after
  the drag.
* F3. Covered by F1. An arm that lands in a document on its way out is seen to be gone, and its
  late broadcast is refused as a cancelled arm's is.
* F4. Every banner carries a scope (`sidepanel/panel.js:210`). A notice about one capture, such as
  "the overlay may show", stays until the tab changes; an error about the page goes when the page
  changes; one about the report (a missing file, a failed copy, a failed save) is left alone by
  both. A restriction replaces any banner, and once it goes a missing file, which still holds
  Copy back, is said again. A tab change is measured against the last `resolveTab` call to
  finish, because opening a tab fires several at once.

**Redaction (improvements 7 and 13).**

* One name test, in three identical copies (template, collector, picker) that a static test holds
  identical. It matches whole words in camelCase, snake case and kebab case names, ignores a
  trailing number, and matches a few words at either end of a run together name (`authtoken`).
  `className` is no longer redacted, and `pwd`, `pin`, `otp`, `cvc` and `otp1` are.
* One URL block, in the template and the picker. Credentials are stripped, and a query or fragment
  value whose name matches is masked, splitting on `;` as well as `&` and following a URL nested in
  a value (`shared/prompt-template.js:1054`). The template applies it to every URL it prints, and
  through `safeText` (`shared/prompt-template.js:1223`) to URLs inside console text, stack frames,
  the `where` line and request caller frames.
* Picker (`content/picker.js:752`). The value of a password, hidden, email or tel input, and of any
  control, attribute, `srcset` candidate, style `url()` or textarea whose name matches, is masked in
  both the attribute list and the serialised markup. Truncation finds the real end of the opening
  tag before it cuts.
* Collector. Keys are tested while props and logged objects are serialised
  (`content/collector-main.js:282`), and `value`, `defaultValue` and `modelValue` are hidden on a
  component whose props describe a password, one time code or card field
  (`content/collector-main.js:1098`).
* README. The privacy section lists what is screened and what is not, and the restriction recipe
  narrows only the two `content_scripts` matches. `docs/ARCHITECTURE.md` states the `activeTab`
  limit correctly.

**Evidence per item, in time order (feature 1 step one, improvement 8).**

* The collector keeps warnings in a ring of their own, counts what each ring drops, stamps every
  entry with a time and a sequence number, and takes both clocks from the natives it had at
  `document_start` (`content/collector-main.js:43`), so a page that fakes `Date` cannot move them.
* The panel stamps an item's time just before `captureVisibleTab` (`sidepanel/panel.js:482`) and
  stores the page load it was captured on (`sidepanel/panel.js:850`).
* The template merges console lines and errors by time, prints a clock (with the date when an
  entry falls on another day than the copy), folds repeats with a count, and takes frames from the
  lines that start with `at`. With more than one item, each item lists what was logged since the
  item before it on the same page load (`shared/prompt-template.js:1414`, `:1439`), says when its
  evidence was on another page or another load, and notes when a ring had already dropped entries
  from its stretch. What came after the last capture gets a section of its own.
* **This breaks the byte for byte rule, once and on purpose**, as improvement 8 said it would.
  Rendered from the same input, the one item prompt differs from `a0c9335` in its console and
  network sections only: the entries reorder by time, gain a clock, and their continuation lines
  move right to match. The goldens in `test/golden/` show it line by line. The preview sample's
  CSS Module line changed too, because the old sample printed a sentence the picker cannot
  produce.

**Found and fixed while verifying those.**

* An arm counts as landing from the moment it is asked for (`background.js:166`), not from its
  injection. A check that arrived while the worker still looked the tab up asked a page the overlay
  had not reached, turned the button dark over it, and left Screen to photograph it with no notice.
  New with F1; on a page rewriting its URL as fast as Chrome allows it hit 1 click in 100 in one
  harness and 3 in 80 in another.
* A tab opened in the foreground no longer keeps the previous tab's banner, an error about one
  page no longer outlives a navigation, and the slow save hint goes with its save, including when
  the item was discarded mid save.
* Redaction gaps seen in Chrome: `&amp;` in markup, parameters split by `;`, nested and percent
  encoded URLs, `//user:pass@`, the later candidates of a `srcset`, `ping`, `xlink:href`,
  `data-src`, `data-href`, style `url()`, secret named textareas and buttons, relative URLs and
  frames in console text, and a truncated opening tag that lost its masked attributes.
* Timeline: a page's own `Date.now` could move the collector's clock; an item's time was read after
  the screenshot rather than before; an item from another tab's load of the same URL was called a
  reload; the date was missing when the log crossed midnight.
* From the fourth round, on the fixes themselves. A URL nested a few thousand times ran the
  screening out of stack, and the page address then printed raw: nesting is followed four levels
  and masked whole past that, and an address that cannot be parsed is still screened. Console
  text stopped matching a URL at its first letter outside ASCII, which printed the token of an
  international address the earlier code had masked: letters of any script now count. A key over
  100 characters was skipped. The style `url()` pattern and the trailing bracket trim could take
  seconds on hostile input, and now take one pass. In Chrome before 138, which leaves a `>` inside
  an attribute value as it is, a cut could split the opening tag and print it unmasked. A `;` or a
  `:line:col` could leave the tail of a secret value in clear. The text of a short secret
  textarea was cut out of all the element's text. A log read on another origin could be filed
  under an item with the page toggle off. A date before the clock read differently by locale and
  is now year first. The slow save hint is cleared when the last slow save ends, however it ends.
  Two older gaps went with them: credentials in a nested URL with no query, and the masking
  marker taken for a child element, which dropped an element's own text from "Search for".
* From a fifth round, on those fixes. Narrowing where a relative URL may start, which had made
  the scan linear, stopped screening one after `:`, `,`, `|`, `#`, JSON's `\/` or another script,
  or with brackets in its path. The scan now takes each run of URL characters once and finds the
  URL's start inside it, under the old rule. A quoted style `url()` holding a parenthesis, as
  CSSOM writes a signed CDN URL, went unmasked. A long key judged whole could block the page for
  seconds, and is now judged by its two ends. A frame on a script URL with no file extension lost
  its position, and a frame is now told by its shape. Running text in another script before an
  e-mail address was taken for credentials and deleted.
* From a sixth round, which ran 604 log lines with planted secrets through the new scan and the
  two earlier ones, and 249 ordinary lines through the new one. The new scan masked 166 secrets
  an earlier one printed, and printed 25 that one had masked. A `(` or an `at` in prose was taken
  for a stack frame, which left digits after a colon outside the mask: a frame is now told by its
  whole line, and its position must hold both line and column. A path in front of an absolute
  URL hid that URL's credentials. A password with a letter outside ASCII was no longer stripped,
  in console text or in the picker. The indexes of a long array filled the key cache, so every
  key logged after one was judged again on every row. The missing file banner kept a stale item
  number after a discard, and a discard could hide the restriction banner. After these fixes the
  corpus prints 35 lines, all printed by the earlier scans of this branch too but one, which only
  the first of them masked (F20). The ordinary lines change as before: four intended masks and
  two over strips (F24).

**How it was checked.** `npm test` (97 tests, every golden byte for byte; each new test was run
against the tree before its fix, where it fails). Then three rounds in
headless Chrome for Testing 156.0.8078.4 with the real unpacked extension, each followed by an
adversarial review and skeptics: one for navigation and Screen (about 40 scenarios, among them
same document navigations, cross document ones fast and slow, the back/forward cache and pages
still streaming), one for redaction (React 18 and 19 forms, AMP markup, truncation and timings),
and one for the timeline. A fourth round re-ran all three against the fixes and reviewed their
diff. It confirmed the navigation and arm race fixes in every scenario, found that the banner
rule it was given cleared item errors on any URL change (the scopes under F4 replaced that rule),
and found the fourth round items above, all fixed. Every defect the rounds confirmed is fixed
above or listed below.
A fifth, shorter round re-ran the failed scenarios in Chrome and reviewed the diff of the fixes
after the fourth. Its banner, save, arm race and redaction scenarios passed, and the defects it
found in those fixes are listed under the fifth round above and fixed. The sixth was not run in
Chrome: it compared the scans line by line in Node, timed hostile input up to 1 MB (every case
under 100 ms but F22 and F23), and ran the panel's banner functions against a stub of the DOM.

A real side panel, the real Alt+Shift+C command and headed Chrome were never used. Headless Chrome
did not enforce the capture quota, so F14 was only ever seen with the quota refusal simulated.

### F5 to F25

The items the rounds above left open, finished for 0.5.0. They fell into three areas, each changed
in a copy of the branch, attacked by a verifier of its own, and repaired where the verifier found
a defect, then combined and checked again.

**The worker and the panel.**

* F5. A disarm with arms still landing also puts a stop in the page's queue at once
  (`background.js:245`), which the page runs at `document_idle` straight after every
  arm already sent there, so the cancel holds if Chrome stops the worker during the wait. In
  Chrome, with the worker stopped while a streaming page held the arm, the page ended with no
  overlay; before, it kept one with the button dark.
* F6 (CW9). A `cdr:check-tab` that fails is read as a tab nothing is known about, and `ready`
  catches a failed restore and a failed first `resolveTab`, so it always fulfils and broadcasts
  keep arriving (`sidepanel/panel.js:398`, `:1926`).
* F7. An arm drops out before it injects when a newer arm was asked for on that tab, and one
  replaced while it lands neither records nor announces itself
  (`background.js:180`, `:206`).
* F11. The panel adopts an arm from a `cdr:check-tab` answer only if its own armed state did not
  change while it asked (`sidepanel/panel.js:394`).
* F12. A disarm waits at most a second for arms still landing (`background.js:122`).
  If they have not landed, it queues a second stop behind them and answers once a stop the page
  runs at once has run, so a page still streaming its HTML gets its Screen in about a second with
  no notice, where it took three with one.
* F13. A capture message ends the arm only when the mode armed is the one that sent it, in the
  worker (`background.js:428`) and the panel (`sidepanel/panel.js:1740`).
* F14. Screen asks again, after the capture and any quota retry, whether a mode was armed
  (`sidepanel/panel.js:1150`).
* F15. One probe runs per tab at a time (`background.js:322`); a request that comes
  while one runs waits for the next. A URL change on an armed tab now costs two probe injections
  instead of four.
* F2's open choice is settled as capture and warn, and the function that held it, with the branch
  it could never take, is gone.
* `test/worker.test.mjs` and `test/panel.test.mjs` run the real worker and panel in `node:vm`
  against a model of the order in which Chrome runs injections and delivers messages
  (`test/support/`), so these rules have unit tests for the first time. Taking out any one fix
  fails its own test.

**The collector.**

* F8. The XHR bookkeeping lives in a `WeakMap` inside the collector
  (`content/collector-main.js:710`), so the page no longer sees it in `Object.keys` or
  `JSON.stringify`, and nothing is written onto an object that is not an `XMLHttpRequest`.
* F9. An `open()` over a request still in flight records that request as aborted, as an `abort()`
  of it is (`content/collector-main.js:769`); Chrome sends no event for it.
* F10, in part. A synchronous retry from `onreadystatechange` after a timeout or abort keeps its
  label, though Chrome replays the retry's `load` and `loadend` first, and an abort is recorded
  even when a page listener stops its events. What remains is listed below.
* F18. The collector judges names and keys with `isSecretNameIn`
  (`content/collector-main.js:169`), a copy of the shared name test that calls
  no method at all, and reaches its maps, `slice` and `exec` through natives taken at
  `document_start`. A page that replaces `String.prototype.split` or `RegExp.prototype.test` can
  no longer make a secret key read as harmless. A test runs the copy against the shared block over
  the same names, so the two cannot drift apart unnoticed.
* F22. `serialize()` keeps a character budget beside its node budget
  (`content/collector-main.js:21`): once more than 6 000 characters are certain to
  print, ten times the 600 kept, it leaves further members out, their names with them. The printed
  text is unchanged, and two hundred rows of ten keys of 100 000 characters take about a
  millisecond where they took 350.
* Found by the verifier and fixed: a record field left for later was looked up on
  `Object.prototype`, so a page that set `Object.prototype.fallback` hid every failed XHR; and
  object keys made of digits went uncounted by the budget.

**The template and the picker.**

* F16. An attribute name may hold a quote or a `<` and start with `=`, as the parser allows and
  `outerHTML` writes back, and such a tag is masked like any other
  (`content/picker.js:828`). A tag name with a `<` in it (`<div<1 …>`) is read
  from its last `<`.
* F17. The picked markup is masked only as far as it is kept, the opening tag and one `MAX_HTML`
  after it, cut where no tag and no textarea's text is open (`content/picker.js:894`).
  A 1.07 MB table took 84 to 90 ms to mask in Chrome 156 and now takes about 3 ms. A tag name no
  longer runs on through `<a<a<a…` in script text, which took seconds.
* F19. A void element over the limit is its opening tag with each value over 120 characters cut,
  and no closing tag (`content/picker.js:676`).
* F20, in part. In a message, a query or fragment with nothing in front of it, a path with path
  parameters, credentials wherever a URL starts (`shared/prompt-template.js:1080`),
  `\u0026` between parameters, `sid` and a redirect encoded twice are screened, and every URL
  loses the secret values of its path parameters (`:1123`). A `data:` URL's content is
  left alone. Of the 35 corpus lines that still printed a secret, 33 now mask; no line the base
  masked prints, and none of the 249 ordinary lines changes.
* F23. A parameter or attribute name, and a form field's name or id, over 400 characters is judged
  by its first and last 200, as the collector judges a key (`shared/prompt-template.js:977`).
* Found by the verifier and fixed: the first F16 pattern stopped reading a tag name holding `<`
  and a non letter, which printed that tag's attributes; a `data:` URL's payload was read as path
  parameters; and a bare `//` in ordinary text (XPath's `//ns:tag`) was taken for credentials.

F24 and F25 stayed as they were for 0.5.0, and F21 for the reason it gave. All three were fixed
for 0.6.0, in the next subsection.

**How it was checked.** `npm test` (148 tests, every golden byte for byte; each new test fails on
the tree before its fix). For the worker and the panel, each fix was driven in headless Chrome for
Testing 156 against the tree before it, to show the behaviour changed where the item says, and
the earlier suites were run again on the new tree: the scenario suite (194 checks), X1 to X8, B0
to B5c, D0 to D5 and the arm race runs (190), with no failure. The collector's verifier tried to
break host pages: XHR used every way, builtins replaced after load, hostile object graphs, and
timings. The template's verifier ran the 604 line corpus and 100 more lines aimed at the new code,
and timed hostile input of up to 1 MB.

The combined tree was then reviewed by someone who had not seen the code and run end to end in
Chrome for Testing 156 with the real extension: a page logging errors that hold secrets, failing
fetch and XHR requests with secret parameters, and a form with a password; Region, Element and
Screen; a sentence each; Copy. Every run gave three items in order, each file on disk, the log
under the right item, every planted secret masked in the prompt and in storage, no exception in
the page, the worker or the panel, and the page's own fetch, XHR and console behaving exactly as
they do without the extension. The regression suites passed again, as did fuzzing of 99 000 URL
lines and 8 000 picked subtrees against the base, with no regression. It found four defects in the
patches, fixed since, each with a test that fails before the fix: a cancelled arm whose file
Chrome read slower than the disarm's bounded wait landed after every stop and stayed, and now
stops itself; a frame with a `;jsessionid=` lost its position into the mask; a page path starting
with `//@` lost what came before the `@`; and three test comments still described listeners
added at the first `send()`. It also found an older one, fixed with them: an uncaught error
whose location held a masked value lost its line and column. And since F9 records an `open()`
over a request in flight, which a type-ahead can do on every keystroke, a full ring of failed
requests now drops one the page ended itself before a real failure.

### Everything else, for 0.6.0

What was still open after 0.5.0: every bug and risk under "Bugs and risks" that the subsections
above had not fixed (the remaining medium and low findings and the M items), F10 and F26 to F30
from the table at the end, and improvements 9 to 24. F20, F21, F24 and F25 were taken up with the
template and the collector. The new feature proposals were left out: they are new features, not
open items. Items that turned out to be fixed already are marked so. Line references point at the
`open-items` tree, version 0.6.0.

**The sheet and its files.**

* SS1, SS4, SS5 (improvement 14). Windows merge the sheet item by item instead of adopting it
  whole (`sidepanel/panel.js:2994`). Each item carries one stamp for its words and one for its
  intent and tick (`:1123`), and each field takes the newer copy. An item that left the sheet is
  remembered for ten minutes, at most 200 of them (`:32`), so a window that had not seen the
  discard cannot bring it back. A copy takes items off by id (`:1631`). The `document.hasFocus()`
  guard the review proposed was built first and dropped: in Chrome both panels reported focus, and
  each wrote its own words back over the other's in a loop. Focus now decides nothing.
* SS3. A removal of the stored sheet is ignored by a panel left open (`:3402`), which keeps showing
  its sheet, as one left open for a week does.
* SS7. The FILE MISSING reason sits with the item in the frame (`sidepanel/panel.html:97`) and says
  to untick or discard it, and unticking lifts the block. The flag is no longer stored: files are
  asked about at startup, on focus, when the panel is shown and with every copy
  (`sidepanel/panel.js:2742`). Chrome's own limit on how often it looks is F31.
* SS8, SS9, SS10, SS11, SS12. A failed save moves the selection only when the item in the frame is
  the one taken off (`:1346`). An item with a mode this build does not know reads as CAPTURE
  instead of stopping the panel (`:2899`). A change from another window is read from the change
  event and updates rows in place (`:1139`): one keystroke in one window cost the other no page
  read and no list rebuild, against one of each before. `tabId` is no longer stored (`:2764`);
  `title` stays, since the prompt reads it as the page fallback. Intent and toggles are written
  separately, each when it changes, and every panel listens for both (`:2856`, `:2882`).
* RO6, RO7 (improvement 15). A download record counts only when its file name is the item's path
  and this extension made it (`:2278`), for a discard, for trusting that a file exists and at copy
  time. In Chrome an id reissued to the user's own download was refused. RO7 is partial: a file
  whose download record Chrome has erased cannot be asked about (F45).
* RO9, UX8, UX9. After a blocked clipboard, "Clear these items" takes the copied items off the
  sheet and keeps their files (`sidepanel/panel.html:202`, `sidepanel/panel.js:3462`). Items left
  after a partial copy are ticked again, and the receipt goes when the next item arrives, unless a
  hand copy is still pending (`:1631`, `:1256`).
* RO10, partial. The weekly expiry deletes the screenshots of the sheet it drops, unless a panel in
  another window still shows it (`:3188`), and a panel closed during a save cancels the download and
  removes its file (`:3515`). A copy keeps every file its prompt names, on purpose (judgment calls
  below).
* SP6. File names are `<timestamp>_<mode>.png` and no longer carry the page's host and path
  (`:2234`).
* SP7 (improvement 21). Content scripts can no longer read the extension's storage
  (`background.js:184`), and the worker runs panel messages only for its own pages
  (`background.js:192`, `:822`). The panel adopts a stored sheet only through a field whitelist
  with caps, at most 500 items (`sidepanel/panel.js:2760`, `:2935`).
* SP10. The manifest sets `incognito` to `not_allowed` (`manifest.json:6`), so the extension cannot
  run in an incognito window, and the panel also refuses to capture in one
  (`sidepanel/panel.js:48`). Not run in a real incognito window: headless Chrome disabled the
  unpacked extension when incognito access was turned on.
* UX2 (improvement 17). A discard leaves the sheet in every window at once, and its files go six
  seconds later (`:31`, `:1427`). Undo, or Cmd or Ctrl+Z (in the description field only until
  something is typed there), puts the items back (`:1533`, `:1492`). The countdown pauses while the
  pointer or the keyboard is on Undo (`:1472`), a save that fails for a discarded item takes it out
  of the trash (`:1502`), and Undo after Discard all brings a hand copy's receipt back (`:1564`).
  Closing the panel within the six seconds deletes the files at once. Discard all moved to the far
  end of the sheet's own row (`sidepanel/panel.html:157`).
* SS6 (improvement 23). The prompt numbers items as the sheet does: the panel sends each ticked
  item's position (`sidepanel/panel.js:2445`), and the template uses those numbers when they rise
  strictly (`shared/prompt-template.js:2265`).
* Found by verification and fixed. An item discarded while Copy waited on the page read was in the
  prompt, and lost its file six seconds later; the set is now taken when the read returns
  (`sidepanel/panel.js:2436`). Copy asks about the files alongside the page read and waits up to
  150 ms for Chrome's answer only when there is no page to read (`:39`, `:2431`). An answer that
  comes after the prompt was settled is said on the receipt, numbered as the copied prompt numbers
  its items (`:2513`).

**The panel's interface.**

* UX3 (improvement 12). The banner sits in a live region that is never hidden, polite for notices
  and assertive for errors, and sticks to the top of the panel (`sidepanel/panel.html:27`,
  `sidepanel/panel.js:278`, `sidepanel/panel.css:169`). The receipt is announced through a status
  line (`sidepanel/panel.html:209`). In Chrome a failed save with the panel scrolled 353 px put the
  banner off screen before, and at the top now.
* UX4. A line under Copy says why it is disabled, rebuilt from the sheet on every change: a missing
  file, an item still saving, or nothing ticked (`sidepanel/panel.js:2560`,
  `sidepanel/panel.html:182`).
* M12. Selecting a row scrolls the list, not the panel (`sidepanel/panel.js:1095`). Six captures
  in a 360 by 700 panel left the document at 0 px each time, against up to 246 px before.
* UX5, settled, partial. Run in Chrome for Testing 156 with a real side panel, opened with
  `chrome.sidePanel.open` under a CDP user gesture, still headless: after a Region drag the field is
  the panel's active element, but the page keeps the keyboard, so typed characters go into the
  page's focused input. That makes it medium, as the review said it would be. The panel now says so
  under the field whenever it does not have the keyboard (`sidepanel/panel.html:103`,
  `sidepanel/panel.js:1205`). What remains is F44.
* UX7. A pointer click on a row puts the caret in its sentence; Enter on a row leaves focus on the
  row (`sidepanel/panel.js:1054`).
* UX11. The shortcut shown is the one Chrome has bound, read at startup and on focus, with a button
  to set one when none is bound (`:2627`). Copy declares its own shortcut
  (`sidepanel/panel.html:174`).
* UX12. The three contrast failures pass AA: 4.79:1 to 5.51:1 in the light theme and 5.09:1 to
  5.72:1 in the dark one (`sidepanel/panel.css:32`, `:721`).
* UX13. The mode buttons carry `aria-pressed` and Read prompt `aria-expanded`
  (`sidepanel/panel.js:347`, `:2673`). The row tooltip can be hovered and read, and Esc closes it
  (`sidepanel/panel.css:574`, `sidepanel/panel.js:3560`). A click on it reaches the row it covers
  half a second later and anywhere else only closes it, a double click selects a word, and any key
  calls a waiting click off (`:829`, `:892`, `:799`, `:803`). Why it waits is under the judgment
  calls.
* UX15, UX16. The gauge names what it measures (`REGION · PNG 1280×720`, `:721`), "collector" no
  longer appears in the panel, and the unused id, the default text never shown and the empty count
  element are gone.
* RO11, partial. The element chip counts the sheet's element items and shows 0, not the reload
  dash (`:2143`). The console and network chips show `…` until the first read of the tab in view,
  and again after a tab switch (`:317`, `sidepanel/panel.html:113`). They are read again when the
  panel takes focus, is shown, or has the pointer back, at most once a second
  (`sidepanel/panel.js:2153`), and an older reply can no longer overwrite a newer count. They stay a
  snapshot while the panel is left alone (F46). (Since 0.6.1 they follow the tab in view while the
  panel is open and shown, which fixes F46.)

**The worker, the overlay and capture.**

* CW2 (improvement 16). The overlay and the picker send the visual viewport's offset and scale, and
  the crop applies them (`content/overlay.js:657`, `sidepanel/panel.js:616`). At a 2x pinch panned
  to 150, 100 the crop was the area dragged.
* CW3, M1, PI20 (improvement 19). The overlay is a manual popover in the top layer
  (`content/overlay.js:159`), so a transformed `body` no longer moves it. It goes inside the modal
  dialog on top, found through focus, through open shadow roots and slots, and, when nothing has
  focus, by hit testing the open modals (`:255`, `:273`, `:316`). It follows a dialog closed,
  removed or opened while armed, and raises itself over a popover shown later, one in a shadow
  root within 15 frames (`:340`, `:376`, `:401`), at most 100 times per arm (`:40`). The picker does
  the same (`content/picker.js:2646`) and hides its own `::backdrop`, so a page rule cannot dim the
  screenshot (`:887`). Not fixed: a fullscreen element (F36) and a dialog in a closed shadow root
  (F37). (Since 0.6.1 both are handled, save the cases left in F36 and F37.)
* CW4. While a mode is armed the panel holds a port to the worker, and closing the panel disarms
  the tab (`sidepanel/panel.js:1749`, `background.js:921`). A port shut by a worker stop is
  reopened, after 100 ms doubling up to 2 s when it keeps shutting. A shortcut arm whose
  `sidePanel.open` fails is disarmed (`background.js:978`).
* CW6, CW7, CW11. The Web Store is told by its hostname and path (`background.js:67`). The overlay
  sets `touch-action: none` and ends a drag on `pointercancel` and `lostpointercapture`
  (`content/overlay.js:76`, `:549`). The unused `dpr` field is gone, the internal page pattern stays
  as a guard with a comment saying when it is reached (`background.js:61`), and a capture whose
  bitmap does not have the viewport's shape raises a notice (`sidepanel/panel.js:591`).
* UX14 (with the picker's half below). Region takes the keyboard: the first arrow places a
  selection, arrows move it, Shift resizes it, Alt steps by 1 px and Enter captures
  (`content/overlay.js:579`, `:603`). The panel hands the arrows and Enter to the page while a mode
  is armed and focus is not in a text field (`sidepanel/panel.js:3590`, `:3602`), so the keyboard
  works after clicking Region or Element, not only after the shortcut.
* TR13 was already fixed; the protocol header now also lists `cdr:collect` and the panel's port
  (`background.js:17`).
* F27. A region whose message arrives while another mode is lit is photographed with the notice
  that an overlay may show (`sidepanel/panel.js:1863`, `:3242`). Shown in the panel realm in Node;
  the 25 ms window was not reproduced in Chrome.
* F28. Each `start()` of the overlay and the picker has a run id that its messages carry, and a
  late message from an earlier run no longer ends a newer arm of the same mode (`background.js:905`,
  `sidepanel/panel.js:3283`).
* F29. Every disarm queues `content/stop.js` behind the arms already sent (`background.js:321`): a
  file, because Chrome reads files in the order they were asked for and a function can overtake
  them. The panel sends a disarm when `cdr:arm` rejects (`sidepanel/panel.js:1713`). The orderings
  are proven in the worker realm, since Chrome cannot time them reliably.
* Improvement 9. On a tab with no collector the panel asks the worker to start one
  (`sidepanel/panel.js:2089`, `background.js:478`). The worker first asks whether one is running,
  from the extension's world by an event a 0.6.0 collector cancels and in the page's world by the
  global 0.5.0 set (`background.js:530`, `:813`), and when one answers it injects only a bridge, so
  a log kept since page load survives a reload or update of the extension. A collector it starts is
  told it started late (`background.js:515`) and says so in every snapshot
  (`content/collector-main.js:151`). The panel then says "Collecting from now", and after ten
  seconds "Collecting since 21:05", with the date when that was another day
  (`sidepanel/panel.js:2015`, `:2029`); the prompt says when collection began. A collector is
  started only where the manifest's `content_scripts` would have started one: matches,
  exclude_matches, include_globs and exclude_globs are read as Chrome reads them, which a probe
  extension confirmed on 1350 of 1350 pattern and URL pairs (`background.js:545`, `:656`, `:765`).
  A site counts as declared when Chrome would run the collector on some URL of it, judged on the
  URLs the rules themselves suggest, each wildcard left empty and filled with a letter no exclude
  holds, written as Chrome writes them (`:579`); a pattern's path is escaped as Chrome escapes a
  URL's, which the last check confirmed on 7141 manifest variants at 60 URLs. An include glob that
  names a scheme is not tried as a path, so that a host glob (`*://*.example.com/*`) declares no
  other site; `*://*app*` then declares a site only at a URL that already matches it. On a site the
  manifest leaves out nothing is injected, not even the probes; on a declared site's undeclared
  path a running collector is bridged but none is started (`:491`). The panel words the two cases
  apart (`sidepanel/panel.js:2044`, `:2047`). A slow start reads as a timeout and not as a refusal,
  and a late refusal is shown at once.

**The picker.**

* PI4, PI5, PI12, SP8 (improvement 10). While armed, mouse presses and clicks are cancelled, and
  pointer, touch and capture events are stopped (`content/picker.js:1927`). Every handler ignores
  untrusted events, so a page script can neither force a pick nor have its own events swallowed
  (`:2098`, `:2149`). The pick is made on a trusted `pointerup` of a press that began while armed,
  at the release point (`:2148`, `:2176`), so a disabled control is picked and a node replaced
  under a still pointer is the new one. After the pick, presses, a double click's later presses and
  Enter's repeats are kept from the page for a second, each press until its release and for at most
  five seconds (`:598`, `:602`, `:2777`, `:2839`). A right press no longer selects a word, and
  select all still works (`:2114`).
* PI6 (improvement 20). While picking, frames let the pointer through to the page, by a constructed
  style sheet adopted into the document and into each open shadow root that holds a frame
  (`:2427`). It is put back on every frame and at every press when the page replaces its list
  (`:2454`, `:2462`), and emptied when picking ends (`:2475`). A frame is picked whole and never
  receives the press, and a menu drawn over it keeps its hover. Where the pointer is inside a
  frame's box, one hit test with the sheet off says what is drawn there, and elsewhere nothing is
  restyled (`:2025`). That hit test also finds an `<object>`'s fallback content, and the frames are
  looked for again at a press, so one put in just before it is picked. Only a frame whose own CSS
  beats the sheet gets a shield (`:2514`). Picking inside a frame is not done.
* PI7, partial. The pick descends through open shadow roots (`:1987`), the selector joins one path
  per tree with ` >>> ` (`:985`), and the collector finds the marked node there and reads its
  component (`content/collector-main.js:3790`). A closed shadow root still yields its host (F37).
  (Since 0.6.1 the pick goes inside a closed root too, and its component is read through the host.)
* PI10, M5 (improvement 22). The element is read and photographed the moment it is picked, with the
  pointer over it, and the payload says when it matched `:hover` (`content/picker.js:2882`); the
  prompt then says "Styles and screenshot show it hovered." (`shared/prompt-template.js:1203`).
  Reading after taking the hover away was built first, and broke every element that exists only
  while hovered (how it was checked, below). Props come from the fiber on the current tree
  (`content/collector-main.js:3031`): six renders on React 18.3.1 printed six fresh values, where
  every other one was stale before.
* PI13 was already fixed by F19 (`content/picker.js:1111`). PI14: an arm no longer clears the flag
  that a page has no collector, and one `ping` clears it once a collector answers (`:836`). PI15:
  the payload no longer carries `tagName`, `classes` and `inlineStyle` (`:2882`). PI18: each level
  of the selector is tested for being unique, up to eight, and a long selector loses ancestor
  classes before any level (`:985`, `:1017`).
* UX14, picker half. Arrows step to the parent, the first child or a sibling, and Enter picks. With
  nothing highlighted it starts from the focused element, or from the first element in view that is
  drawn where it stands (`:2258`, `:2303`, `:2332`).
* F26. The opening tag scanner reads each run of attributes once (`:1664`): picking an element
  holding 100 kB of `<a <a="1"…` script text took 57 ms in Chrome, against 1360 ms.
* Redaction, found by verification and fixed: the value of any element whose type is password, a
  custom element included (`:1259`); `data`, `codebase`, `cite`, `background`, `longdesc`,
  `manifest` and `imagesrcset` (`:1197`, `:1204`); an iframe's `srcdoc`, hidden whole when anything
  in it would be (`:1590`); each value judged as the page set it, so JSON in a link that the markup
  writes with `&quot;` is screened (`:1230`); JSON with a raw `&` in a URL value (`:1330`); and the
  secret keys of JSON and of JavaScript object literals in any attribute (`data-props`, Alpine's
  `x-data`), masked where they stand with the rest printed as the page wrote it (`:1411`, `:1502`).
* A reload of the extension while armed no longer leaves the old picker or overlay holding the
  page's pointer: each ends itself within a frame once its extension context is gone (`:2230`,
  `content/overlay.js:405`).

**The collector and its bridge.**

* CO4 (improvement 18). Thirty frames are captured (`content/collector-main.js:1208`), and frames
  of known libraries and of compiled async helpers are skipped by path, name and shape (`:1310`,
  `:1320`, `:1333`, `:1396`, `:1484`): axios in development and UMD bundles, TypeScript's
  `__awaiter` and `__generator`, Babel's regenerator (7.27's included), SWC's `_ts_generator` and
  esbuild, each checked against real compiler output. A compiled async body prints once, under its
  function's name.
* CO7, CO8, M3, TR12. Resource URLs, methods and status texts are truncated (`:1015`). Console text
  applies the console's own substitutions (`%s`, `%d`, `%o`, with `%c` dropped), and an Error
  prints its header once (`:859`, `:895`, `:578`). A failed resource is found by `currentSrc`,
  `href.baseVal` or `data` (`:1015`). The bridge no longer collects the user agent and the scroll
  position (`content/collector-bridge.js:234`).
* CO9 and CO10 were already fixed.
* CO11 (improvement 21). The bridge rebuilds every reply from known fields, with rings capped at
  30, strings sliced and numbers required to be finite (`content/collector-bridge.js:208`).
* CO12. `serialize()` walks the value itself (`content/collector-main.js:633`): a getter prints
  `[Getter]` and is never called, `toJSON` is not called, and only three proxy traps run. For plain
  data the text is byte identical to before, over 160 000 fuzzed values.
* CO14. Every wrapper is a Proxy of the native with an apply trap only (`:956`), so its name,
  length and prototype are the native's, and `window.__cdrCollector` is gone. The bridge reads the
  log over a channel of its own, named with 128 random bits, instead of `window.postMessage`
  (`:3922`, `content/collector-bridge.js:91`). The natives the channel uses are taken at
  document_start, every event it sends is built from a dictionary with no prototype, and every
  recorded entry defines its fields as its own (`content/collector-main.js:76`, `:91`, `:209`), so a
  getter or setter a page plants on a prototype learns nothing. The collector listens on at most
  eight channels, the newest live (`:3926`). What a page written against the extension can still
  do is F32.
* M4, partial. The prompt labels a request the page's CSP blocked as such and keeps the page's
  caller (`:1119`, `:1141`); the browser's reports still name the extension (F47).
* PI2, PI9, PI16, PI21 (improvement 11, collector half). The owner is sent when it is the component
  itself (`:3182`). A call site read from `_debugStack` is marked so (`:3203`). Handler text is left
  out when it has a shape only a minifier writes, and member calls off `this`, `window`, `document`
  or `self` count as readable (`:3275`, `:3361`, `:3419`). A folded `XProvider` prints the
  component's props (`:3100`).
* Props that could hold a password, found by verification and fixed. When a component is read, the
  collector reads the live values of the document's secret controls (type password, an autocomplete
  for a password, a one time code or a card number, or a secret name or id, hidden inputs
  included), at most 32 of each kind (`:2298`, `:2385`, `:2481`), and withholds any string prop
  that equals one, contains one, or covers half of one (`:2515`). A component that renders a
  control taking a password, a code or a card's digits, known by its type or autocomplete, also
  withholds a string shaped like one: 8 to 256 characters with no whitespace holding a letter and a
  digit, or beside a code or card control three digits or more (`:2550`). Names that point at
  another element (`aria*`, `data-*`, `_id`, and any ending in `Id`, `UUID`, `For` or `By`) are
  exempt, and so are paths, URLs (`blob:`, `data:` and `mailto:` ones too), dates and months, which
  are checked before the digit rule. `value`, `defaultValue` and `modelValue` stay withheld on a
  component that renders such a control, a custom element with `type="password"` or an input one
  level into its open shadow root included (`:2585`, `:2762`), and the walk follows Vue's Suspense
  (`:2716`). The titles, totals and steps of login and checkout forms print again. What it cannot
  see is F48.
* F10. A request that ends with status 0, or 400 and above, is also settled from its
  `readystatechange` to DONE, one task later, in case its `loadend` never reaches the collector,
  and a status 0 end that lasted the request's timeout is labelled as one (`:1947`, `:2072`). What
  remains is in the table.
* F21. A key is judged whole, and only when its value would still print (`:502`).
* F30, partial. With no `JSON.stringify`, a sparse array of ten million slots takes 0.3 ms instead
  of 613, and 4 000 String wrappers 0.03 ms instead of 1 000 (`:633`). What remains is in the table.
* Late starts, found by verification and fixed. The collector no longer uses the page's Promise or
  its `then` (`:1605`, `:1632`), so fetch works on zone.js and Bluebird pages. On a zone.js page it
  takes `setTimeout` and `addEventListener` from the natives zone.js kept (`:1845`). It wraps only
  what is still a function where it expects one, and nothing in its setup throws into the page
  (`:967`, `:982`, `:1040`), so pages using xhook keep working. A fetch promise the page decorated
  (`p.abort`) is handed back as the same object and watched on a side chain (`:1671`). What
  remains is F35, F42 and F49.
* A fetch refused for its own arguments (a body on a GET, credentials in the URL) is recorded as
  never sent (`:1692`) and prints as `NEVER SENT` with the browser's reason and no duration
  (`shared/prompt-template.js:518`, `:657`).
* Console cost, found by verification and fixed. Chrome reports a console message whose top frame
  is a `chrome-extension` URL in detail, and every page `console.error` and `console.warn` reached
  the native from the wrapper: 2000 calls took 279 ms with the extension against 7 ms without it,
  and 1727 ms from 30 frames deep. The collector now declares
  `//# sourceURL=punch-list://extension/collector-main.js` (`content/collector-main.js:4075`), and
  the same calls take 6 ms and 7 ms. Its costs are under the judgment calls.
* The failure paths no longer call builtins a page can replace, nor the page's
  `Error.prepareStackTrace` (`:197`, `:1272`).

**The template.**

* PI2, PI8, PI9, PI11 (improvement 11, template half). The call site says "inside its own
  definition" when the owner is the component (`shared/prompt-template.js:778`). A long selector is
  kept from the right, whole steps first, then the element's trailing classes, with a note saying
  what was left out and when it now starts inside a shadow root (`:1093`, `:1109`). A call site read
  from a stack is labelled so, and the prompt says once that positions in frames are not mapped
  back to the source (`:290`, `:251`). React 19.1 and 19.2 ids and dashed UUIDs are no longer
  offered as search targets (`:960`).
* PJ5, SP2, PJ15 (improvement 21). One sentence marks everything taken from the page, the
  screenshots included, as evidence to weigh and not instructions (`:251`). The title and style
  values go through `clip()` (`:340`). Every report field is normalized before use, so a malformed
  or forged value is taken as absent (`:2284`).
* PJ8, PJ9, PJ10, PJ13. The CSS Module hint offers the stylesheet's stem as a search target
  (`:1004`). Pages are counted as they print (`:1881`). Times read `YYYY-MM-DD HH:MM:SS` with the
  zone, built by hand with no locale (`:361`, `:368`, `:380`), and with the page toggle off one line
  gives the zone and the day (`:436`). PJ13 was already fixed; a status text that is not a string
  now also leaves single spaces.
* PJ12. `tools/preview-prompt.mjs` renders every golden sample by name, from the samples the tests
  use (`tools/preview-prompt.mjs:282`).
* PJ17, PJ18. The closings name only the evidence that printed, and a change request is told what
  to do with a defect the evidence shows (`shared/prompt-template.js:215`). In a list the shared
  block is headed "Page when the report was copied", or "Page the last item was captured on" when
  nothing was read (`:2206`).
* RO3, SS6. With the page toggle off, a log read elsewhere or after a reload keeps its caution
  (`:2123`). Items are numbered as the sheet numbers them (`:2265`).
* Late starts, lists and cautions. A log that started late says collection began after the capture
  instead of claiming a reload (`:1957`), a list's first item reads "Logged since collection began,
  before this capture" (`:2062`), a caution names a screenshot only when there is one and speaks of
  one item in the singular, and entries with no time print under a heading of their own (`:2517`).
* F20, F24, F25. JSON in a parameter, raw or percent encoded up to five times, is masked when one
  of its keys looks secret by the parameter name rule (`:1352`). A `data:` URL's content is decoded
  layer by layer and masked when a link in it carries a secret, or when it is still encoded past
  four layers (`:1632`). An encoded scheme is found after any escape (`:1690`). A user name made
  of words (`git@`, `jane.doe@`) is kept and a token is stripped (`:1314`, `:1339`). A Firefox
  shaped frame keeps its line and column only when a line next to it is a frame too (`:1738`,
  `:1761`). Decoding checks for valid UTF-8 before it calls `decodeURIComponent` and has a fast
  path for plain escapes (`:1479`, `:1490`, `:1509`): a megabyte of invalid escapes went from about
  300 ms to under 75. What F20 and F24 leave is in the table. (F20 was finished in 0.6.1; what
  F24 leaves is F52.)

**Tooling, release and docs.**

* TR1 and TR3 were already fixed: v0.5.0 was released, and the goldens are the stored baseline.
* TR4, TR7. `tools/release-check.mjs` makes every release decision (`tools/release-check.mjs:58`).
  A push to `main` or a manual run releases a version that has no tag or no release, a pushed tag
  releases its commit, and a change to what a tagged version ships fails with a request to bump the
  version, including a change made by widening `INCLUDE` (`:173`). CI runs the same check on pull
  requests into `main` (`.github/workflows/ci.yml:37`).
* TR5. The zip's deflate streams are written by `tools/deflate.mjs` instead of `node:zlib`
  (`tools/deflate.mjs:262`), and each is inflated back to check it. The same tree now gives one
  checksum on Node 20, 22 and Homebrew's Node 24, where it gave two.
* TR2, TR6, M11. Before writing anything the build checks for LICENSE, every injected script, every
  `panel.html` reference and that every script parses, and checks every import by linking the
  modules in V8 without running them, named exports included; a dynamic `import()` must be a
  written path in a module it links (`tools/build.mjs:574`, `:512`, `:400`). In a git checkout it
  packs only tracked files, says what is untracked or edited, and refuses a file in an unresolved
  merge conflict (`:208`, `:277`). The zip carries LICENSE (`:65`).
* `.gitattributes` converts exactly the files the build packs as text, so an image added to a
  shipped folder is committed intact (`tools/build.mjs:77`), and the tests pass on a CRLF checkout.
* TR8, TR9, TR10. The stage keeps download records across a reload of the panel frame
  (`tools/chrome-shim.js:33`). `docs/ARCHITECTURE.md`, under "Running the panel outside Chrome",
  lists what the stage does not reproduce. The media scripts' setup notes are corrected.
* SP3, SP11, SP12, PI17. The restriction recipe was run both ways in Chrome for Testing 156, and
  the README gives the result. The `activeTab` sentence points at its section. `PRIVACY.md` is new.
  PI17 was already right in the README and the preview.
* TR11 is not fixed (F53). (The owner has since set the repository's description and homepage.)

**How it was checked.** Each area was implemented in its own copy of the branch, each fix with a
test that fails on the tree before it, and the seven copies were then combined. Three rounds of
adversarial verification followed, in headless Chrome for Testing 156.0.8078.4 with the real
unpacked extension and in Node, each followed by a fix round held to the same rule for tests. The
first round found 55 defects (2 high, 13 medium, 40 low), the second 47 (1 high, 11 medium, 35
low) and the third 49 (1 high, 10 medium, 38 low). Each round found them in the code the round
before had written, or in older edge cases further out, and the older share grew: 16 of 55, 24 of
47, then 31 of 49. The highest:

* Round one, high: an element that exists only while hovered (a CSS or JavaScript hover menu, a
  React menu unmounted on mouseleave, a row action) was read and photographed after a catcher layer
  had taken the hover away: a 4 by 4 crop at the top left, opacity 0, no component, a blank
  screenshot. The catcher is gone, and the element is read at once.
* Round one, high, also in 0.5.0: a typed password printed in props when a component set the
  field's type itself, as a `PasswordInput` rendering `<input type="password" value={value}>` does.
* Round one, medium, found by three verifiers: after any reload or update of the extension, a tab
  whose collector held the whole log since page load was reported as a late start, in the panel and
  in the prompt, because the worker probed for the global the collector no longer set, and the unit
  test planted it.
* Round two, high: after a late start every `fetch` threw on zone.js and Bluebird pages, because
  the collector had taken `then` from the page's Promise.
* Round three, high, also in 0.5.0: the live password printed when the user picked a component
  that was handed it without rendering the field, such as a strength meter or a rules list.

A regression check of the last fix round followed: four checkers in Chrome, each asked only whether
that round's fixes held and whether anything that worked before had broken. They found 5 new defects
(1 medium). A component that renders a password control printed a secret handed to it under another
name when no control held it, such as a confirm field handed the first password after the step that
held it had unmounted. The site check refused a running collector after a route change when an
include glob had no slash before its text (`*app*`). Frames were picked by their box rather than by
what is drawn there, and one past the first hundred could not be picked at all. And after a late
start, a page whose `fetch` returns a Bluebird promise or another thenable no longer reports its
unhandled rejections, which is kept (F49). A fourth fix round took the rest, each fix followed by an
adversarial check of that fix alone, and those checks found 12 defects in the fixes and around them
(5 medium, one of them older). The shape rule also fired beside fields known only by a secret name,
hiding the ids of every shipping and profile form, and it missed every secret made only of digits;
the frame test modelled clipping by hand, and so passed over fixed frames, frames under an overflow
the viewport takes from `body`, and an `<object>`'s fallback frame. All three were redone by hand:
the shape rule is keyed on password, code and card controls known by type or autocomplete, with a
digit rule beside the last two; the site check asks Chrome's own rule about URLs the manifest's
rules suggest; and the frame test asks the browser itself, once, and only where the pointer is
inside a frame's box. A last check by three skeptics then found 2 medium and 10 low defects in
those. A date beside a card field was withheld, because the digit rule ran before the exemptions. An
exclude that took out the few URLs the site check tried (the root, a pattern's own path) lost a
running collector that the round before had bridged. Among the lows, a pattern's path was not
escaped as Chrome escapes a URL's (`café`, `a"b`), and the picker's rule giving an `<object>`'s
fallback the pointer back beat the page's own `none` and slowed every restyle by about a quarter (a
slowdown that did not reproduce for 0.6.1, where the rule measured no restyle cost; it stays removed
because it cuts off a `none` the page sets above the object). All but one were fixed, each with a
test that fails on the tree before it (the one left was in F50: a frame with a discrete
`pointer-events` transition, fixed in 0.6.1), and the checkers' own Chrome scripts were then run
again on the result. Every props case they built prints or withholds as documented. The worker's
matcher agrees with Chrome on all 7141 manifest variants at 60 URLs, the ten site cases bridge the
running collector, and of the 878 rows where the site check had lost one, 56 remain, all of one
stated limit: an include glob that names a scheme is not tried as a path (`*://*app*`). Every picker
case picks what plain Chrome's hit test finds, save the stated limits (a closed shadow root, handled
since 0.6.1, and a frame past the 2,000th), and a move over a frame costs 13.9 ms at 100 000
elements, down from 17.4, with a page's own restyle while picking as fast as without.

`npm test` passes 529 tests in 12 files, every one of the 28 goldens byte for byte. A real side
panel was used once, headless, for UX5; headed Chrome and the real Alt+Shift+C command were not.

**Judgment calls.**

* **The build's own deflate encoder** (`tools/deflate.mjs`) rather than a stored zip. A stored zip
  is reproducible with no compressor at all, but the 16 shipped files come to about 690 kB stored
  against about 220 kB deflated. The cost is 356 lines of compression code the project now owns;
  node:zlib reads every stream back, so a fault fails the build instead of shipping.
* **Release on a push to `main` at an untagged version, and a CI version job on pull requests.**
  0.3.0 and 0.4.0 were never released because bumps went untagged (TR1); now merging the bump is
  the release. The cost: every change to a shipped file needs a version bump in the same pull
  request, and a merge to `main` publishes with no further step.
* **Getters printed as `[Getter]`.** Calling a page's getter because something was logged runs page
  code the page did not ask for: a lazy getter computes, a framework records a dependency, a
  throwing one lost the whole line. The cost: an object whose members are accessors, as Vue 2's
  reactive data are, prints `[Getter]` for each instead of its value.
* **The weekly expiry deletes the screenshots of uncopied items.** No copied prompt names them, so
  they are only clutter (RO10, lead 6). The cost: a screenshot of an uncopied item that the user
  kept for something else goes after a week. Screenshots of copied items are never deleted, and a
  panel in another window that still shows the sheet keeps it all.
* **Copy waits for Chrome's file answer only when there is no page to read** (`FILE_ANSWER_MS`,
  150 ms). A fixed wait cost every copy 120 ms and still missed deletions Chrome had not looked for;
  with a page to read, Chrome's answer (0.3 to 30 ms) almost always comes during the read. The
  cost: a copy on a restricted tab takes about 160 ms instead of under 10, and a copy whose page
  read beats Chrome's answer still names the file and says so on the receipt.
* **The collector's script address, `punch-list://extension/collector-main.js`.** It removes the
  console cost above, and stacks the page can read no longer carry the extension's id. The costs:
  error monitors that drop errors whose top frame is a `chrome-extension://` URL no longer drop a
  page error thrown through a wrapper (a page's own `xhr.open('GET')` TypeError); CSP violation
  events and reports give `punch-list` as the source; and with source maps off DevTools links
  relayed lines to `collector-main.js`. A bare relative name was rejected, since it left the CSP
  source empty and could pass for a page file.
* **Frames pass the pointer through a constructed sheet while picking.** Shields over frames took
  the hover from menus drawn over a frame, and a cross site frame tells the parent nothing when the
  pointer enters it, so a shield switched off at that moment comes too late. The cost: page scripts
  can see the sheet in `adoptedStyleSheets` while picking, a frame whose own CSS beats it keeps a
  shield (since 0.6.1 only an inline `!important`, a layered `!important` or one of more than eight
  ids does), under which a menu still loses its hover, and while the pointer is over a frame each
  move restyles the page once (28 ms at 100 000 elements), so that the browser, rather than a model
  of clipping and stacking written by hand, says what is drawn there.
* **Passwords withheld by value.** Withholding every string and number prop of a component that
  renders a secret field hid the titles, totals and steps of every login and checkout form, and
  still printed a password handed to a component that renders no field. Matching the live values of
  the document's secret controls withholds the password wherever it is passed, and judging strings
  by shape in a component that renders a password, code or card control catches what no field
  holds yet. The cost is F48 and about 3 ms more per pick on a page of 60 000 elements.
* **The tooltip's click through, with its 500 ms wait.** The tooltip can be hovered and read
  (UX13), so it covers the row above, and a click there must still reach that row while a double
  click selects a word. Half a second is the default double click time on macOS and Windows. The
  cost: a row picked through its tooltip changes half a second after the click, and F41. (Since
  0.6.1 the wait grows to the user's slowest double click seen in the panel, up to one second.)
* **No probe at all on a site the matches leave out, and probing only on a matched site's other
  paths.** A page that answers the probe gets a bridge and can put lines of its own in the log, so a
  site the user kept the collector off gets nothing injected. On a declared site, a single page app
  that moved off a declared path keeps the log its collector started with. The cost: on such a
  path a page can answer the probe and learn the extension is installed (F32), and on a site left
  out a collector still running from before the matches were narrowed is not read.

### The table, for 0.6.1

What was asked: every row of the table at the end as 0.6.0 left it (F10 and F20 to F59), in nine
areas (the URL scan, the word lists, the panel, the live chips, the wrappers, the natives, the
picker, the overlay, the build), and CI on the Node lines still supported. Line references point at
the 0.6.1 tree.

How it was checked. Each area was fixed in its own copy of 0.6.0, each fix with a test that fails on
the tree before it, and checked in headless Chrome for Testing 156.0.8078.4 with the real unpacked
extension; the nine were then merged (`eec92cf`). Six checkers took the merged tree apart by area,
in Chrome and in Node, each asked whether its fixes held, whether the claims made for them were
true, and whether anything that worked in 0.6.0 had broken. They found 34 problems (7 medium, 27
low), 23 of them marked regressions against 0.6.0: 21 in code, plus the docs, which had not been
brought up to date yet, and the version, which still said 0.6.0. A second round took every finding
in code under the same rule for tests, and reverted one fix (F50e) whose side effect was worse than
the shift it removed. A final check of that tree (`d5b082e`) in the same six areas found 24 problems
(4 high, 2 medium, 18 low), 17 of them regressions against 0.6.0 that the rounds had brought in. The
four high ones: picking a link whose `href` is a megabyte `data:` URL froze the page for 0.7 s, keys
with a `u` or `b` prefix (`{u'token': …}`) printed again, a trim of a long ring in quadratic time
froze a page for 1 to 11 s at its next console call, and file opens blocked on a volume that stopped
answering used up Chrome's file threads across the whole browser. A third round fixed 19 of them
with small changes, each with a test that fails on the tree before it, left two documented with
their measured cost (F68, and the shadow walk in F48), and answered the three about the disk check
by taking it back to 0.6.0's behaviour (F31, F45). It also fixed F67, found while these docs were
checked against the code. A confirmation run reran every reproduction script of both checks on that
tree (`c72b712`): of 65 findings, 46 were gone, 17 were the documented limits, and 2 could not run
(the disk check's, whose code was taken out). It found 6 new problems in the third round's small
changes (1 medium, 5 low, 4 of them regressions against 0.6.0). Three more rounds followed, each
checked in Chrome by rerunning the scripts of the check before it, and each fix again with a test
that fails on the tree before it. The fourth round fixed the six (`3878b9f`). A check of that tree
found 9 low problems, 8 of them distinct; the fifth round fixed six, widened one fix and documented
the last (`a811414`). Rerunning those scripts showed that the fifth round's survey change brought
back the third round's cost on pages of many `content-visibility: auto` frames (high) and that a
card's digits run together in a sentence printed again (low). The sixth round fixed both
(`27c09c6`), and a last rerun of those two checkers' scripts confirmed both fixes and found nothing
high: three low edges of the sixth round's own (the cost of its card search, in F48, and two survey
edges, in F50) and a cost 0.6.0 already had (F71). The loop stopped there (see Judgment calls).

`npm test` passes 648 tests in 12 files on Node 22.21.1 and 24.10.0 (529 in 0.6.0), with every one
of the 28 goldens byte for byte; seven goldens gained F56's two lines.

**Claims the checkers proved false.** Each was a claim made for a fix of the first round, or a row
or document of 0.6.0, and each is now true or withdrawn.

* F36's row said the overlay was drawn under a fullscreen element. It was drawn above it, inert, so
  every press reached the page. The first fix then reloaded an `<object>` on every arm, moved
  `:last-child` layouts, fired `slotchange`, had no box in a component with no default slot, and its
  "armed before or after" failed for the body. All five were fixed (below).
* F51's first fix said a root attached after the arm is found within a quarter second. Its walk went
  from the start of the page, so a toast appended last to a page of 30 000 elements was missed, and
  walking every fifteenth frame cost 2 to 20 times what 0.6.0 spent. Replaced (below).
* F50e's first fix put the picker's host after `body`, which took `:last-child` from `body` itself.
  Reverted. F50f's first fix held discrete transitions for the whole arm, which cut the page's own
  fade of a frame short, so its `transitionend` never ran. Now held only at the picker's moments.
* F31 and F45's first fix called a file it could not read missing, had no time limit (Copy stayed on
  Copying), and listed a folder once per missing item (5,272 ms for 20 in 10,000 files). Fixed in
  the second round, and then taken back with the rest of the disk check (below).
* F46's first fix said a page cannot hold back the bridge's counts. That holds only on a declared
  start, and one lost signal froze the chips where no read could correct them. Fixed, and the late
  start case is stated (F32).
* F48's first fix said shadow roots are searched at any depth. It looked into no nested root once
  the light DOM held 512 hosts, and its edit rule withheld numbers and month labels one character
  from a short secret. Fixed.
* F20 and F40's first fix took 823 ms in Chrome for a megabyte page URL, counted any quoted word
  before a colon as a JSON key, and screened text it joined across an apostrophe more weakly than
  the parts. Fixed. F40's row was itself wrong: request and page URLs do carry a raw `&` in JSON.
* F52's first fix measured its cost on first names only, and stripped `armstrong@`, `jschmidt@`,
  `pgsql@` and `httpd@`. Fixed with letter groups.
* F54's first fix said the build finds every dynamic import. A comment ended by U+2028 or a lone CR,
  or an HTML like comment in a content script, hid one; `#import` was read as one; and Node 24
  passed phase imports Chrome refuses. Fixed. Its time limit on the import check treated a symptom:
  `spawnSync` input stalls on macOS (7 of 2,880 children). Fixed by taking input from files.
* F59's first fix killed only the `git` or `gh` it started, not their children. Fixed, on CI.
* F39's kept row said a page listener added before the arm on a tab with no gate still has its
  press's default action cancelled. A listener that calls `stopImmediatePropagation` keeps the press
  from the picker, and a link is followed. Documented; not fixable for such tabs.
* F37's first picker fix reached into closed roots but lost the component and handlers 0.6.0 gave
  through the host, and wrote its marker inside the closed tree. Fixed: the host is marked and read.
* `docs/ARCHITECTURE.md` said a wrapper's `toString` reads as the native's (F34 says otherwise), and
  that giving an `<object>`'s fallback the pointer back slowed every restyle by a quarter, which did
  not reproduce. Both corrected.

**Claims the final check proved false.** Each was made for a fix of the second round, and each is
now true or withdrawn.

* F50f's hold was said to come only at the picker's own moments, so that the page hears no
  transition of `pointer-events`. It also came when the sheet went back after the page dropped it,
  which fired `transitionrun`, `transitionstart` and `transitioncancel` on every frame in that tree:
  a page that reset its own lists every animation frame heard 363 events in a second, against 6 in
  0.6.0. The sheet now goes back with nothing held. Its open item said only that every survey reads
  the first 100 frames; a frame past them was not held at the arm, where a press right after it went
  into the frame in 2 of 3 tries. Every frame found and drawn, up to 2,000, is now asked, and one
  not drawn is asked once it is (rounds four to six, below).
* F51's walk was said to cost within 1.4 times 0.6.0. That held for quiet pages. On a page that
  changes its light DOM, every known shadow root was queried at every look until the next walk, 10
  to 13 times 0.6.0 with closed roots, and the walk was gated by frames, so 120 Hz doubled it. Now
  only the roots that held a popover or a dialog are queried, and the walk runs at most once a
  second by the clock. Such a page still costs about three times 0.6.0 with closed roots (F69).
* F36's overlay was said to keep presses and clicks from the page inside a fullscreen element, and
  to work in a fullscreen component's shadow root. A misclick inside a fullscreen element nested in
  a link, a label or a form's button followed the link, toggled the box or submitted the form, which
  0.6.0 did not do. A component whose own CSS says `* { pointer-events: none }` left the host drawn
  while every press went through (0.6.0 could not be used there either). Clicks on the host are
  now cancelled as well as stopped, and its inline style sets `pointer-events`, `visibility` and
  `opacity`.
* F46 was said to tell a change it could not tell with the next entry, and every read was said to
  set the chips right. A ring filled during a stack overflow never told again while it stayed full,
  and on a late start a page that sent the change event itself could make the bridge drop the
  panel's port, after which no read moved the chips. Both fixed.
* F48's shadow walk was called bounded. It is bounded in roots, in the elements asked for roots and
  in the controls read, not in the elements a root's selector looks at: 512 roots of 2,000 elements
  took 58.9 ms a pick. Now said so (F48).
* F54 was said to check every dynamic import, and phase imports to fail the build on every Node. A
  match that started at an earlier `import` hid a real `import()`, and a static phase import in a
  module nothing imports built clean on Node 24. Both fixed.
* F59 was said to leave a call that Ctrl+C left running to finish or reach its limit on its own. It
  ran on with nothing to enforce the limit. Fixed: only CI starts a call in a group of its own.
* The build was said to remove its temporary folder when each check ends. A build stopped by a
  signal left it behind, and a temp directory it could not use crashed the build with a stack. Both
  fixed; what a stopped build still leaves is F70.
* F31 and F45's disk check was said to hold back a deletion in folders of 200 to 2,000 files. That
  held only with the head start the test harness gave. Withdrawn with the disk check.

**What the confirmation run and the reruns found.** Each is about a fix of the third, fourth or
fifth round, and each is now fixed or written down.

* F48's card rule was said to withhold a card number one digit away however it is grouped. It did
  only when the prop was grouped as the field: `4111111111111111` beside a field holding `4111 1111
  1111 1111` printed whole (medium; 0.6.0 printed it too). The fourth round held each grouped
  number's digits beside the held values, which took two of the 64 places a pick keeps for them (a
  passphrase after 32 grouped numbers printed), read every string prop twice (18 ms a pick for a
  megabyte prop of digits), and found a four digit PIN in the joined digits of a reference number.
  The fifth works the digits out once a pick, for held numbers of 12 digits or more only, and
  compares them with props of 64 characters or fewer that hold nothing else, which let the digits
  run together in a sentence print again. The sixth looks for those digits in every prop as written
  as well, without the cap or the PIN problem. Its rerun found the sentence, JSON, URL and over 64
  character cases withheld again, as in the fourth round, and the cost of searching each prop twice,
  once for each held number as written and once for its digits: with 63 held card numbers and twelve
  1 MB props that hold none of them, a pick takes 511 to 581 ms against 245 to 282 ms in 0.6.0, and
  with one held card 7.0 to 7.9 ms against 3.1 to 3.5 (F48).
* The ring's one pass cut copied the whole ring onto itself on every push that ran out of stack at
  its first look: a sweep to a ring of about 132,000 entries took 39.3 s, against 33.3 s in 0.6.0.
  It now copies only after it cut something: 33.3 to 35.5 s, against 32.9 to 33.7 s in 0.6.0.
* W1-3's wider decode had its cost written down only for a value with no colon (`it%27s`, not
  decoded again). It decoded every value with `%27` or `%5C` and a colon, so a picked link of a
  megabyte of `q=it%27s:1&` took 158 to 172 ms against 64 to 75 ms in 0.6.0. The fourth round
  decoded only where a decode can make a key, which printed three shapes the third round hid (a raw
  `"token"%3A…`, an encoded URL with credentials before `@`, an escaped `{`); the fifth decodes
  those too. The same pick now takes 98 to 122 ms, and the three shapes and a fuzz of 400,000 values
  are masked exactly as the third round masked them.
* The survey of every frame cost 1.0 to 1.2 ms on 2,000 plain iframes, but on frames in
  `content-visibility: auto` sections reading each frame's style lays it out: on 1,000 such frames
  each arm took 37 to 51 ms (0.6.0: 8 to 10) and the first scroll after it froze the page for 0.34
  to 0.36 s. The fourth round passed over every frame not drawn, which left a frame shown while
  armed unheld until the next survey. The fifth asked hidden frames again and called
  `checkVisibility()` with no options on frames in skipped content, which lays them out too: 33 to
  43 ms an arm and 0.34 s at the first scroll again. The sixth passes over every frame not drawn and
  asks those again before each change of the sheet, once drawn. In Chrome a frame first drawn while
  armed, shown from `display: none` or `content-visibility: hidden` or scrolled into view in a
  `content-visibility: auto` section, now gives the page no transition event (the fourth round: 9 on
  three moves and 3 at an Escape), and on 1,000 and 2,000 such frames an arm takes 10.3 to 10.7 and
  18.6 to 19.6 ms and the first scroll after it holds the page 48.5 to 55.3 and 87 to 94 ms at most,
  as in the fourth round and 0.6.0 (the fifth: 34 to 42 and 99 to 113 ms, 0.33 and 1.1 to 1.2 s).
  What it leaves is in F50.
* The release check's process groups were to start only on CI, but `CI=false` and `CI=0` counted as
  CI, so on a local run with either, Ctrl+C left a hung git or gh call running with no limit. Only
  `CI=true`, `CI=1` or `GITHUB_ACTIONS=true` count now.
* W5-1's guard test, which fails when the panel leaves file opens waiting, could not see opens made
  when a panel loads, and then not one that waits for the page to be visible. It now reopens panels
  with the panel's own `fetch` in reach and a document that is visible, and fails with 1,800 opens
  counted when every item is opened at load.

**The URL scan and the word lists.**

* F20, F40, F55. The JSON rule the picker used for a link's query is now the one shared rule, in
  both copies of the SECRET URLS block, read in one pass (`shared/prompt-template.js:1854`
  `splitJson`, `:1920` `jsonSpans`). A key counts only where JSON puts one, quoted raw, escaped, as
  `"` or `'`, or percent encoded once or more, with one or two of the letters `u`, `b` and `r`
  allowed before its quote, as Python writes a dict (`:1366`, `:1365`), and a URL with more than 500
  distinct keys in all is hidden from its first bracket (`:1380`). A parameter's value is decoded
  once more when it holds an encoded apostrophe or backslash and a colon, and something a decode
  could make more of (a `{` or `,` a key can follow, a raw double quote, a letter or digit written
  as an escape, or an `@` with slashes) (`:1580` `nestedUrl`), so single quoted keys that show only
  once decoded are hidden. A pair with an empty name is screened. A `data:` URL's content is hidden
  after its comma when a link in it carries credentials or a secret parameter, or JSON in it names a
  secret key, and a path parameter there (`;jsessionid=`) counts by its name, read once on the
  content decoded as far as it goes (`:1777` `dataContent`, `:1804` `pathSecretIn`). Text a URL is
  read on across is screened on its own as well (`:2235`). The scheme of an absolute URL is found by
  its `://` (`:2014`): a megabyte of dotted names in a message takes about 3 ms where it took 21 to
  72. A megabyte page URL takes about 25 ms in Node and under 100 ms from click to clipboard in
  Chrome, where the first round took 823 ms, and picking a link whose `href` is a megabyte `data:`
  URL holds the page for 100 to 117 ms, where the second round took 650 to 717 ms. In the first
  round's 30 000 line fuzz of console text the printed secrets fell from 14,352 to 37 of 26,238.
  What is left is F60, and what the scan costs is F68.
* F43. `nonce` is a secret word in all three copies (`shared/prompt-template.js:1284`,
  `content/collector-main.js:300`, `content/picker.js:124`), which covers `payment_method_nonce` and
  WordPress's `_wpnonce`.
* F52, partial. A URL's user name with no password goes when it has five consonants in a row,
  counting common letter groups (`sch`, `ght`, `str`, `sql`, `http`, `ck`, `ng` and 15 more) as one
  (`shared/prompt-template.js:1349`, `:1396`). It strips about 44, 64 and 78 percent of random
  tokens of 8, 12 and 16 small letters. What is left is in the table.
* F56. A list prints the log's zone and day above the first item whenever no Captured line comes
  before the first log line, the page toggle on or off (`shared/prompt-template.js:443`
  `clockNotice`).

**The panel.**

* F31, F45, tried and taken back. Where Chrome let the extension open file URLs, the second round
  had the panel ask the disk before Chrome's records. The final check found that opens blocked on a
  volume that stopped answering used up Chrome's file threads across the whole browser, and two
  smaller faults (F31). The third round took the panel back to Chrome's records alone, with 0.6.0's
  code there byte for byte (`sidepanel/panel.js:2920` `checkFiles`): it opens no file URL and lists
  no folder. A copy whose ticked screenshot's path is a FIFO never opens it, and a copy with 20
  unticked items and one ticked waits on nothing; both take under 75 ms, as in 0.6.0.
  What a safe disk check would need is in the F31 row.
* F41, partial. The click wait on a row tooltip grows to the slowest double click the panel has
  seen, with a fifth to spare, up to one second (`sidepanel/panel.js:850` `learnClickTime`, `:832`).
* F44. Checked again with a real side panel: `chrome.sidePanel.open`, `chrome.windows.update` with
  `focused` and `window.focus()`, called in the task that carried the drag's activation, left the
  keyboard with the page. Kept.
* F57. On a tab the panel may not capture, a request to hide the banner puts the restriction back
  (`sidepanel/panel.js:283` `showBanner`), so a copy no longer takes it away.
* F58. Copy gives the keyboard back: to Copy, to the tick of an item whose missing file holds it
  back, or to Copy again once the sheet is empty, also after Cmd or Ctrl+Enter in the field
  (`sidepanel/panel.js:2661` `focusAfterCopy`).

**The collector and its bridge.**

* F46. While the panel is open and shown it holds a `cdr:counts` port to the bridge of the tab in
  view (`sidepanel/panel.js:2247` `watchCounts`, `content/collector-bridge.js:223`). The bridge asks
  the collector to watch, posts the two counts when they change, at most every 250 ms (`:183`),
  setting that gap before it asks (`:288` `countsTick`), and again at every read and Clear (`:250`
  `recount`). A change event that comes while no port is open is acted on when the bridge's timer
  fires (`:309`), and a bridge that stops watching closes every port it still holds (`:264`
  `unwatchCounts`), so a page that floods that event on a late start can no longer make it drop the
  panel's port: the chips followed the log in 8 of 8 runs, where the second round froze in 2 of 3.
  The collector says a ring grew only with 1,600 calls of stack to spare and marks it told after the
  event has gone (`content/collector-main.js:4253` `roomToTell`, `:4277` `countsChanged`). A change
  it could not tell is owed (`:197`) and told with the next entry, also one into a full ring. In the
  checker's case (warnings logged on the way back from a stack overflow) the chips showed 35 with no
  read, where the first round showed 0 even after one. The probe costs about 13 µs; 20,000 console
  lines in 2 s cost 163 to 251 ms in console calls (0.6.0: 266). A ring left long by pushes that ran
  out of stack is cut back to 30 in one pass by the next push (`:224` `push`), a fault older than
  this round: the console call after about 66,000 extra entries takes 0.8 ms, where the second
  round's cut took 11 s.
* F10, partial. A failed XHR is also settled a task later from its `load`, `error`, `timeout` or
  `abort` event, one timer per request (`content/collector-main.js:2107`, `:2081`). A page whose
  listener stops `readystatechange` and `loadend` had a 500, a refused connection and a timeout
  recorded, where 0.6.0 recorded none.
* F35, partial. After a late start `Error` is taken from the native zone.js kept, as `setTimeout`
  and `addEventListener` are (`content/collector-main.js:359` `beforeZone`, `:378`, `:1915`). With
  zone.js 0.15's error plugin, 200 requests made 200 calls of the page's `String.prototype.split`
  and recorded no caller; now none, and the caller is named.
* F48, partial. A prop one edit away from a secret control's value is withheld when that value reads
  as a passphrase or a seed (`content/collector-main.js:2759` `editedFrom`, `:2796` `seedLike`), as
  a number of 12 digits or more, such as a card number, now does (`:2771`), and such a number in a
  prop that holds nothing else counts by its digits, however the field and the prop group it
  (`:2495` `cardDigits`), and its digits run together count in any prop (`:2717` `holdsSecret`).
  Open shadow roots are searched depth first, up to 512 among the first 100,000 elements (`:2644`
  `shadowValues`, `:2670`, `:2466`). A password field in a form's root inside an app shell's root,
  followed by 600 icons with roots of their own, is now found. A pick on 300,000 plain elements
  takes 16.1 to 17.1 ms (0.6.0: 13.0), and on 60,000 with 202 roots 5.3 to 5.4 ms (0.6.0: 2.7). The
  walk is bounded in roots, not in the elements inside them, and what that costs is in the F48 row.
* F30, F32, F33, F34, F42, F47, F49. Checked again in Chrome, kept, with what was measured now in
  each row of the table.

**The picker.**

* F39, partial. `content/press-gate.js`, declared first in the bridge's entry at document_start,
  listens on the window for the 17 event types the picker keeps (`content/press-gate.js:42`) and,
  once the picker has been armed in the page, hands each to it; the picker acts on them while it is
  armed, through the tail and while the Enter that picked is held (`content/picker.js:3814`, `:3727`
  `route`). Each event is handled once (`:2317` `seen`). During two picks the page had heard 14
  events; now none.
* F38, partial. The transient activation of every press and key the picker keeps is spent at once
  with `showPicker()` on a button input in no document (`content/picker.js:2303` `spend`). Sticky
  activation stays.
* F37, the picker's half. The pick, the frames' sheet, the top layer check and the focus walks go
  into closed shadow roots through `chrome.dom.openOrClosedShadowRoot` (`content/picker.js:2375`,
  `:2394`). The selector joins the paths with ` >>> `, the outermost closed root's host is marked
  and read, and the prompt names the component nearest that host and says so (`:1201` `reachOf`,
  `:1228` `throughHost`, `shared/prompt-template.js:765`). An arm on 20 000 elements with 60 roots
  takes 21 to 45 ms against 6 to 22 ms.
* F50, four of seven edges. A popover or dialog in a known shadow root raises the host on its
  `toggle` or `close` (`content/picker.js:2406` `addRoot`). The Enter that picked is held until it
  is let go (`:3485` `holdEnter`): held for three seconds it had sent the form 62 times, now none.
  The sheet's selector has the specificity of eight ids (`:978`), so an `!important` id rule no
  longer gets a frame a shield. A frame's discrete `pointer-events` transition is held back only at
  three moments: the sheet's first adoption into a tree in an arm, its lift for the hit test over a
  frame and its return, and its removal at the end (`:2576` `holding`, `:988`). A sheet the page
  dropped goes back with nothing held, before anything restyles (`:3026` `keepPassing`): a page that
  reset its list in every animation frame for a second heard 6 transition events, as in 0.6.0 (the
  second round: 363). Whether a frame has such a transition is asked of every frame found and drawn,
  up to 2,000, until one has, and of a frame not drawn at the survey before the first change of the
  sheet after it is drawn (`:3079` `surveyFrames`, `:2507` `drawnSince`, `:992`). Such a frame is
  picked where it is drawn, at 8.5 to 8.7 ms a lift against 4.5 to 4.9 ms. On a page with none, a
  survey of 2,000 plain iframes takes 1.0 to 1.2 ms, where the second round's took 0.3 ms, and one
  of 100 frames or fewer costs what it did. The `space-y` shift (F50e) stays, after the fix for it
  was reverted.

**The overlay.**

* F36, partial. With no modal open the host goes inside the element shown fullscreen
  (`content/overlay.js:491` `fullscreenHolder`, `:200` `mount`), into its shadow root when it has
  one, and never into an element of the types in `NO_HOST` or outside the HTML namespace (`:55`):
  across three arms a fullscreen PDF in an `<object>` was requested once. As a last child it
  measures its siblings and flags a crop that may be off (`:241` `childBoxes`, `:256`). It stops
  hover and wheel events at itself inside the element (`:858` `swallowInFullscreen`), is raised on
  `fullscreenchange` (`:771`), and an element that gave it no box is tried again. A click, a double
  click and a middle click on it are cancelled as well as stopped (`:844` `cancel`), so a misclick
  or a tap inside a fullscreen element nested in a link, a label or a form's button no longer
  follows the link, toggles the box or submits the form, as the second round's did. Its inline style
  sets `pointer-events`, `visibility` and `opacity` (`:60` `build`), so a component's own
  `* { pointer-events: none }` no longer lets presses through it. A drag over a fullscreen `div`
  selected, armed before or after.
* F37, the overlay's half. The focus walk and the hit test ask Chrome for a closed root at every
  host, and the walk asks each custom element once an arm (`content/overlay.js:445` `shadowOf`,
  `:460` `closedRootOf`). A modal dialog in a closed root on a custom element, or on a `div` that
  holds the focus, got the host, and a drag no longer closed it. On disarm the overlay lets go of
  every node it held (`:1136` `stop`); a removed component is now collected.
* F51. The walk takes half its 20 000 element budget from each end of the page
  (`content/overlay.js:317` `collectRoots`) and runs at a look only when a `MutationObserver` saw a
  change, at most once a second by the clock, whatever the frame rate (`:407` `watchChanges`,
  `:48`). A look queries the document and only the roots that held a popover or a dialog at the last
  walk (`:387` `holdsLayer`, `:517` `queryAll`). Over 3 s armed on a quiet page, 6,000 open roots
  cost 7 to 8 ms against 45 to 47 in 0.6.0, and 51 000 plain elements 14 ms against 12 to 14, with
  no look over 1.1 ms. On a page that changes every frame, 6,000 open roots cost 22 to 24 ms against
  45 to 48, and 6,000 closed roots 23 to 24 against 6.5 to 6.7 (F69); the longest stretch there is
  one walk, 5.8 to 6.8 ms.

**Tooling and CI.**

* F54. V8 says which `import` followed by `(` is an import: the file parses as it is and not once
  that `import` is spelled `class ` (`tools/build.mjs:442` `inCode`, `:463`). The pattern is tried
  at every `import` in the file (`:414` `starts`), so a match that starts at an earlier one can no
  longer hide a real `import()`. Comments end at any line terminator (`:377`, `:378`), and phase
  imports fail the build on Node 22 and 24 (`:398`, `:468`, `:585`, `:632`), also in a module
  nothing imports (`:537` `linkMain`). On the checker's 63 shapes that parse, the build agrees with
  Chrome 156 on both. The search takes 0.9 ms on the shipped scripts; what it costs on hostile input
  is in F66.
* The build's children take input from files in a temporary folder, never a pipe, and each is killed
  after 120 s (`tools/build.mjs:701` `runNode`, `:734`, `:649`). `node --check` runs only for a
  module V8 refused (`:784`), so a clean build starts one child instead of four, in 0.13 s instead
  of 0.18 to 0.19 s. A temporary folder that cannot be made or written fails the build with one line
  per check and no stack (`:679` `inScratch`). Each build first removes the folders, more than an
  hour old, of builds a signal stopped (`:657` `sweepScratch`), which costs 8 to 10 ms with 21,365
  entries in the temp directory. What a stopped build still leaves is F70.
* F59. On CI, and never on Windows, each `git` and `gh` call leads its own process group and is
  killed with everything it started after 60 s (`tools/release-check.mjs:147` `run`, `:140`,
  `:126`). A local run keeps the call in the terminal's group, so Ctrl+C stops it, as in 0.6.0. A
  failed or hung call prints its message alone (`:144` `CallFailed`), any other error keeps its type
  and stack, and a `manifest.json` or `package.json` that is not valid JSON fails as a `SyntaxError`
  that names the file.
* F67. The release check takes only exit 1 from `git rev-parse -q --verify` to mean no tag, and
  fails on any other (`tools/release-check.mjs:178` `tagCommitOf`). Before, outside a repository
  (exit 128) with `GITHUB_SHA` set as on a runner, a run from `main` decided to tag and release
  (`publish=true`), and a pull request's check passed. Older than the 0.6.1 rounds.
* F53, TR11. The owner set the repository's description and homepage.
* CI tests Node 22 and 24 (`.github/workflows/ci.yml:25`), `package.json` asks for Node 22 or newer,
  the version check and the release run on Node 24, and every job has `timeout-minutes` (15 and 15
  in `ci.yml:19`, `:46`, 20 in `release.yml:45`).

**Judgment calls.**

* **The press gate is not injected into tabs already open.** Injecting it at install would touch
  every tab the user has open, and would still come after the listeners those pages added. The cost:
  on such a tab F39 stays as it was until the tab is reloaded.
* **The picker's host stays on `body`.** No place under the html element leaves every structural
  pseudo class of `body` unchanged, and after `body` broke rules that styled `body` itself. The cost
  is F50e's shift on a page that spaces `body`'s children by margin.
* **A `MutationObserver` rather than a live element count gates the overlay's walk.** The count is
  cheaper but sees no change in a shadow root or to `popover`. The cost: a page that changes every
  frame pays for one batch of records per walk, at most one walk a second, up to 24 ms over 3 s on
  6,000 roots, about three times 0.6.0 with closed roots (F69).
* **F31 and F45 are left to Chrome's records.** Asking the disk answers what the records cannot, but
  a safe version needs new mechanisms: a shared mark on folders that stopped answering, a cap on
  outstanding opens, and disk asks that outlive the copy's wait (F31). The cost: a screenshot
  deleted within about ten seconds of Chrome's last look is still copied, as in 0.6.0.
* **The shadow walk is bounded in roots, not in elements.** A shared element budget would cap a
  pick's cost, but one root of 10,000 elements or more, such as a data grid, would use it up, and a
  password field in any root after it would print again. The cost: about 60 ns a pick for each
  element inside the roots looked into, 58.9 ms for 512 roots of 2,000 elements (F48).
* **The release check's calls get process groups only on CI.** A call in a group of its own is out
  of the terminal's reach, so on a local run Ctrl+C would stop the script and leave a hung call
  running with nothing to enforce its limit. The cost: on a local run, what a call that ran out of
  time started keeps running, as in 0.6.0 (F70).
* **The check loop stopped after the sixth round.** Each round fixed what the check before it found,
  and each fix opened smaller edges of its own (the fourth round's card digits took places a pick
  keeps for values; the fifth round's survey filter laid out what it meant to skip; the sixth
  round's card search reads each prop twice). After the fifth round, only a high finding was to be
  fixed and the rest written down. The sixth round fixed the one high finding, and broke that rule
  for the card regression: a card's digits in a sentence printed where the fourth round withheld
  them, and the fix was one line. The last rerun found nothing high, and three losses against an
  earlier round, all low and written down rather than fixed: beside a grouped field, part of a card
  number or its digits with one character changed print where only the fourth round withheld them
  (F48, as in 0.6.0); the card search doubles a pick's cost against 0.6.0 on pages of megabyte props
  beside many card fields (F48); and a frame put back after a move is held only from the next
  survey, where the fifth round held it (F50). Checking a fix takes a rerun of an hour or more in
  Chrome, and every round so far opened edges that only such a rerun found. The cost: the low edges
  in the F48, F50 and F71 rows stay, each with what it costs.

## Found while implementing, not fixed

F21 and F24 to F29 were fixed for 0.6.0, at the lines of that tree the subsection for 0.6.0 gives.
For 0.6.1 these were fixed, and their rows are gone: F20, F40 and F55 at
`shared/prompt-template.js:1854` (`splitJson`), `:1920` (`jsonSpans`) and `:2014` (`SCHEME`); F43 at
`shared/prompt-template.js:1284`, with its copies at `content/collector-main.js:300` and
`content/picker.js:124`; F46 at `content/collector-bridge.js:223` (`watchCounts`), `:250`
(`recount`) and `:288` (`countsTick`), `content/collector-main.js:4277` (`countsChanged`) and
`sidepanel/panel.js:2247` (`watchCounts`); F51 at `content/overlay.js:317` (`collectRoots`) and
`:407` (`watchChanges`); F53 by the owner, who set the repository's description and homepage; F54 at
`tools/build.mjs:442` (`inCode`) and `:414` (`starts`); F56 at `shared/prompt-template.js:443`
(`clockNotice`); F57 at `sidepanel/panel.js:283` (`showBanner`); F58 at `sidepanel/panel.js:2661`
(`focusAfterCopy`); F59 at `tools/release-check.mjs:147` (`run`); and F67, found while these docs
were checked against the code, at `tools/release-check.mjs:178` (`tagCommitOf`). F10, F35, F36, F37,
F38, F39, F41, F48, F50 and F52 were fixed in part, and their rows keep only what remains. F31 and
F45 were tried and taken back, and their rows say what a safe version needs. F30, F32, F33, F34,
F42, F44, F47 and F49 were checked again and kept, with what was measured. F60 to F66 and F68 to F71
are new: what the 0.6.1 rounds found and left, each with what it costs. Each row says whether it is
older than the round that found it.

| Id | Where | What | Fix |
| :--- | :--- | :--- | :--- |
| F10 | `content/collector-main.js:2107` (`backstop`), `:2081` | A page listener added before the first `open()` that stops every event a failed request ends with (the `readystatechange` to DONE, then `load`, `error` or `timeout`, then `loadend`) still hides it until the object is opened again. Stopping `loadend` or `timeout` alone has not hidden one since 0.6.0, and stopping `readystatechange` and `loadend` together has not since 0.6.1: the collector settles a failed request a task later from whichever of those events reaches it first, with one timer per request, and labels a status 0 end that lasted the timeout as a timeout. Low; also at `a0c9335`. | Not fixable short of replacing the `XMLHttpRequest` constructor. Listeners on one target run in the order they were added, whatever their capture flag (Chrome for Testing 156), so only the constructor comes earlier, and a Proxy of it would print `function () { [native code] }` (F34), and `XMLHttpRequest.prototype.constructor` would no longer be `XMLHttpRequest` unless the collector rewrote the native prototype, on every page. |
| F30 | `content/collector-main.js:703` (`walk`) | `serialize()` no longer uses `JSON.stringify` (0.6.0). What remains is the list of an object's keys, which V8 collects whole before handing out the first: about 100 ms for an object of a million keys, in the page's thread, and only for an object the page hands to `console.error` or `console.warn`. Low; also at `a0c9335`, slower there. | Not fixable from a script. Measured in Chrome for Testing 156 on an object of a million keys: a for-in that stops at its first key takes 92 ms, `Object.keys` 93, `Reflect.ownKeys` 159, `Object.getOwnPropertyNames` 154, a `JSON.stringify` whose replacer stops at the first key 100, and a for-in over a proxy of the object 193, against under 0.1 ms for a thousand keys. Nothing a script can call hands out a key before the whole list is built. |
| F31 | `sidepanel/panel.js:2920` (`checkFiles`) | Chrome looks at the disk at most once every ten seconds, for all downloads together, so a screenshot deleted within about ten seconds of its last look is still copied. A copy whose page read beats Chrome's answer also names the file, and then says so on the receipt. Low; also at `a0c9335`, where nothing was checked after startup. | Not fixable with Chrome's records: no downloads API makes Chrome look sooner. Tried for 0.6.1 and taken back. Where Chrome allows file access (the Allow access to file URLs switch, on for the unpacked extension in Chrome 156), the panel opened the file URL of each screenshot and listed its folder when the file did not open. The checks in Chrome for Testing 156 found three problems. An open on a volume that stops answering stays blocked in one of Chrome's file threads, which Chrome cannot cancel, and the panel opened each such path once per panel page: 60 items took the browser process from 44 to 101 threads, 300 took it to 286, and a sheet of 30 with the panel reopened 9 times reached 288, past which an unrelated file URL did not open within 5 s and downloads stalled across the whole browser. A file that exists but will not open, in a folder Chrome lists as empty (mode 311), was called missing, held Copy back and stayed missing at every later check, though Chrome's record said it existed. And a deletion a second before Copy was still missed in folders of about 2,000 files or more (smaller ones on a slower machine), because the listing did not end within the copy's wait. With 0.6.0's behaviour back, 300 quiet items leave the browser at 40 to 41 threads and 9 reopens at 42 to 45, unrelated file URLs open in about 1 ms, and downloads complete in about 55 ms. A safe version needs: one late open marking its whole folder or volume as not answering, with no more opens there until it returns; a cap on the opens a page leaves outstanding; that state shared by every panel page, in every window and across reopens; an empty listing taken as no answer when Chrome's record says the file exists, with the missing shortcut used only when the record agrees; disk asks that outlive the copy's wait, with a late gone said on the receipt and naming the disk; and `PRIVACY.md` and the README saying that the panel opens its screenshots' file URLs and lists their folder. |
| F32 | `content/collector-main.js:116` (`PROBE`), `content/collector-bridge.js:60` (`HELLO`) | A page script written against this extension can tell it is installed, by the probe event a running collector answers. It can open a channel of its own and read its log, or push the live bridge's channel out with eight of them, and it can watch the counts on a channel of its own, which say less than the log. When the extension starts on a tab already open, it can overhear the bridge's channel and answer in the collector's place, a collector started late takes the page's builtins as they are then, and a page that heard the bridge's HELLO can send `unwatch` on the bridge's own channel, which holds the live chips back until the panel's next read, though it can no longer make the bridge drop the panel's port. On a declared start it never learns the channel, and cannot hold the counts back. On a declared site's undeclared path it can answer the worker's probe and get a bridge. None of this puts into a prompt more than logging made up lines would. Low; new with CO14 and improvement 9, the `unwatch` with F46. | Not fixable for code in the page's world: the guard needs a signal both copies of the collector can see there, which the page sees too, and a tab already open has no path between the worlds that a page listener cannot hear. Nor would a silent probe hide the extension. In Chrome for Testing 156 a page with the collector running also reads `punch-list://extension/collector-main.js` in the stack of an error thrown through a wrapper (`new XMLHttpRequest().open('GET')`), gets an answer over the picker's protocol, and reads `function () { [native code] }` for `fetch` (F34). The address is the collector's sourceURL, kept for the console cost (judgment calls). The bridge on undeclared paths is kept on purpose (judgment calls). |
| F33 | `content/collector-main.js:151` (`LATE`) | A page can hide what its own log says about its start. On a late start into a page still loading, a listener it added earlier can stop the event the collector sends as it starts, or it can make `document.readyState` lie, and the late caveat goes. A false caveat needs code that runs before a declared collector, which a page's own script never does: another extension's document_start script in the page's world that cancels that event, or makes `dispatchEvent` cancel every event. An opener cannot plant a listener on a popup's first window either: in Chrome for Testing 156 the page the popup went to had a window of its own, after `window.open()`, `window.open('')` and `window.open('about:blank')`. Low; new with improvement 9. | Not worth it: it changes only what a log says about its own start, not what it holds, and only for code written against this extension or one that breaks `dispatchEvent` for every page. The event is the one path from the worker's world to the collector; any other signal the two worlds share is in the DOM, where every page script and observer would see it. |
| F34 | `content/collector-main.js:1026` (`wrapNative`) | A wrapper's `toString` reads `function () { [native code] }`, as V8 writes it for any callable proxy, where the native's reads `function fetch() { [native code] }`. A script looking for wrappers in general can tell. Low; new with CO14, which replaced named wrappers whose source printed. | Not worth it: answering it would mean replacing `Function.prototype.toString`, which every page uses. Checked in Chrome for Testing 156: a Proxy with no trap, a Proxy with a trap and a bound function each print `function () { [native code] }`, and only the native prints its name. A replacement of `toString` prints that text for itself unless it lies about itself too, and adds its own frame to the stack of every error it passes on (checked in V8). |
| F35 | `content/collector-main.js:1915`, `:359` (`beforeZone`) | On a late start, `setTimeout`, `addEventListener` and, since 0.6.1, `Error` are taken from the natives zone.js keeps under its own names, so recording a request adds no task to an Angular zone and runs no `ZoneAwareError`. Anything else that replaced them before the start, fake timers for one, is used as it is, and the collector's timer and listeners go through it. Low; new with improvement 9. | Not fixable from the page's world: after the page has run, an untouched copy can only come from a new realm (an iframe), which would change the page. Another way to wait a task, a `MessageChannel`, is the page's to replace as much, and switching to it would change every page for the sake of a test clock. |
| F36 | `content/overlay.js:491` (`fullscreenHolder`), `:55` (`NO_HOST`), `:60` (`build`) | Region cannot be used while the element shown fullscreen is one of the types in `NO_HOST` (audio, canvas, embed, fencedframe, frame, iframe, img, input, object, optgroup, option, script, select, style, template, textarea, video) or outside the HTML namespace (svg, math), a bare `<video>` put fullscreen by its own controls, say. The host stays on the body, drawn above the element and inert, so a drag reaches the page. Region works again with no new arm once the page leaves fullscreen, and Screen works. In a fullscreen component's shadow root the component's own rules still reach the host, a `div`: one that hides it (`div { display: none }`) gives it no box, so it goes back on the body, inert there, and an `!important` rule on `pointer-events`, `visibility` or `opacity`, or a `transform`, `filter` or `clip-path` set on every element, still applies to it. Since 0.6.1 any other fullscreen element takes the host, armed before or after; what that costs is F65. Low; CW3's fullscreen half, also at `a0c9335`. | Not fixable from inside the element: such an element draws no children or loads what it holds (Chrome loads an `<object>`'s document again when a child is added), and outside it the host is inert. Not worth it another way: capture listeners on the window could take a drag over a video or a canvas (never a frame, whose presses go to its own document), but that is a second input path for one case. `display` stays out of the host's inline style, since an inline value would override the browser's rule that hides a popover not shown. |
| F37 | `content/overlay.js:460` (`closedRootOf`), `content/picker.js:1228` (`throughHost`) | Closed shadow roots, what is left. The overlay misses a modal dialog in a closed root on a built in element (a `div`) while nothing in that root has focus, since only the focus walk reaches such a root, and one in a closed root attached during the arm to a custom element its walk has already asked about, until the next arm. The picker reaches every closed root and names the component nearest the outermost closed host (`shared/prompt-template.js:765`); whether that framework rendered the element inside the root cannot be known from the page's world, and the prompt makes no claim either way. Low; also at `a0c9335`. | The old reason was wrong: `chrome.dom.openOrClosedShadowRoot` hands a content script a closed root, with no permission, at about 0.6 µs a call (Chrome for Testing 156). For the overlay's two cases, not worth it: asking every element of the walk cost 15 ms a walk at 24 000 elements, and asking every custom element again at each look would cost that call for each, every quarter second. |
| F38 | `content/picker.js:2303` (`spend`) | A pick leaves the page with sticky activation (`navigator.userActivation.hasBeenActive`), so a page never clicked reads as clicked once, which some features ask for, such as audio with sound. Since 0.6.1 the transient activation a pick gives is spent at once, so a popup or playback as if clicked no longer follows a pick, and an activation the page had from its own click just before the pick is spent with it. Low; also at `a0c9335`. | Not fixable: sticky activation stays for the life of the page (HTML's user activation model), and `showPicker()` spends only the transient one (checked in Chrome 156). |
| F39 | `content/press-gate.js:42`, `content/picker.js:3727` (`route`) | On a tab without the press gate, a page capture listener on `window` added before picking started runs before the picker's. Those tabs are one open from before the extension was installed or enabled, a site the narrowed `matches` leave out, and possibly one open across an update or reload of the extension, which keeps the old gate (whether the new picker is handed its events there was not checked). A listener that only listens hears the presses and the keys, whose default actions the picker still cancels. One that calls `stopImmediatePropagation` keeps the press from the picker: nothing is picked and the press does what it would with no picker (a link is followed), and keys stopped that way, Escape, the arrows and Enter among them, never reach the picker. Where the gate loaded with the page, the page hears nothing of a pick, a stopper included. Low; also at `a0c9335`. | Not fixable for those tabs: listeners on one target run in the order they were added, across worlds, and nothing can come before listeners a page already has. Injecting the gate into open tabs at install would touch every tab the user has open, and come after those listeners anyway. |
| F41 | `sidepanel/panel.js:850` (`learnClickTime`) | The click wait on a row tooltip grows to the slowest double click the browser has counted in the panel, with a fifth to spare, up to one second. With a system double click time slower than half a second, the first slow double click on a tooltip, before the panel has seen one as slow, still picks the row it covers instead of selecting a word, and its second press lands on whatever the closed tooltip covered. So does any double click slower than one second. Low; new with UX13. | Not fixable further: no web API tells the system's double click time, and a wait past one second would read as a lost click. |
| F42 | `content/collector-main.js:1680` (`intrinsicThen`) | After a late start on a page where core-js forced its own Promise, each failed or answered fetch calls the page's replaced `then` once. A collector declared at document_start settles through the engine's own `then` and costs such a page nothing. Low; new with improvement 9. | Not fixable from the page's world, as F35. Checked with core-js 3.39 forcing its own Promise in Chrome for Testing 156: an `await`, a promise returned from an async function, an async generator's `yield`, `for await`, `Array.fromAsync`, and an `await` on a promise given an own `constructor` (either constructor still in reach) each call the page's `then`. V8 skips it only for a promise whose `constructor` is the engine's own `Promise`, and once core-js has replaced the global and deleted the prototype's `constructor`, no function in reach of `window` has the engine's `Promise.prototype` as its prototype. |
| F44 | `sidepanel/panel.js:1262` (`focusDescription`) | After a Region drag the panel puts the caret in the field, but the page keeps the keyboard, so typed characters go into the page's focused input until the user clicks the panel. The panel says so under the field. Medium (UX5); also at `a0c9335`, unsaid. | Not fixable from the panel. Checked again in Chrome for Testing 156 with a real side panel. The panel hears the drag's message with the user activation the content script's message carries, and in that same task `chrome.sidePanel.open` and `chrome.windows.update` with `focused` resolved and `window.focus()` ran. After each, the panel still reported `document.hasFocus()` false. Only a click into the panel moved the keyboard. Blurring the page's element on arm would change the page. |
| F45 | `sidepanel/panel.js:2691` (`writeReceiptNote`) | A screenshot whose download record Chrome has erased (the download list was cleared) cannot be asked about, so the copy goes ahead and the receipt names the item as not checked. Low; also at `a0c9335`, unsaid. | Not fixable with Chrome's records: no other extension API tells whether such a file exists. Tried for 0.6.1 and taken back with F31: file URLs can answer for such a file, but asking through them brought the three problems the F31 row records. A safe version needs the same mechanisms. |
| F47 | `content/collector-main.js:1189` (`CSP_NOTE`) | A fetch the page's CSP blocks is reported by the browser and in the site's CSP reports with the collector as its source, now named `punch-list`. The prompt says the page's policy blocked it and keeps the page's caller. Low (M4). | Not fixable, checked in Chrome for Testing 156: the report names the script of the topmost frame when the native runs. A wrapper whose trap is a function of its own is named, even when it calls the native from a microtask. A trap that is `Reflect.apply` itself, or a bound copy, names the page's line, and runs nothing that could record the request. A call deferred to run from no frame names no source at all, not the page's, and sends what the page's init holds by then: a POST the page changed to PUT just after calling went out as PUT. |
| F48 | `content/collector-main.js:2594` (`documentValues`), `:2759` (`editedFrom`), `:2796` (`seedLike`), `:2670` (`shadowTree`) | Props are withheld when they hold the value of a secret control in the document or in its open shadow roots, or that value changed in one place when it reads as a passphrase or a seed (white space, or 12 characters or more, and not a number of fewer than 12 digits), and, in a component that renders a password, code or card control, when a string has a secret's shape. A value no control holds and of another shape still prints (a passphrase with spaces, a password of letters only or under eight characters), as does any such value handed to a component that renders no such control, and a password under 12 characters with no space, seeded and then changed in one character, outside such a component (`Xk9#mQ2p` beside `Xk9#mQ2z`, `hunter3hunt` beside `hunter2hunt`). A card number counts by its digits only in a prop of 64 characters or fewer that holds nothing else, and its digits run together count in any prop. Grouped inside a sentence (`Card 4111-1111-1111-1111 declined` beside a field holding `4111 1111 1111 1111`), in digits other than ASCII, or grouped by commas, it is caught only when grouped as the field groups it, and a prop holding fewer than 12 of its digits prints, as does, beside a field that groups it, its digits run together with one character changed (`45391488X3436467`), both as in 0.6.0. Each held number of 12 digits or more is looked for in every string prop twice, as written and as its digits: with 63 held card numbers and twelve 1 MB props that hold none of them, a pick takes 511 to 581 ms against 245 to 282 ms in 0.6.0, and with one held card 7.0 to 7.9 against 3.1 to 3.5 ms. In a component the shape rule applies to, an ordinary code of that shape is withheld, such as a coupon code or an order number, and anywhere a string that shares three quarters of such a passphrase or seed at its ends is withheld, such as an e-mail address one character from the user's in a field named `email`, or a number of 12 digits or more one digit from the one in such a field. A field in a closed shadow root, in a root past the first 512 in depth first document order, in a root whose host comes after the first 100,000 elements, or in a frame is not found, and a field two shadow roots deep inside what a component renders brings neither the shape rule nor its `value` props. The walk is bounded in roots, in elements asked for a root and in controls read, not in the elements each root's selector looks at, about 60 ns an element: 512 roots of 2,000 elements took 58.9 ms a pick and 300 of 1,000 took 17.9 ms (0.6.0: 0.2 and 0.1 ms, since it looked into no nested root). Low; each printed at `a0c9335` too, and the costs of the walk and of the second search are new with the 0.6.1 rounds. | Not worth it for what remains: a secret is known by the control that holds it or by its shape, and judging every string by shape everywhere would withhold the ids and hashes every page passes. Catching short passwords changed in one character would withhold again what the first round's rule withheld, numbers and month labels one character from a short secret. A frame's fields belong to another document, whose values reach this one's components only through the page's own messages, and a closed shadow root answers the page's world nothing. A shared element budget would cap the walk, but one root of 10,000 elements or more, such as a data grid, would use it up and hide a field in every root after it. The bounds keep a pick at 16.1 to 17.1 ms on 300,000 elements (0.6.0: 13.0). A number held as its bare digits is searched for twice in the same form, which could be skipped (S); for a grouped one the second search is what finds its digits run together. |
| F49 | `content/collector-main.js:1741` (`watched`) | After a late start, a fetch promise that is not a plain engine promise (one the page decorated with an `abort` method, a Bluebird promise, a thenable) is handed back as the page's own object and watched on a side chain. Any observer marks a promise as handled, so a rejection the page leaves unhandled no longer fires the page's own unhandled rejection report, and the prompt has no `[unhandled]` line for it, though the failed request is still recorded. Low; new with improvement 9. | Not worth it: any reaction marks a promise handled (PerformPromiseThen in ECMAScript), so it cannot be watched without that. Handing back a new promise made the page's own calls on it throw (`p.abort`, Bluebird's `.tap`), and a side chain that rethrows reports a rejection the page handles. Checked in Chrome for Testing 156 with the collector started after load, on a page whose fetch decorates its promise: an unhandled failed fetch fired `unhandledrejection` without the collector and none with it, and was logged; a rethrowing side chain fired one for a rejection the page caught. |
| F50 | `content/picker.js:978` (`PASS_SELECTOR`), `:2576` (`holding`), `:3079` (`surveyFrames`), `:2507` (`drawnSince`), `:3257` (`mount`) | Picker edges that remain. A press in the same animation frame as a page's own assignment of `adoptedStyleSheets`, with no pointer move since, can reach a frame. When the page's new sheet list is restyled before the sheet goes back (it reads a style or forces layout right after setting the list, or sets it in an animation frame callback added after the picker's), a frame with a discrete `pointer-events` transition runs it and the page hears it, as in 0.6.0. A frame whose own `pointer-events` is an inline `!important`, an `!important` in a cascade layer of the page's, or one with more than eight ids keeps a shield, under which a hover menu loses its hover. On a page that spaces `body`'s children by margin (`space-y`), the page shifts by the full gap while armed (4 px on a vertically centred test page), which is undone before the element is read and photographed; the fix that moved the host after `body` was reverted. The fallback content of an `<object>` shows no hover while picking. When no frame among the first 2,000 found has a discrete `pointer-events` transition, one beyond them is adopted without a hold: the page hears its transition at the arm, and for half of it the frame takes a press. A frame that gains such a transition after the arm, while none had one, is found by the next survey (within 15 frames) or when the pointer reaches it, and picking that ends before then removes the sheet without a hold. So is a frame not drawn at the survey that the page removes and puts back after a move (in Chrome, 9 transition events on three moves and 3 at an Escape, as in the fourth round; the fifth held it), and an Escape in the same animation frame as the page scrolls such a frame into view gives the page 3 events, as in 0.6.0, since the frame is drawn only after the sheet is gone. A frame drawn before the arm and then hidden with `content-visibility: hidden` gives the page 2 events at the arm, as in 0.6.0, and 1 when the page shows it while armed, since its transition runs as it is drawn with the sheet in place (0.6.0: 13). A frame drawn before the arm and then scrolled into skipped content takes a press made right after the page scrolls it back, as in 0.6.0. A page that puts back a stale copy of its sheet list holding the picker's emptied sheet can make the next arm add the rule without a hold. Asking every frame costs a page of 2,000 plain iframes 1.0 to 1.2 ms a survey, about four times a second, where the second round's survey took 0.3 ms (at the arm 3.8 to 6 ms against 2.6 to 2.8), and once such a frame is found every lift pays one more restyle (5.4 to 7 ms against 3.2 to 3.7 ms on that page). While 1,999 frames sit in skipped content or with `display: none`, asking those again costs each move over a frame about 0.5 ms (3.8 to 3.9 ms against 3.3 to 3.5 in the fourth round and 0.6.0). Fixed in 0.6.1: a popover in a shadow root hidden and shown again, Enter held past the tail, an `!important` id rule on a frame, and a discrete transition, also on a frame past the first 100 and on one not drawn at the arm and shown or scrolled into view while armed. Low; the `space-y` shift as in 0.5.0, the rest new with the 0.6.0 round. | Not worth it. No event or observer reports an assignment of `adoptedStyleSheets`, so the sheet goes back on the next frame and at every press. Nothing in the page's origin beats an inline `!important` or one in an earlier layer, only the worker can insert a user origin sheet, asynchronously, while the hit test lifts the sheet in the middle of a move, and a layer of the sheet's own made every lift six times slower. After `body` the host took `:last-child` from `body` itself, and no place under the html element leaves `body`'s structural pseudo classes unchanged. The only CSS that gives the fallback the pointer back cuts off a `none` the page set above the object (checked in Chrome 156); an earlier note that it slowed every restyle by a quarter did not reproduce. The 2,000 is the bound the picker already keeps on the frames it boxes (`FRAME_BOXES`, `:992`). S for a frame put back: keep a frame that is not connected in the list until the next survey. A frame drawn with no such transition is dropped from it, since asking it again at every change of the sheet would read the style of every frame drawn since the survey, the cost the fourth round took out. |
| F52 | `shared/prompt-template.js:1396` (`isCredentials`), `:1349` (`CONSONANT_GROUPS`) | A URL's user name with no password that reads as words is kept, so a short token of small letters with no digit and no five consonants in a row, counting common letter groups as one (`https://abcdefghij@host`), prints. The rule strips about 44, 64 and 78 percent of random tokens of 8, 12 and 16 small letters. Of 138 common service and admin accounts only `smmsp` loses its name, as do about 0.2 percent of first name plus surname forms (`ernstsmith@`) and 0.06 percent of first name plus initial ones. Low; the price of F24's fix, which kept `git@` and e-mail addresses. | Not worth more: a table of the 145 letter pairs English rarely writes catches 73% at eight letters but strips 11% of user names made of an initial and a first name, telling the rest from `administrator` needs a dictionary, and a passphrase of real words (`correct-horse-battery-staple@`) cannot be caught even with one. |
| F60 | `shared/prompt-template.js:1366` (`QUOTED_KEY`), `:2158` (`jsonUrlEnd`), `:1804` (`pathSecretIn`) | Shapes the URL scan still does not read: keys quoted with `&quot;` or another HTML entity in a logged URL, keys written with `\/` as PHP's `json_encode` writes them, escaped keys two levels deep that also use `\u` escapes, a key whose two quotes are different characters, JSON in a path segment, JSON arrays of name and value pairs, unquoted JavaScript keys, JSON that closes on a later console line, links or JSON in base64 `data:` content, which is never decoded, and a key with a `u`, `b` or `r` before its quote in an attribute that is not a URL (`data-config="{u'token': …}"`). In a `data:` URL's content, a path parameter whose name holds a comma or a percent escape (`;base64,token=`) is not read, nor one after an encoded quote or space (`%22`, `%20`) in the link's path, both of which the second round hid. In console text, a value in quotes with no JSON around it (`?q="abc"&token=…`) ends the URL at its quote, so a secret parameter after it prints. Each of these prints in 0.6.0 too. Low; older than this round. | S for the quoted value, if it matters: read on past `="…"` when a `&` or `;` follows its closing quote, as past JSON. Each other shape is a rule of its own, for a log that shows it. |
| F61 | `content/collector-main.js:1380` (`VENDOR_FRAME`) | With the collector declared, zone.js wraps the collector's wrapper, so on a page that loads zone.js from a file whose path does not contain `zone.js` (`zone.umd.js`, or Angular's polyfills bundle) the first two caller frames of a failed request are zone.js's own (`proto.<computed> [as open]`), and the page's frame is the third of the three kept. Not measured behind a request library. Low; new. | S for the file names (`zone.umd.js`, `zone.min.js`); frames bundled into a polyfills file would need names. |
| F62 | `content/collector-bridge.js:250` (`recount`), `sidepanel/panel.js:2297` (`countsFollowed`), `content/collector-main.js:197` (`owed`) | The live chips can stand still until the panel's next read: when the bridge's listener takes the collector's event but cannot act on it (not seen in Chrome), on a page that only ever logs within 1,600 calls of its stack limit, during a stack overflow until the page logs again from a shallower frame, into any ring, and on a late start after a page sends `unwatch` (F32). While a change is owed and a panel watches, each console call into a full ring repeats the stack check until the event goes out, about 25 µs a call: 20,000 calls near the stack limit took 2.2 s against 1.7 s in the second round. With no panel open nothing changes. The path for a hidden panel was not tested, since headless Chrome keeps `visibilityState` at visible. Low; new with F46. | Not worth more: the collector sends its event only with 1,600 calls of stack to spare, every read and Clear sets the chips right, and a channel a page knows the name of cannot be kept from it. |
| F63 | `tools/chrome-shim.js`, `tools/panel-stage.html` | The stage models no port: its panel shim has no `tabs.connect` and the demo tab's shim no `runtime.onConnect`, so on the stage the console and network chips stay a snapshot, read on focus as before. Low; new with F46. | S: a pair of port fakes in the two shims. |
| F64 | `content/overlay.js:317` (`collectRoots`), `:407` (`watchChanges`), `:517` (`queryAll`) | The overlay's walk for shadow roots misses a component in the middle of a page of more than 20,000 elements, which is never walked, and a shadow root attached to an element already in the page (a component defined after the arm, or `attachShadow` on an existing element), which changes no child list and waits for a walk something else causes, the next placement or the shortcut. A known root that gets its first popover or dialog after a walk is queried from the next walk on, within a second and a look (1.25 s at 60 Hz), and a popover in it, or in a root a later walk finds, can cover the overlay until then. Pressing the shortcut again puts the overlay on top. Low; the root on an existing element as in 0.6.0. | Not worth it: no mutation record reports `attachShadow`, so only a walk finds such a root, and walking all of a larger page at every look would cost what the budget is there to avoid (about 1.4 ms over 20,000 elements). |
| F65 | `content/overlay.js:241` (`childBoxes`), `:844` (`cancel`), `sidepanel/panel.js:617` (`MOVED_UNDER_OVERLAY`) | In a fullscreen element with no shadow root the host is the last child, so that element's `:last-child`, `:nth-last-child`, `:last-of-type`, `:only-child` and `:empty` rules see one more child while Region is armed: on a slide laid out with Tailwind's `space-y` the cards moved up 20 px, and the screenshot, taken once the host is gone, was 20 px off what was selected. The capture is flagged when a direct child moved or resized; a change deeper inside the last child that does not move it is not caught. Page code can also see the host there (a `MutationObserver` on the element, a capture `toggle` listener). Clicks on the host are cancelled as well as stopped: the page's capture listeners still hear a click first and then find it cancelled (`defaultPrevented` true), and a middle click (`auxclick`) no longer reaches its bubble listeners. Low; new with F36. | Not fixable: no position among the children is invisible to selectors, and first would trip `:first-child`, the sibling combinators and every `:nth-child` instead. The check costs one forced layout per placement, 0.03 to 0.3 ms. |
| F66 | `tools/build.mjs:428` (`lineOf`), `:442` (`inCode`), `:414` (`starts`) | Line numbers in the build's messages count line feeds only, so after a lone carriage return, U+2028 or U+2029 they differ from V8's. A file under `content/` that a module also imports is parsed only as a module, so `await / import('./x.js') /g` reads as a regular expression to the build and as a division and an import to Chrome's classic injection; no shipped file is both. The search for `import(` tries its pattern at every `import` in a file, 0.9 ms on the shipped scripts but quadratic on hostile input: one line of 20,000 keywords that each match takes 0.7 to 1.8 s, and 20,000 `import` each followed by a comment opener on one line 3 to 6 s. HTML like comments are taken between `import` and its parenthesis anywhere on a line, though a classic script allows `-->` only at a line start; that only adds a place V8 then rules out. Low; older than this round, the search's cost new with it. | S for the line numbers. The second is not worth it while no shipped file is both, nor the search's cost, which only a file written to slow the build reaches; every place found costs one V8 parse of its file, as every real `import()` already did. |
| F68 | `shared/prompt-template.js:1854` (`splitJson`), `:2235` (`JOIN_CHANGES`), `:1804` (`pathSecretIn`) | What the URL scan costs. Of the checker's 38 megabyte shapes, each tried in a message, a request URL and the page URL, all 114 are under 150 ms and 45 are over twice 0.6.0; the slowest, a message of URLs each followed by a quote and a brace, takes 120 to 143 ms (0.6.0: 44 to 47). The collector clips console text at 6,000 characters and request URLs at 600, so only the page URL and a picked element's attributes can hold a megabyte. In the page URL every shape is under 60 ms; over twice 0.6.0 there are alternating quotes (27 ms against 11), backslash runs before a quote (26 to 27 against 10), single quoted JSON with encoded quotes (28 to 30 against 3), encoded single quoted keys with a raw `&` (18 against 6) and `data:` content encoded four times (14 against 4). In a picked link every shape is under 50 ms: a plain megabyte query 41 to 48 ms, `data:` shapes 12 to 24 ms (0.6.0: 1 to 3), layered `%25` escapes after JSON 40 ms (0.6.0: 8). In Chrome, picking a link whose `href` is a megabyte `data:` URL holds the page for 100 to 117 ms, and 583 to 683 ms with five such attributes, where 0.6.0, which did not read such content, took 17 ms; 0.6.0 holds the page 117 to 133 ms (683 to 700 with five) for a plain megabyte query. A megabyte request URL of `it%27s` values costs 29 ms (0.6.0: 20). Low; new with the 0.6.1 rounds. | Not worth it while every shape stays under 150 ms: the layered decode in `splitJson` and the second reading of text a URL is read on across keep these shapes over twice 0.6.0, and both are part of the fixes that hide keys 0.6.0 printed (F20, F40). |
| F69 | `content/overlay.js:317` (`collectRoots`), `:48` (`ROOT_WALK_MS`) | On a page that changes its tree all the time and has many closed shadow roots, the armed overlay costs about three times 0.6.0: over 3 s, 11 to 12 ms against 4 with 2,000 closed roots, and 23 to 24 against 6.5 to 6.7 with 6,000. That is the walk itself, 6 to 7 ms on 6,000 roots once a second, which 0.6.0 never paid: it walked only when placing the overlay and never saw a closed root. Busy pages with open roots cost about half what they did in 0.6.0, and quiet pages at or below it. At 120 Hz (derived, not measured, since headless Chrome stays at 60 frames a second) the walk still lands in an 8.3 ms frame once a second. Low; new with F37 and F51. | Not worth it: the walk is what finds a popover or a dialog in a closed root (F37), and it runs at most once a second. Walking only the roots that changed would need a further observer, which this round did not add. |
| F70 | `tools/build.mjs:657` (`sweepScratch`), `tools/release-check.mjs:140` (`GROUP`) | What a stopped run leaves behind. When the build alone is killed (not its process group) while a child is stuck, that child keeps running with no limit. A build stopped by a signal leaves its temporary folder, a copy of every shipped script (about 0.8 MB), until a build at least an hour later removes it. On a local release check, a `git` or `gh` call that runs out of time is stopped, but what it started keeps running, as in 0.6.0. Low; the release check's as in 0.6.0, the rest new with the build's temporary folders. | Not worth it: a process that is killed runs none of its own code, so only a later build can remove its folder, and only after an hour, since a running build uses each of its folders for one child, within that child's time limit. A group per call on a local run takes the call out of the terminal's reach, so Ctrl+C would leave it running with no limit, as the second round's did (F59). The sweep costs 8 to 10 ms a build with 21,365 entries in the temp directory. |
| F71 | `content/picker.js:2459` (`frameAt`), `:992` (`FRAME_BOXES`) | `frameAt()` reads the box of every frame found before the one under the pointer, and in Chrome the box of a frame that is not drawn is not cheap to read: the first such reads after a hit test lay out skipped `content-visibility: auto` content. With 1,999 frames in skipped content found before the one under the pointer, the first move over it after an arm takes 0.81 s in 0.6.0 and 0.95 s in 0.6.1, and each later move 53 to 58 ms (39 to 57 ms behind 1,999 frames with `display: none`); the page alone takes 0.70 to 0.75 s for the first 1,999 such reads and 47 to 49 ms after that. With the frame under the pointer found first, a move over it takes 3.8 to 3.9 ms. The comment on `FRAME_BOXES` held for drawn frames only, and now says so. Low; also in 0.6.0, found by the last rerun of the 0.6.1 rounds. | S: pass over a frame that `checkVisibility({ contentVisibilityAuto: true })` says is not drawn, which cannot be under the pointer, before reading its box (0.3 to 0.5 ms for 2,000 frames in Chrome). Left for a later round, since the loop stopped at the sixth (see Judgment calls). |

The stage (`tools/panel-stage.html`) cannot model an arm that lands out of order because of the
stage's own artificial delay; the real extension landed 75 of 75 back to back injections in order.
