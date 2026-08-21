<div align="center">

<img src="icons/icon128.png" width="76" alt="">

# Punch List for Claude Code

**Walk through your app. Mark what is wrong and what should change. Hand Claude Code the list.**

A Chrome extension that collects screenshots of the things you notice, one sentence about
each, and the console errors and failed requests behind them, then hands Claude Code a single
prompt containing all of it.

<img src="https://img.shields.io/badge/Manifest-V3-1a1a1f" alt="Manifest V3">
<img src="https://img.shields.io/badge/Chrome-116%2B-1a1a1f" alt="Chrome 116 or newer">
<img src="https://img.shields.io/badge/dependencies-0-c61876" alt="Zero dependencies">
<img src="https://img.shields.io/badge/build_step-none-1a1a1f" alt="No build step">
<img src="https://img.shields.io/badge/license-MIT-1a1a1f" alt="MIT license">

<p>
<a href="#install"><b>Install</b></a>
&nbsp;·&nbsp;
<a href="#how-it-works">How it works</a>
&nbsp;·&nbsp;
<a href="#example-three-items-one-prompt">Example</a>
&nbsp;·&nbsp;
<a href="#what-gets-attached">What it collects</a>
&nbsp;·&nbsp;
<a href="#privacy">Privacy</a>
&nbsp;·&nbsp;
<a href="#make-it-yours">Make it yours</a>
</p>

</div>

<br>

<img src="docs/media/demo.gif" alt="Marking a broken total, a coupon field and the whole checkout in turn, typing a sentence for each, and copying one prompt for all three">

<sub><i>A real run against <code>tools/demo-page.html</code>, the demo page in this repository. Everything on screen is the extension's own code; only the browser is stood in for. See <a href="#development">Development</a>.</i></sub>

<br>

## Why

A punch list is what you compile on a walkthrough before sign-off: every defect and every
change, written down as you find it, handed to whoever does the work. Reviewing your own app
is the same job. You click through a flow and notice five things. Two are broken, three should
be different, and each one on its own is hardly worth a message.

So you send them one at a time, or you do not send them at all. Each one means a screenshot,
a sentence, and, for the bugs, a trip to DevTools for the stack trace you know Claude Code
will ask for. By the third one the context of the first has gone.

This extension keeps a sheet open while you walk. Frame a thing, say what is wrong with it or
what should change, frame the next. When you are done, one click copies a single prompt that
carries every screenshot by path, every sentence, and the console and network evidence that
was collected while you walked. Claude Code opens the images itself.

## Features

* **A sheet, not a shot.** Every capture becomes a numbered item with its own screenshot,
  its own sentence and its own intent. Add as many as the walkthrough needs.
* **Three ways to frame.** Drag a region, click an element, or grab the whole viewport.
  Element captures also bring the node's markup and computed styles.
* **Bugs and suggestions on the same sheet.** Each item is either. The prompt opens with
  "Fix 1 issue and make 2 changes", gives each item the heading that fits it, and closes
  with the instruction that fits each kind.
* **The evidence rides along.** `console.error` and `console.warn`, uncaught exceptions,
  unhandled rejections, failed resource loads, and requests that came back 4xx, 5xx or not at
  all, collected from page load without being asked.
* **One prompt, pasted once.** The screenshots are already on disk with absolute paths.
  Copy is instant and can be repeated. Tick the items that go this time; the rest wait on
  the sheet for the next prompt.
* **Survives the panel closing.** A half-built sheet comes back when the side panel reopens,
  in this window or another, and is dropped after a week untouched.
* **Nothing leaves your machine.** No network code, no accounts, no telemetry. Files go to
  your Downloads folder and text goes to your clipboard.

## How it works

### 1. Frame what you noticed

Drag a region, click a single element, or grab the whole viewport. Press <kbd>Esc</kbd> to
back out. <kbd>Alt</kbd><kbd>Shift</kbd><kbd>C</kbd> opens the panel and arms the region
tool in one go.

<table>
<tr>
<td width="50%"><img src="docs/media/capture-region.png" alt="Dragging a rectangle over a broken total"><br><sub><b>Region.</b> Drag a box around anything.</sub></td>
<td width="50%"><img src="docs/media/capture-element.png" alt="The element picker highlighting a summary row"><br><sub><b>Element.</b> Hover to highlight, click to pick.</sub></td>
</tr>
</table>

