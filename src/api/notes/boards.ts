import { and, eq, sql } from 'drizzle-orm';
import {
  type BoardDisplayProperty,
  type BoardSchemaToken,
  BoardValidationError,
  CARD_TEXT_PREVIEW_LENGTH,
  decodeStoredBoardConfig,
  type EffectiveBoard,
  previewBoardProperty,
  UNCLASSIFIED,
  validateBoardConfig,
} from '../../shared/board';
import { hasNoteQuery, type NoteQuery } from '../../shared/note-filters';
import { DEFAULT_NOTE_SORT, isPropertySort, type NoteSort, noteSortIdentity } from '../../shared/note-sort';
import { type PropertyDefinition, PropertyError, type PropertySchema } from '../../shared/properties';
import { db } from '../db/client';
import { folderBoardViews, notePropertyState, notes } from '../db/schema';
import { collaborationAccessibleNoteWhere } from '../lib/collaboration-access';
import { type PageRequest, pageRows } from '../lib/pagination';
import { type FolderQueryInput, folderQueryContext } from './folder-query';
import { authorizeMetadata, metadataSchema } from './metadata-access';
import { type MetadataExecutor, type MetadataTx, metadataTransaction } from './metadata-transaction';
import { noteSortSql } from './note-sort-sql';

export async function readBoardConfig(
  userId: string,
  folderId: string,
  executor: MetadataExecutor = db,
  schemaSnapshot?: PropertySchema
): Promise<EffectiveBoard | null> {
  const [row] = await executor
    .select()
    .from(folderBoardViews)
    .where(and(eq(folderBoardViews.userId, userId), eq(folderBoardViews.folderId, folderId)))
    .limit(1);
  if (!row) return null;
  const { config, requiresReview } = decodeStoredBoardConfig(JSON.parse(row.config));
  if (requiresReview)
    return {
      config,
      version: row.version,
      columns: [],
      reconfigurationRequired: true,
      groupingState: {
        type: 'select',
        available: false,
        reason: 'This board uses retired tag settings. The owner must review and save property-only board settings.',
      },
    };
  if (!config.enabled)
    return {
      config,
      version: row.version,
      columns: [],
      groupingState: {
        type: 'select',
        available: false,
        reason: 'Board is not enabled. The owner can enable it in Board settings.',
      },
    };
  const schema = schemaSnapshot ?? (await metadataSchema(executor as MetadataTx, userId, folderId));
  const field = schema.definitions.find(
    (d) => d.id === config.grouping.propertyId && d.type === 'select' && !d.archived
  );
  if (schema.schemaId !== config.grouping.schemaId || !field)
    return {
      config,
      version: row.version,
      columns: [],
      groupingState: {
        type: 'select',
        available: false,
        reason: 'Grouping property is unavailable; disable or switch the board.',
      },
    };
  if (!(await boardJsonCapability(executor)))
    return {
      config,
      version: row.version,
      columns: [],
      groupingState: {
        type: 'select',
        available: false,
        reason: 'This database does not support Select grouping JSON queries.',
      },
    };
  const cardProperties: BoardDisplayProperty[] = schema.definitions
    .filter((d) => config.cardPropertyIds.includes(d.id) && !d.archived && ['text', 'select', 'date'].includes(d.type))
    .map(
      (d) =>
        ({
          propertyId: d.id,
          label: d.label,
          type: d.type,
          ...(d.type === 'select'
            ? { options: d.options.filter((o) => !o.archived).map(({ id, label }) => ({ id, label })) }
            : {}),
        }) as BoardDisplayProperty
    );
  return {
    config,
    version: row.version,
    cardProperties,
    columns: [
      ...field.options.filter((o) => !o.archived).map((o) => ({ key: o.id, label: o.label })),
      { key: UNCLASSIFIED, label: 'Unclassified' },
    ],
    groupingState: {
      type: 'select',
      available: true,
      schemaId: schema.schemaId,
      schemaRevision: schema.revision,
      propertyId: field.id,
      label: field.label,
    },
  };
}

/** Probe the actual executor, not assumptions about a driver/package version. */
export async function boardJsonCapability(executor: MetadataExecutor = db) {
  try {
    const rows = await executor.all<{ scalar: string; kind: string }>(
      sql`select json_extract(${'{"probe":"ok"}'}, ${'$.probe'}) as scalar, json_type(${'{"probe":"ok"}'}, ${'$.probe'}) as kind`
    );
    return rows[0]?.scalar === 'ok' && rows[0]?.kind === 'text';
  } catch {
    return false;
  }
}

