/**
 * content/page-shot.js, run for real in a node:vm realm against a model of a
 * host page (test/support/page-realm.mjs).
 *
 * It is the one script that changes a host page on purpose, so these hold it
 * to putting the page back: every style it set, only where the value is still
 * its own, and the scroll position, whether the panel calls end(), stops
 * calling (the lease), the page is left (pagehide) or the user touches the
 * page. Then they hold it to what it changes during a run: which element
 * scrolls, which fixed elements show on which screen, sticky made relative,
 * snapping off.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { lastFiled as filed, makePage, panelAndPage as together } from './support/page-realm.mjs';

const HEADER = { id: 'header', position: 'fixed', rect: { x: 0, y: 0, width: 985, height: 60 } };
const BAR = { id: 'bar', position: 'fixed', rect: { x: 0, y: 740, width: 985, height: 60 } };
const SIDEBAR = { id: 'sidebar', position: 'fixed', rect: { x: 0, y: 0, width: 200, height: 800 } };
const STICKY = { id: 'sticky', position: 'sticky', rect: { x: 0, y: 400, width: 985, height: 40 } };

/** A page with the script injected. */
function started(options = {}) {
  const page = makePage(options);
  page.inject();
  return page;
}

/** Each inline property of the element, as name: 'value[ !important]'. */
function inline(element) {
  return Object.fromEntries(
    [...element.style.props].map(([name, { value, priority }]) => [name, priority ? `${value} !important` : value])
  );
}

const hidden = { visibility: 'hidden !important', opacity: '0 !important' };

/** step(index), with the clock run on until it answers. */
async function step(page, index, ms = 2000) {
  const reply = page.call('step', index);
  await page.clock.advance(ms);
  return reply;
}

// ------------------------------------------------------------- restoring --

test('end puts back every style it set and the scroll position, and leaves no style attribute behind', async () => {
  const page = started({ elements: [HEADER, BAR, STICKY] });
  page.root.scrollTop = 900;
  const begun = await page.call('begin');
  assert.equal(begun.ok, true);
  assert.equal(page.root.scrollTop, 0, 'a run starts at the top');
  await step(page, 1);
  assert.deepEqual(inline(page.el('header')), hidden);
  assert.deepEqual(inline(page.el('sticky')), {
    position: 'relative !important',
    top: 'auto !important',
    right: 'auto !important',
    bottom: 'auto !important',
    left: 'auto !important',
  });
  assert.deepEqual(inline(page.root), { 'scroll-snap-type': 'none !important' });

  assert.deepEqual(await page.call('end'), { restored: true });
  for (const element of [page.el('header'), page.el('bar'), page.el('sticky'), page.root]) {
    assert.deepEqual(inline(element), {});
    assert.equal(element.getAttribute('style'), null, `${element.id || element.localName} had no style attribute`);
  }
  assert.equal(page.root.scrollTop, 900, 'the page is back where it was');
  assert.equal(await page.call('isActive'), false);
});

test('end puts back a value the page had set, with its priority, and leaves one the page changed during the run', async () => {
  const page = started({
    elements: [
      { ...HEADER, style: { visibility: ['visible', 'important'], color: 'red' } },
      { ...BAR, id: 'bar', style: { opacity: '0.9' } },
    ],
  });
  await page.call('begin');
  await step(page, 1);
  assert.deepEqual(inline(page.el('header')), { ...hidden, color: 'red' });
  assert.deepEqual(inline(page.el('bar')), hidden);

  // The page writes its own opacity on the bar while the run goes on, as a
  // framework re-rendering it would.
  page.el('bar').style.setProperty('opacity', '0.5');
  await page.call('end');
  assert.deepEqual(inline(page.el('header')), { visibility: 'visible !important', color: 'red' });
  assert.deepEqual(inline(page.el('bar')), { opacity: '0.5' }, "the page's own write is left alone");
});

test('a value the page writes over during the run is hidden again on the next step, and its write is what end puts back', async () => {
  const page = started({ elements: [HEADER] });
  await page.call('begin');
  await step(page, 1);
  page.el('header').style.setProperty('opacity', '1', 'important');
  await step(page, 2);
  assert.deepEqual(inline(page.el('header')), hidden, 'hidden again');
  await page.call('end');
  assert.deepEqual(inline(page.el('header')), { opacity: '1 !important' });
});

test('the lease puts the page back when no call comes for 4 s, and the next step says so', async () => {
  const page = started({ elements: [HEADER] });
  page.root.scrollTop = 500;
  await page.call('begin');
  await step(page, 1, 32); // two frames, and the step has answered
  await page.clock.advance(3900);
  assert.equal(await page.call('isActive'), true, 'still going 3.9 s after the last step ended');
  await page.clock.advance(200);
  assert.equal(await page.call('isActive'), false);
  assert.deepEqual(inline(page.el('header')), {});
  assert.equal(page.root.scrollTop, 500);
  assert.deepEqual(await page.call('step', 2), { active: false, stopped: 'lease' });
  assert.deepEqual(page.listening(), [], 'and it no longer listens to the page');
});

test('the lease runs from the end of a step, so a step that waits on an image does not use it up', async () => {
  const page = started({
    elements: [{ id: 'photo', tag: 'img', rect: { x: 0, y: 900, width: 400, height: 300 }, complete: false }],
  });
  await page.call('begin');
  // The image in view never loads: the step gives up on it 800 ms after
  // its two frames, and 4.7 s after it began the run is still going.
  const reply = await step(page, 1, 32 + 800);
  assert.equal(reply.active, true);
  await page.clock.advance(3900);
  assert.equal(await page.call('isActive'), true);
  await page.clock.advance(200);
  assert.equal(await page.call('isActive'), false);
});

test('pagehide puts the page back and the next step says so', async () => {
  const page = started({ elements: [HEADER] });
  page.root.scrollTop = 300;
  await page.call('begin');
  await step(page, 1);
  page.input('pagehide');
  assert.deepEqual(inline(page.el('header')), {});
  assert.equal(page.root.scrollTop, 300);
  assert.deepEqual(await page.call('step', 2), { active: false, stopped: 'pagehide' });
});

for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown']) {
  test(`a ${type} on the page puts it back and the next step says the user stopped it`, async () => {
    const page = started({ elements: [HEADER, STICKY] });
    page.root.scrollTop = 1200;
    await page.call('begin');
    await step(page, 1);
    page.input(type);
    assert.deepEqual(inline(page.el('header')), {});
    assert.deepEqual(inline(page.el('sticky')), {});
    assert.equal(page.root.scrollTop, 1200);
    assert.deepEqual(await page.call('step', 2), { active: false, stopped: 'user' });
  });
}

test('the page input listeners are passive and in the capture phase, and an untrusted event does not stop the run', async () => {
  const page = started();
  await page.call('begin');
  const input = page.listening().filter((entry) => entry.type !== 'pagehide');
  assert.deepEqual(
    input.map((entry) => entry.type),
    ['wheel', 'touchstart', 'keydown', 'pointerdown']
  );
  assert.ok(input.every((entry) => entry.capture && entry.passive));
  page.input('keydown', { isTrusted: false });
  assert.equal(await page.call('isActive'), true, "a page's own dispatchEvent is not the user");
});

test('a step that is still waiting when the run ends answers that it stopped, and changes nothing after', async () => {
  const page = started({
    elements: [HEADER, { id: 'photo', tag: 'img', rect: { x: 0, y: 900, width: 400, height: 300 }, complete: false }],
  });
  await page.call('begin');
  const reply = page.call('step', 1);
  await page.clock.advance(100);
  page.input('wheel');
  await page.clock.advance(1000);
  assert.deepEqual(await reply, { active: false, stopped: 'user' });
  assert.deepEqual(inline(page.el('header')), {});
});

