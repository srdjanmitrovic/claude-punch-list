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
import { execFileSync, spawn, spawnSync } from 'node:child_process';
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
  utimesSync,
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

// A build of the real tree takes under a fifth of a second here, and a CI
// runner is three to four times slower, so a build that takes a minute is
// stuck. Its stdin is not connected: data handed to a child on stdin through
// spawnSync now and then never arrived on macOS. W6-F4: the build's own limit
// for each child it starts is a quarter of this, so a stuck child is stopped
// by the build, which then removes its temporary folder, before this limit
// kills the build and leaves both.
const BUILD_LIMIT_MS = 60_000;

function runBuild(dir, { env = {}, timeout = BUILD_LIMIT_MS } = {}) {
  const result = spawnSync(process.execPath, [join(dir, 'tools', 'build.mjs')], {
    cwd: dir,
    env: cleanEnv({ BUILD_CHECK_TIMEOUT_MS: String(BUILD_LIMIT_MS / 4), ...env }),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    killSignal: 'SIGKILL',
  });
  const stopped = result.error?.code === 'ETIMEDOUT' ? `\nthe build did not finish within ${timeout / 1000} s, so it was stopped` : '';
  const out = { status: result.status, output: `${result.stdout}\n${result.stderr}${stopped}` };
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
// bytes are pinned here for a fixed input, so CI on Node 22 and 24 proves the
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

// A module preloaded into the build and every Node it starts, through
// NODE_OPTIONS, which a child inherits.
function preload(dir, name, lines) {
  const path = join(dir, name);
  writeFileSync(path, `${lines.join('\n')}\n`);
  return `--import=${pathToFileURL(path).href}`;
}

// V6-1. The build handed the import check every file, and Node's syntax check
// each module, on stdin through spawnSync's `input`. Now and then on macOS
// the child waited on that pipe for good, and the build with it: a few
// children in a thousand with six builds at once, which failed this file's
// tests at random. Each child now reads a file, and its stdin is not
// connected. Seen from inside each child the build starts, for a build that
// passes and for one whose module Node is asked about.
test('build: no child of the build is handed its input through a pipe', (t) => {
  const dir = writeFixture(scratch(t));
  const log = join(dir, 'stdin.log');
  const env = {
    STDIN_LOG: log,
    NODE_OPTIONS: preload(dir, 'stdin-probe.mjs', [
      "import { appendFileSync, fstatSync } from 'node:fs';",
      'const stdin = fstatSync(0);',
      'const args = [...process.execArgv, ...process.argv.slice(2)];',
      'const record = { pid: process.pid, ppid: process.ppid, args, pipe: stdin.isFIFO() || stdin.isSocket() };',
      'appendFileSync(process.env.STDIN_LOG, `${JSON.stringify(record)}\\n`);',
    ]),
  };
  const children = () => {
    const records = readFileSync(log, 'utf8').trim().split('\n').map((text) => JSON.parse(text));
    rmSync(log);
    const build = records.find((record) => record.ppid === process.pid);
    assert.ok(build, 'the build did not run with the probe');
    return records.filter((record) => record.ppid === build.pid);
  };

  const clean = runBuild(dir, { env });
  assert.equal(clean.status, 0, clean.output);
  const started = children();
  assert.ok(started.some((child) => child.args.includes('--link')), JSON.stringify(started));
  for (const child of started) assert.equal(child.pipe, false, `stdin is a pipe in ${child.args.join(' ')}`);

  const lib = join(dir, 'shared', 'lib.js');
  writeFileSync(lib, `${readFileSync(lib, 'utf8')}\nexport const = ;\n`);
  const broken = runBuild(dir, { env });
  assert.equal(broken.status, 1, broken.output);
  assert.match(broken.output, /shared\/lib\.js:\d+ does not parse: SyntaxError/);
  const asked = children();
  assert.ok(asked.some((child) => child.args.includes('--check')), JSON.stringify(asked));
  for (const child of asked) assert.equal(child.pipe, false, `stdin is a pipe in ${child.args.join(' ')}`);
});

// V6-1 and V6-6. A child that never answers is stopped, Node's syntax check
// of a module (which had no limit at all) as well as the import check, and
// the build says which in words. It said "spawnSync <path to node>
// ETIMEDOUT". Each child may take ten times what a whole build takes on this
// machine, and at least two seconds.
test('build: a check that never answers is stopped, and the build says which', (t) => {
  const dir = writeFixture(scratch(t));
  const started = performance.now();
  const plain = runBuild(dir);
  assert.equal(plain.status, 0, plain.output);
  const limit = Math.max(2000, Math.ceil((10 * (performance.now() - started)) / 100) * 100);
  const seconds = String(limit / 1000).replace('.', '\\.');
  const pidFile = join(dir, 'hung.pid');
  const hang = preload(dir, 'hang.mjs', [
    "import { writeFileSync } from 'node:fs';",
    'if ([...process.execArgv, ...process.argv].includes(process.env.HANG_ON)) {',
    '  writeFileSync(process.env.HANG_PID, String(process.pid));',
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);',
    '}',
  ]);
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // A child the build leaves running (one with no limit is, once this test
  // stops the build) is stopped here.
  const leftRunning = [];
  t.after(() => {
    for (const pid of leftRunning) if (alive(pid)) process.kill(pid, 'SIGKILL');
  });
  const hangOn = (flag) => {
    rmSync(pidFile, { force: true });
    const env = { NODE_OPTIONS: hang, HANG_ON: flag, HANG_PID: pidFile, BUILD_CHECK_TIMEOUT_MS: String(limit) };
    const result = runBuild(dir, { env, timeout: 20 * limit });
    assert.ok(existsSync(pidFile), `no child was started with ${flag}\n${result.output}`);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    if (alive(pid)) leftRunning.push(pid);
    return { ...result, pid };
  };

  const link = hangOn('--link');
  assert.equal(link.status, 1, link.output);
  assert.match(link.output, new RegExp(`the import check did not finish within ${seconds} s, so it was stopped`));
  assert.doesNotMatch(link.output, /ETIMEDOUT|does not parse/);
  assert.ok(!alive(link.pid), 'the import check was left running');

  const lib = join(dir, 'shared', 'lib.js');
  writeFileSync(lib, `${readFileSync(lib, 'utf8')}\nexport const = ;\n`);
  const syntax = hangOn('--check');
  assert.equal(syntax.status, 1, syntax.output);
  assert.match(syntax.output, new RegExp(`the syntax check of shared/lib\\.js did not finish within ${seconds} s, so it was stopped`));
  assert.ok(!alive(syntax.pid), 'the syntax check was left running');
});

