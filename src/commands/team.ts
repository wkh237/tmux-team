// ─────────────────────────────────────────────────────────────
// team command - inspect pane team/workspace scope and manage explicit shared teams
// ─────────────────────────────────────────────────────────────

import type { Context, RegistryScope, TeamPaneInfo, TeamPaneRegistration } from '../types.js';
import { ExitCodes } from '../exits.js';
import { registrationFromEntry } from '../registry.js';

export function cmdTeam(ctx: Context, args: string[]): void {
  const subcommand = args[0];

  switch (subcommand) {
    case undefined:
      listTeamNames(ctx, []);
      break;
    case 'ls':
    case 'list':
      listTeamMembers(ctx, args.slice(1));
      break;
    case 'add':
      addTeamMember(ctx, args.slice(1));
      break;
    case 'rm':
    case 'remove':
      removeTeam(ctx, args.slice(1));
      break;
    case 'panes':
    case 'inventory':
      listPaneInventory(ctx, args.slice(1));
      break;
    default:
      ctx.ui.error(`Unknown team subcommand: ${subcommand}`);
      ctx.ui.error(
        'Usage: tmux-team team [ls <team>|add <team> <name> [pane]|rm <team> --force|panes]'
      );
      ctx.exit(ExitCodes.ERROR);
  }
}

function listTeamNames(ctx: Context, args: string[]): void {
  const teams = ctx.tmux.listTeams();
  const summaryOnly = args.includes('--summary');

  if (ctx.flags.json) {
    ctx.ui.json({ teams });
    return;
  }

  const rows = Object.entries(teams).sort(([a], [b]) => a.localeCompare(b));
  if (rows.length === 0) {
    ctx.ui.info('No shared teams found.');
    return;
  }

  if (summaryOnly) {
    ctx.ui.table(
      ['TEAM', 'AGENTS'],
      rows.map(([teamName, agents]) => [teamName, agents.join(', ') || '-'])
    );
    return;
  }

  ctx.ui.table(
    ['TEAM', 'MEMBERS'],
    rows.map(([teamName, agents]) => [teamName, String(agents.length)])
  );
}

export function listTeamMembers(ctx: Context, args: string[]): void {
  const teamName = args.find((arg) => !arg.startsWith('-'));
  if (!teamName) {
    listTeamNames(ctx, args);
    return;
  }

  const rows = teamMemberRows(ctx.tmux.listTeamPanes(), teamName);
  if (ctx.flags.json) {
    ctx.ui.json({ team: teamName, members: rows.map(rowToMemberJson) });
    return;
  }

  if (rows.length === 0) {
    ctx.ui.info(
      `No agents in team "${teamName}". Use 'tmt team add ${teamName} <name>' to add one.`
    );
    return;
  }

  ctx.ui.table(['NAME', 'PANE', 'TARGET', 'CWD', 'CMD', 'REMARK'], rows);
}

function addTeamMember(ctx: Context, args: string[]): void {
  const [teamName, name, maybePane, ...remarkParts] = args.filter((arg) => !arg.startsWith('-'));
  if (!teamName || !name) {
    ctx.ui.error('Usage: tmux-team team add <team> <name> [pane] [remark]');
    ctx.exit(ExitCodes.ERROR);
  }

  const scope: RegistryScope = { type: 'team', teamName };
  const registry = ctx.tmux.getAgentRegistry(scope);
  if (registry.paneRegistry[name]) {
    ctx.ui.error(
      `Agent '${name}' already exists in team '${teamName}'. Use 'tmux-team update --team ${teamName}' to modify.`
    );
    ctx.exit(ExitCodes.ERROR);
  }

  const targetPane = maybePane ?? ctx.tmux.getCurrentPaneId();
  if (!targetPane) {
    ctx.ui.error(
      'Not running inside tmux. Provide a pane target: tmt team add <team> <name> <pane>'
    );
    ctx.exit(ExitCodes.ERROR);
  }

  const resolvedPane = ctx.tmux.resolvePaneTarget(targetPane);
  if (!resolvedPane) {
    ctx.ui.error(`Pane '${targetPane}' not found. Is tmux running?`);
    ctx.exit(ExitCodes.PANE_NOT_FOUND);
  }

  const remark = remarkParts.length > 0 ? remarkParts.join(' ') : undefined;
  ctx.tmux.setAgentRegistration(
    resolvedPane,
    scope,
    registrationFromEntry(name, {
      pane: resolvedPane,
      ...(remark !== undefined && { remark }),
    })
  );

  if (ctx.flags.json) {
    ctx.ui.json({ added: name, team: teamName, pane: resolvedPane, remark });
    return;
  }

  ctx.ui.success(`Added agent '${name}' to team '${teamName}' at pane ${resolvedPane}`);
}

function listPaneInventory(ctx: Context, _args: string[]): void {
  const teams = ctx.tmux.listTeams();
  const panes = ctx.tmux.listTeamPanes();

  if (ctx.flags.json) {
    ctx.ui.json({ teams, panes });
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

export function listPaneStatus(ctx: Context, target: string): void {
  const resolvedPane = resolvePaneLike(ctx, target);
  if (!resolvedPane) {
    ctx.ui.error(`Pane or team '${target}' not found.`);
    ctx.exit(ExitCodes.PANE_NOT_FOUND);
  }

  const pane = ctx.tmux.listTeamPanes().find((item) => item.pane === resolvedPane);
  if (!pane) {
    ctx.ui.error(`Pane '${target}' not found.`);
    ctx.exit(ExitCodes.PANE_NOT_FOUND);
  }

  if (ctx.flags.json) {
    ctx.ui.json({ pane });
    return;
  }

  console.log(`Pane: ${pane.pane}${pane.target ? ` (${pane.target})` : ''}`);
  console.log(`CWD:  ${pane.cwd ?? '-'}`);
  console.log(`CMD:  ${pane.command || '-'}`);

  if (pane.registrations.length === 0) {
    ctx.ui.info('No registrations on this pane.');
    return;
  }

  ctx.ui.table(
    ['SCOPE', 'NAME', 'REMARK'],
    pane.registrations.map((registration) => [
      registration.scopeType === 'team'
        ? `team:${registration.scope}`
        : `workspace:${registration.scope}`,
      registration.agent,
      registration.remark ?? '-',
    ])
  );
}

function resolvePaneLike(ctx: Context, target: string): string | null {
  const candidates = [target];
  const dotted = target.match(/^([^.]+)\.([^.]+)\.([^.]+)$/);
  if (dotted) {
    candidates.push(`${dotted[1]}:${dotted[2]}.${dotted[3]}`);
  }

  for (const candidate of candidates) {
    const resolved = ctx.tmux.resolvePaneTarget(candidate);
    if (resolved) return resolved;
  }

  return null;
}

function teamMemberRows(panes: TeamPaneInfo[], teamName: string): string[][] {
  const rows: string[][] = [];
  for (const pane of panes) {
    for (const registration of pane.registrations) {
      if (registration.scopeType !== 'team' || registration.scope !== teamName) continue;
      rows.push([
        registration.agent,
        pane.pane,
        pane.target ?? '-',
        pane.cwd ?? '-',
        pane.command || '-',
        registration.remark ?? '-',
      ]);
    }
  }
  return rows.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
}

function rowToMemberJson(row: string[]): {
  name: string;
  pane: string;
  target: string;
  cwd: string;
  command: string;
  remark?: string;
} {
  return {
    name: row[0],
    pane: row[1],
    target: row[2],
    cwd: row[3],
    command: row[4],
    ...(row[5] !== '-' && { remark: row[5] }),
  };
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
