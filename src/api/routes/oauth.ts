import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { db, libsql } from '../db/client';
import {
  type ApiKey,
  authorizationCollaborationScopes,
  authorizationFolderRules,
  collaborationGrants,
  integrationAuthorizations,
  type OAuthAuthorization,
  oauthAuthorizationCodes,
  oauthAuthorizations,
  oauthClients,
  oauthTokens,
} from '../db/schema';
import type { auth } from '../lib/auth';
import { publicCollaborationAccessKey } from '../lib/collaboration-identity';
import { getApiRuntimeConfig } from '../lib/env';
import { filterSelectablePermissionRows } from '../lib/folder-access';
import { createId } from '../lib/id';
import {
  ACCESS_TOKEN_TTL_MS,
  AUTHORIZATION_CODE_TTL_MS,
  findOAuthClient,
  generateOAuthToken,
  hashOAuthToken,
  isRedirectUriAllowed,
  oauthCapabilitiesFitScope,
  oauthError,
  oauthScopeForCapabilities,
  parseOAuthScope,
  REFRESH_TOKEN_TTL_MS,
  SUPPORTED_OAUTH_SCOPES,
  validateDcrRedirectUri,
  validateOAuthRedirectUri,
  verifyPkce,
} from '../lib/oauth';

type Variables = {
  user: typeof auth.$Infer.Session.user | null;
  session: typeof auth.$Infer.Session.session | null;
  apiKey: ApiKey | null;
  oauthAuthorization: OAuthAuthorization | null;
};

export const oauthRoutes = new Hono<{ Variables: Variables }>();

const { frontendUrl } = getApiRuntimeConfig();

type AuthorizationAccessMode = 'all' | 'top_level' | 'specific';
type AuthorizationSharedAccessMode = 'none' | 'specific' | 'all';
type AuthorizationPermissionInput = {
  folderId: string;
  canRead?: boolean;
  canCreate?: boolean;
  canEdit?: boolean;
  canComment?: boolean;
  appliesTo?: 'exact' | 'subtree';
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAuthorizationPermissionInput(value: unknown): value is AuthorizationPermissionInput {
  if (!isRecord(value) || typeof value.folderId !== 'string') return false;
  return (
    ['canRead', 'canCreate', 'canEdit', 'canComment'].every(
      (key) => value[key] === undefined || typeof value[key] === 'boolean'
    ) &&
    (value.appliesTo === undefined || value.appliesTo === 'exact' || value.appliesTo === 'subtree')
  );
}

function getOrigin(c: Context<{ Variables: Variables }>) {
  return new URL(c.req.url).origin;
}

function textParam(value: FormDataEntryValue | string | undefined | null) {
  return typeof value === 'string' ? value : undefined;
}

function isDatabaseBusy(error: unknown) {
  const seen = new Set<unknown>();
  let current = error;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    const candidate = current as {
      code?: unknown;
      extendedCode?: unknown;
      rawCode?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    const codes = [candidate.code, candidate.extendedCode].map(String);
    if (codes.some((code) => code.startsWith('SQLITE_BUSY')) || candidate.rawCode === 5) return true;
    const message = typeof candidate.message === 'string' ? candidate.message : '';
    if (/SQLITE_BUSY|database is locked/i.test(message)) return true;
    current = candidate.cause;
  }
  return false;
}

async function withDatabaseBusyRetry<T>(operation: () => Promise<T>) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isDatabaseBusy(error) || attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

function authorizationServerMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: SUPPORTED_OAUTH_SCOPES,
  };
}

async function validateAuthorizeRequest(input: {
  clientId?: string;
  redirectUri?: string;
  responseType?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}) {
  if (input.responseType !== 'code')
    return { ok: false as const, status: 400 as const, error: oauthError('unsupported_response_type') };
  if (!input.clientId || !input.redirectUri || !input.codeChallenge)
    return {
      ok: false as const,
      status: 400 as const,
      error: oauthError('invalid_request', 'client_id, redirect_uri, and code_challenge are required'),
    };
  if (input.codeChallengeMethod !== 'S256')
    return {
      ok: false as const,
      status: 400 as const,
      error: oauthError('invalid_request', 'Only S256 PKCE is supported'),
    };

  const client = await findOAuthClient(input.clientId);
  if (!client) return { ok: false as const, status: 400 as const, error: oauthError('invalid_client') };
  if (!isRedirectUriAllowed(client, input.redirectUri))
    return {
      ok: false as const,
      status: 400 as const,
      error: oauthError('invalid_request', 'redirect_uri is not registered for this client'),
    };
  return {
    ok: true as const,
    client,
    redirectUri: input.redirectUri,
    clientId: input.clientId,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: input.codeChallengeMethod,
  };
}

