import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { getMinuNotesNodeLink } from '../../shared/canvas-links';
import { NOTE_ID_PATTERN, normalizeWikilinkTitle, parseWikilinks } from '../../shared/wikilinks';
import { db as defaultDb } from '../db/client';
import type { MetadataExecutor } from './metadata-transaction';

const db = defaultDb;

import { noteLinks, notes } from '../db/schema';
import {
  collaborationAccessibleNoteWhere,
  hasFolderCollaborationAccessSql,
  integrationAccessibleNoteWhere,
  type SharedAccessMode,
} from '../lib/collaboration-access';
import { createId } from '../lib/id';
import { activeNoteWhere } from '../trash/policy';

export type ParsedNoteLink = {
  targetTitle: string;
  targetNoteId: string | null;
  label: string | null;
  linkType: 'wikilink' | 'internal-url' | 'markdown-internal-url' | 'canvas-note';
  raw: string;
  from: number;
  to: number;
};

const NOTE_URL_PATTERN = String.raw`(?:https?:\/\/)?[^\s)]+\/notes\/(note_[a-zA-Z0-9]+)|\/notes\/(note_[a-zA-Z0-9]+)`;
const MARKDOWN_INTERNAL_URL_PATTERN = new RegExp(String.raw`\[([^\]\n]+)\]\((${NOTE_URL_PATTERN})\)`, 'g');
const RAW_INTERNAL_URL_PATTERN = new RegExp(String.raw`(?<!\]\()(?:${NOTE_URL_PATTERN})`, 'g');

export function normalizeNoteTitle(title: string) {
  return normalizeWikilinkTitle(title);
}

export function parseWikiLinks(markdown: string): ParsedNoteLink[] {
  return parseWikilinks(markdown).map((link) => ({
    targetTitle: link.target,
    targetNoteId: NOTE_ID_PATTERN.test(link.target) ? link.target : null,
    label: link.label,
    linkType: 'wikilink',
    raw: link.raw,
    from: link.from,
    to: link.to,
  }));
}

export function parseInternalNoteUrls(markdown: string): ParsedNoteLink[] {
  const links: ParsedNoteLink[] = [];
  const markdownRanges: Array<{ from: number; to: number }> = [];

  for (const match of markdown.matchAll(MARKDOWN_INTERNAL_URL_PATTERN)) {
    const from = match.index ?? 0;
    const raw = match[0];
    const targetNoteId = match[3] ?? match[4];
    markdownRanges.push({ from, to: from + raw.length });
    links.push({
      targetTitle: match[1]?.trim() || targetNoteId,
      targetNoteId,
      label: match[1]?.trim() || null,
      linkType: 'markdown-internal-url',
      raw,
      from,
      to: from + raw.length,
    });
  }

  for (const match of markdown.matchAll(RAW_INTERNAL_URL_PATTERN)) {
    const from = match.index ?? 0;
    const raw = match[0];
    const to = from + raw.length;
    const targetNoteId = match[1] ?? match[2];
    if (markdownRanges.some((range) => from >= range.from && to <= range.to)) continue;
    links.push({
      targetTitle: targetNoteId,
      targetNoteId,
      label: null,
      linkType: 'internal-url',
      raw,
      from,
      to,
    });
  }

  return links;
}

export function parseNoteLinks(markdown: string): ParsedNoteLink[] {
  return [...parseWikiLinks(markdown), ...parseInternalNoteUrls(markdown)].sort((a, b) => a.from - b.from);
}

export function sanitizeCanvasNoteLinksForVisibleTargets(input: {
  content: string;
  visibleTargetIds: ReadonlySet<string>;
}) {
  let canvas: { nodes?: unknown[] };
  try {
    canvas = JSON.parse(input.content) as { nodes?: unknown[] };
  } catch {
    return { content: input.content, hiddenLinkCount: 0 };
  }
  if (!Array.isArray(canvas.nodes)) return { content: input.content, hiddenLinkCount: 0 };

  let hiddenLinkCount = 0;
  for (const node of canvas.nodes) {
    const link = getMinuNotesNodeLink(node);
    if (!link || input.visibleTargetIds.has(link.id) || !node || typeof node !== 'object') continue;
    const metadata = (node as { minunotes?: unknown }).minunotes;
    if (!metadata || typeof metadata !== 'object') continue;
    delete (metadata as { link?: unknown }).link;
    if (Object.keys(metadata).length === 0) delete (node as { minunotes?: unknown }).minunotes;
    hiddenLinkCount += 1;
  }
  return {
    content: hiddenLinkCount > 0 ? JSON.stringify(canvas) : input.content,
    hiddenLinkCount,
  };
}

