import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BoardValidationError,
  DEFAULT_BOARD_CONFIG,
  decodeStoredBoardConfig,
  validateBoardConfig,
} from '../src/shared/board';
import { cleanupBoardTests, setupBoardTest } from './board-fixtures';
import { setupPropertyBoardTest } from './property-board-fixtures';

afterEach(cleanupBoardTests);
const disabled = { ...DEFAULT_BOARD_CONFIG, enabled: false };
const selected = { ...DEFAULT_BOARD_CONFIG, grouping: { type: 'select', schemaId: 'schema_A', propertyId: 'field_A' } };
const { columnVisibility: _visibility, ...v4Base } = selected;
const legacy = { ...v4Base, schemaVersion: 2, lanes: [], includeTags: [], excludeTags: [] };

describe('property-only board contract', () => {
  it('accepts zero through twelve unique v5 display IDs and rejects old writes without clearing visibility', () => {
    const current = { ...selected, schemaVersion: 5, cardPropertyIds: [] };
    for (const count of [0, 1, 12]) {
      const cardPropertyIds = Array.from({ length: count }, (_, i) => `field_${i}`);
      expect(validateBoardConfig({ ...current, cardPropertyIds })).toEqual({ ...current, cardPropertyIds });
    }
    for (const cardPropertyIds of [undefined, null, '', ['a', 'a'], ['bad.path'], [42], Array(13).fill('a')])
      expect(() => validateBoardConfig({ ...current, cardPropertyIds })).toThrow(BoardValidationError);
    expect(() => validateBoardConfig({ ...current, schemaVersion: 3 })).toThrow('Refresh');
    expect(() => validateBoardConfig({ ...current, cardTypePropertyId: 'a' })).toThrow();
  });
  it('decodes a v3 single selection without mutation, including the grouping property', () => {
    const stored = {
      schemaVersion: 3,
      enabled: true,
      mode: 'read-only',
      grouping: selected.grouping,
      cardTypePropertyId: selected.grouping.propertyId,
    };
    const before = JSON.stringify(stored);
    expect(decodeStoredBoardConfig(stored)).toEqual({
      config: { ...selected, cardPropertyIds: [selected.grouping.propertyId] },
      requiresReview: false,
    });
    expect(JSON.stringify(stored)).toBe(before);
    expect(decodeStoredBoardConfig({ ...stored, cardTypePropertyId: undefined }).config.cardPropertyIds).toEqual([]);
  });
  it('accepts explicit properties and disabled empty selections, never tag settings', () => {
    expect(validateBoardConfig(selected)).toEqual(selected);
    expect(validateBoardConfig(disabled)).toEqual(disabled);
    expect(validateBoardConfig({ ...selected, cardPropertyIds: ['type_A'] })).toMatchObject({
      cardPropertyIds: ['type_A'],
    });
  });
  it.each([
    null,
    [],
    {},
    DEFAULT_BOARD_CONFIG,
    legacy,
    { ...selected, schemaVersion: 1 },
    { ...selected, mode: 'moves' },
    { ...selected, lanes: [] },
    { ...selected, includeTags: [] },
    { ...selected, excludeTags: [] },
    { ...selected, grouping: { type: 'tags' } },
    { ...selected, grouping: { ...selected.grouping, extra: true } },
    { ...selected, grouping: { ...selected.grouping, propertyId: 'bad.path' } },
    { ...selected, cardTypePropertyId: '' },
    { ...selected, extra: 'x'.repeat(16384) },
  ])('rejects invalid or retired write config %#', (input) =>
    expect(() => validateBoardConfig(input)).toThrow(BoardValidationError));
  it('decodes only harmless property legacy configs without requiring reconfiguration', () => {
    expect(decodeStoredBoardConfig(selected)).toEqual({ config: selected, requiresReview: false });
    expect(decodeStoredBoardConfig(legacy)).toEqual({ config: selected, requiresReview: false });
    for (const extra of [
      { includeTags: ['project'] },
      { excludeTags: ['private'] },
      { includeTags: null },
      { excludeTags: undefined },
    ])
      expect(decodeStoredBoardConfig({ ...legacy, ...extra })).toMatchObject({
        config: selected,
        requiresReview: true,
      });
    expect(decodeStoredBoardConfig({ schemaVersion: 1, mode: 'read-only', enabled: true })).toMatchObject({
      requiresReview: true,
    });
    expect(() => decodeStoredBoardConfig({ ...legacy, schemaVersion: 99 })).toThrow();
  });
});

