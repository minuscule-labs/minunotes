import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTemplateTests, setupTemplateTest } from './template-fixtures';

afterEach(cleanupTemplateTests);
async function setup(userId = 'owner', oauth = false) {
  const f = await setupTemplateTest();
  const auth = {
    id: 'authorization',
    userId,
    accessMode: 'all' as const,
    sharedAccessMode: 'all' as const,
    canRead: true,
    canCreate: true,
    canEdit: false,
    canComment: false,
    createdAt: f.now,
    updatedAt: f.now,
  };
  await f.db.insert(f.schema.integrationAuthorizations).values(auth);
  const credential = {
    ...auth,
    id: 'credential',
    authorizationId: auth.id,
    integrationAuthorizationId: auth.id,
    name: 'Test',
    uid: 'TESTTEST',
    hash: 'fixture',
    salt: 'fixture',
  };
  const { harnessRoutes } = await import('../src/api/routes/harness');
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId });
    c.set('session', null);
    c.set('apiKey', oauth ? null : credential);
    c.set('oauthAuthorization', oauth ? credential : null);
    await next();
  });
  app.route('/harness', harnessRoutes);
  const preview = () => app.request('/harness/folders/board/templates/template/preview');
  const body = async () => {
    const p = await (await preview()).json();
    return {
      folderId: 'board',
      templateId: 'template',
      snapshot: p.snapshot,
      schemaId: p.schema.schemaId,
      schemaRevision: p.schema.revision,
      title: 'Final',
      tags: [],
      values: {},
      requestId: 'request',
      variables: { date: 'd', time: 't', datetime: 'dt' },
    };
  };
  const create = (payload: unknown) =>
    app.request('/harness/notes/from-template', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  return { ...f, app, auth, credential, preview, body, create };
}
describe('Harness template capabilities', () => {
  it('project-root subtree rules and specific exact read-only exceptions retain their existing boundaries', async () => {
    const f = await setup();
    await f.db
      .update(f.schema.integrationAuthorizations)
      .set({ accessMode: 'top_level' })
      .where(eq(f.schema.integrationAuthorizations.id, f.auth.id));
    await f.db.insert(f.schema.authorizationFolderRules).values({
      id: 'project',
      authorizationId: f.auth.id,
      userId: 'owner',
      folderId: 'root',
      appliesTo: 'subtree',
      canRead: true,
      canCreate: true,
      createdAt: f.now,
      updatedAt: f.now,
    });
    expect((await f.preview()).status).toBe(200);
    await f.db.update(f.schema.folders).set({ isAgentReadOnly: true }).where(eq(f.schema.folders.id, 'root'));
    expect((await f.preview()).status).toBe(403);
    await f.db
      .update(f.schema.integrationAuthorizations)
      .set({ accessMode: 'specific' })
      .where(eq(f.schema.integrationAuthorizations.id, f.auth.id));
    await f.db.insert(f.schema.authorizationFolderRules).values({
      id: 'exact',
      authorizationId: f.auth.id,
      userId: 'owner',
      folderId: 'board',
      appliesTo: 'exact',
      canRead: true,
      canCreate: true,
      createdAt: f.now,
      updatedAt: f.now,
    });
    expect((await f.create(await f.body())).status).toBe(201);
  });
  it('direct-note-only collaboration scopes never become folder template discovery or creation', async () => {
    const f = await setup('editor');
    await f.addNote('shared-note', 'Shared note');
    await f.db.delete(f.schema.collaborationGrants).where(eq(f.schema.collaborationGrants.id, 'grant_editor'));
    await f.db.insert(f.schema.collaborationGrants).values({
      id: 'note-grant',
      ownerUserId: 'owner',
      granteeUserId: 'editor',
      noteId: 'shared-note',
      role: 'editor',
      createdByUserId: 'owner',
      createdAt: f.now,
      updatedAt: f.now,
    });
    await f.db
      .update(f.schema.integrationAuthorizations)
      .set({ sharedAccessMode: 'specific' })
      .where(eq(f.schema.integrationAuthorizations.id, f.auth.id));
    await f.db.insert(f.schema.authorizationCollaborationScopes).values({
      id: 'scope',
      authorizationId: f.auth.id,
      userId: 'editor',
      collaborationGrantId: 'note-grant',
      createdAt: f.now,
    });
    expect((await f.app.request('/harness/notes/shared-note/properties')).status).toBe(200);
    expect((await f.app.request('/harness/folders/board/templates')).status).toBe(404);
    expect((await f.preview()).status).toBe(404);
    expect((await f.libsql.execute('select * from note_creation_requests')).rows).toEqual([]);
  });
  it.each([
    false,
    true,
  ])('create without edit works through credential type oauth=%s, snapshot never grants access', async (oauth) => {
    const f = await setup('editor', oauth);
    await f.db.update(f.schema.notes).set({ isApiEditable: false }).where(eq(f.schema.notes.id, 'template'));
    const body = await f.body(),
      response = await f.create(body);
    expect(response.status).toBe(201);
    const result = await response.json();
    expect(
      (
        await f.libsql.execute(
          `select user_id,created_by_user_id,updated_by_actor_type,updated_by_actor_id from notes where id='${result.note.id}'`
        )
      ).rows[0]
    ).toMatchObject({
      user_id: 'owner',
      created_by_user_id: 'editor',
      updated_by_actor_type: 'agent',
      updated_by_actor_id: 'credential',
    });
    expect(JSON.stringify(result)).not.toMatch(/owner|userId|actorId/);
    f.credential.canCreate = false;
    expect((await f.create(body)).status).toBe(404);
  });
  it('separately checks stored create/read and credential ceiling, destination and source private ancestry', async () => {
    const f = await setup(),
      body = await f.body();
    f.credential.canCreate = false;
    expect((await f.create(body)).status).toBe(403);
    f.credential.canCreate = true;
    await f.db
      .update(f.schema.integrationAuthorizations)
      .set({ canCreate: false })
      .where(eq(f.schema.integrationAuthorizations.id, f.auth.id));
    expect((await f.preview()).status).toBe(403);
    await f.db
      .update(f.schema.integrationAuthorizations)
      .set({ canCreate: true })
      .where(eq(f.schema.integrationAuthorizations.id, f.auth.id));
    await f.db.update(f.schema.folders).set({ isPrivate: true }).where(eq(f.schema.folders.id, 'other'));
    expect((await f.preview()).status).toBe(404);
    expect((await f.create(body)).status).toBe(404);
    await f.db.update(f.schema.folders).set({ isPrivate: false }).where(eq(f.schema.folders.id, 'other'));
    await f.db.update(f.schema.folders).set({ isAgentReadOnly: true }).where(eq(f.schema.folders.id, 'root'));
    expect((await f.create(body)).status).toBe(403);
  });
  it.each([true, false])('bounds direct Harness bodies content-length=%s', async (length) => {
    const f = await setup(),
      body = JSON.stringify(await f.body()) + ' '.repeat(256 * 1024);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (length) headers['content-length'] = String(Buffer.byteLength(body));
    expect((await f.app.request('/harness/notes/from-template', { method: 'POST', headers, body })).status).toBe(413);
    expect((await f.libsql.execute('select * from note_creation_requests')).rows).toEqual([]);
  });
  it('specific folder rules allow create but shared note-only scopes do not', async () => {
    const f = await setup();
    await f.db
      .update(f.schema.integrationAuthorizations)
      .set({ accessMode: 'specific' })
      .where(eq(f.schema.integrationAuthorizations.id, f.auth.id));
    expect((await f.preview()).status).toBe(403);
    await f.db.insert(f.schema.authorizationFolderRules).values({
      id: 'rule',
      authorizationId: f.auth.id,
      userId: 'owner',
      folderId: 'board',
      appliesTo: 'exact',
      canRead: true,
      canCreate: true,
      canEdit: false,
      createdAt: f.now,
      updatedAt: f.now,
    });
    expect((await f.preview()).status).toBe(200);
    const body = await f.body();
    await f.db
      .update(f.schema.integrationAuthorizations)
      .set({ revokedAt: f.now })
      .where(eq(f.schema.integrationAuthorizations.id, f.auth.id));
    expect((await f.create(body)).status).toBe(403);
  });
});
