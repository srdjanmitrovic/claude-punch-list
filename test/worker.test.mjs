/**
 * background.js, run for real in a node:vm realm (test/support/worker-realm.mjs)
 * against a model of the pages it injects into.
 *
 * What these hold the worker to is ordering: an arm against the disarm that
 * cancels it, an arm against an older arm, a capture message against the arm
 * after it, and a probe against the change it asks about. The model is how
 * Chrome was observed to order injections, so what passes here still has to
 * pass in Chrome; what fails here fails there too.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { FakePage, flush, loadWorker } from './support/worker-realm.mjs';

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
