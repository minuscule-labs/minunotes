import { expect, type Locator, type Page, test } from '@playwright/test';
import type { ColumnVisibility } from '../../src/shared/board';
import { browserFixture } from './fixtures';
import { mockPropertyBoard } from './property-board-fixtures';

async function openFolderViews(page: Page) {
  const main = page.getByRole('main');
  const title = await main.getByRole('heading', { level: 2 }).innerText();
  await main.getByRole('button', { name: `Actions for ${title}`, exact: true }).click();
  const views = page.getByRole('button', { name: /^Switch to (list|board)$/ });
  await expect(views).toBeVisible();
  return views;
}
async function switchFolderView(page: Page, name: 'List' | 'Board') {
  const views = await openFolderViews(page);
  await expect(views).toHaveText(`Switch to ${name.toLowerCase()}`);
  await views.click();
  await expect(views).toHaveCount(0);
}

const boardUrl = `/folders/${browserFixture.folder.id}?view=board`;
const boardRegion = (page: Page) => page.getByRole('region', { name: 'Folder board', exact: true });
const loadedDescription = (count: number, more: boolean) =>
  `${count} ${count === 1 ? 'card' : 'cards'} loaded.${more ? ' More available.' : ''}`;
async function expectLoaded(lane: Locator, count: number, more: boolean) {
  const description = loadedDescription(count, more);
  const number = lane.getByRole('note', { name: description, exact: true });
  await expect(number).toBeVisible();
  await expect(number).toHaveText(`· ${count}${more ? '+' : ''}`);
  await expect(lane.getByRole('heading', { level: 3 })).toHaveAccessibleDescription(description);
  return number;
}
async function expectRemainingHeight(page: Page) {
  const board = boardRegion(page);
  await expect
    .poll(() =>
      board.evaluate((grid) => {
        const main = grid.closest('main');
        if (!main) throw new Error('Missing main');
        const style = getComputedStyle(main);
        return Math.abs(
          grid.getBoundingClientRect().bottom -
            (main.getBoundingClientRect().bottom -
              Number.parseFloat(style.paddingBottom) -
              Number.parseFloat(style.borderBottomWidth))
        );
      })
    )
    .toBeLessThanOrEqual(2);
  const metrics = await board.evaluate((grid) => {
    const main = grid.closest('main');
    if (!main) throw new Error('Missing main');
    const rect = grid.getBoundingClientRect(),
      style = getComputedStyle(grid);
    const scrollbar =
      grid.offsetHeight -
      grid.clientHeight -
      Number.parseFloat(style.borderTopWidth) -
      Number.parseFloat(style.borderBottomWidth);
    return {
      mainScroll: main.scrollTop,
      mainHeight: main.clientHeight,
      mainExtent: main.scrollHeight,
      laneBottom:
        rect.bottom - Number.parseFloat(style.paddingBottom) - Number.parseFloat(style.borderBottomWidth) - scrollbar,
      lanes: [...grid.children].map((lane) => {
        const box = lane.getBoundingClientRect();
        return { top: box.top, height: box.height, bottom: box.bottom };
      }),
    };
  });
  expect(metrics.lanes).toHaveLength(4);
  for (const lane of metrics.lanes) {
    expect(lane).toEqual(metrics.lanes[0]);
    expect(Math.abs(lane.bottom - metrics.laneBottom)).toBeLessThanOrEqual(2);
  }
  expect(metrics.mainExtent - metrics.mainHeight).toBeLessThanOrEqual(2);
  expect(metrics.mainScroll).toBe(0);
}

