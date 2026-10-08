import { and, asc, eq, exists, gt, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { type Context, Hono } from 'hono';
import { db } from '../db/client';
import { folderShareLinks, folders, notes, templateFolderAssignments, user as users } from '../db/schema';
import { createDocument, listDocuments, listFolders } from '../harness/commands';
import type { auth } from '../lib/auth';
import {
  collaborationRoleAllows,
  resolveFolderCollaborationAccess,
  resolveFolderNavigationAccess,
  serializeCollaborationAccess,
} from '../lib/collaboration-access';
import { serializeCollaborationUserIdentity } from '../lib/collaboration-identity';
import { omitCollaborationInternalFields, omitResourceCreator } from '../lib/collaboration-serialization';
import {
  listTrashableFolderIds,
  listTrashableNoteIds,
  resolveFolderTrashEligibility,
  trashEligibilityStatus,
} from '../lib/collaboration-trash';
import { loadFolderAccessTree, validateFolderMove, validateFolderParent } from '../lib/folder-access';
import { createId } from '../lib/id';
import { parsePageRequest } from '../lib/pagination';
import { buildFolderShareUrl, generateShareToken, hashShareToken } from '../lib/share-tokens';
import { compactNoteSelection } from '../notes/listing';
import { trashFolder } from '../trash/operations';
import { activeFolderWhere, activeNoteWhere } from '../trash/policy';

type Variables = {
  user: typeof auth.$Infer.Session.user | null;
  session: typeof auth.$Infer.Session.session | null;
};

export const folderRoutes = new Hono<{ Variables: Variables }>();

const childFolders = alias(folders, 'child');

class InvalidFolderChildrenCursorError extends Error {}

function decodeFolderChildrenCursor(value: string) {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      title?: unknown;
      id?: unknown;
    };
    if (typeof decoded.title !== 'string' || typeof decoded.id !== 'string')
      throw new InvalidFolderChildrenCursorError();
    return { title: decoded.title, id: decoded.id };
  } catch (error) {
    if (error instanceof InvalidFolderChildrenCursorError) throw error;
    throw new InvalidFolderChildrenCursorError();
  }
}

function encodeFolderChildrenCursor(folder: { title: string; id: string }) {
  return Buffer.from(JSON.stringify(folder)).toString('base64url');
}

function getUser(c: Context<{ Variables: Variables }>) {
  const user = c.get('user');
  if (!user) return null;
  return user;
}

function activeFolderShareWhere(folderId: string, userId: string) {
  const now = new Date();
  return and(
    eq(folderShareLinks.folderId, folderId),
    eq(folderShareLinks.userId, userId),
    isNull(folderShareLinks.revokedAt),
    or(isNull(folderShareLinks.expiresAt), gt(folderShareLinks.expiresAt, now))
  );
}

function serializeFolderShareLink(shareLink: typeof folderShareLinks.$inferSelect, url?: string | null) {
  return {
    id: shareLink.id,
    folderId: shareLink.folderId,
    permission: shareLink.permission,
    createdAt: shareLink.createdAt,
    updatedAt: shareLink.updatedAt,
    expiresAt: shareLink.expiresAt,
    revokedAt: shareLink.revokedAt,
    url: url ?? (shareLink.token ? buildFolderShareUrl(shareLink.token) : null),
  };
}

async function getShareableFolder(userId: string, folderId: string) {
  const tree = await loadFolderAccessTree(userId);
  const folder = tree.byId.get(folderId);
  if (!folder) return { ok: false as const, status: 404 as const, error: 'Folder not found' };
  return { ok: true as const, folder };
}

folderRoutes.get('/', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const result = await listFolders({ userId: user.id });
  return c.json({ folders: result.value.folders.map(omitResourceCreator) });
});

folderRoutes.post('/', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const body = (await c.req.json().catch(() => null)) as { title?: string; parentFolderId?: string | null } | null;
  const title = body?.title?.trim();
  if (!title) return c.json({ error: 'Folder title is required' }, 400);

  const parentFolderId = body?.parentFolderId ?? null;
  let resourceOwnerUserId = user.id;
  if (parentFolderId) {
    const access = await resolveFolderCollaborationAccess({ actorUserId: user.id, folderId: parentFolderId });
    if (!access) return c.json({ error: 'Folder not found' }, 404);
    if (!collaborationRoleAllows(access.role, 'create')) return c.json({ error: 'Forbidden' }, 403);
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
  await db.insert(folders).values(folder);
  return c.json(
    {
      folder: resourceOwnerUserId === user.id ? omitResourceCreator(folder) : omitCollaborationInternalFields(folder),
    },
    201
  );
});

