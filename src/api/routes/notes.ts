import { and, desc, eq, gt, inArray, isNull, ne, or } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { db } from '../db/client';
import { apiKeys, folders, noteShareLinks, notes, templateFolderAssignments, user as users } from '../db/schema';
import {
  type DocumentEdit,
  editDocument,
  listNoteEvents,
  MAX_SEARCH_QUERY_LENGTH,
  moveDocuments,
  readDocument,
  searchDocuments,
  updateDocument,
} from '../harness/commands';
import { findSection, parseSections } from '../harness/sections';
import type { auth } from '../lib/auth';
import {
  type CollaborationAccess,
  collaborationAccessibleNoteWhere,
  collaborationRoleAllows,
  resolveNoteCollaborationAccess,
  resolveNoteCollaborationAccessBatch,
  serializeCollaborationAccess,
} from '../lib/collaboration-access';
import { createCollaborationActorSerializer } from '../lib/collaboration-actor-identity';
import { serializeCollaborationUserIdentity } from '../lib/collaboration-identity';
import { omitCollaborationInternalFields, omitResourceCreator } from '../lib/collaboration-serialization';
import { resolveNoteTrashEligibility, trashEligibilityStatus } from '../lib/collaboration-trash';
import { createId } from '../lib/id';
import { pageRows, parsePageRequest } from '../lib/pagination';
import { buildShareUrl, generateShareToken, hashShareToken } from '../lib/share-tokens';
import {
  addCommentReply,
  type CommentAnchorInput,
  createCommentThread,
  deleteCommentMessage,
  deleteCommentThread,
  listCommentThreads,
  setCommentThreadStatus,
  toggleCommentReaction,
  updateCommentAnchor,
  updateCommentMessage,
} from '../notes/comments';
import { listBacklinks, listOrphanNotes, listOutgoingLinks, sanitizeCanvasNoteLinksForActor } from '../notes/links';
import { compactNoteSelection } from '../notes/listing';
import { listAccessibleTags, listNoteTags, setNoteTags } from '../notes/tags';
import { getNoteVersion, listNoteVersions, restoreNoteVersion, serializeVersion } from '../notes/versions';
import { trashNote, trashNotes } from '../trash/operations';
import { activeFolderWhere, activeNoteWhere } from '../trash/policy';

type Variables = {
  user: typeof auth.$Infer.Session.user | null;
  session: typeof auth.$Infer.Session.session | null;
};

export const noteRoutes = new Hono<{ Variables: Variables }>();

function getUser(c: Context<{ Variables: Variables }>) {
  const user = c.get('user');
  if (!user) return null;
  return user;
}

type DiscoveryScope = 'all' | 'mine' | 'shared';

function parseDiscoveryScope(value: string | undefined): DiscoveryScope | null {
  if (value === undefined || value === 'all') return 'all';
  if (value === 'mine' || value === 'shared') return value;
  return null;
}

async function serializeDiscoveryNotes<
  T extends { id: string; folderId: string; folderTitle?: string | null; userId: string },
>(actorUserId: string, notesToSerialize: readonly T[]) {
  const accessByNoteId = await resolveNoteCollaborationAccessBatch({
    actorUserId,
    resources: notesToSerialize,
  });
  const visible = notesToSerialize.flatMap((note) => {
    const access = accessByNoteId.get(note.id);
    return access ? [{ note, access }] : [];
  });
  const ownerIds = [
    ...new Set(visible.filter((item) => item.access.role !== 'owner').map((item) => item.access.resourceOwnerUserId)),
  ];
  const ownerRows = ownerIds.length
    ? await db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(inArray(users.id, ownerIds))
    : [];
  const ownerIdentities = new Map(
    ownerRows.map((owner) => [owner.id, serializeCollaborationUserIdentity({ ...owner, currentUserId: actorUserId })])
  );
  return visible.map(({ note, access }) => {
    const { userId: _userId, ...publicNote } = note;
    const safeNote =
      access.role === 'owner'
        ? omitResourceCreator(publicNote)
        : { ...omitCollaborationInternalFields(publicNote), updatedByActorId: null };
    return {
      ...(access.source === 'note_grant' ? { ...safeNote, folderId: null, folderTitle: null } : safeNote),
      access: serializeCollaborationAccess(access),
      owner: access.role === 'owner' ? null : (ownerIdentities.get(access.resourceOwnerUserId) ?? null),
    };
  });
}