export async function sanitizeCanvasNoteLinksForActor(input: { actorUserId: string; content: string }) {
  const targetIds = [
    ...new Set(
      parseCanvasNoteLinks(input.content)
        .map((link) => link.targetNoteId)
        .filter((id): id is string => !!id)
    ),
  ];
  if (targetIds.length === 0) return { content: input.content, hiddenLinkCount: 0 };
  const visibleTargets = await db
    .select({ id: notes.id })
    .from(notes)
    .where(collaborationAccessibleNoteWhere(input.actorUserId, 'read', inArray(notes.id, targetIds)));
  return sanitizeCanvasNoteLinksForVisibleTargets({
    content: input.content,
    visibleTargetIds: new Set(visibleTargets.map((target) => target.id)),
  });
}

export function parseCanvasNoteLinks(content: string): ParsedNoteLink[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { nodes?: unknown }).nodes)) return [];

  const links: ParsedNoteLink[] = [];
  for (const [index, node] of (parsed as { nodes: unknown[] }).nodes.entries()) {
    const link = getMinuNotesNodeLink(node);
    if (!link) continue;
    const nodeValue = node as { text?: unknown; label?: unknown };
    const text = typeof nodeValue.text === 'string' ? nodeValue.text.trim() : '';
    const label = typeof nodeValue.label === 'string' ? nodeValue.label.trim() : '';
    links.push({
      targetTitle: link.id,
      targetNoteId: link.id,
      label: text || label || null,
      linkType: 'canvas-note',
      raw: link.id,
      from: index,
      to: index,
    });
  }
  return links;
}

async function resolveUniqueTargetNote(
  input: { userId: string; sourceNoteId: string; targetTitle: string },
  executor: MetadataExecutor = defaultDb
) {
  const db = executor;
  const normalized = normalizeNoteTitle(input.targetTitle);
  const rows = await db
    .select({ id: notes.id })
    .from(notes)
    .where(activeNoteWhere(input.userId, sql`lower(${notes.title}) = ${normalized}`))
    .limit(2);
  const candidates = rows.filter((row) => row.id !== input.sourceNoteId);
  return candidates.length === 1 ? candidates[0].id : null;
}

async function resolveTargetNoteById(
  input: { userId: string; sourceNoteId: string; targetNoteId: string },
  executor: MetadataExecutor = defaultDb
) {
  const db = executor;
  if (input.targetNoteId === input.sourceNoteId) return null;
  const [target] = await db
    .select({ id: notes.id, title: notes.title })
    .from(notes)
    .where(activeNoteWhere(input.userId, eq(notes.id, input.targetNoteId)))
    .limit(1);
  return target ?? null;
}

export async function reindexNoteLinks(
  input: {
    userId: string;
    noteId: string;
    markdown: string;
    documentType?: string;
  },
  executor: MetadataExecutor = defaultDb
) {
  const db = executor;
  const parsed = input.documentType?.startsWith('canvas.')
    ? parseCanvasNoteLinks(input.markdown)
    : parseNoteLinks(input.markdown);
  await db.delete(noteLinks).where(and(eq(noteLinks.userId, input.userId), eq(noteLinks.sourceNoteId, input.noteId)));
  if (parsed.length === 0) return { links: [] };

  const now = new Date();
  const values = [];
  for (const link of parsed) {
    const target = link.targetNoteId
      ? await resolveTargetNoteById(
          {
            userId: input.userId,
            sourceNoteId: input.noteId,
            targetNoteId: link.targetNoteId,
          },
          executor
        )
      : null;
    const targetNoteId =
      target?.id ??
      (link.linkType === 'wikilink'
        ? await resolveUniqueTargetNote(
            {
              userId: input.userId,
              sourceNoteId: input.noteId,
              targetTitle: link.targetTitle,
            },
            executor
          )
        : null);
    values.push({
      id: createId('note_link'),
      userId: input.userId,
      sourceNoteId: input.noteId,
      targetNoteId,
      targetTitle: target?.title ?? link.targetTitle,
      label: link.label,
      linkType: link.linkType,
      createdAt: now,
      updatedAt: now,
    });
  }
  await db.insert(noteLinks).values(values);
  return { links: values };
}

