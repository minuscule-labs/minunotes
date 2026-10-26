import type { InStatement } from '@libsql/client';
import { afterEach, expect, it, vi } from 'vitest';
import { publicShareCauseCodes, ShareReadMeasurement } from '../src/api/lib/share-observability';
import { cleanupBoardTests, setupBoardTest } from './board-fixtures';

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupBoardTests();
});

function privateDatabaseError() {
  return new Error('SQL select content; params: secret-token owner@example.com private-title private-body', {
    cause: Object.assign(new Error('libsql://private-host?authToken=private-key'), {
      code: 'SERVER_ERROR',
      cause: Object.assign(new Error('/internal/share/folders/secret-token?query=secret-query'), {
        code: 'UND_ERR_CONNECT_TIMEOUT',
      }),
    }),
  });
}

async function setupObservabilityTest() {
  const f = await setupBoardTest(43);
  const token = 'secret-token';
  await f.db.insert(f.schema.folderShareLinks).values({
    id: 'share-observability',
    userId: 'owner',
    folderId: 'board',
    token,
    tokenHash: (await import('../src/api/lib/share-tokens')).hashShareToken(token),
    permission: 'read',
    createdAt: f.now,
    updatedAt: f.now,
  });
  // Exercise the real production app, including rate limits and its onError handler.
  const { default: app } = await import('../src/api/index');
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  const read = (path = `/internal/share/folders/${token}?query=secret-query`) =>
    app.fetch(new Request(`https://api.example.test${path}`), {
      requestContext: { http: { sourceIp: '203.0.113.10' } },
    } as never);
  const event = () => {
    expect(info).toHaveBeenCalledTimes(1);
    expect(errorLog).not.toHaveBeenCalled();
    expect(info.mock.calls[0][0]).toBe('[PUBLIC SHARE]');
    return info.mock.calls[0][1];
  };
  const expectPrivate = () => {
    const output = JSON.stringify([...info.mock.calls, ...errorLog.mock.calls]);
    for (const secret of [
      'secret-token',
      'secret-query',
      'owner@example.com',
      'private-title',
      'private-body',
      'private-note-id',
      'select content',
      'private-host',
      'private-key',
      '/internal/share',
      'params:',
      'owner"',
    ]) {
      expect(output).not.toContain(secret);
    }
  };
  return { ...f, read, event, info, errorLog, expectPrivate };
}

it('accounts UTF-8 content bytes without serialization and records note/total durations', async () => {
  const clock = vi.spyOn(performance, 'now');
  clock.mockReturnValueOnce(100).mockReturnValueOnce(102).mockReturnValueOnce(108).mockReturnValueOnce(115);
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const measurement = new ShareReadMeasurement();
  measurement.folderQueryCalls++;
  const rows = [{ content: 'é🙂', title: 'private-title' }, { content: '' }];
  expect(await measurement.fetchNotes(async () => rows)).toBe(rows);
  measurement.complete(200);
  expect(info.mock.calls[0][1]).toMatchObject({
    operation: 'public_share.folder_snapshot',
    status: 200,
    outcome: 'success',
    duration_ms: 15,
    note_fetch_duration_ms: 6,
    folder_query_calls: 1,
    note_fetch_batches: 1,
    note_count: 2,
    note_content_bytes: 6,
  });
  expect(JSON.stringify(info.mock.calls)).not.toContain('private-title');
});

it('bounds nested causes and accepts only exact allowlisted code properties', () => {
  expect(publicShareCauseCodes(privateDatabaseError())).toEqual(['SERVER_ERROR', 'UND_ERR_CONNECT_TIMEOUT']);
  expect(publicShareCauseCodes({ code: 'SQLITE_ERROR secret-token', message: 'ETIMEDOUT' })).toEqual(['UNKNOWN']);
  const cycle: { code: string; cause?: unknown } = { code: 'ECONNRESET' };
  cycle.cause = cycle;
  expect(publicShareCauseCodes(cycle)).toEqual(['ECONNRESET']);
  let nested: unknown = { code: 'ETIMEDOUT' };
  for (let index = 0; index < 9; index++) nested = { cause: nested };
  expect(publicShareCauseCodes(nested)).toEqual(['UNKNOWN']);
});

