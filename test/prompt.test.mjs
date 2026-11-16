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

const SECRET_VALUES = ['s3cr3t', 't0k3n', 'hunter2', 'oauthc0de', 'k3y', 'abc.def', 'f00d', 'AIzaFAKE', 'rel4t1ve'];

test('prompt: no secret value from a url survives into the prompt', () => {
  const prompt = buildPrompt(EXTRA.secrets());
  for (const value of SECRET_VALUES) assert.ok(!prompt.includes(value), `${value} printed`);
  for (const kept of ['step=2', 'state=xyz', 'redirect=%2Fhome', 'fields=name', 'w=40', 'callback=initMap:210:13)']) {
    assert.ok(prompt.includes(kept), `${kept} was masked too`);
  }
});

test('prompt: urls in page text are screened whatever their script, scheme or depth', () => {
  const report = sampleReport('bug');
  const said = (text, t) => report.consoleLines.push({ level: 'warn', text, t });
  said('retry https://bücher.example/a?token=IDNSECRET', 100);
  said('connect postgres://app:PGSECRET@db.internal/x', 101);
  said('GET https://example.com/a?auth=admin:9876543', 102);
  said('reload https://a.test/?token=SEC;RETTAIL done', 103);
  said('at f (https://x.test/app.js?token=FRAMETOK:10:5)', 104);
  // A relative url wherever a log line puts one: after punctuation, inside
  // escaped JSON, after another script, or with brackets in its path.
  const relative = [
    'Failed:/api/x?token=REL01', 'retry #2:/api/x?token=REL02', 'GET|/api/x?token=REL03|500',
    '2026-11-16,GET,/api/x?token=REL04,500', 'navigate #/reset?token=REL05', '(GET)/api/x?token=REL06',
    'GET /odata/Products(1)/x?token=REL07', 'GET /api/users/[id]/x?token=REL08', '{"u":"https:\\/\\/a.test\\/r?token=REL09"}',
    '请求/api/login?token=REL10失败', 'GET /search/a=b/x?token=REL11', 'redirect→/login?token=REL12',
  ];
  relative.forEach((text, index) => said(text, 110 + index));
  report.page.url = `https://x.test/p?api_key=TOPKEY&n=${'?a='.repeat(4000)}`;
  const prompt = buildPrompt(report);
  for (const value of ['IDNSECRET', 'PGSECRET', '9876543', 'RETTAIL', 'FRAMETOK', 'TOPKEY']) {
    assert.ok(!prompt.includes(value), `${value} printed`);
  }
  for (let index = 1; index <= relative.length; index += 1) {
    const marker = `REL${String(index).padStart(2, '0')}`;
    assert.ok(!prompt.includes(marker), `${marker} printed`);
  }
  assert.ok(prompt.includes('token=<redacted>:10:5)'), 'a frame lost its position');
});

test('prompt: a frame keeps its position whatever its script is called, and running text is left alone', () => {
  const report = sampleReport('bug');
  const said = (text, t) => report.consoleLines.push({ level: 'warn', text, t });
  said('at f (https://maps.test/maps/api/js?key=K1:12:34)', 100);
  said('    at https://a.test/reset?token=K2:12:7', 101);
  said('g@https://a.test/feed?access_token=K3:1:20', 102);
  said('请访问https://example.com或联系admin@example.com', 103);
  said('Error: boom\n    at f (https://a.test/x.js:1:2)\n    global code@https://a.test/y?token=K4:3:1', 104);
  // A '(' or an 'at' in prose is no frame, so digits after a colon stay in the value.
  const prose = [
    'Login failed (https://a.test/login?auth=admin:77056277)', 'Look at https://a.test/reset?pin=12:44556677',
    '(/api/login?auth=admin:66778899)', '{"cb":"(https://a.test/?code=4:88990011)"}', 'Retrying at https://a.test/x?token=abc:55667788',
    'alice@https://a.test/?auth=admin:33445566',
  ];
  prose.forEach((text, index) => said(text, 110 + index));
  // Credentials stripped after a leading path, and in any script.
  const credentials = [
    '代理/https://user:PWA1@api.test/x?y=1', 'upstream:/x,https://user:PWA2@h.test/?a=1', 'GET,/v1,postgres://app:PWA3@db.test/app?ssl=1',
    '/set=https://user:PWA4@host.test/?x=1', 'https://u:PässwörtPWB1@host.test/', 'https://josé:PWB2@host.test/',
    'postgres://user:PWB3é@db.test/app', 'GET /x?next=//josé:PWB4@host.test/',
  ];
  credentials.forEach((text, index) => said(text, 120 + index));
  const prompt = buildPrompt(report);
  for (const kept of ['key=<redacted>:12:34)', 'token=<redacted>:12:7', 'access_token=<redacted>:1:20', '请访问https://example.com或联系admin@example.com', 'token=<redacted>:3:1']) {
    assert.ok(prompt.includes(kept), `${kept} is missing`);
  }
  for (const value of ['77056277', '44556677', '66778899', '88990011', '55667788', '33445566', 'PWA1', 'PWA2', 'PWA3', 'PWA4', 'PWB1', 'PWB2', 'PWB3', 'PWB4']) {
    assert.ok(!prompt.includes(value), `${value} printed`);
  }
});

test('prompt: text built to make the url scan backtrack costs one pass', () => {
  for (const text of [`/?a${')'.repeat(100000)}`, `http://x/?a${']'.repeat(100000)}`, '-/'.repeat(50000), '(/'.repeat(50000), 'a.'.repeat(50000)]) {
    const report = sampleReport('bug');
    report.errors.push({ kind: 'resource', text: `Failed to load <img>: ${text}`, stack: '', t: 50 });
    const started = performance.now();
    buildPrompt(report);
    assert.ok(performance.now() - started < 500, `${text.slice(0, 6)}… took ${Math.round(performance.now() - started)} ms`);
  }
});

test('prompt: with the page toggle off, a log read on another origin is not filed under the items', () => {
  const report = sampleReport('mixed');
  for (const item of report.items) delete item.armedAt;
  const read = new URL(report.items.at(-1).url);
  report.readUrl = `https://staging.example.com${read.pathname}${read.search}`;
  report.page = null;
  const prompt = buildPrompt(report);
  assert.ok(!/Logged (?:since item|on this page load)/.test(prompt), 'staging entries were filed under an item');
});

test('prompt: an element whose markup holds a masked value keeps its own text as a search target', () => {
  const report = sampleReport('bug');
  report.items[0].element = {
    ...report.items[0].element,
    html: '<a href="/reset?token=<redacted>">Forgot password?</a>',
    text: 'Forgot password?',
  };
  assert.match(buildPrompt(report), /Search for: .*"Forgot password\?"/);
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
