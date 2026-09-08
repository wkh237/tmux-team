#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { selectNativeArtifact, withNativeArtifact } from './native-artifact-policy.mjs';
import { assertNativeTarget, verifyNativeRuntime } from './native-runtime-proof.mjs';

const { values } = parseArgs({
  options: {
    manifest: { type: 'string' },
    archive: { type: 'string' },
    target: { type: 'string' },
    skill: { type: 'string' },
    notices: { type: 'string' },
    license: { type: 'string' },
  },
});
for (const name of ['manifest', 'archive', 'target', 'skill', 'notices', 'license']) {
  assert(values[name], `--${name} is required`);
}
const metadata = selectNativeArtifact(values.manifest, values.archive, values.target);
assertNativeTarget(values.target, 'Artifact requires a matching native host');
const skill = fs.readFileSync(values.skill, 'utf8');
const notices = fs.readFileSync(values.notices, 'utf8');
assert(
  !/<year>|<copyright holders>/.test(notices),
  'Dependency notices contain placeholder attribution'
);

await withNativeArtifact(values.archive, metadata, async (artifactRoot) => {
  assert.equal(
    fs.readFileSync(path.join(artifactRoot, 'THIRD-PARTY-NOTICES.txt'), 'utf8'),
    notices,
    'Native archive notices differ from the generated inventory'
  );
  assert.deepEqual(
    fs.readFileSync(path.join(artifactRoot, 'LICENSE')),
    fs.readFileSync(values.license),
    'Native archive license differs from the selected source'
  );
  verifyNativeRuntime({
    executable: path.join(artifactRoot, 'tmt'),
    target: metadata.target,
    version: metadata.version,
    skill,
    profileContent: 'Persisted by native archive',
    subject: 'Native archive',
    matchingHostMessage: 'Artifact requires a matching native host',
  });
  console.log(
    `Verified native archive ${metadata.name}: linkage, version, skill, managed install, SQLite persistence`
  );
});
