import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupPropertiesTests, setupPropertiesTest } from './properties-fixtures';

afterEach(cleanupPropertiesTests);
async function setup(actor = 'owner') {
  const f = await setupPropertiesTest();
  await f.addNote('n', 'Note', [], { isApiEditable: true });
  const authorization = {
    id: 'authorization',
    userId: actor,
    accessMode: 'all' as const,
    canRead: true,
    canEdit: true,
    canCreate: false,
    canComment: false,
    sharedAccessMode: 'all' as const,
    createdAt: f.now,
    updatedAt: f.now,
  };
  await f.db.insert(f.schema.integrationAuthorizations).values(authorization);
  const apiKey = {
    ...authorization,
    id: 'key',
    authorizationId: authorization.id,
    name: 'test',
    uid: 'TESTTEST',
    hash: 'test',
    salt: 'test',
  };
  const { harnessRoutes } = await import('../src/api/routes/harness');
  const app = new Hono<{
    Variables: { user: { id: string }; session: null; apiKey: typeof apiKey; oauthAuthorization: null };
  }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: actor });
    c.set('session', null);
    c.set('apiKey', apiKey);
    c.set('oauthAuthorization', null);
    await next();
  });
  app.route('/harness', harnessRoutes);
  const request = (path: string, input?: unknown) =>
    app.request(
      `/harness${path}`,
      input === undefined
        ? {}
        : { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }
    );
  return { ...f, app, request, authorization };
}
describe('Harness properties parity', () => {
  it('uses the common enabled-board archive guard without granting board configuration tools', async () => {
    const f = await setup();
    const schema = await f.addField('Workflow');
    const { DEFAULT_BOARD_CONFIG } = await import('../src/shared/board');
    await f.boards.saveBoardConfig(
      'owner',
      'board',
      {
        ...DEFAULT_BOARD_CONFIG,
        schemaVersion: 5,
        grouping: { type: 'select', schemaId: schema.schemaId, propertyId: schema.definitions[0].id },
      },
      0,
      { schemaId: schema.schemaId as string, schemaRevision: 1 }
    );
    const before = (await f.libsql.execute('select * from folder_property_schemas')).rows;
    const archive = { expectedRevision: 1, mutation: { type: 'archive', propertyId: schema.definitions[0].id } };
    expect((await f.request('/folders/board/properties', archive)).status).toBe(409);
    expect((await f.libsql.execute('select * from folder_property_schemas')).rows).toEqual(before);
    await f.boards.saveBoardConfig('owner', 'board', { ...DEFAULT_BOARD_CONFIG, enabled: false }, 1);
    expect((await f.request('/folders/board/properties', archive)).status).toBe(200);
    expect((await f.app.request('/harness/folders/board/board/config')).status).toBe(404);
  });
  it.each([
    true,
    false,
  ])('limits direct Harness properties bodies (content-length: %s), without metadata writes', async (contentLength) => {
    const f = await setup();
    const schema = await f.addField('Summary', 'text');
    const definitionsBefore = (await f.libsql.execute('select * from folder_property_schemas')).rows;
    const notePatch = {
      schemaId: schema.schemaId,
      schemaRevision: 1,
      expectedRevision: 0,
      values: { [schema.definitions[0].id]: 'Bounded value' },
    };
    const schemaPatch = {
      expectedRevision: 1,
      mutation: { type: 'rename', propertyId: schema.definitions[0].id, label: 'Renamed' },
    };
    for (const [path, payload] of [
      ['/notes/n/properties', notePatch],
      ['/folders/board/properties', schemaPatch],
    ] as const) {
      const body = JSON.stringify(payload) + ' '.repeat(256 * 1024);
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (contentLength) headers['content-length'] = String(Buffer.byteLength(body));
      const response = await f.app.request(`/harness${path}`, { method: 'PATCH', headers, body });
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: 'Request body too large' });
      expect((await f.request(path)).status).toBe(200);
    }
    expect((await f.libsql.execute('select * from folder_property_schemas')).rows).toEqual(definitionsBefore);
    expect((await f.libsql.execute('select * from note_property_state')).rows).toEqual([]);
    expect((await f.libsql.execute('select * from note_events')).rows).toEqual([]);
    expect((await f.request('/notes/n/properties', notePatch)).status).toBe(200);
    expect((await f.request('/folders/board/properties', schemaPatch)).status).toBe(200);
  });
  it('uses the same revisions, controlled schema IDs and note event contract', async () => {
    const f = await setup();
    const response = await f.request('/folders/board/properties', {
      expectedRevision: 0,
      mutation: { type: 'add', label: 'Summary', fieldType: 'text' },
    });
    expect(response.status).toBe(200);
    const s = await response.json(),
      id = s.definitions[0].id;
    const patch = { schemaId: s.schemaId, schemaRevision: 1, expectedRevision: 0, values: { [id]: 'hello' } };
    expect((await f.request('/notes/n/properties', patch)).status).toBe(200);
    expect((await f.request('/notes/n/properties', patch)).status).toBe(409);
    const event = (await f.libsql.execute('select * from note_events')).rows[0];
    expect(event.actor_type).toBe('agent');
    expect(event.actor_id).toBe('key');
    expect(event.event_type).toBe('properties_update');
  });
  it('honors private ancestry, read-only policies, exact exceptions, API-editability and revocation', async () => {
    const f = await setup();
    const s = await f.addField('Text', 'text');
    const patch = {
      schemaId: s.schemaId,
      schemaRevision: 1,
      expectedRevision: 0,
      values: { [s.definitions[0].id]: 'value' },
    };
    await f.db.update(f.schema.folders).set({ isPrivate: true }).where(eq(f.schema.folders.id, 'root'));
    expect((await f.request('/notes/n/properties')).status).toBe(403);
    expect((await f.request('/folders/board/properties')).status).toBe(403);
    await f.db
      .update(f.schema.folders)
      .set({ isPrivate: false, isAgentReadOnly: true })
      .where(eq(f.schema.folders.id, 'root'));
    expect((await f.request('/notes/n/properties')).status).toBe(200);
    expect((await f.request('/notes/n/properties', patch)).status).toBe(403);
    await f.db
      .update(f.schema.integrationAuthorizations)
      .set({ accessMode: 'specific' })
      .where(eq(f.schema.integrationAuthorizations.id, 'authorization'));
    await f.db.insert(f.schema.authorizationFolderRules).values({
      id: 'rule',
      authorizationId: 'authorization',
      userId: 'owner',
      folderId: 'board',
      appliesTo: 'exact',
      canRead: true,
      canEdit: true,
      createdAt: f.now,
      updatedAt: f.now,
    });
    expect((await f.request('/notes/n/properties', patch)).status).toBe(200);
    await f.db.update(f.schema.notes).set({ isApiEditable: false }).where(eq(f.schema.notes.id, 'n'));
    expect((await f.request('/notes/n/properties', { ...patch, expectedRevision: 1, values: {} })).status).toBe(403);
    await f.db
      .update(f.schema.integrationAuthorizations)
      .set({ revokedAt: new Date() })
      .where(eq(f.schema.integrationAuthorizations.id, 'authorization'));
    expect((await f.request('/notes/n/properties')).status).toBe(403);
  });
  it('restricts shared note-only grants and schema mutations; rejects unselected grants', async () => {
    const f = await setup('stranger');
    const s = await f.addField();
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
    const result = await f.request('/notes/n/properties');
    expect(result.status).toBe(200);
    expect(JSON.stringify(await result.json())).not.toMatch(/owner|folderId|userId/);
    expect((await f.request('/folders/board/properties')).status).toBe(404);
    const patch = {
      schemaId: s.schemaId,
      schemaRevision: 1,
      expectedRevision: 0,
      values: { [s.definitions[0].id]: s.definitions[0].options[0].id },
    };
    expect((await f.request('/notes/n/properties', patch)).status).toBe(200);
    await f.db
      .update(f.schema.integrationAuthorizations)
      .set({ sharedAccessMode: 'specific' })
      .where(eq(f.schema.integrationAuthorizations.id, 'authorization'));
    expect((await f.request('/notes/n/properties')).status).toBe(404);
    await f.db.insert(f.schema.authorizationCollaborationScopes).values({
      id: 'scope',
      authorizationId: 'authorization',
      userId: 'stranger',
      collaborationGrantId: 'direct',
      createdAt: f.now,
    });
    expect((await f.request('/notes/n/properties')).status).toBe(200);
    await f.db.insert(f.schema.collaborationGrants).values({
      id: 'folder',
      ownerUserId: 'owner',
      granteeUserId: 'stranger',
      folderId: 'board',
      role: 'editor',
      createdByUserId: 'owner',
      createdAt: f.now,
      updatedAt: f.now,
    });
    await f.db.insert(f.schema.authorizationCollaborationScopes).values({
      id: 'scope2',
      authorizationId: 'authorization',
      userId: 'stranger',
      collaborationGrantId: 'folder',
      createdAt: f.now,
    });
    expect(
      (
        await f.request('/folders/board/properties', {
          expectedRevision: 1,
          mutation: { type: 'archive', propertyId: s.definitions[0].id },
        })
      ).status
    ).toBe(403);
  });
});
