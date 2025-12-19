// ─────────────────────────────────────────────────────────────
// PM Commands - project management CLI
// ─────────────────────────────────────────────────────────────

import type { Context } from '../types.js';
import { ExitCodes } from '../exits.js';
import { colors } from '../ui.js';
import {
  checkPermission,
  buildPermissionPath,
  PermissionChecks,
  type PermissionCheck,
} from './permissions.js';
import {
  findCurrentTeamId,
  getStorageAdapter,
  generateTeamId,
  getTeamsDir,
  linkTeam,
  listTeams,
  createStorageAdapter,
  saveTeamConfig,
} from './manager.js';
import type { StorageAdapter } from './storage/adapter.js';
import type { TaskStatus, MilestoneStatus, StorageBackend } from './types.js';
import path from 'path';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

async function requireTeam(ctx: Context): Promise<{ teamId: string; storage: StorageAdapter }> {
  const teamId = findCurrentTeamId(process.cwd(), ctx.paths.globalDir);
  if (!teamId) {
    ctx.ui.error("No team found. Run 'tmux-team pm init' first or navigate to a linked directory.");
    ctx.exit(ExitCodes.CONFIG_MISSING);
  }
  const storage = getStorageAdapter(teamId, ctx.paths.globalDir);

  // Validate team exists
  const team = await storage.getTeam();
  if (!team) {
    ctx.ui.error(`Team ${teamId} not found. The .tmux-team-id file may be stale.`);
    ctx.exit(ExitCodes.CONFIG_MISSING);
  }

  return { teamId, storage };
}

function formatStatus(status: TaskStatus | MilestoneStatus): string {
  switch (status) {
    case 'pending':
      return colors.yellow('pending');
    case 'in_progress':
      return colors.blue('in_progress');
    case 'done':
      return colors.green('done');
    default:
      return status;
  }
}

function parseStatus(s: string): TaskStatus {
  const normalized = s.toLowerCase().replace(/-/g, '_');
  if (normalized === 'pending' || normalized === 'in_progress' || normalized === 'done') {
    return normalized as TaskStatus;
  }
  throw new Error(`Invalid status: ${s}. Use: pending, in_progress, done`);
}

function requirePermission(ctx: Context, check: PermissionCheck): void {
  const result = checkPermission(ctx.config, check);

  // Display warning if there's an identity conflict
  if (result.warning) {
    ctx.ui.warn(result.warning);
  }

  if (!result.allowed) {
    const permPath = buildPermissionPath(check);
    ctx.ui.error(`Permission denied: ${result.actor} cannot perform ${permPath}`);
    ctx.exit(ExitCodes.ERROR);
  }
}

// ─────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────

export async function cmdPmInit(ctx: Context, args: string[]): Promise<void> {
  requirePermission(ctx, PermissionChecks.teamCreate());

  const { ui, flags, paths } = ctx;

  // Parse flags: --name, --backend, --repo
  let name = 'Unnamed Project';
  let backend: StorageBackend = 'fs';
  let repo: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name' && args[i + 1]) {
      name = args[++i];
    } else if (args[i].startsWith('--name=')) {
      name = args[i].slice(7);
    } else if (args[i] === '--backend' && args[i + 1]) {
      const b = args[++i];
      if (b !== 'fs' && b !== 'github') {
        ui.error(`Invalid backend: ${b}. Use: fs, github`);
        ctx.exit(ExitCodes.ERROR);
      }
      backend = b;
    } else if (args[i].startsWith('--backend=')) {
      const b = args[i].slice(10);
      if (b !== 'fs' && b !== 'github') {
        ui.error(`Invalid backend: ${b}. Use: fs, github`);
        ctx.exit(ExitCodes.ERROR);
      }
      backend = b as StorageBackend;
    } else if (args[i] === '--repo' && args[i + 1]) {
      repo = args[++i];
    } else if (args[i].startsWith('--repo=')) {
      repo = args[i].slice(7);
    }
  }

  // Validate GitHub backend requires repo
  if (backend === 'github' && !repo) {
    ui.error('GitHub backend requires --repo flag (e.g., --repo owner/repo)');
    ctx.exit(ExitCodes.ERROR);
  }

  const teamId = generateTeamId();
  const teamDir = path.join(getTeamsDir(paths.globalDir), teamId);

  // Save config first
  saveTeamConfig(teamDir, { backend, repo });

  // Create storage adapter
  const storage = createStorageAdapter(teamDir, backend, repo);

  const team = await storage.initTeam(name);
  linkTeam(process.cwd(), teamId);

  await storage.appendEvent({
    event: 'team_created',
    id: teamId,
    name,
    backend,
    repo,
    actor: 'human',
    ts: new Date().toISOString(),
  });

  if (flags.json) {
    ui.json({ team, backend, repo, linked: process.cwd() });
  } else {
    ui.success(`Created team '${name}' (${teamId})`);
    if (backend === 'github') {
      ui.info(`Backend: GitHub (${repo})`);
    }
    ui.info(`Linked to ${process.cwd()}`);
  }
}

