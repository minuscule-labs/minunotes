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

async function setupObjectAccessApp() {
  vi.resetModules();
  const dir = await mkdtemp(path.join(tmpdir(), 'notes-auth-object-access-'));
  tempDirs.push(dir);
  vi.stubEnv('TURSO_DB_URL', `file:${path.join(dir, 'test.db')}`);

  const [{ db, libsql }, schema, { noteRoutes }, { harnessRoutes }, { attachmentRoutes }] = await Promise.all([
    import('../src/api/db/client'),
    import('../src/api/db/schema'),
    import('../src/api/routes/notes'),
    import('../src/api/routes/harness'),
    import('../src/api/routes/attachments'),
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
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const folderB = {
    id: 'folder_b',
    userId: userB.id,
    parentFolderId: null,
    title: 'B Folder',
    isPrivate: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const noteA = {
    id: 'note_a',
    folderId: folderA.id,
    userId: userA.id,
    title: 'A Note',
    content: 'A content',
    type: 'note' as const,
    isApiEditable: true,
    updatedByActorType: null,
    updatedByActorId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const noteB = {
    id: 'note_b',
    folderId: folderB.id,
    userId: userB.id,
    title: 'B Note',
    content: 'B content',
    type: 'note' as const,
    isApiEditable: true,
    updatedByActorType: null,
    updatedByActorId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const authorizationA = {
    id: 'agent_key_a',
    userId: userA.id,
    canCreateFolders: true,
    canRead: true,
    canCreate: true,
    canEdit: true,
    accessMode: 'all' as const,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastUsedAt: null,
    revokedAt: null,
  };
  const apiKeyA = {
    ...authorizationA,
    authorizationId: authorizationA.id,
    name: 'A key',
    uid: 'AAAAAAAA',
    hash: 'hash',
    salt: 'salt',
  };
  const attachmentB = {
    id: 'att_b',
    userId: userB.id,
    noteId: noteB.id,
    folderId: folderB.id,
    provider: 'filesystem',
    filename: 'b.png',
    mimeType: 'image/png',
    size: 10,
    contentHash: 'hash',
    storageKey: 'users/user_b/notes/note_b/attachments/att_b-b.png',
    status: 'ready',
    referencedAt: null,
    unreferencedAt: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await db.insert(schema.user).values([userA, userB]);
  await db.insert(schema.folders).values([folderA, folderB]);
  await db.insert(schema.notes).values([noteA, noteB]);
  await db.insert(schema.integrationAuthorizations).values(authorizationA);
  await db.insert(schema.apiKeys).values(apiKeyA);
  await db.insert(schema.attachments).values(attachmentB);

  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', userA);
    c.set('session', { id: 'session_a', userId: userA.id });
    c.set('apiKey', c.req.path.startsWith('/api/harness') ? apiKeyA : null);
    await next();
  });
  app.route('/api/notes', noteRoutes);
  app.route('/api/harness', harnessRoutes);
  app.route('/api/attachments', attachmentRoutes);

  return { app };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.doUnmock('../src/api/lib/auth');
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('object-level authorization', () => {
  it("does not allow a signed-in user to read or update another user's note by id", async () => {
    const { app } = await setupObjectAccessApp();

    const read = await app.request('/api/notes/note_b');
    expect(read.status).toBe(404);

    const update = await app.request('/api/notes/note_b', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Stolen' }),
    });
    expect(update.status).toBe(404);
  });

  it("does not allow an API key to read or edit another user's note by id", async () => {
    const { app } = await setupObjectAccessApp();

    const read = await app.request('/api/harness/notes/note_b');
    expect(read.status).toBe(404);

    const edit = await app.request('/api/harness/notes/note_b/edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ edits: [{ type: 'append', text: 'stolen' }] }),
    });
    expect(edit.status).toBe(404);
  });

  it("does not allow a signed-in user to read another user's attachment by id", async () => {
    const { app } = await setupObjectAccessApp();

    const response = await app.request('/api/attachments/att_b/content');
    expect(response.status).toBe(404);
  });
});

describe('harness authentication', () => {
  it('rejects an invalid API key instead of falling back to session auth', async () => {
    vi.resetModules();
    vi.doMock('../src/api/lib/auth', () => ({
      auth: {
        $Infer: {},
        api: {
          getSession: async () => ({
            user: { id: 'user_session', name: 'Session User', email: 'session@example.com' },
            session: { id: 'session', userId: 'user_session' },
          }),
        },
      },
    }));

    const { harnessAuthenticationMiddleware } = await import('../src/api/middleware/authentication');
    const app = new Hono();
    app.use('*', harnessAuthenticationMiddleware);
    app.get('/protected', (c) => c.json({ user: c.get('user') }));

    const response = await app.request('/protected', { headers: { 'x-api-key': 'not-a-valid-key' } });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid API key' });
  });
});
