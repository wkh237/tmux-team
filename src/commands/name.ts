// name command - set the visible title of a tmux pane

import type { Context } from '../types.js';
import { ExitCodes } from '../exits.js';

export function cmdName(ctx: Context, name: string, target?: string): void {
  const { ui, tmux, flags, exit } = ctx;

  const hasControlCharacter = [...name].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });

  if (!name || name.trim().length === 0 || hasControlCharacter) {
    ui.error('Pane name must be non-empty and contain no control characters or newlines.');
    exit(ExitCodes.ERROR);
  }

  const requestedTarget = target ?? tmux.getCurrentPaneId();
  if (!requestedTarget) {
    ui.error('Not running inside tmux.');
    return exit(ExitCodes.PANE_NOT_FOUND);
  }

  const paneId = tmux.resolvePaneTarget(requestedTarget);
  if (!paneId) {
    ui.error(`Pane '${requestedTarget}' not found. Is tmux running?`);
    return exit(ExitCodes.PANE_NOT_FOUND);
  }

  tmux.setPaneTitle(paneId, name);

  if (flags.json) {
    ui.json({ named: name, pane: paneId });
  } else {
    ui.success(`Named pane ${paneId} '${name}'`);
  }
}
