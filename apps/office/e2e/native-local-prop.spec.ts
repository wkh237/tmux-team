import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from '@playwright/test';
import { runCli, withSandbox } from '../../../test/support/cli-process.js';
import { builtinFurniture } from '../src/blocks/block-contract.js';
import { BUILTIN_DIGEST } from '../src/props/prop-contract.js';
import { installNativeOffice } from './native-office-fixture.js';

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a port.');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
}

function propState(databasePath: string, digest: string) {
  const database = new Database(databasePath, { readonly: true });
  try {
    const catalogRevision = database
      .prepare('SELECT revision FROM office_prop_catalog WHERE singleton = 1')
      .pluck()
      .get() as number;
    const candidate = database
      .prepare(
        'SELECT digest, bytes, prop_count AS propCount, installed_revision AS installedRevision, installed_at_ms AS installedAtMs FROM office_prop_packs WHERE digest = ?'
      )
      .get(digest) as
      | {
          digest: string;
          bytes: Buffer;
          propCount: number;
          installedRevision: number;
          installedAtMs: number;
        }
      | undefined;
    return { catalogRevision, candidate };
  } finally {
    database.close();
  }
}

function savedBlock(databasePath: string, identityId: string) {
  const database = new Database(databasePath, { readonly: true });
  try {
    const row = database
      .prepare(
        'SELECT block_id AS blockId, identity_id AS identityId, revision, layout, updated_at_ms AS updatedAtMs FROM office_local_blocks WHERE identity_id = ?'
      )
      .get(identityId) as
      | {
          blockId: string;
          identityId: string;
          revision: number;
          layout: string;
          updatedAtMs: number;
        }
      | undefined;
    return row && { ...row, layoutBytes: Buffer.from(row.layout) };
  } finally {
    database.close();
  }
}

