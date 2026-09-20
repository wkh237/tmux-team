// Bootstrap transport proof, not Office authorization or browser E2E coverage.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

assert.equal(process.env.GCLOUD_PROJECT, 'demo-tmt-office');
const endpoint = (name) => {
  const host = process.env[name];
  assert.match(host ?? '', /^(127\.0\.0\.1|localhost):[0-9]+$/, `${name} must be loopback`);
  return `http://${host}`;
};
const auth = endpoint('FIREBASE_AUTH_EMULATOR_HOST');
const firestore = endpoint('FIRESTORE_EMULATOR_HOST');
const request = async (url, method, body, token) => {
  const response = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: await response.json() };
};
const account = (operation) =>
  `${auth}/identitytoolkit.googleapis.com/v1/accounts:${operation}?key=demo-key`;
const probe = `${firestore}/v1/projects/demo-tmt-office/databases/(default)/documents/bootstrap/${randomUUID()}`;
let idToken;
try {
  const email = `fixture-${randomUUID()}@example.invalid`;
  const created = await request(account('signUp'), 'POST', {
    email,
    password: randomUUID(),
    returnSecureToken: true,
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.email, email);
  assert.equal(typeof created.body.idToken, 'string');
  idToken = created.body.idToken;
  const found = await request(account('lookup'), 'POST', { idToken });
  assert.equal(found.status, 200);
  assert.equal(found.body.users[0].localId, created.body.localId);

  // Emulator-only owner bypass is an independent positive control. It must
  // never be used with a cloud URL or treated as a product authorization grant.
  const fields = { value: { stringValue: randomUUID() } };
  const written = await request(probe, 'PATCH', { fields }, 'owner');
  assert.equal(written.status, 200);
  const stored = await request(probe, 'GET', undefined, 'owner');
  assert.equal(stored.status, 200);
  assert.deepEqual(stored.body.fields, fields);
  for (const token of [undefined, idToken]) {
    const denied = await request(probe, 'GET', undefined, token);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.status, 'PERMISSION_DENIED');
    assert.equal((await request(probe, 'PATCH', { fields }, token)).status, 403);
  }
} finally {
  const removed = await request(probe, 'DELETE', undefined, 'owner');
  assert.equal(removed.status, 200);
  assert.equal((await request(probe, 'GET', undefined, 'owner')).status, 404);
  if (idToken) {
    assert.equal((await request(account('delete'), 'POST', { idToken })).status, 200);
    assert.equal((await request(account('lookup'), 'POST', { idToken })).status, 400);
  }
}
console.log(
  'Office emulator bootstrap verified: Auth, denied client access, stored fixture and cleanup.'
);
