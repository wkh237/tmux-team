#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const cli = process.env.TMT_TEST_CLI;
const office = process.env.TMT_TEST_OFFICE;
assert(cli && office, 'TMT_TEST_CLI and TMT_TEST_OFFICE are required');
for (const executable of [cli, office]) fs.accessSync(executable, fs.constants.X_OK);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tmt-local-office-e2e-'));
const home = path.join(root, 'home');
const state = path.join(root, 'state');
const prefix = path.join(root, 'prefix');
const bin = path.join(prefix, 'bin');
const cwd = path.join(root, 'work');
for (const directory of [home, bin, cwd]) fs.mkdirSync(directory, { recursive: true });
const env = { ...process.env, HOME: home, TMUX_TEAM_HOME: state };
let browser;

function fixtureCommand(program, args) {
  const result = spawnSync(program, args, { cwd, env, encoding: 'utf8' });
  assert.equal(
    result.status,
    0,
    `fixture command failed: ${program} ${args.join(' ')}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
}

fixtureCommand('git', ['init', '--quiet']);
fixtureCommand('git', [
  'remote',
  'add',
  'origin',
  'https://Example.COM/Organization/Office-Discussion-Board-With-A-Long-Category.git',
]);

async function launchBrowser() {
  const entry = require.resolve('@playwright/test', {
    paths: [process.env.TMT_TEST_PLAYWRIGHT_ROOT ?? path.join(process.cwd(), 'apps/office')],
  });
  const loaded = await import(pathToFileURL(entry).href);
  const chromium = loaded.chromium ?? loaded.default?.chromium;
  assert(chromium, 'Playwright Chromium is unavailable');
  return chromium.launch({ channel: process.env.TMT_TEST_BROWSER_CHANNEL ?? 'chrome' });
}

async function assertNoHorizontalOverflow(page) {
  const widths = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  assert(
    widths.document <= widths.viewport,
    `horizontal overflow: document ${widths.document}px exceeds viewport ${widths.viewport}px`
  );
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function installOfficeFixture(installPrefix, source, version) {
  const releaseId = randomUUID();
  const release = path.join(installPrefix, 'lib', 'tmt-office', 'releases', releaseId);
  fs.mkdirSync(path.join(installPrefix, 'bin'), { recursive: true });
  fs.mkdirSync(release, { recursive: true });
  fs.copyFileSync(source, path.join(release, 'tmt-office'));
  fs.chmodSync(path.join(release, 'tmt-office'), 0o755);
  for (const name of ['LICENSE', 'NATIVE-INSTALL.md', 'THIRD-PARTY-NOTICES.txt']) {
    const sourceFile =
      name === 'THIRD-PARTY-NOTICES.txt' ? path.join(root, name) : path.join(process.cwd(), name);
    if (name === 'THIRD-PARTY-NOTICES.txt')
      fs.writeFileSync(sourceFile, 'Local Office test fixture\n');
    fs.copyFileSync(sourceFile, path.join(release, name));
  }
  const files = Object.fromEntries(
    ['tmt-office', 'LICENSE', 'NATIVE-INSTALL.md', 'THIRD-PARTY-NOTICES.txt'].map((name) => [
      name,
      sha256(path.join(release, name)),
    ])
  );
  fs.writeFileSync(
    path.join(release, 'receipt.json'),
    JSON.stringify({
      schema_version: 1,
      release_id: releaseId,
      prefix: fs.realpathSync(installPrefix),
      version,
      channel: 'alpha',
      pinned_version: null,
      archive: `tmt-office-${version}.tar.gz`,
      archive_sha256: '0'.repeat(64),
      target: `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl'}`,
      file_sha256: files,
      source: 'local-archive',
    })
  );
  fs.symlinkSync(`releases/${releaseId}`, path.join(installPrefix, 'lib', 'tmt-office', 'current'));
  fs.symlinkSync(
    '../lib/tmt-office/current/tmt-office',
    path.join(installPrefix, 'bin', 'tmt-office')
  );
}

const officeVersion = spawnSync(office, ['__tmt-office', '1', 'probe'], {
  cwd,
  env,
  encoding: 'utf8',
}).stdout.split('\n')[1];
assert(officeVersion, 'Office probe did not return a version');
installOfficeFixture(prefix, office, officeVersion);

