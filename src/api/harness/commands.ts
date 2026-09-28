import { createHash } from 'node:crypto';
import {
  compileMinuDiagramSyntax,
  createDefaultCanvasDocument,
  createDefaultMindMapDocument,
  type JsonCanvasDocument,
} from '@dpklabs/minucanvas';
import { and, asc, desc, eq, gt, inArray, isNull, like, lt, or, sql } from 'drizzle-orm';
import type { MinuNotesNodeExtra, MinuNotesNodeMetadata } from '../../shared/canvas-links';
import { syncNoteAttachmentReferences } from '../attachments/references';
import { db } from '../db/client';
import { folders, type Note, noteEvents, notes, noteTags, noteVersions, tags } from '../db/schema';
import {
  collaborationAccessibleNoteWhere,
  integrationAccessibleNoteWhere,
  type SharedAccessMode,
} from '../lib/collaboration-access';
import { createId } from '../lib/id';
import { reindexNoteLinks, resolveUnresolvedNoteLinks } from '../notes/links';
import { compactNoteSelection } from '../notes/listing';
import { buildLiteralFtsPrefixQuery } from '../notes/search';
import { normalizeTagName } from '../notes/tags';
import { createNoteVersion, maybeCreateUserCheckpoint } from '../notes/versions';
import { activeFolderWhere, activeNoteWhere } from '../trash/policy';
import { applyDocumentEdits, type DocumentEdit } from './edits';
import { hashMarkdown } from './hash';
import { getLineRange, searchLines } from './line-search';
import { encodeCursor, type PageInfo } from './pagination';

export const MAX_SEARCH_QUERY_LENGTH = 200;

export type NoteSearchCursor = {
  rank: number;
  updatedAt: string;
  title: string;
  id: string;
};

export type ActorType = 'user' | 'agent' | 'system';
export type NoteEventType =
  | 'create'
  | 'update'
  | 'edit_patch'
  | 'move'
  | 'toggle_api_editable'
  | 'restore'
  | 'trash'
  | 'restore_from_trash';

export type DocumentCommandResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400; error: string }
  | { ok: false; status: 403; error: string }
  | { ok: false; status: 404; error: string }
  | { ok: false; status: 409; error: string; currentHash: string };

export async function listFolders(input: { userId: string }) {
  const rows = await db.select().from(folders).where(activeFolderWhere(input.userId)).orderBy(asc(folders.title));
  return { ok: true, value: { folders: rows } } satisfies DocumentCommandResult<{ folders: typeof rows }>;
}

export type NoteType = 'note' | 'template';
export type DocumentType = 'markdown' | 'canvas.default' | 'canvas.mindmap';

export function isCanvasDocumentType(documentType: string) {
  return documentType.startsWith('canvas.');
}

export function normalizeCanvasDocument(value: unknown): JsonCanvasDocument | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<JsonCanvasDocument>;
  if (!Array.isArray(candidate.nodes) || !Array.isArray(candidate.edges)) return null;
  return { nodes: candidate.nodes, edges: candidate.edges } as JsonCanvasDocument;
}

export function parseCanvasDocumentJson(content: string): JsonCanvasDocument | null {
  try {
    return normalizeCanvasDocument(JSON.parse(content));
  } catch {
    return null;
  }
}

export function serializeCanvasDocument(value: unknown): string | null {
  const canvas = normalizeCanvasDocument(value);
  return canvas ? JSON.stringify(canvas) : null;
}

export function emptyCanvasDocument(documentType: DocumentType = 'canvas.default') {
  return JSON.stringify(
    documentType === 'canvas.mindmap' ? createDefaultMindMapDocument({ rootId: 'Root' }) : createDefaultCanvasDocument()
  );
}

export type CanvasSyntaxFormat = 'auto' | 'minu' | 'mermaid';

export function isCanvasSyntaxFormat(value: unknown): value is CanvasSyntaxFormat {
  return value === 'auto' || value === 'minu' || value === 'mermaid';
}

function detectCanvasSyntaxFormat(syntax: string): Exclude<CanvasSyntaxFormat, 'auto'> {
  for (const line of syntax.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('%%{')) return 'mermaid';
    if (trimmed.startsWith('%%')) continue;

    const header = /^(?:flowchart|graph)\b(.*)$/i.exec(trimmed);
    if (!header) return 'minu';

    const remainder = header[1].trim();
    if (!remainder || /^(?:>|-->|\[)/.test(remainder)) return 'minu';
    return 'mermaid';
  }
  return 'minu';
}

export function compileDiagramSyntax(input: { syntax: string; documentType?: DocumentType }) {
  const result = compileMinuDiagramSyntax(input.syntax, {
    strict: true,
    ...(input.documentType === 'canvas.mindmap' ? { layout: 'mindmap' as const } : {}),
  });
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  if (errors.length > 0) return { ok: false as const, errors: result.diagnostics };
  const documentType: DocumentType =
    input.documentType ?? (result.parsed.layout === 'mindmap' ? 'canvas.mindmap' : 'canvas.default');
  return {
    ok: true as const,
    document: result.document,
    documentType,
    diagnostics: result.diagnostics,
    title: result.parsed.title,
  };
}

export async function listDocuments(input: {
  userId: string;
  folderId?: string;
  type?: NoteType;
  offset?: number;
  limit?: number;
}) {
  const type = input.type ?? 'note';
  const where = input.folderId
    ? activeNoteWhere(input.userId, eq(notes.folderId, input.folderId), eq(notes.type, type))
    : activeNoteWhere(input.userId, eq(notes.type, type));
  const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
  const rows = await db
    .select(compactNoteSelection)
    .from(notes)
    .where(where)
    .orderBy(desc(notes.updatedAt), asc(notes.title), asc(notes.id))
    .limit(limit + 1)
    .offset(Math.max(0, input.offset ?? 0));
  const hasMore = rows.length > limit;
  return {
    ok: true,
    value: { documents: hasMore ? rows.slice(0, limit) : rows, hasMore },
  } satisfies DocumentCommandResult<{ documents: typeof rows; hasMore: boolean }>;
}

