import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupPropertiesTests, setupPropertiesTest } from './properties-fixtures';

afterEach(cleanupPropertiesTests);

async function setup(actor = 'owner', oauth = false) {
  const f = await setupPropertiesTest();
  const authorization = {
    id: 'automation-auth',
    userId: actor,
    accessMode: 'all' as const,
    sharedAccessMode: 'all' as const,
    canRead: true,
    canEdit: true,
    canCreate: false,
    canComment: false,
    createdAt: f.now,
    updatedAt: f.now,
  };
  await f.db.insert(f.schema.integrationAuthorizations).values(authorization);
  const credential = {
    ...authorization,
    id: 'automation-key',
    authorizationId: authorization.id,
    integrationAuthorizationId: authorization.id,
    name: 'Test',
    uid: 'TESTTEST',
    hash: 'test',
    salt: 'test',
    clientId: 'client',
    scope: 'notes.read notes.edit',
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', actor === 'anonymous' ? null : { id: actor });
    c.set('session', null);
    c.set('apiKey', oauth ? null : credential);
    c.set('oauthAuthorization', oauth ? credential : null);
    await next();
  });
  app.route('/harness', (await import('../src/api/routes/harness')).harnessRoutes);
  const request = (path: string, body?: unknown) =>
    app.request(
      `/harness${path}`,
      body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }
    );
  const add = (id = 'n', title = 'Before', extra = {}) => f.addNote(id, title, [], { isApiEditable: true, ...extra });
  const rename = (title = 'After', expectedTitle = 'Before', id = 'n') =>
    request(`/notes/${id}/rename`, { title, expectedTitle });
  const stored = async () => (await f.db.select().from(f.schema.notes).where(eq(f.schema.notes.id, 'n')))[0];
  return { ...f, app, request, add, rename, stored, authorization, credential };
}

