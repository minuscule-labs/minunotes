import { eq } from 'drizzle-orm';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanupPropertyBoardTests, setupPropertyBoardTest } from './property-board-fixtures';

afterEach(cleanupPropertyBoardTests);
it('property grouping ignores ordinary note tags and never hydrates them on cards', async () => {
  const f = await setupPropertyBoardTest();
  await f.saveSelect();
  for (const [id, extra] of Object.entries({
    direct: {},
    canvas: { documentType: 'canvas.mindmap' },
    template: { type: 'template' },
    trash: { deletedAt: f.now },
    child: { folderId: 'child' },
    foreign: { folderId: 'foreign', userId: 'other-user' },
  })) {
    await f.addNote(id, id, ['status-done', 'hidden'], extra);
    await f.db.insert(f.schema.notePropertyState).values({
      noteId: id,
      userId: id === 'foreign' ? 'other-user' : 'owner',
      values: JSON.stringify({ [f.field.id]: f.field.options[0].id }),
      revision: 1,
      createdAt: f.now,
      updatedAt: f.now,
    });
  }
  await f.addNote('unset', 'unset', ['status-todo']);
  const page = await (await f.request(f.laneUrl(f.field.options[0].id), 'viewer')).json();
  expect(page.cards.map((c: { id: string }) => c.id)).toEqual(['canvas', 'direct']);
  for (const card of page.cards)
    for (const key of ['tags', 'content', 'userId', 'updatedByActorId']) expect(card).not.toHaveProperty(key);
  expect(page.access).toMatchObject({ role: 'viewer', source: 'folder_grant' });
  expect((await (await f.request(f.laneUrl('unclassified'))).json()).cards).toMatchObject([
    { id: 'unset', unclassifiedReason: 'no-property-value' },
  ]);
});
it('rejects obsolete tag parameters, duplicate tokens and invalid/stale requests', async () => {
  const f = await setupPropertyBoardTest();
  await f.saveSelect();
  for (const extra of [
    '&tag=anything',
    '&tag=',
    '&boardTags=anything',
    '&includeTags=anything',
    '&excludeTags=anything',
    '&version=1',
    '&schemaRevision=1',
    '&page=1&page=2',
    '&schemaId=invalid.path',
  ])
    expect((await f.request(f.laneUrl('unclassified', 1, 1, extra))).status).toBe(400);
  expect((await f.request(f.laneUrl('unknown'))).status).toBe(400);
  expect((await f.request(f.laneUrl('unclassified', 1, 2))).status).toBe(409);
  expect((await f.request(f.laneUrl('unclassified', 1, 1, '&page=9999999999'))).status).toBe(400);
});
it('rechecks grants and ancestors on every read; note grants do not grant board access', async () => {
  const f = await setupPropertyBoardTest();
  await f.saveSelect();
  await f.addNote('direct', 'Direct');
  await f.db.insert(f.schema.collaborationGrants).values({
    id: 'direct',
    ownerUserId: 'owner',
    granteeUserId: 'stranger',
    noteId: 'direct',
    role: 'viewer',
    createdByUserId: 'owner',
    createdAt: f.now,
    updatedAt: f.now,
  });
  expect((await f.request(f.laneUrl('unclassified'), 'stranger')).status).toBe(404);
  expect((await f.request(f.laneUrl('unclassified'), 'viewer')).status).toBe(200);
  await f.db.delete(f.schema.collaborationGrants).where(eq(f.schema.collaborationGrants.id, 'grant_viewer'));
  expect((await f.request(f.laneUrl('unclassified'), 'viewer')).status).toBe(404);
  await f.db.update(f.schema.folders).set({ deletedAt: f.now }).where(eq(f.schema.folders.id, 'root'));
  expect((await f.request(f.laneUrl('unclassified'))).status).toBe(404);
  expect((await f.saveSelect(f.config, 1)).status).toBe(404);
});
it('reads more than 100 lane cards with a single bounded query and no metadata mutations', async () => {
  const f = await setupPropertyBoardTest();
  await f.saveSelect();
  for (let i = 0; i < 131; i++) {
    const id = `n${String(i).padStart(3, '0')}`;
    await f.addNote(id, 'Same title', ['ordinary']);
    await f.patch(id, { [f.field.id]: f.field.options[0].id });
  }
  await f.db.update(f.schema.notes).set({ updatedAt: f.now });
  const tables = ['notes', 'note_tags', 'note_events', 'note_links', 'note_property_state'];
  const before = await Promise.all(
    tables.map(async (table) => (await f.libsql.execute(`select * from ${table}`)).rows)
  );
  const board = await f.boards.readBoardConfig('owner', 'board');
  if (!board) throw Error('Missing board');
  const spy = vi.spyOn(f.libsql, 'execute');
  const input = { actorUserId: 'viewer', userId: 'owner', folderId: 'board', board, lane: f.field.options[0].id };
  const first = await f.boards.readBoardLane({ ...input, page: { page: 1, limit: 100, offset: 0 } });
  expect(spy.mock.calls).toHaveLength(1);
  spy.mockClear();
  const second = await f.boards.readBoardLane({ ...input, page: { page: 2, limit: 100, offset: 100 } });
  expect(spy.mock.calls).toHaveLength(1);
  spy.mockRestore();
  expect(first).toMatchObject({ hasMore: true });
  expect(second).toMatchObject({ hasMore: false });
  expect([...first.cards, ...second.cards].map((c) => c.id)).toEqual(
    Array.from({ length: 131 }, (_, i) => `n${String(i).padStart(3, '0')}`)
  );
  expect(
    await Promise.all(tables.map(async (table) => (await f.libsql.execute(`select * from ${table}`)).rows))
  ).toEqual(before);
  expect((await f.app.request('/internal/folders/board/board/moves', { method: 'POST', body: '{}' })).status).toBe(404);
});
