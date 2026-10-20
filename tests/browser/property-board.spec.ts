import { expect, type Locator, type Page, test } from '@playwright/test';
import { browserFixture } from './fixtures';
import { mockPropertyBoard } from './property-board-fixtures';

const boardUrl = `/folders/${browserFixture.folder.id}?view=board`;
const region = (page: Parameters<typeof mockPropertyBoard>[0]) =>
  page.getByRole('region', { name: 'Folder board', exact: true });

async function expectLaneCount(lane: Locator, count: number, more: boolean) {
  const description = `${count} ${count === 1 ? 'card' : 'cards'} loaded.${more ? ' More available.' : ''}`;
  const number = lane.getByRole('note', { name: description, exact: true });
  await expect(number).toBeVisible();
  await expect(number).toHaveText(`· ${count}${more ? '+' : ''}`);
  await expect(lane.getByRole('heading', { level: 3 })).toHaveAccessibleDescription(description);
}
async function expectBoardBottom(page: Page) {
  await expect
    .poll(() =>
      region(page).evaluate((grid) => {
        const main = grid.closest('main');
        if (!main) throw new Error('Missing main content');
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
  const bounds = await region(page).evaluate((grid) => {
    const rect = grid.getBoundingClientRect(),
      style = getComputedStyle(grid);
    const border = Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);
    const scrollbar = grid.offsetHeight - grid.clientHeight - border;
    return {
      expected:
        rect.bottom - Number.parseFloat(style.paddingBottom) - Number.parseFloat(style.borderBottomWidth) - scrollbar,
      bottoms: [...grid.children].map((lane) => lane.getBoundingClientRect().bottom),
    };
  });
  for (const bottom of bounds.bottoms) expect(Math.abs(bottom - bounds.expected)).toBeLessThanOrEqual(2);
}

test('Card properties checklist is a local owner draft; save shares ordered previews and Cancel keeps values', async ({
  page,
}) => {
  const api = await mockPropertyBoard(page);
  api.cards[0].displayValues = { text_field: '<b>Plain</b> 😀', date_field: '2028-02-29' };
  await page.goto(boardUrl);
  const card = region(page)
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: browserFixture.source.title, exact: true }) });
  await expect(card.getByRole('definition')).toHaveText(['Bug']);
  const before = structuredClone(api.cards);
  await page.getByRole('button', { name: 'Board settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Board settings' });
  const choices = dialog.getByRole('group', { name: 'Card properties', exact: true }).getByRole('checkbox');
  await expect(choices).toHaveCount(4);
  await expect(choices.nth(1)).not.toBeChecked();
  await choices.nth(2).check();
  await choices.nth(0).check();
  await choices.nth(3).uncheck();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(api.writes).toEqual([]);
  await expect(card.getByRole('definition')).toHaveText(['Bug']);
  await page.getByRole('button', { name: 'Board settings' }).click();
  await expect(choices.nth(0)).not.toBeChecked();
  await expect(choices.nth(3)).toBeChecked();
  await choices.nth(2).check();
  await choices.nth(0).focus();
  await page.keyboard.press('Space');
  await expect(choices.nth(0)).toBeChecked();
  await dialog.getByRole('button', { name: 'Save board' }).click();
  await expect(dialog).toHaveCount(0);
  expect(api.writes[0].config.cardPropertyIds).toEqual(['type_field', 'date_field', 'text_field']);
  await expect(card.getByRole('term')).toHaveText(['Summary:', 'Due date:', 'Type:']);
  await expect(card.getByRole('definition')).toHaveText(['<b>Plain</b> 😀', '2028-02-29', 'Bug']);
  expect(api.cards).toEqual(before);
  expect(api.requests.filter((r) => r.method !== 'GET').every((r) => r.path.endsWith('/board/config'))).toBe(true);
});

