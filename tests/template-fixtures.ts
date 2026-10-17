import { setupPropertiesTest } from './properties-fixtures';

export { cleanupPropertiesTests as cleanupTemplateTests } from './properties-fixtures';
export async function setupTemplateTest() {
  const f = await setupPropertiesTest();
  const templates = await import('../src/api/notes/templates');
  await f.addNote('template', 'Feature', [], {
    type: 'template',
    folderId: 'other',
    content: '{{title}} {{date}} {{time}} {{datetime}}\n[[Target]]',
  });
  await templates.saveTemplateMembership(f.actor, 'template', { folderIds: ['board', 'child'] });
  return { ...f, templates };
}
