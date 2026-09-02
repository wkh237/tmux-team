// ─────────────────────────────────────────────────────────────
// check command - capture output from agent's pane
// ─────────────────────────────────────────────────────────────

import type { Context } from '../types.js';
import { ExitCodes } from '../exits.js';
import { colors } from '../ui.js';
import { resolveTarget } from '../target-resolver.js';
import { normalizeName } from '../domain/names.js';

export function cmdCheck(ctx: Context, target: string, lines?: number): void {
  const { ui, config, tmux, flags, exit } = ctx;
  const resolution = resolveTarget(tmux, target);
  if (!resolution.ok) {
    if (flags.json) ui.json({ error: resolution.error });
    else ui.error(resolution.error.message);
    return exit(
      resolution.error.code === 'NAME_NOT_FOUND'
        ? ExitCodes.NAME_NOT_FOUND
        : ExitCodes.PANE_NOT_FOUND
    );
  }

  const pane = resolution.value.paneId;
  const captureLines = lines ?? config.defaults.captureLines;

  try {
    const output = tmux.capture(pane, captureLines);

    if (flags.json) {
      ui.json({
        target,
        pane,
        ...(resolution.value.identity && {
          identity: {
            name: resolution.value.identity.name,
            canonicalName:
              resolution.value.identity.canonicalName ||
              normalizeName(resolution.value.identity.name),
          },
        }),
        lines: captureLines,
        output,
      });
    } else {
      console.log(colors.cyan(`─── Output from ${target} (${pane}) ───`));
      console.log(output);
    }
  } catch {
    const message = `Failed to capture pane ${pane}. Is tmux running?`;
    if (flags.json) ui.json({ error: { code: 'ERROR', message } });
    else ui.error(message);
    exit(ExitCodes.ERROR);
  }
}
