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
});

test('picker: the picked element itself is judged by its own attributes', () => {
  const attrs = { type: 'password', name: 'pw' };
  const control = secretControl('input', (name) => attrs[name] ?? null);
  assert.equal(control, true);
  assert.equal(maskAttribute('value', 'hunter2', control), '<redacted>');
  assert.equal(maskAttribute('name', 'pw', control), 'pw');
  assert.equal(secretControl('div', (name) => attrs[name] ?? null), false);
});
