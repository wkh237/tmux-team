import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  expectError,
  fileSnapshot,
  parseWholeStdout,
  runCli,
  withSandbox,
} from '../support/cli-process.js';

if (!process.env.TMT_TEST_CLI) throw new Error('Select the native build with TMT_TEST_CLI.');

describe('native configuration process boundary', () => {
  it('retains JavaScript numeric semantics and insertion order in opaque fields', async () => {
    await withSandbox(async (sandbox) => {
      fs.mkdirSync(sandbox.globalDir, { recursive: true });
      const bytes =
        '{"zFuture":9007199254740993,"aFuture":{"values":[1e400,-1e400,-0,3]},"preambleMode":"always"}';
      fs.writeFileSync(sandbox.globalConfig, bytes);
      const shown = await runCli(sandbox, ['config', '--json']);
      expect(shown.status).toBe(0);
      expect(parseWholeStdout(shown)).toMatchObject({ resolved: { preambleMode: 'always' } });
      expect(fs.readFileSync(sandbox.globalConfig, 'utf8')).toBe(bytes);
      const edited = await runCli(sandbox, [
        'config',
        'set',
        'preambleMode',
        'disabled',
        '--global',
        '--json',
      ]);
      expect(edited.status).toBe(0);
      const expected = JSON.parse(bytes);
      expected.preambleMode = 'disabled';
      expect(fs.readFileSync(sandbox.globalConfig, 'utf8')).toBe(
        `${JSON.stringify(expected, null, 2)}\n`
      );
      fs.writeFileSync(sandbox.globalConfig, '{"defaults":{"timeout":1e400}}');
      const invalid = await runCli(sandbox, ['config', '--json']);
      expect(invalid.status).toBe(1);
      expect(expectError(invalid, 'CONFIG_ERROR').error).toMatchObject({
        message: expect.stringContaining('(defaults.timeout)'),
      });
    });
  });

  it('normalizes XDG parent components without requiring discarded directories', async () => {
    await withSandbox(async (sandbox) => {
      sandbox.env.XDG_CONFIG_HOME = path.join(sandbox.root, 'missing') + '/../resolved';
      const shown = await runCli(sandbox, ['config', '--json']);
      expect(shown.status).toBe(0);
      const config = path.join(sandbox.root, 'resolved', 'tmux-team', 'config.json');
      expect(parseWholeStdout(shown)).toMatchObject({ paths: { global: config } });
      expect(
        (await runCli(sandbox, ['config', 'set', 'ui.paneBadge', 'on', '--global', '--json']))
          .status
      ).toBe(0);
      expect(JSON.parse(fs.readFileSync(config, 'utf8'))).toEqual({ ui: { paneBadge: 'on' } });
      expect(fs.existsSync(path.join(sandbox.root, 'missing'))).toBe(false);
    });
  });

  it('normalizes HOME before selecting an existing legacy configuration', async () => {
    await withSandbox(async (sandbox) => {
      sandbox.env.HOME = path.join(sandbox.root, 'missing') + '/../resolved-home';
      delete sandbox.env.XDG_CONFIG_HOME;
      const config = path.join(sandbox.root, 'resolved-home', '.tmux-team', 'config.json');
      fs.mkdirSync(path.dirname(config), { recursive: true });
      fs.writeFileSync(config, '{"ui":{"paneBadge":"on"}}');
      const before = fileSnapshot(sandbox.root);
      const shown = await runCli(sandbox, ['config', '--json']);
      expect(shown.status).toBe(0);
      expect(parseWholeStdout(shown)).toMatchObject({
        paths: { global: config },
        resolved: { ui: { paneBadge: 'on' } },
      });
      expect(fileSnapshot(sandbox.root)).toEqual(before);
      expect(fs.existsSync(path.join(sandbox.root, 'missing'))).toBe(false);
    });
  });

  it('preserves a file blocking the configuration directory on write failure', async () => {
    await withSandbox(async (sandbox) => {
      fs.mkdirSync(sandbox.xdgConfigHome, { recursive: true });
      fs.writeFileSync(sandbox.globalDir, 'unrelated user file');
      const before = fileSnapshot(sandbox.root);
      const result = await runCli(sandbox, [
        'config',
        'set',
        'ui.paneBadge',
        'on',
        '--global',
        '--json',
      ]);
      expect(result.status).toBe(1);
      expectError(result, 'INTERNAL_ERROR');
      expect(fileSnapshot(sandbox.root)).toEqual(before);
    });
  });

  it('validates known settings and containers before projecting overrides', async () => {
    for (const [global, local] of [
      [null, {}],
      [[], {}],
      [{ defaults: null }, {}],
      [{ exchange: [] }, {}],
      [{ ui: { paneBadge: true } }, {}],
      [{ defaults: { timeout: '180' } }, {}],
      [{ defaults: { pollInterval: 0 } }, {}],
      [{ defaults: { captureLines: 0.5 } }, {}],
      [{ exchange: { retentionDays: 3651 } }, {}],
      [{ defaults: { preambleEvery: null } }, { $config: { preambleEvery: 3 } }],
      [{}, { $config: [] }],
      [{}, { $config: { pasteEnterDelayMs: null } }],
    ]) {
      await withSandbox(async (sandbox) => {
        fs.mkdirSync(sandbox.globalDir, { recursive: true });
        fs.writeFileSync(sandbox.globalConfig, JSON.stringify(global));
        fs.writeFileSync(sandbox.localConfig, JSON.stringify(local));
        const before = fileSnapshot(sandbox.root);
        const result = await runCli(sandbox, ['config', 'show', '--json']);
        expect(result.status).toBe(1);
        expectError(result, 'CONFIG_ERROR');
        expect(fileSnapshot(sandbox.root)).toEqual(before);
        expect(fs.existsSync(sandbox.database)).toBe(false);
      });
    }
  });

  it('reports malformed JSON without replacing or repairing it', async () => {
    await withSandbox(async (sandbox) => {
      fs.writeFileSync(sandbox.localConfig, '{ not json');
      const before = fileSnapshot(sandbox.root);
      const result = await runCli(sandbox, ['config', 'set', 'preambleEvery', '4', '--json']);
      expect(result.status).toBe(1);
      expect(expectError(result, 'CONFIG_ERROR').error).toMatchObject({
        message: expect.stringContaining(sandbox.localConfig),
      });
      expect(fileSnapshot(sandbox.root)).toEqual(before);
    });
  });

  it('keeps global-only settings out of local edits and ignores opaque local copies', async () => {
    await withSandbox(async (sandbox) => {
      fs.writeFileSync(
        sandbox.localConfig,
        JSON.stringify({
          $config: { exchange: { retentionDays: 1 }, ui: { paneBadge: 'on' }, future: true },
        })
      );
      const before = fileSnapshot(sandbox.root);
      for (const args of [
        ['config', 'set', 'exchange.retentionDays', '1'],
        ['config', 'set', 'ui.paneBadge', 'on'],
        ['config', 'clear', 'exchange.retentionDays'],
        ['config', 'clear', 'ui.paneBadge'],
      ]) {
        const result = await runCli(sandbox, [...args, '--json']);
        expect(result.status).toBe(1);
        expectError(result, 'ERROR');
        expect(fileSnapshot(sandbox.root)).toEqual(before);
      }
      const shown = await runCli(sandbox, ['config', '--json']);
      expect(shown.status).toBe(0);
      expect(parseWholeStdout(shown)).toMatchObject({
        resolved: { exchange: { retentionDays: 90 }, ui: { paneBadge: 'off' } },
      });
      expect(fileSnapshot(sandbox.root)).toEqual(before);
    });
  });

  it('distinguishes absent-container clear, clear-all and obsolete-key repair', async () => {
    await withSandbox(async (sandbox) => {
      const before = fileSnapshot(sandbox.root);
      const missing = await runCli(sandbox, ['config', 'clear', 'preambleEvery', '--json']);
      expect(missing.status).toBe(0);
      expect(parseWholeStdout(missing)).toEqual({ ok: true });
      expect(fileSnapshot(sandbox.root)).toEqual(before);
      expect((await runCli(sandbox, ['config', 'clear', '--json'])).status).toBe(0);
      expect(JSON.parse(fs.readFileSync(sandbox.localConfig, 'utf8'))).toEqual({});
      fs.writeFileSync(
        sandbox.localConfig,
        JSON.stringify({
          keep: 'data',
          $config: { mode: 'legacy' },
        })
      );
      expect((await runCli(sandbox, ['config', 'clear', 'mode', '--json'])).status).toBe(0);
      expect(JSON.parse(fs.readFileSync(sandbox.localConfig, 'utf8'))).toEqual({ keep: 'data' });
    });
  });

  it('finds the nearest ancestor settings file and edits that file only', async () => {
    await withSandbox(async (sandbox) => {
      const nested = path.join(sandbox.cwd, 'child', 'nested');
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(sandbox.localConfig, JSON.stringify({ $config: { preambleEvery: 8 } }));
      const child = { ...sandbox, cwd: nested };
      const shown = await runCli(child, ['config', '--json']);
      expect(shown.status).toBe(0);
      expect(parseWholeStdout(shown)).toMatchObject({
        resolved: { preambleEvery: 8 },
        sources: { preambleEvery: 'local' },
        paths: { local: fs.realpathSync(sandbox.localConfig) },
      });
      expect((await runCli(child, ['config', 'set', 'preambleEvery', '9', '--json'])).status).toBe(
        0
      );
      expect(JSON.parse(fs.readFileSync(sandbox.localConfig, 'utf8'))).toEqual({
        $config: { preambleEvery: 9 },
      });
      expect(fs.readdirSync(nested)).toEqual([]);
      expect(fs.existsSync(sandbox.database)).toBe(false);
    });
  });

  it.each(['new', 'legacy-empty', 'legacy-config', 'both-config', 'xdg-empty'])(
    'preserves %s global directory selection without creating state',
    async (scenario) => {
      await withSandbox(async (sandbox) => {
        delete sandbox.env.XDG_CONFIG_HOME;
        const xdg = path.join(sandbox.home, '.config', 'tmux-team');
        const legacy = path.join(sandbox.home, '.tmux-team');
        if (scenario !== 'new') fs.mkdirSync(legacy, { recursive: true });
        if (
          scenario === 'legacy-config' ||
          scenario === 'both-config' ||
          scenario === 'xdg-empty'
        ) {
          fs.writeFileSync(path.join(legacy, 'config.json'), '{}');
        }
        if (scenario === 'both-config' || scenario === 'xdg-empty')
          fs.mkdirSync(xdg, { recursive: true });
        if (scenario === 'both-config') fs.writeFileSync(path.join(xdg, 'config.json'), '{}');
        const before = fileSnapshot(sandbox.root);
        const shown = await runCli(sandbox, ['config', '--json']);
        expect(shown.status).toBe(0);
        const expected = scenario === 'new' || scenario === 'both-config' ? xdg : legacy;
        expect(parseWholeStdout(shown)).toMatchObject({
          paths: { global: path.join(expected, 'config.json') },
        });
        expect(fileSnapshot(sandbox.root)).toEqual(before);
      });
    }
  );

  it('honors the explicit directory override within the isolated process group', async () => {
    await withSandbox(async (sandbox) => {
      const override = path.join(sandbox.root, "custom root's files");
      // The common launcher intentionally removes ambient TMUX_TEAM_HOME.
      // env introduces this explicit fixture-only value inside its bounded child
      // group; no shell expansion or production environment bypass is added.
      const selected = {
        ...sandbox,
        cli: {
          executable: '/usr/bin/env',
          args: [`TMUX_TEAM_HOME=${override}`, sandbox.cli.executable, ...sandbox.cli.args],
        },
      };
      const result = await runCli(selected, [
        'config',
        'set',
        'ui.paneBadge',
        'on',
        '--global',
        '--json',
      ]);
      expect(result.status).toBe(0);
      expect(parseWholeStdout(result)).toEqual({ ok: true });
      expect(JSON.parse(fs.readFileSync(path.join(override, 'config.json'), 'utf8'))).toEqual({
        ui: { paneBadge: 'on' },
      });
      expect(fs.existsSync(sandbox.globalDir)).toBe(false);
      expect(fs.existsSync(path.join(override, 'tmux-team.db'))).toBe(false);
    });
  });
});
