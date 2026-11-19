/**
 * background.js, run for real in a node:vm realm (test/support/worker-realm.mjs)
 * against a model of the pages it injects into.
 *
 * What these hold the worker to is ordering: an arm against the disarm that
 * cancels it, an arm against an older arm, a capture message against the arm
 * after it, and a probe against the change it asks about. The model is how
 * Chrome was observed to order injections, so what passes here still has to
 * pass in Chrome; what fails here fails there too.
 *
 * And what it settles when a panel closes: the downloads the panel said it
 * would take back, and none it may not touch.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { FakePage, PANEL_SENDER, flush, loadWorker, makeDownloads } from './support/worker-realm.mjs';

const TAB = 1;
const fromTab = { tab: { id: TAB } };

/**
 * Arm, and let the arm's lookups run and its file reach the page. Resolves to
 * the reply, or to 'pending' on a page that has not run the arm yet.
 */
async function armed(worker, mode, armId) {
  const reply = worker.send({ type: 'cdr:arm', mode, tabId: TAB, armId });
  await flush();
  return worker.settled(reply);
}

test('worker: an arm and a disarm on a loaded page leave nothing behind', async () => {
  const worker = loadWorker();
  assert.deepEqual(await armed(worker, 'region', 'a'), { ok: true });
  assert.equal(worker.pages[TAB].live(), 'region');
  assert.equal(worker.internals.armedByTab.get(TAB)?.mode, 'region');

  const reply = await worker.settled(worker.send({ type: 'cdr:disarm', tabId: TAB }));
  assert.deepEqual(reply, { ok: true, superseded: false });
  assert.equal(worker.pages[TAB].live(), null);
  assert.equal(worker.internals.armedByTab.has(TAB), false);
});

// F5. The disarm waits for the arm to land, and Chrome may stop the worker in
// that wait. The page still runs the arm when it reaches document_idle.
test('worker: a disarm still takes the overlay down if the worker is stopped while it waits', async () => {
  const page = new FakePage({ idle: false });
  const worker = loadWorker({ pages: { [TAB]: page } });
  worker.send({ type: 'cdr:arm', mode: 'region', tabId: TAB, armId: 'a' });
  await flush();
  worker.send({ type: 'cdr:disarm', tabId: TAB });
  await flush();

  worker.kill();
  page.reachIdle();
  await flush();
  assert.equal(page.live(), null, 'the overlay came up after the worker was stopped, and stayed');
});

// F12. A page still streaming its HTML never reaches document_idle, so the arm
// never lands. The panel gives a disarm 3 s before it photographs the page
// with a warning about the overlay.
test('worker: a disarm answers in good time on a page that never reaches document_idle', async () => {
  const page = new FakePage({ idle: false });
  const worker = loadWorker({ pages: { [TAB]: page } });
  await armed(worker, 'region', 'a');

  const reply = worker.send({ type: 'cdr:disarm', tabId: TAB });
  await worker.clock.advance(2000);
  assert.deepEqual(await worker.settled(reply), { ok: true, superseded: false });

  // And again for the next one, which the same arm, still not landed, would
  // otherwise hold up as long.
  const again = worker.send({ type: 'cdr:disarm', tabId: TAB });
  await worker.clock.advance(2000);
  assert.deepEqual(await worker.settled(again), { ok: true, superseded: false });

  // When the page does get there, the cancelled arm comes up and goes down in
  // the same run, and nothing records it.
  page.reachIdle();
  await flush();
  assert.equal(page.live(), null);
  assert.equal(worker.internals.armedByTab.has(TAB), false);
});

// The bound must not answer for a page that is merely busy while an overlay
// from an earlier arm is drawn on it: the stop has not run, and a Screen
// waiting on the answer would photograph the overlay with no warning.
test('worker: a disarm does not answer while a busy page still shows an earlier overlay', async () => {
  const page = new FakePage();
  const worker = loadWorker({ pages: { [TAB]: page } });
  await armed(worker, 'region', 'a');
  assert.equal(page.live(), 'region');

  page.pause();
  worker.send({ type: 'cdr:arm', mode: 'element', tabId: TAB, armId: 'b' });
  await flush();
  const reply = worker.send({ type: 'cdr:disarm', tabId: TAB });
  await worker.clock.advance(5000);
  assert.equal(await worker.settled(reply), 'pending');

  page.resume();
  await flush();
  assert.deepEqual(await worker.settled(reply), { ok: true, superseded: false });
  assert.equal(page.live(), null);
});

