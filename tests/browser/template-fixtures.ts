import type { Page } from '@playwright/test';
import type { PropertyError } from '../../src/shared/properties';
import {
  renderTemplate,
  type TemplateCreation,
  type TemplateDefaults,
  type TemplatePreview,
  templateTags,
  templateValues,
} from '../../src/shared/templates';
import { browserFixture } from './fixtures';
import { mockProperties } from './properties-fixtures';
export async function mockTemplates(page: Page, role: 'owner' | 'editor' | 'viewer' | 'commenter' = 'owner') {
  const f = await mockProperties(page, role);
  const template = f.body.notes.get(browserFixture.template.id);
  if (!template) throw new Error('Missing template fixture');
  template.content = '{{title}} {{date}} {{time}} {{datetime}}';
  const folderId = browserFixture.folder.id,
    templateId = browserFixture.template.id;
  const defaultValues = {
    [f.schema.definitions[0].id]: 'Prepared',
    [f.schema.definitions[1].id]: f.schema.definitions[1].options[0].id,
  };
  let defaults: TemplateDefaults = {
    revision: 0,
    tags: ['feature'],
    assignments: [
      {
        id: 'assignment',
        folderId,
        title: browserFixture.folder.title,
        revision: 0,
        schemaId: f.schema.schemaId,
        values: defaultValues,
      },
      {
        id: 'second-assignment',
        folderId: 'folder_second',
        title: 'Second destination',
        revision: 0,
        schemaId: 'second-schema',
        values: {},
      },
    ],
  };
  let snapshot = 'snapshot-1';
  const controls = { conflictNext: false, failNext: false, deny: false, loseResponse: false, delay: 0 };
  const creates: TemplateCreation[] = [],
    tagSaves: unknown[] = [],
    defaultSaves: unknown[] = [],
    previewReads: string[] = [],
    schemaReads: string[] = [];
  const receipts = new Map<string, { fingerprint: string; noteId: string }>();
  await page.route('**/internal/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname,
      method = req.method();
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: data });
    if (path === `/internal/folders/${folderId}/detail`)
      return json({
        folder: browserFixture.folder,
        ancestors: [],
        childFolders: [],
        access: { role, source: role === 'owner' ? 'owner' : 'folder_grant' },
        sharedBy: null,
      });
    if (path === `/internal/folders/${folderId}/templates`)
      return role === 'viewer' || role === 'commenter'
        ? json({ error: 'Forbidden' }, 403)
        : json({ templates: [{ id: templateId, title: browserFixture.template.title }] });
    if (path === `/internal/folders/${folderId}/templates/${templateId}/preview`) {
      previewReads.push(path);
      if (controls.deny) return json({ error: 'Not found' }, 404);
      if (controls.failNext) {
        controls.failNext = false;
        return json({ error: 'Temporary failure' }, 500);
      }
      return json({
        template: { id: templateId, title: browserFixture.template.title, body: template.content },
        tags: defaults.tags,
        values: defaults.assignments[0].values,
        schema: { ...f.schema, definitions: f.schema.definitions.filter((d) => !d.archived) },
        snapshot,
      } satisfies TemplatePreview);
    }
    if (path === `/internal/notes/templates/${templateId}/defaults`) {
      if (controls.deny) return json({ error: 'Not found' }, 404);
      if (method === 'GET') return json(defaults);
      const input = req.postDataJSON();
      if (controls.conflictNext || input.expectedRevision !== defaults.revision) {
        controls.conflictNext = false;
        return json({ error: 'Defaults changed' }, 409);
      }
      if (controls.failNext) {
        controls.failNext = false;
        return json({ error: 'Temporary failure' }, 500);
      }
      defaults = { ...defaults, tags: templateTags(input.tags), revision: defaults.revision + 1 };
      snapshot += 't';
      tagSaves.push(input);
      return json({ revision: defaults.revision, tags: defaults.tags });
    }
    if (path.includes(`/internal/notes/templates/${templateId}/folders/`) && path.endsWith('/defaults')) {
      if (controls.deny) return json({ error: 'Not found' }, 404);
      const input = req.postDataJSON(),
        a = defaults.assignments[0];
      if (
        controls.conflictNext ||
        input.expectedRevision !== a.revision ||
        input.assignmentId !== a.id ||
        input.schemaRevision !== f.schema.revision
      ) {
        controls.conflictNext = false;
        return json({ error: 'Defaults changed' }, 409);
      }
      if (controls.failNext) {
        controls.failNext = false;
        return json({ error: 'Temporary failure' }, 500);
      }
      try {
        const values = templateValues(input.values, f.schema);
        defaults.assignments[0] = { ...a, revision: a.revision + 1, values };
        snapshot += 'p';
        defaultSaves.push(input);
        return json(defaults.assignments[0]);
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }
    if (path.endsWith('/properties') && path.includes('/folders/')) {
      schemaReads.push(path);
      if (path.includes('folder_second')) return json({ schemaId: 'second-schema', revision: 1, definitions: [] });
      return route.fallback();
    }
    if (path === `/internal/folders/${folderId}/notes/from-template`) {
      const input = req.postDataJSON() as TemplateCreation;
      creates.push(input);
      if (controls.delay) await new Promise((r) => setTimeout(r, controls.delay));
      if (controls.deny) return json({ error: 'Not found' }, 404);
      if (controls.failNext) {
        controls.failNext = false;
        return json({ error: 'Temporary failure' }, 500);
      }
      const receipt = receipts.get(input.requestId);
      if (receipt)
        return receipt.fingerprint === JSON.stringify(input)
          ? json({ note: { id: receipt.noteId }, replayed: true })
          : json({ error: 'Payload changed' }, 409);
      if (controls.conflictNext || input.snapshot !== snapshot || input.schemaRevision !== f.schema.revision) {
        controls.conflictNext = false;
        return json({ error: 'Review changed' }, 409);
      }
      try {
        const values = templateValues(input.values, f.schema),
          id = 'note_from_template';
        f.body.notes.set(id, {
          ...browserFixture.source,
          id,
          folderId,
          title: input.title,
          content: renderTemplate(template.content, input.title, input.variables),
          type: 'note',
        });
        f.state.set(id, { revision: Object.keys(values).length ? 1 : 0, values });
        receipts.set(input.requestId, { fingerprint: JSON.stringify(input), noteId: id });
        if (controls.loseResponse) {
          controls.loseResponse = false;
          return route.abort('failed');
        }
        return json({ note: { id }, replayed: false }, 201);
      } catch (e) {
        return json({ error: (e as PropertyError).message }, 400);
      }
    }
    return route.fallback();
  });
  return {
    ...f,
    controls,
    creates,
    tagSaves,
    defaultSaves,
    previewReads,
    schemaReads,
    receipts,
    changeSnapshot: () => {
      snapshot += 'changed';
    },
    get defaults() {
      return defaults;
    },
  };
}
