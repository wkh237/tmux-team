import { test as base, expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';

interface BrowserSession {
  context: BrowserContext;
  page: Page;
  requests: URL[];
}
const test = base.extend<{ openSession: (url?: string) => Promise<BrowserSession> }>({
  openSession: async ({ browser }, use) => {
    const sessions: BrowserSession[] = [];
    const unexpected: string[] = [];
    await use(async (url = 'http://127.0.0.1:4173') => {
      const context = await browser.newContext();
      const requests: URL[] = [];
      context.on('request', (request) => {
        requests.push(new URL(request.url()));
      });
      await context.route('**/*', async (route) => {
        const target = new URL(route.request().url());
        if (target.hostname === '127.0.0.1') return route.continue();
        // The official popup transport requires Google's public iframe library even
        // with Auth Emulator. No production auth/API endpoints are allowed.
        if (
          target.protocol === 'https:' &&
          target.hostname === 'apis.google.com' &&
          (target.pathname.startsWith('/js/') || target.pathname.startsWith('/_/scs/')) &&
          route.request().method() === 'GET' &&
          route.request().resourceType() === 'script'
        )
          return route.continue();
        // Firebase's emulator widget requests optional CDN presentation assets.
        // Block them, but do not stub its local authentication logic or responses.
        if (!['unpkg.com', 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(target.hostname)) {
          unexpected.push(target.origin + target.pathname);
        }
        await route.abort();
      });
      const page = await context.newPage();
      const session = { context, page, requests };
      sessions.push(session);
      await page.goto(url);
      return session;
    });
    for (const session of sessions) await session.context.close();
    expect(unexpected).toEqual([]);
  },
});

async function openPopup(page: Page): Promise<Page> {
  const opened = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Sign in with Google (emulator)' }).click();
  const popup = await opened;
  await expect(popup.getByRole('button', { name: 'Add new account' })).toBeVisible();
  return popup;
}

async function submitNewAccount(popup: Page, name: string): Promise<void> {
  await popup.getByRole('button', { name: 'Add new account' }).click();
  // The upstream emulator labels are not associated with inputs; use its stable IDs.
  await popup
    .locator('#email-input')
    .fill(`${name.toLowerCase()}-${crypto.randomUUID()}@example.test`);
  await popup.locator('#display-name-input').fill(name);
  await popup.getByRole('button', { name: 'Sign in with Google.com', exact: true }).click();
}

async function signIn(page: Page, name: string): Promise<void> {
  await submitNewAccount(await openPopup(page), name);
  await expect(page.getByText(`Signed in as ${name}`, { exact: true })).toBeVisible();
  await expect(page.getByText(/^UID: /)).toContainText(/UID: \S+/);
}

test('default build stays disconnected without Firebase requests', async ({ openSession }) => {
  const { page, requests } = await openSession('http://127.0.0.1:4174');
  await expect(page.getByRole('heading', { name: 'No world connected' })).toBeVisible();
  await page.getByRole('link', { name: 'Setup', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A private world' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Sign in/ })).toHaveCount(0);
  expect(requests.every((request) => request.origin === 'http://127.0.0.1:4174')).toBe(true);
});

test('real popup login is memory-only, tab-isolated and never implies world membership', async ({
  openSession,
}) => {
  const alice = await openSession();
  const bob = await openSession();
  await signIn(alice.page, 'Alice');
  const aliceUid = await alice.page.getByText(/^UID: /).textContent();
  await expect(bob.page.getByRole('button', { name: /Sign in/ })).toBeEnabled();
  await signIn(bob.page, 'Bob');
  expect(await bob.page.getByText(/^UID: /).textContent()).not.toBe(aliceUid);
  const tab = await alice.context.newPage();
  await tab.goto('http://127.0.0.1:4173');
  await expect(tab.getByRole('button', { name: /Sign in/ })).toBeEnabled();
  await alice.page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(alice.page.getByRole('button', { name: /Sign in/ })).toBeEnabled();
  await expect(bob.page.getByText('Signed in as Bob', { exact: true })).toBeVisible();
  await bob.page.reload();
  await expect(bob.page.getByRole('button', { name: /Sign in/ })).toBeEnabled();
  await expect(bob.page.getByText(/^UID: /)).toHaveCount(0);
  await expect(bob.page.getByRole('heading', { name: 'No world connected' })).toBeVisible();
  expect(
    alice.requests.some(
      (request) => request.port === '9099' && request.pathname.includes('signInWithIdp')
    )
  ).toBe(true);
});

test('closing the real popup clears pending state and permits another login', async ({
  openSession,
}) => {
  const { page } = await openSession();
  const button = page.getByRole('button', { name: /Sign in/ });
  const popup = await openPopup(page);
  await expect(button).toBeDisabled();
  await popup.close();
  // Firebase waits eight seconds after its two-second desktop close poll.
  await expect(page.getByRole('alert')).toHaveText('Sign-in cancelled. You can try again.', {
    timeout: 15_000,
  });
  await expect(button).toBeEnabled();
  await signIn(page, 'Retry');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('failed token exchange reports transport failure without inventing a session, then recovers', async ({
  openSession,
}) => {
  const { page, context } = await openSession();
  const exchange = '**/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp*';
  await context.route(exchange, (route) => route.abort('connectionrefused'));
  await submitNewAccount(await openPopup(page), 'Offline');
  await expect(page.getByRole('alert')).toHaveText(
    'Cannot reach the local Auth Emulator. Check that it is running, then try again.'
  );
  await expect(page.getByText(/^UID: /)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Sign in/ })).toBeEnabled();
  await context.unroute(exchange);
  await signIn(page, 'Recovered');
});

test('browser popup blocking produces an actionable error and releases the button', async ({
  openSession,
}) => {
  const { page } = await openSession();
  // Exercise the real SDK's blocked-window path, not a fabricated Firebase error.
  await page.evaluate(() => {
    window.open = () => null;
  });
  await page.getByRole('button', { name: /Sign in/ }).click();
  await expect(page.getByRole('alert')).toHaveText('Allow popups for this page, then try again.');
  await expect(page.getByRole('button', { name: /Sign in/ })).toBeEnabled();
  await expect(page.getByText(/^UID: /)).toHaveCount(0);
});
