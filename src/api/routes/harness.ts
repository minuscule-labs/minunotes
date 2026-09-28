import { eq, inArray } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { db } from '../db/client';
import {
  type ApiKey,
  authorizationFolderRules,
  folders,
  type Note,
  notes,
  type OAuthAuthorization,
} from '../db/schema';
import {
  type CanvasSyntaxFormat,
  canvasDocumentFromSyntax,
  createDocument,
  type DocumentEdit,
  type DocumentType,
  editDocument,
  isCanvasSyntaxFormat,
  type LineSearchCursor,
  linkCanvasNodeToNote,
  listFolders,
  listNoteEvents,
  MAX_SEARCH_QUERY_LENGTH,
  moveDocuments,
  type NoteSearchCursor,
  readDocument,
  readDocumentLines,
  replaceCanvasDocument,
  searchAllDocumentLines,
  searchDocumentLines,
  searchDocuments,
  serializeCanvasDocument,
  unlinkCanvasNode,
} from '../harness/commands';
import { hashMarkdown } from '../harness/hash';
import {
  compareTitleIdPositions,
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
  isTitleIdPosition,
  paginateItems,
  paginationScope,
  parsePageLimit,
} from '../harness/pagination';
import { findSection, parseSections } from '../harness/sections';
import type { auth } from '../lib/auth';
import {
  type CollaborationAccess,
  collaborationAccessibleNoteWhere,
  integrationAccessibleFolderWhere,
  integrationAccessibleNoteWhere,
  resolveIntegrationFolderAccess,
  resolveIntegrationNoteAccess,
  resolveIntegrationReadAccessBatch,
  resolveNoteCollaborationAccessBatch,
} from '../lib/collaboration-access';
import { createCollaborationActorSerializer } from '../lib/collaboration-actor-identity';
import { omitResourceCreator } from '../lib/collaboration-serialization';
import {
  resolveFolderTrashEligibility,
  resolveNoteTrashEligibility,
  trashEligibilityStatus,
} from '../lib/collaboration-trash';
import {
  canIntegrationAccessFolder,
  getIntegrationAccessibleFolderIds,
  validateFolderParent,
} from '../lib/folder-access';
import { createId } from '../lib/id';
import { type AuthorizationCapability, capabilitiesAllow } from '../lib/integration-authorization';
import {
  addCommentReply,
  type CommentActor,
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
import {
  listBacklinks,
  listOrphanNotes,
  listOutgoingLinks,
  parseCanvasNoteLinks,
  sanitizeCanvasNoteLinksForVisibleTargets,
} from '../notes/links';
import { listIntegrationAccessibleTags, listNoteTags, listUserTags, setNoteTags } from '../notes/tags';
import { trashFolder, trashNote } from '../trash/operations';

type Variables = {
  user: typeof auth.$Infer.Session.user | null;
  session: typeof auth.$Infer.Session.session | null;
  apiKey: ApiKey | null;
  oauthAuthorization: OAuthAuthorization | null;
};

export const harnessRoutes = new Hono<{ Variables: Variables }>();

function getUser(c: Context<{ Variables: Variables }>) {
  const user = c.get('user');
  if (!user) return null;
  return user;
}

function getIntegrationAuthorization(c: Context<{ Variables: Variables }>) {
  const apiKey = c.get('apiKey');
  if (apiKey)
    return {
      actor: apiKey,
      authorizationId: apiKey.authorizationId,
      sharedAccessMode: apiKey.sharedAccessMode ?? 'none',
    };
  const oauthAuthorization = c.get('oauthAuthorization');
  if (oauthAuthorization)
    return {
      actor: oauthAuthorization,
      authorizationId: oauthAuthorization.integrationAuthorizationId,
      sharedAccessMode: oauthAuthorization.sharedAccessMode ?? 'none',
    };
  return null;
}

async function canReadHarnessCanvasTarget(c: Context<{ Variables: Variables }>, noteId: string) {
  const user = getUser(c);
  if (!user) return false;
  const integration = getIntegrationAuthorization(c);
  if (!integration || !capabilitiesAllow(integration.actor, 'read')) return false;
  const owned = await readDocument({ documentId: noteId, userId: user.id });
  if (owned.ok) return hasFolderPermission(c, owned.value.note.folderId, 'read');
  if (!integration.authorizationId) return false;
  return Boolean(
    await resolveIntegrationNoteAccess({
      actorUserId: user.id,
      authorizationId: integration.authorizationId,
      sharedAccessMode: integration.sharedAccessMode,
      noteId,
      capability: 'read',
    })
  );
}

async function sanitizeHarnessCanvasContent(c: Context<{ Variables: Variables }>, content: string) {
  const targetIds = [
    ...new Set(
      parseCanvasNoteLinks(content)
        .map((link) => link.targetNoteId)
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const visibility = await Promise.all(
    targetIds.map(async (targetId) => [targetId, await canReadHarnessCanvasTarget(c, targetId)] as const)
  );
  return sanitizeCanvasNoteLinksForVisibleTargets({
    content,
    visibleTargetIds: new Set(visibility.filter(([, visible]) => visible).map(([targetId]) => targetId)),
  });
}

async function readHarnessDocument(
  c: Context<{ Variables: Variables }>,
  noteId: string,
  capability: AuthorizationCapability
) {
  const user = getUser(c);
  if (!user) return null;
  const integration = getIntegrationAuthorization(c);
  if (integration && !capabilitiesAllow(integration.actor, capability)) return null;

  const owned = await readDocument({ documentId: noteId, userId: user.id });
  if (owned.ok) {
    if (!(await hasFolderPermission(c, owned.value.note.folderId, capability))) return null;
    const sanitized = owned.value.note.documentType.startsWith('canvas.')
      ? await sanitizeHarnessCanvasContent(c, owned.value.note.content)
      : { content: owned.value.note.content, hiddenLinkCount: 0 };
    return {
      ...owned.value,
      note: { ...owned.value.note, content: sanitized.content },
      contentHash: hashMarkdown(sanitized.content),
      rawContentHash: owned.value.contentHash,
      hiddenCanvasLinkCount: sanitized.hiddenLinkCount,
      resourceOwnerUserId: user.id,
      role: 'owner' as const,
      source: 'owner' as const,
    };
  }
  if (!integration?.authorizationId) return null;
  const access = await resolveIntegrationNoteAccess({
    actorUserId: user.id,
    authorizationId: integration.authorizationId,
    sharedAccessMode: integration.sharedAccessMode,
    noteId,
    capability,
  });
  if (!access || access.source === 'owner') return null;
  const shared = await readDocument({ documentId: noteId, userId: access.resourceOwnerUserId });
  if (!shared.ok) return null;
  const sanitized = shared.value.note.documentType.startsWith('canvas.')
    ? await sanitizeHarnessCanvasContent(c, shared.value.note.content)
    : { content: shared.value.note.content, hiddenLinkCount: 0 };
  const note = { ...shared.value.note, content: sanitized.content };
  return {
    ...shared.value,
    note: access.source === 'note_grant' ? { ...note, folderId: null } : note,
    contentHash: hashMarkdown(sanitized.content),
    rawContentHash: shared.value.contentHash,
    hiddenCanvasLinkCount: sanitized.hiddenLinkCount,
    resourceOwnerUserId: access.resourceOwnerUserId,
    role: access.role,
    source: access.source,
  };
}

async function resolveHarnessLinkedNoteAccessBatch(c: Context<{ Variables: Variables }>, noteIds: readonly string[]) {
  const user = getUser(c);
  if (!user || noteIds.length === 0) return new Map<string, CollaborationAccess>();
  const integration = getIntegrationAuthorization(c);
  if (integration && (!integration.authorizationId || !capabilitiesAllow(integration.actor, 'read')))
    return new Map<string, CollaborationAccess>();

  const readableFolderIds = integration ? await getReadableFolderIds(c) : null;
  const uniqueNoteIds = [...new Set(noteIds)];
  const resources: Array<{ id: string; folderId: string; userId: string }> = [];
  for (let start = 0; start < uniqueNoteIds.length; start += 500) {
    const idBatch = uniqueNoteIds.slice(start, start + 500);
    resources.push(
      ...(await db
        .select({ id: notes.id, folderId: notes.folderId, userId: notes.userId })
        .from(notes)
        .where(
          integration?.authorizationId
            ? integrationAccessibleNoteWhere(
                {
                  actorUserId: user.id,
                  authorizationId: integration.authorizationId,
                  sharedAccessMode: integration.sharedAccessMode,
                  ownedFolderIds: readableFolderIds ?? new Set(),
                },
                inArray(notes.id, idBatch)
              )
            : collaborationAccessibleNoteWhere(user.id, 'read', inArray(notes.id, idBatch))
        ))
    );
  }

  return integration?.authorizationId
    ? resolveIntegrationReadAccessBatch({
        actorUserId: user.id,
        authorizationId: integration.authorizationId,
        sharedAccessMode: integration.sharedAccessMode,
        resources,
      })
    : resolveNoteCollaborationAccessBatch({ actorUserId: user.id, resources });
}

async function resolveHarnessFolder(
  c: Context<{ Variables: Variables }>,
  folderId: string,
  capability: AuthorizationCapability
) {
  const user = getUser(c);
  if (!user) return null;
  const integration = getIntegrationAuthorization(c);
  if (integration && !capabilitiesAllow(integration.actor, capability)) return null;
  const [owned] = await db
    .select({ id: folders.id, userId: folders.userId })
    .from(folders)
    .where(eq(folders.id, folderId))
    .limit(1);
  if (owned?.userId === user.id)
    return (await hasFolderPermission(c, folderId, capability))
      ? { resourceOwnerUserId: user.id, role: 'owner' as const, source: 'owner' as const }
      : null;
  if (!integration?.authorizationId) return null;
  const access = await resolveIntegrationFolderAccess({
    actorUserId: user.id,
    authorizationId: integration.authorizationId,
    sharedAccessMode: integration.sharedAccessMode,
    folderId,
    capability,
  });
  return access ? { resourceOwnerUserId: access.resourceOwnerUserId, role: access.role, source: access.source } : null;
}

async function harnessDocumentDeniedStatus(userId: string, noteId: string) {
  return (await readDocument({ documentId: noteId, userId })).ok ? (403 as const) : (404 as const);
}

function getActor(c: Context<{ Variables: Variables }>): { actorType: 'user' | 'agent'; actorId?: string } {
  const key = c.get('apiKey');
  const oauthAuthorization = c.get('oauthAuthorization');
  return key
    ? { actorType: 'agent', actorId: key.id }
    : oauthAuthorization
      ? { actorType: 'agent', actorId: oauthAuthorization.id }
      : { actorType: 'user' };
}

type HarnessNoteSummary = Pick<Note, 'id' | 'folderId' | 'title' | 'documentType' | 'type' | 'createdAt' | 'updatedAt'>;
type HarnessFolderSummary = Pick<
  typeof folders.$inferSelect,
  'id' | 'parentFolderId' | 'title' | 'isPrivate' | 'isAgentReadOnly' | 'createdAt' | 'updatedAt'
>;

type SummarizableNote = HarnessNoteSummary & { content?: string; userId?: string };
type HarnessAccessSummary = Pick<CollaborationAccess, 'role' | 'source'>;

function summarizeHarnessFolder(folder: HarnessFolderSummary): HarnessFolderSummary {
  return {
    id: folder.id,
    parentFolderId: folder.parentFolderId,
    title: folder.title,
    isPrivate: folder.isPrivate,
    isAgentReadOnly: folder.isAgentReadOnly,
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt,
  };
}

function summarizeHarnessNote(note: SummarizableNote): HarnessNoteSummary {
  return {
    id: note.id,
    folderId: note.folderId,
    title: note.title,
    documentType: note.documentType,
    type: note.type,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

function summarizeHarnessAccess(access: HarnessAccessSummary): HarnessAccessSummary {
  return { role: access.role, source: access.source };
}

function isValidCursorDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isNoteSearchCursor(value: unknown): value is NoteSearchCursor {
  if (!value || typeof value !== 'object') return false;
  const cursor = value as Partial<NoteSearchCursor>;
  return (
    typeof cursor.rank === 'number' &&
    Number.isInteger(cursor.rank) &&
    cursor.rank >= 0 &&
    cursor.rank <= 5 &&
    isValidCursorDate(cursor.updatedAt) &&
    typeof cursor.title === 'string' &&
    typeof cursor.id === 'string'
  );
}

function isLineSearchCursor(value: unknown): value is LineSearchCursor {
  if (!value || typeof value !== 'object') return false;
  const cursor = value as Partial<LineSearchCursor>;
  return (
    isValidCursorDate(cursor.noteUpdatedAt) &&
    typeof cursor.title === 'string' &&
    typeof cursor.noteId === 'string' &&
    typeof cursor.line === 'number' &&
    Number.isInteger(cursor.line) &&
    cursor.line >= 1 &&
    typeof cursor.column === 'number' &&
    Number.isInteger(cursor.column) &&
    cursor.column >= 1
  );
}

function summarizeHarnessDocumentResult<T extends { note: SummarizableNote; contentHash: string }>(result: T) {
  return {
    note: summarizeHarnessNote(result.note),
    contentHash: result.contentHash,
  };
}

function summarizeHarnessDocumentForSource<T extends { note: SummarizableNote; contentHash: string }>(
  result: T,
  source: 'owner' | 'note_grant' | 'folder_grant'
) {
  const summarized = summarizeHarnessDocumentResult(result);
  return source === 'note_grant' ? { ...summarized, note: { ...summarized.note, folderId: null } } : summarized;
}

async function hasFolderPermission(
  c: Context<{ Variables: Variables }>,
  folderId: string,
  permission: 'read' | 'create' | 'edit' | 'comment'
) {
  const user = c.get('user');
  if (!user) return false;
  return canIntegrationAccessFolder({
    apiKey: c.get('apiKey'),
    oauthAuthorization: c.get('oauthAuthorization'),
    userId: user.id,
    folderId,
    permission,
  });
}

function getCommentActor(c: Context<{ Variables: Variables }>): CommentActor {
  const user = c.get('user');
  const key = c.get('apiKey');
  const oauthAuthorization = c.get('oauthAuthorization');
  if (key) return { type: 'agent', id: key.id };
  if (oauthAuthorization) return { type: 'agent', id: oauthAuthorization.id };
  return { type: 'user', id: user?.id ?? 'owner' };
}

async function requireCommentAccess(c: Context<{ Variables: Variables }>, noteId: string, _operation: 'read' | 'edit') {
  const user = c.get('user');
  if (!user) return { ok: false as const, status: 401 as const, error: 'Unauthorized' };
  const owned = await readDocument({ documentId: noteId, userId: user.id });
  const current = await readHarnessDocument(c, noteId, 'comment');
  if (!current)
    return owned.ok
      ? { ok: false as const, status: 403 as const, error: 'Forbidden' }
      : { ok: false as const, status: 404 as const, error: 'Note not found' };
  return { ok: true as const, note: current.note, resourceOwnerUserId: current.resourceOwnerUserId };
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

async function getReadableFolderIds(c: Context<{ Variables: Variables }>) {
  const user = c.get('user');
  if (!user) return null;
  return getIntegrationAccessibleFolderIds({
    apiKey: c.get('apiKey'),
    oauthAuthorization: c.get('oauthAuthorization'),
    userId: user.id,
    permission: 'read',
  });
}

function paginateTags(c: Context<{ Variables: Variables }>, tags: Array<{ id: string; name: string }>, scope: string) {
  const limit = parsePageLimit(c.req.query('limit'));
  try {
    const page = paginateItems(
      tags,
      limit,
      c.req.query('cursor'),
      scope,
      (tag) => ({ title: tag.name, id: tag.id }),
      compareTitleIdPositions,
      isTitleIdPosition
    );
    return c.json({ tags: page.items, pageInfo: page.pageInfo });
  } catch (error) {
    if (error instanceof InvalidCursorError) return c.json({ error: error.message }, 400);
    throw error;
  }
}

harnessRoutes.get('/tags', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const readableFolderIds = await getReadableFolderIds(c);
  const integration = getIntegrationAuthorization(c);
  const scope = paginationScope('tags', user.id, readableFolderIds ? [...readableFolderIds].sort().join(',') : 'owner');
  if (
    integration?.authorizationId &&
    integration.sharedAccessMode !== 'none' &&
    capabilitiesAllow(integration.actor, 'read')
  ) {
    const visibleTags = await listIntegrationAccessibleTags({
      actorUserId: user.id,
      authorizationId: integration.authorizationId,
      sharedAccessMode: integration.sharedAccessMode,
      ownedFolderIds: readableFolderIds ?? new Set(),
    });
    visibleTags.sort((left, right) =>
      compareTitleIdPositions({ title: left.name, id: left.id }, { title: right.name, id: right.id })
    );
    return paginateTags(c, visibleTags, scope);
  }
  if (!readableFolderIds) {
    const visibleTags = await listUserTags({ userId: user.id });
    visibleTags.sort((left, right) =>
      compareTitleIdPositions({ title: left.name, id: left.id }, { title: right.name, id: right.id })
    );
    return paginateTags(c, visibleTags, scope);
  }

  const readableIds = [...readableFolderIds];
  if (readableIds.length === 0) return c.json({ tags: [], pageInfo: { hasMore: false, nextCursor: null } });
  const visibleTags = await listUserTags({ userId: user.id, folderIds: readableIds });
  visibleTags.sort((left, right) =>
    compareTitleIdPositions({ title: left.name, id: left.id }, { title: right.name, id: right.id })
  );
  return paginateTags(c, visibleTags, scope);
});

harnessRoutes.get('/folders', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const readableFolderIds = await getReadableFolderIds(c);
  const integration = getIntegrationAuthorization(c);
  let foldersInScope: HarnessFolderSummary[];
  if (
    integration?.authorizationId &&
    integration.sharedAccessMode !== 'none' &&
    capabilitiesAllow(integration.actor, 'read')
  ) {
    const accessibleFolders = await db
      .select({
        id: folders.id,
        parentFolderId: folders.parentFolderId,
        title: folders.title,
        isPrivate: folders.isPrivate,
        isAgentReadOnly: folders.isAgentReadOnly,
        createdAt: folders.createdAt,
        updatedAt: folders.updatedAt,
      })
      .from(folders)
      .where(
        integrationAccessibleFolderWhere({
          actorUserId: user.id,
          authorizationId: integration.authorizationId,
          sharedAccessMode: integration.sharedAccessMode,
          ownedFolderIds: readableFolderIds ?? new Set(),
        })
      );
    const accessibleIds = new Set(accessibleFolders.map((folder) => folder.id));
    foldersInScope = accessibleFolders.map((folder) => ({
      ...folder,
      parentFolderId: folder.parentFolderId && accessibleIds.has(folder.parentFolderId) ? folder.parentFolderId : null,
    }));
  } else {
    const result = await listFolders({ userId: user.id });
    foldersInScope = readableFolderIds
      ? result.value.folders.filter((folder) => readableFolderIds.has(folder.id))
      : result.value.folders;
  }
  foldersInScope.sort((left, right) =>
    compareTitleIdPositions({ title: left.title, id: left.id }, { title: right.title, id: right.id })
  );
  const limit = parsePageLimit(c.req.query('limit'));
  let page: { items: typeof foldersInScope; pageInfo: { hasMore: boolean; nextCursor: string | null } };
  try {
    page = paginateItems(
      foldersInScope,
      limit,
      c.req.query('cursor'),
      paginationScope('folders', user.id, readableFolderIds ? [...readableFolderIds].sort().join(',') : 'owner'),
      (folder) => ({ title: folder.title, id: folder.id }),
      compareTitleIdPositions,
      isTitleIdPosition
    );
  } catch (error) {
    if (error instanceof InvalidCursorError) return c.json({ error: error.message }, 400);
    throw error;
  }
  const visibleFolders = page.items.map(summarizeHarnessFolder);
  return c.json({ folders: visibleFolders, pageInfo: page.pageInfo });
});

harnessRoutes.post('/folders', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const key = c.get('apiKey');
  const oauthAuthorization = c.get('oauthAuthorization');
  if (key && !key.canCreateFolders) return c.json({ error: 'Forbidden' }, 403);
  if (oauthAuthorization && !oauthAuthorization.canCreateFolders) return c.json({ error: 'Forbidden' }, 403);

  const body = (await c.req.json().catch(() => null)) as { title?: string; parentFolderId?: string | null } | null;
  const title = body?.title?.trim();
  if (!title) return c.json({ error: 'Folder title is required' }, 400);

  const parentFolderId = body?.parentFolderId ?? null;
  let resourceOwnerUserId = user.id;
  if (parentFolderId) {
    const access = await resolveHarnessFolder(c, parentFolderId, 'create');
    if (!access) return c.json({ error: 'Forbidden' }, 403);
    resourceOwnerUserId = access.resourceOwnerUserId;
  }
  const parent = await validateFolderParent({ userId: resourceOwnerUserId, parentFolderId });
  if (!parent.ok) return c.json({ error: parent.error }, parent.status);

  const folder = {
    id: createId('folder'),
    userId: resourceOwnerUserId,
    createdByUserId: user.id,
    parentFolderId,
    title,
    isPrivate: false,
    isAgentReadOnly: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await db.transaction(async (tx) => {
    await tx.insert(folders).values(folder);

    const actor = key ?? oauthAuthorization;
    const integrationAuthorizationId = key?.authorizationId ?? oauthAuthorization?.integrationAuthorizationId;
    if (resourceOwnerUserId === user.id && actor?.accessMode === 'specific' && integrationAuthorizationId) {
      await tx
        .insert(authorizationFolderRules)
        .values({
          id: createId('auth_rule'),
          authorizationId: integrationAuthorizationId,
          userId: user.id,
          folderId: folder.id,
          canRead: actor.canRead,
          canCreate: actor.canCreate,
          canEdit: actor.canEdit,
          canComment: actor.canComment,
          canCreateFolders: actor.canCreateFolders,
          appliesTo: 'exact',
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoNothing({
          target: [authorizationFolderRules.authorizationId, authorizationFolderRules.folderId],
        });
    }
  });

  return c.json({ folder: summarizeHarnessFolder(folder) }, 201);
});

harnessRoutes.get('/notes/search', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const q = c.req.query('q')?.trim();
  if (!q) return c.json({ notes: [], pageInfo: { hasMore: false, nextCursor: null } });
  if (q.length > MAX_SEARCH_QUERY_LENGTH)
    return c.json({ error: `Query must be ${MAX_SEARCH_QUERY_LENGTH} characters or fewer` }, 400);

  const tag = c.req.query('tag')?.trim();
  const readableFolderIds = await getReadableFolderIds(c);
  const scope = paginationScope(
    'note-search',
    user.id,
    q,
    tag ?? '',
    readableFolderIds ? [...readableFolderIds].sort().join(',') : 'owner'
  );
  let cursor: NoteSearchCursor | null;
  try {
    cursor = decodeCursor(c.req.query('cursor'), scope, isNoteSearchCursor);
  } catch (error) {
    if (error instanceof InvalidCursorError) return c.json({ error: error.message }, 400);
    throw error;
  }
  const integration = getIntegrationAuthorization(c);
  const result = await searchDocuments({
    userId: user.id,
    query: q,
    limit: parsePageLimit(c.req.query('limit')),
    tag,
    folderIds: readableFolderIds,
    cursor,
    cursorScope: scope,
    integrationAccess:
      integration?.authorizationId &&
      integration.sharedAccessMode !== 'none' &&
      capabilitiesAllow(integration.actor, 'read')
        ? {
            authorizationId: integration.authorizationId,
            sharedAccessMode: integration.sharedAccessMode,
          }
        : undefined,
  });
  const accessByNoteId = integration?.authorizationId
    ? await resolveIntegrationReadAccessBatch({
        actorUserId: user.id,
        authorizationId: integration.authorizationId,
        sharedAccessMode: integration.sharedAccessMode,
        resources: result.value.documents,
      })
    : null;
  const visibleDocuments = result.value.documents.flatMap((note) => {
    const summarized = summarizeHarnessNote(note);
    if (!accessByNoteId) return [summarized];
    const access = accessByNoteId.get(note.id);
    if (!access) return [];
    return [access.source === 'note_grant' ? { ...summarized, folderId: null, folderTitle: null } : summarized];
  });
  return c.json({
    notes: visibleDocuments,
    pageInfo: result.value.pageInfo,
  });
});

harnessRoutes.get('/notes/search-lines', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const q = c.req.query('q')?.trim();
  if (!q) return c.json({ query: '', matches: [], pageInfo: { hasMore: false, nextCursor: null } });
  if (q.length > MAX_SEARCH_QUERY_LENGTH)
    return c.json({ error: `Query must be ${MAX_SEARCH_QUERY_LENGTH} characters or fewer` }, 400);

  const readableFolderIds = await getReadableFolderIds(c);
  const integration = getIntegrationAuthorization(c);
  const folderId = c.req.query('folderId');
  const context = Number.parseInt(c.req.query('context') ?? '', 10);
  const caseSensitive = c.req.query('caseSensitive') === 'true';
  const scope = paginationScope(
    'line-search',
    user.id,
    q,
    folderId ?? '',
    String(Number.isFinite(context) ? context : ''),
    String(caseSensitive),
    readableFolderIds ? [...readableFolderIds].sort().join(',') : 'owner'
  );
  let cursor: LineSearchCursor | null;
  try {
    cursor = decodeCursor(c.req.query('cursor'), scope, isLineSearchCursor);
  } catch (error) {
    if (error instanceof InvalidCursorError) return c.json({ error: error.message }, 400);
    throw error;
  }
  const result = await searchAllDocumentLines({
    userId: user.id,
    query: q,
    folderId,
    folderIds: readableFolderIds,
    context,
    limit: parsePageLimit(c.req.query('limit')),
    caseSensitive,
    cursor,
    cursorScope: scope,
    integrationAccess:
      integration?.authorizationId &&
      integration.sharedAccessMode !== 'none' &&
      capabilitiesAllow(integration.actor, 'read')
        ? {
            authorizationId: integration.authorizationId,
            sharedAccessMode: integration.sharedAccessMode,
          }
        : undefined,
  });
  const { accessResources, ...publicResult } = result.value;
  const accessByNoteId = integration?.authorizationId
    ? await resolveIntegrationReadAccessBatch({
        actorUserId: user.id,
        authorizationId: integration.authorizationId,
        sharedAccessMode: integration.sharedAccessMode,
        resources: accessResources,
      })
    : null;
  const matches = result.value.matches.flatMap((match) => {
    if (!accessByNoteId) return [match];
    const access = accessByNoteId.get(match.noteId);
    if (!access) return [];
    return [access.source === 'note_grant' ? { ...match, folderId: null } : match];
  });
  return c.json({ ...publicResult, matches });
});

harnessRoutes.post('/notes', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const body = (await c.req.json().catch(() => null)) as {
    folderId?: string;
    title?: string;
    content?: string;
    documentType?: DocumentType;
  } | null;
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);
  if (!body.folderId) return c.json({ error: 'Folder id is required' }, 400);

  const access = await resolveHarnessFolder(c, body.folderId, 'create');
  if (!access) return c.json({ error: 'Forbidden' }, 403);

  const actor = getActor(c);
  const result = await createDocument({
    userId: access.resourceOwnerUserId,
    creatorUserId: user.id,
    folderId: body.folderId,
    title: body.title,
    markdown: body.content,
    documentType: body.documentType,
    actorType: actor.actorType,
    actorId: actor.actorId,
  });

  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(summarizeHarnessDocumentResult(result.value), 201);
});

harnessRoutes.post('/canvases', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const body = (await c.req.json().catch(() => null)) as {
    folderId?: string;
    title?: string;
    canvas?: unknown;
    documentType?: 'canvas.default' | 'canvas.mindmap';
  } | null;
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);
  if (!body.folderId) return c.json({ error: 'Folder id is required' }, 400);
  const access = await resolveHarnessFolder(c, body.folderId, 'create');
  if (!access) return c.json({ error: 'Forbidden' }, 403);

  const content = body.canvas === undefined ? undefined : serializeCanvasDocument(body.canvas);
  if (body.canvas !== undefined && !content)
    return c.json({ error: 'Canvas content must include nodes and edges arrays' }, 400);
  if (content && (await sanitizeHarnessCanvasContent(c, content)).hiddenLinkCount > 0)
    return c.json({ error: 'Canvas contains inaccessible note links' }, 403);

  const actor = getActor(c);
  const result = await createDocument({
    userId: access.resourceOwnerUserId,
    creatorUserId: user.id,
    folderId: body.folderId,
    title: body.title,
    markdown: content ?? undefined,
    documentType: body.documentType ?? 'canvas.default',
    actorType: actor.actorType,
    actorId: actor.actorId,
  });

  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(summarizeHarnessDocumentResult(result.value), 201);
});

