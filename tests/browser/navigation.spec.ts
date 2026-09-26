import { expect, test } from '@playwright/test';
import { browserFixture, mockBrowserApi } from './fixtures';

test('preserves nested folder context while navigating between folders and notes', async ({ page }) => {
  await mockBrowserApi(page);
  await page.goto(`/notes/${browserFixture.child.id}`);

  const primary = page.getByRole('navigation', { name: 'Primary' });
  const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(primary.getByRole('link', { name: browserFixture.folder.title })).toBeVisible();
  await expect(primary.getByRole('link', { name: browserFixture.childFolder.title })).toHaveAttribute(
    'aria-current',
    'location'
  );
  await expect(breadcrumb.getByRole('link', { name: browserFixture.folder.title })).toBeVisible();
  await expect(breadcrumb.getByRole('link', { name: browserFixture.childFolder.title })).toBeVisible();
  await expect(breadcrumb.getByText(browserFixture.child.title, { exact: true })).toHaveAttribute(
    'aria-current',
    'page'
  );

  await breadcrumb.getByRole('link', { name: browserFixture.childFolder.title }).click();
  await expect(page).toHaveURL(`/folders/${browserFixture.childFolder.id}`);
  await primary.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page).toHaveURL('/');
});

test('uses a static brand and aligns sidebar controls with desktop breadcrumbs', async ({ page }) => {
  await mockBrowserApi(page);
  await page.goto('/');

  const brand = page.getByText('MinuNotes', { exact: true });
  const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
  const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(page.getByRole('link', { name: 'MinuNotes', exact: true })).toHaveCount(0);
  await expect
    .poll(() => page.locator('html').evaluate((element) => getComputedStyle(element).fontFamily))
    .toContain('system-ui');
  await expect.poll(() => brand.evaluate((element) => getComputedStyle(element).fontFamily)).toContain('ui-monospace');

  const [brandBox, collapseBox, breadcrumbBox] = await Promise.all([
    brand.boundingBox(),
    collapse.boundingBox(),
    breadcrumb.boundingBox(),
  ]);
  if (!brandBox || !collapseBox || !breadcrumbBox) throw new Error('Navigation header elements must be visible');
  const breadcrumbCenter = breadcrumbBox.y + breadcrumbBox.height / 2;
  expect(Math.abs(brandBox.y + brandBox.height / 2 - breadcrumbCenter)).toBeLessThanOrEqual(1);
  expect(Math.abs(collapseBox.y + collapseBox.height / 2 - breadcrumbCenter)).toBeLessThanOrEqual(1);
});