export async function cmdPmMilestone(ctx: Context, args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;

  switch (subcommand) {
    case 'add':
      return cmdMilestoneAdd(ctx, rest);
    case 'list':
    case 'ls':
      return cmdMilestoneList(ctx, rest);
    case 'done':
      return cmdMilestoneDone(ctx, rest);
    default:
      ctx.ui.error(`Unknown milestone command: ${subcommand}. Use: add, list, done`);
      ctx.exit(ExitCodes.ERROR);
  }
}

async function cmdMilestoneAdd(ctx: Context, args: string[]): Promise<void> {
  requirePermission(ctx, PermissionChecks.milestoneCreate());

  const { ui, flags } = ctx;
  const { storage } = await requireTeam(ctx);

  const name = args[0];
  if (!name) {
    ui.error('Usage: tmux-team pm milestone add <name>');
    ctx.exit(ExitCodes.ERROR);
  }

  const milestone = await storage.createMilestone({ name });

  await storage.appendEvent({
    event: 'milestone_created',
    id: milestone.id,
    name,
    actor: 'human',
    ts: new Date().toISOString(),
  });

  if (flags.json) {
    ui.json(milestone);
  } else {
    ui.success(`Created milestone #${milestone.id}: ${name}`);
  }
}

async function cmdMilestoneList(ctx: Context, _args: string[]): Promise<void> {
  requirePermission(ctx, PermissionChecks.milestoneList());

  const { ui, flags } = ctx;
  const { storage } = await requireTeam(ctx);

  const milestones = await storage.listMilestones();

  if (flags.json) {
    ui.json(milestones);
    return;
  }

  if (milestones.length === 0) {
    ui.info('No milestones. Use: tmux-team pm milestone add <name>');
    return;
  }

  console.log();
  ui.table(
    ['ID', 'NAME', 'STATUS'],
    milestones.map((m) => [m.id, m.name, formatStatus(m.status)])
  );
  console.log();
}

async function cmdMilestoneDone(ctx: Context, args: string[]): Promise<void> {
  requirePermission(ctx, PermissionChecks.milestoneUpdate(['status']));

  const { ui, flags } = ctx;
  const { storage } = await requireTeam(ctx);

  const id = args[0];
  if (!id) {
    ui.error('Usage: tmux-team pm milestone done <id>');
    ctx.exit(ExitCodes.ERROR);
  }

  const milestone = await storage.getMilestone(id);
  if (!milestone) {
    ui.error(`Milestone ${id} not found`);
    ctx.exit(ExitCodes.PANE_NOT_FOUND);
  }

  const updated = await storage.updateMilestone(id, { status: 'done' });

  await storage.appendEvent({
    event: 'milestone_updated',
    id,
    field: 'status',
    from: milestone.status,
    to: 'done',
    actor: 'human',
    ts: new Date().toISOString(),
  });

  if (flags.json) {
    ui.json(updated);
  } else {
    ui.success(`Milestone #${id} marked as done`);
  }
}

export async function cmdPmTask(ctx: Context, args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;

  switch (subcommand) {
    case 'add':
      return cmdTaskAdd(ctx, rest);
    case 'list':
    case 'ls':
      return cmdTaskList(ctx, rest);
    case 'show':
      return cmdTaskShow(ctx, rest);
    case 'update':
      return cmdTaskUpdate(ctx, rest);
    case 'done':
      return cmdTaskDone(ctx, rest);
    default:
      ctx.ui.error(`Unknown task command: ${subcommand}. Use: add, list, show, update, done`);
      ctx.exit(ExitCodes.ERROR);
  }
}

