import { writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { createServer } from 'node:net';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { runCli, withSandbox } from '../../../test/support/cli-process.js';
import { installNativeOffice } from './native-office-fixture.js';

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Could not reserve a loopback port.');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
}

async function verifyEmbeddedAssets(sessionUrl: string): Promise<void> {
  const index = await fetch(sessionUrl);
  expect(index.ok).toBe(true);
  const html = await index.text();
  const source = html.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];
  if (!source) throw new Error('Embedded Office index has no module asset.');
  const result = await new Promise<{ declared: number; received: number; complete: boolean }>(
    (resolve, reject) => {
      const request = get(new URL(source, sessionUrl), (response) => {
        let received = 0;
        response.on('data', (chunk: Buffer) => (received += chunk.byteLength));
        response.on('end', () =>
          resolve({
            declared: Number(response.headers['content-length']),
            received,
            complete: response.complete,
          })
        );
        response.on('aborted', () =>
          resolve({
            declared: Number(response.headers['content-length']),
            received,
            complete: false,
          })
        );
      });
      request.on('error', reject);
    }
  );
  expect(result).toEqual({ declared: result.declared, received: result.declared, complete: true });
}

test('real local CLI profile reaches SQLite, browser and service restart', async ({
  browser,
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  await withSandbox(async (sandbox) => {
    const prefix = await installNativeOffice(sandbox);
    const identity = await runCli(sandbox, ['identity', 'create', 'Alice', '--json']);
    expect(identity.status, identity.stdout).toBe(0);
    const profileFile = path.join(sandbox.root, 'profile.json');
    writeFileSync(
      profileFile,
      JSON.stringify({
        displayLabel: 'Architecture',
        description: '<script>plain text only</script>',
        appearance: {
          hairStyle: 'tied',
          hairColor: 'gold',
          skinTone: 'warm',
          shirtColor: 'green',
          shirtMark: 'AI',
        },
      })
    );
    const layoutFile = path.join(sandbox.root, 'layout.json');
    writeFileSync(
      layoutFile,
      JSON.stringify({ objects: [{ asset: 'desk', x: 3, y: 5, rotation: 0 }] })
    );
    const office = (args: string[]) =>
      runCli(sandbox, ['office', '--prefix', prefix, ...args, '--json'], { deadlineMs: 30_000 });
    const shown = await office(['profile', 'show', '--local', '--identity', 'Alice']);
    expect(shown.status, shown.stdout).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({
      exists: false,
      revision: 0,
      identityName: 'Alice',
    });
    const applied = await office([
      'profile',
      'apply',
      '--local',
      '--identity',
      'Alice',
      '--file',
      profileFile,
      '--if-revision',
      '0',
    ]);
    expect(applied.status, applied.stdout).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      exists: true,
      revision: 1,
      profile: { displayLabel: 'Architecture' },
    });
    const block = await office([
      'block',
      'apply',
      '--local',
      '--identity',
      'Alice',
      '--file',
      layoutFile,
      '--if-revision',
      '0',
    ]);
    expect(block.status, block.stdout).toBe(0);
    const initialDiagnostics: Array<Promise<string>> = [];
    page.on('pageerror', (error) =>
      initialDiagnostics.push(Promise.resolve(`pageerror: ${error.message}`))
    );
    page.on('requestfailed', (request) =>
      initialDiagnostics.push(
        Promise.resolve(
          `requestfailed: ${request.url()} ${request.failure()?.errorText ?? 'unknown'}`
        )
      )
    );
    page.on('response', (response) => {
      if (response.url().includes('/api/v1/local/profiles'))
        initialDiagnostics.push(
          response.text().then((body) => `profiles: ${response.status()} ${body}`)
        );
      else if (!response.ok())
        initialDiagnostics.push(
          Promise.resolve(`response: ${response.status()} ${response.url()}`)
        );
    });
    let started = await office(['start']);
    expect(started.status, started.stdout).toBe(0);
    const initialUrl = JSON.parse(started.stdout).url;
    try {
      await verifyEmbeddedAssets(initialUrl);
    } catch (cause) {
      const status = await office(['status']);
      throw new Error(`Embedded asset failed; Office status: ${status.stdout}`, { cause });
    }
    await page.goto(initialUrl);
    await page.screenshot({ path: testInfo.outputPath('native-profile-initial.png') });
    try {
      await expect(page.locator('.profile-preview .avatar-name')).toHaveText('Alice');
    } catch (error) {
      await testInfo.attach('native-profile-initial-diagnostics', {
        body: Buffer.from(
          `${(await Promise.all(initialDiagnostics)).join('\n')}\n${await page.locator('body').innerText()}`
        ),
        contentType: 'text/plain',
      });
      throw error;
    }
    await expect(page.locator('.profile-preview .avatar-mark')).toHaveText('AI');
    await expect(page.getByLabel('Description')).toHaveValue('<script>plain text only</script>');
    expect(await page.locator('script').count()).toBeGreaterThan(0);
    expect(await page.locator('.profile-editor script').count()).toBe(0);
    await expect(page.getByText(/Offline —/)).toBeVisible();
    await expect(page.locator('.block-scene .avatar-name')).toHaveCount(0);
    // Reopen in a fresh browser context after the service restart. This also
    // discards the previous origin's connection pool and revoked token.
    await page.close();
    expect((await office(['stop'])).status).toBe(0);
    started = await office(['start', '--port', String(await unusedLoopbackPort())]);
    expect(started.status, started.stdout).toBe(0);
    const restartedContext = await browser.newContext();
    const restartedPage = await restartedContext.newPage();
    const restartDiagnostics: string[] = [];
    restartedPage.on('pageerror', (error) =>
      restartDiagnostics.push(`pageerror: ${error.message}`)
    );
    restartedPage.on('requestfailed', (request) =>
      restartDiagnostics.push(
        `requestfailed: ${request.url()} ${request.failure()?.errorText ?? 'unknown'}`
      )
    );
    restartedPage.on('response', (response) => {
      if (!response.ok())
        restartDiagnostics.push(`response: ${response.status()} ${response.url()}`);
    });
    const restartedUrl = JSON.parse(started.stdout).url;
    await verifyEmbeddedAssets(restartedUrl);
    const restartedResponse = await restartedPage.goto(restartedUrl);
    expect(restartedResponse?.ok()).toBe(true);
    try {
      await expect(restartedPage.getByRole('heading', { name: 'Your local office' })).toBeVisible();
    } catch (error) {
      await testInfo.attach('native-profile-restart-diagnostics', {
        body: Buffer.from(
          `${restartDiagnostics.join('\n')}\n${(await restartedPage.content()).slice(0, 4096)}`
        ),
        contentType: 'text/plain',
      });
      throw error;
    }
    await expect(restartedPage.locator('.profile-preview .avatar-mark')).toHaveText('AI');
    await restartedPage.screenshot({ path: testInfo.outputPath('native-profile-restart.png') });
    await restartedContext.close();
    expect(
      JSON.parse((await office(['profile', 'show', '--local', '--identity', 'Alice'])).stdout)
    ).toMatchObject({ revision: 1 });
    expect((await office(['stop'])).status).toBe(0);
  });
});
