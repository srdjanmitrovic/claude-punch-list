/**
 * The page's half of a whole page capture (the Page mode), in the isolated
 * world. The panel injects this file, then calls begin(), step(index) once
 * for each screen and end() through chrome.scripting.executeScript, and takes
 * each screenshot itself between two steps.
 *
 * This is the one script that changes a host page on purpose. It scrolls the
 * page, turns scroll snapping off, makes sticky elements relative and hides
 * elements fixed to the window, all through inline !important styles set with
 * the CSSOM (never the style attribute, which a page's CSP could refuse).
 * end() puts every one of them back, but only where the value is still the
 * one this script set, so a value the page wrote during the run stays the
 * page's, and then it puts the scroll position back. It also runs by itself:
 * when the panel has not called for LEASE_MS (the panel, its window or the
 * worker went away), on pagehide, and when the user scrolls, presses a key or
 * clicks on the page, which the next step reports as stopped: 'user'.
 *
 * Every handler the page can reach is wrapped in try, so nothing here throws
 * into page code. Injected again for every capture, so nothing here may be a
 * top level const, let or class: the controller is made once and cached on
 * the window.
 */
(() => {
  'use strict';

  function createController() {
    // How long a run outlives the last call from the panel. Each step sets it
    // again when it starts and when it ends, so what it has to cover is the
    // gap between two steps: the panel's pacing (520 ms) and captureVisibleTab
    // with its quota retries (three waits of 600 ms) while another window's
    // panel is capturing too.
    const LEASE_MS = 4000;
    // How long a step waits for the images in view to finish loading. A lazy
    // image starts loading once it is scrolled near, and an empty box in the
    // middle of the stitched page reads as a broken image.
    const IMAGE_WAIT_MS = 800;
    // A frame that does not come (a tab that is not painting) is not waited
    // for longer than this.
    const FRAME_WAIT_MS = 100;
    // The most elements one walk looks at, through shadow roots. Reading the
    // computed position of 20 000 elements took 4 to 9 ms in Chrome.
    const SCAN_LIMIT = 20000;
    // An inner scroller is only chosen when it covers this share of the view:
    // a dialog body scrolls too, and Region or Element covers that better.
    const MIN_SHARE = 0.25;
    // A fixed element at least this share of the scroller's height is a
    // sidebar or a backdrop, left alone so that it repeats down the page.
    const TALL = 0.9;
    const INPUT = ['wheel', 'touchstart', 'keydown', 'pointerdown'];
    const INSETS = ['top', 'right', 'bottom', 'left'];
    // The built in elements attachShadow accepts, as the DOM standard lists
    // them. Any other element can only host a root when it is a custom
    // element, whose name has a hyphen.
    const SHADOW_HOSTS = new Set([
      'article',
      'aside',
      'blockquote',
      'body',
      'div',
      'footer',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'header',
      'main',
      'nav',
      'p',
      'section',
      'span',
    ]);

    /**
     * The run in progress, or null:
     * { scroller, still, root, rect, scroll, styles, timer }. scroller is the
     * inner element that scrolls, or null for the document; still says
     * nothing is scrolled at all (see begin); rect is the part of the
     * view it shows; styles maps each element touched to
     * { hadStyle, props: Map(prop -> { value, priority, mine }) }, the page's
     * own value and priority and the value this script set.
     */
    let run = null;
    // Why the last run ended by itself ('user', 'pagehide', 'lease' or
    // 'error'), for the next step to report. begin() clears it.
    let lastStop = null;
    // Each element's closed shadow root or null, asked for once a run (see
    // shadowOf). begin() starts it again.
    let asked = new WeakMap();

    // ------------------------------------------------------------ styles --

    /**
     * Set `prop` to `value` !important on the element, recording what it
     * was. Says whether it wrote anything: not when the value there is still
     * the one it set.
     */
    function setStyle(element, prop, value) {
      const style = element.style;
      let entry = run.styles.get(element);
      if (!entry) {
        entry = { hadStyle: element.getAttribute('style') !== null, props: new Map() };
        run.styles.set(element, entry);
      }
      const record = entry.props.get(prop);
      const current = style.getPropertyValue(prop);
      const priority = style.getPropertyPriority(prop);
      if (record && current === record.mine && priority === 'important') return false;
      // The first time, or the page wrote its own value since (a framework
      // re-rendering a header): that value is the one to put back.
      style.setProperty(prop, value, 'important');
      entry.props.set(prop, { value: current, priority, mine: style.getPropertyValue(prop) });
      return true;
    }

    /**
     * Put `prop` back on the element, if what is there is still this
     * script's. Says whether there was anything of its own to put back.
     */
    function restoreStyle(element, prop) {
      const entry = run.styles.get(element);
      const record = entry?.props.get(prop);
      if (!record) return false;
      try {
        const style = element.style;
        if (style.getPropertyValue(prop) === record.mine && style.getPropertyPriority(prop) === 'important') {
          if (record.value) style.setProperty(prop, record.value, record.priority);
          else style.removeProperty(prop);
        }
      } catch {
        /* an element the page has since taken apart */
      }
      entry.props.delete(prop);
      if (entry.props.size) return true;
      run.styles.delete(element);
      // An element that had no style attribute is left without one, rather
      // than with an empty one a page's own selector could see.
      try {
        if (!entry.hadStyle && element.getAttribute('style') === '') element.removeAttribute('style');
      } catch {
        /* as above */
      }
      return true;
    }

    function restoreAll() {
      for (const [element, entry] of [...run.styles]) {
        for (const prop of [...entry.props.keys()]) restoreStyle(element, prop);
      }
    }

    // -------------------------------------------------------------- walk --

    /**
     * The element's shadow root, open, or closed where Chrome lets an
     * extension ask for one. The stage has no isolated world and no
     * chrome.dom, so there only open roots are walked.
     *
     * A closed root is not only a component's: a widget's loader puts one
     * on a plain div, and a chat button fixed in it would repeat down the
     * stitched page. So every element that can host one is asked, once a
     * run, as asking costs about 15 ms over 20 000 divs and a walk runs
     * twice a step. A root attached to an element after it was asked is
     * missed until the next run; a widget's new host is a new element.
     */
    function shadowOf(node) {
      if (node.shadowRoot) return node.shadowRoot;
      // Only these can host a root at all, so the others are not asked about.
      const name = node.localName;
      if (!name || !(name.includes('-') || SHADOW_HOSTS.has(name))) return null;
      if (asked.has(node)) return asked.get(node);
      const ask = globalThis.chrome?.dom?.openOrClosedShadowRoot;
      let shadow = null;
      if (typeof ask === 'function') {
        try {
          shadow = ask(node) || null;
        } catch {
          shadow = null;
        }
      }
      asked.set(node, shadow);
      return shadow;
    }

    /** Call visit for each element, in document order through shadow roots, up to SCAN_LIMIT. */
    function walk(visit) {
      const walkers = [document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT)];
      let budget = SCAN_LIMIT;
      while (walkers.length && budget > 0) {
        const node = walkers[walkers.length - 1].nextNode();
        if (!node) {
          walkers.pop();
          continue;
        }
        budget -= 1;
        visit(node);
        const shadow = shadowOf(node);
        if (shadow) walkers.push(document.createTreeWalker(shadow, NodeFilter.SHOW_ELEMENT));
      }
    }

    // ---------------------------------------------------------- scroller --

    function scrollingRoot() {
      return document.scrollingElement || document.documentElement;
    }

    /** Whether the user can scroll the document itself: not when the page locked it. */
    function documentScrolls() {
      const locked = (element) => {
        const overflow = element ? getComputedStyle(element).overflowY : 'visible';
        return overflow === 'hidden' || overflow === 'clip';
      };
      const html = document.documentElement;
      if (locked(html)) return false;
      // The body's overflow is the viewport's when the root's is visible.
      const own = html ? getComputedStyle(html).overflowY : 'visible';
      return !(own === 'visible' && locked(document.body));
    }

    /** The share of the view an element's box covers, in CSS pixels squared. */
    function shownArea(box) {
      const width = Math.min(box.right, innerWidth) - Math.max(box.left, 0);
      const height = Math.min(box.bottom, innerHeight) - Math.max(box.top, 0);
      return Math.max(0, width) * Math.max(0, height);
    }

    /**
     * What to scroll: the document, or the element that scrolls furthest of
     * those covering at least MIN_SHARE of the view, when it scrolls further
     * than the document does (`scrolls` says whether the document does at
     * all). Null is the document.
     */
    function pickScroller(root, scrolls) {
      let best = null;
      let distance = scrolls ? root.scrollHeight - root.clientHeight : 0;
      const enough = MIN_SHARE * innerWidth * innerHeight;
      walk((element) => {
        if (element === root) return;
        const reach = element.scrollHeight - element.clientHeight;
        if (reach <= distance) return; // read before the computed style, which costs more
        const overflow = getComputedStyle(element).overflowY;
        if (overflow !== 'auto' && overflow !== 'scroll' && overflow !== 'overlay') return;
        if (shownArea(element.getBoundingClientRect()) < enough) return;
        best = element;
        distance = reach;
      });
      return best;
    }

    /** The part of the view the scroller shows, without its borders and scrollbars. */
    function scrollerRect(scroller, root) {
      if (!scroller) return { x: 0, y: 0, width: root.clientWidth, height: root.clientHeight };
      const box = scroller.getBoundingClientRect();
      return {
        x: box.left + scroller.clientLeft,
        y: box.top + scroller.clientTop,
        width: scroller.clientWidth,
        height: scroller.clientHeight,
      };
    }

    // A still run (see begin) is one screen, at the top of nothing: the
    // screen in view, wherever the locked page was left scrolled.
    function currentTop() {
      return run.still ? 0 : (run.scroller || run.root).scrollTop;
    }

    function currentHeight() {
      return run.still ? run.rect.height : (run.scroller || run.root).scrollHeight;
    }

    /**
     * Scroll to `top` at once. 'instant' because a page's
     * `scroll-behavior: smooth` turns a plain scrollTo into an animation that
     * has not moved yet when the screenshot is taken.
     */
    function scrollTo(top) {
      (run.scroller || window).scrollTo({ top, behavior: 'instant' });
    }

    /**
     * How far one step scrolls: a CSS pixel short of the scroller's height,
     * so two screens overlap by a row. At a device pixel ratio that is not a
     * whole number the view's height in CSS pixels is rounded, and a whole
     * screen's step could pass over a row that no screenshot shows.
     */
    function stride() {
      return Math.max(1, run.rect.height - 1);
    }

    function reachedEnd() {
      return currentTop() + run.rect.height >= currentHeight() - 1;
    }

    /** The colour behind the page, for whatever the stitched image has no frame for. */
    function background() {
      for (const element of [document.body, document.documentElement]) {
        if (!element) continue;
        const colour = getComputedStyle(element).backgroundColor;
        if (colour && colour !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(colour)) return colour;
      }
      return 'rgb(255, 255, 255)';
    }

    // -------------------------------------------------- fixed and sticky --

    /**
     * Make each sticky element relative, so it shows once at its own place,
     * and show or hide each element fixed to the window. One that overlaps
     * the scroller and is shorter than TALL of it shows on the first screen
     * when its centre is in the upper half, on the last when it is in the
     * lower half, and is hidden on every other. Hidden takes opacity as well
     * as visibility: a descendant can set visibility: visible and still
     * paint, and none can undo an ancestor's opacity. Says whether it
     * changed anything on the page.
     */
    function settle(index, atEnd) {
      const box = run.rect;
      let changed = false;
      const set = (element, prop, value) => {
        if (setStyle(element, prop, value)) changed = true;
      };
      const restore = (element, prop) => {
        if (restoreStyle(element, prop)) changed = true;
      };
      walk((element) => {
        const position = getComputedStyle(element).position;
        if (position === 'sticky') {
          set(element, 'position', 'relative');
          for (const side of INSETS) set(element, side, 'auto');
          return;
        }
        if (position !== 'fixed') return;
        const rect = element.getBoundingClientRect();
        const overlaps =
          rect.width > 0 &&
          rect.height > 0 &&
          rect.left < box.x + box.width &&
          rect.right > box.x &&
          rect.top < box.y + box.height &&
          rect.bottom > box.y;
        let show = true;
        if (overlaps && rect.height < TALL * box.height) {
          const upper = rect.top + rect.height / 2 < box.y + box.height / 2;
          show = upper ? index === 0 : atEnd;
        }
        if (show) {
          restore(element, 'visibility');
          restore(element, 'opacity');
        } else {
          set(element, 'visibility', 'hidden');
          set(element, 'opacity', '0');
        }
      });
      return changed;
    }

    // ------------------------------------------------------------- waits --

    function frame() {
      return new Promise((resolve) => {
        let done = false;
        const go = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(go, FRAME_WAIT_MS);
        try {
          requestAnimationFrame(go);
        } catch {
          /* the timer goes on its own */
        }
      });
    }

    /** Until each image in view has loaded or failed, or IMAGE_WAIT_MS has passed. */
    function images() {
      const pending = [];
      for (const image of document.images) {
        if (image.complete) continue;
        const box = image.getBoundingClientRect();
        if (box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth) pending.push(image);
      }
      if (!pending.length) return Promise.resolve();
      return new Promise((resolve) => {
        let left = pending.length;
        const finish = () => {
          clearTimeout(timer);
          for (const image of pending) {
            image.removeEventListener('load', one);
            image.removeEventListener('error', one);
          }
          resolve();
        };
        const one = () => {
          left -= 1;
          if (left <= 0) finish();
        };
        const timer = setTimeout(finish, IMAGE_WAIT_MS);
        for (const image of pending) {
          image.addEventListener('load', one);
          image.addEventListener('error', one);
        }
      });
    }

    async function paint() {
      await frame();
      await frame();
      await images();
    }

    // ------------------------------------------------------------- lease --

    function lease() {
      clearTimeout(run.timer);
      run.timer = setTimeout(() => stop('lease'), LEASE_MS);
    }

    function onInput(event) {
      try {
        if (event.isTrusted) stop('user');
      } catch {
        /* nothing reaches the page */
      }
    }

    function onPageHide() {
      try {
        stop('pagehide');
      } catch {
        /* as above */
      }
    }

    /** End the run by itself, and keep why for the next step to say. */
    function stop(reason) {
      if (!run) return;
      lastStop = reason;
      finish();
    }

    /**
     * Put the page back: the scroll position first, then every style. A
     * still run scrolled nothing, so where the page is now is the page's own.
     */
    function finish() {
      const ending = run;
      if (!ending) return;
      clearTimeout(ending.timer);
      for (const type of INPUT) window.removeEventListener(type, onInput, true);
      window.removeEventListener('pagehide', onPageHide, true);
      try {
        if (ending.scroller) {
          ending.scroller.scrollTo({ top: ending.scroll.top, left: ending.scroll.left, behavior: 'instant' });
        } else if (!ending.still) {
          window.scrollTo({ top: ending.scroll.y, left: ending.scroll.x, behavior: 'instant' });
        }
      } catch {
        /* a scroller the page has since taken out */
      }
      try {
        restoreAll();
      } finally {
        run = null;
      }
    }

    // ------------------------------------------------------------ public --

    /**
     * Start a run: refuse pinch zoom, choose what to scroll, turn snapping
     * off and scroll to the top. A run the panel lost track of (its frame
     * reloaded) is put back first.
     *
     * A document the page has locked (overflow hidden or clip, as an open
     * dialog, a cookie wall or a menu sets) is one the user cannot scroll,
     * though a script still can. With nothing else to scroll, the run is
     * still: it neither scrolls nor settles, and is the one screen in view,
     * as the user sees it. `locked` tells the panel why, when the document
     * would have scrolled.
     */
    function begin() {
      try {
        finish();
        lastStop = null;
        asked = new WeakMap();
        const zoom = window.visualViewport?.scale;
        if (typeof zoom === 'number' && Math.abs(zoom - 1) > 0.01) return { ok: false, reason: 'zoom' };
        const root = scrollingRoot();
        const scrolls = documentScrolls();
        const scroller = pickScroller(root, scrolls);
        const still = !scroller && !scrolls;
        run = {
          scroller,
          still,
          root,
          rect: scrollerRect(scroller, root),
          scroll: {
            x: window.scrollX,
            y: window.scrollY,
            top: scroller ? scroller.scrollTop : 0,
            left: scroller ? scroller.scrollLeft : 0,
          },
          styles: new Map(),
          timer: null,
        };
        for (const type of INPUT) window.addEventListener(type, onInput, { capture: true, passive: true });
        window.addEventListener('pagehide', onPageHide, true);
        lease();
        if (!still) {
          setStyle(scroller || document.documentElement, 'scroll-snap-type', 'none');
          scrollTo(0);
        }
        const height = currentHeight();
        return {
          ok: true,
          scroller: scroller ? 'inner' : 'document',
          ...(still && root.scrollHeight - root.clientHeight > 1 ? { locked: true } : {}),
          rect: run.rect,
          client: { width: root.clientWidth, height: root.clientHeight },
          viewport: { width: innerWidth, height: innerHeight },
          scrollHeight: height,
          screens: height <= run.rect.height ? 1 : 1 + Math.ceil((height - run.rect.height) / stride()),
          background: background(),
        };
      } catch (error) {
        try {
          finish();
        } catch {
          /* already as put back as it can be */
        }
        return { ok: false, reason: 'error', message: String(error?.message || error) };
      }
    }

    /**
     * Scroll to screen `index`, settle the fixed and sticky elements, and
     * wait for the page to paint. The reply says where the page actually
     * is, which the panel draws the frame at, and `before` is where it was
     * when the step began, so the panel can tell a page that moved or grew
     * since the last screenshot.
     */
    async function step(index) {
      if (!run) return { active: false, stopped: lastStop || 'ended' };
      const mine = run;
      try {
        lease();
        const before = { top: currentTop(), scrollHeight: currentHeight() };
        if (!run.still) {
          scrollTo(index * stride());
          settle(index, reachedEnd());
        }
        await paint();
        if (run !== mine) return { active: false, stopped: lastStop || 'ended' };
        // Settled again once the page has had its frames. Its scroll handlers
        // run with the frame after a scroll, so a header a script fixes once
        // the page is scrolled is fixed only now. Lazy content can lengthen
        // the page meanwhile, or a collapsing section shorten it, and the
        // bottom bar follows the end. Two more frames only when that changed
        // anything, for the change to be painted.
        const atEnd = reachedEnd();
        if (!run.still && settle(index, atEnd)) {
          await frame();
          await frame();
          if (run !== mine) return { active: false, stopped: lastStop || 'ended' };
        }
        lease();
        return {
          active: true,
          top: currentTop(),
          scrollHeight: currentHeight(),
          atEnd,
          viewport: { width: innerWidth, height: innerHeight },
          before,
        };
      } catch (error) {
        if (run === mine) stop('error');
        return { active: false, stopped: 'error', message: String(error?.message || error) };
      }
    }

    /** Put the page back. Says whether a run was still going. */
    function end() {
      try {
        if (!run) return { restored: false, stopped: lastStop };
        finish();
        return { restored: true };
      } catch {
        run = null;
        return { restored: false };
      }
    }

    return { begin, step, end, isActive: () => Boolean(run) };
  }

  if (!window.__cdrPageShot) {
    window.__cdrPageShot = createController();
  }
})();