test('begin puts back a run the panel lost track of before it starts another', async () => {
  const page = started({ elements: [HEADER] });
  page.root.scrollTop = 700;
  await page.call('begin');
  await step(page, 1);
  // The panel's frame reloaded and starts again.
  await page.call('begin');
  await page.call('end');
  assert.equal(page.root.scrollTop, 700, 'the first run kept where the page really was');
  assert.deepEqual(inline(page.el('header')), {});
});

// An app's scrolling pane is what the run scrolls, so it is put back as the
// document is, on every path that ends a run.
test('an inner scroller gets its scroll position and its snapping back, however the run ends', async () => {
  const pane = { id: 'pane', overflowY: 'auto', rect: { x: 200, y: 0, width: 600, height: 800 }, scroll: { height: 9000 } };
  for (const [how, close] of [
    ['end', (page) => page.call('end')],
    ['wheel', (page) => page.input('wheel')],
    ['lease', (page) => page.clock.advance(4100)],
  ]) {
    const page = started({ height: 3000, elements: [pane, HEADER] });
    page.el('pane').scrollTop = 450;
    page.root.scrollTop = 120;
    assert.equal((await page.call('begin')).scroller, 'inner', how);
    assert.equal(page.el('pane').scrollTop, 0, `${how}: the run starts at the top of the pane`);
    await step(page, 2);
    assert.equal(page.el('pane').scrollTop, 1598, how);
    assert.deepEqual(inline(page.el('header')), hidden, how);
    await close(page);
    assert.equal(await page.call('isActive'), false, how);
    assert.equal(page.el('pane').scrollTop, 450, `${how}: the pane is back where it was`);
    assert.equal(page.root.scrollTop, 120, `${how}: the document was not moved`);
    assert.deepEqual(inline(page.el('pane')), {}, how);
    assert.equal(page.el('pane').getAttribute('style'), null, how);
    assert.deepEqual(inline(page.el('header')), {}, how);
  }
});

test('two injections keep one controller, and a run survives the second', async () => {
  const page = started();
  const first = page.window.__cdrPageShot;
  await page.call('begin');
  page.inject();
  assert.equal(page.window.__cdrPageShot, first);
  assert.equal(await page.call('isActive'), true);
});

test('pinch zoom is refused and nothing on the page changes', async () => {
  const page = started({ scale: 1.6, elements: [HEADER] });
  page.root.scrollTop = 400;
  assert.deepEqual(await page.call('begin'), { ok: false, reason: 'zoom' });
  assert.equal(page.root.scrollTop, 400);
  assert.deepEqual(inline(page.root), {});
  assert.deepEqual(page.listening(), []);
});

// ------------------------------------------------------- what it changes --

test('the document is chosen unless an inner element scrolls further and covers a quarter of the view', async () => {
  const pane = { id: 'pane', overflowY: 'auto', rect: { x: 200, y: 0, width: 600, height: 800 }, scroll: { height: 9000 } };
  const small = { id: 'small', overflowY: 'auto', rect: { x: 0, y: 0, width: 300, height: 300 }, scroll: { height: 20000 } };
  const short = { ...pane, id: 'short', scroll: { height: 2000 } };

  let page = started({ height: 3000, elements: [short, small] });
  let begun = await page.call('begin');
  assert.equal(begun.scroller, 'document', 'the document scrolls 2200 px, the pane 1200');
  assert.deepEqual(begun.rect, { x: 0, y: 0, width: 985, height: 800 });

  page = started({ height: 3000, elements: [pane, small] });
  begun = await page.call('begin');
  assert.equal(begun.scroller, 'inner', 'the pane scrolls 8200 px, and the small one covers under a quarter');
  assert.deepEqual(begun.rect, { x: 200, y: 0, width: 585, height: 800 });
  assert.equal(begun.screens, Math.ceil(9000 / 800));
  assert.deepEqual(inline(page.el('pane')), { 'scroll-snap-type': 'none !important' });

  page = started({ height: 3000, elements: [{ ...pane, overflowY: 'hidden' }] });
  assert.equal((await page.call('begin')).scroller, 'document', 'overflow hidden does not scroll for the user');
});

test('a document the page locked is not what scrolls', async () => {
  const pane = { id: 'pane', overflowY: 'scroll', rect: { x: 0, y: 0, width: 985, height: 800 }, scroll: { height: 1400 } };
  const page = started({ height: 5000, bodyOverflow: 'hidden', elements: [pane] });
  const begun = await page.call('begin');
  assert.equal(begun.scroller, 'inner');
  assert.equal(page.root.scrollTop, 0);
});

// An open dialog, a cookie wall or a menu locks the document. The user cannot
// scroll it, but a script still can (the probe got seven screens out of a
// locked 5000 px page), and that would load and log, under the lock, what the
// user never reached. With overflow clip it would not move at all.
test('a document the page locked, with nothing else to scroll, is left as it is, as the screen in view', async () => {
  for (const lock of [{ bodyOverflow: 'hidden' }, { overflow: 'hidden' }, { overflow: 'clip' }]) {
    const name = JSON.stringify(lock);
    const page = started({ height: 5000, elements: [HEADER, BAR, STICKY], ...lock });
    page.root.scrollTop = 1200;
    const begun = await page.call('begin');
    assert.deepEqual(
      [begun.scroller, begun.locked, begun.screens, begun.scrollHeight],
      ['document', true, 1, 800],
      `${name}: ${JSON.stringify(begun)}`
    );
    const reply = await step(page, 0);
    assert.deepEqual(
      [reply.top, reply.atEnd, reply.scrollHeight, reply.before],
      [0, true, 800, { top: 0, scrollHeight: 800 }],
      name
    );
    assert.deepEqual(page.scrolls, [], `${name}: it was scrolled`);
    for (const element of [page.root, page.el('header'), page.el('bar'), page.el('sticky')]) {
      assert.deepEqual(inline(element), {}, `${name}: ${element.id || element.localName} was changed`);
    }
    assert.deepEqual(await page.call('end'), { restored: true }, name);
    assert.deepEqual(page.scrolls, [], `${name}: it was scrolled on the way out`);
    assert.equal(page.root.scrollTop, 1200, name);
  }
  // Locked, but it fits the view anyway: nothing to say about a lock.
  const fits = started({ height: 800, bodyOverflow: 'hidden' });
  const begun = await fits.call('begin');
  assert.equal(begun.screens, 1);
  assert.equal('locked' in begun, false);
});

// Locomotive Scroll 4 in smooth mode (a view 1024 px wide or more) locks the
// root with overflow hidden and moves its container up with a transform as
// the wheel turns: in Chrome for Testing 156 Page said an open dialog had
// locked the page, where none was open. Told apart from a lock a dialog,
// a cookie wall or a menu holds only where nothing of those is there.
const LOCO = { id: 'container', rect: { x: 0, y: 0, width: 1000, height: 3600 }, transform: 'matrix(1, 0, 0, 1, 0, -384)' };

