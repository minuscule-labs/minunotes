import {
  PropertyError,
  type PropertySchema,
  type PropertyValues,
  patchPropertyValues,
  propertyRevision,
} from './properties';
import { normalizeTagName } from './tags';

export type TemplateVariables = { date: string; time: string; datetime: string };
export type AssignedTemplate = { id: string; title: string };
export type TemplatePreview = {
  template: AssignedTemplate & { body: string };
  tags: string[];
  values: PropertyValues;
  schema: PropertySchema;
  snapshot: string;
};
export type TemplateDefaults = {
  revision: number;
  tags: string[];
  assignments: Array<{
    id: string;
    folderId: string;
    title: string;
    revision: number;
    schemaId: string | null;
    values: PropertyValues;
  }>;
};
export type TemplateCreation = {
  folderId: string;
  templateId: string;
  snapshot: string;
  schemaId: string | null;
  schemaRevision: number;
  title: string;
  tags: string[];
  values: Record<string, string | null>;
  requestId: string;
  variables: TemplateVariables;
};
export function templateObject(input: unknown, keys?: string[]): Record<string, unknown> {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Object.keys(input).some((k) => ['__proto__', 'constructor', 'prototype'].includes(k) || (keys && !keys.includes(k)))
  )
    throw new PropertyError('Invalid or unknown template attributes');
  return input as Record<string, unknown>;
}
export function templateString(input: unknown, max: number, empty = false): string {
  if (typeof input !== 'string' || (!empty && !input.trim()) || input.length > max)
    throw new PropertyError(`Expected ${empty ? '0' : '1'}–${max} characters`);
  return input;
}
export function templateTags(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 50) throw new PropertyError('At most 50 tags are allowed');
  const tags = input.map((v) => normalizeTagName(templateString(v, 80)));
  if (tags.some((t) => !t) || new Set(tags).size !== tags.length)
    throw new PropertyError('Empty or duplicate normalized tags');
  return tags;
}
export function templateSchemaId(input: unknown) {
  return input === null ? null : templateString(input, 100);
}
export function templateValues(input: unknown, schema: PropertySchema): PropertyValues {
  return patchPropertyValues({}, schema.definitions, templateObject(input));
}
export function parseTemplateCreation(input: unknown): TemplateCreation {
  const v = templateObject(input, [
    'folderId',
    'templateId',
    'snapshot',
    'schemaId',
    'schemaRevision',
    'title',
    'tags',
    'values',
    'requestId',
    'variables',
  ]);
  const vars = templateObject(v.variables, ['date', 'time', 'datetime']);
  const requestId = templateString(v.requestId, 128);
  // SQLite length() stops at NUL; reject it before any receipt/creation write.
  if (requestId.includes('\0')) throw new PropertyError('Invalid request ID');
  const values = templateObject(v.values);
  if (
    Object.keys(values).length > 12 ||
    Object.entries(values).some(
      ([k, val]) => k.length > 100 || (val !== null && (typeof val !== 'string' || val.length > 1000))
    )
  )
    throw new PropertyError('Invalid property values');
  return {
    folderId: templateString(v.folderId, 100),
    templateId: templateString(v.templateId, 100),
    snapshot: templateString(v.snapshot, 128),
    schemaId: templateSchemaId(v.schemaId),
    schemaRevision: propertyRevision(v.schemaRevision),
    title: templateString(v.title, 1000).trim(),
    tags: templateTags(v.tags),
    values: values as TemplateCreation['values'],
    requestId,
    variables: {
      date: templateString(vars.date, 80, true),
      time: templateString(vars.time, 80, true),
      datetime: templateString(vars.datetime, 80, true),
    },
  };
}
/** Preserve only the original four literal substitutions. No clock or script evaluation. */
export function renderTemplate(body: string, title: string, variables: TemplateVariables) {
  return body.replace(/\{\{(title|date|time|datetime)\}\}/g, (_, key: string) =>
    key === 'title' ? title : variables[key as keyof TemplateVariables]
  );
}