function command(args, expected = 0) {
  const result = spawnSync(cli, [...args, '--json'], { cwd, env, encoding: 'utf8' });
  assert.equal(
    result.status,
    expected,
    `command failed: ${args.join(' ')}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
  return JSON.parse(result.stdout);
}
function officeCommand(args, expected = 0) {
  return command(['office', ...args, '--prefix', prefix], expected);
}
const builtinBytes = fs.readFileSync(
  path.join(process.cwd(), 'contracts/office/builtin-props-v1.tmtprop.json')
);
const builtinLength = Buffer.alloc(8);
builtinLength.writeBigUInt64BE(BigInt(builtinBytes.length));
const builtinDigest = `sha256:${createHash('sha256')
  .update(Buffer.from('TMT-OFFICE-PROP-PACK-V1\0'))
  .update(builtinLength)
  .update(builtinBytes)
  .digest('hex')}`;
const builtinFootprints = Object.fromEntries(
  JSON.parse(builtinBytes).props.map(({ key, footprint }) => [key, footprint])
);
const avatarSample = path.join(
  process.cwd(),
  'contracts/office/avatar-pack-v1-sample.tmtavatar.json'
);
const avatarBytes = fs.readFileSync(avatarSample);
const avatarLength = Buffer.alloc(8);
avatarLength.writeBigUInt64BE(BigInt(avatarBytes.length));
const avatarDigest = `sha256:${createHash('sha256')
  .update(Buffer.from('TMT-OFFICE-AVATAR-PACK-V1\0'))
  .update(avatarLength)
  .update(avatarBytes)
  .digest('hex')}`;
const avatarDocument = JSON.parse(avatarBytes.toString('utf8'));
function assertAvatarProjection(actual) {
  assert.equal(actual.digest, avatarDigest);
  assert.equal(actual.formatVersion, avatarDocument.formatVersion);
  assert.equal(actual.label, avatarDocument.label);
  assert.equal(actual.credit, avatarDocument.credit);
  assert.equal(actual.license, avatarDocument.license);
  assert.equal(actual.fileBytes, avatarBytes.length);
  assert.equal(actual.cellCount, avatarDocument.avatars.length * 16 * 24);
  assert.deepEqual(
    actual.avatars,
    avatarDocument.avatars.map(({ key, label }) => ({
      key,
      label,
      raster: { width: 16, height: 24 },
    }))
  );
}
function avatarStorageSnapshot() {
  const database = new Database(path.join(state, 'tmux-team.db'), { readonly: true });
  try {
    return {
      catalog: database.prepare('SELECT * FROM office_avatar_catalog ORDER BY singleton').all(),
      packs: database.prepare('SELECT * FROM office_avatar_packs ORDER BY digest').all(),
      profiles: database.prepare('SELECT * FROM office_local_profiles ORDER BY identity_id').all(),
    };
  } finally {
    database.close();
  }
}
function blockStorageSnapshot() {
  const database = new Database(path.join(state, 'tmux-team.db'), { readonly: true });
  try {
    return database.prepare('SELECT * FROM office_local_blocks ORDER BY block_id').all();
  } finally {
    database.close();
  }
}
function builtinFurniture(asset, x, y, rotation) {
  return {
    prop: `${builtinDigest}/${asset}`,
    footprint: builtinFootprints[asset],
    x,
    y,
    rotation,
  };
}
function layout(objects) {
  const file = path.join(root, `layout-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({ version: 2, objects }));
  return file;
}
function tokenFrom(url) {
  return new URLSearchParams(new URL(url).hash.slice(1)).get('token');
}
function endpoint(url) {
  const value = new URL(url);
  return value.origin;
}
async function rawRequest(url, options = {}) {
  return await new Promise((resolve, reject) => {
    const request = http.request(url, options, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString(),
        })
      );
    });
    request.on('error', (error) =>
      reject(new Error(`raw ${options.method ?? 'GET'} ${url} failed`, { cause: error }))
    );
    if (options.body) request.write(options.body);
    request.end();
  });
}
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

