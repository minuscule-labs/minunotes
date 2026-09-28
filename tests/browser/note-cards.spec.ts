import { expect, test } from '@playwright/test';
import { browserFixture, mockBrowserApi } from './fixtures';

test('wraps and clamps long mobile note titles while preserving the full title', async ({ page }) => {
  const api = await mockBrowserApi(page);
  const title = 'MobileTitle'.repeat(12);
  api.notes.set(browserFixture.source.id, { ...browserFixture.source, title });
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto(`/folders/${browserFixture.folder.id}`);

  const expectTitleClamp = async () => {
    const titleNode = page.getByTitle(title);
    await expect(titleNode).toBeVisible();

    const metrics = await titleNode.evaluate((element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      const parent = element.closest('.rounded-lg');
      const parentBounds = parent?.getBoundingClientRect();
      return {
        text: element.textContent,
        lineClamp: style.webkitLineClamp,
        overflowWrap: style.overflowWrap,
        height: bounds.height,
        lineHeight: Number.parseFloat(style.lineHeight),
        left: bounds.left,
        right: bounds.right,
        parentLeft: parentBounds?.left,
        parentRight: parentBounds?.right,
        viewportWidth: document.documentElement.clientWidth,
        documentWidth: document.documentElement.scrollWidth,
      };
    });

    expect(metrics.text).toBe(title);
    expect(metrics.lineClamp).toBe('2');
    expect(metrics.overflowWrap).toBe('anywhere');
    expect(metrics.height).toBeLessThanOrEqual(metrics.lineHeight * 2 + 1);
    expect(metrics.left).toBeGreaterThanOrEqual(metrics.parentLeft ?? 0);
    expect(metrics.right).toBeLessThanOrEqual(metrics.parentRight ?? 0);
    expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
  };

  await expectTitleClamp();
  await page.goto('/');
  await expectTitleClamp();
});
