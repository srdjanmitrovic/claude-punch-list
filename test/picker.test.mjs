/**
 * What the element picker hides from a picked node's markup and attributes.
 *
 * The picker runs in the page and builds its payload from the live DOM, which
 * Node has none of. The masking works on attribute values and serialised
 * markup alone, so its block is lifted out of content/picker.js, with the
 * secret name blocks it calls, and run here as it is.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('../content/picker.js', import.meta.url), 'utf8');

function between(begin, end) {
  const from = SOURCE.indexOf(begin);
  const to = SOURCE.indexOf(end, from);
  assert.ok(from !== -1 && to !== -1, `content/picker.js has lost its ${begin} marker`);
  return SOURCE.slice(from, to + end.length);
}

const BLOCKS = [
  between('// SECRET NAMES BEGIN', '// SECRET NAMES END'),
  between('// SECRET URLS BEGIN', '// SECRET URLS END'),
  between('// MASKING BEGIN', '// MASKING END'),
].join('\n');

const { maskMarkup, maskAttribute, secretControl, maskedStart } = new Function(
  `${BLOCKS}\nreturn { maskMarkup, maskAttribute, secretControl, maskedStart: typeof maskedStart === 'function' ? maskedStart : null };`
)();

const MAX_HTML = Number(/const MAX_HTML = (\d+);/.exec(SOURCE)[1]);

// markup() and what it calls outside the masking block: the code between
// visibleText() and styles(), run with the blocks it reads from.
const markup = (() => {
  const visible = SOURCE.indexOf('    function visibleText(element) {');
  const from = SOURCE.indexOf('\n    }\n', visible) + '\n    }\n'.length;
  const to = SOURCE.indexOf('    function styles(element) {');
  assert.ok(visible !== -1 && to > from, 'content/picker.js has moved markup() away from visibleText() and styles()');
  return new Function(`const MAX_HTML = ${MAX_HTML};\n${BLOCKS}\n${SOURCE.slice(from, to)}\nreturn markup;`)();
})();

/**
 * How long a run takes. A run over the limit is timed once more and the
 * quicker run counts, so that a pause of the machine's own (a collection, a
 * busy core) does not fail a test, while work that grows out of bounds is
 * over the limit both times.
 */
function timed(run, limit) {
  const once = () => {
    const started = performance.now();
    run();
    return performance.now() - started;
  };
  const first = once();
  return first < limit ? first : Math.min(first, once());
}

test('picker: a password input loses its value, wherever React mirrored it', () => {
  assert.equal(
    maskMarkup('<form><input type="password" name="pw" value="hunter2"><button>Go</button></form>'),
    '<form><input type="password" name="pw" value="<redacted>"><button>Go</button></form>'
  );
});

test('picker: a hidden input and a field named for a secret lose their value', () => {
  assert.equal(
    maskMarkup('<input type="hidden" name="csrf_token" value="abc123">'),
    '<input type="hidden" name="csrf_token" value="<redacted>">'
  );
  assert.equal(
    maskMarkup('<input type="text" id="cardNumber" value="4111111111111111">'),
    '<input type="text" id="cardNumber" value="<redacted>">'
  );
  assert.equal(
    maskMarkup('<input autocomplete="one-time-code" value="123456">'),
    '<input autocomplete="one-time-code" value="<redacted>">'
  );
});

test('picker: an ordinary field keeps its value, and an untouched tag is left byte for byte', () => {
  const html = '<div class="row"><input type="text" name="quantity" value="3"><span title="a>b">x</span></div>';
  assert.equal(maskMarkup(html), html);
});

test('picker: an attribute named for a secret is hidden on any element', () => {
  assert.equal(
    maskMarkup('<div data-auth-token="eyJhbGciOi" data-testid="card">x</div>'),
    '<div data-auth-token="<redacted>" data-testid="card">x</div>'
  );
});

test('picker: a payment nonce field and attribute lose their value (F43)', () => {
  assert.equal(
    maskMarkup('<input type="text" name="payment_method_nonce" value="tokencc_F43A"><span data-card-nonce="F43B" data-announce="soon">x</span>'),
    '<input type="text" name="payment_method_nonce" value="<redacted>"><span data-card-nonce="<redacted>" data-announce="soon">x</span>'
  );
  assert.equal(maskAttribute('href', '/wp-admin/post.php?post=7&_wpnonce=F43C'), '/wp-admin/post.php?post=7&_wpnonce=<redacted>');
});

test('picker: a link\'s user name of small letters with five consonants in a row goes (F52)', () => {
  assert.equal(maskAttribute('href', 'https://xkcdqwertyzpqlm@git.example.com/repo'), 'https://git.example.com/repo');
  assert.equal(maskAttribute('href', 'ssh://postgres@db.example.com/app'), 'ssh://postgres@db.example.com/app');
});

test('picker: a url attribute keeps its path and loses credentials and secret params', () => {
  assert.equal(
    maskMarkup('<a href="/reset?token=abc&amp;step=2">Reset</a>'),
    '<a href="/reset?token=<redacted>&amp;step=2">Reset</a>'
  );
  assert.equal(
    maskAttribute('src', 'https://user:pw@cdn.test/i.png?X-Amz-Signature=f00&w=40', false),
    'https://cdn.test/i.png?X-Amz-Signature=<redacted>&w=40'
  );
  assert.equal(maskAttribute('href', '/plain/path', false), '/plain/path');
  // A password outside ASCII, as outerHTML keeps it.
  assert.equal(maskAttribute('href', 'https://u:Pässwört@host.test/x', false), 'https://host.test/x');
  assert.equal(maskAttribute('href', 'https://josé:pw@host.test/x', false), 'https://host.test/x');
});

test('picker: the picked element itself is judged by its own attributes', () => {
  const attrs = { type: 'password', name: 'pw' };
  const control = secretControl('input', (name) => attrs[name] ?? null);
  assert.equal(control, true);
  assert.equal(maskAttribute('value', 'hunter2', control), '<redacted>');
  assert.equal(maskAttribute('name', 'pw', control), 'pw');
  // A name alone makes no control of an element that is none.
  assert.equal(secretControl('div', (name) => ({ name: 'pw' })[name] ?? null), false);
});

