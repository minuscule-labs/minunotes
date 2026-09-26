import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, notExists, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import {
  attachments,
  folderShareLinks,
  folders,
  noteCommentThreads,
  noteEvents,
  noteShareLinks,
  notes,
  noteTags,
  noteVersions,
  tags,
} from '../db/schema';
import { hashMarkdown } from '../harness/hash';
import {
  isDescendantOrSelf,
  isFolderEffectivelyAgentReadOnly,
  isFolderEffectivelyPrivate,
  loadFolderAccessTree,
} from '../lib/folder-access';
import { createId } from '../lib/id';
import { getObjectStorage } from '../storage';
import { activeFolderWhere, activeNoteWhere } from './policy';

export type TrashOperationResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 404; error: string }
  | { ok: false; status: 409; error: string; requiresDestination?: boolean };

export type TrashedNoteSummary = {
  id: string;
  folderId: string;
  title: string;
  documentType: 'markdown' | 'canvas.default' | 'canvas.mindmap';
  type: 'note' | 'template';
  deletedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  originalFolderTitle: string | null;
  originalFolderAvailable: boolean;
};

export async function listTrashedNotes(input: { userId: string; offset?: number; limit?: number }) {
  const rows = await db
    .select({
      id: notes.id,
      folderId: notes.folderId,
      title: notes.title,
      documentType: notes.documentType,
      type: notes.type,
      deletedAt: notes.deletedAt,
      createdAt: notes.createdAt,
      updatedAt: notes.updatedAt,
      originalFolderTitle: folders.title,
    })
    .from(notes)
    .leftJoin(folders, and(eq(notes.folderId, folders.id), eq(folders.userId, input.userId)))
    .where(and(eq(notes.userId, input.userId), isNotNull(notes.deletedAt), isNull(notes.trashBatchId)))
    .orderBy(desc(notes.deletedAt), desc(notes.updatedAt), asc(notes.id))
    .limit(input.limit ? input.limit + 1 : -1)
    .offset(input.offset ?? 0);

  const activeFolders = await db.select({ id: folders.id }).from(folders).where(activeFolderWhere(input.userId));
  const activeFolderIds = new Set(activeFolders.map((folder) => folder.id));

  return rows.flatMap((row) =>
    row.deletedAt
      ? [
          {
            ...row,
            deletedAt: row.deletedAt,
            originalFolderAvailable: activeFolderIds.has(row.folderId),
          } satisfies TrashedNoteSummary,
        ]
      : []
  );
}

export type TrashedFolderContents = {
  rootFolderId: string;
  folders: Array<{
    id: string;
    parentFolderId: string | null;
    title: string;
    deletedAt: Date;
    createdAt: Date;
    updatedAt: Date;
  }>;
  notes: Array<{
    id: string;
    folderId: string;
    title: string;
    documentType: 'markdown' | 'canvas.default' | 'canvas.mindmap';
    type: 'note' | 'template';
    deletedAt: Date;
    createdAt: Date;
    updatedAt: Date;
  }>;
};

export async function listTrashedFolderContents(input: {
  userId: string;
  folderId: string;
}): Promise<TrashOperationResult<TrashedFolderContents>> {
  const [root] = await db
    .select({ id: folders.id })
    .from(folders)
    .where(
      and(
        eq(folders.id, input.folderId),
        eq(folders.userId, input.userId),
        isNotNull(folders.deletedAt),
        eq(folders.trashBatchId, input.folderId)
      )
    )
    .limit(1);
  if (!root) return { ok: false, status: 404, error: 'Trashed folder not found' };

  const [folderRows, noteRows] = await Promise.all([
    db
      .select({
        id: folders.id,
        parentFolderId: folders.parentFolderId,
        title: folders.title,
        deletedAt: folders.deletedAt,
        createdAt: folders.createdAt,
        updatedAt: folders.updatedAt,
      })
      .from(folders)
      .where(
        and(eq(folders.userId, input.userId), isNotNull(folders.deletedAt), eq(folders.trashBatchId, input.folderId))
      )
      .orderBy(asc(folders.title)),
    db
      .select({
        id: notes.id,
        folderId: notes.folderId,
        title: notes.title,
        documentType: notes.documentType,
        type: notes.type,
        deletedAt: notes.deletedAt,
        createdAt: notes.createdAt,
        updatedAt: notes.updatedAt,
      })
      .from(notes)
      .where(and(eq(notes.userId, input.userId), isNotNull(notes.deletedAt), eq(notes.trashBatchId, input.folderId)))
      .orderBy(asc(notes.title)),
  ]);

  return {
    ok: true,
    value: {
      rootFolderId: root.id,
      folders: folderRows.flatMap((folder) => (folder.deletedAt ? [{ ...folder, deletedAt: folder.deletedAt }] : [])),
      notes: noteRows.flatMap((note) => (note.deletedAt ? [{ ...note, deletedAt: note.deletedAt }] : [])),
    },
  };
}