test('a locked page that a script of its own has moved is told apart from one a dialog holds, and left as it is', async () => {
  const scripted = async (elements, name, options = {}) => {
    const page = started({ height: 3600, overflow: 'hidden', bodyOverflow: 'hidden', elements, ...options });
    const begun = await page.call('begin');
    assert.equal(begun.locked, true, `${name}: ${JSON.stringify(begun)}`);
    assert.equal(begun.screens, 1, name);
    await step(page, 0);
    await page.call('end');
    assert.deepEqual(page.scrolls, [], `${name}: it was scrolled`);
    for (const element of [page.root, ...elements.map((spec) => page.el(spec.id))]) {
      assert.equal(element.writes, 0, `${name}: ${element.id || element.localName} was changed`);
    }
    return begun.scripted ?? false;
  };
  assert.equal(await scripted([LOCO], 'moved up'), true);
  assert.equal(
    await scripted([{ ...LOCO, transform: 'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -384, 0, 1)' }], 'matrix3d'),
    true
  );
  const cover = { id: 'cover', position: 'fixed', rect: { x: 0, y: 0, width: 1000, height: 800 } };
  assert.equal(
    await scripted(
      [
        LOCO,
        { ...BAR, id: 'cookies' },
        { ...cover, style: { visibility: 'hidden' } },
        { ...cover, id: 'transition', style: { opacity: '0' } },
      ],
      'a bar, a hidden cover, a transparent one'
    ),
    true,
    'a bar fixed to the bottom, or a cover that cannot be seen, holds nothing'
  );
  // What holds a page still is there, so the notice names both causes.
  for (const [name, more] of [
    ['a backdrop', [cover]],
    ['a modal dialog', [{ id: 'dialog', tag: 'dialog', position: 'fixed', modal: true, rect: { x: 300, y: 200, width: 400, height: 300 } }]],
    ['aria-modal', [{ id: 'sheet', attributes: { 'aria-modal': 'true' }, rect: { x: 300, y: 200, width: 400, height: 300 } }]],
  ]) {
    assert.equal(await scripted([LOCO, ...more], name), false, name);
  }
  // And what does not look like a page moved up by its own scrolling.
  for (const [name, change] of [
    ['at the top, not moved yet', { transform: 'matrix(1, 0, 0, 1, 0, 0)' }],
    ['moved sideways, as a menu pushes the page', { transform: 'matrix(1, 0, 0, 1, 300, 0)' }],
    ['pushed sideways once scrolled', { transform: 'matrix(1, 0, 0, 1, 300, -384)' }],
    ['scaled', { transform: 'matrix(0.9, 0, 0, 0.9, 0, -384)' }],
    ['no transform', { transform: 'none' }],
    ['no taller than the view', { rect: { x: 0, y: 0, width: 1000, height: 800 } }],
    ['fixed to the window, a column too narrow to hold the page', { position: 'fixed', rect: { x: 0, y: 0, width: 200, height: 3600 } }],
  ]) {
    assert.equal(await scripted([{ ...LOCO, ...change }], name), false, name);
  }
  // An aria-modal element that is not shown holds nothing.
  const closed = { id: 'closed', attributes: { 'aria-modal': 'true' }, rect: { x: 0, y: 0, width: 0, height: 0 } };
  assert.equal(await scripted([LOCO, closed], 'a closed sheet'), true);
  // The page scrolls for the user: no lock, so nothing to tell apart.
  const page = started({ height: 3600, elements: [LOCO] });
  const begun = await page.call('begin');
  assert.equal('locked' in begun || 'scripted' in begun, false);
});

test('begin says the device pixel ratio, for the panel to count the screens a run at the cap takes', async () => {
  for (const ratio of [1, 2, 1.25]) {
    const page = started({ ratio });
    assert.equal((await page.call('begin')).ratio, ratio);
  }
});

test('a top fixed element shows on the first screen only, a bottom one on the last only, and a tall sidebar always', async () => {
  const page = started({ height: 2000, elements: [HEADER, BAR, SIDEBAR] });
  const shown = () => ['header', 'bar', 'sidebar'].filter((id) => !inline(page.el(id)).opacity);
  await page.call('begin');
  const replies = [];
  replies.push(await step(page, 0));
  assert.deepEqual(shown(), ['header', 'sidebar']);
  replies.push(await step(page, 1));
  assert.deepEqual(shown(), ['sidebar']);
  replies.push(await step(page, 2));
  assert.deepEqual(shown(), ['bar', 'sidebar']);
  assert.deepEqual(
    replies.map(({ top, atEnd }) => ({ top, atEnd })),
    [
      { top: 0, atEnd: false },
      { top: 799, atEnd: false },
      { top: 1200, atEnd: true },
    ],
    'a step is a CSS pixel short of a screen, and the last is clamped to the end of the page, which the reply says'
  );
  assert.deepEqual(inline(page.el('sidebar')), {});
});

test('a page that fits the view is one screen with every fixed element shown', async () => {
  const page = started({ height: 800, elements: [HEADER, BAR] });
  const begun = await page.call('begin');
  assert.equal(begun.screens, 1);
  const reply = await step(page, 0);
  assert.equal(reply.atEnd, true);
  assert.deepEqual(inline(page.el('header')), {});
  assert.deepEqual(inline(page.el('bar')), {});
});

test('a fixed element outside the inner scroller is left alone', async () => {
  const page = started({
    height: 800,
    elements: [
      { id: 'top', position: 'fixed', rect: { x: 0, y: 0, width: 1000, height: 60 } },
      { id: 'pane', overflowY: 'auto', rect: { x: 0, y: 60, width: 1000, height: 740 }, scroll: { height: 4000 } },
      { id: 'toast', position: 'fixed', rect: { x: 700, y: 700, width: 250, height: 60 } },
    ],
  });
  const begun = await page.call('begin');
  assert.equal(begun.scroller, 'inner');
  await step(page, 1);
  assert.deepEqual(inline(page.el('top')), {}, 'the header sits above the pane');
  assert.deepEqual(inline(page.el('toast')), hidden, 'the toast is over the pane, so it shows on the last screen only');
  assert.equal(page.el('pane').scrollTop, 739);
});

test('when lazy content lengthens the page during the last step, the bottom bar is hidden again', async () => {
  const page = started({
    height: 1600,
    elements: [BAR, { id: 'photo', tag: 'img', rect: { x: 0, y: 1000, width: 400, height: 300 }, complete: false }],
  });
  await page.call('begin');
  const reply = page.call('step', 1);
  await page.clock.advance(100);
  assert.deepEqual(inline(page.el('bar')), {}, 'at the end when the step scrolled');
  page.height = 2400;
  page.el('photo').load();
  await page.clock.advance(500);
  const answer = await reply;
  assert.equal(answer.atEnd, false);
  assert.equal(answer.scrollHeight, 2400);
  assert.deepEqual(inline(page.el('bar')), hidden);
});

// A header that a script fixes once the page is scrolled past it, which is
// how many sites make a header sticky. Chrome runs scroll handlers with the
// frame after the scroll, so the header is not fixed yet when the step has
// just scrolled, and was shown, repeated, on every screen after the first.
test('a header that a script fixes once the page is scrolled is hidden on that same screen', async () => {
  const page = started({ height: 3000, elements: [{ id: 'nav', rect: { x: 0, y: 0, width: 985, height: 60 } }] });
  const scroll = page.scroll;
  page.scroll = (target, options) => {
    scroll(target, options);
    page.clock.setTimeout(() => {
      page.el('nav').sheet.position = target.scrollTop > 100 ? 'fixed' : 'static';
    }, 16);
  };
  await page.call('begin');
  await step(page, 0);
  assert.deepEqual(inline(page.el('nav')), {}, 'in its place on the first screen');
  await step(page, 1);
  assert.equal(page.computed(page.el('nav')).position, 'fixed');
  assert.deepEqual(inline(page.el('nav')), hidden, 'the header repeated on the second screen');
  await page.call('end');
  assert.deepEqual(inline(page.el('nav')), {});
});

