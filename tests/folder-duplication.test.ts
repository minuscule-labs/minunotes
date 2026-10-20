import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ObjectStorage } from '../src/api/storage/object-storage';
import { FOLDER_COPY_LIMITS } from '../src/shared/folder-duplication';
import { cleanupBoardTests, setupBoardTest } from './board-fixtures';

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupBoardTests();
});
const payload = { title: 'New project', parentFolderId: null, requestId: 'copy_request_0001' };
async function setup(full = false) {
  const f = await setupBoardTest(44),
    copy = await import('../src/api/folders/duplicate');
  const objects = new Map<string, Uint8Array>([['original-image', new TextEncoder().encode('image')]]);
  const storage: ObjectStorage = {
    provider: 'test',
    getObject: vi.fn(async ({ key }) => (objects.has(key) ? { body: objects.get(key) ?? new Uint8Array() } : null)),
    putObject: vi.fn(async ({ key, body }) => {
      objects.set(key, body);
    }),
    deleteObject: vi.fn(async ({ key }) => {
      objects.delete(key);
    }),
  };
  const rawDuplicate = (input: unknown = payload, actor = 'owner', source = 'board') =>
    copy.duplicateFolder(actor, source, input, { storage, origins: ['https://notes.test'] });
  const preview = (parent: string | null = null, actor = 'owner', source = 'board') =>
    copy.previewFolderDuplication(actor, source, parent, { origins: ['https://notes.test'] });
  if (full) {
    await f.db
      .update(f.schema.folders)
      .set({ isPrivate: true, isAgentReadOnly: true })
      .where(eq(f.schema.folders.id, 'root'));
    await f.addNote('note_target', 'Target', ['starter'], {
      content: '{{title}}\n![image](</internal/attachments/att_image/content>)\n[[Outside]]',
    });
    await f.addNote('note_canvas', 'Canvas', [], {
      folderId: 'child',
      documentType: 'canvas.mindmap',
      content: JSON.stringify({
        nodes: [
          {
            id: 'node',
            type: 'text',
            text: '[[Target]]',
            minunotes: { link: { type: 'note', id: 'note_target' } },
            x: 3,
            y: 8,
          },
        ],
        edges: [],
      }),
    });
    await f.addNote('note_inside', 'Contained template', [], { type: 'template', content: '{{date}}' });
    await f.addNote('note_external', 'Assigned template', [], {
      folderId: 'other',
      type: 'template',
      isApiEditable: false,
      content: '{{title}} [[Target]]',
    });
    await f.addNote('note_outside', 'Outside', [], { folderId: 'other' });
    await f.addNote('note_trash', 'Trashed', [], { deletedAt: f.now });
    await f.db
      .insert(f.schema.folders)
      .values({ id: 'trash-folder', title: 'Trash', userId: 'owner', parentFolderId: 'board', deletedAt: f.now });
    await f.addNote('note_below_trash', 'Hidden by ancestor', [], { folderId: 'trash-folder' });
    const defs = [
      {
        id: 'status',
        label: 'Status',
        type: 'select',
        archived: false,
        options: [
          { id: 'open', label: 'Open', archived: false },
          { id: 'retired', label: 'Old', archived: true },
        ],
      },
      { id: 'text', label: 'Details', type: 'text', archived: true, options: [] },
    ];
    await f.db.insert(f.schema.folderPropertySchemas).values({
      folderId: 'board',
      userId: 'owner',
      schemaId: 'schema_base',
      revision: 8,
      definitions: JSON.stringify(defs),
      createdAt: f.now,
      updatedAt: f.now,
    });
    await f.db.insert(f.schema.notePropertyState).values({
      noteId: 'note_target',
      userId: 'owner',
      revision: 8,
      values: JSON.stringify({ status: 'retired', text: 'x'.repeat(1000), unknown: 27 }),
      createdAt: f.now,
      updatedAt: f.now,
    });
    await f.db.insert(f.schema.folderBoardViews).values({
      folderId: 'board',
      userId: 'owner',
      version: 7,
      config: JSON.stringify({
        schemaVersion: 5,
        enabled: false,
        mode: 'read-only',
        grouping: { type: 'select', schemaId: 'schema_base', propertyId: 'status' },
        cardPropertyIds: ['text'],
        columnVisibility: { mode: 'selected', optionIds: ['open', 'retired'], showUnclassified: false },
      }),
      createdAt: f.now,
      updatedAt: f.now,
    });
    await f.db.insert(f.schema.templateDefaultState).values({
      templateId: 'note_external',
      userId: 'owner',
      revision: 8,
      tags: '["starter"]',
      createdAt: f.now,
      updatedAt: f.now,
    });
    await f.db.insert(f.schema.templateFolderAssignments).values([
      {
        id: 'assignment1',
        templateId: 'note_external',
        folderId: 'board',
        userId: 'owner',
        schemaId: 'schema_base',
        defaultsRevision: 8,
        propertyDefaults: '{"status":"open"}',
      },
      { id: 'assignment2', templateId: 'note_external', folderId: 'child', userId: 'owner' },
      { id: 'assignment3', templateId: 'note_inside', folderId: 'other', userId: 'owner' },
    ]);
    const bytes = objects.get('original-image') ?? new Uint8Array();
    await f.db.insert(f.schema.attachments).values({
      id: 'att_image',
      userId: 'owner',
      noteId: 'note_target',
      folderId: 'board',
      filename: 'image.png',
      mimeType: 'image/png',
      size: bytes.length,
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      storageKey: 'original-image',
      referencedAt: f.now,
    });
  }
  const initialPreview = await preview();
  const duplicate = (input: unknown = payload, actor = 'owner', source = 'board') =>
    rawDuplicate(
      typeof input === 'object' && input !== null && !Array.isArray(input)
        ? { previewToken: initialPreview.token, ...input }
        : input,
      actor,
      source
    );
  return { ...f, duplicate, rawDuplicate, preview, objects, storage };
}
describe('folder duplication', () => {
  it('copies a complete recursive project with independent metadata/templates/images/links and unchanged source', async () => {
    const f = await setup(true);
    const tables = [
      'folders',
      'notes',
      'folder_property_schemas',
      'folder_board_views',
      'note_property_state',
      'template_folder_assignments',
      'template_default_state',
      'tags',
      'note_tags',
      'collaboration_grants',
    ];
    const before = new Map<string, unknown[]>();
    for (const table of tables) before.set(table, (await f.libsql.execute(`select * from ${table}`)).rows);
    const result = await f.duplicate();
    expect(result.counts).toEqual({ folders: 2, notes: 2, templates: 2, attachments: 1 });
    expect(result.replayed).toBe(false);
    const clones = await f.db.select().from(f.schema.notes);
    const copied = clones.filter(
      (row) =>
        ![
          'note_target',
          'note_canvas',
          'note_inside',
          'note_external',
          'note_outside',
          'note_trash',
          'note_below_trash',
        ].includes(row.id)
    );
    expect(copied).toHaveLength(4);
    const target = copied.find((row) => row.title === 'Target'),
      canvas = copied.find((row) => row.title === 'Canvas'),
      template = copied.find((row) => row.title === 'Assigned template');
    if (!target || !canvas || !template) throw new Error('Missing copied note');
    expect(template.folderId).toBe(result.folder.id);
    expect(template.isApiEditable).toBe(false);
    expect(template.content).toContain('{{title}}');
    expect(template.content).toContain(`[[${target.id}|Target]]`);
    expect(target.content).toContain('[[note_outside|Outside]]');
    const canvasDoc = JSON.parse(canvas.content);
    expect(canvasDoc.nodes[0]).toMatchObject({
      id: 'node',
      x: 3,
      y: 8,
      minunotes: { link: { id: target.id } },
      text: `[[${target.id}|Target]]`,
    });
    const [root] = await f.db.select().from(f.schema.folders).where(eq(f.schema.folders.id, result.folder.id));
    expect(root).toMatchObject({
      parentFolderId: null,
      isPrivate: true,
      isAgentReadOnly: true,
      createdByUserId: 'owner',
    });
    const [schema] = await f.db
      .select()
      .from(f.schema.folderPropertySchemas)
      .where(eq(f.schema.folderPropertySchemas.folderId, result.folder.id));
    const definitions = JSON.parse(schema.definitions);
    expect(schema.revision).toBe(1);
    expect(schema.schemaId).not.toBe('schema_base');
    expect(definitions[0].options[1].archived).toBe(true);
    const [state] = await f.db
      .select()
      .from(f.schema.notePropertyState)
      .where(eq(f.schema.notePropertyState.noteId, target.id));
    expect(JSON.parse(state.values)).toEqual({
      [definitions[0].id]: definitions[0].options[1].id,
      [definitions[1].id]: 'x'.repeat(1000),
      unknown: 27,
    });
    expect(state.revision).toBe(1);
    const [board] = await f.db
      .select()
      .from(f.schema.folderBoardViews)
      .where(eq(f.schema.folderBoardViews.folderId, result.folder.id));
    expect(board.version).toBe(1);
    expect(JSON.parse(board.config)).toMatchObject({
      enabled: false,
      grouping: { schemaId: schema.schemaId, propertyId: definitions[0].id },
      cardPropertyIds: [definitions[1].id],
      columnVisibility: {
        mode: 'selected',
        optionIds: definitions[0].options.map((option: { id: string }) => option.id),
        showUnclassified: false,
      },
    });
    const assignments = (await f.db.select().from(f.schema.templateFolderAssignments)).filter(
      (row) => row.templateId === template.id
    );
    expect(assignments).toHaveLength(2);
    expect(assignments.find((row) => row.folderId === result.folder.id)).toMatchObject({
      schemaId: schema.schemaId,
      propertyDefaults: JSON.stringify({ [definitions[0].id]: definitions[0].options[0].id }),
      defaultsRevision: 1,
    });
    const [defaults] = await f.db
      .select()
      .from(f.schema.templateDefaultState)
      .where(eq(f.schema.templateDefaultState.templateId, template.id));
    expect(defaults).toMatchObject({ tags: '["starter"]', revision: 1 });
    const [image] = await f.db.select().from(f.schema.attachments).where(eq(f.schema.attachments.noteId, target.id));
    expect(image.storageKey).not.toBe('original-image');
    expect(image.id).not.toBe('att_image');
    expect(target.content).toContain(`/attachments/${image.id}/content`);
    expect(f.objects.get(image.storageKey)).toEqual(f.objects.get('original-image'));
    expect(await f.db.select().from(f.schema.noteVersions)).toHaveLength(4);
    expect(await f.db.select().from(f.schema.noteEvents)).toHaveLength(4);
    const links = await f.db.select().from(f.schema.noteLinks);
    expect(links.some((row) => row.sourceNoteId === canvas.id && row.targetNoteId === target.id)).toBe(true);
    expect(
      Number((await f.libsql.execute('select count(*) n from note_search_documents')).rows[0].n)
    ).toBeGreaterThanOrEqual(4);
    for (const table of tables) {
      const after = (await f.libsql.execute(`select * from ${table}`)).rows;
      for (const row of before.get(table) ?? []) expect(after).toContainEqual(row);
    }
    expect(await f.db.select().from(f.schema.collaborationGrants)).toHaveLength(3);
    expect(await f.db.select().from(f.schema.tags)).toHaveLength(1);
    await f.db.delete(f.schema.notes).where(eq(f.schema.notes.id, 'note_target'));
    f.objects.delete('original-image');
    expect(f.objects.get(image.storageKey)).toEqual(new TextEncoder().encode('image'));
    expect(target.content).toContain(`![image](</internal/attachments/${image.id}/content>)`);
    expect(await f.db.select().from(f.schema.notes).where(eq(f.schema.notes.id, target.id))).toHaveLength(1);
  });
  it('retains an angle-linked copied image after ordinary edits and cleanup, but cleans up an intentionally removed image', async () => {
    const f = await setup(true);
    const { updateDocument } = await import('../src/api/harness/commands');
    const storageModule = await import('../src/api/storage');
    const { cleanupUnreferencedAttachments } = await import('../src/api/attachments/cleanup');
    const { extractAppAttachmentIds } = await import('../src/api/attachments/references');
    const copied = await f.duplicate();
    expect(copied.folder.id).not.toBe('board');
    // Select the note that owns the cloned image, rather than relying on note insert order.
    const images = await f.db.select().from(f.schema.attachments);
    const image = images.find((row) => row.id !== 'att_image');
    if (!image) throw new Error('Missing copied image');
    const [imageNote] = await f.db.select().from(f.schema.notes).where(eq(f.schema.notes.id, image.noteId));
    await f.db.delete(f.schema.notes).where(eq(f.schema.notes.id, 'note_target'));
    f.objects.delete('original-image');
    const edit = await updateDocument({
      documentId: imageNote.id,
      userId: 'owner',
      markdown: `${imageNote.content}\nOrdinary edit`,
      actorType: 'user',
      actorId: 'owner',
    });
    expect(edit.ok).toBe(true);
    const [afterEdit] = await f.db.select().from(f.schema.attachments).where(eq(f.schema.attachments.id, image.id));
    vi.spyOn(storageModule, 'getObjectStorage').mockReturnValue(f.storage);
    const cutoff = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
    expect(await cleanupUnreferencedAttachments({ cutoff })).toMatchObject({ deleted: 0 });
    expect(afterEdit.unreferencedAt).toBeNull();
    expect(f.objects.get(image.storageKey)).toEqual(new TextEncoder().encode('image'));
    for (const markdown of [
      '![image](/internal/attachments/att_image/content)',
      '[download](/internal/attachments/att_image/content "Title")',
      '![image](https://notes.test/internal/attachments/att_image/content?q=1#part)',
      '![image](https://notes.test/internal/attachments/att_image/content?next=/internal/attachments/att_other/content)',
      '![image](<https://notes.test/internal/attachments/att_image/content?next=/internal/attachments/att_other/content>)',
      '![image](</internal/attachments/att_image/content>)',
      '[download](<https://notes.test/internal/attachments/att_image/content?q=(1)#part> "Title")',
      "![image](  </internal/attachments/att_image/content>  'Title' )",
    ])
      expect(extractAppAttachmentIds(markdown)).toEqual(['att_image']);
    for (const malformed of [
      '![bad](</internal/attachments/att_image/content)',
      '![bad](/internal/attachments/att_image/content>)',
    ])
      expect(extractAppAttachmentIds(malformed)).toEqual([]);
    expect(
      (
        await updateDocument({
          documentId: imageNote.id,
          userId: 'owner',
          markdown: 'Image intentionally removed',
          actorType: 'user',
          actorId: 'owner',
        })
      ).ok
    ).toBe(true);
    expect(await cleanupUnreferencedAttachments({ cutoff })).toMatchObject({ deleted: 1 });
    expect(f.objects.has(image.storageKey)).toBe(false);
  });
  it('replays when the original commits after the retry receipt lookup, including title-link resolution changes', async () => {
    const f = await setup(true),
      transactions = await import('../src/api/notes/metadata-transaction');
    let staged: () => void = () => {},
      resume: () => void = () => {};
    const atStage = new Promise<void>((resolve) => {
        staged = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
    vi.mocked(f.storage.putObject).mockImplementationOnce(async ({ key, body }) => {
      f.objects.set(key, body);
      staged();
      await gate;
    });
    const first = f.duplicate();
    await atStage;
    const real = transactions.metadataTransaction;
    let delayed = false;
    const spy = vi.spyOn(transactions, 'metadataTransaction').mockImplementation(async (run) => {
      const value = await real(run);
      if (!delayed) {
        delayed = true;
        resume();
        await first;
      }
      return value;
    });
    let second: unknown;
    try {
      second = await f.duplicate();
    } catch (error) {
      second = { error };
    }
    const committed = await first;
    spy.mockRestore();
    expect(second).toMatchObject({ folder: { id: committed.folder.id }, replayed: true });
    expect(await f.db.select().from(f.schema.folderDuplicationRequests)).toHaveLength(1);
    expect(f.objects.size).toBe(2);
    expect(f.objects.has('original-image')).toBe(true);
    const committedImages = await f.db.select().from(f.schema.attachments);
    const deletedKeys = vi.mocked(f.storage.deleteObject).mock.calls.map(([input]) => input.key);
    for (const image of committedImages) {
      expect(deletedKeys).not.toContain(image.storageKey);
      expect(f.objects.get(image.storageKey)).toEqual(new TextEncoder().encode('image'));
    }
    for (const key of deletedKeys) expect(f.objects.has(key)).toBe(false);
  });
  it('rejects combined expanded content and metadata before staging images or creating a tree', async () => {
    const f = await setup(true);
    const [schema] = await f.db.select().from(f.schema.folderPropertySchemas);
    const definitions = JSON.parse(schema.definitions);
    const values: Record<string, string> = { text: 'z'.repeat(181000) };
    for (let i = 0; i < 98; i++) {
      definitions.push({
        id: `s${i}`,
        label: `S${i}`,
        type: 'select',
        archived: false,
        options: [{ id: 'o', label: 'Option', archived: false }],
      });
      values[`s${i}`] = 'o';
    }
    await f.db
      .update(f.schema.folderPropertySchemas)
      .set({ definitions: JSON.stringify(definitions) })
      .where(eq(f.schema.folderPropertySchemas.folderId, 'board'));
    for (let i = 0; i < 90; i++) {
      const id = `note_budget${i}`;
      await f.addNote(id, `Budget ${i}`, [], { content: '[[Target]]' });
      await f.db.insert(f.schema.notePropertyState).values({
        noteId: id,
        userId: 'owner',
        revision: 1,
        values: JSON.stringify(values),
        createdAt: f.now,
        updatedAt: f.now,
      });
    }
    const checked = await f.preview();
    expect(checked.counts.notes + checked.counts.templates).toBe(94);
    await expect(f.duplicate({ ...payload, previewToken: checked.token })).rejects.toMatchObject({ status: 413 });
    expect(f.storage.putObject).not.toHaveBeenCalled();
    expect(await f.db.select().from(f.schema.folderDuplicationRequests)).toHaveLength(0);
    expect(await f.db.select().from(f.schema.folders)).toHaveLength(6);
  });
  it('converges concurrent retries, refuses changed payloads and retains a tombstone after hard deletion', async () => {
    const f = await setup();
    const [a, b] = await Promise.all([f.duplicate(), f.duplicate()]);
    expect(a.folder.id).toBe(b.folder.id);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(await f.db.select().from(f.schema.folderDuplicationRequests)).toHaveLength(1);
    await expect(f.duplicate({ ...payload, title: 'Different' })).rejects.toMatchObject({ status: 409 });
    await f.db.delete(f.schema.folders).where(eq(f.schema.folders.id, a.folder.id));
    await expect(f.duplicate()).rejects.toMatchObject({ status: 404 });
    expect(await f.db.select().from(f.schema.folders)).toHaveLength(5);
    expect(await f.db.select().from(f.schema.folderDuplicationRequests)).toHaveLength(1);
  });
  it('enforces session ownership, destination/privacy/depth/Trash and size bounds before writes', async () => {
    const f = await setup();
    for (const actor of ['viewer', 'commenter', 'editor', 'stranger'])
      await expect(f.duplicate(payload, actor)).rejects.toMatchObject({ status: 404 });
    await expect(f.duplicate({ ...payload, parentFolderId: 'foreign' })).rejects.toMatchObject({ status: 404 });
    await expect(f.duplicate({ ...payload, parentFolderId: 'child' })).rejects.toMatchObject({ status: 400 });
    await f.db.update(f.schema.folders).set({ isPrivate: true }).where(eq(f.schema.folders.id, 'other'));
    await expect(f.duplicate({ ...payload, parentFolderId: 'other' })).rejects.toMatchObject({ status: 403 });
    for (let i = 0; i < 3; i++)
      await f.db
        .insert(f.schema.folders)
        .values({ id: `deep${i}`, title: 'Deep', userId: 'owner', parentFolderId: i ? `deep${i - 1}` : 'root' });
    await expect(f.duplicate({ ...payload, parentFolderId: 'deep2' })).rejects.toMatchObject({ status: 400 });
    for (let i = 0; i < FOLDER_COPY_LIMITS.folders; i++)
      await f.db
        .insert(f.schema.folders)
        .values({ id: `wide${i}`, title: 'Wide', userId: 'owner', parentFolderId: 'board' });
    await expect(f.duplicate()).rejects.toMatchObject({ status: 413 });
    await f.db.update(f.schema.folders).set({ deletedAt: f.now }).where(eq(f.schema.folders.id, 'root'));
    await expect(f.duplicate()).rejects.toMatchObject({ status: 404 });
    expect(await f.db.select().from(f.schema.folderDuplicationRequests)).toHaveLength(0);
    expect(f.storage.putObject).not.toHaveBeenCalled();
    const response = await f.app.request('/internal/folders/foreign/duplicate', {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(404);
  });
  it('compensates partial storage failure, source drift and final database rollback without deleting source bytes', async () => {
    const f = await setup(true);
    vi.mocked(f.storage.putObject).mockImplementationOnce(async ({ key, body }) => {
      f.objects.set(key, body);
      throw new Error('lost upload acknowledgement');
    });
    await expect(f.duplicate()).rejects.toMatchObject({ status: 503 });
    expect([...f.objects.keys()]).toEqual(['original-image']);
    vi.mocked(f.storage.putObject).mockImplementationOnce(async ({ key, body }) => {
      f.objects.set(key, body);
      await f.db.update(f.schema.notes).set({ title: 'Changed' }).where(eq(f.schema.notes.id, 'note_target'));
    });
    await expect(f.duplicate()).rejects.toMatchObject({ status: 409 });
    expect([...f.objects.keys()]).toEqual(['original-image']);
    await f.db
      .update(f.schema.folderBoardViews)
      .set({ config: '{' })
      .where(eq(f.schema.folderBoardViews.folderId, 'board'));
    await expect(f.duplicate()).rejects.toMatchObject({ status: 409 });
    expect([...f.objects.keys()]).toEqual(['original-image']);
    expect(await f.db.select().from(f.schema.folderDuplicationRequests)).toHaveLength(0);
    expect(await f.db.select().from(f.schema.folders)).toHaveLength(6);
  });
  it('reconciles a lost commit acknowledgement and preserves objects when the receipt probe is unavailable', async () => {
    const f = await setup(true),
      transactions = await import('../src/api/notes/metadata-transaction');
    const real = transactions.metadataTransaction;
    const created = (value: unknown) =>
      !!value && typeof value === 'object' && 'replayed' in value && value.replayed === false;
    let lost = false;
    const spy = vi.spyOn(transactions, 'metadataTransaction').mockImplementation(async (run) => {
      const value = await real(run);
      if (!lost && created(value)) {
        lost = true;
        throw new Error('lost commit response');
      }
      return value;
    });
    const result = await f.duplicate();
    expect(result.replayed).toBe(true);
    expect(f.storage.deleteObject).not.toHaveBeenCalled();
    expect(f.objects.size).toBe(2);
    spy.mockRestore();
    const refreshed = await f.preview();
    lost = false;
    const second = vi.spyOn(transactions, 'metadataTransaction').mockImplementation(async (run) => {
      if (lost) throw new Error('probe unavailable');
      const value = await real(run);
      if (created(value)) {
        lost = true;
        throw new Error('lost commit response');
      }
      return value;
    });
    await expect(
      f.duplicate({ ...payload, requestId: 'copy_request_0002', previewToken: refreshed.token })
    ).rejects.toMatchObject({
      status: 503,
      uncertain: true,
    });
    expect(f.storage.deleteObject).not.toHaveBeenCalled();
    expect(f.objects.size).toBe(3);
    second.mockRestore();
    const recovered = await f.duplicate({ ...payload, requestId: 'copy_request_0002' });
    expect(recovered.replayed).toBe(true);
    expect(recovered.folder.id).not.toBe(result.folder.id);
    expect(await f.db.select().from(f.schema.folderDuplicationRequests)).toHaveLength(2);
  });
  it('provides read-only authorized scoped previews and requires fresh confirmation, with safe legacy continuation', async () => {
    const f = await setup(true);
    const before = (await f.db.select().from(f.schema.folders)).length;
    const checked = await f.preview();
    expect(checked).toMatchObject({
      sourceFolderId: 'board',
      parentFolderId: null,
      counts: { folders: 2, notes: 2, templates: 2, attachments: 1 },
      imageBytes: 5,
    });
    expect(f.storage.getObject).not.toHaveBeenCalled();
    expect(f.storage.putObject).not.toHaveBeenCalled();
    expect(await f.db.select().from(f.schema.folderDuplicationRequests)).toHaveLength(0);
    for (const actor of ['viewer', 'editor', 'stranger'])
      await expect(f.preview(null, actor)).rejects.toMatchObject({ status: 404 });
    expect(
      (await f.request('/internal/folders/board/duplicate-preview?parentFolderId=other&parentFolderId=child')).status
    ).toBe(400);
    const moved = await f.preview('other');
    await expect(f.duplicate({ ...payload, parentFolderId: 'other' })).rejects.toMatchObject({ status: 409 });
    expect(moved.token).not.toBe(checked.token);
    await f.db.update(f.schema.notes).set({ content: 'Changed' }).where(eq(f.schema.notes.id, 'note_inside'));
    await expect(f.duplicate()).rejects.toMatchObject({ status: 409 });
    expect(await f.db.select().from(f.schema.folders)).toHaveLength(before);
    await expect(f.rawDuplicate()).rejects.toMatchObject({ status: 428 });
    const fresh = await f.preview();
    const continued = await f.duplicate({ ...payload, previewToken: fresh.token });
    expect((await f.rawDuplicate()).folder.id).toBe(continued.folder.id);
    // A pre-preview committed receipt retains its original three-field fingerprint too.
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ sourceId: 'board', ...payload }))
      .digest('hex');
    await f.db
      .update(f.schema.folderDuplicationRequests)
      .set({ fingerprint })
      .where(eq(f.schema.folderDuplicationRequests.requestId, payload.requestId));
    expect((await f.rawDuplicate()).replayed).toBe(true);
  });
  it('enforces the 100-document and 25 MiB image hard caps, including templates and repeat image copies', async () => {
    const f = await setup();
    expect(FOLDER_COPY_LIMITS.notes).toBe(100);
    expect(FOLDER_COPY_LIMITS.attachmentBytes).toBe(25 * 1024 * 1024);
    for (let i = 0; i < 100; i++)
      await f.addNote(`note_limit${i}`, `Limit ${i}`, [], { type: i === 99 ? 'template' : 'note' });
    const checked = await f.preview();
    expect(checked.counts).toMatchObject({ notes: 99, templates: 1 });
    await f.addNote('note_over', 'Over');
    await expect(f.preview()).rejects.toMatchObject({ status: 413 });
    await expect(f.duplicate()).rejects.toMatchObject({ status: 413 });
    await f.db.delete(f.schema.notes).where(eq(f.schema.notes.id, 'note_over'));
    for (let i = 0; i < 3; i++) {
      await f.db
        .update(f.schema.notes)
        .set({ content: `![image](</internal/attachments/att_limit${i}/content>)` })
        .where(eq(f.schema.notes.id, `note_limit${i}`));
      await f.db.insert(f.schema.attachments).values({
        id: `att_limit${i}`,
        userId: 'owner',
        noteId: `note_limit${i}`,
        folderId: 'board',
        filename: 'image.png',
        mimeType: 'image/png',
        size: (i === 2 ? 5 : 10) * 1024 * 1024,
        contentHash: 'hash',
        storageKey: `unused${i}`,
        referencedAt: f.now,
      });
    }
    const imagePreview = await f.preview();
    expect(imagePreview.imageBytes).toBe(25 * 1024 * 1024);
    await f.db
      .update(f.schema.attachments)
      .set({ size: 5 * 1024 * 1024 + 1 })
      .where(eq(f.schema.attachments.id, 'att_limit2'));
    await expect(f.preview()).rejects.toMatchObject({ status: 413 });
    await expect(f.duplicate({ ...payload, previewToken: imagePreview.token })).rejects.toMatchObject({ status: 409 });
    expect(f.storage.getObject).not.toHaveBeenCalled();
    expect(f.storage.putObject).not.toHaveBeenCalled();
    expect(await f.db.select().from(f.schema.folderDuplicationRequests)).toHaveLength(0);
  });
  it('exposes a bounded route contract and creates then replays an ordinary folder without a Board/schema', async () => {
    const f = await setup();
    const post = (body: unknown) =>
      f.app.request('/internal/folders/other/duplicate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const check = await f.request('/internal/folders/other/duplicate-preview');
    expect(check.status).toBe(200);
    const checked = await check.json();
    const confirmed = { ...payload, previewToken: checked.token };
    const created = await post(confirmed);
    expect(created.status).toBe(201);
    const a = await created.json();
    expect(a.counts).toEqual({ folders: 1, notes: 0, templates: 0, attachments: 0 });
    expect(a.folder).not.toHaveProperty('userId');
    const again = await post(confirmed);
    expect(again.status).toBe(200);
    expect((await again.json()).folder).toEqual(a.folder);
    expect((await post({ ...payload, title: '' })).status).toBe(400);
    expect((await post({ ...payload, content: 'x'.repeat(5000) })).status).toBe(413);
  });
});