export async function listNoteEvents(input: { documentId: string; userId: string; limit?: number }) {
  const current = await readDocument({ documentId: input.documentId, userId: input.userId });
  if (!current.ok) return current;

  const events = await db
    .select()
    .from(noteEvents)
    .where(and(eq(noteEvents.noteId, input.documentId), eq(noteEvents.userId, input.userId)))
    .orderBy(desc(noteEvents.createdAt))
    .limit(input.limit ?? 50);

  return { ok: true, value: { noteId: current.value.note.id, events } } satisfies DocumentCommandResult<{
    noteId: string;
    events: typeof events;
  }>;
}

export async function readDocumentLines(input: { documentId: string; userId: string; from?: number; to?: number }) {
  const current = await readDocument({ documentId: input.documentId, userId: input.userId });
  if (!current.ok) return current;

  const range = getLineRange(current.value.note.content, input.from ?? 1, input.to ?? 80);
  return {
    ok: true,
    value: {
      noteId: current.value.note.id,
      contentHash: current.value.contentHash,
      noteSizeBytes: new TextEncoder().encode(current.value.note.content).length,
      ...range,
    },
  } satisfies DocumentCommandResult<{
    noteId: string;
    contentHash: string;
    noteSizeBytes: number;
    from: number;
    to: number;
    lineCount: number;
    lines: ReturnType<typeof getLineRange>['lines'];
  }>;
}

export async function searchDocumentLines(input: {
  documentId: string;
  userId: string;
  query: string;
  context?: number;
  limit?: number;
  caseSensitive?: boolean;
}) {
  const current = await readDocument({ documentId: input.documentId, userId: input.userId });
  if (!current.ok) return current;

  const result = searchLines(current.value.note.content, input);
  return {
    ok: true,
    value: {
      noteId: current.value.note.id,
      title: current.value.note.title,
      folderId: current.value.note.folderId,
      contentHash: current.value.contentHash,
      noteSizeBytes: new TextEncoder().encode(current.value.note.content).length,
      ...result,
    },
  } satisfies DocumentCommandResult<{
    noteId: string;
    title: string;
    folderId: string;
    contentHash: string;
    noteSizeBytes: number;
    lineCount: number;
    matches: ReturnType<typeof searchLines>['matches'];
  }>;
}

export type LineSearchCursor = {
  noteUpdatedAt: string;
  title: string;
  noteId: string;
  line: number;
  column: number;
};

export async function searchAllDocumentLines(input: {
  userId: string;
  query: string;
  folderId?: string;
  folderIds?: Set<string> | null;
  context?: number;
  limit?: number;
  caseSensitive?: boolean;
  cursor?: LineSearchCursor | null;
  cursorScope?: string;
  integrationAccess?: { authorizationId: string; sharedAccessMode: SharedAccessMode };
}) {
  const query = input.query.trim();
  if (!query)
    return {
      ok: true,
      value: { query, matches: [], accessResources: [], pageInfo: { hasMore: false, nextCursor: null } },
    } as const;
  if (!input.integrationAccess && input.folderIds && input.folderIds.size === 0)
    return {
      ok: true,
      value: { query, matches: [], accessResources: [], pageInfo: { hasMore: false, nextCursor: null } },
    } as const;

  const pattern = `%${query}%`;
  const contentSearchMatch = input.caseSensitive
    ? sql<boolean>`instr(${notes.content}, ${query}) > 0`
    : like(notes.content, pattern);
  const where = input.integrationAccess
    ? integrationAccessibleNoteWhere(
        {
          actorUserId: input.userId,
          authorizationId: input.integrationAccess.authorizationId,
          sharedAccessMode: input.integrationAccess.sharedAccessMode,
          ownedFolderIds: input.folderIds ?? new Set(),
        },
        input.folderId ? and(eq(notes.userId, input.userId), eq(notes.folderId, input.folderId)) : undefined,
        contentSearchMatch
      )
    : input.folderId
      ? activeNoteWhere(input.userId, eq(notes.folderId, input.folderId), contentSearchMatch)
      : activeNoteWhere(input.userId, contentSearchMatch);
  const cursor = input.cursor;
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
  const noteBatchSize = 25;
  const matches: Array<
    ReturnType<typeof searchLines>['matches'][number] & {
      noteId: string;
      title: string;
      folderId: string;
      userId: string;
      noteUpdatedAt: string;
    }
  > = [];
  let notePosition = cursor
    ? { updatedAt: new Date(cursor.noteUpdatedAt), title: cursor.title, id: cursor.noteId }
    : null;
  let includePositionNote = Boolean(cursor);

  while (matches.length < limit + 1) {
    const afterNotePosition = notePosition
      ? or(
          includePositionNote ? eq(notes.id, notePosition.id) : undefined,
          lt(notes.updatedAt, notePosition.updatedAt),
          and(eq(notes.updatedAt, notePosition.updatedAt), gt(notes.title, notePosition.title)),
          and(
            eq(notes.updatedAt, notePosition.updatedAt),
            eq(notes.title, notePosition.title),
            gt(notes.id, notePosition.id)
          )
        )
      : undefined;
    const rows = await db
      .select({
        id: notes.id,
        folderId: notes.folderId,
        userId: notes.userId,
        title: notes.title,
        content: notes.content,
        updatedAt: notes.updatedAt,
      })
      .from(notes)
      .where(
        and(
          where,
          input.integrationAccess
            ? undefined
            : input.folderIds
              ? inArray(notes.folderId, [...input.folderIds])
              : undefined,
          afterNotePosition
        )
      )
      .orderBy(desc(notes.updatedAt), asc(notes.title), asc(notes.id))
      .limit(noteBatchSize);
    if (rows.length === 0) break;

    for (const note of rows) {
      const noteUpdatedAt = note.updatedAt.toISOString();
      const sameNote = Boolean(cursor && note.id === cursor.noteId);
      const result = searchLines(note.content, {
        query,
        context: input.context,
        limit: limit + 1 - matches.length,
        caseSensitive: input.caseSensitive,
        after: sameNote && cursor ? { line: cursor.line, column: cursor.column } : undefined,
      });
      matches.push(
        ...result.matches.map((match) => ({
          ...match,
          noteId: note.id,
          title: note.title,
          folderId: note.folderId,
          userId: note.userId,
          noteUpdatedAt,
        }))
      );
      if (matches.length >= limit + 1) break;
    }

    if (matches.length >= limit + 1 || rows.length < noteBatchSize) break;
    const lastNote = rows.at(-1);
    if (!lastNote) break;
    notePosition = { updatedAt: lastNote.updatedAt, title: lastNote.title, id: lastNote.id };
    includePositionNote = false;
  }

  const hasMore = matches.length > limit;
  const visibleMatches = hasMore ? matches.slice(0, limit) : matches;
  const last = visibleMatches[visibleMatches.length - 1];
  const accessResources = [
    ...new Map(
      visibleMatches.map((match) => [
        match.noteId,
        { id: match.noteId, folderId: match.folderId, userId: match.userId },
      ])
    ).values(),
  ];
  return {
    ok: true,
    value: {
      query,
      matches: visibleMatches.map(({ noteUpdatedAt: _noteUpdatedAt, userId: _userId, ...match }) => match),
      accessResources,
      pageInfo: {
        hasMore,
        nextCursor:
          hasMore && last && input.cursorScope
            ? encodeCursor(input.cursorScope, {
                noteUpdatedAt: last.noteUpdatedAt,
                title: last.title,
                noteId: last.noteId,
                line: last.line,
                column: last.column,
              })
            : null,
      },
    },
  } as const;
}

