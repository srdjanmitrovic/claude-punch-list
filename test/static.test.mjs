/**
 * Checks that need no browser: every file the extension names exists, every
 * file parses, and the rules in CONTRIBUTING.md that fail silently in Chrome
 * fail loudly here.
 *
 * `npm run build` makes the same checks on what it packs, which is what git
 * tracks. These make them on the working tree, so a typo in an injected
 * script's path, a missing stylesheet or a syntax error fails here before
 * anything is committed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Read with LF, as the build packs it, whatever line endings the checkout has.
const read = (path) => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');
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

// The panel injects the page shot's script itself (capturePage), by the same
// kind of path, which nothing else asks for until Page is pressed.
test('static: every script the panel injects exists', () => {
  const injected = [...read('sidepanel/panel.js').matchAll(/['"](content\/[\w.-]+\.js)['"]/g)].map((m) => m[1]);
  assert.ok(injected.includes('content/page-shot.js'));
  for (const path of injected) assert.ok(exists(path), `sidepanel/panel.js injects ${path}, which does not exist`);
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

// The build's own check, on the working tree: V8 parses and links the
// modules (never runs them), so an import written without spaces, with a
// path from the root, or of a name the file does not export fails here as it
// fails in Chrome. A pattern over the text saw only the first of these, and
// only with a space before the quote.
test('static: every import names a file, and every name imported is one it exports', async () => {
  const { checkImports, INCLUDE } = await import(pathToFileURL(join(ROOT, 'tools', 'build.mjs')).href);
  const walk = (path) =>
    statSync(join(ROOT, path)).isDirectory()
      ? readdirSync(join(ROOT, path)).flatMap((name) => walk(`${path}/${name}`))
      : [path];
  const entries = INCLUDE.filter(exists)
    .flatMap(walk)
    .map((name) => ({ name, data: readFileSync(join(ROOT, name)) }));
  const roots = [manifest.background.service_worker, 'sidepanel/panel.js'];
  const { problems, modules } = checkImports(entries, roots);
  assert.deepEqual(problems, []);
  for (const file of MODULES) assert.ok(modules.includes(file), `${file} is not reached from ${roots.join(' or ')}`);
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
  // markup() prints only from the masked start of outerHTML, so reading
  // innerHTML again would be a way round the masking.
  assert.match(body('markup'), /maskedStart\(raw, /);
  assert.doesNotMatch(body('markup'), /innerHTML/);
  const returns = [...body('maskedStart').matchAll(/return ([^;]+);/g)].map((match) => match[1]);
  assert.ok(returns.length > 0 && returns.every((value) => /^maskMarkup\(|^masked$/.test(value)), returns.join(', '));
  assert.match(body('maskedStart'), /const masked = maskMarkup\(/);
  assert.match(body('attributes'), /maskAttribute\(/);
  // The inline style travels only inside the masked markup. It was once sent
  // a second time as a field of its own, uncapped, that nothing read.
  assert.doesNotMatch(source, /inlineStyle:/);
  assert.match(source, /text: visibleText\(element\)/);
  for (const file of ['content/picker.js', 'content/collector-main.js', 'shared/prompt-template.js']) {
    const text = read(file);
    const after = text.slice(text.indexOf('SECRET NAMES END'));
    assert.doesNotMatch(after, /SECRET_WORDS\s*(?:\.|\[|=)/, `${file} changes SECRET_WORDS after its block`);
  }
});

// Chrome runs these again, in the same world, every time a capture mode is
// armed (the page shot's, every time Page is pressed). A top level const, let
// or class from the first run is still declared when the second arrives, and
// the second run throws before doing anything. Two copies in one script fail
// to compile for exactly the same reason.
test('static: re-injected capture scripts declare nothing a second run would redeclare', () => {
  for (const file of ['content/overlay.js', 'content/picker.js', 'content/page-shot.js']) {
    const source = read(file);
    assert.doesNotThrow(
      () => new vm.Script(`${source}\n;\n${source}`, { filename: file }),
      `${file} declares something at the top level with const, let or class`
    );
  }
});

// A Chrome Web Store listing needs a privacy policy that stands alone and a
// line saying the extension is not Anthropic's. Both live in PRIVACY.md, and
// the README points at it, so the policy cannot drift out of reach unnoticed.
test('static: PRIVACY.md says what is read and kept, that nothing leaves, and who it is not', () => {
  assert.ok(exists('PRIVACY.md'), 'there is no PRIVACY.md');
  const policy = read('PRIVACY.md');
  assert.match(policy, /nothing leaves your computer/i);
  assert.match(policy, /makes no network requests/);
  assert.match(policy, /not affiliated with, endorsed by\s+or sponsored by Anthropic/);
  for (const place of ['Downloads', 'chrome.storage.local', 'clipboard']) assert.ok(policy.includes(place), place);
  // Every permission the manifest asks for is explained there.
  for (const permission of manifest.permissions) assert.ok(policy.includes(`\`${permission}\``), permission);
  assert.match(read('README.md'), /\]\(PRIVACY\.md\)/);
});
