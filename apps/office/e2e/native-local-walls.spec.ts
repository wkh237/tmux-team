import { mapGeometry } from '../src/world-map/map-source.js';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { runCli, withSandbox } from '../../../test/support/cli-process.js';
import { officeWorldFixture } from '../../../test/support/office-world.js';
import { installNativeOffice, unusedLoopbackPort } from './native-office-fixture.js';
import { savedWorld } from './native-world-state.js';
import { fitWorldCoordinates } from './world-editor-gesture.js';
import type { WorldDocument } from '../src/world-map/world-contract.js';
import type { WorldSnapshot, WorldWrite } from '../src/world-map/world-port.js';

test('native wall authoring rejects interior windows and missing support, preserves the draft, and saves explicit repairs across restart', async ({
  page,
}, info) => {
  await withSandbox(async (sandbox) => {
    const prefix = await installNativeOffice(sandbox);
    const command = async (args: string[]) => {
      const result = await runCli(sandbox, ['office', '--prefix', prefix, ...args, '--json'], {
        deadlineMs: 30_000,
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    };
    const initial: WorldSnapshot = await command(['layout', 'show']);
    const base = officeWorldFixture().layout;
    const studioId = '20000000-0000-4000-8000-000000000001';
    const layout: WorldDocument = {
      ...base,
      map: {
        ...base.map,
        areas: [
          ...mapGeometry(base.map).areas,
          { id: studioId, name: 'Studio', binding: { type: 'personal', identityId: null } },
        ],
        floor: Array.from({ length: 36 }, (_, y) => [
          { y, start: 0, end: 36, areaId: studioId },
          { y, start: 36, end: 72, areaId: base.map.primaryLobbyId },
        ]).flat(),
        doors: [{ x: 36, y: 16, axis: 'vertical' }],
      },
    };
    const file = path.join(sandbox.root, 'walls.json');
    writeFileSync(file, JSON.stringify(layout));
    await command([
      'layout',
      'apply',
      '--file',
      file,
      '--if-revision',
      '0',
      '--legacy-basis',
      initial.legacyBasis!,
    ]);
    let started = await command(['start', '--port', String(await unusedLoopbackPort())]);
    const writes: WorldWrite[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/v1/local/world' && request.method() === 'PUT')
        writes.push(request.postDataJSON());
    });
    const begin = () => page.getByRole('button', { name: 'Edit layout', exact: true }).click();
    const save = async (status: number) => {
      const response = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/v1/local/world' &&
          response.request().method() === 'PUT'
      );
      await page.getByRole('button', { name: 'Save layout', exact: true }).click();
      const result = await response;
      expect(result.status()).toBe(status);
      return result.json();
    };
    const coordinates = async (x: number, y: number) => {
      await precision();
      await page.getByRole('spinbutton', { name: 'X', exact: true }).fill(String(x));
      await page.getByRole('spinbutton', { name: 'Y', exact: true }).fill(String(y));
      await page.getByRole('button', { name: 'Apply coordinates', exact: true }).click();
    };
    const precision = async () => {
      const panel = page.locator('.world-placement-details');
      if (!(await panel.evaluate((element) => (element as HTMLDetailsElement).open)))
        await panel.locator('summary').click();
    };
    const object = page.getByRole('combobox', { name: 'Object', exact: true });
    try {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(started.url);
      await begin();
      await page.getByRole('combobox', { name: 'Area', exact: true }).selectOption(studioId);
      for (const name of [
        'Observatory window',
        'Brass wall lamp',
        'Orbit poster',
        'Crew sign',
        'Link plaque',
      ]) {
        await page.getByRole('button', { name: 'Walls', exact: true }).click();
        await page.getByRole('button', { name, exact: true }).click();
        if (name === 'Crew sign') {
          await page.getByLabel('Display text', { exact: true }).fill('CREW');
          await page.getByRole('button', { name: 'Apply appearance', exact: true }).click();
        }
      }
      await save(200);
      await expect(page.getByRole('button', { name: 'Edit layout', exact: true })).toBeVisible();
      const authored: WorldSnapshot = await command(['layout', 'show']);
      const original = savedWorld(sandbox.database);
      expect(JSON.parse(original.layout)).toEqual(authored.layout);
      expect(authored.layout.map).toEqual(layout.map);
      expect(authored.layout.objects[0]).toEqual(layout.objects[0]);
      const added = authored.layout.objects.slice(1);
      expect(added.map((entry) => [entry.kind, entry.placement.x, entry.placement.y])).toEqual([
        ['window', 0, 0],
        ['wallLight', 12, 0],
        ['decoration', 15, 0],
        ['decoration', 21, 0],
        ['decoration', 29, 0],
      ]);
      expect(added[3]!.placement.customization).toEqual({ text: 'CREW' });
      for (const entry of added)
        expect(entry.surface).toEqual({
          type: 'wall',
          axis: 'horizontal',
          face: 'positive',
          elevation: 3,
        });
      const window = added[0]!;
      await page.getByRole('button', { name: 'Fit office', exact: true }).click();
      await page.screenshot({ path: info.outputPath('native-wall-collection.png') });

      // The partition is valid and has a door outside the window's span. Only exterior eligibility changes.
      await begin();
      await object.selectOption(window.id);
      await precision();
      await page
        .getByRole('combobox', { name: 'Wall direction', exact: true })
        .selectOption('vertical');
      await page
        .getByRole('combobox', { name: 'Indoor face', exact: true })
        .selectOption('negative');
      await coordinates(36, 2);
      expect(await save(400)).toMatchObject({
        error: 'WORLD_INVALID',
        issues: [{ objectId: window.id, reason: 'windowRequiresExterior' }],
      });
      expect(savedWorld(sandbox.database)).toEqual(original);
      expect(writes.at(-1)!.layout).toEqual({
        ...authored.layout,
        objects: authored.layout.objects.map((entry) =>
          entry.id === window.id
            ? {
                ...entry,
                placement: { ...entry.placement, x: 36, y: 2 },
                surface: { type: 'wall', axis: 'vertical', face: 'negative', elevation: 3 },
              }
            : entry
        ),
      });
      await expect(page.getByRole('spinbutton', { name: 'X', exact: true })).toHaveValue('36');
      await page.getByRole('button', { name: 'Reload saved layout (discard draft)' }).click();
      await expect(page.getByRole('button', { name: 'Edit layout', exact: true })).toBeVisible();

      // Move the same window off its supporting wall; native admission must
      // reject it while retaining the complete draft for explicit repair.
      await begin();
      await object.selectOption(window.id);
      await coordinates(0, 1);
      expect(await save(400)).toMatchObject({
        error: 'WORLD_INVALID',
        issues: [{ objectId: window.id, reason: 'missingWall' }],
      });
      const invalid = writes.at(-1)!;
      expect(invalid.layout.map).toEqual(authored.layout.map);
      expect(invalid.layout.objects).toEqual(
        authored.layout.objects.map((entry) =>
          entry.id === window.id
            ? { ...entry, placement: { ...entry.placement, x: 0, y: 1 } }
            : entry
        )
      );
      expect(savedWorld(sandbox.database)).toEqual(original);
      await page.getByRole('button', { name: 'Select affected object', exact: true }).click();
      await expect(page.getByRole('heading', { name: /^Selected object: / })).toBeFocused();
      await expect(page.getByRole('heading', { name: /^Selected object: / })).toBeInViewport();
      await expect(object).toHaveValue(window.id);
      await expect(page.getByRole('spinbutton', { name: 'Y', exact: true })).toHaveValue('1');
      await page.screenshot({ path: info.outputPath('native-missing-wall-draft.png') });
      // Explicit relocation repairs the same window, with its ID/artwork unchanged.
      await coordinates(0, 0);
      await save(200);
      await expect(page.getByRole('button', { name: 'Edit layout', exact: true })).toBeVisible();
      const repaired: WorldSnapshot = await command(['layout', 'show']);
      expect(repaired.layout.map).toEqual(invalid.layout.map);
      expect(repaired.layout.objects).toEqual(authored.layout.objects);
      // Repair restores the exact saved state; no-op Save cannot advance revision.
      expect(savedWorld(sandbox.database).revision).toBe(original.revision);
      expect(JSON.parse(savedWorld(sandbox.database).layout)).toEqual(repaired.layout);
      const durable = savedWorld(sandbox.database);
      await page.goto('about:blank');
      await command(['stop']);
      started = await command(['start', '--port', String(await unusedLoopbackPort())]);
      await page.goto(started.url);
      await expect(page.locator('.office-map')).toHaveAttribute('data-scene-ready', 'true');
      expect(savedWorld(sandbox.database)).toEqual(durable);
      expect((await command(['layout', 'show'])).layout).toEqual(repaired.layout);
      await page.screenshot({ path: info.outputPath('native-repaired-wall-restart.png') });
      await begin();
      await page.getByRole('button', { name: 'Inspect', exact: true }).click();
      const point = await fitWorldCoordinates(page, { x: -4, y: -20, width: 80, height: 50.5 });
      // Repaired north window starts at y=0, elevation3. Hit its artwork center.
      const center = point(
        window.placement.footprint.width / 2,
        -3 - window.placement.footprint.height / 2
      );
      await page.mouse.click(center.x, center.y);
      await expect(object).toHaveValue(window.id);
      await expect(page.getByRole('heading', { name: /^Selected object: / })).toBeFocused();
      await precision();
      await expect(page.getByRole('spinbutton', { name: 'Y', exact: true })).toHaveValue('0');
      expect(savedWorld(sandbox.database)).toEqual(durable);
    } finally {
      try {
        if (!page.isClosed()) await page.goto('about:blank');
      } finally {
        await command(['stop']);
        expect((await command(['status'])).service.running).toBe(false);
      }
    }
  });
});
