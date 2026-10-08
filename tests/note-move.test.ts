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

async function setupApp() {
  vi.resetModules();
  const dir = await mkdtemp(path.join(tmpdir(), 'notes-move-'));
  tempDirs.push(dir);
  vi.stubEnv('TURSO_DB_URL', `file:${path.join(dir, 'test.db')}`);

  const [{ db, libsql }, schema, { noteRoutes }] = await Promise.all([
    import('../src/api/db/client'),
    import('../src/api/db/schema'),
    import('../src/api/routes/notes'),
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
  const source = {
    id: 'folder_source',
    userId: user.id,
    parentFolderId: null,
    title: 'Source',
    isPrivate: false,
    isAgentReadOnly: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const target = { ...source, id: 'folder_target', title: 'Target' };
  const note = {
    id: 'note_move',
    userId: user.id,
    folderId: source.id,
    title: 'Move me',
    content: 'content',
    documentType: 'markdown' as const,
    type: 'note' as const,
    isApiEditable: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await db.insert(schema.user).values(user);
  await db.insert(schema.folders).values([source, target]);
  await db.insert(schema.notes).values(note);

  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', user);
    c.set('session', { id: 'session_user_a', userId: user.id });
    c.set('apiKey', null);
    await next();
  });
  app.route('/api/notes', noteRoutes);

  return { app, db, schema };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('note moves', () => {
  it('moves notes in bulk for signed-in users', async () => {
    const { app, db, schema } = await setupApp();

    const response = await app.request('/api/notes/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ noteIds: ['note_move'], targetFolderId: 'folder_target' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      notes: [{ note: expect.objectContaining({ id: 'note_move', folderId: 'folder_target' }) }],
    });

    const [row] = await db
      .select({ folderId: schema.notes.folderId })
      .from(schema.notes)
      .where(eq(schema.notes.id, 'note_move'));
    expect(row.folderId).toBe('folder_target');
  });

  it('rejects move batches over the note limit', async () => {
    const { app } = await setupApp();

    const response = await app.request('/api/notes/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        noteIds: Array.from({ length: 101 }, (_, index) => `note_${index}`),
        targetFolderId: 'folder_target',
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Cannot move more than 100 notes at once' });
  });
});