harnessRoutes.post('/canvases/from-syntax', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const body = (await c.req.json().catch(() => null)) as {
    folderId?: string;
    title?: string;
    syntax?: string;
    documentType?: 'canvas.default' | 'canvas.mindmap';
    format?: CanvasSyntaxFormat;
  } | null;
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);
  if (!body.folderId) return c.json({ error: 'Folder id is required' }, 400);
  if (!body.syntax?.trim()) return c.json({ error: 'Diagram syntax is required' }, 400);
  if (
    body.documentType !== undefined &&
    body.documentType !== 'canvas.default' &&
    body.documentType !== 'canvas.mindmap'
  )
    return c.json({ error: 'Document type must be canvas.default or canvas.mindmap' }, 400);
  if (body.format !== undefined && !isCanvasSyntaxFormat(body.format))
    return c.json({ error: 'Format must be auto, minu, or mermaid' }, 400);
  const access = await resolveHarnessFolder(c, body.folderId, 'create');
  if (!access) return c.json({ error: 'Forbidden' }, 403);

  const compiled = await canvasDocumentFromSyntax({
    syntax: body.syntax,
    documentType: body.documentType,
    format: body.format,
  });
  if (!compiled.ok) return c.json({ error: 'Diagram syntax has errors', diagnostics: compiled.errors }, 400);
  if ((await sanitizeHarnessCanvasContent(c, JSON.stringify(compiled.canvas))).hiddenLinkCount > 0)
    return c.json({ error: 'Canvas contains inaccessible note links' }, 403);

  const actor = getActor(c);
  const result = await createDocument({
    userId: access.resourceOwnerUserId,
    creatorUserId: user.id,
    folderId: body.folderId,
    title: body.title ?? compiled.title,
    markdown: JSON.stringify(compiled.canvas),
    documentType: compiled.documentType as 'canvas.default' | 'canvas.mindmap',
    actorType: actor.actorType,
    actorId: actor.actorId,
  });

  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(
    {
      ...summarizeHarnessDocumentResult(result.value),
      diagnostics: compiled.diagnostics,
    },
    201
  );
});