for (const width of [390, 1280])
  for (const theme of ['catppuccin-latte', 'catppuccin-mocha'])
    for (const count of [0, 1, 12])
      test(`Card properties ${count} ${width} ${theme}: bounded previews, ordered rows and keyboard checklist`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize({ width, height: 844 });
        await page.addInitScript((value) => localStorage.setItem('notes-theme', value), theme);
        const api = await mockPropertyBoard(page, { extraCards: 30 });
        for (let i = 4; i < 12; i++)
          api.schema.definitions.push({
            id: `extra_field_${i}`,
            label: `Long field ${i} ${'Name'.repeat(14)}`,
            type: 'text',
            archived: false,
            options: [],
          });
        const ids = api.schema.definitions.map((d) => d.id);
        api.setCardProperties(count === 1 ? ['text_field'] : count === 12 ? [...ids].reverse() : []);
        for (const card of api.cards)
          card.displayValues = Object.fromEntries(
            api.schema.definitions
              .filter((d) => d.type !== 'select')
              .map((d) => [d.id, d.type === 'date' ? '2028-02-29' : '😀'.repeat(80) + 'Unbroken'.repeat(40)])
          );
        await page.goto(boardUrl);
        const card = region(page)
          .getByRole('listitem')
          .filter({ has: page.getByRole('link', { name: browserFixture.source.title, exact: true }) });
        await expect(card.getByRole('definition')).toHaveCount(count);
        if (count) {
          const text = card.getByRole('definition').first().locator('span').first();
          expect(Array.from(await text.innerText())).toHaveLength(160);
          const bounds = await text.evaluate((el) => ({
            height: el.getBoundingClientRect().height,
            line: Number.parseFloat(getComputedStyle(el).lineHeight),
            clamp: getComputedStyle(el).webkitLineClamp,
          }));
          expect(bounds.height).toBeLessThanOrEqual(bounds.line * 2 + 1);
          expect(bounds.clamp).toBe('2');
          await expect(card.getByText('Truncated preview', { exact: true })).toHaveCount(count === 12 ? 9 : 1);
        }
        if (count === 12) {
          await expect(card.getByRole('term')).toHaveText(api.schema.definitions.map((d) => `${d.label}:`));
          await expect(card.getByRole('definition').nth(2)).toHaveText('2028-02-29');
        }
        expect(await page.locator('html').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        await expectBoardBottom(page);
        await page.screenshot({ path: testInfo.outputPath('card-properties.png') });
        await page.getByRole('button', { name: 'Board settings' }).click();
        const dialog = page.getByRole('dialog', { name: 'Board settings' });
        await expect(
          dialog.getByRole('group', { name: 'Card properties', exact: true }).getByRole('checkbox')
        ).toHaveCount(12);
        await expect(dialog.getByRole('checkbox', { name: 'Unclassified', exact: true })).toBeChecked();
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).focus();
        await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport();
        await page.screenshot({ path: testInfo.outputPath('card-properties-settings.png') });
        await page.keyboard.press('Escape');
        await expect(page.getByRole('button', { name: 'Board settings' })).toBeFocused();
        expect(api.writes).toEqual([]);
        expect(api.requests.filter((r) => r.method !== 'GET')).toEqual([]);
      });

