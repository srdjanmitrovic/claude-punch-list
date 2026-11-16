/**
 * The prompt template.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS FILE IS YOURS TO SHAPE.
 *
 * Everything else in this extension exists to gather the data below. What you
 * do with it here is the actual contract with Claude Code, and it is a judgment
 * call, not a technical one. Things worth deciding for yourself:
 *
 *   - Ordering. Claude Code reads top to bottom. Right now the items come first
 *     and the raw context last, on the theory that intent should frame the
 *     evidence. Putting console errors first would bias it toward the stack
 *     trace instead. Both are defensible.
 *   - What leads the element section. It opens with the component and its call
 *     site because those name files, and closes with the selector and the
 *     markup because a render tree path locates nothing in a codebase. Between
 *     them sits one line of things to grep for. Swapping any of that around is
 *     a line in formatElement.
 *   - Instruction strength. The closing lines currently ask it to find the root
 *     cause before editing. Softening that to "propose a fix" gets faster,
 *     shallower answers; that is sometimes what you want.
 *   - Whether to tell it to read the screenshots. Claude Code will not open an
 *     image unless something points at it, hence the explicit lines.
 *   - The wording of each voice in INTENTS and MIXED below. Those strings are
 *     the entire difference between reporting a bug, proposing a change, and
 *     handing over a list that does both.
 *
 * Edit freely and reload the extension. No other file needs to change.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * @typedef {Object} Item
 * One captured thing and what the user said about it.
 * @property {'bug'|'change'=} intent  Which voice this item speaks in.
 * @property {string}  description    What the user typed for this item.
 * @property {string=} screenshotPath Absolute path to the saved PNG.
 * @property {string=} url            Page the item was captured on. Printed as
 *                                    a path while the report stays on one
 *                                    origin, in full once it spans two.
 * @property {number=} capturedAt     When, as epoch milliseconds.
 * @property {number=} armedAt        When the collector started on the page
 *                                    load the item was captured on, as epoch
 *                                    milliseconds. Matches the report's own
 *                                    armedAt when the log read for the report
 *                                    holds what led up to this item, which is
 *                                    how a list prints each item's entries
 *                                    under it.
 * @property {Object=} element        { selector, attributes, html, styles, text,
 *                                    truncated, component, handlers,
 *                                    classHints }, where component is the React
 *                                    or Vue node behind the selector, handlers
 *                                    are the event props found on the picked
 *                                    node or on the nearest ancestor carrying
 *                                    any, and classHints is one clause per
 *                                    class whose origin could be decoded.
 *
 * @typedef {Object} Report
 * @property {Item[]}  items         In capture order. Never empty.
 * @property {Object=} page          { url, title, viewport:{width,height,dpr} }
 *                                   The page the console and network buffers
 *                                   were read from, which is the current tab.
 *                                   The url is printed as a path while the
 *                                   report stays on one origin, in full once it
 *                                   spans two. Absent when the page toggle is
 *                                   off, in which case no URL is printed
 *                                   anywhere, though pages are still counted.
 * @property {Array=}  consoleLines  [{ level, text, t }], errors and warnings
 * @property {Array=}  errors        [{ kind, text, where, stack, t }]
 * @property {Array=}  network       [{ method, url, status, statusText, ms,
 *                                   caller, outcome, t }], where caller is the
 *                                   stack that sent the request, nearest frame
 *                                   first, and outcome is 'aborted' or
 *                                   'timeout' when the page ended the request
 *                                   itself. Every t is milliseconds since
 *                                   armedAt, and orders the entries; seq, a
 *                                   count across all three, orders the ones
 *                                   that share a millisecond.
 * @property {Object=} dropped       { console, warnings, errors, network }:
 *                                   how many entries each of the collector's
 *                                   rings pushed out before the read.
 * @property {number}  builtAt       When the buffers were read and the prompt
 *                                   assembled, as epoch milliseconds.
 * @property {number=} armedAt       When the collector started on the page the
 *                                   buffers came from, as epoch milliseconds.
 *                                   An item captured before it was captured on
 *                                   an earlier load of that page.
 * @property {string=} contextError  Set when the buffers could not be read:
 *                                   'timeout' if the tab did not answer, any
 *                                   other value if nothing came back. The page
 *                                   then comes from the newest item.
 */

/**
 * The two voices this template speaks in.
 *
 * The evidence is identical either way. A screenshot, a console buffer and a DOM
 * node describe the page the same regardless of why it is being reported, so
 * only the framing around that evidence changes: the opening directive, the
 * heading over the user's own words, the reason to open the image, and the
 * closing instruction. Keeping those strings here rather than forking
 * buildPrompt is what stops the two prompts drifting apart in the parts that
 * were never supposed to differ.
 *
 * The closing lines are where the two really diverge, and they are worth
 * reading as a pair. A bug has a root cause and asking for it first is what
 * stops Claude Code patching the symptom. A change has no root cause; the
 * corresponding risk is that it quietly grows, so that line asks for the
 * smallest version instead.
 *
 * `lead` takes the item count and a scope phrase ("on <url>", "across 2
 * pages"). `screenshot` is the single-item wording, where the path has its own
 * section; `screenshots` is said once at the top of a list, because repeating
 * it under every item would be noise.
 *
 * 'bug' is the fallback for any item with no intent, which covers reports made
 * before this existed and the sample in tools/preview-prompt.mjs.
 */
const INTENTS = {
  bug: {
    lead: (count, where) =>
      count === 1 ? `Fix this issue ${where}` : `Fix these ${count} issues ${where}`,
    heading: "What's wrong",
    screenshot: 'Read that image before anything else. It shows the problem as rendered.',
    screenshots:
      'Each item has a screenshot on disk. Read that image before working on the item. ' +
      'It shows the problem as rendered.',
    closing:
      'Find the root cause in this codebase before changing anything. ' +
      'If the screenshot and the console point at different things, say so rather than guessing.',
  },
  change: {
    lead: (count, where) =>
      count === 1 ? `Make this change ${where}` : `Make these ${count} changes ${where}`,
    heading: 'What should change',
    screenshot:
      'Read that image before anything else. It shows the current behaviour, which is what ' +
      'this change is measured against.',
    screenshots:
      'Each item has a screenshot on disk. Read that image before working on the item. ' +
      'It shows the current behaviour, which is what the change is measured against.',
    closing:
      'Find where this is implemented before writing anything, and follow the patterns already ' +
      'in this codebase rather than introducing new ones. If the change is larger than it looks, ' +
      'say so and propose the smallest version that delivers it.',
  },
};

/**
 * The voice for a list that mixes bugs and changes.
 *
 * Each item still carries its own heading from INTENTS, so Claude Code can tell
 * which is which. What this table supplies is the framing around the whole list:
 * the opening line names both kinds of work and how many of each, and the
 * closing gives the two instructions side by side, because neither alone is
 * right for the other kind of item.
 */
const MIXED = {
  lead: (counts, where) =>
    `Fix ${plural(counts.bug, 'issue')} and make ${plural(counts.change, 'change')} ${where}`,
  screenshots:
    'Each item has a screenshot on disk. Read that image before working on the item. ' +
    'For a bug it shows the problem as rendered; for a change it shows the current behaviour, ' +
    'which is what the change is measured against.',
  closing:
    'For each bug, find the root cause in this codebase before changing anything, and if the ' +
    'screenshot and the console point at different things, say so rather than guessing. ' +
    'For each change, find where it is implemented before writing anything and follow the ' +
    'patterns already in this codebase rather than introducing new ones; if it is larger than ' +
    'it looks, say so and propose the smallest version that delivers it.',
};

/**
 * Added to the closing of any report with more than one item.
 *
 * A list invites two failure modes a single report does not have: an item
 * quietly skipped, and changes that cannot be traced back to the item that
 * asked for them. The second sentence is there so a shared cause is reported
 * as one thing rather than patched three times.
 */
const MANY_ITEMS =
  'Cover every item, and say which item each change belongs to. ' +
  'If several items turn out to share a cause or a fix, say so rather than treating them separately.';

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Reduce a string read out of the page to something that can only ever be part
 * of the line it is put on.
 *
 * Everything else the page controls is already contained: markup and the
 * console go through fence(), and a string prop value is JSON encoded by the
 * collector before it ever gets here. Component names, prop keys and source
 * paths had no such guard, and they are page controlled too: a displayName is
 * whatever the page assigned, and this prompt is pasted straight into Claude
 * Code. A name containing a newline and a `## ` could otherwise open a section
 * of the page's own choosing and give it instructions.
 */
