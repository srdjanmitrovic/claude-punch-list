/**
 * Render the prompt template against sample data.
 *
 *     node tools/preview-prompt.mjs           # one bug
 *     node tools/preview-prompt.mjs change    # one suggested change
 *     node tools/preview-prompt.mjs mixed     # a list: two changes and a bug, across two pages
 *     node tools/preview-prompt.mjs minified  # one bug on a production build, where the
 *                                             # component name is the bundler's
 *     node tools/preview-prompt.mjs reloaded  # any other branch, by the name of its
 *                                             # file under test/golden (see EXTRA)
 *
 * Editing shared/prompt-template.js normally means reloading the extension and
 * capturing something to see the result. This skips all of that: it imports the
 * real template, feeds it a representative report, and prints exactly what
 * would land on the clipboard.
 *
 * The samples deliberately include every optional section at once, which is
 * the worst case for length. A real capture usually has fewer.
 *
 * The tests import sampleReport() and EXTRA from here, so the golden files
 * under test/golden and what this prints are always built from the same data.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildPrompt } from '../shared/prompt-template.js';

const PAGE = {
  url: 'http://localhost:3000/checkout',
  title: 'Checkout | Example Store',
  viewport: { width: 1280, height: 720, dpr: 2 },
};

const FOLDER = '/Users/you/Downloads/claude-punch-list';

const at = (time) => Date.parse(`2026-08-07T${time}`);

// Same page, same evidence, two reasons for reporting it. Reading the pair back
// to back is the point: everything between the first line and the last should
// be byte for byte identical.
const SINGLE = {
  bug: {
    intent: 'bug',
    description:
      'The order total shows NaN after applying a coupon. Expected the discounted price.',
  },
  change: {
    intent: 'change',
    description:
      'The coupon field should validate as you type instead of only on submit, so the ' +
      'discounted total updates inline.',
  },
};

// The owner deliberately differs from names[0]: CartSummary writes this span
// and passes it down, so the source path is CartSummary's file and not the file
// Total is defined in. That is the case the wording has to get right, and it is
// the one a sample that always agreed with itself would never show.
const ELEMENT = {
  selector: 'form.coupon > div.cart-summary > span.total',
  html:
    '<span class="total price price--emphasis _total_1f3k9_12" data-testid="cart-total" ' +
    'aria-label="Order total">NaN</span>',
  // The picker sends these separately from the markup, and the search line is
  // built out of them rather than out of the HTML. `NaN` is here to be rejected:
  // it is what the page computed this render, not anything anyone can grep for.
  attributes: { 'data-testid': 'cart-total', 'aria-label': 'Order total' },
  text: 'NaN',
  truncated: false,
  styles: {
    display: 'inline',
    color: 'rgb(220, 38, 38)',
    'font-size': '18px',
    'font-weight': '700',
  },
  component: {
    framework: 'react',
    build: 'development',
    names: ['Total', 'CartSummary', 'CheckoutPage'],
    owner: 'CartSummary',
    // What Vite serves: the module url's pathname, with the ?t= cache buster
    // already stripped by the collector. React 19.1 and later record no
    // source location, so the collector reads this out of _debugStack, and
    // the line and column are where the transformed module the browser ran
    // has the JSX, which is what sourceFrom says.
    source: '/src/components/cart/CartSummary.tsx:42:9',
    sourceFrom: 'stack',
    props: ['amount=NaN', 'currency="EUR"', 'onRetry=ƒ handleSave'],
    hops: 0,
  },
  // Two elements up on purpose. A total has no handlers of its own; the form
  // around it does, and that is the case the wording has to get right, because
  // "Handlers: onSubmit=ƒ handleApply" under a span would send a reader looking
  // for an onSubmit in Total.
  handlers: {
    hops: 2,
    label: 'form.coupon',
    list: ['onSubmit=ƒ handleApply', 'onChange=ƒ'],
    starts: 'setPending(true); applyCoupon(inputRef.current ? ...',
    startsOf: 'onSubmit',
  },
  // What content/picker.js says of a Vite CSS Module class. Vite's class carries
  // the local name and the line it is declared on, and a hash of the file path
  // in place of the path, so the clause can name the rule and its line but not
  // the file. The webpack and Next.js shape is the one that names a file.
  classHints: [
    '_total_1f3k9_12 is a Vite CSS Module: local .total declared on line 12 of its module file, whose name the class does not carry',
  ],
};

// The same element on a production build, and the case the component wording
// has to work hardest for. Every field here came off a real minified bundle:
// the name is terser's, three ancestors were dropped for the same reason, and
// TooltipProviderProvider collapsed into the TooltipProvider that rendered it.
// Nothing in `names` can be grepped except the ancestors, so the prompt has to
// point at the props instead, which minification leaves alone.
const MINIFIED_ELEMENT = {
  selector: 'div.tooltip > span.Tooltip_label__8kq2p',
  html: '<span class="Tooltip_label__8kq2p" data-testid="tooltip-label">Save</span>',
  text: 'Save',
  truncated: false,
  attributes: { 'data-testid': 'tooltip-label' },
  styles: { display: 'inline', 'font-size': '13px' },
  component: {
    framework: 'react',
    build: 'production',
    names: ['A', 'TooltipProvider', 'App'],
    minified: 3,
    renamed: true,
    hops: 0,
    props: ['label="Save"', 'open=true', 'onOpenChange=ƒ noop', 'delayDuration=700'],
  },
  // No `starts` here, which is the production case: the bundle has the handler
  // body but reading it back would print minified code nobody can act on. The
  // names go the same way, so the search line has to carry this element on the
  // test id alone.
  handlers: {
    hops: 0,
    label: '',
    list: ['onClick=ƒ o', 'onMouseEnter=ƒ (anonymous)'],
    starts: '',
    startsOf: '',
  },
  // Next.js names a CSS Module class [file]_[local]__[hash], which is the one
  // production class whose origin can be read straight off the name.
  classHints: ['Tooltip_label__8kq2p is a CSS Module: .label in Tooltip.module.css'],
};

// A walkthrough rather than a single moment: three things noticed on the way
// through a checkout, one of them a page earlier. This is what the list layout
// has to carry, and every branch of it is exercised here: a second page, an
// item with no element, and both intents in one report. The element was
// picked with a mouse, so it was read under the pointer, as nearly every
// mouse pick is.
const LIST = [
  {
    intent: 'change',
    description:
      'The coupon field should validate as you type instead of only on submit, so the ' +
      'discounted total updates inline.',
    screenshotPath: `${FOLDER}/2026-08-07_20-49-02_localhost-checkout.png`,
    url: PAGE.url,
    capturedAt: at('20:49:02'),
    element: { ...ELEMENT, hovered: true },
  },
  {
    intent: 'bug',
    description:
      'The order total shows NaN after applying a coupon. Expected the discounted price.',
    screenshotPath: `${FOLDER}/2026-08-07_20-50-17_localhost-checkout.png`,
    url: PAGE.url,
    capturedAt: at('20:50:17'),
    element: null,
  },
  {
    intent: 'change',
    description:
      'The cart page should show the same shipping estimate the checkout uses. Right now ' +
      'it says "calculated at checkout", which is the step people abandon on.',
    screenshotPath: `${FOLDER}/2026-08-07_20-51-33_localhost-cart.png`,
    url: 'http://localhost:3000/cart',
    capturedAt: at('20:51:33'),
    element: null,
  },
];

export const MODES = ['bug', 'change', 'mixed', 'minified'];

/**
 * The report the panel would hand buildPrompt() for one of MODES.
 *
 * A fresh copy every call, so a caller that edits one (the tests do, to reach
 * branches no preview shows) cannot leak that edit into the next.
 */
