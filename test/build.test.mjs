/**
 * The release tooling: the zip tools/build.mjs writes, the decision
 * tools/release-check.mjs makes for the release workflow, and the parts of
 * the stage and media scripts that a release or a contributor relies on.
 *
 * The build is run as a separate process on a copy of the tree in a temporary
 * folder, the way a person or CI runs it, so the tests see its exit code and
 * its output and never touch this checkout's dist/.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Read with LF. .gitattributes pins only the shipped files and the goldens,
// so a Windows checkout with core.autocrlf on holds the workflows, the tools
// and the docs these tests read with CRLF.
const read = (path) => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');
const buildModule = () => import(pathToFileURL(join(ROOT, 'tools', 'build.mjs')).href);
const SHIPPED = ['manifest.json', 'background.js', 'icons', 'content', 'shared', 'sidepanel', 'LICENSE'];

// Git run for a throwaway repository: none of the machine's own settings (a
// signing key, a hook, a default branch), and none of a CI run's GITHUB_*
// variables, which tools/release-check.mjs would otherwise read as its own.
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GITHUB_') || key.startsWith('GIT_')) delete env[key];
  return {
    ...env,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.test',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.test',
    ...extra,
  };
}

const hasGit = spawnSync('git', ['--version'], { env: cleanEnv() }).status === 0;

function git(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, env: cleanEnv(), encoding: 'utf8', stdio: 'pipe' }).trim();
}

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'punch-list-build-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A copy of what ships, plus the build script, in a folder of its own. */
function copyTree(dir) {
  for (const part of SHIPPED) cpSync(join(ROOT, part), join(dir, part), { recursive: true });
  copyTools(dir);
  return dir;
}

// The packager and what it imports. A file the tree before a change did not
// have yet is skipped, so a test fails on what the build does, not on a copy.
const TOOLS = ['build.mjs', 'deflate.mjs'];
function copyTools(dir, files = TOOLS) {
  mkdirSync(join(dir, 'tools'), { recursive: true });
  for (const file of files) {
    if (existsSync(join(ROOT, 'tools', file))) cpSync(join(ROOT, 'tools', file), join(dir, 'tools', file));
  }
}

function runBuild(dir) {
  const result = spawnSync(process.execPath, [join(dir, 'tools', 'build.mjs')], {
    cwd: dir,
    env: cleanEnv(),
    encoding: 'utf8',
  });
  const out = { status: result.status, output: `${result.stdout}\n${result.stderr}` };
  if (result.status === 0) {
    const name = readdirSync(join(dir, 'dist')).find((file) => file.endsWith('.zip'));
    out.zip = readFileSync(join(dir, 'dist', name));
    out.sha = createHash('sha256').update(out.zip).digest('hex');
  }
  return out;
}

/** The entries of a zip, read from its central directory. */
function unzip(zip) {
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end -= 1;
  assert.ok(end >= 0, 'no end of central directory');
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files = new Map();
  for (let k = 0; k < count; k += 1) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50);
    const method = zip.readUInt16LE(at + 10);
    const packed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extra = zip.readUInt16LE(at + 30);
    const comment = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const payload = zip.subarray(start, start + packed);
    files.set(name, method === 8 ? inflateRawSync(payload) : Buffer.from(payload));
    at += 46 + nameLength + extra + comment;
  }
  return files;
}

// A small extension made up here, so the archive's bytes depend on this file
// and on tools/build.mjs alone. The text is generated to give the compressor
// repeats near and far, and the icon is noise, which is stored rather than
// deflated.
function writeFixture(dir, { crlf = false } = {}) {
  let seed = 20261116;
  const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
  const words = ['const', 'return', 'function', 'await', 'item', 'panel', 'capture', 'state', 'if', 'else', '=>', '{', '}', '(', ')', ';', 'tab', 'mode', 'error', 'console'];
  const prose = (count) =>
    Array.from({ length: count }, (_, k) => {
      const line = Array.from({ length: 4 + Math.floor(random() * 8) }, () => words[Math.floor(random() * words.length)]);
      return `${'  '.repeat(k % 4)}// ${line.join(' ')}`;
    }).join('\n');
  const eol = (text) => (crlf ? text.replace(/\n/g, '\r\n') : text);
  const files = {
    'manifest.json': JSON.stringify(
      {
        manifest_version: 3,
        name: 'Fixture',
        version: '1.2.3',
        background: { service_worker: 'background.js', type: 'module' },
        side_panel: { default_path: 'sidepanel/panel.html' },
        icons: { 16: 'icons/icon16.png' },
        content_scripts: [{ matches: ['<all_urls>'], js: ['content/collector.js'] }],
      },
      null,
      2
    ),
    'background.js': `const SCRIPT = 'content/overlay.js';\n${prose(200)}\nexport { SCRIPT };\n`,
    'content/overlay.js': `(() => {\n${prose(1500)}\n})();\n`,
    'content/collector.js': `(() => {\n${prose(900)}\n})();\n`,
    'shared/lib.js': `export const value = 1;\n${prose(300)}\n`,
    'sidepanel/panel.html':
      '<!doctype html>\n<link rel="stylesheet" href="panel.css">\n<script type="module" src="panel.js"></script>\n',
    'sidepanel/panel.js': `import { value } from '../shared/lib.js';\n${prose(400)}\nexport default value;\n`,
    'sidepanel/panel.css': `body { margin: 0; }\n${prose(50).replace(/\/\/ (.*)/g, '/* $1 */')}\n`,
    LICENSE: 'MIT License\n\nPermission is hereby granted, free of charge.\n',
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), eol(text));
  }
  // Noise, which deflate cannot shrink, so the zip stores this one as it is.
  const noise = Buffer.from(Array.from({ length: 3000 }, () => Math.floor(random() * 256)));
  mkdirSync(join(dir, 'icons'), { recursive: true });
  writeFileSync(join(dir, 'icons', 'icon16.png'), noise);
  copyTools(dir);
  return dir;
}