test('picker: code, key and sig after the first param are masked although markup writes & as &amp;', () => {
  assert.equal(
    maskMarkup('<img src="/a.png?w=40&amp;sig=AMPSIG"><a href="/m?size=2&amp;key=K&amp;code=C">m</a>'),
    '<img src="/a.png?w=40&amp;sig=<redacted>"><a href="/m?size=2&amp;key=<redacted>&amp;code=<redacted>">m</a>'
  );
});

test('picker: every srcset candidate is masked on its own, and a comma inside a url survives', () => {
  assert.equal(
    maskAttribute('srcset', '/a.png?w=40 1x, /a.png?X-Amz-Signature=S&w=80 2x', false),
    '/a.png?w=40 1x, /a.png?X-Amz-Signature=<redacted>&w=80 2x'
  );
  const plain = 'https://cdn.test/w_100,h_100/a.jpg 1x, https://cdn.test/w_200,h_200/a.jpg 2x';
  assert.equal(maskAttribute('srcset', plain, false), plain);
});

test('picker: lazy loaded, SVG and inline style urls lose their secret params', () => {
  assert.equal(maskAttribute('data-src', '/a.png?token=T', false), '/a.png?token=<redacted>');
  assert.equal(maskAttribute('xlink:href', '/s.svg?token=T#icon', false), '/s.svg?token=<redacted>#icon');
  assert.equal(
    maskMarkup('<div style="background-image: url(&quot;/bg.png?X-Amz-Signature=S&quot;)">x</div>'),
    '<div style="background-image: url(&quot;/bg.png?X-Amz-Signature=<redacted>&quot;)">x</div>'
  );
});

test('picker: a textarea named for a secret loses its text, and an ordinary one keeps it', () => {
  assert.equal(
    maskMarkup('<form><textarea name="privateKey">-----BEGIN PRIVATE KEY-----</textarea></form>'),
    '<form><textarea name="privateKey"><redacted></textarea></form>'
  );
  const plain = '<textarea name="comment">Looks good &lt;3</textarea>';
  assert.equal(maskMarkup(plain), plain);
});

test('picker: email, phone and numbered fields are secret controls; accesskey is not a key', () => {
  assert.equal(secretControl('input', (name) => ({ type: 'email' })[name] ?? null), true);
  assert.equal(secretControl('input', (name) => ({ type: 'tel' })[name] ?? null), true);
  assert.equal(secretControl('input', (name) => ({ name: 'otp1' })[name] ?? null), true);
  assert.equal(secretControl('button', (name) => ({ name: 'csrf_token' })[name] ?? null), true);
  assert.equal(maskAttribute('accesskey', 's', false), 's');
});

test('picker: cutting long markup keeps the whole opening tag although the marker holds a ">"', () => {
  const cut = (open) => {
    const inner = '<p>row</p>'.repeat(400);
    return markup({ outerHTML: `${open}${inner}</form>`, innerHTML: inner, children: { length: 400 }, tagName: 'FORM' });
  };
  const { html, truncated } = cut('<form id="big" action="/login?token=T&amp;step=1" data-testid="big" method="post">');
  assert.equal(truncated, true);
  assert.ok(
    html.startsWith('<form id="big" action="/login?token=<redacted>&amp;step=1" data-testid="big" method="post">\n'),
    html.slice(0, 120)
  );
  assert.ok(!html.includes('token=T&'));
  // Chrome before 138 writes a '>' inside a value as it is.
  const old = cut('<form action="/login?token=OLD&amp;next=a>b" x-show="n > 0" method="post">').html;
  assert.ok(old.startsWith('<form action="/login?token=<redacted>&amp;next=a>b" x-show="n > 0" method="post">\n'), old.slice(0, 120));
});

test('picker: every form of url() in a style is masked, an untouched one is left as written, and none backtracks', () => {
  assert.equal(maskAttribute('style', `background: url('/a.png?sig=S')`, false), `background: url('/a.png?sig=<redacted>')`);
  assert.equal(maskAttribute('style', 'background: url("/a.png?sig=S")', false), 'background: url("/a.png?sig=<redacted>")');
  assert.equal(maskAttribute('style', 'background: url( /a.png?sig=S )', false), 'background: url(/a.png?sig=<redacted>)');
  // CSSOM writes a url with a parenthesis in it in &quot; form.
  assert.equal(
    maskMarkup('<div style="background-image: url(&quot;https://cdn.test/a(1).png?sig=PAREN&quot;);">x</div>'),
    '<div style="background-image: url(&quot;https://cdn.test/a(1).png?sig=<redacted>&quot;);">x</div>'
  );
  const plain = 'background: url(  "/a.png?w=2"  ), url(/b.png)';
  assert.equal(maskAttribute('style', plain, false), plain);
  for (const hostile of ['url(' + ' '.repeat(20000) + 'x', 'url(' + ' \t'.repeat(10000) + 'x', 'url('.repeat(25000), 'url("'.repeat(20000), 'url(&quot;'.repeat(10000), 'url(&quot;x&quot;'.repeat(10000), 'url(&quot;' + 'a&'.repeat(25000)]) {
    const took = timed(() => maskAttribute('style', hostile, false), 250);
    assert.ok(took < 250, `${hostile.slice(0, 12)}… took ${Math.round(took)} ms`);
  }
});

test('picker: a url nested in a parameter loses its credentials, and nesting has a floor', () => {
  assert.equal(maskAttribute('href', '/l?next=https://u:S70X@b.test/x', false), '/l?next=https://b.test/x');
  assert.equal(maskAttribute('href', '/l?next=https%3A%2F%2Fu%3AS71X%40b.test%2Fx', false), '/l?next=<redacted>');
  const deep = '/p?api_key=TOP&n=' + '?a='.repeat(4000) + '?token=DEEP';
  const masked = maskAttribute('href', deep, false);
  assert.ok(!masked.includes('TOP') && !masked.includes('DEEP'));
});

