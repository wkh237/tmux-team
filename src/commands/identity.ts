import type { Context } from '../types.js';
import type { IdentityRequest } from '../cli/requests.js';
import { publicIdentity } from '../domain/identity.js';
import { IdentityServiceError } from '../identity-service.js';
import { IdentitySelectionError } from '../identity-context.js';
import { ExitCodes } from '../exits.js';

/** Storage-only identity operations; presence remains owned by the list command. */
export function cmdIdentity(ctx: Context, request: IdentityRequest): void {
  try {
    const service = ctx.identityService;
    if (request.operation === 'list') {
      const identities = service.listIdentities().map(publicIdentity);
      if (ctx.flags.json) ctx.ui.json({ identities });
      else if (identities.length === 0) ctx.ui.info('No durable identities found.');
      else
        ctx.ui.table(
          ['NAME', 'ID'],
          identities.map((identity) => [identity.name, identity.id])
        );
      return;
    }
    if (request.operation === 'create') {
      const result = service.createIdentity(request.name);
      const identity = publicIdentity(result.identity);
      if (ctx.flags.json) ctx.ui.json({ identity, created: result.created });
      else
        ctx.ui.success(
          `${result.created ? 'Created' : 'Already exists:'} identity '${identity.name}' (${identity.id}).`
        );
      return;
    }
    const identity = publicIdentity(service.showIdentity(request.name));
    if (ctx.flags.json) ctx.ui.json({ identity });
    else
      ctx.ui.table(
        ['NAME', 'CANONICAL NAME', 'ID'],
        [[identity.name, identity.canonicalName, identity.id]]
      );
  } catch (error) {
    const expected =
      error instanceof IdentityServiceError || error instanceof IdentitySelectionError;
    const code = expected ? error.code : 'IDENTITY_ERROR';
    const message = expected ? error.message : 'Could not complete the identity operation.';
    if (ctx.flags.json) ctx.ui.json({ error: { code, message } });
    else ctx.ui.error(message);
    ctx.exit(code === 'NAME_NOT_FOUND' ? ExitCodes.NAME_NOT_FOUND : ExitCodes.ERROR);
  }
}