export async function searchDocuments(input: {
  userId: string;
  query: string;
  limit?: number;
  type?: NoteType;
  tag?: string;
  folderIds?: Set<string> | null;
  cursor?: NoteSearchCursor | null;
  cursorScope?: string;
  offset?: number;
  includeCollaborations?: boolean;
  discoveryScope?: 'all' | 'mine' | 'shared';
  integrationAccess?: { authorizationId: string; sharedAccessMode: SharedAccessMode };
}) {
  const query = input.query.trim();
  if (!query) return { ok: true, value: { documents: [], pageInfo: { hasMore: false, nextCursor: null } } } as const;
  if (!input.integrationAccess && input.folderIds && input.folderIds.size === 0)
    return { ok: true, value: { documents: [], pageInfo: { hasMore: false, nextCursor: null } } } as const;

  const pattern = `%${query}%`;
  const prefixPattern = `${query}%`;
  const ftsQuery = buildLiteralFtsPrefixQuery(query);
  const indexedContentSearchMatch = sql<boolean>`${notes.id} in (
    select indexed_document.note_id
    from note_search_fts
    inner join note_search_documents as indexed_document on indexed_document.id = note_search_fts.rowid
    where note_search_fts match ${ftsQuery}
  )`;
  const type = input.type ?? 'note';
  const tagName = input.tag ? normalizeTagName(input.tag) : '';
  if (input.tag && !tagName)
    return { ok: true, value: { documents: [], pageInfo: { hasMore: false, nextCursor: null } } } as const;

  const tagSearchMatch = sql<boolean>`exists (
    select 1 from ${noteTags}
    inner join ${tags} on ${tags.id} = ${noteTags.tagId}
    where ${noteTags.noteId} = ${notes.id}
      and ${noteTags.userId} = ${notes.userId}
      and lower(${tags.name}) like lower(${pattern})
  )`;
  const exactTagMatch = tagName
    ? sql<boolean>`exists (
        select 1 from ${noteTags}
        inner join ${tags} on ${tags.id} = ${noteTags.tagId}
        where ${noteTags.noteId} = ${notes.id}
          and ${noteTags.userId} = ${notes.userId}
          and ${tags.normalizedName} = ${tagName}
      )`
    : undefined;
  const includesCollaborations =
    input.includeCollaborations || input.discoveryScope === 'all' || input.discoveryScope === 'shared';
  const folderTitleSearchMatch =
    includesCollaborations || input.integrationAccess
      ? and(eq(notes.userId, input.userId), like(folders.title, pattern))
      : like(folders.title, pattern);
  const searchRank = sql<number>`case
    when lower(${notes.title}) = lower(${query}) then 0
    when lower(${notes.title}) like lower(${prefixPattern}) then 1
    when lower(${notes.title}) like lower(${pattern}) then 2
    when ${tagSearchMatch} then 3
    when ${folderTitleSearchMatch} then 4
    else 5
  end`;
  const afterCursor = input.cursor
    ? or(
        gt(searchRank, input.cursor.rank),
        and(eq(searchRank, input.cursor.rank), lt(notes.updatedAt, new Date(input.cursor.updatedAt))),
        and(
          eq(searchRank, input.cursor.rank),
          eq(notes.updatedAt, new Date(input.cursor.updatedAt)),
          gt(notes.title, input.cursor.title)
        ),
        and(
          eq(searchRank, input.cursor.rank),
          eq(notes.updatedAt, new Date(input.cursor.updatedAt)),
          eq(notes.title, input.cursor.title),
          gt(notes.id, input.cursor.id)
        )
      )
    : undefined;
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
  const rows = await db
    .select({
      id: notes.id,
      folderId: notes.folderId,
      userId: notes.userId,
      title: notes.title,
      documentType: notes.documentType,
      type: notes.type,
      isApiEditable: notes.isApiEditable,
      createdAt: notes.createdAt,
      updatedAt: notes.updatedAt,
      folderTitle: folders.title,
      searchRank,
    })
    .from(notes)
    .innerJoin(folders, and(eq(notes.folderId, folders.id), eq(folders.userId, notes.userId)))
    .where(
      and(
        input.integrationAccess
          ? integrationAccessibleNoteWhere({
              actorUserId: input.userId,
              authorizationId: input.integrationAccess.authorizationId,
              sharedAccessMode: input.integrationAccess.sharedAccessMode,
              ownedFolderIds: input.folderIds ?? new Set(),
            })
          : input.discoveryScope === 'shared'
            ? collaborationAccessibleNoteWhere(input.userId, 'read', sql`${notes.userId} <> ${input.userId}`)
            : includesCollaborations
              ? collaborationAccessibleNoteWhere(input.userId)
              : activeNoteWhere(input.userId),
        eq(notes.type, type),
        input.integrationAccess
          ? undefined
          : input.folderIds
            ? inArray(notes.folderId, [...input.folderIds])
            : undefined,
        exactTagMatch,
        or(like(notes.title, pattern), indexedContentSearchMatch, folderTitleSearchMatch, tagSearchMatch),
        afterCursor
      )
    )
    .orderBy(searchRank, desc(notes.updatedAt), asc(notes.title), asc(notes.id))
    .limit(limit + 1)
    .offset(Math.max(0, input.offset ?? 0));

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  const documents = pageRows.map(({ searchRank: _searchRank, ...document }) => document);
  const pageInfo: PageInfo = {
    hasMore,
    nextCursor:
      hasMore && last && input.cursorScope
        ? encodeCursor(input.cursorScope, {
            rank: Number(last.searchRank),
            updatedAt: last.updatedAt.toISOString(),
            title: last.title,
            id: last.id,
          })
        : null,
  };

  return { ok: true, value: { documents, pageInfo } } as const;
}