it.each(['snapshot', 'detail'])('emits one correlated event with raw canvas bytes through %s', async (operation) => {
  const f = await setupObservabilityTest();
  await f.addNote('public', 'private-title', [], { content: 'é🙂' });
  await f.addNote('note_outside', 'Outside', [], { folderId: 'other', content: 'private-body' });
  const canvasContent = JSON.stringify({
    nodes: [{ id: 'node', type: 'text', text: 'Link', minunotes: { link: { type: 'note', id: 'note_outside' } } }],
    edges: [],
  });
  await f.addNote('canvas', 'Canvas', [], { documentType: 'canvas.default', content: canvasContent });
  const response = await f.read(
    operation === 'snapshot' ? undefined : '/internal/share/folders/secret-token/notes/canvas'
  );
  expect(response.status).toBe(200);
  const event = f.event();
  expect(event).toMatchObject({
    operation: operation === 'snapshot' ? 'public_share.folder_snapshot' : 'public_share.folder_note',
    request_id: response.headers.get('X-Request-Id'),
    status: 200,
    outcome: 'success',
    folder_query_calls: 1,
    note_fetch_batches: 1,
    note_count: operation === 'snapshot' ? 2 : 1,
    note_content_bytes: (operation === 'snapshot' ? 6 : 0) + Buffer.byteLength(canvasContent),
  });
  expect(event.request_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(event.duration_ms).toBeGreaterThanOrEqual(event.note_fetch_duration_ms);
  expect(event.note_fetch_duration_ms).toBeGreaterThanOrEqual(0);
  expect(event).not.toHaveProperty('cause_codes');
  const body = await response.json();
  const canvas = operation === 'snapshot' ? body.notes.find((note: { id: string }) => note.id === 'canvas') : body.note;
  expect(Buffer.byteLength(canvas.content)).toBeLessThan(Buffer.byteLength(canvasContent));
  f.expectPrivate();
});

it('does not fetch note content for denied snapshots', async () => {
  const f = await setupObservabilityTest();
  const execute = vi.spyOn(f.libsql, 'execute');
  const response = await f.read('/internal/share/folders/unknown');
  expect(response.status).toBe(404);
  expect(f.event()).toMatchObject({
    status: 404,
    outcome: 'denied',
    folder_query_calls: 0,
    note_fetch_batches: 0,
    note_count: 0,
    note_content_bytes: 0,
  });
  expect(execute).toHaveBeenCalledTimes(1);
  f.expectPrivate();
});

it.each(['lookup', 'folders', 'notes'])('sanitizes nested %s failures without double logging', async (stage) => {
  const f = await setupObservabilityTest();
  const execute = f.libsql.execute.bind(f.libsql);
  vi.spyOn(f.libsql, 'execute').mockImplementation(async (statement: InStatement) => {
    const sql = typeof statement === 'string' ? statement : statement.sql;
    if (
      (stage === 'lookup' && sql.includes('from "folder_share_links"')) ||
      (stage === 'folders' && sql.startsWith('select "id", "parent_folder_id"')) ||
      (stage === 'notes' && sql.includes('from "notes"'))
    )
      throw privateDatabaseError();
    return execute(statement);
  });
  const response = await f.read();
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: 'Internal Server Error' });
  const event = f.event();
  expect(event).toMatchObject({
    request_id: response.headers.get('X-Request-Id'),
    status: 500,
    outcome: 'error',
    folder_query_calls: stage === 'lookup' ? 0 : 1,
    note_fetch_batches: stage === 'notes' ? 1 : 0,
    note_count: 0,
    note_content_bytes: 0,
    cause_codes: ['SERVER_ERROR', 'UND_ERR_CONNECT_TIMEOUT'],
  });
  f.expectPrivate();
});

