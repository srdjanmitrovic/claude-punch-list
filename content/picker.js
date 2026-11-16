/**
 * Element picker, injected on demand by background.js.
 *
 * Unlike overlay.js this does NOT put a click-catcher over the page, because a
 * catcher would become the answer to every elementFromPoint() query. Instead
 * the highlight box is pointer-events:none and the page's own mouse events are
 * suppressed with capture-phase listeners on window, which run before almost
 * anything the page registered.
 */
(() => {
  'use strict';

  /**
   * Which computed styles end up in the prompt.
   *
   * getComputedStyle returns ~340 properties. Dumping all of them buries the
   * signal and wastes Claude Code's context, so this is a deliberate shortlist
   * aimed at the bugs that actually show up in a screenshot: box model, layout
   * mode, stacking, overflow, and typography.
   *
   * TUNE THIS. If you mostly debug grid layouts, add grid-template-areas and
   * grid-auto-flow. If you fight z-index and sticky headers, add inset and
   * will-change. Properties whose value equals the CSS initial value are
   * filtered out below, so a longer list costs less than it looks.
   */
  const STYLE_PROPERTIES = [
    'display',
    'position',
    'inset',
    'width',
    'height',
    'max-width',
    'padding',
    'margin',
    'box-sizing',
    'flex-direction',
    'flex-wrap',
    'justify-content',
    'align-items',
    'gap',
    'grid-template-columns',
    'overflow',
    'z-index',
    'opacity',
    'visibility',
    'transform',
    'color',
    'background-color',
    'font-family',
    'font-size',
    'font-weight',
    'line-height',
    'text-align',
    'white-space',
    'border',
    'border-radius',
  ];

  // Values that carry no information whatever the property: reporting
  // `transform: none` on every element is noise.
  const UNINTERESTING = new Set([
    'none',
    'normal',
    'auto',
    'visible',
    '0px',
    'rgba(0, 0, 0, 0)',
    'static',
    '0px 0px 0px 0px',
  ]);

  /**
   * Per property initial values.
   *
   * The set above cannot catch these, because the same string is meaningful
   * elsewhere: `row` says nothing as a flex-direction but everything as a
   * grid-auto-flow, and `1` is a default opacity but never a default z-index.
   * Without this, every single element reports flex-direction, flex-wrap,
   * opacity and text-align, which is four lines of noise per capture.
   */
  const INITIAL_VALUE = {
    'flex-direction': 'row',
    'flex-wrap': 'nowrap',
    'justify-content': 'normal',
    'align-items': 'normal',
    opacity: '1',
    'text-align': 'start',
    'box-sizing': 'content-box',
    'font-weight': '400',
  };

  const MAX_HTML = 1600;

  // SECRET NAMES BEGIN. The same block sits in content/collector-main.js,
  // content/picker.js and shared/prompt-template.js, which cannot share code:
  // two are injected into the page and one is a module. test/static.test.mjs
  // fails if the copies differ.
  const REDACTED = '<redacted>';

  // Matched against the whole words of a name, so className is not caught by
  // "ssn" nor passHref by "pass". A word of five letters or more also matches
  // at either end of a run together lowercase name (authtoken, phonenumber).
  // Deliberately broad: a needlessly hidden value costs a line of the prompt,
  // and the other kind of mistake cannot be taken back.
  const SECRET_WORDS = [
    'password', 'passwd', 'passphrase', 'passcode', 'pwd', 'secret', 'token', 'auth', 'oauth',
    'authorization', 'bearer', 'jwt', 'cookie', 'session', 'credential', 'apikey', 'accesskey',
    'privatekey', 'signingkey', 'csrf', 'xsrf', 'otp', 'totp', 'pin', 'pincode', 'cvv', 'cvc',
    'ssn', 'iban', 'cardnumber', 'creditcard', 'ccnumber', 'account', 'address', 'email', 'phone',
    'dob', 'birth', 'signature', 'jsessionid', 'sessid', 'securitycode', 'verificationcode',
  ];

  function isSecretName(name) {
    const words = String(name)
      .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
      .filter(Boolean)
      // otp1, cvv2, address2: a field numbered in a row is still that field.
      .map((word) => word.toLowerCase().replace(/(?<=[a-z])\d+$/, ''));
    return words.some((word, index) =>
      SECRET_WORDS.some(
        (secret) =>
          word === secret ||
          word === secret + 's' ||
          word + (words[index + 1] || '') === secret ||
          (secret.length >= 5 && (word.startsWith(secret) || word.endsWith(secret)))
      )
    );
  }
  // SECRET NAMES END

  // SECRET URLS BEGIN. The same block sits in content/picker.js and
  // shared/prompt-template.js; test/static.test.mjs fails if they differ.

  // Whole names that carry a secret in a url, though as words they are too
  // common to treat as secret anywhere (errorCode, sortKey): an OAuth code, an
  // API key, a signed url's signature, a single sign on ticket, a session id
  // in the form PHP and forum software put in a url when cookies are off.
  const SECRET_PARAMS = ['code', 'key', 'sig', 'ticket', 'sid'];

  // Embedded credentials: up to the last '@' before the path, since a password
  // can hold one. A scheme relative url (//user:pass@host) carries them too.
  const CREDENTIALS = /^((?:[a-z][a-z0-9+.-]*:)?\/\/)([^/?#\s]*)@/i;

  // Where the host of a url ends, and so where its credentials must have ended.
  const HOST_END = /[/?#\s]/g;

  // What a userinfo may be made of: anything but a control character or one
  // of "<>[\]^`{|}, none of which RFC 3986 lets one hold. It has stopped at
  // '/', '?', '#' and white space already, and runs to the last '@', since a
  // password can hold one. Letters of any script count, as in an IRI.
  const USERINFO = /^[^\x00-\x1f\x7f"<>[\\\]^`{|}]+$/;

  // How many urls deep a value is followed (a return address holding a return
  // address). Past that the value is masked whole: a page that nests further is
  // either broken or built to run this out of stack.
  const MAX_NESTING = 4;

  /**
   * isSecretName with a bound on its cost. A name too long to be a field's (a
   * url or a blob used as a key or an id) is judged by its first and last 200
   * characters, where a field name sits, so that a name of a million
   * characters costs no more than a short one; the collector judges a long key
   * the same way.
   */
  function isSecretNameBounded(name) {
    if (name.length <= 400) return isSecretName(name);
    return isSecretName(name.slice(0, 200)) || isSecretName(name.slice(-200));
  }

  /** Whether a parameter's name marks its value as secret. */
  function isSecretParam(name) {
    return SECRET_PARAMS.includes(name.toLowerCase()) || isSecretNameBounded(name);
  }

  /**
   * A query (`?a=1&token=x`) or fragment (`#access_token=x`) with the value of
   * every secret looking name masked, and any url inside a value (a redirect,
   * a return address) masked the same way. Handed back unchanged, the very
   * same string, when there is nothing to mask.
   */
  function maskParams(part, depth = 0) {
    if (part.length < 2 || !part.includes('=')) return part;
    let changed = false;
    // Pairs end at '&', and at a ';' that a name and '=' follow. Some servers
    // separate pairs with ';', and serialised markup writes '&' as '&amp;',
    // whose ';' would otherwise leave the next name as 'amp;token'. A ';' with
    // no '=' after it is part of the value, and goes with it. JSON may write
    // '&' as \u0026, which ends a pair too.
    const pieces = part.slice(1).split(/(&|\\u0026|;(?=[^&;=]*=))/i);
    for (let index = 0; index < pieces.length; index += 2) {
      const pair = pieces[index];
      const eq = pair.indexOf('=');
      if (eq <= 0 || eq === pair.length - 1) continue;
      let name = pair.slice(0, eq);
      try {
        name = decodeURIComponent(name.replace(/\+/g, ' '));
      } catch {
        /* a malformed escape is still a name to test */
      }
      // A hash router's fragment carries a route before its query.
      name = name.slice(name.lastIndexOf('?') + 1);
      const value = pair.slice(eq + 1);
      const masked = isSecretParam(name) ? REDACTED : nestedUrl(value, depth);
      if (masked === value) continue;
      pieces[index] = pair.slice(0, eq + 1) + masked;
      changed = true;
    }
    return changed ? part[0] + pieces.join('') : part;
  }

  /**
   * A parameter's value with the secrets of any url it holds masked, whether
   * written out (`next=/verify?token=x`) or percent encoded. An encoded one is
   * masked whole: put back encoded, the marker would print as %3Credacted%3E.
   */
  function nestedUrl(value, depth) {
    const holdsUrl = (text) => /[?#]/.test(text) || credentialsAt(text) !== null;
    if (holdsUrl(value)) return depth < MAX_NESTING ? screenUrl(value, depth + 1) : REDACTED;
    // %253F is a '?' encoded twice, as a return address inside a return
    // address's own encoding arrives.
    if (!/%(?:25)*(?:3F|23|40)/i.test(value)) return value;
    let decoded;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      return value;
    }
    if (holdsUrl(decoded)) {
      return depth < MAX_NESTING && screenUrl(decoded, depth + 1) === decoded ? value : REDACTED;
    }
    // Still encoded once more: decoded again, one level deeper.
    return depth < MAX_NESTING && nestedUrl(decoded, depth + 1) === decoded ? value : REDACTED;
  }

  /**
   * A url, absolute or relative, without embedded credentials and with secret
   * query and fragment values masked. Unchanged when there is nothing to remove.
   *
   * Plain string work rather than new URL(), which would reject a relative url
   * and rewrite the rest of an absolute one on its way back out.
   */
  function safeUrl(url) {
    return typeof url === 'string' ? screenUrl(url, 0) : url;
  }

  /**
   * The credentials at the start of a url, as CREDENTIALS matches them, or
   * null. A userinfo with letters outside ASCII counts only with a ':' in it
   * (josé:pw@, u:Pässwort@). Without one, in running text, it is a run of
   * another script up to an e-mail address further on
   * (请访问https://example.com或联系admin@example.com), and no password.
   */
  function credentialsAt(url) {
    const found = CREDENTIALS.exec(url);
    return found && (found[2].includes(':') || !/[^\x00-\x7f]/.test(found[2])) ? found : null;
  }

  /**
   * The text with the credentials of every url in it removed, wherever the url
   * starts: a second url run into the first (https://cors.test/https://u:p@…),
   * one after letters of another script, or one written in JSON, whose ':\/\/'
   * is a '://'. After a scheme, a userinfo goes as credentialsAt would take it.
   * After a bare '//', which a comment or a path can hold too, only one with a
   * ':' in it, and only characters a userinfo may hold, does: XPath writes
   * //xs:element[@name='x'], whose '[' no userinfo has. Each stretch between
   * two '/' is read once, so the cost is one pass whatever the text.
   */
  function withoutCredentials(text) {
    if (!text.includes('@')) return text;
    let out = '';
    let kept = 0;
    let slash = text.indexOf('/');
    while (slash !== -1) {
      const json = text[slash - 1] === '\\' && text.startsWith('\\/', slash + 1);
      if (text[slash + 1] !== '/' && !json) {
        slash = text.indexOf('/', slash + 1);
        continue;
      }
      const lead = json ? text[slash - 2] : text[slash - 1];
      const from = slash + (json ? 3 : 2);
      HOST_END.lastIndex = from;
      const end = HOST_END.exec(text)?.index ?? text.length;
      const host = text.slice(from, end);
      const userinfo = host.slice(0, Math.max(host.lastIndexOf('@'), 0));
      const at = from + userinfo.length;
      const scheme = lead === ':';
      const loose =
        !scheme && (lead === undefined || !/[\w/.:\\]/.test(lead)) && USERINFO.test(userinfo);
      if (
        userinfo &&
        (userinfo.includes(':') || (scheme && !/[^\x00-\x7f]/.test(userinfo))) &&
        (scheme || loose)
      ) {
        out += text.slice(kept, from);
        kept = at + 1;
      }
      slash = end < text.length ? text.indexOf('/', end) : -1;
    }
    return kept ? out + text.slice(kept) : text;
  }

  /**
   * The part of a url before its query with the secret values of any path
   * parameters masked: Java's ;jsessionid=, a connection string's
   * ;password=. A ';' with no '=' after it changes nothing. A data: url's
   * parameters (;charset=utf8) end at its comma. What follows is its content,
   * not more parameters: an svg, each of whose %23 colours would read as one
   * more nested url, or base64, whose '=' padding would end a name made of
   * random letters.
   */
  function maskPath(path, depth) {
    const comma = /^\s*data:/i.test(path) ? path.indexOf(',') : -1;
    const end = comma === -1 ? path.length : comma;
    const semi = path.indexOf(';');
    if (semi === -1 || semi > end) return path;
    return path.slice(0, semi) + maskParams(path.slice(semi, end), depth) + path.slice(end);
  }

  function screenUrl(url, depth) {
    const credentials = credentialsAt(url);
    const bare = withoutCredentials(credentials ? credentials[1] + url.slice(credentials[0].length) : url);
    const cut = bare.search(/[?#]/);
    if (cut === -1) return maskPath(bare, depth);
    const hashAt = bare.indexOf('#', cut);
    const search = hashAt === -1 ? bare.slice(cut) : bare.slice(cut, hashAt);
    const hash = hashAt === -1 ? '' : bare.slice(hashAt);
    return maskPath(bare.slice(0, cut), depth) + maskParams(search, depth) + maskParams(hash, depth);
  }
  // SECRET URLS END

  function createController() {
    let host = null;
    let shadow = null;
    let box = null;
    let tag = null;
    let active = false;
    let current = null;

    const INSPECT_TIMEOUT_MS = 300;
    const pending = new Map();
    // Bumped by stop(). A pick that was cancelled while its inspect was still
    // in flight must not arrive afterwards as a capture.
    let generation = 0;
    // A page with no MAIN world collector never answers, and there is no point
    // making every subsequent pick on that tab wait out the timeout again. This
    // is the case after the extension is reloaded, because Chrome does not
    // re-inject declared content scripts into tabs that are already open.
    //
    // Cleared by start(), so this remembers a silent page rather than latching
    // on one slow answer. A single round trip that lost a race to a busy main
    // thread would otherwise turn the feature off for the life of the page.
    let mainWorldSilent = false;

    /**
     * Replies from the MAIN world collector.
     *
     * Registered once, when the controller is created, rather than in start():
     * start() runs again on every arm and would stack a listener per arm.
     *
     * collector-bridge.js listens for the same responses on this same window.
     * Its ids are numbers and these are strings, and a Map keys on
     * SameValueZero, so 1 and '1' can never collide: each side looks up the
     * other's id, finds nothing, and ignores the reply.
     */
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.__cdr !== 'response') return;
      const resolve = pending.get(data.id);
      if (!resolve) return;
      pending.delete(data.id);
      resolve(data.payload);
    });

    /**
     * Rebuild a reply from scratch, keeping only what the contract allows.
     *
     * Nothing that arrives here is trustworthy. The request is broadcast with
     * window.postMessage, so on a tab with no collector (one open from before
     * the extension was installed or reloaded) the page's own scripts are the
     * only listeners, and any of them can answer. Whatever comes back is
     * printed into a prompt the user pastes into Claude Code, so adopting the
     * object wholesale would let a page choose its own fields, nest objects the
     * template will stringify, or hand over an array of a million entries.
     *
     * Rebuilding rather than validating is the point: a field this version does
     * not know about cannot survive, whatever a future reply carries.
     */
    function adopt(payload) {
      if (!payload || typeof payload !== 'object') return null;

      // An older collector answered 'inspect' with the component summary
      // itself, which is recognisable by framework and names sitting at the top
      // level where a component field belongs. That pairing is worth a branch,
      // because a new picker meets an old collector every time the extension is
      // reloaded with tabs left open: Chrome does not re-inject declared
      // content scripts into them, so the MAIN world keeps running the previous
      // build while this file arrives fresh on the next arm. Reading the old
      // shape lets such a tab degrade to the previous behaviour rather than
      // lose the component altogether. The opposite pairing needs no handling,
      // since an old picker is only ever injected by the build it shipped with.
      const legacy = typeof payload.framework === 'string' && Array.isArray(payload.names);

      return {
        component: adoptComponent(legacy ? payload : payload.component),
        handlers: legacy ? null : adoptHandlers(payload.handlers),
      };
    }

    // Shared by both rebuilders: an array of short strings and nothing else,
    // whatever shape actually arrived.
    function strings(value, limit) {
      // Sliced before filtering, not after. A hostile reply can carry a million
      // entries, and filtering first walks every one of them in the content
      // script before the cap throws them away. The slack multiplier leaves
      // room for non-string entries to be dropped without losing real ones.
      return (Array.isArray(value) ? value : [])
        .slice(0, limit * 4)
        .filter((entry) => typeof entry === 'string')
        .slice(0, limit)
        .map((entry) => entry.slice(0, 200));
    }

    function adoptComponent(payload) {
      if (!payload || typeof payload !== 'object') return null;

      const names = strings(payload.names, 5);
      if (!names.length) return null;

      const component = {
        framework: payload.framework === 'vue' ? 'vue' : 'react',
        names,
        hops: Number.isFinite(payload.hops) && payload.hops > 0 ? Math.floor(payload.hops) : 0,
      };
      // Left absent rather than defaulted. The template says "development
      // build" only when this build said so, because that claim is what tells
      // a reader the names are the ones in their source.
      if (payload.build === 'development' || payload.build === 'production') {
        component.build = payload.build;
      }
      for (const key of ['owner', 'source', 'version']) {
        if (typeof payload[key] === 'string' && payload[key]) {
          component[key] = payload[key].slice(0, 200);
        }
      }
      if (Number.isFinite(payload.minified) && payload.minified > 0) {
        component.minified = Math.floor(payload.minified);
      }
      if (payload.renamed === true) component.renamed = true;
      const props = strings(payload.props, 12);
      if (props.length) component.props = props;

      return component;
    }

    function adoptHandlers(payload) {
      if (!payload || typeof payload !== 'object') return null;

      const list = strings(payload.list, 6);
      // A handlers block with nothing in its list says nothing, so the object
      // goes rather than printing an ancestor label above an empty list.
      if (!list.length) return null;

      const handlers = { list };
      // Zero is the picked element itself and is meaningful, unlike the
      // component's hops where zero is the absence of a hop.
      if (Number.isFinite(payload.hops) && payload.hops >= 0) {
        handlers.hops = Math.floor(payload.hops);
      }
      for (const key of ['label', 'starts', 'startsOf']) {
        if (typeof payload[key] === 'string' && payload[key]) {
          handlers[key] = payload[key].slice(0, 200);
        }
      }
      return handlers;
    }

    /**
     * Ask the MAIN world which React or Vue component rendered this node, and
     * which event handlers it or a near ancestor carries.
     *
     * The picker runs in the ISOLATED world, where React's __reactFiber$ and
     * Vue's __vueParentComponent are invisible: expando properties live on each
     * world's own wrapper of a node. The DOM itself is shared, which is why the
     * node is handed over as an attribute rather than in the message.
     *
     * Resolves to a rebuilt { component, handlers }, either of which can be
     * null, or to null on timeout rather than hanging, so a page where the MAIN
     * script never ran still produces a capture.
     */
    function inspect(element) {
      if (mainWorldSilent) return Promise.resolve(null);
      return new Promise((resolve) => {
        // Random so that a marker left behind by an earlier pick that never
        // settled cannot be matched by this one. Not a security boundary.
        const marker = 'pick' + Math.random().toString(36).slice(2);
        let settled = false;

        function finish(reply) {
          if (settled) return;
          settled = true;
          pending.delete(marker);
          // Idempotent: the MAIN world removes it too, and this is what covers
          // the timeout path, where nobody over there ever saw the node.
          element.removeAttribute('data-cdr-pick');
          resolve(reply);
        }

        pending.set(marker, (payload) => finish(adopt(payload)));

        element.setAttribute('data-cdr-pick', marker);
        window.postMessage({ __cdr: 'request', id: marker, action: 'inspect', marker }, '*');
        setTimeout(() => {
          if (!settled) mainWorldSilent = true;
          finish(null);
        }, INSPECT_TIMEOUT_MS);
      });
    }

    function build() {
      host = document.createElement('div');
      host.setAttribute('data-cdr-picker', '');
      host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;margin:0;padding:0;border:0';

      shadow = host.attachShadow({ mode: 'closed' });
      shadow.innerHTML = `
        <style>
          :host { all: initial; }
          .box {
            position: fixed;
            border: 2px solid #d6157f;
            background: rgba(214, 21, 127, 0.12);
            pointer-events: none;
            display: none;
            border-radius: 2px;
            transition: all 60ms ease-out;
          }
          .tag {
            position: fixed;
            font: 600 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
            color: #fff;
            background: #d6157f;
            padding: 4px 7px;
            border-radius: 3px;
            display: none;
            pointer-events: none;
            white-space: nowrap;
            max-width: 60vw;
            overflow: hidden;
            text-overflow: ellipsis;
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
        <div class="box"></div>
        <div class="tag"></div>
        <div class="hint">Click an element to capture it &nbsp;·&nbsp; <b>Esc</b> to cancel</div>
      `;

      box = shadow.querySelector('.box');
      tag = shadow.querySelector('.tag');
    }

    function describe(element) {
      let text = element.tagName.toLowerCase();
      if (element.id) text += '#' + element.id;
      const classes = Array.from(element.classList).slice(0, 2);
      if (classes.length) text += '.' + classes.join('.');
      if (element.classList.length > 2) text += `.…+${element.classList.length - 2}`;
      const r = element.getBoundingClientRect();
      return `${text}  ${Math.round(r.width)}×${Math.round(r.height)}`;
    }

    function highlight(element) {
      current = element;
      const r = element.getBoundingClientRect();
      box.style.display = 'block';
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      box.style.width = r.width + 'px';
      box.style.height = r.height + 'px';

      tag.style.display = 'block';
      tag.textContent = describe(element);
      const above = r.top - 26;
      tag.style.top = (above < 4 ? Math.min(r.bottom + 6, window.innerHeight - 26) : above) + 'px';
      tag.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 200)) + 'px';
    }

    /**
     * Build a selector specific enough to find the element again.
     *
     * Stops at body: `html > body >` prefixes every path on every page and
     * helps nobody locate the code behind an element.
     */
    function cssPath(element) {
      const parts = [];
      let node = element;
      while (
        node &&
        node.nodeType === 1 &&
        node !== document.body &&
        node !== document.documentElement &&
        parts.length < 6
      ) {
        if (node.id) {
          try {
            if (document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
              parts.unshift('#' + CSS.escape(node.id));
              break;
            }
          } catch {
            /* exotic id, fall through to the class/index path */
          }
        }
        let part = node.tagName.toLowerCase();
        const classes = Array.from(node.classList)
          .filter((c) => c && !/^\d/.test(c))
          .slice(0, 3);
        if (classes.length) {
          part += '.' + classes.map((c) => CSS.escape(c)).join('.');
        }
        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
        parts.unshift(part);
        node = node.parentElement;
      }
      return parts.join(' > ');
    }

    /**
     * The element's text for the payload, without what a secret textarea
     * holds. textContent takes in a textarea's text like any other, so with a
     * textarea inside, the text is put together from its text nodes, leaving
     * out the ones a secret textarea holds and nothing else.
     */
    function visibleText(element) {
      const secret = (node) =>
        node.tagName === 'TEXTAREA' && secretTextarea((name) => node.getAttribute(name));
      let text;
      if (secret(element)) text = '';
      else if (!element.querySelector('textarea')) text = element.textContent || '';
      else {
        const parts = [];
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          parts.push(node.parentElement && secret(node.parentElement) ? ' ' : node.data);
        }
        text = parts.join('');
      }
      return text.trim().replace(/\s+/g, ' ').slice(0, 200);
    }

    /**
     * A masked opening tag cut to fit in `room` characters. Every attribute
     * stays, with a value over 120 characters cut as the attribute list cuts
     * it (a data: url in a src, a long inline style), and a tag still too
     * long after that is cut itself. Cut after masking, so nothing hidden can
     * come back.
     */
    function shortTag(tag, room) {
      if (tag.length <= room) return tag;
      const cut = tag.replace(ATTRIBUTE, (whole, space, name, value) =>
        value.length > 120 ? `${space}${name}="${value.slice(0, 120)}…"` : whole
      );
      return cut.length <= room ? cut : `${cut.slice(0, room - 2)}…>`;
    }

    /**
     * A deeply nested element's outerHTML can be hundreds of kilobytes. The
     * opening tag carries most of the debugging value (that is where classes,
     * data attributes and inline styles live), so it is kept, cut only when
     * it alone would not fit, and the children are cut.
     */
    function markup(element) {
      // The opening tag is found before masking, since the marker holds a
      // '>' of its own; masked, it is where the masked whole starts.
      const raw = element.outerHTML || '';
      const leading = LEADING_TAG.exec(raw);
      const openTag = leading ? maskMarkup(leading[0]) : '';
      // Masked before anything is cut, so a cut cannot fall inside a tag and
      // leave half a secret that no longer looks like one. Only as much is
      // masked as can be kept: the opening tag and a full budget after it.
      const full = maskedStart(raw, openTag.length + MAX_HTML);
      if (full.length <= MAX_HTML) return { html: full, truncated: false };

      const readable = leading !== null && full.startsWith(openTag);
      const shown = readable ? shortTag(openTag, MAX_HTML - 60) : full.slice(0, 200);
      // A void element (img, input) is its opening tag and nothing else: it
      // has no children to count and no closing tag.
      if (readable && leading[0].length === raw.length) return { html: shown, truncated: true };

      // The closing tag as outerHTML wrote it, which keeps an SVG name's case.
      const closing = /<\/[^\s<>"]+>$/.exec(raw)?.[0] ?? `</${element.tagName.toLowerCase()}>`;
      // The children run up to the closing tag when the masking read to the
      // end, and are printed only up to their share of MAX_HTML.
      const from = readable ? openTag.length : shown.length;
      const to = full.endsWith(closing) ? full.length - closing.length : full.length;
      const inner = full.slice(from, Math.min(to, from + Math.max(MAX_HTML - shown.length - 60, 0)));
      return {
        html: `${shown}\n${inner}\n  <!-- …${element.children.length} child element(s), truncated -->\n${closing}`,
        truncated: true,
      };
    }

    function styles(element) {
      const computed = getComputedStyle(element);
      const out = {};
      for (const property of STYLE_PROPERTIES) {
        const value = computed.getPropertyValue(property);
        if (!value) continue;
        const trimmed = value.trim();
        if (!trimmed || UNINTERESTING.has(trimmed)) continue;
        if (INITIAL_VALUE[property] === trimmed) continue;
        out[property] = trimmed;
      }
      return out;
    }

    function attributes(element) {
      const out = {};
      const control = secretControl(element.tagName.toLowerCase(), (name) =>
        element.getAttribute(name)
      );
      for (const attribute of Array.from(element.attributes || [])) {
        // data-cdr-pick is this extension's own, live only while a pick is in
        // flight. The payload is built before it is set, so this is belt and
        // braces against a page that re-serialises a subtree in that window.
        if (attribute.name === 'class' || attribute.name === 'style') continue;
        if (attribute.name === 'data-cdr-pick') continue;
        const value = maskAttribute(attribute.name, attribute.value, control);
        out[attribute.name] = value.length > 120 ? value.slice(0, 120) + '…' : value;
      }
      return out;
    }

    // MASKING BEGIN (test/picker.test.mjs runs this block on its own)
    // PRIVACY: markup and attributes go into the prompt and into
    // chrome.storage.local for up to a week, and a picked form carries what
    // was typed into it. What is hidden is decided by name, as for props
    // (isSecretName), plus the controls below. A name match, not a guarantee.

    // Attributes whose value is a url, which can carry a token in its query.
    // The data- ones are where lazy loading libraries park a src until it
    // scrolls into view.
    const URL_ATTRIBUTES = [
      'href', 'src', 'action', 'formaction', 'poster', 'ping', 'xlink:href', 'data-src', 'data-href',
    ];

    // Lists of urls, each candidate with a query of its own.
    const URL_LISTS = ['srcset', 'data-srcset'];

    // A url() in a style: in double quotes, single quotes, the &quot; that
    // markup writes, or bare. A quoted url may hold a parenthesis (a CDN's
    // photo%20(1).jpg), so each quoted form runs to its own closing quote.
    // No two neighbouring parts can match the same characters, so a style
    // built to make this backtrack (url( and a long run of spaces, or
    // thousands of url( in a row) costs one pass.
    const STYLE_URL =
      /url\(\s*(?:"([^"]*)"|'([^']*)'|&quot;((?:[^&]|&(?!quot;))*)&quot;|([^\s"'()]+))\s*\)/gi;

    /**
     * Whether a form control's value is a secret whatever it is called: a
     * password or hidden input, a field the browser fills with a password, a
     * one time code or a card, or one whose name or id says so. React mirrors
     * a controlled input's live value into its value attribute, so without
     * this a picked login form prints the password typed into it.
     *
     * @param {(name: string) => string|null} get  an attribute's value
     */
    function secretControl(tag, get) {
      if (!['input', 'textarea', 'select', 'button'].includes(tag)) return false;
      const type = (get('type') || '').toLowerCase();
      // An email or phone field is personal whatever it is called.
      if (tag === 'input' && ['password', 'hidden', 'email', 'tel'].includes(type)) return true;
      if (/password|one-time-code|cc-(?:number|csc|exp)/i.test(get('autocomplete') || '')) {
        return true;
      }
      return isSecretNameBounded(get('name') || '') || isSecretNameBounded(get('id') || '');
    }

    /** One attribute's value as the payload may carry it. */
    function maskAttribute(name, value, control) {
      if (!value) return value;
      const lower = name.toLowerCase();
      // HTML's accesskey is a keyboard shortcut, one character, not a key.
      if (lower !== 'accesskey' && ((control && lower === 'value') || isSecretNameBounded(lower))) {
        return REDACTED;
      }
      if (URL_ATTRIBUTES.includes(lower)) return safeUrl(value);
      // A candidate ends at the comma before the next one, but a url can
      // hold a comma of its own (an image CDN's w_100,h_100).
      if (URL_LISTS.includes(lower)) {
        return value.replace(/[^\s,][^\s]*?(?=,?(?:\s|$))/g, (url) => safeUrl(url));
      }
      // A signed background image. Markup writes the quotes as &quot;.
      if (lower === 'style') {
        return value.replace(STYLE_URL, (whole, double, single, entity, bare) => {
          const url = double ?? single ?? entity ?? bare;
          const masked = safeUrl(url);
          if (masked === url) return whole;
          const quote = double != null ? '"' : single != null ? "'" : entity != null ? '&quot;' : '';
          return `url(${quote}${masked}${quote})`;
        });
      }
      return value;
    }

    // An attribute's name as outerHTML writes it back. The parser lets a name
    // hold a quote or a '<' and start with an '=' (<div =x="1" a"b="2">), so
    // only whitespace, '/', '>' and a later '=' end one. A tag the pattern
    // could not read was left as written, every value in it unmasked.
    const ATTRIBUTE_NAME = '(?:=[^\\s/>=]*|[^\\s/>=]+)';

    // An opening tag as outerHTML writes it, which always puts a value in
    // double quotes; the value can still hold a '>' in older Chrome. A tag
    // name stops at a '<': script text is written out raw, and a name that
    // ran on through <a<a<a… was read again from every '<' in it, which
    // took seconds. A name the parser made with a '<' in it (<div<x …>,
    // <div<1 …>, <div< …>) is read from its last '<' instead, attributes and
    // all. There a '<' sits inside a name, so what follows it need not be a
    // letter, nor be there at all; a letter is left to the first branch, so
    // that no '<' is read from twice.
    const ATTRIBUTES = `(?:\\s+${ATTRIBUTE_NAME}="[^"]*")*`;
    const OPEN_TAG = new RegExp(
      `<([A-Za-z][^\\s/<>]*|(?<=[^\\s/>]<)(?![A-Za-z])[^\\s/<>]*)(${ATTRIBUTES})(\\s*\\/?)>`,
      'g'
    );
    const ATTRIBUTE = new RegExp(`(\\s+)(${ATTRIBUTE_NAME})="([^"]*)"`, 'g');

    // The tag outerHTML opens with, the picked element's own, its name read
    // whole even when it holds a '<'. Anchored, it is read from one place
    // only, so that costs one pass. Since a value may hold a '>' in older
    // Chrome, the first '>' is not always its end.
    const LEADING_TAG = new RegExp(`^<[A-Za-z][^\\s/>]*${ATTRIBUTES}\\s*\\/?>`);

    // A textarea's value is its text, not an attribute. Serialisation
    // escapes every '<' in that text, so it runs to the closing tag.
    const TEXTAREA = new RegExp(`(<textarea(${ATTRIBUTES})\\s*>)([^<]+)(?=<\\/textarea>)`, 'gi');
    const TEXTAREA_START = /<textarea/gi;
    const TEXTAREA_END = /<\/textarea>/gi;

    /** Whether a textarea, given its attributes, holds a secret. */
    function secretTextarea(get) {
      return secretControl('textarea', get);
    }

    /**
     * Serialised markup with every value maskAttribute would hide hidden. A
     * tag with nothing to hide is left exactly as written. A match inside a
     * script's text can only hide too much, never too little.
     */
    function maskMarkup(html) {
      return html.replace(OPEN_TAG, (tag, name, attrs, end) => {
        const list = [...attrs.matchAll(ATTRIBUTE)];
        const get = (wanted) => list.find((match) => match[2].toLowerCase() === wanted)?.[3] ?? null;
        const control = secretControl(name.toLowerCase(), get);
        let changed = false;
        const rebuilt = list.map(([whole, space, attr, value]) => {
          const masked = maskAttribute(attr, value, control);
          if (masked === value) return whole;
          changed = true;
          return `${space}${attr}="${masked}"`;
        });
        return changed ? `<${name}${rebuilt.join('')}${end}>` : tag;
      }).replace(TEXTAREA, (whole, open, attrs) => {
        const list = [...attrs.matchAll(ATTRIBUTE)];
        const get = (wanted) => list.find((match) => match[2].toLowerCase() === wanted)?.[3] ?? null;
        return secretTextarea(get) ? open + REDACTED : whole;
      });
    }

    /**
     * The start of maskMarkup(html): all of it, or at least its first `keep`
     * characters, read from masking only as much of html as that takes. A
     * subtree of megabytes is cut to MAX_HTML characters, and masking all of
     * it cost more than serialising it did.
     */
    function maskedStart(html, keep) {
      for (let size = keep * 2; size < html.length; ) {
        const cut = safeCut(html, size);
        if (cut >= html.length) break;
        const masked = maskMarkup(html.slice(0, cut));
        if (masked.length > keep) return masked;
        // Masking took more out than it left (a long secret value), so the
        // next try reads further.
        size = cut * 4;
      }
      return maskMarkup(html);
    }

    /**
     * The first place at or after `at` where html can be cut and its start
     * masked as it would be masked in the whole: not inside an opening tag,
     * whose later attributes would go unread, and not inside a textarea's
     * text, which is masked only once its closing tag is seen. Each search
     * goes on from where the last stopped, so this reads html once up to
     * the cut.
     */
    function safeCut(html, at) {
      let cut = at;
      OPEN_TAG.lastIndex = 0;
      TEXTAREA_START.lastIndex = 0;
      let tag = OPEN_TAG.exec(html);
      let area = TEXTAREA_START.exec(html);
      for (;;) {
        while (tag && tag.index < cut) {
          cut = Math.max(cut, tag.index + tag[0].length);
          tag = OPEN_TAG.exec(html);
        }
        // Only the last textarea opened before the cut can still be open
        // at it: an earlier one's text ends at the next '<'.
        let open = -1;
        while (area && area.index < cut) {
          open = area.index;
          area = TEXTAREA_START.exec(html);
        }
        if (open === -1) return cut;
        TEXTAREA_END.lastIndex = open;
        const close = TEXTAREA_END.exec(html);
        const end = close ? close.index + close[0].length : html.length;
        if (end <= cut) return cut;
        cut = end;
      }
    }
    // MASKING END

    /**
     * What a generated class name proves about where its CSS lives.
     *
     * Pure string matching on names the page already shows us. That is the
     * whole reason this sits in the ISOLATED world beside the rest of the
     * payload rather than in the collector: these shapes are stamped in by the
     * build, so they read the same in a production bundle, where every
     * framework internal a collector could ask about has been stripped.
     *
     * Each clause claims only what its pattern proves. A Vite module class
     * carries a hash of the file path and not the path, so the file it came
     * from is genuinely unrecoverable and is left unnamed rather than guessed.
     */
    function classHints(element) {
      const hints = [];

      // Vue's scoped id arrives as an attribute rather than a class, and it is
      // the one hint here that points inside a component file, so it goes first
      // and cannot be crowded out by a long class list.
      for (const attribute of Array.from(element.attributes || [])) {
        if (hints.length >= 3) break;
        if (/^data-v-[0-9a-f]{6,10}$/.test(attribute.name)) {
          hints.push(
            `${attribute.name} is a Vue scoped style id, so the rule is in that component's <style scoped>`
          );
        }
      }

      // No backticks in these clauses. The template flattens every page
      // controlled string and turns a backtick into an apostrophe, so one
      // written here comes out as punctuation rather than as code formatting.
      for (const name of Array.from(element.classList)) {
        if (hints.length >= 3) break;
        // Every shape below is a build artefact and so is short. A longer name
        // is the page's own, and the clause would be pasted into a prompt.
        if (!name || name.length > 80) continue;

        // [file]_[local]__[hash], webpack and Next.js. Neither the file nor the
        // local part may contain an underscore, which is what keeps a BEM class
        // such as nav__item__active out: its middle part would have to start
        // with the separator.
        let match = /^([A-Za-z][A-Za-z0-9$-]*)_([A-Za-z][A-Za-z0-9$-]*)__([A-Za-z0-9]{5,6})$/.exec(name);
        // The shape alone is not enough. `product_card__header` is an ordinary
        // hand written class and matches it exactly, and reporting one as a
        // module names a stylesheet that does not exist, which is the single
        // worst thing this feature can do. A real hash is base64ish: it carries
        // a digit, or mixes cases. An all lowercase English word carries
        // neither, so it is rejected.
        if (match && !/\d/.test(match[3]) && !(/[a-z]/.test(match[3]) && /[A-Z]/.test(match[3]))) {
          match = null;
        }
        if (match) {
          hints.push(`${name} is a CSS Module: .${match[2]} in ${match[1]}.module.css`);
          continue;
        }

        // _[local]_[hash]_[line], Vite.
        match = /^_([A-Za-z][A-Za-z0-9$-]*)_([A-Za-z0-9]{5,6})_(\d+)$/.exec(name);
        if (match) {
          hints.push(
            `${name} is a Vite CSS Module: local .${match[1]} declared on line ${match[3]} of its module file, whose name the class does not carry`
          );
          continue;
        }

        // [file]__[name]-sc-[hash], styled-components with the babel plugin. A
        // bare sc- class is deliberately ignored: it names nothing, and the
        // shape is loose enough to catch an ordinary hand written class.
        match = /^([A-Za-z][A-Za-z0-9$]*)__([A-Za-z][A-Za-z0-9$]*)-sc-[A-Za-z0-9]+(?:-\d+)?$/.exec(name);
        if (match) {
          hints.push(
            `${name} is styled-components: the ${match[2]} styled call in ${match[1]}`
          );
          continue;
        }

        // css-[hash]-[label], Emotion with the babel plugin. The hash must
        // contain a digit, or a plain class like css-module-Wrapper matches.
        match = /^css-([a-z0-9]{5,})-([A-Za-z][A-Za-z0-9$]*)$/.exec(name);
        if (match && /\d/.test(match[1])) {
          hints.push(
            `${name} is an Emotion class labelled ${match[2]}, so the style is in that component's css or styled call`
          );
        }
      }

      return hints;
    }

    function onMouseMove(event) {
      const element = document.elementFromPoint(event.clientX, event.clientY);
      if (!element || element === current) return;
      if (element === document.documentElement || element === document.body) return;
      highlight(element);
    }

    function swallow(event) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    }

    function onClick(event) {
      swallow(event);
      if (!current) return;
      const element = current;
      const rect = element.getBoundingClientRect();

      const payload = {
        selector: cssPath(element),
        tagName: element.tagName.toLowerCase(),
        classes: Array.from(element.classList),
        attributes: attributes(element),
        inlineStyle: maskAttribute('style', element.getAttribute('style') || '', false),
        text: visibleText(element),
        ...markup(element),
        styles: styles(element),
      };

      // Read here with the rest of the payload, while the DOM is still exactly
      // what the user clicked and before the marker attribute below is set.
      const hints = classHints(element);
      if (hints.length) payload.classHints = hints;

      // Pad slightly so the element does not sit flush against the crop edge,
      // then clamp every edge before deriving the size. Clamping the origin
      // while keeping the element's full height would, for a card scrolled half
      // above the fold, produce a crop reaching far below the element and full
      // of unrelated content.
      const left = Math.max(0, rect.left - 4);
      const top = Math.max(0, rect.top - 4);
      const right = Math.min(window.innerWidth, rect.right + 4);
      const bottom = Math.min(window.innerHeight, rect.bottom + 4);

      const captureRect = {
        x: left,
        y: top,
        width: Math.max(1, right - left),
        height: Math.max(1, bottom - top),
      };

      const viewport = {
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
      };

      stop();

      // The marker attribute is set here, after the payload is built, because
      // attributes() and markup() read the live DOM and would otherwise print
      // data-cdr-pick into the user's prompt.
      const inspected = inspect(element);

      // Removing the highlight box only queues the change, and one frame does
      // not guarantee a paint has landed before the panel screenshots the tab,
      // hence two. The round trip runs alongside them, so its timeout is only
      // ever paid on a page where the MAIN world never answers at all.
      const painted = new Promise((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(resolve);
        });
      });

      // stop() ran above, so Escape is already unhooked; the panel's cancel
      // button is the route still open during the round trip. Without this the
      // cancelled pick would arrive anyway, and the panel would answer it with
      // a screenshot and a file on disk.
      const era = generation;
      Promise.all([inspected, painted]).then(([reply]) => {
        if (era !== generation) return;
        if (reply?.component) payload.component = reply.component;
        if (reply?.handlers) payload.handlers = reply.handlers;
        send({ type: 'cdr:element-picked', rect: captureRect, viewport, element: payload });
      });
    }

    function onKeyDown(event) {
      if (event.key !== 'Escape') return;
      swallow(event);
      stop();
      send({ type: 'cdr:capture-cancelled', mode: 'element' });
    }

    function send(message) {
      try {
        chrome.runtime.sendMessage(message).catch(() => {});
      } catch {
        /* extension context invalidated */
      }
    }

    function start() {
      if (active) return;
      // Mutually exclusive with the region overlay; see the matching comment
      // in overlay.js.
      try {
        window.__cdrRegionOverlay?.stop();
      } catch {
        /* ignore */
      }
      if (!host) build();
      active = true;
      current = null;
      mainWorldSilent = false;
      box.style.display = 'none';
      tag.style.display = 'none';
      shadow.querySelector('.hint').style.display = 'block';

      (document.body || document.documentElement).appendChild(host);

      window.addEventListener('mousemove', onMouseMove, true);
      window.addEventListener('click', onClick, true);
      window.addEventListener('mousedown', swallow, true);
      window.addEventListener('mouseup', swallow, true);
      window.addEventListener('keydown', onKeyDown, true);
      // See the matching line in overlay.js.
      window.addEventListener('pagehide', stop);
    }

    function stop() {
      // Before the active guard, deliberately. onClick calls stop() itself and
      // then waits on the inspect round trip, so by the time the panel's cancel
      // button disarms the tab this controller is already inactive. Bumping
      // below the guard would make that call a no-op and let the cancelled pick
      // land anyway, as a capture and a PNG on disk.
      generation += 1;
      if (!active) return;
      active = false;
      window.removeEventListener('mousemove', onMouseMove, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('mousedown', swallow, true);
      window.removeEventListener('mouseup', swallow, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pagehide', stop);
      if (host && host.parentNode) host.parentNode.removeChild(host);
    }

    // See the matching line in overlay.js.
    return { start, stop, isActive: () => active };
  }

  if (!window.__cdrElementPicker) {
    window.__cdrElementPicker = createController();
  }
  window.__cdrElementPicker.start();
})();