export function sampleReport(mode = 'bug') {
  const items =
    mode === 'mixed'
      ? LIST
      : [
          {
            ...SINGLE[mode === 'minified' ? 'bug' : mode],
            screenshotPath: `${FOLDER}/2026-08-07_20-51-33_localhost-checkout.png`,
            url: PAGE.url,
            capturedAt: at('20:51:33'),
            element: mode === 'minified' ? MINIFIED_ELEMENT : ELEMENT,
          },
        ];

  // The page loaded a moment before the capture, and its log is that moment:
  // the request fails, the app warns, and then it throws. The walkthrough's
  // page loaded before its first capture, and the same three entries land
  // between its first and second, so the list prints them under the item
  // that reports the bug.
  const walk = mode === 'mixed';
  const armedAt = walk ? at('20:48:40') : at('20:51:30');
  const shift = walk ? at('20:50:10') - armedAt : 0;
  const later = (entry) => ({ ...entry, t: entry.t + shift });

  return structuredClone({
    items: walk ? items.map((item) => ({ ...item, armedAt: item.url === PAGE.url ? armedAt : CART_LOAD })) : items,
    builtAt: at('20:51:33'),
    armedAt,
    page: PAGE,
    consoleLines: CONSOLE_LINES.map(later),
    errors: ERRORS.map(later),
    network: NETWORK.map(later),
  });
}

