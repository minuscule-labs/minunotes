import { expect, test } from '@playwright/test';
import { browserFixture } from './fixtures';
import { mockPropertyBoard } from './property-board-fixtures';

const url = '/share/folders/folder_share_token';
const prefix = `/internal${url}`;
let broadReads: string[];
test.beforeEach(({ page }) => {
  broadReads = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (/^\/internal\/share\/folders\/[^/]+$/.test(path) || path.endsWith('/wikilinks')) broadReads.push(path);
  });
});
test.afterEach(() => expect(broadReads).toEqual([]));

test('List browsing reads metadata only and opening/reopening reads one fresh body', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  const metadataResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === `${prefix}/navigation`
  );
  await page.goto(url);
  await expect(page.getByRole('button', { name: browserFixture.source.title, exact: true })).toBeVisible();
  expect(api.requests.filter((request) => request.path.startsWith(`${prefix}/notes/`))).toHaveLength(0);
  const metadata = await (await metadataResponse).json();
  expect(metadata.notes.every((note: object) => !('content' in note))).toBe(true);
  await page.getByRole('button', { name: browserFixture.source.title, exact: true }).click();
  await expect(page.locator('.notes-minu-renderer')).toContainText(browserFixture.source.content);
  await page.getByRole('button', { name: 'Back to folder' }).click();
  api.notes.set(browserFixture.source.id, { ...browserFixture.source, content: 'Updated on reopening.' });
  await page.getByRole('button', { name: browserFixture.source.title, exact: true }).click();
  await expect(page.locator('.notes-minu-renderer')).toContainText('Updated on reopening.');
  expect(api.requests.filter((request) => request.path === `${prefix}/notes/${browserFixture.source.id}`)).toHaveLength(
    2
  );
});

