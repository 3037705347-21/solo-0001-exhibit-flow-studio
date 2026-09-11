import { test, expect } from '@playwright/test';

test('lead sign-off gates publishing and must be renewed after plan changes', async ({ page }) => {
  await page.goto('/review');

  // Resolve the critical finding so the readiness check can pass.
  await page.getByRole('button', { name: 'Resolve', exact: true }).first().click();
  await page.getByRole('button', { name: 'Run readiness check' }).click();
  await expect(page.getByText('Ready to share')).toBeVisible();

  // Publishing stays locked until a lead signs off.
  await expect(page.getByRole('button', { name: 'Export snapshot' })).toHaveCount(0);
  await expect(page.getByText('Awaiting lead sign-off')).toBeVisible();
  await page.getByRole('button', { name: 'Sign off to publish' }).click();
  await page.getByLabel('Accountable lead').fill('Mara Chen');
  await page.getByRole('button', { name: 'Confirm and sign off' }).click();
  await expect(page.getByText('Signed off by Mara Chen')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export snapshot' })).toBeVisible();

  // A placement change invalidates the sign-off and locks publishing again.
  await page.goto('/journey');
  await page.getByRole('button', { name: /Conservator’s Gloves/ }).click();
  await page.getByRole('button', { name: /Place Conservator’s Gloves here/ }).first().click();
  await page.goto('/review');
  await expect(page.getByText('Sign-off needs renewal')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export snapshot' })).toHaveCount(0);

  // Re-running the readiness check and confirming again restores publishing.
  await page.getByRole('button', { name: 'Run readiness check' }).click();
  await page.getByRole('button', { name: 'Sign off to publish' }).click();
  await page.getByLabel('Accountable lead').fill('Mara Chen');
  await page.getByRole('button', { name: 'Confirm and sign off' }).click();
  await expect(page.getByText('Signed off by Mara Chen')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export snapshot' })).toBeVisible();
});
