import { Hono } from 'hono';
import { handle } from 'hono/aws-lambda';
import { cors } from 'hono/cors';
import { libsql } from './db/client';
import type { ApiKey, OAuthAuthorization } from './db/schema';
import type { auth } from './lib/auth';
import { getApiRuntimeConfig } from './lib/env';
import {
  isPublicSharePath,
  reportPublicShareError,
  type ShareObservabilityEnv,
  shareSnapshotObservability,
} from './lib/share-observability';
import {
  type AuthContext,
  authenticationMiddleware,
  harnessApiKeyAuthenticationMiddleware,
  mcpOAuthAuthenticationMiddleware,
} from './middleware/authentication';
import { createRateLimitMiddleware } from './middleware/rate-limit';
import { createRequestSizeLimitMiddleware } from './middleware/request-limits';
import { securityHeadersMiddleware } from './middleware/security-headers';
import { harnessOpenApiSpec } from './openapi/harness';
import { accountRoutes } from './routes/account';
import { apiKeyRoutes } from './routes/api-keys';
import { attachmentRoutes } from './routes/attachments';
import { authRoutes } from './routes/auth';
import { collaborationRoutes } from './routes/collaboration';
import { folderRoutes } from './routes/folders';
import { harnessRoutes } from './routes/harness';
import { mcpRoutes } from './routes/mcp';
import { noteRoutes } from './routes/notes';
import { oauthRoutes } from './routes/oauth';
import { shareRoutes } from './routes/share';
import { trashRoutes } from './routes/trash';

const app = new Hono<{
  Variables: ShareObservabilityEnv['Variables'] & {
    user: typeof auth.$Infer.Session.user | null;
    session: typeof auth.$Infer.Session.session | null;
    apiKey: ApiKey | null;
    oauthAuthorization: OAuthAuthorization | null;
    authContext: AuthContext;
  };
}>();

const { allowedOrigins } = getApiRuntimeConfig();
const authRateLimit = createRateLimitMiddleware({
  windowMs: 60_000,
  max: 60,
  keyPrefix: 'auth',
  skip: (path) => path === '/internal/auth/sign-out' || path === '/internal/auth/get-session',
});
const apiKeyRateLimit = createRateLimitMiddleware({ windowMs: 60_000, max: 30, keyPrefix: 'api-keys' });
const harnessRateLimit = createRateLimitMiddleware({ windowMs: 60_000, max: 120, keyPrefix: 'harness' });
const publicShareRateLimit = createRateLimitMiddleware({ windowMs: 60_000, max: 300, keyPrefix: 'public-share' });
const invitationPreviewRateLimit = createRateLimitMiddleware({
  windowMs: 60_000,
  max: 30,
  keyPrefix: 'collaboration-invitation-preview',
});
const invitationAcceptanceRateLimit = createRateLimitMiddleware({
  windowMs: 60_000,
  max: 10,
  keyPrefix: 'collaboration-invitation-acceptance',
});
const invitationResendRateLimit = createRateLimitMiddleware({
  windowMs: 60_000,
  max: 10,
  keyPrefix: 'collaboration-invitation-resend',
});
const collaboratorManagementRateLimit = createRateLimitMiddleware({
  windowMs: 60_000,
  max: 30,
  keyPrefix: 'collaborator-management',
});
const writeBodyLimit = createRequestSizeLimitMiddleware({ maxBytes: 256 * 1024 });
const uploadBodyLimit = createRequestSizeLimitMiddleware({ maxBytes: 12 * 1024 * 1024 });

app.use('*', securityHeadersMiddleware);
app.use(
  '*',
  cors({
    origin: (origin) => {
      if (!origin) return '';
      return allowedOrigins.includes(origin) ? origin : '';
    },
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'X-API-Key',
      'Mcp-Session-Id',
      'MCP-Protocol-Version',
      'Last-Event-ID',
    ],
    exposeHeaders: ['Mcp-Session-Id'],
    credentials: true,
  })
);

function oauthAuthorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  };
}

function mcpProtectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
    scopes_supported: ['notes.read', 'notes.create', 'notes.edit'],
    resource_documentation: `${origin}/v1/openapi.json`,
  };
}

