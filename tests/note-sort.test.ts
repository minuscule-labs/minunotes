import { expect, it } from 'vitest';
import { parseNoteQuery } from '../src/shared/note-filters';
import { DEFAULT_NOTE_SORT, folderReadIdentity, NOTE_SORT_OPTIONS, parseNoteSort } from '../src/shared/note-sort';

it('accepts only the six scalar sort tokens and defaults only when absent', () => {
  expect(parseNoteSort(new URLSearchParams())).toBe(DEFAULT_NOTE_SORT);
  for (const { value } of NOTE_SORT_OPTIONS) expect(parseNoteSort(new URLSearchParams({ sort: value }))).toBe(value);
  for (const raw of [
    'sort=',
    'sort=title',
    'sort=TITLE-ASC',
    'sort=title-asc&sort=title-desc',
    'sort=updated-desc&sort=updated-desc',
    'sort=%27%20OR%201%3D1',
    'sort=%5B%22title-asc%22%5D',
  ])
    expect(() => parseNoteSort(new URLSearchParams(raw))).toThrow(/sort/i);
});
it('accepts canonical property descriptors, rejects unknown or malformed contracts, and binds type/schema', () => {
  const property = { version: 1, schemaId: 'schema_a', propertyId: 'prop_a', type: 'text', direction: 'asc' };
  const parsed = parseNoteSort(new URLSearchParams({ sort: JSON.stringify(property) }));
  expect(parsed).toEqual(property);
  const reordered = parseNoteSort(
    new URLSearchParams({
      sort: JSON.stringify({ direction: 'asc', type: 'text', propertyId: 'prop_a', schemaId: 'schema_a', version: 1 }),
    })
  );
  expect(folderReadIdentity(parseNoteQuery({}), parsed)).toBe(folderReadIdentity(parseNoteQuery({}), reordered));
  for (const change of [
    { version: 2 },
    { extra: true },
    { schemaId: '' },
    { propertyId: 'x'.repeat(101) },
    { propertyId: 'bad"path' },
    { type: 'number' },
    { direction: 'up' },
    { direction: null },
  ])
    expect(() => parseNoteSort(new URLSearchParams({ sort: JSON.stringify({ ...property, ...change }) }))).toThrow(
      /sort/i
    );
  for (const value of ['{}', '[]', 'null', 'true', '{"version":1}', ' '.repeat(2000)])
    expect(() => parseNoteSort(new URLSearchParams({ sort: value }))).toThrow(/sort/i);
  expect(() => parseNoteSort(new URLSearchParams({ sort: `${JSON.stringify(property)}x` }))).toThrow(/sort/i);
});
it('binds read identity to both immutable query and sort without mutating either', () => {
  const query = parseNoteQuery({ q: '[1]' });
  const before = structuredClone(query);
  const keys = NOTE_SORT_OPTIONS.map(({ value }) => folderReadIdentity(query, value));
  expect(new Set(keys).size).toBe(6);
  expect(folderReadIdentity(query)).toBe(folderReadIdentity(query, DEFAULT_NOTE_SORT));
  expect(folderReadIdentity(parseNoteQuery({ q: 'other' }))).not.toBe(keys[0]);
  expect(query).toEqual(before);
});