async function cmdTaskAdd(ctx: Context, args: string[]): Promise<void> {
  requirePermission(ctx, PermissionChecks.taskCreate());

  const { ui, flags } = ctx;
  const { storage } = await requireTeam(ctx);

  // Parse args: <title> [--milestone <id>] [--assignee <name>] [--body <text>]
  let title = '';
  let body: string | undefined;
  let milestone: string | undefined;
  let assignee: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--milestone' || args[i] === '-m') {
      milestone = args[++i];
    } else if (args[i].startsWith('--milestone=')) {
      milestone = args[i].slice(12);
    } else if (args[i] === '--assignee' || args[i] === '-a') {
      assignee = args[++i];
    } else if (args[i].startsWith('--assignee=')) {
      assignee = args[i].slice(11);
    } else if (args[i] === '--body' || args[i] === '-b') {
      body = args[++i];
    } else if (args[i].startsWith('--body=')) {
      body = args[i].slice(7);
    } else if (!title) {
      title = args[i];
    }
  }

  if (!title) {
    ui.error('Usage: tmux-team pm task add <title> [--milestone <id>]');
    ctx.exit(ExitCodes.ERROR);
  }

  const task = await storage.createTask({ title, body, milestone, assignee });

  await storage.appendEvent({
    event: 'task_created',
    id: task.id,
    title,
    milestone,
    actor: 'human',
    ts: new Date().toISOString(),
  });

  if (flags.json) {
    ui.json(task);
  } else {
    ui.success(`Created task #${task.id}: ${title}`);
  }
}

async function cmdTaskList(ctx: Context, args: string[]): Promise<void> {
  requirePermission(ctx, PermissionChecks.taskList());

  const { ui, flags } = ctx;
  const { storage } = await requireTeam(ctx);

  // Parse filters
  let milestone: string | undefined;
  let status: TaskStatus | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--milestone' || args[i] === '-m') {
      milestone = args[++i];
    } else if (args[i].startsWith('--milestone=')) {
      milestone = args[i].slice(12);
    } else if (args[i] === '--status' || args[i] === '-s') {
      status = parseStatus(args[++i]);
    } else if (args[i].startsWith('--status=')) {
      status = parseStatus(args[i].slice(9));
    }
  }

  const tasks = await storage.listTasks({ milestone, status });

  if (flags.json) {
    ui.json(tasks);
    return;
  }

  if (tasks.length === 0) {
    ui.info('No tasks. Use: tmux-team pm task add <title>');
    return;
  }

  console.log();
  ui.table(
    ['ID', 'TITLE', 'STATUS', 'MILESTONE'],
    tasks.map((t) => [t.id, t.title.slice(0, 40), formatStatus(t.status), t.milestone || '-'])
  );
  console.log();
}

async function cmdTaskShow(ctx: Context, args: string[]): Promise<void> {
  requirePermission(ctx, PermissionChecks.taskShow());

  const { ui, flags } = ctx;
  const { storage } = await requireTeam(ctx);

  const id = args[0];
  if (!id) {
    ui.error('Usage: tmux-team pm task show <id>');
    ctx.exit(ExitCodes.ERROR);
  }

  const task = await storage.getTask(id);
  if (!task) {
    ui.error(`Task ${id} not found`);
    ctx.exit(ExitCodes.PANE_NOT_FOUND);
  }

  if (flags.json) {
    ui.json(task);
    return;
  }

  console.log();
  console.log(colors.cyan(`Task #${task.id}: ${task.title}`));
  console.log(`Status: ${formatStatus(task.status)}`);
  if (task.milestone) console.log(`Milestone: #${task.milestone}`);
  if (task.assignee) console.log(`Assignee: ${task.assignee}`);
  console.log(`Created: ${task.createdAt}`);
  console.log(`Updated: ${task.updatedAt}`);
  console.log();
}

