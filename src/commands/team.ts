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

  const rows = panesToRows(panes);
  if (rows.length === 0) {
    ctx.ui.info('No tmux panes found.');
    return;
  }

  ctx.ui.table(['PANE', 'TARGET', 'AGENT', 'SCOPE', 'CWD', 'CMD'], rows);
}

function panesToRows(panes: TeamPaneInfo[]): string[][] {
  return panes.flatMap((pane) => {
    const registrations: Partial<TeamPaneRegistration>[] = pane.registrations.length
      ? pane.registrations
      : [{ scope: '-', agent: '-' }];

    return registrations.map((registration) => [
      pane.pane,
      pane.target ?? '-',
      formatAgent(registration),
      formatScope(registration),
      pane.cwd ?? '-',
      pane.command || '-',
    ]);
  });
}

function formatAgent(registration: Partial<TeamPaneRegistration>): string {
  if (!registration.agent || registration.agent === '-') return '-';
  return registration.remark
    ? `${registration.agent} (${registration.remark})`
    : registration.agent;
}

function formatScope(registration: Partial<TeamPaneRegistration>): string {
  if (!registration.scopeType || !registration.scope) return '-';
  return `${registration.scopeType}:${registration.scope}`;
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
