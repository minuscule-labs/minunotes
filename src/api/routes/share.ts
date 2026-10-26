import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { BoardValidationError } from '../../shared/board';
import { NoteQueryError } from '../../shared/note-filters';
import { PropertyError } from '../../shared/properties';
import { db } from '../db/client';
import { attachments, folderShareLinks, folders, noteShareLinks, notes } from '../db/schema';
import {
  type ShareObservabilityEnv,
  type ShareSnapshotMeasurement,
  shareSnapshotObservability,
} from '../lib/share-observability';
import { hashShareToken } from '../lib/share-tokens';
import { parseBoardLaneRequest } from '../notes/board-request';
import { readAuthorizedBoard, readAuthorizedBoardLane } from '../notes/boards';
import { sanitizeCanvasNoteLinksForVisibleTargets } from '../notes/links';
import {
  databaseSharedWikilinkRepository,
  resolveSourceWikilinks,
  type SharedWikilinkRepository,
} from '../shared/wikilink-resolver';
import { getObjectStorage } from '../storage';
import { activeNoteWhere, filterActiveFolderHierarchy } from '../trash/policy';
import { attachmentContentResponse } from './attachments';

export const shareRoutes = new Hono<ShareObservabilityEnv>();

async function loadActiveNoteShare(token: string) {
  const tokenHash = hashShareToken(token);
  const now = new Date();
  const [row] = await db
    .select({
      note: notes,
      share: {
        id: noteShareLinks.id,
        permission: noteShareLinks.permission,
        createdAt: noteShareLinks.createdAt,
      },
    })
    .from(noteShareLinks)
    .innerJoin(notes, eq(noteShareLinks.noteId, notes.id))
    .innerJoin(folders, eq(notes.folderId, folders.id))
    .where(
      and(
        eq(noteShareLinks.tokenHash, tokenHash),
        isNull(notes.deletedAt),
        isNull(folders.deletedAt),
        isNull(noteShareLinks.revokedAt),
        or(isNull(noteShareLinks.expiresAt), gt(noteShareLinks.expiresAt, now))
      )
    )
    .limit(1);
  if (!row) return null;
  const activeFolders = await loadUserFolders(row.note.userId);
  return activeFolders.some((folder) => folder.id === row.note.folderId) ? row : null;
}

async function loadActiveFolderShare(token: string, measurement?: ShareSnapshotMeasurement) {
  const tokenHash = hashShareToken(token);
  const now = new Date();
  const [row] = await db
    .select({
      folder: folders,
      share: {
        id: folderShareLinks.id,
        permission: folderShareLinks.permission,
        createdAt: folderShareLinks.createdAt,
      },
    })
    .from(folderShareLinks)
    .innerJoin(folders, eq(folderShareLinks.folderId, folders.id))
    .where(
      and(
        eq(folderShareLinks.tokenHash, tokenHash),
        isNull(folders.deletedAt),
        isNull(folderShareLinks.revokedAt),
        or(isNull(folderShareLinks.expiresAt), gt(folderShareLinks.expiresAt, now))
      )
    )
    .limit(1);
  if (!row) return null;
  if (measurement) measurement.folderQueryCalls++;
  const userFolders = await loadUserFolders(row.folder.userId);
  if (!userFolders.some((folder) => folder.id === row.folder.id)) return null;
  const folderIds = collectFolderTreeIds(row.folder.id, userFolders);
  return { ...row, userFolders, folderIds };
}

async function loadUserFolders(userId: string) {
  const rows = await db
    .select({
      id: folders.id,
      parentFolderId: folders.parentFolderId,
      title: folders.title,
      updatedAt: folders.updatedAt,
    })
    .from(folders)
    .where(and(eq(folders.userId, userId), isNull(folders.deletedAt)))
    .orderBy(asc(folders.title));
  return filterActiveFolderHierarchy(rows);
}

function collectFolderTreeIds(rootFolderId: string, userFolders: Array<{ id: string; parentFolderId: string | null }>) {
  const folderIds = new Set([rootFolderId]);
  let added = true;
  while (added) {
    added = false;
    for (const folder of userFolders) {
      if (folder.parentFolderId && folderIds.has(folder.parentFolderId) && !folderIds.has(folder.id)) {
        folderIds.add(folder.id);
        added = true;
      }
    }
  }
  return folderIds;
}

