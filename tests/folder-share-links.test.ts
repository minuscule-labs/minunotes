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

async function setupFolderShareApp() {
  vi.resetModules();
  const dir = await mkdtemp(path.join(tmpdir(), 'notes-folder-share-links-'));
  tempDirs.push(dir);
  vi.stubEnv('TURSO_DB_URL', `file:${path.join(dir, 'test.db')}`);
  vi.stubEnv('FRONTEND_URL', 'https://notes.example.test');

  vi.stubEnv('ATTACHMENT_STORAGE_DRIVER', 'filesystem');
  vi.stubEnv('ATTACHMENT_STORAGE_PATH', path.join(dir, 'attachments'));

  const [{ db, libsql }, schema, { folderRoutes }, { shareRoutes }, storage] = await Promise.all([
    import('../src/api/db/client'),
    import('../src/api/db/schema'),
    import('../src/api/routes/folders'),
    import('../src/api/routes/share'),
    import('../src/api/storage'),
  ]);

  await runMigrations(libsql);

  const userA = {
    id: 'user_a',
    name: 'User A',
    email: 'a@example.com',
    emailVerified: true,
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const userB = {
    id: 'user_b',
    name: 'User B',
    email: 'b@example.com',
    emailVerified: true,
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const folderA = {
    id: 'folder_a',
    userId: userA.id,
    parentFolderId: null,
    title: 'A Folder',
    isPrivate: false,
    isAgentReadOnly: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const childFolder = {
    id: 'folder_child',
    userId: userA.id,
    parentFolderId: folderA.id,
    title: 'Child Folder',
    isPrivate: false,
    isAgentReadOnly: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const privateFolder = {
    id: 'folder_private',
    userId: userA.id,
    parentFolderId: null,
    title: 'Private Folder',
    isPrivate: true,
    isAgentReadOnly: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await db.insert(schema.user).values([userA, userB]);
  await db.insert(schema.folders).values([folderA, childFolder, privateFolder]);
  await db.insert(schema.notes).values([
    {
      id: 'note_a',
      folderId: folderA.id,
      userId: userA.id,
      title: 'A Note',
      content: '# Shared\n\nHello',
      type: 'note',
      documentType: 'markdown',
      isApiEditable: true,
      updatedByActorType: null,
      updatedByActorId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'note_template',
      folderId: folderA.id,
      userId: userA.id,
      title: 'Template',
      content: 'hidden template',
      type: 'template',
      documentType: 'markdown',
      isApiEditable: true,
      updatedByActorType: null,
      updatedByActorId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'note_child',
      folderId: childFolder.id,
      userId: userA.id,
      title: 'Child Note',
      content: 'hidden child',
      type: 'note',
      documentType: 'markdown',
      isApiEditable: true,
      updatedByActorType: null,
      updatedByActorId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);

  const app = new Hono();
  app.use('/api/folders/*', async (c, next) => {
    const currentUser = c.req.header('x-user') === 'b' ? userB : userA;
    c.set('user', currentUser);
    c.set('session', { id: `session_${currentUser.id}`, userId: currentUser.id });
    await next();
  });
  app.route('/api/folders', folderRoutes);
  app.route('/api/share', shareRoutes);

  return { app, db, schema, storage };
}

function tokenFromUrl(url: string) {
  const token = new URL(url).pathname.split('/').pop();
  if (!token) throw new Error('Missing share token in URL');
  return token;
}

afterEach(async () => {
  const storage = await import('../src/api/storage');
  storage.resetObjectStorageForTests();
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('folder share links', () => {
  it('creates a share link and resolves descendant notes publicly', async () => {
    const { app } = await setupFolderShareApp();

    const create = await app.request('/api/folders/folder_a/share-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(create.status).toBe(201);
    const { shareLink } = (await create.json()) as { shareLink: { id: string; url: string } };
    expect(shareLink.url).toMatch(/^https:\/\/notes\.example\.test\/share\/folders\//);

    const publicRead = await app.request(`/api/share/folders/${tokenFromUrl(shareLink.url)}`);
    expect(publicRead.status).toBe(200);
    const body = (await publicRead.json()) as {
      folder: { title: string };
      folders: Array<{ title: string; parentFolderId: string | null }>;
      notes: Array<{ title: string; content: string }>;
      share: { id: string; permission: string };
    };
    expect(body.folder.title).toBe('A Folder');
    expect(body.folders).toEqual([expect.objectContaining({ title: 'Child Folder', parentFolderId: 'folder_a' })]);
    expect(body.notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'A Note', content: '# Shared\n\nHello' }),
        expect.objectContaining({ title: 'Child Note', content: 'hidden child' }),
      ])
    );
    expect(body.notes.map((note) => note.title)).not.toContain('Template');
    expect(body.share.id).toBe(shareLink.id);
    expect(body.share.permission).toBe('read');
  });

  it('keeps canvas links inside the shared subtree and strips outside targets', async () => {
    const { app, db, schema } = await setupFolderShareApp();
    await db.insert(schema.notes).values([
      {
        id: 'note_outside',
        folderId: 'folder_private',
        userId: 'user_a',
        title: 'Outside',
        content: '',
        documentType: 'markdown',
        type: 'note',
        isApiEditable: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'note_canvas',
        folderId: 'folder_a',
        userId: 'user_a',
        title: 'Canvas',
        content: JSON.stringify({
          nodes: [
            {
              id: 'inside',
              type: 'text',
              text: 'Inside',
              minunotes: { link: { type: 'note', id: 'note_child' } },
            },
            {
              id: 'outside',
              type: 'text',
              text: 'Outside',
              minunotes: { link: { type: 'note', id: 'note_outside' } },
            },
          ],
          edges: [],
        }),
        documentType: 'canvas.default',
        type: 'note',
        isApiEditable: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const create = await app.request('/api/folders/folder_a/share-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const token = tokenFromUrl(((await create.json()) as { shareLink: { url: string } }).shareLink.url);
    const body = (await (await app.request(`/api/share/folders/${token}`)).json()) as {
      notes: Array<{ id: string; content: string }>;
    };
    const canvas = JSON.parse(body.notes.find((note) => note.id === 'note_canvas')?.content ?? '{}') as {
      nodes: Array<{ id: string; minunotes?: { link?: { id: string } } }>;
    };
    expect(canvas.nodes.find((node) => node.id === 'inside')?.minunotes?.link?.id).toBe('note_child');
    expect(canvas.nodes.find((node) => node.id === 'outside')?.minunotes?.link).toBeUndefined();
  });

  it('serves attachments only through their owning note in the shared subtree', async () => {
    const { app, db, schema, storage } = await setupFolderShareApp();
    await storage.getObjectStorage().putObject({
      key: 'users/user_a/notes/note_child/attachments/att_child-image.png',
      body: new TextEncoder().encode('child-image'),
      contentType: 'image/png',
    });
    await db.insert(schema.attachments).values({
      id: 'att_child',
      userId: 'user_a',
      noteId: 'note_child',
      folderId: 'folder_child',
      provider: 'filesystem',
      filename: 'child.png',
      mimeType: 'image/png',
      size: 11,
      contentHash: 'child',
      storageKey: 'users/user_a/notes/note_child/attachments/att_child-image.png',
      status: 'ready',
    });

    const create = await app.request('/api/folders/folder_a/share-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const token = tokenFromUrl(((await create.json()) as { shareLink: { url: string } }).shareLink.url);

    const content = await app.request(`/api/share/folders/${token}/notes/note_child/attachments/att_child/content`);
    expect(content.status).toBe(200);
    expect(await content.text()).toBe('child-image');
    expect(content.headers.get('cache-control')).toBe('no-store');

    expect((await app.request(`/api/share/folders/${token}/notes/note_a/attachments/att_child/content`)).status).toBe(
      404
    );
    expect(
      (await app.request(`/api/share/folders/${token}/notes/note_outside/attachments/att_child/content`)).status
    ).toBe(404);

    await app.request('/api/folders/folder_a/share-link', { method: 'DELETE' });
    expect(
      (await app.request(`/api/share/folders/${token}/notes/note_child/attachments/att_child/content`)).status
    ).toBe(404);
  });

  it('resolves only authored links for a selected note inside the shared subtree', async () => {
    const { app, db, schema } = await setupFolderShareApp();
    await db
      .update(schema.notes)
      .set({ content: '[[Child Note]] [[Outside Target]] [[Missing]]' })
      .where(eq(schema.notes.id, 'note_a'));
    await db.insert(schema.notes).values({
      id: 'note_outside',
      folderId: 'folder_private',
      userId: 'user_a',
      title: 'Outside Target',
      content: '',
      documentType: 'markdown',
      type: 'note',
      isApiEditable: true,
      updatedByActorType: null,
      updatedByActorId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(schema.noteShareLinks).values({
      id: 'share_outside',
      userId: 'user_a',
      noteId: 'note_outside',
      tokenHash: 'outside_hash',
      token: 'outside-token',
      permission: 'read',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const create = await app.request('/api/folders/folder_a/share-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const { shareLink } = (await create.json()) as { shareLink: { url: string } };
    const token = tokenFromUrl(shareLink.url);

    const response = await app.request(`/api/share/folders/${token}/notes/note_a/wikilinks`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      resolutions: [
        { target: 'Child Note', href: `/share/folders/${token}?note=note_child` },
        { target: 'Outside Target', href: '/share/outside-token' },
        { target: 'Missing', href: null },
      ],
    });

    expect((await app.request(`/api/share/folders/${token}/notes/note_outside/wikilinks`)).status).toBe(404);
    await app.request('/api/folders/folder_a/share-link', { method: 'DELETE' });
    expect((await app.request(`/api/share/folders/${token}/notes/note_a/wikilinks`)).status).toBe(404);
  });

  it('returns existing active share metadata on repeated create', async () => {
    const { app } = await setupFolderShareApp();

    const first = await app.request('/api/folders/folder_a/share-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const { shareLink: firstShare } = (await first.json()) as { shareLink: { id: string; url: string } };

    const second = await app.request('/api/folders/folder_a/share-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(second.status).toBe(200);
    const { shareLink: secondShare } = (await second.json()) as { shareLink: { id: string; url: string | null } };
    expect(secondShare.id).toBe(firstShare.id);
    expect(secondShare.url).toBe(firstShare.url);
  });

  it('regenerates and revokes folder share links', async () => {
    const { app } = await setupFolderShareApp();

    const first = await app.request('/api/folders/folder_a/share-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const { shareLink: firstShare } = (await first.json()) as { shareLink: { url: string } };

    const regenerate = await app.request('/api/folders/folder_a/share-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ regenerate: true }),
    });
    expect(regenerate.status).toBe(201);
    const { shareLink: secondShare } = (await regenerate.json()) as { shareLink: { url: string } };
    expect(secondShare.url).not.toBe(firstShare.url);
    expect((await app.request(`/api/share/folders/${tokenFromUrl(firstShare.url)}`)).status).toBe(404);
    expect((await app.request(`/api/share/folders/${tokenFromUrl(secondShare.url)}`)).status).toBe(200);

    const revoke = await app.request('/api/folders/folder_a/share-link', { method: 'DELETE' });
    expect(revoke.status).toBe(200);
    expect((await app.request(`/api/share/folders/${tokenFromUrl(secondShare.url)}`)).status).toBe(404);
  });

  it('allows owners to explicitly share private folders', async () => {
    const { app } = await setupFolderShareApp();

    const create = await app.request('/api/folders/folder_private/share-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(create.status).toBe(201);
    const { shareLink } = (await create.json()) as { shareLink: { url: string } };

    const publicRead = await app.request(`/api/share/folders/${tokenFromUrl(shareLink.url)}`);
    expect(publicRead.status).toBe(200);
    const body = (await publicRead.json()) as { folder: { title: string }; notes: unknown[] };
    expect(body.folder.title).toBe('Private Folder');
    expect(body.notes).toEqual([]);
  });

  it('does not allow another user to manage a folder share link', async () => {
    const { app } = await setupFolderShareApp();

    const create = await app.request('/api/folders/folder_a/share-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user': 'b' },
      body: JSON.stringify({}),
    });
    expect(create.status).toBe(404);

    const revoke = await app.request('/api/folders/folder_a/share-link', {
      method: 'DELETE',
      headers: { 'x-user': 'b' },
    });
    expect(revoke.status).toBe(404);
  });
});
