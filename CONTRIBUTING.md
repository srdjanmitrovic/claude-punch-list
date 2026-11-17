# Contributing

Thanks for taking a look. This is a small, deliberately dependency free project, so getting
set up takes about a minute.

## Getting started

```bash
git clone https://github.com/srdjanmitrovic/claude-punch-list.git
cd claude-punch-list
```

Open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and select the
repository folder. There is nothing to install and nothing to compile.

To reload after a change:

| You changed | What to do |
| :--- | :--- |
| `background.js` | Press reload on the extension card |
| `sidepanel/*` | Close and reopen the side panel |
| `content/*` | Press reload on the card, then reload the page |
| `manifest.json` | Press reload on the card |

## Testing a change

Serve the repository and open the demo page, which breaks on purpose:

```bash
python3 -m http.server 8000
# then open http://localhost:8000/tools/demo-page.html
```

Clicking **Apply** on that page fires a failing request, a console warning, and an uncaught
`TypeError`. That gives the collector real data to pick up, so you can verify a change end to
end rather than against an empty buffer.

Two more fixtures sit beside it. `tools/demo-react.html` and `tools/demo-vue.html` render a
small component tree so the element picker's component lookup has something to read; the stage
loads either with `?demo=demo-react.html` or `?demo=demo-vue.html`. Both pull their framework
from a CDN, which is fine for a fixture and would not be fine in the extension. Nothing under
`tools/` is packaged.

For work on the panel itself there is a faster loop. With the same server running, open
`http://localhost:8000/tools/panel-stage.html`. That is the panel as an ordinary web page
beside the demo page, with `chrome.*` stood in for by `tools/chrome-shim.js`. Capture modes,
the collector, the prompt and persistence all work; reload the page to see a change, and
reload just the panel frame (`__stage.reloadPanel()` in the console) to simulate closing and
reopening the side panel. Captures are a grey placeholder unless a driver supplies
screenshots, which is what `tools/make-media.mjs` does to produce the README's images.

Before opening a pull request:

```bash
npm test               # the tests below; CI runs the same command on every push and pull request
npm run build          # packs what git tracks, after checking every path, import and parse
npm run prompt         # renders the prompt template, in case you touched it
npm run prompt mixed   # the same, for a report with several items
npm run prompt minified # the same, for a production build with no real component name
npm run prompt reloaded # any other sample, by the name of its file in test/golden
```

The tests use `node:test`, which ships with Node, so there is nothing to install. They live in
`test/`:

* `test/prompt.test.mjs` renders the template against the samples in `tools/preview-prompt.mjs`,
  plus every variation in its `EXTRA` table, which the preview also renders by name, and compares
  each prompt byte for byte with a file in `test/golden/`. If you change the prompt on purpose,
  run `UPDATE_GOLDEN=1 npm test` and commit the regenerated files with the change, so the diff
  shows exactly what Claude Code will now read.
* `test/collector.test.mjs` runs `content/collector-main.js` in a fresh `node:vm` realm and holds
  every wrapper to the rules below.
* `test/bridge.test.mjs` runs `content/collector-bridge.js` and `content/collector-main.js`
  together in one `node:vm` realm: the handshake over the bridge's channel whichever half starts
  first, what the bridge does with an answer that is not the collector's, the fallback to
  `window.postMessage` for a collector of 0.5.0 still running in a tab, and the page facts it
  hands the panel.
* `test/picker.test.mjs` runs the picker's masking block, lifted out of `content/picker.js`
  between its `MASKING BEGIN` and `MASKING END` markers, against markup a picked form produces.
* `test/picker-events.test.mjs` runs `content/picker.js` in a `node:vm` realm against a model of
  the page. The model keeps to behaviour observed in Chrome 156, listed at the top of the file:
  frames take every pointer event over them unless an adopted style sheet of their tree gives
  them `pointer-events: none`, disabled controls get pointer events and no mouse events, `:hover`
  moves at a frame, everything outside an open modal dialog is inert, a closed shadow root hides
  what is inside it, and window listeners run in the order they were added. When the picker
  comes to rely on another browser behaviour, check it in Chrome first, then add it to the model
  with a note of where it was seen.
