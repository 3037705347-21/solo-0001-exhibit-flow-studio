import { expect, test } from '@playwright/test';

test.describe('planning lineage', () => {
  test('direct creation shows provenance and a source modification flags dependents', async ({ page }) => {
    await page.goto('/collection');

    // 1. Directly create an object.
    await page.getByRole('button', { name: 'Add object' }).first().click();
    await page.getByLabel('Accession ID').fill('AF-2027-700');
    await page.getByLabel('Title').fill('Lineage Test Plaque');
    await page.getByLabel('Maker / source').fill('In-house team');
    await page.getByLabel('Medium').fill('Enamel');
    await page.getByLabel('Summary').fill('A plaque used to verify that provenance and staleness propagate correctly.');
    await page.getByLabel('Width (cm)').fill('12');
    await page.getByLabel('Height (cm)').fill('18');
    await page.getByLabel('Depth (cm)').fill('1');
    await page.getByLabel('Dwell time (min)').fill('3');
    await page.getByRole('button', { name: 'Add object' }).last().click();
    await expect(page.getByText('Lineage Test Plaque').first()).toBeVisible();

    // 2. The lineage detail records a direct origin.
    await page.getByRole('button', { name: 'Show provenance for Lineage Test Plaque' }).click();
    await expect(page.getByText('Directly created in this workspace')).toBeVisible();
    await page.getByRole('button', { name: 'Close dialog' }).click();

    // 3. Place it in the first zone.
    await page.goto('/journey');
    await page.getByRole('button', { name: /Lineage Test Plaque/ }).click();
    await page.getByRole('button', { name: /Place Lineage Test Plaque here/ }).first().click();

    // 4. Edit the source object's content.
    await page.goto('/collection');
    await page.getByRole('button', { name: 'Show provenance for Lineage Test Plaque' }).click();
    await page.getByRole('button', { name: 'Edit record' }).click();
    await page.getByLabel('Title').fill('Lineage Test Plaque (revised)');
    await page.getByRole('button', { name: 'Save changes' }).click();

    // 5. The placement is now flagged for re-review and its detail explains why.
    await page.goto('/journey');
    await expect(page.getByText('Re-review').first()).toBeVisible();
    await page.getByRole('button', { name: 'Show provenance for Lineage Test Plaque (revised)' }).click();
    await expect(page.getByText('Upstream record changed — re-review needed')).toBeVisible();
    await expect(page.getByText('Carried in Arrival / A Light Carried')).toBeVisible();
  });

  test('import generates provenance; re-importing the identical file creates no duplicates', async ({ page }) => {
    await page.goto('/collection');
    const file = {
      name: 'lineage-import.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({
        artifacts: [
          {
            accessionId: 'AF-2027-800',
            title: 'Imported Reliquary Box',
            maker: 'Conservation Studio',
            medium: 'Silver and cedar',
            summary: 'An imported object used to prove batch provenance is created exactly once.',
            width: 22, height: 16, depth: 14, dwellMinutes: 5,
            narrativeRole: 'reflection',
          },
        ],
      })),
    };

    // First import creates exactly one object and records the file as its source.
    await page.getByTestId('artifact-import-input').setInputFiles(file);
    await expect(page.getByText('Imported Reliquary Box').first()).toBeVisible();
    await expect(page.getByTestId('imported-count')).toContainText('1');
    await page.getByRole('button', { name: 'Show provenance for Imported Reliquary Box' }).click();
    await expect(page.getByText(/Imported from lineage-import\.json/)).toBeVisible();
    await page.getByRole('button', { name: 'Close dialog' }).click();

    // Re-import the identical file: idempotent, counts and cards stay the same.
    await page.getByTestId('artifact-import-input').setInputFiles(file);
    await expect(page.getByText(/already imported/i)).toBeVisible();
    await expect(page.getByTestId('imported-count')).toContainText('1');
    await expect(page.getByText('Imported Reliquary Box')).toHaveCount(1);
  });

  test('deleting a source previews the downstream impact and keeps its finding on the review desk flagged', async ({ page }) => {
    await page.goto('/collection');

    // Oral History Tape 12 is placed in "Afterlives" and linked to a critical finding.
    const card = page.locator('.artifact-card', { hasText: 'Oral History Tape 12' });
    await card.getByRole('button', { name: 'Remove Oral History Tape 12' }).click();

    // The delete-impact dialog names the affected placement and finding.
    await expect(page.getByText('DELETE IMPACT')).toBeVisible();
    await expect(page.getByText('Placement in Afterlives')).toBeVisible();
    await expect(page.getByText('Add transcript beside oral history station')).toBeVisible();
    await page.getByRole('button', { name: 'Delete and flag dependents' }).click();

    // Object removed; downstream dependents were flagged, not silently deleted.
    await expect(page.getByText(/removed; dependents flagged/i)).toBeVisible();
    await expect(page.getByText('Oral History Tape 12')).toHaveCount(0);

    // The linked finding REMAINS on the review desk with an explicit
    // "Needs re-review" badge naming the deleted source.
    await page.goto('/review');
    const finding = page.locator('.issue-row', { hasText: 'Add transcript beside oral history station' });
    await expect(finding).toBeVisible();
    await expect(finding.getByText('Needs re-review')).toBeVisible();
    await expect(finding.getByText('Linked object deleted')).toBeVisible();
  });

  test('moving a placement to another zone keeps published packages on the original context and prompts re-review', async ({ page }) => {
    // 1) Resolve all seed findings so the plan can be published. Keep
    // advancing whichever transition is available until none remain.
    await page.goto('/review');
    await page.getByRole('button', { name: /All \d/ }).click();
    for (let index = 0; index < 10; index += 1) {
      const start = page.locator('.issue-row').getByRole('button', { name: 'Start work' }).first();
      const resolve = page.locator('.issue-row').getByRole('button', { name: 'Resolve' }).first();
      if (await start.count() > 0) { await start.click(); continue; }
      if (await resolve.count() > 0) { await resolve.click(); continue; }
      break;
    }
    await page.getByRole('button', { name: 'Run readiness check' }).click();
    await expect(page.getByRole('heading', { name: 'Ready to share' })).toBeVisible();

    // 2) Publish the package: the Oral History Tape placement is in Afterlives.
    await page.getByRole('button', { name: 'Export snapshot' }).click();
    await expect(page.getByText(/Snapshot downloaded/)).toBeVisible();
    const packageRowLink = page.locator('.package-row').first();
    await expect(packageRowLink).toContainText(/Package/);

    // 3) Move Oral History Tape 12 from Afterlives to the Arrival zone.
    await page.goto('/journey');
    await page.getByRole('button', { name: 'Remove Oral History Tape 12' }).click();
    await page.getByRole('button', { name: /Oral History Tape 12/ }).click();
    await page.getByRole('button', { name: /Place Oral History Tape 12 here/ }).first().click();

    // 4) The previously published package now prompts re-review because the
    // archived placement (its original context) is gone from the plan.
    await page.goto('/review');
    const packageRow = page.locator('.package-row').first();
    await expect(packageRow.getByText(/\d+ deleted|re-review/)).toBeVisible();
    await packageRow.click();

    // 5) Its dependency closure still points at the ORIGINAL placement context:
    // the archived (stale) row keeps "Afterlives", distinct from the still-valid
    // Afterlives placement of another object (Mended Serving Bowl).
    const archivedDependency = page.locator('.dependency-row.is-stale', { hasText: 'Placement in Afterlives' });
    await expect(archivedDependency).toBeVisible();
    await expect(archivedDependency).toContainText('Mark reviewed');
  });
});