function flatten(value) {
  return String(value)
    .replace(/\s+/g, ' ')
    .replace(/`/g, "'")
    .trim()
    .slice(0, 200);
}

/** Fence a block of text with one more backtick than any run inside it. */
function fence(body, language = '') {
  const longest = Math.max(2, ...(body.match(/`+/g) || []).map((run) => run.length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${language}\n${body}\n${ticks}`;
}

const MINUTE = 60 * 1000;

function stamp(ms) {
  return new Date(ms).toLocaleString();
}

/**
 * When an evidence line was logged: the clock time to the millisecond when
 * the collector's start is known, otherwise seconds since it started. Built
 * by hand rather than with toLocaleTimeString, whose shape follows the
 * machine, so that every line of one prompt has the same width.
 */
function clockOf(t, clock) {
  if (!Number.isFinite(t)) return '';
  if (!Number.isFinite(clock.armedAt)) return `+${(t / 1000).toFixed(3)}s`;
  const date = new Date(clock.armedAt + t);
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  // A tab left open overnight keeps yesterday's entries in its log, and a
  // bare time would read as minutes before the capture.
  const day = dayOf(date);
  return (
    `${day === clock.day ? '' : `${day} `}` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}`
  );
}

/**
 * The date, year first. The Captured line follows the machine's locale, so
 * 8/6 beside it would read as August in one and June in another.
 */
