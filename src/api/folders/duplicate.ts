import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull, type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import {
  FOLDER_COPY_LIMITS,
  FolderDuplicationError,
  type FolderDuplicationPreview,
  type FolderDuplicationRequest,
  type FolderDuplicationResult,
  parseFolderDuplication,
} from '../../shared/folder-duplication';
import {
  attachments,
  folderBoardViews,
  folderDuplicationRequests,
  folderPropertySchemas,
  folders,
  noteEvents,
  notePropertyState,
  notes,
  noteTags,
  templateDefaultState,
  templateFolderAssignments,
} from '../db/schema';
import { getApiRuntimeConfig } from '../lib/env';
import { createId } from '../lib/id';
import { reindexNoteLinks } from '../notes/links';
import { type MetadataTx, metadataTransaction } from '../notes/metadata-transaction';
import { createNoteVersion } from '../notes/versions';
import { getObjectStorage } from '../storage';
import type { ObjectStorage } from '../storage/object-storage';
import { activeAttachmentWhere, activeNoteWhere } from '../trash/policy';
import { discardStaged, planAttachments, stageAttachments } from './duplicate-attachments';
import {
  contentReferences,
  copyBoard,
  copyContent,
  copySchema,
  copyValues,
  type SchemaCopy,
} from './duplicate-content';

