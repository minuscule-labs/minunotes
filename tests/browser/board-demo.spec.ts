import { type ChildProcess, spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { DEMO_BOARD_URL, DEMO_WEB_URL, PROJECT_ROOT } from '../../scripts/lib/board-demo';
import { DEMO_CONFIG, DEMO_FOLDER_ID, DEMO_TEMPLATE_ID, DEMO_USERS } from '../../scripts/lib/board-demo-seed';
import type { EffectiveBoard } from '../../src/shared/board';

test.describe('real disposable board demo', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ baseURL: DEMO_WEB_URL });
  let child: ChildProcess;
  let output = '';
  let exited: Promise<void>;
  let root = '';
  function records(prefix: string) {
    return output
      .split('\n')
      .filter((line) => line.startsWith(`${prefix} `))
      .flatMap((line) => {
        try {
          return [JSON.parse(line.slice(prefix.length + 1))];
        } catch {
          return [];
        }
      });
  }
  test.beforeAll(async () => {
    test.setTimeout(90_000);
    child = spawn(process.execPath, ['--import', 'tsx', 'scripts/board-demo.ts', '--large'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        TURSO_DB_URL: 'libsql://must-not-be-used.invalid',
        SES_FROM_EMAIL: 'must-not-send@example.com',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const capture = (chunk: Buffer) => {
      output = `${output}${chunk}`.slice(-1_000_000);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    exited = new Promise((resolve) => child.once('exit', () => resolve()));
    for (let count = 0; count < 600 && !records('BOARD_DEMO_READY').length; count++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(output);
      await delay(100);
    }
    const ready = records('BOARD_DEMO_READY').at(-1);
    expect(ready, output).toBeTruthy();
    root = ready.root;
    expect(ready.counts).toEqual({ notes: 172, visibleCards: 167, todoCards: 158 });
  });
  test.afterAll(async () => {
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`Demo cleanup timed out\n${output}`));
          }, 15_000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    expect(output).toContain('BOARD_DEMO_CLEANED');
    if (root) await expect(stat(root)).rejects.toHaveProperty('code', 'ENOENT');
  });
  async function login(page: Page, role: 'owner' | 'viewer' | 'editor') {
    const email = DEMO_USERS[role].email;
    const previousCodes = records('BOARD_DEMO_OTP').length;
    await page.goto(DEMO_BOARD_URL);
    await page.getByPlaceholder('you@example.com').fill(email);
    await page.getByRole('button', { name: 'Send code', exact: true }).click();
    const currentCode = () =>
      records('BOARD_DEMO_OTP')
        .slice(previousCodes)
        .find((record) => record.email === email);
    await expect.poll(() => currentCode()?.otp, { timeout: 10_000 }).toMatch(/^\d{6}$/);
    const otp = currentCode().otp;
    await page.getByPlaceholder('123456').fill(otp);
    await page.getByRole('button', { name: 'Verify', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Folder board', exact: true })).toBeVisible();
  }

  async function expectPropertySaved(
    page: Page,
    noteId: string | undefined,
    minimumRevision: number,
    values: Record<string, string>
  ) {
    expect(noteId).toMatch(/^note_[a-f0-9]{32}$/);
    expect(Object.keys(values).length).toBeGreaterThan(0);
    // Wait for the intended REAL server values/revision, not silence or a previous save.
    await expect
      .poll(async () => {
        const response = await page.request.get(`/internal/notes/${noteId}/properties`);
        expect(response.status()).toBe(200);
        const properties = await response.json();
        return {
          advanced: properties.revision >= minimumRevision,
          values: Object.fromEntries(Object.keys(values).map((id) => [id, properties.values[id] ?? null])),
        };
      })
      .toEqual({ advanced: true, values });
    const panel = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^Properties$/ }) });
    await expect(panel).toHaveAttribute('aria-busy', 'false');
    await expect
      .poll(() => page.evaluate((id) => sessionStorage.getItem(`minunotes:properties-draft:${id}`), noteId))
      .toBeNull();
    await expect(panel.getByRole('status')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: /Reload|Review changes/ })).toHaveCount(0);
  }

  let configContext: BrowserContext;
  let configPage: Page;
  let initialBoard: EffectiveBoard;
  test.beforeEach(async ({ browser }) => {
    configContext = await browser.newContext({ baseURL: DEMO_WEB_URL });
    configPage = await configContext.newPage();
    await login(configPage, 'owner');
    initialBoard = (await (await configPage.request.get(`/internal/folders/${DEMO_FOLDER_ID}/board/config`)).json())
      .board;
  });
  test.afterEach(async () => {
    try {
      const current = (await (await configPage.request.get(`/internal/folders/${DEMO_FOLDER_ID}/board/config`)).json())
        .board;
      const schema = await (await configPage.request.get(`/internal/folders/${DEMO_FOLDER_ID}/properties`)).json();
      expect(
        (
          await configPage.request.put(`/internal/folders/${DEMO_FOLDER_ID}/board/config`, {
            data: {
              config: initialBoard.config,
              expectedVersion: current.version,
              schemaId: schema.schemaId,
              schemaRevision: schema.revision,
            },
          })
        ).status()
      ).toBe(200);
    } finally {
      await configContext.close();
    }
  });

  test('fresh demo defaults to Status and Type without tag-gated cards', async ({ page }) => {
    await login(page, 'owner');
    const board = page.getByRole('region', { name: 'Folder board', exact: true });
    await expect(board.getByRole('heading', { level: 3 })).toHaveText(['Todo', 'In progress', 'Done', 'Unclassified']);
    const current = (await (await page.request.get(`/internal/folders/${DEMO_FOLDER_ID}/board/config`)).json()).board;
    expect(current.config).toEqual(DEMO_CONFIG);
    await expect(board.getByRole('definition').filter({ hasText: /^Bug$/ }).first()).toBeVisible();
    await expect(board.getByText('status-todo', { exact: true })).toHaveCount(0);
    await expect(board.getByRole('link', { name: 'Excluded: missing board tag', exact: true })).toBeVisible();
    await expect(board.getByRole('link', { name: 'Excluded: exclusion tag', exact: true })).toBeVisible();
    await expect(
      board.getByRole('region', { name: 'Unclassified', exact: true }).getByText('No property value', { exact: true })
    ).toHaveCount(2);
  });

  test('viewer finds an unloaded note through one read-only folder query in List and Board, then clears it', async ({
    page,
  }) => {
    await login(page, 'viewer');
    const board = page.getByRole('region', { name: 'Folder board', exact: true });
    await expect(board.getByRole('link', { name: 'Pagination card 150', exact: true })).toHaveCount(0);
    const before = (await (await page.request.get(`/internal/folders/${DEMO_FOLDER_ID}/board/config`)).json()).board;
    const writes: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/internal/') && request.method() !== 'GET') writes.push(request.url());
    });
    const switchView = async (view: 'list' | 'board') => {
      const title = await page.getByRole('main').getByRole('heading', { level: 2 }).innerText();
      await page
        .getByRole('main')
        .getByRole('button', { name: `Actions for ${title}`, exact: true })
        .click();
      await page.getByRole('button', { name: `Switch to ${view}`, exact: true }).click();
    };
    await switchView('list');
    const search = page.getByRole('textbox', { name: 'Search titles in this folder', exact: true });
    await search.fill('Pagination card 150');
    await search.press('Enter');
    await expect(page.getByRole('main').getByRole('link', { name: 'Pagination card 150', exact: true })).toBeVisible();
    const link = await page
      .getByRole('main')
      .getByRole('link', { name: 'Pagination card 150', exact: true })
      .getAttribute('href');
    if (!link) throw new Error('Missing matched note link');
    const noteId = link.split('/').at(-1);
    const valuesBefore = await (await page.request.get(`/internal/notes/${noteId}/properties`)).json();
    const schema = await (await page.request.get(`/internal/folders/${DEMO_FOLDER_ID}/properties`)).json();
    const status = schema.definitions.find((field: { label: string }) => field.label === 'Status');
    const todo = status.options.find((option: { label: string }) => option.label === 'Todo');
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    const panel = page.getByRole('dialog', { name: 'Filter notes' });
    await panel.getByRole('button', { name: 'Add property', exact: true }).click();
    await panel.getByLabel('Add property', { exact: true }).selectOption(status.id);
    await panel.getByRole('checkbox', { name: todo.label, exact: true }).check();
    await panel.getByRole('button', { name: 'Apply', exact: true }).click();
    await page.getByRole('button', { name: /^Sort by ·/ }).click();
    const sortPanel = page.getByRole('dialog', { name: 'Sort notes', exact: true });
    await sortPanel.getByRole('button', { name: 'Status · select property', exact: true }).click();
    await sortPanel.getByLabel('Sort direction', { exact: true }).selectOption('desc');
    await sortPanel.press('Escape');
    const propertySort = new URL(page.url()).searchParams.get('sort');
    expect(JSON.parse(propertySort ?? 'null')).toEqual({
      version: 1,
      schemaId: schema.schemaId,
      propertyId: status.id,
      type: 'select',
      direction: 'desc',
    });
    const filters = new URL(page.url()).searchParams.get('filters');
    const list = await (
      await page.request.get(
        `/internal/folders/${DEMO_FOLDER_ID}/notes?type=note&limit=50&page=1&sort=${encodeURIComponent(propertySort ?? '')}&q=Pagination+card+150&filters=${encodeURIComponent(filters ?? '')}&schemaId=${schema.schemaId}&schemaRevision=${schema.revision}`
      )
    ).json();
    expect(list.notes.map((note: { id: string }) => note.id)).toEqual([noteId]);
    expect(list.sortIdentity).toBe(propertySort);
    expect(list.querySchema).toEqual({ schemaId: schema.schemaId, schemaRevision: schema.revision });
    await switchView('board');
    expect(new URL(page.url()).searchParams.get('filters')).toBe(filters);
    expect(new URL(page.url()).searchParams.get('sort')).toBe(propertySort);
    await expect(board.getByRole('link', { name: 'Pagination card 150', exact: true })).toHaveAttribute('href', link);
    await expect(board.getByRole('button', { name: /^Load more/ })).toHaveCount(0);
    await expect(board.getByRole('note', { name: '1 card loaded.', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Filter · 1', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Filter notes' })
      .getByRole('button', { name: 'Clear all', exact: true })
      .click();
    await panel.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(search).toHaveValue('Pagination card 150');
    await page.getByRole('button', { name: 'Clear search', exact: true }).click();
    await expect(board.getByRole('button', { name: 'Load more Todo', exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('sort')).toBe(propertySort);
    expect(writes).toEqual([]);
    expect(await (await page.request.get(`/internal/notes/${noteId}/properties`)).json()).toEqual(valuesBefore);
    expect((await (await page.request.get(`/internal/folders/${DEMO_FOLDER_ID}/board/config`)).json()).board).toEqual(
      before
    );
  });

  test('owner configures defaults independently, editor reviews one atomic instance and it enters a property-backed lane', async ({
    page,
    browser,
  }) => {
    await login(page, 'owner');
    await page.goto(`/notes/${DEMO_TEMPLATE_ID}`);
    await page.locator('summary').filter({ hasText: 'Template defaults' }).click();
    await page.getByLabel('Assigned destination').selectOption(DEMO_FOLDER_ID);
    await page.getByLabel('Summary', { exact: true }).fill('Owner prepared default');
    await page.getByRole('button', { name: 'Save default properties', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Default properties saved' })).toBeVisible();
    const context = await browser.newContext({ baseURL: DEMO_WEB_URL });
    try {
      const editor = await context.newPage();
      await login(editor, 'editor');
      expect((await editor.request.get(`/internal/notes/${DEMO_TEMPLATE_ID}`)).status()).toBe(404);
      await editor.goto(`/folders/${DEMO_FOLDER_ID}/new-from-template`);
      await editor.getByRole('button', { name: 'Excluded: template', exact: true }).click();
      await expect(editor.getByLabel('Summary', { exact: true })).toHaveValue('Owner prepared default');
      await editor.getByLabel('Note title').fill('000 Template reviewed note');
      await editor.getByLabel('Final tags').fill('board, board-lite, status-done');
      // Ordinary tags do not group cards: explicitly review the actual Status property.
      await editor.getByLabel('Status', { exact: true }).selectOption({ label: 'Done' });
      await editor.getByLabel('Summary', { exact: true }).fill('Final reviewed value');
      await editor.getByRole('button', { name: 'Clear Due date', exact: true }).click();
      const request = editor.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/notes/from-template'));
      await editor.getByRole('button', { name: 'Create note', exact: true }).click();
      const payload = (await request).postDataJSON();
      await expect(editor).toHaveURL(/\/notes\/note_[a-f0-9]{32}$/);
      const noteId = new URL(editor.url()).pathname.split('/').at(-1);
      const note = await (await editor.request.get(`/internal/notes/${noteId}`)).json();
      const properties = await (await editor.request.get(`/internal/notes/${noteId}/properties`)).json();
      expect(note.note.content).toContain('000 Template reviewed note');
      expect(note.note.content).toContain(payload.variables.datetime);
      expect(Object.values(properties.values)).toContain('Final reviewed value');
      const status = properties.schema.definitions.find((field: { label: string }) => field.label === 'Status');
      expect(properties.values[status.id]).toBe(
        status.options.find((option: { label: string }) => option.label === 'Done').id
      );
      expect(Object.values(properties.values)).not.toContain('2026-10-31');
      const retry = await editor.request.post(`/internal/folders/${DEMO_FOLDER_ID}/notes/from-template`, {
        data: payload,
      });
      expect(retry.status()).toBe(200);
      expect((await retry.json()).note.id).toBe(noteId);
      const events = await (await page.request.get(`/internal/notes/${noteId}/events`)).json();
      expect(events.events.filter((e: { eventType: string }) => e.eventType === 'create')).toHaveLength(1);
      await editor.goto(DEMO_BOARD_URL);
      await expect(
        editor
          .getByRole('region', { name: 'Done', exact: true })
          .getByRole('link', { name: '000 Template reviewed note', exact: true })
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('owner signs in normally, sees scoped real cards and opens the existing note editor', async ({ page }) => {
    await login(page, 'owner');
    const board = page.getByRole('region', { name: 'Folder board', exact: true });
    await expect(board.getByRole('link', { name: 'Backlog example 1', exact: true })).toBeVisible();
    await expect(board.getByRole('link', { name: 'Canvas planning example', exact: true })).toBeVisible();
    await expect(board.getByText('No property value', { exact: true })).toHaveCount(2);
    await expect(board.getByText('Multiple mapped tags', { exact: true })).toHaveCount(0);
    await expect(board.getByRole('link', { name: 'Excluded: exclusion tag', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Board settings', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await board.getByRole('link', { name: 'Backlog example 1', exact: true }).click();
    await expect(page).toHaveURL(/\/notes\/note_[a-f0-9]{32}$/);
    await expect(page.getByPlaceholder('Untitled note', { exact: true })).toHaveValue('Backlog example 1');
    const noteId = new URL(page.url()).pathname.split('/').at(-1);
    const before = await (await page.request.get(`/internal/notes/${noteId}`)).json();
    const propertiesBefore = await (await page.request.get(`/internal/notes/${noteId}/properties`)).json();
    const statusBefore = propertiesBefore.schema.definitions.find(
      (field: { label: string }) => field.label === 'Status'
    );
    const summaryBefore = propertiesBefore.schema.definitions.find(
      (field: { label: string }) => field.label === 'Summary'
    );
    const doneId = statusBefore.options.find((option: { label: string }) => option.label === 'Done').id;
    await page.locator('summary').filter({ hasText: 'Properties' }).click();
    await page.getByLabel('Status', { exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Choose Status' })
      .getByRole('button', { name: 'Done', exact: true })
      .click();
    await expectPropertySaved(page, noteId, propertiesBefore.revision + 1, { [statusBefore.id]: doneId });
    await page.getByLabel('Summary', { exact: true }).fill('Owner synthetic metadata edit');
    await page.getByLabel('Summary', { exact: true }).press('Tab');
    await expectPropertySaved(page, noteId, propertiesBefore.revision + 2, {
      [statusBefore.id]: doneId,
      [summaryBefore.id]: 'Owner synthetic metadata edit',
    });
    const after = await (await page.request.get(`/internal/notes/${noteId}`)).json();
    const propertiesAfter = await (await page.request.get(`/internal/notes/${noteId}/properties`)).json();
    expect(after.note.content).toBe(before.note.content);
    expect(after.contentHash).toBe(before.contentHash);
    expect(propertiesAfter.revision).toBe(propertiesBefore.revision + 2);
    const statusField = propertiesAfter.schema.definitions.find((field: { label: string }) => field.label === 'Status');
    const summaryField = propertiesAfter.schema.definitions.find(
      (field: { label: string }) => field.label === 'Summary'
    );
    expect(propertiesAfter.values[statusField.id]).toBe(
      statusField.options.find((option: { label: string }) => option.label === 'Done').id
    );
    expect(propertiesAfter.values[summaryField.id]).toBe('Owner synthetic metadata edit');
    await page.goto(DEMO_BOARD_URL);
    await expect(
      page
        .getByRole('region', { name: 'Done', exact: true })
        .getByRole('link', { name: 'Backlog example 1', exact: true })
    ).toBeVisible();
  });

  test('editor signs in normally, edits inherited properties but cannot define fields', async ({ page }) => {
    await login(page, 'editor');
    await page
      .getByRole('region', { name: 'Folder board', exact: true })
      .getByRole('link', { name: 'Backlog example 2', exact: true })
      .click();
    const noteId = new URL(page.url()).pathname.split('/').at(-1);
    const before = await (await page.request.get(`/internal/notes/${noteId}`)).json();
    const propertiesBefore = await (await page.request.get(`/internal/notes/${noteId}/properties`)).json();
    const summaryBefore = propertiesBefore.schema.definitions.find(
      (field: { label: string }) => field.label === 'Summary'
    );
    const dateBefore = propertiesBefore.schema.definitions.find(
      (field: { label: string }) => field.label === 'Due date'
    );
    await page.locator('summary').filter({ hasText: 'Properties' }).click();
    await page.getByLabel('Summary', { exact: true }).fill('Editor synthetic metadata edit');
    await page.getByLabel('Due date', { exact: true }).fill('2028-02-29');
    await page.getByLabel('Due date', { exact: true }).press('Enter');
    await expectPropertySaved(page, noteId, propertiesBefore.revision + 1, {
      [summaryBefore.id]: 'Editor synthetic metadata edit',
      [dateBefore.id]: '2028-02-29',
    });
    const after = await (await page.request.get(`/internal/notes/${noteId}`)).json();
    expect(after.contentHash).toBe(before.contentHash);
    const saved = await (await page.request.get(`/internal/notes/${noteId}/properties`)).json();
    const summaryField = saved.schema.definitions.find((field: { label: string }) => field.label === 'Summary');
    const dateField = saved.schema.definitions.find((field: { label: string }) => field.label === 'Due date');
    expect(saved.values[summaryField.id]).toBe('Editor synthetic metadata edit');
    expect(saved.values[dateField.id]).toBe('2028-02-29');
    await expect(page.getByRole('link', { name: 'Add a property', exact: true })).toHaveCount(0);
    expect(
      (
        await page.request.patch(`/internal/folders/${DEMO_FOLDER_ID}/properties`, {
          data: { expectedRevision: 1, mutation: { type: 'add', label: 'Denied', fieldType: 'text' } },
        })
      ).status()
    ).toBe(403);
  });
  test('viewer signs in with a real session, reads inherited cards and cannot configure', async ({ page }) => {
    await login(page, 'viewer');
    await expect(page.getByRole('button', { name: 'Board settings', exact: true })).toHaveCount(0);
    const config = await page.request.get(`/internal/folders/${DEMO_FOLDER_ID}/board/config`);
    expect(config.status()).toBe(200);
    const viewerConfig = await config.json();
    expect(viewerConfig.access.role).toBe('viewer');
    const denied = await page.request.put(`/internal/folders/${DEMO_FOLDER_ID}/board/config`, {
      data: { config: DEMO_CONFIG, expectedVersion: viewerConfig.board.version },
    });
    expect(denied.status()).toBe(403);
    expect(
      (await (await page.request.get(`/internal/folders/${DEMO_FOLDER_ID}/board/config`)).json()).board.version
    ).toBe(viewerConfig.board.version);
    expect((await page.request.get('/internal/folders/folder_demo_other/board?lane=todo')).status()).toBe(404);
    const board = page.getByRole('region', { name: 'Folder board', exact: true });
    const columnSizes = () =>
      board.locator(':scope > section').evaluateAll((columns) =>
        columns.map((column) => {
          const { width, height } = column.getBoundingClientRect();
          return { width, height };
        })
      );
    const todo = page.getByRole('region', { name: 'Todo', exact: true });
    const expectTodoCount = async (count: number, more: boolean) => {
      const description = `${count} cards loaded.${more ? ' More available.' : ''}`;
      const number = todo.getByRole('note', { name: description, exact: true });
      await expect(number).toBeVisible();
      await expect(number).toHaveText(`· ${count}${more ? '+' : ''}`);
      await expect(todo.getByRole('heading', { level: 3 })).toHaveAccessibleDescription(description);
    };
    await expectTodoCount(25, true);
    await expect
      .poll(() =>
        board.evaluate((grid) => {
          const main = grid.closest('main');
          if (!main) throw new Error('Missing main content');
          const style = getComputedStyle(main);
          return Math.abs(
            grid.getBoundingClientRect().bottom -
              (main.getBoundingClientRect().bottom -
                Number.parseFloat(style.paddingBottom) -
                Number.parseFloat(style.borderBottomWidth))
          );
        })
      )
      .toBeLessThanOrEqual(2);
    const before = await columnSizes();
    expect(before).toHaveLength(4);
    for (const column of before) expect(column).toEqual(before[0]);
    for (let count = 0; count < 6; count++) {
      await todo.getByRole('button', { name: 'Load more Todo', exact: true }).click();
      await expectTodoCount(Math.min((count + 2) * 25, 157), count < 5);
    }
    await expect(todo.getByRole('link')).toHaveCount(157);
    expect(await columnSizes()).toEqual(before);
    const cards = todo.getByRole('region', { name: 'Todo cards', exact: true });
    expect(await cards.evaluate((element) => element.scrollHeight)).toBeGreaterThan(
      await cards.evaluate((element) => element.clientHeight)
    );
    await todo.getByRole('link', { name: 'Pagination card 150', exact: true }).focus();
    await expect(todo.getByRole('link', { name: 'Pagination card 150', exact: true })).toBeInViewport();
    await expect(todo.getByRole('link', { name: 'Pagination card 150', exact: true })).toHaveCount(1);
    await expect(todo.getByRole('button', { name: 'Load more Todo', exact: true })).toHaveCount(0);
    await page
      .getByRole('region', { name: 'Done', exact: true })
      .getByRole('link', { name: 'Backlog example 1', exact: true })
      .click();
    await page.locator('summary').filter({ hasText: 'Properties' }).click();
    await expect(page.getByLabel('Status', { exact: true })).toBeDisabled();
    await expect(page.getByLabel('Summary', { exact: true })).toHaveAttribute('readonly', '');
    await expect(page.getByRole('button', { name: 'Save properties', exact: true })).toHaveCount(0);
    const noteId = new URL(page.url()).pathname.split('/').at(-1);
    const props = await (await page.request.get(`/internal/notes/${noteId}/properties`)).json();
    expect(
      (
        await page.request.patch(`/internal/notes/${noteId}/properties`, {
          data: {
            schemaId: props.schema.schemaId,
            schemaRevision: props.schema.revision,
            expectedRevision: props.revision,
            values: {},
          },
        })
      ).status()
    ).toBe(403);
  });

  test('owner reads a property-only board without per-note body reads or board writes', async ({ page }) => {
    const requests: Array<{ method: string; path: string }> = [];
    page.on('request', (request) => requests.push({ method: request.method(), path: new URL(request.url()).pathname }));
    await login(page, 'owner');
    await expect(page.getByLabel('Filter tags (all, comma-separated)')).toHaveCount(0);
    const board = page.getByRole('region', { name: 'Folder board', exact: true });
    await expect(board.getByRole('link', { name: 'Excluded: missing board tag', exact: true })).toBeVisible();
    await expect(board.getByRole('link', { name: 'Excluded: exclusion tag', exact: true })).toBeVisible();
    expect(requests.filter((request) => /^\/internal\/notes\/note_[a-f0-9]{32}(\/|$)/.test(request.path))).toEqual([]);
    expect(requests.filter((request) => request.path.includes('/board') && request.method !== 'GET')).toEqual([]);
  });

  test('owner switches grouping properties; divergent ordinary tags never affect placement or metadata', async ({
    page,
    browser,
  }) => {
    await login(page, 'owner');
    const initial = (await (await page.request.get(`/internal/folders/${DEMO_FOLDER_ID}/board/config`)).json()).board;
    const context = await browser.newContext({ baseURL: DEMO_WEB_URL });
    const viewerContext = await browser.newContext({ baseURL: DEMO_WEB_URL });
    try {
      await page.getByRole('button', { name: 'Board settings', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Board settings' });
      await dialog.getByLabel('Columns', { exact: true }).selectOption({ label: 'Status' });
      await dialog.getByRole('checkbox', { name: 'Type select', exact: true }).check();
      await dialog.getByRole('checkbox', { name: 'Summary text', exact: true }).check();
      await dialog.getByRole('checkbox', { name: 'Due date date', exact: true }).check();
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      expect((await (await page.request.get(`/internal/folders/${DEMO_FOLDER_ID}/board/config`)).json()).board).toEqual(
        initial
      );
      await page.getByRole('button', { name: 'Board settings', exact: true }).click();
      await expect(dialog.getByRole('checkbox', { name: 'Summary text', exact: true })).not.toBeChecked();
      await dialog.getByRole('checkbox', { name: 'Summary text', exact: true }).check();
      await dialog.getByRole('checkbox', { name: 'Due date date', exact: true }).check();
      await dialog.getByRole('button', { name: 'Save board', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      const savedVisibility = (
        await (await page.request.get(`/internal/folders/${DEMO_FOLDER_ID}/board/config`)).json()
      ).board;
      expect(savedVisibility.config.cardPropertyIds).toHaveLength(3);
      const example = page.getByRole('link', { name: 'Excluded: missing board tag', exact: true }).locator('..');
      await expect(example.getByRole('term')).toHaveText(['Summary:', 'Due date:', 'Type:']);
      await expect(example.getByRole('definition').nth(1)).toHaveText('2026-10-31');
      await expect(
        page.getByRole('region', { name: 'Folder board', exact: true }).getByRole('heading', { level: 3 })
      ).toHaveText(['Todo', 'In progress', 'Done', 'Unclassified']);
      const editor = await context.newPage();
      await login(editor, 'editor');
      await editor.goto(`/folders/${DEMO_FOLDER_ID}/new-from-template`);
      await editor.getByRole('button', { name: 'Excluded: template', exact: true }).click();
      await editor.getByLabel('Note title').fill('000 Select divergent template note');
      await editor.getByLabel('Final tags').fill('board, board-lite, status-todo');
      await editor.getByLabel('Status', { exact: true }).selectOption({ label: 'Done' });
      await editor.getByLabel('Type', { exact: true }).selectOption({ label: 'Bug' });
      await editor.getByRole('button', { name: 'Create note', exact: true }).click();
      await expect(editor).toHaveURL(/\/notes\/note_[a-f0-9]{32}$/);
      const noteId = new URL(editor.url()).pathname.split('/').at(-1);
      const before = await (await editor.request.get(`/internal/notes/${noteId}`)).json();
      const properties = await (await editor.request.get(`/internal/notes/${noteId}/properties`)).json();
      const tags = await (await editor.request.get(`/internal/notes/${noteId}/tags`)).json();
      const viewer = await viewerContext.newPage();
      await login(viewer, 'viewer');
      await viewer.getByRole('button', { name: 'Refresh board' }).click();
      await expect(
        viewer
          .getByRole('region', { name: 'Done', exact: true })
          .getByRole('link', { name: '000 Select divergent template note', exact: true })
      ).toBeVisible();
      await expect(
        viewer
          .getByRole('link', { name: '000 Select divergent template note', exact: true })
          .locator('..')
          .getByRole('definition')
          .filter({ hasText: /^Bug$/ })
      ).toBeVisible();
      await editor.goto(DEMO_BOARD_URL);
      await expect(
        editor
          .getByRole('region', { name: 'Done', exact: true })
          .getByRole('link', { name: '000 Select divergent template note', exact: true })
      ).toBeVisible();
      await editor
        .getByRole('region', { name: 'Done', exact: true })
        .getByRole('link', { name: '000 Select divergent template note', exact: true })
        .click();
      await expect(editor.getByPlaceholder('Untitled note', { exact: true })).toHaveValue(
        '000 Select divergent template note'
      );
      await page.getByRole('button', { name: 'Board settings', exact: true }).click();
      await dialog.getByLabel('Columns', { exact: true }).selectOption({ label: 'Type' });
      await dialog.getByRole('button', { name: 'Save board', exact: true }).click();
      await expect(
        page
          .getByRole('region', { name: 'Bug', exact: true })
          .getByRole('link', { name: '000 Select divergent template note', exact: true })
      ).toBeVisible();
      await page.getByRole('button', { name: 'Board settings', exact: true }).click();
      await dialog.getByLabel('Columns', { exact: true }).selectOption({ label: 'Status' });
      await dialog.getByRole('button', { name: 'Save board', exact: true }).click();
      await expect(
        page
          .getByRole('region', { name: 'Done', exact: true })
          .getByRole('link', { name: '000 Select divergent template note', exact: true })
      ).toBeVisible();
      expect((await (await editor.request.get(`/internal/notes/${noteId}`)).json()).contentHash).toBe(
        before.contentHash
      );
      expect(await (await editor.request.get(`/internal/notes/${noteId}/properties`)).json()).toEqual(properties);
      expect(await (await editor.request.get(`/internal/notes/${noteId}/tags`)).json()).toEqual(tags);
    } finally {
      const current = (await (await page.request.get(`/internal/folders/${DEMO_FOLDER_ID}/board/config`)).json()).board;
      if (JSON.stringify(current.config) !== JSON.stringify(initial.config)) {
        const schema = await (await page.request.get(`/internal/folders/${DEMO_FOLDER_ID}/properties`)).json();
        expect(
          (
            await page.request.put(`/internal/folders/${DEMO_FOLDER_ID}/board/config`, {
              data: {
                config: initial.config,
                expectedVersion: current.version,
                schemaId: schema.schemaId,
                schemaRevision: schema.revision,
              },
            })
          ).status()
        ).toBe(200);
      }
      await context.close();
      await viewerContext.close();
    }
  });

  test('owner manages compact schema context without changing values; real template and active Select archive guards hold', async ({
    page,
  }) => {
    await login(page, 'owner');
    const href = await page
      .getByRole('region', { name: 'Folder board', exact: true })
      .getByRole('link', { name: 'Backlog example 1', exact: true })
      .getAttribute('href');
    const noteId = href?.split('/').at(-1);
    expect(noteId).toMatch(/^note_[a-f0-9]{32}$/);
    const readSchema = async () =>
      await (await page.request.get(`/internal/folders/${DEMO_FOLDER_ID}/properties`)).json();
    const before = await readSchema();
    const valuesBefore = await (await page.request.get(`/internal/notes/${noteId}/properties`)).json();
    const bodyBefore = await (await page.request.get(`/internal/notes/${noteId}`)).json();
    const status = before.definitions.find((field: { label: string }) => field.label === 'Status');
    const firstOption = status.options[0];
    const patchPath = `/internal/folders/${DEMO_FOLDER_ID}/properties`;
    const writes: { expectedRevision: number; mutation: { type: string; propertyId?: string; optionId?: string } }[] =
      [];
    page.on('request', (r) => {
      if (r.method() === 'PATCH' && new URL(r.url()).pathname === patchPath) writes.push(r.postDataJSON());
    });
    const manager = (label: string) => page.getByRole('dialog', { name: `Manage property ${label}`, exact: true });
    const actions = async (label: string) => {
      await page.getByRole('button', { name: `Actions for property ${label}`, exact: true }).click();
      return page.getByRole('dialog', { name: `Actions for property ${label}`, exact: true });
    };
    const saveLabel = async (label: string) => {
      await page.getByLabel('Label', { exact: true }).fill(label);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    };
    await page.goto(`/folders/${DEMO_FOLDER_ID}/settings`);
    const list = page.getByRole('list', { name: 'Folder properties', exact: true });
    await expect(list.getByRole('listitem')).toHaveCount(
      before.definitions.filter((d: { archived: boolean }) => !d.archived).length
    );
    await expect(list.getByRole('button')).toHaveCount(
      before.definitions.filter((d: { archived: boolean }) => !d.archived).length * 2
    );
    await expect(page.getByRole('button', { name: /^Rename option / })).toHaveCount(0);
    await expect(list.getByText(/^(Text|Select|Date)$/)).toHaveCount(0);
    const statusName = page.getByRole('button', { name: 'Manage Status', exact: true });
    await expect(statusName.locator('svg[aria-hidden="true"]')).toHaveCount(1);
    await statusName.hover();
    const rowColor = await statusName.locator('..').evaluate((row) => getComputedStyle(row).backgroundColor);
    expect(rowColor).not.toBe('rgba(0, 0, 0, 0)');
    const statusEllipsis = page.getByRole('button', { name: 'Actions for property Status', exact: true });
    await statusEllipsis.hover();
    await expect(statusName.locator('..')).toHaveCSS('background-color', rowColor);
    await expect(statusName).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(statusEllipsis).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await statusName.click();
    await expect(manager('Status').getByText('Select', { exact: true })).toBeVisible();
    await expect(manager('Status').getByRole('combobox')).toHaveCount(0);
    await expect(manager('Status').getByText('Archiving preserves saved values.', { exact: true })).toHaveCount(0);
    await expect(manager('Status').getByRole('button', { name: /^Rename option / })).toHaveCount(status.options.length);
    await expect(page.getByRole('button', { name: 'Rename option Bug', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    expect(writes).toHaveLength(0);
    const originalIds = status.options.map((option: { id: string }) => option.id);
    const downIds = [...originalIds];
    [downIds[0], downIds[1]] = [downIds[1], downIds[0]];
    const reorder = async (direction: 'down' | 'up', expectedIds: string[], expectedRevision: number) => {
      if (!(await manager('Status').isVisible())) await statusName.click();
      await manager('Status')
        .getByRole('button', { name: `Actions for option ${firstOption.label}`, exact: true })
        .click();
      const menu = page.getByRole('dialog', { name: `Actions for option ${firstOption.label}`, exact: true });
      const move = menu.getByRole('button', { name: `Move option ${firstOption.label} ${direction}`, exact: true });
      await expect(move).toBeEnabled();
      await expect(move.locator(`svg.lucide-arrow-${direction}`)).toHaveAttribute('aria-hidden', 'true');
      const response = page.waitForResponse(
        (r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname === patchPath
      );
      await move.click();
      expect((await response).status()).toBe(200);
      const accepted = await readSchema();
      expect(accepted.revision).toBe(expectedRevision + 1);
      const options = accepted.definitions.find((field: { id: string }) => field.id === status.id).options;
      expect(options.map((option: { id: string }) => option.id)).toEqual(expectedIds);
      await expect(manager('Status').getByRole('button', { name: /^Rename option / })).toHaveText(
        options
          .filter((option: { archived: boolean }) => !option.archived)
          .map((option: { label: string }) => option.label)
      );
      const values = await (await page.request.get(`/internal/notes/${noteId}/properties`)).json();
      expect(values.values).toEqual(valuesBefore.values);
      expect(values.revision).toBe(valuesBefore.revision);
    };
    await reorder('down', downIds, before.revision);
    await reorder('up', originalIds, before.revision + 1);
    expect((await readSchema()).definitions).toEqual(before.definitions);
    expect(writes).toEqual([
      {
        expectedRevision: before.revision,
        mutation: { type: 'reorder_options', propertyId: status.id, optionIds: downIds },
      },
      {
        expectedRevision: before.revision + 1,
        mutation: { type: 'reorder_options', propertyId: status.id, optionIds: originalIds },
      },
    ]);
    await page.keyboard.press('Escape');
    await (await actions('Status')).getByRole('button', { name: 'Rename Status', exact: true }).click();
    const editProperty = page.getByRole('dialog', { name: 'Edit property', exact: true });
    await expect(editProperty.getByRole('textbox', { name: 'Label', exact: true })).toHaveValue('Status');
    await expect(editProperty.getByRole('combobox')).toHaveCount(0);
    await expect(page.getByText(/Archiving preserves saved values/)).toHaveCount(0);
    await saveLabel('Status manager review');
    let current = await readSchema();
    expect(current.definitions.find((d: { id: string }) => d.id === status.id)).toMatchObject({
      label: 'Status manager review',
      type: 'select',
    });
    await page.getByRole('button', { name: 'Manage Status manager review', exact: true }).click();
    await manager('Status manager review')
      .getByRole('button', { name: `Rename option ${firstOption.label}`, exact: true })
      .click();
    await saveLabel('Ready manager review');
    current = await readSchema();
    expect(current.definitions.find((d: { id: string }) => d.id === status.id).options[0]).toMatchObject({
      id: firstOption.id,
      label: 'Ready manager review',
    });
    const during = await (await page.request.get(`/internal/notes/${noteId}/properties`)).json();
    expect(during.values).toEqual(valuesBefore.values);
    expect(during.revision).toBe(valuesBefore.revision);
    await page.getByRole('button', { name: 'Manage Status manager review', exact: true }).click();
    await manager('Status manager review')
      .getByRole('button', { name: 'Rename option Ready manager review', exact: true })
      .click();
    await saveLabel(firstOption.label);
    await (await actions('Status manager review'))
      .getByRole('button', { name: 'Rename Status manager review', exact: true })
      .click();
    await saveLabel(status.label);
    current = await readSchema();
    expect(current.definitions).toEqual(before.definitions);
    expect(current.schemaId).toBe(before.schemaId);
    expect(writes).toHaveLength(6);
    expect(writes.slice(2).map((w) => w.expectedRevision)).toEqual([
      before.revision + 2,
      before.revision + 3,
      before.revision + 4,
      before.revision + 5,
    ]);
    expect(writes.slice(2).map((w) => w.mutation.propertyId)).toEqual([status.id, status.id, status.id, status.id]);
    expect(writes.filter((w) => w.mutation.type === 'rename_option').map((w) => w.mutation.optionId)).toEqual([
      firstOption.id,
      firstOption.id,
    ]);
    const archive = async (label: string, expectedStatus: number) => {
      const menu = await actions(label);
      const response = page.waitForResponse(
        (r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname === patchPath
      );
      await menu.getByRole('button', { name: `Archive ${label}`, exact: true }).click();
      expect((await response).status()).toBe(expectedStatus);
    };
    // Seeded Status is referenced by template defaults: prove that independent guard first.
    await archive('Status', 409);
    await expect(page.getByRole('alert')).toContainText('referenced template defaults');
    expect(await readSchema()).toEqual(current);
    // Use an isolated Select, never change template defaults just to reach the BOARD guard.
    const guardLabel = 'Manager grouping guard';
    await page.getByRole('button', { name: 'Add property', exact: true }).click();
    await page.getByLabel('Type', { exact: true }).selectOption('select');
    await page.getByLabel('Options (comma-separated)', { exact: true }).fill('One, Two');
    await saveLabel(guardLabel);
    current = await readSchema();
    const guarded = current.definitions.find((d: { label: string }) => d.label === guardLabel);
    const boardBefore = (await (await page.request.get(`/internal/folders/${DEMO_FOLDER_ID}/board/config`)).json())
      .board;
    expect(
      (
        await page.request.put(`/internal/folders/${DEMO_FOLDER_ID}/board/config`, {
          data: {
            config: {
              ...DEMO_CONFIG,
              grouping: { type: 'select', schemaId: current.schemaId, propertyId: guarded.id },
            },
            expectedVersion: boardBefore.version,
            schemaId: current.schemaId,
            schemaRevision: current.revision,
          },
        })
      ).status()
    ).toBe(200);
    const enabled = (await (await page.request.get(`/internal/folders/${DEMO_FOLDER_ID}/board/config`)).json()).board;
    expect(enabled.config.enabled).toBe(true);
    expect(enabled.config.grouping).toMatchObject({ type: 'select', propertyId: guarded.id });
    await archive(guardLabel, 409);
    await expect(page.getByRole('alert')).toContainText('enabled board before archiving its grouping property');
    expect(await readSchema()).toEqual(current);
    const latestBoard = (await (await page.request.get(`/internal/folders/${DEMO_FOLDER_ID}/board/config`)).json())
      .board;
    const latestSchema = await readSchema();
    expect(
      (
        await page.request.put(`/internal/folders/${DEMO_FOLDER_ID}/board/config`, {
          data: {
            config: boardBefore.config,
            expectedVersion: latestBoard.version,
            schemaId: latestSchema.schemaId,
            schemaRevision: latestSchema.revision,
          },
        })
      ).status()
    ).toBe(200);
    await archive(guardLabel, 200); // Cleanup archives, never deletes, the isolated field.
    await expect(page.getByRole('button', { name: `Manage ${guardLabel}`, exact: true })).toHaveCount(0);
    const restored = await readSchema();
    expect(restored.definitions.filter((d: { id: string }) => d.id !== guarded.id)).toEqual(before.definitions);
    expect(restored.definitions.find((d: { id: string }) => d.id === guarded.id).archived).toBe(true);
    const valuesAfter = await (await page.request.get(`/internal/notes/${noteId}/properties`)).json();
    expect(valuesAfter.values).toEqual(valuesBefore.values);
    expect(valuesAfter.revision).toBe(valuesBefore.revision);
    expect((await (await page.request.get(`/internal/notes/${noteId}`)).json()).contentHash).toBe(
      bodyBefore.contentHash
    );
    // Existing afterEach still restores initial config using CURRENT CAS/schema tokens.
  });
});
