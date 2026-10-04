import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { publicCollaborationAccessKey } from '../src/api/lib/collaboration-identity';

const tempDirs: string[] = [];

async function runMigrations(libsql: { executeMultiple: (sql: string) => Promise<unknown> }, through = 39, from = 0) {
  for (let index = from; index <= through; index += 1) {
    const [file] = await Array.fromAsync(
      (await import('node:fs/promises')).glob(`drizzle/${String(index).padStart(4, '0')}_*.sql`)
    );
    if (!file) throw new Error(`Missing migration ${index}`);
    await libsql.executeMultiple(await readFile(file, 'utf8'));
  }
}

function pkceChallenge(verifier: string) {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function setupApp() {
  vi.resetModules();
  const dir = await mkdtemp(path.join(tmpdir(), 'notes-oauth-'));
  tempDirs.push(dir);
  vi.stubEnv('TURSO_DB_URL', `file:${path.join(dir, 'test.db')}`);

  const [
    { db, libsql },
    schema,
    { oauthRoutes },
    { harnessRoutes },
    { harnessApiKeyAuthenticationMiddleware, mcpOAuthAuthenticationMiddleware },
    { hashOAuthToken },
  ] = await Promise.all([
    import('../src/api/db/client'),
    import('../src/api/db/schema'),
    import('../src/api/routes/oauth'),
    import('../src/api/routes/harness'),
    import('../src/api/middleware/authentication'),
    import('../src/api/lib/oauth'),
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
  await db.insert(schema.user).values(user);
  await db.insert(schema.oauthClients).values({
    id: 'client_a',
    name: 'Client A',
    description: 'Test client',
    redirectUris: JSON.stringify(['https://client.example/callback']),
    clientType: 'public',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', user);
    c.set('session', { id: 'session_user_a', userId: user.id });
    c.set('apiKey', null);
    await next();
  });
  app.route('/api/oauth', oauthRoutes);
  app.route('/oauth', oauthRoutes);

  const authApp = new Hono();
  authApp.use('/api/harness/*', harnessApiKeyAuthenticationMiddleware);
  authApp.route('/api/harness', harnessRoutes);

  const bearerApp = new Hono();
  bearerApp.use('*', mcpOAuthAuthenticationMiddleware);
  bearerApp.get('/', (c) => c.json({ authorization: c.get('oauthAuthorization') }));

  return { app, authApp, bearerApp, db, libsql, schema, user, hashOAuthToken };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('oauth foundations', () => {
  it('normalizes legacy OAuth scopes and project-root rule inheritance', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'notes-oauth-migration-'));
    tempDirs.push(dir);
    const client = createClient({ url: `file:${path.join(dir, 'test.db')}` });
    await runMigrations(client, 27);
    const now = Math.floor(Date.now() / 1000);
    await client.executeMultiple(`
      INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
      VALUES ('user_legacy', 'Legacy', 'legacy@example.com', 1, ${now}, ${now});
      INSERT INTO oauth_clients (id, name, redirect_uris, client_type, created_at, updated_at)
      VALUES ('client_legacy', 'Legacy client', '["https://client.example/callback"]', 'public', ${now}, ${now});
      INSERT INTO oauth_authorizations (
        id, user_id, client_id, scope, access_mode, can_read, can_create, can_edit,
        can_comment, can_create_folders, created_at, updated_at
      ) VALUES (
        'oauth_auth_legacy', 'user_legacy', 'client_legacy', 'notes', 'all', 1, 0, 1, 1, 1, ${now}, ${now}
      );
      INSERT INTO oauth_authorization_codes (
        id, code_hash, client_id, user_id, redirect_uri, scope, code_challenge,
        code_challenge_method, authorization_id, expires_at, created_at
      ) VALUES (
        'oauth_code_legacy', 'code_hash_legacy', 'client_legacy', 'user_legacy',
        'https://client.example/callback', 'notes', 'challenge', 'S256',
        'oauth_auth_legacy', ${now + 600}, ${now}
      );
      INSERT INTO oauth_tokens (
        id, authorization_id, access_token_hash, refresh_token_hash, scope,
        access_token_expires_at, refresh_token_expires_at, created_at, updated_at
      ) VALUES (
        'oauth_token_legacy', 'oauth_auth_legacy', 'access_hash_legacy', 'refresh_hash_legacy',
        'notes', ${now + 3600}, ${now + 7200}, ${now}, ${now}
      );
    `);
    await runMigrations(client, 28, 28);

    const expected = 'notes.read notes.edit comments.write folders.create';
    const authorization = await client.execute("SELECT scope FROM oauth_authorizations WHERE id = 'oauth_auth_legacy'");
    const code = await client.execute("SELECT scope FROM oauth_authorization_codes WHERE id = 'oauth_code_legacy'");
    const token = await client.execute("SELECT scope FROM oauth_tokens WHERE id = 'oauth_token_legacy'");
    expect(authorization.rows[0]?.scope).toBe(expected);
    expect(code.rows[0]?.scope).toBe(expected);
    expect(token.rows[0]?.scope).toBe(expected);

    await runMigrations(client, 29, 29);
    await client.executeMultiple(`
      INSERT INTO folders (id, user_id, parent_folder_id, title, is_private, is_agent_read_only, created_at, updated_at)
      VALUES ('folder_project_root', 'user_legacy', NULL, 'Project root', 0, 0, ${now}, ${now});
      UPDATE oauth_authorizations SET access_mode = 'top_level' WHERE id = 'oauth_auth_legacy';
      INSERT INTO oauth_authorization_folder_permissions (
        id, authorization_id, folder_id, can_read, can_create, can_edit, can_comment, created_at, updated_at
      ) VALUES (
        'oauth_perm_legacy', 'oauth_auth_legacy', 'folder_project_root', 1, 0, 0, 0, ${now}, ${now}
      );
    `);
    await runMigrations(client, 30, 30);
    const permission = await client.execute(
      "SELECT applies_to FROM oauth_authorization_folder_permissions WHERE id = 'oauth_perm_legacy'"
    );
    expect(permission.rows[0]?.applies_to).toBe('subtree');
    client.close();
  });

  it('creates and revokes user-owned OAuth apps', async () => {
    const { app } = await setupApp();

    const create = await app.request('/api/oauth/clients', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Test OAuth App',
        description: 'Created in test',
        redirectUris: ['https://client.example/callback'],
      }),
    });
    expect(create.status).toBe(201);
    const createBody = (await create.json()) as {
      client: { id: string; name: string; userId: string; redirectUris: string };
    };
    expect(createBody.client.name).toBe('Test OAuth App');
    expect(JSON.parse(createBody.client.redirectUris)).toEqual(['https://client.example/callback']);

    const list = await app.request('/api/oauth/clients');
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      clients: [{ id: createBody.client.id, name: 'Test OAuth App' }],
    });

    const revoke = await app.request(`/api/oauth/clients/${createBody.client.id}`, { method: 'DELETE' });
    expect(revoke.status).toBe(200);
  }, 10_000);

  it('dynamically registers public OAuth clients', async () => {
    const { app } = await setupApp();

    const response = await app.request('/api/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'ChatGPT Connector',
        redirect_uris: ['https://chatgpt.com/connector/oauth/abc123'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      client_id: string;
      redirect_uris: string[];
      token_endpoint_auth_method: string;
      grant_types: string[];
      response_types: string[];
    };
    expect(body.client_id).toMatch(/^oauth_client_/);
    expect(body.redirect_uris).toEqual(['https://chatgpt.com/connector/oauth/abc123']);
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.grant_types).toContain('authorization_code');
    expect(body.response_types).toContain('code');
  });

  it('rejects unsupported dynamic client redirect hosts', async () => {
    const { app } = await setupApp();

    const response = await app.request('/api/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Unknown', redirect_uris: ['https://evil.example/callback'] }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_redirect_uri' });
  });

  it('rejects bearer tokens for direct harness access', async () => {
    const { authApp, db, schema, user, hashOAuthToken } = await setupApp();
    const token = 'mnoac_test_token';
    const publicFolder = {
      id: 'folder_public',
      userId: user.id,
      parentFolderId: null,
      title: 'Public',
      isPrivate: false,
      isAgentReadOnly: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const privateFolder = {
      id: 'folder_private',
      userId: user.id,
      parentFolderId: null,
      title: 'Private',
      isPrivate: true,
      isAgentReadOnly: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await db.insert(schema.folders).values([publicFolder, privateFolder]);
    await db.insert(schema.integrationAuthorizations).values({
      id: 'oauth_auth_all',
      userId: user.id,
      accessMode: 'all',
      canRead: true,
      canCreate: false,
      canEdit: false,
      canCreateFolders: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [authorization] = await db
      .insert(schema.oauthAuthorizations)
      .values({
        id: 'oauth_auth_all',
        integrationAuthorizationId: 'oauth_auth_all',
        userId: user.id,
        clientId: 'client_a',
        scope: 'notes',
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    await db.insert(schema.oauthTokens).values({
      id: 'oauth_token_all',
      authorizationId: authorization.id,
      accessTokenHash: hashOAuthToken(token),
      refreshTokenHash: hashOAuthToken('refresh'),
      scope: 'notes',
      accessTokenExpiresAt: new Date(Date.now() + 60_000),
      refreshTokenExpiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const folders = await authApp.request('/api/harness/folders', { headers: { authorization: `Bearer ${token}` } });
    expect(folders.status).toBe(401);
    await expect(folders.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('lists and revokes connected apps', async () => {
    const { app, db, schema, user } = await setupApp();
    await db.insert(schema.integrationAuthorizations).values({
      id: 'oauth_auth_connected',
      userId: user.id,
      accessMode: 'specific',
      canRead: true,
      canCreate: false,
      canEdit: false,
      canCreateFolders: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(schema.oauthAuthorizations).values({
      id: 'oauth_auth_connected',
      integrationAuthorizationId: 'oauth_auth_connected',
      userId: user.id,
      clientId: 'client_a',
      scope: 'notes',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const list = await app.request('/api/oauth/authorizations');
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      authorizations: [
        {
          id: 'oauth_auth_connected',
          sharedAccessMode: 'none',
          collaborationGrantIds: [],
          client: { name: 'Client A' },
        },
      ],
    });

    const revoke = await app.request('/api/oauth/authorizations/oauth_auth_connected', { method: 'DELETE' });
    expect(revoke.status).toBe(200);

    const after = await app.request('/api/oauth/authorizations');
    const afterBody = (await after.json()) as { authorizations: Array<{ id: string; revokedAt: string | null }> };
    expect(
      afterBody.authorizations.find((authorization) => authorization.id === 'oauth_auth_connected')?.revokedAt
    ).toBeTruthy();
  });

  it('edits connected-app permissions and updates active OAuth tokens', async () => {
    const { app, bearerApp, db, schema, user, hashOAuthToken } = await setupApp();
    const now = new Date();
    const accessToken = 'mnoac_editable_access';
    const refreshToken = 'mnort_editable_refresh';

    await db.insert(schema.folders).values({
      id: 'folder_editable',
      userId: user.id,
      parentFolderId: null,
      title: 'Editable folder',
      isPrivate: false,
      isAgentReadOnly: false,
      createdAt: now,
      updatedAt: now,
    });
    const sharedOwner = {
      id: 'user_edit_shared_owner',
      name: 'Shared Owner',
      email: 'shared-owner@example.com',
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(schema.user).values(sharedOwner);
    await db.insert(schema.folders).values({
      id: 'folder_shared_edit',
      userId: sharedOwner.id,
      parentFolderId: null,
      title: 'Shared folder',
      isPrivate: false,
      isAgentReadOnly: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.collaborationGrants).values({
      id: 'grant_shared_edit',
      ownerUserId: sharedOwner.id,
      granteeUserId: user.id,
      folderId: 'folder_shared_edit',
      role: 'viewer',
      createdByUserId: sharedOwner.id,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.integrationAuthorizations).values({
      id: 'oauth_auth_editable',
      userId: user.id,
      accessMode: 'all',
      canRead: true,
      canCreate: false,
      canEdit: false,
      canComment: false,
      canCreateFolders: false,
      sharedAccessMode: 'none',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.oauthAuthorizations).values({
      id: 'oauth_auth_editable',
      integrationAuthorizationId: 'oauth_auth_editable',
      userId: user.id,
      clientId: 'client_a',
      scope: 'notes.read',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.oauthAuthorizationCodes).values({
      id: 'oauth_code_editable',
      codeHash: hashOAuthToken('pending_code'),
      clientId: 'client_a',
      userId: user.id,
      redirectUri: 'https://client.example/callback',
      scope: 'notes.read',
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
      authorizationId: 'oauth_auth_editable',
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
    });
    await db.insert(schema.oauthTokens).values({
      id: 'oauth_token_editable',
      authorizationId: 'oauth_auth_editable',
      accessTokenHash: hashOAuthToken(accessToken),
      refreshTokenHash: hashOAuthToken(refreshToken),
      scope: 'notes.read',
      accessTokenExpiresAt: new Date(now.getTime() + 60_000),
      refreshTokenExpiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
      updatedAt: now,
    });

    const update = await app.request('/api/oauth/authorizations/oauth_auth_editable', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accessMode: 'specific',
        canRead: true,
        canCreate: true,
        canEdit: true,
        canComment: true,
        canCreateFolders: true,
        sharedAccessMode: 'specific',
        collaborationGrantIds: [publicCollaborationAccessKey('grant_shared_edit')],
        permissions: [{ folderId: 'folder_editable', canRead: true, canCreate: true, canEdit: true, canComment: true }],
      }),
    });
    expect(update.status).toBe(200);
    await expect(update.json()).resolves.toEqual({ ok: true });

    const expectedScope = 'notes.read notes.create notes.edit comments.write folders.create';
    const authorization = await bearerApp.request('/', { headers: { authorization: `Bearer ${accessToken}` } });
    expect(authorization.status).toBe(200);
    await expect(authorization.json()).resolves.toMatchObject({
      authorization: {
        canRead: true,
        canCreate: true,
        canEdit: true,
        canComment: true,
        canCreateFolders: true,
      },
    });

    const [oauthGrant] = await db.select().from(schema.oauthAuthorizations);
    const [integrationGrant] = await db.select().from(schema.integrationAuthorizations);
    const [authorizationCode] = await db.select().from(schema.oauthAuthorizationCodes);
    const [token] = await db.select().from(schema.oauthTokens);
    const [folderRule] = await db.select().from(schema.authorizationFolderRules);
    const [collaborationScope] = await db.select().from(schema.authorizationCollaborationScopes);
    expect(oauthGrant.scope).toBe(expectedScope);
    expect(integrationGrant).toMatchObject({
      accessMode: 'specific',
      sharedAccessMode: 'specific',
      canCreateFolders: true,
    });
    expect(authorizationCode.scope).toBe(expectedScope);
    expect(folderRule).toMatchObject({ folderId: 'folder_editable', canRead: true, canComment: true });
    expect(collaborationScope).toMatchObject({ collaborationGrantId: 'grant_shared_edit' });
    expect(token.scope).toBe(expectedScope);

    // Refresh must use the current grant scope even if an older token row is stale.
    await db.update(schema.oauthTokens).set({ scope: 'notes.read' });
    const refreshed = await app.request('/api/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: 'client_a' }),
    });
    expect(refreshed.status).toBe(200);
    await expect(refreshed.json()).resolves.toMatchObject({ scope: expectedScope });
  });

  it('rejects foreign, invalid-comment, private-folder, and invalid-share authorization edits', async () => {
    const { app, db, schema, user } = await setupApp();
    const now = new Date();
    await db.insert(schema.integrationAuthorizations).values({
      id: 'oauth_auth_edit_owner',
      userId: user.id,
      accessMode: 'all',
      canRead: true,
      canCreate: false,
      canEdit: false,
      canComment: false,
      canCreateFolders: false,
      sharedAccessMode: 'none',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.oauthAuthorizations).values({
      id: 'oauth_auth_edit_owner',
      integrationAuthorizationId: 'oauth_auth_edit_owner',
      userId: user.id,
      clientId: 'client_a',
      scope: 'notes.read',
      createdAt: now,
      updatedAt: now,
    });

    const otherUser = { ...user, id: 'user_b', name: 'User B', email: 'b@example.com' };
    await db.insert(schema.user).values(otherUser);
    await db.insert(schema.integrationAuthorizations).values({
      id: 'oauth_auth_edit_other',
      userId: otherUser.id,
      accessMode: 'all',
      canRead: true,
      canCreate: false,
      canEdit: false,
      canComment: false,
      canCreateFolders: false,
      sharedAccessMode: 'none',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.oauthAuthorizations).values({
      id: 'oauth_auth_edit_other',
      integrationAuthorizationId: 'oauth_auth_edit_other',
      userId: otherUser.id,
      clientId: 'client_a',
      scope: 'notes.read',
      createdAt: now,
      updatedAt: now,
    });

    const base = {
      accessMode: 'all',
      canRead: true,
      canCreate: false,
      canEdit: false,
      canComment: false,
      canCreateFolders: false,
      sharedAccessMode: 'none',
      collaborationGrantIds: [],
      permissions: [],
    };
    const foreign = await app.request('/api/oauth/authorizations/oauth_auth_edit_other', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(base),
    });
    expect(foreign.status).toBe(404);

    const invalidComment = await app.request('/api/oauth/authorizations/oauth_auth_edit_owner', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...base, canRead: false, canComment: true }),
    });
    expect(invalidComment.status).toBe(400);

    await db.insert(schema.folders).values({
      id: 'folder_edit_private',
      userId: user.id,
      parentFolderId: null,
      title: 'Private folder',
      isPrivate: true,
      isAgentReadOnly: false,
      createdAt: now,
      updatedAt: now,
    });
    const privateFolder = await app.request('/api/oauth/authorizations/oauth_auth_edit_owner', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...base,
        accessMode: 'specific',
        permissions: [{ folderId: 'folder_edit_private', canRead: true }],
      }),
    });
    expect(privateFolder.status).toBe(400);

    const invalidShare = await app.request('/api/oauth/authorizations/oauth_auth_edit_owner', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...base,
        sharedAccessMode: 'specific',
        collaborationGrantIds: ['invalid-grant'],
      }),
    });
    expect(invalidShare.status).toBe(400);

    const unchanged = (await db.select().from(schema.integrationAuthorizations)).find(
      (authorization) => authorization.id === 'oauth_auth_edit_owner'
    );
    expect(unchanged).toMatchObject({ canRead: true, canComment: false });
    const unchangedOAuth = (await db.select().from(schema.oauthAuthorizations)).find(
      (authorization) => authorization.id === 'oauth_auth_edit_owner'
    );
    expect(unchangedOAuth?.scope).toBe('notes.read');

    const folderCreationOnly = await app.request('/api/oauth/authorizations/oauth_auth_edit_owner', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...base, canRead: false, canCreateFolders: true }),
    });
    expect(folderCreationOnly.status).toBe(200);
    const updated = (await db.select().from(schema.integrationAuthorizations)).find(
      (authorization) => authorization.id === 'oauth_auth_edit_owner'
    );
    const updatedOAuth = (await db.select().from(schema.oauthAuthorizations)).find(
      (authorization) => authorization.id === 'oauth_auth_edit_owner'
    );
    expect(updated).toMatchObject({ canRead: false, canCreateFolders: true });
    expect(updatedOAuth?.scope).toBe('folders.create');
  });

  it('serves OAuth endpoints from root aliases for MCP clients', async () => {
    const { app } = await setupApp();
    const verifier = 'b'.repeat(64);
    const authorize = await app.request(
      `/oauth/authorize?response_type=code&client_id=client_a&redirect_uri=${encodeURIComponent('https://client.example/callback')}&code_challenge=${encodeURIComponent(pkceChallenge(verifier))}&code_challenge_method=S256`
    );
    expect(authorize.status).toBe(302);
    expect(new URL(authorize.headers.get('location')!).pathname).toBe('/oauth/authorize');

    const token = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: 'client_a',
        redirect_uri: 'https://client.example/callback',
        code: 'invalid',
        code_verifier: verifier,
      }),
    });
    expect(token.status).toBe(400);
  });

  it('serves authorization server metadata', async () => {
    const { app } = await setupApp();
    const response = await app.request('/api/oauth/.well-known/oauth-authorization-server');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      authorization_endpoint: 'http://localhost/oauth/authorize',
      token_endpoint: 'http://localhost/oauth/token',
      registration_endpoint: 'http://localhost/oauth/register',
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['notes.read', 'notes.create', 'notes.edit', 'comments.write', 'folders.create'],
    });
  });

  it('rejects unsupported scopes and permissions beyond the requested scope', async () => {
    const { app } = await setupApp();
    const verifier = 's'.repeat(64);
    const base = `response_type=code&client_id=client_a&redirect_uri=${encodeURIComponent('https://client.example/callback')}&code_challenge=${encodeURIComponent(pkceChallenge(verifier))}&code_challenge_method=S256`;

    const preview = await app.request(`/api/oauth/authorize/preview?${base}&scope=notes.read%20admin`);
    expect(preview.status).toBe(400);
    await expect(preview.json()).resolves.toMatchObject({ error: 'invalid_scope' });

    const approve = await app.request('/api/oauth/authorize/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        responseType: 'code',
        clientId: 'client_a',
        redirectUri: 'https://client.example/callback',
        codeChallenge: pkceChallenge(verifier),
        codeChallengeMethod: 'S256',
        scope: 'notes.read',
        accessMode: 'all',
        canRead: true,
        canEdit: true,
      }),
    });
    expect(approve.status).toBe(400);
    await expect(approve.json()).resolves.toMatchObject({ error: 'invalid_scope' });
  });

  it('stores selected shared collaboration grants during consent', async () => {
    const { app, db, schema, user } = await setupApp();
    const owner = {
      id: 'shared_owner',
      name: 'Shared Owner',
      email: 'owner@example.com',
      emailVerified: true,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await db.insert(schema.user).values(owner);
    await db.insert(schema.folders).values({
      id: 'shared_folder',
      userId: owner.id,
      parentFolderId: null,
      title: 'Shared folder',
      isPrivate: false,
      isAgentReadOnly: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(schema.collaborationGrants).values({
      id: 'shared_grant',
      ownerUserId: owner.id,
      granteeUserId: user.id,
      folderId: 'shared_folder',
      role: 'viewer',
      createdByUserId: owner.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const verifier = 'u'.repeat(64);
    const approve = await app.request('/api/oauth/authorize/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        responseType: 'code',
        clientId: 'client_a',
        redirectUri: 'https://client.example/callback',
        codeChallenge: pkceChallenge(verifier),
        codeChallengeMethod: 'S256',
        scope: 'notes.read',
        accessMode: 'all',
        canRead: true,
        sharedAccessMode: 'specific',
        collaborationGrantIds: [publicCollaborationAccessKey('shared_grant')],
      }),
    });
    expect(approve.status).toBe(200);

    const [authorization] = await db.select().from(schema.integrationAuthorizations);
    expect(authorization.sharedAccessMode).toBe('specific');
    await expect(db.select().from(schema.authorizationCollaborationScopes)).resolves.toMatchObject([
      { authorizationId: authorization.id, userId: user.id, collaborationGrantId: 'shared_grant' },
    ]);

    const list = await app.request('/api/oauth/authorizations');
    const listBody = await list.json();
    expect(listBody).toMatchObject({
      authorizations: [
        {
          sharedAccessMode: 'specific',
          collaborationGrantIds: [publicCollaborationAccessKey('shared_grant')],
        },
      ],
    });
    expect(JSON.stringify(listBody)).not.toContain('shared_grant');
  });

  it('stores the approved scope and intersects bearer capabilities with token scope', async () => {
    const { app, bearerApp, db, schema, user, hashOAuthToken } = await setupApp();
    const verifier = 't'.repeat(64);
    const approve = await app.request('/api/oauth/authorize/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        responseType: 'code',
        clientId: 'client_a',
        redirectUri: 'https://client.example/callback',
        codeChallenge: pkceChallenge(verifier),
        codeChallengeMethod: 'S256',
        scope: 'notes.read notes.edit',
        accessMode: 'all',
        canRead: true,
        canEdit: false,
      }),
    });
    expect(approve.status).toBe(200);
    const [approved] = await db.select().from(schema.oauthAuthorizations);
    expect(approved.scope).toBe('notes.read');

    const bearer = 'mnoac_scope_intersection';
    await db.insert(schema.integrationAuthorizations).values({
      id: 'oauth_auth_scope_intersection',
      userId: user.id,
      accessMode: 'all',
      canRead: true,
      canCreate: false,
      canEdit: true,
      canComment: false,
      canCreateFolders: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [authorization] = await db
      .insert(schema.oauthAuthorizations)
      .values({
        id: 'oauth_auth_scope_intersection',
        integrationAuthorizationId: 'oauth_auth_scope_intersection',
        userId: user.id,
        clientId: 'client_a',
        scope: 'notes.read notes.edit',
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    await db.insert(schema.oauthTokens).values({
      id: 'oauth_token_scope_intersection',
      authorizationId: authorization.id,
      accessTokenHash: hashOAuthToken(bearer),
      refreshTokenHash: hashOAuthToken('mnort_scope_intersection'),
      scope: 'notes.read',
      accessTokenExpiresAt: new Date(Date.now() + 60_000),
      refreshTokenExpiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const authenticated = await bearerApp.request('/', { headers: { authorization: `Bearer ${bearer}` } });
    expect(authenticated.status).toBe(200);
    await expect(authenticated.json()).resolves.toMatchObject({
      authorization: { canRead: true, canEdit: false },
    });
  });

  it('exchanges an authorization code with PKCE and revokes a token', async () => {
    const { app, db, schema } = await setupApp();
    const verifier = 'a'.repeat(64);
    const authorizePath = `/api/oauth/authorize?response_type=code&client_id=client_a&redirect_uri=${encodeURIComponent('https://client.example/callback')}&code_challenge=${encodeURIComponent(pkceChallenge(verifier))}&code_challenge_method=S256&state=abc`;
    const authorize = await app.request(authorizePath);
    expect(authorize.status).toBe(302);
    const location = authorize.headers.get('location');
    expect(location).toBeTruthy();
    expect(new URL(location!).pathname).toBe('/oauth/authorize');

    const preview = await app.request(authorizePath.replace('/authorize?', '/authorize/preview?'));
    expect(preview.status).toBe(200);
    await expect(preview.json()).resolves.toMatchObject({ client: { name: 'Client A' }, request: { state: 'abc' } });

    const approve = await app.request('/api/oauth/authorize/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        responseType: 'code',
        clientId: 'client_a',
        redirectUri: 'https://client.example/callback',
        codeChallenge: pkceChallenge(verifier),
        codeChallengeMethod: 'S256',
        state: 'abc',
        accessMode: 'all',
        canRead: true,
        canCreate: false,
        canEdit: false,
        canComment: true,
        canCreateFolders: false,
        folderIds: [],
      }),
    });
    expect(approve.status).toBe(200);
    const [authorization] = await db.select().from(schema.integrationAuthorizations);
    expect(authorization).toMatchObject({ canRead: true, canEdit: false, canComment: true });
    const { redirectUrl } = (await approve.json()) as { redirectUrl: string };
    const redirected = new URL(redirectUrl);
    expect(redirected.searchParams.get('state')).toBe('abc');
    const code = redirected.searchParams.get('code');
    expect(code).toBeTruthy();

    const token = await app.request('/api/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: 'client_a',
        redirect_uri: 'https://client.example/callback',
        code: code!,
        code_verifier: verifier,
      }),
    });
    expect(token.status).toBe(200);
    const tokenBody = (await token.json()) as { access_token: string; refresh_token: string; token_type: string };
    expect(tokenBody.token_type).toBe('Bearer');
    expect(tokenBody.access_token).toMatch(/^mnoac_/);
    expect(tokenBody.refresh_token).toMatch(/^mnort_/);

    const reuse = await app.request('/api/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: 'client_a',
        redirect_uri: 'https://client.example/callback',
        code: code!,
        code_verifier: verifier,
      }),
    });
    expect(reuse.status).toBe(400);

    const revoke = await app.request('/api/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: tokenBody.access_token }),
    });
    expect(revoke.status).toBe(200);
  });

  it('rolls back authorization-code consumption when token issuance fails', async () => {
    const { app, libsql } = await setupApp();
    const verifier = 'f'.repeat(64);
    const approve = await app.request('/api/oauth/authorize/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        responseType: 'code',
        clientId: 'client_a',
        redirectUri: 'https://client.example/callback',
        codeChallenge: pkceChallenge(verifier),
        codeChallengeMethod: 'S256',
        scope: 'notes.read',
        accessMode: 'all',
        canRead: true,
      }),
    });
    const { redirectUrl } = (await approve.json()) as { redirectUrl: string };
    const code = new URL(redirectUrl).searchParams.get('code');
    expect(code).toBeTruthy();
    const exchange = () =>
      app.request('/api/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: 'client_a',
          redirect_uri: 'https://client.example/callback',
          code: code ?? '',
          code_verifier: verifier,
        }),
      });

    await libsql.execute(`
      CREATE TRIGGER fail_oauth_token_insert
      BEFORE INSERT ON oauth_tokens
      BEGIN
        SELECT RAISE(ABORT, 'forced token insert failure');
      END
    `);
    expect((await exchange()).status).toBe(500);
    await libsql.execute('DROP TRIGGER fail_oauth_token_insert');
    expect((await exchange()).status).toBe(200);
  });

  it('returns temporarily_unavailable when wrapped database-busy errors exhaust retries', async () => {
    const { app, libsql } = await setupApp();
    const verifier = 'b'.repeat(64);
    const approve = await app.request('/api/oauth/authorize/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        responseType: 'code',
        clientId: 'client_a',
        redirectUri: 'https://client.example/callback',
        codeChallenge: pkceChallenge(verifier),
        codeChallengeMethod: 'S256',
        scope: 'notes.read',
        accessMode: 'all',
        canRead: true,
      }),
    });
    const { redirectUrl } = (await approve.json()) as { redirectUrl: string };
    const code = new URL(redirectUrl).searchParams.get('code') ?? '';
    const batch = vi.spyOn(libsql, 'batch').mockRejectedValue(
      Object.assign(new Error('remote database is busy'), {
        code: 'HRANA_WEBSOCKET_ERROR',
        cause: { code: 'SQLITE_BUSY_TIMEOUT' },
      })
    );

    const response = await app.request('/api/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: 'client_a',
        redirect_uri: 'https://client.example/callback',
        code,
        code_verifier: verifier,
      }),
    });

    expect(batch).toHaveBeenCalledTimes(5);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: 'temporarily_unavailable' });
    batch.mockRestore();
  });

  it('atomically consumes authorization codes and rotates refresh tokens', async () => {
    const { app } = await setupApp();
    const verifier = 'r'.repeat(64);
    const approve = await app.request('/api/oauth/authorize/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        responseType: 'code',
        clientId: 'client_a',
        redirectUri: 'https://client.example/callback',
        codeChallenge: pkceChallenge(verifier),
        codeChallengeMethod: 'S256',
        scope: 'notes.read',
        accessMode: 'all',
        canRead: true,
      }),
    });
    const { redirectUrl } = (await approve.json()) as { redirectUrl: string };
    const code = new URL(redirectUrl).searchParams.get('code')!;
    const exchange = () =>
      app.request('/api/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: 'client_a',
          redirect_uri: 'https://client.example/callback',
          code,
          code_verifier: verifier,
        }),
      });

    const exchanges = await Promise.all([exchange(), exchange()]);
    expect(exchanges.map((response) => response.status).sort()).toEqual([200, 400]);
    const successfulExchange = exchanges.find((response) => response.status === 200)!;
    const { refresh_token: refreshToken } = (await successfulExchange.json()) as { refresh_token: string };
    const refresh = () =>
      app.request('/api/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
      });

    const refreshes = await Promise.all([refresh(), refresh()]);
    expect(refreshes.map((response) => response.status).sort()).toEqual([200, 400]);
    const successfulRefresh = refreshes.find((response) => response.status === 200);
    expect(successfulRefresh).toBeDefined();
    await expect(successfulRefresh?.json()).resolves.toMatchObject({ scope: 'notes.read' });
  });
});
