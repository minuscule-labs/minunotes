import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_BOARD_CONFIG } from '../src/shared/board';
import { cleanupPropertyBoardTests, setupPropertyBoardTest } from './property-board-fixtures';

afterEach(cleanupPropertyBoardTests);

describe('whole Select board snapshots', () => {
  it('preserves selected IDs across schema changes without replacing archived choices or admitting new options', async () => {
    const f = await setupPropertyBoardTest();
    const [todo, done] = f.field.options;
    const config = {
      ...f.config,
      columnVisibility: {
        mode: 'selected' as const,
        optionIds: [todo.id, done.id],
        showUnclassified: true,
      },
    };
    await f.addNote('n', 'N');
    await f.patch('n', { [f.field.id]: todo.id });
    expect((await f.saveSelect(config)).status).toBe(200);
    const valuesBefore = (await f.libsql.execute('select * from note_property_state')).rows;
    const configBefore = (await f.libsql.execute('select * from folder_board_views')).rows;
    const columns = async () => {
      const response = await f.request('/internal/folders/board/board/config');
      expect(response.status).toBe(200);
      const { board } = await response.json();
      expect(board.config).toEqual(config);
      return board.columns;
    };
    await f.properties.mutateFolderProperties(f.actor, 'board', {
      expectedRevision: 1,
      mutation: { type: 'rename_option', propertyId: f.field.id, optionId: todo.id, label: 'Ready' },
    });
    expect(await columns()).toEqual([
      { key: todo.id, label: 'Ready' },
      { key: done.id, label: 'Done' },
      { key: 'unclassified', label: 'Unclassified' },
    ]);
    await f.properties.mutateFolderProperties(f.actor, 'board', {
      expectedRevision: 2,
      mutation: {
        type: 'reorder_options',
        propertyId: f.field.id,
        optionIds: f.field.options.map((o) => o.id).reverse(),
      },
    });
    expect(await columns()).toEqual([
      { key: done.id, label: 'Done' },
      { key: todo.id, label: 'Ready' },
      { key: 'unclassified', label: 'Unclassified' },
    ]);
    await f.properties.mutateFolderProperties(f.actor, 'board', {
      expectedRevision: 3,
      mutation: { type: 'archive_option', propertyId: f.field.id, optionId: todo.id },
    });
    const current = await f.properties.mutateFolderProperties(f.actor, 'board', {
      expectedRevision: 4,
      mutation: { type: 'add_option', propertyId: f.field.id, label: 'Ready' },
    });
    const added = current.definitions[0].options.at(-1);
    if (!added) throw new Error('Missing added option');
    expect(added.id).not.toBe(todo.id);
    expect(await columns()).toEqual([
      { key: done.id, label: 'Done' },
      { key: 'unclassified', label: 'Unclassified' },
    ]);
    for (const revision of [1, 2, 3, 4]) {
      for (const lane of [todo.id, done.id, 'unclassified']) {
        for (const page of [1, 2])
          expect((await f.request(f.laneUrl(lane, revision, 1, `&page=${page}`))).status).toBe(409);
      }
    }
    for (const lane of [todo.id, added.id]) expect((await f.request(f.laneUrl(lane, 5))).status).toBe(400);
    expect((await (await f.request(f.laneUrl('unclassified', 5))).json()).cards).toMatchObject([
      { id: 'n', unclassifiedReason: 'unavailable-property-value' },
    ]);
    expect((await f.libsql.execute('select * from folder_board_views')).rows).toEqual(configBefore);
    const reviewed = { ...f.token, schemaRevision: 5 };
    expect((await f.saveSelect(config, 1, 'owner', reviewed)).status).toBe(400);
    expect((await f.libsql.execute('select * from folder_board_views')).rows).toEqual(configBefore);
    const cleared = {
      ...config,
      columnVisibility: { mode: 'selected' as const, optionIds: [], showUnclassified: false },
    };
    expect((await f.saveSelect(cleared, 1, 'owner', reviewed)).status).toBe(200);
    expect((await f.boards.readBoardConfig('owner', 'board'))?.columns).toEqual([]);
    for (const page of [1, 2]) expect((await f.request(f.laneUrl(done.id, 5, 1, `&page=${page}`))).status).toBe(409);
    expect((await f.request(f.laneUrl('unclassified', 5, 2))).status).toBe(400);
    expect(
      (
        await f.saveSelect(
          { ...f.config, columnVisibility: { mode: 'all', showUnclassified: false } },
          2,
          'owner',
          reviewed
        )
      ).status
    ).toBe(200);
    expect((await f.boards.readBoardConfig('owner', 'board'))?.columns.map((c) => c.key)).toEqual(
      current.definitions[0].options.filter((o) => !o.archived).map((o) => o.id)
    );
    expect((await f.libsql.execute('select * from note_property_state')).rows).toEqual(valuesBefore);
  });
  it('invalidates visibility/config and reordered/renamed/archived display generations without changing values', async () => {
    const f = await setupPropertyBoardTest();
    const t = await f.addType();
    await f.addField('Summary', 'text', [], 'board', 2);
    const schema = await f.addField('Due', 'date', [], 'board', 3);
    const text = schema.definitions[2],
      date = schema.definitions[3];
    const config = { ...t.config, cardPropertyIds: [t.typeField.id, text.id, date.id] };
    const token = { schemaId: schema.schemaId as string, schemaRevision: 4 };
    await f.addNote('n', 'N');
    await f.patch('n', {
      [f.field.id]: f.field.options[0].id,
      [t.typeField.id]: t.typeField.options[0].id,
      [text.id]: 'Summary',
      [date.id]: '2026-10-20',
    });
    await f.saveSelect(config, 0, 'owner', token);
    const before = (await f.libsql.execute('select * from note_property_state')).rows;
    const ids = schema.definitions.map((d) => d.id).reverse();
    await f.properties.mutateFolderProperties(f.actor, 'board', {
      expectedRevision: 4,
      mutation: { type: 'reorder', propertyIds: ids },
    });
    for (const lane of [f.field.options[0].id, 'unclassified'])
      expect((await f.request(f.laneUrl(lane, 4))).status).toBe(409);
    const ordered = await (await f.request(f.laneUrl(f.field.options[0].id, 5))).json();
    expect(ordered.cards[0].properties.map((p: { propertyId: string }) => p.propertyId)).toEqual([
      date.id,
      text.id,
      t.typeField.id,
    ]);
    await f.properties.mutateFolderProperties(f.actor, 'board', {
      expectedRevision: 5,
      mutation: { type: 'rename', propertyId: date.id, label: 'Deadline' },
    });
    expect((await f.request(f.laneUrl(f.field.options[0].id, 5))).status).toBe(409);
    expect((await (await f.request(f.laneUrl(f.field.options[0].id, 6))).json()).cards[0].properties[0].label).toBe(
      'Deadline'
    );
    await f.properties.mutateFolderProperties(f.actor, 'board', {
      expectedRevision: 6,
      mutation: { type: 'archive', propertyId: text.id },
    });
    expect((await f.request(f.laneUrl(f.field.options[0].id, 6))).status).toBe(409);
    expect(
      (await (await f.request(f.laneUrl(f.field.options[0].id, 7))).json()).cards[0].properties.map(
        (p: { propertyId: string }) => p.propertyId
      )
    ).toEqual([date.id, t.typeField.id]);
    await f.saveSelect({ ...config, cardPropertyIds: [] }, 1, 'owner', { ...token, schemaRevision: 7 });
    expect((await f.request(f.laneUrl(f.field.options[0].id, 7))).status).toBe(409);
    expect((await (await f.request(f.laneUrl(f.field.options[0].id, 7, 2))).json()).cards[0].properties).toEqual([]);
    expect((await f.libsql.execute('select * from note_property_state')).rows).toEqual(before);
  });
  it('requires bounded single-valued tokens from the first page and rejects old generations', async () => {
    const f = await setupPropertyBoardTest();
    await f.saveSelect();
    for (const url of [
      `/internal/folders/board/board?lane=${f.field.options[0].id}`,
      `${f.laneUrl(f.field.options[0].id)}&schemaId=other`,
      `${f.laneUrl(f.field.options[0].id)}&schemaRevision=1`,
      f.laneUrl(f.field.options[0].id).replace('schemaRevision=1', 'schemaRevision=0'),
      f.laneUrl(f.field.options[0].id).replace('schemaRevision=1', 'schemaRevision=1.5'),
      f.laneUrl(f.field.options[0].id).replace('schemaId=', 'schemaId=invalid.'),
      f.laneUrl('unknown'),
    ])
      expect((await f.request(url)).status, url).toBe(400);
    expect(await f.request(f.laneUrl(f.field.options[0].id, 2))).toMatchObject({ status: 409 });
    await f.properties.mutateFolderProperties(f.actor, 'board', {
      expectedRevision: 1,
      mutation: { type: 'rename_option', propertyId: f.field.id, optionId: f.field.options[0].id, label: 'Ready' },
    });
    for (const option of f.field.options) expect((await f.request(f.laneUrl(option.id))).status).toBe(409);
    expect((await f.boards.readBoardConfig('owner', 'board'))?.columns[0]).toEqual({
      key: f.field.options[0].id,
      label: 'Ready',
    });
    expect((await f.request(f.laneUrl(f.field.options[0].id, 2))).status).toBe(200);
    await f.save({ ...DEFAULT_BOARD_CONFIG, enabled: false }, 1);
    expect((await f.request(f.laneUrl(f.field.options[0].id, 2))).status).toBe(404);
    expect((await f.request('/internal/folders/board/board?lane=todo')).status).toBe(404);
  });
  it('rechecks grants without leaking private schema or cached lane data and never falls back to tags', async () => {
    const f = await setupPropertyBoardTest();
    await f.saveSelect();
    await f.addNote('n', 'N', ['status-todo']);
    await f.db.insert(f.schema.collaborationGrants).values({
      id: 'note-only',
      ownerUserId: 'owner',
      granteeUserId: 'stranger',
      noteId: 'n',
      role: 'viewer',
      createdByUserId: 'owner',
      createdAt: f.now,
      updatedAt: f.now,
    });
    expect((await f.request(f.laneUrl(f.field.options[0].id), 'stranger')).status).toBe(404);
    expect((await f.request(f.laneUrl(f.field.options[0].id), 'viewer')).status).toBe(200);
    await f.db.delete(f.schema.collaborationGrants).where(eq(f.schema.collaborationGrants.id, 'grant_viewer'));
    expect((await f.request(f.laneUrl(f.field.options[0].id), 'viewer')).status).toBe(404);
    expect((await f.request('/internal/folders/board/board/config', 'viewer')).status).toBe(404);
    await f.db.delete(f.schema.folderPropertySchemas).where(eq(f.schema.folderPropertySchemas.folderId, 'board'));
    expect((await f.request(f.laneUrl('todo'))).status).toBe(409);
    expect((await f.boards.readBoardConfig('owner', 'board'))?.columns).toEqual([]);
  });
  it('Type rename and retirement invalidate every lane token without changing values or guarding optional display', async () => {
    const f = await setupPropertyBoardTest();
    const t = await f.addType();
    await f.addNote('n', 'N');
    await f.patch('n', { [f.field.id]: f.field.options[0].id, [t.typeField.id]: t.typeField.options[0].id });
    await f.saveSelect(t.config, 0, 'owner', t.token);
    const before = (await f.libsql.execute('select * from note_property_state')).rows;
    await f.properties.mutateFolderProperties(f.actor, 'board', {
      expectedRevision: 2,
      mutation: { type: 'rename', propertyId: t.typeField.id, label: 'Kind' },
    });
    expect((await f.request(f.laneUrl(f.field.options[0].id, 2))).status).toBe(409);
    expect((await f.boards.readBoardConfig('owner', 'board'))?.cardProperties?.[0]?.label).toBe('Kind');
    await f.properties.mutateFolderProperties(f.actor, 'board', {
      expectedRevision: 3,
      mutation: {
        type: 'rename_option',
        propertyId: t.typeField.id,
        optionId: t.typeField.options[0].id,
        label: 'Defect',
      },
    });
    expect((await f.request(f.laneUrl(f.field.options[0].id, 3))).status).toBe(409);
    expect((await (await f.request(f.laneUrl(f.field.options[0].id, 4))).json()).cards[0].properties[0].value).toBe(
      'Defect'
    );
    await f.properties.mutateFolderProperties(f.actor, 'board', {
      expectedRevision: 4,
      mutation: { type: 'archive', propertyId: t.typeField.id },
    });
    expect((await f.request(f.laneUrl(f.field.options[0].id, 4))).status).toBe(409);
    expect((await (await f.request(f.laneUrl(f.field.options[0].id, 5))).json()).cards[0]).toHaveProperty(
      'properties',
      []
    );
    expect((await f.libsql.execute('select * from note_property_state')).rows).toEqual(before);
  });
  it('offset overlap is deduplicable but only refresh promises a fresh complete view', async () => {
    const f = await setupPropertyBoardTest();
    await f.saveSelect();
    for (let i = 0; i < 30; i++) {
      await f.addNote(`n${String(i).padStart(2, '0')}`, `Note ${String(i).padStart(2, '0')}`);
      await f.db.insert(f.schema.notePropertyState).values({
        noteId: `n${String(i).padStart(2, '0')}`,
        userId: 'owner',
        values: JSON.stringify({ [f.field.id]: f.field.options[0].id }),
        revision: 1,
        createdAt: f.now,
        updatedAt: f.now,
      });
    }
    const first = await (await f.request(f.laneUrl(f.field.options[0].id))).json();
    await f.db
      .update(f.schema.notes)
      .set({ updatedAt: new Date(f.now.getTime() + 1000) })
      .where(eq(f.schema.notes.id, 'n29'));
    const second = await (await f.request(f.laneUrl(f.field.options[0].id, 1, 1, '&page=2'))).json();
    const ids = [...first.cards, ...second.cards].map((c: { id: string }) => c.id);
    expect(ids.length).toBe(30);
    expect(new Set(ids).size).toBe(29);
    const refreshed = await (await f.request(f.laneUrl(f.field.options[0].id, 1, 1, '&limit=100'))).json();
    expect(new Set(refreshed.cards.map((c: { id: string }) => c.id)).size).toBe(30);
  });
});
