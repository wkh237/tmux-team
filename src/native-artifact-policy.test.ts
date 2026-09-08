import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGzip } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import * as tar from 'tar';
import { runCli, withSandbox, type Sandbox } from './test-support/cli-process.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { selectNativeArtifact, withNativeArtifact } = (await import(
  pathToFileURL(path.join(repositoryRoot, 'scripts', 'native-artifact-policy.mjs')).href
)) as unknown as {
  selectNativeArtifact: (
    manifestFile: string,
    archiveFile: string,
    target: string
  ) => NativeArtifact;
  withNativeArtifact: <T>(
    archiveFile: string,
    metadata: NativeArtifact,
    inspect: (root: string) => Promise<T> | T
  ) => Promise<T>;
};

const REQUIRED_FILES = ['tmt', 'LICENSE', 'NATIVE-INSTALL.md', 'THIRD-PARTY-NOTICES.txt'];
const TARGET = 'aarch64-apple-darwin';
const VERSION = '5.0.0-alpha.1';

interface NativeArtifact {
  readonly name: string;
  readonly version: string;
  readonly target: string;
  readonly sha256: string;
}

interface ArchiveOptions {
  readonly duplicate?: string;
  readonly executable?: boolean;
  readonly extra?: string;
  readonly link?: 'hard' | 'symlink';
  readonly omit?: string;
  readonly specialPermissions?: boolean;
  readonly traversal?: boolean;
}

interface ArchiveFixture {
  readonly archiveFile: string;
  readonly manifestFile: string;
  readonly manifest: Record<string, unknown>;
  readonly metadata: NativeArtifact;
}

function archiveName(target = TARGET): string {
  return `tmux-team-${VERSION}-${target}.tar.gz`;
}