type Folder = typeof folders.$inferSelect;
function digest(value: unknown) {
  return createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item) =>
        item instanceof Map ? [...item.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))) : item
      )
    )
    .digest('hex');
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new FolderDuplicationError('Missing copy mapping');
  return value;
}
function limit() {
  return new FolderDuplicationError(
    'This folder exceeds the copy limits (100 notes/templates, 25 MB of images, 16 MB of content/metadata); choose a smaller folder',
    413
  );
}
async function ownedPath(tx: MetadataTx, actor: string, id: string) {
  const path: Folder[] = [];
  let current: string | null = id;
  while (current) {
    if (path.length > 4 || path.some((row) => row.id === current))
      throw new FolderDuplicationError('Invalid folder hierarchy');
    const [row] = await tx
      .select()
      .from(folders)
      .where(and(eq(folders.userId, actor), eq(folders.id, current), isNull(folders.deletedAt)));
    if (!row) throw new FolderDuplicationError('Folder not found', 404);
    path.push(row);
    current = row.parentFolderId;
  }
  return path;
}
async function snapshot(tx: MetadataTx, actor: string, sourceId: string, parentId: string | null, origins: string[]) {
  const sourcePath = await ownedPath(tx, actor, sourceId);
  const destinationPath = parentId ? await ownedPath(tx, actor, parentId) : [];
  if (destinationPath.some((row) => row.isPrivate))
    throw new FolderDuplicationError('Cannot create subfolders under a private folder', 403);
  const tree: Folder[] = [sourcePath[0]];
  let frontier = [sourceId],
    height = 0;
  while (frontier.length) {
    const children = await tx
      .select()
      .from(folders)
      .where(and(eq(folders.userId, actor), isNull(folders.deletedAt), inArray(folders.parentFolderId, frontier)))
      .orderBy(asc(folders.id))
      .limit(FOLDER_COPY_LIMITS.folders - tree.length + 1);
    if (!children.length) break;
    if (tree.length + children.length > FOLDER_COPY_LIMITS.folders) throw limit();
    if (children.some((row) => tree.some((old) => old.id === row.id)) || ++height > 4)
      throw new FolderDuplicationError('Invalid source folder hierarchy');
    tree.push(...children);
    frontier = children.map((row) => row.id);
  }
  const folderIds = tree.map((row) => row.id);
  if (parentId && folderIds.includes(parentId))
    throw new FolderDuplicationError('Choose a destination outside the source folder', 400);
  if (destinationPath.length + height > 4 || sourcePath.length - 1 + height > 4)
    throw new FolderDuplicationError('Maximum folder depth reached', 400);
  let bytes = Buffer.byteLength(JSON.stringify([tree, sourcePath, destinationPath]));
  // Estimate in SQL before fetching large bodies/default maps. Account for row overhead too.
  async function read<R>(
    table: SQLWrapper,
    where: SQL | undefined,
    blob: SQLWrapper,
    query: () => PromiseLike<R[]>
  ): Promise<R[]> {
    const estimate = await tx.get<{ bytes: number }>(
      sql`select coalesce(sum(256 + coalesce(length(cast(${blob} as blob)),0)),0) as bytes from ${table} where ${where}`
    );
    if (bytes + Number(estimate?.bytes ?? 0) > FOLDER_COPY_LIMITS.bytes) throw limit();
    const rows = await query();
    bytes += Buffer.byteLength(JSON.stringify(rows));
    if (bytes > FOLDER_COPY_LIMITS.bytes) throw limit();
    return rows;
  }
  const assignmentWhere = and(
    eq(templateFolderAssignments.userId, actor),
    inArray(templateFolderAssignments.folderId, folderIds)
  );
  const membership = await read(
    templateFolderAssignments,
    assignmentWhere,
    templateFolderAssignments.propertyDefaults,
    () => tx.select().from(templateFolderAssignments).where(assignmentWhere).orderBy(asc(templateFolderAssignments.id))
  );
  const noteWhere = activeNoteWhere(
    actor,
    sql`(${inArray(notes.folderId, folderIds)} or (${notes.type} = 'template' and exists (select 1 from ${templateFolderAssignments} where ${assignmentWhere} and ${templateFolderAssignments.templateId} = ${notes.id})))`
  );
  const documents = await read(notes, noteWhere, notes.content, () =>
    tx
      .select()
      .from(notes)
      .where(noteWhere)
      .orderBy(asc(notes.id))
      .limit(FOLDER_COPY_LIMITS.notes + 1)
  );
  if (documents.length > FOLDER_COPY_LIMITS.notes) throw limit();
  const noteIds = documents.map((row) => row.id),
    templateIds = documents.filter((row) => row.type === 'template').map((row) => row.id);
  const assignments = membership.filter((row) => templateIds.includes(row.templateId));
  const schemasWhere = and(eq(folderPropertySchemas.userId, actor), inArray(folderPropertySchemas.folderId, folderIds));
  const schemas = await read(folderPropertySchemas, schemasWhere, folderPropertySchemas.definitions, () =>
    tx.select().from(folderPropertySchemas).where(schemasWhere).orderBy(asc(folderPropertySchemas.folderId))
  );
  const boardWhere = and(eq(folderBoardViews.userId, actor), inArray(folderBoardViews.folderId, folderIds));
  const boards = await read(folderBoardViews, boardWhere, folderBoardViews.config, () =>
    tx.select().from(folderBoardViews).where(boardWhere).orderBy(asc(folderBoardViews.folderId))
  );
  const valueWhere = and(eq(notePropertyState.userId, actor), inArray(notePropertyState.noteId, noteIds));
  const values = await read(notePropertyState, valueWhere, notePropertyState.values, () =>
    tx.select().from(notePropertyState).where(valueWhere).orderBy(asc(notePropertyState.noteId))
  );
  const tagWhere = and(eq(noteTags.userId, actor), inArray(noteTags.noteId, noteIds));
  const tags = await read(noteTags, tagWhere, sql`''`, () =>
    tx.select().from(noteTags).where(tagWhere).orderBy(asc(noteTags.id))
  );
  const defaultsWhere = and(
    eq(templateDefaultState.userId, actor),
    inArray(templateDefaultState.templateId, templateIds)
  );
  const defaults = await read(templateDefaultState, defaultsWhere, templateDefaultState.tags, () =>
    tx.select().from(templateDefaultState).where(defaultsWhere).orderBy(asc(templateDefaultState.templateId))
  );
  // Include an imported template's protection context, not its unrelated folder's schema/config.
  const importedPaths: Folder[][] = [];
  for (const id of [
    ...new Set(documents.filter((row) => !folderIds.includes(row.folderId)).map((row) => row.folderId)),
  ].sort())
    importedPaths.push(await ownedPath(tx, actor, id));
  const refs = new Map<string, string[]>(),
    titleTargets = new Set<string>();
  let referenceCount = 0;
  for (const note of documents) {
    const found = contentReferences(note.content, note.documentType, origins);
    refs.set(note.id, found.attachments);
    referenceCount += found.attachments.length;
    for (const title of found.titles) titleTargets.add(title);
  }
  if (referenceCount > FOLDER_COPY_LIMITS.attachments) throw limit();
  const attachmentIds = [...new Set([...refs.values()].flat())];
  const attachmentWhere = activeAttachmentWhere(
    actor,
    inArray(attachments.id, attachmentIds),
    eq(attachments.status, 'ready')
  );
  const images = await read(attachments, attachmentWhere, sql`''`, () =>
    tx.select().from(attachments).where(attachmentWhere).orderBy(asc(attachments.id))
  );
  if (images.length !== attachmentIds.length)
    throw new FolderDuplicationError('A referenced image is unavailable; repair the source before duplicating');
  const imageNotes = images.length
    ? await tx
        .select({ folderId: notes.folderId })
        .from(notes)
        .where(
          activeNoteWhere(
            actor,
            inArray(
              notes.id,
              images.map((image) => image.noteId)
            )
          )
        )
    : [];
  const protectedImageFolders = [...new Set(imageNotes.map((note) => note.folderId))]
    .filter((id) => !folderIds.includes(id) && !importedPaths.some((path) => path[0].id === id))
    .sort();
  for (const id of protectedImageFolders) importedPaths.push(await ownedPath(tx, actor, id));
  const titles = new Map<string, string>();
  const wanted = [...titleTargets].sort();
  for (let start = 0; start < wanted.length; start += 100) {
    const candidates = await tx
      .select({ title: notes.title, id: sql<string>`min(${notes.id})`, count: sql<number>`count(*)` })
      .from(notes)
      .where(activeNoteWhere(actor, eq(notes.type, 'note'), inArray(notes.title, wanted.slice(start, start + 100))))
      .groupBy(notes.title)
      .orderBy(asc(notes.title));
    for (const row of candidates) if (Number(row.count) === 1) titles.set(row.title, row.id);
  }
  bytes += Buffer.byteLength(JSON.stringify([importedPaths, [...titles], [...refs]]));
  if (bytes > FOLDER_COPY_LIMITS.bytes) throw limit();
  return {
    tree,
    sourcePath,
    destinationPath,
    importedPaths,
    documents,
    schemas,
    boards,
    values,
    tags,
    defaults,
    assignments,
    images,
    refs,
    titles,
  };
}
async function receipt(tx: MetadataTx, actor: string, requestId: string) {
  const [row] = await tx
    .select()
    .from(folderDuplicationRequests)
    .where(and(eq(folderDuplicationRequests.actorUserId, actor), eq(folderDuplicationRequests.requestId, requestId)));
  return row;
}
async function replay(
  tx: MetadataTx,
  actor: string,
  row: typeof folderDuplicationRequests.$inferSelect,
  fingerprint: string
): Promise<FolderDuplicationResult> {
  if (row.fingerprint !== fingerprint)
    throw new FolderDuplicationError('Request ID already used with a different duplication', 409);
  const path = await ownedPath(tx, actor, row.rootFolderId);
  return {
    folder: { id: path[0].id, title: path[0].title, parentFolderId: path[0].parentFolderId },
    counts: JSON.parse(row.counts),
    replayed: true,
  };
}
function sized(raw: string, max: number) {
  if (Buffer.byteLength(raw) > max) throw limit();
  return raw;
}
function copyOrigins(origins?: string[]) {
  if (origins) return origins;
  const config = getApiRuntimeConfig();
  return [config.frontendUrl, config.apiUrl, config.attachmentStorage.publicBaseUrl]
    .filter((value): value is string => !!value)
    .map((value) => new URL(value).origin);
}
export async function previewFolderDuplication(
  actor: string,
  sourceId: string,
  parentId: unknown,
  options: { origins?: string[] } = {}
): Promise<FolderDuplicationPreview> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(sourceId)) throw new FolderDuplicationError('Folder not found', 404);
  const parent = parseFolderDuplication({
    title: 'Copy',
    parentFolderId: parentId,
    requestId: 'preview_request_0',
  }).parentFolderId;
  const original = await metadataTransaction((tx) =>
    snapshot(tx, actor, sourceId, parent, copyOrigins(options.origins))
  );
  // Reuse image validation/count semantics, but never initialize storage or stage objects here.
  const plans = planAttachments(
    original.images,
    original.documents,
    original.refs,
    new Map(original.documents.map((row) => [row.id, row.id])),
    new Map(original.tree.map((row) => [row.id, row.id])),
    sourceId
  );
  return {
    sourceFolderId: sourceId,
    parentFolderId: parent,
    token: digest(original),
    counts: {
      folders: original.tree.length,
      notes: original.documents.filter((row) => row.type === 'note').length,
      templates: original.documents.filter((row) => row.type === 'template').length,
      attachments: plans.length,
    },
    imageBytes: plans.reduce((sum, plan) => sum + plan.source.size, 0),
  };
}
export async function duplicateFolder(
  actor: string,
  sourceId: string,
  input: unknown,
  options: { storage?: ObjectStorage; origins?: string[] } = {}
): Promise<FolderDuplicationResult> {
  const request = parseFolderDuplication(input);
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(sourceId)) throw new FolderDuplicationError('Folder not found', 404);
  // A preview is a changing precondition, not a new intent. Keep legacy receipt fingerprints valid,
  // so an explicitly reviewed legacy retry can retain its request ID and converge with an in-flight copy.
  const fingerprint = digest({
    sourceId,
    title: request.title,
    parentFolderId: request.parentFolderId,
    requestId: request.requestId,
  });
  try {
    return await duplicateAttempt(actor, sourceId, request, fingerprint, options);
  } catch (error) {
    // Even preparation/precondition failures can race a successful concurrent attempt. Reconcile
    // before reporting rejection, but do not turn an unavailable probe into proof of failure.
    if (error instanceof FolderDuplicationError && error.uncertain) throw error;
    let committed: FolderDuplicationResult | null;
    try {
      committed = await metadataTransaction(async (tx) => {
        const prior = await receipt(tx, actor, request.requestId);
        return prior ? replay(tx, actor, prior, fingerprint) : null;
      });
    } catch (probeError) {
      if (probeError instanceof FolderDuplicationError) throw probeError;
      throw new FolderDuplicationError(
        'Duplication outcome could not be confirmed. Retry the unchanged request.',
        503,
        true
      );
    }
    if (committed) return committed;
    throw error;
  }
}
async function duplicateAttempt(
  actor: string,
  sourceId: string,
  request: FolderDuplicationRequest,
  fingerprint: string,
  options: { storage?: ObjectStorage; origins?: string[] }
): Promise<FolderDuplicationResult> {
  const captured = await metadataTransaction(async (tx) => {
    const prior = await receipt(tx, actor, request.requestId);
    if (prior) return { kind: 'replay' as const, result: await replay(tx, actor, prior, fingerprint) };
    // Receipt and validation share one consistent database snapshot. A completed copy's new
    // titles must never be visible here while its receipt is still observed as absent.
    const origins = copyOrigins(options.origins);
    const original = await snapshot(tx, actor, sourceId, request.parentFolderId, origins);
    const sourceHash = digest(original);
    if (!request.previewToken)
      throw new FolderDuplicationError('Review the copy summary to continue this same attempt', 428);
    if (request.previewToken !== sourceHash)
      throw new FolderDuplicationError(
        'Source or destination changed. Refresh the copy summary and confirm again',
        409
      );
    return { kind: 'snapshot' as const, original, sourceHash, origins };
  });
  if (captured.kind === 'replay') return captured.result;
  const { original, sourceHash, origins } = captured;
  const rootId = createId('folder');
  const folderIds = new Map(original.tree.map((row) => [row.id, row.id === sourceId ? rootId : createId('folder')]));
  const noteIds = new Map(original.documents.map((row) => [row.id, createId('note')]));
  const schemaCopies = new Map<string, SchemaCopy>(
    original.schemas.map((row) => [row.folderId, copySchema(row.schemaId, row.definitions)])
  );
  const plans = planAttachments(original.images, original.documents, original.refs, noteIds, folderIds, rootId);
  const storage = plans.length ? (options.storage ?? getObjectStorage()) : null;
  const staged: string[] = [];
  let finalStarted = false;
  const now = new Date();
  const copiedNotes = original.documents.map((note) => ({
    ...note,
    id: required(noteIds.get(note.id)),
    folderId: folderIds.get(note.folderId) ?? rootId,
    createdByUserId: actor,
    createdAt: now,
    updatedAt: now,
    updatedByActorType: 'user',
    updatedByActorId: actor,
    deletedAt: null,
    trashBatchId: null,
    content: copyContent(note.content, note.documentType, {
      notes: noteIds,
      titles: original.titles,
      origins,
      attachments: new Map(plans.filter((p) => p.noteId === noteIds.get(note.id)).map((p) => [p.source.id, p.id])),
    }),
  }));
  const protections = [...original.sourcePath, ...original.importedPaths.flat()];
  const copiedFolders = original.tree.map((row) => ({
    ...row,
    id: required(folderIds.get(row.id)),
    parentFolderId:
      row.id === sourceId ? request.parentFolderId : required(folderIds.get(required(row.parentFolderId ?? undefined))),
    title: row.id === sourceId ? request.title : row.title,
    createdByUserId: actor,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    trashBatchId: null,
    isPrivate: row.isPrivate || (row.id === sourceId && protections.some((p) => p.isPrivate)),
    isAgentReadOnly: row.isAgentReadOnly || (row.id === sourceId && protections.some((p) => p.isAgentReadOnly)),
  }));
  const copiedSchemas = original.schemas.map((row) => {
    const copy = required(schemaCopies.get(row.folderId));
    return {
      ...row,
      folderId: required(folderIds.get(row.folderId)),
      schemaId: copy.schemaId,
      definitions: sized(JSON.stringify(copy.definitions), 65536),
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
  });
  const copiedValues = original.values.map((row) => {
    const source = required(original.documents.find((note) => note.id === row.noteId));
    return {
      ...row,
      noteId: required(noteIds.get(row.noteId)),
      values: sized(copyValues(row.values, schemaCopies.get(source.folderId)), 262144),
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
  });
  const copiedBoards = original.boards.map((row) => ({
    ...row,
    folderId: required(folderIds.get(row.folderId)),
    config: sized(copyBoard(row.config, schemaCopies.get(row.folderId)), 16384),
    version: 1,
    createdAt: now,
    updatedAt: now,
  }));
  const copiedTags = original.tags.map((row) => ({
    ...row,
    id: createId('note_tag'),
    noteId: required(noteIds.get(row.noteId)),
    createdAt: now,
  }));
  const copiedDefaults = original.defaults.map((row) => ({
    ...row,
    templateId: required(noteIds.get(row.templateId)),
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }));
  const copiedAssignments = original.assignments.map((row) => {
    const schema = schemaCopies.get(row.folderId),
      matches = schema?.oldSchemaId === row.schemaId;
    return {
      ...row,
      id: createId('assignment'),
      folderId: required(folderIds.get(row.folderId)),
      templateId: required(noteIds.get(row.templateId)),
      schemaId: matches ? schema.schemaId : row.schemaId,
      propertyDefaults: sized(copyValues(row.propertyDefaults, matches ? schema : undefined), 262144),
      defaultsRevision: row.defaultsRevision ? 1 : 0,
      createdAt: now,
    };
  });
  const copiedImages = plans.map((plan) => ({
    ...plan.source,
    id: plan.id,
    noteId: plan.noteId,
    folderId: plan.folderId,
    provider: required(storage ?? undefined).provider,
    storageKey: plan.storageKey,
    referencedAt: now,
    unreferencedAt: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  }));
  // One logical copy budget, including every remapped metadata row, before any object staging.
  // Initial history/FTS are derived representations of this same content, not another logical document.
  if (
    Buffer.byteLength(
      JSON.stringify([
        copiedFolders,
        copiedSchemas,
        copiedNotes,
        copiedValues,
        copiedBoards,
        copiedTags,
        copiedDefaults,
        copiedAssignments,
        copiedImages,
      ])
    ) > FOLDER_COPY_LIMITS.bytes
  )
    throw limit();
  const counts = {
    folders: original.tree.length,
    notes: copiedNotes.filter((row) => row.type === 'note').length,
    templates: copiedNotes.filter((row) => row.type === 'template').length,
    attachments: plans.length,
  };
  try {
    if (storage) await stageAttachments(storage, plans, staged);
    finalStarted = true;
    const result = await metadataTransaction(async (tx) => {
      const prior = await receipt(tx, actor, request.requestId);
      if (prior) return replay(tx, actor, prior, fingerprint);
      if (digest(await snapshot(tx, actor, sourceId, request.parentFolderId, origins)) !== sourceHash)
        throw new FolderDuplicationError('Source or destination changed while copying; review and retry');
      for (const row of copiedFolders) await tx.insert(folders).values(row);
      for (const row of copiedSchemas) await tx.insert(folderPropertySchemas).values(row);
      for (const row of copiedNotes) await tx.insert(notes).values(row);
      for (const row of copiedValues) await tx.insert(notePropertyState).values(row);
      for (const row of copiedBoards) await tx.insert(folderBoardViews).values(row);
      for (const row of copiedTags) await tx.insert(noteTags).values(row);
      for (const row of copiedDefaults) await tx.insert(templateDefaultState).values(row);
      for (const row of copiedAssignments) await tx.insert(templateFolderAssignments).values(row);
      for (const row of copiedImages) await tx.insert(attachments).values(row);
      for (const note of copiedNotes) {
        await reindexNoteLinks(
          { userId: actor, noteId: note.id, markdown: note.content, documentType: note.documentType },
          tx
        );
        await createNoteVersion({ note, reason: 'create', actorType: 'user', actorId: actor }, tx);
        await tx.insert(noteEvents).values({
          id: createId('event'),
          noteId: note.id,
          userId: actor,
          actorType: 'user',
          actorId: actor,
          eventType: 'create',
          summary: 'Created by duplicating a folder',
          afterHash: createHash('sha256').update(note.content).digest('hex'),
          createdAt: now,
        });
      }
      await tx.insert(folderDuplicationRequests).values({
        id: createId('folder_copy_request'),
        actorUserId: actor,
        requestId: request.requestId,
        fingerprint,
        sourceFolderId: sourceId,
        parentFolderId: request.parentFolderId,
        title: request.title,
        rootFolderId: rootId,
        counts: JSON.stringify(counts),
        createdAt: now,
      });
      return {
        folder: { id: rootId, title: request.title, parentFolderId: request.parentFolderId },
        counts,
        replayed: false,
      };
    });
    if (result.folder.id !== rootId && storage) await discardStaged(storage, staged);
    return result;
  } catch (error) {
    if (!finalStarted) {
      if (storage) await discardStaged(storage, staged);
      if (error instanceof FolderDuplicationError) throw error;
      throw new FolderDuplicationError('Image copying failed; retry the unchanged request', 503);
    }
    // A failed acknowledgement is not proof of rollback. Reconcile before deleting any objects.
    let existing: typeof folderDuplicationRequests.$inferSelect | undefined;
    try {
      existing = await metadataTransaction((tx) => receipt(tx, actor, request.requestId));
    } catch {
      throw new FolderDuplicationError(
        'Duplication outcome could not be confirmed. Retry the unchanged request.',
        503,
        true
      );
    }
    if (existing) {
      if (existing.rootFolderId !== rootId && storage) await discardStaged(storage, staged);
      return metadataTransaction((tx) => replay(tx, actor, required(existing), fingerprint));
    }
    if (storage) await discardStaged(storage, staged);
    if (error instanceof FolderDuplicationError) throw error;
    throw new FolderDuplicationError('Folder copying failed; retry the unchanged request', 503);
  }
}
