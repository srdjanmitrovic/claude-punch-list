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
 * @property {Array=}  consoleLines  [{ level, text, t }]
 * @property {Array=}  errors        [{ kind, text, where, stack, t }]
 * @property {Array=}  network       [{ method, url, status, statusText, ms,
 *                                   caller }], where caller is the stack that
 *                                   sent the request, nearest frame first.
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

/**
 * A failed request per line, and under it the code that sent it.
 *
 * The frames are the strongest locator in this prompt: a 500 names a route, but
 * the first frame names the file and the line the call was written on. They are
 * nearest first, so that first frame is the function that called fetch and the
 * ones after it are its callers. The continuation lines are indented to sit
 * under the label rather than the margin, because a bare frame on the left
 * would read as another request.
 */
function formatNetwork(network = []) {
  const lines = [];
  for (const request of network) {
    const status = request.status === 0 ? 'FAILED' : request.status;
    const timing = request.ms ? ` (${request.ms}ms)` : '';
    lines.push(
      `${request.method} ${request.url || '(no url)'} -> ${status} ${request.statusText || ''}${timing}`.trim()
    );

    const frames = (Array.isArray(request.caller) ? request.caller : [])
      .filter((frame) => typeof frame === 'string')
      .map(flatten)
      .filter(Boolean)
      .slice(0, 3);
    frames.forEach((frame, index) => {
      lines.push(index === 0 ? `    called from ${frame}` : `${' '.repeat(16)}${frame}`);
    });
  }
  return lines;
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
  // its own text.
  const ownText = /<[a-z]/i.test(typeof element.html === 'string' ? element.html.slice(1) : '')
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
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) return safeUrl(url);
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    // A landing page has no path to speak of, and "Fix this issue on /" names
    // nothing at all. The host is the only identifying thing left, so keep it.
    return path === '/' ? safeUrl(url) : path;
  } catch {
    return url;
  }
}

/**
 * A url with any embedded credentials removed.
 *
 * Printing one in full is the two origin fallback, and https://user:pass@host/
 * is a real thing to have in an address bar. Dropping the origin happened to
 * strip it; printing the url must not put it back, on the clipboard and into a
 * prompt the user is about to paste somewhere.
 */
function safeUrl(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = '';
    parsed.password = '';
    return parsed.href;
  } catch {
    return url;
  }
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

function formatPage(report, itemsElsewhere, showUrl) {
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
  if (built - last > MINUTE) details.push(`- Console and network read: ${stamp(built)}`);

  // The image is a moment in time; the console and network buffers are read
  // when the report is built. A reload or navigation in between makes them
  // disagree, and Claude Code should know which half to trust.
  if (itemsElsewhere.length === 1 && report.items.length === 1) {
    details.push(
      `- CAUTION: the screenshot was taken on ${showUrl(itemsElsewhere[0].url)}, but the page ` +
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
  // Decided once for the whole report, so that a url cannot print as a path in
  // the opening line and in full three sections later.
  const showUrl = oneOrigin(items, report.page) ? pathOf : safeUrl;
  const where = describeScope(items, report.page, showUrl);

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
      sections.push(lines.join('\n'));
    });
  }

  if (report.page) {
    // Likewise: a CAUTION saying the screenshot was taken somewhere else, above
    // a URL line naming that same place, is worse than no caution at all.
    const elsewhere = items.filter(
      (item) => item.url && showUrl(item.url) !== showUrl(report.page.url)
    );
    sections.push(formatPage(report, elsewhere, showUrl));
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