harnessRoutes.get('/notes/orphans', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const readableFolderIds = await getReadableFolderIds(c);
  const integration = getIntegrationAuthorization(c);
  const integrationAccess =
    integration?.authorizationId &&
    integration.sharedAccessMode !== 'none' &&
    capabilitiesAllow(integration.actor, 'read')
      ? {
          authorizationId: integration.authorizationId,
          sharedAccessMode: integration.sharedAccessMode,
          ownedFolderIds: readableFolderIds ?? new Set(),
        }
      : undefined;
  const scope = paginationScope(
    'orphans',
    user.id,
    readableFolderIds ? [...readableFolderIds].sort().join(',') : 'owner'
  );
  try {
    const limit = parsePageLimit(c.req.query('limit'));
    const cursor = decodeCursor(c.req.query('cursor'), scope, isTitleIdPosition);
    const rows = await listOrphanNotes({
      userId: user.id,
      integrationAccess,
      folderIds: integrationAccess ? undefined : (readableFolderIds ?? undefined),
      after: cursor,
      limit: limit + 1,
    });
    const hasMore = rows.length > limit;
    const pageCandidates = hasMore ? rows.slice(0, limit) : rows;
    const lastCandidate = pageCandidates.at(-1);
    const accessByNoteId =
      integration?.authorizationId && pageCandidates.length > 0
        ? await resolveIntegrationReadAccessBatch({
            actorUserId: user.id,
            authorizationId: integration.authorizationId,
            sharedAccessMode: integration.sharedAccessMode,
            resources: pageCandidates,
          })
        : null;
    const visibleNotes = pageCandidates.flatMap((note) => {
      const summarized = summarizeHarnessNote(note);
      if (!accessByNoteId) return [summarized];
      const access = accessByNoteId.get(note.id);
      if (!access) return [];
      return [access.source === 'note_grant' ? { ...summarized, folderId: null, folderTitle: null } : summarized];
    });
    return c.json({
      notes: visibleNotes,
      pageInfo: {
        hasMore,
        nextCursor:
          hasMore && lastCandidate ? encodeCursor(scope, { title: lastCandidate.title, id: lastCandidate.id }) : null,
      },
    });
  } catch (error) {
    if (error instanceof InvalidCursorError) return c.json({ error: error.message }, 400);
    throw error;
  }
});