export async function readAuthorizedBoard(actorUserId: string, ownerId: string, folderId: string) {
  return metadataTransaction(async (tx) => {
    await authorizeMetadata(tx, { actorUserId }, folderId, ownerId, null, 'read');
    return readBoardConfig(ownerId, folderId, tx);
  });
}

export async function guardEnabledBoard(
  tx: MetadataTx,
  ownerId: string,
  folderId: string,
  definitions: PropertyDefinition[]
) {
  const [row] = await tx
    .select()
    .from(folderBoardViews)
    .where(and(eq(folderBoardViews.userId, ownerId), eq(folderBoardViews.folderId, folderId)));
  if (!row) return;
  const { config, requiresReview } = decodeStoredBoardConfig(JSON.parse(row.config));
  if (
    config.enabled &&
    !requiresReview &&
    !definitions.some((d) => d.id === config.grouping.propertyId && !d.archived && d.type === 'select')
  )
    throw new PropertyError('Disable or switch the enabled board before archiving its grouping property', 409);
}

/** Version zero means create. Both creation and update are atomic compare-and-set operations. */
export async function saveBoardConfig(
  userId: string,
  folderId: string,
  input: unknown,
  expectedVersion: number,
  reviewedSchema?: BoardSchemaToken
) {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || expectedVersion >= Number.MAX_SAFE_INTEGER)
    throw new BoardValidationError('A nonnegative expectedVersion is required');
  const config = validateBoardConfig(input);
  return metadataTransaction(async (tx) => {
    await authorizeMetadata(tx, { actorUserId: userId }, folderId, userId, null, 'edit');
    if (config.enabled) {
      const schema = await metadataSchema(tx, userId, folderId);
      if (
        !reviewedSchema ||
        reviewedSchema.schemaId !== schema.schemaId ||
        reviewedSchema.schemaRevision !== schema.revision
      )
        throw new PropertyError('Schema changed; refresh and review before saving', 409);
      if (
        config.grouping.schemaId !== schema.schemaId ||
        !schema.definitions.some((d) => d.id === config.grouping.propertyId && !d.archived && d.type === 'select')
      )
        throw new BoardValidationError('Choose an active Select property from this folder');
      if (
        config.cardPropertyIds.some(
          (id) =>
            !schema.definitions.some((d) => d.id === id && !d.archived && ['text', 'select', 'date'].includes(d.type))
        )
      )
        throw new BoardValidationError(
          'Choose active Card properties from this folder or remove unavailable selections'
        );
      if (!(await boardJsonCapability(tx)))
        throw new BoardValidationError('Select grouping JSON queries are unavailable');
    }
    const now = new Date();
    const rows =
      expectedVersion === 0
        ? await tx
            .insert(folderBoardViews)
            .values({ userId, folderId, config: JSON.stringify(config), version: 1, createdAt: now, updatedAt: now })
            .onConflictDoNothing()
            .returning({ version: folderBoardViews.version })
        : await tx
            .update(folderBoardViews)
            .set({ config: JSON.stringify(config), version: expectedVersion + 1, updatedAt: now })
            .where(
              and(
                eq(folderBoardViews.userId, userId),
                eq(folderBoardViews.folderId, folderId),
                eq(folderBoardViews.version, expectedVersion)
              )
            )
            .returning({ version: folderBoardViews.version });
    return rows.length ? readBoardConfig(userId, folderId, tx) : null;
  });
}

/** Bind ACL, config, definitions and classification to one DB snapshot. */
export async function readAuthorizedBoardLane(
  input: Omit<LaneInput, 'board' | 'queryContext'> & FolderQueryInput & { version?: number }
) {
  return metadataTransaction(async (tx) => {
    await authorizeMetadata(tx, { actorUserId: input.actorUserId }, input.folderId, input.userId, null, 'read');
    const schemaSnapshot =
      input.query?.filters.all.length || isPropertySort(input.sort)
        ? await metadataSchema(tx, input.userId, input.folderId)
        : undefined;
    const board = await readBoardConfig(input.userId, input.folderId, tx, schemaSnapshot);
    if (!board?.config.enabled) throw new PropertyError('Board is not enabled', 404);
    if (input.version !== undefined && input.version !== board.version)
      throw new PropertyError('Board configuration changed. Refresh the board.', 409);
    if (input.version === undefined || input.schemaId === undefined || input.schemaRevision === undefined)
      throw new BoardValidationError('Select lanes require board and schema snapshot tokens');
    const state = board.groupingState;
    if (
      !state.available ||
      state.type !== 'select' ||
      state.schemaId !== input.schemaId ||
      state.schemaRevision !== input.schemaRevision
    )
      throw new PropertyError('Grouping schema changed or is unavailable. Refresh the board.', 409);
    if (!board.columns.some((c) => c.key === input.lane)) throw new BoardValidationError('Unknown lane');
    const queryContext =
      (input.query && hasNoteQuery(input.query)) || isPropertySort(input.sort)
        ? await folderQueryContext(tx, input.userId, input.folderId, input, schemaSnapshot)
        : undefined;
    return readBoardLane({ ...input, board, queryContext }, tx);
  });
}

