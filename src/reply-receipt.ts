import { TextDecoder } from 'node:util';
import type { RequestEndpoint } from './request-service.js';
import { hasLoneSurrogate } from './domain/text-content.js';

export const MAX_REPLY_RECEIPT_LENGTH = 8192;
const MAX_RECEIPT_STRING_BYTES = 4096;

export interface ReplyReceipt {
  readonly version: 1;
  readonly requestId: string;
  readonly attemptId: string;
  readonly endpoint: RequestEndpoint;
}

export type ReplyReceiptErrorCode = 'RESPONSE_RECEIPT_INVALID' | 'RESPONSE_RECEIPT_MISMATCH';

export class ReplyReceiptError extends Error {
  constructor(
    public readonly code: ReplyReceiptErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'ReplyReceiptError';
  }
}

function invalid(message = 'Response receipt is invalid.', cause?: unknown): ReplyReceiptError {
  return new ReplyReceiptError('RESPONSE_RECEIPT_INVALID', message, { cause });
}

function assertBoundedString(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    hasLoneSurrogate(value) ||
    Buffer.byteLength(value, 'utf8') > MAX_RECEIPT_STRING_BYTES
  ) {
    throw invalid(`Response receipt ${label} is invalid.`);
  }
}

function assertEndpoint(endpoint: unknown): asserts endpoint is RequestEndpoint {
  if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) {
    throw invalid('Response receipt endpoint is invalid.');
  }
  const value = endpoint as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (
    keys.join('\u0000') !==
    ['paneId', 'panePid', 'serverId', 'serverPid', 'serverStartTime', 'socketPath'].join('\u0000')
  ) {
    throw invalid('Response receipt endpoint is invalid.');
  }
  assertBoundedString(value.serverId, 'serverId');
  assertBoundedString(value.socketPath, 'socketPath');
  assertBoundedString(value.serverStartTime, 'serverStartTime');
  assertBoundedString(value.paneId, 'paneId');
  if (!/^%\d+$/.test(value.paneId)) throw invalid('Response receipt paneId is invalid.');
  if (!Number.isSafeInteger(value.serverPid) || (value.serverPid as number) <= 0) {
    throw invalid('Response receipt serverPid is invalid.');
  }
  if (!Number.isSafeInteger(value.panePid) || (value.panePid as number) <= 0) {
    throw invalid('Response receipt panePid is invalid.');
  }
}

function validateReceipt(value: unknown): ReplyReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid();
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join('\u0000') !== ['attemptId', 'endpoint', 'requestId', 'version'].join('\u0000')) {
    throw invalid();
  }
  if (record.version !== 1) throw invalid('Response receipt version is invalid.');
  assertBoundedString(record.requestId, 'requestId');
  if (Buffer.byteLength(record.requestId, 'utf8') > 256) {
    throw invalid('Response receipt requestId is invalid.');
  }
  assertBoundedString(record.attemptId, 'attemptId');
  assertEndpoint(record.endpoint);
  return {
    version: 1,
    requestId: record.requestId,
    attemptId: record.attemptId,
    endpoint: {
      serverId: record.endpoint.serverId,
      socketPath: record.endpoint.socketPath,
      serverPid: record.endpoint.serverPid,
      serverStartTime: record.endpoint.serverStartTime,
      paneId: record.endpoint.paneId,
      panePid: record.endpoint.panePid,
    },
  };
}

/** Encode a versioned, canonical, unpadded base64url correlation receipt. */
export function encodeReplyReceipt(value: ReplyReceipt): string {
  const receipt = validateReceipt(value);
  const encoded = Buffer.from(JSON.stringify(receipt), 'utf8').toString('base64url');
  if (encoded.length > MAX_REPLY_RECEIPT_LENGTH) {
    throw invalid('Response receipt exceeds the maximum length.');
  }
  return encoded;
}

/** Decode and validate a receipt; positional request ID correlation is checked when supplied. */
export function decodeReplyReceipt(encoded: string, requestId?: string): ReplyReceipt {
  if (
    typeof encoded !== 'string' ||
    encoded.length === 0 ||
    encoded.length > MAX_REPLY_RECEIPT_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(encoded)
  ) {
    throw invalid();
  }
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      Buffer.from(encoded, 'base64url')
    );
  } catch (error) {
    throw invalid('Response receipt is not valid UTF-8.', error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch (error) {
    throw invalid('Response receipt is not valid JSON.', error);
  }
  const receipt = validateReceipt(parsed);
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== encoded) {
    throw invalid('Response receipt is not canonical.');
  }
  if (requestId !== undefined && receipt.requestId !== requestId) {
    throw new ReplyReceiptError(
      'RESPONSE_RECEIPT_MISMATCH',
      'Response receipt does not match the requested ID.'
    );
  }
  return receipt;
}

export function validateReplyRequestId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || hasLoneSurrogate(value)) {
    throw new Error('Request ID must be a non-empty string.');
  }
  if (Buffer.byteLength(value, 'utf8') > 256) {
    throw new Error('Request ID must not exceed 256 UTF-8 bytes.');
  }
}
