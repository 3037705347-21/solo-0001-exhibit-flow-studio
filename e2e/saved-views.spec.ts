import { expect, test, type Page } from '@playwright/test';

const REFLECTION_OBJECTS = ['Mended Serving Bowl', 'Oral History Tape 12', 'Conservator’s Gloves'];

test.beforeEach(async ({ page }) => {
  await page.goto('/collection');
  page.on('dialog', (dialog) => dialog.accept().catch(() => undefined));
});

async function filterReflectionRole(page: Page) {
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await page.locator('.filter-drawer').getByText('Reflection', { exact: true }).click();
  for (const title of REFLECTION_OBJECTS) {
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
  }
  await expect(page.locator('.toolbar-count')).toContainText('3 results');
}

async function openSaveModal(page: Page, kind: 'live' | 'frozen') {
  await page.getByRole('button', { name: kind === 'live' ? 'Save live view' : 'Issue frozen list' }).first().click();
}

async function submitSaveModal(page: Page, name: string, kind: 'live' | 'frozen') {
  await page.getByLabel('View name').fill(name);
  await page.getByRole('button', { name: kind === 'live' ? 'Save live view' : 'Issue frozen list' }).last().click();
}

async function saveView(page: Page, name: string, kind: 'live' | 'frozen') {
  await openSaveModal(page, kind);
  await submitSaveModal(page, name, kind);
}

