/**
 * Region-select overlay, injected on demand by background.js.
 *
 * Injected with chrome.scripting.executeScript, which re-runs this whole file
 * every time. The controller is built once and cached on window; subsequent
 * injections only call start(). That keeps repeat captures cheap and avoids
 * stacking duplicate listeners.
 *
 * The file's last statement is that start(), whose value, the run it made, is
 * what the injection answers with. Every message the run sends carries it, so
 * the worker and the panel can tell a late message from an earlier run apart
 * from the arm that is live now.
 */
(() => {
  'use strict';

  function createController() {
    let host = null;
    let shadow = null;
    let root = null;
    let selection = null;
    let label = null;
    let hint = null;
    let active = false;
    let dragging = false;
    let keyed = false; // a selection made with the arrow keys is on screen
    let run = null; // this start()'s name, see the header
    let origin = { x: 0, y: 0 };
    let rect = { x: 0, y: 0, width: 0, height: 0 };
    let mountedIn = null; // the modal dialog the host was put in, see mount()
    let watching = false; // a frame is asked for, see watch()
    let watchedFrames = 0;
    let remounts = 0; // this arm's, see remount()
    let roots = []; // the page's open shadow roots, see collectRoots()
    let layerSeen = []; // the page's top layer when the host last went on top, see watch()

    const MIN_SIZE = 10; // px; smaller drags are treated as a misclick
    const KEY_STEP = 10; // px an arrow key moves or resizes by; Alt makes it 1
    const MODAL_CHECK_FRAMES = 15; // how often watch() looks for a new modal or popover
    const MAX_REMOUNTS = 100; // per arm, see remount()
    const ROOT_SCAN = 20000; // elements walked looking for open shadow roots, see collectRoots()

    function build() {
      host = document.createElement('div');
      host.setAttribute('data-cdr-overlay', '');
      // Max z-index, and reset anything the page's * selector might impose.
      // The last few undo a popover's own defaults (see mount): it is sized
      // to its content, centred, bordered and painted, and this host has to
      // cover the viewport and draw nothing itself.
      host.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:2147483647',
        'margin:0',
        'padding:0',
        'border:0',
        'width:auto',
        'height:auto',
        'max-width:none',
        'max-height:none',
        'overflow:visible',
        'background:transparent',
        'color:inherit',
      ].join(';');

      shadow = host.attachShadow({ mode: 'closed' });
      // touch-action: none, or a finger drag is taken by the browser as a pan
      // and ends in pointercancel instead of pointerup.
      shadow.innerHTML = `
        <style>
          :host { all: initial; }
          .root {
            position: fixed;
            inset: 0;
            cursor: crosshair;
            touch-action: none;
            background: rgba(10, 12, 16, 0.28);
          }
          .sel {
            position: fixed;
            border: 1px solid #d6157f;
            background: rgba(214, 21, 127, 0.08);
            box-shadow: 0 0 0 100vmax rgba(10, 12, 16, 0.28);
            display: none;
            pointer-events: none;
          }
          .label {
            position: fixed;
            font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
            color: #fff;
            background: #d6157f;
            padding: 4px 6px;
            border-radius: 3px;
            display: none;
            pointer-events: none;
            white-space: nowrap;
          }
          .hint {
            position: fixed;
            left: 50%;
            top: 20px;
            transform: translateX(-50%);
            font: 500 12px/1.3 ui-sans-serif, system-ui, -apple-system, sans-serif;
            color: #f5f5f4;
            background: rgba(20, 22, 28, 0.92);
            padding: 8px 14px;
            border-radius: 999px;
            pointer-events: none;
            box-shadow: 0 4px 16px rgba(0,0,0,0.35);
            white-space: nowrap;
          }
          .hint b { color: #f7a8cf; font-weight: 600; }
        </style>
        <div class="root">
          <div class="sel"></div>
          <div class="label"></div>
          <div class="hint">Drag to select a region, or use the arrow keys and <b>Enter</b> &nbsp;·&nbsp; <b>Esc</b> to cancel</div>
        </div>
      `;

      root = shadow.querySelector('.root');
      selection = shadow.querySelector('.sel');
      label = shadow.querySelector('.label');
      hint = shadow.querySelector('.hint');
    }

    /**
     * Put the host where the page cannot cover it or make it inert.
     *
     * A z-index does not lift anything above the top layer, where modal
     * dialogs, popovers and the fullscreen element live, and while a dialog
     * is open with showModal() everything outside it is inert: the overlay
     * drew under the dialog and no drag reached it. So the host goes inside
     * the topmost open modal dialog, which keeps it out of the inert part, and
     * is shown as a manual popover, which puts it in the top layer above
     * everything already there. The top layer is laid out against the
     * viewport whatever its ancestors do, so a transform or filter on the
     * page's body (or on the dialog) no longer turns position: fixed into
     * document coordinates that scroll away. Inside a fullscreen element it
     * does not go: that can be a video, whose children are never drawn. So
     * while an element of the page is fullscreen the overlay cannot be used:
     * Chrome draws a popover that is not inside the fullscreen element under
     * it, also one shown after it (seen in Chrome for Testing 156, armed
     * before and after the element went fullscreen).
     *
     * A browser without popovers, or a page that refuses one, gets the host
     * as it was before, on the body at the highest z-index.
     *
     * The page can move under it while it is armed: close or remove the
     * dialog it went into, open another, put something else in the top
     * layer after it, or take the host out of the document. watch() and the
     * listeners in start() put it back. `previous` is the modal it was in,
     * which it goes back into while that is still open and no other has
     * focus (see topModal()).
     *
     * A modal dialog in a closed shadow root cannot be found, nor can the
     * host be put inside it, so the overlay is inert under one.
     */
    function mount(previous = null) {
      collectRoots();
      mountedIn = topModal(previous);
      const parent = mountedIn || document.body || document.documentElement;
      if (typeof host.showPopover === 'function') {
        host.setAttribute('popover', 'manual');
        parent.appendChild(host);
        try {
          host.showPopover();
        } catch {
          // A host left with the attribute and not shown is display: none.
          host.removeAttribute('popover');
        }
      } else {
        host.removeAttribute('popover');
        parent.appendChild(host);
      }
      layerSeen = topLayerNow();
    }

    /**
     * The page's open shadow roots, where a component keeps its own dialog
     * or popover and where the document's queries do not look. Walked each
     * time the host is put somewhere, within a budget, as collector-main.js
     * bounds its own walk; a root attached after that is known from the
     * next move on.
     */
    function collectRoots() {
      const found = [];
      const pending = document.documentElement ? [document.documentElement] : [];
      let budget = ROOT_SCAN;
      while (pending.length && budget > 0) {
        const node = pending.pop();
        budget -= 1;
        const shadow = node.shadowRoot;
        if (shadow) {
          found.push(shadow);
          for (const child of shadow.children || []) pending.push(child);
        }
        for (const child of node.children || []) pending.push(child);
      }
      roots = found;
    }

    /** What matches `selector` in the document and in the open shadow roots known, the host aside. */
    function queryAll(selector) {
      const found = [];
      for (const scope of [document, ...roots]) {
        try {
          if (scope !== document && !scope.host.isConnected) continue;
          for (const node of scope.querySelectorAll(selector)) if (node !== host) found.push(node);
        } catch {
          /* a selector this browser does not know: nothing of that kind to work around */
        }
      }
      return found;
    }

    /**
     * What the page has in the top layer: its open popovers and modal
     * dialogs, in the document and in the open shadow roots known.
     */
    function topLayerNow() {
      return queryAll(':popover-open, dialog:modal');
    }

    function unmount() {
      try {
        if (host.matches(':popover-open')) host.hidePopover();
      } catch {
        /* removing it below takes it out of the top layer anyway */
      }
      host.removeAttribute('popover');
      if (host.parentNode) host.parentNode.removeChild(host);
      mountedIn = null;
    }

    /**
     * The topmost open modal dialog, or null. Focus cannot leave it, so the
     * modal around the focused element is the one, found also inside a
     * shadow root (picker.js does the same).
     *
     * With no focus to go by, `keep`, the modal the host is in, stays the
     * answer for as long as it is open. A modal opened after it took focus
     * as it opened, which focusin, its toggle and the frame loop all look
     * for, and the host has followed it there already.
     *
     * Otherwise, as when the page dropped the focus before the arm (a
     * framework that re-rendered the focused field), the open modals are
     * looked for in the document and in the open shadow roots known, and of
     * several the one on top is taken (see modalOnTop()). Going by document
     * order put the host into one underneath, or on the body under a shadow
     * root's modal, where it was inert. Where hit testing gives no answer,
     * the last found is taken: in the document, a dialog opened from inside
     * another is also inside it in the DOM.
     */
    function topModal(keep = null) {
      const focused = modalOfFocus();
      if (focused) return focused;
      if (keep && isModal(keep)) return keep;
      const open = queryAll('dialog:modal');
      if (open.length < 2) return open[0] || null;
      return modalOnTop(open) || open[open.length - 1];
    }

    /**
     * Of several open modal dialogs, the one opened last, which is the one
     * on top: everything outside it is inert, hit testing passes over what
     * is inert, and its ::backdrop covers the rest of the viewport and is
     * hit as the dialog (checked in Chrome for Testing 156). So the middle
     * of each is hit tested in turn, through open shadow roots, until a hit
     * is inside one of them, the innermost first. A hit on the host, which
     * is not inert where it is, says nothing.
     */
    function modalOnTop(open) {
      for (const dialog of open) {
        try {
          const box = dialog.getBoundingClientRect();
          const x = box.left + box.width / 2;
          const y = box.top + box.height / 2;
          let node = document.elementFromPoint(x, y);
          for (let depth = 0; node && node.shadowRoot && depth < 32; depth += 1) {
            const inner = node.shadowRoot.elementFromPoint(x, y);
            if (!inner || inner === node) break;
            node = inner;
          }
          for (let depth = 0; node && node !== host && depth < 256; depth += 1) {
            if (open.includes(node)) return node;
            node = composedParent(node);
          }
        } catch {
          /* no hit testing here: the order found decides */
        }
      }
      return null;
    }

    function modalOfFocus() {
      try {
        let node = document.activeElement;
        while (node && node.shadowRoot && node.shadowRoot.activeElement) node = node.shadowRoot.activeElement;
        for (let depth = 0; node && node.nodeType === 1 && depth < 256; depth += 1) {
          if (isModal(node)) return node;
          node = composedParent(node);
        }
      } catch {
        /* a page in an odd state: the query in topModal() still looks */
      }
      return null;
    }

    /**
     * The node's parent as the page is drawn. A node slotted from the light
     * DOM is drawn in its slot, in the shadow tree of the element it is a
     * child of: a component's own <dialog> wraps the content the page hands
     * it that way (md-dialog does), and the focus is on that content.
     */
    function composedParent(node) {
      return node.assignedSlot || node.parentElement || shadowHostOf(node);
    }

    function shadowHostOf(node) {
      const root = typeof node.getRootNode === 'function' ? node.getRootNode() : null;
      return root && root !== document && root.host ? root.host : null;
    }

    function isModal(node) {
      try {
        return node.matches('dialog:modal');
      } catch {
        return false;
      }
    }

    /**
     * Whether the host is no longer where it can be seen and used: out of the
     * document, inside a dialog that has closed (where it is drawn at no
     * size), or a popover the page has hidden. With `modals`, also when a
     * modal dialog other than the one it is in is on top, which makes it
     * inert.
     */
    function misplaced(modals) {
      if (!host.isConnected) return true;
      if (mountedIn && !isModal(mountedIn)) return true;
      try {
        if (host.hasAttribute('popover') && !host.matches(':popover-open')) return true;
      } catch {
        /* no popovers here, and so none hidden */
      }
      return Boolean(modals) && topModal(mountedIn) !== mountedIn;
    }

    /**
     * Take the host out and put it where mount() would now. A drag under way
     * loses its pointer with the move, so it starts again. Bounded per arm,
     * for a page that takes out of its document whatever it did not put
     * there: with nothing to stop it, the two would trade the host back and
     * forth every frame. 0.5.0 lost the overlay on such a page, as this does
     * once the bound is reached.
     */
    function remount() {
      if (remounts >= MAX_REMOUNTS) return;
      remounts += 1;
      if (dragging) clear();
      const previous = mountedIn;
      unmount();
      mount(previous);
    }

    /**
     * Put the host last in the top layer again, where it is above whatever
     * the page has put there since it was shown: a popover the page shows
     * while armed (a toast) is drawn over the overlay, and a drag that
     * starts on it goes to the page. Hidden and shown again, a popover goes
     * to the end of the top layer, and stays where it is in the document.
     * Counted with the remounts, for a page that answers by raising its own.
     */
    function raise() {
      if (remounts >= MAX_REMOUNTS) return;
      try {
        if (!host.matches(':popover-open')) return;
        remounts += 1;
        host.hidePopover();
        host.showPopover();
        layerSeen = topLayerNow();
      } catch {
        /* the next frame finds a host that is not shown, and puts it back */
      }
    }

    /**
     * Every frame while armed: put the host back if the page has moved
     * under it (see misplaced()). Closing or removing a dialog sends nothing
     * from inside a shadow root, and removing one sends nothing at all, so
     * the listeners in start() are not enough on their own. A new modal is
     * looked for every few frames only, since that queries the document,
     * and so is something the page put in the top layer since the host went
     * on top: a popover in a shadow root sends its toggle no further than
     * its root, and is drawn over the overlay until the host is raised
     * (picker.js looks the same way). A tab in the background runs no
     * frames, and draws nothing either.
     */
    function watch() {
      // A reload of the extension leaves this script running with no id,
      // and nothing it sends arrives: the arm ends here (picker.js too).
      try {
        if (active && !chrome.runtime?.id) stop();
      } catch {
        stop();
      }
      if (!active) {
        watching = false;
        return;
      }
      try {
        const look = watchedFrames % MODAL_CHECK_FRAMES === 0;
        if (misplaced(look)) remount();
        else if (look) {
          const layer = topLayerNow();
          if (layer.some((node) => !layerSeen.includes(node))) raise();
          else layerSeen = layer;
        }
      } catch {
        /* a page in an odd state must not stop the loop */
      }
      watchedFrames += 1;
      requestAnimationFrame(watch);
    }

    /**
     * A dialog opened, closed or took focus, or a popover came or went:
     * straight away rather than at the next look from watch(). Focus moves
     * into a modal dialog as it opens, also inside a shadow root, and the
     * focusin reaches the window from there; a dialog's toggle and close, and
     * a popover's toggle, do from the light DOM only. A popover the page
     * showed after the host is above it, so the host is raised over it.
     */
    function onTopLayer(event) {
      if (!active || (event && event.target === host)) return;
      if (misplaced(true)) remount();
      else if (event && event.type === 'toggle' && event.newState === 'open') raise();
    }

    /**
     * Turn two drag corners into a viewport rect.
     *
     * Both edges are clamped before the size is derived. Clamping only the
     * origin and keeping the raw drag delta would widen the selection: pointer
     * capture keeps delivering negative coordinates once the cursor leaves the
     * window, so dragging left past the edge from x=500 would report a 550px
     * wide region starting at 0, capturing 50px the user never selected.
     */
    function normalize(ax, ay, bx, by) {
      const left = Math.max(0, Math.min(ax, bx));
      const top = Math.max(0, Math.min(ay, by));
      const right = Math.min(window.innerWidth, Math.max(ax, bx));
      const bottom = Math.min(window.innerHeight, Math.max(ay, by));
      return {
        x: left,
        y: top,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
      };
    }

    function paint() {
      selection.style.display = 'block';
      selection.style.left = rect.x + 'px';
      selection.style.top = rect.y + 'px';
      selection.style.width = rect.width + 'px';
      selection.style.height = rect.height + 'px';

      label.style.display = 'block';
      label.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
      // Keep the readout inside the viewport: below the selection normally,
      // above it when the selection runs off the bottom edge.
      const below = rect.y + rect.height + 6;
      label.style.top = (below + 20 > window.innerHeight ? rect.y - 24 : below) + 'px';
      label.style.left = Math.min(rect.x, window.innerWidth - 90) + 'px';
    }

    /** Back to the armed state with nothing selected, as on arrival. */
    function clear() {
      dragging = false;
      keyed = false;
      selection.style.display = 'none';
      label.style.display = 'none';
      hint.style.display = 'block';
    }

    /**
     * Kept from the page. The host is inside the page's tree, and inside a
     * modal dialog when one is open, so a drag's pointer, mouse and click
     * events would otherwise bubble out to the page's own handlers: a dialog
     * that closes on a click outside its box would close under the drag, and
     * a menu that closes on any click would close before the screenshot.
     */
    function swallow(event) {
      event.stopPropagation();
    }

    function onPointerDown(event) {
      swallow(event);
      if (event.button !== 0) return;
      event.preventDefault();
      dragging = true;
      keyed = false;
      hint.style.display = 'none';
      origin = { x: event.clientX, y: event.clientY };
      rect = { x: origin.x, y: origin.y, width: 0, height: 0 };
      try {
        event.target.setPointerCapture(event.pointerId);
      } catch {
        /* not fatal: without capture the drag ends if it leaves the overlay */
      }
    }

    function onPointerMove(event) {
      swallow(event);
      if (!dragging) return;
      event.preventDefault();
      rect = normalize(origin.x, origin.y, event.clientX, event.clientY);
      paint();
    }

    function onPointerUp(event) {
      swallow(event);
      if (!dragging) return;
      event.preventDefault();
      dragging = false;
      rect = normalize(origin.x, origin.y, event.clientX, event.clientY);

      if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) {
        // Treat as a misclick and stay armed rather than silently capturing a
        // sliver or tearing down the overlay the user still wants.
        clear();
        return;
      }

      finish();
    }

    /**
     * The browser took the pointer away: a touch it decided was a pan, a
     * system gesture, a pointer capture lost to the page. No pointerup follows
     * for this drag, so without this `dragging` stayed on, the box followed a
     * hovering mouse with no button held, and the next stray pointerup sent a
     * capture from the stale origin. lostpointercapture also comes after an
     * ordinary pointerup, when the drag is already over and this does nothing.
     */
    function onPointerCancel(event) {
      swallow(event);
      if (!dragging) return;
      clear();
    }

    /** The visible part of the page, where a keyboard selection starts. */
    function visibleArea() {
      const vv = window.visualViewport;
      if (vv && vv.width > 0 && vv.height > 0) {
        return { x: vv.offsetLeft, y: vv.offsetTop, width: vv.width, height: vv.height };
      }
      return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
    }

    const ARROWS = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };

    /**
     * Region capture without a pointer. The first arrow key puts a selection
     * of half the visible area in its middle; arrows move it, Shift with an
     * arrow moves its right or bottom edge, Alt makes each step one pixel, and
     * Enter captures it. Heard on the page's window, so it needs the page to
     * have focus: the shortcut leaves it there, and from the panel a click on
     * the page (which a drag shorter than MIN_SIZE ignores) or F6 moves it.
     */
    function onArrow(event, [dx, dy]) {
      const step = event.altKey ? 1 : KEY_STEP;
      const maxW = window.innerWidth;
      const maxH = window.innerHeight;
      if (!keyed) {
        const area = visibleArea();
        keyed = true;
        hint.style.display = 'none';
        rect = {
          x: Math.round(area.x + area.width / 4),
          y: Math.round(area.y + area.height / 4),
          width: Math.max(MIN_SIZE, Math.round(area.width / 2)),
          height: Math.max(MIN_SIZE, Math.round(area.height / 2)),
        };
      } else if (event.shiftKey) {
        rect.width = Math.min(maxW - rect.x, Math.max(MIN_SIZE, rect.width + dx * step));
        rect.height = Math.min(maxH - rect.y, Math.max(MIN_SIZE, rect.height + dy * step));
      } else {
        rect.x = Math.min(maxW - rect.width, Math.max(0, rect.x + dx * step));
        rect.y = Math.min(maxH - rect.height, Math.max(0, rect.y + dy * step));
      }
      paint();
    }

    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        stop();
        send({ type: 'cdr:capture-cancelled', mode: 'region' });
        return;
      }
      if (event.isComposing || event.metaKey || event.ctrlKey) return;
      if (key(event.key, event)) {
        // Kept from the page, which would scroll under the selection, or
        // act on an Enter that took the selection.
        event.preventDefault();
        event.stopPropagation();
      }
    }

    /**
     * An arrow moves the selection (with Shift, resizes it; with Alt, by one
     * pixel) and Enter takes it. From the page's own keydown, and from the
     * panel, which keeps the keyboard when Region is armed from it and hands
     * these keys on. Answers whether the key was used: Enter with nothing
     * selected is the page's, as every other key is.
     */
    function key(name, { shiftKey = false, altKey = false } = {}) {
      if (!active || dragging) return false;
      const arrow = ARROWS[name];
      if (arrow) {
        onArrow({ shiftKey, altKey }, arrow);
        return true;
      }
      if (name === 'Enter' && keyed) {
        finish();
        return true;
      }
      return false;
    }

    function send(message) {
      try {
        // Promise form: if the side panel is closed there is no receiver, and
        // the callback form would log "Could not establish connection".
        chrome.runtime.sendMessage({ run, ...message }).catch(() => {});
      } catch {
        /* extension context invalidated (reloaded mid-session) */
      }
    }

    /**
     * The viewport the rect is measured in, the layout viewport, and the
     * visual viewport within it. A screenshot shows the visual one: under
     * pinch zoom that is a magnified part of the layout viewport, and the
     * panel needs its offset and scale to find the rect in the picture.
     */
    function viewportNow() {
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const vv = window.visualViewport;
      if (vv) {
        viewport.visual = {
          x: vv.offsetLeft,
          y: vv.offsetTop,
          width: vv.width,
          height: vv.height,
          scale: vv.scale,
        };
      }
      return viewport;
    }

    function finish() {
      const captured = { ...rect };
      const viewport = viewportNow();
      // This run's name, read now: the shortcut can start a new run in the
      // two frames below, and the message is about this one.
      const finished = run;

      stop();

      // The overlay must be gone from the rendered frame before the screenshot
      // is taken, and removing it from the DOM only queues that change. Two
      // frames guarantees a paint has actually landed.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          send({ type: 'cdr:region-selected', rect: captured, viewport, run: finished });
        });
      });
    }

    const POINTER = [
      ['pointerdown', onPointerDown],
      ['pointermove', onPointerMove],
      ['pointerup', onPointerUp],
      ['pointercancel', onPointerCancel],
      ['lostpointercapture', onPointerCancel],
      ['click', swallow],
      ['dblclick', swallow],
      ['mousedown', swallow],
      ['mouseup', swallow],
      ['contextmenu', swallow],
    ];

    // See onTopLayer().
    const TOP_LAYER = ['focusin', 'toggle', 'close'];

    function start() {
      if (active) {
        // Armed again while armed: the shortcut, most likely pressed because
        // the overlay is not to be seen. The arm stands, and the host goes
        // back where it can be, or above what covers it, past the bound on
        // remount() too, since the user asked.
        remounts = 0;
        if (misplaced(true)) remount();
        else raise();
        return run;
      }
      // The two capture modes are mutually exclusive. Arming this one while the
      // picker is running would leave both sets of listeners fighting over the
      // same clicks, so the other is always torn down first.
      try {
        window.__cdrElementPicker?.stop();
      } catch {
        /* ignore */
      }
      if (!host) build();
      active = true;
      run = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      clear();

      remounts = 0;
      mount();

      for (const [type, listener] of POINTER) root.addEventListener(type, listener);
      window.addEventListener('keydown', onKeyDown, true);
      for (const type of TOP_LAYER) window.addEventListener(type, onTopLayer, true);
      // A page kept in the back/forward cache would come back with the overlay
      // live and nothing outside the page aware of it.
      window.addEventListener('pagehide', stop);
      watchedFrames = 0;
      if (!watching) {
        watching = true;
        requestAnimationFrame(watch);
      }
      return run;
    }

    function stop() {
      if (!active) return;
      active = false;
      dragging = false;
      keyed = false;
      for (const [type, listener] of POINTER) root.removeEventListener(type, listener);
      window.removeEventListener('keydown', onKeyDown, true);
      for (const type of TOP_LAYER) window.removeEventListener(type, onTopLayer, true);
      window.removeEventListener('pagehide', stop);
      unmount();
    }

    // isActive is how the worker asks whether the overlay survived a change of
    // URL: Chrome reports pushState and a hash change as loading, too.
    return { start, stop, isActive: () => active, key };
  }

  if (!window.__cdrRegionOverlay) {
    window.__cdrRegionOverlay = createController();
  }
  return window.__cdrRegionOverlay.start();
})();