// ------------------------------------------------------------------ build --

// M11. The MIT license asks for its notice in every copy, and the zip is the
// copy most people install.
test('build: the zip carries LICENSE with the MIT notice', (t) => {
  const result = runBuild(copyTree(scratch(t)));
  assert.equal(result.status, 0, result.output);
  const license = unzip(result.zip).get('LICENSE');
  assert.ok(license, 'LICENSE is not in the zip');
  assert.equal(license.toString('utf8'), read('LICENSE'));
});

// TR5. Node links whichever zlib it was built with, its own or the system's,
// and the two compress the same input to different bytes. The archive's
// bytes are pinned here for a fixed input, so CI on Node 20 and 24 proves the
// checksum no longer moves with the Node that ran the build. A change to the
// zip writer or the compressor changes this hash, and that is the point: it
// changes every release checksum too.
test('build: the archive is the same bytes whatever Node and zlib build it', (t) => {
  const result = runBuild(writeFixture(scratch(t)));
  assert.equal(result.status, 0, result.output);
  assert.equal(result.sha, '1091d998d369fd4a69d2dab5a96264c783df66ad538c8eda6afda08214c8c81f');
  for (const file of TOOLS) {
    const source = existsSync(join(ROOT, 'tools', file)) ? read(`tools/${file}`) : '';
    assert.doesNotMatch(source, /\b(?:deflateRawSync|deflateSync|createDeflateRaw|createDeflate|gzipSync)\b/, `tools/${file} compresses with zlib`);
  }
});

// TR5. A Windows checkout with core.autocrlf on holds every text file with
// CRLF. The archive must still be the one CI built from LF.
test('build: CRLF line endings in the checkout do not change the archive', (t) => {
  const lf = runBuild(writeFixture(scratch(t)));
  const crlf = runBuild(writeFixture(scratch(t), { crlf: true }));
  assert.equal(lf.status, 0, lf.output);
  assert.equal(crlf.status, 0, crlf.output);
  assert.equal(crlf.sha, lf.sha);
});

// TR5, the other half. The build packs LF whatever the checkout holds; the
// attributes make the checkout itself LF too, so loading a Windows checkout
// unpacked runs the same bytes the zip ships. They convert exactly what the
// build converts: a file the build packs byte for byte, git must store and
// check out byte for byte.
test('build: git converts exactly the shipped files the build packs as text', { skip: !hasGit && 'no git' }, async (t) => {
  const { INCLUDE, TEXT_EXTENSIONS, isText } = await buildModule();
  const dir = scratch(t);
  git(dir, 'init', '-q');
  cpSync(join(ROOT, '.gitattributes'), join(dir, '.gitattributes'));
  const names = [];
  for (const top of INCLUDE) {
    if (!statSync(join(ROOT, top)).isDirectory()) {
      names.push(top);
      continue;
    }
    for (const folder of [top, `${top}/deeper/still`]) {
      const extensions = [...TEXT_EXTENSIONS, 'png', 'jpg', 'woff2', 'wasm', 'bin', 'webmanifest', 'map'];
      names.push(...extensions.map((extension) => `${folder}/file.${extension}`), `${folder}/LICENSE`);
    }
  }
  const text = names.filter(isText);
  const asIs = names.filter((name) => !isText(name));
  assert.ok(text.length > 0 && asIs.length > 0);
  const answers = new Set(git(dir, 'check-attr', 'text', 'eol', '--', ...text, ...asIs).split('\n'));
  for (const file of text) {
    assert.ok(answers.has(`${file}: text: set`) && answers.has(`${file}: eol: lf`), `${file} is not kept LF`);
  }
  for (const file of asIs) assert.ok(answers.has(`${file}: text: unset`), `git would convert ${file}`);
});

// What the attributes are for, done for real: a PNG, a font and a file git
// would guess is text, committed from and checked out to a Windows checkout,
// come back as they went in. A plain `text` on sidepanel/ stripped the CR
// from the CR LF in a PNG's first eight bytes, and committed it broken.
test('build: git commits and checks out a binary in a shipped folder unchanged', { skip: !hasGit && 'no git' }, (t) => {
  const dir = scratch(t);
  git(dir, 'init', '-q');
  cpSync(join(ROOT, '.gitattributes'), join(dir, '.gitattributes'));
  const crlf = ['-c', 'core.autocrlf=true', '-c', 'core.eol=crlf'];
  const files = {
    'sidepanel/empty.png': readFileSync(join(ROOT, 'icons', 'icon16.png')),
    'content/fonts/mono.woff2': Buffer.from('wOF2\0\x01\0\0\r\n\r\nglyphs\r\n', 'latin1'),
    // No NUL byte, so git's own guess would call it text.
    'shared/table.bin': Buffer.from('a\r\nb\r\nc\r\n'),
    'sidepanel/panel.js': Buffer.from('one();\r\ntwo();\r\n'),
  };
  for (const [name, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), data);
  }
  git(dir, ...crlf, 'add', '-A');
  for (const [name, data] of Object.entries(files)) {
    const stored = execFileSync('git', ['cat-file', 'blob', `:${name}`], { cwd: dir, env: cleanEnv() });
    const expected = name.endsWith('.js') ? Buffer.from(data.toString('latin1').replace(/\r\n/g, '\n'), 'latin1') : data;
    assert.ok(stored.equals(expected), `${name} was committed as different bytes`);
    rmSync(join(dir, name));
  }
  git(dir, ...crlf, 'checkout', '--', '.');
  for (const [name, data] of Object.entries(files)) {
    const expected = name.endsWith('.js') ? Buffer.from('one();\ntwo();\n') : data;
    assert.ok(readFileSync(join(dir, name)).equals(expected), `${name} was checked out as different bytes`);
  }
});

