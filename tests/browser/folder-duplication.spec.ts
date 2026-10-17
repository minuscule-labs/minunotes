import { expect, type Page, test } from '@playwright/test';
import { browserFixture } from './fixtures';
import { mockPropertyBoard } from './property-board-fixtures';

const folder = `/folders/${browserFixture.folder.id}`;
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Duplicate folder', exact: true });
const previewBody = (sourceFolderId = browserFixture.folder.id, parentFolderId: string | null = null) => ({
  sourceFolderId,
  parentFolderId,
  token: 'a'.repeat(64),
  counts: { folders: 2, notes: 3, templates: 1, attachments: 0 },
  imageBytes: 0,
});
async function mockCopyPreviews(page: Page) {
  await page.route('**/internal/folders/*/duplicate-preview*', (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({ json: previewBody(url.pathname.split('/').at(-2), url.searchParams.get('parentFolderId')) });
  });
}
async function openCopy(page: Page) {
  const trigger = page
    .getByRole('main')
    .getByRole('button', { name: `Actions for ${browserFixture.folder.title}`, exact: true });
  await trigger.click();
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByText(/^Copy notes, subfolders/)).toHaveCount(0);
  await expect(dialog(page).getByText(/^Maximum 100 notes\/templates/)).toHaveCount(0);
  await expect(dialog(page).getByRole('button', { name: 'Refresh copy summary' })).toHaveCount(0);
  await expect(dialog(page)).not.toHaveAttribute('aria-describedby');
  return trigger;
}
test('folder duplication: owner menu entry points, cancellation focus and independent bare-URL success', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => localStorage.setItem('notes-theme', 'catppuccin-mocha'));
  const api = await mockPropertyBoard(page);
  await mockCopyPreviews(page);
  const requests: unknown[] = [];
  await page.route(`**/internal/folders/${browserFixture.folder.id}/duplicate`, async (route) => {
    requests.push(route.request().postDataJSON());
    const body = route.request().postDataJSON();
    const copy = {
      ...browserFixture.folder,
      id: 'folder_copied',
      title: body.title,
      parentFolderId: body.parentFolderId,
    };
    api.folders.push(copy);
    await route.fulfill({
      json: { folder: copy, counts: { folders: 2, notes: 3, templates: 1, attachments: 0 }, replayed: false },
      status: 201,
    });
  });
  await page.goto(folder);
  const side = page
    .getByRole('complementary')
    .getByRole('button', { name: `Actions for ${browserFixture.folder.title}`, exact: true });
  await side.click();
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(side).toBeFocused();
  const child = page
    .getByRole('main')
    .getByRole('button', { name: `Actions for ${browserFixture.childFolder.title}`, exact: true });
  await child.click();
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(dialog(page).getByLabel('Folder name')).toHaveValue('Child folder copy');
  await dialog(page).press('Escape');
  await expect(child).toBeFocused();
  const trigger = await openCopy(page);
  await expect(dialog(page).getByLabel('Folder name')).toBeFocused();
  await expect(dialog(page).getByLabel('Folder name')).toHaveValue('Browser tests copy');
  await dialog(page).getByRole('button', { name: 'Close duplicate folder' }).click();
  await expect(trigger).toBeFocused();
  expect(requests).toEqual([]);
  expect(api.writes).toEqual([]);
  await openCopy(page);
  await dialog(page).getByLabel('Folder name').fill('Project base copy');
  await expect(dialog(page).getByRole('button', { name: 'Browser tests', exact: true })).toBeDisabled();
  await expect(dialog(page).getByRole('group', { name: 'Copy summary' })).toContainText(
    '3 notes · 1 template · 1 subfolder'
  );
  await expect(dialog(page).getByRole('group', { name: 'Copy summary' })).toContainText('0 uploaded images');
  await page.screenshot({ path: info.outputPath('duplicate-folder-desktop.png'), fullPage: true });
  await dialog(page).getByRole('button', { name: 'Duplicate folder', exact: true }).click();
  await expect(page).toHaveURL(/\/folders\/folder_copied$/);
  await expect(dialog(page)).toHaveCount(0);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ title: 'Project base copy', parentFolderId: null });
  expect(Object.keys(requests[0] as object).sort()).toEqual(['parentFolderId', 'previewToken', 'requestId', 'title']);
  expect(requests[0]).toMatchObject({ previewToken: 'a'.repeat(64) });
});
test('folder duplication: shared viewer has no duplicate action', async ({ page }) => {
  const api = await mockPropertyBoard(page, { role: 'viewer' });
  await page.route('**/internal/folders', (route) => route.fulfill({ json: { folders: [] } }));
  await page.goto(folder);
  await page.getByRole('main').getByRole('button', { name: 'Actions for Browser tests', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Duplicate', exact: true })).toHaveCount(0);
  expect(api.writes).toEqual([]);
});
test('folder duplication: stale validation automatically rechecks without resubmitting and retains editable draft', async ({
  page,
}) => {
  await mockPropertyBoard(page);
  let reads = 0,
    releaseSummary: () => void = () => {};
  const summaryGate = new Promise<void>((resolve) => {
    releaseSummary = resolve;
  });
  await page.route('**/internal/folders/*/duplicate-preview*', async (route) => {
    reads++;
    if (reads > 1) await summaryGate;
    await route.fulfill({ json: { ...previewBody(), token: (reads === 1 ? 'a' : 'b').repeat(64) } });
  });
  const requests: unknown[] = [];
  await page.route(`**/internal/folders/${browserFixture.folder.id}/duplicate`, async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status: 409, json: { error: 'Source changed; review and retry' } });
  });
  await page.goto(folder);
  await openCopy(page);
  await dialog(page).getByPlaceholder('Search folders').fill('Child folder');
  await expect(dialog(page).getByRole('button', { name: 'Child folder', exact: true })).toBeDisabled();
  await dialog(page).getByPlaceholder('Search folders').fill('');
  await dialog(page).getByLabel('Folder name').fill('Keep this draft');
  await dialog(page).getByRole('button', { name: 'Duplicate folder', exact: true }).click();
  await expect(dialog(page).getByRole('alert').filter({ hasText: 'Source changed' })).toBeVisible();
  await expect(dialog(page).getByLabel('Folder name')).toHaveValue('Keep this draft');
  await expect(dialog(page).getByLabel('Folder name')).toBeEnabled();
  const copy = dialog(page).getByRole('button', { name: 'Duplicate folder', exact: true });
  await expect(copy).toBeDisabled();
  await expect(dialog(page).getByRole('group', { name: 'Copy summary' })).toContainText('Checking copy size');
  await dialog(page)
    .locator('form')
    .evaluate((form) => form.requestSubmit());
  expect(requests).toHaveLength(1);
  releaseSummary();
  await expect(copy).toBeEnabled();
  expect(reads).toBe(2);
  expect(requests).toHaveLength(1);
  await expect(dialog(page).getByRole('button', { name: 'Refresh copy summary' })).toHaveCount(0);
  await copy.click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toMatchObject({ title: 'Keep this draft', previewToken: 'b'.repeat(64) });
  expect((requests[0] as { requestId: string }).requestId).not.toBe((requests[1] as { requestId: string }).requestId);
  expect(page.url()).toContain(folder);
});
test('folder duplication: mobile uncertain response locks one request across reload and retries without a second copy', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.addInitScript(() => localStorage.setItem('notes-theme', 'catppuccin-latte'));
  const api = await mockPropertyBoard(page);
  await mockCopyPreviews(page);
  const requests: Array<{ title: string; parentFolderId: null; requestId: string }> = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/internal/folders/${browserFixture.folder.id}/duplicate`, async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const copy = {
      ...browserFixture.folder,
      id: 'folder_once',
      title: body.title,
      parentFolderId: body.parentFolderId,
    };
    if (requests.length === 1) {
      api.folders.push(copy);
      await gate;
      await route.abort('failed');
    } else if (requests.length === 2)
      await route.fulfill({ status: 409, json: { error: 'Source changed; review and retry' } });
    else
      await route.fulfill({
        json: { folder: copy, counts: { folders: 2, notes: 3, templates: 1, attachments: 0 }, replayed: true },
      });
  });
  await page.goto(folder);
  await openCopy(page);
  await dialog(page).getByLabel('Folder name').fill('Lost reply project');
  await expect(dialog(page).getByRole('button', { name: 'Duplicate folder', exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath('duplicate-folder-mobile.png'), fullPage: true });
  await dialog(page).getByRole('button', { name: 'Duplicate folder', exact: true }).click();
  await expect(dialog(page).getByRole('button', { name: 'Duplicating…', exact: true })).toBeDisabled();
  await dialog(page)
    .locator('form')
    .evaluate((form) => {
      form.requestSubmit();
      form.requestSubmit();
    });
  await dialog(page).press('Escape');
  await expect(dialog(page)).toBeVisible();
  expect(requests).toHaveLength(1);
  const saved = await page.evaluate(() => {
    const key = Object.keys(sessionStorage).find((key) => key.startsWith('minunotes:duplicate-folder:')) ?? '';
    return { key, value: JSON.parse(sessionStorage.getItem(key) ?? 'null') };
  });
  release();
  await expect(dialog(page).getByRole('button', { name: 'Retry duplication', exact: true })).toBeEnabled();
  await expect(dialog(page).getByLabel('Folder name')).toBeDisabled();
  await page.reload();
  await openCopy(page);
  await expect(dialog(page).getByLabel('Folder name')).toHaveValue('Lost reply project');
  await expect(dialog(page).getByLabel('Folder name')).toBeDisabled();
  expect(requests).toHaveLength(1);
  let rechecks = 0,
    releaseSummary: () => void = () => {};
  const summaryGate = new Promise<void>((resolve) => {
    releaseSummary = resolve;
  });
  await page.route('**/internal/folders/*/duplicate-preview*', async (route) => {
    rechecks++;
    await summaryGate;
    await route.fulfill({ json: { ...previewBody(), token: 'b'.repeat(64) } });
  });
  await dialog(page).getByRole('button', { name: 'Retry duplication', exact: true }).click();
  await expect(dialog(page).getByRole('button', { name: 'Continue same duplication', exact: true })).toBeDisabled();
  await expect(dialog(page).getByRole('group', { name: 'Copy summary' })).toContainText('Checking copy size');
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  await expect(dialog(page).getByLabel('Folder name')).toBeDisabled();
  expect(await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? 'null').request, saved.key)).toEqual(
    requests[0]
  );
  await expect(dialog(page).getByRole('group', { name: 'Copy summary' })).toContainText(
    'earlier copy may already exist'
  );
  await dialog(page)
    .locator('form')
    .evaluate((form) => form.requestSubmit());
  expect(requests).toHaveLength(2);
  releaseSummary();
  await expect(dialog(page).getByRole('button', { name: 'Continue same duplication', exact: true })).toBeEnabled();
  await expect(dialog(page).getByRole('button', { name: 'Continue same duplication', exact: true })).toBeFocused();
  expect(rechecks).toBe(1);
  await expect(dialog(page).getByRole('button', { name: 'Refresh copy summary' })).toHaveCount(0);
  expect(requests).toHaveLength(2);
  expect(await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? 'null').request, saved.key)).toEqual(
    requests[0]
  );
  await dialog(page).getByRole('button', { name: 'Continue same duplication', exact: true }).click();
  await expect(page).toHaveURL(/\/folders\/folder_once$/);
  expect(requests).toHaveLength(3);
  expect(requests[2]).toEqual({ ...requests[0], previewToken: 'b'.repeat(64) });
  expect(api.folders.filter((item) => item.id === 'folder_once')).toHaveLength(1);
  expect(
    await page.evaluate(() =>
      Object.keys(sessionStorage).filter((key) => key.startsWith('minunotes:duplicate-folder:'))
    )
  ).toEqual([]);
  // An older unresolved three-field request is explicitly reviewed, never silently discarded/re-keyed.
  await mockCopyPreviews(page);
  const legacy = { title: 'Legacy project', parentFolderId: null, requestId: 'legacy_request_00001' };
  const legacyRequests: Record<string, unknown>[] = [];
  await page.evaluate(
    ({ saved, legacy }) => sessionStorage.setItem(saved.key, JSON.stringify({ ...saved.value, request: legacy })),
    { saved, legacy }
  );
  await page.route(`**/internal/folders/${browserFixture.folder.id}/duplicate`, async (route) => {
    const body = route.request().postDataJSON();
    legacyRequests.push(body);
    const copy = { ...browserFixture.folder, id: 'folder_legacy', title: legacy.title, parentFolderId: null };
    if (!body.previewToken) {
      api.folders.push(copy);
      await route.fulfill({ status: 428, json: { error: 'Review the copy summary to continue this same attempt' } });
    } else if (legacyRequests.length === 2) await route.abort('failed');
    else await route.fulfill({ json: { folder: copy, counts: previewBody().counts, replayed: true } });
  });
  await page.goto(folder);
  await openCopy(page);
  await dialog(page).getByRole('button', { name: 'Retry duplication', exact: true }).click();
  await expect(dialog(page).getByRole('button', { name: 'Continue same duplication', exact: true })).toBeEnabled();
  expect(legacyRequests).toEqual([legacy]);
  expect(await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? 'null').request, saved.key)).toEqual(
    legacy
  );
  await dialog(page).getByRole('button', { name: 'Continue same duplication', exact: true }).click();
  await expect(dialog(page).getByRole('button', { name: 'Retry duplication', exact: true })).toBeEnabled();
  await dialog(page).getByRole('button', { name: 'Retry duplication', exact: true }).click();
  await expect(page).toHaveURL(/\/folders\/folder_legacy$/);
  expect(legacyRequests[1]).toEqual({ ...legacy, previewToken: 'a'.repeat(64) });
  expect(legacyRequests[2]).toEqual(legacyRequests[1]);
  expect(api.folders.filter((row) => row.id === 'folder_legacy')).toHaveLength(1);
});
test('folder duplication: loading, over-limit and unconfirmed summaries cannot submit, exact caps can', async ({
  page,
}, info) => {
  await mockPropertyBoard(page);
  let mode = 'limit',
    release: () => void = () => {},
    first = true,
    reads = 0,
    writes = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/internal/folders/*/duplicate-preview*', async (route) => {
    reads++;
    if (first) {
      first = false;
      await gate;
    }
    if (mode === 'limit')
      await route.fulfill({
        status: 413,
        json: { error: 'This folder exceeds the copy limits; choose a smaller folder' },
      });
    else
      await route.fulfill({
        json: {
          ...previewBody(mode === 'wrong' ? 'wrong_source' : browserFixture.folder.id),
          counts: { folders: 2, notes: 99, templates: 1, attachments: 3 },
          imageBytes: 25 * 1024 * 1024,
        },
      });
  });
  await page.route(`**/internal/folders/${browserFixture.folder.id}/duplicate`, async (route) => {
    writes++;
    await route.abort('failed');
  });
  await page.goto(folder);
  await openCopy(page);
  const copy = dialog(page).getByRole('button', { name: 'Duplicate folder', exact: true }),
    summary = dialog(page).getByRole('group', { name: 'Copy summary' });
  await expect(summary).toContainText('Checking copy size');
  await expect(copy).toBeDisabled();
  await dialog(page)
    .locator('form')
    .evaluate((form) => form.requestSubmit());
  expect(writes).toBe(0);
  release();
  await expect(summary.getByRole('alert')).toContainText('exceeds the copy limits');
  await expect(copy).toBeDisabled();
  await dialog(page)
    .locator('form')
    .evaluate((form) => form.requestSubmit());
  expect(writes).toBe(0);
  expect(reads).toBe(1);
  await expect(summary.getByRole('button', { name: 'Refresh copy summary' })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('duplicate-folder-over-limit.png'), fullPage: true });
  mode = 'wrong';
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await openCopy(page);
  await expect(summary.getByRole('alert')).toContainText('not confirmed');
  await expect(copy).toBeDisabled();
  expect(reads).toBe(2);
  await dialog(page)
    .locator('form')
    .evaluate((form) => form.requestSubmit());
  expect(writes).toBe(0);
  mode = 'ok';
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await openCopy(page);
  await expect(summary).toContainText('99 notes · 1 template · 1 subfolder');
  await expect(summary).toContainText('3 uploaded images · 25 MB total');
  await expect(copy).toBeEnabled();
  expect(reads).toBe(3);
  expect(writes).toBe(0);
});
test('folder duplication: a late old-destination preview cannot replace the currently confirmed summary', async ({
  page,
}) => {
  const api = await mockPropertyBoard(page);
  api.folders.push({ ...browserFixture.folder, id: 'folder_destination', title: 'Destination', parentFolderId: null });
  let release: () => void = () => {};
  const reads: Array<string | null> = [];
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/internal/folders/*/duplicate-preview*', async (route) => {
    const parent = new URL(route.request().url()).searchParams.get('parentFolderId');
    reads.push(parent);
    if (!parent) {
      await gate;
      await route.fulfill({
        json: { ...previewBody(), counts: { folders: 2, notes: 88, templates: 0, attachments: 0 } },
      });
    } else await route.fulfill({ json: { ...previewBody(browserFixture.folder.id, parent), token: 'b'.repeat(64) } });
  });
  await page.goto(folder);
  await openCopy(page);
  await expect(dialog(page).getByRole('group', { name: 'Copy summary' })).toContainText('Checking copy size');
  await dialog(page).getByRole('button', { name: 'Destination', exact: true }).click();
  const copy = dialog(page).getByRole('button', { name: 'Duplicate folder', exact: true }),
    summary = dialog(page).getByRole('group', { name: 'Copy summary' });
  await expect(summary).toContainText('3 notes · 1 template · 1 subfolder');
  await expect(copy).toBeEnabled();
  release();
  await expect(summary).not.toContainText('88 notes');
  const requests: Record<string, unknown>[] = [];
  await page.route(`**/internal/folders/${browserFixture.folder.id}/duplicate`, async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status: 409, json: { error: 'Source changed' } });
  });
  await copy.click();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ parentFolderId: 'folder_destination', previewToken: 'b'.repeat(64) });
  await expect(dialog(page).getByRole('alert').filter({ hasText: 'Source changed' })).toBeVisible();
  await expect(copy).toBeEnabled();
  expect(reads).toEqual([null, 'folder_destination', 'folder_destination']);
  expect(requests).toHaveLength(1);
  await expect(summary).not.toContainText('88 notes');
});
