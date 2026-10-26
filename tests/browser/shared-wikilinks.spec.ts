import { expect, test } from '@playwright/test';
import { browserFixture, mockBrowserApi } from './fixtures';

test('renders source-bound resolved and unresolved links in a shared note', async ({ page }) => {
  await mockBrowserApi(page);
  await page.goto(`/share/note_share_${browserFixture.linked.id}`);

  const byTitle = page.locator(`a.me-wikilink[data-wikilink-target="Target Note"]`);
  const byId = page.getByRole('link', { name: 'Target by ID' });
  const missing = page.locator(`a.me-wikilink[data-wikilink-target="Missing Note"]`);

  await expect(byTitle).toHaveClass(/me-wikilink--resolved/);
  await expect(byTitle).toHaveAttribute('href', `/share/note_share_${browserFixture.target.id}`);
  await expect(byId).toHaveAttribute('href', `/share/note_share_${browserFixture.target.id}`);
  await expect(missing).toHaveClass(/me-wikilink--unknown/);
  await expect(missing).not.toHaveAttribute('href', /.+/);

  const codeBlocks = page.locator('.me-static-codeblock');
  await expect(codeBlocks).toHaveCount(3);
  await expect(codeBlocks.first().locator('.me-lang-label')).toHaveText('ts');
  await expect(codeBlocks.first()).toHaveCSS('border-top-style', 'solid');
  await expect(codeBlocks.first().locator('.me-codeblock-header')).toHaveCSS('display', 'flex');
  await expect(codeBlocks.first().locator('.me-codeblock-body')).toHaveCSS('overflow-x', 'auto');
  await expect(codeBlocks.first().getByRole('button', { name: 'Copy code' })).toBeVisible();
  await expect(codeBlocks.nth(1).locator('.me-lang-label')).toHaveText('unknownlang');
  await expect(codeBlocks.nth(1).locator('.me-codeblock-body')).toContainText('fallback code');
  await expect(codeBlocks.nth(2).locator('.me-lang-label')).toHaveCount(0);

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await codeBlocks.first().getByRole('button', { name: 'Copy code' }).click();
  await expect(codeBlocks.first().getByRole('button', { name: 'Copy code' })).toHaveText('Copied');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('const answer: number = 42;');

  await byTitle.click();
  await expect(page).toHaveURL(`/share/note_share_${browserFixture.target.id}`);
  await expect(page.getByRole('heading', { name: browserFixture.target.title })).toBeVisible();
});

test('resolves portable attachment destinations in static Markdown', async ({ page }) => {
  const api = await mockBrowserApi(page);
  api.notes.set(browserFixture.linked.id, {
    ...browserFixture.linked,
    content:
      '![Browser image](/internal/attachments/att_browser/content)\n\n[Download](/internal/attachments/att_browser/content?download=1)',
  });
  await page.goto(`/share/note_share_${browserFixture.linked.id}`);

  const expectedImageUrl = new URL(
    '/internal/share/note_share_note_linked/attachments/att_browser/content',
    page.url()
  ).toString();
  await expect(page.locator('.notes-minu-renderer img')).toHaveAttribute('src', expectedImageUrl);
  await expect(page.getByRole('link', { name: 'Download' })).toHaveAttribute('href', `${expectedImageUrl}?download=1`);
});

test('scopes portable attachments to the selected note in a shared folder', async ({ page }) => {
  const api = await mockBrowserApi(page);
  api.notes.set(browserFixture.linked.id, {
    ...browserFixture.linked,
    content: '![Browser image](/internal/attachments/att_browser/content)',
  });
  await page.goto(`/share/folders/folder_share_token?note=${browserFixture.linked.id}`);

  await expect(page.locator('.notes-minu-renderer img')).toHaveAttribute(
    'src',
    new URL(
      `/internal/share/folders/folder_share_token/notes/${browserFixture.linked.id}/attachments/att_browser/content`,
      page.url()
    ).toString()
  );
});

test('renders callouts and Mermaid diagrams in a shared note', async ({ page }) => {
  const api = await mockBrowserApi(page);
  api.notes.set(browserFixture.linked.id, {
    ...browserFixture.linked,
    content: '> [!WARNING]\n> Check this first.\n\n```mermaid\nflowchart LR\n  Shared --> Safe\n```',
  });
  await page.goto(`/share/note_share_${browserFixture.linked.id}`);

  await expect(page.locator('blockquote.me-callout--warning')).toContainText('Check this first.');
  const diagram = page.locator('.me-mermaid-block');
  await expect(diagram).toHaveClass(/me-mermaid-block--ready/, { timeout: 15_000 });
  await expect(diagram.locator('svg')).toBeVisible();
});

test('loads and navigates folder-shared notes through the note search parameter', async ({ page }) => {
  const reads: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/internal/share/folders/')) reads.push(path);
  });
  await mockBrowserApi(page);
  await page.goto(`/share/folders/folder_share_token?note=${browserFixture.linked.id}`);

  await expect(page.getByRole('heading', { name: browserFixture.linked.title })).toBeVisible();
  const target = page.locator(`a.me-wikilink[data-wikilink-target="Target Note"]`);
  const missing = page.locator(`a.me-wikilink[data-wikilink-target="Missing Note"]`);
  await expect(target).toHaveAttribute('href', `/share/folders/folder_share_token?note=${browserFixture.target.id}`);
  await expect(missing).not.toHaveAttribute('href', /.+/);

  await target.click();
  await expect(page).toHaveURL(`/share/folders/folder_share_token?note=${browserFixture.target.id}`);
  await expect(page.getByRole('heading', { name: browserFixture.target.title })).toBeVisible();

  await page.getByRole('button', { name: 'Back to folder' }).click();
  await expect(page).toHaveURL('/share/folders/folder_share_token');
  await page.getByRole('button', { name: browserFixture.linked.title }).click();
  await expect(page).toHaveURL(`/share/folders/folder_share_token?note=${browserFixture.linked.id}`);
  await expect(page.getByRole('heading', { name: browserFixture.linked.title, exact: true })).toBeVisible();
  expect(
    reads.filter((path) => path.endsWith('/wikilinks') || path === '/internal/share/folders/folder_share_token')
  ).toEqual([]);
  expect(reads.filter((path) => path.endsWith(`/notes/${browserFixture.linked.id}`))).toHaveLength(2);
});