harnessRoutes.post('/notes/move', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const body = (await c.req.json().catch(() => null)) as { noteIds?: string[]; targetFolderId?: string } | null;
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);
  if (!Array.isArray(body.noteIds)) return c.json({ error: 'Note ids array is required' }, 400);
  if (!body.noteIds.every((noteId) => typeof noteId === 'string'))
    return c.json({ error: 'Note ids must be strings' }, 400);
  if (!body.targetFolderId) return c.json({ error: 'Target folder id is required' }, 400);
  if (!(await hasFolderPermission(c, body.targetFolderId, 'create'))) return c.json({ error: 'Forbidden' }, 403);

  const documentIds = [...new Set(body.noteIds.map((id) => id.trim()).filter(Boolean))];
  for (const noteId of documentIds) {
    const current = await readDocument({ documentId: noteId, userId: user.id });
    if (!current.ok) return c.json({ error: current.error }, current.status);
    if (!(await hasFolderPermission(c, current.value.note.folderId, 'edit')))
      return c.json({ error: 'Forbidden' }, 403);
  }

  const actor = getActor(c);
  const result = await moveDocuments({
    documentIds,
    targetFolderId: body.targetFolderId,
    userId: user.id,
    actorType: actor.actorType,
    actorId: actor.actorId,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);

  return c.json({
    targetFolderId: body.targetFolderId,
    notes: result.value.notes.map((item) => summarizeHarnessNote(item.note)),
  });
});

