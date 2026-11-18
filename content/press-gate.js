/**
 * ISOLATED world, declared at document_start beside the bridge: listeners on
 * window for the presses and keys the element picker keeps from the page,
 * added before any script of the page's own has run.
 *
 * Chrome runs the listeners of one target in the order they were added,
 * across worlds. The picker is injected only when Element is armed, so a
 * capture listener the page put on window before that ran first, and heard
 * every press that picked, and the keys, before the picker could keep them.
 * These run before any listener of the page's, and hand each event to the
 * picker (content/picker.js, route()) while it is armed or just after a pick.
 * Otherwise they do nothing at all: nothing is read, kept or sent.
 *
 * The types are the picker's: its CANCELLED and STOPPED lists, the three key
 * events, and selectstart. Touch listeners are passive, as the picker's are,
 * so that no page scrolls any later for them. Only the first copy of this
 * file in a page adds them.
 */
(() => {
  'use strict';

  try {
    if (window.__cdrPressGate) return;
    const gate = { hook: null };
    window.__cdrPressGate = gate;
    const TYPES = [
      'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick',
      'pointerdown', 'pointerup', 'pointercancel', 'contextmenu', 'touchstart', 'touchend',
      'gotpointercapture', 'lostpointercapture',
      'keydown', 'keypress', 'keyup', 'selectstart',
    ];
    const relay = (event) => {
      const hook = gate.hook;
      if (typeof hook !== 'function') return;
      try {
        hook(event);
      } catch {
        /* the picker's own listener hears it next */
      }
    };
    for (const type of TYPES) {
      window.addEventListener(type, relay, { capture: true, passive: type.startsWith('touch') });
    }
  } catch {
    /* no gate: the picker listens for itself, as on a tab open from before */
  }
})();
