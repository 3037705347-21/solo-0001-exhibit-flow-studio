import { test, expect } from '@playwright/test';

test('compare and apply a visitor scenario', async ({ page }) => {
  await page.goto('/insights');
  await page.getByRole('button', { name: 'Leisurely' }).click();
  await page.getByLabel('Group size').fill('12');
  await expect(page.getByText('Leisurely visit')).toBeVisible();
  await page.getByRole('button', { name: 'Apply preferences' }).click();
  await expect(page.getByText('Planning preferences applied.')).toBeVisible();
});

test('recovers an unsaved scenario draft after a reload', async ({ page }) => {
  await page.goto('/insights');
  await page.getByRole('button', { name: 'Leisurely' }).click();
  await page.reload();
  const banner = page.getByText('Recovered an unsaved scenario draft');
  await expect(banner).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(banner).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Leisurely' })).toHaveClass(/selected/);
  await page.getByRole('button', { name: 'Apply preferences' }).click();
  await expect(page.getByText('Planning preferences applied.')).toBeVisible();
  await expect(page.getByText(/Saved profile:/)).toContainText('Leisurely');
});

test('reverts unapplied scenario changes to the saved profile', async ({ page }) => {
  await page.goto('/insights');
  await page.getByRole('button', { name: 'Leisurely' }).click();
  await expect(page.getByText('Unapplied scenario changes')).toBeVisible();
  await page.getByRole('button', { name: 'Revert to saved' }).click();
  await expect(page.getByRole('button', { name: 'Balanced' })).toHaveClass(/selected/);
  await expect(page.getByText('Unapplied scenario changes')).not.toBeVisible();
  await page.reload();
  await expect(page.getByText('Recovered an unsaved scenario draft')).not.toBeVisible();
  await expect(page.getByText(/Saved profile:/)).toContainText('Balanced');
});

test('discards a recovered draft without applying it', async ({ page }) => {
  await page.goto('/insights');
  await page.getByRole('button', { name: 'Focused' }).click();
  await page.reload();
  const banner = page.getByText('Recovered an unsaved scenario draft');
  await expect(banner).toBeVisible();
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(banner).not.toBeVisible();
  await page.reload();
  await expect(page.getByText('Recovered an unsaved scenario draft')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Balanced' })).toHaveClass(/selected/);
  await expect(page.getByText(/Saved profile:/)).toContainText('Balanced');
});

test('resets controls and disables apply the moment a draft is discarded', async ({ page }) => {
  await page.goto('/insights');
  await page.getByRole('button', { name: 'Focused' }).click();
  await page.getByLabel('Group size').fill('14');
  await page.reload();
  await expect(page.getByText('Recovered an unsaved scenario draft')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Focused' })).toHaveClass(/selected/);
  await expect(page.getByLabel('Group size')).toHaveValue('14');
  await expect(page.getByRole('button', { name: 'Apply preferences' })).toBeEnabled();
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByText('Recovered an unsaved scenario draft')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Balanced' })).toHaveClass(/selected/);
  await expect(page.getByLabel('Group size')).toHaveValue('6');
  await expect(page.getByText('Unapplied scenario changes')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply preferences' })).toBeDisabled();
});

test('requires reconfirmation when the plan changes before applying', async ({ page }) => {
  await page.goto('/insights');
  await page.getByLabel('Group size').fill('14');
  await page.goto('/journey');
  await page.getByRole('button', { name: /Conservator’s Gloves/ }).click();
  await page.getByRole('button', { name: /Place Conservator’s Gloves here/ }).first().click();
  await page.goto('/insights');
  await expect(page.getByText('Recovered an unsaved scenario draft')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Apply preferences' }).click();
  await expect(page.getByText(/plan changed since this draft/i)).toBeVisible();
  await expect(page.getByText(/Saved profile:/)).toContainText('6 people');
  await page.getByRole('button', { name: 'Confirm apply' }).click();
  await expect(page.getByText('Planning preferences applied.')).toBeVisible();
  await expect(page.getByText(/Saved profile:/)).toContainText('14 people');
});