export type TrashedFolderSummary = {
  id: string;
  parentFolderId: string | null;
  title: string;
  deletedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  originalParentTitle: string | null;
  originalParentAvailable: boolean;
  descendantFolderCount: number;
  noteCount: number;
};

export async function listTrashedFolders(input: { userId: string; offset?: number; limit?: number }) {
  const allFolders = await db.select().from(folders).where(eq(folders.userId, input.userId));
  const byId = new Map(allFolders.map((folder) => [folder.id, folder]));
  const activeFolders = await db.select({ id: folders.id }).from(folders).where(activeFolderWhere(input.userId));
  const activeFolderIds = new Set(activeFolders.map((folder) => folder.id));
  const roots = allFolders.filter((folder) => folder.deletedAt && folder.trashBatchId === folder.id);
  const batchNotes = await db
    .select({ trashBatchId: notes.trashBatchId })
    .from(notes)
    .where(and(eq(notes.userId, input.userId), isNotNull(notes.deletedAt), isNotNull(notes.trashBatchId)));

  return roots
    .map(
      (root) =>
        ({
          id: root.id,
          parentFolderId: root.parentFolderId,
          title: root.title,
          deletedAt: root.deletedAt as Date,
          createdAt: root.createdAt,
          updatedAt: root.updatedAt,
          originalParentTitle: root.parentFolderId ? (byId.get(root.parentFolderId)?.title ?? null) : null,
          originalParentAvailable: root.parentFolderId ? activeFolderIds.has(root.parentFolderId) : true,
          descendantFolderCount: allFolders.filter((folder) => folder.id !== root.id && folder.trashBatchId === root.id)
            .length,
          noteCount: batchNotes.filter((note) => note.trashBatchId === root.id).length,
        }) satisfies TrashedFolderSummary
    )
    .sort((left, right) => right.deletedAt.getTime() - left.deletedAt.getTime() || left.id.localeCompare(right.id))
    .slice(input.offset ?? 0, input.limit ? (input.offset ?? 0) + input.limit + 1 : undefined);
}

function noteTrashEvent(
  note: Pick<typeof notes.$inferSelect, 'id' | 'userId' | 'content'>,
  input: {
    eventType: 'trash' | 'restore_from_trash';
    summary: string;
    createdAt: Date;
    actorType?: 'user' | 'agent';
    actorId?: string | null;
  }
) {
  const contentHash = hashMarkdown(note.content);
  return {
    id: createId('note_event'),
    noteId: note.id,
    userId: note.userId,
    actorType: input.actorType ?? ('user' as const),
    actorId: input.actorId ?? null,
    eventType: input.eventType,
    summary: input.summary,
    beforeHash: contentHash,
    afterHash: contentHash,
    createdAt: input.createdAt,
  };
}