test('build: two builds of one tree are byte identical', (t) => {
  const dir = writeFixture(scratch(t));
  const first = runBuild(dir);
  const second = runBuild(dir);
  assert.equal(first.status, 0, first.output);
  assert.ok(first.zip.equals(second.zip));
});

// The compressor is written for this repository, so it is held to zlib's
// inflate on inputs that reach every branch: empty, one byte, long runs,
// incompressible data, matches across the window, and the files that ship.
test('build: every deflate stream inflates back to its input', async () => {
  const { deflateRaw } = await import(pathToFileURL(join(ROOT, 'tools', 'deflate.mjs')).href);
  let seed = 7;
  const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
  const bytes = (n, f) => Buffer.from(Array.from({ length: n }, (_, k) => f(k)));
  const block = bytes(800, () => Math.floor(random() * 256));
  const inputs = [
    Buffer.alloc(0),
    Buffer.from('a'),
    Buffer.from('aaaa'),
    Buffer.alloc(300000),
    Buffer.from('ab'.repeat(50000)),
    bytes(70000, (k) => k & 255),
    bytes(100000, () => Math.floor(random() * 256)),
    Buffer.concat([block, bytes(32000, () => Math.floor(random() * 256)), block, block]),
    ...Array.from({ length: 60 }, () => {
      const out = bytes(Math.floor(random() * 4000), () => Math.floor(random() * 6));
      for (let k = 40; k < out.length; k += 1) if (random() < 0.4) out[k] = out[k - 1 - Math.floor(random() * 40)];
      return out;
    }),
  ];
  for (const name of ['shared/prompt-template.js', 'content/collector-main.js', 'icons/icon128.png']) {
    inputs.push(readFileSync(join(ROOT, name)));
  }
  for (const [index, input] of inputs.entries()) {
    assert.ok(inflateRawSync(deflateRaw(input)).equals(input), `input ${index} did not survive`);
  }
});

// The build reads each stream back before writing it, so a compressor that
// produced a stream any inflater rejects, or one that inflates to the wrong
// bytes, stops the release instead of shipping.
test('build: a deflate stream that does not read back fails the build', (t) => {
  const dir = writeFixture(scratch(t));
  // A valid stream of nothing: shorter than any file, so it would be chosen.
  writeFileSync(join(dir, 'tools', 'deflate.mjs'), 'export function deflateRaw() { return Buffer.from([0x03, 0x00]); }\n');
  const result = runBuild(dir);
  assert.notEqual(result.status, 0, 'the build wrote an archive whose entries inflate to nothing');
  assert.match(result.output, /does not inflate back to itself/);
});

// Deflate allows codes of at most 15 bits (7 for the code length tree), and
// an inflater refuses a set of codes that is not complete. Fibonacci weights
// give the deepest possible Huffman tree, far past either limit.
test('build: Huffman code lengths stay within the limit and form a complete code', async () => {
  const { codeLengths } = await import(pathToFileURL(join(ROOT, 'tools', 'deflate.mjs')).href);
  const fibonacci = (n) => {
    const out = [1, 1];
    while (out.length < n) out.push(out.at(-1) + out.at(-2));
    return out;
  };
  for (const [weights, limit] of [
    [fibonacci(30), 15],
    [fibonacci(19), 7],
    [[5, 0, 0, 1], 15],
    [Array.from({ length: 286 }, (_, k) => (k % 7 ? k * k : 0)), 15],
  ]) {
    const lengths = [...codeLengths(weights, limit)];
    weights.forEach((weight, symbol) => assert.equal(lengths[symbol] > 0, weight > 0, `symbol ${symbol}`));
    assert.ok(Math.max(...lengths) <= limit, `a code of ${Math.max(...lengths)} bits, over ${limit}`);
    const kraft = lengths.reduce((sum, length) => sum + (length ? 2 ** -length : 0), 0);
    assert.equal(kraft, 1, 'the code is not complete');
  }
});

// TR6. A local build packed whatever sat in the included folders, so a
// scratch file or an export in content/ went out in a release zip that a
// clean checkout of the same commit did not have.
test('build: a file git does not track is left out, and said so', { skip: !hasGit && 'no git' }, (t) => {
  const dir = copyTree(scratch(t));
  git(dir, 'init', '-q');
  git(dir, 'add', '--', ...SHIPPED, 'tools');
  writeFileSync(join(dir, 'content', 'scratch-notes.js'), '// not for release\n');
  const result = runBuild(dir);
  assert.equal(result.status, 0, result.output);
  const names = [...unzip(result.zip).keys()];
  assert.ok(!names.includes('content/scratch-notes.js'), 'an untracked file was packed');
  assert.ok(names.includes('content/picker.js'));
  assert.match(result.output, /not tracked by git, so not packed: content\/scratch-notes\.js/);
});

