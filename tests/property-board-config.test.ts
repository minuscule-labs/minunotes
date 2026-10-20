import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BOARD_CONFIG, validateBoardConfig } from '../src/shared/board';
import { cleanupPropertyBoardTests, setupPropertyBoardTest } from './property-board-fixtures';

afterEach(cleanupPropertyBoardTests);

describe('Select board configuration', () => {
  it('projects All/Selected and Unclassified independently in schema order without changing other data', async () => {
    const f = await setupPropertyBoardTest();
    await f.addNote('hidden', 'Hidden', ['ordinary']);
    await f.patch('hidden', { [f.field.id]: f.field.options[1].id });
    const tables = [
      'notes',
      'note_property_state',
      'note_tags',
      'note_events',
      'folder_property_schemas',
      'collaboration_grants',
    ];
    const snapshot = () =>
      Promise.all(tables.map(async (table) => (await f.libsql.execute(`select * from ${table}`)).rows));
    const before = await snapshot();
    let version = 0;
    for (const mode of ['all', 'selected'] as const) {
      for (const showUnclassified of [false, true]) {
        // Deliberately reverse the selected IDs: schema order must win.
        const columnVisibility =
          mode === 'all'
            ? { mode, showUnclassified }
            : { mode, optionIds: [f.field.options[2].id, f.field.options[0].id], showUnclassified };
        const config = { ...f.config, columnVisibility };
        const response = await f.saveSelect(config, version++);
        expect(response.status).toBe(200);
        const { board } = await response.json();
        expect(board.config).toEqual(config);
        expect(board.groupingState.available).toBe(true);
        expect(board.columns.map((c: { key: string }) => c.key)).toEqual([
          ...(mode === 'all' ? f.field.options : [f.field.options[0], f.field.options[2]]).map((o) => o.id),
          ...(showUnclassified ? ['unclassified'] : []),
        ]);
        expect(board).not.toHaveProperty('schemaSnapshot');
        expect(board).not.toHaveProperty('activeIds');
        expect(await snapshot()).toEqual(before);
      }
    }
    for (const showUnclassified of [false, true]) {
      const response = await f.saveSelect(
        {
          ...f.config,
          columnVisibility: { mode: 'selected', optionIds: [], showUnclassified },
        },
        version++
      );
      expect(response.status).toBe(200);
      expect((await response.json()).board).toMatchObject({
        columns: showUnclassified ? [{ key: 'unclassified', label: 'Unclassified' }] : [],
        groupingState: { available: true },
      });
    }
    expect(await snapshot()).toEqual(before);
    const list = await (await f.request('/internal/folders/board/notes', 'viewer')).json();
    expect(list.notes.map((n: { id: string }) => n.id)).toContain('hidden');
    expect((await f.app.request('/internal/notes/hidden', { headers: { 'x-user': 'viewer' } })).status).toBe(200);
  });
  it('rejects unavailable and foreign selections atomically but permits disabled recovery', async () => {
    const f = await setupPropertyBoardTest();
    const t = await f.addType();
    const current = await f.properties.mutateFolderProperties(f.actor, 'board', {
      expectedRevision: 2,
      mutation: { type: 'archive_option', propertyId: f.field.id, optionId: f.field.options[3].id },
    });
    const token = { schemaId: current.schemaId as string, schemaRevision: current.revision };
    const selected = (optionIds: string[]) => ({
      ...f.config,
      columnVisibility: { mode: 'selected' as const, optionIds, showUnclassified: false },
    });
    expect((await f.saveSelect(selected([f.field.options[0].id]), 0, 'owner', token)).status).toBe(200);
    const tables = [
      'folder_board_views',
      'folder_property_schemas',
      'notes',
      'note_property_state',
      'collaboration_grants',
    ];
    const snapshot = () =>
      Promise.all(tables.map(async (table) => (await f.libsql.execute(`select * from ${table}`)).rows));
    const before = await snapshot();
    for (const id of ['unknown', 'unclassified', f.field.options[3].id, t.typeField.options[0].id]) {
      const response = await f.saveSelect(selected([f.field.options[0].id, id]), 1, 'owner', token);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain('remove unavailable selections');
      expect(await snapshot()).toEqual(before);
    }
    for (const actor of ['viewer', 'commenter', 'editor'])
      expect((await f.saveSelect(selected([]), 1, actor, token)).status).toBe(403);
    expect((await f.saveSelect(selected([]), 1, 'owner', t.token)).status).toBe(409);
    expect((await f.saveSelect(selected([]), 0, 'owner', token)).status).toBe(409);
    expect(await snapshot()).toEqual(before);
    // Disabled configs retain unavailable choices without a live-schema token.
    expect((await f.save({ ...selected(['unknown']), enabled: false }, 1)).status).toBe(200);
    expect((await f.boards.readBoardConfig('owner', 'board'))?.config.columnVisibility).toEqual({
      mode: 'selected',
      optionIds: ['unknown'],
      showUnclassified: false,
    });
  });
  it('round trips all twelve active fields, including grouping, with owner-only CAS and no value writes', async () => {
    const f = await setupPropertyBoardTest();
    let current = f.propertySchema;
    for (let i = 1; i < 12; i++)
      current = await f.addField(`Field ${i}`, i === 1 ? 'date' : 'text', [], 'board', current.revision);
    const token = { schemaId: current.schemaId as string, schemaRevision: current.revision };
    const ids = current.definitions.map((d) => d.id);
    const config = { ...f.config, cardPropertyIds: [...ids].reverse() };
    await f.addNote('n', 'N');
    const tables = ['notes', 'note_property_state', 'note_tags', 'note_events'];
    const before = await Promise.all(
      tables.map(async (table) => (await f.libsql.execute(`select * from ${table}`)).rows)
    );
    expect((await f.saveSelect(config, 0, 'owner', token)).status).toBe(200);
    expect((await f.boards.readBoardConfig('owner', 'board'))?.cardProperties?.map((d) => d.propertyId)).toEqual(ids);
    for (const actor of ['viewer', 'editor', 'commenter'])
      expect((await f.saveSelect({ ...config, cardPropertyIds: [] }, 1, actor, token)).status).toBe(403);
    expect(
      (await f.saveSelect({ ...config, cardPropertyIds: [] }, 1, 'owner', { ...token, schemaRevision: 1 })).status
    ).toBe(409);
    expect((await f.saveSelect({ ...config, cardPropertyIds: [] }, 1, 'owner', token)).status).toBe(200);
    expect((await f.saveSelect(config, 1, 'owner', token)).status).toBe(409);
    expect(
      await Promise.all(tables.map(async (table) => (await f.libsql.execute(`select * from ${table}`)).rows))
    ).toEqual(before);
  });
  it('reads stored v3 choices without rewriting and rejects old-client writes with actionable guidance', async () => {
    const f = await setupPropertyBoardTest();
    const t = await f.addType();
    const { cardPropertyIds: _ids, columnVisibility: _visibility, ...base } = t.config;
    const stored = { ...base, schemaVersion: 3, cardTypePropertyId: t.typeField.id };
    await f.db.insert(f.schema.folderBoardViews).values({
      userId: 'owner',
      folderId: 'board',
      version: 9,
      config: JSON.stringify(stored),
      createdAt: f.now,
      updatedAt: f.now,
    });
    const before = (await f.libsql.execute('select * from folder_board_views')).rows;
    const board = await f.boards.readBoardConfig('owner', 'board');
    expect(board).toMatchObject({ version: 9, config: t.config, cardProperties: [{ propertyId: t.typeField.id }] });
    const rejected = await f.saveSelect(stored, 9, 'owner', t.token);
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain('Refresh');
    expect((await f.libsql.execute('select * from folder_board_views')).rows).toEqual(before);
    expect((await f.saveSelect(t.config, 9, 'owner', t.token)).status).toBe(200);
  });
  it('reads stored v4 without mutation and rejects all older writers without erasing v5 visibility', async () => {
    const f = await setupPropertyBoardTest();
    const { columnVisibility: _visibility, ...base } = f.config;
    const stored = { ...base, schemaVersion: 4 };
    await f.addNote('n', 'N', ['ordinary-tag']);
    await f.patch('n', { [f.field.id]: f.field.options[0].id });
    await f.db.insert(f.schema.folderBoardViews).values({
      userId: 'owner',
      folderId: 'board',
      config: JSON.stringify(stored),
      version: 9,
      createdAt: f.now,
      updatedAt: f.now,
    });
    const tables = [
      'folder_board_views',
      'folder_property_schemas',
      'notes',
      'note_property_state',
      'note_tags',
      'note_events',
    ];
    const snapshot = () =>
      Promise.all(tables.map(async (table) => (await f.libsql.execute(`select * from ${table}`)).rows));
    const before = await snapshot();
    const read = await f.request('/internal/folders/board/board/config');
    expect(read.status).toBe(200);
    expect((await read.json()).board).toMatchObject({ version: 9, config: f.config });
    expect(await snapshot()).toEqual(before);

    const visibility = { mode: 'selected' as const, optionIds: [f.field.options[0].id], showUnclassified: false };
    const config = { ...f.config, columnVisibility: visibility };
    expect((await f.saveSelect(config, 9)).status).toBe(200);
    expect((await f.boards.readBoardConfig('owner', 'board'))?.config).toEqual(config);
    const saved = await snapshot();
    for (const schemaVersion of [1, 2, 3, 4]) {
      const rejected = await f.saveSelect({ ...stored, schemaVersion }, 10);
      expect(rejected.status).toBe(400);
      expect(await rejected.text()).toContain('Refresh');
      expect(await snapshot()).toEqual(saved);
    }
    expect((await f.saveSelect(config, 9)).status).toBe(409);
    expect(await snapshot()).toEqual(saved);
    expect(saved.slice(1)).toEqual(before.slice(1));
  });
  it('validates property-only settings without copied options', () => {
    expect(() => validateBoardConfig(DEFAULT_BOARD_CONFIG)).toThrow();
    const config = {
      ...DEFAULT_BOARD_CONFIG,
      schemaVersion: 5,
      grouping: { type: 'select', schemaId: 'schema_A', propertyId: 'property_A' },
    };
    expect(validateBoardConfig(config)).toEqual(config);
    expect(validateBoardConfig({ ...config, cardPropertyIds: ['type_A'] })).toEqual({
      ...config,
      cardPropertyIds: ['type_A'],
    });
    for (const cardPropertyIds of ['', null, 42, ['bad.path'], ['a'.repeat(101)]])
      expect(() => validateBoardConfig({ ...config, cardPropertyIds })).toThrow();
    expect(() => validateBoardConfig({ ...config, cardPropertyIds: ['a'.repeat(17000)] })).toThrow('16 KiB');
    for (const grouping of [
      null,
      {},
      { ...config.grouping, type: 'text' },
      { ...config.grouping, propertyId: '' },
      { ...config.grouping, options: [] },
    ])
      expect(() => validateBoardConfig({ ...config, grouping })).toThrow();
    expect(() => validateBoardConfig({ ...config, options: [] })).toThrow();
    expect(() => validateBoardConfig({ ...config, schemaVersion: 2 })).toThrow();
  });
  it('uses any active Select, current schema CAS, and owner-only saves without note changes', async () => {
    const f = await setupPropertyBoardTest();
    await f.addNote('n', 'N', ['status-todo']);
    await f.patch('n', { [f.field.id]: f.field.options[1].id });
    const before = await f.libsql.execute('select * from notes');
    expect((await f.saveSelect()).status).toBe(200);
    const board = await f.boards.readBoardConfig('owner', 'board');
    expect(board?.columns.map((c) => c.label)).toEqual(['Todo', 'Done', 'Empty', 'Retired', 'Unclassified']);
    expect(board?.groupingState).toMatchObject({ type: 'select', available: true, label: 'Workflow', ...f.token });
    for (const actor of ['viewer', 'editor', 'commenter'])
      expect((await f.saveSelect(f.config, 1, actor)).status).toBe(403);
    expect((await f.saveSelect(f.config, 1, 'owner', { ...f.token, schemaRevision: 2 })).status).toBe(409);
    expect(
      (await f.saveSelect({ ...f.config, grouping: { ...f.config.grouping, propertyId: 'foreign' } }, 1)).status
    ).toBe(400);
    await f.addField('Text', 'text', [], 'board', 1);
    expect((await f.saveSelect(f.config, 1)).status).toBe(409);
    expect((await f.save({ ...DEFAULT_BOARD_CONFIG, enabled: false }, 1)).status).toBe(200);
    expect((await f.libsql.execute('select * from notes')).rows).toEqual(before.rows);
    expect((await f.libsql.execute('select name from tags')).rows).toEqual([{ name: 'status-todo' }]);
    expect((await f.libsql.execute('select "values" from note_property_state')).rows[0].values).toContain(
      f.field.options[1].id
    );
  });
  it('guards enabled property archive, permits option archive and disabled remediation, keeps template guard', async () => {
    const f = await setupPropertyBoardTest();
    await f.saveSelect();
    const archive = () =>
      f.properties.mutateFolderProperties(f.actor, 'board', {
        expectedRevision: 1,
        mutation: { type: 'archive', propertyId: f.field.id },
      });
    await expect(archive()).rejects.toMatchObject({ status: 409 });
    await f.properties.mutateFolderProperties(f.actor, 'board', {
      expectedRevision: 1,
      mutation: { type: 'archive_option', propertyId: f.field.id, optionId: f.field.options[3].id },
    });
    expect((await f.boards.readBoardConfig('owner', 'board'))?.columns).toHaveLength(4);
    expect((await f.saveSelect({ ...f.config, enabled: false }, 1)).status).toBe(200);
    await f.properties.mutateFolderProperties(f.actor, 'board', {
      expectedRevision: 2,
      mutation: { type: 'archive', propertyId: f.field.id },
    });
    expect(await f.boards.readBoardConfig('owner', 'board')).toMatchObject({
      columns: [],
      groupingState: { available: false },
    });
    expect((await f.save({ ...DEFAULT_BOARD_CONFIG, enabled: false }, 2)).status).toBe(200);
  });
  it('reports unavailable retained grouping and allows disabling without schema tokens', async () => {
    const f = await setupPropertyBoardTest();
    await f.saveSelect();
    await f.db.delete(f.schema.folderPropertySchemas).where(eq(f.schema.folderPropertySchemas.folderId, 'board'));
    expect(await (await f.request('/internal/folders/board/board/config')).json()).toMatchObject({
      board: { columns: [], groupingState: { available: false } },
    });
    expect((await f.save({ ...f.config, enabled: false }, 1)).status).toBe(200);
    expect((await f.save({ ...DEFAULT_BOARD_CONFIG, enabled: false }, 2)).status).toBe(200);
  });
  it('rejects non-Select and foreign schema IDs without partially changing config', async () => {
    const f = await setupPropertyBoardTest();
    const text = await f.addField('Summary', 'text', [], 'board', 1);
    const date = await f.addField('Due', 'date', [], 'board', 2);
    const foreign = await f.properties.mutateFolderProperties({ actorUserId: 'other-user' }, 'foreign', {
      expectedRevision: 0,
      mutation: { type: 'add', label: 'Workflow', fieldType: 'select', options: ['Todo'] },
    });
    const reviewed = { schemaId: date.schemaId as string, schemaRevision: 3 };
    for (const propertyId of [text.definitions[1].id, date.definitions[2].id, foreign.definitions[0].id]) {
      expect(
        (await f.saveSelect({ ...f.config, grouping: { ...f.config.grouping, propertyId } }, 0, 'owner', reviewed))
          .status
      ).toBe(400);
    }
    expect(
      (
        await f.saveSelect(
          { ...f.config, grouping: { ...f.config.grouping, schemaId: foreign.schemaId } },
          0,
          'owner',
          reviewed
        )
      ).status
    ).toBe(400);
    expect(await f.boards.readBoardConfig('owner', 'board')).toBeNull();
  });
  it('template references remain independent of enabled-board guard, including Trash', async () => {
    const f = await setupPropertyBoardTest();
    const templates = await import('../src/api/notes/templates');
    await f.addNote('template', 'Template', [], { type: 'template', folderId: 'other' });
    await templates.saveTemplateMembership(f.actor, 'template', { folderIds: ['board'] });
    const [assignment] = await f.db.select().from(f.schema.templateFolderAssignments);
    await templates.saveAssignmentDefaults(f.actor, 'template', 'board', {
      assignmentId: assignment.id,
      expectedRevision: 0,
      ...f.token,
      values: { [f.field.id]: f.field.options[3].id },
    });
    await f.db.update(f.schema.notes).set({ deletedAt: f.now }).where(eq(f.schema.notes.id, 'template'));
    await f.saveSelect();
    const before = (await f.libsql.execute('select * from folder_property_schemas')).rows;
    const archive = (type: string) =>
      f.properties.mutateFolderProperties(f.actor, 'board', {
        expectedRevision: 1,
        mutation: {
          type,
          propertyId: f.field.id,
          ...(type === 'archive_option' ? { optionId: f.field.options[3].id } : {}),
        },
      });
    await expect(archive('archive_option')).rejects.toThrow('template defaults');
    await f.saveSelect({ ...f.config, enabled: false }, 1);
    await expect(archive('archive')).rejects.toThrow('template defaults');
    expect((await f.libsql.execute('select * from folder_property_schemas')).rows).toEqual(before);
    await f.db.update(f.schema.notes).set({ deletedAt: null }).where(eq(f.schema.notes.id, 'template'));
    await templates.saveAssignmentDefaults(f.actor, 'template', 'board', {
      assignmentId: assignment.id,
      expectedRevision: 1,
      ...f.token,
      values: {},
    });
    await f.saveSelect(f.config, 2);
    await expect(archive('archive')).rejects.toThrow('enabled board');
    await archive('archive_option');
    expect((await f.boards.readBoardConfig('owner', 'board'))?.columns).toHaveLength(4);
  });
  it('failed board/schema writes roll back exact saved state', async () => {
    const f = await setupPropertyBoardTest();
    await f.save();
    const configBefore = (await f.libsql.execute('select * from folder_board_views')).rows;
    const schemaBefore = (await f.libsql.execute('select * from folder_property_schemas')).rows;
    await f.libsql.execute(
      "create trigger fail_board before update on folder_board_views begin select raise(abort, 'Injected board failure'); end"
    );
    await expect(f.boards.saveBoardConfig('owner', 'board', f.config, 1, f.token)).rejects.toThrow('Failed query');
    expect((await f.libsql.execute('select * from folder_board_views')).rows).toEqual(configBefore);
    await f.libsql.execute('drop trigger fail_board');
    await f.saveSelect(f.config, 1);
    await f.libsql.execute(
      "create trigger fail_schema before update on folder_property_schemas begin select raise(abort, 'Injected schema failure'); end"
    );
    await expect(
      f.properties.mutateFolderProperties(f.actor, 'board', {
        expectedRevision: 1,
        mutation: { type: 'rename_option', propertyId: f.field.id, optionId: f.field.options[0].id, label: 'Changed' },
      })
    ).rejects.toThrow('Failed query');
    expect((await f.libsql.execute('select * from folder_property_schemas')).rows).toEqual(schemaBefore);
    expect((await f.boards.readBoardConfig('owner', 'board'))?.columns[0].label).toBe('Todo');
  });
  it('validates optional Type in the reviewed transaction, allows archive/clear/disable and preserves exact note data', async () => {
    const f = await setupPropertyBoardTest();
    const t = await f.addType();
    await f.addNote('n', 'N', ['status-todo']);
    await f.patch('n', { [f.field.id]: f.field.options[0].id, [t.typeField.id]: t.typeField.options[0].id });
    const tables = ['notes', 'note_property_state', 'note_tags', 'note_versions', 'note_events'];
    const before = await Promise.all(
      tables.map(async (table) => (await f.libsql.execute(`select * from ${table}`)).rows)
    );
    const foreign = await f.properties.mutateFolderProperties({ actorUserId: 'other-user' }, 'foreign', {
      expectedRevision: 0,
      mutation: { type: 'add', label: 'Type', fieldType: 'select', options: ['Bug'] },
    });
    for (const cardPropertyId of ['foreign', foreign.definitions[0].id, f.field.options[0].id])
      expect((await f.saveSelect({ ...t.config, cardPropertyIds: [cardPropertyId] }, 0, 'owner', t.token)).status).toBe(
        400
      );
    expect((await f.saveSelect(t.config)).status).toBe(409);
    expect((await f.saveSelect(t.config, 0, 'owner', t.token)).status).toBe(200);
    expect((await f.boards.readBoardConfig('owner', 'board'))?.cardProperties).toMatchObject([
      {
        propertyId: t.typeField.id,
        label: 'Type',
      },
    ]);
    await f.properties.mutateFolderProperties(f.actor, 'board', {
      expectedRevision: 2,
      mutation: { type: 'archive', propertyId: t.typeField.id },
    });
    expect((await f.boards.readBoardConfig('owner', 'board'))?.cardProperties).toEqual([]);
    const reviewed = { ...t.token, schemaRevision: 3 };
    expect((await f.saveSelect(t.config, 1, 'owner', reviewed)).status).toBe(400);
    expect((await f.saveSelect({ ...t.config, enabled: false }, 1)).status).toBe(200);
    expect((await f.saveSelect(f.config, 2, 'owner', reviewed)).status).toBe(200);
    expect((await f.save({ ...DEFAULT_BOARD_CONFIG, enabled: false }, 3)).status).toBe(200);
    const text = await f.addField('Summary', 'text', [], 'board', 3);
    expect(
      (
        await f.saveSelect({ ...t.config, cardPropertyIds: [text.definitions[2].id] }, 4, 'owner', {
          ...t.token,
          schemaRevision: 4,
        })
      ).status
    ).toBe(200);
    expect(
      await Promise.all(tables.map(async (table) => (await f.libsql.execute(`select * from ${table}`)).rows))
    ).toEqual(before);
  });
  it('JSON capability failure is explicit and still permits disabling', async () => {
    const f = await setupPropertyBoardTest();
    await f.saveSelect();
    const all = vi.spyOn(f.db, 'all').mockRejectedValue(new Error('JSON unsupported'));
    try {
      expect(await f.boards.boardJsonCapability()).toBe(false);
      expect(await f.boards.readBoardConfig('owner', 'board')).toMatchObject({
        columns: [],
        groupingState: { available: false },
      });
      await f.save({ ...DEFAULT_BOARD_CONFIG, enabled: false }, 1);
      expect((await f.boards.readBoardConfig('owner', 'board'))?.groupingState).toMatchObject({
        type: 'select',
        available: false,
      });
    } finally {
      all.mockRestore();
    }
  });
  it('independent clients cannot commit enabled grouping plus archived property', async () => {
    const f = await setupPropertyBoardTest();
    vi.resetModules();
    const [{ libsql }, properties] = await Promise.all([
      import('../src/api/db/client'),
      import('../src/api/notes/properties'),
    ]);
    try {
      const result = await Promise.allSettled([
        f.boards.saveBoardConfig('owner', 'board', f.config, 0, f.token),
        properties.mutateFolderProperties(f.actor, 'board', {
          expectedRevision: 1,
          mutation: { type: 'archive', propertyId: f.field.id },
        }),
      ]);
      expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const board = await f.boards.readBoardConfig('owner', 'board');
      const schema = await f.properties.readFolderProperties(f.actor, 'board');
      expect(Boolean(board?.config.enabled && schema.definitions[0].archived)).toBe(false);
    } finally {
      libsql.close();
    }
  });
});
