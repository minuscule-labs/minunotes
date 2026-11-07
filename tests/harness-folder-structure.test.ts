import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupBoardTests, setupBoardTest } from './board-fixtures';

afterEach(cleanupBoardTests);
async function setup(actor = 'owner', oauth = false) {
  const f = await setupBoardTest(44);
  const auth = {
    id: 'folder-auth',
    userId: actor,
    accessMode: 'all' as const,
    sharedAccessMode: 'all' as const,
    canRead: true,
    canEdit: true,
    canCreate: true,
    canComment: false,
    canCreateFolders: true,
    createdAt: f.now,
    updatedAt: f.now,
  };
  await f.db.insert(f.schema.integrationAuthorizations).values(auth);
  const credential = {
    ...auth,
    id: 'key',
    authorizationId: auth.id,
    integrationAuthorizationId: auth.id,
    name: 'Test',
    uid: 'TESTTEST',
    hash: 'test',
    salt: 'test',
    clientId: 'client',
    scope: 'notes.read notes.edit notes.create folders.create',
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: actor });
    c.set('session', null);
    c.set('apiKey', oauth ? null : credential);
    c.set('oauthAuthorization', oauth ? credential : null);
    await next();
  });
  app.route('/harness', (await import('../src/api/routes/harness')).harnessRoutes);
  const request = (path: string, body?: unknown) =>
    app.request(
      `/harness/folders/${path}`,
      body === undefined
        ? {}
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    );
  const preview = async (parent: string | null = null) =>
    await request(`board/duplicate-preview${parent ? `?parentFolderId=${parent}` : ''}`);
  const copy = (token: string, extra = {}) =>
    request('board/duplicate', {
      title: 'Copy',
      parentFolderId: null,
      requestId: 'copy_request_1234',
      previewToken: token,
      ...extra,
    });
  const stored = async () => (await f.db.select().from(f.schema.folders).where(eq(f.schema.folders.id, 'board')))[0];
  const rule = async (folderId: string, appliesTo: 'exact' | 'subtree' = 'subtree', extra = {}) =>
    f.db.insert(f.schema.authorizationFolderRules).values({
      id: `rule-${folderId}`,
      authorizationId: auth.id,
      userId: actor,
      folderId,
      appliesTo,
      canRead: true,
      canEdit: true,
      canCreate: true,
      canComment: false,
      canCreateFolders: true,
      ...extra,
    });
  return { ...f, auth, credential, request, preview, copy, stored, rule };
}