export async function trashFolder(input: {
  userId: string;
  folderId: string;
  actorType?: 'user' | 'agent';
  actorId?: string | null;
}): Promise<TrashOperationResult<{ deletedAt: Date; folderCount: number; noteCount: number }>> {
  const tree = await loadFolderAccessTree(input.userId);
  const root = tree.byId.get(input.folderId);
  if (!root) return { ok: false, status: 404, error: 'Folder not found' };

  const folderIds = tree.folders
    .filter((folder) => isDescendantOrSelf(folder.id, root.id, tree.byId))
    .map((folder) => folder.id);
  const activeNotes = await db
    .select()
    .from(notes)
    .where(activeNoteWhere(input.userId, inArray(notes.folderId, folderIds)));
  const noteIds = activeNotes.map((note) => note.id);
  const now = new Date();

  const trashed = await db.transaction(async (tx) => {
    const changedFolders = await tx
      .update(folders)
      .set({ deletedAt: now, trashBatchId: root.id })
      .where(and(eq(folders.userId, input.userId), inArray(folders.id, folderIds), isNull(folders.deletedAt)))
      .returning({ id: folders.id });
    if (changedFolders.length !== folderIds.length) throw new Error('Folder trash state changed');

    if (noteIds.length > 0) {
      const changedNotes = await tx
        .update(notes)
        .set({
          deletedAt: now,
          trashBatchId: root.id,
          updatedByActorType: input.actorType ?? 'user',
          updatedByActorId: input.actorId ?? null,
        })
        .where(and(eq(notes.userId, input.userId), inArray(notes.id, noteIds), isNull(notes.deletedAt)))
        .returning({ id: notes.id });
      if (changedNotes.length !== noteIds.length) throw new Error('Note trash state changed');
      await tx
        .update(noteShareLinks)
        .set({ revokedAt: now, updatedAt: now })
        .where(
          and(
            eq(noteShareLinks.userId, input.userId),
            inArray(noteShareLinks.noteId, noteIds),
            isNull(noteShareLinks.revokedAt)
          )
        );
      await tx.insert(noteEvents).values(
        activeNotes.map((note) =>
          noteTrashEvent(note, {
            eventType: 'trash',
            summary: 'Moved note to Trash with folder',
            createdAt: now,
            actorType: input.actorType,
            actorId: input.actorId,
          })
        )
      );
    }
    await tx
      .update(folderShareLinks)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(folderShareLinks.userId, input.userId),
          inArray(folderShareLinks.folderId, folderIds),
          isNull(folderShareLinks.revokedAt)
        )
      );
    return true;
  });

  return trashed
    ? { ok: true, value: { deletedAt: now, folderCount: folderIds.length, noteCount: noteIds.length } }
    : { ok: false, status: 404, error: 'Folder not found' };
}

export async function restoreTrashedFolder(input: {
  userId: string;
  folderId: string;
}): Promise<
  TrashOperationResult<{ folder: typeof folders.$inferSelect; restoredAtTopLevel: boolean; noteCount: number }>
> {
  const [root] = await db
    .select()
    .from(folders)
    .where(
      and(
        eq(folders.id, input.folderId),
        eq(folders.userId, input.userId),
        isNotNull(folders.deletedAt),
        eq(folders.trashBatchId, input.folderId)
      )
    )
    .limit(1);
  if (!root) return { ok: false, status: 404, error: 'Trashed folder not found' };

  let restoreParentId = root.parentFolderId;
  if (restoreParentId) {
    const [parent] = await db
      .select({ id: folders.id })
      .from(folders)
      .where(activeFolderWhere(input.userId, eq(folders.id, restoreParentId)))
      .limit(1);
    if (!parent) restoreParentId = null;
  }
  const restoredAtTopLevel = Boolean(root.parentFolderId && !restoreParentId);
  const batchNotes = await db
    .select()
    .from(notes)
    .where(and(eq(notes.userId, input.userId), isNotNull(notes.deletedAt), eq(notes.trashBatchId, input.folderId)));
  const now = new Date();

  const restored = await db.transaction(async (tx) => {
    const changedFolders = await tx
      .update(folders)
      .set({ deletedAt: null, trashBatchId: null })
      .where(
        and(eq(folders.userId, input.userId), isNotNull(folders.deletedAt), eq(folders.trashBatchId, input.folderId))
      )
      .returning({ id: folders.id });
    if (changedFolders.length === 0) throw new Error('Folder restore state changed');

    const [restoredRoot] = await tx
      .update(folders)
      .set({ parentFolderId: restoreParentId, updatedAt: now })
      .where(and(eq(folders.id, input.folderId), eq(folders.userId, input.userId), isNull(folders.deletedAt)))
      .returning();
    if (!restoredRoot) throw new Error('Folder restore state changed');

    if (batchNotes.length > 0) {
      const noteIds = batchNotes.map((note) => note.id);
      const changedNotes = await tx
        .update(notes)
        .set({
          deletedAt: null,
          trashBatchId: null,
          updatedByActorType: 'user',
          updatedByActorId: null,
          updatedAt: now,
        })
        .where(and(eq(notes.userId, input.userId), inArray(notes.id, noteIds), eq(notes.trashBatchId, input.folderId)))
        .returning({ id: notes.id });
      if (changedNotes.length !== noteIds.length) throw new Error('Note restore state changed');
      await tx.insert(noteEvents).values(
        batchNotes.map((note) =>
          noteTrashEvent(note, {
            eventType: 'restore_from_trash',
            summary: 'Restored note from Trash with folder',
            createdAt: now,
          })
        )
      );
    }
    return restoredRoot;
  });
  if (!restored) return { ok: false, status: 404, error: 'Trashed folder not found' };

  return { ok: true, value: { folder: restored, restoredAtTopLevel, noteCount: batchNotes.length } };
}

