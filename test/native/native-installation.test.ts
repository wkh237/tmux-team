import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as tar from 'tar';
import {
  expectError,
  parseWholeStdout,
  runCli,
  withSandbox,
  type Sandbox,
} from '../../src/test-support/cli-process.js';

if (!process.env.TMT_TEST_CLI) throw new Error('Select the native build with TMT_TEST_CLI.');

const REQUIRED_FILES = ['tmt', 'LICENSE', 'NATIVE-INSTALL.md', 'THIRD-PARTY-NOTICES.txt'];

type InstallResult = {
  readonly executable: string;
  readonly version: string;
  readonly changed: boolean;
};

type ArtifactFixture = {
  readonly archive: string;
  readonly manifest: string;
  readonly version: string;
  readonly target: string;
};

function nativeTarget(): string {
  const architecture =
    process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : null;
  const platform =
    process.platform === 'darwin'
      ? 'apple-darwin'
      : process.platform === 'linux'
        ? 'unknown-linux-musl'
        : null;
  if (architecture === null || platform === null)
    throw new Error(`Unsupported native test target: ${process.arch}-${process.platform}`);
  return `${architecture}-${platform}`;
}

async function createArtifact(
  sandbox: Sandbox,
  version: string,
  executableSuffix: Uint8Array = new Uint8Array()
): Promise<ArtifactFixture> {
  const target = nativeTarget();
  const name = `tmux-team-${version}-${target}.tar.gz`;
  const fixtureRoot = path.join(sandbox.root, 'native archive inputs with spaces');
  const tree = path.join(fixtureRoot, 'tree');
  const root = path.join(tree, name.slice(0, -'.tar.gz'.length));
  const archive = path.join(fixtureRoot, name);
  const manifest = path.join(fixtureRoot, 'manifest.json');
  mkdirSync(root, { recursive: true });
  copyFileSync(sandbox.cli.executable, path.join(root, 'tmt'));
  const executable = path.join(root, 'tmt');
  chmodSync(executable, 0o755);
  if (executableSuffix.byteLength > 0)
    writeFileSync(executable, Buffer.concat([readFileSync(executable), executableSuffix]));
  writeFileSync(path.join(root, 'LICENSE'), 'MIT\n');
  writeFileSync(path.join(root, 'NATIVE-INSTALL.md'), 'Native local installation fixture.\n');
  writeFileSync(path.join(root, 'THIRD-PARTY-NOTICES.txt'), 'Synthetic test notice fixture.\n');
  await tar.c({ cwd: tree, file: archive, gzip: true }, [path.basename(root)]);
  const checksum = createHash('sha256').update(readFileSync(archive)).digest('hex');
  writeFileSync(
    manifest,
    `${JSON.stringify({
      artifacts: {
        [name]: {
          kind: 'executable-zip',
          name,
          target_triples: [target],
          checksums: { sha256: checksum },
          assets: REQUIRED_FILES.map((file) => ({ path: file })),
        },
      },
      releases: [{ app_name: 'tmt-cli', app_version: version, artifacts: [name] }],
    })}\n`
  );
  return { archive, manifest, version, target };
}

function installPrefix(sandbox: Sandbox): string {
  return path.join(sandbox.root, 'native install prefix with spaces');
}

async function install(
  sandbox: Sandbox,
  fixture: ArtifactFixture,
  prefix: string,
  flags: readonly string[] = [],
  tmuxTeamHome?: string
): Promise<InstallResult> {
  const selected =
    tmuxTeamHome === undefined
      ? sandbox
      : {
          ...sandbox,
          cli: {
            executable: '/usr/bin/env',
            args: [`TMUX_TEAM_HOME=${tmuxTeamHome}`, sandbox.cli.executable, ...sandbox.cli.args],
          },
        };
  const result = await runCli(selected, [
    '__native-install',
    '--archive',
    fixture.archive,
    '--manifest',
    fixture.manifest,
    '--prefix',
    prefix,
    '--channel',
    'alpha',
    ...flags,
    '--json',
  ]);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return parseWholeStdout(result) as unknown as InstallResult;
}

function currentPointer(prefix: string): string {
  return path.join(prefix, 'lib', 'tmux-team', 'current');
}

function receiptPath(prefix: string): string {
  return path.join(currentPointer(prefix), 'receipt.json');
}