function dayOf(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** What clockOf needs from the report: the log's start, and the day the report was made. */
function clockFor(report) {
  return {
    armedAt: report.armedAt,
    day: dayOf(new Date(Number.isFinite(report.builtAt) ? report.builtAt : Date.now())),
  };
}

/**
 * The frames worth printing from a stack: its first three "at" lines. Taken
 * by what they say rather than by position, because a message that runs over
 * several lines (a ZodError, React's invalid hook call) fills the first lines
 * of the stack with more message.
 */
function stackFrames(stack) {
  return String(stack)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at '))
    .slice(0, 3);
}

/**
 * One log line, uncaught error or failed request, made ready to print: the
 * first line, what goes under it with its indent, and a key that is the same
 * for two entries only when they would print the same (bar the clock and the
 * timing), so a run of them can fold into one.
 *
 * @typedef {{ t: number, seq: number, head: string, more: { indent: number, text: string }[], key: string }} Entry
 */

/** @returns {Entry} */
function consoleEntry(entry) {
  // A failed resource and many a logged message carry a url, and a url can
  // carry a token (see safeUrl).
  const head = `[${entry.level}] ${safeText(entry.text)}`;
  return { t: entry.t, seq: entry.seq, head, more: [], key: head };
}

/** @returns {Entry} */
function errorEntry(error) {
  const label = error.kind === 'unhandled-rejection' ? 'unhandled' : 'error';
  const head = `[${label}] ${safeText(error.text)}`;
  // The throw site and its callers; deeper frames are usually framework
  // internals and not worth the tokens. The location the collector recorded
  // is only worth printing when the stack has no frame, since the first frame
  // names the same place and adds the function.
  // A frame names the script's url, and a script loaded as maps/api/js?key=
  // carries its key into every frame.
  let frames = error.stack ? stackFrames(error.stack).map(safeText) : [];
  // Screened as the frame it prints as, so that its :line:col is kept out of
  // a masked value at the end of its url, as any frame's is.
  if (!frames.length && error.where) frames = [safeText(`at ${error.where}`)];
  const more = frames.map((text) => ({ indent: 10, text }));
  return { t: error.t, seq: error.seq, head, more, key: [head, ...frames].join('\n') };
}

/**
 * A failed request, and under it the code that sent it.
 *
 * The frames are the strongest locator in this prompt: a 500 names a route, but
 * the first frame names the file and the line the call was written on. They are
 * nearest first, so that first frame is the function that called fetch and the
 * ones after it are its callers. The continuation lines are indented to sit
 * under the label rather than the margin, because a bare frame on the left
 * would read as another request.
 *
 * @returns {Entry}
 */
function networkEntry(request) {
  const status = cancelledLabel(request) || (request.status === 0 ? 'FAILED' : request.status);
  // Joined rather than interpolated: HTTP/2 responses have no status text,
  // and a fixed template would leave two spaces where it was.
  const parts = [request.method, request.url ? safeUrl(request.url) : '(no url)', '->', status];
  if (request.statusText) parts.push(request.statusText);
  const frames = (Array.isArray(request.caller) ? request.caller : [])
    .filter((frame) => typeof frame === 'string')
    .map(flatten)
    .filter(Boolean)
    .slice(0, 3)
    .map(safeText);
  // The timing is left out of the key: a poll failing thirty times takes a
  // slightly different time on each, and is still one thing that happened.
  const key = [parts.join(' '), ...frames].join('\n');
  if (request.ms) parts.push(`(${request.ms}ms)`);
  const more = frames.map((frame, index) =>
    index === 0 ? { indent: 4, text: `called from ${frame}` } : { indent: 16, text: frame }
  );
  return { t: request.t, seq: request.seq, head: parts.join(' ').trim(), more, key };
}

/**
 * Oldest first, and within one millisecond in the order the collector pushed
 * them. An entry with no time, from an older collector, goes last.
 */
function byTime(a, b) {
  const at = Number.isFinite(a.t) ? a.t : Infinity;
  const bt = Number.isFinite(b.t) ? b.t : Infinity;
  if (at !== bt) return at - bt;
  return Number.isFinite(a.seq) && Number.isFinite(b.seq) ? a.seq - b.seq : 0;
}

/**
 * Entries as lines, each behind its clock, with a run of identical ones
 * folded into the first and counted. A poll that fails thirty times is one
 * fact, and printed thirty times it was most of the prompt.
 *
 * @param {Entry[]} entries  already in the order to print
 */
function renderEntries(entries, clock) {
  const lines = [];
  for (let start = 0; start < entries.length; ) {
    const entry = entries[start];
    let end = start + 1;
    while (end < entries.length && entries[end].key === entry.key) end += 1;
    const count = end - start;

    const time = clockOf(entry.t, clock);
    const prefix = time ? `${time} ` : '';
    const last = count > 1 ? clockOf(entries[end - 1].t, clock) : '';
    const repeats = count > 1 ? ` (×${count}${last ? `, last ${last}` : ''})` : '';
    // A message that runs over several lines keeps its later lines under its
    // own text, where they cannot be read as entries of their own.
    const label = entry.head.indexOf('] ');
    const under = ' '.repeat(prefix.length + (label === -1 ? 0 : label + 2));
    lines.push(`${prefix}${entry.head.split('\n').join(`\n${under}`)}${repeats}`);
    // Continuation lines sit under the entry, not under its clock.
    for (const line of entry.more) {
      lines.push(`${' '.repeat(prefix.length + line.indent)}${line.text}`);
    }
    start = end;
  }
  return lines;
}

/** Console lines and uncaught errors, merged into the order they happened. */
function formatConsole(consoleLines = [], errors = [], clock) {
  const entries = [...errors.map(errorEntry), ...consoleLines.map(consoleEntry)].sort(byTime);
  return renderEntries(entries, clock);
}

function formatNetwork(network = [], clock) {
  // A request the page ended itself (an effect cleaning up, a search box
  // replacing its previous query, a timeout it set) is not a failure. It still
  // prints, because a page can cancel the one request it needed, but labelled
  // as what it was and after every real failure, so it cannot read as the
  // cause.
  const real = network.filter((request) => !cancelledLabel(request)).map(networkEntry);
  const ended = network.filter((request) => cancelledLabel(request)).map(networkEntry);
  return [
    ...renderEntries(real.sort(byTime), clock),
    ...renderEntries(ended.sort(byTime), clock),
  ];
}

/**
 * What the collector pushed out of its rings before this read, as a
 * sentence, or '' when nothing was. The rings keep the newest LIMIT entries
 * each, and without this a log of thirty lines reads as all there was.
 */
function droppedNotice(dropped) {
  if (!dropped || typeof dropped !== 'object') return '';
  const kinds = [
    [dropped.console, 'console error', 'console errors'],
    [dropped.warnings, 'warning', 'warnings'],
    [dropped.errors, 'uncaught error or failed load', 'uncaught errors or failed loads'],
    [dropped.network, 'failed request', 'failed requests'],
  ].filter(([count]) => Number.isInteger(count) && count > 0);
  if (!kinds.length) return '';
  const parts = kinds.map(([count, one, many]) => `${count} ${count === 1 ? one : many}`);
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  const total = kinds.reduce((sum, [count]) => sum + count, 0);
  return (
    `the collector keeps only the newest entries of each kind, so ${list} logged earlier ` +
    `${total === 1 ? 'is' : 'are'} not shown.`
  );
}

/** Compared, not looked up, so an unexpected outcome string can never match. */
function cancelledLabel(request) {
  if (request.outcome === 'aborted') return 'ABORTED by the page';
  if (request.outcome === 'timeout') return 'TIMEOUT set by the page';
  return '';
}

function formatStyles(styles = {}) {
  const entries = Object.entries(styles);
  if (!entries.length) return '';
  return entries.map(([property, value]) => `${property}: ${value}`).join('; ');
}

/**
 * The React or Vue component behind a picked element, as a few lines plus the
 * props, which the caller places further down.
 *
 * The MAIN world does the reading and hands over plain strings, so nothing is
 * left here but wording, and the wording is what decides whether Claude Code
 * opens the right file. Two traps it has to stay clear of:
 *
 *   - React records where a node's JSX is WRITTEN, which is the owner's file
 *     and not the component's own. Telling a reader that `Total` lives at
 *     Checkout.tsx:42 sends them to the call site to look for a definition that
 *     is not there. Vue records the opposite, the component's own file, so the
 *     two frameworks cannot share a sentence.
 *   - A production build renames components, so `t` is a real answer rather
 *     than a broken one, and a reader who is not told that will grep for a name
 *     that was never in the source.
 */
function formatComponent(component) {
  const names = (component.names || []).filter((entry) => typeof entry === 'string').map(flatten);
  // Not names[0]: an anonymous component yields an empty name, and throwing the
  // whole block away would discard a source path and a prop list with it. The
  // index matters as well as the name, or the component chosen here is also
  // printed as its own ancestor.
  const nameIndex = names.findIndex(Boolean);
  const name = nameIndex === -1 ? '' : names[nameIndex];

  const vue = component.framework === 'vue';
  const source = typeof component.source === 'string' ? flatten(component.source) : '';
  const owner = typeof component.owner === 'string' ? flatten(component.owner) : '';
  const props = (component.props || [])
    .filter((entry) => typeof entry === 'string')
    .map(flatten)
    .filter(Boolean);

  const lines = [];

  if (name) {
    let framework = vue ? 'Vue' : 'React';
    // Only Vue offers its version, and it is worth the four characters: the same
    // question has different answers in the options API and the composition API.
    if (vue && typeof component.version === 'string') framework += ` ${flatten(component.version)}`;
    // Asserted nowhere: a reply this build did not produce must not be allowed
    // to claim a development build, because that claim is what tells a reader
    // the names can be trusted as written.
    const build =
      component.build === 'production'
        ? component.renamed
          ? 'production build'
          : 'production build; names may be minified'
        : component.build === 'development'
          ? 'development build'
          : '';

    let identity = build
      ? `Component: \`${name}\` (${framework}, ${build})`
      : `Component: \`${name}\` (${framework})`;
    if (component.renamed) {
      // Said outright rather than hedged. A reader told only that names "may be
      // minified" still tries to grep for `A` and finds nothing, then doubts
      // the report. React DevTools shows the same string for the same reason,
      // which is worth saying because the reader may have it open.
      identity +=
        `. The bundler chose that name, so it does not appear in the source and ` +
        `searching for it will find nothing. React DevTools shows the same name.`;
    }
    if (component.hops > 0) {
      // The picked node came from dangerouslySetInnerHTML, a portal boundary or
      // a script of the page's own, so nothing about it appears in the
      // component's source and a reader looking for it there will not find it.
      // The count is parentElement steps, so it is said in DOM elements: saying
      // "levels" invites counting components, which is a different number.
      const steps = component.hops === 1 ? '1 DOM element' : `${component.hops} DOM elements`;
      identity +=
        `${identity.endsWith('.') ? '' : '.'} The selected element was not rendered by ` +
        `${vue ? 'Vue' : 'React'} itself; ` +
        `this is the nearest component node, ${steps} up.`;
    }
    lines.push(identity);
  }

  if (source && vue) {
    // Not "Call site". Vue's __file is the component's own file, so this is the
    // one framework where the path is where the definition lives.
    lines.push(`Defined in ${source}`);
  } else if (source && owner) {
    lines.push(
      `Call site: ${source} (where ${owner} writes this JSX; ` +
        `${name || 'this component'} is defined elsewhere)`
    );
  } else if (source) {
    // The caveat has to survive an owner React could not name, because that is
    // still a call site and still not where the component is defined.
    lines.push(
      `Call site: ${source} (where this JSX is written; ` +
        `${name || 'this component'} is defined elsewhere)`
    );
  }

  // Its own line, never spliced onto the one above. "Rendered from X, where A
  // writes this JSX rather than where B is defined, inside C > D" reads as
  // though C and D were where B is defined, which is the opposite of the point.
  const ancestors = names
    .slice(nameIndex + 1)
    .filter(Boolean)
    .join(' > ');
  // No silent gaps. A chain reading "Inside TooltipProvider" when three more
  // components sat between would have the reader looking for a parent that is
  // not the parent, so the ones left out are counted rather than hidden.
  const skipped =
    Number.isFinite(component.minified) && component.minified > 0 ? component.minified : 0;

  // What to do instead, since the name cannot be used. Prop names survive
  // minification because mangling them would break every component boundary,
  // and an ancestor the bundler left alone is a real symbol to search for.
  if (component.renamed) {
    const byAncestor = ancestors
      ? ` The ancestors on the next line are real names, so those can be searched for.`
      : '';
    lines.push(
      `Find it by the prop names below, which minification leaves alone, and by the ` +
        `markup and any test ids.${byAncestor}`
    );
  }

  // No silent gaps. A chain reading "Inside TooltipProvider" when three more
  // components sat between would have the reader looking for a parent that is
  // not the parent, so the ones left out are counted rather than hidden.
  if (ancestors && skipped) {
    lines.push(`Inside ${ancestors}, plus ${skipped} the bundler renamed`);
  } else if (ancestors) {
    lines.push(`Inside ${ancestors}`);
  } else if (skipped) {
    lines.push(
      `Inside ${skipped} component${skipped === 1 ? '' : 's'}, every one of them renamed by the bundler`
    );
  }

  // Handed back on their own rather than pushed onto the rest. The search line
  // sits between the ancestors and the props, and it is built out of what the
  // other lines already say, so it cannot exist until they do.
  const propLines = [];
  if (props.length && name) propLines.push(`Props of \`${name}\`: ${props.join(', ')}`);
  else if (props.length) propLines.push(`Props: ${props.join(', ')}`);

  return { lines, props: propLines, name, renamed: component.renamed === true };
}

/**
 * The handler entries that will be printed.
 *
 * The search line reads the same list, and reads it through here rather than
 * off the payload, so it cannot offer a name that the cap dropped before the
 * handlers line was written.
 */
function handlerList(handlers) {
  return (Array.isArray(handlers?.list) ? handlers.list : [])
    .filter((entry) => typeof entry === 'string')
    .map(flatten)
    .filter(Boolean)
    // A name only when it is one worth having. An anonymous handler and a
    // bundler's single letter both print as "onClick=f o", which offers the
    // reader a search target that matches nothing, and this file argues
    // elsewhere that such a target is worse than none. The prop name is real
    // either way, so that is what survives.
    .map((entry) => {
      const match = /^([^=]+)=ƒ\s*(.*)$/.exec(entry);
      if (!match) return entry;
      const name = match[2].trim();
      const usable = name && !name.startsWith('(') && name.length >= 3;
      return usable ? `${match[1]}=ƒ ${name}` : match[1];
    })
    .slice(0, 6);
}

/**
 * The event handlers on the picked element, or on the ancestor that carries
 * them.
 *
 * `hops` is the whole difficulty. Handlers found two elements up are that
 * ancestor's, and a reader told they belong to the picked element opens its
 * component, finds no onClick in it and concludes the report is wrong. So the
 * ancestor is named outright and the distance is counted in DOM elements, the
 * same unit the component block above counts in.
 *
 * `starts` is the first statement or two of the handler body. It is there to be
 * recognised, not read: seeing `setPending(true); applyCoupon(` is what turns a
 * grep for the handler name into the right file on the first try.
 */
function formatHandlers(handlers) {
  if (!handlers || typeof handlers !== 'object') return [];

  const list = handlerList(handlers);
  const hops = Number.isFinite(handlers.hops) && handlers.hops > 0 ? Math.floor(handlers.hops) : 0;
  const label = typeof handlers.label === 'string' ? flatten(handlers.label) : '';
  const starts = typeof handlers.starts === 'string' ? flatten(handlers.starts) : '';
  const startsOf = typeof handlers.startsOf === 'string' ? flatten(handlers.startsOf) : '';

  const lines = [];

  const steps = hops === 1 ? '1 element' : `${hops} elements`;
  const where = label ? `\`${label}\`` : 'an ancestor';

  if (list.length && !hops) {
    lines.push(`Handlers: ${list.join(', ')}`);
  } else if (list.length) {
    lines.push(`Handlers on ${where}, ${steps} up the DOM, not on the picked element: ${list.join(', ')}`);
  }

  // Gated on the list rather than printed beside it. A body line with no list
  // above it has lost the sentence saying whose element these belong to, and a
  // reader who takes it for the picked element's opens the wrong component.
  if (starts && list.length) {
    const whose = startsOf ? `\`${startsOf}\` body` : 'Handler body';
    lines.push(`${whose} starts: ${starts}`);
  }

  return lines;
}

/**
 * Where a class came from, as whole clauses the collector wrote.
 *
 * Nothing is parsed back out of them here beyond the stylesheet name for the
 * search line. A clause is a sentence the collector is responsible for, and
 * splitting it up here would make two files own one sentence.
 */
function formatClassHints(classHints) {
  const clauses = (Array.isArray(classHints) ? classHints : [])
    .filter((entry) => typeof entry === 'string')
    .map(flatten)
    .filter(Boolean)
    .slice(0, 3);
  return clauses.length ? [`Classes: ${clauses.join('; ')}`] : [];
}

/**
 * Function names out of the `key=ƒ name` entries the collector writes for props
 * and handlers.
 *
 * An anonymous function has no name to search for, and a one or two character
 * name on a production build is the bundler's, which is worse than no target at
 * all: it matches most lines in the file.
 */
function functionNames(entries) {
  const names = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (typeof entry !== 'string') continue;
    const match = /=ƒ\s+(.+)$/.exec(flatten(entry));
    const name = match ? match[1].trim() : '';
    if (!name || name.startsWith('(') || name.length < 3) continue;
    names.push(name);
  }
  return names;
}

