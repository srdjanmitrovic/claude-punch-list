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
 *   - Ordering. Claude Code reads top to bottom. Right now the description comes
 *     first and the raw context last, on the theory that intent should frame the
 *     evidence. Putting console errors first would bias it toward the stack
 *     trace instead. Both are defensible.
 *   - Instruction strength. The closing line currently asks it to find the root
 *     cause before editing. Softening that to "propose a fix" gets faster,
 *     shallower answers; that is sometimes what you want.
 *   - Whether to tell it to read the screenshot. Claude Code will not open the
 *     image unless something points at it, hence the explicit line.
 *   - The wording of each intent in INTENTS below. Those eight strings are the
 *     entire difference between reporting a bug and proposing a change.
 *
 * Edit freely and reload the extension. No other file needs to change.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * @typedef {Object} Report
 * @property {'bug'|'change'=} intent Which voice to speak in. See INTENTS below.
 * @property {string}  description   What the user typed.
 * @property {string=} screenshotPath Absolute path to the saved PNG.
 * @property {Object=} page          { url, title, viewport:{width,height,dpr} }
 * @property {Array=}  consoleLines  [{ level, text, t }]
 * @property {Array=}  errors        [{ kind, text, where, stack, t }]
 * @property {Array=}  network       [{ method, url, status, statusText, ms }]
 * @property {Object=} element       { selector, html, styles, text, truncated }
 * @property {string}  capturedAt    Human-readable local timestamp.
 * @property {string=} pageChangedFrom URL the screenshot was taken on, set only
 *                                   when the page navigated before saving, so
 *                                   the image and the console output disagree.
 */

/**
 * The two voices this template speaks in.
 *
 * The evidence is identical either way. A screenshot, a console buffer and a DOM
 * node describe the page the same regardless of why it is being reported, so
 * only the framing around that evidence changes: the opening directive, the
 * heading over the user's own words, the reason to open the image, and the
 * closing instruction. Keeping those four strings here rather than forking
 * buildPrompt is what stops the two prompts drifting apart in the parts that
 * were never supposed to differ.
 *
 * The closing lines are where the two really diverge, and they are worth
 * reading as a pair. A bug has a root cause and asking for it first is what
 * stops Claude Code patching the symptom. A change has no root cause; the
 * corresponding risk is that it quietly grows, so that line asks for the
 * smallest version instead.
 *
 * 'bug' is the fallback for any report with no intent, which covers drafts made
 * before this existed and the sample in tools/preview-prompt.mjs.
 */
const INTENTS = {
  bug: {
    lead: (url) => (url ? `Fix this issue on ${url}` : 'Fix this issue on the captured page'),
    heading: "What's wrong",
    screenshot: 'Read that image before anything else. It shows the problem as rendered.',
    closing:
      'Find the root cause in this codebase before changing anything. ' +
      'If the screenshot and the console point at different things, say so rather than guessing.',
  },
  change: {
    lead: (url) => (url ? `Make this change on ${url}` : 'Make this change on the captured page'),
    heading: 'What should change',
    screenshot:
      'Read that image before anything else. It shows the current behaviour, which is what ' +
      'this change is measured against.',
    closing:
      'Find where this is implemented before writing anything, and follow the patterns already ' +
      'in this codebase rather than introducing new ones. If the change is larger than it looks, ' +
      'say so and propose the smallest version that delivers it.',
  },
};

/** Fence a block of text, avoiding accidental fence collisions. */
function fence(body, language = '') {
  const ticks = body.includes('```') ? '````' : '```';
  return `${ticks}${language}\n${body}\n${ticks}`;
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
 * @param {Report} report
 * @returns {string} Markdown ready for the clipboard.
 */
export function buildPrompt(report) {
  const sections = [];
  const url = report.page?.url || '';
  const voice = INTENTS[report.intent] || INTENTS.bug;

  sections.push(voice.lead(url));

  sections.push(
    `## ${voice.heading}\n${report.description?.trim() || '(no description given)'}`
  );

  if (report.screenshotPath) {
    sections.push(`## Screenshot\n${report.screenshotPath}\n\n${voice.screenshot}`);
  }

  if (report.page) {
    const { viewport } = report.page;
    const details = [`- URL: ${report.page.url}`];
    if (report.page.title) details.push(`- Title: ${report.page.title}`);
    if (viewport) {
      const dpr = viewport.dpr && viewport.dpr !== 1 ? ` @${viewport.dpr}x` : '';
      details.push(`- Viewport: ${viewport.width} x ${viewport.height}${dpr}`);
    }
    details.push(`- Captured: ${report.capturedAt}`);
    if (report.pageChangedFrom) {
      details.push(
        `- CAUTION: the screenshot was taken on ${report.pageChangedFrom}, but the page ` +
          'changed before this report was generated. The console and network entries below ' +
          'come from the current page, so they may not correspond to the image.'
      );
    }
    sections.push(`## Page\n${details.join('\n')}`);
  }

  const consoleLines = formatConsole(report.consoleLines, report.errors);
  if (consoleLines.length) {
    sections.push(`## Console output\n${fence(consoleLines.join('\n'))}`);
  }

  const networkLines = formatNetwork(report.network);
  if (networkLines.length) {
    sections.push(`## Failed network requests\n${fence(networkLines.join('\n'))}`);
  }

  if (report.element) {
    const parts = [`Selector: \`${report.element.selector}\``];
    if (report.element.html) {
      parts.push(fence(report.element.html, 'html'));
    }
    const styles = formatStyles(report.element.styles);
    if (styles) parts.push(`Computed styles: ${styles}`);
    if (report.element.truncated) {
      parts.push('_(markup truncated; open the page to see the full subtree)_');
    }
    sections.push(`## Selected element\n${parts.join('\n')}`);
  }

  sections.push(`---\n${voice.closing}`);

  return sections.join('\n\n');
}
