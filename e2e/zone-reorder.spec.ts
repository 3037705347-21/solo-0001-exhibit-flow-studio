import { test, expect } from '@playwright/test';

test('stage, preview, and apply a zone reorder as one change', async ({ page }) => {
  await page.goto('/journey');
  const lanes = page.locator('.zone-lane h3');
  await expect(lanes.first()).toHaveText('Arrival / A Light Carried');

  await page.getByRole('button', { name: 'Reorder zones' }).click();
  const dialog = page.getByRole('dialog', { name: 'Reorder zones' });
  await expect(dialog).toBeVisible();
  // Nothing to apply until the staged order actually changes.
  await expect(dialog.getByRole('button', { name: 'Apply new order' })).toBeDisabled();

  await dialog.getByRole('button', { name: 'Move Afterlives up' }).click();
  // The preview shows the downstream impact before anything is committed.
  await expect(dialog.getByText('VISIT TIMELINE')).toBeVisible();
  await expect(dialog.getByText('No exported materials are affected.')).toBeVisible();
  await expect(dialog.getByText('Confirm quilt lux rotation')).toBeVisible();

  await dialog.getByRole('button', { name: 'Apply new order' }).click();
  await expect(page.getByText(/Zone order updated — 2 zones moved/)).toBeVisible();
  await expect(lanes.nth(2)).toHaveText('Afterlives');
  await expect(lanes.nth(3)).toHaveText('The Common Thread');

  // The resolved finding on the moved zone was flagged for re-review.
  await page.goto('/review');
  await expect(page.getByText('Confirm quilt lux rotation')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resolve' }).first()).toBeVisible();
});

test('exported materials are flagged out of date after a reorder', async ({ page }) => {
  await page.goto('/review');
  await page.getByLabel('Exhibition zone').selectOption('zone-common');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download zone checklist (CSV)' }).click();
  await downloadPromise;
  const exportsCard = page.getByRole('region', { name: 'Exported materials' });
  await expect(exportsCard.getByText('The Common Thread checklist')).toBeVisible();
  await expect(exportsCard.getByText('Current')).toBeVisible();

  await page.goto('/journey');
  await page.getByRole('button', { name: 'Reorder zones' }).click();
  const dialog = page.getByRole('dialog', { name: 'Reorder zones' });
  await dialog.getByRole('button', { name: 'Move Arrival / A Light Carried down' }).click();
  await expect(dialog.getByText('The Common Thread checklist')).toBeVisible();
  await expect(dialog.getByText(/will be marked out of date/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Apply new order' }).click();

  await page.goto('/review');
  const staleCard = page.getByRole('region', { name: 'Exported materials' });
  await expect(staleCard.getByText('1 out of date')).toBeVisible();
  await expect(staleCard.getByText('Out of date', { exact: true })).toBeVisible();
  await expect(staleCard.getByText(/export again to refresh/)).toBeVisible();
});

test('cancelling a staged reorder keeps the current order and outputs', async ({ page }) => {
  await page.goto('/journey');
  await page.getByRole('button', { name: 'Reorder zones' }).click();
  const dialog = page.getByRole('dialog', { name: 'Reorder zones' });
  await dialog.getByRole('button', { name: 'Move Afterlives up' }).click();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);

  const lanes = page.locator('.zone-lane h3');
  await expect(lanes.first()).toHaveText('Arrival / A Light Carried');
  await expect(lanes.nth(3)).toHaveText('Afterlives');

  // Nothing was recorded or invalidated: the review desk shows no exports.
  await page.goto('/review');
  await expect(page.getByRole('region', { name: 'Exported materials' }).getByText('None yet')).toBeVisible();
});
