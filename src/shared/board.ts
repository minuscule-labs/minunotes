import { isCalendarDate } from './properties';

export class BoardValidationError extends Error {}

export type BoardConfig = {
  schemaVersion: 4;
  enabled: boolean;
  mode: 'read-only';
  grouping: { type: 'select'; schemaId: string; propertyId: string };
  cardPropertyIds: string[];
};
export type SelectBoardConfig = BoardConfig;
export type BoardSchemaToken = { schemaId: string; schemaRevision: number };
export type BoardColumn = { key: string; label: string };
export type BoardGroupingState =
  | ({ type: 'select'; available: true; propertyId: string; label: string } & BoardSchemaToken)
  | { type: 'select'; available: false; reason: string };
export type BoardDisplayProperty = { propertyId: string; label: string } & (
  | { type: 'text' | 'date' }
  | { type: 'select'; options: { id: string; label: string }[] }
);
export type BoardCardProperty = { propertyId: string; label: string; value: string } & (
  | { type: 'text'; truncated: boolean }
  | { type: 'date' }
  | { type: 'select'; optionId: string }
);
export type EffectiveBoard = {
  config: BoardConfig;
  version: number;
  columns: BoardColumn[];
  groupingState: BoardGroupingState;
  reconfigurationRequired?: true;
  cardProperties?: BoardDisplayProperty[];
};
export type UnclassifiedReason = 'no-property-value' | 'unavailable-property-value';
export const UNCLASSIFIED = 'unclassified';
export const MAX_CARD_PROPERTIES = 12;
export const CARD_TEXT_PREVIEW_LENGTH = 160;
// Empty grouping is a draft, never an enabled saved configuration.
export const DEFAULT_BOARD_CONFIG: BoardConfig = {
  schemaVersion: 4,
  enabled: true,
  mode: 'read-only',
  grouping: { type: 'select', schemaId: '', propertyId: '' },
  cardPropertyIds: [],
};
const validId = (id: unknown) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);

export function validateBoardConfig(input: unknown): BoardConfig {
  if (new TextEncoder().encode(JSON.stringify(input) ?? '').length > 16384)
    throw new BoardValidationError('Configuration exceeds 16 KiB');
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new BoardValidationError('Invalid configuration');
  const value = input as Partial<BoardConfig>;
  if (value.schemaVersion !== 4 || value.mode !== 'read-only' || typeof value.enabled !== 'boolean')
    throw new BoardValidationError(
      'Boards require version 4 Card properties settings. Refresh, review and save board settings.'
    );
  if (
    Object.keys(value).some((key) => !['schemaVersion', 'enabled', 'mode', 'grouping', 'cardPropertyIds'].includes(key))
  )
    throw new BoardValidationError('Retired settings and unknown board fields are no longer supported');
  const g = value.grouping;
  if (
    !g ||
    typeof g !== 'object' ||
    Array.isArray(g) ||
    g.type !== 'select' ||
    Object.keys(g).some((key) => !['type', 'schemaId', 'propertyId'].includes(key)) ||
    ![g.schemaId, g.propertyId].every((id) => validId(id) || (!value.enabled && id === ''))
  )
    throw new BoardValidationError('Choose a Select grouping property');
  if (
    !Array.isArray(value.cardPropertyIds) ||
    value.cardPropertyIds.length > MAX_CARD_PROPERTIES ||
    !value.cardPropertyIds.every(validId) ||
    new Set(value.cardPropertyIds).size !== value.cardPropertyIds.length
  )
    throw new BoardValidationError('Choose up to 12 unique valid Card properties');
  return {
    schemaVersion: 4,
    enabled: value.enabled,
    mode: 'read-only',
    grouping: { type: 'select', schemaId: g.schemaId, propertyId: g.propertyId },
    cardPropertyIds: [...value.cardPropertyIds],
  };
}

/** Read-only compatibility: never execute retired tag rules or rewrite stored configs on read. */
export function decodeStoredBoardConfig(input: unknown): { config: BoardConfig; requiresReview: boolean } {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new BoardValidationError('Invalid stored board configuration');
  const value = input as Record<string, unknown>;
  if (value.schemaVersion === 4) return { config: validateBoardConfig(input), requiresReview: false };
  if (
    ![1, 2, 3].includes(value.schemaVersion as number) ||
    typeof value.enabled !== 'boolean' ||
    value.mode !== 'read-only'
  )
    throw new BoardValidationError('Unsupported stored board configuration');
  if (value.schemaVersion === 1)
    return { config: { ...DEFAULT_BOARD_CONFIG, enabled: value.enabled }, requiresReview: true };
  if (
    value.schemaVersion === 3 &&
    Object.keys(value).some(
      (key) => !['schemaVersion', 'enabled', 'mode', 'grouping', 'cardTypePropertyId'].includes(key)
    )
  )
    throw new BoardValidationError('Invalid stored version 3 configuration');
  const config = validateBoardConfig({
    schemaVersion: 4,
    enabled: value.enabled,
    mode: value.mode,
    grouping: value.grouping,
    cardPropertyIds: value.cardTypePropertyId === undefined ? [] : [value.cardTypePropertyId],
  });
  // Missing/malformed constraints fail closed too. Empty inactive mappings have no effect on Select grouping.
  const requiresReview =
    value.schemaVersion === 2 &&
    ![value.includeTags, value.excludeTags].every((list) => Array.isArray(list) && list.length === 0);
  return { config, requiresReview };
}

/** Scalar inputs only; SQL callers bound Text to 161 code points before mapping. Never return raw values. */
export function previewBoardProperty(definition: BoardDisplayProperty, raw: unknown): BoardCardProperty | undefined {
  if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0')) return;
  const base = { propertyId: definition.propertyId, label: definition.label };
  if (definition.type === 'select') {
    const option = definition.options.find((o) => o.id === raw);
    return option ? { ...base, type: 'select', optionId: option.id, value: option.label } : undefined;
  }
  if (definition.type === 'date') return isCalendarDate(raw) ? { ...base, type: 'date', value: raw } : undefined;
  const points = Array.from(raw);
  return {
    ...base,
    type: 'text',
    value: points.slice(0, CARD_TEXT_PREVIEW_LENGTH).join(''),
    truncated: points.length > CARD_TEXT_PREVIEW_LENGTH,
  };
}
