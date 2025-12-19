// ─────────────────────────────────────────────────────────────
// Filesystem storage adapter for PM
// ─────────────────────────────────────────────────────────────

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
} from '../types.js';

export class FSAdapter implements StorageAdapter {
  private teamDir: string;

  constructor(teamDir: string) {
    this.teamDir = teamDir;
  }

  private get teamFile(): string {
    return path.join(this.teamDir, 'team.json');
  }

  private get milestonesDir(): string {
    return path.join(this.teamDir, 'milestones');
  }

  private get tasksDir(): string {
    return path.join(this.teamDir, 'tasks');
  }

  private get eventsFile(): string {
    return path.join(this.teamDir, 'events.jsonl');
  }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private readJson<T>(filePath: string): T | null {
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
    } catch {
      return null;
    }
  }

  private writeJson(filePath: string, data: unknown): void {
    this.ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  }

  private now(): string {
    return new Date().toISOString();
  }

  private nextId(dir: string): string {
    this.ensureDir(dir);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const ids = files.map((f) => parseInt(f.replace('.json', ''), 10)).filter((n) => !isNaN(n));
    const max = ids.length > 0 ? Math.max(...ids) : 0;
    return String(max + 1);
  }

  // Team operations
  async initTeam(name: string, windowId?: string): Promise<Team> {
    this.ensureDir(this.teamDir);
    const team: Team = {
      id: path.basename(this.teamDir),
      name,
      windowId,
      createdAt: this.now(),
    };
    this.writeJson(this.teamFile, team);
    this.ensureDir(this.milestonesDir);
    this.ensureDir(this.tasksDir);
    return team;
  }

  async getTeam(): Promise<Team | null> {
    return this.readJson<Team>(this.teamFile);
  }

  async updateTeam(updates: Partial<Team>): Promise<Team> {
    const team = await this.getTeam();
    if (!team) throw new Error('Team not initialized');
    const updated = { ...team, ...updates };
    this.writeJson(this.teamFile, updated);
    return updated;
  }

  // Milestone operations
  async createMilestone(input: CreateMilestoneInput): Promise<Milestone> {
    const id = this.nextId(this.milestonesDir);
    const milestone: Milestone = {
      id,
      name: input.name,
      status: 'pending',
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.writeJson(path.join(this.milestonesDir, `${id}.json`), milestone);
    return milestone;
  }

  async getMilestone(id: string): Promise<Milestone | null> {
    return this.readJson<Milestone>(path.join(this.milestonesDir, `${id}.json`));
  }

  async listMilestones(): Promise<Milestone[]> {
    this.ensureDir(this.milestonesDir);
    const files = fs.readdirSync(this.milestonesDir).filter((f) => f.endsWith('.json'));
    const milestones: Milestone[] = [];
    for (const file of files) {
      const m = this.readJson<Milestone>(path.join(this.milestonesDir, file));
      if (m) milestones.push(m);
    }
    return milestones.sort((a, b) => parseInt(a.id) - parseInt(b.id));
  }

  async updateMilestone(id: string, input: UpdateMilestoneInput): Promise<Milestone> {
    const milestone = await this.getMilestone(id);
    if (!milestone) throw new Error(`Milestone ${id} not found`);
    const updated: Milestone = {
      ...milestone,
      ...input,
      updatedAt: this.now(),
    };
    this.writeJson(path.join(this.milestonesDir, `${id}.json`), updated);
    return updated;
  }

  async deleteMilestone(id: string): Promise<void> {
    const filePath = path.join(this.milestonesDir, `${id}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  // Task operations
  async createTask(input: CreateTaskInput): Promise<Task> {
    const id = this.nextId(this.tasksDir);
    const task: Task = {
      id,
      title: input.title,
      milestone: input.milestone,
      status: 'pending',
      assignee: input.assignee,
      docPath: `tasks/${id}.md`,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.writeJson(path.join(this.tasksDir, `${id}.json`), task);
    // Create empty doc file
    fs.writeFileSync(path.join(this.tasksDir, `${id}.md`), `# ${input.title}\n\n`);
    return task;
  }

  async getTask(id: string): Promise<Task | null> {
    return this.readJson<Task>(path.join(this.tasksDir, `${id}.json`));
  }

  async listTasks(filter?: ListTasksFilter): Promise<Task[]> {
    this.ensureDir(this.tasksDir);
    const files = fs.readdirSync(this.tasksDir).filter((f) => f.endsWith('.json'));
    let tasks: Task[] = [];
    for (const file of files) {
      const t = this.readJson<Task>(path.join(this.tasksDir, file));
      if (t) tasks.push(t);
    }

    // Apply filters
    if (filter?.milestone) {
      tasks = tasks.filter((t) => t.milestone === filter.milestone);
    }
    if (filter?.status) {
      tasks = tasks.filter((t) => t.status === filter.status);
    }
    if (filter?.assignee) {
      tasks = tasks.filter((t) => t.assignee === filter.assignee);
    }

    return tasks.sort((a, b) => parseInt(a.id) - parseInt(b.id));
  }

  async updateTask(id: string, input: UpdateTaskInput): Promise<Task> {
    const task = await this.getTask(id);
    if (!task) throw new Error(`Task ${id} not found`);
    const updated: Task = {
      ...task,
      ...input,
      updatedAt: this.now(),
    };
    this.writeJson(path.join(this.tasksDir, `${id}.json`), updated);
    return updated;
  }

  async deleteTask(id: string): Promise<void> {
    const jsonPath = path.join(this.tasksDir, `${id}.json`);
    const mdPath = path.join(this.tasksDir, `${id}.md`);
    if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
    if (fs.existsSync(mdPath)) fs.unlinkSync(mdPath);
  }

  // Documentation
  async getTaskDoc(id: string): Promise<string | null> {
    const docPath = path.join(this.tasksDir, `${id}.md`);
    if (!fs.existsSync(docPath)) return null;
    return fs.readFileSync(docPath, 'utf-8');
  }

  async setTaskDoc(id: string, content: string): Promise<void> {
    const docPath = path.join(this.tasksDir, `${id}.md`);
    fs.writeFileSync(docPath, content);
  }

  // Audit log
  async appendEvent(event: AuditEvent): Promise<void> {
    this.ensureDir(this.teamDir);
    fs.appendFileSync(this.eventsFile, JSON.stringify(event) + '\n', { flag: 'a' });
  }

  async getEvents(limit?: number): Promise<AuditEvent[]> {
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

export function createFSAdapter(teamDir: string): StorageAdapter {
  return new FSAdapter(teamDir);
}
