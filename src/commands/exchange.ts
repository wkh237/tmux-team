import type { Context } from '../types.js';
import type { ExchangeRequest } from '../cli/requests.js';
import { publicIdentity } from '../domain/identity.js';
import { IdentityServiceError } from '../identity-service.js';
import { IdentitySelectionError, requireIdentityResolution } from '../identity-context.js';
import { ExchangeAttentionError } from '../request-attention.js';
import { ExitCodes } from '../exits.js';

/** Identity selection precedes all request access; reads never acknowledge work. */
export function cmdExchange(ctx: Context, request: ExchangeRequest): void {
  try {
    const identity = publicIdentity(
      requireIdentityResolution(
        ctx.identityService.resolveIdentity(request.selector),
        request.selector
      )
    );
    const service = ctx.requestService;
    switch (request.operation) {
      case 'list': {
        const result = service.listExchanges(identity.id, {
          ...(request.limit !== undefined && { limit: request.limit }),
          ...(request.after !== undefined && { after: request.after }),
        });
        if (ctx.flags.json) ctx.ui.json({ identity, ...result });
        else {
          if (result.items.length === 0) ctx.ui.info('No unacknowledged exchanges.');
          else
            ctx.ui.table(
              ['REQUEST', 'RECIPIENT', 'DELIVERY', 'FINAL', 'REVISION'],
              result.items.map((item) => [
                item.requestId,
                item.recipientIdentityId ?? '-',
                item.delivery,
                item.final.status,
                String(item.revision),
              ])
            );
          if (result.nextAfter !== null)
            ctx.ui.info(
              `More exchanges: repeat x list with the same identity and --after ${result.nextAfter}.`
            );
        }
        return;
      }
      case 'show': {
        const exchange = service.showExchange(identity.id, request.requestId);
        if (ctx.flags.json) ctx.ui.json({ identity, exchange });
        else {
          ctx.ui.table(
            ['REQUEST', 'DELIVERY', 'FINAL', 'REVISION', 'ACKNOWLEDGED', 'SETTLED'],
            [
              [
                exchange.requestId,
                exchange.delivery,
                exchange.final.status,
                String(exchange.revision),
                String(exchange.acknowledged),
                String(exchange.settled),
              ],
            ]
          );
          ctx.ui.info(`Prompt (${exchange.prompt.status}):`);
          if (exchange.prompt.status === 'retained') ctx.ui.info(exchange.prompt.message);
          ctx.ui.info(`Final (${exchange.final.status}):`);
          if (exchange.final.status === 'retained') ctx.ui.info(exchange.final.response);
        }
        return;
      }
      case 'ack': {
        const result = service.acknowledgeExchange(
          identity.id,
          request.requestId,
          request.revision
        );
        if (ctx.flags.json) ctx.ui.json({ identity, ...result });
        else
          ctx.ui.success(
            `Acknowledged ${result.requestId} at revision ${result.revision}${result.changed ? '.' : ' (already acknowledged).'}`
          );
        return;
      }
      case 'ackall': {
        const result = service.acknowledgeAllExchanges(identity.id);
        if (ctx.flags.json) ctx.ui.json({ identity, ...result });
        else
          ctx.ui.success(
            `Acknowledged identity '${identity.name}' through revision ${result.acknowledgedThrough}. Later revisions remain unacknowledged.`
          );
        return;
      }
    }
  } catch (error) {
    const expected =
      error instanceof ExchangeAttentionError ||
      error instanceof IdentitySelectionError ||
      error instanceof IdentityServiceError;
    const code = expected ? error.code : 'X_ERROR';
    const message = expected ? error.message : 'Could not complete the exchange operation.';
    if (ctx.flags.json) ctx.ui.json({ error: { code, message } });
    else ctx.ui.error(message);
    ctx.exit(
      code === 'X_NOT_FOUND' || code === 'NAME_NOT_FOUND'
        ? ExitCodes.NAME_NOT_FOUND
        : code === 'X_REVISION_CONFLICT' || code === 'IDENTITY_AMBIGUOUS'
          ? ExitCodes.CONFLICT
          : ExitCodes.ERROR
    );
  }
}