* `test/capture.test.mjs` runs `content/overlay.js`, `content/stop.js` and a second injection of
  `content/collector-bridge.js` in a `node:vm` realm against a stub DOM that keeps a tree,
  listeners and a top layer and lays nothing out (how the overlay looks was checked in Chrome),
  runs the crop lifted out of `sidepanel/panel.js` against a canvas that records what it draws,
  and holds the worker and the panel to who may ask for what: a content script cannot arm,
  disarm or start a collector, closing the panel disarms the tab it held, and a tab with no
  collector gets one only where the manifest declares one.
* `test/worker.test.mjs` runs `background.js` in a `node:vm` realm against a model of the pages
  it injects into (`test/support/worker-realm.mjs`), and holds the worker to its ordering rules:
  an arm against the disarm that cancels it and against an older arm, a capture message against
  the arm after it, and a probe against the change it asks about.
* `test/panel.test.mjs` runs `sidepanel/panel.js` against a stub of the DOM
  (`test/support/panel-realm.mjs`), with each test playing the worker, and checks which mode is
  lit and what a Screen capture says when replies and broadcasts arrive in an unlucky order.
* `test/panel-ui.test.mjs` runs the panel in the same realm, with `panel.html` and `panel.css`
  read as text, and checks what it says and where the keyboard goes: the live regions, the line
  under Copy, the shortcut Chrome has bound, the contrast of muted text in both themes, the row
  tooltip, the chips, and the keys handed on to the page while a mode is armed.
* `test/sheet.test.mjs` runs one panel realm per window over one shared storage and one downloads
  list, as the side panels of two windows share them in Chrome, and checks what survives two
  windows writing at once, which files a discard, a copy or the weekly expiry deletes, and what
  the panel says about a file it cannot find.
* `test/static.test.mjs` checks what would otherwise only fail in Chrome: every file the manifest,
  the worker and the panel name exists, every file parses, the re-injected capture scripts
  declare nothing at the top level, the copies of the secret name blocks agree, and `PRIVACY.md`
  says what the Chrome Web Store needs it to.
* `test/build.test.mjs` runs `tools/build.mjs` on copies of the tree in a temporary folder and
  reads the zips it writes: LICENSE is in them, a file git does not track is not, CRLF line
  endings change nothing, a broken path, an import Chrome could not link, an `import()` whose path
  the build cannot check, a syntax error or a file in an unresolved merge conflict fails the
  build, git converts exactly the shipped files the build packs as text, and the archive for a
  fixed input has a pinned checksum, so CI on two Node versions shows it does not depend on the
  Node or the zlib that built it. It also holds
  `tools/release-check.mjs` to the release rules below, against throwaway git repositories, and
  the stage's download fake to Chrome's ids.

None of this runs Chrome. The worker and panel realms model the order in which Chrome was seen to
run injections and deliver messages, and the picker's page model keeps to what Chrome was seen to
do with events, so they catch a broken rule but not a change in Chrome. The stage and a real
install are still the check for anything visual, for timing, and for how the panel and the page
hand focus back and forth. Keep any new test dependency free, or make the dependency a dev only
one that `npm run build` does not need.

## Things worth knowing before you change code

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first if you are touching the message flow,
the collector, or anything to do with capture. A few constraints there are not obvious from
reading a single file, and breaking them tends to fail silently rather than loudly:

* `content/collector-main.js` runs in the page's own JavaScript world and has no access to
  `chrome.*`. It also runs on every page the user visits, so a defect there breaks real
  websites. Every wrapper in it must preserve `this`, pass return values through, re-reject
  rejections, and swallow its own errors. Wrap a native with `wrapNative()`, a Proxy with only an
  apply trap, rather than a named function, so the wrapper keeps the native's name, length and
  `toString`. The collector's own stack frames are recognised by its address, not by function
  names. The log goes to the bridge over its channel and never over `window.postMessage`. While a
  request on that channel is answered, read and send events only through the natives taken at
  the top of the file (`detailOf`, `newEvent`, `cancel`), and add to an array with `append()`
  rather than `push` or an index: a getter or a setter the page put on a prototype would
  otherwise run with the request, and so the channel's name, on `window.event`.
