import { expect, type Page, test } from '@playwright/test';
import { browserFixture } from './fixtures';
import { mockPropertyBoard } from './property-board-fixtures';

const folderId = browserFixture.folder.id;
const bare = `/folders/${folderId}`;
const key = (user = 'user_browser', folder = folderId) =>
  `minunotes:folder-view:${encodeURIComponent(user)}:${encodeURIComponent(folder)}`;
async function seed(page: Page, values: Record<string, string>) {
  await page.addInitScript((values) => {
    for (const [key, value] of Object.entries(values))
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
  }, values);
}
async function switchView(page: Page, to: 'list' | 'board') {
  const title = await page.getByRole('main').getByRole('heading', { level: 2 }).innerText();
  await page
    .getByRole('main')
    .getByRole('button', { name: `Actions for ${title}`, exact: true })
    .click();
  await page.getByRole('button', { name: `Switch to ${to}`, exact: true }).click();
  await expect(page.getByRole('button', { name: /^Switch to (list|board)$/ })).toHaveCount(0);
}
async function stored(page: Page, user = 'user_browser', folder = folderId) {
  return page.evaluate((key) => localStorage.getItem(key), key(user, folder));
}

test('new folders default to List; explicit URLs override without saving; saved Board loads without List queries', async ({
  page,
}) => {
  const api = await mockPropertyBoard(page);
  await page.goto(bare);
  await expect(page).toHaveURL(`${bare}`);
  expect(await stored(page)).toBeNull();
  await page.goto(`${bare}?view=board`);
  await expect(page.getByRole('region', { name: 'Folder board', exact: true })).toBeVisible();
  expect(await stored(page)).toBeNull();
  await page.goto(bare);
  await expect(page).toHaveURL(`${bare}`);
  await switchView(page, 'board');
  await expect(page).toHaveURL(`${bare}?view=board`);
  expect(await stored(page)).toBe('board');
  const reads: string[] = [];
  page.on('request', (request) => {
    reads.push(new URL(request.url()).pathname);
  });
  await page.goto(bare);
  await expect(page).toHaveURL(`${bare}?view=board`);
  await expect(page.getByRole('region', { name: 'Folder board', exact: true })).toBeVisible();
  expect(reads).not.toContain(`/internal/folders/${folderId}/notes`);
  await page.reload();
  await expect(page).toHaveURL(`${bare}?view=board`);
  await page.goto(`${bare}?view=list`);
  await expect(page).toHaveURL(`${bare}`);
  expect(await stored(page)).toBe('board');
  expect(api.requests.filter((request) => request.method !== 'GET')).toEqual([]);
});

test('bare List history survives reload while the saved preference is Board; fresh entry restores Board', async ({
  page,
}) => {
  const api = await mockPropertyBoard(page);
  await page.goto(bare);
  await expect(page.getByRole('main').getByRole('table')).toBeVisible();
  await switchView(page, 'board');
  await expect(page).toHaveURL(`${bare}?view=board`);
  expect(await stored(page)).toBe('board');
  await page.goBack();
  await expect(page).toHaveURL(bare);
  await expect(page.getByRole('main').getByRole('table')).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(bare);
  await expect(page.getByRole('main').getByRole('table')).toBeVisible();
  expect(await stored(page)).toBe('board');
  await page.goto(`/notes/${browserFixture.source.id}`);
  await page.goto(bare);
  await expect(page).toHaveURL(`${bare}?view=board`);
  await expect(page.getByRole('region', { name: 'Folder board', exact: true })).toBeVisible();
  await page.goto(`${bare}?view=list`);
  await expect(page).toHaveURL(bare);
  await page.reload();
  await expect(page).toHaveURL(bare);
  await expect(page.getByRole('main').getByRole('table')).toBeVisible();
  expect(await stored(page)).toBe('board');
  expect(api.requests.filter((request) => request.method !== 'GET')).toEqual([]);
});

test('saved choices survive reload and history entries keep their view after later changes', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  await page.goto(bare);
  await expect(page).toHaveURL(`${bare}`);
  await switchView(page, 'board');
  await expect(page).toHaveURL(`${bare}?view=board`);
  await switchView(page, 'list');
  await expect(page).toHaveURL(`${bare}`);
  expect(await stored(page)).toBe('list');
  await page.goBack();
  await expect(page).toHaveURL(`${bare}?view=board`);
  await page.goBack();
  await expect(page).toHaveURL(`${bare}`);
  await page.goForward();
  await expect(page).toHaveURL(`${bare}?view=board`);
  expect(await stored(page)).toBe('list');
  await page.reload();
  await expect(page).toHaveURL(`${bare}?view=board`);
  await page.goto(bare);
  await expect(page).toHaveURL(`${bare}`);
  expect(api.requests.filter((request) => request.method !== 'GET')).toEqual([]);
});

