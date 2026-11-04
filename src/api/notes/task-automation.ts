import { and, asc, eq, gt, isNull, or } from 'drizzle-orm';
import { PropertyError } from '../../shared/properties';
import { notes } from '../db/schema';
import { getNoteEventSummary, insertNoteEvent } from '../harness/commands';
import { hashMarkdown } from '../harness/hash';
import { encodeCursor } from '../harness/pagination';
import { activeNoteWhere } from '../trash/policy';
import { resolveUnresolvedNoteLinks } from './links';
import { compactNoteSelection } from './listing';
import { authorizeMetadata, type MetadataActor } from './metadata-access';
import { metadataTransaction } from './metadata-transaction';
import { createNoteVersion } from './versions';

export async function listFolderNotes(input: {
  actor: MetadataActor;
  ownerId: string;
  folderId: string;
  limit: number;
  cursor: { title: string; id: string } | null;
  cursorScope: string;
  noteType?: 'note' | 'template';
}) {
  return metadataTransaction(async (tx) => {
    if (input.noteType === 'template' && input.ownerId !== input.actor.actorUserId)
      throw new PropertyError('Folder not found', 404);
    await authorizeMetadata(tx, input.actor, input.folderId, input.ownerId, null, 'read');
    const rows = await tx
      .select(compactNoteSelection)
      .from(notes)
      .where(
        activeNoteWhere(
          input.ownerId,
          eq(notes.folderId, input.folderId),
          eq(notes.type, input.noteType ?? 'note'),
          input.cursor
            ? or(
                gt(notes.title, input.cursor.title),
                and(eq(notes.title, input.cursor.title), gt(notes.id, input.cursor.id))
              )
            : undefined
        )
      )
      .orderBy(asc(notes.title), asc(notes.id))
      .limit(input.limit + 1);
    const visible = rows.slice(0, input.limit);
    const hasMore = rows.length > input.limit;
    const last = visible[visible.length - 1];
    return {
      notes: visible,
      pageInfo: {
        hasMore,
        nextCursor: hasMore && last ? encodeCursor(input.cursorScope, { title: last.title, id: last.id }) : null,
      },
    };
  });
}

export async function renameMarkdownNote(actor: MetadataActor, noteId: string, input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PropertyError('Invalid rename request');
  const body = input as Record<string, unknown>;
  if (
    Object.keys(body).some((key) => !['title', 'expectedTitle'].includes(key)) ||
    typeof body.title !== 'string' ||
    !body.title.trim() ||
    body.title.trim().length > 1000 ||
    typeof body.expectedTitle !== 'string'
  )
    throw new PropertyError('title and exact expectedTitle are required; title must contain 1–1,000 characters');
  const title = body.title.trim();
  const expectedTitle = body.expectedTitle;
  return metadataTransaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(notes)
      .where(and(eq(notes.id, noteId), isNull(notes.deletedAt)));
    if (!current) throw new PropertyError('Note not found', 404);
    // Resolve current ACLs inside this transaction, including direct-note grants and revocation.
    await authorizeMetadata(tx, actor, current.folderId, current.userId, noteId, 'read');
    await authorizeMetadata(tx, actor, current.folderId, current.userId, noteId, 'edit');
    if (current.type !== 'note' || current.documentType !== 'markdown')
      throw new PropertyError('Only ordinary Markdown notes can be renamed', 400);
    if (actor.actorType === 'agent' && !current.isApiEditable)
      throw new PropertyError(
        current.userId === actor.actorUserId ? 'Document is not editable through the API' : 'Resource not found',
        current.userId === actor.actorUserId ? 403 : 404
      );
    if (current.title !== expectedTitle)
      throw new PropertyError('Title changed; review the current title before retrying', 409);
    const contentHash = hashMarkdown(current.content);
    if (title === current.title) return { note: current, contentHash };
    const [note] = await tx
      .update(notes)
      .set({
        title,
        updatedAt: new Date(),
        updatedByActorType: actor.actorType ?? 'user',
        updatedByActorId: actor.actorId ?? actor.actorUserId,
      })
      .where(
        and(
          eq(notes.id, noteId),
          eq(notes.userId, current.userId),
          eq(notes.folderId, current.folderId),
          eq(notes.title, expectedTitle),
          isNull(notes.deletedAt)
        )
      )
      .returning();
    if (!note) throw new PropertyError('Title changed; review the current title before retrying', 409);
    await createNoteVersion(
      {
        note: current,
        reason: actor.actorType === 'agent' ? 'before_agent_edit' : 'autosave_checkpoint',
        actorType: actor.actorType ?? 'user',
        actorId: actor.actorId,
      },
      tx
    );
    await resolveUnresolvedNoteLinks({ noteId, userId: note.userId, title }, tx);
    await insertNoteEvent(
      {
        noteId,
        userId: note.userId,
        actorType: actor.actorType ?? 'user',
        actorId: actor.actorId ?? actor.actorUserId,
        eventType: 'update',
        summary: getNoteEventSummary('update', { titleChanged: true }),
        beforeHash: contentHash,
        afterHash: contentHash,
      },
      tx
    );
    return { note, contentHash };
  });
}
