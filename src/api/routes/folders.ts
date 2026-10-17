import { and, asc, eq, exists, gt, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { BoardValidationError } from '../../shared/board';
import { hasNoteQuery, NoteQueryError } from '../../shared/note-filters';
import { DEFAULT_NOTE_SORT } from '../../shared/note-sort';
import { PropertyError } from '../../shared/properties';
import { templateObject } from '../../shared/templates';
import { db } from '../db/client';
import { folderShareLinks, folders, user as users } from '../db/schema';
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
import { createRequestSizeLimitMiddleware } from '../middleware/request-limits';
import { readAuthorizedBoard, readAuthorizedBoardLane, saveBoardConfig } from '../notes/boards';
import { parseFolderQueryRequest, readFilteredFolderNotes } from '../notes/folder-query';
import {
  deletePropertyOption,
  mutateFolderProperties,
  previewOptionDeletion,
  readFolderProperties,
} from '../notes/properties';
import { createFromTemplate, listAssignedTemplates, previewAssignedTemplate } from '../notes/templates';
import { trashFolder } from '../trash/operations';
import { activeFolderWhere } from '../trash/policy';

type Variables = {
  user: typeof auth.$Infer.Session.user | null;
  session: typeof auth.$Infer.Session.session | null;
};

export const folderRoutes = new Hono<{ Variables: Variables }>();

folderRoutes.use('/:folderId/properties', createRequestSizeLimitMiddleware({ maxBytes: 256 * 1024 }));
folderRoutes.get('/:folderId/properties', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  try {
    return c.json(await readFolderProperties({ actorUserId: user.id }, c.req.param('folderId')));
  } catch (error) {
    if (error instanceof PropertyError) return c.json({ error: error.message }, error.status);
    throw error;
  }
});
folderRoutes.patch('/:folderId/properties', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  try {
    return c.json(
      await mutateFolderProperties(
        { actorUserId: user.id },
        c.req.param('folderId'),
        await c.req.json().catch(() => null)
      )
    );
  } catch (error) {
    if (error instanceof PropertyError) return c.json({ error: error.message }, error.status);
    throw error;
  }
});

// The shared limiter handles POST/PUT/PATCH only; this flow also sends a DELETE body.
folderRoutes.use(
  '/:folderId/properties/*',
  bodyLimit({
    maxSize: 4096,
    onError: (c) => c.json({ error: 'Request body too large' }, 413),
  })
);
folderRoutes.get('/:folderId/properties/:propertyId/options/:optionId/deletion-preview', async (c) => {
  c.header('Cache-Control', 'no-store');
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  try {
    return c.json(
      await previewOptionDeletion(
        { actorUserId: user.id },
        c.req.param('folderId'),
        c.req.param('propertyId'),
        c.req.param('optionId')
      )
    );
  } catch (error) {
    if (error instanceof PropertyError) return c.json({ error: error.message }, error.status);
    throw error;
  }
});
folderRoutes.delete('/:folderId/properties/:propertyId/options/:optionId', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  // Also enforce actual bytes when a supplied Content-Length understates the body.
  if ((await c.req.raw.clone().arrayBuffer()).byteLength > 4096)
    return c.json({ error: 'Request body too large' }, 413);
  try {
    return c.json(
      await deletePropertyOption(
        { actorUserId: user.id },
        c.req.param('folderId'),
        c.req.param('propertyId'),
        c.req.param('optionId'),
        await c.req.json().catch(() => null)
      )
    );
  } catch (error) {
    if (error instanceof PropertyError) return c.json({ error: error.message }, error.status);
    throw error;
  }
});

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

folderRoutes.use('/:folderId/board/config', createRequestSizeLimitMiddleware({ maxBytes: 16384 }));

folderRoutes.get('/:folderId/board/config', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const folderId = c.req.param('folderId');
  const access = await resolveFolderCollaborationAccess({ actorUserId: user.id, folderId });
  if (!access) return c.json({ error: 'Folder not found' }, 404);
  try {
    return c.json({
      board: await readAuthorizedBoard(user.id, access.resourceOwnerUserId, folderId),
      access: serializeCollaborationAccess(access),
    });
  } catch (error) {
    if (error instanceof PropertyError) return c.json({ error: error.message }, error.status);
    throw error;
  }
});

