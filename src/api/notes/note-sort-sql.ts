import { asc, desc, sql } from 'drizzle-orm';
import { NOTE_FILTER_WHITESPACE } from '../../shared/note-filters';
import {
  DEFAULT_NOTE_SORT,
  isPropertySort,
  type NoteSort,
  noteSortSchemaError,
  sortProperty,
} from '../../shared/note-sort';
import { PropertyError, type PropertySchema } from '../../shared/properties';
import { notePropertyState, notes } from '../db/schema';

export function noteSortSql(sort: NoteSort = DEFAULT_NOTE_SORT, schema?: PropertySchema) {
  if (isPropertySort(sort)) {
    const error = noteSortSchemaError(sort, schema);
    if (error) throw new PropertyError(error, 409);
    const field = sortProperty(sort, schema);
    if (!field) throw new PropertyError('Sort property unavailable.', 409);
    // Safe even for malformed maps: sorting classifies invalid values, never filters notes out.
    const values = sql`case when json_valid(${notePropertyState.values}) then ${notePropertyState.values} else ${'{}'} end`;
    const path = `$."${sort.propertyId}"`;
    const kind = sql`json_type(${values}, ${path})`;
    const value = sql`json_extract(${values}, ${path})`;
    const scalar = sql`(json_type(${values}) = 'object' and ${kind} = 'text' and instr(${value}, char(0)) = 0 and trim(${value}, ${NOTE_FILTER_WHITESPACE}) <> '')`;
    let usable = scalar;
    let key = value;
    if (sort.type === 'date') {
      // Keep parity with isCalendarDate and property-filter-sql, including rejecting year zero.
      usable = sql`(${scalar} and length(${value}) = 10 and substr(${value},1,4) <> '0000' and ${value} glob ${'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'} and date(${value}, '+0 days') = ${value})`;
    } else if (sort.type === 'select') {
      const options = field.options.filter((option) => !option.archived);
      key = options.length
        ? sql`case ${value} ${sql.join(
            options.map((option, index) => sql`when ${option.id} then ${index}`),
            sql` `
          )} else null end`
        : sql`null`;
      usable = sql`(${scalar} and ${key} is not null)`;
    }
    const validKey = sql`case when ${usable} then ${key} else null end`;
    return [
      asc(sql`case when ${usable} then 0 else 1 end`),
      sort.direction === 'asc' ? asc(validKey) : desc(validKey),
      asc(notes.title),
      asc(notes.id),
    ];
  }
  switch (sort) {
    case 'title-asc':
      return [asc(notes.title), asc(notes.id)];
    case 'title-desc':
      return [desc(notes.title), asc(notes.id)];
    case 'created-asc':
      return [asc(notes.createdAt), asc(notes.title), asc(notes.id)];
    case 'created-desc':
      return [desc(notes.createdAt), asc(notes.title), asc(notes.id)];
    case 'updated-asc':
      return [asc(notes.updatedAt), asc(notes.title), asc(notes.id)];
    default:
      return [desc(notes.updatedAt), asc(notes.title), asc(notes.id)];
  }
}
