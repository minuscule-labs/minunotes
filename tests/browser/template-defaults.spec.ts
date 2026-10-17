import { expect, test } from '@playwright/test';
import { browserFixture } from './fixtures';
import { mockTemplates } from './template-fixtures';

async function open(page: import('@playwright/test').Page) {
  await page.goto(`/notes/${browserFixture.template.id}`);
  await page.locator('summary').filter({ hasText: 'Template defaults' }).click();
}
test('owner defaults save independently from dirty Markdown; fetch only selected assigned schema', async ({ page }) => {
  const f = await mockTemplates(page);
  const bodyReads: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'GET' && new URL(r.url()).pathname === `/internal/notes/${browserFixture.template.id}`)
      bodyReads.push(r.url());
  });
  await open(page);
  expect(f.schemaReads).toHaveLength(0);
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' dirty template body');
  await page.getByLabel('Default tags', { exact: true }).fill('feature, backlog');
  await page.getByRole('button', { name: 'Save default tags', exact: true }).click();
  await expect.poll(() => f.tagSaves.length).toBe(1);
  await page.getByLabel('Assigned destination').selectOption(browserFixture.folder.id);
  await page.getByLabel('Summary', { exact: true }).fill('New default');
  await page.getByRole('button', { name: 'Save default properties', exact: true }).click();
  await expect.poll(() => f.defaultSaves.length).toBe(1);
  expect(f.schemaReads.every((p) => p.includes(browserFixture.folder.id))).toBe(true);
  await expect(editor).toContainText('dirty template body');
  expect(bodyReads).toHaveLength(1);
  await page.getByLabel('Assigned destination').selectOption('folder_second');
  await expect.poll(() => f.schemaReads.some((p) => p.includes('folder_second'))).toBe(true);
  await expect(page.getByLabel('Summary', { exact: true })).toHaveCount(0);
});
test('default conflicts and ordinary errors preserve draft; explicit refresh advances captured revision', async ({
  page,
}) => {
  const f = await mockTemplates(page);
  await open(page);
  await page.getByLabel('Default tags', { exact: true }).fill('draft');
  f.controls.conflictNext = true;
  await page.getByRole('button', { name: 'Save default tags', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('draft is preserved');
  f.defaults.revision++;
  await page.getByRole('button', { name: 'Refresh defaults for review' }).click();
  await expect(page.getByRole('status')).toContainText('review before saving');
  await expect(page.getByLabel('Default tags', { exact: true })).toHaveValue('draft');
  await page.getByRole('button', { name: 'Save default tags', exact: true }).click();
  await expect.poll(() => f.tagSaves.length).toBe(1);
});
test('background refetch cannot advance owner tokens or replace drafted defaults', async ({ page }) => {
  const f = await mockTemplates(page);
  await open(page);
  await page.getByLabel('Default tags', { exact: true }).fill('local-draft');
  f.defaults.revision++;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('button', { name: 'Save default tags', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('draft is preserved');
  await expect(page.getByLabel('Default tags', { exact: true })).toHaveValue('local-draft');
  expect(f.tagSaves).toHaveLength(0);
});
test('property-default errors preserve values and explicit refresh uses the current schema revision', async ({
  page,
}) => {
  const f = await mockTemplates(page);
  await open(page);
  await page.getByLabel('Assigned destination').selectOption(browserFixture.folder.id);
  await page.getByLabel('Summary', { exact: true }).fill('Draft default');
  f.changeSchema();
  await page.getByRole('button', { name: 'Save default properties', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('draft is preserved');
  await page.getByRole('button', { name: 'Refresh defaults for review', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('review before saving');
  await expect(page.getByLabel('Summary', { exact: true })).toHaveValue('Draft default');
  await page.getByRole('button', { name: 'Save default properties', exact: true }).click();
  await expect.poll(() => f.defaultSaves.length).toBe(1);
});
test('revocation removes owner defaults and entered metadata', async ({ page }) => {
  const f = await mockTemplates(page);
  await open(page);
  await page.getByLabel('Default tags', { exact: true }).fill('private-draft');
  f.controls.deny = true;
  await page.getByRole('button', { name: 'Save default tags', exact: true }).click();
  await expect(page.getByText('Template defaults unavailable', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Default tags', { exact: true })).toHaveCount(0);
});
for (const theme of ['catppuccin-latte', 'catppuccin-mocha'])
  test(`owner defaults keyboard/mobile in ${theme}`, async ({ page }) => {
    await page.addInitScript((theme) => localStorage.setItem('notes-theme', theme), theme);
    await page.setViewportSize({ width: 390, height: 844 });
    const f = await mockTemplates(page);
    await page.goto(`/notes/${browserFixture.template.id}`);
    const summary = page.locator('summary').filter({ hasText: 'Template defaults' });
    await summary.focus();
    await page.keyboard.press('Enter');
    await page.getByLabel('Default tags', { exact: true }).fill('keyboard');
    await page.getByRole('button', { name: 'Save default tags', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => f.tagSaves.length).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
