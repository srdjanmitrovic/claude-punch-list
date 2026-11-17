/**
 * Package the extension into a release zip.
 *
 *     node tools/build.mjs
 *
 * There is no build step for DEVELOPING this extension: you load the folder
 * unpacked and edit it in place. This script exists only to produce the archive
 * that gets attached to a GitHub release, so a user can download one file,
 * unzip it, and load it.
 *
 * It writes the zip itself rather than shelling out to `zip`, so it runs the
 * same on macOS, Linux and Windows with nothing installed but Node.
 *
 * The archive is meant to be reproducible: the same commit gives the same
 * bytes, and so the same checksum, on any machine. Three things would quietly
 * break that, and each is handled here rather than left to the environment:
 *
 *   - What is on disk. A file that is not tracked by git, a stray export or a
 *     scratch copy, is not part of the commit, so in a git checkout only
 *     tracked files are packed (`listFiles`).
 *   - Line endings. A Windows checkout can turn every LF into CRLF, so text is
 *     packed with LF whatever the checkout did (`toLf`).
 *   - The compressor. zlib's output differs between builds of zlib, and Node
 *     links a different one depending on who built it (its own copy, or the
 *     system's, as Homebrew's does), so the deflate stream is written by
 *     tools/deflate.mjs and not by `node:zlib`.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
// Only for reading back. Inflating is fixed by the format, so every zlib
// gives the same bytes back; it is compressing that differs between builds.
import { inflateRawSync } from 'node:zlib';
import { deflateRaw } from './deflate.mjs';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Everything Chrome needs at runtime, plus the license, and nothing else.
 *
 * LICENSE is not read by Chrome. It is here because the MIT license asks for
 * its notice to travel with every copy, and the zip is the copy most people
 * get.
 */
export const INCLUDE = [
  'manifest.json',
  'background.js',
  'icons',
  'content',
  'shared',
  'sidepanel',
  'LICENSE',
];

/** Belt and braces: never ship these even if they appear inside an included dir. */
export const EXCLUDE = new Set(['.DS_Store', 'Thumbs.db']);

/**
 * The files packed as text, with LF line endings whatever the checkout holds.
 * Everything else is packed byte for byte. .gitattributes names the same
 * extensions, so git converts exactly the files this script converts, and
 * test/build.test.mjs holds the two to each other.
 */
export const TEXT_EXTENSIONS = ['js', 'mjs', 'json', 'html', 'css', 'svg', 'txt', 'md'];
const TEXT = new RegExp(`\\.(?:${TEXT_EXTENSIONS.join('|')})$|(?:^|/)LICENSE$`);

export function isText(path) {
  return TEXT.test(path);
}

// ------------------------------------------------------------- zip writer --

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/**
 * Build a ZIP archive from {name, data} entries.
 *
 * Stored with a fixed DOS timestamp so the same input always produces a
 * byte-identical archive, which makes release checksums reproducible.
 */
export function makeZip(entries) {
  const DOS_TIME = 0x6000; // 12:00:00
  const DOS_DATE = 0x2821; // 2000-01-01
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRaw(entry.data);
    const useDeflate = compressed.length < entry.data.length;
    // The compressor is this repository's own, so each stream is read back
    // before it is written. A defect in it fails the build here instead of
    // shipping a zip that every unzip tool rejects.
    if (useDeflate && !inflateRawSync(compressed).equals(entry.data)) {
      throw new Error(`${entry.name} does not inflate back to itself, so the archive would be corrupt`);
    }
    const payload = useDeflate ? compressed : entry.data;
    const method = useDeflate ? 8 : 0;
    const sum = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    locals.push(local, nameBytes, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0o644 << 16, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + payload.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuffer, end]);
}