test('a sticky element is made relative with its insets taken off, and its own box is put back after', async () => {
  const page = started({ elements: [{ ...STICKY, style: { top: '10px' } }] });
  await page.call('begin');
  await step(page, 1);
  const sticky = page.el('sticky');
  assert.equal(page.computed(sticky).position, 'relative');
  assert.equal(sticky.getBoundingClientRect().top, 400 - 799, 'it scrolls with the page instead of pinning');
  await page.call('end');
  assert.deepEqual(inline(sticky), { top: '10px' });
});

test('scroll snapping is off for the run, so each screen lands where it was sent, and on again after', async () => {
  const page = started({ height: 3000, snap: [0, 409, 1300, 2200] });
  await page.call('begin');
  const reply = await step(page, 1);
  assert.equal(reply.top, 799, 'not the 409 a snapping page would land on');
  await page.call('end');
  assert.deepEqual(inline(page.root), {});
  assert.equal(page.computed(page.root).scrollSnapType, 'y mandatory');
});

test('a page with smooth scrolling still lands on each screen at once', async () => {
  const page = started({ height: 3000, smooth: true });
  await page.call('begin');
  const reply = page.call('step', 1);
  assert.equal(page.root.scrollTop, 799, 'before any frame has run');
  await page.clock.advance(2000);
  assert.equal((await reply).top, 799);
  assert.ok(page.scrolls.every((scroll) => scroll.behavior === 'instant'));
});

test('a step waits two frames and then for the images in view, at most 800 ms', async () => {
  const page = started({
    elements: [
      { id: 'near', tag: 'img', rect: { x: 0, y: 900, width: 400, height: 300 }, complete: false },
      { id: 'far', tag: 'img', rect: { x: 0, y: 2500, width: 400, height: 300 }, complete: false },
    ],
  });
  await page.call('begin');
  let answered = false;
  const reply = page.call('step', 1).then((value) => {
    answered = true;
    return value;
  });
  await page.clock.advance(400);
  assert.equal(answered, false, 'still waiting on the image in view');
  page.el('near').load();
  await page.clock.advance(1);
  assert.equal(answered, true, 'the one out of view is not waited for');
  assert.equal((await reply).active, true);

  const slow = started({ elements: [{ id: 'near', tag: 'img', rect: { x: 0, y: 900, width: 400, height: 300 }, complete: false }] });
  await slow.call('begin');
  let done = false;
  slow.call('step', 1).then(() => (done = true));
  await slow.clock.advance(32 + 799);
  assert.equal(done, false);
  await slow.clock.advance(2);
  assert.equal(done, true);
});

test('a tab that runs no frames still gets an answer to each step', async () => {
  const page = started({ painting: false });
  await page.call('begin');
  const reply = await step(page, 1, 300);
  assert.equal(reply.active, true);
});

test('a fixed header inside a closed shadow root is hidden where chrome.dom can reach it, and the walk goes on without it', async () => {
  const elements = [
    { id: 'app', tag: 'app-shell', shadow: 'closed', rect: { x: 0, y: 0, width: 985, height: 3000 } },
    { ...HEADER, id: 'inside', shadowIn: 'app' },
    { id: 'open', tag: 'side-note', shadow: 'open' },
    { ...BAR, id: 'deep', shadowIn: 'open' },
  ];
  const page = started({ elements });
  await page.call('begin');
  await step(page, 1);
  assert.deepEqual(inline(page.el('inside')), hidden);
  assert.deepEqual(inline(page.el('deep')), hidden);

  // The stage: no isolated world, so no chrome.dom, and only open roots.
  const stage = started({ dom: false, elements });
  await stage.call('begin');
  await step(stage, 1);
  assert.deepEqual(inline(stage.el('inside')), {});
  assert.deepEqual(inline(stage.el('deep')), hidden);
});

// A widget's loader puts its closed root on a plain div as often as a
// component does on a custom element, and a chat button fixed in it would
// repeat down the stitched page. Asking costs, so each element once a run.
test('a closed shadow root on a plain div is reached too, and each element is asked about once a run', async () => {
  const elements = [
    { id: 'widget', shadow: 'closed', rect: { x: 0, y: 0, width: 0, height: 0 } },
    { ...BAR, id: 'chat', shadowIn: 'widget' },
  ];
  const page = started({ elements });
  const ask = page.window.chrome.dom.openOrClosedShadowRoot;
  let asks = 0;
  page.window.chrome.dom.openOrClosedShadowRoot = (element) => {
    if (element === page.el('widget')) asks += 1;
    return ask(element);
  };
  await page.call('begin');
  await step(page, 0);
  await step(page, 1);
  assert.deepEqual(inline(page.el('chat')), hidden, 'the chat button repeated on the second screen');
  assert.equal(asks, 1, 'asked once over begin and two steps, each walking the page');
  await page.call('end');
  assert.deepEqual(inline(page.el('chat')), {});
  await page.call('begin');
  await step(page, 1);
  assert.equal(asks, 2, 'asked again in the next run');
  await page.call('end');
});

test('step reports where it was before it scrolled, the viewport, and the page height', async () => {
  const page = started({ height: 2600 });
  await page.call('begin');
  await step(page, 0);
  const reply = await step(page, 1);
  assert.deepEqual(reply, {
    active: true,
    top: 799,
    scrollHeight: 2600,
    atEnd: false,
    viewport: { width: 1000, height: 800 },
    before: { top: 0, scrollHeight: 2600 },
  });
});

// ------------------------------------------ the panel and the page together --

const QUOTA = 'This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.';
const LOCKED =
  'The page has locked its scrolling, as an open dialog or menu does, or as a page that scrolls itself with a script does, so this is the visible screen.';

/** Each count the Page button shows while a run goes on, in order, each once. */
function countsShown(panel) {
  const node = panel.element('mode-page-count');
  const seen = [];
  let value = node.textContent;
  Object.defineProperty(node, 'textContent', {
    get: () => value,
    set: (text) => {
      value = text;
      if (text && seen.at(-1) !== text) seen.push(text);
    },
  });
  return seen;
}

test('Page scrolls the page through, files one stitched PNG, and puts the page back', async () => {
  const { panel, page, calls, downloads } = await together({ page: { height: 2000, elements: [HEADER, BAR] } });
  page.root.scrollTop = 600;
  panel.click('mode-page');
  await panel.clock.advance(10000);
  assert.deepEqual(calls, ['inject', 'begin', 'step', 'step', 'step', 'end']);
  const { item, saved } = filed(panel);
  assert.equal(item.mode, 'page');
  assert.deepEqual({ ...item.stitched }, { screens: 3, cssWidth: 1280, cssHeight: 2000 });
  assert.equal(item.width, 1280);
  assert.equal(item.height, 2000);
  assert.match(downloads.at(-1).filename, /^claude-punch-list\/[\d_-]+_page\.png$/);
  assert.deepEqual(
    saved.canvas.context.calls.filter((call) => call.op === 'drawImage').map((call) => call.args.slice(1)),
    [
      [0, 0, 1280, 720, 0, 0, 1280, 720],
      [0, 0, 1280, 720, 0, 719, 1280, 720],
      [0, 0, 1280, 720, 0, 1280, 1280, 720],
    ],
    'each screen at the offset the page reached, the last one clamped to the end'
  );
  assert.equal(page.root.scrollTop, 600);
  assert.deepEqual(inline(page.el('header')), {});
  assert.deepEqual(inline(page.el('bar')), {});
  assert.equal(panel.internals.state.pageShot, null);
  assert.ok(panel.bitmaps.every((bitmap) => bitmap.closed), 'every decoded screenshot was let go');
});

