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
  assert.equal(secretControl('div', (name) => attrs[name] ?? null), false);
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