// Every arm a disarm cancels has landed, or has a stop queued behind it, so
// the stop the answer waits for runs at once. A navigation that dropped the
// arm leaves a new document still loading, which must not hold the answer up
// until document_idle.
test('worker: a disarm after a navigation dropped the arm answers before the new page is idle', async () => {
  const page = new FakePage({ idle: false });
  const worker = loadWorker({ pages: { [TAB]: page } });
  await armed(worker, 'region', 'a');
  const reply = worker.send({ type: 'cdr:disarm', tabId: TAB });
  await flush();
  page.navigate('https://example.test/next');
  await worker.clock.advance(200);
  assert.deepEqual(await worker.settled(reply), { ok: true, superseded: false });
  page.reachIdle();
  await flush();
  assert.equal(page.live(), null);
});

// The stop sent at once can overtake a file still being read from the
// package. The stop after the wait is what takes that one down.
test('worker: a disarm takes down an arm whose file its first stop overtook', async () => {
  const worker = loadWorker({ holdFiles: true });
  worker.send({ type: 'cdr:arm', mode: 'region', tabId: TAB, armId: 'a' });
  await flush();
  const reply = worker.send({ type: 'cdr:disarm', tabId: TAB });
  await flush();
  worker.releaseFiles();
  await flush();
  assert.deepEqual(await worker.settled(reply), { ok: true, superseded: false });
  assert.equal(worker.pages[TAB].live(), null);
});

// A file Chrome is slower to read than the disarm's bounded wait lands after
// every stop the disarm sent. The arm finds itself cancelled and stops itself.
test('worker: an arm whose file lands after the disarm gave up waiting takes itself down', async () => {
  const worker = loadWorker({ holdFiles: true });
  worker.send({ type: 'cdr:arm', mode: 'region', tabId: TAB, armId: 'a' });
  await flush();
  const reply = worker.send({ type: 'cdr:disarm', tabId: TAB });
  await worker.clock.advance(1500);
  assert.deepEqual(await worker.settled(reply), { ok: true, superseded: false });
  worker.releaseFiles();
  await flush();
  assert.equal(worker.pages[TAB].live(), null, 'the overlay landed after every stop, and stayed');
});

// The same overtaking on a page that has not reached document_idle, where
// the wait gives up before the arm lands. The stop queued when it gives up is
// behind the file by then.
test('worker: a disarm that stops waiting still takes down an arm its first stop overtook', async () => {
  const page = new FakePage({ idle: false });
  const worker = loadWorker({ pages: { [TAB]: page }, holdFiles: true });
  worker.send({ type: 'cdr:arm', mode: 'region', tabId: TAB, armId: 'a' });
  await flush();
  const reply = worker.send({ type: 'cdr:disarm', tabId: TAB });
  await flush();
  worker.releaseFiles();
  await worker.clock.advance(2000);
  assert.deepEqual(await worker.settled(reply), { ok: true, superseded: false });
  page.reachIdle();
  await flush();
  assert.equal(page.live(), null);
});

test('worker: an arm asked for after a disarm stands, and the reply says so', async () => {
  const page = new FakePage({ idle: false });
  const worker = loadWorker({ pages: { [TAB]: page } });
  await armed(worker, 'region', 'a');
  const reply = worker.send({ type: 'cdr:disarm', tabId: TAB });
  await flush();
  const newer = worker.send({ type: 'cdr:arm', mode: 'element', tabId: TAB, armId: 'b' });
  await flush();
  page.reachIdle();
  await flush();
  assert.deepEqual(await worker.settled(reply), { ok: true, superseded: true });
  assert.deepEqual(await worker.settled(newer), { ok: true });
  assert.equal(page.live(), 'element');
  assert.deepEqual({ ...worker.internals.armedByTab.get(TAB) }, { mode: 'element', armId: 'b' });
});

