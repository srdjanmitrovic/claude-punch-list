/**
 * Checks that need no browser: every file the extension names exists, every
 * file parses, and the rules in CONTRIBUTING.md that fail silently in Chrome
 * fail loudly here.
 *
 * `npm run build` validates the paths the manifest names. Everything else
 * below, a typo in an injected script's path, a missing stylesheet, a syntax
 * error, would build clean and break at runtime.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const exists = (path) => existsSync(join(ROOT, path));
const manifest = JSON.parse(read('manifest.json'));

// Content scripts are classic scripts. Everything else Chrome loads is a
// module: the worker is declared `"type": "module"` and the panel loads
// panel.js with `type="module"`.
const CLASSIC = readdirSync(join(ROOT, 'content'))
  .filter((name) => name.endsWith('.js'))
  .map((name) => `content/${name}`);
const MODULES = ['background.js', 'sidepanel/panel.js', 'shared/prompt-template.js'];

test('static: manifest.json and package.json agree on the version', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.version, manifest.version);
});

test('static: every file the manifest names exists', () => {
  const named = [
    manifest.background?.service_worker,
    manifest.side_panel?.default_path,
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
    ...(manifest.content_scripts || []).flatMap((script) => [...(script.js || []), ...(script.css || [])]),
  ].filter(Boolean);
  assert.ok(named.length > 0);
  for (const path of named) assert.ok(exists(path), `manifest names ${path}, which does not exist`);
});

test('static: every script the worker injects exists', () => {
  const injected = [...read('background.js').matchAll(/['"](content\/[\w.-]+\.js)['"]/g)].map((m) => m[1]);
  assert.ok(injected.includes('content/overlay.js') && injected.includes('content/picker.js'));
  for (const path of injected) assert.ok(exists(path), `background.js injects ${path}, which does not exist`);
});

test('static: every file panel.html loads exists', () => {
  const html = read(manifest.side_panel.default_path);
  const base = dirname(manifest.side_panel.default_path);
  const refs = [...html.matchAll(/\b(?:src|href)="([^"#?]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length > 0);
  for (const ref of refs) {
    if (/^[a-z]+:/i.test(ref)) continue;
    assert.ok(exists(join(base, ref)), `${manifest.side_panel.default_path} loads ${ref}, which does not exist`);
  }
});

test('static: every relative import resolves', () => {
  for (const file of MODULES) {
    for (const [, specifier] of read(file).matchAll(/^\s*import\s[^'"]*['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      const target = join(dirname(file), specifier);
      assert.ok(exists(target), `${file} imports ${specifier}, which does not exist`);
    }
  }
});

test('static: content scripts compile as classic scripts', () => {
  for (const file of CLASSIC) {
    assert.doesNotThrow(() => new vm.Script(read(file), { filename: file }), file);
  }
});

test('static: modules parse', () => {
  for (const file of MODULES) {
    assert.doesNotThrow(
      () => execFileSync(process.execPath, ['--check', join(ROOT, file)], { stdio: 'pipe' }),
      file
    );
  }
});

// Without this line DevTools links every console.warn and console.error on
// every page to the collector instead of the page's own code. It is a comment,
// so nothing else would notice it going missing.
test('static: the collector ends with a source map that ignore lists it', () => {
  const lastLine = read('content/collector-main.js').trimEnd().split('\n').at(-1);
  const match = lastLine.match(/^\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)$/);
  assert.ok(match, 'the last line of content/collector-main.js is not an inline source map');
  const map = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
  assert.equal(map.version, 3);
  assert.deepEqual(map.ignoreList, [0]);
  assert.equal(map.sources.length, 1);
});

// The secret name test is written three times, because the collector and the
// picker are injected into the page and cannot import the template. A word
// added to one copy and not the others would leave a value hidden in props
// and printed in markup, or the other way round.
test('static: the copies of the secret name blocks are identical', () => {
  const block = (file, name) => {
    const source = read(file);
    const begin = source.indexOf(`// ${name} BEGIN`);
    const end = source.indexOf(`// ${name} END`);
    assert.ok(begin !== -1 && end > begin, `${file} has no ${name} block`);
    // The injected copies sit one level in, inside their wrapper; that
    // indentation is all that may differ.
    const dedent = file.startsWith('content/');
    return source
      .slice(begin, end)
      .split('\n')
      .map((line) => (dedent ? line.replace(/^ {2}/, '') : line))
      .join('\n');
  };
  const template = block('shared/prompt-template.js', 'SECRET NAMES');
  assert.equal(block('content/collector-main.js', 'SECRET NAMES'), template);
  assert.equal(block('content/picker.js', 'SECRET NAMES'), template);
  assert.equal(
    block('content/picker.js', 'SECRET URLS'),
    block('shared/prompt-template.js', 'SECRET URLS')
  );
});

// test/picker.test.mjs runs the masking block on its own, so it cannot see
// the picker stop calling it, or a copy of the word list emptied after the
// block that the sync check above compares.
test('static: the picker masks what it sends, and nothing rewrites the secret words', () => {
  const source = read('content/picker.js');
  const body = (name) => {
    const from = source.indexOf(`    function ${name}(`);
    assert.ok(from !== -1, `content/picker.js has lost ${name}()`);
    return source.slice(from, source.indexOf('\n    }\n', from));
  };
  assert.match(body('markup'), /maskMarkup\(raw\)/);
  assert.match(body('attributes'), /maskAttribute\(/);
  assert.match(source, /inlineStyle: maskAttribute\('style'/);
  assert.match(source, /text: visibleText\(element\)/);
  for (const file of ['content/picker.js', 'content/collector-main.js', 'shared/prompt-template.js']) {
    const text = read(file);
    const after = text.slice(text.indexOf('SECRET NAMES END'));
    assert.doesNotMatch(after, /SECRET_WORDS\s*(?:\.|\[|=)/, `${file} changes SECRET_WORDS after its block`);
  }
});

// Chrome runs these again, in the same world, every time a capture mode is
// armed. A top level const, let or class from the first run is still declared
// when the second arrives, and the second run throws before doing anything.
// Two copies in one script fail to compile for exactly the same reason.
test('static: re-injected capture scripts declare nothing a second run would redeclare', () => {
  for (const file of ['content/overlay.js', 'content/picker.js']) {
    const source = read(file);
    assert.doesNotThrow(
      () => new vm.Script(`${source}\n;\n${source}`, { filename: file }),
      `${file} declares something at the top level with const, let or class`
    );
  }
});
