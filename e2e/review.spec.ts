import { test, expect } from '@playwright/test';

test('advance a review finding and run readiness check', async ({ page }) => {
  await page.goto('/review');
  await page.getByRole('button', { name: 'Start work' }).first().click();
  await expect(page.getByRole('button', { name: 'In Progress' })).toBeVisible();
  await page.getByRole('button', { name: 'Resolve' }).first().click();
  await page.getByRole('button', { name: 'Run readiness check' }).click();
  await expect(page.getByText(/Still needs attention|Ready to share/)).toBeVisible();
});

test('merge duplicate findings into one canonical record', async ({ page }) => {
  await page.goto('/review');

  // The same problem gets reported twice against the same object.
  const createFinding = async (title: string, owner: string, description: string) => {
    await page.getByRole('button', { name: 'New finding' }).click();
    await page.getByLabel('Finding title').fill(title);
    await page.getByLabel('Owner').fill(owner);
    await page.getByLabel('Linked object').selectOption({ label: 'Rain Map Quilt' });
    await page.getByLabel('Context and next step').fill(description);
    await page.getByRole('button', { name: 'Create finding' }).click();
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
  };
  await createFinding('Quilt lux level too high', 'Mara Chen', 'Curatorial measured lux above the textile limit.');
  await createFinding('Check quilt lighting level', 'Rina Solberg', 'Floor walk flagged the same lux problem at the quilt.');

  // Select both duplicates and open the merge preview.
  await page.getByLabel('Select "Quilt lux level too high" for merge').check();
  await page.getByLabel('Select "Check quilt lighting level" for merge').check();
  await page.getByRole('button', { name: 'Merge selected (2)' }).click();

  // The preview shows the shared root cause, field differences, links, and history.
  const dialog = page.getByRole('dialog', { name: 'Merge duplicate findings' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/All selected findings point at object "Rain Map Quilt"/)).toBeVisible();
  await expect(dialog.getByRole('table', { name: 'Field differences' })).toBeVisible();
  await expect(dialog.getByText('STATUS HISTORY')).toBeVisible();
  await expect(dialog.getByText('LINKED ZONES AND OBJECTS')).toBeVisible();

  // Confirm requires a reason and produces a single canonical record.
  await page.getByLabel(/Merge reason/).fill('Same lux problem reported from curation and the floor walk.');
  await page.getByRole('button', { name: 'Confirm merge' }).click();
  await expect(page.getByText('Canonical · 2 merged')).toBeVisible();
  await expect(page.getByText(/Merged into/).nth(1)).toBeVisible();
  await expect(page.getByText(/is now the canonical record/)).toBeVisible();

  // Repeating the same merge does not create another canonical record.
  const mergedRows = page.locator('.issue-merged');
  await expect(mergedRows).toHaveCount(2);
  await mergedRows.nth(0).getByRole('checkbox').check();
  await mergedRows.nth(1).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Merge selected (2)' }).click();
  const repeatDialog = page.getByRole('dialog', { name: 'Merge duplicate findings' });
  await expect(repeatDialog.getByText(/already merged into/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm merge' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('Canonical · 2 merged')).toHaveCount(1);
});
