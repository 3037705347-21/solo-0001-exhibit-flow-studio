import { test, expect } from '@playwright/test';

test.describe('versioned review rule archive', () => {

  test('records the archive version on readiness and published snapshot', async ({ page }) => {
    await page.goto('/review');
    await expect(page.locator('.rule-archive-chip')).toContainText('v1');

    // Clear every open/in-progress finding so the seed plan can pass the gate.
    const startWork = page.getByRole('button', { name: 'Start work', exact: true });
    if (await startWork.first().isVisible().catch(() => false)) await startWork.first().click();
    const resolveButton = page.getByRole('button', { name: 'Resolve', exact: true });
    while (await resolveButton.first().isVisible().catch(() => false)) {
      await resolveButton.first().click();
      await page.waitForTimeout(30);
    }

    await page.getByRole('button', { name: 'Run readiness check' }).click();
    await expect(page.getByRole('heading', { name: 'Ready to share' })).toBeVisible();
    await expect(page.locator('.readiness-card .eyebrow')).toContainText('v1');

    // Snapshot download carries the embedded archive.
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export snapshot' }).click();
    const download = await downloadPromise;
    const contents = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of contents) chunks.push(chunk as Buffer);
    const snapshot = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.ruleArchive).toMatchObject({ profileId: 'standard-review-rules', version: 1 });
    expect(snapshot.ruleProfile.parameters.capacityWarnAt).toBe(0.8);
  });

  test('publishing a new version previews impact and keeps the old binding until an explicit switch', async ({ page }) => {
    await page.goto('/review/rules');
    await expect(page.getByRole('heading', { name: 'Standard gallery review rules · v1' })).toBeVisible();

    await page.getByRole('button', { name: 'Publish new version' }).click();

    // Tighten the capacity warning line to 70%.
    await page.locator('#rule-capacityWarnAt').fill('70');
    await expect(page.locator('#rule-capacityWarnAt')).toHaveValue('70');

    // Publishing stays blocked until the immutable version records a change summary.
    await expect(page.getByRole('button', { name: 'Publish new version' })).toBeDisabled();
    await page.getByLabel(/Change summary/i).fill('Tighten capacity warnings after the visitor-flow study.');

    await page.getByRole('button', { name: 'Preview impact on current plan' }).click();
    await expect(page.getByRole('heading', { name: 'Impact on the current plan' })).toBeVisible();
    // Tighter line surfaces at least one new warning on the seed plan.
    await expect(page.getByText(/New warning/i).first()).toBeVisible();
    const changeRow = page.locator('.rule-change-row', { hasText: 'Capacity warning line' });
    await expect(changeRow).toContainText('70%');

    await page.getByRole('button', { name: 'Publish new version' }).click();

    // Publishing appends v2 but does not rebind; the project must explicitly confirm.
    await expect(page.getByRole('heading', { name: /Switch this project to/ })).toBeVisible();
    await page.getByRole('button', { name: 'Switch and recalculate' }).click();
    await expect(page.getByText(/now interpreted under/)).toBeVisible();

    // Review desk now evaluates under v2 while v1 remains in archive history.
    await page.goto('/review');
    await expect(page.locator('.rule-archive-chip')).toContainText('v2');
  });

  test('a stricter version can block a plan that was ready, and each historical run keeps its version', async ({ page }) => {
    // Make the plan ready under v1 through the UI: advance every open finding,
    // then resolve every finding. Exact name matching avoids "Reopen" buttons.
    await page.goto('/review');
    const startAll = page.getByRole('button', { name: 'Start work', exact: true });
    while (await startAll.first().isVisible().catch(() => false)) {
      await startAll.first().click();
      await page.waitForTimeout(30);
    }
    const resolveAll = page.getByRole('button', { name: 'Resolve', exact: true });
    while (await resolveAll.first().isVisible().catch(() => false)) {
      await resolveAll.first().click();
      await page.waitForTimeout(30);
    }
    await page.getByRole('button', { name: 'Run readiness check' }).click();
    await expect(page.getByRole('heading', { name: 'Ready to share' })).toBeVisible();

    // Publish v2: warn at 60%, block at 70%. The Common Thread zone sits at
    // 15/20 minutes (75%), so it becomes a blocking condition under v2.
    await page.goto('/review/rules');
    await page.getByRole('button', { name: 'Publish new version' }).click();
    await page.locator('#rule-capacityWarnAt').fill('60');
    await page.locator('#rule-capacityBlockAt').fill('70');
    await page.getByLabel(/Change summary/i).fill('Tight dwell limits from the autumn visitor-flow study.');
    await page.getByRole('button', { name: 'Preview impact on current plan' }).click();
    await expect(page.getByText(/New blocking condition/i).first()).toBeVisible();

    await page.getByRole('button', { name: 'Publish new version' }).click();
    await page.getByRole('button', { name: 'Switch and recalculate' }).click();

    // Re-run under v2: the previously ready plan is now blocked.
    await page.goto('/review');
    await page.getByRole('button', { name: 'Run readiness check' }).click();
    await expect(page.getByText('Still needs attention')).toBeVisible();
    await expect(page.getByText(/blocking journey constraint/)).toBeVisible();

    // History keeps both runs, each pinned to the archive version it used.
    const history = page.locator('.rule-run-history').first();
    await expect(history).toBeVisible();
    const runs = await history.locator('.rule-run-row').allInnerTexts();
    expect(runs.some((text) => text.includes('Ready') && text.includes('v1'))).toBe(true);
    expect(runs.some((text) => text.includes('Blocked') && text.includes('v2'))).toBe(true);
  });

  test('unknown bound archive blocks calculation instead of using defaults, then rebinding restores it', async ({ page }) => {
    await page.goto('/review');
    await page.evaluate(() => {
      const key = 'exhibit-flow.workspace.v1';
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const state = JSON.parse(raw);
      state.project.ruleBinding = { profileId: 'standard-review-rules', version: 99, boundAt: new Date().toISOString() };
      localStorage.setItem(key, JSON.stringify(state));
    });
    await page.goto('/journey');
    await expect(page.getByRole('heading', { name: 'Readiness calculations are paused' })).toBeVisible();
    await expect(page.getByText(/not present in this workspace/)).toBeVisible();
    await expect(page.getByText(/planned visit/)).toHaveCount(0);

    // Rebind from the archive page restores calculations.
    await page.goto('/review/rules');
    await page.getByRole('button', { name: /Rebind to v1/ }).click();
    await expect(page.getByText(/Binding repaired/)).toBeVisible();
    await page.goto('/journey');
    await expect(page.getByText('Readiness calculations are paused')).toHaveCount(0);
    await expect(page.getByText(/planned visit/)).toBeVisible();
  });
});