oauthRoutes.get('/.well-known/oauth-authorization-server', (c) => c.json(authorizationServerMetadata(getOrigin(c))));

oauthRoutes.post('/register', async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    redirect_uris?: unknown;
    client_name?: unknown;
    token_endpoint_auth_method?: unknown;
    grant_types?: unknown;
    response_types?: unknown;
    scope?: unknown;
  } | null;
  if (!body) return c.json(oauthError('invalid_client_metadata', 'Invalid JSON'), 400);

  const requestedScope = parseOAuthScope(typeof body.scope === 'string' ? body.scope : undefined, {
    useDefault: true,
  });
  if (!requestedScope.ok)
    return c.json(
      oauthError('invalid_client_metadata', `Unsupported scopes: ${requestedScope.unsupported.join(', ')}`),
      400
    );

  const redirectUris = Array.isArray(body.redirect_uris)
    ? [
        ...new Set(
          body.redirect_uris
            .filter((uri): uri is string => typeof uri === 'string')
            .map((uri) => uri.trim())
            .filter(Boolean)
        ),
      ]
    : [];
  if (redirectUris.length === 0) return c.json(oauthError('invalid_redirect_uri', 'redirect_uris is required'), 400);
  for (const uri of redirectUris) {
    const result = validateDcrRedirectUri(uri);
    if (!result.ok) return c.json(oauthError('invalid_redirect_uri', result.error), 400);
  }

  const tokenEndpointAuthMethod =
    typeof body.token_endpoint_auth_method === 'string' ? body.token_endpoint_auth_method : 'none';
  if (tokenEndpointAuthMethod !== 'none')
    return c.json(oauthError('invalid_client_metadata', 'Only token_endpoint_auth_method=none is supported'), 400);
  const grantTypes = Array.isArray(body.grant_types)
    ? body.grant_types.filter((value): value is string => typeof value === 'string')
    : ['authorization_code', 'refresh_token'];
  if (!grantTypes.includes('authorization_code'))
    return c.json(oauthError('invalid_client_metadata', 'authorization_code grant is required'), 400);
  const responseTypes = Array.isArray(body.response_types)
    ? body.response_types.filter((value): value is string => typeof value === 'string')
    : ['code'];
  if (!responseTypes.includes('code'))
    return c.json(oauthError('invalid_client_metadata', 'code response type is required'), 400);

  const now = new Date();
  const clientName =
    typeof body.client_name === 'string' && body.client_name.trim()
      ? body.client_name.trim()
      : 'Dynamically registered MCP client';
  const [client] = await db
    .insert(oauthClients)
    .values({
      id: createId('oauth_client'),
      userId: null,
      name: clientName,
      description: 'Dynamically registered OAuth client',
      redirectUris: JSON.stringify(redirectUris),
      clientType: 'public',
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return c.json(
    {
      client_id: client.id,
      client_id_issued_at: Math.floor(now.getTime() / 1000),
      client_name: client.name,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: requestedScope.scope,
    },
    201
  );
});

oauthRoutes.get('/clients', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const clients = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.userId, user.id))
    .orderBy(desc(oauthClients.createdAt));
  return c.json({ clients });
});

oauthRoutes.post('/clients', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const body = (await c.req.json().catch(() => null)) as {
    name?: string;
    description?: string | null;
    redirectUris?: string[];
  } | null;
  const name = body?.name?.trim();
  if (!name) return c.json({ error: 'App name is required' }, 400);
  const redirectUris = [...new Set((body?.redirectUris ?? []).map((uri) => uri.trim()).filter(Boolean))];
  if (redirectUris.length === 0) return c.json({ error: 'At least one redirect URI is required' }, 400);
  for (const uri of redirectUris) {
    try {
      const result = validateOAuthRedirectUri(uri);
      if (!result.ok) return c.json({ error: result.error }, 400);
    } catch {
      return c.json({ error: 'Redirect URIs must be valid URLs' }, 400);
    }
  }

  const now = new Date();
  const [client] = await db
    .insert(oauthClients)
    .values({
      id: createId('oauth_client'),
      userId: user.id,
      name,
      description: body?.description?.trim() || null,
      redirectUris: JSON.stringify(redirectUris),
      clientType: 'public',
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return c.json({ client }, 201);
});

oauthRoutes.delete('/clients/:clientId', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const now = new Date();
  const revoked = await db.transaction(async (tx) => {
    const [client] = await tx
      .update(oauthClients)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(oauthClients.id, c.req.param('clientId')),
          eq(oauthClients.userId, user.id),
          isNull(oauthClients.revokedAt)
        )
      )
      .returning({ id: oauthClients.id });
    if (!client) return false;

    const authorizations = await tx
      .select({ id: oauthAuthorizations.id, integrationId: oauthAuthorizations.integrationAuthorizationId })
      .from(oauthAuthorizations)
      .where(eq(oauthAuthorizations.clientId, client.id));
    for (const authorization of authorizations) {
      await tx
        .update(integrationAuthorizations)
        .set({ revokedAt: now, updatedAt: now })
        .where(eq(integrationAuthorizations.id, authorization.integrationId));
      await tx
        .update(oauthTokens)
        .set({ revokedAt: now, updatedAt: now })
        .where(eq(oauthTokens.authorizationId, authorization.id));
    }
    return true;
  });
  return revoked ? c.json({ ok: true }) : c.json({ error: 'OAuth app not found' }, 404);
});

