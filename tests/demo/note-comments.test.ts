import { expect as browserExpect, chromium, type Page } from '@playwright/test';
import { expect, it } from 'vitest';
import {
  createDemoSandbox,
  DEMO_API_PORT,
  DEMO_BOARD_URL,
  DEMO_WEB_PORT,
  DEMO_WEB_URL,
  type DemoChild,
  demoEnvironment,
  launchDemoChild,
  readDemoCodes,
  stopDemoChild,
} from '../../scripts/lib/board-demo';
import { DEMO_FOLDER_ID, DEMO_USERS } from '../../scripts/lib/board-demo-seed';

it('persists general and anchored discussion through the real browser, authentication, API and scratch database', async () => {
  const sandbox = await createDemoSandbox();
  const children: DemoChild[] = [];
  const browser = await chromium.launch();
  try {
    const env = demoEnvironment(sandbox);
    const api = launchDemoChild(
      ['--import', 'tsx', 'src/api/dev.ts'],
      env,
      new RegExp(`API listening on http://127\\.0\\.0\\.1:${DEMO_API_PORT}`)
    );
    children.push(api);
    await api.ready;
    const web = launchDemoChild(
      ['--import', 'tsx', 'scripts/board-demo-web.ts'],
      env,
      new RegExp(`http://127\\.0\\.0\\.1:${DEMO_WEB_PORT}/`)
    );
    children.push(web);
    await web.ready;
    async function login(page: Page, role: 'owner' | 'commenter') {
      const email = DEMO_USERS[role].email;
      await page.goto(DEMO_BOARD_URL);
      await page.getByPlaceholder('you@example.com').fill(email);
      await page.getByRole('button', { name: 'Send code', exact: true }).click();
      let code = '';
      await expect
        .poll(async () => {
          code = (await readDemoCodes(sandbox)).find((entry) => entry.email === email)?.otp ?? '';
          return code;
        })
        .toMatch(/^\d{6}$/);
      await page.getByPlaceholder('123456').fill(code);
      await page.getByRole('button', { name: 'Verify', exact: true }).click();
      await browserExpect(page.getByRole('region', { name: 'Folder board', exact: true })).toBeVisible();
    }
    const ownerContext = await browser.newContext({ baseURL: DEMO_WEB_URL });
    const page = await ownerContext.newPage();
    await login(page, 'owner');
    const created = await page.request.post(`/internal/folders/${DEMO_FOLDER_ID}/notes`, {
      data: { title: 'General comments smoke', content: 'Hello smoke test' },
    });
    expect(created.status()).toBe(201);
    const noteId = (await created.json()).note.id as string;
    await page.goto(DEMO_BOARD_URL);
    await page.getByRole('link', { name: 'General comments smoke', exact: true }).click();
    await browserExpect(page).toHaveURL(new RegExp(`/notes/${noteId}$`));
    await page.getByRole('button', { name: 'Discussion', exact: true }).click();
    const discussion = page.getByRole('region', { name: 'Discussion', exact: true });
    await discussion.getByRole('textbox', { name: 'New discussion comment' }).fill('Real general discussion');
    await discussion.getByRole('button', { name: 'Post', exact: true }).click();
    await browserExpect(discussion.getByText('Real general discussion', { exact: true })).toBeVisible();
    const read = await (await page.request.get(`/internal/notes/${noteId}`)).json();
    expect(read.note.content).toBe('Hello smoke test');
    const anchored = await page.request.post(`/internal/notes/${noteId}/comments`, {
      data: {
        body: 'Real anchored Review',
        anchor: { anchorType: 'range', from: 0, to: 5, quote: 'Hello', documentHash: read.contentHash },
      },
    });
    expect(anchored.status()).toBe(201);
    const oldList = await (await page.request.get(`/internal/notes/${noteId}/comments`)).json();
    expect(oldList.threads).toHaveLength(1);
    expect(oldList.threads[0].anchor.quote).toBe('Hello');
    await page.reload();
    await browserExpect(page.locator('.me-comment-anchor')).toHaveText('Hello');
    await page.getByRole('button', { name: 'Discussion', exact: true }).click();
    await discussion.getByText('You', { exact: true }).first().click();
    await discussion.getByPlaceholder('Reply…').fill('Real persisted reply');
    await discussion.getByRole('button', { name: 'Reply', exact: true }).click();
    await browserExpect(discussion.getByText('Real persisted reply', { exact: true })).toBeVisible();
    await discussion.getByRole('button', { name: 'Add reaction' }).first().click();
    await page.getByRole('button', { name: 'React with 👍' }).click();
    await browserExpect(discussion.getByRole('button', { name: '👍 reaction, 1' })).toBeVisible();
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('Rewritten body');
    await expect
      .poll(async () => (await (await page.request.get(`/internal/notes/${noteId}`)).json()).note.content)
      .toBe('Rewritten body');
    await page.reload();
    await page.getByRole('button', { name: 'Discussion', exact: true }).click();
    await browserExpect(discussion.getByText('Real general discussion', { exact: true })).toBeVisible();
    await browserExpect(discussion.getByText('Real persisted reply', { exact: true })).toBeVisible();
    await browserExpect(discussion.getByRole('button', { name: '👍 reaction, 1' })).toBeVisible();
    await browserExpect(discussion.getByText(/Detached|reattached/)).toHaveCount(0);
    await page.getByRole('button', { name: 'Open Review' }).click();
    await browserExpect(
      page.getByRole('dialog', { name: 'Review', exact: true }).getByText(/could not be reattached/)
    ).toBeVisible();
    await page.getByRole('button', { name: 'Close Review' }).click();
    // List and Board reach the identical note-owned persisted discussion.
    await page.goto(`/folders/${DEMO_FOLDER_ID}?view=list`);
    await page.getByRole('link', { name: 'General comments smoke', exact: true }).click();
    await page.getByRole('button', { name: 'Discussion', exact: true }).click();
    await browserExpect(discussion.getByText('Real general discussion', { exact: true })).toBeVisible();
    const commenterContext = await browser.newContext({ baseURL: DEMO_WEB_URL });
    const commenter = await commenterContext.newPage();
    await login(commenter, 'commenter');
    await commenter.goto(`/notes/${noteId}`);
    await commenter.getByRole('button', { name: 'Discussion', exact: true }).click();
    await commenter.getByRole('textbox', { name: 'New discussion comment' }).fill('Real Commenter without editing');
    await commenter.getByRole('button', { name: 'Post', exact: true }).click();
    await browserExpect(commenter.getByText('Real Commenter without editing', { exact: true })).toBeVisible();
    expect(
      (
        await commenter.request.patch(`/internal/notes/${noteId}`, {
          data: { content: 'Forbidden', baseHash: read.contentHash },
        })
      ).status()
    ).toBe(403);
    const keyResponse = await page.request.post('/internal/api-keys', {
      data: {
        name: 'Synthetic comment-only smoke',
        accessMode: 'all',
        canRead: true,
        canComment: true,
        canCreate: false,
        canEdit: false,
      },
    });
    expect(keyResponse.status()).toBe(201);
    const keyData = await keyResponse.json();
    const headers = { 'x-api-key': keyData.key };
    const harnessUrl = `http://127.0.0.1:${DEMO_API_PORT}/v1/harness/notes/${noteId}/comments`;
    const generalAgent = await page.request.post(harnessUrl, {
      headers,
      data: { target: 'note', body: 'Real comment-only agent' },
    });
    expect(generalAgent.status()).toBe(201);
    expect((await generalAgent.json()).thread).toMatchObject({ target: 'note', anchor: null });
    const mixed = await (await page.request.get(`${harnessUrl}?includeNoteComments=true`, { headers })).json();
    expect(mixed.threads).toHaveLength(4);
    const tokenResponse = await page.request.post(`/internal/notes/${noteId}/share-link`, { data: {} });
    expect(tokenResponse.status()).toBe(201);
    const token = new URL((await tokenResponse.json()).shareLink.url).pathname.split('/').at(-1);
    const anonymous = await browser.newContext({ baseURL: DEMO_WEB_URL });
    const publicResponse = await anonymous.request.get(`/internal/share/${token}`);
    expect(publicResponse.status()).toBe(200);
    const publicData = await publicResponse.json();
    expect(JSON.stringify(publicData)).not.toMatch(
      /Real general discussion|Real comment-only agent|comment_thread|comment_message/
    );
    expect(
      (
        await anonymous.request.post(`/internal/notes/${noteId}/comments`, {
          data: { target: 'note', body: 'Anonymous' },
        })
      ).status()
    ).toBe(401);
    await page.request.patch(`/internal/api-keys/${keyData.apiKey.id}`, { data: { canComment: false } });
    expect(
      (
        await page.request.post(harnessUrl, { headers, data: { target: 'note', body: 'Denied after downgrade' } })
      ).status()
    ).toBe(403);
    const stored = await sandbox.client.execute({
      sql: 'select anchor_type,anchor_from,quote,document_hash,detached from note_comment_threads where note_id=?',
      args: [noteId],
    });
    expect(stored.rows.filter((row) => row.anchor_type === 'note')).toHaveLength(3);
    expect(
      stored.rows
        .filter((row) => row.anchor_type === 'note')
        .every(
          (row) => row.anchor_from === null && row.quote === null && row.document_hash === null && row.detached === 0
        )
    ).toBe(true);
    expect((await sandbox.client.execute('pragma foreign_key_check')).rows).toEqual([]);
  } finally {
    await browser.close();
    await Promise.all(children.map(stopDemoChild));
    await sandbox.dispose();
  }
}, 90_000);
