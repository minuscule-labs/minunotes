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

async function setupHarnessApp(input: {
  canCreateFolders: boolean;
  canComment?: boolean;
  accessMode?: 'all' | 'top_level' | 'specific';
  authentication?: 'apiKey' | 'oauth';
}) {
  vi.resetModules();
  const dir = await mkdtemp(path.join(tmpdir(), 'notes-harness-folders-'));
  tempDirs.push(dir);
  vi.stubEnv('TURSO_DB_URL', `file:${path.join(dir, 'test.db')}`);

  const [{ db, libsql }, schema, { harnessRoutes }] = await Promise.all([
    import('../src/api/db/client'),
    import('../src/api/db/schema'),
    import('../src/api/routes/harness'),
  ]);

  await runMigrations(libsql);

  const user = {
    id: 'user_test',
    name: 'Test User',
    email: 'test@example.com',
    emailVerified: true,
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const authorization = {
    id: 'agent_key_test',
    userId: user.id,
    canCreateFolders: input.canCreateFolders,
    canRead: true,
    canCreate: true,
    canEdit: true,
    canComment: input.canComment ?? false,
    accessMode: input.accessMode ?? ('specific' as const),
    createdAt: new Date(),
    updatedAt: new Date(),
    lastUsedAt: null,
    revokedAt: null,
  };

  const apiKey = {
    ...authorization,
    authorizationId: authorization.id,
    name: 'Test key',
    uid: 'ABCDEFGH',
    hash: 'hash',
    salt: 'salt',
  };

  await db.insert(schema.user).values(user);
  await db.insert(schema.integrationAuthorizations).values(authorization);
  await db.insert(schema.apiKeys).values(apiKey);

  const oauthAuthorization = {
    ...authorization,
    id: 'oauth_auth_test',
    integrationAuthorizationId: authorization.id,
    clientId: 'oauth_client_test',
    scope: 'notes.read notes.create folders.create',
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', user);
    c.set('session', null);
    c.set('apiKey', input.authentication === 'oauth' ? null : apiKey);
    c.set('oauthAuthorization', input.authentication === 'oauth' ? oauthAuthorization : null);
    await next();
  });
  app.route('/api/harness', harnessRoutes);

  return { app, db, libsql, schema, apiKey };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function folderRow(id: string, title: string, parentFolderId: string | null = null, extras = {}) {
  return {
    id,
    userId: 'user_test',
    parentFolderId,
    title,
    isPrivate: false,
    isAgentReadOnly: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extras,
  };
}

function noteRow(id: string, folderId: string, title: string, extras = {}) {
  return {
    id,
    userId: 'user_test',
    folderId,
    title,
    content: `${title} content`,
    documentType: 'markdown' as const,
    type: 'note' as const,
    isApiEditable: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extras,
  };
}

function permissionRow(authorizationId: string, folderId: string, extras = {}) {
  return {
    id: `auth_rule_${folderId}`,
    authorizationId,
    userId: 'user_test',
    folderId,
    canRead: true,
    canCreate: true,
    canEdit: true,
    canComment: false,
    canCreateFolders: false,
    appliesTo: 'exact' as const,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extras,
  };
}

describe('agent-created folder access', () => {
  it('does not let edit permission imply Review comments permission', async () => {
    const { app, db, schema } = await setupHarnessApp({
      canCreateFolders: false,
      canComment: false,
      accessMode: 'all',
    });
    await db.insert(schema.folders).values(folderRow('folder_review_denied', 'Review denied'));
    await db.insert(schema.notes).values(noteRow('note_review_denied', 'folder_review_denied', 'Review denied'));

    const response = await app.request('/api/harness/notes/note_review_denied/comments');
    expect(response.status).toBe(403);
  });

  it('allows explicit Review comments permission without relying on editability', async () => {
    const { app, db, schema } = await setupHarnessApp({
      canCreateFolders: false,
      canComment: true,
      accessMode: 'all',
    });
    await db.insert(schema.folders).values(folderRow('folder_review_allowed', 'Review allowed'));
    await db
      .insert(schema.notes)
      .values(noteRow('note_review_allowed', 'folder_review_allowed', 'Review allowed', { isApiEditable: false }));

    const response = await app.request('/api/harness/notes/note_review_allowed/comments');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ noteId: 'note_review_allowed', threads: [] });
  });

  it('rejects API keys without folder creation permission', async () => {
    const { app } = await setupHarnessApp({ canCreateFolders: false });

    const response = await app.request('/api/harness/folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Agent Workspace' }),
    });

    expect(response.status).toBe(403);
  });

  it('rejects OAuth subfolder creation outside the authorized parent scope', async () => {
    const { app, db, schema, apiKey } = await setupHarnessApp({
      canCreateFolders: true,
      accessMode: 'specific',
      authentication: 'oauth',
    });
    await db
      .insert(schema.folders)
      .values([folderRow('folder_allowed', 'Allowed'), folderRow('folder_forbidden', 'Forbidden')]);
    await db
      .insert(schema.authorizationFolderRules)
      .values(permissionRow(apiKey.authorizationId, 'folder_allowed', { canCreateFolders: true }));

    const denied = await app.request('/api/harness/folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Unauthorized child', parentFolderId: 'folder_forbidden' }),
    });
    expect(denied.status).toBe(403);
    expect((await db.select().from(schema.folders)).map((folder) => folder.title)).not.toContain('Unauthorized child');

    const allowed = await app.request('/api/harness/folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Authorized child', parentFolderId: 'folder_allowed' }),
    });
    expect(allowed.status).toBe(201);
  });

  it('rolls back folder creation when its specific-scope grant fails', async () => {
    const { app, db, libsql, schema } = await setupHarnessApp({ canCreateFolders: true });
    await libsql.execute(`
      CREATE TRIGGER fail_created_folder_permission
      BEFORE INSERT ON authorization_folder_rules
      BEGIN
        SELECT RAISE(ABORT, 'forced permission insert failure');
      END
    `);

    const response = await app.request('/api/harness/folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Must roll back' }),
    });
    expect(response.status).toBe(500);
    expect(await db.select().from(schema.folders)).toEqual([]);
  });

  it('auto-grants scoped permissions for folders created by an allowed API key', async () => {
    const { app, db, schema, apiKey } = await setupHarnessApp({ canCreateFolders: true });

    const createFolderResponse = await app.request('/api/harness/folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Agent Workspace' }),
    });

    expect(createFolderResponse.status).toBe(201);
    const { folder } = (await createFolderResponse.json()) as { folder: { id: string; title: string } };
    expect(folder.title).toBe('Agent Workspace');

    const permissions = await db.select().from(schema.authorizationFolderRules);
    expect(permissions).toEqual([
      expect.objectContaining({
        authorizationId: apiKey.id,
        userId: apiKey.userId,
        folderId: folder.id,
        canRead: true,
        canCreate: true,
        canEdit: true,
      }),
    ]);

    const createNoteResponse = await app.request('/api/harness/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId: folder.id, title: 'Agent note', content: 'Created by agent' }),
    });

    expect(createNoteResponse.status).toBe(201);
    const { note } = (await createNoteResponse.json()) as {
      note: { folderId: string; title: string; content?: string };
    };
    expect(note).toEqual(expect.objectContaining({ folderId: folder.id, title: 'Agent note' }));
    expect(note.content).toBeUndefined();
  });

  it('allows all-access keys to read non-private folders but excludes private folders', async () => {
    const { app, db, schema } = await setupHarnessApp({ canCreateFolders: true, accessMode: 'all' });

    const publicFolder = {
      id: 'folder_public',
      userId: 'user_test',
      parentFolderId: null,
      title: 'Public',
      isPrivate: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const privateFolder = {
      id: 'folder_private',
      userId: 'user_test',
      parentFolderId: null,
      title: 'Private',
      isPrivate: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await db.insert(schema.folders).values([publicFolder, privateFolder]);

    const response = await app.request('/api/harness/folders');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { folders: Array<{ id: string }> };
    expect(body.folders.map((folder) => folder.id)).toContain(publicFolder.id);
    expect(body.folders.map((folder) => folder.id)).not.toContain(privateFolder.id);
  });

  it('uses per-folder rules to restrict a global key without reducing access elsewhere', async () => {
    const { app, db, schema, apiKey } = await setupHarnessApp({ canCreateFolders: false, accessMode: 'all' });
    await db
      .insert(schema.folders)
      .values([
        folderRow('folder_global_reference', 'Reference'),
        folderRow('folder_global_inbox', 'Inbox'),
        folderRow('folder_global_open', 'Open'),
      ]);
    await db
      .insert(schema.authorizationFolderRules)
      .values([
        permissionRow(apiKey.id, 'folder_global_reference', { canCreate: false, canEdit: false }),
        permissionRow(apiKey.id, 'folder_global_inbox', { canCreate: true, canEdit: false }),
      ]);

    const foldersResponse = await app.request('/api/harness/folders');
    const foldersBody = (await foldersResponse.json()) as { folders: Array<{ id: string }> };
    expect(foldersBody.folders.map((folder) => folder.id)).toEqual(
      expect.arrayContaining(['folder_global_reference', 'folder_global_inbox', 'folder_global_open'])
    );

    const create = (folderId: string) =>
      app.request('/api/harness/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folderId, title: 'Created' }),
      });
    expect((await create('folder_global_reference')).status).toBe(403);
    expect((await create('folder_global_inbox')).status).toBe(201);
    expect((await create('folder_global_open')).status).toBe(201);
  });

  it('allows global read access but blocks writes in read-only folders', async () => {
    const { app, db, schema } = await setupHarnessApp({ canCreateFolders: false, accessMode: 'all' });

    const folder = {
      id: 'folder_global_readonly',
      userId: 'user_test',
      parentFolderId: null,
      title: 'Read only',
      isPrivate: false,
      isAgentReadOnly: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await db.insert(schema.folders).values(folder);

    const foldersResponse = await app.request('/api/harness/folders');
    const foldersBody = (await foldersResponse.json()) as { folders: Array<{ id: string }> };
    expect(foldersBody.folders.map((item) => item.id)).toContain(folder.id);

    const createNoteResponse = await app.request('/api/harness/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId: folder.id, title: 'Blocked' }),
    });
    expect(createNoteResponse.status).toBe(403);
  });

  it('allows top-level project roots to read descendants but blocks writes in read-only folders', async () => {
    const { app, db, schema, apiKey } = await setupHarnessApp({ canCreateFolders: false, accessMode: 'top_level' });

    const parent = {
      id: 'folder_project',
      userId: 'user_test',
      parentFolderId: null,
      title: 'Project',
      isPrivate: false,
      isAgentReadOnly: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const child = {
      id: 'folder_child',
      userId: 'user_test',
      parentFolderId: parent.id,
      title: 'Child',
      isPrivate: false,
      isAgentReadOnly: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await db.insert(schema.folders).values([parent, child]);
    await db.insert(schema.authorizationFolderRules).values({
      id: 'agent_perm_project',
      authorizationId: apiKey.id,
      userId: apiKey.userId,
      folderId: parent.id,
      canRead: true,
      canCreate: true,
      canEdit: true,
      appliesTo: 'subtree',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const foldersResponse = await app.request('/api/harness/folders');
    const foldersBody = (await foldersResponse.json()) as { folders: Array<{ id: string }> };
    expect(foldersBody.folders.map((folder) => folder.id)).toContain(child.id);

    const createNoteResponse = await app.request('/api/harness/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId: child.id, title: 'Blocked' }),
    });
    expect(createNoteResponse.status).toBe(403);
  });

  it('allows specific folder grants to write in read-only folders', async () => {
    const { app, db, schema, apiKey } = await setupHarnessApp({ canCreateFolders: false, accessMode: 'specific' });

    const folder = {
      id: 'folder_specific',
      userId: 'user_test',
      parentFolderId: null,
      title: 'Specific',
      isPrivate: false,
      isAgentReadOnly: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await db.insert(schema.folders).values(folder);
    await db.insert(schema.authorizationFolderRules).values({
      id: 'agent_perm_specific',
      authorizationId: apiKey.id,
      userId: apiKey.userId,
      folderId: folder.id,
      canRead: true,
      canCreate: true,
      canEdit: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const createNoteResponse = await app.request('/api/harness/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId: folder.id, title: 'Allowed' }),
    });
    expect(createNoteResponse.status).toBe(201);
  });

  it('honors per-folder permission flags for specific access', async () => {
    const { app, db, schema, apiKey } = await setupHarnessApp({ canCreateFolders: false, accessMode: 'specific' });
    await db.insert(schema.folders).values(folderRow('folder_specific_readonly', 'Specific read only'));
    await db.insert(schema.authorizationFolderRules).values(
      permissionRow(apiKey.id, 'folder_specific_readonly', {
        canRead: true,
        canCreate: false,
        canEdit: false,
      })
    );
    await db.insert(schema.notes).values(noteRow('note_specific_readonly', 'folder_specific_readonly', 'Read only'));

    const read = await app.request('/api/harness/notes/note_specific_readonly');
    expect(read.status).toBe(200);

    const edit = await app.request('/api/harness/notes/note_specific_readonly/tags', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tags: ['blocked'] }),
    });
    expect(edit.status).toBe(403);
  });

  it('treats specific folder permissions as exact non-private folder access', async () => {
    const { app, db, schema, apiKey } = await setupHarnessApp({ canCreateFolders: false, accessMode: 'specific' });

    const parent = {
      id: 'folder_parent',
      userId: 'user_test',
      parentFolderId: null,
      title: 'Parent',
      isPrivate: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const child = {
      id: 'folder_child',
      userId: 'user_test',
      parentFolderId: parent.id,
      title: 'Child',
      isPrivate: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const privateChild = {
      id: 'folder_private_child',
      userId: 'user_test',
      parentFolderId: parent.id,
      title: 'Private child',
      isPrivate: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await db.insert(schema.folders).values([parent, child, privateChild]);
    await db.insert(schema.authorizationFolderRules).values([
      {
        id: 'agent_perm_parent',
        authorizationId: apiKey.id,
        userId: apiKey.userId,
        folderId: parent.id,
        canRead: true,
        canCreate: true,
        canEdit: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'agent_perm_private_child',
        authorizationId: apiKey.id,
        userId: apiKey.userId,
        folderId: privateChild.id,
        canRead: true,
        canCreate: true,
        canEdit: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const response = await app.request('/api/harness/folders');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { folders: Array<{ id: string }> };
    expect(body.folders.map((folder) => folder.id)).toContain(parent.id);
    expect(body.folders.map((folder) => folder.id)).not.toContain(child.id);
    expect(body.folders.map((folder) => folder.id)).not.toContain(privateChild.id);

    await db.insert(schema.authorizationFolderRules).values({
      id: 'agent_perm_child',
      authorizationId: apiKey.id,
      userId: apiKey.userId,
      folderId: child.id,
      canRead: true,
      canCreate: true,
      canEdit: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const explicitChildResponse = await app.request('/api/harness/folders');
    const explicitChildBody = (await explicitChildResponse.json()) as { folders: Array<{ id: string }> };
    expect(explicitChildBody.folders.map((folder) => folder.id)).toContain(child.id);
  });

  it('moves multiple notes with compact responses when source edit and target create are allowed', async () => {
    const { app, db, schema, apiKey } = await setupHarnessApp({ canCreateFolders: false, accessMode: 'specific' });
    await db
      .insert(schema.folders)
      .values([folderRow('folder_source', 'Source'), folderRow('folder_target', 'Target')]);
    await db
      .insert(schema.authorizationFolderRules)
      .values([permissionRow(apiKey.id, 'folder_source'), permissionRow(apiKey.id, 'folder_target')]);
    await db
      .insert(schema.notes)
      .values([noteRow('note_one', 'folder_source', 'One'), noteRow('note_two', 'folder_source', 'Two')]);

    const response = await app.request('/api/harness/notes/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ noteIds: ['note_one', 'note_two'], targetFolderId: 'folder_target' }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      targetFolderId: string;
      notes: Array<{ id: string; folderId: string; content?: string }>;
    };
    expect(body.targetFolderId).toBe('folder_target');
    expect(body.notes).toEqual([
      expect.objectContaining({ id: 'note_one', folderId: 'folder_target' }),
      expect.objectContaining({ id: 'note_two', folderId: 'folder_target' }),
    ]);
    expect(body.notes.some((note) => note.content !== undefined)).toBe(false);

    const rows = await db.select({ id: schema.notes.id, folderId: schema.notes.folderId }).from(schema.notes);
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: 'note_one', folderId: 'folder_target' },
        { id: 'note_two', folderId: 'folder_target' },
      ])
    );
    const events = await db.select().from(schema.noteEvents);
    expect(events.filter((event) => event.eventType === 'move')).toHaveLength(2);
  });

  it('does not move any notes when one source note is outside the editable scope', async () => {
    const { app, db, schema, apiKey } = await setupHarnessApp({ canCreateFolders: false, accessMode: 'specific' });
    await db
      .insert(schema.folders)
      .values([
        folderRow('folder_allowed', 'Allowed'),
        folderRow('folder_blocked', 'Blocked'),
        folderRow('folder_target', 'Target'),
      ]);
    await db
      .insert(schema.authorizationFolderRules)
      .values([permissionRow(apiKey.id, 'folder_allowed'), permissionRow(apiKey.id, 'folder_target')]);
    await db
      .insert(schema.notes)
      .values([
        noteRow('note_allowed', 'folder_allowed', 'Allowed'),
        noteRow('note_blocked', 'folder_blocked', 'Blocked'),
      ]);

    const response = await app.request('/api/harness/notes/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ noteIds: ['note_allowed', 'note_blocked'], targetFolderId: 'folder_target' }),
    });

    expect(response.status).toBe(403);
    const [allowed] = await db
      .select({ folderId: schema.notes.folderId })
      .from(schema.notes)
      .where(eq(schema.notes.id, 'note_allowed'));
    expect(allowed.folderId).toBe('folder_allowed');
  });

  it('blocks moving notes into inaccessible target folders', async () => {
    const { app, db, schema, apiKey } = await setupHarnessApp({ canCreateFolders: false, accessMode: 'specific' });
    await db
      .insert(schema.folders)
      .values([folderRow('folder_source', 'Source'), folderRow('folder_target', 'Target')]);
    await db.insert(schema.authorizationFolderRules).values(permissionRow(apiKey.id, 'folder_source'));
    await db.insert(schema.notes).values(noteRow('note_one', 'folder_source', 'One'));

    const response = await app.request('/api/harness/notes/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ noteIds: ['note_one'], targetFolderId: 'folder_target' }),
    });

    expect(response.status).toBe(403);
  });

  it('allows cross-root moves when both roots are granted', async () => {
    const { app, db, schema, apiKey } = await setupHarnessApp({ canCreateFolders: false, accessMode: 'top_level' });
    await db
      .insert(schema.folders)
      .values([
        folderRow('folder_root_a', 'Root A'),
        folderRow('folder_root_b', 'Root B'),
        folderRow('folder_child_a', 'Child A', 'folder_root_a'),
        folderRow('folder_child_b', 'Child B', 'folder_root_b'),
      ]);
    await db
      .insert(schema.authorizationFolderRules)
      .values([
        permissionRow(apiKey.id, 'folder_root_a', { appliesTo: 'subtree' }),
        permissionRow(apiKey.id, 'folder_root_b', { appliesTo: 'subtree' }),
      ]);
    await db.insert(schema.notes).values(noteRow('note_cross_root', 'folder_child_a', 'Cross root'));

    const response = await app.request('/api/harness/notes/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ noteIds: ['note_cross_root'], targetFolderId: 'folder_child_b' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      notes: [expect.objectContaining({ id: 'note_cross_root', folderId: 'folder_child_b' })],
    });
  });

  it('blocks moving notes into agent read-only targets for all-access keys', async () => {
    const { app, db, schema } = await setupHarnessApp({ canCreateFolders: false, accessMode: 'all' });
    await db
      .insert(schema.folders)
      .values([
        folderRow('folder_source', 'Source'),
        folderRow('folder_readonly', 'Read only', null, { isAgentReadOnly: true }),
      ]);
    await db.insert(schema.notes).values(noteRow('note_one', 'folder_source', 'One'));

    const response = await app.request('/api/harness/notes/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ noteIds: ['note_one'], targetFolderId: 'folder_readonly' }),
    });

    expect(response.status).toBe(403);
  });
});