describe('visible column contract', () => {
  const choices = [
    { mode: 'all', showUnclassified: true },
    { mode: 'all', showUnclassified: false },
    { mode: 'selected', optionIds: ['option_todo'], showUnclassified: true },
    { mode: 'selected', optionIds: ['option_todo'], showUnclassified: false },
    { mode: 'selected', optionIds: [], showUnclassified: true },
    { mode: 'selected', optionIds: [], showUnclassified: false },
  ];
  it.each(choices)('round trips $mode / Unclassified $showUnclassified without changing intent', (columnVisibility) => {
    const config = { ...selected, columnVisibility };
    expect(validateBoardConfig(config)).toEqual(config);
    expect(decodeStoredBoardConfig(config)).toEqual({ config, requiresReview: false });
    expect(validateBoardConfig({ ...disabled, columnVisibility })).toMatchObject({ columnVisibility });
  });
  it('keeps explicit selections, including unavailable IDs, independent of the input and defaults', () => {
    for (const count of [0, 1, 8]) {
      const optionIds = Array.from({ length: count }, (_, i) => `option_${i}`);
      const config = { ...selected, columnVisibility: { mode: 'selected', optionIds, showUnclassified: false } };
      const before = JSON.stringify(config);
      const result = validateBoardConfig(config);
      expect(result).toEqual(config);
      expect(JSON.stringify(config)).toBe(before);
      expect(result.columnVisibility).not.toBe(config.columnVisibility);
      if (result.columnVisibility.mode === 'selected') {
        result.columnVisibility.optionIds.push('option_unavailable');
        expect(optionIds).toHaveLength(count);
      }
    }
    const first = decodeStoredBoardConfig({ schemaVersion: 1, mode: 'read-only', enabled: true }).config;
    first.columnVisibility.showUnclassified = false;
    expect(DEFAULT_BOARD_CONFIG.columnVisibility.showUnclassified).toBe(true);
  });
  it.each([
    undefined,
    null,
    [],
    {},
    'all',
    { mode: 'all' },
    { mode: 'all', showUnclassified: 'false' },
    { mode: 'all', showUnclassified: true, optionIds: [] },
    { mode: 'all', showUnclassified: true, extra: true },
    { mode: 'unknown', showUnclassified: true },
    { mode: ['all'], showUnclassified: true },
    { mode: 'selected', showUnclassified: true },
    { mode: 'selected', optionIds: null, showUnclassified: true },
    { mode: 'selected', optionIds: 'option_a', showUnclassified: true },
    { mode: 'selected', optionIds: [], showUnclassified: null },
    { mode: 'selected', optionIds: ['a', 'a'], showUnclassified: true },
    { mode: 'selected', optionIds: [42], showUnclassified: true },
    { mode: 'selected', optionIds: [''], showUnclassified: true },
    { mode: 'selected', optionIds: ['bad.path'], showUnclassified: true },
    { mode: 'selected', optionIds: ['a'.repeat(101)], showUnclassified: true },
    { mode: 'selected', optionIds: Array(1), showUnclassified: true },
    { mode: 'selected', optionIds: Array.from({ length: 9 }, (_, i) => `o_${i}`), showUnclassified: true },
    { mode: 'selected', optionIds: [], showUnclassified: true, extra: true },
  ])('rejects malformed visibility %# on both writes and stored reads', (columnVisibility) => {
    const config = { ...selected, columnVisibility };
    expect(() => validateBoardConfig(config)).toThrow(BoardValidationError);
    expect(() => decodeStoredBoardConfig(config)).toThrow(BoardValidationError);
  });
  it('strictly validates stored v4 before supplying fresh All defaults, without mutating it', () => {
    const stored = { ...v4Base, schemaVersion: 4, cardPropertyIds: ['field_extra'] };
    const before = JSON.stringify(stored);
    const decoded = decodeStoredBoardConfig(stored);
    expect(decoded).toEqual({
      config: { ...selected, cardPropertyIds: ['field_extra'] },
      requiresReview: false,
    });
    expect(JSON.stringify(stored)).toBe(before);
    decoded.config.cardPropertyIds.push('another');
    decoded.config.columnVisibility.showUnclassified = false;
    expect(decodeStoredBoardConfig(stored).config).toEqual({ ...selected, cardPropertyIds: ['field_extra'] });
    for (const invalid of [
      { ...stored, columnVisibility: { mode: 'selected', optionIds: [], showUnclassified: false } },
      { ...stored, extra: true },
      { ...stored, cardPropertyIds: undefined },
      { ...stored, cardPropertyIds: ['duplicate', 'duplicate'] },
      { ...stored, grouping: { ...stored.grouping, extra: true } },
    ])
      expect(() => decodeStoredBoardConfig(invalid)).toThrow(BoardValidationError);
    expect(() => validateBoardConfig(stored)).toThrow('Refresh');
  });
});