/** The attributes a test suite pins an element by, strongest first. */
const TEST_ID_ATTRIBUTES = ['data-testid', 'data-test', 'data-cy', 'data-qa'];

/** Values that reach the DOM as text and are never written in the source. */
const RUNTIME_TEXT = new Set(['NaN', 'null', 'undefined', 'Infinity', 'true', 'false']);

/**
 * An id minted at runtime rather than written by hand. React's useId produces
 * `:r3:`, component libraries append a counter, and a server rendered list
 * appends the row's key. Searching for one of those finds nothing.
 */
function generatedId(value) {
  return value.includes(':') || /\d{4,}/.test(value) || /^[0-9a-f]{8,}$/i.test(value);
}

/**
 * The element's visible text, when it is a label somebody typed into the source
 * rather than a value the page computed.
 *
 * Three things disqualify it. A digit means rendered data, and a price or a
 * count is different on the next reload. A name JavaScript prints for a value
 * it could not compute is the bug being reported, not a label. Length means the
 * node is a container, whose textContent is every descendant's text run
 * together into a string that exists nowhere in the source.
 */
function searchableText(text) {
  const value = typeof text === 'string' ? flatten(text) : '';
  if (value.length < 2 || value.length > 40) return '';
  if (!/[A-Za-z]/.test(value) || /\d/.test(value)) return '';
  if (RUNTIME_TEXT.has(value)) return '';
  if (!/\s/.test(value) && value.length > 20) return '';
  return value;
}

/**
 * The stylesheet named inside a class hint.
 *
 * The hashed class the clause is about is the bundler's and appears nowhere in
 * the source, so it is a dead search. The file the clause resolved it to is the
 * part worth grepping for. Read off the raw clause, before flatten() turns its
 * backticks into quotes.
 */
function styleFile(classHints) {
  for (const hint of Array.isArray(classHints) ? classHints : []) {
    if (typeof hint !== 'string') continue;
    for (const [, token] of hint.matchAll(/`([^`]+)`/g)) {
      if (/\.(css|scss|sass|less|styl|vue)$/i.test(token)) return flatten(token);
    }
  }
  return '';
}

/**
 * One line of grep targets, so Claude Code does not have to mine them out of
 * the markup.
 *
 * Everything here is already somewhere in this report. The point is that the
 * best of it is inside an HTML block, which costs a reader a parse and a
 * judgment call before the first search. Priority is by how stable the string
 * is in the source: a test id is put there to be found and survives a redesign,
 * a label survives until the copy changes, a handler name until a refactor.
 *
 * `printed` is every other line this element will print. A target already on
 * one of those is dropped, because repeating it teaches nothing and the line is
 * only worth its tokens while every entry is new. The selector is deliberately
 * not in that list: an id buried in `div.cart > #total > span` is exactly the
 * kind of thing this line exists to lift out.
 */
function formatSearch(element, identity) {
  const attributes =
    element.attributes && typeof element.attributes === 'object' ? element.attributes : {};
  const attribute = (key) => (typeof attributes[key] === 'string' ? flatten(attributes[key]) : '');

  const candidates = [];
  const add = (text, quoted = false) => {
    // Past 60 characters a string is a sentence rather than a search. The
    // source it came from will have been wrapped or interpolated somewhere
    // along its length, so the grep for it comes back empty.
    if (text && text.length <= 60) candidates.push({ text, quoted });
  };

  // Every attribute that names a thing gets the same two guards. A per row
  // test id such as row-8f3a1c is as useless a search target as a generated
  // id, and a one character name is worse than useless at the top of the list.
  const stable = (value) => (value && value.length >= 3 && !generatedId(value) ? value : '');
  for (const key of TEST_ID_ATTRIBUTES) add(stable(attribute(key)));
  add(stable(attribute('id')));
  add(attribute('aria-label'), true);
  add(attribute('placeholder'), true);
  add(stable(attribute('name')));
  // A container's text is its children's runs joined with nothing between
  // them, which greps for nothing. Length cannot tell that apart from a real
  // label, but the markup can: an element with a child element did not write
  // its own text. The marker a masked value leaves is not a child.
  const ownText = /<(?!redacted>)[a-z]/i.test(typeof element.html === 'string' ? element.html.slice(1) : '')
    ? ''
    : searchableText(element.text);
  add(ownText, true);
  for (const name of functionNames(handlerList(element.handlers))) add(name);
  for (const name of functionNames(element.component?.props)) add(name);
  // A bundler's name is not searchable, and neither is a two character one.
  if (!identity.renamed && /^[A-Za-z_$][\w$.]{2,}$/.test(identity.name)) add(identity.name);
  add(styleFile(element.classHints));

  // Deduplicated only against itself. Suppressing a candidate because some
  // other line happens to contain the same characters was worse than the
  // repetition it saved: the lines it tested are prose, so `label="Save"` in
  // the props deleted "Save" as a target, and the component name and every
  // handler name were deleted by the lines that describe them. That left a
  // line carrying only strings already visible in the markup fence below it,
  // which is the one thing it must not be. Those other lines present identity
  // and behaviour; this one is the grep list, and a name worth searching for
  // is worth having in it even if it also appears above.
  const chosen = [];
  for (const candidate of candidates) {
    if (chosen.length === 5) break;
    if (chosen.some((entry) => entry.text === candidate.text)) continue;
    chosen.push(candidate);
  }
  if (!chosen.length) return [];

  // Quotes for a phrase a person wrote and backticks for an identifier, so the
  // reader can tell a JSX string to search for from a symbol. A phrase with a
  // quote of its own falls back to backticks rather than being rewritten: the
  // target has to stay the string that is actually in the page.
  const targets = chosen.map((entry) =>
    entry.quoted && !entry.text.includes('"') ? `"${entry.text}"` : `\`${entry.text}\``
  );
  return [`Search for: ${targets.join(', ')}`];
}

/**
 * The lines describing a picked element, so the single-item layout can give
 * them a section of their own and the list layout can tuck them under the item
 * they belong to. Only the label on the selector line differs.
 *
 * Ordered by how close each line gets a reader to a file. The component, its
 * call site and its ancestors name files outright; the search line, the
 * handlers and the props name symbols to grep for. The selector led this
 * section for a long time and has been moved down to sit with the markup,
 * because it describes a path through the rendered tree and there is no file in
 * a codebase it can be looked up in.
 */
function formatElement(element, label = 'Selector') {
  const identity = element.component
    ? formatComponent(element.component)
    : { lines: [], props: [], name: '', renamed: false };
  const handlers = formatHandlers(element.handlers);
  const classHints = formatClassHints(element.classHints);
  // Printed fourth, under the identity lines and above the detail, because it
  // is what a reader should act on first.
  const search = formatSearch(element, identity);

  const parts = [
    ...identity.lines,
    ...search,
    ...handlers,
    ...identity.props,
    ...classHints,
    `${label}: \`${flatten(element.selector)}\``,
  ];
  if (element.html) {
    parts.push(fence(element.html, 'html'));
  }
  const styles = formatStyles(element.styles);
  if (styles) parts.push(`Computed styles: ${styles}`);
  if (element.truncated) {
    parts.push('_(markup truncated; open the page to see the full subtree)_');
  }
  return parts;
}

function voiceOf(item) {
  return INTENTS[item.intent] || INTENTS.bug;
}

/**
 * A page url with the origin taken off, because Claude Code works inside the
 * codebase, where a page is a route and not an address.
 *
 * The query and the hash stay. `?step=2` and `#summary` are often the state
 * being reported (a tab, a filter, a hash router's current route), and two
 * captures of different screens would otherwise print identically.
 *
 * Only http, https and file have a path that still means something once the
 * origin is gone. A chrome-extension:// or data: url is handed back whole.
 */
function pathOf(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // Not a url new URL() reads. Still screened: whatever it is, it is
    // about to print.
    return safeUrl(url);
  }
  if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) return safeUrl(url);
  // Screened, since a path holds secrets too: a ;jsessionid=, or a second url
  // with credentials (/https://u:p@host/). Not as a url of its own, whose
  // start credentialsAt would read a path's leading '//' as an authority:
  // new URL() has taken the real one out, so an '@' left in the path is the
  // path's own (http://host//@alice/profile).
  const path =
    maskPath(withoutCredentials(parsed.pathname), 0) + maskParams(parsed.search) + maskParams(parsed.hash);
  // A landing page has no path to speak of, and "Fix this issue on /" names
  // nothing at all. The host is the only identifying thing left, so keep it.
  return path === '/' ? safeUrl(url) : path;
}

