import { expect, type Page, test } from '@playwright/test';
import { type PersonalVisit, personalRecentsKey } from '../../src/frontend/lib/personal-recents';
import { browserFixture as f, mockBrowserApi } from './fixtures';

const key = personalRecentsKey('user_browser');
async function seed(page: Page, visits: PersonalVisit[]) {
  await page.addInitScript(({ key, visits }) => localStorage.setItem(key, JSON.stringify(visits)), { key, visits });
}
const home = (page: Page) => page.getByRole('region', { name: 'Home', exact: true });
const notes = (page: Page) => home(page).getByRole('region', { name: 'Recently opened notes' });
const folders = (page: Page) => home(page).getByRole('region', { name: 'Recent folders' });

test('only personal visits and opens populate Home; saves do not reorder visits', async ({ page }) => {
  const api = await mockBrowserApi(page);
  await page.goto('/');
  await expect(notes(page).getByText('No recently opened notes yet.')).toBeVisible();
  await expect(home(page).getByRole('link')).toHaveCount(0);
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: f.folder.title, exact: true })
    .click();
  await expect
    .poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '[]'), key))
    .toEqual([{ kind: 'folder', id: f.folder.id }]);
  await page.goto(`/notes/${f.source.id}`);
  await expect(page.locator('.cm-content')).toBeVisible();
  await expect
    .poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '[]')[0]?.id, key))
    .toBe(f.source.id);
  // A different open arrives while this note remains mounted. Saving must not promote this note again.
  await page.evaluate(
    ({ key, id }) => {
      const visits = JSON.parse(localStorage.getItem(key) ?? '[]');
      localStorage.setItem(key, JSON.stringify([{ kind: 'note', id }, ...visits]));
    },
    { key, id: f.linked.id }
  );
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' Saved edit.');
  await api.expectSavedContent('Start here. Saved edit.');
  await expect
    .poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '[]')[0]?.id, key))
    .toBe(f.linked.id);
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Home', exact: true }).click();
  await expect(folders(page).getByRole('link', { name: f.folder.title })).toBeVisible();
  await expect(notes(page).getByRole('link')).toHaveText([f.linked.title, f.source.title]);
  await expect(notes(page).getByRole('link', { name: f.canvas.title })).toHaveCount(0);
});

