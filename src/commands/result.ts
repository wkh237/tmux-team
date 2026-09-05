import type { Context } from '../types.js';
import { ExitCodes } from '../exits.js';
import { ResponseError } from '../domain/response.js';
import type { ResultRequest } from '../cli/requests.js';

function fail(ctx: Context, error: unknown): never {
  const code = error instanceof ResponseError ? error.code : 'RESPONSE_ERROR';
  const message = error instanceof ResponseError ? error.message : 'Could not retrieve response.';
  if (ctx.flags.json) ctx.ui.json({ error: { code, message } });
  else ctx.ui.error(message);
  const status = code === 'RESPONSE_REQUEST_NOT_FOUND' ? ExitCodes.NAME_NOT_FOUND : ExitCodes.ERROR;
  return ctx.exit(status);
}

/** Retrieve only an already-retained final response; absence is intentionally undifferentiated. */
export function cmdResult(ctx: Context, request: ResultRequest): void {
  let record;
  try {
    record = ctx.requestService.getResponse(request.requestId);
  } catch (error) {
    fail(ctx, error);
  }
  if (!record) {
    const result = {
      status: 'unavailable' as const,
      requestId: request.requestId,
      error: {
        code: 'RESPONSE_NOT_AVAILABLE',
        message: `Response for request '${request.requestId}' is not available.`,
      },
    };
    if (ctx.flags.json) ctx.ui.json(result);
    else ctx.ui.error(result.error.message);
    ctx.exit(ExitCodes.NAME_NOT_FOUND);
  }
  const result = {
    status: 'completed' as const,
    requestId: request.requestId,
    response: record.body,
    bodyBytes: record.bodyBytes,
    submittedAtMs: record.submittedAtMs,
  };
  if (ctx.flags.json) ctx.ui.json(result);
  else ctx.ui.info(`Response for request '${request.requestId}':\n${record.body}`);
}
