import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupPropertiesTests, setupPropertiesTest } from './properties-fixtures';

afterEach(cleanupPropertiesTests);
describe('internal property ACLs', () => {
  it('option deletion preview and confirmation are owner-only, tenant-scoped, bounded and reviewed', async () => {
    const f = await setupPropertiesTest();
    const schema = await f.addField();
    const field = schema.definitions[0];
    await f.addNote('n', 'N');
    await f.patch('n', { [field.id]: field.options[0].id });
    const path = `/internal/folders/board/properties/${field.id}/options/${field.options[0].id}`;
    const before = (await f.libsql.execute('select * from folder_property_schemas')).rows;
    const previewResponse = await f.app.request(`${path}/deletion-preview`);
    expect(previewResponse.status).toBe(200);
    expect(previewResponse.headers.get('cache-control')).toBe('no-store');
    const preview = await previewResponse.json();
    expect(preview).toMatchObject({ noteCount: 1, templateDefaultCount: 0 });
    const input = {
      schemaId: preview.schemaId,
      expectedRevision: preview.expectedRevision,
      impactToken: preview.impactToken,
    };
    const remove = (body: unknown, actor = 'owner', url = path) =>
      f.app.request(url, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', 'x-user': actor },
        body: JSON.stringify(body),
      });
    for (const [actor, status] of [
      ['anonymous', 401],
      ['viewer', 403],
      ['commenter', 403],
      ['editor', 403],
      ['stranger', 404],
      ['other-user', 404],
    ] as const) {
      expect((await f.app.request(`${path}/deletion-preview`, { headers: { 'x-user': actor } })).status).toBe(status);
      expect((await remove(input, actor)).status).toBe(status);
    }
    expect((await remove(input, 'owner', path.replace('/board/', '/foreign/'))).status).toBe(404);
    expect((await f.app.request(`${path.replace(field.id, 'unknown')}/deletion-preview`)).status).toBe(404);
    for (const body of [null, {}, { ...input, impactToken: 'guessed' }, { ...input, force: true }])
      expect((await remove(body)).status).toBe(400);
    expect((await remove({ ...input, expectedRevision: 0 })).status).toBe(409);
    for (const lengthHeader of ['actual', 'missing', 'understated']) {
      const body = JSON.stringify(input) + ' '.repeat(4096);
      expect(
        (
          await f.app.request(path, {
            method: 'DELETE',
            headers: {
              'content-type': 'application/json',
              ...(lengthHeader === 'missing'
                ? {}
                : { 'content-length': lengthHeader === 'understated' ? '1' : String(Buffer.byteLength(body)) }),
            },
            body,
          })
        ).status
      ).toBe(413);
    }
    expect((await f.libsql.execute('select * from folder_property_schemas')).rows).toEqual(before);
    expect((await f.properties.readNoteProperties(f.actor, 'n')).values).toEqual({ [field.id]: field.options[0].id });
    expect((await remove(input)).status).toBe(200);
    expect((await f.properties.readNoteProperties(f.actor, 'n')).values).toEqual({});
    expect((await remove(input)).status).toBe(404);
    expect((await f.app.request(`${path}/deletion-preview`)).status).toBe(404);
    const last = path.replace(field.options[0].id, field.options[1].id);
    expect((await f.app.request(`${last}/deletion-preview`)).status).toBe(400);
    expect((await remove(input, 'owner', last)).status).toBe(400);
  });
  it.each([
    true,
    false,
  ])('limits properties bodies before parsing (content-length: %s), without metadata writes', async (contentLength) => {
    const f = await setupPropertiesTest();
    await f.addNote('n', 'N');
    const schema = await f.addField('Summary', 'text');
    const definitionsBefore = (await f.libsql.execute('select * from folder_property_schemas')).rows;
    const notePatch = {
      schemaId: schema.schemaId,
      schemaRevision: 1,
      expectedRevision: 0,
      values: { [schema.definitions[0].id]: 'Bounded value' },
    };
    const schemaPatch = {
      expectedRevision: 1,
      mutation: { type: 'rename', propertyId: schema.definitions[0].id, label: 'Renamed' },
    };
    for (const [path, payload] of [
      ['/internal/notes/n/properties', notePatch],
      ['/internal/folders/board/properties', schemaPatch],
    ] as const) {
      const body = JSON.stringify(payload) + ' '.repeat(256 * 1024);
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (contentLength) headers['content-length'] = String(Buffer.byteLength(body));
      const response = await f.app.request(path, { method: 'PATCH', headers, body });
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: 'Request body too large' });
      expect((await f.app.request(path)).status).toBe(200);
    }
    expect((await f.libsql.execute('select * from folder_property_schemas')).rows).toEqual(definitionsBefore);
    expect((await f.libsql.execute('select * from note_property_state')).rows).toEqual([]);
    expect((await f.libsql.execute('select * from note_events')).rows).toEqual([]);
    for (const [path, payload] of [
      ['/internal/notes/n/properties', notePatch],
      ['/internal/folders/board/properties', schemaPatch],
    ] as const)
      expect(
        (
          await f.app.request(path, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
        ).status
      ).toBe(200);
  });
  it('existing note and folder public shares omit property schemas and values', async () => {
    const f = await setupPropertiesTest();
    await f.addNote('n', 'Public note');
    const s = await f.addField('Private property', 'text');
    await f.patch('n', { [s.definitions[0].id]: 'Private metadata value' });
    const { shareRoutes } = await import('../src/api/routes/share');
    f.app.route('/public', shareRoutes);
    for (const [path, resource] of [
      ['/internal/notes/n/share-link', 'note'],
      ['/internal/folders/board/share-link', 'folder'],
    ]) {
      const res = await f.app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(201);
      const body = await res.json(),
        token = new URL(body.shareLink.url).pathname.split('/').at(-1);
      const url = resource === 'note' ? `/public/${token}` : `/public/folders/${token}`;
      const response = await f.app.request(url);
      expect(response.status).toBe(200);
      const dto = await response.json();
      expect(JSON.stringify(dto)).not.toContain('Private metadata value');
      expect(JSON.stringify(dto)).not.toContain('Private property');
      expect(JSON.stringify(dto)).not.toContain(s.schemaId);
      expect(dto).not.toHaveProperty('properties');
      expect(dto.note ?? dto.notes[0]).not.toHaveProperty('properties');
    }
  });
  it('same-named fields/options across owners are never interchangeable and invalid multi-field patches are atomic', async () => {
    const f = await setupPropertiesTest();
    await f.addNote('n', 'N');
    const s = await f.addField();
    const foreign = await f.properties.mutateFolderProperties({ actorUserId: 'other-user' }, 'foreign', {
      expectedRevision: 0,
      mutation: { type: 'add', label: 'Status', fieldType: 'select', options: ['Todo', 'Done'] },
    });
    const own = s.definitions[0],
      other = foreign.definitions[0];
    expect(own.id).not.toBe(other.id);
    expect(own.options[0].id).not.toBe(other.options[0].id);
    await expect(f.patch('n', { [own.id]: other.options[0].id })).rejects.toMatchObject({ status: 400 });
    await expect(f.patch('n', { [other.id]: other.options[0].id })).rejects.toMatchObject({ status: 400 });
    const date = await f.addField('Due', 'date', [], 'board', 1),
      dateField = date.definitions[1];
    await expect(f.patch('n', { [own.id]: own.options[0].id, [dateField.id]: '2026-02-29' })).rejects.toMatchObject({
      status: 400,
    });
    expect((await f.properties.readNoteProperties(f.actor, 'n')).values).toEqual({});
    expect((await f.libsql.execute('select * from note_events')).rows).toEqual([]);
    await f.properties.mutateFolderProperties(f.actor, 'board', {
      expectedRevision: 2,
      mutation: { type: 'archive_option', propertyId: own.id, optionId: own.options[0].id },
    });
    expect((await f.properties.readNoteProperties(f.actor, 'n')).schema.definitions[0].options).not.toContainEqual(
      expect.objectContaining({ id: own.options[0].id })
    );
  });
  it('allows viewers to read, editors to patch, and only owners to define', async () => {
    const f = await setupPropertiesTest();
    await f.addNote('n', 'N');
    const s = await f.addField(),
      d = s.definitions[0];
    for (const actor of ['owner', 'editor', 'viewer', 'commenter'])
      expect((await f.app.request('/internal/notes/n/properties', { headers: { 'x-user': actor } })).status).toBe(200);
    const body = { schemaId: s.schemaId, schemaRevision: 1, expectedRevision: 0, values: { [d.id]: d.options[0].id } };
    for (const actor of ['viewer', 'commenter', 'stranger'])
      expect(
        (
          await f.app.request('/internal/notes/n/properties', {
            method: 'PATCH',
            headers: { 'x-user': actor, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        ).status
      ).toBe(actor === 'stranger' ? 404 : 403);
    expect(
      (
        await f.app.request('/internal/notes/n/properties', {
          method: 'PATCH',
          headers: { 'x-user': 'editor', 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).status
    ).toBe(200);
    for (const actor of ['editor', 'viewer', 'commenter'])
      expect(
        (
          await f.app.request('/internal/folders/board/properties', {
            method: 'PATCH',
            headers: { 'x-user': actor, 'content-type': 'application/json' },
            body: JSON.stringify({ expectedRevision: 1, mutation: { type: 'rename', propertyId: d.id, label: 'New' } }),
          })
        ).status
      ).toBe(403);
  });
  it('projects only current applicable schema through note-only grants, without owner/folder identities', async () => {
    const f = await setupPropertiesTest();
    await f.addNote('n', 'N');
    const s = await f.addField();
    await f.db.insert(f.schema.collaborationGrants).values({
      id: 'direct',
      ownerUserId: 'owner',
      granteeUserId: 'stranger',
      noteId: 'n',
      role: 'editor',
      createdByUserId: 'owner',
      createdAt: f.now,
      updatedAt: f.now,
    });
    const res = await f.app.request('/internal/notes/n/properties', { headers: { 'x-user': 'stranger' } });
    expect(res.status).toBe(200);
    const dto = await res.json();
    expect(dto.schema.schemaId).toBe(s.schemaId);
    expect(JSON.stringify(dto)).not.toMatch(/owner|folderId|userId|board/);
    expect(
      (await f.app.request('/internal/folders/board/properties', { headers: { 'x-user': 'stranger' } })).status
    ).toBe(404);
    await f.db.delete(f.schema.collaborationGrants).where(eq(f.schema.collaborationGrants.id, 'direct'));
    expect((await f.app.request('/internal/notes/n/properties', { headers: { 'x-user': 'stranger' } })).status).toBe(
      404
    );
  });
  it('rejects tenant, inactive resources and invalid revisions/bodies without writes', async () => {
    const f = await setupPropertiesTest();
    await f.addNote('n', 'N');
    const s = await f.addField();
    for (const body of [
      null,
      {},
      { schemaId: s.schemaId, schemaRevision: 1, expectedRevision: -1, values: {} },
      { schemaId: s.schemaId, schemaRevision: 1, expectedRevision: 0, values: { foreign: 'value' } },
    ])
      expect(
        (
          await f.app.request('/internal/notes/n/properties', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        ).status
      ).toBe(400);
    expect((await f.app.request('/internal/folders/foreign/properties')).status).toBe(404);
    await f.db.update(f.schema.folders).set({ deletedAt: new Date() }).where(eq(f.schema.folders.id, 'root'));
    expect((await f.app.request('/internal/notes/n/properties')).status).toBe(404);
    expect((await f.libsql.execute('select * from note_property_state')).rows).toEqual([]);
  });
});
