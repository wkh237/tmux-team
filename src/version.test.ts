import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('version', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reads VERSION from package.json when possible', async () => {
    vi.resetModules();
    const { VERSION } = await import('./version.js');
    expect(typeof VERSION).toBe('string');
    expect(VERSION.length).toBeGreaterThan(0);
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
    expect(VERSION).toBe('3.0.1');
  });
});
