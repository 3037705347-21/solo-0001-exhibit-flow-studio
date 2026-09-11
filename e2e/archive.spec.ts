import { expect, test } from '@playwright/test';

/**
 * The archive proves idempotency by content identity: the same plan under a
 * different file name or with a changed export time collapses onto one record,
 * while real content changes open a new, explicitly-linked version.
 */

interface SnapshotOverrides {
  generatedAt?: string;
  title?: string;
  readinessScore?: number;
  artifactCount?: number;
  projectId?: string;
  lastReadinessCheck?: string;
}

function makeSnapshot({
  generatedAt = '2026-09-01T10:00:00.000Z',
  title = 'Afterlight: Material Memory',
  readinessScore = 94,
  artifactCount = 2,
  projectId = 'project-afterlight',
  lastReadinessCheck,
}: SnapshotOverrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt,
    project: {
      id: projectId,
      title,
      venue: 'North Hall / Gallery 3',
      audience: 'General visitors',
      openingDate: '2027-03-18',
      stage: 'ready',
      ...(lastReadinessCheck ? { lastReadinessCheck } : {}),
    },
    summary: { artifactCount, zoneCount: 1, visitMinutes: 12, readinessScore },
    zones: [
      {
        id: 'zone-common',
        name: 'The Common Thread',
        shortLabel: 'Common',
        thesis: 'Shared making',
        capacityMinutes: 60,
        maxObjects: 10,
        lowLight: false,
        hasSeating: true,
        color: '#7c6aa6',
        sequence: 0,
        artifactIds: ['artifact-press'],
        artifacts: [
          {
            id: 'artifact-press',
            accessionId: 'AF-1952-088',
            title: 'Portable Letterpress',
            maker: 'Shinsei Works',
            yearLabel: '1952',
            medium: 'Metal',
            origin: 'Osaka',
            summary: 'A travelling press.',
            dimensions: { width: 30, height: 25, depth: 20, unit: 'cm' },
            dwellMinutes: 12,
            narrativeRole: 'turning-point',
            sensitivity: 'standard',
            accessibilityNeed: 'none',
            isKeyObject: true,
            tags: ['print'],
            color: '#2f7c75',
            createdAt: '2026-08-01T09:00:00.000Z',
            updatedAt: '2026-08-01T09:00:00.000Z',
          },
        ],
      },
    ],
    unresolvedIssues: [],
  };
}

test.beforeEach(async ({ page }) => {
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('/archive');
});

