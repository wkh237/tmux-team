import type { Context } from '../types.js';
import { cmdInit } from '../commands/init.js';
import { cmdList } from '../commands/list.js';
import { cmdAdd } from '../commands/add.js';
import { cmdUpdate } from '../commands/update.js';
import { cmdRemove } from '../commands/remove.js';
import { cmdTalk } from '../commands/talk.js';
import { cmdCheck } from '../commands/check.js';
import { cmdConfig } from '../commands/config.js';
import { cmdPreamble } from '../commands/preamble.js';
import { cmdInstall } from '../commands/install.js';
import { cmdLearn } from '../commands/learn.js';
import { cmdThis } from '../commands/this.js';
import { cmdMigrate } from '../commands/migrate.js';
import { cmdName } from '../commands/name.js';
import { cmdUpgrade } from '../commands/upgrade.js';
import { cmdWhoami } from '../commands/whoami.js';
import { cmdUnbind } from '../commands/unbind.js';
import type { ParsedArgs, ParsedInvocation } from './parser.js';

function assertNever(value: never): never {
  throw new Error(`Unhandled parsed invocation: ${JSON.stringify(value)}`);
}

/** Dispatches one fully parsed request to the existing application services. */
export async function dispatchCommand(ctx: Context, parsed: ParsedArgs): Promise<void> {
  const request = parsed.invocation;
  switch (request.kind) {
    case 'help':
    case 'version':
      return;
    case 'init':
      return cmdInit(ctx);
    case 'list':
      return request.target ? cmdList(ctx, request.target.value) : cmdList(ctx);
    case 'add':
      return cmdAdd(ctx, request.pane, request.name);
    case 'update':
      return cmdUpdate(ctx, request.name, request.options);
    case 'remove':
      return cmdRemove(ctx, request.name);
    case 'migrate':
      return cmdMigrate(ctx, request);
    case 'this':
      return cmdThis(ctx, request.name);
    case 'name':
      return cmdName(ctx, request.name);
    case 'whoami':
      return cmdWhoami(ctx);
    case 'unbind':
      return cmdUnbind(ctx);
    case 'talk':
      return cmdTalk(ctx, request.target.value, request.message);
    case 'check':
      return cmdCheck(ctx, request.target.value, request.lines);
    case 'config':
      return cmdConfig(ctx, request);
    case 'preamble':
      return cmdPreamble(ctx, request);
    case 'install':
      return cmdInstall(ctx, request.target);
    case 'completion':
      return;
    case 'upgrade':
      return cmdUpgrade(ctx);
    case 'learn':
      return cmdLearn();
    default:
      return assertNever(request);
  }
}

export type ApplicationInvocation = ParsedInvocation;
