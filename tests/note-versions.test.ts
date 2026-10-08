import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectPrivacySafeCollaborationDto } from './helpers/collaboration-privacy';

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
  const dir = await mkdtemp(path.join(tmpdir(), 'notes-versions-'));
  tempDirs.push(dir);
  vi.stubEnv('TURSO_DB_URL', `file:${path.join(dir, 'test.db')}`);

  const [{ db, libsql }, schema, { folderRoutes }, { noteRoutes }] = await Promise.all([
    import('../src/api/db/client'),
    import('../src/api/db/schema'),
    import('../src/api/routes/folders'),
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

  return { app, folder };
}

async function createNote(app: Hono, folderId: string) {
  const response = await app.request(`/api/folders/${folderId}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Versioned Note', content: 'first' }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { note: { id: string; title: string; content: string }; contentHash: string };
  return body;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('note versions', () => {
  it('coalesces rapid user save activity', async () => {
    const { app, folder } = await setupApp();
    const created = await createNote(app, folder.id);
    const initial = await app.request(`/api/notes/${created.note.id}`);
    expect(initial.status).toBe(200);
    const initialBody = (await initial.json()) as { contentHash: string };

    const first = await app.request(`/api/notes/${created.note.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'second', baseHash: initialBody.contentHash }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { contentHash: string };

    const second = await app.request(`/api/notes/${created.note.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'third', baseHash: firstBody.contentHash }),
    });
    expect(second.status).toBe(200);

    const events = await app.request(`/api/notes/${created.note.id}/events`);
    expect(events.status).toBe(200);
    const eventsBody = (await events.json()) as {
      events: Array<{
        eventType: string;
        beforeHash: string | null;
        afterHash: string | null;
        actor: { key: string; label: string; type: string };
      }>;
    };
    expect(eventsBody.events.map((event) => event.eventType).sort()).toEqual(['create', 'update']);
    const updateEvent = eventsBody.events.find((event) => event.eventType === 'update');
    expect(updateEvent?.beforeHash).toBe(initialBody.contentHash);
    expect(updateEvent?.afterHash).toBeTruthy();
    expect(updateEvent?.actor).toMatchObject({ type: 'user', label: 'You' });
    expectPrivacySafeCollaborationDto(eventsBody, { forbiddenValues: ['user_a', 'a@example.com'] });
    expect(JSON.stringify(eventsBody)).not.toContain('actorId');
    expect(JSON.stringify(eventsBody)).not.toContain('userId');
  });

  it('rejects a stale user save without overwriting the current note', async () => {
    const { app, folder } = await setupApp();
    const created = await createNote(app, folder.id);

    const initial = await app.request(`/api/notes/${created.note.id}`);
    expect(initial.status).toBe(200);
    const initialBody = (await initial.json()) as { contentHash: string };

    const current = await app.request(`/api/notes/${created.note.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'current content', baseHash: initialBody.contentHash }),
    });
    expect(current.status).toBe(200);
    const currentBody = (await current.json()) as { contentHash: string };

    const stale = await app.request(`/api/notes/${created.note.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'stale overwrite', baseHash: initialBody.contentHash }),
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({
      error: 'Document has changed since it was read',
      currentHash: currentBody.contentHash,
    });

    const afterConflict = await app.request(`/api/notes/${created.note.id}`);
    expect(afterConflict.status).toBe(200);
    await expect(afterConflict.json()).resolves.toMatchObject({ note: { content: 'current content' } });
  });

  it('creates an initial version and restores a prior state', async () => {
    const { app, folder } = await setupApp();
    const created = await createNote(app, folder.id);

    const versions = await app.request(`/api/notes/${created.note.id}/versions`);
    expect(versions.status).toBe(200);
    const versionsBody = (await versions.json()) as { versions: Array<{ id: string; reason: string; title: string }> };
    expect(versionsBody.versions).toHaveLength(1);
    expect(versionsBody.versions[0]).toMatchObject({ reason: 'create', title: 'Versioned Note' });

    const update = await app.request(`/api/notes/${created.note.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Changed Note', content: 'second', baseHash: created.contentHash }),
    });
    expect(update.status).toBe(200);

    const restore = await app.request(`/api/notes/${created.note.id}/versions/${versionsBody.versions[0].id}/restore`, {
      method: 'POST',
    });
    expect(restore.status).toBe(200);
    await expect(restore.json()).resolves.toMatchObject({ note: { title: 'Versioned Note', content: 'first' } });

    const afterRestore = await app.request(`/api/notes/${created.note.id}/versions`);
    expect(afterRestore.status).toBe(200);
    const afterRestoreBody = (await afterRestore.json()) as { versions: Array<{ reason: string }> };
    expect(afterRestoreBody.versions.map((version) => version.reason)).toContain('before_restore');
  });
});