it.each([
  ['/navigation', 'public_share.folder_navigation', 0],
  ['/notes/private-note-id', 'public_share.folder_note', 6],
] as const)('measures compact reads %s with one correlated event', async (suffix, operation, bytes) => {
  const f = await setupObservabilityTest();
  await f.addNote('private-note-id', 'private-title', [], { content: 'é🙂' });
  const response = await f.read(`/internal/share/folders/secret-token${suffix}`);
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(f.event()).toMatchObject({
    operation,
    request_id: response.headers.get('X-Request-Id'),
    folder_query_calls: 1,
    note_fetch_batches: 1,
    note_count: 1,
    note_content_bytes: bytes,
  });
  f.expectPrivate();
});

it.each(
  ['/navigation', '/notes/private-note-id'].flatMap((suffix) =>
    ['lookup', 'folders', 'notes'].map((stage) => ({ suffix, stage }))
  )
)('sanitizes compact read errors $suffix at $stage', async ({ suffix, stage }) => {
  const f = await setupObservabilityTest();
  const execute = f.libsql.execute.bind(f.libsql);
  vi.spyOn(f.libsql, 'execute').mockImplementation(async (statement: InStatement) => {
    const sql = typeof statement === 'string' ? statement : statement.sql;
    if (
      (stage === 'lookup' && sql.includes('from "folder_share_links"')) ||
      (stage === 'folders' && sql.startsWith('select "id", "parent_folder_id"')) ||
      (stage === 'notes' && sql.includes('from "notes"'))
    )
      throw privateDatabaseError();
    return execute(statement);
  });
  const response = await f.read(`/internal/share/folders/secret-token${suffix}`);
  expect(response.status).toBe(500);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toEqual({ error: 'Internal Server Error' });
  expect(f.event()).toMatchObject({
    status: 500,
    note_content_bytes: 0,
    folder_query_calls: stage === 'lookup' ? 0 : 1,
    note_fetch_batches: stage === 'notes' ? 1 : 0,
    cause_codes: ['SERVER_ERROR', 'UND_ERR_CONNECT_TIMEOUT'],
  });
  f.expectPrivate();
});

it.each(['/navigation', '/notes/private-note-id'])('denies compact reads %s without content', async (suffix) => {
  const f = await setupObservabilityTest();
  const response = await f.read(`/internal/share/folders/unknown${suffix}`);
  expect(response.status).toBe(404);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(f.event()).toMatchObject({ status: 404, note_count: 0, note_content_bytes: 0, note_fetch_batches: 0 });
});

it('sanitizes non-snapshot public-share failures in the global API logger', async () => {
  const f = await setupObservabilityTest();
  vi.spyOn(f.libsql, 'execute').mockRejectedValue(privateDatabaseError());
  const response = await f.read('/internal/share/secret-token?query=secret-query');
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: 'Internal Server Error' });
  expect(f.info).not.toHaveBeenCalled();
  expect(f.errorLog).toHaveBeenCalledTimes(1);
  expect(f.errorLog.mock.calls[0]).toEqual([
    '[PUBLIC SHARE]',
    {
      operation: 'public_share',
      request_id: response.headers.get('X-Request-Id'),
      status: 500,
      outcome: 'error',
      cause_codes: ['SERVER_ERROR', 'UND_ERR_CONNECT_TIMEOUT'],
    },
  ]);
  f.expectPrivate();
});

it.each([
  '',
  '/navigation',
  '/notes/private-note-id',
])('measures rate-limited reads %s once without a database read', async (suffix) => {
  const f = await setupObservabilityTest();
  for (let index = 0; index < 300; index++) expect((await f.read('/internal/share/folders/unknown')).status).toBe(404);
  f.info.mockClear();
  const execute = vi.spyOn(f.libsql, 'execute');
  const response = await f.read(`/internal/share/folders/secret-token${suffix}`);
  expect(response.status).toBe(429);
  if (suffix) expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(f.event()).toMatchObject({ status: 429, outcome: 'denied', folder_query_calls: 0, note_fetch_batches: 0 });
  expect(execute).not.toHaveBeenCalled();
});
