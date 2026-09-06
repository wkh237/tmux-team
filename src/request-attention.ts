import type {
  RequestAttemptRecord,
  RequestContext,
  RequestResponseRecord,
} from './request-service.js';
import { addExchangeRetentionMs } from './domain/exchange-retention.js';

export type ExchangeAttentionErrorCode =
  | 'X_INPUT_INVALID'
  | 'X_NOT_FOUND'
  | 'X_REVISION_CONFLICT'
  | 'X_REVISION_EXHAUSTED'
  | 'X_ERROR';

export class ExchangeAttentionError extends Error {
  constructor(
    public readonly code: ExchangeAttentionErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'ExchangeAttentionError';
  }
}

export type ExchangeDelivery = RequestAttemptRecord['status'];

export type ExchangeFinalSummary =
  | { readonly status: 'not_submitted' }
  | {
      readonly status: 'retained';
      readonly submittedAtMs: number;
      readonly bodyBytes: number;
      readonly expiresAtMs: number;
    }
  | { readonly status: 'expired'; readonly submittedAtMs: number; readonly expiresAtMs: number }
  | {
      readonly status: 'unavailable';
      readonly submittedAtMs: number;
      readonly expiresAtMs: number;
    };

export type ExchangeFinalDetail =
  | Exclude<ExchangeFinalSummary, { readonly status: 'retained' }>
  | {
      readonly status: 'retained';
      readonly response: string;
      readonly submittedAtMs: number;
      readonly bodyBytes: number;
      readonly expiresAtMs: number;
    };

export interface ExchangeSummary {
  readonly requestId: string;
  readonly recipientIdentityId: string | null;
  readonly preparedAtMs: number;
  readonly delivery: ExchangeDelivery;
  readonly final: ExchangeFinalSummary;
  readonly revision: number;
  readonly acknowledged: boolean;
  readonly settled: boolean;
  readonly retentionExpiresAtMs: number;
}

export interface ExchangeDetail extends Omit<ExchangeSummary, 'final'> {
  readonly prompt: RequestContext['prompt'];
  readonly final: ExchangeFinalDetail;
}

export interface ExchangeAttentionRecord {
  readonly originatorIdentityId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly revision: number;
  readonly acknowledgedRevision: number;
  readonly acknowledgedThrough: number;
  readonly attempt: RequestAttemptRecord;
  readonly responseMetadata?: {
    readonly submittedAtMs: number;
    readonly bodyBytes: number;
    readonly expiresAtMs: number;
  };
}

export interface ExchangeAttentionRepository {
  reserveAttentionRevision(identityId: string): number;
  advanceAttentionRevision(requestId: string): void;
  findExchangeAttention(identityId: string, requestId: string): ExchangeAttentionRecord | undefined;
  listExchangeAttention(
    identityId: string,
    afterRevision: number,
    limit: number,
    nowMs: number
  ): ExchangeAttentionRecord[];
  acknowledgeExchange(
    identityId: string,
    requestId: string,
    revision: number,
    nowMs: number
  ): { currentRevision: number; changed: boolean };
  acknowledgeAllExchanges(identityId: string, nowMs: number): number;
}

export const DEFAULT_EXCHANGE_LIST_LIMIT = 50;
export const MAX_EXCHANGE_LIST_LIMIT = 200;

function finalSummaryForRecord(
  record: ExchangeAttentionRecord,
  nowMs: number
): ExchangeFinalSummary {
  const submittedAtMs = record.attempt.responseSubmittedAtMs;
  if (submittedAtMs === undefined) {
    return { status: 'not_submitted' };
  }
  const expiresAtMs =
    record.responseMetadata?.expiresAtMs ??
    addExchangeRetentionMs(submittedAtMs, record.attempt.retentionDays);
  if (nowMs >= expiresAtMs) return { status: 'expired', submittedAtMs, expiresAtMs };
  if (!record.responseMetadata) return { status: 'unavailable', submittedAtMs, expiresAtMs };
  return {
    status: 'retained',
    submittedAtMs,
    bodyBytes: record.responseMetadata.bodyBytes,
    expiresAtMs,
  };
}

export function projectExchangeSummary(
  record: ExchangeAttentionRecord,
  nowMs: number
): ExchangeSummary {
  const { attempt } = record;
  const acknowledged =
    record.acknowledgedRevision >= record.revision || record.acknowledgedThrough >= record.revision;
  return {
    requestId: record.requestId,
    recipientIdentityId: attempt.recipientIdentityId ?? null,
    preparedAtMs: attempt.preparedAtMs,
    delivery: attempt.status,
    final: finalSummaryForRecord(record, nowMs),
    revision: record.revision,
    acknowledged,
    settled: attempt.responseSubmittedAtMs !== undefined && acknowledged,
    retentionExpiresAtMs: attempt.retentionExpiresAtMs,
  };
}

export function projectExchangeFinalDetail(
  summary: ExchangeSummary,
  context: RequestContext,
  response: RequestResponseRecord | undefined,
  nowMs: number
): ExchangeDetail {
  let final: ExchangeFinalDetail;
  if (
    response &&
    context.attempt.responseSubmittedAtMs !== undefined &&
    nowMs < response.responseExpiresAtMs
  ) {
    final = {
      status: 'retained',
      response: response.body,
      submittedAtMs: response.submittedAtMs,
      bodyBytes: response.bodyBytes,
      expiresAtMs: response.responseExpiresAtMs,
    };
  } else if (summary.final.status === 'retained') {
    final = {
      status: 'unavailable',
      submittedAtMs: summary.final.submittedAtMs,
      expiresAtMs: summary.final.expiresAtMs,
    };
  } else {
    final = summary.final;
  }
  return { ...summary, prompt: context.prompt, final };
}