// Not every tree is a git checkout (GitHub's source archive, a copy), and the
// build must still work there. It packs what is on disk, and says so.
test('build: a tree that is not a git checkout builds from what is on disk', (t) => {
  const dir = copyTree(scratch(t));
  const result = runBuild(dir);
  assert.equal(result.status, 0, result.output);
  assert.ok(unzip(result.zip).has('content/picker.js'));
  assert.match(result.output, /not a git checkout/);
});

// TR2. The build checked only the paths the manifest names. Each of these
// built clean and broke in Chrome: on a mode button, on opening the panel, or
// on every page.
test('build: what would break in Chrome fails the build', (t) => {
  const dir = copyTree(scratch(t));
  const cases = [
    ['content/overlay.js', (text) => `${text}\n}{\n`, /content\/overlay\.js:\d+ does not parse/],
    ['shared/prompt-template.js', (text) => `${text}\nexport const = ;\n`, /shared\/prompt-template\.js:\d+ does not parse/],
    ['background.js', (text) => text.replaceAll("'content/picker.js'", "'content/pickr.js'"), /background\.js injects "content\/pickr\.js"/],
    ['sidepanel/panel.js', (text) => text.replace("'../shared/prompt-template.js'", "'../shared/prompt-templat.js'"), /sidepanel\/panel\.js imports "\.\.\/shared\/prompt-templat\.js"/],
    ['sidepanel/panel.css', null, /sidepanel\/panel\.html loads "panel\.css"/],
  ];
  for (const [file, change, expected] of cases) {
    const path = join(dir, file);
    const original = readFileSync(path, 'utf8');
    if (change) {
      const changed = change(original);
      assert.notEqual(changed, original, `the ${file} case changed nothing`);
      writeFileSync(path, changed);
    } else {
      rmSync(path);
    }
    const result = runBuild(dir);
    writeFileSync(path, original);
    assert.equal(result.status, 1, `${file}: built clean\n${result.output}`);
    assert.match(result.output, expected);
  }
  assert.equal(runBuild(dir).status, 0, 'the restored tree does not build');
});

// TR2, the imports. The check matched only ./ and ../ paths written with a
// space before the quote, and never asked whether a name imported is one the
// file exports, so each of these built clean and left the panel blank in
// Chrome. The check is now V8's own linking, so every form is read the way
// Chrome reads it, and the forms that work still build.
test('build: an import Chrome cannot link fails the build, however it is written', (t) => {
  const dir = writeFixture(scratch(t));
  const path = join(dir, 'sidepanel', 'panel.js');
  const original = readFileSync(path, 'utf8');
  const line = "import { value } from '../shared/lib.js';";
  const swap = (replacement) => original.replace(line, replacement);
  const broken = [
    ["import { value } from '/shared/lb.js';", /sidepanel\/panel\.js imports "\/shared\/lb\.js", which is not in the build/],
    ["import { value } from 'lib';", /sidepanel\/panel\.js imports "lib", which Chrome cannot resolve/],
    ['import {value} from"../shared/lb.js";', /sidepanel\/panel\.js imports "\.\.\/shared\/lb\.js", which is not in the build/],
    [`${line}\nimport { nothing } from '../shared/lib.js';`, /sidepanel\/panel\.js: .*does not provide an export named 'nothing'/],
    ["import {\n  value,\n  valeu,\n} from '../shared/lib.js';", /sidepanel\/panel\.js: .*does not provide an export named 'valeu'/],
    ["import value from '../shared/lib.js';", /does not provide an export named 'default'/],
    ["import { value } from 'https://example.com/lib.js';", /which is not a file in the extension/],
    [`${line}\nconst loadLater = () => import('./nowhere.js');`, /sidepanel\/panel\.js imports "\.\/nowhere\.js", which is not in the build/],
  ];
  for (const [replacement, expected] of broken) {
    writeFileSync(path, swap(replacement));
    const result = runBuild(dir);
    assert.equal(result.status, 1, `built clean with: ${replacement}\n${result.output}`);
    assert.match(result.output, expected, replacement);
  }
  for (const replacement of [
    line,
    'import {value} from"/shared/lib.js";',
    "import {\n  value as libValue,\n} from '../sidepanel/../shared/lib.js';\nconst value = libValue;",
    "import * as lib from '../shared/lib.js';\nconst { value } = lib;",
  ]) {
    writeFileSync(path, swap(replacement));
    const result = runBuild(dir);
    assert.equal(result.status, 0, `failed with: ${replacement}\n${result.output}`);
  }
});

