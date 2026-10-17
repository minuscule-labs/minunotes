import { type NoteQuery, NoteQueryError, noteQueryIdentity } from './note-filters';
import type { PropertyDefinition, PropertySchema } from './properties';

export const DEFAULT_NOTE_SORT = 'updated-desc';
export const NOTE_SORT_OPTIONS = [
  { value: 'updated-desc', label: 'Updated · Newest first' },
  { value: 'updated-asc', label: 'Updated · Oldest first' },
  { value: 'title-asc', label: 'Title · A–Z' },
  { value: 'title-desc', label: 'Title · Z–A' },
  { value: 'created-desc', label: 'Created · Newest first' },
  { value: 'created-asc', label: 'Created · Oldest first' },
] as const;
export type BuiltinNoteSort = (typeof NOTE_SORT_OPTIONS)[number]['value'];
export type PropertyNoteSort = Readonly<{
  version: 1;
  schemaId: string;
  propertyId: string;
  type: 'text' | 'select' | 'date';
  direction: 'asc' | 'desc';
}>;
export type NoteSort = BuiltinNoteSort | PropertyNoteSort;
export function isPropertySort(sort: NoteSort | undefined): sort is PropertyNoteSort {
  return !!sort && typeof sort === 'object';
}
const invalid = (): never => {
  throw new NoteQueryError('Invalid sort. Choose one supported sort order.');
};
export function parseNoteSort(params: URLSearchParams): NoteSort {
  const values = params.getAll('sort');
  if (!values.length) return DEFAULT_NOTE_SORT;
  if (values.length !== 1 || values[0].length > 1024) return invalid();
  const raw = values[0];
  if (NOTE_SORT_OPTIONS.some((option) => option.value === raw)) return raw as BuiltinNoteSort;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return invalid();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const v = value as Record<string, unknown>;
  const id = (candidate: unknown): candidate is string =>
    typeof candidate === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(candidate);
  if (
    Object.keys(v).length !== 5 ||
    Object.keys(v).some((key) => !['version', 'schemaId', 'propertyId', 'type', 'direction'].includes(key))
  )
    return invalid();
  if (
    v.version !== 1 ||
    !id(v.schemaId) ||
    !id(v.propertyId) ||
    typeof v.type !== 'string' ||
    !['text', 'select', 'date'].includes(v.type) ||
    typeof v.direction !== 'string' ||
    !['asc', 'desc'].includes(v.direction)
  )
    return invalid();
  return {
    version: 1,
    schemaId: v.schemaId,
    propertyId: v.propertyId,
    type: v.type as PropertyNoteSort['type'],
    direction: v.direction as PropertyNoteSort['direction'],
  };
}
export function noteSortIdentity(sort: NoteSort = DEFAULT_NOTE_SORT): string {
  return isPropertySort(sort)
    ? JSON.stringify({
        version: 1,
        schemaId: sort.schemaId,
        propertyId: sort.propertyId,
        type: sort.type,
        direction: sort.direction,
      })
    : sort;
}
export function sameNoteSort(a: NoteSort, b: NoteSort): boolean {
  return noteSortIdentity(a) === noteSortIdentity(b);
}
export function sortProperty(sort: NoteSort, schema?: PropertySchema): PropertyDefinition | undefined {
  if (!isPropertySort(sort) || schema?.schemaId !== sort.schemaId) return undefined;
  return schema.definitions.find(
    (field) => field.id === sort.propertyId && field.type === sort.type && !field.archived
  );
}
export function noteSortSchemaError(sort: NoteSort, schema?: PropertySchema): string | null {
  if (!isPropertySort(sort)) return null;
  if (!schema) return 'Load current definitions to review the sort.';
  return sortProperty(sort, schema) ? null : 'The sort property is unavailable or changed. Review or remove the sort.';
}
export function folderReadIdentity(query: NoteQuery, sort: NoteSort = DEFAULT_NOTE_SORT): string {
  return JSON.stringify([noteQueryIdentity(query), noteSortIdentity(sort)]);
}