export function getUpdateEventType(
  input: Pick<UpdateDocumentInput, 'title' | 'markdown' | 'folderId' | 'isApiEditable' | 'documentType'>,
  current: Pick<Note, 'title' | 'content' | 'folderId' | 'isApiEditable' | 'documentType'>
): NoteEventType {
  if (
    input.folderId !== undefined &&
    input.folderId !== current.folderId &&
    input.title === undefined &&
    input.markdown === undefined &&
    input.isApiEditable === undefined &&
    input.documentType === undefined
  ) {
    return 'move';
  }

  if (
    input.isApiEditable !== undefined &&
    input.isApiEditable !== current.isApiEditable &&
    input.title === undefined &&
    input.markdown === undefined &&
    input.folderId === undefined &&
    input.documentType === undefined
  ) {
    return 'toggle_api_editable';
  }

  return 'update';
}

export function getNoteEventSummary(
  eventType: NoteEventType,
  details: {
    titleChanged?: boolean;
    contentChanged?: boolean;
    folderChanged?: boolean;
    isApiEditableChanged?: boolean;
    documentTypeChanged?: boolean;
    isApiEditable?: boolean;
  }
) {
  if (eventType === 'create') return 'Created note';
  if (eventType === 'edit_patch') return 'Patched note content';
  if (eventType === 'move') return 'Moved note to another folder';
  if (eventType === 'restore') return 'Restored note version';
  if (eventType === 'trash') return 'Moved note to Trash';
  if (eventType === 'restore_from_trash') return 'Restored note from Trash';
  if (eventType === 'toggle_api_editable')
    return details.isApiEditable ? 'Enabled API editing' : 'Disabled API editing';

  const changed = [
    details.titleChanged ? 'title' : null,
    details.contentChanged ? 'content' : null,
    details.folderChanged ? 'folder' : null,
    details.isApiEditableChanged ? 'API editability' : null,
    details.documentTypeChanged ? 'document type' : null,
  ].filter(Boolean);

  return changed.length > 0 ? `Updated ${changed.join(', ')}` : 'Updated note';
}

async function insertNoteEvent(input: {
  noteId: string;
  userId: string;
  actorType: ActorType;
  actorId?: string;
  eventType: NoteEventType;
  summary: string;
  beforeHash?: string;
  afterHash?: string;
}) {
  const now = new Date();
  const shouldCoalesce =
    input.actorType === 'user' && (input.eventType === 'update' || input.eventType === 'edit_patch');
  if (shouldCoalesce) {
    const cutoff = new Date(now.getTime() - 10 * 60 * 1000);
    const [recent] = await db
      .select()
      .from(noteEvents)
      .where(
        and(
          eq(noteEvents.noteId, input.noteId),
          eq(noteEvents.userId, input.userId),
          eq(noteEvents.actorType, 'user'),
          input.actorId ? eq(noteEvents.actorId, input.actorId) : isNull(noteEvents.actorId),
          inArray(noteEvents.eventType, ['update', 'edit_patch']),
          gt(noteEvents.createdAt, cutoff)
        )
      )
      .orderBy(desc(noteEvents.createdAt))
      .limit(1);

    if (recent) {
      await db
        .update(noteEvents)
        .set({
          eventType: input.eventType,
          summary: input.summary,
          afterHash: input.afterHash,
          createdAt: now,
        })
        .where(eq(noteEvents.id, recent.id));
      return;
    }
  }

  await db.insert(noteEvents).values({
    id: createId('note_event'),
    noteId: input.noteId,
    userId: input.userId,
    actorType: input.actorType,
    actorId: input.actorId,
    eventType: input.eventType,
    summary: input.summary,
    beforeHash: input.beforeHash,
    afterHash: input.afterHash,
    createdAt: now,
  });
}