async function readCollaborativeDocument(actorUserId: string, noteId: string) {
  const access = await resolveNoteCollaborationAccess({ actorUserId, noteId });
  if (!access) return null;
  const result = await readDocument({ documentId: noteId, userId: access.resourceOwnerUserId });
  if (!result.ok) return null;
  if (access.role === 'owner' || !result.value.note.documentType.startsWith('canvas.'))
    return { ...result.value, access, hiddenCanvasLinkCount: 0 };
  const sanitized = await sanitizeCanvasNoteLinksForActor({ actorUserId, content: result.value.note.content });
  return {
    ...result.value,
    note: { ...result.value.note, content: sanitized.content },
    access,
    hiddenCanvasLinkCount: sanitized.hiddenLinkCount,
  };
}

function serializeCollaborativeNote<T extends object>(note: T, access: CollaborationAccess) {
  return access.role === 'owner'
    ? omitResourceCreator(note)
    : { ...omitCollaborationInternalFields(note), updatedByActorId: null };
}

async function withPublicActorUid<
  T extends { userId: string; updatedByActorType: string | null; updatedByActorId: string | null },
>(note: T) {
  if (note.updatedByActorType !== 'agent' || !note.updatedByActorId) return { ...note, updatedByActorUid: null };
  const [key] = await db
    .select({ uid: apiKeys.uid })
    .from(apiKeys)
    .where(and(eq(apiKeys.id, note.updatedByActorId), eq(apiKeys.userId, note.userId)))
    .limit(1);
  return { ...note, updatedByActorUid: key?.uid ?? null };
}

function activeShareWhere(noteId: string, userId: string) {
  const now = new Date();
  return and(
    eq(noteShareLinks.noteId, noteId),
    eq(noteShareLinks.userId, userId),
    isNull(noteShareLinks.revokedAt),
    or(isNull(noteShareLinks.expiresAt), gt(noteShareLinks.expiresAt, now))
  );
}

function serializeShareLink(shareLink: typeof noteShareLinks.$inferSelect, url?: string | null) {
  return {
    id: shareLink.id,
    noteId: shareLink.noteId,
    permission: shareLink.permission,
    createdAt: shareLink.createdAt,
    updatedAt: shareLink.updatedAt,
    expiresAt: shareLink.expiresAt,
    revokedAt: shareLink.revokedAt,
    url: url ?? (shareLink.token ? buildShareUrl(shareLink.token) : null),
  };
}

noteRoutes.get('/tags', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  return c.json({ tags: await listAccessibleTags(user.id) });
});

noteRoutes.get('/templates', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const page = parsePageRequest(c.req.query('page'), c.req.query('limit'));
  const rows = await db
    .select(compactNoteSelection)
    .from(notes)
    .where(activeNoteWhere(user.id, eq(notes.type, 'template')))
    .orderBy(desc(notes.updatedAt), notes.title, notes.id)
    .limit(page.limit + 1)
    .offset(page.offset);
  const result = pageRows(rows, page);
  return c.json({ templates: result.items, page: result.page, limit: result.limit, hasMore: result.hasMore });
});

noteRoutes.get('/templates/:templateId/folders', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const rows = await db
    .select({ folder: folders })
    .from(templateFolderAssignments)
    .innerJoin(folders, eq(templateFolderAssignments.folderId, folders.id))
    .innerJoin(notes, eq(templateFolderAssignments.templateId, notes.id))
    .where(
      and(
        eq(templateFolderAssignments.userId, user.id),
        eq(templateFolderAssignments.templateId, c.req.param('templateId')),
        activeFolderWhere(user.id),
        activeNoteWhere(user.id, eq(notes.type, 'template'))
      )
    );
  return c.json({ folders: rows.map((row) => row.folder) });
});

noteRoutes.put('/templates/:templateId/folders', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const templateId = c.req.param('templateId');
  const [template] = await db
    .select()
    .from(notes)
    .where(activeNoteWhere(user.id, eq(notes.id, templateId), eq(notes.type, 'template')))
    .limit(1);
  if (!template) return c.json({ error: 'Template not found' }, 404);
  const body = (await c.req.json().catch(() => null)) as { folderIds?: string[] } | null;
  const folderIds = [...new Set(body?.folderIds ?? [])];
  if (folderIds.length) {
    const valid = await db
      .select({ id: folders.id })
      .from(folders)
      .where(activeFolderWhere(user.id, inArray(folders.id, folderIds)));
    if (valid.length !== folderIds.length) return c.json({ error: 'One or more folders were not found' }, 400);
  }
  await db
    .delete(templateFolderAssignments)
    .where(and(eq(templateFolderAssignments.userId, user.id), eq(templateFolderAssignments.templateId, templateId)));
  if (folderIds.length) {
    await db.insert(templateFolderAssignments).values(
      folderIds.map((folderId) => ({
        id: crypto.randomUUID(),
        userId: user.id,
        templateId,
        folderId,
        createdAt: new Date(),
      }))
    );
  }
  return c.json({ ok: true });
});

