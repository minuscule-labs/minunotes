import { parser } from '@lezer/markdown';
import { FOLDER_COPY_LIMITS, FolderDuplicationError } from '../../shared/folder-duplication';
import type { PropertyDefinition } from '../../shared/properties';
import { NOTE_ID_PATTERN } from '../../shared/wikilinks';
import { createId } from '../lib/id';

export function jsonObject(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new FolderDuplicationError('Source metadata is malformed; repair it before duplicating');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new FolderDuplicationError('Source metadata must be an object');
  return value as Record<string, unknown>;
}
export type SchemaCopy = {
  schemaId: string;
  oldSchemaId: string;
  definitions: PropertyDefinition[];
  fields: Map<string, string>;
  options: Map<string, Map<string, string>>;
};
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
export function copySchema(schemaId: string, raw: string): SchemaCopy {
  if (!validId(schemaId)) throw new FolderDuplicationError('Malformed source schema ID');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FolderDuplicationError('Source property definitions are malformed');
  }
  if (!Array.isArray(parsed)) throw new FolderDuplicationError('Source property definitions are malformed');
  const fields = new Map<string, string>();
  const options = new Map<string, Map<string, string>>();
  const definitions = parsed.map((value): PropertyDefinition => {
    if (
      !value ||
      typeof value !== 'object' ||
      !validId(value.id) ||
      fields.has(value.id) ||
      typeof value.label !== 'string' ||
      typeof value.archived !== 'boolean' ||
      !['text', 'date', 'select'].includes(value.type) ||
      !Array.isArray(value.options) ||
      (value.type !== 'select' && value.options.length > 0)
    )
      throw new FolderDuplicationError('Unsupported source property definitions');
    fields.set(value.id, createId('property'));
    const ids = new Map<string, string>();
    options.set(value.id, ids);
    const copiedOptions = value.options.map((option: unknown) => {
      if (!option || typeof option !== 'object') throw new FolderDuplicationError('Malformed Select option');
      const entry = option as { id?: unknown; label?: unknown; archived?: unknown };
      if (
        !validId(entry.id) ||
        ids.has(entry.id) ||
        typeof entry.label !== 'string' ||
        typeof entry.archived !== 'boolean'
      )
        throw new FolderDuplicationError('Malformed Select option');
      const id = createId('option');
      ids.set(entry.id, id);
      return { ...entry, id } as { id: string; label: string; archived: boolean };
    });
    // Preserve extra persisted display metadata, rather than recreating definitions through mutation defaults.
    return { ...value, id: fields.get(value.id), options: copiedOptions };
  });
  return { schemaId: createId('schema'), oldSchemaId: schemaId, definitions, fields, options };
}
export function copyValues(raw: string, schema?: SchemaCopy): string {
  const values = jsonObject(raw);
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        schema?.fields.get(key) ?? key,
        typeof value === 'string' ? (schema?.options.get(key)?.get(value) ?? value) : value,
      ])
    )
  );
}
export function copyBoard(raw: string, schema?: SchemaCopy): string {
  const config = jsonObject(raw);
  if (!schema) return raw;
  const grouping = config.grouping;
  if (grouping && typeof grouping === 'object' && !Array.isArray(grouping)) {
    const g = grouping as Record<string, unknown>;
    if (g.schemaId === schema.oldSchemaId)
      config.grouping = {
        ...g,
        schemaId: schema.schemaId,
        propertyId: typeof g.propertyId === 'string' ? (schema.fields.get(g.propertyId) ?? g.propertyId) : g.propertyId,
      };
  }
  if (Array.isArray(config.cardPropertyIds))
    config.cardPropertyIds = config.cardPropertyIds.map((id) =>
      typeof id === 'string' ? (schema.fields.get(id) ?? id) : id
    );
  if (typeof config.cardTypePropertyId === 'string')
    config.cardTypePropertyId = schema.fields.get(config.cardTypePropertyId) ?? config.cardTypePropertyId;
  return JSON.stringify(config);
}
export type ContentCopyContext = {
  notes: Map<string, string>;
  titles: Map<string, string>;
  attachments: Map<string, string>;
  origins: string[];
};
function appUrl(raw: string, origins: string[]) {
  if (!raw.startsWith('/') && !/^https?:\/\//.test(raw)) return null;
  if (raw.startsWith('//')) return null;
  try {
    const url = new URL(raw, 'https://minunotes.invalid');
    return raw.startsWith('/') || origins.includes(url.origin) ? url : null;
  } catch {
    return null;
  }
}
function replaceUrl(raw: string, ctx: ContentCopyContext): string {
  const url = appUrl(raw, ctx.origins);
  if (!url) return raw;
  const note = url.pathname.match(/^\/notes\/(note_[a-zA-Z0-9]+)$/);
  const attachment = url.pathname.match(/\/internal\/attachments\/(att_[a-zA-Z0-9_-]+)\/content$/);
  const old = note?.[1] ?? attachment?.[1];
  const id = old ? (note ? ctx.notes : ctx.attachments).get(old) : undefined;
  return id
    ? raw.replace(
        url.pathname,
        note ? `/notes/${id}` : url.pathname.replace(`/attachments/${old}/content`, `/attachments/${id}/content`)
      )
    : raw;
}
type Range = { from: number; to: number };
// Non-overlapping source ranges are sorted; lookup avoids a quadratic scan for link-heavy notes.
function overlaps(ranges: Range[], from: number, to: number) {
  let lo = 0,
    hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ranges[mid].from < to) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && ranges[lo - 1].to > from;
}
function markdownRanges(content: string) {
  const protectedRanges: Array<{ from: number; to: number }> = [];
  const urls: Array<{ from: number; to: number }> = [];
  const tree = parser.parse(content);
  tree.iterate({
    enter(node) {
      if (['FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock', 'HTMLTag'].includes(node.name)) {
        protectedRanges.push({ from: node.from, to: node.to });
        return false;
      }
      if (node.name === 'URL') {
        // Lezer includes angle delimiters for valid Markdown destinations. Rewrite only their URL.
        const delimited = content[node.from] === '<' && content[node.to - 1] === '>';
        urls.push({ from: node.from + (delimited ? 1 : 0), to: node.to - (delimited ? 1 : 0) });
      }
    },
  });
  const allowed = (from: number, to: number) => !overlaps(protectedRanges, from, to);
  const links = [...content.matchAll(/\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?\]\]/g)].flatMap((match) => {
    const from = match.index ?? 0,
      to = from + match[0].length,
      target = match[1].trim();
    return target && allowed(from, to) ? [{ from, to, target, label: match[2]?.trim() || null }] : [];
  });
  const parsedUrls = [...urls];
  // Bare app URLs are indexed by MinuNotes too, but never rewrite code or the visible label of a Markdown link.
  for (const match of content.matchAll(
    /https?:\/\/[^\s<>"')\]]+|(?<![a-zA-Z0-9_/])\/(?:notes\/note_[a-zA-Z0-9]+|internal\/attachments\/att_[a-zA-Z0-9_-]+\/content)(?:[?#][^\s<>"')\]]*)?/g
  )) {
    const from = match.index ?? 0,
      to = from + match[0].length;
    if (allowed(from, to) && !overlaps(parsedUrls, from, to) && !overlaps(links, from, to)) {
      // Literal URL-looking labels are not destinations.
      const parent = tree.resolveInner(from, 1);
      let inLabel = false;
      let current: typeof parent | null = parent;
      while (current) {
        if (['Link', 'Image'].includes(current.name)) {
          inLabel = true;
          break;
        }
        current = current.parent;
      }
      if (!inLabel) urls.push({ from, to });
    }
  }
  return { urls: urls.filter((range) => allowed(range.from, range.to)).sort((a, b) => a.from - b.from), links };
}
export function copyMarkdown(content: string, ctx: ContentCopyContext): string {
  const { urls, links } = markdownRanges(content);
  const edits: Array<{ from: number; to: number; text: string }> = [];
  let outputBytes = Buffer.byteLength(content);
  const add = (edit: { from: number; to: number; text: string }) => {
    outputBytes += Buffer.byteLength(edit.text) - Buffer.byteLength(content.slice(edit.from, edit.to));
    if (outputBytes > FOLDER_COPY_LIMITS.bytes)
      throw new FolderDuplicationError('Expanded content exceeds the copy size limit', 413);
    edits.push(edit);
  };
  for (const link of links) {
    const target = NOTE_ID_PATTERN.test(link.target) ? link.target : ctx.titles.get(link.target);
    if (!target) continue;
    const id = ctx.notes.get(target) ?? target;
    if (id === link.target) continue;
    add({ from: link.from, to: link.to, text: `[[${id}|${link.label ?? link.target}]]` });
  }
  for (const range of urls) {
    if (overlaps(links, range.from, range.to)) continue;
    const raw = content.slice(range.from, range.to),
      text = replaceUrl(raw, ctx);
    if (text !== raw) add({ ...range, text });
  }
  const chunks: string[] = [];
  let cursor = 0;
  for (const edit of edits.sort((a, b) => a.from - b.from)) {
    chunks.push(content.slice(cursor, edit.from), edit.text);
    cursor = edit.to;
  }
  chunks.push(content.slice(cursor));
  return chunks.join('');
}
export function copyContent(content: string, documentType: string, ctx: ContentCopyContext): string {
  if (documentType === 'markdown') return copyMarkdown(content, ctx);
  if (!['canvas.default', 'canvas.mindmap'].includes(documentType))
    throw new FolderDuplicationError('Unsupported source document type');
  const canvas = jsonObject(content);
  if (!Array.isArray(canvas.nodes) || !Array.isArray(canvas.edges))
    throw new FolderDuplicationError('Source canvas is malformed');
  for (const node of canvas.nodes) {
    if (!node || typeof node !== 'object') throw new FolderDuplicationError('Source canvas node is malformed');
    const link = node.minunotes?.link;
    if (link?.type === 'note' && typeof link.id === 'string' && ctx.notes.has(link.id))
      node.minunotes = { ...node.minunotes, link: { ...link, id: ctx.notes.get(link.id) } };
    if (typeof node.text === 'string') node.text = copyMarkdown(node.text, ctx);
    if (typeof node.file === 'string') node.file = replaceUrl(node.file, ctx);
  }
  return JSON.stringify(canvas);
}
export function contentReferences(content: string, documentType: string, origins: string[]) {
  const attachments = new Set<string>(),
    titles = new Set<string>();
  const inspect = (markdown: string) => {
    const { urls, links } = markdownRanges(markdown);
    for (const link of links) if (!NOTE_ID_PATTERN.test(link.target)) titles.add(link.target);
    for (const range of urls) {
      const url = appUrl(markdown.slice(range.from, range.to), origins);
      const id = url?.pathname.match(/\/internal\/attachments\/(att_[a-zA-Z0-9_-]+)\/content$/)?.[1];
      if (id) attachments.add(id);
    }
  };
  if (documentType === 'markdown') inspect(content);
  else {
    const canvas = jsonObject(content);
    if (!Array.isArray(canvas.nodes) || !Array.isArray(canvas.edges))
      throw new FolderDuplicationError('Source canvas is malformed');
    for (const node of canvas.nodes) {
      if (!node || typeof node !== 'object') throw new FolderDuplicationError('Source canvas node is malformed');
      if (typeof node.text === 'string') inspect(node.text);
      if (typeof node.file === 'string') {
        const id = appUrl(node.file, origins)?.pathname.match(
          /\/internal\/attachments\/(att_[a-zA-Z0-9_-]+)\/content$/
        )?.[1];
        if (id) attachments.add(id);
      }
    }
  }
  return { attachments: [...attachments], titles: [...titles] };
}
