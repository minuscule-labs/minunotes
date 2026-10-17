import { expect, type Locator, type Page, test } from '@playwright/test';
import { mutatePropertyDefinitions } from '../../src/shared/properties';
import { browserFixture } from './fixtures';
import { mockProperties } from './properties-fixtures';

// Trigger the same visibility transition used by React Query's authorized background reads.
async function refocus(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    window.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    window.dispatchEvent(new Event('visibilitychange'));
  });
}

async function freezeClock(page: Page) {
  // Keep startup/query notifications running; pause only at scoped, mounted timer checks.
  await page.clock.install();
}
async function pausePropertyTime(page: Page) {
  await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now() + 1)));
}
async function openPropertiesModal(page: Page) {
  await page.getByRole('button', { name: 'Open note actions', exact: true }).click();
  await page.getByRole('button', { name: 'Properties', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Properties', exact: true })).toBeVisible();
}
async function openProperties(page: Page, noteId = browserFixture.source.id) {
  await page.goto(`/notes/${noteId}`);
  await expect(page.getByRole('button', { name: 'Open note actions', exact: true })).toBeVisible();
  if (await page.locator('.notes-minu-canvas').count()) await openPropertiesModal(page);
  else await page.locator('summary').filter({ hasText: 'Properties' }).click();
}
async function chooseStatus(page: Page, label: string) {
  await page.getByLabel('Status', { exact: true }).click();
  await page.getByRole('dialog', { name: 'Choose Status' }).getByRole('button', { name: label, exact: true }).click();
}
const propertyPanel = (page: Page) =>
  page
    .locator('details')
    .filter({ has: page.locator('summary').filter({ hasText: /^Properties$/ }) })
    .or(page.getByRole('dialog', { name: 'Properties', exact: true }).locator(':scope > [aria-busy]'));
const storedDraft = (page: Page, noteId = browserFixture.source.id) =>
  page.evaluate((id) => JSON.parse(sessionStorage.getItem(`minunotes:properties-draft:${id}`) ?? 'null'), noteId);
async function expectQuietProperties(page: Page) {
  const panel = propertyPanel(page);
  if (await panel.locator('summary').count()) await expect(panel.locator('summary')).toHaveText('Properties');
  else
    await expect(page.getByRole('dialog', { name: 'Properties', exact: true }).getByRole('heading')).toHaveText(
      'Properties'
    );
  await expect(panel.getByRole('status')).toHaveCount(0);
  await expect(panel.getByText(/Properties saved|Saving properties|Unsaved properties|Current saved /)).toHaveCount(0);
  await expect(
    panel.getByRole('button', { name: /Reload|Review changes|Retry properties|Discard local unsaved changes/ })
  ).toHaveCount(0);
}
async function expectPropertySaved(
  page: Page,
  f: Awaited<ReturnType<typeof mockProperties>>,
  saves: number,
  values: Record<string, string | null>,
  noteId = browserFixture.source.id
) {
  // Require an explicit intended acceptance count/value, then CLIENT acknowledgement too.
  // A prior quiet UI or a server-accepted but held response cannot satisfy this helper.
  expect(saves).toBeGreaterThan(0);
  expect(Object.keys(values).length).toBeGreaterThan(0);
  await expect
    .poll(() => ({
      saves: f.saves.length,
      values: Object.fromEntries(Object.keys(values).map((id) => [id, f.state.get(noteId)?.values[id] ?? null])),
    }))
    .toEqual({ saves, values });
  await expect(propertyPanel(page)).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => storedDraft(page, noteId)).toBeNull();
  await expectQuietProperties(page);
}
async function spaToFolder(page: Page) {
  // Programmatic existing-link activation doesn't blur/flush the focused input before unmount.
  await page
    .getByRole('navigation', { name: 'Breadcrumb' })
    .getByRole('link', { name: browserFixture.folder.title, exact: true })
    .evaluate((link) => link.click());
  await expect(page).toHaveURL(`/folders/${browserFixture.folder.id}`);
}
async function manageSchemaProperty(page: Page, label: string) {
  const manager = page.getByRole('dialog', { name: `Manage property ${label}`, exact: true });
  if (!(await manager.isVisible())) await page.getByRole('button', { name: `Manage ${label}`, exact: true }).click();
  return manager;
}
async function schemaPropertyActions(page: Page, label: string) {
  const actions = page.getByRole('dialog', { name: `Actions for property ${label}`, exact: true });
  if (!(await actions.isVisible()))
    await page.getByRole('button', { name: `Actions for property ${label}`, exact: true }).click();
  return actions;
}
async function schemaOptionActions(page: Page, field: string, option: string) {
  await manageSchemaProperty(page, field);
  const actions = page.getByRole('dialog', { name: `Actions for option ${option}`, exact: true });
  if (!(await actions.isVisible())) {
    // Dismiss the previous floating actions before reaching an option underneath it.
    if (await page.getByRole('dialog', { name: /^Actions for option / }).count()) await page.keyboard.press('Escape');
    await page.getByRole('button', { name: `Actions for option ${option}`, exact: true }).click();
  }
  return actions;
}
async function renameSchemaProperty(page: Page, label: string) {
  await (await schemaPropertyActions(page, label))
    .getByRole('button', { name: `Rename ${label}`, exact: true })
    .click();
  await expect(page.getByRole('dialog', { name: 'Edit property', exact: true })).toBeVisible();
}
async function renameSchemaOption(page: Page, field: string, option: string) {
  await (await manageSchemaProperty(page, field))
    .getByRole('button', { name: `Rename option ${option}`, exact: true })
    .click();
  await expect(page.getByRole('dialog', { name: 'Edit property', exact: true })).toBeVisible();
}
const schemaPath = `/internal/folders/${browserFixture.folder.id}/properties`;
function trackSchemaWrites(page: Page) {
  const writes: { expectedRevision: number; mutation: { propertyId?: string; optionId?: string; label: string } }[] =
    [];
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && new URL(request.url()).pathname === schemaPath)
      writes.push(request.postDataJSON());
  });
  return writes;
}
const nextSchemaRead = (page: Page) =>
  page.waitForResponse(
    (response) => response.request().method() === 'GET' && new URL(response.url()).pathname === schemaPath
  );

async function expectWholeSchemaRow(page: Page, row: Locator, name: Locator, ellipsis: Locator, screenshot: string) {
  const hoverColor = await row.evaluate((element) => {
    const probe = document.createElement('span');
    probe.style.backgroundColor = 'var(--notes-hover)';
    element.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  });
  expect(hoverColor).not.toBe('rgba(0, 0, 0, 0)');
  for (const control of [name, ellipsis]) {
    await control.hover();
    await expect(row).toHaveCSS('background-color', hoverColor);
    await expect(name).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(ellipsis).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  }
  await row.screenshot({ path: screenshot }); // Ellipsis hover still paints the WHOLE row.
  await page.mouse.move(0, 0);
  for (const control of [name, ellipsis]) {
    await control.focus();
    await expect(control).toBeFocused();
    await expect(row).toHaveCSS('background-color', hoverColor);
    await expect(name).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(ellipsis).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await control.evaluate((button: HTMLButtonElement) => button.blur());
  }
  await expect(row).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
}
async function expectMoveIcon(button: Locator, direction: 'up' | 'down') {
  await expect(button.locator(`svg.lucide-arrow-${direction}`)).toHaveAttribute('aria-hidden', 'true');
  await expect(button).toHaveText(`Move ${direction}`);
}

