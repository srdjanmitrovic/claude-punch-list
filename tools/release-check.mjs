/**
 * Decide what a run of the release workflow does, and refuse what would leave
 * one version number on two different builds.
 *
 *     node tools/release-check.mjs           # .github/workflows/release.yml runs this
 *     node tools/release-check.mjs --check   # CI runs this on a pull request into main
 *
 * The release tag is v<version>, from manifest.json, and package.json must
 * agree. Then:
 *
 *   - A pushed tag must be that tag, and is released unless it already is.
 *   - Anything else releases from main only, a push or a manual run:
 *       no tag for the version yet: tag this commit and release it;
 *       tagged, and the shipped files are as they were at the tag: nothing to
 *         do, or, if the tag never got a release, release it from the tag;
 *       tagged, and the shipped files have changed since (their content, or
 *         which files they are, as when INCLUDE in tools/build.mjs grows):
 *         refuse, released or not, because the tag already names another
 *         build of that version. Bump it. A tag that never got a release
 *         can still be released as it is, by running this from the tag.
 *   - --check applies only that last rule, so a pull request hears about it
 *     before it merges rather than after.
 *
 * Before this, 0.3.0 and 0.4.0 were bumped on main and never tagged, the
 * README's download link handed people 0.2.0 under its old name, and 0.4.0
 * named two builds that behaved differently. A manual run from main could
 * never pass, because it compared the branch name with the version.
 *
 * Writes publish, tag, version and commit to $GITHUB_OUTPUT when that is set.
 * Exits 1 on a refusal.
 */

import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXCLUDE, INCLUDE } from './build.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The decision, from facts gathered elsewhere, so it can be tested without
 * git or GitHub.
 *
 * @param {object} facts
 * @param {string} facts.ref             GITHUB_REF: refs/heads/<branch> or refs/tags/<tag>
 * @param {string} facts.sha             the commit this run is on
 * @param {string} facts.manifestVersion
 * @param {string} facts.packageVersion
 * @param {string|null} facts.tagCommit  the commit v<version> points at, or null
 * @param {boolean} facts.shippedChanged whether the zip built from this commit would hold other
 *                                       files, or other bytes, than the one built from that commit
 * @param {boolean} [facts.releaseExists] whether GitHub has a release for the tag; left out
 *                                       when it was not asked, or could not be
 * @param {boolean} [facts.check]        only the rule a pull request can break
 * @returns {{ action: 'publish'|'skip'|'fail', message: string, tag?: string, version?: string, commit?: string }}
 */
export function decide(facts) {
  const { ref, sha, manifestVersion, packageVersion, tagCommit, shippedChanged } = facts;
  if (manifestVersion !== packageVersion) {
    return {
      action: 'fail',
      message: `manifest.json says ${manifestVersion} and package.json says ${packageVersion}. Give both the same version.`,
    };
  }
  const version = manifestVersion;
  const tag = `v${version}`;
  const done = (action, message, commit) => ({ action, message, tag, version, commit });
  // Refused whether or not the tag has a release: the tag names a build of
  // this version, and releasing another under it, or releasing the tag's
  // while main ships something else as the same version, gives one version
  // two builds. The message says only what is known.
  const state =
    facts.releaseExists === true
      ? `${tag} is already released`
      : facts.releaseExists === false
        ? `${tag} is tagged but has no release`
        : `${tag} is already tagged`;
  const bump =
    `${state}, and the files it ships have changed since the tag. ` +
    `Releasing them as ${version} would give one version two builds, so bump "version" ` +
    'in manifest.json and package.json.' +
    (facts.releaseExists === false ? ` To release the build the tag names instead, run the release workflow from ${tag}.` : '');

  if (facts.check) {
    if (tagCommit && shippedChanged) return done('fail', bump);
    return done(
      'skip',
      tagCommit
        ? `${tag} is tagged, and nothing it ships has changed since.`
        : `${tag} is not released yet. Merging this to main releases it.`
    );
  }

  if (ref.startsWith('refs/tags/')) {
    const name = ref.slice('refs/tags/'.length);
    if (name !== tag) {
      return done(
        'fail',
        `Tag ${name} does not match the manifest version ${version}. Bump manifest.json and package.json, then tag again.`
      );
    }
    if (facts.releaseExists) return done('skip', `${tag} already has a release.`);
    return done('publish', `Releasing ${tag}.`, tagCommit || sha);
  }

  if (ref !== 'refs/heads/main') {
    return done(
      'fail',
      `Releases are made from main, and this run is on ${ref.replace(/^refs\/heads\//, '')}. Run it from main, or push the tag ${tag}.`
    );
  }
  if (!tagCommit) return done('publish', `${tag} is not tagged yet. Releasing this commit as ${tag}.`, sha);
  if (shippedChanged) return done('fail', bump);
  if (facts.releaseExists) return done('skip', `${tag} is released, and nothing it ships has changed since.`);
  return done('publish', `${tag} is tagged but has no release. Releasing it from the tag.`, tagCommit);
}