test('picker: a secret textarea leaves the element text, and only its own text', () => {
  const from = SOURCE.indexOf('    function visibleText(element) {');
  const visibleText = new Function(
    'secretTextarea',
    'document',
    'NodeFilter',
    `${SOURCE.slice(from, SOURCE.indexOf('\n    }\n', from) + '\n    }\n'.length)}\nreturn visibleText;`
  );
  const area = (name, text) => ({ tagName: 'TEXTAREA', getAttribute: (n) => (n === 'name' ? name : null), text });
  const element = (...children) => ({
    tagName: 'DIV',
    querySelector: () => children.find((child) => child.tagName),
    textContent: children.map((child) => child.text ?? child).join(''),
    nodes: children.map((child) => (child.tagName ? { data: child.text, parentElement: child } : { data: child, parentElement: null })),
  });
  const fakeDocument = {
    createTreeWalker: (root) => {
      let index = -1;
      return { nextNode: () => root.nodes[++index] || null };
    },
  };
  const run = visibleText((get) => /key|pin/.test(get('name') || ''), fakeDocument, { SHOW_TEXT: 4 });
  assert.equal(run(element('Enter the key below ', area('api_key', 'e'))), 'Enter the key below');
  assert.equal(run(element('Order 1 of 12 ', area('pin', '1'), ' total')), 'Order 1 of 12 total');
  assert.equal(run(element('Notes ', area('comment', 'kept'))), 'Notes kept');
});

test('picker: an attribute whose name holds a quote or starts with "=" does not leave its tag unmasked', () => {
  // Chrome 157 writes such names back into outerHTML as the page wrote them.
  assert.equal(maskMarkup('<div =x="1" data-auth-token="EQ1">a</div>'), '<div =x="1" data-auth-token="<redacted>">a</div>');
  assert.equal(
    maskMarkup(`<div a"b="1" a'c="2" a<d="3" data-auth-token="QT1">a</div>`),
    `<div a"b="1" a'c="2" a<d="3" data-auth-token="<redacted>">a</div>`
  );
  assert.equal(maskMarkup('<input =="1" type="password" value="EQ2">'), '<input =="1" type="password" value="<redacted>">');
  assert.equal(maskMarkup('<div data-"token"="QT2">a</div>'), '<div data-"token"="<redacted>">a</div>');
  assert.equal(maskMarkup('<textarea a"b="1" name="privateKey">QT3</textarea>'), '<textarea a"b="1" name="privateKey"><redacted></textarea>');
});

test('picker: the start of long markup is masked as the start of the whole would be', () => {
  assert.equal(typeof maskedStart, 'function', 'content/picker.js has no maskedStart()');
  // Pieces that a cut could fall inside of and leave a secret behind: a
  // tag, a textarea's text, a value holding '<' or '>' as Chrome before 138
  // writes it, and script text.
  const pieces = [
    '<p class="x">row</p>', '<a href="/r?token=T&amp;x=1">r</a>', '<input type="password" name="pw" value="hunter2">',
    `<textarea name="apiToken">${'k'.repeat(300)}</textarea>`, '<span title="a>b" data-auth-token="S">t</span>',
    '<b title="<textarea name=x>">u</b>', `<script>if (a<b) x("<i data-token='Q'>")</script>`,
    '<img src="https://u:PW@cdn.test/i.png?sig=G" alt="">', `<div data-v="${'v'.repeat(500)}">w</div>`,
  ];
  let seed = 7;
  for (let round = 0; round < 300; round += 1) {
    let html = '<div id="root">';
    for (let count = 0; count < 40; count += 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      html += pieces[seed % pieces.length];
    }
    html += '</div>';
    const whole = maskMarkup(html);
    for (const keep of [10, 200, 1600, 6000]) {
      const start = maskedStart(html, keep);
      assert.ok(start === whole || (whole.startsWith(start) && start.length > keep), `round ${round}, keep ${keep}`);
    }
  }
});

test('picker: a subtree of megabytes is masked only as far as it is kept, and read once', () => {
  const row = (n) => `<tr data-id="${n}"><td><a href="/i/${n}?token=T${n}">i</a></td><td><input type="password" value="hunter${n}"></td></tr>`;
  const inner = Array.from({ length: 16000 }, (_, n) => row(n)).join('');
  let innerReads = 0;
  const element = {
    outerHTML: `<table class="grid">${inner}</table>`,
    get innerHTML() {
      innerReads += 1;
      return inner;
    },
    children: { length: 16000 },
    tagName: 'TABLE',
  };
  let result;
  // About 2 ms masking what is kept, and over 100 ms masking the whole.
  const took = timed(() => {
    result = markup(element);
  }, 50);
  const { html, truncated } = result;
  assert.ok(took < 50, `markup() of ${(element.outerHTML.length / 1e6).toFixed(1)} MB took ${Math.round(took)} ms`);
  assert.equal(innerReads, 0, 'innerHTML was serialised a second time');
  assert.equal(truncated, true);
  assert.ok(html.length <= MAX_HTML, `${html.length} characters`);
  assert.ok(html.startsWith('<table class="grid">\n<tr data-id="0"><td><a href="/i/0?token=<redacted>">'), html.slice(0, 80));
  assert.ok(!/hunter|token=T/.test(html));
  assert.ok(html.endsWith('\n  <!-- …16000 child element(s), truncated -->\n</table>'));
});