test('sidebar and child picker honor independent destination choices rather than the parent view', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  const child = browserFixture.childFolder;
  await seed(page, { [key()]: 'list', [key('user_browser', child.id)]: 'board' });
  await page.route(`**/internal/folders/${child.id}/board/config`, (route) =>
    route.fulfill({ json: { board: null, access: { role: 'owner', source: 'owner' } } })
  );
  await page.goto(`${bare}?view=board`);
  await page.getByRole('button', { name: 'Subfolders · 1', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Subfolder results' })
    .getByRole('link', { name: child.title, exact: true })
    .click();
  await expect(page).toHaveURL(`/folders/${child.id}?view=board`);
  await expect(page.getByText('Board is not enabled.', { exact: false })).toBeVisible();
  expect(await stored(page)).toBe('list');
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: browserFixture.folder.title, exact: true })
    .click();
  await expect(page).toHaveURL(`${bare}`);
  expect(await stored(page, 'user_browser', child.id)).toBe('board');
  expect(api.requests.filter((request) => request.method !== 'GET')).toEqual([]);
});

test('preferences are isolated by authenticated identity, even in the same browser storage', async ({ page }) => {
  await mockPropertyBoard(page);
  await seed(page, { [key()]: 'board', [key('other_user')]: 'list' });
  await page.goto(bare);
  await expect(page).toHaveURL(`${bare}?view=board`);
  await page.route('**/internal/auth/get-session', (route) =>
    route.fulfill({
      json: {
        user: {
          id: 'other_user',
          name: '',
          email: 'other@example.com',
          emailVerified: true,
          image: null,
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01',
        },
        session: { id: 'other_session', userId: 'other_user', expiresAt: '2099-01-01T00:00:00.000Z' },
      },
    })
  );
  await page.goto(bare);
  await expect(page).toHaveURL(`${bare}`);
  await switchView(page, 'board');
  expect(await stored(page, 'other_user')).toBe('board');
  expect(await stored(page)).toBe('board');
  await switchView(page, 'list');
  expect(await stored(page, 'other_user')).toBe('list');
  expect(await stored(page)).toBe('board');
});

for (const role of ['owner', 'editor', 'viewer', 'commenter'] as const)
  test(`${role} can remember a view without enabling a disabled board or gaining folder rights`, async ({ page }) => {
    const api = await mockPropertyBoard(page, { role, disabled: true });
    await page.goto(bare);
    await expect(page).toHaveURL(`${bare}`);
    const trigger = page
      .getByRole('main')
      .getByRole('button', { name: `Actions for ${browserFixture.folder.title}`, exact: true });
    await trigger.click();
    const action = page.getByRole('button', { name: 'Switch to board', exact: true });
    const names = await action.locator('..').getByRole('button').allTextContents();
    if (role === 'owner') expect(names.indexOf('Switch to board')).toBe(names.indexOf('Move') + 1);
    else for (const name of ['Settings', 'Share', 'Rename', 'Move']) expect(names).not.toContain(name);
    await page.screenshot({ path: test.info().outputPath('view-action-order.png') });
    await action.click();
    await expect(page).toHaveURL(`${bare}?view=board`);
    expect(await stored(page)).toBe('board');
    await expect(page.getByRole('alert')).toContainText('Grouping unavailable');
    await expect(page.getByRole('region', { name: 'Folder board', exact: true })).toHaveCount(0);
    await page.goto(bare);
    await expect(page).toHaveURL(`${bare}?view=board`);
    expect(api.snapshot().config.enabled).toBe(false);
    expect(api.requests.filter((request) => request.method !== 'GET')).toEqual([]);
  });

for (const blocked of [false, true])
  test(`corrupt or blocked storage is safe (blocked=${blocked})`, async ({ page }) => {
    const api = await mockPropertyBoard(page);
    if (blocked)
      await page.addInitScript(() => {
        const get = Storage.prototype.getItem,
          set = Storage.prototype.setItem;
        Storage.prototype.getItem = function (key) {
          if (key.startsWith('minunotes:folder-view:')) throw new Error('Denied');
          return get.call(this, key);
        };
        Storage.prototype.setItem = function (key, value) {
          if (key.startsWith('minunotes:folder-view:')) throw new Error('Quota');
          return set.call(this, key, value);
        };
      });
    else await seed(page, { [key()]: '{bad data}' });
    await page.goto(`${bare}?view=unknown`);
    await expect(page).toHaveURL(`${bare}`);
    await switchView(page, 'board');
    await expect(page).toHaveURL(`${bare}?view=board`);
    await page.goto(bare);
    await expect(page).toHaveURL(blocked ? `${bare}` : `${bare}?view=board`);
    expect(api.requests.filter((request) => request.method !== 'GET')).toEqual([]);
  });
