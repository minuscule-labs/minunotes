import { isCalendarDate } from './properties';

export class NoteQueryError extends Error {}
export const NOTE_QUERY_MAX_BYTES = 8192;
export const NOTE_FILTER_WHITESPACE =
  ' \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
type Field = { schemaId: string; propertyId: string };
export type NoteFilter = Field &
  (
    | { type: 'text'; operator: 'contains'; value: string }
    | { type: 'select'; operator: 'is'; optionId: string }
    | { type: 'select'; operator: 'anyOf'; optionIds: string[] }
    | { type: 'date'; operator: 'before' | 'after'; value: string }
    | { type: 'date'; operator: 'between'; from: string; to: string }
    | { type: 'text' | 'select' | 'date'; operator: 'empty' }
  );
export type NoteQuery = { q: string; filters: { version: 1; all: NoteFilter[] } };
export const EMPTY_NOTE_QUERY: NoteQuery = { q: '', filters: { version: 1, all: [] } };
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const fail = (message = 'Invalid folder filters. Review or remove the invalid condition.'): never => {
  throw new NoteQueryError(message);
};
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : fail();
const keys = (value: Record<string, unknown>, allowed: string[]) => {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail();
};
const term = (value: unknown): value is string =>
  typeof value === 'string' && !!value.trim() && Array.from(value).length <= 200 && !value.includes('\0');
const date = (value: unknown): value is string => typeof value === 'string' && isCalendarDate(value);

function clause(input: unknown): NoteFilter {
  const value = object(input);
  if (
    !id(value.schemaId) ||
    !id(value.propertyId) ||
    typeof value.type !== 'string' ||
    !['text', 'select', 'date'].includes(value.type)
  )
    fail();
  const base = { schemaId: value.schemaId as string, propertyId: value.propertyId as string };
  const common = ['schemaId', 'propertyId', 'type', 'operator'];
  if (value.operator === 'empty') {
    keys(value, common);
    return { ...base, type: value.type as 'text' | 'select' | 'date', operator: 'empty' };
  }
  if (value.type === 'text' && value.operator === 'contains') {
    keys(value, [...common, 'value']);
    if (!term(value.value)) fail('Text contains needs a nonblank term of up to 200 characters.');
    return { ...base, type: 'text', operator: 'contains', value: value.value as string };
  }
  if (value.type === 'select' && value.operator === 'is') {
    keys(value, [...common, 'optionId']);
    if (!id(value.optionId)) fail();
    return { ...base, type: 'select', operator: 'is', optionId: value.optionId as string };
  }
  if (value.type === 'select' && value.operator === 'anyOf') {
    keys(value, [...common, 'optionIds']);
    const options = value.optionIds;
    if (
      !Array.isArray(options) ||
      options.length < 1 ||
      options.length > 8 ||
      !options.every(id) ||
      new Set(options).size !== options.length
    )
      fail('Choose one to eight distinct Select options.');
    return { ...base, type: 'select', operator: 'anyOf', optionIds: [...(options as string[])].sort() };
  }
  if (value.type === 'date' && (value.operator === 'before' || value.operator === 'after')) {
    keys(value, [...common, 'value']);
    if (!date(value.value)) fail('Use a real YYYY-MM-DD date.');
    return { ...base, type: 'date', operator: value.operator, value: value.value as string };
  }
  if (value.type === 'date' && value.operator === 'between') {
    keys(value, [...common, 'from', 'to']);
    if (!date(value.from) || !date(value.to) || String(value.from) > String(value.to))
      fail('Use real dates with the start on or before the end.');
    return { ...base, type: 'date', operator: 'between', from: value.from as string, to: value.to as string };
  }
  return fail();
}

/** Validate decoded URL parameter values; arrays from repeated router parameters are invalid. */
export function parseNoteQuery(input: { q?: unknown; filters?: unknown }): NoteQuery {
  if (input.q !== undefined && typeof input.q !== 'string') fail('Use a single title search parameter.');
  if (input.filters !== undefined && typeof input.filters !== 'string') fail('Use a single filters parameter.');
  const rawQ = input.q as string | undefined;
  if (rawQ && (Array.from(rawQ).length > 200 || rawQ.includes('\0')))
    fail('Title search supports up to 200 characters.');
  const raw = new URLSearchParams();
  if (rawQ !== undefined) raw.set('q', rawQ);
  if (input.filters !== undefined) raw.set('filters', input.filters as string);
  if (raw.toString().length > NOTE_QUERY_MAX_BYTES)
    fail('Shorten the search or filters (maximum encoded query is 8 KiB).');
  let all: NoteFilter[] = [];
  if (input.filters !== undefined) {
    let document: Record<string, unknown>;
    try {
      document = object(JSON.parse(input.filters as string));
    } catch {
      return fail();
    }
    keys(document, ['version', 'all']);
    if (document.version !== 1 || !Array.isArray(document.all) || document.all.length > 12)
      fail('Use version 1 filters with at most 12 properties.');
    all = (document.all as unknown[]).map(clause);
    if (new Set(all.map((item) => item.propertyId)).size !== all.length)
      fail('Only one condition per property is supported.');
    all.sort((a, b) =>
      a.schemaId < b.schemaId
        ? -1
        : a.schemaId > b.schemaId
          ? 1
          : a.propertyId < b.propertyId
            ? -1
            : a.propertyId > b.propertyId
              ? 1
              : 0
    );
  }
  const result: NoteQuery = { q: rawQ?.trim() ? rawQ : '', filters: { version: 1, all } };
  if (new URLSearchParams(noteQuerySearch(result)).toString().length > NOTE_QUERY_MAX_BYTES)
    fail('Shorten the search or filters (maximum encoded query is 8 KiB).');
  return result;
}
export function noteQuerySearch(query: NoteQuery): { q?: string; filters?: string } {
  return {
    ...(query.q ? { q: query.q } : {}),
    ...(query.filters.all.length ? { filters: JSON.stringify(query.filters) } : {}),
  };
}
export function noteQueryIdentity(query: NoteQuery): string {
  return JSON.stringify(query);
}
export function hasNoteQuery(query: NoteQuery): boolean {
  return !!query.q || query.filters.all.length > 0;
}