app.get('/.well-known/oauth-authorization-server', (c) =>
  c.json(oauthAuthorizationServerMetadata(new URL(c.req.url).origin))
);
app.get('/.well-known/oauth-protected-resource', (c) =>
  c.json(mcpProtectedResourceMetadata(new URL(c.req.url).origin))
);
app.get('/mcp/.well-known/oauth-protected-resource', (c) =>
  c.json(mcpProtectedResourceMetadata(new URL(c.req.url).origin))
);
app.get('/openapi.json', (c) => c.json(harnessOpenApiSpec));
app.get('/v1/openapi.json', (c) => c.json(harnessOpenApiSpec));
app.get('/health', async (c) => {
  let dbOk = false;
  try {
    await libsql.execute('select 1');
    dbOk = true;
  } catch (error) {
    console.error('[HEALTH CHECK DB ERROR]', error);
  }

  return c.json(
    {
      ok: dbOk,
      environment: process.env.ENVIRONMENT ?? 'unknown',
      time: new Date().toISOString(),
      db: dbOk,
    },
    dbOk ? 200 : 503
  );
});

app.use('/internal/auth', authRateLimit);
app.use('/internal/auth/*', authRateLimit);
app.use('/oauth/token', authRateLimit);
app.use('/oauth/revoke', authRateLimit);
app.use('/internal/oauth/token', authRateLimit);
app.use('/internal/oauth/revoke', authRateLimit);

app.route('/internal/auth', authRoutes);

app.use('/internal/share/folders/:token', shareSnapshotObservability);
app.use('/internal/share', publicShareRateLimit);
app.use('/internal/share/*', publicShareRateLimit);

app.use('/internal/oauth/authorize/preview', async (c, next) => {
  console.info('[OAUTH PREVIEW REQUEST]', {
    path: c.req.path,
    origin: c.req.raw.headers.get('origin'),
    referer: c.req.raw.headers.get('referer'),
    hasCookieHeader: Boolean(c.req.raw.headers.get('cookie')),
  });
  await next();
});
app.use('/internal/oauth/authorize', authenticationMiddleware);
app.use('/internal/oauth/authorize/*', authenticationMiddleware);
app.use('/internal/oauth/clients', authenticationMiddleware);
app.use('/internal/oauth/clients/*', authenticationMiddleware);
app.use('/internal/oauth/authorizations', authenticationMiddleware);
app.use('/internal/oauth/authorizations/*', authenticationMiddleware);
app.use('/oauth/authorize', authenticationMiddleware);
app.use('/oauth/authorize/*', authenticationMiddleware);
app.use('/oauth/clients', authenticationMiddleware);
app.use('/oauth/clients/*', authenticationMiddleware);
app.use('/oauth/authorizations', authenticationMiddleware);
app.use('/oauth/authorizations/*', authenticationMiddleware);
app.use('/internal/account', authenticationMiddleware);
app.use('/internal/account/*', authenticationMiddleware);
app.use('/internal/folders', authenticationMiddleware);
app.use('/internal/folders/*', authenticationMiddleware);
app.use('/internal/notes/*', authenticationMiddleware);
app.use('/internal/collaborations', authenticationMiddleware);
app.use('/internal/collaborations/*', authenticationMiddleware);
app.use('/internal/collaboration-invitations/:token/accept', authenticationMiddleware);
app.use('/internal/collaboration-invitations/:invitationId/resend', authenticationMiddleware);
app.use('/internal/collaboration-invitations/:invitationId', authenticationMiddleware);
app.use('/internal/trash', authenticationMiddleware);
app.use('/internal/trash/*', authenticationMiddleware);
app.use('/internal/attachments', authenticationMiddleware);
app.use('/internal/attachments/*', authenticationMiddleware);
app.use('/internal/api-keys', authenticationMiddleware);
app.use('/internal/api-keys/*', authenticationMiddleware);
app.use('/v1/harness/*', harnessApiKeyAuthenticationMiddleware);
app.use('/mcp', mcpOAuthAuthenticationMiddleware);
app.use('/mcp/*', mcpOAuthAuthenticationMiddleware);

