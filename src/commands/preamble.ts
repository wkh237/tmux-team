// ─────────────────────────────────────────────────────────────
// Preamble command - manage durable identity preambles
// ─────────────────────────────────────────────────────────────

import type { Context } from '../types.js';
import { ExitCodes } from '../exits.js';
import { IdentitySelectionError } from '../identity-context.js';
import { PreambleContentError } from '../domain/preamble.js';

export interface PreambleRequest {
  readonly kind: 'preamble';
  readonly operation: 'show' | 'set' | 'clear';
  readonly agent?: string;
  readonly preamble?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not access identity preamble state.';
}

function failPreamble(ctx: Context, error: unknown): never {
  const publicCode =
    error instanceof IdentitySelectionError
      ? error.code === 'NAME_NOT_FOUND'
        ? 'NAME_NOT_FOUND'
        : 'PREAMBLE_ERROR'
      : error instanceof PreambleContentError
        ? error.code
        : 'PREAMBLE_ERROR';
  const message = errorMessage(error);
  if (ctx.flags.json) ctx.ui.json({ error: { code: publicCode, message } });
  else ctx.ui.error(message);
  return ctx.exit(publicCode === 'NAME_NOT_FOUND' ? ExitCodes.NAME_NOT_FOUND : ExitCodes.ERROR);
}

function service(ctx: Context): NonNullable<Context['preambleService']> {
  if (!ctx.preambleService) {
    throw new Error('Preamble service is unavailable.');
  }
  return ctx.preambleService;
}

function showPreamble(ctx: Context, agentName?: string): void {
  try {
    if (agentName !== undefined) {
      const result = service(ctx).show(agentName);
      const preamble = result.preamble?.content ?? null;
      if (ctx.flags.json) {
        ctx.ui.json({ agent: result.identity.name, preamble });
      } else if (preamble) {
        ctx.ui.info(`Preamble for ${result.identity.name}:\n${preamble}`);
      } else {
        ctx.ui.info(`No preamble set for ${result.identity.name}`);
      }
      return;
    }

    const result = service(ctx)
      .list()
      .map(({ identity, preamble }) => ({
        agent: identity.name,
        preamble: preamble.content,
      }));
    if (ctx.flags.json) {
      ctx.ui.json({ preambles: result });
      return;
    }
    if (result.length === 0) {
      ctx.ui.info('No preambles configured');
      return;
    }
    for (const { agent, preamble } of result) {
      ctx.ui.info(`─── ${agent} ───\n${preamble}\n`);
    }
  } catch (error) {
    failPreamble(ctx, error);
  }
}

function setPreamble(ctx: Context, agentName: string, content: string): void {
  try {
    const result = service(ctx).set(agentName, content);
    if (ctx.flags.json) {
      ctx.ui.json({
        agent: result.identity.name,
        preamble: result.preamble.content,
        status: 'set',
      });
    } else ctx.ui.success(`Set preamble for ${result.identity.name}`);
  } catch (error) {
    failPreamble(ctx, error);
  }
}

function clearPreamble(ctx: Context, agentName: string): void {
  try {
    const result = service(ctx).clear(agentName);
    if (ctx.flags.json) {
      ctx.ui.json({ agent: result.identity.name, status: result.cleared ? 'cleared' : 'not_set' });
    } else if (result.cleared) {
      ctx.ui.success(`Cleared preamble for ${result.identity.name}`);
    } else {
      ctx.ui.info(`No preamble was set for ${result.identity.name}`);
    }
  } catch (error) {
    failPreamble(ctx, error);
  }
}

export function cmdPreamble(ctx: Context, request: PreambleRequest): void {
  switch (request.operation) {
    case 'show':
      showPreamble(ctx, request.agent);
      return;
    case 'set':
      if (request.agent === undefined || request.preamble === undefined) {
        ctx.ui.error('Usage: tmux-team preamble set <agent> <preamble>');
        ctx.exit(ExitCodes.ERROR);
      }
      setPreamble(ctx, request.agent, request.preamble);
      return;
    case 'clear':
      if (request.agent === undefined) {
        ctx.ui.error('Usage: tmux-team preamble clear <agent>');
        ctx.exit(ExitCodes.ERROR);
      }
      clearPreamble(ctx, request.agent);
      return;
  }
}