// The lease is the page's backstop for a panel that went away, so it must
// never fire on one that is merely slow. The slowest a working panel gets
// between two steps is captureVisibleTab refused twice for the quota while
// another window's panel captures (two waits of 600 ms) and then slow to
// answer (600 ms more): 1.8 s, captureViewport's whole retry budget. Each
// step here also waits the whole 800 ms on an image that never loads, which
// the page counts inside the step, since it renews the lease at both ends.
test('the lease holds through the quota retries and the image wait while another panel captures', async () => {
  const photo = (id, y) => ({ id, tag: 'img', rect: { x: 0, y, width: 600, height: 200 }, complete: false });
  const { panel, page, calls } = await together({
    page: { height: 2158, elements: [HEADER, photo('one', 900), photo('two', 1600)] },
  });
  const ok = async () => {};
  const refused = () => {
    throw new Error(QUOTA);
  };
  const slow = () => new Promise((resolve) => panel.clock.setTimeout(resolve, 600));
  panel.shots.next.push(ok, refused, refused, slow, refused, refused, slow);
  // How long the page went without a call, between one ending and the next.
  const silences = [];
  const steps = [];
  let lastAnswer = null;
  const run = page.run.bind(page);
  page.run = async (func, args) => {
    const start = panel.clock.now;
    if (lastAnswer != null) silences.push(start - lastAnswer);
    try {
      return await run(func, args);
    } finally {
      lastAnswer = panel.clock.now;
      if (args[0] === 'step') steps.push(lastAnswer - start);
    }
  };
  panel.click('mode-page');
  let stoppedEarly = false;
  for (let elapsed = 0; elapsed < 14000; elapsed += 100) {
    await panel.clock.advance(100);
    if (panel.internals.state.pageShot && !(await page.call('isActive')) && calls.at(-1) !== 'end') stoppedEarly = true;
  }
  assert.equal(stoppedEarly, false, 'the page put itself back while the panel was still capturing');
  assert.deepEqual(calls, ['inject', 'begin', 'step', 'step', 'step', 'end']);
  const { item } = filed(panel);
  assert.equal(item?.stitched?.screens, 3);
  assert.equal(panel.banner(), null);
  // The test reached the case it is about: a silence as long as the retries,
  // and steps that waited out the image.
  assert.ok(Math.max(...silences) >= 1800, `the longest silence was ${Math.max(...silences)} ms`);
  assert.ok(Math.max(...silences) < 4000);
  assert.ok(steps.slice(1).every((ms) => ms >= 800), `steps took ${steps.join(', ')} ms`);
});

test('a screenshot that fails after its retries ends the run in finally, files nothing, and says why', async () => {
  const { panel, page, calls } = await together({ page: { height: 2000, elements: [HEADER] } });
  page.root.scrollTop = 250;
  const refused = () => {
    throw new Error(QUOTA);
  };
  panel.shots.next.push(async () => {}, refused, refused, refused);
  panel.click('mode-page');
  await panel.clock.advance(10000);
  assert.equal(calls.at(-1), 'end');
  assert.equal(panel.internals.state.items.length, 0);
  assert.match(panel.banner(), /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/);
  assert.equal(page.root.scrollTop, 250);
  assert.deepEqual(inline(page.el('header')), {});
  assert.equal(await page.call('isActive'), false);
  assert.equal(panel.element('mode-page').classList.contains('armed'), false);
});

// Screenshots that would not line up, and a canvas Chrome would not encode:
// each files nothing and says why, with the page put back and every decoded
// screenshot let go.
test('a screenshot of the wrong size, or a page too large to encode, files nothing and says why', async () => {
  const RESIZED = 'The tab changed size, so the page capture stopped. Nothing was filed.';
  const cases = [
    // The first screenshot's height disagrees with the tab's (an infobar
    // came since begin), as cropCapture checks.
    [
      'first screenshot',
      (panel) => panel.imageSizes.set('data:image/png;base64,AAAA', { width: 1280, height: 800 }),
      RESIZED,
    ],
    // A later one is of another size (the window moved to another display),
    // found when the screenshots are put together.
    [
      'later screenshot',
      (panel) => {
        const capture = panel.chrome.tabs.captureVisibleTab;
        let shots = 0;
        panel.chrome.tabs.captureVisibleTab = async (...args) => {
          await capture(...args);
          shots += 1;
          return shots === 2 ? 'data:image/png;base64,BBBB' : 'data:image/png;base64,AAAA';
        };
        panel.imageSizes.set('data:image/png;base64,BBBB', { width: 2560, height: 1440 });
      },
      RESIZED,
    ],
    // Past Chrome's canvas limits toBlob hands over null instead of a PNG.
    [
      'encoder',
      (panel, canvases) => {
        const make = panel.document.createElement;
        panel.document.createElement = (tag) => {
          const node = make(tag);
          if (tag === 'canvas' && panel.internals.state.pageShot?.composing) {
            node.toBlob = (callback) => setImmediate(() => callback(null));
            canvases.push(node);
          }
          return node;
        };
      },
      'The whole page was too large to put together, so nothing was filed.',
    ],
  ];
  for (const [name, arrange, said] of cases) {
    const { panel, page } = await together({ page: { height: 2000, elements: [HEADER] } });
    page.root.scrollTop = 250;
    const canvases = [];
    arrange(panel, canvases);
    panel.click('mode-page');
    await panel.clock.advance(10000);
    assert.equal(panel.internals.state.items.length, 0, `${name}: filed`);
    assert.equal(panel.banner(), said, name);
    assert.equal(panel.internals.state.pageShot, null, name);
    assert.equal(page.root.scrollTop, 250, name);
    assert.deepEqual(inline(page.el('header')), {}, name);
    assert.ok(panel.bitmaps.every((bitmap) => bitmap.closed), `${name}: a decoded screenshot was kept`);
    assert.ok(canvases.every((canvas) => canvas.width === 0), `${name}: the canvas was kept`);
    if (name === 'encoder') assert.equal(canvases.length, 1, 'the encoder case never reached the encoder');
  }
});

test('a panel that stops calling leaves the page to its lease, which puts it back', async () => {
  const { panel, page } = await together({ page: { height: 4000, elements: [HEADER] } });
  page.root.scrollTop = 1000;
  // The second step never comes back: the panel's window closed under it.
  let steps = 0;
  const run = page.run.bind(page);
  page.run = (func, args) => (args[0] === 'step' && ++steps === 2 ? new Promise(() => {}) : run(func, args));
  panel.click('mode-page');
  await panel.clock.advance(1000);
  assert.equal(await page.call('isActive'), true);
  await panel.clock.advance(4000);
  assert.equal(await page.call('isActive'), false);
  assert.equal(page.root.scrollTop, 1000);
  assert.deepEqual(inline(page.el('header')), {});
});

test('touching the page stops the run, files nothing, and the banner says why', async () => {
  const { panel, page, calls } = await together({ page: { height: 4000 } });
  panel.click('mode-page');
  await panel.clock.advance(700);
  page.input('wheel');
  await panel.clock.advance(5000);
  assert.equal(calls.at(-1), 'end');
  assert.equal(panel.internals.state.items.length, 0);
  assert.equal(
    panel.banner(),
    'You scrolled, pressed a key or clicked on the page, so the page capture stopped. Nothing was filed.'
  );
});