app.use('/internal/collaboration-invitations/:token/preview', invitationPreviewRateLimit);
app.use('/internal/collaboration-invitations/:token/accept', invitationAcceptanceRateLimit);
app.use('/internal/collaboration-invitations/:invitationId/resend', invitationResendRateLimit);
app.use('/internal/notes/:noteId/collaborators', collaboratorManagementRateLimit);
app.use('/internal/notes/:noteId/collaborators/:accessKey', collaboratorManagementRateLimit);
app.use('/internal/folders/:folderId/collaborators', collaboratorManagementRateLimit);
app.use('/internal/folders/:folderId/collaborators/:accessKey', collaboratorManagementRateLimit);
app.use('/internal/api-keys', apiKeyRateLimit);
app.use('/internal/api-keys/*', apiKeyRateLimit);
app.use('/v1/harness/*', harnessRateLimit);
app.use('/mcp', harnessRateLimit);
app.use('/mcp/*', harnessRateLimit);

app.use('/internal/folders', writeBodyLimit);
app.use('/internal/folders/:folderId', writeBodyLimit);
app.use('/internal/folders/:folderId/notes', writeBodyLimit);
app.use('/internal/notes/:noteId', writeBodyLimit);
app.use('/internal/notes/:noteId/edit', writeBodyLimit);
app.use('/internal/notes/:noteId/comments', writeBodyLimit);
app.use('/internal/notes/:noteId/comments/*', writeBodyLimit);
app.use('/internal/notes/:noteId/collaborators', writeBodyLimit);
app.use('/internal/notes/:noteId/collaborators/*', writeBodyLimit);
app.use('/internal/folders/:folderId/collaborators', writeBodyLimit);
app.use('/internal/folders/:folderId/collaborators/*', writeBodyLimit);
app.use('/internal/collaboration-invitations/:token/accept', writeBodyLimit);
app.use('/internal/collaboration-invitations/:invitationId/resend', writeBodyLimit);
app.use('/internal/notes/:noteId/share-link', writeBodyLimit);
app.use('/internal/trash/notes/:noteId/restore', writeBodyLimit);
app.use('/internal/trash/folders/:folderId/restore', writeBodyLimit);
app.use('/internal/api-keys', writeBodyLimit);
app.use('/internal/api-keys/:keyId', writeBodyLimit);
app.use('/internal/oauth/clients', writeBodyLimit);
app.use('/internal/oauth/clients/:clientId', writeBodyLimit);
app.use('/oauth/clients', writeBodyLimit);
app.use('/oauth/clients/:clientId', writeBodyLimit);
app.use('/v1/harness/folders', writeBodyLimit);
app.use('/v1/harness/notes', writeBodyLimit);
app.use('/v1/harness/notes/:noteId/edit', writeBodyLimit);
app.use('/v1/harness/notes/:noteId/comments', writeBodyLimit);
app.use('/v1/harness/notes/:noteId/comments/*', writeBodyLimit);
app.use('/mcp', writeBodyLimit);
app.use('/mcp/*', writeBodyLimit);
app.use('/internal/attachments/notes/:noteId/images', uploadBodyLimit);
app.use('/internal/attachments/notes/:noteId/image-uploads', writeBodyLimit);
app.use('/internal/attachments/:attachmentId/complete', writeBodyLimit);

app.route('/internal/account', accountRoutes);
app.route('/internal', collaborationRoutes);
app.route('/internal/folders', folderRoutes);
app.route('/internal/notes', noteRoutes);
app.route('/internal/share', shareRoutes);
app.route('/internal/trash', trashRoutes);
app.route('/internal/oauth', oauthRoutes);
app.route('/internal/attachments', attachmentRoutes);
app.route('/internal/api-keys', apiKeyRoutes);
app.route('/v1/harness', harnessRoutes);
app.route('/mcp', mcpRoutes);
app.route('/oauth', oauthRoutes);

app.onError((error, c) => {
  if (isPublicSharePath(c.req.path)) {
    c.header('X-Request-Id', reportPublicShareError(error, c.get('shareSnapshotMeasurement')));
    return c.json({ error: 'Internal Server Error' }, 500);
  }
  console.error('[API ERROR]', {
    method: c.req.method,
    path: c.req.path,
    message: error.message,
    stack: error.stack,
  });
  return c.json({ error: 'Internal Server Error' }, 500);
});

export default app;
export const handler = handle(app);