folderRoutes.patch('/:folderId', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const body = (await c.req.json().catch(() => null)) as {
    title?: string;
    isPrivate?: boolean;
    isAgentReadOnly?: boolean;
    parentFolderId?: string | null;
  } | null;
  const title = body?.title?.trim();
  if (body?.title !== undefined && !title) return c.json({ error: 'Folder title is required' }, 400);
  if (
    !body ||
    (title === undefined &&
      body.isPrivate === undefined &&
      body.isAgentReadOnly === undefined &&
      body.parentFolderId === undefined)
  )
    return c.json({ error: 'No folder updates provided' }, 400);

  if (body.parentFolderId !== undefined) {
    const move = await validateFolderMove({
      userId: user.id,
      folderId: c.req.param('folderId'),
      parentFolderId: body.parentFolderId,
    });
    if (!move.ok) return c.json({ error: move.error }, move.status);
  }

  const [folder] = await db
    .update(folders)
    .set({
      ...(title !== undefined ? { title } : {}),
      ...(body.isPrivate !== undefined ? { isPrivate: body.isPrivate } : {}),
      ...(body.isAgentReadOnly !== undefined ? { isAgentReadOnly: body.isAgentReadOnly } : {}),
      ...(body.parentFolderId !== undefined ? { parentFolderId: body.parentFolderId } : {}),
      updatedAt: new Date(),
    })
    .where(activeFolderWhere(user.id, eq(folders.id, c.req.param('folderId'))))
    .returning();

  if (!folder) return c.json({ error: 'Folder not found' }, 404);
  return c.json({ folder: omitResourceCreator(folder) });
});

folderRoutes.get('/:folderId/share-link', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const result = await getShareableFolder(user.id, c.req.param('folderId'));
  if (!result.ok) return c.json({ error: result.error }, result.status);

  const [shareLink] = await db
    .select()
    .from(folderShareLinks)
    .where(activeFolderShareWhere(result.folder.id, user.id))
    .limit(1);
  return c.json({ shareLink: shareLink ? serializeFolderShareLink(shareLink) : null });
});

folderRoutes.post('/:folderId/share-link', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const result = await getShareableFolder(user.id, c.req.param('folderId'));
  if (!result.ok) return c.json({ error: result.error }, result.status);

  const body = (await c.req.json().catch(() => null)) as { regenerate?: boolean } | null;
  const [existing] = await db
    .select()
    .from(folderShareLinks)
    .where(activeFolderShareWhere(result.folder.id, user.id))
    .limit(1);
  if (existing && !body?.regenerate && existing.token) return c.json({ shareLink: serializeFolderShareLink(existing) });

  const token = generateShareToken();
  const now = new Date();
  if (existing && !body?.regenerate) {
    const [shareLink] = await db
      .update(folderShareLinks)
      .set({ token, tokenHash: hashShareToken(token), updatedAt: now })
      .where(eq(folderShareLinks.id, existing.id))
      .returning();
    return c.json({ shareLink: serializeFolderShareLink(shareLink) });
  }

  if (existing)
    await db
      .update(folderShareLinks)
      .set({ revokedAt: now, updatedAt: now })
      .where(eq(folderShareLinks.id, existing.id));
  const [shareLink] = await db
    .insert(folderShareLinks)
    .values({
      id: createId('folder_share'),
      userId: user.id,
      folderId: result.folder.id,
      tokenHash: hashShareToken(token),
      token,
      permission: 'read',
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return c.json({ shareLink: serializeFolderShareLink(shareLink) }, 201);
});

folderRoutes.delete('/:folderId/share-link', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const [folder] = await db
    .select({ id: folders.id })
    .from(folders)
    .where(activeFolderWhere(user.id, eq(folders.id, c.req.param('folderId'))))
    .limit(1);
  if (!folder) return c.json({ error: 'Folder not found' }, 404);

  const now = new Date();
  await db
    .update(folderShareLinks)
    .set({ revokedAt: now, updatedAt: now })
    .where(activeFolderShareWhere(folder.id, user.id));
  return c.json({ ok: true });
});

