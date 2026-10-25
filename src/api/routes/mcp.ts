import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { createNotesMcpServer, type NotesMcpClient } from '../../../packages/mcp/src/server';
import type { ApiKey, OAuthAuthorization } from '../db/schema';
import type { auth } from '../lib/auth';
import type { AuthContext } from '../middleware/authentication';
import { harnessRoutes } from './harness';

type Variables = {
  user: typeof auth.$Infer.Session.user | null;
  session: typeof auth.$Infer.Session.session | null;
  apiKey: ApiKey | null;
  oauthAuthorization: OAuthAuthorization | null;
  authContext: AuthContext;
};

export const mcpRoutes = new Hono<{ Variables: Variables }>();

mcpRoutes.all('/', async (c) => {
  const user = c.get('user');
  const origin = new URL(c.req.url).origin;
  const authChallenge = `Bearer resource_metadata="${origin}/mcp/.well-known/oauth-protected-resource"`;
  if (!user) return c.json({ error: 'Unauthorized' }, 401, { 'WWW-Authenticate': authChallenge });

  const bearer = c.req.raw.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  const oauthAuthorization = c.get('oauthAuthorization');
  if (!bearer || !oauthAuthorization)
    return c.json({ error: 'Hosted MCP requires OAuth bearer authentication' }, 401, {
      'WWW-Authenticate': authChallenge,
    });

  const client = createHostedMcpClient({ user, oauthAuthorization });
  const server = createNotesMcpServer(client);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

function toQueryString(input: Record<string, string | number | boolean | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

function createHostedMcpClient(authState: {
  user: NonNullable<Variables['user']>;
  oauthAuthorization: NonNullable<Variables['oauthAuthorization']>;
}): NotesMcpClient {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', authState.user);
    c.set('session', null);
    c.set('apiKey', null);
    c.set('oauthAuthorization', authState.oauthAuthorization);
    c.set('authContext', {
      type: 'oauth',
      userId: authState.user.id,
      authorizationId: authState.oauthAuthorization.id,
    });
    await next();
  });
  app.route('/', harnessRoutes);

  async function request(path: string, init: RequestInit = {}) {
    const response = await app.request(path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...init.headers,
      },
    });

    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message = typeof body?.error === 'string' ? body.error : 'MinuNotes harness request failed';
      throw new Error(`${message} (${response.status})`);
    }
    return body;
  }

  return {
    folders: {
      templates: (folderId) => request(`/folders/${encodeURIComponent(folderId)}/templates`),
      templatePreview: (folderId, templateId) =>
        request(`/folders/${encodeURIComponent(folderId)}/templates/${encodeURIComponent(templateId)}/preview`),
      properties: (folderId) => request(`/folders/${encodeURIComponent(folderId)}/properties`),
      mutateProperties: (folderId, input) =>
        request(`/folders/${encodeURIComponent(folderId)}/properties`, {
          method: 'PATCH',
          body: JSON.stringify(input),
        }),
      list: (input = {}) => request(`/folders${toQueryString(input)}`),
      create: ({ title, parentFolderId }) =>
        request('/folders', { method: 'POST', body: JSON.stringify({ title, parentFolderId }) }),
      trash: (folderId) => request(`/folders/${encodeURIComponent(folderId)}/trash`, { method: 'POST' }),
    },
    notes: {
      fromTemplate: (input) => request('/notes/from-template', { method: 'POST', body: JSON.stringify(input) }),
      properties: (noteId) => request(`/notes/${encodeURIComponent(noteId)}/properties`),
      patchProperties: (noteId, input) =>
        request(`/notes/${encodeURIComponent(noteId)}/properties`, { method: 'PATCH', body: JSON.stringify(input) }),
      search: (input) =>
        request(
          `/notes/search${toQueryString({ q: input.query, tag: input.tag, limit: input.limit, cursor: input.cursor })}`
        ),
      get: (noteId) => request(`/notes/${encodeURIComponent(noteId)}`),
      create: (folderId, input) =>
        request('/notes', {
          method: 'POST',
          body: JSON.stringify({ folderId, title: input.title, content: input.content }),
        }),
      edit: (noteId, edits, baseHash) =>
        request(`/notes/${encodeURIComponent(noteId)}/edit`, {
          method: 'POST',
          body: JSON.stringify({ edits, baseHash }),
        }),
      move: (input) =>
        request('/notes/move', {
          method: 'POST',
          body: JSON.stringify({ noteIds: input.noteIds, targetFolderId: input.targetFolderId }),
        }),
      trash: (noteId) => request(`/notes/${encodeURIComponent(noteId)}/trash`, { method: 'POST' }),
      searchLines: (input) =>
        request(
          `/notes/search-lines${toQueryString({ q: input.query, folderId: input.folderId, context: input.context, limit: input.limit, caseSensitive: input.caseSensitive, cursor: input.cursor })}`
        ),
      lines: (noteId, input) => request(`/notes/${encodeURIComponent(noteId)}/lines${toQueryString(input)}`),
      searchNoteLines: (noteId, input) =>
        request(
          `/notes/${encodeURIComponent(noteId)}/search-lines${toQueryString({ q: input.query, context: input.context, limit: input.limit, caseSensitive: input.caseSensitive })}`
        ),
      outline: (noteId) => request(`/notes/${encodeURIComponent(noteId)}/outline`),
      section: (noteId, sectionId) =>
        request(`/notes/${encodeURIComponent(noteId)}/sections/${encodeURIComponent(sectionId)}`),
      events: (noteId, limit) => request(`/notes/${encodeURIComponent(noteId)}/events${toQueryString({ limit })}`),
      tags: (noteId) => request(`/notes/${encodeURIComponent(noteId)}/tags`),
      replaceTags: (noteId, tags) =>
        request(`/notes/${encodeURIComponent(noteId)}/tags`, {
          method: 'PUT',
          body: JSON.stringify({ tags }),
        }),
    },
    comments: {
      list: (noteId) => request(`/notes/${encodeURIComponent(noteId)}/comments?includeNoteComments=true`),
      create: (noteId, input) =>
        request(`/notes/${encodeURIComponent(noteId)}/comments`, {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      reply: (noteId, threadId, body) =>
        request(`/notes/${encodeURIComponent(noteId)}/comments/${encodeURIComponent(threadId)}/replies`, {
          method: 'POST',
          body: JSON.stringify({ body }),
        }),
      updateAnchor: (noteId, threadId, anchor) =>
        request(`/notes/${encodeURIComponent(noteId)}/comments/${encodeURIComponent(threadId)}/anchor`, {
          method: 'PATCH',
          body: JSON.stringify({ anchor }),
        }),
      setStatus: (noteId, threadId, status) =>
        request(
          `/notes/${encodeURIComponent(noteId)}/comments/${encodeURIComponent(threadId)}/${status === 'resolved' ? 'resolve' : 'reopen'}`,
          { method: 'POST', body: JSON.stringify({}) }
        ),
      updateMessage: (noteId, threadId, messageId, body) =>
        request(
          `/notes/${encodeURIComponent(noteId)}/comments/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`,
          { method: 'PATCH', body: JSON.stringify({ body }) }
        ),
      toggleReaction: (noteId, threadId, messageId, emoji) =>
        request(
          `/notes/${encodeURIComponent(noteId)}/comments/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/reactions`,
          { method: 'POST', body: JSON.stringify({ emoji }) }
        ),
      deleteMessage: (noteId, threadId, messageId) =>
        request(
          `/notes/${encodeURIComponent(noteId)}/comments/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`,
          { method: 'DELETE' }
        ),
      deleteThread: (noteId, threadId) =>
        request(`/notes/${encodeURIComponent(noteId)}/comments/${encodeURIComponent(threadId)}`, {
          method: 'DELETE',
        }),
    },
    canvases: {
      create: (input) => request('/canvases', { method: 'POST', body: JSON.stringify(input) }),
      createFromSyntax: (input) => request('/canvases/from-syntax', { method: 'POST', body: JSON.stringify(input) }),
      replace: (noteId, input) =>
        request(`/notes/${encodeURIComponent(noteId)}/canvas`, {
          method: 'PUT',
          body: JSON.stringify(input),
        }),
      replaceFromSyntax: (noteId, input) =>
        request(`/notes/${encodeURIComponent(noteId)}/canvas/from-syntax`, {
          method: 'PUT',
          body: JSON.stringify(input),
        }),
      setNoteLink: (noteId, nodeId, input) =>
        request(`/notes/${encodeURIComponent(noteId)}/canvas/nodes/${encodeURIComponent(nodeId)}/link-note`, {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      removeNoteLink: (noteId, nodeId, baseHash) =>
        request(
          `/notes/${encodeURIComponent(noteId)}/canvas/nodes/${encodeURIComponent(nodeId)}/link${toQueryString({ baseHash })}`,
          { method: 'DELETE' }
        ),
    },
    tags: {
      list: (input = {}) => request(`/tags${toQueryString(input)}`),
    },
  };
}