Each capture lands in the frame and joins the sheet, the list just above the copy button,
with a tick already in its box. The screenshot is written to `~/Downloads/claude-punch-list/`
at that moment, so the item has a real path from the start and there is nothing left to save
later. **New item** empties the frame without touching the sheet, for when you would rather
line up the next capture against a blank frame than against the last one.

### 2. Say what is wrong, or what should change

Two segments above the field decide which kind of item this is. **Bug** asks Claude Code to
find the root cause before touching anything. **Suggestion** asks it to find where the
behaviour lives and follow the patterns already there, and to propose the smallest version
first if the change turns out to be bigger than it looks. The choice sticks, so a run of
suggestions stays a run of suggestions.

One sentence per item is usually enough, because the console output travels with it.

<table>
<tr>
<td width="50%"><img src="docs/media/panel-light.png" width="380" alt="The side panel in light theme, with three items on the sheet and the whole screen capture selected"></td>
<td width="50%"><img src="docs/media/panel-dark.png" width="380" alt="The side panel in dark theme, with the region capture of the broken total selected"></td>
</tr>
</table>

Each row on the sheet shows its sentence, or says that it has none yet, so a glance shows
what still needs one; hover a row that cut its sentence short to read the whole thing. Click
a row to bring that item back into the frame and its sentence back into the field. The × on
the frame discards the item in it, and its file with it.

Under the field, the **console** and **network** chips count what the page has produced so
far, so a glance tells you whether it has thrown anything yet.

### 3. Copy for Claude Code

One prompt containing every ticked item lands on your clipboard. You paste once. Claude Code
reads each screenshot from its path, works through the items, and says which item each change
belongs to.

The ticks decide what goes. Everything is ticked as it is captured, so the usual walkthrough
is capture, capture, capture, copy. Untick what should wait, or **Clear selection** and tick
just one, and the button says how many are going. A single ticked item is sent as a single
report rather than a list of one. The items that were sent leave the sheet; the rest stay for
the next prompt.

## Example: three items, one prompt

This uses the demo page in this repository (`tools/demo-page.html`), which breaks on purpose,
so you can reproduce every line below yourself.

**What you see.** Click **Apply** on the coupon field and the order total turns into `$NaN`.
While you are there you notice the coupon only validates on submit, and that the Pay button
sits under a field most people never touch.

**What you cannot see.** The cause of the bug is two lines of that page's script, and no
screenshot will ever show them to you:

```js
const entry = CATALOG[code];        // undefined for any code outside CATALOG
const discount = 295 * entry.rate;  // throws, so the total is left holding NaN
```

**What you do.** Drag a box over the total and type a sentence. Pick the coupon field, switch
to **Suggestion**, type a sentence. Grab the screen, type a sentence. Click **Copy for Claude
Code**. Twenty seconds, most of it typing.

**What lands on your clipboard.** Produced by the real template from a real run against that
page, not written by hand:

````markdown
Fix 1 issue and make 2 changes on http://localhost:8000/tools/demo-page.html

Each item has a screenshot on disk. Read that image before working on the item. For a bug it shows the problem as rendered; for a change it shows the current behaviour, which is what the change is measured against.

## 1. What's wrong
The total shows NaN after applying a coupon. It should show the discounted price.

Screenshot: /Users/you/Downloads/claude-punch-list/2026-08-21_18-54-56_localhost-demo-page.png

## 2. What should change
Validate the coupon as you type instead of only on Apply.

Screenshot: /Users/you/Downloads/claude-punch-list/2026-08-21_18-54-57_localhost-demo-page.png

Selected element: `#coupon`
```html
<input id="coupon" placeholder="Coupon code" value="SUMMER25" style="">
```
Computed styles: display: block; width: 242.188px; height: 40.9219px; padding: 9px 11px; box-sizing: border-box; overflow: clip; color: rgb(0, 0, 0); background-color: rgb(255, 255, 255); font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 13.5px; line-height: 20.925px; border: 1px solid rgb(229, 231, 235); border-radius: 7px

## 3. What should change
Move the Pay button above the coupon field. Most people never use a coupon.

Screenshot: /Users/you/Downloads/claude-punch-list/2026-08-21_18-54-58_localhost-demo-page.png