folderRoutes.get('/:folderId/children', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const folderId = c.req.param('folderId');
  const requestedLimit = Number(c.req.query('limit') ?? 100);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100)
    return c.json({ error: 'Limit must be between 1 and 100' }, 400);

  let cursor: { title: string; id: string } | undefined;
  try {
    const cursorValue = c.req.query('cursor');
    cursor = cursorValue ? decodeFolderChildrenCursor(cursorValue) : undefined;
  } catch (error) {
    if (error instanceof InvalidFolderChildrenCursorError) return c.json({ error: 'Invalid folder cursor' }, 400);
    throw error;
  }

  const access = await resolveFolderNavigationAccess({ actorUserId: user.id, folderId });
  if (!access) return c.json({ error: 'Folder not found' }, 404);
  const rows = await db
    .select({
      id: folders.id,
      title: folders.title,
      parentFolderId: folders.parentFolderId,
      updatedAt: folders.updatedAt,
      isPrivate: folders.isPrivate,
      isAgentReadOnly: folders.isAgentReadOnly,
      hasChildren: exists(
        db
          .select({ one: sql`1` })
          .from(childFolders)
          .where(
            and(
              eq(childFolders.userId, folders.userId),
              eq(childFolders.parentFolderId, folders.id),
              isNull(childFolders.deletedAt)
            )
          )
      ),
    })
    .from(folders)
    .where(
      and(
        eq(folders.userId, access.resourceOwnerUserId),
        eq(folders.parentFolderId, folderId),
        isNull(folders.deletedAt),
        cursor
          ? or(gt(folders.title, cursor.title), and(eq(folders.title, cursor.title), gt(folders.id, cursor.id)))
          : undefined
      )
    )
    .orderBy(asc(folders.title), asc(folders.id))
    .limit(requestedLimit + 1);
  const hasMore = rows.length > requestedLimit;
  const items = rows.slice(0, requestedLimit).map((folder) => ({
    ...folder,
    hasChildren: Boolean(folder.hasChildren),
  }));
  const last = items.at(-1);
  return c.json({
    folders: items,
    pageInfo: {
      hasMore,
      nextCursor: hasMore && last ? encodeFolderChildrenCursor(last) : null,
    },
  });
});

folderRoutes.get('/:folderId/detail', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const folderId = c.req.param('folderId');
  const access = await resolveFolderCollaborationAccess({ actorUserId: user.id, folderId });
  if (!access) return c.json({ error: 'Folder not found' }, 404);
  const [folderRow] = await db
    .select({
      folder: folders,
      owner: { id: users.id, name: users.name, email: users.email },
    })
    .from(folders)
    .innerJoin(users, eq(users.id, folders.userId))
    .where(activeFolderWhere(access.resourceOwnerUserId, eq(folders.id, folderId)))
    .limit(1);
  if (!folderRow) return c.json({ error: 'Folder not found' }, 404);
  const { folder, owner } = folderRow;
  const ancestors: Array<typeof folders.$inferSelect> = [];
  const seenAncestorIds = new Set<string>();
  let parentFolderId = folder.parentFolderId;
  while (parentFolderId && !seenAncestorIds.has(parentFolderId)) {
    seenAncestorIds.add(parentFolderId);
    const parentAccess = await resolveFolderCollaborationAccess({ actorUserId: user.id, folderId: parentFolderId });
    if (!parentAccess || parentAccess.resourceOwnerUserId !== access.resourceOwnerUserId) break;
    const [parentFolder] = await db
      .select()
      .from(folders)
      .where(activeFolderWhere(access.resourceOwnerUserId, eq(folders.id, parentFolderId)))
      .limit(1);
    if (!parentFolder) break;
    ancestors.unshift(parentFolder);
    parentFolderId = parentFolder.parentFolderId;
  }
  const childFolders = await db
    .select()
    .from(folders)
    .where(activeFolderWhere(access.resourceOwnerUserId, eq(folders.parentFolderId, folderId)));
  const trashableFolderIds =
    access.role === 'owner'
      ? new Set([folder.id, ...childFolders.map((child) => child.id)])
      : await listTrashableFolderIds({
          actorUserId: user.id,
          resources: [folder, ...childFolders].map((candidate) => ({ id: candidate.id, userId: candidate.userId })),
        });
  const serializeFolder = (value: typeof folders.$inferSelect) => ({
    ...omitCollaborationInternalFields(value),
    canTrash: trashableFolderIds.has(value.id),
  });
  return c.json({
    folder: serializeFolder(ancestors.length > 0 ? folder : { ...folder, parentFolderId: null }),
    ancestors: ancestors.map((ancestor) => ({ ...omitCollaborationInternalFields(ancestor), canTrash: false })),
    childFolders: childFolders.map(serializeFolder),
    access: serializeCollaborationAccess(access),
    sharedBy:
      access.source === 'folder_grant'
        ? serializeCollaborationUserIdentity({ ...owner, currentUserId: user.id })
        : null,
  });
});

