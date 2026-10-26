import { eq } from 'drizzle-orm';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanupPropertyBoardTests, setupPropertyBoardTest } from './property-board-fixtures';

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupPropertyBoardTests();
});

async function setupSharedBoard(folderId = 'board') {
  const f = await setupPropertyBoardTest();
  vi.stubEnv('FRONTEND_URL', 'https://notes.example.test');
  f.app.route('/internal/share', (await import('../src/api/routes/share')).shareRoutes);
  const { config, token: schemaToken, typeField } = await f.addType();
  expect((await f.saveSelect(config, 0, 'owner', schemaToken)).status).toBe(200);
  const createLink = (regenerate = false) =>
    f.app.request(`/internal/folders/${folderId}/share-link`, {
      method: 'POST',
      body: JSON.stringify({ regenerate }),
      headers: { 'content-type': 'application/json' },
    });
  const response = await createLink();
  expect(response.status).toBe(201);
  const { shareLink } = await response.json();
  const token = new URL(shareLink.url).pathname.split('/').pop();
  const prefix = `/internal/share/folders/${token}/folders`;
  const configUrl = `${prefix}/board/board/config`;
  const laneUrl = `${prefix}/board/board?lane=${f.field.options[0].id}&version=1&schemaId=${schemaToken.schemaId}&schemaRevision=${schemaToken.schemaRevision}`;
  const read = (url: string) => f.app.request(url, { headers: { 'x-user': 'anonymous' } });
  return { ...f, createLink, shareLink, token, prefix, configUrl, laneUrl, read, typeField };
}

it('shares visibility projection, full classification and zero-column states without changing note access', async () => {
  const f = await setupSharedBoard();
  for (const [id, value] of Object.entries({
    visible: f.field.options[0].id,
    hidden: f.field.options[1].id,
    archived: f.field.options[3].id,
    unknown: 'unknown',
    invalid: 42,
  })) {
    await f.addNote(id, id);
    await f.db.insert(f.schema.notePropertyState).values({
      noteId: id,
      userId: 'owner',
      revision: 1,
      values: JSON.stringify({ [f.field.id]: value }),
      createdAt: f.now,
      updatedAt: f.now,
    });
  }
  await f.addNote('unset', 'Unset');
  const schema = await f.properties.mutateFolderProperties(f.actor, 'board', {
    expectedRevision: 2,
    mutation: { type: 'archive_option', propertyId: f.field.id, optionId: f.field.options[3].id },
  });
  const { board: initial } = await (await f.read(f.configUrl)).json();
  const publicUrl = (lane: string, version: number, page = 1) =>
    `${f.prefix}/board/board?lane=${lane}&version=${version}&schemaId=${schema.schemaId}&schemaRevision=3&limit=1&page=${page}`;
  let version = 1;
  for (const optionIds of [undefined, [f.field.options[0].id], []]) {
    for (const showUnclassified of [true, false]) {
      const columnVisibility =
        optionIds === undefined ? { mode: 'all', showUnclassified } : { mode: 'selected', optionIds, showUnclassified };
      expect(
        (
          await f.saveSelect({ ...initial.config, columnVisibility }, version, 'owner', {
            schemaId: schema.schemaId as string,
            schemaRevision: 3,
          })
        ).status
      ).toBe(200);
      version++;
      const { board } = await (await f.read(f.configUrl)).json();
      const ownerConfig = await (await f.request('/internal/folders/board/board/config')).json();
      expect(board).toEqual(ownerConfig.board);
      const active = schema.definitions[0].options.filter(
        (o) => !o.archived && (!optionIds || optionIds.includes(o.id))
      );
      expect(board.columns.map((c: { key: string }) => c.key)).toEqual([
        ...active.map((o) => o.id),
        ...(showUnclassified ? ['unclassified'] : []),
      ]);
      expect(board.groupingState.available).toBe(true);
      for (const lane of [...f.field.options.map((o) => o.id), 'unclassified']) {
        const url = publicUrl(lane, version);
        const displayed = board.columns.some((c: { key: string }) => c.key === lane);
        const response = await f.read(url);
        expect(response.status).toBe(displayed ? 200 : 400);
        if (!displayed) continue;
        const ids: string[] = [];
        for (let page = 1; page <= 5; page++) {
          const pageUrl = publicUrl(lane, version, page);
          const publicPage = await (await f.read(pageUrl)).json();
          const { access: _access, ...ownerPage } = await (
            await f.request(pageUrl.replace(`${f.prefix}/board`, '/internal/folders/board'), 'viewer')
          ).json();
          expect(publicPage).toEqual(ownerPage);
          ids.push(...publicPage.cards.map((c: { id: string }) => c.id));
          if (!publicPage.hasMore) break;
        }
        expect(ids.sort()).toEqual(
          lane === 'unclassified'
            ? ['archived', 'invalid', 'unknown', 'unset']
            : lane === f.field.options[0].id
              ? ['visible']
              : lane === f.field.options[1].id
                ? ['hidden']
                : []
        );
      }
      expect((await f.read(publicUrl('unclassified', version - 1, 2))).status).toBe(409);
      expect(
        (await f.read(publicUrl('unclassified', version, 2).replace('schemaRevision=3', 'schemaRevision=2'))).status
      ).toBe(409);
    }
  }
  // Even a zero-column Board does not narrow the folder share or authenticated note access.
  const sharedList = await (await f.read(`/internal/share/folders/${f.token}`)).json();
  expect(sharedList.notes.map((n: { id: string }) => n.id).sort()).toEqual([
    'archived',
    'hidden',
    'invalid',
    'unknown',
    'unset',
    'visible',
  ]);
  expect(sharedList.notes.find((n: { id: string }) => n.id === 'hidden').content).toBe('Private body for hidden');
  expect((await f.app.request('/internal/folders/board/share-link', { method: 'DELETE' })).status).toBe(200);
  for (const url of [f.configUrl, publicUrl('unclassified', version)]) expect((await f.read(url)).status).toBe(404);
});

