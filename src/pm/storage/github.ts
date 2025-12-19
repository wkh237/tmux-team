// ─────────────────────────────────────────────────────────────
// GitHub storage adapter for PM (Phase 5)
// Uses GitHub Issues for tasks, GitHub Milestones for milestones
// ─────────────────────────────────────────────────────────────

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { StorageAdapter } from './adapter.js';
import type {
  Team,
  Milestone,
  Task,
  AuditEvent,
  CreateTaskInput,
  UpdateTaskInput,
  CreateMilestoneInput,
  UpdateMilestoneInput,
  ListTasksFilter,
  TaskStatus,
} from '../types.js';

// ─────────────────────────────────────────────────────────────
// Labels used for task status tracking
// ─────────────────────────────────────────────────────────────

const LABELS = {
  // Base label for all tmux-team managed issues
  TASK: 'tmux-team:task',
  // Status labels
  PENDING: 'tmux-team:pending',
  IN_PROGRESS: 'tmux-team:in_progress',
  DELETED: 'tmux-team:deleted',
  // 'done' status uses closed issue state, no label needed
} as const;

// ─────────────────────────────────────────────────────────────
// GitHub Issue/Milestone JSON types (from gh CLI)
// ─────────────────────────────────────────────────────────────

interface GHIssue {
  number: number;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED';
  labels: Array<{ name: string }>;
  milestone?: { number: number; title: string } | null;
  assignees: Array<{ login: string }>;
  createdAt: string;
  updatedAt: string;
}

interface GHMilestone {
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED';
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────
// Local cache for ID mapping (task ID -> issue number)
// ─────────────────────────────────────────────────────────────

const CACHE_VERSION = 2;

interface IdCache {
  version: number; // Cache format version for migrations
  repo: string; // Associated repo to detect cross-repo drift
  tasks: Record<string, number>; // task ID -> issue number
  milestones: Record<string, { number: number; name: string }>; // milestone ID -> {number, name}
  nextTaskId: number;
  nextMilestoneId: number;
}

// ─────────────────────────────────────────────────────────────
// GitHub Adapter Implementation
// ─────────────────────────────────────────────────────────────

export class GitHubAdapter implements StorageAdapter {
  private teamDir: string;
  private repo: string;

  constructor(teamDir: string, repo: string) {
    this.teamDir = teamDir;
    this.repo = repo;
  }

  // ─────────────────────────────────────────────────────────────
  // Helper: Execute gh CLI command safely (no shell injection)
  // ─────────────────────────────────────────────────────────────

  private gh(args: string[], options?: { skipRepo?: boolean }): string {
    const fullArgs = [...args];
    // gh api doesn't accept --repo flag (repo is in the endpoint path)
    // Other commands like 'gh issue' do accept --repo
    const isApiCommand = args[0] === 'api';
    if (this.repo && !isApiCommand && !options?.skipRepo) {
      fullArgs.push('--repo', this.repo);
    }
    // Use spawnSync with array args to avoid shell injection
    const result = spawnSync('gh', fullArgs, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (result.error) {
      throw new Error(`gh command failed: ${result.error.message}`);
    }

    if (result.status !== 0) {
      const stderr = result.stderr?.trim() || 'Unknown error';
      // Surface auth errors clearly
      if (stderr.includes('gh auth login') || stderr.includes('not logged in')) {
        throw new Error(`GitHub authentication required. Run: gh auth login`);
      }
      throw new Error(`gh command failed: ${stderr}`);
    }

    return (result.stdout || '').trim();
  }

  private ghJson<T>(args: string[]): T {
    const result = this.gh(args);
    return JSON.parse(result) as T;
  }

  // ─────────────────────────────────────────────────────────────
  // Helper: Local ID cache management
  // ─────────────────────────────────────────────────────────────

  private get cacheFile(): string {
    return path.join(this.teamDir, 'github-cache.json');
  }

  private loadCache(): IdCache {
    if (fs.existsSync(this.cacheFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.cacheFile, 'utf-8')) as IdCache;

        // Validate cache integrity
        if (data.version !== CACHE_VERSION) {
          // Version mismatch - reset cache (future: migration logic)
          console.error(`[tmux-team] Cache version mismatch, resetting cache`);
          return this.createEmptyCache();
        }

        if (data.repo !== this.repo) {
          // Repo mismatch - cache is for different repo, reset
          console.error(
            `[tmux-team] Cache repo mismatch (${data.repo} vs ${this.repo}), resetting cache`
          );
          return this.createEmptyCache();
        }

        // Validate nextId counters are consistent
        const maxTaskId = Math.max(0, ...Object.keys(data.tasks).map((k) => parseInt(k, 10) || 0));
        const maxMilestoneId = Math.max(
          0,
          ...Object.keys(data.milestones).map((k) => parseInt(k, 10) || 0)
        );

        if (data.nextTaskId <= maxTaskId) {
          data.nextTaskId = maxTaskId + 1;
        }
        if (data.nextMilestoneId <= maxMilestoneId) {
          data.nextMilestoneId = maxMilestoneId + 1;
        }

        return data;
      } catch {
        // Corrupted cache, reset
        console.error(`[tmux-team] Cache corrupted, resetting`);
      }
    }
    return this.createEmptyCache();
  }

