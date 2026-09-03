import type { Context, RoleResult } from '../types.js';
import { ExitCodes } from '../exits.js';
import { readRoleFile, RoleFileError } from '../role-content.js';
import { RoleContentError } from '../domain/role.js';
import { IdentitySelectionError, type IdentitySelector } from '../identity-context.js';
import { IdentityServiceError } from '../identity-service.js';

type RoleTarget = {
  readonly kind: 'role';
  readonly selector?: IdentitySelector;
};

export type RoleRequest = RoleTarget &
  (
    | { readonly operation: 'show' }
    | { readonly operation: 'clear' }
    | { readonly operation: 'set'; readonly content: string; readonly file?: never }
    | { readonly operation: 'set'; readonly file: string; readonly content?: never }
  );

function printResult(ctx: Context, result: RoleResult, operation: RoleRequest['operation']): void {
  const value = result;
  if (ctx.flags.json) {
    ctx.ui.json(value);
    return;
  }
  if (operation === 'show') {
    ctx.ui.info(`Identity '${value.identity.name}'`);
    if (value.role) ctx.ui.info(value.role.content);
    else ctx.ui.info('No role profile is set.');
  } else if (operation === 'set') {
    ctx.ui.success(`Set role profile for '${value.identity.name}'.`);
  } else {
    ctx.ui.success(`Cleared role profile for '${value.identity.name}'.`);
  }
}

function fail(ctx: Context, error: unknown): never {
  const code =
    error instanceof IdentitySelectionError ||
    error instanceof IdentityServiceError ||
    error instanceof RoleContentError ||
    error instanceof RoleFileError
      ? error.code
      : 'ROLE_ERROR';
  const message = error instanceof Error ? error.message : String(error);
  if (ctx.flags.json) ctx.ui.json({ error: { code, message } });
  else ctx.ui.error(message);
  const exitCode =
    code === 'NAME_NOT_FOUND'
      ? ExitCodes.NAME_NOT_FOUND
      : code === 'IDENTITY_AMBIGUOUS'
        ? ExitCodes.CONFLICT
        : ExitCodes.ERROR;
  return ctx.exit(exitCode);
}

export function cmdRole(ctx: Context, request: RoleRequest): void {
  try {
    const service = ctx.roleService;
    if (!service) throw new Error('Role service is unavailable.');
    if (request.operation === 'show') {
      printResult(ctx, service.show(request.selector), request.operation);
      return;
    }
    if (request.operation === 'clear') {
      printResult(ctx, service.clear(request.selector), request.operation);
      return;
    }
    const content = request.file !== undefined ? readRoleFile(request.file) : request.content;
    printResult(ctx, service.set(request.selector, content), request.operation);
  } catch (error) {
    fail(ctx, error);
  }
}