test('search replaces recents, clears back to them, and command-K still opens quick navigation', async ({ page }) => {
  await mockBrowserApi(page);
  await seed(page, [
    { kind: 'folder', id: f.folder.id },
    { kind: 'folder', id: f.childFolder.id },
    { kind: 'note', id: f.linked.id },
    { kind: 'note', id: f.source.id },
    { kind: 'note', id: f.canvas.id },
  ]);
  await page.goto('/');
  await expect(notes(page).getByRole('link')).toHaveCount(3);
  await page.screenshot({ path: 'artifacts/home-recents/desktop-idle.png', fullPage: true });
  const input = home(page).getByRole('searchbox');
  await input.fill('Source');
  await expect(home(page).getByRole('button', { name: 'Clear search' })).toHaveCount(1);
  // Keep search semantics while hiding the browser's duplicate clear control.
  await expect(input).toHaveClass(/\[&::-webkit-search-cancel-button\]:hidden/);
  await expect(home(page).getByRole('heading', { name: 'Recent folders' })).toHaveCount(0);
  const results = home(page).getByRole('region', { name: 'Search results' });
  await expect(results.getByRole('link', { name: f.source.title })).toBeVisible();
  await page.screenshot({ path: 'artifacts/home-recents/desktop-search.png', fullPage: true });
  await input.fill('Browser');
  await expect(results.getByRole('link', { name: f.folder.title, exact: true })).toBeVisible();
  await home(page).getByRole('button', { name: 'Clear search' }).click();
  await expect(notes(page).getByRole('link')).toHaveCount(3);
  await input.fill('   ');
  await expect(notes(page).getByRole('link')).toHaveCount(3);
  await page.keyboard.press('Meta+k');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close search' }).click();
  await input.fill('');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/home-recents/mobile-idle.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('checks access before display and excludes revoked, deleted and template items', async ({ page }) => {
  await mockBrowserApi(page);
  await seed(page, [
    { kind: 'note', id: f.source.id },
    { kind: 'note', id: f.linked.id },
    { kind: 'note', id: 'note_deleted' },
    { kind: 'note', id: f.template.id },
    { kind: 'folder', id: 'folder_deleted' },
  ]);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/internal/notes/${f.source.id}`, async (route) => {
    await gate;
    await route.fallback();
  });
  await page.route(`**/internal/notes/${f.linked.id}`, (route) =>
    route.fulfill({ status: 403, json: { error: 'Forbidden' } })
  );
  await page.goto('/');
  await expect(home(page).getByRole('status')).toHaveText('Loading recents…');
  await expect(notes(page).getByRole('link')).toHaveCount(0);
  release();
  await expect(notes(page).getByRole('link')).toHaveText([f.source.title]);
  await expect(folders(page).getByRole('link')).toHaveCount(0);
  // Clearing search requires another access check, never the previously displayed title.
  await page.route(`**/internal/notes/${f.source.id}`, (route) =>
    route.fulfill({ status: 404, json: { error: 'Not found' } })
  );
  await home(page).getByRole('searchbox').fill('Source');
  await expect(home(page).getByRole('region', { name: 'Search results' }).getByRole('link')).toHaveCount(1);
  await home(page).getByRole('button', { name: 'Clear search' }).click();
  await expect(notes(page).getByText('No recently opened notes yet.')).toBeVisible();
  await expect(notes(page).getByRole('link')).toHaveCount(0);
});

test('Home search respects the shared-folder limit and follows the next cursor', async ({ page }) => {
  await mockBrowserApi(page);
  const requests: Array<{ limit: number; cursor: string | null }> = [];
  await page.route('**/internal/collaborations/shared-with-me?*', (route) => {
    const params = new URL(route.request().url()).searchParams;
    const limit = Number(params.get('limit') ?? 25);
    const cursor = params.get('cursor');
    requests.push({ limit, cursor });
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      return route.fulfill({ status: 400, json: { error: 'Limit must be between 1 and 50' } });
    const offset = cursor === 'second-page' ? 50 : 0;
    const count = offset ? 1 : 50;
    return route.fulfill({
      json: {
        collaborations: Array.from({ length: count }, (_, index) => ({
          type: 'folder',
          grantId: `grant_${offset + index}`,
          role: 'viewer',
          owner: { label: 'Shared Owner' },
          folder: { id: `folder_paged_${offset + index}`, title: `Paged workspace ${offset + index}` },
        })),
        pageInfo: { hasMore: !offset, nextCursor: offset ? null : 'second-page' },
      },
    });
  });
  await page.goto('/');
  await home(page).getByRole('searchbox').fill('Paged workspace 50');
  const results = home(page).getByRole('region', { name: 'Search results' });
  await expect(results.getByRole('link', { name: 'Paged workspace 50', exact: true })).toBeVisible();
  expect(requests).toEqual([
    { limit: 50, cursor: null },
    { limit: 50, cursor: 'second-page' },
  ]);
  await home(page).getByRole('button', { name: 'Clear search' }).click();
  await expect(notes(page).getByText('No recently opened notes yet.')).toBeVisible();
});

test('does not display another account history', async ({ page }) => {
  await mockBrowserApi(page);
  await page.addInitScript(
    ({ id }) => localStorage.setItem('minunotes:personal-recents:other-user', JSON.stringify([{ kind: 'note', id }])),
    { id: f.source.id }
  );
  await page.goto('/');
  await expect(notes(page).getByText('No recently opened notes yet.')).toBeVisible();
});
