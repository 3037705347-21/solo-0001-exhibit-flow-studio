import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import {
  brokenReferencesFile,
  currentVersionFile,
  interruptedFile,
  missingFieldsFile,
  oldVersionFile,
  snapshotFile,
} from './fixtures/workspaceFiles';

async function openBackupCenter(page: Page) {
  await page.getByRole('button', { name: 'Backup & restore' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Migrate and restore a workspace' })).toBeVisible();
}

async function chooseFile(page: Page, contents: string, name: string) {
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Choose JSON file' }).click(),
  ]);
  await fileChooser.setFiles({ name, mimeType: 'application/json', buffer: Buffer.from(contents) });
}

test.describe('versioned workspace migration and recovery', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/collection');
  });

  test('current version: imports, restores, and re-exports a re-importable file', async ({ page }) => {
    await openBackupCenter(page);
    await chooseFile(page, currentVersionFile(), 'current-v2.json');

    await expect(page.getByText('Source version 2')).toBeVisible();
    await expect(page.getByText('Current format', { exact: true })).toBeVisible();
    const kept = page.locator('.counter-positive strong');
    await expect(kept).toHaveText(/\d+/);

    await page.getByRole('button', { name: 'Review plan and restore' }).click();
    await expect(page.getByRole('heading', { name: 'Workspace restored' })).toBeVisible();

    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByText('Current Version Vase')).toBeVisible();
    await expect(page.getByText('Recovery Fixture Exhibition')).toBeVisible();
    await expect(page.getByText('Recovered from v2')).toBeVisible();

    // Re-export and confirm the file is a valid v2 envelope.
    const downloadPromise = page.waitForEvent('download');
    await openBackupCenter(page);
    await page.getByRole('button', { name: 'Download file' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^exhibit-flow-workspace-.*\.json$/);
    const path = await download.path();
    expect(path).toBeTruthy();
    const text = readFileSync(path as string, 'utf8');
    const parsed = JSON.parse(text);
    expect(parsed.kind).toBe('exhibit-flow.workspace-file');
    expect(parsed.fileVersion).toBe(2);
    expect(parsed.workspace.project.title).toBe('Recovery Fixture Exhibition');
  });

  test('old version: shows ordered v0 -> v1 -> v2 migration steps and converts dwell seconds', async ({ page }) => {
    await openBackupCenter(page);
    await chooseFile(page, oldVersionFile(), 'old-v0.json');

    await expect(page.getByText('Source version 0')).toBeVisible();
    await expect(page.getByText(/convert dwell seconds to minutes/i)).toBeVisible();
    await expect(page.getByText(/Add plan codes/i)).toBeVisible();
    await expect(page.getByText('Dwell time converted from 240 seconds to 4 minutes').first()).toBeVisible();

    await page.getByRole('button', { name: 'Review plan and restore' }).click();
    await expect(page.getByRole('heading', { name: 'Workspace restored' })).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();

    await page.goto('/collection');
    await expect(page.getByText('Old Format Lantern')).toBeVisible();
    await expect(page.getByText('Recovered from v0')).toBeVisible();
  });

  test('missing fields: flags defaults for confirmation and still produces a valid plan', async ({ page }) => {
    await openBackupCenter(page);
    await chooseFile(page, missingFieldsFile(), 'missing-fields-v1.json');

    await expect(page.getByText('Source version 1')).toBeVisible();
    await expect(page.getByText('Fragment Without Fields').first()).toBeVisible();
    await expect(page.getByText(/3 minutes is assumed/i)).toBeVisible();
    await expect(page.getByText('Finding Without Owner').first()).toBeVisible();
    await expect(page.getByText('Unnamed zone')).toBeVisible();

    await page.getByRole('button', { name: 'Review plan and restore' }).click();
    await expect(page.getByRole('heading', { name: 'Workspace restored' })).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByText('Fragment Without Fields')).toBeVisible();
  });

  test('broken references: invalidates dangling and duplicate references on restore', async ({ page }) => {
    await openBackupCenter(page);
    await chooseFile(page, brokenReferencesFile(), 'broken-refs-v1.json');

    await expect(page.getByText(/References object "ghost-artifact"/)).toBeVisible();
    await expect(page.getByText(/listed more than once/)).toBeVisible();
    await expect(page.getByText(/Linked zone "ghost-zone"/)).toBeVisible();

    await page.getByRole('button', { name: 'Review plan and restore' }).click();
    await expect(page.getByRole('heading', { name: 'Workspace restored' })).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();

    // The restored workspace loads cleanly after a reload (persisted state is valid).
    await page.reload();
    await expect(page.getByText('Referenced Lantern')).toBeVisible();
    await expect(page.getByText('Recovery Fixture Exhibition')).toBeVisible();
  });

  test('interrupted recovery: refusing a snapshot keeps the workspace, and rollback restores the prior plan', async ({ page }) => {
    // Snapshot imports must be rejected before anything is written.
    await openBackupCenter(page);
    await chooseFile(page, snapshotFile(), 'snapshot.json');
    await expect(page.getByRole('alert')).toContainText(/readiness snapshot/);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('Afterlight: Material Memory')).toBeVisible();

    // Commit a valid recovery, then roll it back: the original workspace returns.
    await openBackupCenter(page);
    await chooseFile(page, interruptedFile(), 'interrupt-v2.json');
    await page.getByRole('button', { name: 'Review plan and restore' }).click();
    await expect(page.getByRole('heading', { name: 'Workspace restored' })).toBeVisible();
    await page.getByRole('button', { name: 'Roll back recovery' }).click();
    await expect(page.getByText('Afterlight: Material Memory')).toBeVisible();
    await expect(page.getByText('Recovery Fixture Exhibition')).toHaveCount(0);
  });
});
