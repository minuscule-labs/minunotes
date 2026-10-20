import { expect, type Page, test } from '@playwright/test';
import type { ColumnVisibility } from '../../src/shared/board';
import { browserFixture } from './fixtures';
import { mockPropertyBoard } from './property-board-fixtures';

const ownerUrl = `/folders/${browserFixture.folder.id}?view=board`;
const publicUrl = '/share/folders/folder_share_token?view=board';
const region = (page: Page) => page.getByRole('region', { name: 'Folder board', exact: true });
const empty = (page: Page) => page.getByRole('status').filter({ hasText: /^No columns selected$/ });

async function setup(page: Page, audience: 'owner' | 'public', extraCards = 0) {
  const api = await mockPropertyBoard(page, { extraCards });
  const note = { ...browserFixture.source, id: 'note_backlog', title: 'Backlog card' };
  api.notes.set(note.id, note);
  api.cards.push({ id: note.id, title: note.title, value: 'Option_Done', typeValue: 'Type_Task', tags: [] });
  if (audience === 'public') await page.route('**/internal/auth/get-session', (route) => route.fulfill({ json: null }));
  return { ...api, url: audience === 'public' ? publicUrl : ownerUrl };
}

const cases: { name: string; visibility: ColumnVisibility; lanes: string[]; labels: string[]; cards: string[] }[] = [
  {
    name: 'All with Unclassified',
    visibility: { mode: 'all', showUnclassified: true },
    lanes: ['Option_Todo', 'Option_Done', 'Option_Empty', 'unclassified'],
    labels: ['Ready', 'Finished', 'Empty', 'Unclassified'],
    cards: ['Backlog card', 'Canvas Note', 'Source Note', 'Target Note'],
  },
  {
    name: 'All without Unclassified',
    visibility: { mode: 'all', showUnclassified: false },
    lanes: ['Option_Todo', 'Option_Done', 'Option_Empty'],
    labels: ['Ready', 'Finished', 'Empty'],
    cards: ['Backlog card', 'Source Note'],
  },
  {
    name: 'Selected with Unclassified',
    visibility: { mode: 'selected', optionIds: ['Option_Todo'], showUnclassified: true },
    lanes: ['Option_Todo', 'unclassified'],
    labels: ['Ready', 'Unclassified'],
    cards: ['Canvas Note', 'Source Note', 'Target Note'],
  },
  {
    name: 'Selected without Unclassified',
    visibility: { mode: 'selected', optionIds: ['Option_Todo'], showUnclassified: false },
    lanes: ['Option_Todo'],
    labels: ['Ready'],
    cards: ['Source Note'],
  },
  {
    name: 'Unclassified only',
    visibility: { mode: 'selected', optionIds: [], showUnclassified: true },
    lanes: ['unclassified'],
    labels: ['Unclassified'],
    cards: ['Canvas Note', 'Target Note'],
  },
  {
    name: 'zero columns',
    visibility: { mode: 'selected', optionIds: [], showUnclassified: false },
    lanes: [],
    labels: [],
    cards: [],
  },
];

