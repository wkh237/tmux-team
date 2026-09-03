#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

function usage() {
  console.log(`verify-packed-native-install

Usage:
  node scripts/verify-packed-native-install.mjs --package-tarball <path>
    [--expected-arch x64|arm64] [--expected-libc glibc|musl|none]

The verifier installs the packed package into an isolated temporary project,
blocks compiler fallback, loads better-sqlite3's native binding, and executes
an FTS5 query.
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