// No step follows the last screenshot to say the page was stopped before it
// was taken, and by then the page is back where it was, which that
// screenshot shows at the bottom of the image: what end() answers says it.
// The user is most likely to touch the page just as it reaches its end.
test('a page stopped after its last step answered files nothing, and the banner says why', async () => {
  const LEFT = 'The tab left or reloaded the page, so the page capture stopped. Nothing was filed.';
  const INPUT = 'You scrolled, pressed a key or clicked on the page, so the page capture stopped. Nothing was filed.';
  for (const [name, height, act, said] of [
    ['wheel', 2000, (page) => page.input('wheel'), INPUT],
    ['keydown on a page of one screen', 720, (page) => page.input('keydown'), INPUT],
    ['pagehide', 2000, (page) => page.input('pagehide'), LEFT],
    ['new document', 2000, (page) => page.run('() => { delete window.__cdrPageShot; }'), LEFT],
  ]) {
    const { panel, page, calls } = await together({ page: { height, elements: [HEADER, BAR] } });
    page.root.scrollTop = height > 720 ? 600 : 0;
    let stopped = false;
    let shotsAfter = 0;
    const capture = panel.chrome.tabs.captureVisibleTab;
    panel.chrome.tabs.captureVisibleTab = (...args) => {
      if (stopped) shotsAfter += 1;
      return capture(...args);
    };
    const run = page.run.bind(page);
    page.run = async (func, args) => {
      const result = await run(func, args);
      if (args?.[0] === 'step' && result?.atEnd) {
        await act(page);
        stopped = true;
      }
      return result;
    };
    panel.click('mode-page');
    await panel.clock.advance(10000);
    assert.equal(shotsAfter, 1, `${name}: the last screenshot was taken after the stop`);
    assert.equal(calls.at(-1), 'end', name);
    assert.equal(panel.internals.state.items.length, 0, `${name}: filed`);
    assert.equal(panel.banner(), said, name);
    assert.equal(panel.internals.state.pageShot, null, name);
    assert.equal(page.root.scrollTop, height > 720 ? 600 : 0, name);
    assert.deepEqual(inline(page.el('header')), {}, name);
  }
});

// A page whose main thread is stuck, or a frame that went with no answer:
// Page must not read Stop for ever, and Stop must not wait on the call.
test('a page that stops answering ends the run in the panel too, and Stop does not wait for it', async () => {
  const hang = (page) => {
    let steps = 0;
    const run = page.run.bind(page);
    page.run = (func, args) => (args[0] === 'step' && ++steps === 2 ? new Promise(() => {}) : run(func, args));
  };
  const { panel, page, calls } = await together({ page: { height: 4000, elements: [HEADER] } });
  hang(page);
  panel.click('mode-page');
  await panel.clock.advance(1000);
  assert.ok(panel.internals.state.pageShot, 'the run is waiting on its second step');
  await panel.clock.advance(5000);
  assert.equal(panel.internals.state.pageShot, null);
  assert.equal(panel.internals.state.capturing, false);
  assert.equal(panel.element('mode-page-label').textContent, 'Page');
  assert.equal(calls.at(-1), 'end');
  assert.equal(panel.internals.state.items.length, 0);
  assert.equal(
    panel.banner(),
    'The page went away or stopped answering, so the page capture stopped. Nothing was filed.'
  );

  const second = await together({ page: { height: 4000, elements: [HEADER] } });
  hang(second.page);
  second.panel.click('mode-page');
  await second.panel.clock.advance(1000);
  second.panel.click('mode-page');
  await second.panel.clock.advance(1);
  assert.equal(second.panel.internals.state.pageShot, null, 'Stop waited on the step in flight');
  assert.equal(second.panel.element('announce').textContent, 'Page capture cancelled. Nothing was filed.');
  assert.equal(second.panel.internals.state.items.length, 0);
});

// The page's own pagehide is what says the tab left it: tabs.onUpdated also
// reports a change of fragment or a pushState, which an infinite scroll page
// does as it scrolls, and that is no reason to stop.
test('the tab leaving or reloading the page ends the run and says so', async () => {
  for (const [name, leave] of [
    ['pagehide', (page) => page.input('pagehide')],
    // The next step reaches the new document, which has no controller.
    ['new document', (page) => page.run('() => { delete window.__cdrPageShot; }')],
  ]) {
    const { panel, page } = await together({ page: { height: 4000, elements: [HEADER] } });
    panel.click('mode-page');
    await panel.clock.advance(700);
    await leave(page);
    await panel.clock.advance(5000);
    assert.equal(panel.internals.state.items.length, 0, name);
    assert.equal(panel.internals.state.pageShot, null, name);
    assert.equal(
      panel.banner(),
      'The tab left or reloaded the page, so the page capture stopped. Nothing was filed.',
      name
    );
  }
});

for (const [how, act] of [
  ['Stop', (panel) => panel.click('mode-page')],
  ['Esc', (panel) => panel.key('Escape')],
]) {
  test(`${how} ends the run at once, puts the page back, files nothing and keeps quiet`, async () => {
    const { panel, page, calls } = await together({ page: { height: 4000, elements: [HEADER] } });
    page.root.scrollTop = 333;
    panel.click('mode-page');
    await panel.clock.advance(700);
    assert.equal(panel.banner(), 'Capturing the whole page by scrolling it. Press Esc or Stop to cancel.');
    act(panel);
    await panel.flush();
    assert.equal(page.root.scrollTop, 333, 'put back before the step in flight answers');
    await panel.clock.advance(5000);
    assert.equal(panel.internals.state.items.length, 0);
    assert.equal(panel.banner(), null);
    assert.equal(panel.element('announce').textContent, 'Page capture cancelled. Nothing was filed.');
    assert.equal(calls.filter((call) => call === 'end').length >= 1, true);
    assert.equal(panel.internals.state.pageShot, null);

    // A second cancel finds the region holding the same line, which a screen
    // reader may not read again: it is emptied and set anew.
    const region = panel.element('announce');
    const said = [];
    let value = region.textContent;
    Object.defineProperty(region, 'textContent', {
      get: () => value,
      set: (text) => {
        value = text;
        said.push(text);
      },
    });
    panel.click('mode-page');
    await panel.clock.advance(700);
    act(panel);
    await panel.clock.advance(5000);
    assert.equal(panel.internals.state.items.length, 0);
    assert.deepEqual(said.slice(-2), ['', 'Page capture cancelled. Nothing was filed.']);
  });
}

// captureVisibleTab photographs whatever tab is in view, so a switch the
// panel hears of must stop the run before the next screenshot: the check of
// the tab in view comes only after one, of the other tab.
test('a tab switch the panel hears of stops the run before another screenshot is taken', async () => {
  const { panel } = await together({ page: { height: 4000, elements: [HEADER] } });
  let shots = 0;
  const capture = panel.chrome.tabs.captureVisibleTab;
  panel.chrome.tabs.captureVisibleTab = (...args) => {
    shots += 1;
    return capture(...args);
  };
  panel.click('mode-page');
  await panel.clock.advance(700);
  const taken = shots;
  assert.ok(taken >= 1 && panel.internals.state.pageShot);
  panel.chrome.tabs.query = async () => [{ id: 8, windowId: 1, url: 'https://other.test/', title: 'Other' }];
  await panel.internals.resolveTab();
  await panel.clock.advance(5000);
  assert.equal(shots, taken, 'a screenshot was taken after the switch');
  assert.equal(panel.banner(), 'The tab changed, so the page capture stopped. Nothing was filed.');
  assert.equal(panel.internals.state.items.length, 0);
});

