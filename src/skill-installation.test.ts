import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALL_SKILL_TARGET,
  getLegacyClaudeCommand,
  getLegacyCodexDirectories,
  getOpenCodeConfigDirectory,
  getPiCodingAgentDirectory,
  getUniversalSkillSource,
  getSkillConfigs,
  isSkillAgent,
  SKILL_AGENTS,
} from './skill-installation.js';

const ambientPiDirectory = process.env.PI_CODING_AGENT_DIR;
const ambientXdgDirectory = process.env.XDG_CONFIG_HOME;
const ambientOpenCodeDirectory = process.env.OPENCODE_CONFIG_DIR;

beforeEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.OPENCODE_CONFIG_DIR;
});

afterEach(() => {
  if (ambientPiDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = ambientPiDirectory;
  if (ambientXdgDirectory === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = ambientXdgDirectory;
  if (ambientOpenCodeDirectory === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = ambientOpenCodeDirectory;
});

describe('skill-installation provider inventory', () => {
  it('derives the typed provider set and skill config keys from one ordered list', () => {
    expect(SKILL_AGENTS).toEqual(['claude', 'codex', 'gemini', 'agy', 'pi', 'opencode']);
    expect(SKILL_AGENTS.every((agent) => isSkillAgent(agent))).toBe(true);
    expect(isSkillAgent(ALL_SKILL_TARGET)).toBe(false);
    const configs = getSkillConfigs('/package', '/home');
    expect(Object.keys(configs)).toEqual([...SKILL_AGENTS]);
    expect(configs.claude).toEqual({
      source: getUniversalSkillSource('/package'),
      target: '/home/.claude/skills/tmux-team',
    });
    expect(configs.codex).toEqual({
      source: getUniversalSkillSource('/package'),
      target: '/home/.agents/skills/tmux-team',
    });
    expect(configs.gemini).toEqual(configs.codex);
    expect(configs.opencode).toEqual(configs.codex);
    expect(configs.agy).toEqual({
      source: getUniversalSkillSource('/package'),
      target: '/home/.gemini/config/skills/tmux-team',
    });
    expect(configs.pi).toEqual({
      source: getUniversalSkillSource('/package'),
      target: '/home/.pi/agent/skills/tmux-team',
    });
    expect(getPiCodingAgentDirectory('/home')).toBe('/home/.pi/agent');
    expect(getOpenCodeConfigDirectory('/home')).toBe('/home/.config/opencode');
    expect(getLegacyClaudeCommand('/home')).toBe('/home/.claude/commands/team.md');
  });

  it('uses provider directory overrides without changing the canonical source', () => {
    const previousPiDirectory = process.env.PI_CODING_AGENT_DIR;
    const previousXdgDirectory = process.env.XDG_CONFIG_HOME;
    const previousOpenCodeDirectory = process.env.OPENCODE_CONFIG_DIR;
    process.env.PI_CODING_AGENT_DIR = '/custom/pi-agent';
    process.env.XDG_CONFIG_HOME = '/custom/config';
    delete process.env.OPENCODE_CONFIG_DIR;
    try {
      const configs = getSkillConfigs('/package', '/home');
      expect(configs.pi.target).toBe('/custom/pi-agent/skills/tmux-team');
      expect(configs.opencode.target).toBe('/home/.agents/skills/tmux-team');
      expect(getOpenCodeConfigDirectory('/home')).toBe('/custom/config/opencode');

      for (const [value, expected] of [
        ['~', '/home'],
        ['~/custom/pi', '/home/custom/pi'],
        ['/absolute/pi', '/absolute/pi'],
        ['relative/pi', path.resolve('relative/pi')],
      ]) {
        process.env.PI_CODING_AGENT_DIR = value;
        expect(getPiCodingAgentDirectory('/home')).toBe(expected);
      }

      process.env.OPENCODE_CONFIG_DIR = '/custom/opencode';
      expect(getOpenCodeConfigDirectory('/home')).toBe('/custom/opencode');
    } finally {
      if (previousPiDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousPiDirectory;
      if (previousXdgDirectory === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdgDirectory;
      if (previousOpenCodeDirectory === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = previousOpenCodeDirectory;
    }
  });
});

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