harnessRoutes.get('/notes/:noteId/tags', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const noteId = c.req.param('noteId');
  const current = await readHarnessDocument(c, noteId, 'read');
  if (!current) {
    const status = await harnessDocumentDeniedStatus(user.id, noteId);
    return c.json({ error: status === 403 ? 'Forbidden' : 'Note not found' }, status);
  }
  return c.json({ tags: await listNoteTags({ userId: current.resourceOwnerUserId, noteId }) });
});

harnessRoutes.put('/notes/:noteId/tags', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const noteId = c.req.param('noteId');
  const current = await readHarnessDocument(c, noteId, 'edit');
  if (!current) {
    const status = await harnessDocumentDeniedStatus(user.id, noteId);
    return c.json({ error: status === 403 ? 'Forbidden' : 'Note not found' }, status);
  }
  const body = (await c.req.json().catch(() => null)) as { tags?: string[] } | null;
  if (!body || !Array.isArray(body.tags)) return c.json({ error: 'Tags array is required' }, 400);
  return c.json({
    tags: await setNoteTags({ userId: current.resourceOwnerUserId, noteId, tags: body.tags }),
  });
});

harnessRoutes.get('/notes/:noteId', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const noteId = c.req.param('noteId');
  const result = await readHarnessDocument(c, noteId, 'read');
  if (!result) {
    const status = await harnessDocumentDeniedStatus(user.id, noteId);
    return c.json({ error: status === 403 ? 'Forbidden' : 'Note not found' }, status);
  }
  const { userId: _resourceOwnerUserId, ...note } = omitResourceCreator(result.note);
  return c.json({
    note,
    contentHash: result.contentHash,
    access: summarizeHarnessAccess(result),
  });
});