export async function createDocument(input: {
  userId: string;
  creatorUserId: string;
  folderId: string;
  title?: string;
  markdown?: string;
  actorType?: ActorType;
  actorId?: string;
  type?: NoteType;
  documentType?: DocumentType;
}) {
  const [folder] = await db
    .select()
    .from(folders)
    .where(activeFolderWhere(input.userId, eq(folders.id, input.folderId)))
    .limit(1);
  if (!folder) return { ok: false, status: 404, error: 'Folder not found' } satisfies DocumentCommandResult<never>;

  const documentType = input.documentType ?? 'markdown';
  let content = input.markdown ?? (documentType.startsWith('canvas.') ? emptyCanvasDocument(documentType) : '');
  if (documentType.startsWith('canvas.')) {
    const canvas = parseCanvasDocumentJson(content);
    if (!canvas)
      return {
        ok: false,
        status: 400,
        error: 'Canvas content must be JSON with nodes and edges arrays',
      } satisfies DocumentCommandResult<never>;
    content = JSON.stringify(canvas);
  }
  const title =
    input.title?.trim() ||
    (documentType === 'canvas.mindmap'
      ? 'Untitled mind map'
      : documentType.startsWith('canvas.')
        ? 'Untitled canvas'
        : 'Untitled note');
  const note = {
    id: createId('note'),
    folderId: input.folderId,
    userId: input.userId,
    createdByUserId: input.creatorUserId,
    title,
    content,
    documentType,
    type: input.type ?? 'note',
    updatedByActorType: input.actorType ?? 'user',
    updatedByActorId: input.actorId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await db.insert(notes).values(note);
  if (note.documentType === 'markdown' && note.content.includes('/internal/attachments/')) {
    await syncNoteAttachmentReferences({ noteId: note.id, userId: note.userId, markdown: note.content });
  }
  await reindexNoteLinks({
    noteId: note.id,
    userId: note.userId,
    markdown: note.content,
    documentType: note.documentType,
  });
  if (note.documentType === 'markdown') {
    await resolveUnresolvedNoteLinks({ noteId: note.id, userId: note.userId, title: note.title });
  }

  const contentHash = hashMarkdown(note.content);
  await createNoteVersion({
    note: note as Note,
    reason: 'create',
    actorType: note.updatedByActorType ?? 'user',
    actorId: note.updatedByActorId,
  });
  await insertNoteEvent({
    noteId: note.id,
    userId: note.userId,
    actorType: note.updatedByActorType ?? 'user',
    actorId: note.updatedByActorId ?? undefined,
    eventType: 'create',
    summary: getNoteEventSummary('create', {}),
    afterHash: contentHash,
  });

  return { ok: true, value: { note, contentHash } } satisfies DocumentCommandResult<{
    note: typeof note;
    contentHash: string;
  }>;
}

export async function readDocument(input: { documentId: string; userId: string }) {
  const [note] = await db
    .select()
    .from(notes)
    .where(activeNoteWhere(input.userId, eq(notes.id, input.documentId)))
    .limit(1);
  if (!note) return { ok: false, status: 404, error: 'Note not found' } satisfies DocumentCommandResult<never>;

  return {
    ok: true,
    value: { note, contentHash: hashMarkdown(note.content) },
  } satisfies DocumentCommandResult<{ note: typeof note; contentHash: string }>;
}

export const MAX_MOVE_DOCUMENTS = 100;
const MAX_VERSIONS_PER_NOTE = 100;
const USER_CHECKPOINT_INTERVAL_MS = 10 * 60 * 1000;
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

class MoveDocumentsTransactionError extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    message: string
  ) {
    super(message);
  }
}

function hashVersionState(
  note: Pick<Note, 'title' | 'content' | 'documentType' | 'folderId' | 'createdAt' | 'isApiEditable'>
) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        title: note.title,
        content: note.content,
        documentType: note.documentType,
        folderId: note.folderId,
        createdAt: note.createdAt.toISOString(),
        isApiEditable: note.isApiEditable,
      })
    )
    .digest('hex');
}

async function createMoveVersion(
  tx: DbTransaction,
  input: {
    note: Note;
    reason: 'autosave_checkpoint' | 'before_agent_edit';
    actorType: 'user' | 'agent';
    actorId?: string;
  }
) {
  const stateHash = hashVersionState(input.note);
  const [latest] = await tx
    .select()
    .from(noteVersions)
    .where(and(eq(noteVersions.userId, input.note.userId), eq(noteVersions.noteId, input.note.id)))
    .orderBy(desc(noteVersions.createdAt))
    .limit(1);
  if (latest?.stateHash === stateHash) return;

  await tx.insert(noteVersions).values({
    id: createId('note_version'),
    userId: input.note.userId,
    noteId: input.note.id,
    title: input.note.title,
    content: input.note.content,
    documentType: input.note.documentType,
    folderId: input.note.folderId,
    createdAtValue: input.note.createdAt,
    isApiEditable: input.note.isApiEditable,
    stateHash,
    reason: input.reason,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    createdAt: new Date(),
  });

  const excess = await tx
    .select({ id: noteVersions.id })
    .from(noteVersions)
    .where(and(eq(noteVersions.userId, input.note.userId), eq(noteVersions.noteId, input.note.id)))
    .orderBy(desc(noteVersions.createdAt))
    .limit(10_000)
    .offset(MAX_VERSIONS_PER_NOTE);
  if (excess.length > 0)
    await tx.delete(noteVersions).where(
      inArray(
        noteVersions.id,
        excess.map((row) => row.id)
      )
    );
}