  private createEmptyCache(): IdCache {
    return {
      version: CACHE_VERSION,
      repo: this.repo,
      tasks: {},
      milestones: {},
      nextTaskId: 1,
      nextMilestoneId: 1,
    };
  }

  private saveCache(cache: IdCache): void {
    fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
    fs.writeFileSync(this.cacheFile, JSON.stringify(cache, null, 2) + '\n');
  }

  private getIssueNumber(taskId: string): number | null {
    const cache = this.loadCache();
    return cache.tasks[taskId] ?? null;
  }

  private getMilestoneNumber(milestoneId: string): number | null {
    const cache = this.loadCache();
    return cache.milestones[milestoneId]?.number ?? null;
  }

  private getMilestoneName(milestoneId: string): string | null {
    const cache = this.loadCache();
    return cache.milestones[milestoneId]?.name ?? null;
  }

  // ─────────────────────────────────────────────────────────────
  // Helper: Status <-> Label conversion
  // ─────────────────────────────────────────────────────────────

  private statusToLabel(status: TaskStatus): string | null {
    switch (status) {
      case 'pending':
        return LABELS.PENDING;
      case 'in_progress':
        return LABELS.IN_PROGRESS;
      case 'done':
        return null; // Use closed state
    }
  }

  private issueToTask(issue: GHIssue, taskId: string, cache?: IdCache): Task {
    let status: TaskStatus = 'pending';
    if (issue.state === 'CLOSED') {
      status = 'done';
    } else if (issue.labels.some((l) => l.name === LABELS.IN_PROGRESS)) {
      status = 'in_progress';
    }

    // Look up local milestone ID from GitHub milestone number
    let milestoneId: string | undefined;
    if (issue.milestone?.number) {
      const c = cache || this.loadCache();
      const ghMilestoneNum = issue.milestone.number;
      milestoneId = Object.entries(c.milestones).find(([, m]) => m.number === ghMilestoneNum)?.[0];
    }

    return {
      id: taskId,
      title: issue.title,
      milestone: milestoneId,
      status,
      assignee: issue.assignees[0]?.login,
      docPath: `github:issue/${issue.number}`,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
    };
  }

