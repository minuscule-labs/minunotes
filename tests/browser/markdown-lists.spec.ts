import { expect, test } from '@playwright/test';
import { browserFixture, mockBrowserApi } from './fixtures';

for (const theme of ['catppuccin-mocha', 'catppuccin-latte']) {
  for (const share of ['note', 'folder']) {
    test(`preserves Markdown list markers in ${theme} ${share} shares`, async ({ page }) => {
      await page.addInitScript((value) => window.localStorage.setItem('notes-theme', value), theme);
      const api = await mockBrowserApi(page);
      api.notes.set(browserFixture.linked.id, {
        ...browserFixture.linked,
        content: [
          '3. First step',
          '4. Second step',
          '   1. Nested step',
          '   2. Another nested step',
          '',
          '- Bullet',
          '  - Nested bullet',
          '',
          '## Tasks',
          '',
          '- [ ] Pending task',
          '- [x] Finished task',
          '',
          '## In progress',
          '',
          '- [/] Partial task',
        ].join('\n'),
      });
      await page.goto(
        share === 'note'
          ? `/share/note_share_${browserFixture.linked.id}`
          : `/share/folders/folder_share_token?note=${browserFixture.linked.id}`
      );

      const renderer = page.locator('.notes-minu-renderer');
      const orderedLists = renderer.locator('ol');
      await expect(orderedLists).toHaveCount(2);
      await expect(orderedLists.first()).toHaveAttribute('start', '3');
      for (const list of await orderedLists.all()) {
        await expect(list).toHaveCSS('list-style-type', 'decimal');
        await expect(list).toHaveCSS('list-style-position', 'outside');
        await expect(list.locator(':scope > li').first()).toHaveCSS('display', 'list-item');
      }

      const bulletLists = renderer.locator('ul:not(.contains-task-list):not(:has(input[type="checkbox"]))');
      await expect(bulletLists).toHaveCount(2);
      for (const list of await bulletLists.all()) {
        await expect(list).toHaveCSS('list-style-type', 'disc');
        await expect(list.locator(':scope > li').first()).toHaveCSS('display', 'list-item');
      }

      const tasks = renderer.locator('li:has(> input[type="checkbox"])');
      await expect(tasks).toHaveCount(2);
      for (const task of await tasks.all()) {
        await expect(task).toHaveCSS('list-style-type', 'none');
        await expect(task.locator('input')).toBeVisible();
      }
      await expect(tasks.first().locator('input')).not.toBeChecked();
      await expect(tasks.last().locator('input')).toBeChecked();
      await expect(renderer.locator('ul.contains-task-list')).toHaveCSS('list-style-type', 'none');
      await expect(renderer.getByRole('checkbox', { name: 'In progress' })).toHaveAttribute('aria-checked', 'mixed');
    });
  }
}
