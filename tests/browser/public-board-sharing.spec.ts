import { expect, test } from '@playwright/test';
import { browserFixture } from './fixtures';
import { mockPropertyBoard } from './property-board-fixtures';

const publicUrl = '/share/folders/folder_share_token?view=board';
const prefix = '/internal/share/folders/folder_share_token';
let unexpectedReads: string[];
test.beforeEach(({ page }) => {
  unexpectedReads = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === prefix || (path.startsWith(`${prefix}/notes/`) && path.endsWith('/wikilinks')))
      unexpectedReads.push(path);
  });
});
test.afterEach(() => expect(unexpectedReads).toEqual([]));

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

test('renders the shared board anonymously, paginates, and reads only an opened card body', async ({ page }) => {
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
  expect(api.requests.filter((request) => request.path.startsWith(`${prefix}/notes/`))).toHaveLength(0);
  const card = board.getByRole('link', { name: browserFixture.source.title, exact: true });
  await expect(card).toHaveAttribute('href', /\/share\/folders\/folder_share_token\?/);
  await card.click();
  await expect(page.getByRole('heading', { name: browserFixture.source.title, exact: true })).toBeVisible();
  await expect(page.locator('.notes-minu-renderer')).toContainText(browserFixture.source.content);
  await expect(page).toHaveURL(/view=board/);
  await page.getByRole('button', { name: 'Back to folder' }).click();
  await expect(board).toBeVisible();
  expect(api.requests.filter((request) => request.path === `${prefix}/notes/${browserFixture.source.id}`)).toHaveLength(
    1
  );
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

test('refreshes only metadata and opens fresh individual bodies for new and updated cards', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  await page.goto(publicUrl);
  const board = page.getByRole('region', { name: 'Folder board', exact: true });
  await expect(board.getByRole('link', { name: browserFixture.source.title, exact: true })).toBeVisible();
  const freshNote = { ...browserFixture.source, id: 'note_fresh', title: 'Fresh note', content: 'Fresh content.' };
  api.notes.set(freshNote.id, freshNote);
  api.cards.push({ ...api.cards[0], id: freshNote.id, title: freshNote.title });
  api.notes.set(browserFixture.source.id, { ...browserFixture.source, content: 'Updated source content.' });
  await page.getByRole('button', { name: 'Refresh board', exact: true }).click();
  await expect(board.getByRole('link', { name: freshNote.title, exact: true })).toBeVisible();
  expect(api.requests.filter((request) => request.path.startsWith(`${prefix}/notes/`))).toHaveLength(0);
  expect(api.requests.filter((request) => request.path === `${prefix}/navigation`)).toHaveLength(2);
  await board.getByRole('link', { name: freshNote.title, exact: true }).click();
  await expect(page.locator('.notes-minu-renderer')).toContainText(freshNote.content);
  await page.getByRole('button', { name: 'Back to folder' }).click();
  await board.getByRole('link', { name: browserFixture.source.title, exact: true }).click();
  await expect(page.locator('.notes-minu-renderer')).toContainText('Updated source content.');
  expect(api.requests.filter((request) => request.path.startsWith(`${prefix}/notes/`))).toHaveLength(2);
});

test('reads an uncached card on demand and revalidates when reopened', async ({ page }) => {
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
  let releaseRead!: () => void;
  const pendingRead = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  await page.route(`**${prefix}/notes/${freshNote.id}`, async (route) => {
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
  await expect(page.locator('.notes-minu-renderer')).toContainText(freshNote.content);
  await expect(page).toHaveURL(/view=board/);
  await page.getByRole('button', { name: 'Back to folder' }).click();
  await board.getByRole('link', { name: freshNote.title, exact: true }).click();
  await expect(page.getByRole('heading', { name: freshNote.title, exact: true })).toBeVisible();
  expect(api.requests.filter((request) => request.path === `${prefix}/notes/${freshNote.id}`)).toHaveLength(2);
});

for (const view of ['list', 'board']) {
  test(`shows unavailable after one detail read when a ${view} note is missing`, async ({ page }) => {
    const api = await mockPropertyBoard(page);
    await page.goto(`/share/folders/folder_share_token?view=${view}&note=note_missing`);
    await expect(page.getByRole('heading', { name: 'Shared note unavailable', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Folder board', exact: true })).toHaveCount(0);
    expect(api.requests.filter((request) => request.path === `${prefix}/notes/note_missing`)).toHaveLength(1);
    await expect.poll(() => api.requests.filter((request) => request.path === `${prefix}/navigation`).length).toBe(2);
    await page.getByRole('button', { name: 'Back to folder' }).click();
    if (view === 'board') await expect(page.getByRole('region', { name: 'Folder board', exact: true })).toBeVisible();
    else await expect(page.getByRole('button', { name: browserFixture.source.title, exact: true })).toBeVisible();
  });
}

test('allows explicit retry after a failed individual read without opening a stale body', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  await page.goto(publicUrl);
  const board = page.getByRole('region', { name: 'Folder board', exact: true });
  await expect(board).toBeVisible();
  let failed = true;
  await page.route(`**${prefix}/notes/${browserFixture.source.id}`, (route) =>
    failed ? route.fulfill({ status: 503, json: { error: 'Temporary failure' } }) : route.fallback()
  );
  await board.getByRole('link', { name: browserFixture.source.title, exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Unable to load shared note.');
  await expect(page.locator('.notes-minu-renderer')).toHaveCount(0);
  expect(api.requests.filter((request) => request.path === `${prefix}/notes/${browserFixture.source.id}`)).toHaveLength(
    1
  );
  failed = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.notes-minu-renderer')).toContainText(browserFixture.source.content);
});

test('rejects a revoked share during an individual read', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  await page.goto(publicUrl);
  const board = page.getByRole('region', { name: 'Folder board', exact: true });
  await expect(board).toBeVisible();
  api.controls.shareRevoked = true;
  await board.getByRole('link', { name: browserFixture.source.title, exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Shared folder unavailable', exact: true })).toBeVisible();
  await expect(board).toHaveCount(0);
  await expect(page.locator('.notes-minu-renderer')).toHaveCount(0);
});

test('preserves board presentation only on wikilinks within the same folder share', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  const note = {
    ...browserFixture.linked,
    content: '[[Target Note]] [[Child Note]] [[Outside note]] [[Other folder]] [[Missing Note]]',
  };
  api.notes.set(note.id, note);
  api.cards.push({ ...api.cards[0], id: note.id, title: note.title });
  const sameShare = '/share/folders/folder_share_token';
  await page.route(`**${prefix}/notes/${note.id}`, (route) =>
    route.fulfill({
      json: {
        note,
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
    await board.getByRole('link', { name: note.title, exact: true }).click();
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
  api.controls.shareRevoked = true;
  await page.getByRole('button', { name: 'Refresh board', exact: true }).click();
  await expect(board).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Shared folder unavailable', exact: true })).toBeVisible();
});

test('a Board config denial does not revoke the valid root share', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  await page.goto(publicUrl);
  await expect(page.getByRole('region', { name: 'Folder board', exact: true })).toBeVisible();
  api.controls.readFailure = 404;
  await page.getByRole('button', { name: 'Refresh board', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Board unavailable');
  await expect(page.getByRole('heading', { name: 'Shared folder unavailable', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Switch to list' }).click();
  await page.getByRole('button', { name: browserFixture.source.title, exact: true }).click();
  await expect(page.locator('.notes-minu-renderer')).toContainText(browserFixture.source.content);
});