oauthRoutes.get('/authorizations', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const rows = await db
    .select({ connection: oauthAuthorizations, authorization: integrationAuthorizations, client: oauthClients })
    .from(oauthAuthorizations)
    .innerJoin(
      integrationAuthorizations,
      eq(oauthAuthorizations.integrationAuthorizationId, integrationAuthorizations.id)
    )
    .innerJoin(oauthClients, eq(oauthAuthorizations.clientId, oauthClients.id))
    .where(eq(integrationAuthorizations.userId, user.id))
    .orderBy(desc(integrationAuthorizations.createdAt));
  const permissions = await db
    .select()
    .from(authorizationFolderRules)
    .where(eq(authorizationFolderRules.userId, user.id));
  const collaborationScopes = await db
    .select()
    .from(authorizationCollaborationScopes)
    .where(eq(authorizationCollaborationScopes.userId, user.id));

  return c.json({
    authorizations: rows.map((row) => ({
      ...row.connection,
      ...row.authorization,
      client: row.client,
      permissions: permissions
        .filter((permission) => permission.authorizationId === row.authorization.id)
        .map((permission) => ({ ...permission, authorizationId: row.connection.id })),
      collaborationGrantIds: collaborationScopes
        .filter((scope) => scope.authorizationId === row.authorization.id)
        .map((scope) => publicCollaborationAccessKey(scope.collaborationGrantId)),
    })),
  });
});

