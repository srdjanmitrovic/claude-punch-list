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

const { maskMarkup, maskAttribute, secretControl } = new Function(
  [
    between('// SECRET NAMES BEGIN', '// SECRET NAMES END'),
    between('// SECRET URLS BEGIN', '// SECRET URLS END'),
    between('// MASKING BEGIN', '// MASKING END'),
    'return { maskMarkup, maskAttribute, secretControl };',
  ].join('\n')
)();

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
  const MAX_HTML = Number(/const MAX_HTML = (\d+);/.exec(SOURCE)[1]);
  const body = SOURCE.slice(
    SOURCE.indexOf('    // The opening tag at the start of outerHTML.'),
    SOURCE.indexOf('    function styles(element) {')
  );
  const markup = new Function(
    'maskMarkup',
    `const MAX_HTML = ${MAX_HTML};\n${body}\nreturn markup;`
  )(maskMarkup);
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
    const started = performance.now();
    maskAttribute('style', hostile, false);
    assert.ok(performance.now() - started < 250, `${hostile.slice(0, 12)}… took ${Math.round(performance.now() - started)} ms`);
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
  const visibleText = new Function(
    'secretTextarea',
    'document',
    'NodeFilter',
    `${SOURCE.slice(SOURCE.indexOf('    function visibleText(element) {'), SOURCE.indexOf('    // The opening tag at the start of outerHTML.'))}\nreturn visibleText;`
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
