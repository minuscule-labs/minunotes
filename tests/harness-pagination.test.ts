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

async function setup(accessMode: 'all' | 'specific' = 'all') {
  vi.resetModules();
  const dir = await mkdtemp(path.join(tmpdir(), 'notes-harness-pagination-'));
  tempDirs.push(dir);
  vi.stubEnv('TURSO_DB_URL', `file:${path.join(dir, 'test.db')}`);

  const [{ db, libsql }, schema, { harnessRoutes }] = await Promise.all([
    import('../src/api/db/client'),
    import('../src/api/db/schema'),
    import('../src/api/routes/harness'),
  ]);
  await runMigrations(libsql);

  const now = new Date('2025-01-01T00:00:00.000Z');
  const user = {
    id: 'user_pagination',
    name: 'Pagination User',
    email: 'pagination@example.com',
    emailVerified: true,
    image: null,
    createdAt: now,
    updatedAt: now,
  };
  const authorization = {
    id: 'agent_key_pagination',
    userId: user.id,
    canCreateFolders: true,
    canRead: true,
    canCreate: true,
    canEdit: true,
    accessMode,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
    revokedAt: null,
  };
  const apiKey = {
    ...authorization,
    authorizationId: authorization.id,
    name: 'Pagination key',
    uid: 'PAGEKEY1',
    hash: 'hash',
    salt: 'salt',
  };
  await db.insert(schema.user).values(user);
  await db.insert(schema.integrationAuthorizations).values(authorization);
  await db.insert(schema.apiKeys).values(apiKey);

  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', user);
    c.set('session', null);
    c.set('apiKey', apiKey);
    await next();
  });
  app.route('/api/harness', harnessRoutes);

  return { app, db, schema, user, apiKey, now };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function folder(id: string, title: string, now: Date) {
  return {
    id,
    userId: 'user_pagination',
    parentFolderId: null,
    title,
    isPrivate: false,
    isAgentReadOnly: false,
    createdAt: now,
    updatedAt: now,
  };
}

function note(id: string, folderId: string, title: string, content: string, now: Date) {
  return {
    id,
    userId: 'user_pagination',
    folderId,
    title,
    content,
    documentType: 'markdown' as const,
    type: 'note' as const,
    isApiEditable: true,
    createdAt: now,
    updatedAt: now,
  };
}

type PageBody<T> = {
  pageInfo: { hasMore: boolean; nextCursor: string | null };
} & T;