async function readSelectLane(input: LaneInput, executor: MetadataExecutor) {
  const { config, groupingState: state } = input.board;
  if (input.board.reconfigurationRequired || state.type !== 'select' || !state.available)
    throw new PropertyError('Grouping unavailable. Refresh the board.', 409);
  if (!input.board.columns.some((c) => c.key === input.lane)) throw new BoardValidationError('Unknown lane');
  const path = `$."${config.grouping.propertyId}"`;
  const values = sql`case when json_valid(${notePropertyState.values}) then ${notePropertyState.values} else ${'{}'} end`;
  const kind = sql`json_type(${values}, ${path})`;
  const value = sql`json_extract(${values}, ${path})`;
  const activeIds = input.board.columns.filter((c) => c.key !== UNCLASSIFIED).map((c) => c.key);
  const available = sql`(${kind} = 'text' and ${value} in (${sql.join(
    activeIds.map((id) => sql`${id}`),
    sql`, `
  )}))`;
  const display = input.board.cardProperties ?? [];
  const projections = Object.fromEntries(
    display.map((definition, index) => {
      const propertyPath = `$."${definition.propertyId}"`;
      return [
        `preview_${index}`,
        sql<
          string | null
        >`case when json_type(${values}, ${propertyPath}) = 'text' and instr(json_extract(${values}, ${propertyPath}), char(0)) = 0 then substr(json_extract(${values}, ${propertyPath}), 1, ${CARD_TEXT_PREVIEW_LENGTH + 1}) else null end`,
      ];
    })
  );
  const rows = await executor
    .select({
      id: notes.id,
      folderId: notes.folderId,
      title: notes.title,
      documentType: notes.documentType,
      createdAt: notes.createdAt,
      updatedAt: notes.updatedAt,
      ...projections,
      unclassifiedReason: sql<
        'no-property-value' | 'unavailable-property-value' | null
      >`case when ${kind} is null then 'no-property-value' when not coalesce(${available}, 0) then 'unavailable-property-value' else null end`,
    })
    .from(notes)
    .leftJoin(
      notePropertyState,
      and(eq(notePropertyState.noteId, notes.id), eq(notePropertyState.userId, notes.userId))
    )
    .where(
      and(
        collaborationAccessibleNoteWhere(input.actorUserId),
        eq(notes.userId, input.userId),
        eq(notes.folderId, input.folderId),
        eq(notes.type, 'note'),
        input.queryContext?.where,
        input.lane === UNCLASSIFIED
          ? sql`not coalesce(${available}, 0)`
          : sql`${kind} = 'text' and ${value} = ${input.lane}`
      )
    )
    .orderBy(...(input.queryContext?.orderBy ?? noteSortSql(input.sort)))
    .limit(input.page.limit + 1)
    .offset(input.page.offset);
  const page = pageRows(rows, input.page);
  return {
    cards: page.items.map((row) => ({
      id: row.id,
      folderId: row.folderId,
      title: row.title,
      documentType: row.documentType,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      unclassifiedReason: row.unclassifiedReason,
      properties: display.flatMap((definition, index) => {
        const property = previewBoardProperty(
          definition,
          (row as unknown as Record<string, unknown>)[`preview_${index}`]
        );
        return property ? [property] : [];
      }),
    })),
    lane: input.lane,
    ...(input.sort && input.sort !== DEFAULT_NOTE_SORT ? { sortIdentity: noteSortIdentity(input.sort) } : {}),
    configVersion: input.board.version,
    ...(input.queryContext
      ? {
          queryIdentity: input.queryContext.queryIdentity,
          ...(input.queryContext.querySchema ? { querySchema: input.queryContext.querySchema } : {}),
        }
      : {}),
    schemaId: state.schemaId,
    schemaRevision: state.schemaRevision,
    page: page.page,
    limit: page.limit,
    hasMore: page.hasMore,
  };
}

type LaneInput = {
  sort?: NoteSort;
  actorUserId: string;
  userId: string;
  query?: NoteQuery;
  queryContext?: Awaited<ReturnType<typeof folderQueryContext>>;
  folderId: string;
  board: NonNullable<Awaited<ReturnType<typeof readBoardConfig>>>;
  lane: string;
  page: PageRequest;
};
export async function readBoardLane(input: LaneInput, executor: MetadataExecutor = db) {
  return readSelectLane(input, executor);
}
