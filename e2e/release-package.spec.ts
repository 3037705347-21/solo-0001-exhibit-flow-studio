import { expect, test } from '@playwright/test';

test('publishes an immutable release package and tracks drift after later edits', async ({ page }) => {
  await page.goto('/review');

  // The seeded critical finding is in progress; resolve it via the scoped action button
  // (the "Resolved" status filter also contains the word "Resolve", so scope the click).
  const criticalArticle = page.locator('article').filter({ hasText: 'Add transcript beside oral history station' });
  await criticalArticle.getByRole('button', { name: 'Resolve', exact: true }).click();
  await page.getByRole('button', { name: 'Run readiness check' }).click();
  await expect(page.getByRole('heading', { name: 'Ready to share' })).toBeVisible();

  // Freeze the current plan as the first release package.
  await page.getByRole('button', { name: 'Publish release package' }).click();
  const viewer = page.getByRole('dialog');
  await expect(viewer.getByRole('heading', { name: 'REL-0001' })).toBeVisible();
  await expect(viewer.getByText('Matches the current workspace')).toBeVisible();
  await expect(viewer.getByText('Railway Signal Lantern', { exact: true })).toBeVisible();
  await expect(viewer.getByText('READINESS SUMMARY AT FREEZE')).toBeVisible();
  await viewer.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(viewer).not.toBeVisible();

  // The package is stored with the workspace as REL-0001 and currently matches the plan.
  const registry = page.getByRole('region', { name: 'Published release packages' });
  await expect(registry.getByRole('button', { name: /REL-0001/ })).toBeVisible();
  await expect(registry.getByText('All current')).toBeVisible();

  // Editing an object in the collection does not rewrite the frozen package.
  await page.goto('/collection');
  await page.getByRole('button', { name: 'Edit' }).first().click();
  const titleField = page.getByLabel('Title');
  await titleField.fill('Railway Signal Lantern — Retitled');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Object details updated.')).toBeVisible();

  // Only the edited object invalidates the package at this point (no phantom finding drift).
  await page.goto('/review');
  await expect(registry.getByText('1 record drifted')).toBeVisible();

  // Reopen the resolved critical finding so the package drifts on findings too
  // and the plan falls back behind the readiness gate.
  await page.locator('article').filter({ hasText: 'Add transcript beside oral history station' })
    .getByRole('button', { name: 'Reopen', exact: true }).click();
  await expect(registry.getByText('2 records drifted')).toBeVisible();

  // Reopening the package shows exactly which records invalidated it.
  await registry.getByRole('button', { name: /REL-0001/ }).click();
  await expect(viewer).toBeVisible();
  await expect(viewer.getByText('Workspace has drifted')).toBeVisible();
  await expect(viewer.getByText('Edited · title')).toBeVisible();
  await expect(viewer.getByText('Edited · status')).toBeVisible();
  // The frozen content itself is untouched (the drift row carries the accession suffix).
  await expect(viewer.getByText('Railway Signal Lantern', { exact: true })).toBeVisible();
  await viewer.getByRole('button', { name: 'Close', exact: true }).click();

  // History survives a reload and the drift badge persists.
  await page.reload();
  const reloadedRegistry = page.getByRole('region', { name: 'Published release packages' });
  await expect(reloadedRegistry.getByRole('button', { name: /REL-0001/ })).toBeVisible();
  await expect(reloadedRegistry.getByText('2 records drifted')).toBeVisible();

  // Readiness has regressed, so the gate cannot be bypassed by another publish attempt.
  await expect(page.getByRole('button', { name: 'Publish release package' })).not.toBeVisible();
  await expect(page.getByText('Still needs attention')).toBeVisible();
});

test('opens a legacy snapshot export and reads it read-only', async ({ page }) => {
  await page.goto('/review');
  await page.getByRole('button', { name: 'Open legacy snapshot' }).click();
  const fileInput = page.locator('input.release-file-input');
  await fileInput.setInputFiles({
    name: 'exhibit-flow-snapshot-2026-08-30.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-08-30T10:00:00.000Z',
      project: {
        id: 'project-afterlight',
        title: 'Afterlight: Material Memory',
        venue: 'North Hall / Gallery 3',
        audience: 'General visitors, age 12+',
        openingDate: '2027-03-18',
        stage: 'ready',
        lastReadinessCheck: '2026-08-30T10:00:00.000Z',
      },
      summary: { artifactCount: 1, zoneCount: 1, visitMinutes: 4, readinessScore: 100 },
      zones: [{
        id: 'zone-arrival',
        name: 'Arrival / A Light Carried',
        shortLabel: 'Arrival',
        thesis: 'Material memory begins with an object carried through work and darkness.',
        capacityMinutes: 10,
        maxObjects: 3,
        lowLight: false,
        hasSeating: false,
        color: '#d7654e',
        sequence: 0,
        artifactIds: ['artifact-lantern'],
        artifacts: [{
          id: 'artifact-lantern',
          accessionId: 'AF-1908-014',
          title: 'Railway Signal Lantern',
          maker: 'H. B. Cooke & Co.',
          yearLabel: 'c. 1908',
          medium: 'Brass, glass, cotton wick',
          origin: 'York, England',
          summary: 'A hand-carried signal lantern whose worn handle records decades of night work along regional rail lines.',
          dimensions: { width: 19, height: 34, depth: 18, unit: 'cm' },
          dwellMinutes: 4,
          narrativeRole: 'threshold',
          sensitivity: 'standard',
          accessibilityNeed: 'none',
          isKeyObject: true,
          tags: ['labor', 'light', 'rail'],
          color: '#d7654e',
          createdAt: '2026-08-11T09:00:00.000Z',
          updatedAt: '2026-08-11T09:00:00.000Z',
        }],
      }],
      unresolvedIssues: [],
    })),
  });
  const viewer = page.getByRole('dialog');
  await expect(viewer.getByRole('heading', { name: 'Legacy snapshot' })).toBeVisible();
  await expect(viewer.getByText('This snapshot predates release packages')).toBeVisible();
  await expect(viewer.getByText('Railway Signal Lantern', { exact: true })).toBeVisible();
  await expect(viewer.getByText('READINESS SUMMARY AT FREEZE')).toHaveCount(0);
  await expect(viewer.getByText('Matches the current workspace')).toBeVisible();
});
