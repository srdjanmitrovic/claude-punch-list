# Privacy policy

Punch List for Claude Code is a Chrome extension. This page says what it reads, where it keeps
what it reads, and for how long. It applies to every version published from
[this repository](https://github.com/srdjanmitrovic/claude-punch-list).

**In short: nothing leaves your computer.** The extension makes no network requests of any
kind. It has no server, no account, no analytics and no telemetry, and it loads no code from
anywhere. What it collects goes to three places on your own machine: your Downloads folder,
the extension's local storage in Chrome, and, when you ask for it, your clipboard. Where that
text goes after you paste it is up to you.

Punch List for Claude Code is an independent project. It is not affiliated with, endorsed by
or sponsored by Anthropic. Claude and Claude Code are products of Anthropic.

## What it reads

**On every page you open**, a small script (the collector) starts when the page loads and
records, in the page's own memory (on a tab that was already open when the extension was
installed or enabled, it starts instead when the side panel first shows that tab):

* calls to `console.error` and `console.warn`, uncaught errors and unhandled promise
  rejections, with their stack frames;
* resources that failed to load (an image, a script, a stylesheet), by address;
* requests made with `fetch` or `XMLHttpRequest` that failed or returned an error status, with
  their method, address, status, timing and the function in the page that made them.

It keeps the newest 30 entries of each kind. The record lives in that page's memory and goes
when the page is closed or reloaded. The extension reads it only from the side panel, to show
its counts and to build the prompt when you copy, together with the page's address, title,
window size and pixel ratio. While the side panel is open and shown on a tab, the extension's
script in that page also sends the panel the two counts whenever they change, and nothing else
from the record. The README shows how to keep the collector to the sites you name,
in tabs that were already open as well as in new ones. On a site you leave out, the extension
puts nothing in the page to collect, not even a check for a collector already there. On a site
you keep, a page at a path you leave out gets that check, so a collector already running there
(a single page app that moved from a page you kept) is still read.

Beside the collector, a second small script listens on the page for presses and keys, so that
the element picker hears them before the page's own scripts do. It does nothing with them unless
you are picking an element or have just picked one: it reads, keeps and sends nothing. It runs
wherever the collector is set to run, in pages loaded since the extension was installed or
enabled.

While you are picking an element, the extension also reads, in the page, the name of the React
or Vue component behind the highlighted element, and shows it beside the highlight. It does so
each time the highlight moves to another element, by the pointer, Tab or the arrow keys, keeps
nothing of it and sends nothing. The name goes into an item only if you pick that element, as
part of what Element takes, below.

**When you capture something** with Region, Element or Screen, the extension takes:

* a screenshot of the visible part of the tab, cropped to what you framed;
* the page's address and title, and the size of the window;
* with Element, the element you clicked: a selector that finds it again, its markup and
  attributes, some of its computed styles, its visible text, and, on a React or Vue page, the
  name of the component that rendered it, that component's props, and the names and first
  statements of the event handlers bound to it.

**What you type**: the sentence you write for each item, and whether it is a bug or a
suggestion.

Values that look secret are replaced with `<redacted>` where they are read, before anything is
stored: props, markup and logged objects whose names look like a password, token, key, session or
card number, the values of password and hidden fields, any prop that holds what a password, one
time code or card field on the page holds or is shaped like such a secret in a component that
renders one, and the matching parts of every address the prompt prints. That screening goes mostly
by name, so it is not a guarantee. The README's privacy section lists what it covers and what it
does not, among them free text, the page title and the screenshot itself.

## Where it is kept, and for how long

| What | Where | How long |
| :--- | :--- | :--- |
| Screenshots, as PNG files | `claude-punch-list` in your Downloads folder | A screenshot whose item you copied stays until you delete it, because the prompt names it by path. One whose item was never copied is deleted by the extension when you discard the item (once the six seconds in which the discard can be undone have run out) or when a sheet left untouched for a week is dropped. |
| The sheet: each item's sentence, thumbnail, screenshot path, page address and title, and element details | `chrome.storage.local`, in your Chrome profile, readable only by the extension's own pages | Until you copy the items or discard them. A sheet left untouched for a week is dropped the next time the panel opens, with its screenshots, unless a panel in another window is showing it. |
| Your settings: which kinds of evidence to attach, bug or suggestion | `chrome.storage.local` | Until you uninstall the extension. |
| The console and network record | The memory of the page it was collected on | Until that page is closed or reloaded. |
| The prompt | Your clipboard | Until you copy something else. |

Uninstalling the extension removes everything it kept in `chrome.storage.local`. The
screenshots in your Downloads folder are ordinary files and stay until you delete them.

## Who can see it

You can. Nothing is sent to the author of this extension, to Anthropic, or to anyone else.

One caveat. The collector has to run in the page's own JavaScript world to see the page's real
`console` and `fetch`. It hands its record to the rest of the extension over a channel whose name
is random, rather than broadcasting it to the page, but a script on that page written to look
for this extension can still find the collector and read its record, or answer in its place.
That record holds the page's own console and network activity, which any script on the page
could record anyway, so nothing becomes newly available to it.

The extension does not run in incognito windows at all: its manifest does not allow it, so
Chrome offers no setting to turn it on there.

## Permissions

| Permission | What it is used for |
| :--- | :--- |
| Access to all sites (`<all_urls>`) | Taking the screenshot (`captureVisibleTab` requires it), putting the capture overlay and the element picker on the page, reading the tab's address, and running the collector and the picker's press listener |
| `scripting` | Putting the capture overlay and the element picker on the page when you press Region or Element, and starting the collector on a tab that was already open when the extension was installed or enabled, only where the collector is set to run |
| `downloads` | Saving each screenshot to your Downloads folder, reading back where it was saved, checking that it is still there, and deleting the screenshot of an item that was never copied |
| `storage` | Keeping the sheet and your settings between panel sessions |
| `sidePanel` | The panel itself |

## For the Chrome Web Store

In the terms the Chrome Web Store uses, the extension handles **website content** (screenshots,
markup, text, console messages and failed requests of the pages you work on) and **web
history** (the address and title of each page you capture on). It handles them on your
computer only, to build the prompt you copy, and transmits none of them.

* The data is not sold or transferred to third parties.
* The data is not used or transferred for purposes unrelated to the extension's single
  purpose, which is building that prompt.
* The data is not used or transferred to determine creditworthiness or for lending purposes.

## Changes and contact

Changes to this policy are made in this file, and its history on GitHub shows every one.
Questions go to the [issue tracker](https://github.com/srdjanmitrovic/claude-punch-list/issues).