describe('harness cursor pagination', () => {
  it('paginates deterministic folder results and rejects invalid or mismatched cursors', async () => {
    const { app, db, schema, now } = await setup();
    await db
      .insert(schema.folders)
      .values([folder('folder_z', 'Zulu', now), folder('folder_a2', 'Alpha', now), folder('folder_a1', 'Alpha', now)]);

    const firstResponse = await app.request('/api/harness/folders?limit=2');
    const first = (await firstResponse.json()) as PageBody<{ folders: Array<{ id: string }> }>;
    expect(first.folders.map((item) => item.id)).toEqual(['folder_a1', 'folder_a2']);
    expect(first.pageInfo.hasMore).toBe(true);
    expect(first.pageInfo.nextCursor).toEqual(expect.any(String));

    const secondResponse = await app.request(
      `/api/harness/folders?limit=1&cursor=${encodeURIComponent(first.pageInfo.nextCursor ?? '')}`
    );
    const second = (await secondResponse.json()) as PageBody<{ folders: Array<{ id: string }> }>;
    expect(second.folders.map((item) => item.id)).toEqual(['folder_z']);
    expect(second.pageInfo).toEqual({ hasMore: false, nextCursor: null });

    expect((await app.request('/api/harness/folders?cursor=not-a-cursor')).status).toBe(400);
    expect(
      (await app.request(`/api/harness/tags?cursor=${encodeURIComponent(first.pageInfo.nextCursor ?? '')}`)).status
    ).toBe(400);
  });

  it('applies authorization and tag filters before paginating note search', async () => {
    const { app, db, schema, apiKey, now } = await setup('specific');
    const visibleFolder = folder('folder_visible', 'Visible', now);
    const hiddenFolder = folder('folder_hidden', 'Hidden', now);
    await db.insert(schema.folders).values([visibleFolder, hiddenFolder]);
    await db.insert(schema.authorizationFolderRules).values({
      id: 'permission_visible',
      authorizationId: apiKey.id,
      userId: apiKey.userId,
      folderId: visibleFolder.id,
      canRead: true,
      canCreate: true,
      canEdit: true,
      canCreateFolders: true,
      appliesTo: 'exact',
      createdAt: now,
      updatedAt: now,
    });
    await db
      .insert(schema.notes)
      .values([
        note('note_1', visibleFolder.id, 'Match one', 'shared text', now),
        note('note_2', visibleFolder.id, 'Match two', 'shared text', now),
        note('note_3', visibleFolder.id, 'Match three', 'shared text', now),
        note('note_hidden', hiddenFolder.id, 'shared text', 'shared text', now),
      ]);
    await db.insert(schema.tags).values({
      id: 'tag_project',
      userId: 'user_pagination',
      name: 'project',
      normalizedName: 'project',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.noteTags).values(
      ['note_1', 'note_2', 'note_3'].map((noteId) => ({
        id: `note_tag_${noteId}`,
        userId: 'user_pagination',
        noteId,
        tagId: 'tag_project',
        createdAt: now,
      }))
    );

    const firstResponse = await app.request('/api/harness/notes/search?q=shared&tag=project&limit=2');
    const first = (await firstResponse.json()) as PageBody<{
      notes: Array<{ id: string; content?: string; userId?: string }>;
    }>;
    expect(first.notes.map((item) => item.id)).toEqual(['note_1', 'note_3']);
    expect(first.notes.every((item) => item.content === undefined && item.userId === undefined)).toBe(true);
    expect(first.pageInfo.hasMore).toBe(true);

    const secondResponse = await app.request(
      `/api/harness/notes/search?q=shared&tag=project&limit=2&cursor=${encodeURIComponent(first.pageInfo.nextCursor ?? '')}`
    );
    const second = (await secondResponse.json()) as PageBody<{ notes: Array<{ id: string }> }>;
    expect(second.notes.map((item) => item.id)).toEqual(['note_2']);
    expect(second.pageInfo).toEqual({ hasMore: false, nextCursor: null });

    const mismatched = await app.request(
      `/api/harness/notes/search?q=different&tag=project&cursor=${encodeURIComponent(first.pageInfo.nextCursor ?? '')}`
    );
    expect(mismatched.status).toBe(400);

    const oversizedSearch = await app.request(`/api/harness/notes/search?q=${'x'.repeat(201)}`);
    expect(oversizedSearch.status).toBe(400);
    await expect(oversizedSearch.json()).resolves.toEqual({ error: 'Query must be 200 characters or fewer' });
  });

  it('preserves outgoing links and backlinks across batched access checks', async () => {
    const { app, db, schema, now } = await setup();
    const notesFolder = folder('folder_batched_links', 'Batched links', now);
    await db.insert(schema.folders).values(notesFolder);
    const linkedNotes = Array.from({ length: 502 }, (_, index) =>
      note(
        `note_access_${String(index).padStart(3, '0')}`,
        notesFolder.id,
        `Access ${String(index).padStart(3, '0')}`,
        '',
        now
      )
    );
    await db.insert(schema.notes).values(linkedNotes);
    await db.insert(schema.noteLinks).values([
      ...linkedNotes.slice(1).map((target, index) => ({
        id: `link_out_${String(index).padStart(3, '0')}`,
        userId: 'user_pagination',
        sourceNoteId: linkedNotes[0].id,
        targetNoteId: target.id,
        targetTitle: target.title,
        label: null,
        linkType: 'wikilink' as const,
        createdAt: now,
        updatedAt: now,
      })),
      ...linkedNotes.slice(1).map((source, index) => ({
        id: `link_back_${String(index).padStart(3, '0')}`,
        userId: 'user_pagination',
        sourceNoteId: source.id,
        targetNoteId: linkedNotes[0].id,
        targetTitle: linkedNotes[0].title,
        label: null,
        linkType: 'wikilink' as const,
        createdAt: now,
        updatedAt: now,
      })),
    ]);

    const outgoing = (await (await app.request(`/api/harness/notes/${linkedNotes[0].id}/links`)).json()) as {
      links: Array<{ targetNoteId: string | null }>;
    };
    expect(outgoing.links).toHaveLength(501);
    expect(outgoing.links.every((link) => link.targetNoteId !== null)).toBe(true);

    const backlinks = (await (await app.request(`/api/harness/notes/${linkedNotes[0].id}/backlinks`)).json()) as {
      backlinks: Array<{ sourceNoteId: string; sourceFolderId: string | null }>;
    };
    expect(backlinks.backlinks).toHaveLength(501);
    expect(backlinks.backlinks.every((link) => link.sourceFolderId === notesFolder.id)).toBe(true);
  });

  it('paginates orphans across bounded candidate batches without losing order', async () => {
    const { app, db, schema, now } = await setup();
    const notesFolder = folder('folder_batched_orphans', 'Batched orphans', now);
    await db.insert(schema.folders).values(notesFolder);
    const linkedNotes = Array.from({ length: 255 }, (_, index) =>
      note(
        `note_linked_${String(index).padStart(3, '0')}`,
        notesFolder.id,
        `Linked ${String(index).padStart(3, '0')}`,
        '',
        now
      )
    );
    const orphanNotes = Array.from({ length: 10 }, (_, index) =>
      note(
        `note_orphan_${String(index).padStart(3, '0')}`,
        notesFolder.id,
        `Orphan ${String(index).padStart(3, '0')}`,
        '',
        now
      )
    );
    await db.insert(schema.notes).values([...linkedNotes, ...orphanNotes]);
    await db.insert(schema.noteLinks).values(
      linkedNotes.map((target, index) => ({
        id: `link_${String(index).padStart(3, '0')}`,
        userId: 'user_pagination',
        sourceNoteId: linkedNotes[0].id,
        targetNoteId: target.id,
        targetTitle: target.title,
        label: null,
        linkType: 'wikilink' as const,
        createdAt: now,
        updatedAt: now,
      }))
    );

    const firstResponse = await app.request('/api/harness/notes/orphans?limit=5');
    const first = (await firstResponse.json()) as PageBody<{ notes: Array<{ id: string }> }>;
    expect(first.notes.map((item) => item.id)).toEqual(
      Array.from({ length: 5 }, (_, index) => `note_orphan_${String(index).padStart(3, '0')}`)
    );
    expect(first.pageInfo.hasMore).toBe(true);

    const secondResponse = await app.request(
      `/api/harness/notes/orphans?limit=5&cursor=${encodeURIComponent(first.pageInfo.nextCursor ?? '')}`
    );
    const second = (await secondResponse.json()) as PageBody<{ notes: Array<{ id: string }> }>;
    expect(second.notes.map((item) => item.id)).toEqual(
      Array.from({ length: 5 }, (_, index) => `note_orphan_${String(index + 5).padStart(3, '0')}`)
    );
    expect(second.pageInfo).toEqual({ hasMore: false, nextCursor: null });
  });

  it('paginates line matches across bounded note batches without losing order', async () => {
    const { app, db, schema, now } = await setup();
    const notesFolder = folder('folder_batched_lines', 'Batched lines', now);
    await db.insert(schema.folders).values(notesFolder);
    await db
      .insert(schema.notes)
      .values(
        Array.from({ length: 30 }, (_, index) =>
          note(
            `note_batch_${String(index).padStart(2, '0')}`,
            notesFolder.id,
            `Batch ${String(index).padStart(2, '0')}`,
            `batch hit ${index}`,
            now
          )
        )
      );

    const firstResponse = await app.request('/api/harness/notes/search-lines?q=batch%20hit&limit=25');
    const first = (await firstResponse.json()) as PageBody<{ matches: Array<{ noteId: string }> }>;
    expect(first.matches.map((match) => match.noteId)).toEqual(
      Array.from({ length: 25 }, (_, index) => `note_batch_${String(index).padStart(2, '0')}`)
    );
    expect(first.pageInfo.hasMore).toBe(true);

    const secondResponse = await app.request(
      `/api/harness/notes/search-lines?q=batch%20hit&limit=25&cursor=${encodeURIComponent(first.pageInfo.nextCursor ?? '')}`
    );
    const second = (await secondResponse.json()) as PageBody<{ matches: Array<{ noteId: string }> }>;
    expect(second.matches.map((match) => match.noteId)).toEqual(
      Array.from({ length: 5 }, (_, index) => `note_batch_${String(index + 25).padStart(2, '0')}`)
    );
    expect(second.pageInfo).toEqual({ hasMore: false, nextCursor: null });
  });

  it('continues through more than two pages of matches in one note', async () => {
    const { app, db, schema, now } = await setup();
    const notesFolder = folder('folder_lines', 'Lines', now);
    await db.insert(schema.folders).values(notesFolder);
    await db
      .insert(schema.notes)
      .values(note('note_lines', notesFolder.id, 'Line matches', 'hit 1\nhit 2\nhit 3\nhit 4\nhit 5', now));

    const seen: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page += 1) {
      const response = await app.request(
        `/api/harness/notes/search-lines?q=hit&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      );
      const body = (await response.json()) as PageBody<{ matches: Array<{ line: number }> }>;
      seen.push(...body.matches.map((match) => match.line));
      cursor = body.pageInfo.nextCursor;
      if (page < 2) expect(body.pageInfo.hasMore).toBe(true);
      else expect(body.pageInfo).toEqual({ hasMore: false, nextCursor: null });
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });
});
