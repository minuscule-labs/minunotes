import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { arch, cpus, platform, tmpdir } from 'node:os';
import path from 'node:path';
import type { Client, InStatement, ResultSet, Transaction, TransactionMode } from '@libsql/client';
import { DEFAULT_BOARD_CONFIG } from '../../src/shared/board';
import { type NoteFilter, noteQueryIdentity, parseNoteQuery } from '../../src/shared/note-filters';
import { applyMigrationAtomically } from './migration-runner';

const clock = new Date('2026-10-08T12:00:00Z');
const rootPath = new URL('../../', import.meta.url);
const sentinel = 'PROPERTY_BOARD_PRIVATE_BODY_SENTINEL';
const field = {
  id: 'property_workflow',
  label: 'Workflow',
  type: 'select',
  archived: false,
  options: [
    { id: 'option_done', label: 'Done', archived: false },
    { id: 'option_ready', label: 'Ready', archived: false },
    { id: 'option_review', label: 'Review', archived: false },
    { id: 'option_empty', label: 'Empty', archived: false },
    { id: 'option_retired', label: 'Retired', archived: true },
  ],
};
const typeField = {
  id: 'property_type',
  label: 'Category',
  type: 'select',
  archived: false,
  options: [
    { id: 'type_bug', label: 'Defect', archived: false },
    { id: 'type_feature', label: 'Feature', archived: false },
    { id: 'type_task', label: 'Task', archived: false },
    { id: 'type_retired', label: 'Retired', archived: true },
  ],
};
const textField = { id: 'property_summary', label: 'Summary', type: 'text', archived: false, options: [] };
const dateField = { id: 'property_due', label: 'Due', type: 'date', archived: false, options: [] };
const fillerFields = Array.from({ length: 8 }, (_, i) => ({
  id: `property_extra_${i}`,
  label: `Extra ${i}`,
  type: 'text',
  archived: false,
  options: [],
}));
const definitions = [field, typeField, textField, dateField, ...fillerFields];
const previewText = '😀'.repeat(160) + 'PREVIEW_PRIVATE_SUFFIX';
const metadataSentinel = 'PROPERTY_BOARD_PRIVATE_METADATA_SENTINEL';
export function benchmarkCandidates() {
  return Array.from({ length: 1000 }, (_, i) => ({
    id: `bench_${String(i).padStart(4, '0')}`,
    title: `Note ${String(i).padStart(4, '0')}`,
    option:
      i < 900
        ? 'option_done'
        : i < 940
          ? 'option_ready'
          : i < 980
            ? 'option_review'
            : i < 990
              ? undefined
              : 'option_retired',
    typeOption: [
      'type_bug',
      'type_feature',
      'type_task',
      undefined,
      'type_retired',
      'unknown',
      ['type_bug'],
      { id: 'type_bug' },
    ][i % 8],
    tags: ['board', ...(i % 10 === 0 ? ['selected'] : []), ...(i % 20 === 0 ? ['hidden'] : [])],
    documentType: i % 100 === 0 ? ('canvas.default' as const) : ('markdown' as const),
  }));
}
type Trace = { sql: string; args: unknown; rows: number; control?: boolean };
function statement(stmt: InStatement) {
  return typeof stmt === 'string' ? { sql: stmt, args: [] } : stmt;
}
function instrument(client: Client, trace: Trace[]) {
  const originalExecute = client.execute.bind(client);
  const originalTransaction = client.transaction.bind(client);
  const record = async (stmt: InStatement, run: () => Promise<ResultSet>) => {
    const result = await run();
    const query = statement(stmt);
    trace.push({ sql: query.sql, args: query.args ?? [], rows: result.rows.length });
    return result;
  };
  client.execute = ((stmt: InStatement) => record(stmt, () => originalExecute(stmt))) as Client['execute'];
  client.transaction = async (mode?: TransactionMode) => {
    const tx = await originalTransaction(mode);
    trace.push({ sql: mode === 'read' ? 'BEGIN' : 'BEGIN IMMEDIATE', args: [], rows: 0, control: true });
    const execute = tx.execute.bind(tx),
      commit = tx.commit.bind(tx),
      rollback = tx.rollback.bind(tx);
    tx.execute = ((stmt: InStatement) => record(stmt, () => execute(stmt))) as Transaction['execute'];
    tx.commit = async () => {
      await commit();
      trace.push({ sql: 'COMMIT', args: [], rows: 0, control: true });
    };
    tx.rollback = async () => {
      await rollback();
      trace.push({ sql: 'ROLLBACK', args: [], rows: 0, control: true });
    };
    return tx;
  };
  return () => {
    client.execute = originalExecute;
    client.transaction = originalTransaction;
  };
}

