/**
 * MAIN-world collector.
 *
 * Runs in the page's own JavaScript world at document_start, before the page's
 * scripts execute. That is the only place where console, window.fetch and
 * XMLHttpRequest can be wrapped, because an ISOLATED-world content script sees
 * its own copies of those objects, not the page's.
 *
 * The price of living in the MAIN world is that chrome.* APIs are unavailable
 * here. Everything collected is buffered locally and handed to
 * collector-bridge.js (ISOLATED world) on request, over a channel of the
 * bridge's own (see the end of this file).
 */
(() => {
  'use strict';

  // Taken first, before anything below can be replaced by the page: the
  // guard, the late start and the channel to the bridge go through these.
  const call = Function.prototype.call;
  const uncurry = (method) => call.bind(method);
  const reflectApply = Reflect.apply;
  const NativeProxy = Proxy;
  const addWindowListener = uncurry(window.addEventListener);
  const removeWindowListener = uncurry(window.removeEventListener);
  const dispatchWindowEvent = uncurry(window.dispatchEvent);
  const NativeCustomEvent = window.CustomEvent;
  const NativeEvent = typeof Event === 'function' ? Event : null;
  const defineOwn = Object.defineProperty;
  const ownDescriptorAtStart = Object.getOwnPropertyDescriptor;
  const hasOwnAtStart = Object.hasOwn;

  /** A native accessor's getter, uncurried, or null where this world has none. */
  function getterAtStart(proto, key) {
    try {
      const descriptor = proto ? ownDescriptorAtStart(proto, key) : undefined;
      return descriptor && hasOwnAtStart(descriptor, 'get') && typeof descriptor.get === 'function'
        ? uncurry(descriptor.get)
        : null;
    } catch {
      return null;
    }
  }

  // How the collector reads and cancels the events it handles. A plain
  // event.detail or event.preventDefault() is looked up on the page's
  // CustomEvent.prototype and Event.prototype, where a page script can put a
  // getter or a method of its own, and the collector would then run it in
  // the middle of answering the bridge, with the request (and its channel's
  // name, see the end of this file) in hand: it read every snapshot after
  // that, and answered in the collector's place. So these are the natives,
  // taken now. Each listener here is for one type and so never reads it.
  const eventDetail = getterAtStart(NativeCustomEvent && NativeCustomEvent.prototype, 'detail');
  const eventCancel =
    NativeEvent && typeof NativeEvent.prototype.preventDefault === 'function'
      ? uncurry(NativeEvent.prototype.preventDefault)
      : null;
  const detailOf = (event) => (eventDetail ? eventDetail(event) : event.detail);
  const cancel = (event) => (eventCancel ? eventCancel(event) : event.preventDefault());
  // Whether an event this file sent was cancelled, read off the event and not
  // from what dispatchEvent returned: a wrapper of dispatchEvent that drops
  // the value (another extension's document_start script, say) said that
  // every event was cancelled.
  const eventCancelled = getterAtStart(NativeEvent && NativeEvent.prototype, 'defaultPrevented');
  const dispatchCancelled = (event) => {
    const returned = dispatchWindowEvent(window, event);
    return eventCancelled ? eventCancelled(event) === true : !returned;
  };
  // The node the picker asked a component's name of (see answerName, at the
  // end of this file), read through the native as well: a page that later
  // replaced composedPath (a polyfill, a framework's patch of Event) could
  // otherwise make every answer throw, or name another node. Every Chrome
  // this runs in has it; where a world has none, event.target is read.
  const eventPath =
    NativeEvent && typeof NativeEvent.prototype.composedPath === 'function'
      ? uncurry(NativeEvent.prototype.composedPath)
      : null;

  /**
   * A CustomEvent of this world's own. Its init dictionary has no prototype
   * and every member as its own property, because Chrome reads each member
   * (bubbles, cancelable, composed, detail) through the object's prototype
   * chain, and a getter the page put on Object.prototype ran while the
   * collector answered a request, and read the request off window.event.
   */
  function newEvent(type, detail, cancelable) {
    return new NativeCustomEvent(type, {
      __proto__: null,
      bubbles: false,
      cancelable: cancelable === true,
      composed: false,
      detail,
    });
  }

  /**
   * value added at the end of list, as its own property. An assignment past
   * the end looks the index up on Array.prototype first, where a setter of
   * the page's would run, with whatever the collector is handling then.
   */
  function append(list, value) {
    defineOwn(list, list.length, {
      __proto__: null,
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  // Re-injection guard. Wrapping fetch twice would record every request twice.
  //
  // A collector up to 0.5.0 marked itself with a global, and one of those can
  // still be running in a tab after the extension is updated, since Chrome
  // does not take a MAIN world script out of a page. This build sets no
  // global: a page could read one to tell the extension is installed. A
  // collector of this build answers an event instead (see the end of this
  // file). The worker sends it from the extension's own world before it
  // injects a copy at all (startCollector in background.js), and is answered
  // by a cancel, which is all that crosses the worlds. A second copy sends it
  // before wrapping anything, with a function of its own as the detail,
  // which the collector there calls: the answer it waits for is that call.
  // It went by the cancel too, and a page whose dispatchEvent cancelled every
  // event (or did not return what the native returns) was taken for one with
  // a collector, so none ever started there.
  const PROBE = '__cdr_probe';
  try {
    if (window.__cdrCollector) return;
    let answered = false;
    const answer = () => {
      answered = true;
    };
    dispatchWindowEvent(window, newEvent(PROBE, answer, false));
    if (answered) return;
  } catch {
    /* no CustomEvent here: nothing else can have answered either */
  }

  // Whether this collector started after the page had begun to run, so that
  // what the page logged before it is not in the log. Said in every
  // snapshot, so the panel and the prompt can say the log is partial for as
  // long as this collector runs: after the panel is closed and opened again,
  // and after the extension is reloaded or updated, when this one is left
  // running in the page and only a new bridge is added to reach it.
  //
  // Declared, it runs at document_start, before any of the page's scripts.
  // Started by the worker, in a tab that was open before the extension could
  // start there, it runs whenever that is, and only the worker knows that it
  // is starting one: so it says so. Just before it injects this file, it
  // puts a listener in the extension's own world that cancels LATE, which
  // this sends as it starts (startCollector in background.js). Nothing in
  // the document can tell: it went by whether a script element was in it,
  // and another extension's document_start script adds one before the page
  // has run a line, while a page still loading may have run a script that
  // has since removed itself. A document that has finished loading is late
  // whatever the event says: a declared collector never starts there.
  //
  // A page script can listen for LATE too, and cancel it or stop it, but
  // only once it runs, which is after a declared collector has started: so
  // what it can change is what its own log says about its start.
  const LATE = '__cdr_late';
  let startedLate = false;
  try {
    startedLate = dispatchCancelled(newEvent(LATE, null, true));
  } catch {
    /* no CustomEvent here: the document is asked below */
  }
  try {
    if (!startedLate) startedLate = document.readyState !== 'loading';
  } catch {
    /* a document that cannot say: taken as a start at document_start */
  }

  const LIMIT = 30; // ring buffer size, per category
  const MAX_STRING = 600; // truncation budget for any single serialized value

  // Warnings have a ring of their own. A development build of a framework can
  // warn dozens of times per render, and sharing one ring with console.error
  // let that flood push out the one error that mattered.
  const buffers = {
    console: [],
    warnings: [],
    errors: [],
    network: [],
  };

  // How many entries each ring has pushed out, so the prompt can say the log
  // is the newest LIMIT of a longer one rather than all there was.
  const dropped = { console: 0, warnings: 0, errors: 0, network: 0 };

  // The clocks as they are at document_start. A page can replace Date or
  // performance.now later (MockDate, sinon's fake timers, Playwright's
  // page.clock), and the prompt orders entries and splits them between
  // captures by these times, against the panel's own clock.
  const now = Date.now;
  const elapsed = performance.now.bind(performance);
  const startedAt = now();
  // One count across every ring. A failed request, the warning it causes and
  // the throw after it routinely land in the same millisecond, and the prompt
  // prints them in the order they happened, which t alone cannot tell.
  let pushed = 0;
  // How many of the bridge's channels have a panel watching the counts (see
  // countsChanged, at the end of this file). While it is 0, as it is
  // whenever no panel is open on this tab, push() costs one comparison more.
  let watching = 0;
  // Whether a change may not have been told to every channel watching.
  let owed = false;

  /**
   * list without its entry at index, in place. Array methods are the page's
   * to replace, so neither push nor splice is called on the rings.
   */
  function removeAt(list, index) {
    for (let i = index; i + 1 < list.length; i += 1) list[i] = list[i + 1];
    list.length -= 1;
  }

  /**
   * value set as entry's own property. An assignment to a field the entry
   * does not have yet looks it up on Object.prototype first, where a setter
   * of the page's would run with the entry in hand, and could leave a getter
   * on it: one that ran while the bridge's request was answered, and read
   * the channel's name off window.event.
   */
  function setOwn(entry, key, value) {
    defineOwn(entry, key, { __proto__: null, value, writable: true, enumerable: true, configurable: true });
  }

  /** entry's own field, never one looked up on Object.prototype (see setOwn). */
  function ownField(entry, key) {
    return hasOwnAtStart(entry, key) ? entry[key] : undefined;
  }

  function push(ring, entry) {
    setOwn(entry, 't', now() - startedAt); // ms since collector armed
    pushed += 1;
    setOwn(entry, 'seq', pushed);
    const list = buffers[ring];
    append(list, entry);
    // A full ring drops one for each it takes, so its count stays as it was.
    if (list.length <= LIMIT) {
      if (watching > 0) {
        owed = true;
        countsChanged();
      }
      return;
    }
    // More than one when a push before this one ran out of stack between
    // taking its entry and dropping one (a page that logs on its way back
    // from a stack overflow), which the console wrapper swallows: that left
    // the ring longer for good, by one each time. All go in one pass: one
    // at a time, each looked for over the whole ring, took seconds once a
    // few thousand such pushes had made it long.
    // A request the page ended itself (an abort, a timeout it set, an
    // open() over it) goes before any real failure, the newest included: a
    // type-ahead that cancels a request per keystroke would otherwise push
    // the failures the report is for out of the ring.
    const excess = list.length - LIMIT;
    let kept = 0;
    let i = 0;
    try {
      for (; i < list.length; i += 1) {
        const item = list[i];
        if (i - kept < excess && ownField(item, 'outcome')) continue;
        list[kept] = item;
        kept += 1;
      }
    } finally {
      // Out of stack part way, what was not looked at yet moves up behind
      // what was kept, so no entry is left twice. Nothing here calls out.
      // When nothing has left yet, every entry is already in place: moving
      // them all onto themselves on each such push cost the deep band the
      // square of the ring's length.
      const length = list.length;
      if (kept === i) kept = length;
      else for (; i < length; i += 1, kept += 1) list[kept] = list[i];
      dropped[ring] += length - kept;
      list.length = kept;
    }
    // Then the oldest, when fewer had ended than were too many.
    const over = list.length - LIMIT;
    if (over > 0) {
      for (let k = over; k < list.length; k += 1) list[k - over] = list[k];
      list.length -= over;
      dropped[ring] += over;
    }
    // A change not told yet (see countsChanged), told with this entry.
    if (owed && watching > 0) countsChanged();
  }

  // SECRET NAMES BEGIN. The same block sits in content/collector-main.js,
  // content/picker.js and shared/prompt-template.js, which cannot share code:
  // two are injected into the page and one is a module. test/static.test.mjs
  // fails if the copies differ.
  const REDACTED = '<redacted>';

  // Matched against the whole words of a name, so className is not caught by
  // "ssn" nor passHref by "pass". A word of five letters or more also matches
  // at either end of a run together lowercase name (authtoken, phonenumber).
  // Deliberately broad: a needlessly hidden value costs a line of the prompt,
  // and the other kind of mistake cannot be taken back. A nonce is a one time
  // payment token (Braintree's payment_method_nonce) or a form's CSRF token
  // (WordPress's _wpnonce).
  const SECRET_WORDS = [
    'password', 'passwd', 'passphrase', 'passcode', 'pwd', 'secret', 'token', 'auth', 'oauth',
    'authorization', 'bearer', 'jwt', 'cookie', 'session', 'credential', 'apikey', 'accesskey',
    'privatekey', 'signingkey', 'csrf', 'xsrf', 'otp', 'totp', 'pin', 'pincode', 'cvv', 'cvc',
    'ssn', 'iban', 'cardnumber', 'creditcard', 'ccnumber', 'account', 'address', 'email', 'phone',
    'dob', 'birth', 'signature', 'jsessionid', 'sessid', 'securitycode', 'verificationcode',
    'nonce',
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

  // The redaction below runs in the page's own world, so any method it calls
  // on a string, a regular expression, an array or a Map is one the page can
  // replace after document_start. A polyfill's String.prototype.split, or a
  // RegExp.prototype.test that answers true for everything, would make every
  // key read as harmless and print its value. So what it needs is taken now,
  // as the clocks are, and called uncurried rather than looked up on a value.
  const NativeMap = Map;
  const NativeSet = Set;
  const NativeString = String;
  const mapGet = uncurry(Map.prototype.get);
  const mapSet = uncurry(Map.prototype.set);
  const sliceString = uncurry(String.prototype.slice);
  const indexOfString = uncurry(String.prototype.indexOf);
  const lowerCase = uncurry(String.prototype.toLowerCase);
  // Only exec. split, replace and test hand a regular expression on to
  // RegExp.prototype[Symbol.split], exec, flags and constructor, all of which
  // the page can replace, while exec itself reads nothing but the expression's
  // own state.
  const execRegExp = uncurry(RegExp.prototype.exec);
  const stringify = JSON.stringify;
  const isArray = Array.isArray;
  const parseIntNative = parseInt;
  const parseFloatNative = parseFloat;
  // The same for what a request goes through: the failure path formats the
  // call site and times the request. A page that replaced Math.round or an
  // Array method would otherwise run on every failure. How a fetch is
  // chained without a then of the page's is with the fetch wrapper below.
  const round = Math.round;

  /**
   * holder[key], or the native zone.js kept when it replaced it.
   *
   * On a tab that was open before the extension could start there, this file
   * runs after the page's scripts (see startedLate), and zone.js may have
   * replaced what it takes. zone.js keeps each native it replaces under a
   * name of its own, and the native is taken from there when it has. At
   * document_start no such name exists yet, and this is holder[key].
   */
  function beforeZone(holder, key) {
    try {
      const prefix = window.__Zone_symbol_prefix;
      const saved = holder[((typeof prefix === 'string' && prefix) || '__zone_symbol__') + key];
      if (typeof saved === 'function') return saved;
    } catch {
      /* the one in place, then */
    }
    return holder[key];
  }

  // The constructor V8 consults for stackTraceLimit and prepareStackTrace,
  // which is this one whatever the page later assigns to window.Error. After
  // a late start, zone.js's error plugin (zone-error, which an Angular
  // project may load in development) may already have put its
  // ZoneAwareError there. One made at every request read the stack at once,
  // ran the page's prepareStackTrace and zone.js's own rewriting each time,
  // and wrote the zone's name after every frame, so that no caller was ever
  // recorded. Measured in Chrome for Testing 156.
  const NativeError = beforeZone(window, 'Error');

  // What serialize() reads a logged value with. Each of these reads an
  // object's own state and runs nothing of the page's: no getter, no toJSON,
  // no valueOf, and of a proxy's traps only getPrototypeOf, ownKeys and
  // getOwnPropertyDescriptor.
  const ownDescriptor = Object.getOwnPropertyDescriptor;
  const prototypeOf = Object.getPrototypeOf;
  const hasOwn = Object.hasOwn;
  const isFiniteNumber = Number.isFinite;
  const isView = ArrayBuffer.isView;
  const stringValue = uncurry(String.prototype.valueOf);
  const numberValue = uncurry(Number.prototype.valueOf);
  const booleanValue = uncurry(Boolean.prototype.valueOf);
  const bigintValue = uncurry(BigInt.prototype.valueOf);
  const dateValue = uncurry(Date.prototype.getTime);
  const dateText = uncurry(Date.prototype.toISOString);
  /** A native getter, uncurried, or null where this realm has none. */
  function nativeGetter(proto, key) {
    try {
      const descriptor = proto && ownDescriptor(proto, key);
      return descriptor && typeof descriptor.get === 'function' ? uncurry(descriptor.get) : null;
    } catch {
      return null;
    }
  }
  const typedLength = nativeGetter(prototypeOf(Uint8Array.prototype), 'length');
  const NativeElement = typeof Element === 'function' ? Element : null;
  // Taken now, like everything else here: a page can replace window.Error,
  // and a global looked up per value is also the slowest read in the walk.
  const ERROR_PROTO = Error.prototype;
  const TYPE_ERROR_PROTO = TypeError.prototype;
  const OBJECT_PROTO = Object.prototype;
  const ELEMENT_PROTO = NativeElement ? NativeElement.prototype : null;
  const elementTag = NativeElement && nativeGetter(NativeElement.prototype, 'tagName');
  const elementId = NativeElement && nativeGetter(NativeElement.prototype, 'id');
  const NativeURL = typeof URL === 'function' ? URL : null;
  const urlHref = NativeURL && nativeGetter(NativeURL.prototype, 'href');
  // What each kind of value is told by: its prototype, read once, rather than
  // a brand check that throws for every object that is not one. A throw
  // costs about a microsecond, and a logged object can hold thousands.
  const WRAPPERS = new NativeMap([
    [String.prototype, 'string'],
    [Number.prototype, 'number'],
    [Boolean.prototype, 'boolean'],
    [BigInt.prototype, 'bigint'],
    [Date.prototype, 'date'],
  ]);
  if (NativeURL) mapSet(WRAPPERS, NativeURL.prototype, 'url');
  // The same kinds, for a value from another realm, by constructor name.
  const FOREIGN = {
    __proto__: null,
    String: 'string',
    Number: 'number',
    Boolean: 'boolean',
    BigInt: 'bigint',
    Date: 'date',
    URL: 'url',
  };

  // isSecretName, written again so that nothing the page can replace takes
  // part: no method at all, only indexes, lengths and comparisons. The block
  // above stays the definition the picker and the template share, and
  // test/collector.test.mjs runs this copy against it over the same names, so
  // a change made there and not here fails the tests. It reads name[from, to)
  // as though that were the whole string, which judges a long key's two ends
  // without slicing it.
  const LOWER = 1;
  const UPPER = 2;
  const DIGIT = 3;

  // A copy, read by index. test/static.test.mjs fails on any use of
  // SECRET_WORDS after the block that could rewrite it, indexing included.
  const WORDS = [...SECRET_WORDS];

  // Built from literals, with no prototype, so that no lookup leaves it.
  const LOWERCASE = { __proto__: null };
  for (let i = 0; i < 26; i += 1) {
    LOWERCASE['ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i]] = 'abcdefghijklmnopqrstuvwxyz'[i];
  }

  /** LOWER, UPPER or DIGIT for an ASCII letter or digit, 0 for anything else. */
  function charKind(char) {
    if (char >= 'a' && char <= 'z') return LOWER;
    if (char >= 'A' && char <= 'Z') return UPPER;
    if (char >= '0' && char <= '9') return DIGIT;
    return 0;
  }

  /** Whether name[at, at + length), lowercased, reads secret[from, from + length). */
  function spells(name, at, secret, from, length) {
    for (let i = 0; i < length; i += 1) {
      const char = name[at + i];
      if ((LOWERCASE[char] || char) !== secret[from + i]) return false;
    }
    return true;
  }

  function isSecretNameIn(name, from, to) {
    // The word before this one, for a name run across two (pass_word).
    let before = -1;
    let beforeSize = 0;
    let i = from;
    while (i < to) {
      if (!charKind(name[i])) {
        i += 1;
        continue;
      }
      const start = i;
      i += 1;
      while (i < to) {
        const kind = charKind(name[i]);
        if (!kind) break;
        if (kind === UPPER) {
          // fooBar and foo2Bar turn at the capital, and HTTPServer at the
          // last capital of the run, the one a small letter follows.
          if (charKind(name[i - 1]) !== UPPER) break;
          if (i + 1 < to && charKind(name[i + 1]) === LOWER) break;
        }
        i += 1;
      }
      // otp1, cvv2: digits after a letter are not part of the word, though
      // a word of digits alone is kept whole.
      let end = i;
      while (end > start && charKind(name[end - 1]) === DIGIT) end -= 1;
      if (end === start) end = i;
      const size = end - start;
      for (let n = 0; n < WORDS.length; n += 1) {
        const secret = WORDS[n];
        const length = secret.length;
        if (
          (size === length && spells(name, start, secret, 0, length)) ||
          (size === length + 1 &&
            spells(name, start, secret, 0, length) &&
            spells(name, end - 1, 's', 0, 1)) ||
          (before >= 0 &&
            beforeSize + size === length &&
            spells(name, before, secret, 0, beforeSize) &&
            spells(name, start, secret, beforeSize, size)) ||
          (length >= 5 &&
            size >= length &&
            (spells(name, start, secret, 0, length) || spells(name, end - length, secret, 0, length)))
        ) {
          return true;
        }
      }
      before = start;
      beforeSize = size;
    }
    return false;
  }

  /** The name test for a value that should be a string, whatever it is. */
  function isSecretText(value) {
    const name = typeof value === 'string' ? value : NativeString(value);
    return isSecretNameIn(name, 0, name.length);
  }

  /** Array.prototype.includes, for a list of this file's own. */
  function listed(list, value) {
    for (let i = 0; i < list.length; i += 1) {
      if (list[i] === value) return true;
    }
    return false;
  }

  const upperCase = uncurry(String.prototype.toUpperCase);
  const TRUNCATED = ' …[truncated]';

  function truncate(str, max = MAX_STRING) {
    if (typeof str !== 'string') str = NativeString(str);
    return str.length > max ? sliceString(str, 0, max) + TRUNCATED : str;
  }

  // A logged object repeats its keys (two hundred rows of one shape), and
  // this runs in the page's own time, so each name is judged once. The cache
  // is bounded because a page can log any number of names: once full it
  // keeps what it has and judges new names afresh, rather than emptying and
  // judging every one of them again. Only a key whose value can show is
  // judged at all (see walk()), and such a key is shorter than MAX_STRING, so
  // each is judged whole, a word in its middle included.
  const secretKeys = new NativeMap();
  // Counted here rather than read from secretKeys.size, a getter the page
  // can replace like any other.
  let cachedKeys = 0;

  /** Whether name[from, to) is made of digits alone. */
  function digitsIn(name, from, to) {
    for (let i = from; i < to; i += 1) {
      if (name[i] < '0' || name[i] > '9') return false;
    }
    return true;
  }

  function isSecretKey(key) {
    // An array's index, the most common key of all, is never a field name,
    // and is kept out of the cache, which one long array would fill. Nor is
    // any other key of digits: the name test finds no word in one.
    if (key.length > 0 && digitsIn(key, 0, key.length)) return false;
    const known = mapGet(secretKeys, key);
    if (known !== undefined) return known;
    const secret = isSecretNameIn(key, 0, key.length);
    if (cachedKeys < 2000) {
      mapSet(secretKeys, key, secret);
      cachedKeys += 1;
    }
    return secret;
  }

  // What a member reads as when it prints nothing: a hole, an accessor with
  // no getter, and in walk() also undefined, a function and a symbol.
  const ABSENT = { __proto__: null };
  // A member behind a getter, which is never called.
  const GETTER = { __proto__: null };
  // A Date that holds no time, which prints as null, as JSON.stringify has it.
  const INVALID_DATE = { __proto__: null };
  // Which kinds of kindOf() print as a quoted string; the others print bare.
  const QUOTED = { __proto__: null, string: true, url: true, element: true, date: true };

  /**
   * What kind of value an object is, told from its prototype: one of the
   * WRAPPERS kinds, 'error', 'element' or 'object'. Reads prototypes and
   * nothing else, so of a proxy only its getPrototypeOf trap runs.
   */
  function kindOf(value) {
    const first = prototypeOf(value);
    const wrapper = first === null ? undefined : mapGet(WRAPPERS, first);
    if (wrapper) return wrapper;
    // A plain object or an array, the most common by far, in one step.
    if (first === OBJECT_PROTO) return 'object';
    let proto = first;
    let root = null;
    for (let depth = 0; proto !== null && depth < 16; depth += 1) {
      if (proto === ERROR_PROTO) return 'error';
      if (proto === ELEMENT_PROTO) return 'element';
      root = proto;
      proto = prototypeOf(proto);
    }
    // A chain that ends anywhere but this realm's Object.prototype belongs to
    // another realm, a same origin iframe's, whose String.prototype is not
    // the one above. Its prototypes are then told by their constructors'
    // names, read through descriptors, and a wrapper is confirmed by the
    // native brand check in walk(), which works across realms.
    if (root === null || root === OBJECT_PROTO) return 'object';
    proto = first;
    for (let depth = 0; proto !== null && depth < 16; depth += 1) {
      const constructor = memberOf(proto, 'constructor');
      const name = typeof constructor === 'function' ? memberOf(constructor, 'name') : '';
      if (depth === 0 && typeof name === 'string' && hasOwn(FOREIGN, name)) return FOREIGN[name];
      if (name === 'Error') return 'error';
      if (name === 'Element') return 'element';
      proto = prototypeOf(proto);
    }
    return 'object';
  }

  /** "<div#cart>", for an element at the top of a log line or inside one. */
  function elementText(element) {
    const tag = elementTag ? elementTag(element) : element.tagName;
    const id = elementId ? elementId(element) : element.id;
    return `<${lowerCase(NativeString(tag))}${id ? '#' + NativeString(id) : ''}>`;
  }

  /**
   * An Error's stack, with the "Name: message" line in front only when the
   * stack does not already open with it. V8 writes that line into the stack
   * when the error is made, so printing both repeated it on every logged
   * error. A message changed after the error was made no longer matches, and
   * then both are printed, since they say different things.
   */
  function errorText(error) {
    const name = error.name === undefined ? 'Error' : NativeString(error.name);
    const message = error.message === undefined ? '' : NativeString(error.message);
    const header = !name ? message : !message ? name : name + ': ' + message;
    let stack = '';
    try {
      // Reading .stack runs Error.prepareStackTrace if the page installed one.
      stack = error.stack;
    } catch {
      /* the header alone, then */
    }
    if (typeof stack !== 'string' || !stack) return truncate(header);
    return truncate(sliceString(stack, 0, header.length) === header ? stack : header + '\n' + stack);
  }

  /**
   * One member of an object or an array, read from its descriptor, so that
   * a getter is never called: GETTER for one, ABSENT for a hole or a setter
   * alone, and otherwise the value, which may be anything.
   */
  function memberOf(holder, key) {
    const descriptor = ownDescriptor(holder, key);
    if (!descriptor) return ABSENT;
    if (hasOwn(descriptor, 'get')) return descriptor.get === undefined ? ABSENT : GETTER;
    return descriptor.value;
  }

  /**
   * An object or an array as JSON.stringify would print it, cut at
   * MAX_STRING, without JSON.stringify.
   *
   * JSON.stringify runs the page's code: every getter it meets, every
   * toJSON, a wrapper's valueOf, a proxy's get trap. Anything a getter does
   * then happens because something was logged, which is not the page's own
   * behaviour: a lazy getter computes, a framework records the read as a
   * dependency, a throwing one made the whole line [unserializable]. And no
   * replacer can stop its own walk: it reads every slot of a sparse array of
   * ten million, every key of a huge object, and the whole text of a String
   * object, to keep 600 characters.
   *
   * So this walks the value itself, reading members through their
   * descriptors. A getter prints as "[Getter]" and is never called, toJSON is
   * not called either, and a String, Number, Boolean or BigInt object, a Date
   * and a URL are read through the natives taken at the top. Of a proxy, only
   * the getPrototypeOf, ownKeys and getOwnPropertyDescriptor traps run, the
   * last once or twice for each member visited. Everything else prints as
   * JSON.stringify prints it, character for character, which a test holds
   * it to.
   *
   * The walk stops as soon as its text is longer than truncate() keeps, so
   * an array is read only as far as it prints, and an object's members only
   * until then. What it cannot bound is the list of an object's keys, which
   * V8 collects whole before the first is handed out, by for-in as by
   * Object.keys: about 100 ms for an object of a million keys.
   */
  function walk(root) {
    let out = '';
    // Set once the text is longer than truncate() keeps, or reaches it with
    // a value still to follow. Every emit below answers with it, and every
    // loop returns as soon as it is set, so nothing more is read. A flag
    // rather than a throw, which costs about a microsecond in V8, on every
    // long line.
    let full = false;
    // The node budget bounds members that print nothing, which the length of
    // the text cannot: an object of a million functions prints as {}.
    let budget = 4000;
    const ancestors = [];
    let depth = 0;

    const emit = (text) => {
      out += text;
      if (out.length > MAX_STRING) full = true;
      return full;
    };
    // A string is quoted only as far as it can print. One character more
    // than that, and one more again, so that a surrogate pair cut in two
    // cannot change what precedes the cut.
    const emitString = (text) => {
      const room = MAX_STRING + 2 - out.length;
      return emit(stringify(text.length > room ? sliceString(text, 0, room) : text));
    };

    const emitValue = (value) => {
      if (value === GETTER) return emitString('[Getter]');
      switch (typeof value) {
        case 'string':
          return emitString(value);
        case 'number':
          return emit(isFiniteNumber(value) ? stringify(value) : 'null');
        case 'boolean':
          return emit(value ? 'true' : 'false');
        case 'bigint':
          // JSON.stringify throws on one, and the whole line was lost.
          return emit(NativeString(value) + 'n');
        default:
          return value === null ? emit('null') : emitObject(value);
      }
    };

    /** The text of a wrapper, a date, a URL or an element, or null for any other object. */
    const textOf = (value, kind) => {
      try {
        switch (kind) {
          case 'string':
            return stringValue(value);
          case 'number': {
            const number = numberValue(value);
            return isFiniteNumber(number) ? stringify(number) : 'null';
          }
          case 'boolean':
            return booleanValue(value) ? 'true' : 'false';
          case 'bigint':
            return NativeString(bigintValue(value)) + 'n';
          case 'date':
            return isFiniteNumber(dateValue(value)) ? dateText(value) : INVALID_DATE;
          case 'url':
            return urlHref(value);
          case 'element':
            // JSON.stringify walks an element's own properties, which on a
            // React page are its fiber and props: thousands of nodes to say
            // nothing a tag and an id do not.
            return elementText(value);
          default:
            return null;
        }
      } catch {
        // Shares a prototype without being one (Object.create(Date.prototype)),
        // which JSON.stringify prints as a plain object too.
        return null;
      }
    };
    const emitObject = (value) => {
      for (let i = 0; i < depth; i += 1) {
        // The current chain of ancestors, not every object seen: a shared
        // object reached twice is not a cycle, and printing it as one would
        // hide real data.
        if (ancestors[i] === value) return emitString('[Circular]');
      }
      const kind = kindOf(value);
      if (kind !== 'object') {
        const text = textOf(value, kind);
        if (text === INVALID_DATE) return emit('null');
        if (text !== null) return QUOTED[kind] ? emitString(text) : emit(text);
      }

      ancestors[depth] = value;
      depth += 1;
      let filled;
      if (isArray(value)) {
        filled = emitArray(value);
      } else {
        let length = -1;
        try {
          // A typed array's indexes, which for-in would collect whole first.
          if (isView(value) && typedLength) length = typedLength(value);
        } catch {
          /* a DataView */
        }
        filled = length >= 0 ? emitIndexed(value, length) : emitMembers(value);
      }
      depth -= 1;
      return filled;
    };

    const emitArray = (value) => {
      const length = memberOf(value, 'length');
      const count = typeof length === 'number' ? length : 0;
      if (emit('[')) return true;
      for (let i = 0; i < count; i += 1) {
        if (i && emit(',')) return true;
        if (budget <= 0) {
          if (emitString('[…budget exceeded]')) return true;
          continue;
        }
        budget -= 1;
        const member = memberOf(value, i);
        // An element that prints nothing prints null, as JSON.stringify has it.
        const filled =
          member === ABSENT || member === undefined || typeof member === 'function' || typeof member === 'symbol'
            ? emit('null')
            : emitValue(member);
        if (filled) return true;
      }
      return emit(']');
    };

    const emitIndexed = (value, length) => {
      if (emit('{')) return true;
      for (let i = 0; i < length; i += 1) {
        if (i && emit(',')) return true;
        if (emit('"' + i + '":') || emitValue(value[i])) return true;
      }
      return emit('}');
    };

    const emitMembers = (value) => {
      if (emit('{')) return true;
      let first = true;
      // for-in rather than Object.keys: on a proxy it asks for each member's
      // descriptor only when it reaches that member, where Object.keys asks
      // for every one first. It also yields inherited keys, after the own
      // ones, which is where this stops.
      for (const key in value) {
        const descriptor = ownDescriptor(value, key);
        if (!descriptor) break;
        if (!descriptor.enumerable) continue;
        let member;
        if (budget <= 0) {
          member = '[…budget exceeded]';
        } else {
          budget -= 1;
          member = hasOwn(descriptor, 'get')
            ? descriptor.get === undefined
              ? ABSENT
              : GETTER
            : descriptor.value;
        }
        // undefined, a function and a symbol print nothing, name included.
        if (member === ABSENT || member === undefined || typeof member === 'function' || typeof member === 'symbol') {
          continue;
        }
        if ((!first && emit(',')) || emitString(key) || emit(':')) return true;
        first = false;
        // From here the value would start at or past the cut, so nothing of
        // it can show and its key need not be judged. Every key that is
        // judged is therefore shorter than the cut, and is judged whole.
        if (out.length >= MAX_STRING) {
          full = true;
          return true;
        }
        // A logged request or user object carries its Authorization header
        // or password under a name that says so (see isSecretName).
        if (member !== GETTER && withheld(member) && isSecretKey(key)) member = REDACTED;
        if (emitValue(member)) return true;
      }
      return emit('}');
    };

    budget -= 1;
    emitObject(root);
    // Cut here rather than by truncate(): the walk also stops at exactly
    // MAX_STRING characters when a value was still to follow, which
    // truncate() would see nothing to cut in.
    return full ? sliceString(out, 0, MAX_STRING) + TRUNCATED : out;
  }

  /**
   * Console arguments are arbitrary values, including objects with cyclic
   * references and DOM nodes. Anything thrown here would surface as a broken
   * console in the user's page, so every branch is defensive.
   */
  function serialize(value) {
    try {
      if (typeof value === 'string') return truncate(value);
      if (typeof value === 'function') {
        const name = memberOf(value, 'name');
        return `[Function ${typeof name === 'string' && name ? name : 'anonymous'}]`;
      }
      if (value === null || value === undefined || typeof value !== 'object') {
        return NativeString(value);
      }
      const kind = kindOf(value);
      if (kind === 'error') return errorText(value);
      if (kind === 'element') {
        try {
          return truncate(elementText(value));
        } catch {
          /* named Element without being one: printed as an object */
        }
      }
      return walk(value);
    } catch {
      return '[unserializable]';
    }
  }

  // The most a console line keeps: each argument is cut at MAX_STRING, and
  // a call with a hundred of them would otherwise be a hundred times that.
  const TEXT_MAX = MAX_STRING * 10;

  /** One substitution of a format string, or null for a % that is not one. */
  function substitute(spec, value) {
    switch (spec) {
      case 's':
      case 'o':
      case 'O':
        return serialize(value);
      case 'd':
      case 'i':
      case 'f': {
        if (typeof value === 'bigint') return NativeString(value) + 'n';
        // An object would be converted by its own toString, which is the
        // page's code; the console prints NaN for one anyway.
        if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean') {
          return 'NaN';
        }
        const text = NativeString(value);
        return NativeString(spec === 'f' ? parseFloatNative(text) : parseIntNative(text, 10));
      }
      case 'c':
        // CSS for the DevTools console, and nothing to read.
        return '';
      default:
        return null;
    }
  }

  /**
   * The arguments of one console call as the console prints them.
   *
   * A first argument holding %s, %d, %i, %f, %o, %O or %c takes the
   * arguments after it in its place, as the console does, and only what is
   * left over follows it. React's own warnings are written this way
   * ("Each child in a list should have a unique \"key\" prop.%s%s See …"),
   * and printing the format string with its arguments after it put the
   * component's name at the end of the line, after a row of raw %s.
   */
  function formatArgs(args) {
    const count = args.length;
    if (!count) return '';
    const first = args[0];
    let next = 1;
    let text;
    if (count > 1 && typeof first === 'string' && indexOfString(first, '%') >= 0) {
      let head = '';
      let from = 0;
      while (from < first.length) {
        const at = indexOfString(first, '%', from);
        const end = at < 0 || at + 1 >= first.length ? first.length : at;
        // Only as much as can still print: a format string of a megabyte is
        // not copied to keep 600 characters of it.
        const room = from + MAX_STRING + 1 - head.length;
        head += sliceString(first, from, end < room ? end : room);
        if (head.length > MAX_STRING) return truncate(head);
        if (end === first.length) break;
        const spec = first[at + 1];
        let piece = spec === '%' ? '%' : null;
        if (piece === null && next < count) {
          piece = substitute(spec, args[next]);
          if (piece !== null) next += 1;
        }
        if (piece === null) {
          head += '%';
          from = at + 1;
        } else {
          head += piece;
          from = at + 2;
        }
        // What follows the cut, leftover arguments included, would print
        // after it, so nothing of it can show.
        if (head.length > MAX_STRING) return truncate(head);
      }
      text = head;
    } else {
      text = serialize(first);
    }
    for (; next < count && text.length <= TEXT_MAX; next += 1) text += ' ' + serialize(args[next]);
    return truncate(text, TEXT_MAX);
  }

  // ---------------------------------------------------------------- console --
  /**
   * The native, wrapped so that the page cannot tell it from the native.
   *
   * Every wrapper in this file is a Proxy of the function it replaces, with
   * an apply trap and nothing else. Its name, its length, its missing
   * prototype and its refusal of new are then the native's own, and
   * Function.prototype.toString answers "function () { [native code] }" for
   * it, as V8 does for any callable proxy. A named function gave the
   * extension away to any page that looked: fetch.name was "cdrFetch", and
   * the source text of a wrapper is distinctive whatever it is named. Only
   * the missing name in that toString text differs from the native, and only
   * a script written against wrappers in general would look for it.
   *
   * The handler has no prototype, so a trap the page puts on Object.prototype
   * (a get, a has) is never consulted: the proxy forwards everything but the
   * call to the native, exactly. About ten nanoseconds a call, measured.
   */
  function wrapNative(native, relay) {
    return new NativeProxy(native, { __proto__: null, apply: relay });
  }

  /**
   * holder[key], or undefined where reading it throws. On a tab where this
   * file starts after the page has run (see startedLate), what it wraps is
   * whatever the page left there, which need not be the native or even a
   * function: xhook replaces XMLHttpRequest with a constructor whose
   * prototype has no open at all.
   */
  function readIn(holder, key) {
    try {
      return holder !== null && (typeof holder === 'object' || typeof holder === 'function') ? holder[key] : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * holder[key] replaced by a proxy of native (see wrapNative), when native
   * is a function, and left as it is otherwise, or where the page has made
   * it read only. Nothing here may throw into the page: a throw from this
   * file's setup reached the page's own window.onerror, and stopped every
   * wrapper and listener after it, the guard's included.
   */
  function wrapIn(holder, key, native, relay) {
    if (typeof native !== 'function') return false;
    try {
      holder[key] = wrapNative(native, relay);
      return true;
    } catch {
      return false;
    }
  }

  const pageConsole = typeof console === 'object' ? console : null;
  const nativeConsole = { error: readIn(pageConsole, 'error'), warn: readIn(pageConsole, 'warn') };
  function relayConsole(level, self, args) {
    try {
      push(level === 'warn' ? 'warnings' : 'console', { level, text: formatArgs(args) });
    } catch {
      /* never let collection break the page's console */
    }
    return reflectApply(nativeConsole[level], self, args);
  }
  wrapIn(pageConsole, 'error', nativeConsole.error, (_native, self, args) => relayConsole('error', self, args));
  wrapIn(pageConsole, 'warn', nativeConsole.warn, (_native, self, args) => relayConsole('warn', self, args));

  // --------------------------------------------------------------- runtime --
  /**
   * The address a failed element was loading, or ''.
   *
   * src alone missed three common cases. An <img> with only a srcset, or
   * inside a <picture>, has an empty src and loads currentSrc, the candidate
   * it chose. An SVG <image> (and <use>, <feImage>, an SVG <script>) has an
   * href that is an SVGAnimatedString, which printed as "[object
   * SVGAnimatedString]", and an <object> loads its data.
   */
  function resourceUrl(target) {
    const current = target.currentSrc;
    if (typeof current === 'string' && current) return current;
    const src = target.src;
    if (typeof src === 'string' && src) return src;
    const href = target.href;
    if (typeof href === 'string' && href) return href;
    if (href && typeof href === 'object' && typeof href.baseVal === 'string' && href.baseVal) {
      // As written in the markup, which may be relative.
      try {
        return NativeURL ? urlHref(new NativeURL(href.baseVal, document.baseURI)) : href.baseVal;
      } catch {
        return href.baseVal;
      }
    }
    const data = target.data;
    if (typeof data === 'string' && data) return data;
    return '';
  }

  /**
   * window.addEventListener, as the page has it, which on a tab this file
   * starts on late may be anything the page left there: a throw from it is
   * not the page's (see wrapIn).
   */
  function onWindow(type, listener, capture) {
    try {
      window.addEventListener(type, listener, capture);
    } catch {
      /* nothing of this kind is recorded */
    }
  }

  // Capture phase catches two different things with one listener: uncaught
  // exceptions (which bubble) and resource load failures such as a 404 <img>
  // or <script> (which do not bubble and are only visible during capture).
  onWindow(
    'error',
    (event) => {
      try {
        const target = event.target;
        if (target && target !== window && target.tagName) {
          // Cut like every other text here: a data: URL inlined by a bundler
          // is the whole image, and it went into the prompt whole.
          push('errors', {
            kind: 'resource',
            text: truncate(
              `Failed to load <${lowerCase(NativeString(target.tagName))}>: ${
                resourceUrl(target) || '(unknown source)'
              }`
            ),
          });
          return;
        }
        push('errors', {
          kind: 'exception',
          text: truncate(event.message || NativeString(event.error || 'Unknown error')),
          where: event.filename ? truncate(`${event.filename}:${event.lineno}:${event.colno}`) : '',
          stack: event.error && event.error.stack ? truncate(event.error.stack) : '',
        });
      } catch {
        /* ignore */
      }
    },
    true
  );

  onWindow('unhandledrejection', (event) => {
    try {
      const reason = event.reason;
      // serialize() folds an Error's stack into its text, which is right for a
      // console argument that has nowhere else to put it. Here there IS a
      // separate stack field, and a stack string already begins with
      // "Name: message", so reusing serialize() would print the message twice
      // and the whole trace twice over.
      // The Error this file started with: a constructor the page put in its
      // place could answer instanceof with code of its own.
      const isError = reason instanceof NativeError;
      push('errors', {
        kind: 'unhandled-rejection',
        text: isError ? truncate(`${reason.name}: ${reason.message}`) : serialize(reason),
        stack: isError && reason.stack ? truncate(reason.stack) : '',
      });
    } catch {
      /* ignore */
    }
  });

  // ------------------------------------------------------------------- CSP --
  // A request the page's Content Security Policy blocks fails like any
  // network failure ("Failed to fetch"), and the violation is reported with
  // the topmost script on the stack as its source. For a fetch or an XHR the
  // page makes, that is this collector's wrapper, so the browser, the page's
  // own securitypolicyviolation listeners and the site's CSP reports all
  // name "punch-list", the scheme of this file's sourceURL (see the end of
  // the file), rather than the page's file. That cannot be changed from
  // here: any wrapper written in JavaScript is the topmost frame when it
  // calls the native, and calling it later from no frame at all would change
  // when every request the page makes starts.
  //
  // What can be done is to keep the developer reading the prompt from
  // chasing it: the failed request is labelled with what blocked it and why
  // the reports blame the extension, next to the page's own caller, which the
  // wrapper recorded.
  const CSP_NOTE =
    "Blocked by the page's Content Security Policy (connect-src). The browser and the site's " +
    'CSP reports give punch-list as its source, because the request went through the Punch List ' +
    "extension's wrapper";
  const CSP_WINDOW_MS = 10000;
  // Recent connect-src violations, newest last, for a request that fails
  // after its violation was reported.
  const violations = [];

  /** url as an absolute address without its fragment, for comparing with blockedURI. */
  function comparable(url) {
    let href = NativeString(url);
    try {
      if (NativeURL) href = urlHref(new NativeURL(href, document.baseURI));
    } catch {
      /* compared as it is */
    }
    const hash = indexOfString(href, '#');
    return hash < 0 ? href : sliceString(href, 0, hash);
  }

  /** CSP_NOTE when a connect-src violation for this url was reported lately. */
  function blockedNote(url) {
    try {
      if (!violations.length) return '';
      const wanted = comparable(url);
      const now = elapsed();
      for (let i = violations.length - 1; i >= 0; i -= 1) {
        const violation = violations[i];
        if (now - violation.at > CSP_WINDOW_MS) break;
        if (violation.url === wanted) return CSP_NOTE;
      }
    } catch {
      /* ignore */
    }
    return '';
  }

  onWindow(
    'securitypolicyviolation',
    (event) => {
      try {
        if (event.disposition !== 'enforce') return;
        if (event.effectiveDirective !== 'connect-src') return;
        const blocked = event.blockedURI;
        if (typeof blocked !== 'string' || !blocked) return;
        const url = comparable(blocked);
        violations[violations.length] = { url, at: elapsed() };
        if (violations.length > LIMIT) removeAt(violations, 0);
        // The request may have failed, and been recorded, before this event
        // was dispatched: label it now.
        const network = buffers.network;
        for (let i = network.length - 1; i >= 0; i -= 1) {
          const entry = network[i];
          if (entry.t < now() - startedAt - CSP_WINDOW_MS) break;
          // Not one the page refused to send, which no policy saw.
          if (
            entry.status === 0 &&
            !ownField(entry, 'outcome') &&
            !ownField(entry, 'blocked') &&
            !ownField(entry, 'notSent') &&
            comparable(entry.url) === url
          ) {
            entry.statusText = CSP_NOTE;
            setOwn(entry, 'blocked', true);
            break;
          }
        }
      } catch {
        /* ignore */
      }
    },
    true
  );

  // ------------------------------------------------------------- call stack --
  // A failed request is fixed in the function that sent it, and the URL alone
  // never names that function. The only place it can be read is the call site,
  // so an Error is constructed there and formatted later, if the request fails.
  //
  // cleanPath() and STACK_FRAME are defined further down, in the inspect
  // section. Nothing here runs before the page's first request, which is long
  // after this file has finished executing, so the forward reference is safe.

  // Deep enough to reach the page through a request library. axios alone puts
  // seven frames between its caller and open(), and this file two more, so
  // at six the page's own frame was never recorded at all. Recording costs
  // about a microsecond more per request at thirty than at six, measured in
  // Chrome; formatting, the expensive half, still happens only on failure.
  const STACK_CAPTURE_DEPTH = 30; // frames V8 is asked to record
  const CALLER_LIMIT = 3; // frames reported, nearest first
  const CALLER_MAX_STRING = 200; // characters kept from one formatted frame

  // This collector's own frames, known by the file they are in, which
  // reads punch-list://extension/collector-main.js (see the end of the
  // file). The wrappers carry the natives' names (see the console
  // wrappers), so a name could not tell them from the page's own fetch or
  // open. The whole address, so that a file of the page's that happens to
  // be called collector-main.js is still the page's.
  const CDR_FRAME = /punch-list:\/\/extension\/collector-main\.js:/;

  // "    at applyCoupon (https://host/src/Cart.jsx:70:36)". A frame with no
  // name ("    at https://host/src/main.jsx:12:5") does not match, and is
  // reported as its location alone.
  const STACK_NAME = /^\s*at\s+(?:async\s+)?(.+?)\s+\(/;

  /**
   * An Error built at the call site, for formatting only if the call fails.
   *
   * This is the one cost every request on every page the user visits pays, so
   * it stays at one allocation and no string work: V8 records the frames now
   * and only formats them when .stack is read.
   */
  function captureStack() {
    let saved;
    let restore = false;
    try {
      // The limit is global state belonging to the page, which may have raised
      // it for its own error reporting, so it is read first and put back
      // after. Only a value that was actually read is restored: writing
      // undefined back would stop V8 recording stacks for the page's errors
      // entirely, which is a worse bug than having no caller here.
      // On the Error V8 reads it from, which is not window.Error if the page
      // has put a constructor of its own there.
      saved = NativeError.stackTraceLimit;
      restore = true;
      NativeError.stackTraceLimit = STACK_CAPTURE_DEPTH;
      return new NativeError();
    } catch {
      // A frozen Error, or a page accessor of its own that threw.
      return null;
    } finally {
      try {
        if (restore) NativeError.stackTraceLimit = saved;
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * The text of a stack this file captured, formatted by V8 itself, or null.
   *
   * Reading .stack the first time runs Error.prepareStackTrace if the page
   * installed one, which is page code: it was called on every failed request
   * because of the extension, handed this file's own frames, and free to
   * throw or to return something other than a string. So while the capture,
   * which the page never sees, is formatted, a plain prepareStackTrace of the
   * page's is set aside and put back after, with nothing of the page's
   * running in between. One behind an accessor is left where it is, since
   * moving it would call the page's setter, and its answer is then used if
   * it is a string.
   */
  function capturedText(error) {
    let saved;
    let moved = false;
    try {
      const descriptor = ownDescriptor(NativeError, 'prepareStackTrace');
      if (descriptor && hasOwn(descriptor, 'value') && descriptor.value !== undefined && descriptor.writable) {
        saved = descriptor.value;
        NativeError.prepareStackTrace = undefined;
        moved = true;
      }
    } catch {
      /* formatted as the page has it, then */
    }
    try {
      const text = error.stack;
      return typeof text === 'string' ? text : null;
    } catch {
      return null;
    } finally {
      if (moved) {
        try {
          NativeError.prepareStackTrace = saved;
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * The capture as at most three frames, nearest first.
   *
   * Only ever called on a request that has already failed, so a healthy page
   * never pays for the formatting, which is the expensive half.
   */
  // Frames belonging to a framework's own dispatch rather than to the page.
  // Deliberately short: over-matching would hide the page's own code, which is
  // the one thing these frames exist to name.
  const VENDOR_FRAME =
    /react-dom|react\.development|\/node_modules\/|zone\.js|vue\.(global|runtime|esm)|\/(?:axios|jquery|superagent)(?:[.-][\w.-]*)?\.m?js\b/i;
  // A request library's own functions, by name, for when it is bundled into
  // the page's own file and the path cannot tell it from the page: axios's
  // dispatch chain and its methods ("Axios.request", "Axios$1._request" after
  // Rollup renames it, "Axios.<computed> [as get]", and "wrap [as get]", the
  // bound copy axios.get is). Only names nobody gives a function of their
  // own, since one matched here hides a frame of the page's: "xhr", the name
  // axios's adapter is called by, is left in. A minified bundle has none of
  // these names, and nothing can be done there.
  const LIBRARY_NAME =
    /^(?:Axios(?:\$\d+)?\.\S+(?: \[as \w+\])?|wrap \[as (?:request|get|delete|head|options|post|put|patch|postForm|putForm|patchForm)\]|dispatchXhrRequest|dispatchRequest|xhrAdapter|fetchAdapter)$/;

  // An async function compiled for an older browser runs through a helper of
  // its compiler's: TypeScript's __awaiter and __generator, Babel's
  // _asyncToGenerator with or without regenerator, esbuild's __async, and
  // SWC's copies of these. Each puts four to nine frames of its own between
  // the line that awaits and the function's caller, and does it again for
  // every compiled async function further down, so the three slots went to
  // the helpers (axios's own build is compiled this way) and the page's
  // caller was cut.
  //
  // Names only these helpers use, which mark a frame wherever it appears.
  const HELPER_NAME =
    /^(?:__awaiter|__generator|__async|asyncGeneratorStep|_asyncToGenerator|_async_to_generator|_ts_generator|_?regeneratorRuntime|_regenerator|Generator\.(?:next|throw|return|_invoke|<anonymous>))$/;
  // Names their inner functions carry, which a function of the page's can
  // carry too (a wizard's "step"). A frame so named is a helper's only next
  // to one already known to be, and never as the async function itself,
  // which sits below the helper that made its promise.
  const HELPER_INNER =
    /^(?:step|fulfilled|rejected|_next|_throw|tryCatch|(?:Object|Iterator)\.(?:next|throw|return))$/;
  // The helpers that make the promise an async function returns.
  const HELPER_START = /^(?:__awaiter|__async)$/;
  // TypeScript's es5 output resumed after an await carries none of the names
  // above, only this sequence at the bottom of the stack, where the microtask
  // that resumed it starts: __generator's step, the next it is called from,
  // and __awaiter's fulfilled or rejected.
  const ITERATOR_STEP = /^(?:Object|Iterator)\.(?:next|throw|return)$/;
  const SETTLED_STEP = /^(?:fulfilled|rejected)$/;
  // What regenerator calls the body of an async function, which nobody can
  // search for.
  const GENERATED_BODY = /^(?:\S+\.)?_callee\d*\$$/;
  const ANONYMOUS_SUFFIX = '.<anonymous>';
  // SWC's _ts_generator defines its iterator's next with
  // Object.defineProperty, which leaves V8 no name for it: the frame reads
  // "Object.<anonymous>", between _ts_generator's step and the helper that
  // drives it (@swc/helpers 0.5.23).
  const ITERATOR_ANONYMOUS = /^(?:Object|Iterator)\.<anonymous>$/;
  const STEP = /^step$/;

  /** The frames of a stack: each line, the name it gives, and where it is. */
  function parseStack(text) {
    const frames = [];
    // Line 0 is the "Error" header, which is never a frame.
    let at = indexOfString(text, '\n');
    while (at >= 0 && frames.length < STACK_CAPTURE_DEPTH + 10) {
      const end = indexOfString(text, '\n', at + 1);
      const line = sliceString(text, at + 1, end < 0 ? text.length : end);
      at = end;
      const named = execRegExp(STACK_NAME, line);
      const label = named === null ? null : named[1];
      frames[frames.length] = {
        line,
        label,
        // "ApiClient.<anonymous>" is an anonymous function called as a method.
        anonymous:
          label === null ||
          (label.length >= ANONYMOUS_SUFFIX.length &&
            sliceString(label, label.length - ANONYMOUS_SUFFIX.length) === ANONYMOUS_SUFFIX),
        located: execRegExp(STACK_FRAME, line),
      };
    }
    return frames;
  }

  /**
   * Which frames belong to a compiled async function's helper, and which of
   * those made the promise the function returns (the frame below one of
   * those is the function itself).
   *
   * Told by shape as much as by name. The helpers' anonymous functions are
   * the executor of the promise the helper makes, always just above "new
   * Promise", and Babel's wrapper that makes it, just below. The generator
   * body above a helper is anonymous too, but sits above "Generator.next" or
   * "step" instead, and is the page's own code: it is never counted.
   */
  function helperFrames(frames) {
    const count = frames.length;
    const helper = [];
    // Read by index only inside the list: an index past either end would be
    // looked up on Array.prototype, which is the page's.
    const known = (i) => i >= 0 && i < count && helper[i] === true;
    const named = (i, pattern) =>
      i >= 0 && i < count && frames[i].label !== null && execRegExp(pattern, frames[i].label) !== null;
    const promise = (i) => i >= 0 && i < count && frames[i].label === 'new Promise' && frames[i].located === null;
    const starts = (i) => known(i) && (named(i, HELPER_START) || (frames[i].anonymous && promise(i - 1)));
    for (let i = 0; i < count; i += 1) helper[i] = named(i, HELPER_NAME);
    const last = count - 3;
    if (last >= 0 && frames[last].label === 'step' && named(last + 1, ITERATOR_STEP) && named(last + 2, SETTLED_STEP)) {
      helper[last] = true;
      helper[last + 1] = true;
      helper[last + 2] = true;
    }
    // Grown from the frames known so far, one neighbour at a time.
    let changed = true;
    for (let pass = 0; changed && pass < count; pass += 1) {
      changed = false;
      for (let i = 0; i < count; i += 1) {
        if (helper[i]) continue;
        let joins = false;
        if (promise(i)) {
          joins = (known(i - 1) && frames[i - 1].anonymous) || (known(i + 1) && named(i + 1, HELPER_START));
        } else if (frames[i].anonymous) {
          joins =
            (promise(i + 1) && (known(i - 1) || named(i + 2, HELPER_START))) ||
            (promise(i - 1) && known(i - 1)) ||
            // SWC's next, below its step and above the helper calling it,
            // which is never another step, and is in a file: SWC's
            // asyncGeneratorStep. An object literal's method whose
            // generator body calls a function of the page's named step has
            // the same two names over the engine's own Generator.next, which
            // is in no file, and is the page's code.
            (named(i, ITERATOR_ANONYMOUS) &&
              named(i - 1, STEP) &&
              known(i + 1) &&
              frames[i + 1].located !== null &&
              !named(i + 1, STEP)) ||
            // The wrapper Babel 7.27 and later put around regenerator's body
            // when it is reached through regeneratorRuntime, as an older
            // regenerator plugin's output does: always just below the body,
            // which only the runtime calls, and above the runtime's own frame.
            (named(i - 1, GENERATED_BODY) && known(i + 1) && frames[i + 1].located !== null);
        } else if (named(i, HELPER_INNER)) {
          // Above a helper's frame that is in a file (not above a native
          // Generator.next, which a library driving the page's own generator
          // calls too), or below one that did not start a promise.
          joins = (known(i + 1) && frames[i + 1].located !== null) || (known(i - 1) && !starts(i - 1));
        }
        if (joins) {
          helper[i] = true;
          changed = true;
        }
      }
    }
    const started = [];
    for (let i = 0; i < count; i += 1) started[i] = starts(i);
    return { helper, started };
  }

  /** "path:line:column" for a frame in a file, or '' for one that names nowhere. */
  function frameWhere(frame) {
    const located = frame.located;
    if (located === null) return '';
    const path = cleanPath(located[1]);
    // Something that looks like a file, which means an extension on the
    // last segment. "at <anonymous>:1:1" and "at eval:3:9" name nowhere
    // the reader can open, and a bare document path such as /checkout is a
    // route rather than a file, so printing it sends the reader hunting
    // for a source file that never existed. Printing one is worse than
    // printing nothing, because the line around it claims otherwise.
    const query = indexOfString(path, '?');
    if (!path || execRegExp(/\.[a-z0-9]{1,6}$/i, query < 0 ? path : sliceString(path, 0, query)) === null) {
      return '';
    }
    return path + ':' + located[2] + ':' + located[3];
  }

  /**
   * The capture as at most three frames, nearest first.
   *
   * Only ever called on a request that has already failed, so a healthy page
   * never pays for the formatting, which is the expensive half. Every method
   * it uses was taken when this file ran (see the redaction above).
   */
  function callerFrames(error) {
    const out = [];
    try {
      if (!error) return out;
      const text = capturedText(error);
      if (text === null) return out;
      const frames = parseStack(text);
      const { helper, started } = helperFrames(frames);
      const count = frames.length;
      for (let i = 0; i < count && out.length < CALLER_LIMIT; i += 1) {
        if (helper[i]) continue;
        const frame = frames[i];
        let label = frame.label;
        // Where the frames after this one resume once it is printed.
        let next = i;
        const generated = label !== null && execRegExp(GENERATED_BODY, label) !== null;
        if (i + 1 < count && helper[i + 1] && (frame.anonymous || generated)) {
          // The body of a compiled async function, just above its helper.
          // When the helper is the one that made the function's promise,
          // the frame below it is that function: printed once, under its
          // own name, at the line in the body, as a native async function
          // is printed.
          let end = i + 1;
          while (end < count && helper[end]) end += 1;
          const outer = end < count ? frames[end] : null;
          // Unless this may not be the body at all, but a frame of a helper
          // this file does not know, between the body and the helper frames
          // it does: folding it would print the helper's line under the
          // page function's name, which sends the reader to the wrong file.
          // The frame above a body is what the body called. Above an
          // unknown helper frame is the body, anonymous or regenerator's,
          // or another frame of the helper's, named like one (step), past
          // any frames of the helper that is still running it. Such a frame
          // is printed as it is. Not one named like that which called this
          // file itself, though: a helper's step calls a body, never fetch,
          // so that is a function of the page's called step.
          let up = i - 1;
          while (up >= 0 && helper[up] && !started[up]) up -= 1;
          const above = up >= 0 && !helper[up] ? frames[up] : null;
          const sender = up === 0 || (up > 0 && execRegExp(CDR_FRAME, frames[up - 1].line) !== null);
          const unsure =
            above !== null &&
            above.located !== null &&
            (above.anonymous ||
              (above.label !== null &&
                (execRegExp(GENERATED_BODY, above.label) !== null ||
                  (execRegExp(HELPER_INNER, above.label) !== null && !sender)))) &&
            execRegExp(CDR_FRAME, above.line) === null &&
            execRegExp(VENDOR_FRAME, above.line) === null;
          if (!unsure && started[end - 1] && outer !== null && outer.located !== null && !outer.anonymous) {
            label = outer.label;
            next = end;
            // Babel compiles `async function load()` to a load() that
            // calls _load(), which holds the helper: one function.
            const below = end + 1 < count ? frames[end + 1] : null;
            if (
              below !== null &&
              below.label !== null &&
              '_' + below.label === label &&
              below.located !== null &&
              below.located[1] === outer.located[1]
            ) {
              label = below.label;
              next = end + 1;
            }
          } else if (generated) {
            label = null;
          }
        }
        if (execRegExp(CDR_FRAME, frame.line) !== null) continue;
        // Only three frames are kept, and a framework's own dispatch is never
        // the answer to "who sent this request". Measured on the React
        // fixture, the third slot went to react-dom's callCallback while the
        // page's own caller sat just below the cut.
        if (execRegExp(VENDOR_FRAME, frame.line) !== null) continue;
        const where = frameWhere(frame);
        // Nowhere to point at: the async function below, if it was to be
        // folded into this frame, is then read for itself.
        if (!where) continue;
        i = next;
        if (label !== null && execRegExp(LIBRARY_NAME, label) !== null) continue;
        // Its own index (see append): this list goes into the entry.
        append(out, sliceString(label !== null ? label + ' (' + where + ')' : where, 0, CALLER_MAX_STRING));
      }
    } catch {
      /* ignore */
    }
    return out;
  }

  /**
   * 'aborted' or 'timeout' when the page ended a fetch itself, otherwise ''.
   *
   * The signal is asked rather than the error. abort(reason) rejects with
   * whatever reason the page passed, which need not be an AbortError at all,
   * while signal.aborted is true however it was aborted. AbortSignal.timeout()
   * aborts with a TimeoutError, which is what separates the two outcomes.
   */
  function cancelledBy(signal, error) {
    try {
      if (signal && signal.aborted) {
        const reason = signal.reason;
        return reason && reason.name === 'TimeoutError' ? 'timeout' : 'aborted';
      }
      if (error && error.name === 'AbortError') return 'aborted';
    } catch {
      /* a page signal of its own that threw */
    }
    return '';
  }

  // ----------------------------------------------------------------- fetch --
  // The prototype of every promise the engine makes, a native fetch's
  // included, read off the promise an async function returns, which is
  // always the realm's own. window.Promise is not: zone.js (Angular) and
  // Bluebird replace it, and on a tab that was open before the extension
  // could start there the worker injects this file after them (see
  // startedLate). A then taken from window.Promise threw on every fetch of
  // such a page, since theirs read state only their own promises have. The
  // engine's own then is no better there: zone.js replaces it too, with
  // one that wraps each promise in one of its own.
  const PROMISE_PROTO = prototypeOf((async () => {})());

  // The engine's own then, as it is at document_start, before any script of
  // the page's has run. Only then: after a late start it is whatever the
  // page has left on the prototype, and an await stands in (see chained).
  const intrinsicThen = startedLate ? undefined : readIn(PROMISE_PROTO, 'then');
  const ownKeysOf = Reflect.ownKeys;

  /**
   * A fetch's promise of the engine's own, chained to answered and failed,
   * for the page to have in its place: a promise of the engine's own that
   * settles a microtask after it, with the same value or the same error.
   *
   * Through the engine's then taken at document_start, called on the promise
   * directly, so nothing the page puts on Promise.prototype later takes
   * part. An await did the same only while the promise's constructor was
   * the engine's: core-js, where it forces its own Promise, replaces then
   * and deletes that constructor, and the await then called core-js's then
   * once more on every fetch.
   *
   * After a late start the engine's then may be gone already: zone.js
   * replaces it with one that wraps each promise in one of its own, and a
   * then taken from window.Promise threw on every fetch of a zone.js or
   * Bluebird page. The await reacts inside the engine wherever the
   * constructor is still the engine's, as on those pages, and calls the
   * page's then once where core-js has deleted it.
   */
  function chained(pending, answered, failed) {
    const onAnswer = (response) => {
      answered(response);
      return response;
    };
    const onFail = (error) => {
      failed(error);
      throw error;
    };
    if (typeof intrinsicThen === 'function') return reflectApply(intrinsicThen, pending, [onAnswer, onFail]);
    return awaited(pending, onAnswer, onFail);
  }

  /** onAnswer or onFail run with what pending settles with, by an await. */
  async function awaited(pending, onAnswer, onFail) {
    let response;
    try {
      response = await pending;
    } catch (error) {
      return onFail(error);
    }
    return onAnswer(response);
  }

  /**
   * A promise the page's own fetch handed back that is not a plain one of
   * the engine's: a library's (zone.js's, Bluebird's), or the engine's with
   * properties of the page's on it (p.abort, p.requestId). Handed back as
   * it is, the same object, and watched on a side chain: a new promise in
   * its place lost those properties and that identity, and the page threw
   * "p.abort is not a function".
   *
   * The side chain takes a rejection and does not throw it on. One that
   * did would leave a promise nobody handles, reported to the page as an
   * unhandled rejection each time the page handled its own (every request
   * it aborts). The cost is the other way round: a rejection of such a
   * promise the page leaves unhandled is not reported, since the side
   * chain handled it. It is still recorded as a failed request.
   */
  function watched(pending, answered, failed) {
    const onAnswer = (response) => answered(response);
    const onFail = (error) => failed(error);
    if (prototypeOf(pending) === PROMISE_PROTO) {
      if (typeof intrinsicThen === 'function') reflectApply(intrinsicThen, pending, [onAnswer, onFail]);
      else awaited(pending, onAnswer, onFail);
      return;
    }
    // A library's promise, watched with its own then, as the page would.
    const then = pending.then;
    if (typeof then === 'function') reflectApply(then, pending, [onAnswer, onFail]);
  }

  /**
   * Whether a fetch was refused for what it was called with (a body on a GET,
   * a url it cannot parse, a header it does not allow) rather than failing on
   * the network. Chrome rejects it before anything is sent, with a TypeError
   * that names fetch, where a request that failed after it was sent says
   * "Failed to fetch".
   */
  const REFUSED_PREFIX = "Failed to execute 'fetch' on ";
  function refusedBy(error) {
    try {
      const message = error && typeof error === 'object' ? error.message : undefined;
      return (
        typeof message === 'string' &&
        sliceString(message, 0, REFUSED_PREFIX.length) === REFUSED_PREFIX &&
        prototypeOf(error) === TYPE_ERROR_PROTO
      );
    } catch {
      return false;
    }
  }

  const nativeFetch = readIn(window, 'fetch');
  if (typeof nativeFetch === 'function') {
    // A proxy of the native (see wrapNative), whose trap is handed exactly
    // what the page passed. callerFrames() knows its frames by the file.
    const relayFetch = (self, args) => {
      let method = 'GET';
      let url = '';
      let signal = null;
      try {
        const input = args[0];
        const init = args[1];
        // Each member read once: an init object can carry getters, and the
        // native fetch reads them again after this.
        const address = typeof input === 'string' ? input : input && input.url;
        url = typeof input === 'string' ? input : address ? address : NativeString(input);
        method = (init && init.method) || (input && input.method) || 'GET';
        // Kept for the rejection, to tell a request the page cancelled from
        // one that failed. A Request always carries a signal, and init
        // overrides it even with null, as the Request constructor does.
        const given = init ? init.signal : undefined;
        signal = given !== undefined ? given : (input && input.signal) || null;
      } catch {
        /* ignore */
      }
      const started = elapsed();
      // Here, where the caller is still on the stack. By the time the promise
      // settles it is not, and the frames below this one are the microtask
      // queue rather than anybody's code.
      const stack = captureStack();

      const answered = (response) => {
        try {
          // The status, not response.ok. A no-cors response (status 0), a
          // manual redirect (0) and a 304 all have ok false and none of them
          // failed. The XHR branch below draws the line at 400 as well.
          if (response.status >= 400) {
            // Each cut, the method and the status text too: both come from
            // the page or its server, and a reason phrase can be any length.
            const entry = {
              method: truncate(upperCase(NativeString(method))),
              url: truncate(url),
              status: response.status,
              statusText: truncate(response.statusText),
              ms: round(elapsed() - started),
              via: 'fetch',
            };
            const caller = callerFrames(stack);
            if (caller.length) setOwn(entry, 'caller', caller);
            push('network', entry);
          }
        } catch {
          /* ignore */
        }
      };
      const failed = (error) => {
        try {
          const outcome = cancelledBy(signal, error);
          // Refused for its own arguments, it never reached the network, and
          // is the page's own mistake rather than a failure of the server or
          // the connection: said apart, so the prompt does not send the
          // reader looking at either.
          const refused = !outcome && refusedBy(error);
          const message = error && error.message ? error.message : error;
          const entry = {
            method: truncate(upperCase(NativeString(method))),
            url: truncate(url),
            status: 0,
            statusText: outcome
              ? ''
              : refused
                ? truncate(`Not sent: ${message}`)
                : blockedNote(url) || truncate(`Network failure: ${message}`),
            ms: round(elapsed() - started),
            via: 'fetch',
          };
          if (outcome) setOwn(entry, 'outcome', outcome);
          if (refused) setOwn(entry, 'notSent', true);
          const caller = callerFrames(stack);
          if (caller.length) setOwn(entry, 'caller', caller);
          push('network', entry);
        } catch {
          /* ignore */
        }
      };

      // A throw from the page's own fetch, on a tab where this file started
      // after the page replaced it, reaches the page as it would have.
      const pending = reflectApply(nativeFetch, self, args);
      try {
        if (pending === null || (typeof pending !== 'object' && typeof pending !== 'function')) return pending;
        if (prototypeOf(pending) === PROMISE_PROTO && ownKeysOf(pending).length === 0) {
          return chained(pending, answered, failed);
        }
        // From a fetch the page replaced before this file started.
        watched(pending, answered, failed);
      } catch {
        /* a promise of the page's that would not be watched: handed back as it is */
      }
      return pending;
    };
    wrapIn(window, 'fetch', nativeFetch, (_native, self, args) => relayFetch(self, args));
  }

  // ------------------------------------------------------------------- XHR --
  // Each open() starts a record of its own, kept in a WeakMap of the
  // collector's rather than on the object. An own property would show in the
  // page's own Object.keys and JSON.stringify of the object, the url and
  // method with it, and assigning one writes onto whatever `this` the page
  // called the method with, XMLHttpRequest or not. The WeakMap keeps nothing
  // alive: an object's entry goes when the object does.
  //
  // One object can carry two requests at once. A page may reopen it from
  // inside a handler of the request that is just finishing: a retry in
  // ontimeout, the next long poll in onload. That request's remaining events,
  // its loadend included, are still dispatched after the reopen, by which time
  // open() has reset status to 0. Read naively, a timed out request's retry is
  // labelled a timeout, and every successful long poll is recorded as a
  // network failure. So open() parks the finishing record with the status it
  // ended on, and recordFor() credits those late events to it. abort() on a
  // finished request does the same, for the same reason: Chrome fires no event
  // for it and drops the status to 0 before the loadend arrives.
  const XHR_PROTO = readIn(typeof XMLHttpRequest === 'function' ? XMLHttpRequest : null, 'prototype');
  const nativeOpen = readIn(XHR_PROTO, 'open');
  const nativeSend = readIn(XHR_PROTO, 'send');
  const nativeAbort = readIn(XHR_PROTO, 'abort');
  // Both taken now, at document_start, before the page can replace them. A
  // page running zone.js or fake timers would otherwise see the collector's
  // timer and listeners as its own: an extra change detection pass on every
  // request, a test that waits on them, or a timer that never fires because
  // the clock is stopped.
  //
  // On a tab that was open before the extension could start there, this
  // file runs after the page's scripts (see startedLate), and zone.js may
  // have replaced both already: they are taken from the natives it kept
  // (see beforeZone). Through its copies, every listener below would be a
  // task of the zone the page's request was opened in, and in Angular each
  // task that runs is a change detection pass. Measured with zone.js in
  // Chrome for Testing 156: a failed XHR ran 8 tasks in the page's zone
  // instead of 3, three readystatechange, a loadend and a timer of the
  // collector's.
  const nativeSetTimeout = beforeZone(window, 'setTimeout');
  const nativeAddEventListener = beforeZone(EventTarget.prototype, 'addEventListener');

  const xhrs = new WeakMap();
  const weakGet = uncurry(WeakMap.prototype.get);
  const weakSet = uncurry(WeakMap.prototype.set);

  /**
   * One object's bookkeeping, made on first use: req is the request its last
   * open() started, parked a finished one whose late events are still due
   * (see park()), and hooked whether the listeners are on.
   */
  function stateOf(xhr) {
    let state = weakGet(xhrs, xhr);
    if (!state) {
      state = { req: null, parked: null, hooked: false };
      weakSet(xhrs, xhr, state);
    }
    return state;
  }

  /** The request this object's last open() started, if any. */
  function currentOf(xhr) {
    const state = weakGet(xhrs, xhr);
    return state ? state.req : null;
  }

  /**
   * The record an abort, timeout or loadend event belongs to. A finishing
   * request's own events arrive while the object is DONE (readyState 4). Late
   * ones arrive after a reopen has moved it back to OPENED, or while it is DONE
   * for a synchronous request a handler ran to the end, which has settled by
   * then: a settled record gets no more events of its own.
   */
  function recordFor(xhr) {
    const state = weakGet(xhrs, xhr);
    if (!state) return null;
    const current = state.req;
    if (xhr.readyState === 4 && current && !current.settled) return current;
    return state.parked || current;
  }

  /**
   * The request on this object, with the status it ended on, if it has ended
   * (DONE) but its loadend has not settled it yet. That only happens inside
   * one of its own handlers. Read before the open() or abort() that is about to
   * clear the status, and handed to park() once that call has gone through.
   * A record is parked once at most, which keeps the chain below acyclic.
   */
  function finishing(xhr) {
    const record = currentOf(xhr);
    if (!record || !record.sent || record.settled || record.ended || xhr.readyState !== 4) {
      return null;
    }
    return { record, status: xhr.status, statusText: xhr.statusText, timeout: xhr.timeout };
  }

  /**
   * The request on this object if it is still in flight: sent, not yet DONE,
   * and not settled. Read before an open() that cancels it or an abort() that
   * ends it, since afterwards nothing on the object says it was running.
   */
  function inFlight(xhr) {
    const record = currentOf(xhr);
    if (!record || !record.sent || record.settled || record.ended) return null;
    const readyState = xhr.readyState;
    return readyState >= 1 && readyState <= 3 ? record : null;
  }

  /** Credit a finished request's late events to its own record. */
  function park(xhr, { record, status, statusText, timeout }) {
    const state = stateOf(xhr);
    // The time too, for a record its fallback below settles a task later.
    record.ended = { status, statusText, at: elapsed(), timeout };
    // Parks can nest. A handler of a parked request can finish a second one
    // synchronously, with an abort() or a synchronous send(), and that one is
    // parked in turn when the handler reopens. Chrome then delivers the inner
    // request's late events first and the outer's after, so the slot is a
    // stack: settle() hands it back to the record underneath.
    record.under = state.parked || null;
    state.parked = record;
    try {
      // In case no further event arrives for it. settle() ignores a record its
      // loadend has already recorded.
      reflectApply(nativeSetTimeout, window, [() => settle(xhr, record), 0]);
      record.fallback = true;
    } catch {
      /* ignore */
    }
  }

  /** Record a request once, if it failed. Safe to call more than once. */
  function settle(xhr, record) {
    try {
      if (!record || !record.sent || record.settled) return;
      record.settled = true;
      const state = weakGet(xhrs, xhr);
      if (state && state.parked === record) {
        let below = record.under;
        while (below && below.settled) below = below.under;
        state.parked = below || null;
      }
      record.under = null;

      // A parked record carries the status it ended on; the object's own
      // status now belongs to the request that replaced it.
      const status = record.ended ? record.ended.status : xhr.status;
      const statusText = record.ended ? record.ended.statusText : xhr.statusText;
      const end = record.ended ? record.ended.at : elapsed();
      const limit = record.ended ? record.ended.timeout : xhr.timeout;

      // Released before the success early return below. An unformatted V8
      // Error holds a strong reference to every recorded frame's function and
      // receiver, so a long lived XHR, which is how a page long polls, would
      // pin those objects for as long as it lives. Only a failure pays for
      // formatting it.
      const stack = record.stack;
      record.stack = null;

      // status 0 means the request never got a response: CORS rejection,
      // connection refused, or ended by the page, which the abort and timeout
      // listeners have noted on the record.
      if (!(status === 0 || status >= 400)) return;
      const ms = round(end - (record.started || end));
      let outcome = status === 0 ? record.outcome : '';
      // A request that got no response and ran for the whole of its timeout
      // timed out: anything else that ends one with no response, a refused
      // connection or a CORS rejection, ends it sooner, and the timeout would
      // have fired first otherwise. This is for a page whose own listener,
      // added before the first open(), stopped the timeout event before it
      // reached the collector's (F10).
      if (status === 0 && !outcome && typeof limit === 'number' && limit > 0 && ms >= limit - 1) {
        outcome = 'timeout';
      }
      const url = record.url || xhr.responseURL || '';
      const entry = {
        method: truncate(upperCase(NativeString(record.method || 'GET'))),
        url: truncate(url),
        status,
        statusText:
          status === 0 ? (outcome ? '' : blockedNote(url) || 'Network failure') : truncate(statusText),
        ms,
        via: 'xhr',
      };
      if (outcome) setOwn(entry, 'outcome', outcome);
      const caller = callerFrames(stack);
      if (caller.length) setOwn(entry, 'caller', caller);
      push('network', entry);
    } catch {
      /* ignore */
    }
  }

  /**
   * The listeners, put on once per object rather than once per send. A page
   * that long-polls by reusing a single XMLHttpRequest would otherwise
   * accumulate one listener per send and record the same failure N times,
   * flushing every other entry out of the ring buffer. They go on at the
   * first open() rather than the first send(), so that a listener the page
   * adds between the two cannot stop an event (stopImmediatePropagation)
   * before it reaches them. One added before the first open() runs ahead of
   * them, since listeners on one target run in the order they were added,
   * whatever their capture flag (Chrome 156), and nothing short of replacing
   * the constructor would go on earlier. Such a listener has to stop every
   * event the request ends with to hide it (see the backstop).
   */
  function hook(xhr, state) {
    if (state.hooked) return;
    state.hooked = true;
    // Both fire before loadend, which is how a request the page ended
    // itself is told apart from one that failed.
    const mark = (event) => {
      try {
        const target = recordFor(xhr);
        if (target && !target.settled) {
          target.outcome = event.type === 'timeout' ? 'timeout' : 'aborted';
        }
      } catch {
        /* ignore */
      }
      backstop();
    };
    reflectApply(nativeAddEventListener, xhr, ['abort', mark]);
    reflectApply(nativeAddEventListener, xhr, ['timeout', mark]);
    // A backstop for a page listener, added before the first open(), that
    // stops the loadend event before it reaches the one below (F10). The
    // object turns DONE, and says so with a readystatechange, before any of
    // load, error, timeout, abort and loadend is dispatched, so a failure
    // seen at any of them is settled a task later if its loadend has not
    // settled it by then, by one timer per request. Each of them, since
    // such a listener can stop the readystatechange too. A success needs
    // nothing, and costs a property read or two.
    const backstop = () => {
      try {
        if (xhr.readyState !== 4) return;
        const record = currentOf(xhr);
        if (!record || !record.sent || record.settled || record.ended || record.backstop) return;
        const status = xhr.status;
        if (status !== 0 && status < 400) return;
        reflectApply(nativeSetTimeout, window, [() => settle(xhr, record), 0]);
        record.backstop = true;
      } catch {
        /* ignore */
      }
    };
    const ended = () => {
      try {
        const record = recordFor(xhr);
        // A request that ended with no response and was parked waits for its
        // fallback, a task from now, rather than being settled here unlabelled.
        // When a handler of its readystatechange runs a synchronous request
        // to the end, Chrome dispatches that request's load and loadend once
        // more before this request's own timeout or abort event, so this
        // loadend can come first. A plain network failure is only recorded a
        // task later for it.
        if (record && record.fallback && !record.outcome && record.ended.status === 0) return;
        settle(xhr, record);
      } catch {
        /* ignore */
      }
    };
    // Called through Reflect.apply, taken at the top, rather than through a
    // .call looked up on the page's Function.prototype.
    reflectApply(nativeAddEventListener, xhr, ['readystatechange', backstop]);
    reflectApply(nativeAddEventListener, xhr, ['load', backstop]);
    reflectApply(nativeAddEventListener, xhr, ['error', backstop]);
    reflectApply(nativeAddEventListener, xhr, ['loadend', ended]);
  }

  // Proxies of the natives (see wrapNative); callerFrames() knows their
  // frames by this file's name. Each trap is handed exactly what the page
  // passed, so open('GET') still throws for a missing url rather than
  // quietly requesting one called "undefined".
  function relayOpen(xhr, args) {
    const method = args[0];
    const url = args[1];
    let state = null;
    let ended = null;
    let cancelled = null;
    let previous = null;
    try {
      state = stateOf(xhr);
      ended = finishing(xhr);
      cancelled = inFlight(xhr);
      previous = { req: state.req, parked: state.parked };
      // In place before the native open() runs, because that call fires a
      // readystatechange of its own, and a page may send() from it.
      state.req = {
        method,
        url,
        // Captured in open() rather than send(), because open() is where the
        // caller is. A library queues the send a tick later from a helper of
        // its own, and by then the stack names the library, not the page.
        stack: captureStack(),
        started: 0,
        sent: false,
        outcome: '',
        settled: false,
        ended: null,
        // Every field read later is an own one from the start. One left for
        // park() to add would be looked up on Object.prototype until then,
        // where a page can put anything: a fallback that read as true there
        // would stop the loadend listener from settling any request at all.
        under: null,
        fallback: false,
        backstop: false,
      };
    } catch {
      /* ignore */
    }
    let result;
    try {
      result = reflectApply(nativeOpen, xhr, args);
    } catch (error) {
      // A method or url the browser refuses throws before anything on the
      // object changes. The request on it is still the one in progress, so
      // the bookkeeping goes back to match.
      try {
        if (previous) {
          state.req = previous.req;
          state.parked = previous.parked;
        }
      } catch {
        /* ignore */
      }
      throw error;
    }
    try {
      if (ended) park(xhr, ended);
      if (cancelled) {
        // Chrome cancels a request still in flight here and dispatches no
        // event for it, not even loadend, so nothing else would ever record
        // it. It is the page ending its own request, as abort() is, and an
        // abort() of it is recorded as aborted.
        cancelled.outcome = 'aborted';
        cancelled.ended = { status: 0, statusText: '', at: elapsed(), timeout: 0 };
        settle(xhr, cancelled);
      }
      // Only now, once the native open() has accepted the object, which no object
      // but an XMLHttpRequest does.
      hook(xhr, state);
    } catch {
      /* ignore */
    }
    return result;
  }

  function relayAbort(xhr, args) {
    let ended = null;
    let running = null;
    try {
      ended = finishing(xhr);
      running = inFlight(xhr);
      // Labelled before the native abort() dispatches anything, rather than
      // left to the abort listener. Chrome can deliver a loadend ahead of the
      // abort event (see the loadend listener), and a listener the page added
      // before ours can stop the event from reaching it.
      if (running) running.outcome = 'aborted';
    } catch {
      /* ignore */
    }
    const result = reflectApply(nativeAbort, xhr, args);
    try {
      if (ended) park(xhr, ended);
      // The native abort() has dispatched its loadend by now, so if no
      // listener of ours got to settle the request, nothing else will.
      if (running) settle(xhr, running);
    } catch {
      /* ignore */
    }
    return result;
  }

  function relaySend(xhr, args) {
    let record = null;
    let before = null;
    let opened = false;
    try {
      record = currentOf(xhr);
      opened = xhr.readyState === 1;
      if (record) {
        before = { started: record.started, sent: record.sent };
        record.started = elapsed();
        record.sent = true;
      }
      // On since open() as a rule, but a page can send() from the
      // readystatechange that open() fires, before open() returns.
      if (opened) hook(xhr, stateOf(xhr));
    } catch {
      /* ignore */
    }
    try {
      return reflectApply(nativeSend, xhr, args);
    } catch (error) {
      try {
        if (opened && record && xhr.readyState === 4) {
          // A synchronous request that failed at the network level (refused,
          // a CORS rejection) throws out of send() and fires no event at all,
          // loadend included, so nothing else would ever record it. It is the
          // one throw that moves the object from OPENED to DONE.
          settle(xhr, record);
        } else if (record && before) {
          // Refused outright (InvalidStateError: sent twice, or not opened).
          // The request, if one is running, keeps the clock it started with.
          record.started = before.started;
          record.sent = before.sent;
        }
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  // All three or none: a send() wrapped without its open() would find no
  // record to keep, and an open() without its send() would never start one.
  if (typeof nativeOpen === 'function' && typeof nativeSend === 'function' && typeof nativeAbort === 'function') {
    wrapIn(XHR_PROTO, 'open', nativeOpen, (_native, xhr, args) => relayOpen(xhr, args));
    wrapIn(XHR_PROTO, 'abort', nativeAbort, (_native, xhr, args) => relayAbort(xhr, args));
    wrapIn(XHR_PROTO, 'send', nativeSend, (_native, xhr, args) => relaySend(xhr, args));
  }

  // ---------------------------------------------------------------- inspect --
  // The element picker runs in the ISOLATED world, where the framework internals
  // React and Vue hang off DOM nodes as expando properties are invisible. It
  // marks the node the user clicked with an attribute and asks this script to
  // describe it.
  //
  // Everything here formats as well as reads. The reply crosses postMessage, so
  // it has to survive structured clone: plain strings, numbers and arrays only,
  // never a fiber, a component instance or a live prop value. It also means the
  // prompt template only has to print strings.

  const CLIMB_LIMIT = 500; // parentElement steps before giving up
  const NAME_LIMIT = 5; // components reported, nearest first
  const PROP_LIMIT = 12; // props reported for the nearest component
  const PROP_MAX_STRING = 60; // characters kept from a string prop

  /**
   * One prop value as a short display string.
   *
   * serialize() above is for console arguments and has a different job: it
   * keeps stacks, walks whole object graphs and detects cycles. A prop list
   * wants one readable line per key, so nothing is expanded here.
   */
  function summariseValue(value) {
    try {
      if (typeof value === 'string') {
        const clipped =
          value.length > PROP_MAX_STRING ? value.slice(0, PROP_MAX_STRING) + '…' : value;
        // JSON.stringify quotes and escapes newlines, which is what keeps a
        // multi-line string prop on one line of the prompt.
        return JSON.stringify(clipped);
      }
      if (typeof value === 'function') {
        // fn.bind() names the copy "bound fn", which no source contains: the
        // name to search for is what follows.
        const name = execRegExp(/^(?:bound )*(.*)$/s, text(value.name) || '');
        return name && name[1] ? 'ƒ ' + name[1] : 'ƒ';
      }
      if (value === null || value === undefined || typeof value !== 'object') {
        return String(value);
      }
      if (value.$$typeof) {
        const type = value.type;
        const label = typeof type === 'string' ? type : nameOf(type);
        return '<' + (label || 'Element') + ' />';
      }
      if (Array.isArray(value)) return 'Array(' + value.length + ')';
      return '{…}';
    } catch {
      return '{…}';
    }
  }

  /**
   * Whether a value under a secret looking name is withheld. Not a boolean,
   * null or undefined, which can hold no secret and often answer the
   * question (hasPassword: false), and not a function, whose name is a
   * handler's and not a value.
   */
  function withheld(value) {
    return value != null && typeof value !== 'boolean' && typeof value !== 'function';
  }

  // The value of a password field under an innocent name: a design system's
  // <PasswordField type="password" value={pw}>, or a Vue v-model.
  const VALUE_PROPS = ['value', 'defaultValue', 'modelValue'];
  // The autocomplete tokens of a field whose value is a secret itself: a
  // password, a one-time code, a card's number or its security code. Not
  // cc-name, cc-exp or cc-type, which hold nothing secret, and which a form
  // whose card number is in a payment provider's frame has alone.
  const SECRET_FILL = /(?:^|\s)(?:current-password|new-password|one-time-code|cc-number|cc-csc)(?:\s|$)/i;
  // The ones of those that take digits: a code, a card's number or its code.
  const DIGIT_FILL = /(?:^|\s)(?:one-time-code|cc-number|cc-csc)(?:\s|$)/i;

  /** Whether an autocomplete says a control takes a code or a card's digits. */
  function digitKind(fill) {
    try {
      return execRegExp(DIGIT_FILL, NativeString(fill || '')) !== null;
    } catch {
      return false;
    }
  }

  /**
   * Whether a type and an autocomplete say a control takes a password, a
   * one-time code or a card number: what is typed into it is the secret
   * itself.
   */
  function passwordKind(type, fill) {
    return (
      lowerCase(NativeString(type || '')) === 'password' ||
      execRegExp(SECRET_FILL, NativeString(fill || '')) !== null
    );
  }

  /** Whether a type says an input is hidden. */
  function hiddenKind(type) {
    return lowerCase(NativeString(type || '')) === 'hidden';
  }

  /**
   * What the props of the summarised component say of it by themselves: 2
   * when they describe a password, code or card field, 1 when a hidden one
   * (a component that is a CSRF token field), 0 otherwise. Asked through the
   * natives taken at the top, as the name test is.
   */
  function fieldKind(props) {
    try {
      if (passwordKind(props.type, props.autoComplete || props.autocomplete)) return 2;
      return hiddenKind(props.type) ? 1 : 0;
    } catch {
      return 0;
    }
  }

  // The form controls whose value is read, and how: through the natives'
  // own getters, taken now, as everything the redaction relies on is.
  const FIELD_TAGS = ['input', 'textarea', 'select'];
  const FIELD_VALUE = { __proto__: null };
  if (typeof HTMLInputElement === 'function') {
    FIELD_VALUE.input = nativeGetter(HTMLInputElement.prototype, 'value');
  }
  if (typeof HTMLTextAreaElement === 'function') {
    FIELD_VALUE.textarea = nativeGetter(HTMLTextAreaElement.prototype, 'value');
  }
  if (typeof HTMLSelectElement === 'function') {
    FIELD_VALUE.select = nativeGetter(HTMLSelectElement.prototype, 'value');
  }
  /** A native method, uncurried, or null where this realm has none. */
  function nativeMethod(proto, key) {
    try {
      const descriptor = proto && ownDescriptor(proto, key);
      return descriptor && typeof descriptor.value === 'function' ? uncurry(descriptor.value) : null;
    } catch {
      return null;
    }
  }
  const attributeOf = nativeMethod(ELEMENT_PROTO, 'getAttribute');
  const attributeNamesOf = nativeMethod(ELEMENT_PROTO, 'getAttributeNames');
  // A password field of a design system's own element (<sl-input
  // type="password">) keeps its <input> in a shadow root, which the
  // element's own children and the framework's tree do not reach.
  const shadowOf = nativeGetter(ELEMENT_PROTO, 'shadowRoot');
  const queryIn = nativeMethod(
    typeof DocumentFragment === 'function' ? DocumentFragment.prototype : null,
    'querySelector'
  );
  const queryAllInRoot = nativeMethod(
    typeof DocumentFragment === 'function' ? DocumentFragment.prototype : null,
    'querySelectorAll'
  );
  // The document is asked for its secret controls too (see documentValues),
  // through its own querySelectorAll and getElementsByTagName, and the
  // lists they answer read through their own natives.
  const DOCUMENT_PROTO = typeof Document === 'function' ? Document.prototype : null;
  const queryAllIn = nativeMethod(DOCUMENT_PROTO, 'querySelectorAll');
  const tagsIn = nativeMethod(DOCUMENT_PROTO, 'getElementsByTagName');
  const nodeListLength = typeof NodeList === 'function' ? nativeGetter(NodeList.prototype, 'length') : null;
  const collectionItem = typeof HTMLCollection === 'function' ? nativeMethod(HTMLCollection.prototype, 'item') : null;
  // Any element, a design system's own included, whose type or autocomplete
  // says it takes a secret (see SECRET_FILL).
  const SECRET_CONTROLS =
    '[type="password" i],[autocomplete~="current-password" i],[autocomplete~="new-password" i],' +
    '[autocomplete~="one-time-code" i],[autocomplete~="cc-number" i],[autocomplete~="cc-csc" i]';
  const ATTRIBUTE_LIMIT = 64; // attributes or host props of one control judged by name
  const SUBTREE_LIMIT = 3000; // nodes under a component looked at for a secret control
  const GUARD_VALUES = 64; // values of secret controls remembered for one pick
  const DOCUMENT_CONTROLS = 32; // secret controls of the document read for one pick
  const DOCUMENT_NAMED = 256; // form controls of each tag judged by name for one pick
  const SHADOW_LIGHT = 100000; // elements of the document asked for an open shadow root for one pick
  const SHADOW_ROOTS = 512; // open shadow roots of the document looked into for one pick
  // Elements in them asked for a shadow root of their own for one pick, and
  // as many controls in them judged.
  const SHADOW_NODES = 10000;
  // In a shadow root, any element either kind of the document's could be:
  // one of FIELD_TAGS, or one SECRET_CONTROLS matches.
  const SHADOW_CONTROLS = 'input,textarea,select,' + SECRET_CONTROLS;

  /** Remembers a secret control's value, to withhold any prop that holds it. */
  function holdValue(guard, value) {
    if (!((typeof value === 'string' && value) || typeof value === 'number')) return;
    const text = NativeString(value);
    if (!listed(guard.values, text) && guard.values.length < GUARD_VALUES) {
      guard.values[guard.values.length] = text;
    }
  }

  // Longer than any card number, phone number or account number written in
  // groups: text past it is never judged by its digits (cardDigits).
  const CARD_TEXT = 64;

  /**
   * The digits of a number SEED_LENGTH digits long or longer written with
   * nothing but digits and what groups them (white space, dashes, dots,
   * slashes, parentheses or a plus, as seedLike reads a number), in
   * CARD_TEXT characters or fewer: a card's number however a form groups
   * it. Otherwise null. Read by index.
   */
  function cardDigits(text) {
    if (text.length > CARD_TEXT) return null;
    let digits = '';
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i];
      if (c >= '0' && c <= '9') digits += c;
      else if (!(whiteSpace(c) || c === '-' || c === '.' || c === '/' || c === '(' || c === ')' || c === '+')) return null;
    }
    return digits.length >= SEED_LENGTH ? digits : null;
  }

  /** The digits of each held value that is such a number (cardDigits), once a pick. */
  function cardForms(held) {
    const cards = [];
    for (let i = 0; i < held.length; i += 1) {
      const digits = cardDigits(held[i]);
      if (digits !== null) cards[cards.length] = digits;
    }
    return cards;
  }

  /** What a control's own value getter answers, for a native form control. */
  function holdFieldValue(guard, element, kind) {
    const read = FIELD_VALUE[kind];
    if (!element || !read) return;
    try {
      holdValue(guard, read(element));
    } catch {
      /* not that element after all */
    }
  }

  /** The element's tag, lowercased, or '' for what is not one. */
  function tagOf(element) {
    try {
      return element && elementTag ? lowerCase(NativeString(elementTag(element))) : '';
    } catch {
      return '';
    }
  }

  /** The element's attribute, or null. */
  function attributeIn(element, name) {
    if (!element || !attributeOf) return null;
    try {
      return attributeOf(element, name);
    } catch {
      return null;
    }
  }

  /**
   * What a secret control of the document holds: a form control's value, or
   * for a design system's element (<x-pw type="password">) the value
   * attribute and the value of the field in its open shadow root, one level
   * down. Never a getter of the element's own, which is the page's code.
   */
  function holdControlValue(guard, element) {
    const kind = tagOf(element);
    if (listed(FIELD_TAGS, kind)) {
      holdFieldValue(guard, element, kind);
      return;
    }
    holdValue(guard, attributeIn(element, 'value'));
    if (!shadowOf || !queryIn) return;
    try {
      const root = shadowOf(element);
      const inner = root ? queryIn(root, 'input,textarea') : null;
      if (inner) holdFieldValue(guard, inner, tagOf(inner));
    } catch {
      /* no shadow root to ask */
    }
  }

  /** A list querySelectorAll answered, by its native length. */
  function listLength(list) {
    return nodeListLength ? nodeListLength(list) : list.length;
  }

  /** An entry of a list getElementsByTagName answered, or null past its end. */
  function itemAt(list, index) {
    return (collectionItem ? collectionItem(list, index) : list[index]) || null;
  }

  /**
   * The values of the document's secret controls, wherever they are: a
   * component handed the password without rendering the field (a strength
   * meter, a list of the rules it meets), a confirm field handed the first
   * one, a form that seeded the field. A password, code or card field by its
   * type or autocomplete, and a form control whose name or id is a secret
   * name, a hidden one included (a csrf_token): which keeps a field marked
   * after a show password toggle has made it type="text". Bounded: the first
   * DOCUMENT_CONTROLS of each kind, the named ones among the first
   * DOCUMENT_NAMED inputs, text areas and selects. Measured in Chrome for
   * Testing on a page of 60,000 elements, 20,000 of them inputs: about 3 ms
   * a pick, nearly all of it the selector, which has to look at every
   * element. The fields in open shadow roots are found by shadowValues; one
   * in a closed shadow root or in a frame is not found.
   */
  function documentValues(guard) {
    if (!queryAllIn || typeof document !== 'object' || document === null) return;
    try {
      const secret = queryAllIn(document, SECRET_CONTROLS);
      const count = listLength(secret);
      for (let i = 0; i < count && i < DOCUMENT_CONTROLS; i += 1) holdControlValue(guard, secret[i]);
      // Read from the start of live lists, which costs only as far as is
      // read, where a selector for them would match every input there is.
      let read = 0;
      for (let t = 0; tagsIn && t < FIELD_TAGS.length; t += 1) {
        const controls = tagsIn(document, FIELD_TAGS[t]);
        for (let i = 0; i < DOCUMENT_NAMED && read < DOCUMENT_CONTROLS; i += 1) {
          const element = itemAt(controls, i);
          if (element === null) break;
          if (namedSecret(element)) {
            holdControlValue(guard, element);
            read += 1;
          }
        }
      }
      shadowValues(guard);
    } catch {
      /* what was read so far */
    }
  }

  /** Whether an element's name or id is a secret name. */
  function namedSecret(element) {
    const name = attributeIn(element, 'name');
    const id = attributeIn(element, 'id');
    return (name ? isSecretText(name) : false) || (id ? isSecretText(id) : false);
  }

  /**
   * The same for the document's open shadow roots, whose hosts need say
   * nothing of what they hold: a <login-form> of the page's own, with its
   * password field inside. The first SHADOW_LIGHT elements of the document
   * are asked for an open shadow root, and each root found is looked into
   * with the roots inside it (shadowTree) before the next root of the light
   * DOM, so the roots are taken depth first, in document order. Looked into
   * after every root of the light DOM, as they were, the roots inside a
   * shell were never reached on a page whose light DOM held SHADOW_ROOTS
   * other roots, hundreds of icons with roots of their own, after the
   * shell included. Bounded: SHADOW_LIGHT elements of the document asked,
   * SHADOW_ROOTS roots looked into, SHADOW_NODES elements in them asked and
   * as many controls judged, and DOCUMENT_CONTROLS controls read. Measured
   * in Chrome for Testing 156 on a page of 60,000 elements, asking each one
   * for its shadow root takes about 1 ms, less than half of what the
   * selector of documentValues takes. A closed shadow root answers nothing.
   */
  function shadowValues(guard) {
    if (!shadowOf || !queryAllInRoot || !tagsIn) return;
    // The light DOM's roots first, as many as could be looked into: asked
    // between them, a root's querySelectorAll made each next element of the
    // live list cost more, 1.5 ms more a pick on a page of 60,000 elements.
    const light = [];
    const all = tagsIn(document, '*');
    for (let i = 0; i < SHADOW_LIGHT && light.length < SHADOW_ROOTS; i += 1) {
      const element = itemAt(all, i);
      if (element === null) break;
      const root = shadowOf(element);
      if (root) append(light, root);
    }
    const walk = { roots: SHADOW_ROOTS, asked: SHADOW_NODES, judged: SHADOW_NODES, read: 0, stack: [] };
    for (let r = 0; r < light.length && walk.roots > 0 && walk.read < DOCUMENT_CONTROLS; r += 1) {
      shadowTree(guard, light[r], walk);
    }
  }

  /**
   * An open shadow root of the light DOM and the roots inside it, depth
   * first in document order: a root's controls are judged as the
   * document's are, by type or autocomplete, or for a form control by name
   * or id, and the roots of its elements are looked into next, the first of
   * them first, each with the roots inside it.
   */
  function shadowTree(guard, first, walk) {
    const stack = walk.stack;
    stack.length = 0;
    append(stack, first);
    while (stack.length > 0 && walk.roots > 0 && walk.read < DOCUMENT_CONTROLS) {
      const root = stack[stack.length - 1];
      stack.length -= 1;
      walk.roots -= 1;
      const controls = queryAllInRoot(root, SHADOW_CONTROLS);
      const count = listLength(controls);
      for (let i = 0; i < count && walk.judged > 0 && walk.read < DOCUMENT_CONTROLS; i += 1) {
        walk.judged -= 1;
        const element = controls[i];
        if (
          passwordKind(attributeIn(element, 'type'), attributeIn(element, 'autocomplete')) ||
          (listed(FIELD_TAGS, tagOf(element)) && namedSecret(element))
        ) {
          holdControlValue(guard, element);
          walk.read += 1;
        }
      }
      if (walk.asked <= 0) continue;
      const inside = queryAllInRoot(root, '*');
      const size = listLength(inside);
      const from = stack.length;
      for (let i = 0; i < size && walk.asked > 0; i += 1) {
        walk.asked -= 1;
        const nested = shadowOf(inside[i]);
        if (nested) append(stack, nested);
      }
      // Turned round, so that the first of them is taken off the stack first.
      for (let a = from, b = stack.length - 1; a < b; a += 1, b -= 1) {
        const swap = stack[a];
        stack[a] = stack[b];
        stack[b] = swap;
      }
    }
  }

  /**
   * Whether a prop's text holds a value of a secret control: is it, holds
   * it whole (a trimmed or formatted copy, a sentence quoting it), is the
   * most of it (a value seeded into a field the user has since typed on
   * the end of), or is it changed in one place (a seed the user has since
   * edited in the middle, see editedFrom). Short values only by equality: a
   * one letter password is in half of everything.
   */
  function holdsSecret(held, text, cards) {
    for (let i = 0; i < held.length; i += 1) {
      if (holds(held[i], text)) return true;
    }
    // A card's number grouped otherwise than the field groups it (raw
    // digits a formatter hands back, dashes, groups of 4, 6 and 5) is judged
    // by its digits, against the digits of each held value that is such a
    // number (cardForms) and no other: a short code found inside the joined
    // digits of a reference number is no copy of it. Those digits quoted
    // whole in any text (a sentence, JSON, a URL) are a copy of it too.
    if (cards.length) {
      for (let i = 0; i < cards.length; i += 1) {
        if (indexOfString(text, cards[i]) >= 0) return true;
      }
      const digits = cardDigits(text);
      if (digits !== null) {
        for (let i = 0; i < cards.length; i += 1) {
          if (holds(cards[i], digits)) return true;
        }
      }
    }
    return false;
  }

  /** One held value against a prop's text, by the rules holdsSecret gives. */
  function holds(value, text) {
    if (text === value) return true;
    if (value.length >= 4 && indexOfString(text, value) >= 0) return true;
    if (text.length >= 4 && text.length * 2 >= value.length && indexOfString(value, text) >= 0) return true;
    return editedFrom(text, value);
  }

  /**
   * Whether a prop's text and a secret control's value differ in one place
   * only (a run of characters put in, taken out or replaced), what they
   * share at their two ends is four characters or more and three quarters
   * of the longer, and the value reads as a passphrase or a seed (seedLike):
   * a passphrase seeded into a field ("correct horse battery") that the user
   * changed in the middle ("correct horse staple battery"). Not a title that
   * only begins with the word a password begins with. Read by index, as the
   * name test reads, so nothing of the page's runs.
   */
  function editedFrom(text, value) {
    const shorter = text.length < value.length ? text.length : value.length;
    const longer = text.length < value.length ? value.length : text.length;
    let start = 0;
    while (start < shorter && text[start] === value[start]) start += 1;
    let end = 0;
    while (end < shorter - start && text[text.length - 1 - end] === value[value.length - 1 - end]) end += 1;
    const shared = start + end;
    return shared >= 4 && shared * 4 >= longer * 3 && seedLike(value);
  }

  // A secret control's value this long or longer may be a seed (see seedLike).
  const SEED_LENGTH = 12;

  /** Whether a character is white space, as \s in a regular expression reads it. */
  function whiteSpace(c) {
    return (
      c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' ||
      c === '\u00a0' || c === '\u1680' || (c >= '\u2000' && c <= '\u200a') ||
      c === '\u2028' || c === '\u2029' || c === '\u202f' || c === '\u205f' || c === '\u3000' || c === '\ufeff'
    );
  }

  /**
   * Whether a secret control's value reads as a passphrase or a seed, the
   * kind a form fills in and the user then edits: words with white space
   * between them, or SEED_LENGTH characters or more, and not a number of
   * fewer than SEED_LENGTH digits however it is grouped (with spaces,
   * dashes, dots, slashes, parentheses or a plus). A one-time code, a
   * phone number or a date is one, and an order number or a total beside
   * it differs from it in a digit or two without being an edit of it:
   * those have rules of their own. A card's number is longer, and a prop
   * a digit away from it holds all of it but that digit. Nor a short
   * password, which an ordinary word is one letter away from (the label
   * Password beside the password Passw0rd, a month beside the password
   * January2024). Read by index.
   */
  function seedLike(value) {
    let spaced = false;
    let number = true;
    let digits = 0;
    for (let i = 0; i < value.length; i += 1) {
      const c = value[i];
      if (whiteSpace(c)) {
        spaced = true;
      } else if (c >= '0' && c <= '9') {
        digits += 1;
      } else if (!(c === '-' || c === '.' || c === '/' || c === '(' || c === ')' || c === '+')) {
        number = false;
      }
    }
    return (!number || digits >= SEED_LENGTH) && (spaced || value.length >= SEED_LENGTH);
  }

  // The shape of a password or a token: no whitespace, a letter and a digit.
  const SECRET_SHAPE = /^(?=.*\p{L})(?=.*\d)\S+$/u;
  // The shape of a one-time code or a card's number or code: three digits or
  // more, perhaps in groups.
  const DIGIT_SHAPE = /^\d(?:[ -]?\d){2,}$/;
  // Not the shape of a secret, whatever its characters: a path, a URL (which
  // the prompt screens as a URL), or a date or a month.
  const PLAIN_SHAPE =
    /^(?:\.{0,2}\/|[a-z][a-z0-9+.-]*:\/\/|(?:blob|data|mailto|tel):)|^\d{4}-\d{2}(?:-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?)?$/i;
  // Props that name an element rather than hold a value: the element's own
  // class and id, and a reference to another one (htmlFor, inputId,
  // describedBy, aria-*, data-*).
  const SHAPE_KEY = /^(?:class|className|id|htmlFor|for|key|ref|aria-[\s\S]*|aria[A-Z][\s\S]*|data-[\s\S]*|[\s\S]*(?:Id|ID|Ids|IDs|UUID|Uuid|_id|_ids|For|By))$/;

  /**
   * Whether a string prop has the shape of a secret: 8 to 256 characters
   * with no whitespace, a letter and a digit, or, where digits is true,
   * three digits or more. Asked only of a component that renders a control
   * taking a password, a code or a card's digits (by its type or its
   * autocomplete, not a name), where it finds a secret held by no field: a
   * confirm field handed the first password after the step that held it
   * unmounted, a card number handed to a review step. digits is whether
   * such a control takes digits. A title, an error message, a path, a URL, a
   * date, a currency or a short order id has another shape.
   */
  function secretShaped(key, value, digits) {
    if (typeof value !== 'string' || value.length > 256) return false;
    if (execRegExp(SHAPE_KEY, NativeString(key)) !== null) return false;
    if (execRegExp(PLAIN_SHAPE, value) !== null) return false;
    if (digits && execRegExp(DIGIT_SHAPE, value) !== null) return true;
    return value.length >= 8 && execRegExp(SECRET_SHAPE, value) !== null;
  }

  /**
   * Notes in guard whether a control holds a secret, and what it holds.
   *
   * The props of the component summarised for a pick say nothing about this
   * when the component sets the type itself. A PasswordInput({ value }) that
   * renders <input type="password" value={value}> has a value prop and no
   * type, and printed the password as typed (seen on React 18.3.1). So the
   * control is asked: the element, and the props of its own host fiber or
   * vnode.
   *
   * guard.field: a control that takes a password, a one-time code or a
   * card number, by its type or its autocomplete (a form control, any
   * element of a design system's whose type says password, <x-pw
   * type="password">, or an element whose open shadow root holds such a
   * control), or a form control whose name or id, or the name of one of its
   * attributes or props, is a secret name. guard.values: what they hold.
   *
   * A hidden input sets no guard.field: it is what a form carries along (a
   * product id, a CSRF token beside a search box), and the component's own
   * value prop is something else. Its value is held when it is the pick
   * itself, or when its name or id is a secret name (a csrf_token handed
   * in under formKey).
   *
   * element is the DOM node and props the host's own (either may be
   * missing); tag is what the fiber or vnode says the node is; picked
   * whether this is the node the user picked.
   */
  function noteControl(guard, element, props, tag, picked) {
    try {
      let kind = typeof tag === 'string' ? lowerCase(tag) : '';
      if (!kind && element && elementTag) {
        try {
          kind = lowerCase(NativeString(elementTag(element)));
        } catch {
          /* not an element */
        }
      }
      if (!kind) return;
      const own = props && typeof props === 'object' ? props : null;
      const attribute = (name) => attributeIn(element, name);
      const field = listed(FIELD_TAGS, kind);
      const ownType = own !== null ? own.type : undefined;
      const type = attribute('type');
      const names = [own && own.name, own && own.id, attribute('name'), attribute('id')];
      let named = false;
      for (let i = 0; i < names.length && !named; i += 1) {
        named = typeof names[i] === 'string' && names[i] !== '' && isSecretText(names[i]);
      }
      if (kind === 'input' && (hiddenKind(ownType) || hiddenKind(type))) {
        if (picked || named) {
          holdFieldValue(guard, element, kind);
          if (own !== null) holdValue(guard, own.value);
        }
        return;
      }
      let password =
        (own !== null && passwordKind(ownType, own.autoComplete || own.autocomplete)) ||
        passwordKind(type, attribute('autocomplete'));
      let shadowField = null;
      if (!password && !field && element && shadowOf && queryIn) {
        try {
          const root = shadowOf(element);
          shadowField = root ? queryIn(root, SECRET_CONTROLS) : null;
        } catch {
          /* no shadow root to ask */
        }
        password = shadowField !== null && shadowField !== undefined;
      }
      let secret = password;
      if (!secret && field) {
        secret = named;
        if (!secret && element && attributeNamesOf) {
          let attributes = null;
          try {
            attributes = attributeNamesOf(element);
          } catch {
            /* not an element */
          }
          for (let i = 0; attributes && i < attributes.length && i < ATTRIBUTE_LIMIT && !secret; i += 1) {
            secret = isSecretText(attributes[i]);
          }
        }
        if (!secret && own !== null) {
          let judged = 0;
          for (const key in own) {
            if (judged >= ATTRIBUTE_LIMIT || secret) break;
            judged += 1;
            secret = hasOwn(own, key) && isSecretText(key);
          }
        }
      }
      if (!secret) return;
      guard.field = true;
      // Its type or autocomplete, not only its name, says it takes a
      // password, a code or a card's digits (see secretShaped).
      if (password) {
        guard.password = true;
        if (
          (own !== null && digitKind(own.autoComplete || own.autocomplete)) ||
          digitKind(attribute('autocomplete')) ||
          (shadowField && digitKind(attributeIn(shadowField, 'autocomplete')))
        ) {
          guard.digits = true;
        }
      }
      if (field) holdFieldValue(guard, element, kind);
      if (shadowField) holdFieldValue(guard, shadowField, tagOf(shadowField));
      // A design system's element is not read through a getter of its own,
      // which would be the page's code: its props, its attribute and the
      // field in its open shadow root say it.
      if (own !== null) {
        holdValue(guard, own.value);
        holdValue(guard, own.defaultValue);
      }
      if (!field) holdControlValue(guard, element);
    } catch {
      /* ignore */
    }
  }

  /**
   * What the component summarised for a React pick must not print: whether
   * a secret control is at the pick or anywhere it renders, and the values
   * those controls hold. The pick itself, its host fiber, and the host
   * fibers under the component, bounded, then the document's own secret
   * controls (see documentValues).
   */
  function reactGuard(node, host, component) {
    const guard = { field: false, password: false, digits: false, values: [] };
    noteControl(guard, node, null, '', true);
    try {
      noteControl(guard, host.stateNode, host.memoizedProps, typeof host.type === 'string' ? host.type : '', true);
      const pending = [];
      if (component.child) pending[0] = component.child;
      for (let budget = SUBTREE_LIMIT; pending.length && budget > 0; budget -= 1) {
        const fiber = pending[pending.length - 1];
        pending.length -= 1;
        if (!fiber || typeof fiber !== 'object') continue;
        if (typeof fiber.type === 'string') {
          noteControl(guard, fiber.stateNode, fiber.memoizedProps, fiber.type, false);
        }
        if (fiber.sibling) pending[pending.length] = fiber.sibling;
        if (fiber.child) pending[pending.length] = fiber.child;
      }
    } catch {
      /* what was noted so far */
    }
    documentValues(guard);
    return guard;
  }

  /**
   * The same for a Vue pick: the element, then the vnodes the instance
   * rendered, into child components, and into a <Suspense>, which keeps
   * what it shows (and what it is still resolving) on the boundary rather
   * than among its children. A branch still resolving is in no document,
   * and is read here only.
   */
  function vueGuard(node, instance) {
    const guard = { field: false, password: false, digits: false, values: [] };
    try {
      const vnode = node.__vnode;
      noteControl(guard, node, vnode && vnode.props, '', true);
    } catch {
      noteControl(guard, node, null, '', true);
    }
    try {
      const pending = [];
      const more = (vnode) => {
        if (vnode && typeof vnode === 'object' && pending.length < SUBTREE_LIMIT) pending[pending.length] = vnode;
      };
      more(instance.subTree);
      for (let budget = SUBTREE_LIMIT; pending.length && budget > 0; budget -= 1) {
        const vnode = pending[pending.length - 1];
        pending.length -= 1;
        if (!vnode || typeof vnode !== 'object') continue;
        if (typeof vnode.type === 'string') noteControl(guard, vnode.el, vnode.props, vnode.type, false);
        const children = vnode.children;
        if (isArray(children)) {
          for (let i = 0; i < children.length && pending.length < SUBTREE_LIMIT; i += 1) {
            pending[pending.length] = children[i];
          }
        }
        const component = vnode.component;
        if (component && component.subTree) more(component.subTree);
        const suspense = vnode.suspense;
        const active = suspense && typeof suspense === 'object' ? suspense.activeBranch : null;
        const waiting = suspense && typeof suspense === 'object' ? suspense.pendingBranch : null;
        more(active);
        if (waiting !== active) more(waiting);
        // The default and fallback content, which are one of the two
        // branches once mounted, and the only record of them before.
        const content = vnode.ssContent;
        const fallback = vnode.ssFallback;
        if (content !== active && content !== waiting) more(content);
        if (fallback !== active && fallback !== waiting) more(fallback);
      }
    } catch {
      /* what was noted so far */
    }
    documentValues(guard);
    return guard;
  }

  function summariseProps(props, guard) {
    const out = [];
    try {
      if (!props || typeof props !== 'object') return out;
      // A component that renders a secret control, or says it is one,
      // withholds its value props. Any other string or number it holds is
      // withheld for what it holds (see holdsSecret), not for the component
      // it is in: every prop of a login or checkout form was withheld once,
      // its title, its error message and its total, and a strength meter
      // handed the password without rendering the field still printed it.
      // A component that renders a control taking a password, a code or a
      // card's digits also withholds a string shaped like one (see
      // secretShaped).
      const kind = fieldKind(props);
      const password = (guard && guard.password) || kind === 2;
      let digits = guard ? guard.digits : false;
      if (!digits && kind === 2) {
        try {
          digits = digitKind(props.autoComplete || props.autocomplete);
        } catch {
          /* a prop that throws */
        }
      }
      const field = (guard && guard.field) || kind !== 0;
      const held = guard ? guard.values : [];
      const cards = cardForms(held);
      for (const key of Object.keys(props)) {
        if (out.length >= PROP_LIMIT) break;
        // children is the subtree the user can already see, not a setting.
        if (key === 'children') continue;
        let value;
        try {
          // A prop can be a getter, and on a Vue reactive proxy reading one
          // runs framework code.
          value = props[key];
        } catch {
          continue;
        }
        // PRIVACY: this is the one place in the extension that reads live
        // application state rather than what is on the screen, and the value
        // goes into the prompt and into chrome.storage.local with it. The key
        // is still reported, because knowing the prop exists is most of its
        // debugging value and the value rarely is. An object or array prints
        // as {…} or Array(n), which shows nothing, so it is never withheld.
        // Nor is a prop holding what a secret control holds, under any name
        // (text, input, pw), which the name test cannot catch.
        const scalar = typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint';
        const secret =
          withheld(value) &&
          typeof value !== 'object' &&
          (isSecretText(key) ||
            (field && listed(VALUE_PROPS, key)) ||
            (scalar && holdsSecret(held, NativeString(value), cards)) ||
            (password && secretShaped(key, value, digits)));
        out.push(key + '=' + (secret ? REDACTED : summariseValue(value)));
      }
    } catch {
      /* ignore */
    }
    return out;
  }

  /**
   * Name a fiber by its type, never by its tag. React renumbered the tag table
   * inside 16.x (FunctionComponent was 1 and ClassComponent 2 before that), so
   * the same number means different things in two builds that both call
   * themselves React 16. The shapes below have been stable since.
   *
   * Returns null for anything with no useful name, including host elements,
   * symbols such as Fragment, context objects and an unresolved lazy.
   */
  /** A name only when it really is a non-empty string. */
  function text(value) {
    return typeof value === 'string' && value ? value : null;
  }

  function nameOf(type, depth) {
    try {
      const level = depth || 0;
      // memo(forwardRef(fn)) nests, and an object that referenced itself would
      // otherwise recurse forever.
      if (!type || level > 5) return null;
      if (typeof type === 'string') return null; // a host element: div, span
      // Guarded rather than returned raw: displayName is whatever the page
      // assigned, and a Symbol there would make the whole reply un-clonable,
      // so the picker would sit out its timeout for every pick on that page.
      if (typeof type === 'function') return text(type.displayName) || text(type.name);
      if (typeof type !== 'object') return null; // a symbol
      if (typeof type.render === 'function') {
        return (
          text(type.displayName) || text(type.render.displayName) || text(type.render.name)
        );
      }
      if (type.type) return text(type.displayName) || nameOf(type.type, level + 1);
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Find the nearest node React knows about, counting the steps taken.
   *
   * The climb is not decoration. A node produced by dangerouslySetInnerHTML, or
   * by a script the page runs itself, has no fiber of its own, and the user can
   * click one.
   *
   * React has an unreleased enableInternalInstanceMap flag that moves the fiber
   * off the node into a private WeakMap for production builds. When that ships
   * there will be nothing here to read, and returning null is the correct
   * degradation: no component reported, rather than a wrong one.
   */
  function fiberOf(node) {
    let element = node;
    let hops = 0;
    while (element && hops < CLIMB_LIMIT) {
      let keys;
      try {
        keys = Object.getOwnPropertyNames(element);
      } catch {
        keys = [];
      }
      for (const key of keys) {
        if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
          const fiber = element[key];
          if (fiber && typeof fiber.tag === 'number') return { fiber, hops };
        }
      }
      element = element.parentElement;
      hops += 1;
    }
    return null;
  }

  /**
   * Turn a path out of a stack frame or _debugSource into something worth
   * printing. Vite serves modules over http with a ?t=<timestamp> cache buster,
   * and Next.js reports webpack-internal URLs.
   */
  // Through the natives taken at the top, since a failed request's frames
  // go through here (see callerFrames).
  const urlPathname = NativeURL && nativeGetter(NativeURL.prototype, 'pathname');
  const WEBPACK_INTERNAL = 'webpack-internal:';

  function cleanPath(raw) {
    try {
      let path = NativeString(raw);
      if (path[0] === '(') path = sliceString(path, 1);
      const query = indexOfString(path, '?');
      if (query > 0) path = sliceString(path, 0, query);
      if (execRegExp(/^https?:\/\//, path) !== null) {
        try {
          return urlPathname ? urlPathname(new NativeURL(path)) : path;
        } catch {
          return path;
        }
      }
      if (sliceString(path, 0, WEBPACK_INTERNAL.length) === WEBPACK_INTERNAL) {
        let from = WEBPACK_INTERNAL.length;
        for (let slashes = 0; slashes < 3 && path[from] === '/'; slashes += 1) from += 1;
        const loader = execRegExp(/^\([^)]*\)\//, sliceString(path, from));
        if (loader !== null) from += loader[0].length;
        if (sliceString(path, from, from + 2) === './') from += 2;
        return sliceString(path, from) || path;
      }
      return path;
    } catch {
      return '';
    }
  }

  // Frames belonging to React's own element factories. The JSX written by the
  // developer is the first frame below them.
  const STACK_NOISE =
    /jsx-dev-runtime|jsx-runtime|jsxDEV|createElement|react\.development|react-stack-top-frame/;
  const STACK_BOTTOM = /react[-_]stack[-_]bottom[-_]frame/;
  const STACK_FRAME = /(\S+?):(\d+):(\d+)\)?$/;

  /**
   * Where this node's JSX is written, which is the file of whoever rendered it
   * and not the file the component itself is defined in.
   *
   * React 16 to 18 record it as _debugSource. React 19.0 records nothing at
   * all. React 19.1 and later keep _debugStack, an Error constructed inside
   * jsxDEV whose trace has the answer a few frames down.
   *
   * Returned with where it came from, since the two are not equally exact.
   * _debugSource is the position in the file as written, put there by the
   * JSX transform. A stack frame is a position in the code the browser ran,
   * which a bundler or a dev server's transform has already rewritten, and no
   * source map is applied to it here, so its line can be off by however much
   * that rewrite moved it.
   */
  function sourceOf(fiber) {
    try {
      const source = fiber._debugSource;
      if (source && source.fileName) {
        const path = cleanPath(source.fileName);
        if (!path) return null;
        if (!source.lineNumber) return { where: path, from: 'source' };
        const column = source.columnNumber ? ':' + source.columnNumber : '';
        return { where: path + ':' + source.lineNumber + column, from: 'source' };
      }

      const stack = fiber._debugStack;
      if (!stack) return null;
      let text;
      try {
        // A page is free to install Error.prepareStackTrace, so reading .stack
        // can run page code that throws or hands back something else entirely.
        text = typeof stack === 'string' ? stack : stack.stack;
      } catch {
        return null;
      }
      if (typeof text !== 'string') return null;

      // Line 0 is the "Error: react-stack-top-frame" header and line 1 is the
      // factory React built the Error inside, so neither can be the answer. The
      // denylist below is still needed for the frames after them, but skipping
      // these two outright means a factory frame that is anonymous, or minified
      // into a generically named chunk, cannot slip past it and be reported as
      // the developer's own file.
      const lines = text.split('\n').slice(2);
      for (const line of lines) {
        if (STACK_BOTTOM.test(line)) break;
        if (STACK_NOISE.test(line)) continue;
        const frame = line.match(STACK_FRAME);
        if (!frame) continue;
        const path = cleanPath(frame[1]);
        // Something that looks like a file. A frame can be "at <anonymous>:1:1"
        // or "at eval:3:9", and pointing a reader at that is worse than saying
        // nothing, because the rest of the line claims it is where to look.
        if (!path || !/[/.]/.test(path)) continue;
        return { where: path + ':' + frame[2] + ':' + frame[3], from: 'stack' };
      }
      return null;
    } catch {
      return null;
    }
  }

  const HOST_ROOT = 3; // the fiber tag of a root, whose stateNode knows the current tree
  const SIBLING_LIMIT = 2000; // children scanned under one parent

  /** Whether child is among parent's children. */
  function isChildOf(parent, child) {
    let next = parent.child;
    for (let i = 0; next && i < SIBLING_LIMIT; i += 1) {
      if (next === child) return true;
      next = next.sibling;
    }
    return false;
  }

  /**
   * Of a fiber and its alternate, the one on the tree that is on screen.
   *
   * __reactFiber$ on a DOM node, and every return pointer from it, can lead
   * to either copy of a fiber, and the two hold different props: the
   * committed ones, and those of the render before. On React 18.3.1 the
   * printed props alternated between stale and fresh on every render, so a
   * prop that had just changed, often the very bug being reported, was wrong
   * half the time (M5).
   *
   * This is React's own findCurrentFiberUsingSlowPath, which React DevTools
   * uses for the same question: climb both copies to the root in step, and
   * see which one the root's current tree leads to. Bounded, and on anything
   * it does not expect it answers with the fiber it was given, which is what
   * was reported before.
   */
  function currentFiber(fiber) {
    try {
      const alternate = fiber.alternate;
      if (!alternate) return fiber;
      let a = fiber;
      let b = alternate;
      for (let steps = 0; steps < CLIMB_LIMIT; steps += 1) {
        const parentA = a.return;
        if (!parentA) break;
        const parentB = parentA.alternate;
        if (!parentB) {
          // A hidden Suspense boundary puts a fragment with no alternate
          // between itself and its children. Both copies continue above it.
          const next = parentA.return;
          if (!next) break;
          a = b = next;
          continue;
        }
        if (parentA.child === parentB.child) {
          // Both copies of the parent share their children, which happens
          // when a render bailed out: the child set is the current one.
          if (isChildOf(parentA, a)) return a === fiber || a === alternate ? a : fiber;
          if (isChildOf(parentA, b)) return b === fiber || b === alternate ? b : fiber;
          return fiber;
        }
        if (a.return !== b.return) {
          a = parentA;
          b = parentB;
        } else if (isChildOf(parentA, a)) {
          a = parentA;
          b = parentB;
        } else if (isChildOf(parentA, b)) {
          b = parentA;
          a = parentB;
        } else if (isChildOf(parentB, a)) {
          a = parentB;
          b = parentA;
        } else if (isChildOf(parentB, b)) {
          b = parentB;
          a = parentA;
        } else {
          return fiber;
        }
        if (a.alternate !== b) return fiber;
      }
      if (a.tag !== HOST_ROOT || !a.stateNode) return fiber;
      return a.stateNode.current === a ? fiber : alternate;
    } catch {
      return fiber;
    }
  }

  /**
   * Add a name to the chain, folding away the repeats React's own wrappers make.
   *
   * Two of them, and neither is cosmetic: only five names are kept, so a repeat
   * costs a real ancestor further up.
   *
   *   memo(Thing) and forwardRef(Thing) each add a fiber of their own carrying
   *   the same name, so the chain reads "Thing > Thing".
   *
   *   A context Provider is named after its context, so a library that calls
   *   both the context and the component TooltipProvider renders as
   *   "TooltipProviderProvider > TooltipProvider". The component is the one
   *   worth keeping, since it is the one written in the source.
   *
   * Returns true when the name replaced the last one, so that the caller can
   * move whatever it kept for that name to the fiber now named.
   */
  function pushName(names, name) {
    const last = names[names.length - 1];
    if (last === name) return false;
    if (last === name + 'Provider' || last === name + 'Context') {
      names[names.length - 1] = name;
      return true;
    }
    names[names.length] = name;
    return false;
  }

  /**
   * The React component behind a node. With `brief` (see componentOf), the
   * summary ends once the names are known: the walk that builds them is the
   * same either way, so names[0] and `renamed` are what a pick reports.
   */
  function reactSummary(node, brief) {
    const found = fiberOf(node);
    if (!found) return null;
    const host = found.fiber;

    // Computed before the walk, because in a production build most of what the
    // walk finds is the bundler's naming rather than the author's.
    const development = '_debugOwner' in host;

    const names = [];
    let owning = null; // the nearest named fiber, whose props are reported
    let nearest = null; // what that fiber is called, even if a bundler named it
    let minified = 0; // named components the walk passed over as bundler output
    let fiber = host;
    let steps = 0;
    while (fiber && names.length < NAME_LIMIT && steps < CLIMB_LIMIT) {
      steps += 1;
      const name = nameOf(fiber.type);
      if (name) {
        const bundlerName = !development && name.length <= 2;
        if (!owning) {
          // The picked component's own name is kept whatever it is. Even a
          // bundler's `A` is worth printing, because it is the string React
          // DevTools shows for the same component and the reader may be
          // looking at both.
          owning = fiber;
          nearest = bundlerName ? name : null;
          pushName(names, name);
        } else if (bundlerName) {
          // An ancestor's bundler name is worse than no name: it cannot be
          // searched for in the source, and it spends one of the five slots a
          // real name further up could have used. Only ever applied to a
          // production build, where a name the minifier kept is three
          // characters or more anyway (App and Nav are real; A and tN are not).
          minified += 1;
        } else if (pushName(names, name) && names.length === 1) {
          // The nearest name was a Provider's, folded just now into the
          // component that renders it. The props printed under that name are
          // then the component's. They were the Provider's own, its value and
          // children, printed as the props of the component (PI21).
          owning = fiber;
          nearest = null;
        }
      }
      fiber = fiber.return;
    }
    if (!names.length) return null;

    const summary = {
      framework: 'react',
      // The DEV FiberNode constructor defines every _debug* field on every
      // fiber and production defines none, so the presence of the key is the
      // test even when the value is null. __REACT_DEVTOOLS_GLOBAL_HOOK__ is
      // not: it is there whenever the extension is installed and says nothing
      // about which build the page shipped.
      build: development ? 'development' : 'production',
      names,
      hops: found.hops,
    };

    if (minified) summary.minified = minified;
    // Says that names[0] is the bundler's invention rather than a name that
    // appears anywhere in the source, which changes what the reader should do
    // with it: correlate it with React DevTools, do not grep for it.
    if (nearest) summary.renamed = true;
    // No owner, call site or props: the owner and the call site are read
    // from what React keeps for its own DevTools, the props are guarded by a
    // look through the document (reactGuard), and none of it is shown on
    // hover.
    if (brief) return summary;

    try {
      // Read from the HOST fiber, and do not go looking for the owner in the
      // return chain. An element held in context, in a ref or in module scope
      // is rendered somewhere its author never appears as a parent, and after a
      // re-render the chain can reach owner.alternate instead of owner itself.
      const owner = host._debugOwner;
      if (owner) {
        // React 19 records a server component's owner as a ReactComponentInfo,
        // which carries a name and no tag.
        const name = typeof owner.tag === 'number' ? nameOf(owner.type) : owner.name;
        // Sent when it is names[0] as well. That is the commonest case, the
        // element written in the JSX of the component that renders it, and
        // the template says so. Leaving it out made the template say the
        // component was defined elsewhere, beside a line inside its own
        // definition (PI2).
        if (name && typeof name === 'string') summary.owner = name;
      }
    } catch {
      /* ignore */
    }

    const source = sourceOf(host);
    if (source) {
      summary.source = source.where;
      // Read from a stack frame, unmapped (see sourceOf). The template says
      // so, rather than printing it with the confidence of _debugSource (PI9).
      if (source.from === 'stack') summary.sourceFrom = 'stack';
    }

    // From the copy of the fiber on screen (see currentFiber). Its names and
    // source are the same on both copies; its props are not. What it renders
    // is asked too, since the props alone cannot say a value is a password.
    const shown = currentFiber(owning);
    const props = summariseProps(shown.memoizedProps, reactGuard(node, host, shown));
    if (props.length) summary.props = props;

    return summary;
  }

  // --------------------------------------------------------------- handlers --
  // React keeps a host element's own props, onClick included, on the DOM node
  // itself as a __reactProps$<random> expando, in a production build as well
  // as a development one, because event dispatch reads them back from there.
  //
  // That makes a handler name the most precise thing this whole file can
  // offer. Everything else it reports is a component name or a file the reader
  // then has to search; a handler name is the identifier they are looking for.

  const HANDLER_LIMIT = 6; // handler props reported
  const STARTS_MAX = 120; // characters kept from a handler body
  const LABEL_CLASSES = 2; // classes kept in an ancestor's label
  const HANDLER_PROP = /^on[A-Z]/;
  // Whose body is worth printing, most specific first. A node often carries
  // several, and onMouseEnter is rarely the one the user clicked for.
  const STARTS_PREFERENCE = ['onClick', 'onChange', 'onSubmit'];

  /** tag plus a class or two, enough to recognise which ancestor this was. */
  function elementLabel(element) {
    try {
      const tag = element.tagName ? element.tagName.toLowerCase() : '';
      const classes = [];
      const names = element.classList;
      for (let i = 0; names && i < names.length && classes.length < LABEL_CLASSES; i += 1) {
        const name = names[i];
        if (typeof name === 'string' && name) classes.push(name.slice(0, 40));
      }
      return classes.length ? tag + '.' + classes.join('.') : tag;
    } catch {
      return '';
    }
  }

  /**
   * The first statements of a handler, as something to search the source for.
   *
   * Whether the text is worth printing is decided further down by the text
   * itself rather than by the build label, because a minified body is
   * worthless as a search target however the build describes itself.
   */
  // Words that survive minification, so finding one says nothing about
  // whether the author's own names did: keywords, and what a minifier cannot
  // rename because it is a global.
  const MINIFIER_KEEPS = new NativeSet([
    'arguments', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
    'default', 'delete', 'else', 'extends', 'false', 'finally', 'function', 'import', 'instanceof',
    'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'typeof', 'undefined', 'void',
    'while', 'with', 'yield', 'window', 'document', 'console', 'Object', 'Array', 'Promise',
    'Math', 'JSON', 'Number', 'String', 'Boolean', 'Symbol', 'Error', 'Date', 'setTimeout',
    'clearTimeout', 'requestAnimationFrame', 'self', 'globalThis',
  ]);
  const setHas = uncurry(NativeSet.prototype.has);

  /**
   * Source with its comments taken out, each replaced by a space, and its
   * string literals left as they are. A regular expression cannot tell a
   * comment from "//" inside a string, and fetch('https://api.test/x') was
   * cut to fetch('https: by one.
   */
  function withoutComments(source) {
    let out = '';
    let from = 0;
    let quote = '';
    for (let i = 0; i < source.length; i += 1) {
      const char = source[i];
      if (quote) {
        if (char === '\\') i += 1;
        else if (char === quote) quote = '';
        continue;
      }
      if (char === '"' || char === "'" || char === '`') {
        quote = char;
        continue;
      }
      if (char !== '/') continue;
      const next = source[i + 1];
      if (next !== '/' && next !== '*') continue;
      out += sliceString(source, from, i) + ' ';
      const end = indexOfString(source, next === '/' ? '\n' : '*/', i + 2);
      if (end < 0) return out;
      i = next === '/' ? end - 1 : end + 1;
      from = i + 1;
    }
    return out + sliceString(source, from);
  }

  // What a member chain can start from without a minifier having renamed
  // it: the object a method runs on, and the window. A property read
  // straight off one of these is the author's own name in any build, a
  // method of the component or a global of the page's, so this.toggle() and
  // window.location.reload() read as written, where e.preventDefault() and
  // r.current.focus() say nothing a minifier left. Math, Object and the rest
  // of MINIFIER_KEEPS are not here: Object.assign(t, n) is minified code.
  const MEMBER_ROOTS = new NativeSet(['this', 'super', 'window', 'document', 'globalThis', 'self']);

  /**
   * Whether the identifier at source[at] is read straight off a MEMBER_ROOTS
   * name, as in this.toggle or window?.bump, rather than off anything else.
   */
  function offMemberRoot(source, at) {
    let end = at - 1; // the dot
    if (end > 0 && source[end - 1] === '?') end -= 1;
    let start = end;
    while (start > 0 && execRegExp(WORD_PART, source[start - 1]) !== null) start -= 1;
    // The root of the chain, not a link in one: a.window.open is not window.
    return (
      start < end &&
      (start === 0 || source[start - 1] !== '.') &&
      setHas(MEMBER_ROOTS, sliceString(source, start, end))
    );
  }

  /** Whether the identifier at source[at] is an author's name (see hasAuthorNames). */
  function authorNameAt(source, at) {
    if (execRegExp(WORD_START, source[at] || '') === null) return false;
    let end = at + 1;
    while (end < source.length && execRegExp(WORD_PART, source[end]) !== null) end += 1;
    return end - at >= 4 && !setHas(MINIFIER_KEEPS, sliceString(source, at, end));
  }

  /**
   * Whether source[next] opens a call whose first argument is a minified
   * one: anything but a string (t('cart.saved'), an i18n lookup) or an
   * author's name (t(errorKey), x(item)).
   */
  function minifiedCall(source, next) {
    if (source[next] !== '(') return false;
    let first = next + 1;
    while (source[first] === ' ') first += 1;
    return source[first] !== '"' && source[first] !== "'" && source[first] !== '`' && !authorNameAt(source, first);
  }

  /**
   * Whether this text has a shape only a minifier writes, whatever names it
   * also holds: a call of a one letter name on a minified argument (n(!0),
   * t(e.value)), true and false written !0 and !1, undefined written void 0,
   * or statements joined by a comma with nothing after it
   * (e.preventDefault(),o(!1)). A minified body that calls a method off
   * window or document has a readable name in it, and passed as readable
   * for that alone. $ and _, which jQuery and lodash are called by, are
   * not one letter names here. A comma a space follows is a person's, as
   * in let next = count + 1, max = 10 or handleSave(), closeDialog(): a
   * minifier writes none, and the text keeps one space where it had any.
   */
  const ONE_LETTER = /^[A-Za-z]$/;
  function minifiedShape(source) {
    let quote = '';
    let depth = 0;
    for (let i = 0; i < source.length; i += 1) {
      const char = source[i];
      if (quote) {
        if (char === '\\') i += 1;
        else if (char === quote) quote = '';
        continue;
      }
      if (char === '"' || char === "'" || char === '`') {
        quote = char;
      } else if (char === '(' || char === '[' || char === '{') {
        depth += 1;
      } else if (char === ')' || char === ']' || char === '}') {
        depth -= 1;
      } else if (char === ',' && depth <= 0 && i + 1 < source.length && source[i + 1] !== ' ') {
        return true;
      } else if (
        char === '!' &&
        (source[i + 1] === '0' || source[i + 1] === '1') &&
        (i + 2 >= source.length || (source[i + 2] !== '.' && execRegExp(WORD_PART, source[i + 2]) === null))
      ) {
        return true;
      } else if (execRegExp(WORD_PART, char) !== null) {
        let end = i + 1;
        while (end < source.length && execRegExp(WORD_PART, source[end]) !== null) end += 1;
        let next = end;
        while (source[next] === ' ') next += 1;
        if (sliceString(source, i, end) === 'void' && source[next] === '0') return true;
        if (end - i === 1 && execRegExp(ONE_LETTER, char) !== null && source[i - 1] !== '.' && minifiedCall(source, next)) {
          return true;
        }
        i = end - 1;
      }
    }
    return false;
  }

  /**
   * Whether the author's own names survived in this text: an identifier of
   * four characters or more, outside a string, not one a minifier keeps,
   * and not after a dot, in a text with no shape only a minifier writes (see
   * minifiedShape). Minified code still says preventDefault, value and
   * return, as properties and keywords, so a run of four letters anywhere
   * passed a minified body as readable.
   *
   * One read straight off this or the window (see MEMBER_ROOTS) counts only
   * where nothing in the text is a name only a minifier gives: one or two
   * letters with a capital (Bt, Qe), or one or two letters called on a
   * minified argument. window.location.href=Bt(e.id) and
   * self.postMessage(Gt) are minified; window.location.reload() and
   * (e) => window.open(e.target.href) are not.
   */
  const WORD_START = /[A-Za-z_$]/;
  const WORD_PART = /[\w$]/;
  const MANGLED_START = /^[A-Za-z]/;
  const CAPITAL = /[A-Z]/;
  function hasAuthorNames(source) {
    if (minifiedShape(source)) return false;
    let offRoot = false;
    let mangled = false;
    let quote = '';
    for (let i = 0; i < source.length; i += 1) {
      const char = source[i];
      if (quote) {
        if (char === '\\') i += 1;
        else if (char === quote) quote = '';
        continue;
      }
      if (char === '"' || char === "'" || char === '`') {
        quote = char;
        continue;
      }
      if (execRegExp(WORD_PART, char) === null) continue;
      let end = i + 1;
      while (end < source.length && execRegExp(WORD_PART, source[end]) !== null) end += 1;
      if (source[i - 1] !== '.') {
        if (authorNameAt(source, i)) return true;
        if (end - i <= 2 && execRegExp(MANGLED_START, char) !== null) {
          let next = end;
          while (source[next] === ' ') next += 1;
          const word = sliceString(source, i, end);
          if (execRegExp(CAPITAL, word) !== null || minifiedCall(source, next)) mangled = true;
        }
      } else if (!offRoot && authorNameAt(source, i) && offMemberRoot(source, i)) {
        offRoot = true;
      }
      i = end - 1;
    }
    return offRoot && !mangled;
  }

  function handlerStarts(fn) {
    try {
      // The page is free to replace Function.prototype.toString.
      const source = String(fn);

      // The body starts at the first '{' or '=>' outside the parameter list,
      // which is not the same as the first one in the string: a default
      // parameter can hold braces of its own, as in (event = {}) => ….
      let depth = 0;
      let cut = -1;
      let arrow = false;
      for (let i = 0; i < source.length; i += 1) {
        const char = source[i];
        if (char === '(') depth += 1;
        else if (char === ')') depth -= 1;
        else if (depth === 0) {
          if (char === '=' && source[i + 1] === '>') {
            cut = i + 2;
            arrow = true;
            break;
          }
          if (char === '{') {
            cut = i + 1;
            break;
          }
        }
      }
      if (cut < 0) return '';

      let body = source.slice(cut).trimStart();
      // A block bodied arrow opens with its brace here. A concise one,
      // `event => send(event)`, has none and is already the body.
      if (arrow && body.startsWith('{')) body = body.slice(1);

      // Comments are stripped wherever they fall, before whitespace is
      // collapsed: a line comment ends at its newline, and collapsing first
      // would take the rest of the handler into the comment with it. On the
      // React fixture two lines of prose about why a promise is not awaited
      // spent most of the budget. The function's own closing brace is not
      // one of its statements.
      const text = withoutComments(body)
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\s*\}$/, '')
        .trim();
      // A bound method stringifies to "function () { [native code] }", and
      // there is nothing behind it to read.
      if (!text || text.includes('[native code]')) return '';
      // PRIVACY: a handler body can hold a hardcoded key, token or account
      // number, and this text goes into the prompt and into storage with it.
      // Same rule as the props above, except that here there is no key whose
      // value can be replaced: a secret in a statement has no boundary this
      // code could find, so the whole text is dropped rather than masked in
      // part. A needlessly dropped hint costs one line of the prompt.
      // Whether the source is worth printing is a question about the text,
      // not about the build label, and the text can answer it. Minified code
      // has nothing but one and two character identifiers, so a run of four
      // or more letters means the author's own names survived. This replaces
      // gating on a development build, which was both too strict (Vue's
      // development bundle sets no build flag the collector can read, so a
      // perfectly readable handler was dropped) and too loose (a production
      // build with keepNames has real names over a minified body).
      if (!hasAuthorNames(text)) return '';
      // Both privacy tests go through the natives taken at the top, as the
      // props' do, so a page that has replaced a method cannot pass a secret.
      if (isSecretText(text)) return '';
      // The keyword test above only catches a secret that happens to sit next
      // to a telling word. A bearer token pasted into a headers object has no
      // such word near it, so this second test is on the shape of the value:
      // any quoted run of 20 or more characters with nothing but token
      // characters in it. Anything that long is either a credential or a
      // string too unwieldy to be a useful grep target, so dropping it costs
      // the reader nothing in either case.
      if (execRegExp(/(['"`])[A-Za-z0-9_\-.]{20,}\1/, text) !== null) return '';
      return text.length > STARTS_MAX ? text.slice(0, STARTS_MAX) + '…' : text;
    } catch {
      return '';
    }
  }

  /**
   * One handler as "onClick=ƒ handleApply", matching the props format above.
   *
   * A name equal to the prop name is dropped rather than repeated. JSX
   * compiles to an object literal, so `onChange={(event) => …}` reaches this
   * file as a function JavaScript's own name inference has already called
   * onChange. Nobody wrote that name and nobody can search for it, so
   * "onChange=ƒ" is the honest report: this handler is written inline.
   */
  function handlerLabel(entry) {
    try {
      if (entry.fn.name === entry.key) return entry.key + '=ƒ';
    } catch {
      /* ignore */
    }
    return entry.key + '=' + summariseValue(entry.fn);
  }

  /** The on* props of one React props object that are actually functions. */
  function handlerProps(props) {
    const found = [];
    try {
      for (const key of Object.keys(props)) {
        if (found.length >= HANDLER_LIMIT) break;
        if (!HANDLER_PROP.test(key)) continue;
        let value;
        try {
          value = props[key];
        } catch {
          continue;
        }
        // Only a function counts. A prop left at undefined, which is what
        // onClick={enabled ? submit : undefined} leaves behind, would
        // otherwise end the climb at a node with nothing to report and hide
        // the real handler on an ancestor.
        if (typeof value !== 'function') continue;
        found.push({ key, fn: value });
      }
    } catch {
      /* ignore */
    }
    return found;
  }

  /**
   * The nearest handlers at or above the picked node.
   *
   * The climb is here for the same reason fiberOf()'s is, only more so: a
   * click lands on the <span> inside the <button>, and the handler is on the
   * button. Reporting how far up it was found is what lets the reader tell
   * "this element" from "something wrapping it".
   */
  function handlersOf(node) {
    try {
      let element = node;
      let hops = 0;
      while (element && hops < CLIMB_LIMIT) {
        let keys;
        try {
          keys = Object.getOwnPropertyNames(element);
        } catch {
          keys = [];
        }

        let found = [];
        for (const key of keys) {
          // React 16 calls the same object __reactEventHandlers$, which is the
          // version pairing fiberOf() reads __reactInternalInstance$ for.
          if (!key.startsWith('__reactProps$') && !key.startsWith('__reactEventHandlers$')) {
            continue;
          }
          let props;
          try {
            props = element[key];
          } catch {
            continue;
          }
          if (props && typeof props === 'object') found = handlerProps(props);
          if (found.length) break;
        }

        // Vue puts the element's own props on its vnode under the same on*
        // names React uses, so the same reader works once it is pointed at
        // __vnode. It is defined with the same guard as __vueParentComponent,
        // so a plain production build has neither and this yields nothing.
        if (!found.length) {
          try {
            const vnode = element.__vnode;
            if (vnode && vnode.props && typeof vnode.props === 'object') {
              found = handlerProps(vnode.props);
            }
          } catch {
            /* ignore */
          }
        }

        if (found.length) {
          const handlers = {
            hops,
            label: hops ? elementLabel(element) : '',
            list: found.map(handlerLabel),
            starts: '',
            startsOf: '',
          };
          {
            let primary = null;
            for (const name of STARTS_PREFERENCE) {
              primary = found.find((entry) => entry.key === name);
              if (primary) break;
            }
            if (!primary) primary = found[0];
            const starts = handlerStarts(primary.fn);
            if (starts) {
              handlers.starts = starts;
              handlers.startsOf = primary.key;
            }
          }
          return handlers;
        }

        element = element.parentElement;
        hops += 1;
      }
      return null;
    } catch {
      return null;
    }
  }

  function vueName(type) {
    try {
      if (!type) return null;
      if (typeof type.name === 'string' && type.name) return type.name;
      // Single file components compiled by the Vue plugin carry __name, which
      // survives a production build where the options name does not exist.
      if (typeof type.__name === 'string' && type.__name) return type.__name;
      if (typeof type.__file !== 'string' || !type.__file) return null;
      const base = type.__file.split(/[\\/]/).pop() || '';
      const dot = base.lastIndexOf('.');
      return (dot > 0 ? base.slice(0, dot) : base) || null;
    } catch {
      return null;
    }
  }

  /**
   * Vue 3.
   *
   * __vueParentComponent is installed with Object.defineProperty and is not
   * enumerable, so the key scan the React side does would never see it. Vue
   * also only sets it under __DEV__ or __FEATURE_PROD_DEVTOOLS__, so a plain
   * production build offers nothing and null is the honest answer.
   *
   * With `brief` (see componentOf), the summary ends once the names are
   * known, as reactSummary's does.
   */
  function vueSummary(node, brief) {
    let element = node;
    let hops = 0;
    let instance = null;
    while (element && hops < CLIMB_LIMIT) {
      // __vnode.ctx before __vueParentComponent, and the difference only shows
      // up in slot content. For `<Card><b>hi</b></Card>`, the <b> is passed to
      // Card but written in the template of whoever used Card, and
      // __vueParentComponent names Card. Reporting Card would send a reader to
      // the wrong file, which is the one thing this feature exists to avoid.
      // ctx is the instance that was rendering when the vnode was created,
      // which is the file the element is actually in.
      let candidate = null;
      try {
        const ctx = element.__vnode && element.__vnode.ctx;
        if (ctx && ctx.type) candidate = ctx;
      } catch {
        /* ignore */
      }
      if (!candidate && element.__vueParentComponent && element.__vueParentComponent.type) {
        candidate = element.__vueParentComponent;
      }
      if (candidate) {
        instance = candidate;
        break;
      }
      element = element.parentElement;
      hops += 1;
    }
    if (!instance) return null;

    const names = [];
    let named = null; // the instance that gave names[0]
    let current = instance;
    let steps = 0;
    while (current && names.length < NAME_LIMIT && steps < CLIMB_LIMIT) {
      steps += 1;
      const name = vueName(current.type);
      if (name) {
        if (!named) named = current;
        names.push(name);
      }
      current = current.parent;
    }
    if (!named) return null;

    const summary = {
      framework: 'vue',
      names,
      hops,
    };
    // No build, file, props (vueGuard looks through the document) or
    // version.
    if (brief) return summary;

    // Vue cannot be asked which build it is, only which build it is not.
    //
    // __vueParentComponent is set under __DEV__ *or* __FEATURE_PROD_DEVTOOLS__,
    // so reaching this line already rules out a plain production build. It does
    // not tell development and production-with-devtools apart. __hmrId narrows
    // it one way: the SFC compiler stamps it, so its presence is a bundler's
    // development build for certain, while its absence proves nothing (Vue's
    // own vue.global.js development bundle has no HMR ids either, and reporting
    // that page as production was simply wrong).
    //
    // So the field is claimed only when it is known, and the prompt says
    // nothing about the build when it is not. Unlike React, Vue's names survive
    // minification anyway: they are author-written strings in the component
    // options, not function identifiers.
    try {
      if ('__hmrId' in named.type) summary.build = 'development';
    } catch {
      /* ignore */
    }

    try {
      if (typeof named.type.__file === 'string' && named.type.__file) {
        summary.source = named.type.__file;
      }
    } catch {
      /* ignore */
    }

    const props = summariseProps(named.props, vueGuard(node, named));
    if (props.length) summary.props = props;

    try {
      const version = named.appContext && named.appContext.app && named.appContext.app.version;
      if (typeof version === 'string' && version) summary.version = version;
    } catch {
      /* ignore */
    }

    return summary;
  }

  const SHADOW_SCAN = 20000; // elements walked looking for open shadow roots on a pick

  /**
   * The element the picker marked. It can sit inside open shadow roots, since
   * the picker descends into them, and document.querySelector does not look
   * there. So when it finds nothing each open shadow root is asked in turn,
   * found by a walk bounded to SHADOW_SCAN elements: a pick on a huge page
   * costs a bounded time, and a mark past the bound is simply not found, as
   * every shadow pick was before.
   */
  function findMarked(selector) {
    const direct = document.querySelector(selector);
    if (direct) return direct;
    let budget = SHADOW_SCAN;
    const pending = [document.documentElement];
    while (pending.length && budget > 0) {
      const node = pending.pop();
      budget -= 1;
      if (!node) continue;
      const shadow = node.shadowRoot;
      if (shadow) {
        const found = shadow.querySelector(selector);
        if (found) return found;
        for (const child of shadow.children || []) pending.push(child);
      }
      for (const child of node.children || []) pending.push(child);
    }
    return null;
  }

  /**
   * The component behind a node, nearest first, or null: the one place the
   * framework readers are listed. inspect() asks it at a pick, and
   * answerName() at each element the picker highlights while Element is
   * armed (see the end of this file). A reader for another framework goes
   * in here, in the order it is to be tried, and answers null for a node it
   * does not know.
   *
   * With `brief`, every reader keeps to what the hover can afford, asked as
   * often as once a frame for as long as the pointer moves:
   *
   *   It reads names only: `framework`, `names` and, where it applies,
   *   `renamed`. No props, so no guard (reactGuard, vueGuard) and none of
   *   its look through the document and its shadow roots for secret
   *   fields: a pick's round trip, guard included, took 1.24 ms at 20,000
   *   elements and 8.5 ms at 100,000 (Chrome 157), and a name about 4
   *   microseconds.
   *   It does no work across the whole document: no querySelectorAll or
   *   getElementsByTagName of it, and no walk of its shadow roots.
   *   It calls no function of the page's or of its framework's. A read can
   *   still run a getter the page planted, as it can at a pick.
   *   It looks at a fixed number of nodes, however large the page is:
   *   CLIMB_LIMIT elements up from the node, CLIMB_LIMIT steps up the
   *   framework's own tree, and at most SUBTREE_LIMIT nodes of a walk down
   *   the component's own render tree, as Vue 2's reader walks its vnodes
   *   to learn which component wrote an element.
   *   Its names[0] and `renamed` are the ones it gives without `brief`, so
   *   the tag shows the name the item's Component line will start with.
   *
   * A reader that cannot keep to this answers null when `brief` is set, and
   * so is simply not asked while hovering.
   */
  function componentOf(node, brief) {
    return reactSummary(node, brief) || vueSummary(node, brief);
  }

  function inspect(marker) {
    try {
      if (typeof marker !== 'string' || !marker) return null;

      // The picker generates a [a-z0-9] marker, so this is normally a no-op.
      // It is done anyway because the value arrives over postMessage and any
      // script on the page can send one.
      let value = null;
      if (/^[\w-]+$/.test(marker)) {
        value = marker;
      } else if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
        value = CSS.escape(marker);
      }
      if (value === null) return null;

      const node = findMarked('[data-cdr-pick="' + value + '"]');
      if (!node) return null;

      // Removed before any other work. Anything below can throw, and an
      // exception must not leave the extension's attribute on the user's page.
      node.removeAttribute('data-cdr-pick');

      const component = componentOf(node, false);
      // Which build this is was decided from the fiber by reactSummary(), so
      // the fiber is not looked up a second time to ask again. No component
      // means no handler bodies are read, which is the same outcome as a
      // production build and the same reason: nothing worth grepping for.
      const handlers = handlersOf(node);

      // Two answers to one pick, so both travel under one object. Either can
      // be null.
      //
      // The shape change is safe in one direction only, which is the direction
      // that matters here. The picker rebuilds every reply from scratch and
      // keeps only fields it knows about, so an OLD picker handed this NEW
      // object finds no `names` on it and rejects the whole thing: the pick
      // still produces a capture, with no component reported. The other
      // direction, a NEW picker on a tab still running an OLD collector after
      // an extension reload, is the picker's to handle, since nothing in this
      // file is running there.
      return { component, handlers };
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------- bridge ---
  /**
   * A ring's entries as a new array, without Array.prototype.slice, and
   * without an assignment to an index the copy does not have yet (see
   * append): this runs while the bridge's request is being answered.
   */
  function copyRing(ring) {
    const list = buffers[ring];
    const copy = [];
    for (let i = 0; i < list.length; i += 1) append(copy, list[i]);
    return copy;
  }

  function snapshot() {
    return {
      console: copyRing('console'),
      warnings: copyRing('warnings'),
      errors: copyRing('errors'),
      network: copyRing('network'),
      dropped: {
        console: dropped.console,
        warnings: dropped.warnings,
        errors: dropped.errors,
        network: dropped.network,
      },
      armedAt: startedAt,
      // From startedAt on only; see startedLate.
      late: startedLate,
    };
  }

  function clearRings() {
    // A cleared log has dropped nothing the user has not chosen to drop.
    const rings = ['console', 'warnings', 'errors', 'network'];
    for (let i = 0; i < rings.length; i += 1) {
      buffers[rings[i]].length = 0;
      dropped[rings[i]] = 0;
    }
  }

  /**
   * What the panel's console and network chips show: two numbers, no entry.
   * Each ring counted as the bridge hands it on, LIMIT at most: one a push
   * left long (see push) is cut back only at the next push, and was counted
   * whole, 90 where the log held 30.
   */
  function counts() {
    const length = (ring) => (buffers[ring].length < LIMIT ? buffers[ring].length : LIMIT);
    return {
      console: length('console') + length('warnings') + length('errors'),
      network: length('network'),
    };
  }

  // The bridge reads the log over a channel of its own rather than over
  // window.postMessage. A message posted to the window reaches every message
  // listener on the page, a third party's included, so each time the panel
  // read the log, every one of them was handed the page's console text,
  // failed request URLs and stacks, and could also answer in the
  // collector's place.
  //
  // The channel is a pair of event types, named by the bridge with a random
  // part and handed over in one HELLO event, and dispatched on the window.
  // Only a listener for that exact type receives one, and no listener for a
  // name nobody has seen can exist. HELLO itself is visible to a page
  // listener for it, but the declared content scripts exchange it at
  // document_start, before the page has run a line. Dispatch is synchronous
  // and crosses the two worlds, so a request is answered before the bridge's
  // dispatchEvent returns, and the detail reaches the bridge as a copy.
  //
  // Either half may arrive first, both at document_start and when the
  // extension injects them into a page already open: whichever comes second
  // speaks, and the other answers. The bridge answers this half's HELLO only
  // until its channel has carried one answered request, and it asks once
  // (a 'ping') as it speaks, so at document_start the pair is made before
  // the page runs, and a page script that says HELLO later is told nothing.
  // A bridge from 0.5.0 or earlier never says HELLO and reads over
  // window.postMessage, which this build no longer answers for the log; it
  // can only be running in a tab the extension reload has already cut it
  // off from.
  //
  // While the side panel is open on this tab, it holds a port to the bridge,
  // and the bridge asks over its channel to 'watch' the counts: from then on
  // a ring that grows says so once, with a '<channel>:changed' event that
  // carries nothing, and says it again only after the bridge has asked for
  // the 'counts', which it does at most four times a second, and at every
  // read of the panel's, when it asks to 'watch' again. The bridge asks
  // to 'unwatch' when the last port closes. The event is sent from push(),
  // never while a request is being answered, so no page script can run with
  // a request on window.event because of it: only a listener for that exact
  // type hears it, and the type is the channel's name.
  const HELLO = '__cdr_hello';
  const CHANNEL = /^__cdr_[0-9a-f]{32}$/;
  // The channels listened on, oldest first: { name, listener, watched,
  // signalled }, the last two for the counts above.
  const channels = [];
  const CHANNEL_LIMIT = 8;
  // Whether countsChanged is sending its events now.
  let telling = false;
  // Calls deep the stack has to go still, for an event to reach the bridge's
  // listener and for that to run (see countsChanged).
  const HEADROOM = 1600;

  function descend(depth) {
    return depth <= 0 || descend(depth - 1);
  }

  /** Whether the stack has HEADROOM calls left in it. */
  function roomToTell() {
    try {
      return descend(HEADROOM);
    } catch {
      return false;
    }
  }

  /**
   * Says on each channel a panel watches, and that has not said it since its
   * bridge last asked for the counts, that a ring has grown. A page that
   * logs on its way back from a stack overflow has this run with all but no
   * stack left. Then the dispatch threw, or Chrome could not call the
   * bridge's listener and reported that in the tab as an uncaught error of
   * the extension's; and since each channel was marked told before its
   * event went out, it was never told again, and the chips stood still. So
   * nothing is sent without room on the stack, and a channel is marked told
   * only once its event has gone out: one not told is told with the next
   * entry, which a page unwinding its stack makes with more room, into a
   * ring already full too (owed). Nothing is told while an event is going
   * out, so a listener that logs again (a page watching a channel of its
   * own) is not told twice, and cannot recurse. A bridge whose listener
   * failed even so asks again at its next read.
   */
  function countsChanged() {
    if (telling) return;
    telling = true;
    try {
      let room = null;
      for (let i = 0; i < channels.length; i += 1) {
        const entry = channels[i];
        if (!entry.watched || entry.signalled) continue;
        if (room === null) room = roomToTell();
        if (!room) return;
        try {
          dispatchWindowEvent(window, newEvent(entry.name + ':changed', null, false));
          entry.signalled = true;
        } catch {
          return; // told with the next entry
        }
      }
      owed = false;
    } finally {
      telling = false;
    }
  }

  function setWatched(entry, on) {
    if (entry.watched === on) return;
    entry.watched = on;
    watching += on ? 1 : -1;
  }

  function listen(name) {
    for (let i = 0; i < channels.length; i += 1) if (channels[i].name === name) return;
    // An old bridge's channel stays open after the extension reloads and a
    // new one arrives, and a page can say HELLO as often as it likes, so the
    // count has a bound. The oldest goes, not the newest: the bridge that
    // said HELLO last is the live one, and a bound that turned new channels
    // away left the log unreachable from the eighth reload of the extension
    // on, until the page was reloaded. A page that says HELLO eight times
    // pushes the live bridge out too, which leaves its own log unread and
    // the panel's reload advice up; it could as well not log at all.
    if (channels.length >= CHANNEL_LIMIT) {
      const oldest = channels[0];
      for (let i = 1; i < channels.length; i += 1) channels[i - 1] = channels[i];
      channels.length -= 1;
      setWatched(oldest, false);
      try {
        removeWindowListener(window, oldest.name, oldest.listener);
      } catch {
        /* still bounded: the entry is gone either way */
      }
    }
    const entry = { __proto__: null, name, listener: null, watched: false, signalled: false };
    // Nothing of the page's runs from here to the reply: the request is read
    // and the reply made through what was taken at the top of this file, and
    // a page script that ran now could read the request's type off
    // window.event, which is the channel's name.
    entry.listener = (event) => {
      try {
        const action = detailOf(event);
        let payload = null;
        if (action === 'snapshot') payload = snapshot();
        else if (action === 'clear') clearRings();
        else if (action === 'watch' || action === 'counts') {
          if (action === 'watch') setWatched(entry, true);
          entry.signalled = false;
          payload = counts();
        } else if (action === 'unwatch') setWatched(entry, false);
        // The bridge asks once as it says HELLO, to learn that a collector
        // heard it, and is answered with nothing; see the bridge.
        else if (action !== 'ping') return;
        dispatchWindowEvent(window, newEvent(name + ':reply', payload, false));
      } catch {
        /* the bridge then reads nothing, and says so */
      }
    };
    append(channels, entry);
    addWindowListener(window, name, entry.listener);
  }

  try {
    addWindowListener(window, HELLO, (event) => {
      try {
        const detail = detailOf(event);
        if (typeof detail !== 'string' || sliceString(detail, 0, 7) !== 'bridge ') return;
        const name = sliceString(detail, 7);
        if (execRegExp(CHANNEL, name) !== null) listen(name);
      } catch {
        /* ignore */
      }
    });
    // A collector of this build answers the worker's probe and the guard at
    // the top of the next copy, which comes with a function to call. Only
    // the probe is in hand here, whoever sent it.
    addWindowListener(window, PROBE, (event) => {
      try {
        cancel(event);
        const answer = detailOf(event);
        if (typeof answer === 'function') answer();
      } catch {
        /* ignore */
      }
    });
    // For a bridge that arrived first and is waiting to be asked.
    dispatchWindowEvent(window, newEvent(HELLO, 'main', false));
  } catch {
    /* no CustomEvent: the bridge falls back, and finds nothing to read */
  }

  // The picker still asks over window.postMessage, and its protocol is
  // unchanged: it asks what rendered a node it has marked, and the answer is
  // about that node alone, never the log. Through the native taken at the
  // top, and guarded, as every listener here is: a page whose own
  // addEventListener throws must not see this file throw into it.
  try {
    addWindowListener(window, 'message', (event) => {
      // Only accept messages this page sent to itself. Without this guard any
      // embedded iframe could ask.
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.__cdr !== 'request') return;

      // Branch on the action. Reloading the extension leaves this script
      // running in tabs that are already open while a newly injected picker
      // talks to it, so an action this build has never heard of has to answer
      // null, which tells that picker there is no answer rather than leaving it
      // to wait out its timeout. 'snapshot' and 'clear' are among those now:
      // the log is read over the channel above.
      let payload = null;
      if (data.action === 'inspect') payload = inspect(data.marker);

      try {
        window.postMessage({ __cdr: 'response', id: data.id, payload }, '*');
      } catch {
        // Structured clone refused the payload. The caller is waiting on this id
        // and would otherwise sit out its whole timeout, so it gets an empty
        // answer instead.
        try {
          window.postMessage({ __cdr: 'response', id: data.id, payload: null }, '*');
        } catch {
          /* ignore */
        }
      }
    });
  } catch {
    /* the picker then finds no component, as on a page with none */
  }

  // While Element is armed, the picker's tag names the component behind the
  // element it highlights, the name the item's Component line will start
  // with. It asks once for each element it highlights in an arm, with
  // NAME_REQUEST sent on that node itself, and this answers with
  // NAME_REQUEST + ':reply' on the window: { name, renamed } from
  // componentOf(node, true), or null when no component is found. Dispatch is
  // synchronous and crosses the two worlds, so the answer is in before the
  // picker's dispatchEvent returns, in the frame the box is drawn in, with
  // nothing written into the page and nothing posted. The picker sends it
  // composed, so that it reaches this listener from inside an open shadow
  // root, without bubbling, which is why this listens in the capture phase;
  // the node is read off the event's path, since the target seen from the
  // window is the shadow host's. A node in a closed root is never asked
  // about: the picker asks about the root's host instead, as it does at a
  // pick.
  //
  // The type is public, and not one of the bridge's channels, on purpose.
  // Page code can run while the name is read (a getter on a fiber's type, or
  // on Element.prototype.parentElement), and while it does window.event is
  // this request: on a channel it would read the channel's name off it, and
  // then the log. What crosses here is the name of a component of the page's
  // own, which the page can read for itself.
  const NAME_REQUEST = '__cdr_name';
  // Set while a request is answered, so that one a page getter sends from
  // inside the answer gets none, rather than a recursion.
  let naming = false;

  /** The node a name request was sent on, as this world sees it. */
  function requestedNode(event) {
    if (eventPath) {
      // An array of this world's own, so its length and its first index are
      // its own properties, and no accessor on Array.prototype is consulted.
      const path = eventPath(event);
      return path.length > 0 ? path[0] : null;
    }
    return event.target;
  }

  function answerName(event) {
    if (naming) return;
    naming = true;
    try {
      let reply = null;
      try {
        const node = requestedNode(event);
        const found = node ? componentOf(node, true) : null;
        const name = found ? found.names[0] : null;
        if (typeof name === 'string' && name) reply = { name, renamed: found.renamed === true };
      } catch {
        // A throwing getter on a fiber or an element: no name, and the
        // picker shows the element alone.
        reply = null;
      }
      dispatchWindowEvent(window, newEvent(NAME_REQUEST + ':reply', reply, false));
    } catch {
      /* no CustomEvent: the picker hears nothing, and asks no more this arm */
    } finally {
      naming = false;
    }
  }

  try {
    addWindowListener(window, NAME_REQUEST, answerName, true);
  } catch {
    /* the tag then shows the element alone, as on a page with no collector */
  }

  // snapshot() deliberately stays inside this closure, and no global marks
  // the collector: a page could read one to tell the extension is
  // installed. Being honest about the limit of this: code running in the
  // page shares this world by necessity, so a script written against this
  // extension can still find it, through the wrappers' source text, a stack
  // that passes through them, the guard's probe event, or the picker's
  // protocol. Nor is the channel closed to it. It can say a HELLO of its own
  // and read the log over that channel, lines logged before it ran
  // included, or watch the counts on it, which say less than the log. A
  // channel it watches is marked on its own, so it cannot keep the bridge's
  // from being told. And when the extension injects a bridge into a page
  // already open, it can hear that bridge's HELLO and answer in this collector's
  // place, which puts nothing in a prompt that logging made up lines would
  // not, or ask to 'unwatch' on that bridge's channel, which leaves the
  // chips at what the panel's last read found, as they were before they
  // followed the log; each read asks to 'watch' again. What it collects is
  // the page's own console and network activity, which the first script
  // the page runs could wrap for itself; a script that runs later can read,
  // through this, what came before it.
  //
  // The name request is open to it too. It can send NAME_REQUEST on a node
  // of its own and be told the name of the component behind it, which it
  // could read from its own framework, and which also tells it the
  // extension is installed, as the probe does. It can hear the picker's
  // requests, and so learn which element the highlight is on, also one
  // reached with the keys (the pointer's moves reach it anyway). And it can
  // stop the reply, put one of its own in its place (a capture listener for
  // the reply added before the picker's, which is added for each request,
  // runs first), or answer where no collector runs. None of that goes
  // further than the tag: the picker rebuilds the reply to a name of at most
  // 60 characters, writes it as text, and never puts it in a prompt.
})();

// The address V8 gives this file, in stacks, in console messages and in CSP
// reports, instead of chrome-extension://<id>/content/collector-main.js.
//
// Chrome reports a console message whose topmost frame is in a chrome-extension
// URL in detail, with the whole stack captured again and formatted, whether
// or not developer mode is on. Every console.error and console.warn a page
// makes reaches the native from the wrapper in this file, so each one paid
// for that: measured in Chrome for Testing 156 with no DevTools attached,
// about 148 microseconds a call, and 0.9 ms from a stack 30 frames deep,
// against 3 microseconds without the extension. Under an address of another
// scheme the same calls cost what they cost with no extension at all. A
// stack that passes through a wrapper no longer carries the extension's id
// either.
//
// punch-list:// still says whose frame it is, which a relative name would
// not: a CSP report would then name no source at all, and the name could
// pass for one of the page's own files. The file name goes in the path, not
// the host: DevTools names a script by the last segment of its path, and
// called punch-list://collector-main.js, whose path is empty, "(index)",
// the name it gives the page's own document, so with the map below not
// applied every page console.error linked to "(index):<line>".
//# sourceURL=punch-list://extension/collector-main.js
// DevTools links a console message to the frame that called console.warn or
// console.error, which on every page is the wrapper in this file rather than
// the page's own code. The map below lists this file's only source in
// ignoreList, so DevTools skips its frames and links the page's line instead.
// It is a comment: nothing reads it at runtime, and it is written by hand, so
// there is still no build step. Decoded:
// {"version":3,"file":"collector-main.js","sources":["punch-list-collector.js"],
//  "names":[],"mappings":"AAAA","ignoreList":[0],"x_google_ignoreList":[0]}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29sbGVjdG9yLW1haW4uanMiLCJzb3VyY2VzIjpbInB1bmNoLWxpc3QtY29sbGVjdG9yLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBIiwiaWdub3JlTGlzdCI6WzBdLCJ4X2dvb2dsZV9pZ25vcmVMaXN0IjpbMF19
