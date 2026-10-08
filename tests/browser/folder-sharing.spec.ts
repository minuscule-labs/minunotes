import { expect, test } from '@playwright/test';
import { browserFixture, mockBrowserApi } from './fixtures';

test('enables and copies a read-only folder share link', async ({ context, page }) => {
  await context.grantPermissions(['clipboard-write']);
  await mockBrowserApi(page);
  await page.goto(`/folders/${browserFixture.folder.id}`);

  await page.getByRole('main').getByLabel(`Actions for ${browserFixture.folder.title}`).click();
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const shareDialog = page.getByRole('heading', { name: 'Share folder' }).locator('..').locator('..');
  await expect(shareDialog).toBeVisible();
  await expect(shareDialog.getByRole('button', { name: 'Invite', exact: true })).toBeVisible();
  await expect(shareDialog).toHaveClass(/max-w-2xl/);
  await expect(shareDialog.getByText('browser@example.com')).toHaveCount(0);
  await expect(shareDialog.getByRole('heading', { level: 3 })).toHaveText(['Public link', 'People with access']);
  await expect(shareDialog.getByText('Active', { exact: true })).toBeVisible();
  await expect(shareDialog.locator('[data-avatar-palette]').first()).toBeVisible();
  await expect(shareDialog.getByText('a•••@e•••.com')).toBeVisible();
  await expect(shareDialog.getByText('Pending', { exact: true })).toBeVisible();
  await expect(shareDialog.getByText('Expired', { exact: true })).toBeVisible();
  const statusPositions = await Promise.all(
    ['Active', 'Pending', 'Expired'].map(async (status) => {
      const box = await shareDialog.getByText(status, { exact: true }).boundingBox();
      expect(box).not.toBeNull();
      return box?.x ?? 0;
    })
  );
  expect(Math.max(...statusPositions) - Math.min(...statusPositions)).toBeLessThan(2);
  await expect(shareDialog.getByRole('button', { name: 'Resend invitation for e•••@e•••.com' })).toBeVisible();

  const publicLinkSection = shareDialog.getByRole('heading', { name: 'Public link' }).locator('..');
  await expect(publicLinkSection.getByRole('button', { name: 'Copy public link' })).toHaveCount(0);
  await publicLinkSection.getByRole('combobox').selectOption('read');
  await expect(
    page.getByText('This folder is publicly viewable by anyone with the link. Editing is disabled.')
  ).toBeVisible();

  await publicLinkSection.getByRole('button', { name: 'Copy public link' }).click();
  await expect(publicLinkSection.getByRole('button', { name: 'Copied' })).toBeVisible();
});

test('refreshes shared navigation after folder access changes', async ({ page }) => {
  const api = await mockBrowserApi(page, { includeSharedFolderNavigation: true });
  await page.goto(`/folders/${browserFixture.folder.id}`);

  await expect.poll(() => api.sharedFolderNavigationRequests.length).toBe(1);
  await page.getByRole('main').getByLabel(`Actions for ${browserFixture.folder.title}`).click();
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const dialog = page.getByRole('heading', { name: 'Share folder' }).locator('..').locator('..');
  await dialog.getByLabel('Collaborator email').fill('new-person@example.com');
  await dialog.getByRole('button', { name: 'Invite', exact: true }).click();
  await expect(dialog.getByText('Access was granted. Email delivery is unavailable.')).toBeVisible();
  await expect.poll(() => api.sharedFolderNavigationRequests.length).toBe(2);
});