// W6-F4. A build stopped by a signal (Ctrl+C, a kill) never reaches the
// finally that removes its temporary folder, which holds a copy of every
// script. Each build now removes the folders such builds left once they are
// an hour old, and leaves younger ones, which may be a running build's, and
// any folder it did not name.
test('build: a build removes the temporary folders of builds stopped an hour ago', (t) => {
  const dir = writeFixture(scratch(t));
  const temp = scratch(t);
  const left = ['punch-list-build-Old123', 'punch-list-build-New456', 'punch-list-build-notours'];
  for (const name of left) {
    mkdirSync(join(temp, name));
    writeFileSync(join(temp, name, 'input.json'), '{}');
  }
  const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
  for (const name of [left[0], left[2]]) utimesSync(join(temp, name), twoHoursAgo, twoHoursAgo);
  const result = runBuild(dir, { env: { TMPDIR: temp, TMP: temp, TEMP: temp } });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(readdirSync(temp).sort(), [left[1], left[2]].sort());
});

// W6-F5. A temporary folder the build could not make (TMPDIR names no
// folder) or write (a full disk) crashed it with an uncaught stack. It now
// says which check could not run, and removes what it made.
test('build: a temp directory the build cannot use fails it in words', (t) => {
  const dir = writeFixture(scratch(t));
  const missing = join(dir, 'no-such-folder');
  const lost = runBuild(dir, { env: { TMPDIR: missing, TMP: missing, TEMP: missing } });
  assert.equal(lost.status, 1, lost.output);
  assert.match(lost.output, /the import check could not run: ENOENT/);
  assert.match(lost.output, /the syntax check of shared\/lib\.js could not run: ENOENT/);
  assert.doesNotMatch(lost.output, /^\s+at /m);

  const full = preload(dir, 'full.mjs', [
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    'const write = fs.writeFileSync;',
    'fs.writeFileSync = function (path, ...rest) {',
    "  if (String(path).endsWith(process.env.FULL_ON)) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });",
    '  return write.call(this, path, ...rest);',
    '};',
    'syncBuiltinESMExports();',
  ]);
  const lib = join(dir, 'shared', 'lib.js');
  writeFileSync(lib, `${readFileSync(lib, 'utf8')}\nexport const = ;\n`);
  for (const [file, expected] of [
    ['input.json', /the import check could not run: ENOSPC/],
    ['module.mjs', /the syntax check of shared\/lib\.js could not run: ENOSPC/],
  ]) {
    const temp = scratch(t);
    const result = runBuild(dir, { env: { NODE_OPTIONS: full, FULL_ON: file, TMPDIR: temp, TMP: temp, TEMP: temp } });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, expected);
    assert.doesNotMatch(result.output, /^\s+at /m);
    assert.deepEqual(readdirSync(temp), [], `the build left its folder, writing ${file}`);
  }
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
    // The panel injects the page shot itself, so a renamed file would only
    // fail when someone pressed Page.
    ['sidepanel/panel.js', (text) => text.replaceAll("'content/page-shot.js'", "'content/page-shots.js'"), /sidepanel\/panel\.js injects "content\/page-shots\.js"/],
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

// F54. The import() check read the text alone. A method named import whose
// parameters held a '(' or a line break, a method call with a comment between
// its '.' and import, import( in a string, a comment, a template or a regular
// expression, and an import() with a comment before or after its path each
// failed the build, and an import() spread into an object (...import(path))
// was taken for a method and built clean however broken it was. V8 now says
// which of them are imports.
//
// V6-2, V6-3 and V6-4, found checking that. A line comment ended only at \n,
// while JavaScript also ends one at \r, U+2028 and U+2029: a computed path
// read as the literal before such a comment, and built clean while Chrome
// loaded another file, and an import split from its '(' by one was not found
// at all, nor one split by a classic script's HTML-like comment. A private
// method named #import that its class called failed the build.
const LINE_ENDS = { LS: '\u2028', PS: '\u2029', CR: '\r' };
test('build: only what V8 parses as an import() is checked as one', (t) => {
  const dir = writeFixture(scratch(t));
  const panel = join(dir, 'sidepanel', 'panel.js');
  const original = readFileSync(panel, 'utf8');
  const line = "import { value } from '../shared/lib.js';";
  const clean = [
    'const loader = { import(name = String(1)) { return name; } };',
    'const other = {\n  import(\n    name,\n  ) {\n    return name;\n  },\n};',
    "const later = (it) => it./* lazily */import('./nowhere.js');",
    `const help = "call import('./nowhere.js') to load it later";`,
    "// import('./nowhere.js') would load it later",
    '/* import(path) */',
    "const shown = `import('./nowhere.js')`;",
    String.raw`const pattern = /import\('\.\/nowhere\.js'\)/;`,
    "const lazy = () => import(/* lazily */ '../shared/lib.js' /* once */);",
    "const lazier = () => import(\n  // later\n  '../shared/lib.js',\n);",
    "class Loader { #import(name) { return name; } load() { return this.#import('./nowhere.js'); } }",
    ...Object.entries(LINE_ENDS).map(([name, end]) => `const after${name} = () => import(// later${end}'../shared/lib.js');`),
  ];
  writeFileSync(panel, original.replace(line, [line, ...clean].join('\n')));
  const overlay = join(dir, 'content', 'overlay.js');
  const script = readFileSync(overlay, 'utf8');
  writeFileSync(overlay, script.replace('(() => {', `(() => {\n  const help = 'import("../shared/lib.js")';\n  // import(later)`));
  const built = runBuild(dir);
  assert.equal(built.status, 0, built.output);
  writeFileSync(overlay, script);

  const nowhere = /sidepanel\/panel\.js imports "\.\/nowhere\.js", which is not in the build/;
  const computed = /sidepanel\/panel\.js:2 calls import\(\) with a path that is not written out/;
  for (const [added, expected] of [
    ["const later = () => ({ ...import('./nowhere.js') });", nowhere],
    ["const later = () => import(/* lazily */ './nowhere.js');", nowhere],
    [`const later = (path) => [import(path), "import('./nowhere.js')"];`, computed],
    ...Object.values(LINE_ENDS).flatMap((end) => [
      // Chrome loads lib.js.map, and ./nowhere.js.
      [`const later = () => import('../shared/lib.js' // map${end}+ '.map'\n);`, computed],
      [`const later = () => import(// first${end}'./nowhere.js' ||\n'../shared/lib.js');`, computed],
      [`const later = () => import // later${end}('./nowhere.js');`, nowhere],
    ]),
    // W6-F1: a match from an earlier `import` ran on to the next line's '('
    // or to the next */, through the real import(), which was then never
    // tried: `obj.import-->0` is `-- > 0`, and the others are strings.
    ["const probe = (obj) => obj.import-->0 || import('./nowhere.js');\n(() => {})();", nowhere],
    ["const hint = \"import // see docs\"; const lazy = () => import('./nowhere.js');\n(() => {})();", nowhere],
    ["const glob = \"import /*\"; const lazy = () => import('./nowhere.js');\n/* later */ (() => {})();", nowhere],
  ]) {
    writeFileSync(panel, original.replace(line, `${line}\n${added}`));
    const result = runBuild(dir);
    assert.equal(result.status, 1, `built clean with: ${JSON.stringify(added)}\n${result.output}`);
    assert.match(result.output, expected, JSON.stringify(added));
    assert.equal(result.output.match(/sidepanel\/panel\.js/g).length, 1, result.output);
  }
  writeFileSync(panel, original);

  // A content script is not followed as a module, so each import() in it
  // fails the build, wherever its comments are.
  for (const added of [
    "import <!-- later\n('../shared/lib.js');",
    "import\n--> later\n('../shared/lib.js');",
    `import // later${LINE_ENDS.LS}(chrome.runtime.getURL('x.js'));`,
    `import // later${LINE_ENDS.CR}('../shared/lib.js');`,
    "void function (obj) { return obj.import-->0 || import(chrome.runtime.getURL('x.js')); };\n(() => {})();",
  ]) {
    writeFileSync(overlay, script.replace('(() => {', `(() => {\n  ${added}`));
    const result = runBuild(dir);
    assert.equal(result.status, 1, `built clean with: ${JSON.stringify(added)}\n${result.output}`);
    assert.match(result.output, /content\/overlay\.js:2 calls import\(\), and the build does not follow content\/overlay\.js as a module/);
  }
});

// V6-5. Node 24 parses a source phase import (import source x from, and
// import.source()), which Chrome 156 refuses as a SyntaxError, so a panel that
// used one built clean on the Node the release is built with and never
// loaded. Phase imports, the source and the defer phase, now fail the build
// on any Node: in V8's words where it parses them (a static import's phase),
// and otherwise by finding import.source and import.defer in the code.
const parsesSourcePhase = (() => {
  try {
    new vm.Script("import.source('./x.wasm');");
    return true;
  } catch {
    return false;
  }
})();
test('build: a phase import fails the build, on a Node that parses it or not', (t) => {
  const dir = writeFixture(scratch(t));
  const panel = join(dir, 'sidepanel', 'panel.js');
  const original = readFileSync(panel, 'utf8');
  const line = "import { value } from '../shared/lib.js';";
  // Only mentioned: these build.
  writeFileSync(panel, original.replace(line, [line, `const help = "import.source('./x.wasm') loads its source";`, '// import.defer(later)', 'const meta = import.meta.url;'].join('\n')));
  const mentioned = runBuild(dir);
  assert.equal(mentioned.status, 0, mentioned.output);

  const phase = (word) => new RegExp(`sidepanel/panel\\.js:2 calls import\\.${word}\\(\\), a phase import Chrome does not support`);
  for (const [added, expected] of [
    ["const wasm = () => import.source('../shared/lib.js');", phase('source')],
    ["const wasm = () => import /* now */ . source('../shared/lib.js');", phase('source')],
    ["const later = () => import.defer('../shared/lib.js');", phase('defer')],
    [
      "import source wasm from '../shared/lib.js';",
      parsesSourcePhase
        ? /sidepanel\/panel\.js imports "\.\.\/shared\/lib\.js" with import source, a phase import Chrome does not support/
        : /sidepanel\/panel\.js:2 does not parse/,
    ],
  ]) {
    writeFileSync(panel, original.replace(line, `${line}\n${added}`));
    const result = runBuild(dir);
    assert.equal(result.status, 1, `built clean with: ${added}\n${result.output}`);
    assert.match(result.output, expected, added);
  }
  writeFileSync(panel, original);

  // W6-F2: in a module nothing imports, the static form built clean on Node
  // 24, whose V8 parses it, and failed on Node 22, whose V8 does not.
  const unused = join(dir, 'shared', 'unused.js');
  writeFileSync(unused, "import source wasm from './nowhere.wasm';\nexport default wasm;\n");
  const unfollowed = runBuild(dir);
  rmSync(unused);
  assert.equal(unfollowed.status, 1, unfollowed.output);
  assert.match(
    unfollowed.output,
    parsesSourcePhase
      ? /shared\/unused\.js imports "\.\/nowhere\.wasm" with import source, a phase import Chrome does not support/
      : /shared\/unused\.js:1 does not parse/
  );

  const overlay = join(dir, 'content', 'overlay.js');
  writeFileSync(overlay, readFileSync(overlay, 'utf8').replace('(() => {', "(() => {\n  import.source('../shared/lib.js');"));
  const classic = runBuild(dir);
  assert.equal(classic.status, 1, classic.output);
  assert.match(classic.output, /content\/overlay\.js:2 calls import\.source\(\), a phase import Chrome does not support/);
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

// Node 20 reached its end of life in April 2026. CI tests the lines still
// supported, the oldest of them is the one package.json asks for, and the
// version check and the release build run on the newest.
test('release: CI tests the Node versions package.json allows, and releases on the newest', () => {
  const ci = read('.github/workflows/ci.yml');
  const release = read('.github/workflows/release.yml');
  const matrix = JSON.parse(/^\s*node: (\[[^\]\n]*\])$/m.exec(ci)?.[1] ?? '[]').map(Number);
  assert.ok(matrix.length, 'ci.yml has no Node matrix');
  const floor = Number(/^>=(\d+)$/.exec(JSON.parse(read('package.json')).engines?.node ?? '')?.[1]);
  assert.equal(floor, Math.min(...matrix), 'package.json allows a Node that CI does not test, or CI tests one it does not allow');
  assert.ok(floor >= 22, `Node ${floor} is past its end of life`);
  const pinned = [...`${ci}\n${release}`.matchAll(/node-version: "(\d+)"/g)].map((match) => Number(match[1]));
  assert.equal(pinned.length, 2, 'the version check and the release build no longer name their Node');
  for (const version of pinned) assert.equal(version, Math.max(...matrix), `a workflow runs on Node ${version}`);
});

// A step that hangs fails its job within minutes rather than at GitHub's
// limit of six hours. The build's own children and the release check's git
// and gh calls have limits of their own, tested above and below.
test('release: every workflow job has a time limit', () => {
  for (const name of ['ci.yml', 'release.yml']) {
    const text = read(`.github/workflows/${name}`);
    const jobs = text.match(/^    runs-on: .*$/gm) ?? [];
    const limits = text.match(/^    timeout-minutes: \d+$/gm) ?? [];
    assert.ok(jobs.length, `${name} has no job`);
    assert.equal(limits.length, jobs.length, `a job in ${name} has no timeout-minutes`);
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
      stdio: ['ignore', 'pipe', 'pipe'],
      // A run takes a tenth of a second here; one that takes a minute is stuck.
      timeout: 60_000,
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

// F59. Each git and gh call waited as long as it took, so a hung one held the
// release workflow until GitHub's own job limit. Each is now stopped after a
// limit (a minute, and two seconds here), and the run fails naming it, the
// tag lookup as well as the question to GitHub. V6-7: only the call itself
// was stopped, and what it had started ran on (a gh can start git, and git
// its helpers), and the failure printed as an uncaught exception with a
// stack. The stand-ins here wait on a child of their own.
const shell = (!hasGit && 'no git') || (process.platform === 'win32' && 'the stand-ins are shell scripts');
test('release: a git or gh call that hangs is stopped and fails the run', { skip: shell }, async (t) => {
  const dir = scratch(t);
  mkdirSync(join(dir, 'content'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 3, version: '0.1.0' }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  writeFileSync(join(dir, 'content', 'a.js'), 'one();\n');
  copyTools(dir, [...TOOLS, 'release-check.mjs']);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-gpg-sign', '-m', 'first');
  git(dir, 'tag', 'v0.1.0');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = join(dir, '.bin');
  mkdirSync(bin);
  const stub = (name, script) => writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  // A stand-in that never answers: it starts a sleep, says its pid, and waits.
  const pids = join(dir, '.pids');
  const hang = `sleep 30 &\necho $! >> "${pids}"\nwait`;
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // Kept here, since the folder is gone by the time the test ends.
  const seen = [];
  const sleeps = () => {
    const found = existsSync(pids) ? readFileSync(pids, 'utf8').trim().split('\n').map(Number) : [];
    seen.push(...found);
    return found;
  };
  t.after(() => {
    for (const pid of seen) if (alive(pid)) process.kill(pid, 'SIGKILL');
  });
  // A process killed is gone once whatever adopted it has reaped it.
  const goneSoon = async (pid) => {
    for (let tries = 0; tries < 50 && alive(pid); tries += 1) await new Promise((done) => setTimeout(done, 100));
    return !alive(pid);
  };
  const fromMain = () => {
    rmSync(pids, { force: true });
    const started = Date.now();
    const result = spawnSync(process.execPath, [join(dir, 'tools', 'release-check.mjs')], {
      cwd: dir,
      env: cleanEnv({
        // The group kill runs on CI only (the next test says why).
        CI: 'true',
        GITHUB_REF: 'refs/heads/main',
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        RELEASE_CHECK_TIMEOUT_MS: '2000',
      }),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
    });
    return { status: result.status, text: `${result.stdout}${result.stderr}`, seconds: (Date.now() - started) / 1000 };
  };
  const leftNothing = async (run) => {
    const [sleep, ...more] = sleeps();
    assert.ok(sleep && !more.length, `the stand-in did not start one sleep\n${run.text}`);
    assert.ok(await goneSoon(sleep), 'what the hung call started is still running');
  };
  // gh never says whether the tag has a release.
  stub('gh', hang);
  const gh = fromMain();
  await leftNothing(gh);
  assert.equal(gh.status, 1, `ran ${gh.seconds} s\n${gh.text}`);
  assert.equal(gh.text.trim(), 'gh release view v0.1.0 --json tagName did not finish within 2 s, so it was stopped');
  // git never says which commit the tag is on.
  stub('gh', 'echo \'{"tagName":"v0.1.0"}\'');
  stub('git', `case "$*" in *--verify*)\n${hang}\nexit 1;;\nesac\nexec "${realGit}" "$@"`);
  const tag = fromMain();
  await leftNothing(tag);
  assert.equal(tag.status, 1, `ran ${tag.seconds} s\n${tag.text}`);
  assert.equal(tag.text.trim(), 'git rev-parse -q --verify refs/tags/v0.1.0^{commit} did not finish within 2 s, so it was stopped');
});

// W6-F3. A call in a process group of its own is out of the terminal's
// reach, so Ctrl+C on a local run stopped the script and left a hung call
// running, with nobody left to enforce its limit. Only CI puts the call in a
// group of its own now. The run here leads its own group, as a shell's
// foreground job does, and the group gets SIGINT, as Ctrl+C sends it. A
// shell profile that sets CI=false or CI=0 is a local run too.
for (const ci of [undefined, 'false', '0']) {
test(`release: Ctrl+C on a local run stops the call it waits on (${ci === undefined ? 'CI unset' : `CI=${ci}`})`, { skip: shell }, async (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 3, version: '0.1.0' }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  copyTools(dir, [...TOOLS, 'release-check.mjs']);
  const bin = join(dir, '.bin');
  mkdirSync(bin);
  const pidFile = join(dir, '.pid');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`, { mode: 0o755 });
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const wait = async (ready, tries) => {
    for (let k = 0; k < tries && !ready(); k += 1) await new Promise((done) => setTimeout(done, 100));
    return ready();
  };
  const env = cleanEnv({ PATH: `${bin}${delimiter}${process.env.PATH}`, RELEASE_CHECK_TIMEOUT_MS: '20000' });
  delete env.CI;
  delete env.GITHUB_ACTIONS;
  if (ci !== undefined) env.CI = ci;
  const run = spawn(process.execPath, [join(dir, 'tools', 'release-check.mjs'), '--check'], { cwd: dir, env, stdio: 'ignore', detached: true });
  const exited = new Promise((done) => run.on('exit', done));
  let pid = 0;
  t.after(() => {
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    if (alive(run.pid)) process.kill(run.pid, 'SIGKILL');
  });
  assert.ok(await wait(() => (pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : 0) > 0, 200), 'git was never called');
  process.kill(-run.pid, 'SIGINT');
  const guard = setTimeout(() => run.kill('SIGKILL'), 10_000);
  await exited;
  clearTimeout(guard);
  assert.ok(await wait(() => !alive(pid), 50), 'the git call is still running after Ctrl+C');
});
}

// W6-F6. Only a git or gh call's failure is printed as its message alone. A
// manifest.json that is not JSON printed only JSON.parse's words, naming
// neither the file nor the error's type.
test('release: a version file that is not JSON is named, as a SyntaxError', (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, 'manifest.json'), '{\n  "manifest_version": 3,\n  "version": "0.1.0",\n}\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  copyTools(dir, [...TOOLS, 'release-check.mjs']);
  const result = spawnSync(process.execPath, [join(dir, 'tools', 'release-check.mjs'), '--check'], {
    cwd: dir,
    env: cleanEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /SyntaxError: manifest\.json is not valid JSON: /);
});

// F67. A tag lookup that git could not answer (exit 128: not a repository, a
// corrupt one) read as "not tagged yet", so with GITHUB_SHA set a run from
// main went on to release. Only exit 1 means there is no such tag.
test('release: a tag lookup git cannot answer fails the run', { skip: !hasGit && 'no git' }, (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 3, version: '0.1.0' }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  copyTools(dir, [...TOOLS, 'release-check.mjs']);
  const output = join(dir, '.output');
  const result = spawnSync(process.execPath, [join(dir, 'tools', 'release-check.mjs')], {
    cwd: dir,
    // Not a repository, whatever folder holds this one.
    env: cleanEnv({ GIT_CEILING_DIRECTORIES: dirname(dir), GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'c0ffee', GITHUB_OUTPUT: output }),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /^git rev-parse -q --verify refs\/tags\/v0\.1\.0\^\{commit\} failed: fatal: not a git repository/);
  assert.ok(!existsSync(output), `it decided anyway: ${existsSync(output) && readFileSync(output, 'utf8')}`);
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

// Full page (0.7.0). The panel calls into the tab itself, for the page shot
// and for the keys an armed mode takes. The shim had no chrome.scripting, so
// neither ran on the stage: Page failed at once, and keys were not handed on.
test('stage: the shim runs the panel\'s executeScript calls in the demo tab', async () => {
  const injected = [];
  const ran = [];
  const stage = {
    storage: {},
    downloads: { records: {}, nextId: 1 },
    inject: async (file) => injected.push(file),
    run: async (source, args) => {
      ran.push(args);
      return { source, sum: args[0] + args[1], at: new Date(0) };
    },
  };
  const window = { parent: { __stage: stage } };
  class XMLHttpRequest {
    open() {}
    send() {
      this.status = 404;
    }
  }
  vm.runInNewContext(read('tools/chrome-shim.js'), {
    window,
    document: { baseURI: 'http://localhost:8000/sidepanel/' },
    XMLHttpRequest,
    URL,
    setTimeout,
    clearTimeout,
  });
  const { scripting } = window.chrome;
  const filed = await scripting.executeScript({ target: { tabId: 1 }, files: ['content/page-shot.js'] });
  assert.equal(filed.length, 1);
  assert.equal(filed[0].result, undefined);
  assert.deepEqual(injected, ['page-shot.js']);
  const args = [2, 3];
  const [{ result }] = await scripting.executeScript({ target: { tabId: 1 }, func: (a, b) => a + b, args });
  assert.equal(result.source, '(a, b) => a + b');
  assert.equal(result.sum, 5);
  assert.equal(result.at, '1970-01-01T00:00:00.000Z', 'the result is serialised, as Chrome does');
  assert.notEqual(ran[0], args, 'the arguments are a copy');
  const stageSource = read('tools/panel-stage.html');
  assert.match(stageSource, /window\.__stage = \{[\s\S]*?\n {10}inject,\n {10}run\(source, args\) \{/);
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
