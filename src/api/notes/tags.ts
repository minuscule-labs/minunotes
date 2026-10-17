import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { normalizeTagInput, normalizeTagName } from '../../shared/tags';
import { db as defaultDb } from '../db/client';
import type { MetadataExecutor } from './metadata-transaction';

const db = defaultDb;

import { notes, noteTags, tags } from '../db/schema';
import {
  collaborationAccessibleNoteWhere,
  integrationAccessibleNoteWhere,
  type SharedAccessMode,
} from '../lib/collaboration-access';
import { createId } from '../lib/id';
import { activeNoteWhere } from '../trash/policy';

export type SerializedTag = { id: string; name: string; normalizedName: string; noteCount?: number };

export { cleanTagName, normalizeTagInput, normalizeTagName } from '../../shared/tags';

export async function listUserTags(input: { userId: string; noteIds?: string[]; folderIds?: string[] }) {
  if (input.noteIds?.length === 0 || input.folderIds?.length === 0) return [];
  const rows = await db
    .select({
      id: tags.id,
      name: tags.name,
      normalizedName: tags.normalizedName,
      noteCount: sql<number>`count(${noteTags.id})`,
    })
    .from(tags)
    .innerJoin(noteTags, eq(noteTags.tagId, tags.id))
    .innerJoin(notes, eq(noteTags.noteId, notes.id))
    .where(
      and(
        eq(tags.userId, input.userId),
        input.noteIds ? inArray(noteTags.noteId, input.noteIds) : undefined,
        input.folderIds ? inArray(notes.folderId, input.folderIds) : undefined,
        activeNoteWhere(input.userId)
      )
    )
    .groupBy(tags.id)
    .orderBy(asc(tags.name), asc(tags.id));
  return rows satisfies SerializedTag[];
}

export async function listIntegrationAccessibleTags(input: {
  actorUserId: string;
  authorizationId: string;
  sharedAccessMode: SharedAccessMode;
  ownedFolderIds: ReadonlySet<string>;
}) {
  return db
    .select({
      id: tags.id,
      name: tags.name,
      normalizedName: tags.normalizedName,
      noteCount: sql<number>`count(${noteTags.id})`,
    })
    .from(tags)
    .innerJoin(noteTags, and(eq(noteTags.tagId, tags.id), eq(noteTags.userId, tags.userId)))
    .innerJoin(notes, and(eq(noteTags.noteId, notes.id), eq(noteTags.userId, notes.userId)))
    .where(
      integrationAccessibleNoteWhere(
        {
          actorUserId: input.actorUserId,
          authorizationId: input.authorizationId,
          sharedAccessMode: input.sharedAccessMode,
          ownedFolderIds: input.ownedFolderIds,
        },
        eq(notes.type, 'note')
      )
    )
    .groupBy(tags.id)
    .orderBy(asc(tags.name), asc(tags.id));
}

export async function listAccessibleTags(actorUserId: string) {
  return db
    .select({
      id: tags.id,
      name: tags.name,
      normalizedName: tags.normalizedName,
      noteCount: sql<number>`count(${noteTags.id})`,
    })
    .from(tags)
    .innerJoin(noteTags, and(eq(noteTags.tagId, tags.id), eq(noteTags.userId, tags.userId)))
    .innerJoin(notes, and(eq(noteTags.noteId, notes.id), eq(noteTags.userId, notes.userId)))
    .where(collaborationAccessibleNoteWhere(actorUserId, 'read', eq(notes.type, 'note')))
    .groupBy(tags.id)
    .orderBy(asc(tags.name), asc(tags.id));
}

export async function listNoteTags(input: { userId: string; noteId: string }, executor: MetadataExecutor = defaultDb) {
  const db = executor;
  return db
    .select({ id: tags.id, name: tags.name, normalizedName: tags.normalizedName })
    .from(noteTags)
    .innerJoin(tags, eq(noteTags.tagId, tags.id))
    .innerJoin(notes, eq(noteTags.noteId, notes.id))
    .where(and(eq(noteTags.userId, input.userId), eq(noteTags.noteId, input.noteId), activeNoteWhere(input.userId)))
    .orderBy(asc(tags.name));
}

async function ensureTags(
  input: { userId: string; tags: Array<{ name: string; normalizedName: string }> },
  executor: MetadataExecutor = defaultDb
) {
  const db = executor;
  if (input.tags.length === 0) return [];

  const normalizedNames = input.tags.map((tag) => tag.normalizedName);
  const existing = await db
    .select()
    .from(tags)
    .where(and(eq(tags.userId, input.userId), inArray(tags.normalizedName, normalizedNames)));
  const existingNames = new Set(existing.map((tag) => tag.normalizedName));
  const now = new Date();
  const missing = input.tags.filter((tag) => !existingNames.has(tag.normalizedName));

  if (missing.length > 0) {
    await db.insert(tags).values(
      missing.map((tag) => ({
        id: createId('tag'),
        userId: input.userId,
        name: tag.name,
        normalizedName: tag.normalizedName,
        createdAt: now,
        updatedAt: now,
      }))
    );
  }

  return db
    .select()
    .from(tags)
    .where(and(eq(tags.userId, input.userId), inArray(tags.normalizedName, normalizedNames)));
}

export async function setNoteTags(
  input: { userId: string; noteId: string; tags: string[] },
  executor: MetadataExecutor = defaultDb
) {
  const db = executor;
  const cleaned = normalizeTagInput(input.tags);
  const tagRows = await ensureTags({ userId: input.userId, tags: cleaned }, executor);

  const previous = await listNoteTags(input, executor);
  await db.delete(noteTags).where(and(eq(noteTags.userId, input.userId), eq(noteTags.noteId, input.noteId)));

  if (tagRows.length > 0) {
    const now = new Date();
    await db.insert(noteTags).values(
      tagRows.map((tag) => ({
        id: createId('note_tag'),
        userId: input.userId,
        noteId: input.noteId,
        tagId: tag.id,
        createdAt: now,
      }))
    );
  }

  const current = await listNoteTags(input, executor);
  const currentIds = new Set(current.map((tag) => tag.id));
  const removedIds = previous.map((tag) => tag.id).filter((id) => !currentIds.has(id));
  if (removedIds.length > 0) {
    await db
      .delete(tags)
      .where(
        and(
          eq(tags.userId, input.userId),
          inArray(tags.id, removedIds),
          sql`not exists (select 1 from ${noteTags} where ${noteTags.tagId} = ${tags.id})`
        )
      );
  }
  return current;
}

export async function noteIdsForTag(input: { userId: string; tag: string }) {
  const normalizedName = normalizeTagName(input.tag);
  if (!normalizedName) return [];
  return db
    .select({ noteId: noteTags.noteId })
    .from(noteTags)
    .innerJoin(tags, eq(noteTags.tagId, tags.id))
    .innerJoin(notes, eq(noteTags.noteId, notes.id))
    .where(
      and(eq(noteTags.userId, input.userId), eq(tags.normalizedName, normalizedName), activeNoteWhere(input.userId))
    );
}