async function cmdTaskUpdate(ctx: Context, args: string[]): Promise<void> {
  const { ui, flags } = ctx;

  // Parse: <id> --status <status> [--assignee <name>]
  const id = args[0];
  if (!id) {
    ui.error('Usage: tmux-team pm task update <id> --status <status>');
    ctx.exit(ExitCodes.ERROR);
  }

  let status: TaskStatus | undefined;
  let assignee: string | undefined;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--status' || args[i] === '-s') {
      status = parseStatus(args[++i]);
    } else if (args[i].startsWith('--status=')) {
      status = parseStatus(args[i].slice(9));
    } else if (args[i] === '--assignee' || args[i] === '-a') {
      assignee = args[++i];
    } else if (args[i].startsWith('--assignee=')) {
      assignee = args[i].slice(11);
    }
  }

  // Check permissions based on which fields are being updated
  const fields: string[] = [];
  if (status) fields.push('status');
  if (assignee) fields.push('assignee');
  if (fields.length > 0) {
    requirePermission(ctx, PermissionChecks.taskUpdate(fields));
  }

  const { storage } = await requireTeam(ctx);
  const task = await storage.getTask(id);
  if (!task) {
    ui.error(`Task ${id} not found`);
    ctx.exit(ExitCodes.PANE_NOT_FOUND);
  }

  const updates: { status?: TaskStatus; assignee?: string } = {};
  if (status) updates.status = status;
  if (assignee) updates.assignee = assignee;

  if (Object.keys(updates).length === 0) {
    ui.error('No updates specified. Use --status or --assignee');
    ctx.exit(ExitCodes.ERROR);
  }

  const updated = await storage.updateTask(id, updates);

  if (status) {
    await storage.appendEvent({
      event: 'task_updated',
      id,
      field: 'status',
      from: task.status,
      to: status,
      actor: 'human',
      ts: new Date().toISOString(),
    });
  }

  if (flags.json) {
    ui.json(updated);
  } else {
    ui.success(`Updated task #${id}`);
  }
}

async function cmdTaskDone(ctx: Context, args: string[]): Promise<void> {
  requirePermission(ctx, PermissionChecks.taskUpdate(['status']));

  const { ui, flags } = ctx;
  const { storage } = await requireTeam(ctx);

  const id = args[0];
  if (!id) {
    ui.error('Usage: tmux-team pm task done <id>');
    ctx.exit(ExitCodes.ERROR);
  }

  const task = await storage.getTask(id);
  if (!task) {
    ui.error(`Task ${id} not found`);
    ctx.exit(ExitCodes.PANE_NOT_FOUND);
  }

  const updated = await storage.updateTask(id, { status: 'done' });

  await storage.appendEvent({
    event: 'task_updated',
    id,
    field: 'status',
    from: task.status,
    to: 'done',
    actor: 'human',
    ts: new Date().toISOString(),
  });

  if (flags.json) {
    ui.json(updated);
  } else {
    ui.success(`Task #${id} marked as done`);
  }
}

export async function cmdPmDoc(ctx: Context, args: string[]): Promise<void> {
  const { ui, flags } = ctx;

  const id = args[0];
  if (!id) {
    ui.error('Usage: tmux-team pm doc <id> [--print]');
    ctx.exit(ExitCodes.ERROR);
  }

  const printOnly = args.includes('--print') || args.includes('-p');

  // Check permission based on mode
  if (printOnly || flags.json) {
    requirePermission(ctx, PermissionChecks.docRead());
  } else {
    requirePermission(ctx, PermissionChecks.docUpdate());
  }

  const { teamId, storage } = await requireTeam(ctx);
  const task = await storage.getTask(id);
  if (!task) {
    ui.error(`Task ${id} not found`);
    ctx.exit(ExitCodes.PANE_NOT_FOUND);
  }

  const doc = await storage.getTaskDoc(id);

  if (printOnly || flags.json) {
    if (flags.json) {
      ui.json({ id, doc });
    } else {
      console.log(doc || '(empty)');
    }
    return;
  }

  // Open in editor
  const editor = process.env.EDITOR || 'vim';
  const docPath = path.join(getTeamsDir(ctx.paths.globalDir), teamId, 'tasks', `${id}.md`);

  const { spawnSync } = await import('child_process');
  spawnSync(editor, [docPath], { stdio: 'inherit' });

  ui.success(`Saved documentation for task #${id}`);
}

export async function cmdPmLog(ctx: Context, args: string[]): Promise<void> {
  requirePermission(ctx, PermissionChecks.logRead());

  const { ui, flags } = ctx;
  const { storage } = await requireTeam(ctx);

  // Parse --limit flag
  let limit: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' || args[i] === '-n') {
      limit = parseInt(args[++i], 10);
    } else if (args[i].startsWith('--limit=')) {
      limit = parseInt(args[i].slice(8), 10);
    }
  }

  const events = await storage.getEvents(limit);

  if (flags.json) {
    ui.json(events);
    return;
  }

  if (events.length === 0) {
    ui.info('No events logged yet.');
    return;
  }

  console.log();
  for (const event of events) {
    const time = event.ts.slice(0, 19).replace('T', ' ');
    const actor = colors.cyan(event.actor);
    const action = colors.yellow(event.event);
    const id = event.id ? `#${event.id}` : '';
    console.log(`${colors.dim(time)} ${actor} ${action} ${id}`);
  }
  console.log();
}

