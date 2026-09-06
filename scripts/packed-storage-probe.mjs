#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runPackedCommand } from './packed-command.mjs';

const IDENTITY_NAME = 'PackedProbe';
const IDENTITY_CANONICAL_NAME = 'packedprobe';
const ROLE_CONTENT = 'Packed role profile: π\nSecond line: 🚀';
const FUTURE_MIGRATION_NAME = 'future packed probe migration';

const REQUIRED_TABLES = Object.freeze([
  '_migrations',
  'identities',
  'bindings',
  'role_profiles',
  'identity_preambles',
  'preamble_counters',
  'request_attempts',
  'request_responses',
  'request_attention_identities',
]);

function packageModule(packageRoot, relativePath) {
  return import(pathToFileURL(path.join(packageRoot, relativePath)).href);
}

async function runJson(executable, args, env, expectedStatus = 0) {
  const stdout = await runPackedCommand(executable, args, {
    cwd: process.cwd(),
    env,
    expectedStatus,
    timeoutMs: 10_000,
    // The outer verifier owns this probe's group, including nested CLI children.
    isolateProcessGroup: false,
  });
  return JSON.parse(stdout);
}

function withDatabase(Database, databaseFile, options, operation) {
  const database = new Database(databaseFile, options);
  try {
    return operation(database);
  } finally {
    database.close();
  }
}

function migrationHistory(database) {
  return database.prepare('SELECT version, name FROM _migrations ORDER BY version').all();
}

function nativeSnapshot(Database, databaseFile) {
  return withDatabase(Database, databaseFile, { readonly: true }, (database) => ({
    history: migrationHistory(database),
    identities: database
      .prepare(
        'SELECT id, name, canonical_name, created_at, updated_at FROM identities ORDER BY canonical_name'
      )
      .all(),
    roles: database
      .prepare('SELECT identity_id, content, updated_at FROM role_profiles ORDER BY identity_id')
      .all(),
  }));
}

function assertSchema(Database, databaseFile, currentMigrations) {
  withDatabase(Database, databaseFile, { readonly: true }, (database) => {
    const tableNames = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all()
      .map(({ name }) => name);
    for (const table of REQUIRED_TABLES)
      assert.ok(tableNames.includes(table), `Missing table ${table}`);

    const history = migrationHistory(database);
    assert.deepEqual(
      history,
      currentMigrations.map(({ version, name }) => ({ version, name }))
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM identities').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM role_profiles').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM bindings').get().count, 0);
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM identity_preambles').get().count,
      0
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM request_attempts').get().count, 0);
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM request_responses').get().count,
      0
    );
  });
}

function assertRoleResult(value, identity, content) {
  assert.deepEqual(value.identity, {
    id: identity.id,
    name: identity.name,
    canonicalName: identity.canonicalName,
  });
  if (content === null) {
    assert.equal(value.role, null);
    return;
  }
  assert.equal(value.role.content, content);
  assert.equal(typeof value.role.updatedAt, 'string');
  assert.ok(value.role.updatedAt.length > 0);
}

