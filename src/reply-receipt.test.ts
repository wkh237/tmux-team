import { describe, expect, it } from 'vitest';
import {
  MAX_REPLY_RECEIPT_LENGTH,
  ReplyReceiptError,
  decodeReplyReceipt,
  encodeReplyReceipt,
  type ReplyReceipt,
} from './reply-receipt.js';

const endpoint = {
  serverId: 'server-1',
  socketPath: '/tmp/tmt-test.sock',
  serverPid: 1234,
  serverStartTime: '2026-09-06T00:00:00.000Z',
  paneId: '%17',
  panePid: 5678,
} as const;

const receipt: ReplyReceipt = {
  version: 1,
  requestId: 'request-α',
  attemptId: 'attempt-1',
  endpoint,
};

function expectReceiptError(action: () => unknown, code: ReplyReceiptError['code']): void {
  try {
    action();
    expect.fail('expected receipt validation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(ReplyReceiptError);
    expect((error as ReplyReceiptError).code).toBe(code);
  }
}

describe('reply receipt codec', () => {
  it('round-trips a canonical unpadded base64url envelope with the exact fence', () => {
    const encoded = encodeReplyReceipt(receipt);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain('=');
    expect(decodeReplyReceipt(encoded)).toEqual(receipt);
    expect(decodeReplyReceipt(encoded, receipt.requestId)).toEqual(receipt);
    expect(encodeReplyReceipt(decodeReplyReceipt(encoded))).toBe(encoded);
  });

  it('accepts valid JSON key reordering while rejecting non-zero base64 trailing bits', () => {
    const reorderedJson = JSON.stringify({
      endpoint,
      attemptId: receipt.attemptId,
      version: receipt.version,
      requestId: receipt.requestId,
    });
    const reordered = Buffer.from(reorderedJson, 'utf8').toString('base64url');
    expect(decodeReplyReceipt(reordered)).toEqual(receipt);

    const canonical = encodeReplyReceipt(receipt);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const lastIndex = alphabet.indexOf(canonical.at(-1)!);
    const ignoredBits = canonical.length % 4 === 2 ? 4 : canonical.length % 4 === 3 ? 2 : 0;
    expect(ignoredBits).toBeGreaterThan(0);
    const changedIndex =
      (lastIndex & ~((1 << ignoredBits) - 1)) | ((lastIndex + 1) & ((1 << ignoredBits) - 1));
    const nonCanonical = `${canonical.slice(0, -1)}${alphabet[changedIndex]}`;
    expectReceiptError(() => decodeReplyReceipt(nonCanonical), 'RESPONSE_RECEIPT_INVALID');
  });

  it('rejects a positional request mismatch before service submission', () => {
    const encoded = encodeReplyReceipt(receipt);
    expectReceiptError(
      () => decodeReplyReceipt(encoded, 'different-request'),
      'RESPONSE_RECEIPT_MISMATCH'
    );
  });

  it.each([
    '',
    'not-base64!',
    'eyJ2ZXJzaW9uIjoxfQ==',
    Buffer.from([0xff, 0xfe]).toString('base64url'),
  ])('rejects malformed, padded, or non-UTF-8 receipt %j', (encoded) => {
    expectReceiptError(() => decodeReplyReceipt(encoded), 'RESPONSE_RECEIPT_INVALID');
  });

  it.each([
    { version: 2 },
    { extra: true },
    { requestId: '' },
    { attemptId: '' },
    { endpoint: { ...endpoint, paneId: '17' } },
    { endpoint: { ...endpoint, panePid: 0 } },
    { endpoint: { ...endpoint, serverPid: Number.MAX_SAFE_INTEGER + 1 } },
    { endpoint: { ...endpoint, serverId: '\ud800' } },
  ])('rejects an envelope violating the exact versioned fence shape', (change) => {
    const value = { ...receipt, ...change, endpoint: { ...receipt.endpoint, ...change.endpoint } };
    expectReceiptError(() => encodeReplyReceipt(value as ReplyReceipt), 'RESPONSE_RECEIPT_INVALID');
  });

  it('rejects decoded JSON envelopes with malformed top-level or endpoint shapes', () => {
    const malformed = [
      ['[]'],
      [JSON.stringify({ ...receipt, endpoint: [] })],
      [JSON.stringify({ ...receipt, endpoint: { ...endpoint, extra: true } })],
    ];
    for (const [value] of malformed) {
      const encoded = Buffer.from(value, 'utf8').toString('base64url');
      expectReceiptError(() => decodeReplyReceipt(encoded), 'RESPONSE_RECEIPT_INVALID');
    }
  });

  it('rejects receipts whose encoded form exceeds the 8192-character bound', () => {
    const oversized = {
      ...receipt,
      endpoint: {
        ...endpoint,
        serverId: 'x'.repeat(4096),
        socketPath: 'y'.repeat(4096),
      },
    } as ReplyReceipt;
    expect(() => encodeReplyReceipt(oversized)).toThrow(ReplyReceiptError);
    try {
      encodeReplyReceipt(oversized);
    } catch (error) {
      expect((error as ReplyReceiptError).code).toBe('RESPONSE_RECEIPT_INVALID');
    }
  });

  it('enforces bounded request IDs while preserving valid Unicode bytes', () => {
    expect(() => encodeReplyReceipt({ ...receipt, requestId: '😀'.repeat(65) })).toThrow(
      ReplyReceiptError
    );
    expect(() => encodeReplyReceipt({ ...receipt, requestId: 'a'.repeat(257) })).toThrow(
      ReplyReceiptError
    );
    expect(MAX_REPLY_RECEIPT_LENGTH).toBe(8192);
  });
});