// SECRET NAMES BEGIN. The same block sits in content/collector-main.js,
// content/picker.js and shared/prompt-template.js, which cannot share code:
// two are injected into the page and one is a module. test/static.test.mjs
// fails if the copies differ.
const REDACTED = '<redacted>';

// Matched against the whole words of a name, so className is not caught by
// "ssn" nor passHref by "pass". A word of five letters or more also matches
// at either end of a run together lowercase name (authtoken, phonenumber).
// Deliberately broad: a needlessly hidden value costs a line of the prompt,
// and the other kind of mistake cannot be taken back.
const SECRET_WORDS = [
  'password', 'passwd', 'passphrase', 'passcode', 'pwd', 'secret', 'token', 'auth', 'oauth',
  'authorization', 'bearer', 'jwt', 'cookie', 'session', 'credential', 'apikey', 'accesskey',
  'privatekey', 'signingkey', 'csrf', 'xsrf', 'otp', 'totp', 'pin', 'pincode', 'cvv', 'cvc',
  'ssn', 'iban', 'cardnumber', 'creditcard', 'ccnumber', 'account', 'address', 'email', 'phone',
  'dob', 'birth', 'signature', 'jsessionid', 'sessid', 'securitycode', 'verificationcode',
];

function isSecretName(name) {
  const words = String(name)
    .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
    .filter(Boolean)
    // otp1, cvv2, address2: a field numbered in a row is still that field.
    .map((word) => word.toLowerCase().replace(/(?<=[a-z])\d+$/, ''));
  return words.some((word, index) =>
    SECRET_WORDS.some(
      (secret) =>
        word === secret ||
        word === secret + 's' ||
        word + (words[index + 1] || '') === secret ||
        (secret.length >= 5 && (word.startsWith(secret) || word.endsWith(secret)))
    )
  );
}
// SECRET NAMES END

// SECRET URLS BEGIN. The same block sits in content/picker.js and
// shared/prompt-template.js; test/static.test.mjs fails if they differ.

// Whole names that carry a secret in a url, though as words they are too
// common to treat as secret anywhere (errorCode, sortKey): an OAuth code, an
// API key, a signed url's signature, a single sign on ticket, a session id
// in the form PHP and forum software put in a url when cookies are off.
const SECRET_PARAMS = ['code', 'key', 'sig', 'ticket', 'sid'];

