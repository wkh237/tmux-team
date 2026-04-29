// ─────────────────────────────────────────────────────────────
// team command - inspect pane team/workspace scope and manage explicit shared teams
// ─────────────────────────────────────────────────────────────

import type { Context, TeamPaneInfo, TeamPaneRegistration } from '../types.js';
import { ExitCodes } from '../exits.js';

export function cmdTeam(ctx: Context, args: string[]): void {
  const subcommand = args[0] ?? 'ls';

  switch (subcommand) {
    case 'ls':
    case 'list':
      listTeams(ctx, args.slice(1));
      break;
    case 'rm':
    case 'remove':
      removeTeam(ctx, args.slice(1));
      break;
    default:
      ctx.ui.error(`Unknown team subcommand: ${subcommand}`);
      ctx.ui.error('Usage: tmux-team team [ls [--summary]|rm <team> --force]');
      ctx.exit(ExitCodes.ERROR);
  }
}

function listTeams(ctx: Context, args: string[]): void {
  const teams = ctx.tmux.listTeams();
  const panes = ctx.tmux.listTeamPanes();
  const summaryOnly = args.includes('--summary');

  if (ctx.flags.json) {
    ctx.ui.json({ teams, panes });
    return;
  }

  if (summaryOnly) {
    const rows = Object.entries(teams).sort(([a], [b]) => a.localeCompare(b));
    if (rows.length === 0) {
      ctx.ui.info('No shared teams found.');
      return;
    }
    ctx.ui.table(
      ['TEAM', 'AGENTS'],
      rows.map(([teamName, agents]) => [teamName, agents.join(', ') || '-'])
    );
    return;
  }

  const groups = panesToGroups(panes);
  if (groups.length === 0) {
    ctx.ui.info('No tmux panes found.');
    return;
  }

  for (const [index, group] of groups.entries()) {
    if (index > 0) console.log('');
    console.log(group.title);
    ctx.ui.table(['PANE', 'TARGET', 'CWD', 'CMD'], group.rows);
  }
}

interface PaneGroup {
  key: string;
  title: string;
  agents: Set<string>;
  rows: string[][];
}

function panesToGroups(panes: TeamPaneInfo[]): PaneGroup[] {
  const groups = new Map<string, PaneGroup>();

  for (const pane of panes) {
    if (pane.registrations.length === 0) {
      addPaneToGroup(groups, '2:', 'Unregistered panes', pane);
      continue;
    }

    for (const registration of pane.registrations) {
      addPaneToGroup(
        groups,
        scopeSortKey(registration),
        groupTitle(registration),
        pane,
        registration
      );
    }
  }

  return [...groups.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((group) => ({
      ...group,
      title:
        group.agents.size > 0
          ? `${group.title} (${[...group.agents].sort().join(', ')})`
          : group.title,
      rows: group.rows.sort((a, b) => a[1].localeCompare(b[1])),
    }));
}

function addPaneToGroup(
  groups: Map<string, PaneGroup>,
  key: string,
  title: string,
  pane: TeamPaneInfo,
  registration?: TeamPaneRegistration
): void {
  const group = groups.get(key) ?? { key, title, agents: new Set<string>(), rows: [] };
  if (registration) group.agents.add(formatAgent(registration));
  group.rows.push([pane.pane, pane.target ?? '-', pane.cwd ?? '-', pane.command || '-']);
  groups.set(key, group);
}

function scopeSortKey(registration: TeamPaneRegistration): string {
  if (registration.scopeType === 'team') return `0:${registration.scope}`;
  if (registration.scopeType === 'workspace') return `1:${registration.scope}`;
  return '2:';
}

function groupTitle(registration: TeamPaneRegistration): string {
  if (registration.scopeType === 'team') return `Team: ${registration.scope}`;
  return `Workspace: ${registration.scope}`;
}

function formatAgent(registration: TeamPaneRegistration): string {
  return registration.remark
    ? `${registration.agent} (${registration.remark})`
    : registration.agent;
}

function removeTeam(ctx: Context, args: string[]): void {
  const teamName = args.find((arg) => !arg.startsWith('-'));
  const dryRun = args.includes('--dry-run');
  const force = ctx.flags.force || args.includes('--force') || args.includes('-f');

  if (!teamName) {
    ctx.ui.error('Usage: tmux-team team rm <team> --force');
    ctx.exit(ExitCodes.ERROR);
  }

  const teams = ctx.tmux.listTeams();
  const agents = teams[teamName] ?? [];
  if (agents.length === 0) {
    ctx.ui.error(`Team '${teamName}' not found.`);
    ctx.exit(ExitCodes.PANE_NOT_FOUND);
  }

  if (ctx.flags.json && dryRun) {
    ctx.ui.json({ team: teamName, dryRun: true, agents, removed: 0 });
    return;
  }

  if (dryRun) {
    ctx.ui.info(`Would remove team '${teamName}' from ${agents.length} agent(s).`);
    ctx.ui.table(['TEAM', 'AGENTS'], [[teamName, agents.join(', ')]]);
    return;
  }

  if (!force) {
    ctx.ui.error(`Refusing to remove team '${teamName}' without --force.`);
    ctx.exit(ExitCodes.ERROR);
  }

  const result = ctx.tmux.removeTeam(teamName);
  if (ctx.flags.json) {
    ctx.ui.json({ team: teamName, removed: result.removed, agents: result.agents });
    return;
  }

  ctx.ui.success(`Removed team '${teamName}' from ${result.removed} pane(s).`);
}