describe('board configuration authorization and atomicity', () => {
  it('allows only owners to save; collaborators read but cannot configure', async () => {
    const f = await setupBoardTest();
    expect((await f.save()).status).toBe(200);
    for (const actor of ['viewer', 'commenter', 'editor']) {
      expect((await f.request('/internal/folders/board/board/config', actor)).status).toBe(200);
      expect((await f.save(disabled, 1, actor)).status).toBe(403);
    }
    expect((await f.request('/internal/folders/board/board/config', 'stranger')).status).toBe(404);
    expect((await f.request('/internal/folders/board/board/config', 'anonymous')).status).toBe(401);
    expect((await f.save(disabled, 0, 'owner', 'foreign')).status).toBe(404);
    expect((await f.request('/internal/folders/board/board?lane=unclassified')).status).toBe(404);
  });
  it('rejects stale creates and competing updates without upgrading tokens', async () => {
    const f = await setupBoardTest();
    expect((await f.save()).status).toBe(200);
    expect((await f.save()).status).toBe(409);
    const results = await Promise.all([f.save(disabled, 1), f.save(disabled, 1)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await f.boards.readBoardConfig('owner', 'board')).toMatchObject({ version: 2 });
    expect(await f.boards.readBoardConfig('other-user', 'board')).toBeNull();
  });
  it('rejects competing writes from independent clients', async () => {
    const f = await setupBoardTest();
    await f.save();
    vi.resetModules();
    const [{ libsql }, second] = await Promise.all([import('../src/api/db/client'), import('../src/api/notes/boards')]);
    try {
      const results = await Promise.allSettled([
        f.boards.saveBoardConfig('owner', 'board', disabled, 1),
        second.saveBoardConfig('owner', 'board', disabled, 1),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled' && r.value)).toHaveLength(1);
      expect(await f.boards.readBoardConfig('owner', 'board')).toMatchObject({ version: 2 });
    } finally {
      libsql.close();
    }
  });
  it('rejects invalid versions, oversized and retired payloads without writes', async () => {
    const f = await setupBoardTest();
    for (const version of [-1, 1.5, '0', null, Number.MAX_SAFE_INTEGER])
      expect((await f.save(disabled, version)).status).toBe(400);
    expect((await f.save(legacy)).status).toBe(400);
    expect((await f.save({ ...disabled, extra: 'x'.repeat(16384) })).status).toBe(413);
    for (const body of ['null', '{', '{}'])
      expect((await f.app.request('/internal/folders/board/board/config', { method: 'PUT', body })).status).toBe(400);
    expect(await f.boards.readBoardConfig('owner', 'board')).toBeNull();
  });
  it('does not expose infrastructure diagnostics as validation errors', async () => {
    const f = await setupBoardTest();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const writer = vi.spyOn(f.boards, 'saveBoardConfig').mockRejectedValue(new Error('Private database diagnostic'));
    try {
      const response = await f.save();
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain('Private database diagnostic');
    } finally {
      writer.mockRestore();
      log.mockRestore();
    }
  });
  it('reads unconstrained legacy Select configs with identical grouping and no background rewrite', async () => {
    const f = await setupPropertyBoardTest();
    const stored = { ...legacy, ...f.config, schemaVersion: 2 };
    await f.addNote('n', 'N', ['ordinary-tag']);
    await f.patch('n', { [f.field.id]: f.field.options[0].id });
    await f.db.insert(f.schema.folderBoardViews).values({
      userId: 'owner',
      folderId: 'board',
      config: JSON.stringify(stored),
      version: 4,
      createdAt: f.now,
      updatedAt: f.now,
    });
    const tables = ['folder_board_views', 'notes', 'note_tags', 'note_property_state', 'note_events'];
    const before = await Promise.all(
      tables.map(async (table) => (await f.libsql.execute(`select * from ${table}`)).rows)
    );
    const board = await f.boards.readBoardConfig('owner', 'board');
    expect(board).toMatchObject({ version: 4, config: f.config, groupingState: { available: true } });
    expect(board?.reconfigurationRequired).toBeUndefined();
    const response = await f.request(f.laneUrl(f.field.options[0].id, 1, 4), 'viewer');
    expect(response.status).toBe(200);
    expect((await response.json()).cards).toMatchObject([{ id: 'n' }]);
    expect(
      await Promise.all(tables.map(async (table) => (await f.libsql.execute(`select * from ${table}`)).rows))
    ).toEqual(before);
  });
  it.each([
    1, 2,
  ])('blocks retired version %i configs until explicit owner save without modifying notes or tags', async (version) => {
    const f = await setupPropertyBoardTest();
    await f.addNote('n', 'N', ['ordinary-tag', 'status-todo']);
    const stored = { ...legacy, ...f.config, schemaVersion: version, includeTags: ['project'], excludeTags: [] };
    await f.db.insert(f.schema.folderBoardViews).values({
      userId: 'owner',
      folderId: 'board',
      config: JSON.stringify(stored),
      version: 7,
      createdAt: f.now,
      updatedAt: f.now,
    });
    const tables = ['notes', 'note_tags', 'note_property_state', 'note_events'];
    const before = await Promise.all(
      tables.map(async (table) => (await f.libsql.execute(`select * from ${table}`)).rows)
    );
    for (const actor of ['owner', 'viewer', 'editor']) {
      const read = await (await f.request('/internal/folders/board/board/config', actor)).json();
      expect(read.board).toMatchObject({
        version: 7,
        reconfigurationRequired: true,
        columns: [],
        groupingState: { available: false },
      });
      expect((await f.request(f.laneUrl('unclassified', 1, 7), actor)).status).toBe(409);
    }
    expect((await f.libsql.execute('select config from folder_board_views')).rows[0].config).toBe(
      JSON.stringify(stored)
    );
    expect((await f.saveSelect(f.config, 7, 'viewer')).status).toBe(403);
    expect((await f.saveSelect(f.config, 7)).status).toBe(200);
    expect(await f.boards.readBoardConfig('owner', 'board')).toMatchObject({
      version: 8,
      groupingState: { available: true },
    });
    expect(
      await Promise.all(tables.map(async (table) => (await f.libsql.execute(`select * from ${table}`)).rows))
    ).toEqual(before);
  });
});