## Page
- URL: http://localhost:8000/tools/demo-page.html
- Title: Checkout | Northbeam Supply
- Viewport: 1100 x 860 @2x
- Captured: 8/21/2026, 6:54:56 PM

## Console output
```
[unhandled] TypeError: Cannot read properties of undefined (reading 'rate')
          at applyCoupon (http://localhost:8000/tools/demo-page.html:184:38)
[warn] Coupon SUMMER25 not found in catalog, falling back to local lookup
```

## Failed network requests
```
POST /api/coupons/validate -> 501 Unsupported method ('POST') (24ms)
```

---
For each bug, find the root cause in this codebase before changing anything, and if the screenshot and the console point at different things, say so rather than guessing. For each change, find where it is implemented before writing anything and follow the patterns already in this codebase rather than introducing new ones; if it is larger than it looks, say so and propose the smallest version that delivers it. Cover every item, and say which item each change belongs to. If several items turn out to share a cause or a fix, say so rather than treating them separately.
````

Just under 2,500 characters, roughly 600 tokens, for three screenshots, a DOM node and a
stack trace.

**Why that beats three messages.** Each item is numbered, so Claude Code can account for all
of them and you can check that it did. The opening line says how much of each kind of work
there is, and the closing line gives the bug instruction and the change instruction side by
side, because neither alone is right for the other. The console section sits once, at the
bottom, next to the items it explains: the file and line that threw, the request that failed
first, and the warning naming the missing coupon. Nobody has to open DevTools.

**A single ticked item** reads as a single report rather than a list, in the same shape this
extension has produced since its first version: a heading, a screenshot section with its own
instruction, the page, the evidence, and the closing that fits the intent. The list layout
only appears once more than one item is going.

**Items from different pages** are handled too. Capture on the cart, click through to the
checkout, capture again: the opening line says "across 2 pages", each item names its own
page, and the page section names the page the console was read on (the tab you are looking at
when you copy) and flags any item that was captured somewhere else.

That computed styles line is thirteen properties out of the roughly 340 `getComputedStyle`
returns. Properties still sitting at their initial value are dropped automatically, so nothing
here is `opacity: 1` filler. If `font-family` and a fractional `height` are not what you debug,
the list is one array to edit.