for (const audience of ['owner', 'public'] as const) {
  for (const scenario of cases)
    test(`${audience}: ${scenario.name} renders exactly the effective columns and never fetches hidden lanes`, async ({
      page,
    }) => {
      const api = await setup(page, audience);
      api.setColumnVisibility(scenario.visibility);
      await page.goto(api.url);
      if (scenario.lanes.length) {
        await expect(region(page).getByRole('heading', { level: 3 })).toHaveText(scenario.labels);
        await expect
          .poll(() =>
            region(page)
              .getByRole('link')
              .allTextContents()
              .then((titles) => titles.sort())
          )
          .toEqual(scenario.cards);
        await expect(empty(page)).toHaveCount(0);
      } else {
        await expect(empty(page)).toBeVisible();
        await expect(region(page)).toHaveCount(0);
      }
      expect([...new Set(api.laneRequests.map((url) => url.searchParams.get('lane')))].sort()).toEqual(
        [...scenario.lanes].sort()
      );
      expect(api.laneRequests.every((url) => url.searchParams.get('version') === '1')).toBe(true);
      expect(api.requests.filter((r) => r.method !== 'GET')).toEqual([]);
      await expect(page.getByRole('button', { name: 'Board settings', exact: true })).toHaveCount(
        audience === 'owner' ? 1 : 0
      );
    });

  test(`${audience}: hiding a lane removes its cards but not authorized List or note access`, async ({ page }) => {
    const api = await setup(page, audience);
    await page.goto(api.url);
    await expect(region(page).getByRole('link', { name: 'Backlog card', exact: true })).toBeVisible();
    const before = api.laneRequests.length;
    api.setColumnVisibility({ mode: 'selected', optionIds: ['Option_Todo'], showUnclassified: false });
    api.changeConfig();
    await page.getByRole('button', { name: 'Refresh board', exact: true }).click();
    await expect(region(page).getByRole('heading', { level: 3 })).toHaveText(['Ready']);
    await expect(region(page).getByRole('link', { name: 'Backlog card', exact: true })).toHaveCount(0);
    expect(
      api.laneRequests
        .slice(before)
        .every((url) => url.searchParams.get('lane') === 'Option_Todo' && url.searchParams.get('version') === '2')
    ).toBe(true);
    if (audience === 'owner') {
      await page
        .getByRole('main')
        .getByRole('button', { name: `Actions for ${browserFixture.folder.title}`, exact: true })
        .click();
      await page.getByRole('button', { name: 'Switch to list', exact: true }).click();
      await expect(page.getByRole('main').getByRole('link', { name: 'Backlog card', exact: true })).toBeVisible();
      await page.getByRole('main').getByRole('link', { name: 'Backlog card', exact: true }).click();
      await expect(page).toHaveURL('/notes/note_backlog');
      await expect(page.getByRole('textbox', { name: 'Untitled note', exact: true })).toHaveValue('Backlog card');
    } else {
      await page.getByRole('button', { name: 'Switch to list', exact: true }).click();
      await page.getByRole('button', { name: 'Backlog card', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Backlog card', exact: true })).toBeVisible();
      await expect(page.locator('.notes-minu-renderer')).toContainText(browserFixture.source.content);
    }
    expect(api.writes).toEqual([]);
  });

  for (const destination of ['zero', 'another lane'] as const)
    test(`${audience}: a late hidden-lane ${destination === 'zero' ? 'page' : 'error'} cannot revive cards after refresh to ${destination}`, async ({
      page,
    }) => {
      const api = await setup(page, audience, 30);
      await page.goto(api.url);
      const ready = page.getByRole('region', { name: 'Ready', exact: true });
      await expect(ready.getByRole('link')).toHaveCount(25);
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route('**/board?*', async (route) => {
        const params = new URL(route.request().url()).searchParams;
        if (params.get('lane') !== 'Option_Todo' || params.get('page') !== '2' || params.get('version') !== '1')
          return route.fallback();
        await held;
        if (destination === 'another lane') return route.fulfill({ status: 409, json: { error: 'OLD PAGE FAILURE' } });
        await route.fulfill({
          json: {
            cards: [
              {
                id: 'old_page',
                title: 'OLD PAGE CARD',
                folderId: browserFixture.folder.id,
                documentType: 'markdown',
                createdAt: browserFixture.source.createdAt,
                updatedAt: browserFixture.source.updatedAt,
                unclassifiedReason: null,
                properties: [],
              },
            ],
            lane: 'Option_Todo',
            configVersion: 1,
            schemaId: 'schema_board',
            schemaRevision: 1,
            page: 2,
            limit: 25,
            hasMore: false,
          },
        });
      });
      try {
        const requested = page.waitForRequest((r) => {
          const p = new URL(r.url()).searchParams;
          return p.get('lane') === 'Option_Todo' && p.get('page') === '2';
        });
        await ready.getByRole('button', { name: 'Load more Ready', exact: true }).click();
        const oldRequest = await requested;
        const settled = Promise.race([
          page.waitForResponse((r) => r.request() === oldRequest),
          page.waitForEvent('requestfailed', { predicate: (r) => r === oldRequest }),
        ]);
        api.setColumnVisibility({
          mode: 'selected',
          optionIds: destination === 'zero' ? [] : ['Option_Done'],
          showUnclassified: false,
        });
        api.changeConfig();
        await page.getByRole('button', { name: 'Refresh board', exact: true }).click();
        if (destination === 'zero') await expect(empty(page)).toBeVisible();
        else await expect(region(page).getByRole('link', { name: 'Backlog card', exact: true })).toBeVisible();
        release();
        await settled;
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        );
        await expect(page.getByText('OLD PAGE CARD', { exact: true })).toHaveCount(0);
        await expect(page.getByText('OLD PAGE FAILURE', { exact: true })).toHaveCount(0);
        await expect(page.getByRole('region', { name: 'Ready', exact: true })).toHaveCount(0);
        if (destination === 'zero') {
          await expect(empty(page)).toBeVisible();
          await expect(region(page)).toHaveCount(0);
        } else await expect(region(page).getByRole('heading', { level: 3 })).toHaveText(['Finished']);
        // Revealing the lane must use a new generation, not the held page or old loaded pages.
        const before = api.laneRequests.length;
        api.setColumnVisibility({ mode: 'selected', optionIds: ['Option_Todo'], showUnclassified: false });
        api.changeConfig();
        await page.getByRole('button', { name: 'Refresh board', exact: true }).click();
        await expect(ready.getByRole('link')).toHaveCount(25);
        expect(
          api.laneRequests
            .slice(before)
            .every(
              (url) =>
                url.searchParams.get('version') === '3' &&
                url.searchParams.get('page') === '1' &&
                url.searchParams.get('lane') === 'Option_Todo'
            )
        ).toBe(true);
        await expect(page.getByText('OLD PAGE CARD', { exact: true })).toHaveCount(0);
      } finally {
        release();
      }
    });
}

test('zero-column owners can recover through settings without showing hidden cards first', async ({ page }) => {
  const api = await setup(page, 'owner');
  api.setColumnVisibility({ mode: 'selected', optionIds: [], showUnclassified: false });
  await page.goto(api.url);
  await expect(empty(page)).toBeVisible();
  expect(api.laneRequests).toEqual([]);
  await page.getByRole('button', { name: 'Board settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Board settings', exact: true });
  for (const label of ['Ready', 'Finished', 'Empty'])
    await dialog.getByRole('checkbox', { name: `${label} (grouping option)`, exact: true }).check();
  await dialog.getByRole('button', { name: 'Save board', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(empty(page)).toHaveCount(0);
  await expect(region(page).getByRole('heading', { level: 3 })).toHaveText(['Ready', 'Finished', 'Empty']);
  await expect(region(page).getByRole('link', { name: 'Source Note', exact: true })).toBeVisible();
  expect(api.writes).toHaveLength(1);
  expect(api.writes[0].config.columnVisibility).toEqual({
    mode: 'selected',
    optionIds: ['Option_Todo', 'Option_Done', 'Option_Empty'],
    showUnclassified: false,
  });
});

for (const role of ['viewer', 'commenter', 'editor'] as const)
  test(`zero columns does not grant ${role} settings access`, async ({ page }) => {
    const api = await mockPropertyBoard(page, { role });
    api.setColumnVisibility({ mode: 'selected', optionIds: [], showUnclassified: false });
    await page.goto(ownerUrl);
    await expect(empty(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Board settings', exact: true })).toHaveCount(0);
    expect(api.laneRequests).toEqual([]);
    expect(api.writes).toEqual([]);
  });

for (const state of ['disabled', 'unavailable', 'missing columns'] as const)
  test(`${state} is not reported as a successful zero-column selection`, async ({ page }) => {
    const api = await mockPropertyBoard(page, { disabled: state === 'disabled' });
    api.setColumnVisibility({ mode: 'selected', optionIds: [], showUnclassified: false });
    api.controls.unavailable = state === 'unavailable';
    if (state !== 'unavailable')
      await page.route('**/internal/folders/*/board/config', (route) => {
        const board = api.snapshot();
        if (state === 'disabled')
          board.groupingState = { type: 'select', available: false, reason: 'Board is not enabled.' };
        else {
          const { columns: _columns, ...withoutColumns } = board;
          return route.fulfill({ json: { board: withoutColumns, access: { role: 'owner' } } });
        }
        return route.fulfill({ json: { board, access: { role: 'owner' } } });
      });
    await page.goto(ownerUrl);
    if (state === 'disabled') await expect(page.getByRole('alert')).toHaveText('Board is not enabled.');
    else if (state === 'unavailable') await expect(page.getByRole('alert')).toContainText('Grouping unavailable');
    else await expect(region(page)).toBeVisible();
    await expect(empty(page)).toHaveCount(0);
    expect(api.laneRequests).toEqual([]);
  });

test('loading and failed config reads never claim successful zero selection', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  api.setColumnVisibility({ mode: 'selected', optionIds: [], showUnclassified: false });
  api.controls.readFailure = 500;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  await page.route('**/internal/folders/*/board/config', async (route) => {
    if (first) {
      first = false;
      await held;
    }
    await route.fallback();
  });
  try {
    await page.goto(ownerUrl);
    await expect(page.getByRole('status').filter({ hasText: 'Loading board' })).toBeVisible();
    await expect(empty(page)).toHaveCount(0);
    release();
    await expect(page.getByRole('button', { name: 'Retry board', exact: true })).toBeVisible();
    await expect(empty(page)).toHaveCount(0);
    api.controls.readFailure = 0;
    await page.getByRole('button', { name: 'Retry board', exact: true }).click();
    await expect(empty(page)).toBeVisible();
    api.controls.readFailure = 500;
    await page.getByRole('button', { name: 'Refresh board', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('may be stale');
    await expect(empty(page)).toHaveCount(0);
    expect(api.laneRequests).toEqual([]);
  } finally {
    release();
  }
});
