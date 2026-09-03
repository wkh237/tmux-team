import type { Context } from '../types.js';
import { ExitCodes } from '../exits.js';

export const UNSUPPORTED_TEAM_MESSAGE =
  'Team-scoped commands and --team are not supported in tmt v5.';

export function rejectUnsupportedTeam(ctx: Context): never {
  const error = { code: 'UNSUPPORTED_TEAM', message: UNSUPPORTED_TEAM_MESSAGE };
  if (ctx.flags.json) ctx.ui.json({ error });
  else ctx.ui.error(error.message);
  return ctx.exit(ExitCodes.UNSUPPORTED_TEAM);
}
