import { spawn } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTemplateTests, setupTemplateTest } from './template-fixtures';

afterEach(cleanupTemplateTests);
async function reviewed(f: Awaited<ReturnType<typeof setupTemplateTest>>, extra: Record<string, unknown> = {}) {
  const p = await f.templates.previewAssignedTemplate(f.actor, 'board', 'template');
  return {
    folderId: 'board',
    templateId: 'template',
    snapshot: p.snapshot,
    schemaId: p.schema.schemaId,
    schemaRevision: p.schema.revision,
    title: 'Final',
    tags: ['feature'],
    values: {},
    requestId: 'request',
    variables: { date: 'DATE', time: 'TIME', datetime: 'DATETIME' },
    ...extra,
  };
}
function child(code: string): Promise<{ status: number; output: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(
      'pnpm',
      ['exec', 'tsx', '--eval', `(async()=>{${code}})().catch(e=>{console.error(e);process.exitCode=1})`],
      {
        env: {
          ...process.env,
          ENVIRONMENT: 'test',
          TURSO_AUTH_TOKEN: '',
          LIBSQL_AUTH_TOKEN: '',
          SES_FROM_EMAIL: '',
          EMAIL_VERIFICATION_API_KEY: '',
        },
      }
    );
    let output = '';
    p.stdout.on('data', (d) => {
      output += String(d);
    });
    p.stderr.on('data', (d) => {
      output += String(d);
    });
    p.on('error', reject);
    p.on('close', (status) => resolve({ status: status ?? 1, output }));
  });
}
describe('atomic reviewed creation', () => {
  it('creates ordinary owned note with exact frozen body/tags/properties/provenance and one initial event/version', async () => {
    const f = await setupTemplateTest(),
      schema = await f.addField('Text', 'text');
    await f.addNote('target', 'Target');
    const body = await reviewed(f, { values: { [schema.definitions[0].id]: 'Exact' } });
    const result = await f.templates.createFromTemplate({ actorUserId: 'editor' }, body);
    const [note] = await f.db.select().from(f.schema.notes).where(eq(f.schema.notes.id, result.note.id));
    expect(note).toMatchObject({
      userId: 'owner',
      createdByUserId: 'editor',
      updatedByActorType: 'user',
      updatedByActorId: 'editor',
      type: 'note',
      isApiEditable: true,
      content: 'Final DATE TIME DATETIME\n[[Target]]',
    });
    expect((await f.properties.readNoteProperties(f.actor, note.id)).values).toEqual(body.values);
    for (const table of ['note_events', 'note_versions', 'note_tags', 'note_creation_requests'])
      expect(
        (
          await f.libsql.execute(
            `select * from ${table} where ${table === 'note_creation_requests' ? 'note_id' : 'note_id'}='${note.id}'`
          )
        ).rows
      ).toHaveLength(1);
    expect(
      (await f.libsql.execute(`select event_type from note_events where note_id='${note.id}'`)).rows[0].event_type
    ).toBe('create');
  });
  it('clear is complete replacement; completed frozen retry ignores later defaults/schema changes but not changed payload', async () => {
    const f = await setupTemplateTest(),
      body = await reviewed(f, { tags: [] });
    const first = await f.templates.createFromTemplate(f.actor, body);
    await f.templates.saveTemplateTags(f.actor, 'template', { expectedRevision: 0, tags: ['changed'] });
    await f.addField('New', 'text');
    expect((await f.templates.createFromTemplate(f.actor, body)).note.id).toBe(first.note.id);
    await expect(f.templates.createFromTemplate(f.actor, { ...body, title: 'Different' })).rejects.toMatchObject({
      status: 409,
    });
    expect((await f.libsql.execute('select * from note_tags')).rows).toEqual([]);
    expect((await f.libsql.execute('select * from note_events')).rows).toHaveLength(1);
  });
  it('staleness, invalid values and revocation leave no instance', async () => {
    const f = await setupTemplateTest(),
      body = await reviewed(f);
    await f.templates.saveTemplateTags(f.actor, 'template', { expectedRevision: 0, tags: ['new'] });
    await expect(f.templates.createFromTemplate(f.actor, body)).rejects.toMatchObject({ status: 409 });
    const current = await reviewed(f);
    await expect(
      f.templates.createFromTemplate(f.actor, { ...current, values: { foreign: 'no' } })
    ).rejects.toMatchObject({ status: 400 });
    await f.db.delete(f.schema.collaborationGrants).where(eq(f.schema.collaborationGrants.id, 'grant_editor'));
    await expect(f.templates.createFromTemplate({ actorUserId: 'editor' }, current)).rejects.toMatchObject({
      status: 404,
    });
    expect((await f.libsql.execute('select * from note_creation_requests')).rows).toEqual([]);
    expect((await f.libsql.execute('select * from note_events')).rows).toEqual([]);
  });
  it.each([
    'notes',
    'note_links',
    'note_versions',
    'note_events',
    'tags',
    'note_tags',
    'note_property_state',
    'note_creation_requests',
  ])('injected failure at %s rolls back all writes including tags/links/version/event/receipt', async (table) => {
    const f = await setupTemplateTest(),
      schema = await f.addField('Text', 'text');
    const body = await reviewed(f, { values: { [schema.definitions[0].id]: 'value' } });
    const tables = [
      'notes',
      'tags',
      'note_tags',
      'note_links',
      'note_versions',
      'note_events',
      'note_property_state',
      'note_creation_requests',
    ];
    const before = await Promise.all(tables.map(async (t) => (await f.libsql.execute(`select * from ${t}`)).rows));
    await f.libsql.execute(
      `create trigger fail_create before insert on ${table} begin select raise(abort,'injected failure'); end`
    );
    await expect(f.templates.createFromTemplate(f.actor, body)).rejects.toThrow();
    const after = await Promise.all(tables.map(async (t) => (await f.libsql.execute(`select * from ${t}`)).rows));
    expect(after).toEqual(before);
  });
  it.each([
    'trashed',
    'deleted',
    'moved',
  ])('a %s note leaves an unavailable tombstone, never a recreated note', async (state) => {
    const f = await setupTemplateTest(),
      body = await reviewed(f),
      actor = { actorUserId: 'editor' },
      result = await f.templates.createFromTemplate(actor, body);
    if (state === 'deleted') await f.db.delete(f.schema.notes).where(eq(f.schema.notes.id, result.note.id));
    else
      await f.db
        .update(f.schema.notes)
        .set(state === 'moved' ? { folderId: 'other' } : { deletedAt: f.now })
        .where(eq(f.schema.notes.id, result.note.id));
    await expect(f.templates.createFromTemplate(actor, body)).rejects.toMatchObject({ status: 404 });
    expect((await f.libsql.execute('select * from note_creation_requests')).rows).toHaveLength(1);
  });
  it('a move within current folder scope returns the same note, never a new note', async () => {
    const f = await setupTemplateTest(),
      body = await reviewed(f),
      result = await f.templates.createFromTemplate(f.actor, body);
    await f.db.update(f.schema.notes).set({ folderId: 'child' }).where(eq(f.schema.notes.id, result.note.id));
    const retry = await f.templates.createFromTemplate(f.actor, body);
    expect(retry.note).toMatchObject({ id: result.note.id, folderId: 'child' });
    expect((await f.libsql.execute('select * from note_creation_requests')).rows).toHaveLength(1);
  });
  it.each([
    'defaults',
    'schema',
    'assignment',
    'revocation',
  ])('independent creation racing %s commits a complete reviewed instance or no instance', async (change) => {
    const f = await setupTemplateTest(),
      body = await reviewed(f);
    const create = `const {createFromTemplate}=await import('./src/api/notes/templates');try{await createFromTemplate({actorUserId:'editor'},${JSON.stringify(body)});console.log('CREATED')}catch(e){if(![404,409].includes(e.status))throw e;console.log('REJECTED')}`;
    const mutate =
      change === 'defaults'
        ? `const {saveTemplateTags}=await import('./src/api/notes/templates');await saveTemplateTags({actorUserId:'owner'},'template',{expectedRevision:0,tags:['changed']})`
        : change === 'schema'
          ? `const {mutateFolderProperties}=await import('./src/api/notes/properties');await mutateFolderProperties({actorUserId:'owner'},'board',{expectedRevision:0,mutation:{type:'add',label:'New',fieldType:'text'}})`
          : change === 'assignment'
            ? `const {saveTemplateMembership}=await import('./src/api/notes/templates');await saveTemplateMembership({actorUserId:'owner'},'template',{folderIds:['child']})`
            : `const {libsql}=await import('./src/api/db/client');await libsql.execute("delete from collaboration_grants where id='grant_editor'")`;
    const results = await Promise.all([
      child(create),
      child(
        `try{${mutate};console.log('CHANGED')}catch(e){if(e.status!==409&&!/SQLITE_BUSY|SQLITE_LOCKED/.test(e.message))throw e;console.log('BUSY')}`
      ),
    ]);
    expect(
      results.every((r) => r.status === 0),
      JSON.stringify(results)
    ).toBe(true);
    const receipts = (await f.libsql.execute('select * from note_creation_requests')).rows;
    expect(receipts.length).toBeLessThanOrEqual(1);
    for (const table of ['note_events', 'note_versions', 'note_tags'])
      expect((await f.libsql.execute(`select * from ${table}`)).rows).toHaveLength(receipts.length);
    if (receipts.length)
      expect(
        (await f.libsql.execute(`select content from notes where id='${receipts[0].note_id}'`)).rows[0].content
      ).toContain('Final DATE TIME DATETIME');
  }, 30000);
  it('independent process clients race one receipt/note/event, with unchanged retry after busy', async () => {
    const f = await setupTemplateTest(),
      body = await reviewed(f);
    const code = `const {createFromTemplate}=await import('./src/api/notes/templates');try{const r=await createFromTemplate({actorUserId:'owner'},${JSON.stringify(body)});console.log('OK',r.note.id)}catch(e){if(e.status!==409)throw e;console.log('BUSY')}`;
    const results = await Promise.all([child(code), child(code)]);
    expect(
      results.every((r) => r.status === 0),
      JSON.stringify(results)
    ).toBe(true);
    const retry = await f.templates.createFromTemplate(f.actor, body);
    for (const r of results.filter((r) => r.output.includes('OK'))) expect(r.output).toContain(retry.note.id);
    for (const table of ['note_creation_requests', 'note_events', 'note_versions'])
      expect((await f.libsql.execute(`select * from ${table}`)).rows).toHaveLength(1);
  }, 30000);
  it('archive versus assignment-default save on independent clients never commits an invalid pair', async () => {
    const f = await setupTemplateTest(),
      schema = await f.addField(),
      field = schema.definitions[0];
    const a = (await f.templates.readTemplateDefaults(f.actor, 'template')).assignments.find(
      (a) => a.folderId === 'board'
    );
    if (!a) throw new Error('Missing board assignment');
    const input = {
      assignmentId: a.id,
      expectedRevision: 0,
      schemaId: schema.schemaId,
      schemaRevision: 1,
      values: { [field.id]: field.options[0].id },
    };
    const results = await Promise.all([
      child(
        `const {saveAssignmentDefaults}=await import('./src/api/notes/templates');try{await saveAssignmentDefaults({actorUserId:'owner'},'template','board',${JSON.stringify(input)});console.log('SAVED')}catch(e){if(![400,409].includes(e.status))throw e;console.log('CONFLICT')}`
      ),
      child(
        `const {mutateFolderProperties}=await import('./src/api/notes/properties');try{await mutateFolderProperties({actorUserId:'owner'},'board',{expectedRevision:1,mutation:{type:'archive',propertyId:'${field.id}'}});console.log('ARCHIVED')}catch(e){if(e.status!==409)throw e;console.log('CONFLICT')}`
      ),
    ]);
    expect(
      results.every((r) => r.status === 0),
      JSON.stringify(results)
    ).toBe(true);
    const current = await f.properties.readFolderProperties(f.actor, 'board');
    const defaults = (await f.templates.readTemplateDefaults(f.actor, 'template')).assignments.find(
      (a) => a.folderId === 'board'
    );
    if (!defaults) throw new Error('Missing board assignment');
    expect(current.definitions[0].archived && Object.keys(defaults.values).length > 0).toBe(false);
  }, 30000);
});
