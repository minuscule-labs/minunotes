import { spawn } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupPropertyBoardTests, setupPropertyBoardTest } from './property-board-fixtures';

afterEach(cleanupPropertyBoardTests);

function independent(code: string): Promise<{ status: number; output: string }> {
  return new Promise((resolve, reject) => {
    const processChild = spawn(
      'pnpm',
      ['exec', 'tsx', '--eval', `(async()=>{${code}})().catch(e=>{console.error(e);process.exitCode=1})`],
      {
        env: {
          ...process.env,
          ENVIRONMENT: 'test',
          TURSO_AUTH_TOKEN: '',
          LIBSQL_AUTH_TOKEN: '',
          LIBSQL_URL: '',
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

async function setupDeletion() {
  const f = await setupPropertyBoardTest();
  const type = await f.addType();
  const propertyId = f.field.id;
  const optionId = f.field.options[0].id;
  for (const id of ['active', 'canvas', 'moved', 'trash', 'different', 'foreign']) {
    await f.addNote(id, id, ['kept'], {
      ...(id === 'canvas' ? { documentType: 'canvas.default' } : {}),
      ...(id === 'moved' ? { folderId: 'other' } : {}),
      ...(id === 'trash' ? { deletedAt: f.now } : {}),
      ...(id === 'foreign' ? { folderId: 'foreign', userId: 'other-user' } : {}),
    });
    await f.db.insert(f.schema.notePropertyState).values({
      noteId: id,
      userId: id === 'foreign' ? 'other-user' : 'owner',
      revision: 1,
      values: JSON.stringify({
        [propertyId]: id === 'different' ? f.field.options[1].id : optionId,
        retained: 'unchanged',
      }),
      createdAt: f.now,
      updatedAt: f.now,
    });
  }
  for (const id of ['template', 'trashed-template']) {
    await f.addNote(id, id, [], {
      type: 'template',
      folderId: 'other',
      ...(id === 'trashed-template' ? { deletedAt: f.now } : {}),
    });
    await f.db.insert(f.schema.templateFolderAssignments).values({
      id: `assignment_${id}`,
      templateId: id,
      folderId: 'board',
      userId: 'owner',
      defaultsRevision: 2,
      schemaId: f.propertySchema.schemaId,
      propertyDefaults: JSON.stringify({ [propertyId]: optionId, [type.typeField.id]: type.typeField.options[0].id }),
    });
  }
  const preview = () => f.properties.previewOptionDeletion(f.actor, 'board', propertyId, optionId);
  const remove = (input: unknown) => f.properties.deletePropertyOption(f.actor, 'board', propertyId, optionId, input);
  const snapshot = async () => {
    const tables = [
      'folder_property_schemas',
      'note_property_state',
      'template_folder_assignments',
      'notes',
      'note_events',
      'note_tags',
    ];
    return Promise.all(tables.map(async (table) => (await f.libsql.execute(`select * from ${table} order by 1`)).rows));
  };
  return { ...f, type, propertyId, optionId, preview, remove, snapshot };
}

describe('reviewed Select option deletion', () => {
  it('previews without writes, then atomically clears all owner references/defaults without deleting notes or history', async () => {
    const f = await setupDeletion();
    const before = await f.snapshot();
    const preview = await f.preview();
    expect(preview).toMatchObject({
      propertyLabel: 'Workflow',
      optionLabel: 'Todo',
      noteCount: 4,
      templateDefaultCount: 2,
      expectedRevision: 2,
    });
    expect(preview.impactToken).toMatch(/^[a-f0-9]{64}$/);
    expect(preview).not.toHaveProperty('notes');
    expect(await f.preview()).toEqual(preview);
    expect(await f.snapshot()).toEqual(before);
    const current = await f.remove({
      schemaId: preview.schemaId,
      expectedRevision: preview.expectedRevision,
      impactToken: preview.impactToken,
    });
    expect(current.revision).toBe(3);
    expect(current.definitions[0].options).toEqual(f.field.options.slice(1));
    const states = await f.db.select().from(f.schema.notePropertyState);
    for (const row of states) {
      const values = JSON.parse(row.values);
      expect(values.retained).toBe('unchanged');
      if (row.noteId === 'foreign') {
        expect(values[f.propertyId]).toBe(f.optionId);
        expect(row.revision).toBe(1);
      } else if (row.noteId === 'different') {
        expect(values[f.propertyId]).toBe(f.field.options[1].id);
        expect(row.revision).toBe(1);
      } else {
        expect(values).not.toHaveProperty(f.propertyId);
        expect(row.revision).toBe(2);
      }
    }
    const defaults = await f.db.select().from(f.schema.templateFolderAssignments);
    for (const row of defaults) {
      expect(row.defaultsRevision).toBe(3);
      expect(JSON.parse(row.propertyDefaults)).toEqual({ [f.type.typeField.id]: f.type.typeField.options[0].id });
    }
    const events = await f.db.select().from(f.schema.noteEvents);
    expect(events).toHaveLength(4);
    for (const event of events) {
      expect(event).toMatchObject({
        userId: 'owner',
        actorType: 'user',
        actorId: 'owner',
        eventType: 'properties_update',
      });
      expect(event.beforeHash).toBe(event.afterHash);
    }
    const after = await f.snapshot();
    expect(after[3].map((note) => [note.id, note.content, note.folder_id, note.deleted_at])).toEqual(
      before[3].map((note) => [note.id, note.content, note.folder_id, note.deleted_at])
    );
    expect(after[5]).toEqual(before[5]);
    const note = await f.properties.readNoteProperties(f.actor, 'active');
    expect(note.values).toEqual({});
    await expect(
      f.properties.patchNoteProperties(f.actor, 'active', {
        schemaId: note.schema.schemaId,
        schemaRevision: note.schema.revision,
        expectedRevision: note.revision,
        values: { [f.propertyId]: f.optionId },
      })
    ).rejects.toThrow('Unknown or archived option');
    await expect(
      f.remove({
        schemaId: preview.schemaId,
        expectedRevision: preview.expectedRevision,
        impactToken: preview.impactToken,
      })
    ).rejects.toMatchObject({ status: 404 });
  });

  for (const change of ['schema', 'note-revision', 'same-count-replacement', 'default-revision'] as const)
    it(`requires explicit re-review after ${change} changes`, async () => {
      const f = await setupDeletion();
      const preview = await f.preview();
      if (change === 'schema')
        await f.properties.mutateFolderProperties(f.actor, 'board', {
          expectedRevision: 2,
          mutation: { type: 'rename_option', propertyId: f.propertyId, optionId: f.optionId, label: 'Next' },
        });
      if (change === 'note-revision')
        await f.db
          .update(f.schema.notePropertyState)
          .set({ revision: 2 })
          .where(eq(f.schema.notePropertyState.noteId, 'active'));
      if (change === 'default-revision')
        await f.db.update(f.schema.templateFolderAssignments).set({ defaultsRevision: 3 });
      if (change === 'same-count-replacement') {
        await f.db
          .update(f.schema.notePropertyState)
          .set({ revision: 2, values: '{}' })
          .where(eq(f.schema.notePropertyState.noteId, 'active'));
        await f.db
          .update(f.schema.notePropertyState)
          .set({ revision: 2, values: JSON.stringify({ [f.propertyId]: f.optionId }) })
          .where(eq(f.schema.notePropertyState.noteId, 'different'));
        expect((await f.preview()).noteCount).toBe(preview.noteCount);
      }
      const before = await f.snapshot();
      const request = {
        schemaId: preview.schemaId,
        expectedRevision: preview.expectedRevision,
        impactToken: preview.impactToken,
      };
      await expect(f.remove(request)).rejects.toMatchObject({ status: 409 });
      expect(await f.snapshot()).toEqual(before);
      const fresh = await f.preview();
      expect(fresh.impactToken).not.toBe(preview.impactToken);
      await f.remove({
        schemaId: fresh.schemaId,
        expectedRevision: fresh.expectedRevision,
        impactToken: fresh.impactToken,
      });
    });

  it('rolls back note/default/schema changes and activity if a late event insert fails', async () => {
    const f = await setupDeletion();
    const preview = await f.preview();
    const before = await f.snapshot();
    await f.libsql.execute(
      "create trigger fail_delete_event before insert on note_events when new.event_type='properties_update' begin select raise(abort, 'test failure'); end"
    );
    await expect(
      f.remove({
        schemaId: preview.schemaId,
        expectedRevision: preview.expectedRevision,
        impactToken: preview.impactToken,
      })
    ).rejects.toThrow();
    expect(await f.snapshot()).toEqual(before);
  });

  it('clears a complete set larger than one page and preserves unrelated default scopes and historical archived options', async () => {
    const f = await setupPropertyBoardTest();
    await f.properties.mutateFolderProperties(f.actor, 'board', {
      expectedRevision: 1,
      mutation: { type: 'archive_option', propertyId: f.field.id, optionId: f.field.options[3].id },
    });
    for (let i = 0; i < 125; i++) {
      const id = `many-${i}`;
      await f.addNote(id, id);
      await f.db.insert(f.schema.notePropertyState).values({
        noteId: id,
        userId: 'owner',
        revision: 1,
        values: JSON.stringify({ [f.field.id]: f.field.options[0].id }),
        createdAt: f.now,
        updatedAt: f.now,
      });
    }
    await f.addNote('template', 'template', [], { type: 'template' });
    await f.db.insert(f.schema.templateFolderAssignments).values({
      id: 'other-assignment',
      templateId: 'template',
      folderId: 'other',
      userId: 'owner',
      propertyDefaults: JSON.stringify({ [f.field.id]: f.field.options[0].id }),
    });
    const preview = await f.properties.previewOptionDeletion(f.actor, 'board', f.field.id, f.field.options[0].id);
    expect(preview).toMatchObject({ noteCount: 125, templateDefaultCount: 0 });
    const remove = () =>
      f.properties.deletePropertyOption(f.actor, 'board', f.field.id, f.field.options[0].id, {
        schemaId: preview.schemaId,
        expectedRevision: preview.expectedRevision,
        impactToken: preview.impactToken,
      });
    const tables = [
      'notes',
      'note_property_state',
      'folder_property_schemas',
      'note_events',
      'template_folder_assignments',
    ];
    const snapshot = () =>
      Promise.all(tables.map(async (table) => (await f.libsql.execute(`select * from ${table} order by 1`)).rows));
    const before = await snapshot();
    await f.libsql.execute(
      "create trigger fail_late_batch before insert on note_events when new.note_id='many-99' begin select raise(abort, 'late batch failure'); end"
    );
    await expect(remove()).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    await f.libsql.execute('drop trigger fail_late_batch');
    await remove();
    expect(await f.db.select().from(f.schema.noteEvents)).toHaveLength(125);
    const current = await f.properties.readFolderProperties(f.actor, 'board');
    expect(current.definitions[0].options).toEqual(
      f.field.options.slice(1).map((o) => ({ ...o, archived: o.id === f.field.options[3].id }))
    );
    expect(
      (await f.db.select().from(f.schema.notePropertyState)).every((row) => row.values === '{}' && row.revision === 2)
    ).toBe(true);
    expect((await f.db.select().from(f.schema.templateFolderAssignments))[0]).toMatchObject({
      defaultsRevision: 0,
      propertyDefaults: JSON.stringify({ [f.field.id]: f.field.options[0].id }),
    });
  });

  it('keeps grouping cards visible in Unclassified and hides a deleted Type badge', async () => {
    const f = await setupDeletion();
    await f.saveSelect(f.type.config, 0, 'owner', f.type.token);
    const preview = await f.preview();
    await f.remove({
      schemaId: preview.schemaId,
      expectedRevision: preview.expectedRevision,
      impactToken: preview.impactToken,
    });
    let response = await f.request(f.laneUrl('unclassified', 3));
    expect(response.status).toBe(200);
    let cards = (await response.json()).cards;
    expect(cards.map((c: { id: string }) => c.id).sort()).toEqual(['active', 'canvas']);
    expect(cards.every((c: { unclassifiedReason: string }) => c.unclassifiedReason === 'no-property-value')).toBe(true);
    const typeField = f.type.typeField;
    await f.patch('active', { [typeField.id]: typeField.options[0].id });
    const typePreview = await f.properties.previewOptionDeletion(
      f.actor,
      'board',
      typeField.id,
      typeField.options[0].id
    );
    await f.properties.deletePropertyOption(f.actor, 'board', typeField.id, typeField.options[0].id, {
      schemaId: typePreview.schemaId,
      expectedRevision: typePreview.expectedRevision,
      impactToken: typePreview.impactToken,
    });
    response = await f.request(f.laneUrl('unclassified', 4));
    expect(response.status).toBe(200);
    cards = (await response.json()).cards;
    expect(cards.find((c: { id: string }) => c.id === 'active')).toHaveProperty('properties', []);
    expect(cards).toHaveLength(2);
  });

  it('rejects a stale template creation after deletion and re-reviews cleaned defaults', async () => {
    const f = await setupDeletion();
    const templates = await import('../src/api/notes/templates');
    const before = await templates.previewAssignedTemplate(f.actor, 'board', 'template');
    const input = {
      folderId: 'board',
      templateId: 'template',
      snapshot: before.snapshot,
      schemaId: before.schema.schemaId,
      schemaRevision: before.schema.revision,
      title: 'Created',
      tags: [],
      values: before.values,
      requestId: 'reviewed-before-delete',
      variables: { date: 'DATE', time: 'TIME', datetime: 'DATETIME' },
    };
    const preview = await f.preview();
    await f.remove({
      schemaId: preview.schemaId,
      expectedRevision: preview.expectedRevision,
      impactToken: preview.impactToken,
    });
    await expect(templates.createFromTemplate(f.actor, input)).rejects.toMatchObject({ status: 409 });
    const after = await templates.previewAssignedTemplate(f.actor, 'board', 'template');
    expect(after.values).not.toHaveProperty(f.propertyId);
    expect(after.snapshot).not.toBe(before.snapshot);
    const created = await templates.createFromTemplate(f.actor, {
      ...input,
      snapshot: after.snapshot,
      schemaId: after.schema.schemaId,
      schemaRevision: after.schema.revision,
      values: after.values,
    });
    expect((await f.properties.readNoteProperties(f.actor, created.note.id)).values).toEqual(after.values);
  });

  it('a concurrent note save on an independent connection either wins or conflicts without resurrecting a deleted choice', async () => {
    const f = await setupDeletion();
    const preview = await f.preview();
    const deletion = {
      schemaId: preview.schemaId,
      expectedRevision: preview.expectedRevision,
      impactToken: preview.impactToken,
    };
    const patch = {
      schemaId: preview.schemaId,
      schemaRevision: preview.expectedRevision,
      expectedRevision: 1,
      values: { [f.propertyId]: f.field.options[1].id },
    };
    const calls = [
      `await p.deletePropertyOption({actorUserId:'owner'},'board',${JSON.stringify(f.propertyId)},${JSON.stringify(f.optionId)},${JSON.stringify(deletion)})`,
      `await p.patchNoteProperties({actorUserId:'owner'},'active',${JSON.stringify(patch)})`,
    ];
    const results = await Promise.all(
      calls.map((call) =>
        independent(
          `const p=await import('./src/api/notes/properties');try{${call};console.log('SAVED')}catch(e){if(e.status!==409)throw e;console.log('CONFLICT')}`
        )
      )
    );
    expect(
      results.every((r) => r.status === 0),
      JSON.stringify(results)
    ).toBe(true);
    expect(results.filter((r) => r.output.includes('SAVED'))).toHaveLength(1);
    expect(results.filter((r) => r.output.includes('CONFLICT'))).toHaveLength(1);
    const schema = await f.properties.readFolderProperties(f.actor, 'board');
    const active = await f.properties.readNoteProperties(f.actor, 'active');
    if (schema.definitions[0].options.some((o) => o.id === f.optionId)) {
      expect(active.values[f.propertyId]).toBe(f.field.options[1].id);
      expect(await f.db.select().from(f.schema.noteEvents)).toHaveLength(1);
    } else {
      expect(active.values).not.toHaveProperty(f.propertyId);
      expect(await f.db.select().from(f.schema.noteEvents)).toHaveLength(4);
    }
  }, 30000);

  it.each([
    'template creation',
    'default save',
  ])('a concurrent %s on another connection cannot bypass deletion review', async (kind) => {
    const f = await setupDeletion();
    const templates = await import('../src/api/notes/templates');
    const template = await templates.previewAssignedTemplate(f.actor, 'board', 'template');
    const preview = await f.preview();
    const deletion = {
      schemaId: preview.schemaId,
      expectedRevision: preview.expectedRevision,
      impactToken: preview.impactToken,
    };
    const creation = {
      folderId: 'board',
      templateId: 'template',
      snapshot: template.snapshot,
      schemaId: template.schema.schemaId,
      schemaRevision: template.schema.revision,
      title: 'Concurrent instance',
      tags: [],
      values: template.values,
      requestId: 'race-create',
      variables: { date: 'DATE', time: 'TIME', datetime: 'DATETIME' },
    };
    const defaults = {
      assignmentId: 'assignment_template',
      expectedRevision: 2,
      schemaId: template.schema.schemaId,
      schemaRevision: template.schema.revision,
      values: { ...template.values, [f.propertyId]: f.field.options[1].id },
    };
    const competing =
      kind === 'template creation'
        ? `await (await import('./src/api/notes/templates')).createFromTemplate({actorUserId:'owner'},${JSON.stringify(creation)})`
        : `await (await import('./src/api/notes/templates')).saveAssignmentDefaults({actorUserId:'owner'},'template','board',${JSON.stringify(defaults)})`;
    const calls = [
      `await p.deletePropertyOption({actorUserId:'owner'},'board',${JSON.stringify(f.propertyId)},${JSON.stringify(f.optionId)},${JSON.stringify(deletion)})`,
      competing,
    ];
    const results = await Promise.all(
      calls.map((call) =>
        independent(
          `const p=await import('./src/api/notes/properties');try{${call};console.log('SAVED')}catch(e){if(e.status!==409)throw e;console.log('CONFLICT')}`
        )
      )
    );
    expect(
      results.every((r) => r.status === 0),
      JSON.stringify(results)
    ).toBe(true);
    expect(results.filter((r) => r.output.includes('SAVED'))).toHaveLength(1);
    expect(results.filter((r) => r.output.includes('CONFLICT'))).toHaveLength(1);
    const current = await f.properties.readFolderProperties(f.actor, 'board');
    const assignment = await templates.previewAssignedTemplate(f.actor, 'board', 'template');
    if (current.definitions[0].options.some((o) => o.id === f.optionId)) {
      expect(await f.db.select().from(f.schema.noteEvents)).toHaveLength(kind === 'template creation' ? 1 : 0);
      expect(assignment.values[f.propertyId]).toBe(kind === 'template creation' ? f.optionId : f.field.options[1].id);
    } else {
      expect(assignment.values).not.toHaveProperty(f.propertyId);
      expect(await f.db.select().from(f.schema.noteEvents)).toHaveLength(4);
    }
  }, 30000);

  it('serializes simultaneous confirmations: one delete, one rejection, no duplicate activity', async () => {
    const f = await setupDeletion();
    const preview = await f.preview();
    const input = {
      schemaId: preview.schemaId,
      expectedRevision: preview.expectedRevision,
      impactToken: preview.impactToken,
    };
    const results = await Promise.allSettled([f.remove(input), f.remove(input)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await f.db.select().from(f.schema.noteEvents)).toHaveLength(4);
  });
});
