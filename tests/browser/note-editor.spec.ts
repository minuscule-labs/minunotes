import { expect, test } from '@playwright/test';
import { browserFixture, mockBrowserApi } from './fixtures';

test('autosaves editor content and preserves it after reload', async ({ page }) => {
  const api = await mockBrowserApi(page);
  await page.goto(`/notes/${browserFixture.source.id}`);

  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible();
  await expect.poll(() => editor.evaluate((element) => getComputedStyle(element).fontFamily)).toContain('system-ui');
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Updated.');

  await api.expectSavedContent('Start here. Updated.');
  expect(api.saveRequests.at(-1)).toMatchObject({
    noteId: browserFixture.source.id,
    body: { baseHash: 'hash_1' },
  });
  await page.reload();
  await expect(page.locator('.cm-content')).toContainText('Start here. Updated.');
});

test('detects a clean note changed externally and reloads the latest content', async ({ page }) => {
  await page.clock.install();
  const api = await mockBrowserApi(page);
  await page.goto(`/notes/${browserFixture.source.id}`);

  const editor = page.locator('.cm-content');
  await expect(editor).toContainText('Start here.');
  api.externalUpdate(browserFixture.source.id, { content: 'Updated remotely.' });
  await page.clock.runFor(20_000);
  await page.clock.resume();

  expect(api.statusRequests).toContain(browserFixture.source.id);
  await expect(page.getByText('This note was updated elsewhere. Reload to view the latest version.')).toBeVisible();
  await expect(editor).toContainText('Start here.');
  await page.getByRole('button', { name: 'Reload' }).click();
  await expect(editor).toContainText('Updated remotely.');
});

test('preserves and exposes a dirty local draft after an external update wins the save race', async ({ page }) => {
  await page.clock.install();
  const api = await mockBrowserApi(page);
  await page.goto(`/notes/${browserFixture.source.id}`);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });

  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Local draft.');
  api.externalUpdate(browserFixture.source.id, { content: 'Updated remotely.' });
  await page.clock.runFor(800);
  await page.clock.resume();

  await expect(page.getByText('This note was updated elsewhere. Reload to view the latest version.')).toBeVisible();
  await expect(editor).toContainText('Start here. Local draft.');
  expect(api.notes.get(browserFixture.source.id)?.content).toBe('Updated remotely.');
  expect(api.saveRequests.at(-1)).toMatchObject({
    noteId: browserFixture.source.id,
    body: { content: 'Start here. Local draft.', baseHash: 'hash_1' },
  });

  await page.getByRole('button', { name: 'Review local draft' }).click();
  const draftDialog = page.getByRole('dialog', { name: 'Preserved local draft' });
  await expect(draftDialog.getByLabel('Local draft content')).toHaveValue('Start here. Local draft.');
  await expect(draftDialog.getByLabel('Latest saved content')).toHaveValue('Updated remotely.');
  await draftDialog.getByRole('button', { name: 'Close preserved draft' }).click();

  await page.reload();
  await expect(editor).toContainText('Updated remotely.');
  await expect(
    page.getByText('Your conflicting local draft is preserved in this tab until you explicitly discard it.')
  ).toBeVisible();

  await page.goto(`/notes/${browserFixture.target.id}`);
  await expect(page.locator('.cm-content')).toContainText(browserFixture.target.content);
  await page.goto(`/notes/${browserFixture.source.id}`);
  await expect(
    page.getByText('Your conflicting local draft is preserved in this tab until you explicitly discard it.')
  ).toBeVisible();

  await page.getByRole('button', { name: 'Review local draft' }).click();
  await draftDialog.getByRole('button', { name: 'Copy local content' }).click();
  await expect(draftDialog.getByRole('status')).toHaveText('Content copied.');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Start here. Local draft.');
  await draftDialog.getByRole('button', { name: 'Discard local draft…' }).click();
  await expect(draftDialog.getByText('Permanently discard this local draft?')).toBeVisible();
  await draftDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(draftDialog.getByLabel('Local draft content')).toHaveValue('Start here. Local draft.');
  await draftDialog.getByRole('button', { name: 'Discard local draft…' }).click();
  await draftDialog.getByRole('button', { name: 'Discard local draft', exact: true }).click();

  await expect(draftDialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review local draft' })).toHaveCount(0);
  expect(api.notes.get(browserFixture.source.id)?.content).toBe('Updated remotely.');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Review local draft' })).toHaveCount(0);
});