harnessRoutes.post('/notes/:noteId/trash', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const noteId = c.req.param('noteId');
  const current = await readHarnessDocument(c, noteId, 'edit');
  if (!current) return c.json({ error: 'Note not found' }, 404);
  if (!current.note.isApiEditable) return c.json({ error: 'Document is not editable through the API' }, 403);
  const eligibility = await resolveNoteTrashEligibility({
    actorUserId: user.id,
    noteId,
    access: {
      actorUserId: user.id,
      resourceOwnerUserId: current.resourceOwnerUserId,
      role: current.role,
      source: current.source,
      applicableGrantIds: [],
    },
  });
  if (!eligibility.allowed) {
    const error = trashEligibilityStatus(eligibility);
    return c.json({ error: error?.error ?? 'Forbidden' }, error?.status ?? 403);
  }
  const actor = getActor(c);
  const result = await trashNote({
    userId: eligibility.resourceOwnerUserId,
    noteId,
    actorType: actor.actorType,
    actorId: actor.actorId,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ ok: true, ...result.value });
});

harnessRoutes.post('/folders/:folderId/trash', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const folderId = c.req.param('folderId');
  const access = await resolveHarnessFolder(c, folderId, 'edit');
  if (!access) return c.json({ error: 'Folder not found' }, 404);
  const eligibility = await resolveFolderTrashEligibility({
    actorUserId: user.id,
    folderId,
    access: {
      actorUserId: user.id,
      resourceOwnerUserId: access.resourceOwnerUserId,
      role: access.role,
      source: access.source,
      applicableGrantIds: [],
    },
  });
  if (!eligibility.allowed) {
    const error = trashEligibilityStatus(eligibility);
    return c.json({ error: error?.error ?? 'Forbidden' }, error?.status ?? 403);
  }
  const actor = getActor(c);
  const result = await trashFolder({
    userId: eligibility.resourceOwnerUserId,
    folderId,
    actorType: actor.actorType,
    actorId: actor.actorId,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ ok: true, ...result.value });
});

harnessRoutes.get('/notes/:noteId/comments', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const access = await requireCommentAccess(c, c.req.param('noteId'), 'read');
  if (!access.ok) return c.json({ error: access.error }, access.status);
  const result = await listCommentThreads({
    noteId: access.note.id,
    userId: access.resourceOwnerUserId,
    actor: getCommentActor(c),
  });
  if (!result.ok) return commentErrorResponse(c, result);
  return c.json(result.value);
});

harnessRoutes.post('/notes/:noteId/comments', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const access = await requireCommentAccess(c, c.req.param('noteId'), 'edit');
  if (!access.ok) return c.json({ error: access.error }, access.status);
  const body = (await c.req.json().catch(() => null)) as {
    body?: string;
    anchor?: CommentAnchorInput;
  } | null;
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);
  if (typeof body.body !== 'string') return c.json({ error: 'Comment body is required' }, 400);
  if (!body.anchor) return c.json({ error: 'Comment anchor is required' }, 400);
  const result = await createCommentThread({
    noteId: access.note.id,
    userId: access.resourceOwnerUserId,
    actor: getCommentActor(c),
    body: body.body,
    anchor: body.anchor,
  });
  if (!result.ok) return commentErrorResponse(c, result);
  return c.json(result.value, 201);
});

harnessRoutes.post('/notes/:noteId/comments/:threadId/replies', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const access = await requireCommentAccess(c, c.req.param('noteId'), 'edit');
  if (!access.ok) return c.json({ error: access.error }, access.status);
  const body = (await c.req.json().catch(() => null)) as { body?: string } | null;
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);
  if (typeof body.body !== 'string') return c.json({ error: 'Comment body is required' }, 400);
  const result = await addCommentReply({
    noteId: access.note.id,
    threadId: c.req.param('threadId'),
    userId: access.resourceOwnerUserId,
    actor: getCommentActor(c),
    body: body.body,
  });
  if (!result.ok) return commentErrorResponse(c, result);
  return c.json(result.value, 201);
});

harnessRoutes.patch('/notes/:noteId/comments/:threadId/anchor', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const access = await requireCommentAccess(c, c.req.param('noteId'), 'edit');
  if (!access.ok) return c.json({ error: access.error }, access.status);
  const body = (await c.req.json().catch(() => null)) as { anchor?: CommentAnchorInput } | null;
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);
  if (!body.anchor) return c.json({ error: 'Comment anchor is required' }, 400);
  const result = await updateCommentAnchor({
    noteId: access.note.id,
    threadId: c.req.param('threadId'),
    userId: access.resourceOwnerUserId,
    actor: getCommentActor(c),
    anchor: body.anchor,
  });
  if (!result.ok) return commentErrorResponse(c, result);
  return c.json(result.value);
});

for (const [path, status] of [
  ['resolve', 'resolved'],
  ['reopen', 'open'],
] as const) {
  harnessRoutes.post(`/notes/:noteId/comments/:threadId/${path}`, async (c) => {
    const user = getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const access = await requireCommentAccess(c, c.req.param('noteId'), 'edit');
    if (!access.ok) return c.json({ error: access.error }, access.status);
    const result = await setCommentThreadStatus({
      noteId: access.note.id,
      threadId: c.req.param('threadId'),
      userId: access.resourceOwnerUserId,
      actor: getCommentActor(c),
      status,
    });
    if (!result.ok) return commentErrorResponse(c, result);
    return c.json(result.value);
  });
}

harnessRoutes.patch('/notes/:noteId/comments/:threadId/messages/:messageId', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const access = await requireCommentAccess(c, c.req.param('noteId'), 'edit');
  if (!access.ok) return c.json({ error: access.error }, access.status);
  const body = (await c.req.json().catch(() => null)) as { body?: string } | null;
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);
  if (typeof body.body !== 'string') return c.json({ error: 'Comment body is required' }, 400);
  const result = await updateCommentMessage({
    noteId: access.note.id,
    threadId: c.req.param('threadId'),
    messageId: c.req.param('messageId'),
    userId: access.resourceOwnerUserId,
    actor: getCommentActor(c),
    body: body.body,
  });
  if (!result.ok) return commentErrorResponse(c, result);
  return c.json(result.value);
});