for (const width of [390, 1280])
  for (const theme of ['catppuccin-latte', 'catppuccin-mocha'])
    for (const longSelect of [false, true])
      test(`ordered property rows ${width} ${theme} long-select-${longSelect}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 844 });
        await page.addInitScript((value) => localStorage.setItem('notes-theme', value), theme);
        const api = await mockPropertyBoard(page, { extraCards: 30 });
        api.setCardProperties(['type_field', 'date_field', 'text_field']);
        if (longSelect) api.typeField.options[0].label = 'Verylongunbrokenselectlabel'.repeat(3);
        api.cards[0].displayValues = { text_field: 'A plain text preview '.repeat(15), date_field: '2028-02-29' };
        const before = structuredClone(api.cards);
        await page.goto(boardUrl);
        const card = region(page)
          .getByRole('listitem')
          .filter({ has: page.getByRole('link', { name: browserFixture.source.title, exact: true }) });
        const definitions = card.getByRole('definition');
        await expect(card.getByRole('term')).toHaveText(['Summary:', 'Due date:', 'Type:']);
        for (const term of await card.getByRole('term').all()) await expect(term).toHaveClass('sr-only');
        await expect(definitions.nth(0).locator('..')).toHaveAttribute('title', 'Summary');
        await expect(definitions.nth(1).locator('..')).toHaveAttribute('title', 'Due date: 2028-02-29');
        await expect(definitions.nth(2).locator('..')).toHaveAttribute(
          'title',
          `Type: ${api.typeField.options[0].label}`
        );
        await expect(definitions.nth(1)).toHaveText('2028-02-29');
        await expect(definitions.nth(2)).toHaveText(api.typeField.options[0].label);
        const geometry = await card.locator('dl').evaluate((dl) => {
          const rows = [...dl.querySelectorAll('dd')];
          const bounds = rows.map((el) => el.getBoundingClientRect());
          const area = dl.getBoundingClientRect();
          const preview = dl.querySelector('dd span');
          if (!preview) throw new Error('Missing Text preview');
          return {
            width: area.width,
            textWidth: bounds[0].width,
            separateRows: bounds.every((b, i) => i === 0 || b.top >= bounds[i - 1].bottom + 3),
            alignedLeft: bounds.every((b) => Math.abs(b.left - area.left) <= 1),
            selectWidth: bounds[2].width,
            inBounds: bounds.every((b) => b.left >= area.left - 1 && b.right <= area.right + 1),
            selectBackground: getComputedStyle(rows[2]).backgroundColor,
            dateBackground: getComputedStyle(rows[1]).backgroundColor,
            border: getComputedStyle(rows[2]).borderTopWidth,
            textHeight: preview.getBoundingClientRect().height,
            lineHeight: Number.parseFloat(getComputedStyle(preview).lineHeight),
          };
        });
        expect(geometry.inBounds).toBe(true);
        expect(Math.abs(geometry.textWidth - geometry.width)).toBeLessThanOrEqual(1);
        expect(geometry.textHeight).toBeLessThanOrEqual(geometry.lineHeight * 2 + 1);
        expect(geometry.selectBackground).not.toBe('rgba(0, 0, 0, 0)');
        expect(geometry.dateBackground).toBe('rgba(0, 0, 0, 0)');
        expect(geometry.border).toBe('1px');
        expect(geometry.separateRows).toBe(true);
        expect(geometry.alignedLeft).toBe(true);
        if (!longSelect) expect(geometry.selectWidth).toBeLessThan(geometry.width / 2);
        expect(await page.locator('html').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        await expectBoardBottom(page);
        await page.screenshot({ path: testInfo.outputPath(`property-rows-${width}-${theme}-${longSelect}.png`) });
        expect(api.cards).toEqual(before);
        expect(api.writes).toEqual([]);
        expect(api.requests.filter((r) => r.method !== 'GET')).toEqual([]);
      });

for (const width of [390, 1280, 1600, 1920, 2560])
  for (const theme of ['catppuccin-latte', 'catppuccin-mocha'])
    for (const columns of [2, 4])
      test(`bounded columns ${columns} ${width} ${theme}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 844 });
        await page.addInitScript((value) => localStorage.setItem('notes-theme', value), theme);
        const api = await mockPropertyBoard(page, { extraCards: 30 });
        if (columns === 2) api.field.options.splice(1);
        await page.goto(boardUrl);
        const board = region(page);
        await expect(board.getByRole('heading', { level: 3 })).toHaveCount(columns);
        const geometry = await board.evaluate((grid) => {
          const style = getComputedStyle(grid);
          const available =
            grid.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
          const lanes = [...grid.children].map((lane) => lane.getBoundingClientRect());
          const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
          return {
            available,
            gap: Number.parseFloat(style.columnGap),
            rem,
            widths: lanes.map((r) => r.width),
            scrolls: grid.scrollWidth > grid.clientWidth,
            overflow: style.overflowX,
            unused:
              available -
              lanes.reduce((sum, r) => sum + r.width, 0) -
              Number.parseFloat(style.columnGap) * (lanes.length - 1),
          };
        });
        const expected = Math.min(
          24 * geometry.rem,
          Math.max(16 * geometry.rem, (geometry.available - geometry.gap * (columns - 1)) / columns)
        );
        for (const actual of geometry.widths) {
          expect(actual).toBeGreaterThanOrEqual(16 * geometry.rem - 1);
          expect(actual).toBeLessThanOrEqual(24 * geometry.rem + 1);
          expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);
        }
        expect(geometry.overflow).toBe('auto');
        expect(geometry.scrolls).toBe(geometry.available < columns * 16 * geometry.rem + geometry.gap * (columns - 1));
        if (width >= 1920 && columns === 2) expect(geometry.unused).toBeGreaterThan(200);
        if (geometry.scrolls) {
          await board.focus();
          await page.keyboard.press('End');
          await board.evaluate((grid) => {
            grid.scrollLeft = grid.scrollWidth;
          });
          await expect.poll(() => board.evaluate((grid) => grid.scrollLeft)).toBeGreaterThan(0);
          await expect(
            board.getByRole('region', { name: 'Unclassified', exact: true }).getByRole('heading')
          ).toBeInViewport();
        }
        await expectBoardBottom(page);
        expect(await page.locator('html').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`column-width-${columns}-${width}-${theme}.png`) });
        expect(api.writes).toEqual([]);
        expect(api.requests.filter((r) => r.method !== 'GET')).toEqual([]);
      });

