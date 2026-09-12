import { test, expect, type Page } from '@playwright/test';

const TITLE = 'Reduce entry panel copy';

interface StoredIssue {
  owner: string;
  status: string;
  version: number;
  audit: Array<{ issueTitle: string; fromOwner: string; toOwner: string; fromStatus: string; toStatus: string }>;
}

async function selectForAllocation(page: Page, title: string) {
  const row = page.locator('.issue-row', { has: page.getByRole('heading', { name: title }) });
  await row.getByRole('checkbox').check();
}

async function readStoredIssue(page: Page): Promise<StoredIssue> {
  return page.evaluate((title) => {
    const raw = localStorage.getItem('exhibit-flow.workspace.v1');
    const state = raw ? JSON.parse(raw) : null;
    const issue = state.issues.find((candidate: { title: string }) => candidate.title === title);
    return {
      owner: issue.owner,
      status: issue.status,
      version: issue.version,
      audit: state.assignmentLog,
    };
  }, TITLE);
}

test('peer transition wins first: the open allocation batch is rejected without phantom audit', async ({ context }) => {
  const pageOne = await context.newPage();
  const pageTwo = await context.newPage();
  await pageOne.goto('/review');
  await pageTwo.goto('/review');

  // Operator pins a batch against the open v0 finding.
  await selectForAllocation(pageOne, TITLE);
  await pageOne.getByRole('button', { name: /Allocate workload \(1\)/ }).click();
  await expect(pageOne.getByRole('dialog')).toBeVisible();
  await pageOne.getByLabel(`New owner for ${TITLE}`).selectOption({ label: 'Mara Chen' });

  // A peer advances the same finding to in-progress first.
  const peerRow = pageTwo.locator('.issue-row', { has: pageTwo.getByRole('heading', { name: TITLE }) });
  await peerRow.getByRole('button', { name: 'Start work' }).click();
  await expect(peerRow.getByRole('button', { name: 'Resolve' })).toBeVisible();

  // The operator's dialog observes the external revision and blocks commit.
  await expect(pageOne.getByRole('alert').getByText('Status changed', { exact: true })).toBeVisible();
  await expect(pageOne.getByRole('button', { name: /^Confirm 1 reassign$/ })).toBeDisabled();

  const stored = await readStoredIssue(pageTwo);
  expect(stored.owner).toBe('Theo James');
  expect(stored.status).toBe('in-progress');
  expect(stored.version).toBe(1);
  expect(stored.audit.filter((entry) => entry.issueTitle === TITLE)).toEqual([]);

  // The other tab converges on the identical state.
  await expect.poll(() => readStoredIssue(pageOne)).toEqual(stored);
});

test('allocation commits first, then a transition stacks on the same finding without losing owner or audit', async ({ page }) => {
  await page.goto('/review');
  const row = page.locator('.issue-row', { has: page.getByRole('heading', { name: TITLE }) });

  // Commit the allocation first through the same-tab FIFO queue.
  await row.getByRole('checkbox').check();
  await page.getByRole('button', { name: /Allocate workload \(1\)/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel(`New owner for ${TITLE}`).selectOption({ label: 'Mara Chen' });
  await page.getByRole('button', { name: /^Confirm 1 reassign$/ }).click();
  await expect(page.getByText('1 finding reassigned in one transaction.')).toBeVisible();

  // Immediately advance the same finding in the same queue. The transition
  // re-reads shared storage under the same lock, sees Mara at v1, and applies
  // on top instead of restoring the stale owner.
  const movedRow = page.locator('.issue-row', { has: page.getByRole('heading', { name: TITLE }) });
  await movedRow.getByRole('button', { name: 'Start work' }).click();
  await expect(movedRow.getByText('In Progress', { exact: true })).toBeVisible();

  const stored = await readStoredIssue(page);
  expect(stored.owner).toBe('Mara Chen');
  expect(stored.status).toBe('in-progress');
  expect(stored.version).toBe(2);
  const related = stored.audit.filter((entry) => entry.issueTitle === TITLE);
  expect(related).toEqual([
    expect.objectContaining({ fromOwner: 'Theo James', toOwner: 'Mara Chen', fromStatus: 'open', toStatus: 'open' }),
  ]);

  // The version survives a reload: the write was durable and single-source.
  await page.reload();
  const reloaded = await readStoredIssue(page);
  expect(reloaded).toEqual(stored);
});
