import { createHash } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  mutatePropertyDefinitions,
  type NoteProperties,
  type OptionDeletionPreview,
  type OptionDeletionRequest,
  type PropertyPatch,
  type PropertySchema,
  parseOptionDeletion,
  patchPropertyValues,
  removePropertyOption,
} from '../../src/shared/properties';
import { browserFixture, mockBrowserApi } from './fixtures';
export async function mockProperties(page: Page, role: 'owner' | 'editor' | 'viewer' | 'commenter' = 'owner') {
  const body = await mockBrowserApi(page, { noteAccessRole: role });
  await page.route(`**/internal/folders/${browserFixture.folder.id}/templates`, (route) =>
    route.fulfill({ json: { templates: [browserFixture.template] } })
  );
  let next = 0;
  const id = (prefix: string) => `${prefix}_browser_${++next}`;
  let schema: PropertySchema = { schemaId: 'schema_browser', revision: 1, definitions: [] };
  schema.definitions = mutatePropertyDefinitions(
    schema.definitions,
    { type: 'add', label: 'Summary', fieldType: 'text' },
    id
  );
  schema.definitions = mutatePropertyDefinitions(
    schema.definitions,
    { type: 'add', label: 'Status', fieldType: 'select', options: ['Todo', 'Done'] },
    id
  );
  schema.definitions = mutatePropertyDefinitions(
    schema.definitions,
    { type: 'add', label: 'Due date', fieldType: 'date' },
    id
  );
  const state = new Map<string, { revision: number; values: Record<string, string> }>();
  const saves: PropertyPatch[] = [];
  const patches: PropertyPatch[] = [];
  const schemaSaves: unknown[] = [];
  const templateDefaults = new Map<string, { revision: number; values: Record<string, string> }>();
  const optionDeletions: Array<OptionDeletionRequest & { propertyId: string; optionId: string }> = [];
  const deletionAttempts: unknown[] = [];
  const controls = { conflictNext: false, deny: false, failNext: false, loseResponseNext: false };
  type Hold = { phase: 'before' | 'after'; reached: () => void; released: Promise<void> };
  let nextHold: Hold | null = null;
  let active = 0;
  let maxActive = 0;
  const patchResources: string[] = [];
  const holdNext = (phase: Hold['phase']) => {
    let reached = () => {};
    let release = () => {};
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    nextHold = { phase, reached, released };
    return { started, release };
  };
  await page.route('**/internal/**/properties', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      isNote = url.pathname.includes('/notes/');
    const resource = url.pathname.split('/').at(-2) as string;
    const writing = isNote && request.method() === 'PATCH';
    const hold = writing ? nextHold : null;
    if (writing) {
      nextHold = null;
      patches.push(request.postDataJSON());
      patchResources.push(resource);
      active++;
      maxActive = Math.max(maxActive, active);
    }
    const json = async (value: unknown, status = 200) => {
      const responseBody = JSON.stringify(value);
      if (writing && status === 200 && hold?.phase === 'after') {
        hold.reached();
        await hold.released;
      }
      if (writing && status === 200 && controls.loseResponseNext) {
        controls.loseResponseNext = false;
        return route.abort('failed');
      }
      return route.fulfill({ status, contentType: 'application/json', body: responseBody });
    };
    const handle = async () => {
      if (hold?.phase === 'before') {
        hold.reached();
        await hold.released;
      }
      if (controls.deny) return json({ error: 'Not found' }, 404);
      if (request.method() === 'GET') {
        if (!isNote) return json(schema);
        const current = state.get(resource) ?? { revision: 0, values: {} };
        return json({
          schema: { ...schema, definitions: schema.definitions.filter((d) => !d.archived) },
          ...current,
        } satisfies NoteProperties);
      }
      if (controls.failNext) {
        controls.failNext = false;
        return json({ error: 'Temporary failure' }, 500);
      }
      if (controls.conflictNext) {
        controls.conflictNext = false;
        return json({ error: 'Properties changed' }, 409);
      }
      const input = request.postDataJSON();
      if (!isNote) {
        if (role !== 'owner') return json({ error: 'Forbidden' }, 403);
        if (input.expectedRevision !== schema.revision) return json({ error: 'Schema changed' }, 409);
        try {
          schema = {
            ...schema,
            revision: schema.revision + 1,
            definitions: mutatePropertyDefinitions(schema.definitions, input.mutation, id),
          };
          schemaSaves.push(input);
          return json(schema);
        } catch (e) {
          return json({ error: (e as Error).message }, 400);
        }
      }
      const current = state.get(resource) ?? { revision: 0, values: {} };
      if (role !== 'owner' && role !== 'editor') return json({ error: 'Forbidden' }, 403);
      if (
        input.schemaId !== schema.schemaId ||
        input.schemaRevision !== schema.revision ||
        input.expectedRevision !== current.revision
      )
        return json({ error: 'Properties changed' }, 409);
      try {
        const values = patchPropertyValues(current.values, schema.definitions, input.values);
        const result = { revision: current.revision + 1, values };
        state.set(resource, result);
        saves.push(input);
        return json({ schema: { ...schema, definitions: schema.definitions.filter((d) => !d.archived) }, ...result });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    };
    try {
      return await handle();
    } finally {
      if (writing) active--;
    }
  });
  await page.route(`**/internal/folders/${browserFixture.folder.id}/properties/*/options/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.split('/');
    const propertyId = path[5],
      optionId = path[7];
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (controls.deny) return json({ error: 'Not found' }, 404);
    if (role !== 'owner') return json({ error: 'Forbidden' }, 403);
    try {
      const definitions = removePropertyOption(schema.definitions, propertyId, optionId);
      const field = schema.definitions.find((d) => d.id === propertyId);
      const option = field?.options.find((o) => o.id === optionId);
      if (!field || !option || !schema.schemaId) return json({ error: 'Not found' }, 404);
      const notes = [...state]
        .filter(([, s]) => s.values[propertyId] === optionId)
        .sort(([a], [b]) => a.localeCompare(b));
      const defaults = [...templateDefaults]
        .filter(([, s]) => s.values[propertyId] === optionId)
        .sort(([a], [b]) => a.localeCompare(b));
      const preview: OptionDeletionPreview = {
        schemaId: schema.schemaId,
        expectedRevision: schema.revision,
        propertyId,
        optionId,
        propertyLabel: field.label,
        optionLabel: option.label,
        noteCount: notes.length,
        templateDefaultCount: defaults.length,
        impactToken: createHash('sha256')
          .update(
            JSON.stringify([
              schema.schemaId,
              schema.revision,
              propertyId,
              optionId,
              notes.map(([id, s]) => [id, s.revision]),
              defaults.map(([id, s]) => [id, s.revision]),
            ])
          )
          .digest('hex'),
      };
      if (request.method() === 'GET' && path.at(-1) === 'deletion-preview') return json(preview);
      if (request.method() !== 'DELETE') return route.fallback();
      deletionAttempts.push(request.postDataJSON());
      const input = parseOptionDeletion(request.postDataJSON());
      if (controls.failNext) {
        controls.failNext = false;
        return json({ error: 'Temporary failure' }, 500);
      }
      if (
        controls.conflictNext ||
        input.schemaId !== schema.schemaId ||
        input.expectedRevision !== schema.revision ||
        input.impactToken !== preview.impactToken
      ) {
        controls.conflictNext = false;
        return json({ error: 'Deletion impact changed; review again before confirming' }, 409);
      }
      schema = { ...schema, revision: schema.revision + 1, definitions };
      for (const [id, s] of notes) {
        const values = { ...s.values };
        delete values[propertyId];
        state.set(id, { revision: s.revision + 1, values });
      }
      for (const [id, s] of defaults) {
        const values = { ...s.values };
        delete values[propertyId];
        templateDefaults.set(id, { revision: s.revision + 1, values });
      }
      optionDeletions.push({ ...input, propertyId, optionId });
      if (controls.loseResponseNext) {
        controls.loseResponseNext = false;
        return route.abort('failed');
      }
      return json(schema);
    } catch (error) {
      return json({ error: (error as Error).message }, (error as { status?: number }).status ?? 400);
    }
  });
  return {
    body,
    state,
    templateDefaults,
    optionDeletions,
    deletionAttempts,
    saves,
    patches,
    schemaSaves,
    controls,
    holdNext,
    patchResources,
    get active() {
      return active;
    },
    get maxActive() {
      return maxActive;
    },
    get schema() {
      return schema;
    },
    changeSchema: () => {
      schema = { ...schema, revision: schema.revision + 1 };
    },
    fixture: browserFixture,
  };
}