// ------------------------------------------------------------------- facts --

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tagCommitOf(tag) {
  const result = spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * The INCLUDE list in the source of a tools/build.mjs, exported or not (it
 * was not in 0.5.0), or null when it is not written as a plain list of
 * strings.
 */
export function includeIn(source) {
  const list = /\bconst INCLUDE = \[([^\]]*)\]/.exec(source)?.[1];
  if (list === undefined) return null;
  const paths = [...list.matchAll(/'([^'\n]+)'|"([^"\n]+)"/g)].map((match) => match[1] ?? match[2]);
  return paths.length ? paths : null;
}

/** The INCLUDE list tools/build.mjs had at `commit`, or null. */
function includeAt(commit) {
  const result = spawnSync('git', ['show', `${commit}:tools/build.mjs`], { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? includeIn(result.stdout) : null;
}

/** Each file the zip built from `commit` holds, with its blob: path, then object id. */
function shippedAt(commit, include) {
  const listing = git(['ls-tree', '-r', '-z', commit, '--', ...include]);
  const files = new Map();
  for (const line of listing.split('\0').filter(Boolean)) {
    // "<mode> <type> <object>\t<path>"
    const tab = line.indexOf('\t');
    const [, type, object] = line.slice(0, tab).split(' ');
    const path = line.slice(tab + 1);
    if (type === 'blob' && !EXCLUDE.has(path.split('/').pop())) files.set(path, object);
  }
  return files;
}

/**
 * Whether the zip built from `to` holds other files than the one built from
 * `from`, or other bytes in any of them. Each side is listed with its own
 * INCLUDE, so a widened or narrowed INCLUDE counts as a change even when no
 * file it adds or drops has changed. A comparison of content alone, over
 * today's INCLUDE, passed a zip that had gained a file under a version
 * already out.
 */
function shippedChangedBetween(from, to) {
  const before = shippedAt(from, includeAt(from) ?? INCLUDE);
  const after = shippedAt(to, INCLUDE);
  if (before.size !== after.size) return true;
  for (const [path, object] of after) if (before.get(path) !== object) return true;
  return false;
}

/** Asks GitHub through `gh`, which the hosted runners carry. */
function releaseExistsFor(tag) {
  const result = spawnSync('gh', ['release', 'view', tag, '--json', 'tagName'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.error) throw new Error(`could not run gh to ask whether ${tag} has a release: ${result.error.message}`);
  if (result.status === 0) return true;
  if (/release not found/i.test(result.stderr)) return false;
  throw new Error(`gh release view ${tag} failed: ${result.stderr.trim()}`);
}

function main() {
  const check = process.argv.includes('--check');
  const read = (file) => JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
  const manifestVersion = read('manifest.json').version;
  const packageVersion = read('package.json').version;
  const sha = process.env.GITHUB_SHA || git(['rev-parse', 'HEAD']);
  const ref = process.env.GITHUB_REF || `refs/heads/${git(['rev-parse', '--abbrev-ref', 'HEAD'])}`;
  const tag = `v${manifestVersion}`;
  const tagCommit = tagCommitOf(tag);
  const shippedChanged = tagCommit ? shippedChangedBetween(tagCommit, sha) : false;
  // Asked on a pushed tag and on main, where the answer decides the run or,
  // on a refusal, its remedy: a tag that never got a release can still be
  // released as it is, from the tag. --check and the first release of a
  // version need no GitHub access at all. A refusal that cannot ask still
  // refuses, saying only that the tag exists.
  const asks =
    !check && manifestVersion === packageVersion && tagCommit &&
    (ref === `refs/tags/${tag}` || ref === 'refs/heads/main');
  let releaseExists;
  if (asks) {
    try {
      releaseExists = releaseExistsFor(tag);
    } catch (error) {
      if (!(ref === 'refs/heads/main' && shippedChanged)) throw error;
    }
  }

  const result = decide({ ref, sha, manifestVersion, packageVersion, tagCommit, shippedChanged, releaseExists, check });
  const stream = result.action === 'fail' ? console.error : console.log;
  stream(result.message);
  if (process.env.GITHUB_OUTPUT) {
    const lines = [`publish=${result.action === 'publish'}`];
    if (result.tag) lines.push(`tag=${result.tag}`, `version=${result.version}`);
    if (result.commit) lines.push(`commit=${result.commit}`);
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  }
  if (result.action === 'fail') process.exit(1);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main();
}
