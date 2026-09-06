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