  private milestoneToMilestone(ghMilestone: GHMilestone, id: string): Milestone {
    return {
      id,
      name: ghMilestone.title,
      status: ghMilestone.state === 'CLOSED' ? 'done' : 'pending',
      createdAt: ghMilestone.createdAt,
      updatedAt: ghMilestone.createdAt, // GH milestones don't have updatedAt
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Helper: Ensure labels exist
  // ─────────────────────────────────────────────────────────────

  private async ensureLabels(): Promise<void> {
    const labels = [
      { name: LABELS.TASK, color: '0366d6', desc: 'tmux-team managed task' },
      { name: LABELS.PENDING, color: 'fbca04', desc: 'Task pending' },
      { name: LABELS.IN_PROGRESS, color: '1d76db', desc: 'Task in progress' },
      { name: LABELS.DELETED, color: 'b60205', desc: 'Task deleted' },
    ];
    for (const label of labels) {
      try {
        this.gh([
          'label',
          'create',
          label.name,
          '--force',
          '--color',
          label.color,
          '--description',
          label.desc,
        ]);
      } catch {
        // Label might already exist, ignore
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Team operations
  // ─────────────────────────────────────────────────────────────

  private get teamFile(): string {
    return path.join(this.teamDir, 'team.json');
  }

  private get eventsFile(): string {
    return path.join(this.teamDir, 'events.jsonl');
  }

  private now(): string {
    return new Date().toISOString();
  }

  async initTeam(name: string, windowId?: string): Promise<Team> {
    fs.mkdirSync(this.teamDir, { recursive: true });

    // Ensure labels exist in the repo
    await this.ensureLabels();

    const team: Team = {
      id: path.basename(this.teamDir),
      name,
      windowId,
      createdAt: this.now(),
    };

    fs.writeFileSync(this.teamFile, JSON.stringify(team, null, 2) + '\n');

    // Initialize empty cache with version and repo
    this.saveCache(this.createEmptyCache());

    return team;
  }

  async getTeam(): Promise<Team | null> {
    if (!fs.existsSync(this.teamFile)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.teamFile, 'utf-8')) as Team;
    } catch {
      return null;
    }
  }

  async updateTeam(updates: Partial<Team>): Promise<Team> {
    const team = await this.getTeam();
    if (!team) throw new Error('Team not initialized');
    const updated = { ...team, ...updates };
    fs.writeFileSync(this.teamFile, JSON.stringify(updated, null, 2) + '\n');
    return updated;
  }

  // ─────────────────────────────────────────────────────────────
  // Milestone operations (GitHub Milestones)
  // ─────────────────────────────────────────────────────────────

  async createMilestone(input: CreateMilestoneInput): Promise<Milestone> {
    // Create milestone in GitHub
    const result = this.gh([
      'api',
      `repos/${this.repo}/milestones`,
      '-X',
      'POST',
      '-f',
      `title=${input.name}`,
      '-f',
      'state=open',
    ]);
    const ghMilestone = JSON.parse(result) as { number: number; title: string; created_at: string };

    // Cache the ID mapping (store both number and name)
    const cache = this.loadCache();
    const id = String(cache.nextMilestoneId++);
    cache.milestones[id] = { number: ghMilestone.number, name: ghMilestone.title };
    this.saveCache(cache);

    return {
      id,
      name: ghMilestone.title,
      status: 'pending',
      createdAt: ghMilestone.created_at,
      updatedAt: ghMilestone.created_at,
    };
  }

  async getMilestone(id: string): Promise<Milestone | null> {
    const number = this.getMilestoneNumber(id);
    if (!number) return null;

    try {
      const result = this.gh(['api', `repos/${this.repo}/milestones/${number}`]);
      const ghMilestone = JSON.parse(result) as GHMilestone;
      return this.milestoneToMilestone(ghMilestone, id);
    } catch (error) {
      const err = error as Error;
      if (err.message.includes('auth')) {
        throw err; // Re-throw auth errors
      }
      return null; // Not found or other error
    }
  }

  async listMilestones(): Promise<Milestone[]> {
    const cache = this.loadCache();
    const milestones: Milestone[] = [];

    try {
      // Get all milestones (open and closed)
      const result = this.gh([
        'api',
        `repos/${this.repo}/milestones`,
        '-X',
        'GET',
        '--jq',
        '.',
        '-f',
        'state=all',
      ]);
      const ghMilestones = JSON.parse(result) as GHMilestone[];

      // Match with cached IDs, or create new mappings
      for (const ghm of ghMilestones) {
        let id = Object.entries(cache.milestones).find(([, m]) => m.number === ghm.number)?.[0];
        if (!id) {
          // New milestone from GitHub, assign ID
          id = String(cache.nextMilestoneId++);
          cache.milestones[id] = { number: ghm.number, name: ghm.title };
        }
        milestones.push(this.milestoneToMilestone(ghm, id));
      }

      this.saveCache(cache);
    } catch (error) {
      // Surface auth errors instead of silently returning empty array
      const err = error as Error;
      if (err.message.includes('auth')) {
        throw err; // Re-throw auth errors
      }
      // Other errors (no milestones, network issues) return empty array
    }

    return milestones.sort((a, b) => parseInt(a.id) - parseInt(b.id));
  }

  async updateMilestone(id: string, input: UpdateMilestoneInput): Promise<Milestone> {
    const number = this.getMilestoneNumber(id);
    if (!number) throw new Error(`Milestone ${id} not found`);

    const args = ['api', `repos/${this.repo}/milestones/${number}`, '-X', 'PATCH'];
    if (input.name) args.push('-f', `title=${input.name}`);
    if (input.status) {
      args.push('-f', `state=${input.status === 'done' ? 'closed' : 'open'}`);
    }

    const result = this.gh(args);
    const ghMilestone = JSON.parse(result) as GHMilestone;
    return this.milestoneToMilestone(ghMilestone, id);
  }

  async deleteMilestone(id: string): Promise<void> {
    const number = this.getMilestoneNumber(id);
    if (!number) return;

    try {
      this.gh(['api', `repos/${this.repo}/milestones/${number}`, '-X', 'DELETE']);
    } catch {
      // Already deleted or not found
    }

    // Remove from cache
    const cache = this.loadCache();
    delete cache.milestones[id];
    this.saveCache(cache);
  }

  // ─────────────────────────────────────────────────────────────
  // Task operations (GitHub Issues)
  // ─────────────────────────────────────────────────────────────

  async createTask(input: CreateTaskInput): Promise<Task> {
    // Always add both TASK (base) and PENDING (status) labels
    const args = [
      'issue',
      'create',
      '--title',
      input.title,
      '--body',
      input.body || '', // Required for non-interactive mode
      '--label',
      LABELS.TASK,
      '--label',
      LABELS.PENDING,
    ];

    // Add milestone if specified (gh issue create expects milestone name, not number)
    if (input.milestone) {
      const milestoneName = this.getMilestoneName(input.milestone);
      if (milestoneName) {
        args.push('--milestone', milestoneName);
      }
    }

    // NOTE: Assignee is intentionally NOT supported for GitHub backend.
    // Agent names (e.g., "codex") don't map to GitHub usernames, and passing
    // them could accidentally notify unrelated GitHub users or fail silently.
    // Use labels or comments for agent attribution instead.

    // Create issue and get its number
    const url = this.gh(args);
    const issueNumber = parseInt(url.split('/').pop() || '0', 10);

    // Cache the ID mapping
    const cache = this.loadCache();
    const id = String(cache.nextTaskId++);
    cache.tasks[id] = issueNumber;
    this.saveCache(cache);

    // Fetch the created issue for full details
    const issue = this.ghJson<GHIssue>([
      'issue',
      'view',
      String(issueNumber),
      '--json',
      'number,title,body,state,labels,milestone,assignees,createdAt,updatedAt',
    ]);

    return this.issueToTask(issue, id);
  }

  async getTask(id: string): Promise<Task | null> {
    const number = this.getIssueNumber(id);
    if (!number) return null;

    try {
      const issue = this.ghJson<GHIssue>([
        'issue',
        'view',
        String(number),
        '--json',
        'number,title,body,state,labels,milestone,assignees,createdAt,updatedAt',
      ]);
      return this.issueToTask(issue, id);
    } catch {
      return null;
    }
  }

  async listTasks(filter?: ListTasksFilter): Promise<Task[]> {
    let cache = this.loadCache();

    // Rebuild milestone cache if empty (e.g., after cache reset)
    if (Object.keys(cache.milestones).length === 0) {
      await this.listMilestones(); // This populates the cache
      cache = this.loadCache(); // Reload updated cache
    }

    const args = [
      'issue',
      'list',
      '--json',
      'number,title,body,state,labels,milestone,assignees,createdAt,updatedAt',
      '--limit',
      '1000',
    ];

    // Filter by status
    if (filter?.status === 'done') {
      args.push('--state', 'closed');
    } else if (filter?.status) {
      args.push('--state', 'open');
      args.push('--label', filter.status === 'in_progress' ? LABELS.IN_PROGRESS : LABELS.PENDING);
    } else {
      args.push('--state', 'all');
    }

    // Filter by milestone (gh issue list expects milestone name)
    if (filter?.milestone) {
      const milestoneName = this.getMilestoneName(filter.milestone);
      if (milestoneName) {
        args.push('--milestone', milestoneName);
      }
    }

    // NOTE: Assignee filter not supported for GitHub backend (security risk)

    // Only get tmux-team managed issues (all have TASK label)
    args.push('--label', LABELS.TASK);

    try {
      const issues = this.ghJson<GHIssue[]>(args);
      const tasks: Task[] = [];

      for (const issue of issues) {
        // Find or create ID mapping
        let id = Object.entries(cache.tasks).find(([, num]) => num === issue.number)?.[0];
        if (!id) {
          id = String(cache.nextTaskId++);
          cache.tasks[id] = issue.number;
        }
        // Pass cache for efficient milestone lookup
        tasks.push(this.issueToTask(issue, id, cache));
      }

      this.saveCache(cache);
      return tasks.sort((a, b) => parseInt(a.id) - parseInt(b.id));
    } catch (error) {
      // Surface errors instead of silently returning empty array
      const err = error as Error;
      if (err.message.includes('auth')) {
        throw err; // Re-throw auth errors
      }
      return [];
    }
  }

  async updateTask(id: string, input: UpdateTaskInput): Promise<Task> {
    const number = this.getIssueNumber(id);
    if (!number) throw new Error(`Task ${id} not found`);

    const args = ['issue', 'edit', String(number)];

    if (input.title) {
      args.push('--title', input.title);
    }

    // NOTE: Assignee updates are not supported for GitHub backend (security risk)

    if (input.milestone) {
      const milestoneName = this.getMilestoneName(input.milestone);
      if (milestoneName) {
        args.push('--milestone', milestoneName);
      }
    }

    // Handle status change via labels
    if (input.status) {
      if (input.status === 'done') {
        // Close the issue
        this.gh(['issue', 'close', String(number)]);
        // Remove status labels
        this.gh(['issue', 'edit', String(number), '--remove-label', LABELS.PENDING]);
        this.gh(['issue', 'edit', String(number), '--remove-label', LABELS.IN_PROGRESS]);
      } else {
        // Reopen if needed
        this.gh(['issue', 'reopen', String(number)]);
        // Update labels
        const newLabel = this.statusToLabel(input.status);
        const oldLabel = input.status === 'pending' ? LABELS.IN_PROGRESS : LABELS.PENDING;
        if (newLabel) {
          this.gh([
            'issue',
            'edit',
            String(number),
            '--add-label',
            newLabel,
            '--remove-label',
            oldLabel,
          ]);
        }
      }
    }

    // Apply other edits
    if (args.length > 3) {
      this.gh(args);
    }

    // Return updated task
    const task = await this.getTask(id);
    if (!task) throw new Error(`Task ${id} not found after update`);
    return task;
  }

  async deleteTask(id: string): Promise<void> {
    const number = this.getIssueNumber(id);
    if (!number) return;

    // Close the issue (GitHub doesn't allow deleting issues via API)
    try {
      this.gh(['issue', 'close', String(number)]);
      // Add a label to indicate it was deleted
      this.gh(['issue', 'edit', String(number), '--add-label', LABELS.DELETED]);
    } catch {
      // Already closed or not found
    }

    // Remove from cache
    const cache = this.loadCache();
    delete cache.tasks[id];
    this.saveCache(cache);
  }

  // ─────────────────────────────────────────────────────────────
  // Documentation (Issue body)
  // ─────────────────────────────────────────────────────────────

  async getTaskDoc(id: string): Promise<string | null> {
    const number = this.getIssueNumber(id);
    if (!number) return null;

    try {
      const issue = this.ghJson<GHIssue>(['issue', 'view', String(number), '--json', 'body']);
      return issue.body || null;
    } catch {
      return null;
    }
  }

  async setTaskDoc(id: string, content: string): Promise<void> {
    const number = this.getIssueNumber(id);
    if (!number) throw new Error(`Task ${id} not found`);

    this.gh(['issue', 'edit', String(number), '--body', content]);
  }

  // ─────────────────────────────────────────────────────────────
  // Audit log (Issue Comments)
  // ─────────────────────────────────────────────────────────────

  async appendEvent(event: AuditEvent): Promise<void> {
    // Also append to local JSONL for offline access
    fs.mkdirSync(this.teamDir, { recursive: true });
    fs.appendFileSync(this.eventsFile, JSON.stringify(event) + '\n', { flag: 'a' });

    // If event is related to a task, add comment to the issue
    // Events are named: task_created, task_updated, etc.
    if (event.id && event.event.startsWith('task_')) {
      const number = this.getIssueNumber(event.id);
      if (number) {
        // Format a readable comment
        let comment = `[tmux-team] **${event.actor}** - \`${event.event}\``;
        if (event.field && event.from !== undefined && event.to !== undefined) {
          comment += `\n\n${event.field}: ${event.from} → ${event.to}`;
        }
        try {
          this.gh(['issue', 'comment', String(number), '--body', comment]);
        } catch {
          // Ignore comment failures (might be rate limited)
        }
      }
    }
  }

  async getEvents(limit?: number): Promise<AuditEvent[]> {
    // Read from local JSONL (primary source)
    if (!fs.existsSync(this.eventsFile)) return [];
    const lines = fs.readFileSync(this.eventsFile, 'utf-8').trim().split('\n');
    const events: AuditEvent[] = [];
    for (const line of lines) {
      if (line.trim()) {
        try {
          events.push(JSON.parse(line) as AuditEvent);
        } catch {
          // Skip malformed lines
        }
      }
    }
    if (limit) {
      return events.slice(-limit);
    }
    return events;
  }
}

// ─────────────────────────────────────────────────────────────
// Factory function
// ─────────────────────────────────────────────────────────────

export function createGitHubAdapter(teamDir: string, repo: string): StorageAdapter {
  return new GitHubAdapter(teamDir, repo);
}