test('data-only prop reaches catalog, preview, block renderer and placeholder lifecycle', async ({
  browser,
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  await withSandbox(async (sandbox) => {
    const prefix = await installNativeOffice(sandbox);
    const identityName = 'Prop artist';
    const identity = await runCli(sandbox, ['identity', 'create', identityName, '--json']);
    expect(identity.status, identity.stdout).toBe(0);
    const identityId = (JSON.parse(identity.stdout).identity as { id: string }).id;
    const propFile = path.join(sandbox.root, 'studio.tmtprop.json');
    const fullLabel = '\\'.repeat(80);
    const capacityProps = Array.from({ length: 14 }, (_, index) => ({
      key: `prop-${String(index).padStart(27, '0')}`,
      label: fullLabel,
      footprint: { width: 1, height: 1 },
      pixels: ['1'],
    }));
    writeFileSync(
      propFile,
      JSON.stringify({
        formatVersion: 1,
        label: 'Studio custom',
        credit: 'Acceptance fixture',
        license: 'CC0-1.0',
        palette: ['#00000000', '#ff5533ff'],
        props: [
          {
            key: 'signal-lamp',
            label: 'Signal lamp',
            footprint: { width: 2, height: 2 },
            pixels: ['010', '111', '010'],
          },
          ...capacityProps,
        ],
      })
    );
    const office = (args: string[]) =>
      runCli(sandbox, ['office', '--prefix', prefix, ...args, '--json'], {
        deadlineMs: 30_000,
      });
    const validated = await office(['prop', 'validate', '--file', propFile]);
    expect(validated.status, validated.stdout).toBe(0);
    const digest = JSON.parse(validated.stdout).digest as string;
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const stoppedPreview = await office(['prop', 'preview', '--file', propFile]);
    expect(stoppedPreview.status).toBe(1);
    expect(stoppedPreview.stdout).toContain('OFFICE_SERVICE_NOT_RUNNING');
    const installed = await office([
      'prop',
      'install',
      '--local',
      '--file',
      propFile,
      '--if-revision',
      '0',
    ]);
    expect(installed.status, installed.stdout).toBe(0);
    expect(JSON.parse(installed.stdout)).toMatchObject({
      digest,
      catalogRevision: 1,
      builtin: false,
      changed: true,
    });
    const installedState = propState(sandbox.database, digest);
    expect(installedState).toMatchObject({
      catalogRevision: 1,
      candidate: {
        digest,
        propCount: 15,
        installedRevision: 1,
        installedAtMs: expect.any(Number),
      },
    });
    expect(installedState.candidate!.bytes).toEqual(readFileSync(propFile));
    expect(installedState.candidate!.installedAtMs).toBeGreaterThan(0);
    const listed = await office(['prop', 'list', '--local']);
    expect(listed.status, listed.stdout).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({
      catalogRevision: 1,
      builtins: [{ digest: BUILTIN_DIGEST, builtin: true }],
      packs: [{ digest, builtin: false }],
    });
    const layoutFile = path.join(sandbox.root, 'layout-v2.json');
    writeFileSync(
      layoutFile,
      JSON.stringify({
        version: 2,
        objects: [
          {
            prop: `${digest}/signal-lamp`,
            footprint: { width: 2, height: 2 },
            x: 4,
            y: 6,
            rotation: 0,
          },
          ...capacityProps.map((prop, index) => ({
            prop: `${digest}/${prop.key}`,
            footprint: prop.footprint,
            x: index,
            y: 2,
            rotation: 0,
          })),
          builtinFurniture('desk', 10, 10, 0),
        ],
      })
    );
    const block = await office([
      'block',
      'apply',
      '--local',
      '--identity',
      identityName,
      '--file',
      layoutFile,
      '--if-revision',
      '0',
    ]);
    expect(block.status, block.stdout).toBe(0);
    expect(Buffer.byteLength(block.stdout)).toBeGreaterThan(4_096);
    expect(JSON.parse(block.stdout)).toMatchObject({
      revision: 1,
      layout: { version: 2 },
      resolutions: Array.from({ length: 16 }, () => ({ status: 'available' })),
    });
    expect(JSON.parse(block.stdout).layout.objects).toHaveLength(16);
    expect(JSON.parse(block.stdout).resolutions).toHaveLength(16);
    const shown = await office(['block', 'show', '--local', '--identity', identityName]);
    expect(shown.status, shown.stdout).toBe(0);
    expect(Buffer.byteLength(shown.stdout)).toBeGreaterThan(4_096);
    expect(JSON.parse(shown.stdout)).toMatchObject({
      revision: 1,
      layout: { version: 2 },
      resolutions: Array.from({ length: 16 }, () => ({ status: 'available' })),
    });
    expect(JSON.parse(shown.stdout).layout.objects).toHaveLength(16);
    expect(JSON.parse(shown.stdout).resolutions).toHaveLength(16);
    const storedBlock = savedBlock(sandbox.database, identityId);
    expect(storedBlock).toMatchObject({
      blockId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      identityId,
      revision: 1,
      updatedAtMs: expect.any(Number),
    });
    expect(storedBlock!.updatedAtMs).toBeGreaterThan(0);
    expect(JSON.parse(storedBlock!.layout)).toEqual(JSON.parse(readFileSync(layoutFile, 'utf8')));

    let started = await office(['start', '--port', String(await unusedLoopbackPort())]);
    expect(started.status, started.stdout).toBe(0);
    let sessionUrl = JSON.parse(started.stdout).url as string;
    try {
      const beforePreviews = {
        prop: propState(sandbox.database, digest),
        block: savedBlock(sandbox.database, identityId),
      };
      const preview = await office(['prop', 'preview', '--file', propFile]);
      expect(preview.status, preview.stdout).toBe(0);
      const firstPreview = JSON.parse(preview.stdout);
      const repeatedPreview = await office(['prop', 'preview', '--file', propFile]);
      expect(repeatedPreview.status, repeatedPreview.stdout).toBe(0);
      expect(JSON.parse(repeatedPreview.stdout)).toMatchObject({
        previewId: firstPreview.previewId,
        expiresAtMs: firstPreview.expiresAtMs,
      });
      for (let index = 1; index <= 3; index += 1) {
        const variant = path.join(sandbox.root, `studio-${index}.tmtprop.json`);
        const document = JSON.parse(readFileSync(propFile, 'utf8'));
        document.label = `Studio custom ${index}`;
        writeFileSync(variant, JSON.stringify(document));
        const accepted = await office(['prop', 'preview', '--file', variant]);
        expect(accepted.status, accepted.stdout).toBe(0);
      }
      const overflow = path.join(sandbox.root, 'studio-overflow.tmtprop.json');
      const overflowDocument = JSON.parse(readFileSync(propFile, 'utf8'));
      overflowDocument.label = 'Studio overflow';
      writeFileSync(overflow, JSON.stringify(overflowDocument));
      const limited = await office(['prop', 'preview', '--file', overflow]);
      expect(limited.status).toBe(1);
      expect(limited.stdout).toContain('OFFICE_PROP_PREVIEW_LIMIT');
      const previewContext = await browser.newContext();
      try {
        const previewPage = await previewContext.newPage();
        await previewPage.goto(firstPreview.url);
        await expect(previewPage.getByRole('heading', { name: 'Signal lamp' })).toBeVisible();
      } finally {
        await previewContext.close();
      }
      expect({
        prop: propState(sandbox.database, digest),
        block: savedBlock(sandbox.database, identityId),
      }).toEqual(beforePreviews);

      await page.goto(sessionUrl);
      await expect(page.getByRole('button', { name: 'Signal lamp 1' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Desk 16' })).toBeVisible();
      await expect(page.locator('rect[fill="#ff5533ff"]')).toHaveCount(19);
      await page.screenshot({
        path: testInfo.outputPath('builtin-custom-props-desktop.png'),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      const narrowBounds = await page.evaluate(() => {
        const tools = document.querySelector<HTMLElement>('.block-tools')!.getBoundingClientRect();
        const buttons = Array.from(
          document.querySelectorAll<HTMLElement>('.furniture-list button')
        ).map((button) => button.getBoundingClientRect());
        return {
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          toolsLeft: tools.left,
          toolsRight: tools.right,
          buttonsLeft: Math.min(...buttons.map((button) => button.left)),
          buttonsRight: Math.max(...buttons.map((button) => button.right)),
        };
      });
      expect(narrowBounds.documentWidth).toBeLessThanOrEqual(narrowBounds.viewportWidth);
      expect(narrowBounds.buttonsLeft).toBeGreaterThanOrEqual(narrowBounds.toolsLeft);
      expect(narrowBounds.buttonsRight).toBeLessThanOrEqual(narrowBounds.toolsRight);
      await page.screenshot({
        path: testInfo.outputPath('builtin-custom-props-narrow.png'),
        fullPage: true,
      });

      const removed = await office(['prop', 'remove', '--local', digest, '--if-revision', '1']);
      expect(removed.status, removed.stdout).toBe(0);
      expect(propState(sandbox.database, digest)).toEqual({
        catalogRevision: 2,
        candidate: undefined,
      });
      expect(savedBlock(sandbox.database, identityId)).toEqual(storedBlock);
      await expect(
        page.getByRole('img', { name: `Unavailable prop ${digest.slice(7, 19)}` }).first()
      ).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByRole('button', { name: 'Desk 16' })).toBeVisible();
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.screenshot({
        path: testInfo.outputPath('unavailable-props-desktop.png'),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: testInfo.outputPath('unavailable-props-narrow.png'),
        fullPage: true,
      });

      const restored = await office([
        'prop',
        'install',
        '--local',
        '--file',
        propFile,
        '--if-revision',
        '2',
      ]);
      expect(restored.status, restored.stdout).toBe(0);
      const restoredState = propState(sandbox.database, digest);
      expect(restoredState).toMatchObject({
        catalogRevision: 3,
        candidate: { digest, propCount: 15, installedRevision: 3 },
      });
      expect(restoredState.candidate!.bytes).toEqual(readFileSync(propFile));
      expect(savedBlock(sandbox.database, identityId)).toEqual(storedBlock);
      await expect(page.locator('rect[fill="#ff5533ff"]')).toHaveCount(19, { timeout: 10_000 });

      const database = new Database(sandbox.database);
      try {
        database
          .prepare('UPDATE office_prop_packs SET bytes = ? WHERE digest = ?')
          .run(Buffer.from('{}'), digest);
      } finally {
        database.close();
      }
      expect(savedBlock(sandbox.database, identityId)).toEqual(storedBlock);
      await expect(
        page.getByRole('img', { name: `Unavailable prop ${digest.slice(7, 19)}` }).first()
      ).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByRole('button', { name: 'Desk 16' })).toBeVisible();

      expect((await office(['stop'])).status).toBe(0);
      started = await office(['start', '--port', String(await unusedLoopbackPort())]);
      expect(started.status, started.stdout).toBe(0);
      sessionUrl = JSON.parse(started.stdout).url;
      expect(savedBlock(sandbox.database, identityId)).toEqual(storedBlock);
      await page.goto(sessionUrl);
      await expect(
        page.getByRole('img', { name: `Unavailable prop ${digest.slice(7, 19)}` }).first()
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Desk 16' })).toBeVisible();
    } finally {
      const stopped = await office(['stop']);
      expect(stopped.status, stopped.stdout).toBe(0);
      expect(JSON.parse(stopped.stdout)).toMatchObject({ running: false });
      expect(typeof JSON.parse(stopped.stdout).changed).toBe('boolean');
    }
  });
});
