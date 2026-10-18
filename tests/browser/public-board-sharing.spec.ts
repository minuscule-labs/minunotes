import { expect, test } from '@playwright/test';
import { browserFixture } from './fixtures';
import { mockPropertyBoard } from './property-board-fixtures';

const publicUrl = '/share/folders/folder_share_token?view=board';

test('copies the existing folder public link with board presentation', async ({ context, page }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const api = await mockPropertyBoard(page);
  await page.goto(`/folders/${browserFixture.folder.id}?view=board`);
  await expect(page.getByRole('region', { name: 'Folder board', exact: true })).toBeVisible();
  await page.getByRole('main').getByLabel(`Actions for ${browserFixture.folder.title}`).click();
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const dialog = page.getByRole('heading', { name: 'Share folder' }).locator('..').locator('..');
  await dialog.getByRole('heading', { name: 'Public link' }).locator('..').getByRole('combobox').selectOption('read');
  await dialog.getByRole('button', { name: 'Copy public link' }).click();
  await expect(dialog.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`http://localhost:5173${publicUrl}`);
  expect(
    api.requests.filter((request) => request.path.endsWith('/share-link') && request.method === 'POST')
  ).toHaveLength(1);
  expect(api.writes).toHaveLength(0);
});

test('renders the shared board anonymously, paginates, and keeps cards in the public viewer', async ({ page }) => {
  const api = await mockPropertyBoard(page, { extraCards: 26 });
  await page.route('**/internal/auth/get-session', (route) => route.fulfill({ json: null }));
  await page.goto(publicUrl);
  const board = page.getByRole('region', { name: 'Folder board', exact: true });
  await expect(board).toBeVisible();
  await expect(board.getByRole('heading', { name: 'Ready', exact: true })).toBeVisible();
  await expect(board.getByText('Bug', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Board settings', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New Note', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toHaveCount(0);
  await board.getByRole('button', { name: 'Load more Ready', exact: true }).click();
  await expect(board.getByRole('link', { name: 'Extra 025', exact: true })).toBeVisible();
  const card = board.getByRole('link', { name: browserFixture.source.title, exact: true });
  await expect(card).toHaveAttribute('href', /\/share\/folders\/folder_share_token\?/);
  await card.click();
  await expect(page.getByRole('heading', { name: browserFixture.source.title, exact: true })).toBeVisible();
  await expect(page.locator('.notes-minu-renderer')).toContainText(browserFixture.source.content);
  await expect(page).toHaveURL(/view=board/);
  await page.getByRole('button', { name: 'Back to folder' }).click();
  await expect(board).toBeVisible();
  expect(
    api.requests.filter((request) => request.path === `/internal/folders/${browserFixture.folder.id}/board/config`)
  ).toHaveLength(0);
  expect(api.requests.filter((request) => request.path.includes('/share/') && request.method !== 'GET')).toHaveLength(
    0
  );
});

test('switches list and board on the same share and preserves descendant navigation', async ({ page }) => {
  await mockPropertyBoard(page);
  await page.goto(publicUrl);
  await page.getByRole('button', { name: browserFixture.childFolder.title }).first().click();
  await expect(page).toHaveURL(new RegExp(`folder=${browserFixture.childFolder.id}`));
  await expect(page.getByRole('region', { name: 'Folder board', exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('main').getByRole('heading', { name: browserFixture.childFolder.title, exact: true })
  ).toBeVisible();
  await page.getByRole('button', { name: 'Switch to list' }).click();
  await expect(page.getByRole('region', { name: 'Folder board', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: browserFixture.child.title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Switch to board' }).click();
  await expect(page.getByRole('region', { name: 'Folder board', exact: true })).toBeVisible();
});

test('refreshes the public viewer data along with new and updated board cards', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  await page.goto(publicUrl);
  const board = page.getByRole('region', { name: 'Folder board', exact: true });
  await expect(board.getByRole('link', { name: browserFixture.source.title, exact: true })).toBeVisible();

  const freshNote = { ...browserFixture.source, id: 'note_fresh', title: 'Fresh note', content: 'Fresh content.' };
  api.notes.set(freshNote.id, freshNote);
  api.cards.push({ ...api.cards[0], id: freshNote.id, title: freshNote.title });
  api.notes.set(browserFixture.source.id, { ...browserFixture.source, content: 'Updated source content.' });

  await page.getByRole('button', { name: 'Refresh board', exact: true }).click();
  await board.getByRole('link', { name: freshNote.title, exact: true }).click();
  await expect(page.getByRole('heading', { name: freshNote.title, exact: true })).toBeVisible();
  await expect(page.locator('.notes-minu-renderer')).toContainText(freshNote.content);
  await page.getByRole('button', { name: 'Back to folder' }).click();
  await board.getByRole('link', { name: browserFixture.source.title, exact: true }).click();
  await expect(page.locator('.notes-minu-renderer')).toContainText('Updated source content.');
  expect(api.requests.filter((request) => request.path === '/internal/share/folders/folder_share_token')).toHaveLength(
    2
  );
});

test('loads an uncached card on demand after returning from the public viewer', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  await page.goto(publicUrl);
  const board = page.getByRole('region', { name: 'Folder board', exact: true });
  await board.getByRole('link', { name: browserFixture.source.title, exact: true }).click();
  await expect(page.getByRole('heading', { name: browserFixture.source.title, exact: true })).toBeVisible();
  const freshNote = { ...browserFixture.source, id: 'note_fresh', title: 'Fresh note', content: 'Fresh content.' };
  api.notes.set(freshNote.id, freshNote);
  api.cards.push({ ...api.cards[0], id: freshNote.id, title: freshNote.title });
  await page.getByRole('button', { name: 'Back to folder' }).click();
  const freshCard = board.getByRole('link', { name: freshNote.title, exact: true });
  await expect(freshCard).toBeVisible();
  expect(api.requests.filter((request) => request.path === '/internal/share/folders/folder_share_token')).toHaveLength(
    1
  );

  let releaseRead!: () => void;
  const pendingRead = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  await page.route('**/internal/share/folders/folder_share_token', async (route) => {
    await pendingRead;
    await route.fallback();
  });
  await freshCard.click();
  try {
    await expect(page.getByRole('status')).toHaveText('Loading shared note...');
    await expect(board).toHaveCount(0);
  } finally {
    releaseRead();
  }
  await expect(page.getByRole('heading', { name: freshNote.title, exact: true })).toBeVisible();
  await expect(page.locator('.notes-minu-renderer')).toContainText(freshNote.content);
  await expect(page).toHaveURL(/view=board/);
  await page.getByRole('button', { name: 'Back to folder' }).click();
  await board.getByRole('link', { name: freshNote.title, exact: true }).click();
  await expect(page.getByRole('heading', { name: freshNote.title, exact: true })).toBeVisible();
  expect(api.requests.filter((request) => request.path === '/internal/share/folders/folder_share_token')).toHaveLength(
    2
  );
});

for (const view of ['list', 'board']) {
  test(`shows unavailable after one on-demand read when a ${view} note remains missing`, async ({ page }) => {
    const api = await mockPropertyBoard(page);
    await page.goto(`/share/folders/folder_share_token?view=${view}&note=note_missing`);
    await expect(page.getByRole('heading', { name: 'Shared note unavailable', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Folder board', exact: true })).toHaveCount(0);
    expect(
      api.requests.filter((request) => request.path === '/internal/share/folders/folder_share_token')
    ).toHaveLength(2);
    await page.getByRole('button', { name: 'Back to folder' }).click();
    if (view === 'board') await expect(page.getByRole('region', { name: 'Folder board', exact: true })).toBeVisible();
    else await expect(page.getByRole('button', { name: browserFixture.source.title, exact: true })).toBeVisible();
  });
}

test('allows retry after a failed on-demand read without opening an unavailable note', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  await page.goto(publicUrl);
  const board = page.getByRole('region', { name: 'Folder board', exact: true });
  await board.getByRole('link', { name: browserFixture.source.title, exact: true }).click();
  const freshNote = { ...browserFixture.source, id: 'note_fresh', title: 'Fresh note', content: 'Fresh content.' };
  api.cards.push({ ...api.cards[0], id: freshNote.id, title: freshNote.title });
  await page.getByRole('button', { name: 'Back to folder' }).click();
  let failed = true;
  await page.route('**/internal/share/folders/folder_share_token', (route) =>
    failed ? route.fulfill({ status: 503, json: { error: 'Temporary failure' } }) : route.fallback()
  );
  await board.getByRole('link', { name: freshNote.title, exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Unable to load shared note.', { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: freshNote.title, exact: true })).toHaveCount(0);
  await expect(board).toHaveCount(0);
  failed = false;
  api.notes.set(freshNote.id, freshNote);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('heading', { name: freshNote.title, exact: true })).toBeVisible();
  await expect(page.locator('.notes-minu-renderer')).toContainText(freshNote.content);
});

test('rejects a revoked share during an on-demand read', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  await page.goto(publicUrl);
  const board = page.getByRole('region', { name: 'Folder board', exact: true });
  await board.getByRole('link', { name: browserFixture.source.title, exact: true }).click();
  api.cards.push({ ...api.cards[0], id: 'note_fresh', title: 'Fresh note' });
  await page.getByRole('button', { name: 'Back to folder' }).click();
  await page.route('**/internal/share/folders/folder_share_token', (route) =>
    route.fulfill({
      status: 404,
      json: { error: 'Shared folder not found' },
    })
  );
  await board.getByRole('link', { name: 'Fresh note', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Shared folder unavailable', exact: true })).toBeVisible();
  await expect(board).toHaveCount(0);
  await expect(page.locator('.notes-minu-renderer')).toHaveCount(0);
  expect(api.requests.filter((request) => request.path === '/internal/share/folders/folder_share_token')).toHaveLength(
    2
  );
});

test('preserves board presentation only on wikilinks within the same folder share', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  api.notes.set(browserFixture.linked.id, {
    ...browserFixture.linked,
    content: '[[Target Note]] [[Child Note]] [[Outside note]] [[Other folder]] [[Missing Note]]',
  });
  api.cards.push({ ...api.cards[0], id: browserFixture.linked.id, title: browserFixture.linked.title });
  const sameShare = '/share/folders/folder_share_token';
  await page.route(`**/internal${sameShare}/notes/${browserFixture.linked.id}/wikilinks`, (route) =>
    route.fulfill({
      json: {
        resolutions: [
          { target: 'Target Note', href: `${sameShare}?note=${browserFixture.target.id}` },
          { target: 'Child Note', href: `${sameShare}?note=${browserFixture.child.id}` },
          { target: 'Outside note', href: '/share/another_note_token' },
          { target: 'Other folder', href: `/share/folders/another_folder_token?note=${browserFixture.target.id}` },
          { target: 'Missing Note', href: null },
        ],
      },
    })
  );
  await page.goto(publicUrl);
  const board = page.getByRole('region', { name: 'Folder board', exact: true });

  for (const target of [browserFixture.target, browserFixture.child]) {
    await board.getByRole('link', { name: browserFixture.linked.title, exact: true }).click();
    await expect(page.getByRole('link', { name: 'Outside note', exact: true })).toHaveAttribute(
      'href',
      '/share/another_note_token'
    );
    await expect(page.getByRole('link', { name: 'Other folder', exact: true })).toHaveAttribute(
      'href',
      `/share/folders/another_folder_token?note=${browserFixture.target.id}`
    );
    await expect(page.locator('a.me-wikilink[data-wikilink-target="Missing Note"]')).not.toHaveAttribute('href');
    const link = page.getByRole('link', { name: target.title, exact: true });
    await expect(link).toHaveAttribute('href', `${sameShare}?note=${target.id}&view=board`);
    await link.click();
    await expect(page.getByRole('heading', { name: target.title, exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Back to folder' }).click();
    await expect(board).toBeVisible();
    await expect(page).toHaveURL(/view=board/);
  }
  await expect(page.getByRole('heading', { name: browserFixture.childFolder.title, exact: true })).toBeVisible();
});

test('hides retained cards after public link revocation', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  await page.goto(publicUrl);
  const board = page.getByRole('region', { name: 'Folder board', exact: true });
  await expect(board.getByRole('link', { name: browserFixture.source.title, exact: true })).toBeVisible();
  api.controls.readFailure = 404;
  await page.getByRole('button', { name: 'Refresh board', exact: true }).click();
  await expect(board).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('Board unavailable');
});