describe('owner-scoped folder structure Harness', () => {
  it('masks inaccessible parent context and checks scope before revealing destination hierarchy', async () => {
    const f = await setup();
    await f.db
      .update(f.schema.integrationAuthorizations)
      .set({ accessMode: 'specific' })
      .where(eq(f.schema.integrationAuthorizations.id, f.auth.id));
    await f.rule('board', 'exact');
    const renamed = await f.request('board/rename', { title: 'Renamed', expectedTitle: 'Board' });
    expect(renamed.status).toBe(200);
    const result = await renamed.json();
    expect(result).toMatchObject({ parentContext: 'unavailable', folder: { parentFolderId: null } });
    expect(JSON.stringify(result)).not.toContain('"root"');
    const moved = await f.request('board/move', {
      parentFolderId: 'child',
      expectedParentFolderId: 'root',
      confirm: true,
    });
    expect(moved.status).toBe(403);
    expect((await moved.json()).error).not.toMatch(/descendant|private/);
  });
  it.each([
    false,
    true,
  ])('renames/moves with exact metadata preconditions and preserves subtree identities (OAuth=%s)', async (oauth) => {
    const f = await setup('owner', oauth);
    await f.addNote('n', 'Task', [], { isApiEditable: true });
    const before = await f.db.select().from(f.schema.notes);
    expect((await f.request('board/rename', { title: ' Renamed ', expectedTitle: 'Board' })).status).toBe(200);
    expect((await f.request('board/rename', { title: 'Overwrite', expectedTitle: 'Board' })).status).toBe(409);
    expect(
      (await f.request('board/move', { parentFolderId: 'other', expectedParentFolderId: 'root', confirm: true })).status
    ).toBe(200);
    expect(await f.stored()).toMatchObject({ id: 'board', title: 'Renamed', parentFolderId: 'other' });
    expect(await f.db.select().from(f.schema.notes)).toEqual(before);
    expect((await f.db.select().from(f.schema.folders).where(eq(f.schema.folders.id, 'child')))[0].parentFolderId).toBe(
      'board'
    );
    expect(
      (await f.request('board/move', { parentFolderId: null, expectedParentFolderId: 'root', confirm: true })).status
    ).toBe(409);
    expect(
      (await f.request('board/move', { parentFolderId: null, expectedParentFolderId: 'other', confirm: true })).status
    ).toBe(200);
  });
  it('rejects unconfirmed/invalid updates, cycles and unsupported destinations without changing source', async () => {
    const f = await setup();
    for (const body of [
      { title: 'New' },
      { title: ' ', expectedTitle: 'Board' },
      { title: 'x'.repeat(201), expectedTitle: 'Board' },
      { title: 'New', expectedTitle: 'Board', isPrivate: false },
    ])
      expect((await f.request('board/rename', body)).status).toBe(400);
    for (const body of [
      { parentFolderId: 'other', expectedParentFolderId: 'root' },
      { parentFolderId: 'other', confirm: true },
      { parentFolderId: 'child', expectedParentFolderId: 'root', confirm: true },
      { parentFolderId: 'board', expectedParentFolderId: 'root', confirm: true },
    ])
      expect((await f.request('board/move', body)).status).toBe(400);
    expect(
      (await f.request('board/move', { parentFolderId: 'foreign', expectedParentFolderId: 'root', confirm: true }))
        .status
    ).toBeGreaterThanOrEqual(403);
    expect((await f.stored()).parentFolderId).toBe('root');
  });
  it('serializes conflicting title updates and denies all shared-owner structure operations', async () => {
    const f = await setup();
    const updates = await Promise.all(
      ['One', 'Two'].map((title) => f.request('board/rename', { title, expectedTitle: 'Board' }))
    );
    expect(updates.map((r) => r.status).sort()).toEqual([200, 409]);
    const editor = await setup('editor');
    expect((await editor.request('board/rename', { title: 'New', expectedTitle: 'Board' })).status).toBe(404);
    expect((await editor.preview()).status).toBe(404);
  });
  it.each([
    'private-child',
    'readonly-child',
    'uneditable-note',
    'denied-child',
    'no-folder-capability',
    'readonly-destination',
    'private-destination',
    'revoked',
  ])('denies moving an affected subtree after %s', async (policy) => {
    const f = await setup();
    if (policy === 'private-child')
      await f.db.update(f.schema.folders).set({ isPrivate: true }).where(eq(f.schema.folders.id, 'child'));
    if (policy === 'readonly-child')
      await f.db.update(f.schema.folders).set({ isAgentReadOnly: true }).where(eq(f.schema.folders.id, 'child'));
    if (policy === 'uneditable-note') await f.addNote('n', 'Protected', [], { isApiEditable: false });
    if (policy === 'denied-child') await f.rule('child', 'exact', { canEdit: false });
    if (policy === 'no-folder-capability') f.credential.canCreateFolders = false;
    if (policy === 'readonly-destination')
      await f.db.update(f.schema.folders).set({ isAgentReadOnly: true }).where(eq(f.schema.folders.id, 'other'));
    if (policy === 'private-destination')
      await f.db.update(f.schema.folders).set({ isPrivate: true }).where(eq(f.schema.folders.id, 'other'));
    if (policy === 'revoked')
      await f.db
        .update(f.schema.integrationAuthorizations)
        .set({ revokedAt: f.now })
        .where(eq(f.schema.integrationAuthorizations.id, f.auth.id));
    expect(
      (await f.request('board/move', { parentFolderId: 'other', expectedParentFolderId: 'root', confirm: true })).status
    ).toBeGreaterThanOrEqual(403);
    expect((await f.stored()).parentFolderId).toBe('root');
  });
  it('never strips inherited read-only protection even when exact scoped exceptions permit editing', async () => {
    const f = await setup();
    await f.db
      .update(f.schema.integrationAuthorizations)
      .set({ accessMode: 'specific' })
      .where(eq(f.schema.integrationAuthorizations.id, f.auth.id));
    await f.db.update(f.schema.folders).set({ isAgentReadOnly: true }).where(eq(f.schema.folders.id, 'root'));
    await f.rule('board', 'exact');
    await f.rule('child', 'exact');
    await f.rule('other');
    const response = await f.request('board/move', {
      parentFolderId: 'other',
      expectedParentFolderId: 'root',
      confirm: true,
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain('inherited');
    expect((await f.stored()).parentFolderId).toBe('root');
  });
  it('rolls back moves that would leave current scope, and rejects restricted Root/exact-only copy destinations', async () => {
    const f = await setup();
    await f.db
      .update(f.schema.integrationAuthorizations)
      .set({ accessMode: 'specific' })
      .where(eq(f.schema.integrationAuthorizations.id, f.auth.id));
    await f.rule('root');
    await f.rule('other', 'exact');
    expect(
      (await f.request('board/move', { parentFolderId: 'other', expectedParentFolderId: 'root', confirm: true })).status
    ).toBe(403);
    expect((await f.stored()).parentFolderId).toBe('root');
    expect((await f.preview()).status).toBe(403);
    expect((await f.preview('other')).status).toBe(403);
    const p = await f.preview('root');
    expect(p.status).toBe(200);
    expect((await f.copy((await p.json()).token, { parentFolderId: 'root' })).status).toBe(201);
    expect(await f.db.select().from(f.schema.authorizationFolderRules)).toHaveLength(2);
  });
});

describe('reviewed authorized folder copying', () => {
  it('does not expose a copied root new parent outside current scope when replaying a completed receipt', async () => {
    const f = await setup();
    const p = await (await f.preview('root')).json();
    const made = await f.copy(p.token, { parentFolderId: 'root' });
    const id = (await made.json()).folder.id;
    await f.db.update(f.schema.folders).set({ parentFolderId: 'other' }).where(eq(f.schema.folders.id, id));
    await f.db
      .update(f.schema.integrationAuthorizations)
      .set({ accessMode: 'specific' })
      .where(eq(f.schema.integrationAuthorizations.id, f.auth.id));
    await f.rule('root');
    await f.rule(id);
    const replay = await f.copy(p.token, { parentFolderId: 'root' });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      replayed: true,
      parentContext: 'unavailable',
      folder: { id, parentFolderId: null },
    });
  });
  it('previews without writes, creates once, attributes to the agent and replays without newer previews', async () => {
    const f = await setup();
    await f.addNote('n', 'Task', ['retained'], { isApiEditable: false });
    const before = await f.db.select().from(f.schema.folders);
    f.credential.canEdit = false;
    const p = await f.preview();
    expect(p.status).toBe(200);
    const reviewed = await p.json();
    expect(reviewed.counts).toMatchObject({ folders: 2, notes: 1 });
    expect(await f.db.select().from(f.schema.folders)).toEqual(before);
    const first = await f.copy(reviewed.token);
    expect(first.status).toBe(201);
    const result = await first.json();
    const cloned = (await f.db.select().from(f.schema.notes)).find((n) => n.id !== 'n');
    expect(cloned).toMatchObject({
      folderId: result.folder.id,
      isApiEditable: false,
      updatedByActorType: 'agent',
      updatedByActorId: 'key',
    });
    const second = await f.copy(reviewed.token);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ replayed: true, folder: { id: result.folder.id } });
    f.credential.id = 'different-connection';
    expect((await f.copy(reviewed.token)).status).toBe(409);
    expect(await f.db.select().from(f.schema.folderDuplicationRequests)).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/userId|actorId|storageKey/);
  });
  it('rejects stale/missing review and revocation on replay without producing replacement copies', async () => {
    const f = await setup();
    expect(
      (await f.request('board/duplicate', { title: 'Copy', parentFolderId: null, requestId: 'copy_request_1234' }))
        .status
    ).toBe(428);
    const p = await (await f.preview()).json();
    await f.db.update(f.schema.folders).set({ title: 'Changed' }).where(eq(f.schema.folders.id, 'board'));
    expect((await f.copy(p.token)).status).toBe(409);
    const current = await (await f.preview()).json();
    expect((await f.copy(current.token)).status).toBe(201);
    await f.db
      .update(f.schema.integrationAuthorizations)
      .set({ revokedAt: f.now })
      .where(eq(f.schema.integrationAuthorizations.id, f.auth.id));
    expect((await f.copy(current.token)).status).toBe(403);
    expect(await f.db.select().from(f.schema.folderDuplicationRequests)).toHaveLength(1);
  });
  it.each([
    'private-child',
    'trashed-source',
    'no-read',
    'no-create',
    'no-folder-create',
    'denied-child',
    'private-template',
  ])('rejects inaccessible copy input after %s', async (policy) => {
    const f = await setup();
    if (policy === 'private-child')
      await f.db.update(f.schema.folders).set({ isPrivate: true }).where(eq(f.schema.folders.id, 'child'));
    if (policy === 'trashed-source')
      await f.db.update(f.schema.folders).set({ deletedAt: f.now }).where(eq(f.schema.folders.id, 'root'));
    if (policy === 'no-read') f.credential.canRead = false;
    if (policy === 'no-create') f.credential.canCreate = false;
    if (policy === 'no-folder-create') f.credential.canCreateFolders = false;
    if (policy === 'denied-child') await f.rule('child', 'exact', { canRead: false });
    if (policy === 'private-template') {
      await f.addNote('template', 'Private template', [], { type: 'template', folderId: 'other' });
      await f.db
        .insert(f.schema.templateFolderAssignments)
        .values({ id: 'a', userId: 'owner', templateId: 'template', folderId: 'board' });
      await f.db.update(f.schema.folders).set({ isPrivate: true }).where(eq(f.schema.folders.id, 'other'));
    }
    expect((await f.preview()).status).toBeGreaterThanOrEqual(403);
    expect(await f.db.select().from(f.schema.folderDuplicationRequests)).toHaveLength(0);
  });
  it('preserves read-only protections and does not pin hidden external title targets into copied bodies', async () => {
    const f = await setup();
    await f.addNote('n', 'Source', [], { content: '[[Secret]]' });
    await f.addNote('note_secret', 'Secret', [], { folderId: 'other' });
    await f.db.update(f.schema.folders).set({ isAgentReadOnly: true }).where(eq(f.schema.folders.id, 'board'));
    await f.db.update(f.schema.folders).set({ isPrivate: true }).where(eq(f.schema.folders.id, 'other'));
    const p = await f.preview();
    expect(p.status).toBe(200);
    const result = await f.copy((await p.json()).token);
    expect(result.status).toBe(201);
    const id = (await result.json()).folder.id;
    expect((await f.db.select().from(f.schema.folders).where(eq(f.schema.folders.id, id)))[0].isAgentReadOnly).toBe(
      true
    );
    const copied = (await f.db.select().from(f.schema.notes)).find((n) => n.folderId === id);
    expect(copied?.content).toBe('[[Secret]]');
  });
});