test('any Select defines ordered empty columns and compact reasons without tag controls or note reads', async ({
  page,
}) => {
  const api = await mockPropertyBoard(page);
  await page.goto(boardUrl);
  const board = region(page);
  await expect(board.getByRole('heading', { level: 3 })).toHaveText(['Ready', 'Finished', 'Empty', 'Unclassified']);
  await expect(
    board.getByRole('region', { name: 'Empty', exact: true }).getByText('No notes in this lane.')
  ).toBeVisible();
  await expect(board.getByText('No property value', { exact: true })).toBeVisible();
  await expect(board.getByText('Archived or unavailable property value', { exact: true })).toBeVisible();
  await expect(board.getByRole('definition').filter({ hasText: /^Bug$/ })).toHaveCount(1);
  await expect(page.getByLabel('Filter tags (all, comma-separated)')).toHaveCount(0);
  expect(
    api.laneRequests.every(
      (url) =>
        url.searchParams.get('schemaId') === 'schema_board' &&
        url.searchParams.get('schemaRevision') === '1' &&
        url.searchParams.get('version') === '1' &&
        !url.searchParams.has('tag')
    )
  ).toBe(true);
  expect(api.requests.filter((r) => r.path.startsWith('/internal/notes/note_'))).toEqual([]);
  expect(api.requests.filter((r) => r.method !== 'GET')).toEqual([]);
});