// Embedded credentials: up to the last '@' before the path, since a password
// can hold one. A scheme relative url (//user:pass@host) carries them too.
const CREDENTIALS = /^((?:[a-z][a-z0-9+.-]*:)?\/\/)([^/?#\s]*)@/i;

// Where the host of a url ends, and so where its credentials must have ended.
const HOST_END = /[/?#\s]/g;

// What a userinfo may be made of: anything but a control character or one
// of "<>[\]^`{|}, none of which RFC 3986 lets one hold. It has stopped at
// '/', '?', '#' and white space already, and runs to the last '@', since a
// password can hold one. Letters of any script count, as in an IRI.
const USERINFO = /^[^\x00-\x1f\x7f"<>[\\\]^`{|}]+$/;

// How many urls deep a value is followed (a return address holding a return
// address). Past that the value is masked whole: a page that nests further is
// either broken or built to run this out of stack.
const MAX_NESTING = 4;

/**
 * isSecretName with a bound on its cost. A name too long to be a field's (a
 * url or a blob used as a key or an id) is judged by its first and last 200
 * characters, where a field name sits, so that a name of a million
 * characters costs no more than a short one; the collector judges a long key
 * the same way.
 */
function isSecretNameBounded(name) {
  if (name.length <= 400) return isSecretName(name);
  return isSecretName(name.slice(0, 200)) || isSecretName(name.slice(-200));
}

/** Whether a parameter's name marks its value as secret. */
function isSecretParam(name) {
  return SECRET_PARAMS.includes(name.toLowerCase()) || isSecretNameBounded(name);
}

/**
 * A query (`?a=1&token=x`) or fragment (`#access_token=x`) with the value of
 * every secret looking name masked, and any url inside a value (a redirect,
 * a return address) masked the same way. Handed back unchanged, the very
 * same string, when there is nothing to mask.
 */
function maskParams(part, depth = 0) {
  if (part.length < 2 || !part.includes('=')) return part;
  let changed = false;
  // Pairs end at '&', and at a ';' that a name and '=' follow. Some servers
  // separate pairs with ';', and serialised markup writes '&' as '&amp;',
  // whose ';' would otherwise leave the next name as 'amp;token'. A ';' with
  // no '=' after it is part of the value, and goes with it. JSON may write
  // '&' as \u0026, which ends a pair too.
  const pieces = part.slice(1).split(/(&|\\u0026|;(?=[^&;=]*=))/i);
  for (let index = 0; index < pieces.length; index += 2) {
    const pair = pieces[index];
    const eq = pair.indexOf('=');
    if (eq <= 0 || eq === pair.length - 1) continue;
    let name = pair.slice(0, eq);
    try {
      name = decodeURIComponent(name.replace(/\+/g, ' '));
    } catch {
      /* a malformed escape is still a name to test */
    }
    // A hash router's fragment carries a route before its query.
    name = name.slice(name.lastIndexOf('?') + 1);
    const value = pair.slice(eq + 1);
    const masked = isSecretParam(name) ? REDACTED : nestedUrl(value, depth);
    if (masked === value) continue;
    pieces[index] = pair.slice(0, eq + 1) + masked;
    changed = true;
  }
  return changed ? part[0] + pieces.join('') : part;
}

/**
 * A parameter's value with the secrets of any url it holds masked, whether
 * written out (`next=/verify?token=x`) or percent encoded. An encoded one is
 * masked whole: put back encoded, the marker would print as %3Credacted%3E.
 */
function nestedUrl(value, depth) {
  const holdsUrl = (text) => /[?#]/.test(text) || credentialsAt(text) !== null;
  if (holdsUrl(value)) return depth < MAX_NESTING ? screenUrl(value, depth + 1) : REDACTED;
  // %253F is a '?' encoded twice, as a return address inside a return
  // address's own encoding arrives.
  if (!/%(?:25)*(?:3F|23|40)/i.test(value)) return value;
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return value;
  }
  if (holdsUrl(decoded)) {
    return depth < MAX_NESTING && screenUrl(decoded, depth + 1) === decoded ? value : REDACTED;
  }
  // Still encoded once more: decoded again, one level deeper.
  return depth < MAX_NESTING && nestedUrl(decoded, depth + 1) === decoded ? value : REDACTED;
}

/**
 * A url, absolute or relative, without embedded credentials and with secret
 * query and fragment values masked. Unchanged when there is nothing to remove.
 *
 * Plain string work rather than new URL(), which would reject a relative url
 * and rewrite the rest of an absolute one on its way back out.
 */
function safeUrl(url) {
  return typeof url === 'string' ? screenUrl(url, 0) : url;
}

/**
 * The credentials at the start of a url, as CREDENTIALS matches them, or
 * null. A userinfo with letters outside ASCII counts only with a ':' in it
 * (josé:pw@, u:Pässwort@). Without one, in running text, it is a run of
 * another script up to an e-mail address further on
 * (请访问https://example.com或联系admin@example.com), and no password.
 */
function credentialsAt(url) {
  const found = CREDENTIALS.exec(url);
  return found && (found[2].includes(':') || !/[^\x00-\x7f]/.test(found[2])) ? found : null;
}

/**
 * The text with the credentials of every url in it removed, wherever the url
 * starts: a second url run into the first (https://cors.test/https://u:p@…),
 * one after letters of another script, or one written in JSON, whose ':\/\/'
 * is a '://'. After a scheme, a userinfo goes as credentialsAt would take it.
 * After a bare '//', which a comment or a path can hold too, only one with a
 * ':' in it, and only characters a userinfo may hold, does: XPath writes
 * //xs:element[@name='x'], whose '[' no userinfo has. Each stretch between
 * two '/' is read once, so the cost is one pass whatever the text.
 */
function withoutCredentials(text) {
  if (!text.includes('@')) return text;
  let out = '';
  let kept = 0;
  let slash = text.indexOf('/');
  while (slash !== -1) {
    const json = text[slash - 1] === '\\' && text.startsWith('\\/', slash + 1);
    if (text[slash + 1] !== '/' && !json) {
      slash = text.indexOf('/', slash + 1);
      continue;
    }
    const lead = json ? text[slash - 2] : text[slash - 1];
    const from = slash + (json ? 3 : 2);
    HOST_END.lastIndex = from;
    const end = HOST_END.exec(text)?.index ?? text.length;
    const host = text.slice(from, end);
    const userinfo = host.slice(0, Math.max(host.lastIndexOf('@'), 0));
    const at = from + userinfo.length;
    const scheme = lead === ':';
    const loose =
      !scheme && (lead === undefined || !/[\w/.:\\]/.test(lead)) && USERINFO.test(userinfo);
    if (
      userinfo &&
      (userinfo.includes(':') || (scheme && !/[^\x00-\x7f]/.test(userinfo))) &&
      (scheme || loose)
    ) {
      out += text.slice(kept, from);
      kept = at + 1;
    }
    slash = end < text.length ? text.indexOf('/', end) : -1;
  }
  return kept ? out + text.slice(kept) : text;
}

/**
 * The part of a url before its query with the secret values of any path
 * parameters masked: Java's ;jsessionid=, a connection string's
 * ;password=. A ';' with no '=' after it changes nothing. A data: url's
 * parameters (;charset=utf8) end at its comma. What follows is its content,
 * not more parameters: an svg, each of whose %23 colours would read as one
 * more nested url, or base64, whose '=' padding would end a name made of
 * random letters.
 */
function maskPath(path, depth) {
  const comma = /^\s*data:/i.test(path) ? path.indexOf(',') : -1;
  const end = comma === -1 ? path.length : comma;
  const semi = path.indexOf(';');
  if (semi === -1 || semi > end) return path;
  return path.slice(0, semi) + maskParams(path.slice(semi, end), depth) + path.slice(end);
}

function screenUrl(url, depth) {
  const credentials = credentialsAt(url);
  const bare = withoutCredentials(credentials ? credentials[1] + url.slice(credentials[0].length) : url);
  const cut = bare.search(/[?#]/);
  if (cut === -1) return maskPath(bare, depth);
  const hashAt = bare.indexOf('#', cut);
  const search = hashAt === -1 ? bare.slice(cut) : bare.slice(cut, hashAt);
  const hash = hashAt === -1 ? '' : bare.slice(hashAt);
  return maskPath(bare.slice(0, cut), depth) + maskParams(search, depth) + maskParams(hash, depth);
}
// SECRET URLS END

// A url's characters: anything but whitespace, quotes, angle brackets, the
// backtick, and the quotes and commas of other scripts that end a url in
// running text. Letters of any script stay in, so an international domain or
// path does not cut the url short ahead of its query; text straight after a
// url (Japanese has no spaces) can be taken in with it, which at worst masks
// a little more of a secret value.
const URL_CHAR = '[^\\s"\'<>`\\u00ab\\u00bb\\u2018\\u2019\\u201c\\u201d\\u3001\\u3002\\uff08\\uff09\\uff0c]';

// A run of url characters, the only place a url can be. Found in one pass,
// runs never overlap, and the url inside each is then picked out by hand, so
// no input can make the scan go back over text it has already passed.
const URL_RUN = new RegExp(`${URL_CHAR}+`, 'g');

// An absolute url of any scheme (https://, wss://, postgres://).
const SCHEME = /\b[a-z][a-z0-9+.-]{0,31}:\/\//i;

/**
 * Where the url in a run starts, or -1 for none: an absolute url; a path
 * with a query, fragment or path parameter (GET /api/session?token=x,
 * /app;jsessionid=x), which is how a log line names a request; or a query or
 * fragment that nothing before it in the run starts a url for (search:
 * ?code=x, hash changed: #access_token=x, GET api/x?token=x), which is then
 * screened on its own. A path starts at a '/' that does not follow a word
 * character, '/' or '.', so a file path or a fraction is not taken for one.
 * Credentials are not looked for here: safeText strips them wherever a url
 * starts.
 *
 * @param {string} run
 * @param {string} before  the character before the run, '' at the start
 */
function urlStart(run, before) {
  const scheme = SCHEME.exec(run);
  let start = scheme ? scheme.index : -1;
  // The first query or fragment mark with something after it, and the last
  // such mark or ';', which a path must come before.
  let first = -1;
  let mark = -1;
  for (let index = 0; index < run.length - 1; index += 1) {
    const char = run[index];
    if (char === '?' || char === '#') {
      if (first === -1) first = index;
      mark = index;
    } else if (char === ';') {
      mark = index;
    }
  }
  for (let index = 0; index < mark && (start === -1 || index < start); index += 1) {
    if (run[index] === '/' && !/[\w/.]/.test(index ? run[index - 1] : before)) {
      start = index;
      break;
    }
  }
  return first !== -1 && (start === -1 || first < start) ? first : start;
}

// A stack frame's line up to the url it names: V8's "    at f (" and
// "    at ", Firefox and Safari's "f@", "@" and "global code@".
const FRAME_LEAD = /^\s*at\s(?:.*\(|\s*)$|^\s*(?:[^\s@()]*|(?:global|module|eval) code)@$/;

/**
 * Whether the url that starts at this offset is the one a stack frame names.
 * The whole line before it must read as a frame: a '(' or an 'at' in prose
 * (Login failed (https://…), Look at https://…) does not make one. A line
 * that runs longer than a frame's name before its url is not a frame.
 */
function inFrame(text, at) {
  const before = text.slice(Math.max(0, at - 300), at);
  const lineStart = before.lastIndexOf('\n');
  if (lineStart === -1 && at > 300) return false;
  return FRAME_LEAD.test(before.slice(lineStart + 1));
}

/**
 * Every url in a line of page text or a stack frame, through safeUrl. What
 * the scan took in that belongs to the text is kept out of the url first:
 * closing punctuation, a bracket the url did not open, and a frame's
 * :line:col, which would otherwise vanish into a masked value. Credentials
 * go from the whole run, wherever a url in it starts, since a url glued to
 * a word (foo_https://u:p@…) or run into another holds them too.
 */
function safeText(text) {
  const whole = String(text);
  return whole.replace(URL_RUN, (run, offset) => {
    const start = urlStart(run, offset ? whole[offset - 1] : '');
    if (start === -1) return withoutCredentials(run);
    const found = run.slice(start);
    // Counted once and kept up to date as the end moves back, so a long run
    // of closing brackets costs one pass rather than one per bracket.
    const tally = { '(': 0, ')': 0, '[': 0, ']': 0 };
    for (const char of found) if (char in tally) tally[char] += 1;
    let end = found.length;
    for (;;) {
      const last = found[end - 1];
      const open = { ')': '(', ']': '[' }[last];
      if ('.,;:!?'.includes(last)) end -= 1;
      else if (open && tally[open] < tally[last]) {
        tally[last] -= 1;
        end -= 1;
      } else break;
    }
    let url = found.slice(0, end);
    // In a stack frame, the url is followed by its position: "at f (url:3:9)",
    // "at url:3:9", "f@url:3:9". Every current engine writes both the line and
    // the column, so a single number, or any number outside a frame, is taken
    // to be part of the last value (auth=admin:1234, alice@url?auth=admin:1234).
    const position = /:\d+:\d+$/.exec(url);
    if (position && /[?#;]/.test(url.slice(0, position.index)) && inFrame(whole, offset + start)) {
      end = position.index;
      url = found.slice(0, end);
    }
    return withoutCredentials(run.slice(0, start) + safeUrl(url) + found.slice(end));
  });
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function distinctPages(items) {
  return [...new Set(items.map((item) => item.url).filter(Boolean))];
}

/**
 * Whether the urls in this report can print as bare paths.
 *
 * On one origin the origin is noise, repeated on every line of a report that
 * never left the host. Across two it is the only thing separating /cart on
 * localhost from /cart on staging, and the opening line says no more than
 * "across 2 pages", so the full url has to carry the difference.
 */
function oneOrigin(items, page) {
  const origins = new Set(distinctPages(items).map(originOf));
  if (page?.url) origins.add(originOf(page.url));
  return origins.size <= 1;
}

/**
 * Where the report happened, for the opening line.
 *
 * One page is named outright. Several are counted rather than listed, because
 * each item names its own page further down and the first line should stay
 * short enough to read as a directive. With the page toggle off the count
 * survives but no URL does.
 */
function describeScope(items, page, showUrl) {
  const urls = distinctPages(items);
  if (urls.length > 1) return `across ${urls.length} pages`;
  const url = page ? urls[0] || page.url : '';
  return url ? `on ${showUrl(url)}` : 'on the captured page';
}

/**
 * The sentence saying the buffers are missing, or '' when they were read.
 *
 * Printed because a report with no console section otherwise reads as a page
 * that logged nothing, which is exactly the conclusion it cannot support.
 *
 * Neither wording blames the captured page. The buffers are read from the tab
 * in view when the copy is made, which need not be where the items were taken
 * (a restricted tab, another busy one), so all either can say for certain is
 * that nothing came back.
 */
function unreadNotice(contextError) {
  if (!contextError) return '';
  const reason =
    contextError === 'timeout'
      ? 'not read for this report (the browser tab did not answer in time)'
      : 'not available for this report';
  return `${reason}, so nothing can be concluded from their absence.`;
}

/**
 * Whether an item recorded the page load it was captured on, and that load
 * is not the one this report read: an earlier load of the address, or
 * another tab open on it. Which of the two is not known, so nothing printed
 * claims a reload on this evidence.
 */
function otherLoad(item, armedAt) {
  return Number.isFinite(item.armedAt) && Number.isFinite(armedAt) && item.armedAt !== armedAt;
}

/**
 * For an item that recorded no load (kept from an older build, or captured
 * on a page too busy to answer): whether it was captured before the page the
 * buffers came from last loaded. Two loads of one address print the same
 * url, so only the time can tell them apart.
 */
function capturedBeforeLoad(item, armedAt) {
  return (
    !Number.isFinite(item.armedAt) &&
    Number.isFinite(armedAt) &&
    Number.isFinite(item.capturedAt) &&
    item.capturedAt < armedAt
  );
}

/** The page the log was read on, printed or not. */
function readPage(report) {
  return report.page?.url || report.readUrl || '';
}

/**
 * Whether two urls name the same page: the same origin, path, query and
 * fragment as new URL() reads them, so an empty '?' or '#' makes no
 * difference, and the values of secret parameters make none either. Not the
 * printed form, which with the page toggle off drops the origin, and would
 * take /checkout on staging for /checkout on localhost.
 */
function samePlace(a, b) {
  const place = (url) => {
    try {
      const parsed = new URL(url);
      return `${parsed.origin} ${parsed.protocol}${parsed.host}${parsed.pathname}${maskParams(parsed.search)}${maskParams(parsed.hash)}`;
    } catch {
      return safeUrl(url);
    }
  };
  return place(a) === place(b);
}

/**
 * Whether an item was captured on the very page load whose log this report
 * read, so that the log holds what led up to it. An item that recorded no
 * load is judged by its page and its time instead, and only when both are
 * known: placed on the wrong log, another page's errors would read as the
 * cause of its screenshot.
 */
function onThisLog(item, report) {
  if (!Number.isFinite(report.armedAt)) return false;
  if (Number.isFinite(item.armedAt)) return item.armedAt === report.armedAt;
  if (!Number.isFinite(item.capturedAt) || item.capturedAt < report.armedAt) return false;
  const read = readPage(report);
  return Boolean(read && item.url) && samePlace(item.url, read);
}

/**
 * The time from which no ring had yet pushed anything out: before it, an
 * entry may have been dropped. -Infinity when nothing was dropped.
 */
function completeSince(report) {
  const dropped = report.dropped || {};
  const lines = report.consoleLines || [];
  const rings = [
    [dropped.console, lines.filter((entry) => entry.level !== 'warn')],
    [dropped.warnings, lines.filter((entry) => entry.level === 'warn')],
    [dropped.errors, report.errors || []],
    [dropped.network, report.network || []],
  ];
  let since = -Infinity;
  for (const [count, kept] of rings) {
    if (!Number.isInteger(count) || count <= 0) continue;
    const times = kept.map((entry) => entry.t).filter(Number.isFinite);
    if (times.length) since = Math.max(since, Math.min(...times));
  }
  return since;
}

/**
 * The log split up by item, for a list: for each item captured on this page
 * load, what was logged since the capture before it, and then what came
 * after the last one. A list of three things noticed on the way through a
 * flow otherwise ended in one log of everything, and which error belonged to
 * which screenshot was left to guesswork.
 *
 * Null when there is no log to split: one item, nothing read, or no
 * collector start time to measure captures against.
 */
function splitLog(items, report) {
  if (items.length < 2 || report.contextError || !Number.isFinite(report.armedAt)) return null;
  const entries = [
    ...(report.errors || []).map(errorEntry),
    ...(report.consoleLines || []).map(consoleEntry),
    ...(report.network || []).map(networkEntry),
  ].sort(byTime);
  const logged = items.filter(
    (item) => Number.isFinite(item.capturedAt) && onThisLog(item, report)
  );
  // No capture on this load, so nothing to split by: the log prints whole,
  // under the caution that it was read somewhere none of them were taken.
  if (!logged.length) return null;
  const buckets = new Map(logged.map((item) => [item, []]));
  const after = [];
  for (const entry of entries) {
    const owner = Number.isFinite(entry.t)
      ? logged.find((item) => entry.t <= item.capturedAt - report.armedAt)
      : undefined;
    (owner ? buckets.get(owner) : after).push(entry);
  }
  return { logged, buckets, after, since: completeSince(report) };
}

/** The lines an item of a list carries about the log: its own entries, or why there are none. */
function itemLog(item, items, split, report) {
  const said = (text) => ['', `Console and network: ${text}`];
  const bucket = split.buckets.get(item);
  if (bucket) {
    const previous = split.logged[split.logged.indexOf(item) - 1];
    // A quiet log reads as a clean one, so an item whose stretch of the log
    // began before the collector last dropped something says so.
    const start = previous ? previous.capturedAt - report.armedAt : -Infinity;
    const cut =
      start < split.since
        ? said('the collector had already dropped older entries, so this log may be incomplete.')
        : [];
    if (!bucket.length) return cut;
    const since = previous
      ? `since item ${items.indexOf(previous) + 1}`
      : 'on this page load before this capture';
    return ['', `Logged ${since}:`, fence(renderEntries(bucket, clockFor(report)).join('\n')), ...cut];
  }
  const read = readPage(report);
  // Nothing to compare against: only that this log does not hold it is known.
  if (!read) return said('recorded on another page or another load of this one, which this report did not read.');
  if (item.url && !samePlace(item.url, read)) {
    return said('recorded on another page, which this report did not read.');
  }
  if (otherLoad(item, report.armedAt)) {
    return said('recorded on another load of this page (an earlier one, or another tab), which this report did not read.');
  }
  if (capturedBeforeLoad(item, report.armedAt)) {
    return said('recorded before this page last loaded, which this report could not read.');
  }
  return [];
}

/**
 * @param {{ elsewhere: Item[], other: Item[], before: Item[] }} stale Items
 *   captured on another page, items that recorded another load of this page
 *   (an earlier one, or another tab), and items that recorded no load but
 *   were captured before this page last loaded.
 */
function formatPage(report, stale, showUrl) {
  const { page } = report;
  const { viewport } = page;
  const details = [`- URL: ${showUrl(page.url)}`];
  if (page.title) details.push(`- Title: ${page.title}`);
  if (viewport) {
    const dpr = viewport.dpr && viewport.dpr !== 1 ? ` @${viewport.dpr}x` : '';
    details.push(`- Viewport: ${viewport.width} x ${viewport.height}${dpr}`);
  }

  // The screenshots have their own times; the buffers are read when the prompt
  // is built. A report can be assembled days after its captures, and Claude
  // Code should be able to tell a Monday screenshot from a Thursday console.
  const built = Number.isFinite(report.builtAt) ? report.builtAt : Date.now();
  const times = report.items.map((item) => item.capturedAt).filter(Number.isFinite);
  const first = times.length ? Math.min(...times) : built;
  const last = times.length ? Math.max(...times) : built;
  details.push(
    last - first > MINUTE ? `- Captured: ${stamp(first)} to ${stamp(last)}` : `- Captured: ${stamp(first)}`
  );

  // Nothing was read, so there is no read time to give and nothing for a
  // caution to qualify.
  const unread = unreadNotice(report.contextError);
  if (unread) {
    details.push(`- Console and network: ${unread}`);
    return `## Page\n${details.join('\n')}`;
  }

  if (built - last > MINUTE) details.push(`- Console and network read: ${stamp(built)}`);
  const dropped = droppedNotice(report.dropped);
  if (dropped) details.push(`- Console and network: ${dropped}`);

  // The image is a moment in time; the console and network buffers are read
  // when the report is built. A navigation or a reload in between makes them
  // disagree, and Claude Code should know which half to trust.
  const { elsewhere, other, before } = stale;
  const affected = report.items.filter(
    (item) => elsewhere.includes(item) || other.includes(item) || before.includes(item)
  );
  if (affected.length === 1 && report.items.length === 1) {
    let caution;
    if (elsewhere.length) {
      caution =
        `the screenshot was taken on ${showUrl(elsewhere[0].url)}, but the page changed before ` +
        'this report was generated. The console and network entries below come from the ' +
        'current page, so they may not correspond to the image.';
    } else if (other.length) {
      caution =
        'the screenshot was taken on another load of this page (an earlier one, or another ' +
        'tab). The console and network entries below come from the load this report read, ' +
        'so they may not correspond to the image.';
    } else {
      caution =
        'the page was reloaded after the screenshot was taken. The console and network ' +
        'entries below come from the reloaded page, so they may not correspond to the image.';
    }
    details.push(`- CAUTION: ${caution}`);
  } else if (affected.length) {
    const named = (items) => {
      const numbers = items.map((item) => report.items.indexOf(item) + 1);
      return numbers.length === 1
        ? { noun: `Item ${numbers[0]}`, verb: 'was' }
        : { noun: `Items ${numbers.slice(0, -1).join(', ')} and ${numbers.at(-1)}`, verb: 'were' };
    };
    // Each reason names its own items, so the reader knows which screenshots
    // were taken on another page and which on another load of this one.
    const reasons = [
      [elsewhere, 'elsewhere'],
      [other, 'on another load of this page'],
      [before, 'before this page last loaded'],
    ]
      .filter(([list]) => list.length)
      .map(([list, where], index) => {
        const { noun, verb } = named(list);
        return index === 0 ? `${noun} ${verb} captured ${where}` : `${noun.toLowerCase()} ${where}`;
      });
    const which =
      reasons.length === 1
        ? reasons[0]
        : `${reasons.slice(0, -1).join(', ')}, and ${reasons.at(-1)}`;
    details.push(
      `- CAUTION: the console and network entries below were read on this page. ${which}, ` +
        'so they may not correspond to those screenshots.'
    );
  }

  return `## Page\n${details.join('\n')}`;
}

/**
 * @param {Report} report
 * @returns {string} Markdown ready for the clipboard.
 */
export function buildPrompt(report) {
  const items = report.items?.length ? report.items : [{ description: '' }];
  const sections = [];

  const counts = { bug: 0, change: 0 };
  for (const item of items) counts[item.intent === 'change' ? 'change' : 'bug'] += 1;
  const mixed = counts.bug > 0 && counts.change > 0;
  const voice = mixed ? MIXED : voiceOf(items[0]);
  // Decided once for the whole report, so that a url cannot print as a path in
  // the opening line and in full three sections later.
  const showUrl = oneOrigin(items, report.page) ? pathOf : safeUrl;
  const where = describeScope(items, report.page, showUrl);
  const split = splitLog(items, report);

  sections.push(mixed ? MIXED.lead(counts, where) : voice.lead(items.length, where));

  if (items.length === 1) {
    // One item reads as a report, not a list: the description gets the
    // heading, the screenshot gets its own section, and the element stays a
    // section of its own at the end.
    const [item] = items;
    sections.push(`## ${voice.heading}\n${item.description?.trim() || '(no description given)'}`);
    if (item.screenshotPath) {
      sections.push(`## Screenshot\n${item.screenshotPath}\n\n${voice.screenshot}`);
    }
  } else {
    // Several items read as a list. Each is numbered so the closing line can
    // ask for changes to be attributed back to it, and carries its own page
    // only when the items disagree about where they were taken.
    // On what gets printed, not on the raw url. Two urls that differ only in an
    // empty fragment print identically, and a "Page:" line repeating the line
    // above it reads as a bug in the tool.
    const samePage = new Set(distinctPages(items).map(showUrl)).size <= 1;
    if (items.every((item) => item.screenshotPath)) {
      sections.push(voice.screenshots);
    } else if (items.some((item) => item.screenshotPath)) {
      sections.push(
        'Where an item names a screenshot on disk, read that image before working on the item.'
      );
    }

    items.forEach((item, index) => {
      const lines = [
        `## ${index + 1}. ${voiceOf(item).heading}`,
        item.description?.trim() || '(no description given)',
      ];
      const facts = [];
      if (item.screenshotPath) facts.push(`Screenshot: ${item.screenshotPath}`);
      if (!samePage && item.url && report.page) facts.push(`Page: ${showUrl(item.url)}`);
      if (facts.length) lines.push('', ...facts);
      if (item.element) lines.push('', ...formatElement(item.element, 'Selected element'));
      if (split) lines.push(...itemLog(item, items, split, report));
      sections.push(lines.join('\n'));
    });
  }

  if (report.page) {
    // Likewise: a CAUTION saying the screenshot was taken somewhere else, above
    // a URL line naming that same place, is worse than no caution at all.
    const elsewhere = items.filter(
      (item) => item.url && showUrl(item.url) !== showUrl(report.page.url)
    );
    const other = items.filter(
      (item) => !elsewhere.includes(item) && otherLoad(item, report.armedAt)
    );
    const before = items.filter(
      (item) => !elsewhere.includes(item) && capturedBeforeLoad(item, report.armedAt)
    );
    // A split log says under each item where its entries are, or why there
    // are none, so a caution here would only repeat it, about entries "below"
    // that are above.
    const stale = split ? { elsewhere: [], other: [], before: [] } : { elsewhere, other, before };
    sections.push(formatPage(report, stale, showUrl));
  } else {
    // The page toggle is off, which keeps urls out, but a missing log, or a
    // log cut short, still has to be explained somewhere.
    const said = unreadNotice(report.contextError) || droppedNotice(report.dropped);
    if (said) sections.push(`## Console and network\n${said[0].toUpperCase()}${said.slice(1)}`);
  }

  if (split) {
    // Split under the items above; what is left came after the last of them.
    if (split.after.length) {
      sections.push(
        `## Logged after the last capture on this page\n` +
          fence(renderEntries(split.after, clockFor(report)).join('\n'))
      );
    }
  } else {
    const consoleLines = formatConsole(report.consoleLines, report.errors, clockFor(report));
    if (consoleLines.length) {
      sections.push(`## Console output\n${fence(consoleLines.join('\n'))}`);
    }

    const networkLines = formatNetwork(report.network, clockFor(report));
    if (networkLines.length) {
      sections.push(`## Failed network requests\n${fence(networkLines.join('\n'))}`);
    }
  }

  if (items.length === 1 && items[0].element) {
    sections.push(`## Selected element\n${formatElement(items[0].element).join('\n')}`);
  }

  const closing = items.length > 1 ? `${voice.closing} ${MANY_ITEMS}` : voice.closing;
  sections.push(`---\n${closing}`);

  return sections.join('\n\n');
}
