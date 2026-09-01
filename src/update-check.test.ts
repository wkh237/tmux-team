import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  checkLatestVersion,
  inspectLocalDrift,
  isNewerVersion,
  runStartupChecks,
} from './update-check.js';
import type { Context } from './types.js';

describe('local installation drift', () => {
  let temp = '';
  afterEach(() => {
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
  });

  it('detects legacy Codex copies and wrong or broken managed links', () => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-team-drift-'));
    const root = path.join(temp, 'package');
    const home = path.join(temp, 'home');
    fs.mkdirSync(path.join(root, 'skills', 'tmux-team'), { recursive: true });
    fs.mkdirSync(path.join(root, 'skills', 'claude'), { recursive: true });
    fs.writeFileSync(path.join(root, 'skills', 'tmux-team', 'SKILL.md'), 'canonical');
    fs.writeFileSync(path.join(root, 'skills', 'claude', 'team.md'), 'claude');
    fs.mkdirSync(path.join(home, '.codex', 'skills', 'tmux-team'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'skills', 'tmux-team', 'SKILL.md'), 'old');
    fs.mkdirSync(path.join(home, '.agents', 'skills'), { recursive: true });
    fs.symlinkSync(
      path.join(temp, 'missing'),
      path.join(home, '.agents', 'skills', 'tmux-team'),
      'junction'
    );
    const issues = inspectLocalDrift({ home, root });
    expect(issues.some((issue) => issue.kind === 'legacy')).toBe(true);
    expect(issues.some((issue) => issue.kind === 'broken-link')).toBe(true);

    const wrongTarget = path.join(home, '.claude', 'commands', 'team.md');
    fs.mkdirSync(path.dirname(wrongTarget), { recursive: true });
    const wrongSource = path.join(temp, 'other-team.md');
    fs.writeFileSync(wrongSource, 'other');
    fs.symlinkSync(wrongSource, wrongTarget);
    expect(
      inspectLocalDrift({ home, root }).some(
        (issue) => issue.path === wrongTarget && issue.kind === 'wrong-link'
      )
    ).toBe(true);
    const customCodexHome = path.join(temp, 'custom-codex');
    fs.mkdirSync(path.join(customCodexHome, 'skills', 'tmux-team'), { recursive: true });
    fs.writeFileSync(path.join(customCodexHome, 'skills', 'tmux-team', 'SKILL.md'), 'old');
    expect(inspectLocalDrift({ home, root, codexHome: customCodexHome })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'legacy', path: expect.stringContaining('custom-codex') }),
      ])
    );
  });

  it('detects a Claude copied command only when its content differs', () => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-team-drift-'));
    const root = path.join(temp, 'package');
    const home = path.join(temp, 'home');
    fs.mkdirSync(path.join(root, 'skills', 'claude'), { recursive: true });
    fs.writeFileSync(path.join(root, 'skills', 'claude', 'team.md'), 'new');
    fs.mkdirSync(path.join(home, '.claude', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'commands', 'team.md'), 'old');
    expect(inspectLocalDrift({ home, root }).some((issue) => issue.kind === 'outdated-copy')).toBe(
      true
    );
  });
});

describe('version comparison', () => {
  it('recognizes strictly newer semver releases', () => {
    expect(isNewerVersion('4.3.0', '4.2.9')).toBe(true);
    expect(isNewerVersion('4.2.0', '4.2.0')).toBe(false);
    expect(isNewerVersion('4.2.0-beta.1', '4.2.0')).toBe(false);
    expect(isNewerVersion('4.2.0-beta.2', '4.2.0-beta.1')).toBe(true);
    expect(isNewerVersion('not-semver', '4.2.0')).toBe(false);
  });

  it('uses a fresh cache without contacting npm', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-team-cache-'));
    fs.writeFileSync(
      path.join(cacheDir, 'version-check.json'),
      JSON.stringify({ checkedAt: Date.now(), latestVersion: '9.0.0' })
    );
    await expect(checkLatestVersion(cacheDir, '4.2.0')).resolves.toBe('9.0.0');
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('does not report an equal cached version', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-team-cache-'));
    fs.writeFileSync(
      path.join(cacheDir, 'version-check.json'),
      JSON.stringify({ checkedAt: Date.now(), latestVersion: '4.2.0' })
    );
    await expect(checkLatestVersion(cacheDir, '4.2.0')).resolves.toBeUndefined();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('warns about a cached update during an interactive startup', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-team-cache-'));
    fs.writeFileSync(
      path.join(cacheDir, 'version-check.json'),
      JSON.stringify({ checkedAt: Date.now(), latestVersion: '9.0.0' })
    );
    const context = {
      flags: { json: false, verbose: false },
      paths: { globalDir: cacheDir, globalConfig: '', localConfig: '', stateFile: '' },
      ui: { warn: vi.fn() },
    } as unknown as Context;
    const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    try {
      await runStartupChecks(context, 'list');
      expect(context.ui.warn).toHaveBeenCalledWith(expect.stringContaining('tmt upgrade'));
    } finally {
      if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor);
      else Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: undefined });
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('skips startup checks for suppressed commands and JSON output', async () => {
    const warn = vi.fn();
    const context = {
      flags: { json: false, verbose: false },
      paths: { globalDir: '/nonexistent', globalConfig: '', localConfig: '', stateFile: '' },
      ui: { warn },
    } as unknown as Context;
    await runStartupChecks(context, 'install');
    context.flags.json = true;
    await runStartupChecks(context, 'list');
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports local drift during ordinary startup', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-team-startup-'));
    fs.mkdirSync(path.join(home, '.agents', 'skills'), { recursive: true });
    fs.symlinkSync(path.join(home, 'missing'), path.join(home, '.agents', 'skills', 'tmux-team'));
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(home);
    const warn = vi.fn();
    const context = {
      flags: { json: false, verbose: false },
      paths: { globalDir: home, globalConfig: '', localConfig: '', stateFile: '' },
      ui: { warn },
    } as unknown as Context;
    try {
      await runStartupChecks(context, 'list');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('tmt install --force'));
    } finally {
      homedir.mockRestore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('fetches and caches npm latest when the cache is stale', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-team-cache-'));
    fs.writeFileSync(
      path.join(cacheDir, 'version-check.json'),
      JSON.stringify({ checkedAt: Date.now() - 2 * 24 * 60 * 60 * 1000, latestVersion: '4.2.0' })
    );
    const request = new EventEmitter() as EventEmitter & {
      setTimeout: () => void;
      destroy: () => void;
    };
    request.setTimeout = vi.fn();
    request.destroy = vi.fn();
    const response = new EventEmitter() as EventEmitter & { setEncoding: () => void };
    response.setEncoding = vi.fn();
    const get = vi.spyOn(https, 'get').mockImplementation(((
      _url: string,
      _options: unknown,
      callback: (value: EventEmitter & { setEncoding: () => void }) => void
    ) => {
      callback(response);
      queueMicrotask(() => {
        response.emit('data', '{"version":"9.0.0"}');
        response.emit('end');
      });
      return request;
    }) as never);
    try {
      await expect(checkLatestVersion(cacheDir, '4.2.0')).resolves.toBe('9.0.0');
      expect(get).toHaveBeenCalled();
      expect(
        JSON.parse(fs.readFileSync(path.join(cacheDir, 'version-check.json'), 'utf8')).latestVersion
      ).toBe('9.0.0');
    } finally {
      get.mockRestore();
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