test('a tab switch, an arm on the tab and a resized window each end the run and say so', async () => {
  const cases = [
    [
      'tab',
      async (panel) => {
        panel.chrome.tabs.query = async () => [{ id: 8, windowId: 1, url: 'https://other.test/', title: 'Other' }];
        await panel.internals.resolveTab();
      },
      'The tab changed, so the page capture stopped. Nothing was filed.',
    ],
    [
      'armed',
      async (panel) => panel.broadcast({ type: 'cdr:armed', mode: 'region', tabId: 7 }),
      'A capture mode was armed, so the page capture stopped. Nothing was filed.',
    ],
    [
      'resized',
      async (panel, page) => page.resize(1000, 720),
      'The tab changed size, so the page capture stopped. Nothing was filed.',
    ],
    // Another tab in view before the panel has heard of the switch: the
    // screenshot just taken would be of that tab.
    [
      'tab in view',
      async (panel) => {
        panel.chrome.tabs.query = async () => [{ id: 8, windowId: 1, url: 'https://other.test/', title: 'Other' }];
      },
      'The tab changed, so the page capture stopped. Nothing was filed.',
    ],
  ];
  for (const [name, act, said] of cases) {
    const { panel, page, calls } = await together({ page: { height: 4000, elements: [HEADER] } });
    page.root.scrollTop = 77;
    panel.click('mode-page');
    await panel.clock.advance(700);
    await act(panel, page);
    await panel.clock.advance(5000);
    assert.equal(panel.internals.state.items.length, 0, name);
    assert.equal(panel.banner(), said, name);
    assert.equal(calls.at(-1), 'end', name);
    assert.equal(page.root.scrollTop, 77, name);
  }
});

// Once every screenshot is in, the page is back as it was, and a tab switch
// or an arm has nothing left to spoil: the page is filed, and under the tab
// it was taken on, whatever tab is in view by the time it is.
test('a tab switch or an arm while the page is put together still files it, under the tab it was taken on', async () => {
  const other = { id: 8, windowId: 1, url: 'https://other.test/', title: 'Other' };
  for (const [name, act] of [
    [
      'tab',
      async (panel) => {
        panel.chrome.tabs.query = async () => [other];
        await panel.internals.resolveTab();
      },
    ],
    ['armed', async (panel) => panel.broadcast({ type: 'cdr:armed', mode: 'region', tabId: 7 })],
  ]) {
    const { panel } = await together({ page: { height: 2000 } });
    // The first canvas made while the page is put together is the moment.
    const make = panel.document.createElement;
    let acted = null;
    panel.document.createElement = (tag) => {
      if (tag === 'canvas' && !acted && panel.internals.state.pageShot?.composing) acted = act(panel);
      return make(tag);
    };
    panel.click('mode-page');
    await panel.clock.advance(10000);
    assert.ok(acted, `${name}: the page was never put together`);
    await acted;
    const { item } = filed(panel);
    assert.equal(item?.mode, 'page', name);
    assert.deepEqual([item.url, item.title, item.tabId], ['https://example.test/', 'Example', 7], name);
  }
});

test('the screenshots are taken at least 520 ms apart, while the page scrolls in between', async () => {
  const { panel } = await together({ page: { height: 3600 } });
  const at = [];
  for (let i = 0; i < 5; i += 1) panel.shots.next.push(async () => at.push(panel.clock.now));
  panel.click('mode-page');
  await panel.clock.advance(10000);
  assert.equal(at.length, 5);
  for (let i = 1; i < at.length; i += 1) assert.ok(at[i] - at[i - 1] >= 520, `${at[i] - at[i - 1]} ms apart`);
  assert.ok(at[4] - at[0] < 4 * 600, 'and not much more');
});

test('a page longer than the cap stops at 10 000 device pixels, at full resolution, and the item says so', async () => {
  const { panel, page, calls } = await together({ page: { height: 30000 } });
  panel.imageSizes.set('data:image/png;base64,AAAA', { width: 2560, height: 1440 });
  // Every canvas the panel makes, to find the thumbnail's.
  const realm = new panel.internals.handleBroadcast.constructor('return this')();
  const canvases = [];
  const make = realm.document.createElement;
  realm.document.createElement = (tag) => {
    const node = make(tag);
    if (tag === 'canvas') canvases.push(node);
    return node;
  };
  panel.click('mode-page');
  await panel.clock.advance(20000);
  assert.equal(calls.filter((call) => call === 'step').length, 7, '5000 CSS pixels at 2x is seven screens of 720');
  const { item } = filed(panel);
  assert.equal(item.width, 2560);
  assert.equal(item.height, 10000);
  assert.deepEqual({ ...item.stitched }, { screens: 7, cssWidth: 1280, cssHeight: 5000, cut: true });
  assert.match(panel.element('preview-meta').textContent, /PAGE · PNG 2560×10000 · CUT SHORT$/);
  assert.equal(
    panel.banner(),
    'The page is longer than a whole page capture covers, so this shows its first 5000 CSS pixels.'
  );
  assert.equal(
    panel.element('list').children[0].children[1].getAttribute('aria-label'),
    'Item 1, page, cut short, no description yet'
  );
  assert.equal(page.root.scrollTop, 0);
  // Its thumbnail is held to 1600 px tall, not the 800 of other captures.
  const thumb = canvases.find((canvas) => canvas.width && canvas.height && canvas !== filed(panel).saved.canvas);
  assert.deepEqual([thumb.width, thumb.height], [410, 1600]);
  // And the report hands the template how it was put together.
  const report = realm.assembleReport([item], { context: null, error: null });
  assert.deepEqual({ ...report.items[0].stitched }, { screens: 7, cssWidth: 1280, cssHeight: 5000, cut: true });
});

// In Chrome for Testing 156 a 30,000 px page read 0/34 until the first
// screenshot, though the cap let six be taken at 2x (begin's count knew
// nothing of the cap), and 6/7 after the last one (a screen was added for a
// next one the cap would not take). The same 6/7 showed on Wikipedia, MDN
// and GitHub.
test('the count says the screens a run cut at the cap takes, before the first screenshot and after the last', async () => {
  for (const [ratio, screens] of [
    [2, 7], // 5000 CSS pixels at 2x: seven screens of 720, a pixel short each
    [1, 14], // 10,000 at 1x
  ]) {
    const { panel, calls } = await together({ page: { height: 30000, ratio } });
    if (ratio === 2) panel.imageSizes.set('data:image/png;base64,AAAA', { width: 2560, height: 1440 });
    const seen = countsShown(panel);
    panel.click('mode-page');
    await panel.clock.advance(20000);
    assert.equal(calls.filter((call) => call === 'step').length, screens, `${ratio}x`);
    assert.deepEqual(
      seen,
      ['0/1', ...Array.from({ length: screens + 1 }, (_, taken) => `${taken}/${screens}`)],
      `${ratio}x`
    );
    assert.equal(filed(panel).item.stitched.screens, screens);
  }
});

test('the count ends on the screens taken when the page ends, or stops scrolling, before its estimate', async () => {
  // A page that reaches its end: the estimate was right all along. At 2159
  // the third screen ends a pixel short of it, which the page counts as its
  // end, so the estimate does too.
  for (const height of [2158, 2159]) {
    const plain = await together({ page: { height } });
    const seen = countsShown(plain.panel);
    plain.panel.click('mode-page');
    await plain.panel.clock.advance(10000);
    assert.deepEqual(seen, ['0/1', '0/3', '1/3', '2/3', '3/3'], `${height}`);
  }

  // One that will not scroll past 1000: at 0, 719, 1000 and 1000 again.
  const stuck = await together({ page: { height: 2000 } });
  const scroll = stuck.page.scroll;
  stuck.page.scroll = (target, options) => scroll(target, { ...options, top: Math.min(options.top, 1000) });
  const counts = countsShown(stuck.panel);
  stuck.panel.click('mode-page');
  await stuck.panel.clock.advance(10000);
  assert.equal(counts.at(-1), '4/4', counts.join(' '));
});

