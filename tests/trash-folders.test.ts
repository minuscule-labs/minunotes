import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
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

async function setupTrashFoldersApp() {
  vi.resetModules();
  const dir = await mkdtemp(path.join(tmpdir(), 'notes-trash-folders-'));
  tempDirs.push(dir);
  vi.stubEnv('TURSO_DB_URL', `file:${path.join(dir, 'test.db')}`);
  vi.stubEnv('FRONTEND_URL', 'https://notes.example.test');
  vi.stubEnv('ATTACHMENT_STORAGE_DRIVER', 'filesystem');
  vi.stubEnv('ATTACHMENT_STORAGE_PATH', path.join(dir, 'attachments'));

  const [{ db, libsql }, schema, { folderRoutes }, { noteRoutes }, { shareRoutes }, { trashRoutes }, storage] =
    await Promise.all([
      import('../src/api/db/client'),
      import('../src/api/db/schema'),
      import('../src/api/routes/folders'),
      import('../src/api/routes/notes'),
      import('../src/api/routes/share'),
      import('../src/api/routes/trash'),
      import('../src/api/storage'),
    ]);
  await runMigrations(libsql);

  const users = [
    {
      id: 'user_a',
      name: 'User A',
      email: 'a@example.com',
      emailVerified: true,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'user_b',
      name: 'User B',
      email: 'b@example.com',
      emailVerified: true,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];
  await db.insert(schema.user).values(users);

  const app = new Hono();
  app.use('/api/*', async (c, next) => {
    c.set('user', c.req.header('x-user') === 'b' ? users[1] : users[0]);
    c.set('session', null);
    await next();
  });
  app.route('/api/folders', folderRoutes);
  app.route('/api/notes', noteRoutes);
  app.route('/api/share', shareRoutes);
  app.route('/api/trash', trashRoutes);

  return { app, db, schema, storage, users };
}

async function createFolder(app: Hono, title: string, parentFolderId?: string) {
  const response = await app.request('/api/folders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, parentFolderId }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { folder: { id: string; parentFolderId: string | null } }).folder;
}

async function createNote(app: Hono, folderId: string, title: string) {
  const response = await app.request(`/api/folders/${folderId}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, content: `# ${title}` }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { note: { id: string; folderId: string } }).note;
}

function tokenFromUrl(url: string) {
  const token = new URL(url).pathname.split('/').pop();
  if (!token) throw new Error('Missing share token');
  return token;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('folder Trash lifecycle', () => {
  it('moves an active folder subtree and its notes to one Trash batch', async () => {
    const { app, db, schema } = await setupTrashFoldersApp();
    const root = await createFolder(app, 'Root');
    const child = await createFolder(app, 'Child', root.id);
    const rootNote = await createNote(app, root.id, 'Root note');
    const childNote = await createNote(app, child.id, 'Child note');

    const folderShare = await app.request(`/api/folders/${root.id}/share-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const folderToken = tokenFromUrl(((await folderShare.json()) as { shareLink: { url: string } }).shareLink.url);
    const noteShare = await app.request(`/api/notes/${childNote.id}/share-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const noteToken = tokenFromUrl(((await noteShare.json()) as { shareLink: { url: string } }).shareLink.url);

    expect(
      (await app.request(`/api/folders/${root.id}`, { method: 'DELETE', headers: { 'x-user': 'b' } })).status
    ).toBe(404);
    const remove = await app.request(`/api/folders/${root.id}`, { method: 'DELETE' });
    expect(remove.status).toBe(200);
    expect(await remove.json()).toMatchObject({ ok: true, folderCount: 2, noteCount: 2 });
    expect((await app.request(`/api/folders/${root.id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await app.request(`/api/share/folders/${folderToken}`)).status).toBe(404);
    expect((await app.request(`/api/share/${noteToken}`)).status).toBe(404);

    const folders = (await (await app.request('/api/folders')).json()) as { folders: unknown[] };
    const trash = (await (await app.request('/api/trash')).json()) as {
      folders: Array<{ id: string; descendantFolderCount: number; noteCount: number }>;
    };
    expect(folders.folders).toEqual([]);
    expect(trash.folders).toEqual([expect.objectContaining({ id: root.id, descendantFolderCount: 1, noteCount: 2 })]);

    expect(
      (
        await app.request(`/api/trash/folders/${root.id}/contents`, {
          headers: { 'x-user': 'b' },
        })
      ).status
    ).toBe(404);
    const contentsResponse = await app.request(`/api/trash/folders/${root.id}/contents`);
    expect(contentsResponse.status).toBe(200);
    const contents = (await contentsResponse.json()) as {
      rootFolderId: string;
      folders: Array<{ id: string; parentFolderId: string | null }>;
      notes: Array<{ id: string; folderId: string; content?: string }>;
    };
    expect(contents.rootFolderId).toBe(root.id);
    expect(contents.folders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: root.id }),
        expect.objectContaining({ id: child.id, parentFolderId: root.id }),
      ])
    );
    expect(contents.notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: rootNote.id, folderId: root.id }),
        expect.objectContaining({ id: childNote.id, folderId: child.id }),
      ])
    );
    expect(contents.notes.every((note) => note.content === undefined)).toBe(true);

    const storedFolders = await db.select().from(schema.folders);
    const storedNotes = await db.select().from(schema.notes);
    expect(storedFolders.map((folder) => folder.trashBatchId)).toEqual([root.id, root.id]);
    expect(storedNotes.map((note) => note.trashBatchId)).toEqual([root.id, root.id]);
    expect(storedNotes.map((note) => note.id)).toEqual(expect.arrayContaining([rootNote.id, childNote.id]));
    const events = await db.select().from(schema.noteEvents);
    expect(events.filter((event) => event.eventType === 'trash')).toHaveLength(2);
  });

  it('restores the original hierarchy and keeps shares revoked', async () => {
    const { app, db, schema } = await setupTrashFoldersApp();
    const parent = await createFolder(app, 'Parent');
    const root = await createFolder(app, 'Root', parent.id);
    const child = await createFolder(app, 'Child', root.id);
    const note = await createNote(app, child.id, 'Nested note');
    const share = await app.request(`/api/notes/${note.id}/share-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const token = tokenFromUrl(((await share.json()) as { shareLink: { url: string } }).shareLink.url);
    expect((await app.request(`/api/folders/${root.id}`, { method: 'DELETE' })).status).toBe(200);

    const restore = await app.request(`/api/trash/folders/${root.id}/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(restore.status).toBe(200);
    expect(await restore.json()).toMatchObject({
      folder: { id: root.id, parentFolderId: parent.id },
      restoredAtTopLevel: false,
      noteCount: 1,
    });
    expect((await app.request(`/api/notes/${note.id}`)).status).toBe(200);
    expect((await app.request(`/api/share/${token}`)).status).toBe(404);

    const [storedChild] = await db.select().from(schema.folders).where(eq(schema.folders.id, child.id));
    const [storedNote] = await db.select().from(schema.notes).where(eq(schema.notes.id, note.id));
    expect(storedChild).toMatchObject({ parentFolderId: root.id, deletedAt: null, trashBatchId: null });
    expect(storedNote).toMatchObject({ folderId: child.id, deletedAt: null, trashBatchId: null });
    const events = await db.select().from(schema.noteEvents).where(eq(schema.noteEvents.noteId, note.id));
    expect(events.map((event) => event.eventType)).toContain('restore_from_trash');
  });

  it('restores a subtree at the top level when its original parent is unavailable', async () => {
    const { app, db, schema } = await setupTrashFoldersApp();
    const parent = await createFolder(app, 'Parent');
    const root = await createFolder(app, 'Root', parent.id);
    await createFolder(app, 'Child', root.id);
    expect((await app.request(`/api/folders/${root.id}`, { method: 'DELETE' })).status).toBe(200);
    await db
      .update(schema.folders)
      .set({ deletedAt: new Date(), trashBatchId: parent.id })
      .where(eq(schema.folders.id, parent.id));

    const restore = await app.request(`/api/trash/folders/${root.id}/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(restore.status).toBe(200);
    expect(await restore.json()).toMatchObject({
      folder: { id: root.id, parentFolderId: null },
      restoredAtTopLevel: true,
    });
  });

  it('preserves separately trashed child subtrees during permanent parent purge', async () => {
    const { app, db, schema, storage, users } = await setupTrashFoldersApp();
    const outside = await createFolder(app, 'Outside');
    const parent = await createFolder(app, 'Parent');
    const child = await createFolder(app, 'Child', parent.id);
    const parentNote = await createNote(app, parent.id, 'Parent note');
    const childNote = await createNote(app, child.id, 'Child note');
    const movedNote = await createNote(app, parent.id, 'Moved note');
    expect(
      (
        await app.request(`/api/notes/${movedNote.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ folderId: outside.id }),
        })
      ).status
    ).toBe(200);
    expect(
      (
        await app.request(`/api/folders/${parent.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ isPrivate: true, isAgentReadOnly: true }),
        })
      ).status
    ).toBe(200);
    expect((await app.request(`/api/folders/${child.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await app.request(`/api/folders/${parent.id}`, { method: 'DELETE' })).status).toBe(200);

    const storageKey = `users/${users[0].id}/notes/${parentNote.id}/attachments/att_parent-image.png`;
    await storage.getObjectStorage().putObject({
      key: storageKey,
      body: new Uint8Array([1, 2, 3]),
      contentType: 'image/png',
    });
    const movedStorageKey = `users/${users[0].id}/notes/${movedNote.id}/attachments/att_moved-image.png`;
    await storage.getObjectStorage().putObject({
      key: movedStorageKey,
      body: new Uint8Array([4, 5, 6]),
      contentType: 'image/png',
    });
    await db.insert(schema.attachments).values([
      {
        id: 'att_parent',
        userId: users[0].id,
        noteId: parentNote.id,
        folderId: parent.id,
        provider: 'filesystem',
        filename: 'image.png',
        mimeType: 'image/png',
        size: 3,
        contentHash: 'hash',
        storageKey,
        status: 'ready',
      },
      {
        id: 'att_moved',
        userId: users[0].id,
        noteId: movedNote.id,
        folderId: parent.id,
        provider: 'filesystem',
        filename: 'moved.png',
        mimeType: 'image/png',
        size: 3,
        contentHash: 'hash',
        storageKey: movedStorageKey,
        status: 'ready',
      },
    ]);

    const purge = await app.request(`/api/trash/folders/${parent.id}`, { method: 'DELETE' });
    expect(purge.status).toBe(200);
    expect(await purge.json()).toEqual({
      ok: true,
      deletedFolderCount: 1,
      deletedNoteCount: 1,
      deletedAttachmentCount: 1,
    });
    await expect(storage.getObjectStorage().getObject({ key: storageKey })).resolves.toBeNull();
    await expect(storage.getObjectStorage().getObject({ key: movedStorageKey })).resolves.not.toBeNull();

    const [storedChild] = await db.select().from(schema.folders).where(eq(schema.folders.id, child.id));
    const [storedChildNote] = await db.select().from(schema.notes).where(eq(schema.notes.id, childNote.id));
    const [storedMovedNote] = await db.select().from(schema.notes).where(eq(schema.notes.id, movedNote.id));
    const movedVersions = await db
      .select()
      .from(schema.noteVersions)
      .where(eq(schema.noteVersions.noteId, movedNote.id));
    const [movedAttachment] = await db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.noteId, movedNote.id));
    expect(storedChild).toMatchObject({
      parentFolderId: null,
      deletedAt: expect.any(Date),
      trashBatchId: child.id,
      isPrivate: true,
      isAgentReadOnly: true,
    });
    expect(storedChildNote).toMatchObject({ folderId: child.id, deletedAt: expect.any(Date), trashBatchId: child.id });
    expect(storedMovedNote).toMatchObject({ folderId: outside.id, deletedAt: null });
    expect(movedVersions.length).toBeGreaterThan(0);
    expect(movedVersions.every((version) => version.folderId === outside.id)).toBe(true);
    expect(movedAttachment.folderId).toBe(outside.id);
    expect(await db.select().from(schema.folders).where(eq(schema.folders.id, parent.id))).toEqual([]);
    expect(await db.select().from(schema.notes).where(eq(schema.notes.id, parentNote.id))).toEqual([]);
  });

  it('releases a purge claim when attachment deletion fails', async () => {
    const { app, db, schema, users } = await setupTrashFoldersApp();
    const folder = await createFolder(app, 'Folder');
    const note = await createNote(app, folder.id, 'Attachment note');
    await db.insert(schema.attachments).values({
      id: 'att_invalid',
      userId: users[0].id,
      noteId: note.id,
      folderId: folder.id,
      provider: 'filesystem',
      filename: 'invalid.png',
      mimeType: 'image/png',
      size: 1,
      contentHash: 'hash',
      storageKey: '../outside.png',
      status: 'ready',
    });
    expect((await app.request(`/api/folders/${folder.id}`, { method: 'DELETE' })).status).toBe(200);

    expect((await app.request(`/api/trash/folders/${folder.id}`, { method: 'DELETE' })).status).toBe(500);
    const [storedFolder] = await db.select().from(schema.folders).where(eq(schema.folders.id, folder.id));
    const [storedNote] = await db.select().from(schema.notes).where(eq(schema.notes.id, note.id));
    expect(storedFolder.trashBatchId).toBe(folder.id);
    expect(storedNote.trashBatchId).toBe(folder.id);
    const trash = (await (await app.request('/api/trash')).json()) as { folders: Array<{ id: string }> };
    expect(trash.folders.map((item) => item.id)).toEqual([folder.id]);
  });

  it('blocks parent purge until separately trashed notes inside it are handled', async () => {
    const { app } = await setupTrashFoldersApp();
    const folder = await createFolder(app, 'Folder');
    const standalone = await createNote(app, folder.id, 'Standalone trash');
    const batched = await createNote(app, folder.id, 'Folder trash');
    expect((await app.request(`/api/notes/${standalone.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await app.request(`/api/folders/${folder.id}`, { method: 'DELETE' })).status).toBe(200);

    const blocked = await app.request(`/api/trash/folders/${folder.id}`, { method: 'DELETE' });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: expect.stringContaining('separately trashed notes') });

    expect((await app.request(`/api/trash/notes/${standalone.id}`, { method: 'DELETE' })).status).toBe(200);
    const purge = await app.request(`/api/trash/folders/${folder.id}`, { method: 'DELETE' });
    expect(purge.status).toBe(200);
    expect(await purge.json()).toMatchObject({ deletedFolderCount: 1, deletedNoteCount: 1 });
    expect((await app.request(`/api/notes/${batched.id}`)).status).toBe(404);
  });
});