export async function permanentlyDeleteTrashedFolder(input: {
  userId: string;
  folderId: string;
}): Promise<
  TrashOperationResult<{ deletedFolderCount: number; deletedNoteCount: number; deletedAttachmentCount: number }>
> {
  const batchFolders = await db
    .select()
    .from(folders)
    .where(
      and(eq(folders.userId, input.userId), isNotNull(folders.deletedAt), eq(folders.trashBatchId, input.folderId))
    );
  if (!batchFolders.some((folder) => folder.id === input.folderId))
    return { ok: false, status: 404, error: 'Trashed folder not found' };

  const folderIds = batchFolders.map((folder) => folder.id);
  const standaloneNotes = await db
    .select({ id: notes.id })
    .from(notes)
    .where(
      and(
        eq(notes.userId, input.userId),
        inArray(notes.folderId, folderIds),
        isNotNull(notes.deletedAt),
        isNull(notes.trashBatchId)
      )
    )
    .limit(1);
  if (standaloneNotes.length > 0)
    return {
      ok: false,
      status: 409,
      error: 'Restore or permanently delete separately trashed notes in this folder first',
    };

  const separateTrashedRoots = await db
    .select()
    .from(folders)
    .where(
      and(
        eq(folders.userId, input.userId),
        inArray(folders.parentFolderId, folderIds),
        isNotNull(folders.deletedAt),
        or(isNull(folders.trashBatchId), ne(folders.trashBatchId, input.folderId))
      )
    );
  const allOwnerFolders = await db.select().from(folders).where(eq(folders.userId, input.userId));
  const allOwnerFoldersById = new Map(allOwnerFolders.map((folder) => [folder.id, folder]));
  const detachedRoots = separateTrashedRoots.map((folder) => ({
    ...folder,
    isPrivate: isFolderEffectivelyPrivate(folder.id, allOwnerFoldersById),
    isAgentReadOnly: isFolderEffectivelyAgentReadOnly(folder.id, allOwnerFoldersById),
  }));
  const batchNotes = await db
    .select({ id: notes.id })
    .from(notes)
    .where(and(eq(notes.userId, input.userId), isNotNull(notes.deletedAt), eq(notes.trashBatchId, input.folderId)));
  const noteIds = batchNotes.map((note) => note.id);
  const batchNoteIds = new Set(noteIds);
  const [versionReferences, attachmentReferences] = await Promise.all([
    db
      .select({ noteId: notes.id, currentFolderId: notes.folderId })
      .from(noteVersions)
      .innerJoin(notes, eq(noteVersions.noteId, notes.id))
      .where(and(eq(noteVersions.userId, input.userId), inArray(noteVersions.folderId, folderIds))),
    db
      .select({ noteId: notes.id, currentFolderId: notes.folderId })
      .from(attachments)
      .innerJoin(notes, eq(attachments.noteId, notes.id))
      .where(and(eq(attachments.userId, input.userId), inArray(attachments.folderId, folderIds))),
  ]);
  const externalReferences = new Map<string, string>();
  for (const reference of [...versionReferences, ...attachmentReferences]) {
    if (!batchNoteIds.has(reference.noteId)) externalReferences.set(reference.noteId, reference.currentFolderId);
  }
  const claimId = createId('purge');

  const claimed = await db.transaction(async (tx) => {
    const claimedFolders = await tx
      .update(folders)
      .set({ trashBatchId: claimId })
      .where(
        and(eq(folders.userId, input.userId), inArray(folders.id, folderIds), eq(folders.trashBatchId, input.folderId))
      )
      .returning({ id: folders.id });
    if (claimedFolders.length !== folderIds.length) throw new Error('Folder purge state changed');
    if (noteIds.length > 0) {
      const claimedNotes = await tx
        .update(notes)
        .set({ trashBatchId: claimId })
        .where(and(eq(notes.userId, input.userId), inArray(notes.id, noteIds), eq(notes.trashBatchId, input.folderId)))
        .returning({ id: notes.id });
      if (claimedNotes.length !== noteIds.length) throw new Error('Note purge state changed');
    }
    return true;
  });
  if (!claimed) return { ok: false, status: 404, error: 'Trashed folder not found' };

  const attachmentRows =
    noteIds.length > 0
      ? await db
          .select({ storageKey: attachments.storageKey })
          .from(attachments)
          .where(and(eq(attachments.userId, input.userId), inArray(attachments.noteId, noteIds)))
      : [];
  try {
    if (attachmentRows.length > 0) {
      const storage = getObjectStorage();
      for (const attachment of attachmentRows) await storage.deleteObject({ key: attachment.storageKey });
    }
  } catch (error) {
    await db.transaction(async (tx) => {
      await tx
        .update(folders)
        .set({ trashBatchId: input.folderId })
        .where(
          and(eq(folders.userId, input.userId), inArray(folders.id, folderIds), eq(folders.trashBatchId, claimId))
        );
      if (noteIds.length > 0)
        await tx
          .update(notes)
          .set({ trashBatchId: input.folderId })
          .where(and(eq(notes.userId, input.userId), inArray(notes.id, noteIds), eq(notes.trashBatchId, claimId)));
    });
    throw error;
  }

  const deleted = await db.transaction(async (tx) => {
    for (const [noteId, currentFolderId] of externalReferences) {
      await tx
        .update(noteVersions)
        .set({ folderId: currentFolderId })
        .where(
          and(
            eq(noteVersions.userId, input.userId),
            eq(noteVersions.noteId, noteId),
            inArray(noteVersions.folderId, folderIds)
          )
        );
      await tx
        .update(attachments)
        .set({ folderId: currentFolderId, updatedAt: new Date() })
        .where(
          and(
            eq(attachments.userId, input.userId),
            eq(attachments.noteId, noteId),
            inArray(attachments.folderId, folderIds)
          )
        );
    }
    const tagged =
      noteIds.length > 0
        ? await tx.select({ tagId: noteTags.tagId }).from(noteTags).where(inArray(noteTags.noteId, noteIds))
        : [];
    for (const detachedRoot of detachedRoots)
      await tx
        .update(folders)
        .set({
          parentFolderId: null,
          isPrivate: detachedRoot.isPrivate,
          isAgentReadOnly: detachedRoot.isAgentReadOnly,
        })
        .where(and(eq(folders.userId, input.userId), eq(folders.id, detachedRoot.id)));
    if (noteIds.length > 0)
      await tx
        .delete(notes)
        .where(and(eq(notes.userId, input.userId), inArray(notes.id, noteIds), eq(notes.trashBatchId, claimId)));
    const deletedFolders = await tx
      .delete(folders)
      .where(and(eq(folders.userId, input.userId), inArray(folders.id, folderIds), eq(folders.trashBatchId, claimId)))
      .returning({ id: folders.id });
    if (deletedFolders.length !== folderIds.length) throw new Error('Folder purge state changed');

    for (const { tagId } of tagged) {
      await tx
        .delete(tags)
        .where(
          and(
            eq(tags.id, tagId),
            eq(tags.userId, input.userId),
            sql`not exists (select 1 from ${noteTags} where ${noteTags.tagId} = ${tagId})`
          )
        );
    }
    return true;
  });

  return deleted
    ? {
        ok: true,
        value: {
          deletedFolderCount: folderIds.length,
          deletedNoteCount: noteIds.length,
          deletedAttachmentCount: attachmentRows.length,
        },
      }
    : { ok: false, status: 404, error: 'Trashed folder not found' };
}

