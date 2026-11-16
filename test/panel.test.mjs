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