export async function resolveUnresolvedNoteLinks(
  input: { userId: string; title: string; noteId: string },
  executor: MetadataExecutor = defaultDb
) {
  const db = executor;
  const normalized = normalizeNoteTitle(input.title);
  const candidates = await db
    .select({ id: notes.id })
    .from(notes)
    .where(activeNoteWhere(input.userId, sql`lower(${notes.title}) = ${normalized}`))
    .limit(2);
  if (candidates.length !== 1) return;

  await db
    .update(noteLinks)
    .set({ targetNoteId: input.noteId, updatedAt: new Date() })
    .where(
      and(
        eq(noteLinks.userId, input.userId),
        isNull(noteLinks.targetNoteId),
        sql`lower(${noteLinks.targetTitle}) = ${normalized}`
      )
    );
}

export async function listOutgoingLinks(input: { userId: string; noteId: string; actorUserId?: string }) {
  const source = await db
    .select({ id: notes.id })
    .from(notes)
    .where(
      input.actorUserId
        ? collaborationAccessibleNoteWhere(input.actorUserId, 'read', eq(notes.id, input.noteId))
        : activeNoteWhere(input.userId, eq(notes.id, input.noteId))
    )
    .limit(1);
  if (source.length === 0) return null;

  const links = await db
    .select({
      id: noteLinks.id,
      sourceNoteId: noteLinks.sourceNoteId,
      targetNoteId: noteLinks.targetNoteId,
      targetTitle: noteLinks.targetTitle,
      label: noteLinks.label,
      linkType: noteLinks.linkType,
      createdAt: noteLinks.createdAt,
      updatedAt: noteLinks.updatedAt,
    })
    .from(noteLinks)
    .where(and(eq(noteLinks.userId, input.userId), eq(noteLinks.sourceNoteId, input.noteId)))
    .orderBy(noteLinks.targetTitle);

  const targetIds = links.map((link) => link.targetNoteId).filter((id): id is string => Boolean(id));
  if (targetIds.length === 0) return links;
  const activeTargets = await db
    .select({ id: notes.id })
    .from(notes)
    .where(
      input.actorUserId
        ? collaborationAccessibleNoteWhere(input.actorUserId, 'read', inArray(notes.id, targetIds))
        : activeNoteWhere(input.userId, inArray(notes.id, targetIds))
    );
  const activeTargetIds = new Set(activeTargets.map((target) => target.id));
  return links.map((link) =>
    link.targetNoteId && !activeTargetIds.has(link.targetNoteId)
      ? {
          ...link,
          targetNoteId: null,
          targetTitle: link.linkType === 'wikilink' ? link.targetTitle : link.label?.trim() || 'Linked note',
        }
      : link
  );
}

