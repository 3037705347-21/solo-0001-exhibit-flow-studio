import { test, expect, type Page } from '@playwright/test';

async function resetSamplePlan(page: Page) {
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('/rotation');
  await page.getByRole('button', { name: 'Reset sample plan' }).click();
  await expect(page.getByRole('heading', { name: 'Rotation schedule' })).toBeVisible();
}

test('rotation schedule: generate, adjust, confirm, drift, and recover', async ({ page }) => {
  await resetSamplePlan(page);

  // 1. Normal generation — a draft plan with batches for each sensitive object.
  await page.getByRole('button', { name: 'Generate rotation plan' }).first().click();
  await expect(page.getByText('Draft available for review')).toBeVisible();
  const batchCount = await page.locator('.rotation-batch').count();
  expect(batchCount).toBeGreaterThanOrEqual(3);

  // Every batch must declare the pinned object and gallery versions.
  await expect(page.locator('.rotation-dependency-row code').first()).toBeVisible();

  // 2. Manual adjustment — rename the first batch, plan returns to draft and is marked manual.
  await page.getByRole('button', { name: /Edit label for/ }).first().click();
  const labelInput = page.getByLabel('Batch label');
  await labelInput.fill('Conservation group A');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: /Conservation group A/ })).toBeVisible();
  await expect(page.getByText('Manually adjusted')).toBeVisible();

  // 3. Confirm — batches are pinned to current object and gallery versions.
  await page.getByRole('button', { name: 'Confirm plan' }).click();
  await expect(page.getByText('Confirmed schedule')).toBeVisible();
  await expect(page.locator('.rotation-plan-card').first()).toHaveClass(/status-confirmed/);

  // 4. Gallery condition change — toggling the low-light gallery returns dependent batches to review.
  const commonSwitch = page.getByLabel('Toggle low light for The Common Thread');
  await commonSwitch.uncheck();
  await expect(page.getByText('This schedule is stale and must be reviewed')).toBeVisible();
  await expect(page.locator('.rotation-batch.state-stale').first()).toBeVisible();

  // Recovery via re-confirm after restoring the gallery.
  await page.getByLabel('Toggle low light for The Common Thread').check();
  await page.getByRole('button', { name: 'Re-confirm after review' }).click();
  await expect(page.getByText('Confirmed schedule')).toBeVisible();

  // 5. Object sensitivity change — edit a fragile object, confirm drift, then restore.
  await page.goto('/collection');
  const bowlCard = page.locator('.artifact-card', { hasText: 'Mended Serving Bowl' });
  await bowlCard.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Sensitivity').selectOption('standard');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Mended Serving Bowl')).toBeVisible();
  await page.goto('/rotation');
  await expect(page.getByText('This schedule is stale and must be reviewed')).toBeVisible();

  await page.goto('/collection');
  const bowlCardAfter = page.locator('.artifact-card', { hasText: 'Mended Serving Bowl' });
  await bowlCardAfter.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Sensitivity').selectOption('fragile');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.goto('/rotation');
  await page.getByRole('button', { name: 'Re-confirm after review' }).click();
  await expect(page.getByText('Confirmed schedule')).toBeVisible();

  // 6. Opening date change also invalidates, then re-confirm re-anchors stints.
  await page.getByLabel('Planned opening date').fill('2027-06-01');
  await page.getByLabel('Planned opening date').blur();
  await expect(page.getByText('This schedule is stale and must be reviewed')).toBeVisible();
  await page.getByRole('button', { name: 'Re-confirm after review' }).click();
  await expect(page.getByText('Confirmed schedule')).toBeVisible();

  // 7. Export works for a confirmed plan.
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'JSON' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/exhibit-flow-rotation-.*\.json/);

  // 8. Recovery across reload — confirmed status persists with the workspace.
  await page.reload();
  await expect(page.locator('.rotation-plan-card').first()).toHaveClass(/status-confirmed/);
});
