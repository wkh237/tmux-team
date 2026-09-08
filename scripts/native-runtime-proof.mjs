#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPackedCommand } from './packed-command.mjs';
import { assertBenchmarkHelp } from '../test/support/performance-contract.mjs';

export function nativeHostTarget() {
  const architecture =
    process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : null;
  const platform = process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl';
  assert(
    ['darwin', 'linux'].includes(process.platform) && architecture,
    'Unsupported verification host'
  );
  return `${architecture}-${platform}`;
}

export function assertNativeTarget(target, message) {
  assert.equal(target, nativeHostTarget(), message);
}

function verifyLinkage(executable, cwd, env, subject) {
  if (process.platform === 'darwin') {
    // Resolve the selected system toolchain once with xcrun. Invoking the
    // resolved inspection tool directly avoids xcrun's cache diagnostics under
    // the product's isolated HOME without guessing an Xcode install path.
    const otool = runPackedCommand('/usr/bin/xcrun', ['--find', 'otool'], {
      cwd,
      env: process.env,
    }).trim();
    assert(otool, 'macOS otool path is empty');
    let libraries;
    try {
      libraries = runPackedCommand(otool, ['-L', executable], {
        cwd,
        env,
      });
    } catch (error) {
      throw new Error(`${subject} linkage inspection failed`, { cause: error });
    }
    const dependencies = libraries.trim().split('\n').slice(1);
    assert(dependencies.length > 0, 'Mach-O dependency inventory is empty');
    for (const dependency of dependencies) {
      assert(
        /^\s+(\/usr\/lib\/|\/System\/Library\/Frameworks\/)/.test(dependency),
        `Native archive requires a non-system library: ${dependency}`
      );
    }
    return;
  }

  const readelf = ['/usr/bin/readelf', '/bin/readelf'].find((candidate) =>
    fs.existsSync(candidate)
  );
  assert(readelf, 'Linux runtime verification requires readelf');
  let headers;
  try {
    headers = runPackedCommand(readelf, ['--program-headers', executable], { cwd, env });
  } catch (error) {
    throw new Error(`${subject} linkage inspection failed`, { cause: error });
  }
  assert(!/\bINTERP\b/.test(headers), 'Musl archive must not require a dynamic interpreter');
  let dynamic;
  try {
    dynamic = runPackedCommand(readelf, ['--dynamic', executable], { cwd, env });
  } catch (error) {
    throw new Error(`${subject} linkage inspection failed`, { cause: error });
  }
  assert(!/\(NEEDED\)/.test(dynamic), 'Musl archive must not require shared libraries');
}

/**
 * Prove the runtime behavior shared by raw native binaries and extracted archives.
 * Archive inventory, checksums, notices and license checks remain in their callers.
 */
export function verifyNativeRuntime({
  executable,
  target,
  version,
  skill,
  profileContent,
  subject,
  matchingHostMessage = `${subject} requires a matching native host`,
}) {
  assert(fs.statSync(executable).isFile(), `${subject} must be a regular file`);
  fs.accessSync(executable, fs.constants.X_OK);
  assertNativeTarget(target, matchingHostMessage);
  assert(version.length > 0, 'Native runtime version must not be empty');

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tmt installed proof's ")));
  try {
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'outside checkout');
    const xdg = path.join(root, 'config');
    const emptyPath = path.join(root, 'empty-path');
    for (const directory of [home, cwd, emptyPath]) fs.mkdirSync(directory);
    // An allowlist avoids ambient provider, tmux, loader and runtime overrides.
    const env = { HOME: home, XDG_CONFIG_HOME: xdg, PATH: emptyPath, LANG: 'C', TMPDIR: root };
    verifyLinkage(executable, cwd, env, subject);

    const run = (args) => runPackedCommand(executable, args, { cwd, env });
    const json = (args) => JSON.parse(run([...args, '--json']));
    const globalRoot = path.join(xdg, 'tmux-team');
    assert.equal(run(['--version']).trim(), version, `${subject} version mismatch`);
    assertBenchmarkHelp(run(['--help']));
    assert.equal(run(['learn', '--skill']), skill, `${subject} embedded skill mismatch`);
    assert(!fs.existsSync(xdg), 'Read-only runtime commands must not initialize config state');
    const customRoot = path.join(cwd, 'custom skills');
    fs.mkdirSync(customRoot);
    const targetPath = path.join(fs.realpathSync(customRoot), 'tmux-team');
    assert.deepEqual(json(['install', '--dir', customRoot]), {
      installed: [{ target: targetPath, changed: true }],
    });
    assert(fs.lstatSync(targetPath).isSymbolicLink(), 'Installed skill must be a managed link');
    assert.equal(fs.readFileSync(path.join(targetPath, 'SKILL.md'), 'utf8'), skill);
    const managedAssets = path.join(fs.realpathSync(globalRoot), 'skill-assets');
    assert(
      fs.realpathSync(targetPath).startsWith(`${managedAssets}${path.sep}`),
      'Installed skill must use the isolated managed asset store'
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(globalRoot, 'skill-installations.json'))),
      {
        version: 1,
        targets: [targetPath],
      }
    );
    const database = path.join(globalRoot, 'tmux-team.db');
    assert(!fs.existsSync(database), 'Skill installation must not initialize SQLite');
    const created = json(['identity', 'create', 'artifact-proof']);
    assert.equal(created.created, true);
    assert.equal(created.identity.name, 'artifact-proof');
    assert.equal(created.identity.lifetime, 'saved');
    const shown = json(['identity', 'show', 'artifact-proof']);
    assert.deepEqual(shown.identity, created.identity);
    const profile = json(['role', '--identity', 'artifact-proof', 'set', profileContent]);
    assert.equal(profile.role.content, profileContent);
    assert.deepEqual(json(['role', '--identity', 'artifact-proof', 'show']), profile);
    const descriptor = fs.openSync(database, 'r');
    try {
      const header = Buffer.alloc(16);
      assert.equal(fs.readSync(descriptor, header, 0, 16, 0), 16);
      assert.equal(header.toString(), 'SQLite format 3\0');
    } finally {
      fs.closeSync(descriptor);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