// A page that says it goes on but will not scroll there (a scroll handler
// that pulls it back, a height it reports and cannot reach). Without the
// stop it would be stepped in place up to 100 times, about 52 s.
test('a page that stops scrolling before its end is filed as far as it went, and says that, not that it was too long', async () => {
  const { panel, page, calls } = await together({ page: { height: 2000 } });
  page.root.scrollTop = 300;
  const scroll = page.scroll;
  page.scroll = (target, options) => scroll(target, { ...options, top: Math.min(options.top, 1000) });
  panel.click('mode-page');
  await panel.clock.advance(10000);
  // At 0, 719, 1000 and 1000 again, where it stops.
  assert.deepEqual(calls, ['inject', 'begin', 'step', 'step', 'step', 'step', 'end']);
  const { item } = filed(panel);
  assert.deepEqual({ ...item.stitched }, { screens: 4, cssWidth: 1280, cssHeight: 1720, cut: true });
  assert.equal(panel.banner(), 'The page would not scroll any further, so this shows its first 1720 CSS pixels.');
  assert.equal(page.root.scrollTop, 300);
});

test('a page that does not scroll is one screen, filed as Page with a notice', async () => {
  const { panel } = await together({ page: { height: 720, elements: [HEADER, BAR] } });
  panel.click('mode-page');
  await panel.clock.advance(5000);
  const { item } = filed(panel);
  assert.deepEqual({ ...item.stitched }, { screens: 1, cssWidth: 1280, cssHeight: 720 });
  assert.equal(panel.banner(), 'Nothing on this page scrolls, so this is the visible screen.');
});

test('a page that locked its scrolling is filed as the screen in view, unscrolled, and says why', async () => {
  const { panel, page, calls } = await together({
    page: { height: 5000, bodyOverflow: 'hidden', elements: [HEADER, BAR] },
  });
  page.root.scrollTop = 1200;
  panel.click('mode-page');
  await panel.clock.advance(5000);
  assert.deepEqual(calls, ['inject', 'begin', 'step', 'end']);
  const { item, saved } = filed(panel);
  assert.deepEqual({ ...item.stitched }, { screens: 1, cssWidth: 1280, cssHeight: 720 });
  assert.deepEqual(
    saved.canvas.context.calls.filter((call) => call.op === 'drawImage').map((call) => call.args.slice(1)),
    [[0, 0, 1280, 720, 0, 0, 1280, 720]]
  );
  assert.equal(panel.banner(), LOCKED);
  assert.deepEqual(page.scrolls, []);
  assert.equal(page.root.scrollTop, 1200);
});

// The notice names both causes unless the page looks moved by its own script,
// and then says that, not that a dialog is open.
test('a page that scrolls itself with a script is filed as the screen in view, and says that instead', async () => {
  const { panel, page, calls } = await together({
    page: { height: 3600, overflow: 'hidden', bodyOverflow: 'hidden', elements: [{ ...LOCO, rect: { ...LOCO.rect, width: 1280 } }] },
  });
  panel.click('mode-page');
  await panel.clock.advance(5000);
  assert.deepEqual(calls, ['inject', 'begin', 'step', 'end']);
  assert.deepEqual({ ...filed(panel).item.stitched }, { screens: 1, cssWidth: 1280, cssHeight: 720 });
  assert.equal(
    panel.banner(),
    'The page moves its content with a script instead of scrolling, which a whole page capture cannot follow, so this is the visible screen.'
  );
  assert.deepEqual(page.scrolls, []);

  // At its top the script has not moved it yet: the notice names both.
  const top = await together({
    page: { height: 3600, overflow: 'hidden', elements: [{ ...LOCO, transform: 'matrix(1, 0, 0, 1, 0, 0)' }] },
  });
  top.panel.click('mode-page');
  await top.panel.clock.advance(5000);
  assert.equal(top.panel.banner(), LOCKED);
});

// A page that changes height under the capture can leave a seam that does not
// line up, so the item says it may: one that grew while a screenshot was
// taken, and one whose script took a header out of the flow once scrolled,
// which happens inside the step, after its scroll and before it answers.
test('a page that changes height while a screenshot is taken, or during a step, is filed with a seam notice', async () => {
  const seam = 'The page changed height or moved while it was captured, so a seam in this screenshot may not line up.';
  for (const name of ['still', 'between', 'inside']) {
    const { panel, page } = await together({ page: { height: 2000 } });
    if (name === 'between') {
      const capture = panel.chrome.tabs.captureVisibleTab;
      let shots = 0;
      panel.chrome.tabs.captureVisibleTab = (...args) => {
        shots += 1;
        if (shots === 2) page.height = 2200;
        return capture(...args);
      };
    }
    if (name === 'inside') {
      const scroll = page.scroll;
      page.scroll = (target, options) => {
        scroll(target, options);
        if (target.scrollTop > 0) page.clock.setTimeout(() => (page.height = 1944), 16);
      };
    }
    panel.click('mode-page');
    await panel.clock.advance(10000);
    assert.equal(filed(panel).item?.mode, 'page', name);
    assert.equal(panel.banner(), name === 'still' ? null : seam, name);
  }
});

test('pinch zoom is refused before anything is captured', async () => {
  const { panel, calls } = await together({ page: { scale: 2 } });
  panel.click('mode-page');
  await panel.clock.advance(3000);
  assert.deepEqual(calls, ['inject', 'begin', 'end']);
  assert.equal(panel.internals.state.items.length, 0);
  assert.match(panel.banner(), /^Zoom back out to capture the whole page/);
});

test('an inner scroller is followed, and what is beside it is filled with the page background', async () => {
  const { panel } = await together({
    page: {
      height: 720,
      background: 'rgb(250, 250, 250)',
      elements: [{ id: 'pane', overflowY: 'auto', rect: { x: 280, y: 60, width: 1000, height: 600 }, scroll: { height: 1500, scrollbar: 0 } }],
    },
  });
  panel.click('mode-page');
  await panel.clock.advance(8000);
  const { item, saved } = filed(panel);
  assert.equal(item.height, 720 + 900);
  const calls = saved.canvas.context.calls;
  assert.deepEqual(calls.slice(0, 2), [
    { set: 'fillStyle', value: 'rgb(250, 250, 250)' },
    { op: 'fillRect', args: [0, 0, 1280, 1620] },
  ]);
  assert.deepEqual(
    calls.filter((call) => call.op === 'drawImage').map((call) => call.args.slice(1)),
    [
      [0, 0, 1280, 660, 0, 0, 1280, 660], // the first screen, down to the pane's bottom edge
      [0, 660, 1280, 60, 0, 1560, 1280, 60], // what was below the pane, moved down by 900
      [280, 60, 1000, 600, 280, 60, 1000, 600],
      [280, 60, 1000, 600, 280, 659, 1000, 600],
      [280, 60, 1000, 600, 280, 960, 1000, 600], // the last screen, clamped to the pane's end
    ]
  );
  assert.match(
    panel.banner(),
    /^The page scrolls inside one area, so only that area is shown in full, and what is beside it is from the first screen\.$/
  );
});
