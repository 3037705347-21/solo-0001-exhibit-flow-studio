import { test, expect } from '@playwright/test';

test('advance a review finding and run readiness check', async ({ page }) => {
  await page.goto('/review');
  await page.getByRole('button', { name: 'Start work' }).first().click();
  await expect(page.getByRole('button', { name: 'In Progress' })).toBeVisible();
  await page.getByRole('button', { name: 'Resolve' }).first().click();
  await page.getByRole('button', { name: 'Run readiness check' }).click();
  await expect(page.getByText(/Still needs attention|Ready to share/)).toBeVisible();
});
