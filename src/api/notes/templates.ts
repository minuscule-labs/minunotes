import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { type PropertyDefinition, PropertyError, propertyRevision } from '../../shared/properties';
import {
  parseTemplateCreation,
  renderTemplate,
  type TemplateDefaults,
  type TemplatePreview,
  templateObject,
  templateSchemaId,
  templateString,
  templateTags,
  templateValues,
} from '../../shared/templates';
import { syncNoteAttachmentReferences } from '../attachments/references';
import {
  folders,
  noteCreationRequests,
  notePropertyState,
  notes,
  templateDefaultState,
  templateFolderAssignments,
} from '../db/schema';
import { ownedFolderPolicy } from '../folders/structure';
import { createDocument, getNoteEventSummary, insertNoteEvent } from '../harness/commands';
import { hashMarkdown } from '../harness/hash';
import { isFolderEffectivelyPrivate } from '../lib/folder-access';
import { createId } from '../lib/id';
import { activeFolderWhere, activeNoteWhere, filterActiveFolderHierarchy } from '../trash/policy';
import { reindexNoteLinks, resolveUnresolvedNoteLinks } from './links';
import { authorizeMetadata, type MetadataActor, metadataSchema } from './metadata-access';
import { type MetadataTx, metadataTransaction } from './metadata-transaction';
import { setNoteTags } from './tags';
import { createNoteVersion } from './versions';

