import { createHash } from 'node:crypto';
import type { Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../../src/api/db/schema';
import { DEFAULT_BOARD_CONFIG, validateBoardConfig } from '../../src/shared/board';
import { mutatePropertyDefinitions } from '../../src/shared/properties';

export const DEMO_FOLDER_ID = 'folder_demo_board';
export const DEMO_ROOT_ID = 'folder_demo_root';
export const DEMO_CHILD_ID = 'folder_demo_child';
export const DEMO_OTHER_FOLDER_ID = 'folder_demo_other';
export const DEMO_TEMPLATE_FOLDER_ID = 'folder_demo_templates';
export const DEMO_USERS = Object.fromEntries(
  ['owner', 'viewer', 'commenter', 'editor', 'other'].map((role) => [
    role,
    { id: `user_demo_${role}`, name: `Board demo ${role}`, email: `${role}@board-demo.test` },
  ])
) as Record<'owner' | 'viewer' | 'commenter' | 'editor' | 'other', { id: string; name: string; email: string }>;
export const DEMO_TEMPLATE_ID = stableId('note', 'template');
export const DEMO_CONTENT_TEMPLATE_ID = stableId('note', 'content-template');
export const DEMO_OTHER_CONFIG = validateBoardConfig({ ...DEFAULT_BOARD_CONFIG, enabled: false });
let nextPropertyId = 0;
const propertyId = (prefix: string) => stableId(prefix, `properties-${nextPropertyId++}`);
export const DEMO_PROPERTY_DEFINITIONS = [
  ...mutatePropertyDefinitions(
    [],
    { type: 'add', label: 'Status', fieldType: 'select', options: ['Todo', 'In progress', 'Done'] },
    propertyId
  ),
  ...mutatePropertyDefinitions([], { type: 'add', label: 'Summary', fieldType: 'text' }, propertyId),
  ...mutatePropertyDefinitions([], { type: 'add', label: 'Due date', fieldType: 'date' }, propertyId),
];
export const DEMO_TYPE_DEFINITION = mutatePropertyDefinitions(
  [],
  { type: 'add', label: 'Type', fieldType: 'select', options: ['Bug', 'Feature', 'Task'] },
  propertyId
)[0];
DEMO_PROPERTY_DEFINITIONS.push(DEMO_TYPE_DEFINITION);
export const DEMO_CONFIG = validateBoardConfig({
  ...DEFAULT_BOARD_CONFIG,
  schemaVersion: 5,
  grouping: {
    type: 'select',
    schemaId: stableId('property_schema', 'board'),
    propertyId: DEMO_PROPERTY_DEFINITIONS[0].id,
  },
  cardPropertyIds: [DEMO_TYPE_DEFINITION.id],
});
const timestamp = new Date('2026-10-08T12:00:00.000Z');
function stableId(prefix: string, key: string) {
  return `${prefix}_${createHash('sha256').update(`board-demo:${key}`).digest('hex').slice(0, 32)}`;
}

export function demoNotes(large = false) {
  type Note = typeof schema.notes.$inferInsert & {
    tags: string[];
    title: string;
    content: string;
    propertyValues: Record<string, string>;
  };
  const records: Note[] = [];
  const add = (key: string, title: string, tags: string[], extra: Partial<Note> = {}) =>
    records.push({
      id: stableId('note', key),
      folderId: DEMO_FOLDER_ID,
      userId: DEMO_USERS.owner.id,
      createdByUserId: DEMO_USERS.owner.id,
      title,
      content: `# ${title}\n\nSynthetic Board Lite test note. Safe to edit; restarting the demo resets it.\n\n- [ ] Check the board card\n- [ ] Open this existing note\n`,
      documentType: 'markdown',
      type: 'note',
      createdAt: timestamp,
      updatedAt: timestamp,
      tags: ['board', 'board-lite', ...tags],
      propertyValues: {
        [DEMO_PROPERTY_DEFINITIONS[0].id]: DEMO_PROPERTY_DEFINITIONS[0].options[0].id,
        [DEMO_TYPE_DEFINITION.id]: DEMO_TYPE_DEFINITION.options[2].id,
        [DEMO_PROPERTY_DEFINITIONS[1].id]: 'Synthetic property; independent of board grouping and tags',
        [DEMO_PROPERTY_DEFINITIONS[2].id]: '2026-10-31',
      },
      ...extra,
    });
  // Ordinary synthetic note tags are intentionally independent of property grouping.
  for (const lane of [
    { key: 'backlog', label: 'Backlog', tag: 'status-backlog' },
    { key: 'todo', label: 'Todo', tag: 'status-todo' },
    { key: 'in-progress', label: 'In progress', tag: 'status-in-progress' },
    { key: 'in-review', label: 'In review', tag: 'status-in-review' },
    { key: 'done', label: 'Done', tag: 'status-done' },
  ])
    for (const index of [1, 2])
      add(
        `${lane.key}-${index}`,
        `${lane.label} example ${index}`,
        [lane.tag, index === 1 ? 'feature' : 'maintenance'],
        {
          propertyValues: {
            [DEMO_PROPERTY_DEFINITIONS[0].id]:
              DEMO_PROPERTY_DEFINITIONS[0].options[
                lane.key === 'done' ? 2 : ['in-progress', 'in-review'].includes(lane.key) ? 1 : 0
              ].id,
            [DEMO_TYPE_DEFINITION.id]: DEMO_TYPE_DEFINITION.options[index - 1].id,
          },
        }
      );
  add('no-status', 'Unclassified: no status', ['feature'], { propertyValues: {} });
  add('multiple-status', 'Unclassified: conflicting statuses', ['status-todo', 'status-done'], { propertyValues: {} });
  add('canvas', 'Canvas planning example', ['status-done'], {
    documentType: 'canvas.default',
    content: '{"nodes":[],"edges":[]}',
    propertyValues: {
      [DEMO_PROPERTY_DEFINITIONS[0].id]: DEMO_PROPERTY_DEFINITIONS[0].options[2].id,
      [DEMO_TYPE_DEFINITION.id]: DEMO_TYPE_DEFINITION.options[2].id,
    },
  });
  add('blocked', 'Blocked: waiting for review', ['status-todo', 'blocked', 'feature']);
  add('long', `Long title: ${'representative board context '.repeat(8)}`, [
    'status-todo',
    'long-label-'.repeat(15).replace(/-$/, ''),
  ]);
  add('template', 'Excluded: template', ['status-todo'], {
    type: 'template',
    folderId: DEMO_TEMPLATE_FOLDER_ID,
    content: '# {{title}}\n\nReviewed at {{datetime}}\n\n- [ ] Acceptance criteria\n',
  });
  add('content-template', 'Content-only template', [], {
    type: 'template',
    folderId: DEMO_TEMPLATE_FOLDER_ID,
    content: '# {{title}}\n\nContent-only legacy template\n',
    tags: [],
  });
  add('trash', 'Excluded: trashed note', ['status-todo'], { deletedAt: timestamp, trashBatchId: 'demo-trash' });
  add('child', 'Excluded: child-folder note', ['status-todo'], { folderId: DEMO_CHILD_ID });
  add('missing-include', 'Excluded: missing board tag', ['status-todo'], { tags: ['board-lite', 'status-todo'] });
  add('excluded-tag', 'Excluded: exclusion tag', ['status-todo', 'demo-excluded']);
  add('other-owner', 'Excluded: other owner', ['status-todo'], {
    userId: DEMO_USERS.other.id,
    createdByUserId: DEMO_USERS.other.id,
    folderId: DEMO_OTHER_FOLDER_ID,
  });
  if (large)
    for (let index = 1; index <= 150; index++)
      add(`large-${index}`, `Pagination card ${String(index).padStart(3, '0')}`, ['status-todo', 'pagination']);
  return records;
}

/** Only called with the launcher-created disposable database, never an application DB target. */
export async function seedBoardDemo(client: Client, large = false) {
  const count = await client.execute('SELECT count(*) AS count FROM user');
  if (Number(count.rows[0].count) !== 0) throw new Error('Demo seeding requires a fresh, empty database');
  const db = drizzle(client, { schema });
  const records = demoNotes(large);
  await db.transaction(async (tx) => {
    await tx.insert(schema.user).values(
      Object.values(DEMO_USERS).map((user) => ({
        ...user,
        emailVerified: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      }))
    );
    await tx.insert(schema.folders).values(
      [
        { id: DEMO_ROOT_ID, userId: DEMO_USERS.owner.id, title: 'Board Lite demo workspace' },
        { id: DEMO_FOLDER_ID, userId: DEMO_USERS.owner.id, parentFolderId: DEMO_ROOT_ID, title: 'Board Lite demo' },
        {
          id: DEMO_CHILD_ID,
          userId: DEMO_USERS.owner.id,
          parentFolderId: DEMO_FOLDER_ID,
          title: 'Child folder (not on board)',
        },
        { id: DEMO_OTHER_FOLDER_ID, userId: DEMO_USERS.other.id, title: 'Other tenant (not shared)' },
        {
          id: DEMO_TEMPLATE_FOLDER_ID,
          userId: DEMO_USERS.owner.id,
          title: 'Private template storage',
          isPrivate: true,
        },
      ].map((folder) => ({ ...folder, createdAt: timestamp, updatedAt: timestamp }))
    );
    await tx.insert(schema.collaborationGrants).values(
      ['viewer', 'commenter', 'editor'].map((role) => ({
        id: `grant_demo_${role}`,
        ownerUserId: DEMO_USERS.owner.id,
        granteeUserId: DEMO_USERS[role as 'viewer' | 'commenter' | 'editor'].id,
        folderId: DEMO_ROOT_ID,
        role: role as 'viewer' | 'commenter' | 'editor',
        createdByUserId: DEMO_USERS.owner.id,
        createdAt: timestamp,
        updatedAt: timestamp,
      }))
    );
    await tx.insert(schema.notes).values(records.map(({ tags: _tags, propertyValues: _values, ...note }) => note));
    const tagRows = new Map<string, typeof schema.tags.$inferInsert>();
    const noteTagRows: Array<typeof schema.noteTags.$inferInsert> = [];
    for (const note of records)
      for (const name of note.tags) {
        const tagId = stableId('tag', `${note.userId}:${name}`);
        tagRows.set(tagId, {
          id: tagId,
          userId: note.userId,
          name,
          normalizedName: name,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        noteTagRows.push({
          id: stableId('note_tag', `${note.id}:${name}`),
          userId: note.userId,
          noteId: note.id,
          tagId,
          createdAt: timestamp,
        });
      }
    await tx.insert(schema.tags).values([...tagRows.values()]);
    await tx.insert(schema.noteTags).values(noteTagRows);
    await tx.insert(schema.folderPropertySchemas).values({
      folderId: DEMO_FOLDER_ID,
      userId: DEMO_USERS.owner.id,
      schemaId: stableId('property_schema', 'board'),
      revision: 1,
      definitions: JSON.stringify(DEMO_PROPERTY_DEFINITIONS),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const childDefinitions = mutatePropertyDefinitions(
      [],
      { type: 'add', label: 'Child text', fieldType: 'text' },
      (prefix) => stableId(prefix, 'child-text')
    );
    await tx.insert(schema.folderPropertySchemas).values({
      folderId: DEMO_CHILD_ID,
      userId: DEMO_USERS.owner.id,
      schemaId: stableId('property_schema', 'child'),
      revision: 1,
      definitions: JSON.stringify(childDefinitions),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await tx.insert(schema.templateDefaultState).values({
      templateId: DEMO_TEMPLATE_ID,
      userId: DEMO_USERS.owner.id,
      revision: 1,
      tags: JSON.stringify(['board', 'board-lite', 'status-todo', 'feature']),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await tx.insert(schema.templateFolderAssignments).values([
      {
        id: stableId('template_folder', 'board'),
        templateId: DEMO_TEMPLATE_ID,
        folderId: DEMO_FOLDER_ID,
        userId: DEMO_USERS.owner.id,
        defaultsRevision: 1,
        schemaId: stableId('property_schema', 'board'),
        propertyDefaults: JSON.stringify({
          [DEMO_PROPERTY_DEFINITIONS[0].id]: DEMO_PROPERTY_DEFINITIONS[0].options[0].id,
          [DEMO_PROPERTY_DEFINITIONS[1].id]: 'Prepared from template',
          [DEMO_PROPERTY_DEFINITIONS[2].id]: '2026-10-31',
          [DEMO_TYPE_DEFINITION.id]: DEMO_TYPE_DEFINITION.options[2].id,
        }),
      },
      {
        id: stableId('template_folder', 'child'),
        templateId: DEMO_TEMPLATE_ID,
        folderId: DEMO_CHILD_ID,
        userId: DEMO_USERS.owner.id,
        defaultsRevision: 1,
        schemaId: stableId('property_schema', 'child'),
        propertyDefaults: JSON.stringify({ [childDefinitions[0].id]: 'Different destination default' }),
      },
      {
        id: stableId('template_folder', 'content'),
        templateId: DEMO_CONTENT_TEMPLATE_ID,
        folderId: DEMO_FOLDER_ID,
        userId: DEMO_USERS.owner.id,
      },
    ]);
    await tx.insert(schema.notePropertyState).values(
      records
        .filter((note) => note.folderId === DEMO_FOLDER_ID && note.type === 'note')
        .map((note) => ({
          noteId: note.id,
          userId: note.userId,
          revision: 1,
          values: JSON.stringify(note.propertyValues),
          createdAt: timestamp,
          updatedAt: timestamp,
        }))
    );
    await tx.insert(schema.folderBoardViews).values(
      [DEMO_FOLDER_ID, DEMO_OTHER_FOLDER_ID].map((folderId) => ({
        folderId,
        userId: folderId === DEMO_FOLDER_ID ? DEMO_USERS.owner.id : DEMO_USERS.other.id,
        config: JSON.stringify(folderId === DEMO_FOLDER_ID ? DEMO_CONFIG : DEMO_OTHER_CONFIG),
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      }))
    );
  });
  return { notes: records.length, visibleCards: large ? 167 : 17, todoCards: large ? 158 : 8 };
}