folderRoutes.put('/:folderId/board/config', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const folderId = c.req.param('folderId');
  const access = await resolveFolderCollaborationAccess({ actorUserId: user.id, folderId });
  if (!access) return c.json({ error: 'Folder not found' }, 404);
  if (access.role !== 'owner') return c.json({ error: 'Only the folder owner can configure the board' }, 403);
  const text = await c.req.text();
  if (new TextEncoder().encode(text).length > 16384) return c.json({ error: 'Payload exceeds 16 KiB' }, 413);
  let body: { config?: unknown; expectedVersion?: number; schemaId?: string; schemaRevision?: number };
  try {
    body = JSON.parse(text);
    if (
      !body ||
      !Number.isSafeInteger(body.expectedVersion) ||
      (body.expectedVersion ?? -1) < 0 ||
      (body.expectedVersion ?? 0) >= Number.MAX_SAFE_INTEGER
    )
      throw new BoardValidationError('A nonnegative expectedVersion is required');
    if (
      (body.schemaId !== undefined || body.schemaRevision !== undefined) &&
      (typeof body.schemaId !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(body.schemaId) ||
        !Number.isSafeInteger(body.schemaRevision) ||
        (body.schemaRevision ?? -1) < 1 ||
        (body.schemaRevision ?? 0) >= Number.MAX_SAFE_INTEGER)
    )
      throw new BoardValidationError('Invalid reviewed schema token');
    const board = await saveBoardConfig(
      access.resourceOwnerUserId,
      folderId,
      body.config,
      body.expectedVersion as number,
      body.schemaId !== undefined
        ? { schemaId: body.schemaId, schemaRevision: body.schemaRevision as number }
        : undefined
    );
    if (!board) return c.json({ error: 'Board configuration changed. Reload settings before saving.' }, 409);
    return c.json({ board });
  } catch (error) {
    if (error instanceof PropertyError) return c.json({ error: error.message }, error.status);
    if (error instanceof SyntaxError || error instanceof BoardValidationError)
      return c.json({ error: error instanceof Error ? error.message : 'Invalid configuration' }, 400);
    throw error;
  }
});

folderRoutes.get('/:folderId/board', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  let readQuery: ReturnType<typeof parseFolderQueryRequest>;
  try {
    readQuery = parseFolderQueryRequest(new URL(c.req.url).searchParams);
  } catch (error) {
    if (error instanceof NoteQueryError) return c.json({ error: error.message }, 400);
    throw error;
  }
  const folderId = c.req.param('folderId');
  const access = await resolveFolderCollaborationAccess({ actorUserId: user.id, folderId });
  if (!access) return c.json({ error: 'Folder not found' }, 404);
  for (const key of ['version', 'lane', 'page', 'limit', 'schemaId', 'schemaRevision']) {
    if ((c.req.queries(key)?.length ?? 0) > 1) return c.json({ error: `Repeated ${key} parameter` }, 400);
  }
  const version = c.req.query('version');
  if (version !== undefined && (!/^[1-9]\d*$/.test(version) || !Number.isSafeInteger(Number(version))))
    return c.json({ error: 'Invalid configuration version' }, 400);
  const lane = c.req.query('lane') ?? '';
  const schemaId = c.req.query('schemaId');
  const schemaRevision = c.req.query('schemaRevision');
  if (schemaId !== undefined && !/^[a-zA-Z0-9_-]{1,100}$/.test(schemaId))
    return c.json({ error: 'Invalid schema identity' }, 400);
  if (
    schemaRevision !== undefined &&
    (!/^[1-9]\d*$/.test(schemaRevision) ||
      !Number.isSafeInteger(Number(schemaRevision)) ||
      Number(schemaRevision) >= Number.MAX_SAFE_INTEGER)
  )
    return c.json({ error: 'Invalid schema revision' }, 400);
  if (['tag', 'boardTags', 'includeTags', 'excludeTags'].some((key) => c.req.queries(key) !== undefined))
    return c.json({ error: 'Board tag filters are no longer supported. Refresh the property-only board.' }, 400);
  const page = parsePageRequest(c.req.query('page'), c.req.query('limit'), { defaultLimit: 25 });
  if (!Number.isSafeInteger(page.offset) || page.offset > 1000000)
    return c.json({ error: 'Page is out of range' }, 400);
  try {
    return c.json({
      ...(await readAuthorizedBoardLane({
        actorUserId: user.id,
        userId: access.resourceOwnerUserId,
        folderId,
        lane,
        page,
        query: readQuery.query,
        sort: readQuery.sort,
        version: version === undefined ? undefined : Number(version),
        schemaId,
        schemaRevision: schemaRevision === undefined ? undefined : Number(schemaRevision),
      })),
      access: serializeCollaborationAccess(access),
    });
  } catch (error) {
    if (error instanceof PropertyError) return c.json({ error: error.message }, error.status);
    if (error instanceof BoardValidationError) return c.json({ error: error.message }, 400);
    throw error;
  }
});