async function maybeCreateMoveUserCheckpoint(tx: DbTransaction, input: { note: Note; actorId?: string }) {
  const [latest] = await tx
    .select()
    .from(noteVersions)
    .where(and(eq(noteVersions.userId, input.note.userId), eq(noteVersions.noteId, input.note.id)))
    .orderBy(desc(noteVersions.createdAt))
    .limit(1);
  if (latest && Date.now() - latest.createdAt.getTime() < USER_CHECKPOINT_INTERVAL_MS) return;
  await createMoveVersion(tx, {
    note: input.note,
    reason: 'autosave_checkpoint',
    actorType: 'user',
    actorId: input.actorId,
  });
}

export async function moveDocuments(input: {
  documentIds: string[];
  targetFolderId: string;
  userId: string;
  actorType?: ActorType;
  actorId?: string;
}) {
  const documentIds = [...new Set(input.documentIds.map((id) => id.trim()).filter(Boolean))];
  if (documentIds.length === 0)
    return { ok: false, status: 400, error: 'At least one note id is required' } satisfies DocumentCommandResult<never>;
  if (documentIds.length > MAX_MOVE_DOCUMENTS)
    return {
      ok: false,
      status: 400,
      error: `Cannot move more than ${MAX_MOVE_DOCUMENTS} notes at once`,
    } satisfies DocumentCommandResult<never>;

  const [targetFolder] = await db
    .select({ id: folders.id })
    .from(folders)
    .where(activeFolderWhere(input.userId, eq(folders.id, input.targetFolderId)))
    .limit(1);
  if (!targetFolder)
    return { ok: false, status: 404, error: 'Destination folder not found' } satisfies DocumentCommandResult<never>;

  const currentNotes = await db
    .select()
    .from(notes)
    .where(activeNoteWhere(input.userId, inArray(notes.id, documentIds)));
  if (currentNotes.length !== documentIds.length)
    return { ok: false, status: 404, error: 'One or more notes were not found' } satisfies DocumentCommandResult<never>;

  if (input.actorType === 'agent') {
    if (currentNotes.some((note) => note.type === 'template'))
      return {
        ok: false,
        status: 403,
        error: 'Templates cannot be moved through the API',
      } satisfies DocumentCommandResult<never>;
    if (currentNotes.some((note) => !note.isApiEditable))
      return {
        ok: false,
        status: 403,
        error: 'One or more notes are not editable through the API',
      } satisfies DocumentCommandResult<never>;
  }

  const noteById = new Map(currentNotes.map((note) => [note.id, note]));
  const orderedNotes = documentIds
    .map((documentId) => noteById.get(documentId))
    .filter((note): note is Note => Boolean(note));

  try {
    const moved = await db.transaction(async (tx) => {
      const results = [] as Array<{ note: Note; contentHash: string }>;
      for (const currentNote of orderedNotes) {
        const folderChanged = currentNote.folderId !== input.targetFolderId;
        const actorType = input.actorType ?? 'user';
        const beforeHash = hashMarkdown(currentNote.content);
        if (folderChanged && input.actorType === 'agent') {
          await createMoveVersion(tx, {
            note: currentNote,
            reason: 'before_agent_edit',
            actorType: 'agent',
            actorId: input.actorId,
          });
        } else if (folderChanged && actorType === 'user') {
          await maybeCreateMoveUserCheckpoint(tx, { note: currentNote, actorId: input.actorId });
        }

        const [note] = await tx
          .update(notes)
          .set({
            folderId: input.targetFolderId,
            updatedByActorType: actorType,
            updatedByActorId: input.actorId,
            updatedAt: new Date(),
          })
          .where(and(eq(notes.id, currentNote.id), eq(notes.userId, input.userId)))
          .returning();
        if (!note) throw new MoveDocumentsTransactionError(404, 'Note not found');

        const contentHash = hashMarkdown(note.content);
        if (folderChanged) {
          await tx.insert(noteEvents).values({
            id: createId('note_event'),
            noteId: note.id,
            userId: note.userId,
            actorType,
            actorId: input.actorId,
            eventType: 'move',
            summary: 'Moved note to another folder',
            beforeHash,
            afterHash: contentHash,
            createdAt: new Date(),
          });
        }
        results.push({ note, contentHash });
      }
      return results;
    });

    return { ok: true, value: { notes: moved } } satisfies DocumentCommandResult<{
      notes: Array<{ note: Note; contentHash: string }>;
    }>;
  } catch (error) {
    if (error instanceof MoveDocumentsTransactionError)
      return { ok: false, status: error.status, error: error.message } satisfies DocumentCommandResult<never>;
    throw error;
  }
}

export interface UpdateDocumentInput {
  documentId: string;
  userId: string;
  title?: string;
  markdown?: string;
  folderId?: string;
  isApiEditable?: boolean;
  documentType?: DocumentType;
  createdAt?: Date;
  baseHash?: string;
  actorType?: ActorType;
  actorId?: string;
  eventType?: NoteEventType;
}