const MAX_TEMPLATE_ASSIGNMENTS = 1000;

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
async function ownedTemplate(
  tx: MetadataTx,
  actor: MetadataActor,
  templateId: string,
  capability: 'read' | 'edit' = 'edit'
) {
  const [note] = await tx
    .select()
    .from(notes)
    .where(
      activeNoteWhere(
        actor.actorUserId,
        eq(notes.id, templateId),
        eq(notes.type, 'template'),
        eq(notes.documentType, 'markdown')
      )
    );
  if (!note) throw new PropertyError('Template not found', 404);
  await authorizeMetadata(tx, actor, note.folderId, actor.actorUserId, null, 'read');
  if (capability === 'edit') {
    await authorizeMetadata(tx, actor, note.folderId, actor.actorUserId, null, 'edit');
    if (actor.actorType === 'agent' && !note.isApiEditable)
      throw new PropertyError('Template is not editable through the API', 403);
  }
  return note;
}
async function assignments(tx: MetadataTx, ownerId: string, templateId: string) {
  return tx
    .select()
    .from(templateFolderAssignments)
    .where(and(eq(templateFolderAssignments.userId, ownerId), eq(templateFolderAssignments.templateId, templateId)))
    .orderBy(asc(templateFolderAssignments.folderId));
}
function membership(rows: Awaited<ReturnType<typeof assignments>>) {
  return digest(rows.map((r) => [r.id, r.folderId]));
}
async function tagState(tx: MetadataTx, templateId: string, ownerId: string) {
  const [state] = await tx
    .select()
    .from(templateDefaultState)
    .where(and(eq(templateDefaultState.templateId, templateId), eq(templateDefaultState.userId, ownerId)));
  return { revision: state?.revision ?? 0, tags: state ? (JSON.parse(state.tags) as string[]) : [] };
}
export async function readTemplateMembership(actor: MetadataActor, templateId: string) {
  return metadataTransaction(async (tx) => {
    await ownedTemplate(tx, actor, templateId, 'read');
    const rows = await assignments(tx, actor.actorUserId, templateId);
    const policy = await ownedFolderPolicy(tx, actor);
    return {
      folders: policy.tree.folders.filter((f) => policy.allowed(f.id, 'read') && rows.some((r) => r.folderId === f.id)),
      snapshot: membership(rows),
    };
  });
}
export async function saveTemplateMembership(actor: MetadataActor, templateId: string, input: unknown) {
  if (actor.actorType === 'agent') throw new PropertyError('Use per-destination assignment changes', 403);
  const body = templateObject(input, ['folderIds', 'snapshot']);
  if (
    !Array.isArray(body.folderIds) ||
    body.folderIds.length > MAX_TEMPLATE_ASSIGNMENTS ||
    new Set(body.folderIds).size !== body.folderIds.length
  )
    throw new PropertyError('Invalid folder IDs');
  const ids = body.folderIds.map((id) => templateString(id, 100));
  const expected = body.snapshot === undefined ? undefined : templateString(body.snapshot, 128);
  return metadataTransaction(async (tx) => {
    await ownedTemplate(tx, actor, templateId);
    const rows = await assignments(tx, actor.actorUserId, templateId);
    if (expected !== undefined && expected !== membership(rows))
      throw new PropertyError('Assignments changed; review before retrying', 409);
    const active = filterActiveFolderHierarchy(
      await tx
        .select()
        .from(folders)
        .where(and(eq(folders.userId, actor.actorUserId), isNull(folders.deletedAt)))
    );
    if (ids.some((id) => !active.some((f) => f.id === id))) throw new PropertyError('Folder not found', 404);
    // Hidden Trash destinations were not offered for selection, so omission is not an explicit removal.
    const removed = rows.filter((r) => active.some((f) => f.id === r.folderId) && !ids.includes(r.folderId));
    if (removed.length)
      await tx.delete(templateFolderAssignments).where(
        inArray(
          templateFolderAssignments.id,
          removed.map((r) => r.id)
        )
      );
    const added = ids.filter((id) => !rows.some((r) => r.folderId === id));
    if (added.length)
      await tx.insert(templateFolderAssignments).values(
        added.map((folderId) => ({
          id: createId('template_folder'),
          userId: actor.actorUserId,
          templateId,
          folderId,
        }))
      );
    const current = await assignments(tx, actor.actorUserId, templateId);
    return { ok: true, snapshot: membership(current) };
  });
}
async function templateDefaults(tx: MetadataTx, actor: MetadataActor, templateId: string): Promise<TemplateDefaults> {
  await ownedTemplate(tx, actor, templateId, 'read');
  const rows = await assignments(tx, actor.actorUserId, templateId);
  const policy = await ownedFolderPolicy(tx, actor);
  const visible = policy.tree.folders.filter((f) => policy.allowed(f.id, 'read'));
  return {
    ...(await tagState(tx, templateId, actor.actorUserId)),
    assignments: rows
      .filter((r) => visible.some((f) => f.id === r.folderId))
      .map((r) => ({
        id: r.id,
        folderId: r.folderId,
        title: visible.find((f) => f.id === r.folderId)?.title ?? '',
        revision: r.defaultsRevision,
        schemaId: r.schemaId,
        values: JSON.parse(r.propertyDefaults),
      })),
  };
}
export async function readTemplateDefaults(actor: MetadataActor, templateId: string): Promise<TemplateDefaults> {
  return metadataTransaction((tx) => templateDefaults(tx, actor, templateId));
}
export async function readTemplateSettings(actor: MetadataActor, templateId: string) {
  return metadataTransaction(async (tx) => ({
    ...(await templateDefaults(tx, actor, templateId)),
    membershipSnapshot: membership(await assignments(tx, actor.actorUserId, templateId)),
  }));
}
export async function setTemplateAssignment(
  actor: MetadataActor,
  templateId: string,
  folderId: string,
  input: unknown
) {
  const body = templateObject(input, ['assigned', 'snapshot']);
  if (typeof body.assigned !== 'boolean') throw new PropertyError('assigned must be a boolean');
  const snapshot = templateString(body.snapshot, 128);
  return metadataTransaction(async (tx) => {
    await ownedTemplate(tx, actor, templateId);
    await authorizeMetadata(tx, actor, folderId, actor.actorUserId, null, 'read');
    await authorizeMetadata(tx, actor, folderId, actor.actorUserId, null, 'edit');
    const rows = await assignments(tx, actor.actorUserId, templateId);
    if (membership(rows) !== snapshot) throw new PropertyError('Assignments changed; review before retrying', 409);
    const current = rows.find((row) => row.folderId === folderId);
    if (body.assigned && !current) {
      const policy = await ownedFolderPolicy(tx, actor);
      if (rows.filter((row) => policy.tree.byId.has(row.folderId)).length >= MAX_TEMPLATE_ASSIGNMENTS)
        throw new PropertyError(`At most ${MAX_TEMPLATE_ASSIGNMENTS} active template assignments are allowed`);
      await tx
        .insert(templateFolderAssignments)
        .values({ id: createId('template_folder'), userId: actor.actorUserId, templateId, folderId });
    }
    if (!body.assigned && current)
      await tx.delete(templateFolderAssignments).where(eq(templateFolderAssignments.id, current.id));
    return { ok: true, snapshot: membership(await assignments(tx, actor.actorUserId, templateId)) };
  });
}
export async function saveTemplateTags(actor: MetadataActor, templateId: string, input: unknown) {
  const body = templateObject(input, ['expectedRevision', 'tags']);
  const expected = propertyRevision(body.expectedRevision),
    tags = templateTags(body.tags);
  return metadataTransaction(async (tx) => {
    await ownedTemplate(tx, actor, templateId);
    const current = await tagState(tx, templateId, actor.actorUserId);
    if (current.revision !== expected) throw new PropertyError('Defaults changed; review before retrying', 409);
    if (JSON.stringify(current.tags) === JSON.stringify(tags)) return current;
    const now = new Date();
    if (!expected)
      await tx.insert(templateDefaultState).values({
        templateId,
        userId: actor.actorUserId,
        revision: 1,
        tags: JSON.stringify(tags),
        createdAt: now,
        updatedAt: now,
      });
    else
      await tx
        .update(templateDefaultState)
        .set({ revision: expected + 1, tags: JSON.stringify(tags), updatedAt: now })
        .where(
          and(
            eq(templateDefaultState.templateId, templateId),
            eq(templateDefaultState.userId, actor.actorUserId),
            eq(templateDefaultState.revision, expected)
          )
        );
    return { revision: expected + 1, tags };
  });
}
export async function saveAssignmentDefaults(
  actor: MetadataActor,
  templateId: string,
  folderId: string,
  input: unknown
) {
  const body = templateObject(input, ['assignmentId', 'expectedRevision', 'schemaId', 'schemaRevision', 'values']);
  const id = templateString(body.assignmentId, 100),
    expected = propertyRevision(body.expectedRevision),
    schemaId = templateSchemaId(body.schemaId),
    revision = propertyRevision(body.schemaRevision);
  return metadataTransaction(async (tx) => {
    await ownedTemplate(tx, actor, templateId);
    await authorizeMetadata(tx, actor, folderId, actor.actorUserId, null, 'read');
    await authorizeMetadata(tx, actor, folderId, actor.actorUserId, null, 'edit');
    const [row] = await tx
      .select()
      .from(templateFolderAssignments)
      .where(
        and(
          eq(templateFolderAssignments.templateId, templateId),
          eq(templateFolderAssignments.folderId, folderId),
          eq(templateFolderAssignments.userId, actor.actorUserId)
        )
      );
    if (!row || row.id !== id || row.defaultsRevision !== expected)
      throw new PropertyError('Assignment changed; review before retrying', 409);
    const schema = await metadataSchema(tx, actor.actorUserId, folderId);
    if (schema.schemaId !== schemaId || schema.revision !== revision)
      throw new PropertyError('Schema changed; review before retrying', 409);
    const values = templateValues(body.values, schema);
    await tx
      .update(templateFolderAssignments)
      .set({ defaultsRevision: expected + 1, schemaId, propertyDefaults: JSON.stringify(values) })
      .where(eq(templateFolderAssignments.id, id));
    return { id, revision: expected + 1, schemaId, values };
  });
}
function managedDocument(note: typeof notes.$inferSelect) {
  return {
    template: {
      id: note.id,
      title: note.title,
      folderId: note.folderId,
      body: note.content,
      isApiEditable: note.isApiEditable,
    },
    contentHash: hashMarkdown(note.content),
  };
}
export async function readManagedTemplate(actor: MetadataActor, templateId: string) {
  return metadataTransaction(async (tx) => managedDocument(await ownedTemplate(tx, actor, templateId, 'read')));
}
export async function createManagedTemplate(actor: MetadataActor, input: unknown) {
  const body = templateObject(input, ['folderId', 'title', 'markdown']);
  const folderId = templateString(body.folderId, 100),
    title = templateString(body.title, 1000).trim(),
    markdown = templateString(body.markdown, 200000, true);
  return metadataTransaction(async (tx) => {
    await authorizeMetadata(tx, actor, folderId, actor.actorUserId, null, 'read');
    await authorizeMetadata(tx, actor, folderId, actor.actorUserId, null, 'create');
    const result = await createDocument(
      {
        userId: actor.actorUserId,
        creatorUserId: actor.actorUserId,
        folderId,
        title,
        markdown,
        type: 'template',
        actorType: actor.actorType,
        actorId: actor.actorId ?? actor.actorUserId,
      },
      tx
    );
    if (!result.ok) throw new PropertyError(result.error, result.status as 400 | 404);
    return managedDocument(await ownedTemplate(tx, actor, result.value.note.id, 'read'));
  });
}
export async function updateManagedTemplate(actor: MetadataActor, templateId: string, input: unknown) {
  const body = templateObject(input, ['baseHash', 'expectedTitle', 'title', 'markdown']);
  const baseHash = templateString(body.baseHash, 64),
    expectedTitle = templateString(body.expectedTitle, 200000, true);
  if (!/^[a-f0-9]{64}$/.test(baseHash) || (body.title === undefined && body.markdown === undefined))
    throw new PropertyError('A body hash, exact title and title/markdown change are required');
  const title = body.title === undefined ? undefined : templateString(body.title, 1000).trim();
  const markdown = body.markdown === undefined ? undefined : templateString(body.markdown, 200000, true);
  return metadataTransaction(async (tx) => {
    const current = await ownedTemplate(tx, actor, templateId);
    if (current.title !== expectedTitle || hashMarkdown(current.content) !== baseHash)
      throw new PropertyError('Template changed; read and review before retrying', 409);
    const titleChanged = title !== undefined && title !== current.title,
      contentChanged = markdown !== undefined && markdown !== current.content;
    if (!titleChanged && !contentChanged) return managedDocument(current);
    const [note] = await tx
      .update(notes)
      .set({
        title: title ?? current.title,
        content: markdown ?? current.content,
        updatedAt: new Date(),
        updatedByActorType: actor.actorType ?? 'user',
        updatedByActorId: actor.actorId ?? actor.actorUserId,
      })
      .where(
        activeNoteWhere(
          actor.actorUserId,
          eq(notes.id, current.id),
          eq(notes.folderId, current.folderId),
          eq(notes.title, expectedTitle),
          eq(notes.content, current.content),
          eq(notes.type, 'template'),
          eq(notes.documentType, 'markdown')
        )
      )
      .returning();
    if (!note) throw new PropertyError('Template changed; read and review before retrying', 409);
    await createNoteVersion(
      {
        note: current,
        reason: actor.actorType === 'agent' ? 'before_agent_edit' : 'autosave_checkpoint',
        actorType: actor.actorType ?? 'user',
        actorId: actor.actorId,
      },
      tx
    );
    if (contentChanged) {
      await syncNoteAttachmentReferences({ noteId: note.id, userId: note.userId, markdown: note.content }, tx);
      await reindexNoteLinks(
        { noteId: note.id, userId: note.userId, markdown: note.content, documentType: 'markdown' },
        tx
      );
    }
    if (titleChanged) await resolveUnresolvedNoteLinks({ noteId: note.id, userId: note.userId, title: note.title }, tx);
    await insertNoteEvent(
      {
        noteId: note.id,
        userId: note.userId,
        actorType: actor.actorType ?? 'user',
        actorId: actor.actorId ?? actor.actorUserId,
        eventType: 'update',
        summary: getNoteEventSummary('update', { titleChanged, contentChanged }),
        beforeHash: baseHash,
        afterHash: hashMarkdown(note.content),
      },
      tx
    );
    return managedDocument(note);
  });
}