oauthRoutes.patch('/authorizations/:authorizationId', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const body = await c.req.json().catch(() => null);
  if (
    !isRecord(body) ||
    (body.accessMode !== 'all' && body.accessMode !== 'top_level' && body.accessMode !== 'specific') ||
    typeof body.canRead !== 'boolean' ||
    typeof body.canCreate !== 'boolean' ||
    typeof body.canEdit !== 'boolean' ||
    typeof body.canComment !== 'boolean' ||
    typeof body.canCreateFolders !== 'boolean' ||
    (body.sharedAccessMode !== 'none' && body.sharedAccessMode !== 'specific' && body.sharedAccessMode !== 'all') ||
    !Array.isArray(body.collaborationGrantIds) ||
    !body.collaborationGrantIds.every((grantId): grantId is string => typeof grantId === 'string') ||
    body.collaborationGrantIds.length > 100 ||
    !Array.isArray(body.permissions) ||
    !body.permissions.every(isAuthorizationPermissionInput)
  )
    return c.json({ error: 'Invalid authorization settings' }, 400);

  const accessMode = body.accessMode as AuthorizationAccessMode;
  const sharedAccessMode = body.sharedAccessMode as AuthorizationSharedAccessMode;
  const capabilities = {
    canRead: body.canRead,
    canCreate: body.canCreate,
    canEdit: body.canEdit,
    canComment: body.canComment,
    canCreateFolders: body.canCreateFolders,
  };
  if (capabilities.canComment && !capabilities.canRead)
    return c.json({ error: 'Comment permission requires read permission' }, 400);
  if (
    !capabilities.canRead &&
    !capabilities.canCreate &&
    !capabilities.canEdit &&
    !capabilities.canComment &&
    !capabilities.canCreateFolders
  )
    return c.json({ error: 'At least one permission is required' }, 400);

  const collaborationGrantKeys = [...new Set(body.collaborationGrantIds)];
  if (sharedAccessMode === 'specific' && collaborationGrantKeys.length === 0)
    return c.json({ error: 'At least one collaboration grant is required for specific shared access' }, 400);
  if (sharedAccessMode !== 'specific' && collaborationGrantKeys.length > 0)
    return c.json({ error: 'Collaboration grant selections require specific shared access mode' }, 400);

  const [existing] = await db
    .select({ connection: oauthAuthorizations, authorization: integrationAuthorizations })
    .from(oauthAuthorizations)
    .innerJoin(
      integrationAuthorizations,
      eq(oauthAuthorizations.integrationAuthorizationId, integrationAuthorizations.id)
    )
    .where(
      and(
        eq(oauthAuthorizations.id, c.req.param('authorizationId')),
        eq(oauthAuthorizations.userId, user.id),
        eq(integrationAuthorizations.userId, user.id),
        isNull(integrationAuthorizations.revokedAt)
      )
    )
    .limit(1);
  if (!existing) return c.json({ error: 'OAuth authorization not found' }, 404);

  let collaborationGrantIds: string[] = [];
  if (collaborationGrantKeys.length > 0) {
    const validGrants = await db
      .select({ id: collaborationGrants.id })
      .from(collaborationGrants)
      .where(eq(collaborationGrants.granteeUserId, user.id));
    const internalIdByPublicKey = new Map(
      validGrants.map((grant) => [publicCollaborationAccessKey(grant.id), grant.id])
    );
    const resolvedIds = collaborationGrantKeys.map((key) => internalIdByPublicKey.get(key));
    if (!resolvedIds.every((id): id is string => Boolean(id)))
      return c.json({ error: 'One or more collaboration grants are invalid' }, 400);
    collaborationGrantIds = resolvedIds;
  }

  if (accessMode !== 'all' && body.permissions.length === 0)
    return c.json({ error: 'At least one folder is required' }, 400);
  const selectablePermissions = await filterSelectablePermissionRows({
    userId: user.id,
    accessMode,
    permissions: body.permissions,
  });
  if (selectablePermissions.length !== body.permissions.length)
    return c.json({ error: 'One or more folders cannot be selected' }, 400);

  const now = new Date();
  const scope = oauthScopeForCapabilities(capabilities);
  const folderRules = selectablePermissions.flatMap((permission) => {
    if (!permission.folderId) return [];
    return [
      {
        id: createId('auth_rule'),
        authorizationId: existing.authorization.id,
        userId: user.id,
        folderId: permission.folderId,
        canRead: capabilities.canRead && (permission.canRead ?? capabilities.canRead),
        canCreate: capabilities.canCreate && (permission.canCreate ?? capabilities.canCreate),
        canEdit: capabilities.canEdit && (permission.canEdit ?? capabilities.canEdit),
        canComment: capabilities.canComment && (permission.canComment ?? capabilities.canComment),
        canCreateFolders: capabilities.canCreateFolders,
        appliesTo:
          accessMode === 'top_level'
            ? ('subtree' as const)
            : accessMode === 'specific'
              ? ('exact' as const)
              : (permission.appliesTo ?? 'exact'),
        createdAt: now,
        updatedAt: now,
      },
    ];
  });

  const updated = await db.transaction(async (tx) => {
    const [activeAuthorization] = await tx
      .update(integrationAuthorizations)
      .set({ ...capabilities, accessMode, sharedAccessMode, updatedAt: now })
      .where(
        and(
          eq(integrationAuthorizations.id, existing.authorization.id),
          eq(integrationAuthorizations.userId, user.id),
          isNull(integrationAuthorizations.revokedAt)
        )
      )
      .returning({ id: integrationAuthorizations.id });
    if (!activeAuthorization) return false;

    await tx
      .update(oauthAuthorizations)
      .set({ scope, updatedAt: now })
      .where(eq(oauthAuthorizations.id, existing.connection.id));
    await tx
      .update(oauthTokens)
      .set({ scope, updatedAt: now })
      .where(and(eq(oauthTokens.authorizationId, existing.connection.id), isNull(oauthTokens.revokedAt)));
    await tx
      .update(oauthAuthorizationCodes)
      .set({ scope })
      .where(
        and(
          eq(oauthAuthorizationCodes.authorizationId, existing.connection.id),
          isNull(oauthAuthorizationCodes.usedAt),
          gt(oauthAuthorizationCodes.expiresAt, now)
        )
      );

    await tx
      .delete(authorizationCollaborationScopes)
      .where(eq(authorizationCollaborationScopes.authorizationId, existing.authorization.id));
    if (sharedAccessMode === 'specific' && collaborationGrantIds.length > 0)
      await tx.insert(authorizationCollaborationScopes).values(
        collaborationGrantIds.map((collaborationGrantId) => ({
          id: createId('auth_collaboration_scope'),
          authorizationId: existing.authorization.id,
          userId: user.id,
          collaborationGrantId,
          createdAt: now,
        }))
      );

    await tx
      .delete(authorizationFolderRules)
      .where(eq(authorizationFolderRules.authorizationId, existing.authorization.id));
    if (folderRules.length > 0)
      await tx
        .insert(authorizationFolderRules)
        .values(folderRules)
        .onConflictDoNothing({
          target: [authorizationFolderRules.authorizationId, authorizationFolderRules.folderId],
        });

    return true;
  });
  if (!updated) return c.json({ error: 'OAuth authorization not found' }, 404);
  return c.json({ ok: true });
});

