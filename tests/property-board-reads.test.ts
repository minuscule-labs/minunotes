import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupPropertyBoardTests, setupPropertyBoardTest } from './property-board-fixtures';

afterEach(cleanupPropertyBoardTests);

describe('SQL Select board reads', () => {
  it('projects ordered Text/Select/Date previews, bounds Unicode in SQL and never changes notes or classification', async () => {
    const f = await setupPropertyBoardTest();
    const t = await f.addType();
    await f.addField('Summary', 'text', [], 'board', 2);
    const schema = await f.addField('Due', 'date', [], 'board', 3);
    const text = schema.definitions[2],
      date = schema.definitions[3];
    const config = { ...t.config, cardPropertyIds: [date.id, text.id, t.typeField.id] };
    const token = { schemaId: schema.schemaId as string, schemaRevision: schema.revision };
    expect((await f.saveSelect(config, 0, 'owner', token)).status).toBe(200);
    const samples: Record<string, [unknown, unknown, unknown]> = {
      valid: ['😀'.repeat(160) + 'ZPRIVATE_SUFFIX', '2028-02-29', t.typeField.options[0].id],
      boundary: ['😀'.repeat(160), '2026-10-20', t.typeField.options[1].id],
      blank: [' \n\t', '', null],
      bad: [{ html: '<script>' }, '2026-02-29', 'unknown'],
      scalar: [false, 123, [t.typeField.options[0].id]],
      nul: ['abc\0suffix', '2026-10-20\0invalid', t.typeField.options[0].id + '\0invalid'],
      escaped: ['<script>alert(1)</script>', '2026-01-01', t.typeField.options[2].id],
    };
    for (const [id, [summary, due, type]] of Object.entries(samples)) {
      await f.addNote(id, id);
      await f.db.insert(f.schema.notePropertyState).values({
        noteId: id,
        userId: 'owner',
        revision: 1,
        values: JSON.stringify({
          [f.field.id]: f.field.options[0].id,
          [text.id]: summary,
          [date.id]: due,
          [t.typeField.id]: type,
          hidden: 'HIDDEN_DISPLAY_SENTINEL',
        }),
        createdAt: f.now,
        updatedAt: f.now,
      });
    }
    const tables = ['notes', 'note_property_state', 'note_tags', 'note_events'];
    const before = await Promise.all(
      tables.map(async (table) => (await f.libsql.execute(`select * from ${table}`)).rows)
    );
    const board = await f.boards.readBoardConfig('owner', 'board');
    expect(board?.cardProperties?.map((d) => d.propertyId)).toEqual([t.typeField.id, text.id, date.id]);
    const result = await (await f.request(f.laneUrl(f.field.options[0].id, 4), 'viewer')).json();
    expect(result.cards).toHaveLength(7);
    const valid = result.cards.find((c: { id: string }) => c.id === 'valid');
    expect(valid.properties).toEqual([
      { propertyId: t.typeField.id, label: 'Type', type: 'select', value: 'Bug', optionId: t.typeField.options[0].id },
      { propertyId: text.id, label: 'Summary', type: 'text', value: '😀'.repeat(160), truncated: true },
      { propertyId: date.id, label: 'Due', type: 'date', value: '2028-02-29' },
    ]);
    expect(result.cards.find((c: { id: string }) => c.id === 'boundary').properties[1].truncated).toBe(false);
    for (const id of ['blank', 'bad', 'scalar', 'nul'])
      expect(result.cards.find((c: { id: string }) => c.id === id).properties).toEqual([]);
    expect(result.cards.find((c: { id: string }) => c.id === 'escaped').properties[1].value).toBe(
      '<script>alert(1)</script>'
    );
    expect(JSON.stringify(result)).not.toMatch(
      /HIDDEN_DISPLAY_SENTINEL|PRIVATE_SUFFIX|preview_\d|typeBadge|typeOptionId/
    );
    expect((await f.saveSelect({ ...config, cardPropertyIds: [] }, 1, 'owner', token)).status).toBe(200);
    const empty = await (await f.request(f.laneUrl(f.field.options[0].id, 4, 2), 'commenter')).json();
    expect(empty.cards.map((c: { id: string }) => c.id)).toEqual(result.cards.map((c: { id: string }) => c.id));
    for (const card of empty.cards) expect(card.properties).toEqual([]);
    expect(
      await Promise.all(tables.map(async (table) => (await f.libsql.execute(`select * from ${table}`)).rows))
    ).toEqual(before);
  });
  it('classifies scalar values, missing and retained unavailable values with owner/folder exclusions and no bodies', async () => {
    const f = await setupPropertyBoardTest();
    await f.saveSelect();
    for (const id of [
      'todo',
      'canvas',
      'unset',
      'archived',
      'foreign-value',
      'array',
      'object',
      'number',
      'null',
      'template',
      'trash',
      'child',
      'foreign',
      'wrong-owner-state',
    ]) {
      await f.addNote(id, id, ['status-done'], {
        ...(id === 'template' ? { type: 'template' as const } : {}),
        ...(id === 'trash' ? { deletedAt: f.now } : {}),
        ...(id === 'child' ? { folderId: 'child' } : {}),
        ...(id === 'foreign' ? { folderId: 'foreign', userId: 'other-user' } : {}),
        ...(id === 'canvas' ? { documentType: 'canvas.mindmap' } : {}),
      });
    }
    // Deliberately inject a corrupt cross-owner row to prove the join fails closed
    // even if a legacy/imported database did not enforce the composite FK.
    await f.libsql.execute('PRAGMA foreign_keys = OFF');
    for (const [id, value] of Object.entries({
      todo: f.field.options[0].id,
      canvas: f.field.options[0].id,
      archived: f.field.options[3].id,
      'foreign-value': 'option_foreign',
      array: [f.field.options[0].id],
      object: { value: f.field.options[0].id },
      number: 42,
      null: null,
      template: f.field.options[0].id,
      trash: f.field.options[0].id,
      child: f.field.options[0].id,
      foreign: f.field.options[0].id,
      'wrong-owner-state': f.field.options[0].id,
    })) {
      await f.db.insert(f.schema.notePropertyState).values({
        noteId: id,
        userId: id === 'foreign' || id === 'wrong-owner-state' ? 'other-user' : 'owner',
        values: JSON.stringify({ [f.field.id]: value }),
        revision: 1,
        createdAt: f.now,
        updatedAt: f.now,
      });
    }
    await f.libsql.execute('PRAGMA foreign_keys = ON');
    await f.properties.mutateFolderProperties(f.actor, 'board', {
      expectedRevision: 1,
      mutation: { type: 'archive_option', propertyId: f.field.id, optionId: f.field.options[3].id },
    });
    const before = await f.libsql.execute('select * from notes');
    const valuesBefore = await f.libsql.execute('select * from note_property_state');
    const response = await f.request(f.laneUrl(f.field.options[0].id, 2), 'viewer');
    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page.cards.map((c: { id: string }) => c.id)).toEqual(['canvas', 'todo']);
    expect(page.cards[0]).not.toHaveProperty('tags');
    const unclassified = await (await f.request(f.laneUrl('unclassified', 2))).json();
    expect(
      unclassified.cards.map((c: { id: string; unclassifiedReason: string }) => [c.id, c.unclassifiedReason])
    ).toEqual([
      ['archived', 'unavailable-property-value'],
      ['array', 'unavailable-property-value'],
      ['foreign-value', 'unavailable-property-value'],
      ['null', 'unavailable-property-value'],
      ['number', 'unavailable-property-value'],
      ['object', 'unavailable-property-value'],
      ['unset', 'no-property-value'],
      ['wrong-owner-state', 'no-property-value'],
    ]);
    expect((await (await f.request(f.laneUrl(f.field.options[2].id, 2))).json()).cards).toEqual([]);
    for (const card of [...page.cards, ...unclassified.cards]) {
      expect(Object.keys(card).sort()).toEqual([
        'createdAt',
        'documentType',
        'folderId',
        'id',
        'properties',
        'title',
        'unclassifiedReason',
        'updatedAt',
      ]);
    }
    expect((await f.libsql.execute('select * from notes')).rows).toEqual(before.rows);
    expect((await f.libsql.execute('select * from note_property_state')).rows).toEqual(valuesBefore.rows);
    expect((await f.libsql.execute('select * from note_events')).rows).toEqual([]);
  });
  it('classifies before pages and loads 200 stable cards exactly once with one helper query', async () => {
    const f = await setupPropertyBoardTest();
    const t = await f.addType();
    await f.saveSelect(t.config, 0, 'owner', t.token);
    const candidates = Array.from({ length: 210 }, (_, i) => ({
      id: `n${String(i).padStart(3, '0')}`,
      index: i,
      tags: ['board', 'project', 'selected', ...(i < 25 ? ['hidden'] : [])],
    }));
    await f.db.transaction(async (tx) => {
      await tx.insert(f.schema.tags).values(
        ['board', 'project', 'selected', 'hidden'].map((name) => ({
          id: `owner_${name}`,
          userId: 'owner',
          name,
          normalizedName: name,
          createdAt: f.now,
          updatedAt: f.now,
        }))
      );
      // Keep every insert below 999 bound parameters, including the tag links.
      for (let start = 0; start < candidates.length; start += 50) {
        const batch = candidates.slice(start, start + 50);
        await tx.insert(f.schema.notes).values(
          batch.map(({ id }) => ({
            id,
            title: 'Same title',
            folderId: 'board',
            userId: 'owner',
            content: `Private body for ${id}`,
            createdAt: f.now,
            updatedAt: f.now,
          }))
        );
        await tx.insert(f.schema.notePropertyState).values(
          batch.map(({ id, index }) => ({
            noteId: id,
            userId: 'owner',
            revision: 1,
            values: JSON.stringify({
              [f.field.id]: f.field.options[index >= 200 ? 1 : 0].id,
              [t.typeField.id]: t.typeField.options[index % 3].id,
            }),
            createdAt: f.now,
            updatedAt: f.now,
          }))
        );
        await tx.insert(f.schema.noteTags).values(
          batch.flatMap(({ id, tags }) =>
            tags.map((name) => ({
              id: `${id}_${name}`,
              userId: 'owner',
              noteId: id,
              tagId: `owner_${name}`,
              createdAt: f.now,
            }))
          )
        );
      }
    });
    const expected = Array.from({ length: 200 }, (_, i) => `n${String(i).padStart(3, '0')}`);
    const board = await f.boards.readBoardConfig('owner', 'board');
    if (!board) throw new Error('Missing board');
    const execute = vi.spyOn(f.libsql, 'execute');
    const ids: string[] = [];
    for (let page = 1; page <= 8; page++) {
      execute.mockClear();
      const result = await f.boards.readBoardLane({
        actorUserId: 'viewer',
        userId: 'owner',
        folderId: 'board',
        board,
        lane: f.field.options[0].id,
        page: { page, limit: 25, offset: (page - 1) * 25 },
      });
      expect(execute.mock.calls).toHaveLength(1);
      ids.push(...result.cards.map((c) => c.id));
      for (const card of result.cards) expect(card).toMatchObject({ properties: [{ propertyId: t.typeField.id }] });
      expect(result.hasMore).toBe(page < 8);
      expect(JSON.stringify(result)).not.toContain('Private body');
    }
    execute.mockRestore();
    expect(ids).toEqual(expected);
    expect(new Set(ids).size).toBe(200);
    expect((await f.request(f.laneUrl(f.field.options[0].id, 2, 1, '&tag=missing&limit=1'))).status).toBe(400);
  });
  it('projects only configured scalar Type with current labels and omits malformed, archived and unknown badges', async () => {
    const f = await setupPropertyBoardTest();
    const t = await f.addType();
    await f.saveSelect(t.config, 0, 'owner', t.token);
    const values: Record<string, unknown> = {
      bug: t.typeField.options[0].id,
      feature: t.typeField.options[1].id,
      task: t.typeField.options[2].id,
      missing: undefined,
      unknown: 'unknown',
      array: [t.typeField.options[0].id],
      object: { id: t.typeField.options[0].id },
      number: 1,
      null: null,
    };
    for (const [id, type] of Object.entries(values)) {
      await f.addNote(id, id, ['status-done']);
      await f.db.insert(f.schema.notePropertyState).values({
        noteId: id,
        userId: 'owner',
        revision: 1,
        values: JSON.stringify({
          [f.field.id]: f.field.options[0].id,
          [t.typeField.id]: type,
          unrelated: 'PRIVATE_METADATA_SENTINEL',
        }),
        createdAt: f.now,
        updatedAt: f.now,
      });
    }
    const board = await f.boards.readBoardConfig('owner', 'board');
    if (!board) throw new Error('Missing board');
    const execute = vi.spyOn(f.libsql, 'execute');
    const result = await f.boards.readBoardLane({
      actorUserId: 'viewer',
      userId: 'owner',
      folderId: 'board',
      board,
      lane: f.field.options[0].id,
      page: { page: 1, limit: 25, offset: 0 },
    });
    expect(execute.mock.calls).toHaveLength(1);
    const projection = execute.mock.calls[0][0] as unknown as { sql: string; args: unknown[] };
    expect(projection.args).toContain(`$."${t.typeField.id}"`);
    expect(projection.sql).not.toMatch(/(?:select |, )"note_property_state"\."values"(?:, | from)/);
    execute.mockRestore();
    expect(JSON.stringify(result)).not.toContain('PRIVATE_METADATA_SENTINEL');
    for (const card of result.cards) {
      const option = t.typeField.options.find((o) => o.id === values[card.id]);
      expect(card.properties).toEqual(
        option
          ? [
              {
                propertyId: t.typeField.id,
                type: 'select',
                optionId: option.id,
                label: t.typeField.label,
                value: option.label,
              },
            ]
          : []
      );
      expect(card).not.toHaveProperty('typeOptionId');
    }
    await f.properties.mutateFolderProperties(f.actor, 'board', {
      expectedRevision: 2,
      mutation: { type: 'archive_option', propertyId: t.typeField.id, optionId: t.typeField.options[0].id },
    });
    const fresh = await (await f.request(f.laneUrl(f.field.options[0].id, 3))).json();
    expect(fresh.cards.find((c: { id: string }) => c.id === 'bug')).toHaveProperty('properties', []);
    expect(fresh.cards.find((c: { id: string }) => c.id === 'feature').properties[0].value).toBe('Feature');
    await f.addNote('corrupt-json', 'Corrupt');
    await f.addNote('wrong-owner-type', 'Wrong owner');
    // Corruption is injected only into this owned scratch fixture, bypassing normal DB constraints.
    await f.libsql.execute('PRAGMA foreign_keys=OFF');
    await f.libsql.execute('PRAGMA ignore_check_constraints=ON');
    await f.db.insert(f.schema.notePropertyState).values([
      { noteId: 'corrupt-json', userId: 'owner', revision: 1, values: '{broken', createdAt: f.now, updatedAt: f.now },
      {
        noteId: 'wrong-owner-type',
        userId: 'other-user',
        revision: 1,
        values: JSON.stringify({ [f.field.id]: f.field.options[0].id, [t.typeField.id]: t.typeField.options[1].id }),
        createdAt: f.now,
        updatedAt: f.now,
      },
    ]);
    await f.libsql.execute('PRAGMA ignore_check_constraints=OFF');
    await f.libsql.execute('PRAGMA foreign_keys=ON');
    const unclassified = await (await f.request(f.laneUrl('unclassified', 3), 'viewer')).json();
    expect(unclassified.cards).toHaveLength(2);
    for (const card of unclassified.cards) {
      expect(card).toHaveProperty('properties', []);
      expect(card.unclassifiedReason).toBe('no-property-value');
    }
  });
  it('observes actual JSON capability and keeps tenant-qualified state without tag queries', async () => {
    const f = await setupPropertyBoardTest();
    expect(await f.boards.boardJsonCapability()).toBe(true);
    await f.saveSelect();
    await f.addNote('n', 'N');
    await f.patch('n', { [f.field.id]: f.field.options[0].id });
    const board = await f.boards.readBoardConfig('owner', 'board');
    if (!board) throw new Error('Missing board');
    const execute = vi.spyOn(f.libsql, 'execute');
    await f.boards.readBoardLane({
      actorUserId: 'owner',
      userId: 'owner',
      folderId: 'board',
      board,
      lane: f.field.options[0].id,
      page: { page: 1, limit: 25, offset: 0 },
    });
    const sql = execute.mock.calls
      .map(([query]) => (typeof query === 'string' ? query : (query as { sql: string }).sql))
      .join('\n');
    expect(sql).toContain(
      'left join "note_property_state" on ("note_property_state"."note_id" = "notes"."id" and "note_property_state"."user_id" = "notes"."user_id")'
    );
    expect(sql).not.toMatch(/select[^;]*"notes"\."content"/);
    execute.mockRestore();
    await f.db.update(f.schema.folders).set({ deletedAt: f.now }).where(eq(f.schema.folders.id, 'root'));
    expect(await f.request(f.laneUrl(f.field.options[0].id))).toMatchObject({ status: 404 });
  });
});