/** Include retained assignments even when their template or storage folder is in Trash. */
export async function guardTemplateDefaults(
  tx: MetadataTx,
  ownerId: string,
  folderId: string,
  definitions: PropertyDefinition[]
) {
  const rows = await tx
    .select()
    .from(templateFolderAssignments)
    .where(and(eq(templateFolderAssignments.userId, ownerId), eq(templateFolderAssignments.folderId, folderId)));
  for (const row of rows) {
    try {
      templateValues(JSON.parse(row.propertyDefaults), { schemaId: row.schemaId, revision: 0, definitions });
    } catch {
      throw new PropertyError('Clear referenced template defaults or remove the assignment before archiving', 409);
    }
  }
}
async function destination(tx: MetadataTx, actor: MetadataActor, folderId: string) {
  const [folder] = await tx
    .select()
    .from(folders)
    .where(and(eq(folders.id, folderId), isNull(folders.deletedAt)));
  if (!folder) throw new PropertyError('Folder not found', 404);
  await authorizeMetadata(tx, actor, folderId, folder.userId, null, 'create');
  return folder;
}
async function assignedPreview(
  tx: MetadataTx,
  actor: MetadataActor,
  folderId: string,
  ownerId: string,
  templateId: string
): Promise<TemplatePreview> {
  // Preview is a read as well as a destination-create operation for agent credentials.
  if (actor.actorType === 'agent') await authorizeMetadata(tx, actor, folderId, ownerId, null, 'read');
  const [row] = await tx
    .select({ note: notes, assignment: templateFolderAssignments })
    .from(templateFolderAssignments)
    .innerJoin(
      notes,
      and(eq(notes.id, templateFolderAssignments.templateId), eq(notes.userId, templateFolderAssignments.userId))
    )
    .where(
      and(
        eq(templateFolderAssignments.folderId, folderId),
        eq(templateFolderAssignments.userId, ownerId),
        activeNoteWhere(
          ownerId,
          eq(notes.id, templateId),
          eq(notes.type, 'template'),
          eq(notes.documentType, 'markdown')
        )
      )
    );
  if (!row) throw new PropertyError('Assigned template not found', 404);
  if (actor.actorType === 'agent') {
    const sourceFolders = filterActiveFolderHierarchy(
      await tx.select().from(folders).where(activeFolderWhere(ownerId))
    );
    if (isFolderEffectivelyPrivate(row.note.folderId, new Map(sourceFolders.map((f) => [f.id, f]))))
      throw new PropertyError('Assigned template not found', 404);
  }
  const tags = await tagState(tx, templateId, ownerId),
    schema = await metadataSchema(tx, ownerId, folderId);
  const values = templateValues(JSON.parse(row.assignment.propertyDefaults), schema);
  return {
    template: { id: row.note.id, title: row.note.title, body: row.note.content },
    tags: tags.tags,
    values,
    schema: {
      ...schema,
      definitions: schema.definitions
        .filter((d) => !d.archived)
        .map((d) => ({ ...d, options: d.options.filter((o) => !o.archived) })),
    },
    snapshot: digest([
      row.note.id,
      row.note.title,
      row.note.content,
      tags,
      row.assignment.id,
      row.assignment.defaultsRevision,
      row.assignment.schemaId,
      row.assignment.propertyDefaults,
    ]),
  };
}
export async function createFromTemplate(actor: MetadataActor, input: unknown) {
  const body = parseTemplateCreation(input);
  const actorType = actor.actorType ?? 'user';
  const actorId = actorType === 'user' ? actor.actorUserId : actor.actorId;
  if (!actor.actorUserId || !actorId) throw new PropertyError('Authenticated actor required', 403);
  const fingerprint = digest({
    ...body,
    values: Object.fromEntries(Object.entries(body.values).sort(([a], [b]) => a.localeCompare(b))),
  });
  return metadataTransaction(async (tx) => {
    const folder = await destination(tx, actor, body.folderId);
    const [receipt] = await tx
      .select()
      .from(noteCreationRequests)
      .where(
        and(
          eq(noteCreationRequests.folderId, folder.id),
          eq(noteCreationRequests.actorUserId, actor.actorUserId),
          eq(noteCreationRequests.actorType, actorType),
          eq(noteCreationRequests.actorId, actorId),
          eq(noteCreationRequests.requestId, body.requestId)
        )
      );
    if (receipt) {
      if (receipt.fingerprint !== fingerprint)
        throw new PropertyError('Request ID already used with a different payload', 409);
      const [note] = await tx
        .select()
        .from(notes)
        .where(activeNoteWhere(folder.userId, eq(notes.id, receipt.noteId), eq(notes.type, 'note')));
      if (!note) throw new PropertyError('Created note is unavailable', 404);
      // A moved receipt may return only through current folder scope, never reveal a note-grant-only folder.
      await authorizeMetadata(tx, actor, note.folderId, note.userId, null, 'read');
      return {
        note: { id: note.id, title: note.title, folderId: note.folderId },
        contentHash: hashMarkdown(note.content),
        replayed: true,
      };
    }
    const preview = await assignedPreview(tx, actor, folder.id, folder.userId, body.templateId);
    if (
      preview.snapshot !== body.snapshot ||
      preview.schema.schemaId !== body.schemaId ||
      preview.schema.revision !== body.schemaRevision
    )
      throw new PropertyError('Template or schema changed; review before retrying', 409);
    const values = templateValues(body.values, preview.schema);
    const result = await createDocument(
      {
        userId: folder.userId,
        creatorUserId: actor.actorUserId,
        folderId: folder.id,
        title: body.title,
        markdown: renderTemplate(preview.template.body, body.title, body.variables),
        actorType,
        actorId,
      },
      tx
    );
    if (!result.ok) throw new PropertyError(result.error, result.status as 400 | 404);
    const note = result.value.note;
    await setNoteTags({ userId: folder.userId, noteId: note.id, tags: body.tags }, tx);
    const now = new Date();
    if (Object.keys(values).length)
      await tx.insert(notePropertyState).values({
        noteId: note.id,
        userId: folder.userId,
        revision: 1,
        values: JSON.stringify(values),
        createdAt: now,
        updatedAt: now,
      });
    await tx.insert(noteCreationRequests).values({
      id: createId('creation_request'),
      userId: folder.userId,
      folderId: folder.id,
      actorUserId: actor.actorUserId,
      actorType,
      actorId,
      requestId: body.requestId,
      fingerprint,
      noteId: note.id,
      createdAt: now,
    });
    return {
      note: { id: note.id, title: note.title, folderId: folder.id },
      contentHash: result.value.contentHash,
      replayed: false,
    };
  });
}

export async function previewAssignedTemplate(actor: MetadataActor, folderId: string, templateId: string) {
  return metadataTransaction(async (tx) => {
    const folder = await destination(tx, actor, folderId);
    return assignedPreview(tx, actor, folderId, folder.userId, templateId);
  });
}
export async function listAssignedTemplates(actor: MetadataActor, folderId: string) {
  return metadataTransaction(async (tx) => {
    const folder = await destination(tx, actor, folderId);
    if (actor.actorType === 'agent') await authorizeMetadata(tx, actor, folderId, folder.userId, null, 'read');
    const assigned = await tx
      .select({ id: templateFolderAssignments.templateId })
      .from(templateFolderAssignments)
      .where(
        and(eq(templateFolderAssignments.folderId, folderId), eq(templateFolderAssignments.userId, folder.userId))
      );
    const result: Array<{ id: string; title: string }> = [];
    for (const row of assigned) {
      try {
        result.push((await assignedPreview(tx, actor, folderId, folder.userId, row.id)).template);
      } catch (error) {
        if (!(error instanceof PropertyError && error.status === 404)) throw error;
      }
    }
    return result.map(({ id, title }) => ({ id, title }));
  });
}