export async function updateDocument(input: UpdateDocumentInput) {
  const current = await readDocument({ documentId: input.documentId, userId: input.userId });
  if (!current.ok) return current;

  const currentHash = current.value.contentHash;
  const isApiMutation =
    input.actorType === 'agent' &&
    (input.title !== undefined ||
      input.markdown !== undefined ||
      input.folderId !== undefined ||
      input.isApiEditable !== undefined ||
      input.documentType !== undefined ||
      input.createdAt !== undefined);
  if (isApiMutation && current.value.note.type === 'template') {
    return {
      ok: false,
      status: 403,
      error: 'Templates cannot be edited through the API',
    } satisfies DocumentCommandResult<never>;
  }
  if (isApiMutation && !current.value.note.isApiEditable) {
    return {
      ok: false,
      status: 403,
      error: 'Document is not editable through the API',
    } satisfies DocumentCommandResult<never>;
  }

  if (input.baseHash && input.baseHash !== currentHash) {
    return {
      ok: false,
      status: 409,
      error: 'Document has changed since it was read',
      currentHash,
    } satisfies DocumentCommandResult<never>;
  }

  if (input.folderId !== undefined) {
    const [folder] = await db
      .select()
      .from(folders)
      .where(activeFolderWhere(input.userId, eq(folders.id, input.folderId)))
      .limit(1);
    if (!folder)
      return { ok: false, status: 404, error: 'Destination folder not found' } satisfies DocumentCommandResult<never>;
  }

  const nextDocumentType = input.documentType ?? current.value.note.documentType;
  let nextContent = input.markdown;
  if (nextContent !== undefined && nextDocumentType.startsWith('canvas.')) {
    const canvas = parseCanvasDocumentJson(nextContent);
    if (!canvas)
      return {
        ok: false,
        status: 400,
        error: 'Canvas content must be JSON with nodes and edges arrays',
      } satisfies DocumentCommandResult<never>;
    nextContent = JSON.stringify(canvas);
  }

  const titleChanged = input.title !== undefined && input.title !== current.value.note.title;
  const contentChanged = nextContent !== undefined && nextContent !== current.value.note.content;
  const folderChanged = input.folderId !== undefined && input.folderId !== current.value.note.folderId;
  const isApiEditableChanged =
    input.isApiEditable !== undefined && input.isApiEditable !== current.value.note.isApiEditable;
  const documentTypeChanged =
    input.documentType !== undefined && input.documentType !== current.value.note.documentType;
  const createdAtChanged =
    input.createdAt !== undefined && input.createdAt.getTime() !== current.value.note.createdAt.getTime();

  const stateChanged =
    titleChanged || contentChanged || folderChanged || isApiEditableChanged || documentTypeChanged || createdAtChanged;
  if (stateChanged && input.actorType === 'agent') {
    await createNoteVersion({
      note: current.value.note,
      reason: 'before_agent_edit',
      actorType: 'agent',
      actorId: input.actorId,
    });
  } else if (stateChanged && (input.actorType ?? 'user') === 'user') {
    await maybeCreateUserCheckpoint({ note: current.value.note, actorId: input.actorId });
  }

  const [note] = await db
    .update(notes)
    .set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(nextContent !== undefined ? { content: nextContent } : {}),
      ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
      ...(input.isApiEditable !== undefined ? { isApiEditable: input.isApiEditable } : {}),
      ...(input.documentType !== undefined ? { documentType: input.documentType } : {}),
      ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
      updatedByActorType: input.actorType ?? 'user',
      updatedByActorId: input.actorId,
      updatedAt: new Date(),
    })
    .where(and(eq(notes.id, input.documentId), eq(notes.userId, input.userId)))
    .returning();

  if (!note) return { ok: false, status: 404, error: 'Note not found' } satisfies DocumentCommandResult<never>;

  if (contentChanged || documentTypeChanged) {
    await syncNoteAttachmentReferences({
      noteId: note.id,
      userId: note.userId,
      markdown: note.documentType === 'markdown' ? note.content : '',
    });
    await reindexNoteLinks({
      noteId: note.id,
      userId: note.userId,
      markdown: note.content,
      documentType: note.documentType,
    });
  }
  if (titleChanged && note.documentType === 'markdown')
    await resolveUnresolvedNoteLinks({ noteId: note.id, userId: note.userId, title: note.title });

  const contentHash = hashMarkdown(note.content);
  const actorType = input.actorType ?? 'user';
  if (stateChanged) {
    const eventType = input.eventType ?? getUpdateEventType(input, current.value.note);
    await insertNoteEvent({
      noteId: note.id,
      userId: note.userId,
      actorType,
      actorId: input.actorId,
      eventType,
      summary: getNoteEventSummary(eventType, {
        titleChanged,
        contentChanged,
        folderChanged,
        isApiEditableChanged,
        documentTypeChanged,
        isApiEditable: note.isApiEditable,
      }),
      beforeHash: currentHash,
      afterHash: contentHash,
    });
  }

  return { ok: true, value: { note, contentHash } } satisfies DocumentCommandResult<{
    note: typeof note;
    contentHash: string;
  }>;
}

export async function linkCanvasNodeToNote(
  input: Omit<UpdateDocumentInput, 'markdown' | 'documentType'> & { nodeId: string; targetNoteId: string }
) {
  const current = await readDocument({ documentId: input.documentId, userId: input.userId });
  if (!current.ok) return current;
  if (!current.value.note.documentType.startsWith('canvas.'))
    return {
      ok: false,
      status: 400,
      error: 'Canvas operations are only supported for canvas notes',
    } satisfies DocumentCommandResult<never>;
  if (input.targetNoteId === input.documentId)
    return {
      ok: false,
      status: 400,
      error: 'A canvas cannot link to itself',
    } satisfies DocumentCommandResult<never>;

  const [target] = await db
    .select({ id: notes.id, title: notes.title })
    .from(notes)
    .where(activeNoteWhere(input.userId, eq(notes.id, input.targetNoteId), eq(notes.type, 'note')))
    .limit(1);
  if (!target) return { ok: false, status: 404, error: 'Target note not found' } satisfies DocumentCommandResult<never>;

  const canvas = parseCanvasDocumentJson(current.value.note.content) as JsonCanvasDocument<MinuNotesNodeExtra> | null;
  if (!canvas)
    return {
      ok: false,
      status: 400,
      error: 'Canvas content must include nodes and edges arrays',
    } satisfies DocumentCommandResult<never>;

  let found = false;
  const nextCanvas: JsonCanvasDocument<MinuNotesNodeExtra> = {
    ...canvas,
    nodes: canvas.nodes.map((node) => {
      if (node.id !== input.nodeId) return node;
      found = true;
      const currentMetadata =
        node.minunotes && typeof node.minunotes === 'object' ? node.minunotes : ({} satisfies MinuNotesNodeMetadata);
      return {
        ...node,
        text: node.text?.trim() ? node.text : target.title,
        minunotes: {
          ...currentMetadata,
          link: { type: 'note', id: target.id },
        },
      };
    }),
  };
  if (!found) return { ok: false, status: 404, error: 'Canvas node not found' } satisfies DocumentCommandResult<never>;

  return replaceCanvasDocument({
    documentId: input.documentId,
    userId: input.userId,
    title: input.title,
    canvas: nextCanvas,
    baseHash: input.baseHash,
    actorType: input.actorType,
    actorId: input.actorId,
  });
}