async function main() {
  const packageRoot = process.argv[2];
  if (!packageRoot || process.argv.length !== 3) {
    throw new Error('Usage: node scripts/packed-storage-probe.mjs <installed-package-root>');
  }
  const resolvedPackageRoot = path.resolve(packageRoot);
  const executable = path.join(resolvedPackageRoot, 'bin', 'tmux-team');
  if (!fs.existsSync(executable)) throw new Error(`Packed executable is missing: ${executable}`);

  // This must remain the first storage operation. It proves the public packed
  // CLI creates no identity as a side effect of an explicit missing lookup.
  const environment = { ...process.env };
  const missingOutput = await runPackedCommand(
    executable,
    ['role', 'show', '--identity', 'missing', '--json'],
    {
      cwd: process.cwd(),
      env: environment,
      expectedStatus: 3,
      timeoutMs: 10_000,
      isolateProcessGroup: false,
    }
  );
  assert.deepEqual(JSON.parse(missingOutput), {
    error: { code: 'NAME_NOT_FOUND', message: "Identity 'missing' was not found." },
  });

  const { resolvePaths } = await packageModule(resolvedPackageRoot, 'src/config.ts');
  const { CURRENT_MIGRATIONS } = await packageModule(
    resolvedPackageRoot,
    'src/storage/migrations.ts'
  );
  const { openIdentityRepository } = await packageModule(
    resolvedPackageRoot,
    'src/storage/identity-repository.ts'
  );
  const requireFromPackage = createRequire(path.join(resolvedPackageRoot, 'package.json'));
  const Database = requireFromPackage('better-sqlite3');
  const paths = resolvePaths(process.cwd());

  assertSchema(Database, paths.databaseFile, CURRENT_MIGRATIONS);

  const created = await runJson(
    executable,
    ['identity', 'create', IDENTITY_NAME, '--json'],
    environment
  );
  assert.equal(created.created, true);
  assert.equal(typeof created.identity.id, 'string');
  assert.ok(created.identity.id.length > 0);
  const identity = {
    id: created.identity.id,
    name: IDENTITY_NAME,
    canonicalName: IDENTITY_CANONICAL_NAME,
  };
  assert.deepEqual(created, { identity, created: true });
  assert.deepEqual(
    await runJson(
      executable,
      ['identity', 'create', IDENTITY_CANONICAL_NAME, '--json'],
      environment
    ),
    { identity, created: false }
  );
  assert.deepEqual(
    await runJson(executable, ['identity', 'show', IDENTITY_CANONICAL_NAME, '--json'], environment),
    { identity }
  );
  assert.deepEqual(await runJson(executable, ['identity', 'list', '--json'], environment), {
    identities: [identity],
  });

  const seededSnapshot = nativeSnapshot(Database, paths.databaseFile);
  assert.equal(seededSnapshot.identities.length, 1);
  assert.equal(seededSnapshot.identities[0].id, identity.id);
  assert.deepEqual(seededSnapshot.roles, []);
  assert.deepEqual(
    seededSnapshot.history,
    CURRENT_MIGRATIONS.map(({ version, name }) => ({ version, name }))
  );

  const repositoryProbe = openIdentityRepository(paths.databaseFile);
  try {
    assert.deepEqual(repositoryProbe.findBindings(), []);
    assert.deepEqual(repositoryProbe.listPreambles(), []);
    assert.deepEqual(repositoryProbe.listAttempts(), []);
    assert.equal(repositoryProbe.getPreambleCount(identity.id), 0);
    assert.equal(repositoryProbe.findResponse('missing-response'), undefined);
  } finally {
    repositoryProbe.close();
  }

  // Seed through the installed service, then exercise only public packed CLI
  // attention/reply operations. No live pane or test-only module is required.
  const { createRequestService } = await packageModule(
    resolvedPackageRoot,
    'src/request-service.ts'
  );
  const { encodeReplyReceipt } = await packageModule(resolvedPackageRoot, 'src/reply-receipt.ts');
  const attentionRepository = openIdentityRepository(paths.databaseFile);
  const requestId = 'packed-attention-request';
  const endpoint = {
    serverId: 'packed',
    socketPath: '/packed-probe.sock',
    serverPid: 1,
    serverStartTime: 'packed-start',
    paneId: '%1',
    panePid: 2,
  };
  let attempt;
  try {
    const requests = createRequestService({ repository: attentionRepository });
    attempt = requests.prepare({
      requestId,
      message: 'Packed original π',
      endpoint,
      wait: false,
      expiresAtMs: Date.now() + 60_000,
      originator: { kind: 'explicit', identityId: identity.id },
    });
    requests.beginSend(attempt.attemptId);
  } finally {
    attentionRepository.close();
  }
  const attentionArgs = ['--identity', IDENTITY_NAME, '--json'];
  assert.deepEqual(await runJson(executable, ['x', 'ackall', ...attentionArgs], environment), {
    identity,
    acknowledgedThrough: 1,
  });
  assert.deepEqual(await runJson(executable, ['x', ...attentionArgs], environment), {
    identity,
    items: [],
    nextAfter: null,
  });
  const receipt = encodeReplyReceipt({
    version: 1,
    requestId,
    attemptId: attempt.attemptId,
    endpoint,
  });
  const body = 'Packed final π\nComplete result';
  await runJson(
    executable,
    ['reply', requestId, '--receipt', receipt, '--message', body, '--json'],
    environment
  );
  const reopened = await runJson(executable, ['x', ...attentionArgs], environment);
  assert.equal(reopened.items.length, 1);
  assert.equal(reopened.items[0].requestId, requestId);
  assert.equal(reopened.items[0].revision, 2);
  assert.equal(reopened.items[0].acknowledged, false);
  assert.equal(reopened.items[0].settled, false);
  assert.equal(Object.hasOwn(reopened.items[0], 'attemptId'), false);
  assert.equal(Object.hasOwn(reopened.items[0].final, 'response'), false);
  const shown = await runJson(executable, ['x', 'show', requestId, ...attentionArgs], environment);
  assert.equal(shown.exchange.prompt.message, 'Packed original π');
  assert.equal(shown.exchange.final.response, body);
  const stale = await runJson(
    executable,
    ['x', 'ack', requestId, '--revision', '1', ...attentionArgs],
    environment,
    5
  );
  assert.equal(stale.error.code, 'X_REVISION_CONFLICT');
  assert.deepEqual(
    await runJson(
      executable,
      ['x', 'ack', requestId, '--revision', '2', ...attentionArgs],
      environment
    ),
    { identity, requestId, revision: 2, acknowledged: true, changed: true }
  );
  const settled = await runJson(
    executable,
    ['x', 'show', requestId, ...attentionArgs],
    environment
  );
  assert.equal(settled.exchange.settled, true);

  const roleSet = await runJson(
    executable,
    ['role', 'set', ROLE_CONTENT, '--identity', IDENTITY_NAME, '--json'],
    environment
  );
  assertRoleResult(roleSet, identity, ROLE_CONTENT);
  assert.deepEqual(nativeSnapshot(Database, paths.databaseFile).history, seededSnapshot.history);

  const roleShow = await runJson(
    executable,
    ['role', 'show', '--identity', IDENTITY_NAME, '--json'],
    environment
  );
  assertRoleResult(roleShow, identity, ROLE_CONTENT);
  assert.deepEqual(roleShow, roleSet);

  const roleClear = await runJson(
    executable,
    ['role', 'clear', '--identity', IDENTITY_NAME, '--json'],
    environment
  );
  assertRoleResult(roleClear, identity, null);

  const roleAfterClear = await runJson(
    executable,
    ['role', 'show', '--identity', IDENTITY_NAME, '--json'],
    environment
  );
  assertRoleResult(roleAfterClear, identity, null);
  const reopenedRepository = openIdentityRepository(paths.databaseFile);
  try {
    const storedIdentities = reopenedRepository.listIdentities();
    assert.equal(storedIdentities.length, 1);
    assert.deepEqual(storedIdentities[0], {
      ...identity,
      createdAt: seededSnapshot.identities[0].created_at,
      updatedAt: seededSnapshot.identities[0].updated_at,
    });
    assert.equal(reopenedRepository.findRole(identity.id), undefined);
  } finally {
    reopenedRepository.close();
  }

  const roleRestore = await runJson(
    executable,
    ['role', 'set', ROLE_CONTENT, '--identity', IDENTITY_NAME, '--json'],
    environment
  );
  assertRoleResult(roleRestore, identity, ROLE_CONTENT);
  const beforeFutureFailure = nativeSnapshot(Database, paths.databaseFile);
  assert.equal(beforeFutureFailure.roles.length, 1);
  assert.equal(beforeFutureFailure.roles[0].content, ROLE_CONTENT);

  const futureVersion = CURRENT_MIGRATIONS.at(-1).version + 1;
  withDatabase(Database, paths.databaseFile, {}, (database) => {
    database
      .prepare('INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)')
      .run(futureVersion, FUTURE_MIGRATION_NAME, new Date().toISOString());
  });
  const futureSnapshot = nativeSnapshot(Database, paths.databaseFile);
  assert.deepEqual(futureSnapshot.history, [
    ...beforeFutureFailure.history,
    { version: futureVersion, name: FUTURE_MIGRATION_NAME },
  ]);

  const incompatible = await runJson(
    executable,
    ['role', 'show', '--identity', IDENTITY_NAME, '--json'],
    environment,
    1
  );
  assert.deepEqual(Object.keys(incompatible), ['error']);
  assert.equal(incompatible.error.code, 'ROLE_ERROR');
  assert.match(incompatible.error.message, /migration|schema|unsupported/i);

  const afterFutureFailure = nativeSnapshot(Database, paths.databaseFile);
  assert.deepEqual(afterFutureFailure.history, futureSnapshot.history);
  assert.deepEqual(afterFutureFailure.roles, beforeFutureFailure.roles);
  assert.deepEqual(afterFutureFailure.identities, beforeFutureFailure.identities);
  assert.deepEqual(afterFutureFailure.history.at(-1), {
    version: futureVersion,
    name: FUTURE_MIGRATION_NAME,
  });

  console.log('Packed storage verified.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
