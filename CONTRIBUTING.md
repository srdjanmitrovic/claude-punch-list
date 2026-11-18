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

The tests use `node:test`, which ships with Node, so there is nothing to install but Node 22 or
newer, as `package.json` asks (`engines` is `>=22`). CI runs them on Node 22 and 24, the lines
still supported. They live in `test/`:

* `test/prompt.test.mjs` renders the template against the samples in `tools/preview-prompt.mjs`,
  plus every variation in its `EXTRA` table, which the preview also renders by name, and compares
  each prompt byte for byte with a file in `test/golden/`. If you change the prompt on purpose,
  run `UPDATE_GOLDEN=1 npm test` and commit the regenerated files with the change, so the diff
  shows exactly what Claude Code will now read.
* `test/collector.test.mjs` runs `content/collector-main.js` in a fresh `node:vm` realm and holds
  every wrapper to the rules below, and the name it answers while Element hovers to the brief
  contract below: what it reads and what it leaves alone, a bounded walk, nothing thrown into the
  page, and the same name a pick reports.
* `test/bridge.test.mjs` runs `content/collector-bridge.js` and `content/collector-main.js`
  together, each in a `node:vm` realm of its own over shared events and nodes (`makeWorlds` in
  `test/support/worker-realm.mjs`), as two worlds of one page: the handshake over the bridge's
  channel whichever half starts first, what the bridge does with an answer that is not the
  collector's, the fallback to `window.postMessage` for a collector of 0.5.0 still running in a
  tab, the page facts it hands the panel, and the counts it posts on the panel's `cdr:counts`
  port: as they change, at most four times a second, again at every read, and nothing while no
  port is open, with the ports it closes when it stops watching, also against a page that floods
  the change event or answers in the collector's place. It also asks a component's name from the extension's world as the picker
  does while it hovers, on a node each world wraps on its own: answered before `dispatchEvent`
  returns, read off the page's wrapper, copied as it crosses, and never with the log's channel
  on `window.event`.
* `test/picker.test.mjs` runs the picker's masking block, lifted out of `content/picker.js`
  between its `MASKING BEGIN` and `MASKING END` markers, against markup a picked form produces.
* `test/picker-events.test.mjs` runs `content/picker.js` in a `node:vm` realm against a model of
  the page. The model keeps to behaviour observed in Chrome 156, listed at the top of the file.
  Frames take every pointer event over them unless an adopted style sheet of their tree gives
  them `pointer-events: none` and no `!important` rule of the page's beats it. Disabled controls
  get pointer events and no mouse events, `:hover` moves at a frame, and everything outside an
  open modal dialog is inert. A closed shadow root hides what is inside it from the page but not
  from `chrome.dom`. Window listeners run in the order they were added. A press or key grants
  transient activation that `showPicker()` spends. An event sent on an element reaches the
  window's capture listeners at once, and gets out of a shadow root only when it is composed. A
  popover's `toggle` goes no further than its own tree, and a frame's discrete transition of
  `pointer-events` holds its old value for half its time. A test that needs the press gate runs `content/press-gate.js` in the realm first.
  When the picker comes to rely on another browser behaviour, check it in Chrome first, then add
  it to the model with a note of where it was seen.
