import { describe, expect, it } from 'vitest';
import { NoteQueryError, noteQueryIdentity, noteQuerySearch, parseNoteQuery } from '../src/shared/note-filters';

const field = {
  schemaId: 'schema_A',
  propertyId: 'field_A',
  type: 'text',
  operator: 'contains',
  value: 'literal %_\\',
};
const filters = (all: unknown[]) => JSON.stringify({ version: 1, all });
describe('folder-owned note query contract', () => {
  it('normalizes only empty search, retains literal spaces and omits empty parameters', () => {
    expect(noteQuerySearch(parseNoteQuery({}))).toEqual({});
    expect(noteQuerySearch(parseNoteQuery({ q: '  ' }))).toEqual({});
    expect(noteQuerySearch(parseNoteQuery({ q: '  Literal  ' }))).toEqual({ q: '  Literal  ' });
    expect(parseNoteQuery({ filters: filters([]) }).filters.all).toEqual([]);
  });
  it('canonicalizes field and option set order without changing terms', () => {
    const select = {
      schemaId: 'schema_A',
      propertyId: 'field_B',
      type: 'select',
      operator: 'anyOf',
      optionIds: ['b', 'a'],
    };
    const a = parseNoteQuery({ q: '%_\\', filters: filters([select, field]) });
    const b = parseNoteQuery({ q: '%_\\', filters: filters([field, { ...select, optionIds: ['a', 'b'] }]) });
    expect(noteQueryIdentity(a)).toBe(noteQueryIdentity(b));
    expect(parseNoteQuery(noteQuerySearch(a))).toEqual(a);
  });
  it.each([
    { q: ['repeated'] },
    { q: 12 },
    { q: 'x'.repeat(201) },
    { filters: '{}' },
    { filters: '{broken' },
    { filters: filters([{ ...field, extra: true }]) },
    { filters: filters([{ ...field, type: { toString: 1 } }]) },
    { filters: filters([{ ...field, propertyId: 'bad.path' }]) },
    { filters: filters([{ ...field, schemaId: '' }]) },
    { filters: filters([field, field]) },
    { filters: filters([{ ...field, value: ' \t' }]) },
    { filters: filters([{ ...field, value: 'x'.repeat(201) }]) },
    { filters: filters([{ ...field, operator: 'regex' }]) },
    { filters: filters([{ ...field, type: 'select', operator: 'anyOf', optionIds: [] }]) },
    {
      filters: filters([
        { schemaId: 'schema_A', propertyId: 'f', type: 'select', operator: 'anyOf', optionIds: ['a', 'a'] },
      ]),
    },
    {
      filters: filters([
        {
          schemaId: 'schema_A',
          propertyId: 'f',
          type: 'select',
          operator: 'anyOf',
          optionIds: Array.from({ length: 9 }, (_, i) => `o${i}`),
        },
      ]),
    },
    { filters: JSON.stringify({ version: 2, all: [] }) },
    { filters: filters(Array.from({ length: 13 }, (_, i) => ({ ...field, propertyId: `p${i}` }))) },
  ])('rejects invalid query %# without broadening', (input) =>
    expect(() => parseNoteQuery(input)).toThrow(NoteQueryError));
  it('validates typed operators, calendar dates and inclusive ordered ranges', () => {
    const date = {
      schemaId: 'schema_A',
      propertyId: 'date',
      type: 'date',
      operator: 'between',
      from: '2028-02-29',
      to: '2028-03-01',
    };
    expect(parseNoteQuery({ filters: filters([date]) }).filters.all).toHaveLength(1);
    for (const clause of [
      { ...date, from: '2026-02-29' },
      { ...date, from: '2028-03-02' },
      { ...date, to: '2028-13-01' },
    ])
      expect(() => parseNoteQuery({ filters: filters([clause]) })).toThrow(NoteQueryError);
    for (const type of ['text', 'date', 'select'])
      expect(
        parseNoteQuery({ filters: filters([{ schemaId: 's', propertyId: 'p', type, operator: 'empty' }]) }).filters.all
      ).toHaveLength(1);
  });
  it('accepts the maximum twelve clauses and eight options when the encoded document fits', () => {
    const all = Array.from({ length: 12 }, (_, i) => ({
      schemaId: 's',
      propertyId: `p${i}`,
      type: 'text',
      operator: 'empty',
    }));
    expect(parseNoteQuery({ filters: filters(all) }).filters.all).toHaveLength(12);
    const optionIds = Array.from({ length: 8 }, (_, i) => `option_${i}`);
    expect(
      parseNoteQuery({
        filters: filters([{ schemaId: 's', propertyId: 'p', type: 'select', operator: 'anyOf', optionIds }]),
      }).filters.all
    ).toHaveLength(1);
    expect(parseNoteQuery({ q: '😀'.repeat(200) }).q).toBe('😀'.repeat(200));
  });
  it('enforces the encoded overall query budget without truncation', () => {
    expect(() =>
      parseNoteQuery({
        filters: filters(
          Array.from({ length: 12 }, (_, i) => ({ ...field, propertyId: `p${i}`, value: '😀'.repeat(200) }))
        ),
      })
    ).toThrow('Shorten');
  });
});