class NoteTrashStateChangedError extends Error {}

export async function trashNotes(input: {
  userId: string;
  noteIds: string[];
  actorType?: 'user' | 'agent';
  actorId?: string | null;
  emptyDraft?: { noteId: string; creatorUserId: string; createdAt: Date; updatedAt: Date };
}): Promise<TrashOperationResult<{ deletedAt: Date; noteCount: number }>> {
  const noteIds = [...new Set(input.noteIds)];
  if (noteIds.length === 0) return { ok: false, status: 404, error: 'No notes were found' };

  const current = await db
    .select({ id: notes.id, userId: notes.userId, content: notes.content })
    .from(notes)
    .where(activeNoteWhere(input.userId, inArray(notes.id, noteIds)));
  if (current.length !== noteIds.length) return { ok: false, status: 404, error: 'One or more notes were not found' };

  const now = new Date();
  try {
    await db.transaction(async (tx) => {
      const changed = await tx
        .update(notes)
        .set({
          deletedAt: now,
          trashBatchId: null,
          updatedByActorType: input.actorType ?? 'user',
          updatedByActorId: input.actorId ?? null,
        })
        .where(
          activeNoteWhere(
            input.userId,
            inArray(notes.id, noteIds),
            ...(input.emptyDraft
              ? [
                  eq(notes.id, input.emptyDraft.noteId),
                  eq(notes.createdByUserId, input.emptyDraft.creatorUserId),
                  eq(notes.updatedByActorType, 'user'),
                  eq(notes.updatedByActorId, input.emptyDraft.creatorUserId),
                  eq(notes.createdAt, input.emptyDraft.createdAt),
                  eq(notes.updatedAt, input.emptyDraft.updatedAt),
                  eq(notes.type, 'note'),
                  eq(notes.documentType, 'markdown'),
                  eq(notes.title, 'Untitled note'),
                  eq(notes.content, ''),
                  notExists(
                    db
                      .select({ id: noteCommentThreads.id })
                      .from(noteCommentThreads)
                      .where(eq(noteCommentThreads.noteId, notes.id))
                  ),
                  notExists(db.select({ id: noteTags.id }).from(noteTags).where(eq(noteTags.noteId, notes.id))),
                  notExists(
                    db.select({ id: attachments.id }).from(attachments).where(eq(attachments.noteId, notes.id))
                  ),
                  notExists(
                    db
                      .select({ id: noteEvents.id })
                      .from(noteEvents)
                      .where(and(eq(noteEvents.noteId, notes.id), ne(noteEvents.eventType, 'create')))
                  ),
                ]
              : [])
          )
        )
        .returning({ id: notes.id });
      if (changed.length !== noteIds.length) throw new NoteTrashStateChangedError();

      await tx
        .update(noteShareLinks)
        .set({ revokedAt: now, updatedAt: now })
        .where(
          and(
            eq(noteShareLinks.userId, input.userId),
            inArray(noteShareLinks.noteId, noteIds),
            isNull(noteShareLinks.revokedAt)
          )
        );
      await tx.insert(noteEvents).values(
        current.map((note) =>
          noteTrashEvent(note, {
            eventType: 'trash',
            summary: 'Moved note to Trash',
            createdAt: now,
            actorType: input.actorType,
            actorId: input.actorId,
          })
        )
      );
    });
  } catch (error) {
    if (error instanceof NoteTrashStateChangedError)
      return { ok: false, status: 409, error: 'Note trash state changed; refresh and try again' };
    throw error;
  }

  return { ok: true, value: { deletedAt: now, noteCount: noteIds.length } };
}

