import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { runCli, withSandbox } from '../../../test/support/cli-process.js';
import { installNativeOffice, unusedLoopbackPort } from './native-office-fixture.js';
import type { WorldSnapshot } from '../src/world-map/world-port.js';
import { fitWorldCoordinates } from './world-editor-gesture.js';

test('converts retained walls to platforms only after Save and keeps canvas gestures', async ({
  page,
}, info) => {
  await withSandbox(async (sandbox) => {
    const prefix = await installNativeOffice(sandbox);
    async function office<T>(args: string[]): Promise<T> {
      const result = await runCli(sandbox, ['office', '--prefix', prefix, ...args, '--json']);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      return JSON.parse(result.stdout) as T;
    }
    const fresh = await office<WorldSnapshot>(['layout', 'show']);
    expect(fresh.layout.map.version).toBe(6);
    expect(fresh.layout.objects.every((object) => object.surface.type === 'floor')).toBe(true);
    if (fresh.layout.map.version === 1) throw new Error('Expected modular starter');
    const mountedId = fresh.layout.objects.find((object) => !object.extension)!.id;
    const retained = {
      ...fresh.layout,
      map: { ...fresh.layout.map, version: 5 as const },
      objects: fresh.layout.objects.map((object) =>
        object.id === mountedId
          ? {
              ...object,
              placement: { ...object.placement, x: 4, y: 0 },
              surface: {
                type: 'wall' as const,
                axis: 'horizontal' as const,
                face: 'positive' as const,
                elevation: 0,
              },
            }
          : object
      ),
    };
    const file = path.join(sandbox.root, 'retained-layout.json');
    writeFileSync(file, JSON.stringify(retained));
    await office([
      'layout',
      'apply',
      '--file',
      file,
      '--if-revision',
      String(fresh.revision),
      '--legacy-basis',
      fresh.legacyBasis!,
    ]);
    const before = await office<WorldSnapshot>(['layout', 'show']);
    const started = await office<{ url: string }>([
      'start',
      '--port',
      String(await unusedLoopbackPort()),
    ]);
    try {
      await page.setViewportSize({ width: 1536, height: 1024 });
      await page.goto(started.url);
      await expect(page.locator('.office-map')).toHaveAttribute('data-scene-ready', 'true');
      await page.getByRole('button', { name: 'Edit layout', exact: true }).click();
      const inspector = page.getByRole('complementary', { name: 'Layout tools' });
      await expect(inspector.getByRole('toolbar', { name: 'Build tools' })).toBeVisible();
      const bounds = await inspector.boundingBox();
      expect(bounds!.x).toBeGreaterThan(1000);
      await inspector.getByRole('button', { name: 'Preview platforms' }).click();
      await expect(inspector.getByRole('button', { name: 'Preview platforms' })).toHaveCount(0);
      await expect(inspector.getByRole('button', { name: 'Walls', exact: true })).toHaveCount(0);
      expect(await office<WorldSnapshot>(['layout', 'show'])).toEqual(before);
      await page.screenshot({ path: info.outputPath('skybridge-preview.png') });
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      expect(await office<WorldSnapshot>(['layout', 'show'])).toEqual(before);
      await page.getByRole('button', { name: 'Edit layout', exact: true }).click();
      await inspector.getByRole('button', { name: 'Preview platforms' }).click();
      await page.getByRole('button', { name: 'Save layout', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Edit layout', exact: true })).toBeVisible();
      const saved = await office<WorldSnapshot>(['layout', 'show']);
      expect(saved.layout.map.version).toBe(6);
      expect(
        saved.layout.objects.map(({ id, placement, extension }) => ({ id, placement, extension }))
      ).toEqual(
        before.layout.objects.map(({ id, placement, extension }) => ({ id, placement, extension }))
      );
      expect(saved.layout.objects.every((object) => object.surface.type === 'floor')).toBe(true);
      // The initial token fragment is consumed; reopen the authenticated URL.
      await page.goto('about:blank');
      await page.goto(started.url);
      await expect(page.locator('.office-map')).toHaveAttribute('data-scene-ready', 'true');
      await page.screenshot({ path: info.outputPath('skybridge-saved.png') });
      expect((await office<WorldSnapshot>(['layout', 'show'])).layout).toEqual(saved.layout);
      // Independent v6 fixture framing: the eastern ghost ends at X=184;
      // Four-unit framing margins have no rear-wall reserve on platforms.
      const point = await fitWorldCoordinates(page, { x: -4, y: -46, width: 192, height: 173 });
      const ghost = point(160, 17.5);
      const creation = page.getByRole('region', { name: 'Create meeting space', exact: true });
      await expect(page.locator('.meeting-entry')).toHaveCount(0);
      await page.mouse.move(ghost.x, ghost.y);
      await page.mouse.down();
      await page.mouse.move(ghost.x + 180, ghost.y - 120, { steps: 6 });
      await page.mouse.up();
      await expect(creation).toHaveCount(0);
      await page.mouse.wheel(24, 32);
      const canvas = page.locator('.office-canvas canvas');
      await canvas.dispatchEvent('wheel', {
        deltaX: 0,
        deltaY: -20,
        deltaMode: 0,
        ctrlKey: true,
        clientX: 400,
        clientY: 400,
      });
      await expect(creation).toHaveCount(0);
      // The canvas-owned target follows pan and pinch. A click at its new
      // position must open the form; a drag over the same target must not.
      await page.mouse.click(
        400 + (ghost.x + 180 - 24 - 400) * Math.exp(0.2),
        400 + (ghost.y - 120 - 32 - 400) * Math.exp(0.2)
      );
      await expect(creation.getByRole('textbox', { name: 'Room name', exact: true })).toBeFocused();
      expect((await office<WorldSnapshot>(['layout', 'show'])).layout).toEqual(saved.layout);
      await creation
        .getByRole('textbox', { name: 'Room name', exact: true })
        .fill('Platform review');
      await creation.getByRole('button', { name: 'Save room', exact: true }).click();
      await page.getByRole('button', { name: 'Save layout', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Edit layout', exact: true })).toBeVisible();
      const furnished = await office<WorldSnapshot>(['layout', 'show']);
      expect(furnished.layout.objects).toHaveLength(saved.layout.objects.length + 9);
      expect(furnished.layout.objects.every((object) => object.surface.type === 'floor')).toBe(
        true
      );
    } finally {
      await page.goto('about:blank');
      await office(['stop']);
    }
  });
});
