// ─────────────────────────────────────────────────────────────
// Storage adapter interface for PM backends
// ─────────────────────────────────────────────────────────────

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

/**
 * Abstract storage adapter interface.
 * Implemented by:
 * - FSAdapter (Phase 4): Local filesystem storage
 * - GitHubAdapter (Phase 5): GitHub Issues as storage
 */
export interface StorageAdapter {
  // Team operations
  initTeam(name: string, windowId?: string): Promise<Team>;
  getTeam(): Promise<Team | null>;
  updateTeam(updates: Partial<Team>): Promise<Team>;

  // Milestone operations
  createMilestone(input: CreateMilestoneInput): Promise<Milestone>;
  getMilestone(id: string): Promise<Milestone | null>;
  listMilestones(): Promise<Milestone[]>;
  updateMilestone(id: string, input: UpdateMilestoneInput): Promise<Milestone>;
  deleteMilestone(id: string): Promise<void>;

  // Task operations
  createTask(input: CreateTaskInput): Promise<Task>;
  getTask(id: string): Promise<Task | null>;
  listTasks(filter?: ListTasksFilter): Promise<Task[]>;
  updateTask(id: string, input: UpdateTaskInput): Promise<Task>;
  deleteTask(id: string): Promise<void>;

  // Documentation
  getTaskDoc(id: string): Promise<string | null>;
  setTaskDoc(id: string, content: string): Promise<void>;
  getMilestoneDoc(id: string): Promise<string | null>;
  setMilestoneDoc(id: string, content: string): Promise<void>;

  // Audit log
  appendEvent(event: AuditEvent): Promise<void>;
  getEvents(limit?: number): Promise<AuditEvent[]>;
}

/**
 * Factory function type for creating storage adapters.
 */
export type StorageAdapterFactory = (teamDir: string) => StorageAdapter;
