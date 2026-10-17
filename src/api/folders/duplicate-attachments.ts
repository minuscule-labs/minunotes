import { createHash } from 'node:crypto';
import { FOLDER_COPY_LIMITS, FolderDuplicationError } from '../../shared/folder-duplication';
import type { attachments } from '../db/schema';
import { createId } from '../lib/id';
import type { ObjectStorage } from '../storage/object-storage';
export type AttachmentSource = typeof attachments.$inferSelect;
export type AttachmentPlan = {
  source: AttachmentSource;
  noteId: string;
  folderId: string;
  id: string;
  storageKey: string;
};
export function planAttachments(
  sources: AttachmentSource[],
  notes: Array<{ id: string; folderId: string }>,
  references: Map<string, string[]>,
  noteIds: Map<string, string>,
  folderIds: Map<string, string>,
  rootId: string
): AttachmentPlan[] {
  const rows = new Map(sources.map((row) => [row.id, row]));
  const plans: AttachmentPlan[] = [];
  for (const note of notes)
    for (const id of references.get(note.id) ?? []) {
      const source = rows.get(id);
      if (source?.status !== 'ready' || source.deletedAt)
        throw new FolderDuplicationError('A referenced image is unavailable; repair the source before duplicating');
      if (source.size <= 0 || source.size > 10 * 1024 * 1024)
        throw new FolderDuplicationError('A source image exceeds the supported size', 413);
      const attachmentId = createId('att'),
        noteId = noteIds.get(note.id),
        folderId = folderIds.get(note.folderId) ?? rootId;
      if (!noteId) throw new FolderDuplicationError('Missing copied image note');
      plans.push({
        source,
        noteId,
        folderId,
        id: attachmentId,
        storageKey: `users/${source.userId}/notes/${noteId}/attachments/${attachmentId}`,
      });
    }
  if (
    plans.length > FOLDER_COPY_LIMITS.attachments ||
    plans.reduce((total, p) => total + p.source.size, 0) > FOLDER_COPY_LIMITS.attachmentBytes
  )
    throw new FolderDuplicationError('This folder exceeds the image-copy limit', 413);
  return plans;
}
export async function stageAttachments(storage: ObjectStorage, plans: AttachmentPlan[], staged: string[]) {
  for (const plan of plans) {
    if (storage.getObjectMetadata) {
      const metadata = await storage.getObjectMetadata({ key: plan.source.storageKey });
      if (!metadata || metadata.size !== plan.source.size)
        throw new FolderDuplicationError(
          'A referenced image is missing or changed; repair the source before duplicating'
        );
    }
    const object = await storage.getObject({ key: plan.source.storageKey });
    if (
      !object ||
      object.body.byteLength !== plan.source.size ||
      createHash('sha256').update(object.body).digest('hex') !== plan.source.contentHash
    )
      throw new FolderDuplicationError(
        'A referenced image is missing or changed; repair the source before duplicating'
      );
    // Track before writing: a provider can store bytes but lose the write acknowledgement.
    staged.push(plan.storageKey);
    await storage.putObject({ key: plan.storageKey, body: object.body, contentType: plan.source.mimeType });
  }
}
export async function discardStaged(storage: ObjectStorage, keys: string[]) {
  // Best effort, only after database reconciliation proves these per-attempt objects are uncommitted.
  for (const key of keys)
    try {
      await storage.deleteObject({ key });
    } catch {
      /* Retain an orphan rather than interfere with any source or committed object. */
    }
}