try {
  const missingPrefix = path.join(root, 'missing-prefix');
  assert.equal(
    command(['office', 'start', '--prefix', missingPrefix], 1).error.code,
    'OFFICE_NOT_INSTALLED'
  );
  assert.equal(command(['office', 'stop', '--prefix', missingPrefix]).changed, false);
  assert.equal(fs.existsSync(state), false);
  command(['identity', 'create', 'Alice']);
  const validatedAvatar = officeCommand(['avatar', 'validate', '--file', avatarSample]);
  assert.equal(validatedAvatar.digest, avatarDigest);
  assert.equal(validatedAvatar.avatars[0].key, 'signal-bot');
  assert.equal(officeCommand(['avatar', 'list', '--local']).catalogRevision, 0);
  const installedAvatar = officeCommand([
    'avatar',
    'install',
    '--local',
    '--file',
    avatarSample,
    '--if-revision',
    '0',
  ]);
  assert.equal(installedAvatar.changed, true);
  assert.equal(installedAvatar.catalogRevision, 1);
  assertAvatarProjection(installedAvatar);
  assertAvatarProjection(officeCommand(['avatar', 'show', '--local', avatarDigest]));
  const implicitProfile = officeCommand(['profile', 'show', '--local', '--identity', 'Alice']);
  assert.equal(implicitProfile.exists, false);
  const selectedProfileFile = path.join(root, 'profile-with-custom-avatar.json');
  const selectedProfile = {
    ...implicitProfile.profile,
    displayLabel: 'Signal lead',
    appearance: { ...implicitProfile.profile.appearance, shirtMark: 'AI' },
    avatarRef: `${avatarDigest}/signal-bot`,
  };
  fs.writeFileSync(selectedProfileFile, JSON.stringify(selectedProfile));
  const appliedProfile = officeCommand([
    'profile',
    'apply',
    '--local',
    '--identity',
    'Alice',
    '--file',
    selectedProfileFile,
    '--if-revision',
    '0',
  ]);
  assert.equal(appliedProfile.changed, true);
  assert.equal(appliedProfile.revision, 1);
  assert.equal(appliedProfile.profile.avatarRef, `${avatarDigest}/signal-bot`);
  const selectedProfileRows = avatarStorageSnapshot().profiles;
  assert.equal(selectedProfileRows.length, 1);
  assert.equal(JSON.parse(selectedProfileRows[0].profile).avatarRef, `${avatarDigest}/signal-bot`);
  const missing = officeCommand(['block', 'show', '--local', '--identity', 'Alice']);
  assert.equal(missing.exists, false);
  assert.equal(missing.revision, 0);
  assert.deepEqual(missing.layout, { version: 2, objects: [] });

  assert.deepEqual(blockStorageSnapshot(), []);

  // The board one-shot path must work through the verified companion while the
  // local HTTP service is stopped, then persist independently in shared SQLite.
  assert.equal(officeCommand(['status']).service.running, false);
  const boardCreated = officeCommand([
    'board',
    'post',
    '--general',
    '--identity',
    'Alice',
    '--title',
    'Persistent review',
    '--body',
    'Survives service restart.',
  ]);
  const repositoryTitle =
    'Repository coordination: durable browser review across a deliberately long title';
  const repositoryBody =
    'This long plain-text discussion verifies the rendered Office board against the real local service.\n\nIt keeps line breaks, stays readable at a narrow viewport, and exposes the moderation action without interpreting markup.\n\n<script>window.__tmtBoardScriptRan = true</script>';
  const repositoryCreated = officeCommand([
    'board',
    'post',
    '--repo',
    'origin',
    '--identity',
    'Alice',
    '--title',
    repositoryTitle,
    '--body',
    repositoryBody,
  ]);
  const boardDatabase = new Database(path.join(state, 'tmux-team.db'), { readonly: true });
  try {
    assert.deepEqual(
      boardDatabase
        .prepare(
          'SELECT id, thread_id, revision, title, body, deleted FROM office_board_entries WHERE id = ?'
        )
        .get(boardCreated.entryId),
      {
        id: boardCreated.entryId,
        thread_id: boardCreated.threadId,
        revision: 1,
        title: 'Persistent review',
        body: 'Survives service restart.',
        deleted: 0,
      }
    );
    assert.equal(
      boardDatabase.prepare('SELECT revision FROM office_board_state WHERE singleton = 1').get()
        .revision,
      2
    );
  } finally {
    boardDatabase.close();
  }

  const started = officeCommand(['start']);
  assert.equal(started.running, true);
  assert.equal(started.changed, true);
  assert.equal(started.reused, false);
  const firstToken = tokenFrom(started.url);
  assert.match(firstToken, /^[A-Za-z0-9_-]{43}$/);
  const origin = endpoint(started.url);
  const receiptPath = path.join(state, 'office', 'runtime', 'service-v1.json');
  const firstReceipt = JSON.parse(fs.readFileSync(receiptPath));
  assert.equal(firstReceipt.browserToken, firstToken);
  assert.equal(
    new Set([firstReceipt.browserToken, firstReceipt.controlToken, firstReceipt.nonce]).size,
    3
  );
  const directHealth = await rawRequest(`${origin}/control/v1/health`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${firstReceipt.controlToken}`,
      'X-TMT-Office-Nonce': firstReceipt.nonce,
      'Content-Length': '0',
    },
  });
  assert.equal(directHealth.status, 200);
  const reused = officeCommand(['start']);
  assert.equal(reused.reused, true);
  assert.equal(reused.url, started.url);

  const previewPack = JSON.parse(avatarBytes);
  previewPack.label = 'Signal bots preview only';
  const previewAvatarFile = path.join(root, 'preview-only.tmtavatar.json');
  fs.writeFileSync(previewAvatarFile, JSON.stringify(previewPack));
  const beforePreviewState = avatarStorageSnapshot();
  const avatarPreview = officeCommand(['avatar', 'preview', '--file', previewAvatarFile]);
  assert.match(avatarPreview.previewId, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(new URL(avatarPreview.url).pathname.startsWith('/local/avatars/preview/'), true);
  assert.deepEqual(avatarStorageSnapshot(), beforePreviewState);

  const shell = await fetch(`${origin}/local`);
  assert.equal(shell.status, 200);
  assert.equal(shell.headers.get('cache-control'), 'no-store');
  assert(shell.headers.get('content-security-policy'));
  assert.equal(shell.headers.get('access-control-allow-origin'), null);
  assert((await shell.text()).includes('<div id="root"'));

  const headers = { Authorization: `Bearer ${firstToken}` };
  const listed = await fetch(`${origin}/api/v1/local/blocks`, { headers });
  assert.equal(listed.status, 200);
  const projection = await listed.json();
  assert.deepEqual(projection, []);
  assert.equal(JSON.stringify(projection).includes('notes'), false);

  browser = await launchBrowser();
  const page = await browser.newPage();
  const browserRequests = [];
  page.on('request', (request) => browserRequests.push(request.url()));
  await page.goto(avatarPreview.url);
  await page.getByRole('heading', { name: 'Signal bots preview only' }).waitFor();
  await page.getByRole('img', { name: 'Signal bot' }).waitFor();
  assert.equal(await page.locator('.avatar-name', { hasText: 'signal-bot' }).count(), 1);
  const avatarDesktopScreenshot = process.env.TMT_TEST_AVATAR_DESKTOP_SCREENSHOT;
  const avatarNarrowScreenshot = process.env.TMT_TEST_AVATAR_NARROW_SCREENSHOT;
  if (avatarDesktopScreenshot) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: avatarDesktopScreenshot, fullPage: true });
  }
  if (avatarNarrowScreenshot) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: avatarNarrowScreenshot, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  const avatarCatalogRequestCount = () =>
    browserRequests.filter((url) => new URL(url).pathname === '/api/v1/local/avatar-catalog')
      .length;
  const beforeOpeningRoom = avatarStorageSnapshot();
  await page.goto(started.url);
  await page.getByRole('heading', { name: 'Your office', exact: true }).waitFor();
  await page.getByText('Unfurnished · not saved').waitFor();
  assert.deepEqual(blockStorageSnapshot(), []);
  assert.deepEqual(avatarStorageSnapshot(), beforeOpeningRoom);
  await page.getByRole('link', { name: "Enter Alice's room" }).click();
  await page.getByRole('button', { name: 'Add desk' }).click();
  assert.deepEqual(blockStorageSnapshot(), []);
  assert.deepEqual(avatarStorageSnapshot(), beforeOpeningRoom);
  await page.getByRole('button', { name: 'Save layout' }).click();
  await page.locator('.block-heading').getByText('Saved · revision 1').waitFor();
  const created = officeCommand(['block', 'show', '--local', '--identity', 'Alice']);
  assert.equal(created.exists, true);
  assert.equal(created.revision, 1);
  assert.equal(created.identityId, missing.identityId);
  assert.deepEqual(created.layout.objects, [builtinFurniture('desk', 14, 14, 0)]);
  assert.equal(blockStorageSnapshot().length, 1);
  assert.equal(blockStorageSnapshot()[0].block_id, created.blockId);
  assert.equal(blockStorageSnapshot()[0].revision, 1);
  assert.deepEqual(JSON.parse(blockStorageSnapshot()[0].layout), created.layout);
  const savedProjection = await (await fetch(`${origin}/api/v1/local/blocks`, { headers })).json();
  assert.equal(savedProjection.length, 1);
  assert.deepEqual(
    Object.keys(savedProjection[0]).sort(),
    [
      'blockId',
      'exists',
      'identityId',
      'identityName',
      'layout',
      'resolutions',
      'revision',
      'updatedAtMs',
    ].sort()
  );
  await page.getByRole('link', { name: '← Back to office' }).click();
  await page.getByText('1 piece · saved').waitFor();
  await page.locator('.office-map[data-scene-ready="true"]').waitFor();
  assert.equal(await page.locator('.office-canvas canvas').count(), 1);
  assert.equal(blockStorageSnapshot()[0].revision, 1);
  const officeScreenshot = process.env.TMT_TEST_OFFICE_OVERVIEW_SCREENSHOT;
  if (officeScreenshot) await page.screenshot({ path: officeScreenshot, fullPage: true });
  await page.getByRole('link', { name: "Enter Alice's room" }).click();
  await page.getByText('Appearance', { exact: true }).click();
  await page.getByText('Avatar · Signal bots · Signal bot').waitFor();
  assert.equal(new URL(page.url()).hash, '');
  assert.equal(await page.getByLabel('Avatar art').inputValue(), `${avatarDigest}/signal-bot`);
  assert.equal(await page.getByLabel('Hair style').isDisabled(), true);
  assert.equal(await page.getByLabel('Shirt mark').isEnabled(), true);
  const profilePixels = await page
    .locator('.profile-preview .profile-avatar rect')
    .evaluateAll((nodes) => nodes.map((node) => [...node.attributes].map((item) => item.value)));
  assert(profilePixels.length > 0);
  await page.locator('.office-map[data-scene-ready="true"]').waitFor();
  assert.equal(
    await page
      .getByText('Offline — this identity is not shown as present in the room.')
      .isVisible(),
    true
  );
  assert.equal(avatarCatalogRequestCount(), 4);
  const profileDesktopScreenshot = process.env.TMT_TEST_PROFILE_DESKTOP_SCREENSHOT;
  const profileNarrowScreenshot = process.env.TMT_TEST_PROFILE_NARROW_SCREENSHOT;
  const profileFallbackScreenshot = process.env.TMT_TEST_PROFILE_FALLBACK_SCREENSHOT;
  if (profileDesktopScreenshot) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: profileDesktopScreenshot, fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await assertNoHorizontalOverflow(page);
  if (profileNarrowScreenshot) {
    await page.screenshot({ path: profileNarrowScreenshot, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const removedAvatar = officeCommand([
    'avatar',
    'remove',
    '--local',
    avatarDigest,
    '--if-revision',
    '1',
  ]);
  assert.equal(removedAvatar.changed, true);
  assert.equal(removedAvatar.catalogRevision, 2);
  assert.equal(officeCommand(['avatar', 'list', '--local']).packs.length, 0);
  await page.goto('about:blank');
  await page.goto(started.url);
  await page.getByText('1 piece · saved').waitFor();
  await page.getByRole('link', { name: "Enter Alice's room" }).click();
  await page.getByText('Appearance', { exact: true }).click();
  await page.getByText('Avatar · unavailable, showing saved default appearance').waitFor();
  assert.equal(new URL(page.url()).hash, '');
  assert.equal(await page.getByLabel('Avatar art').inputValue(), `${avatarDigest}/signal-bot`);
  assert.deepEqual(avatarStorageSnapshot().profiles, selectedProfileRows);
  assert.equal(avatarCatalogRequestCount(), 6);
  await page.setViewportSize({ width: 390, height: 844 });
  await assertNoHorizontalOverflow(page);
  if (profileFallbackScreenshot) {
    await page.screenshot({ path: profileFallbackScreenshot, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const reinstalledAvatar = officeCommand([
    'avatar',
    'install',
    '--local',
    '--file',
    avatarSample,
    '--if-revision',
    '2',
  ]);
  assert.equal(reinstalledAvatar.changed, true);
  assert.equal(reinstalledAvatar.catalogRevision, 3);
  assert.deepEqual(avatarStorageSnapshot().profiles, selectedProfileRows);
  await page.goto('about:blank');
  await page.goto(started.url);
  await page.getByRole('link', { name: "Enter Alice's room" }).click();
  await page.getByText('Appearance', { exact: true }).click();
  await page.getByText('Avatar · Signal bots · Signal bot').waitFor();
  assert.equal(new URL(page.url()).hash, '');
  assert.equal(avatarCatalogRequestCount(), 8);
  const browserBoard = await page.evaluate(
    async ({ threadId, token }) => {
      const response = await fetch('/api/v1/local/board/threads/show', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId, replyLimit: 20, replyCursor: null }),
      });
      return { status: response.status, value: await response.json() };
    },
    { threadId: boardCreated.threadId, token: firstToken }
  );
  assert.equal(browserBoard.status, 200);
  assert.equal(browserBoard.value.thread.title, 'Persistent review');
  assert.equal(browserBoard.value.thread.body, 'Survives service restart.');
  assert.equal(browserBoard.value.boardRevision, 2);
  await page.locator('.block-heading').getByText('Saved · revision 1').waitFor();
  await page.getByRole('button', { name: 'Add plant' }).click();
  await page.getByRole('button', { name: 'Save layout' }).click();
  await page.getByText('Saved · revision 2').waitFor();
  assert(browserRequests.every((url) => new URL(url).hostname === '127.0.0.1'));
  const browserSaved = officeCommand(['block', 'show', '--local', '--identity', 'Alice']);
  assert.equal(browserSaved.revision, 2);
  assert.equal(browserSaved.layout.objects.length, 2);
  assert(
    browserSaved.layout.objects.some(
      (object) => object.prop === `${builtinDigest}/plant` && object.footprint.width === 2
    )
  );

  // Continue through the actual rendered board. These interactions use the
  // authenticated runtime installed by the local shell, not an in-memory API mock.
  await page.getByRole('link', { name: 'Board' }).click();
  await page.getByRole('heading', { name: 'Office board' }).waitFor();
  await page.getByRole('heading', { name: 'Persistent review' }).waitFor();
  await page.getByText('Survives service restart.').waitFor();
  await page
    .locator('.board-conversation .board-entry')
    .filter({ hasText: 'Persistent review' })
    .getByText(/Alice · revision 1/)
    .waitFor();
  assert.equal(await page.getByRole('heading', { name: repositoryTitle }).count(), 0);
  assert.equal(
    await page
      .locator('.board-index')
      .getByRole('button', { name: new RegExp(repositoryTitle) })
      .count(),
    0
  );
  const replyForm = page.locator('.board-reply-form');
  await replyForm.getByLabel('Message').fill('Owner reply created through the rendered board.');
  await replyForm.getByRole('button', { name: 'Reply as owner' }).click();
  await page.getByText('Owner reply created through the rendered board.').waitFor();

  await page.getByRole('button', { name: 'New post' }).click();
  const newPost = page.locator('.board-index .board-compose');
  await newPost.getByLabel('Title').fill('Owner follow-up');
  await newPost.getByLabel('Message').fill('Owner post before editing.');
  await newPost.getByRole('button', { name: 'Post as owner' }).click();
  await page.getByRole('heading', { name: 'Owner follow-up' }).waitFor();
  await page.getByRole('button', { name: 'Edit' }).click();
  const editForm = page.locator('.board-conversation .board-entry form');
  await editForm.getByLabel('Title').fill('Owner follow-up edited');
  await editForm.getByLabel('Message').fill('Owner edit persisted through restart.');
  await editForm.getByRole('button', { name: 'Save edit' }).click();
  await page.getByRole('heading', { name: 'Owner follow-up edited' }).waitFor();

  const repositoryId = 'example.com/Organization/Office-Discussion-Board-With-A-Long-Category';
  await page.getByLabel('Category').selectOption(`repository:${repositoryId}`);
  await page.getByRole('heading', { name: repositoryTitle }).waitFor();
  await page.getByText(repositoryBody).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Persistent review' }).count(), 0);
  assert.equal(
    await page
      .locator('.board-index')
      .getByRole('button', { name: /Persistent review/ })
      .count(),
    0
  );
  assert.equal(await page.locator('script').filter({ hasText: '__tmtBoardScriptRan' }).count(), 0);
  assert.equal(await page.evaluate(() => window.__tmtBoardScriptRan), undefined);
  const desktopScreenshot = process.env.TMT_TEST_BOARD_DESKTOP_SCREENSHOT;
  const narrowScreenshot = process.env.TMT_TEST_BOARD_NARROW_SCREENSHOT;
  if (desktopScreenshot) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: desktopScreenshot, fullPage: true });
  }
  if (narrowScreenshot) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: narrowScreenshot, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Moderate delete' }).click();
  await page.getByText('Deleted entry').waitFor();

  let ownerFollowUpEntry;
  const changedBoard = new Database(path.join(state, 'tmux-team.db'), { readonly: true });
  try {
    ownerFollowUpEntry = changedBoard
      .prepare(
        "SELECT id, author_kind, title, body, revision, deleted FROM office_board_entries WHERE title = 'Owner follow-up edited'"
      )
      .get();
    assert.deepEqual(ownerFollowUpEntry, {
      id: ownerFollowUpEntry.id,
      author_kind: 'owner',
      title: 'Owner follow-up edited',
      body: 'Owner edit persisted through restart.',
      revision: 2,
      deleted: 0,
    });
    assert.deepEqual(
      changedBoard
        .prepare(
          'SELECT author_kind, body, deleted FROM office_board_entries WHERE thread_id = ? AND is_root = 0'
        )
        .get(boardCreated.threadId),
      {
        author_kind: 'owner',
        body: 'Owner reply created through the rendered board.',
        deleted: 0,
      }
    );
    assert.deepEqual(
      changedBoard
        .prepare('SELECT title, body, deleted FROM office_board_entries WHERE id = ?')
        .get(repositoryCreated.entryId),
      { title: null, body: null, deleted: 1 }
    );
    assert.equal(
      changedBoard.prepare('SELECT revision FROM office_board_state WHERE singleton = 1').get()
        .revision,
      6
    );
  } finally {
    changedBoard.close();
  }

  const cliAfterBrowser = officeCommand([
    'board',
    'show',
    ownerFollowUpEntry.id,
    '--reply-limit',
    '20',
  ]);
  assert.equal(cliAfterBrowser.thread.author.kind, 'owner');
  assert.equal(cliAfterBrowser.thread.title, 'Owner follow-up edited');
  assert.equal(cliAfterBrowser.thread.body, 'Owner edit persisted through restart.');
  assert.equal(cliAfterBrowser.thread.revision, 2);
  const cliThreadAfterBrowser = officeCommand([
    'board',
    'show',
    boardCreated.threadId,
    '--reply-limit',
    '20',
  ]);
  assert.equal(cliThreadAfterBrowser.thread.author.kind, 'identity');
  assert.equal(cliThreadAfterBrowser.thread.author.name, 'Alice');
  assert(
    cliThreadAfterBrowser.replies.some(
      (reply) =>
        reply.author.kind === 'owner' &&
        reply.body === 'Owner reply created through the rendered board.'
    )
  );

  const boardBeforeStale = new Database(path.join(state, 'tmux-team.db'), { readonly: true });
  let staleSnapshot;
  try {
    staleSnapshot = {
      entry: boardBeforeStale
        .prepare('SELECT * FROM office_board_entries WHERE id = ?')
        .get(ownerFollowUpEntry.id),
      boardRevision: boardBeforeStale
        .prepare('SELECT revision FROM office_board_state WHERE singleton = 1')
        .get().revision,
    };
  } finally {
    boardBeforeStale.close();
  }
  const staleBoardEdit = await fetch(
    `${origin}/api/v1/local/board/entries/${ownerFollowUpEntry.id}`,
    {
      method: 'PUT',
      headers: { ...headers, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Stale overwrite',
        body: 'This must not commit.',
        ifRevision: 1,
        operationId: randomUUID(),
      }),
    }
  );
  assert.equal(staleBoardEdit.status, 409);
  assert.equal((await staleBoardEdit.json()).error, 'BOARD_REVISION_CONFLICT');
  const boardAfterStale = new Database(path.join(state, 'tmux-team.db'), { readonly: true });
  try {
    assert.deepEqual(
      {
        entry: boardAfterStale
          .prepare('SELECT * FROM office_board_entries WHERE id = ?')
          .get(ownerFollowUpEntry.id),
        boardRevision: boardAfterStale
          .prepare('SELECT revision FROM office_board_state WHERE singleton = 1')
          .get().revision,
      },
      staleSnapshot
    );
  } finally {
    boardAfterStale.close();
  }

  const cliReplyBody = 'Identity reply created through a fresh CLI process.';
  const cliReply = officeCommand([
    'board',
    'reply',
    boardCreated.threadId,
    '--identity',
    'Alice',
    '--body',
    cliReplyBody,
  ]);
  assert.equal(cliReply.revision, 1);
  await page.getByLabel('Category').selectOption('general');
  const generalThreadButton = page.getByRole('button', { name: /Persistent review/ });
  await generalThreadButton.waitFor();
  assert.equal(await page.getByRole('heading', { name: repositoryTitle }).count(), 0);
  await generalThreadButton.click();
  await page.getByText(cliReplyBody).waitFor();
  await page
    .locator('.board-entry')
    .filter({ hasText: cliReplyBody })
    .getByText(/Alice · revision 1/)
    .waitFor();
  assert(browserRequests.every((url) => new URL(url).hostname === '127.0.0.1'));
  await browser.close();
  browser = undefined;

  const badOrigin = await fetch(`${origin}/api/v1/local/identities/${created.identityId}/block`, {
    method: 'PUT',
    headers: { ...headers, Origin: 'http://attacker.invalid', 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 2, layout: { version: 2, objects: [] } }),
  });
  assert.equal(badOrigin.status, 403);
  assert.equal(
    (
      await fetch(`${origin}/api/v1/local/blocks`, {
        headers: { Authorization: `Bearer ${'z'.repeat(43)}` },
      })
    ).status,
    401
  );
  const badHost = await rawRequest(`${origin}/api/v1/local/blocks`, {
    headers: { Host: 'attacker.invalid', Authorization: `Bearer ${firstToken}` },
  });
  assert.equal(badHost.status, 421);
  assert.equal((await fetch(`${origin}/../private`, { headers })).status, 404);
  const invalidLayout = await fetch(
    `${origin}/api/v1/local/identities/${created.identityId}/block`,
    {
      method: 'PUT',
      headers: { ...headers, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: 2,
        layout: { version: 2, objects: [builtinFurniture('desk', 31, 31, 0)] },
      }),
    }
  );
  assert.equal(invalidLayout.status, 400);
  try {
    const oversized = await rawRequest(
      `${origin}/api/v1/local/identities/${created.identityId}/block`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${firstToken}`,
          Origin: origin,
          'Content-Type': 'application/json',
          'Content-Length': String(65 * 1024),
        },
        body: 'x'.repeat(65 * 1024),
      }
    );
    assert.equal(oversized.status, 400);
  } catch (error) {
    // The server may close as soon as the declared length exceeds its bound,
    // before Node finishes uploading. A reset is also a bounded rejection.
    assert.equal(error.cause?.code, 'ECONNRESET');
  }
  assert.equal(officeCommand(['block', 'show', '--local', '--identity', 'Alice']).revision, 2);

  const secondLayout = layout([builtinFurniture('plant', 2, 3, 0)]);
  officeCommand([
    'block',
    'apply',
    '--local',
    '--identity',
    'Alice',
    '--file',
    secondLayout,
    '--if-revision',
    '2',
  ]);
  const stale = await fetch(`${origin}/api/v1/local/identities/${created.identityId}/block`, {
    method: 'PUT',
    headers: { ...headers, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 2, layout: { version: 2, objects: [] } }),
  });
  assert.equal(stale.status, 409);

  const held = net.createConnection(Number(new URL(origin).port), '127.0.0.1');
  held.setEncoding('utf8');
  let heldResponse = '';
  const heldFinished = new Promise((resolve, reject) => {
    held.on('data', (chunk) => (heldResponse += chunk));
    held.once('end', resolve);
    held.once('error', reject);
  });
  await new Promise((resolve, reject) => {
    held.once('connect', resolve);
    held.once('error', reject);
  });
  held.write(
    `PUT /api/v1/local/identities/${created.identityId}/block HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${new URL(origin).port}\r\n` +
      `Authorization: Bearer ${firstToken}\r\n` +
      `Origin: ${origin}\r\n` +
      'Content-Type: application/json\r\n' +
      'Content-Length: 128\r\n\r\n' +
      '{"expectedRevision":3,'
  );
  assert.equal(officeCommand(['status']).service.running, true);
  assert.equal(officeCommand(['stop']).changed, true);
  await heldFinished;
  assert(heldResponse.startsWith('HTTP/1.1 400 '));
  assert.equal(officeCommand(['block', 'show', '--local', '--identity', 'Alice']).revision, 3);
  const stoppedLayout = layout([builtinFurniture('rug', 1, 1, 0)]);
  const stoppedWrite = officeCommand([
    'block',
    'apply',
    '--local',
    '--identity',
    'Alice',
    '--file',
    stoppedLayout,
    '--if-revision',
    '3',
  ]);
  assert.equal(stoppedWrite.revision, 4);
  const restarted = officeCommand(['start']);
  assert.notEqual(tokenFrom(restarted.url), firstToken);
  assert.equal(
    (await fetch(`${endpoint(restarted.url)}/api/v1/local/blocks`, { headers })).status,
    401
  );
  assert.deepEqual(
    officeCommand(['block', 'show', '--local', '--identity', 'Alice']).layout,
    stoppedWrite.layout
  );
  browser = await launchBrowser();
  const reopened = await browser.newPage();
  const reopenedBrowserRequests = [];
  reopened.on('request', (request) => reopenedBrowserRequests.push(request.url()));
  await reopened.goto(restarted.url);
  await reopened.getByRole('heading', { name: 'Your office', exact: true }).waitFor();
  await reopened.getByRole('link', { name: "Enter Alice's room" }).click();
  await reopened.getByText('Appearance', { exact: true }).click();
  assert.equal(new URL(reopened.url()).hash, '');
  const restartedToken = tokenFrom(restarted.url);
  const reopenedBoard = await reopened.evaluate(
    async ({ threadId, token }) => {
      const response = await fetch('/api/v1/local/board/threads/show', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId, replyLimit: 20, replyCursor: null }),
      });
      return { status: response.status, value: await response.json() };
    },
    { threadId: boardCreated.threadId, token: restartedToken }
  );
  assert.equal(reopenedBoard.status, 200);
  assert.equal(reopenedBoard.value.thread.title, 'Persistent review');
  assert.equal(reopenedBoard.value.thread.body, 'Survives service restart.');
  assert.equal(
    reopenedBoard.value.replies[0].body,
    'Owner reply created through the rendered board.'
  );
  assert(reopenedBoard.value.replies.some((reply) => reply.body === cliReplyBody));
  assert.equal(reopenedBoard.value.boardRevision, 7);
  await reopened.getByText('Saved · revision 4').waitFor();
  await reopened.getByText('Avatar · Signal bots · Signal bot').waitFor();
  assert.equal(await reopened.getByLabel('Avatar art').inputValue(), `${avatarDigest}/signal-bot`);
  const reopenedProfilePixels = await reopened
    .locator('.profile-preview .profile-avatar rect')
    .evaluateAll((nodes) => nodes.map((node) => [...node.attributes].map((item) => item.value)));
  assert.deepEqual(reopenedProfilePixels, profilePixels);
  assert.equal(
    reopenedBrowserRequests.filter(
      (url) => new URL(url).pathname === '/api/v1/local/avatar-catalog'
    ).length,
    2
  );
  assert.deepEqual(avatarStorageSnapshot().profiles, selectedProfileRows);
  await reopened.getByRole('link', { name: 'Board' }).click();
  await reopened.getByRole('heading', { name: 'Owner follow-up edited' }).waitFor();
  await reopened.getByRole('button', { name: /Persistent review/ }).click();
  await reopened.getByText('Owner reply created through the rendered board.').waitFor();
  await reopened
    .getByLabel('Category')
    .selectOption(
      'repository:example.com/Organization/Office-Discussion-Board-With-A-Long-Category'
    );
  await reopened.getByText('Deleted entry').waitFor();
  assert(reopenedBrowserRequests.every((url) => new URL(url).hostname === '127.0.0.1'));
  await browser.close();
  browser = undefined;

  const receipt = JSON.parse(fs.readFileSync(receiptPath));
  fs.writeFileSync(receiptPath, JSON.stringify({ ...receipt, runningVersion: '0.0.0-test' }), {
    mode: 0o600,
  });
  assert.equal(officeCommand(['status']).service.restartNeeded, true);
  assert.equal(officeCommand(['start'], 1).error.code, 'OFFICE_RESTART_REQUIRED');
  fs.writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
  process.kill(receipt.pid, 'SIGKILL');
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(receipt.pid, 0);
    } catch {
      break;
    }
    await pause(20);
  }
  assert.equal(officeCommand(['status']).service.running, false);
  const recovered = officeCommand(['start']);
  assert.equal(recovered.running, true);
  assert.equal(officeCommand(['stop']).changed, true);
  assert.equal(fs.existsSync(receiptPath), false);

  const occupied = net.createServer();
  await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  const occupiedPort = occupied.address().port;
  const portFailure = officeCommand(['start', '--port', String(occupiedPort)], 1);
  assert.equal(portFailure.error.code, 'OFFICE_PORT_UNAVAILABLE');
  await new Promise((resolve) => occupied.close(resolve));

  const fakePrefix = path.join(root, 'fake-prefix');
  fs.mkdirSync(path.join(fakePrefix, 'bin'), { recursive: true });
  const fakeOffice = path.join(root, 'fake-office');
  fs.writeFileSync(
    fakeOffice,
    `#!/bin/sh\nif [ "$1 $2 $3" = "__tmt-office 1 probe" ]; then printf 'TMT-OFFICE/1\\n${officeVersion}\\n'; exit 0; fi\nexit 1\n`,
    { mode: 0o700 }
  );
  installOfficeFixture(fakePrefix, fakeOffice, officeVersion);
  const readinessFailure = command(['office', 'start', '--prefix', fakePrefix], 1);
  assert.equal(readinessFailure.error.code, 'OFFICE_SERVICE_UNAVAILABLE');

  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(
    receiptPath,
    JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      port: 9,
      nonce: 'n'.repeat(43),
      browserToken: 'b'.repeat(43),
      controlToken: 'c'.repeat(43),
      runningVersion: 'unrelated',
    }),
    { mode: 0o600 }
  );
  const uncertain = officeCommand(['status'], 1);
  assert.equal(uncertain.error.code, 'OFFICE_SERVICE_UNCERTAIN');
  assert.doesNotThrow(() => process.kill(process.pid, 0));
  fs.unlinkSync(receiptPath);

  const beforeReset = officeCommand(['profile', 'show', '--local', '--identity', 'Alice']);
  assert.equal(beforeReset.revision, 1);
  const resetProfileFile = path.join(root, 'profile-default-reset.json');
  fs.writeFileSync(resetProfileFile, JSON.stringify({ ...beforeReset.profile, avatarRef: null }));
  const resetProfile = officeCommand([
    'profile',
    'apply',
    '--local',
    '--identity',
    'Alice',
    '--file',
    resetProfileFile,
    '--if-revision',
    '1',
  ]);
  assert.equal(resetProfile.revision, 2);
  assert.equal(Object.hasOwn(resetProfile.profile, 'avatarRef'), false);
  assert.deepEqual(resetProfile.profile.appearance, beforeReset.profile.appearance);
  const retriedResetProfile = officeCommand([
    'profile',
    'apply',
    '--local',
    '--identity',
    'Alice',
    '--file',
    resetProfileFile,
    '--if-revision',
    '1',
  ]);
  assert.equal(retriedResetProfile.changed, false);
  assert.equal(retriedResetProfile.revision, resetProfile.revision);
  assert.equal(retriedResetProfile.updatedAtMs, resetProfile.updatedAtMs);
  assert.deepEqual(retriedResetProfile.profile, resetProfile.profile);

  command(['rm', 'Alice', '--force']);
  command(['identity', 'create', 'Alice']);
  const replacement = officeCommand(['block', 'show', '--local', '--identity', 'Alice']);
  assert.equal(replacement.exists, false);
  assert.notEqual(replacement.identityId, created.identityId);
  const replacementProfile = officeCommand(['profile', 'show', '--local', '--identity', 'Alice']);
  assert.equal(replacementProfile.exists, false);
  assert.equal(replacementProfile.revision, 0);
  assert.notEqual(replacementProfile.identityId, appliedProfile.identityId);
  assert.equal(officeCommand(['stop']).changed, false);
  console.log('Verified offline local Office lifecycle, shared revisions and loopback security.');
} finally {
  await browser?.close();
  try {
    officeCommand(['stop']);
  } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