/** No external target, no env-file loading; only a new marked local database. */
export async function runPropertyBoardBenchmark(onSandboxCreated?: (root: string) => void) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'notes-property-board-benchmark-')));
  const marker = randomBytes(32).toString('hex');
  await writeFile(path.join(root, '.owned'), marker, { mode: 0o600 });
  Object.assign(process.env, {
    ENVIRONMENT: 'test',
    TURSO_DB_URL: `file:${path.join(root, 'benchmark.db')}`,
    LIBSQL_URL: `file:${path.join(root, 'benchmark.db')}`,
    TURSO_AUTH_TOKEN: '',
    LIBSQL_AUTH_TOKEN: '',
    SES_FROM_EMAIL: '',
    RESEND_API_KEY: '',
    AWS_ACCESS_KEY_ID: '',
    AWS_SECRET_ACCESS_KEY: '',
    AWS_SESSION_TOKEN: '',
    EMAIL_PROTECTION_MODE: 'off',
  });
  let client: Client | undefined;
  let restore: (() => void) | undefined;
  try {
    onSandboxCreated?.(root);
    // Environment is local BEFORE importing the singleton DB or service.
    const [{ libsql, db }, schema, boards] = await Promise.all([
      import('../../src/api/db/client'),
      import('../../src/api/db/schema'),
      import('../../src/api/notes/boards'),
    ]);
    client = libsql;
    await client.execute(
      'create table __drizzle_migrations (id integer primary key, hash text not null, created_at integer)'
    );
    const journal = JSON.parse(await readFile(new URL('drizzle/meta/_journal.json', rootPath), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const migrations = journal.entries.filter((m) => m.idx <= 43);
    assert.equal(migrations.at(-1)?.tag, '0043_template_defaults');
    for (const entry of migrations) {
      const text = await readFile(new URL(`drizzle/${entry.tag}.sql`, rootPath), 'utf8');
      await applyMigrationAtomically(
        client,
        {
          ...entry,
          hash: createHash('sha256').update(text).digest('hex'),
          statements: text
            .split('--> statement-breakpoint')
            .map((s) => s.trim())
            .filter(Boolean),
        },
        '__drizzle_migrations'
      );
    }
    await client.execute('pragma foreign_keys=on');
    const candidates = benchmarkCandidates();
    await db.transaction(async (tx) => {
      await tx.insert(schema.user).values(
        ['owner', 'reader', 'foreign'].map((id) => ({
          id,
          name: id,
          email: `${id}@benchmark.invalid`,
          createdAt: clock,
          updatedAt: clock,
        }))
      );
      await tx.insert(schema.folders).values(
        [
          { id: 'root', userId: 'owner', title: 'Root' },
          { id: 'board', userId: 'owner', parentFolderId: 'root', title: 'Board' },
          { id: 'child', userId: 'owner', parentFolderId: 'board', title: 'Child' },
          { id: 'foreign', userId: 'foreign', title: 'Foreign' },
        ].map((f) => ({ ...f, createdAt: clock, updatedAt: clock }))
      );
      await tx.insert(schema.collaborationGrants).values({
        id: 'reader_grant',
        ownerUserId: 'owner',
        granteeUserId: 'reader',
        folderId: 'root',
        role: 'viewer',
        createdByUserId: 'owner',
        createdAt: clock,
        updatedAt: clock,
      });
      await tx.insert(schema.folderPropertySchemas).values({
        userId: 'owner',
        folderId: 'board',
        schemaId: 'schema_benchmark',
        revision: 1,
        definitions: JSON.stringify(definitions),
        createdAt: clock,
        updatedAt: clock,
      });
      for (let start = 0; start < candidates.length; start += 100) {
        const batch = candidates.slice(start, start + 100);
        await tx.insert(schema.notes).values(
          batch.map((n) => ({
            id: n.id,
            title: n.title,
            userId: 'owner',
            folderId: 'board',
            content: `${sentinel} ${n.id}`,
            documentType: n.documentType,
            createdAt: clock,
            updatedAt: clock,
          }))
        );
        const values = batch;
        if (values.length)
          await tx.insert(schema.notePropertyState).values(
            values.map((n) => ({
              noteId: n.id,
              userId: 'owner',
              revision: 1,
              values: JSON.stringify({
                [field.id]: n.option,
                [typeField.id]: n.typeOption,
                [textField.id]: previewText,
                [dateField.id]: '2028-02-29',
                ...Object.fromEntries(fillerFields.map((d) => [d.id, previewText])),
                unrelated: metadataSentinel,
              }),
              createdAt: clock,
              updatedAt: clock,
            }))
          );
      }
      await tx.insert(schema.notes).values(
        [
          { id: 'noise_child', folderId: 'child', userId: 'owner' },
          { id: 'noise_foreign', folderId: 'foreign', userId: 'foreign' },
          { id: 'noise_trash', folderId: 'board', userId: 'owner', deletedAt: clock },
          { id: 'noise_template', folderId: 'board', userId: 'owner', type: 'template' as const },
        ].map((n) => ({ ...n, title: 'Noise', content: sentinel, createdAt: clock, updatedAt: clock }))
      );
      await tx.insert(schema.tags).values(
        ['board', 'selected', 'hidden'].map((tag) => ({
          id: tag,
          userId: 'owner',
          name: tag,
          normalizedName: tag,
          createdAt: clock,
          updatedAt: clock,
        }))
      );
      for (let start = 0; start < candidates.length; start += 100)
        await tx.insert(schema.noteTags).values(
          candidates.slice(start, start + 100).flatMap((n) =>
            n.tags.map((tag) => ({
              id: `${n.id}_${tag}`,
              noteId: n.id,
              userId: 'owner',
              tagId: tag,
              createdAt: clock,
            }))
          )
        );
    });
    const config = {
      ...DEFAULT_BOARD_CONFIG,
      schemaVersion: 4,
      grouping: { type: 'select', schemaId: 'schema_benchmark', propertyId: field.id },
      cardPropertyIds: [typeField.id],
    };

    assert.equal(await boards.boardJsonCapability(), true);
    const sqlite = (await client.execute('select sqlite_version() as version')).rows[0].version;
    const count = (
      await client.execute(
        "select count(*) as count from notes where user_id='owner' and folder_id='board' and type='note' and deleted_at is null"
      )
    ).rows[0].count;
    assert.equal(Number(count), 1000);
    assert.equal((await client.execute('pragma foreign_key_check')).rows.length, 0);
    const trace: Trace[] = [];
    restore = instrument(client, trace);
    const samples: Array<{
      actor: string;
      scenario: string;
      run: number;
      lane: string;
      page: number;
      milliseconds: number;
      cards: number;
      payloadBytes: number;
      queryCount: number;
      returnedRows: number;
      transactionQueries: number;
    }> = [];
    const scenarios = [
      { name: 'single-select-baseline', ids: [typeField.id] },
      { name: 'none', ids: [] },
      { name: 'text-select-date', ids: [dateField.id, textField.id, typeField.id] },
      { name: 'all-twelve-max-preview', ids: definitions.map((d) => d.id) },
    ];
    for (const [index, scenario] of scenarios.entries()) {
      await boards.saveBoardConfig('owner', 'board', { ...config, cardPropertyIds: scenario.ids }, index, {
        schemaId: 'schema_benchmark',
        schemaRevision: 1,
      });
      for (const actor of ['owner', 'reader'])
        for (let run = 0; run < 4; run++) {
          trace.length = 0;
          const start = performance.now();
          const board = await boards.readAuthorizedBoard(actor, 'owner', 'board');
          assert(board);
          samples.push({
            actor,
            scenario: scenario.name,
            run,
            lane: 'config',
            page: 0,
            milliseconds: performance.now() - start,
            cards: 0,
            payloadBytes: Buffer.byteLength(JSON.stringify(board)),
            queryCount: trace.length,
            returnedRows: trace.reduce((n, q) => n + q.rows, 0),
            transactionQueries: trace.filter((q) => q.control).length,
          });
          for (const [lane, page] of [
            ...board.columns.map((c) => [c.key, 1] as const),
            ['option_done', 2],
            ['option_done', 9],
            ['option_ready', 2],
            ['unclassified', 2],
          ] as Array<readonly [string, number]>) {
            trace.length = 0;
            const start = performance.now();
            const result = await boards.readAuthorizedBoardLane({
              actorUserId: actor,
              userId: 'owner',
              folderId: 'board',
              lane,
              version: index + 1,
              schemaId: 'schema_benchmark',
              schemaRevision: 1,
              page: { page, limit: 25, offset: (page - 1) * 25 },
            });
            const expected = candidates.filter((n) =>
              lane === 'unclassified'
                ? !['option_done', 'option_ready', 'option_review', 'option_empty'].includes(n.option ?? '')
                : n.option === lane
            );
            assert.deepEqual(
              result.cards.map((c) => c.id),
              expected.slice((page - 1) * 25, page * 25).map((n) => n.id)
            );
            assert.equal(result.hasMore, expected.length > page * 25);
            for (const [index, card] of result.cards.entries()) {
              const value = expected[(page - 1) * 25 + index].typeOption;
              const option = typeField.options.find((o) => o.id === value && !o.archived);
              assert.deepEqual(
                card.properties.find((p) => p.propertyId === typeField.id),
                scenario.ids.includes(typeField.id) && option
                  ? {
                      propertyId: typeField.id,
                      type: 'select',
                      optionId: option.id,
                      label: typeField.label,
                      value: option.label,
                    }
                  : undefined
              );
              assert(!('typeOptionId' in card));
              assert(card.properties.length <= 12);
              assert.deepEqual(
                card.properties.map((p) => p.propertyId),
                definitions
                  .filter((d) => scenario.ids.includes(d.id))
                  .filter((d) => d.id !== typeField.id || !!option)
                  .filter(
                    (d) =>
                      d.id !== field.id ||
                      field.options.some((o) => !o.archived && o.id === expected[(page - 1) * 25 + index].option)
                  )
                  .map((d) => d.id)
              );
              for (const property of card.properties) {
                if (property.type === 'text') {
                  assert.equal(Array.from(property.value).length, 160);
                  assert.equal(property.truncated, true);
                }
                if (property.type === 'date') assert.equal(property.value, '2028-02-29');
              }
            }
            assert(trace.length <= 9, 'No per-card queries');
            for (const q of trace.filter((q) => q.sql.includes('left join "note_property_state"'))) {
              assert.equal((q.args as unknown[]).includes(`$."${typeField.id}"`), scenario.ids.includes(typeField.id));
              assert(q.rows <= 26, 'Only page-size+1 candidates returned');
              assert(!/(?:select |, )"note_property_state"\."values"(?:, | from)/.test(q.sql));
            }
            const payload = JSON.stringify(result);
            assert(!payload.includes(sentinel));
            assert(!payload.includes(metadataSentinel));
            assert(!payload.includes('PREVIEW_PRIVATE_SUFFIX'));
            assert(!/preview_\\d|typeOptionId/.test(payload));
            assert(result.cards.length <= 25);
            samples.push({
              actor,
              scenario: scenario.name,
              run,
              lane,
              page,
              milliseconds: performance.now() - start,
              cards: result.cards.length,
              payloadBytes: Buffer.byteLength(payload),
              queryCount: trace.length,
              returnedRows: trace.reduce((n, q) => n + q.rows, 0),
              transactionQueries: trace.filter((q) => q.control).length,
            });
            // Keep each distinct real SQL/bound-parameter card plan, including offset.
            for (const q of trace.filter((q) => q.sql.includes('left join "note_property_state"')))
              planQueries.set(JSON.stringify([q.sql, q.args]), q);
          }
        }
    }
    const folderQueries = await import('../../src/api/notes/folder-query');
    const selectedBoard = await boards.saveBoardConfig('owner', 'board', config, 4, {
      schemaId: 'schema_benchmark',
      schemaRevision: 1,
    });
    assert(selectedBoard);
    const ref = { schemaId: 'schema_benchmark' };
    const textCondition: NoteFilter = {
      ...ref,
      propertyId: textField.id,
      type: 'text',
      operator: 'contains',
      value: 'VATE_SU',
    };
    const anyCondition: NoteFilter = {
      ...ref,
      propertyId: typeField.id,
      type: 'select',
      operator: 'anyOf',
      optionIds: ['type_feature', 'type_bug'],
    };
    const dateCondition: NoteFilter = {
      ...ref,
      propertyId: dateField.id,
      type: 'date',
      operator: 'between',
      from: '2028-02-29',
      to: '2028-02-29',
    };
    const filteredCases = [
      { name: 'late-title', q: 'Note 0999', all: [], expected: candidates.filter((n) => n.id === 'bench_0999') },
      { name: 'title-across-lanes', q: 'Note 09', all: [], expected: candidates.slice(900) },
      { name: 'hidden-text-after-preview', q: '', all: [textCondition], expected: candidates },
      {
        name: 'select-any-of',
        q: '',
        all: [anyCondition],
        expected: candidates.filter((n) => ['type_bug', 'type_feature'].includes(n.typeOption as string)),
      },
      { name: 'inclusive-date', q: '', all: [dateCondition], expected: candidates },
      {
        name: 'combined',
        q: 'Note 09',
        all: [textCondition, anyCondition, dateCondition],
        expected: candidates.slice(900).filter((n) => ['type_bug', 'type_feature'].includes(n.typeOption as string)),
      },
      {
        name: 'empty-select',
        q: '',
        all: [{ ...ref, propertyId: typeField.id, type: 'select', operator: 'empty' } as NoteFilter],
        expected: candidates.filter((n) => n.typeOption === undefined),
      },
      { name: 'no-match', q: 'not present', all: [], expected: [] },
    ];
    const filteredSamples: Array<{
      scenario: string;
      actor: string;
      view: string;
      lane: string;
      page: number;
      milliseconds: number;
      rows: number;
      payloadBytes: number;
      queryCount: number;
      returnedRows: number;
    }> = [];
    const parity: Array<{ scenario: string; actor: string; matches: number; listIds: string[]; boardIds: string[] }> =
      [];
    const filteredPlanQueries = new Map<string, Trace>();
    for (const actor of ['owner', 'reader'])
      for (const scenario of filteredCases) {
        const query = parseNoteQuery({ q: scenario.q, filters: JSON.stringify({ version: 1, all: scenario.all }) });
        const byView = new Map<string, string[]>();
        for (const view of ['list', 'board']) {
          const ids: string[] = [];
          for (const lane of view === 'list' ? ['flat'] : selectedBoard.columns.map((c) => c.key)) {
            const expected = scenario.expected.filter(
              (n) =>
                view === 'list' ||
                (lane === 'unclassified'
                  ? !['option_done', 'option_ready', 'option_review', 'option_empty'].includes(n.option ?? '')
                  : n.option === lane)
            );
            for (let page = 1; ; page++) {
              trace.length = 0;
              const start = performance.now();
              const input = {
                actorUserId: actor,
                ownerId: 'owner',
                userId: 'owner',
                folderId: 'board',
                query,
                schemaId: 'schema_benchmark',
                schemaRevision: 1,
                page: { page, limit: 25, offset: (page - 1) * 25 },
              };
              const result =
                view === 'list'
                  ? await folderQueries.readFilteredFolderNotes(input)
                  : await boards.readAuthorizedBoardLane({ ...input, lane, version: 5 });
              const rows = 'documents' in result ? result.documents : result.cards;
              assert.deepEqual(
                rows.map((n) => n.id),
                expected.slice((page - 1) * 25, page * 25).map((n) => n.id)
              );
              assert.equal(result.hasMore, expected.length > page * 25);
              assert.equal(result.queryIdentity, noteQueryIdentity(query));
              ids.push(...rows.map((n) => n.id));
              assert(trace.length <= 9, 'Filtered reads must retain constant query budget');
              for (const q of trace.filter((q) => q.sql.includes('left join "note_property_state"'))) {
                assert(q.rows <= 26, 'Filtered candidates are bounded before return');
                filteredPlanQueries.set(JSON.stringify([q.sql, q.args]), q);
              }
              const payload = JSON.stringify(result);
              assert(
                !payload.includes(sentinel) &&
                  !payload.includes(metadataSentinel) &&
                  !payload.includes('PREVIEW_PRIVATE_SUFFIX')
              );
              assert(!/(?:"content"|"values"|"preview_\d+")/.test(payload));
              assert(rows.length <= 25);
              filteredSamples.push({
                scenario: scenario.name,
                actor,
                view,
                lane,
                page,
                milliseconds: performance.now() - start,
                rows: rows.length,
                payloadBytes: Buffer.byteLength(payload),
                queryCount: trace.length,
                returnedRows: trace.reduce((sum, q) => sum + q.rows, 0),
              });
              if (!result.hasMore) break;
            }
          }
          assert.equal(new Set(ids).size, ids.length);
          byView.set(view, ids.sort());
          assert.deepEqual(ids, scenario.expected.map((n) => n.id).sort());
        }
        const listIds = byView.get('list') ?? [],
          boardIds = byView.get('board') ?? [];
        assert.deepEqual(listIds, boardIds);
        parity.push({ scenario: scenario.name, actor, matches: listIds.length, listIds, boardIds });
      }
    restore();
    restore = undefined;
    const filteredPlans = [];
    for (const q of filteredPlanQueries.values())
      filteredPlans.push({
        sql: q.sql,
        args: q.args,
        plan: (await client.execute({ sql: `EXPLAIN QUERY PLAN ${q.sql}`, args: q.args as never })).rows,
      });
    const plans = [];
    for (const q of planQueries.values())
      plans.push({
        sql: q.sql,
        args: q.args,
        plan: (await client.execute({ sql: `EXPLAIN QUERY PLAN ${q.sql}`, args: q.args as never })).rows,
      });
    const require = createRequire(import.meta.url);
    const packageVersion = async (name: string) => {
      let directory = path.dirname(require.resolve(name));
      for (;;) {
        try {
          const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
          if (pkg.name === name) return pkg.version as string;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const parent = path.dirname(directory);
        if (parent === directory) throw new Error(`Package version not found: ${name}`);
        directory = parent;
      }
    };
    return {
      environment: {
        node: process.version,
        platform: platform(),
        arch: arch(),
        cpu: cpus()[0]?.model,
        libsqlClient: await packageVersion('@libsql/client'),
        drizzle: await packageVersion('drizzle-orm'),
        sqlite,
        jsonScalarExtraction: true,
        database: 'new owned local file; migrated through 0043; removed in finally',
      },
      fixture: {
        seed: 'fixed sequential IDs/clock 2026-10-08',
        candidates: 1000,
        done: 900,
        ready: 40,
        review: 40,
        unset: 10,
        archived: 10,
        empty: 0,
        excludedTag: 50,
        selectedTag: 100,
        noise: 4,
        typePropertyId: typeField.id,
        typeLabels: typeField.options.filter((o) => !o.archived).map(({ id, label }) => ({ id, label })),
        typeBadges: candidates.filter((n) => typeField.options.some((o) => !o.archived && o.id === n.typeOption))
          .length,
        typeBadgesVerified: true,
      },
      samples,
      plans,
      filtered: {
        samples: filteredSamples,
        parity,
        plans: filteredPlans,
        maxQueryCount: Math.max(...filteredSamples.map((s) => s.queryCount)),
        maxPayloadBytes: Math.max(...filteredSamples.map((s) => s.payloadBytes)),
        maxReturnedRows: Math.max(...filteredSamples.map((s) => s.returnedRows)),
      },
      scenarios: scenarios.map((scenario) => {
        const values = samples.filter((s) => s.scenario === scenario.name);
        return {
          name: scenario.name,
          selected: scenario.ids.length,
          maxQueryCount: Math.max(...values.map((s) => s.queryCount)),
          maxPayloadBytes: Math.max(...values.map((s) => s.payloadBytes)),
          maxReturnedRows: Math.max(...values.map((s) => s.returnedRows)),
          milliseconds: values.map((s) => s.milliseconds),
        };
      }),
      summary: {
        cold: samples.filter((s) => s.run === 0),
        warmMilliseconds: samples.filter((s) => s.run > 0).map((s) => s.milliseconds),
        maxPayloadBytes: Math.max(...samples.map((s) => s.payloadBytes)),
        maxQueryCount: Math.max(...samples.map((s) => s.queryCount)),
        maxReturnedRows: Math.max(...samples.map((s) => s.returnedRows)),
      },
    };
  } finally {
    restore?.();
    client?.close();
    assert.equal(await readFile(path.join(root, '.owned'), 'utf8'), marker);
    assert.equal(await realpath(root), root);
    await rm(root, { recursive: true });
    planQueries.clear();
  }
}
const planQueries = new Map<string, Trace>();
