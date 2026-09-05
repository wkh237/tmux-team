import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Context, UI } from '../types.js';
import type { RequestService } from '../request-service.js';
import { ResponseError } from '../domain/response.js';
import { encodeReplyReceipt } from '../reply-receipt.js';
import { cmdReply } from './reply.js';
import { cmdResult } from './result.js';

const endpoint = {
  serverId: 'server-1',
  socketPath: '/tmp/tmt.sock',
  serverPid: 1234,
  serverStartTime: 'start',
  paneId: '%1',
  panePid: 5678,
} as const;

const tempFiles: string[] = [];

afterEach(() => {
  for (const file of tempFiles.splice(0)) fs.rmSync(file, { force: true });
});

function createContext(
  requestService: Partial<RequestService>,
  json = true
): Context & { output: unknown[] } {
  const output: unknown[] = [];
  const ui: UI = {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    table: vi.fn(),
    json: (value: unknown) => output.push(value),
  };
  return {
    output,
    argv: [],
    flags: { json, verbose: false },
    ui,
    config: {} as Context['config'],
    tmux: {} as Context['tmux'],
    identityService: {} as Context['identityService'],
    requestService: requestService as RequestService,
    paths: {} as Context['paths'],
    exit: ((code: number) => {
      throw Object.assign(new Error(`exit(${code})`), { exitCode: code });
    }) as Context['exit'],
  };
}

describe('reply and result command adapters', () => {
  it('keeps unavailable human errors on the error channel and hides unexpected error details', () => {
    const missing = createContext({ getResponse: () => undefined }, false);
    expect(() => cmdResult(missing, { kind: 'result', requestId: 'missing' })).toThrow('exit(3)');
    expect(missing.ui.info).not.toHaveBeenCalled();
    expect(missing.ui.error).toHaveBeenCalledWith(
      "Response for request 'missing' is not available."
    );
    const failed = createContext({
      getResponse: () => {
        throw new Error('private endpoint details');
      },
    });
    expect(() => cmdResult(failed, { kind: 'result', requestId: 'request' })).toThrow('exit(1)');
    expect(failed.output).toEqual([
      { error: { code: 'RESPONSE_ERROR', message: 'Could not retrieve response.' } },
    ]);
  });

  it('reads the complete file and emits only the submitted acknowledgement fields', async () => {
    const file = path.join(os.tmpdir(), `tmt-reply-${process.pid}-${Date.now()}.txt`);
    tempFiles.push(file);
    const body = '\ufefffirst\r\n\u0000日本語\n';
    fs.writeFileSync(file, Buffer.from(body, 'utf8'));
    const requestId = 'request-1';
    const receipt = encodeReplyReceipt({
      version: 1,
      requestId,
      attemptId: 'attempt-1',
      endpoint,
    });
    const submitResponse = vi.fn(() => ({
      requestId,
      attemptId: 'attempt-1',
      endpoint,
      body,
      bodyBytes: Buffer.byteLength(body),
      submittedAtMs: 99,
    }));
    const ctx = createContext({ submitResponse });

    await cmdReply(ctx, { kind: 'reply', requestId, receipt, file });

    expect(submitResponse).toHaveBeenCalledWith({
      requestId,
      attemptId: 'attempt-1',
      endpoint,
      body,
    });
    expect(ctx.output).toEqual([
      { status: 'submitted', requestId, bodyBytes: Buffer.byteLength(body), submittedAtMs: 99 },
    ]);
    expect(JSON.stringify(ctx.output)).not.toContain(receipt);
    expect(JSON.stringify(ctx.output)).not.toContain(endpoint.socketPath);
  });

  it('maps receipt and service errors without opening storage for invalid input', async () => {
    const submitResponse = vi.fn();
    const ctx = createContext({ submitResponse });
    const invalid = path.join(os.tmpdir(), `tmt-invalid-${process.pid}-${Date.now()}.txt`);
    tempFiles.push(invalid);
    fs.writeFileSync(invalid, 'should not be read');

    await expect(
      cmdReply(ctx, {
        kind: 'reply',
        requestId: 'request-1',
        receipt: 'not-a-receipt',
        file: invalid,
      })
    ).rejects.toMatchObject({ exitCode: 1 });
    expect(submitResponse).not.toHaveBeenCalled();
    expect(ctx.output).toEqual([
      { error: { code: 'RESPONSE_RECEIPT_INVALID', message: expect.any(String) } },
    ]);
    expect(JSON.stringify(ctx.output)).not.toContain('not-a-receipt');
  });

  it('maps a final conflict to exit 5 and does not expose the attempted body', async () => {
    const file = path.join(os.tmpdir(), `tmt-conflict-${process.pid}-${Date.now()}.txt`);
    tempFiles.push(file);
    fs.writeFileSync(file, 'different body');
    const requestId = 'request-1';
    const receipt = encodeReplyReceipt({ version: 1, requestId, attemptId: 'attempt-1', endpoint });
    const submitResponse = vi.fn(() => {
      throw new ResponseError('RESPONSE_CONFLICT', 'different final response');
    });
    const ctx = createContext({ submitResponse });

    await expect(cmdReply(ctx, { kind: 'reply', requestId, receipt, file })).rejects.toMatchObject({
      exitCode: 5,
    });
    expect(ctx.output).toEqual([
      { error: { code: 'RESPONSE_CONFLICT', message: 'different final response' } },
    ]);
    expect(JSON.stringify(ctx.output)).not.toContain('different body');
  });

  it('returns an exact completed result without receipt or endpoint fields', () => {
    const response = {
      requestId: 'request-1',
      attemptId: 'attempt-1',
      endpoint,
      body: '\ufeffbody\r\n日本語\u0000',
      bodyBytes: Buffer.byteLength('\ufeffbody\r\n日本語\u0000'),
      submittedAtMs: 123,
    };
    const ctx = createContext({ getResponse: vi.fn(() => response) });

    cmdResult(ctx, { kind: 'result', requestId: response.requestId });

    expect(ctx.output).toEqual([
      {
        status: 'completed',
        requestId: response.requestId,
        response: response.body,
        bodyBytes: response.bodyBytes,
        submittedAtMs: response.submittedAtMs,
      },
    ]);
    expect(JSON.stringify(ctx.output)).not.toContain(response.attemptId);
    expect(JSON.stringify(ctx.output)).not.toContain(endpoint.socketPath);
  });

  it('uses one unavailable result for pending, unknown, and expired bodies', () => {
    for (const requestId of ['pending', 'unknown', 'expired']) {
      const ctx = createContext({ getResponse: vi.fn(() => undefined) });
      expect(() => cmdResult(ctx, { kind: 'result', requestId })).toThrow(/exit\(3\)/);
      expect(ctx.output).toEqual([
        {
          status: 'unavailable',
          requestId,
          error: {
            code: 'RESPONSE_NOT_AVAILABLE',
            message: `Response for request '${requestId}' is not available.`,
          },
        },
      ]);
    }
  });
});
