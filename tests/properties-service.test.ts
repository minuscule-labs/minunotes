import { spawn } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupPropertiesTests, setupPropertiesTest } from './properties-fixtures';

afterEach(cleanupPropertiesTests);
function child(code: string): Promise<{ status: number; output: string }> {
  return new Promise((resolve, reject) => {
    const processChild = spawn(
      'pnpm',
      ['exec', 'tsx', '--eval', `(async()=>{${code}})().catch(e=>{console.error(e);process.exitCode=1})`],
      {
        env: {
          ...process.env,
          TURSO_AUTH_TOKEN: '',
          LIBSQL_AUTH_TOKEN: '',
          LIBSQL_URL: '',
          ENVIRONMENT: 'local',
          SES_FROM_EMAIL: '',
          EMAIL_VERIFICATION_API_KEY: '',
        },
      }
    );
    let output = '';
    processChild.stdout.on('data', (data) => {
      output += String(data);
    });
    processChild.stderr.on('data', (data) => {
      output += String(data);
    });
    processChild.on('error', reject);
    processChild.on('close', (status) => resolve({ status: status ?? 1, output }));
  });
}
describe('transactional properties', () => {
  it('CAS is enforced across independent processes/connections, not just the local queue', async () => {
    const f = await setupPropertiesTest();
    await f.addNote('n', 'N');
    const s = await f.addField('Text', 'text');
    const input = {
      schemaId: s.schemaId,
      schemaRevision: 1,
      expectedRevision: 0,
      values: { [s.definitions[0].id]: 'value' },
    };
    const code = `const {patchNoteProperties}=await import('./src/api/notes/properties');try{await patchNoteProperties({actorUserId:'owner'},'n',${JSON.stringify(input)});console.log('SAVED')}catch(e){console.log('CONFLICT',e.status);if(e.status!==409)throw e}`;
    const result = await Promise.all([child(code), child(code)]);
    expect(
      result.every((r) => r.status === 0),
      JSON.stringify(result)
    ).toBe(true);
    expect(result.filter((r) => r.output.includes('SAVED'))).toHaveLength(1);
    expect(result.filter((r) => r.output.includes('CONFLICT 409'))).toHaveLength(1);
    expect((await f.properties.readNoteProperties(f.actor, 'n')).revision).toBe(1);
    expect((await f.libsql.execute('select * from note_events')).rows).toHaveLength(1);
  }, 30000);
  it('automatic cleanup versus metadata save is mutually safe on separate connections', async () => {
    const f = await setupPropertiesTest();
    await f.addNote('n', 'Untitled note', [], {
      content: '',
      createdByUserId: 'owner',
      updatedByActorType: 'user',
      updatedByActorId: 'owner',
    });
    const s = await f.addField('Text', 'text');
    const input = {
      schemaId: s.schemaId,
      schemaRevision: 1,
      expectedRevision: 0,
      values: { [s.definitions[0].id]: 'work' },
    };
    const result = await Promise.all([
      child(
        `const {patchNoteProperties}=await import('./src/api/notes/properties');try{await patchNoteProperties({actorUserId:'owner'},'n',${JSON.stringify(input)});console.log('SAVED')}catch(e){if(![404,409].includes(e.status))throw e;console.log('DENIED')}`
      ),
      child(
        `const {trashNote}=await import('./src/api/trash/operations');console.log(JSON.stringify(await trashNote({userId:'owner',noteId:'n',emptyDraft:{creatorUserId:'owner',createdAt:new Date('${f.now.toISOString()}'),updatedAt:new Date('${f.now.toISOString()}')}})))`
      ),
    ]);
    expect(
      result.every((r) => r.status === 0),
      JSON.stringify(result)
    ).toBe(true);
    const [note] = await f.db.select().from(f.schema.notes).where(eq(f.schema.notes.id, 'n'));
    const state = (await f.libsql.execute('select * from note_property_state')).rows;
    expect(Boolean(note.deletedAt) && state.length > 0).toBe(false);
    if (state.length) expect(note.deletedAt).toBeNull();
    else expect(note.deletedAt).not.toBeNull();
  }, 30000);
  it('normal body edits and body-only version/Trash restore leave metadata untouched', async () => {
    const f = await setupPropertiesTest();
    const s = await f.addField('Summary', 'text'),
      field = s.definitions[0];
    const create = await f.app.request('/internal/folders/board/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Initial', content: 'Initial body' }),
    });
    expect(create.status).toBe(201);
    const initial = await create.json(),
      noteId = initial.note.id;
    await f.patch(noteId, { [field.id]: 'Independent property' });
    const before = await f.properties.readNoteProperties(f.actor, noteId);
    const versions = await (await f.app.request(`/internal/notes/${noteId}/versions`)).json();
    const edit = await f.app.request(`/internal/notes/${noteId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Edited body', baseHash: initial.contentHash }),
    });
    expect(edit.status).toBe(200);
    expect(await f.properties.readNoteProperties(f.actor, noteId)).toEqual(before);
    const restore = await f.app.request(`/internal/notes/${noteId}/versions/${versions.versions[0].id}/restore`, {
      method: 'POST',
    });
    expect(restore.status).toBe(200);
    expect((await restore.json()).note.content).toBe('Initial body');
    expect(await f.properties.readNoteProperties(f.actor, noteId)).toEqual(before);
    const { trashNote, restoreTrashedNote } = await import('../src/api/trash/operations');
    expect(await trashNote({ userId: 'owner', noteId })).toMatchObject({ ok: true });
    await expect(f.properties.readNoteProperties(f.actor, noteId)).rejects.toMatchObject({ status: 404 });
    expect(await restoreTrashedNote({ userId: 'owner', noteId })).toMatchObject({ ok: true });
    expect(await f.properties.readNoteProperties(f.actor, noteId)).toEqual(before);
    const events = (await f.libsql.execute('select event_type from note_events')).rows.map((r) => r.event_type);
    expect(events).toContain('properties_update');
    expect(events.filter((e) => e === 'properties_update')).toHaveLength(1);
  });
  it('preserves content, tags, versions; CAS, no-op, clear and events are independent', async () => {
    const f = await setupPropertiesTest();
    await f.addNote('n', 'Note', ['work']);
    const before = (await f.libsql.execute("select * from notes where id='n'")).rows;
    const s = await f.addField(),
      d = s.definitions[0];
    const saved = await f.patch('n', { [d.id]: d.options[0].id });
    expect(saved.revision).toBe(1);
    await f.patch('n', { [d.id]: d.options[0].id });
    expect((await f.libsql.execute('select * from note_events')).rows).toHaveLength(1);
    await expect(f.patch('n', { [d.id]: d.options[1].id }, { expectedRevision: 0 })).rejects.toMatchObject({
      status: 409,
    });
    expect((await f.libsql.execute('select * from note_versions')).rows).toHaveLength(0);
    expect((await f.libsql.execute('select * from note_tags')).rows).toHaveLength(1);
    const after = (await f.libsql.execute("select * from notes where id='n'")).rows[0];
    expect(after.content).toBe(before[0].content);
    expect(after.title).toBe(before[0].title);
    const events = (await f.libsql.execute('select * from note_events')).rows;
    expect(events[0].event_type).toBe('properties_update');
    expect(events[0].before_hash).toBe(events[0].after_hash);
    expect((await f.patch('n', { [d.id]: null })).revision).toBe(2);
  });
  it('retains values invisibly across folder moves and rejects same-revision foreign schemas', async () => {
    const f = await setupPropertiesTest();
    await f.addNote('n', 'Note');
    const a = await f.addField(),
      d = a.definitions[0];
    await f.patch('n', { [d.id]: d.options[0].id });
    const b = await f.addField('Status', 'select', ['Todo', 'Done'], 'other');
    await f.db.update(f.schema.notes).set({ folderId: 'other' }).where(eq(f.schema.notes.id, 'n'));
    const moved = await f.properties.readNoteProperties(f.actor, 'n');
    expect(moved.values).toEqual({});
    expect(moved.schema.schemaId).toBe(b.schemaId);
    await expect(f.patch('n', { [d.id]: d.options[0].id }, { schemaId: a.schemaId })).rejects.toMatchObject({
      status: 409,
    });
    const bd = b.definitions[0];
    await f.patch('n', { [bd.id]: bd.options[1].id });
    await f.db.update(f.schema.notes).set({ folderId: 'board' }).where(eq(f.schema.notes.id, 'n'));
    expect((await f.properties.readNoteProperties(f.actor, 'n')).values).toEqual({ [d.id]: d.options[0].id });
  });
  it('archives without destruction and rejects normal properties on templates', async () => {
    const f = await setupPropertiesTest();
    await f.addNote('n', 'N');
    await f.addNote('t', 'T', [], { type: 'template' });
    const s = await f.addField(),
      d = s.definitions[0];
    await f.patch('n', { [d.id]: d.options[0].id });
    await f.properties.mutateFolderProperties(f.actor, 'board', {
      expectedRevision: 1,
      mutation: { type: 'archive', propertyId: d.id },
    });
    expect((await f.properties.readNoteProperties(f.actor, 'n')).values).toEqual({});
    expect((await f.libsql.execute('select "values" from note_property_state')).rows[0].values).toContain(d.id);
    await expect(f.properties.readNoteProperties(f.actor, 't')).rejects.toMatchObject({ status: 400 });
  });
  it('protects cleared property-only drafts even at identical timestamps; explicit Trash works', async () => {
    const f = await setupPropertiesTest();
    await f.addNote('n', 'Untitled note', [], {
      content: '',
      createdByUserId: 'owner',
      updatedByActorType: 'user',
      updatedByActorId: 'owner',
    });
    const s = await f.addField('Text', 'text'),
      d = s.definitions[0];
    await f.patch('n', { [d.id]: 'saved' });
    await f.patch('n', { [d.id]: null });
    await f.db.update(f.schema.notes).set({ updatedAt: f.now }).where(eq(f.schema.notes.id, 'n'));
    // Remove events and restore identical timestamps: only the atomic property-state predicate protects this draft.
    await f.db.delete(f.schema.noteEvents).where(eq(f.schema.noteEvents.noteId, 'n'));
    const { trashNote } = await import('../src/api/trash/operations');
    const auto = await trashNote({
      userId: 'owner',
      noteId: 'n',
      emptyDraft: { creatorUserId: 'owner', createdAt: f.now, updatedAt: f.now },
    });
    expect(auto).toMatchObject({ ok: false, status: 409 });
    expect(await trashNote({ userId: 'owner', noteId: 'n' })).toMatchObject({ ok: true });
    expect((await f.libsql.execute('select * from note_property_state')).rows).toHaveLength(1);
  });
  it('serializes simultaneous CAS writers and rolls back failed event insertion', async () => {
    const f = await setupPropertiesTest();
    await f.addNote('n', 'N');
    const s = await f.addField('Text', 'text'),
      d = s.definitions[0];
    const request = {
      schemaId: s.schemaId,
      schemaRevision: s.revision,
      expectedRevision: 0,
      values: { [d.id]: 'first' },
    };
    const results = await Promise.allSettled([
      f.properties.patchNoteProperties(f.actor, 'n', request),
      f.properties.patchNoteProperties(f.actor, 'n', { ...request, values: { [d.id]: 'second' } }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await f.libsql.execute('select * from note_events')).rows).toHaveLength(1);
    await f.libsql.execute(
      "create trigger fail_properties before insert on note_events when new.event_type='properties_update' begin select raise(abort, 'test failure'); end"
    );
    await expect(f.patch('n', { [d.id]: 'third' })).rejects.toThrow('Failed query');
    expect((await f.properties.readNoteProperties(f.actor, 'n')).revision).toBe(1);
    expect((await f.libsql.execute('select * from note_events')).rows).toHaveLength(1);
  });
});