async function createArchiveFixture(
  sandbox: Sandbox,
  options: ArchiveOptions = {}
): Promise<ArchiveFixture> {
  const name = archiveName();
  const rootName = name.slice(0, -'.tar.gz'.length);
  const fixtureRoot = fs.mkdtempSync(path.join(sandbox.root, 'archive-fixture-'));
  const tree = path.join(fixtureRoot, 'archive tree');
  const root = path.join(tree, rootName);
  const archiveFile = path.join(fixtureRoot, name);
  const manifestFile = path.join(fixtureRoot, 'manifest.json');
  fs.mkdirSync(root, { recursive: true });

  for (const file of REQUIRED_FILES) {
    if (file === options.omit) continue;
    const target = path.join(root, file);
    fs.writeFileSync(target, `${file} fixture\n`, { mode: file === 'tmt' ? 0o755 : 0o644 });
  }
  if (options.executable === false) fs.chmodSync(path.join(root, 'tmt'), 0o644);
  if (options.specialPermissions) fs.chmodSync(path.join(root, 'tmt'), 0o4755);
  if (options.extra !== undefined) {
    fs.writeFileSync(path.join(root, options.extra), 'unexpected test fixture\n');
  }
  if (options.link === 'symlink') {
    fs.unlinkSync(path.join(root, 'LICENSE'));
    fs.symlinkSync('../../outside', path.join(root, 'LICENSE'));
  } else if (options.link === 'hard') {
    fs.unlinkSync(path.join(root, 'LICENSE'));
    fs.linkSync(path.join(root, 'tmt'), path.join(root, 'LICENSE'));
  }

  const entries = [rootName];
  const tarOptions = {
    cwd: tree,
    file: archiveFile,
    gzip: true,
    portable: options.specialPermissions !== true,
  };
  if (options.traversal) {
    fs.writeFileSync(path.join(fixtureRoot, 'escape'), 'traversal fixture\n');
    entries.push('../escape');
    Object.assign(tarOptions, { preservePaths: true });
  }
  if (options.specialPermissions) {
    Object.assign(tarOptions, {
      onWriteEntry(entry: { path: string; stat: { mode: number } }) {
        if (entry.path === `${rootName}/tmt`) entry.stat.mode = 0o4755;
      },
    });
  }
  if (options.duplicate !== undefined) entries.push(path.join(rootName, options.duplicate));
  await tar.c(tarOptions, entries);
  const sha256 = createHash('sha256').update(fs.readFileSync(archiveFile)).digest('hex');
  const manifest = {
    artifacts: {
      [name]: {
        kind: 'executable-zip',
        name,
        target_triples: [TARGET],
        checksums: { sha256 },
        assets: REQUIRED_FILES.map((file) => ({ path: file })),
      },
    },
    releases: [{ app_version: VERSION, artifacts: [name] }],
  };
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest)}\n`);
  return {
    archiveFile,
    manifestFile,
    manifest,
    metadata: selectNativeArtifact(manifestFile, archiveFile, TARGET),
  };
}

function withArtifactMetadata(sha256: string): NativeArtifact {
  return {
    name: archiveName(),
    version: VERSION,
    target: TARGET,
    sha256,
  };
}

describe('native artifact policy', () => {
  it.each([
    ['notices', 'stale notices', 'Native archive notices differ from the generated inventory'],
    ['license', 'stale license', 'Native archive license differs from the selected source'],
    ['notices', 'Copyright (c) <year>', 'Dependency notices contain placeholder attribution'],
  ])('fails the verifier process for invalid %s evidence', async (changed, content, diagnostic) => {
    await withSandbox(async (sandbox) => {
      const fixture = await createArchiveFixture(sandbox);
      const architecture = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
      const platform = process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl';
      const target = `${architecture}-${platform}`;
      const artifact = (fixture.manifest.artifacts as Record<string, Record<string, unknown>>)[
        archiveName()
      ];
      artifact.target_triples = [target];
      fs.writeFileSync(fixture.manifestFile, JSON.stringify(fixture.manifest));
      const notices = path.join(sandbox.root, 'selected-notices.txt');
      const license = path.join(sandbox.root, 'selected-license.txt');
      fs.writeFileSync(
        notices,
        changed === 'notices' ? content : 'THIRD-PARTY-NOTICES.txt fixture\n'
      );
      fs.writeFileSync(license, changed === 'license' ? content : 'LICENSE fixture\n');
      const result = await runCli(
        {
          ...sandbox,
          cli: {
            executable: process.execPath,
            args: [path.join(repositoryRoot, 'scripts/verify-native-artifact.mjs')],
          },
        },
        [
          '--manifest',
          fixture.manifestFile,
          '--archive',
          fixture.archiveFile,
          '--target',
          target,
          '--skill',
          license,
          '--notices',
          notices,
          '--license',
          license,
        ]
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(diagnostic);
    });
  });

  it('rejects a manifest target mismatch and a missing checksum', async () => {
    await withSandbox(async (sandbox) => {
      const targetFixture = await createArchiveFixture(sandbox);
      const mismatched = structuredClone(targetFixture.manifest) as Record<string, unknown>;
      const artifact = (mismatched.artifacts as Record<string, Record<string, unknown>>)[
        archiveName()
      ];
      artifact.target_triples = ['x86_64-unknown-linux-musl'];
      fs.writeFileSync(targetFixture.manifestFile, JSON.stringify(mismatched));
      expect(() =>
        selectNativeArtifact(targetFixture.manifestFile, targetFixture.archiveFile, TARGET)
      ).toThrow('Manifest target mismatch');

      const checksumFixture = await createArchiveFixture(sandbox);
      const missingChecksum = structuredClone(checksumFixture.manifest) as Record<string, unknown>;
      const missingArtifact = (
        missingChecksum.artifacts as Record<string, Record<string, unknown>>
      )[archiveName()];
      missingArtifact.checksums = {};
      fs.writeFileSync(checksumFixture.manifestFile, JSON.stringify(missingChecksum));
      expect(() =>
        selectNativeArtifact(checksumFixture.manifestFile, checksumFixture.archiveFile, TARGET)
      ).toThrow('Manifest requires SHA-256');
    });
  });

  it('rejects malformed asset inventories and release membership', async () => {
    await withSandbox(async (sandbox) => {
      const assetFixture = await createArchiveFixture(sandbox);
      const malformedAssets = structuredClone(assetFixture.manifest) as Record<string, unknown>;
      const assetArtifact = (malformedAssets.artifacts as Record<string, Record<string, unknown>>)[
        archiveName()
      ];
      assetArtifact.assets = [{ path: 'tmt' }];
      fs.writeFileSync(assetFixture.manifestFile, JSON.stringify(malformedAssets));
      expect(() =>
        selectNativeArtifact(assetFixture.manifestFile, assetFixture.archiveFile, TARGET)
      ).toThrow('Manifest must describe exactly the native runtime files');

      const releaseFixture = await createArchiveFixture(sandbox);
      const missingRelease = structuredClone(releaseFixture.manifest) as Record<string, unknown>;
      missingRelease.releases = [];
      fs.writeFileSync(releaseFixture.manifestFile, JSON.stringify(missingRelease));
      expect(() =>
        selectNativeArtifact(releaseFixture.manifestFile, releaseFixture.archiveFile, TARGET)
      ).toThrow('Archive must belong to exactly one release');
    });
  });

  it('accepts four regular files, returns the inspector value, and cleans staging', async () => {
    await withSandbox(async (sandbox) => {
      const fixture = await createArchiveFixture(sandbox);
      const sentinel = path.join(sandbox.root, 'unrelated sentinel.txt');
      fs.writeFileSync(sentinel, 'preserve me\n');
      let extracted: string | undefined;

      const result = await withNativeArtifact(fixture.archiveFile, fixture.metadata, (root) => {
        extracted = root;
        expect(fs.readdirSync(root).sort()).toEqual([...REQUIRED_FILES].sort());
        expect(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8')).toBe('LICENSE fixture\n');
        expect(fs.statSync(path.join(root, 'tmt')).mode & 0o111).not.toBe(0);
        expect(fs.readFileSync(sentinel, 'utf8')).toBe('preserve me\n');
        return 'inspected';
      });

      expect(result).toBe('inspected');
      expect(extracted).toBeDefined();
      expect(fs.existsSync(extracted as string)).toBe(false);
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('preserve me\n');
    });
  });

  it('rejects an archive checksum mismatch before invoking the callback', async () => {
    await withSandbox(async (sandbox) => {
      const fixture = await createArchiveFixture(sandbox);
      const original = fs.readFileSync(fixture.archiveFile);
      let called = false;
      const metadata = { ...fixture.metadata, sha256: '0'.repeat(64) };

      await expect(
        withNativeArtifact(fixture.archiveFile, metadata, () => {
          called = true;
        })
      ).rejects.toThrow('Native archive checksum mismatch');
      expect(called).toBe(false);
      expect(fs.readFileSync(fixture.archiveFile)).toEqual(original);
    });
  });

  it('rejects an invalid metadata archive name before reading the archive', async () => {
    await withSandbox(async (sandbox) => {
      const fixture = await createArchiveFixture(sandbox);
      const original = fs.readFileSync(fixture.archiveFile);
      let called = false;

      await expect(
        withNativeArtifact(fixture.archiveFile, { ...fixture.metadata, name: '...tar.gz' }, () => {
          called = true;
        })
      ).rejects.toThrow('Invalid native archive name');
      expect(called).toBe(false);
      expect(fs.readFileSync(fixture.archiveFile)).toEqual(original);
    });
  });

  it('rejects oversized compressed input before allocating its contents', async () => {
    await withSandbox(async (sandbox) => {
      const fixture = await createArchiveFixture(sandbox);
      const descriptor = fs.openSync(fixture.archiveFile, 'r+');
      try {
        fs.ftruncateSync(descriptor, 64 * 1024 * 1024 + 1);
      } finally {
        fs.closeSync(descriptor);
      }
      let called = false;

      await expect(
        withNativeArtifact(fixture.archiveFile, fixture.metadata, () => {
          called = true;
        })
      ).rejects.toThrow('Artifact input must be a bounded regular file');
      expect(called).toBe(false);
    });
  });

  it('rejects a truncated gzip after recomputing its checksum', async () => {
    await withSandbox(async (sandbox) => {
      const fixture = await createArchiveFixture(sandbox);
      const compressed = fs.readFileSync(fixture.archiveFile);
      const truncated = compressed.subarray(0, compressed.length - 8);
      fs.writeFileSync(fixture.archiveFile, truncated);
      const metadata = withArtifactMetadata(createHash('sha256').update(truncated).digest('hex'));

      await expect(
        withNativeArtifact(fixture.archiveFile, metadata, () => undefined)
      ).rejects.toThrow(/unexpected end/i);
    });
  });

  it('rejects missing notices and a non-executable runtime', async () => {
    await withSandbox(async (sandbox) => {
      const missingNotice = await createArchiveFixture(sandbox, {
        omit: 'THIRD-PARTY-NOTICES.txt',
      });
      await expect(
        withNativeArtifact(missingNotice.archiveFile, missingNotice.metadata, () => undefined)
      ).rejects.toThrow(
        'Missing native archive entry: tmux-team-5.0.0-alpha.1-aarch64-apple-darwin/THIRD-PARTY-NOTICES.txt'
      );

      const missingExecutable = await createArchiveFixture(sandbox, { omit: 'tmt' });
      await expect(
        withNativeArtifact(
          missingExecutable.archiveFile,
          missingExecutable.metadata,
          () => undefined
        )
      ).rejects.toThrow(
        'Missing native archive entry: tmux-team-5.0.0-alpha.1-aarch64-apple-darwin/tmt'
      );

      const nonExecutable = await createArchiveFixture(sandbox, { executable: false });
      await expect(
        withNativeArtifact(nonExecutable.archiveFile, nonExecutable.metadata, () => undefined)
      ).rejects.toThrow('Native executable lacks execute permission');
    });
  });

  it('rejects special permission bits on an otherwise executable runtime', async () => {
    await withSandbox(async (sandbox) => {
      const fixture = await createArchiveFixture(sandbox, { specialPermissions: true });

      await expect(
        withNativeArtifact(fixture.archiveFile, fixture.metadata, () => undefined)
      ).rejects.toThrow('Native archive must not set special permission bits');
    });
  });

  it('rejects a FIFO input through the bounded process helper', async () => {
    await withSandbox(async (sandbox) => {
      const fixture = await createArchiveFixture(sandbox);
      const fifo = path.join(sandbox.root, 'native archive fifo');
      const mkfifoSandbox = { ...sandbox, cli: { executable: '/usr/bin/mkfifo', args: [] } };
      const created = await runCli(mkfifoSandbox, [fifo]);
      expect(created.status).toBe(0);
      expect(created.signal).toBeNull();
      expect(created.stderr).toBe('');
      expect(fs.statSync(fifo).isFIFO()).toBe(true);
      // Put the subject, not just FIFO creation, behind the process deadline:
      // regressing to a blocking open must fail rather than hang the test runner.
      const moduleUrl = pathToFileURL(
        path.join(repositoryRoot, 'scripts/native-artifact-policy.mjs')
      ).href;
      const probe = `import { withNativeArtifact } from ${JSON.stringify(moduleUrl)};
