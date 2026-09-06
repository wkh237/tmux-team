import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openIdentityRepository } from './storage/identity-repository.js';
import {
  collectResults,
  runWorker as spawnWorker,
  stopWorkers,
  waitForFiles,
  workerMessage,
} from './test-support/request-workers.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('identity repository multi-process races', () => {
  it('creates one durable identity for equivalent names without creating a binding', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tmt-concurrency-'));
    directories.push(directory);
    const barrier = path.join(directory, 'barrier');
    fs.mkdirSync(barrier);
    const databaseFile = path.join(directory, 'tmux-team.db');
    const worker = new URL(
      './test-support/workers/identity-concurrency-worker.ts',
      import.meta.url
    );
    const handles = ['a', 'b'].map((variant) =>
      spawnWorker(worker, [databaseFile, barrier, variant, 'create'], variant, directory)
    );
    try {
      await waitForFiles(
        ['a', 'b'].map((variant) => path.join(barrier, `ready-${variant}`)),
        handles
      );
      fs.writeFileSync(path.join(barrier, 'go'), 'go');
      const results = await collectResults(handles);
      const messages = results.map((result) =>
        workerMessage<{ id: string; created: boolean }>(result)
      );
      expect(messages.map((message) => message.id)).toEqual([messages[0]?.id, messages[0]?.id]);
      expect(messages.map((message) => message.created).sort()).toEqual([false, true]);

      const repository = openIdentityRepository(databaseFile);
      try {
        const identities = repository.listIdentities();
        expect(identities).toHaveLength(1);
        expect(identities[0]).toMatchObject({
          id: messages[0]?.id,
          canonicalName: 'alice',
        });
        expect(['Ａｌｉｃｅ', 'alice']).toContain(identities[0]?.name);
        expect(repository.findBindings()).toHaveLength(0);
      } finally {
        repository.close();
      }
    } finally {
      await stopWorkers(handles);
    }
  }, 30_000);

  it('converges equivalent names to one identity and one binding', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tmt-concurrency-'));
    directories.push(directory);
    const barrier = path.join(directory, 'barrier');
    fs.mkdirSync(barrier);
    const databaseFile = path.join(directory, 'tmux-team.db');
    const worker = new URL(
      './test-support/workers/identity-concurrency-worker.ts',
      import.meta.url
    );
    const handles = ['a', 'b'].map((variant) =>
      spawnWorker(worker, [databaseFile, barrier, variant], variant, directory)
    );
    try {
      await waitForFiles(
        ['a', 'b'].map((variant) => path.join(barrier, `ready-${variant}`)),
        handles
      );
      fs.writeFileSync(path.join(barrier, 'go'), 'go');
      const results = await collectResults(handles);
      const messages = results.map((result) => workerMessage<{ id: string }>(result));
      const ids = messages.map((message) => message.id);
      expect(ids[0]).toBe(ids[1]);
      const repository = openIdentityRepository(databaseFile);
      try {
        expect(repository.listIdentities()).toHaveLength(1);
        expect(repository.findBindings()).toHaveLength(1);
        expect(repository.findBindings()[0]?.identityId).toBe(ids[0]);
      } finally {
        repository.close();
      }
    } finally {
      await stopWorkers(handles);
    }
  }, 30_000);
});