test('picker: a void element over the limit is its opening tag cut to fit, with no closing tag', () => {
  const img = `<img alt="hero" src="data:image/png;base64,${'iVBORw0KGgo'.repeat(5000)}" data-token="VOID1">`;
  const { html, truncated } = markup({ outerHTML: img, innerHTML: '', children: { length: 0 }, tagName: 'IMG' });
  assert.equal(truncated, true);
  assert.ok(html.length <= MAX_HTML, `${html.length} characters`);
  assert.ok(html.startsWith('<img alt="hero" src="data:image/png;base64,iVBORw0KGgo'), html.slice(0, 60));
  assert.ok(html.endsWith('…" data-token="<redacted>">'), html.slice(-40));
  assert.ok(!html.includes('</img>') && !html.includes('child element'));
  const input = `<input type="text" name="q" value="${'v'.repeat(3000)}">`;
  const short = markup({ outerHTML: input, innerHTML: '', children: { length: 0 }, tagName: 'INPUT' }).html;
  assert.ok(short.length <= MAX_HTML && !short.includes('</input>'), short.slice(-40));
  // An element with children whose own tag is too long keeps every
  // attribute, each value cut, and as much of its children as fits.
  const div = `<div class="card" style="${'color: red; '.repeat(400)}" data-auth-token="S"><p>child</p></div>`;
  const cut = markup({ outerHTML: div, innerHTML: '<p>child</p>', children: { length: 1 }, tagName: 'DIV' }).html;
  assert.ok(cut.length <= MAX_HTML, `${cut.length} characters`);
  assert.ok(cut.startsWith('<div class="card" style="color: red; '));
  assert.ok(cut.includes('…" data-auth-token="<redacted>">\n<p>child</p>\n'), cut.slice(100, 240));
  assert.ok(cut.endsWith('\n</div>'));
});

test('picker: a name, id or url parameter name of a million characters is judged by its ends, in bounded time', () => {
  const long = 'aB'.repeat(500000);
  for (const [html, masked] of [
    [`<input name="${long}" value="kept">`, false],
    [`<input id="${long}Token" value="gone">`, true],
    [`<div style="background: url(&quot;/a.png?${long}=kept&quot;)">x</div>`, false],
    [`<a href="/a?${long}Token=gone">x</a>`, true],
  ]) {
    let out;
    // A few ms judged by its ends, and about 300 ms judged whole.
    const took = timed(() => {
      out = maskMarkup(html);
    }, 100);
    assert.ok(took < 100, `${html.slice(0, 16)}… took ${Math.round(took)} ms`);
    assert.equal(out.includes('gone'), false);
    assert.equal(out.includes('<redacted>'), masked);
  }
});

test('picker: a url attribute loses path parameters, and credentials wherever they sit', () => {
  assert.equal(maskAttribute('href', '/app;jsessionid=J1?x=1', false), '/app;jsessionid=<redacted>?x=1');
  assert.equal(maskMarkup('<a href="/app;jsessionid=J2">x</a>'), '<a href="/app;jsessionid=<redacted>">x</a>');
  assert.equal(maskAttribute('href', 'https://cors.test/https://user:PW1@api.test/x', false), 'https://cors.test/https://api.test/x');
  assert.equal(maskAttribute('src', '/a.png?sid=S1&w=2', false), '/a.png?sid=<redacted>&w=2');
  assert.equal(maskAttribute('href', '/l?next=https%253A%252F%252Fa.test%252F%253Ftoken%253DT2', false), '/l?next=<redacted>');
  const plain = 'data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C%2Fsvg%3E';
  assert.equal(maskAttribute('src', plain, false), plain);
});

