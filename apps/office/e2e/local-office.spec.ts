import { expect, test } from '@playwright/test';
import type { Request } from '@playwright/test';

test('offline local composition renders and conditionally edits the shared block port', async ({
  page,
}) => {
  const token = 'a'.repeat(43);
  const blockId = '11111111-1111-4111-8111-111111111111';
  let revision = 1;
  let objects = [{ asset: 'desk', x: 4, y: 6, rotation: 0 }];
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.route('**/api/v1/local/blocks', async (route) => {
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([
        {
          exists: true,
          identityId: '22222222-2222-4222-8222-222222222222',
          identityName: 'Alice',
          blockId,
          revision,
          objects,
          updatedAtMs: revision,
        },
      ]),
    });
  });
  await page.route(`**/api/v1/local/blocks/${blockId}`, async (route) => {
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
      objects = input.objects;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        exists: true,
        identityId: '22222222-2222-4222-8222-222222222222',
        identityName: 'Alice',
        blockId,
        revision,
        objects,
        updatedAtMs: revision,
      }),
    });
  });

  await page.goto(`http://127.0.0.1:4176/local#token=${token}`);
  await expect(page).toHaveURL('http://127.0.0.1:4176/local');
  await expect(page.getByRole('heading', { name: 'Your local office' })).toBeVisible();
  await expect(page.getByText('Saved · revision 1')).toBeVisible();
  await page.getByRole('button', { name: 'Add plant' }).click();
  await page.getByRole('button', { name: 'Save layout' }).click();
  await expect(page.getByText('Saved · revision 2')).toBeVisible();
  expect(objects).toHaveLength(2);
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
