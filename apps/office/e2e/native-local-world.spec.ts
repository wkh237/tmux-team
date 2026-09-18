import { mapGeometry } from '../src/world-map/map-source.js';
import { worldGeometry, worldObjectRect, wallProjection } from '../src/rendering/world-geometry.js';
import Database from 'better-sqlite3';
import { expect, test } from '@playwright/test';
import { runCli, withSandbox } from '../../../test/support/cli-process.js';
import { installNativeOffice, unusedLoopbackPort } from './native-office-fixture.js';
import type { WorldSnapshot } from '../src/world-map/world-port.js';
import { STUDY_DIGEST, MODULAR_LOUNGE_DIGEST } from '../src/props/prop-contract.js';
import { installDrawObserver, observeIdleScene, sceneActivity } from './scene-observation.js';
import { fitWorldCoordinates } from './world-editor-gesture.js';

test('one installation world is lazy, saves through the browser and retains an empty layout after restart', async ({
  page,
}, info) => {
  await withSandbox(async (sandbox) => {
    const prefix = await installNativeOffice(sandbox);
    const office = async (args: string[]) => {
      const result = await runCli(sandbox, ['office', '--prefix', prefix, ...args, '--json'], {
        deadlineMs: 30_000,
      });
      expect(result.status, result.stdout).toBe(0);
      return JSON.parse(result.stdout);
    };
    const show = async (): Promise<WorldSnapshot> => office(['layout', 'show']);
    const observe = () => {
      const database = new Database(sandbox.database, { readonly: true });
      try {
        const row = database
          .prepare(
            'SELECT layout_revision AS revision, layout_json AS layout FROM office_local_worlds'
          )
          .get() as { revision: number; layout: string } | undefined;
        return {
          identities: database.prepare('SELECT count(*) FROM identities').pluck().get(),
          blocks: database.prepare('SELECT count(*) FROM office_local_blocks').pluck().get(),
          world: row ? { revision: row.revision, layout: JSON.parse(row.layout) } : null,
        };
      } finally {
        database.close();
      }
    };
    const initial = await show();
    expect(initial).toMatchObject({ worldId: null, revision: 0, changed: false });
    expect(initial.legacyBasis).toMatch(/^[a-f0-9]{64}$/);
    expect(initial.layout.map.version).toBe(5);
    const areas = mapGeometry(initial.layout.map).areas;
    expect(areas).toHaveLength(5);
    expect(areas.find((area) => area.id === initial.layout.map.primaryLobbyId)).toEqual({
      id: initial.layout.map.primaryLobbyId,
      name: 'Lobby',
      binding: { type: 'lobby' },
    });
    expect(
      areas.filter((area) => area.binding.type === 'personal').map((area) => area.binding)
    ).toEqual(Array.from({ length: 4 }, () => ({ type: 'personal', identityId: null })));
    const props = initial.layout.objects.map((object) => object.placement.prop);
    expect(props).toContain(`${MODULAR_LOUNGE_DIGEST}/lounge-sofa`);
    expect(props).toContain(`${STUDY_DIGEST}/oak-bookcase`);
    const geometry = worldGeometry(initial.layout);
    const front = geometry
      .visible(geometry.bounds)
      .walls.find(
        (wall) =>
          wall.areaId === initial.layout.map.primaryLobbyId &&
          wall.axis === 'horizontal' &&
          !wall.raised &&
          !wall.open &&
          !wall.circulation
      );
    expect(front).toBeDefined();
    for (const object of initial.layout.objects.filter((item) => item.extension)) {
      const artwork = worldObjectRect(object, geometry.projection);
      expect(artwork.y + artwork.height).toBeLessThanOrEqual(
        wallProjection(front!, geometry.projection).bounds.y
      );
    }
    const unmaterialized = { identities: 0, blocks: 0, world: null };
    // A denser projection must not bury the starter desks behind tall front walls.
    const desks = initial.layout.objects.filter((item) =>
      item.placement.prop.endsWith('/workstation-desk')
    );
    expect(desks).toHaveLength(4);
    for (const desk of desks) {
      const wall = geometry
        .visible(geometry.bounds)
        .walls.filter(
          (candidate) =>
            candidate.axis === 'horizontal' &&
            !candidate.raised &&
            !candidate.open &&
            !candidate.circulation &&
            candidate.y > desk.placement.y &&
            candidate.x <= desk.placement.x &&
            candidate.x + candidate.width > desk.placement.x
        )
        .sort((a, b) => a.y - b.y)[0]!;
      expect(wall).toBeDefined();
      const art = worldObjectRect(desk, geometry.projection);
      expect(
        art.y + art.height - wallProjection(wall, geometry.projection).bounds.y
      ).toBeLessThanOrEqual(2);
    }
    expect(observe()).toEqual(unmaterialized);
    let started = await office(['start', '--port', String(await unusedLoopbackPort())]);
    try {
      await page.setViewportSize({ width: 1536, height: 1024 });
      await installDrawObserver(page);
      await page.goto(started.url);
      await expect(page.locator('.office-map')).toHaveAttribute('data-scene-ready', 'true');
      await expect(page.getByRole('button', { name: 'Office menu' })).toBeVisible();
      expect(observe()).toEqual(unmaterialized);
      await page.screenshot({ path: info.outputPath('native-world-preset.png') });
      await observeIdleScene(page, info, 'starter');
      // Inspect the real Lobby at a readable scale through normal camera controls.
      await page.mouse.move(900, 650);
      await page.mouse.down();
      await page.mouse.move(1032, 618);
      await page.mouse.up();
      for (let step = 0; step < 3; step++)
        await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
      await sceneActivity(page);
      await page.screenshot({ path: info.outputPath('native-world-lobby.png') });
      await page.getByRole('button', { name: 'Fit office', exact: true }).click();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: info.outputPath('native-world-preset-narrow.png') });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        390
      );
      await page.setViewportSize({ width: 1536, height: 1024 });
      await page.getByRole('button', { name: 'Edit layout' }).click();
      await expect(
        page.getByRole('combobox', { name: 'Object', exact: true }).locator('option')
      ).toHaveCount(initial.layout.objects.length + 1);
      expect(observe()).toEqual(unmaterialized);
      await page.screenshot({ path: info.outputPath('native-world-edit-walls.png') });
      const areaPicker = page.getByRole('combobox', { name: 'Area', exact: true });
      await areaPicker.selectOption(areas.find((area) => area.name === 'Office 01')!.id);
      await expect(
        page.getByRole('combobox', { name: 'Object', exact: true }).locator('optgroup').first()
      ).toHaveAttribute('label', /^Office 01 · Current room \(/);
      await page.screenshot({ path: info.outputPath('native-world-edit-office-walls.png') });
      expect(observe()).toEqual(unmaterialized);
      await areaPicker.selectOption(initial.layout.map.primaryLobbyId);
      const sofa = initial.layout.objects.find(
        (object) => object.placement.prop.endsWith('/lounge-sofa') && object.placement.x === 8
      )!;
      expect(sofa.placement.y).toBe(8);
      const dragSofa = async () => {
        await page.getByRole('combobox', { name: 'Object', exact: true }).selectOption(sofa.id);
        const move = page
          .locator('.world-object-actions')
          .getByRole('button', { name: 'Move object', exact: true });
        await move.click();
        await expect(move).toHaveAttribute('aria-pressed', 'true');
        await expect(move).toHaveCSS('background-color', 'rgb(154, 244, 212)');
        await expect(page.locator('.world-object-preview > svg')).toHaveCSS('width', '80px');
        await expect(page.locator('.world-object-preview > svg svg')).toHaveCSS('width', 'auto');
        await expect(page.locator('.world-object-preview > svg svg')).toHaveAttribute(
          'width',
          '16'
        );
        const inspector = await page
          .getByRole('complementary', { name: 'Layout tools' })
          .boundingBox();
        const saveBar = await page.locator('.world-save-bar').boundingBox();
        // A collapsed inspector must leave the unused space transparent to the scene.
        expect(inspector).not.toBeNull();
        expect(saveBar).not.toBeNull();
        expect(saveBar!.y + saveBar!.height).toBeLessThanOrEqual(inspector!.y);
        await page.screenshot({ path: info.outputPath('native-world-object-actions.png') });
        // Independent v5 framing: 104-wide world plus the meeting ghost through
        // x=168, -48..136 source Y, 7/8 depth and 16 wall reserve.
        // Lobby interior is 61/88 of native depth; Fit includes four-unit borders.
        const point = await fitWorldCoordinates(page, { x: -4, y: -62, width: 176, height: 189 });
        const from = point(16, 16 + (16 * 61) / 88 - 8);
        const to = point(20, 16 + (20 * 61) / 88 - 8);
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps: 6 });
        await page.mouse.up();
        await page.getByText('Precise placement', { exact: true }).click();
        await expect(page.getByRole('spinbutton', { name: 'X', exact: true })).toHaveValue('12');
        await expect(page.getByRole('spinbutton', { name: 'Y', exact: true })).toHaveValue('12');
      };
      await dragSofa();
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect(page.getByRole('spinbutton', { name: 'X', exact: true })).toHaveValue('8');
      await expect(page.getByRole('spinbutton', { name: 'Y', exact: true })).toHaveValue('8');
      await page.getByRole('button', { name: 'Redo', exact: true }).click();
      await expect(page.getByRole('spinbutton', { name: 'X', exact: true })).toHaveValue('12');
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      expect(observe()).toEqual(unmaterialized);
      await page.getByRole('button', { name: 'Edit layout', exact: true }).click();
      await dragSofa();
      const expectedLayout = structuredClone(initial.layout);
      const expectedSofa = expectedLayout.objects.find((object) => object.id === sofa.id)!;
      expectedSofa.placement.x = expectedSofa.placement.y = 12;
      await page.getByRole('button', { name: 'Save layout', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Edit layout' })).toBeVisible();
      await page.screenshot({ path: info.outputPath('native-world-solid-walls.png') });
      const saved = await show();
      expect(saved).toMatchObject({ revision: 1, legacyBasis: null, layout: expectedLayout });
      expect(observe()).toEqual({
        identities: 0,
        blocks: 0,
        world: { revision: 1, layout: expectedLayout },
      });

      await page.getByRole('button', { name: 'Edit layout' }).click();
      const objects = page.getByRole('combobox', { name: 'Object', exact: true });
      for (const [index, object] of initial.layout.objects.entries()) {
        await objects.selectOption(object.id);
        await page.getByRole('button', { name: 'Remove placement', exact: true }).click();
        await expect(objects.locator('option')).toHaveCount(initial.layout.objects.length - index);
      }
      // A browser draft is not an implicit write or a second store.
      expect(await show()).toEqual(saved);
      await page.getByRole('button', { name: 'Save layout', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Edit layout' })).toBeVisible();
      const cleared = await show();
      const empty = { ...initial.layout, objects: [] };
      expect(cleared).toMatchObject({ worldId: saved.worldId, revision: 2, layout: empty });
      await office(['stop']);
      started = await office(['start', '--port', String(await unusedLoopbackPort())]);
      await page.goto(started.url);
      await expect(page.locator('.office-map')).toHaveAttribute('data-scene-ready', 'true');
      await page.getByRole('button', { name: 'Edit layout' }).click();
      await expect(objects.locator('option')).toHaveCount(1);
      expect(await show()).toEqual(cleared);
      expect(observe()).toEqual({
        identities: 0,
        blocks: 0,
        world: { revision: 2, layout: empty },
      });
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.screenshot({ path: info.outputPath('native-world-empty-restarted.png') });
    } finally {
      await office(['stop']);
    }
  });
});
