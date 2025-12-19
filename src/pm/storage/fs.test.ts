// ─────────────────────────────────────────────────────────────
// FS Storage Adapter Tests
// ─────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { FSAdapter, createFSAdapter } from './fs.js';

describe('FSAdapter', () => {
  let testDir: string;
  let adapter: FSAdapter;

  beforeEach(() => {
    // Create a unique temp directory for each test
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-team-test-'));
    adapter = new FSAdapter(testDir);
  });

  afterEach(() => {
    // Clean up temp directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('Team Operations', () => {
    it('creates team directory structure on initTeam', async () => {
      await adapter.initTeam('Test Project');

      expect(fs.existsSync(testDir)).toBe(true);
      expect(fs.existsSync(path.join(testDir, 'milestones'))).toBe(true);
      expect(fs.existsSync(path.join(testDir, 'tasks'))).toBe(true);
    });

    it('writes team.json with id, name, createdAt', async () => {
      const team = await adapter.initTeam('My Project', 'window-1');

      expect(team.name).toBe('My Project');
      expect(team.windowId).toBe('window-1');
      expect(team.id).toBe(path.basename(testDir));
      expect(team.createdAt).toBeDefined();

      // Verify file contents
      const teamFile = path.join(testDir, 'team.json');
      const saved = JSON.parse(fs.readFileSync(teamFile, 'utf-8'));
      expect(saved.name).toBe('My Project');
    });

    it('returns team data from team.json', async () => {
      await adapter.initTeam('Test Project');
      const team = await adapter.getTeam();

      expect(team).not.toBeNull();
      expect(team?.name).toBe('Test Project');
    });

    it('returns null when team.json does not exist', async () => {
      const team = await adapter.getTeam();
      expect(team).toBeNull();
    });

    it('updates team data', async () => {
      await adapter.initTeam('Original Name');
      const updated = await adapter.updateTeam({ name: 'New Name' });

      expect(updated.name).toBe('New Name');

      // Verify persisted
      const team = await adapter.getTeam();
      expect(team?.name).toBe('New Name');
    });

    it('throws error when updating non-existent team', async () => {
      await expect(adapter.updateTeam({ name: 'New' })).rejects.toThrow('Team not initialized');
    });
  });

  describe('Milestone Operations', () => {
    beforeEach(async () => {
      await adapter.initTeam('Test Project');
    });

    it('creates milestone with auto-incremented ID', async () => {
      const m1 = await adapter.createMilestone({ name: 'Phase 1' });
      const m2 = await adapter.createMilestone({ name: 'Phase 2' });
      const m3 = await adapter.createMilestone({ name: 'Phase 3' });

      expect(m1.id).toBe('1');
      expect(m2.id).toBe('2');
      expect(m3.id).toBe('3');
    });

    it('writes milestone to milestones/<id>.json', async () => {
      const milestone = await adapter.createMilestone({ name: 'MVP' });
      const filePath = path.join(testDir, 'milestones', `${milestone.id}.json`);

      expect(fs.existsSync(filePath)).toBe(true);
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(saved.name).toBe('MVP');
      expect(saved.status).toBe('pending');
    });

    it('lists all milestones sorted by ID', async () => {
      await adapter.createMilestone({ name: 'Phase 3' });
      await adapter.createMilestone({ name: 'Phase 1' });
      await adapter.createMilestone({ name: 'Phase 2' });

      const milestones = await adapter.listMilestones();

      expect(milestones).toHaveLength(3);
      expect(milestones[0].id).toBe('1');
      expect(milestones[1].id).toBe('2');
      expect(milestones[2].id).toBe('3');
    });

    it('returns milestone by ID', async () => {
      await adapter.createMilestone({ name: 'Test' });
      const milestone = await adapter.getMilestone('1');

      expect(milestone).not.toBeNull();
      expect(milestone?.name).toBe('Test');
    });

    it('returns null for non-existent milestone', async () => {
      const milestone = await adapter.getMilestone('999');
      expect(milestone).toBeNull();
    });

    it('updates milestone status', async () => {
      await adapter.createMilestone({ name: 'Test' });
      const updated = await adapter.updateMilestone('1', { status: 'done' });

      expect(updated.status).toBe('done');

      const milestone = await adapter.getMilestone('1');
      expect(milestone?.status).toBe('done');
    });

    it('updates milestone updatedAt on change', async () => {
      const original = await adapter.createMilestone({ name: 'Test' });
      const originalUpdatedAt = original.updatedAt;

      // Small delay to ensure different timestamp
      await new Promise((r) => setTimeout(r, 10));

      const updated = await adapter.updateMilestone('1', { name: 'Updated' });
      expect(updated.updatedAt).not.toBe(originalUpdatedAt);
    });

    it('throws error when updating non-existent milestone', async () => {
      await expect(adapter.updateMilestone('999', { name: 'New' })).rejects.toThrow(
        'Milestone 999 not found'
      );
    });

    it('deletes milestone', async () => {
      await adapter.createMilestone({ name: 'Test' });
      await adapter.deleteMilestone('1');

      const milestone = await adapter.getMilestone('1');
      expect(milestone).toBeNull();
    });
  });

  describe('Task Operations', () => {
    beforeEach(async () => {
      await adapter.initTeam('Test Project');
    });

    it('creates task with auto-incremented ID', async () => {
      const t1 = await adapter.createTask({ title: 'Task 1' });
      const t2 = await adapter.createTask({ title: 'Task 2' });

      expect(t1.id).toBe('1');
      expect(t2.id).toBe('2');
    });

    it('writes task to tasks/<id>.json', async () => {
      const task = await adapter.createTask({ title: 'Implement feature' });
      const filePath = path.join(testDir, 'tasks', `${task.id}.json`);

      expect(fs.existsSync(filePath)).toBe(true);
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(saved.title).toBe('Implement feature');
      expect(saved.status).toBe('pending');
    });

    it('creates markdown doc file for task', async () => {
      const task = await adapter.createTask({ title: 'My Task' });
      const docPath = path.join(testDir, 'tasks', `${task.id}.md`);

      expect(fs.existsSync(docPath)).toBe(true);
      const content = fs.readFileSync(docPath, 'utf-8');
      expect(content).toContain('# My Task');
    });

    it('creates task with milestone and assignee', async () => {
      await adapter.createMilestone({ name: 'Phase 1' });
      const task = await adapter.createTask({
        title: 'Test',
        milestone: '1',
        assignee: 'claude',
      });

      expect(task.milestone).toBe('1');
      expect(task.assignee).toBe('claude');
    });

    it('lists all tasks sorted by ID', async () => {
      await adapter.createTask({ title: 'Third' });
      await adapter.createTask({ title: 'First' });
      await adapter.createTask({ title: 'Second' });

      const tasks = await adapter.listTasks();

      expect(tasks).toHaveLength(3);
      expect(tasks[0].id).toBe('1');
      expect(tasks[1].id).toBe('2');
      expect(tasks[2].id).toBe('3');
    });

    it('filters tasks by milestone', async () => {
      await adapter.createTask({ title: 'Task 1', milestone: '1' });
      await adapter.createTask({ title: 'Task 2', milestone: '2' });
      await adapter.createTask({ title: 'Task 3', milestone: '1' });

      const tasks = await adapter.listTasks({ milestone: '1' });

      expect(tasks).toHaveLength(2);
      expect(tasks.every((t) => t.milestone === '1')).toBe(true);
    });

    it('filters tasks by status', async () => {
      const t1 = await adapter.createTask({ title: 'Pending' });
      await adapter.createTask({ title: 'Also Pending' });
      await adapter.updateTask(t1.id, { status: 'done' });

      const pending = await adapter.listTasks({ status: 'pending' });
      const done = await adapter.listTasks({ status: 'done' });

      expect(pending).toHaveLength(1);
      expect(done).toHaveLength(1);
    });

    it('filters tasks by assignee', async () => {
      await adapter.createTask({ title: 'Task 1', assignee: 'claude' });
      await adapter.createTask({ title: 'Task 2', assignee: 'codex' });

      const tasks = await adapter.listTasks({ assignee: 'claude' });

      expect(tasks).toHaveLength(1);
      expect(tasks[0].assignee).toBe('claude');
    });

    it('returns task by ID', async () => {
      await adapter.createTask({ title: 'Test Task' });
      const task = await adapter.getTask('1');

      expect(task).not.toBeNull();
      expect(task?.title).toBe('Test Task');
    });

    it('returns null for non-existent task', async () => {
      const task = await adapter.getTask('999');
      expect(task).toBeNull();
    });

    it('updates task status', async () => {
      await adapter.createTask({ title: 'Test' });
      const updated = await adapter.updateTask('1', { status: 'in_progress' });

      expect(updated.status).toBe('in_progress');
    });

    it('throws error when updating non-existent task', async () => {
      await expect(adapter.updateTask('999', { status: 'done' })).rejects.toThrow(
        'Task 999 not found'
      );
    });

    it('deletes task and its doc file', async () => {
      await adapter.createTask({ title: 'Test' });
      await adapter.deleteTask('1');

      expect(await adapter.getTask('1')).toBeNull();
      expect(await adapter.getTaskDoc('1')).toBeNull();
    });
  });

  describe('Task Documentation', () => {
    beforeEach(async () => {
      await adapter.initTeam('Test Project');
    });

    it('gets task documentation', async () => {
      await adapter.createTask({ title: 'Test' });
      const doc = await adapter.getTaskDoc('1');

      expect(doc).toContain('# Test');
    });

    it('sets task documentation', async () => {
      await adapter.createTask({ title: 'Test' });
      await adapter.setTaskDoc('1', '# Updated\n\nNew content');

      const doc = await adapter.getTaskDoc('1');
      expect(doc).toBe('# Updated\n\nNew content');
    });

    it('returns null for non-existent doc', async () => {
      const doc = await adapter.getTaskDoc('999');
      expect(doc).toBeNull();
    });
  });

  describe('Audit Log', () => {
    beforeEach(async () => {
      await adapter.initTeam('Test Project');
    });

    it('appends event to events.jsonl', async () => {
      await adapter.appendEvent({
        event: 'task_created',
        id: '1',
        actor: 'human',
        ts: new Date().toISOString(),
      });

      const events = await adapter.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].event).toBe('task_created');
    });

    it('appends multiple events', async () => {
      await adapter.appendEvent({ event: 'event1', id: '1', actor: 'human', ts: '' });
      await adapter.appendEvent({ event: 'event2', id: '2', actor: 'claude', ts: '' });
      await adapter.appendEvent({ event: 'event3', id: '3', actor: 'codex', ts: '' });

      const events = await adapter.getEvents();
      expect(events).toHaveLength(3);
    });

    it('returns events with limit', async () => {
      for (let i = 0; i < 10; i++) {
        await adapter.appendEvent({ event: `event${i}`, id: String(i), actor: 'human', ts: '' });
      }

      const events = await adapter.getEvents(3);
      expect(events).toHaveLength(3);
      // Returns last 3 events
      expect(events[0].event).toBe('event7');
      expect(events[1].event).toBe('event8');
      expect(events[2].event).toBe('event9');
    });

    it('returns empty array when no events', async () => {
      const events = await adapter.getEvents();
      expect(events).toEqual([]);
    });

    it('handles malformed JSONL lines gracefully', async () => {
      // Write some valid and invalid lines directly
      const eventsFile = path.join(testDir, 'events.jsonl');
      fs.writeFileSync(
        eventsFile,
        `{"event":"valid","id":"1","actor":"h","ts":""}\n` +
          `not json\n` +
          `{"event":"also_valid","id":"2","actor":"c","ts":""}\n`
      );

      const events = await adapter.getEvents();
      expect(events).toHaveLength(2);
    });
  });

  describe('createFSAdapter factory', () => {
    it('creates FSAdapter instance', () => {
      const adapter = createFSAdapter('/tmp/test');
      expect(adapter).toBeInstanceOf(FSAdapter);
    });
  });
});