oauthRoutes.delete('/authorizations/:authorizationId', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const now = new Date();
  const revoked = await db.transaction(async (tx) => {
    const [authorization] = await tx
      .select({ id: oauthAuthorizations.id, integrationId: integrationAuthorizations.id })
      .from(oauthAuthorizations)
      .innerJoin(
        integrationAuthorizations,
        eq(oauthAuthorizations.integrationAuthorizationId, integrationAuthorizations.id)
      )
      .where(
        and(
          eq(oauthAuthorizations.id, c.req.param('authorizationId')),
          eq(integrationAuthorizations.userId, user.id),
          isNull(integrationAuthorizations.revokedAt)
        )
      )
      .limit(1);
    if (!authorization) return false;
    await tx
      .update(integrationAuthorizations)
      .set({ revokedAt: now, updatedAt: now })
      .where(eq(integrationAuthorizations.id, authorization.integrationId));
    await tx
      .update(oauthTokens)
      .set({ revokedAt: now, updatedAt: now })
      .where(eq(oauthTokens.authorizationId, authorization.id));
    return true;
  });
  return revoked ? c.json({ ok: true }) : c.json({ error: 'Connected app not found' }, 404);
});

oauthRoutes.get('/authorize/preview', async (c) => {
  const user = c.get('user');
  if (!user) {
    console.info('[OAUTH PREVIEW UNAUTHORIZED]', {
      path: new URL(c.req.url).pathname,
      origin: c.req.raw.headers.get('origin'),
      referer: c.req.raw.headers.get('referer'),
      hasCookieHeader: Boolean(c.req.raw.headers.get('cookie')),
    });
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const result = await validateAuthorizeRequest({
    clientId: c.req.query('client_id'),
    redirectUri: c.req.query('redirect_uri'),
    responseType: c.req.query('response_type'),
    codeChallenge: c.req.query('code_challenge'),
    codeChallengeMethod: c.req.query('code_challenge_method'),
  });
  if (!result.ok) return c.json(result.error, result.status);
  const requestedScope = parseOAuthScope(c.req.query('scope'), { useDefault: true });
  if (!requestedScope.ok)
    return c.json(oauthError('invalid_scope', `Unsupported scopes: ${requestedScope.unsupported.join(', ')}`), 400);
  return c.json({
    client: result.client,
    request: {
      scope: requestedScope.scope,
      state: c.req.query('state') ?? null,
      redirectUri: result.redirectUri,
    },
  });
});

oauthRoutes.post('/authorize/approve', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const body = (await c.req.json().catch(() => null)) as {
    clientId?: string;
    redirectUri?: string;
    responseType?: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
    state?: string | null;
    scope?: string;
    accessMode?: 'all' | 'top_level' | 'specific';
    canRead?: boolean;
    canCreate?: boolean;
    canEdit?: boolean;
    canComment?: boolean;
    canCreateFolders?: boolean;
    folderIds?: string[];
    sharedAccessMode?: 'none' | 'specific' | 'all';
    collaborationGrantIds?: string[];
  } | null;
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);
  const result = await validateAuthorizeRequest({
    clientId: body.clientId,
    redirectUri: body.redirectUri,
    responseType: body.responseType,
    codeChallenge: body.codeChallenge,
    codeChallengeMethod: body.codeChallengeMethod,
  });
  if (!result.ok) return c.json(result.error, result.status);

  const accessMode =
    body.accessMode === 'all' || body.accessMode === 'top_level' || body.accessMode === 'specific'
      ? body.accessMode
      : 'specific';
  const requestedScope = parseOAuthScope(body.scope, { useDefault: true });
  if (!requestedScope.ok)
    return c.json(oauthError('invalid_scope', `Unsupported scopes: ${requestedScope.unsupported.join(', ')}`), 400);

  const canRead = body.canRead ?? true;
  const canCreate = body.canCreate ?? false;
  const canEdit = body.canEdit ?? false;
  const canComment = body.canComment ?? false;
  const canCreateFolders = body.canCreateFolders ?? false;
  const approvedCapabilities = { canRead, canCreate, canEdit, canComment, canCreateFolders };
  if (!canRead && !canCreate && !canEdit && !canComment && !canCreateFolders)
    return c.json({ error: 'At least one permission is required' }, 400);
  if (canComment && !canRead) return c.json({ error: 'Comment permission requires read permission' }, 400);
  if (!oauthCapabilitiesFitScope(approvedCapabilities, requestedScope.scopes))
    return c.json(oauthError('invalid_scope', 'Approved permissions exceed the requested OAuth scope'), 400);
  const approvedScope = oauthScopeForCapabilities(approvedCapabilities);
  if (
    body.sharedAccessMode !== undefined &&
    body.sharedAccessMode !== 'none' &&
    body.sharedAccessMode !== 'specific' &&
    body.sharedAccessMode !== 'all'
  )
    return c.json({ error: 'Shared access mode must be none, specific, or all' }, 400);
  const sharedAccessMode =
    body.sharedAccessMode === 'specific' || body.sharedAccessMode === 'all' ? body.sharedAccessMode : 'none';
  if (
    body.collaborationGrantIds !== undefined &&
    (!Array.isArray(body.collaborationGrantIds) ||
      !body.collaborationGrantIds.every((collaborationGrantId) => typeof collaborationGrantId === 'string'))
  )
    return c.json({ error: 'Collaboration grant ids must be an array of strings' }, 400);
  const collaborationGrantKeys = [...new Set(body.collaborationGrantIds ?? [])];
  if (collaborationGrantKeys.length > 100)
    return c.json({ error: 'No more than 100 collaboration grants may be selected' }, 400);
  if (sharedAccessMode !== 'specific' && collaborationGrantKeys.length > 0)
    return c.json({ error: 'Collaboration grant selections require specific shared access mode' }, 400);
  if (sharedAccessMode === 'specific' && collaborationGrantKeys.length === 0)
    return c.json({ error: 'At least one collaboration grant is required for specific shared access' }, 400);
  let collaborationGrantIds: string[] = [];
  if (collaborationGrantKeys.length > 0) {
    const validGrants = await db
      .select({ id: collaborationGrants.id })
      .from(collaborationGrants)
      .where(eq(collaborationGrants.granteeUserId, user.id));
    const internalIdByPublicKey = new Map(
      validGrants.map((grant) => [publicCollaborationAccessKey(grant.id), grant.id])
    );
    const resolvedIds = collaborationGrantKeys.map((key) => internalIdByPublicKey.get(key));
    if (!resolvedIds.every((id): id is string => Boolean(id)))
      return c.json({ error: 'One or more collaboration grants are invalid' }, 400);
    collaborationGrantIds = resolvedIds;
  }
  const folderIds = [...new Set(body.folderIds ?? [])];
  if (accessMode !== 'all' && folderIds.length === 0) return c.json({ error: 'At least one folder is required' }, 400);
  const selectedPermissions =
    accessMode === 'all'
      ? []
      : await filterSelectablePermissionRows({
          userId: user.id,
          accessMode,
          permissions: folderIds.map((folderId) => ({ folderId, canRead, canCreate, canEdit, canComment })),
        });
  if (accessMode !== 'all' && selectedPermissions.length !== folderIds.length)
    return c.json({ error: 'One or more folders cannot be selected' }, 400);

  const now = new Date();
  const code = generateOAuthToken('mnocd');
  await db.transaction(async (tx) => {
    const authorizationId = createId('oauth_auth');
    const [authorization] = await tx
      .insert(integrationAuthorizations)
      .values({
        id: authorizationId,
        userId: user.id,
        accessMode,
        canRead,
        canCreate,
        canEdit,
        canComment,
        canCreateFolders,
        sharedAccessMode,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await tx.insert(oauthAuthorizations).values({
      id: authorizationId,
      integrationAuthorizationId: authorizationId,
      userId: user.id,
      clientId: result.clientId,
      scope: approvedScope,
      createdAt: now,
      updatedAt: now,
    });

    if (sharedAccessMode === 'specific' && collaborationGrantIds.length > 0)
      await tx.insert(authorizationCollaborationScopes).values(
        collaborationGrantIds.map((collaborationGrantId) => ({
          id: createId('auth_collaboration_scope'),
          authorizationId: authorization.id,
          userId: user.id,
          collaborationGrantId,
          createdAt: now,
        }))
      );

    if (accessMode !== 'all' && selectedPermissions.length > 0) {
      await tx
        .insert(authorizationFolderRules)
        .values(
          selectedPermissions.flatMap(({ folderId }) =>
            folderId
              ? [
                  {
                    id: createId('auth_rule'),
                    authorizationId: authorization.id,
                    userId: user.id,
                    folderId,
                    canRead,
                    canCreate,
                    canEdit,
                    canComment,
                    canCreateFolders,
                    appliesTo: accessMode === 'top_level' ? ('subtree' as const) : ('exact' as const),
                    createdAt: now,
                    updatedAt: now,
                  },
                ]
              : []
          )
        )
        .onConflictDoNothing({
          target: [authorizationFolderRules.authorizationId, authorizationFolderRules.folderId],
        });
    }

    await tx.insert(oauthAuthorizationCodes).values({
      id: createId('oauth_code'),
      codeHash: hashOAuthToken(code),
      clientId: result.clientId,
      userId: user.id,
      redirectUri: result.redirectUri,
      scope: approvedScope,
      codeChallenge: result.codeChallenge,
      codeChallengeMethod: result.codeChallengeMethod,
      authorizationId: authorization.id,
      expiresAt: new Date(now.getTime() + AUTHORIZATION_CODE_TTL_MS),
      createdAt: now,
    });
  });

  const url = new URL(result.redirectUri);
  url.searchParams.set('code', code);
  if (body.state) url.searchParams.set('state', body.state);
  return c.json({ redirectUrl: url.toString() });
});

oauthRoutes.get('/authorize', async (c) => {
  const result = await validateAuthorizeRequest({
    clientId: c.req.query('client_id'),
    redirectUri: c.req.query('redirect_uri'),
    responseType: c.req.query('response_type'),
    codeChallenge: c.req.query('code_challenge'),
    codeChallengeMethod: c.req.query('code_challenge_method'),
  });
  if (!result.ok) return c.json(result.error, result.status);
  const url = new URL('/oauth/authorize', frontendUrl);
  for (const [key, value] of new URL(c.req.url).searchParams.entries()) url.searchParams.set(key, value);
  return c.redirect(url.toString(), 302);
});

oauthRoutes.post('/token', async (c) => {
  const body = await c.req.parseBody().catch(() => null);
  if (!body) return c.json(oauthError('invalid_request'), 400);

  const grantType = textParam(body.grant_type);
  if (grantType === 'authorization_code') return exchangeAuthorizationCode(c, body);
  if (grantType === 'refresh_token') return refreshAccessToken(c, body);
  return c.json(oauthError('unsupported_grant_type'), 400);
});

oauthRoutes.post('/revoke', async (c) => {
  const body = await c.req.parseBody().catch(() => null);
  const token = body ? textParam(body.token) : null;
  if (!token) return c.json(oauthError('invalid_request', 'token is required'), 400);

  const tokenHash = hashOAuthToken(token);
  const now = new Date();
  await db
    .update(oauthTokens)
    .set({ revokedAt: now, updatedAt: now })
    .where(eq(oauthTokens.accessTokenHash, tokenHash));
  await db
    .update(oauthTokens)
    .set({ revokedAt: now, updatedAt: now })
    .where(eq(oauthTokens.refreshTokenHash, tokenHash));
  return c.body(null, 200);
});

async function exchangeAuthorizationCode(
  c: Context<{ Variables: Variables }>,
  body: Record<string, FormDataEntryValue | string>
) {
  const code = textParam(body.code);
  const clientId = textParam(body.client_id);
  const redirectUri = textParam(body.redirect_uri);
  const verifier = textParam(body.code_verifier);
  if (!code || !clientId || !redirectUri || !verifier)
    return c.json(oauthError('invalid_request', 'code, client_id, redirect_uri, and code_verifier are required'), 400);

  const [row] = await db
    .select()
    .from(oauthAuthorizationCodes)
    .where(
      and(
        eq(oauthAuthorizationCodes.codeHash, hashOAuthToken(code)),
        eq(oauthAuthorizationCodes.clientId, clientId),
        eq(oauthAuthorizationCodes.redirectUri, redirectUri),
        isNull(oauthAuthorizationCodes.usedAt)
      )
    )
    .limit(1);
  if (!row || row.expiresAt.getTime() <= Date.now()) return c.json(oauthError('invalid_grant'), 400);
  if (!verifyPkce({ verifier, challenge: row.codeChallenge, method: row.codeChallengeMethod }))
    return c.json(oauthError('invalid_grant', 'PKCE verification failed'), 400);

  const now = new Date();
  try {
    const tokens = await claimAndIssueTokens(
      {
        sql: `UPDATE oauth_authorization_codes
              SET used_at = ?
              WHERE id = ? AND used_at IS NULL AND expires_at > ?`,
        args: [toEpochSeconds(now), row.id, toEpochSeconds(now)],
      },
      row.authorizationId,
      now
    );
    return tokens ? c.json(tokens) : c.json(oauthError('invalid_grant'), 400);
  } catch (error) {
    if (isDatabaseBusy(error))
      return c.json(oauthError('temporarily_unavailable', 'The authorization server is temporarily busy'), 503);
    throw error;
  }
}

async function refreshAccessToken(
  c: Context<{ Variables: Variables }>,
  body: Record<string, FormDataEntryValue | string>
) {
  const refreshToken = textParam(body.refresh_token);
  if (!refreshToken) return c.json(oauthError('invalid_request', 'refresh_token is required'), 400);

  const [token] = await db
    .select()
    .from(oauthTokens)
    .where(and(eq(oauthTokens.refreshTokenHash, hashOAuthToken(refreshToken)), isNull(oauthTokens.revokedAt)))
    .limit(1);
  if (!token || token.refreshTokenExpiresAt.getTime() <= Date.now()) return c.json(oauthError('invalid_grant'), 400);

  const now = new Date();
  try {
    const tokens = await claimAndIssueTokens(
      {
        sql: `UPDATE oauth_tokens
              SET revoked_at = ?, updated_at = ?
              WHERE id = ? AND revoked_at IS NULL AND refresh_token_expires_at > ?`,
        args: [toEpochSeconds(now), toEpochSeconds(now), token.id, toEpochSeconds(now)],
      },
      token.authorizationId,
      now
    );
    return tokens ? c.json(tokens) : c.json(oauthError('invalid_grant'), 400);
  } catch (error) {
    if (isDatabaseBusy(error))
      return c.json(oauthError('temporarily_unavailable', 'The authorization server is temporarily busy'), 503);
    throw error;
  }
}

function toEpochSeconds(value: Date) {
  return Math.floor(value.getTime() / 1000);
}

async function claimAndIssueTokens(
  claim: { sql: string; args: Array<string | number> },
  authorizationId: string,
  now: Date
) {
  const accessToken = generateOAuthToken('mnoac');
  const refreshToken = generateOAuthToken('mnort');
  const accessTokenExpiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL_MS);
  const refreshTokenExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);

  const tokenId = createId('oauth_token');
  const results = await withDatabaseBusyRetry(() =>
    libsql.batch(
      [
        claim,
        {
          sql: `INSERT INTO oauth_tokens (
                  id, authorization_id, access_token_hash, refresh_token_hash, scope,
                  access_token_expires_at, refresh_token_expires_at, created_at, updated_at
                )
                SELECT ?, ?, ?, ?, oauth_authorizations.scope, ?, ?, ?, ?
                FROM oauth_authorizations
                WHERE oauth_authorizations.id = ? AND changes() = 1
                RETURNING scope`,
          args: [
            tokenId,
            authorizationId,
            hashOAuthToken(accessToken),
            hashOAuthToken(refreshToken),
            toEpochSeconds(accessTokenExpiresAt),
            toEpochSeconds(refreshTokenExpiresAt),
            toEpochSeconds(now),
            toEpochSeconds(now),
            authorizationId,
          ],
        },
        {
          sql: `UPDATE integration_authorizations
                SET last_used_at = ?, updated_at = ?
                WHERE id = (
                  SELECT integration_authorization_id FROM oauth_authorizations WHERE id = ?
                ) AND EXISTS (SELECT 1 FROM oauth_tokens WHERE id = ?)`,
          args: [toEpochSeconds(now), toEpochSeconds(now), authorizationId, tokenId],
        },
      ],
      'write'
    )
  );
  const scope = results[1]?.rows[0]?.scope;
  if (results[0]?.rowsAffected !== 1 || results[1]?.rows.length !== 1 || typeof scope !== 'string') return null;

  return {
    token_type: 'Bearer',
    access_token: accessToken,
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: refreshToken,
    scope,
  };
}
