/**
 * Render the prompt template against sample data.
 *
 *     node tools/preview-prompt.mjs           # one bug
 *     node tools/preview-prompt.mjs change    # one suggested change
 *     node tools/preview-prompt.mjs mixed     # a list: two changes and a bug, across two pages
 *
 * Editing shared/prompt-template.js normally means reloading the extension and
 * capturing something to see the result. This skips all of that: it imports the
 * real template, feeds it a representative report, and prints exactly what
 * would land on the clipboard.
 *
 * The samples deliberately include every optional section at once, which is
 * the worst case for length. A real capture usually has fewer.
 */

import { buildPrompt } from '../shared/prompt-template.js';

const PAGE = {
  url: 'http://localhost:3000/checkout',
  title: 'Checkout | Example Store',
  viewport: { width: 1280, height: 720, dpr: 2 },
};

const FOLDER = '/Users/you/Downloads/claude-debug';

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

const ELEMENT = {
  selector: 'div.cart-summary > span.total',
  html: '<span class="total price price--emphasis">NaN</span>',
  text: 'NaN',
  truncated: false,
  styles: {
    display: 'inline',
    color: 'rgb(220, 38, 38)',
    'font-size': '18px',
    'font-weight': '700',
  },
};

// A walkthrough rather than a single moment: three things noticed on the way
// through a checkout, one of them a page earlier. This is what the list layout
// has to carry, and every branch of it is exercised here: a second page, an
// item with no element, and both intents in one report.
const LIST = [
  {
    intent: 'change',
    description:
      'The coupon field should validate as you type instead of only on submit, so the ' +
      'discounted total updates inline.',
    screenshotPath: `${FOLDER}/2026-08-07_20-49-02_localhost-checkout.png`,
    url: PAGE.url,
    capturedAt: at('20:49:02'),
    element: ELEMENT,
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

const mode = ['change', 'mixed'].includes(process.argv[2]) ? process.argv[2] : 'bug';

const items =
  mode === 'mixed'
    ? LIST
    : [
        {
          ...SINGLE[mode],
          screenshotPath: `${FOLDER}/2026-08-07_20-51-33_localhost-checkout.png`,
          url: PAGE.url,
          capturedAt: at('20:51:33'),
          element: ELEMENT,
        },
      ];

const sample = {
  items,
  builtAt: at('20:51:33'),
  page: PAGE,
  consoleLines: [
    { level: 'warn', text: 'Coupon SUMMER25 missing from catalog, falling back to null', t: 1840 },
  ],
  errors: [
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
  ],
  network: [
    {
      method: 'POST',
      url: 'http://localhost:3000/api/coupons/validate',
      status: 500,
      statusText: 'Internal Server Error',
      ms: 243,
      via: 'fetch',
    },
  ],
};

const prompt = buildPrompt(sample);

console.log(prompt);
console.log('\n' + '-'.repeat(60));
console.log(
  `${mode}: ${items.length} item${items.length === 1 ? '' : 's'}, ${prompt.length} characters, ` +
    `roughly ${Math.ceil(prompt.length / 4)} tokens, ${prompt.split('\n').length} lines`
);