test('picker: a data: url keeps its content, whose colours and padding are no parameters', () => {
  // An svg with five colours, each a %23 that would read as one more url.
  const paths = Array.from({ length: 5 }, (_, n) => `<path fill='#${n}${n}${n}' d='M${n}'/>`).join('');
  const svg = `data:image/svg+xml;charset=utf8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg'>${paths}</svg>`)}`;
  assert.equal(maskAttribute('src', svg, false), svg);
  // base64 whose letters spell a secret word ahead of its '=' padding, alone
  // and inside an svg, as a blurred placeholder puts it in a style.
  const png = 'data:image/png;charset=x;base64,iVBORw0KGgoTokenAAAANSUhEUg==';
  assert.equal(maskAttribute('src', png, false), png);
  const blur = `data:image/svg+xml;charset=utf-8,%3Csvg%3E%3Cimage href='data:image/jpeg;base64,/9j/4AAQSecretAAQ=='/%3E%3C/svg%3E`;
  const style = `background-size:cover;background-image:url(&quot;${blur}&quot;)`;
  assert.equal(maskAttribute('style', style, false), style);
  // The parameters before the comma are still read.
  assert.equal(maskAttribute('src', 'data:text/plain;token=D1,hello', false), 'data:text/plain;token=<redacted>,hello');
});

test('picker: a tag name with a "<" in it is read, whatever follows the "<"', () => {
  // The parser makes such names of malformed markup or an unrendered
  // template (<div<{{x}} …>), and outerHTML writes them back as they are.
  for (const name of ['div<x', 'div<1', 'span<_', 'div<{{x}}', 'div<', 'div<<1', 'a<b<2']) {
    assert.equal(
      maskMarkup(`<${name} data-token="S1" class="c">a</${name}>`),
      `<${name} data-token="<redacted>" class="c">a</${name}>`,
      name
    );
  }
  // Such an element picked with too many children to print keeps its whole
  // opening tag.
  const rows = '<p>row</p>'.repeat(400);
  const { html } = markup({ outerHTML: `<div<1 data-token="S2" class="c">${rows}</div<1>`, children: { length: 400 }, tagName: 'DIV<1' });
  assert.ok(html.startsWith('<div<1 data-token="<redacted>" class="c">\n<p>row</p>'), html.slice(0, 60));
  assert.ok(html.endsWith('\n</div<1>'), html.slice(-20));
  // Text and script text where a '<' starts no tag are left alone.
  for (const plain of ['<p>a&lt;1 &amp;&amp; b</p>', '<script>if (a<1 && b < 2) go()</script>', '<script>x< y</script>']) {
    assert.equal(maskMarkup(plain), plain);
  }
});

test('picker: script text built to make the tag pattern read a name again from every "<" costs one pass', () => {
  // Script text is serialised raw, so a page can put any run of '<' into it.
  for (const text of [
    '<a'.repeat(30000), '<textarea'.repeat(6000), '<a "'.repeat(15000), '<a a"b="1"'.repeat(6000),
    '<1'.repeat(30000), 'a<'.repeat(30000), 'a<<'.repeat(20000), '<x<'.repeat(20000), 'x< '.repeat(20000),
  ]) {
    const html = `<div class="w"><script>${text}</script><p data-auth-token="S">after</p></div>`;
    const took = timed(() => {
      markup({ outerHTML: html, innerHTML: html.slice(15, -6), children: { length: 2 }, tagName: 'DIV' });
      maskMarkup(html);
    }, 250);
    assert.ok(took < 250, `${text.slice(0, 10)}… took ${Math.round(took)} ms`);
  }
});

// The opening tag scanner, with the pattern it stands in for.
const scanning = new Function(
  `${BLOCKS}\nreturn { tagScanner: typeof tagScanner === 'function' ? tagScanner : null, OPEN_TAG };`
)();

test('picker: a run of attributes named with a "<" is read once, not again from every "<" in it', () => {
  // Script text and comments are written out raw, so a page can put this in
  // either. 100 kB of it took 1.7 s, in the page, when its element was picked.
  const run = ' <a="1"'.repeat(14000);
  for (const [label, html] of [
    ['script', `<div class="w"><script><a${run}</script><p data-auth-token="S">after</p></div>`],
    ['comment', `<div class="w"><!-- <a${run} --><p data-auth-token="S">after</p></div>`],
    ['names holding "<"', `<div class="w"><script><a${' b<c="1"'.repeat(12500)}</script><p data-auth-token="S">after</p></div>`],
    ['textarea', `<div class="w"><script><textarea${' <textarea="1"'.repeat(7000)}</script><p data-auth-token="S">after</p></div>`],
  ]) {
    let masked;
    let start;
    const took = timed(() => {
      masked = maskMarkup(html);
      start = maskedStart(html, MAX_HTML + 20);
    }, 150);
    assert.ok(took < 150, `${label}: ${Math.round(took)} ms for ${Math.round(html.length / 1000)} kB`);
    assert.ok(masked.endsWith('<p data-auth-token="<redacted>">after</p></div>'), label);
    assert.ok(start.length > MAX_HTML, label);
  }
});

test('picker: the tag scanner finds exactly the tags the pattern found', () => {
  assert.equal(typeof scanning.tagScanner, 'function', 'content/picker.js has no tagScanner()');
  const pieces = [
    '<', 'a', 'B', ' ', '\t', '\n', '=', '"', "'", '>', '/', '1', '<a', ' <a="1"', '<textarea', '"x"', '<<', 'div<1',
    ' =x="1"', ' a"b="2"', '<!--', '-->', ' data-token="T"', '/>', ' x', '<p>', '</p>',
  ];
  const byPattern = (html) => {
    const found = [];
    const pattern = new RegExp(scanning.OPEN_TAG.source, 'g');
    for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
      found.push([match.index, match.index + match[0].length, match[1], match[2], match[3]]);
    }
    return found;
  };
  const byScanner = (html) => {
    const found = [];
    const next = scanning.tagScanner(html);
    for (let tag = next(); tag; tag = next()) found.push([tag.index, tag.end, tag.name, tag.attrs, tag.close]);
    return found;
  };
  let seed = 11;
  for (let round = 0; round < 6000; round += 1) {
    let html = '';
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const count = 1 + (seed % 40);
    for (let index = 0; index < count; index += 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      html += pieces[seed % pieces.length];
    }
    assert.deepEqual(byScanner(html), byPattern(html), JSON.stringify(html));
  }
});

test('picker: JSON written into an href is judged with its quotes, although markup writes them as &quot;', () => {
  // As outerHTML writes <a href='/cb?state={"token":"PK01"}'>.
  assert.equal(
    maskMarkup('<a href="/cb?state={&quot;token&quot;:&quot;PK01&quot;}">x</a>'),
    '<a href="/cb?state=<redacted>">x</a>'
  );
  // What is kept of a masked value goes back escaped as outerHTML wrote it.
  assert.equal(
    maskMarkup('<a href="/cb?q=&quot;a&quot;&amp;token=PK02&amp;n=1" title="&quot;t&quot;">x</a>'),
    '<a href="/cb?q=&quot;a&quot;&amp;token=<redacted>&amp;n=1" title="&quot;t&quot;">x</a>'
  );
  // A control's type and name are read as the page set them.
  assert.equal(maskMarkup('<input name="pass&amp;word" value="PK03">'), '<input name="pass&amp;word" value="<redacted>">');
  const plain = '<a href="/s?q=&quot;shoes&quot;&amp;page=2" data-x="&lt;b&gt;">x</a>';
  assert.equal(maskMarkup(plain), plain);
});

test('picker: an object\'s data, a preload link\'s imagesrcset and an iframe\'s srcdoc are screened', () => {
  assert.equal(
    maskMarkup('<object data="https://x.test/doc.pdf?token=OB1" type="application/pdf"></object>'),
    '<object data="https://x.test/doc.pdf?token=<redacted>" type="application/pdf"></object>'
  );
  assert.equal(
    maskMarkup('<link rel="preload" as="image" imagesrcset="https://x.test/a.png?token=IS1 1x, /b.png?w=2 2x">'),
    '<link rel="preload" as="image" imagesrcset="https://x.test/a.png?token=<redacted> 1x, /b.png?w=2 2x">'
  );
  // srcdoc as outerHTML writes it, and as attributes() reads it.
  assert.equal(
    maskMarkup('<iframe srcdoc="&lt;a href=&quot;https://x.test/?token=SD1&quot;&gt;x&lt;/a&gt;"></iframe>'),
    '<iframe srcdoc="<redacted>"></iframe>'
  );
  assert.equal(maskAttribute('srcdoc', `<a href='https://x.test/?token=SD2'>x</a>`, false), '<redacted>');
  assert.equal(maskAttribute('srcdoc', '<form><input type="password" value="SD3"></form>', false), '<redacted>');
  assert.equal(maskAttribute('srcdoc', 'see https://u:SD4@x.test/a', false), '<redacted>');
  // A srcdoc inside a srcdoc.
  assert.equal(
    maskAttribute('srcdoc', '<iframe srcdoc="&lt;img src=&quot;/i.png?sig=SD5&quot;&gt;"></iframe>', false),
    '<redacted>'
  );
  // One with nothing to hide prints as it is, and a huge one is hidden unread.
  const plain = '<p class="note">Hello <a href="/help?topic=2">help</a></p>';
  assert.equal(maskAttribute('srcdoc', plain, false), plain);
  assert.equal(maskAttribute('srcdoc', `<p>${'x'.repeat(200000)}</p>`, false), '<redacted>');
});

test('picker: a data: url whose content holds a literal "?" with the rest of its link encoded is masked', () => {
  const encoded = 'data:text/html,%3Ca%20href%3D%22https://x.test/?token%3DDQ1%22%3E';
  assert.equal(maskAttribute('href', encoded, false), 'data:text/html,<redacted>');
  assert.equal(maskAttribute('style', `background: url("${encoded}")`, false), 'background: url("data:text/html,<redacted>")');
  assert.equal(
    maskAttribute('href', 'data:text/html,<a href="https://x.test/?token=DQ2">x</a>', false),
    'data:text/html,<redacted>'
  );
  assert.equal(
    maskMarkup('<a href="data:text/html,%3Ca%20href%3D%22https://x.test/?token%3DDQ3%22%3E">x</a>'),
    '<a href="data:text/html,<redacted>">x</a>'
  );
  // A data: url with a '?' and no secret keeps its content.
  const plain = 'data:text/html,%3Cp%3EWhy?%3C/p%3E';
  assert.equal(maskAttribute('href', plain, false), plain);
});

// R3: safeUrl reads a query pair by pair, and a raw '&' inside a string of
// the JSON (or its &) ended a pair, so the key after it was never read.
test('picker: JSON in a url that a raw "&" cuts into pairs is still judged whole', () => {
  // As outerHTML writes <a href='/cb?s={"user":"a&b","token":"J05"}'>.
  assert.equal(
    maskMarkup('<a href="/cb?s={&quot;user&quot;:&quot;a&amp;b&quot;,&quot;token&quot;:&quot;J05&quot;}">x</a>'),
    '<a href="/cb?s=<redacted>">x</a>'
  );
  assert.equal(maskAttribute('href', '/cb?s={"user":"a\\u0026b","token":"J06"}', false), '/cb?s=<redacted>');
  // Only the JSON goes; the pairs around it stay.
  assert.equal(
    maskAttribute('href', '/cb?a=[1]&s={"user":"a&b","token":"J07"}&z=2', false),
    '/cb?a=[1]&s=<redacted>&z=2'
  );
  // Percent encoded around a raw '&': hidden from its first bracket on.
  assert.equal(maskAttribute('href', '/cb?s=%7B%22user%22%3A%22a&b%22%2C%22token%22%3A%22J08%22%7D', false), '/cb?s=<redacted>');
  // A JavaScript object in single quotes, in a style's url().
  assert.equal(
    maskAttribute('style', `background:url("/a.png?s={'token':'J10'}")`, false),
    'background:url("/a.png?s=<redacted>")'
  );
  // JSON with a '&' and no secret is left as written.
  const plain = '/s?f={"q":"salt & pepper","page":2}';
  assert.equal(maskAttribute('href', plain, false), plain);
});

// R3: JSON in an attribute that holds no url (React on Rails'
// data-react-props, Inertia's data-page) was never screened.
test('picker: JSON in any attribute loses the values of its secret keys, and is otherwise left as written', () => {
  assert.equal(
    maskMarkup('<div data-react-props="{&quot;csrfToken&quot;:&quot;JA01&quot;,&quot;user&quot;:&quot;x&quot;}">p</div>'),
    '<div data-react-props="{&quot;csrfToken&quot;:&quot;<redacted>&quot;,&quot;user&quot;:&quot;x&quot;}">p</div>'
  );
  assert.equal(maskAttribute('data-props', '{"token":"JA02","n":1}', false), '{"token":"<redacted>","n":1}');
  // Nested, with a url holding a secret, and JSON written into a string.
  assert.equal(
    maskAttribute('data-page', '{"props":{"auth":{"user":"JA03"},"next":"/verify?token=JA04"},"cfg":"{\\"apiKey\\":\\"JA05\\"}"}', false),
    '{"props":{"auth":"<redacted>","next":"/verify?token=<redacted>"},"cfg":"{\\"apiKey\\":\\"<redacted>\\"}"}'
  );
  assert.equal(maskAttribute('value', '[{"password":"JA06"}]', false), '[{"password":"<redacted>"}]');
  assert.equal(maskAttribute('data-x', '{"__proto__":{"token":"JA07"},"a":1}', false), '{"__proto__":{"token":"<redacted>"},"a":1}');
  // Something that only looks like JSON, and names a secret key, goes whole.
  assert.equal(maskAttribute('data-x', '{"token": "JA08", oops}', false), '<redacted>');
  // Keys are judged as names, as props are: key and code are no secrets
  // here, and a null or a boolean hides nothing.
  for (const kept of ['{"a": 1, "b": [1, 2]}', '{"key":"item-1","code":"US"}', '{"token":null,"auth":false}', '[1,2,3]', '{not json}']) {
    assert.equal(maskAttribute('data-x', kept, false), kept);
  }
});

test('picker: JSON in an attribute is read within a bound on its size and its cost', () => {
  // Past MAX_JSON_VALUE characters it is hidden unread.
  assert.equal(maskAttribute('data-page', `{"a":"${'x'.repeat(100001)}"}`, false), '<redacted>');
  // More keys and values than MAX_JSON_NODES, nesting deeper than a stack
  // goes, and, not quite JSON, more distinct keys than MAX_JSON_KEYS: each a
  // blob, hidden whole, quickly, and with no throw.
  const wide = `[${'0,'.repeat(25000)}"x"]`;
  const deep = `${'['.repeat(30000)}"x"${']'.repeat(30000)}`;
  const loose = `{${Array.from({ length: 9000 }, (_, i) => `"k${i}": 1`).join(', ')}, oops}`;
  for (const blob of [wide, deep, loose]) {
    let out;
    const took = timed(() => {
      out = maskAttribute('data-x', blob, false);
    }, 200);
    assert.ok(took < 200, `${took} ms for ${blob.length} characters`);
    assert.equal(out, '<redacted>');
  }
});

// r3-T3: a JSON value with a secret key was parsed and written back, so a
// big number lost its digits (the prompt named an id the page never had),
// and the page's spacing and escapes were rewritten.
test('picker: JSON with a secret key is masked where it stands, the rest left as the page wrote it', () => {
  assert.equal(
    maskAttribute('data-props', '{"orderId": 12345678901234567890, "price": 1.50, "csrfToken": "x"}', false),
    '{"orderId": 12345678901234567890, "price": 1.50, "csrfToken": "<redacted>"}'
  );
  assert.equal(
    maskAttribute('data-props', ' {\n  "name": "Caf\\u00e9",\n  "apiKey": {"id": 1e3},\n  "list": [ 1, 2 ]\n} ', false),
    ' {\n  "name": "Caf\\u00e9",\n  "apiKey": "<redacted>",\n  "list": [ 1, 2 ]\n} '
  );
  // A string that changes is written again, and only that string.
  assert.equal(
    maskAttribute('data-page', '{"n": 1.0, "next": "/v?token=T\\u0026step=2", "t": "\\u00e9"}', false),
    '{"n": 1.0, "next": "/v?token=<redacted>&step=2", "t": "\\u00e9"}'
  );
  assert.equal(
    maskMarkup('<div data-props="{&quot;id&quot;: 9007199254740993, &quot;session&quot;: &quot;S&quot;}">x</div>'),
    '<div data-props="{&quot;id&quot;: 9007199254740993, &quot;session&quot;: &quot;<redacted>&quot;}">x</div>'
  );
});

// r3-T3: a JavaScript object in an attribute (Alpine's x-data, keys bare
// or in single quotes) was never screened, so a secret key's value printed.
test('picker: a JavaScript object in an attribute loses the values of its secret keys', () => {
  const cases = [
    ["{ apiToken: 'SECRET2', open: false }", "{ apiToken: '<redacted>', open: false }"],
    ["{'apiKey': 'SECRET3'}", "{'apiKey': '<redacted>'}"],
    ['{password: "S4", show: false}', '{password: "<redacted>", show: false}'],
    ["{ token: $persist('S5').as('t'), n: [1, 2] }", "{ token: '<redacted>', n: [1, 2] }"],
    ["{ user: { pin: 1234 }, items: [{ secret: `S6` }] }", "{ user: { pin: '<redacted>' }, items: [{ secret: `<redacted>` }] }"],
    ["{ password: '', session: null, auth: false }", "{ password: '<redacted>', session: null, auth: false }"],
  ];
  for (const [value, masked] of cases) {
    assert.equal(maskAttribute('x-data', value, false), masked, value);
  }
  assert.equal(
    maskMarkup(`<div x-data="{ apiToken: 'S7', open: false }">x</div>`),
    `<div x-data="{ apiToken: '<redacted>', open: false }">x</div>`
  );
  // A key inside a string is no key, and an object without a secret is left
  // as written; JSON with a secret key written into a string goes whole.
  for (const kept of ["{ label: 'token: abc', open: false }", "{ open: false, toggle() { this.open = !this.open } }", '{ active: on, "is-open": open }']) {
    assert.equal(maskAttribute('x-data', kept, false), kept);
  }
  assert.equal(maskAttribute('x-data', `{ cfg: '{"token":"S8"}' }`, false), '<redacted>');
  // Within a bound: more distinct keys than MAX_JSON_KEYS go whole, quickly.
  const many = `{ ${Array.from({ length: 9000 }, (_, i) => `k${i}: ${i}`).join(', ')} }`;
  let out;
  const took = timed(() => {
    out = maskAttribute('x-data', many, false);
  }, 200);
  assert.ok(took < 200, `${took} ms`);
  assert.equal(out, '<redacted>');
});

// r3-T6 (medium): a custom element password field (<pin-input
// type="password">, whose value React 18 sets as an attribute) printed its
// value in the picked markup and in storage.
test('picker: any element whose type is password loses its value', () => {
  assert.equal(
    maskMarkup('<pin-input type="password" id="rpin" value="PINSECRET31"></pin-input>'),
    '<pin-input type="password" id="rpin" value="<redacted>"></pin-input>'
  );
  const attrs = { type: 'Password', value: 'S' };
  const control = secretControl('x-pw', (name) => attrs[name] ?? null);
  assert.equal(control, true);
  assert.equal(maskAttribute('value', 'S', control), '<redacted>');
  assert.equal(secretControl('x-field', (name) => ({ type: 'text' })[name] ?? null), false);
});

// F20: the picker read JSON in a link with its own copy of the rule, so a
// key whose quotes are escaped or that holds a \u escape, JSON in a data:
// url's content and a data: url that says ;base64 while holding text were
// read in neither place. The rule is now one, in the SECRET URLS block.
test('picker: escaped keys, and JSON or text in a data: url, are read in a picked element\'s links (F20)', () => {
  assert.equal(maskAttribute('href', '/cb?s="{\\"token\\":\\"PF1\\"}"', false), '/cb?s=<redacted>');
  assert.equal(maskAttribute('href', '/cb?s={"\\u0074oken":"PF2"}', false), '/cb?s=<redacted>');
  assert.equal(maskAttribute('href', 'data:application/json,{"a":"b?c","token":"PF3"}', false), 'data:application/json,<redacted>');
  assert.equal(maskAttribute('href', 'data:application/json,%7B%22token%22%3A%22PF4%22%7D', false), 'data:application/json,<redacted>');
  assert.equal(
    maskAttribute('href', 'data:text/html;base64,%3Ca%20href%3D%22https%3A%2F%2Fa.test%2F%3Ftoken%3DPF5%22%3E', false),
    'data:text/html;base64,<redacted>'
  );
  assert.equal(
    maskMarkup('<a href="data:application/json,{&quot;token&quot;:&quot;PF6&quot;}">x</a>'),
    '<a href="data:application/json,<redacted>">x</a>'
  );
  // A srcdoc is hidden whole when anything in it would be.
  assert.equal(maskAttribute('srcdoc', '<script>var cfg = {"token":"PF7"}</script>', false), '<redacted>');
  // Base64 content and JSON with nothing secret are left as written.
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  for (const plain of [png, 'data:application/json,{"name":"x","page":1}', "/s?q=it's%20fine&page=2"]) {
    assert.equal(maskAttribute('href', plain, false), plain);
  }
});

// V1-4: the picker's links and srcdoc read a quoted word before a colon as a
// key anywhere, so a script's case label or ternary hid a document 0.6.0
// printed. A key counts where JSON puts one; one in single quotes or with
// escaped quotes still does.
test('picker: only a key where JSON puts one hides a srcdoc or a data: link (V1-4)', () => {
  const plain = [
    "<script>switch (mode) { case 'code': run(); break; default: stop(); }</script><p>Hello</p>",
    "<script>const store = persist ? 'session' : 'local';</script><p>Hello</p>",
  ];
  for (const doc of plain) {
    assert.equal(maskAttribute('srcdoc', doc, false), doc);
    assert.equal(maskAttribute('href', `data:text/html,${doc}`, false), `data:text/html,${doc}`);
  }
  assert.equal(maskAttribute('srcdoc', "<script>var cfg = {'token':'PV14A'}</script>", false), '<redacted>');
  assert.equal(maskAttribute('href', 'data:application/json,{"a":"{\\"token\\":\\"PV14B\\"}"}', false), 'data:application/json,<redacted>');
});

// V1-7: a pair with no name was skipped, so a url in its value kept its secret.
test('picker: a url in the value of a pair with no name is screened (V1-7)', () => {
  assert.equal(
    maskAttribute('href', 'https://a.test/x?=https://b.test/cb?token=PV17', false),
    'https://a.test/x?=https://b.test/cb?token=<redacted>'
  );
});

// V1-5: letter groups count as one consonant, so a surname with an initial
// keeps its place in a picked link, and a random token still goes.
test('picker: a link\'s user name made of letter groups stays (V1-5)', () => {
  for (const href of ['https://jschmidt@bitbucket.org/team/repo.git', 'ssh://pgsql@db.example.com/app', 'https://armstrong@a.example/']) {
    assert.equal(maskAttribute('href', href, false), href);
  }
  assert.equal(maskAttribute('href', 'https://qmzbtrwhalk@git.example.com/repo', false), 'https://git.example.com/repo');
});

// W1-1: every absolute url in a data: url's content was screened as a url
// again on each decoded layer, so a link of a megabyte of ';x=1' path
// parameters behind an escape encoded six times held the page for 240 ms a
// read, 0.7 s a pick and 3.4 s with five such attributes (0.6.0: 1 ms a read).
// Only the names of its path parameters are read now, once, in the last
// layer: about 25 ms. The limit is three times what a megabyte of plain
// parameters in a link takes on this machine, and at least 100 ms.
test('picker: a megabyte data: link of path parameters behind a layered escape is read in bounded time (W1-1)', () => {
  const plain = `https://a.test/?${'a=1&'.repeat(1 << 18)}`;
  let best = Infinity;
  for (let run = 0; run < 3; run += 1) best = Math.min(best, timed(() => maskAttribute('href', plain, false), 0));
  const limit = Math.max(100, 3 * best);
  const href = `data:,http://h/%2525252525253D${';x=1'.repeat((1 << 18) - 10)}`;
  let out;
  const took = timed(() => {
    out = maskAttribute('href', href, false);
  }, limit);
  assert.ok(took < limit, `${Math.round(took)} ms, over ${Math.round(limit)}`);
  assert.equal(out, href);
  assert.equal(maskAttribute('href', `${href};jsessionid=PW11`, false), 'data:,<redacted>');
});