await withNativeArtifact(process.argv[1], JSON.parse(process.argv[2]), () => console.log('unexpected extraction'));`;
      const result = await runCli(
        {
          ...sandbox,
          cli: { executable: process.execPath, args: ['--input-type=module', '--eval', probe] },
        },
        [fifo, JSON.stringify(fixture.metadata)]
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Artifact input must be a bounded regular file');
    });
  });

  it(
    'rejects expanded gzip input over the bound without allocating a giant test buffer',
    { timeout: 5_000 },
    async () => {
      await withSandbox(async (sandbox) => {
        const fixture = await createArchiveFixture(sandbox);
        const chunk = Buffer.alloc(256 * 1024, 0x61);
        const source = Readable.from(
          (async function* repeatedChunks() {
            for (let index = 0; index < 513; index += 1) yield chunk;
          })()
        );
        await pipeline(source, createGzip(), fs.createWriteStream(fixture.archiveFile));
        const compressed = fs.readFileSync(fixture.archiveFile);
        const metadata = withArtifactMetadata(
          createHash('sha256').update(compressed).digest('hex')
        );

        await expect(
          withNativeArtifact(fixture.archiveFile, metadata, () => undefined)
        ).rejects.toThrow(/larger than 134217728 bytes/i);
      });
    }
  );

  it('rejects unexpected test files and duplicate entries', async () => {
    await withSandbox(async (sandbox) => {
      const unexpected = await createArchiveFixture(sandbox, { extra: 'native.test.ts' });
      await expect(
        withNativeArtifact(unexpected.archiveFile, unexpected.metadata, () => undefined)
      ).rejects.toThrow('Unexpected native archive entry');

      const duplicate = await createArchiveFixture(sandbox, { duplicate: 'LICENSE' });
      await expect(
        withNativeArtifact(duplicate.archiveFile, duplicate.metadata, () => undefined)
      ).rejects.toThrow('Duplicate native archive entry');
    });
  });

  it('rejects a regular path traversal entry before extraction', async () => {
    await withSandbox(async (sandbox) => {
      const fixture = await createArchiveFixture(sandbox, { traversal: true });
      await expect(
        withNativeArtifact(fixture.archiveFile, fixture.metadata, () => undefined)
      ).rejects.toThrow('Unexpected native archive entry: ../escape');
    });
  });

  it.each(['symlink', 'hard'] as const)(
    'rejects %s entries, including traversal links',
    async (link) => {
      await withSandbox(async (sandbox) => {
        const fixture = await createArchiveFixture(sandbox, { link });
        await expect(
          withNativeArtifact(fixture.archiveFile, fixture.metadata, () => undefined)
        ).rejects.toThrow('Native archive entry must be regular');
      });
    }
  );

  it('cleans staging after callback failure without removing an unrelated sentinel', async () => {
    await withSandbox(async (sandbox) => {
      const fixture = await createArchiveFixture(sandbox);
      const sentinel = path.join(sandbox.root, 'unrelated sentinel.txt');
      fs.writeFileSync(sentinel, 'preserve me\n');
      let extracted: string | undefined;

      await expect(
        withNativeArtifact(fixture.archiveFile, fixture.metadata, (root) => {
          extracted = root;
          throw new Error('inspection failed');
        })
      ).rejects.toThrow('inspection failed');
      expect(extracted).toBeDefined();
      expect(fs.existsSync(extracted as string)).toBe(false);
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('preserve me\n');
    });
  });
});
