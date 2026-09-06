import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getLegacyCodexDirectories } from './skill-installation.js';

describe('skill-installation legacy candidate resolution', () => {
  it('deduplicates equivalent paths in candidate order when CODEX_HOME matches default .codex', () => {
    const home = '/test/user/home';
    const codexHome = path.join(home, '.codex');
    const candidates = getLegacyCodexDirectories(home, codexHome);
    expect(candidates).toEqual([path.join(home, '.codex', 'skills', 'tmux-team')]);
  });

  it('deduplicates equivalent unnormalized candidate paths without pre-normalizing input', () => {
    const home = '/test/user/home';
    // Raw unnormalized candidate path containing redundant relative and dot segments
    const codexHome = `${home}/nested/../.codex/.`;
    const candidates = getLegacyCodexDirectories(home, codexHome);
    expect(candidates).toHaveLength(1);
    expect(path.resolve(candidates[0])).toBe(
      path.resolve(path.join(home, '.codex', 'skills', 'tmux-team'))
    );
  });

  it('preserves installer preference order for a distinct custom CODEX_HOME', () => {
    const home = '/test/user/home';
    const customCodexHome = '/opt/custom/codex';
    const candidates = getLegacyCodexDirectories(home, customCodexHome);
    expect(candidates).toEqual([
      path.join(customCodexHome, 'skills', 'tmux-team'),
      path.join(home, '.codex', 'skills', 'tmux-team'),
    ]);
  });

  it('excludes active managed .agents target when CODEX_HOME is configured to .agents', () => {
    const home = '/test/user/home';
    const codexHome = path.join(home, '.agents');
    const candidates = getLegacyCodexDirectories(home, codexHome);
    expect(candidates).toEqual([path.join(home, '.codex', 'skills', 'tmux-team')]);
  });

  it('resolves expected paths for nonexistent paths without requiring disk entries', () => {
    const home = '/virtual/nonexistent/home';
    const codexHome = '/virtual/nonexistent/codex';
    const candidates = getLegacyCodexDirectories(home, codexHome);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toBe(path.join(codexHome, 'skills', 'tmux-team'));
    expect(candidates[1]).toBe(path.join(home, '.codex', 'skills', 'tmux-team'));
  });
});
