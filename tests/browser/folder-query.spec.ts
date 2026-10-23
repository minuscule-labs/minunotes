import { expect, type Page, test } from '@playwright/test';
import { noteQueryIdentity, noteQuerySearch, parseNoteQuery } from '../../src/shared/note-filters';
import { browserFixture } from './fixtures';
import { mockPropertyBoard } from './property-board-fixtures';

const folder = `/folders/${browserFixture.folder.id}`;
const main = (page: Page) => page.getByRole('main');
const titleInput = (page: Page) => page.getByRole('textbox', { name: 'Search titles in this folder', exact: true });
async function switchView(page: Page, view: 'list' | 'board') {
  await main(page)
    .getByRole('button', { name: `Actions for ${browserFixture.folder.title}`, exact: true })
    .click();
  await page.getByRole('button', { name: `Switch to ${view}`, exact: true }).click();
}
async function openFilters(page: Page) {
  await page.getByRole('button', { name: /^Filter(?: · \d+)?$/ }).click();
  const panel = page.getByRole('dialog', { name: 'Filter notes' });
  await expect(panel.getByRole('button', { name: 'Add property', exact: true })).toBeEnabled();
  return panel;
}
async function addProperty(panel: ReturnType<Page['getByRole']>, id: string) {
  await panel.getByRole('button', { name: 'Add property', exact: true }).click();
  await panel.getByLabel('Add property', { exact: true }).selectOption(id);
}
for (const view of ['list', 'board'] as const) {
  const url = `${folder}${view === 'board' ? '?view=board' : ''}`;
  test(`${view}: debounce finds unloaded note, Enter preserves focus, clear resets pagination`, async ({ page }) => {
    const api = await mockPropertyBoard(page, { extraCards: 151 });
    await page.goto(url);
    await expect(titleInput(page)).toBeVisible();
    await expect(main(page).getByRole('link', { name: 'Extra 150', exact: true })).toHaveCount(0);
    const reads = () => [...api.listRequests, ...api.laneRequests].filter((request) => request.searchParams.has('q'));
    await titleInput(page).fill('Extra 150');
    await page.waitForTimeout(120);
    expect(reads()).toHaveLength(0);
    await expect(main(page).getByRole('link', { name: 'Extra 150', exact: true })).toBeVisible();
    await expect(titleInput(page)).toBeFocused();
    await titleInput(page).fill('Extra 149');
    await titleInput(page).press('Enter');
    await expect(main(page).getByRole('link', { name: 'Extra 149', exact: true })).toBeVisible();
    await expect(main(page).getByRole('link', { name: 'Extra 150', exact: true })).toHaveCount(0);
    await expect(titleInput(page)).toBeFocused();
    expect(reads().every((request) => request.searchParams.get('page') === '1')).toBeTruthy();
    await page.getByRole('button', { name: 'Clear search', exact: true }).click();
    await expect(titleInput(page)).toHaveValue('');
    await expect(main(page).getByRole('link', { name: browserFixture.source.title, exact: true })).toBeVisible();
    expect(api.writes).toEqual([]);
  });
  test(`${view}: hidden full Text filters are explicit drafts, Escape/Cancel discard and Clear retains title`, async ({
    page,
  }) => {
    const api = await mockPropertyBoard(page);
    api.cards[0].displayValues = { text_field: `${'prefix'.repeat(50)} hidden-match`, date_field: '2028-02-29' };
    api.setCardProperties([]);
    await page.goto(`${url}${view === 'board' ? '&' : '?'}q=${encodeURIComponent(browserFixture.source.title)}`);
    await expect(main(page).getByRole('link', { name: browserFixture.source.title, exact: true })).toBeVisible();
    let panel = await openFilters(page);
    await addProperty(panel, 'text_field');
    await panel.getByLabel('Value for Summary', { exact: true }).fill('hidden-match');
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(new URL(page.url()).searchParams.has('filters')).toBeFalsy();
    panel = await openFilters(page);
    await expect(panel.getByLabel('Value for Summary', { exact: true })).toHaveCount(0);
    await addProperty(panel, 'text_field');
    await panel.getByLabel('Value for Summary', { exact: true }).fill('hidden-match');
    await panel.press('Escape');
    await expect(page.getByRole('button', { name: 'Filter', exact: true })).toBeFocused();
    panel = await openFilters(page);
    await addProperty(panel, 'text_field');
    await panel.getByLabel('Value for Summary', { exact: true }).fill('hidden-match');
    await panel.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Filter · 1', exact: true })).toBeVisible();
    await expect(main(page).getByRole('link', { name: browserFixture.source.title, exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('q')).toBe(browserFixture.source.title);
    panel = await openFilters(page);
    await panel.getByRole('button', { name: 'Clear all', exact: true }).click();
    await panel.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Filter', exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.has('filters')).toBeFalsy();
    await expect(titleInput(page)).toHaveValue(browserFixture.source.title);
    expect(api.writes).toEqual([]);
  });
  test(`${view}: date draft validation keeps applied query and valid inclusive range works`, async ({ page }) => {
    const api = await mockPropertyBoard(page);
    api.cards[0].displayValues = { date_field: '2028-02-29' };
    await page.goto(url);
    const panel = await openFilters(page);
    await addProperty(panel, 'date_field');
    await panel.getByLabel('Operator for Due date').selectOption('between');
    await panel.getByLabel('Start date for Due date').fill('2028-03-01');
    await panel.getByLabel('End date for Due date').fill('2028-02-29');
    await panel.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('start on or before');
    expect(new URL(page.url()).searchParams.has('filters')).toBeFalsy();
    await panel.getByLabel('Start date for Due date').fill('2028-02-29');
    await panel.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(main(page).getByRole('link', { name: browserFixture.source.title, exact: true })).toBeVisible();
    await expect(main(page).getByRole('link', { name: browserFixture.canvas.title, exact: true })).toHaveCount(0);
    if (view === 'board')
      await expect(page.getByText('No matching notes in this column.', { exact: true })).toHaveCount(3);
    expect(api.writes).toEqual([]);
  });
  test(`${view}: malformed/repeated query blocks results and explicit repair restores scope`, async ({ page }) => {
    const api = await mockPropertyBoard(page);
    await page.goto(`${url}${view === 'board' ? '&' : '?'}q=a&q=b`);
    await expect(main(page).getByRole('alert')).toContainText('single search');
    expect(api.listRequests).toEqual([]);
    expect(api.laneRequests).toEqual([]);
    await page.getByRole('button', { name: 'Clear folder query', exact: true }).click();
    await expect(main(page).getByRole('link', { name: browserFixture.source.title, exact: true })).toBeVisible();
  });
  for (const echo of [null, 'old-query'])
    test(`${view}: missing/mismatched echo ${echo} fails closed`, async ({ page }) => {
      const api = await mockPropertyBoard(page);
      api.controls.queryEcho = echo;
      await page.goto(`${url}${view === 'board' ? '&' : '?'}q=${encodeURIComponent(browserFixture.source.title)}`);
      await expect(main(page).getByRole('alert')).toContainText('query was not confirmed');
      await expect(main(page).getByRole('link', { name: browserFixture.source.title, exact: true })).toHaveCount(0);
    });
}

for (const view of ['list', 'board'] as const)
  for (const missing of [true, false])
    test(`${view}: ${missing ? 'missing' : 'mismatched'} property schema echo blocks results`, async ({ page }) => {
      const api = await mockPropertyBoard(page);
      api.controls.schemaEcho = missing ? null : { schemaId: 'schema_board', schemaRevision: 999 };
      const query = parseNoteQuery({
        filters: JSON.stringify({
          version: 1,
          all: [{ schemaId: 'schema_board', propertyId: 'date_field', type: 'date', operator: 'empty' }],
        }),
      });
      const params = new URLSearchParams(noteQuerySearch(query));
      if (view === 'board') params.set('view', 'board');
      await page.goto(`${folder}?${params}`);
      await expect(main(page).getByRole('alert')).toContainText('Filter definitions changed');
      await expect(main(page).getByRole('link', { name: browserFixture.source.title, exact: true })).toHaveCount(0);
    });

for (const view of ['list', 'board'] as const)
  test(`${view}: toolbar Clear filters retains title and refresh uses the same applied query`, async ({ page }) => {
    const api = await mockPropertyBoard(page);
    await page.goto(`${folder}?q=Source${view === 'board' ? '&view=board' : ''}`);
    const panel = await openFilters(page);
    await addProperty(panel, 'type_field');
    await panel.getByRole('checkbox', { name: 'Bug', exact: true }).check();
    await panel.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(main(page).getByRole('link', { name: browserFixture.source.title, exact: true })).toBeVisible();
    const toolbar = main(page).getByRole('region', { name: 'Folder query', exact: true });
    const refresh = toolbar.getByRole('button', {
      name: view === 'board' ? 'Refresh board' : 'Refresh notes',
      exact: true,
    });
    const before = view === 'board' ? api.laneRequests.length : api.listRequests.length;
    const beforeUrl = page.url();
    await refresh.click();
    await expect
      .poll(() => (view === 'board' ? api.laneRequests.length : api.listRequests.length))
      .toBeGreaterThan(before);
    await expect(main(page).getByRole('link', { name: browserFixture.source.title, exact: true })).toBeVisible();
    expect(page.url()).toBe(beforeUrl);
    await expect(toolbar.getByRole('button', { name: 'Filter · 1', exact: true })).toBeVisible();
    await toolbar.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await expect(toolbar.getByRole('button', { name: 'Filter', exact: true })).toBeFocused();
    await expect(toolbar.getByRole('button', { name: 'Clear filters', exact: true })).toHaveCount(0);
    await expect(titleInput(page)).toHaveValue('Source');
    expect(new URL(page.url()).searchParams.has('filters')).toBeFalsy();
    await toolbar.getByRole('button', { name: 'Clear search', exact: true }).click();
    await expect(titleInput(page)).toBeFocused();
    await expect(titleInput(page)).toHaveValue('');
    expect(api.writes).toEqual([]);
  });

test('pending title debounce preserves an open property draft', async ({ page }) => {
  await mockPropertyBoard(page);
  await page.goto(folder);
  await titleInput(page).fill('Source');
  const panel = await openFilters(page);
  await addProperty(panel, 'text_field');
  await panel.getByLabel('Value for Summary', { exact: true }).fill('draft stays');
  await page.waitForTimeout(350);
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel('Value for Summary', { exact: true })).toHaveValue('draft stays');
  expect(new URL(page.url()).searchParams.get('q')).toBe('Source');
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(new URL(page.url()).searchParams.has('filters')).toBeFalsy();
});

test('legacy List and empty query documents normalize without changing the remembered view', async ({ page }) => {
  await mockPropertyBoard(page);
  await page.addInitScript(() => localStorage.setItem('minunotes:folder-view:user_browser:folder_browser', 'board'));
  await page.goto(`${folder}?view=list&q=++&filters=${encodeURIComponent(JSON.stringify({ version: 1, all: [] }))}`);
  await expect(page).toHaveURL(new RegExp(`${folder}$`));
  await expect(main(page).getByRole('table')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('minunotes:folder-view:user_browser:folder_browser'))).toBe(
    'board'
  );
  await page.reload();
  await expect(main(page).getByRole('table')).toBeVisible();
  await page.goto(`${folder}?view=unsupported&q=Source`);
  await expect(page.getByRole('region', { name: 'Folder board', exact: true })).toBeVisible();
  await expect(titleInput(page)).toHaveValue('Source');
});

