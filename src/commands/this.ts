// ─────────────────────────────────────────────────────────────
// this command - register current pane as an agent
// ─────────────────────────────────────────────────────────────

import type { Context } from '../types.js';
import { cmdName } from './name.js';

export function cmdThis(ctx: Context, name: string): void {
  cmdName(ctx, name);
}
