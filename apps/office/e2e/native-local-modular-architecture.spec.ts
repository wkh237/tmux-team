import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { runCli, withSandbox } from '../../../test/support/cli-process.js';
import { officeWorldFixture, legacyLobbyObjects } from '../../../test/support/office-world.js';
import { installNativeOffice, unusedLoopbackPort } from './native-office-fixture.js';
import { savedWorld } from './native-world-state.js';
import { workshopStarter } from '../src/blocks/workshop-starter.js';
import vectors from '../../../contracts/office/modules-v2-vectors.json' with { type: 'json' };
import { decodeModuleMap } from '../src/world-map/module-contract.js';
import { moduleBounds } from '../src/world-map/module-geometry.js';
import type { WorldDocument, WorldObject } from '../src/world-map/world-contract.js';
import type { WorldSnapshot } from '../src/world-map/world-port.js';

/** Native module-source round trip and real architecture; not final art sign-off. */
test('four module offices and Lobby render derived seams and save source-only edits with mounted objects', async ({
  page,
}, info) => {
  await withSandbox(async (sandbox) => {
    const prefix = await installNativeOffice(sandbox);
    async function office<T>(args: string[]): Promise<T> {
      const result = await runCli(sandbox, ['office', '--prefix', prefix, ...args, '--json'], {
        deadlineMs: 30_000,
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      return JSON.parse(result.stdout) as T;
    }
    const initial = await office<WorldSnapshot>(['layout', 'show']);
    const base = officeWorldFixture().layout;
    const map = decodeModuleMap(vectors.starter);
    const offices = map.modules.slice(1);
    const objects: WorldObject[] = legacyLobbyObjects().map((object) => ({
      ...object,
      placement: { ...object.placement, x: object.placement.x + 32, y: object.placement.y + 2 },
    }));
    for (const [index, style] of (['study', 'library', 'studio', 'study'] as const).entries()) {
      const bounds = moduleBounds(offices[index]!, map.version);
      for (const placement of workshopStarter(style))
        objects.push({
          id: `30000000-0000-4000-8000-${String(objects.length + 1).padStart(12, '0')}`,
          kind: 'decoration',
          surface: { type: 'floor' },
          extension: null,
          placement: { ...placement, x: placement.x + bounds.x + 4, y: placement.y + bounds.y + 4 },
        });
    }
    const layout: WorldDocument = {
      ...base,
      map,
      objects,
    };
    const file = path.join(sandbox.root, 'architecture-slice.json');
    writeFileSync(file, JSON.stringify(layout));
    await office([
      'layout',
      'apply',
      '--file',
      file,
      '--if-revision',
      '0',
      '--legacy-basis',
      initial.legacyBasis!,
    ]);
    const started = await office<{ url: string }>([
      'start',
      '--port',
      String(await unusedLoopbackPort()),
    ]);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.setViewportSize({ width: 1536, height: 1024 });
      await page.goto(started.url);
      await expect(page.locator('.office-map')).toHaveAttribute('data-scene-ready', 'true');
      await page.getByRole('button', { name: 'Edit layout', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Add floor', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Paint area', exact: true })).toHaveCount(0);
      await page
        .getByRole('combobox', { name: 'Area', exact: true })
        .selectOption(offices[0]!.area.id);
      const areaName = page.getByRole('textbox', { name: 'Area name', exact: true });
      await areaName.fill('Design studio');
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect(areaName).toHaveValue('Office 01');
      await page.getByRole('button', { name: 'Redo', exact: true }).click();
      await expect(areaName).toHaveValue('Design studio');
      for (const name of ['Observatory window', 'Brass wall lamp', 'Orbit poster']) {
        await page.getByRole('button', { name: 'Walls', exact: true }).click();
        await page.getByRole('button', { name, exact: true }).click();
      }
      await page.screenshot({ path: info.outputPath('modular-architecture-build.png') });
      await page.getByRole('button', { name: 'Save layout', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Edit layout', exact: true })).toBeVisible();
      const authored = await office<WorldSnapshot>(['layout', 'show']);
      expect(authored.layout.map).toEqual({
        ...map,
        modules: map.modules.map((module) =>
          module.area.id === offices[0]!.area.id
            ? { ...module, area: { ...module.area, name: 'Design studio' } }
            : module
        ),
      });
      expect(authored.layout.map).not.toHaveProperty('floor');
      expect(authored.layout.map).not.toHaveProperty('doors');
      expect(authored.layout.map).not.toHaveProperty('areas');
      expect(authored.layout.objects).toHaveLength(layout.objects.length + 3);
      const durable = savedWorld(sandbox.database);
      expect(JSON.parse(durable.layout)).toEqual(authored.layout);
      await page.getByRole('button', { name: 'Fit office', exact: true }).click();
      expect(await page.evaluate(() => devicePixelRatio)).toBe(1);
      for (const name of ['Edit layout', 'Zoom in', 'Zoom out', 'Fit office']) {
        const button = page.getByRole('button', { name, exact: true });
        const bounds = (await button.boundingBox())!;
        expect(bounds.width).toBeGreaterThanOrEqual(44);
        expect(bounds.height).toBeGreaterThanOrEqual(44);
      }
      const edit = page.getByRole('button', { name: 'Edit layout', exact: true });
      await edit.focus();
      // Programmatic focus after a mouse click does not enter keyboard modality.
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      await expect(edit).toBeFocused();
      expect(await edit.evaluate((node) => getComputedStyle(node).outlineStyle)).toBe('solid');
      expect(await edit.evaluate((node) => getComputedStyle(node).outlineColor)).toBe(
        'rgb(92, 231, 238)'
      );
      expect(await edit.evaluate((node) => getComputedStyle(node).color)).toBe(
        'rgb(243, 234, 215)'
      );
      await page.screenshot({ path: info.outputPath('modular-architecture-1536.png') });
      await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
      await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
      // Reopening needs the original URL: its bearer lives only in memory.
      await page.goto('about:blank');
      await page.goto(started.url);
      await expect(page.locator('.office-map')).toHaveAttribute('data-scene-ready', 'true');
      expect(savedWorld(sandbox.database)).toEqual(durable);
      await page.getByRole('button', { name: 'Edit layout', exact: true }).click();
      const tools = page.getByRole('toolbar', { name: 'Build tools' });
      await tools.getByRole('button', { name: 'Add office', exact: true }).click();
      // Independent literal framing for the eight eligible starter neighbors:
      // scene bounds [-60,-80]..[164,89], 96px HUD band, left Lobby neighbor center[-32,12.5].
      const scale = Math.min((1536 * 0.84) / 224, (1024 - 192) / 169);
      await page.mouse.click(768 + (-32 - 52) * scale, 512 + (12.5 - 4.5) * scale);
      const form = page.getByRole('form', { name: 'New office' });
      await expect(form.locator('summary')).toContainText('Column -1, row 0 · Change');
      await expect(form.getByRole('textbox', { name: 'Name', exact: true })).toBeFocused();
      await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Expansion studio');
      await page.screenshot({ path: info.outputPath('modular-office-wireframe.png') });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole('button', { name: 'Fit office', exact: true }).click();
      await form.getByRole('textbox', { name: 'Name', exact: true }).focus();
      const cardBounds = (await form.boundingBox())!;
      const draftBounds = (await page.getByRole('region', { name: 'Layout draft' }).boundingBox())!;
      expect(cardBounds.x).toBeGreaterThanOrEqual(0);
      expect(cardBounds.x + cardBounds.width).toBeLessThanOrEqual(390);
      expect(cardBounds.y).toBeGreaterThanOrEqual(draftBounds.y + draftBounds.height);
      expect(cardBounds.y + cardBounds.height).toBeLessThanOrEqual(844);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      await page.screenshot({ path: info.outputPath('modular-office-wireframe-narrow.png') });
      await page.setViewportSize({ width: 1536, height: 1024 });
      await page.getByRole('button', { name: 'Fit office', exact: true }).click();
      // Choosing and naming a preview cannot create durable rooms or mutate the draft.
      expect(savedWorld(sandbox.database)).toEqual(durable);
      await form.getByRole('button', { name: 'Cancel placement' }).click();
      await expect(page.getByRole('region', { name: 'Layout draft' })).toContainText('No changes');
      await tools.getByRole('button', { name: 'Add office', exact: true }).click();
      await form.getByRole('combobox', { name: 'Office slot' }).selectOption('-1,0');
      await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Expansion studio');
      await form.getByRole('button', { name: 'Add office', exact: true }).click();
      await expect(page.getByRole('combobox', { name: 'Area', exact: true })).toContainText(
        'Expansion studio'
      );
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect(page.getByRole('combobox', { name: 'Area', exact: true })).not.toContainText(
        'Expansion studio'
      );
      await page.getByRole('button', { name: 'Redo', exact: true }).click();
      await page.getByRole('button', { name: 'Save layout', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Edit layout', exact: true })).toBeVisible();
      const expanded = await office<WorldSnapshot>(['layout', 'show']);
      expect(expanded.layout.map.version).toBe(2);
      if (expanded.layout.map.version !== 2) throw new Error('Expected module source');
      expect(expanded.layout.map.modules).toHaveLength(6);
      expect(expanded.layout.map.modules).toContainEqual({
        area: {
          id: expect.any(String),
          name: 'Expansion studio',
          binding: { type: 'personal', identityId: null },
        },
        slot: { type: 'office', column: -1, row: 0 },
        material: 'workshop',
      });
      expect(expanded.layout.objects).toEqual(authored.layout.objects);
      await page.goto('about:blank');
      await page.goto(started.url);
      await expect(page.locator('.office-map')).toHaveAttribute('data-scene-ready', 'true');
      expect(JSON.parse(savedWorld(sandbox.database).layout)).toEqual(expanded.layout);
      await page.getByRole('button', { name: 'Edit layout', exact: true }).click();
      await page.getByRole('button', { name: 'Preview modular layout', exact: true }).click();
      expect(JSON.parse(savedWorld(sandbox.database).layout)).toEqual(expanded.layout);
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Preview modular layout', exact: true })
      ).toBeVisible();
      await page.getByRole('button', { name: 'Redo', exact: true }).click();
      await page.getByRole('button', { name: 'Save layout', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Edit layout', exact: true })).toBeVisible();
      const grid = await office<WorldSnapshot>(['layout', 'show']);
      expect(grid.layout).toEqual({
        ...expanded.layout,
        map: {
          ...expanded.layout.map,
          version: 4,
          modules: expanded.layout.map.modules.map((module) => ({
            ...module,
            slot:
              module.slot.type === 'office' && module.slot.row >= 1
                ? { ...module.slot, row: module.slot.row + 1 }
                : module.slot,
          })),
        },
        // This fixture has only interior contents: the two southern workstations
        // move by48; Lobby and northern mounted objects keep their coordinates.
        objects: expanded.layout.objects.map((object) => ({
          ...object,
          placement: {
            ...object.placement,
            y: object.placement.y >= 48 ? object.placement.y + 48 : object.placement.y,
          },
        })),
      });
      await page.goto('about:blank');
      await page.goto(started.url);
      await expect(page.locator('.office-map')).toHaveAttribute('data-scene-ready', 'true');
      expect(JSON.parse(savedWorld(sandbox.database).layout)).toEqual(grid.layout);
      await page.getByRole('button', { name: 'Fit office', exact: true }).click();
      await page.screenshot({ path: info.outputPath('modular-grid-corridors.png') });
      await page.getByRole('button', { name: 'Edit layout', exact: true }).click();
      await tools.getByRole('button', { name: 'Add office', exact: true }).click();
      await form.getByRole('combobox', { name: 'Office slot' }).selectOption('0,-2');
      await expect(form.locator('summary')).toContainText('Column 0, row -2 · Change');
      await expect(form.getByRole('textbox', { name: 'Name', exact: true })).toBeFocused();
      await form.getByRole('textbox', { name: 'Name', exact: true }).fill('North workshop');
      await page.screenshot({ path: info.outputPath('modular-grid-wireframe.png') });
      expect(JSON.parse(savedWorld(sandbox.database).layout)).toEqual(grid.layout);
      await form.getByRole('button', { name: 'Cancel placement' }).click();
      await page
        .getByRole('region', { name: 'Layout draft' })
        .getByRole('button', { name: 'Cancel', exact: true })
        .click();
      expect(JSON.parse(savedWorld(sandbox.database).layout)).toEqual(grid.layout);
      await page.getByRole('button', { name: 'Edit layout', exact: true }).click();
      const areaPicker = page.getByRole('combobox', { name: 'Area', exact: true });
      await areaPicker.selectOption(offices[0]!.area.id);
      await page.getByRole('button', { name: 'Review module removal', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Remove module', exact: true })).toBeDisabled();
      await expect(page.getByRole('region', { name: 'Area removal preview' })).toContainText(
        'Move or explicitly remove the affected placements first.'
      );
      await page.getByRole('button', { name: 'Cancel removal', exact: true }).click();
      await areaPicker.selectOption(grid.layout.map.primaryLobbyId);
      await page.getByRole('button', { name: 'Review module removal', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Remove module', exact: true })).toBeDisabled();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Review module removal', exact: true })
      ).toBeFocused();
      if (grid.layout.map.version === 1) throw new Error('Expected modular layout');
      const expansion = grid.layout.map.modules.find(
        (module) => module.area.name === 'Expansion studio'
      )!;
      await areaPicker.selectOption(expansion.area.id);
      await page.getByRole('button', { name: 'Review module removal', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Remove module', exact: true })).toBeEnabled();
      await expect(page.getByRole('button', { name: 'Cancel removal', exact: true })).toBeFocused();
      await page.setViewportSize({ width: 390, height: 844 });
      const removalDialog = (await page.getByRole('dialog').boundingBox())!;
      const removeButton = (await page
        .getByRole('button', { name: 'Remove module', exact: true })
        .boundingBox())!;
      expect(removalDialog.x).toBeGreaterThanOrEqual(0);
      expect(removalDialog.x + removalDialog.width).toBeLessThanOrEqual(390);
      expect(removeButton.y + removeButton.height).toBeLessThanOrEqual(844);
      await page.screenshot({ path: info.outputPath('modular-module-removal-narrow.png') });
      await page.setViewportSize({ width: 1536, height: 1024 });
      await page.screenshot({ path: info.outputPath('modular-module-removal.png') });
      await page.getByRole('button', { name: 'Remove module', exact: true }).click();
      await expect(areaPicker).not.toContainText('Expansion studio');
      expect(JSON.parse(savedWorld(sandbox.database).layout)).toEqual(grid.layout);
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect(areaPicker).toContainText('Expansion studio');
      await page.getByRole('button', { name: 'Redo', exact: true }).click();
      await page.getByRole('button', { name: 'Save layout', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Edit layout', exact: true })).toBeVisible();
      const removed = await office<WorldSnapshot>(['layout', 'show']);
      expect(removed.layout).toEqual({
        ...grid.layout,
        map: {
          ...grid.layout.map,
          modules: grid.layout.map.modules.filter((module) => module !== expansion),
        },
      });
      await page.goto('about:blank');
      await page.goto(started.url);
      await expect(page.locator('.office-map')).toHaveAttribute('data-scene-ready', 'true');
      expect(JSON.parse(savedWorld(sandbox.database).layout)).toEqual(removed.layout);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: info.outputPath('modular-architecture-narrow.png') });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      expect(errors).toEqual([]);
    } finally {
      await page.goto('about:blank');
      await office(['stop']);
    }
  });
});