// ------------------------------------------------------------------ files --

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * The files under INCLUDE that git tracks, and those of them in an unresolved
 * merge conflict, or null when `root` is not the top of a git work tree (a
 * downloaded source archive, or no git at all).
 *
 * The check for the top matters: a folder that merely sits inside some other
 * repository would otherwise be answered for by that repository, which tracks
 * none of these paths.
 *
 * git lists a conflicted path once for each of its stages (the common
 * ancestor, ours, theirs), so the paths are deduplicated here. Without that a
 * conflicted icon went into the zip three times, without a word. listFiles
 * refuses a conflicted path in any case; this keeps its message to one line.
 */
function trackedFiles(root) {
  let top;
  try {
    top = git(root, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    return null;
  }
  if (!top || realpathSync(top) !== realpathSync(root)) return null;
  const paths = git(root, ['ls-files', '-z', '--', ...INCLUDE]).split('\0').filter(Boolean);
  // Each line is "<mode> <object> <stage>\t<path>".
  const unmerged = git(root, ['ls-files', '-z', '--unmerged', '--', ...INCLUDE])
    .split('\0')
    .filter(Boolean)
    .map((line) => line.slice(line.indexOf('\t') + 1));
  return { paths: [...new Set(paths)], unmerged: [...new Set(unmerged)] };
}

/** Every file under INCLUDE on disk, for a tree that is not a git checkout. */
function filesOnDisk(root, target, out = []) {
  const absolute = join(root, target);
  if (!existsSync(absolute)) return out;
  if (statSync(absolute).isDirectory()) {
    for (const child of readdirSync(absolute)) filesOnDisk(root, join(target, child), out);
    return out;
  }
  // Paths are written with forward slashes, whatever the host platform does.
  out.push(target.split(sep).join('/'));
  return out;
}

/**
 * The order of the entries is part of the archive's bytes, so it is fixed
 * here rather than taken from git or the file system: INCLUDE's order, then
 * each folder's names sorted, a folder's files at the point its name sorts.
 */
function compareForArchive(a, b) {
  const group = (path) => INCLUDE.findIndex((top) => path === top || path.startsWith(`${top}/`));
  const difference = group(a) - group(b);
  if (difference) return difference;
  const left = a.split('/');
  const right = b.split('/');
  for (let k = 0; k < Math.min(left.length, right.length); k += 1) {
    if (left[k] !== right[k]) return left[k] < right[k] ? -1 : 1;
  }
  return left.length - right.length;
}

/** CRLF to LF. A lone CR is left alone; nothing here writes one. */
export function toLf(data) {
  if (!data.includes(0x0d)) return data;
  const out = Buffer.alloc(data.length);
  let size = 0;
  for (let k = 0; k < data.length; k += 1) {
    if (data[k] === 0x0d && data[k + 1] === 0x0a) continue;
    out[size++] = data[k];
  }
  return out.subarray(0, size);
}

/**
 * What goes into the archive, and what the person building should know about
 * what does not: files git does not track, tracked files edited since the last
 * commit (which make the checksum differ from that commit's), and tracked
 * files deleted from disk.
 *
 * A file in an unresolved merge conflict stops the build. On disk it holds
 * one side of the conflict, or both with markers between them, and a zip of
 * either is not a build of any commit.
 */
export function listFiles(root) {
  const notes = [];
  const problems = [];
  const tracked = trackedFiles(root);
  let paths = tracked?.paths;
  if (tracked) {
    for (const path of tracked.unmerged) {
      problems.push(`${path} has an unresolved merge conflict. Resolve it, git add it, and build again.`);
    }
    const missing = paths.filter((path) => !existsSync(join(root, path)));
    if (missing.length) notes.push(`tracked but deleted, so not packed: ${missing.join(', ')}`);
    paths = paths.filter((path) => !missing.includes(path));
    try {
      const untracked = git(root, ['ls-files', '-z', '--others', '--exclude-standard', '--', ...INCLUDE])
        .split('\0')
        .filter(Boolean);
      if (untracked.length) notes.push(`not tracked by git, so not packed: ${untracked.join(', ')}`);
      const edited = git(root, ['diff', '--name-only', '-z', 'HEAD', '--', ...INCLUDE])
        .split('\0')
        .filter(Boolean);
      if (edited.length) {
        notes.push(
          `edited since the last commit, so the checksum is not that commit's: ${edited.join(', ')}`
        );
      }
    } catch {
      // A repository with no commit yet has no HEAD to compare with.
    }
  } else {
    notes.push('not a git checkout, so every file on disk under the included paths is packed');
    paths = INCLUDE.flatMap((target) => filesOnDisk(root, target));
  }
  paths = paths.filter((path) => !EXCLUDE.has(path.split('/').pop())).sort(compareForArchive);
  return { paths, notes, problems };
}

export function collectEntries(root) {
  const { paths, notes, problems } = listFiles(root);
  const entries = paths.map((name) => {
    const data = readFileSync(join(root, name));
    return { name, data: isText(name) ? toLf(data) : data };
  });
  return { entries, notes, problems };
}

// ------------------------------------------------------------ validation --

/** The `src` and `href` values of an HTML file, without fragment or query. */
function references(html) {
  return [...html.matchAll(/\b(?:src|href)="([^"#?]*)/g)]
    .map((match) => match[1])
    .filter((ref) => ref && !/^[a-z][a-z0-9+.-]*:/i.test(ref) && !ref.startsWith('//'));
}

function moduleScripts(html) {
  return [...html.matchAll(/<script\b[^>]*>/gi)]
    .map((match) => match[0])
    .filter((tag) => /\btype=["']?module\b/i.test(tag))
    .map((tag) => /\bsrc="([^"#?]+)/.exec(tag)?.[1])
    .filter(Boolean);
}

// --------------------------------------------------------------- imports --

/**
 * Where Chrome looks for a module an extension page or worker imports. A
 * specifier that starts with /, ./ or ../ is a URL relative to the importing
 * file, so "/shared/x.js" is the extension's own shared/x.js. A full URL
 * points outside the extension, which loads no code from elsewhere. Anything
 * else is a bare name, which only an import map could resolve, and nothing
 * here declares one.
 */
export function resolveSpecifier(specifier, from) {
  if (/^(?:\/(?!\/)|\.{1,2}\/)/.test(specifier)) {
    const url = new URL(specifier, `chrome-extension://extension/${from}`);
    let path = url.pathname.slice(1);
    try {
      path = decodeURIComponent(path);
    } catch {
      // A stray % is looked up as it is written.
    }
    return { path };
  }
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(specifier)) {
    return { problem: 'which is not a file in the extension, and an extension loads no code from elsewhere' };
  }
  return { problem: 'which Chrome cannot resolve: a module path starts with ./, ../ or /' };
}

// The keyword import up to its '(': not a property (loader.import, or
// loader.\nimport), and with white space or comments allowed before the '(',
// as JavaScript allows them, so import /* x */ ('./x.js') is read too. A
// comment's body cannot hold '*/', so each comment ends at its first.
const IMPORT_CALL = /(?<![\w$])import(?<!\.\s*import)(?:\s|\/\*(?:[^*]|\*(?!\/))*\*\/|\/\/[^\n]*\n)*\(/.source;

// import("./x.js") with a literal path: quoted, or a template with nothing
// put into it. V8 reports only static imports, so this one is found in the
// text. A literal in a comment or a string is taken for an import too, which
// can fail a build but never lets a broken one pass.
const DYNAMIC_IMPORT = new RegExp(IMPORT_CALL + /\s*(?:(['"])([^'"\n]+)\1|`([^`$\\\n]+)`)\s*[,)]/.source, 'g');

// Every import( in a file, literal or not. One whose path is computed or
// built from a template (import(`./${name}.js`)) names no file the build can
// look for, and so does any import( in a file the build does not follow as a
// module, so each of those fails the build rather than going unchecked.
const ANY_DYNAMIC_IMPORT = new RegExp(IMPORT_CALL, 'g');

// A method named import (import(name) {, static import() {), which is no
// import. Its ')' and '{' share a line, which a call and a block after it
// cannot, so a dynamic import never reads this way. A method whose
// parameters hold a '(' or a line break is still taken for an import.
const IMPORT_METHOD = new RegExp(IMPORT_CALL + /[^()\n]*\)[ \t]*\{/.source, 'y');

/** The specifier of each import( DYNAMIC_IMPORT can read, by where it starts. */
function literalImports(text) {
  return new Map([...text.matchAll(DYNAMIC_IMPORT)].map((match) => [match.index, match[2] ?? match[3]]));
}

/**
 * A problem for each import( in a shipped script the build cannot check: one
 * whose path is not a literal, or any in a file the build does not follow as
 * a module (a content script, or a module nothing imports).
 */
export function uncheckedImports(name, text, followed) {
  const literal = literalImports(text);
  const problems = [];
  for (const match of text.matchAll(ANY_DYNAMIC_IMPORT)) {
    if (followed && literal.has(match.index)) continue;
    IMPORT_METHOD.lastIndex = match.index;
    if (IMPORT_METHOD.test(text)) continue;
    const line = text.slice(0, match.index).split('\n').length;
    problems.push(
      followed
        ? `${name}:${line} calls import() with a path that is not written out, which the build cannot check: ` +
            'write it as one quoted string'
        : `${name}:${line} calls import(), and the build does not follow ${name} as a module, so it cannot check it`
    );
  }
  return problems;
}

/** The specifiers of a module's static imports and re-exports, in V8's own words. */
function staticSpecifiers(record) {
  // moduleRequests is the newer name (Node 22 on); Node 20 has only the older.
  return record.moduleRequests?.map((request) => request.specifier) ?? record.dependencySpecifiers;
}

/**
 * The second half of checkImports, in a Node started with
 * --experimental-vm-modules, where vm.SourceTextModule exists. Reads
 * {names, files, roots} on stdin and writes {modules, problems}.
 *
 * Each module is parsed by V8 and linked, never run. Linking is the step
 * where Chrome fails a module graph, for an import of a file that is not
 * there or of a name the file does not export, so the answer is V8's own and
 * does not depend on how an import statement is spaced or split over lines.
 */
async function linkMain() {
  const { names, files, roots } = JSON.parse(readFileSync(0, 'utf8'));
  const inBuild = new Set(names);
  const context = vm.createContext({});
  const records = new Map();
  const modules = [];
  const problems = [];
  let linkable = true;

  const load = (name) => {
    if (records.has(name)) return records.get(name);
    let record = null;
    if (/\.m?js$/.test(name)) {
      modules.push(name);
      try {
        record = new vm.SourceTextModule(files[name], { identifier: name, context });
      } catch {
        // checkModule reports the syntax error, with its line.
        linkable = false;
      }
    } else {
      // A JSON or CSS module, which Chrome imports with a type attribute and
      // which exports only its default.
      record = new vm.SyntheticModule(['default'], () => {}, { identifier: name, context });
    }
    records.set(name, record);
    return record;
  };

  const queue = roots.filter((name) => inBuild.has(name));
  while (queue.length) {
    const name = queue.shift();
    if (records.has(name)) continue;
    const record = load(name);
    if (!(record instanceof vm.SourceTextModule)) continue;
    const dynamic = [...literalImports(files[name]).values()];
    for (const specifier of [...staticSpecifiers(record), ...dynamic]) {
      const { path, problem } = resolveSpecifier(specifier, name);
      const missing = problem || (!inBuild.has(path) && 'which is not in the build');
      if (missing) {
        problems.push(`${name} imports "${specifier}", ${missing}`);
        linkable = false;
      } else {
        queue.push(path);
        // A module loaded only by import() is linked on its own, later.
        if (dynamic.includes(specifier)) roots.push(path);
      }
    }
  }

  if (linkable) {
    const linker = (specifier, referencing) => records.get(resolveSpecifier(specifier, referencing.identifier).path);
    for (const name of roots) {
      const record = records.get(name);
      if (record?.status !== 'unlinked') continue;
      try {
        await record.link(linker);
      } catch (error) {
        const specifier = /requested module '([^']+)'/.exec(error.message)?.[1];
        const importers = specifier
          ? [...records]
              .filter(([, other]) => other instanceof vm.SourceTextModule && staticSpecifiers(other).includes(specifier))
              .map(([other]) => other)
          : [];
        problems.push(`${importers.length ? importers.join(', ') : `${name} or a module it imports`}: ${error.message}`);
        break;
      }
    }
  }
  process.stdout.write(JSON.stringify({ modules, problems }));
}

/**
 * Follows the imports of every module from `roots`, in the archive's own
 * files: every import must name a file in the build, and every name imported
 * must be one that file exports. Returns which files are modules, so the rest
 * of content/ can be parsed as the classic scripts they are.
 */
export function checkImports(entries, roots) {
  const files = {};
  for (const entry of entries) {
    if (/\.m?js$/.test(entry.name)) files[entry.name] = entry.data.toString('utf8');
  }
  const input = JSON.stringify({ names: entries.map((entry) => entry.name), files, roots });
  try {
    const output = execFileSync(
      process.execPath,
      ['--experimental-vm-modules', '--no-warnings', fileURLToPath(import.meta.url), '--link'],
      { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }
    );
    return JSON.parse(output);
  } catch (error) {
    const reason = String(error.stderr || error.message).trim().split('\n')[0];
    return { modules: roots, problems: [`the imports could not be checked: ${reason}`] };
  }
}

function checkClassic(entry) {
  try {
    new vm.Script(entry.data.toString('utf8'), { filename: entry.name });
    return null;
  } catch (error) {
    const line = new RegExp(`${entry.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`).exec(
      error.stack || ''
    )?.[1];
    return `${entry.name}${line ? `:${line}` : ''} does not parse: ${error.name}: ${error.message}`;
  }
}

/**
 * Node can check a module's syntax only by being run on it, and then only by
 * file name or from stdin. Stdin, with the type said outright, means it does
 * not matter where the file is or what any package.json beside it says.
 */
function checkModule(entry) {
  try {
    execFileSync(process.execPath, ['--input-type=module', '--check'], {
      input: entry.data,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return null;
  } catch (error) {
    const output = String(error.stderr || '');
    const line = /\[stdin\]:(\d+)/.exec(output)?.[1];
    const message = /^\w*Error: .*$/m.exec(output)?.[0] || 'node --check failed';
    return `${entry.name}${line ? `:${line}` : ''} does not parse: ${message}`;
  }
}

/**
 * Everything that would build clean and then break in Chrome: a path the
 * manifest, the worker or the panel names that is not in the archive, an
 * import of a file that is not in it or of a name that file does not export,
 * a file that does not parse.
 *
 * test/static.test.mjs checks the same things in the working tree. They are
 * checked again here because the archive is not the working tree: a file
 * that exists on disk but was never added to git passes those tests and is
 * left out of this build.
 */
export function validate(entries) {
  const problems = [];
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const names = new Set(byName.keys());

  const manifestEntry = byName.get('manifest.json');
  if (!manifestEntry) {
    problems.push('manifest.json is missing');
    return { problems, manifest: null };
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  } catch (error) {
    problems.push(`manifest.json is not valid JSON: ${error.message}`);
    return { problems, manifest: null };
  }

  if (manifest.manifest_version !== 3) problems.push('manifest_version must be 3');
  if (!/^\d+(\.\d+){0,3}$/.test(manifest.version || '')) {
    problems.push(`version "${manifest.version}" is not a valid extension version`);
  }
  if (!names.has('LICENSE')) {
    problems.push('LICENSE is missing, and the MIT license asks for its notice to ship with the code');
  }

  // Every path the manifest points at must actually be in the archive. This is
  // the failure that produces a broken install rather than a build error.
  const referenced = [
    manifest.background?.service_worker,
    manifest.side_panel?.default_path,
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
    ...(manifest.content_scripts || []).flatMap((script) => [
      ...(script.js || []),
      ...(script.css || []),
    ]),
  ].filter(Boolean);

  for (const path of new Set(referenced)) {
    if (!names.has(path)) problems.push(`manifest references "${path}", which is not in the build`);
  }

  // The worker injects the capture scripts by path, which nothing checks until
  // a mode button is pressed.
  const worker = byName.get(manifest.background?.service_worker);
  if (worker) {
    for (const [, path] of worker.data.toString('utf8').matchAll(/['"](content\/[\w.-]+\.js)['"]/g)) {
      if (!names.has(path)) problems.push(`${worker.name} injects "${path}", which is not in the build`);
    }
  }

  // The panel's stylesheet, scripts and images, and which scripts are modules.
  const modules = [];
  if (worker && manifest.background?.type === 'module') modules.push(worker.name);
  const panelPath = manifest.side_panel?.default_path;
  const panel = byName.get(panelPath);
  if (panel) {
    const html = panel.data.toString('utf8');
    for (const ref of references(html)) {
      const path = posix.normalize(posix.join(posix.dirname(panelPath), ref));
      if (!names.has(path)) problems.push(`${panelPath} loads "${ref}", which is not in the build`);
    }
    for (const src of moduleScripts(html)) {
      modules.push(posix.normalize(posix.join(posix.dirname(panelPath), src)));
    }
  }

  // Follow imports from every module, which are modules themselves. Under
  // content/ everything else is a classic script (a content script, or a file
  // the worker injects); anywhere else it is parsed as a module too, so a
  // module nothing imports yet still gets a message about its syntax rather
  // than about its `export`.
  const imports = checkImports(entries, modules);
  problems.push(...imports.problems);
  const seen = new Set(imports.modules);
  for (const entry of entries) {
    // An import() whose path the check above could not read, or in a file it
    // did not follow, is one it let through unchecked.
    if (/\.m?js$/.test(entry.name)) {
      problems.push(...uncheckedImports(entry.name, entry.data.toString('utf8'), seen.has(entry.name)));
    }
    if (!entry.name.endsWith('.js')) continue;
    const classic = !seen.has(entry.name) && entry.name.startsWith('content/');
    const problem = classic ? checkClassic(entry) : checkModule(entry);
    if (problem) problems.push(problem);
  }

  return { problems, manifest };
}

// ------------------------------------------------------------------- main --

/** Build the archive for the tree at `root`. Writes nothing. */
export function build(root = DEFAULT_ROOT) {
  const collected = collectEntries(root);
  const { entries, notes } = collected;
  const validated = validate(entries);
  const problems = [...collected.problems, ...validated.problems];
  const { manifest } = validated;
  if (problems.length) return { problems, notes, entries };
  const name = `claude-punch-list-v${manifest.version}.zip`;
  const zip = makeZip(entries);
  const sha = createHash('sha256').update(zip).digest('hex');
  return { problems, notes, entries, manifest, name, zip, sha };
}

function main() {
  const outDir = join(DEFAULT_ROOT, 'dist');
  const result = build(DEFAULT_ROOT);
  for (const note of result.notes) console.warn(`Note: ${note}`);

  if (result.problems.length) {
    console.error('Build failed:\n');
    for (const problem of result.problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  const { manifest, name, zip, sha, entries } = result;
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, name), zip);
  writeFileSync(join(outDir, `${name}.sha256`), `${sha}  ${name}\n`);

  const kb = (zip.length / 1024).toFixed(1);
  console.log(`${manifest.name} ${manifest.version}\n`);
  for (const entry of entries) {
    console.log(`  ${entry.name.padEnd(34)} ${String(entry.data.length).padStart(7)} B`);
  }
  console.log(`\n  ${entries.length} files, ${kb} kB packed`);
  console.log(`\n  dist/${name}`);
  console.log(`  sha256 ${sha}`);
  console.log(`
Install it:
  1. Unzip the archive.
  2. Open chrome://extensions and turn on Developer mode.
  3. Click "Load unpacked" and select the unzipped folder.
`);
}

// Compared as real paths: run from a folder reached through a symlink (macOS's
// /var is one), the script's own URL names the real path and argv does not.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  if (process.argv[2] === '--link') await linkMain();
  else main();
}