function currentReleaseId(prefix: string): string {
  return readlinkSync(currentPointer(prefix)).replace(/^releases\//, '');
}

function releaseIds(prefix: string): string[] {
  return readdirSync(path.join(prefix, 'lib', 'tmux-team', 'releases')).sort();
}

function receipt(prefix: string): Record<string, unknown> {
  return JSON.parse(readFileSync(receiptPath(prefix), 'utf8')) as Record<string, unknown>;
}

function artifactChecksum(fixture: ArtifactFixture): string {
  const manifest = JSON.parse(readFileSync(fixture.manifest, 'utf8')) as {
    artifacts: Record<string, { checksums: { sha256: string } }>;
  };
  return manifest.artifacts[path.basename(fixture.archive)].checksums.sha256;
}

describe('native installation process contract', () => {
  it(
    'installs a real copied native executable from spaced paths and runs it with an empty PATH',
    { timeout: 60_000 },
    async () => {
      await withSandbox(async (sandbox) => {
        const versionResult = await runCli(sandbox, ['--version']);
        expect(versionResult.status).toBe(0);
        expect(versionResult.stderr).toBe('');
        const version = versionResult.stdout.trim();
        expect(version).toMatch(/^\d+\.\d+\.\d+-alpha(?:\.[0-9A-Za-z-]+)?$/);
        const fixture = await createArtifact(sandbox, version);
        const prefix = installPrefix(sandbox);
        const installed = await install(sandbox, fixture, prefix);
        expect(installed).toEqual({
          executable: path.join(realpathSync(prefix), 'bin', 'tmt'),
          version,
          changed: true,
        });
        expect(readlinkSync(installed.executable)).toBe('../lib/tmux-team/current/tmt');
        expect(existsSync(sandbox.database)).toBe(false);

        sandbox.env.PATH = '';
        const moved = await runCli(
          { ...sandbox, cli: { executable: installed.executable, args: [] } },
          ['--version']
        );
        expect(moved.status).toBe(0);
        expect(moved.stdout).toBe(`${version}\n`);
        expect(moved.stderr).toBe('');
        expect(existsSync(sandbox.database)).toBe(false);
      });
    }
  );

  it(
    'repeats as a no-op while application-state selectors change',
    { timeout: 60_000 },
    async () => {
      await withSandbox(async (sandbox) => {
        const versionResult = await runCli(sandbox, ['--version']);
        const fixture = await createArtifact(sandbox, versionResult.stdout.trim());
        const prefix = installPrefix(sandbox);
        const first = await install(sandbox, fixture, prefix);
        const pointer = readlinkSync(currentPointer(prefix));
        const before = readFileSync(path.join(prefix, 'lib', 'tmux-team', pointer, 'tmt'));

        const firstHome = path.join(sandbox.root, 'unrelated tmux state one');
        const second = await install(sandbox, fixture, prefix, [], firstHome);
        const secondHome = path.join(sandbox.root, 'unrelated tmux state two');
        const third = await install(sandbox, fixture, prefix, [], secondHome);

        expect(first.changed).toBe(true);
        expect(second).toEqual({ ...first, changed: false });
        expect(third).toEqual({ ...first, changed: false });
        expect(readlinkSync(currentPointer(prefix))).toBe(pointer);
        expect(readFileSync(path.join(prefix, 'lib', 'tmux-team', pointer, 'tmt'))).toEqual(before);
        expect(releaseIds(prefix)).toHaveLength(1);
        expect(existsSync(firstHome)).toBe(false);
        expect(existsSync(secondHome)).toBe(false);
        expect(existsSync(sandbox.database)).toBe(false);
      });
    }
  );

  it(
    'records pin and unpin transitions while retaining the old release bytes',
    { timeout: 60_000 },
    async () => {
      await withSandbox(async (sandbox) => {
        const versionResult = await runCli(sandbox, ['--version']);
        const fixture = await createArtifact(sandbox, versionResult.stdout.trim());
        const prefix = installPrefix(sandbox);
        await install(sandbox, fixture, prefix);
        const originalId = currentReleaseId(prefix);
        const originalBytes = readFileSync(
          path.join(prefix, 'lib', 'tmux-team', 'releases', originalId, 'tmt')
        );

        const pinned = await install(sandbox, fixture, prefix, ['--pin']);
        const pinnedId = currentReleaseId(prefix);
        expect(pinned.changed).toBe(true);
        expect(pinnedId).not.toBe(originalId);
        expect(receipt(prefix)).toMatchObject({
          version: fixture.version,
          channel: 'alpha',
          pinned_version: fixture.version,
        });
        expect(
          readFileSync(path.join(prefix, 'lib', 'tmux-team', 'releases', originalId, 'tmt'))
        ).toEqual(originalBytes);

        const unpinned = await install(sandbox, fixture, prefix, ['--unpin']);
        const unpinnedId = currentReleaseId(prefix);
        expect(unpinned.changed).toBe(true);
        expect(unpinnedId).not.toBe(pinnedId);
        expect(receipt(prefix)).toMatchObject({
          version: fixture.version,
          channel: 'alpha',
          pinned_version: null,
        });
        expect(releaseIds(prefix)).toEqual([originalId, pinnedId, unpinnedId].sort());
        expect(
          readFileSync(path.join(prefix, 'lib', 'tmux-team', 'releases', originalId, 'tmt'))
        ).toEqual(originalBytes);
        expect(existsSync(sandbox.database)).toBe(false);
      });
    }
  );

  it(
    'rejects an equal-version artifact with changed file bytes even when its archive digest is forged into the receipt',
    { timeout: 60_000 },
    async () => {
      await withSandbox(async (sandbox) => {
        const versionResult = await runCli(sandbox, ['--version']);
        const version = versionResult.stdout.trim();
        const originalFixture = await createArtifact(sandbox, version);
        const prefix = installPrefix(sandbox);
        await install(sandbox, originalFixture, prefix);
        const pointer = readlinkSync(currentPointer(prefix));
        const originalExecutable = readFileSync(
          path.join(prefix, 'lib', 'tmux-team', pointer, 'tmt')
        );
        const originalReceipt = receipt(prefix);
        const candidate = await createArtifact(
          sandbox,
          version,
          Buffer.from('\nintentionally different candidate bytes\n')
        );
        const forgedReceipt = {
          ...originalReceipt,
          archive_sha256: artifactChecksum(candidate),
        };
        const forgedReceiptBytes = Buffer.from(`${JSON.stringify(forgedReceipt)}\n`);
        writeFileSync(receiptPath(prefix), forgedReceiptBytes);

        // This candidate is intentionally never executed; it only tests equal-version file integrity.
        const result = await runCli(sandbox, [
          '__native-install',
          '--archive',
          candidate.archive,
          '--manifest',
          candidate.manifest,
          '--prefix',
          prefix,
          '--channel',
          'alpha',
          '--json',
        ]);
        expect(result.status).toBe(1);
        expectError(
          result,
          'NATIVE_INSTALL_FAILED',
          'Installed target or equal-version artifact integrity does not match.'
        );
        expect(readlinkSync(currentPointer(prefix))).toBe(pointer);
        expect(readFileSync(path.join(prefix, 'lib', 'tmux-team', pointer, 'tmt'))).toEqual(
          originalExecutable
        );
        expect(readFileSync(receiptPath(prefix))).toEqual(forgedReceiptBytes);
        expect(receipt(prefix).file_sha256).toEqual(originalReceipt.file_sha256);
        expect(existsSync(sandbox.database)).toBe(false);
      });
    }
  );

  it(
    'refuses unmanaged collisions and a tampered receipt without changing owned bytes or pointer',
    { timeout: 60_000 },
    async () => {
      await withSandbox(async (sandbox) => {
        const versionResult = await runCli(sandbox, ['--version']);
        const fixture = await createArtifact(sandbox, versionResult.stdout.trim());
        const prefix = installPrefix(sandbox);
        mkdirSync(path.join(prefix, 'bin'), { recursive: true });
        const collision = path.join(prefix, 'bin', 'tmt');
        const collisionBytes = Buffer.from('user-owned command\n');
        writeFileSync(collision, collisionBytes);
        const collisionResult = await runCli(sandbox, [
          '__native-install',
          '--archive',
          fixture.archive,
          '--manifest',
          fixture.manifest,
          '--prefix',
          prefix,
          '--channel',
          'alpha',
          '--json',
        ]);
        expect(collisionResult.status).toBe(1);
        expectError(collisionResult, 'NATIVE_INSTALL_FAILED');
        expect(readFileSync(collision)).toEqual(collisionBytes);
        expect(existsSync(currentPointer(prefix))).toBe(false);

        const ownedPrefix = path.join(sandbox.root, 'owned prefix');
        await install(sandbox, fixture, ownedPrefix);
        const pointer = readlinkSync(currentPointer(ownedPrefix));
        const executable = readFileSync(path.join(ownedPrefix, 'lib', 'tmux-team', pointer, 'tmt'));
        writeFileSync(receiptPath(ownedPrefix), '{ malformed receipt');
        const tampered = await runCli(sandbox, [
          '__native-install',
          '--archive',
          fixture.archive,
          '--manifest',
          fixture.manifest,
          '--prefix',
          ownedPrefix,
          '--channel',
          'alpha',
          '--json',
        ]);
        expect(tampered.status).toBe(1);
        expectError(tampered, 'NATIVE_INSTALL_FAILED');
        expect(readlinkSync(currentPointer(ownedPrefix))).toBe(pointer);
        expect(readFileSync(path.join(ownedPrefix, 'lib', 'tmux-team', pointer, 'tmt'))).toEqual(
          executable
        );
        expect(existsSync(sandbox.database)).toBe(false);
      });
    }
  );

  it('keeps the internal installer out of help and completion output', async () => {
    await withSandbox(async (sandbox) => {
      const help = await runCli(sandbox, ['help']);
      expect(help.status).toBe(0);
      expect(help.stdout).not.toContain('__native-install');
      expect(help.stdout).not.toContain('--archive');
      for (const shell of ['bash', 'zsh']) {
        const completion = await runCli(sandbox, ['completion', shell]);
        expect(completion.status).toBe(0);
        expect(completion.stdout).not.toContain('__native-install');
        expect(completion.stdout).not.toContain('--archive');
      }
      expect(existsSync(sandbox.database)).toBe(false);
    });
  });
});