noteRoutes.get('/search', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const page = parsePageRequest(c.req.query('page'), c.req.query('limit'));
  const scope = parseDiscoveryScope(c.req.query('scope'));
  if (!scope) return c.json({ error: 'Scope must be all, mine, or shared' }, 400);
  const q = c.req.query('q')?.trim();
  if (!q) return c.json({ notes: [], page: page.page, limit: page.limit, hasMore: false });
  if (q.length > MAX_SEARCH_QUERY_LENGTH)
    return c.json({ error: `Query must be ${MAX_SEARCH_QUERY_LENGTH} characters or fewer` }, 400);

  const type = c.req.query('type') === 'template' ? 'template' : 'note';
  const tag = c.req.query('tag')?.trim();
  const result = await searchDocuments({
    userId: user.id,
    query: q,
    limit: page.limit,
    offset: page.offset,
    type,
    tag,
    discoveryScope: type === 'note' ? scope : 'mine',
  });
  return c.json({
    notes: await serializeDiscoveryNotes(user.id, result.value.documents),
    page: page.page,
    limit: page.limit,
    hasMore: result.value.pageInfo.hasMore,
  });
});

noteRoutes.get('/recent', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const page = parsePageRequest(c.req.query('page'), c.req.query('limit'), { defaultLimit: 10, maxLimit: 50 });
  const scope = parseDiscoveryScope(c.req.query('scope'));
  if (!scope) return c.json({ error: 'Scope must be all, mine, or shared' }, 400);
  const accessWhere =
    scope === 'mine'
      ? activeNoteWhere(user.id, eq(notes.type, 'note'))
      : scope === 'shared'
        ? collaborationAccessibleNoteWhere(user.id, 'read', eq(notes.type, 'note'), ne(notes.userId, user.id))
        : collaborationAccessibleNoteWhere(user.id, 'read', eq(notes.type, 'note'));
  const rows = await db
    .select({ ...compactNoteSelection, userId: notes.userId })
    .from(notes)
    .where(accessWhere)
    .orderBy(desc(notes.updatedAt), notes.id)
    .limit(page.limit + 1)
    .offset(page.offset);
  const result = pageRows(rows, page);

  return c.json({
    notes: await serializeDiscoveryNotes(user.id, result.items),
    page: result.page,
    limit: result.limit,
    hasMore: result.hasMore,
  });
});

noteRoutes.get('/orphans', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const page = parsePageRequest(c.req.query('page'), c.req.query('limit'));
  const rows = await listOrphanNotes({
    userId: user.id,
    actorUserId: user.id,
    offset: page.offset,
    limit: page.limit + 1,
  });
  const result = pageRows(rows, page);
  const accessByNoteId = await resolveNoteCollaborationAccessBatch({
    actorUserId: user.id,
    resources: result.items,
  });
  const visibleNotes = result.items.map(({ userId: _resourceOwnerUserId, ...note }) =>
    accessByNoteId.get(note.id)?.source === 'note_grant' ? { ...note, folderId: null } : note
  );
  return c.json({ notes: visibleNotes, page: result.page, limit: result.limit, hasMore: result.hasMore });
});

noteRoutes.get('/:noteId/tags', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const noteId = c.req.param('noteId');
  const access = await resolveNoteCollaborationAccess({ actorUserId: user.id, noteId });
  if (!access) return c.json({ error: 'Note not found' }, 404);
  return c.json({ tags: await listNoteTags({ userId: access.resourceOwnerUserId, noteId }) });
});

noteRoutes.put('/:noteId/tags', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const noteId = c.req.param('noteId');
  const current = await readCollaborativeDocument(user.id, noteId);
  if (!current) return c.json({ error: 'Note not found' }, 404);
  const { access } = current;
  if (!collaborationRoleAllows(access.role, 'edit')) return c.json({ error: 'Forbidden' }, 403);
  if (access.role !== 'owner' && current.note.type === 'template') return c.json({ error: 'Forbidden' }, 403);
  const body = (await c.req.json().catch(() => null)) as { tags?: string[] } | null;
  if (!body || !Array.isArray(body.tags)) return c.json({ error: 'Tags array is required' }, 400);
  return c.json({
    tags: await setNoteTags({ userId: access.resourceOwnerUserId, noteId, tags: body.tags }),
  });
});

