import { DEFAULT_BOARD_CONFIG, type SelectBoardConfig } from '../src/shared/board';
import { setupPropertiesTest } from './properties-fixtures';

export { cleanupPropertiesTests as cleanupPropertyBoardTests } from './properties-fixtures';

export async function setupPropertyBoardTest() {
  const f = await setupPropertiesTest();
  const schema = await f.addField('Workflow', 'select', ['Todo', 'Done', 'Empty', 'Retired']);
  const field = schema.definitions[0];
  const config: SelectBoardConfig = {
    ...DEFAULT_BOARD_CONFIG,
    schemaVersion: 5,
    grouping: { type: 'select', schemaId: schema.schemaId as string, propertyId: field.id },
  };
  const token = { schemaId: schema.schemaId as string, schemaRevision: schema.revision };
  const saveSelect = (input: unknown = config, expectedVersion = 0, actor = 'owner', reviewed = token) =>
    f.app.request('/internal/folders/board/board/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-user': actor },
      body: JSON.stringify({ config: input, expectedVersion, ...reviewed }),
    });
  const laneUrl = (lane: string, revision = schema.revision, version = 1, extra = '') =>
    `/internal/folders/board/board?lane=${encodeURIComponent(lane)}&version=${version}&schemaId=${schema.schemaId}&schemaRevision=${revision}${extra}`;
  const addType = async () => {
    const current = await f.addField('Type', 'select', ['Bug', 'Feature', 'Task'], 'board', 1);
    const typeField = current.definitions[1];
    return {
      typeField,
      config: { ...config, cardPropertyIds: [typeField.id] },
      token: { schemaId: current.schemaId as string, schemaRevision: current.revision },
    };
  };
  return { ...f, propertySchema: schema, field, config, token, saveSelect, laneUrl, addType };
}
