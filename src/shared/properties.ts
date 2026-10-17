export class PropertyError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404 | 409 = 400
  ) {
    super(message);
  }
}
export type PropertyType = 'text' | 'select' | 'date';
export type PropertyOption = { id: string; label: string; archived: boolean };
export type PropertyDefinition = {
  id: string;
  label: string;
  type: PropertyType;
  archived: boolean;
  options: PropertyOption[];
};
export type PropertyValues = Record<string, string>;
export type PropertySchema = { schemaId: string | null; revision: number; definitions: PropertyDefinition[] };
export type NoteProperties = { schema: PropertySchema; revision: number; values: PropertyValues };
export type PropertyMutation =
  | { type: 'add'; label: string; fieldType: PropertyType; options?: string[] }
  | { type: 'rename'; propertyId: string; label: string }
  | { type: 'archive'; propertyId: string }
  | { type: 'reorder'; propertyIds: string[] }
  | { type: 'add_option'; propertyId: string; label: string }
  | { type: 'rename_option'; propertyId: string; optionId: string; label: string }
  | { type: 'archive_option'; propertyId: string; optionId: string }
  | { type: 'reorder_options'; propertyId: string; optionIds: string[] };
export type SchemaMutationRequest = { expectedRevision: number; mutation: PropertyMutation };
export type OptionDeletionRequest = { schemaId: string; expectedRevision: number; impactToken: string };
export type OptionDeletionPreview = OptionDeletionRequest & {
  propertyId: string;
  optionId: string;
  propertyLabel: string;
  optionLabel: string;
  noteCount: number;
  templateDefaultCount: number;
};
export type PropertyPatch = {
  schemaId: string | null;
  schemaRevision: number;
  expectedRevision: number;
  values: Record<string, string | null>;
};
const unsafe = new Set(['__proto__', 'prototype', 'constructor']);
export function propertyRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= Number.MAX_SAFE_INTEGER)
    throw new PropertyError('A nonnegative revision is required');
  return value as number;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((k) => unsafe.has(k)))
    throw new PropertyError('Invalid object');
  return value as Record<string, unknown>;
}
function label(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80)
    throw new PropertyError('Labels must contain 1–80 characters');
  return value.trim();
}
function uniqueLabels(values: Array<{ label: string; archived: boolean }>) {
  const active = values.filter((v) => !v.archived).map((v) => v.label.toLocaleLowerCase());
  if (new Set(active).size !== active.length) throw new PropertyError('Duplicate active labels');
}
export function mutatePropertyDefinitions(
  previous: PropertyDefinition[],
  input: unknown,
  id: (prefix: string) => string
): PropertyDefinition[] {
  const m = object(input);
  const keys: Record<string, string[]> = {
    add: ['type', 'label', 'fieldType', 'options'],
    rename: ['type', 'propertyId', 'label'],
    archive: ['type', 'propertyId'],
    reorder: ['type', 'propertyIds'],
    add_option: ['type', 'propertyId', 'label'],
    rename_option: ['type', 'propertyId', 'optionId', 'label'],
    archive_option: ['type', 'propertyId', 'optionId'],
    reorder_options: ['type', 'propertyId', 'optionIds'],
  };
  if (
    typeof m.type !== 'string' ||
    !Object.hasOwn(keys, m.type) ||
    Object.keys(m).some((k) => !keys[m.type as string].includes(k))
  )
    throw new PropertyError('Unknown operation or attributes; field types are immutable and IDs are server-generated');
  const definitions: PropertyDefinition[] = structuredClone(previous);
  if (m.type === 'add') {
    if (!['text', 'select', 'date'].includes(String(m.fieldType))) throw new PropertyError('Invalid field type');
    const type = m.fieldType as PropertyType;
    if (type !== 'select' && m.options !== undefined) throw new PropertyError('Only Select has options');
    if (type === 'select' && (!Array.isArray(m.options) || m.options.length < 1 || m.options.length > 8))
      throw new PropertyError('Select requires 1–8 options');
    definitions.push({
      id: id('property'),
      label: label(m.label),
      type,
      archived: false,
      options:
        type === 'select'
          ? (m.options as unknown[]).map((v) => ({ id: id('option'), label: label(v), archived: false }))
          : [],
    });
  } else if (m.type === 'reorder') {
    if (
      !Array.isArray(m.propertyIds) ||
      m.propertyIds.length !== definitions.length ||
      new Set(m.propertyIds).size !== definitions.length ||
      m.propertyIds.some((v) => !definitions.some((d) => d.id === v))
    )
      throw new PropertyError('Reorder must include every historical property ID exactly once');
    return m.propertyIds.map((v) => definitions.find((d) => d.id === v) as PropertyDefinition);
  } else {
    const field = definitions.find((d) => d.id === m.propertyId && !d.archived);
    if (!field) throw new PropertyError('Unknown or archived property');
    if (m.type === 'rename') field.label = label(m.label);
    else if (m.type === 'archive') field.archived = true;
    else if (field.type === 'select' && m.type === 'reorder_options') {
      if (
        !Array.isArray(m.optionIds) ||
        m.optionIds.length !== field.options.length ||
        new Set(m.optionIds).size !== field.options.length ||
        m.optionIds.some((v) => !field.options.some((o) => o.id === v))
      )
        throw new PropertyError('Reorder must include every historical option ID exactly once');
      field.options = m.optionIds.map((v) => field.options.find((o) => o.id === v) as PropertyOption);
    } else if (field.type === 'select' && m.type === 'add_option')
      field.options.push({ id: id('option'), label: label(m.label), archived: false });
    else if (field.type === 'select' && (m.type === 'rename_option' || m.type === 'archive_option')) {
      const option = field.options.find((o) => o.id === m.optionId && !o.archived);
      if (!option) throw new PropertyError('Unknown or archived option');
      if (m.type === 'rename_option') option.label = label(m.label);
      else option.archived = true;
    } else throw new PropertyError('Unknown operation; field types are immutable');
  }
  if (definitions.filter((d) => !d.archived).length > 12) throw new PropertyError('At most 12 active fields');
  uniqueLabels(definitions);
  for (const field of definitions.filter((d) => !d.archived && d.type === 'select')) {
    const count = field.options.filter((o) => !o.archived).length;
    if (count < 1 || count > 8) throw new PropertyError('Select requires 1–8 active options');
    uniqueLabels(field.options);
  }
  if (new TextEncoder().encode(JSON.stringify(definitions)).length > 65536)
    throw new PropertyError('Schema exceeds 64 KiB');
  return definitions;
}
// Destructive deletion is separate from the compatible, non-destructive archive mutation.
export function removePropertyOption(
  previous: PropertyDefinition[],
  propertyId: string,
  optionId: string
): PropertyDefinition[] {
  const definitions = structuredClone(previous);
  const field = definitions.find((d) => d.id === propertyId && !d.archived && d.type === 'select');
  if (!field) throw new PropertyError('Select property not found', 404);
  const option = field.options.find((o) => o.id === optionId && !o.archived);
  if (!option) throw new PropertyError('Option not found', 404);
  if (field.options.filter((o) => !o.archived).length <= 1) throw new PropertyError('Keep at least one active option');
  field.options = field.options.filter((o) => o.id !== optionId);
  return definitions;
}
export function parseOptionDeletion(input: unknown): OptionDeletionRequest {
  const v = object(input);
  if (Object.keys(v).some((key) => !['schemaId', 'expectedRevision', 'impactToken'].includes(key)))
    throw new PropertyError('Unknown deletion attributes');
  if (typeof v.schemaId !== 'string' || !v.schemaId || v.schemaId.length > 100)
    throw new PropertyError('schemaId is required');
  if (typeof v.impactToken !== 'string' || !/^[a-f0-9]{64}$/.test(v.impactToken))
    throw new PropertyError('Review deletion impact before confirming');
  return { schemaId: v.schemaId, expectedRevision: propertyRevision(v.expectedRevision), impactToken: v.impactToken };
}
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
/** Patch only supplied active keys; all out-of-folder/archived state remains untouched. */
export function patchPropertyValues(
  previous: PropertyValues,
  definitions: PropertyDefinition[],
  input: unknown
): PropertyValues {
  const patch = object(input);
  const values = { ...previous };
  for (const [key, value] of Object.entries(patch)) {
    const field = definitions.find((d) => d.id === key && !d.archived);
    if (!field) throw new PropertyError('Unknown or archived property');
    if (value === null) {
      delete values[key];
      continue;
    }
    if (typeof value !== 'string') throw new PropertyError('Values must be strings or null');
    if (field.type === 'text' && value === '') {
      delete values[key];
      continue;
    }
    if (field.type === 'text' && value.length > 1000) throw new PropertyError('Text exceeds 1,000 characters');
    if (field.type === 'date' && !isCalendarDate(value)) throw new PropertyError('Use a real YYYY-MM-DD date');
    if (
      field.type === 'select' &&
      !field.options.some((o) => o.id === value && (!o.archived || previous[key] === value))
    )
      throw new PropertyError('Unknown or archived option');
    values[key] = value;
  }
  if (new TextEncoder().encode(JSON.stringify(values)).length > 262144)
    throw new PropertyError('Values exceed 256 KiB');
  return values;
}
export function parsePropertyPatch(input: unknown): PropertyPatch {
  const v = object(input);
  if (Object.keys(v).some((k) => !['schemaId', 'schemaRevision', 'expectedRevision', 'values'].includes(k)))
    throw new PropertyError('Unknown patch attributes');
  if (v.schemaId !== null && (typeof v.schemaId !== 'string' || v.schemaId.length > 100))
    throw new PropertyError('schemaId is required');
  return {
    schemaId: v.schemaId as string | null,
    schemaRevision: propertyRevision(v.schemaRevision),
    expectedRevision: propertyRevision(v.expectedRevision),
    values: object(v.values) as PropertyPatch['values'],
  };
}