test('only active Select properties are available; changing grouping shows fresh choices without saving', async ({
  page,
}) => {
  const api = await mockPropertyBoard(page);
  await page.goto(boardUrl);
  await page.getByRole('button', { name: 'Board settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Board settings' });
  await expect(dialog.getByLabel('Columns', { exact: true }).locator('option')).toHaveText([
    'Choose a Select property',
    'Workflow',
    'Type',
  ]);
  await dialog.getByLabel('Columns', { exact: true }).selectOption('type_field');
  await expect(dialog.getByRole('checkbox', { name: 'Bug (grouping option)', exact: true })).not.toBeChecked();
  await dialog.getByLabel('Columns', { exact: true }).selectOption('workflow_field');
  await expect(dialog.getByRole('checkbox', { name: 'Ready (grouping option)', exact: true })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(api.writes).toEqual([]);
});

test('quiet settings preserve edits made during explicit error recovery and never submit on review', async ({
  page,
}) => {
  const api = await mockPropertyBoard(page);
  await page.goto(boardUrl);
  await page.getByRole('button', { name: 'Board settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Board settings', exact: true });
  await expect(dialog.getByLabel('Columns', { exact: true })).toBeEnabled();
  await expect(
    dialog.getByRole('checkbox', { name: /^(Type|Kind|Category)( select| \(unavailable\))$/ })
  ).toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Refresh and review', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('radio')).toHaveCount(0);
  for (const label of ['Ready', 'Finished', 'Empty'])
    await expect(dialog.getByRole('checkbox', { name: `${label} (grouping option)`, exact: true })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Unclassified', exact: true })).toBeChecked();
  await dialog.getByRole('checkbox', { name: /^(Type|Kind|Category)( select| \(unavailable\))$/ }).uncheck();
  api.controls.saveFailure = 500;
  await dialog.getByRole('button', { name: 'Save board', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Save failed');
  const review = dialog.getByRole('button', { name: 'Refresh and review', exact: true });
  await expect(review).toBeVisible();
  api.changeConfig();
  api.changeSchema();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/internal/folders/*/board/config', async (route) => {
    if (route.request().method() === 'GET') await held;
    await route.fallback();
  });
  try {
    await review.click();
    await expect(review).toBeDisabled();
    await dialog.getByLabel('Enabled').uncheck();
  } finally {
    release();
  }
  await expect(review).toHaveCount(0);
  await expect(dialog.getByLabel('Enabled')).not.toBeChecked();
  expect(api.writes).toHaveLength(1);
  api.controls.saveFailure = 0;
  await dialog.getByRole('button', { name: 'Save board', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(api.writes[0]).toMatchObject({ expectedVersion: 1, schemaRevision: 1 });
  expect(api.writes[1]).toMatchObject({
    expectedVersion: 2,
    schemaRevision: 2,
    config: { enabled: false },
  });
  expect(api.requests.filter((r) => r.method !== 'GET').every((r) => r.path.endsWith('/board/config'))).toBe(true);
});

test('schema read failures retain a visible recovery action until explicit successful review', async ({ page }) => {
  const api = await mockPropertyBoard(page);
  let fail = true;
  await page.route('**/internal/folders/*/properties', (route) =>
    fail ? route.fulfill({ status: 500, json: { error: 'Schema read failed' } }) : route.fallback()
  );
  await page.goto(boardUrl);
  await page.getByRole('button', { name: 'Board settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Board settings', exact: true });
  await expect(dialog.getByRole('alert')).toContainText('Schema read failed');
  await expect(dialog.getByRole('button', { name: 'Save board', exact: true })).toBeDisabled();
  const review = dialog.getByRole('button', { name: 'Refresh and review', exact: true });
  await expect(review).toBeVisible();
  fail = false;
  await review.click();
  await expect(review).toHaveCount(0);
  await expect(dialog.getByLabel('Columns', { exact: true })).toHaveValue('workflow_field');
  await expect(dialog.getByRole('button', { name: 'Save board', exact: true })).toBeEnabled();
  expect(api.writes).toEqual([]);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Board settings', exact: true })).toBeFocused();
});

test('schema/config conflicts keep draft tokens until explicit refresh/review; retired selection can be disabled', async ({
  page,
}) => {
  const api = await mockPropertyBoard(page);
  await page.goto(boardUrl);
  await page.getByRole('button', { name: 'Board settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Board settings' });
  await dialog.getByRole('checkbox', { name: /^(Type|Kind|Category)( select| \(unavailable\))$/ }).uncheck();
  api.changeSchema();
  api.changeConfig();
  await page.locator('button[aria-label="Refresh board"]').evaluate((button: HTMLButtonElement) => button.click());
  await dialog.getByRole('button', { name: 'Save board' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Your draft has been kept');
  expect(api.writes[0]).toMatchObject({ expectedVersion: 1, schemaRevision: 1 });
  await dialog.getByRole('button', { name: 'Refresh and review' }).click();
  await expect(
    dialog.getByRole('checkbox', { name: /^(Type|Kind|Category)( select| \(unavailable\))$/ })
  ).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Save board' }).click();
  await expect(dialog).toHaveCount(0);
  expect(api.writes[1]).toMatchObject({ expectedVersion: 2, schemaRevision: 2 });
  api.field.archived = true;
  api.controls.unavailable = true;
  api.changeSchema();
  await page.getByRole('button', { name: 'Refresh board' }).click();
  await expect(region(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Board settings' }).click();
  await expect(dialog.getByRole('button', { name: 'Save board' })).toBeDisabled();
  await expect(dialog.getByRole('alert')).toContainText('Grouping property unavailable');
  await expect(dialog.getByRole('button', { name: 'Refresh and review', exact: true })).toBeVisible();
  await dialog.getByLabel('Enabled').uncheck();
  await dialog.getByRole('button', { name: 'Save board' }).click();
  await expect(dialog).toHaveCount(0);
});

test('rename/reorder/archive resets all pages and labels; stale lane response hides the whole generation', async ({
  page,
}) => {
  const api = await mockPropertyBoard(page, { extraCards: 150 });
  await page.goto(boardUrl);
  let ready = page.getByRole('region', { name: 'Ready', exact: true });
  await expectLaneCount(ready, 25, true);
  await ready.getByRole('button', { name: 'Load more Ready' }).click();
  await expectLaneCount(ready, 50, true);
  api.field.options[0].label = 'Reviewed';
  api.field.options.reverse();
  api.changeSchema();
  await page.getByRole('button', { name: 'Refresh board' }).click();
  ready = page.getByRole('region', { name: 'Reviewed', exact: true });
  await expectLaneCount(ready, 25, true);
  await expect(region(page).getByRole('heading', { level: 3 })).toHaveText([
    'Empty',
    'Finished',
    'Reviewed',
    'Unclassified',
  ]);
  const todoOption = api.field.options.find((o) => o.id === 'Option_Todo');
  if (!todoOption) throw new Error('Missing fixture option');
  todoOption.archived = true;
  api.changeSchema();
  await ready.getByRole('button', { name: 'Load more Reviewed' }).click();
  await expect(region(page)).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('snapshot changed');
  await page.getByRole('button', { name: 'Refresh board' }).click();
  await expect(region(page).getByRole('heading', { level: 3 })).toHaveText(['Empty', 'Finished', 'Unclassified']);
  await expectLaneCount(page.getByRole('region', { name: 'Unclassified', exact: true }), 25, true);
});

test('stable 151-card lane loads each ID once; overlap remains deduplicated until refresh', async ({ page }) => {
  const api = await mockPropertyBoard(page, { extraCards: 150 });
  await page.goto(boardUrl);
  const ready = page.getByRole('region', { name: 'Ready', exact: true });
  for (let count = 25; count <= 150; count += 25) {
    await expectLaneCount(ready, count, true);
    await ready.getByRole('button', { name: 'Load more Ready' }).click();
  }
  await expectLaneCount(ready, 151, false);
  await expect(ready.getByRole('link')).toHaveCount(151);
  await page.getByRole('button', { name: 'Refresh board' }).click();
  await expectLaneCount(ready, 25, true);
  api.cards.unshift({ ...api.cards[0], id: 'recent', title: 'Recent' });
  await ready.getByRole('button', { name: 'Load more Ready' }).click();
  await expectLaneCount(ready, 49, true);
});

for (const role of ['viewer', 'commenter', 'editor'] as const)
  test(`${role} can read Select but cannot configure`, async ({ page }) => {
    await mockPropertyBoard(page, { role });
    await page.goto(boardUrl);
    await expect(region(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Board settings' })).toHaveCount(0);
  });

test('late old-generation page cannot reappear after a schema refresh', async ({ page }) => {
  const api = await mockPropertyBoard(page, { extraCards: 30 });
  await page.goto(boardUrl);
  const ready = page.getByRole('region', { name: 'Ready', exact: true });
  await expectLaneCount(ready, 25, true);
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/board?*', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('page') !== '2' || url.searchParams.get('schemaRevision') !== '1') return route.fallback();
    await pending;
    await route.fulfill({
      json: {
        cards: [
          {
            id: 'old_generation_only',
            title: 'Old generation card',
            properties: [
              { propertyId: 'type_field', type: 'select', optionId: 'Type_Bug', label: 'Type', value: 'Bug' },
            ],
            documentType: 'markdown',
            folderId: browserFixture.folder.id,
            createdAt: browserFixture.source.createdAt,
            updatedAt: browserFixture.source.updatedAt,
            tags: [],
            unclassifiedReason: null,
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
  const requested = page.waitForRequest((r) => new URL(r.url()).searchParams.get('page') === '2');
  await ready.getByRole('button', { name: 'Load more Ready' }).click();
  const oldRequest = await requested;
  // Consuming AbortSignal may settle a superseded page by cancellation rather than a response.
  const settled = Promise.race([
    page.waitForResponse((response) => response.request() === oldRequest),
    page.waitForEvent('requestfailed', { predicate: (request) => request === oldRequest }),
  ]);
  api.field.options[0].label = 'Current';
  api.typeField.options[0].label = 'Defect';
  api.changeSchema();
  await page.getByRole('button', { name: 'Refresh board' }).click();
  const current = page.getByRole('region', { name: 'Current', exact: true });
  await expectLaneCount(current, 25, true);
  release();
  await settled;
  await expect(region(page).getByRole('link', { name: 'Old generation card' })).toHaveCount(0);
  await expectLaneCount(current, 25, true);
  await expect(current.getByRole('definition').filter({ hasText: /^Defect$/ })).toHaveCount(25);
  await expect(region(page).getByRole('definition').filter({ hasText: /^Bug$/ })).toHaveCount(0);
});

for (const width of [390, 1280])
  for (const theme of ['catppuccin-latte', 'catppuccin-mocha'])
    test(`Select ${width} ${theme}: equal geometry, independent scrolling and keyboard links/settings`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.addInitScript((value) => localStorage.setItem('notes-theme', value), theme);
      await mockPropertyBoard(page, { extraCards: 30 });
      await page.goto(boardUrl);
      const board = region(page);
      await expectLaneCount(board.getByRole('region', { name: 'Ready', exact: true }), 25, true);
      await expectBoardBottom(page);
      await expect(page.locator('html')).toHaveClass(new RegExp(`theme-${theme}`));
      const positions = await board.locator(':scope > section').evaluateAll((columns) =>
        columns.map((column) => {
          const { top, width, height } = column.getBoundingClientRect();
          return { top, width, height };
        })
      );
      expect(positions).toHaveLength(4);
      for (const column of positions) expect(column).toEqual(positions[0]);
      const cards = board.getByRole('region', { name: 'Ready cards', exact: true });
      expect(await cards.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
      expect(await cards.evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto');
      expect(await cards.evaluate((el) => getComputedStyle(el).scrollbarWidth)).toBe('none');
      expect(await cards.evaluate((el) => getComputedStyle(el, '::-webkit-scrollbar').display)).toBe('none');
      expect(await board.evaluate((el) => getComputedStyle(el).scrollbarWidth)).not.toBe('none');
      expect(await board.evaluate((el) => getComputedStyle(el, '::-webkit-scrollbar').display)).not.toBe('none');
      const header = board.getByRole('region', { name: 'Ready', exact: true }).locator(':scope > header');
      const footer = board.getByRole('button', { name: 'Load more Ready', exact: true });
      const headerBefore = await header.boundingBox(),
        footerBefore = await footer.boundingBox();
      const mainBefore = await page.getByRole('main').evaluate((el) => el.scrollTop);
      await expect(footer).toBeInViewport();
      await cards.hover();
      await page.mouse.wheel(0, 200);
      await expect.poll(() => cards.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      const beforeKeyboard = await cards.evaluate((el) => el.scrollTop);
      await cards.focus();
      await page.keyboard.press('ArrowDown');
      await expect.poll(() => cards.evaluate((el) => el.scrollTop)).toBeGreaterThan(beforeKeyboard);
      expect(
        await board.getByRole('region', { name: 'Finished cards', exact: true }).evaluate((el) => el.scrollTop)
      ).toBe(0);
      expect(await page.getByRole('main').evaluate((el) => el.scrollTop)).toBe(mainBefore);
      expect(await header.boundingBox()).toEqual(headerBefore);
      expect(await footer.boundingBox()).toEqual(footerBefore);
      await expectBoardBottom(page);
      const last = board.getByRole('region', { name: 'Ready', exact: true }).getByRole('link').last();
      await last.focus();
      await expect(last).toBeInViewport();
      if (width === 390) {
        await board.focus();
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => board.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByRole('button', { name: 'Board settings' }).focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Board settings' });
      await expect(dialog.getByLabel('Columns', { exact: true })).toHaveValue('workflow_field');
      await expect(dialog.getByLabel('Columns', { exact: true })).toBeEnabled();
      await expect(dialog.getByRole('button', { name: 'Refresh and review', exact: true })).toHaveCount(0);
      expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath('quiet-select-settings.png') });
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Board settings', exact: true })).toBeFocused();
      const link = board.getByRole('link', { name: browserFixture.source.title, exact: true });
      await link.focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(`/notes/${browserFixture.source.id}`);
    });

test('new drafts suggest Status grouping but no display fields, otherwise require explicit active Select', async ({
  page,
}) => {
  const api = await mockPropertyBoard(page, { absent: true });
  api.field.label = 'Status';
  await page.goto(boardUrl);
  await page.getByRole('button', { name: 'Board settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Board settings' });
  await expect(dialog.getByLabel('Columns', { exact: true })).toHaveValue(api.field.id);
  await expect(dialog.getByLabel('Columns', { exact: true })).toHaveValue(api.field.id);
  await expect(
    dialog.getByRole('checkbox', { name: /^(Type|Kind|Category)( select| \(unavailable\))$/ })
  ).not.toBeChecked();
  expect(api.writes).toEqual([]);
  await page.keyboard.press('Escape');
  api.field.label = 'Workflow';
  api.typeField.label = 'Kind';
  await page.getByRole('button', { name: 'Board settings' }).click();
  await expect(dialog.getByLabel('Columns', { exact: true })).toHaveValue('');
  await expect(
    dialog.getByRole('checkbox', { name: /^(Type|Kind|Category)( select| \(unavailable\))$/ })
  ).not.toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Save board' })).toBeDisabled();
  await dialog.getByLabel('Columns', { exact: true }).selectOption(api.field.id);
  await dialog.getByRole('checkbox', { name: /^(Type|Kind|Category)( select| \(unavailable\))$/ }).check();
  await dialog.getByRole('button', { name: 'Save board' }).click();
  await expect(dialog).toHaveCount(0);
  expect(api.writes[0]).toMatchObject({ expectedVersion: 0, config: { cardPropertyIds: [api.typeField.id] } });
  await expect(region(page).getByRole('definition').filter({ hasText: /^Bug$/ })).toBeVisible();
});

test('Type labels refresh by stable ID; option/field retirement hides badges and owner can clear unavailable selection', async ({
  page,
}) => {
  const api = await mockPropertyBoard(page);
  await page.goto(boardUrl);
  await expect(region(page).getByRole('definition').filter({ hasText: /^Bug$/ })).toBeVisible();
  api.typeField.label = 'Category';
  api.typeField.options[0].label = 'Defect';
  api.changeSchema();
  await page.getByRole('button', { name: 'Refresh board' }).click();
  await expect(
    region(page)
      .getByRole('definition')
      .filter({ hasText: /^Defect$/ })
  ).toBeVisible();
  await expect(region(page).getByRole('definition').filter({ hasText: /^Bug$/ })).toHaveCount(0);
  api.typeField.options[0].archived = true;
  api.changeSchema();
  await page.getByRole('button', { name: 'Refresh board' }).click();
  await expect(
    region(page)
      .getByRole('definition')
      .filter({ hasText: /^Defect$/ })
  ).toHaveCount(0);
  api.typeField.archived = true;
  api.changeSchema();
  await page.getByRole('button', { name: 'Refresh board' }).click();
  await page.getByRole('button', { name: 'Board settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Board settings' });
  await expect(
    dialog.getByRole('checkbox', { name: /^(Type|Kind|Category)( select| \(unavailable\))$/ })
  ).toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Save board' })).toBeDisabled();
  await expect(dialog.getByRole('alert')).toContainText('Card properties unavailable');
  await expect(dialog.getByRole('button', { name: 'Refresh and review', exact: true })).toBeVisible();
  await dialog.getByRole('checkbox', { name: /^(Type|Kind|Category)( select| \(unavailable\))$/ }).uncheck();
  await expect(dialog.getByRole('button', { name: 'Refresh and review', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Save board' }).click();
  await expect(dialog).toHaveCount(0);
  expect(api.writes[0].config.cardPropertyIds).toEqual([]);
  expect(api.cards[0].typeValue).toBe('Type_Bug');
});

test('network failures retain warnings/cards; lane revocation hides every lane and settings', async ({ page }) => {
  const api = await mockPropertyBoard(page, { extraCards: 30 });
  await page.goto(boardUrl);
  const ready = page.getByRole('region', { name: 'Ready', exact: true });
  await expectLaneCount(ready, 25, true);
  api.controls.laneFailure = 500;
  await ready.getByRole('button', { name: 'Load more Ready' }).click();
  await expect(ready.getByRole('alert')).toContainText('may be stale');
  await expect(ready.getByRole('link')).toHaveCount(25);
  api.controls.laneFailure = 404;
  await ready.getByRole('button', { name: 'Retry lane' }).click();
  await expect(region(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Board settings' })).toHaveCount(0);
});
