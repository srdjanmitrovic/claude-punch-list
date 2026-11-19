/**
 * sidepanel/panel.js, run for real in a node:vm realm against a stub of the
 * DOM (test/support/panel-realm.mjs), with the worker played by each test.
 *
 * These hold the panel to what it shows about an arm: which button is lit
 * when replies and broadcasts arrive in an unlucky order, and what a Screen
 * capture says about an overlay that may be in it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultWorker, loadPanel } from './support/panel-realm.mjs';
import { panelAndPage } from './support/page-realm.mjs';

const TAB = 7;
const fromTab = { tab: { id: TAB } };
const ARMED_DURING_SCREEN =
  'A capture mode was armed while this screenshot waited, so its overlay may show in it.';
const OVERLAY_TOO_BUSY =
  'The page was too busy to take the capture overlay down in time, so it may show in this screenshot.';

/** A worker that answers as usual, except where `answers` says otherwise. */
function worker(answers = {}) {
  return (message) => (message.type in answers ? answers[message.type](message) : defaultWorker(message));
}

/** A promise and the function that settles it. */
function held() {
  let release;
  const promise = new Promise((resolve) => (release = resolve));
  return { promise, release };
}

async function started(options) {
  const panel = loadPanel(options);
  await panel.internals.ready;
  await panel.flush();
  return panel;
}

// F6. A worker that does not answer the startup check left `ready` rejected,
// and the panel dropped every broadcast after it.
test('panel: a failed startup check still leaves the panel listening', async () => {
  let checks = 0;
  const panel = loadPanel({
    worker: worker({
      'cdr:check-tab': () => {
        checks += 1;
        if (checks === 1) throw new Error('Could not establish connection. Receiving end does not exist.');
        return defaultWorker({ type: 'cdr:check-tab' });
      },
    }),
  });
  await assert.doesNotReject(panel.internals.ready);
  await panel.flush();
  // The rest of the startup ran: the tab is shown as usable.
  assert.equal(panel.element('status-dot').className, 'dot ready');
  assert.equal(panel.element('mode-region').disabled, false);

  panel.broadcast({ type: 'cdr:armed', mode: 'region', tabId: TAB });
  await panel.flush();
  assert.deepEqual(panel.lit(), ['region'], 'the broadcast after a failed startup was dropped');
});

test('panel: a failed restore still leaves the panel listening', async () => {
  const panel = loadPanel({
    setup: (chrome) => {
      chrome.storage.local.get = async () => {
        throw new Error('storage is unavailable');
      };
    },
  });
  await assert.doesNotReject(panel.internals.ready);
  await panel.flush();
  assert.equal(panel.element('status-dot').className, 'dot ready');
  panel.broadcast({ type: 'cdr:armed', mode: 'element', tabId: TAB });
  await panel.flush();
  assert.deepEqual(panel.lit(), ['element']);
});

// F11. The shortcut's arm has no armId, so an answer the worker read before
// Esc cancelled it could not be refused by id, and lit the button again.
test('panel: a check answered before Esc cancelled the shortcut does not relight it', async () => {
  let check = null;
  const panel = await started({
    worker: worker({ 'cdr:check-tab': (message) => (check ? check.promise : defaultWorker(message)) }),
  });
  panel.broadcast({ type: 'cdr:armed', mode: 'region', tabId: TAB });
  await panel.flush();
  assert.deepEqual(panel.lit(), ['region']);

  check = held();
  const resolving = panel.internals.resolveTab();
  await panel.flush();
  panel.key('Escape');
  assert.deepEqual(panel.lit(), []);
  assert.ok(panel.sent.some((m) => m.type === 'cdr:disarm' && m.tabId === TAB));

  check.release({ ok: true, restriction: null, armedMode: 'region', armId: null });
  await resolving;
  await panel.flush();
  assert.deepEqual(panel.lit(), [], 'a stale answer lit the cancelled shortcut again');
});

test('panel: a check still adopts the shortcut armed before the panel was listening', async () => {
  const panel = await started({
    worker: worker({ 'cdr:check-tab': () => ({ ok: true, restriction: null, armedMode: 'region', armId: null }) }),
  });
  assert.deepEqual(panel.lit(), ['region']);
});

// F13. A drag's message comes two frames after the release, and an Element
// click can land in between. Only the mode that sent it has ended.
test('panel: a capture message turns off only the mode that sent it', async () => {
  const panel = await started();
  panel.click('mode-element');
  await panel.flush();
  assert.deepEqual(panel.lit(), ['element']);

  panel.broadcast({ type: 'cdr:region-selected', rect: { x: 0, y: 0, width: 50, height: 50 }, viewport: { width: 1280, height: 720 } }, fromTab);
  await panel.flush();
  assert.deepEqual(panel.lit(), ['element'], 'a late drag turned the picker dark');
  // The drag itself is still filed.
  assert.equal(panel.internals.state.items.length, 1);
  assert.equal(panel.internals.state.items[0].mode, 'region');

  panel.broadcast({ type: 'cdr:capture-cancelled', mode: 'region' }, fromTab);
  await panel.flush();
  assert.deepEqual(panel.lit(), ['element']);
  panel.broadcast({ type: 'cdr:capture-cancelled', mode: 'element' }, fromTab);
  await panel.flush();
  assert.deepEqual(panel.lit(), []);
});

