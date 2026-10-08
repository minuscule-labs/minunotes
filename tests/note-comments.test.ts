import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectPrivacySafeCollaborationDto } from './helpers/collaboration-privacy';

const tempDirs: string[] = [];

type ThreadResponse = {
  thread: {
    id: string;
    createdBy: { type: 'user' | 'agent'; key: string; label: string; displayName: string | null };
    messages: Array<{ id: string }>;
  };
};

type MessageResponse = { message: { id: string } };

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
  const dir = await mkdtemp(path.join(tmpdir(), 'notes-comments-'));
  tempDirs.push(dir);
  vi.stubEnv('TURSO_DB_URL', `file:${path.join(dir, 'test.db')}`);

  const [{ db, libsql }, schema, { noteRoutes }, { harnessRoutes }, { hashMarkdown }] = await Promise.all([
    import('../src/api/db/client'),
    import('../src/api/db/schema'),
    import('../src/api/routes/notes'),
    import('../src/api/routes/harness'),
    import('../src/api/harness/hash'),
  ]);
  await runMigrations(libsql);

  const now = new Date();
  const owner = {
    id: 'user_owner',
    name: 'Note Owner',
    email: 'owner@example.com',
    emailVerified: true,
    image: null,
    createdAt: now,
    updatedAt: now,
  };
  const otherUser = {
    id: 'user_other',
    name: 'Other User',
    email: 'other@example.com',
    emailVerified: true,
    image: null,
    createdAt: now,
    updatedAt: now,
  };
  const folder = {
    id: 'folder_comments',
    userId: owner.id,
    parentFolderId: null,
    title: 'Comments',
    isPrivate: false,
    isAgentReadOnly: false,
    createdAt: now,
    updatedAt: now,
  };
  const otherFolder = { ...folder, id: 'folder_other', userId: otherUser.id, title: 'Other' };
  const note = {
    id: 'note_comments',
    userId: owner.id,
    folderId: folder.id,
    title: 'Review me',
    content: 'Alpha beta gamma',
    documentType: 'markdown' as const,
    type: 'note' as const,
    isApiEditable: true,
    createdAt: now,
    updatedAt: now,
  };
  const canvas = {
    ...note,
    id: 'note_canvas',
    title: 'Canvas',
    content: '{"nodes":[],"edges":[]}',
    documentType: 'canvas.default' as const,
  };
  const otherNote = { ...note, id: 'note_other', userId: otherUser.id, folderId: otherFolder.id };
  const authorization = {
    id: 'agent_key_comments',
    userId: owner.id,
    canCreateFolders: false,
    canRead: true,
    canCreate: true,
    canEdit: false,
    canComment: true,
    accessMode: 'specific' as const,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
    revokedAt: null,
  };

  const apiKey = {
    ...authorization,
    authorizationId: authorization.id,
    name: 'Reviewer',
    uid: 'REVIEW01',
    hash: 'hash',
    salt: 'salt',
  };

  await db.insert(schema.user).values([owner, otherUser]);
  await db.insert(schema.folders).values([folder, otherFolder]);
  await db.insert(schema.notes).values([note, canvas, otherNote]);
  await db.insert(schema.integrationAuthorizations).values(authorization);
  await db.insert(schema.apiKeys).values(apiKey);
  await db.insert(schema.authorizationFolderRules).values({
    id: 'auth_rule_comments',
    authorizationId: apiKey.id,
    userId: owner.id,
    folderId: folder.id,
    canRead: true,
    canCreate: true,
    canEdit: false,
    canComment: true,
    canCreateFolders: false,
    appliesTo: 'exact',
    createdAt: now,
    updatedAt: now,
  });

  const ownerApp = new Hono();
  ownerApp.use('*', async (c, next) => {
    c.set('user', owner);
    c.set('session', null);
    await next();
  });
  ownerApp.route('/internal/notes', noteRoutes);

  const collaboratorApp = new Hono();
  collaboratorApp.use('*', async (c, next) => {
    c.set('user', otherUser);
    c.set('session', null);
    await next();
  });
  collaboratorApp.route('/internal/notes', noteRoutes);

  const harnessApp = new Hono();
  harnessApp.use('*', async (c, next) => {
    c.set('user', owner);
    c.set('session', null);
    c.set('apiKey', apiKey);
    c.set('oauthAuthorization', null);
    await next();
  });
  harnessApp.route('/v1/harness', harnessRoutes);

  return {
    ownerApp,
    collaboratorApp,
    harnessApp,
    db,
    schema,
    owner,
    otherUser,
    folder,
    note,
    canvas,
    otherNote,
    apiKey,
    hashMarkdown,
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function jsonRequest(method: string, body?: unknown) {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

function rangeAnchor(documentHash: string, extras: Record<string, unknown> = {}) {
  return {
    anchorType: 'range',
    from: 6,
    to: 10,
    quote: 'beta',
    documentHash,
    ...extras,
  };
}

describe('note comments', () => {
  it('counts the same reaction once per actor', async () => {
    const { ownerApp, collaboratorApp, db, schema, owner, otherUser, note, hashMarkdown } = await setupApp();
    await db.insert(schema.collaborationGrants).values({
      id: 'collaboration_grant_reactions',
      ownerUserId: owner.id,
      granteeUserId: otherUser.id,
      noteId: note.id,
      folderId: null,
      role: 'commenter',
      createdByUserId: owner.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const created = await ownerApp.request(
      `/internal/notes/${note.id}/comments`,
      jsonRequest('POST', { body: 'React here.', anchor: rangeAnchor(hashMarkdown(note.content)) })
    );
    const thread = (await created.json()) as ThreadResponse;
    const messageId = thread.thread.messages[0].id;
    const reactionPath = `/internal/notes/${note.id}/comments/${thread.thread.id}/messages/${messageId}/reactions`;

    expect((await ownerApp.request(reactionPath, jsonRequest('POST', { emoji: '👍' }))).status).toBe(200);
    const collaboratorReaction = await collaboratorApp.request(reactionPath, jsonRequest('POST', { emoji: '👍' }));
    expect(collaboratorReaction.status).toBe(200);
    await expect(collaboratorReaction.json()).resolves.toEqual({
      messageId,
      reactions: [{ emoji: '👍', count: 2, reactedByCurrentActor: true }],
    });

    const ownerView = await ownerApp.request(`/internal/notes/${note.id}/comments`);
    await expect(ownerView.json()).resolves.toMatchObject({
      threads: [{ messages: [{ reactions: [{ emoji: '👍', count: 2, reactedByCurrentActor: true }] }] }],
    });
  });

  it('supports the owner thread, reply, edit, resolve, reopen, anchor, and delete lifecycle', async () => {
    const { ownerApp, note, hashMarkdown } = await setupApp();
    const initialHash = hashMarkdown(note.content);

    const created = await ownerApp.request(
      `/internal/notes/${note.id}/comments`,
      jsonRequest('POST', { body: 'Please clarify this.', anchor: rangeAnchor(initialHash) })
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as ThreadResponse;
    expect(createdBody.thread).toMatchObject({
      noteId: note.id,
      status: 'open',
      anchor: { from: 6, to: 10, quote: 'beta', documentHash: initialHash, detached: false },
      createdBy: { type: 'user', label: 'You', displayName: 'Note Owner' },
      messages: [{ body: 'Please clarify this.', author: { label: 'You' } }],
    });
    expect(JSON.stringify(createdBody)).not.toContain('user_owner');
    const threadId = createdBody.thread.id as string;
    const rootMessageId = createdBody.thread.messages[0].id as string;

    const reply = await ownerApp.request(
      `/internal/notes/${note.id}/comments/${threadId}/replies`,
      jsonRequest('POST', { body: 'A follow-up.' })
    );
    expect(reply.status).toBe(201);
    const replyBody = (await reply.json()) as MessageResponse;
    const replyId = replyBody.message.id as string;

    const edited = await ownerApp.request(
      `/internal/notes/${note.id}/comments/${threadId}/messages/${replyId}`,
      jsonRequest('PATCH', { body: 'Updated follow-up.' })
    );
    expect(edited.status).toBe(200);
    await expect(edited.json()).resolves.toMatchObject({ message: { body: 'Updated follow-up.' } });

    const reacted = await ownerApp.request(
      `/internal/notes/${note.id}/comments/${threadId}/messages/${replyId}/reactions`,
      jsonRequest('POST', { emoji: '🎉' })
    );
    expect(reacted.status).toBe(200);
    await expect(reacted.json()).resolves.toEqual({
      messageId: replyId,
      reactions: [{ emoji: '🎉', count: 1, reactedByCurrentActor: true }],
    });
    const listedReaction = await ownerApp.request(`/internal/notes/${note.id}/comments`);
    await expect(listedReaction.json()).resolves.toMatchObject({
      threads: [{ messages: [{ reactions: [] }, { reactions: [{ emoji: '🎉', count: 1 }] }] }],
    });
    const removedReaction = await ownerApp.request(
      `/internal/notes/${note.id}/comments/${threadId}/messages/${replyId}/reactions`,
      jsonRequest('POST', { emoji: '🎉' })
    );
    await expect(removedReaction.json()).resolves.toEqual({ messageId: replyId, reactions: [] });
    const joinedReaction = await ownerApp.request(
      `/internal/notes/${note.id}/comments/${threadId}/messages/${replyId}/reactions`,
      jsonRequest('POST', { emoji: '🧑🏽‍💻' })
    );
    expect(joinedReaction.status).toBe(200);
    await expect(joinedReaction.json()).resolves.toMatchObject({
      reactions: [{ emoji: '🧑🏽‍💻', count: 1, reactedByCurrentActor: true }],
    });
    for (const emoji of ['not emoji', '👍🎉']) {
      const invalidReaction = await ownerApp.request(
        `/internal/notes/${note.id}/comments/${threadId}/messages/${replyId}/reactions`,
        jsonRequest('POST', { emoji })
      );
      expect(invalidReaction.status).toBe(400);
    }

    const resolved = await ownerApp.request(
      `/internal/notes/${note.id}/comments/${threadId}/resolve`,
      jsonRequest('POST', {})
    );
    expect(resolved.status).toBe(200);
    await expect(resolved.json()).resolves.toMatchObject({
      thread: { status: 'resolved', resolvedBy: { label: 'You' } },
    });

    const reopened = await ownerApp.request(
      `/internal/notes/${note.id}/comments/${threadId}/reopen`,
      jsonRequest('POST', {})
    );
    expect(reopened.status).toBe(200);
    await expect(reopened.json()).resolves.toMatchObject({ thread: { status: 'open', resolvedBy: null } });

    const saved = await ownerApp.request(
      `/internal/notes/${note.id}`,
      jsonRequest('PATCH', { content: 'Prefix Alpha beta gamma', baseHash: initialHash })
    );
    expect(saved.status).toBe(200);
    const savedBody = (await saved.json()) as { contentHash: string };
    const anchored = await ownerApp.request(
      `/internal/notes/${note.id}/comments/${threadId}/anchor`,
      jsonRequest('PATCH', {
        anchor: rangeAnchor(savedBody.contentHash, { from: 13, to: 17 }),
      })
    );
    expect(anchored.status).toBe(200);
    await expect(anchored.json()).resolves.toMatchObject({
      thread: { anchor: { from: 13, to: 17, quote: 'beta', documentHash: savedBody.contentHash } },
    });

    const deletedReply = await ownerApp.request(`/internal/notes/${note.id}/comments/${threadId}/messages/${replyId}`, {
      method: 'DELETE',
    });
    expect(deletedReply.status).toBe(200);
    await expect(deletedReply.json()).resolves.toEqual({ ok: true, deletedThread: false });

    const deletedRoot = await ownerApp.request(
      `/internal/notes/${note.id}/comments/${threadId}/messages/${rootMessageId}`,
      { method: 'DELETE' }
    );
    expect(deletedRoot.status).toBe(200);
    await expect(deletedRoot.json()).resolves.toEqual({ ok: true, deletedThread: true });

    const listed = await ownerApp.request(`/internal/notes/${note.id}/comments`);
    await expect(listed.json()).resolves.toMatchObject({ threads: [] });
  });

  it('rejects stale, invalid, canvas, and template comment anchors', async () => {
    const { ownerApp, note, canvas, db, schema, hashMarkdown } = await setupApp();
    const currentHash = hashMarkdown(note.content);

    const stale = await ownerApp.request(
      `/internal/notes/${note.id}/comments`,
      jsonRequest('POST', { body: 'Stale', anchor: rangeAnchor('stale_hash') })
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({
      error: 'Document has changed since the comment anchor was created',
      currentHash,
    });

    const mismatch = await ownerApp.request(
      `/internal/notes/${note.id}/comments`,
      jsonRequest('POST', { body: 'Mismatch', anchor: rangeAnchor(currentHash, { quote: 'nope' }) })
    );
    expect(mismatch.status).toBe(400);

    const canvasResponse = await ownerApp.request(
      `/internal/notes/${canvas.id}/comments`,
      jsonRequest('POST', {
        body: 'Canvas comment',
        anchor: { anchorType: 'range', from: 0, to: 1, quote: '{', documentHash: hashMarkdown(canvas.content) },
      })
    );
    expect(canvasResponse.status).toBe(400);
    await expect(canvasResponse.json()).resolves.toEqual({ error: 'Comments are only supported for markdown notes' });

    await db.update(schema.notes).set({ type: 'template' }).where(eq(schema.notes.id, note.id));
    const templateResponse = await ownerApp.request(`/internal/notes/${note.id}/comments`);
    expect(templateResponse.status).toBe(400);
    await expect(templateResponse.json()).resolves.toEqual({ error: 'Comments are not supported for templates' });
  });

  it('reattaches uniquely shifted quotes and marks removed quotes detached', async () => {
    const { ownerApp, note, hashMarkdown } = await setupApp();
    const initialHash = hashMarkdown(note.content);
    const created = await ownerApp.request(
      `/internal/notes/${note.id}/comments`,
      jsonRequest('POST', { body: 'Track beta', anchor: rangeAnchor(initialHash) })
    );
    expect(created.status).toBe(201);

    const shiftedSave = await ownerApp.request(
      `/internal/notes/${note.id}`,
      jsonRequest('PATCH', { content: 'Prefix Alpha beta gamma', baseHash: initialHash })
    );
    expect(shiftedSave.status).toBe(200);
    const shifted = await ownerApp.request(`/internal/notes/${note.id}/comments`);
    await expect(shifted.json()).resolves.toMatchObject({
      threads: [{ anchor: { from: 13, to: 17, quote: 'beta', detached: false } }],
    });

    const shiftedBody = (await shiftedSave.json()) as { contentHash: string };
    const removedSave = await ownerApp.request(
      `/internal/notes/${note.id}`,
      jsonRequest('PATCH', { content: 'Prefix Alpha gamma', baseHash: shiftedBody.contentHash })
    );
    expect(removedSave.status).toBe(200);
    const detached = await ownerApp.request(`/internal/notes/${note.id}/comments`);
    await expect(detached.json()).resolves.toMatchObject({
      threads: [{ anchor: { quote: 'beta', detached: true } }],
    });
  });

  it('enforces collaborator comment roles, authorship, identity, and revocation', async () => {
    const { ownerApp, collaboratorApp, db, schema, owner, otherUser, note, hashMarkdown } = await setupApp();
    const now = new Date();
    await db.insert(schema.collaborationGrants).values({
      id: 'comment_grant',
      ownerUserId: owner.id,
      granteeUserId: otherUser.id,
      noteId: note.id,
      folderId: null,
      role: 'viewer',
      createdByUserId: owner.id,
      createdAt: now,
      updatedAt: now,
    });

    const viewerList = await collaboratorApp.request(`/internal/notes/${note.id}/comments`);
    expect(viewerList.status).toBe(403);

    await db
      .update(schema.collaborationGrants)
      .set({ role: 'commenter', updatedAt: new Date() })
      .where(eq(schema.collaborationGrants.id, 'comment_grant'));
    const ownerCreated = await ownerApp.request(
      `/internal/notes/${note.id}/comments`,
      jsonRequest('POST', { body: 'Owner review', anchor: rangeAnchor(hashMarkdown(note.content)) })
    );
    const ownerThread = (await ownerCreated.json()) as ThreadResponse;
    const ownerThreadId = ownerThread.thread.id;
    const ownerMessageId = ownerThread.thread.messages[0].id;

    const readable = await collaboratorApp.request(`/internal/notes/${note.id}/comments`);
    expect(readable.status).toBe(200);
    const readableBody = await readable.json();
    expect(readableBody).toMatchObject({
      threads: [{ createdBy: { label: owner.name, displayName: owner.name } }],
    });
    expectPrivacySafeCollaborationDto(readableBody, {
      forbiddenValues: [owner.id, otherUser.id, owner.email, otherUser.email, 'comment_grant'],
    });

    const collaboratorCreated = await collaboratorApp.request(
      `/internal/notes/${note.id}/comments`,
      jsonRequest('POST', {
        body: 'Collaborator review',
        anchor: rangeAnchor(hashMarkdown(note.content), { from: 11, to: 16, quote: 'gamma' }),
      })
    );
    expect(collaboratorCreated.status).toBe(201);
    const collaboratorThread = (await collaboratorCreated.json()) as ThreadResponse;
    expect(collaboratorThread.thread.createdBy).toMatchObject({
      type: 'user',
      label: 'You',
      displayName: otherUser.name,
    });
    expect(collaboratorThread.thread.createdBy.key).toMatch(/^user_[a-f0-9]{16}$/);
    expect(collaboratorThread.thread.createdBy.key).not.toContain(otherUser.id);

    const ownerResolve = await collaboratorApp.request(
      `/internal/notes/${note.id}/comments/${ownerThreadId}/resolve`,
      jsonRequest('POST', {})
    );
    expect(ownerResolve.status).toBe(403);
    const ownResolve = await collaboratorApp.request(
      `/internal/notes/${note.id}/comments/${collaboratorThread.thread.id}/resolve`,
      jsonRequest('POST', {})
    );
    expect(ownResolve.status).toBe(200);
    const ownerEdit = await collaboratorApp.request(
      `/internal/notes/${note.id}/comments/${ownerThreadId}/messages/${ownerMessageId}`,
      jsonRequest('PATCH', { body: 'Overwrite owner' })
    );
    expect(ownerEdit.status).toBe(403);
    const ownerAnchor = await collaboratorApp.request(
      `/internal/notes/${note.id}/comments/${ownerThreadId}/anchor`,
      jsonRequest('PATCH', { anchor: rangeAnchor(hashMarkdown(note.content)) })
    );
    expect(ownerAnchor.status).toBe(403);
    const ownerDelete = await collaboratorApp.request(`/internal/notes/${note.id}/comments/${ownerThreadId}`, {
      method: 'DELETE',
    });
    expect(ownerDelete.status).toBe(403);

    await db
      .update(schema.collaborationGrants)
      .set({ role: 'editor', updatedAt: new Date() })
      .where(eq(schema.collaborationGrants.id, 'comment_grant'));
    const editorResolve = await collaboratorApp.request(
      `/internal/notes/${note.id}/comments/${ownerThreadId}/resolve`,
      jsonRequest('POST', {})
    );
    expect(editorResolve.status).toBe(200);

    await db.delete(schema.collaborationGrants).where(eq(schema.collaborationGrants.id, 'comment_grant'));
    const revoked = await collaboratorApp.request(`/internal/notes/${note.id}/comments`);
    expect(revoked.status).toBe(404);
  });

  it('serializes OAuth comment actors with the app name and no internal authorization id', async () => {
    const { db, schema, owner, note, hashMarkdown } = await setupApp();
    const now = new Date();
    await db.insert(schema.integrationAuthorizations).values({
      id: 'oauth_integration_comments',
      userId: owner.id,
      canCreateFolders: false,
      canRead: true,
      canCreate: false,
      canEdit: false,
      canComment: true,
      accessMode: 'all',
      sharedAccessMode: 'none',
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      revokedAt: null,
    });
    await db.insert(schema.oauthClients).values({
      id: 'oauth_client_comments',
      userId: owner.id,
      name: 'Review App',
      description: null,
      redirectUris: '["https://example.com/callback"]',
      clientType: 'public',
      clientSecretHash: null,
      createdAt: now,
      updatedAt: now,
      revokedAt: null,
    });
    await db.insert(schema.oauthAuthorizations).values({
      id: 'oauth_connection_comments',
      userId: owner.id,
      integrationAuthorizationId: 'oauth_integration_comments',
      clientId: 'oauth_client_comments',
      scope: 'notes.read notes.comment',
      createdAt: now,
      updatedAt: now,
    });

    const { createCommentThread } = await import('../src/api/notes/comments');
    const result = await createCommentThread({
      noteId: note.id,
      userId: owner.id,
      actor: { type: 'agent', id: 'oauth_connection_comments' },
      body: 'OAuth review',
      anchor: rangeAnchor(hashMarkdown(note.content)),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.thread.createdBy).toMatchObject({
      type: 'agent',
      label: 'Review App',
      displayName: 'Review App',
    });
    expect(result.value.thread.createdBy.key).toMatch(/^agent_[a-f0-9]{16}$/);
    expect(JSON.stringify(result.value)).not.toContain('oauth_connection_comments');
  });

  it('supports explicit comment-only API keys while enforcing scope and authorship', async () => {
    const { ownerApp, harnessApp, note, db, schema, apiKey, hashMarkdown } = await setupApp();
    const currentHash = hashMarkdown(note.content);

    const ownerCreated = await ownerApp.request(
      `/internal/notes/${note.id}/comments`,
      jsonRequest('POST', { body: 'Owner thread', anchor: rangeAnchor(currentHash) })
    );
    const ownerThread = (await ownerCreated.json()) as ThreadResponse;
    const ownerThreadId = ownerThread.thread.id as string;
    const ownerMessageId = ownerThread.thread.messages[0].id as string;

    const forbiddenEdit = await harnessApp.request(
      `/v1/harness/notes/${note.id}/comments/${ownerThreadId}/messages/${ownerMessageId}`,
      jsonRequest('PATCH', { body: 'Agent overwrite' })
    );
    expect(forbiddenEdit.status).toBe(403);

    const forbiddenResolve = await harnessApp.request(
      `/v1/harness/notes/${note.id}/comments/${ownerThreadId}/resolve`,
      jsonRequest('POST', {})
    );
    expect(forbiddenResolve.status).toBe(403);

    const agentCreated = await harnessApp.request(
      `/v1/harness/notes/${note.id}/comments`,
      jsonRequest('POST', {
        body: 'Agent review',
        anchor: rangeAnchor(currentHash, { from: 11, to: 16, quote: 'gamma' }),
      })
    );
    expect(agentCreated.status).toBe(201);
    const agentBody = (await agentCreated.json()) as ThreadResponse;
    expect(agentBody.thread.createdBy).toMatchObject({
      type: 'agent',
      label: apiKey.name,
      displayName: apiKey.name,
      isCurrentUser: true,
    });
    expect(JSON.stringify(agentBody)).not.toContain(apiKey.id);

    const agentResolved = await harnessApp.request(
      `/v1/harness/notes/${note.id}/comments/${agentBody.thread.id}/resolve`,
      jsonRequest('POST', {})
    );
    expect(agentResolved.status).toBe(200);

    await db.update(schema.notes).set({ isApiEditable: false }).where(eq(schema.notes.id, note.id));
    const readable = await harnessApp.request(`/v1/harness/notes/${note.id}/comments`);
    expect(readable.status).toBe(200);
    const commentOnlyReply = await harnessApp.request(
      `/v1/harness/notes/${note.id}/comments/${agentBody.thread.id}/replies`,
      jsonRequest('POST', { body: 'Comment-only reply' })
    );
    expect(commentOnlyReply.status).toBe(201);

    const agentReaction = await harnessApp.request(
      `/v1/harness/notes/${note.id}/comments/${ownerThreadId}/messages/${ownerMessageId}/reactions`,
      jsonRequest('POST', { emoji: '👀' })
    );
    expect(agentReaction.status).toBe(200);
    await expect(agentReaction.json()).resolves.toMatchObject({
      reactions: [{ emoji: '👀', count: 1, reactedByCurrentActor: true }],
    });
    const ownerReactionView = await ownerApp.request(`/internal/notes/${note.id}/comments`);
    const ownerReactionBody = (await ownerReactionView.json()) as {
      threads: Array<{ id: string; messages: Array<{ reactions: unknown[] }> }>;
    };
    expect(ownerReactionBody.threads.find((thread) => thread.id === ownerThreadId)?.messages[0]?.reactions).toEqual([
      { emoji: '👀', count: 1, reactedByCurrentActor: false },
    ]);

    await db
      .update(schema.authorizationFolderRules)
      .set({ canComment: false })
      .where(eq(schema.authorizationFolderRules.authorizationId, apiKey.id));
    const folderBlocked = await harnessApp.request(`/v1/harness/notes/${note.id}/comments`);
    expect(folderBlocked.status).toBe(403);

    await db
      .update(schema.authorizationFolderRules)
      .set({ canComment: true })
      .where(eq(schema.authorizationFolderRules.authorizationId, apiKey.id));
    apiKey.canEdit = true;
    apiKey.canComment = false;
    const keyBlocked = await harnessApp.request(`/v1/harness/notes/${note.id}/comments`);
    expect(keyBlocked.status).toBe(403);
  });

  it('hides comments while trashed, retains them on restore, isolates users, and cascades permanent deletion', async () => {
    const { ownerApp, harnessApp, note, otherNote, db, schema, hashMarkdown } = await setupApp();
    const created = await ownerApp.request(
      `/internal/notes/${note.id}/comments`,
      jsonRequest('POST', { body: 'Retain me', anchor: rangeAnchor(hashMarkdown(note.content)) })
    );
    expect(created.status).toBe(201);
    const createdThread = (await created.json()) as ThreadResponse;
    await ownerApp.request(
      `/internal/notes/${note.id}/comments/${createdThread.thread.id}/messages/${createdThread.thread.messages[0].id}/reactions`,
      jsonRequest('POST', { emoji: '👍' })
    );

    const isolated = await harnessApp.request(`/v1/harness/notes/${otherNote.id}/comments`);
    expect(isolated.status).toBe(404);

    await db.update(schema.notes).set({ deletedAt: new Date() }).where(eq(schema.notes.id, note.id));
    const trashed = await ownerApp.request(`/internal/notes/${note.id}/comments`);
    expect(trashed.status).toBe(404);

    await db.update(schema.notes).set({ deletedAt: null }).where(eq(schema.notes.id, note.id));
    const restored = await ownerApp.request(`/internal/notes/${note.id}/comments`);
    expect(restored.status).toBe(200);
    await expect(restored.json()).resolves.toMatchObject({ threads: [{ messages: [{ body: 'Retain me' }] }] });

    await db.delete(schema.notes).where(and(eq(schema.notes.id, note.id), eq(schema.notes.userId, note.userId)));
    await expect(db.select().from(schema.noteCommentThreads)).resolves.toHaveLength(0);
    await expect(db.select().from(schema.noteCommentMessages)).resolves.toHaveLength(0);
    await expect(db.select().from(schema.noteCommentMessageReactions)).resolves.toHaveLength(0);
  });
});