// R5. The check read import() only with a quoted path, so one written as a
// template or built from parts went unchecked and built clean however broken
// it was, as did any import() in a content script. A template with nothing
// put into it is read like a quoted path; anything else the build cannot
// check fails it.
test('build: an import() whose path the build cannot check fails the build', (t) => {
  const dir = writeFixture(scratch(t));
  const panel = join(dir, 'sidepanel', 'panel.js');
  const original = readFileSync(panel, 'utf8');
  const line = "import { value } from '../shared/lib.js';";
  const unchecked = /sidepanel\/panel\.js:2 calls import\(\) with a path that is not written out, which the build cannot check/;
  const broken = [
    ['const later = () => import(`./nowhere.js`);', /sidepanel\/panel\.js imports "\.\/nowhere\.js", which is not in the build/],
    ["const later = () => import('./no' + 'where.js');", unchecked],
    ['const later = (name) => import(`./${name}.js`);', unchecked],
    ['const later = (path) => import(path);', unchecked],
    ['const later = (path) => import (\n  path\n);', unchecked],
    // T5: a comment between import and its '(' hid the call from the check.
    ["const later = () => import /* lazily */ ('./nowhere.js');", /sidepanel\/panel\.js imports "\.\/nowhere\.js", which is not in the build/],
    ["const later = () => import // lazily\n  ('./nowhere.js');", /sidepanel\/panel\.js imports "\.\/nowhere\.js", which is not in the build/],
    ['const later = (path) => import /* lazily */ (path);', unchecked],
  ];
  for (const [added, expected] of broken) {
    writeFileSync(panel, original.replace(line, `${line}\n${added}`));
    const result = runBuild(dir);
    assert.equal(result.status, 1, `built clean with: ${added}\n${result.output}`);
    assert.match(result.output, expected, added);
  }
  for (const added of [
    'const later = () => import(`../shared/lib.js`);',
    "const later = () => import('../shared/lib.js', { with: {} });",
    // A method of that name is no import, called or defined. T5: the check
    // failed the build on a definition, and on a call split after its '.'.
    "const later = (loader) => loader.import('./nowhere.js');",
    "const later = (loader) => loader.\n  import('./nowhere.js');",
    'const loader = { import(name) { return name; } };',
    'class Loader { static import(name) { return name; } }',
  ]) {
    writeFileSync(panel, original.replace(line, `${line}\n${added}`));
    const result = runBuild(dir);
    assert.equal(result.status, 0, `failed with: ${added}\n${result.output}`);
  }
  writeFileSync(panel, original);
  // A content script is not followed as a module, so no import() in it is checked.
  const overlay = join(dir, 'content', 'overlay.js');
  writeFileSync(overlay, readFileSync(overlay, 'utf8').replace('(() => {', "(() => {\n  import('../shared/lib.js');"));
  const classic = runBuild(dir);
  assert.equal(classic.status, 1, classic.output);
  assert.match(classic.output, /content\/overlay\.js:2 calls import\(\), and the build does not follow content\/overlay\.js as a module/);
});

// TR6. git lists a path in an unresolved merge conflict once for each side,
// and the build packed every line it was given: three copies of a conflicted
// icon, one of them a side of the conflict, and not a word about it. A
// conflict now stops the build, for a binary as for a script.
test('build: a file in an unresolved merge conflict stops the build', { skip: !hasGit && 'no git' }, (t) => {
  const dir = copyTree(scratch(t));
  const icon = join(dir, 'icons', 'icon16.png');
  const original = readFileSync(icon);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-gpg-sign', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'side');
  writeFileSync(icon, Buffer.concat([original, Buffer.from('side')]));
  git(dir, 'commit', '-q', '--no-gpg-sign', '-am', 'side');
  git(dir, 'checkout', '-q', 'main');
  writeFileSync(icon, Buffer.concat([original, Buffer.from('main')]));
  git(dir, 'commit', '-q', '--no-gpg-sign', '-am', 'main');
  const merge = spawnSync('git', ['merge', '-q', '--no-edit', 'side'], { cwd: dir, env: cleanEnv(), encoding: 'utf8' });
  assert.notEqual(merge.status, 0, 'the merge did not conflict');
  assert.match(git(dir, 'status', '--porcelain'), /^(?:UU|AA) icons\/icon16\.png$/m);

  const result = runBuild(dir);
  assert.equal(result.status, 1, result.output);
  const said = result.output.match(/icons\/icon16\.png has an unresolved merge conflict/g) || [];
  assert.equal(said.length, 1, result.output);
  assert.ok(!existsSync(join(dir, 'dist')), 'a zip was written');
});

// ---------------------------------------------------------------- release --

const FACTS = {
  ref: 'refs/heads/main',
  sha: 'c0ffee',
  manifestVersion: '0.6.0',
  packageVersion: '0.6.0',
  tagCommit: null,
  shippedChanged: false,
  releaseExists: false,
};

async function decide(changes) {
  const { decide } = await import(pathToFileURL(join(ROOT, 'tools', 'release-check.mjs')).href);
  return decide({ ...FACTS, ...changes });
}

// TR4. A manual run from main compared "main" with the version and failed,
// always. It now decides as a push to main does: it releases a version that
// has no tag yet, publishes a tag that never got a release, succeeds doing
// nothing on a version released with nothing shipped changed since, and
// fails on one whose shipped files have changed (the test after this one).
test('release: a run from main releases an untagged version and passes on a released one', async () => {
  assert.deepEqual(await decide({}), {
    action: 'publish',
    message: 'v0.6.0 is not tagged yet. Releasing this commit as v0.6.0.',
    tag: 'v0.6.0',
    version: '0.6.0',
    commit: 'c0ffee',
  });
  const released = await decide({ tagCommit: 'beef', releaseExists: true });
  assert.equal(released.action, 'skip');
  const unpublished = await decide({ tagCommit: 'beef' });
  assert.equal(unpublished.action, 'publish');
  assert.equal(unpublished.commit, 'beef', 'a tag that never got a release is built from the tag');
});

