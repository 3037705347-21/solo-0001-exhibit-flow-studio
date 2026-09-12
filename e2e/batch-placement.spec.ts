import { test, expect } from '@playwright/test';

test('batch place queued objects as one transaction', async ({ page }) => {
  await page.goto('/journey');
  await page.getByRole('button', { name: 'Batch place' }).click();
  await page.getByLabel(/Zone for Conservator’s Gloves/).selectOption('zone-arrival');
  const apply = page.getByRole('button', { name: /Apply batch \(1\)/ });
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(page.getByText(/Batch placement applied/)).toBeVisible();
  await expect(page.getByText('Queue is clear')).toBeVisible();
  await expect(page.locator('.placement-info strong', { hasText: 'Conservator’s Gloves' })).toBeVisible();
});

test('cancelling a staged batch leaves the queue untouched', async ({ page }) => {
  await page.goto('/journey');
  await page.getByRole('button', { name: 'Batch place' }).click();
  await page.getByLabel(/Zone for Conservator’s Gloves/).selectOption('zone-patterns');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: /Conservator’s Gloves/ })).toBeVisible();
  await expect(page.locator('.placement-info strong', { hasText: 'Conservator’s Gloves' })).toHaveCount(0);
});