// F7. Arms on one tab were ordered by when each one's lookups answered, so an
// older arm answered late put its mode on the page after the newer one.
test('worker: an older arm whose tab lookup answers late does not take the page from a newer one', async () => {
  const page = new FakePage();
  let releaseOlder;
  let calls = 0;
  const worker = loadWorker({
    pages: { [TAB]: page },
    tabsGet: (tabId) => {
      const tab = { id: tabId, url: page.url };
      calls += 1;
      if (calls === 1) return new Promise((resolve) => (releaseOlder = () => resolve(tab)));
      return Promise.resolve(tab);
    },
  });
  const older = worker.send({ type: 'cdr:arm', mode: 'element', tabId: TAB });
  const newer = worker.send({ type: 'cdr:arm', mode: 'region', tabId: TAB, armId: 'b' });
  await flush();
  assert.equal(page.live(), 'region');

  releaseOlder();
  await flush();
  assert.deepEqual(await worker.settled(older), { ok: true });
  assert.deepEqual(await worker.settled(newer), { ok: true });
  assert.equal(page.live(), 'region', 'the older arm put its mode on the page last');
  assert.deepEqual({ ...worker.internals.armedByTab.get(TAB) }, { mode: 'region', armId: 'b' });
  assert.deepEqual(
    worker.broadcasts.filter((m) => m.type === 'cdr:armed').map((m) => m.mode),
    ['region']
  );
});

// An older arm already injecting when the newer one is asked for lands first,
// and the newer one takes the page over. Only the newer one is news: the
// shortcut's broadcast carries no armId, so a panel would light its mode over
// the newer one until the newer broadcast came.
test('worker: an arm replaced while it lands is not announced', async () => {
  const worker = loadWorker({ holdFiles: true });
  const older = worker.send({ type: 'cdr:arm', mode: 'region', tabId: TAB });
  await flush();
  const newer = worker.send({ type: 'cdr:arm', mode: 'element', tabId: TAB, armId: 'b' });
  await flush();
  worker.releaseFiles();
  await flush();
  assert.deepEqual(await worker.settled(older), { ok: true });
  assert.deepEqual(await worker.settled(newer), { ok: true });
  assert.equal(worker.pages[TAB].live(), 'element');
  assert.deepEqual(
    worker.broadcasts.filter((m) => m.type === 'cdr:armed').map((m) => [m.mode, m.armId ?? null]),
    [['element', 'b']]
  );
  assert.deepEqual({ ...worker.internals.armedByTab.get(TAB) }, { mode: 'element', armId: 'b' });
});

// F13. A drag's message comes two frames after the release, and an Element
// click can land in between. Only the arm of the mode that sent it has ended.
test('worker: a capture message ends only the arm of the mode that sent it', async () => {
  const worker = loadWorker();
  await armed(worker, 'element', 'e');
  assert.equal(worker.internals.armedByTab.get(TAB)?.mode, 'element');

  await worker.send({ type: 'cdr:region-selected', rect: {}, viewport: {} }, fromTab);
  assert.equal(worker.internals.armedByTab.get(TAB)?.mode, 'element', 'a late drag ended the picker');
  await worker.send({ type: 'cdr:capture-cancelled', mode: 'region' }, fromTab);
  assert.equal(worker.internals.armedByTab.get(TAB)?.mode, 'element');

  await worker.send({ type: 'cdr:element-picked', rect: {}, viewport: {}, element: {} }, fromTab);
  assert.equal(worker.internals.armedByTab.has(TAB), false);

  await armed(worker, 'region', 'r');
  await worker.send({ type: 'cdr:capture-cancelled', mode: 'region' }, fromTab);
  assert.equal(worker.internals.armedByTab.has(TAB), false);
});

// F15. Each URL change on an armed tab brought up to four probes.
test('worker: probes asked for together share one injection behind the one running', async () => {
  const worker = loadWorker();
  await armed(worker, 'region', 'a');
  const before = worker.injections.filter((i) => i.kind === 'probe').length;

  worker.updated(TAB, { status: 'loading' });
  const answers = [
    worker.send({ type: 'cdr:verify', tabId: TAB }),
    worker.send({ type: 'cdr:verify', tabId: TAB }),
  ];
  worker.updated(TAB, { status: 'complete' });
  answers.push(worker.send({ type: 'cdr:verify', tabId: TAB }));
  await flush();

  for (const answer of answers) assert.deepEqual(await worker.settled(answer), { ok: true, mode: 'region' });
  const probes = worker.injections.filter((i) => i.kind === 'probe').length - before;
  assert.ok(probes <= 2, `${probes} probes for one change of URL`);
});

