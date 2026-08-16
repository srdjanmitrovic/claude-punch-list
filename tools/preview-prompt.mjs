/**
 * Render the prompt template against sample data.
 *
 *     node tools/preview-prompt.mjs           # bug report
 *     node tools/preview-prompt.mjs change    # suggested change
 *
 * Editing shared/prompt-template.js normally means reloading the extension and
 * capturing something to see the result. This skips all of that: it imports the
 * real template, feeds it a representative report, and prints exactly what
 * would land on the clipboard.
 *
 * The sample below deliberately includes every optional section at once, which
 * is the worst case for length. A real capture usually has fewer.
 */

import { buildPrompt } from '../shared/prompt-template.js';

// Same page, same evidence, two reasons for reporting it. Reading the pair back
// to back is the point: everything between the first line and the last should
// be byte for byte identical.
const DESCRIPTIONS = {
  bug: 'The order total shows NaN after applying a coupon. Expected the discounted price.',
  change:
    'The coupon field should validate as you type instead of only on submit, so the discounted ' +
    'total updates inline.',
};

const intent = process.argv[2] === 'change' ? 'change' : 'bug';

const sample = {
  intent,
  description: DESCRIPTIONS[intent],
  screenshotPath: '/Users/you/Downloads/claude-debug/2026-08-07_20-51-33_localhost-checkout.png',
  capturedAt: new Date('2026-08-07T20:51:33').toLocaleString(),
  page: {
    url: 'http://localhost:3000/checkout',
    title: 'Checkout | Example Store',
    viewport: { width: 1280, height: 720, dpr: 2 },
  },
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
  element: {
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
  },
};

const prompt = buildPrompt(sample);

console.log(prompt);
console.log('\n' + '-'.repeat(60));
console.log(
  `intent: ${intent} — ${prompt.length} characters, roughly ` +
    `${Math.ceil(prompt.length / 4)} tokens, ${prompt.split('\n').length} lines`
);
