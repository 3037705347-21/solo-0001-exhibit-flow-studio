import { test, expect } from '@playwright/test';

async function openMerge(page: import('@playwright/test').Page) {
  await page.goto('/collection');
  await page.getByRole('button', { name: 'Merge workspace' }).click();
  await expect(page.getByRole('dialog', { name: 'Merge another workspace' })).toBeVisible();
}

async function previewJson(page: import('@playwright/test').Page, payload: unknown) {
  await page.getByLabel('Incoming JSON').fill(JSON.stringify(payload));
  await page.getByRole('button', { name: 'Preview reconciliation' }).click();
}

test.describe('collection merge and reconciliation', () => {
  test('field conflict: resolves per field and keeps the object placed and linked', async ({ page }) => {
    await openMerge(page);
    await previewJson(page, {
      artifacts: [{
        accessionId: 'AF-1908-014',
        title: 'Railway Signal Lamp (Revised)',
        maker: 'H. B. Cooke & Co.',
        medium: 'Brass, glass, cotton wick',
        summary: 'A hand-carried signal lantern whose worn handle records decades of night work along regional rail lines.',
        dimensions: { width: 20, height: 35, depth: 19, unit: 'cm' },
        dwellMinutes: 5,
      }],
    });

    // Three field conflicts are listed with both sides.
    await expect(page.getByText('Field conflict').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Commit merge' })).toBeDisabled();

    // Keep the current title, take incoming dimensions and dwell time.
    const titleRow = page.locator('.merge-field-row', { hasText: 'Title' });
    await titleRow.locator('.merge-cell-current').click();
    const dimensionsRow = page.locator('.merge-field-row', { hasText: 'Dimensions' });
    await dimensionsRow.locator('.merge-cell-incoming').click();
    const dwellRow = page.locator('.merge-field-row', { hasText: 'Dwell time' });
    await dwellRow.locator('.merge-cell-incoming').click();
    await page.getByRole('button', { name: 'Accept merged result' }).click();

    await expect(page.getByRole('button', { name: 'Commit merge' })).toBeEnabled();
    await page.getByRole('button', { name: 'Commit merge' }).click();
    await expect(page.getByText('Merge committed')).toBeVisible();

    // Title preserved from current, dimensions from incoming.
    await expect(page.getByText('Railway Signal Lantern').first()).toBeVisible();
    await expect(page.getByText('Railway Signal Lamp (Revised)')).toHaveCount(0);

    // Placement reference survived: the object is still in the journey.
    await page.goto('/journey');
    await expect(page.getByText('Railway Signal Lantern')).toBeVisible();
  });

  test('reference conflict: dangling finding must be decided before commit', async ({ page }) => {
    await openMerge(page);
    await previewJson(page, {
      artifacts: [],
      findings: [{
        title: 'Finding with a dangling object link',
        description: 'References an accession id that exists on neither side of the merge.',
        severity: 'critical',
        status: 'open',
        owner: 'Imogen Reid',
        artifactAccessionId: 'AF-MISSING-999',
      }],
    });

    await expect(page.locator('.merge-entry').getByText('Reference conflict', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Commit merge' })).toBeDisabled();

    // Import without the broken link.
    await page.getByRole('button', { name: 'Import without link' }).click();
    await page.getByRole('button', { name: 'Commit merge' }).click();
    await expect(page.getByText('Merge committed')).toBeVisible();

    await page.goto('/review');
    await expect(page.getByText('Finding with a dangling object link')).toBeVisible();
  });

  test('identical records confirm cleanly without duplicating anything', async ({ page }) => {
    await openMerge(page);
    await previewJson(page, {
      artifacts: [{
        accessionId: 'AF-1968-117',
        title: 'Kitchen Table Radio',
        maker: 'Morrow Electronics',
        yearLabel: '1968',
        medium: 'Bakelite, copper, fabric',
        origin: 'Detroit, United States',
        summary: 'A domestic radio repaired repeatedly by one family, carrying music and news through three generations.',
        dimensions: { width: 33, height: 22, depth: 18, unit: 'cm' },
        dwellMinutes: 5,
        narrativeRole: 'context',
        sensitivity: 'standard',
        accessibilityNeed: 'audio',
        isKeyObject: false,
        tags: ['sound', 'repair', 'home'],
        color: '#c7903d',
      }],
      findings: [{
        title: 'Add transcript beside oral history station',
        description: 'The current audio treatment needs a synchronized transcript and a printed fallback.',
        severity: 'critical',
        status: 'in-progress',
        owner: 'Mara Chen',
        artifactAccessionId: 'AF-1994-052',
        zoneShortLabel: 'Afterlives',
      }],
    });

    await expect(page.locator('.merge-entry').getByText('Identical', { exact: true })).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Commit merge' })).toBeEnabled();
    await page.getByRole('button', { name: 'Commit merge' }).click();

    // The radio still appears exactly once in the collection.
    await page.goto('/collection');
    await expect(page.getByText('Kitchen Table Radio')).toHaveCount(1);
  });

  test('repeat confirmation: committing the same import twice never duplicates', async ({ page }) => {
    const payload = {
      artifacts: [{
        accessionId: 'AF-2026-777',
        title: 'Repeated Import Vessel',
        maker: 'Merge Studio',
        medium: 'Stoneware',
        summary: 'An incoming record imported twice to prove identity matching prevents duplicates.',
        dimensions: { width: 14, height: 20, depth: 14, unit: 'cm' },
        dwellMinutes: 4,
      }],
      findings: [{
        title: 'Repeated import finding',
        description: 'A finding carried in the same file during both merge attempts.',
        severity: 'note',
        status: 'open',
        owner: 'Merge Studio',
        artifactAccessionId: 'AF-2026-777',
      }],
    };

    // First import: new object and new finding.
    await openMerge(page);
    await previewJson(page, payload);
    await expect(page.locator('.merge-entry').getByText('New object', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Commit merge' }).click();
    await expect(page.getByText('Merge committed')).toBeVisible();
    await expect(page.getByText('Repeated Import Vessel')).toHaveCount(1);

    // Second import of the identical file: everything is recognized as identical.
    await page.getByRole('button', { name: 'Merge workspace' }).click();
    await page.getByLabel('Incoming JSON').fill(JSON.stringify(payload));
    await page.getByRole('button', { name: 'Preview reconciliation' }).click();
    await expect(page.locator('.merge-entry').getByText('Identical', { exact: true })).toHaveCount(2);
    await page.getByRole('button', { name: 'Commit merge' }).click();

    await expect(page.getByText('Repeated Import Vessel')).toHaveCount(1);
    await page.goto('/review');
    await expect(page.getByText('Repeated import finding')).toHaveCount(1);
  });
});
