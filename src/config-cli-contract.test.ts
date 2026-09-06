import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodeReplyReceipt } from './reply-receipt.js';
import { createRequestService } from './request-service.js';
import { openIdentityRepository } from './storage/identity-repository.js';
import {
  expectError,
  fileSnapshot,
  parseWholeStdout,
  runCli,
  withSandbox,
  type Sandbox,
} from './test-support/cli-process.js';

const endpoint = {
  serverId: 'config-contract-server',
  socketPath: '/tmp/config-contract.sock',
  serverPid: 1234,
  serverStartTime: 'config-contract-start',
  paneId: '%1',
  panePid: 5678,
} as const;

function seedReply(sandbox: Sandbox, requestId: string): string {
  const repository = openIdentityRepository(sandbox.database);
  try {
    const service = createRequestService({ repository, now: () => Date.now() });
    const prepared = service.prepare({
      requestId,
      endpoint,
      wait: false,
      expiresAtMs: Date.now() + 60 * 60 * 1000,
    });
    service.beginSend(prepared.attemptId);
    service.settle(prepared.attemptId, 'sent');
    return encodeReplyReceipt({
      version: 1,
      requestId,
      attemptId: prepared.attemptId,
      endpoint,
    });
  } finally {
    repository.close();
  }
}

function writeGlobal(sandbox: Sandbox, value: unknown): string {
  const bytes = JSON.stringify(value);
  if (bytes === undefined) throw new Error('Expected a JSON value for the global config fixture.');
  fs.mkdirSync(sandbox.globalDir, { recursive: true });
  fs.writeFileSync(sandbox.globalConfig, bytes);
  return bytes;
}

function writeLocal(sandbox: Sandbox, value: unknown): string {
  const bytes = JSON.stringify(value);
  if (bytes === undefined) throw new Error('Expected a JSON value for the local config fixture.');
  fs.writeFileSync(sandbox.localConfig, bytes);
  return bytes;
}