export async function unlinkCanvasNode(
  input: Omit<UpdateDocumentInput, 'markdown' | 'documentType'> & { nodeId: string }
) {
  const current = await readDocument({ documentId: input.documentId, userId: input.userId });
  if (!current.ok) return current;
  if (!current.value.note.documentType.startsWith('canvas.'))
    return {
      ok: false,
      status: 400,
      error: 'Canvas operations are only supported for canvas notes',
    } satisfies DocumentCommandResult<never>;

  const canvas = parseCanvasDocumentJson(current.value.note.content) as JsonCanvasDocument<MinuNotesNodeExtra> | null;
  if (!canvas)
    return {
      ok: false,
      status: 400,
      error: 'Canvas content must include nodes and edges arrays',
    } satisfies DocumentCommandResult<never>;

  let found = false;
  const nextCanvas: JsonCanvasDocument<MinuNotesNodeExtra> = {
    ...canvas,
    nodes: canvas.nodes.map((node) => {
      if (node.id !== input.nodeId) return node;
      found = true;
      if (!node.minunotes || typeof node.minunotes !== 'object' || !node.minunotes.link) return node;
      const nextMetadata = { ...node.minunotes };
      delete nextMetadata.link;
      const nextNode = { ...node };
      if (Object.keys(nextMetadata).length > 0) nextNode.minunotes = nextMetadata;
      else delete nextNode.minunotes;
      return nextNode;
    }),
  };
  if (!found) return { ok: false, status: 404, error: 'Canvas node not found' } satisfies DocumentCommandResult<never>;

  return replaceCanvasDocument({
    documentId: input.documentId,
    userId: input.userId,
    title: input.title,
    canvas: nextCanvas,
    baseHash: input.baseHash,
    actorType: input.actorType,
    actorId: input.actorId,
  });
}

export async function replaceCanvasDocument(
  input: Omit<UpdateDocumentInput, 'markdown' | 'documentType'> & {
    canvas: JsonCanvasDocument;
    documentType?: Extract<DocumentType, 'canvas.default' | 'canvas.mindmap'>;
  }
) {
  const current = await readDocument({ documentId: input.documentId, userId: input.userId });
  if (!current.ok) return current;
  const documentType =
    input.documentType ??
    (current.value.note.documentType.startsWith('canvas.')
      ? (current.value.note.documentType as Extract<DocumentType, 'canvas.default' | 'canvas.mindmap'>)
      : 'canvas.default');
  if (!current.value.note.documentType.startsWith('canvas.'))
    return {
      ok: false,
      status: 400,
      error: 'Canvas operations are only supported for canvas notes',
    } satisfies DocumentCommandResult<never>;
  const content = serializeCanvasDocument(input.canvas);
  if (!content)
    return {
      ok: false,
      status: 400,
      error: 'Canvas content must include nodes and edges arrays',
    } satisfies DocumentCommandResult<never>;
  return updateDocument({
    documentId: input.documentId,
    userId: input.userId,
    title: input.title,
    markdown: content,
    documentType,
    baseHash: input.baseHash,
    actorType: input.actorType,
    actorId: input.actorId,
  });
}

export async function canvasDocumentFromSyntax(input: {
  syntax: string;
  documentType?: DocumentType;
  format?: CanvasSyntaxFormat;
}) {
  const format =
    input.format === undefined || input.format === 'auto' ? detectCanvasSyntaxFormat(input.syntax) : input.format;

  if (format === 'mermaid') {
    if (input.documentType === 'canvas.mindmap')
      return {
        ok: false as const,
        errors: [
          {
            severity: 'error' as const,
            code: 'unsupported_diagram' as const,
            message: 'Mermaid flowcharts cannot be compiled as mind maps',
          },
        ],
      };

    const { compileMermaidSyntax } = await import('@dpklabs/minucanvas/mermaid');
    const compiled = await compileMermaidSyntax(input.syntax);
    if (!compiled.success) return { ok: false as const, errors: compiled.diagnostics };
    return {
      ok: true as const,
      canvas: compiled.document,
      documentType: input.documentType ?? 'canvas.default',
      diagnostics: compiled.diagnostics,
      title: undefined,
    };
  }

  const compiled = compileDiagramSyntax(input);
  if (!compiled.ok) return compiled;
  return {
    ok: true as const,
    canvas: compiled.document,
    documentType: compiled.documentType,
    diagnostics: compiled.diagnostics,
    title: compiled.title,
  };
}

export async function editDocument(
  input: Omit<UpdateDocumentInput, 'title' | 'markdown' | 'folderId'> & { edits: DocumentEdit[] }
) {
  const current = await readDocument({ documentId: input.documentId, userId: input.userId });
  if (!current.ok) return current;
  if (current.value.note.documentType !== 'markdown')
    return {
      ok: false,
      status: 400,
      error: 'Patch edits are only supported for markdown notes',
    } satisfies DocumentCommandResult<never>;

  const result = applyDocumentEdits(current.value.note.content, input.edits);
  if (!result.ok) return { ok: false, status: 400, error: result.error } satisfies DocumentCommandResult<never>;

  return updateDocument({
    documentId: input.documentId,
    userId: input.userId,
    markdown: result.markdown,
    baseHash: input.baseHash,
    actorType: input.actorType,
    actorId: input.actorId,
    eventType: 'edit_patch',
  });
}

export type { DocumentEdit };