for (const width of [390, 1280])
  for (const theme of ['catppuccin-latte', 'catppuccin-mocha'])
    test(`property-only compact controls and keyboard focus in ${theme} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.addInitScript((theme) => localStorage.setItem('notes-theme', theme), theme);
      const api = await mockPropertyBoard(page);
      await page.goto(`${boardUrl}&boardTags=feature`);
      const board = boardRegion(page);
      await expect(board.getByRole('link', { name: 'Source Note', exact: true })).toBeVisible();
      await expect(page.getByLabel('Filter tags (all, comma-separated)')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Apply filters' })).toHaveCount(0);
      const refresh = page.getByRole('button', { name: 'Refresh board', exact: true });
      const settings = page.getByRole('button', { name: 'Board settings', exact: true });
      await expect(page.getByRole('button', { name: 'About this board', exact: true })).toHaveCount(0);
      for (const button of [refresh, settings]) {
        await expect(button).toHaveText('');
        expect((await button.boundingBox())?.width).toBe(32);
      }
      const hint = page.locator('p.sr-only').filter({ hasText: 'Scroll sideways' });
      await expect(board).toHaveAttribute('aria-describedby', (await hint.getAttribute('id')) ?? '');
      await expect(board).toHaveAccessibleDescription(
        'Scroll sideways for more statuses. Scroll within a column for more cards.'
      );
      await refresh.focus();
      await expect(page.getByRole('tooltip')).toHaveText('Refresh board');
      await page.keyboard.press('Escape');
      await expect(async () => {
        const spacing = await board.locator('li').evaluateAll((cards) =>
          cards.map((card) => {
            const column = card.closest('section')?.parentElement;
            if (!column) throw new Error('Card column missing');
            const outer = column.getBoundingClientRect(),
              inner = card.getBoundingClientRect();
            return { left: inner.left - outer.left, right: outer.right - inner.right };
          })
        );
        expect(spacing.length).toBeGreaterThan(0);
        for (const gaps of spacing) expect(Math.abs(gaps.left - gaps.right)).toBeLessThanOrEqual(1);
      }).toPass({ timeout: 5000 });
      await page.keyboard.press('Escape');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath('property-only-board.png') });
      const before = api.requests.filter((r) => r.path.endsWith('/board/config')).length;
      await refresh.click();
      await expect.poll(() => api.requests.filter((r) => r.path.endsWith('/board/config')).length).toBe(before + 1);
      await page.keyboard.press('Escape');
      await settings.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Board settings', exact: true });
      await expect(dialog.getByLabel('Columns', { exact: true })).toBeEnabled();
      await expect(dialog.getByLabel('Columns', { exact: true })).toHaveValue('workflow_field');
      await expect(
        dialog.getByRole('checkbox', { name: /^(Type|Kind|Category)( select| \(unavailable\))$/ })
      ).toBeChecked();
      await expect(dialog.locator('details')).toHaveCount(0);
      await expect(dialog.getByRole('option', { name: 'Tags', exact: true })).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: 'Refresh and review' })).toHaveCount(0);
      const visibility = dialog.getByRole('group', { name: 'Visible columns', exact: true });
      await expect(visibility.getByRole('radio')).toHaveCount(0);
      for (const label of ['Ready', 'Finished', 'Empty']) {
        await expect(
          visibility.getByRole('checkbox', { name: `${label} (grouping option)`, exact: true })
        ).toBeChecked();
      }
      await expect(visibility.getByRole('checkbox', { name: 'Unclassified', exact: true })).toBeChecked();
      expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath('property-only-settings.png') });
      await dialog.getByRole('checkbox', { name: /^(Type|Kind|Category)( select| \(unavailable\))$/ }).uncheck();
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(settings).toBeFocused();
      expect(api.writes).toEqual([]);
      expect(api.requests.filter((r) => r.method !== 'GET')).toEqual([]);
      expect(
        api.laneRequests.every(
          (url) => !url.searchParams.has('tag') && url.searchParams.get('schemaId') === 'schema_board'
        )
      ).toBe(true);
      await settings.click();
      await expect(
        dialog.getByRole('checkbox', { name: /^(Type|Kind|Category)( select| \(unavailable\))$/ })
      ).toBeChecked();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(settings).toBeFocused();
      const link = board.getByRole('link', { name: 'Source Note', exact: true });
      await link.focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(`/notes/${browserFixture.source.id}`);
    });

for (const role of ['owner', 'editor', 'viewer', 'commenter'] as const)
  for (const initial of ['list', 'board'] as const)
    test(`${role} switches ${initial} through folder settings without gaining management permissions or writing`, async ({
      page,
    }) => {
      const api = await mockPropertyBoard(page, { role });
      await page.setViewportSize({ width: initial === 'list' ? 390 : 1280, height: 844 });
      const initialUrl = initial === 'board' ? boardUrl : `/folders/${browserFixture.folder.id}`;
      await page.goto(initialUrl);
      await expect(
        page.getByRole('main').getByRole('heading', { level: 2, name: browserFixture.folder.title, exact: true })
      ).toBeVisible();
      await expect(page.getByRole('button', { name: /^Switch to (list|board)$/ })).toHaveCount(0);
      const trigger = page
        .getByRole('main')
        .getByRole('button', { name: `Actions for ${browserFixture.folder.title}`, exact: true });
      await trigger.focus();
      await page.keyboard.press('Enter');
      const views = page.getByRole('button', { name: /^Switch to (list|board)$/ });
      await expect(views).toBeVisible();
      await expect(views).toHaveCount(1);
      const next = initial === 'list' ? 'board' : 'list';
      await expect(views).toHaveText(`Switch to ${next}`);
      await expect(page.getByRole('button', { name: `Switch to ${initial}`, exact: true })).toHaveCount(0);
      await expect(page.getByRole('link', { name: /^(List|Board)$/ })).toHaveCount(0);
      for (const name of ['Settings', 'Share', 'Rename', 'Move'])
        await expect(views.locator('..').getByRole('button', { name, exact: true })).toHaveCount(
          role === 'owner' ? 1 : 0
        );
      if (role === 'viewer' || role === 'commenter')
        await expect(views.locator('..').getByRole('button')).toHaveCount(1);
      await page.screenshot({ path: test.info().outputPath('folder-view-settings.png') });
      await page.keyboard.press('Escape');
      await expect(views).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await trigger.click();
      await views.focus();
      await page.keyboard.press('Enter');
      await expect(views).toHaveCount(0);
      await expect(page).toHaveURL(initial === 'list' ? boardUrl : `/folders/${browserFixture.folder.id}`);
      await page.goBack();
      await expect(page).toHaveURL(initialUrl);
      await page.goForward();
      await expect(page).toHaveURL(initial === 'list' ? boardUrl : `/folders/${browserFixture.folder.id}`);
      expect(api.requests.filter((request) => request.method !== 'GET')).toEqual([]);
    });

test('read-only linked cards preserve List/Board navigation and folder scope without note reads or writes', async ({
  page,
}) => {
  const api = await mockPropertyBoard(page);
  await page.goto(boardUrl);
  const board = boardRegion(page);
  await expect(board.getByRole('link', { name: browserFixture.canvas.title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Subfolders · 1', exact: true }).click();
  await expect(
    page.getByRole('navigation', { name: 'Subfolder results' }).getByRole('link', { name: 'Child folder' })
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await switchFolderView(page, 'List');
  await expect(board).toHaveCount(0);
  await switchFolderView(page, 'Board');
  await expect(board).toBeVisible();
  await page.goBack();
  await expect(board).toHaveCount(0);
  await page.goForward();
  await expect(board).toBeVisible();
  expect(api.requests.filter((r) => r.method !== 'GET')).toEqual([]);
  expect(
    api.requests.some((r) => new RegExp(`/internal/notes/${browserFixture.source.id}(?:/properties)?$`).test(r.path))
  ).toBe(false);
});
for (const role of ['viewer', 'commenter', 'editor'] as const)
  test(`${role} sees property cards but no settings or move controls`, async ({ page }) => {
    const api = await mockPropertyBoard(page, { role });
    await page.goto(boardUrl);
    await expect(boardRegion(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Board settings', exact: true })).toHaveCount(0);
    await expect(boardRegion(page).locator('[draggable="true"]')).toHaveCount(0);
    expect(api.requests.filter((r) => r.method !== 'GET')).toEqual([]);
  });
for (const legacy of ['tags', 'filtered'] as const)
  for (const width of [390, 1280])
    for (const theme of ['catppuccin-latte', 'catppuccin-mocha'])
      test(`legacy ${legacy} recovery at ${width}px in ${theme}: explicit save only`, async ({ page }) => {
        await page.setViewportSize({ width, height: 844 });
        await page.addInitScript((theme) => localStorage.setItem('notes-theme', theme), theme);
        const api = await mockPropertyBoard(page, { legacy });
        await page.goto(boardUrl);
        await expect(boardRegion(page)).toHaveCount(0);
        await expect(page.getByRole('alert')).toContainText('retired tag settings');
        const trigger = page.getByRole('button', { name: 'Board settings', exact: true });
        await trigger.click();
        const dialog = page.getByRole('dialog', { name: 'Board settings' });
        await expect(dialog.getByRole('alert')).toContainText('Note tags will not change');
        await expect(dialog.getByLabel('Columns', { exact: true })).toBeEnabled();
        expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: test.info().outputPath('legacy-recovery.png') });
        if (legacy === 'tags') {
          await expect(dialog.getByRole('button', { name: 'Save board' })).toBeDisabled();
          await dialog.getByLabel('Columns', { exact: true }).selectOption('workflow_field');
        }
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(dialog).toHaveCount(0);
        expect(api.writes).toEqual([]);
        await trigger.click();
        await expect(dialog.getByLabel('Columns', { exact: true })).toBeEnabled();
        await dialog.getByLabel('Columns', { exact: true }).selectOption('workflow_field');
        await dialog.getByRole('button', { name: 'Save board' }).click();
        await expect(dialog).toHaveCount(0);
        await expect(boardRegion(page)).toBeVisible();
        expect(api.writes).toHaveLength(1);
        expect(api.writes[0]).toMatchObject({ expectedVersion: 1, schemaRevision: 1, config: { schemaVersion: 5 } });
        expect(Object.keys(api.writes[0].config).sort()).toEqual([
          'cardPropertyIds',
          'columnVisibility',
          'enabled',
          'grouping',
          'mode',
          'schemaVersion',
        ]);
      });
test('legacy recovery is owner-only and never reads lanes for viewers', async ({ page }) => {
  const api = await mockPropertyBoard(page, { legacy: 'filtered', role: 'viewer' });
  await page.goto(boardUrl);
  await expect(page.getByRole('alert')).toContainText('owner');
  await expect(boardRegion(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Board settings' })).toHaveCount(0);
  expect(api.laneRequests).toEqual([]);
  expect(api.writes).toEqual([]);
});
test('an equivalent unfiltered legacy property board needs no write', async ({ page }) => {
  const api = await mockPropertyBoard(page, { legacy: 'unfiltered' });
  await page.goto(boardUrl);
  await expect(boardRegion(page)).toBeVisible();
  expect(api.writes).toEqual([]);
});
test('absent boards require explicit property selection and save; disabling does not change notes', async ({
  page,
}) => {
  const api = await mockPropertyBoard(page, { absent: true });
  await page.goto(boardUrl);
  await expect(boardRegion(page)).toHaveCount(0);
  const trigger = page.getByRole('button', { name: 'Board settings' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Board settings' });
  await expect(dialog.getByLabel('Columns', { exact: true })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Save board' })).toBeDisabled();
  await dialog.getByLabel('Columns', { exact: true }).selectOption('workflow_field');
  await dialog.getByRole('button', { name: 'Save board' }).click();
  await expect(boardRegion(page)).toBeVisible();
  expect(api.writes[0]).toMatchObject({ expectedVersion: 0, config: { schemaVersion: 5 } });
  await trigger.click();
  await dialog.getByLabel('Enabled').uncheck();
  await dialog.getByRole('button', { name: 'Save board' }).click();
  await expect(boardRegion(page)).toHaveCount(0);
  expect(api.writes[1]).toMatchObject({ expectedVersion: 1, config: { enabled: false } });
  expect(api.requests.filter((r) => r.method !== 'GET').every((r) => r.path.endsWith('/board/config'))).toBe(true);
});

for (const mode of ['all', 'selected'] as const)
  for (const showUnclassified of [false, true])
    test(`owner saves ${mode} columns / Unclassified ${showUnclassified} and reopens the same choices`, async ({
      page,
    }) => {
      const api = await mockPropertyBoard(page);
      if (mode === 'all') api.setColumnVisibility({ mode, showUnclassified });
      await page.goto(boardUrl);
      const trigger = page.getByRole('button', { name: 'Board settings', exact: true });
      const dialog = page.getByRole('dialog', { name: 'Board settings', exact: true });
      await trigger.click();
      await dialog.getByRole('checkbox', { name: 'Ready (grouping option)', exact: true }).uncheck();
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
      expect(api.writes).toEqual([]);
      await trigger.click();
      await expect(dialog.getByRole('radio')).toHaveCount(0);
      const ready = dialog.getByRole('checkbox', { name: 'Ready (grouping option)', exact: true });
      await expect(ready).toBeChecked();
      await expect(ready).toBeEnabled();
      if (mode === 'selected') {
        await dialog.getByRole('checkbox', { name: 'Finished (grouping option)', exact: true }).focus();
        await page.keyboard.press('Space');
        await dialog.getByRole('checkbox', { name: 'Empty (grouping option)', exact: true }).uncheck();
      }
      const unclassified = dialog.getByRole('checkbox', {
        name: 'Unclassified',
        exact: true,
      });
      await unclassified.setChecked(showUnclassified);
      expect(api.writes).toEqual([]);
      await dialog.getByRole('button', { name: 'Save board', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      const columnVisibility =
        mode === 'all' ? { mode, showUnclassified } : { mode, optionIds: ['Option_Todo'], showUnclassified };
      expect(api.writes).toHaveLength(1);
      expect(api.writes[0]).toMatchObject({
        expectedVersion: 1,
        schemaId: 'schema_board',
        schemaRevision: 1,
        config: { columnVisibility, cardPropertyIds: ['type_field'] },
      });
      expect(api.writes[0].config.columnVisibility).toEqual(columnVisibility);
      await trigger.click();
      await expect(dialog.getByRole('radio')).toHaveCount(0);
      await expect(unclassified).toBeChecked({ checked: showUnclassified });
      await expect(ready).toBeChecked();
      await expect(dialog.getByRole('checkbox', { name: 'Finished (grouping option)', exact: true })).toBeChecked({
        checked: mode === 'all',
      });
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      expect(api.writes).toHaveLength(1);
    });

test('checkboxes support zero columns and Unclassified-only without reset or count summaries', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  await page.goto(boardUrl);
  const trigger = page.getByRole('button', { name: 'Board settings', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Board settings', exact: true });
  await trigger.click();
  await expect(dialog.getByRole('status')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Reset to all columns', exact: true })).toHaveCount(0);
  for (const label of ['Ready', 'Finished', 'Empty'])
    await dialog.getByRole('checkbox', { name: `${label} (grouping option)`, exact: true }).uncheck();
  const unclassified = dialog.getByRole('checkbox', { name: 'Unclassified', exact: true });
  await unclassified.uncheck();
  await expect(dialog.getByRole('status')).toHaveText('No columns selected — this Board will show no cards.');
  await dialog.getByRole('button', { name: 'Save board', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(api.writes[0].config.columnVisibility).toEqual({ mode: 'selected', optionIds: [], showUnclassified: false });
  await trigger.click();
  await expect(dialog.getByRole('status')).toHaveText('No columns selected — this Board will show no cards.');
  await unclassified.check();
  await expect(unclassified).toBeChecked();
  await expect(dialog.getByRole('status')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Save board', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(api.writes[1].config.columnVisibility).toEqual({ mode: 'selected', optionIds: [], showUnclassified: true });
});

test('rechecking every option stays Selected and future options remain unchecked without a reset action', async ({
  page,
}) => {
  const api = await mockPropertyBoard(page);
  await page.goto(boardUrl);
  const trigger = page.getByRole('button', { name: 'Board settings', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Board settings', exact: true });
  await trigger.click();
  const option = dialog.getByRole('checkbox', { name: 'Empty (grouping option)', exact: true });
  await option.uncheck();
  await option.check();
  await dialog.getByRole('button', { name: 'Save board', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(api.writes[0].config.columnVisibility).toEqual({
    mode: 'selected',
    optionIds: ['Option_Todo', 'Option_Done', 'Option_Empty'],
    showUnclassified: true,
  });
  api.field.options.push({ id: 'Option_New', label: 'New option', archived: false });
  api.changeSchema();
  await page.getByRole('button', { name: 'Refresh board', exact: true }).click();
  await trigger.click();
  await expect(dialog.getByRole('checkbox', { name: 'New option (grouping option)', exact: true })).not.toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Reset to all columns', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('status')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Save board', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(api.writes[1].config.columnVisibility).toEqual({
    mode: 'selected',
    optionIds: ['Option_Todo', 'Option_Done', 'Option_Empty'],
    showUnclassified: true,
  });
  expect(api.writes).toHaveLength(2);
});

test('changing grouping and switching back discards unrelated real-option selections but keeps Unclassified intent', async ({
  page,
}) => {
  const api = await mockPropertyBoard(page);
  api.setColumnVisibility({ mode: 'selected', optionIds: ['Option_Todo'], showUnclassified: false });
  await page.goto(boardUrl);
  await page.getByRole('button', { name: 'Board settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Board settings', exact: true });
  const grouping = dialog.getByLabel('Columns', { exact: true });
  await expect(grouping).toBeEnabled();
  await grouping.selectOption('type_field');
  await expect(dialog.getByRole('radio')).toHaveCount(0);
  await expect(
    dialog.getByText('Grouping changed. Review the fresh column selection before saving.', { exact: true })
  ).toBeVisible();
  for (const label of ['Bug', 'Feature', 'Task'])
    await expect(dialog.getByRole('checkbox', { name: `${label} (grouping option)`, exact: true })).not.toBeChecked();
  await dialog.getByRole('checkbox', { name: 'Bug (grouping option)', exact: true }).check();
  await grouping.selectOption('workflow_field');
  await expect(dialog.getByRole('checkbox', { name: 'Ready (grouping option)', exact: true })).not.toBeChecked();
  await grouping.selectOption('type_field');
  await expect(dialog.getByRole('checkbox', { name: 'Bug (grouping option)', exact: true })).not.toBeChecked();
  await dialog.getByRole('checkbox', { name: 'Feature (grouping option)', exact: true }).check();
  await expect(dialog.getByRole('checkbox', { name: 'Unclassified', exact: true })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Save board', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(api.writes[0].config).toMatchObject({
    grouping: { propertyId: 'type_field' },
    columnVisibility: { mode: 'selected', optionIds: ['Type_Feature'], showUnclassified: false },
    cardPropertyIds: ['type_field'],
  });
});

test('unavailable column rows retain focus and undo until dismissal, with no silent removal', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  api.setColumnVisibility({ mode: 'selected', optionIds: ['Option_Todo', 'Option_Missing'], showUnclassified: false });
  api.field.options[0].archived = true;
  api.changeSchema();
  await page.goto(boardUrl);
  await page.getByRole('button', { name: 'Board settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Board settings', exact: true });
  const archived = dialog.getByRole('checkbox', { name: 'Ready (unavailable grouping option)', exact: true });
  const unknown = dialog.getByRole('checkbox', {
    name: 'Column Option_Missing (unavailable grouping option)',
    exact: true,
  });
  await expect(archived).toBeChecked();
  await expect(unknown).toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Save board', exact: true })).toBeDisabled();
  await archived.focus();
  await page.keyboard.press('Space');
  await expect(archived).toBeFocused();
  await expect(archived).not.toBeChecked();
  await page.keyboard.press('Space');
  await expect(archived).toBeChecked();
  await archived.uncheck();
  await unknown.uncheck();
  await expect(unknown).toBeAttached();
  await expect(dialog.getByRole('button', { name: 'Save board', exact: true })).toBeEnabled();
  expect(api.writes).toEqual([]);
  await dialog.getByRole('button', { name: 'Save board', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(api.writes[0].config.columnVisibility).toEqual({ mode: 'selected', optionIds: [], showUnclassified: false });
});

test('an unavailable column can be disabled or deliberately removed without a reset shortcut', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  api.setColumnVisibility({ mode: 'selected', optionIds: ['Option_Missing'], showUnclassified: false });
  await page.goto(boardUrl);
  const trigger = page.getByRole('button', { name: 'Board settings', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Board settings', exact: true });
  await trigger.click();
  await expect(dialog.getByRole('button', { name: 'Save board', exact: true })).toBeDisabled();
  await dialog.getByLabel('Enabled', { exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Save board', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(api.writes[0].config).toMatchObject({
    enabled: false,
    columnVisibility: { mode: 'selected', optionIds: ['Option_Missing'], showUnclassified: false },
  });
  await trigger.click();
  await dialog.getByLabel('Enabled', { exact: true }).check();
  await expect(dialog.getByRole('button', { name: 'Save board', exact: true })).toBeDisabled();
  await dialog
    .getByRole('checkbox', { name: 'Column Option_Missing (unavailable grouping option)', exact: true })
    .uncheck();
  for (const label of ['Ready', 'Finished', 'Empty'])
    await dialog.getByRole('checkbox', { name: `${label} (grouping option)`, exact: true }).check();
  await dialog.getByRole('button', { name: 'Save board', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(api.writes[1].config).toMatchObject({
    enabled: true,
    columnVisibility: {
      mode: 'selected',
      optionIds: ['Option_Todo', 'Option_Done', 'Option_Empty'],
      showUnclassified: false,
    },
  });
});

for (const width of [390, 1280])
  for (const theme of ['catppuccin-latte', 'catppuccin-mocha'])
    test(`real Unclassified and synthetic choice remain distinct by keyboard at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.addInitScript((value) => localStorage.setItem('notes-theme', value), theme);
      const api = await mockPropertyBoard(page);
      api.field.options[0].label = 'A'.repeat(80);
      api.field.options[2].label = 'Unclassified';
      await page.goto(boardUrl);
      await page.getByRole('button', { name: 'Board settings', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Board settings', exact: true });
      const real = dialog.getByRole('checkbox', { name: 'Unclassified (grouping option)', exact: true });
      const synthetic = dialog.getByRole('checkbox', { name: 'Unclassified', exact: true });
      await real.focus();
      await page.keyboard.press('Space');
      await expect(real).not.toBeChecked();
      await expect(synthetic).toBeChecked();
      await synthetic.focus();
      await page.keyboard.press('Space');
      await expect(synthetic).not.toBeChecked();
      await expect(real).not.toBeChecked();
      expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath('visible-column-settings.png') });
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: 'Board settings', exact: true })).toBeFocused();
      expect(api.writes).toEqual([]);
    });