// Sharing must not hand a request the answer of a probe that read the page
// before the change the request is about.
test('worker: a probe asked for while one runs answers from the page as it is after', async () => {
  const page = new FakePage();
  const worker = loadWorker({ pages: { [TAB]: page } });
  await armed(worker, 'region', 'a');

  page.pause();
  const first = worker.send({ type: 'cdr:verify', tabId: TAB });
  await flush();
  page.resume(); // the first probe reads 'region' here
  page.window.__cdrRegionOverlay.stop(); // and then a real navigation takes it
  const second = worker.send({ type: 'cdr:verify', tabId: TAB });
  await flush();
  assert.deepEqual(await worker.settled(first), { ok: true, mode: 'region' });
  assert.deepEqual(await worker.settled(second), { ok: true, mode: null });
  assert.equal(worker.internals.armedByTab.has(TAB), false);
});

test('worker: a probe waits for an arm still landing', async () => {
  const page = new FakePage({ idle: false });
  const worker = loadWorker({ pages: { [TAB]: page } });
  worker.send({ type: 'cdr:arm', mode: 'region', tabId: TAB, armId: 'a' });
  const answer = worker.send({ type: 'cdr:verify', tabId: TAB });
  await flush();
  assert.equal(await worker.settled(answer), 'pending');
  page.reachIdle();
  await flush();
  assert.deepEqual(await worker.settled(answer), { ok: true, mode: 'region' });
});

// F29. The stop a disarm queued was a function, which reached the page ahead
// of an arm whose file Chrome was still reading. With the worker stopped in
// the wait that follows, nothing sent another stop, and the overlay that
// landed after it stayed up.
test('worker: a disarm takes down an arm still being read, though the worker is stopped straight after', async () => {
  const worker = loadWorker({ holdFiles: true });
  worker.send({ type: 'cdr:arm', mode: 'region', tabId: TAB, armId: 'a' });
  await flush();
  worker.send({ type: 'cdr:disarm', tabId: TAB });
  await flush();
  worker.kill();
  worker.releaseFiles();
  await flush();
  assert.equal(worker.pages[TAB].live(), null, 'the overlay landed after the only stop, and stayed');
});

// F29. A worker stopped while an arm waited for document_idle: the panel's
// request failed, it went dark and sent a disarm, which a new worker that
// never heard of the arm answered with a stop the page ran at once, before
// the arm. The overlay then landed with the button dark.
test('worker: a disarm from a worker started afresh still comes after an arm the stopped one sent', async () => {
  const page = new FakePage({ idle: false });
  const first = loadWorker({ pages: { [TAB]: page } });
  first.send({ type: 'cdr:arm', mode: 'region', tabId: TAB, armId: 'a' });
  await flush();
  first.kill();

  const second = loadWorker({ pages: { [TAB]: page } });
  const reply = second.send({ type: 'cdr:disarm', tabId: TAB });
  await second.clock.advance(200);
  assert.deepEqual(await second.settled(reply), { ok: true, superseded: false });
  page.reachIdle();
  await flush();
  assert.equal(page.live(), null, 'the arm landed after every stop the new worker sent');
});

// The stop now always queued must not cancel an arm asked for after the
// disarm: it is a file asked for before that arm's file, so it runs first.
test('worker: the stop a disarm queues does not take down an arm asked for after it', async () => {
  const page = new FakePage({ idle: false });
  const worker = loadWorker({ pages: { [TAB]: page }, holdFiles: true });
  worker.send({ type: 'cdr:disarm', tabId: TAB });
  await flush();
  worker.send({ type: 'cdr:arm', mode: 'element', tabId: TAB, armId: 'b' });
  await flush();
  worker.releaseFiles();
  page.reachIdle();
  await worker.clock.advance(1500);
  assert.equal(page.live(), 'element');
});

