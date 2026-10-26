import type { InStatement } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanupBoardTests, setupBoardTest } from './board-fixtures';

const hierarchyQuery = /^select "id", "parent_folder_id", "title", "updated_at" from "folders"/;

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupBoardTests();
});

async function setupEgressTest() {
  const f = await setupBoardTest(43);
  f.app.route('/internal/share', (await import('../src/api/routes/share')).shareRoutes);
  const token = 'egress-test-token';
  await f.db.insert(f.schema.folderShareLinks).values({
    id: 'shared-board',
    userId: 'owner',
    folderId: 'board',
    token,
    tokenHash: (await import('../src/api/lib/share-tokens')).hashShareToken(token),
    permission: 'read',
    createdAt: f.now,
    updatedAt: f.now,
  });
  const returned: Array<{ sql: string; args: unknown; ids: string[]; bytes: number }> = [];
  const execute = f.libsql.execute.bind(f.libsql);
  const spy = vi.spyOn(f.libsql, 'execute').mockImplementation(async (statement: InStatement) => {
    const result = await execute(statement);
    const sql = typeof statement === 'string' ? statement : statement.sql;
    // Capture actual client results, before Drizzle mapping or HTTP filtering.
    if (sql.startsWith('select ') && result.columns.includes('content') && sql.includes('from "notes"')) {
      returned.push({
        sql,
        args: typeof statement === 'string' ? [] : statement.args,
        ids: result.rows.map((row) => String(row.id)),
        bytes: result.rows.reduce((total, row) => total + Buffer.byteLength(String(row.content), 'utf8'), 0),
      });
    }
    return result;
  });
  const read = () => f.app.request(`/internal/share/folders/${token}`);
  const folderQueries = () =>
    spy.mock.calls.filter(([statement]) =>
      hierarchyQuery.test(typeof statement === 'string' ? statement : statement.sql)
    );
  return { ...f, token, read, returned, spy, folderQueries };
}

it('returns only subtree bodies from libSQL, independent of large unrelated same-owner notes', async () => {
  const f = await setupEgressTest();
  await f.addNote('small', 'z', [], { content: 'é🙂' });
  await f.addNote('child-note', 'A', [], { folderId: 'child', content: 'child' });
  await f.addNote('canvas', 'B', [], { content: '{"nodes":[],"edges":[]}', documentType: 'canvas.default' });
  await f.addNote('template', 'Template', [], { type: 'template', content: 'excluded template' });
  await f.addNote('deleted', 'Deleted', [], { deletedAt: f.now, content: 'excluded deleted' });
  await f.db.insert(f.schema.folders).values([
    { id: 'trashed', userId: 'owner', parentFolderId: 'board', title: 'Trashed', deletedAt: f.now },
    { id: 'under-trash', userId: 'owner', parentFolderId: 'trashed', title: 'Under trash' },
  ]);
  await f.addNote('under-trash-note', 'Under trash', [], { folderId: 'under-trash' });
  await f.addNote('foreign-note', 'Foreign', [], { userId: 'other-user', folderId: 'foreign' });

  f.spy.mockClear();
  expect((await f.read()).status).toBe(200);
  expect(f.returned).toHaveLength(1);
  const baseline = f.returned[0];
  expect(baseline.ids).toEqual(['child-note', 'canvas', 'small']);
  expect(baseline.bytes).toBe(Buffer.byteLength('é🙂child{"nodes":[],"edges":[]}'));
  expect(f.folderQueries()).toHaveLength(1);

  for (let index = 0; index < 40; index++) {
    await f.addNote(`large-${index}`, `Large ${index}`, [], { folderId: 'other', content: 'x'.repeat(65_536) });
  }
  f.spy.mockClear();
  const response = await f.read();
  expect(response.status).toBe(200);
  expect(f.returned).toHaveLength(2);
  expect(f.returned[1]).toEqual(baseline);
  expect(f.folderQueries()).toHaveLength(1);
  expect(f.spy).toHaveBeenCalledTimes(3);
  expect((await response.json()).notes.map((note: { id: string }) => note.id)).toEqual(baseline.ids);

  // Compare the previous owner-wide query only against this disposable fixture.
  const { activeNoteWhere } = await import('../src/api/trash/policy');
  const previousRows = await f.db
    .select({ content: f.schema.notes.content })
    .from(f.schema.notes)
    .where(activeNoteWhere('owner', eq(f.schema.notes.type, 'note')));
  expect(previousRows).toHaveLength(43);
  expect(previousRows.reduce((bytes, note) => bytes + Buffer.byteLength(note.content), 0)).toBe(
    baseline.bytes + 2_621_440
  );
});

it('uses constant bind count beyond 999 subtree folders and preserves database title ordering', async () => {
  const f = await setupEgressTest();
  for (let offset = 0; offset < 1_100; offset += 50) {
    await f.db.insert(f.schema.folders).values(
      Array.from({ length: 50 }, (_, index) => ({
        id: `scope-${offset + index}`,
        userId: 'owner',
        parentFolderId: 'board',
        title: `Scope ${offset + index}`,
      }))
    );
  }
  for (const [id, title, folderId] of [
    ['first', 'A', 'scope-1099'],
    ['second', 'Z', 'scope-0'],
    ['third', 'a', 'child'],
    ['last', 'é', 'board'],
  ])
    await f.addNote(id, title, [], { folderId });
  const response = await f.read();
  expect(response.status).toBe(200);
  expect((await response.json()).folders).toHaveLength(1_101);
  expect(f.returned).toHaveLength(1);
  expect(f.returned[0].ids).toEqual(['first', 'second', 'third', 'last']);
  expect(f.returned[0].sql).toContain('json_each(?)');
  expect(f.returned[0].args).toHaveLength(5);
});

it('returns an empty snapshot without widening the SQL scope', async () => {
  const f = await setupEgressTest();
  await f.addNote('outside', 'Outside', [], { folderId: 'other' });
  const response = await f.read();
  expect(response.status).toBe(200);
  expect((await response.json()).notes).toEqual([]);
  expect(f.returned).toMatchObject([{ ids: [], bytes: 0 }]);
});

it.each([
  'expired',
  'revoked',
  'trashed',
  'orphaned',
  'cyclic',
  'wrong-owner',
])('denies %s shares before returning any note content', async (kind) => {
  const f = await setupEgressTest();
  await f.addNote('body', 'Body');
  if (kind === 'expired' || kind === 'revoked') {
    await f.db
      .update(f.schema.folderShareLinks)
      .set(kind === 'expired' ? { expiresAt: new Date(0) } : { revokedAt: f.now })
      .where(eq(f.schema.folderShareLinks.id, 'shared-board'));
  } else if (kind === 'trashed') {
    await f.db.update(f.schema.folders).set({ deletedAt: f.now }).where(eq(f.schema.folders.id, 'root'));
  } else {
    // Model legacy/corrupt hierarchy rows that modern FKs prevent inserting.
    await f.libsql.execute('PRAGMA foreign_keys = OFF');
    const parentFolderId = kind === 'orphaned' ? 'missing' : kind === 'cyclic' ? 'child' : 'foreign';
    await f.db.update(f.schema.folders).set({ parentFolderId }).where(eq(f.schema.folders.id, 'board'));
  }
  expect((await f.read()).status).toBe(404);
  expect(f.returned).toEqual([]);
  expect(f.folderQueries().length).toBeLessThanOrEqual(1);
});