test('one folder query survives view switches, reload and Back/Forward without query storage', async ({ page }) => {
  const api = await mockPropertyBoard(page, { extraCards: 60 });
  await page.goto(folder);
  await titleInput(page).fill('Extra 059');
  await titleInput(page).press('Enter');
  await expect(main(page).getByRole('link', { name: 'Extra 059', exact: true })).toBeVisible();
  let panel = await openFilters(page);
  await addProperty(panel, 'type_field');

  await panel.getByRole('checkbox', { name: 'Bug', exact: true }).check();
  await panel.getByRole('checkbox', { name: 'Feature', exact: true }).check();
  await panel.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Filter · 1', exact: true })).toBeVisible();
  const listUrl = page.url();
  const filters = new URL(listUrl).searchParams.get('filters');
  expect(new URL(listUrl).searchParams.has('view')).toBeFalsy();
  await switchView(page, 'board');
  await expect(page.getByRole('region', { name: 'Folder board', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('filters')).toBe(filters);
  await expect(titleInput(page)).toHaveCount(1);
  await page.goBack();
  await expect(page).toHaveURL(listUrl);
  await expect(main(page).getByRole('table')).toBeVisible();
  await page.reload();
  await expect(main(page).getByRole('table')).toBeVisible();
  await expect(page).toHaveURL(listUrl);
  await page.goForward();
  await expect(page.getByRole('region', { name: 'Folder board', exact: true })).toBeVisible();
  await switchView(page, 'list');
  panel = await openFilters(page);
  await panel.getByRole('button', { name: 'Clear all', exact: true }).click();
  await panel.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Filter', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('button', { name: 'Filter · 1', exact: true })).toBeVisible();
  const storage = await page.evaluate(() => ({ ...localStorage }));
  expect(
    Object.values(storage).some((value) => String(value).includes('Extra 059') || String(value).includes('type_field'))
  ).toBeFalsy();
  expect(api.writes).toEqual([]);
});
for (const disabled of [true, false])
  test(`List search independent of ${disabled ? 'disabled' : 'absent'} Board`, async ({ page }) => {
    const api = await mockPropertyBoard(page, { disabled, absent: !disabled });
    await page.goto(`${folder}?q=${encodeURIComponent(browserFixture.source.title)}`);
    await expect(main(page).getByRole('link', { name: browserFixture.source.title, exact: true })).toBeVisible();
    expect(api.laneRequests).toEqual([]);
    expect(api.writes).toEqual([]);
  });
for (const literal of ['123', '[1]', 'false', '"quoted"', '%_\\ 漢'])
  test(`literal title URL ${literal}`, async ({ page }) => {
    const api = await mockPropertyBoard(page);
    api.cards[0].title = literal;
    await page.goto(folder);
    await titleInput(page).fill(literal);
    await titleInput(page).press('Enter');
    await expect(main(page).getByRole('link', { name: literal, exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('q')).toBe(literal);
    await page.reload();
    await expect(titleInput(page)).toHaveValue(literal);
    await switchView(page, 'board');
    await expect(main(page).getByRole('link', { name: literal, exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('q')).toBe(literal);
  });
for (const role of ['viewer', 'commenter', 'editor', 'owner'] as const)
  test(`${role} can filter without mutation or permission widening`, async ({ page }) => {
    const api = await mockPropertyBoard(page, { role });
    const before = structuredClone(api.cards);
    await page.goto(`${folder}?view=board`);
    const panel = await openFilters(page);
    await addProperty(panel, 'workflow_field');
    await panel.getByRole('checkbox', { name: 'Ready', exact: true }).check();
    await panel.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(main(page).getByRole('link', { name: browserFixture.source.title, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Board settings', exact: true })).toHaveCount(
      role === 'owner' ? 1 : 0
    );
    expect(api.writes).toEqual([]);
    expect(api.cards).toEqual(before);
  });
for (const view of ['list', 'board'] as const)
  for (const late of ['success', 'error'] as const)
    test(`${view}: superseded ${late} cannot replace or block the current query`, async ({ page }) => {
      const api = await mockPropertyBoard(page);
      api.cards[0].title = 'current-query';
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held = 0;
      await page.route(/\/internal\/folders\/[^/]+\/(notes|board)\?/, async (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get('q') !== 'old-query') return route.fallback();
        held++;
        await gate;
        const card = {
          id: 'old_card',
          title: 'Old query must never reappear',
          folderId: browserFixture.folder.id,
          type: 'note',
          documentType: 'markdown',
          createdAt: browserFixture.source.createdAt,
          updatedAt: browserFixture.source.updatedAt,
          properties: [],
          unclassifiedReason: null,
        };
        await route
          .fulfill(
            late === 'error'
              ? { status: 409, json: { error: 'Obsolete query failed' } }
              : {
                  json: {
                    notes: [card],
                    cards: [card],
                    lane: url.searchParams.get('lane'),
                    page: 1,
                    limit: 25,
                    hasMore: false,
                    configVersion: 1,
                    schemaId: api.schema.schemaId,
                    schemaRevision: api.schema.revision,
                    queryIdentity: noteQueryIdentity(parseNoteQuery({ q: 'old-query' })),
                    access: { role: 'owner', source: 'owner' },
                  },
                }
          )
          .catch(() => {});
      });
      await page.goto(`${folder}?q=old-query${view === 'board' ? '&view=board' : ''}`);
      await expect.poll(() => held).toBeGreaterThan(0);
      await titleInput(page).fill('current-query');
      await titleInput(page).press('Enter');
      await expect(main(page).getByRole('link', { name: 'current-query', exact: true })).toBeVisible();
      release();
      await page.waitForTimeout(100);
      await expect(main(page).getByRole('link', { name: 'Old query must never reappear', exact: true })).toHaveCount(0);
      await expect(main(page).getByRole('alert')).toHaveCount(0);
      await expect(main(page).getByRole('link', { name: 'current-query', exact: true })).toBeVisible();
    });

test('composition and pending title callbacks do not cross folder navigation; parent Back restores applied query', async ({
  page,
}) => {
  const api = await mockPropertyBoard(page);
  await page.goto(`${folder}?q=${encodeURIComponent(browserFixture.source.title)}`);
  await expect(main(page).getByRole('link', { name: browserFixture.source.title, exact: true })).toBeVisible();
  await titleInput(page).dispatchEvent('compositionstart');
  await titleInput(page).fill('unfinished-composition');
  await titleInput(page).press('Enter');
  await page.waitForTimeout(350);
  expect(api.listRequests.some((request) => request.searchParams.get('q') === 'unfinished-composition')).toBeFalsy();
  await titleInput(page).dispatchEvent('compositionend');
  await main(page).getByRole('link', { name: 'Child folder', exact: true }).click();
  await expect(titleInput(page)).toHaveValue('');
  await page.waitForTimeout(350);
  expect(new URL(page.url()).searchParams.has('q')).toBeFalsy();
  expect(api.listRequests.some((request) => request.searchParams.get('q') === 'unfinished-composition')).toBeFalsy();
  await page.goBack();
  await expect(titleInput(page)).toHaveValue(browserFixture.source.title);
});

test('List query changes reset page and stale bulk selection; clear never resurrects selection', async ({ page }) => {
  const api = await mockPropertyBoard(page, { extraCards: 90 });
  await page.goto(folder);
  await main(page)
    .getByRole('checkbox', { name: `Select ${browserFixture.source.title}`, exact: true })
    .check();
  await expect(page.getByText('1 note selected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Page 2', { exact: true })).toBeVisible();
  await titleInput(page).fill('Extra 089');
  await titleInput(page).press('Enter');
  await expect(main(page).getByRole('link', { name: 'Extra 089', exact: true })).toBeVisible();
  await expect(page.getByText('Page 2', { exact: true })).toHaveCount(0);
  await expect(page.getByText('1 note selected', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(
    main(page).getByRole('checkbox', { name: `Select ${browserFixture.source.title}`, exact: true })
  ).not.toBeChecked();
  expect(
    api.listRequests
      .filter((request) => request.searchParams.has('q'))
      .every((request) => request.searchParams.get('page') === '1')
  ).toBeTruthy();
});

for (const view of ['list', 'board'] as const)
  test(`${view}: observed access revocation hides every cached query and survives Back`, async ({ page }) => {
    const api = await mockPropertyBoard(page, { role: 'viewer' });
    await page.goto(`${folder}${view === 'list' ? '?view=board' : ''}`);
    await expect(main(page).getByRole('link', { name: browserFixture.source.title, exact: true })).toBeVisible();
    if (view === 'list') api.controls.listFailure = 403;
    else api.controls.laneFailure = 403;
    await switchView(page, view);
    await expect(main(page).getByText('Folder not found', { exact: true })).toBeVisible();
    await page.goBack();
    await expect(main(page).getByText('Folder not found', { exact: true })).toBeVisible();
    await expect(main(page).getByRole('link', { name: browserFixture.source.title, exact: true })).toHaveCount(0);
  });

for (const width of [390, 1280])
  for (const theme of ['catppuccin-latte', 'catppuccin-mocha'])
    for (const view of ['list', 'board'] as const)
      test(`${view}: filter geometry and keyboard at ${width} ${theme}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript((theme) => localStorage.setItem('notes-theme', theme), theme);
        const api = await mockPropertyBoard(page);
        const long = `Priority ${'long-property-'.repeat(7)}`;
        const option = `Bug ${'long-option-'.repeat(9)}`;
        api.typeField.label = long;
        api.typeField.options[0].label = option;
        api.cards[0].displayValues = { date_field: '2028-02-29' };
        await page.goto(
          `${folder}?q=${encodeURIComponent(browserFixture.source.title)}${view === 'board' ? '&view=board' : ''}`
        );
        await expect(titleInput(page)).toBeVisible();
        await expect(page.locator('html')).toHaveClass(new RegExp(`theme-${theme}`));
        const toolbar = main(page).getByRole('region', { name: 'Folder query', exact: true });
        const refresh = toolbar.getByRole('button', {
          name: view === 'board' ? 'Refresh board' : 'Refresh notes',
          exact: true,
        });
        await expect(refresh).toBeVisible();
        const settings = toolbar.getByRole('button', { name: 'Board settings', exact: true });
        await expect(settings).toHaveCount(view === 'board' ? 1 : 0);
        const searchBounds = await titleInput(page).boundingBox();
        expect(searchBounds?.height).toBe(32);
        expect(searchBounds?.width).toBeLessThanOrEqual(240);
        if (width === 1280) {
          const filterBounds = await toolbar.getByRole('button', { name: 'Filter', exact: true }).boundingBox();
          const refreshBounds = await refresh.boundingBox();
          expect(filterBounds?.y).toBe(searchBounds?.y);
          expect(refreshBounds?.y).toBe(searchBounds?.y);
          expect((refreshBounds?.x ?? 0) - (filterBounds?.x ?? 0)).toBeGreaterThan(200);
        }
        await page.screenshot({ path: testInfo.outputPath('compact-toolbar.png'), fullPage: true });
        const panel = await openFilters(page);
        await addProperty(panel, 'type_field');

        await panel.getByRole('checkbox', { name: option, exact: true }).check();
        await addProperty(panel, 'date_field');
        await panel.getByLabel('Operator for Due date').selectOption('between');
        await panel.getByRole('button', { name: 'Apply', exact: true }).click();
        await expect(panel.getByRole('alert')).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
        await page.screenshot({ path: testInfo.outputPath('folder-query-draft.png'), fullPage: true });
        await panel.getByLabel('Start date for Due date').fill('2028-02-29');
        await panel.getByLabel('End date for Due date').fill('2028-02-29');
        await panel.getByRole('button', { name: 'Apply', exact: true }).click();
        await expect(main(page).getByRole('link', { name: /^Source Note/ })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Filter · 2', exact: true })).toBeFocused();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
        if (view === 'board') {
          const board = page.getByRole('region', { name: 'Folder board', exact: true });
          const geometry = await board.evaluate((grid) => {
            const main = grid.closest('main');
            if (!main) throw new Error('Missing main content');
            const style = getComputedStyle(main);
            const bottom =
              main.getBoundingClientRect().bottom -
              parseFloat(style.paddingBottom) -
              parseFloat(style.borderBottomWidth);
            return {
              gap: Math.abs(bottom - grid.getBoundingClientRect().bottom),
              widths: [...grid.children].map((lane) => lane.getBoundingClientRect().width),
              heights: [...grid.children].map((lane) => lane.getBoundingClientRect().height),
            };
          });
          expect(geometry.gap).toBeLessThanOrEqual(2);
          expect(geometry.widths.every((value) => value >= 256 && value <= 384)).toBeTruthy();
          expect(new Set(geometry.heights.map(Math.round)).size).toBe(1);
        }
        await page.screenshot({ path: testInfo.outputPath('folder-query-applied.png'), fullPage: true });
      });

test('property counts are draft-local; option search preserves hidden selections and property matching is inclusive', async ({
  page,
}) => {
  const api = await mockPropertyBoard(page);
  await page.goto(folder);
  await expect(main(page).getByRole('link', { name: browserFixture.source.title, exact: true })).toBeVisible();
  const panel = await openFilters(page);
  await addProperty(panel, 'type_field');
  await expect(panel.getByLabel('Search options for Type', { exact: true })).toBeFocused();
  const reads = api.listRequests.length;
  await panel.getByRole('checkbox', { name: 'Bug', exact: true }).check();
  await panel.getByLabel('Search options for Type').fill('Feature');
  await expect(panel.getByRole('checkbox', { name: 'Bug', exact: true })).toHaveCount(0);
  await panel.getByRole('checkbox', { name: 'Feature', exact: true }).check();
  await expect(panel.getByRole('button', { name: 'Edit Type', exact: true })).toHaveAccessibleDescription('2 selected');
  await panel.getByLabel('Search options for Type').fill('no such option');
  await expect(panel.getByText('No matching options.', { exact: true })).toBeVisible();
  await panel.getByLabel('Search options for Type').fill('');
  await expect(panel.getByRole('checkbox', { name: 'Bug', exact: true })).toBeChecked();
  await expect(panel.getByRole('checkbox', { name: 'Feature', exact: true })).toBeChecked();
  await addProperty(panel, 'workflow_field');
  await panel.getByRole('checkbox', { name: 'Ready', exact: true }).check();
  await expect(panel.getByRole('button', { name: 'Edit Workflow', exact: true })).toHaveAccessibleDescription(
    '1 selected'
  );
  expect(api.listRequests).toHaveLength(reads);
  expect(new URL(page.url()).searchParams.has('filters')).toBeFalsy();
  await panel.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Filter · 2', exact: true })).toBeFocused();
  const applied = parseNoteQuery({ filters: new URL(page.url()).searchParams.get('filters') });
  expect(applied.filters.all).toHaveLength(2);
  expect(applied.filters.all.find((filter) => filter.propertyId === 'type_field')).toMatchObject({
    operator: 'anyOf',
    optionIds: ['Type_Bug', 'Type_Feature'],
  });
  await expect(main(page).getByRole('link', { name: browserFixture.source.title, exact: true })).toBeVisible();
  await expect(main(page).getByRole('link', { name: browserFixture.canvas.title, exact: true })).toHaveCount(0);
  expect(api.writes).toEqual([]);
});

test('clearing a property or all draft filters is explicit, cancellable, and keeps the applied title', async ({
  page,
}) => {
  const api = await mockPropertyBoard(page);
  await page.goto(`${folder}?q=Source`);
  let panel = await openFilters(page);
  await addProperty(panel, 'type_field');
  await panel.getByRole('checkbox', { name: 'Bug', exact: true }).check();
  await addProperty(panel, 'workflow_field');
  await panel.getByRole('checkbox', { name: 'Ready', exact: true }).check();
  await panel.getByRole('button', { name: 'Apply', exact: true }).click();
  const applied = page.url();
  panel = await openFilters(page);
  await panel.getByRole('button', { name: 'Edit Type', exact: true }).click();
  await panel.getByRole('button', { name: 'Clear Type', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Add property', exact: true })).toBeFocused();
  await expect(panel.getByRole('button', { name: 'Edit Workflow', exact: true })).toBeVisible();
  expect(page.url()).toBe(applied);
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
  panel = await openFilters(page);
  await expect(panel.getByRole('button', { name: 'Edit Type', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Clear all', exact: true }).click();
  expect(page.url()).toBe(applied);
  await expect(panel.getByRole('navigation', { name: 'Filter properties' }).getByRole('button')).toHaveCount(0);
  await panel.press('Escape');
  panel = await openFilters(page);
  await expect(panel.getByRole('button', { name: 'Edit Type', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Clear Type', exact: true }).click();
  await panel.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Filter · 1', exact: true })).toBeVisible();
  panel = await openFilters(page);
  await panel.getByRole('button', { name: 'Clear all', exact: true }).click();
  await panel.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(titleInput(page)).toHaveValue('Source');
  expect(new URL(page.url()).searchParams.has('filters')).toBeFalsy();
  expect(api.writes).toEqual([]);
});

test('legacy single choice stays unchanged until Apply; unchecking its last option clears only that condition', async ({
  page,
}) => {
  const api = await mockPropertyBoard(page);
  const query = parseNoteQuery({
    q: 'Source',
    filters: JSON.stringify({
      version: 1,
      all: [
        {
          schemaId: api.schema.schemaId,
          propertyId: 'type_field',
          type: 'select',
          operator: 'is',
          optionId: 'Type_Bug',
        },
        { schemaId: api.schema.schemaId, propertyId: 'workflow_field', type: 'select', operator: 'empty' },
      ],
    }),
  });
  await page.goto(`${folder}?${new URLSearchParams(noteQuerySearch(query))}`);
  const before = page.url();
  let panel = await openFilters(page);
  await panel.getByRole('button', { name: 'Edit Type', exact: true }).click();
  await expect(panel.getByRole('checkbox', { name: 'Bug', exact: true })).toBeChecked();
  await panel.getByRole('checkbox', { name: 'Bug', exact: true }).uncheck();
  await expect(panel.getByRole('button', { name: 'Edit Type', exact: true })).not.toHaveAccessibleDescription(
    '1 selected'
  );
  expect(page.url()).toBe(before);
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(page.url()).toBe(before);
  panel = await openFilters(page);
  await panel.getByRole('button', { name: 'Edit Type', exact: true }).click();
  await panel.getByRole('checkbox', { name: 'Bug', exact: true }).uncheck();
  await panel.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Filter · 1', exact: true })).toBeVisible();
  expect(parseNoteQuery({ filters: new URL(page.url()).searchParams.get('filters') }).filters.all).toEqual([
    query.filters.all.find((filter) => filter.propertyId === 'workflow_field'),
  ]);
  expect(new URL(page.url()).searchParams.get('q')).toBe('Source');
  expect(api.writes).toEqual([]);
});

for (const view of ['list', 'board'] as const)
  test(`${view}: Not set checkbox combines with values, survives reload/view switches and clears explicitly`, async ({
    page,
  }) => {
    const api = await mockPropertyBoard(page, { extraCards: 4 });
    api.typeField.options[0].label = 'Backlog';
    const values = ['Type_Bug', undefined, null, ' \t', 'Type_Feature', 42];
    api.cards.forEach((card, index) => {
      card.title = `Filter candidate ${index}`;
      card.typeValue = index < values.length ? values[index] : 'Type_Feature';
    });
    await page.goto(`${folder}${view === 'board' ? '?view=board' : ''}`);
    let panel = await openFilters(page);
    await addProperty(panel, 'type_field');
    await expect(panel.getByLabel('Match for Type', { exact: true })).toHaveCount(0);
    const notSet = () => panel.getByRole('checkbox', { name: 'Not set (empty value)', exact: true });
    await panel.getByRole('checkbox', { name: 'Backlog', exact: true }).check();
    await notSet().check();
    await panel.getByLabel('Search options for Type').fill('no matching status');
    await expect(notSet()).toBeChecked();
    await expect(panel.getByRole('button', { name: 'Edit Type', exact: true })).toHaveAccessibleDescription(
      '2 selected'
    );
    await panel.getByRole('button', { name: 'Apply', exact: true }).click();
    const query = () => parseNoteQuery({ filters: new URL(page.url()).searchParams.get('filters') ?? undefined });
    expect(query().filters.all).toEqual([
      {
        schemaId: 'schema_board',
        propertyId: 'type_field',
        type: 'select',
        operator: 'anyOf',
        optionIds: ['Type_Bug'],
        includeEmpty: true,
      },
    ]);
    await expect(main(page).getByRole('list', { name: 'Applied filters' })).toContainText('Backlog, Not set');
    for (let index = 0; index < values.length; index++)
      await expect(main(page).getByRole('link', { name: `Filter candidate ${index}`, exact: true })).toHaveCount(
        index < 4 ? 1 : 0
      );
    await switchView(page, view === 'list' ? 'board' : 'list');
    expect(query().filters.all[0]).toMatchObject({ includeEmpty: true, optionIds: ['Type_Bug'] });
    await page.reload();
    panel = await openFilters(page);
    await expect(notSet()).toBeChecked();
    await expect(panel.getByRole('checkbox', { name: 'Backlog', exact: true })).toBeChecked();
    await panel.getByRole('checkbox', { name: 'Backlog', exact: true }).uncheck();
    await panel.getByRole('button', { name: 'Apply', exact: true }).click();
    expect(query().filters.all).toEqual([
      {
        schemaId: 'schema_board',
        propertyId: 'type_field',
        type: 'select',
        operator: 'empty',
      },
    ]);
    panel = await openFilters(page);
    await expect(notSet()).toBeChecked();
    await panel.getByRole('checkbox', { name: 'Backlog', exact: true }).check();
    await panel.getByRole('button', { name: 'Apply', exact: true }).click();
    expect(query().filters.all[0]).toMatchObject({ includeEmpty: true, optionIds: ['Type_Bug'] });
    panel = await openFilters(page);
    await notSet().uncheck();
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(query().filters.all[0]).toMatchObject({ includeEmpty: true });
    panel = await openFilters(page);
    await notSet().uncheck();
    await panel.getByRole('button', { name: 'Apply', exact: true }).click();
    expect(query().filters.all[0]).toMatchObject({ operator: 'anyOf', optionIds: ['Type_Bug'] });
    expect(query().filters.all[0]).not.toHaveProperty('includeEmpty');
    panel = await openFilters(page);
    await panel.getByRole('checkbox', { name: 'Backlog', exact: true }).uncheck();
    await panel.getByRole('button', { name: 'Apply', exact: true }).click();
    expect(query().filters.all).toEqual([]);
    expect(api.writes).toEqual([]);
  });

test('unavailable selected options remain visible and block Apply until explicitly removed', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  const query = parseNoteQuery({
    filters: JSON.stringify({
      version: 1,
      all: [
        {
          schemaId: api.schema.schemaId,
          propertyId: 'type_field',
          type: 'select',
          operator: 'anyOf',
          optionIds: ['Type_Bug', 'missing_option'],
          includeEmpty: true,
        },
      ],
    }),
  });
  await page.goto(`${folder}?${new URLSearchParams(noteQuerySearch(query))}`);
  const before = page.url();
  const panel = await openFilters(page);
  await expect(panel.getByRole('checkbox', { name: 'Unavailable option', exact: true })).toBeChecked();
  await panel.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(panel.getByRole('alert').filter({ hasText: 'filtered option is unavailable' })).toBeVisible();
  expect(page.url()).toBe(before);
  expect(api.listRequests).toHaveLength(0);
  await panel.getByRole('checkbox', { name: 'Unavailable option', exact: true }).click();
  await expect(panel.getByRole('checkbox', { name: 'Unavailable option', exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(main(page).getByRole('link', { name: browserFixture.source.title, exact: true })).toBeVisible();
  expect(api.writes).toEqual([]);
});

test('empty Select/Text/Date modes remain supported and incomplete Text cannot silently clear filters', async ({
  page,
}) => {
  const api = await mockPropertyBoard(page);
  await page.goto(folder);
  const panel = await openFilters(page);
  await addProperty(panel, 'text_field');
  await panel.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(panel.getByRole('alert')).toBeVisible();
  expect(new URL(page.url()).searchParams.has('filters')).toBeFalsy();
  await panel.getByLabel('Operator for Summary').selectOption('empty');
  await addProperty(panel, 'type_field');
  await panel.getByRole('checkbox', { name: 'Not set (empty value)', exact: true }).check();
  await addProperty(panel, 'date_field');
  await panel.getByLabel('Operator for Due date').selectOption('empty');
  await panel.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Filter · 3', exact: true })).toBeVisible();
  expect(
    parseNoteQuery({ filters: new URL(page.url()).searchParams.get('filters') }).filters.all.every(
      (filter) => filter.operator === 'empty'
    )
  ).toBeTruthy();
  expect(api.writes).toEqual([]);
});

for (const width of [390, 1280])
  for (const theme of ['catppuccin-latte', 'catppuccin-mocha'])
    test(`two-pane long option list, keyboard and footer at ${width} ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 780 });
      await page.addInitScript((value) => localStorage.setItem('notes-theme', value), theme);
      const api = await mockPropertyBoard(page);
      const field = api.schema.definitions.find((item) => item.id === 'type_field');
      if (!field) throw new Error('Missing Type');
      field.options.push(
        ...Array.from({ length: 40 }, (_, index) => ({
          id: `long_option_${index}`,
          label: `Option ${index} ${'Long option label '.repeat(4)}`,
          archived: false,
        }))
      );
      await page.goto(folder);
      const panel = await openFilters(page);
      await addProperty(panel, 'type_field');
      await expect(panel.getByLabel('Search options for Type')).toBeFocused();
      await panel.getByLabel('Search options for Type').press('Tab');
      await page.keyboard.press('Space');
      await expect(panel.getByRole('checkbox', { name: 'Bug', exact: true })).toBeChecked();
      const navigation = await panel.getByRole('navigation', { name: 'Filter properties' }).boundingBox();
      const search = await panel.getByLabel('Search options for Type').boundingBox();
      expect(navigation && search).toBeTruthy();
      if (width >= 640) expect(search?.x).toBeGreaterThan((navigation?.x ?? 0) + (navigation?.width ?? 0));
      else expect(search?.y).toBeGreaterThan(navigation?.y ?? 0);
      await page.screenshot({ path: testInfo.outputPath('property-filter-picker.png'), fullPage: true });
      await panel.getByRole('checkbox', { name: field.options.at(-1)?.label, exact: true }).check();
      await expect(panel.getByRole('button', { name: 'Apply', exact: true })).toBeInViewport();
      await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
      await page.screenshot({ path: testInfo.outputPath('property-filter-options.png'), fullPage: true });
      const before = page.url();
      await main(page).getByRole('heading', { name: browserFixture.folder.title, exact: true, level: 2 }).click();
      await expect(panel).toHaveCount(0);
      expect(page.url()).toBe(before);
      await openFilters(page);
      await expect(page.getByRole('button', { name: 'Edit Type', exact: true })).toHaveCount(0);
      expect(api.writes).toEqual([]);
    });

test('Select maximum stays explicit and reopening never prunes unavailable applied selections', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  const type = api.schema.definitions.find((field) => field.id === 'type_field');
  if (!type) throw new Error('Missing Type');
  type.options.push(
    ...Array.from({ length: 8 }, (_, index) => ({ id: `more_${index}`, label: `More ${index}`, archived: false }))
  );
  await page.goto(folder);
  let panel = await openFilters(page);
  await expect(panel.getByRole('button', { name: 'Refresh definitions', exact: true })).toHaveCount(0);
  await addProperty(panel, 'type_field');
  await panel.getByRole('checkbox', { name: 'Bug', exact: true }).check();
  for (let index = 0; index < 8; index++)
    await panel.getByRole('checkbox', { name: `More ${index}`, exact: true }).check();
  await expect(panel.getByRole('button', { name: 'Edit Type', exact: true })).toHaveAccessibleDescription('9 selected');
  await panel.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(panel.getByRole('alert')).toBeVisible();
  expect(new URL(page.url()).searchParams.has('filters')).toBeFalsy();
  await panel.getByRole('checkbox', { name: 'More 7', exact: true }).uncheck();
  await panel.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Filter · 1', exact: true })).toBeVisible();
  const appliedUrl = page.url();
  const bug = type.options.find((option) => option.id === 'Type_Bug');
  if (!bug) throw new Error('Missing Bug');
  bug.archived = true;
  api.schema.revision++;
  panel = await openFilters(page);
  await expect(panel.getByRole('checkbox', { name: 'Unavailable option', exact: true })).toBeChecked();
  await expect(panel.getByRole('button', { name: 'Edit Type', exact: true })).toHaveAccessibleDescription('8 selected');
  await panel.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(panel.getByRole('alert').filter({ hasText: 'filtered option is unavailable' })).toBeVisible();
  expect(page.url()).toBe(appliedUrl);
  await panel.getByRole('checkbox', { name: 'Unavailable option', exact: true }).click();
  await expect(panel.getByRole('checkbox', { name: 'Unavailable option', exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Filter · 1', exact: true })).toBeVisible();
  expect(api.writes).toEqual([]);
});

test('empty hint and wrapped property counts are vertically centered', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  const field = api.schema.definitions.find((item) => item.id === 'type_field');
  if (!field) throw new Error('Missing Type');
  field.label = 'A property with a long wrapping name '.repeat(3);
  await page.goto(folder);
  const panel = await openFilters(page);
  const hint = panel.getByText('Add a property to narrow down your notes.', { exact: true });
  const hintOffset = await hint.evaluate((element) => {
    const parent = element.parentElement;
    if (!parent) throw new Error('Missing hint container');
    const text = element.getBoundingClientRect();
    const container = parent.getBoundingClientRect();
    return Math.abs(text.y + text.height / 2 - container.y - container.height / 2);
  });
  expect(hintOffset).toBeLessThanOrEqual(1);
  await addProperty(panel, 'type_field');
  await panel.getByRole('checkbox', { name: 'Bug', exact: true }).check();
  const offset = await panel.getByRole('button', { name: `Edit ${field.label}`, exact: true }).evaluate((element) => {
    const label = element.querySelector('span');
    const count = element.querySelector('[id$="-count"]');
    if (!label || !count) throw new Error('Missing property label/count');
    const text = label.getBoundingClientRect();
    const badge = count.getBoundingClientRect();
    return {
      difference: Math.abs(text.y + text.height / 2 - badge.y - badge.height / 2),
      wraps: text.height > badge.height,
    };
  });
  expect(offset.wraps).toBeTruthy();
  expect(offset.difference).toBeLessThanOrEqual(1);
  expect(api.writes).toEqual([]);
});

async function chooseSort(page: Page, label: string) {
  await page.getByRole('button', { name: /^Sort by ·/ }).click();
  const panel = page.getByRole('dialog', { name: 'Sort notes', exact: true });
  const chooseField = panel.getByRole('button', { name: 'Choose sort field', exact: true });
  if (await chooseField.count()) await chooseField.click();
  await panel.getByRole('button', { name: label.split(' · ')[0], exact: true }).click();
  await panel
    .getByLabel('Sort direction', { exact: true })
    .selectOption(label.includes('Oldest') || label.includes('A–Z') ? 'asc' : 'desc');
  await panel.press('Escape');
  await expect(panel).toHaveCount(0);
}
const noteIds = (page: Page) =>
  main(page)
    .locator('a[href^="/notes/"]:visible')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href')?.split('/').at(-1)));

for (const view of ['list', 'board'] as const) {
  test(`${view}: all six sort orders are global, deterministic and read-only`, async ({ page }) => {
    const api = await mockPropertyBoard(page, { extraCards: 2 });
    const rows = [
      { title: 'Sort Bravo', created: 3, updated: 1 },
      { title: 'Sort Alpha', created: 1, updated: 3 },
      { title: 'Sort Alpha', created: 1, updated: 3 },
      { title: 'Sort Zulu', created: 2, updated: 2 },
      { title: 'Sort Bravo', created: 3, updated: 1 },
    ];
    api.cards.forEach((card, index) => {
      Object.assign(card, rows[index], {
        value: 'Option_Todo',
        createdAt: `2028-01-0${rows[index].created}T00:00:00.000Z`,
        updatedAt: `2028-01-0${rows[index].updated}T00:00:00.000Z`,
      });
    });
    const alpha = [api.cards[1].id, api.cards[2].id].sort(),
      bravo = [api.cards[0].id, api.cards[4].id].sort(),
      zulu = api.cards[3].id;
    const choices = [
      ['Updated · Newest first', 'updated-desc', [...alpha, zulu, ...bravo]],
      ['Updated · Oldest first', 'updated-asc', [...bravo, zulu, ...alpha]],
      ['Title · A–Z', 'title-asc', [...alpha, ...bravo, zulu]],
      ['Title · Z–A', 'title-desc', [zulu, ...bravo, ...alpha]],
      ['Created · Newest first', 'created-desc', [...bravo, zulu, ...alpha]],
      ['Created · Oldest first', 'created-asc', [...alpha, zulu, ...bravo]],
    ] as const;
    const before = structuredClone(api.cards);
    await page.goto(`${folder}${view === 'board' ? '?view=board' : ''}`);
    for (const [label, token, expected] of choices) {
      await chooseSort(page, label);
      await expect.poll(() => noteIds(page)).toEqual([...expected]);
      expect(new URL(page.url()).searchParams.get('sort')).toBe(token === 'updated-desc' ? null : token);
      await expect(page.getByRole('button', { name: `Sort by · ${label}`, exact: true })).toBeFocused();
    }
    expect(api.writes).toEqual([]);
    expect(api.cards).toEqual(before);
    const requests = view === 'board' ? api.laneRequests : api.listRequests;
    const count = requests.length;
    await page.getByRole('button', { name: view === 'board' ? 'Refresh board' : 'Refresh notes', exact: true }).click();
    await expect.poll(() => requests.length).toBeGreaterThan(count);
    expect(requests.slice(count).every((url) => url.searchParams.get('sort') === 'created-asc')).toBeTruthy();
    await expect.poll(() => noteIds(page)).toEqual([...choices[5][2]]);
  });
  test(`${view}: unloaded globally first card and pages reset on sort changes without selection or duplicates`, async ({
    page,
  }) => {
    const api = await mockPropertyBoard(page, { extraCards: 151 });
    await page.goto(`${folder}${view === 'board' ? '?view=board' : ''}`);
    await expect(main(page).getByRole('link', { name: 'Extra 150', exact: true })).toHaveCount(0);
    if (view === 'board') {
      await page.getByRole('button', { name: 'Load more Ready', exact: true }).click();
      await expect(page.getByRole('note', { name: '50 cards loaded. More available.', exact: true })).toBeVisible();
    } else {
      await main(page)
        .getByRole('checkbox', { name: `Select ${browserFixture.source.title}`, exact: true })
        .check();
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await expect(page.getByText('Page 2', { exact: true })).toBeVisible();
    }
    await chooseSort(page, 'Title · Z–A');
    await expect(main(page).getByRole('link', { name: 'Extra 150', exact: true })).toBeVisible();
    expect(await noteIds(page)).toContain('extra_150');
    await expect(page.getByText('Page 2', { exact: true })).toHaveCount(0);
    await expect(page.getByText('1 note selected', { exact: true })).toHaveCount(0);
    const requests = view === 'board' ? api.laneRequests : api.listRequests;
    expect(
      requests
        .filter((url) => url.searchParams.get('sort') === 'title-desc')
        .every((url) => url.searchParams.get('page') === '1')
    ).toBeTruthy();
    const firstPageIds = await noteIds(page);
    if (view === 'board') {
      await expect(page.getByRole('note', { name: '25 cards loaded. More available.', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Load more Ready', exact: true }).click();
    } else await page.getByRole('button', { name: 'Next', exact: true }).click();
    if (view === 'list') await expect(page.getByText('Page 2', { exact: true })).toBeVisible();
    await expect.poll(async () => (await noteIds(page)).length).toBe(view === 'board' ? 52 : 50);
    const ids = await noteIds(page);
    expect(new Set(ids).size).toBe(ids.length);
    if (view === 'list') expect(ids.some((id) => firstPageIds.includes(id))).toBeFalsy();
    await chooseSort(page, 'Title · A–Z');
    await expect(main(page).getByRole('link', { name: 'Extra 000', exact: true })).toBeVisible();
    expect(api.writes).toEqual([]);
  });
  for (const echo of ['missing', 'wrong'] as const)
    test(`${view}: ${echo} sort echo never displays falsely sorted results`, async ({ page }) => {
      const api = await mockPropertyBoard(page);
      api.controls.sortEcho = echo === 'missing' ? null : 'created-desc';
      await page.goto(`${folder}?sort=title-asc${view === 'board' ? '&view=board' : ''}`);
      await expect(main(page).getByRole('alert')).toContainText('Sort order was not confirmed');
      await expect(main(page).getByRole('link', { name: browserFixture.source.title, exact: true })).toHaveCount(0);
      await chooseSort(page, 'Updated · Newest first');
      await expect(main(page).getByRole('link', { name: browserFixture.source.title, exact: true })).toBeVisible();
      expect(api.writes).toEqual([]);
    });
  test(`${view}: invalid sort blocks reads; Reset sort repairs only sort and preserves literal title/filter scope`, async ({
    page,
  }) => {
    const api = await mockPropertyBoard(page);
    api.cards[0].title = '[1]';
    const query = parseNoteQuery({
      q: '[1]',
      filters: JSON.stringify({
        version: 1,
        all: [
          {
            schemaId: api.schema.schemaId,
            propertyId: 'type_field',
            type: 'select',
            operator: 'anyOf',
            optionIds: ['Type_Bug'],
          },
        ],
      }),
    });
    await page.goto(
      `${folder}?${new URLSearchParams(noteQuerySearch(query))}&sort=title-asc&sort=title-desc${view === 'board' ? '&view=board' : ''}`
    );
    await expect(main(page).getByRole('alert')).toContainText('Invalid sort');
    expect(api.listRequests).toEqual([]);
    expect(api.laneRequests).toEqual([]);
    expect(new URL(page.url()).searchParams.getAll('sort')).toHaveLength(2);
    await page.getByRole('button', { name: 'Reset sort', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sort by · Updated · Newest first', exact: true })).toBeFocused();
    await expect(main(page).getByRole('link', { name: '[1]', exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('q')).toBe('[1]');
    expect(new URL(page.url()).searchParams.has('filters')).toBeTruthy();
    expect(new URL(page.url()).searchParams.has('sort')).toBeFalsy();
    expect(api.writes).toEqual([]);
  });
}

test('personal sort survives query/filter clears, view switches, reload and history; unrelated folder starts clean', async ({
  page,
}) => {
  const api = await mockPropertyBoard(page);
  await page.goto(folder);
  await titleInput(page).fill('Source');
  await chooseSort(page, 'Title · Z–A');
  await expect(titleInput(page)).toHaveValue('Source');
  expect(new URL(page.url()).searchParams.get('q')).toBe('Source');
  const panel = await openFilters(page);
  await addProperty(panel, 'type_field');
  await panel.getByRole('checkbox', { name: 'Bug', exact: true }).check();
  await panel.getByRole('button', { name: 'Apply', exact: true }).click();
  const first = page.url();
  await switchView(page, 'board');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sort by · Title · Z–A', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('sort')).toBe('title-desc');
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  expect(new URL(page.url()).searchParams.get('sort')).toBe('title-desc');
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  expect(new URL(page.url()).searchParams.get('sort')).toBe('title-desc');
  await chooseSort(page, 'Created · Oldest first');
  await page.goBack();
  await expect(page.getByRole('button', { name: 'Sort by · Created · Newest first', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('button', { name: 'Sort by · Title · Z–A', exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('button', { name: 'Sort by · Created · Newest first', exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('button', { name: 'Sort by · Created · Oldest first', exact: true })).toBeVisible();
  await switchView(page, 'list');
  await main(page).getByRole('link', { name: 'Child folder', exact: true }).click();
  expect(new URL(page.url()).searchParams.has('sort')).toBeFalsy();
  await page.goBack();
  await expect(page.getByRole('button', { name: 'Sort by · Created · Oldest first', exact: true })).toBeVisible();
  expect(new URL(first).searchParams.get('filters')).toBeTruthy();
  const stored = await page.evaluate(() => ({ ...localStorage }));
  expect(
    Object.entries(stored).some(([key, value]) => /sort/i.test(key) || /title-desc|created-asc/.test(value))
  ).toBeFalsy();
  expect(api.writes).toEqual([]);
});

for (const role of ['owner', 'editor', 'commenter', 'viewer'] as const)
  test(`${role}: personal sorting does not mutate shared config or properties`, async ({ page }) => {
    const api = await mockPropertyBoard(page, { role });
    const before = structuredClone(api.cards);
    await page.goto(`${folder}?view=board`);
    await chooseSort(page, 'Title · A–Z');
    await expect(main(page).getByRole('link', { name: browserFixture.source.title, exact: true })).toBeVisible();
    expect(api.writes).toEqual([]);
    expect(api.cards).toEqual(before);
    await expect(page.getByRole('button', { name: 'Board settings', exact: true })).toHaveCount(
      role === 'owner' ? 1 : 0
    );
  });

for (const width of [390, 1280])
  for (const theme of ['catppuccin-latte', 'catppuccin-mocha'])
    test(`personal sort keyboard and geometry at ${width} ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 780 });
      await page.addInitScript((value) => localStorage.setItem('notes-theme', value), theme);
      const api = await mockPropertyBoard(page);
      await page.goto(`${folder}?view=board`);
      const button = page.getByRole('button', { name: 'Sort by · Updated · Newest first', exact: true });
      await button.focus();
      await page.keyboard.press('Enter');
      const panel = page.getByRole('dialog', { name: 'Sort notes', exact: true });
      await expect(panel.getByRole('group', { name: 'Sort fields', exact: true }).getByRole('button')).toHaveCount(7);
      await expect(panel.getByLabel('Search sort fields')).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath('personal-sort-options.png'), fullPage: true });
      await panel.press('Escape');
      await expect(button).toBeFocused();
      await button.press('Enter');
      await panel.getByRole('button', { name: 'Title', exact: true }).focus();
      await page.keyboard.press('Space');
      await expect(panel.getByRole('button', { name: 'Choose sort field', exact: true })).toBeFocused();
      await panel.getByLabel('Sort direction', { exact: true }).selectOption('desc');
      await expect(panel.getByLabel('Sort direction', { exact: true }).locator('option')).toHaveCount(2);
      await page.screenshot({ path: testInfo.outputPath('personal-sort-editor.png'), fullPage: true });
      await panel.press('Escape');
      await expect(page.getByRole('button', { name: 'Sort by · Title · Z–A', exact: true })).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
      await expect(page.getByRole('button', { name: 'Board settings', exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('personal-sort-applied.png'), fullPage: true });
      expect(api.writes).toEqual([]);
    });

for (const view of ['list', 'board'] as const)
  for (const late of ['success', 'error'] as const)
    test(`${view}: superseded sort ${late} cannot replace or block the current order`, async ({ page }) => {
      const api = await mockPropertyBoard(page);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held = 0,
        finished = 0;
      await page.route(/\/internal\/folders\/[^/]+\/(notes|board)\?/, async (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get('sort') !== 'title-asc') return route.fallback();
        held++;
        await gate;
        const card = {
          id: 'obsolete_sort',
          title: 'Obsolete sort must not reappear',
          folderId: browserFixture.folder.id,
          type: 'note',
          documentType: 'markdown',
          createdAt: browserFixture.source.createdAt,
          updatedAt: browserFixture.source.updatedAt,
          properties: [],
          unclassifiedReason: null,
        };
        await route
          .fulfill(
            late === 'error'
              ? { status: 409, json: { error: 'Obsolete sort failed' } }
              : {
                  json: {
                    notes: [card],
                    cards: [card],
                    sortIdentity: 'title-asc',
                    lane: url.searchParams.get('lane'),
                    page: 1,
                    limit: 25,
                    hasMore: false,
                    configVersion: 1,
                    schemaId: api.schema.schemaId,
                    schemaRevision: api.schema.revision,
                    access: { role: 'owner', source: 'owner' },
                  },
                }
          )
          .catch(() => {});
        finished++;
      });
      try {
        await page.goto(`${folder}?sort=title-asc${view === 'board' ? '&view=board' : ''}`);
        await expect.poll(() => held).toBeGreaterThan(0);
        await chooseSort(page, 'Title · Z–A');
        await expect(main(page).getByRole('link', { name: browserFixture.source.title, exact: true })).toBeVisible();
      } finally {
        release();
      }
      await expect.poll(() => finished).toBe(held);
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      );
      await expect(main(page).getByRole('link', { name: 'Obsolete sort must not reappear', exact: true })).toHaveCount(
        0
      );
      await expect(main(page).getByRole('alert')).toHaveCount(0);
      await expect(main(page).getByRole('link', { name: browserFixture.source.title, exact: true })).toBeVisible();
      expect(new URL(page.url()).searchParams.get('sort')).toBe('title-desc');
      expect(api.writes).toEqual([]);
    });

test('field-first sort search stays local; field/direction edit in place and remove restores the default', async ({
  page,
}) => {
  const api = await mockPropertyBoard(page);
  await page.goto(folder);
  await expect(main(page).getByRole('link', { name: browserFixture.source.title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Sort by ·/ }).click();
  const panel = page.getByRole('dialog', { name: 'Sort notes', exact: true });
  const before = page.url();
  const reads = api.listRequests.length;
  await panel.getByLabel('Search sort fields').fill('cre');
  await expect(panel.getByRole('group', { name: 'Sort fields' }).getByRole('button')).toHaveCount(1);
  await expect(panel.getByRole('button', { name: 'Created', exact: true })).toBeVisible();
  await panel.getByLabel('Search sort fields').fill('not a field');
  await expect(panel.getByText('No matching fields.', { exact: true })).toBeVisible();
  expect(page.url()).toBe(before);
  expect(api.listRequests).toHaveLength(reads);
  await panel.getByLabel('Search sort fields').fill('cre');
  await panel.getByRole('button', { name: 'Created', exact: true }).click();
  await expect(panel.getByLabel('Sort direction')).toHaveValue('desc');
  await expect(panel.getByRole('button', { name: 'Choose sort field' })).toBeFocused();
  expect(new URL(page.url()).searchParams.get('sort')).toBe('created-desc');
  await expect(page.getByRole('button', { name: 'Sort by · Created · Newest first' })).toHaveText('Created');
  await panel.getByLabel('Sort direction').selectOption('asc');
  await expect(panel).toBeVisible();
  expect(new URL(page.url()).searchParams.get('sort')).toBe('created-asc');
  await panel.getByRole('button', { name: 'Choose sort field' }).click();
  await expect(panel.getByLabel('Search sort fields')).toBeFocused();
  await expect(panel.getByRole('group', { name: 'Sort fields' }).getByRole('button')).toHaveCount(7);
  await panel.getByRole('button', { name: 'Title', exact: true }).click();
  await expect(panel.getByLabel('Sort direction')).toHaveValue('asc');
  await expect(panel.getByRole('button', { name: 'Add sort', exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Remove sort', exact: true }).click();
  await expect(panel).toHaveCount(0);
  const trigger = page.getByRole('button', { name: 'Sort by · Updated · Newest first', exact: true });
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveText('Sort by');
  expect(new URL(page.url()).searchParams.has('sort')).toBeFalsy();
  await trigger.click();
  await expect(panel.getByLabel('Search sort fields')).toHaveValue('');
  await expect(panel.getByRole('group', { name: 'Sort fields' }).getByRole('button')).toHaveCount(7);
  expect(api.writes).toEqual([]);
});

test('external sort history closes the field picker without applying its search', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  await page.goto(folder);
  await chooseSort(page, 'Title · A–Z');
  await page.getByRole('button', { name: /^Sort by ·/ }).click();
  const panel = page.getByRole('dialog', { name: 'Sort notes', exact: true });
  await panel.getByRole('button', { name: 'Choose sort field' }).click();
  await panel.getByLabel('Search sort fields').fill('Created');
  await page.goBack();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sort by · Updated · Newest first' })).toBeVisible();
  expect(new URL(page.url()).searchParams.has('sort')).toBeFalsy();
  expect(api.writes).toEqual([]);
});

async function choosePropertySort(page: Page, label: string, type: string, direction: 'asc' | 'desc') {
  await page.getByRole('button', { name: /^Sort by ·/ }).click();
  const panel = page.getByRole('dialog', { name: 'Sort notes', exact: true });
  const field = panel.getByRole('button', { name: 'Choose sort field', exact: true });
  if (await field.count()) await field.click();
  await panel.getByRole('button', { name: `${label} · ${type} property`, exact: true }).click();
  await panel.getByLabel('Sort direction').selectOption(direction);
  await panel.press('Escape');
}
for (const view of ['list', 'board'] as const)
  for (const type of ['text', 'date', 'select'] as const)
    test(`property sort: ${view} ${type} hidden full values and invalid-last in both directions`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: view === 'board' ? 390 : 1280, height: 780 });
      await page.addInitScript(
        (theme) => localStorage.setItem('notes-theme', theme),
        view === 'board' ? 'catppuccin-latte' : 'catppuccin-mocha'
      );
      const api = await mockPropertyBoard(page, { extraCards: 2, role: 'viewer' });
      api.setCardProperties([]);
      const field = api.schema.definitions.find(
        (item) => item.id === (type === 'text' ? 'text_field' : type === 'date' ? 'date_field' : 'type_field')
      );
      if (!field) throw new Error('Missing sort field');
      const values =
        type === 'text'
          ? [`${'prefix'.repeat(40)}z`, `${'prefix'.repeat(40)}a`, null, [], ' \t\u00a0']
          : type === 'date'
            ? ['2028-03-01', '2028-02-29', '0000-01-01', '2026-02-29', null]
            : ['Type_Feature', 'Type_Bug', 'unknown', '', 'retired'];
      api.cards.forEach((card, index) => {
        card.value = 'Option_Todo';
        card.title = index < 2 ? 'Valid' : 'Empty';
        if (type === 'select') card.typeValue = values[index] as string;
        else card.displayValues = { [field.id]: values[index] };
      });
      await page.goto(`${folder}${view === 'board' ? '?view=board' : ''}`);
      const before = structuredClone(api.cards);
      const invalid = api.cards
        .slice(2)
        .map((card) => card.id)
        .sort();
      for (const direction of ['asc', 'desc'] as const) {
        await choosePropertySort(page, field.label, type, direction);
        const expected = direction === 'asc' ? [api.cards[1].id, api.cards[0].id] : [api.cards[0].id, api.cards[1].id];
        await expect.poll(() => noteIds(page)).toEqual([...expected, ...invalid]);
        const descriptor = JSON.parse(new URL(page.url()).searchParams.get('sort') ?? 'null');
        expect(descriptor).toEqual({
          version: 1,
          schemaId: api.schema.schemaId,
          propertyId: field.id,
          type,
          direction,
        });
        const requests = view === 'board' ? api.laneRequests : api.listRequests;
        const latest = requests.filter((url) => url.searchParams.get('sort') === JSON.stringify(descriptor));
        expect(latest.length).toBeGreaterThan(0);
        expect(
          latest.every(
            (url) =>
              url.searchParams.get('schemaId') === api.schema.schemaId && url.searchParams.get('schemaRevision') === '1'
          )
        ).toBeTruthy();
      }
      await page.getByRole('button', { name: /^Sort by ·/ }).click();
      await page.screenshot({ path: testInfo.outputPath('property-sort-editor.png'), fullPage: true });
      await page.getByRole('dialog', { name: 'Sort notes' }).press('Escape');
      const saved = new URL(page.url()).searchParams.get('sort');
      await page.reload();
      await expect.poll(() => noteIds(page)).toEqual([api.cards[0].id, api.cards[1].id, ...invalid]);
      await switchView(page, view === 'board' ? 'list' : 'board');
      await expect.poll(() => noteIds(page)).toEqual([api.cards[0].id, api.cards[1].id, ...invalid]);
      expect(new URL(page.url()).searchParams.get('sort')).toBe(saved);
      expect(api.writes).toEqual([]);
      expect(api.cards).toEqual(before);
    });

test('property sort: schema echo is required without filters; refresh re-ranks renamed options without changing URL', async ({
  page,
}) => {
  const api = await mockPropertyBoard(page);
  api.cards.forEach((card) => {
    card.value = 'Option_Todo';
  });
  api.cards[0].typeValue = 'Type_Feature';
  api.cards[1].typeValue = 'Type_Bug';
  const descriptor = {
    version: 1,
    schemaId: api.schema.schemaId,
    propertyId: 'type_field',
    type: 'select',
    direction: 'asc',
  };
  api.controls.schemaEcho = null;
  await page.goto(`${folder}?sort=${encodeURIComponent(JSON.stringify(descriptor))}`);
  await expect(main(page).getByRole('alert')).toContainText('Sort definitions changed');
  await expect(main(page).getByRole('link', { name: browserFixture.source.title, exact: true })).toHaveCount(0);
  api.controls.schemaEcho = undefined;
  await page.getByRole('button', { name: 'Refresh notes', exact: true }).click();
  await expect.poll(() => noteIds(page)).toEqual([api.cards[1].id, api.cards[0].id, api.cards[2].id]);
  const before = page.url();
  const field = api.schema.definitions.find((item) => item.id === 'type_field');
  if (!field) throw new Error('Missing Type');
  field.label = 'Priority';
  field.options.reverse();
  api.schema.revision++;
  await page.getByRole('button', { name: /^Sort by ·/ }).click();
  await expect(page.getByRole('button', { name: 'Sort by · Priority · Ascending', exact: true })).toBeVisible();
  await expect.poll(() => noteIds(page)).toEqual([api.cards[0].id, api.cards[1].id, api.cards[2].id]);
  expect(page.url()).toBe(before);
  expect(api.listRequests.at(-1)?.searchParams.get('schemaRevision')).toBe('2');
  expect(api.writes).toEqual([]);
});

test('property sort: unavailable field blocks cached cards until explicit sort-only reset, preserving title and filters', async ({
  page,
}) => {
  const api = await mockPropertyBoard(page);
  api.schema.definitions[2].archived = true;
  const query = parseNoteQuery({
    q: 'Source',
    filters: JSON.stringify({
      version: 1,
      all: [
        {
          schemaId: api.schema.schemaId,
          propertyId: 'type_field',
          type: 'select',
          operator: 'anyOf',
          optionIds: ['Type_Bug'],
        },
      ],
    }),
  });
  const params = new URLSearchParams(noteQuerySearch(query));
  params.set('view', 'board');
  params.set(
    'sort',
    JSON.stringify({
      version: 1,
      schemaId: api.schema.schemaId,
      propertyId: 'date_field',
      type: 'date',
      direction: 'asc',
    })
  );
  await page.goto(`${folder}?${params}`);
  await expect(main(page).getByRole('alert')).toContainText('sort property is unavailable');
  expect(api.laneRequests).toEqual([]);
  const filters = new URL(page.url()).searchParams.get('filters');
  await page.getByRole('button', { name: 'Reset sort', exact: true }).click();
  await expect(main(page).getByRole('link', { name: browserFixture.source.title, exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('filters')).toBe(filters);
  expect(new URL(page.url()).searchParams.get('q')).toBe('Source');
  expect(new URL(page.url()).searchParams.has('sort')).toBeFalsy();
  await page.goBack();
  await expect(main(page).getByRole('alert')).toContainText('sort property is unavailable');
  await expect(main(page).getByRole('link', { name: browserFixture.source.title, exact: true })).toHaveCount(0);
  expect(api.writes).toEqual([]);
});

test('stale field stays applied until explicit removal; refresh does not broaden it', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  const query = parseNoteQuery({
    filters: JSON.stringify({
      version: 1,
      all: [{ schemaId: api.schema.schemaId, propertyId: 'date_field', type: 'date', operator: 'empty' }],
    }),
  });
  api.schema.definitions[2].archived = true;
  await page.goto(`${folder}?${new URLSearchParams(noteQuerySearch(query))}`);
  await expect(main(page).getByRole('alert')).toContainText('unavailable or changed');
  expect(api.listRequests).toEqual([]);
  await page.getByRole('button', { name: 'Refresh definitions', exact: true }).click();
  expect(new URL(page.url()).searchParams.has('filters')).toBeTruthy();
  await page.getByRole('button', { name: /^Remove Unavailable property/ }).click();
  await expect(main(page).getByRole('link', { name: browserFixture.source.title, exact: true })).toBeVisible();
});