// F28. The shortcut arms Region again in the two frames between a drag's
// release and its message. The message named only its mode, so it ended the
// newer arm, and a panel opening later showed the page unarmed.
test('worker: a late message from an earlier run does not end a newer arm of the same mode', async () => {
  const page = new FakePage({ runs: true });
  const worker = loadWorker({ pages: { [TAB]: page } });
  await armed(worker, 'region');
  assert.equal(worker.internals.armedByTab.get(TAB)?.run, 'run-1');
  assert.equal(worker.broadcasts.at(-1).run, 'run-1');

  page.window.__cdrRegionOverlay.stop(); // the drag's release
  await armed(worker, 'region'); // the shortcut, before the drag's message
  assert.equal(worker.internals.armedByTab.get(TAB)?.run, 'run-2');

  await worker.send({ type: 'cdr:region-selected', rect: {}, viewport: {}, run: 'run-1' }, fromTab);
  assert.equal(worker.internals.armedByTab.get(TAB)?.mode, 'region', 'the late drag ended the newer arm');
  const check = await worker.settled(worker.send({ type: 'cdr:check-tab', tabId: TAB }));
  assert.equal(check.run, 'run-2');

  await worker.send({ type: 'cdr:capture-cancelled', mode: 'region', run: 'run-2' }, fromTab);
  assert.equal(worker.internals.armedByTab.has(TAB), false);
});

/** setup for loadWorker: the shipped content_scripts entries with `fields` put over each. */
const narrowedTo = (fields) => (chrome) => {
  const real = chrome.runtime.getManifest();
  chrome.runtime.getManifest = () => ({
    ...real,
    content_scripts: real.content_scripts.map((entry) => ({ ...entry, ...fields })),
  });
};

// Low in the last regression check (Z1, Z4): an include glob with no '/'
// before its path text, such as '*app*' or '*app/*', was taken to keep every
// site out, so a single page app that had moved off it lost its running
// collector's log after a reload of the extension. Chrome runs a script with
// include_globs ['*app*'] on https://any.site/app, so the site is declared.
test('worker: an include glob declares a site when some URL of the site matches it', async () => {
  const URL_ = 'http://127.0.0.1:8861/settings';
  const cases = [
    [{ include_globs: ['*app*'] }, URL_, true],
    [{ include_globs: ['*app/*'] }, URL_, true],
    [{ include_globs: ['*admin*'] }, URL_, true],
    [{ include_globs: ['*nothing*'] }, URL_, true],
    [{ include_globs: ['*/app/*'] }, URL_, true],
    [{ include_globs: ['http://*/app/*'] }, URL_, true],
    [{ include_globs: ['http://*/app/*'] }, 'https://shop.test/settings', false],
    // A glob about hosts still keeps other hosts out.
    [{ include_globs: ['*://*.example.com/*'] }, 'https://shop.example.com/settings', true],
    [{ include_globs: ['*://*.example.com/*'] }, 'https://bank.test/settings', false],
    [{ include_globs: ['http://127.0.0.1:*'] }, 'http://localhost:8861/settings', false],
    // An exclude keeps the site out only when it matches every URL of it.
    [{ exclude_globs: ['*admin*'] }, URL_, true],
    [{ exclude_globs: ['*app*'] }, URL_, true],
    [{ exclude_globs: ['*://localhost:*/*'] }, 'http://localhost:8861/settings', false],
    [{ exclude_globs: ['*://localhost:*/*'] }, URL_, true],
    [{ exclude_matches: ['http://localhost/*'] }, 'http://localhost:8861/settings', false],
  ];
  const wrong = cases.filter(([fields, url, expected]) => {
    const { collectorSiteDeclaredFor } = loadWorker({ setup: narrowedTo(fields) }).internals;
    return collectorSiteDeclaredFor(url) !== expected;
  });
  assert.deepEqual(wrong, []);

  // The single page app that loaded at /app/spa under the glob and moved to
  // /settings: its collector, still running, is bridged.
  for (const glob of ['*app*', '*app/*']) {
    const page = new FakePage({ url: URL_ });
    page.window.__cdrCollector = true; // answers the probe as the running collector does
    const worker = loadWorker({ pages: { [TAB]: page }, setup: narrowedTo({ include_globs: [glob] }) });
    assert.deepEqual(await worker.settled(worker.send({ type: 'cdr:collect', tabId: TAB })), { ok: true, fresh: false }, glob);
    assert.deepEqual(worker.injections.filter((i) => i.file).map((i) => i.file), ['content/collector-bridge.js']);
  }
});