folderRoutes.get('/:folderId/notes', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const folderId = c.req.param('folderId');
  let access = await resolveFolderCollaborationAccess({ actorUserId: user.id, folderId });
  if (!access) {
    const [ownedFolder] = await db
      .select({ id: folders.id })
      .from(folders)
      .where(and(eq(folders.id, folderId), eq(folders.userId, user.id)))
      .limit(1);
    if (!ownedFolder) return c.json({ error: 'Folder not found' }, 404);
    access = {
      actorUserId: user.id,
      resourceOwnerUserId: user.id,
      role: 'owner',
      source: 'owner',
      applicableGrantIds: [],
    };
  }
  const type = c.req.query('type') === 'template' ? 'template' : 'note';
  if (type === 'template' && access.role !== 'owner') return c.json({ error: 'Folder not found' }, 404);
  const page = parsePageRequest(c.req.query('page'), c.req.query('limit'));
  const result = await listDocuments({
    userId: access.resourceOwnerUserId,
    folderId,
    type,
    offset: page.offset,
    limit: page.limit,
  });
  const trashableNoteIds = await listTrashableNoteIds({
    actorUserId: user.id,
    noteIds: result.value.documents.map((note) => note.id),
    access,
  });
  const serializedNotes = result.value.documents.map((note) => {
    const safeNote =
      access.role === 'owner'
        ? omitResourceCreator(note)
        : { ...omitCollaborationInternalFields(note), updatedByActorId: null };
    return { ...safeNote, canTrash: trashableNoteIds.has(note.id) };
  });
  return c.json({
    notes: serializedNotes,
    access: serializeCollaborationAccess(access),
    page: page.page,
    limit: page.limit,
    hasMore: result.value.hasMore,
  });
});

folderRoutes.get('/:folderId/templates', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const rows = await db
    .select({ template: compactNoteSelection })
    .from(templateFolderAssignments)
    .innerJoin(notes, eq(templateFolderAssignments.templateId, notes.id))
    .innerJoin(folders, eq(templateFolderAssignments.folderId, folders.id))
    .where(
      and(
        eq(templateFolderAssignments.userId, user.id),
        activeFolderWhere(user.id, eq(folders.id, c.req.param('folderId'))),
        activeNoteWhere(user.id, eq(notes.type, 'template'))
      )
    )
    .orderBy(notes.title, notes.id);
  return c.json({ templates: rows.map((row) => row.template) });
});

folderRoutes.post('/:folderId/notes', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const access = await resolveFolderCollaborationAccess({
    actorUserId: user.id,
    folderId: c.req.param('folderId'),
  });
  if (!access) return c.json({ error: 'Folder not found' }, 404);
  if (!collaborationRoleAllows(access.role, 'create')) return c.json({ error: 'Forbidden' }, 403);

  const body = (await c.req.json().catch(() => ({}))) as {
    title?: string;
    content?: string;
    type?: 'note' | 'template';
    documentType?: 'markdown' | 'canvas.default' | 'canvas.mindmap';
  };
  const documentType =
    body.documentType === 'canvas.default' || body.documentType === 'canvas.mindmap' ? body.documentType : 'markdown';
  if (body.type === 'template' && access.role !== 'owner')
    return c.json({ error: 'Collaborators cannot create templates' }, 403);
  if (body.type === 'template' && documentType !== 'markdown')
    return c.json({ error: 'Templates must be markdown documents' }, 400);
  const result = await createDocument({
    userId: access.resourceOwnerUserId,
    creatorUserId: user.id,
    folderId: c.req.param('folderId'),
    title: body.title,
    markdown: body.content,
    documentType,
    type: body.type === 'template' ? 'template' : 'note',
    actorType: 'user',
    actorId: user.id,
  });

  if (!result.ok) return c.json({ error: result.error }, result.status);
  if (access.role === 'owner') return c.json({ note: omitResourceCreator(result.value.note) }, 201);
  return c.json({ note: { ...omitCollaborationInternalFields(result.value.note), updatedByActorId: null } }, 201);
});

folderRoutes.delete('/:folderId', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const folderId = c.req.param('folderId');
  const eligibility = await resolveFolderTrashEligibility({ actorUserId: user.id, folderId });
  if (!eligibility.allowed) {
    const error = trashEligibilityStatus(eligibility);
    return c.json(
      { error: error?.status === 404 ? 'Folder not found' : (error?.error ?? 'Forbidden') },
      error?.status ?? 403
    );
  }
  const result = await trashFolder({
    userId: eligibility.resourceOwnerUserId,
    folderId,
    actorType: 'user',
    actorId: user.id,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ ok: true, ...result.value });
});