export async function trashNote(input: {
  userId: string;
  noteId: string;
  actorType?: 'user' | 'agent';
  actorId?: string | null;
  emptyDraft?: { creatorUserId: string; createdAt: Date; updatedAt: Date };
}): Promise<TrashOperationResult<{ deletedAt: Date }>> {
  const result = await trashNotes({
    userId: input.userId,
    noteIds: [input.noteId],
    actorType: input.actorType,
    actorId: input.actorId,
    emptyDraft: input.emptyDraft ? { ...input.emptyDraft, noteId: input.noteId } : undefined,
  });
  if (!result.ok) return result.status === 404 ? { ok: false, status: 404, error: 'Note not found' } : result;
  return { ok: true, value: { deletedAt: result.value.deletedAt } };
}

export async function restoreTrashedNote(input: {
  userId: string;
  noteId: string;
  folderId?: string;
}): Promise<TrashOperationResult<{ note: typeof notes.$inferSelect; restoredToOriginalFolder: boolean }>> {
  const [current] = await db
    .select()
    .from(notes)
    .where(
      and(
        eq(notes.id, input.noteId),
        eq(notes.userId, input.userId),
        isNotNull(notes.deletedAt),
        isNull(notes.trashBatchId)
      )
    )
    .limit(1);
  if (!current) return { ok: false, status: 404, error: 'Trashed note not found' };

  const destinationId = input.folderId ?? current.folderId;
  const [destination] = await db
    .select({ id: folders.id })
    .from(folders)
    .where(activeFolderWhere(input.userId, eq(folders.id, destinationId)))
    .limit(1);
  if (!destination) {
    if (input.folderId) return { ok: false, status: 404, error: 'Destination folder not found' };
    return {
      ok: false,
      status: 409,
      error: 'The original folder is unavailable; choose another folder',
      requiresDestination: true,
    };
  }

  const now = new Date();
  const contentHash = hashMarkdown(current.content);
  const note = await db.transaction(async (tx) => {
    const [restored] = await tx
      .update(notes)
      .set({
        folderId: destination.id,
        deletedAt: null,
        trashBatchId: null,
        updatedByActorType: 'user',
        updatedByActorId: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(notes.id, input.noteId),
          eq(notes.userId, input.userId),
          isNotNull(notes.deletedAt),
          isNull(notes.trashBatchId)
        )
      )
      .returning();
    if (!restored) return null;

    await tx.insert(noteEvents).values({
      id: createId('note_event'),
      noteId: restored.id,
      userId: input.userId,
      actorType: 'user',
      actorId: null,
      eventType: 'restore_from_trash',
      summary: 'Restored note from Trash',
      beforeHash: contentHash,
      afterHash: contentHash,
      createdAt: now,
    });
    return restored;
  });
  if (!note) return { ok: false, status: 404, error: 'Trashed note not found' };

  return {
    ok: true,
    value: { note, restoredToOriginalFolder: destination.id === current.folderId },
  };
}