// W1-4: that url ran on through encodeURI'd markup, whose quotes and spaces
// are %22 and %20, so an entity's ';' and the words up to a later '=' read as
// a secret parameter and hid ordinary html. It ends at a quote, '<', '>' or
// space, raw or encoded, and only a name made of url characters counts.
test('picker: an html data: link with entities and a word before an "=" keeps its content (W1-4)', () => {
  for (const html of [
    '<a href="https://a.test/">Home</a>&nbsp;&middot;&nbsp;Account settings <a href="/settings">open</a>',
    '<a href="https://a.test/help">Help</a><p style="color:red;font-weight:bold">Your account is locked=true</p>',
  ]) {
    const href = `data:text/html,${encodeURI(html)}`;
    assert.equal(maskAttribute('href', href, false), href);
  }
  const src = `data:text/html,${encodeURI('<img src="https://a.test/i.png;jsessionid=PW14">')}`;
  assert.equal(maskAttribute('src', src, false), 'data:text/html,<redacted>');
});

// W1-2: a key counted only with its quote straight after the '{' or ',' and
// white space, so Python's repr of a dict ({u'token': u'…'}, {b'token': …})
// printed in a picked link, which 0.6.0's picker hid. W1-3: JSON all in one
// value was trusted to nestedUrl, which did not decode single quoted keys
// that show only once decoded.
test('picker: keys with a string prefix, or in single quotes that show only once decoded, hide a link (W1-2, W1-3)', () => {
  for (const state of [
    "{u'next': u'/home', u'token': u'PW12A'}",
    "{b'token': b'PW12B'}",
    '{u%27token%27:%20u%27PW12C%27}',
    '{%5C%27token%5C%27:%5C%27PW13A%5C%27}',
    '{%5Cn%27token%27:%27PW13B%27}',
    "{%27token':'PW13C'}",
  ]) {
    assert.equal(maskAttribute('href', `/cb?state=${state}`, false), '/cb?state=<redacted>', state);
  }
  assert.equal(maskMarkup(`<a href="/cb?state={u'token': u'PW12D'}">x</a>`), '<a href="/cb?state=<redacted>">x</a>');
  const doc = "<script>t = x ? u'session' : 2; switch (m) { case 'code': f(); }</script>";
  assert.equal(maskAttribute('srcdoc', doc, false), doc);
});