test('refreshes expanded shared navigation after a collaborator creates a subfolder', async ({ page }) => {
  const api = await mockBrowserApi(page, { includeSharedFolderNavigation: true, folderAccessRole: 'editor' });
  await page.goto('/folders/folder_shared_nav_child');

  await expect(page.getByText('Shared by Shared Owner', { exact: true })).toBeVisible();
  const primary = page.getByRole('navigation', { name: 'Primary' });
  await expect(primary.getByRole('link', { name: 'Shared subfolder', exact: true })).toBeVisible();
  await primary.getByRole('button', { name: 'Expand Shared subfolder' }).click();
  await expect(primary.getByRole('link', { name: 'Shared nested folder', exact: true })).toBeVisible();
  await expect.poll(() => api.sharedFolderNavigationRequests.length).toBe(3);

  await page.getByRole('main').getByRole('button', { name: 'Actions for Shared subfolder' }).click();
  await page.getByRole('button', { name: 'Add subfolder' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create subfolder' });
  await dialog.getByLabel('Folder name').fill('Created in shared folder');
  await dialog.getByRole('button', { name: 'Create folder' }).click();

  await expect(dialog).toBeHidden();
  await expect(
    primary
      .getByLabel('Subfolders of Shared subfolder')
      .getByRole('link', { name: 'Created in shared folder', exact: true })
  ).toBeVisible();
  await expect.poll(() => api.sharedFolderNavigationRequests.length).toBe(6);
  expect(
    api.sharedFolderNavigationRequests.filter((path) => path === '/collaborations/shared-folder-roots')
  ).toHaveLength(2);
  expect(
    api.sharedFolderNavigationRequests.filter((path) => path === '/folders/folder_shared_nav/children')
  ).toHaveLength(2);
  expect(
    api.sharedFolderNavigationRequests.filter((path) => path === '/folders/folder_shared_nav_child/children')
  ).toHaveLength(2);
});

test('moves selected notes from a folder list', async ({ page }) => {
  await mockBrowserApi(page);
  await page.goto(`/folders/${browserFixture.folder.id}`);

  const table = page.locator('table');
  await table.getByLabel(`Select ${browserFixture.source.title}`).check();
  await table.getByLabel(`Select ${browserFixture.target.title}`).check();
  await expect(page.getByText('2 notes selected')).toBeVisible();

  await page.getByRole('button', { name: 'Move' }).click();
  const dialog = page.getByRole('dialog', { name: 'Move 2 notes' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: browserFixture.childFolder.title, exact: true }).click();
  await dialog.getByRole('button', { name: 'Move here' }).click();

  await expect(page.getByText('2 notes selected')).toHaveCount(0);
  await expect(page.getByRole('link', { name: browserFixture.source.title })).toHaveCount(0);
  await expect(page.getByRole('link', { name: browserFixture.target.title })).toHaveCount(0);
});

test('moves selected notes to Trash from a folder list', async ({ page }) => {
  await mockBrowserApi(page);
  await page.goto(`/folders/${browserFixture.folder.id}`);

  const table = page.locator('table');
  await table.getByLabel(`Select ${browserFixture.source.title}`).check();
  await table.getByLabel(`Select ${browserFixture.target.title}`).check();
  await expect(page.getByText('2 notes selected')).toBeVisible();

  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByRole('heading', { name: 'Move 2 items to Trash?' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Move to Trash' }).click();

  await expect(page.getByText('2 notes selected')).toHaveCount(0);
  await expect(page.getByRole('link', { name: browserFixture.source.title })).toHaveCount(0);
  await expect(page.getByRole('link', { name: browserFixture.target.title })).toHaveCount(0);
});

test('keeps rendered table backgrounds constrained to the table width', async ({ page }) => {
  const api = await mockBrowserApi(page);
  api.notes.set(browserFixture.source.id, {
    ...browserFixture.source,
    content: '| name | id |\n| --- | --- |\n| Venue | 123 |',
  });
  await page.goto('/share/folders/folder_share_token');
  await page.getByRole('button', { name: browserFixture.source.title }).click();

  const scroller = page.locator('.notes-minu-renderer .me-renderer-table-scroller');
  const table = scroller.locator('table');
  await expect(table).toBeVisible();

  const [scrollerBox, tableBox] = await Promise.all([scroller.boundingBox(), table.boundingBox()]);
  if (!scrollerBox || !tableBox) throw new Error('Expected rendered table bounds');
  expect(tableBox.width).toBeLessThan(scrollerBox.width);
});

test('renders a public shared folder read-only view', async ({ page }) => {
  await mockBrowserApi(page);
  await page.goto('/share/folders/folder_share_token');

  await expect(page.getByRole('heading', { name: browserFixture.folder.title, level: 2 })).toBeVisible();
  await expect(page.getByRole('button', { name: browserFixture.childFolder.title }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: browserFixture.source.title })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Folder' }).first()).toBeVisible();

  await page.getByRole('button', { name: browserFixture.source.title }).click();
  await expect(page.getByRole('heading', { name: browserFixture.source.title })).toBeVisible();
  await expect(page.locator('.notes-minu-renderer')).toContainText(browserFixture.source.content);

  await page.getByRole('button', { name: 'Back to folder' }).click();
  await page.getByRole('button', { name: browserFixture.childFolder.title }).first().click();
  await expect(page.getByRole('heading', { name: browserFixture.childFolder.title })).toBeVisible();
  await page.getByRole('button', { name: browserFixture.child.title }).click();
  await expect(page.getByRole('heading', { name: browserFixture.child.title })).toBeVisible();
  await expect(page.locator('.notes-minu-renderer')).toContainText(browserFixture.child.content);
  await expect(page.getByLabel(`Actions for ${browserFixture.folder.title}`)).toHaveCount(0);
});
