#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { selectNativeArtifact, withNativeArtifact } from './native-artifact-policy.mjs';
import { runPackedCommand } from './packed-command.mjs';

const { values } = parseArgs({
  options: {
    manifest: { type: 'string' },
    archive: { type: 'string' },
    target: { type: 'string' },
    skill: { type: 'string' },
    notices: { type: 'string' },
    license: { type: 'string' },
  },
});
for (const name of ['manifest', 'archive', 'target', 'skill', 'notices', 'license']) {
  assert(values[name], `--${name} is required`);
}
const metadata = selectNativeArtifact(values.manifest, values.archive, values.target);
const architecture =
  process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : null;
const platform = process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl';
assert(
  ['darwin', 'linux'].includes(process.platform) && architecture,
  'Unsupported verification host'
);
assert.equal(
  values.target,
  `${architecture}-${platform}`,
  'Artifact requires a matching native host'
);
const skill = fs.readFileSync(values.skill, 'utf8');
const notices = fs.readFileSync(values.notices, 'utf8');
assert(
  !/<year>|<copyright holders>/.test(notices),
  'Dependency notices contain placeholder attribution'
);

await withNativeArtifact(values.archive, metadata, async (artifactRoot) => {
  assert.equal(
    fs.readFileSync(path.join(artifactRoot, 'THIRD-PARTY-NOTICES.txt'), 'utf8'),
    notices,
    'Native archive notices differ from the generated inventory'
  );
  assert.deepEqual(
    fs.readFileSync(path.join(artifactRoot, 'LICENSE')),
    fs.readFileSync(values.license),
    'Native archive license differs from the selected source'
  );
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tmt installed proof's ")));
  try {
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'outside checkout');
    const xdg = path.join(root, 'config');
    const emptyPath = path.join(root, 'empty-path');
    for (const directory of [home, cwd, emptyPath]) fs.mkdirSync(directory);
    // An allowlist avoids ambient provider, tmux, loader and runtime overrides.
    const env = { HOME: home, XDG_CONFIG_HOME: xdg, PATH: emptyPath, LANG: 'C', TMPDIR: root };
    const executable = path.join(artifactRoot, 'tmt');
    // Inspection tools belong to the verifier, never the executable's PATH.
    if (process.platform === 'darwin') {
      const libraries = runPackedCommand('/usr/bin/otool', ['-L', executable], { cwd, env });
      const dependencies = libraries.trim().split('\n').slice(1);
      assert(dependencies.length > 0, 'Mach-O dependency inventory is empty');
      for (const dependency of dependencies) {
        assert(
          /^\s+(\/usr\/lib\/|\/System\/Library\/Frameworks\/)/.test(dependency),
          `Native archive requires a non-system library: ${dependency}`
        );
      }
    } else {
      const headers = runPackedCommand('/usr/bin/readelf', ['--program-headers', executable], {
        cwd,
        env,
      });
      assert(!/\bINTERP\b/.test(headers), 'Musl archive must not require a dynamic interpreter');
      const dynamic = runPackedCommand('/usr/bin/readelf', ['--dynamic', executable], { cwd, env });
      assert(!/\(NEEDED\)/.test(dynamic), 'Musl archive must not require shared libraries');
    }
    const run = (args) => runPackedCommand(executable, args, { cwd, env });
    const json = (args) => JSON.parse(run([...args, '--json']));
    assert.equal(run(['--version']).trim(), metadata.version, 'Native archive version mismatch');
    assert.equal(run(['learn', '--skill']), skill, 'Native archive embedded skill mismatch');
    const customRoot = path.join(cwd, 'custom skills');
    fs.mkdirSync(customRoot);
    const target = path.join(fs.realpathSync(customRoot), 'tmux-team');
    assert.deepEqual(json(['install', '--dir', customRoot]), {
      installed: [{ target, changed: true }],
    });
    assert(fs.lstatSync(target).isSymbolicLink(), 'Installed skill must be a managed link');
    assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), skill);
    const globalRoot = path.join(xdg, 'tmux-team');
    const managedAssets = path.join(fs.realpathSync(globalRoot), 'skill-assets');
    assert(
      fs.realpathSync(target).startsWith(`${managedAssets}${path.sep}`),
      'Installed skill must use the isolated managed asset store'
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(globalRoot, 'skill-installations.json'))),
      {
        version: 1,
        targets: [target],
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
    const profile = json([
      'role',
      '--identity',
      'artifact-proof',
      'set',
      'Persisted by native archive',
    ]);
    assert.equal(profile.role.content, 'Persisted by native archive');
    assert.deepEqual(json(['role', '--identity', 'artifact-proof', 'show']), profile);
    const descriptor = fs.openSync(database, 'r');
    try {
      const header = Buffer.alloc(16);
      assert.equal(fs.readSync(descriptor, header, 0, 16, 0), 16);
      assert.equal(header.toString(), 'SQLite format 3\0');
    } finally {
      fs.closeSync(descriptor);
    }
    console.log(
      `Verified native archive ${metadata.name}: linkage, version, skill, managed install, SQLite persistence`
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