folderRoutes.get('/:folderId/notes', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const type = c.req.query('type') === 'template' ? 'template' : 'note';
  let readQuery: ReturnType<typeof parseFolderQueryRequest> | undefined;
  if (type === 'note') {
    try {
      readQuery = parseFolderQueryRequest(new URL(c.req.url).searchParams);
    } catch (error) {
      if (error instanceof NoteQueryError) return c.json({ error: error.message }, 400);
      throw error;
    }
  }

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
  if (type === 'template' && access.role !== 'owner') return c.json({ error: 'Folder not found' }, 404);
  const page = parsePageRequest(c.req.query('page'), c.req.query('limit'));
  let filtered: Awaited<ReturnType<typeof readFilteredFolderNotes>> | undefined;
  if (readQuery && (hasNoteQuery(readQuery.query) || readQuery.sort !== DEFAULT_NOTE_SORT)) {
    if (!Number.isSafeInteger(page.offset) || page.offset > 1000000)
      return c.json({ error: 'Page is out of range' }, 400);
    try {
      filtered = await readFilteredFolderNotes({
        ...readQuery,
        actorUserId: user.id,
        ownerId: access.resourceOwnerUserId,
        folderId,
        page,
      });
    } catch (error) {
      if (error instanceof PropertyError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  }
  const result = filtered
    ? { ok: true, value: filtered }
    : await listDocuments({
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
    ...(filtered
      ? {
          queryIdentity: filtered.queryIdentity,
          ...(filtered.querySchema ? { querySchema: filtered.querySchema } : {}),
          ...(filtered.sortIdentity ? { sortIdentity: filtered.sortIdentity } : {}),
        }
      : {}),
    access: serializeCollaborationAccess(access),
    page: page.page,
    limit: page.limit,
    hasMore: result.value.hasMore,
  });
});

folderRoutes.get('/:folderId/templates', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  try {
    return c.json({ templates: await listAssignedTemplates({ actorUserId: user.id }, c.req.param('folderId')) });
  } catch (error) {
    if (error instanceof PropertyError) return c.json({ error: error.message }, error.status);
    throw error;
  }
});
folderRoutes.get('/:folderId/templates/:templateId/preview', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  try {
    return c.json(
      await previewAssignedTemplate({ actorUserId: user.id }, c.req.param('folderId'), c.req.param('templateId'))
    );
  } catch (error) {
    if (error instanceof PropertyError) return c.json({ error: error.message }, error.status);
    throw error;
  }
});
folderRoutes.use('/:folderId/notes/from-template', createRequestSizeLimitMiddleware({ maxBytes: 256 * 1024 }));
folderRoutes.post('/:folderId/notes/from-template', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  try {
    const body = templateObject(await c.req.json().catch(() => null));
    if (Object.hasOwn(body, 'folderId') && body.folderId !== c.req.param('folderId'))
      throw new PropertyError('Destination mismatch');
    const result = await createFromTemplate({ actorUserId: user.id }, { ...body, folderId: c.req.param('folderId') });
    return c.json(result, result.replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof PropertyError) return c.json({ error: error.message }, error.status);
    throw error;
  }
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