test('switches between live and source editing and autosaves raw markdown changes', async ({ page }) => {
  const api = await mockBrowserApi(page);
  const markdown = '![Browser image](/internal/attachments/att_browser/content)';
  api.notes.set(browserFixture.source.id, { ...browserFixture.source, content: markdown });
  await page.goto(`/notes/${browserFixture.source.id}`);

  await expect(page.locator('.me-image-wrapper')).toBeVisible();
  await expect(page.locator('img.me-image')).toHaveAttribute(
    'src',
    new URL('/internal/attachments/att_browser/content', page.url()).toString()
  );
  await page.getByLabel('Open note actions').click();
  await page.getByRole('button', { name: 'Source mode', exact: true }).click();

  const editor = page.locator('.cm-content');
  await expect(page.locator('.me-image-wrapper')).toHaveCount(0);
  await expect(editor).toContainText(markdown);
  await expect.poll(() => editor.evaluate((element) => getComputedStyle(element).fontFamily)).toContain('ui-monospace');

  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type('\n\nEdited in source.');
  await api.expectSavedContent(`${markdown}\n\nEdited in source.`);

  await page.getByLabel('Open note actions').click();
  await page.getByRole('button', { name: 'Live mode', exact: true }).click();
  await expect(page.locator('.me-image-wrapper')).toBeVisible();
});

test('renders callouts and Mermaid diagrams in live mode', async ({ page }) => {
  const api = await mockBrowserApi(page);
  api.notes.set(browserFixture.source.id, {
    ...browserFixture.source,
    content: '> [!TIP]\n> Review before publishing.\n\n```mermaid\nflowchart LR\n  Draft --> Publish\n```',
  });
  await page.goto(`/notes/${browserFixture.source.id}`);

  await expect(page.locator('.me-callout-label--tip')).toBeVisible();
  const diagram = page.locator('.me-mermaid-block');
  await expect(diagram).toHaveClass(/me-mermaid-block--ready/, { timeout: 15_000 });
  await expect(diagram.locator('svg')).toBeVisible();

  const nodeFill = () =>
    diagram
      .locator('svg .node rect')
      .first()
      .evaluate((element) => getComputedStyle(element).fill);
  const darkNodeFill = await nodeFill();
  await page.getByLabel('Open account and settings menu').click();
  await page.getByRole('button', { name: 'Theme', exact: true }).click();
  await page.getByRole('dialog', { name: 'Theme' }).getByLabel('Theme selection').selectOption('catppuccin-latte');
  await expect(page.locator('html')).toHaveClass(/theme-catppuccin-latte/);
  await expect.poll(nodeFill).not.toBe(darkNodeFill);
});

test('pastes an internal note URL as a canonical wikilink with a runtime title', async ({ page }) => {
  const api = await mockBrowserApi(page);
  await page.goto(`/notes/${browserFixture.source.id}`);

  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.press('Backspace');
  await editor.evaluate(
    (element, targetUrl) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', targetUrl);
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
    },
    `${new URL(page.url()).origin}/notes/${browserFixture.target.id}`
  );

  await api.expectSavedContent(`[[${browserFixture.target.id}]]`);
  await expect(editor).toContainText(browserFixture.target.title);

  await page.getByLabel('Open note actions').click();
  await page.getByRole('button', { name: 'Source mode', exact: true }).click();
  await expect(editor).toContainText(`[[${browserFixture.target.id}]]`);
});

test('keeps external URL paste as a standard Markdown link', async ({ page }) => {
  const api = await mockBrowserApi(page);
  await page.goto(`/notes/${browserFixture.source.id}`);

  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await editor.evaluate((element) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'https://example.com/article');
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  });

  await api.expectSavedContent('[Start here.](https://example.com/article)');
});