noteRoutes.get('/:noteId', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const result = await readCollaborativeDocument(user.id, c.req.param('noteId'));
  if (!result) return c.json({ error: 'Note not found' }, 404);
  const noteWithActor = await withPublicActorUid(result.note);
  const note = serializeCollaborativeNote(noteWithActor, result.access);
  const trashEligibility = await resolveNoteTrashEligibility({
    actorUserId: user.id,
    noteId: result.note.id,
    access: result.access,
  });
  return c.json({
    note: result.access.source === 'note_grant' ? { ...note, folderId: null } : note,
    contentHash: result.contentHash,
    access: { ...serializeCollaborationAccess(result.access), canTrash: trashEligibility.allowed },
  });
});

noteRoutes.get('/:noteId/versions', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const limit = Number.parseInt(c.req.query('limit') ?? '', 10);
  const versions = await listNoteVersions({
    noteId: c.req.param('noteId'),
    userId: user.id,
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : undefined,
  });
  if (!versions) return c.json({ error: 'Note not found' }, 404);
  return c.json({ noteId: c.req.param('noteId'), versions });
});

noteRoutes.get('/:noteId/versions/:versionId', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const version = await getNoteVersion({
    noteId: c.req.param('noteId'),
    versionId: c.req.param('versionId'),
    userId: user.id,
  });
  if (!version) return c.json({ error: 'Version not found' }, 404);
  return c.json({ version: serializeVersion(version) });
});

noteRoutes.post('/:noteId/versions/:versionId/restore', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const result = await restoreNoteVersion({
    noteId: c.req.param('noteId'),
    versionId: c.req.param('versionId'),
    userId: user.id,
    actorType: 'user',
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({
    note: await withPublicActorUid(result.value.note),
    contentHash: result.value.contentHash,
    version: result.value.version,
  });
});

async function resolveHumanCommentContext(c: Context<{ Variables: Variables }>) {
  const actor = getUser(c);
  if (!actor) return c.json({ error: 'Unauthorized' }, 401);
  const access = await resolveNoteCollaborationAccess({ actorUserId: actor.id, noteId: c.req.param('noteId') ?? '' });
  if (!access) return c.json({ error: 'Note not found' }, 404);
  if (!collaborationRoleAllows(access.role, 'comment')) return c.json({ error: 'Forbidden' }, 403);
  return { actor, access };
}

function commentErrorResponse(
  c: Context<{ Variables: Variables }>,
  result: { status: 400 | 403 | 404 | 409; error: string; currentHash?: string }
) {
  return c.json(
    { error: result.error, ...(result.currentHash ? { currentHash: result.currentHash } : {}) },
    result.status
  );
}

noteRoutes.get('/:noteId/comments', async (c) => {
  const context = await resolveHumanCommentContext(c);
  if (context instanceof Response) return context;
  const result = await listCommentThreads({
    noteId: c.req.param('noteId'),
    userId: context.access.resourceOwnerUserId,
    actor: { type: 'user', id: context.actor.id },
  });
  if (!result.ok) return commentErrorResponse(c, result);
  return c.json(result.value);
});

noteRoutes.post('/:noteId/comments', async (c) => {
  const context = await resolveHumanCommentContext(c);
  if (context instanceof Response) return context;
  const body = (await c.req.json().catch(() => null)) as {
    body?: string;
    anchor?: CommentAnchorInput;
  } | null;
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);
  if (typeof body.body !== 'string') return c.json({ error: 'Comment body is required' }, 400);
  if (!body.anchor) return c.json({ error: 'Comment anchor is required' }, 400);
  const result = await createCommentThread({
    noteId: c.req.param('noteId'),
    userId: context.access.resourceOwnerUserId,
    actor: { type: 'user', id: context.actor.id },
    body: body.body,
    anchor: body.anchor,
  });
  if (!result.ok) return commentErrorResponse(c, result);
  return c.json(result.value, 201);
});

noteRoutes.post('/:noteId/comments/:threadId/replies', async (c) => {
  const context = await resolveHumanCommentContext(c);
  if (context instanceof Response) return context;
  const body = (await c.req.json().catch(() => null)) as { body?: string } | null;
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);
  if (typeof body.body !== 'string') return c.json({ error: 'Comment body is required' }, 400);
  const result = await addCommentReply({
    noteId: c.req.param('noteId'),
    threadId: c.req.param('threadId'),
    userId: context.access.resourceOwnerUserId,
    actor: { type: 'user', id: context.actor.id },
    body: body.body,
  });
  if (!result.ok) return commentErrorResponse(c, result);
  return c.json(result.value, 201);
});

