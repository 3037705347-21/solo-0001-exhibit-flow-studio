import { test, expect } from '@playwright/test';

test.describe('legacy workspace upgrade', () => {
  test('wraps a pre-coordination bare document and keeps autosaves revisioned', async ({ page, context }) => {
    await page.goto('/collection');
    // On an empty profile the seed is held in memory; trigger one autosave to materialize it.
    await page.getByRole('button', { name: 'Edit' }).first().click();
    await page.getByLabel('Maker / source').fill('seed capture');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Object details updated.')).toBeVisible();
    const envelope = await page.evaluate(() => localStorage.getItem('exhibit-flow.workspace.v1'));
    expect(envelope).not.toBeNull();
    // Reformat the saved document as a pre-coordination bare v1 document.
    const bare = JSON.stringify(JSON.parse(envelope!).workspace);
    await page.evaluate((raw) => localStorage.setItem('exhibit-flow.workspace.v1', raw), bare);

    await page.goto('/collection');
    await expect(page.getByText('Afterlight: Material Memory').first()).toBeVisible();

    // First autosave after upgrade (opening an editor is not a write; use an edit)
    await page.getByRole('button', { name: 'Edit' }).first().click();
    await page.getByLabel('Maker / source').fill('Upgraded Workshop');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Object details updated.')).toBeVisible();

    const afterEdit = await page.evaluate(() => JSON.parse(localStorage.getItem('exhibit-flow.workspace.v1')!));
    expect(afterEdit.format).toBe('exhibit-flow-workspace');
    expect(afterEdit.formatVersion).toBe(2);
    expect(afterEdit.revision).toBeGreaterThanOrEqual(2);
    expect(afterEdit.workspace.artifacts[0].maker).toBe('Upgraded Workshop');

    // Data survives a refresh and stays revisioned.
    await page.reload();
    await expect(page.getByText('Upgraded Workshop').first()).toBeVisible();
    const afterReload = await page.evaluate(() => JSON.parse(localStorage.getItem('exhibit-flow.workspace.v1')!));
    expect(afterReload.revision).toBe(afterEdit.revision);

    // A second tab opened on the upgraded document coordinates normally.
    const tabB = await context.newPage();
    await tabB.goto('/collection');
    await expect(tabB.getByText('Upgraded Workshop').first()).toBeVisible();
  });
});