export async function permanentlyDeleteTrashedNote(input: {
  userId: string;
  noteId: string;
}): Promise<TrashOperationResult<{ deletedAttachmentCount: number }>> {
  const claimId = createId('purge');
  const [claimed] = await db
    .update(notes)
    .set({ trashBatchId: claimId })
    .where(
      and(
        eq(notes.id, input.noteId),
        eq(notes.userId, input.userId),
        isNotNull(notes.deletedAt),
        isNull(notes.trashBatchId)
      )
    )
    .returning({ id: notes.id });
  if (!claimed) return { ok: false, status: 404, error: 'Trashed note not found' };

  const attachmentRows = await db
    .select({ storageKey: attachments.storageKey })
    .from(attachments)
    .where(and(eq(attachments.noteId, input.noteId), eq(attachments.userId, input.userId)));
  try {
    if (attachmentRows.length > 0) {
      const storage = getObjectStorage();
      for (const attachment of attachmentRows) await storage.deleteObject({ key: attachment.storageKey });
    }
  } catch (error) {
    await db
      .update(notes)
      .set({ trashBatchId: null })
      .where(and(eq(notes.id, input.noteId), eq(notes.userId, input.userId), eq(notes.trashBatchId, claimId)));
    throw error;
  }

  const deleted = await db.transaction(async (tx) => {
    const tagged = await tx
      .select({ tagId: noteTags.tagId })
      .from(noteTags)
      .where(and(eq(noteTags.noteId, input.noteId), eq(noteTags.userId, input.userId)));
    const [note] = await tx
      .delete(notes)
      .where(
        and(
          eq(notes.id, input.noteId),
          eq(notes.userId, input.userId),
          isNotNull(notes.deletedAt),
          eq(notes.trashBatchId, claimId)
        )
      )
      .returning({ id: notes.id });
    if (!note) return false;

    for (const { tagId } of tagged) {
      await tx
        .delete(tags)
        .where(
          and(
            eq(tags.id, tagId),
            eq(tags.userId, input.userId),
            sql`not exists (select 1 from ${noteTags} where ${noteTags.tagId} = ${tagId})`
          )
        );
    }
    return true;
  });

  return deleted
    ? { ok: true, value: { deletedAttachmentCount: attachmentRows.length } }
    : { ok: false, status: 404, error: 'Trashed note not found' };
}
