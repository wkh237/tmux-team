import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  expectError,
  expectJsonSuccess,
  parseWholeStdout,
  runCli,
  withSandbox,
} from '../test/support/cli-process.js';
import type { PublicIdentity } from './domain/identity.js';

function forbidTmux(sandbox: Parameters<typeof runCli>[0]): string {
  const wrapperDirectory = path.join(sandbox.root, 'forbidden-bin');
  const logPath = path.join(sandbox.root, 'tmux-invocations.log');
  mkdirSync(wrapperDirectory);
  const wrapperPath = path.join(wrapperDirectory, 'tmux');
  writeFileSync(
    wrapperPath,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TMT_IDENTITY_TMUX_LOG"\nexit 97\n'
  );
  chmodSync(wrapperPath, 0o755);
  sandbox.env.PATH = `${wrapperDirectory}${path.delimiter}${process.env.PATH ?? ''}`;
  sandbox.env.TMT_IDENTITY_TMUX_LOG = logPath;
  return logPath;
}

function assertPublicIdentity(value: unknown): asserts value is PublicIdentity {
  expect(value).toEqual({
    id: expect.any(String),
    name: expect.any(String),
    canonicalName: expect.any(String),
  });
  expect(Object.keys(value as object).sort()).toEqual(['canonicalName', 'id', 'name']);
  expect((value as PublicIdentity).id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );
}

