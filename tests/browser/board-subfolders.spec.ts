import { expect, type Page, test } from '@playwright/test';
import type { Folder } from '../../src/frontend/lib/api';
import { browserFixture } from './fixtures';
import { mockPropertyBoard } from './property-board-fixtures';

const parentId = browserFixture.folder.id;
async function openFolderViews(page: Page) {
  const main = page.getByRole('main');
  const title = await main.getByRole('heading', { level: 2 }).innerText();
  await main.getByRole('button', { name: `Actions for ${title}`, exact: true }).click();
  const views = page.getByRole('button', { name: /^Switch to (list|board)$/ });
  await expect(views).toBeVisible();
  return views;
}
async function switchFolderView(page: Page, name: 'List' | 'Board') {
  const views = await openFolderViews(page);
  await expect(views).toHaveText(`Switch to ${name.toLowerCase()}`);
  await views.click();
  await expect(views).toHaveCount(0);
}

const boardUrl = `/folders/${parentId}?view=board`;
const detailPath = (id = parentId) => `/internal/folders/${id}/detail`;
const board = (page: Page) => page.getByRole('region', { name: 'Folder board', exact: true });
const picker = (page: Page) => page.getByRole('dialog', { name: 'Subfolders', exact: true });
const results = (page: Page) => picker(page).getByRole('navigation', { name: 'Subfolder results', exact: true });
const trigger = (page: Page, count: number) =>
  page.getByRole('button', { name: `Subfolders · ${count.toLocaleString()}`, exact: true });
const children = (count: number, folderId = parentId): Folder[] =>
  Array.from({ length: count }, (_, i) => ({
    ...browserFixture.childFolder,
    id: `folder_sub_${String(i + 1).padStart(4, '0')}`,
    parentFolderId: folderId,
    title: `Directory ${String(i + 1).padStart(4, '0')}`,
  }));

async function mockChildren(page: Page, count: number, options: Parameters<typeof mockPropertyBoard>[1] = {}) {
  const api = await mockPropertyBoard(page, options);
  const role = options.role ?? 'owner';
  const access = { role, source: role === 'owner' ? 'owner' : 'folder_grant' };
  const controls = { children: children(count), status: 0 };
  const detailRequests: string[] = [];
  const known = new Map<string, { folder: Folder; children: Folder[] }>();
  const holds = new Map<string, { reached: () => void; released: Promise<void> }>();
  // Owner-wide cache deliberately differs from authorized direct children; NEVER a picker source.
  api.folders.push({ ...browserFixture.childFolder, id: 'folder_cache_only', title: 'Cache-only child' });
  api.folders.push({
    ...browserFixture.childFolder,
    id: 'folder_grandchild',
    parentFolderId: browserFixture.childFolder.id,
    title: 'Grandchild not direct',
  });
  api.folders.push({ ...browserFixture.folder, id: 'folder_unrelated', title: 'Unrelated root' });
  await page.route('**/internal/folders/*/detail', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2) ?? '';
    if (route.request().method() !== 'GET') return route.fallback();
    detailRequests.push(id);
    const destination = known.get(id);
    const folder =
      id === parentId
        ? browserFixture.folder
        : (destination?.folder ?? controls.children.find((child) => child.id === id));
    if (!folder) return route.fallback();
    const status = id === parentId ? controls.status : 0;
    const response = structuredClone({
      folder,
      childFolders: id === parentId ? controls.children : (destination?.children ?? []),
      ancestors: [],
      access,
      sharedBy: null,
    });
    const hold = holds.get(id);
    if (hold) {
      holds.delete(id);
      hold.reached();
      await hold.released;
    }
    return route.fulfill({
      status: status || 200,
      json: status ? { error: 'Synthetic folder-detail failure' } : response,
    });
  });
  await page.route('**/internal/folders/*/notes*', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2) ?? '';
    if (route.request().method() !== 'GET' || id === parentId) return route.fallback();
    if (!known.has(id) && !controls.children.some((child) => child.id === id)) return route.fallback();
    return route.fulfill({ json: { notes: [], page: 1, limit: 50, hasMore: false, access } });
  });
  // Synthetic child boards are absent, not copies of the parent's cards/configuration.
  await page.route('**/internal/folders/*/board/config', (route) => {
    if (new URL(route.request().url()).pathname === `/internal/folders/${parentId}/board/config`)
      return route.fallback();
    return route.fulfill({ json: { board: null, access } });
  });
  return {
    ...api,
    boardControls: api.controls,
    controls,
    detailRequests,
    known,
    holdDetail(id = parentId) {
      let reached = () => {},
        release = () => {};
      const started = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      holds.set(id, { reached, released });
      return { started, release };
    },
  };
}
async function ready(page: Page) {
  await expect(board(page).getByRole('link')).toHaveCount(3);
  await expect(board(page).getByRole('status')).toHaveCount(0);
  await expect(board(page).getByRole('heading', { level: 3 })).toHaveText([
    'Ready',
    'Finished',
    'Empty',
    'Unclassified',
  ]);
}
async function refocusDetail(page: Page) {
  // The normal visibility transition, NOT a new refresh API or test-only app hook.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    window.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    window.dispatchEvent(new Event('visibilitychange'));
  });
}
async function open(page: Page, count: number) {
  await trigger(page, count).click();
  await expect(picker(page).getByRole('searchbox', { name: 'Search subfolders', exact: true })).toBeFocused();
}

