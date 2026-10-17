import { describe, expect, it } from 'vitest';
import {
  isCalendarDate,
  mutatePropertyDefinitions,
  parseOptionDeletion,
  patchPropertyValues,
  removePropertyOption,
} from '../src/shared/properties';

let next = 0;
const id = (prefix: string) => `${prefix}_${++next}`;
const field = () =>
  mutatePropertyDefinitions([], { type: 'add', label: 'Status', fieldType: 'select', options: ['Todo', 'Done'] }, id);
describe('property validation', () => {
  it('preserves stable IDs on rename/reorder, rejects replacement attributes, and enforces option archive limits', () => {
    const fields = field(),
      original = fields[0];
    let renamed = mutatePropertyDefinitions(fields, { type: 'rename', propertyId: original.id, label: 'Phase' }, id);
    renamed = mutatePropertyDefinitions(
      renamed,
      { type: 'rename_option', propertyId: original.id, optionId: original.options[0].id, label: 'Next' },
      id
    );
    const reordered = mutatePropertyDefinitions(
      renamed,
      { type: 'reorder_options', propertyId: original.id, optionIds: original.options.map((o) => o.id).reverse() },
      id
    );
    expect(reordered[0].id).toBe(original.id);
    expect(reordered[0].type).toBe('select');
    expect(reordered[0].options[1].id).toBe(original.options[0].id);
    expect(() =>
      mutatePropertyDefinitions(
        fields,
        { type: 'rename', propertyId: original.id, label: 'Changed', fieldType: 'date' },
        id
      )
    ).toThrow('immutable');
    expect(() =>
      mutatePropertyDefinitions(fields, { type: 'add', label: 'Injected', fieldType: 'text', id: 'client-id' }, id)
    ).toThrow('server-generated');
    expect(() =>
      mutatePropertyDefinitions(
        fields,
        { type: 'reorder_options', propertyId: original.id, optionIds: [original.options[0].id] },
        id
      )
    ).toThrow('historical');
    const archived = mutatePropertyDefinitions(
      fields,
      { type: 'archive_option', propertyId: original.id, optionId: original.options[0].id },
      id
    );
    expect(() =>
      mutatePropertyDefinitions(
        archived,
        { type: 'archive_option', propertyId: original.id, optionId: original.options[1].id },
        id
      )
    ).toThrow('1–8');
    const text = mutatePropertyDefinitions([], { type: 'add', label: 'Text', fieldType: 'text' }, id);
    expect(patchPropertyValues({ [text[0].id]: 'previous' }, text, { [text[0].id]: '' })).toEqual({});
  });
  it('deletes only the selected active option, retaining IDs/order/archives without changing its input', () => {
    const fields = field();
    fields[0].options.push({ id: 'retired', label: 'Old', archived: true });
    const before = structuredClone(fields);
    const removed = removePropertyOption(fields, fields[0].id, fields[0].options[0].id);
    expect(fields).toEqual(before);
    expect(removed[0].options).toEqual(before[0].options.slice(1));
    expect(() => removePropertyOption(removed, fields[0].id, fields[0].options[1].id)).toThrow('at least one');
    for (const [propertyId, optionId] of [
      ['missing', 'retired'],
      [fields[0].id, 'missing'],
      [fields[0].id, 'retired'],
    ])
      expect(() => removePropertyOption(fields, propertyId, optionId)).toThrow('not found');
    fields[0].type = 'text';
    expect(() => removePropertyOption(fields, fields[0].id, fields[0].options[0].id)).toThrow('not found');
    fields[0].type = 'select';
    fields[0].archived = true;
    expect(() => removePropertyOption(fields, fields[0].id, fields[0].options[0].id)).toThrow('not found');
  });
  it('requires strict reviewed deletion tokens and rejects unsupported attributes', () => {
    const valid = { schemaId: 'schema', expectedRevision: 1, impactToken: 'a'.repeat(64) };
    expect(parseOptionDeletion(valid)).toEqual(valid);
    for (const invalid of [
      null,
      [],
      {},
      { ...valid, schemaId: '' },
      { ...valid, expectedRevision: -1 },
      { ...valid, impactToken: 'guessed' },
      { ...valid, force: true },
      JSON.parse('{"__proto__":{}}'),
    ])
      expect(() => parseOptionDeletion(invalid)).toThrow();
  });
  it('validates real date-only calendar values', () => {
    for (const date of ['2024-02-29', '2000-02-29', '2026-12-31', '0001-01-01'])
      expect(isCalendarDate(date)).toBe(true);
    for (const date of ['1900-02-29', '2026-02-29', '2024-04-31', '0000-01-01', '2026-1-01', '2026-01-01T00:00:00Z'])
      expect(isCalendarDate(date)).toBe(false);
  });
  it('enforces limits, labels and immutable types', () => {
    expect(() =>
      mutatePropertyDefinitions([], { type: 'add', label: 'x'.repeat(81), fieldType: 'text' }, id)
    ).toThrow();
    expect(() =>
      mutatePropertyDefinitions([], { type: 'add', label: 'S', fieldType: 'select', options: [] }, id)
    ).toThrow();
    expect(() =>
      mutatePropertyDefinitions([], { type: 'add', label: 'S', fieldType: 'select', options: ['A', 'a'] }, id)
    ).toThrow('Duplicate');
    let fields = field();
    expect(() =>
      mutatePropertyDefinitions(fields, { type: 'change_type', propertyId: fields[0].id, fieldType: 'date' }, id)
    ).toThrow();
    for (let i = 1; i < 12; i++)
      fields = mutatePropertyDefinitions(fields, { type: 'add', label: `F${i}`, fieldType: 'text' }, id);
    expect(() => mutatePropertyDefinitions(fields, { type: 'add', label: 'F12', fieldType: 'text' }, id)).toThrow('12');
    expect(() => mutatePropertyDefinitions(fields, { type: 'reorder', propertyIds: [] }, id)).toThrow('historical');
  });
  it('rejects wrong/foreign/unsafe values and retains archived state', () => {
    const fields = field(),
      key = fields[0].id,
      choice = fields[0].options[0].id;
    expect(() => patchPropertyValues({}, fields, { [key]: 'foreign' })).toThrow();
    expect(() => patchPropertyValues({}, fields, { [key]: 123 })).toThrow();
    expect(() => patchPropertyValues({}, fields, JSON.parse('{"__proto__":"bad"}'))).toThrow();
    const archived = mutatePropertyDefinitions(
      fields,
      { type: 'archive_option', propertyId: key, optionId: choice },
      id
    );
    expect(patchPropertyValues({ [key]: choice, old: 'retained' }, archived, {})).toEqual({
      [key]: choice,
      old: 'retained',
    });
    expect(() => patchPropertyValues({}, archived, { [key]: choice })).toThrow();
    const text = mutatePropertyDefinitions([], { type: 'add', label: 'T', fieldType: 'text' }, id);
    expect(() => patchPropertyValues({}, text, { [text[0].id]: 'x'.repeat(1001) })).toThrow();
    expect(patchPropertyValues({ [key]: choice }, fields, { [key]: null })).toEqual({});
  });
});