test('converts rich HTML paste into portable Markdown', async ({ page }) => {
  const api = await mockBrowserApi(page);
  await page.goto(`/notes/${browserFixture.source.id}`);

  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await editor.evaluate((element) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/html', '<h2>Imported heading</h2><p><strong>Bold</strong> text</p>');
    clipboardData.setData('text/plain', 'Imported heading\nBold text');
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  });

  await expect.poll(() => api.saveRequests.at(-1)?.body.content).toContain('## Imported heading');
  await expect.poll(() => api.saveRequests.at(-1)?.body.content).toContain('**Bold** text');
});

test('inserts a heading through the slash-command menu', async ({ page }) => {
  const api = await mockBrowserApi(page);
  await page.goto(`/notes/${browserFixture.source.id}`);

  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.press('Backspace');
  await page.evaluate(() => {
    const samples: number[] = [];
    (window as typeof window & { slashMenuXSamples?: number[] }).slashMenuXSamples = samples;
    const sample = () => {
      const menu = document.querySelector<HTMLElement>('.cm-tooltip-autocomplete');
      if (menu) samples.push(menu.getBoundingClientRect().left);
      window.requestAnimationFrame(sample);
    };
    window.requestAnimationFrame(sample);
  });
  await page.keyboard.type('/');

  const slashMenu = page.locator('.cm-tooltip-autocomplete');
  await expect(slashMenu).toBeVisible();
  const slashCursorX = await page
    .locator('.cm-line')
    .first()
    .evaluate((line) => {
      const range = document.createRange();
      const text = line.firstChild;
      if (!text) throw new Error('Expected slash command text');
      range.setStart(text, 1);
      range.setEnd(text, 1);
      return range.getBoundingClientRect().left;
    });
  const slashMenuCursorOffset = async () => {
    const slashMenuBox = await slashMenu.boundingBox();
    if (!slashMenuBox) return Number.POSITIVE_INFINITY;
    return Math.abs(slashMenuBox.x - slashCursorX);
  };
  await expect.poll(slashMenuCursorOffset).toBeLessThan(24);

  // CodeMirror may remeasure after the comment gutter updates; the menu must remain at the cursor.
  await page.waitForTimeout(1_200);
  expect(await slashMenuCursorOffset()).toBeLessThan(24);
  const slashMenuXSamples = await page.evaluate(
    () => (window as typeof window & { slashMenuXSamples?: number[] }).slashMenuXSamples ?? []
  );
  expect(slashMenuXSamples.length).toBeGreaterThan(0);
  expect(Math.max(...slashMenuXSamples.map((x) => Math.abs(x - slashCursorX)))).toBeLessThan(24);

  await page.getByText('Heading 1', { exact: true }).click();
  await page.keyboard.type('Browser heading');
  await api.expectSavedContent('# Browser heading');
});

test('renders a table reached later in a long note', async ({ page }) => {
  const api = await mockBrowserApi(page);
  const longPrefix = Array.from({ length: 400 }, (_, index) => `Paragraph ${index}.`).join('\n\n');
  api.notes.set(browserFixture.source.id, {
    ...browserFixture.source,
    content: `${longPrefix}\n\n## Table\n\n| Feature | Live | Shared | Source preserved |\n| --- | :---: | :---: | :---: |\n| Callouts | Yes | Yes | Yes |\n| Mermaid | Yes | Yes | Yes |`,
  });

  await page.goto(`/notes/${browserFixture.source.id}`);
  await page.locator('.cm-content').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');

  await expect(page.locator('.me-table-widget')).toBeVisible();
  await expect(page.locator('.me-table-render')).toContainText('Source preserved');
});