The prompt wording lives in one file and is likewise meant to be edited. See
[Make it yours](#make-it-yours).

## Install

There are two ways in, both under a minute. Neither goes through the Chrome Web Store, so both
use Developer mode.

### From source, which is also the fastest

```bash
git clone https://github.com/srdjanmitrovic/claude-punch-list.git
cd claude-punch-list
```

1. Open `chrome://extensions`
2. Turn on **Developer mode** (toggle, top right)
3. Click **Load unpacked** and select the `claude-punch-list` folder you just cloned
4. Pin the extension from the puzzle piece menu, so its icon sits in the toolbar
5. Reload any tab you want to work on

Nothing to install and nothing to compile. Loading the folder rather than a zip has a second
benefit: your edits go live. Change a file, press reload on the extension card, and it applies.

### From a release zip

1. Download `claude-punch-list-vX.Y.Z.zip` from the
   [releases page](https://github.com/srdjanmitrovic/claude-punch-list/releases)
2. Unzip it
3. Follow steps 1 to 5 above, picking the unzipped folder at step 3

Requires Chrome 116 or newer.

> **Step 5 is not optional.** Console and network capture works by wrapping `console.error`,
> `console.warn`, `fetch` and `XMLHttpRequest` before the page's own scripts run, which can only happen on a
> page load that occurs after the extension is enabled. On a tab opened earlier, screenshots
> still work, but the context counts show a dash and the panel tells you to reload.

### First run

The repository ships a demo page that breaks on purpose, so you can confirm everything works
without hunting for a real bug.

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000/tools/demo-page.html` in a **new** tab, then:

1. Click **Apply** on the coupon field. The total turns into `$NaN`, and behind it the page
   fires a failing request, a console warning, and an unhandled `TypeError` from the async
   handler.
2. Press <kbd>Alt</kbd><kbd>Shift</kbd><kbd>C</kbd>, or click the toolbar icon and choose
   **Region**.
3. Drag a box over the order summary.
4. Check that the **console** and **network** chips now show counts in magenta. That is the
   collector confirming it caught the error.
5. Type a sentence. Then click **Element**, pick the coupon field, switch to **Suggestion**
   and type another.
6. Click **Copy for Claude Code**, then paste into a Claude Code session.

You should get a markdown prompt with two numbered items, the absolute path to a PNG in
`~/Downloads/claude-punch-list/` under each, the `TypeError` with the frame that threw it, and
the failed request.

### If something does not work

**The counts show a dash.** The tab was open before the extension was enabled. Reload it.

**Every capture opens a "Save as" dialog.** Chrome's "Ask where to save each file before
downloading" setting is on. Turn it off in `chrome://settings/downloads` and saving becomes
instant. The extension cannot override that setting, so it waits and tells you instead. The
item shows SAVING in the meantime and the copy button stays off until every item has a path.

**An item says FILE MISSING.** Its screenshot was deleted from the Downloads folder after it
was captured, which can happen to a sheet that sat for a few days. Discard that item, or
capture it again; the copy button stays off until you do.

**Nothing happens at all.** The service worker has its own console, separate from the page's.
On the extension's card in `chrome://extensions`, click **service worker** to open it. Errors
from `background.js` land there. For the panel itself, right click inside it and choose
**Inspect**.

**The panel says Chrome blocks this page.** That is accurate and unavoidable on `chrome://`
pages, the Web Store, other extensions' pages, and `view-source:`. Open a normal http or https
page. For local files, turn on "Allow access to file URLs" on the extension's card.

## What gets attached

| Toggle | What it adds |
| :--- | :--- |
| **console** | `console.error` and `console.warn` calls, uncaught exceptions with stack frames, unhandled promise rejections, and failed resource loads |
| **network** | Requests that returned 4xx or 5xx or failed outright, with method, URL, status and timing |
| **element** | For each item picked with the element tool: the node's markup, a CSS selector that finds it again, and a curated set of computed styles |
| **page** | URL, title, viewport size and device pixel ratio, plus each item's own URL when the sheet spans more than one page |

Console and network are read once, when you copy, from the tab you are looking at. Element
payloads belong to the item they were picked with and are printed under it. Each toggle is
remembered between sessions, and so is the sheet itself: items, sentences and thumbnails come
back when the panel reopens, and a sheet untouched for a week is dropped at startup. The
files on disk are never touched by that.

## Privacy

Nothing leaves your machine. There is no network code in this extension: screenshots go to
your Downloads folder, the sheet itself (thumbnails, sentences, screenshot paths, page URLs
and any picked element's markup) goes to the extension's own local storage, and text goes to
your clipboard.

The one caveat worth stating plainly is that the collector has to run in the page's own
JavaScript world to wrap the real `console` and `fetch`, and anything in that world is
reachable by the page. Scripts on the page can therefore request the collected buffer. In
practice that buffer holds the page's own console and network activity, which any script
there could already record by wrapping the same functions, so nothing becomes newly
available. It does mean the buffer is not a private channel.

`clipboardWrite` is deliberately **not** requested. Chrome allows sanitized clipboard writes
from extension pages without it, so asking would add the "Modify data you copy and paste"
install warning while buying nothing.

### Restricting it to your own sites

`<all_urls>` appears in `manifest.json` **three** times, and they are separate grants that do
different jobs. Narrowing one and not the others is the mistake to avoid, because each half
fails quietly in its own way.

| Where | What it controls |
| :--- | :--- |
| `host_permissions` | Screenshotting the tab, injecting the overlay and picker, and whether Chrome reveals the tab's URL to the extension at all |
| `content_scripts[].matches`, twice | Where the collector arms, and therefore which sites `console`, `fetch` and `XMLHttpRequest` get wrapped on. This is also what drives the site list in the install warning. |

To limit the extension to the sites you actually work on, change **all three** to the same
list:

```json
"host_permissions": ["http://localhost/*", "https://*.yourcompany.com/*"],

"content_scripts": [
  { "matches": ["http://localhost/*", "https://*.yourcompany.com/*"], "js": ["content/collector-bridge.js"], "world": "ISOLATED", "run_at": "document_start" },
  { "matches": ["http://localhost/*", "https://*.yourcompany.com/*"], "js": ["content/collector-main.js"], "world": "MAIN", "run_at": "document_start" }
]
```

Editing only `host_permissions` leaves the collector still injecting on every page you visit
and still wrapping `console`, `fetch` and `XMLHttpRequest` there, which is usually the exact
thing you were trying to stop. Editing only `matches` leaves capture working nowhere, since
Chrome withholds the URL and the panel reports the page as unreadable.

[Permissions are explained one by one in the architecture notes](docs/ARCHITECTURE.md#permissions).

## Make it yours

**The prompt.** [`shared/prompt-template.js`](shared/prompt-template.js) is the whole contract
with Claude Code, and it is the most useful file to edit. Ordering, tone, and how firmly it
instructs are all yours to set. Two tables and one sentence near the top hold every string
that depends on what kind of sheet this is: `INTENTS` for a bug and for a change, `MIXED` for
a sheet that has both, and `MANY_ITEMS` for the line that asks for every item to be covered.
Nothing else differs between them. To see your changes without reloading anything:

```bash
npm run prompt          # one bug
npm run prompt change   # one suggested change
npm run prompt mixed    # a bug and two changes across two pages
```

That renders the real template against a representative sheet and prints exactly what would
land on your clipboard, plus a rough token count.

**Which computed styles get reported.** `STYLE_PROPERTIES` at the top of
[`content/picker.js`](content/picker.js). It is a shortlist because `getComputedStyle` returns
around 340 properties and dumping them all buries the signal.

**Where screenshots go.** `SAVE_FOLDER` in [`sidepanel/panel.js`](sidepanel/panel.js), relative
to your Downloads directory.

**How long an uncopied sheet is kept.** `REPORT_TTL_MS` in the same file, currently a week.

**How much history the collector keeps.** `LIMIT` in
[`content/collector-main.js`](content/collector-main.js), currently the last 30 entries per
category.

## Development

There is no build step. Edit a file, then press reload on the extension card in
`chrome://extensions`. Content script changes also need a page reload. Side panel changes need
the panel closed and reopened.

For work on the panel there is a faster loop. Serve the repository and open
`http://localhost:8000/tools/panel-stage.html`: that is the panel running as an ordinary web
page beside the demo page, with `chrome.*` stood in for by `tools/chrome-shim.js`. Capture
modes, the collector, the prompt and persistence all work, and reloading the page is the whole
cycle. It is also where the images in this README come from, so they can be regenerated rather
than redrawn:

```bash
npm run build     # package dist/claude-punch-list-vX.Y.Z.zip for a release
npm run prompt    # preview the prompt template with sample data
npm run icons     # regenerate the PNG icons from tools/make-icons.py

node tools/make-media.mjs    # screenshots and GIF frames; needs Playwright and the server above
python3 tools/make-gif.py    # frames to docs/media/demo.gif; needs Pillow
```

`npm run build` needs no `npm install`. There are no dependencies: the packager writes the zip
itself so it behaves identically on macOS, Linux and Windows, and produces a byte identical
archive for the same input so release checksums are reproducible. Playwright and Pillow are
needed only for the media scripts, and neither is declared anywhere.

[How the pieces fit together](docs/ARCHITECTURE.md), including why the collector is split in
two, why the heavy lifting lives in the side panel rather than the service worker, and why
screenshots are saved the moment they are taken.

## Roadmap

Honest about what is not built yet.

* **Reordering the sheet.** Items are numbered in the order they were captured. Dragging a
  thumbnail to move it is the obvious next step.
* **Marking up a capture.** An arrow or a circle on the screenshot itself, for the cases where
  "the second one from the left" is not good enough.
* **Full page screenshots** that scroll and stitch. Sticky headers repeat, lazily loaded
  content shifts under you, and the capture rate limit forces roughly half a second per
  viewport. Region capture covers most real cases.
* **Framework component names.** Reading a React fiber or Vue instance off a DOM node needs
  main world access, which the collector already has. Wiring the picker through it would let
  the prompt name the component instead of only the selector.

## Contributing

Issues and pull requests are welcome. [Start here](CONTRIBUTING.md).

If you are reporting a bug in this extension, the extension can report it for you.

## License

MIT. See [LICENSE](LICENSE).

<div align="center">
<br>
<sub>Not affiliated with Anthropic. Claude and Claude Code are products of Anthropic.</sub>
</div>
