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
 */

import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'dist');

/** Everything Chrome needs at runtime, and nothing else. */
const INCLUDE = [
  'manifest.json',
  'background.js',
  'icons',
  'content',
  'shared',
  'sidepanel',
];

/** Belt and braces: never ship these even if they appear inside an included dir. */
const EXCLUDE = new Set(['.DS_Store', 'Thumbs.db']);

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
function makeZip(entries) {
  const DOS_TIME = 0x6000; // 12:00:00
  const DOS_DATE = 0x2821; // 2000-01-01
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const useDeflate = compressed.length < entry.data.length;
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

function collect(target, out = []) {
  const absolute = join(ROOT, target);
  const info = statSync(absolute);

  if (info.isDirectory()) {
    for (const child of readdirSync(absolute).sort()) {
      if (EXCLUDE.has(child)) continue;
      collect(join(target, child), out);
    }
    return out;
  }

  if (EXCLUDE.has(target.split(sep).pop())) return out;
  // Zip entries always use forward slashes, whatever the host platform does.
  out.push({ name: target.split(sep).join('/'), data: readFileSync(absolute) });
  return out;
}

// ------------------------------------------------------------ validation --

function validate(entries) {
  const problems = [];
  const names = new Set(entries.map((e) => e.name));

  const manifestEntry = entries.find((e) => e.name === 'manifest.json');
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

  return { problems, manifest };
}

// ------------------------------------------------------------------- main --

const entries = INCLUDE.flatMap((target) => collect(target));
const { problems, manifest } = validate(entries);

if (problems.length) {
  console.error('Build failed:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const name = `claude-debug-reporter-v${manifest.version}.zip`;
const zip = makeZip(entries);

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, name), zip);

const sha = createHash('sha256').update(zip).digest('hex');
writeFileSync(join(OUT_DIR, `${name}.sha256`), `${sha}  ${name}\n`);

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
