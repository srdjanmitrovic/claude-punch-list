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

For work on the panel itself there is a faster loop. With the same server running, open
`http://localhost:8000/tools/panel-stage.html`. That is the panel as an ordinary web page
beside the demo page, with `chrome.*` stood in for by `tools/chrome-shim.js`. Capture modes,
the collector, the prompt and persistence all work; reload the page to see a change, and
reload just the panel frame (`__stage.reloadPanel()` in the console) to simulate closing and
reopening the side panel. Captures are a grey placeholder unless a driver supplies
screenshots, which is what `tools/make-media.mjs` does to produce the README's images.

Before opening a pull request:

```bash
npm run build          # validates the manifest and every path it references
npm run prompt         # renders the prompt template, in case you touched it
npm run prompt mixed   # the same, for a report with several items
```

There is no test suite yet. If you add one, please keep it dependency free or make the
dependency a dev only one that `npm run build` does not need.

## Things worth knowing before you change code

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first if you are touching the message flow,
the collector, or anything to do with capture. A few constraints there are not obvious from
reading a single file, and breaking them tends to fail silently rather than loudly:

* `content/collector-main.js` runs in the page's own JavaScript world and has no access to
  `chrome.*`. It also runs on every page the user visits, so a defect there breaks real
  websites. Every wrapper in it must preserve `this`, pass return values through, re-reject
  rejections, and swallow its own errors.
* `content/overlay.js` and `content/picker.js` are re-injected in full on every use. They must
  not declare anything at the top level with `const`, `let` or `class`.
* Content script broadcasts reach every open side panel, not just the one in the same window.
  Filter on `sender.tab.id`.
* Anything that runs before an `await` in the service worker still holds the user gesture.
  Anything after it does not. `chrome.sidePanel.open()` cares about this.
* Screenshots go to disk at capture time, and an item is only persisted once it has a path.
  Discarding an uncopied item deletes its file; the reset after a copy must not, because the
  prompt on the clipboard names every file.
* `shared/prompt-template.js` must render a one item report byte for byte as it did before
  the list existed. `npm run prompt` and `npm run prompt change` are the check.

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
network request. If you have an idea that needs one, open an issue first so we can talk about
it before you spend time on it.
