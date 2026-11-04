import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { setupBoardTest } from './board-fixtures';
import { cleanupPropertiesTests, setupPropertiesTest } from './properties-fixtures';

afterEach(cleanupPropertiesTests);

import app from '../src/api/index';
import { mcpRoutes } from '../src/api/routes/mcp';

function oauthAuthorization() {
  const now = new Date();
  return {
    id: 'oauth_auth_test',
    integrationAuthorizationId: 'oauth_auth_test',
    userId: 'user_test',
    clientId: 'oauth_client_test',
    scope: 'notes.read',
    accessMode: 'all' as const,
    canRead: true,
    canCreate: false,
    canEdit: false,
    canComment: false,
    canCreateFolders: false,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
    revokedAt: null,
  };
}

describe('hosted MCP route', () => {
  it('exposes scoped owner template authoring, assignments and independent defaults through hosted OAuth', async () => {
    const f = await setupPropertiesTest();
    const auth = {
      id: 'template-manager',
      userId: 'owner',
      accessMode: 'all' as const,
      sharedAccessMode: 'none' as const,
      canRead: true,
      canCreate: true,
      canEdit: true,
      canComment: false,
      createdAt: f.now,
      updatedAt: f.now,
    };
    await f.db.insert(f.schema.integrationAuthorizations).values(auth);
    const credential = {
      ...auth,
      id: 'template-oauth',
      integrationAuthorizationId: auth.id,
      clientId: 'client',
      scope: 'notes.read notes.create notes.edit',
    };
    const local = new Hono();
    local.use('*', async (c, next) => {
      c.set('user', { id: 'owner' });
      c.set('session', null);
      c.set('apiKey', null);
      c.set('oauthAuthorization', credential);
      await next();
    });
    local.route('/mcp', (await import('../src/api/routes/mcp')).mcpRoutes);
    const call = async (name: string, args: unknown) =>
      (
        await local.request('/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: 'Bearer synthetic',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
        })
      ).json();
    const made = (await call('notes_create_template', { folderId: 'other', title: 'Managed', markdown: '{{title}}' }))
      .result.structuredContent.result;
    const templateId = made.template.id;
    expect(
      (await call('notes_list_template_library', { folderId: 'other', limit: 1 })).result.structuredContent.result
        .templates[0].id
    ).toBe(templateId);
    expect((await call('notes_read_template', { templateId })).result.structuredContent.result.contentHash).toBe(
      made.contentHash
    );
    const changed = await call('notes_update_template', {
      templateId,
      expectedTitle: 'Managed',
      baseHash: made.contentHash,
      title: 'Renamed',
      markdown: '{{date}}',
    });
    expect(changed.result.structuredContent.result.template.title).toBe('Renamed');
    const settings = (await call('notes_read_template_settings', { templateId })).result.structuredContent.result;
    expect(
      (
        await call('notes_set_template_assignment', {
          templateId,
          folderId: 'board',
          assigned: true,
          snapshot: settings.membershipSnapshot,
        })
      ).result.structuredContent.result.ok
    ).toBe(true);
    expect(
      (await call('notes_set_template_tags', { templateId, expectedRevision: settings.revision, tags: ['feature'] }))
        .result.structuredContent.result.tags
    ).toEqual(['feature']);
    const updated = (await call('notes_read_template_settings', { templateId })).result.structuredContent.result;
    const a = updated.assignments[0];
    expect(
      (
        await call('notes_set_template_property_defaults', {
          templateId,
          folderId: 'board',
          assignmentId: a.id,
          expectedRevision: a.revision,
          schemaId: null,
          schemaRevision: 0,
          values: {},
        })
      ).result.structuredContent.result.revision
    ).toBe(1);
    credential.canEdit = false;
    const denied = await call('notes_set_template_tags', { templateId, expectedRevision: 1, tags: [] });
    expect(denied.result.isError).toBe(true);
    expect((await call('notes_read_template_settings', { templateId })).result.structuredContent.result.tags).toEqual([
      'feature',
    ]);
  });
  it('uses owner-scoped structure commands through hosted MCP and preserves copy error uncertainty', async () => {
    const f = await setupBoardTest(44);
    await f.addNote('task', 'Task', [], { isApiEditable: true });
    const auth = {
      id: 'structure-auth',
      userId: 'owner',
      canRead: true,
      canEdit: true,
      canCreate: true,
      canComment: false,
      canCreateFolders: true,
      accessMode: 'all' as const,
      sharedAccessMode: 'none' as const,
      createdAt: f.now,
      updatedAt: f.now,
    };
    await f.db.insert(f.schema.integrationAuthorizations).values(auth);
    const credential = {
      ...auth,
      id: 'oauth',
      integrationAuthorizationId: auth.id,
      clientId: 'client',
      scope: 'notes.read notes.edit notes.create folders.create',
    };
    const local = new Hono();
    local.use('*', async (c, next) => {
      c.set('user', { id: 'owner' });
      c.set('session', null);
      c.set('apiKey', null);
      c.set('oauthAuthorization', credential);
      await next();
    });
    local.route('/mcp', (await import('../src/api/routes/mcp')).mcpRoutes);
    const call = async (name: string, args: unknown) =>
      (
        await local.request('/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: 'Bearer synthetic',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
        })
      ).json();
    expect(
      (await call('notes_rename_folder', { folderId: 'board', title: 'Renamed', expectedTitle: 'Board' })).result
        .structuredContent.result.folder.title
    ).toBe('Renamed');
    expect(
      (
        await call('notes_move_folder', {
          folderId: 'board',
          parentFolderId: 'other',
          expectedParentFolderId: 'root',
          confirm: true,
        })
      ).result.structuredContent.result.folder.parentFolderId
    ).toBe('other');
    const p = (await call('notes_preview_folder_duplication', { folderId: 'board', parentFolderId: null })).result
      .structuredContent.result;
    const payload = {
      folderId: 'board',
      title: 'Copy',
      parentFolderId: null,
      requestId: 'fixed_request_0001',
      previewToken: p.token,
      confirm: true,
    };
    const copy = await call('notes_duplicate_folder', payload);
    expect(copy.result.structuredContent.result.replayed).toBe(false);
    expect((await call('notes_duplicate_folder', payload)).result.structuredContent.result.replayed).toBe(true);
    credential.canCreateFolders = false;
    expect((await call('notes_duplicate_folder', payload)).result).toMatchObject({
      isError: true,
      structuredContent: { result: { status: 403, uncertain: false } },
    });
  });
  it('exposes exact-folder discovery and metadata-safe rename through the real hosted OAuth boundary', async () => {
    const f = await setupPropertiesTest();
    await f.addNote('task', 'Before', [], { isApiEditable: true });
    const auth = {
      id: 'task-auth',
      userId: 'owner',
      canRead: true,
      canEdit: true,
      canCreate: false,
      canComment: false,
      accessMode: 'all' as const,
      sharedAccessMode: 'none' as const,
      createdAt: f.now,
      updatedAt: f.now,
    };
    await f.db.insert(f.schema.integrationAuthorizations).values(auth);
    const credential = {
      ...auth,
      id: 'task-oauth',
      integrationAuthorizationId: auth.id,
      clientId: 'client',
      scope: 'notes.read notes.edit',
    };
    const local = new Hono();
    local.use('*', async (c, next) => {
      c.set('user', { id: 'owner' });
      c.set('session', null);
      c.set('apiKey', null);
      c.set('oauthAuthorization', credential);
      await next();
    });
    local.route('/mcp', (await import('../src/api/routes/mcp')).mcpRoutes);
    const call = async (name: string, args: unknown) =>
      (
        await local.request('/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: 'Bearer synthetic',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
        })
      ).json();
    const list = await call('notes_list_folder_notes', { folderId: 'board', limit: 1 });
    expect(list.result.structuredContent.result.notes).toEqual([
      expect.objectContaining({ id: 'task', title: 'Before' }),
    ]);
    expect(list.result.structuredContent.result.notes[0]).not.toHaveProperty('content');
    const rename = await call('notes_rename_note', { noteId: 'task', title: 'After', expectedTitle: 'Before' });
    expect(rename.result.structuredContent.result.note).toMatchObject({ id: 'task', title: 'After' });
    const stale = await call('notes_rename_note', { noteId: 'task', title: 'Overwrite', expectedTitle: 'Before' });
    expect(JSON.stringify(stale)).toContain('Title changed');
    const invalid = await call('notes_rename_note', {
      noteId: 'task',
      title: 'Overwrite',
      expectedTitle: 'After',
      folderId: 'other',
    });
    expect(invalid.result?.structuredContent).toBeUndefined();
    credential.canEdit = false;
    expect(
      JSON.stringify(await call('notes_rename_note', { noteId: 'task', title: 'Overwrite', expectedTitle: 'After' }))
    ).toContain('Forbidden');
    const [stored] = await f.db.select().from(f.schema.notes);
    expect(stored.title).toBe('After');
    credential.canRead = false;
    expect(JSON.stringify(await call('notes_list_folder_notes', { folderId: 'board' }))).toContain('Folder not found');
  });
  it('hosted template tools share reviewed creation, frozen receipts and OAuth create ceiling', async () => {
    const f = await setupPropertiesTest();
    await f.addNote('template', 'Feature', [], {
      type: 'template',
      folderId: 'other',
      isApiEditable: false,
      content: '{{title}} {{date}}',
    });
    const templates = await import('../src/api/notes/templates');
    await templates.saveTemplateMembership(f.actor, 'template', { folderIds: ['board'] });
    const auth = {
      id: 'authorization',
      userId: 'owner',
      canRead: true,
      canCreate: true,
      canEdit: false,
      canComment: false,
      accessMode: 'all' as const,
      sharedAccessMode: 'none' as const,
      createdAt: f.now,
      updatedAt: f.now,
    };
    await f.db.insert(f.schema.integrationAuthorizations).values(auth);
    const routes = (await import('../src/api/routes/mcp')).mcpRoutes;
    let credentialCanCreate = true;
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('user', { id: 'owner' });
      c.set('session', null);
      c.set('apiKey', null);
      c.set('oauthAuthorization', {
        ...auth,
        id: 'oauth',
        integrationAuthorizationId: auth.id,
        clientId: 'client',
        scope: 'notes.read notes.create',
        canCreate: credentialCanCreate,
      });
      await next();
    });
    app.route('/mcp', routes);
    const call = async (name: string, args: unknown) =>
      (
        await app.request('/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: 'Bearer synthetic',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
        })
      ).json();
    const list = await call('notes_list_assigned_templates', { folderId: 'board' });
    expect(list.result.structuredContent.result.templates).toEqual([{ id: 'template', title: 'Feature' }]);
    const p = (await call('notes_preview_assigned_template', { folderId: 'board', templateId: 'template' })).result
      .structuredContent.result;
    expect(JSON.stringify(p)).not.toMatch(/userId|folderId|actorId|other/);
    const input = {
      folderId: 'board',
      templateId: 'template',
      snapshot: p.snapshot,
      schemaId: p.schema.schemaId,
      schemaRevision: p.schema.revision,
      title: 'Final',
      tags: [],
      values: {},
      requestId: 'request',
      variables: { date: 'frozen', time: 't', datetime: 'dt' },
    };
    const first = await call('notes_create_from_template', input),
      second = await call('notes_create_from_template', input);
    expect(second.result.structuredContent.result.note.id).toBe(first.result.structuredContent.result.note.id);
    expect(second.result.structuredContent.result.replayed).toBe(true);
    credentialCanCreate = false;
    expect((await call('notes_create_from_template', input)).result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('(403)') }],
    });
    expect((await f.libsql.execute('select * from note_events')).rows).toHaveLength(1);
  });
  it('properties tools share OAuth ACL, structured DTO, independent CAS and validation', async () => {
    const f = await setupPropertiesTest();
    await f.addNote('n', 'N', [], { isApiEditable: true });
    const s = await f.addField('Summary', 'text');
    const auth = {
      id: 'authorization',
      userId: 'owner',
      canRead: true,
      canEdit: true,
      canCreate: false,
      canComment: false,
      accessMode: 'all' as const,
      sharedAccessMode: 'none' as const,
      createdAt: f.now,
      updatedAt: f.now,
    };
    await f.db.insert(f.schema.integrationAuthorizations).values(auth);
    const { mcpRoutes: routes } = await import('../src/api/routes/mcp');
    let credentialCanEdit = true;
    let credentialCanRead = true;
    const app = new Hono<{ Variables: Record<string, unknown> }>();
    app.use('*', async (c, next) => {
      c.set('user', { id: 'owner' });
      c.set('session', null);
      c.set('apiKey', null);
      c.set('oauthAuthorization', {
        ...auth,
        canEdit: credentialCanEdit,
        canRead: credentialCanRead,
        id: 'oauth',
        integrationAuthorizationId: auth.id,
        clientId: 'client',
        scope: 'notes.read notes.edit',
      });
      await next();
    });
    app.route('/mcp', routes);
    const call = async (name: string, args: unknown) => {
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer synthetic',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      expect(res.status).toBe(200);
      return res.json();
    };
    const read = await call('notes_read_note_properties', { noteId: 'n' });
    expect(read.result.structuredContent.result).toMatchObject({
      schema: { schemaId: s.schemaId },
      revision: 0,
      values: {},
    });
    expect(JSON.stringify(read)).not.toMatch(/folderId|userId|resourceOwner/);
    const patch = {
      noteId: 'n',
      schemaId: s.schemaId,
      schemaRevision: 1,
      expectedRevision: 0,
      values: { [s.definitions[0].id]: 'OAuth property' },
    };
    expect((await call('notes_patch_note_properties', patch)).result.structuredContent.result.revision).toBe(1);
    expect((await call('notes_patch_note_properties', patch)).result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('(409)') }],
    });
    expect(
      (await call('notes_patch_note_properties', { ...patch, expectedRevision: 1, values: { foreign: 'bad' } })).result
    ).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('(400)') }] });
    const schema = await call('notes_mutate_folder_properties', {
      folderId: 'board',
      expectedRevision: 1,
      mutation: { type: 'rename', propertyId: s.definitions[0].id, label: 'Renamed' },
    });
    expect(schema.result.structuredContent.result.definitions[0].id).toBe(s.definitions[0].id);
    // A read-only OAuth token cannot borrow the connection's broader stored edit permission.
    credentialCanEdit = false;
    expect(
      (await call('notes_patch_note_properties', { ...patch, schemaRevision: 2, expectedRevision: 1 })).result
    ).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('(403)') }] });
    expect(
      (
        await call('notes_mutate_folder_properties', {
          folderId: 'board',
          expectedRevision: 2,
          mutation: { type: 'archive', propertyId: s.definitions[0].id },
        })
      ).result
    ).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('(403)') }] });
    expect((await call('notes_read_note_properties', { noteId: 'n' })).result.structuredContent.result.revision).toBe(
      1
    );
    credentialCanRead = false;
    expect((await call('notes_read_note_properties', { noteId: 'n' })).result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('(403)') }],
    });
    credentialCanEdit = true;
    credentialCanRead = true;
    await f.libsql.execute("update integration_authorizations set can_edit=0 where id='authorization'");
    expect(
      (await call('notes_patch_note_properties', { ...patch, schemaRevision: 2, expectedRevision: 1 })).result
    ).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('(403)') }] });
  });
  it('requires authentication', async () => {
    const response = await app.request('/mcp', { method: 'POST' });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('/mcp/.well-known/oauth-protected-resource');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('rejects API-key auth on hosted MCP', async () => {
    const response = await app.request('/mcp', { method: 'POST', headers: { 'x-api-key': 'ntak_invalid' } });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('serves OAuth protected resource metadata for MCP', async () => {
    const response = await app.request('/mcp/.well-known/oauth-protected-resource');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      resource: 'http://localhost/mcp',
      authorization_servers: ['http://localhost'],
      bearer_methods_supported: ['header'],
    });
  });

  it('lists the expanded tool set over streamable HTTP with OAuth bearer auth', async () => {
    const testApp = new Hono();
    testApp.use('*', async (c, next) => {
      c.set('user', { id: 'user_test', name: 'Test User', email: 'test@example.com' });
      c.set('session', null);
      c.set('apiKey', null);
      c.set('oauthAuthorization', oauthAuthorization());
      await next();
    });
    testApp.route('/mcp', mcpRoutes);

    const response = await testApp.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer mnoac_test',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    const toolNames = body.result.tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'notes_move_notes',
        'notes_trash_note',
        'notes_trash_folder',
        'notes_create_canvas',
        'notes_create_canvas_from_syntax',
        'notes_replace_canvas',
        'notes_replace_canvas_from_syntax',
        'notes_set_canvas_node_note_link',
        'notes_remove_canvas_node_note_link',
        'notes_read_outline',
        'notes_read_events',
        'notes_list_tags',
        'notes_read_note_tags',
        'notes_replace_note_tags',
      ])
    );
    expect(toolNames.filter((name: string) => /restore|permanent.*delete/i.test(name))).toEqual([]);
  });

  it('calls a new read tool through the hosted OAuth adapter', async () => {
    const testApp = new Hono();
    testApp.use('*', async (c, next) => {
      c.set('user', { id: 'user_test', name: 'Test User', email: 'test@example.com' });
      c.set('session', null);
      c.set('apiKey', null);
      c.set('oauthAuthorization', oauthAuthorization());
      await next();
    });
    testApp.route('/mcp', mcpRoutes);

    const response = await testApp.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer mnoac_test',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'notes_list_tags', arguments: {} },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        structuredContent: { result: { tags: [] } },
      },
    });
  });

  it('propagates hosted OAuth write permission failures through a new canvas tool', async () => {
    const testApp = new Hono();
    testApp.use('*', async (c, next) => {
      c.set('user', { id: 'user_test', name: 'Test User', email: 'test@example.com' });
      c.set('session', null);
      c.set('apiKey', null);
      c.set('oauthAuthorization', oauthAuthorization());
      await next();
    });
    testApp.route('/mcp', mcpRoutes);

    const response = await testApp.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer mnoac_test',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'notes_create_canvas',
          arguments: { folderId: 'folder_forbidden', canvas: { nodes: [], edges: [] } },
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        isError: true,
        content: [{ type: 'text', text: expect.stringContaining('Forbidden (403)') }],
      },
    });
  });

  it('fails closed when the OAuth actor is missing its shared authorization id', async () => {
    const testApp = new Hono();
    testApp.use('*', async (c, next) => {
      c.set('user', { id: 'user_test', name: 'Test User', email: 'test@example.com' });
      c.set('session', null);
      c.set('apiKey', null);
      c.set('oauthAuthorization', { ...oauthAuthorization(), integrationAuthorizationId: '' });
      await next();
    });
    testApp.route('/mcp', mcpRoutes);

    const response = await testApp.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer mnoac_test',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'notes_create_canvas',
          arguments: { folderId: 'folder_forbidden', canvas: { nodes: [], edges: [] } },
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        isError: true,
        content: [{ type: 'text', text: expect.stringContaining('Forbidden (403)') }],
      },
    });
  });

  it('serves MCP initialize over streamable HTTP with OAuth bearer auth', async () => {
    const testApp = new Hono();
    testApp.use('*', async (c, next) => {
      c.set('user', { id: 'user_test', name: 'Test User', email: 'test@example.com' });
      c.set('session', null);
      c.set('apiKey', null);
      c.set('oauthAuthorization', oauthAuthorization());
      await next();
    });
    testApp.route('/mcp', mcpRoutes);

    const response = await testApp.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer mnoac_test',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '0.1.0' },
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { serverInfo: { name: 'minunotes', version: '0.1.0' } },
    });
  });
});
