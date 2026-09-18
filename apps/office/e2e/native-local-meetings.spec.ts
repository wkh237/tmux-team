import { mapGeometry } from '../src/world-map/map-source.js';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from '@playwright/test';
import { withSandbox } from '../../../test/support/cli-process.js';
import { withE2EFixture } from '../../../test/e2e/harness.js';
import { installNativeOffice, unusedLoopbackPort } from './native-office-fixture.js';
import { openOfficeDirectory } from './office-navigation.js';
import type { MeetingRoom } from '../src/local/room-contract.js';
import type { WorldSnapshot } from '../src/world-map/world-port.js';
import type { WorldDocument } from '../src/world-map/world-contract.js';

test('real private-tmux identities project into multiple meetings without moving homes or copying membership', async ({
  page,
}, info) => {
  await withSandbox(async (sandbox) => {
    const prefix = await installNativeOffice(sandbox);
    await withE2EFixture(
      async (fixture) => {
        async function cli<T>(args: string[]): Promise<T> {
          const result = await fixture.runJsonCli<T>(args);
          expect(result.code, result.stdout + result.stderr).toBe(0);
          expect(result.json).toBeDefined();
          return result.json!;
        }
        const office = <T>(args: string[]) => cli<T>(['office', '--prefix', prefix, ...args]);
        const room = async (args: string[]) =>
          (await cli<{ room: MeetingRoom }>(['room', ...args])).room;
        const alicePane = await fixture.createMockPane('alice');
        const contractorPane = await fixture.createMockPane('contractor');
        const alice = await cli<{ id: string }>(['add', alicePane.pane, 'Alice', '-s']);
        const contractor = await cli<{ id: string; lifetime: string }>([
          'add',
          contractorPane.pane,
          'Contractor',
        ]);
        expect(contractor.lifetime).toBe('temporary');
        const online = [
          { ...alice, name: 'Alice' },
          { ...contractor, name: 'Contractor' },
        ];
        for (let index = 1; index <= 7; index++) {
          const name = `Guest ${index}`;
          const pane = await fixture.createMockPane(`guest-${index}`);
          const identity = await cli<{ id: string }>(['add', pane.pane, name, '-s']);
          online.push({ ...identity, name });
        }
        online.sort((a, b) => a.id.localeCompare(b.id));
        const shared = online[0]!;
        await cli(['identity', 'create', 'Offline']);
        const design = await room(['create', 'Design review']);
        const planning = await room(['create', 'Planning']);
        for (const name of [...online.map((identity) => identity.name), 'Offline'])
          await room(['join', design.id, '--identity', name]);
        await room(['join', planning.id, '--identity', shared.name]);
        const rosters = [await room(['show', design.id]), await room(['show', planning.id])];
        const initial = await office<WorldSnapshot>(['layout', 'show']);
        const lobbyId = initial.layout.map.primaryLobbyId;
        const areaA = '70000000-0000-4000-8000-000000000001';
        const areaB = '70000000-0000-4000-8000-000000000002';
        const layout: WorldDocument = {
          version: 1,
          objects: [],
          map: {
            version: 1,
            primaryLobbyId: lobbyId,
            areas: [
              { id: lobbyId, name: 'Lobby', binding: { type: 'lobby' } },
              { id: areaA, name: 'West meeting', binding: { type: 'meeting', roomId: design.id } },
              {
                id: areaB,
                name: 'East meeting',
                binding: { type: 'meeting', roomId: planning.id },
              },
            ],
            floor: Array.from({ length: 36 }, (_, y) =>
              [lobbyId, areaA, areaB].map((areaId, index) => ({
                y,
                start: index * 36,
                end: (index + 1) * 36,
                areaId,
              }))
            ).flat(),
            doors: [36, 72].map((x) => ({ x, y: 16, axis: 'vertical' as const })),
          },
        };
        const file = path.join(sandbox.root, 'meeting-world.json');
        writeFileSync(file, JSON.stringify(layout));
        const saved = await office<WorldSnapshot>([
          'layout',
          'apply',
          '--file',
          file,
          '--if-revision',
          '0',
          '--legacy-basis',
          initial.legacyBasis!,
        ]);
        expect(saved.layout).toEqual(layout);
        const stored = () => {
          const db = new Database(sandbox.database, { readonly: true });
          try {
            return {
              identities: db.prepare('SELECT count(*) FROM identities').pluck().get(),
              world: db
                .prepare('SELECT layout_revision, layout_json FROM office_local_worlds')
                .get(),
            };
          } finally {
            db.close();
          }
        };
        const before = stored();
        expect(before.identities).toBe(10);
        // Allocate explicit fixture ports; never reuse the user's preview service.
        const launch = async () =>
          office<{ url: string }>(['start', '--port', String(await unusedLoopbackPort())]);
        let started = await launch();
        try {
          await page.setViewportSize({ width: 1440, height: 1000 });
          const enter = async () => {
            await page.goto(started.url);
            await expect(page.locator('.office-map')).toHaveAttribute('data-scene-ready', 'true');
          };
          const openArea = async (name: string) => {
            await openOfficeDirectory(page);
            await page.getByRole('button', { name: new RegExp(`^${name} · meeting`) }).click();
            return page.getByRole('region', { name: 'Area roster' });
          };
          await enter();
          await openOfficeDirectory(page);
          const directory = page.getByRole('complementary', { name: 'Office directory' });
          await expect(
            directory.getByRole('button', {
              name: 'Alice · Online Unassigned · Lobby',
              exact: true,
            })
          ).toBeVisible();
          await expect(
            directory.getByRole('button', {
              name: 'Contractor · Online Contractor · Lobby',
              exact: true,
            })
          ).toBeVisible();
          await directory.getByRole('button', { name: 'Lobby · lobby', exact: true }).click();
          await expect(page.getByRole('heading', { name: 'Residents · 10' })).toBeVisible();
          let roster = await openArea('West meeting');
          await expect(roster.getByRole('heading', { name: 'Members · 10' })).toBeVisible();
          await expect(roster.getByRole('button')).toHaveCount(10);
          for (const identity of online)
            await expect(
              roster.getByRole('button', { name: new RegExp(`^${identity.name} · Online`) })
            ).toBeVisible();
          await expect(
            roster.getByRole('button', { name: 'Alice · Online', exact: true })
          ).toBeVisible();
          await expect(
            roster.getByRole('button', { name: 'Contractor · Online Contractor', exact: true })
          ).toBeVisible();
          await expect(
            roster.getByRole('button', { name: 'Offline · Offline', exact: true })
          ).toBeVisible();
          await roster.getByRole('searchbox', { name: 'Search members' }).fill('offline');
          await expect(roster.getByRole('button')).toHaveCount(1);
          await roster.getByRole('button', { name: 'Offline · Offline', exact: true }).click();
          await expect(
            page.getByText('Viewing in Design review. Membership is independent of the home area.')
          ).toBeVisible();
          await expect(page.getByRole('button', { name: 'Message Offline' })).toBeVisible();
          await page.getByRole('button', { name: 'Close agent conversation' }).click();

          // Independent fixture: three empty 36x36 areas, 5/8 floor depth,
          // 16-high walls, bounds (-4,-20,116,50.5), and 84% Fit framing.
          // This floor fits three previews (center, left, right), not all nine online members.
          // Larger open areas exercise the six-preview ceiling in geometry tests.
          const viewport = (await page.locator('.office-canvas').boundingBox())!;
          const scale = Math.min(viewport.width / 116, viewport.height / 50.5) * 0.84;
          const point = (x: number, y: number) => ({
            x: viewport.x + (viewport.width - 116 * scale) / 2 + (x + 4) * scale,
            y: viewport.y + (viewport.height - 50.5 * scale) / 2 + (y + 20) * scale,
          });
          const previews = [54, 44, 64].map((x, index) => ({
            x,
            name: online[index]!.name,
            meeting: 'Design review',
          }));
          previews.push({ x: 90, name: shared.name, meeting: 'Planning' });
          for (const { x, name, meeting } of previews) {
            const target = point(x, 11.25);
            await page.mouse.click(target.x, target.y);
            await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible();
            await expect(
              page.getByText(`Room: ${meeting}. Only ${name} receives this message.`)
            ).toBeVisible();
            await expect(page.locator('.agent-hud-host')).toHaveAttribute('data-anchored', 'true');
            const conversation = page.getByRole('dialog', { name: 'Agent conversation' });
            const conversationBounds = (await conversation.boundingBox())!;
            // An empty chat stays below the populated HUD's 440px height and
            // keeps its composer on screen, including the room-context line.
            expect(conversationBounds.height).toBeLessThan(440);
            expect(conversationBounds.y).toBeGreaterThanOrEqual(0);
            expect(conversationBounds.y + conversationBounds.height).toBeLessThanOrEqual(
              page.viewportSize()!.height
            );
            await expect(
              conversation.getByRole('button', { name: 'Send', exact: true })
            ).toBeInViewport();
            const anchor = page.locator('.agent-hud-host');
            const beforeZoom = await anchor.getAttribute('style');
            await page.getByRole('button', { name: 'Zoom in' }).click();
            await expect.poll(() => anchor.getAttribute('style')).not.toBe(beforeZoom);
            await page.screenshot({ path: info.outputPath(`agent-anchor-${x}.png`) });
            await page.getByRole('button', { name: 'Fit office' }).click();
            await page.getByRole('button', { name: 'Close agent conversation' }).click();
          }
          // Legacy fixture floor is 36 * 5/8 = 22.5 scene units deep.
          // Click above the actor previews, not beyond the room's front wall.
          const emptyFloor = point(54, 5);
          await page.mouse.click(emptyFloor.x, emptyFloor.y);
          await expect(page.getByRole('complementary', { name: 'Area details' })).toBeVisible();
          await expect(page.getByRole('heading', { name: 'Members · 10' })).toBeVisible();
          await page.getByRole('button', { name: 'Close details' }).click();
          await page.screenshot({ path: info.outputPath('meeting-projections-native.png') });
          roster = await openArea('East meeting');
          await expect(roster.getByRole('heading', { name: 'Members · 1' })).toBeVisible();
          await page.setViewportSize({ width: 390, height: 844 });
          expect(
            await roster.evaluate((element) => element.scrollWidth <= element.clientWidth)
          ).toBe(true);
          await expect(
            roster.getByRole('button', { name: new RegExp(`^${shared.name} · Online`) })
          ).toBeInViewport();
          await page.screenshot({ path: info.outputPath('meeting-roster-narrow.png') });
          expect(stored()).toEqual(before);

          // Promotion changes eligibility, not UUID, meeting membership or terrain.
          const promoted = await cli<{ id: string; lifetime: string }>([
            'add',
            contractorPane.pane,
            'Contractor',
            '-s',
          ]);
          expect(promoted).toMatchObject({ id: contractor.id, lifetime: 'saved' });
          fixture.tmux(['kill-pane', '-t', alicePane.pane]);
          await office(['stop']);
          started = await launch();
          await page.setViewportSize({ width: 1440, height: 1000 });
          await enter();
          roster = await openArea('West meeting');
          await expect(
            roster.getByRole('button', { name: 'Alice · Offline', exact: true })
          ).toBeVisible();
          await expect(
            roster.getByRole('button', { name: 'Contractor · Online', exact: true })
          ).toBeVisible();
          expect([await room(['show', design.id]), await room(['show', planning.id])]).toEqual(
            rosters
          );
          expect((await office<WorldSnapshot>(['layout', 'show'])).layout).toEqual(layout);

          // Detaching a spatial area preserves the canonical room and its complete roster.
          const detached = {
            ...layout,
            map: {
              ...mapGeometry(layout.map),
              areas: mapGeometry(layout.map).areas.filter((area) => area.id !== areaA),
              floor: mapGeometry(layout.map).floor.map((row) =>
                row.areaId === areaA ? { ...row, areaId: null } : row
              ),
            },
          };
          writeFileSync(file, JSON.stringify(detached));
          await office(['layout', 'apply', '--file', file, '--if-revision', '1']);
          await page.getByRole('button', { name: 'Refresh office' }).click();
          await expect(page.locator('.office-map')).toHaveAttribute('data-scene-ready', 'true');
          await openOfficeDirectory(page);
          await expect(page.getByRole('button', { name: /^West meeting · meeting/ })).toHaveCount(
            0
          );
          await expect(page.getByRole('button', { name: /^East meeting · meeting/ })).toBeVisible();
          expect([await room(['show', design.id]), await room(['show', planning.id])]).toEqual(
            rosters
          );
          expect((await office<WorldSnapshot>(['layout', 'show'])).layout).toEqual(detached);
          expect(stored().identities).toBe(10);
        } finally {
          await office(['stop']);
        }
      },
      { globalDir: sandbox.globalDir }
    );
  });
});
