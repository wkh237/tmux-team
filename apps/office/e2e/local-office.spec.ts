import { expect, test } from '@playwright/test';
import type { Request } from '@playwright/test';
import { builtinFurniture } from '../src/blocks/block-contract.js';

test('office overview enters an unfurnished room and saves through shared profile and block ports', async ({
  page,
}, testInfo) => {
  const token = 'a'.repeat(43);
  const blockId = '11111111-1111-4111-8111-111111111111';
  let revision = 0;
  let profileRevision = 0;
  let objects: ReturnType<typeof builtinFurniture>[] = [];
  let profile = {
    displayLabel: '',
    description: 'Architecture review',
    appearance: {
      hairStyle: 'curls',
      hairColor: 'silver',
      skinTone: 'deep',
      shirtColor: 'plum',
      shirtMark: 'AI',
    },
  };
  const catalog = {
    hairStyles: ['short', 'bob', 'curls', 'tied', 'bald'],
    hairColors: ['ink', 'brown', 'gold', 'silver'],
    skinTones: ['light', 'warm', 'medium', 'deep'],
    shirtColors: ['blue', 'green', 'clay', 'plum', 'gold', 'ink'],
  };
  const requests: string[] = [];
  let avatarCatalogRequests = 0;
  let extraRooms = false;
  page.on('request', (request) => requests.push(request.url()));
  await page.route('**/api/v1/local/avatar-catalog', async (route) => {
    expect(route.request().method()).toBe('GET');
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
    avatarCatalogRequests += 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ catalogRevision: 0, packs: [] }),
    });
  });
  await page.route('**/api/v1/local/profiles', async (route) => {
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([
        {
          identityId: '22222222-2222-4222-8222-222222222222',
          identityName: 'Alice',
          exists: profileRevision > 0,
          revision: profileRevision,
          profile,
          updatedAtMs: profileRevision || null,
          catalog,
          online: true,
        },
        ...(extraRooms
          ? [
              {
                identityId: '33333333-3333-4333-8333-333333333333',
                identityName: 'Bob',
                exists: false,
                revision: 0,
                profile: { ...profile, appearance: { ...profile.appearance, shirtColor: 'green' } },
                updatedAtMs: null,
                catalog,
                online: true,
              },
              {
                identityId: '44444444-4444-4444-8444-444444444444',
                identityName: 'Casey — Documentation and architecture',
                exists: false,
                revision: 0,
                profile,
                updatedAtMs: null,
                catalog,
                online: false,
              },
            ]
          : []),
      ]),
    });
  });
  await page.route(
    '**/api/v1/local/profiles/22222222-2222-4222-8222-222222222222',
    async (route) => {
      expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
      if (route.request().method() === 'PUT') {
        expect(route.request().headers().origin).toBe('http://127.0.0.1:4176');
        const input = route.request().postDataJSON();
        if (input.expectedRevision !== profileRevision)
          return route.fulfill({ status: 409, body: '{"error":"REVISION_CONFLICT"}' });
        profileRevision += 1;
        profile = input.profile;
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          identityId: '22222222-2222-4222-8222-222222222222',
          identityName: 'Alice',
          exists: profileRevision > 0,
          revision: profileRevision,
          profile,
          updatedAtMs: profileRevision || null,
          catalog,
          ...(route.request().method() === 'PUT' ? { changed: true } : {}),
        }),
      });
    }
  );
  await page.route('**/api/v1/local/blocks', async (route) => {
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(
        revision === 0
          ? []
          : [
              {
                exists: true,
                identityId: '22222222-2222-4222-8222-222222222222',
                identityName: 'Alice',
                blockId,
                revision,
                layout: { version: 2, objects },
                resolutions: objects.map((_, index) => ({
                  index,
                  status: 'available',
                  label: 'Desk',
                })),
                updatedAtMs: revision,
              },
            ]
      ),
    });
  });
  await page.route(
    '**/api/v1/local/identities/22222222-2222-4222-8222-222222222222/block',
    async (route) => {
      const request = route.request();
      expect(request.headers().authorization).toBe(`Bearer ${token}`);
      if (request.method() === 'PUT') {
        expect(request.headers().origin).toBe('http://127.0.0.1:4176');
        const input = request.postDataJSON();
        if (input.expectedRevision !== revision) {
          await route.fulfill({ status: 409, body: '{"error":"REVISION_CONFLICT"}' });
          return;
        }
        revision += 1;
        objects = input.layout.objects;
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          exists: revision > 0,
          identityId: '22222222-2222-4222-8222-222222222222',
          identityName: 'Alice',
          blockId: revision > 0 ? blockId : null,
          revision,
          layout: { version: 2, objects },
          resolutions: objects.map((_, index) => ({ index, status: 'available', label: 'Prop' })),
          updatedAtMs: revision,
          ...(request.method() === 'PUT' ? { changed: true } : {}),
        }),
      });
    }
  );

  await page.goto(`http://127.0.0.1:4176/local#token=${token}`);
  await expect(page).toHaveURL('http://127.0.0.1:4176/local');
  await expect(page.getByRole('heading', { name: 'Your office' })).toBeVisible();
  await expect(page.getByText('Unfurnished · not saved')).toBeVisible();
  expect(revision).toBe(0);
  expect(profileRevision).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('office-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('office-narrow.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('link', { name: "Enter Alice's room" }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Add desk' }).click();
  expect(revision).toBe(0);
  await page.getByRole('button', { name: 'Save layout' }).click();
  await expect(page.getByText('Avatar · default robot')).toBeVisible();
  await expect(page.getByText('Saved · revision 1')).toBeVisible();
  await expect(page.locator('.profile-preview .avatar-name')).toHaveText('Alice');
  await expect(page.locator('.profile-preview .avatar-mark')).toHaveText('AI');
  await page.getByLabel('Shirt mark').fill('UX');
  await page.getByRole('button', { name: 'Save appearance' }).click();
  await expect(page.getByText('Saved · revision 1')).toHaveCount(2);
  // Visual-only coverage uses this existing mocked port; durable profile
  // acceptance remains in native-local-profile.spec.ts with the real service.
  for (const hairStyle of catalog.hairStyles) {
    await page.getByLabel('Hair style').selectOption(hairStyle);
    const avatar = page.locator('.profile-preview .profile-avatar');
    await expect(avatar.locator('circle, path, image')).toHaveCount(0);
    await expect(avatar.locator('svg[shape-rendering="crispEdges"]')).toHaveCount(1);
    await expect(avatar.locator('.avatar-name')).toHaveText('Alice');
    await page.locator('.profile-preview').screenshot({
      path: testInfo.outputPath(`pixel-avatar-${hairStyle}.png`),
    });
  }
  await page.getByLabel('Hair style').selectOption('curls');
  await page.screenshot({ path: testInfo.outputPath('profile-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('profile-narrow.png'), fullPage: true });
  await page.getByRole('button', { name: 'Add plant' }).click();
  await page.getByRole('button', { name: 'Save layout' }).click();
  await expect(page.getByText('Saved · revision 2')).toBeVisible();
  expect(objects).toHaveLength(2);
  expect(profile.appearance.shirtMark).toBe('UX');
  // The Vite dev server mounts effects twice under StrictMode. Edits must not
  // trigger more catalog reads; the production companion verifier asserts one.
  expect(avatarCatalogRequests).toBe(4);
  await page.getByRole('link', { name: '← Back to office' }).click();
  await expect(page.getByText('2 pieces · saved')).toBeVisible();
  await expect(page.locator('.office-room .block-scene')).toBeVisible();
  extraRooms = true;
  await page.getByRole('button', { name: 'Refresh office' }).click();
  await expect(page.getByText('3 spaces · 2 online')).toBeVisible();
  await expect(page.locator('.office-room')).toHaveCount(3);
  await expect(
    page
      .getByRole('article', { name: "Casey — Documentation and architecture's room" })
      .locator('.profile-avatar')
  ).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: testInfo.outputPath('office-team-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('office-team-narrow.png'), fullPage: true });
  expect(requests.every((url) => new URL(url).hostname === '127.0.0.1')).toBe(true);
});

test('missing local session gives recoverable CLI guidance', async ({ page }) => {
  await page.goto('http://127.0.0.1:4176/local');
  await expect(page.getByRole('alert')).toHaveText(
    'Local Office could not initialize. Rerun tmt office start and reopen its URL.'
  );
});

test('offline board renders plain text and preserves owner edits, replies and moderation', async ({
  page,
}) => {
  const token = 'b'.repeat(43);
  const threadId = '11111111-1111-4111-8111-111111111111';
  const identityReplyId = '22222222-2222-4222-8222-222222222222';
  const ownerReplyId = '33333333-3333-4333-8333-333333333333';
  let revision = 1;
  let title = 'What we learned';
  let body = '<script>still plain text</script>';
  let identityReplyDeleted = false;
  let ownerReply: Record<string, unknown> | undefined;
  const category = { kind: 'general' };
  const owner = { kind: 'owner' };
  const entry = () => ({
    id: threadId,
    threadId,
    category,
    author: owner,
    revision,
    deleted: false,
    createdAtMs: 1,
    updatedAtMs: revision,
    title,
    body,
  });
  const replies = () => [
    {
      id: identityReplyId,
      threadId,
      category,
      author: {
        kind: 'identity',
        identityId: '44444444-4444-4444-8444-444444444444',
        name: 'Alice',
      },
      revision: identityReplyDeleted ? 2 : 1,
      deleted: identityReplyDeleted,
      createdAtMs: 2,
      updatedAtMs: identityReplyDeleted ? 4 : 2,
      ...(identityReplyDeleted ? {} : { body: 'Please document the edge case.' }),
    },
    ...(ownerReply ? [ownerReply] : []),
  ];
  const authorized = (request: Request) => {
    expect(request.headers().authorization).toBe(`Bearer ${token}`);
    expect(request.headers().origin).toBe('http://127.0.0.1:4176');
  };
  await page.route('**/api/v1/local/board/categories/list', async (route) => {
    authorized(route.request());
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ categories: [category], nextCursor: null, boardRevision: revision }),
    });
  });
  await page.route('**/api/v1/local/board/threads/list', async (route) => {
    authorized(route.request());
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        threads: [
          {
            ...entry(),
            body: undefined,
            replyCount: replies().filter((reply) => !reply.deleted).length,
            activitySequence: revision,
          },
        ],
        nextCursor: null,
        boardRevision: revision,
      }),
    });
  });
  await page.route('**/api/v1/local/board/threads/show', async (route) => {
    authorized(route.request());
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        thread: entry(),
        replies: replies(),
        nextCursor: null,
        boardRevision: revision,
      }),
    });
  });
  await page.route(`**/api/v1/local/board/entries/${threadId}`, async (route) => {
    authorized(route.request());
    expect(route.request().method()).toBe('PUT');
    const input = route.request().postDataJSON();
    expect(input.actor).toBeUndefined();
    title = input.title;
    body = input.body;
    revision += 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        entryId: threadId,
        revision,
        changed: true,
        operationId: input.operationId,
      }),
    });
  });
  await page.route(`**/api/v1/local/board/threads/${threadId}/replies`, async (route) => {
    authorized(route.request());
    const input = route.request().postDataJSON();
    ownerReply = {
      id: ownerReplyId,
      threadId,
      category,
      author: owner,
      revision: 1,
      deleted: false,
      createdAtMs: 3,
      updatedAtMs: 3,
      body: input.body,
    };
    revision += 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        entryId: ownerReplyId,
        threadId,
        revision: 1,
        created: true,
        operationId: input.operationId,
      }),
    });
  });
  await page.route(`**/api/v1/local/board/entries/${identityReplyId}`, async (route) => {
    authorized(route.request());
    const input = route.request().postDataJSON();
    expect(input.moderate).toBe(true);
    identityReplyDeleted = true;
    revision += 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        entryId: identityReplyId,
        revision: 2,
        deleted: true,
        changed: true,
        moderated: true,
        operationId: input.operationId,
      }),
    });
  });

  await page.goto(`http://127.0.0.1:4176/local/board#token=${token}`);
  await expect(page).toHaveURL('http://127.0.0.1:4176/local/board');
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByText('<script>still plain text</script>')).toBeVisible();
  expect(await page.locator('.board-body script').count()).toBe(0);

  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Message').first().fill('Updated owner note');
  await page.getByRole('button', { name: 'Save edit' }).click();
  await expect(page.getByRole('button', { name: 'Save edit' })).toBeHidden();
  await expect(
    page.locator('.board-entry').first().getByText('Updated owner note', { exact: true })
  ).toBeVisible();

  const replyForm = page.locator('.board-reply-form');
  await replyForm.getByRole('textbox', { name: 'Message' }).fill('Owner follow-up');
  await replyForm.getByRole('button', { name: 'Reply as owner' }).click();
  await expect(page.getByText('Owner follow-up')).toBeVisible();

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Moderate delete' }).click();
  await expect(page.getByText('Deleted entry')).toBeVisible();

  await page.goto(`http://127.0.0.1:4176/local/board#token=${token}`);
  await expect(page.getByText('Updated owner note')).toBeVisible();
  await expect(page.getByText('Owner follow-up')).toBeVisible();
});
