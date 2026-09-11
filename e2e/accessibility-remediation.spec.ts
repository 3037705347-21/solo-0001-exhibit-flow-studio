import { test, expect, type Page, type Locator } from '@playwright/test';

async function openTwoFreshGaps(page: Page) {
  await page.goto('/journey');
  // Remove two objects with recorded interpretation needs: their requirements
  // are only covered once the object is placed, so both become open gaps.
  await page.getByRole('button', { name: 'Remove Oral History Tape 12' }).click();
  await page.getByRole('button', { name: 'Remove Rain Map Quilt' }).click();
  await expect(page.getByRole('button', { name: /Oral History Tape 12/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Rain Map Quilt/ })).toBeVisible();
}

async function openRemediationDialog(page: Page): Promise<Locator> {
  await page.goto('/review');
  await page.getByRole('button', { name: /^Log 2 remediation findings/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Open findings for coverage gaps' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('successfully commits a remediation batch for fresh coverage gaps', async ({ page }) => {
  await openTwoFreshGaps(page);
  const dialog = await openRemediationDialog(page);

  await expect(dialog.getByText('Oral History Tape 12')).toBeVisible();
  await expect(dialog.getByText('Rain Map Quilt')).toBeVisible();
  await expect(dialog.getByText('Audio interpretation')).toBeVisible();
  await expect(dialog.getByText('Seated interpretation')).toBeVisible();
  await dialog.getByLabel('Owner for all selected gaps').fill('Mara Chen');

  await dialog.getByRole('button', { name: 'Create findings' }).click();

  await expect(page.getByText(/2 remediation findings opened in one transaction/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Coverage tracked' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Log 2 remediation findings/ })).toHaveCount(0);

  // Both findings are in the review list, linked to object, owner, and requirement.
  await expect(page.getByText('Access remediation: Oral History Tape 12')).toBeVisible();
  await expect(page.getByText('Access remediation: Rain Map Quilt')).toBeVisible();
  await expect(page.getByText('Owner: Mara Chen.')).toHaveCount(2);

  // Coverage and the review list agree: the same two gaps show open findings.
  await expect(page.getByText('Open finding')).toHaveCount(2);
});

test('blocks duplicate remediation when an unresolved finding already covers a gap', async ({ page }) => {
  await openTwoFreshGaps(page);
  const dialog = await openRemediationDialog(page);
  await dialog.getByLabel('Owner for all selected gaps').fill('Mara Chen');
  await dialog.getByRole('button', { name: 'Create findings' }).click();
  await expect(page.getByText(/2 remediation findings opened/)).toBeVisible();

  // The action button is disabled once every gap has an open finding.
  await expect(page.getByRole('button', { name: 'Coverage tracked' })).toBeDisabled();

  // Resolving one gap's finding frees only that gap, proving idempotency is per gap.
  const issueRows = page.locator('.issue-row');
  await issueRows.filter({ hasText: 'Rain Map Quilt' }).getByRole('button', { name: 'Start work' }).click();
  await issueRows.filter({ hasText: 'Rain Map Quilt' }).getByRole('button', { name: 'Resolve' }).click();
  await expect(page.getByRole('button', { name: /^Log 1 remediation finding/ })).toBeVisible();

  const reopened = page.getByRole('dialog', { name: 'Open findings for coverage gaps' });
  await page.getByRole('button', { name: /^Log 1 remediation finding/ }).click();
  await expect(reopened).toBeVisible();
  // The still-open tape gap is excluded; only the resolved quilt gap is offered.
  await expect(reopened.getByText('Oral History Tape 12')).toHaveCount(0);
  await expect(reopened.getByText('Rain Map Quilt')).toBeVisible();
});

test('cancels the remediation batch without writing any finding', async ({ page }) => {
  await openTwoFreshGaps(page);
  await page.goto('/review');
  const countBefore = await page.locator('.issue-row').count();
  const dialog = await openRemediationDialog(page);
  await dialog.getByLabel('Owner for all selected gaps').fill('Mara Chen');

  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Access remediation: Rain Map Quilt')).toHaveCount(0);
  await expect(page.locator('.issue-row')).toHaveCount(countBefore);
  // Gaps are still offered for commit — nothing was consumed.
  await expect(page.getByRole('button', { name: /^Log 2 remediation findings/ })).toBeVisible();
});

test('historical findings follow an object after it moves zones', async ({ page }) => {
  await page.goto('/journey');
  // The tape (standard sensitivity) is free to move between any zone.
  await page.getByRole('button', { name: 'Remove Oral History Tape 12' }).click();
  await page.goto('/review');
  await page.getByRole('button', { name: /^Log 1 remediation finding/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Open findings for coverage gaps' });
  await dialog.getByLabel('Owner for all selected gaps').fill('Mara Chen');
  await dialog.getByRole('button', { name: 'Create findings' }).click();
  await expect(page.getByText('Access remediation: Oral History Tape 12')).toBeVisible();

  // Place the object in Arrival: the historical finding now scopes to Arrival.
  await page.goto('/journey');
  await page.getByRole('button', { name: /Oral History Tape 12/ }).click();
  const arrivalLane = page.locator('.zone-lane').filter({ hasText: 'Arrival / A Light Carried' });
  await arrivalLane.getByRole('button', { name: /Place Oral History Tape 12 here/ }).click();

  await page.goto('/review');
  await page.getByLabel('Exhibition zone').selectOption('zone-arrival');
  await expect(page.getByText('Access remediation: Oral History Tape 12')).toBeVisible();

  // Move the object to Patterns: the finding moves with it instead of vanishing.
  await page.goto('/journey');
  await page.getByRole('button', { name: 'Remove Oral History Tape 12' }).click();
  await page.getByRole('button', { name: /Oral History Tape 12/ }).click();
  const patternsLane = page.locator('.zone-lane').filter({ hasText: 'Patterns of Work' });
  await patternsLane.getByRole('button', { name: /Place Oral History Tape 12 here/ }).click();

  await page.goto('/review');
  await page.getByLabel('Exhibition zone').selectOption('zone-patterns');
  await expect(page.getByText('Access remediation: Oral History Tape 12')).toBeVisible();

  await page.getByLabel('Exhibition zone').selectOption('zone-arrival');
  await expect(page.getByText('Access remediation: Oral History Tape 12')).toHaveCount(0);
});
