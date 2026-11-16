/**
 * The prompt, compared byte for byte with test/golden.
 *
 * CONTRIBUTING.md asks that a one item report renders exactly as it did
 * before. These files are that "before". A change that alters one of them on
 * purpose regenerates them in the same commit:
 *
 *     UPDATE_GOLDEN=1 npm test
 *
 * and the diff of test/golden in that commit is the change a reviewer reads.
 */

import './support/fixed-clock.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { buildPrompt } from '../shared/prompt-template.js';
import { MODES, sampleReport } from '../tools/preview-prompt.mjs';

const GOLDEN = new URL('./golden/', import.meta.url);
const UPDATE = process.env.UPDATE_GOLDEN === '1';

// Branches the four previews never reach. Each starts from a preview sample
// and changes only what the branch needs, so a diff in one of these files
// points at one cause.
const EXTRA = {
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

  // A list where item 1 predates a reload of /checkout and item 3 was taken on
  // /cart: one caution has to name both reasons.
  'list-reloaded': () => {
    const report = sampleReport('mixed');
    report.armedAt = report.items[1].capturedAt - 10 * 1000;
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
    return report;
  },
};

const SECRET_VALUES = ['s3cr3t', 't0k3n', 'hunter2', 'oauthc0de', 'k3y', 'abc.def', 'f00d'];

test('prompt: no secret value from a url survives into the prompt', () => {
  const prompt = buildPrompt(EXTRA.secrets());
  for (const value of SECRET_VALUES) assert.ok(!prompt.includes(value), `${value} printed`);
  for (const kept of ['step=2', 'state=xyz', 'redirect=%2Fhome', 'fields=name', 'w=40']) {
    assert.ok(prompt.includes(kept), `${kept} was masked too`);
  }
});

const CASES = [...MODES.map((mode) => [mode, () => sampleReport(mode)]), ...Object.entries(EXTRA)];

for (const [name, make] of CASES) {
  test(`prompt: ${name} matches test/golden/${name}.txt`, () => {
    const actual = `${buildPrompt(make())}\n`;
    const file = new URL(`${name}.txt`, GOLDEN);
    if (UPDATE) {
      mkdirSync(GOLDEN, { recursive: true });
      writeFileSync(file, actual);
      return;
    }
    assert.equal(actual, readFileSync(file, 'utf8'));
  });
}

test('prompt: a report with no items still renders', () => {
  const prompt = buildPrompt({ items: [], builtAt: 0 });
  assert.match(prompt, /\(no description given\)/);
});