test.describe('saved collection views', () => {
  test('creates live and frozen views, tracks drift, and restores after reload and route changes', async ({ page }) => {
    await filterReflectionRole(page);

    // Save a live view from the current rules.
    await saveView(page, 'Reflection watch', 'live');
    await expect(page.getByText('Live view · Reflection watch')).toBeVisible();
    await expect(page.getByText('Rule version 1 — basis: 1 role filter')).toBeVisible();

    // Issue a frozen list from the same rules with a distinct name.
    await saveView(page, 'Reflection pack', 'frozen');
    await expect(page.getByText('Frozen list · Reflection pack')).toBeVisible();
    await expect(page.getByText('All members intact')).toBeVisible();
    for (const title of REFLECTION_OBJECTS) {
      await expect(page.getByRole('heading', { name: title })).toBeVisible();
    }

    // Change a member's role: the frozen member is flagged changed; the frozen list stays at 3 members.
    const glovesCard = page.locator('.artifact-card', { has: page.getByRole('heading', { name: 'Conservator’s Gloves' }) });
    await glovesCard.getByRole('button', { name: 'Edit' }).click();
    await page.getByLabel('Narrative role').selectOption('threshold');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Changed · Narrative role')).toBeVisible();
    await expect(page.getByText('Invalid · 1 changed, 0 missing')).toBeVisible();

    // The live view recomputes: the gloves drop out, two reflection objects remain.
    await page.getByRole('button', { name: 'Reflection watch' }).click();
    await expect(page.locator('.toolbar-count')).toContainText('2 results');
    await expect(page.getByRole('heading', { name: 'Conservator’s Gloves' })).not.toBeVisible();
    await expect(page.getByRole('heading', { name: 'Oral History Tape 12' })).toBeVisible();

    // Delete another member: the frozen list retains its entry and marks it missing.
    await page.getByRole('button', { name: 'Reflection pack' }).click();
    const tapeCard = page.locator('.artifact-card', { has: page.getByRole('heading', { name: 'Oral History Tape 12' }) });
    await tapeCard.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByText('Missing · deleted')).toBeVisible();
    await expect(page.getByText('Invalid · 1 changed, 1 missing')).toBeVisible();
    await expect(page.getByText(/retained as evidence/)).toBeVisible();

    // Correct an accession ID on the remaining member: drift shows issued -> corrected value.
    const bowlCard = page.locator('.artifact-card', { has: page.getByRole('heading', { name: 'Mended Serving Bowl' }) });
    await bowlCard.getByRole('button', { name: 'Edit' }).click();
    await page.getByLabel('Accession ID').fill('AF-1987-999');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Changed · Accession ID')).toBeVisible();
    await expect(page.getByText('AF-1987-064')).toBeVisible();
    await expect(page.getByText('AF-1987-999')).toBeVisible();
    await expect(page.getByText('Invalid · 2 changed, 1 missing')).toBeVisible();

    // Persistence: reload keeps the frozen selection and all drift markers.
    await page.reload();
    await expect(page.getByText('Frozen list · Reflection pack')).toBeVisible();
    await expect(page.getByText('Invalid · 2 changed, 1 missing')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Oral History Tape 12' })).toBeVisible();
    await expect(page.getByText('Missing · deleted')).toBeVisible();
    await expect(page.getByText('AF-1987-064')).toBeVisible();

    // Cross-route return keeps semantics: the frozen list is still active, not ad hoc filters.
    await page.goto('/journey');
    await page.goto('/collection');
    await expect(page.getByText('Frozen list · Reflection pack')).toBeVisible();
    await expect(page.locator('.search-box input')).toBeDisabled();

    // The live view still follows the collection (2 members) after navigation.
    await page.getByRole('button', { name: 'Reflection watch' }).click();
    await expect(page.locator('.toolbar-count')).toContainText('1 results');

    // Delete each view by id; ad hoc browsing returns and no stale selection survives.
    await page.getByRole('button', { name: 'Delete live view' }).click();
    await expect(page.getByRole('button', { name: 'Reflection watch' })).toHaveCount(0);
    await expect(page.getByText('Browsing with unsaved filters')).toBeVisible();
    await page.getByRole('button', { name: 'Reflection pack' }).click();
    await page.getByRole('button', { name: 'Delete frozen list' }).click();
    await expect(page.getByRole('button', { name: 'Reflection pack' })).toHaveCount(0);
    await expect(page.getByText('Browsing with unsaved filters')).toBeVisible();
    await expect(page.locator('.search-box input')).toBeEnabled();
  });

  test('rejects duplicate names across kinds and locks controls for frozen lists', async ({ page }) => {
    await filterReflectionRole(page);

    await saveView(page, 'Shared set', 'live');
    await expect(page.getByText('Live view · Shared set')).toBeVisible();

    // The same normalized name on a frozen list is rejected; the modal stays open.
    await openSaveModal(page, 'frozen');
    await submitSaveModal(page, 'shared set', 'frozen');
    await expect(page.getByText(/already exists/)).toBeVisible();
    await page.getByLabel('View name').fill('Distinct frozen set');
    await page.getByRole('button', { name: 'Issue frozen list' }).last().click();
    await expect(page.getByText('Frozen list · Distinct frozen set')).toBeVisible();

    // Frozen semantics: controls are locked so the issued list cannot be re-filtered.
    await expect(page.locator('.search-box input')).toBeDisabled();
    if (await page.locator('.filter-drawer').isHidden()) {
      await page.getByRole('button', { name: 'Filters', exact: true }).click();
    }
    const disabledCheckboxes = page.locator('.filter-drawer input[type="checkbox"]');
    const count = await disabledCheckboxes.count();
    expect(count).toBeGreaterThan(0);
    for (let index = 0; index < count; index += 1) {
      await expect(disabledCheckboxes.nth(index)).toBeDisabled();
    }

    // A frozen list cannot be revised from the UI; only a separate new live view is offered.
    await expect(page.getByRole('button', { name: /Update saved view/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save current rules as live view' })).toBeVisible();
  });

  test('keeps an empty frozen list (issued while nothing matched) after reload and route changes', async ({ page }) => {
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    await page.locator('.filter-drawer').getByText('Key objects only', { exact: true }).click();
    await page.getByLabel('Search collection').fill('zzz-no-such-object');
    await expect(page.locator('.toolbar-count')).toContainText('0 results');

    // Issue the frozen list while nothing matches; zero members is a valid issue.
    await saveView(page, 'Empty issue pack', 'frozen');
    await expect(page.getByText('Frozen list · Empty issue pack')).toBeVisible();
    await expect(page.getByText('issued record of 0 objects')).toBeVisible();
    await expect(page.getByText('No objects were on this issued list')).toBeVisible();
    await expect(page.locator('.search-box input')).toBeDisabled();
    await expect(page.locator('.artifact-card')).toHaveCount(0);

    // Reload: the frozen semantics and empty membership must be restored, not dropped.
    await page.reload();
    await expect(page.getByText('Frozen list · Empty issue pack')).toBeVisible();
    await expect(page.getByText('issued record of 0 objects')).toBeVisible();
    await expect(page.getByText('No objects were on this issued list')).toBeVisible();
    await expect(page.locator('.search-box input')).toBeDisabled();

    // Cross-route return preserves the frozen list.
    await page.goto('/insights');
    await page.goto('/collection');
    await expect(page.getByText('Frozen list · Empty issue pack')).toBeVisible();
    await expect(page.getByText('No objects were on this issued list')).toBeVisible();
    await expect(page.locator('.search-box input')).toBeDisabled();
  });

  test('records a new rule version when a live view is updated', async ({ page }) => {
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    await page.locator('.filter-drawer').getByText('Threshold', { exact: true }).click();
    await expect(page.locator('.toolbar-count')).toContainText('1 results');
    await saveView(page, 'Role watch', 'live');
    await expect(page.getByText('Rule version 1')).toBeVisible();

    // Widen the rules while the live view is selected, then save the revision.
    await page.locator('.filter-drawer').getByText('Context', { exact: true }).click();
    await expect(page.locator('.toolbar-count')).toContainText('3 results');
    await expect(page.getByText('Unsaved rule changes')).toBeVisible();
    await page.getByRole('button', { name: 'Update saved view (v2)' }).click();
    await expect(page.locator('.view-banner.live').getByText('Rule version 2')).toBeVisible();
    await expect(page.getByText('updated to rule version 2')).toBeVisible();
    await expect(page.locator('.toolbar-count')).toContainText('3 results');

    // The prior version (rules, membership, basis) remains on record in persisted state.
    const storage = await page.evaluate(() => localStorage.getItem('exhibit-flow.workspace.v1'));
    const parsed = JSON.parse(storage ?? '{}');
    const saved = parsed.collectionViews?.find((view: { name: string }) => view.name === 'Role watch');
    expect(saved.kind).toBe('live');
    expect(saved.ruleVersions).toHaveLength(2);
    expect(saved.ruleVersions[0].memberIds).toEqual(['artifact-lantern']);
    expect(saved.ruleVersions[1].memberIds).toEqual(['artifact-lantern', 'artifact-sample-book', 'artifact-radio']);
    expect(saved.frozenMembers).toBeUndefined();
  });
});