noteRoutes.patch('/:noteId/comments/:threadId/anchor', async (c) => {
  const context = await resolveHumanCommentContext(c);
  if (context instanceof Response) return context;
  const body = (await c.req.json().catch(() => null)) as { anchor?: CommentAnchorInput } | null;
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);
  if (!body.anchor) return c.json({ error: 'Comment anchor is required' }, 400);
  const result = await updateCommentAnchor({
    noteId: c.req.param('noteId'),
    threadId: c.req.param('threadId'),
    userId: context.access.resourceOwnerUserId,
    actor: { type: 'user', id: context.actor.id },
    anchor: body.anchor,
  });
  if (!result.ok) return commentErrorResponse(c, result);
  return c.json(result.value);
});

for (const [path, status] of [
  ['resolve', 'resolved'],
  ['reopen', 'open'],
] as const) {
  noteRoutes.post(`/:noteId/comments/:threadId/${path}`, async (c) => {
    const context = await resolveHumanCommentContext(c);
    if (context instanceof Response) return context;
    const result = await setCommentThreadStatus({
      noteId: c.req.param('noteId'),
      threadId: c.req.param('threadId'),
      userId: context.access.resourceOwnerUserId,
      actor: { type: 'user', id: context.actor.id },
      status,
      canManageAnyThread: context.access.role === 'owner' || context.access.role === 'editor',
    });
    if (!result.ok) return commentErrorResponse(c, result);
    return c.json(result.value);
  });
}

noteRoutes.patch('/:noteId/comments/:threadId/messages/:messageId', async (c) => {
  const context = await resolveHumanCommentContext(c);
  if (context instanceof Response) return context;
  const body = (await c.req.json().catch(() => null)) as { body?: string } | null;
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);
  if (typeof body.body !== 'string') return c.json({ error: 'Comment body is required' }, 400);
  const result = await updateCommentMessage({
    noteId: c.req.param('noteId'),
    threadId: c.req.param('threadId'),
    messageId: c.req.param('messageId'),
    userId: context.access.resourceOwnerUserId,
    actor: { type: 'user', id: context.actor.id },
    body: body.body,
  });
  if (!result.ok) return commentErrorResponse(c, result);
  return c.json(result.value);
});

noteRoutes.post('/:noteId/comments/:threadId/messages/:messageId/reactions', async (c) => {
  const context = await resolveHumanCommentContext(c);
  if (context instanceof Response) return context;
  const body = (await c.req.json().catch(() => null)) as { emoji?: string } | null;
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);
  if (typeof body.emoji !== 'string') return c.json({ error: 'Reaction emoji is required' }, 400);
  const result = await toggleCommentReaction({
    noteId: c.req.param('noteId'),
    threadId: c.req.param('threadId'),
    messageId: c.req.param('messageId'),
    userId: context.access.resourceOwnerUserId,
    actor: { type: 'user', id: context.actor.id },
    emoji: body.emoji,
  });
  if (!result.ok) return commentErrorResponse(c, result);
  return c.json(result.value);
});

noteRoutes.delete('/:noteId/comments/:threadId/messages/:messageId', async (c) => {
  const context = await resolveHumanCommentContext(c);
  if (context instanceof Response) return context;
  const result = await deleteCommentMessage({
    noteId: c.req.param('noteId'),
    threadId: c.req.param('threadId'),
    messageId: c.req.param('messageId'),
    userId: context.access.resourceOwnerUserId,
    actor: { type: 'user', id: context.actor.id },
  });
  if (!result.ok) return commentErrorResponse(c, result);
  return c.json(result.value);
});

noteRoutes.delete('/:noteId/comments/:threadId', async (c) => {
  const context = await resolveHumanCommentContext(c);
  if (context instanceof Response) return context;
  const result = await deleteCommentThread({
    noteId: c.req.param('noteId'),
    threadId: c.req.param('threadId'),
    userId: context.access.resourceOwnerUserId,
    actor: { type: 'user', id: context.actor.id },
  });
  if (!result.ok) return commentErrorResponse(c, result);
  return c.json(result.value);
});

noteRoutes.get('/:noteId/status', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const result = await readCollaborativeDocument(user.id, c.req.param('noteId'));
  if (!result) return c.json({ error: 'Note not found' }, 404);
  return c.json({
    noteId: result.note.id,
    contentHash: result.contentHash,
    updatedAt: result.note.updatedAt,
  });
});