* `test/capture.test.mjs` runs `content/overlay.js`, `content/stop.js` and a second injection of
  `content/collector-bridge.js` in a `node:vm` realm against a stub DOM that keeps a tree,
  listeners, a top layer, a fullscreen element and shadow roots (closed ones behind a stand in for
  `chrome.dom.openOrClosedShadowRoot`) and a clock that each frame moves on by one frame of a
  display at 60 Hz or another rate, and lays nothing out (how the overlay looks was checked in
  Chrome), runs the crop lifted out of `sidepanel/panel.js` against a canvas that records what it
  draws, and holds the worker and the panel to who may ask for what: a content script cannot arm,
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
  tooltip, the chips and the port that keeps them current, where focus goes after a copy, and the
  keys handed on to the page while a mode is armed.
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
  the build cannot check, a phase import, a syntax error or a file in an unresolved merge conflict
  fails the build, an import check that never answers is stopped and named, a temp directory the
  build cannot use fails it in words, a build removes the folders of builds stopped an hour
  before, git converts exactly the shipped files the build packs as text, and the archive for a
  fixed input has a pinned checksum, so CI on Node 22 and 24 shows it does not depend on the Node
  or the zlib that built it. Each build runs with its stdin not connected and a limit of 60 s, and
  its children with one of 15 s, so a stuck child is stopped by the build, which then removes its
  folder. It also holds `tools/release-check.mjs` to the release rules below, against throwaway
  git repositories, including a `git` or `gh` that never answers and leaves a child of its own
  running, Ctrl+C on a local run, a tag lookup git cannot answer and a version file that is not
  JSON. It holds the workflows to the Node versions `package.json` allows, every workflow job to a
  time limit, and the stage's download fake to Chrome's ids.

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
  `chrome.*`. It also runs on every page the user visits, so a defect there breaks real websites.
  Every wrapper in it must preserve `this`, pass return values through, re-reject rejections, and
  swallow its own errors. Wrap a native with `wrapNative()`, a Proxy with only an apply trap,
  rather than a named function, so the wrapper keeps the native's name and length, and its
  `toString` says `[native code]` (with no name, as V8 prints any callable proxy, where the
  native's names itself: `function fetch() { [native code] }`). The collector's own stack frames
  are recognised by its address, not by function names. The log goes to the bridge over its
  channel and never over `window.postMessage`. While a request on that channel is answered, read
  and send events only through the natives taken at the top of the file (`detailOf`, `newEvent`,
  `cancel`), and add to an array with `append()` rather than `push` or an index: a getter or a
  setter the page put on a prototype would otherwise run with the request, and so the channel's
  name, on `window.event`. The collector tells a watching bridge that a ring grew
  (`countsChanged`) only from `push()`, never from inside a request handler, for the same reason,
  and only when 1,600 more calls fit on the stack (`roomToTell`): with less, Chrome could fail to
  call the bridge's listener at all and report the failure in the tab as the extension's. A change
  it could not tell then is told with the next entry, into a full ring too (`owed`). A ring a push
  left long is cut back in one pass, never by a search of the ring per entry, which froze a page
  for seconds.
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
  those live on the node as properties only the page's own JavaScript world can see. At a pick the
  node crosses the boundary as a temporary `data-cdr-pick` attribute, since the DOM is shared and
  the property is not. Both sides remove that attribute, including on the timeout path. Hovering
  writes nothing: the picker sends `__cdr_name` on the node itself, and the collector answers on
  the window before `dispatchEvent` returns (see
  [The name while hovering](docs/ARCHITECTURE.md#the-name-while-hovering)). Keep that listener on
  its public type. On the bridge's channel, page code that runs during the answer would read the
  channel's name off `window.event`.
* Every framework reader goes behind `componentOf(node, brief)` in `content/collector-main.js`,
  the one place both a pick and the hover ask, in the order the readers are tried. With `brief`
  set it is answering the hover, as often as once a frame, and a reader must then keep to this
  contract:
  * it reads names only (`framework`, `names`, and `renamed` where it applies), so no props and
    no guard;
  * it does no work across the whole document: no `querySelectorAll` or `getElementsByTagName`
    of it, and no walk of its shadow roots;
  * it calls no function of the page's or of its framework's (a read can still run a getter the
    page planted, as at a pick);
  * it looks at a fixed number of nodes, however large the page is: `CLIMB_LIMIT` elements up
    from the node, `CLIMB_LIMIT` steps up the framework's own tree, and at most `SUBTREE_LIMIT`
    nodes of a walk down the component's own render tree (as Vue 2's reader walks its vnodes to
    learn which component wrote an element);
  * its `names[0]` and `renamed` are the ones it gives without `brief`, so the tag shows the name
    the item's Component line starts with.

  A reader that cannot keep to it answers `null` when `brief` is set, and is then simply not asked
  while hovering. `test/collector.test.mjs` holds React and Vue 3 to it, and a new reader needs
  the same tests: that its brief path reads no prop and nothing of the document, and that the
  nodes it looks at stay within those bounds, where a walk down the render tree is counted
  against `SUBTREE_LIMIT`.
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

Each `git` and `gh` call the check makes is stopped after a minute, and the run then fails and
names the call in one line, so a hung one cannot hold the release workflow until GitHub's own six
hour limit. On CI (`GITHUB_ACTIONS` is `true`, or `CI` is set) each call runs in a process group
of its own, and what it started is stopped with it, except on Windows, which has no process
groups. Locally the call stays in the terminal's group, so Ctrl+C stops it with the check, and a
call that runs out of time is stopped while what it started itself keeps running, as in 0.6.0. The
tag lookup takes only git's exit 1 to mean the version is not tagged; any other failure, such as
git finding no repository, fails the run instead of releasing. A `manifest.json` or `package.json`
that is not valid JSON is named, as a `SyntaxError`. The version check and the release build run
on Node 24, and every workflow job has a time limit of its own (15 minutes for the tests and the
version check, 20 for the release).

Before it writes the zip, the build checks every path the manifest, the worker and the panel name,
links every module without running it, and parses every script. It also reads every dynamic
`import()` in a shipped script. A quoted path, or a template with nothing put into it, is checked
as a static import is, with white space or comments allowed around the `(` and the path. Any other
path fails the build, and so does an `import()` in a file the build does not follow as a module (a
content script, for example), because it cannot check what such an import would load. A method
named `import` is no import, whether called (`loader.import(...)`) or defined (`import(name) {`),
nor is a private `#import`, nor an `import(` inside a string, a comment, a template or a regular
expression. The build finds every `import` followed by `(` in the text, with any comment
JavaScript allows between them, trying the pattern at each keyword `import` on its own, so a match
that starts at an earlier one (`obj.import-->`, or `"import //"` in a string) cannot run on
through a real `import()` and hide it. It then asks V8 which of them are imports. One is when the
file parses as it is and stops parsing once that `import` is spelled `class `, since `class (` is
never an expression while a method named `class` parses as well as one named `import`. In a file
that does not parse, each one found counts, which can add a problem to a build that fails anyway
but never lets a broken import pass. A phase import fails the build whatever Node runs it: a
static `import source` or `import defer`, read from V8's own record of the module's imports, in a
module the build follows and in one nothing imports, and a dynamic `import.source()` or
`import.defer()`, found the same way as `import()`. Chrome 156 refuses all of them, while Node 24
parses the source phase, so without this check the release build on Node 24 passed a panel Chrome
cannot load. Line numbers in the build's messages count line feeds only, so after a lone carriage
return, U+2028 or U+2029 they differ from V8's.

The build's children take no input through a pipe. The import check runs as a child process
(`node --experimental-vm-modules tools/build.mjs --link`) that reads every script from a JSON file
in a new temporary folder and writes its answer to a file there. Its stdin and stdout are not
connected, and the folder is removed when it ends. Data handed to a child on stdin through
`spawnSync`'s `input` now and then never arrived on macOS, and the build then waited for good.
Every child has a time limit of 120 s, after which it is killed and the build fails saying
which. Node's own syntax check (`node --check`) runs only for a module V8 refused, to find the
line of the error, since V8's message from `vm.SourceTextModule` gives none. A temporary folder
that cannot be made or written (no such `TMPDIR`, a full disk) fails the build with one line per
check that could not run, and no stack. A build stopped by a signal (Ctrl+C, a kill) never
removes its folder, which holds a copy of every shipped script, so each build first removes the
`punch-list-build-` folders in the temp directory that were last changed over an hour ago.

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
