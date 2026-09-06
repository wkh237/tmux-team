#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

function usage() {
  console.log(`verify-packed-native-install

Usage:
  node scripts/verify-packed-native-install.mjs --package-tarball <path>
    [--expected-arch x64|arm64] [--expected-libc glibc|musl|none]

The verifier installs the packed package into an isolated temporary project,
blocks compiler fallback, loads better-sqlite3's native binding, and executes
an FTS5 query, and verifies bundled skill viewing and isolated installation.
`);
}

function parseArgs(argv) {
  const options = { expectedArch: null, expectedLibc: 'auto', packageTarball: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      usage();
      process.exit(0);
    }
    if (argument === '--package-tarball') {
      options.packageTarball = argv[++index];
    } else if (argument === '--expected-arch') {
      options.expectedArch = argv[++index];
    } else if (argument === '--expected-libc') {
      options.expectedLibc = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!options.packageTarball) throw new Error('--package-tarball is required');
  if (options.expectedArch && !['x64', 'arm64'].includes(options.expectedArch)) {
    throw new Error(`Unsupported --expected-arch: ${options.expectedArch}`);
  }
  if (!['auto', 'glibc', 'musl', 'none'].includes(options.expectedLibc)) {
    throw new Error(`Unsupported --expected-libc: ${options.expectedLibc}`);
  }
  return options;
}

function findNpm() {
  return execFileSync('which', ['npm'], { encoding: 'utf8' }).trim();
}