// TR7. 0.4.0 named two builds that behaved differently. A version already
// tagged cannot take a change to what ships, from main or from a pull
// request about to merge. R5: a tag with no release was refused as "already
// released", and release.yml said such a tag is released from main. It is
// refused all the same, since the tag names another build of the version,
// and the message says what is known and asks for a bump.
test('release: a change to what ships under a tagged version is refused, released or not', async () => {
  const bump = /Releasing them as 0\.6\.0 would give one version two builds, so bump "version" in manifest\.json and package\.json\./;
  const released = await decide({ tagCommit: 'beef', shippedChanged: true, releaseExists: true });
  assert.equal(released.action, 'fail');
  assert.match(released.message, /^v0\.6\.0 is already released, and the files it ships have changed since the tag\. /);
  assert.match(released.message, bump);
  const unreleased = await decide({ tagCommit: 'beef', shippedChanged: true, releaseExists: false });
  assert.equal(unreleased.action, 'fail');
  assert.match(unreleased.message, /^v0\.6\.0 is tagged but has no release, and the files it ships have changed since the tag\. /);
  assert.match(unreleased.message, bump);
  assert.match(unreleased.message, / To release the build the tag names instead, run the release workflow from v0\.6\.0\.$/);
  // Not known: a pull request's check, which never asks GitHub, and main
  // when GitHub could not answer.
  for (const check of [false, true]) {
    const unknown = await decide({ tagCommit: 'beef', shippedChanged: true, releaseExists: undefined, check });
    assert.equal(unknown.action, 'fail');
    assert.match(unknown.message, /^v0\.6\.0 is already tagged, and the files it ships have changed since the tag\. /);
    assert.match(unknown.message, bump);
  }
  assert.doesNotMatch(unreleased.message + (await decide({ tagCommit: 'beef', shippedChanged: true, check: true, releaseExists: undefined })).message, /already released/);
  assert.equal((await decide({ tagCommit: 'beef', check: true })).action, 'skip');
  assert.equal((await decide({ check: true })).action, 'skip');
});

test('release: a pushed tag must be the version, and versions must agree', async () => {
  const pushed = await decide({ ref: 'refs/tags/v0.6.0', tagCommit: 'c0ffee' });
  assert.equal(pushed.action, 'publish');
  assert.equal((await decide({ ref: 'refs/tags/v0.6.0', tagCommit: 'c0ffee', releaseExists: true })).action, 'skip');
  const wrong = await decide({ ref: 'refs/tags/v0.5.9' });
  assert.equal(wrong.action, 'fail');
  assert.match(wrong.message, /Tag v0\.5\.9 does not match the manifest version 0\.6\.0/);
  assert.equal((await decide({ packageVersion: '0.5.0' })).action, 'fail');
  const branch = await decide({ ref: 'refs/heads/feature' });
  assert.equal(branch.action, 'fail');
  assert.match(branch.message, /Releases are made from main, and this run is on feature/);
});

