import { expect, test } from '@playwright/test';
import { browserFixture, mockBrowserApi } from './fixtures';

test('uses an anchored dialog for creation and viewing, with full discussion in the Review drawer', async ({
  page,
}) => {
  const api = await mockBrowserApi(page);
  await page.goto(`/notes/${browserFixture.source.id}`);

  const editor = page.locator('.cm-content');
  await expect(editor).toContainText('Start here.');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();

  const createDialog = page.getByLabel('Add comment');
  await expect(createDialog).toBeVisible();
  await expect(createDialog.getByText('Start here.')).toBeVisible();
  const editorBox = await editor.boundingBox();
  const dialogBox = await createDialog.boundingBox();
  if (!editorBox || !dialogBox) throw new Error('Expected editor and comment dialog bounds');
  expect(dialogBox.y).toBeGreaterThanOrEqual(editorBox.y - 20);
  expect(dialogBox.width).toBeCloseTo(448, -1);
  await createDialog.getByPlaceholder('Leave a comment…').fill('Please review this opening.');
  await page.getByRole('textbox', { name: 'Untitled note' }).click();
  await expect(createDialog).toBeHidden();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await createDialog.evaluate((element) => {
    element.dataset.dialogInstance = 'preserved';
  });
  await createDialog.getByPlaceholder('Leave a comment…').fill('Please review this opening.');
  await createDialog.getByRole('button', { name: 'Comment', exact: true }).click();

  const commentAnchor = page.locator('.me-comment-anchor');
  await expect(commentAnchor).toContainText('Start here.');
  const threadDialog = page.getByRole('dialog', { name: 'Comment thread', exact: true });
  await expect(threadDialog).toHaveAttribute('data-dialog-instance', 'preserved');
  await expect(threadDialog.getByText('Please review this opening.')).toBeVisible();
  const stableDialogBox = await threadDialog.boundingBox();
  expect(stableDialogBox?.x).toBeCloseTo(dialogBox.x, 0);
  expect(stableDialogBox?.y).toBeCloseTo(dialogBox.y, 0);

  await threadDialog.getByRole('button', { name: 'More comment actions' }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await threadDialog.getByRole('textbox', { name: 'Edit comment' }).fill('Please review this opening carefully.');
  await threadDialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(threadDialog.getByText('Please review this opening carefully.')).toBeVisible();
  await expect(threadDialog.getByText(/\(edited\)/)).toBeVisible();

  await threadDialog.getByRole('button', { name: 'Add reaction' }).hover();
  await expect(page.getByRole('tooltip')).toHaveText('Add reaction');
  await threadDialog.getByRole('button', { name: 'Add reaction' }).click();
  await page.getByRole('button', { name: 'React with 🎉' }).click();
  await expect(threadDialog.getByRole('button', { name: '🎉 reaction, 1' })).toHaveAttribute('aria-pressed', 'true');

  await threadDialog.getByRole('button', { name: 'Add reaction' }).click();
  await page.getByRole('button', { name: 'More reactions' }).click();
  await page.getByRole('textbox', { name: 'Type to search for an emoji' }).fill('fire');
  await page.getByRole('button', { name: 'flame', exact: true }).click();
  await expect(threadDialog.getByRole('button', { name: '🔥 reaction, 1' })).toHaveAttribute('aria-pressed', 'true');
  await threadDialog.getByRole('button', { name: 'Close comment' }).click();

  const reviewButton = page.getByRole('button', { name: 'Open Review' });
  await expect(reviewButton).toHaveText('');
  await reviewButton.click();
  const drawer = page.getByRole('dialog', { name: 'Review' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('Please review this opening carefully.')).toBeVisible();
  await expect(drawer.getByRole('button', { name: '🎉 reaction, 1' })).toBeVisible();
  await expect(drawer.locator('[data-avatar-palette]').first()).toBeVisible();
  await drawer.getByText('You', { exact: true }).first().click();
  await drawer.getByPlaceholder('Reply…').fill('Owner follow-up.');
  await drawer.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(drawer.getByText('Owner follow-up.')).toBeVisible();
  await drawer.getByRole('button', { name: 'More comment actions' }).last().click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await drawer.getByRole('textbox', { name: 'Edit comment' }).fill('Edited owner follow-up.');
  await drawer.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(drawer.getByText('Edited owner follow-up.')).toBeVisible();
  await drawer.getByRole('button', { name: 'Resolve comment' }).hover();
  await expect(page.getByRole('tooltip')).toHaveText('Resolve comment');
  await drawer.getByRole('button', { name: 'Resolve comment' }).click();
  await expect(drawer.getByRole('button', { name: 'Reopen comment' })).toBeVisible();
  await drawer.getByRole('button', { name: 'Reopen comment' }).click();
  await drawer.getByRole('button', { name: 'Close Review' }).click();

  await commentAnchor.click();
  await expect(threadDialog).toBeVisible();
  await expect(drawer).toBeHidden();

  await editor.click();
  await page.keyboard.press('Home');
  await page.keyboard.type('Before ');
  await api.expectSavedContent('Before Start here.');
  await expect
    .poll(() => api.commentRequests.find((request) => request.path.endsWith('/anchor'))?.body)
    .toMatchObject({
      anchor: { from: 7, to: 18, quote: 'Start here.', documentHash: 'hash_2' },
    });

  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Replacement');
  await api.expectSavedContent('Replacement');
  await expect
    .poll(() => api.commentRequests.filter((request) => request.path.endsWith('/anchor')).at(-1)?.body)
    .toMatchObject({ anchor: { quote: 'Start here.', detached: true, documentHash: 'hash_3' } });
  await expect(threadDialog).toBeHidden();
  await page.getByRole('button', { name: 'Open Review' }).click();
  await expect(page.getByRole('dialog', { name: 'Review' }).getByText(/could not be reattached/)).toBeVisible();
});

test('keeps range comments in the fixed toolbar for read-only commenters', async ({ page }) => {
  await mockBrowserApi(page, { noteAccessRole: 'commenter' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/notes/${browserFixture.source.id}`);

  const editor = page.locator('.cm-content');
  await expect(editor).toContainText('Start here.');
  const line = editor.locator('.cm-line').filter({ hasText: 'Start here.' });
  const lineBounds = await line.boundingBox();
  expect(lineBounds).not.toBeNull();
  const selectionY = (lineBounds?.y ?? 0) + (lineBounds?.height ?? 0) / 2;
  await page.mouse.move((lineBounds?.x ?? 0) + 1, selectionY);
  await page.mouse.down();
  await page.mouse.move((lineBounds?.x ?? 0) + (lineBounds?.width ?? 0) - 1, selectionY, { steps: 8 });
  await page.mouse.up();

  await expect(page.locator('.me-toolbar--floating')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Comment', exact: true })).toBeVisible();
  await expect(page.getByLabel('Open insert menu')).toHaveCount(0);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.getByLabel('Add comment')).toBeVisible();
});

test('creates a whole-line comment from a simple themed gutter icon', async ({ page }) => {
  await mockBrowserApi(page);
  await page.goto(`/notes/${browserFixture.source.id}`);

  const editor = page.locator('.cm-content');
  const line = page.locator('.cm-line').filter({ hasText: 'Start here.' }).first();
  const lineButton = page.getByRole('button', { name: 'Comment on line' });
  await expect(lineButton).toHaveCSS('opacity', '0');
  await editor.click();
  await page.getByRole('textbox', { name: 'Untitled note' }).hover();
  await expect(lineButton).toHaveCSS('opacity', '0');
  await line.hover();
  await expect(lineButton).toHaveCSS('opacity', '1');
  await expect(lineButton).toHaveCSS('border-top-width', '0px');
  const usesThemeMutedColor = () =>
    lineButton.evaluate((element) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--notes-muted)';
      document.body.append(probe);
      const expected = getComputedStyle(probe).color;
      probe.remove();
      return getComputedStyle(element).color === expected;
    });
  await expect.poll(usesThemeMutedColor).toBe(true);
  const lineButtonBox = await lineButton.boundingBox();
  const lineIconBox = await lineButton.locator('svg').boundingBox();
  if (!lineButtonBox || !lineIconBox) throw new Error('Expected line comment icon bounds');
  expect(Math.abs(lineIconBox.x + lineIconBox.width / 2 - (lineButtonBox.x + lineButtonBox.width / 2))).toBeLessThan(1);
  expect(Math.abs(lineIconBox.y + lineIconBox.height / 2 - (lineButtonBox.y + lineButtonBox.height / 2))).toBeLessThan(
    1
  );

  await lineButton.click();
  const dialog = page.getByLabel('Add comment');
  await expect(dialog.getByText('Start here.')).toBeVisible();
  const dialogBox = await dialog.boundingBox();
  const editorContainerBox = await page.locator('.notes-minu-editor').boundingBox();
  if (!dialogBox || !editorContainerBox) throw new Error('Expected comment dialog and editor container bounds');
  expect(
    Math.abs(dialogBox.x + dialogBox.width / 2 - (editorContainerBox.x + editorContainerBox.width / 2))
  ).toBeLessThan(2);
  expect(dialogBox.y).toBeGreaterThanOrEqual(lineButtonBox.y + lineButtonBox.height + 6);
  await dialog.getByPlaceholder('Leave a comment…').fill('Review the complete line.');
  await dialog.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.locator('.me-comment-anchor')).toContainText('Start here.');

  await page.getByLabel('Open account and settings menu').click();
  await page.getByRole('button', { name: 'Theme', exact: true }).click();
  await page.getByRole('dialog', { name: 'Theme' }).getByLabel('Theme selection').selectOption('catppuccin-latte');
  await expect(page.locator('html')).toHaveClass(/theme-catppuccin-latte/);
  const existingCommentButton = page.locator('.me-comment-gutter-badge').first();
  await expect
    .poll(() =>
      existingCommentButton.evaluate((element) => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--notes-muted)';
        document.body.append(probe);
        const expected = getComputedStyle(probe).color;
        probe.remove();
        return getComputedStyle(element).color === expected;
      })
    )
    .toBe(true);
});

test('shows semantic Markdown in quoted comment context', async ({ page }) => {
  await mockBrowserApi(page);
  await page.goto(`/notes/${browserFixture.linked.id}`);

  const line = page.locator('.cm-line').filter({ hasText: 'Integration reference:' }).first();
  await line.hover();
  await line.getByRole('button', { name: 'Comment on line' }).click();

  const quote = page.getByLabel('Add comment').locator('blockquote');
  await expect(quote).toHaveText('Integration reference: MinuNotes integration — MinuEditor v0.11.1');
  await expect(quote.locator('strong')).toHaveText('Integration reference:');
  await expect(quote).not.toContainText('[[');
  await expect(quote).not.toContainText('**');
});

test('places a whole-line comment dialog above the icon near the viewport bottom', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await mockBrowserApi(page);
  await page.goto(`/notes/${browserFixture.source.id}`);
  await page.addStyleTag({ content: '.notes-minu-editor .cm-content { padding-top: 280px !important; }' });

  const line = page.locator('.cm-line').filter({ hasText: 'Start here.' }).first();
  await line.click();
  const lineButton = page.getByRole('button', { name: 'Comment on line' });
  const lineButtonBox = await lineButton.boundingBox();
  if (!lineButtonBox) throw new Error('Expected line comment icon bounds');
  await lineButton.click();

  const dialog = page.getByLabel('Add comment');
  await expect(dialog).toBeVisible();
  const dialogBox = await dialog.boundingBox();
  if (!dialogBox) throw new Error('Expected comment dialog bounds');
  expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(lineButtonBox.y - 6);
});

test('opens Review with the same responsive drawer geometry as Backlinks', async ({ page }) => {
  await mockBrowserApi(page);
  await page.goto(`/notes/${browserFixture.source.id}`);

  await page.getByRole('button', { name: 'Open Review' }).click();
  const desktopDrawer = page.getByRole('dialog', { name: 'Review' });
  await expect(desktopDrawer).toBeVisible();
  await expect(desktopDrawer).toHaveCSS('position', 'fixed');
  const desktopBox = await desktopDrawer.boundingBox();
  expect(desktopBox?.width).toBeCloseTo(448, -1);
  expect(desktopBox?.x).toBeGreaterThan(800);
  await desktopDrawer.getByRole('button', { name: 'Close Review' }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open Review' }).click();
  const mobileDrawer = page.getByRole('dialog', { name: 'Review' });
  await expect(mobileDrawer).toBeVisible();
  const mobileBox = await mobileDrawer.boundingBox();
  expect(mobileBox?.x).toBe(0);
  expect(mobileBox?.width).toBe(390);
  expect(mobileBox?.y).toBeGreaterThan(100);
});

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 390, height: 844 },
]) {
  test(`discusses the note below its body without editor anchors at width ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const theme = viewport.width === 1280 ? 'catppuccin-latte' : 'catppuccin-mocha';
    await page.addInitScript((value) => localStorage.setItem('notes-theme', value), theme);
    const api = await mockBrowserApi(page, { noteAccessRole: 'commenter' });
    await page.goto(`/notes/${browserFixture.source.id}`);
    const discussion = page.getByRole('region', { name: 'Discussion', exact: true });
    await page.getByRole('button', { name: 'Discussion', exact: true }).click();
    const composer = discussion.getByRole('textbox', { name: 'New discussion comment' });
    await expect(composer).toBeFocused();
    const bodyBox = await page.locator('.cm-content').boundingBox();
    const sectionBox = await discussion.boundingBox();
    if (!bodyBox || !sectionBox) throw new Error('Expected note body and Discussion bounds');
    expect(sectionBox.y).toBeGreaterThan(bodyBox.y + bodyBox.height);
    await composer.fill('A whole-note decision.');
    await discussion.getByRole('button', { name: 'Post', exact: true }).click();
    await expect(discussion.getByText('A whole-note decision.', { exact: true })).toHaveCount(1);
    expect(api.commentRequests[0].body).toEqual({ body: 'A whole-note decision.', target: 'note' });
    expect(api.saveRequests).toHaveLength(0);
    await expect(page.locator('.me-comment-anchor')).toHaveCount(0);
    await expect(discussion.locator('blockquote')).toHaveCount(0);
    await expect(discussion.getByText(/Detached|reattached/)).toHaveCount(0);
    await discussion.getByPlaceholder('Reply…').fill('A follow-up.');
    await discussion.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(discussion.getByText('A follow-up.', { exact: true })).toBeVisible();
    await discussion.getByRole('button', { name: 'Add reaction' }).first().click();
    await page.getByRole('button', { name: 'React with 👍' }).click();
    await expect(discussion.getByRole('button', { name: '👍 reaction, 1' })).toBeVisible();
    await discussion.getByRole('button', { name: 'More comment actions' }).first().click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await discussion.getByRole('textbox', { name: 'Edit comment' }).fill('Updated whole-note decision.');
    await discussion.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(discussion.getByText('Updated whole-note decision.', { exact: true })).toBeVisible();
    await discussion.getByRole('button', { name: 'Resolve comment' }).click();
    await expect(discussion.getByRole('button', { name: 'Reopen comment' })).toBeVisible();
    await discussion.getByRole('button', { name: 'Reopen comment' }).click();
    api.externalUpdate(browserFixture.source.id, { content: 'Entirely rewritten body', title: 'Renamed note' });
    await page.reload();
    await page.getByRole('button', { name: 'Discussion', exact: true }).click();
    await expect(discussion.getByText('Updated whole-note decision.', { exact: true })).toHaveCount(1);
    await expect(discussion.getByText('A follow-up.', { exact: true })).toBeVisible();
    await expect(page.locator('.me-comment-anchor')).toHaveCount(0);
    expect(api.commentRequests.filter((request) => request.path.endsWith('/anchor'))).toHaveLength(0);
    await page.getByRole('button', { name: 'Open Review' }).click();
    await expect(
      page
        .getByRole('dialog', { name: 'Review', exact: true })
        .getByText('Updated whole-note decision.', { exact: true })
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Close Review' }).click();
    await discussion.getByRole('button', { name: 'More discussion actions' }).click();
    await page.getByRole('button', { name: 'Delete discussion', exact: true }).click();
    await expect(discussion.getByText('Updated whole-note decision.', { exact: true })).toHaveCount(0);
    await expect(discussion.getByText('A follow-up.', { exact: true })).toHaveCount(0);
  });
}

test('posting general discussion does not force-save dirty body changes', async ({ page }) => {
  const api = await mockBrowserApi(page);
  await page.goto(`/notes/${browserFixture.source.id}`);
  // Stop the clock before creating dirty content, so autosave cannot make this a false positive.
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1_000));
  await page.locator('.cm-content').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Unsaved');
  await expect(page.locator('.cm-content')).toContainText('Unsaved');
  const before = api.saveRequests.length;
  expect(before).toBe(0);
  await page.getByRole('button', { name: 'Discussion', exact: true }).click();
  const discussion = page.getByRole('region', { name: 'Discussion', exact: true });
  await discussion.getByRole('textbox', { name: 'New discussion comment' }).fill('Independent discussion');
  await discussion.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(discussion.getByText('Independent discussion', { exact: true })).toBeVisible();
  expect(api.saveRequests).toHaveLength(before);
  expect(api.commentRequests[0].body).toEqual({ target: 'note', body: 'Independent discussion' });
});

test('hides Discussion and Review after role downgrade or comment-read denial', async ({ page }) => {
  const api = await mockBrowserApi(page, { noteAccessRole: 'commenter' });
  await page.goto(`/notes/${browserFixture.source.id}`);
  await expect(page.getByRole('button', { name: 'Discussion', exact: true })).toBeVisible();
  api.setNoteAccessRole('viewer');
  await page.reload();
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
  await expect(page.getByRole('button', { name: 'Discussion', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Discussion', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open Review' })).toHaveCount(0);
  api.setNoteAccessRole('commenter');
  await page.route(/\/internal\/notes\/[^/]+\/comments\?includeNoteComments=true$/, (route) =>
    route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Forbidden' }) })
  );
  await page.reload();
  await expect(page.locator('.cm-content')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Discussion', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open Review' })).toHaveCount(0);
});

