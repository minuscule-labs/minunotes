import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tempDirs: string[] = [];

async function runMigrations(libsql: { executeMultiple: (sql: string) => Promise<unknown> }) {
  for (let index = 0; index <= 40; index += 1) {
    const [file] = await Array.fromAsync(
      (await import('node:fs/promises')).glob(`drizzle/${String(index).padStart(4, '0')}_*.sql`)
    );
    if (!file) throw new Error(`Missing migration ${index}`);
    await libsql.executeMultiple(await readFile(file, 'utf8'));
  }
}

async function setupApp() {
  vi.resetModules();
  const dir = await mkdtemp(path.join(tmpdir(), 'notes-tags-'));
  tempDirs.push(dir);
  vi.stubEnv('TURSO_DB_URL', `file:${path.join(dir, 'test.db')}`);

  const [{ db, libsql }, schema, { folderRoutes }, { noteRoutes }, { harnessRoutes }] = await Promise.all([
    import('../src/api/db/client'),
    import('../src/api/db/schema'),
    import('../src/api/routes/folders'),
    import('../src/api/routes/notes'),
    import('../src/api/routes/harness'),
  ]);

  await runMigrations(libsql);

  const user = {
    id: 'user_a',
    name: 'User A',
    email: 'a@example.com',
    emailVerified: true,
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const folder = {
    id: 'folder_a',
    userId: user.id,
    parentFolderId: null,
    title: 'A Folder',
    isPrivate: false,
    isAgentReadOnly: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await db.insert(schema.user).values(user);
  await db.insert(schema.folders).values(folder);

  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', user);
    c.set('session', { id: 'session_user_a', userId: user.id });
    c.set('apiKey', null);
    await next();
  });
  app.route('/api/folders', folderRoutes);
  app.route('/api/notes', noteRoutes);
  app.route('/api/harness', harnessRoutes);

  return { app, folder };
}

async function createNote(app: Hono, folderId: string, title: string) {
  const response = await app.request(`/api/folders/${folderId}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, content: '' }),
  });
  expect(response.status).toBe(201);
  const { note } = (await response.json()) as { note: { id: string; title: string } };
  return note;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('note tags', () => {
  it('sets, normalizes, lists, and replaces note tags', async () => {
    const { app, folder } = await setupApp();
    const note = await createNote(app, folder.id, 'Tagged Note');

    const update = await app.request(`/api/notes/${note.id}/tags`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tags: [' Product ', '#OAuth', 'product', ''] }),
    });
    expect(update.status).toBe(200);
    await expect(update.json()).resolves.toMatchObject({ tags: [{ name: 'oauth' }, { name: 'product' }] });

    const list = await app.request(`/api/notes/${note.id}/tags`);
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({ tags: [{ name: 'oauth' }, { name: 'product' }] });

    const all = await app.request('/api/notes/tags');
    expect(all.status).toBe(200);
    await expect(all.json()).resolves.toMatchObject({
      tags: expect.arrayContaining([expect.objectContaining({ name: 'oauth', noteCount: 1 })]),
    });

    const replace = await app.request(`/api/notes/${note.id}/tags`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tags: ['Research'] }),
    });
    expect(replace.status).toBe(200);
    await expect(replace.json()).resolves.toMatchObject({ tags: [{ name: 'research' }] });

    const afterReplace = await app.request('/api/notes/tags');
    expect(afterReplace.status).toBe(200);
    const afterReplaceBody = (await afterReplace.json()) as { tags: Array<{ name: string }> };
    expect(afterReplaceBody.tags.map((tag) => tag.name)).toEqual(['research']);

    const removeAll = await app.request(`/api/notes/${note.id}/tags`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tags: [] }),
    });
    expect(removeAll.status).toBe(200);
    await expect(removeAll.json()).resolves.toMatchObject({ tags: [] });

    const afterRemoveAll = await app.request('/api/notes/tags');
    expect(afterRemoveAll.status).toBe(200);
    await expect(afterRemoveAll.json()).resolves.toMatchObject({ tags: [] });
  });

  it('exposes tags through the harness API', async () => {
    const { app, folder } = await setupApp();
    const note = await createNote(app, folder.id, 'Harness Tagged Note');

    const update = await app.request(`/api/harness/notes/${note.id}/tags`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tags: ['Agent'] }),
    });
    expect(update.status).toBe(200);

    const list = await app.request(`/api/harness/notes/${note.id}/tags`);
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({ tags: [{ name: 'agent' }] });
  });
});