// The workflows are not pinned to LF, so a Windows checkout holds them with
// CRLF. This failed there once, on a pattern that wanted a bare \n, so it
// is held to both endings here and on every platform.
test('release: the workflows ask tools/release-check.mjs and build what it names', () => {
  for (const eol of ['\n', '\r\n']) {
    const release = read('.github/workflows/release.yml').replace(/\n/g, eol);
    const ci = read('.github/workflows/ci.yml').replace(/\n/g, eol);
    assert.match(release, /workflow_dispatch:/);
    assert.match(release, /branches: \[main\]/);
    assert.match(release, /run: node tools\/release-check\.mjs$/m);
    assert.match(release, /fetch-depth: 0/);
    assert.match(release, /git checkout --detach "\$\{\{ steps\.plan\.outputs\.commit \}\}"/);
    assert.match(release, /tag_name: \$\{\{ steps\.plan\.outputs\.tag \}\}/);
    assert.match(release, /target_commitish: \$\{\{ steps\.plan\.outputs\.commit \}\}/);
    assert.doesNotMatch(release, /GITHUB_REF_NAME/, 'the old tag check is still there');
    for (const step of ['Test', 'Build', 'Publish']) {
      const at = release.indexOf(`- name: ${step}`);
      assert.ok(at !== -1, `release.yml has no ${step} step`);
      assert.match(release.slice(at, at + 200), /if: steps\.plan\.outputs\.publish == 'true'/, `${step} runs without a decision`);
    }
    assert.match(ci, /run: node tools\/release-check\.mjs --check$/m);
    // The header says what decide() does with a tag that has no release.
    const header = release.slice(0, release.indexOf('name: Release')).replace(/\r?\n# ?/g, ' ');
    assert.match(header, /one that is tagged but has no release, from the tag, when nothing it ships has changed since the tag\./);
    assert.match(header, /Once a version is tagged, a change to what it ships fails the run and asks for a version bump, whether or not the tag has a release/);
  }
});

// The tag's own INCLUDE is read from the tag's tools/build.mjs, which in
// 0.5.0 did not export it yet.
test('release: the files a tag shipped are read from the build script it had', async () => {
  const { includeIn } = await import(pathToFileURL(join(ROOT, 'tools', 'release-check.mjs')).href);
  const { INCLUDE } = await buildModule();
  assert.deepEqual(includeIn(read('tools/build.mjs')), INCLUDE);
  const old = "const INCLUDE = [\n  'manifest.json',\n  'background.js',\n  'icons',\n  'content',\n  'shared',\n  'sidepanel',\n];\n";
  assert.deepEqual(includeIn(old), ['manifest.json', 'background.js', 'icons', 'content', 'shared', 'sidepanel']);
  assert.equal(includeIn('export const INCLUDE = listFrom(somewhere);'), null);
});

// The decision above, fed by real git: tags, history and which paths ship.
test('release: tools/release-check.mjs reads the version, the tag and the shipped files from git', { skip: !hasGit && 'no git' }, (t) => {
  const dir = scratch(t);
  const write = (name, text) => {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  };
  const version = (v) => {
    write('manifest.json', JSON.stringify({ manifest_version: 3, version: v }));
    write('package.json', JSON.stringify({ version: v }));
  };
  copyTools(dir, [...TOOLS, 'release-check.mjs']);
  version('0.1.0');
  write('content/a.js', 'one();\n');
  write('README.md', 'Read me.\n');
  write('PRIVACY.md', 'Nothing leaves.\n');
  git(dir, 'init', '-q', '-b', 'main');
  const commit = (message) => {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '--no-gpg-sign', '-m', message);
    return git(dir, 'rev-parse', 'HEAD');
  };
  const check = (args, env = {}) => {
    const output = join(dir, '.output');
    rmSync(output, { force: true });
    const result = spawnSync(process.execPath, [join(dir, 'tools', 'release-check.mjs'), ...args], {
      cwd: dir,
      env: cleanEnv({ GITHUB_OUTPUT: output, ...env }),
      encoding: 'utf8',
    });
    const outputs = existsSync(output)
      ? Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map((line) => line.split('=')))
      : {};
    return { status: result.status, text: `${result.stdout}${result.stderr}`, outputs };
  };

  const first = commit('first');
  assert.equal(check(['--check']).status, 0);
  const fromMain = check([], { GITHUB_REF: 'refs/heads/main' });
  assert.equal(fromMain.status, 0, fromMain.text);
  assert.deepEqual(fromMain.outputs, { publish: 'true', tag: 'v0.1.0', version: '0.1.0', commit: first });

  git(dir, 'tag', 'v0.1.0');
  write('README.md', 'Read me, again.\n');
  commit('docs only');
  assert.equal(check(['--check']).status, 0, 'a change that ships nothing needs no bump');

  // Widening INCLUDE to a file that sat unchanged at the tag changes the zip
  // all the same, though no shipped file's content changed. Only the content
  // was compared, over the new INCLUDE, so this passed.
  const builder = readFileSync(join(dir, 'tools', 'build.mjs'), 'utf8');
  // The copy has whatever line endings this checkout gave tools/build.mjs.
  const widened = builder.replace(/^ {2}'LICENSE',(\r?\n)\];/m, "  'LICENSE',$1  'PRIVACY.md',$1];");
  assert.notEqual(widened, builder, 'INCLUDE is no longer written the way this test expects');
  write('tools/build.mjs', widened);
  commit('ship the privacy policy');
  const wider = check(['--check']);
  assert.equal(wider.status, 1, wider.text);
  assert.match(wider.text, /v0\.1\.0 is already tagged, .*so bump "version"/);
  // From main too, as release.yml runs it. T5: the refusal never asked
  // GitHub, so "tagged but has no release" and its remedy never printed in
  // a real run. A gh on the PATH stands in for the real one, answering as
  // `gh release view` does.
  const bin = join(dir, '.bin');
  mkdirSync(bin);
  const gh = (script) => writeFileSync(join(bin, 'gh'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const fromMainWith = () => check([], { GITHUB_REF: 'refs/heads/main', PATH: `${bin}${delimiter}${process.env.PATH}` });
  gh('echo "release not found" >&2\nexit 1');
  const unreleased = fromMainWith();
  assert.equal(unreleased.status, 1);
  assert.match(unreleased.text, /v0\.1\.0 is tagged but has no release, .*so bump "version"/);
  assert.match(unreleased.text, /To release the build the tag names instead, run the release workflow from v0\.1\.0\./);
  gh('echo \'{"tagName":"v0.1.0"}\'');
  const released = fromMainWith();
  assert.equal(released.status, 1);
  assert.match(released.text, /v0\.1\.0 is already released, .*so bump "version"/);
  // A gh that cannot answer leaves the refusal saying only what git knows.
  gh('echo "gh was asked" >&2\nexit 3');
  const unknown = fromMainWith();
  assert.equal(unknown.status, 1);
  assert.match(unknown.text, /v0\.1\.0 is already tagged, .*so bump "version"/);
  assert.doesNotMatch(unknown.text, /gh was asked/);
  // A change to the build that leaves INCLUDE as it was ships nothing new.
  write('tools/build.mjs', `${builder}\n// a comment\n`);
  commit('narrow it again');
  assert.equal(check(['--check']).status, 0, 'a change to the build alone asked for a bump');

  write('content/a.js', 'two();\n');
  commit('change what ships');
  const refused = check(['--check']);
  assert.equal(refused.status, 1);
  assert.match(refused.text, /v0\.1\.0 is already tagged/);
  assert.equal(fromMainWith().status, 1);

  version('0.2.0');
  const bumped = commit('bump');
  assert.equal(check(['--check']).status, 0);
  assert.equal(check([], { GITHUB_REF: 'refs/heads/main' }).outputs.commit, bumped);
  assert.equal(check([], { GITHUB_REF: 'refs/tags/v0.1.0' }).status, 1);
});