test('Text coalesces at 500ms, flushes on blur, and unchanged values/choices/clears never churn revisions', async ({
  page,
}) => {
  await freezeClock(page);
  const f = await mockProperties(page);
  await openProperties(page);
  await pausePropertyTime(page);
  const text = page.getByLabel('Summary', { exact: true });
  await text.fill('One');
  await page.clock.runFor(300);
  await text.fill('Latest');
  await page.clock.runFor(499);
  await expectQuietProperties(page);
  await expect(propertyPanel(page)).toHaveAttribute('aria-busy', 'false');
  expect((await storedDraft(page)).values[f.schema.definitions[0].id]).toBe('Latest');
  expect(f.patches).toHaveLength(0);
  await page.clock.runFor(1);
  await expectPropertySaved(page, f, 1, { [f.schema.definitions[0].id]: 'Latest' });
  expect(f.patches[0].values).toEqual({ [f.schema.definitions[0].id]: 'Latest' });
  await page.clock.resume();
  await text.press('Tab');
  await text.fill('Latest');
  await text.press('Tab');
  await chooseStatus(page, 'Todo');
  await expectPropertySaved(page, f, 2, { [f.schema.definitions[1].id]: f.schema.definitions[1].options[0].id });
  await chooseStatus(page, 'Todo');
  await page.getByLabel('Status', { exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Choose Status' })
    .getByRole('button', { name: 'Clear Status', exact: true })
    .click();
  await expectPropertySaved(page, f, 3, { [f.schema.definitions[1].id]: null });
  await page.getByLabel('Status', { exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Choose Status' })
    .getByRole('button', { name: 'Clear Status', exact: true })
    .click();
  await page.getByLabel('Due date', { exact: true }).press('Tab');
  await text.fill('Blur now');
  await text.press('Tab');
  await expectPropertySaved(page, f, 4, { [f.schema.definitions[0].id]: 'Blur now' });
  await page.clock.runFor(1000);
  expect(f.patches.map((p) => p.expectedRevision)).toEqual([0, 1, 2, 3]);
  expect(f.saves).toHaveLength(4);
  expect(f.maxActive).toBe(1);
});

test('a queued Select acknowledgement defers unsettled text without losing its focus or local work', async ({
  page,
}) => {
  await freezeClock(page);
  const f = await mockProperties(page);
  const hold = f.holdNext('after');
  await openProperties(page);
  await chooseStatus(page, 'Todo');
  await hold.started;
  await pausePropertyTime(page);
  const text = page.getByLabel('Summary', { exact: true });
  await text.fill('Still typing');
  await page.clock.runFor(499);
  hold.release();
  await expect(propertyPanel(page)).toHaveAttribute('aria-busy', 'false');
  await expect.poll(async () => (await storedDraft(page))?.base.revision).toBe(1);
  await expectQuietProperties(page);
  await expect(text).toBeFocused();
  expect(f.patches).toHaveLength(1);
  expect((await storedDraft(page)).base.revision).toBe(1);
  expect(f.state.get(browserFixture.source.id)?.values).not.toHaveProperty(f.schema.definitions[0].id);
  await page.clock.runFor(1);
  await expectPropertySaved(page, f, 2, { [f.schema.definitions[0].id]: 'Still typing' });
  expect(f.patches[1]).toMatchObject({ expectedRevision: 1, values: { [f.schema.definitions[0].id]: 'Still typing' } });
  await page.clock.resume();
  await expect(text).toBeFocused();
  expect(f.maxActive).toBe(1);
});

test('accepted snapshots preserve newer typing and coalesce eligible fields in one serial successor', async ({
  page,
}) => {
  await freezeClock(page);
  const f = await mockProperties(page);
  const [textField, statusField, dateField] = f.schema.definitions;
  const hold = f.holdNext('after');
  await openProperties(page);
  const text = page.getByLabel('Summary', { exact: true });
  await text.fill('Submitted first');
  await text.press('Tab');
  await hold.started;
  await text.fill('Newer typing');
  await page.clock.runFor(500);
  await page.getByLabel('Due date', { exact: true }).fill('2028-02-29');
  await page.getByLabel('Due date', { exact: true }).press('Enter');
  await chooseStatus(page, 'Done');
  await page.getByLabel('Status', { exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Choose Status' })).toBeVisible();
  expect(f.patches).toHaveLength(1);
  expect(f.patches[0].values).toEqual({ [textField.id]: 'Submitted first' });
  expect(f.state.get(browserFixture.source.id)?.values[textField.id]).toBe('Submitted first');
  expect((await storedDraft(page)).values[textField.id]).toBe('Newer typing');
  const next = f.holdNext('after');
  hold.release();
  await next.started;
  expect(f.patches[1]).toMatchObject({
    expectedRevision: 1,
    schemaRevision: 1,
    values: {
      [textField.id]: 'Newer typing',
      [statusField.id]: statusField.options[1].id,
      [dateField.id]: '2028-02-29',
    },
  });
  const remaining = await storedDraft(page);
  expect(remaining.base.revision).toBe(1);
  expect(remaining.values[textField.id]).toBe('Newer typing');
  await expect(page.getByRole('dialog', { name: 'Choose Status' })).toBeVisible();
  next.release();
  await expectPropertySaved(page, f, 2, {
    [textField.id]: 'Newer typing',
    [statusField.id]: statusField.options[1].id,
    [dateField.id]: '2028-02-29',
  });
  await expect(page.getByRole('dialog', { name: 'Choose Status' })).toBeVisible();
  expect(await storedDraft(page)).toBeNull();
  expect(f.maxActive).toBe(1);
});

test('edit then revert to the old base during an accepted-but-held request queues the revert at its accepted revision', async ({
  page,
}) => {
  const f = await mockProperties(page);
  const field = f.schema.definitions[0];
  f.state.set(browserFixture.source.id, { revision: 3, values: { [field.id]: 'Original' } });
  const hold = f.holdNext('after');
  await openProperties(page);
  const text = page.getByLabel('Summary', { exact: true });
  await text.fill('Intermediate');
  await text.press('Tab');
  await hold.started;
  await text.fill('Original');
  await text.press('Tab');
  expect((await storedDraft(page)).values[field.id]).toBe('Original');
  const next = f.holdNext('after');
  hold.release();
  await next.started;
  expect(f.patches.map((p) => p.expectedRevision)).toEqual([3, 4]);
  expect(f.patches.map((p) => p.values)).toEqual([{ [field.id]: 'Intermediate' }, { [field.id]: 'Original' }]);
  expect((await storedDraft(page)).base.revision).toBe(4);
  next.release();
  await expectPropertySaved(page, f, 2, { [field.id]: 'Original' });
  await expect(text).toHaveValue('Original');
  expect(f.state.get(browserFixture.source.id)?.revision).toBe(5);
  expect(f.maxActive).toBe(1);
});

test('valid dates commit only on Enter/blur and invalid native partial input never clears or joins another save', async ({
  page,
}) => {
  await freezeClock(page);
  const f = await mockProperties(page);
  const [textField, , dateField] = f.schema.definitions;
  f.state.set(browserFixture.source.id, { revision: 0, values: { [dateField.id]: '2024-02-29' } });
  await openProperties(page);
  const date = page.getByLabel('Due date', { exact: true });
  await date.fill('2028-02-29');
  await page.clock.runFor(1000);
  expect(f.patches).toHaveLength(0);
  await date.press('Enter');
  await expectPropertySaved(page, f, 1, { [dateField.id]: '2028-02-29' });
  expect(f.patches[0].values).toEqual({ [dateField.id]: '2028-02-29' });
  await date.fill('');
  await date.pressSequentially('02'); // Native month filled, day/year incomplete: value='', badInput=true.
  expect(await date.evaluate((input: HTMLInputElement) => input.validity.badInput)).toBe(true);
  await expect(date).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('Summary', { exact: true }).fill('Independent text');
  await page.getByLabel('Summary', { exact: true }).press('Tab');
  await expect.poll(() => f.saves.length).toBe(2);
  await expect(propertyPanel(page)).toHaveAttribute('aria-busy', 'false');
  await expect.poll(async () => (await storedDraft(page))?.base.revision).toBe(2);
  await expect(page.getByRole('status')).toContainText('Unsaved date');
  expect(f.patches[1].values).toEqual({ [textField.id]: 'Independent text' });
  expect(f.state.get(browserFixture.source.id)?.values[dateField.id]).toBe('2028-02-29');
  expect((await storedDraft(page)).invalidDates).toContain(dateField.id);
  await page.getByRole('button', { name: 'Clear Due date', exact: true }).click();
  await expectPropertySaved(page, f, 3, { [dateField.id]: null });
  expect(f.patches[2].values).toEqual({ [dateField.id]: null });
  await date.fill('2024-02-29');
  await page.getByLabel('Summary', { exact: true }).focus(); // Tab may move between native date segments, not blur.
  await expectPropertySaved(page, f, 4, { [dateField.id]: '2024-02-29' });
  await date.fill('');
  await page.getByLabel('Summary', { exact: true }).focus();
  await expectPropertySaved(page, f, 5, { [dateField.id]: null });
  expect(f.patches[4].values).toEqual({ [dateField.id]: null });
  expect(f.maxActive).toBe(1);
});

test('a recovered partial date cannot turn into a clear on ordinary focus/blur or another field retry', async ({
  page,
}) => {
  await freezeClock(page);
  const f = await mockProperties(page);
  const [, statusField, dateField] = f.schema.definitions;
  f.state.set(browserFixture.source.id, { revision: 2, values: { [dateField.id]: '2028-02-29' } });
  await page.addInitScript(
    (draft) => sessionStorage.setItem('minunotes:properties-draft:note_source', JSON.stringify(draft)),
    {
      base: { schema: f.schema, revision: 2, values: { [dateField.id]: '2028-02-29' } },
      values: { [dateField.id]: '' },
      ready: [],
      invalidDates: [dateField.id],
      folderId: browserFixture.folder.id,
    }
  );
  await openProperties(page);
  await expect(page.getByRole('status')).toContainText('Recovered properties draft');
  await page.getByLabel('Due date', { exact: true }).focus();
  await page.getByLabel('Summary', { exact: true }).focus();
  await page.clock.runFor(1500);
  expect(f.patches).toHaveLength(0);
  await chooseStatus(page, 'Done');
  await page.getByRole('button', { name: 'Retry properties', exact: true }).click();
  await expect.poll(() => f.saves.length).toBe(1);
  await expect(propertyPanel(page)).toHaveAttribute('aria-busy', 'false');
  await expect.poll(async () => (await storedDraft(page))?.base.revision).toBe(3);
  await expect(page.getByRole('status')).toContainText('Unsaved date');
  expect(f.patches).toHaveLength(1);
  expect(f.patches[0]).toMatchObject({ expectedRevision: 2, values: { [statusField.id]: statusField.options[1].id } });
  expect(f.state.get(browserFixture.source.id)?.values[dateField.id]).toBe('2028-02-29');
  await page.getByRole('button', { name: 'Clear Due date', exact: true }).click();
  await expectPropertySaved(page, f, 2, { [dateField.id]: null });
  expect(f.patches[1].values).toEqual({ [dateField.id]: null });
});

test('explicit note-property review preserves a removed field for copying instead of dropping or replaying it', async ({
  page,
}) => {
  await freezeClock(page);
  const f = await mockProperties(page);
  const field = f.schema.definitions[0];
  f.controls.failNext = true;
  await openProperties(page);
  await page.getByLabel('Summary', { exact: true }).fill('Keep removed field work');
  await page.getByLabel('Summary', { exact: true }).press('Tab');
  await expect(page.getByRole('status')).toContainText("Couldn't save — changes kept");
  field.archived = true;
  f.changeSchema();
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('drafted field was archived or moved');
  await expect(page.getByLabel('Summary', { exact: true })).toHaveValue('Keep removed field work');
  expect((await storedDraft(page)).base.schema.revision).toBe(1);
  expect((await storedDraft(page)).values[field.id]).toBe('Keep removed field work');
  await page.clock.runFor(1500);
  expect(f.patches).toHaveLength(1);
  await page.getByRole('button', { name: 'Discard local unsaved changes', exact: true }).click();
  await expect(page.getByLabel('Summary', { exact: true })).toHaveCount(0);
  expect(f.patches).toHaveLength(1);
  expect(f.saves).toHaveLength(0);
});

test('failure pauses the whole serial queue: typing, timers and refocus never replay until explicit Retry', async ({
  page,
}) => {
  await freezeClock(page);
  const f = await mockProperties(page);
  const [textField, statusField] = f.schema.definitions;
  const hold = f.holdNext('before');
  await openProperties(page);
  await page.getByLabel('Summary', { exact: true }).fill('First');
  await page.getByLabel('Summary', { exact: true }).press('Tab');
  await hold.started;
  await chooseStatus(page, 'Done');
  await page.getByLabel('Summary', { exact: true }).fill('Queued later');
  f.controls.failNext = true;
  hold.release();
  await expect(page.getByRole('status')).toContainText("Couldn't save — changes kept");
  await page.getByLabel('Summary', { exact: true }).fill('Edited after failure');
  await page.clock.runFor(1500);
  await refocus(page);
  await page.getByLabel('Summary', { exact: true }).press('Tab');
  expect(f.patches).toHaveLength(1);
  await page.getByRole('button', { name: 'Retry properties', exact: true }).click();
  await expectPropertySaved(page, f, 1, {
    [textField.id]: 'Edited after failure',
    [statusField.id]: statusField.options[1].id,
  });
  expect(f.patches[1]).toMatchObject({
    expectedRevision: 0,
    schemaRevision: 1,
    values: { [textField.id]: 'Edited after failure', [statusField.id]: statusField.options[1].id },
  });
  expect(f.saves).toHaveLength(1);
  expect(f.maxActive).toBe(1);
});

test('a lost committed acknowledgement retries captured CAS, conflicts safely, and explicit review shows the saved value', async ({
  page,
}) => {
  await freezeClock(page);
  const f = await mockProperties(page);
  const field = f.schema.definitions[1];
  f.controls.loseResponseNext = true;
  await openProperties(page);
  await chooseStatus(page, 'Todo');
  await expect(page.getByRole('status')).toContainText("Couldn't save — changes kept");
  expect(f.state.get(browserFixture.source.id)?.revision).toBe(1);
  await page.getByRole('button', { name: 'Retry properties', exact: true }).click();
  await expect(page.getByRole('status')).toContainText("Couldn't save — changes kept");
  expect(f.patches.map((p) => p.expectedRevision)).toEqual([0, 0]);
  expect(f.saves).toHaveLength(1);
  await chooseStatus(page, 'Done');
  await page.clock.runFor(1500);
  expect(f.patches).toHaveLength(2);
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await expect(page.getByText('Current saved Status: Todo', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Status', { exact: true })).toHaveText('Done');
  expect(f.patches).toHaveLength(2);
  await page.getByRole('button', { name: 'Retry properties', exact: true }).click();
  await expectPropertySaved(page, f, 2, { [field.id]: field.options[1].id });
  expect(f.patches[2]).toMatchObject({ expectedRevision: 1, values: { [field.id]: field.options[1].id } });
});

test('recovered drafts wait for an authorized read and explicit review/retry, even after editing and focus', async ({
  page,
}) => {
  await freezeClock(page);
  const f = await mockProperties(page);
  const field = f.schema.definitions[0];
  await page.addInitScript(
    (draft) => sessionStorage.setItem('minunotes:properties-draft:note_source', JSON.stringify(draft)),
    {
      base: { schema: f.schema, revision: 0, values: {} },
      values: { [field.id]: 'Recovered work' },
      ready: [field.id],
      folderId: browserFixture.folder.id,
    }
  );
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/internal/notes/${browserFixture.source.id}/properties`, async (route) => {
    if (route.request().method() === 'GET') await gate;
    await route.fallback();
  });
  await page.goto(`/notes/${browserFixture.source.id}`);
  await expect(page.locator('.cm-content')).toBeVisible();
  await expect(page.getByLabel('Summary', { exact: true })).toHaveCount(0);
  release();
  await page.locator('summary').filter({ hasText: 'Properties' }).click();
  await expect(page.getByRole('status')).toContainText('Recovered properties draft');
  await page.getByLabel('Summary', { exact: true }).fill('Recovered and edited');
  await page.clock.runFor(1500);
  await refocus(page);
  expect(f.patches).toHaveLength(0);
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await expect(page.getByText('Current saved Summary: Not set', { exact: true })).toBeVisible();
  await page.clock.runFor(1500);
  expect(f.patches).toHaveLength(0);
  await page.getByRole('button', { name: 'Retry properties', exact: true }).click();
  await expectPropertySaved(page, f, 1, { [field.id]: 'Recovered and edited' });
  expect(f.saves[0].values).toEqual({ [field.id]: 'Recovered and edited' });
});

test('cached metadata never exposes a recovered draft before a new authorized mount read, including revocation', async ({
  page,
}) => {
  const f = await mockProperties(page);
  f.controls.failNext = true;
  await openProperties(page);
  await page.getByLabel('Summary', { exact: true }).fill('Private cached draft');
  await page.getByLabel('Summary', { exact: true }).press('Tab');
  await expect(page.getByRole('status')).toContainText("Couldn't save — changes kept");
  await spaToFolder(page);
  let release = () => {};
  let started = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route(`**/internal/notes/${browserFixture.source.id}/properties`, async (route) => {
    if (route.request().method() === 'GET') {
      started();
      await gate;
    }
    await route.fallback();
  });
  await page
    .locator(`a[href="/notes/${browserFixture.source.id}"]`)
    .first()
    .evaluate((link) => (link as HTMLAnchorElement).click());
  await reading;
  await expect(page.locator('.cm-content')).toBeVisible();
  await expect(page.getByLabel('Summary', { exact: true })).toHaveCount(0);
  f.controls.deny = true;
  release();
  await expect(page.getByText('Properties unavailable', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Summary', { exact: true })).toHaveCount(0);
  expect(await storedDraft(page)).toBeNull();
  expect(f.patches).toHaveLength(1);
});

test('unmount cancels a pending debounce without a hidden flush and meaningful property-only work remains recoverable', async ({
  page,
}) => {
  await freezeClock(page);
  const f = await mockProperties(page);
  await page.goto(`/folders/${browserFixture.folder.id}`);
  await page.getByRole('button', { name: 'New Note', exact: true }).click();
  await page.locator('summary').filter({ hasText: 'Properties' }).click();
  await page.getByLabel('Summary', { exact: true }).fill('Local property-only work');
  await spaToFolder(page);
  await page.clock.runFor(1500);
  expect(f.patches).toHaveLength(0);
  expect(f.body.trashMutationRequests).toHaveLength(0);
  expect(await page.evaluate(() => sessionStorage.getItem('minunotes:properties-draft:note_created_1'))).toContain(
    'Local property-only work'
  );
  await page
    .locator('a[href="/notes/note_created_1"]')
    .first()
    .evaluate((link) => (link as HTMLAnchorElement).click());
  await page.locator('summary').filter({ hasText: 'Properties' }).click();
  await expect(page.getByRole('status')).toContainText('Recovered properties draft');
  await expect(page.getByLabel('Summary', { exact: true })).toHaveValue('Local property-only work');
  await page.clock.runFor(1500);
  expect(f.patches).toHaveLength(0);
});

test('a late accepted response after note switch cannot clear the old draft or affect another note', async ({
  page,
}) => {
  const f = await mockProperties(page);
  const hold = f.holdNext('after');
  await openProperties(page);
  await page.getByLabel('Summary', { exact: true }).fill('Old note work');
  await page.getByLabel('Summary', { exact: true }).press('Tab');
  await hold.started;
  await spaToFolder(page);
  await page
    .locator(`a[href="/notes/${browserFixture.canvas.id}"]`)
    .first()
    .evaluate((link) => (link as HTMLAnchorElement).click());
  await openPropertiesModal(page);
  hold.release();
  await expect.poll(() => f.active).toBe(0);
  await expect(page.getByLabel('Summary', { exact: true })).toHaveValue('');
  await expect(propertyPanel(page)).toHaveAttribute('aria-busy', 'false');
  await expectQuietProperties(page);
  expect((await storedDraft(page)).values[f.schema.definitions[0].id]).toBe('Old note work');
  expect(f.patchResources).toEqual([browserFixture.source.id]);
});

test('a quick remount keeps the per-note lock and late acknowledgement cannot replay a recovered draft', async ({
  page,
}) => {
  const f = await mockProperties(page);
  const hold = f.holdNext('after');
  await openProperties(page);
  await chooseStatus(page, 'Todo');
  await hold.started;
  await spaToFolder(page);
  await page
    .locator(`a[href="/notes/${browserFixture.source.id}"]`)
    .first()
    .evaluate((link) => (link as HTMLAnchorElement).click());
  await page.locator('summary').filter({ hasText: 'Properties' }).click();
  await expect(page.getByRole('button', { name: 'Retry properties', exact: true })).toBeDisabled();
  expect(f.patches).toHaveLength(1);
  hold.release();
  await expect(page.getByRole('status')).toContainText('Recovered properties draft');
  await expect(page.getByRole('button', { name: 'Retry properties', exact: true })).toBeEnabled();
  expect(f.patches).toHaveLength(1);
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await expectPropertySaved(page, f, 1, { [f.schema.definitions[1].id]: f.schema.definitions[1].options[0].id });
  expect(await storedDraft(page)).toBeNull();
  expect(f.maxActive).toBe(1);
});

test('newer authorized metadata cache is not regressed by a late success; discard is local, not an undo', async ({
  page,
}) => {
  await freezeClock(page);
  const f = await mockProperties(page);
  const [textField, statusField] = f.schema.definitions;
  const hold = f.holdNext('after');
  await openProperties(page);
  await chooseStatus(page, 'Todo');
  await hold.started;
  await page.getByLabel('Summary', { exact: true }).fill('Later local edit');
  await page.clock.runFor(500);
  f.state.set(browserFixture.source.id, {
    revision: 2,
    values: { [statusField.id]: statusField.options[1].id, [textField.id]: 'Remote value' },
  });
  const read = page.waitForResponse(
    (r) => r.request().method() === 'GET' && r.url().endsWith(`/notes/${browserFixture.source.id}/properties`)
  );
  await refocus(page);
  await read;
  hold.release();
  await expect(page.getByRole('status')).toContainText('Properties changed while saving');
  expect(f.patches).toHaveLength(1);
  expect((await storedDraft(page)).base.revision).toBe(1);
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await expect(page.getByText('Current saved Summary: Remote value', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Discard local unsaved changes', exact: true }).click();
  await expect(page.getByLabel('Status', { exact: true })).toHaveText('Done');
  await expect(page.getByLabel('Summary', { exact: true })).toHaveValue('Remote value');
  expect(f.patches).toHaveLength(1);
  expect(f.state.get(browserFixture.source.id)?.revision).toBe(2);
});

test('folder/schema movement during an accepted response cannot rebase captured draft identities or revive its cache', async ({
  page,
}) => {
  await freezeClock(page);
  const f = await mockProperties(page);
  const hold = f.holdNext('after');
  await openProperties(page);
  await chooseStatus(page, 'Todo');
  await hold.started;
  await page.getByLabel('Summary', { exact: true }).fill('Captured old folder work');
  f.body.notes.set(browserFixture.source.id, { ...browserFixture.source, folderId: 'folder_child_browser' });
  f.schema.schemaId = 'schema_new_folder';
  f.schema.definitions[0].label = 'Replacement summary';
  const read = page.waitForResponse(
    (r) => r.request().method() === 'GET' && r.url().endsWith(`/notes/${browserFixture.source.id}/properties`)
  );
  await refocus(page);
  await read;
  await expect(page.getByRole('link', { name: 'Add a property', exact: true })).toHaveAttribute(
    'href',
    '/folders/folder_child_browser/settings'
  );
  hold.release();
  await expect.poll(() => f.active).toBe(0);
  await page.clock.runFor(1500);
  expect(f.patches).toHaveLength(1);
  const captured = await storedDraft(page);
  expect(captured.base.schema.schemaId).toBe('schema_browser');
  expect(captured.base.revision).toBe(0);
  await expect(page.getByLabel('Summary', { exact: true })).toHaveValue('Captured old folder work');
  await expect(page.getByLabel('Replacement summary', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Discard local unsaved changes', exact: true }).click();
  await expect(page.getByLabel('Replacement summary', { exact: true })).toBeVisible();
});

for (const theme of ['catppuccin-latte', 'catppuccin-mocha'])
  test(`quiet autosave and actionable recovery remain usable on mobile in ${theme}`, async ({ page }) => {
    await page.addInitScript((theme) => localStorage.setItem('notes-theme', theme), theme);
    const f = await mockProperties(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const hold = f.holdNext('after');
    await openProperties(page);
    await page.getByLabel('Summary', { exact: true }).fill('Synthetic autosave value');
    await page.getByLabel('Summary', { exact: true }).press('Tab');
    await hold.started;
    await expect(propertyPanel(page)).toHaveAttribute('aria-busy', 'true');
    await expectQuietProperties(page);
    expect(f.saves).toHaveLength(1); // Accepted server value isn't yet a local acknowledgement.
    expect((await storedDraft(page)).values[f.schema.definitions[0].id]).toBe('Synthetic autosave value');
    await page.screenshot({ path: test.info().outputPath(`quiet-pending-${theme}-390.png`) });
    hold.release();
    await expectPropertySaved(page, f, 1, { [f.schema.definitions[0].id]: 'Synthetic autosave value' });
    await page.screenshot({ path: test.info().outputPath(`quiet-${theme}-390.png`) });
    f.controls.failNext = true;
    await page.getByLabel('Summary', { exact: true }).fill('Synthetic kept changes');
    await page.getByLabel('Summary', { exact: true }).press('Tab');
    await expect(page.getByRole('status')).toContainText("Couldn't save — changes kept");
    await page.screenshot({ path: test.info().outputPath(`recovery-${theme}-390.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const attempts = f.patches.length;
    await page.getByRole('button', { name: 'Review changes', exact: true }).click();
    await expect(page.getByText('Current saved Summary: Synthetic autosave value', { exact: true })).toBeVisible();
    expect(f.patches).toHaveLength(attempts); // Review reads only; it never submits.
    await page.getByRole('button', { name: 'Retry properties', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expectPropertySaved(page, f, 2, { [f.schema.definitions[0].id]: 'Synthetic kept changes' });
    expect(f.state.get(browserFixture.source.id)?.values[f.schema.definitions[0].id]).toBe('Synthetic kept changes');
    const later = f.holdNext('after');
    await page.getByLabel('Summary', { exact: true }).fill('Ordinary edit after recovery');
    await page.getByLabel('Summary', { exact: true }).press('Tab');
    await later.started;
    await expectQuietProperties(page); // No stale comparison/footer follows a completed review.
    later.release();
    await expectPropertySaved(page, f, 3, { [f.schema.definitions[0].id]: 'Ordinary edit after recovery' });
  });

test('Select and clear autosave stable IDs/tokens immediately with keyboard/focus preserved during acknowledgement', async ({
  page,
}) => {
  const f = await mockProperties(page);
  const status = f.schema.definitions[1];
  const done = status.options[1];
  f.state.set(browserFixture.source.id, { revision: 4, values: { [status.id]: status.options[0].id } });
  await page.goto(`/notes/${browserFixture.source.id}`);
  await page.locator('summary').filter({ hasText: 'Properties' }).click();
  const trigger = page.getByLabel('Status', { exact: true });
  await expect(trigger).toHaveText('Todo');
  await trigger.focus();
  await page.keyboard.press('Enter');
  const picker = page.getByRole('dialog', { name: 'Choose Status' });
  await expect(picker.getByRole('button', { pressed: true })).toHaveText('Todo');
  await expect(picker.getByRole('button')).toHaveText(['Todo', 'Done', 'Not set']);
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(trigger).toBeFocused();
  const hold = f.holdNext('before');
  await page.keyboard.press('Space');
  await expect(picker.getByRole('button', { name: 'Todo', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(picker.getByRole('button', { name: 'Done', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await hold.started;
  await expect(picker).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveText('Done');
  await expect(propertyPanel(page)).toHaveAttribute('aria-busy', 'true');
  await expectQuietProperties(page);
  expect(f.patches).toEqual([
    { schemaId: f.schema.schemaId, schemaRevision: 1, expectedRevision: 4, values: { [status.id]: done.id } },
  ]);
  expect(f.state.get(browserFixture.source.id)?.values[status.id]).toBe(status.options[0].id);
  const stored = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem('minunotes:properties-draft:note_source') ?? 'null')
  );
  expect(stored.values).toEqual({ [status.id]: done.id });
  await trigger.click();
  hold.release();
  await expectPropertySaved(page, f, 1, { [status.id]: done.id });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('button', { pressed: true })).toHaveText('Done');
  await picker.getByRole('button', { name: 'Clear Status', exact: true }).click();
  await expect(trigger).toHaveText('Not set');
  await expect.poll(() => f.saves.length).toBe(2);
  expect(f.patches[1]).toMatchObject({ expectedRevision: 5, values: { [status.id]: null } });
  expect(f.state.get(browserFixture.source.id)?.values).not.toHaveProperty(status.id);
  expect(f.maxActive).toBe(1);
  await expect(page.getByRole('button', { name: 'Save properties', exact: true })).toHaveCount(0);
});

for (const retained of ['archived', 'unavailable'] as const)
  test(`a retained ${retained} selection stays explicit until intentionally cleared`, async ({ page }) => {
    const f = await mockProperties(page);
    const status = f.schema.definitions[1];
    const selectedId = retained === 'archived' ? status.options[0].id : 'option_unknown';
    if (retained === 'archived') status.options[0].archived = true;
    f.state.set(browserFixture.source.id, { revision: 1, values: { [status.id]: selectedId } });
    await page.goto(`/notes/${browserFixture.source.id}`);
    await page.locator('summary').filter({ hasText: 'Properties' }).click();
    const trigger = page.getByLabel('Status', { exact: true });
    await expect(trigger).toHaveText(retained === 'archived' ? 'Todo (archived)' : 'option_unknown (unavailable)');
    await expect(trigger).toHaveClass(/notes-muted/);
    await trigger.click();
    const picker = page.getByRole('dialog', { name: 'Choose Status' });
    await expect(picker.getByRole('button', { name: 'Todo', exact: true })).toHaveCount(
      retained === 'archived' ? 0 : 1
    );
    await page.keyboard.press('Escape');
    expect(f.patches).toHaveLength(0);
    expect(f.state.get(browserFixture.source.id)?.values[status.id]).toBe(selectedId);
    await page.getByRole('button', { name: 'Clear Status', exact: true }).click();
    await expect.poll(() => f.saves.length).toBe(1);
    expect(f.saves[0].values).toEqual({ [status.id]: null });
  });

test('rename/reorder never replaces captured draft labels or stable IDs until explicit reload', async ({ page }) => {
  const f = await mockProperties(page);
  const status = f.schema.definitions[1];
  const todoId = status.options[0].id;
  const hold = f.holdNext('before');
  await page.goto(`/notes/${browserFixture.source.id}`);
  await page.locator('summary').filter({ hasText: 'Properties' }).click();
  await page.getByLabel('Status', { exact: true }).click();
  await page.getByRole('dialog', { name: 'Choose Status' }).getByRole('button', { name: 'Todo', exact: true }).click();
  await hold.started;
  status.options[0].label = 'Queued';
  status.options.reverse();
  f.changeSchema();
  const read = page.waitForResponse(
    (r) => r.request().method() === 'GET' && r.url().endsWith(`/notes/${browserFixture.source.id}/properties`)
  );
  await refocus(page);
  await read;
  hold.release();
  await expect(page.getByRole('status')).toContainText('changes kept');
  await expect(page.getByLabel('Status', { exact: true })).toHaveText('Todo');
  await page.getByLabel('Status', { exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Choose Status' }).getByRole('button')).toHaveText([
    'Todo',
    'Done',
    'Not set',
  ]);
  await page.keyboard.press('Escape');
  expect(f.patches[0]).toMatchObject({ schemaRevision: 1, values: { [status.id]: todoId } });
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await expect(page.getByLabel('Status', { exact: true })).toHaveText('Queued');
  await page.getByLabel('Status', { exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Choose Status' }).getByRole('button')).toHaveText([
    'Done',
    'Queued',
    'Not set',
  ]);
  await page.keyboard.press('Escape');
  expect(f.patches).toHaveLength(1);
  await page.getByRole('button', { name: 'Retry properties', exact: true }).click();
  await expect.poll(() => f.saves.length).toBe(1);
  expect(f.saves[0]).toMatchObject({ schemaRevision: 2, values: { [status.id]: todoId } });
});

for (const accessLoss of ['revoked', 'viewer'] as const)
  test(`an open picker unmounts when access becomes ${accessLoss}`, async ({ page }) => {
    const f = await mockProperties(page);
    const hold = f.holdNext('after');
    await page.goto(`/notes/${browserFixture.source.id}`);
    await page.locator('summary').filter({ hasText: 'Properties' }).click();
    await page.getByLabel('Summary', { exact: true }).fill('Private draft');
    await page.getByLabel('Status', { exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Choose Status' })).toBeVisible();
    await hold.started;
    if (accessLoss === 'revoked') f.controls.deny = true;
    else f.body.setNoteAccessRole('viewer');
    await refocus(page);
    await expect(page.getByRole('dialog', { name: 'Choose Status' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Add a property', exact: true })).toHaveCount(0);
    if (accessLoss === 'revoked') {
      await expect(page.getByText('Properties unavailable', { exact: true })).toBeVisible();
      await expect(page.getByLabel('Status', { exact: true })).toHaveCount(0);
      await expect(page.getByText('Private draft', { exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => sessionStorage.getItem('minunotes:properties-draft:note_source'))).toBeNull();
    } else await expect(page.getByLabel('Status', { exact: true })).toBeDisabled();
    hold.release();
    await expect.poll(() => f.active).toBe(0);
    expect(f.patches).toHaveLength(1); // Began on authorized blur, never replayed after access loss.
    if (accessLoss === 'revoked') await expect(page.getByText('Properties unavailable', { exact: true })).toBeVisible();
    else await expect(page.getByLabel('Summary', { exact: true })).toHaveValue('Private draft');
  });

for (const role of ['owner', 'editor', 'viewer', 'commenter'] as const)
  test(`${role} gets only the authorized folder schema navigation with an empty schema`, async ({ page }) => {
    const f = await mockProperties(page, role);
    f.schema.definitions = [];
    const schemaRequests: string[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === schemaPath) schemaRequests.push(r.method());
    });
    const metadataRead = page.waitForResponse(
      (r) => r.request().method() === 'GET' && r.url().endsWith(`/notes/${browserFixture.source.id}/properties`)
    );
    await page.goto(`/notes/${browserFixture.source.id}`);
    await metadataRead;
    await expect(page.locator('.cm-content')).toBeVisible();
    const link = page.getByRole('link', { name: 'Add a property', exact: true });
    if (role === 'owner') {
      await page.locator('summary').filter({ hasText: 'Properties' }).click();
      await expect(link).toHaveAttribute('href', `/folders/${browserFixture.folder.id}/settings`);
      expect(schemaRequests).toEqual([]);
      await link.click();
      await expect(page).toHaveURL(`/folders/${browserFixture.folder.id}/settings`);
      await expect(page.getByRole('button', { name: 'Add property', exact: true })).toBeVisible();
    } else await expect(link).toHaveCount(0);
    expect(f.patches).toHaveLength(0);
    expect(f.schemaSaves).toHaveLength(0);
    expect(schemaRequests.every((method) => method === 'GET')).toBe(true);
  });

test('an unfiled owner note never advertises schema creation', async ({ page }) => {
  const f = await mockProperties(page);
  await page.route(`**/internal/notes/${browserFixture.source.id}`, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: {
            note: { ...browserFixture.source, folderId: null },
            contentHash: 'hash_1',
            access: { role: 'owner', source: 'owner' },
          },
        })
      : route.fallback()
  );
  f.schema.definitions = [];
  await page.goto(`/notes/${browserFixture.source.id}`);
  await expect(page.locator('.cm-content')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Add a property', exact: true })).toHaveCount(0);
  await expect(page.locator('summary').filter({ hasText: 'Properties' })).toHaveCount(0);
});

for (const theme of ['catppuccin-latte', 'catppuccin-mocha'])
  for (const width of [1280, 390])
    test(`compact long-label rows and picker fit ${theme} at ${width}px`, async ({ page }) => {
      await page.addInitScript((theme) => localStorage.setItem('notes-theme', theme), theme);
      const f = await mockProperties(page);
      const longLabel = 'Status for a deliberately long property label';
      const longOption = 'A deliberately long choice label with enough words to wrap safely on a narrow viewport';
      f.schema.definitions[1].label = longLabel;
      f.schema.definitions[1].options[1].label = longOption;
      f.state.set(browserFixture.source.id, {
        revision: 0,
        values: { [f.schema.definitions[1].id]: f.schema.definitions[1].options[1].id },
      });
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/notes/${browserFixture.source.id}`);
      await page.locator('summary').filter({ hasText: 'Properties' }).click();
      await expect(page.getByLabel(longLabel, { exact: true })).toHaveText(longOption);
      await expect(page.locator('html')).toHaveClass(new RegExp(`theme-${theme}`));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`rows-${theme}-${width}.png`) });
      await page.getByLabel(longLabel, { exact: true }).click();
      const picker = page.getByRole('dialog', { name: `Choose ${longLabel}` });
      await expect(picker).toBeVisible();
      const bounds = await picker.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds?.x).toBeGreaterThanOrEqual(0);
      expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width);
      await expect(picker.getByRole('button', { pressed: true })).toHaveText(longOption);
      await page.screenshot({ path: test.info().outputPath(`picker-${theme}-${width}.png`) });
      await page.keyboard.press('Escape');
      await expect(page.getByLabel(longLabel, { exact: true })).toBeFocused();
      expect(f.patches).toHaveLength(0);
    });

for (const theme of ['catppuccin-latte', 'catppuccin-mocha'])
  for (const documentType of ['markdown', 'canvas.default', 'canvas.mindmap'] as const)
    test(`quiet properties match the ${documentType} note shell in ${theme}`, async ({ page }) => {
      await page.addInitScript((theme) => localStorage.setItem('notes-theme', theme), theme);
      const f = await mockProperties(page);
      const canvas = documentType !== 'markdown';
      if (canvas) f.body.notes.set(browserFixture.canvas.id, { ...browserFixture.canvas, documentType });
      await page.setViewportSize({ width: 390, height: 844 });
      await openProperties(page, canvas ? browserFixture.canvas.id : browserFixture.source.id);
      await expect(page.locator('html')).toHaveClass(new RegExp(`theme-${theme}`));
      await expectQuietProperties(page);
      await expect(propertyPanel(page)).toHaveAttribute('aria-busy', 'false');
      const shell = canvas
        ? page.locator('.notes-minu-canvas').locator('xpath=ancestor::section[1]')
        : page.locator('.cm-content').locator('xpath=ancestor::div[contains(@class,"overflow-x-hidden")][1]');
      const background = theme === 'catppuccin-latte' ? 'rgb(239, 241, 245)' : 'rgb(30, 30, 46)';
      const floatingSurface = theme === 'catppuccin-latte' ? 'rgb(255, 255, 255)' : 'rgb(24, 24, 37)';
      await expect(shell).toHaveCSS('background-color', background);
      if (canvas)
        await expect(page.getByRole('dialog', { name: 'Properties', exact: true })).toHaveCSS(
          'background-color',
          floatingSurface
        );
      else await expect(propertyPanel(page)).toHaveCSS('background-color', background);
      if (canvas) await expect(page.locator('.notes-minu-canvas')).toHaveCSS('background-color', floatingSurface);
      await page.screenshot({ path: test.info().outputPath(`quiet-${documentType}-${theme}-390.png`) });
      await page.getByLabel('Status', { exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Choose Status' })).toHaveCSS('background-color', floatingSurface);
      await page.keyboard.press('Escape');
      expect(f.patches).toHaveLength(0);
    });

test('Select draft/save leaves independent canvas body editing and its hash untouched', async ({ page }) => {
  const f = await mockProperties(page);
  const bodyReads: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'GET' && new URL(r.url()).pathname === `/internal/notes/${browserFixture.canvas.id}`)
      bodyReads.push(r.url());
  });
  await page.goto(`/notes/${browserFixture.canvas.id}`);
  await page.getByRole('button', { name: 'Rectangle (R)' }).click();
  await page.getByLabel('Canvas editor').click({ position: { x: 400, y: 300 } });
  await expect(page.locator('[data-minucanvas-node-id]')).toHaveCount(1);
  await openPropertiesModal(page);
  await page.getByLabel('Status', { exact: true }).click();
  await page.getByRole('dialog', { name: 'Choose Status' }).getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(() => f.saves.length).toBe(1);
  await expect.poll(() => f.body.notes.get(browserFixture.canvas.id)?.content).toContain('rectangle');
  expect(bodyReads).toHaveLength(1);
  expect(f.body.saveRequests.find((r) => r.noteId === browserFixture.canvas.id)).toMatchObject({
    body: { baseHash: 'hash_1' },
  });
  expect(f.patches[0]).not.toHaveProperty('baseHash');
  await expect(page.locator('[data-minucanvas-node-id]')).toHaveCount(1);
});

test('a new property-only note is not automatically trashed after metadata is saved and cleared', async ({ page }) => {
  const f = await mockProperties(page);
  await page.goto(`/folders/${browserFixture.folder.id}`);
  await page.getByRole('button', { name: 'New Note', exact: true }).click();
  await expect(page).toHaveURL('/notes/note_created_1');
  await page.locator('summary').filter({ hasText: 'Properties' }).click();
  await page.getByLabel('Summary', { exact: true }).fill('Meaningful draft');
  await page.getByLabel('Summary', { exact: true }).press('Tab');
  await expectPropertySaved(page, f, 1, { [f.schema.definitions[0].id]: 'Meaningful draft' }, 'note_created_1');
  await expect.poll(() => f.saves.length).toBe(1);
  await page.getByRole('button', { name: 'Clear Summary', exact: true }).click();
  await expect.poll(() => f.saves.length).toBe(2);
  await page
    .getByRole('navigation', { name: 'Breadcrumb' })
    .getByRole('link', { name: browserFixture.folder.title, exact: true })
    .click();
  await expect(page).toHaveURL(`/folders/${browserFixture.folder.id}`);
  expect(f.body.trashMutationRequests).toHaveLength(0);
  expect(f.body.notes.get('note_created_1')?.content).toBe('');
});
for (const theme of ['catppuccin-latte', 'catppuccin-mocha'])
  test(`properties keyboard controls remain usable in ${theme}`, async ({ page }) => {
    await page.addInitScript((theme) => localStorage.setItem('notes-theme', theme), theme);
    const f = await mockProperties(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/notes/${browserFixture.source.id}`);
    const summary = page.locator('summary').filter({ hasText: 'Properties' });
    await summary.focus();
    await page.keyboard.press('Enter');
    await page.getByLabel('Summary', { exact: true }).focus();
    await page.keyboard.type('Keyboard value');
    await page.keyboard.press('Tab');
    await expect.poll(() => f.saves.length).toBe(1);
    await expect(page.locator('html')).toHaveClass(new RegExp(`theme-${theme}`));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
test('settings enforce Select option and active field limits without losing an invalid dialog draft', async ({
  page,
}) => {
  const f = await mockProperties(page);
  await page.goto(`/folders/${browserFixture.folder.id}/settings`);
  await page.getByRole('button', { name: 'Add property', exact: true }).click();
  await page.getByLabel('Label', { exact: true }).fill('Too many');
  await page.getByLabel('Type', { exact: true }).selectOption('select');
  await page
    .getByLabel('Options (comma-separated)', { exact: true })
    .fill('One, Two, Three, Four, Five, Six, Seven, Eight, Nine');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('1–8');
  await expect(page.getByLabel('Label', { exact: true })).toHaveValue('Too many');
  await page.keyboard.press('Escape');
  let n = 0;
  for (let i = 3; i < 12; i++)
    f.schema.definitions = mutatePropertyDefinitions(
      f.schema.definitions,
      { type: 'add', label: `Limit ${i}`, fieldType: 'text' },
      (prefix) => `${prefix}_limit_${++n}`
    );
  await page.reload();
  await expect(page.getByRole('button', { name: 'Add property', exact: true })).toBeDisabled();
});
test('archiving a drafted Select choice preserves it on reload until explicitly cleared', async ({ page }) => {
  const f = await mockProperties(page);
  f.controls.conflictNext = true;
  await page.goto(`/notes/${browserFixture.source.id}`);
  await page.locator('summary').filter({ hasText: 'Properties' }).click();
  await page.getByLabel('Status', { exact: true }).click();
  await page.getByRole('dialog', { name: 'Choose Status' }).getByRole('button', { name: 'Todo', exact: true }).click();
  await expect(page.getByRole('status')).toContainText("Couldn't save");
  f.schema.definitions[1].options[0].archived = true;
  f.changeSchema();
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('drafted choice was archived');
  await expect(page.getByLabel('Status', { exact: true })).toHaveText('Todo');
  const capturedDraft = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem('minunotes:properties-draft:note_source') ?? 'null')
  );
  expect(capturedDraft.values[f.schema.definitions[1].id]).toBe(f.schema.definitions[1].options[0].id);
  expect(f.patches).toHaveLength(1);
  await page.getByRole('button', { name: 'Clear Status', exact: true }).click();
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await expect(page.getByLabel('Status', { exact: true })).toHaveText('Not set');
  expect(f.saves).toHaveLength(0); // Reviewed null already matches the server: no revision churn.
  expect(f.patches).toHaveLength(1);
});
test('Text/Select/Date and Clear save only metadata while a dirty Markdown body remains intact', async ({ page }) => {
  const f = await mockProperties(page);
  const bodyReads: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'GET' && new URL(r.url()).pathname === `/internal/notes/${browserFixture.source.id}`)
      bodyReads.push(r.url());
  });
  await page.goto(`/notes/${browserFixture.source.id}`);
  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible();
  await page.locator('summary').filter({ hasText: 'Properties' }).click();
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' dirty body');
  const hold = f.holdNext('before');
  await page.getByLabel('Summary', { exact: true }).fill('Plain <b>text</b>');
  await page.getByLabel('Status', { exact: true }).click();
  await page.getByRole('dialog', { name: 'Choose Status' }).getByRole('button', { name: 'Done', exact: true }).click();
  await hold.started;
  await page.getByLabel('Due date', { exact: true }).fill('2024-02-29');
  await page.getByLabel('Due date', { exact: true }).press('Enter');
  hold.release();
  await expect.poll(() => f.saves.length).toBe(2);
  await expectPropertySaved(page, f, 2, {
    [f.schema.definitions[0].id]: 'Plain <b>text</b>',
    [f.schema.definitions[1].id]: f.schema.definitions[1].options[1].id,
    [f.schema.definitions[2].id]: '2024-02-29',
  });
  await expect(editor).toContainText('Start here. dirty body');
  expect(bodyReads).toHaveLength(1);
  expect(f.saves).toHaveLength(2);
  for (const patch of f.saves) expect(patch).not.toHaveProperty('baseHash');
  await f.body.expectSavedContent('Start here. dirty body');
  const text = f.schema.definitions[0];
  expect(f.state.get(browserFixture.source.id)?.values[text.id]).toBe('Plain <b>text</b>');
  await page.getByRole('button', { name: 'Clear Summary', exact: true }).click();
  await expect.poll(() => f.saves.length).toBe(3);
  expect(f.state.get(browserFixture.source.id)?.values).not.toHaveProperty(text.id);
});
test('stale metadata conflicts and ordinary failures preserve drafts, and reload never replaces the body', async ({
  page,
}) => {
  const f = await mockProperties(page);
  await page.goto(`/notes/${browserFixture.source.id}`);
  await page.locator('summary').filter({ hasText: 'Properties' }).click();
  await page.getByLabel('Summary', { exact: true }).fill('Keep this draft');
  f.controls.conflictNext = true;
  await page.getByLabel('Summary', { exact: true }).press('Tab');
  await expect(page.getByRole('status')).toContainText("Couldn't save — changes kept");
  await expect(page.getByLabel('Summary', { exact: true })).toHaveValue('Keep this draft');
  await page.reload();
  await page.locator('summary').filter({ hasText: 'Properties' }).click();
  await expect(page.getByLabel('Summary', { exact: true })).toHaveValue('Keep this draft');
  await expect(page.getByRole('status')).toContainText('Recovered properties draft');
  expect(f.patches).toHaveLength(1);
  f.controls.failNext = true;
  await page.getByRole('button', { name: 'Retry properties', exact: true }).click();
  await expect(page.getByRole('status')).toContainText("Couldn't save — changes kept");
  f.state.set(browserFixture.source.id, {
    revision: 10,
    values: { [f.schema.definitions[0].id]: 'Someone else saved this' },
  });
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await expect(page.getByText('Current saved Summary: Someone else saved this', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Summary', { exact: true })).toHaveValue('Keep this draft');
  await expect(page.locator('.cm-content')).toContainText('Start here.');
  expect(f.patches).toHaveLength(2);
  await page.getByRole('button', { name: 'Retry properties', exact: true }).click();
  await expect.poll(() => f.saves.length).toBe(1);
  expect(f.saves[0].expectedRevision).toBe(10);
});
for (const role of ['viewer', 'commenter'] as const)
  test(`${role} has read-only property controls`, async ({ page }) => {
    await mockProperties(page, role);
    await page.goto(`/notes/${browserFixture.source.id}`);
    await page.locator('summary').filter({ hasText: 'Properties' }).click();
    await expect(page.getByLabel('Summary', { exact: true })).toHaveAttribute('readonly', '');
    await expect(page.getByLabel('Status', { exact: true })).toBeDisabled();
    await expect(page.getByRole('link', { name: 'Add a property', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save properties', exact: true })).toHaveCount(0);
  });
for (const type of ['canvas.default', 'canvas.mindmap'] as const)
  test(`${type} metadata modal is outside the canvas and works at mobile size`, async ({ page }) => {
    const f = await mockProperties(page, 'editor');
    f.body.notes.set(browserFixture.canvas.id, { ...browserFixture.canvas, documentType: type });
    await page.setViewportSize({ width: 390, height: 844 });
    await openProperties(page, browserFixture.canvas.id);
    await expect(page.getByRole('link', { name: 'Add a property', exact: true })).toHaveCount(0);
    await page.getByLabel('Summary', { exact: true }).fill('Canvas property');
    await page.getByLabel('Summary', { exact: true }).press('Tab');
    await expect.poll(() => f.saves.length).toBe(1);
    expect(f.body.notes.get(browserFixture.canvas.id)?.content).toBe('{"nodes":[],"edges":[]}');
    await expect(page.locator('.notes-minu-canvas')).toBeVisible();
  });
test('access revocation clears metadata and the preserved properties draft without blocking the body editor', async ({
  page,
}) => {
  const f = await mockProperties(page);
  await page.goto(`/notes/${browserFixture.source.id}`);
  await page.locator('summary').filter({ hasText: 'Properties' }).click();
  await page.getByLabel('Summary', { exact: true }).fill('Private draft');
  f.controls.deny = true;
  await page.getByLabel('Summary', { exact: true }).press('Tab');
  await expect(page.getByText('Properties unavailable', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Summary', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('minunotes:properties-draft:note_source'))).toBeNull();
  await expect(page.locator('.cm-content')).toContainText('Start here.');
});
for (const theme of ['catppuccin-latte', 'catppuccin-mocha'])
  for (const width of [1280, 390])
    test(`folder manager stays flat, contextual and keyboard-safe in ${theme} at ${width}px`, async ({ page }) => {
      await page.addInitScript((theme) => localStorage.setItem('notes-theme', theme), theme);
      const f = await mockProperties(page);
      const writes = trackSchemaWrites(page);
      const longName = 'Status with a deliberately long property name that wraps on narrow screens';
      const longOption = 'A deliberately long option label that wraps without leaving the viewport';
      f.schema.definitions[1].label = longName;
      f.schema.definitions[1].options[1].label = longOption;
      let id = 0;
      f.schema.definitions = mutatePropertyDefinitions(
        f.schema.definitions,
        { type: 'add', label: 'Other Select', fieldType: 'select', options: ['Other choice', 'Another choice'] },
        (prefix) => `${prefix}_manager_${++id}`
      );
      const before = structuredClone(f.schema);
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/folders/${browserFixture.folder.id}/settings`);
      const list = page.getByRole('list', { name: 'Folder properties', exact: true });
      await list.scrollIntoViewIfNeeded();
      await expect(list.getByRole('listitem')).toHaveCount(4);
      await expect(list.getByRole('button')).toHaveCount(8); // Name + ellipsis only, never a button wall.
      expect(
        await list
          .getByRole('listitem')
          .evaluateAll((rows) => rows.every((row) => getComputedStyle(row).borderTopWidth === '0px'))
      ).toBe(true);
      await expect(page.getByText('Properties for notes in this folder.', { exact: true })).toBeVisible();
      await expect(page.getByText(/The board still groups by tags/)).toHaveCount(0);
      await expect(page.getByRole('button', { name: /^Rename / })).toHaveCount(0);
      await expect(page.getByRole('list', { name: /^Options for / })).toHaveCount(0);
      await list.locator('..').screenshot({ path: test.info().outputPath(`manager-list-${theme}-${width}.png`) });
      const trigger = page.getByRole('button', { name: `Manage ${longName}`, exact: true });
      const actionTrigger = page.getByRole('button', { name: `Actions for property ${longName}`, exact: true });
      await expect(list.getByText(/^(Text|Select|Date)$/)).toHaveCount(0);
      await expect(trigger.locator('svg[aria-hidden="true"]')).toHaveCount(1);
      await expectWholeSchemaRow(
        page,
        trigger.locator('..'),
        trigger,
        actionTrigger,
        test.info().outputPath(`manager-polish-property-row-${theme}-${width}.png`)
      );
      await trigger.focus();
      await page.keyboard.press('Enter');
      const manager = page.getByRole('dialog', { name: `Manage property ${longName}`, exact: true });
      await expect(manager).toBeVisible();
      await expect(manager.getByText('Select', { exact: true })).toBeVisible();
      await expect(manager.getByText('Archiving preserves saved values.', { exact: true })).toHaveCount(0);
      const optionName = manager.getByRole('button', { name: `Rename option ${longOption}`, exact: true });
      const optionEllipsis = manager.getByRole('button', { name: `Actions for option ${longOption}`, exact: true });
      await expectWholeSchemaRow(
        page,
        optionName.locator('..'),
        optionName,
        optionEllipsis,
        test.info().outputPath(`manager-polish-option-row-${theme}-${width}.png`)
      );
      await expect(manager.getByRole('textbox')).toHaveCount(0);
      await expect(manager.getByRole('button', { name: /^Rename option / })).toHaveCount(2);
      await expect(page.getByRole('button', { name: 'Rename option Other choice', exact: true })).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath(`manager-options-${theme}-${width}.png`) });
      await schemaOptionActions(page, longName, longOption);
      const optionActions = page.getByRole('dialog', { name: `Actions for option ${longOption}`, exact: true });
      await expect(optionActions.getByRole('button')).toHaveText(['Move up', 'Move down', 'Delete option']);
      await expectMoveIcon(
        optionActions.getByRole('button', { name: `Move option ${longOption} up`, exact: true }),
        'up'
      );
      await expectMoveIcon(
        optionActions.getByRole('button', { name: `Move option ${longOption} down`, exact: true }),
        'down'
      );
      await expect(
        optionActions.getByRole('button', { name: `Move option ${longOption} down`, exact: true })
      ).toBeDisabled();
      await expect(page.getByRole('menu')).toHaveCount(0);
      await expect(page.getByRole('listbox')).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath(`manager-option-actions-${theme}-${width}.png`) });
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: `Actions for option ${longOption}`, exact: true })).toBeFocused();
      await expect(manager).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
      await actionTrigger.focus();
      await page.keyboard.press('Space');
      const actions = page.getByRole('dialog', { name: `Actions for property ${longName}`, exact: true });
      await expect(actions.getByRole('button')).toHaveText(['Rename', 'Move up', 'Move down', 'Archive']);
      await expectMoveIcon(actions.getByRole('button', { name: `Move ${longName} up`, exact: true }), 'up');
      await expectMoveIcon(actions.getByRole('button', { name: `Move ${longName} down`, exact: true }), 'down');
      await page.keyboard.press('Tab');
      await expect(actions.getByRole('button', { name: `Move ${longName} up`, exact: true })).toBeFocused();
      await page.screenshot({ path: test.info().outputPath(`manager-property-actions-${theme}-${width}.png`) });
      await page.keyboard.press('Escape');
      await expect(actionTrigger).toBeFocused();
      await renameSchemaProperty(page, longName);
      await expect(page.getByRole('dialog')).toHaveCount(1);
      await expect(page.getByLabel('Type', { exact: true })).toHaveCount(0);
      await expect(page.getByText('Type: Select', { exact: true })).toHaveCount(0);
      await expect(page.getByText('Types cannot be changed.', { exact: true })).toHaveCount(0);
      await expect(page.getByText(/Archiving preserves saved values/)).toHaveCount(0);
      await page.getByLabel('Label', { exact: true }).fill('Unsaved property name kept');
      await page
        .getByRole('button', { name: 'Manage Summary', exact: true, includeHidden: true })
        .evaluate((button: HTMLButtonElement) => button.click());
      await expect(page.getByLabel('Label', { exact: true })).toHaveValue('Unsaved property name kept');
      await expect(page.getByRole('button', { name: /^Rename option / })).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath(`manager-editor-${theme}-${width}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
      expect(writes).toHaveLength(0);
      expect(f.schemaSaves).toHaveLength(0);
      expect(f.patches).toHaveLength(0);
      expect(f.schema).toEqual(before);
    });

test('Text and Date managers have immutable type context without irrelevant Select options or writes', async ({
  page,
}) => {
  const f = await mockProperties(page);
  await page.goto(`/folders/${browserFixture.folder.id}/settings`);
  for (const [label, type] of [
    ['Summary', 'Text'],
    ['Due date', 'Date'],
  ]) {
    const manager = await manageSchemaProperty(page, label);
    await expect(manager.getByText(type, { exact: true })).toBeVisible();
    await expect(manager.getByRole('list')).toHaveCount(0);
    await expect(manager.getByRole('button', { name: /Add option/ })).toHaveCount(0);
    await manager.getByRole('button', { name: `Rename ${label}`, exact: true }).click();
    await expect(page.getByText(`Type: ${type}`, { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Type', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: `Manage ${label}`, exact: true })).toBeFocused();
  }
  expect(f.schemaSaves).toHaveLength(0);
});

test('contextual option add/rename/delete clears only selected values, with last-option guards intact', async ({
  page,
}) => {
  const f = await mockProperties(page);
  const writes = trackSchemaWrites(page);
  const field = f.schema.definitions[1],
    selected = field.options[0];
  f.state.set(browserFixture.source.id, { revision: 5, values: { [field.id]: selected.id } });
  const values = structuredClone(f.state.get(browserFixture.source.id));
  await page.goto(`/folders/${browserFixture.folder.id}/settings`);
  await renameSchemaOption(page, field.label, selected.label);
  await page.getByLabel('Label', { exact: true }).fill('Queued');
  expect(f.schemaSaves).toHaveLength(0);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await (await manageSchemaProperty(page, field.label))
    .getByRole('button', { name: `Add option to ${field.label}`, exact: true })
    .click();
  await page.getByLabel('Label', { exact: true }).fill('Later');
  expect(f.schemaSaves).toHaveLength(1);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Edit property', exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: `Manage property ${field.label}`, exact: true })).toBeVisible();
  const added = f.schema.definitions[1].options.at(-1);
  expect(added).toMatchObject({ label: 'Later', archived: false });
  await schemaOptionActions(page, field.label, 'Later');
  await page.getByRole('button', { name: 'Delete option Later', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Delete “Later”?', exact: true })
    .getByRole('button', { name: 'Delete option', exact: true })
    .click();
  await expect.poll(() => f.optionDeletions.length).toBe(1);
  await expect(page.getByRole('dialog', { name: 'Delete “Later”?', exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Manage property Status', exact: true })).toBeVisible();
  expect(f.state.get(browserFixture.source.id)).toEqual(values);
  await expect(page.getByRole('button', { name: 'Rename option Later', exact: true })).toHaveCount(0);
  await schemaOptionActions(page, field.label, 'Queued');
  await page.getByRole('button', { name: 'Delete option Queued', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Delete “Queued”?', exact: true })
    .getByRole('button', { name: 'Delete option', exact: true })
    .click();
  await expect.poll(() => f.optionDeletions.length).toBe(2);
  await expect(page.getByRole('dialog', { name: 'Delete “Queued”?', exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Manage property Status', exact: true })).toBeVisible();
  await schemaOptionActions(page, field.label, 'Done');
  await expect(page.getByRole('button', { name: 'Move option Done up', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Move option Done down', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Delete option Done', exact: true })).toBeDisabled();
  expect(writes.map((w) => w.expectedRevision)).toEqual([1, 2]);
  expect(writes.map((w) => w.mutation)).toEqual([
    { type: 'rename_option', propertyId: field.id, optionId: selected.id, label: 'Queued' },
    { type: 'add_option', propertyId: field.id, label: 'Later' },
  ]);
  expect(
    f.optionDeletions.map(({ propertyId, optionId, expectedRevision }) => ({ propertyId, optionId, expectedRevision }))
  ).toEqual([
    { propertyId: field.id, optionId: added?.id, expectedRevision: 3 },
    { propertyId: field.id, optionId: selected.id, expectedRevision: 4 },
  ]);
  expect(f.schema.definitions[1].options.map((o) => o.id)).toEqual([field.options[1].id]);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await schemaPropertyActions(page, field.label);
  await page.getByRole('button', { name: `Archive ${field.label}`, exact: true }).click();
  await expect(page.getByRole('button', { name: `Manage ${field.label}`, exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(f.state.get(browserFixture.source.id)).toEqual({ revision: 6, values: {} });
  expect(f.patches).toHaveLength(0);
  expect(writes[2]).toEqual({ expectedRevision: 5, mutation: { type: 'archive', propertyId: field.id } });
});

for (const width of [390, 1280])
  test(`option deletion previews impact and Cancel/Escape never write at ${width}px`, async ({ page }) => {
    const f = await mockProperties(page);
    await page.setViewportSize({ width, height: 844 });
    const field = f.schema.definitions[1],
      option = field.options[0];
    f.state.set('moved-note', { revision: 1, values: { [field.id]: option.id } });
    f.state.set('trashed-note', { revision: 2, values: { [field.id]: option.id } });
    f.templateDefaults.set('assignment', { revision: 1, values: { [field.id]: option.id } });
    await page.goto(`/folders/${browserFixture.folder.id}/settings`);
    const open = async () => {
      await schemaOptionActions(page, field.label, option.label);
      const action = page.getByRole('button', { name: `Delete option ${option.label}`, exact: true });
      await expect(action.locator('svg[aria-hidden="true"]')).toHaveCount(1);
      await action.click();
      return page.getByRole('dialog', { name: 'Delete “Todo”?', exact: true });
    };
    let dialog = await open();
    await expect(dialog.getByText('Status will be cleared on 2 notes.', { exact: true })).toBeVisible();
    await expect(
      dialog.getByText('The option will also be cleared from 1 template default.', { exact: true })
    ).toBeVisible();
    await expect(
      dialog.getByText('Includes retained values on moved notes and notes in Trash.', { exact: true })
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Manage property Status', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Actions for option Todo', exact: true })).toBeFocused();
    dialog = await open();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Manage property Status', exact: true })).toBeVisible();
    expect(f.deletionAttempts).toHaveLength(0);
    expect(f.optionDeletions).toHaveLength(0);
    expect(f.schemaSaves).toHaveLength(0);
  });

test('confirmed option deletion clears notes/defaults, keeps the manager open, and notes show Not set', async ({
  page,
}) => {
  const f = await mockProperties(page);
  const field = f.schema.definitions[1],
    option = field.options[0];
  f.state.set(browserFixture.source.id, {
    revision: 2,
    values: { [field.id]: option.id, [f.schema.definitions[0].id]: 'Kept' },
  });
  f.templateDefaults.set('assignment', { revision: 3, values: { [field.id]: option.id, retained: 'Kept' } });
  const beforeBody = f.body.notes.get(browserFixture.source.id)?.content;
  await page.goto(`/folders/${browserFixture.folder.id}/settings`);
  await schemaOptionActions(page, field.label, option.label);
  await page.getByRole('button', { name: 'Delete option Todo', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete “Todo”?', exact: true });
  await expect(dialog.getByText('Status will be cleared on 1 note.', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete option', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Manage property Status', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rename option Todo', exact: true })).toHaveCount(0);
  expect(f.optionDeletions).toHaveLength(1);
  expect(f.state.get(browserFixture.source.id)).toEqual({
    revision: 3,
    values: { [f.schema.definitions[0].id]: 'Kept' },
  });
  expect(f.templateDefaults.get('assignment')).toEqual({ revision: 4, values: { retained: 'Kept' } });
  expect(f.body.notes.get(browserFixture.source.id)?.content).toBe(beforeBody);
  expect(f.patches).toHaveLength(0);
  await page.goto(`/notes/${browserFixture.source.id}`);
  await page.locator('summary').filter({ hasText: 'Properties' }).click();
  await expect(page.getByLabel('Status', { exact: true })).toHaveText('Not set');
  await page.getByLabel('Status', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Todo', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
});

test('changed deletion impact requires a fresh explicit preview and a second confirmation', async ({ page }) => {
  const f = await mockProperties(page);
  const field = f.schema.definitions[1],
    option = field.options[0];
  f.state.set('first', { revision: 1, values: { [field.id]: option.id } });
  await page.goto(`/folders/${browserFixture.folder.id}/settings`);
  await schemaOptionActions(page, field.label, option.label);
  await page.getByRole('button', { name: 'Delete option Todo', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete “Todo”?', exact: true });
  await expect(dialog.getByText('Status will be cleared on 1 note.', { exact: true })).toBeVisible();
  f.state.delete('first');
  f.state.set('replacement', { revision: 1, values: { [field.id]: option.id } });
  await dialog.getByRole('button', { name: 'Delete option', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Deletion impact changed');
  await expect(dialog.getByRole('button', { name: 'Delete option', exact: true })).toBeDisabled();
  expect(f.deletionAttempts).toHaveLength(1);
  expect(f.optionDeletions).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Review impact again', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Delete option', exact: true })).toBeEnabled();
  expect(f.deletionAttempts).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Delete option', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(f.optionDeletions).toHaveLength(1);
  expect(f.deletionAttempts).toHaveLength(2);
});

test('a failed deletion preview cannot confirm until a successful explicit review', async ({ page }) => {
  const f = await mockProperties(page);
  await page.goto(`/folders/${browserFixture.folder.id}/settings`);
  const pattern = '**/properties/*/options/*/deletion-preview';
  await page.route(pattern, (route) => route.fulfill({ status: 500, json: { error: 'Preview failed' } }));
  await schemaOptionActions(page, 'Status', 'Todo');
  await page.getByRole('button', { name: 'Delete option Todo', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete “Todo”?', exact: true });
  await expect(dialog.getByRole('alert')).toContainText('Preview failed');
  await expect(dialog.getByRole('button', { name: 'Delete option', exact: true })).toBeDisabled();
  expect(f.deletionAttempts).toHaveLength(0);
  await page.unroute(pattern);
  await dialog.getByRole('button', { name: 'Review impact again', exact: true }).click();
  await expect(dialog.getByText('Status will be cleared on 0 notes.', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Delete option', exact: true })).toBeEnabled();
  expect(f.optionDeletions).toHaveLength(0);
});

test('deletion disables dismissal and duplicate writes while pending, then reopens the manager', async ({ page }) => {
  const f = await mockProperties(page);
  await page.goto(`/folders/${browserFixture.folder.id}/settings`);
  await schemaOptionActions(page, 'Status', 'Todo');
  await page.getByRole('button', { name: 'Delete option Todo', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete “Todo”?', exact: true });
  await expect(dialog.getByText('Status will be cleared on 0 notes.', { exact: true })).toBeVisible();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/properties/*/options/*', async (route) => {
    if (route.request().method() === 'DELETE') await held;
    await route.fallback();
  });
  try {
    await dialog.getByRole('button', { name: 'Delete option', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Deleting…', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
  } finally {
    release();
  }
  await expect(dialog).toHaveCount(0);
  expect(f.optionDeletions).toHaveLength(1);
  await expect(page.getByRole('dialog', { name: 'Manage property Status', exact: true })).toBeVisible();
});

test('lost deletion acknowledgements refresh reads without replaying the destructive request', async ({ page }) => {
  const f = await mockProperties(page);
  await page.goto(`/folders/${browserFixture.folder.id}/settings`);
  await schemaOptionActions(page, 'Status', 'Todo');
  await page.getByRole('button', { name: 'Delete option Todo', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete “Todo”?', exact: true });
  await expect(dialog.getByText('Status will be cleared on 0 notes.', { exact: true })).toBeVisible();
  f.controls.loseResponseNext = true;
  await dialog.getByRole('button', { name: 'Delete option', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(f.deletionAttempts).toHaveLength(1);
  expect(f.optionDeletions).toHaveLength(1);
  await manageSchemaProperty(page, 'Status');
  await expect(page.getByRole('button', { name: 'Rename option Todo', exact: true })).toHaveCount(0);
});

test('a recovered draft referencing a deleted option is preserved for explicit replacement, never silently replayed', async ({
  page,
}) => {
  const f = await mockProperties(page);
  const field = f.schema.definitions[1],
    option = field.options[0];
  const captured = structuredClone(f.schema);
  await page.goto(`/folders/${browserFixture.folder.id}/settings`);
  await schemaOptionActions(page, 'Status', 'Todo');
  await page.getByRole('button', { name: 'Delete option Todo', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete “Todo”?', exact: true });
  await dialog.getByRole('button', { name: 'Delete option', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.addInitScript(
    (draft) => sessionStorage.setItem('minunotes:properties-draft:note_source', JSON.stringify(draft)),
    {
      base: { schema: captured, revision: 0, values: {} },
      values: { [field.id]: option.id },
      ready: [field.id],
      folderId: browserFixture.folder.id,
    }
  );
  await openProperties(page);
  await expect(page.getByRole('status')).toContainText('Recovered properties draft');
  expect(f.patches).toHaveLength(0);
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Changes kept; clear or replace it');
  expect(f.patches).toHaveLength(0);
  await chooseStatus(page, 'Done');
  expect(f.patches).toHaveLength(0);
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Latest properties loaded');
  await page.getByRole('button', { name: 'Retry properties', exact: true }).click();
  await expect.poll(() => f.saves.length).toBe(1);
  expect(f.saves[0].values).toEqual({ [field.id]: field.options[1].id });
});

test('revoked access tears down option deletion without exposing counts or making changes', async ({ page }) => {
  const f = await mockProperties(page);
  await page.goto(`/folders/${browserFixture.folder.id}/settings`);
  await schemaOptionActions(page, 'Status', 'Todo');
  await page.getByRole('button', { name: 'Delete option Todo', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete “Todo”?', exact: true });
  await expect(dialog.getByText('Status will be cleared on 0 notes.', { exact: true })).toBeVisible();
  f.controls.deny = true;
  await dialog.getByRole('button', { name: 'Delete option', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Folder properties', exact: true })).toHaveCount(0);
  expect(f.optionDeletions).toHaveLength(0);
});

test('a pending deletion preview disables confirmation and cancellation cannot reopen a late result', async ({
  page,
}) => {
  const f = await mockProperties(page);
  await page.goto(`/folders/${browserFixture.folder.id}/settings`);
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/properties/*/options/*/deletion-preview', async (route) => {
    await pending;
    await route.fallback();
  });
  try {
    await schemaOptionActions(page, 'Status', 'Todo');
    await page.getByRole('button', { name: 'Delete option Todo', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete “Todo”?', exact: true });
    await expect(dialog.getByRole('status')).toHaveText('Checking affected notes…');
    await expect(dialog.getByRole('button', { name: 'Delete option', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  } finally {
    release();
  }
  await expect(page.getByRole('dialog', { name: 'Manage property Status', exact: true })).toBeVisible();
  expect(f.deletionAttempts).toHaveLength(0);
});

test('adding a Select option returns to its open manager for immediate reordering', async ({ page }) => {
  const f = await mockProperties(page);
  const field = f.schema.definitions[1];
  await page.goto(`/folders/${browserFixture.folder.id}/settings`);
  const manager = await manageSchemaProperty(page, field.label);
  await manager.getByRole('button', { name: `Add option to ${field.label}`, exact: true }).click();
  await page.getByLabel('Label', { exact: true }).fill('Later');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Edit property', exact: true })).toHaveCount(0);
  await expect(manager).toBeVisible();
  await manager.getByRole('button', { name: 'Actions for option Later', exact: true }).click();
  await page.getByRole('button', { name: 'Move option Later up', exact: true }).click();
  await expect.poll(() => f.schemaSaves.length).toBe(2);
  await expect(manager).toBeVisible();
  expect(f.schema.definitions[1].options.at(-2)?.label).toBe('Later');
});

test('a manager counts only active options for max8 and never opens a competing add form at the limit', async ({
  page,
}) => {
  const f = await mockProperties(page);
  const field = f.schema.definitions[1];
  field.options.unshift({ id: 'option_retired_manager', label: 'Retired', archived: true });
  let id = 0;
  for (let n = 2; n < 8; n++)
    f.schema.definitions = mutatePropertyDefinitions(
      f.schema.definitions,
      { type: 'add_option', propertyId: field.id, label: `Choice ${n}` },
      (prefix) => `${prefix}_maximum_${++id}`
    );
  await page.goto(`/folders/${browserFixture.folder.id}/settings`);
  const manager = await manageSchemaProperty(page, field.label);
  await expect(manager.getByRole('button', { name: /^Rename option / })).toHaveCount(8);
  const add = manager.getByRole('button', { name: `Add option to ${field.label}`, exact: true });
  await expect(add).toBeDisabled();
  await add.evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(page.getByLabel('Label', { exact: true })).toHaveCount(0);
  expect(f.schemaSaves).toHaveLength(0);
});

for (const change of ['archived', 'missing', 'revoked'] as const)
  test(`a saved manager and nested actions close when their target becomes ${change}`, async ({ page }) => {
    const f = await mockProperties(page);
    const field = f.schema.definitions[1];
    await page.goto(`/folders/${browserFixture.folder.id}/settings`);
    await schemaOptionActions(page, field.label, field.options[0].label);
    if (change === 'archived') field.archived = true;
    else if (change === 'missing') f.schema.definitions = f.schema.definitions.filter((d) => d.id !== field.id);
    else f.controls.deny = true;
    const read = nextSchemaRead(page);
    await refocus(page);
    await read;
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: `Manage ${field.label}`, exact: true })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: `Rename option ${field.options[0].label}`, exact: true })
    ).toHaveCount(0);
    expect(f.schemaSaves).toHaveLength(0);
  });

test('field arrows move across archived neighbors in one click and preserve every historical ID', async ({ page }) => {
  const f = await mockProperties(page);
  f.schema.definitions[1].archived = true;
  f.schema.definitions.unshift({
    id: 'property_retired_before',
    label: 'Retired before',
    type: 'text',
    archived: true,
    options: [],
  });
  f.schema.definitions.push({
    id: 'property_retired_after',
    label: 'Retired after',
    type: 'text',
    archived: true,
    options: [],
  });
  const allIds = f.schema.definitions.map((field) => field.id);
  const archived = structuredClone(f.schema.definitions.filter((field) => field.archived));
  const activeOrder = () => f.schema.definitions.filter((field) => !field.archived).map((field) => field.label);
  await page.goto(`/folders/${browserFixture.folder.id}/settings`);
  await schemaPropertyActions(page, 'Summary');
  await expect(page.getByRole('button', { name: 'Move Summary up', exact: true })).toBeDisabled();
  await schemaPropertyActions(page, 'Due date');
  await expect(page.getByRole('button', { name: 'Move Due date down', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Move Due date up', exact: true }).click();
  await expect.poll(activeOrder).toEqual(['Due date', 'Summary']);
  await schemaPropertyActions(page, 'Due date');
  await expect(page.getByRole('button', { name: 'Move Due date up', exact: true })).toBeDisabled();
  await schemaPropertyActions(page, 'Summary');
  await expect(page.getByRole('button', { name: 'Move Summary down', exact: true })).toBeDisabled();
  await schemaPropertyActions(page, 'Due date');
  await page.getByRole('button', { name: 'Move Due date down', exact: true }).click();
  await expect.poll(activeOrder).toEqual(['Summary', 'Due date']);
  expect(f.schema.definitions.filter((field) => field.archived)).toEqual(archived);
  for (const save of f.schemaSaves) {
    const ids = (save as { mutation: { propertyIds: string[] } }).mutation.propertyIds;
    expect(ids).toHaveLength(allIds.length);
    expect(new Set(ids)).toEqual(new Set(allIds));
  }
});
test('Select Up skips archived options and disables the first visible option while retaining all IDs', async ({
  page,
}) => {
  const f = await mockProperties(page);
  const field = f.schema.definitions[1];
  field.options = [
    { id: 'option_retired_before', label: 'Retired before', archived: true },
    { id: 'option_alpha', label: 'Alpha', archived: false },
    { id: 'option_retired_middle', label: 'Retired middle', archived: true },
    { id: 'option_beta', label: 'Beta', archived: false },
    { id: 'option_retired_after', label: 'Retired after', archived: true },
  ];
  const allIds = field.options.map((option) => option.id);
  const archived = structuredClone(field.options.filter((option) => option.archived));
  const activeOrder = () =>
    f.schema.definitions[1].options.filter((option) => !option.archived).map((option) => option.label);
  await page.goto(`/folders/${browserFixture.folder.id}/settings`);
  await schemaOptionActions(page, field.label, 'Alpha');
  await expect(page.getByRole('button', { name: 'Move option Alpha up', exact: true })).toBeDisabled();
  await schemaOptionActions(page, field.label, 'Beta');
  await page.getByRole('button', { name: 'Move option Beta up', exact: true }).click();
  await expect.poll(activeOrder).toEqual(['Beta', 'Alpha']);
  await schemaOptionActions(page, field.label, 'Beta');
  await expect(page.getByRole('button', { name: 'Move option Beta up', exact: true })).toBeDisabled();
  await schemaOptionActions(page, field.label, 'Alpha');
  await page.getByRole('button', { name: 'Move option Alpha up', exact: true }).click();
  await expect.poll(activeOrder).toEqual(['Alpha', 'Beta']);
  expect(f.schema.definitions[1].options.filter((option) => option.archived)).toEqual(archived);
  for (const save of f.schemaSaves) {
    const ids = (save as { mutation: { optionIds: string[] } }).mutation.optionIds;
    expect(ids).toHaveLength(allIds.length);
    expect(new Set(ids)).toEqual(new Set(allIds));
  }
});
test('Select Down skips archived neighbors, blocks pending and last items, and uses current tokens without changing values', async ({
  page,
}) => {
  const f = await mockProperties(page);
  const writes = trackSchemaWrites(page);
  f.schema.revision = 7;
  const field = f.schema.definitions[1];
  field.options = [
    { id: 'option_down_retired_before', label: 'Retired before', archived: true },
    { id: 'option_down_alpha', label: 'Alpha', archived: false },
    { id: 'option_down_retired_middle', label: 'Retired middle', archived: true },
    { id: 'option_down_beta', label: 'Beta', archived: false },
    { id: 'option_down_retired_after', label: 'Retired after', archived: true },
  ];
  const allIds = field.options.map((option) => option.id);
  const archived = structuredClone(field.options.filter((option) => option.archived));
  const swapped = [allIds[0], allIds[3], allIds[2], allIds[1], allIds[4]];
  f.state.set(browserFixture.source.id, { revision: 6, values: { [field.id]: allIds[1] } });
  const values = structuredClone(f.state.get(browserFixture.source.id));
  const body = structuredClone(f.body.notes.get(browserFixture.source.id));
  let reached = () => {},
    release = () => {};
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  await page.route(`**${schemaPath}`, async (route) => {
    if (route.request().method() === 'PATCH' && !held) {
      held = true;
      reached();
      await released;
    }
    await route.fallback(); // The unchanged fixture STILL validates CAS and real reorder definitions.
  });
  await page.goto(`/folders/${browserFixture.folder.id}/settings`);
  await schemaOptionActions(page, field.label, 'Beta');
  await expect(page.getByRole('button', { name: 'Move option Beta down', exact: true })).toBeDisabled();
  await schemaOptionActions(page, field.label, 'Alpha');
  await expect(page.getByRole('button', { name: 'Move option Alpha up', exact: true })).toBeDisabled();
  const down = page.getByRole('button', { name: 'Move option Alpha down', exact: true });
  await expect(down).toBeEnabled();
  await expectMoveIcon(down, 'down');
  await down.click();
  await started;
  try {
    expect(writes).toHaveLength(1);
    expect(f.schemaSaves).toHaveLength(0);
    await expect(page.getByRole('dialog', { name: 'Actions for option Alpha', exact: true })).toHaveCount(0);
    const pendingTrigger = page.getByRole('button', { name: 'Actions for option Beta', exact: true });
    await expect(pendingTrigger).toBeDisabled();
    await pendingTrigger.evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.getByRole('dialog', { name: /^Actions for option / })).toHaveCount(0);
    expect(writes).toHaveLength(1);
  } finally {
    release();
  }
  const optionLabels = (label: string) =>
    page
      .getByRole('list', { name: `Options for ${label}`, exact: true })
      .getByRole('button', { name: /^Rename option / });
  await expect(optionLabels(field.label)).toHaveText(['Beta', 'Alpha']);
  expect(f.schemaSaves).toHaveLength(1);
  expect(f.schema.definitions[1].options.map((option) => option.id)).toEqual(swapped);
  expect(f.state.get(browserFixture.source.id)).toEqual(values);
  f.changeSchema(); // Simulate a newer authorized schema, not a captured editor token.
  f.schema.definitions[1].label = 'Current Status';
  const read = nextSchemaRead(page);
  await refocus(page);
  await read;
  await expect(page.getByRole('dialog', { name: 'Manage property Current Status', exact: true })).toBeVisible();
  await schemaOptionActions(page, 'Current Status', 'Alpha');
  await expect(page.getByRole('button', { name: 'Move option Alpha down', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Move option Alpha up', exact: true }).click();
  await expect(optionLabels('Current Status')).toHaveText(['Alpha', 'Beta']);
  expect(writes).toEqual([
    { expectedRevision: 7, mutation: { type: 'reorder_options', propertyId: field.id, optionIds: swapped } },
    { expectedRevision: 9, mutation: { type: 'reorder_options', propertyId: field.id, optionIds: allIds } },
  ]);
  expect(f.schemaSaves).toHaveLength(2);
  expect(f.schema.revision).toBe(10);
  expect(f.schema.definitions[1].options.map((option) => option.id)).toEqual(allIds);
  expect(f.schema.definitions[1].options.filter((option) => option.archived)).toEqual(archived);
  expect(f.state.get(browserFixture.source.id)).toEqual(values);
  expect(f.body.notes.get(browserFixture.source.id)).toEqual(body);
  expect(f.patches).toHaveLength(0);
});

test('property editing hides fixed type details and Cancel discards changes without saving', async ({ page }) => {
  await mockProperties(page);
  const writes = trackSchemaWrites(page);
  await page.goto(`/folders/${browserFixture.folder.id}/settings`);
  await renameSchemaProperty(page, 'Summary');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Type:', { exact: false })).toHaveCount(0);
  await expect(dialog.getByText('Types cannot be changed.', { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await page.getByLabel('Label', { exact: true }).fill('Unsaved label');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toHaveLength(0);
  await renameSchemaProperty(page, 'Summary');
  await expect(page.getByLabel('Label', { exact: true })).toHaveValue('Summary');
});

test('Select option conflicts recover by explicit refresh without retyping or changing IDs', async ({ page }) => {
  const f = await mockProperties(page);
  const writes = trackSchemaWrites(page);
  const field = f.schema.definitions[1];
  const option = field.options[0];
  await page.goto(`/folders/${browserFixture.folder.id}/settings`);
  await renameSchemaOption(page, field.label, option.label);
  await page.getByLabel('Label', { exact: true }).fill('Queued');
  await expect(page.getByRole('button', { name: 'Reload properties', exact: true })).toHaveCount(0);
  f.changeSchema();
  const backgroundRead = nextSchemaRead(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await backgroundRead;
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Draft preserved');
  expect(writes.map((write) => write.expectedRevision)).toEqual([1]);
  await page.getByRole('button', { name: 'Reload properties', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveCount(0);
  await expect(page.getByLabel('Label', { exact: true })).toHaveValue('Queued');
  expect(writes).toHaveLength(1);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(writes.map((write) => write.expectedRevision)).toEqual([1, 2]);
  for (const write of writes)
    expect(write.mutation).toMatchObject({
      type: 'rename_option',
      propertyId: field.id,
      optionId: option.id,
      label: 'Queued',
    });
  expect(f.schema.definitions[1].options[0]).toMatchObject({ id: option.id, label: 'Queued' });
});
for (const target of ['property', 'option'] as const)
  for (const retired of ['archived', 'missing'] as const)
    test(`explicit refresh retains a draft and revision when its ${target} is ${retired}`, async ({ page }) => {
      const f = await mockProperties(page);
      const writes = trackSchemaWrites(page);
      const field = f.schema.definitions[target === 'property' ? 0 : 1];
      const option = target === 'option' ? field.options[0] : undefined;
      await page.goto(`/folders/${browserFixture.folder.id}/settings`);
      if (option) await renameSchemaOption(page, field.label, option.label);
      else await renameSchemaProperty(page, field.label);
      await page.getByLabel('Label', { exact: true }).fill('Retained draft');
      if (target === 'property') {
        if (retired === 'archived') field.archived = true;
        else f.schema.definitions[0] = { ...field, id: 'property_same_name_replacement' };
      } else if (retired === 'archived') field.options[0].archived = true;
      else field.options[0] = { ...field.options[0], id: 'option_same_name_replacement' };
      f.changeSchema();
      const backgroundRead = nextSchemaRead(page);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await backgroundRead;
      await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Draft preserved');
      await page.getByRole('button', { name: 'Reload properties', exact: true }).click();
      await expect(page.getByRole('dialog').getByRole('alert')).toContainText(
        `This ${target} is archived or unavailable`
      );
      await expect(page.getByLabel('Label', { exact: true })).toHaveValue('Retained draft');
      expect(writes).toHaveLength(1);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Schema changed');
      expect(writes.map((write) => write.expectedRevision)).toEqual([1, 1]);
      for (const write of writes) {
        expect(write.mutation.propertyId).toBe(field.id);
        if (option) expect(write.mutation.optionId).toBe(option.id);
      }
      expect(f.schemaSaves).toHaveLength(0);
      await expect(page.getByLabel('Label', { exact: true })).toHaveValue('Retained draft');
    });
test('failed explicit schema refresh keeps the draft revision even with newer cached schema data', async ({ page }) => {
  const f = await mockProperties(page);
  const writes = trackSchemaWrites(page);
  await page.goto(`/folders/${browserFixture.folder.id}/settings`);
  await renameSchemaProperty(page, 'Summary');
  await page.getByLabel('Label', { exact: true }).fill('Retained through failure');
  f.changeSchema();
  const backgroundRead = nextSchemaRead(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await backgroundRead;
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Draft preserved');
  const pattern = `**${schemaPath}`;
  await page.route(pattern, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ status: 500, json: { error: 'Temporary schema read failure' } })
      : route.fallback()
  );
  await page.getByRole('button', { name: 'Reload properties', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Schema refresh failed');
  await expect(page.getByLabel('Label', { exact: true })).toHaveValue('Retained through failure');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Schema changed');
  expect(writes.map((write) => write.expectedRevision)).toEqual([1, 1]);
  expect(f.schemaSaves).toHaveLength(0);
  await page.unroute(pattern);
  await page.getByRole('button', { name: 'Reload properties', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveCount(0);
  await expect(page.getByLabel('Label', { exact: true })).toHaveValue('Retained through failure');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(writes.map((write) => write.expectedRevision)).toEqual([1, 1, 2]);
});
test('explicit refresh preserves the latest add-field label, type and options entered during its read', async ({
  page,
}) => {
  const f = await mockProperties(page);
  const writes = trackSchemaWrites(page);
  await page.goto(`/folders/${browserFixture.folder.id}/settings`);
  await page.getByRole('button', { name: 'Add property', exact: true }).click();
  await page.getByLabel('Label', { exact: true }).fill('Draft field');
  await page.getByLabel('Type', { exact: true }).selectOption('date');
  f.changeSchema();
  const backgroundRead = nextSchemaRead(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await backgroundRead;
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Draft preserved');
  let release = () => {};
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = () => {};
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route(`**${schemaPath}`, async (route) => {
    if (route.request().method() === 'GET') {
      started();
      await delayed;
    }
    await route.fallback();
  });
  await page.getByRole('button', { name: 'Reload properties', exact: true }).click();
  await reading;
  try {
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await page.getByLabel('Label', { exact: true }).fill('Latest priority');
    await page.getByLabel('Type', { exact: true }).selectOption('select');
    await page.getByLabel('Options (comma-separated)', { exact: true }).fill('Low, Medium, High');
  } finally {
    release();
  }
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveCount(0);
  await expect(page.getByLabel('Label', { exact: true })).toHaveValue('Latest priority');
  await expect(page.getByLabel('Type', { exact: true })).toHaveValue('select');
  await expect(page.getByLabel('Options (comma-separated)', { exact: true })).toHaveValue('Low, Medium, High');
  expect(writes).toHaveLength(1);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(writes.map((write) => write.expectedRevision)).toEqual([1, 2]);
  expect(writes[1].mutation).toMatchObject({
    type: 'add',
    label: 'Latest priority',
    fieldType: 'select',
    options: ['Low', 'Medium', 'High'],
  });
  expect(f.schema.definitions.at(-1)?.label).toBe('Latest priority');
});
test('permission revocation during explicit schema refresh hides settings and closes the draft', async ({ page }) => {
  const f = await mockProperties(page);
  const writes = trackSchemaWrites(page);
  await page.goto(`/folders/${browserFixture.folder.id}/settings`);
  await renameSchemaProperty(page, 'Summary');
  await page.getByLabel('Label', { exact: true }).fill('Private draft');
  f.changeSchema();
  const backgroundRead = nextSchemaRead(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await backgroundRead;
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Draft preserved');
  f.controls.deny = true;
  await page.getByRole('button', { name: 'Reload properties', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rename Summary', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Manage Summary', exact: true })).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Folder properties', exact: true })).toHaveCount(0);
  expect(writes).toHaveLength(1);
});
test('owner schema settings add, rename, reorder, archive and recover stale drafts without retyping', async ({
  page,
}) => {
  const f = await mockProperties(page);
  const writes = trackSchemaWrites(page);
  await page.goto(`/folders/${browserFixture.folder.id}/settings`);
  await page.getByRole('button', { name: 'Add property', exact: true }).click();
  await page.getByLabel('Label', { exact: true }).fill('Priority');
  await page.getByLabel('Type', { exact: true }).selectOption('select');
  await page.getByLabel('Options (comma-separated)', { exact: true }).fill('Low, High');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const added = f.schema.definitions.at(-1);
  expect(added?.options).toHaveLength(2);
  await renameSchemaProperty(page, 'Priority');
  await page.getByLabel('Label', { exact: true }).fill('Impact');
  f.changeSchema();
  const backgroundRead = nextSchemaRead(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await backgroundRead;
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Draft preserved');
  await expect(page.getByLabel('Label', { exact: true })).toHaveValue('Impact');
  expect(writes.map((write) => write.expectedRevision)).toEqual([1, 2]);
  expect(f.schemaSaves).toHaveLength(1);
  await page.getByRole('button', { name: 'Reload properties', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveCount(0);
  await expect(page.getByLabel('Label', { exact: true })).toHaveValue('Impact');
  expect(writes).toHaveLength(2);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(writes.map((write) => write.expectedRevision)).toEqual([1, 2, 3]);
  expect(writes.slice(1).map((write) => write.mutation.propertyId)).toEqual([added?.id, added?.id]);
  expect(f.schema.definitions.at(-1)?.label).toBe('Impact');
  expect(f.schema.definitions.at(-1)?.id).toBe(added?.id);
  await schemaPropertyActions(page, 'Impact');
  await page.getByRole('button', { name: 'Move Impact up', exact: true }).click();
  await expect.poll(() => f.schema.definitions.at(-2)?.id).toBe(added?.id);
  await schemaPropertyActions(page, 'Impact');
  await page.getByRole('button', { name: 'Archive Impact', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Rename Impact', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Manage Impact', exact: true })).toHaveCount(0);
  expect(f.schema.definitions.find((d) => d.id === added?.id)?.archived).toBe(true);
});

for (const documentType of ['markdown', 'canvas.default', 'canvas.mindmap'] as const)
  for (const width of [390, 1280])
    for (const theme of ['catppuccin-latte', 'catppuccin-mocha'])
      test(`${documentType} properties popup/modal at ${width}px in ${theme}: one surface, focus and no writes`, async ({
        page,
      }) => {
        const f = await mockProperties(page);
        const canvas = documentType !== 'markdown';
        const note = canvas ? browserFixture.canvas : browserFixture.source;
        f.body.notes.set(note.id, { ...note, documentType });
        await page.setViewportSize({ width, height: 844 });
        await page.addInitScript((theme) => localStorage.setItem('notes-theme', theme), theme);
        await page.goto(`/notes/${note.id}`);
        const trigger = page.getByRole('button', { name: 'Open note actions', exact: true });
        await expect(trigger).toBeVisible();
        const inline = page.locator('summary').filter({ hasText: /^Properties$/ });
        if (canvas) await expect(inline).toHaveCount(0);
        else {
          await expect(inline).toBeVisible();
          await inline.click();
        }
        const geometry = canvas ? await page.locator('.notes-minu-canvas').boundingBox() : null;
        await trigger.focus();
        await page.keyboard.press('Enter');
        await page.getByRole('button', { name: 'Properties', exact: true }).focus();
        await page.keyboard.press('Enter');
        const modal = page.getByRole('dialog', { name: 'Properties', exact: true });
        await expect(modal.getByLabel('Summary', { exact: true })).toBeVisible();
        await expect(modal).toContainText('Close');
        expect(await modal.evaluate((el) => el.contains(document.activeElement))).toBe(true);
        await expect(page.getByLabel('Summary', { exact: true })).toHaveCount(1);
        await expect(inline).toHaveCount(0);
        expect(await modal.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: test.info().outputPath('properties-modal.png') });
        await modal.getByLabel('Status', { exact: true }).click();
        await expect(page.getByRole('dialog', { name: 'Choose Status', exact: true })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog', { name: 'Choose Status', exact: true })).toHaveCount(0);
        await expect(modal).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(modal).toHaveCount(0);
        await expect(trigger).toBeFocused();
        if (canvas) {
          await expect(inline).toHaveCount(0);
          expect(await page.locator('.notes-minu-canvas').boundingBox()).toEqual(geometry);
        } else {
          await expect(inline).toBeVisible();
          await expect(propertyPanel(page)).toHaveJSProperty('open', true);
        }
        expect(f.patches).toEqual([]);
        expect(f.body.saveRequests).toEqual([]);
        expect(await storedDraft(page, note.id)).toBeNull();
      });

for (const documentType of ['markdown', 'canvas.default', 'canvas.mindmap'] as const)
  for (const role of ['owner', 'editor', 'viewer', 'commenter'] as const)
    test(`${role} ${documentType} modal retains authorized metadata access without body writes`, async ({ page }) => {
      const f = await mockProperties(page, role);
      const note = documentType === 'markdown' ? browserFixture.source : browserFixture.canvas;
      f.body.notes.set(note.id, { ...note, documentType });
      await page.goto(`/notes/${note.id}`);
      await openPropertiesModal(page);
      const modal = page.getByRole('dialog', { name: 'Properties', exact: true });
      await expect(modal.getByLabel('Summary', { exact: true })).toBeVisible();
      if (role === 'owner' || role === 'editor') {
        await modal.getByLabel('Summary', { exact: true }).fill('Modal edit');
        await modal.getByLabel('Summary', { exact: true }).press('Tab');
        await expectPropertySaved(page, f, 1, { [f.schema.definitions[0].id]: 'Modal edit' }, note.id);
        expect(f.patches[0]).toEqual({
          schemaId: f.schema.schemaId,
          schemaRevision: 1,
          expectedRevision: 0,
          values: { [f.schema.definitions[0].id]: 'Modal edit' },
        });
      } else {
        await expect(modal.getByLabel('Summary', { exact: true })).toHaveAttribute('readonly', '');
        await expect(modal.getByLabel('Status', { exact: true })).toBeDisabled();
        await expect(modal.getByRole('button', { name: /^Clear / })).toHaveCount(0);
        expect(f.patches).toEqual([]);
      }
      await expect(modal.getByRole('link', { name: 'Add a property', exact: true })).toHaveCount(
        role === 'owner' ? 1 : 0
      );
      await modal.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(modal).toHaveCount(0);
      expect(f.body.notes.get(note.id)?.content).toBe(note.content);
      expect(f.body.saveRequests).toEqual([]);
    });

for (const documentType of ['markdown', 'canvas.default', 'canvas.mindmap'] as const)
  test(`${documentType} modal close/reopen retains the serial lock and newer edits through a held acknowledgement`, async ({
    page,
  }) => {
    const f = await mockProperties(page);
    const note = documentType === 'markdown' ? browserFixture.source : browserFixture.canvas;
    f.body.notes.set(note.id, { ...note, documentType });
    await page.goto(`/notes/${note.id}`);
    await openPropertiesModal(page);
    const modal = page.getByRole('dialog', { name: 'Properties', exact: true });
    const status = f.schema.definitions[1];
    const text = f.schema.definitions[0];
    const hold = f.holdNext('after');
    try {
      await chooseStatus(page, 'Todo');
      await hold.started;
      await modal.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(modal).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Open note actions', exact: true })).toBeFocused();
      await openPropertiesModal(page);
      await expect(propertyPanel(page)).toHaveAttribute('aria-busy', 'true');
      await modal.getByLabel('Summary', { exact: true }).fill('Newer queued value');
      await modal.getByLabel('Summary', { exact: true }).press('Tab');
      await expect(modal.getByText(/Recovered properties draft/)).toHaveCount(0);
      expect(f.patches).toHaveLength(1);
    } finally {
      hold.release();
    }
    await expectPropertySaved(
      page,
      f,
      2,
      { [status.id]: status.options[0].id, [text.id]: 'Newer queued value' },
      note.id
    );
    expect(f.patches[1]).toEqual({
      schemaId: f.schema.schemaId,
      schemaRevision: 1,
      expectedRevision: 1,
      values: { [text.id]: 'Newer queued value' },
    });
    expect(f.maxActive).toBe(1);
    expect(f.body.saveRequests).toEqual([]);
    await modal.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(modal).toHaveCount(0);
    if (documentType === 'markdown') {
      await page
        .locator('summary')
        .filter({ hasText: /^Properties$/ })
        .click();
      await expect(page.getByLabel('Summary', { exact: true })).toHaveValue('Newer queued value');
    }
  });

for (const documentType of ['markdown', 'canvas.default', 'canvas.mindmap'] as const)
  test(`${documentType} modal conflict keeps its draft on reopen until explicit review/retry, then revocation closes it`, async ({
    page,
  }) => {
    const f = await mockProperties(page);
    const note = documentType === 'markdown' ? browserFixture.source : browserFixture.canvas;
    f.body.notes.set(note.id, { ...note, documentType });
    await page.goto(`/notes/${note.id}`);
    await openPropertiesModal(page);
    const modal = page.getByRole('dialog', { name: 'Properties', exact: true });
    const text = f.schema.definitions[0];
    f.controls.conflictNext = true;
    await modal.getByLabel('Summary', { exact: true }).fill('Keep modal draft');
    await modal.getByLabel('Summary', { exact: true }).press('Tab');
    await expect(modal.getByRole('status')).toContainText("Couldn't save — changes kept");
    await modal.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(modal).toHaveCount(0);
    f.state.set(note.id, { revision: 3, values: { [text.id]: 'Other saved value' } });
    await openPropertiesModal(page);
    await expect(modal.getByLabel('Summary', { exact: true })).toHaveValue('Keep modal draft');
    expect(f.patches).toHaveLength(1);
    await modal.getByRole('button', { name: 'Review changes', exact: true }).click();
    await expect(modal.getByText('Current saved Summary: Other saved value', { exact: true })).toBeVisible();
    expect(f.patches).toHaveLength(1);
    await modal.getByRole('button', { name: 'Retry properties', exact: true }).click();
    await expectPropertySaved(page, f, 1, { [text.id]: 'Keep modal draft' }, note.id);
    expect(f.patches[1].expectedRevision).toBe(3);
    expect(f.body.saveRequests).toEqual([]);
    f.controls.deny = true;
    await refocus(page);
    await expect(modal).toHaveCount(0);
    await expect(page.getByLabel('Summary', { exact: true })).toHaveCount(0);
    await expect.poll(() => storedDraft(page, note.id)).toBeNull();
    expect(f.patches).toHaveLength(2);
  });

for (const documentType of ['markdown', 'canvas.default', 'canvas.mindmap'] as const)
  test(`${documentType} unfinished date remains a draft across modal dismissal, not a clear or hidden save`, async ({
    page,
  }) => {
    const f = await mockProperties(page);
    const note = documentType === 'markdown' ? browserFixture.source : browserFixture.canvas;
    f.body.notes.set(note.id, { ...note, documentType });
    await page.goto(`/notes/${note.id}`);
    await openPropertiesModal(page);
    const modal = page.getByRole('dialog', { name: 'Properties', exact: true });
    await modal.getByLabel('Due date', { exact: true }).fill('2028-02-29');
    expect(f.patches).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open note actions', exact: true })).toBeFocused();
    expect(f.patches).toEqual([]);
    await openPropertiesModal(page);
    await expect(modal.getByLabel('Due date', { exact: true })).toHaveValue('2028-02-29');
    expect(f.patches).toEqual([]);
    await modal.getByLabel('Due date', { exact: true }).press('Enter');
    await expectPropertySaved(page, f, 1, { [f.schema.definitions[2].id]: '2028-02-29' }, note.id);
    expect(f.body.saveRequests).toEqual([]);
  });

for (const role of ['owner', 'viewer'] as const)
  test(`${role} empty canvas schema stays accessible through the modal without an inline strip`, async ({ page }) => {
    const f = await mockProperties(page, role);
    f.schema.definitions.splice(0);
    await page.goto(`/notes/${browserFixture.canvas.id}`);
    await openPropertiesModal(page);
    const modal = page.getByRole('dialog', { name: 'Properties', exact: true });
    await expect(modal.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
    await expect(page.locator('summary').filter({ hasText: /^Properties$/ })).toHaveCount(0);
    if (role === 'owner') await expect(modal.getByRole('link', { name: 'Add a property', exact: true })).toBeVisible();
    else await expect(modal).toContainText('No properties defined for this note.');
    expect(f.patches).toEqual([]);
    expect(f.body.saveRequests).toEqual([]);
  });

for (const width of [390, 1280])
  for (const theme of ['catppuccin-latte', 'catppuccin-mocha'])
    test(`inline property fields cap at 24rem but details stay full width in ${theme} at ${width}px`, async ({
      page,
    }) => {
      const f = await mockProperties(page);
      await page.setViewportSize({ width, height: 844 });
      await page.addInitScript((theme) => localStorage.setItem('notes-theme', theme), theme);
      await openProperties(page);
      const details = propertyPanel(page),
        fields = details.locator(':scope > div').first();
      await expect(fields).toHaveCSS('max-width', '384px');
      const dimensions = await details.evaluate((el) => ({
        width: el.getBoundingClientRect().width,
        parent: el.parentElement?.clientWidth ?? 0,
      }));
      expect(Math.abs(dimensions.width - dimensions.parent)).toBeLessThanOrEqual(1);
      expect((await fields.boundingBox())?.width).toBeLessThanOrEqual(384);
      if (width === 1280) expect(dimensions.width).toBeGreaterThan(384);
      await page.screenshot({ path: test.info().outputPath('inline-property-width.png') });
      await openPropertiesModal(page);
      const modal = page.getByRole('dialog', { name: 'Properties', exact: true });
      await expect(modal).toHaveCSS('max-width', '512px');
      await expect(modal.locator(':scope > [aria-busy] > div').first()).toHaveCSS('max-width', 'none');
      await modal.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(modal).toHaveCount(0);
      await expect(details).toHaveJSProperty('open', true);
      expect(f.patches).toEqual([]);
      expect(f.body.saveRequests).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });

test('outside dismissal returns focus without changing an existing canvas node, viewport or body', async ({ page }) => {
  const f = await mockProperties(page);
  await page.goto(`/notes/${browserFixture.canvas.id}`);
  await page.getByRole('button', { name: 'Rectangle (R)' }).click();
  await page.getByLabel('Canvas editor').click({ position: { x: 400, y: 300 } });
  const node = page.locator('[data-minucanvas-node-id]');
  await expect(node).toHaveCount(1);
  await expect.poll(() => f.body.notes.get(browserFixture.canvas.id)?.content).toContain('rectangle');
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  const content = f.body.notes.get(browserFixture.canvas.id)?.content;
  const saves = f.body.saveRequests.length;
  const nodePosition = await node.boundingBox();
  const framePosition = await page.locator('.notes-minu-canvas').boundingBox();
  await openPropertiesModal(page);
  const modal = page.getByRole('dialog', { name: 'Properties', exact: true });
  await expect(modal.getByLabel('Summary', { exact: true })).toBeVisible();
  await page.mouse.click(4, 200);
  await expect(modal).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open note actions', exact: true })).toBeFocused();
  await expect(node).toHaveCount(1);
  expect(await node.boundingBox()).toEqual(nodePosition);
  expect(await page.locator('.notes-minu-canvas').boundingBox()).toEqual(framePosition);
  expect(f.body.notes.get(browserFixture.canvas.id)?.content).toBe(content);
  expect(f.body.saveRequests).toHaveLength(saves);
  expect(f.patches).toEqual([]);
});