// F14. Chrome's capture quota can hold the shot up to 1.2 s, and a mode
// armed during that wait may be in it.
test('panel: Screen warns about a mode armed while the capture waited out the quota', async () => {
  const panel = await started();
  panel.shots.next.push(() => {
    throw new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.');
  });
  panel.click('mode-visible');
  await panel.flush();
  panel.click('mode-region');
  await panel.flush();
  assert.deepEqual(panel.lit(), ['region']);

  await panel.clock.advance(600);
  assert.equal(panel.internals.state.items.length, 1);
  assert.equal(panel.banner(), ARMED_DURING_SCREEN);
});

test('panel: Screen warns about a mode armed while it waited for the cancel', async () => {
  const panel = await started({
    worker: worker({ 'cdr:disarm': () => ({ ok: true, superseded: true }) }),
  });
  panel.click('mode-region');
  await panel.flush();
  panel.click('mode-visible');
  await panel.flush();
  assert.equal(panel.internals.state.items.length, 1);
  assert.equal(panel.banner(), ARMED_DURING_SCREEN);
});

test('panel: Screen warns when the page outlasts the wait for the cancel', async () => {
  const panel = await started({ worker: worker({ 'cdr:disarm': () => new Promise(() => {}) }) });
  panel.click('mode-region');
  await panel.flush();
  panel.click('mode-visible');
  await panel.clock.advance(3000);
  assert.equal(panel.internals.state.items.length, 1);
  assert.equal(panel.banner(), OVERLAY_TOO_BUSY);
});

test('panel: Screen says nothing when the overlay came down in time', async () => {
  const panel = await started();
  panel.click('mode-region');
  await panel.flush();
  panel.click('mode-visible');
  await panel.flush();
  assert.equal(panel.internals.state.items.length, 1);
  assert.equal(panel.banner(), null);
  assert.deepEqual(panel.lit(), []);
});

// ------------------------------------------------------------- full page --

const SLOW_PHOTO = { id: 'photo', tag: 'img', rect: { x: 0, y: 900, width: 600, height: 200 }, complete: false };

// Page clears the page the way Screen does (clearForShot), and then waits for
// it: an overlay left on the page would be scrolled and photographed on every
// screen.
test('panel: Page cancels an armed mode and waits for the overlay to go before it scrolls', async () => {
  const disarm = held();
  const { panel, calls } = await panelAndPage({
    page: { height: 2000 },
    panel: { worker: worker({ 'cdr:disarm': () => disarm.promise }) },
  });
  panel.click('mode-region');
  await panel.flush();
  panel.click('mode-page');
  await panel.flush();
  assert.deepEqual(panel.lit(), [], 'the arm stayed lit');
  assert.ok(panel.sent.some((message) => message.type === 'cdr:disarm'));
  await panel.clock.advance(1000);
  assert.deepEqual(calls, [], 'the page was touched before the overlay went');
  disarm.release({ ok: true, superseded: false });
  await panel.clock.advance(8000);
  assert.deepEqual(calls.slice(0, 2), ['inject', 'begin']);
  assert.equal(panel.internals.state.items.at(-1)?.mode, 'page');
  assert.equal(panel.banner(), null);
});

// Unlike Screen, which photographs the page as it is, Page would scroll the
// page out from under an overlay the user has just armed.
test('panel: Page does not start when a mode was armed on the tab while it waited', async () => {
  const { panel, calls } = await panelAndPage({
    page: { height: 2000 },
    panel: { worker: worker({ 'cdr:disarm': () => ({ ok: true, superseded: true }) }) },
  });
  panel.click('mode-region');
  await panel.flush();
  panel.click('mode-page');
  await panel.clock.advance(3000);
  assert.deepEqual(calls, []);
  assert.equal(panel.internals.state.items.length, 0);
  assert.equal(panel.banner(), 'A capture mode was armed, so the page capture did not start.');
  assert.equal(panel.internals.state.pageShot, null);
  assert.equal(panel.internals.state.capturing, false);
});

test('panel: the second click of a double click on Page does not stop what the first started', async () => {
  const { panel } = await panelAndPage({ page: { height: 2000 } });
  panel.click('mode-page', { detail: 1 });
  panel.click('mode-page', { detail: 2 });
  await panel.clock.advance(8000);
  assert.equal(panel.internals.state.items.at(-1)?.mode, 'page');
});

// Closing the panel cannot wait for anything, so the page is told at once;
// the lease in the page is there for a call that never leaves.
test('panel: closing the panel during a page shot tells the page to put itself back', async () => {
  const { panel, page, calls } = await panelAndPage({ page: { height: 4000, elements: [SLOW_PHOTO] } });
  page.root.scrollTop = 120;
  panel.click('mode-page');
  await panel.clock.advance(300);
  assert.equal(await page.call('isActive'), true);
  panel.windowEvent('pagehide');
  await panel.flush();
  assert.equal(calls.at(-1), 'end');
  assert.equal(await page.call('isActive'), false);
  assert.equal(page.root.scrollTop, 120);
});

test('panel: Screen waits while a page shot runs', async () => {
  const { panel } = await panelAndPage({ page: { height: 4000, elements: [SLOW_PHOTO] } });
  panel.click('mode-page');
  await panel.clock.advance(300);
  await panel.internals.captureVisible();
  await panel.clock.advance(400);
  assert.equal(panel.internals.state.items.length, 0, 'Screen filed a capture in the middle of the page shot');
});