harnessRoutes.post('/notes/:noteId/comments/:threadId/messages/:messageId/reactions', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const access = await requireCommentAccess(c, c.req.param('noteId'), 'edit');
  if (!access.ok) return c.json({ error: access.error }, access.status);
  const body = (await c.req.json().catch(() => null)) as { emoji?: string } | null;
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);
  if (typeof body.emoji !== 'string') return c.json({ error: 'Reaction emoji is required' }, 400);
  const result = await toggleCommentReaction({
    noteId: access.note.id,
    threadId: c.req.param('threadId'),
    messageId: c.req.param('messageId'),
    userId: access.resourceOwnerUserId,
    actor: getCommentActor(c),
    emoji: body.emoji,
  });
  if (!result.ok) return commentErrorResponse(c, result);
  return c.json(result.value);
});

harnessRoutes.delete('/notes/:noteId/comments/:threadId/messages/:messageId', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const access = await requireCommentAccess(c, c.req.param('noteId'), 'edit');
  if (!access.ok) return c.json({ error: access.error }, access.status);
  const result = await deleteCommentMessage({
    noteId: access.note.id,
    threadId: c.req.param('threadId'),
    messageId: c.req.param('messageId'),
    userId: access.resourceOwnerUserId,
    actor: getCommentActor(c),
  });
  if (!result.ok) return commentErrorResponse(c, result);
  return c.json(result.value);
});

harnessRoutes.delete('/notes/:noteId/comments/:threadId', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const access = await requireCommentAccess(c, c.req.param('noteId'), 'edit');
  if (!access.ok) return c.json({ error: access.error }, access.status);
  const result = await deleteCommentThread({
    noteId: access.note.id,
    threadId: c.req.param('threadId'),
    userId: access.resourceOwnerUserId,
    actor: getCommentActor(c),
  });
  if (!result.ok) return commentErrorResponse(c, result);
  return c.json(result.value);
});

harnessRoutes.get('/notes/:noteId/events', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const current = await readDocument({ documentId: c.req.param('noteId'), userId: user.id });
  if (!current.ok) return c.json({ error: current.error }, current.status);
  if (!(await hasFolderPermission(c, current.value.note.folderId, 'read'))) return c.json({ error: 'Forbidden' }, 403);

  const limit = Number.parseInt(c.req.query('limit') ?? '', 10);
  const result = await listNoteEvents({
    documentId: c.req.param('noteId'),
    userId: user.id,
    limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  const actor = getCommentActor(c);
  const serializeActor = await createCollaborationActorSerializer({
    references: result.value.events.map((event) => ({
      type: event.actorType as 'user' | 'agent' | 'system',
      id: event.actorId ?? (event.actorType === 'user' ? event.userId : null),
    })),
    currentActor: { type: actor.type, id: actor.id },
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

harnessRoutes.get('/notes/:noteId/links', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const noteId = c.req.param('noteId');
  const current = await readHarnessDocument(c, noteId, 'read');
  if (!current) {
    const status = await harnessDocumentDeniedStatus(user.id, noteId);
    return c.json({ error: status === 403 ? 'Forbidden' : 'Note not found' }, status);
  }

  const links = await listOutgoingLinks({ userId: current.resourceOwnerUserId, noteId });
  if (!links) return c.json({ error: 'Note not found' }, 404);
  const accessByNoteId = await resolveHarnessLinkedNoteAccessBatch(
    c,
    links.map((link) => link.targetNoteId).filter((id): id is string => Boolean(id))
  );
  const visibleLinks = links.map((link) => {
    if (!link.targetNoteId || accessByNoteId.has(link.targetNoteId)) return link;
    return {
      ...link,
      targetNoteId: null,
      targetTitle: link.linkType === 'wikilink' ? link.targetTitle : link.label?.trim() || 'Linked note',
    };
  });
  return c.json({ noteId, links: visibleLinks });
});

harnessRoutes.get('/notes/:noteId/backlinks', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const noteId = c.req.param('noteId');
  const current = await readHarnessDocument(c, noteId, 'read');
  if (!current) {
    const status = await harnessDocumentDeniedStatus(user.id, noteId);
    return c.json({ error: status === 403 ? 'Forbidden' : 'Note not found' }, status);
  }

  const backlinks = await listBacklinks({ userId: current.resourceOwnerUserId, noteId });
  if (!backlinks) return c.json({ error: 'Note not found' }, 404);
  const accessByNoteId = await resolveHarnessLinkedNoteAccessBatch(
    c,
    backlinks.map((backlink) => backlink.sourceNoteId)
  );
  const visibleBacklinks = backlinks.flatMap((backlink) => {
    const access = accessByNoteId.get(backlink.sourceNoteId);
    if (!access) return [];
    return [access.source === 'note_grant' ? { ...backlink, sourceFolderId: null } : backlink];
  });
  return c.json({ noteId, backlinks: visibleBacklinks });
});

harnessRoutes.get('/notes/:noteId/lines', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const current = await readHarnessDocument(c, c.req.param('noteId'), 'read');
  if (!current) return c.json({ error: 'Note not found' }, 404);

  const result = await readDocumentLines({
    documentId: c.req.param('noteId'),
    userId: current.resourceOwnerUserId,
    from: Number.parseInt(c.req.query('from') ?? '', 10),
    to: Number.parseInt(c.req.query('to') ?? '', 10),
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(result.value);
});

harnessRoutes.get('/notes/:noteId/search-lines', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const current = await readHarnessDocument(c, c.req.param('noteId'), 'read');
  if (!current) return c.json({ error: 'Note not found' }, 404);

  const q = c.req.query('q')?.trim();
  if (!q) return c.json({ query: '', matches: [] });
  if (q.length > MAX_SEARCH_QUERY_LENGTH)
    return c.json({ error: `Query must be ${MAX_SEARCH_QUERY_LENGTH} characters or fewer` }, 400);

  const result = await searchDocumentLines({
    documentId: c.req.param('noteId'),
    userId: current.resourceOwnerUserId,
    query: q,
    context: Number.parseInt(c.req.query('context') ?? '', 10),
    limit: Number.parseInt(c.req.query('limit') ?? '', 10),
    caseSensitive: c.req.query('caseSensitive') === 'true',
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(result.value);
});

harnessRoutes.get('/notes/:noteId/outline', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const result = await readHarnessDocument(c, c.req.param('noteId'), 'read');
  if (!result) return c.json({ error: 'Note not found' }, 404);
  return c.json({
    noteId: result.note.id,
    contentHash: result.contentHash,
    sections: parseSections(result.note.content),
  });
});

harnessRoutes.get('/notes/:noteId/sections/:sectionId', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const result = await readHarnessDocument(c, c.req.param('noteId'), 'read');
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

harnessRoutes.put('/notes/:noteId/canvas', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const body = (await c.req.json().catch(() => null)) as {
    canvas?: unknown;
    documentType?: 'canvas.default' | 'canvas.mindmap';
    title?: string;
    baseHash?: string;
  } | null;
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);
  if (body.canvas === undefined) return c.json({ error: 'Canvas content is required' }, 400);
  const canvas = serializeCanvasDocument(body.canvas);
  if (!canvas) return c.json({ error: 'Canvas content must include nodes and edges arrays' }, 400);

  const current = await readHarnessDocument(c, c.req.param('noteId'), 'edit');
  if (!current) return c.json({ error: 'Note not found' }, 404);
  if (current.hiddenCanvasLinkCount > 0) return c.json({ error: 'Canvas contains inaccessible note links' }, 403);
  if ((await sanitizeHarnessCanvasContent(c, canvas)).hiddenLinkCount > 0)
    return c.json({ error: 'Canvas contains inaccessible note links' }, 403);

  const actor = getActor(c);
  const result = await replaceCanvasDocument({
    documentId: c.req.param('noteId'),
    userId: current.resourceOwnerUserId,
    title: body.title,
    canvas: JSON.parse(canvas),
    documentType: body.documentType,
    baseHash: body.baseHash ?? current.rawContentHash,
    actorType: actor.actorType,
    actorId: actor.actorId,
  });

  if (!result.ok)
    return c.json(
      { error: result.error, ...('currentHash' in result ? { currentHash: result.currentHash } : {}) },
      result.status
    );
  return c.json(summarizeHarnessDocumentForSource(result.value, current.source));
});

harnessRoutes.post('/notes/:noteId/canvas/nodes/:nodeId/link-note', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const body = (await c.req.json().catch(() => null)) as { targetNoteId?: string; baseHash?: string } | null;
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);
  if (!body.targetNoteId?.trim()) return c.json({ error: 'Target note id is required' }, 400);

  const current = await readHarnessDocument(c, c.req.param('noteId'), 'edit');
  if (!current) return c.json({ error: 'Note not found' }, 404);
  if (current.hiddenCanvasLinkCount > 0) return c.json({ error: 'Canvas contains inaccessible note links' }, 403);
  const target = await readHarnessDocument(c, body.targetNoteId, 'read');
  if (target?.note.type !== 'note' || target.resourceOwnerUserId !== current.resourceOwnerUserId)
    return c.json({ error: 'Target note not found' }, 404);

  const actor = getActor(c);
  const result = await linkCanvasNodeToNote({
    documentId: c.req.param('noteId'),
    userId: current.resourceOwnerUserId,
    nodeId: c.req.param('nodeId'),
    targetNoteId: target.note.id,
    baseHash: body.baseHash ?? current.rawContentHash,
    actorType: actor.actorType,
    actorId: actor.actorId,
  });

  if (!result.ok)
    return c.json(
      { error: result.error, ...('currentHash' in result ? { currentHash: result.currentHash } : {}) },
      result.status
    );
  return c.json(summarizeHarnessDocumentForSource(result.value, current.source));
});

harnessRoutes.delete('/notes/:noteId/canvas/nodes/:nodeId/link', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const current = await readHarnessDocument(c, c.req.param('noteId'), 'edit');
  if (!current) return c.json({ error: 'Note not found' }, 404);
  if (current.hiddenCanvasLinkCount > 0) return c.json({ error: 'Canvas contains inaccessible note links' }, 403);

  const actor = getActor(c);
  const result = await unlinkCanvasNode({
    documentId: c.req.param('noteId'),
    userId: current.resourceOwnerUserId,
    nodeId: c.req.param('nodeId'),
    baseHash: c.req.query('baseHash') ?? current.rawContentHash,
    actorType: actor.actorType,
    actorId: actor.actorId,
  });

  if (!result.ok)
    return c.json(
      { error: result.error, ...('currentHash' in result ? { currentHash: result.currentHash } : {}) },
      result.status
    );
  return c.json(summarizeHarnessDocumentForSource(result.value, current.source));
});