test('save failures keep choices and old tokens; conflicts require a complete explicit review before retry', async ({
  page,
}) => {
  const api = await mockPropertyBoard(page);
  api.setColumnVisibility({ mode: 'selected', optionIds: ['Option_Todo', 'Option_Done'], showUnclassified: false });
  await page.goto(boardUrl);
  await page.getByRole('button', { name: 'Board settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Board settings', exact: true });
  const save = dialog.getByRole('button', { name: 'Save board', exact: true });
  const review = dialog.getByRole('button', { name: 'Refresh and review', exact: true });
  const unclassified = dialog.getByRole('checkbox', { name: 'Unclassified', exact: true });
  await unclassified.check();
  api.controls.saveFailure = 500;
  await save.click();
  await expect(dialog.getByRole('alert')).toContainText('Save failed');
  expect(api.writes).toHaveLength(1);
  await expect(unclassified).toBeChecked();
  api.field.options[0].label = 'Renamed';
  api.field.options[1].archived = true;
  api.field.options.push({ id: 'Option_New', label: 'New option', archived: false });
  api.changeSchema();
  api.changeConfig();
  await page.locator('button[aria-label="Refresh board"]').evaluate((button: HTMLButtonElement) => button.click());
  await expect(dialog.getByRole('checkbox', { name: 'Ready (grouping option)', exact: true })).toBeChecked();
  api.controls.saveFailure = 0;
  await save.click();
  await expect(dialog.getByRole('alert')).toContainText('Snapshot changed');
  expect(api.writes).toHaveLength(2);
  for (const write of api.writes)
    expect(write).toMatchObject({
      expectedVersion: 1,
      schemaRevision: 1,
      config: {
        columnVisibility: { mode: 'selected', optionIds: ['Option_Todo', 'Option_Done'], showUnclassified: true },
      },
    });
  await expect(save).toBeDisabled();
  await unclassified.focus();
  await page.keyboard.press('Enter');
  expect(api.writes).toHaveLength(2);
  api.controls.schemaFailure = 500;
  await review.click();
  await expect(dialog.getByRole('alert')).toContainText('Schema read failed');
  await expect(save).toBeDisabled();
  await expect(dialog.getByRole('checkbox', { name: 'Ready (grouping option)', exact: true })).toBeChecked();
  expect(api.writes).toHaveLength(2);
  api.controls.schemaFailure = 0;
  await review.click();
  const archived = dialog.getByRole('checkbox', { name: 'Finished (unavailable grouping option)', exact: true });
  await expect(archived).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Renamed (grouping option)', exact: true })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'New option (grouping option)', exact: true })).not.toBeChecked();
  await expect(unclassified).toBeChecked();
  await expect(save).toBeDisabled();
  await archived.uncheck();
  await save.click();
  await expect(dialog).toHaveCount(0);
  expect(api.writes).toHaveLength(3);
  expect(api.writes[2]).toMatchObject({
    expectedVersion: 2,
    schemaRevision: 2,
    config: { columnVisibility: { mode: 'selected', optionIds: ['Option_Todo'], showUnclassified: true } },
  });
});