it('presents the existing folder share as the same board, anonymously and read-only', async () => {
  const f = await setupSharedBoard('root');
  await f.addNote('public', 'Public card');
  await f.patch('public', { [f.field.id]: f.field.options[0].id, [f.typeField.id]: f.typeField.options[0].id });
  await f.addNote('child-note', 'Child note', [], { folderId: 'child' });
  await f.addNote('template', 'Template', [], { type: 'template' });
  await f.addNote('trashed', 'Trashed', [], { deletedAt: f.now });
  const queries = vi.spyOn(f.libsql, 'execute');
  const hierarchyReads = () =>
    queries.mock.calls.filter(([s]) => /^select "id", "parent_folder_id"/.test(typeof s === 'string' ? s : s.sql));
  const publicConfig = await f.read(f.configUrl);
  expect(publicConfig.status).toBe(200);
  expect(hierarchyReads()).toHaveLength(1);
  expect(publicConfig.headers.get('cache-control')).toBe('no-store');
  const ownerConfig = await (await f.request('/internal/folders/board/board/config')).json();
  expect(await publicConfig.json()).toEqual({ board: ownerConfig.board });
  queries.mockClear();
  const lane = await f.read(f.laneUrl);
  expect(lane.status).toBe(200);
  expect(hierarchyReads()).toHaveLength(1);
  expect(lane.headers.get('cache-control')).toBe('no-store');
  const result = await lane.json();
  expect(result.cards).toMatchObject([{ id: 'public', properties: [{ label: 'Type', value: 'Bug' }] }]);
  expect(result.cards).toHaveLength(1);
  for (const key of ['content', 'userId', 'tags', 'updatedByActorId']) expect(result.cards[0]).not.toHaveProperty(key);
  const ownerLane = await (await f.request(f.laneUrl.replace(`${f.prefix}/board`, '/internal/folders/board'))).json();
  const { access: _access, ...ownerPage } = ownerLane;
  expect(result).toEqual(ownerPage);
  for (const [url, method] of [
    [f.configUrl, 'PUT'],
    [f.laneUrl, 'POST'],
    [f.laneUrl, 'DELETE'],
  ] as const)
    expect((await f.app.request(url, { method, body: '{}', headers: { 'x-user': 'anonymous' } })).status).toBe(404);
  expect((await (await f.read(f.configUrl)).json()).board.version).toBe(1);
});

