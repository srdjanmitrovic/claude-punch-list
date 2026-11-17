/**
 * Element picker, injected on demand by background.js.
 *
 * Unlike overlay.js this does NOT put a click-catcher over the page while it
 * picks, because a catcher would become the answer to every elementFromPoint()
 * query. Instead the highlight box is pointer-events:none and the page's own
 * pointer and mouse events are suppressed with capture-phase listeners on
 * window, which run before almost anything the page registered.
 *
 * One exception: a frame takes every event over it, so while armed frames are
 * made to let the pointer through to the page (see passFrames()), and a frame
 * is picked as a whole.
 *
 * The element is read the moment it is picked, in whatever hover state it is
 * in, and the payload says when that is a hover state. Nothing covers the page
 * between the press and the screenshot, since a menu that exists only while
 * hovered closes as soon as anything takes the hover from it. The rest of the
 * press, and a double click's second press, are kept from the page by the same
 * capture listeners for a moment after the pick (see beginTail()).
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

  // A user name made of words: git, admin, jane.doe, JaneDoe, deploy-bot. An
  // address needs it (ssh://git@github.com/org/repo), and it hides nothing.
  // Each word is a capital or a small letter and up to 15 small letters after
  // it. A token used as a user name still goes: it carries digits
  // (https://ghp_…@github.com, a Sentry key), capitals run together
  // (AKIAIOSFODNNEXAMPLE), a run of small letters longer than a word
  // (the 24 of a Stripe test key), or more than PLAIN_USER_MAX characters.
  const PLAIN_USER =
    /^[A-Za-z][a-z]{0,15}(?:[A-Z][a-z]{1,15})*(?:[._-][A-Za-z][a-z]{0,15}(?:[A-Z][a-z]{1,15})*)*$/;
  const PLAIN_USER_MAX = 32;

  // A key in JSON, written out or once decoded: "token": in state={"token":…}.
  const JSON_KEY = /"([^"\\]*)"\s*:/g;

  // More distinct keys than any state a url carries. Past that the value is a
  // blob, kept out whole rather than judged key by key in the page's time.
  const MAX_JSON_KEYS = 500;

  // How many urls deep a value is followed (a return address holding a return
  // address). Past that the value is masked whole: a page that nests further is
  // either broken or built to run this out of stack.
  const MAX_NESTING = 4;

  /**
   * Whether what stands before a url's '@' is credentials to strip. With a ':'
   * it holds a password, and always is. Without one it is a user name, which
   * is stripped unless it is a plain word, or unless it is no user name at
   * all: letters outside ASCII are running text up to an e-mail address
   * further on (请访问https://example.com或联系admin@example.com), and a ';', ','
   * or a character no userinfo may hold is an e-mail address run into a url
   * with no path (https://example.com;help@example.com).
   */
  function isCredentials(userinfo) {
    if (userinfo.includes(':')) return true;
    if (/[^\x00-\x7f]/.test(userinfo) || /[;,]/.test(userinfo)) return false;
    if (userinfo && !USERINFO.test(userinfo)) return false;
    return !(userinfo.length <= PLAIN_USER_MAX && PLAIN_USER.test(userinfo));
  }

  /**
   * Whether JSON in a value names a secret key (state={"token":"…"}), each
   * distinct key judged once, and by the rule for a parameter's name: the key
   * of a state the url carries is a parameter of it, so {"key":…} and
   * {"code":…} are as secret as ?key= and ?code=.
   */
  function secretKeyIn(text) {
    if (!text.includes('"')) return false;
    const seen = new Set();
    for (const [, key] of text.matchAll(JSON_KEY)) {
      if (seen.has(key)) continue;
      if (seen.size === MAX_JSON_KEYS) return true;
      seen.add(key);
      if (isSecretParam(key)) return true;
    }
    return false;
  }

  // isSecretName's test, with each word looked up rather than compared with
  // every secret word in turn, and skipped when no secret word appears in the
  // name's letters at all, which every name it matches has. A url can carry a
  // megabyte of names (its parameters, the keys of the JSON in them), chosen
  // by the page, and the word by word scan cost 250 ns a character. The same
  // words and the same answers: test/prompt.test.mjs holds the two to that.
  const SECRET_SET = new Set(SECRET_WORDS);
  const SECRET_ENDS = new Set([...SECRET_SET].filter((secret) => secret.length >= 5));
  const END_SIZES = [...new Set([...SECRET_ENDS].map((secret) => secret.length))];
  const ANY_SECRET = new RegExp([...SECRET_SET].join('|'));

  function isSecretNameQuick(name) {
    // ASCII letters only, as the words are made of. A letter of another
    // script that lowercases to one (the Kelvin sign) would split a match.
    if (!ANY_SECRET.test(name.replace(/[^A-Za-z]+/g, '').toLowerCase())) return false;
    const words = name
      .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
      .filter(Boolean)
      .map((word) => word.toLowerCase().replace(/(?<=[a-z])\d+$/, ''));
    return words.some(
      (word, index) =>
        SECRET_SET.has(word) ||
        (word.endsWith('s') && SECRET_SET.has(word.slice(0, -1))) ||
        SECRET_SET.has(word + (words[index + 1] || '')) ||
        END_SIZES.some(
          (size) => size <= word.length && (SECRET_ENDS.has(word.slice(0, size)) || SECRET_ENDS.has(word.slice(-size)))
        )
    );
  }

  /**
   * isSecretName with a bound on its cost. A name too long to be a field's (a
   * url or a blob used as a key or an id) is judged by its first and last 200
   * characters, where a field name sits, so that a name of a million
   * characters costs no more than a short one; the collector judges a long key
   * the same way.
   */
  function isSecretNameBounded(name) {
    if (name.length <= 400) return isSecretNameQuick(name);
    return isSecretNameQuick(name.slice(0, 200)) || isSecretNameQuick(name.slice(-200));
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
   * So is a value holding JSON with a secret key (an OAuth state of
   * {"token":…}, usually encoded as %7B%22token%22…), whose quotes and
   * braces a pair cannot be cut out of.
   */
  function nestedUrl(value, depth) {
    const holdsUrl = (text) => /[?#]/.test(text) || credentialsAt(text) !== null;
    if (secretKeyIn(value)) return REDACTED;
    if (holdsUrl(value)) return depth < MAX_NESTING ? screenUrl(value, depth + 1) : REDACTED;
    // %253F is a '?' encoded twice, as a return address inside a return
    // address's own encoding arrives. %22 is a quote, which JSON starts with.
    if (!/%(?:25)*(?:3F|23|40|22)/i.test(value)) return value;
    const decoded = decodeLoosely(value);
    if (holdsUrl(decoded)) {
      return depth < MAX_NESTING && screenUrl(decoded, depth + 1) === decoded ? value : REDACTED;
    }
    // Still encoded once more: decoded again, one level deeper.
    return depth < MAX_NESTING && nestedUrl(decoded, depth + 1) === decoded ? value : REDACTED;
  }

  /**
   * The text with each valid percent escape decoded and anything else left as
   * written. decodeURIComponent gives up on the whole text at one stray '%'
   * (width=100%), which left the escapes around it, and the link they spell,
   * unread. Bytes that are no UTF-8 are read one by one, which still finds an
   * ASCII '?', '#' or quote among them. Text whose every '%' starts an escape
   * of an ASCII byte cannot fail decodeURIComponent, and is decoded in one
   * call: a megabyte of values encoded twice took 100 ms run by run.
   */
  function decodeLoosely(text) {
    if (!/%(?![0-7][0-9a-f])/i.test(text)) return decodeURIComponent(text);
    return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, decodeRun);
  }

  /**
   * A run of escapes decoded: as UTF-8 when its bytes are UTF-8, else one
   * character for each byte. The bytes are checked before decodeURIComponent
   * is asked, rather than its throw caught: a megabyte of values each with a
   * byte that is no UTF-8 cost 300 ms in throws alone.
   */
  function decodeRun(run) {
    const bytes = [];
    for (let at = 1; at < run.length; at += 3) bytes.push(parseInt(run.slice(at, at + 2), 16));
    if (isUtf8(bytes)) {
      try {
        return decodeURIComponent(run);
      } catch {
        // isUtf8 accepts what decodeURIComponent does, so this is not reached.
      }
    }
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return text;
  }

  /**
   * Whether bytes are UTF-8 as decodeURIComponent reads it: no overlong form,
   * no surrogate, nothing past U+10FFFF, no sequence cut short.
   */
  function isUtf8(bytes) {
    for (let at = 0; at < bytes.length; ) {
      const lead = bytes[at];
      if (lead < 0x80) {
        at += 1;
        continue;
      }
      let size;
      if (lead >= 0xc2 && lead <= 0xdf) size = 2;
      else if (lead >= 0xe0 && lead <= 0xef) size = 3;
      else if (lead >= 0xf0 && lead <= 0xf4) size = 4;
      else return false;
      if (at + size > bytes.length) return false;
      // The second byte's range is narrower after four leads.
      const low = lead === 0xe0 ? 0xa0 : lead === 0xf0 ? 0x90 : 0x80;
      const high = lead === 0xed ? 0x9f : lead === 0xf4 ? 0x8f : 0xbf;
      if (bytes[at + 1] < low || bytes[at + 1] > high) return false;
      for (let next = 2; next < size; next += 1) {
        if (bytes[at + next] < 0x80 || bytes[at + next] > 0xbf) return false;
      }
      at += size;
    }
    return true;
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
   * null when what stands before the '@' is no credentials (isCredentials): a
   * plain user name, a run of another script up to an e-mail address, or an
   * e-mail address run into a url with no path.
   */
  function credentialsAt(url) {
    const found = CREDENTIALS.exec(url);
    return found && isCredentials(found[2]) ? found : null;
  }

  /**
   * The text with the credentials of every url in it removed, wherever the url
   * starts: a second url run into the first (https://cors.test/https://u:p@…),
   * one after letters of another script, or one written in JSON, whose ':\/\/'
   * is a '://'. After a scheme, a userinfo goes as isCredentials judges it, so
   * a url glued to a word (id=42ssh://git@github.com/…) keeps its user name as
   * one at the start of a line does. After a bare '//', which a comment or a
   * path can hold too, only one with a ':' in it, and only characters a
   * userinfo may hold, does: XPath writes //xs:element[@name='x'], whose '['
   * no userinfo has. Each stretch between two '/' is read once, so the cost is
   * one pass whatever the text.
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
      if (userinfo && (scheme ? isCredentials(userinfo) : loose && userinfo.includes(':'))) {
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
   * random letters. Content that is not base64 can still hold a link (an html
   * or svg document, percent encoded), and is masked whole when that link
   * carries a secret (see dataContent).
   */
  function maskPath(path, depth) {
    const comma = /^\s*data:/i.test(path) ? path.indexOf(',') : -1;
    const end = comma === -1 ? path.length : comma;
    const tail = comma === -1 ? '' : dataContent(path.slice(0, comma), path.slice(comma), depth);
    const semi = path.indexOf(';');
    if (semi === -1 || semi > end) return comma === -1 ? path : path.slice(0, comma) + tail;
    return path.slice(0, semi) + maskParams(path.slice(semi, end), depth) + tail;
  }

  /**
   * A data: url's content, from its comma, masked whole when a link inside
   * it carries credentials or a secret parameter. Read as written and then
   * decoded, since the link in data:text/html,%3Ca%20href%3D%22…%3Ftoken%3D…
   * is all escapes; put back encoded, a marker in it would print as
   * %3Credacted%3E. Decoded loosely, so one stray '%' does not hide the rest,
   * and again for each layer of encoding, as many as a value is followed
   * (MAX_NESTING), since content encoded twice shows its link only on the
   * second. Content still encoded past that, and still able to hold a link,
   * is masked whole, as a parameter nested past MAX_NESTING is. Only the query
   * and fragment of what it holds are read, never a ';' or a bare '=', which is
   * what an svg's styles and a nested base64 image's padding are made of.
   * Base64 content is left alone: it is no text to read.
   */
  function dataContent(head, content, depth) {
    const linkable = /[?#@]|%(?:25)*(?:3F|23|40)/i;
    if (/;\s*base64\s*$/i.test(head) || !linkable.test(content)) return content;
    const next = Math.min(depth + 1, MAX_NESTING);
    let text = content;
    for (let layer = 0; ; layer += 1) {
      if (withoutCredentials(text) !== text) return `,${REDACTED}`;
      for (const [part] of text.matchAll(/[?#][^\s"'<>`]*/g)) {
        if (maskParams(part, next) !== part) return `,${REDACTED}`;
      }
      const decoded = decodeLoosely(text);
      if (decoded === text) return content;
      if (layer === MAX_NESTING) return linkable.test(decoded) ? `,${REDACTED}` : content;
      text = decoded;
    }
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
    let hint = null;
    let shields = null;
    let active = false;
    // What the box is drawn around, and what Enter or a click picks.
    let current = null;
    // What the pointer was last over. The arrow keys move current away from
    // it, and a click over this same element picks what they moved to.
    let anchor = null;
    // The elements ArrowUp stepped out of, so that ArrowDown goes back down
    // the same way.
    let trail = [];
    // Where the box was last drawn, so a frame that finds the element where
    // it was changes nothing.
    let placed = '';
    // A primary button went down while armed. A pointerup without one, from a
    // press that began before the arm, is not a pick.
    let pressed = false;
    // The last trusted pointer position, looked at again after a scroll.
    let pointer = null;
    let scrolled = false;
    // The frame loop that keeps frames letting the pointer through and the
    // box on its element while armed.
    let frame = 0;
    let frameCount = 0;
    let frameList = [];
    // Every frame found, up to FRAME_BOXES, for frameAt() to hold the point
    // against: frameList keeps only the first 100 for the shields.
    let allFrames = [];
    // The stylesheet that makes frames let the pointer through (see
    // passFrames()), false where none can be made, whether it holds its
    // rule, and the trees that adopted it.
    let passSheet = null;
    let passRule = false;
    const passIn = new Set();
    // Pointers pressed while armed and not yet let go (see onSelectStart()).
    const downs = new Set();
    // The frames the sheet does not reach, which get a shield instead (see
    // shieldFrames()).
    let live = [];
    // The style each shield was last given.
    const shieldAt = [];
    // What was in the top layer when the host was last put above it.
    let layerSeen = new Set();
    // Open shadow roots, searched for frames to shield as well as the
    // document is.
    let roots = new Set();
    // The modal dialog the host was put in, and whether it is in the top
    // layer as a popover (see mount()).
    let mountedIn = null;
    let popover = false;
    // The moments after a pick (see beginTail()). The id tells a pick still
    // in flight that the tail it started has since been replaced.
    let tailOn = false;
    let tailId = 0;
    let tailTimer = 0;
    let tailCap = 0;
    let tailFrame = 0;
    // Presses that began in the tail and have not ended, by pointer id; the
    // wait after one ends for the rest of it (its click, a dblclick, a tap's
    // mouse events); and whether the tail's time is up, so that it ends as
    // soon as no press is left (see tailOver()).
    const tailPresses = new Set();
    let tailSettle = 0;
    let tailDue = false;
    // A pick made by a finger, read once its tap has moved the hover (see
    // commit()).
    let tapRead = null;
    // The keys whose keydown the picker answered, so that their keyup is
    // kept from the page too, and no other.
    const taken = new Set();

    const INSPECT_TIMEOUT_MS = 300;
    // How long presses are still kept from the page once the pick is sent.
    // The panel takes its screenshot on receipt, and retries a capture
    // refused by Chrome's quota after 600 ms; a press made in this time is
    // not the page's.
    const TAIL_MS = 1000;
    // However a pick ends, the page has its pointer back by then, even with
    // a press begun in the tail still held.
    const TAIL_LIMIT_MS = 5000;
    // A mouse press's click and dblclick come in the same task as its
    // pointerup. This long after it, the press is over.
    const SETTLE_MS = 50;
    // A tap's click follows its pointerup at once. One that never comes (the
    // finger was held, or the page cancelled the tap) is not waited for
    // longer than this.
    const TAP_MS = 400;
    // How many levels of a selector are tested for being unique. On a page of
    // 58 000 elements a test took up to 2 ms; past this the path runs to an id
    // or the top of its tree, which makes it unique without a test.
    const PATH_TESTS = 8;
    // The template prints this much of a selector and shortens a longer one
    // from its start, saying so.
    const SELECTOR_ROOM = 200;
    // A selector longer than this is no path a page builds but a page built
    // to make one (an id of a megabyte), and is cut to SELECTOR_ROOM here.
    const SELECTOR_LIMIT = 4000;
    // Where the keyboard looks for something to start from when nothing is
    // focused: the middle of the viewport, then across it.
    const START_POINTS = [
      [0.5, 0.5], [0.5, 0.25], [0.5, 0.75], [0.25, 0.5], [0.75, 0.5],
      [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75],
    ];
    // Elements looked at, in document order, for one in view, when none of
    // those points has one.
    const START_SCAN = 5000;
    // How many of them in view are hit tested, to see that they are drawn.
    const START_HITS = 200;
    // How much of a start must be in view each way, in pixels: a skip link
    // clipped to 1x1 is not something the user can see.
    const START_MIN = 4;
    const FRAMES = 'iframe, frame, embed, object';
    const FRAME_TAGS = ['iframe', 'frame', 'embed', 'object'];
    // How many frames frameAt() holds a point against: reading 2000 boxes
    // after a hit test takes well under a millisecond.
    const FRAME_BOXES = 2000;
    // Elements walked at arm time looking for open shadow roots.
    const ROOT_SCAN = 20000;
    const pending = new Map();
    // Bumped by stop(). A pick that was cancelled while its inspect was still
    // in flight must not arrive afterwards as a capture.
    let generation = 0;
    // A page with no MAIN world collector never answers, and there is no point
    // making every subsequent pick on that tab wait out the timeout again. This
    // is the case after the extension is reloaded, because Chrome does not
    // re-inject declared content scripts into tabs that are already open.
    //
    // Kept across arms: an arm allows one pick, so clearing this on every arm
    // made every pick on such a tab wait the full timeout. It does not latch
    // on one slow answer either. Each arm on a page that went silent pings the
    // MAIN world, which answers every request it is sent, and any answer
    // clears this, so a round trip that once lost a race to a busy main thread
    // costs the lookup for at most that one arm.
    let mainWorldSilent = false;
    let pingId = null;

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
      // Where the call site came from when it was not _debugSource: "stack"
      // is React 19's _debugStack, a position in the code the browser ran,
      // which the template must not print as an exact line. Any other value
      // is dropped, as an unknown field is.
      if (payload.sourceFrom === 'stack') component.sourceFrom = 'stack';
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

    /**
     * Whether the MAIN world has come back, asked of a page that went silent.
     * The collector answers every request, whatever its action, so the answer
     * itself is the news. Only one ping is outstanding at a time, so a page
     * with no collector does not collect one per arm.
     */
    function ping() {
      if (pingId) pending.delete(pingId);
      const id = 'ping' + Math.random().toString(36).slice(2);
      pingId = id;
      pending.set(id, () => {
        if (pingId === id) pingId = null;
        mainWorldSilent = false;
      });
      window.postMessage({ __cdr: 'request', id, action: 'ping' }, '*');
    }

    function build() {
      host = document.createElement('div');
      host.setAttribute('data-cdr-picker', '');
      // Every property a page rule could reach the host with, set inline and
      // important. In the top layer the host is a [popover], and pages style
      // those: a fade in, a background, a border, a size that fits content.
      host.style.cssText = [
        'position:fixed',
        'inset:0',
        'width:auto',
        'height:auto',
        'max-width:none',
        'max-height:none',
        'z-index:2147483647',
        'pointer-events:none',
        'margin:0',
        'padding:0',
        'border:0',
        'background:transparent',
        'overflow:visible',
        'display:block',
        'opacity:1',
        'visibility:visible',
        'transform:none',
        'filter:none',
        'transition:none',
        'animation:none',
      ]
        .map((rule) => rule + ' !important')
        .join(';');

      shadow = host.attachShadow({ mode: 'closed' });
      shadow.innerHTML = `
        <style>
          :host { all: initial; }
          /* In the top layer the host is a popover, and a popover gets a
             backdrop that a page's ::backdrop rule dims or blurs, over a
             modal dialog and in the screenshot. No inline style reaches a
             pseudo-element, but an important rule in here outranks one of
             the page's, important or not (checked in Chrome). */
          :host::backdrop { display: none !important; }
          .shield {
            position: fixed;
            pointer-events: auto;
            display: none;
          }
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
        <div class="shields"></div>
        <div class="box"></div>
        <div class="tag"></div>
        <div class="hint">Click an element to capture it &nbsp;·&nbsp; <b>↑</b> <b>↓</b> parent or child, <b>Enter</b> to capture &nbsp;·&nbsp; <b>Esc</b> to cancel</div>
      `;

      box = shadow.querySelector('.box');
      tag = shadow.querySelector('.tag');
      hint = shadow.querySelector('.hint');
      shields = shadow.querySelector('.shields');
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
      placed = `${r.left},${r.top},${r.width},${r.height}`;
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
     * A selector that finds the element again, and nothing else.
     *
     * Inside a shadow root the path stops at the root, since no CSS selector
     * crosses a shadow boundary, and the host's own path goes in front of it,
     * joined with >>>, the deep combinator Puppeteer and WebdriverIO read. So
     * `x-app >>> button.save` is the save button inside x-app's shadow root.
     *
     * Kept to what the template prints where it can be: past that,
     * ancestors lose their classes. A path still longer is sent whole, every
     * level of every tree, so that it still finds the element from the
     * document. Cutting it here dropped whole shadow trees from its start,
     * and the rest matched nothing, with no sign of the cut; the template
     * shortens it for the prompt instead, and says that it did.
     */
    function cssPath(element) {
      const trees = [];
      for (let node = element; node && trees.length < 16; ) {
        const root = node.getRootNode();
        trees.unshift({ node, root });
        node = root.nodeType === 11 && root.host ? root.host : null;
      }
      const join = (paths) => paths.map((path) => path.join(' > ')).join(' >>> ');
      let text = join(trees.map(({ node, root }) => pathIn(node, root, () => 3)));
      if (text.length > SELECTOR_ROOM) {
        text = join(trees.map(({ node, root }) => pathIn(node, root, (level) => (level === 0 ? 3 : 0))));
      }
      if (text.length > SELECTOR_LIMIT) text = levelOf(element, 0).slice(0, SELECTOR_ROOM);
      return text;
    }

    /**
     * The levels of a path from the top of one tree (the document or a shadow
     * root) down to the element. Each level is the tag, up to `classes(level)`
     * classes, and :nth-of-type when a sibling shares the tag, so given its
     * parent a level names exactly one child.
     *
     * Levels are added from the element up until the path matches nothing
     * else, as tested, or an id that is unique is reached. It used to stop at
     * six levels untested, so rows of repeated cards shared one selector. A
     * path that reaches the top untested is tested once more, and given the
     * top in front if that fails, which makes it unique by construction.
     *
     * Stops at body: `html > body >` prefixes every path on every page and
     * helps nobody locate the code behind an element, so `body` is put in
     * front only when the path needs it.
     */
    function pathIn(element, root, classes) {
      const top = root.nodeType === 9 ? root.body : null;
      const unique = (levels) => {
        try {
          const found = root.querySelectorAll(levels.join(' > '));
          return found.length === 1 && found[0] === element;
        } catch {
          return false;
        }
      };
      const levels = [];
      let tests = 0;
      let node = element;
      for (; node && node.nodeType === 1 && node !== top && node !== root.documentElement; node = node.parentElement) {
        const id = uniqueId(node, root);
        if (id) {
          levels.unshift(id);
          return levels;
        }
        levels.unshift(levelOf(node, classes(levels.length)));
        if (tests < PATH_TESTS) {
          tests += 1;
          if (unique(levels)) return levels;
        }
      }
      if (tests >= PATH_TESTS && unique(levels)) return levels;
      // Probed in Chrome: a shadow root's querySelectorAll reads :host > as
      // the root's own children.
      if (root.nodeType !== 9) levels.unshift(':host');
      else levels.unshift(node && node === top ? 'body' : ':root');
      return levels;
    }

    function uniqueId(node, root) {
      if (!node.id) return '';
      try {
        const selector = '#' + CSS.escape(node.id);
        return root.querySelectorAll(selector).length === 1 ? selector : '';
      } catch {
        return ''; /* exotic id, fall through to the class/index path */
      }
    }

    function levelOf(node, classes) {
      // localName, not tagName: an SVG element keeps its case
      // (foreignObject), and a name the parser let hold a '<' is escaped.
      let part = CSS.escape(node.localName);
      const names = Array.from(node.classList)
        .filter((c) => c && !/^\d/.test(c))
        .slice(0, classes);
      if (names.length) {
        part += '.' + names.map((c) => CSS.escape(c)).join('.');
      }
      // The top level of a shadow root has the root, not an element, above it.
      const parent = node.parentElement || node.parentNode;
      if (parent && parent.children) {
        const siblings = Array.from(parent.children).filter(
          (c) => c.localName === node.localName && c.namespaceURI === node.namespaceURI
        );
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      return part;
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
    // scrolls into view. An object's document is its data, and it is picked
    // whole, so that attribute prints as it is.
    const URL_ATTRIBUTES = [
      'href', 'src', 'action', 'formaction', 'poster', 'ping', 'xlink:href', 'data-src', 'data-href',
      'data', 'codebase', 'cite', 'background', 'longdesc', 'manifest',
    ];

    // Lists of urls, each candidate with a query of its own. A preload link
    // names its images in imagesrcset.
    const URL_LISTS = ['srcset', 'data-srcset', 'imagesrcset'];

    // An iframe's srcdoc longer than this is hidden whole rather than read:
    // it is a document of its own, and parsing it costs the page's time.
    const MAX_DOCUMENT = 100000;
    // How deep a srcdoc inside a srcdoc is read before it is hidden whole.
    let documentDepth = 0;

    // A value written as JSON (a React or Inertia mount point's props,
    // data-props, a widget's config) is read as JSON up to this size, and a
    // longer one is hidden whole, as a long srcdoc is: parsing it costs the
    // page's time.
    const MAX_JSON_VALUE = MAX_DOCUMENT;
    // How many keys and values of it are looked at before it is taken for a
    // blob and hidden whole.
    const MAX_JSON_NODES = 20000;
    // How many times JSON a raw '&' cut is looked for again in one url.
    const MAX_JSON_SPANS = 8;

    // What outerHTML writes in an attribute's value in place of a character:
    // '&', '"' and a no-break space, and from Chrome 138 '<' and '>' as well.
    // A value is judged as the page set it, so JSON in an href
    // (state={&quot;token&quot;:…}) shows its quotes to the JSON check.
    const ENTITY = /&(?:amp|quot|nbsp|lt|gt);/g;
    const ENTITIES = { '&amp;': '&', '&quot;': '"', '&nbsp;': '\u00a0', '&lt;': '<', '&gt;': '>' };

    function unescapeValue(value) {
      return value.includes('&') ? value.replace(ENTITY, (entity) => ENTITIES[entity]) : value;
    }

    // Written back in the double quotes the value sits in. A '<' or '>' is
    // left as it is, which is still markup that reads the same, so that the
    // marker prints as <redacted> and not as &lt;redacted&gt;.
    function escapeValue(value) {
      return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\u00a0/g, '&nbsp;');
    }

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
      const type = (get('type') || '').toLowerCase();
      // A custom element password field (<pin-input type="password">),
      // whose value React 18 sets as an attribute.
      if (type === 'password') return true;
      if (!['input', 'textarea', 'select', 'button'].includes(tag)) return false;
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
      if (URL_ATTRIBUTES.includes(lower)) return screenUrlValue(value);
      // A candidate ends at the comma before the next one, but a url can
      // hold a comma of its own (an image CDN's w_100,h_100).
      if (URL_LISTS.includes(lower)) {
        return value.replace(/[^\s,][^\s]*?(?=,?(?:\s|$))/g, (url) => screenUrlValue(url));
      }
      // A signed background image. Markup writes the quotes as &quot;.
      if (lower === 'style') {
        return value.replace(STYLE_URL, (whole, double, single, entity, bare) => {
          const url = double ?? single ?? entity ?? bare;
          const masked = screenUrlValue(url);
          if (masked === url) return whole;
          const quote = double != null ? '"' : single != null ? "'" : entity != null ? '&quot;' : '';
          return `url(${quote}${masked}${quote})`;
        });
      }
      if (lower === 'srcdoc') return maskDocument(value);
      return maskJson(value, 0);
    }

    /**
     * A url as safeUrl masks it, with a data: url's content read whole
     * first. safeUrl cuts a url at its first literal '?', and a data: url's
     * content can hold one with the rest of a link still encoded after it
     * (data:text/html,%3Ca href%3D%22https://x/?token%3D…), so the content
     * was cut before dataContent could read it.
     */
    function screenUrlValue(url) {
      if (/^\s*data:/i.test(url)) {
        const read = maskPath(url, 0);
        if (read !== url) return read;
      }
      return splitJson(safeUrl(url));
    }

    // A key in JSON, or in a JavaScript object written in single quotes
    // ({'token':…}), which a url carries now and then too.
    const QUOTED_KEY = /(["'])([^"'\\]*)\1\s*:/g;

    /**
     * A url with any JSON in its query or fragment that still names a
     * secret key once safeUrl is done hidden, from its opening bracket to
     * its close. safeUrl reads a query pair by pair, and a raw '&' in a
     * string of the JSON (or its \u0026) ends a pair, so in
     * ?s={"user":"a&b","token":"…"} the key after it was read as no
     * parameter at all; and it reads only double quoted keys. JSON percent
     * encoded around a raw '&' is hidden from its first bracket on. Keys are
     * judged by the rule for a parameter's name, as secretKeyIn judges them.
     */
    function splitJson(url) {
      const at = url.search(/[?#]/);
      if (at === -1 || !/[[{]|%5B|%7B/i.test(url.slice(at))) return url;
      let rest = url.slice(at);
      for (let round = 0; round < MAX_JSON_SPANS; round += 1) {
        // Never 0: rest starts with its '?' or '#'.
        const key = secretKeyAt(rest);
        const span = key > 0 ? jsonAround(rest, key) : null;
        if (!span) break;
        rest = rest.slice(0, span[0]) + REDACTED + rest.slice(span[1]);
      }
      if (secretKeyAt(rest) !== -1 || secretKeyAt(decodeLoosely(rest)) !== -1) {
        let cut = rest.search(/[[{]|%5B|%7B/i);
        if (cut === -1 || secretKeyAt(decodeLoosely(rest.slice(0, cut))) !== -1) cut = 1;
        rest = rest.slice(0, cut) + REDACTED;
      }
      return rest === url.slice(at) ? url : url.slice(0, at) + rest;
    }

    // Where the first key in text that names a secret starts, -1 when none
    // does, and 0 past MAX_JSON_KEYS distinct keys, which make a blob.
    function secretKeyAt(text) {
      if (!/["']/.test(text)) return -1;
      const seen = new Set();
      for (const match of text.matchAll(QUOTED_KEY)) {
        const key = match[2];
        if (seen.has(key)) continue;
        if (seen.size === MAX_JSON_KEYS) return 0;
        seen.add(key);
        if (isSecretParam(key)) return match.index;
      }
      return -1;
    }

    /**
     * Where the outermost JSON around a position starts and ends, as
     * [start, end], reading strings as JSON writes them (or in single
     * quotes) so that a bracket in one counts for nothing; null when no
     * bracket is open there. A JSON that never closes runs to the end of
     * the text.
     */
    function jsonAround(text, index) {
      let start = -1;
      let depth = 0;
      let quoted = '';
      for (let i = 0; i < text.length; i += 1) {
        const c = text[i];
        if (i === index && depth === 0) return null;
        if (quoted) {
          if (c === '\\') i += 1;
          else if (c === quoted) quoted = '';
        } else if (c === '"' || c === "'") {
          quoted = c;
        } else if (c === '{' || c === '[') {
          if (depth === 0) start = i;
          depth += 1;
        } else if ((c === '}' || c === ']') && depth > 0) {
          depth -= 1;
          if (depth === 0 && i > index) return [start, i + 1];
        }
      }
      return depth > 0 && start <= index ? [start, text.length] : null;
    }

    // A token of JSON: a string, a bracket or separator, or a number or
    // literal.
    const JSON_TOKEN = /"(?:[^"\\]|\\.)*"|[{}[\],:]|[^\s{}[\],:"]+/g;

    /**
     * An attribute's value that is JSON (data-props, data-page, a widget's
     * config), with the value of every key named for a secret hidden, as a
     * prop of that name is, the secrets of any url in its strings masked,
     * and JSON written into one of its strings read the same way. Hidden
     * where it stands, and the rest left as the page wrote it: a parsed and
     * rewritten copy lost the digits of a big number, and the page's
     * spacing and escapes. Handed back as it was when nothing is hidden. A
     * value that only looks like JSON is read as a JavaScript object (see
     * maskLiteral()). One longer than MAX_JSON_VALUE, and one of more than
     * MAX_JSON_NODES keys and values, are hidden whole. A null or a boolean
     * hides nothing.
     */
    function maskJson(value, depth) {
      const text = value.trim();
      const ends = text[0] + text[text.length - 1];
      if ((ends !== '{}' && ends !== '[]') || !/["':]/.test(text)) return value;
      if (text.length > MAX_JSON_VALUE || depth >= MAX_NESTING) return REDACTED;
      try {
        JSON.parse(text);
      } catch {
        return maskLiteral(value, text);
      }
      const tokens = [...text.matchAll(JSON_TOKEN)];
      const edits = [];
      let at = 0;
      let budget = MAX_JSON_NODES;
      const skip = () => {
        let open = 0;
        do {
          const token = tokens[at][0];
          at += 1;
          if (token === '{' || token === '[') open += 1;
          else if (token === '}' || token === ']') open -= 1;
        } while (open > 0);
      };
      const walk = () => {
        budget -= 1;
        if (budget < 0) throw new RangeError('a blob');
        const token = tokens[at];
        at += 1;
        const written = token[0];
        if (written === '{' || written === '[') {
          if (tokens[at][0] === (written === '{' ? '}' : ']')) {
            at += 1;
            return;
          }
          for (;;) {
            const first = written === '{' ? tokens[at + 2] : null;
            if (first && !['null', 'true', 'false'].includes(first[0]) && isSecretNameBounded(JSON.parse(tokens[at][0]))) {
              at += 2;
              skip();
              const last = tokens[at - 1];
              edits.push([first.index, last.index + last[0].length, JSON.stringify(REDACTED)]);
            } else {
              if (first) at += 2;
              walk();
            }
            at += 1;
            if (tokens[at - 1][0] !== ',') return;
          }
        }
        if (written[0] === '"') {
          const node = JSON.parse(written);
          const nested = maskJson(node, depth + 1);
          const masked = nested !== node ? nested : screenUrlValue(node);
          if (masked !== node) edits.push([token.index, token.index + written.length, JSON.stringify(masked)]);
        }
      };
      try {
        walk();
      } catch {
        return REDACTED;
      }
      return edits.length ? spliced(value, text, edits) : value;
    }

    // The value with each [from, to, text] edit of its trimmed text made,
    // in order, and its spacing around it kept.
    function spliced(value, text, edits) {
      const lead = value.length - value.trimStart().length;
      let out = value.slice(0, lead);
      let kept = 0;
      for (const [from, to, put] of edits) {
        out += text.slice(kept, from) + put;
        kept = to;
      }
      return out + text.slice(kept) + value.slice(lead + text.length);
    }

    // A key in a JavaScript object: bare, or in either quotes.
    const LITERAL_KEY = /([A-Za-z_$][\w$]*|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*:/y;

    /**
     * A value that looks like JSON and is not: a JavaScript object written
     * into an attribute (Alpine's x-data, a Vue binding), whose keys may be
     * bare or in single quotes. The value of each key named for a secret is
     * hidden where it stands, a string's own quotes kept, unless it is
     * true, false, null or undefined. Strings are read past, so that a key
     * inside one is not taken for one. One that still names a secret JSON
     * key after that (JSON written into a string, or not quite JSON) is
     * hidden whole, as is one of more than MAX_JSON_KEYS distinct keys. One
     * pass, whatever the text.
     */
    function maskLiteral(value, text) {
      const edits = [];
      const judged = new Map();
      let keyed = false;
      for (let at = 0; at < text.length; ) {
        const c = text[at];
        if (keyed && /\s/.test(c)) {
          at += 1;
          continue;
        }
        if (keyed) {
          keyed = false;
          LITERAL_KEY.lastIndex = at;
          const found = LITERAL_KEY.exec(text);
          if (found) {
            at = LITERAL_KEY.lastIndex;
            const name = /^['"]/.test(found[1]) ? found[1].slice(1, -1) : found[1];
            if (!judged.has(name)) {
              if (judged.size === MAX_JSON_KEYS) return REDACTED;
              judged.set(name, isSecretNameBounded(name));
            }
            if (judged.get(name)) {
              const end = literalEnd(text, at);
              const written = text.slice(at, end).trim();
              const from = text.indexOf(written, at);
              if (written && !/^(?:true|false|null|undefined)$/.test(written)) {
                const quote = /^(['"`])[\s\S]*\1$/.test(written) ? written[0] : "'";
                edits.push([from, from + written.length, quote + REDACTED + quote]);
              }
              at = end;
            }
            continue;
          }
        }
        if (c === '"' || c === "'" || c === '`') {
          at = stringEnd(text, at);
          continue;
        }
        if (c === '{' || c === ',') keyed = true;
        at += 1;
      }
      const masked = edits.length ? spliced(value, text, edits) : value;
      return namesSecret(masked) ? REDACTED : masked;
    }

    // Where a string that starts at `at` ends, past its closing quote.
    function stringEnd(text, at) {
      for (let index = at + 1; index < text.length; index += 1) {
        if (text[index] === '\\') index += 1;
        else if (text[index] === text[at]) return index + 1;
      }
      return text.length;
    }

    // Where a value in a JavaScript object that starts at `at` ends: at the
    // ',' or the closing bracket after it at its own depth.
    function literalEnd(text, at) {
      let open = 0;
      for (let index = at; index < text.length; ) {
        const c = text[index];
        if (c === '"' || c === "'" || c === '`') {
          index = stringEnd(text, index);
          continue;
        }
        if (c === '{' || c === '[' || c === '(') open += 1;
        else if (c === '}' || c === ']' || c === ')') {
          if (open === 0) return index;
          open -= 1;
        } else if (c === ',' && open === 0) return index;
        index += 1;
      }
      return text.length;
    }

    // Whether text that is not quite JSON names a secret key, each distinct
    // key judged once; past MAX_JSON_KEYS of them it is a blob.
    function namesSecret(text) {
      const seen = new Set();
      for (const [, key] of text.matchAll(JSON_KEY)) {
        if (seen.has(key)) continue;
        if (seen.size === MAX_JSON_KEYS) return true;
        seen.add(key);
        if (isSecretNameBounded(key)) return true;
      }
      return false;
    }

    /**
     * An iframe's srcdoc, a document written into one attribute, hidden
     * whole when anything in it would be masked: an attribute maskMarkup
     * hides, or a link in its text with credentials or a secret parameter.
     * The browser's own parser reads it first where there is one, since the
     * page may have written its attributes in single quotes or none, and
     * maskMarkup reads the double quotes outerHTML writes.
     */
    function maskDocument(html) {
      if (html.length > MAX_DOCUMENT || documentDepth >= MAX_NESTING) return REDACTED;
      documentDepth += 1;
      try {
        let source = html;
        if (typeof DOMParser === 'function') {
          try {
            source = new DOMParser().parseFromString(html, 'text/html').documentElement.outerHTML;
          } catch {
            /* read as it is written */
          }
        }
        if (maskMarkup(source) !== source || dataContent('', unescapeValue(source), 0) !== unescapeValue(source)) {
          return REDACTED;
        }
        return html;
      } finally {
        documentDepth -= 1;
      }
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
    const TAG_NAME = `<([A-Za-z][^\\s/<>]*|(?<=[^\\s/>]<)(?![A-Za-z])[^\\s/<>]*)`;
    // What tagScanner() finds, as one pattern. Nothing runs it: from a '<'
    // that starts no tag it read on through the same run of attributes as
    // the '<' before it did, and the scanner is how that is avoided.
    // test/picker.test.mjs holds the two to the same answers.
    const OPEN_TAG = new RegExp(`${TAG_NAME}(${ATTRIBUTES})(\\s*\\/?)>`, 'g');
    const ATTRIBUTE = new RegExp(`(\\s+)(${ATTRIBUTE_NAME})="([^"]*)"`, 'g');

    // OPEN_TAG in its three parts, each matched only where it stands.
    const TAG_HEAD = new RegExp(TAG_NAME, 'y');
    const ONE_ATTRIBUTE = new RegExp(`\\s+${ATTRIBUTE_NAME}="[^"]*"`, 'y');
    const TAG_END = /(\s*\/?)>/y;

    /**
     * The opening tags of html in order, one per call, as OPEN_TAG finds
     * them, and null after the last.
     *
     * OPEN_TAG was tried again from every '<' that started no tag, and in
     * script text, a comment, or a long run of attributes named with a '<'
     * (<a <a="1" <a="1"…), each try read on through the same run to its end:
     * 1.7 s for 100 kB, in the page, when an element holding it was picked.
     * Here the end of a run of attributes is remembered by where the run
     * starts, so each run is read once, whichever '<' reached it.
     *
     * The answers are the same because OPEN_TAG can match only one way from
     * a given '<'. No part of it can hand characters back for the next to
     * use: a name stops at the space, '/', '<' or '>' that nothing else may
     * start with, a value at its closing quote, and fewer attributes leave
     * an attribute name where the closing '>' would have to be.
     */
    function tagScanner(html) {
      const runs = new Map();
      // Where the run of attributes starting at `at` ends. Each position is
      // read once, and every one passed on the way learns the same end.
      const runEnd = (at) => {
        const passed = [];
        let end = at;
        while (!runs.has(end)) {
          ONE_ATTRIBUTE.lastIndex = end;
          if (!ONE_ATTRIBUTE.exec(html)) {
            runs.set(end, end);
            break;
          }
          passed.push(end);
          end = ONE_ATTRIBUTE.lastIndex;
        }
        const last = runs.get(end);
        for (const position of passed) runs.set(position, last);
        return last;
      };
      let lt = html.indexOf('<');
      return function next() {
        while (lt !== -1) {
          const at = lt;
          TAG_HEAD.lastIndex = at;
          const head = TAG_HEAD.exec(html);
          if (head) {
            const from = TAG_HEAD.lastIndex;
            const to = runEnd(from);
            TAG_END.lastIndex = to;
            const end = TAG_END.exec(html);
            if (end) {
              const index = TAG_END.lastIndex;
              lt = html.indexOf('<', index);
              return { index: at, end: index, name: head[1], attrs: html.slice(from, to), close: end[1] };
            }
          }
          lt = html.indexOf('<', at + 1);
        }
        return null;
      };
    }

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
     * script's text can only hide too much, never too little. Each value is
     * judged as the page set it, its entities read (see unescapeValue), as
     * attributes() judges it.
     */
    function maskMarkup(html) {
      const next = tagScanner(html);
      let out = '';
      let kept = 0;
      for (let found = next(); found; found = next()) {
        const { name, attrs, close } = found;
        const list = [...attrs.matchAll(ATTRIBUTE)];
        const get = (wanted) => {
          const value = list.find((match) => match[2].toLowerCase() === wanted)?.[3];
          return value == null ? null : unescapeValue(value);
        };
        const control = secretControl(name.toLowerCase(), get);
        let changed = false;
        const rebuilt = list.map(([whole, space, attr, value]) => {
          const raw = unescapeValue(value);
          const masked = maskAttribute(attr, raw, control);
          if (masked === raw) return whole;
          changed = true;
          return `${space}${attr}="${escapeValue(masked)}"`;
        });
        if (!changed) continue;
        out += `${html.slice(kept, found.index)}<${name}${rebuilt.join('')}${close}>`;
        kept = found.end;
      }
      return (kept ? out + html.slice(kept) : html).replace(TEXTAREA, (whole, open, attrs) => {
        const list = [...attrs.matchAll(ATTRIBUTE)];
        const get = (wanted) => {
          const value = list.find((match) => match[2].toLowerCase() === wanted)?.[3];
          return value == null ? null : unescapeValue(value);
        };
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
      const nextTag = tagScanner(html);
      TEXTAREA_START.lastIndex = 0;
      let tag = nextTag();
      let area = TEXTAREA_START.exec(html);
      for (;;) {
        while (tag && tag.index < cut) {
          cut = Math.max(cut, tag.end);
          tag = nextTag();
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

    // ------------------------------------------------------------- events ---

    // Every event of a press, kept from the page while armed and for a moment
    // after the pick (see beginTail()). Only mousedown, mouseup and click used
    // to be, so a trigger that opens on pointerdown (the Radix pattern) opened
    // under the picker, and the payload described it as open.
    //
    // Where the default is something the page would see (focus, a selection,
    // a link followed, a box ticked, a middle click opening a tab), it is
    // cancelled too. A pointer event's own default is not: cancelling
    // pointerdown suppresses the mousedown after it, and with it the one place
    // where focus and selection can be cancelled. The browser's own context
    // menu stays, and touch listeners are passive, so those are only stopped.
    //
    // A right press selects a word whatever became of its mousedown (see
    // onSelectStart()). A finger's press captures its pointer to what it
    // pressed, which the page heard as gotpointercapture and
    // lostpointercapture.
    const CANCELLED = ['mousedown', 'mouseup', 'click', 'dblclick', 'auxclick'];
    const STOPPED = [
      'pointerdown', 'pointerup', 'pointercancel', 'contextmenu', 'touchstart', 'touchend',
      'gotpointercapture', 'lostpointercapture',
    ];
    const PRESS = [...CANCELLED, ...STOPPED];
    // What the tail listens for (see beginTail()).
    const TAIL_EVENTS = [...PRESS, 'keydown', 'keypress', 'keyup'];

    // The keys the picker answers while armed (see step()). Every other key,
    // Tab among them, still reaches the page.
    const STEP_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'];

    function listenOptions(type) {
      return type.startsWith('touch') ? { capture: true, passive: true } : true;
    }

    function swallow(event) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    }

    function hold(event) {
      if (CANCELLED.includes(event.type) || event.type.startsWith('key')) {
        swallow(event);
        return;
      }
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (event.type === 'pointerdown' && event.pointerType === 'touch') uncapture(event);
    }

    // The capture a finger's press takes, let go as the press begins, so
    // that there is no gotpointercapture or lostpointercapture for a page
    // listener added before the picker's to hear either. What cannot be let
    // go (a target in a closed shadow root) is stopped all the same.
    function uncapture(event) {
      try {
        const target = typeof event.composedPath === 'function' ? event.composedPath()[0] : event.target;
        if (target && typeof target.hasPointerCapture === 'function' && target.hasPointerCapture(event.pointerId)) {
          target.releasePointerCapture(event.pointerId);
        }
      } catch {
        /* stopped all the same (STOPPED) */
      }
    }

    /**
     * The element under a point, as deep as the page lets anyone look: past
     * the picker's own shields, and into open shadow roots, whose content
     * elementFromPoint reports as their host, and where the pick used to stop.
     * A closed root keeps its host, which is as far as the page allows.
     *
     * Frames let the pointer through while armed (see passFrames()), and so
     * a hit test goes through them too. A frame is found by its box instead
     * (see frameAt()). Taking the sheet off for each look found it too, but
     * restyled the whole page on every move: 28 ms a move at 100 000
     * elements (measured in Chrome).
     */
    function pickAt(x, y) {
      const element = deepest(x, y);
      return frameAt(x, y, element) || (pickable(element) ? element : null);
    }

    function deepest(x, y) {
      let element = under(document, x, y);
      for (let depth = 0; element && element.shadowRoot && depth < 32; depth += 1) {
        const root = element.shadowRoot;
        const inner = under(root, x, y);
        if (!inner || inner === element || !(root.contains(inner) || element.contains(inner))) break;
        roots.add(root);
        element = inner;
      }
      return element;
    }

    /**
     * The frame at a point, or null. With the sheet on, the hit test passes
     * through every frame, so it cannot say whether one is there: where the
     * point is in no frame's box, which is nearly every move, none is, and
     * that costs only reading the boxes. Where it is in one, the browser is
     * asked once with the sheet off, which restyles the page as every look
     * once did, and answers for clipping, stacking, visibility, rounded
     * corners and fixed frames as drawing does: a frame whose box holds the
     * point is not always what is drawn there (a carousel's slide out of
     * view, a frame under another, an <object> showing its fallback). A
     * frame the page itself gives pointer-events:none is passed through, as
     * the page passes it. What it finds inside an <object> is its fallback
     * content, which the sheet passes through too, and is picked.
     *
     * The box is taken a pixel wider on each side: a frame at a fractional
     * offset is drawn and hit tested on a pixel row its box starts just
     * past (checked in Chrome), and the lifted hit test decides there.
     *
     * The boxes are read here, after the hit test, which has brought the
     * layout up to date, so they cost no layout of their own.
     */
    function frameAt(x, y, element) {
      if (!element) return null;
      let boxed = false;
      for (let index = 0; index < allFrames.length && !boxed; index += 1) {
        const frame = allFrames[index];
        if (!frame.isConnected) continue;
        const r = frame.getBoundingClientRect();
        boxed = x >= r.left - 1 && x < r.right + 1 && y >= r.top - 1 && y < r.bottom + 1;
      }
      if (!boxed) return null;
      const lift = Boolean(passSheet) && !passSheet.disabled;
      if (lift) passSheet.disabled = true;
      try {
        const top = deepest(x, y);
        if (!top) return null;
        if (FRAME_TAGS.includes(top.localName)) return top;
        let node = top.parentNode;
        while (node && node.nodeType === 1 && node.localName !== 'object') node = node.parentNode;
        return node && node.nodeType === 1 && pickable(top) ? top : null;
      } finally {
        if (lift) passSheet.disabled = false;
      }
    }

    // The topmost element at a point within one tree. The host is looked
    // through: it is there to catch events over frames, not to be picked.
    function under(scope, x, y) {
      const hit = scope.elementFromPoint(x, y);
      if (hit !== host) return hit;
      return scope.elementsFromPoint(x, y).find((node) => node !== host) || null;
    }

    function pickable(element) {
      return (
        Boolean(element) &&
        element.nodeType === 1 &&
        element !== host &&
        element !== document.documentElement &&
        element !== document.body
      );
    }

    function hostOf(element) {
      const root = element.getRootNode ? element.getRootNode() : null;
      return root && root.nodeType === 11 && root.host ? root.host : null;
    }

    function hovering(element) {
      try {
        return element.matches(':hover');
      } catch {
        return false;
      }
    }

    function forget() {
      current = null;
      anchor = null;
      trail = [];
      placed = '';
      box.style.display = 'none';
      tag.style.display = 'none';
    }

    function hover(x, y) {
      const element = pickAt(x, y);
      if (!element || element === anchor) return;
      anchor = element;
      trail = [];
      highlight(element);
    }

    function onMouseMove(event) {
      if (!event.isTrusted) return;
      // No button is down: a release the page never heard of (a native
      // context menu takes it) leaves no press behind.
      if (event.buttons === 0) downs.clear();
      pointer = { x: event.clientX, y: event.clientY };
      hover(event.clientX, event.clientY);
    }

    /**
     * Only a press selects anything while armed and in the tail: a right
     * press, or a Ctrl+click on macOS, selects the word under the pointer
     * as the context menu opens, whatever became of the mousedown, which
     * cancelling selectstart is what keeps from the page (checked in Chrome
     * 156). A selection made from the keyboard (Cmd+A in a field) or by the
     * page's own script (select all) is the page's.
     */
    function onSelectStart(event) {
      if (event.isTrusted && (downs.size || tailPresses.size)) swallow(event);
    }

    /**
     * The pointer reached a frame, so the frame took it: the page set its
     * own sheets since the last frame, or the frame is in a shadow root not
     * known yet. The sheet goes back, or into that root, before the press
     * that follows, which would have gone into the frame.
     */
    function onFrameOver(event) {
      if (!event.isTrusted) return;
      const target = typeof event.composedPath === 'function' ? event.composedPath()[0] : event.target;
      try {
        if (!target || target.nodeType !== 1 || !target.matches(FRAMES)) return;
        const scope = target.getRootNode();
        if (scope.nodeType === 11 && scope.host) roots.add(scope);
        passFrames();
        if (!frameList.includes(target)) frameList.push(target);
        if (!allFrames.includes(target) && allFrames.length < FRAME_BOXES) allFrames.push(target);
      } catch {
        /* the loop finds it */
      }
    }

    /**
     * The pick is made on pointerup rather than on click. Chrome sends a
     * disabled control pointer events and no mouse events at all, so a click
     * never came and a disabled button could not be picked.
     *
     * Events a page script dispatched itself are ignored here and in every
     * handler below, and left to reach the page: one could otherwise pick, or
     * cancel, on the user's behalf.
     */
    function onPointer(event) {
      if (!event.isTrusted) return;
      hold(event);
      if (event.type === 'pointerdown') {
        downs.add(event.pointerId);
        keepPassing();
      } else if (event.type === 'pointerup' || event.type === 'pointercancel') {
        downs.delete(event.pointerId);
      }
      // A second finger neither starts a pick nor ends the first one's.
      if (event.isPrimary === false) return;
      if (event.type === 'pointerdown') {
        pressed = event.button === 0;
      } else if (event.type === 'pointercancel') {
        pressed = false;
      } else if (event.type === 'pointerup' && pressed && event.button === 0) {
        pressed = false;
        commitAt(event.clientX, event.clientY, event.pointerType === 'touch');
      }
    }

    /**
     * What a press at this point picks: the element under it now. The node
     * highlighted last can be gone, replaced by a render or scrolled away
     * under a still pointer. Only when the pointer is still over the element
     * it was last over is the highlight taken instead, since the arrow keys
     * may have moved it to a parent.
     */
    function commitAt(x, y, tap) {
      // A frame put in since the last survey (every 15 frames) would not be
      // in allFrames yet, and the sheet passes the pointer through it.
      findFrames();
      const hit = pickAt(x, y);
      const element = hit && hit !== anchor ? hit : current && current.isConnected ? current : hit;
      if (element) commit(element, tap);
    }

    function onKeyDown(event) {
      if (!event.isTrusted) return;
      if (event.key === 'Escape') {
        swallow(event);
        stop();
        send({ type: 'cdr:capture-cancelled', mode: 'element' });
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      if (!STEP_KEYS.includes(event.key)) return;
      // A key that found nothing to do is the page's (see step()).
      if (!step(event.key)) return;
      swallow(event);
      taken.add(event.key);
    }

    // The keyup of a key the picker answered, so a page that acts on keyup
    // does not act on it.
    function onKeyUp(event) {
      if (!event.isTrusted || !taken.has(event.key)) return;
      taken.delete(event.key);
      swallow(event);
    }

    // Tab still moves focus while armed, and the box follows it, so an
    // element can be reached and picked from the keyboard alone.
    function onFocusIn(event) {
      if (!event.isTrusted) return;
      const target = typeof event.composedPath === 'function' ? event.composedPath()[0] : event.target;
      if (!pickable(target)) return;
      anchor = null;
      trail = [];
      highlight(target);
    }

    function onScroll() {
      scrolled = true;
    }

    /**
     * Whether the extension this runs for was reloaded or removed since: a
     * content script of the old one is left running, with no id, and
     * nothing it sends arrives. Its arm, or its tail, then ends on its own
     * at the next frame rather than keeping the page's pointer.
     */
    function orphaned() {
      try {
        return !chrome.runtime?.id;
      } catch {
        return true;
      }
    }

    // A dialog, popover or fullscreen element came or went: the host moves
    // so that it is above it, or out of a dialog that closed.
    function onTopLayer(event) {
      if (event && event.target === host) return;
      if (active) mount();
    }

    /**
     * The keyboard picker. ArrowUp widens to the parent, ArrowDown goes back
     * to where ArrowUp came from or else into the first child, ArrowLeft and
     * ArrowRight move to a sibling, and Enter picks. With nothing highlighted
     * yet, the first key highlights the focused element, or an element in
     * view (see startElement()). On a page with nothing to highlight the key
     * is not the picker's, and goes on to the page.
     *
     * Also what the panel calls, through key() on the controller, since while
     * Element is armed from the panel the keys go to the panel and not here.
     *
     * @returns {boolean} whether the key was the picker's
     */
    function step(key) {
      if (!active || !STEP_KEYS.includes(key)) return false;
      if (!current || !current.isConnected) {
        const start = startElement();
        if (!start) return false;
        anchor = null;
        trail = [];
        highlight(start);
        return true;
      }
      if (key === 'Enter') {
        commit(current);
        return true;
      }
      let next = null;
      if (key === 'ArrowUp') {
        next = parentOf(current);
        if (next) trail.push(current);
      } else if (key === 'ArrowDown') {
        const back = trail.pop();
        next = back && back.isConnected && parentOf(back) === current ? back : null;
        if (!next) {
          trail = [];
          next = firstChildOf(current);
        }
      } else {
        next = siblingOf(current, key === 'ArrowLeft' ? 'previousElementSibling' : 'nextElementSibling');
        if (next) trail = [];
      }
      if (next) highlight(next);
      return true;
    }

    /**
     * Where the keyboard starts: the focused element, else what is under the
     * middle of the viewport, or under a point across it, else the first
     * element in view in document order. The middle alone was often the
     * page's background (body, which is not picked), and then no key did
     * anything at all while every one of them was kept from the page.
     *
     * Only an element the user can see is started from (see inSight()): a
     * skip link clipped to one pixel, or a banner kept hidden, came first in
     * document order, and the box was drawn around nothing. Nor one that is
     * not drawn where it stands (see onTop()).
     */
    function startElement() {
      let focused = document.activeElement;
      while (focused && focused.shadowRoot && focused.shadowRoot.activeElement) {
        focused = focused.shadowRoot.activeElement;
      }
      if (pickable(focused)) return focused;
      const width = window.innerWidth;
      const height = window.innerHeight;
      for (const [x, y] of START_POINTS) {
        const found = pickAt(width * x, height * y);
        if (found && inSight(found)) return found;
      }
      if (!document.body) return null;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let looks = START_HITS;
      for (let node = walker.nextNode(), budget = START_SCAN; node && budget > 0 && looks > 0; node = walker.nextNode(), budget -= 1) {
        if (!pickable(node) || !inSight(node)) continue;
        looks -= 1;
        if (onTop(node)) return node;
      }
      return null;
    }

    /**
     * Whether what is drawn at the middle of the element's part in view is
     * the element or inside it. A link in a collapsed menu (height 0 and
     * overflow hidden), one clipped away by clip-path, and one under a
     * cover all have a box in view and are not seen.
     */
    function onTop(element) {
      const r = element.getBoundingClientRect();
      const x = (Math.max(r.left, 0) + Math.min(r.right, window.innerWidth)) / 2;
      const y = (Math.max(r.top, 0) + Math.min(r.bottom, window.innerHeight)) / 2;
      const found = pickAt(x, y);
      return Boolean(found) && within(element, found);
    }

    /**
     * Whether the user can see an element: at least START_MIN pixels of it
     * each way inside the viewport, not visibility:hidden, and not see
     * through (opacity 0, its own or an ancestor's). Chrome before 121 names
     * the last two options checkVisibilityCSS and checkOpacity.
     */
    function inSight(element) {
      const r = element.getBoundingClientRect();
      const width = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
      const height = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
      if (!(width >= START_MIN && height >= START_MIN)) return false;
      try {
        if (typeof element.checkVisibility !== 'function') return true;
        return element.checkVisibility({
          visibilityProperty: true,
          opacityProperty: true,
          checkVisibilityCSS: true,
          checkOpacity: true,
        });
      } catch {
        return true;
      }
    }

    // Up through a shadow root to its host, and never to body or html.
    function parentOf(element) {
      const parent = element.parentElement || hostOf(element);
      return pickable(parent) ? parent : null;
    }

    // The first child that takes up room on screen, in the shadow root first
    // since that is what renders, and the first child at all failing that.
    function firstChildOf(element) {
      let fallback = null;
      for (const list of [element.shadowRoot ? element.shadowRoot.children : [], element.children]) {
        for (const child of Array.from(list)) {
          if (!pickable(child)) continue;
          const r = child.getBoundingClientRect();
          if (r.width > 0 || r.height > 0) return child;
          fallback = fallback || child;
        }
      }
      return fallback;
    }

    function siblingOf(element, direction) {
      let node = element[direction];
      while (node && !pickable(node)) node = node[direction];
      return node || null;
    }

    // -------------------------------------------------------- the picking ---

    /**
     * Frames take every event over them, so left alone the page never heard
     * the pointer there and a press went to the framed page, for real. While
     * armed, and through the tail, they let the pointer through to the page
     * instead: a stylesheet of the picker's own, adopted by the document and
     * by each open shadow root that holds a frame, gives them
     * pointer-events:none. A move or a press over a frame then reaches the
     * page, where the capture listeners keep it, and nothing goes into the
     * frame. What the page draws over a frame (a hover menu, a tooltip)
     * keeps the pointer, and its hover, as it would with no picker. The
     * frame itself is what is picked there, as a whole (see pickAt()): what
     * is inside it is another document, and the picker runs in this one.
     * The children of an <object>, drawn only as its fallback content (a
     * missing PDF's link), inherit none from it, so they show no hover
     * while picking; the lifted hit test in frameAt() still finds them.
     * Giving them auto back took the page's own none from them (an
     * inherited one, a layered rule) and slowed every restyle by a quarter,
     * since a rule on any element's parent is matched against every element
     * (measured in Chrome).
     *
     * A shield over each frame did this before, from the top of the page,
     * where it took the hover from whatever the page drew over the frame. A
     * shield put up only once the pointer reached a frame would come too
     * late: a cross-site frame tells its parent nothing when the pointer
     * goes into it (checked in Chrome 156).
     *
     * Adopted from this isolated world, the sheet applies to the page as the
     * page's own do (checked in Chrome). Nothing in the DOM changes; the page
     * can see the sheet in adoptedStyleSheets while it is there. A page that
     * sets its own list drops it, and it is put back the next frame (see
     * keepPassing()). Once the pick is over the sheet is emptied as well as
     * taken out, so a copy of the list the page kept and puts back later
     * holds a sheet that does nothing.
     */
    function passFrames() {
      if (passSheet === false) return;
      try {
        if (!passSheet) passSheet = new CSSStyleSheet();
        if (!passRule) passSheet.replaceSync(`${FRAMES} { pointer-events: none !important; }`);
        passRule = true;
      } catch {
        // No constructable stylesheets: every frame gets a shield.
        passSheet = false;
        return;
      }
      for (const scope of [document, ...roots]) {
        try {
          if (scope !== document && (!scope.host.isConnected || !scope.querySelector(FRAMES))) continue;
          const sheets = scope.adoptedStyleSheets;
          if (!sheets.includes(passSheet)) scope.adoptedStyleSheets = [...sheets, passSheet];
          passIn.add(scope);
        } catch {
          /* the frames in a tree in an odd state get a shield */
        }
      }
    }

    // keepPassing() each frame, twice: in the loop, and once more after the
    // frame callbacks the page has asked for by then. A page that sets its
    // list in an animation frame of its own, run after the loop's, dropped
    // the sheet for every press (checked in Chrome).
    function keepPassingEachFrame() {
      keepPassing();
      setTimeout(() => requestAnimationFrame(keepPassing), 0);
    }

    // The sheet put back in every tree that adopted it where the page has
    // set its own list since. A look at each list, each frame and at each
    // press.
    function keepPassing() {
      for (const scope of passIn) {
        try {
          const sheets = scope.adoptedStyleSheets;
          if (!sheets.includes(passSheet)) scope.adoptedStyleSheets = [...sheets, passSheet];
        } catch {
          /* gone with its tree */
        }
      }
    }

    // The sheet taken back out of every tree that adopted it, leaving the
    // page's own sheets as they are now, and emptied.
    function stopPassing() {
      for (const scope of passIn) {
        try {
          const sheets = scope.adoptedStyleSheets;
          if (sheets.includes(passSheet)) scope.adoptedStyleSheets = sheets.filter((sheet) => sheet !== passSheet);
        } catch {
          /* gone with its tree */
        }
      }
      passIn.clear();
      if (!passSheet || !passRule) return;
      try {
        passSheet.replaceSync('');
        passRule = false;
      } catch {
        /* out of every list it was put in all the same */
      }
    }

    // The frames as they stand now: found, letting the pointer through, and
    // the ones that still take it (a page rule that wins over the sheet's,
    // a tree that would not adopt it), which get a shield.
    function surveyFrames() {
      frameList = findFrames();
      passFrames();
      live = frameList.filter((element) => {
        try {
          return getComputedStyle(element).getPropertyValue('pointer-events') !== 'none';
        } catch {
          return true;
        }
      });
    }

    /**
     * A shield over each frame that still takes the pointer (see
     * surveyFrames()), as every frame used to have. It is looked through
     * (see under()), so the frame is still what is picked.
     */
    function shieldFrames() {
      if (frameCount % 15 === 0) {
        // Shadow roots attached since the arm, and their frames.
        collectRoots();
        surveyFrames();
        // Dialogs fire toggle only from Chrome 132. Focus is moved into a
        // modal dialog as it opens, which is how an older one shows here.
        // A shielded frame that came into the dialog, or left it, moves the
        // host too, and so does whatever the page put in the top layer
        // without a toggle that reaches window (a popover in a shadow root),
        // also one it hid and showed again since the last look.
        const modal = modalOfFocus() || mountedIn;
        const layer = topLayerNow();
        if (modal && (modal !== mountedIn || (host.parentNode === modal) !== holdsFrame(modal))) mount();
        else if (layer.some((node) => !layerSeen.has(node))) mount();
        else layerSeen = new Set(layer);
      }
      frameCount += 1;
      keepPassingEachFrame();
      let used = 0;
      for (const element of live) {
        if (!element.isConnected) continue;
        const r = element.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0 || r.right <= 0 || r.bottom <= 0) continue;
        if (r.left >= window.innerWidth || r.top >= window.innerHeight) continue;
        let shield = shields.children[used];
        if (!shield) {
          shield = document.createElement('div');
          shield.className = 'shield';
          shields.appendChild(shield);
        }
        // Compared with what was written last, not read back: Chrome
        // rewrites cssText in its own form, and every frame would restyle.
        const at = `display:block;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
        if (shieldAt[used] !== at) shield.style.cssText = shieldAt[used] = at;
        used += 1;
      }
      for (let index = used; index < shields.children.length; index += 1) {
        if (shieldAt[index] !== 'display:none') shields.children[index].style.cssText = shieldAt[index] = 'display:none';
      }
    }

    function findFrames() {
      const found = [];
      const every = [];
      for (const scope of [document, ...roots]) {
        if (scope !== document && !scope.host.isConnected) {
          roots.delete(scope);
          continue;
        }
        try {
          for (const element of scope.querySelectorAll(FRAMES)) {
            if (found.length < 100) found.push(element);
            if (every.length < FRAME_BOXES) every.push(element);
          }
        } catch {
          /* a scope in an odd state shields nothing */
        }
      }
      allFrames = every;
      return found;
    }

    // Open shadow roots, so frames inside a web component let the pointer
    // through too, and a popover in one is seen in the top layer. Walked
    // at the arm and on each survey, within a budget, so a root attached
    // while armed is found too; one found sooner by the pointer (see
    // pickAt() and onFrameOver()) is added then. A closed root is not seen.
    function collectRoots() {
      const stack = document.documentElement ? [document.documentElement] : [];
      let budget = ROOT_SCAN;
      while (stack.length && budget > 0) {
        const walker = document.createTreeWalker(stack.pop(), NodeFilter.SHOW_ELEMENT);
        for (let node = walker.currentNode; node && budget > 0; node = walker.nextNode()) {
          budget -= 1;
          if (node.shadowRoot) {
            roots.add(node.shadowRoot);
            stack.push(node.shadowRoot);
          }
        }
      }
    }

    // Each frame while armed: frames letting the pointer through (or
    // shielded), the box where its element is, and the element under a
    // pointer the page scrolled under.
    function tick() {
      frame = 0;
      if (!active) return;
      if (orphaned()) {
        stop();
        return;
      }
      try {
        // The page took the host out: removed the modal dialog it sat in
        // (which fires no close event), or rewrote body. Put back, or the
        // rest of the arm has no box, no hint and no frame shields.
        if (!host.isConnected || (mountedIn && !mountedIn.isConnected)) mount();
        shieldFrames();
        if (current && !current.isConnected) {
          forget();
          scrolled = true;
        }
        if (scrolled && pointer) hover(pointer.x, pointer.y);
        scrolled = false;
        if (current) {
          const r = current.getBoundingClientRect();
          if (`${r.left},${r.top},${r.width},${r.height}` !== placed) highlight(current);
        }
      } catch {
        /* a page in an odd state must not stop the loop */
      }
      frame = requestAnimationFrame(tick);
    }

    /**
     * Where the host goes. In the top layer as a popover whenever anything is
     * there (a modal dialog, an open popover, a fullscreen element), so the
     * box is drawn above it and not under it. Shown again on every move,
     * which puts it above whatever opened last. On a page with nothing in the
     * top layer it stays an ordinary element at the end of body, as it always
     * was.
     *
     * Inside the topmost modal dialog only when the dialog holds a frame
     * that needs a shield (see surveyFrames()), which is rare now that frames
     * let the pointer through. Everything outside the dialog is inert, and a
     * shield there let the pointer through to the frame (checked in Chrome).
     * The box, the tag and the hint take no pointer, and from body they are
     * drawn above the dialog all the same (checked in Chrome). In the dialog
     * the host is its last child, which a :last-child rule (Tailwind's
     * space-y) then misses, and the dialog moved while armed.
     */
    function mount() {
      const modal = topModal();
      const parent = (modal && holdsFrame(modal) ? modal : null) || document.body || document.documentElement;
      if (host.parentNode !== parent) parent.appendChild(host);
      // The modal dialog seen, whether or not the host went into it.
      mountedIn = modal;
      popover = false;
      const layer = topLayerNow();
      layerSeen = new Set(layer);
      if (modal || layer.length) {
        try {
          host.setAttribute('popover', 'manual');
          if (host.matches(':popover-open')) host.hidePopover();
          host.showPopover();
          popover = true;
        } catch {
          /* no popover API: the host stays where it is, under the top layer */
        }
      } else if (host.hasAttribute('popover')) {
        host.removeAttribute('popover');
      }
    }

    // Whether a frame that needs a shield is in the dialog, in its own tree
    // or in an open shadow root inside it.
    function holdsFrame(modal) {
      return live.some((element) => within(modal, element));
    }

    function within(ancestor, node) {
      for (let at = node; at; at = at.parentNode || (at.nodeType === 11 ? at.host : null)) {
        if (at === ancestor) return true;
      }
      return false;
    }

    function unmount() {
      if (popover) {
        try {
          host.hidePopover();
        } catch {
          /* already hidden */
        }
      }
      popover = false;
      mountedIn = null;
      if (host && host.parentNode) host.parentNode.removeChild(host);
    }

    function topModal() {
      const focused = modalOfFocus();
      if (focused) return focused;
      try {
        const open = document.querySelectorAll(':modal');
        return open.length ? open[open.length - 1] : null;
      } catch {
        return null;
      }
    }

    // Focus cannot leave the blocking dialog, so the modal around the focused
    // element is the topmost one, also inside a shadow root.
    function modalOfFocus() {
      let node = document.activeElement;
      while (node && node.shadowRoot && node.shadowRoot.activeElement) node = node.shadowRoot.activeElement;
      for (let depth = 0; node && node.nodeType === 1 && depth < 256; depth += 1) {
        try {
          if (node.matches(':modal')) return node;
        } catch {
          return null;
        }
        node = node.parentElement || hostOf(node);
      }
      return null;
    }

    /**
     * What the page has in the top layer: open popovers and modal dialogs,
     * in the document and in the open shadow roots known, and a fullscreen
     * element. A popover in a shadow root fires a toggle that never reaches
     * window, so the host stayed under it; the frame loop compares this with
     * what was there when the host was last put on top (see shieldFrames()).
     */
    function topLayerNow() {
      const found = [];
      for (const scope of [document, ...roots]) {
        try {
          if (scope !== document && !scope.host.isConnected) continue;
          for (const node of scope.querySelectorAll(':popover-open, :modal')) {
            if (node !== host) found.push(node);
          }
        } catch {
          /* no :popover-open before Chrome 114 */
        }
      }
      try {
        if (document.fullscreenElement) found.push(document.fullscreenElement);
      } catch {
        /* no fullscreen API */
      }
      return found;
    }

    /**
     * The moments after a pick. The press that picked is still going (its
     * mouseup and click follow the pointerup), the second press of a double
     * click follows within half a second, and the panel is about to
     * photograph the page. So every press is still kept from the page, by
     * capture listeners on window as while armed, until TAIL_MS after the
     * payload is sent. Nothing is put over the page for it: a catcher there
     * took the hover from the picked element, and a menu that exists only
     * while hovered was gone before it could be read or photographed.
     *
     * Frames go on letting the pointer through (see passFrames()), so the
     * rest of the press, and a second one, cannot go into one. The highlight
     * goes at once, and so does the host, unless it shields a frame the
     * sheet does not reach. It then stays where it has been all along, so
     * the page is laid out the same when it is read as when it is
     * photographed.
     *
     * A press begun in the tail is let end in it, its click and a dblclick
     * too, however late its time runs out (see tailOver()); the page heard
     * the rest of such a press as a click without its pointerdown, and
     * followed a link. TAIL_LIMIT_MS after the pick, or after the last
     * press begun in the tail, ends it whatever is held.
     *
     * The key that picked, held down, repeats: its repeats and its keyup
     * are kept from the page too, or a form whose field had focus was sent.
     *
     * @returns {number} this tail's id
     */
    function beginTail() {
      endTail();
      for (const part of [box, tag, hint]) part.style.display = 'none';
      if (!shieldAt.some((at) => at && at.startsWith('display:block'))) unmount();
      tailOn = true;
      tailId += 1;
      for (const type of TAIL_EVENTS) window.addEventListener(type, onTail, listenOptions(type));
      window.addEventListener('selectstart', onSelectStart, true);
      window.addEventListener('mouseover', onFrameOver, true);
      window.addEventListener('pagehide', endTail);
      tailCap = setTimeout(endTail, TAIL_LIMIT_MS);
      tailFrame = requestAnimationFrame(tailTick);
      return tailId;
    }

    // Each frame of the tail: the sheet kept in place (see keepPassing()),
    // and the tail of an extension since reloaded ended.
    function tailTick() {
      tailFrame = 0;
      if (!tailOn) return;
      if (orphaned()) {
        endTail();
        return;
      }
      keepPassingEachFrame();
      tailFrame = requestAnimationFrame(tailTick);
    }

    function lingerTail(id) {
      if (!tailOn || id !== tailId) return;
      clearTimeout(tailTimer);
      tailTimer = setTimeout(tailOver, TAIL_MS);
    }

    // The tail's time is up: it ends now, or once the presses begun in it
    // have ended.
    function tailOver() {
      tailTimer = 0;
      if (tailPresses.size || tailSettle) tailDue = true;
      else endTail();
    }

    function endTail() {
      if (!tailOn) return;
      tailOn = false;
      tapRead = null;
      for (const timer of [tailTimer, tailCap, tailSettle]) clearTimeout(timer);
      tailTimer = tailCap = tailSettle = 0;
      if (tailFrame) cancelAnimationFrame(tailFrame);
      tailFrame = 0;
      tailPresses.clear();
      tailDue = false;
      for (const type of TAIL_EVENTS) window.removeEventListener(type, onTail, true);
      window.removeEventListener('selectstart', onSelectStart, true);
      window.removeEventListener('mouseover', onFrameOver, true);
      window.removeEventListener('pagehide', endTail);
      if (!active) {
        unmount();
        stopPassing();
      }
    }

    function onTail(event) {
      if (!event.isTrusted) return;
      if (event.type === 'keyup') {
        if (event.key !== 'Enter') return;
        taken.delete(event.key);
      } else if (event.type.startsWith('key') && !(event.repeat && taken.has(event.key))) {
        // Only the repeats of the key that picked: a new press is the page's.
        return;
      }
      hold(event);
      if (event.type === 'pointerdown') {
        tailPresses.add(event.pointerId);
        keepPassing();
        // However late it began, the press has its TAIL_LIMIT_MS.
        clearTimeout(tailCap);
        tailCap = setTimeout(endTail, TAIL_LIMIT_MS);
      } else if ((event.type === 'pointerup' || event.type === 'pointercancel') && tailPresses.delete(event.pointerId)) {
        // A tap's mouse events, and its click, come after its pointerup.
        settle(event.pointerType === 'touch' ? TAP_MS : SETTLE_MS);
      }
      // The mouse events a tap makes come once it has moved the hover.
      if (tapRead && (event.type === 'mousedown' || event.type === 'click')) tapRead();
    }

    // A press begun in the tail has ended; what is left of it comes within
    // `ms`, and then a tail whose time is up ends.
    function settle(ms) {
      clearTimeout(tailSettle);
      tailSettle = setTimeout(() => {
        tailSettle = 0;
        if (tailDue && !tailPresses.size) endTail();
      }, ms);
    }

    /**
     * The payload. The element's box and styles are read as the page will
     * stand for the screenshot, and in whatever hover state the element is
     * in, which the payload names. The host is out of the page for what
     * describes the page's own tree: in a modal dialog it would be in the
     * dialog's markup and text, and anywhere it would count as a sibling in
     * the selector. When it is still there (see beginTail()) it goes back in
     * the same task, so no frame is drawn without it.
     */
    function read(element) {
      const rect = element.getBoundingClientRect();
      const look = styles(element);
      // Picked with the pointer over it, which nothing takes away: its
      // styles and its screenshot are those of its hover state, and the
      // prompt says so.
      const hovered = hovering(element);

      const parent = host.parentNode;
      const next = host.nextSibling;
      if (parent) parent.removeChild(host);
      let payload;
      try {
        payload = {
          selector: cssPath(element),
          attributes: attributes(element),
          text: visibleText(element),
          ...markup(element),
          styles: look,
        };
        if (hovered) payload.hovered = true;

        // Read here with the rest of the payload, while the DOM is still exactly
        // what the user clicked and before the marker attribute is set.
        const hints = classHints(element);
        if (hints.length) payload.classHints = hints;
      } finally {
        if (parent) {
          parent.insertBefore(host, next && next.parentNode === parent ? next : null);
          if (popover) {
            try {
              host.showPopover();
            } catch {
              /* the shields are back in the page either way */
            }
          }
        }
      }

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
      // The visual viewport, which is what the screenshot shows under pinch
      // zoom; the panel crops through it. See the same in overlay.js.
      const vv = window.visualViewport;
      if (vv) {
        viewport.visual = { x: vv.offsetLeft, y: vv.offsetTop, width: vv.width, height: vv.height, scale: vv.scale };
      }

      return { payload, captureRect, viewport };
    }

    /**
     * Take the element: read it at once (see read()), then ask the MAIN
     * world about it and let the highlight's removal paint before the pick
     * is sent for the panel to photograph.
     *
     * A finger's pick is read a moment later. A tap moves the hover to what
     * it tapped only after its pointerup, just before the mouse events made
     * for it, and leaves it there for the screenshot, so it is read then,
     * when the payload and the screenshot show the same state.
     */
    function commit(element, tap = false) {
      // This run's name, read now: the pick is sent after a round trip, and
      // the shortcut or the panel may have started a new run by then.
      const picked = run;
      disarm();
      // stop() bumps this, so a pick cancelled from the panel while it waits
      // for its tap or its round trip never arrives.
      const era = generation;
      const tail = beginTail();

      const take = () => {
        if (era !== generation) return;
        let reading;
        try {
          reading = read(element);
        } catch {
          // Nothing was sent, and the panel still shows Element lit.
          send({ type: 'cdr:capture-cancelled', mode: 'element' });
          if (tail === tailId) endTail();
          return;
        }
        const { payload, captureRect, viewport } = reading;

        // The marker attribute is set here, after the payload is built, because
        // attributes() and markup() read the live DOM and would otherwise print
        // data-cdr-pick into the user's prompt.
        const inspected = inspect(element);

        // Hiding the highlight box only queues the change, and one frame does
        // not guarantee a paint has landed before the panel screenshots the tab,
        // hence two. The round trip runs alongside them, so its timeout is only
        // ever paid on a page where the MAIN world never answers at all.
        const painted = new Promise((resolve) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(resolve);
          });
        });

        // Escape is already unhooked; the panel's cancel button is the route
        // still open during the round trip. Without the check the cancelled
        // pick would arrive anyway, and the panel would answer it with a
        // screenshot and a file on disk.
        Promise.all([inspected, painted])
          .then(([reply]) => {
            if (era !== generation) return;
            if (reply?.component) payload.component = reply.component;
            if (reply?.handlers) payload.handlers = reply.handlers;
            send({ type: 'cdr:element-picked', rect: captureRect, viewport, element: payload, run: picked });
            lingerTail(tail);
          })
          .catch(() => {
            if (era === generation) send({ type: 'cdr:capture-cancelled', mode: 'element' });
            if (tail === tailId) endTail();
          });
      };

      if (!tap) {
        take();
        return;
      }
      let timer = 0;
      const once = () => {
        if (tapRead !== once) return;
        tapRead = null;
        clearTimeout(timer);
        take();
      };
      tapRead = once;
      timer = setTimeout(once, TAP_MS);
    }

    // This start()'s name, returned to the injection and put on every message,
    // so a late one from an earlier run cannot end a newer arm (overlay.js).
    let run = null;

    function send(message) {
      try {
        chrome.runtime.sendMessage({ run, ...message }).catch(() => {});
      } catch {
        /* extension context invalidated */
      }
    }

    function listen(on) {
      const method = on ? 'addEventListener' : 'removeEventListener';
      window[method]('mousemove', onMouseMove, true);
      for (const type of PRESS) window[method](type, onPointer, listenOptions(type));
      window[method]('keydown', onKeyDown, true);
      window[method]('keyup', onKeyUp, true);
      window[method]('focusin', onFocusIn, true);
      window[method]('selectstart', onSelectStart, true);
      window[method]('mouseover', onFrameOver, true);
      window[method]('scroll', onScroll, on ? { capture: true, passive: true } : true);
      window[method]('toggle', onTopLayer, true);
      window[method]('close', onTopLayer, true);
      document[method]('fullscreenchange', onTopLayer);
      // See the matching line in overlay.js.
      window[method]('pagehide', stop);
    }

    function start() {
      if (active) return run;
      // Mutually exclusive with the region overlay; see the matching comment
      // in overlay.js.
      try {
        window.__cdrRegionOverlay?.stop();
      } catch {
        /* ignore */
      }
      endTail();
      if (!host) build();
      active = true;
      run = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      forget();
      pressed = false;
      pointer = null;
      scrolled = false;
      if (mainWorldSilent) ping();
      taken.clear();
      hint.style.display = 'block';
      shields.style.display = 'block';

      roots = new Set();
      collectRoots();
      // Frames let the pointer through before the host is placed, which
      // goes into a modal dialog only for a frame that still needs a shield.
      surveyFrames();
      frameCount = 1;
      mount();
      listen(true);
      // Shields at once, then the loop from the next frame.
      tick();
      return run;
    }

    // Armed listeners off, the host and the frames left as they are: a pick
    // hands them on to the tail (see beginTail()), and stop() takes them
    // down.
    function disarm() {
      active = false;
      listen(false);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      pressed = false;
      downs.clear();
      roots = new Set();
      frameList = [];
      allFrames = [];
      live = [];
    }

    function stop() {
      // Before the active guard, deliberately. A pick disarms the picker and
      // then waits on a tap, the inspect round trip and two frames, so by
      // the time the panel's cancel button disarms the tab this controller is
      // already inactive. Bumping below the guard would make that call a
      // no-op and let the cancelled pick land anyway, as a capture and a PNG
      // on disk.
      generation += 1;
      endTail();
      if (!active) return;
      disarm();
      unmount();
      stopPassing();
    }

    // isActive: see the matching line in overlay.js. key: the panel holds the
    // keyboard while Element is armed from it, and hands the picker's keys on
    // (see step()).
    return { start, stop, isActive: () => active, key: (name) => step(name) };
  }

  if (!window.__cdrElementPicker) {
    window.__cdrElementPicker = createController();
  }
  // The injection answers with this value, the run start() made.
  return window.__cdrElementPicker.start();
})();
