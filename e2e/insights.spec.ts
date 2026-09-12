import { test, expect } from '@playwright/test';

test('compare and apply a visitor scenario', async ({ page }) => {
  await page.goto('/insights');
  await page.getByRole('button', { name: 'Leisurely' }).click();
  await page.getByLabel('Group size').fill('12');
  await expect(page.getByRole('heading', { name: 'Leisurely visit' })).toBeVisible();
  await page.getByRole('button', { name: 'Apply preferences' }).click();
  await expect(page.getByText('Planning preferences applied.')).toBeVisible();
});
