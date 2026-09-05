import type { Context } from '../types.js';
import { ExitCodes } from '../exits.js';
import { ResponseError } from '../domain/response.js';
import { decodeReplyReceipt, ReplyReceiptError } from '../reply-receipt.js';
import { readResponseFile, readResponseStdin, ResponseInputError } from '../response-content.js';
import type { ReplyRequest } from '../cli/requests.js';

function errorCode(error: unknown): string {
  if (
    error instanceof ResponseError ||
    error instanceof ResponseInputError ||
    error instanceof ReplyReceiptError
  ) {
    return error.code;
  }
  return 'RESPONSE_ERROR';
}

function exitCode(code: string): number {
  if (code === 'RESPONSE_REQUEST_NOT_FOUND') return ExitCodes.NAME_NOT_FOUND;
  if (code === 'RESPONSE_CONFLICT') return ExitCodes.CONFLICT;
  if (code === 'RESPONSE_INPUT_TIMEOUT') return ExitCodes.TIMEOUT;
  return ExitCodes.ERROR;
}

function fail(ctx: Context, error: unknown): never {
  const code = errorCode(error);
  const message =
    error instanceof ResponseError ||
    error instanceof ResponseInputError ||
    error instanceof ReplyReceiptError
      ? error.message
      : 'Could not submit response.';
  if (ctx.flags.json) ctx.ui.json({ error: { code, message } });
  else ctx.ui.error(message);
  return ctx.exit(exitCode(code));
}

/** Read the selected body completely before opening durable request storage. */
export async function cmdReply(ctx: Context, request: ReplyRequest): Promise<void> {
  let record;
  try {
    const receipt = decodeReplyReceipt(request.receipt, request.requestId);
    const body =
      request.file !== undefined ? readResponseFile(request.file) : await readResponseStdin();
    record = ctx.requestService.submitResponse({
      requestId: request.requestId,
      attemptId: receipt.attemptId,
      endpoint: receipt.endpoint,
      body,
    });
  } catch (error) {
    fail(ctx, error);
  }
  const result = {
    status: 'submitted' as const,
    requestId: request.requestId,
    bodyBytes: record.bodyBytes,
    submittedAtMs: record.submittedAtMs,
  };
  if (ctx.flags.json) ctx.ui.json(result);
  else
    ctx.ui.success(
      `Submitted response for request '${request.requestId}' (${record.bodyBytes} bytes).`
    );
}