test('keeps a late general-comment response scoped to its original note after navigation', async ({ page }) => {
  const api = await mockBrowserApi(page);
  const source = api.notes.get(browserFixture.source.id);
  if (!source) throw new Error('Missing source fixture');
  source.content = `[[${browserFixture.target.id}|${browserFixture.target.title}]]`;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  await page.route(/\/internal\/notes\/note_source\/comments$/, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    started = true;
    await held;
    return route.fallback();
  });
  await page.goto(`/notes/${browserFixture.source.id}`);
  await page.getByRole('button', { name: 'Discussion', exact: true }).click();
  await page.getByRole('textbox', { name: 'New discussion comment' }).fill('Source-only decision');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await expect.poll(() => started).toBe(true);
  try {
    await page.locator('.cm-content').getByText(browserFixture.target.title, { exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/notes/${browserFixture.target.id}$`));
  } finally {
    release();
  }
  await expect.poll(() => api.commentThreads.get(browserFixture.source.id)?.length).toBe(1);
  const discussion = page.getByRole('region', { name: 'Discussion', exact: true });
  await expect(discussion.getByText('Source-only decision', { exact: true })).toHaveCount(0);
  await expect(discussion.getByRole('textbox', { name: 'New discussion comment' })).toHaveValue('');
  await expect(page.getByRole('dialog', { name: 'Comment thread', exact: true })).toHaveCount(0);
  await page.goBack();
  await page.getByRole('button', { name: 'Discussion', exact: true }).click();
  await expect(discussion.getByText('Source-only decision', { exact: true })).toHaveCount(1);
});

test('retains the draft on failure and prevents a duplicate pending general submission', async ({ page }) => {
  const api = await mockBrowserApi(page);
  let calls = 0;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/internal\/notes\/[^/]+\/comments$/, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    calls += 1;
    if (calls === 1)
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Discussion unavailable' }),
      });
    await held;
    return route.fallback();
  });
  await page.goto(`/notes/${browserFixture.source.id}`);
  await page.getByRole('button', { name: 'Discussion', exact: true }).click();
  const discussion = page.getByRole('region', { name: 'Discussion', exact: true });
  const composer = discussion.getByRole('textbox', { name: 'New discussion comment' });
  await composer.fill('Keep my draft');
  await discussion.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(discussion.getByText('Discussion unavailable')).toBeVisible();
  await expect(composer).toHaveValue('Keep my draft');
  expect(calls).toBe(1);
  await discussion.getByRole('button', { name: 'Post', exact: true }).click();
  try {
    await expect(discussion.getByRole('button', { name: 'Post', exact: true })).toBeDisabled();
    await composer.press('ControlOrMeta+Enter');
    expect(calls).toBe(2);
  } finally {
    release();
  }
  await expect(discussion.getByText('Keep my draft', { exact: true })).toHaveCount(1);
  await expect(composer).toHaveValue('');
  expect(api.commentRequests.filter((request) => request.method === 'POST')).toHaveLength(1);
});