// The cart page in the walkthrough is another load with its own collector,
// whose log this report did not read.
const CART_LOAD = at('20:51:25');

const CONSOLE_LINES = [
  { level: 'warn', text: 'Coupon SUMMER25 missing from catalog, falling back to null', t: 1840 },
];

const ERRORS = [
  {
    kind: 'exception',
    text: "TypeError: Cannot read properties of undefined (reading 'price')",
    where: 'http://localhost:3000/js/cart.js:142:18',
    stack:
      "TypeError: Cannot read properties of undefined (reading 'price')\n" +
      '    at applyCoupon (cart.js:142:18)\n' +
      '    at handleSubmit (checkout.js:88:5)\n' +
      '    at HTMLFormElement.<anonymous> (checkout.js:31:9)',
    t: 1902,
  },
];

const NETWORK = [
  {
    method: 'POST',
    url: 'http://localhost:3000/api/coupons/validate',
    status: 500,
    statusText: 'Internal Server Error',
    ms: 243,
    via: 'fetch',
    t: 1650,
    // Nearest frame first, as V8 reports them. Nothing applies a source map:
    // these read as src paths because Vite's dev server serves each module at
    // its source path. A bundled build gives bundle urls and offsets.
    caller: [
      'applyCoupon (/src/components/cart/CartSummary.tsx:70:36)',
      'handleApply (/src/components/cart/CartSummary.tsx:84:13)',
    ],
  },
];

// A selector longer than the line allows, on utility class markup.
export const LONG_SELECTOR =
  'div.min-h-screen.bg-gray-50.dark\\:bg-gray-900 > main.mx-auto.max-w-7xl.px-4 > ' +
  'section.grid.grid-cols-1.lg\\:grid-cols-3:nth-of-type(2) > div.rounded-xl.border.border-gray-200 > ' +
  'div.flex.items-center.justify-between > span.total.text-lg.font-semibold';

