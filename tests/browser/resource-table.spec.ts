import { expect, type Locator, type Page, test } from '@playwright/test';
import { browserFixture, mockBrowserApi } from './fixtures';

const longTitle = `Long ${'unbroken_title_'.repeat(60)}`;
const spacedTitle = `Many ${'words in a title '.repeat(30)}`;
const paths = {
  recent: '/',
  folder: `/folders/${browserFixture.folder.id}`,
  templates: '/templates',
  shared: '/shared',
  owned: '/shared/by-me',
  public: '/share/folders/folder_share_token',
} as const;

async function fixtures(page: Page) {
  const api = await mockBrowserApi(page, { includeSharedCollaborations: true, includeSharedByMe: true });
  api.notes.set(browserFixture.source.id, { ...browserFixture.source, title: longTitle });
  api.notes.set(browserFixture.target.id, { ...browserFixture.target, title: spacedTitle });
  api.notes.set(browserFixture.template.id, { ...browserFixture.template, title: longTitle });
  const writes: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/internal/') && request.method() !== 'GET')
      writes.push(request.url());
  });
  await page.route('**/internal/collaborations/shared-with-me*', (route) => {
    const type = new URL(route.request().url()).searchParams.get('type') ?? 'note';
    const resource = {
      id: type === 'note' ? browserFixture.source.id : browserFixture.folder.id,
      title: longTitle,
      updatedAt: browserFixture.source.updatedAt,
      ...(type === 'note' ? { documentType: 'markdown' } : {}),
    };
    return route.fulfill({
      json: {
        collaborations: [
          {
            type,
            grantId: `grant_${type}`,
            role: 'viewer',
            owner: {
              key: 'owner',
              type: 'user',
              label: 'Owner',
              displayName: null,
              maskedEmail: null,
              isCurrentUser: false,
            },
            [type]: resource,
          },
        ],
        pageInfo: { hasMore: false, nextCursor: null },
      },
    });
  });
  await page.route('**/internal/collaborations/shared-by-me*', (route) => {
    const type = new URL(route.request().url()).searchParams.get('type') ?? 'note';
    return route.fulfill({
      json: {
        resources: [
          {
            type,
            resource: {
              id: type === 'note' ? browserFixture.source.id : browserFixture.folder.id,
              title: longTitle,
              updatedAt: browserFixture.source.updatedAt,
            },
            activeCollaboratorCount: 2,
            pendingInvitationCount: 1,
            expiredInvitationCount: 0,
            publicLinkActive: true,
          },
        ],
        pageInfo: { hasMore: false, nextCursor: null },
      },
    });
  });
  return { api, writes };
}

async function assertTableBounds(container: Locator, allVisible: boolean) {
  const bounds = await container.evaluate((el) => {
    const table = el.querySelector('table');
    if (!table) throw new Error('Shared table missing');
    const rect = el.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      overflow: getComputedStyle(el).overflowX,
      width: el.clientWidth,
      extent: el.scrollWidth,
      tableWidth: table.clientWidth,
      tableExtent: table.scrollWidth,
      headers: [...table.querySelectorAll('th')]
        .filter((h) => getComputedStyle(h).display !== 'none')
        .map((h) => {
          const r = h.getBoundingClientRect();
          return { left: r.left, right: r.right };
        }),
    };
  });
  expect(bounds.overflow).toBe('auto');
  expect(bounds.tableExtent - bounds.tableWidth).toBeLessThanOrEqual(2);
  if (allVisible) {
    expect(bounds.extent - bounds.width).toBeLessThanOrEqual(2);
    for (const header of bounds.headers) {
      expect(header.left).toBeGreaterThanOrEqual(bounds.left - 1);
      expect(header.right).toBeLessThanOrEqual(bounds.right + 1);
    }
  }
}

for (const view of Object.keys(paths) as Array<keyof typeof paths>)
  for (const width of [390, 840, 1280])
    for (const theme of ['catppuccin-latte', 'catppuccin-mocha'])
      test(`${view} uses the shared resource renderer with bounded long titles in ${theme} at ${width}px`, async ({
        page,
      }) => {
        const { writes } = await fixtures(page);
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript((theme) => localStorage.setItem('notes-theme', theme), theme);
        await page.goto(paths[view]);
        const main = page
          .getByRole('main')
          .count()
          .then((count) => (count ? page.getByRole('main') : page.locator('body')));
        const scope = await main;
        const name = scope
          .getByRole(view === 'public' ? 'button' : 'link')
          .filter({ hasText: longTitle })
          .first();
        await expect(name).toBeVisible();
        await page.screenshot({ path: test.info().outputPath('resource-table.png') });
        expect(await page.locator('[data-resource-table]').count()).toBeGreaterThan(0);
        const tables = page.locator('[data-resource-table]:visible');
        if (width >= 768 || ['shared', 'owned', 'public'].includes(view)) {
          expect(await tables.count()).toBeGreaterThan(0);
          await expect(name.locator('span[title]').first()).toHaveAttribute('title', longTitle);
          await expect(name.locator('span[title]').first()).toHaveCSS('text-overflow', 'ellipsis');
          for (const table of await tables.all()) await assertTableBounds(table, width === 1280 || view === 'public');
        } else await expect(scope.getByRole('table')).toHaveCount(0);
        const overflow = await page.evaluate(() => ({
          width: document.documentElement.scrollWidth - innerWidth,
          offenders: [...document.querySelectorAll('body *')]
            .filter((el) => !el.closest('[data-resource-table]') && el.getBoundingClientRect().right > innerWidth + 1)
            .slice(0, 8)
            .map((el) => `${el.tagName}.${el.className}`),
        }));
        expect(overflow.width, JSON.stringify(overflow.offenders)).toBeLessThanOrEqual(1);
        if (view === 'folder' && width === 1280) {
          for (const name of ['Name', 'Type', 'Updated', 'Actions'])
            await expect(scope.getByRole('columnheader', { name, exact: true })).toBeInViewport();
          const checkbox = scope.getByRole('checkbox', { name: `Select ${longTitle}`, exact: true });
          await checkbox.focus();
          await page.keyboard.press('Space');
          await expect(checkbox).toBeChecked();
          await expect(checkbox).toBeFocused();
          await expect(page.getByText('1 note selected', { exact: true })).toBeVisible();
          await scope.getByRole('button', { name: 'Clear', exact: true }).click();
        }
        if (view === 'shared' || view === 'public') {
          await expect(scope.getByRole('checkbox')).toHaveCount(0);
          await expect(scope.getByRole('button', { name: /^Manage sharing/ })).toHaveCount(0);
        }
        await page.screenshot({ path: test.info().outputPath('resource-table.png') });
        expect(writes).toEqual([]);
      });

test('empty sharing tables retain their headings and empty-state cells', async ({ page }) => {
  await mockBrowserApi(page);
  await page.goto('/shared');
  await expect(page.getByText('No shared notes on this page.')).toBeVisible();
  await expect(page.getByText('No shared folders on this page.')).toBeVisible();
  await expect(page.locator('[data-resource-table]')).toHaveCount(2);
});
