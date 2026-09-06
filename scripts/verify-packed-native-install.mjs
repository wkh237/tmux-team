#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runPackedCommand } from './packed-command.mjs';
import { verifyPackedArtifact } from './packed-artifact-policy.mjs';

function usage() {
  console.log(`verify-packed-native-install

Usage:
  node scripts/verify-packed-native-install.mjs --package-tarball <path>
    [--expected-arch x64|arm64] [--expected-libc glibc|musl|none]

The verifier installs the packed package into an isolated temporary project,
blocks compiler fallback, loads better-sqlite3's native binding, and executes
an FTS5 query, verifies application migrations and role persistence, rejects
test-only package artifacts, and verifies bundled skills and isolated installation.
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
  return execFileSync('which', ['npm'], { encoding: 'utf8', timeout: 5_000 }).trim();
}

function installPackage({ projectDirectory, tarball, cacheDirectory, env }) {
  const npmPath = findNpm();
  const result = spawnSync(
    npmPath,
    ['install', '--no-audit', '--no-fund', '--no-package-lock', '--ignore-scripts', tarball],
    {
      cwd: projectDirectory,
      encoding: 'utf8',
      timeout: 120_000,
      killSignal: 'SIGKILL',
      env: {
        ...env,
        npm_config_cache: cacheDirectory,
        npm_config_userconfig: path.join(env.HOME, '.npmrc'),
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

function isolatedEnvironment(projectDirectory) {
  const home = path.join(projectDirectory, 'home');
  fs.mkdirSync(home);
  const temporaryDirectory = path.join(home, 'tmp');
  fs.mkdirSync(temporaryDirectory);
  const env = {
    ...process.env,
    HOME: home,
    CODEX_HOME: path.join(home, '.codex'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    TMUX_TEAM_HOME: path.join(home, 'tmt'),
    TMPDIR: temporaryDirectory,
  };
  for (const key of ['TMUX', 'TMUX_PANE', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
  return env;
}

function verifyPackedCli(projectDirectory, env) {
  const executable = path.join(projectDirectory, 'node_modules', '.bin', 'tmt');
  const output = runPackedCommand(executable, ['--version'], {
    cwd: projectDirectory,
    env,
  });
  assert.match(output, /^\d+\.\d+\.\d+(?:-[\w.]+)?\s*$/);
}

function verifyPackedSkills(projectDirectory, env, providers) {
  const executable = path.join(projectDirectory, 'node_modules', '.bin', 'tmt');
  const home = env.HOME;
  const run = (args, expectedStatus = 0) =>
    runPackedCommand(executable, args, {
      cwd: projectDirectory,
      env,
      expectedStatus,
    });

  const legacyClaudeCommand = path.join(home, '.claude', 'commands', 'team.md');
  fs.mkdirSync(path.dirname(legacyClaudeCommand), { recursive: true });
  fs.writeFileSync(legacyClaudeCommand, 'legacy Claude command\n');

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
    providers
  );
  assert.deepEqual(
    Object.fromEntries(installed.installed.map((item) => [item.agent, item.target])),
    {
      claude: path.join(home, '.claude', 'skills', 'tmux-team'),
      codex: path.join(home, '.agents', 'skills', 'tmux-team'),
      gemini: path.join(home, '.agents', 'skills', 'tmux-team'),
    },
    'Provider installs must use only the canonical skill targets'
  );
  const universal = path.join(home, '.agents', 'skills', 'tmux-team');
  const claude = path.join(home, '.claude', 'skills', 'tmux-team');
  assert.ok(fs.lstatSync(universal).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(universal, 'SKILL.md'), 'utf8'), content);
  assert.ok(fs.lstatSync(claude).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(claude, 'SKILL.md'), 'utf8'), content);
  assert.equal(fs.realpathSync(universal), fs.realpathSync(path.dirname(source)));
  assert.equal(fs.realpathSync(claude), fs.realpathSync(path.dirname(source)));
  assert.ok(fs.existsSync(legacyClaudeCommand), 'The legacy Claude command should be preserved');
  const legacyContent = fs.readFileSync(legacyClaudeCommand, 'utf8');
  assert.equal(legacyContent, 'legacy Claude command\n');

  const repeatedDefault = JSON.parse(run(['install', 'all', '--json']));
  assert.deepEqual(
    repeatedDefault.installed.map((item) => item.changed),
    providers.map(() => false),
    'Repeating installation should be a no-op for managed canonical links'
  );

  // An unmanaged canonical Claude target must remain untouched unless force
  // is explicit, while the old command path above remains user-owned.
  fs.rmSync(claude, { recursive: true, force: true });
  fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, 'user-owned.md'), 'keep this file\n');
  const refused = JSON.parse(run(['install', 'all', '--json'], 1));
  assert.ok(refused.error, 'Unmanaged canonical content must require --force');
  assert.equal(fs.readFileSync(path.join(claude, 'user-owned.md'), 'utf8'), 'keep this file\n');
  assert.equal(fs.readFileSync(legacyClaudeCommand, 'utf8'), legacyContent);
  const forced = JSON.parse(run(['install', 'all', '--force', '--json']));
  const claudeInstall = forced.installed.find((item) => item.agent === 'claude');
  assert.equal(claudeInstall.changed, true);
  assert.ok(claudeInstall.backup, 'Force installation should report the recoverable backup');
  assert.equal(
    fs.readFileSync(path.join(claudeInstall.backup, 'user-owned.md'), 'utf8'),
    'keep this file\n'
  );
  assert.ok(fs.lstatSync(claude).isSymbolicLink());
  assert.equal(fs.existsSync(legacyClaudeCommand), false);
  assert.deepEqual(claudeInstall.legacyBackups?.length, 1);
  assert.equal(fs.readFileSync(claudeInstall.legacyBackups[0], 'utf8'), legacyContent);

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
  assert.equal(fs.readFileSync(path.join(claude, 'SKILL.md'), 'utf8'), updated);
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
  try {
    fs.mkdirSync(projectDirectory);
    fs.mkdirSync(cacheDirectory);
    fs.writeFileSync(
      path.join(projectDirectory, 'package.json'),
      JSON.stringify({ name: 'tmux-team-packed-install-check', private: true, version: '0.0.0' }) +
        '\n'
    );
    const env = isolatedEnvironment(projectDirectory);
    installPackage({ projectDirectory, tarball, cacheDirectory, env });
    const packageRoot = path.join(projectDirectory, 'node_modules', 'tmux-team');
    verifyPackedArtifact(packageRoot);
    const installedRequire = createRequire(path.join(packageRoot, 'package.json'));
    const loader = pathToFileURL(installedRequire.resolve('tsx/esm')).href;
    loadAndVerifySqlite(projectDirectory, options.expectedLibc);
    verifyPackedCli(projectDirectory, env);
    const runNode = (args, timeoutMs = 10_000) =>
      runPackedCommand(process.execPath, ['--import', loader, ...args], {
        cwd: projectDirectory,
        env,
        timeoutMs,
      });
    const providers = JSON.parse(
      runNode([
        '--input-type=module',
        '--eval',
        `const { SKILL_AGENTS } = await import(${JSON.stringify(pathToFileURL(path.join(packageRoot, 'src/skill-installation.ts')).href)}); console.log(JSON.stringify(SKILL_AGENTS));`,
      ])
    );
    verifyPackedSkills(projectDirectory, env, providers);
    const probe = fileURLToPath(new URL('./packed-storage-probe.mjs', import.meta.url));
    assert.equal(runNode([probe, packageRoot], 60_000).trim(), 'Packed storage verified.');
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