export async function cmdPmList(ctx: Context, _args: string[]): Promise<void> {
  requirePermission(ctx, PermissionChecks.teamList());

  const { ui, flags, paths } = ctx;

  const teams = listTeams(paths.globalDir);
  const currentTeamId = findCurrentTeamId(process.cwd(), paths.globalDir);

  if (flags.json) {
    ui.json({ teams, currentTeamId });
    return;
  }

  if (teams.length === 0) {
    ui.info("No teams. Use: tmux-team pm init --name 'My Project'");
    return;
  }

  console.log();
  ui.table(
    ['', 'ID', 'NAME', 'BACKEND', 'CREATED'],
    teams.map((t) => [
      t.id === currentTeamId ? colors.green('→') : ' ',
      t.id.slice(0, 8) + '...',
      t.name,
      t.backend === 'github' ? colors.cyan('github') : colors.dim('fs'),
      t.createdAt.slice(0, 10),
    ])
  );
  console.log();
}

// ─────────────────────────────────────────────────────────────
// Main PM router
// ─────────────────────────────────────────────────────────────

export async function cmdPm(ctx: Context, args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;

  // Handle shorthands
  const cmd = subcommand === 'm' ? 'milestone' : subcommand === 't' ? 'task' : subcommand;

  switch (cmd) {
    case 'init':
      return cmdPmInit(ctx, rest);
    case 'milestone':
      return cmdPmMilestone(ctx, rest);
    case 'task':
      return cmdPmTask(ctx, rest);
    case 'doc':
      return cmdPmDoc(ctx, rest);
    case 'log':
      return cmdPmLog(ctx, rest);
    case 'list':
    case 'ls':
      return cmdPmList(ctx, rest);
    case undefined:
    case 'help':
      return cmdPmHelp(ctx);
    default:
      ctx.ui.error(`Unknown pm command: ${subcommand}. Run 'tmux-team pm help'`);
      ctx.exit(ExitCodes.ERROR);
  }
}

function cmdPmHelp(_ctx: Context): void {
  console.log(`
${colors.cyan('tmux-team pm')} - Project management

${colors.yellow('COMMANDS')}
  ${colors.green('init')} [options]                    Create a new team/project
    --name <name>                    Project name
    --backend <fs|github>            Storage backend (default: fs)
    --repo <owner/repo>              GitHub repo (required for github backend)
  ${colors.green('list')}                              List all teams
  ${colors.green('milestone')} add <name>              Add milestone (shorthand: m)
  ${colors.green('milestone')} list                    List milestones
  ${colors.green('milestone')} done <id>               Mark milestone complete
  ${colors.green('task')} add <title> [--milestone]    Add task (shorthand: t)
  ${colors.green('task')} list [--status] [--milestone] List tasks
  ${colors.green('task')} show <id>                    Show task details
  ${colors.green('task')} update <id> --status <s>     Update task status
  ${colors.green('task')} done <id>                    Mark task complete
  ${colors.green('doc')} <id> [--print]                View/edit task documentation
  ${colors.green('log')} [--limit <n>]                 Show audit event log

${colors.yellow('BACKENDS')}
  ${colors.cyan('fs')}      Local filesystem (default) - tasks in ~/.config/tmux-team/teams/
  ${colors.cyan('github')}  GitHub Issues - tasks become issues, milestones sync with GH

${colors.yellow('SHORTHANDS')}
  pm m  = pm milestone
  pm t  = pm task
  pm ls = pm list

${colors.yellow('EXAMPLES')}
  # Local filesystem backend (default)
  tmux-team pm init --name "Auth Refactor"

  # GitHub backend - uses gh CLI for auth
  tmux-team pm init --name "Sprint 1" --backend github --repo owner/repo

  tmux-team pm m add "Phase 1"
  tmux-team pm t add "Implement login" --milestone 1
  tmux-team pm t list --status pending
  tmux-team pm t done 1
  tmux-team pm log --limit 10
`);
}
