import { test, expect, type Page } from '@playwright/test';

async function resetPlan(page: Page): Promise<void> {
  await page.goto('/collection');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
}

test('shows placement and finding impact before deleting a placed object, then supports immediate undo', async ({ page }) => {
  await resetPlan(page);

  // The seed places Oral History Tape 12 in Afterlives with a linked finding.
  await page.getByLabel('Search collection').fill('Oral History');
  await page.getByText('Oral History Tape 12').waitFor();
  await page.getByRole('button', { name: /Delete object/ }).first().click();

  const dialog = page.getByRole('dialog', { name: 'Delete object' });
  await expect(dialog).toBeVisible();
  // Impact groups, not just a bare "remove object" prompt.
  await expect(dialog.getByText(/Journey placements/i)).toBeVisible();
  await expect(dialog.getByText(/Afterlives/)).toBeVisible();
  await expect(dialog.getByText(/Review findings/i)).toBeVisible();
  await expect(dialog.getByText(/Add transcript beside oral history station/i)).toBeVisible();
  await expect(dialog.getByText(/Historical export packages are never rewritten|Recovery center/i)).toBeVisible();

  await dialog.getByRole('button', { name: 'Delete object' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.artifact-card', { hasText: 'Oral History Tape 12' })).toHaveCount(0);

  // Recovery entry advertises the one recoverable delete.
  await expect(page.getByRole('button', { name: /Recovery center/ })).toContainText('1');

  // Immediate undo restores the object and its placement and finding.
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText('Oral History Tape 12')).toBeVisible();
  await page.goto('/journey');
  await expect(page.getByText('Oral History Tape 12')).toBeVisible();
});

test('deleting an object that carries a finding previews the cascaded finding', async ({ page }) => {
  await resetPlan(page);
  await page.getByLabel('Search collection').fill('Rain Map');
  await page.getByRole('button', { name: /Delete object/ }).first().click();

  const dialog = page.getByRole('dialog', { name: 'Delete object' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Review findings/i)).toBeVisible();
  await expect(dialog.getByText(/Confirm quilt lux rotation/i)).toBeVisible();
  // The finding copy makes clear it is recoverable, not silently destroyed.
  await expect(dialog.getByText(/recoverable for 7 days/i)).toBeVisible();

  await dialog.getByRole('button', { name: 'Delete object' }).click();
  await expect(page.getByRole('button', { name: /Recovery center/ })).toContainText('1');
});

test('empty object record delete shows the no-reference impact panel', async ({ page }) => {
  await resetPlan(page);
  await page.getByLabel('Search collection').fill('Gloves');
  await page.getByRole('button', { name: /Delete object/ }).first().click();

  const dialog = page.getByRole('dialog', { name: 'Delete object' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Nothing else references this record/i)).toBeVisible();
  await expect(dialog.getByText(/Only this single record is removed/i)).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete object' }).click();
  await expect(page.getByRole('button', { name: /Recovery center/ })).toContainText('1');
});

test('empty record delete shows no-reference impact and still creates a recovery entry', async ({ page }) => {
  await resetPlan(page);
  await page.goto('/review');
  // Seed "Reduce entry panel copy" is warning, open, zone-linked; pick the resolved note instead via filter is complex.
  // Create a standalone finding with no links.
  await page.getByRole('button', { name: 'New finding' }).click();
  await page.getByLabel('Finding title').fill('Standalone housekeeping note');
  await page.getByLabel('Severity').selectOption('note');
  await page.getByLabel('Owner').fill('Noa');
  await page.getByLabel('Context and next step').fill('A standalone note that is intentionally not linked to anything at all.');
  await page.getByRole('button', { name: 'Create finding' }).click();

  await page.getByRole('button', { name: /Delete finding/ }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Delete finding' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/not linked to any object or area/i)).toBeVisible();

  await dialog.getByRole('button', { name: 'Delete finding' }).click();
  await expect(page.locator('.issue-row', { hasText: 'Standalone housekeeping note' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Recovery center/ })).toContainText('1');
});

test('confirming delete keeps historical published packages and recovery center restores with audit trail', async ({ page }) => {
  await resetPlan(page);

  // Resolve all findings and unplaced key objects is hard; instead publish a zone checklist,
  // which records a published package referencing the Afterlives area.
  await page.goto('/review');
  await page.getByLabel('Exhibition zone').selectOption('zone-after');
  await page.getByRole('button', { name: 'Download zone checklist (CSV)' }).click();
  await expect(page.getByText(/recorded in the export ledger/i)).toBeVisible();

  // Delete an object referenced by the just-published checklist.
  await page.goto('/collection');
  await page.getByLabel('Search collection').fill('Oral History');
  await page.getByRole('button', { name: /Delete object/ }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Delete object' });
  await expect(dialog.getByText(/published package/i)).toBeVisible();
  await expect(dialog.getByText(/stays exactly as exported/i)).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete object' }).click();

  // Recovery center lists the deletion and can restore it.
  await page.getByRole('button', { name: /Recovery center/ }).click();
  const recovery = page.getByRole('dialog', { name: 'Recovery center' });
  await expect(recovery).toBeVisible();
  await expect(recovery.getByText('Oral History Tape 12')).toBeVisible();
  await recovery.getByRole('button', { name: 'Review & restore' }).click();
  await expect(recovery.getByText(/exact recorded state can be restored/i)).toBeVisible();
  await recovery.getByRole('button', { name: 'Restore now' }).click();
  await recovery.getByRole('button', { name: 'Close dialog' }).click();
  await page.goto('/collection');
  await page.getByLabel('Search collection').fill('Oral History');
  await expect(page.getByText('Oral History Tape 12')).toBeVisible();
});

test('deleting an exhibition area returns its objects to the queue and the restore pulls them back', async ({ page }) => {
  await resetPlan(page);
  await page.goto('/journey');

  // Afterlives holds the bowl and the tape; open its delete flow.
  await page.getByRole('button', { name: 'Delete exhibition area Afterlives' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete exhibition area' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Mended Serving Bowl/)).toBeVisible();
  await expect(dialog.getByText(/2 placed objects return to the unplaced queue/i)).toBeVisible();
  await expect(dialog.getByText(/Add transcript beside oral history station/i)).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete exhibition area' }).click();

  // Objects survive and return to the unplaced queue; the area lane disappears.
  await expect(page.getByText('Mended Serving Bowl')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete exhibition area Afterlives' })).toHaveCount(0);

  // Restore through the recovery center.
  await page.getByRole('button', { name: /Recovery center/ }).click();
  const recovery = page.getByRole('dialog', { name: 'Recovery center' });
  await recovery.getByRole('button', { name: 'Review & restore' }).click();
  await recovery.getByRole('button', { name: 'Restore now' }).click();
  await recovery.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByRole('heading', { name: 'Afterlives' })).toBeVisible();
  await expect(page.getByText('Mended Serving Bowl').first()).toBeVisible();
});

test('empty record under a ready sign-off is not labelled isolated and previews the sign-off regression', async ({ page }) => {
  await resetPlan(page);
  await page.goto('/review');

  // The only readiness blocker is the seed's critical (in-progress) finding.
  await page.locator('.issue-row', { hasText: 'Add transcript beside oral history station' })
    .getByRole('button', { name: 'Resolve' }).click();
  await page.getByRole('button', { name: 'Run readiness check' }).click();
  await expect(page.getByText('Ready to share').first()).toBeVisible();

  // Delete an object with no placement and no findings while the plan is signed off.
  await page.goto('/collection');
  await page.getByLabel('Search collection').fill('Gloves');
  await page.getByRole('button', { name: /Delete object/ }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Delete object' });
  await expect(dialog).toBeVisible();
  // The "nothing else references this record" banner must not contradict the groups.
  await expect(dialog.getByText(/Nothing else references this record/i)).toHaveCount(0);
  await expect(dialog.getByText(/Readiness sign-off/i)).toBeVisible();
  await expect(dialog.getByText(/returns to review/i)).toBeVisible();
  await expect(dialog.getByText(/No exported package will change/i)).toBeVisible();

  await dialog.getByRole('button', { name: 'Delete object' }).click();
  // The ready sign-off actually regresses on confirm.
  await expect(page.locator('.badge', { hasText: 'In review' })).toBeVisible();
});

test('restore surfaces conflicts when the source data changed after deletion', async ({ page }) => {
  await resetPlan(page);

  // Delete the gloves object (no placement, no finding).
  await page.getByLabel('Search collection').fill('Gloves');
  await page.getByRole('button', { name: /Delete object/ }).first().click();
  await page.getByRole('dialog', { name: 'Delete object' }).getByRole('button', { name: 'Delete object' }).click();

  // Create a replacement object claiming the same accession ID.
  await page.getByLabel('Search collection').fill('');
  await page.getByRole('button', { name: 'Add object' }).first().click();
  await page.getByLabel('Accession ID').fill('AF-2001-019');
  await page.getByLabel('Title').fill('Replacement Gloves Record');
  await page.getByLabel('Maker / source').fill('Another conservator');
  await page.getByLabel('Medium').fill('Cotton and pigment');
  await page.getByLabel('Summary').fill('A newer record that claimed the accession identifier after the original deletion.');
  await page.getByLabel('Width (cm)').fill('24');
  await page.getByLabel('Height (cm)').fill('31');
  await page.getByLabel('Depth (cm)').fill('3');
  await page.getByLabel('Dwell time (min)').fill('3');
  await page.getByRole('button', { name: 'Add object' }).last().click();
  await expect(page.getByText('Replacement Gloves Record')).toBeVisible();

  // Attempt restore: the conflict must be shown and the current state preserved.
  await page.getByRole('button', { name: /Recovery center/ }).click();
  const recovery = page.getByRole('dialog', { name: 'Recovery center' });
  await recovery.getByRole('button', { name: 'Review & restore' }).click();
  await expect(recovery.getByText(/Accession ID AF-2001-019 is now used by another object/i)).toBeVisible();
  // A blocking collision requires an explicit acknowledgement before restore runs.
  await expect(recovery.getByRole('button', { name: 'Resolve blocking conflicts first' })).toBeDisabled();

  // Explicitly choosing skip closes without overwriting the current object.
  await recovery.getByText('Skip / keep current state').click();
  await recovery.getByRole('button', { name: 'Restore now' }).click();
  await expect(recovery.getByText(/Nothing was restored/i)).toBeVisible();
  await recovery.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByText('Replacement Gloves Record')).toBeVisible();
  // The deletion remains recoverable because nothing was applied.
  await expect(page.getByRole('button', { name: /Recovery center/ })).toContainText('1');
});