noteRoutes.get('/:noteId/share-link', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const noteId = c.req.param('noteId');
  const [note] = await db
    .select({ id: notes.id })
    .from(notes)
    .where(activeNoteWhere(user.id, eq(notes.id, noteId)))
    .limit(1);
  if (!note) return c.json({ error: 'Note not found' }, 404);

  const [shareLink] = await db.select().from(noteShareLinks).where(activeShareWhere(noteId, user.id)).limit(1);
  return c.json({ shareLink: shareLink ? serializeShareLink(shareLink) : null });
});

noteRoutes.post('/:noteId/share-link', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const noteId = c.req.param('noteId');
  const [note] = await db
    .select({ id: notes.id })
    .from(notes)
    .where(activeNoteWhere(user.id, eq(notes.id, noteId)))
    .limit(1);
  if (!note) return c.json({ error: 'Note not found' }, 404);

  const body = (await c.req.json().catch(() => null)) as { regenerate?: boolean } | null;
  const [existing] = await db.select().from(noteShareLinks).where(activeShareWhere(noteId, user.id)).limit(1);
  if (existing && !body?.regenerate && existing.token) return c.json({ shareLink: serializeShareLink(existing) });

  const token = generateShareToken();
  const now = new Date();
  if (existing && !body?.regenerate) {
    const [shareLink] = await db
      .update(noteShareLinks)
      .set({ token, tokenHash: hashShareToken(token), updatedAt: now })
      .where(eq(noteShareLinks.id, existing.id))
      .returning();
    return c.json({ shareLink: serializeShareLink(shareLink) });
  }

  if (existing)
    await db.update(noteShareLinks).set({ revokedAt: now, updatedAt: now }).where(eq(noteShareLinks.id, existing.id));
  const [shareLink] = await db
    .insert(noteShareLinks)
    .values({
      id: createId('share'),
      userId: user.id,
      noteId,
      tokenHash: hashShareToken(token),
      token,
      permission: 'read',
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return c.json({ shareLink: serializeShareLink(shareLink) }, 201);
});

noteRoutes.delete('/:noteId/share-link', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const noteId = c.req.param('noteId');
  const [note] = await db
    .select({ id: notes.id })
    .from(notes)
    .where(activeNoteWhere(user.id, eq(notes.id, noteId)))
    .limit(1);
  if (!note) return c.json({ error: 'Note not found' }, 404);

  const now = new Date();
  await db.update(noteShareLinks).set({ revokedAt: now, updatedAt: now }).where(activeShareWhere(noteId, user.id));
  return c.json({ ok: true });
});

noteRoutes.get('/:noteId/links', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const noteId = c.req.param('noteId');
  const access = await resolveNoteCollaborationAccess({ actorUserId: user.id, noteId });
  if (!access) return c.json({ error: 'Note not found' }, 404);
  const links = await listOutgoingLinks({
    userId: access.resourceOwnerUserId,
    actorUserId: user.id,
    noteId,
  });
  if (!links) return c.json({ error: 'Note not found' }, 404);
  return c.json({ noteId: c.req.param('noteId'), links });
});

noteRoutes.get('/:noteId/backlinks', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const noteId = c.req.param('noteId');
  const access = await resolveNoteCollaborationAccess({ actorUserId: user.id, noteId });
  if (!access) return c.json({ error: 'Note not found' }, 404);
  const backlinks = await listBacklinks({
    userId: access.resourceOwnerUserId,
    actorUserId: user.id,
    noteId,
  });
  if (!backlinks) return c.json({ error: 'Note not found' }, 404);
  return c.json({ noteId: c.req.param('noteId'), backlinks });
});

noteRoutes.get('/:noteId/events', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const limit = Number.parseInt(c.req.query('limit') ?? '', 10);
  const result = await listNoteEvents({
    documentId: c.req.param('noteId'),
    userId: user.id,
    limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  const serializeActor = await createCollaborationActorSerializer({
    references: result.value.events.map((event) => ({
      type: event.actorType as 'user' | 'agent' | 'system',
      id: event.actorId ?? (event.actorType === 'user' ? event.userId : null),
    })),
    currentActor: { type: 'user', id: user.id },
  });
  return c.json({
    noteId: result.value.noteId,
    events: result.value.events.map(({ userId: _ownerUserId, actorId, actorType, ...event }) => ({
      ...event,
      actor: serializeActor({
        type: actorType as 'user' | 'agent' | 'system',
        id: actorId ?? (actorType === 'user' ? _ownerUserId : null),
      }),
    })),
  });
});

noteRoutes.get('/:noteId/outline', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const result = await readCollaborativeDocument(user.id, c.req.param('noteId'));
  if (!result) return c.json({ error: 'Note not found' }, 404);

  return c.json({
    noteId: result.note.id,
    contentHash: result.contentHash,
    sections: parseSections(result.note.content),
  });
});

