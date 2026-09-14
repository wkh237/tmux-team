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
    const propFile = path.join(sandbox.root, 'studio.tmtprop.json');
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
    expect(JSON.parse(block.stdout)).toMatchObject({
      revision: 1,
      layout: { version: 2 },
      resolutions: [{ status: 'available' }, { status: 'available' }],
    });

    let started = await office(['start', '--port', String(await unusedLoopbackPort())]);
    expect(started.status, started.stdout).toBe(0);
    let sessionUrl = JSON.parse(started.stdout).url as string;
    try {
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
      const previewPage = await previewContext.newPage();
      await previewPage.goto(firstPreview.url);
      await expect(previewPage.getByRole('heading', { name: 'Signal lamp' })).toBeVisible();
      await previewContext.close();

      await page.goto(sessionUrl);
      await expect(page.getByRole('button', { name: 'Signal lamp 1' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Desk 2' })).toBeVisible();
      await expect(page.locator('rect[fill="#ff5533ff"]')).toHaveCount(5);
      await page.screenshot({
        path: testInfo.outputPath('builtin-custom-props-desktop.png'),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: testInfo.outputPath('builtin-custom-props-narrow.png'),
        fullPage: true,
      });

      const removed = await office(['prop', 'remove', '--local', digest, '--if-revision', '1']);
      expect(removed.status, removed.stdout).toBe(0);
      await expect(
        page.getByRole('img', { name: `Unavailable prop ${digest.slice(7, 19)}` })
      ).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByRole('button', { name: 'Desk 2' })).toBeVisible();

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
      await expect(page.locator('rect[fill="#ff5533ff"]')).toHaveCount(5, { timeout: 10_000 });

      const database = new Database(sandbox.database);
      try {
        database
          .prepare('UPDATE office_prop_packs SET bytes = ? WHERE digest = ?')
          .run(Buffer.from('{}'), digest);
      } finally {
        database.close();
      }
      await expect(
        page.getByRole('img', { name: `Unavailable prop ${digest.slice(7, 19)}` })
      ).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByRole('button', { name: 'Desk 2' })).toBeVisible();

      expect((await office(['stop'])).status).toBe(0);
      started = await office(['start', '--port', String(await unusedLoopbackPort())]);
      expect(started.status, started.stdout).toBe(0);
      sessionUrl = JSON.parse(started.stdout).url;
      await page.goto(sessionUrl);
      await expect(
        page.getByRole('img', { name: `Unavailable prop ${digest.slice(7, 19)}` })
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Desk 2' })).toBeVisible();
    } finally {
      await office(['stop']);
    }
  });
});
