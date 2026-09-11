import { test, expect, type Page } from '@playwright/test';

/**
 * Two browser tabs work on the same exhibition. A stale tab must detect that
 * the workspace moved forward, show both sides of the change, and let the user
 * reload or replay ("redo") without silently overwriting the other tab.
 */

async function resetSamplePlan(page: Page) {
  await page.goto('/collection');
  // Existing persisted state from other specs would skew the scenario.
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await expect(page.getByText('Afterlight: Material Memory').first()).toBeVisible();
}

test.describe('cross-tab workspace version coordination', () => {
  test.beforeEach(async ({ page }) => {
    await resetSamplePlan(page);
  });

  test('object edit in tab B is visible to a stale tab A and can be redone', async ({ context }) => {
    const tabA = await context.newPage();
    const tabB = await context.newPage();
    await tabA.goto('/collection');
    await tabB.goto('/collection');

    // Tab A starts editing first: the base revision is pinned while the editor is open.
    await tabA.getByRole('button', { name: 'Edit' }).first().click();
    await tabA.getByLabel('Maker / source').fill('Tab A Workshop');

    // Tab B edits the same object and saves while A's editor stays open.
    await tabB.getByRole('button', { name: 'Edit' }).first().click();
    await tabB.getByLabel('Maker / source').fill('Cooke & Sons (Tab B)');
    await tabB.getByRole('button', { name: 'Save changes' }).click();
    await expect(tabB.getByText('Object details updated.')).toBeVisible();

    // Tab A submits its older-based edit and must see the conflict instead of overwriting.
    await tabA.getByRole('button', { name: 'Save changes' }).click();
    await expect(tabA.getByRole('dialog', { name: 'Another tab moved the workspace forward' })).toBeVisible();
    const dialog = tabA.getByRole('dialog');
    await expect(dialog.getByText('YOUR UNSAVED CHANGE')).toBeVisible();
    await expect(dialog.getByText('SAVED IN THE OTHER TAB')).toBeVisible();
    await expect(dialog.getByText('Railway Signal Lantern').first()).toBeVisible();
    await expect(dialog.getByText('Maker').first()).toBeVisible();
    await expect(dialog.getByText(/Overlapping records detected/)).toBeVisible();

    // Redo is gated behind an explicit confirmation because the records overlap.
    const redo = dialog.getByRole('button', { name: 'Redo my change' });
    await expect(redo).toBeDisabled();
    await dialog.getByRole('checkbox', { name: /I have compared the changes/ }).check();
    await redo.click();
    await expect(dialog).toBeHidden();
    // The replay kept the other tab's finding/placement data and applied the local edit.
    await expect(tabA.getByText('Tab A Workshop').first()).toBeVisible();

    // Revision survives reload in both tabs.
    for (const page of [tabA, tabB]) {
      await page.reload();
      await expect(page.getByText('Tab A Workshop').first()).toBeVisible();
    }
  });

  test('placement changes alternate between tabs and non-overlapping changes replay automatically', async ({ context }) => {
    const tabA = await context.newPage();
    const tabB = await context.newPage();
    await tabA.goto('/journey');
    await tabB.goto('/journey');

    // Tab A arms a placement first: selecting an object pins the base revision.
    await tabA.getByRole('button', { name: /Conservator’s Gloves/ }).click();

    // Tab B moves a different already-placed object: Sample Book down within Patterns.
    await tabB.getByRole('button', { name: 'Move Dyer’s Sample Book down' }).click();
    await expect(tabB.getByText('Object sequence could not be changed')).toHaveCount(0);

    // Tab A now places Gloves into Arrival against the older base — conflict, not overwrite.
    await tabA.getByRole('button', { name: /Place Conservator’s Gloves here/ }).first().click();
    const dialog = tabA.getByRole('dialog', { name: 'Another tab moved the workspace forward' });
    await expect(dialog).toBeVisible();
    await expect(tabA.getByText('YOUR UNSAVED CHANGE')).toBeVisible();
    await expect(dialog.getByText(/Conservator.*Gloves/)).toBeVisible();
    await expect(dialog.getByText('Dyer’s Sample Book')).toBeVisible();
    // Different records: no overlap, so redo is immediately available.
    await dialog.getByRole('button', { name: 'Redo my change' }).click();

    // Both placements are present after replay: Gloves (local) and reorder (remote).
    const arrival = tabA.locator('.zone-lane').filter({ hasText: 'Arrival / A Light Carried' });
    await expect(arrival.getByText(/Conservator’s Gloves/)).toBeVisible();

    // Refresh keeps every placement change in both tabs.
    for (const page of [tabA, tabB]) {
      await page.reload();
      const lane = page.locator('.zone-lane').filter({ hasText: 'Arrival / A Light Carried' });
      await expect(lane.getByText(/Conservator’s Gloves/)).toBeVisible();
    }
  });

  test('a finding created against an older revision is replayed on top of a newer resolution', async ({ context }) => {
    const tabA = await context.newPage();
    const tabB = await context.newPage();
    await tabA.goto('/review');
    await tabB.goto('/review');

    // Tab A opens the new-finding editor first: its base revision is pinned for the interaction.
    await tabA.getByRole('button', { name: 'New finding' }).click();
    await tabA.getByLabel('Finding title').fill('Cross-tab lighting note');
    await tabA.getByLabel('Owner').fill('Tab A Curator');
    await tabA.getByLabel('Context and next step').fill('Need a documented lux plan for the rotated textile.');

    // Tab B resolves the in-progress critical finding while A's editor is open.
    const criticalRow = tabB.locator('.issue-row', { hasText: 'Add transcript beside oral history station' });
    await criticalRow.getByRole('button', { name: 'Resolve' }).click();
    await expect(criticalRow.getByText('Resolved')).toBeVisible();

    // Tab A submits its finding against the older revision and must see the conflict.
    await tabA.getByRole('button', { name: 'Create finding' }).click();
    const dialog = tabA.getByRole('dialog', { name: 'Another tab moved the workspace forward' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Cross-tab lighting note')).toBeVisible();
    await expect(dialog.getByText('Add transcript beside oral history station')).toBeVisible();
    // Different records: replay needs no extra confirmation.
    await dialog.getByRole('button', { name: 'Redo my change' }).click();

    // Replay keeps the other tab's resolution and adds the new finding.
    await expect(tabA.locator('.issue-row', { hasText: 'Cross-tab lighting note' })).toBeVisible();
    await expect(tabA.locator('.issue-row', { hasText: 'Add transcript beside oral history station' }).getByText('Resolved').first()).toBeVisible();

    // Refresh keeps both sides of the merge in both tabs.
    for (const page of [tabA, tabB]) {
      await page.reload();
      await expect(page.locator('.issue-row', { hasText: 'Cross-tab lighting note' })).toBeVisible();
      await expect(page.locator('.issue-row', { hasText: 'Add transcript beside oral history station' }).getByText('Resolved').first()).toBeVisible();
    }
  });

  test('the conflict comparison shows original, local and remote values side by side', async ({ context }) => {
    const tabA = await context.newPage();
    const tabB = await context.newPage();
    await tabA.goto('/collection');
    await tabB.goto('/collection');

    // Both tabs start editing the Lantern before either saves, pinning the same base revision.
    await tabA.getByRole('button', { name: 'Edit' }).first().click();
    await tabA.getByLabel('Maker / source').fill('Local workshop value');

    await tabB.getByRole('button', { name: 'Edit' }).first().click();
    await tabB.getByLabel('Maker / source').fill('Remote workshop value');
    await tabB.getByLabel('Dwell time (min)').fill('9');
    await tabB.getByRole('button', { name: 'Save changes' }).click();
    await expect(tabB.getByText('Object details updated.')).toBeVisible();

    await tabA.getByRole('button', { name: 'Save changes' }).click();
    const dialog = tabA.getByRole('dialog', { name: 'Another tab moved the workspace forward' });
    await expect(dialog).toBeVisible();

    // The dedicated overlap table shows the original value and each tab's competing new value.
    await expect(dialog.getByRole('columnheader', { name: 'Original value' })).toBeVisible();
    await expect(dialog.getByRole('columnheader', { name: 'Your tab' })).toBeVisible();
    await expect(dialog.getByRole('columnheader', { name: 'Other tab (saved)' })).toBeVisible();

    const makerRow = dialog.locator('tr', { has: tabA.getByRole('rowheader', { name: 'Maker' }) });
    await expect(makerRow.getByText('H. B. Cooke & Co.')).toBeVisible();
    await expect(makerRow.getByText('Local workshop value')).toBeVisible();
    await expect(makerRow.getByText('Remote workshop value')).toBeVisible();

    // A field changed only by the other tab still displays base vs new (your side unchanged).
    const dwellRow = dialog.locator('tr', { has: tabA.getByRole('rowheader', { name: 'Dwell time' }) });
    await expect(dwellRow.locator('.conflict-cell-base')).toHaveText('4 min');
    await expect(dwellRow.locator('.conflict-cell-local')).toHaveText('4 min');
    await expect(dwellRow.locator('.conflict-cell-remote')).toHaveText('9 min');

    // The side columns are visually distinct and the redo stays gated until comparison is acknowledged.
    const redo = dialog.getByRole('button', { name: 'Redo my change' });
    await expect(redo).toBeDisabled();
    await dialog.getByRole('checkbox', { name: /I have compared the changes/ }).check();
    await expect(redo).toBeEnabled();
  });

  test('an unreadable saved document is preserved in both tabs after acknowledgement', async ({ context }) => {
    const tabA = await context.newPage();
    const tabB = await context.newPage();
    await tabA.goto('/collection');
    await tabB.goto('/collection');

    // Corrupt the saved document in every open tab and reload them: both must detect it.
    const broken = '{ this is not a valid workspace document';
    await tabA.evaluate((raw) => localStorage.setItem('exhibit-flow.workspace.v1', raw), broken);
    await tabB.evaluate((raw) => localStorage.setItem('exhibit-flow.workspace.v1', raw), broken);
    await tabA.reload();
    await tabB.reload();

    const bannerA = tabA.getByRole('status').filter({ hasText: 'Saved workspace could not be read' });
    const bannerB = tabB.getByRole('status').filter({ hasText: 'Saved workspace could not be read' });
    await expect(bannerA).toBeVisible();
    await expect(bannerB).toBeVisible();

    const recoveryKey = 'exhibit-flow.workspace-recovered.v1';
    const stashedA = await tabA.evaluate((key) => localStorage.getItem(key), recoveryKey);
    expect(stashedA).not.toBeNull();
    expect(stashedA).toContain(broken);

    // Acknowledging in one tab clears the broken main document but keeps the recovery copy.
    await bannerA.getByRole('button', { name: /Acknowledge/ }).click();
    await expect(bannerA).toBeHidden();
    const afterA = await tabA.evaluate(() => ({
      main: localStorage.getItem('exhibit-flow.workspace.v1'),
      recovery: localStorage.getItem('exhibit-flow.workspace-recovered.v1'),
    }));
    expect(afterA.main).toBeNull();
    expect(afterA.recovery).toBe(stashedA);

    // The other tab still shows its warning and its acknowledgement also keeps the copy.
    await expect(bannerB).toBeVisible();
    await bannerB.getByRole('button', { name: /Acknowledge/ }).click();
    const afterB = await tabB.evaluate(() => localStorage.getItem('exhibit-flow.workspace-recovered.v1'));
    expect(afterB).toBe(stashedA);

    // Work continues on a clean, revisioned document without touching the preserved copy.
    await tabA.getByRole('button', { name: 'Edit' }).first().click();
    await tabA.getByLabel('Maker / source').fill('After recovery edit');
    await tabA.getByRole('button', { name: 'Save changes' }).click();
    await expect(tabA.getByText('Object details updated.')).toBeVisible();
    const finalState = await tabA.evaluate(() => ({
      revision: JSON.parse(localStorage.getItem('exhibit-flow.workspace.v1')!).revision,
      recovery: localStorage.getItem('exhibit-flow.workspace-recovered.v1'),
    }));
    expect(finalState.revision).toBeGreaterThanOrEqual(2);
    expect(finalState.recovery).toBe(stashedA);
  });

  test('single-tab editing still autosaves without any conflict UI', async ({ page }) => {
    await page.goto('/journey');
    await page.getByRole('button', { name: /Conservator’s Gloves/ }).click();
    await page.getByRole('button', { name: /Place Conservator’s Gloves here/ }).first().click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.reload();
    const lane = page.locator('.zone-lane').filter({ hasText: 'Arrival / A Light Carried' });
    await expect(lane.getByText(/Conservator’s Gloves/)).toBeVisible();
  });
});