// Low in the check of that fix (L2): the URL built from a glob's text was
// tried as it was written, so a glob whose text no URL holds as Chrome writes
// it ('café' is 'caf%C3%A9' in a path, a query or a fragment, a space is
// '%20') declared every site, and so did an include glob the same entry's
// exclude glob cancels. In both cases Chrome runs the collector on no URL of
// the site, so the page must get no probe and no bridge.
test('worker: a site is declared only when Chrome would run the collector on some URL of it', async () => {
  const URL_ = 'http://127.0.0.1:8861/forger';
  const cases = [
    [{ include_globs: ['*café*'] }, false],
    [{ include_globs: ['*a b*'] }, false],
    [{ include_globs: ['*"x*'] }, false],
    [{ include_globs: ['*caf%C3%A9*'] }, true],
    [{ include_globs: ['*app*'], exclude_globs: ['*app*'] }, false],
    [{ include_globs: ['*admin*'], exclude_globs: ['*admin*'] }, false],
    [{ include_globs: ['*app/*'], exclude_globs: ['*app/*'] }, false],
    [{ include_globs: ['*app*'], exclude_globs: ['*app/admin*'] }, true],
    // Chrome runs this on /xapp, which the exclude leaves in.
    [{ include_globs: ['*app*'], exclude_matches: ['http://127.0.0.1/app*'] }, true, '/app'],
    // Medium in the last verification (C2): on a URL the excludes take out,
    // an exclude that also takes out the other URLs tried (the root, a
    // pattern's own path) lost a running collector. Each path is where the
    // tab was in Chrome.
    [{ exclude_matches: ['http://127.0.0.1/'] }, true, '/'],
    [{ exclude_globs: ['*/'] }, true, '/app/'],
    [{ exclude_globs: ['*:8861/', '*settings*'] }, true, '/settings'],
    [{ matches: ['*://*/app/*'], exclude_matches: ['*://*/app/'] }, true, '/settings'],
    [{ include_globs: ['*/app/*'], exclude_globs: ['*/app/'] }, true, '/settings'],
    [{ matches: ['http://*/*.html'], exclude_globs: ['*/.html'] }, true, '/settings'],
    [{ matches: ['http://127.0.0.1/app*'], exclude_globs: ['*/app'] }, true, '/settings'],
    // A pattern's path and a glob that meet only on a longer URL (/app/admin).
    [{ matches: ['*://*/app/*'], include_globs: ['*/admin*'] }, true, '/app/users'],
    // A glob that meets a pattern's path only before it (/x.html).
    [{ matches: ['http://*/*.html'], include_globs: ['*?x*'] }, true, '/app/x'],
    // A glob that names a scheme is not tried as a path (a stated limit),
    // though Chrome runs this one on /app.
    [{ include_globs: ['*://*app*'], exclude_globs: ['*/'] }, false, '/app/'],
    // A pattern's path as Chrome writes it.
    [{ matches: ['http://127.0.0.1/ü/*'] }, true, '/%C3%BC/x'],
    // And still out where nothing of the site gets it.
    [{ exclude_matches: ['http://127.0.0.1/*'] }, false, '/'],
    [{ exclude_globs: ['*127.0.0.1*'] }, false, '/settings'],
    // A match pattern's ? is part of a query, not a wildcard.
    [{ matches: ['http://127.0.0.1/page?mode=x'] }, true],
    [{ matches: ['http://127.0.0.1/page?mode=x'], exclude_matches: ['http://127.0.0.1/page?mode=x'] }, false],
  ];
  const wrong = cases.filter(([fields, expected, at]) => {
    const { collectorSiteDeclaredFor } = loadWorker({ setup: narrowedTo(fields) }).internals;
    return collectorSiteDeclaredFor(at ? new URL(at, URL_).href : URL_) !== expected;
  });
  assert.deepEqual(wrong, []);

  // The forging page of the check: it answers the probe, and gets nothing.
  const page = new FakePage({ url: URL_ });
  page.window.__cdrCollector = true;
  const worker = loadWorker({ pages: { [TAB]: page }, setup: narrowedTo({ include_globs: ['*café*'] }) });
  assert.deepEqual(await worker.settled(worker.send({ type: 'cdr:collect', tabId: TAB })), { ok: false, outside: 'site' });
  assert.deepEqual(worker.injections, []);
});

// ------------------------------------------------- what a closed panel left

