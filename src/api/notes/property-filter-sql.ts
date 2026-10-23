import { and, type SQL, sql } from 'drizzle-orm';
import { NOTE_FILTER_WHITESPACE, type NoteQuery } from '../../shared/note-filters';
import { PropertyError, type PropertySchema } from '../../shared/properties';
import { notePropertyState, notes } from '../db/schema';

const literal = (value: string) => `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
const stale = (): never => {
  throw new PropertyError(
    'A filtered property or option is unavailable or changed. Refresh definitions and review or remove the condition.',
    409
  );
};

/** Compile only current-schema scalar predicates; callers supply authorized scope and snapshot transaction. */
export function propertyFilterSql(query: NoteQuery, schema?: PropertySchema): SQL | undefined {
  const predicates: SQL[] = [];
  if (query.q) predicates.push(sql`${notes.title} like ${literal(query.q)} escape ${'\\'}`);
  if (!query.filters.all.length) return and(...predicates);
  if (!schema) return stale();
  const values = sql`case when json_valid(${notePropertyState.values}) then ${notePropertyState.values} else ${'{}'} end`;
  const validMap = sql`(${notePropertyState.values} is null or (json_valid(${notePropertyState.values}) and json_type(${values}) = 'object'))`;
  predicates.push(validMap);
  for (const filter of query.filters.all) {
    const field = schema.definitions.find((d) => d.id === filter.propertyId && !d.archived && d.type === filter.type);
    if (filter.schemaId !== schema.schemaId || !field) return stale();
    const path = `$."${filter.propertyId}"`;
    const kind = sql`json_type(${values}, ${path})`;
    const value = sql`json_extract(${values}, ${path})`;
    const scalar = sql`(${kind} = 'text' and instr(${value}, char(0)) = 0)`;
    const empty = sql`(${kind} is null or ${kind} = 'null' or (${scalar} and trim(${value}, ${NOTE_FILTER_WHITESPACE}) = ''))`;
    if (filter.operator === 'empty') {
      predicates.push(empty);
    } else if (filter.type === 'text' && filter.operator === 'contains') {
      predicates.push(sql`(${scalar} and ${value} like ${literal(filter.value)} escape ${'\\'})`);
    } else if (filter.type === 'select') {
      const options = filter.operator === 'is' ? [filter.optionId] : filter.optionIds;
      if (options.some((id) => !field.options.some((o) => o.id === id && !o.archived))) return stale();
      const selected = options.length
        ? sql`(${scalar} and ${value} in (${sql.join(
            options.map((id) => sql`${id}`),
            sql`, `
          )}))`
        : sql`0`;
      predicates.push(filter.operator === 'anyOf' && filter.includeEmpty ? sql`(${selected} or ${empty})` : selected);
    } else if (filter.type === 'date') {
      // Match isCalendarDate: SQLite normalizes invalid days but also accepts year zero, which we reject.
      // Shape and NUL guards prevent prefix coercion.
      predicates.push(
        sql`(${scalar} and length(${value}) = 10 and substr(${value}, 1, 4) <> '0000' and ${value} glob ${'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'} and date(${value}, '+0 days') = ${value})`
      );
      if (filter.operator === 'between')
        predicates.push(sql`(${value} >= ${filter.from} and ${value} <= ${filter.to})`);
      else if (filter.operator === 'before') predicates.push(sql`${value} < ${filter.value}`);
      else predicates.push(sql`${value} > ${filter.value}`);
    }
  }
  return and(...predicates);
}
