import { and, eq } from 'drizzle-orm';
import { db as defaultDb } from '../db/client';
import { attachments } from '../db/schema';
import type { MetadataExecutor } from '../notes/metadata-transaction';

const APP_ATTACHMENT_URL_PATTERN =
  /(?:!\[[^\]]*\]|\[[^\]]*\])\(\s*(?:<(?:https?:\/\/[^\s<>]+?)?\/internal\/attachments\/(att_[a-zA-Z0-9_-]+)\/content(?:[?#][^\s<>]*)?>|(?:https?:\/\/[^\s)]+?)?\/internal\/attachments\/(att_[a-zA-Z0-9_-]+)\/content(?:[?#][^\s)]*)?)\s*(?:"[^"]*"|'[^']*')?\s*\)/g;

export function extractAppAttachmentIds(markdown: string) {
  const ids = new Set<string>();
  for (const match of markdown.matchAll(APP_ATTACHMENT_URL_PATTERN)) {
    // Separate branches require balanced angle delimiters and retain the existing bare-URL grammar.
    ids.add(match[1] ?? match[2]);
  }
  return [...ids];
}

export async function syncNoteAttachmentReferences(
  input: { noteId: string; userId: string; markdown: string },
  executor: MetadataExecutor = defaultDb
) {
  const db = executor;
  const referencedIds = new Set(extractAppAttachmentIds(input.markdown));
  const now = new Date();
  const rows = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.noteId, input.noteId), eq(attachments.userId, input.userId)));

  for (const attachment of rows) {
    const isReferenced = referencedIds.has(attachment.id);
    const wasUnreferenced = Boolean(attachment.unreferencedAt);
    if (isReferenced) {
      await db
        .update(attachments)
        .set({ referencedAt: now, unreferencedAt: null, updatedAt: now })
        .where(and(eq(attachments.id, attachment.id), eq(attachments.userId, input.userId)));
    } else if (!wasUnreferenced && attachment.referencedAt && !attachment.deletedAt) {
      await db
        .update(attachments)
        .set({ unreferencedAt: now, updatedAt: now })
        .where(and(eq(attachments.id, attachment.id), eq(attachments.userId, input.userId)));
    }
  }
}