test('failed initial definitions do not imply empty columns or prevent explicit disabled recovery', async ({
  page,
}) => {
  const api = await mockPropertyBoard(page);
  api.setColumnVisibility({ mode: 'selected', optionIds: ['Option_Todo'], showUnclassified: false });
  api.controls.schemaFailure = 500;
  const schemaRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/properties')) schemaRequests.push(request.url());
  });
  await page.goto(boardUrl);
  await page.getByRole('button', { name: 'Board settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Board settings', exact: true });
  await expect(dialog.getByRole('alert')).toContainText('Schema read failed');
  await expect(dialog.getByRole('status')).toHaveText('Column definitions could not be loaded.');
  await expect(dialog.getByRole('button', { name: 'Save board', exact: true })).toBeDisabled();
  await expect(dialog.getByText('No columns selected — this Board will show no cards.', { exact: true })).toHaveCount(
    0
  );
  await dialog.getByLabel('Enabled', { exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Save board', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(schemaRequests).toHaveLength(1);
  expect(api.writes).toHaveLength(1);
  expect(api.writes[0].schemaId).toBeUndefined();
  expect(api.writes[0].config).toMatchObject({
    enabled: false,
    columnVisibility: { mode: 'selected', optionIds: ['Option_Todo'], showUnclassified: false },
  });
});

