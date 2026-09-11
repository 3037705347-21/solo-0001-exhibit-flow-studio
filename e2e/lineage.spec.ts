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

  test('deleting a source previews the downstream impact and flags dependents', async ({ page }) => {
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

    // The review desk publishes the dependency closure panel.
    await page.goto('/review');
    await expect(page.getByText('PUBLISHED PACKAGE DEPENDENCIES')).toBeVisible();
  });
});