it('keeps board reads within the existing share subtree and rejects other tokens', async () => {
  const f = await setupSharedBoard();
  for (const folderId of ['root', 'other', 'foreign', 'missing']) {
    for (const suffix of ['/config', '']) {
      const response = await f.read(`${f.prefix}/${folderId}/board${suffix}${suffix ? '' : '?lane=unclassified'}`);
      expect(response.status).toBe(404);
    }
  }
  expect((await f.read(`${f.prefix}/child/board/config`)).status).toBe(200);
  for (const url of [f.configUrl, f.laneUrl])
    expect((await f.read(url.replace(`/folders/${f.token}/`, '/folders/invalid/'))).status).toBe(404);
});

it('uses the same rotation, expiry, revocation and active-folder checks for both presentations', async () => {
  const f = await setupSharedBoard();
  const rotated = await (await f.createLink(true)).json();
  const nextToken = new URL(rotated.shareLink.url).pathname.split('/').pop();
  const urls = [f.configUrl, f.laneUrl];
  for (const url of urls) expect((await f.read(url)).status).toBe(404);
  const currentUrls = urls.map((url) => url.replace(`/folders/${f.token}/`, `/folders/${nextToken}/`));
  for (const url of currentUrls) expect((await f.read(url)).status).toBe(200);
  await f.db
    .update(f.schema.folderShareLinks)
    .set({ expiresAt: new Date(0) })
    .where(eq(f.schema.folderShareLinks.id, rotated.shareLink.id));
  for (const url of currentUrls) expect((await f.read(url)).status).toBe(404);
  await f.db
    .update(f.schema.folderShareLinks)
    .set({ expiresAt: null })
    .where(eq(f.schema.folderShareLinks.id, rotated.shareLink.id));
  await f.db.update(f.schema.folders).set({ deletedAt: f.now }).where(eq(f.schema.folders.id, 'root'));
  for (const url of currentUrls) expect((await f.read(url)).status).toBe(404);
  await f.db.update(f.schema.folders).set({ deletedAt: null }).where(eq(f.schema.folders.id, 'root'));
  expect((await f.app.request('/internal/folders/board/share-link', { method: 'DELETE' })).status).toBe(200);
  for (const url of currentUrls) expect((await f.read(url)).status).toBe(404);
});

it('public Board filters combine selected values with Not set without widening stale options', async () => {
  const f = await setupSharedBoard();
  for (const [id, type] of [
    ['backlog', f.typeField.options[0].id],
    ['empty', null],
    ['other', f.typeField.options[1].id],
  ] as const) {
    await f.addNote(id, id);
    await f.patch(id, { [f.field.id]: f.field.options[0].id, [f.typeField.id]: type });
  }
  const filtered = (optionIds: string[]) =>
    `${f.laneUrl}&filters=${encodeURIComponent(
      JSON.stringify({
        version: 1,
        all: [
          {
            schemaId: f.config.grouping.schemaId,
            propertyId: f.typeField.id,
            type: 'select',
            operator: 'anyOf',
            optionIds,
            includeEmpty: true,
          },
        ],
      })
    )}`;
  const response = await f.read(filtered([f.typeField.options[0].id]));
  expect(response.status).toBe(200);
  expect((await response.json()).cards.map((card: { id: string }) => card.id).sort()).toEqual(['backlog', 'empty']);
  expect((await f.read(filtered(['unavailable']))).status).toBe(409);
});

it('reuses board pagination, validation and snapshot checks', async () => {
  const f = await setupSharedBoard();
  for (let i = 0; i < 26; i++) {
    const id = `card-${String(i).padStart(2, '0')}`;
    await f.addNote(id, id);
    await f.patch(id, { [f.field.id]: f.field.options[0].id });
  }
  const first = await (await f.read(f.laneUrl)).json();
  const second = await (await f.read(`${f.laneUrl}&page=2`)).json();
  expect(first).toMatchObject({ hasMore: true, page: 1, limit: 25 });
  expect(first.cards).toHaveLength(25);
  expect(second).toMatchObject({ hasMore: false, page: 2 });
  expect(second.cards).toHaveLength(1);
  expect(new Set([...first.cards, ...second.cards].map((card) => card.id)).size).toBe(26);
  for (const extra of ['&version=1', '&lane=other', '&tag=retired', '&page=9999999999', '&schemaId=invalid.path'])
    expect((await f.read(`${f.laneUrl}${extra}`)).status).toBe(400);
  expect((await f.read(f.laneUrl.replace('version=1', 'version=2'))).status).toBe(409);
  expect((await f.read(f.laneUrl.replace('schemaRevision=2', 'schemaRevision=1'))).status).toBe(409);
});
