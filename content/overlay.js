/**
 * Region-select overlay, injected on demand by background.js.
 *
 * Injected with chrome.scripting.executeScript, which re-runs this whole file
 * every time. The controller is built once and cached on window; subsequent
 * injections only call start(). That keeps repeat captures cheap and avoids
 * stacking duplicate listeners.
 */
(() => {
  'use strict';

  function createController() {
    let host = null;
    let shadow = null;
    let selection = null;
    let label = null;
    let hint = null;
    let active = false;
    let dragging = false;
    let origin = { x: 0, y: 0 };
    let rect = { x: 0, y: 0, width: 0, height: 0 };

    const MIN_SIZE = 10; // px; smaller drags are treated as a misclick

    function build() {
      host = document.createElement('div');
      host.setAttribute('data-cdr-overlay', '');
      // Max z-index, and reset anything the page's * selector might impose.
      host.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:2147483647',
        'margin:0',
        'padding:0',
        'border:0',
      ].join(';');

      shadow = host.attachShadow({ mode: 'closed' });
      shadow.innerHTML = `
        <style>
          :host { all: initial; }
          .root {
            position: fixed;
            inset: 0;
            cursor: crosshair;
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
            font: 500 12px/1 ui-sans-serif, system-ui, -apple-system, sans-serif;
            color: #f5f5f4;
            background: rgba(20, 22, 28, 0.92);
            padding: 8px 14px;
            border-radius: 999px;
            pointer-events: none;
            box-shadow: 0 4px 16px rgba(0,0,0,0.35);
          }
          .hint b { color: #f7a8cf; font-weight: 600; }
        </style>
        <div class="root">
          <div class="sel"></div>
          <div class="label"></div>
          <div class="hint">Drag to select a region &nbsp;·&nbsp; <b>Esc</b> to cancel</div>
        </div>
      `;

      selection = shadow.querySelector('.sel');
      label = shadow.querySelector('.label');
      hint = shadow.querySelector('.hint');
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

    function onPointerDown(event) {
      if (event.button !== 0) return;
      event.preventDefault();
      dragging = true;
      hint.style.display = 'none';
      origin = { x: event.clientX, y: event.clientY };
      rect = { x: origin.x, y: origin.y, width: 0, height: 0 };
      try {
        event.target.setPointerCapture(event.pointerId);
      } catch {
        /* not fatal, the window listeners still track the drag */
      }
    }

    function onPointerMove(event) {
      if (!dragging) return;
      event.preventDefault();
      rect = normalize(origin.x, origin.y, event.clientX, event.clientY);
      paint();
    }

    function onPointerUp(event) {
      if (!dragging) return;
      event.preventDefault();
      dragging = false;
      rect = normalize(origin.x, origin.y, event.clientX, event.clientY);

      if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) {
        // Treat as a misclick and stay armed rather than silently capturing a
        // sliver or tearing down the overlay the user still wants.
        selection.style.display = 'none';
        label.style.display = 'none';
        hint.style.display = 'block';
        return;
      }

      finish();
    }

    function onKeyDown(event) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      stop();
      send({ type: 'cdr:capture-cancelled', mode: 'region' });
    }

    function send(message) {
      try {
        // Promise form: if the side panel is closed there is no receiver, and
        // the callback form would log "Could not establish connection".
        chrome.runtime.sendMessage(message).catch(() => {});
      } catch {
        /* extension context invalidated (reloaded mid-session) */
      }
    }

    function finish() {
      const captured = { ...rect };
      const viewport = {
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
      };

      stop();

      // The overlay must be gone from the rendered frame before the screenshot
      // is taken, and removing it from the DOM only queues that change. Two
      // frames guarantees a paint has actually landed.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          send({ type: 'cdr:region-selected', rect: captured, viewport });
        });
      });
    }

    function start() {
      if (active) return;
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
      dragging = false;

      selection.style.display = 'none';
      label.style.display = 'none';
      hint.style.display = 'block';

      (document.body || document.documentElement).appendChild(host);

      const root = shadow.querySelector('.root');
      root.addEventListener('pointerdown', onPointerDown);
      root.addEventListener('pointermove', onPointerMove);
      root.addEventListener('pointerup', onPointerUp);
      window.addEventListener('keydown', onKeyDown, true);
    }

    function stop() {
      if (!active) return;
      active = false;
      dragging = false;
      const root = shadow.querySelector('.root');
      root.removeEventListener('pointerdown', onPointerDown);
      root.removeEventListener('pointermove', onPointerMove);
      root.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('keydown', onKeyDown, true);
      if (host.parentNode) host.parentNode.removeChild(host);
    }

    return { start, stop };
  }

  if (!window.__cdrRegionOverlay) {
    window.__cdrRegionOverlay = createController();
  }
  window.__cdrRegionOverlay.start();
})();
