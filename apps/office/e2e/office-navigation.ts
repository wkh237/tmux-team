import type { Page } from '@playwright/test';

/** Open the accessible directory without toggling an already-open panel closed. */
export async function openOfficeDirectory(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: /^Directory · / });
  await toggle.waitFor({ state: 'visible' });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

/** Select an identity in the world HUD, including saved agents without a personal area. */
export async function openAgentDetails(page: Page, name: string): Promise<void> {
  await openOfficeDirectory(page);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await page
    .getByRole('button', { name: new RegExp(`^${escaped} · (Online|Offline|Presence unknown)`) })
    .click();
}

/** Expose accessible object actions without changing the camera or activating one. */
export async function openOfficeObjects(page: Page): Promise<void> {
  await openOfficeDirectory(page);
  await page.getByRole('button', { name: 'Lobby · lobby', exact: true }).click();
}