async function loadSharedAttachment(input: { userId: string; noteId: string; attachmentId: string }) {
  const [attachment] = await db
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.id, input.attachmentId),
        eq(attachments.userId, input.userId),
        eq(attachments.noteId, input.noteId),
        isNull(attachments.deletedAt),
        eq(attachments.status, 'ready')
      )
    )
    .limit(1);
  if (!attachment) return null;
  const object = await getObjectStorage().getObject({ key: attachment.storageKey });
  return object ? { attachment, object } : null;
}

function sharedAttachmentResponse(result: NonNullable<Awaited<ReturnType<typeof loadSharedAttachment>>>) {
  return attachmentContentResponse({
    body: result.object.body,
    contentType: result.object.contentType ?? result.attachment.mimeType,
    cacheControl: 'no-store',
    sandbox: true,
  });
}

shareRoutes.get('/folders/:token/notes/:noteId/attachments/:attachmentId/content', async (c) => {
  const token = c.req.param('token').trim();
  if (!token) return c.json({ error: 'Shared attachment not found' }, 404);

  const row = await loadActiveFolderShare(token);
  if (!row) return c.json({ error: 'Shared attachment not found' }, 404);
  const { folderIds } = row;
  const noteId = c.req.param('noteId');
  const [source] = await db
    .select({ id: notes.id, folderId: notes.folderId })
    .from(notes)
    .where(activeNoteWhere(row.folder.userId, eq(notes.id, noteId), eq(notes.type, 'note')))
    .limit(1);
  if (!source || !folderIds.has(source.folderId)) return c.json({ error: 'Shared attachment not found' }, 404);

  const result = await loadSharedAttachment({
    userId: row.folder.userId,
    noteId: source.id,
    attachmentId: c.req.param('attachmentId'),
  });
  return result ? sharedAttachmentResponse(result) : c.json({ error: 'Shared attachment not found' }, 404);
});

shareRoutes.get('/:token/attachments/:attachmentId/content', async (c) => {
  const token = c.req.param('token').trim();
  if (!token) return c.json({ error: 'Shared attachment not found' }, 404);

  const row = await loadActiveNoteShare(token);
  if (!row) return c.json({ error: 'Shared attachment not found' }, 404);
  const result = await loadSharedAttachment({
    userId: row.note.userId,
    noteId: row.note.id,
    attachmentId: c.req.param('attachmentId'),
  });
  return result ? sharedAttachmentResponse(result) : c.json({ error: 'Shared attachment not found' }, 404);
});

shareRoutes.get('/folders/:token/notes/:noteId/wikilinks', async (c) => {
  const token = c.req.param('token').trim();
  if (!token) return c.json({ error: 'Shared note not found' }, 404);

  const row = await loadActiveFolderShare(token);
  if (!row) return c.json({ error: 'Shared note not found' }, 404);
  const { userFolders, folderIds } = row;
  const [source] = await db
    .select()
    .from(notes)
    .where(activeNoteWhere(row.folder.userId, eq(notes.id, c.req.param('noteId')), eq(notes.type, 'note')))
    .limit(1);
  if (!source || !folderIds.has(source.folderId)) return c.json({ error: 'Shared note not found' }, 404);

  const repository: SharedWikilinkRepository = {
    ...databaseSharedWikilinkRepository,
    listFolders: async () => userFolders,
  };
  const resolutions = await resolveSourceWikilinks(
    { kind: 'folder', token, folderId: row.folder.id, source },
    { repository }
  );
  return c.json({ resolutions });
});

// A board is a presentation of an existing folder share, never a separate grant.
async function loadSharedBoardFolder(token: string, folderId: string) {
  const row = await loadActiveFolderShare(token.trim());
  if (!row) return null;
  return row.folderIds.has(folderId) ? row.folder.userId : null;
}