// Every branch the four modes never reach, one sample each, so that each can
// be read as it prints (node tools/preview-prompt.mjs vue-and-failures) and
// each has a golden file of the same name. Each starts from a mode's sample
// and changes only what the branch needs, so a diff in one of those files
// points at one cause.
export const EXTRA = {
  // The panel could not read the tab (a tab opened before the extension was
  // installed or reloaded). It sends no evidence, the newest item's own page
  // in place of the one it would have read, and the reason.
  'no-context': () => {
    const report = sampleReport('bug');
    report.page = { url: report.items[0].url, title: 'Checkout | Example Store' };
    report.consoleLines = [];
    report.errors = [];
    report.network = [];
    report.contextError = 'missing';
    return report;
  },

  // The same, for a page too busy to answer before the panel gave up.
  'no-answer': () => {
    const report = sampleReport('bug');
    report.page = { url: report.items[0].url, title: 'Checkout | Example Store' };
    report.consoleLines = [];
    report.errors = [];
    report.network = [];
    report.contextError = 'timeout';
    return report;
  },

  // Nothing read and the page toggle off: no url anywhere, but the missing log
  // is still explained.
  'no-context-no-page': () => {
    const report = sampleReport('bug');
    report.page = null;
    report.consoleLines = [];
    report.errors = [];
    report.network = [];
    report.contextError = 'missing';
    return report;
  },

  // Captured on /checkout, then the page reloaded on the same address before
  // the copy. Only the collector's start time shows it.
  reloaded: () => {
    const report = sampleReport('bug');
    report.armedAt = report.items[0].capturedAt + 30 * 1000;
    return report;
  },

  // A list where /checkout reloaded between items 1 and 2, and item 3 was
  // taken on /cart. Each item says where its entries went; item 2, the first
  // capture on the new load, carries everything that load logged before it.
  'list-reloaded': () => {
    const report = sampleReport('mixed');
    const reload = report.items[1].capturedAt - 10 * 1000;
    // The same moments on the clock, measured from the new load.
    for (const list of [report.consoleLines, report.errors, report.network]) {
      for (const entry of list) entry.t -= reload - report.armedAt;
    }
    report.armedAt = reload;
    report.items[1].armedAt = reload;
    return report;
  },

  // Every item captured somewhere else, and the copy made from a page none of
  // them were taken on: nothing to split by, so the log prints whole under a
  // caution, as it did before items carried their load.
  'list-all-elsewhere': () => {
    const report = sampleReport('mixed');
    // The account page loads after the last capture, and its entries follow.
    report.armedAt = report.items[2].capturedAt + 20 * 1000;
    report.page.url = 'http://localhost:3000/account';
    return report;
  },

  // The walkthrough with the page toggle off. The panel still passes the url
  // it read the log on, never printed, so item 3 (which recorded no load) is
  // still told apart from the checkout page by its own.
  'list-no-page': () => {
    const report = sampleReport('mixed');
    report.page = null;
    report.readUrl = 'http://localhost:3000/checkout';
    delete report.items[2].armedAt;
    return report;
  },

  // One capture in a second tab open on the same address, copied from the
  // first: another load, which the caution must not call a reload.
  'other-tab': () => {
    const report = sampleReport('bug');
    report.items[0].armedAt = report.armedAt - 10 * 1000;
    return report;
  },

  // The walkthrough after a poll filled the network ring: six requests were
  // pushed out, and both checkout items may have lost some of theirs.
  'list-dropped': () => {
    const report = sampleReport('mixed');
    report.dropped = { network: 6 };
    return report;
  },

  // A tab left open overnight on one load: an entry from the evening before
  // carries its date, and today's entries do not.
  overnight: () => {
    const report = sampleReport('bug');
    const day = 24 * 60 * 60 * 1000;
    for (const list of [report.consoleLines, report.errors, report.network]) {
      for (const entry of list) entry.t += day;
    }
    report.armedAt -= day;
    report.consoleLines.push({ level: 'error', text: 'Error: socket closed', t: 30 * 60 * 1000 });
    return report;
  },

  // Requests the page ended itself print after the real failure, labelled,
  // and a status line with no status text keeps single spaces.
  'cancelled-requests': () => {
    const report = sampleReport('bug');
    report.network = [
      { method: 'GET', url: '/api/search?q=c', status: 0, statusText: '', ms: 41, via: 'fetch', outcome: 'aborted' },
      { method: 'GET', url: '/api/rates', status: 0, statusText: '', ms: 5003, via: 'xhr', outcome: 'timeout' },
      ...report.network,
      { method: 'GET', url: '/api/cart', status: 502, statusText: '', ms: 87, via: 'fetch' },
    ];
    return report;
  },

  // One capture on /checkout, buffers read after moving to /cart.
  elsewhere: () => {
    const report = sampleReport('bug');
    report.page.url = 'http://localhost:3000/cart';
    return report;
  },

  // A list spanning two origins prints full urls instead of paths.
  'two-origins': () => {
    const report = sampleReport('mixed');
    report.items[2].url = 'https://staging.example.com/cart';
    return report;
  },

  // A Vue component, cut markup, a request that never got a response and an
  // unhandled rejection, all in one report.
  'vue-and-failures': () => {
    const report = sampleReport('bug');
    const { element } = report.items[0];
    element.component = {
      framework: 'vue',
      version: '3.4.21',
      build: 'development',
      names: ['CouponField', 'CheckoutForm'],
      source: '/src/components/CouponField.vue',
      props: ['modelValue="SUMMER25"', 'disabled=false'],
      hops: 0,
    };
    element.truncated = true;
    report.errors.push({ kind: 'unhandled-rejection', text: 'Error: cart expired', stack: '' });
    report.network.push({
      method: 'GET',
      url: 'http://localhost:3000/api/cart',
      status: 0,
      statusText: 'Network failure: Failed to fetch',
      ms: 12,
      via: 'fetch',
    });
    return report;
  },

  // Secrets in every place a url prints: the page, a request, a logged
  // message, a failed resource, and credentials in an address on a second
  // origin. Each keeps its shape and loses only the value.
  secrets: () => {
    const report = sampleReport('mixed');
    report.page.url = 'http://localhost:3000/checkout?step=2&session_id=s3cr3t#access_token=t0k3n';
    report.items[2].url = 'https://admin:hunter2@staging.example.com/cart?code=oauthc0de&state=xyz';
    report.network.push({
      method: 'POST',
      url: '/api/login?api_key=k3y&redirect=%2Fhome',
      status: 401,
      statusText: 'Unauthorized',
      ms: 33,
      via: 'fetch',
    });
    report.consoleLines.push({ level: 'warn', text: 'retrying https://api.example.com/v1/me?token=abc.def&fields=name' });
    report.errors.push({
      kind: 'resource',
      text: 'Failed to load <img>: https://cdn.example.com/a.png?X-Amz-Signature=f00d&w=40',
    });
    // A frame names its script, and a script loaded with its key in the url
    // carries the key into every frame.
    report.errors.push({
      kind: 'exception',
      text: 'TypeError: map is undefined',
      stack:
        'TypeError: map is undefined\n' +
        '    at initMap (https://maps.googleapis.com/maps/api/js?key=AIzaFAKE&callback=initMap:210:13)',
    });
    report.consoleLines.push({ level: 'error', text: 'GET /api/session?token=rel4t1ve 401' });
    return report;
  },
};