noteRoutes.get('/:noteId/sections/:sectionId', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const result = await readCollaborativeDocument(user.id, c.req.param('noteId'));
  if (!result) return c.json({ error: 'Note not found' }, 404);

  const section = findSection(result.note.content, c.req.param('sectionId'));
  if (!section) return c.json({ error: 'Section not found' }, 404);

  return c.json({
    noteId: result.note.id,
    contentHash: result.contentHash,
    section: {
      ...section,
      markdown: result.note.content.slice(section.from, section.to),
      content: result.note.content.slice(section.contentFrom, section.contentTo),
    },
  });
});

noteRoutes.post('/trash', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const body = (await c.req.json().catch(() => null)) as { noteIds?: string[] } | null;
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);
  if (!Array.isArray(body.noteIds) || body.noteIds.length === 0)
    return c.json({ error: 'At least one note id is required' }, 400);
  if (!body.noteIds.every((noteId) => typeof noteId === 'string' && noteId.length > 0))
    return c.json({ error: 'Note ids must be non-empty strings' }, 400);

  const noteIds = [...new Set(body.noteIds)];
  if (noteIds.length > 100) return c.json({ error: 'No more than 100 notes may be trashed at once' }, 400);

  const eligibility = await Promise.all(
    noteIds.map((noteId) => resolveNoteTrashEligibility({ actorUserId: user.id, noteId }))
  );
  const denied = eligibility.find((item) => !item.allowed);
  if (denied && !denied.allowed) {
    const error = trashEligibilityStatus(denied);
    return c.json(
      { error: error?.status === 404 ? 'One or more notes were not found' : (error?.error ?? 'Forbidden') },
      error?.status ?? 403
    );
  }
  const ownerIds = new Set(eligibility.flatMap((item) => (item.allowed ? [item.resourceOwnerUserId] : [])));
  if (ownerIds.size !== 1) return c.json({ error: 'Notes must belong to the same owner' }, 403);
  const [resourceOwnerUserId] = ownerIds;
  const result = await trashNotes({
    userId: resourceOwnerUserId,
    noteIds,
    actorType: 'user',
    actorId: user.id,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ ok: true, ...result.value });
});

noteRoutes.post('/move', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const body = (await c.req.json().catch(() => null)) as { noteIds?: string[]; targetFolderId?: string } | null;
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);
  if (!Array.isArray(body.noteIds)) return c.json({ error: 'Note ids array is required' }, 400);
  if (!body.noteIds.every((noteId) => typeof noteId === 'string'))
    return c.json({ error: 'Note ids must be strings' }, 400);
  if (!body.targetFolderId) return c.json({ error: 'Target folder id is required' }, 400);

  const result = await moveDocuments({
    documentIds: body.noteIds,
    targetFolderId: body.targetFolderId,
    userId: user.id,
    actorType: 'user',
  });

  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({
    notes: await Promise.all(
      result.value.notes.map(async (item) => ({ ...item, note: await withPublicActorUid(item.note) }))
    ),
  });
});

noteRoutes.post('/:noteId/edit', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const current = await readCollaborativeDocument(user.id, c.req.param('noteId'));
  if (!current) return c.json({ error: 'Note not found' }, 404);
  const { access } = current;
  if (!collaborationRoleAllows(access.role, 'edit')) return c.json({ error: 'Forbidden' }, 403);
  if (access.role !== 'owner' && current.note.type === 'template') return c.json({ error: 'Forbidden' }, 403);

  const body = (await c.req.json().catch(() => null)) as { edits?: DocumentEdit[]; baseHash?: string } | null;
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);
  if (!Array.isArray(body.edits) || body.edits.length === 0)
    return c.json({ error: 'At least one edit is required' }, 400);

  const result = await editDocument({
    documentId: c.req.param('noteId'),
    userId: access.resourceOwnerUserId,
    edits: body.edits,
    baseHash: body.baseHash,
    actorType: 'user',
    actorId: user.id,
  });

  if (!result.ok)
    return c.json(
      { error: result.error, ...('currentHash' in result ? { currentHash: result.currentHash } : {}) },
      result.status
    );
  const note = serializeCollaborativeNote(result.value.note, access);
  return c.json(
    access.source === 'note_grant' ? { ...result.value, note: { ...note, folderId: null } } : { ...result.value, note }
  );
});

