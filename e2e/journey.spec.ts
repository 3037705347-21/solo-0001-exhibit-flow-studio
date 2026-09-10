import { test, expect } from '@playwright/test';

test('place an object into a journey zone', async ({ page }) => {
  await page.goto('/journey');
  const queueItem = page.getByRole('button', { name: /Conservator’s Gloves/ });
  await queueItem.click();
  await page
    .getByRole('button', { name: /Place Conservator’s Gloves here/ })
    .first()
    .click();
  await expect(page.getByText('Conservator’s Gloves').first()).toBeVisible();
});
