import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Client } from '@libsql/client';
import { Hono } from 'hono';
import { vi } from 'vitest';
import { DEFAULT_BOARD_CONFIG } from '../src/shared/board';

const resources: Array<{ dir: string; client: Client }> = [];
export async function runBoardMigrations(client: Client, from = 0, through = 41) {
  const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  for (const entry of journal.entries.filter((entry) => entry.idx >= from && entry.idx <= through))
    await client.executeMultiple(await readFile(`drizzle/${entry.tag}.sql`, 'utf8'));
  await client.execute('PRAGMA foreign_keys = ON');
}
export async function cleanupBoardTests() {
  for (const { client, dir } of resources.splice(0)) {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
}
export async function setupBoardTest(through = 41) {
  vi.resetModules();
  const dir = await mkdtemp(path.join(tmpdir(), 'notes-board-'));
  vi.stubEnv('TURSO_DB_URL', `file:${path.join(dir, 'test.db')}`);
  vi.stubEnv('TURSO_AUTH_TOKEN', '');
  const [{ db, libsql }, schema, { folderRoutes }, boards] = await Promise.all([
    import('../src/api/db/client'),
    import('../src/api/db/schema'),
    import('../src/api/routes/folders'),
    import('../src/api/notes/boards'),
  ]);
  resources.push({ dir, client: libsql });
  await runBoardMigrations(libsql, 0, through);
  const now = new Date('2026-10-08T12:00:00.000Z');
  const users = ['owner', 'viewer', 'commenter', 'editor', 'stranger', 'other-user'].map((id) => ({
    id,
    name: id,
    email: `${id}@example.com`,
    emailVerified: true,
    image: null,
    createdAt: now,
    updatedAt: now,
  }));
  await db.insert(schema.user).values(users);
  await db.insert(schema.folders).values([
    { id: 'root', userId: 'owner', title: 'Root', createdAt: now, updatedAt: now },
    { id: 'board', userId: 'owner', parentFolderId: 'root', title: 'Board', createdAt: now, updatedAt: now },
    { id: 'child', userId: 'owner', parentFolderId: 'board', title: 'Child', createdAt: now, updatedAt: now },
    { id: 'other', userId: 'owner', title: 'Other', createdAt: now, updatedAt: now },
    { id: 'foreign', userId: 'other-user', title: 'Foreign', createdAt: now, updatedAt: now },
  ]);
  await db.insert(schema.collaborationGrants).values(
    ['viewer', 'commenter', 'editor'].map((role) => ({
      id: `grant_${role}`,
      ownerUserId: 'owner',
      granteeUserId: role,
      folderId: 'root',
      role: role as 'viewer' | 'commenter' | 'editor',
      createdByUserId: 'owner',
      createdAt: now,
      updatedAt: now,
    }))
  );
  const app = new Hono();
  app.use('*', async (c, next) => {
    const actor = c.req.header('x-user') ?? 'owner';
    c.set('user', users.find((user) => user.id === actor) ?? null);
    c.set('session', null);
    await next();
  });
  app.route('/internal/folders', folderRoutes);
  const request = (url: string, actor = 'owner') => app.request(url, { headers: { 'x-user': actor } });
  const save = (
    config: unknown = { ...DEFAULT_BOARD_CONFIG, enabled: false },
    expectedVersion: unknown = 0,
    actor = 'owner',
    folderId = 'board'
  ) =>
    app.request(`/internal/folders/${folderId}/board/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-user': actor },
      body: JSON.stringify({ config, expectedVersion }),
    });
  const addNote = async (
    id: string,
    title: string,
    names: string[] = [],
    extra: Partial<typeof schema.notes.$inferInsert> = {}
  ) => {
    const note = {
      id,
      title,
      folderId: 'board',
      userId: 'owner',
      content: `Private body for ${id}`,
      createdAt: now,
      updatedAt: now,
      ...extra,
    };
    await db.insert(schema.notes).values(note);
    for (const name of names) {
      const tagId = `${note.userId}_${name}`;
      await db
        .insert(schema.tags)
        .values({ id: tagId, userId: note.userId, name, normalizedName: name, createdAt: now, updatedAt: now })
        .onConflictDoNothing();
      await db
        .insert(schema.noteTags)
        .values({ id: `${id}_${name}`, userId: note.userId, noteId: id, tagId, createdAt: now });
    }
  };
  return { app, db, libsql, schema, boards, now, request, save, addNote };
}