test('direct descendant links load one body and Back preserves its folder', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  await page.goto(`${url}?note=${browserFixture.child.id}`);
  await expect(page.getByRole('heading', { name: browserFixture.child.title, exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: browserFixture.child.title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to folder' }).click();
  await expect(page).toHaveURL(`${url}?folder=${browserFixture.childFolder.id}`);
  await expect(page.getByRole('heading', { name: browserFixture.childFolder.title, exact: true })).toBeVisible();
  expect(api.requests.filter((request) => request.path.startsWith(`${prefix}/notes/`))).toHaveLength(2);
});

test('Back and Forward each reauthorize selected Markdown without retaining old bodies', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  await page.goto(`${url}?note=${browserFixture.linked.id}&view=board`);
  await expect(page.getByRole('heading', { name: browserFixture.linked.title, exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Target Note', exact: true }).click();
  await expect(page.getByRole('heading', { name: browserFixture.target.title, exact: true })).toBeVisible();
  api.notes.set(browserFixture.target.id, { ...browserFixture.target, content: 'New target body for Forward.' });
  await page.goBack();
  await expect(page.getByRole('heading', { name: browserFixture.linked.title, exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.locator('.notes-minu-renderer')).toContainText('New target body for Forward.');
  await expect(page).toHaveURL(/view=board/);
  for (const id of [browserFixture.linked.id, browserFixture.target.id])
    expect(api.requests.filter((request) => request.path === `${prefix}/notes/${id}`)).toHaveLength(2);
});

test('a late canceled note A cannot overwrite selected note B', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  api.notes.set(browserFixture.target.id, { ...browserFixture.target, content: 'Current B body.' });
  let release!: () => void;
  let completed!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = new Promise<void>((resolve) => {
    completed = resolve;
  });
  await page.route(`**${prefix}/notes/${browserFixture.source.id}`, async (route) => {
    await pending;
    await route.fulfill({ json: { note: { ...browserFixture.source, content: 'Late A secret.' }, resolutions: [] } });
    completed();
  });
  await page.goto(url);
  await page.getByRole('button', { name: browserFixture.source.title, exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Loading shared note...');
  await page.getByRole('button', { name: 'Back to folder' }).click();
  await page.getByRole('button', { name: browserFixture.target.title, exact: true }).click();
  await expect(page.locator('.notes-minu-renderer')).toContainText('Current B body.');
  release();
  await done;
  await expect(page.getByText('Late A secret.', { exact: true })).toHaveCount(0);
  await expect(page.locator('.notes-minu-renderer')).toContainText('Current B body.');
});

test('switching tokens cancels old reads even when both shares use the same note ID', async ({ page }) => {
  await mockPropertyBoard(page);
  const other = '/share/folders/another_token';
  const source = { ...browserFixture.source, title: 'Other shared note', content: 'Other body. [[Folder A]]' };
  await page.route(`**/internal${other}/navigation`, (route) =>
    route.fulfill({
      json: {
        folder: browserFixture.folder,
        folders: [],
        notes: [
          {
            id: source.id,
            folderId: source.folderId,
            title: source.title,
            documentType: source.documentType,
            updatedAt: source.updatedAt,
          },
        ],
        share: { id: 'other', permission: 'read', createdAt: source.createdAt },
      },
    })
  );
  await page.route(`**/internal${other}/notes/${source.id}`, (route) =>
    route.fulfill({
      json: {
        note: source,
        resolutions: [{ target: 'Folder A', href: `${url}?note=${source.id}` }],
      },
    })
  );
  let release!: () => void;
  let completed!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = new Promise<void>((resolve) => {
    completed = resolve;
  });
  await page.route(`**${prefix}/notes/${source.id}`, async (route) => {
    await pending;
    await route.fulfill({ json: { note: { ...source, content: 'Old token secret.' }, resolutions: [] } });
    completed();
  });
  await page.goto(`${other}?note=${source.id}`);
  await expect(page.locator('.notes-minu-renderer')).toContainText('Other body.');
  await page.getByRole('link', { name: 'Folder A', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Loading shared note...');
  await page.goBack();
  await expect(page.locator('.notes-minu-renderer')).toContainText('Other body.');
  release();
  await done;
  await expect(page.getByText('Old token secret.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: source.title, exact: true })).toBeVisible();
});

for (const denial of ['moved', 'revoked']) {
  test(`reopening after ${denial} does not display the previously downloaded body`, async ({ page }) => {
    const api = await mockPropertyBoard(page);
    await page.goto(`${url}?note=${browserFixture.source.id}`);
    await expect(page.locator('.notes-minu-renderer')).toContainText(browserFixture.source.content);
    await page.getByRole('button', { name: 'Back to folder' }).click();
    await expect(page.getByRole('button', { name: browserFixture.source.title, exact: true })).toBeVisible();
    if (denial === 'moved') api.notes.set(browserFixture.source.id, { ...browserFixture.source, folderId: 'outside' });
    else api.controls.shareRevoked = true;
    await page.getByRole('button', { name: browserFixture.source.title, exact: true }).click();
    await expect(
      page.getByRole('heading', {
        name: denial === 'moved' ? 'Shared note unavailable' : 'Shared folder unavailable',
        exact: true,
      })
    ).toBeVisible();
    await expect(page.locator('.notes-minu-renderer')).toHaveCount(0);
    expect(
      api.requests.filter((request) => request.path === `${prefix}/notes/${browserFixture.source.id}`)
    ).toHaveLength(2);
  });
}

test('failed focus revalidation hides the retained body and only explicit Retry reads again', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  await page.goto(`${url}?note=${browserFixture.source.id}`);
  await expect(page.locator('.notes-minu-renderer')).toContainText(browserFixture.source.content);
  let failed = true;
  await page.route(`**${prefix}/notes/${browserFixture.source.id}`, (route) =>
    failed ? route.fulfill({ status: 503, json: { error: 'Temporary failure' } }) : route.fallback()
  );
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('alert')).toContainText('Unable to load shared note.');
  await expect(page.locator('.notes-minu-renderer')).toHaveCount(0);
  expect(api.requests.filter((request) => request.path === `${prefix}/notes/${browserFixture.source.id}`)).toHaveLength(
    2
  );
  failed = false;
  api.notes.set(browserFixture.source.id, { ...browserFixture.source, content: 'Recovered after focus failure.' });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.notes-minu-renderer')).toContainText('Recovered after focus failure.');
});

for (const state of ['loading', 'failed']) {
  test(`preserves descendant Back after focus revalidation is ${state} without retaining its body`, async ({
    page,
  }) => {
    await mockPropertyBoard(page);
    await page.goto(`${url}?note=${browserFixture.child.id}`);
    await expect(page.getByRole('heading', { name: browserFixture.child.title, exact: true })).toBeVisible();
    let release!: () => void;
    let completed!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = new Promise<void>((resolve) => {
      completed = resolve;
    });
    let intercepted = false;
    await page.route(`**${prefix}/notes/${browserFixture.child.id}`, async (route) => {
      intercepted = true;
      try {
        await pending;
        await route.fulfill({ status: 503, json: { error: 'Temporary failure' } });
      } finally {
        completed();
      }
    });
    try {
      await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
      await expect(page.getByRole('status')).toHaveText('Loading shared note...');
      await expect(page.locator('.notes-minu-renderer')).toHaveCount(0);
      if (state === 'failed') {
        release();
        await expect(page.getByRole('alert')).toContainText('Unable to load shared note.');
        await expect(page.locator('.notes-minu-renderer')).toHaveCount(0);
      }
      await page.getByRole('button', { name: 'Back to folder' }).click();
      await expect(page).toHaveURL(`${url}?folder=${browserFixture.childFolder.id}`);
      await expect(page.getByRole('heading', { name: browserFixture.childFolder.title, exact: true })).toBeVisible();
    } finally {
      release();
      if (intercepted) await done;
    }
  });
}

test('a valid detail opens even when navigation stays stale, without a recovery loop', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  const fresh = { ...browserFixture.source, id: 'note_fresh', title: 'Fresh note', content: 'Fresh body.' };
  api.notes.set(fresh.id, fresh);
  await page.route(`**${prefix}/navigation`, (route) =>
    route.fulfill({
      json: {
        folder: browserFixture.folder,
        folders: [],
        notes: [],
        share: { id: 'share', permission: 'read', createdAt: fresh.createdAt },
      },
    })
  );
  await page.goto(`${url}?note=${fresh.id}`);
  await expect(page.getByRole('heading', { name: fresh.title, exact: true })).toBeVisible();
  await expect(page.locator('.notes-minu-renderer')).toContainText(fresh.content);
  await expect.poll(() => api.requests.filter((request) => request.path === `${prefix}/navigation`).length).toBe(2);
  expect(api.requests.filter((request) => request.path === `${prefix}/notes/${fresh.id}`)).toHaveLength(1);
});

test('a selected canvas loads only its own body and no separate wikilinks', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  await page.goto(`${url}?note=${browserFixture.canvas.id}`);
  await expect(page.locator('.notes-minu-canvas')).toBeVisible();
  expect(api.requests.filter((request) => request.path.startsWith(`${prefix}/notes/`))).toHaveLength(1);
});