describe('real CLI configuration contract', () => {
  it('rejects invalid loaded shapes and numeric policies without rewriting files', async () => {
    const invalidCases: Array<{ label: string; scope: 'global' | 'local'; value: unknown }> = [
      { label: 'global null root', scope: 'global', value: null },
      { label: 'global array root', scope: 'global', value: [] },
      { label: 'global null defaults', scope: 'global', value: { defaults: null } },
      { label: 'global array defaults', scope: 'global', value: { defaults: [] } },
      {
        label: 'null known global value',
        scope: 'global',
        value: { defaults: { pasteEnterDelayMs: null } },
      },
      { label: 'unknown preamble mode', scope: 'global', value: { preambleMode: 'poll' } },
      { label: 'zero timeout', scope: 'global', value: { defaults: { timeout: 0 } } },
      {
        label: 'timeout over one day',
        scope: 'global',
        value: { defaults: { timeout: 86_400.001 } },
      },
      { label: 'zero poll interval', scope: 'global', value: { defaults: { pollInterval: 0 } } },
      {
        label: 'fractional capture lines',
        scope: 'global',
        value: { defaults: { captureLines: 1.5 } },
      },
      {
        label: 'preamble frequency beyond safe integer',
        scope: 'global',
        value: { defaults: { preambleEvery: 9_007_199_254_740_992 } },
      },
      {
        label: 'negative preamble frequency',
        scope: 'local',
        value: { $config: { preambleEvery: -1 } },
      },
      {
        label: 'fractional preamble frequency',
        scope: 'local',
        value: { $config: { preambleEvery: 1.5 } },
      },
      {
        label: 'string paste delay',
        scope: 'local',
        value: { $config: { pasteEnterDelayMs: '1.5' } },
      },
      {
        label: 'negative paste delay',
        scope: 'local',
        value: { $config: { pasteEnterDelayMs: -1 } },
      },
      {
        label: 'null known local value',
        scope: 'local',
        value: { $config: { preambleEvery: null } },
      },
      { label: 'local null root', scope: 'local', value: null },
      { label: 'local array root', scope: 'local', value: [] },
      { label: 'local array settings', scope: 'local', value: { $config: [] } },
    ];

    for (const invalid of invalidCases) {
      await withSandbox(async (sandbox) => {
        const bytes =
          invalid.scope === 'global'
            ? writeGlobal(sandbox, invalid.value)
            : writeLocal(sandbox, invalid.value);
        const before = fileSnapshot(sandbox.root);
        const result = await runCli(sandbox, ['list', '--json']);

        expect(result.status, invalid.label).toBe(1);
        expectError(result, 'CONFIG_ERROR');
        expect(fileSnapshot(sandbox.root), invalid.label).toEqual(before);
        expect(
          fs.readFileSync(
            invalid.scope === 'global' ? sandbox.globalConfig : sandbox.localConfig,
            'utf8'
          )
        ).toBe(bytes);
        expect(fs.existsSync(sandbox.database), invalid.label).toBe(false);
      });
    }
  }, 30_000);

  it('rejects null known values even when another config tier overrides them', async () => {
    for (const [globalValue, localValue] of [
      [{ defaults: { pasteEnterDelayMs: null } }, { $config: { pasteEnterDelayMs: 0 } }],
      [{ defaults: { preambleEvery: 3 } }, { $config: { preambleEvery: null } }],
    ] as const) {
      await withSandbox(async (sandbox) => {
        const globalBytes = writeGlobal(sandbox, globalValue);
        const localBytes = writeLocal(sandbox, localValue);
        const before = fileSnapshot(sandbox.root);
        const result = await runCli(sandbox, ['list', '--json']);

        expect(result.status).toBe(1);
        expectError(result, 'CONFIG_ERROR');
        expect(fileSnapshot(sandbox.root)).toEqual(before);
        expect(fs.readFileSync(sandbox.globalConfig, 'utf8')).toBe(globalBytes);
        expect(fs.readFileSync(sandbox.localConfig, 'utf8')).toBe(localBytes);
        expect(fs.existsSync(sandbox.database)).toBe(false);
      });
    }
  });

  it('accepts omitted defaults and local settings while retaining built-in defaults', async () => {
    await withSandbox(async (sandbox) => {
      writeGlobal(sandbox, { futureGlobal: { keep: true } });
      writeLocal(sandbox, { keep: true });
      const result = await runCli(sandbox, ['config', 'show', '--json']);

      expect(result.status).toBe(0);
      expect(parseWholeStdout(result)).toMatchObject({
        resolved: {
          preambleMode: 'always',
          preambleEvery: 3,
          pasteEnterDelayMs: 500,
          defaults: { timeout: 180, pollInterval: 1, captureLines: 100 },
        },
      });
    });
  });

  it('accepts safe preamble frequencies above the timer delay bound', async () => {
    await withSandbox(async (sandbox) => {
      writeGlobal(sandbox, { defaults: { preambleEvery: 2_147_483_648 } });
      const result = await runCli(sandbox, ['config', 'show', '--json']);

      expect(result.status).toBe(0);
      expect(parseWholeStdout(result)).toMatchObject({
        resolved: { preambleEvery: 2_147_483_648 },
      });
    });
  });

  it('keeps unknown and retired keys opaque while applying valid precedence and zero values', async () => {
    await withSandbox(async (sandbox) => {
      const globalBytes = writeGlobal(sandbox, {
        preambleMode: 'disabled',
        mode: 'retired-global-mode',
        futureGlobal: { keep: true },
        defaults: {
          timeout: 86_400,
          pollInterval: 0.25,
          captureLines: 0,
          preambleEvery: 7,
          pasteEnterDelayMs: 1.5,
          maxCaptureLines: 999,
          futureDefault: 'opaque',
        },
      });
      const localBytes = writeLocal(sandbox, {
        keep: { value: true },
        $config: {
          mode: 'retired-local-mode',
          preambleMode: 'always',
          preambleEvery: 0,
          futureLocal: ['opaque'],
        },
      });

      const result = await runCli(sandbox, ['config', 'show', '--json']);
      expect(result.status).toBe(0);
      const document = parseWholeStdout(result) as {
        resolved: {
          preambleMode: string;
          preambleEvery: number;
          pasteEnterDelayMs: number;
          defaults: Record<string, unknown>;
        };
      };
      expect(document.resolved).toMatchObject({
        preambleMode: 'always',
        preambleEvery: 0,
        pasteEnterDelayMs: 1.5,
        defaults: {
          timeout: 86_400,
          pollInterval: 0.25,
          captureLines: 0,
        },
      });
      expect(document.resolved.defaults).not.toHaveProperty('maxCaptureLines');
      expect(document.resolved.defaults).not.toHaveProperty('futureDefault');
      expect(document.resolved).not.toHaveProperty('mode');
      expect(fs.readFileSync(sandbox.globalConfig, 'utf8')).toBe(globalBytes);
      expect(fs.readFileSync(sandbox.localConfig, 'utf8')).toBe(localBytes);
    });
  });

  it('rejects decimal, out-of-range, and unknown setters without writing files', async () => {
    await withSandbox(async (sandbox) => {
      writeLocal(sandbox, {
        keep: true,
        $config: { preambleEvery: 3, pasteEnterDelayMs: 500 },
      });
      const before = fileSnapshot(sandbox.root);
      for (const [key, value] of [
        ['preambleEvery', '1.5'],
        ['preambleEvery', '12junk'],
        ['preambleEvery', ' 12'],
        ['preambleEvery', '+12'],
        ['preambleEvery', '9007199254740992'],
        ['preambleEvery', '-1'],
        ['pasteEnterDelayMs', '1.5'],
        ['pasteEnterDelayMs', '12junk'],
        ['pasteEnterDelayMs', '12\n'],
        ['pasteEnterDelayMs', ' 12'],
        ['pasteEnterDelayMs', '+12'],
        ['pasteEnterDelayMs', '2147483648'],
        ['pasteEnterDelayMs', '-1'],
        ['futureKey', '1'],
      ]) {
        const result = await runCli(sandbox, ['config', 'set', key, value, '--json']);
        expect(result.status, `${key}=${value}`).toBe(1);
        expectError(result, 'ERROR');
        expect(fileSnapshot(sandbox.root), `${key}=${value}`).toEqual(before);
      }
    });
  }, 30_000);

  it('repairs a targeted invalid setting while preserving partial global defaults and opaque siblings', async () => {
    await withSandbox(async (sandbox) => {
      writeGlobal(sandbox, {
        defaults: { timeout: 240, futureDefault: { keep: true } },
      });
      writeLocal(sandbox, {
        keep: 'opaque',
        $config: { preambleEvery: 'invalid', pasteEnterDelayMs: 500 },
      });

      const repaired = await runCli(sandbox, ['config', 'set', 'preambleEvery', '4', '--json']);
      expect(repaired.status).toBe(0);
      expect(JSON.parse(fs.readFileSync(sandbox.localConfig, 'utf8'))).toEqual({
        keep: 'opaque',
        $config: { preambleEvery: 4, pasteEnterDelayMs: 500 },
      });

      const globalSet = await runCli(sandbox, [
        'config',
        'set',
        'preambleEvery',
        '0',
        '--global',
        '--json',
      ]);
      expect(globalSet.status).toBe(0);
      expect(JSON.parse(fs.readFileSync(sandbox.globalConfig, 'utf8'))).toEqual({
        defaults: {
          timeout: 240,
          preambleEvery: 0,
          futureDefault: { keep: true },
        },
      });
    });
  });

  it('allows zero setters and repairs only the targeted invalid local setting', async () => {
    await withSandbox(async (sandbox) => {
      writeLocal(sandbox, {
        keep: 'opaque',
        $config: { preambleEvery: 3, pasteEnterDelayMs: 500 },
      });
      expect(
        (await runCli(sandbox, ['config', 'set', 'preambleEvery', '0', '--json'])).status
      ).toBe(0);
      expect(
        (await runCli(sandbox, ['config', 'set', 'pasteEnterDelayMs', '0', '--json'])).status
      ).toBe(0);
      const shown = await runCli(sandbox, ['config', 'show', '--json']);
      expect(shown.status).toBe(0);
      expect(parseWholeStdout(shown)).toMatchObject({
        resolved: { preambleEvery: 0, pasteEnterDelayMs: 0 },
      });

      writeLocal(sandbox, {
        keep: 'opaque',
        $config: { preambleEvery: 'invalid', pasteEnterDelayMs: 0 },
      });
      const repaired = await runCli(sandbox, ['config', 'clear', 'preambleEvery', '--json']);
      expect(repaired.status).toBe(0);
      expect(JSON.parse(fs.readFileSync(sandbox.localConfig, 'utf8'))).toEqual({
        keep: 'opaque',
        $config: { pasteEnterDelayMs: 0 },
      });

      const invalidRemainder = JSON.stringify({
        keep: 'opaque',
        $config: { preambleEvery: 'invalid', pasteEnterDelayMs: 'invalid' },
      });
      fs.writeFileSync(sandbox.localConfig, invalidRemainder);
      const rejected = await runCli(sandbox, ['config', 'clear', 'preambleEvery', '--json']);
      expect(rejected.status).toBe(1);
      expectError(rejected, 'CONFIG_ERROR');
      expect(fs.readFileSync(sandbox.localConfig, 'utf8')).toBe(invalidRemainder);
    });
  });

  it('keeps storage-only reply and result usable with malformed configuration', async () => {
    await withSandbox(async (sandbox) => {
      const requestId = 'config-independent-response';
      const receipt = seedReply(sandbox, requestId);
      writeGlobal(sandbox, { defaults: { captureLines: 'invalid' } });
      const body = 'storage-only despite malformed config';

      const submitted = await runCli(sandbox, [
        'reply',
        requestId,
        '--receipt',
        receipt,
        '--message',
        body,
        '--json',
      ]);
      expect(submitted.status).toBe(0);
      expect(parseWholeStdout(submitted)).toMatchObject({
        status: 'submitted',
        requestId,
        bodyBytes: Buffer.byteLength(body),
      });

      const retrieved = await runCli(sandbox, ['result', requestId, '--json']);
      expect(retrieved.status).toBe(0);
      expect(parseWholeStdout(retrieved)).toMatchObject({
        status: 'completed',
        requestId,
        response: body,
      });
      expect(fs.existsSync(sandbox.database)).toBe(true);
    });
  });

  it('does not let malformed unrelated local settings affect a public result lookup', async () => {
    await withSandbox(async (sandbox) => {
      const requestId = 'config-independent-missing-result';
      seedReply(sandbox, requestId);
      writeLocal(sandbox, { $config: { preambleEvery: 'invalid' } });
      const result = await runCli(sandbox, ['result', 'missing-result', '--json']);
      expect(result.status).toBe(3);
      expectError(result, 'RESPONSE_NOT_AVAILABLE');
    });
  });
});
