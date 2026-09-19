/**
 * Render the prompt template against sample data.
 *
 *     node tools/preview-prompt.mjs           # one bug
 *     node tools/preview-prompt.mjs change    # one suggested change
 *     node tools/preview-prompt.mjs mixed     # a list: two changes and a bug, across two pages
 *     node tools/preview-prompt.mjs minified  # one bug on a production build, where the
 *                                             # component name is the bundler's
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
    // already stripped by the collector.
    source: '/src/components/cart/CartSummary.tsx:42:9',
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
  // What Vite's dev server makes of a CSS Module: the hash is per build, so the
  // class in the DOM is not in the source and the stylesheet is the only part
  // of this clause worth searching for.
  classHints: ['_total_1f3k9_12 is a CSS Module: .total in CartSummary.module.css'],
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

const mode = ['change', 'mixed', 'minified'].includes(process.argv[2]) ? process.argv[2] : 'bug';

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
      // Nearest frame first, and already resolved through the source map, which
      // is why these are src paths and not bundle offsets.
      caller: [
        'applyCoupon (/src/components/cart/CartSummary.tsx:70:36)',
        'handleApply (/src/components/cart/CartSummary.tsx:84:13)',
      ],
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