describe('real CLI durable identity contract', () => {
  it(
    'creates, shows, and lists storage-only identities with stable canonical rows',
    { timeout: 10_000 },
    async () =>
      withSandbox(async (sandbox) => {
        const globalConfig = '{ malformed global config';
        const localConfig = '{ malformed local config';
        mkdirSync(sandbox.globalDir, { recursive: true });
        writeFileSync(sandbox.globalConfig, globalConfig);
        writeFileSync(sandbox.localConfig, localConfig);
        const tmuxLog = forbidTmux(sandbox);

        const first = await runCli(sandbox, ['identity', 'create', '  Alice  ', '--json']);
        expect(first.status).toBe(0);
        expect(first.stderr).toBe('');
        const firstDocument = parseWholeStdout(first) as {
          identity: PublicIdentity;
          created: boolean;
        };
        expect(firstDocument.created).toBe(true);
        assertPublicIdentity(firstDocument.identity);
        expect(firstDocument.identity).toEqual({
          id: firstDocument.identity.id,
          name: 'Alice',
          canonicalName: 'alice',
        });
        const identityId = firstDocument.identity.id;

        const repeated = await runCli(sandbox, ['identity', 'create', 'ALICE', '--json']);
        expectJsonSuccess(repeated, {
          identity: { id: identityId, name: 'Alice', canonicalName: 'alice' },
          created: false,
        });

        const shown = await runCli(sandbox, ['identity', 'show', 'alice', '--json']);
        expectJsonSuccess(shown, {
          identity: { id: identityId, name: 'Alice', canonicalName: 'alice' },
        });

        const listed = await runCli(sandbox, ['identity', 'list', '--json']);
        expectJsonSuccess(listed, {
          identities: [{ id: identityId, name: 'Alice', canonicalName: 'alice' }],
        });

        expect(readFileSync(sandbox.globalConfig, 'utf8')).toBe(globalConfig);
        expect(readFileSync(sandbox.localConfig, 'utf8')).toBe(localConfig);
        expect(existsSync(tmuxLog)).toBe(false);
      })
  );

  it(
    'calibrates the tmux invocation guard with a command that needs tmux',
    { timeout: 10_000 },
    async () =>
      withSandbox(async (sandbox) => {
        const tmuxLog = forbidTmux(sandbox);
        const activeList = await runCli(sandbox, ['list', '--json']);
        expect(activeList.status).toBe(1);
        expect(existsSync(tmuxLog)).toBe(true);
      })
  );

  it(
    'maps invalid names to INVALID_NAME with exit status 1 and no created row',
    { timeout: 10_000 },
    async () =>
      withSandbox(async (sandbox) => {
        for (const name of ['%12', '10.3']) {
          const result = await runCli(sandbox, ['identity', 'create', name, '--json']);
          expect(result.status, name).toBe(1);
          expect(result.stderr, name).toBe('');
          expectError(result, 'INVALID_NAME');
        }

        const listed = await runCli(sandbox, ['identity', 'list', '--json']);
        expectJsonSuccess(listed, { identities: [] });
      })
  );

  it(
    'maps a valid but missing show name to NAME_NOT_FOUND with exit status 3',
    { timeout: 10_000 },
    async () =>
      withSandbox(async (sandbox) => {
        const result = await runCli(sandbox, ['identity', 'show', 'Missing', '--json']);
        expect(result.status).toBe(3);
        expect(result.stderr).toBe('');
        expect(parseWholeStdout(result)).toEqual({
          error: { code: 'NAME_NOT_FOUND', message: "Identity 'Missing' was not found." },
        });
      })
  );

  it(
    'keeps explicit role access storage-only for a durable identity',
    { timeout: 10_000 },
    async () =>
      withSandbox(async (sandbox) => {
        mkdirSync(sandbox.globalDir, { recursive: true });
        writeFileSync(sandbox.globalConfig, '{ malformed');
        writeFileSync(sandbox.localConfig, '{ malformed');
        const tmuxLog = forbidTmux(sandbox);

        const created = await runCli(sandbox, ['identity', 'create', 'RoleUser', '--json']);
        expect(created.status).toBe(0);
        expect(created.stderr).toBe('');
        const createdDocument = parseWholeStdout(created) as {
          identity: PublicIdentity;
        };
        assertPublicIdentity(createdDocument.identity);

        const set = await runCli(sandbox, [
          'role',
          'set',
          'durable role content',
          '--identity',
          'roleuser',
          '--json',
        ]);
        expect(set.status).toBe(0);
        expect(set.stderr).toBe('');
        const setDocument = parseWholeStdout(set) as {
          identity: PublicIdentity;
          role: { content: string; updatedAt: string };
        };
        expect(setDocument.identity).toEqual(createdDocument.identity);
        expect(setDocument.role.content).toBe('durable role content');
        expect(setDocument.role.updatedAt).toEqual(expect.any(String));

        const shown = await runCli(sandbox, ['role', 'show', '--identity', 'ROLEUSER', '--json']);
        expect(shown.status).toBe(0);
        expect(shown.stderr).toBe('');
        expect(parseWholeStdout(shown)).toEqual(setDocument);
        expect(readFileSync(sandbox.globalConfig, 'utf8')).toBe('{ malformed');
        expect(readFileSync(sandbox.localConfig, 'utf8')).toBe('{ malformed');
        expect(existsSync(tmuxLog)).toBe(false);
      })
  );

  it(
    'rejects identity grammar failures before creating storage rows',
    { timeout: 10_000 },
    async () =>
      withSandbox(async (sandbox) => {
        for (const args of [
          ['identity', '--json'],
          ['identity', 'create', '--json'],
          ['identity', 'show', '--json'],
          ['identity', 'create', 'Alice', 'extra', '--json'],
          ['identity', 'list', 'extra', '--json'],
        ]) {
          const result = await runCli(sandbox, args);
          expect(result.status, args.join(' ')).toBe(1);
          expect(result.stderr, args.join(' ')).toBe('');
          expectError(result, 'USAGE_ERROR');
          expect(existsSync(sandbox.database), args.join(' ')).toBe(false);
        }

        const created = await runCli(sandbox, ['identity', 'create', 'Alice', '--json']);
        expectJsonSuccess(created, {
          identity: expect.objectContaining({ name: 'Alice', canonicalName: 'alice' }),
          created: true,
        });
        const beforeInvalidGrammar = parseWholeStdout(created) as { identity: PublicIdentity };
        const invalidGrammar = await runCli(sandbox, [
          'identity',
          'create',
          'Alice',
          'extra',
          '--json',
        ]);
        expect(invalidGrammar.status).toBe(1);
        expectError(invalidGrammar, 'USAGE_ERROR');
        const listed = await runCli(sandbox, ['identity', 'list', '--json']);
        expectJsonSuccess(listed, {
          identities: [beforeInvalidGrammar.identity],
        });
      })
  );
});
