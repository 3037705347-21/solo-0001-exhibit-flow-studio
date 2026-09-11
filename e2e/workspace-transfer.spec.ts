import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const STORAGE_KEY = 'exhibit-flow.workspace.v1';
const BACKUP_KEY = 'exhibit-flow.workspace.restore-backup.v1';

const SEED_TITLE = 'Afterlight: Material Memory';

interface SeedShape {
  version: number;
  project: Record<string, unknown>;
  artifacts: Array<Record<string, unknown>>;
  zones: Array<Record<string, unknown>>;
  issues: Array<Record<string, unknown>>;
  preferences: Record<string, unknown>;
}

async function readStoredWorkspace(page: Page): Promise<SeedShape> {
  const raw = await page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY);
  expect(raw).toBeTruthy();
  return JSON.parse(raw as string) as SeedShape;
}

async function writeWorkspace(page: Page, workspace: unknown): Promise<void> {
  await page.evaluate(({ key, value }) => window.localStorage.setItem(key, JSON.stringify(value)), { key: STORAGE_KEY, value: workspace });
}

async function setChooserFile(page: Page, payload: unknown): Promise<void> {
  await page.evaluate((content) => {
    const blob = new Blob([content], { type: 'application/json' });
    const file = new File([blob], 'workspace-import.json', { type: 'application/json' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, JSON.stringify(payload));
}

async function openTransfer(page: Page): Promise<void> {
  await page.getByTestId('import-workspace-button').click();
  await expect(page.getByRole('dialog', { name: 'Import, migrate & restore' })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/collection');
});

test('scenario 1: current-version export round trips and keeps every record', async ({ page }) => {
  const exported = page.waitForEvent('download');
  await page.getByTestId('export-workspace-button').click();
  const download = await exported;
  const contents = JSON.parse(readFileSync(await download.path() as string, 'utf8'));
  expect(contents.kind).toBe('exhibit-flow-workspace');
  expect(contents.workspace.version).toBe(2);
  expect(contents.workspace.artifacts).toHaveLength(8);

  await openTransfer(page);
  await setChooserFile(page, contents);

  await expect(page.getByText('v2')).toBeVisible();
  const kept = page.locator('.transfer-count.neutral');
  await expect(kept).toContainText('17 kept');
  await expect(page.locator('.transfer-count.danger')).toContainText('0 invalidated');
  await expect(page.locator('.transfer-count.warning')).toContainText('0 need confirmation');

  await page.getByRole('button', { name: 'Restore workspace' }).click();
  await expect(page.getByText('Workspace restored')).toBeVisible();
  await page.getByRole('button', { name: 'Keep restored workspace' }).click();
  const stored = await readStoredWorkspace(page);
  expect(stored.version).toBe(2);
  expect(stored.artifacts).toHaveLength(8);
});

test('scenario 2: an old version 0 export is migrated through ordered steps', async ({ page }) => {
  const seed = await readStoredWorkspace(page);
  const legacy = {
    project: seed.project,
    artifacts: seed.artifacts,
    zones: seed.zones.map(({ sequence, ...zone }) => { void sequence; return zone; }),
    issues: seed.issues,
    preferences: { pace: 'balanced', accessibilityPriority: 70, groupSize: 6 },
  };

  await openTransfer(page);
  await setChooserFile(page, legacy);

  await expect(page.getByText('v0 (legacy)')).toBeVisible();
  await expect(page.getByText('Legacy workspace normalization')).toBeVisible();
  await expect(page.getByText('Planning preferences expansion')).toBeVisible();
  await expect(page.getByText('Structure and reference integrity')).toBeVisible();
  // New v2 preference defaults appear as "added".
  await expect(page.getByText(/transitionBufferMinutes/)).toBeVisible();

  await page.getByRole('button', { name: 'Restore workspace' }).click();
  await expect(page.getByText('Workspace restored')).toBeVisible();
  await page.getByRole('button', { name: 'Keep restored workspace' }).click();
  const migrated = await readStoredWorkspace(page);
  expect(migrated.version).toBe(2);
  expect(migrated.zones.map((zone) => zone.sequence)).toEqual([0, 1, 2, 3]);
  expect(migrated.preferences.transitionBufferMinutes).toBe(3);
});

test('scenario 3: missing fields are repaired or invalidated before restore', async ({ page }) => {
  const seed = await readStoredWorkspace(page);
  const withGaps = {
    ...seed,
    version: 2,
    artifacts: seed.artifacts.map((artifact, index) => {
      if (index === 0) return { ...artifact, title: '' };
      if (artifact.id === 'artifact-gloves') {
        const { dimensions, ...rest } = artifact;
        void dimensions;
        return rest;
      }
      return artifact;
    }),
  };

  await openTransfer(page);
  await setChooserFile(page, withGaps);

  await expect(page.locator('.transfer-count.danger')).toContainText('1 invalidated');
  await expect(page.locator('.transfer-count.positive')).toContainText(/added/);
  await expect(page.getByText(/Missing title/)).toBeVisible();

  await page.getByRole('button', { name: 'Restore workspace' }).click();
  await page.getByRole('button', { name: 'Keep restored workspace' }).click();
  const restored = await readStoredWorkspace(page);
  expect(restored.artifacts).toHaveLength(7);
  expect(restored.artifacts.find((artifact) => artifact.id === 'artifact-lantern')?.title).toBe('Untitled object');
});

test('scenario 4: broken references require a per-record human decision', async ({ page }) => {
  const seed = await readStoredWorkspace(page);
  const corrupted = {
    ...seed,
    version: 2,
    zones: seed.zones.map((zone, index) => index === 0
      ? { ...zone, artifactIds: [...zone.artifactIds, 'artifact-vanished'] }
      : zone),
    issues: [
      ...seed.issues,
      {
        id: 'issue-broken-zone',
        title: 'Missing zone link',
        description: 'Links to a zone that is not in this file.',
        severity: 'critical',
        status: 'open',
        zoneId: 'zone-vanished',
        owner: 'Tester',
        createdAt: '2026-09-01T10:00:00.000Z',
        updatedAt: '2026-09-01T10:00:00.000Z',
      },
    ],
  };

  await openTransfer(page);
  await setChooserFile(page, corrupted);

  await expect(page.locator('.transfer-count.warning')).toContainText('2 need confirmation');
  const restoreButton = page.getByRole('button', { name: 'Restore workspace' });
  await expect(restoreButton).toBeDisabled();

  // Drop the broken placement link but keep the arrival zone; exclude the finding.
  await page.getByRole('button', { name: 'Drop broken link, keep record' }).first().click();
  await page.getByRole('button', { name: 'Exclude record' }).last().click();
  await expect(restoreButton).toBeEnabled();
  await restoreButton.click();
  await page.getByRole('button', { name: 'Keep restored workspace' }).click();

  const restored = await readStoredWorkspace(page);
  expect(restored.zones[0].artifactIds).not.toContain('artifact-vanished');
  expect(restored.issues.find((issue) => issue.id === 'issue-broken-zone')).toBeUndefined();
});

test('scenario 5: an interrupted restore rolls back automatically on next load', async ({ page }) => {
  const seed = await readStoredWorkspace(page);
  const interrupted = {
    ...seed,
    project: { ...seed.project, title: 'PARTIALLY RESTORED PLAN' },
  };
  await page.evaluate(({ mainKey, backupKey, previous, current }) => {
    window.localStorage.setItem(mainKey, JSON.stringify(current));
    window.localStorage.setItem(backupKey, JSON.stringify({ savedAt: '2026-09-11T09:00:00.000Z', serialized: JSON.stringify(previous) }));
  }, { mainKey: STORAGE_KEY, backupKey: BACKUP_KEY, previous: seed, current: interrupted });

  await page.reload();

  await expect(page.getByText('rolled back automatically')).toBeVisible();
  expect(await page.locator('.project-name').textContent()).toContain(SEED_TITLE);
  const stored = await readStoredWorkspace(page);
  expect(stored.project.title).toBe(SEED_TITLE);
  const backupExists = await page.evaluate((key) => window.localStorage.getItem(key) !== null, BACKUP_KEY);
  expect(backupExists).toBe(false);
});

test('scenario 5b: a failed write leaves the current workspace usable inside the modal', async ({ page }) => {
  const seed = await readStoredWorkspace(page);
  await writeWorkspace(page, seed);

  // Freeze storage writes before opening the modal: backup creation must fail
  // and the restore must not start.
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === 'exhibit-flow.workspace.restore-backup.v1') throw new DOMException('denied', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });

  await openTransfer(page);
  await setChooserFile(page, seed);
  await page.getByRole('button', { name: 'Restore workspace' }).click();

  await expect(page.getByText(/safety backup could not be stored|current workspace is unchanged/)).toBeVisible();
  expect(await page.locator('.project-name').textContent()).toContain(SEED_TITLE);
});
