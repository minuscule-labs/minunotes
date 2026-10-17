import { afterEach, describe, expect, it } from 'vitest';
import { cleanupPropertyBoardTests, setupPropertyBoardTest } from './property-board-fixtures';

afterEach(cleanupPropertyBoardTests);
const encoded = (all: unknown[]) => JSON.stringify({ version: 1, all });
async function setup() {
  const f = await setupPropertyBoardTest();
  const t = await f.addType();
  await f.addField('Summary', 'text', [], 'board', 2);
  const schema = await f.addField('Due', 'date', [], 'board', 3);
  const text = schema.definitions[2],
    date = schema.definitions[3];
  const ref = (propertyId: string, type: string, rest: Record<string, unknown>) => ({
    schemaId: schema.schemaId,
    propertyId,
    type,
    ...rest,
  });
  await f.saveSelect(t.config, 0, 'owner', { schemaId: schema.schemaId as string, schemaRevision: 4 });
  const url = (kind: 'list' | 'board', query: Record<string, string> = {}, lane = f.field.options[0].id, page = 1) => {
    const params = new URLSearchParams({
      schemaId: schema.schemaId as string,
      schemaRevision: '4',
      page: String(page),
      limit: '2',
      ...query,
    });
    return kind === 'list'
      ? `/internal/folders/board/notes?${params}`
      : `${f.laneUrl(lane, 4, 1, '&limit=2')}&${new URLSearchParams({ ...query, page: String(page) })}`;
  };
  const collect = async (kind: 'list' | 'board', query: Record<string, string>, actor = 'viewer') => {
    const ids: string[] = [];
    for (const lane of kind === 'list' ? ['unused'] : [...f.field.options.map((o) => o.id), 'unclassified']) {
      for (let page = 1; page < 50; page++) {
        const response = await f.request(url(kind, query, lane, page), actor);
        expect(response.status, await response.clone().text()).toBe(200);
        const body = await response.json();
        expect(body.queryIdentity).toBeTypeOf('string');
        const rows = kind === 'list' ? body.notes : body.cards;
        ids.push(...rows.map((n: { id: string }) => n.id));
        // The identity deliberately echoes the viewer's terms, not stored body/metadata values.
        expect(JSON.stringify(rows)).not.toMatch(/PRIVATE_BODY|HIDDEN_VALUE|preview_\d/);
        if (!body.hasMore) break;
      }
    }
    return ids.sort();
  };
  const seed = async (id: string, title: string, values: Record<string, unknown> = {}) => {
    await f.addNote(id, title, [], { content: 'PRIVATE_BODY' });
    await f.db.insert(f.schema.notePropertyState).values({
      noteId: id,
      userId: 'owner',
      revision: 1,
      values: JSON.stringify({ [f.field.id]: f.field.options[0].id, hidden: 'HIDDEN_VALUE', ...values }),
      createdAt: f.now,
      updatedAt: f.now,
    });
  };
  return { ...f, ...t, schemaSnapshot: schema, text, date, ref, url, collect, seed };
}
describe('authorized shared folder queries', () => {
  it('sorts full Text, real Dates and configured Select ranks before paging, invalid values last in BOTH directions', async () => {
    for (const type of ['text', 'date', 'select'] as const) {
      const f = await setup();
      const field = type === 'text' ? f.text : type === 'date' ? f.date : f.typeField;
      const valid =
        type === 'text'
          ? [`${'prefix'.repeat(40)}a`, `${'prefix'.repeat(40)}b`]
          : type === 'date'
            ? ['0001-01-01', '2000-02-29', '2028-02-29', '9999-12-31']
            : f.typeField.options.map((option) => option.id);
      const invalid: unknown[] = [undefined, null, ' \t\n\u00a0', 42, false, [], {}, 'bad\0suffix'];
      if (type === 'date')
        invalid.push('0000-01-01', '0000-02-29', '0000-12-31', '1900-02-29', '2026-02-29', '2028-02-29junk');
      if (type === 'select') invalid.push('unknown_option');
      const last: string[] = [];
      for (let index = 0; index < invalid.length; index++) {
        const id = `empty_${String(index).padStart(2, '0')}`;
        last.push(id);
        await f.seed(id, 'Tie', { [f.field.id]: null, [field.id]: invalid[index] });
      }
      // Emulate historical corruption only in this owned disposable DB; restore checks before reads.
      await f.libsql.execute('pragma ignore_check_constraints=ON');
      try {
        for (const [id, raw] of [
          ['bad_map', '{'],
          ['array_map', '[]'],
          ['scalar_map', '42'],
          ['string_map', '"map"'],
        ] as const) {
          await f.seed(id, 'Tie', { [f.field.id]: null });
          await f.libsql.execute({
            sql: 'update note_property_state set "values" = ? where note_id = ?',
            args: [raw, id],
          });
          last.push(id);
        }
      } finally {
        await f.libsql.execute('pragma ignore_check_constraints=OFF');
      }
      await f.addNote('no_state', 'Tie');
      last.push('no_state');
      last.sort();
      for (let i = 0; i < valid.length; i++)
        await f.seed(`valid_${i}`, 'Tie', { [f.field.id]: null, [field.id]: valid[i] });
      const notesBefore = (await f.libsql.execute('select * from notes')).rows;
      const valuesBefore = (await f.libsql.execute('select * from note_property_state')).rows;
      for (const direction of ['asc', 'desc'] as const) {
        const sort = JSON.stringify({
          version: 1,
          schemaId: f.schemaSnapshot.schemaId,
          propertyId: field.id,
          type,
          direction,
        });
        const expected = valid.map((_, i) => `valid_${i}`);
        if (direction === 'desc') expected.reverse();
        for (const kind of ['list', 'board'] as const) {
          const ids: string[] = [];
          for (let page = 1; page < 30; page++) {
            const response = await f.request(f.url(kind, { sort }, 'unclassified', page), 'viewer');
            expect(response.status, await response.clone().text()).toBe(200);
            const body = await response.json();
            expect(JSON.parse(body.sortIdentity)).toEqual(JSON.parse(sort));
            expect(body.querySchema).toEqual({ schemaId: f.schemaSnapshot.schemaId, schemaRevision: 4 });
            const rows = kind === 'list' ? body.notes : body.cards;
            expect(JSON.stringify(rows)).not.toContain('prefix'.repeat(40));
            ids.push(...rows.map((row: { id: string }) => row.id));
            if (!body.hasMore) break;
          }
          expect(ids).toEqual([...expected, ...last]);
        }
      }
      expect((await f.libsql.execute('select * from notes')).rows).toEqual(notesBefore);
      expect((await f.libsql.execute('select * from note_property_state')).rows).toEqual(valuesBefore);
      expect((await f.libsql.execute('select * from note_events')).rows).toEqual([]);
    }
  });
  it('binds property sorts to schema/type snapshots, refreshes renamed/reordered Select ranks, and handles zero active options', async () => {
    const f = await setup();
    const ids = f.typeField.options.map((option) => option.id);
    for (let i = 0; i < ids.length; i++) await f.seed(`rank_${i}`, 'Tie', { [f.typeField.id]: ids[i] });
    const sort = JSON.stringify({
      version: 1,
      schemaId: f.schemaSnapshot.schemaId,
      propertyId: f.typeField.id,
      type: 'select',
      direction: 'asc',
    });
    for (const kind of ['list', 'board'] as const) {
      expect((await f.request(f.url(kind, { sort }).replace('schemaRevision=4', 'schemaRevision=3'))).status).toBe(409);
      for (const extra of [{ schemaId: 'foreign' }, { propertyId: 'foreign' }, { type: 'text' }])
        expect((await f.request(f.url(kind, { sort: JSON.stringify({ ...JSON.parse(sort), ...extra }) }))).status).toBe(
          409
        );
      expect((await f.request(f.url(kind, { sort }), 'stranger')).status).toBe(404);
    }
    await f.properties.mutateFolderProperties(f.actor, 'board', {
      expectedRevision: 4,
      mutation: { type: 'rename_option', propertyId: f.typeField.id, optionId: ids[0], label: 'Zulu' },
    });
    await f.properties.mutateFolderProperties(f.actor, 'board', {
      expectedRevision: 5,
      mutation: { type: 'reorder_options', propertyId: f.typeField.id, optionIds: [...ids].reverse() },
    });
    for (const kind of ['list', 'board'] as const) {
      const stale = await f.request(f.url(kind, { sort }));
      expect(stale.status).toBe(409);
      const response = await f.request(f.url(kind, { sort }).replace('schemaRevision=4', 'schemaRevision=6'));
      expect(response.status, await response.clone().text()).toBe(200);
      const body = await response.json();
      expect((kind === 'list' ? body.notes : body.cards).map((row: { id: string }) => row.id)).toEqual([
        'rank_2',
        'rank_1',
      ]);
    }
    // Public mutations correctly prohibit zero active options; emulate historical/corrupt definitions defensively.
    const schemaRow = (
      await f.libsql.execute("select definitions from folder_property_schemas where folder_id = 'board'")
    ).rows[0];
    const definitions = JSON.parse(schemaRow.definitions as string);
    for (const option of definitions.find((field: { id: string }) => field.id === f.typeField.id).options)
      option.archived = true;
    await f.libsql.execute({
      sql: "update folder_property_schemas set definitions = ?, revision = 9 where folder_id = 'board'",
      args: [JSON.stringify(definitions)],
    });
    for (const kind of ['list', 'board'] as const) {
      const response = await f.request(f.url(kind, { sort }).replace('schemaRevision=4', 'schemaRevision=9'));
      expect(response.status, await response.clone().text()).toBe(200);
      const body = await response.json();
      expect((kind === 'list' ? body.notes : body.cards).map((row: { id: string }) => row.id)).toEqual([
        'rank_0',
        'rank_1',
      ]);
    }
    await f.properties.mutateFolderProperties(f.actor, 'board', {
      expectedRevision: 9,
      mutation: { type: 'archive', propertyId: f.typeField.id },
    });
    for (const kind of ['list', 'board'] as const)
      expect((await f.request(f.url(kind, { sort }).replace('schemaRevision=4', 'schemaRevision=10'))).status).toBe(
        409
      );
  });
  it('keeps property sorts bounded over 1,000 notes and works without an enabled or present Board', async () => {
    const f = await setup();
    const start = performance.now();
    for (let batch = 0; batch < 10; batch++) {
      const entries = Array.from({ length: 100 }, (_, i) => {
        const n = batch * 100 + i;
        return {
          id: `smoke_${String(n).padStart(4, '0')}`,
          folderId: 'board',
          userId: 'owner',
          title: `Smoke ${n}`,
          content: 'PRIVATE_BODY',
          createdAt: f.now,
          updatedAt: f.now,
        };
      });
      await f.db.insert(f.schema.notes).values(entries);
      await f.db.insert(f.schema.notePropertyState).values(
        entries.map((row) => ({
          noteId: row.id,
          userId: 'owner',
          revision: 1,
          values: JSON.stringify({ [f.text.id]: row.id, [f.field.id]: f.field.options[0].id }),
          createdAt: f.now,
          updatedAt: f.now,
        }))
      );
    }
    const sort = JSON.stringify({
      version: 1,
      schemaId: f.schemaSnapshot.schemaId,
      propertyId: f.text.id,
      type: 'text',
      direction: 'desc',
    });
    for (const kind of ['list', 'board'] as const) {
      const response = await f.request(f.url(kind, { sort }));
      expect(response.status).toBe(200);
      const body = await response.json();
      const rows = kind === 'list' ? body.notes : body.cards;
      expect(rows.map((row: { id: string }) => row.id)).toEqual(['smoke_0999', 'smoke_0998']);
      expect(body.hasMore).toBe(true);
      expect(JSON.stringify(body).length).toBeLessThan(5000);
    }
    await f.boards.saveBoardConfig('owner', 'board', { ...f.config, enabled: false }, 1);
    expect((await f.request(f.url('list', { sort }))).status).toBe(200);
    await f.libsql.execute("delete from folder_board_views where folder_id = 'board'");
    expect((await f.request(f.url('list', { sort }))).status).toBe(200);
    process.stdout.write(`property-sort 1000-note seed + adapter smoke ms: ${Math.round(performance.now() - start)}\n`);
  });

  it('sorts every full dataset before either adapter paginates, with stable title/ID ties and read-only scope', async () => {
    const f = await setup();
    const records = [
      { id: 'sort_c', title: 'Sort Bravo', created: 3, updated: 1 },
      { id: 'sort_b', title: 'Sort Alpha', created: 1, updated: 3 },
      { id: 'sort_a', title: 'Sort Alpha', created: 1, updated: 3 },
      { id: 'sort_d', title: 'Sort Zulu', created: 2, updated: 2 },
      { id: 'sort_e', title: 'Sort Bravo', created: 3, updated: 1 },
    ];
    for (const row of records) {
      await f.seed(row.id, row.title);
      await f.libsql.execute({
        sql: 'update notes set created_at = ?, updated_at = ? where id = ?',
        args: [f.now + row.created, f.now + row.updated, row.id],
      });
    }
    const before = await f.libsql.execute('select * from notes');
    const orders = {
      'updated-desc': ['sort_a', 'sort_b', 'sort_d', 'sort_c', 'sort_e'],
      'updated-asc': ['sort_c', 'sort_e', 'sort_d', 'sort_a', 'sort_b'],
      'created-desc': ['sort_c', 'sort_e', 'sort_d', 'sort_a', 'sort_b'],
      'created-asc': ['sort_a', 'sort_b', 'sort_d', 'sort_c', 'sort_e'],
      'title-asc': ['sort_a', 'sort_b', 'sort_c', 'sort_e', 'sort_d'],
      'title-desc': ['sort_d', 'sort_c', 'sort_e', 'sort_a', 'sort_b'],
    };
    for (const kind of ['list', 'board'] as const)
      for (const [sort, expected] of Object.entries(orders))
        for (const filtered of [false, true]) {
          const ids: string[] = [];
          for (let page = 1; page <= 3; page++) {
            const query = {
              sort,
              ...(filtered ? { q: 'Sort', filters: encoded([f.ref(f.text.id, 'text', { operator: 'empty' })]) } : {}),
            };
            const response = await f.request(f.url(kind, query, undefined, page), 'viewer');
            expect(response.status, await response.clone().text()).toBe(200);
            const body = await response.json();
            if (sort !== 'updated-desc') expect(body.sortIdentity).toBe(sort);
            else expect(body).not.toHaveProperty('sortIdentity');
            const rows = kind === 'list' ? body.notes : body.cards;
            ids.push(...rows.map((row: { id: string }) => row.id));
            expect(body.hasMore).toBe(page < 3);
          }
          expect(ids).toEqual(expected);
          expect(new Set(ids).size).toBe(5);
        }
    for (const kind of ['list', 'board'] as const) {
      for (const sort of ['', 'title', 'TITLE-ASC', "' OR 1=1 --"])
        expect((await f.request(f.url(kind, { sort }))).status).toBe(400);
      expect((await f.request(`${f.url(kind, { sort: 'title-asc' })}&sort=title-desc`)).status).toBe(400);
      expect((await f.request(f.url(kind, { sort: 'title-asc' }), 'stranger')).status).toBe(404);
      await f.libsql.execute("delete from collaboration_grants where grantee_user_id = 'viewer'");
      expect((await f.request(f.url(kind, { sort: 'title-asc' }), 'viewer')).status).toBe(404);
    }
    expect((await f.libsql.execute('select * from notes')).rows).toEqual(before.rows);
    expect((await f.libsql.execute('select * from note_events')).rows).toEqual([]);
    expect((await f.boards.readBoardConfig('owner', 'board'))?.version).toBe(1);
    await f.boards.saveBoardConfig('owner', 'board', { ...f.config, enabled: false }, 1);
    const list = await f.request('/internal/folders/board/notes?sort=title-desc', 'owner');
    expect(list.status).toBe(200);
    expect((await list.json()).notes.map((row: { id: string }) => row.id)).toEqual(orders['title-desc']);
    await f.libsql.execute("delete from folder_board_views where folder_id = 'board'");
    const absent = await f.request('/internal/folders/board/notes?sort=title-desc', 'owner');
    expect(absent.status).toBe(200);
    expect((await absent.json()).notes.map((row: { id: string }) => row.id)).toEqual(orders['title-desc']);
  });

  it('matches beyond loaded pages in both adapters before pagination, with no query-induced writes', async () => {
    const f = await setup();
    for (let i = 0; i < 30; i++) await f.seed(`prefix_${i}`, `A ${i}`);
    await f.seed('late', 'Z literal needle', { [f.text.id]: `${'x'.repeat(200)} after preview` });
    const before = await f.libsql.execute('select * from notes');
    expect(await f.collect('list', { q: 'needle' })).toEqual(['late']);
    expect(await f.collect('board', { q: 'needle' })).toEqual(['late']);
    const query = { filters: encoded([f.ref(f.text.id, 'text', { operator: 'contains', value: 'after preview' })]) };
    expect(await f.collect('list', query)).toEqual(['late']);
    expect(await f.collect('board', query)).toEqual(['late']);
    expect((await f.libsql.execute('select * from notes')).rows).toEqual(before.rows);
    expect((await f.libsql.execute('select * from note_events')).rows).toEqual([]);
    expect((await f.boards.readBoardConfig('owner', 'board'))?.version).toBe(1);
  });
  it('uses literal title/Text substrings and does not search bodies or hidden metadata', async () => {
    const f = await setup();
    await f.seed('literal', "100%_\\' Café", { [f.text.id]: "100%_\\' Café" });
    await f.seed('other', '1000 anything', { [f.text.id]: '1000 anything' });
    for (const value of ['%_', "\\'", 'Café', 'CAF'])
      for (const kind of ['list', 'board'] as const) {
        expect(await f.collect(kind, { q: value })).toEqual(['literal']);
        expect(
          await f.collect(kind, { filters: encoded([f.ref(f.text.id, 'text', { operator: 'contains', value })]) })
        ).toEqual(['literal']);
      }
    for (const q of ['PRIVATE_BODY', 'HIDDEN_VALUE', 'CAFÉ', "' OR 1=1 --"])
      expect(await f.collect('list', { q })).toEqual([]);
  });
  it('distinguishes missing/null/blank from invalid scalar, object, array and unavailable Select values', async () => {
    const f = await setup();
    const values = {
      missing: undefined,
      null: null,
      blank: ' \t\n\u00a0',
      number: 1,
      bool: false,
      object: {},
      array: [],
      unknown: 'missing_option',
      valid: f.typeField.options[0].id,
    };
    await f.addNote('no_state', 'No property state');
    for (const [id, value] of Object.entries(values))
      await f.seed(id, id, { [f.typeField.id]: value, [f.text.id]: value, [f.date.id]: value });
    for (const [id, type] of [
      [f.typeField.id, 'select'],
      [f.text.id, 'text'],
      [f.date.id, 'date'],
    ]) {
      const query = { filters: encoded([f.ref(id, type, { operator: 'empty' })]) };
      for (const kind of ['list', 'board'] as const)
        expect(await f.collect(kind, query)).toEqual(['blank', 'missing', 'no_state', 'null']);
    }
    for (const operator of [
      { operator: 'is', optionId: f.typeField.options[0].id },
      { operator: 'anyOf', optionIds: [f.typeField.options[1].id, f.typeField.options[0].id] },
    ])
      expect(await f.collect('list', { filters: encoded([f.ref(f.typeField.id, 'select', operator)]) })).toEqual([
        'valid',
      ]);
  });
  it('compares only real calendar dates, with exclusive endpoints and inclusive ordered ranges', async () => {
    const f = await setup();
    for (const [id, value] of [
      ['before', '2028-02-28'],
      ['leap', '2028-02-29'],
      ['after', '2028-03-01'],
      ['invalid', '2026-02-29'],
      ['nul', '2028-02-29\0bad'],
    ])
      await f.seed(id, id, { [f.date.id]: value });
    for (const [condition, ids] of [
      [{ operator: 'before', value: '2028-02-29' }, ['before']],
      [{ operator: 'after', value: '2028-02-29' }, ['after']],
      [{ operator: 'between', from: '2028-02-28', to: '2028-02-29' }, ['before', 'leap']],
    ] as const)
      for (const kind of ['list', 'board'] as const)
        expect(await f.collect(kind, { filters: encoded([f.ref(f.date.id, 'date', condition)]) })).toEqual(
          [...ids].sort()
        );
  });
  it('excludes historical year-zero dates from comparisons and empty while retaining valid calendar boundaries', async () => {
    const f = await setup();
    for (const [id, value] of [
      ['zero_first', '0000-01-01'],
      ['zero_leap', '0000-02-29'],
      ['zero_last', '0000-12-31'],
      ['invalid_nonleap', '1900-02-29'],
      ['valid_earliest', '0001-01-01'],
      ['valid_latest', '9999-12-31'],
    ])
      await f.seed(id, id, { [f.date.id]: value });
    for (const [condition, ids] of [
      [{ operator: 'before', value: '2028-01-01' }, ['valid_earliest']],
      [{ operator: 'after', value: '0001-01-01' }, ['valid_latest']],
      [{ operator: 'between', from: '0001-01-01', to: '9999-12-31' }, ['valid_earliest', 'valid_latest']],
      [{ operator: 'empty' }, []],
    ] as const)
      for (const kind of ['list', 'board'] as const)
        expect(await f.collect(kind, { filters: encoded([f.ref(f.date.id, 'date', condition)]) })).toEqual([...ids]);
  });
  it('blocks repeated, stale, foreign and unavailable queries rather than returning unfiltered rows', async () => {
    const f = await setup();
    await f.seed('n', 'N');
    const invalid = [
      f.ref('foreign', 'text', { operator: 'empty' }),
      { ...f.ref(f.text.id, 'text', { operator: 'empty' }), schemaId: 'foreign' },
      f.ref(f.text.id, 'select', { operator: 'empty' }),
      f.ref(f.typeField.id, 'select', { operator: 'is', optionId: 'foreign' }),
    ];
    for (const clause of invalid)
      for (const kind of ['list', 'board'] as const)
        expect((await f.request(f.url(kind, { filters: encoded([clause]) }))).status).toBe(409);
    for (const kind of ['list', 'board'] as const) {
      expect((await f.request(`${f.url(kind, { q: 'a' })}&q=b`)).status).toBe(400);
      expect((await f.request(f.url(kind, { filters: '{}' }))).status).toBe(400);
      expect(
        (
          await f.request(
            f
              .url(kind, { filters: encoded([f.ref(f.text.id, 'text', { operator: 'empty' })]) })
              .replace('schemaRevision=4', 'schemaRevision=3')
          )
        ).status
      ).toBe(409);
      expect((await f.request(f.url(kind, { q: 'n' }), 'stranger')).status).toBe(404);
    }
  });
  it('retains direct active-note scope and rechecks access for every filtered read', async () => {
    const f = await setup();
    await f.seed('active', 'Match');
    await f.addNote('canvas', 'Match', [], { documentType: 'canvas.mindmap' });
    for (const [id, extra] of [
      ['child_note', { folderId: 'child' }],
      ['template', { type: 'template' }],
      ['trash', { deletedAt: f.now }],
      ['foreign_note', { folderId: 'foreign', userId: 'other-user' }],
    ] as const)
      await f.addNote(id, 'Match', [], extra);
    for (const actor of ['owner', 'viewer', 'editor', 'commenter'])
      for (const kind of ['list', 'board'] as const)
        expect(await f.collect(kind, { q: 'Match' }, actor)).toEqual(['active', 'canvas']);
    await f.libsql.execute("delete from collaboration_grants where grantee_user_id = 'viewer'");
    for (const kind of ['list', 'board'] as const)
      expect((await f.request(f.url(kind, { q: 'Match' }), 'viewer')).status).toBe(404);
  });
  it('ANDs conditions, blocks schema drift, and preserves unfiltered response compatibility', async () => {
    const f = await setup();
    await f.seed('match', 'Match', { [f.text.id]: 'Needle', [f.typeField.id]: f.typeField.options[0].id });
    await f.seed('wrong_type', 'Match', { [f.text.id]: 'Needle', [f.typeField.id]: f.typeField.options[1].id });
    await f.seed('wrong_text', 'Match', { [f.text.id]: 'Other', [f.typeField.id]: f.typeField.options[0].id });
    const query = {
      q: 'Match',
      filters: encoded([
        f.ref(f.text.id, 'text', { operator: 'contains', value: 'needle' }),
        f.ref(f.typeField.id, 'select', { operator: 'is', optionId: f.typeField.options[0].id }),
      ]),
    };
    for (const kind of ['list', 'board'] as const) {
      expect(await f.collect(kind, query)).toEqual(['match']);
      const plain = await (await f.request(f.url(kind))).json();
      const explicitEmpty = await (await f.request(f.url(kind, { q: ' ', filters: encoded([]) }))).json();
      expect(explicitEmpty).toEqual(plain);
      expect(plain).not.toHaveProperty('queryIdentity');
    }
    await f.properties.mutateFolderProperties(f.actor, 'board', {
      expectedRevision: 4,
      mutation: { type: 'archive', propertyId: f.text.id },
    });
    for (const kind of ['list', 'board'] as const) {
      expect((await f.request(f.url(kind, query))).status).toBe(409);
      expect((await f.request(f.url(kind, query).replace('schemaRevision=4', 'schemaRevision=5'))).status).toBe(409);
    }
  });
  it('supports title-only List queries independently of an enabled board/schema and preserves safe serialization', async () => {
    const f = await setup();
    await f.seed('n', 'Needle');
    await f.boards.saveBoardConfig('owner', 'board', { ...f.config, enabled: false }, 1);
    const result = await f.request('/internal/folders/board/notes?q=needle', 'viewer');
    expect(result.status).toBe(200);
    const body = await result.json();
    expect(body.notes).toHaveLength(1);
    expect(body.notes[0]).toHaveProperty('canTrash', false);
    expect(body.notes[0]).not.toHaveProperty('content');
    expect(body.notes[0]).not.toHaveProperty('userId');
    expect(body.notes[0]).not.toHaveProperty('createdByUserId');
    expect(body.queryIdentity).toBeTypeOf('string');
  });
});