// ------------------------------------------------------------------ stage --

// TR8. The stage simulates closing and reopening the side panel by reloading
// the panel frame. Chrome's download history survives that; the shim's ids
// did not, so a reopened panel's next capture took an id a stored item
// already had, and the stored items' records were gone.
test('stage: download ids and records survive the panel frame reloading', async () => {
  const source = read('tools/chrome-shim.js');
  const stage = {
    storage: {},
    downloads: { records: {}, nextId: 1 },
    downloadsDir: () => '/Users/you/Downloads/',
    saveDelay: () => 0,
    tabUrl: () => 'http://localhost:8000/tools/demo-page.html',
    tabTitle: () => 'Demo',
  };
  const openPanel = () => {
    const window = { parent: { __stage: stage } };
    class XMLHttpRequest {
      open() {}
      send() {
        this.status = 404;
      }
    }
    vm.runInNewContext(source, {
      window,
      document: { baseURI: 'http://localhost:8000/sidepanel/' },
      XMLHttpRequest,
      URL,
      setTimeout,
      clearTimeout,
    });
    return window.chrome;
  };
  const settle = () => new Promise((done) => setTimeout(done, 20));

  const before = openPanel();
  const first = await before.downloads.download({ filename: 'claude-punch-list/one.png' });
  await settle();
  const after = openPanel();
  const second = await after.downloads.download({ filename: 'claude-punch-list/two.png' });
  await settle();
  assert.notEqual(second, first, 'the reopened panel reused a download id');
  const [record] = await after.downloads.search({ id: first });
  assert.equal(record?.state, 'complete');
  assert.equal(record.filename, '/Users/you/Downloads/claude-punch-list/one.png');

  // A discard removes the file and then the record, as in Chrome.
  await after.downloads.removeFile(first);
  assert.equal((await after.downloads.search({ id: first }))[0].exists, false);
  await after.downloads.erase({ id: first });
  assert.equal((await after.downloads.search({ id: first })).length, 0);

  // The stage hands the shim the store this test hands it.
  assert.match(read('tools/panel-stage.html'), /window\.__stage = \{[^}]*\bdownloads,/);
});

// Found while regenerating the README media for 0.6.0: the picker and the
// overlay stop at their first frame when chrome.runtime.id is missing, which
// is how a reloaded extension leaves them, and the demo tab's shim had no id.
// Every pick on the stage then came to nothing, and make-media.mjs timed out.
test('stage: the demo tab shim carries the runtime id the picker and overlay look for', () => {
  for (const file of ['content/picker.js', 'content/overlay.js']) {
    assert.match(read(file), /chrome\.runtime\?\.id/, file);
  }
  const stage = read('tools/panel-stage.html');
  const shim = stage.slice(stage.indexOf('function installDemoShim'));
  assert.match(shim.slice(0, shim.indexOf('onMessage')), /runtime: \{\s*id: '[^']+',/);
});

// TR9. The architecture notes listed two things the stage does not
// reproduce, then five. Each of these is a way the stage differs from Chrome
// that a change can pass on the stage and fail in Chrome.
test('stage: the architecture notes say what the stage does not reproduce', () => {
  const notes = read('docs/ARCHITECTURE.md');
  const section = notes.slice(notes.indexOf('## Running the panel outside Chrome'), notes.indexOf('## Conventions in the code'));
  for (const [what, pattern] of [
    ['late injection', /not at `document_start`/],
    ['no isolated world', /no isolated world/],
    ['messages shared, not serialised', /Chrome serialises every message/],
    ['ids that survive a panel reload', /survive the panel frame\s+reloading/],
    ['uniquify ignored', /`conflictAction: 'uniquify'` is ignored/],
    ['no capture quota', /no capture\s+quota/],
    ['storage in memory', /\*\*Storage\.\*\*/],
    ['no failures', /Chrome's own failures do not happen here/],
    ['fixed panel width', /fixed 380 pixels/],
  ]) {
    assert.match(section, pattern, what);
  }
  assert.doesNotMatch(section, /download ids start again on every reload/);
});

// TR10. The media scripts' own setup notes did not work as written:
// `npm i -D` writes Playwright into package.json, which the same comment says
// it deliberately is not; since Playwright 1.38 that install fetches no
// browser, so launch() failed; and macOS does not ship Pillow.
test('tools: the media scripts say how to set them up without declaring anything', () => {
  const media = read('tools/make-media.mjs');
  const header = media.slice(0, media.indexOf('*/'));
  const commands = [...header.matchAll(/^ \*     (\S.*)$/gm)].map((match) => match[1]);
  assert.ok(commands.length >= 3, 'the header lists no setup commands');
  for (const command of commands) assert.doesNotMatch(command, /npm i(?:nstall)?\b.*(?:-D\b|--save-dev)/, command);
  assert.match(header, /npm install --no-save playwright/);
  assert.match(header, /npx playwright install chromium/);
  assert.match(header, /PLAYWRIGHT_CHANNEL=chrome/);
  const gif = read('tools/make-gif.py');
  assert.doesNotMatch(gif, /which macOS ships with/);
  assert.match(gif, /pip install --user Pillow/);
});
