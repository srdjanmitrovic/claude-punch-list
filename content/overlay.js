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
    let mountedIn = null; // the modal dialog or fullscreen element the host was put in, see mount()
    let inFullscreen = false; // the host is inside the element shown fullscreen, see mount() and HOVER
    let moved = false; // putting the host there moved the fullscreen element's children, see mount()
    let barren = null; // a fullscreen element the host got no box in, see mount()
    let watching = false; // a frame is asked for, see watch()
    let watchedFrames = 0;
    let walkedAt = -Infinity; // when watch() last walked for shadow roots, see watch()
    let remounts = 0; // this arm's, see remount()
    let roots = []; // the page's shadow roots, see collectRoots()
    let layerRoots = []; // those of them that hold a popover or a dialog, see queryAll()
    let changed = true; // the page's tree may have changed since the last walk, see watchChanges()
    let observer = null; // see watchChanges()
    let asked = new WeakMap(); // custom element -> its closed shadow root or null, this arm, see closedRootOf()
    let layerSeen = []; // the page's top layer when the host last went on top, see watch()

    const MIN_SIZE = 10; // px; smaller drags are treated as a misclick
    const KEY_STEP = 10; // px an arrow key moves or resizes by; Alt makes it 1
    const MODAL_CHECK_FRAMES = 15; // how often watch() looks for a new modal, popover or fullscreen element
    const ROOT_WALK_MS = 1000; // the least time between two of watch()'s walks for shadow roots, at any frame rate
    const MAX_REMOUNTS = 100; // per arm, see remount()
    const ROOT_SCAN = 20000; // elements walked looking for shadow roots, half from each end, see collectRoots()
    const MOVED_CHECK = 64; // children of the fullscreen element measured, see childBoxes()
    const HTML_NS = 'http://www.w3.org/1999/xhtml';
    // Elements that draw no children of theirs, or whose children are what
    // they show or load: the host never goes inside one (see fullscreenHolder()).
    const NO_HOST = new Set([
      'audio', 'canvas', 'embed', 'fencedframe', 'frame', 'iframe', 'img', 'input', 'object',
      'optgroup', 'option', 'script', 'select', 'style', 'template', 'textarea', 'video',
    ]);

    function build() {
      host = document.createElement('div');
      host.setAttribute('data-cdr-overlay', '');
      // Max z-index, and reset anything the page's * selector might impose,
      // which in a fullscreen component's shadow root (see mount) beats the
      // :host rule below: a `* { pointer-events: none }` there left the
      // overlay drawn but passed through. Not display, which would override
      // the rule that hides a popover not shown.
      // The last few undo a popover's own defaults (see mount): it is sized
      // to its content, centred, bordered and painted, and this host has to
      // cover the viewport and draw nothing itself.
      host.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:2147483647',
        'pointer-events:auto',
        'visibility:visible',
        'opacity:1',
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
     * document coordinates that scroll away.
     *
     * An element shown fullscreen does what a modal dialog does: everything
     * outside it is inert. The host, shown after it, was drawn above it and
     * passed over by every press, which went to the page (seen in Chrome for
     * Testing 156). So with no modal dialog open the host goes inside the
     * fullscreen element, unless that holds the body already, and into its
     * own shadow root when it has one, open or closed: there the element's
     * light children, its slots and its own `:last-child` rules never see
     * the host, and a component with no slot draws it all the same. Without
     * a shadow root the host is its last child, and a `:last-child` rule of
     * the page's can move the other children while armed: that is measured
     * (see childBoxes()), in a shadow root too, and said with the capture.
     *
     * An element that draws no children, or whose children are what it
     * shows or loads (a video, a canvas, a frame, an <object>, whose
     * document Chrome loads again when a child is added), is never touched:
     * the host stays on the body, drawn above it and inert, and the overlay
     * cannot be used until the page leaves fullscreen. Any other element
     * the host gets no box in is found by asking (see drawn()), and is
     * treated the same until it goes fullscreen again or the shortcut is
     * pressed again.
     *
     * A browser without popovers, or a page that refuses one, gets the host
     * as it was before, on the body at the highest z-index.
     *
     * The page can move under it while it is armed: close or remove the
     * dialog it went into, open another, go fullscreen or leave it, put
     * something else in the top layer after it, or take the host out of the
     * document. watch() and the listeners in start() put it back.
     * `previous` is the modal it was in, which it goes back into while that
     * is still open and no other has focus (see topModal()).
     *
     * A modal dialog in a closed shadow root is found and the host put
     * inside it as in an open one, through the extension's own way into a
     * closed root (see shadowOf()).
     */
    function mount(previous = null) {
      collectRoots();
      const modal = topModal(previous);
      const full = modal ? null : fullscreenHolder();
      mountedIn = modal || full;
      if (full) {
        const own = shadowOf(full);
        const before = childBoxes(own || full);
        place(own || full);
        if (!drawn()) {
          barren = full;
          unmount();
          place(document.body || document.documentElement);
        } else {
          moved = movedSince(before);
        }
      } else {
        place(modal || document.body || document.documentElement);
      }
      const holder = modal ? fullscreenHolder() : full;
      inFullscreen = Boolean(holder) && host.isConnected && inside(holder, host);
      layerSeen = topLayerNow();
    }

    /** Whether `node` is `ancestor` or drawn inside it, through slots and shadow roots. */
    function inside(ancestor, node) {
      for (let at = node, depth = 0; at && depth < 256; at = composedParent(at), depth += 1) {
        if (at === ancestor) return true;
      }
      return false;
    }

    /**
     * Where the last children of `parent` are drawn, to tell whether the
     * host, put in after them, moved them: a rule on `:last-child` (as
     * Tailwind's space-y writes) stops matching the child that was last,
     * and a slide laid out around it shifts while armed. The screenshot is
     * taken once the host is gone and the page has moved back, so the crop
     * is then not what was selected, and the capture says so. Reading the
     * boxes forces a layout, as drawn() does next.
     */
    function childBoxes(parent) {
      const boxes = [];
      try {
        const children = parent.children;
        for (let i = children.length - 1; i >= 0 && boxes.length < MOVED_CHECK; i -= 1) {
          const node = children[i];
          const box = node.getBoundingClientRect();
          boxes.push([node, box.left, box.top, box.width, box.height]);
        }
      } catch {
        /* nothing to compare: nothing said */
      }
      return boxes;
    }

    function movedSince(before) {
      try {
        return before.some(([node, left, top, width, height]) => {
          const box = node.getBoundingClientRect();
          return (
            Math.abs(box.left - left) > 0.5 ||
            Math.abs(box.top - top) > 0.5 ||
            Math.abs(box.width - width) > 0.5 ||
            Math.abs(box.height - height) > 0.5
          );
        });
      } catch {
        return false;
      }
    }

    function place(parent) {
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
    }

    /**
     * Whether the host got a box where it was put. It forces a layout, so it
     * is asked only of a fullscreen element (see mount()).
     */
    function drawn() {
      try {
        return host.getClientRects().length > 0;
      } catch {
        return true;
      }
    }

    /**
     * The page's shadow roots, where a component keeps its own dialog or
     * popover and where the document's queries do not look. Walked each
     * time the host is put somewhere, and by watch() when the page has
     * changed since (see watchChanges()), at most once a second, so a root
     * attached while armed is found at the next look or within a second.
     *
     * Within a budget, as collector-main.js bounds its own walk: half of it
     * from the start of the page and half from its end, each shadow tree
     * walked where its host stands, so a page larger than the budget still
     * has both its first and its last elements walked. Toast stacks and
     * dialog portals are put at the end of the body, and a component near
     * the top is as likely as one at the end. A tree walker takes about
     * 1.4 ms over 20 000 elements in Chrome for Testing 156, closed roots
     * included, where reading each element's children for open roots took
     * 8 ms.
     */
    function collectRoots() {
      const found = [];
      const half = ROOT_SCAN / 2;
      let budget = half;
      let last = null; // the last element the walk from the start reached
      let whole = false;
      const ahead = [document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT)];
      while (budget > 0) {
        const node = ahead[ahead.length - 1].nextNode();
        if (!node) {
          ahead.pop(); // a shadow tree walked: on to its host's own children
          if (ahead.length) continue;
          whole = true;
          break;
        }
        budget -= 1;
        last = node;
        const shadow = node.shadowRoot || closedRootOf(node);
        if (shadow) {
          found.push(shadow);
          ahead.push(document.createTreeWalker(shadow, NodeFilter.SHOW_ELEMENT));
        }
      }
      if (!whole) {
        // From the end back, the same order reversed: a host's children,
        // then its shadow tree, then the host, until the two walks meet.
        budget += half;
        const known = new Set(found);
        const behind = [];
        const back = [];
        const enter = (scope) => {
          const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
          let node = null;
          for (let deeper = walker.lastChild(); deeper; deeper = walker.lastChild()) node = deeper;
          back.push({ walker, node, entered: false });
        };
        enter(document);
        while (back.length && budget > 0) {
          const at = back[back.length - 1];
          if (!at.node) {
            back.pop();
            continue;
          }
          const shadow = at.entered ? null : at.node.shadowRoot || closedRootOf(at.node);
          if (shadow) {
            at.entered = true;
            if (!known.has(shadow)) behind.push(shadow);
            enter(shadow);
            continue;
          }
          if (at.node === last) break;
          budget -= 1;
          at.node = at.walker.previousNode();
          at.entered = false;
        }
        found.push(...behind.reverse());
      }
      roots = found;
      layerRoots = found.filter(holdsLayer);
      watchChanges();
    }

    /**
     * Whether a shadow root has anything that can go in the top layer. Only
     * a popover can be shown as one and only a dialog opened as a modal, so
     * a root with neither is not queried at each look until a walk finds
     * one in it (see queryAll()). A component library's buttons and
     * icons are most of a page's roots, and querying each cost about 0.6 µs
     * a look.
     */
    function holdsLayer(shadow) {
      try {
        return Boolean(shadow.querySelector('[popover], dialog'));
      } catch {
        return true;
      }
    }

    /**
     * Notes any change to the page's tree, in the document and in each
     * shadow root walked, or to an element's popover attribute, so that
     * watch() walks again only when something has changed (a root walked as
     * holding no popover may have been given one). A MutationObserver costs
     * nothing until a change, and is let go at the first, so a page that
     * changes all the time pays for one batch of records a walk. The host's
     * own moves are not changes.
     * Shadow roots attached to an element already in the page (a component
     * defined after the arm) change no tree, and are found by the next walk
     * something else brings, the next placement or the shortcut.
     */
    function watchChanges() {
      changed = true;
      try {
        if (!observer) observer = new MutationObserver(onChange);
        observer.disconnect();
        const options = { childList: true, subtree: true, attributes: true, attributeFilter: ['popover'] };
        observer.observe(document, options);
        for (const shadow of roots) observer.observe(shadow, options);
        changed = false;
      } catch {
        /* no observer here: watch() walks at every chance it has */
      }
    }

    function onChange(records) {
      if (!records.some(byPage)) return;
      changed = true;
      try {
        observer.disconnect();
      } catch {
        /* it stays connected, and tells again */
      }
    }

    function byPage(record) {
      if (record.target === host) return false; // its popover attribute
      if (record.type !== 'childList') return true;
      for (const node of record.addedNodes) if (node !== host) return true;
      for (const node of record.removedNodes) if (node !== host) return true;
      return false;
    }

    /**
     * The node's shadow root, open or closed. A closed one answers null to
     * shadowRoot, and only an extension can ask for it, which takes about
     * half a microsecond and throws for anything but an HTML element. A
     * user agent's own root (a video's controls) is answered with null.
     */
    function shadowOf(node) {
      if (node.shadowRoot) return node.shadowRoot;
      try {
        return chrome.dom.openOrClosedShadowRoot(node) || null;
      } catch {
        return null;
      }
    }

    /**
     * A custom element's closed shadow root, asked for once an arm. Asking
     * every element of the walk took 15 ms over 20 000 elements, and a
     * closed root is a component's. One attached after the element was
     * asked is not seen until the next arm.
     */
    function closedRootOf(node) {
      const name = node.localName; // none on the shadow root a walk starts at
      if (!name || !name.includes('-')) return null;
      if (!asked.has(node)) asked.set(node, shadowOf(node));
      return asked.get(node);
    }

    /** The element shown fullscreen, the innermost through shadow roots, or null. */
    function fullscreenNow() {
      try {
        let node = document.fullscreenElement || null;
        for (let depth = 0; node && depth < 32; depth += 1) {
          const shadow = shadowOf(node);
          const inner = shadow && shadow.fullscreenElement;
          if (!inner || inner === node) break;
          node = inner;
        }
        return node;
      } catch {
        return null;
      }
    }

    /**
     * The fullscreen element, when the host has to go inside it: not when
     * it holds the body (the whole page shown fullscreen), where the host
     * is not inert, not one that draws no children or whose children are
     * its content (NO_HOST, and anything outside the HTML namespace, such
     * as an <svg>), decided before the page's tree is touched, and not one
     * the host got no box in (see mount()).
     */
    function fullscreenHolder() {
      const full = fullscreenNow();
      if (!full || full === barren) return null;
      if (full.namespaceURI !== HTML_NS || NO_HOST.has(full.localName)) return null;
      try {
        if (document.body && full.contains(document.body)) return null;
      } catch {
        /* a page in an odd state: try it */
      }
      return full;
    }

    /** Whether what the host was put in still keeps the rest of the page inert. */
    function holds(node) {
      return isModal(node) || node === fullscreenNow();
    }

    /**
     * What matches `selector` in the document and in the shadow roots known,
     * the host aside. Of the roots, only those that held a popover or a
     * dialog when walked (see holdsLayer()). A root given its first one
     * later is queried from the next walk on, which that change brings
     * within a second and a look. Querying every root once anything had
     * changed cost a page that changes all the time ten times 0.6.0 on 6000
     * closed roots.
     */
    function queryAll(selector) {
      const found = [];
      for (const scope of [document, ...layerRoots]) {
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
     * dialogs, in the document and in the shadow roots known, and the
     * element shown fullscreen, so that one put fullscreen after the host
     * went on top (the body, which the host stays in) is seen as new.
     */
    function topLayerNow() {
      const layer = queryAll(':popover-open, dialog:modal');
      const full = fullscreenNow();
      if (full && !layer.includes(full)) layer.push(full);
      return layer;
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
      inFullscreen = false;
      moved = false;
    }

    /**
     * The topmost open modal dialog, or null. Focus cannot leave it, so the
     * modal around the focused element is the one, found also inside a
     * shadow root, open (picker.js does the same) or closed.
     *
     * With no focus to go by, `keep`, the modal the host is in, stays the
     * answer for as long as it is open. A modal opened after it took focus
     * as it opened, which focusin, its toggle and the frame loop all look
     * for, and the host has followed it there already.
     *
     * Otherwise, as when the page dropped the focus before the arm (a
     * framework that re-rendered the focused field), the open modals are
     * looked for in the document and in the shadow roots known, and of
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
     * of each is hit tested in turn, through shadow roots, until a hit
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
          for (let depth = 0; node && node !== host && depth < 32; depth += 1) {
            const shadow = shadowOf(node);
            const inner = shadow && shadow.elementFromPoint(x, y);
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
        for (let depth = 0; node && depth < 32; depth += 1) {
          const shadow = shadowOf(node);
          if (!shadow || !shadow.activeElement) break;
          node = shadow.activeElement;
        }
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
     * size) or an element no longer fullscreen, or a popover the page has
     * hidden. With `modals`, also when a modal dialog other than the one it
     * is in is on top, or an element went fullscreen, which makes it inert.
     */
    function misplaced(modals) {
      if (!host.isConnected) return true;
      if (mountedIn && !holds(mountedIn)) return true;
      try {
        if (host.hasAttribute('popover') && !host.matches(':popover-open')) return true;
      } catch {
        /* no popovers here, and so none hidden */
      }
      return Boolean(modals) && (topModal(mountedIn) || fullscreenHolder()) !== mountedIn;
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
     * (picker.js looks the same way). The shadow roots are walked again at
     * a look only when the page has changed, and at most once a second (see
     * collectRoots()). A tab in the background runs no frames, and draws
     * nothing either.
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
        if (look && changed && watchedFrames > 0 && performance.now() - walkedAt >= ROOT_WALK_MS) {
          walkedAt = performance.now();
          collectRoots();
        }
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
     * A dialog opened, closed or took focus, a popover came or went, or an
     * element went fullscreen or left it: straight away rather than at the
     * next look from watch(). Focus moves into a modal dialog as it opens,
     * also inside a shadow root, and the focusin reaches the window from
     * there, as fullscreenchange does; a dialog's toggle and close, and a
     * popover's toggle, do from the light DOM only. A popover the page
     * showed after the host is above it, so the host is raised over it, and
     * so is an element put fullscreen that the host stays outside of, or in
     * (the body). A fullscreen element the host got no box in is tried
     * again once fullscreen changes: it may have been hidden only then.
     */
    function onTopLayer(event) {
      if (!active || (event && event.target === host)) return;
      const fullscreen = Boolean(event) && event.type === 'fullscreenchange';
      if (fullscreen) barren = null;
      if (misplaced(true)) remount();
      else if (fullscreen || (event && event.type === 'toggle' && event.newState === 'open')) raise();
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

    /**
     * A click is cancelled as well. Inside the element shown fullscreen the
     * host has the page's elements around it, and a link, a label, a button
     * or a <summary> among them acted on a click only stopped here: the link
     * was followed, the checkbox toggled, the form submitted, and the page's
     * own handler that would have prevented it was never reached.
     */
    function cancel(event) {
      event.stopPropagation();
      event.preventDefault();
    }

    /**
     * Kept from the page too while the host is inside the element shown
     * fullscreen: a player's box that shows its controls on a mouse move,
     * or changes the slide on a wheel, would otherwise do so under the
     * selection, and the controls be in the screenshot. On the body or in
     * a modal dialog these reach the page as they did before. pointerenter
     * and mouseenter go to each element the pointer enters on its own, and
     * cannot be stopped here.
     */
    function swallowInFullscreen(event) {
      if (inFullscreen) event.stopPropagation();
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
      // The page moved under the host (see childBoxes()), and moves back
      // once it is gone, before the screenshot: the panel says so.
      const shifted = moved;

      stop();

      // The overlay must be gone from the rendered frame before the screenshot
      // is taken, and removing it from the DOM only queues that change. Two
      // frames guarantees a paint has actually landed.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          send({
            type: 'cdr:region-selected',
            rect: captured,
            viewport,
            run: finished,
            ...(shifted && { moved: true }),
          });
        });
      });
    }

    const POINTER = [
      ['pointerdown', onPointerDown],
      ['pointermove', onPointerMove],
      ['pointerup', onPointerUp],
      ['pointercancel', onPointerCancel],
      ['lostpointercapture', onPointerCancel],
      ['click', cancel],
      ['dblclick', cancel],
      ['auxclick', cancel],
      ['mousedown', swallow],
      ['mouseup', swallow],
      ['contextmenu', swallow],
    ];

    // See swallowInFullscreen(). Passive: none of them is prevented.
    const HOVER = [
      'mousemove', 'mouseover', 'mouseout', 'pointerover', 'pointerout', 'wheel',
      'touchstart', 'touchmove', 'touchend', 'touchcancel',
    ];

    // See onTopLayer().
    const TOP_LAYER = ['focusin', 'toggle', 'close', 'fullscreenchange'];

    function start() {
      if (active) {
        // Armed again while armed: the shortcut, most likely pressed because
        // the overlay is not to be seen. The arm stands, and the host goes
        // back where it can be, or above what covers it, past the bound on
        // remount() too, since the user asked. A fullscreen element the host
        // got no box in is tried again.
        remounts = 0;
        asked = new WeakMap();
        barren = null;
        collectRoots();
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
      asked = new WeakMap();
      barren = null;
      mount();

      for (const [type, listener] of POINTER) root.addEventListener(type, listener);
      for (const type of HOVER) root.addEventListener(type, swallowInFullscreen, { passive: true });
      window.addEventListener('keydown', onKeyDown, true);
      for (const type of TOP_LAYER) window.addEventListener(type, onTopLayer, true);
      // A page kept in the back/forward cache would come back with the overlay
      // live and nothing outside the page aware of it.
      window.addEventListener('pagehide', stop);
      watchedFrames = 0;
      // The arm walked just now: the look at the first frame does not walk
      // again, any look after it may.
      walkedAt = -Infinity;
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
      for (const type of HOVER) root.removeEventListener(type, swallowInFullscreen);
      window.removeEventListener('keydown', onKeyDown, true);
      for (const type of TOP_LAYER) window.removeEventListener(type, onTopLayer, true);
      window.removeEventListener('pagehide', stop);
      unmount();
      // A disarmed overlay holds none of the page's nodes: a component taken
      // out of the page is let go with its shadow root.
      try {
        observer?.disconnect();
      } catch {
        /* nothing observed */
      }
      roots = [];
      layerRoots = [];
      layerSeen = [];
      barren = null;
      changed = true;
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
