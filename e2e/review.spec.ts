import { test, expect } from '@playwright/test';

test('advance a review finding and run readiness check', async ({ page }) => {
  await page.goto('/review');
  await page.getByRole('button', { name: 'Start work' }).first().click();
  await expect(page.getByRole('button', { name: 'In Progress' })).toBeVisible();
  await page.getByRole('button', { name: 'Resolve' }).first().click();
  await page.getByRole('button', { name: 'Run readiness check' }).first().click();
  await expect(page.getByText(/Still needs attention|Ready to share/)).toBeVisible();
});

test('blocker links jump to their finding and the result survives a reload', async ({ page }) => {
  await page.goto('/review');
  await page.getByRole('button', { name: 'Run readiness check' }).first().click();
  await expect(page.getByText('Still needs attention')).toBeVisible();

  // The recorded result and its blockers persist across a refresh.
  await page.reload();
  await expect(page.getByText('Still needs attention')).toBeVisible();
  await expect(page.getByText('1 critical review finding remains unresolved.')).toBeVisible();

  // A blocker link jumps to the linked finding and highlights it in place.
  await page.getByRole('link', { name: 'Add transcript beside oral history station' }).click();
  await expect(page).toHaveURL(/\/review\?issue=issue-audio-transcript/);
  await expect(page.locator('#review-issue-issue-audio-transcript')).toHaveClass(/highlighted/);
});

test('edits from another module stale the check, and a zone blocker returns to review', async ({ page }) => {
  await page.goto('/review');
  await page.getByRole('button', { name: 'Run readiness check' }).first().click();
  await expect(page.getByText('Still needs attention')).toBeVisible();

  // Change an object field from the collection module.
  await page.getByRole('link', { name: /Collection/ }).first().click();
  await page.locator('.artifact-card', { hasText: 'Mended Serving Bowl' }).getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Sensitivity').selectOption('low-light');
  await page.getByRole('button', { name: 'Save changes' }).click();

  // Back on the review desk the recorded verdict is marked stale with the changed fact.
  await page.getByRole('link', { name: /Review desk/ }).click();
  await expect(page.getByText('Plan changed since this check.')).toBeVisible();
  await expect(page.getByText(/object “Mended Serving Bowl”/)).toBeVisible();

  // Re-checking records the new journey blocker, whose link jumps to the zone.
  await page.getByRole('button', { name: 'Re-check now' }).click();
  await expect(page.getByText('Plan changed since this check.')).toHaveCount(0);
  await page.getByRole('link', { name: /Mended Serving Bowl requires low light/ }).click();
  await expect(page).toHaveURL(/\/journey\?.*zone=zone-after/);
  await expect(page.getByText('Resolving blocker:')).toBeVisible();
  await expect(page.locator('#journey-zone-zone-after')).toHaveClass(/highlighted/);

  // The return path keeps the context and lands back on the review desk.
  await page.getByRole('link', { name: 'Back to review desk' }).click();
  await expect(page).toHaveURL(/\/review$/);
  await expect(page.getByText('Still needs attention')).toBeVisible();
});

test('removing a linked object invalidates the blocker link and asks for a re-check', async ({ page }) => {
  await page.goto('/review');
  await page.getByRole('button', { name: 'Run readiness check' }).first().click();
  await expect(page.getByText('1 critical review finding remains unresolved.')).toBeVisible();

  // Remove the object that the critical finding is linked to.
  await page.getByRole('link', { name: /Collection/ }).first().click();
  page.on('dialog', (dialog) => dialog.accept());
  await page.locator('.artifact-card', { hasText: 'Oral History Tape 12' }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('.artifact-card', { hasText: 'Oral History Tape 12' })).toHaveCount(0);

  // The recorded blocker now points at a removed target and says so.
  await page.getByRole('link', { name: /Review desk/ }).click();
  await expect(page.getByText('Plan changed since this check.')).toBeVisible();
  await expect(page.getByText('Removed — re-check')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Add transcript beside oral history station' })).toHaveCount(0);

  // Re-checking clears the invalidated blocker.
  await page.getByRole('button', { name: 'Re-check now' }).click();
  await expect(page.getByText('Removed — re-check')).toHaveCount(0);
});
