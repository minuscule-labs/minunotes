import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTemplateTests, setupTemplateTest } from './template-fixtures';

afterEach(cleanupTemplateTests);
describe('session template adapters', () => {
  it('scoped shared editor preview/create has no private storage IDs or general template access', async () => {
    const f = await setupTemplateTest();
    const headers = { 'x-user': 'editor', 'content-type': 'application/json' };
    const list = await f.app.request('/internal/folders/board/templates', { headers });
    expect(await list.json()).toEqual({ templates: [{ id: 'template', title: 'Feature' }] });
    const p = await (await f.app.request('/internal/folders/board/templates/template/preview', { headers })).json();
    expect(JSON.stringify(p)).not.toMatch(/other|userId|folderId|actorId|assignment/);
    const body = {
      templateId: 'template',
      snapshot: p.snapshot,
      schemaId: p.schema.schemaId,
      schemaRevision: p.schema.revision,
      title: 'Final',
      tags: [],
      values: {},
      requestId: 'request',
      variables: { date: 'd', time: 't', datetime: 'dt' },
    };
    const create = () =>
      f.app.request('/internal/folders/board/notes/from-template', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    const first = await create();
    expect(first.status).toBe(201);
    const second = await create();
    expect(second.status).toBe(200);
    expect((await first.json()).note.id).toBe((await second.json()).note.id);
    expect((await f.app.request('/internal/notes/template', { headers })).status).toBe(404);
    for (const user of ['viewer', 'commenter', 'stranger']) {
      expect(
        (await f.app.request('/internal/folders/board/templates/template/preview', { headers: { 'x-user': user } }))
          .status
      ).toBe(user === 'stranger' ? 404 : 403);
      expect(
        (await f.app.request('/internal/notes/templates/template/defaults', { headers: { 'x-user': user } })).status
      ).toBe(404);
    }
  });
  it.each([
    true,
    false,
  ])('limits create/default requests with content-length=%s before side effects', async (contentLength) => {
    const f = await setupTemplateTest();
    for (const [path, method] of [
      ['/internal/folders/board/notes/from-template', 'POST'],
      ['/internal/notes/templates/template/defaults', 'PUT'],
    ] as const) {
      const body = `{}${' '.repeat(256 * 1024)}`,
        headers: Record<string, string> = { 'content-type': 'application/json' };
      if (contentLength) headers['content-length'] = String(Buffer.byteLength(body));
      expect((await f.app.request(path, { method, headers, body })).status).toBe(413);
    }
    expect((await f.libsql.execute('select * from note_creation_requests')).rows).toEqual([]);
    expect((await f.libsql.execute('select * from template_default_state')).rows).toEqual([]);
  });
});
