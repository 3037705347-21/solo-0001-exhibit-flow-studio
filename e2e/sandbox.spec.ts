import { test, expect, type Page } from '@playwright/test';

const STORAGE_KEY = 'exhibit-flow.workspace.v1';

async function resetPlan(page: Page) {
  await page.goto('/collection');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Reset sample plan' }).click();
  await page.waitForFunction((key) => {
    const raw = localStorage.getItem(key);
    return raw !== null && raw.includes('Afterlight: Material Memory');
  }, STORAGE_KEY);
}

async function startSandbox(page: Page) {
  await page.goto('/sandbox');
  await page.getByRole('button', { name: 'Start sandbox' }).click();
  await expect(page.getByText('Compose the trial')).toBeVisible();
}

async function stageMove(page: Page, artifactLabel: string, zoneLabel: string) {
  await page.getByLabel('Move object').selectOption({ label: artifactLabel });
  await page.getByLabel('To zone').selectOption({ label: zoneLabel });
  await page.getByRole('button', { name: 'Stage move' }).click();
}

test.describe('capacity sandbox', () => {
  test.beforeEach(async ({ page }) => {
    await resetPlan(page);
  });

  test('combines move, new object, and zone rule changes and applies the batch successfully', async ({ page }) => {
    await startSandbox(page);
    await stageMove(page, 'Conservator’s Gloves', 'Arrival');

    await page.getByRole('button', { name: 'Stage an unrecorded object' }).click();
    await page.getByLabel('Accession ID').fill('AF-2027-501');
    await page.getByLabel('Title').fill('Trial Projection Plinth');
    await page.getByLabel('Maker / source').fill('Studio North');
    await page.getByLabel('Medium').fill('Wood and glass');
    await page.getByLabel('Width (cm)').fill('12');
    await page.getByLabel('Height (cm)').fill('9');
    await page.getByLabel('Depth (cm)').fill('4');
    await page.getByLabel('Dwell time (min)').fill('2');
    await page.getByLabel('Object summary').fill('A trial plinth previewing how a new work reshapes this zone.');
    await page.getByLabel('Trial placement').selectOption({ label: 'Arrival' });
    await page.getByRole('button', { name: 'Stage in sandbox' }).click();

    await expect(page.getByText('Move → Arrival')).toBeVisible();
    await expect(page.getByText('New object · → Arrival')).toBeVisible();

    await page.getByLabel('Arrival / A Light Carried dwell capacity minutes').fill('12');
    await page.getByLabel('Arrival / A Light Carried maximum objects').fill('4');

    // Live per-zone results: Arrival grows 1 -> 3 objects, 4 -> 9 minutes against the new 12 minute cap.
    await expect(page.getByText('1 → 3 / 4 objects')).toBeVisible();
    await expect(page.getByText('4 → 9 / 12 min')).toBeVisible();
    await expect(page.getByText('Applicable')).toBeVisible();

    const before = JSON.parse((await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY))!);
    expect(before.artifacts).toHaveLength(8);

    await page.getByRole('button', { name: /^Apply 3 changes$/ }).click();
    await expect(page.getByText('Applied 3 sandbox changes to the live plan.')).toBeVisible();

    // Sandbox closes; the live journey reflects the batch and it persisted.
    await page.goto('/journey');
    const arrivalStats = page.locator('.zone-lane').first();
    await expect(arrivalStats).toContainText('3/4 objects');
    await expect(arrivalStats).toContainText('9/12 min');
    await expect(page.getByText('Trial Projection Plinth').first()).toBeVisible();

    const after = JSON.parse((await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY))!);
    expect(after.artifacts).toHaveLength(9);
    expect(after.zones.find((zone: { id: string }) => zone.id === 'zone-arrival').artifactIds).toHaveLength(3);
  });

  test('cancelling discards everything and leaves plan, readiness data and storage untouched', async ({ page }) => {
    await startSandbox(page);
    await stageMove(page, 'Conservator’s Gloves', 'Arrival');
    const storedAtStage = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
    await page.getByLabel('Arrival / A Light Carried dwell capacity minutes').fill('30');

    await expect(page.getByText('1 → 2 / 3 objects')).toBeVisible();

    await page.getByRole('button', { name: 'Discard sandbox' }).click();
    await expect(page.getByRole('button', { name: 'Start sandbox' })).toBeVisible();

    await page.goto('/journey');
    const arrival = page.locator('.zone-lane').first();
    await expect(arrival).toContainText('1/3 objects');
    await expect(arrival).toContainText('4/10 min');

    const storedAfter = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
    expect(storedAfter).toBe(storedAtStage);
  });

  test('flags a single conflicting move and blocks application until it is removed', async ({ page }) => {
    await startSandbox(page);
    await stageMove(page, 'Dyer’s Sample Book', 'Arrival');

    await expect(page.getByText('requires low light')).toBeVisible();
    await expect(page.getByText('Blocked')).toBeVisible();
    const applyButton = page.getByRole('button', { name: /^Apply / });
    await expect(applyButton).toBeDisabled();

    await page.getByRole('button', { name: /Remove move of Dyer’s Sample Book/ }).click();
    await expect(page.getByText('Applicable')).toBeVisible();
    await expect(applyButton).toBeDisabled(); // no changes remain
  });

  test('stops applying when the plan changed in another tab and explains how to re-run', async ({ context }) => {
    const sandboxPage = await context.newPage();
    await sandboxPage.goto('/sandbox');
    await sandboxPage.getByRole('button', { name: 'Start sandbox' }).click();
    await stageMove(sandboxPage, 'Conservator’s Gloves', 'Arrival');
    await expect(sandboxPage.getByText('Applicable')).toBeVisible();

    // Another tab modifies the saved plan while the sandbox is frozen (same object, placed directly).
    const otherPage = await context.newPage();
    await otherPage.goto('/journey');
    await otherPage.getByRole('button', { name: /Conservator’s Gloves/ }).click();
    await otherPage.getByRole('button', { name: /Place Conservator’s Gloves here/ }).first().click();
    await otherPage.waitForFunction((key) => {
      const raw = localStorage.getItem(key);
      if (!raw) return false;
      const parsed = JSON.parse(raw) as { zones: Array<{ id: string; artifactIds: string[] }> };
      const arrival = parsed.zones.find((zone) => zone.id === 'zone-arrival');
      return Boolean(arrival?.artifactIds.includes('artifact-gloves'));
    }, STORAGE_KEY);
    await otherPage.close();

    await expect(sandboxPage.getByText('Plan changed elsewhere')).toBeVisible();

    await sandboxPage.getByRole('button', { name: /^Apply 1 change$/ }).click();
    await expect(sandboxPage.getByRole('dialog', { name: 'Sandbox apply blocked' })).toBeVisible();
    await expect(sandboxPage.getByText('The plan changed elsewhere after the sandbox started')).toBeVisible();
    await expect(sandboxPage.getByText(/re-run the same moves/i)).toBeVisible();

    // Re-anchoring replays the staged move against the newest version and lets it apply.
    await sandboxPage.getByRole('button', { name: 'Re-anchor & re-run' }).click();
    await expect(sandboxPage.getByText('re-anchored to the latest plan')).toBeVisible();
    await expect(sandboxPage.getByText('Applicable')).toBeVisible();
    await sandboxPage.getByRole('button', { name: /^Apply 1 change$/ }).click();
    await expect(sandboxPage.getByText('Applied 1 sandbox change to the live plan.')).toBeVisible();
  });
});
