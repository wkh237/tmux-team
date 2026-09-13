import { expect, test } from '@playwright/test';

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