test('inserts a default table directly and keeps history actions in overflow', async ({ page }) => {
  const api = await mockBrowserApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/notes/${browserFixture.source.id}`);

  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.press('Backspace');

  await expect(page.getByLabel('Undo')).toHaveCount(0);
  await expect(page.getByLabel('Insert image')).toHaveCount(0);
  await page.getByLabel('Open insert menu').click();
  await expect(page.getByLabel('Insert content')).toBeVisible();
  await page.getByRole('button', { name: 'Table', exact: true }).click();

  const table = '\n\n|  |  |\n| --- | --- |\n|  |  |\n\n';
  await api.expectSavedContent(table);
  await expect(page.locator('.me-table-picker')).toHaveCount(0);

  const tableActions = page.locator('.me-table-actions');
  const tableActionsTrigger = page.getByRole('button', { name: 'Table actions' });
  await expect(tableActionsTrigger.locator('svg')).toBeVisible();
  await expect(tableActionsTrigger.locator('svg circle')).toHaveCount(3);
  await expect(tableActionsTrigger).not.toContainText('…');
  await expect(tableActions).toHaveCSS('margin-bottom', '0px');
  const tableActionsBounds = await tableActions.boundingBox();
  const tableActionsTriggerBounds = await tableActionsTrigger.boundingBox();
  expect(tableActionsBounds).not.toBeNull();
  expect(tableActionsTriggerBounds).not.toBeNull();
  if (!tableActionsBounds || !tableActionsTriggerBounds) throw new Error('Table actions bounds unavailable');
  expect(Math.abs(tableActionsTriggerBounds.x - tableActionsBounds.x)).toBeLessThan(1);

  await page.getByLabel('Open editor actions').click();
  await expect(page.getByRole('group', { name: 'Editor actions' })).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await api.expectSavedContent('');

  await page.getByLabel('Open editor actions').click();
  await page.getByRole('button', { name: 'Redo' }).click();
  await api.expectSavedContent(table);
});

test('inserts an external image through the app image picker', async ({ page }) => {
  const api = await mockBrowserApi(page);
  await page.goto(`/notes/${browserFixture.source.id}`);

  await page.getByLabel('Open insert menu').click();
  await page.getByLabel('Insert image').click();
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  await page.getByPlaceholder('Paste the image link…').fill('https://example.com/browser.png');
  await page.getByRole('button', { name: 'Embed image' }).click();

  await expect
    .poll(() => api.notes.get(browserFixture.source.id)?.content)
    .toContain('https://example.com/browser.png');
});

test('uploads an app-owned image and saves its stable attachment URL', async ({ page }) => {
  const api = await mockBrowserApi(page);
  await page.goto(`/notes/${browserFixture.source.id}`);

  await page.getByLabel('Open insert menu').click();
  await page.getByLabel('Insert image').click();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'browser.png',
    mimeType: 'image/png',
    buffer: Buffer.from([137, 80, 78, 71]),
  });

  await expect
    .poll(() => api.notes.get(browserFixture.source.id)?.content)
    .toContain('/internal/attachments/att_browser/content');
});

test('keeps the editor open and reports an app-owned image upload failure', async ({ page }) => {
  await mockBrowserApi(page, { uploadFails: true });
  await page.goto(`/notes/${browserFixture.source.id}`);

  await page.getByLabel('Open insert menu').click();
  await page.getByLabel('Insert image').click();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'browser.png',
    mimeType: 'image/png',
    buffer: Buffer.from([137, 80, 78, 71]),
  });

  await expect(page.getByText('Attachment storage unavailable').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Add an image' })).toBeVisible();
});

test('returns from a canvas to its notes folder', async ({ page }) => {
  await mockBrowserApi(page);
  await page.goto(`/notes/${browserFixture.canvas.id}`);

  await page.getByRole('button', { name: 'Back to notes' }).click();
  await expect(page).toHaveURL(`/folders/${browserFixture.folder.id}`);
});

test('persists a canvas edit through reload', async ({ page }) => {
  const api = await mockBrowserApi(page);
  await page.goto(`/notes/${browserFixture.canvas.id}`);

  await expect(page.locator('.notes-minu-canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Rectangle (R)' }).click();
  await page.getByLabel('Canvas editor').click({ position: { x: 400, y: 300 } });

  await expect.poll(() => api.notes.get(browserFixture.canvas.id)?.content).toContain('rectangle');
  expect(api.saveRequests.find((request) => request.noteId === browserFixture.canvas.id)).toMatchObject({
    body: { baseHash: 'hash_1' },
  });
  await page.reload();
  await expect(page.locator('.notes-minu-canvas')).toBeVisible();
  await expect(page.locator('[data-minucanvas-node-id]')).toHaveCount(1);
});

test('links, opens, and unlinks a canvas node while preserving its external URL', async ({ page }) => {
  const api = await mockBrowserApi(page);
  api.notes.set(browserFixture.canvas.id, {
    ...browserFixture.canvas,
    content: JSON.stringify({
      nodes: [
        {
          id: 'node_link',
          type: 'text',
          text: 'Canvas topic',
          x: 0,
          y: 0,
          width: 180,
          height: 80,
          url: 'https://example.com/reference',
        },
      ],
      edges: [],
    }),
  });
  await page.goto(`/notes/${browserFixture.canvas.id}`);

  const node = () => page.locator('[data-minucanvas-node-id="node_link"]');
  await expect(node()).toBeVisible();
  await node().click({ button: 'right' });
  await page.getByRole('button', { name: 'Link to note…', exact: true }).click();
  await expect(page.getByLabel('Close note link dialog')).toBeVisible();
  await expect(page.getByPlaceholder('Search notes...')).toHaveValue('');
  await page.getByLabel('Close note link dialog').click();
  await expect(page.getByRole('dialog', { name: 'Link node to note' })).toHaveCount(0);

  await node().click({ button: 'right' });
  await page.getByRole('button', { name: 'Link to note…', exact: true }).click();
  await expect(page.getByPlaceholder('Search notes...')).toHaveValue('');
  await page.getByPlaceholder('Search notes...').fill('Target');
  await page.getByRole('button', { name: /Target Note/ }).click();

  await expect
    .poll(() => {
      const content = api.notes.get(browserFixture.canvas.id)?.content;
      if (!content) return null;
      return JSON.parse(content).nodes[0]?.minunotes?.link?.id;
    })
    .toBe(browserFixture.target.id);

  await node().click({ button: 'right' });
  await expect(page.getByRole('button', { name: 'Edit link…', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove note link', exact: true }).click();

  await expect
    .poll(() => {
      const content = api.notes.get(browserFixture.canvas.id)?.content;
      if (!content) return null;
      const linkedNode = JSON.parse(content).nodes[0];
      return { internalLink: linkedNode?.minunotes?.link ?? null, url: linkedNode?.url };
    })
    .toEqual({ internalLink: null, url: 'https://example.com/reference' });

  await node().click({ button: 'right' });
  await page.getByRole('button', { name: 'Link to note…', exact: true }).click();
  await page.getByPlaceholder('Search notes...').fill('Target');
  await page.getByRole('button', { name: /Target Note/ }).click();
  await expect
    .poll(() => {
      const content = api.notes.get(browserFixture.canvas.id)?.content;
      if (!content) return null;
      return JSON.parse(content).nodes[0]?.minunotes?.link?.id;
    })
    .toBe(browserFixture.target.id);

  const popupPromise = page.waitForEvent('popup');
  await page.getByLabel('Open linked note: Canvas topic').click();
  const targetPage = await popupPromise;
  await expect(targetPage).toHaveURL(new RegExp(`/notes/${browserFixture.target.id}$`));
  await targetPage.close();
});

test('inserts an ID-backed wikilink selected from note suggestions', async ({ page }) => {
  const api = await mockBrowserApi(page);
  await page.goto(`/notes/${browserFixture.source.id}`);

  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.type('[[');

  await page.getByText(browserFixture.target.title, { exact: true }).click();
  await api.expectSavedContent(`[[${browserFixture.target.id}|${browserFixture.target.title}]]`);

  const main = page.locator('main');
  await main.evaluate((element) => {
    element.style.paddingTop = '2000px';
    element.scrollTo({ top: element.scrollHeight });
  });
  await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page
    .getByText(`[[${browserFixture.target.id}|${browserFixture.target.title}]]`, { exact: true })
    .click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  await expect(page).toHaveURL(new RegExp(`/notes/${browserFixture.target.id}$`));
  await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBe(0);
});

test('refreshes wikilink suggestions while typing an open wikilink query', async ({ page }) => {
  const api = await mockBrowserApi(page);
  await page.goto(`/notes/${browserFixture.source.id}`);

  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.type('[[');

  api.notes.set('note_fresh_target', {
    ...browserFixture.target,
    id: 'note_fresh_target',
    title: 'Fresh Target',
    content: 'Fresh target content.',
  });

  await page.keyboard.type('Fresh');
  await page.getByText('Fresh Target', { exact: true }).click();
  await api.expectSavedContent('[[note_fresh_target|Fresh Target]]');
});
