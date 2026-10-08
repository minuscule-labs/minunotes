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

async function setupFolderApp() {
  vi.resetModules();
  const dir = await mkdtemp(path.join(tmpdir(), 'notes-folders-'));
  tempDirs.push(dir);
  vi.stubEnv('TURSO_DB_URL', `file:${path.join(dir, 'test.db')}`);

  const [{ db, libsql }, schema, { folderRoutes }] = await Promise.all([
    import('../src/api/db/client'),
    import('../src/api/db/schema'),
    import('../src/api/routes/folders'),
  ]);

  await runMigrations(libsql);

  const user = {
    id: 'user_test',
    name: 'Test User',
    email: 'test@example.com',
    emailVerified: true,
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await db.insert(schema.user).values(user);

  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', user);
    c.set('session', null);
    await next();
  });
  app.route('/api/folders', folderRoutes);

  return { app, db, libsql, schema, user };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createFolder(app: Hono, title: string, parentFolderId?: string | null) {
  const response = await app.request('/api/folders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, parentFolderId }),
  });
  expect(response.status).toBe(201);
  const { folder } = (await response.json()) as { folder: { id: string; parentFolderId: string | null } };
  return folder;
}

describe('folder hierarchy', () => {
  it('creates canvas notes as note-backed documents', async () => {
    const { app } = await setupFolderApp();
    const folder = await createFolder(app, 'Diagrams');

    const response = await app.request(`/api/folders/${folder.id}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ documentType: 'canvas.default' }),
    });
    expect(response.status).toBe(201);
    const { note } = (await response.json()) as { note: { title: string; documentType: string; content: string } };
    expect(note.title).toBe('Untitled canvas');
    expect(note.documentType).toBe('canvas.default');
    expect(JSON.parse(note.content)).toEqual({ nodes: [], edges: [] });
  });

  it('creates mind map notes with a root node', async () => {
    const { app } = await setupFolderApp();
    const folder = await createFolder(app, 'Mind maps');

    const response = await app.request(`/api/folders/${folder.id}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ documentType: 'canvas.mindmap' }),
    });
    expect(response.status).toBe(201);
    const { note } = (await response.json()) as { note: { title: string; documentType: string; content: string } };
    expect(note.title).toBe('Untitled mind map');
    expect(note.documentType).toBe('canvas.mindmap');
    const canvas = JSON.parse(note.content) as { nodes: Array<{ id: string; text: string }>; edges: unknown[] };
    expect(canvas.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'Root', text: 'Central topic', shape: 'text' })])
    );
    expect(canvas.edges).toEqual([]);
  });

  it('rejects canvas templates', async () => {
    const { app } = await setupFolderApp();
    const folder = await createFolder(app, 'Templates');

    const response = await app.request(`/api/folders/${folder.id}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'template', documentType: 'canvas.default' }),
    });
    expect(response.status).toBe(400);
  });

  it('creates folders up to depth 4 and rejects deeper folders', async () => {
    const { app } = await setupFolderApp();

    let parentFolderId: string | null = null;
    const folderIds: string[] = [];
    for (const title of ['Project', 'Area', 'Topic', 'Detail', 'Item']) {
      const response = await app.request('/api/folders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, parentFolderId }),
      });
      expect(response.status).toBe(201);
      const { folder } = (await response.json()) as { folder: { id: string; parentFolderId: string | null } };
      expect(folder.parentFolderId).toBe(parentFolderId);
      folderIds.push(folder.id);
      parentFolderId = folder.id;
    }

    const tooDeepResponse = await app.request('/api/folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Too deep', parentFolderId: folderIds.at(-1) }),
    });
    expect(tooDeepResponse.status).toBe(400);
  });

  it('excludes active folders beneath deleted ancestors from the active hierarchy', async () => {
    const { app, db, schema, user } = await setupFolderApp();
    const now = new Date();
    await db.insert(schema.folders).values([
      {
        id: 'folder_active_root',
        userId: user.id,
        parentFolderId: null,
        title: 'Active root',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'folder_active_child',
        userId: user.id,
        parentFolderId: 'folder_active_root',
        title: 'Active child',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'folder_deleted_root',
        userId: user.id,
        parentFolderId: null,
        title: 'Deleted root',
        deletedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'folder_orphaned_active_child',
        userId: user.id,
        parentFolderId: 'folder_deleted_root',
        title: 'Orphaned active child',
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const response = await app.request('/api/folders');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { folders: Array<{ id: string }> };
    expect(body.folders.map(({ id }) => id).sort()).toEqual(['folder_active_child', 'folder_active_root']);
  });

  it('keeps owner folder-detail access checks bounded as child folders grow', async () => {
    const { app, db, libsql, schema, user } = await setupFolderApp();
    const parent = await createFolder(app, 'Parent');
    const now = new Date();
    await db.insert(schema.folders).values(
      Array.from({ length: 30 }, (_, index) => ({
        id: `folder_child_${index}`,
        userId: user.id,
        createdByUserId: user.id,
        parentFolderId: parent.id,
        title: `Child ${index}`,
        createdAt: now,
        updatedAt: now,
      }))
    );

    const client = libsql as unknown as {
      execute: (...args: unknown[]) => Promise<unknown>;
    };
    const execute = client.execute.bind(client);
    let databaseCalls = 0;
    client.execute = async (...args: unknown[]) => {
      databaseCalls += 1;
      return execute(...args);
    };

    const response = await app.request(`/api/folders/${parent.id}/detail`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      folder: { canTrash: boolean };
      childFolders: Array<{ canTrash: boolean }>;
      sharedBy: { label: string } | null;
    };
    expect(body.sharedBy).toBeNull();
    expect(body.folder.canTrash).toBe(true);
    expect(body.childFolders).toHaveLength(30);
    expect(body.childFolders.every((folder) => folder.canTrash)).toBe(true);
    expect(databaseCalls).toBeLessThanOrEqual(5);
  });

  it('toggles private folders and moves folder subtrees to Trash', async () => {
    const { app } = await setupFolderApp();

    const parent = await createFolder(app, 'Parent');
    await createFolder(app, 'Child', parent.id);

    const privateResponse = await app.request(`/api/folders/${parent.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isPrivate: true }),
    });
    expect(privateResponse.status).toBe(200);
    const { folder } = (await privateResponse.json()) as { folder: { isPrivate: boolean } };
    expect(folder.isPrivate).toBe(true);

    const deleteResponse = await app.request(`/api/folders/${parent.id}`, { method: 'DELETE' });
    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toMatchObject({ ok: true, folderCount: 2, noteCount: 0 });
    const listResponse = await app.request('/api/folders');
    await expect(listResponse.json()).resolves.toEqual({ folders: [] });
  });

  it('moves folders to another parent and top level', async () => {
    const { app } = await setupFolderApp();

    const first = await createFolder(app, 'First');
    const second = await createFolder(app, 'Second');
    const child = await createFolder(app, 'Child', first.id);

    const moveUnderSecond = await app.request(`/api/folders/${child.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentFolderId: second.id }),
    });
    expect(moveUnderSecond.status).toBe(200);
    const { folder: moved } = (await moveUnderSecond.json()) as { folder: { parentFolderId: string | null } };
    expect(moved.parentFolderId).toBe(second.id);

    const moveTopLevel = await app.request(`/api/folders/${child.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentFolderId: null }),
    });
    expect(moveTopLevel.status).toBe(200);
    const { folder: topLevel } = (await moveTopLevel.json()) as { folder: { parentFolderId: string | null } };
    expect(topLevel.parentFolderId).toBeNull();
  });

  it('rejects moving folders into themselves or descendants', async () => {
    const { app } = await setupFolderApp();

    const parent = await createFolder(app, 'Parent');
    const child = await createFolder(app, 'Child', parent.id);

    const intoSelf = await app.request(`/api/folders/${parent.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentFolderId: parent.id }),
    });
    expect(intoSelf.status).toBe(400);

    const intoDescendant = await app.request(`/api/folders/${parent.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentFolderId: child.id }),
    });
    expect(intoDescendant.status).toBe(400);
  });

  it('rejects moves that exceed max depth or target private folders', async () => {
    const { app } = await setupFolderApp();

    let parentFolderId: string | null = null;
    for (const title of ['A', 'B', 'C', 'D']) {
      const folder = await createFolder(app, title, parentFolderId);
      parentFolderId = folder.id;
    }
    const deepParentId = parentFolderId;
    const subtreeRoot = await createFolder(app, 'Subtree');
    await createFolder(app, 'Subtree child', subtreeRoot.id);

    const tooDeep = await app.request(`/api/folders/${subtreeRoot.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentFolderId: deepParentId }),
    });
    expect(tooDeep.status).toBe(400);

    const privateParent = await createFolder(app, 'Private parent');
    const privateResponse = await app.request(`/api/folders/${privateParent.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isPrivate: true }),
    });
    expect(privateResponse.status).toBe(200);

    const intoPrivate = await app.request(`/api/folders/${subtreeRoot.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentFolderId: privateParent.id }),
    });
    expect(intoPrivate.status).toBe(403);
  });
});