describe('exact-folder Harness listing', () => {
  it('lists compact ordinary notes only, in stable title/ID pages with exact folder boundaries', async () => {
    const f = await setup();
    await f.add('a', 'Same');
    await f.add('b', 'Same');
    await f.add('c', 'Zulu', { documentType: 'canvas.default', content: '{"nodes":[],"edges":[]}' });
    await f.add('d', 'ZZ', { documentType: 'canvas.mindmap', content: '{"nodes":[],"edges":[]}' });
    await f.add('child-note', 'AAA', { folderId: 'child' });
    await f.add('other-note', 'AAA', { folderId: 'other' });
    await f.add('template', 'AAA', { type: 'template' });
    await f.add('deleted', 'AAA', { deletedAt: f.now });
    let cursor: string | null = null;
    const ids: string[] = [];
    do {
      const response = await f.request(
        `/folders/board/notes?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      for (const note of body.notes) {
        expect(Object.keys(note).sort()).toEqual(
          ['id', 'folderId', 'title', 'documentType', 'type', 'createdAt', 'updatedAt'].sort()
        );
        ids.push(note.id);
      }
      expect(body.pageInfo.hasMore).toBe(Boolean(body.pageInfo.nextCursor));
      cursor = body.pageInfo.nextCursor;
    } while (cursor);
    expect(ids).toEqual(['a', 'b', 'd', 'c']);
    expect(await (await f.request('/folders/other/notes')).json()).toMatchObject({
      notes: [{ id: 'other-note' }],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    expect(await (await f.request('/folders/foreign/notes')).json()).not.toHaveProperty('notes');
  });

  it('bounds pages, handles empty folders and rejects malformed/cross-folder/credential cursors and unsupported filters', async () => {
    const f = await setup();
    expect(await (await f.request('/folders/board/notes')).json()).toEqual({
      notes: [],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    await f.db.insert(f.schema.notes).values(
      Array.from({ length: 102 }, (_, i) => ({
        id: `n${String(i).padStart(3, '0')}`,
        title: 'Same',
        folderId: 'board',
        userId: 'owner',
        content: 'Never returned',
        createdAt: f.now,
        updatedAt: f.now,
      }))
    );
    expect((await (await f.request('/folders/board/notes')).json()).notes).toHaveLength(25);
    expect((await (await f.request('/folders/board/notes?limit=10000')).json()).notes).toHaveLength(100);
    const page = await (await f.request('/folders/board/notes?limit=1')).json();
    const cursor = encodeURIComponent(page.pageInfo.nextCursor);
    expect((await f.request('/folders/board/notes?cursor=invalid')).status).toBe(400);
    expect((await f.request(`/folders/other/notes?cursor=${cursor}`)).status).toBe(400);
    f.credential.id = 'different-key';
    expect((await f.request(`/folders/board/notes?cursor=${cursor}`)).status).toBe(400);
    expect((await f.request('/folders/board/notes?type=template')).status).toBe(400);
    expect((await f.request('/folders/board/notes?limit=1&limit=2')).status).toBe(400);
  });

  it.each([
    'viewer',
    'editor',
  ])('supports authorized shared-folder reads for %s without owner/actor identities', async (actor) => {
    const f = await setup(actor, true);
    await f.add();
    const response = await f.request('/folders/board/notes');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.notes).toHaveLength(1);
    expect(JSON.stringify(body)).not.toMatch(/userId|updatedByActorId|content|grant_/);
    f.credential.canRead = false;
    expect((await f.request('/folders/board/notes')).status).toBe(404);
  });

  it('never authorizes folder enumeration with a direct-note grant', async () => {
    const f = await setup('stranger');
    await f.add();
    await f.db.insert(f.schema.collaborationGrants).values({
      id: 'direct',
      ownerUserId: 'owner',
      granteeUserId: 'stranger',
      noteId: 'n',
      role: 'editor',
      createdByUserId: 'owner',
      createdAt: f.now,
      updatedAt: f.now,
    });
    expect((await f.request('/notes/n')).status).toBe(200);
    expect((await f.request('/folders/board/notes')).status).toBe(404);
  });

  it.each([
    'private',
    'trashed',
    'revoked',
    'no-read',
    'specific-denied',
  ])('denies listing after %s changes', async (policy) => {
    const f = await setup();
    await f.add();
    if (policy === 'private')
      await f.db.update(f.schema.folders).set({ isPrivate: true }).where(eq(f.schema.folders.id, 'root'));
    if (policy === 'trashed')
      await f.db.update(f.schema.folders).set({ deletedAt: f.now }).where(eq(f.schema.folders.id, 'root'));
    if (policy === 'revoked')
      await f.db
        .update(f.schema.integrationAuthorizations)
        .set({ revokedAt: f.now })
        .where(eq(f.schema.integrationAuthorizations.id, f.authorization.id));
    if (policy === 'no-read') f.credential.canRead = false;
    if (policy === 'specific-denied')
      await f.db
        .update(f.schema.integrationAuthorizations)
        .set({ accessMode: 'specific' })
        .where(eq(f.schema.integrationAuthorizations.id, f.authorization.id));
    expect((await f.request('/folders/board/notes')).status).toBeGreaterThanOrEqual(403);
  });
});

describe('metadata-safe Markdown rename', () => {
  it('preserves identity/content/properties/tags and uses native versions, events and link resolution', async () => {
    const f = await setup();
    await f.add();
    const s = await f.addField('Summary', 'text');
    await f.patch('n', { [s.definitions[0].id]: 'retained' });
    const properties = await f.properties.readNoteProperties(f.actor, 'n');
    await f.addNote('linker', 'Linker', ['retained-tag'], { content: '[[After]] [[Before]]' });
    const links = await import('../src/api/notes/links');
    await links.reindexNoteLinks({
      userId: 'owner',
      noteId: 'linker',
      markdown: '[[After]] [[Before]]',
      documentType: 'markdown',
    });
    const before = await f.stored();
    const response = await f.rename('  After  ');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.note).toMatchObject({ id: 'n', folderId: 'board', title: 'After' });
    expect(body.note).not.toHaveProperty('content');
    expect(body.contentHash).toBe((await import('../src/api/harness/hash')).hashMarkdown(before.content));
    expect(await f.stored()).toMatchObject({
      id: before.id,
      content: before.content,
      folderId: before.folderId,
      documentType: before.documentType,
      createdAt: before.createdAt,
      isApiEditable: true,
      updatedByActorId: f.credential.id,
    });
    expect(await f.properties.readNoteProperties(f.actor, 'n')).toEqual(properties);
    const versions = await f.db.select().from(f.schema.noteVersions);
    expect(versions).toContainEqual(
      expect.objectContaining({
        noteId: 'n',
        title: 'Before',
        content: before.content,
        reason: 'before_agent_edit',
        actorType: 'agent',
      })
    );
    const events = await f.db
      .select()
      .from(f.schema.noteEvents)
      .where(and(eq(f.schema.noteEvents.noteId, 'n'), eq(f.schema.noteEvents.eventType, 'update')));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      summary: 'Updated title',
      beforeHash: body.contentHash,
      afterHash: body.contentHash,
    });
    const outgoing = await f.db.select().from(f.schema.noteLinks).where(eq(f.schema.noteLinks.sourceNoteId, 'linker'));
    expect(outgoing).toContainEqual(expect.objectContaining({ targetTitle: 'After', targetNoteId: 'n' }));
    expect(outgoing).toContainEqual(expect.objectContaining({ targetTitle: 'Before', targetNoteId: 'n' }));
  });

  it('rejects concurrent stale titles, and same-title no-ops create no additional history/events', async () => {
    const f = await setup();
    await f.add();
    const responses = await Promise.all([f.rename('First'), f.rename('Second')]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const current = await f.stored();
    const events = await f.db.select().from(f.schema.noteEvents);
    const versions = await f.db.select().from(f.schema.noteVersions);
    expect((await f.rename('Overwrite', 'Before')).status).toBe(409);
    expect((await f.rename(current.title, current.title)).status).toBe(200);
    expect(await f.db.select().from(f.schema.noteEvents)).toEqual(events);
    expect(await f.db.select().from(f.schema.noteVersions)).toEqual(versions);
    expect((await f.stored()).updatedAt).toEqual(current.updatedAt);
  });

  it('uses the exact expectedTitle including spaces, rather than normalizing a precondition', async () => {
    const f = await setup();
    await f.add('n', ' Before ');
    expect((await f.rename('After', 'Before')).status).toBe(409);
    expect((await f.rename('After', ' Before ')).status).toBe(200);
  });

  it('rejects invalid requests, templates, canvases and non-API-editable notes without writes', async () => {
    const f = await setup();
    await f.add();
    for (const body of [
      null,
      [],
      {},
      { title: 'After' },
      { title: '', expectedTitle: 'Before' },
      { title: '   ', expectedTitle: 'Before' },
      { title: 'x'.repeat(1001), expectedTitle: 'Before' },
      { title: 'After', expectedTitle: 2 },
      { title: 'After', expectedTitle: 'Before', folderId: 'other' },
    ])
      expect((await f.request('/notes/n/rename', body)).status).toBe(400);
    for (const extra of [
      { type: 'template' as const },
      { documentType: 'canvas.default' as const },
      { documentType: 'canvas.mindmap' as const },
    ]) {
      await f.db
        .update(f.schema.notes)
        .set({ type: 'note', documentType: 'markdown', ...extra })
        .where(eq(f.schema.notes.id, 'n'));
      expect((await f.rename()).status).toBe(400);
    }
    await f.db
      .update(f.schema.notes)
      .set({ documentType: 'markdown', isApiEditable: false })
      .where(eq(f.schema.notes.id, 'n'));
    expect((await f.rename()).status).toBe(403);
    expect((await f.stored()).title).toBe('Before');
    expect(await f.db.select().from(f.schema.noteEvents)).toHaveLength(0);
    expect(await f.db.select().from(f.schema.noteVersions)).toHaveLength(0);
  });

  it.each(['viewer', 'commenter'])('denies rename for shared %s', async (actor) => {
    const f = await setup(actor);
    await f.add();
    expect((await f.rename()).status).toBe(404);
    expect((await f.stored()).title).toBe('Before');
  });

  it.each([
    false,
    true,
  ])('allows scoped direct-note editor rename and hides folder context (OAuth=%s)', async (oauth) => {
    const f = await setup('stranger', oauth);
    await f.add();
    await f.db.insert(f.schema.collaborationGrants).values({
      id: 'direct',
      ownerUserId: 'owner',
      granteeUserId: 'stranger',
      noteId: 'n',
      role: 'editor',
      createdByUserId: 'owner',
      createdAt: f.now,
      updatedAt: f.now,
    });
    const response = await f.rename();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.note.folderId).toBeNull();
    expect(JSON.stringify(body)).not.toMatch(/board|owner|userId|actorId|Private body/);
    await f.db.delete(f.schema.collaborationGrants).where(eq(f.schema.collaborationGrants.id, 'direct'));
    expect((await f.rename('Another', 'After')).status).toBe(404);
  });

  it.each([
    'private',
    'trashed',
    'read-only',
    'revoked',
    'no-read',
    'no-edit',
    'specific-denied',
  ])('rejects rename after %s changes without writes', async (policy) => {
    const f = await setup();
    await f.add();
    if (policy === 'private')
      await f.db.update(f.schema.folders).set({ isPrivate: true }).where(eq(f.schema.folders.id, 'root'));
    if (policy === 'trashed')
      await f.db.update(f.schema.folders).set({ deletedAt: f.now }).where(eq(f.schema.folders.id, 'root'));
    if (policy === 'read-only')
      await f.db.update(f.schema.folders).set({ isAgentReadOnly: true }).where(eq(f.schema.folders.id, 'root'));
    if (policy === 'revoked')
      await f.db
        .update(f.schema.integrationAuthorizations)
        .set({ revokedAt: f.now })
        .where(eq(f.schema.integrationAuthorizations.id, f.authorization.id));
    if (policy === 'no-read') f.credential.canRead = false;
    if (policy === 'no-edit') f.credential.canEdit = false;
    if (policy === 'specific-denied')
      await f.db
        .update(f.schema.integrationAuthorizations)
        .set({ accessMode: 'specific' })
        .where(eq(f.schema.integrationAuthorizations.id, f.authorization.id));
    expect((await f.rename()).status).toBeGreaterThanOrEqual(403);
    expect((await f.stored()).title).toBe('Before');
    expect(await f.db.select().from(f.schema.noteEvents)).toHaveLength(0);
    expect(await f.db.select().from(f.schema.noteVersions)).toHaveLength(0);
  });

  it('rolls back title/version changes on a late event failure', async () => {
    const f = await setup();
    await f.add();
    await f.libsql.execute(
      "create trigger fail_rename before insert on note_events begin select raise(abort, 'test failure'); end"
    );
    const { renameMarkdownNote } = await import('../src/api/notes/task-automation');
    await expect(
      renameMarkdownNote(
        {
          actorUserId: 'owner',
          actorType: 'agent',
          actorId: f.credential.id,
          authorizationId: f.authorization.id,
          credentialCapabilities: f.credential,
        },
        'n',
        { title: 'After', expectedTitle: 'Before' }
      )
    ).rejects.toThrow();
    expect((await f.stored()).title).toBe('Before');
    expect(await f.db.select().from(f.schema.noteEvents)).toHaveLength(0);
    expect(await f.db.select().from(f.schema.noteVersions)).toHaveLength(0);
  });
});
