import { and, asc, eq, exists, inArray, isNull, sql } from 'drizzle-orm';
import {
  mutatePropertyDefinitions,
  type NoteProperties,
  type OptionDeletionPreview,
  PropertyError,
  type PropertySchema,
  type PropertyValues,
  parseOptionDeletion,
  parsePropertyPatch,
  patchPropertyValues,
  propertyRevision,
  removePropertyOption,
} from '../../shared/properties';
import {
  folderPropertySchemas,
  folders,
  noteEvents,
  notePropertyState,
  notes,
  templateFolderAssignments,
} from '../db/schema';
import { hashMarkdown } from '../harness/hash';
import { createId } from '../lib/id';
import { guardEnabledBoard } from './boards';
import { authorizeMetadata, type MetadataActor, metadataSchema as schemaState } from './metadata-access';
import { metadataTransaction as propertyTransaction, type MetadataTx as Tx } from './metadata-transaction';
import { guardTemplateDefaults } from './templates';

export type PropertyActor = MetadataActor;
function authorize(
  tx: Tx,
  actor: PropertyActor,
  folderId: string,
  ownerId: string,
  noteId: string | null,
  edit: boolean
) {
  return authorizeMetadata(tx, actor, folderId, ownerId, noteId, edit ? 'edit' : 'read');
}
function project(schema: PropertySchema, revision: number, values: PropertyValues): NoteProperties {
  const definitions = schema.definitions
    .filter((d) => !d.archived)
    .map((d) => ({ ...d, options: d.options.filter((o) => !o.archived || values[d.id] === o.id) }));
  return {
    schema: { ...schema, definitions },
    revision,
    values: Object.fromEntries(definitions.filter((d) => Object.hasOwn(values, d.id)).map((d) => [d.id, values[d.id]])),
  };
}
async function currentNote(tx: Tx, actor: PropertyActor, noteId: string, edit: boolean) {
  const [note] = await tx
    .select()
    .from(notes)
    .where(and(eq(notes.id, noteId), isNull(notes.deletedAt)));
  if (!note) throw new PropertyError('Note not found', 404);
  await authorize(tx, actor, note.folderId, note.userId, note.id, edit);
  if (note.type !== 'note') throw new PropertyError('Template defaults are not supported');
  if (edit && actor.actorType === 'agent' && !note.isApiEditable)
    throw new PropertyError(
      note.userId === actor.actorUserId ? 'Document is not editable through the API' : 'Resource not found',
      note.userId === actor.actorUserId ? 403 : 404
    );
  return note;
}
export async function readFolderProperties(actor: PropertyActor, folderId: string) {
  return propertyTransaction(async (tx) => {
    const [folder] = await tx.select().from(folders).where(eq(folders.id, folderId));
    if (!folder) throw new PropertyError('Folder not found', 404);
    await authorize(tx, actor, folderId, folder.userId, null, false);
    return schemaState(tx, folder.userId, folderId);
  });
}
export async function mutateFolderProperties(actor: PropertyActor, folderId: string, input: unknown) {
  const body = input as { expectedRevision?: unknown; mutation?: unknown } | null;
  return propertyTransaction(async (tx) => {
    const [folder] = await tx.select().from(folders).where(eq(folders.id, folderId));
    if (!folder) throw new PropertyError('Folder not found', 404);
    await authorize(tx, actor, folderId, folder.userId, null, true);
    if (folder.userId !== actor.actorUserId) throw new PropertyError('Only the folder owner can edit definitions', 403);
    const expected = propertyRevision(body?.expectedRevision);
    if (!body || Object.keys(body).some((k) => !['expectedRevision', 'mutation'].includes(k)))
      throw new PropertyError('Unknown mutation attributes');
    const current = await schemaState(tx, folder.userId, folderId);
    if (current.revision !== expected) throw new PropertyError('Schema changed; reload before retrying', 409);
    const definitions = mutatePropertyDefinitions(current.definitions, body?.mutation, createId);
    await guardTemplateDefaults(tx, folder.userId, folderId, definitions);
    await guardEnabledBoard(tx, folder.userId, folderId, definitions);
    if (JSON.stringify(definitions) === JSON.stringify(current.definitions)) return current;
    const now = new Date();
    const result = {
      ...current,
      schemaId: current.schemaId ?? createId('property_schema'),
      revision: expected + 1,
      definitions,
    };
    if (!expected)
      await tx.insert(folderPropertySchemas).values({
        folderId,
        userId: folder.userId,
        schemaId: result.schemaId,
        revision: result.revision,
        definitions: JSON.stringify(definitions),
        createdAt: now,
        updatedAt: now,
      });
    else
      await tx
        .update(folderPropertySchemas)
        .set({ revision: result.revision, definitions: JSON.stringify(definitions), updatedAt: now })
        .where(
          and(
            eq(folderPropertySchemas.folderId, folderId),
            eq(folderPropertySchemas.userId, folder.userId),
            eq(folderPropertySchemas.revision, expected)
          )
        );
    return result;
  });
}
// Use json_each keys rather than interpolating a client-supplied JSON path.
function optionReference(
  values: typeof notePropertyState.values | typeof templateFolderAssignments.propertyDefaults,
  propertyId: string,
  optionId: string
) {
  return sql`exists (select 1 from json_each(${values}) where key = ${propertyId} and type = 'text' and value = ${optionId})`;
}
async function optionDeletionContext(
  tx: Tx,
  actor: PropertyActor,
  folderId: string,
  propertyId: string,
  optionId: string
) {
  const [folder] = await tx.select().from(folders).where(eq(folders.id, folderId));
  if (!folder) throw new PropertyError('Folder not found', 404);
  await authorize(tx, actor, folderId, folder.userId, null, true);
  if (folder.userId !== actor.actorUserId || actor.actorType === 'agent')
    throw new PropertyError('Only the folder owner can delete options', 403);
  const current = await schemaState(tx, folder.userId, folderId);
  const definitions = removePropertyOption(current.definitions, propertyId, optionId);
  const field = current.definitions.find((d) => d.id === propertyId);
  const option = field?.options.find((o) => o.id === optionId);
  if (!field || !option || !current.schemaId) throw new PropertyError('Option not found', 404);
  const noteMatches = and(
    eq(notePropertyState.userId, folder.userId),
    optionReference(notePropertyState.values, propertyId, optionId)
  );
  // Include moved and trashed notes: retained values must not resurrect a deleted option.
  const affectedNotes = await tx
    .select({ id: notes.id, revision: notePropertyState.revision })
    .from(notePropertyState)
    .innerJoin(notes, and(eq(notes.id, notePropertyState.noteId), eq(notes.userId, notePropertyState.userId)))
    .where(noteMatches)
    .orderBy(asc(notes.id));
  const affectedDefaults = await tx
    .select({ id: templateFolderAssignments.id, revision: templateFolderAssignments.defaultsRevision })
    .from(templateFolderAssignments)
    .where(
      and(
        eq(templateFolderAssignments.userId, folder.userId),
        eq(templateFolderAssignments.folderId, folderId),
        optionReference(templateFolderAssignments.propertyDefaults, propertyId, optionId)
      )
    )
    .orderBy(asc(templateFolderAssignments.id));
  const preview: OptionDeletionPreview = {
    schemaId: current.schemaId,
    expectedRevision: current.revision,
    propertyId,
    optionId,
    propertyLabel: field.label,
    optionLabel: option.label,
    noteCount: affectedNotes.length,
    templateDefaultCount: affectedDefaults.length,
    impactToken: hashMarkdown(
      JSON.stringify([
        folder.userId,
        folderId,
        current.schemaId,
        current.revision,
        propertyId,
        optionId,
        affectedNotes,
        affectedDefaults,
      ])
    ),
  };
  return { current, definitions, preview, noteMatches, affectedNotes, affectedDefaults };
}
export async function previewOptionDeletion(
  actor: PropertyActor,
  folderId: string,
  propertyId: string,
  optionId: string
) {
  return propertyTransaction(
    async (tx) => (await optionDeletionContext(tx, actor, folderId, propertyId, optionId)).preview
  );
}
export async function deletePropertyOption(
  actor: PropertyActor,
  folderId: string,
  propertyId: string,
  optionId: string,
  input: unknown
) {
  const reviewed = parseOptionDeletion(input);
  return propertyTransaction(async (tx) => {
    const { current, definitions, preview, noteMatches, affectedNotes, affectedDefaults } = await optionDeletionContext(
      tx,
      actor,
      folderId,
      propertyId,
      optionId
    );
    if (
      reviewed.schemaId !== current.schemaId ||
      reviewed.expectedRevision !== current.revision ||
      reviewed.impactToken !== preview.impactToken
    )
      throw new PropertyError('Deletion impact changed; review again before confirming', 409);
    const now = new Date();
    const path = `$.${JSON.stringify(propertyId)}`;
    const changedStates = await tx
      .update(notePropertyState)
      .set({
        values: sql`json_remove(${notePropertyState.values}, ${path})`,
        revision: sql`${notePropertyState.revision} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          noteMatches,
          exists(
            tx
              .select({ id: notes.id })
              .from(notes)
              .where(and(eq(notes.id, notePropertyState.noteId), eq(notes.userId, actor.actorUserId)))
          )
        )
      )
      .returning({ id: notePropertyState.noteId });
    if (changedStates.length !== preview.noteCount)
      throw new PropertyError('Deletion impact changed; review again before confirming', 409);
    for (const row of affectedDefaults) {
      const changed = await tx
        .update(templateFolderAssignments)
        .set({
          propertyDefaults: sql`json_remove(${templateFolderAssignments.propertyDefaults}, ${path})`,
          defaultsRevision: row.revision + 1,
        })
        .where(
          and(
            eq(templateFolderAssignments.id, row.id),
            eq(templateFolderAssignments.userId, actor.actorUserId),
            eq(templateFolderAssignments.folderId, folderId),
            eq(templateFolderAssignments.defaultsRevision, row.revision)
          )
        )
        .returning({ id: templateFolderAssignments.id });
      if (changed.length !== 1) throw new PropertyError('Template defaults changed; review deletion again', 409);
    }
    await guardTemplateDefaults(tx, actor.actorUserId, folderId, definitions);
    await guardEnabledBoard(tx, actor.actorUserId, folderId, definitions);
    const result = { ...current, revision: current.revision + 1, definitions };
    const changedSchema = await tx
      .update(folderPropertySchemas)
      .set({
        revision: result.revision,
        definitions: JSON.stringify(definitions),
        updatedAt: now,
      })
      .where(
        and(
          eq(folderPropertySchemas.folderId, folderId),
          eq(folderPropertySchemas.userId, actor.actorUserId),
          eq(folderPropertySchemas.schemaId, reviewed.schemaId),
          eq(folderPropertySchemas.revision, reviewed.expectedRevision)
        )
      )
      .returning({ id: folderPropertySchemas.folderId });
    if (changedSchema.length !== 1) throw new PropertyError('Schema changed; review deletion again', 409);
    // Hash bodies only at confirmation, in bounded batches rather than loading every body at once.
    for (let offset = 0; offset < affectedNotes.length; offset += 50) {
      const ids = affectedNotes.slice(offset, offset + 50).map((note) => note.id);
      const changedNotes = await tx
        .update(notes)
        .set({
          updatedAt: now,
          updatedByActorType: actor.actorType ?? 'user',
          updatedByActorId: actor.actorId ?? actor.actorUserId,
        })
        .where(and(eq(notes.userId, actor.actorUserId), inArray(notes.id, ids)))
        .returning({ id: notes.id, content: notes.content });
      if (changedNotes.length !== ids.length)
        throw new PropertyError('Deletion impact changed; review again before confirming', 409);
      for (const note of changedNotes) {
        const hash = hashMarkdown(note.content);
        await tx.insert(noteEvents).values({
          id: createId('note_event'),
          noteId: note.id,
          userId: actor.actorUserId,
          actorType: actor.actorType ?? 'user',
          actorId: actor.actorId ?? actor.actorUserId,
          eventType: 'properties_update',
          summary: 'Cleared property value after option deletion',
          beforeHash: hash,
          afterHash: hash,
          createdAt: now,
        });
      }
    }
    return result;
  });
}
export async function readNoteProperties(actor: PropertyActor, noteId: string) {
  return propertyTransaction(async (tx) => {
    const note = await currentNote(tx, actor, noteId, false);
    const schema = await schemaState(tx, note.userId, note.folderId);
    const [state] = await tx
      .select()
      .from(notePropertyState)
      .where(and(eq(notePropertyState.noteId, noteId), eq(notePropertyState.userId, note.userId)));
    return project(schema, state?.revision ?? 0, state ? JSON.parse(state.values) : {});
  });
}
export async function patchNoteProperties(actor: PropertyActor, noteId: string, input: unknown) {
  return propertyTransaction(async (tx) => {
    const note = await currentNote(tx, actor, noteId, true);
    const body = parsePropertyPatch(input);
    const schema = await schemaState(tx, note.userId, note.folderId);
    if (body.schemaId !== schema.schemaId || body.schemaRevision !== schema.revision)
      throw new PropertyError('Schema changed; reload before retrying', 409);
    const [state] = await tx
      .select()
      .from(notePropertyState)
      .where(and(eq(notePropertyState.noteId, noteId), eq(notePropertyState.userId, note.userId)));
    const revision = state?.revision ?? 0;
    if (body.expectedRevision !== revision) throw new PropertyError('Properties changed; reload before retrying', 409);
    const previous: PropertyValues = state ? JSON.parse(state.values) : {};
    const values = patchPropertyValues(previous, schema.definitions, body.values);
    if (JSON.stringify(values) === JSON.stringify(previous)) return project(schema, revision, previous);
    const now = new Date();
    if (!state)
      await tx.insert(notePropertyState).values({
        noteId,
        userId: note.userId,
        revision: 1,
        values: JSON.stringify(values),
        createdAt: now,
        updatedAt: now,
      });
    else
      await tx
        .update(notePropertyState)
        .set({ revision: revision + 1, values: JSON.stringify(values), updatedAt: now })
        .where(
          and(
            eq(notePropertyState.noteId, noteId),
            eq(notePropertyState.userId, note.userId),
            eq(notePropertyState.revision, revision)
          )
        );
    await tx
      .update(notes)
      .set({
        updatedAt: now,
        updatedByActorType: actor.actorType ?? 'user',
        updatedByActorId: actor.actorId ?? actor.actorUserId,
      })
      .where(and(eq(notes.id, noteId), eq(notes.userId, note.userId), isNull(notes.deletedAt)));
    const hash = hashMarkdown(note.content);
    await tx.insert(noteEvents).values({
      id: createId('note_event'),
      noteId,
      userId: note.userId,
      actorType: actor.actorType ?? 'user',
      actorId: actor.actorId ?? actor.actorUserId,
      eventType: 'properties_update',
      summary: 'Updated note properties',
      beforeHash: hash,
      afterHash: hash,
      createdAt: now,
    });
    return project(schema, revision + 1, values);
  });
}
