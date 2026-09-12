import { test, expect } from '@playwright/test';

test('advance a review finding and run readiness check', async ({ page }) => {
  await page.goto('/review');
  await page.getByRole('button', { name: 'Start work' }).first().click();
  await expect(page.getByRole('button', { name: 'In Progress' })).toBeVisible();
  await page.getByRole('button', { name: 'Resolve' }).first().click();
  await page.getByRole('button', { name: 'Run readiness check' }).click();
  await expect(page.getByText(/Still needs attention|Ready to share/)).toBeVisible();
});

test('edit a finding with a rationale and inspect its versioned history', async ({ page }) => {
  await page.goto('/review');
  const row = page.locator('article', { has: page.getByRole('heading', { name: 'Reduce entry panel copy' }) });
  await row.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Finding title').fill('Shorten entry panel copy');
  await page.getByLabel('Basis for change').fill('Tightened after the design review walkthrough.');
  await page.getByRole('button', { name: 'Save changes' }).click();

  const updated = page.locator('article', { has: page.getByRole('heading', { name: 'Shorten entry panel copy' }) });
  await expect(updated.getByText('v2')).toBeVisible();
  await updated.getByRole('button', { name: 'History' }).click();
  await expect(page.getByText('Edited')).toBeVisible();
  await expect(page.getByText('based on v1')).toBeVisible();
  await expect(page.getByText('Tightened after the design review walkthrough.')).toBeVisible();
  await expect(page.getByText('Created')).toBeVisible();
});

test('cancel an edit without recording a revision', async ({ page }) => {
  await page.goto('/review');
  const row = page.locator('article', { has: page.getByRole('heading', { name: 'Reduce entry panel copy' }) });
  await row.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Finding title').fill('Shorten entry panel copy');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: 'Reduce entry panel copy' })).toBeVisible();
  await row.getByRole('button', { name: 'History' }).click();
  await expect(page.getByText('Created')).toBeVisible();
  await expect(page.getByText('Edited')).not.toBeVisible();
});
