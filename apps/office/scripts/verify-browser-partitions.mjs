import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const playwright = fileURLToPath(new URL('../node_modules/.bin/playwright', import.meta.url));

function listedTests(args) {
  const result = spawnSync(playwright, ['test', '--list', '--reporter=json', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.errors, []);
  const identities = [];
  function visit(suites) {
    for (const suite of suites ?? []) {
      for (const spec of suite.specs ?? []) {
        identities.push(`${spec.file}:${spec.line}:${spec.column}:${spec.title}:${spec.id}`);
      }
      visit(suite.suites);
    }
  }
  visit(report.suites);
  return identities.sort();
}

const complete = listedTests([]);
const partitions = new Map([
  ['emulator', listedTests(['--config', 'playwright.emulator.config.ts'])],
  ['local', listedTests(['--config', 'playwright.local.config.ts'])],
  ['native 1/2', listedTests(['--config', 'playwright.native.config.ts', '--shard', '1/2'])],
  ['native 2/2', listedTests(['--config', 'playwright.native.config.ts', '--shard', '2/2'])],
]);

assert.equal(complete.length, 125, 'Update the reviewed browser partition inventory.');
const partitioned = [...partitions.values()].flat();
assert.equal(new Set(partitioned).size, partitioned.length, 'Browser partitions overlap.');
assert.deepEqual(partitioned.sort(), complete, 'Browser partitions omit or add listed tests.');

const decoration = [...partitions.entries()]
  .filter(([, tests]) =>
    tests.some((identity) => identity.startsWith('native-decoration.spec.ts:'))
  )
  .map(([name]) => name);
assert.deepEqual(decoration, ['emulator'], 'Native decoration must stay emulator-backed.');

for (const [name, tests] of partitions) process.stdout.write(`${name}: ${tests.length}\n`);
process.stdout.write(`complete: ${complete.length}\n`);
