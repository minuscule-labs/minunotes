import { Hono } from 'hono';
import { cleanupBoardTests, setupBoardTest } from './board-fixtures';
export const cleanupPropertiesTests = cleanupBoardTests;
export async function setupPropertiesTest() {
  const f = await setupBoardTest(43);
  const properties = await import('../src/api/notes/properties');
  const { noteRoutes } = await import('../src/api/routes/notes');
  const app = new Hono<{ Variables: { user: { id: string } | null; session: null } }>();
  app.use('*', async (c, next) => {
    const actor = c.req.header('x-user') ?? 'owner';
    c.set('user', actor === 'anonymous' ? null : { id: actor });
    c.set('session', null);
    await next();
  });
  app.route('/internal/notes', noteRoutes);
  app.route('/internal/folders', (await import('../src/api/routes/folders')).folderRoutes);
  const actor = { actorUserId: 'owner' };
  const addField = (
    label = 'Status',
    fieldType = 'select',
    options = ['Todo', 'Done'],
    folderId = 'board',
    expectedRevision = 0
  ) =>
    properties.mutateFolderProperties(actor, folderId, {
      expectedRevision,
      mutation: { type: 'add', label, fieldType, ...(fieldType === 'select' ? { options } : {}) },
    });
  const patch = async (noteId: string, values: Record<string, string | null>, extra: Record<string, unknown> = {}) => {
    const current = await properties.readNoteProperties(actor, noteId);
    return properties.patchNoteProperties(actor, noteId, {
      schemaId: current.schema.schemaId,
      schemaRevision: current.schema.revision,
      expectedRevision: current.revision,
      values,
      ...extra,
    });
  };
  return { ...f, app, properties, actor, addField, patch };
}
