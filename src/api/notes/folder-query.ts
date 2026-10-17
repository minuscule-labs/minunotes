import { and, eq } from 'drizzle-orm';
import {
  NOTE_QUERY_MAX_BYTES,
  type NoteQuery,
  NoteQueryError,
  noteQueryIdentity,
  parseNoteQuery,
} from '../../shared/note-filters';
import {
  DEFAULT_NOTE_SORT,
  isPropertySort,
  type NoteSort,
  noteSortIdentity,
  parseNoteSort,
} from '../../shared/note-sort';
import { PropertyError, type PropertySchema } from '../../shared/properties';
import { notePropertyState, notes } from '../db/schema';
import { collaborationAccessibleNoteWhere } from '../lib/collaboration-access';
import { type PageRequest, pageRows } from '../lib/pagination';
import { compactNoteSelection } from './listing';
import { authorizeMetadata, metadataSchema } from './metadata-access';
import { type MetadataTx, metadataTransaction } from './metadata-transaction';
import { noteSortSql } from './note-sort-sql';
import { propertyFilterSql } from './property-filter-sql';

export type FolderQueryInput = { query?: NoteQuery; sort?: NoteSort; schemaId?: string; schemaRevision?: number };
export function parseFolderQueryRequest(params: URLSearchParams): FolderQueryInput & { query: NoteQuery } {
  if (params.toString().length > NOTE_QUERY_MAX_BYTES)
    throw new NoteQueryError('Shorten the search or filters (maximum encoded query is 8 KiB).');
  for (const key of ['q', 'filters', 'schemaId', 'schemaRevision', 'page', 'limit'])
    if (params.getAll(key).length > 1) throw new NoteQueryError(`Repeated ${key} parameter`);
  const query = parseNoteQuery({ q: params.get('q') ?? undefined, filters: params.get('filters') ?? undefined });
  const schemaId = params.get('schemaId') ?? undefined;
  const revision = params.get('schemaRevision') ?? undefined;
  if (schemaId !== undefined && !/^[a-zA-Z0-9_-]{1,100}$/.test(schemaId))
    throw new NoteQueryError('Invalid schema identity');
  if (
    revision !== undefined &&
    (!/^[1-9]\d*$/.test(revision) ||
      !Number.isSafeInteger(Number(revision)) ||
      Number(revision) >= Number.MAX_SAFE_INTEGER)
  )
    throw new NoteQueryError('Invalid schema revision');
  return {
    query,
    sort: parseNoteSort(params),
    schemaId,
    schemaRevision: revision === undefined ? undefined : Number(revision),
  };
}

/** Resolve once inside the caller's authorized transaction; scope never comes from a clause. */
export async function folderQueryContext(
  tx: MetadataTx,
  ownerId: string,
  folderId: string,
  input: FolderQueryInput,
  snapshot?: PropertySchema
) {
  const query = input.query ?? parseNoteQuery({});
  let schema: PropertySchema | undefined;
  if (query.filters.all.length || isPropertySort(input.sort)) {
    schema = snapshot ?? (await metadataSchema(tx, ownerId, folderId));
    if (!input.schemaId || input.schemaId !== schema.schemaId || input.schemaRevision !== schema.revision)
      throw new PropertyError(
        isPropertySort(input.sort)
          ? 'Sort definitions changed. Refresh definitions and review the sort.'
          : 'Filter schema changed. Refresh definitions and review the query.',
        409
      );
  }
  const where = propertyFilterSql(query, schema);
  return {
    where,
    orderBy: noteSortSql(input.sort, schema),
    queryIdentity: noteQueryIdentity(query),
    ...(schema ? { querySchema: { schemaId: schema.schemaId, schemaRevision: schema.revision } } : {}),
  };
}

export async function readFilteredFolderNotes(
  input: FolderQueryInput & { actorUserId: string; ownerId: string; folderId: string; page: PageRequest }
) {
  return metadataTransaction(async (tx) => {
    await authorizeMetadata(tx, { actorUserId: input.actorUserId }, input.folderId, input.ownerId, null, 'read');
    const context = await folderQueryContext(tx, input.ownerId, input.folderId, input);
    const rows = await tx
      .select(compactNoteSelection)
      .from(notes)
      .leftJoin(
        notePropertyState,
        and(eq(notePropertyState.noteId, notes.id), eq(notePropertyState.userId, notes.userId))
      )
      .where(
        and(
          collaborationAccessibleNoteWhere(input.actorUserId),
          eq(notes.userId, input.ownerId),
          eq(notes.folderId, input.folderId),
          eq(notes.type, 'note'),
          context.where
        )
      )
      .orderBy(...context.orderBy)
      .limit(input.page.limit + 1)
      .offset(input.page.offset);
    const page = pageRows(rows, input.page);
    return {
      documents: page.items,
      hasMore: page.hasMore,
      queryIdentity: context.queryIdentity,
      ...(input.sort && input.sort !== DEFAULT_NOTE_SORT ? { sortIdentity: noteSortIdentity(input.sort) } : {}),
      ...(context.querySchema ? { querySchema: context.querySchema } : {}),
    };
  });
}
