# Review: Punch List for Claude Code 0.4.0

Reviewed at commit `a0c9335` on 2026-11-15. The analysis was made without changing code. Two
sections at the end, added on 2026-11-16, record what was implemented afterwards and what turned
up while doing it; the 0.6.0 round was recorded in them on 2026-11-17. Line references in the
sections before them point at `a0c9335`.

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
  documentation and Chrome's samples. The fullscreen half was observed for 0.6.0: the overlay stays
  under a fullscreen element (F36).
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
references, and those in the table after it, point at that tree.

### Items 2 and 3 of the top 5

**Tests and CI (improvement 6).** `npm test` runs `node:test` with no dependency: goldens for the
prompt in `test/golden/`, the real collector in a `node:vm` realm against a fake XMLHttpRequest
that behaves as Chrome 156 was observed to, and static checks on every path the manifest, the
worker and the panel name. `.github/workflows/ci.yml` runs it on Node 20 and 24, and `release.yml`
runs it before building.

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
  snapshot while the panel is left alone (F46).

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
  (F37).
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
  300 ms to under 75. What F20 and F24 leave is in the table.

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
* TR11 is not fixed (F53).

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
that round's fixes held and whether anything that worked before had broken. They found 5 new
defects (1 medium). A component that renders a password control printed a secret handed to it under
another name when no control held it, such as a confirm field handed the first password after the
step that held it had unmounted. The site check refused a running collector after a route change
when an include glob had no slash before its text (`*app*`). Frames were picked by their box rather
than by what is drawn there, and one past the first hundred could not be picked at all. And after a
late start, a page whose `fetch` returns a Bluebird promise or another thenable no longer reports
its unhandled rejections, which is kept (F49). A fourth fix round took the rest, each fix followed
by an adversarial check of that fix alone, and those checks found 12 defects in the fixes and
around them (5 medium, one of them older). The shape rule also fired beside fields known only by a
secret name, hiding the ids of every shipping and profile form, and it missed every secret made
only of digits; the frame test modelled clipping by hand, and so passed over fixed frames, frames
under an overflow the viewport takes from `body`, and an `<object>`'s fallback frame. All three
were redone by hand: the shape rule is keyed on password, code and card controls known by type or
autocomplete, with a digit rule beside the last two; the site check asks Chrome's own rule about
URLs the manifest's rules suggest; and the frame test asks the browser itself, once, and only where
the pointer is inside a frame's box. A last check by three skeptics then found 2 medium and 10 low
defects in those. A date beside a card field was withheld, because the digit rule ran before the
exemptions. An exclude that took out the few URLs the site check tried (the root, a pattern's own
path) lost a running collector that the round before had bridged. Among the lows, a pattern's path
was not escaped as Chrome escapes a URL's (`café`, `a"b`), and the picker's rule giving an
`<object>`'s fallback the pointer back beat the page's own `none` and slowed every restyle by about
a quarter. All but one were fixed, each with a test that fails on the tree before it (the one left
is in F50: a frame with a discrete `pointer-events` transition), and the checkers' own Chrome
scripts were then run again on the result. Every props case they built prints or withholds as
documented. The worker's matcher agrees with Chrome on all 7141 manifest variants at 60 URLs, the
ten site cases bridge the running collector, and of the 878 rows where the site check had lost one,
56 remain, all of one stated limit: an include glob that names a scheme is not tried as a path
(`*://*app*`). Every picker case picks what plain Chrome's hit test finds, save the stated limits
(a closed shadow root, a frame past the 2,000th), and a move over a frame costs 13.9 ms at 100 000
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
  shield, under which a menu still loses its hover, and while the pointer is over a frame each move
  restyles the page once (28 ms at 100 000 elements), so that the browser, rather than a model of
  clipping and stacking written by hand, says what is drawn there.
* **Passwords withheld by value.** Withholding every string and number prop of a component that
  renders a secret field hid the titles, totals and steps of every login and checkout form, and
  still printed a password handed to a component that renders no field. Matching the live values of
  the document's secret controls withholds the password wherever it is passed, and judging strings
  by shape in a component that renders a password, code or card control catches what no field
  holds yet. The cost is F48 and about 3 ms more per pick on a page of 60 000 elements.
* **The tooltip's click through, with its 500 ms wait.** The tooltip can be hovered and read
  (UX13), so it covers the row above, and a click there must still reach that row while a double
  click selects a word. Half a second is the default double click time on macOS and Windows. The
  cost: a row picked through its tooltip changes half a second after the click, and F41.
