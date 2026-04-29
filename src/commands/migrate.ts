// ─────────────────────────────────────────────────────────────
// migrate command - copy legacy JSON registry into tmux metadata
// ─────────────────────────────────────────────────────────────

import type { Context, PaneEntry } from '../types.js';
import { ExitCodes } from '../exits.js';
import { loadLocalConfigFile, saveLocalConfigFile } from '../config.js';
import { getRegistryScope, registrationFromEntry, scopeLabel } from '../registry.js';

interface MigrationItem {
  agent: string;
  fromPane: string;
  pane: string;
  remark?: string;
  status: 'ready' | 'migrated';
}

export function cmdMigrate(ctx: Context, args: string[]): void {
  const dryRun = args.includes('--dry-run');
  const cleanup = args.includes('--cleanup');
  const { ui, paths, flags, tmux, exit } = ctx;
  const localConfig = loadLocalConfigFile(paths);
  const scope = getRegistryScope(ctx);
  const items: MigrationItem[] = [];

  for (const [agentName, rawEntry] of Object.entries(localConfig)) {
    if (agentName === '$config') continue;
    const entry = rawEntry as PaneEntry | undefined;
    if (!entry?.pane) continue;

    const pane = tmux.resolvePaneTarget(entry.pane);
    if (!pane) {
      ui.error(`Pane '${entry.pane}' for agent '${agentName}' not found. Is tmux running?`);
      exit(ExitCodes.PANE_NOT_FOUND);
    }
    const paneId = pane as string;

    items.push({
      agent: agentName,
      fromPane: entry.pane,
      pane: paneId,
      ...(entry.remark !== undefined && { remark: entry.remark }),
      status: dryRun ? 'ready' : 'migrated',
    });

    if (!dryRun) {
      tmux.setAgentRegistration(paneId, scope, registrationFromEntry(agentName, entry));
    }
  }

  if (!dryRun && cleanup && items.length > 0) {
    for (const item of items) {
      delete localConfig[item.agent];
    }
    saveLocalConfigFile(paths, localConfig);
  }

  if (flags.json) {
    ui.json({
      dryRun,
      cleanup,
      scope,
      migrated: dryRun ? 0 : items.length,
      items,
    });
    return;
  }

  if (items.length === 0) {
    ui.info(`No legacy agents found in ${paths.localConfig}`);
    return;
  }

  const action = dryRun ? 'Would migrate' : 'Migrated';
  ui.success(`${action} ${items.length} agent(s) to ${scopeLabel(scope)}`);
  ui.table(
    ['AGENT', 'FROM', 'PANE', 'REMARK'],
    items.map((item) => [item.agent, item.fromPane, item.pane, item.remark ?? '-'])
  );

  if (!dryRun && !cleanup) {
    ui.info('Legacy JSON was left in place. Use --cleanup to remove migrated agent entries.');
  }
}