test('a late definitions response from a dismissed opening cannot overwrite the reopened draft', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  const oldSchema = structuredClone(api.schema);
  let release = () => {},
    reached = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let reads = 0;
  await page.route('**/internal/folders/*/properties', async (route) => {
    if (++reads !== 1) return route.fallback();
    reached();
    await held;
    await route.fulfill({ json: oldSchema });
  });
  await page.goto(boardUrl);
  const trigger = page.getByRole('button', { name: 'Board settings', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Board settings', exact: true });
  try {
    await trigger.click();
    await started;
    await expect(dialog.getByRole('button', { name: 'Save board', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    api.field.options[0].label = 'Current';
    api.changeSchema();
    await trigger.click();
    await dialog.getByRole('checkbox', { name: 'Current (grouping option)', exact: true }).uncheck();
    const response = page.waitForResponse('**/internal/folders/*/properties');
    release();
    await (await response).finished();
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    );
    await expect(dialog.getByRole('checkbox', { name: 'Current (grouping option)', exact: true })).not.toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: 'Ready (grouping option)', exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Save board', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(api.writes[0]).toMatchObject({
      schemaRevision: 2,
      config: {
        columnVisibility: { mode: 'selected', optionIds: ['Option_Done', 'Option_Empty'], showUnclassified: true },
      },
    });
  } finally {
    release();
  }
});

test('a late explicit review cannot upgrade or downgrade tokens in a subsequent opening', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  await page.goto(boardUrl);
  const trigger = page.getByRole('button', { name: 'Board settings', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Board settings', exact: true });
  await trigger.click();
  await expect(dialog.getByLabel('Columns', { exact: true })).toBeEnabled();
  api.changeSchema();
  api.changeConfig();
  await dialog.getByRole('button', { name: 'Save board', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Snapshot changed');
  let release = () => {},
    reached = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let reads = 0;
  await page.route('**/internal/folders/*/board/config', async (route) => {
    if (route.request().method() !== 'GET' || ++reads !== 1) return route.fallback();
    const oldBoard = structuredClone(api.snapshot());
    reached();
    await held;
    await route.fulfill({ json: { board: oldBoard } });
  });
  try {
    await dialog.getByRole('button', { name: 'Refresh and review', exact: true }).click();
    await started;
    await page.keyboard.press('Escape');
    api.field.options[0].label = 'Newest';
    api.changeSchema();
    api.changeConfig();
    const current = page.waitForResponse('**/internal/folders/*/board/config');
    await page.getByRole('button', { name: 'Refresh board', exact: true }).click();
    await current;
    await trigger.click();
    await dialog.getByRole('checkbox', { name: 'Unclassified', exact: true }).uncheck();
    const oldResponse = page.waitForResponse('**/internal/folders/*/board/config');
    release();
    await (await oldResponse).finished();
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    );
    await expect(dialog.getByRole('checkbox', { name: 'Newest (grouping option)', exact: true })).toBeChecked();
    await dialog.getByRole('button', { name: 'Save board', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(api.writes).toHaveLength(2);
    expect(api.writes[1]).toMatchObject({
      expectedVersion: 3,
      schemaRevision: 3,
      config: {
        columnVisibility: {
          mode: 'selected',
          optionIds: ['Option_Todo', 'Option_Done', 'Option_Empty'],
          showUnclassified: false,
        },
      },
    });
  } finally {
    release();
  }
});

const visibilityCases: ColumnVisibility[] = [
  { mode: 'all', showUnclassified: false },
  { mode: 'selected', optionIds: ['Option_Todo'], showUnclassified: true },
  { mode: 'selected', optionIds: [], showUnclassified: false },
];
for (const columnVisibility of visibilityCases)
  test(`settings save preserves v5 visibility ${JSON.stringify(columnVisibility)}`, async ({ page }) => {
    const api = await mockPropertyBoard(page);
    api.setColumnVisibility(columnVisibility);
    await page.goto(boardUrl);
    await page.getByRole('button', { name: 'Board settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Board settings' });
    await expect(dialog.getByLabel('Columns', { exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(api.writes).toEqual([]);
    await page.getByRole('button', { name: 'Board settings', exact: true }).click();
    await expect(dialog.getByLabel('Columns', { exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Save board' }).click();
    await expect(dialog).toHaveCount(0);
    expect(api.writes[0].config).toMatchObject({ schemaVersion: 5, columnVisibility });
    expect(api.snapshot().config.columnVisibility).toEqual(columnVisibility);
  });
test('a conflicted settings draft retains its visibility through explicit refresh and review', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  const columnVisibility: ColumnVisibility = { mode: 'selected', optionIds: ['Option_Todo'], showUnclassified: false };
  api.setColumnVisibility(columnVisibility);
  await page.goto(boardUrl);
  await page.getByRole('button', { name: 'Board settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Board settings' });
  await expect(dialog.getByLabel('Columns', { exact: true })).toBeEnabled();
  api.setColumnVisibility({ mode: 'all', showUnclassified: true });
  api.changeConfig();
  await dialog.getByRole('button', { name: 'Save board' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Your draft has been kept');
  expect(api.writes[0]).toMatchObject({ expectedVersion: 1, config: { columnVisibility } });
  await dialog.getByRole('button', { name: 'Refresh and review' }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Save board' }).click();
  await expect(dialog).toHaveCount(0);
  expect(api.writes[1]).toMatchObject({ expectedVersion: 2, config: { schemaVersion: 5, columnVisibility } });
});

test('initial read shows loading, fails without empty-column claims and supports explicit retry', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  api.controls.readFailure = 500;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/internal/folders/*/board/config', async (route) => {
    await held;
    await route.fallback();
  });
  try {
    await page.goto(boardUrl);
    await expect(page.getByRole('status').filter({ hasText: 'Loading board' })).toBeVisible();
    await expect(page.getByText('No notes in this lane.')).toHaveCount(0);
  } finally {
    release();
  }
  const retry = page.getByRole('button', { name: 'Retry board', exact: true });
  await expect(retry).toBeVisible();
  await expect(boardRegion(page)).toHaveCount(0);
  api.controls.readFailure = 0;
  await retry.click();
  await expect(boardRegion(page)).toBeVisible();
  expect(api.writes).toEqual([]);
});
test('transient configuration failures retain cards and an open settings draft without writes', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  await page.goto(boardUrl);
  await expect(boardRegion(page)).toBeVisible();
  await page.getByRole('button', { name: 'Board settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Board settings' });
  await dialog.getByRole('checkbox', { name: /^(Type|Kind|Category)( select| \(unavailable\))$/ }).uncheck();
  api.controls.readFailure = 500;
  await page.locator('button[aria-label="Refresh board"]').evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.getByText(/Last configuration read failed/)).toBeAttached();
  await expect(
    dialog.getByRole('checkbox', { name: /^(Type|Kind|Category)( select| \(unavailable\))$/ })
  ).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(boardRegion(page)).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('may be stale');
  api.controls.readFailure = 0;
  await page.getByRole('button', { name: 'Retry board' }).click();
  await expect(page.getByText(/Last configuration read failed/)).toHaveCount(0);
  expect(api.writes).toEqual([]);
});

test('inline counts distinguish unknown and successful empty, then partial and exhausted unique cards with passive accessible tooltips', async ({
  page,
}) => {
  const api = await mockPropertyBoard(page, { extraCards: 30 });
  let reached = () => {},
    release = () => {};
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/board?*', async (route) => {
    if (new URL(route.request().url()).searchParams.get('lane') === 'Option_Todo') {
      reached();
      await held;
    }
    await route.fallback(); // Existing schema/page validators and actual synthetic cards remain authoritative.
  });
  const ready = page.getByRole('region', { name: 'Ready', exact: true });
  try {
    await page.goto(boardUrl);
    await started;
    await expect(ready.getByRole('status')).toHaveText('Loading…');
    await expect(ready.getByRole('heading', { level: 3 })).toHaveText('Ready');
    await expect(ready.getByRole('note', { name: /cards? loaded/ })).toHaveCount(0);
    await expectLoaded(page.getByRole('region', { name: 'Empty', exact: true }), 0, false);
  } finally {
    release();
  }
  const count = await expectLoaded(ready, 25, true);
  await expect(ready.getByRole('link')).toHaveCount(25);
  await expect(boardRegion(page).getByRole('status')).toHaveCount(0);
  const before = structuredClone(api.requests);
  expect(await count.evaluate((element) => element.tagName)).toBe('SPAN');
  await expect(ready.getByRole('button', { name: /cards? loaded/ })).toHaveCount(0);
  await count.hover();
  await expect(page.getByRole('tooltip')).toHaveText('25 cards loaded. More available.');
  await page.mouse.move(0, 0);
  await count.focus();
  await expect(count).toBeFocused();
  await expect(page.getByRole('tooltip')).toHaveText('25 cards loaded. More available.');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  expect(api.requests).toEqual(before);
  await ready.getByRole('button', { name: 'Load more Ready', exact: true }).click();
  await expectLoaded(ready, 31, false);
  await expect(ready.getByRole('link')).toHaveCount(31);
  await expect(ready.getByRole('button', { name: 'Load more Ready', exact: true })).toHaveCount(0);
  const visibleHeader = await ready
    .locator(':scope > header')
    .evaluate((header) =>
      [...header.children]
        .filter((el) => getComputedStyle(el).position !== 'absolute')
        .map((el) => ({ y: el.getBoundingClientRect().y, height: el.getBoundingClientRect().height }))
    );
  expect(visibleHeader).toHaveLength(2);
  expect(
    Math.abs(visibleHeader[0].y + visibleHeader[0].height / 2 - (visibleHeader[1].y + visibleHeader[1].height / 2))
  ).toBeLessThanOrEqual(1);
  expect(api.requests.filter((r) => r.method !== 'GET')).toEqual([]);
});

test('initial lane failure never invents zero; successful recovery alone restores inline empty and loaded counts', async ({
  page,
}) => {
  const api = await mockPropertyBoard(page);
  api.controls.laneFailure = 500;
  await page.goto(boardUrl);
  const ready = page.getByRole('region', { name: 'Ready', exact: true });
  await expect(ready.getByRole('alert')).toContainText('Last read failed');
  await expect(boardRegion(page).getByRole('note', { name: /cards? loaded/ })).toHaveCount(0);
  await expect(boardRegion(page).getByText('No notes in this lane.', { exact: true })).toHaveCount(0);
  api.controls.laneFailure = 0;
  await page.getByRole('button', { name: 'Refresh board', exact: true }).click();
  await expectLoaded(ready, 1, false);
  await expectLoaded(page.getByRole('region', { name: 'Empty', exact: true }), 0, false);
  expect(api.writes).toEqual([]);
});

test('failed next page retains real cards but suppresses stale numeric count; retry and revocation preserve existing recovery/privacy', async ({
  page,
}) => {
  const api = await mockPropertyBoard(page, { extraCards: 30 });
  await page.goto(boardUrl);
  const ready = page.getByRole('region', { name: 'Ready', exact: true });
  await expectLoaded(ready, 25, true);
  api.controls.laneFailure = 500;
  await ready.getByRole('button', { name: 'Load more Ready', exact: true }).click();
  await expect(ready.getByRole('alert')).toContainText('may be stale');
  await expect(ready.getByRole('link')).toHaveCount(25);
  await expect(ready.getByRole('note', { name: /cards? loaded/ })).toHaveCount(0);
  api.controls.laneFailure = 0;
  await ready.getByRole('button', { name: 'Retry lane', exact: true }).click();
  await expectLoaded(ready, 25, true);
  api.controls.laneFailure = 404;
  await ready.getByRole('button', { name: 'Load more Ready', exact: true }).click();
  await expect(boardRegion(page)).toHaveCount(0);
  await expect(page.getByRole('note', { name: /cards? loaded/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Board settings', exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('Board unavailable');
  expect(api.writes).toEqual([]);
});

test('long full status label truncates visually without wrapping its count or changing accessible names', async ({
  page,
}) => {
  const api = await mockPropertyBoard(page, { extraCards: 30 });
  const label = 'A status with an unusually long name that must leave room for its loaded count';
  api.field.options[0].label = label;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(boardUrl);
  const lane = page.getByRole('region', { name: label, exact: true });
  const count = await expectLoaded(lane, 25, true);
  const heading = lane.getByRole('heading', { name: label, exact: true });
  await expect(heading).toHaveAttribute('title', label);
  await expect(count).toHaveCSS('white-space', 'nowrap');
  expect(await heading.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  const a = await heading.boundingBox(),
    b = await count.boundingBox();
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  expect(Math.abs((a?.y ?? 0) + (a?.height ?? 0) / 2 - (b?.y ?? 0) - (b?.height ?? 0) / 2)).toBeLessThanOrEqual(1);
  await expectRemainingHeight(page);
  expect(api.writes).toEqual([]);
});

for (const width of [390, 1280])
  for (const theme of ['catppuccin-latte', 'catppuccin-mocha'])
    test(`remaining height, tall and live resize with wrapped header in ${theme} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.addInitScript((value) => localStorage.setItem('notes-theme', value), theme);
      const api = await mockPropertyBoard(page, { extraCards: 150 });
      api.folders[0].title =
        'Project with a deliberately long folder title that wraps naturally without any hardcoded board header offset';
      await page.goto(boardUrl);
      const ready = page.getByRole('region', { name: 'Ready', exact: true });
      await expectLoaded(ready, 25, true);
      await expect(boardRegion(page).getByRole('status')).toHaveCount(0);
      const before = structuredClone(api.requests);
      const footer = ready.getByRole('button', { name: 'Load more Ready', exact: true });
      const cards = ready.getByRole('region', { name: 'Ready cards', exact: true });
      for (const height of [844, 1440, 600]) {
        await page.setViewportSize({ width, height });
        await expectRemainingHeight(page);
        await expect(footer).toBeInViewport();
        if (height === 1440) expect((await boardRegion(page).boundingBox())?.height).toBeGreaterThan(704);
        const headerBefore = await ready.locator(':scope > header').boundingBox();
        const footerBefore = await footer.boundingBox();
        await cards.hover();
        await page.mouse.wheel(0, 100);
        await expect.poll(() => cards.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
        const oldScroll = await cards.evaluate((el) => el.scrollTop);
        await cards.focus();
        await page.keyboard.press('ArrowDown');
        await expect.poll(() => cards.evaluate((el) => el.scrollTop)).toBeGreaterThan(oldScroll);
        expect(await ready.locator(':scope > header').boundingBox()).toEqual(headerBefore);
        expect(await footer.boundingBox()).toEqual(footerBefore);
        expect(await page.getByRole('main').evaluate((el) => el.scrollTop)).toBe(0);
        expect(
          await page.getByRole('region', { name: 'Finished cards', exact: true }).evaluate((el) => el.scrollTop)
        ).toBe(0);
        await page.screenshot({ path: test.info().outputPath(`height-count-${theme}-${width}-${height}.png`) });
      }
      // Exceptionally short: use the EXISTING outer scroller rather than clipping fixed controls.
      await page.setViewportSize({ width, height: 260 });
      expect(await page.getByRole('main').evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
      await footer.scrollIntoViewIfNeeded();
      await expect(footer).toBeInViewport();
      await page.screenshot({ path: test.info().outputPath(`height-count-${theme}-${width}-short.png`) });
      const newOptions = page.getByRole('button', { name: 'Open new options', exact: true });
      await newOptions.scrollIntoViewIfNeeded();
      await newOptions.click();
      await expect(page.getByRole('button', { name: 'Canvas', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width, height: 844 });
      await page.getByRole('main').evaluate((el) => {
        el.scrollTop = 0;
      });
      await expectRemainingHeight(page);
      await page.getByRole('button', { name: 'Subfolders · 1', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Subfolders', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      expect(api.requests).toEqual(before); // Resize/scroll/count/subfolder/New-menu interactions never refetch the board.
      await page.getByRole('button', { name: 'Board settings', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Board settings', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(api.requests.slice(before.length)).toEqual([
        { path: `/internal/folders/${browserFixture.folder.id}/properties`, method: 'GET' },
      ]);
      expect(api.requests.filter((r) => r.method !== 'GET')).toEqual([]);
      await switchFolderView(page, 'List');
      if (width >= 768) await expect(page.getByRole('table')).toBeVisible();
      const sourceLink = page.getByRole('main').getByRole('link', { name: /^Source Note(?: |$)/ });
      await expect(sourceLink).toBeVisible();
      await expect(sourceLink).toHaveAttribute('href', `/notes/${browserFixture.source.id}`);
      await expect(
        page.getByRole('main').getByRole('checkbox', { name: 'Select Source Note', exact: true })
      ).toBeVisible();
      await expect(boardRegion(page)).toHaveCount(0);
    });