* **No probe at all on a site the matches leave out, and probing only on a matched site's other
  paths.** A page that answers the probe gets a bridge and can put lines of its own in the log, so a
  site the user kept the collector off gets nothing injected. On a declared site, a single page app
  that moved off a declared path keeps the log its collector started with. The cost: on such a
  path a page can answer the probe and learn the extension is installed (F32), and on a site left
  out a collector still running from before the matches were narrowed is not read.

## Found while implementing, not fixed

F21 and F24 to F29 were fixed for 0.6.0, as the previous subsection says: F21 at
`content/collector-main.js:502`, F24 at `shared/prompt-template.js:1314`, F25 at
`shared/prompt-template.js:1761`, F26 at `content/picker.js:1664`, F27 at
`sidepanel/panel.js:3242`, F28 at `background.js:905` and F29 at `background.js:321`. F10, F20
and F30 remain in part. The rows after F30 are the limits that remain after the 0.6.0 round, from
what the fix rounds left not fixed or partial and from the limits they stated. Each says whether
it is older than the round.

| Id | Where | What | Fix |
| :--- | :--- | :--- | :--- |
| F10 | `content/collector-main.js:2072` | A page listener added before the first `open()` that stops `readystatechange` as well as `loadend` still hides a failed request until the object is opened again. Since 0.6.0 stopping `loadend` or `timeout` alone does not: the collector also settles a failed request from its `readystatechange` to DONE, and labels a status 0 end that lasted the timeout as a timeout. Low; also at `a0c9335`. | Not worth a heuristic. |
| F20 | `shared/prompt-template.js:1417` | Shapes the URL scan still does not read: JSON whose keys are written with escapes or single quotes, JSON inside a `data:` URL's content, a `data:` URL that says `;base64` while holding text, and unencoded JSON with a raw `&` (F40). Since 0.6.0 JSON in a parameter, raw or encoded, and links in percent encoded `data:` content are screened. Low. | M |
| F30 | `content/collector-main.js:633` | `serialize()` no longer uses `JSON.stringify` (0.6.0). What remains is the list of an object's keys, which V8 collects whole before handing out the first: about 100 ms for an object of a million keys, in the page's thread. Low; also at `a0c9335`, slower there. | Not fixable from a script: for-in, `Object.keys` and `Reflect.ownKeys` all collect the whole list. |
| F31 | `sidepanel/panel.js:2742` | Chrome looks at the disk at most once every ten seconds, for all downloads together, so a screenshot deleted within about ten seconds of its last look is still copied. A copy whose page read beats Chrome's answer also names the file, and then says so on the receipt. Low; also at `a0c9335`, where nothing was checked after startup. | Not fixable: no API makes Chrome look sooner. |
| F32 | `content/collector-main.js:116`, `content/collector-bridge.js:70` | A page script written against this extension can tell it is installed, by the probe event a running collector answers. It can open a channel of its own and read its log, or push the live bridge's channel out with eight of them. When the extension starts on a tab already open, it can overhear the bridge's channel and answer in the collector's place, and a collector started late takes the page's builtins as they are then. On a declared site's undeclared path it can answer the worker's probe and get a bridge. None of this puts into a prompt more than logging made up lines would. Low; new with CO14 and improvement 9. | Not fixable for code in the page's world: the guard needs a signal both copies of the collector can see there, which the page sees too, and a tab already open has no path between the worlds that a page listener cannot hear. The bridge on undeclared paths is kept on purpose (judgment calls). |
| F33 | `content/collector-main.js:151` | A page can change what its own log says about its start. Once its script runs it can cancel the event the collector sends as it starts, which adds a false late caveat; on a late start into a page still loading it can stop that event or make `document.readyState` lie, which hides the caveat. Another extension whose document_start script makes `dispatchEvent` cancel every event makes a declared collector's log read as partial. Low; new. | Not worth it: it changes only what a page's own log says about itself, not what the log holds, and the event is the one path from the worker's world to the collector. |
| F34 | `content/collector-main.js:956` | A wrapper's `toString` reads `function () { [native code] }`, as V8 writes it for any callable proxy, where the native's reads `function fetch() { [native code] }`. A script looking for wrappers in general can tell. Low; new with CO14, which replaced named wrappers whose source printed. | Not worth it: answering it would mean replacing `Function.prototype.toString`, which every page uses. |
| F35 | `content/collector-main.js:1845` | On a late start, `setTimeout` and `addEventListener` are taken from the natives zone.js keeps under its own names, so recording a request adds no task to an Angular zone. Anything else that replaced them before the start, fake timers for one, is used as it is, and the collector's timer and listeners go through it. zone.js's error plugin, which replaces `window.Error`, was not measured. Low; new with improvement 9. | Not fixable from the page's world: after the page has run, an untouched copy can only come from a new realm (an iframe), which would change the page. |
| F36 | `content/overlay.js:139` | Region cannot be used while an element of the page is fullscreen: the overlay is drawn under it and a drag reaches the page, whether Region was armed before or after. Low; CW3's fullscreen half, also at `a0c9335`, first observed in this round. | Not fixable: Chrome draws a popover outside the fullscreen element under it, even one shown later, and inside the element is no place for it when that element is a video, whose children are never drawn. Screen works. |
| F37 | `content/overlay.js:156`, `content/picker.js:2582` | Closed shadow roots. A modal dialog in one cannot be found, so the overlay is inert under it and a drag can close the dialog. A frame in one keeps the pointer while picking, so a press goes into the frame and nothing is picked. A pick inside one yields its host (PI7). Low; also at `a0c9335`. | Not fixable: a closed root answers null to `shadowRoot`, so the walk, the focus walk and the hit test stop at its host, and the extension cannot put a node inside it, the one place the overlay would not be inert. |
| F38 | `content/picker.js:2148` | A pick gives the page transient user activation: for about five seconds it may open a popup or start playback as if clicked, and it can see the activation in `navigator.userActivation`. It never hears the press. Low; also at `a0c9335`. | Not fixable: Chrome grants it as it dispatches the press, before any listener runs, and nothing withdraws it; spending it (`window.open`, `requestFullscreen`) would change the page. |
| F39 | `content/picker.js:3046` | A page capture listener on `window` added before picking started hears the presses that make the pick, every press of a double click included. Their default actions are still cancelled, and no listener below the window hears them. Low; also at `a0c9335`. | Not fixable: listeners on one target run in the order they were added, across worlds, and the picker can only add its own when it arms. |
| F40 | `shared/prompt-template.js:1417` | In console text, unencoded JSON in a URL value with a raw `&` inside an earlier value leaks a secret key after it, because `maskParams` splits the query at that `&`. Chrome percent encodes quotes in the URLs it records, so request and page URLs never carry it, and the picker screens it (`content/picker.js:1330`). Low; also at `a0c9335`. | S: move the picker's `splitJson` into the shared SECRET URLS block, in both copies at once. |
| F41 | `sidepanel/panel.js:799` | With a system double click time slower than half a second, a double click on a row tooltip slower than that picks the row it covers instead of selecting a word, and its second press lands on whatever the closed tooltip covered. Low; new with UX13. | Not worth it: a longer wait slows every click through the tooltip, and every dismiss, by as much. |
| F42 | `content/collector-main.js:1610` | After a late start on a page where core-js forced its own Promise, each failed or answered fetch calls the page's replaced `then` once. A collector declared at document_start settles through the engine's own `then` and costs such a page nothing. Low; new with improvement 9. | Not fixable from the page's world, as F35: after a late start the `then` on the prototype is whatever the page left there. |
| F43 | `shared/prompt-template.js:1259` | `payment_method_nonce` and other one time payment nonces are not secret names, so a prop or a parameter holding one prints. Low; also at `a0c9335`. | S, left for a change to the word list, which has to land in all three copies at once. |
| F44 | `sidepanel/panel.js:1205` | After a Region drag the panel puts the caret in the field, but the page keeps the keyboard, so typed characters go into the page's focused input until the user clicks the panel. The panel says so under the field. Medium (UX5); also at `a0c9335`, unsaid. | Not fixable from the panel: nothing it can call takes the keyboard, and blurring the page's element on arm would change the page. |
| F45 | `sidepanel/panel.js:2513` | A screenshot whose download record Chrome has erased (the download list was cleared) cannot be asked about, so the copy goes ahead and the receipt names the item as not checked. Low; also at `a0c9335`, unsaid. | Not fixable: no extension API tells whether such a file exists. |
| F46 | `sidepanel/panel.js:2153` | The console and network chips are read again on focus, when the panel is shown and when the pointer comes back, so they stay a snapshot while the panel is left alone. Low (RO11). | M: the collector would push its counts to the panel. |
| F47 | `content/collector-main.js:1119` | A fetch the page's CSP blocks is reported by the browser and in the site's CSP reports with the collector as its source, now named `punch-list`. The prompt says the page's policy blocked it and keeps the page's caller. Low (M4). | Not fixable: any wrapper is the top frame when it calls the native, and deferring the call would change when every request starts. |
| F48 | `content/collector-main.js:2481` | Props are withheld when they hold the value of a secret control in the document and, in a component that renders a password, code or card control, when a string has a secret's shape (8 to 256 characters with no whitespace holding a letter and a digit, or beside a code or card control three digits or more). A value no control holds and of another shape still prints (a passphrase with spaces, a password of letters only or under eight characters), as does any such value handed to a component that renders no such control, and a seed of that kind the user changed in the middle rather than typed onto. In a component the shape rule applies to, an ordinary code of that shape is withheld, such as a coupon code or an order number. A field inside a shadow root is found only when its host element says it takes a secret, and one in a frame not at all. Low; each printed at `a0c9335` too. | Not worth it: the rule knows a secret by the control that holds it, and looking further costs every pick more. |
| F49 | `content/collector-main.js:1671` | After a late start, a fetch promise that is not a plain engine promise (one the page decorated with an `abort` method, a Bluebird promise, a thenable) is handed back as the page's own object and watched on a side chain. Any observer marks a promise as handled, so a rejection the page leaves unhandled no longer fires the page's own unhandled rejection report, and the prompt has no `[unhandled]` line for it, though the failed request is still recorded. Low; new. | Not worth it: handing back a new promise made the page's own calls on it throw (`p.abort`, Bluebird's `.tap`), and rethrowing on the side chain gave two spurious page errors on a page that handles its own rejection. |
| F50 | `content/picker.js:2454` | Picker timing edges. A press in the same animation frame as a page's own assignment of `adoptedStyleSheets`, with no pointer move since, can reach a frame. A popover or dialog in a shadow root hidden and shown again within a quarter second can cover the highlight. Enter held past the tail repeats to the page. A hover menu over a frame whose own CSS beats the sheet loses its hover to that frame's shield. On a page that spaces `body`'s children by margin (`space-y`), the page shifts by 8 px while armed, which is undone before the element is read and photographed. A frame with a discrete `pointer-events` transition (`transition: all .3s allow-discrete`) keeps `none` for half the transition once the sheet is lifted, so the element under it is picked, and the page hears four transition events on each move over it. The fallback content of an `<object>` shows no hover while picking. Low; new with this round, the space-y shift as in 0.5.0, the transition as in the round before (last check, C3). | Not worth it: the sheet comes back on the next frame and at every press, shadow roots are surveyed every 15 frames, repeats after the tail are the user's own, moving the host out of `body` would change where it lives on every page, a transition is the page's own and cutting it would change the page, and giving fallback content the pointer back took the page's own `none` from it and slowed every restyle by a quarter. |
| F51 | `content/overlay.js:186` | The overlay finds open shadow roots when it is placed, so one attached afterwards is seen only at the next placement, and a modal or popover in it can cover the overlay until then. Pressing the shortcut again places it on top. Low; also at `a0c9335`. | Not worth it: the walk takes about 8 ms on a page of 24 000 elements, too much for every frame. |
| F52 | `shared/prompt-template.js:1314` | A URL's user name with no password that reads as words is kept, so a short token of small letters with no digit (`https://xkcdqwertyzpqlm@host`) prints. Low; the price of F24's fix, which kept `git@` and e-mail addresses. | Not worth it: telling such a token from `administrator` needs a dictionary. |
| F53 | GitHub repository settings | The repository's description and homepage still name the old project (TR11). Low. | An owner action: `gh repo edit` with the manifest's description and the new homepage. |
| F54 | `tools/build.mjs:370` | The build reads a method definition whose parameters hold `(` or a line break, a comment between `.` and `import`, and `import(` inside a string as dynamic imports. Low; new with the import check. | Not worth it: each fails the build loudly and never lets a broken import pass. |
| F55 | `shared/prompt-template.js:1785` | A megabyte of console text made of distinct dotted keys (`t.o.k.e.n.`…) took 103 ms to screen in the second fix round, just over the 100 ms the rounds held hostile input to. Not measured since. Low. | S if it matters. |
| F56 | `shared/prompt-template.js:2417` | With the page toggle on, a list gives the log's zone only on the page section's Items captured line, after the items. Low. | S |
| F57 | `sidepanel/panel.js:2414` | Copy takes the banner down when it starts, so on a restricted tab the restriction banner stays away after the copy until the next tab event. Low; older than this round. | S |
| F58 | `sidepanel/panel.js:2494` | After a copy held back by a missing file, the disabled Copy button loses focus to the document body. Low; older than this round. | S |
| F59 | `tools/release-check.mjs:122` | Its `git` and `gh` calls have no timeout, so a hung one holds the release workflow until GitHub's own job limit. Low. | S |

The stage (`tools/panel-stage.html`) cannot model an arm that lands out of order because of the
stage's own artificial delay; the real extension landed 75 of 75 back to back injections in order.