* The last line of `content/collector-main.js` is a hand written source map that puts the file on
  DevTools' ignore list. Without it, DevTools links every `console.warn`, `console.error` and
  failed request on every page to the collector instead of the page's own code. The same map
  sends links into the collector itself to a placeholder file, so to debug the collector, turn
  off **JavaScript source maps** in DevTools settings for the session, or delete the line
  locally. `npm test` fails if the line goes missing.
* Above that source map, `content/collector-main.js` declares
  `//# sourceURL=punch-list://extension/collector-main.js`. Chrome reports a console message whose
  topmost frame is in a `chrome-extension` URL in detail, capturing and formatting the whole stack
  again, and every `console.error` and `console.warn` a page makes reaches the native from the
  collector's wrapper. Measured in Chrome for Testing 156 with no DevTools attached, that cost
  about 148 microseconds a call under the extension's own address, against 3 microseconds without
  the extension, and the sourceURL brings it back to the second figure. Stacks and console
  messages therefore name `punch-list://extension/collector-main.js`, a CSP report gives
  `punch-list` as the source, and the collector's own frames are recognised by that whole
  address. The file name sits in the path because DevTools names a script by its path, so with
  source maps off the collector shows as `collector-main.js` (with no path it showed as
  "(index)", like the page's own document). `npm test` fails if the line goes missing, names
  another scheme or names another file.
* `content/overlay.js`, `content/picker.js` and `content/stop.js` are re-injected in full on
  every use. They must not declare anything at the top level with `const`, `let` or `class`.
* What counts as a secret is written down three times, between `SECRET NAMES BEGIN` and
  `SECRET NAMES END` in `content/collector-main.js`, `content/picker.js` and
  `shared/prompt-template.js`, because two of those are injected into the page and cannot import
  the third. Change all three together (the url block likewise, in the picker and the template);
  `npm test` fails if they differ. The collector judges names with `isSecretNameIn`, a copy of
  `isSecretName` written without any method the page can replace, so a change to the rules of
  `isSecretName` must be made there too; `test/collector.test.mjs` fails until the two agree. The
  README's privacy section lists what is screened and what is not, and should change with them.
* The picker reads a React fiber or a Vue instance by asking `content/collector-main.js`, because
  those live on the node as properties only the page's own JavaScript world can see. The node
  crosses the boundary as a temporary `data-cdr-pick` attribute, since the DOM is shared and the
  property is not. Both sides remove that attribute, including on the timeout path.
* Content script broadcasts reach every open side panel, not just the one in the same window.
  Filter on `sender.tab.id`.
* A content script runs in a page that may be hostile. The worker acts on the messages only the
  panel sends (`PANEL_MESSAGES` in `background.js`) and on the `cdr:panel` port only when they
  come from one of the extension's own pages, and it closes `chrome.storage.local` to content
  scripts at every start. A new message of that kind belongs in `PANEL_MESSAGES`.
* Anything that runs before an `await` in the service worker still holds the user gesture.
  Anything after it does not. `chrome.sidePanel.open()` cares about this.
* Screenshots go to disk at capture time, and an item is only persisted once it has a path.
  Discarding an uncopied item deletes its file once the undo lapses, and the weekly expiry
  deletes the files of the sheet it drops; the reset after a copy must not, because the prompt on
  the clipboard names every file. Before deleting a file or trusting what Chrome says about it,
  hold the download record to the item (`recordFor` in `sidepanel/panel.js`): Chrome hands
  download ids out again.
* `shared/prompt-template.js` must render a one item report byte for byte as it did before.
  `npm test` is the check: the goldens in `test/golden/` are that "before", and a deliberate
  change to them belongs in the same commit as the change to the template.

## Releasing

A version is released once and names exactly one build. Its tag is `v<version>`, from
`manifest.json`.

1. In the change that alters what ships (anything under `content/`, `shared/`, `sidepanel/` or
   `icons/`, `background.js`, `manifest.json` or `LICENSE`), bump `version` in both
   `manifest.json` and `package.json`. `npm test` fails if the two differ.
2. Merge it to `main`. The release workflow sees a version with no tag, runs the tests, builds the
   zip, tags that commit `v<version>` and publishes the release with the zip and its checksum.

`tools/release-check.mjs` decides what each run of the release workflow does, and
`node tools/release-check.mjs --check` asks it locally. A run on `main`, from a push or started
by hand, follows the same rules:

* a version with no tag yet is tagged at this commit and released;
* a tagged version whose shipped files are unchanged since the tag is released from the tag if it
  never got a release, and otherwise the run does nothing;
* a tagged version whose shipped files have changed since the tag fails, whether or not the tag
  got a release, with a message saying to bump the version. When the tag never got a release, the
  message also says how to release the build the tag names: run the release workflow from the
  tag. When the run cannot ask GitHub whether the tag has a release, it still fails, and its
  message says only that the version is tagged.

What ships means the files and also which files they are, so adding a path to `INCLUDE` in
`tools/build.mjs` needs a version bump too, even when the file it adds has not changed. A run
started by hand on any other branch fails. Pushing the tag `v<version>` yourself releases the
commit it points at, from whichever branch, unless that tag already has a release; a tag that
does not match the manifest's version fails. A run started by hand from a tag does what pushing
that tag does. CI applies the third rule to every pull request into `main`, so a change that
ships something under a version already tagged hears about it before it merges. CI's check never
asks GitHub, so its message says only that the version is tagged, and never offers the way out
through the tag. A change that ships nothing (docs, tests, tools) needs no bump.

Before it writes the zip, the build checks every path the manifest, the worker and the panel
name, links every module without running it, and parses every script. It also reads every dynamic
`import()` in a shipped script. A quoted path, or a template with nothing put into it, is checked
as a static import is, with white space or comments allowed between `import` and its `(`. Any
other path fails the build, and so does an `import()` in a file the build does not follow as a
module (a content script, for example), because it cannot check what such an import would load.
A method named `import` is no import, whether called (`loader.import(...)`) or defined
(`import(name) {`). A definition whose parameters hold a `(` or a line break, a call with a
comment between its `.` and `import`, and an `import(` inside a string or a comment are still read
as imports, which can fail a build but never lets a broken one pass.

The zip is reproducible. `node tools/build.mjs` packs only what git tracks (and says what it left
out, or what was edited since the last commit), packs text with LF line endings whatever the
checkout holds, and writes its own deflate stream (`tools/deflate.mjs`) rather than using the
zlib Node was built with, so a checkout of a tag gives the release's checksum on any machine.
zlib only reads each stream back before the zip is written, which fails the build if the
compressor ever produces one that does not inflate to the file. A change to the zip
writer or the compressor changes every checksum for the same input, which is why
`test/build.test.mjs` pins one.

A file in an unresolved merge conflict stops the build, since what is on disk is not any
commit's. `.gitattributes` converts exactly the files the build packs as text (the extensions in
`TEXT_EXTENSIONS` in `tools/build.mjs`, and `LICENSE`) and leaves every other file in the shipped
folders as it is, so an image or a font added there is committed intact; `test/build.test.mjs`
fails if the two lists part, so an extension added to `TEXT_EXTENSIONS` goes into
`.gitattributes` in the same change.

## Style

Match the file you are editing. Broadly: plain modern JavaScript, no framework, no build step,
two space indent, and comments that explain a constraint the code cannot show rather than
restating what the next line does.

Design changes should read against the notes at the top of `sidepanel/panel.css`. The palette
is deliberately two colours, and registration magenta means one specific thing.

## Reporting bugs

Open an issue with what you expected, what happened, the page you saw it on if it is public,
and your Chrome version.

If the bug is visual, this extension can report it for you. That is a genuinely useful smoke
test of the tool, and the output is exactly the context a maintainer wants.

## Scope

Some things are intentionally out of scope for now: a full page scroll and stitch capture, any
server component, and telemetry of any kind. Nothing in this extension should ever make a
network request. The React and Vue fixtures under `tools/` load a framework from a CDN, which is
the one exception and only because they are test pages that never ship. If you have an idea that
needs one, open an issue first so we can talk about it before you spend time on it.
