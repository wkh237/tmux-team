import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(relativePath: string): Record<string, unknown> {
  const filePath = path.join(repoRoot, relativePath);
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

const packageVersion = readJson('package.json').version;

if (typeof packageVersion !== 'string') {
  throw new TypeError('package.json must define a string version');
}

describe('version', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reads VERSION from package.json when possible', async () => {
    vi.resetModules();
    const { VERSION } = await import('./version.js');

    expect(VERSION).toBe(packageVersion);
  });

  it('keeps package and Claude plugin manifest versions synchronized', () => {
    const marketplaceJson = readJson('.claude-plugin/marketplace.json');
    const pluginJson = readJson('plugins/tmux-team/.claude-plugin/plugin.json');
    const marketplacePlugins = marketplaceJson.plugins;

    expect(Array.isArray(marketplacePlugins)).toBe(true);
    const marketplacePlugin = (marketplacePlugins as Array<Record<string, unknown>>).find(
      (plugin) => plugin.name === 'tmux-team'
    );
    expect(marketplacePlugin).toBeDefined();
    expect(marketplacePlugin?.version).toBe(packageVersion);
    expect(pluginJson.version).toBe(packageVersion);
  });

  it('falls back to hardcoded version when package.json read fails', async () => {
    vi.resetModules();
    vi.doMock('fs', () => ({
      default: {
        readFileSync: () => {
          throw new Error('read fail');
        },
      },
      readFileSync: () => {
        throw new Error('read fail');
      },
    }));

    const { VERSION } = await import('./version.js');
    expect(VERSION).toBe(packageVersion);
  });
});