export async function listOrphanNotes(input: {
  userId: string;
  actorUserId?: string;
  integrationAccess?: {
    authorizationId: string;
    sharedAccessMode: SharedAccessMode;
    ownedFolderIds: ReadonlySet<string>;
  };
  folderIds?: ReadonlySet<string>;
  after?: { title: string; id: string } | null;
  offset?: number;
  limit?: number;
}) {
  if (input.folderIds && input.folderIds.size === 0) return [];

  let candidateBatchSize = 250;
  const requestedLimit = input.limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, input.limit);
  if (requestedLimit === 0) return [];
  let remainingOffset = Math.max(0, input.offset ?? 0);
  let candidatePosition = input.after ?? null;
  const orphans: Array<{
    id: string;
    folderId: string;
    userId: string;
    title: string;
    documentType: (typeof notes.$inferSelect)['documentType'];
    type: (typeof notes.$inferSelect)['type'];
    createdAt: Date;
    updatedAt: Date;
  }> = [];

  while (orphans.length < requestedLimit) {
    const candidates = await db
      .select({
        id: notes.id,
        folderId: notes.folderId,
        userId: notes.userId,
        title: notes.title,
        documentType: notes.documentType,
        type: notes.type,
        createdAt: notes.createdAt,
        updatedAt: notes.updatedAt,
      })
      .from(notes)
      .where(
        and(
          input.integrationAccess
            ? integrationAccessibleNoteWhere(
                {
                  actorUserId: input.userId,
                  authorizationId: input.integrationAccess.authorizationId,
                  sharedAccessMode: input.integrationAccess.sharedAccessMode,
                  ownedFolderIds: input.integrationAccess.ownedFolderIds,
                },
                eq(notes.type, 'note')
              )
            : input.actorUserId
              ? collaborationAccessibleNoteWhere(input.actorUserId, 'read', eq(notes.type, 'note'))
              : activeNoteWhere(input.userId, eq(notes.type, 'note')),
          input.folderIds ? inArray(notes.folderId, [...input.folderIds]) : undefined,
          candidatePosition
            ? or(
                gt(notes.title, candidatePosition.title),
                and(eq(notes.title, candidatePosition.title), gt(notes.id, candidatePosition.id))
              )
            : undefined
        )
      )
      .orderBy(asc(notes.title), asc(notes.id))
      .limit(candidateBatchSize);
    if (candidates.length === 0) break;

    const incoming = await db
      .select({ targetNoteId: noteLinks.targetNoteId })
      .from(noteLinks)
      .innerJoin(notes, eq(noteLinks.sourceNoteId, notes.id))
      .where(
        and(
          input.actorUserId || input.integrationAccess ? undefined : eq(noteLinks.userId, input.userId),
          inArray(
            noteLinks.targetNoteId,
            candidates.map((note) => note.id)
          ),
          input.integrationAccess
            ? integrationAccessibleNoteWhere({
                actorUserId: input.userId,
                authorizationId: input.integrationAccess.authorizationId,
                sharedAccessMode: input.integrationAccess.sharedAccessMode,
                ownedFolderIds: input.integrationAccess.ownedFolderIds,
              })
            : input.actorUserId
              ? collaborationAccessibleNoteWhere(input.actorUserId)
              : activeNoteWhere(input.userId)
        )
      );
    const linkedIds = new Set(incoming.map((link) => link.targetNoteId));
    for (const candidate of candidates) {
      if (linkedIds.has(candidate.id)) continue;
      if (remainingOffset > 0) {
        remainingOffset -= 1;
        continue;
      }
      orphans.push(candidate);
      if (orphans.length >= requestedLimit) break;
    }

    const lastCandidate = candidates.at(-1);
    if (!lastCandidate || candidates.length < candidateBatchSize) break;
    candidatePosition = { title: lastCandidate.title, id: lastCandidate.id };
    candidateBatchSize = 1_000;
  }

  return orphans;
}

export async function listBacklinks(input: { userId: string; noteId: string; actorUserId?: string }) {
  const target = await db
    .select({ id: notes.id })
    .from(notes)
    .where(
      input.actorUserId
        ? collaborationAccessibleNoteWhere(input.actorUserId, 'read', eq(notes.id, input.noteId))
        : activeNoteWhere(input.userId, eq(notes.id, input.noteId))
    )
    .limit(1);
  if (target.length === 0) return null;

  const canAccessSourceFolder = input.actorUserId
    ? hasFolderCollaborationAccessSql({
        actorUserId: input.actorUserId,
        folderId: notes.folderId,
        ownerUserId: notes.userId,
      })
    : sql<boolean>`1`;
  const rows = await db
    .select({
      id: noteLinks.id,
      sourceNoteId: noteLinks.sourceNoteId,
      sourceTitle: notes.title,
      sourceFolderId: notes.folderId,
      canAccessSourceFolder,
      targetTitle: noteLinks.targetTitle,
      label: noteLinks.label,
      linkType: noteLinks.linkType,
      createdAt: noteLinks.createdAt,
      updatedAt: noteLinks.updatedAt,
    })
    .from(noteLinks)
    .innerJoin(notes, eq(noteLinks.sourceNoteId, notes.id))
    .where(
      and(
        eq(noteLinks.userId, input.userId),
        eq(noteLinks.targetNoteId, input.noteId),
        input.actorUserId ? collaborationAccessibleNoteWhere(input.actorUserId) : activeNoteWhere(input.userId)
      )
    )
    .orderBy(notes.title);
  return rows.map(({ canAccessSourceFolder: folderVisible, sourceFolderId, ...row }) => ({
    ...row,
    sourceFolderId: folderVisible ? sourceFolderId : null,
  }));
}
