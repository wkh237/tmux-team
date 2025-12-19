// ─────────────────────────────────────────────────────────────
// Project Management types
// ─────────────────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'in_progress' | 'done';
export type MilestoneStatus = 'pending' | 'in_progress' | 'done';

export interface Team {
  id: string;
  name: string;
  windowId?: string;
  createdAt: string;
}

export interface Milestone {
  id: string;
  name: string;
  status: MilestoneStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  title: string;
  milestone?: string;
  status: TaskStatus;
  assignee?: string;
  docPath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEvent {
  event: string;
  id: string;
  actor: string;
  ts: string;
  [key: string]: unknown;
}

export interface CreateTaskInput {
  title: string;
  body?: string;
  milestone?: string;
  assignee?: string;
}

export interface UpdateTaskInput {
  status?: TaskStatus;
  assignee?: string;
  title?: string;
  milestone?: string;
}

export interface CreateMilestoneInput {
  name: string;
}

export interface UpdateMilestoneInput {
  name?: string;
  status?: MilestoneStatus;
}

export interface ListTasksFilter {
  milestone?: string;
  status?: TaskStatus;
  assignee?: string;
}

// ─────────────────────────────────────────────────────────────
// Storage backend configuration
// ─────────────────────────────────────────────────────────────

export type StorageBackend = 'fs' | 'github';

export interface TeamConfig {
  backend: StorageBackend;
  repo?: string; // GitHub repo (owner/repo format) for github backend
}

export interface TeamWithConfig extends Team {
  backend: StorageBackend;
  repo?: string;
}
