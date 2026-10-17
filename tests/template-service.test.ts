import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTemplateTests, setupTemplateTest } from './template-fixtures';

afterEach(cleanupTemplateTests);
describe('template defaults and retained membership', () => {
  for (const withSnapshot of [false, true])
    it.each([
      { label: 'trashed destination', trashId: 'child', visibleIds: ['root', 'board'], hiddenIds: ['child'] },
      {
        label: 'trashed parent with active descendant',
        trashId: 'board',
        visibleIds: ['root'],
        hiddenIds: ['board', 'child'],
      },
    ])(
      'visible-only save retains populated defaults for $label (snapshot: ' + withSnapshot + ')',
      async ({ trashId, visibleIds, hiddenIds }) => {
        const f = await setupTemplateTest();
        await f.templates.saveTemplateMembership(f.actor, 'template', { folderIds: ['root', 'board', 'child'] });
        const boardSchema = await f.addField(),
          childSchema = await f.addField('Child summary', 'text', [], 'child');
        const initial = await f.templates.readTemplateDefaults(f.actor, 'template');
        const childValues = { [childSchema.definitions[0].id]: 'Retain this real default' };
        for (const [folderId, schema, values] of [
          ['board', boardSchema, { [boardSchema.definitions[0].id]: boardSchema.definitions[0].options[0].id }],
          ['child', childSchema, childValues],
        ] as const) {
          const assignment = initial.assignments.find((a) => a.folderId === folderId);
          if (!assignment) throw new Error('Missing destination assignment');
          await f.templates.saveAssignmentDefaults(f.actor, 'template', folderId, {
            assignmentId: assignment.id,
            expectedRevision: assignment.revision,
            schemaId: schema.schemaId,
            schemaRevision: schema.revision,
            values,
          });
        }
        const rawAssignments = () =>
          f.db.select().from(f.schema.templateFolderAssignments).orderBy(f.schema.templateFolderAssignments.folderId);
        const beforeRows = await rawAssignments();
        const beforeDefaults = await f.templates.readTemplateDefaults(f.actor, 'template');
        const beforePreview = await f.templates.previewAssignedTemplate(f.actor, 'child', 'template');
        expect(beforeRows.find((a) => a.folderId === 'child')).toMatchObject({
          defaultsRevision: 1,
          schemaId: childSchema.schemaId,
          propertyDefaults: JSON.stringify(childValues),
        });
        await f.db.update(f.schema.folders).set({ deletedAt: f.now }).where(eq(f.schema.folders.id, trashId));
        if (trashId === 'board') {
          const [child] = await f.db.select().from(f.schema.folders).where(eq(f.schema.folders.id, 'child'));
          expect(child.deletedAt).toBeNull();
        }
        const membership = await f.templates.readTemplateMembership(f.actor, 'template');
        // Deliberately submit the independently known visible IDs, not the membership DTO's potentially wrong list.
        await f.templates.saveTemplateMembership(f.actor, 'template', {
          folderIds: visibleIds,
          ...(withSnapshot ? { snapshot: membership.snapshot } : {}),
        });
        // Exact raw rows protect identity, revision, schema identity and serialized defaults (not just empty DTOs).
        expect(await rawAssignments()).toEqual(beforeRows);
        expect(membership.folders.map((folder) => folder.id).sort()).toEqual([...visibleIds].sort());
        expect(
          (await f.templates.readTemplateMembership(f.actor, 'template')).folders.map((folder) => folder.id).sort()
        ).toEqual([...visibleIds].sort());
        expect(
          (await f.templates.readTemplateDefaults(f.actor, 'template')).assignments.map((a) => a.folderId).sort()
        ).toEqual([...visibleIds].sort());
        await expect(f.templates.previewAssignedTemplate(f.actor, 'child', 'template')).rejects.toMatchObject({
          status: 404,
        });
        for (const hiddenId of hiddenIds) {
          await expect(
            f.templates.saveTemplateMembership(f.actor, 'template', {
              folderIds: [...visibleIds, hiddenId],
              ...(withSnapshot ? { snapshot: membership.snapshot } : {}),
            })
          ).rejects.toMatchObject({ status: 404 });
          expect(await rawAssignments()).toEqual(beforeRows);
        }
        await f.db.update(f.schema.folders).set({ deletedAt: null }).where(eq(f.schema.folders.id, trashId));
        expect(await rawAssignments()).toEqual(beforeRows);
        expect(await f.templates.readTemplateDefaults(f.actor, 'template')).toEqual(beforeDefaults);
        expect(await f.templates.previewAssignedTemplate(f.actor, 'child', 'template')).toEqual(beforePreview);
        const restored = await f.templates.readTemplateMembership(f.actor, 'template');
        expect(restored.folders.map((folder) => folder.id).sort()).toEqual(['board', 'child', 'root']);
        // Explicitly unassigning the restored active destination still removes its populated assignment.
        await f.templates.saveTemplateMembership(f.actor, 'template', {
          folderIds: ['root', 'board'],
          ...(withSnapshot ? { snapshot: restored.snapshot } : {}),
        });
        expect(await rawAssignments()).toEqual(beforeRows.filter((a) => a.folderId !== 'child'));
        await expect(f.templates.previewAssignedTemplate(f.actor, 'child', 'template')).rejects.toMatchObject({
          status: 404,
        });
      }
    );
  it('content-only previews, two schemas, independent body/default metadata and retained assignment IDs', async () => {
    const f = await setupTemplateTest();
    const before = (await f.libsql.execute("select * from notes where id='template'")).rows;
    const defaults = await f.templates.readTemplateDefaults(f.actor, 'template');
    expect(defaults.tags).toEqual([]);
    const s = await f.addField('Text', 'text'),
      other = await f.addField('Date', 'date', [], 'child');
    const board = defaults.assignments.find((a) => a.folderId === 'board'),
      child = defaults.assignments.find((a) => a.folderId === 'child');
    if (!board || !child) throw new Error('Missing destination assignments');
    for (const [a, schema, value] of [
      [board, s, 'Default'],
      [child, other, '2028-02-29'],
    ] as const)
      await f.templates.saveAssignmentDefaults(f.actor, 'template', a.folderId, {
        assignmentId: a.id,
        expectedRevision: 0,
        schemaId: schema.schemaId,
        schemaRevision: schema.revision,
        values: { [schema.definitions[0].id]: value },
      });
    await f.templates.saveTemplateTags(f.actor, 'template', { expectedRevision: 0, tags: ['# Feature'] });
    await f.templates.saveTemplateMembership(f.actor, 'template', { folderIds: ['board', 'child'] });
    expect((await f.templates.readTemplateDefaults(f.actor, 'template')).assignments.map((a) => a.id)).toEqual(
      defaults.assignments.map((a) => a.id)
    );
    expect((await f.templates.previewAssignedTemplate({ actorUserId: 'editor' }, 'board', 'template')).values).toEqual({
      [s.definitions[0].id]: 'Default',
    });
    expect((await f.templates.previewAssignedTemplate(f.actor, 'child', 'template')).values).toEqual({
      [other.definitions[0].id]: '2028-02-29',
    });
    expect((await f.libsql.execute("select * from notes where id='template'")).rows).toEqual(before);
    expect((await f.libsql.execute('select * from tags')).rows).toEqual([]);
  });
  it('snapshot changes for body/defaults/reassignment and stale owner saves conflict', async () => {
    const f = await setupTemplateTest(),
      p = await f.templates.previewAssignedTemplate(f.actor, 'board', 'template');
    await f.templates.saveTemplateTags(f.actor, 'template', { expectedRevision: 0, tags: ['feature'] });
    await expect(
      f.templates.saveTemplateTags(f.actor, 'template', { expectedRevision: 0, tags: [] })
    ).rejects.toMatchObject({ status: 409 });
    expect((await f.templates.previewAssignedTemplate(f.actor, 'board', 'template')).snapshot).not.toBe(p.snapshot);
    const membership = await f.templates.readTemplateMembership(f.actor, 'template');
    await f.templates.saveTemplateMembership(f.actor, 'template', {
      folderIds: ['child'],
      snapshot: membership.snapshot,
    });
    await expect(
      f.templates.saveTemplateMembership(f.actor, 'template', { folderIds: ['board'], snapshot: membership.snapshot })
    ).rejects.toMatchObject({ status: 409 });
    await f.templates.saveTemplateMembership(f.actor, 'template', { folderIds: ['child', 'board'] });
    expect((await f.templates.previewAssignedTemplate(f.actor, 'board', 'template')).snapshot).not.toBe(p.snapshot);
  });
  it('only eligible destination creators discover assigned templates; no general access grant', async () => {
    const f = await setupTemplateTest();
    for (const user of ['viewer', 'commenter', 'stranger'])
      await expect(
        f.templates.previewAssignedTemplate({ actorUserId: user }, 'board', 'template')
      ).rejects.toBeDefined();
    expect(await f.templates.listAssignedTemplates({ actorUserId: 'editor' }, 'board')).toEqual([
      { id: 'template', title: 'Feature' },
    ]);
    await expect(f.templates.readTemplateDefaults({ actorUserId: 'editor' }, 'template')).rejects.toMatchObject({
      status: 404,
    });
    expect((await f.app.request('/internal/notes/template', { headers: { 'x-user': 'editor' } })).status).toBe(404);
  });
  it('retained defaults block archive even with template in Trash; clearing or removing permits it', async () => {
    const f = await setupTemplateTest(),
      s = await f.addField(),
      field = s.definitions[0];
    const a = (await f.templates.readTemplateDefaults(f.actor, 'template')).assignments.find(
      (a) => a.folderId === 'board'
    );
    if (!a) throw new Error('Missing board assignment');
    await f.templates.saveAssignmentDefaults(f.actor, 'template', 'board', {
      assignmentId: a.id,
      expectedRevision: 0,
      schemaId: s.schemaId,
      schemaRevision: 1,
      values: { [field.id]: field.options[0].id },
    });
    await f.db.update(f.schema.notes).set({ deletedAt: f.now }).where(eq(f.schema.notes.id, 'template'));
    await expect(
      f.properties.mutateFolderProperties(f.actor, 'board', {
        expectedRevision: 1,
        mutation: { type: 'archive_option', propertyId: field.id, optionId: field.options[0].id },
      })
    ).rejects.toMatchObject({ status: 409 });
    await f.db.update(f.schema.notes).set({ deletedAt: null }).where(eq(f.schema.notes.id, 'template'));
    await f.templates.saveAssignmentDefaults(f.actor, 'template', 'board', {
      assignmentId: a.id,
      expectedRevision: 1,
      schemaId: s.schemaId,
      schemaRevision: 1,
      values: {},
    });
    expect(
      (
        await f.properties.mutateFolderProperties(f.actor, 'board', {
          expectedRevision: 1,
          mutation: { type: 'archive', propertyId: field.id },
        })
      ).revision
    ).toBe(2);
  });
});