test('uses vertical primary navigation and groups secondary destinations under More', async ({ page }) => {
  await mockBrowserApi(page);
  await page.goto('/');

  const primary = page.getByRole('navigation', { name: 'Primary' });
  const home = primary.getByRole('link', { name: 'Home', exact: true });
  const shared = primary.getByRole('link', { name: 'Shared', exact: true });
  const templates = primary.getByRole('link', { name: 'Templates', exact: true });
  const more = primary.getByRole('button', { name: 'More navigation' });
  const boxes = await Promise.all([
    home.boundingBox(),
    shared.boundingBox(),
    templates.boundingBox(),
    more.boundingBox(),
  ]);
  if (boxes.some((box) => !box)) throw new Error('Primary navigation rows must be visible');
  expect(new Set(boxes.map((box) => Math.round(box?.x ?? 0))).size).toBe(1);
  expect(new Set(boxes.map((box) => Math.round(box?.width ?? 0))).size).toBe(1);
  expect(boxes.every((box) => (box?.height ?? 0) <= 40)).toBe(true);
  await expect
    .poll(() => home.evaluate((element) => Number(getComputedStyle(element).fontWeight)))
    .toBeLessThanOrEqual(500);

  await more.click();
  await page.getByRole('button', { name: 'Resources', exact: true }).click();
  await expect(page).toHaveURL('/resources');
  await expect(page.getByRole('heading', { name: 'Learn to build a calmer, connected workspace.' })).toBeVisible();

  await page.getByRole('link', { name: 'Open MinuNotes' }).click();
  await expect(page).toHaveURL('/');
  await more.click();
  await page.getByRole('button', { name: 'Integrations', exact: true }).click();
  await expect(page).toHaveURL('/integrations');
  await expect(page.getByRole('heading', { name: 'Integrations' })).toBeVisible();
  const createKeyBox = await page.getByRole('button', { name: 'Create key' }).boundingBox();
  const addAppBox = await page.getByRole('button', { name: 'Add App' }).boundingBox();
  expect(createKeyBox).not.toBeNull();
  expect(addAppBox).not.toBeNull();
  expect(
    Math.abs((createKeyBox?.x ?? 0) + (createKeyBox?.width ?? 0) - ((addAppBox?.x ?? 0) + (addAppBox?.width ?? 0)))
  ).toBeLessThanOrEqual(1);
  await expect(more).toHaveAttribute('aria-current', 'page');

  await page.getByRole('button', { name: 'Open account and settings menu' }).click();
  await expect(page.getByRole('button', { name: 'Profile', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Theme', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Logout', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resources', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Integrations', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Trash', exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Theme', exact: true }).click();
  const themeDialog = page.getByRole('dialog', { name: 'Theme' });
  await expect(themeDialog.getByLabel('Theme selection')).toBeVisible();
});

test('edits an optional collaboration display name from the sidebar profile', async ({ page }) => {
  await mockBrowserApi(page);
  await page.goto('/');

  await expect(page.locator('aside').locator('[data-avatar-palette]')).toBeVisible();
  await expect(page.getByText('browser@example.com', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open account and settings menu' }).click();
  await page.getByRole('button', { name: 'Profile', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Profile' });
  await expect(dialog.getByText('browser@example.com', { exact: true })).toBeVisible();
  await dialog.getByLabel('Display name').fill('  Updated   Person  ');
  await dialog.getByRole('button', { name: 'Save profile' }).click();

  await expect(dialog).toBeHidden();
  await expect(page.locator('aside')).toContainText('Updated Person');
});

test('uses nested folder lists with accessible expansion and quiet inactive actions', async ({ page }) => {
  await mockBrowserApi(page);
  await page.goto('/');

  const primary = page.getByRole('navigation', { name: 'Primary' });
  const rootLink = primary.getByRole('link', { name: browserFixture.folder.title, exact: true });
  const rootItem = rootLink.locator('xpath=../..');
  const expand = primary.getByRole('button', { name: `Expand ${browserFixture.folder.title}` });
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expect(rootItem.locator(':scope > ul')).toHaveCount(0);

  const inactiveActions = primary.getByRole('button', { name: `Actions for ${browserFixture.folder.title}` });
  await expect.poll(() => inactiveActions.evaluate((element) => getComputedStyle(element).opacity)).toBe('0');
  await inactiveActions.focus();
  await expect.poll(() => inactiveActions.evaluate((element) => getComputedStyle(element).opacity)).toBe('1');

  const childListId = await expand.getAttribute('aria-controls');
  if (!childListId) throw new Error('Folder expansion must reference its child list');
  await expand.click();
  await expect(primary.getByRole('button', { name: `Collapse ${browserFixture.folder.title}` })).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  const childList = rootItem.locator(':scope > ul');
  await expect(childList).toHaveAttribute('id', childListId);
  await expect(childList.getByRole('link', { name: browserFixture.childFolder.title, exact: true })).toBeVisible();

  await rootLink.click();
  await expect(page).toHaveURL(`/folders/${browserFixture.folder.id}`);
  await expect.poll(() => inactiveActions.evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
});

test('keeps the narrow sidebar scrollbar unobtrusive without disabling scroll', async ({ page }) => {
  const api = await mockBrowserApi(page);
  for (let index = 0; index < 20; index += 1) {
    api.folders.push({
      ...browserFixture.folder,
      id: `folder_scroll_${index}`,
      title: `Scrollable folder ${index + 1}`,
    });
  }
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.goto('/');

  const primary = page.getByRole('navigation', { name: 'Primary' });
  const scroller = primary.locator('.notes-sidebar-scroll');
  const [sidebarBox, scrollerBox] = await Promise.all([page.locator('aside').boundingBox(), scroller.boundingBox()]);
  if (!sidebarBox || !scrollerBox) throw new Error('Sidebar navigation must be visible');
  expect(Math.abs(scrollerBox.x + scrollerBox.width - (sidebarBox.x + sidebarBox.width))).toBeLessThanOrEqual(1);
  await expect.poll(() => scroller.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect.poll(() => scroller.evaluate((element) => getComputedStyle(element).scrollbarWidth)).toBe('thin');
  await scroller.hover();
  await page.mouse.wheel(0, 300);
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});

test('supports Home to folder to note navigation with browser history', async ({ page }) => {
  await mockBrowserApi(page);
  await page.goto('/');

  const primary = page.getByRole('navigation', { name: 'Primary' });
  await expect(primary.getByRole('link', { name: 'Home', exact: true })).toHaveAttribute('aria-current', 'page');
  await primary.getByRole('link', { name: browserFixture.folder.title }).click();
  await page.getByRole('link', { name: browserFixture.childFolder.title }).click();
  await page.getByRole('link', { name: browserFixture.child.title }).click();
  await expect(page).toHaveURL(`/notes/${browserFixture.child.id}`);

  await page.goBack();
  await expect(page).toHaveURL(`/folders/${browserFixture.childFolder.id}`);
  await page.goForward();
  await expect(page).toHaveURL(`/notes/${browserFixture.child.id}`);
});

test('moves a newly created untouched note to Trash when leaving it', async ({ page }) => {
  const api = await mockBrowserApi(page, { emptyTrash: true });
  await page.goto(`/folders/${browserFixture.folder.id}`);
  await page.getByRole('button', { name: 'New Note' }).click();
  await expect(page).toHaveURL('/notes/note_created_1');
  await page
    .getByRole('navigation', { name: 'Breadcrumb' })
    .getByRole('link', { name: browserFixture.folder.title })
    .click();
  await expect(page).toHaveURL(`/folders/${browserFixture.folder.id}`);
  await expect.poll(() => api.trashMutationRequests.length).toBe(1);
  expect(api.notes.has('note_created_1')).toBe(false);
  expect(api.trashNotes.some((note) => note.id === 'note_created_1')).toBe(true);
});

test('preserves a new note once its title is edited', async ({ page }) => {
  const api = await mockBrowserApi(page, { emptyTrash: true });
  await page.goto(`/folders/${browserFixture.folder.id}`);
  await page.getByRole('button', { name: 'New Note' }).click();
  await expect(page).toHaveURL('/notes/note_created_1');
  const title = page.getByRole('textbox', { name: 'Untitled note' });
  await title.fill('Keep me');
  await expect.poll(() => api.saveRequests.length).toBeGreaterThan(0);
  await page
    .getByRole('navigation', { name: 'Breadcrumb' })
    .getByRole('link', { name: browserFixture.folder.title })
    .click();
  await expect(page).toHaveURL(`/folders/${browserFixture.folder.id}`);
  expect(api.trashMutationRequests).toHaveLength(0);
  expect(api.notes.get('note_created_1')?.title).toBe('Keep me');
});

test('locks the editor while an empty-draft cleanup request is pending', async ({ page }) => {
  const api = await mockBrowserApi(page, { emptyTrash: true, emptyDraftTrashDelayMs: 750 });
  await page.goto(`/folders/${browserFixture.folder.id}`);
  await page.getByRole('button', { name: 'New Note' }).click();
  await expect(page).toHaveURL('/notes/note_created_1');
  await page
    .getByRole('navigation', { name: 'Breadcrumb' })
    .getByRole('link', { name: browserFixture.folder.title })
    .click();
  const title = page.getByRole('textbox', { name: 'Untitled note' });
  await expect(title).toHaveAttribute('readonly', '');
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
  await expect(page.getByText('Moving empty draft to Trash…')).toBeVisible();
  await expect(page).toHaveURL(`/folders/${browserFixture.folder.id}`);
  expect(api.notes.has('note_created_1')).toBe(false);
});

test('keeps an empty draft if another actor fills it before navigation', async ({ page }) => {
  const api = await mockBrowserApi(page, { emptyTrash: true });
  await page.goto(`/folders/${browserFixture.folder.id}`);
  await page.getByRole('button', { name: 'New Note' }).click();
  await expect(page).toHaveURL('/notes/note_created_1');
  api.externalUpdate('note_created_1', { content: 'Remote content' });
  await page
    .getByRole('navigation', { name: 'Breadcrumb' })
    .getByRole('link', { name: browserFixture.folder.title })
    .click();
  await expect(page).toHaveURL(`/folders/${browserFixture.folder.id}`);
  await expect.poll(() => api.trashMutationRequests.length).toBe(1);
  expect(api.notes.get('note_created_1')?.content).toBe('Remote content');
  expect(api.trashNotes).toHaveLength(0);
});

test('saves a markdown note before structural folder navigation proceeds', async ({ page }) => {
  const api = await mockBrowserApi(page);
  await page.goto(`/notes/${browserFixture.source.id}`);

  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Navigating.');
  await page
    .getByRole('navigation', { name: 'Breadcrumb' })
    .getByRole('link', { name: browserFixture.folder.title })
    .click();

  await expect(page).toHaveURL(`/folders/${browserFixture.folder.id}`);
  await api.expectSavedContent('Start here. Navigating.');
});

test('uses Templates as the parent while editing a template', async ({ page }) => {
  const api = await mockBrowserApi(page);
  const template = {
    ...browserFixture.source,
    id: 'note_template',
    title: 'Weekly template',
    type: 'template' as const,
  };
  api.notes.set(template.id, template);

  await page.goto(`/notes/${template.id}`);

  const primary = page.getByRole('navigation', { name: 'Primary' });
  const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(primary.getByRole('link', { name: 'Templates' })).toHaveAttribute('aria-current', 'page');
  await expect(breadcrumb.getByRole('link', { name: 'Templates' })).toBeVisible();
  await expect(breadcrumb.getByText(template.title, { exact: true })).toHaveAttribute('aria-current', 'page');

  await breadcrumb.getByRole('link', { name: 'Templates' }).click();
  await expect(page).toHaveURL('/templates');
});

test('renders existing templates without waiting for the shared folder list', async ({ page }) => {
  await mockBrowserApi(page);
  let releaseFolders = () => {};
  const foldersReleased = new Promise<void>((resolve) => {
    releaseFolders = resolve;
  });
  await page.route('**/internal/folders', async (route) => {
    await foldersReleased;
    await route.fallback();
  });

  try {
    await page.goto('/templates');
    await expect(page.getByRole('heading', { name: 'Templates', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: browserFixture.template.title, exact: true })).toBeVisible();
  } finally {
    releaseFolders();
  }
});

test('shows route-aware mobile navigation and active folder context', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockBrowserApi(page);
  await page.goto(`/notes/${browserFixture.child.id}`);

  await expect(page.getByRole('heading', { name: browserFixture.child.title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open menu' }).click();
  const primary = page.getByRole('navigation', { name: 'Primary' });
  await expect(primary.getByRole('link', { name: browserFixture.childFolder.title })).toHaveAttribute(
    'aria-current',
    'location'
  );
  await page.getByRole('button', { name: 'Close menu' }).click();

  await page.getByRole('link', { name: `Go to ${browserFixture.childFolder.title}` }).click();
  await expect(page).toHaveURL(`/folders/${browserFixture.childFolder.id}`);
  await expect(page.getByRole('heading', { name: browserFixture.childFolder.title, level: 1 })).toBeVisible();
});

test('opens search with recent notes and restores trigger focus on Escape', async ({ page }) => {
  await mockBrowserApi(page);
  await page.goto('/');

  const searchButton = page.getByRole('button', { name: 'Search', exact: true });
  await expect(searchButton).toHaveAttribute('title', `Search (${process.platform === 'darwin' ? '⌘K' : 'Ctrl+K'})`);
  await searchButton.click();
  const dialog = page.getByRole('dialog', { name: 'Search notes' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('option', { name: new RegExp(browserFixture.source.title) })).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Search notes or folders' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(searchButton).toBeFocused();
});

test('scopes unified search and labels shared notes and folders', async ({ page }) => {
  await mockBrowserApi(page, { includeSharedCollaborations: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Search', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'Search notes' });
  const scope = dialog.getByRole('group', { name: 'Search scope' });
  const all = scope.getByRole('button', { name: 'All', exact: true });
  const mine = scope.getByRole('button', { name: 'Owned by me', exact: true });
  const shared = scope.getByRole('button', { name: 'Shared with me', exact: true });
  await expect(all).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByRole('option', { name: /Source Note Shared by Shared Owner · Commenter/ })).toBeVisible();

  await mine.click();
  await expect(mine).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByRole('option', { name: /Source Note/ })).toHaveCount(0);
  await shared.click();
  await expect(dialog.getByRole('option', { name: /Source Note Shared by Shared Owner · Commenter/ })).toBeVisible();

  const input = dialog.getByRole('textbox', { name: 'Search notes or folders' });
  await input.fill('Browser tests');
  await expect(dialog.getByRole('option', { name: /Browser tests Shared by Shared Owner · Editor/ })).toBeVisible();
  await mine.click();
  await expect(dialog.getByRole('option', { name: /Browser tests Folder/ })).toBeVisible();

  await input.fill('Source');
  await expect(dialog.getByRole('option', { name: /Source Note/ })).toHaveCount(0);
  await all.click();
  await expect(dialog.getByRole('option', { name: /Source Note Shared by Shared Owner · Commenter/ })).toBeVisible();
});

test('debounces interactive note searches and requests a compact first page', async ({ page }) => {
  await mockBrowserApi(page);
  const searchRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/notes/search')) searchRequests.push(request.url());
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Search', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'Search notes' });
  const input = dialog.getByRole('textbox', { name: 'Search notes or folders' });
  await input.pressSequentially('Source', { delay: 20 });
  await expect(dialog.getByRole('option', { name: new RegExp(browserFixture.source.title) })).toBeVisible();

  expect(searchRequests).toHaveLength(1);
  expect(new URL(searchRequests[0]).searchParams.get('limit')).toBe('20');
});

test('navigates keyboard-only search while the desktop sidebar is collapsed', async ({ page }) => {
  await mockBrowserApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();

  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog', { name: 'Search notes' });
  const input = dialog.getByRole('textbox', { name: 'Search notes or folders' });
  await input.fill('Child');
  await expect(dialog.getByRole('option', { name: new RegExp(browserFixture.childFolder.title) })).toBeVisible();
  await expect(dialog.getByRole('option', { name: new RegExp(browserFixture.child.title) })).toBeVisible();
  await input.press('ArrowDown');
  await input.press('Enter');

  await expect(page).toHaveURL(`/notes/${browserFixture.child.id}`);
  await expect(dialog).toBeHidden();
});

test('navigates to a folder from search with normal history', async ({ page }) => {
  await mockBrowserApi(page);
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await page.keyboard.press('Control+k');

  const dialog = page.getByRole('dialog', { name: 'Search notes' });
  const input = dialog.getByRole('textbox', { name: 'Search notes or folders' });
  await input.fill('Browser tests');
  await input.press('Enter');
  await expect(page).toHaveURL(`/folders/${browserFixture.folder.id}`);
  await page.goBack();
  await expect(page).toHaveURL('/');
});

test('supports mobile search and backlink navigation with focus restoration', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockBrowserApi(page);
  await page.goto(`/notes/${browserFixture.target.id}`);

  const backlinksButton = page.getByRole('button', { name: /Open backlinks/ });
  await expect(backlinksButton).toBeVisible();
  await backlinksButton.click();
  const backlinksDialog = page.getByRole('dialog', { name: 'Backlinks' });
  await expect(backlinksDialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(backlinksDialog).toBeHidden();
  await expect(backlinksButton).toBeFocused();

  await page.getByRole('button', { name: 'Open menu' }).click();
  const searchButton = page.getByRole('button', { name: 'Search', exact: true });
  await searchButton.click();
  const searchDialog = page.getByRole('dialog', { name: 'Search notes' });
  await expect(searchDialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(searchButton).toBeFocused();

  await page.getByRole('button', { name: 'Close menu' }).click();
  await backlinksButton.click();
  await backlinksDialog.getByRole('link', { name: new RegExp(browserFixture.linked.title) }).click();
  await expect(page).toHaveURL(`/notes/${browserFixture.linked.id}`);
});

test('creates a top-level folder from the Folders section and opens it', async ({ page }) => {
  await mockBrowserApi(page);
  await page.goto('/');

  const primary = page.getByRole('navigation', { name: 'Primary' });
  const trigger = primary.getByRole('button', { name: 'Create top-level folder' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Create top-level folder' });
  const submit = dialog.getByRole('button', { name: 'Create folder' });
  await expect(submit).toBeDisabled();
  await dialog.getByRole('textbox', { name: 'Folder name' }).fill('New workspace');
  await submit.click();

  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL('/folders/folder_created_3');
  await expect(primary.getByRole('link', { name: 'New workspace' })).toHaveAttribute('aria-current', 'page');
});

test('creates subfolders from the parent action menu without leaving the folder', async ({ page }) => {
  const api = await mockBrowserApi(page);
  await page.goto(`/folders/${browserFixture.folder.id}`);
  await page
    .getByRole('main')
    .getByRole('button', { name: `Actions for ${browserFixture.folder.title}` })
    .click();
  await page.getByRole('button', { name: 'Add subfolder' }).click();

  const dialog = page.getByRole('dialog', { name: 'Create subfolder' });
  await expect(dialog.getByText(`Add a folder under ${browserFixture.folder.title}.`)).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Folder name' }).fill('Created child');
  await dialog.getByRole('button', { name: 'Create folder' }).click();

  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(`/folders/${browserFixture.folder.id}`);
  await expect
    .poll(() => api.folders.find((folder) => folder.title === 'Created child')?.parentFolderId)
    .toBe(browserFixture.folder.id);
});

test('keeps the folder dialog open and reports creation failures', async ({ page }) => {
  await mockBrowserApi(page, { folderCreateFails: true });
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('button', { name: 'Create top-level folder' })
    .click();

  const dialog = page.getByRole('dialog', { name: 'Create top-level folder' });
  await dialog.getByRole('textbox', { name: 'Folder name' }).fill('Unavailable folder');
  await dialog.getByRole('button', { name: 'Create folder' }).click();

  await expect(dialog.getByRole('alert')).toContainText('Folder creation unavailable');
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL('/');
});

test('closes the mobile drawer after creating a top-level folder', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockBrowserApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('button', { name: 'Create top-level folder' })
    .click();

  const dialog = page.getByRole('dialog', { name: 'Create top-level folder' });
  await dialog.getByRole('textbox', { name: 'Folder name' }).fill('Mobile workspace');
  await dialog.getByRole('button', { name: 'Create folder' }).click();

  await expect(page).toHaveURL('/folders/folder_created_3');
  await expect(page.getByRole('button', { name: 'Close menu' })).toBeHidden();
});

test('persists desktop sidebar and folder expansion preferences', async ({ page }) => {
  await mockBrowserApi(page);
  await page.goto(`/folders/${browserFixture.folder.id}`);

  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('button', { name: `Expand ${browserFixture.folder.title}` })
    .click();
  await expect(
    page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: browserFixture.childFolder.title })
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: browserFixture.childFolder.title })
  ).toBeVisible();

  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();
});

test('shows folder context on Recent Notes', async ({ page }) => {
  await mockBrowserApi(page);
  await page.goto('/');

  const main = page.getByRole('main');
  const sourceLink = main.getByRole('link', { name: browserFixture.source.title });
  await expect(sourceLink).toBeVisible();
  await expect(main.getByRole('link', { name: browserFixture.folder.title }).first()).toBeVisible();
});

test('keeps long breadcrumbs discoverable and horizontally scrollable', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 700 });
  const api = await mockBrowserApi(page);
  api.folders[0].title = `Projects ${'with a very long name '.repeat(8)}`;
  api.folders[1].title = `Research ${'with another long name '.repeat(8)}`;
  await page.goto(`/notes/${browserFixture.child.id}`);

  const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(breadcrumb).toBeVisible();
  await expect(breadcrumb.getByRole('link', { name: api.folders[0].title })).toHaveAttribute(
    'title',
    api.folders[0].title
  );
  expect(await breadcrumb.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
});

test('renders unknown routes with a useful Home escape', async ({ page }) => {
  await mockBrowserApi(page);
  await page.goto('/does-not-exist');

  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page).toHaveTitle('Page not found - MinuNotes');
  await page.getByRole('link', { name: 'Go to Home' }).click();
  await expect(page).toHaveURL('/');
});

test('redirects legacy folder template settings before rendering', async ({ page }) => {
  await mockBrowserApi(page);
  await page.goto(`/folders/${browserFixture.folder.id}/templates`);

  await expect(page).toHaveURL(`/folders/${browserFixture.folder.id}/settings`);
  await expect(page.getByText('Opening folder settings...')).toHaveCount(0);
  await expect(page).toHaveTitle(`${browserFixture.folder.title} settings - MinuNotes`);
});

test('redirects legacy API Access links to Integrations', async ({ page }) => {
  await mockBrowserApi(page);
  await page.goto('/settings/api-access');

  await expect(page).toHaveURL('/integrations');
  await expect(page.getByRole('heading', { name: 'Integrations' })).toBeVisible();
  await expect(page).toHaveTitle('Integrations - MinuNotes');
});

test('sets descriptive titles for authenticated and shared routes', async ({ page }) => {
  await mockBrowserApi(page);

  await page.goto('/');
  await expect(page).toHaveTitle('Recent notes - MinuNotes');
  await page.goto(`/folders/${browserFixture.folder.id}`);
  await expect(page).toHaveTitle(`${browserFixture.folder.title} - MinuNotes`);
  await page.goto(`/notes/${browserFixture.source.id}/activity`);
  await expect(page).toHaveTitle(`${browserFixture.source.title} activity - MinuNotes`);
  await page.goto('/templates');
  await expect(page).toHaveTitle('Templates - MinuNotes');
  await page.goto('/resources/markdown-editor');
  await expect(page).toHaveTitle('Markdown and editor - MinuNotes');
  await page.goto(`/share/note_share_${browserFixture.linked.id}`);
  await expect(page).toHaveTitle(`${browserFixture.linked.title} - MinuNotes`);
  await page.goto('/share/folders/folder_share_token');
  await expect(page).toHaveTitle(`${browserFixture.folder.title} - MinuNotes`);
  await page.goto(`/share/folders/folder_share_token?note=${browserFixture.target.id}`);
  await expect(page).toHaveTitle(`${browserFixture.target.title} - MinuNotes`);
});

test('shows one consolidated folder settings destination', async ({ page }) => {
  await mockBrowserApi(page);
  await page.goto(`/folders/${browserFixture.folder.id}`);

  await page
    .getByRole('main')
    .getByRole('button', { name: `Actions for ${browserFixture.folder.title}` })
    .click();
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Template settings' })).toHaveCount(0);
});

test('shows note context on the activity route', async ({ page }) => {
  await mockBrowserApi(page);
  await page.goto(`/notes/${browserFixture.source.id}/activity`);

  const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(breadcrumb.getByRole('link', { name: browserFixture.source.title })).toBeVisible();
  await expect(breadcrumb.getByText('Activity', { exact: true })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('link', { name: 'Back to note' }).click();
  await expect(page).toHaveURL(`/notes/${browserFixture.source.id}`);
});

test('searches before showing API key folders and scopes Comment globally or individually', async ({ page }) => {
  await mockBrowserApi(page);
  await page.goto('/integrations');
  await page.getByRole('button', { name: 'Create key' }).click();

  const dialog = page
    .getByRole('heading', { name: 'Create API key' })
    .locator('xpath=ancestor::div[contains(@class, "max-w-2xl")]');
  await expect(dialog.getByRole('button', { name: 'Close API key access' })).toBeVisible();
  await expect(dialog).toHaveClass(/notes-modal-scroll/);
  await expect.poll(() => dialog.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect.poll(() => dialog.evaluate((element) => getComputedStyle(element).scrollbarWidth)).toBe('thin');
  await dialog.getByText('Specific folders', { exact: true }).click();
  await expect(dialog.getByRole('button', { name: new RegExp(browserFixture.folder.title) })).toHaveCount(0);

  const search = dialog.getByPlaceholder('Search folders...');
  await search.fill(browserFixture.folder.title);
  await dialog
    .getByRole('button', { name: `${browserFixture.folder.title} ${browserFixture.folder.title}`, exact: true })
    .click();
  await search.fill(browserFixture.childFolder.title);
  await dialog
    .getByRole('button', {
      name: `${browserFixture.childFolder.title} ${browserFixture.folder.title} / ${browserFixture.childFolder.title}`,
      exact: true,
    })
    .click();

  const commentPermissions = dialog.getByLabel('Comment', { exact: true });
  await expect(commentPermissions).toHaveCount(3);

  await commentPermissions.nth(1).check();
  await expect(commentPermissions.nth(1)).toBeChecked();
  await expect(commentPermissions.nth(2)).not.toBeChecked();
  await expect
    .poll(() => commentPermissions.first().evaluate((input: HTMLInputElement) => input.indeterminate))
    .toBe(true);

  await commentPermissions.nth(1).uncheck();
  await commentPermissions.first().check();
  for (const checkbox of await commentPermissions.all()) await expect(checkbox).toBeChecked();

  await commentPermissions.nth(1).uncheck();
  await expect(commentPermissions.first()).not.toBeChecked();
  await expect
    .poll(() => commentPermissions.first().evaluate((input: HTMLInputElement) => input.indeterminate))
    .toBe(true);
  await expect(commentPermissions.nth(1)).not.toBeChecked();
  await expect(commentPermissions.nth(2)).toBeChecked();

  await dialog.getByRole('button', { name: 'Close API key access' }).click();
  await expect(dialog).toBeHidden();
});