test('successful zero hides navigation without owner-cache fallback; one child stays compact and direct-only', async ({
  page,
}) => {
  const api = await mockChildren(page, 0);
  await page.goto(boardUrl);
  await ready(page);
  await expect(page.getByRole('button', { name: /^Subfolders/ })).toHaveCount(0);
  await expect(page.getByRole('main').getByRole('navigation', { name: 'Subfolders', exact: true })).toHaveCount(0);
  await expect(page.getByRole('main').getByRole('link', { name: 'Cache-only child', exact: true })).toHaveCount(0);
  api.controls.children = children(1);
  const read = page.waitForResponse((r) => new URL(r.url()).pathname === detailPath());
  await refocusDetail(page);
  await read;
  await expect(trigger(page, 1)).toBeVisible();
  await ready(page);
  const before = structuredClone(api.requests);
  await expect(page.getByRole('main').getByRole('link', { name: 'Directory 0001', exact: true })).toHaveCount(0);
  expect(await trigger(page, 1).evaluate((button) => button.closest('nav') === null)).toBe(true);
  await open(page, 1);
  await expect(results(page).getByRole('link')).toHaveCount(1);
  await expect(results(page).getByRole('link')).toHaveAttribute('href', '/folders/folder_sub_0001');
  await expect(picker(page).getByRole('status')).toHaveText('1–1 of 1');
  await expect(picker(page).getByRole('button', { name: 'Next', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(trigger(page, 1)).toBeFocused();
  expect(api.requests).toEqual(before);
  expect(api.requests.filter((request) => request.method !== 'GET')).toEqual([]);
});

test('1000 children mount only50 links, search the final child immediately, and replace pages through both boundaries without GETs', async ({
  page,
}) => {
  const api = await mockChildren(page, 1000);
  await page.goto(`${boardUrl}&boardTags=feature`);
  await ready(page);
  const before = structuredClone(api.requests);
  const cardIds = await board(page)
    .getByRole('link')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href')));
  await open(page, 1000);
  const search = picker(page).getByRole('searchbox');
  await expect(results(page).getByRole('link')).toHaveCount(50);
  await expect(picker(page).getByRole('status')).toHaveText('1–50 of 1,000');
  await expect(picker(page).getByRole('button', { name: 'Previous', exact: true })).toBeDisabled();
  await picker(page).getByRole('button', { name: 'Next', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(picker(page).getByRole('status')).toHaveText('51–100 of 1,000');
  await expect.poll(() => results(page).evaluate((element) => element.scrollTop)).toBe(0);
  await picker(page).getByRole('button', { name: 'Previous', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(picker(page).getByRole('status')).toHaveText('1–50 of 1,000');
  await search.fill('  dIrEcToRy 1000  ');
  await expect(results(page).getByRole('link')).toHaveText(['Directory 1000']);
  await expect(trigger(page, 1000)).toHaveText('Subfolders · 1,000');
  await expect(picker(page).getByRole('status')).toHaveText('1–1 of 1');
  await search.fill('does not exist');
  await expect(picker(page).getByText('No matching subfolders.', { exact: true })).toBeVisible();
  await expect(results(page).getByRole('link')).toHaveCount(0);
  await picker(page).getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(search).toBeFocused();
  for (let n = 1; n < 20; n++) {
    await picker(page).getByRole('button', { name: 'Next', exact: true }).click();
    await expect(picker(page).getByRole('status')).toHaveText(
      `${(n * 50 + 1).toLocaleString()}–${((n + 1) * 50).toLocaleString()} of 1,000`
    );
    await expect(results(page).getByRole('link')).toHaveCount(50);
    await expect(results(page).getByRole('link').first()).toHaveText(
      `Directory ${String(n * 50 + 1).padStart(4, '0')}`
    );
  }
  await expect(picker(page).getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  await picker(page).getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(picker(page).getByRole('status')).toHaveText('901–950 of 1,000');
  await search.fill('directory 00');
  await expect(picker(page).getByRole('status')).toHaveText('1–50 of 99');
  await page.keyboard.press('Escape');
  await open(page, 1000);
  await expect(search).toHaveValue('');
  await expect(picker(page).getByRole('status')).toHaveText('1–50 of 1,000');
  expect(
    await board(page)
      .getByRole('link')
      .evaluateAll((links) => links.map((link) => link.getAttribute('href')))
  ).toEqual(cardIds);
  expect(api.requests).toEqual(before);
  expect(api.requests.filter((request) => request.method !== 'GET')).toEqual([]);
  expect(api.requests.some((request) => /\/internal\/notes\//.test(request.path))).toBe(false);
});

test('case-insensitive alphabetical ties use IDs; native child navigation resets parent filters and Back/Forward keeps URLs', async ({
  page,
}) => {
  const api = await mockChildren(page, 3);
  api.controls.children = [
    { ...children(1)[0], id: 'folder_tie_z', title: 'Same' },
    { ...children(1)[0], id: 'folder_tie_a', title: 'same' },
    { ...children(1)[0], id: 'folder_alpha', title: 'alpha' },
  ];
  await page.goto(`${boardUrl}&boardTags=feature`);
  await ready(page);
  await open(page, 3);
  await expect(results(page).getByRole('link')).toHaveText(['alpha', 'same', 'Same']);
  expect(
    await results(page)
      .getByRole('link')
      .evaluateAll((links) => links.map((link) => link.getAttribute('href')))
  ).toEqual(['/folders/folder_alpha', '/folders/folder_tie_a', '/folders/folder_tie_z']);
  const child = results(page).getByRole('link', { name: 'same', exact: true });
  await child.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/folders/folder_tie_a');
  await openFolderViews(page);
  await expect(page.getByRole('button', { name: 'Switch to board', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(picker(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 2, name: 'same', exact: true })).toBeVisible();
  await expect(board(page)).toHaveCount(0);
  await page.goBack();
  // Existing property-only search validation retires boardTags on history navigation.
  await expect(page).toHaveURL(boardUrl);
  await open(page, 3);
  await expect(picker(page).getByRole('searchbox')).toHaveValue('');
  await page.keyboard.press('Escape');
  await page.goForward();
  await expect(page).toHaveURL('/folders/folder_tie_a');
  expect(api.requests.filter((request) => request.method !== 'GET')).toEqual([]);
});

test('modified native link opens a separate window without closing/resetting the parent picker', async ({
  page,
  context,
}) => {
  await mockChildren(page, 1);
  await page.goto(boardUrl);
  await ready(page);
  await open(page, 1);
  const link = results(page).getByRole('link');
  await expect(link).toHaveAttribute('href', '/folders/folder_sub_0001');
  // Local document overlay only for the NEW tab; no unmocked app/auth/backend access.
  await context.route('**/folders/folder_sub_0001', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Synthetic child tab</title>' })
  );
  // Native modifier-created windows can have no opener; observe the context, not window.open's popup event.
  const pending = context.waitForEvent('page');
  await link.click({ modifiers: ['Shift'] });
  const tab = await pending;
  try {
    await expect(tab).toHaveURL('/folders/folder_sub_0001');
    await expect(tab).toHaveTitle('Synthetic child tab');
  } finally {
    await tab.close();
  }
  await expect(page).toHaveURL(boardUrl);
  await expect(picker(page)).toBeVisible();
});

test('normal data refresh clamps pages, reflects rename/move, resets scrolling and final-child teardown returns header focus', async ({
  page,
}) => {
  const api = await mockChildren(page, 120);
  await page.goto(boardUrl);
  await ready(page);
  await open(page, 120);
  await picker(page).getByRole('button', { name: 'Next', exact: true }).click();
  await picker(page).getByRole('button', { name: 'Next', exact: true }).click();
  await expect(picker(page).getByRole('status')).toHaveText('101–120 of 120');
  api.controls.children = api.controls.children.slice(0, 55);
  await refocusDetail(page);
  await expect(trigger(page, 55)).toBeVisible();
  await expect(picker(page).getByRole('status')).toHaveText('51–55 of 55');
  api.controls.children[54].title = 'AAAA renamed';
  await refocusDetail(page);
  await picker(page).getByRole('searchbox').fill('aaaa');
  await expect(results(page).getByRole('link')).toHaveText(['AAAA renamed']);
  api.controls.children = api.controls.children.filter((child) => child.id !== 'folder_sub_0055');
  await refocusDetail(page);
  await expect(trigger(page, 54)).toBeVisible();
  await expect(picker(page).getByText('No matching subfolders.', { exact: true })).toBeVisible();
  api.controls.children = [];
  await refocusDetail(page);
  await expect(picker(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Subfolders/ })).toHaveCount(0);
  await expect(
    page.getByRole('main').getByRole('button', { name: `Actions for ${browserFixture.folder.title}`, exact: true })
  ).toBeFocused();
  expect(api.requests.filter((request) => request.method !== 'GET')).toEqual([]);
});

for (const role of ['owner', 'editor', 'viewer', 'commenter'] as const)
  test(`${role} can navigate server-visible children without management controls`, async ({ page }) => {
    const api = await mockChildren(page, 1, { role });
    await page.goto(boardUrl);
    await ready(page);
    await open(page, 1);
    await expect(results(page).getByRole('link')).toHaveText(['Directory 0001']);
    await expect(picker(page).getByRole('button')).toHaveCount(0);
    await results(page).getByRole('link').click();
    await expect(page).toHaveURL('/folders/folder_sub_0001');
    expect(api.requests.filter((request) => request.method !== 'GET')).toEqual([]);
  });
for (const status of [401, 403, 404])
  test(`current-folder ${status} closes cached picker and never reveals owner-wide fallback`, async ({ page }) => {
    const api = await mockChildren(page, 1);
    await page.goto(boardUrl);
    await ready(page);
    await open(page, 1);
    const before = api.detailRequests.filter((id) => id === parentId).length;
    api.controls.status = status;
    await refocusDetail(page);
    await expect(page.getByText('Folder not found', { exact: true })).toBeVisible();
    await expect(picker(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Subfolders/ })).toHaveCount(0);
    await expect(page.getByRole('main').getByText(/Directory 0001|Cache-only child|Grandchild not direct/)).toHaveCount(
      0
    );
    expect(api.detailRequests.filter((id) => id === parentId)).toHaveLength(before + 1);
    if (status !== 404) {
      // The existing app-shell observer retries this shared query. A later500 is NOT authorization.
      const failedAgain = page.waitForResponse((r) => new URL(r.url()).pathname === detailPath() && r.status() === 500);
      api.controls.status = 500;
      await failedAgain;
      await expect(page.getByText('Folder not found', { exact: true })).toBeVisible();
      await expect(picker(page)).toHaveCount(0);
      await expect(page.getByRole('button', { name: /^Subfolders/ })).toHaveCount(0);
      api.controls.status = 0;
      await expect(trigger(page, 1)).toBeVisible(); // ONLY the fresh successful authorized read recovers.
    }
    expect(api.requests.filter((request) => request.method !== 'GET')).toEqual([]);
  });

test('initial folder loading is not zero; transient failure is truthful and Retry reads ONLY folder detail', async ({
  page,
}) => {
  const api = await mockChildren(page, 1);
  api.controls.status = 500;
  const held = api.holdDetail();
  try {
    await page.goto(boardUrl);
    await held.started;
    await expect(page.getByText('Loading folder...', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Subfolders/ })).toHaveCount(0);
  } finally {
    held.release();
  }
  const retry = page.getByRole('button', { name: 'Retry subfolders', exact: true });
  await expect(retry).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('Subfolders unavailable', { exact: true })).toBeVisible();
  await ready(page);
  const before = api.requests.length;
  api.controls.status = 0;
  await retry.click();
  await expect(trigger(page, 1)).toBeVisible();
  expect(api.requests.slice(before)).toEqual([{ path: detailPath(), method: 'GET' }]);
  await open(page, 1);
  await expect(results(page).getByRole('link')).toHaveCount(1);
});

test('cached transient error suppresses stale navigation and retries without refreshing board generations', async ({
  page,
}) => {
  const api = await mockChildren(page, 1);
  await page.goto(boardUrl);
  await ready(page);
  await open(page, 1);
  api.controls.status = 500;
  await refocusDetail(page);
  const retry = page.getByRole('button', { name: 'Retry subfolders', exact: true });
  await expect(retry).toBeVisible({ timeout: 15000 });
  await expect(picker(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Subfolders/ })).toHaveCount(0);
  await ready(page);
  const before = api.requests.length;
  api.controls.status = 0;
  api.controls.children = children(2);
  await retry.click();
  await expect(trigger(page, 2)).toBeVisible();
  expect(api.requests.slice(before)).toEqual([{ path: detailPath(), method: 'GET' }]);
});

test('late old-folder detail cannot revive the current child picker; view switch also clears local state', async ({
  page,
}) => {
  const api = await mockChildren(page, 1);
  const child = api.controls.children[0];
  const grandchildren = children(2, child.id).map((folder, index) => ({
    ...folder,
    id: `folder_nested_${index}`,
    title: `Nested ${index}`,
  }));
  api.known.set(child.id, { folder: child, children: grandchildren });
  await page.goto(boardUrl);
  await ready(page);
  await open(page, 1);
  const held = api.holdDetail();
  try {
    await refocusDetail(page);
    await held.started;
    await results(page).getByRole('link').click();
    await expect(page).toHaveURL(`/folders/${child.id}`);
    await switchFolderView(page, 'Board');
    await open(page, 2);
    await expect(results(page).getByRole('link')).toHaveText(['Nested 0', 'Nested 1']);
    const oldResponse = page.waitForResponse((r) => new URL(r.url()).pathname === detailPath());
    held.release();
    await oldResponse;
    await expect(trigger(page, 2)).toBeVisible();
    await expect(results(page).getByRole('link')).toHaveText(['Nested 0', 'Nested 1']);
    await picker(page).getByRole('searchbox').fill('Nested 1');
    await switchFolderView(page, 'List');
    await expect(picker(page)).toHaveCount(0);
    await switchFolderView(page, 'Board');
    await open(page, 2);
    await expect(picker(page).getByRole('searchbox')).toHaveValue('');
  } finally {
    held.release();
  }
  expect(api.requests.filter((request) => request.method !== 'GET')).toEqual([]);
});

for (const mode of ['disabled', 'absent', 'unavailable'] as const)
  test(`${mode} board does not hide authorized child navigation`, async ({ page }) => {
    const api = await mockChildren(page, 1, { disabled: mode === 'disabled', absent: mode === 'absent' });
    if (mode === 'unavailable') api.boardControls.unavailable = true;
    await page.goto(boardUrl);
    await open(page, 1);
    await expect(board(page)).toHaveCount(0);
    await expect(results(page).getByRole('link')).toHaveCount(1);
    await results(page).getByRole('link').click();
    await expect(page).toHaveURL('/folders/folder_sub_0001');
    expect(api.requests.filter((request) => request.method !== 'GET')).toEqual([]);
  });

test('opening the existing new-options portal dismisses the picker without swallowing normal controls', async ({
  page,
}) => {
  const api = await mockChildren(page, 1);
  await page.goto(boardUrl);
  await ready(page);
  await open(page, 1);
  await page.getByRole('button', { name: 'Open new options', exact: true }).click();
  await expect(picker(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Canvas', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Canvas', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open new options', exact: true })).toBeFocused();
  expect(api.requests.filter((request) => request.method !== 'GET')).toEqual([]);
});

test('List contents/actions and existing pagination stay separate from board-only navigation', async ({ page }) => {
  const api = await mockChildren(page, 1);
  api.controls.children = [{ ...browserFixture.childFolder }];
  await page.goto(`/folders/${parentId}`);
  await expect(
    page.getByRole('table').getByRole('link', { name: browserFixture.childFolder.title, exact: true })
  ).toBeVisible();
  await expect(page.getByRole('table').getByLabel('Select Source Note', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Subfolders/ })).toHaveCount(0);
  await expect(board(page)).toHaveCount(0);
  expect(api.requests.filter((request) => request.method !== 'GET')).toEqual([]);
});

for (const theme of ['catppuccin-latte', 'catppuccin-mocha'])
  for (const width of [390, 1280])
    test(`bounded whole-row native navigation in ${theme} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.addInitScript((value) => localStorage.setItem('notes-theme', value), theme);
      const api = await mockChildren(page, 1);
      await page.goto(boardUrl);
      await ready(page);
      const y = (await board(page).boundingBox())?.y;
      api.controls.children = children(1000);
      api.controls.children[0].title = 'A long subfolder title remains fully accessible while the picker stays bounded';
      await refocusDetail(page);
      await expect(trigger(page, 1000)).toBeVisible();
      await ready(page);
      expect((await board(page).boundingBox())?.y).toBe(y);
      const before = structuredClone(api.requests);
      await trigger(page, 1000).focus();
      await page.keyboard.press('Enter');
      const search = picker(page).getByRole('searchbox');
      await expect(search).toBeFocused();
      await expect(trigger(page, 1000)).toHaveAttribute('aria-expanded', 'true');
      const first = results(page).getByRole('link').first();
      await expect(first).toHaveAttribute('title', api.controls.children[0].title);
      await expect(first.locator('svg')).toHaveAttribute('aria-hidden', 'true');
      await first.hover();
      const hover = await first.evaluate((row) => getComputedStyle(row).backgroundColor);
      expect(hover).not.toBe('rgba(0, 0, 0, 0)');
      await page.mouse.move(0, 0);
      await search.focus();
      await page.keyboard.press('Tab');
      await expect(first).toBeFocused();
      await expect(first).toHaveCSS('background-color', hover);
      await expect(picker(page).getByRole('listbox')).toHaveCount(0);
      await expect(picker(page).getByRole('menu')).toHaveCount(0);
      const scroller = results(page);
      expect(
        await scroller.evaluate(
          (el) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overscrollBehaviorY === 'contain'
        )
      ).toBe(true);
      const boardScroll = await board(page).evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop }));
      await scroller.hover();
      await page.mouse.wheel(0, 250);
      await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      expect(await board(page).evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop }))).toEqual(boardScroll);
      await search.fill('directory 099');
      await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(0);
      await expect(picker(page).getByRole('status')).toHaveText('1–10 of 10');
      await picker(page).getByRole('button', { name: 'Clear search', exact: true }).click();
      await expect(results(page).getByRole('link')).toHaveCount(50);
      await page.screenshot({ path: test.info().outputPath(`subfolders-open-${theme}-${width}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const bounds = await picker(page).boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds?.x).toBeGreaterThanOrEqual(0);
      expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width);
      expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(844);
      await page.keyboard.press('Escape');
      await expect(trigger(page, 1000)).toBeFocused();
      await page.screenshot({ path: test.info().outputPath(`subfolders-closed-${theme}-${width}.png`) });
      await open(page, 1000);
      await page.getByRole('heading', { level: 2, name: browserFixture.folder.title, exact: true }).click();
      await expect(picker(page)).toHaveCount(0);
      await expect(trigger(page, 1000)).toBeFocused();
      expect(api.requests).toEqual(before);
      expect(api.requests.filter((request) => request.method !== 'GET')).toEqual([]);
    });
