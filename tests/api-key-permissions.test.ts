import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { publicCollaborationAccessKey } from '../src/api/lib/collaboration-identity';

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
  const dir = await mkdtemp(path.join(tmpdir(), 'notes-api-key-permissions-'));
  tempDirs.push(dir);
  vi.stubEnv('TURSO_DB_URL', `file:${path.join(dir, 'test.db')}`);

  const [{ db, libsql }, schema, { apiKeyRoutes }] = await Promise.all([
    import('../src/api/db/client'),
    import('../src/api/db/schema'),
    import('../src/api/routes/api-keys'),
  ]);
  await runMigrations(libsql);

  const now = new Date();
  const user = {
    id: 'user_api_keys',
    name: 'API Key Owner',
    email: 'keys@example.com',
    emailVerified: true,
    image: null,
    createdAt: now,
    updatedAt: now,
  };
  const folder = {
    id: 'folder_api_keys',
    userId: user.id,
    parentFolderId: null,
    title: 'Review folder',
    isPrivate: false,
    isAgentReadOnly: false,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(schema.user).values(user);
  await db.insert(schema.folders).values(folder);

  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', user);
    c.set('session', null);
    c.set('apiKey', null);
    await next();
  });
  app.route('/api-keys', apiKeyRoutes);

  return { app, db, libsql, schema, folder, user, now };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('API key Review comments permission', () => {
  it('defaults Review comments permission to disabled and returns it from list responses', async () => {
    const { app } = await setupApp();
    const create = await app.request('/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Read only', canRead: true, canEdit: false, permissions: [] }),
    });

    expect(create.status).toBe(201);
    await expect(create.json()).resolves.toMatchObject({ apiKey: { canRead: true, canComment: false } });

    const list = await app.request('/api-keys');
    await expect(list.json()).resolves.toMatchObject({ keys: [{ canComment: false }] });
  });

  it('defaults shared access to none and manages specific collaboration selections', async () => {
    const { app, db, schema, user, now } = await setupApp();
    await db.insert(schema.user).values({
      id: 'shared_owner',
      name: 'Shared Owner',
      email: 'shared@example.com',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.folders).values({
      id: 'shared_folder',
      userId: 'shared_owner',
      parentFolderId: null,
      title: 'Shared',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.notes).values({
      id: 'shared_note',
      userId: 'shared_owner',
      folderId: 'shared_folder',
      title: 'Shared note',
      content: '',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.collaborationGrants).values({
      id: 'shared_grant',
      ownerUserId: 'shared_owner',
      granteeUserId: user.id,
      noteId: 'shared_note',
      folderId: null,
      role: 'viewer',
      createdByUserId: 'shared_owner',
      createdAt: now,
      updatedAt: now,
    });

    const defaultKey = await app.request('/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Default' }),
    });
    expect(defaultKey.status).toBe(201);
    const defaultBody = (await defaultKey.json()) as { apiKey: { id: string } };
    await expect(app.request('/api-keys').then((response) => response.json())).resolves.toMatchObject({
      keys: [expect.objectContaining({ sharedAccessMode: 'none', collaborationGrantIds: [] })],
    });

    const updated = await app.request(`/api-keys/${defaultBody.apiKey.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sharedAccessMode: 'specific',
        collaborationGrantIds: [publicCollaborationAccessKey('shared_grant')],
      }),
    });
    expect(updated.status).toBe(200);
    const updatedBody = await updated.json();
    expect(updatedBody).toMatchObject({
      apiKey: {
        sharedAccessMode: 'specific',
        collaborationGrantIds: [publicCollaborationAccessKey('shared_grant')],
      },
    });
    expect(JSON.stringify(updatedBody)).not.toContain('shared_grant');
    const listedSpecific = await app.request('/api-keys');
    expect(JSON.stringify(await listedSpecific.json())).not.toContain('shared_grant');
    expect(await db.select().from(schema.authorizationCollaborationScopes)).toHaveLength(1);

    const all = await app.request(`/api-keys/${defaultBody.apiKey.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sharedAccessMode: 'all' }),
    });
    expect(all.status).toBe(200);
    expect(await db.select().from(schema.authorizationCollaborationScopes)).toHaveLength(0);

    const emptySpecific = await app.request('/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Empty specific scope', sharedAccessMode: 'specific' }),
    });
    expect(emptySpecific.status).toBe(400);

    const invalid = await app.request('/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Invalid scope',
        sharedAccessMode: 'specific',
        collaborationGrantIds: ['missing_grant'],
      }),
    });
    expect(invalid.status).toBe(400);
  });

  it('stores folder restrictions beneath a global capability ceiling', async () => {
    const { app, db, schema, folder } = await setupApp();
    const create = await app.request('/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Global with restriction',
        accessMode: 'all',
        canRead: true,
        canCreate: true,
        canEdit: true,
        permissions: [{ folderId: folder.id, canRead: true, canCreate: false, canEdit: false }],
      }),
    });
    expect(create.status).toBe(201);
    const [key] = await db.select().from(schema.integrationAuthorizations);
    const [permission] = await db.select().from(schema.authorizationFolderRules);
    expect(key).toMatchObject({ accessMode: 'all', canRead: true, canCreate: true, canEdit: true });
    expect(permission).toMatchObject({ folderId: folder.id, canRead: true, canCreate: false, canEdit: false });
  });

  it('deduplicates folder grants and rolls back failed credential creation', async () => {
    const { app, db, libsql, schema, folder } = await setupApp();
    const create = await app.request('/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Deduplicated',
        accessMode: 'specific',
        permissions: [{ folderId: folder.id }, { folderId: folder.id }],
      }),
    });
    expect(create.status).toBe(201);
    const [permission] = await db.select().from(schema.authorizationFolderRules);
    expect(permission).toBeDefined();
    await expect(
      db.insert(schema.authorizationFolderRules).values({
        ...permission,
        id: 'auth_rule_duplicate',
      })
    ).rejects.toThrow();

    await libsql.execute(`
      CREATE TRIGGER fail_authorization_rule_insert
      BEFORE INSERT ON authorization_folder_rules
      BEGIN
        SELECT RAISE(ABORT, 'forced permission insert failure');
      END
    `);
    const failed = await app.request('/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Must roll back',
        accessMode: 'specific',
        permissions: [{ folderId: folder.id }],
      }),
    });
    expect(failed.status).toBe(500);
    const keys = await db.select().from(schema.apiKeys);
    expect(keys.map((key) => key.name)).not.toContain('Must roll back');
  });

  it('persists global and folder Review permission and requires read access', async () => {
    const { app, db, schema, folder } = await setupApp();
    const invalid = await app.request('/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Invalid reviewer', canRead: false, canComment: true, permissions: [] }),
    });
    expect(invalid.status).toBe(400);

    const create = await app.request('/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Reviewer',
        accessMode: 'specific',
        canRead: true,
        canEdit: false,
        canComment: true,
        permissions: [{ folderId: folder.id }],
      }),
    });
    expect(create.status).toBe(201);
    const body = (await create.json()) as { apiKey: { id: string } };

    const [key] = await db.select().from(schema.integrationAuthorizations);
    expect(key).toMatchObject({ canRead: true, canEdit: false, canComment: true });
    const [permission] = await db.select().from(schema.authorizationFolderRules);
    expect(permission).toMatchObject({ folderId: folder.id, canRead: true, canEdit: false, canComment: true });

    const invalidUpdate = await app.request(`/api-keys/${body.apiKey.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ canRead: false }),
    });
    expect(invalidUpdate.status).toBe(400);
  });
});