// The log in time order, as an unattended page produces it: a poll failing
// over and over (folded into one line), a message that runs over several
// lines before its stack, warnings the collector had to drop, and entries
// that carry no time because an older collector logged them.
EXTRA.timeline = () => {
  const report = sampleReport('bug');
  const poll = (t) => ({ method: 'GET', url: '/api/stock', status: 503, statusText: 'Service Unavailable', ms: 30 + (t % 7), via: 'fetch', t });
  report.network.push(poll(2000), poll(4000), poll(6000), poll(8000));
  report.errors.push({
    kind: 'exception',
    text: 'ZodError: [\n  { "path": ["total"], "message": "Expected number" }\n]',
    stack:
      'ZodError: [\n  {\n    "path": ["total"],\n    "message": "Expected number"\n  }\n]\n' +
      '    at parse (/src/lib/schema.ts:12:9)\n    at loadCart (/src/lib/cart.ts:40:3)',
    t: 2500,
  });
  report.consoleLines.push({ level: 'warn', text: 'from before the update' });
  // One millisecond, two entries: the warning was pushed first, and the
  // collector's count keeps it first although errors are merged in first.
  report.consoleLines.push({ level: 'warn', text: 'stock fell back to cache', t: 9000, seq: 41 });
  report.errors.push({ kind: 'exception', text: 'Error: cache empty', stack: '', t: 9000, seq: 42 });
  report.dropped = { console: 0, warnings: 20, errors: 0, network: 1 };
  return report;
};