const DIR = '/Users/you/Downloads/claude-punch-list/';
const OURS = PANEL_SENDER.id;

/** A download record, this extension's unless `extra` says otherwise. */
const download = (id, extra = {}) => ({ id, state: 'complete', filename: `${DIR}${id}.png`, byExtensionId: OURS, ...extra });

/** A stored sheet whose items name these files. */
const sheetNaming = (...paths) =>
  new Map([['cdrReport', { items: paths.map((path, index) => ({ id: `item-${index}`, path })), removed: [], updatedAt: 1, writer: 'x' }]]);

/** Open the panel's port, post each message on it, close it as the panel goes, and let the worker finish. */
async function panelCloses(worker, ...messages) {
  const port = worker.connect('cdr:panel');
  for (const message of messages) port.post(message);
  port.close();
  await flush();
  return port;
}

/** The ids the worker touched, by call. */
const touched = (downloads) => ({
  cancel: downloads.made('cancel'),
  removeFile: downloads.made('removeFile'),
  erase: downloads.made('erase'),
});

const NOTHING = { cancel: [], removeFile: [], erase: [] };

// Found while checking 0.7.0 in Chrome for Testing 156: the panel's own
// cancel, removeFile and erase on pagehide never reached the browser when the
// side panel was closed with chrome.sidePanel.close or with its window. A
// discard closed within its undo left the file on disk and in the download
// list for good, and a copy waiting on a "Save as" dialog was not cancelled.
test('worker: closing the panel settles the downloads it said were pending', async () => {
  const downloads = makeDownloads([
    download(1), // a discarded file
    download(2, { state: 'in_progress', filename: '' }), // a marked copy waiting on a "Save as" dialog
    download(3, { state: 'in_progress', filename: `${DIR}3.png.crdownload` }), // a first save being written
    download(4), // a file the panel did not name
  ]);
  const worker = loadWorker({ downloads });
  await panelCloses(worker, { type: 'cdr:pending', ids: [1, 2, 3] });
  assert.deepEqual(touched(downloads), { cancel: [2, 3], removeFile: [1], erase: [1, 2, 3] });
  assert.deepEqual([...downloads.records.keys()], [4]);
});

test('worker: a download that finishes before the cancel reaches it is taken off the disk', async () => {
  const downloads = makeDownloads([download(5, { state: 'in_progress', filename: '' })]);
  // The user pressed Save in the dialog as the panel closed.
  downloads.api.cancel = async (id) => {
    downloads.calls.push(['cancel', id]);
    Object.assign(downloads.records.get(id), { state: 'complete', filename: `${DIR}5_marked.png` });
  };
  const worker = loadWorker({ downloads });
  await panelCloses(worker, { type: 'cdr:pending', ids: [5] });
  assert.deepEqual(touched(downloads), { cancel: [5], removeFile: [5], erase: [5] });
});

test('worker: a closing panel settles only downloads of this extension that no stored item names', async () => {
  const downloads = makeDownloads([
    download(1, { byExtensionId: 'another-extension' }),
    download(2, { byExtensionId: undefined }), // the user's own download, which Chrome reissued the id to
    download(3), // the item was taken back in another window, which stored it
    download(4),
  ]);
  const worker = loadWorker({ downloads, storage: sheetNaming(`${DIR}3.png`) });
  await panelCloses(worker, { type: 'cdr:pending', ids: [1, 2, 3, 4, 9] });
  assert.deepEqual(touched(downloads), { cancel: [], removeFile: [4], erase: [4] });

  // A stored sheet that cannot be read leaves every file as it is.
  const unreadable = makeDownloads([download(4)]);
  const blind = loadWorker({
    downloads: unreadable,
    setup: (chrome) => {
      chrome.storage.local.get = () => Promise.reject(new Error('IO error'));
    },
  });
  await panelCloses(blind, { type: 'cdr:pending', ids: [4] });
  assert.deepEqual(touched(unreadable), NOTHING);

  // A content script's port is shut, and nothing it says is settled.
  const fromPage = makeDownloads([download(4)]);
  const attacked = loadWorker({ downloads: fromPage });
  const port = attacked.connect('cdr:panel', { id: OURS, url: 'https://evil.test/', tab: { id: 1 } });
  port.post({ type: 'cdr:pending', ids: [4] });
  port.close();
  await flush();
  assert.equal(port.closed, true);
  assert.deepEqual(touched(fromPage), NOTHING);
});