function installPackage({ projectDirectory, tarball, cacheDirectory }) {
  const npmPath = findNpm();
  const result = spawnSync(
    npmPath,
    ['install', '--no-audit', '--no-fund', '--no-package-lock', '--ignore-scripts', tarball],
    {
      cwd: projectDirectory,
      encoding: 'utf8',
      env: {
        ...process.env,
        npm_config_cache: cacheDirectory,
      },
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Packed package installation failed (exit ${result.status}).\n${result.stdout ?? ''}${result.stderr ?? ''}`
    );
  }
}

function verifyArchitecture(expectedArch, expectedLibc) {
  if (expectedArch && process.arch !== expectedArch) {
    throw new Error(`Architecture mismatch: expected ${expectedArch}, got ${process.arch}`);
  }
  if (expectedLibc === 'auto' || expectedLibc === 'none') return;
  const glibcVersion = process.report?.getReport?.().header?.glibcVersionRuntime;
  const actualLibc = glibcVersion ? 'glibc' : 'musl';
  if (actualLibc !== expectedLibc) {
    throw new Error(`Libc mismatch: expected ${expectedLibc}, got ${actualLibc}`);
  }
}

function expectedPrebuildTarget(expectedLibc) {
  if (process.platform === 'darwin') return `darwin-${process.arch}`;
  if (process.platform === 'linux') {
    const glibcVersion = process.report?.getReport?.().header?.glibcVersionRuntime;
    const libc = expectedLibc === 'auto' ? (glibcVersion ? 'glibc' : 'musl') : expectedLibc;
    return `${libc === 'musl' ? 'linuxmusl' : 'linux'}-${process.arch}`;
  }
  throw new Error(`Unsupported prebuild platform: ${process.platform}`);
}

function loadAndVerifySqlite(projectDirectory, expectedLibc) {
  const requireFromProject = createRequire(path.join(projectDirectory, 'verify.cjs'));
  const packageEntry = requireFromProject.resolve('better-sqlite3');
  const packageDirectory = path.dirname(path.dirname(packageEntry));
  const target = expectedPrebuildTarget(expectedLibc);
  const prebuild = path.join(packageDirectory, 'prebuilds', `${target}.node`);
  if (!fs.existsSync(prebuild)) {
    throw new Error(`Bundled better-sqlite3 prebuild is missing: ${target}`);
  }

  const Database = requireFromProject('better-sqlite3');
  const database = new Database(':memory:');
  try {
    const compileOptions = database.pragma('compile_options');
    const hasFts5 = compileOptions.some((option) =>
      Object.values(option).some((value) => String(value).toUpperCase().includes('FTS5'))
    );
    if (!hasFts5) throw new Error('better-sqlite3 was loaded without FTS5 support');
    database.exec('CREATE VIRTUAL TABLE documents USING fts5(body)');
    database.prepare('INSERT INTO documents (body) VALUES (?)').run('native sqlite verification');
    const matches = database
      .prepare("SELECT body FROM documents WHERE documents MATCH 'native'")
      .all();
    if (matches.length !== 1 || matches[0].body !== 'native sqlite verification') {
      throw new Error('FTS5 query returned an unexpected result');
    }
  } finally {
    database.close();
  }
}

function verifyPackedCli(projectDirectory) {
  const executable = path.join(projectDirectory, 'node_modules', '.bin', 'tmt');
  const result = spawnSync(executable, ['--version'], {
    cwd: projectDirectory,
    encoding: 'utf8',
    env: { ...process.env, TMUX_TEAM_HOME: path.join(projectDirectory, 'tmt-home') },
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || !/^\d+\.\d+\.\d+(?:-[\w.]+)?\s*$/.test(result.stdout ?? '')) {
    throw new Error(
      `Packed tmt executable failed (exit ${result.status}).\n${result.stdout ?? ''}${result.stderr ?? ''}`
    );
  }
}

function verifyPackedSkills(projectDirectory) {
  const executable = path.join(projectDirectory, 'node_modules', '.bin', 'tmt');
  const home = path.join(projectDirectory, 'skill-home');
  fs.mkdirSync(home);
  const env = {
    ...process.env,
    HOME: home,
    CODEX_HOME: path.join(home, '.codex'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
  };
  for (const key of ['TMUX', 'TMUX_PANE', 'TMUX_TEAM_HOME']) delete env[key];
  const run = (args, expectedStatus = 0) => {
    const result = spawnSync(executable, args, {
      cwd: projectDirectory,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, expectedStatus, `Packed skill command failed: ${result.stderr}`);
    assert.equal(result.stderr, '', 'Packed skill command emitted unexpected diagnostics');
    return result.stdout;
  };

  const packageRoot = path.join(projectDirectory, 'node_modules', 'tmux-team');
  const source = path.join(packageRoot, 'skills', 'tmux-team', 'SKILL.md');
  const content = fs.readFileSync(source, 'utf8');
  assert.equal(run(['learn', '--skill']), content, 'Skill viewer must preserve exact bundled text');
  const sourceParent = path.dirname(path.dirname(source));
  const sourceSiblings = fs.readdirSync(sourceParent).sort();
  const overlap = JSON.parse(run(['install', '--dir', sourceParent, '--force', '--json'], 1));
  assert.ok(overlap.error, 'Overlapping custom target must fail explicitly');
  assert.equal(fs.readFileSync(source, 'utf8'), content);
  assert.deepEqual(fs.readdirSync(sourceParent).sort(), sourceSiblings);
  const installed = JSON.parse(run(['install', 'all', '--json']));
  assert.deepEqual(
    installed.installed.map((item) => item.agent),
    ['claude', 'codex', 'gemini']
  );
  const universal = path.join(home, '.agents', 'skills', 'tmux-team');
  const claude = path.join(home, '.claude', 'commands', 'team.md');
  assert.ok(fs.lstatSync(universal).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(universal, 'SKILL.md'), 'utf8'), content);
  assert.ok(fs.lstatSync(claude).isSymbolicLink());
  assert.equal(
    fs.readFileSync(claude, 'utf8'),
    fs.readFileSync(path.join(packageRoot, 'skills', 'claude', 'team.md'), 'utf8')
  );

  const customRoot = path.join(projectDirectory, 'custom skills');
  fs.mkdirSync(customRoot);
  const sibling = path.join(customRoot, 'unrelated.txt');
  fs.writeFileSync(sibling, 'preserve this sibling');
  const custom = JSON.parse(run(['install', '--dir', './custom skills', '--json']));
  const target = path.join(fs.realpathSync(customRoot), 'tmux-team');
  assert.equal(custom.installed.length, 1);
  assert.equal(custom.installed[0].target, target);
  assert.equal(custom.installed[0].changed, true);
  assert.ok(fs.lstatSync(target).isSymbolicLink());
  assert.equal(fs.realpathSync(target), fs.realpathSync(path.dirname(source)));
  const repeated = JSON.parse(run(['install', '--dir', './custom skills', '--json']));
  assert.equal(repeated.installed[0].changed, false);
  assert.equal(fs.readFileSync(sibling, 'utf8'), 'preserve this sibling');

  // Only the disposable installed package is changed, proving links and the
  // viewer follow source updates without writing to the host's installed skill.
  const updated = `${content}\nPacked verification update.\n`;
  fs.writeFileSync(source, updated);
  assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), updated);
  assert.equal(fs.readFileSync(path.join(universal, 'SKILL.md'), 'utf8'), updated);
  assert.equal(run(['learn', '--skill']), updated);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const tarball = path.resolve(options.packageTarball);
  if (!fs.existsSync(tarball) || !tarball.endsWith('.tgz')) {
    throw new Error(`Package tarball does not exist or is not a .tgz file: ${tarball}`);
  }
  verifyArchitecture(options.expectedArch, options.expectedLibc);

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-team-packed-'));
  const projectDirectory = path.join(temporaryRoot, 'project');
  const cacheDirectory = path.join(temporaryRoot, 'npm-cache');
  fs.mkdirSync(projectDirectory);
  fs.mkdirSync(cacheDirectory);
  try {
    fs.writeFileSync(
      path.join(projectDirectory, 'package.json'),
      JSON.stringify({ name: 'tmux-team-packed-install-check', private: true, version: '0.0.0' }) +
        '\n'
    );
    installPackage({ projectDirectory, tarball, cacheDirectory });
    loadAndVerifySqlite(projectDirectory, options.expectedLibc);
    verifyPackedCli(projectDirectory);
    verifyPackedSkills(projectDirectory);
    console.log(
      `Packed install verified: ${process.platform}/${process.arch}/${
        options.expectedLibc === 'auto' ? 'detected libc' : options.expectedLibc
      }`
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