harnessRoutes.put('/notes/:noteId/canvas/from-syntax', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const body = (await c.req.json().catch(() => null)) as {
    syntax?: string;
    documentType?: 'canvas.default' | 'canvas.mindmap';
    title?: string;
    baseHash?: string;
    format?: CanvasSyntaxFormat;
  } | null;
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);
  if (!body.syntax?.trim()) return c.json({ error: 'Diagram syntax is required' }, 400);
  if (
    body.documentType !== undefined &&
    body.documentType !== 'canvas.default' &&
    body.documentType !== 'canvas.mindmap'
  )
    return c.json({ error: 'Document type must be canvas.default or canvas.mindmap' }, 400);
  if (body.format !== undefined && !isCanvasSyntaxFormat(body.format))
    return c.json({ error: 'Format must be auto, minu, or mermaid' }, 400);

  const current = await readHarnessDocument(c, c.req.param('noteId'), 'edit');
  if (!current) return c.json({ error: 'Note not found' }, 404);
  if (current.hiddenCanvasLinkCount > 0) return c.json({ error: 'Canvas contains inaccessible note links' }, 403);

  const compiled = await canvasDocumentFromSyntax({
    syntax: body.syntax,
    documentType: body.documentType,
    format: body.format,
  });
  if (!compiled.ok) return c.json({ error: 'Diagram syntax has errors', diagnostics: compiled.errors }, 400);
  if ((await sanitizeHarnessCanvasContent(c, JSON.stringify(compiled.canvas))).hiddenLinkCount > 0)
    return c.json({ error: 'Canvas contains inaccessible note links' }, 403);

  const actor = getActor(c);
  const result = await replaceCanvasDocument({
    documentId: c.req.param('noteId'),
    userId: current.resourceOwnerUserId,
    title: body.title ?? compiled.title,
    canvas: compiled.canvas,
    documentType: compiled.documentType as 'canvas.default' | 'canvas.mindmap',
    baseHash: body.baseHash ?? current.rawContentHash,
    actorType: actor.actorType,
    actorId: actor.actorId,
  });

  if (!result.ok)
    return c.json(
      { error: result.error, ...('currentHash' in result ? { currentHash: result.currentHash } : {}) },
      result.status
    );
  return c.json({
    ...summarizeHarnessDocumentForSource(result.value, current.source),
    diagnostics: compiled.diagnostics,
  });
});

harnessRoutes.post('/notes/:noteId/edit', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const body = (await c.req.json().catch(() => null)) as { edits?: DocumentEdit[]; baseHash?: string } | null;
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);
  if (!Array.isArray(body.edits) || body.edits.length === 0)
    return c.json({ error: 'At least one edit is required' }, 400);

  const current = await readHarnessDocument(c, c.req.param('noteId'), 'edit');
  if (!current) return c.json({ error: 'Note not found' }, 404);

  const actor = getActor(c);
  const result = await editDocument({
    documentId: c.req.param('noteId'),
    userId: current.resourceOwnerUserId,
    edits: body.edits,
    baseHash: body.baseHash,
    actorType: actor.actorType,
    actorId: actor.actorId,
  });

  if (!result.ok)
    return c.json(
      { error: result.error, ...('currentHash' in result ? { currentHash: result.currentHash } : {}) },
      result.status
    );
  const summarized = summarizeHarnessDocumentResult(result.value);
  return c.json(
    current.source === 'note_grant' ? { ...summarized, note: { ...summarized.note, folderId: null } } : summarized
  );
});