test('same content imported under different file names stays one archive', async ({ page }) => {
  const input = page.getByTestId('archive-file-input');
  await expect(page.getByText('No archived plans yet')).toBeVisible();

  await input.setInputFiles({ name: 'exhibit-flow-snapshot-2026-09-01.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(makeSnapshot())) });
  await expect(page.getByRole('heading', { name: 'Afterlight: Material Memory' })).toBeVisible();
  await expect(page.getByText('v1')).toBeVisible();

  // Identical bytes, different file name: idempotent — no second record.
  await input.setInputFiles({ name: 'forwarded-by-email-copy.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(makeSnapshot())) });
  await expect(page.getByText(/Already archived/)).toBeVisible();

  const lineage = page.getByRole('region', { name: 'Archived plan Afterlight: Material Memory' });
  await expect(lineage.locator('.archive-version-row')).toHaveCount(1);
  await expect(lineage.getByText(/imported 2×/)).toBeVisible();
});

test('a changed export time does not create a duplicate', async ({ page }) => {
  const input = page.getByTestId('archive-file-input');
  await input.setInputFiles({ name: 'snapshot-september.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(makeSnapshot({ generatedAt: '2026-09-01T10:00:00.000Z' }))) });
  await input.setInputFiles({
    name: 'snapshot-october.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(makeSnapshot({
      generatedAt: '2026-10-15T08:30:00.000Z',
      lastReadinessCheck: '2026-10-15T08:30:00.000Z',
    }))),
  });
  await expect(page.getByText(/Already archived/)).toBeVisible();
  const lineage = page.getByRole('region', { name: 'Archived plan Afterlight: Material Memory' });
  await expect(lineage.locator('.archive-version-row')).toHaveCount(1);
  // The frozen export date of the first import is preserved.
  await expect(lineage.getByText(/Exported Sep 1, 2026/)).toBeVisible();
});

test('changed business fields become a new version that shows what it replaces', async ({ page }) => {
  const input = page.getByTestId('archive-file-input');
  await input.setInputFiles({ name: 'v1.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(makeSnapshot({ readinessScore: 94 }))) });
  await input.setInputFiles({ name: 'v2.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(makeSnapshot({ readinessScore: 71, artifactCount: 3 }))) });

  await expect(page.getByText(/Archived as v2, replacing v1/)).toBeVisible();
  const lineage = page.getByRole('region', { name: 'Archived plan Afterlight: Material Memory' });
  await expect(lineage.locator('.archive-version-row')).toHaveCount(2);
  await expect(lineage.getByTestId('supersede-note')).toContainText('Replaces v1');
  await expect(lineage.getByText('Current version')).toBeVisible();
});

test('double-clicking import on the same file is idempotent', async ({ page }) => {
  const input = page.getByTestId('archive-file-input');
  const file = { name: 'same.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(makeSnapshot())) };
  await input.setInputFiles(file);
  // Selecting the same file twice (as a user repeatedly clicking import) must
  // still collapse onto a single record.
  await input.setInputFiles(file);
  await input.setInputFiles(file);
  const lineage = page.getByRole('region', { name: 'Archived plan Afterlight: Material Memory' });
  await expect(lineage.locator('.archive-version-row')).toHaveCount(1);
  await expect(lineage.getByText(/imported 3×/)).toBeVisible();
});

test('archived versions survive reload in stable order with the sort preference', async ({ page }) => {
  const input = page.getByTestId('archive-file-input');
  await input.setInputFiles({ name: 'a.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(makeSnapshot({ projectId: 'plan-b', title: 'Zircon Findings', generatedAt: '2026-08-01T10:00:00.000Z' }))) });
  await input.setInputFiles({ name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(makeSnapshot({ projectId: 'plan-a', title: 'Amber Opening', generatedAt: '2026-07-01T10:00:00.000Z' }))) });

  await page.getByRole('button', { name: 'Plan title A–Z' }).click();
  const cards = page.locator('.archive-lineage');
  await expect(cards.first()).toContainText('Amber Opening');
  await expect(cards.nth(1)).toContainText('Zircon Findings');

  await page.reload();
  const cardsAfter = page.locator('.archive-lineage');
  await expect(cardsAfter.first()).toContainText('Amber Opening');
  await expect(page.getByRole('button', { name: 'Plan title A–Z' })).toHaveAttribute('aria-pressed', 'true');
});

test('reopen shows the frozen snapshot and export uses the frozen date', async ({ page }) => {
  const input = page.getByTestId('archive-file-input');
  await input.setInputFiles({ name: 'snap.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(makeSnapshot())) });

  await page.getByRole('button', { name: 'Reopen' }).click();
  const dialog = page.getByRole('dialog', { name: 'Afterlight: Material Memory' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('The Common Thread')).toBeVisible();
  await expect(dialog).toContainText('Sep 1, 2026');

  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export snapshot' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('exhibit-flow-snapshot-2026-09-01.json');
});

test('deleting an archive never touches the live workspace and re-import rebuilds it', async ({ page }) => {
  const input = page.getByTestId('archive-file-input');
  await input.setInputFiles({ name: 'snap.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(makeSnapshot({ readinessScore: 94 }))) });
  await input.setInputFiles({ name: 'snap2.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(makeSnapshot({ readinessScore: 71 }))) });

  const lineage = page.getByRole('region', { name: 'Archived plan Afterlight: Material Memory' });
  await expect(lineage.locator('.archive-version-row')).toHaveCount(2);

  // Delete the newest version (v2); its predecessor stays reachable.
  await page.getByRole('button', { name: 'Delete archived v2' }).click();
  await page.getByRole('button', { name: 'Delete archived version' }).click();
  await expect(lineage.locator('.archive-version-row')).toHaveCount(1);
  await expect(page.locator('.toast', { hasText: /live workspace/ })).toBeVisible();

  // The live workspace is the seeded review-desk plan, untouched by archiving.
  await page.goto('/collection');
  await expect(page.getByText('Railway Signal Lantern').first()).toBeVisible();

  // Re-import the deleted content: it rebuilds with the same identity, v2 and
  // its replacement link come back.
  await page.goto('/archive');
  await input.setInputFiles({ name: 'snap2-renamed.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(makeSnapshot({ readinessScore: 71 }))) });
  const restored = page.getByRole('region', { name: 'Archived plan Afterlight: Material Memory' });
  await expect(restored.locator('.archive-version-row')).toHaveCount(2);
  await expect(restored.getByTestId('supersede-note')).toContainText('Replaces v1');
});

test('deleting a middle version keeps surviving references meaningful until re-import', async ({ page }) => {
  const input = page.getByTestId('archive-file-input');
  await input.setInputFiles({ name: 'v1.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(makeSnapshot({ readinessScore: 94 }))) });
  await input.setInputFiles({ name: 'v2.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(makeSnapshot({ readinessScore: 80 }))) });
  await input.setInputFiles({ name: 'v3.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(makeSnapshot({ readinessScore: 66 }))) });

  const lineage = page.getByRole('region', { name: 'Archived plan Afterlight: Material Memory' });
  await expect(lineage.locator('.archive-version-row')).toHaveCount(3);

  // Remove the middle version; v3 still records that it replaced something.
  await page.getByRole('button', { name: 'Delete archived v2' }).click();
  await page.getByRole('button', { name: 'Delete archived version' }).click();
  await expect(lineage.locator('.archive-version-row')).toHaveCount(2);
  await expect(lineage.getByTestId('supersede-dangling')).toContainText('has since been deleted');
  // v1 is still correctly described as the first version (not a dangling link).
  await expect(lineage.getByText('First archived version of this plan')).toBeVisible();

  // Reopen v3: the modal explains the dangling reference instead of claiming first version.
  const rows = lineage.locator('.archive-version-row');
  await rows.filter({ hasText: 'Current version' }).getByRole('button', { name: 'Reopen' }).click();
  const dialog = page.getByRole('dialog', { name: 'Afterlight: Material Memory' });
  await expect(dialog).toContainText('has since been deleted');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();

  // Rebuild v2 from the same content: the full replacement chain is restored.
  await input.setInputFiles({ name: 'v2-restored.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(makeSnapshot({ readinessScore: 80 }))) });
  await expect(lineage.locator('.archive-version-row')).toHaveCount(3);
  await expect(lineage.getByTestId('supersede-dangling')).toHaveCount(0);
});

test('an invalid file is rejected without adding a record', async ({ page }) => {
  const input = page.getByTestId('archive-file-input');
  await input.setInputFiles({ name: 'not-a-snapshot.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ hello: 'world' })) });
  await expect(page.getByText(/not a valid ExhibitFlow snapshot/)).toBeVisible();
  await expect(page.getByText('No archived plans yet')).toBeVisible();
});
