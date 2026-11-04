import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTemplateTests, setupTemplateTest } from './template-fixtures';

afterEach(cleanupTemplateTests);
async function setup(userId = 'owner', oauth = false) {
  const f = await setupTemplateTest();
  const auth = {
    id: 'manager',
    userId: userId === 'anonymous' ? 'owner' : userId,
    accessMode: 'all' as const,
    sharedAccessMode: 'all' as const,
    canRead: true,
    canCreate: true,
    canEdit: true,
    canComment: false,
    createdAt: f.now,
    updatedAt: f.now,
  };
  await f.db.insert(f.schema.integrationAuthorizations).values(auth);
  const credential = {
    ...auth,
    id: 'manager-key',
    authorizationId: auth.id,
    integrationAuthorizationId: auth.id,
    name: 'Test',
    uid: 'TESTTEST',
    hash: 'fixture',
    salt: 'fixture',
    clientId: 'client',
    scope: 'notes.read notes.edit notes.create',
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', userId === 'anonymous' ? null : { id: userId });
    c.set('session', null);
    c.set('apiKey', oauth ? null : credential);
    c.set('oauthAuthorization', oauth ? credential : null);
    await next();
  });
  app.route('/harness', (await import('../src/api/routes/harness')).harnessRoutes);
  const request = (path: string, method = 'GET', body?: unknown) =>
    app.request(`/harness${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  const read = () => request('/templates/template');
  const state = async () => await (await request('/templates/template/settings')).json();
  const update = async (patch: Record<string, unknown> = { title: 'Renamed' }) => {
    const current = await (await read()).json();
    return request('/templates/template', 'PATCH', {
      baseHash: current.contentHash,
      expectedTitle: current.template?.title,
      ...patch,
    });
  };
  const rule = (folderId: string, appliesTo: 'exact' | 'subtree' = 'subtree', extra = {}) =>
    f.db.insert(f.schema.authorizationFolderRules).values({
      id: `rule-${folderId}`,
      authorizationId: auth.id,
      userId,
      folderId,
      appliesTo,
      canRead: true,
      canCreate: true,
      canEdit: true,
      createdAt: f.now,
      updatedAt: f.now,
      ...extra,
    });
  const stored = async () => (await f.db.select().from(f.schema.notes).where(eq(f.schema.notes.id, 'template')))[0];
  return { ...f, app, auth, credential, request, read, state, update, rule, stored };
}

describe('owned template authoring', () => {
  it('can edit and rename a legacy long title without truncating its precondition', async () => {
    const f = await setup();
    await f.db
      .update(f.schema.notes)
      .set({ title: 'x'.repeat(1001) })
      .where(eq(f.schema.notes.id, 'template'));
    expect((await f.update({ markdown: '' })).status).toBe(200);
    expect((await f.update({ title: 'Short' })).status).toBe(200);
    expect((await f.stored()).title).toBe('Short');
  });
  it('updates native attachment references and link targets transactionally without regenerating content', async () => {
    const f = await setup();
    await f.addNote('target', 'Target');
    await f.db.insert(f.schema.attachments).values({
      id: 'att_template',
      userId: 'owner',
      noteId: 'template',
      folderId: 'other',
      filename: 'image.png',
      mimeType: 'image/png',
      size: 4,
      contentHash: 'hash',
      storageKey: 'test/image.png',
      createdAt: f.now,
      updatedAt: f.now,
    });
    const old = await (await f.read()).json();
    expect((await f.update({ markdown: '![](/internal/attachments/att_template/content) [[Target]]' })).status).toBe(
      200
    );
    expect((await f.db.select().from(f.schema.attachments))[0].referencedAt).toBeTruthy();
    expect((await f.db.select().from(f.schema.noteLinks)).some((l) => l.targetNoteId === 'target')).toBe(true);
    expect(
      (
        await f.request('/templates/template', 'PATCH', {
          baseHash: old.contentHash,
          expectedTitle: 'Feature',
          markdown: 'Stale',
        })
      ).status
    ).toBe(409);
    expect((await f.update({ markdown: '' })).status).toBe(200);
    expect((await f.db.select().from(f.schema.attachments))[0].unreferencedAt).toBeTruthy();
    expect(await f.db.select().from(f.schema.noteLinks)).toEqual([]);
  });
  it.each([
    false,
    true,
  ])('creates/reads/renames/edits native templates with agent attribution (OAuth=%s)', async (oauth) => {
    const f = await setup('owner', oauth);
    const created = await f.request('/templates', 'POST', {
      folderId: 'other',
      title: ' New ',
      markdown: '{{title}}\n[[Target]]',
    });
    expect(created.status).toBe(201);
    const made = await created.json();
    expect(made).toMatchObject({
      template: { title: 'New', folderId: 'other', body: '{{title}}\n[[Target]]', isApiEditable: true },
    });
    expect(made.contentHash).toMatch(/^[a-f0-9]{64}$/);
    const [row] = await f.db.select().from(f.schema.notes).where(eq(f.schema.notes.id, made.template.id));
    expect(row).toMatchObject({
      type: 'template',
      documentType: 'markdown',
      createdByUserId: 'owner',
      updatedByActorType: 'agent',
      updatedByActorId: 'manager-key',
    });
    expect(await f.db.select().from(f.schema.noteEvents)).toHaveLength(1);
    expect(await f.db.select().from(f.schema.noteVersions)).toHaveLength(1);
    const before = await f.stored();
    const read = await (await f.read()).json();
    const updated = await f.update({ title: 'Renamed', markdown: 'New {{date}} [[Target]]' });
    expect(updated.status).toBe(200);
    const after = await updated.json();
    expect(after.template).toMatchObject({
      id: 'template',
      title: 'Renamed',
      folderId: 'other',
      body: 'New {{date}} [[Target]]',
    });
    expect(after.contentHash).not.toBe(read.contentHash);
    expect(await f.stored()).toMatchObject({
      id: before.id,
      createdAt: before.createdAt,
      folderId: before.folderId,
      type: 'template',
    });
    expect((await f.db.select().from(f.schema.noteVersions)).find((v) => v.noteId === 'template')).toMatchObject({
      reason: 'before_agent_edit',
      title: 'Feature',
      content: before.content,
    });
    expect(await (await f.read()).json()).toEqual(after);
    const events = await f.db.select().from(f.schema.noteEvents);
    const noop = await f.update({ title: 'Renamed' });
    expect(noop.status).toBe(200);
    expect(await f.db.select().from(f.schema.noteEvents)).toEqual(events);
  });
  it('uses independent exact title/body guards and admits only one concurrent update', async () => {
    const f = await setup(),
      current = await (await f.read()).json();
    const body = { baseHash: current.contentHash, expectedTitle: 'Feature', title: 'One' };
    const responses = await Promise.all([
      f.request('/templates/template', 'PATCH', body),
      f.request('/templates/template', 'PATCH', { ...body, title: 'Two' }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await f.request('/templates/template', 'PATCH', { ...body, markdown: 'Old intent' })).status).toBe(409);
    const read = await (await f.read()).json();
    expect(
      (
        await f.request('/templates/template', 'PATCH', {
          ...body,
          expectedTitle: read.template.title,
          baseHash: '0'.repeat(64),
        })
      ).status
    ).toBe(409);
    expect(await f.db.select().from(f.schema.noteEvents)).toHaveLength(1);
  });
  it('rolls back late history/event failures without changing template or links', async () => {
    const f = await setup(),
      current = await f.stored();
    await f.libsql.execute(
      "create trigger fail_template before insert on note_events begin select raise(abort, 'test failure'); end"
    );
    const response = await f.update({ title: 'After', markdown: 'Changed [[New]]' });
    expect(response.status).toBe(500);
    expect(await f.stored()).toEqual(current);
    expect(await f.db.select().from(f.schema.noteVersions)).toEqual([]);
    expect(await f.db.select().from(f.schema.noteLinks)).toEqual([]);
  });
  it('rejects malformed, unsupported and oversized authoring input, without opening generic template editing', async () => {
    const f = await setup();
    for (const value of [
      null,
      [],
      {},
      { folderId: 'other', title: ' ', markdown: '' },
      { folderId: 'other', title: 'x'.repeat(1001), markdown: '' },
      { folderId: 'other', title: 'T', markdown: '', isApiEditable: true },
    ])
      expect((await f.request('/templates', 'POST', value)).status).toBe(400);
    const current = await (await f.read()).json();
    for (const patch of [
      {},
      { baseHash: 'bad', expectedTitle: 'Feature', title: 'x' },
      { baseHash: current.contentHash, expectedTitle: 'Feature' },
      { baseHash: current.contentHash, expectedTitle: 'Feature', folderId: 'board', title: 'x' },
      { baseHash: current.contentHash, expectedTitle: 'Feature', title: ' ' },
    ])
      expect((await f.request('/templates/template', 'PATCH', patch)).status).toBe(400);
    expect(
      (await f.request('/templates', 'POST', { folderId: 'other', title: 'T', markdown: 'x'.repeat(200001) })).status
    ).toBe(400);
    const raw = JSON.stringify({ folderId: 'other', title: 'T', markdown: '' }) + ' '.repeat(256 * 1024);
    expect(
      (
        await f.app.request('/harness/templates', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: raw,
        })
      ).status
    ).toBe(413);
    expect((await f.request('/notes/template/rename', 'POST', { title: 'No', expectedTitle: 'Feature' })).status).toBe(
      400
    );
    expect(
      (
        await f.request('/notes/template/edit', 'POST', {
          baseHash: current.contentHash,
          edits: [{ type: 'append', text: 'No' }],
        })
      ).status
    ).toBe(403);
    await f.addNote('ordinary', 'Ordinary');
    expect((await f.request('/templates/ordinary')).status).toBe(404);
    await f.db.update(f.schema.notes).set({ documentType: 'canvas.default' }).where(eq(f.schema.notes.id, 'template'));
    expect((await f.read()).status).toBe(404);
    expect(await f.db.select().from(f.schema.noteEvents)).toEqual([]);
  });
  it.each([
    'private',
    'trashed-parent',
    'readonly',
    'api-locked',
    'revoked',
    'credential-read',
    'credential-edit',
    'stored-edit',
    'specific',
  ])('enforces %s at authoritative mutation boundary', async (mode) => {
    const f = await setup(),
      initial = await (await f.read()).json(),
      before = await f.stored();
    if (mode === 'private')
      await f.db.update(f.schema.folders).set({ isPrivate: true }).where(eq(f.schema.folders.id, 'other'));
    if (mode === 'trashed-parent') {
      await f.db.update(f.schema.folders).set({ parentFolderId: 'root' }).where(eq(f.schema.folders.id, 'other'));
      await f.db.update(f.schema.folders).set({ deletedAt: f.now }).where(eq(f.schema.folders.id, 'root'));
    }
    if (mode === 'readonly')
      await f.db.update(f.schema.folders).set({ isAgentReadOnly: true }).where(eq(f.schema.folders.id, 'other'));
    if (mode === 'api-locked')
      await f.db.update(f.schema.notes).set({ isApiEditable: false }).where(eq(f.schema.notes.id, 'template'));
    if (mode === 'revoked')
      await f.db
        .update(f.schema.integrationAuthorizations)
        .set({ revokedAt: f.now })
        .where(eq(f.schema.integrationAuthorizations.id, f.auth.id));
    if (mode === 'credential-read') f.credential.canRead = false;
    if (mode === 'credential-edit') f.credential.canEdit = false;
    if (mode === 'stored-edit')
      await f.db
        .update(f.schema.integrationAuthorizations)
        .set({ canEdit: false })
        .where(eq(f.schema.integrationAuthorizations.id, f.auth.id));
    if (mode === 'specific')
      await f.db
        .update(f.schema.integrationAuthorizations)
        .set({ accessMode: 'specific' })
        .where(eq(f.schema.integrationAuthorizations.id, f.auth.id));
    const response = await f.request('/templates/template', 'PATCH', {
      baseHash: initial.contentHash,
      expectedTitle: 'Feature',
      title: 'Forbidden',
    });
    expect(response.status).toBeGreaterThanOrEqual(403);
    expect((await f.stored()).title).toBe(before.title);
    expect(
      (await f.request('/templates/template/defaults', 'PUT', { expectedRevision: 0, tags: ['bad'] })).status
    ).toBeGreaterThanOrEqual(403);
    expect(await f.db.select().from(f.schema.templateDefaultState)).toEqual([]);
    expect(await f.db.select().from(f.schema.noteEvents)).toEqual([]);
  });
  it('supports create without edit, read-only inspection, exact scoped editing exceptions, and create ceilings', async () => {
    const f = await setup();
    f.credential.canEdit = false;
    expect((await f.request('/templates', 'POST', { folderId: 'other', title: 'Created', markdown: '' })).status).toBe(
      201
    );
    expect((await f.read()).status).toBe(200);
    expect((await f.update()).status).toBe(403);
    f.credential.canCreate = false;
    expect((await f.request('/templates', 'POST', { folderId: 'other', title: 'No', markdown: '' })).status).toBe(403);
    f.credential.canEdit = true;
    await f.db
      .update(f.schema.integrationAuthorizations)
      .set({ accessMode: 'specific' })
      .where(eq(f.schema.integrationAuthorizations.id, f.auth.id));
    await f.rule('other', 'exact');
    await f.db.update(f.schema.folders).set({ isAgentReadOnly: true }).where(eq(f.schema.folders.id, 'other'));
    expect((await f.update()).status).toBe(200);
    await f.db.update(f.schema.notes).set({ isApiEditable: false }).where(eq(f.schema.notes.id, 'template'));
    expect((await f.read()).status).toBe(200);
    expect((await f.update()).status).toBe(403);
  });
  it.each([
    'editor',
    'stranger',
    'anonymous',
  ])('rejects owner administration by %s, including note-only access', async (user) => {
    const f = await setup(user, true);
    if (user === 'stranger')
      await f.db.insert(f.schema.collaborationGrants).values({
        id: 'direct',
        ownerUserId: 'owner',
        granteeUserId: user,
        noteId: 'template',
        role: 'editor',
        createdByUserId: 'owner',
        createdAt: f.now,
        updatedAt: f.now,
      });
    for (const path of ['/templates/template', '/templates/template/settings', '/folders/other/template-library'])
      expect((await f.request(path)).status).toBe(user === 'anonymous' ? 401 : 404);
    expect((await f.request('/templates', 'POST', { folderId: 'board', title: 'No', markdown: '' })).status).toBe(
      user === 'anonymous' ? 401 : 404
    );
    expect((await f.request('/templates/template/defaults', 'PUT', { expectedRevision: 0, tags: [] })).status).toBe(
      user === 'anonymous' ? 401 : 404
    );
  });
});

describe('template library and scoped configuration', () => {
  it('retains the native 1000 active-assignment limit across scoped deltas without counting retained Trash', async () => {
    const f = await setup();
    await f.db.insert(f.schema.folders).values(
      Array.from({ length: 998 }, (_, i) => ({
        id: `limit-${i}`,
        title: 'Destination',
        userId: 'owner',
        createdAt: f.now,
        updatedAt: f.now,
      }))
    );
    await f.db.insert(f.schema.templateFolderAssignments).values(
      Array.from({ length: 998 }, (_, i) => ({
        id: `limit-assignment-${i}`,
        userId: 'owner',
        templateId: 'template',
        folderId: `limit-${i}`,
      }))
    );
    await f.db
      .update(f.schema.integrationAuthorizations)
      .set({ accessMode: 'specific' })
      .where(eq(f.schema.integrationAuthorizations.id, f.auth.id));
    await f.rule('other', 'exact');
    const settings = await f.state();
    expect(settings.assignments).toEqual([]);
    expect(
      (
        await f.request('/templates/template/folders/other', 'PUT', {
          assigned: true,
          snapshot: settings.membershipSnapshot,
        })
      ).status
    ).toBe(400);
    expect(await f.db.select().from(f.schema.templateFolderAssignments)).toHaveLength(1000);
    await f.db.update(f.schema.folders).set({ deletedAt: f.now }).where(eq(f.schema.folders.id, 'limit-0'));
    expect(
      (
        await f.request('/templates/template/folders/other', 'PUT', {
          assigned: true,
          snapshot: (await f.state()).membershipSnapshot,
        })
      ).status
    ).toBe(200);
    expect(await f.db.select().from(f.schema.templateFolderAssignments)).toHaveLength(1001);
  });
  it('requires destination read as well as edit and hides private destination defaults', async () => {
    const f = await setup(),
      settings = await f.state(),
      a = settings.assignments.find((a) => a.folderId === 'board');
    await f.db
      .update(f.schema.integrationAuthorizations)
      .set({ accessMode: 'specific' })
      .where(eq(f.schema.integrationAuthorizations.id, f.auth.id));
    await f.rule('other', 'exact');
    await f.rule('board', 'exact', { canRead: false });
    expect((await f.state()).assignments).toEqual([]);
    expect(
      (
        await f.request('/templates/template/folders/board/defaults', 'PUT', {
          assignmentId: a.id,
          expectedRevision: 0,
          schemaId: null,
          schemaRevision: 0,
          values: {},
        })
      ).status
    ).toBe(403);
    expect(
      (
        await f.request('/templates/template/folders/board', 'PUT', {
          assigned: false,
          snapshot: settings.membershipSnapshot,
        })
      ).status
    ).toBe(403);
    await f.db
      .update(f.schema.authorizationFolderRules)
      .set({ canRead: true })
      .where(eq(f.schema.authorizationFolderRules.folderId, 'board'));
    await f.db.update(f.schema.folders).set({ isPrivate: true }).where(eq(f.schema.folders.id, 'board'));
    expect((await f.state()).assignments).toEqual([]);
    expect(
      (
        await f.request('/templates/template/folders/board', 'PUT', {
          assigned: false,
          snapshot: settings.membershipSnapshot,
        })
      ).status
    ).toBe(403);
    expect(await f.db.select().from(f.schema.templateFolderAssignments)).toHaveLength(2);
  });
  it('provides compact exact-folder keyset pages with separate folder/actor/kind cursor namespaces', async () => {
    const f = await setup();
    for (const id of ['a', 'b', 'c']) await f.addNote(id, 'Same', [], { folderId: 'other', type: 'template' });
    await f.addNote('ordinary', 'Same', [], { folderId: 'other' });
    await f.addNote('nested', 'Same', [], { folderId: 'child', type: 'template' });
    const first = await (await f.request('/folders/other/template-library?limit=2')).json();
    expect(first.templates.map((t) => t.id)).toEqual(['template', 'a']);
    expect(JSON.stringify(first)).not.toMatch(/body|content|actorId|userId/);
    const cursor = encodeURIComponent(first.pageInfo.nextCursor);
    expect(
      (await (await f.request(`/folders/other/template-library?limit=2&cursor=${cursor}`)).json()).templates.map(
        (t) => t.id
      )
    ).toEqual(['b', 'c']);
    expect((await f.request(`/folders/board/template-library?cursor=${cursor}`)).status).toBe(400);
    expect((await f.request(`/folders/other/notes?cursor=${cursor}`)).status).toBe(400);
    f.credential.id = 'different';
    expect((await f.request(`/folders/other/template-library?cursor=${cursor}`)).status).toBe(400);
    expect((await f.request('/folders/other/template-library?cursor=bad')).status).toBe(400);
    expect((await f.request('/folders/other/template-library?limit=1&limit=2')).status).toBe(400);
    expect((await f.request('/folders/other/template-library?q=Same')).status).toBe(400);
    expect((await (await f.request('/folders/board/template-library')).json()).templates).toEqual([]);
  });
  it('returns only readable destinations; delta changes preserve hidden/private/trashed assignments and defaults', async () => {
    const f = await setup();
    await f.templates.saveTemplateMembership(f.actor, 'template', { folderIds: ['board', 'child', 'root'] });
    const s = await f.addField('Keep', 'text', [], 'child');
    const a = (await f.state()).assignments.find((a) => a.folderId === 'child');
    await f.templates.saveAssignmentDefaults(f.actor, 'template', 'child', {
      assignmentId: a.id,
      expectedRevision: 0,
      schemaId: s.schemaId,
      schemaRevision: s.revision,
      values: { [s.definitions[0].id]: 'Preserve me' },
    });
    const rows = await f.db.select().from(f.schema.templateFolderAssignments);
    await f.db
      .update(f.schema.integrationAuthorizations)
      .set({ accessMode: 'specific' })
      .where(eq(f.schema.integrationAuthorizations.id, f.auth.id));
    await f.rule('other', 'exact');
    await f.rule('board', 'exact');
    const visible = await f.state();
    expect(visible.assignments.map((a) => a.folderId)).toEqual(['board']);
    expect(JSON.stringify(visible)).not.toMatch(/Preserve me|Child|"child"|"root"/);
    expect(
      (
        await f.request('/templates/template/folders/root', 'PUT', {
          assigned: false,
          snapshot: visible.membershipSnapshot,
        })
      ).status
    ).toBe(403);
    const removed = await f.request('/templates/template/folders/board', 'PUT', {
      assigned: false,
      snapshot: visible.membershipSnapshot,
    });
    expect(removed.status).toBe(200);
    expect(await f.db.select().from(f.schema.templateFolderAssignments)).toEqual(
      rows.filter((r) => r.folderId !== 'board')
    );
    expect(
      (
        await f.request('/templates/template/folders/board', 'PUT', {
          assigned: true,
          snapshot: visible.membershipSnapshot,
        })
      ).status
    ).toBe(409);
    const next = await f.state();
    expect(
      (
        await f.request('/templates/template/folders/board', 'PUT', {
          assigned: true,
          snapshot: next.membershipSnapshot,
        })
      ).status
    ).toBe(200);
    await f.db.update(f.schema.folders).set({ deletedAt: f.now }).where(eq(f.schema.folders.id, 'child'));
    const retained = await f.db.select().from(f.schema.templateFolderAssignments);
    expect(
      (
        await f.request('/templates/template/folders/board', 'PUT', {
          assigned: false,
          snapshot: (await f.state()).membershipSnapshot,
        })
      ).status
    ).toBe(200);
    expect(await f.db.select().from(f.schema.templateFolderAssignments)).toEqual(
      retained.filter((r) => r.folderId !== 'board')
    );
  });
  it('saves explicit tags and schema-specific defaults with independent revisions, invalidates previews and preserves native creation', async () => {
    const f = await setup(),
      schema = await f.addField(),
      field = schema.definitions[0];
    const settings = await f.state(),
      assignment = settings.assignments.find((a) => a.folderId === 'board');
    const preview = await (await f.request('/folders/board/templates/template/preview')).json();
    expect(
      (
        await f.request('/templates/template/defaults', 'PUT', {
          expectedRevision: settings.revision,
          tags: ['# Feature'],
        })
      ).status
    ).toBe(200);
    expect(
      (await f.request('/templates/template/defaults', 'PUT', { expectedRevision: settings.revision, tags: [] })).status
    ).toBe(409);
    const payload = {
      assignmentId: assignment.id,
      expectedRevision: assignment.revision,
      schemaId: schema.schemaId,
      schemaRevision: schema.revision,
      values: { [field.id]: field.options[0].id },
    };
    const url = '/templates/template/folders/board/defaults';
    expect((await f.request(url, 'PUT', { ...payload, values: { Status: 'Todo' } })).status).toBe(400);
    expect((await f.request(url, 'PUT', { ...payload, assignmentId: 'foreign' })).status).toBe(409);
    expect((await f.request(url, 'PUT', { ...payload, schemaRevision: 0 })).status).toBe(409);
    expect((await f.request(url, 'PUT', payload)).status).toBe(200);
    expect((await f.request(url, 'PUT', payload)).status).toBe(409);
    const creation = {
      folderId: 'board',
      templateId: 'template',
      snapshot: preview.snapshot,
      schemaId: schema.schemaId,
      schemaRevision: schema.revision,
      title: 'Final',
      tags: ['feature'],
      values: payload.values,
      requestId: 'new-instance',
      variables: { date: 'DATE', time: 'TIME', datetime: 'DT' },
    };
    expect((await f.request('/notes/from-template', 'POST', creation)).status).toBe(409);
    const fresh = await (await f.request('/folders/board/templates/template/preview')).json();
    expect(fresh).toMatchObject({ tags: ['feature'], values: payload.values });
    const instance = await f.request('/notes/from-template', 'POST', { ...creation, snapshot: fresh.snapshot });
    expect(instance.status).toBe(201);
    const id = (await instance.json()).note.id;
    expect((await f.properties.readNoteProperties(f.actor, id)).values).toEqual(payload.values);
    expect((await f.db.select().from(f.schema.notes).where(eq(f.schema.notes.id, id)))[0].content).toContain(
      'Final DATE TIME DT'
    );
    const before = await f.stored();
    expect(before.title).toBe('Feature');
    const noEdit = await f.request('/templates/template/folders/foreign', 'PUT', {
      assigned: true,
      snapshot: (await f.state()).membershipSnapshot,
    });
    expect(noEdit.status).toBe(404);
    await f.db.update(f.schema.folders).set({ isAgentReadOnly: true }).where(eq(f.schema.folders.id, 'board'));
    expect((await f.request(url, 'PUT', { ...payload, expectedRevision: 1 })).status).toBe(403);
    expect(
      (
        await f.request('/templates/template/folders/board', 'PUT', {
          assigned: false,
          snapshot: (await f.state()).membershipSnapshot,
        })
      ).status
    ).toBe(403);
  });
});