shareRoutes.get('/folders/:token/folders/:folderId/board/config', async (c) => {
  c.header('Cache-Control', 'no-store');
  const folderId = c.req.param('folderId');
  const ownerId = await loadSharedBoardFolder(c.req.param('token'), folderId);
  if (!ownerId) return c.json({ error: 'Shared folder not found' }, 404);
  try {
    // The public token has already authorized this folder. Reuse the owner's
    // board reader so classification, active-note rules and snapshots stay identical.
    return c.json({ board: await readAuthorizedBoard(ownerId, ownerId, folderId) });
  } catch (error) {
    if (error instanceof PropertyError) return c.json({ error: error.message }, error.status);
    if (error instanceof BoardValidationError) return c.json({ error: error.message }, 400);
    throw error;
  }
});

shareRoutes.get('/folders/:token/folders/:folderId/board', async (c) => {
  c.header('Cache-Control', 'no-store');
  const folderId = c.req.param('folderId');
  const ownerId = await loadSharedBoardFolder(c.req.param('token'), folderId);
  if (!ownerId) return c.json({ error: 'Shared folder not found' }, 404);
  try {
    return c.json(
      await readAuthorizedBoardLane({
        ...parseBoardLaneRequest(new URL(c.req.url).searchParams),
        actorUserId: ownerId,
        userId: ownerId,
        folderId,
      })
    );
  } catch (error) {
    if (error instanceof PropertyError) return c.json({ error: error.message }, error.status);
    if (error instanceof BoardValidationError || error instanceof NoteQueryError)
      return c.json({ error: error.message }, 400);
    throw error;
  }
});

shareRoutes.get('/folders/:token', shareSnapshotObservability, async (c) => {
  const token = c.req.param('token').trim();
  if (!token) return c.json({ error: 'Shared folder not found' }, 404);

  const measurement = c.get('shareSnapshotMeasurement');
  const row = await loadActiveFolderShare(token, measurement);
  if (!row || row.folderIds.size === 0) return c.json({ error: 'Shared folder not found' }, 404);
  const { userFolders, folderIds } = row;
  const fetchNotes = () =>
    db
      .select({
        id: notes.id,
        folderId: notes.folderId,
        title: notes.title,
        content: notes.content,
        documentType: notes.documentType,
        updatedAt: notes.updatedAt,
      })
      .from(notes)
      .where(
        activeNoteWhere(
          row.folder.userId,
          eq(notes.type, 'note'),
          // One bound JSON value regardless of subtree size; SQLite owns ordering.
          // json_each is already required by the existing property/Board readers.
          sql`${notes.folderId} in (select value from json_each(${JSON.stringify([...folderIds])}))`
        )
      )
      .orderBy(asc(notes.title));
  const visibleNotes = measurement ? await measurement.fetchNotes(fetchNotes) : await fetchNotes();
  const visibleNoteIds = new Set(visibleNotes.map((note) => note.id));
  return c.json({
    folder: {
      id: row.folder.id,
      title: row.folder.title,
      updatedAt: row.folder.updatedAt,
    },
    folders: userFolders.filter((folder) => folder.id !== row.folder.id && folderIds.has(folder.id)),
    notes: visibleNotes.map((note) =>
      note.documentType.startsWith('canvas.')
        ? {
            ...note,
            content: sanitizeCanvasNoteLinksForVisibleTargets({
              content: note.content,
              visibleTargetIds: visibleNoteIds,
            }).content,
          }
        : note
    ),
    share: row.share,
  });
});

shareRoutes.get('/:token', async (c) => {
  const token = c.req.param('token').trim();
  if (!token) return c.json({ error: 'Shared note not found' }, 404);

  const row = await loadActiveNoteShare(token);
  if (!row) return c.json({ error: 'Shared note not found' }, 404);
  const resolutions = await resolveSourceWikilinks({ kind: 'note', token, source: row.note });
  const content = row.note.documentType.startsWith('canvas.')
    ? sanitizeCanvasNoteLinksForVisibleTargets({ content: row.note.content, visibleTargetIds: new Set() }).content
    : row.note.content;
  return c.json({
    note: {
      title: row.note.title,
      content,
      documentType: row.note.documentType,
      updatedAt: row.note.updatedAt,
    },
    share: row.share,
    resolutions,
  });
});