// The walkthrough as a panel that never recorded load times would send it
// (items kept from before this existed, or a page too busy to answer when
// they were captured): the checkout items are judged by their page and time
// instead. Also an entry logged after the last capture on /checkout.
EXTRA['timeline-list'] = () => {
  const report = sampleReport('mixed');
  for (const item of report.items) delete item.armedAt;
  report.consoleLines.push({
    level: 'error',
    text: 'late failure',
    t: report.items[1].capturedAt - report.armedAt + 9000,
  });
  return report;
};

// The commonest React pick: the element is written in the render of the
// component that renders it, so the owner is that component.
EXTRA['inside-own-component'] = () => {
  const report = sampleReport('bug');
  Object.assign(report.items[0].element.component, { owner: 'Total', source: '/src/components/cart/Total.tsx:12:5' });
  return report;
};

// A call site React recorded itself (_debugSource, React 16 to 18), printed
// as exact, as every call site was before sourceFrom.
EXTRA['source-recorded'] = () => {
  const report = sampleReport('bug');
  delete report.items[0].element.component.sourceFrom;
  return report;
};

// Picked with the pointer still over the element.
EXTRA.hovered = () => {
  const report = sampleReport('bug');
  report.items[0].element.hovered = true;
  return report;
};

// The walkthrough with an unticked row between items 1 and 2 on the sheet.
EXTRA['sheet-numbers'] = () => {
  const report = sampleReport('mixed');
  report.items.forEach((item, index) => (item.number = [1, 3, 4][index]));
  return report;
};

// The walkthrough with its first two rows swapped on the sheet: the bug was
// moved to the top. Listed and numbered as the sheet now stands, while the
// log still goes by capture time, so the bug's share of it is what was logged
// since the capture now numbered 2.
EXTRA.reordered = () => {
  const report = sampleReport('mixed');
  const [first, second, third] = report.items;
  report.items = [second, first, third];
  report.items.forEach((item, index) => (item.number = index + 1));
  return report;
};

// The page toggle off, one capture on /checkout, the log read on /cart.
EXTRA['page-off-elsewhere'] = () => {
  const report = sampleReport('bug');
  report.page = null;
  report.readUrl = 'http://localhost:3000/cart';
  delete report.items[0].armedAt;
  return report;
};

// A tab open from before the extension could start there: the capture came
// first, and the panel started the collector two seconds later, so the item
// recorded no load and the log holds only what came after it.
EXTRA['late-start'] = () => {
  const report = sampleReport('bug');
  report.startedLate = true;
  report.armedAt = report.items[0].capturedAt + 2000;
  // The same three entries, logged when the coupon was tried again.
  for (const list of [report.consoleLines, report.errors, report.network]) {
    for (const entry of list) entry.t -= 1500;
  }
  report.builtAt = report.armedAt + 5000;
  return report;
};

// A selector longer than the line allows, on utility class markup.
EXTRA['long-selector'] = () => {
  const report = sampleReport('bug');
  report.items[0].element.selector = LONG_SELECTOR;
  return report;
};

// Printing is for `npm run prompt`. Importing this file, as the tests do, only
// hands over the samples. Compared as real paths, because import.meta.url has
// symlinks resolved and argv does not.
function runDirectly() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (process.argv[1] && runDirectly()) {
  const asked = process.argv[2];
  const known = MODES.includes(asked) || Object.hasOwn(EXTRA, asked);
  if (asked && !known) {
    console.error(`No sample called ${asked}; printing bug. The samples: ${[...MODES, ...Object.keys(EXTRA)].join(', ')}.`);
  }
  const mode = known ? asked : 'bug';
  const sample = MODES.includes(mode) ? sampleReport(mode) : EXTRA[mode]();
  const prompt = buildPrompt(sample);
  const count = sample.items.length;

  console.log(prompt);
  console.log('\n' + '-'.repeat(60));
  console.log(
    `${mode}: ${count} item${count === 1 ? '' : 's'}, ${prompt.length} characters, ` +
      `roughly ${Math.ceil(prompt.length / 4)} tokens, ${prompt.split('\n').length} lines`
  );
}
