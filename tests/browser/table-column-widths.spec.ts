import { expect, type Locator, test } from '@playwright/test';
import { browserFixture, mockBrowserApi } from './fixtures';

const cases = [
  {
    name: 'text columns on desktop',
    width: 1280,
    content: [
      '| Question | Type | What legacy does today | V2 decision | Why |',
      '| --- | --- | --- | --- | --- |',
      '| Separate auction flow? | Legacy port; same behavior | One processor and one uploader for every listing type; the uploader builds an auction or a dealer vehicle by type. | No separate flow. Auctions run the existing flow; six tasks become listing-type aware, plus one disablement rule. | Auctions need the same steps. A separate flow would duplicate about 25 task wirings and every gate. |',
    ].join('\n'),
  },
  {
    name: 'empty columns on mobile',
    width: 390,
    content: '|  |  |  |  |  |\n| --- | --- | --- | --- | --- |\n|  |  |  |  |  |',
  },
];

async function expectMinimumColumns(table: Locator) {
  await expect(table).toBeVisible();
  await expect(table.locator('th, td')).toHaveCount(10);
  await expect
    .poll(() =>
      table
        .locator('th, td')
        .evaluateAll((cells) => Math.min(...cells.map((cell) => cell.getBoundingClientRect().width)))
    )
    .toBeGreaterThanOrEqual(119.5);
}

for (const example of cases) {
  test(`keeps a 120px column minimum while viewing and editing ${example.name}`, async ({ page }) => {
    const api = await mockBrowserApi(page);
    api.notes.set(browserFixture.source.id, { ...browserFixture.source, content: example.content });
    await page.setViewportSize({ width: example.width, height: 900 });
    await page.goto(`/notes/${browserFixture.source.id}`);

    const table = page.locator('.me-table-render');
    await expectMinimumColumns(table);
    if (example.width === 1280) {
      const lines = await table
        .locator('th')
        .first()
        .evaluate((cell) => {
          const range = document.createRange();
          range.selectNodeContents(cell);
          return range.getClientRects().length;
        });
      expect(lines).toBe(1);
    }

    await table.locator('th').first().click();
    await expect(page.locator('.me-table-widget--editing')).toBeVisible();
    await expectMinimumColumns(table);
    await expect
      .poll(() =>
        table
          .locator('input')
          .evaluateAll((inputs) => Math.min(...inputs.map((input) => input.getBoundingClientRect().width)))
      )
      .toBeGreaterThanOrEqual(119.5);

    const input = table.locator('input').first();
    await input.fill('Updated question');
    await expect.poll(() => api.notes.get(browserFixture.source.id)?.content).toContain('| Updated question |');
    await input.press('Escape');
    await expect(page.locator('.me-table-widget--editing')).toHaveCount(0);
    await expectMinimumColumns(table);

    if (example.width === 390) {
      const scroller = page.locator('.me-table-scroller');
      await expect(scroller).toHaveCSS('overflow-x', 'auto');
      const bounds = await scroller.evaluate((element) => ({
        client: element.clientWidth,
        scroll: element.scrollWidth,
      }));
      expect(bounds.scroll).toBeGreaterThan(bounds.client);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(example.width);
  });

  test(`keeps a 120px column minimum in read-only ${example.name}`, async ({ page }) => {
    const api = await mockBrowserApi(page);
    api.notes.set(browserFixture.source.id, { ...browserFixture.source, content: example.content });
    await page.setViewportSize({ width: example.width, height: 900 });
    await page.goto('/share/folders/folder_share_token');
    await page.getByRole('button', { name: browserFixture.source.title }).click();

    const scroller = page.locator('.notes-minu-renderer .me-renderer-table-scroller');
    await expectMinimumColumns(scroller.locator('table'));
    await expect(scroller.locator('input')).toHaveCount(0);
    if (example.width === 390) {
      await expect(scroller).toHaveCSS('overflow-x', 'auto');
      const bounds = await scroller.evaluate((element) => ({
        client: element.clientWidth,
        scroll: element.scrollWidth,
      }));
      expect(bounds.scroll).toBeGreaterThan(bounds.client);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(example.width);
  });
}
