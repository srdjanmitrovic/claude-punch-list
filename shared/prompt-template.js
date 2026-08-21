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
 * @property {string=} url            Page the item was captured on.
 * @property {number=} capturedAt     When, as epoch milliseconds.
 * @property {Object=} element        { selector, html, styles, text, truncated }
 *
 * @typedef {Object} Report
 * @property {Item[]}  items         In capture order. Never empty.
 * @property {Object=} page          { url, title, viewport:{width,height,dpr} }
 *                                   The page the console and network buffers
 *                                   were read from, which is the current tab.
 *                                   Absent when the page toggle is off, in
 *                                   which case no URL is printed anywhere,
 *                                   though pages are still counted.
 * @property {Array=}  consoleLines  [{ level, text, t }]
 * @property {Array=}  errors        [{ kind, text, where, stack, t }]
 * @property {Array=}  network       [{ method, url, status, statusText, ms }]
 * @property {number}  builtAt       When the buffers were read and the prompt
 *                                   assembled, as epoch milliseconds.
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

function formatConsole(consoleLines = [], errors = []) {
  const lines = [];

  for (const error of errors) {
    const label = error.kind === 'unhandled-rejection' ? 'unhandled' : 'error';
    lines.push(`[${label}] ${error.text}`);

    if (error.stack) {
      // Skip line 0: it repeats the message already printed above. The next few
      // frames are the throw site and its callers; deeper ones are usually
      // framework internals and not worth the tokens.
      const frames = error.stack
        .split('\n')
        .slice(1, 4)
        .map((frame) => frame.trim())
        .filter(Boolean);
      for (const frame of frames) lines.push(`          ${frame}`);
    } else if (error.where) {
      // Only useful when there is no stack, since the first stack frame names
      // the same location and adds the function name.
      lines.push(`          at ${error.where}`);
    }
  }

  for (const entry of consoleLines) {
    lines.push(`[${entry.level}] ${entry.text}`);
  }

  return lines;
}

function formatNetwork(network = []) {
  return network.map((request) => {
    const status = request.status === 0 ? 'FAILED' : request.status;
    const timing = request.ms ? ` (${request.ms}ms)` : '';
    return `${request.method} ${request.url} -> ${status} ${request.statusText || ''}${timing}`.trim();
  });
}

function formatStyles(styles = {}) {
  const entries = Object.entries(styles);
  if (!entries.length) return '';
  return entries.map(([property, value]) => `${property}: ${value}`).join('; ');
}

/**
 * The lines describing a picked element, so the single-item layout can give
 * them a section of their own and the list layout can tuck them under the item
 * they belong to. Only the label on the first line differs.
 */
function formatElement(element, label = 'Selector') {
  const parts = [`${label}: \`${element.selector}\``];
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

function distinctPages(items) {
  return [...new Set(items.map((item) => item.url).filter(Boolean))];
}

/**
 * Where the report happened, for the opening line.
 *
 * One page is named outright. Several are counted rather than listed, because
 * each item names its own page further down and the first line should stay
 * short enough to read as a directive. With the page toggle off the count
 * survives but no URL does.
 */
function describeScope(items, page) {
  const urls = distinctPages(items);
  if (urls.length > 1) return `across ${urls.length} pages`;
  const url = page ? urls[0] || page.url : '';
  return url ? `on ${url}` : 'on the captured page';
}

function formatPage(report, itemsElsewhere) {
  const { page } = report;
  const { viewport } = page;
  const details = [`- URL: ${page.url}`];
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
  if (built - last > MINUTE) details.push(`- Console and network read: ${stamp(built)}`);

  // The image is a moment in time; the console and network buffers are read
  // when the report is built. A reload or navigation in between makes them
  // disagree, and Claude Code should know which half to trust.
  if (itemsElsewhere.length === 1 && report.items.length === 1) {
    details.push(
      `- CAUTION: the screenshot was taken on ${itemsElsewhere[0].url}, but the page ` +
        'changed before this report was generated. The console and network entries below ' +
        'come from the current page, so they may not correspond to the image.'
    );
  } else if (itemsElsewhere.length) {
    const numbers = itemsElsewhere.map((item) => report.items.indexOf(item) + 1);
    const which =
      numbers.length === 1
        ? `Item ${numbers[0]} was`
        : `Items ${numbers.slice(0, -1).join(', ')} and ${numbers.at(-1)} were`;
    details.push(
      `- CAUTION: the console and network entries below were read on this page. ${which} ` +
        'captured elsewhere, so they may not correspond to those screenshots.'
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
  const where = describeScope(items, report.page);

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
    const samePage = distinctPages(items).length <= 1;
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
      if (!samePage && item.url && report.page) facts.push(`Page: ${item.url}`);
      if (facts.length) lines.push('', ...facts);
      if (item.element) lines.push('', ...formatElement(item.element, 'Selected element'));
      sections.push(lines.join('\n'));
    });
  }

  if (report.page) {
    const elsewhere = items.filter((item) => item.url && item.url !== report.page.url);
    sections.push(formatPage(report, elsewhere));
  }

  const consoleLines = formatConsole(report.consoleLines, report.errors);
  if (consoleLines.length) {
    sections.push(`## Console output\n${fence(consoleLines.join('\n'))}`);
  }

  const networkLines = formatNetwork(report.network);
  if (networkLines.length) {
    sections.push(`## Failed network requests\n${fence(networkLines.join('\n'))}`);
  }

  if (items.length === 1 && items[0].element) {
    sections.push(`## Selected element\n${formatElement(items[0].element).join('\n')}`);
  }

  const closing = items.length > 1 ? `${voice.closing} ${MANY_ITEMS}` : voice.closing;
  sections.push(`---\n${closing}`);

  return sections.join('\n\n');
}
