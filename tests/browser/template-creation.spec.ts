import { expect, test } from '@playwright/test';
import { browserFixture } from './fixtures';
import { mockTemplates } from './template-fixtures';

const path = `/folders/${browserFixture.folder.id}/new-from-template`;
test('cancel creates nothing and defaults are editable/clearable before ordinary-editor success', async ({ page }) => {
  const f = await mockTemplates(page);
  await page.goto(path);
  await expect(page.getByLabel('Summary', { exact: true })).toHaveValue('Prepared');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(f.creates).toHaveLength(0);
  expect(f.receipts.size).toBe(0);
  await page.goto(path);
  await page.getByLabel('Note title').fill('Reviewed');
  await page.getByRole('button', { name: 'Clear tags', exact: true }).click();
  await page.getByRole('button', { name: 'Clear properties', exact: true }).click();
  await page.getByRole('button', { name: 'Create note', exact: true }).click();
  await expect(page).toHaveURL('/notes/note_from_template');
  expect(f.creates[0]).toMatchObject({ title: 'Reviewed', tags: [], values: {} });
  expect(f.body.notes.get('note_from_template')?.content).toContain('Reviewed');
  expect(f.receipts.size).toBe(1);
});
test('duplicate clicks and a lost committed response retry the exact frozen request and variables', async ({
  page,
}) => {
  const f = await mockTemplates(page);
  await page.goto(path);
  await page.getByLabel('Note title').fill('Frozen');
  f.controls.loseResponse = true;
  await page.getByRole('button', { name: 'Create note', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('uncertain');
  await expect(page.getByLabel('Note title')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  const frozen = structuredClone(f.creates[0]);
  f.changeSnapshot();
  f.changeSchema();
  await page.getByRole('button', { name: 'Retry creation', exact: true }).dblclick();
  await expect(page).toHaveURL('/notes/note_from_template');
  expect(f.creates).toHaveLength(2);
  expect(f.creates[1]).toEqual(frozen);
  expect(f.receipts.size).toBe(1);
});
test('stale snapshot preserves final clears and explicit re-review updates token only', async ({ page }) => {
  const f = await mockTemplates(page);
  await page.goto(path);
  await page.getByLabel('Note title').fill('Draft');
  await page.getByLabel('Summary', { exact: true }).fill('Draft property');
  await page.getByRole('button', { name: 'Clear tags', exact: true }).click();
  f.changeSnapshot();
  f.changeSchema();
  await page.getByRole('button', { name: 'Create note', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Re-review');
  await expect(page.getByLabel('Summary', { exact: true })).toHaveValue('Draft property');
  await page.getByRole('button', { name: 'Re-review template', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Latest template');
  await page.getByRole('button', { name: 'Create note', exact: true }).click();
  await expect(page).toHaveURL('/notes/note_from_template');
  expect(f.creates[1].requestId).not.toBe(f.creates[0].requestId);
  expect(f.creates[1].tags).toEqual([]);
  expect(Object.values(f.creates[1].values)).toContain('Draft property');
});
test('removed fields remain flagged, not silently dropped; user can explicitly clear them', async ({ page }) => {
  const f = await mockTemplates(page);
  await page.goto(path);
  await expect(page.getByLabel('Summary', { exact: true })).toHaveValue('Prepared');
  f.schema.definitions[0].archived = true;
  f.changeSchema();
  await page.getByRole('button', { name: 'Re-review template', exact: true }).click();
  await expect(page.getByText(/Removed field:/)).toBeVisible();
  await page.getByRole('button', { name: 'Clear removed field' }).click();
  await page.getByRole('button', { name: 'Create note', exact: true }).click();
  await expect(page).toHaveURL('/notes/note_from_template');
  expect(f.creates[0].values).not.toHaveProperty(f.schema.definitions[0].id);
});
test('shared editor uses scoped preview without reading the template library or private note', async ({ page }) => {
  const f = await mockTemplates(page, 'editor'),
    reads: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'GET') reads.push(new URL(r.url()).pathname);
  });
  await page.goto(path);
  await expect(page.getByLabel('Summary', { exact: true })).toHaveValue('Prepared');
  expect(reads).not.toContain(`/internal/notes/${browserFixture.template.id}`);
  expect(reads).not.toContain('/internal/notes/templates');
  await page.getByRole('button', { name: 'Create note', exact: true }).click();
  await expect(page).toHaveURL('/notes/note_from_template');
  expect(f.receipts.size).toBe(1);
});
for (const role of ['viewer', 'commenter'] as const)
  test(`${role} cannot review/create`, async ({ page }) => {
    const f = await mockTemplates(page, role);
    await page.goto(path);
    await expect(page.getByText('Template creation unavailable', { exact: true })).toBeVisible();
    expect(f.previewReads).toHaveLength(0);
    expect(f.creates).toHaveLength(0);
  });
test('preview revocation removes reviewed metadata and creates nothing', async ({ page }) => {
  const f = await mockTemplates(page);
  await page.goto(path);
  await expect(page.getByLabel('Summary', { exact: true })).toHaveValue('Prepared');
  f.controls.deny = true;
  await page.getByRole('button', { name: 'Re-review template', exact: true }).click();
  await expect(page.getByText('Template creation unavailable', { exact: true })).toBeVisible();
  expect(f.creates).toHaveLength(0);
});