noteRoutes.patch('/:noteId', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const current = await readCollaborativeDocument(user.id, c.req.param('noteId'));
  if (!current) return c.json({ error: 'Note not found' }, 404);
  const { access } = current;
  if (!collaborationRoleAllows(access.role, 'edit')) return c.json({ error: 'Forbidden' }, 403);
  if (access.role !== 'owner' && current.note.type === 'template') return c.json({ error: 'Forbidden' }, 403);

  const body = (await c.req.json().catch(() => null)) as {
    title?: string;
    content?: string;
    folderId?: string;
    isApiEditable?: boolean;
    createdAt?: string;
    baseHash?: string;
  } | null;
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);
  if (
    access.role !== 'owner' &&
    (body.folderId !== undefined || body.isApiEditable !== undefined || body.createdAt !== undefined)
  )
    return c.json({ error: 'Collaborators can only change note title and content' }, 403);

  const title = body.title?.trim();
  if (body.title !== undefined && !title) return c.json({ error: 'Note title is required' }, 400);
  if (access.role !== 'owner' && body.content !== undefined && current.hiddenCanvasLinkCount > 0)
    return c.json({ error: 'Canvas contains note links you cannot edit' }, 403);
  let content = body.content;
  if (access.role !== 'owner' && content !== undefined && current.note.documentType.startsWith('canvas.'))
    content = (await sanitizeCanvasNoteLinksForActor({ actorUserId: user.id, content })).content;
  const createdAt = body.createdAt !== undefined ? new Date(body.createdAt) : undefined;
  if (body.createdAt !== undefined && (!createdAt || Number.isNaN(createdAt.getTime())))
    return c.json({ error: 'Invalid created date' }, 400);

  const result = await updateDocument({
    documentId: c.req.param('noteId'),
    userId: access.resourceOwnerUserId,
    title,
    markdown: content,
    folderId: body.folderId,
    isApiEditable: body.isApiEditable,
    createdAt,
    baseHash: body.baseHash,
    actorType: 'user',
    actorId: user.id,
  });

  if (!result.ok)
    return c.json(
      { error: result.error, ...('currentHash' in result ? { currentHash: result.currentHash } : {}) },
      result.status
    );
  let responseValue = result.value;
  if (access.role !== 'owner' && responseValue.note.documentType.startsWith('canvas.')) {
    const sanitized = await sanitizeCanvasNoteLinksForActor({
      actorUserId: user.id,
      content: responseValue.note.content,
    });
    responseValue = { ...responseValue, note: { ...responseValue.note, content: sanitized.content } };
  }
  const note = serializeCollaborativeNote(responseValue.note, access);
  return c.json(
    access.source === 'note_grant'
      ? { ...responseValue, note: { ...note, folderId: null } }
      : { ...responseValue, note }
  );
});

noteRoutes.delete('/:noteId/empty-draft', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const body = (await c.req.json().catch(() => null)) as { createdAt?: unknown; updatedAt?: unknown } | null;
  if (typeof body?.createdAt !== 'string' || typeof body.updatedAt !== 'string')
    return c.json({ error: 'Draft timestamps are required' }, 400);
  const createdAt = new Date(body.createdAt);
  const updatedAt = new Date(body.updatedAt);
  if (
    !Number.isFinite(createdAt.getTime()) ||
    !Number.isFinite(updatedAt.getTime()) ||
    createdAt.toISOString() !== body.createdAt ||
    updatedAt.toISOString() !== body.updatedAt
  )
    return c.json({ error: 'Invalid draft timestamps' }, 400);

  const noteId = c.req.param('noteId');
  const eligibility = await resolveNoteTrashEligibility({ actorUserId: user.id, noteId });
  if (!eligibility.allowed) {
    const error = trashEligibilityStatus(eligibility);
    return c.json(
      { error: error?.status === 404 ? 'Note not found' : (error?.error ?? 'Forbidden') },
      error?.status ?? 403
    );
  }
  const result = await trashNote({
    userId: eligibility.resourceOwnerUserId,
    noteId,
    actorType: 'user',
    actorId: user.id,
    emptyDraft: { creatorUserId: user.id, createdAt, updatedAt },
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ ok: true, ...result.value });
});

noteRoutes.delete('/:noteId', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const noteId = c.req.param('noteId');
  const eligibility = await resolveNoteTrashEligibility({ actorUserId: user.id, noteId });
  if (!eligibility.allowed) {
    const error = trashEligibilityStatus(eligibility);
    return c.json(
      { error: error?.status === 404 ? 'Note not found' : (error?.error ?? 'Forbidden') },
      error?.status ?? 403
    );
  }
  const result = await trashNote({
    userId: eligibility.resourceOwnerUserId,
    noteId,
    actorType: 'user',
    actorId: user.id,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ ok: true, ...result.value });
});