test('worker: a list it cannot read settles nothing, not even the list before it', async () => {
  const malformed = [
    { type: 'cdr:pending' },
    { type: 'cdr:pending', ids: 4 },
    { type: 'cdr:pending', ids: '4' },
    { type: 'cdr:pending', ids: ['4'] },
    { type: 'cdr:pending', ids: [4, -1] },
    { type: 'cdr:pending', ids: [4, 1.5] },
    { type: 'cdr:pending', ids: [4, 2 ** 53] },
    { type: 'cdr:pending', ids: [4, null] },
    { type: 'cdr:pending', ids: { length: 1, 0: 4 } },
    { type: 'cdr:pending', ids: Array.from({ length: 5001 }, (_, i) => i) },
  ];
  for (const message of malformed) {
    const downloads = makeDownloads([download(4)]);
    await panelCloses(loadWorker({ downloads }), { type: 'cdr:pending', ids: [4] }, message);
    assert.deepEqual(touched(downloads), NOTHING, JSON.stringify(message).slice(0, 80));
  }
  // The longest list a panel sends is taken.
  const downloads = makeDownloads([download(4)]);
  await panelCloses(loadWorker({ downloads }), { type: 'cdr:pending', ids: Array.from({ length: 5000 }, (_, i) => i) });
  assert.deepEqual(touched(downloads), { cancel: [], removeFile: [4], erase: [4] });
});

test('worker: each list replaces the one before, and an empty one leaves nothing to settle', async () => {
  // A save that finished, or a discard undone, before the panel closed.
  const emptied = makeDownloads([download(1), download(2)]);
  await panelCloses(loadWorker({ downloads: emptied }), { type: 'cdr:pending', ids: [1, 2] }, { type: 'cdr:pending', ids: [] });
  assert.deepEqual(touched(emptied), NOTHING);

  const replaced = makeDownloads([download(1), download(2)]);
  await panelCloses(
    loadWorker({ downloads: replaced }),
    { type: 'cdr:pending', ids: [1] },
    { type: 'cdr:pending', ids: [] },
    { type: 'cdr:pending', ids: [2] }
  );
  assert.deepEqual(touched(replaced), { cancel: [], removeFile: [2], erase: [2] });

  // Nothing is settled while the panel stays open.
  const open = makeDownloads([download(1)]);
  const worker = loadWorker({ downloads: open });
  worker.connect('cdr:panel').post({ type: 'cdr:pending', ids: [1] });
  await flush();
  assert.deepEqual(touched(open), NOTHING);
});

test('worker: a panel that holds a tab and downloads disarms the one and settles the others when it closes', async () => {
  const downloads = makeDownloads([download(1)]);
  const worker = loadWorker({ downloads });
  assert.deepEqual(await worker.settled(worker.send({ type: 'cdr:arm', mode: 'region', tabId: TAB, armId: 'a' })), { ok: true });
  await panelCloses(worker, { type: 'cdr:holding', tabId: TAB }, { type: 'cdr:pending', ids: [1] });
  await worker.clock.advance(200);
  assert.equal(worker.pages[TAB].live(), null);
  assert.deepEqual(touched(downloads), { cancel: [], removeFile: [1], erase: [1] });
});

// The worker is stopped while idle with the port open, which closes the port
// from its end; the panel opens a new one, which starts a new worker, and says
// the list again on it (the panel's side is in sheet.test.mjs).
test('worker: a port reopened after the worker stopped settles the list said again on it, once', async () => {
  const downloads = makeDownloads([download(1), download(2, { state: 'in_progress', filename: '' })]);
  const storage = new Map();
  const stopped = loadWorker({ downloads, storage });
  const first = stopped.connect('cdr:panel');
  first.post({ type: 'cdr:pending', ids: [1, 2] });
  stopped.kill();
  first.close(); // nothing reaches a stopped worker
  await flush();
  assert.deepEqual(touched(downloads), NOTHING);

  const started = loadWorker({ downloads, storage });
  await panelCloses(started, { type: 'cdr:holding', tabId: null }, { type: 'cdr:pending', ids: [1, 2] });
  assert.deepEqual(touched(downloads), { cancel: [2], removeFile: [1], erase: [1, 2] });
});
