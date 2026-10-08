import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tempDirs: string[] = [];

async function runMigrations(libsql: { executeMultiple: (sql: string) => Promise<unknown> }) {
  for (let index = 0; index <= 40; index += 1) {
    const [file] = await Array.fromAsync(
      (await import('node:fs/promises')).glob(`drizzle/${String(index).padStart(4, '0')}_*.sql`)
    );
    if (!file) throw new Error(`Missing migration ${index}`);
    await libsql.executeMultiple(await readFile(file, 'utf8'));
  }
}

async function setup() {
  vi.resetModules();
  const dir = await mkdtemp(path.join(tmpdir(), 'notes-collaboration-agents-'));
  tempDirs.push(dir);
  vi.stubEnv('TURSO_DB_URL', `file:${path.join(dir, 'test.db')}`);

  const [{ db, libsql }, schema, { harnessRoutes }] = await Promise.all([
    import('../src/api/db/client'),
    import('../src/api/db/schema'),
    import('../src/api/routes/harness'),
  ]);
  await runMigrations(libsql);

  const now = new Date();
  const owner = {
    id: 'owner',
    name: 'Owner',
    email: 'owner@example.com',
    emailVerified: true,
    image: null,
    createdAt: now,
    updatedAt: now,
  };
  const collaborator = {
    id: 'collaborator',
    name: 'Collaborator',
    email: 'collaborator@example.com',
    emailVerified: true,
    image: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(schema.user).values([owner, collaborator]);
  await db.insert(schema.folders).values([
    {
      id: 'owner_parent',
      userId: owner.id,
      parentFolderId: null,
      title: 'Owner parent',
      isPrivate: false,
      isAgentReadOnly: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'shared_folder',
      userId: owner.id,
      parentFolderId: 'owner_parent',
      title: 'Shared folder',
      isPrivate: false,
      isAgentReadOnly: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'shared_child',
      userId: owner.id,
      parentFolderId: 'shared_folder',
      title: 'Shared child',
      isPrivate: false,
      isAgentReadOnly: false,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.insert(schema.notes).values([
    {
      id: 'shared_note',
      userId: owner.id,
      folderId: 'shared_folder',
      title: 'Shared note',
      content: 'Shared content',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'future_note',
      userId: owner.id,
      folderId: 'shared_folder',
      title: 'Future note',
      content: 'Future content',
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.insert(schema.tags).values([
    {
      id: 'shared_tag',
      userId: owner.id,
      name: 'shared-tag',
      normalizedName: 'shared-tag',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'future_tag',
      userId: owner.id,
      name: 'future-tag',
      normalizedName: 'future-tag',
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.insert(schema.noteTags).values([
    { id: 'shared_note_tag', userId: owner.id, noteId: 'shared_note', tagId: 'shared_tag', createdAt: now },
    { id: 'future_note_tag', userId: owner.id, noteId: 'future_note', tagId: 'future_tag', createdAt: now },
  ]);
  await db.insert(schema.noteLinks).values([
    {
      id: 'link_to_future',
      userId: owner.id,
      sourceNoteId: 'shared_note',
      targetNoteId: 'future_note',
      targetTitle: 'Future note',
      label: null,
      linkType: 'wikilink',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'future_backlink',
      userId: owner.id,
      sourceNoteId: 'future_note',
      targetNoteId: 'shared_note',
      targetTitle: 'Shared note',
      label: null,
      linkType: 'wikilink',
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.insert(schema.collaborationGrants).values({
    id: 'shared_grant',
    ownerUserId: owner.id,
    granteeUserId: collaborator.id,
    noteId: 'shared_note',
    folderId: null,
    role: 'viewer',
    createdByUserId: owner.id,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.integrationAuthorizations).values({
    id: 'authorization',
    userId: collaborator.id,
    accessMode: 'all',
    canRead: true,
    canCreate: false,
    canEdit: false,
    canComment: false,
    canCreateFolders: false,
    sharedAccessMode: 'none',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.apiKeys).values({
    id: 'api_key',
    userId: collaborator.id,
    authorizationId: 'authorization',
    name: 'Collaborator key',
    uid: 'COLLAB01',
    hash: 'hash',
    salt: 'salt',
    createdAt: now,
    updatedAt: now,
  });

  const apiKey = {
    id: 'api_key',
    userId: collaborator.id,
    authorizationId: 'authorization',
    name: 'Collaborator key',
    uid: 'COLLAB01',
    hash: 'hash',
    salt: 'salt',
    accessMode: 'all' as const,
    canRead: true,
    canCreate: false,
    canEdit: false,
    canComment: false,
    canCreateFolders: false,
    sharedAccessMode: 'none' as const,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
    revokedAt: null,
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', collaborator);
    c.set('session', null);
    c.set('apiKey', apiKey);
    c.set('oauthAuthorization', null);
    await next();
  });
  app.route('/harness', harnessRoutes);

  return { app, db, libsql, schema, apiKey, now, collaborator, harnessRoutes };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('collaborator agent access', () => {
  it('applies the same shared-role ceilings to OAuth-backed Harness and hosted MCP operations', async () => {
    const { db, libsql, schema, now, collaborator, harnessRoutes } = await setup();
    const oauthAuthorization = {
      id: 'oauth_connection',
      userId: collaborator.id,
      integrationAuthorizationId: 'authorization',
      clientId: 'oauth_client',
      scope: 'notes.read notes.create notes.edit',
      accessMode: 'all' as const,
      canRead: true,
      canCreate: true,
      canEdit: true,
      canComment: false,
      canCreateFolders: false,
      sharedAccessMode: 'none' as 'none' | 'specific' | 'all',
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      revokedAt: null,
    };
    const oauthApp = new Hono();
    oauthApp.use('*', async (c, next) => {
      c.set('user', collaborator);
      c.set('session', null);
      c.set('apiKey', null);
      c.set('oauthAuthorization', oauthAuthorization);
      await next();
    });
    oauthApp.route('/harness', harnessRoutes);

    expect((await oauthApp.request('/harness/notes/shared_note')).status).toBe(404);
    oauthAuthorization.sharedAccessMode = 'specific';
    expect((await oauthApp.request('/harness/notes/shared_note')).status).toBe(404);
    await db.insert(schema.authorizationCollaborationScopes).values({
      id: 'oauth_scope',
      authorizationId: 'authorization',
      userId: collaborator.id,
      collaborationGrantId: 'shared_grant',
      createdAt: now,
    });
    const selected = await oauthApp.request('/harness/notes/shared_note');
    expect(selected.status).toBe(200);
    const selectedBody = (await selected.json()) as { contentHash: string };
    expect(
      (
        await oauthApp.request('/harness/notes/shared_note/trash', {
          method: 'POST',
        })
      ).status
    ).toBe(404);
    expect(
      (
        await oauthApp.request('/harness/notes/shared_note/edit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            baseHash: selectedBody.contentHash,
            edits: [{ type: 'append', text: ' blocked by viewer role' }],
          }),
        })
      ).status
    ).toBe(404);

    await db
      .update(schema.collaborationGrants)
      .set({ role: 'editor', updatedAt: new Date() })
      .where(eq(schema.collaborationGrants.id, 'shared_grant'));
    const editable = (await (await oauthApp.request('/harness/notes/shared_note')).json()) as { contentHash: string };
    expect(
      (
        await oauthApp.request('/harness/notes/shared_note/edit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            baseHash: editable.contentHash,
            edits: [{ type: 'append', text: ' OAuth edit' }],
          }),
        })
      ).status
    ).toBe(200);
    expect(
      (
        await oauthApp.request('/harness/notes/shared_note/trash', {
          method: 'POST',
        })
      ).status
    ).toBe(403);

    await db.insert(schema.collaborationGrants).values({
      id: 'oauth_folder_editor_grant',
      ownerUserId: 'owner',
      granteeUserId: collaborator.id,
      noteId: null,
      folderId: 'shared_folder',
      role: 'editor',
      createdByUserId: 'owner',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.authorizationCollaborationScopes).values({
      id: 'oauth_folder_scope',
      authorizationId: 'authorization',
      userId: collaborator.id,
      collaborationGrantId: 'oauth_folder_editor_grant',
      createdAt: now,
    });
    const oauthCreated = await oauthApp.request('/harness/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId: 'shared_folder', title: 'OAuth created' }),
    });
    expect(oauthCreated.status).toBe(201);
    const oauthCreatedBody = (await oauthCreated.json()) as { note: { id: string } };
    expect(
      (
        await oauthApp.request(`/harness/notes/${oauthCreatedBody.note.id}/trash`, {
          method: 'POST',
        })
      ).status
    ).toBe(200);

    oauthAuthorization.canEdit = false;
    expect(
      (
        await oauthApp.request('/harness/notes/shared_note/edit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ edits: [{ type: 'append', text: ' capability blocked' }] }),
        })
      ).status
    ).toBe(404);
    oauthAuthorization.canEdit = true;
    await db
      .delete(schema.authorizationCollaborationScopes)
      .where(eq(schema.authorizationCollaborationScopes.id, 'oauth_scope'));
    oauthAuthorization.sharedAccessMode = 'all';
    expect((await oauthApp.request('/harness/notes/shared_note')).status).toBe(200);
    await db.delete(schema.collaborationGrants).where(eq(schema.collaborationGrants.granteeUserId, collaborator.id));
    expect((await oauthApp.request('/harness/notes/shared_note')).status).toBe(404);
    libsql.close();
  });

  it('enforces none, specific, all, revocation, capability, and owner safety for Harness reads', async () => {
    const { app, db, libsql, schema, apiKey, now } = await setup();

    expect((await app.request('/harness/notes/shared_note')).status).toBe(404);

    apiKey.sharedAccessMode = 'specific';
    expect((await app.request('/harness/notes/shared_note')).status).toBe(404);
    await db.insert(schema.authorizationCollaborationScopes).values({
      id: 'scope',
      authorizationId: 'authorization',
      userId: 'collaborator',
      collaborationGrantId: 'shared_grant',
      createdAt: now,
    });
    const selected = await app.request('/harness/notes/shared_note');
    expect(selected.status).toBe(200);
    const selectedBody = (await selected.json()) as {
      note: Record<string, unknown>;
      access: Record<string, unknown>;
    };
    expect(selectedBody).toMatchObject({
      note: { id: 'shared_note', folderId: null, content: 'Shared content' },
      access: { role: 'viewer', source: 'note_grant' },
    });
    expect(selectedBody.note).not.toHaveProperty('userId');
    const selectedSearch = await app.request('/harness/notes/search?q=content');
    await expect(selectedSearch.json()).resolves.toMatchObject({
      notes: [
        {
          id: 'shared_note',
          folderId: null,
          folderTitle: null,
        },
      ],
    });
    const hiddenFolderSearch = await app.request('/harness/notes/search?q=Shared%20folder');
    await expect(hiddenFolderSearch.json()).resolves.toMatchObject({ notes: [] });
    await expect(
      app.request('/harness/notes/search-lines?q=Shared').then((response) => response.json())
    ).resolves.toMatchObject({
      matches: [
        expect.objectContaining({
          noteId: 'shared_note',
          folderId: null,
        }),
      ],
    });
    await expect(
      app.request('/harness/notes/shared_note/links').then((response) => response.json())
    ).resolves.toMatchObject({
      links: [{ id: 'link_to_future', targetNoteId: null }],
    });
    await expect(
      app.request('/harness/notes/shared_note/backlinks').then((response) => response.json())
    ).resolves.toMatchObject({ backlinks: [] });
    await expect(app.request('/harness/notes/orphans').then((response) => response.json())).resolves.toMatchObject({
      notes: [{ id: 'shared_note', folderId: null }],
    });
    await expect(app.request('/harness/tags').then((response) => response.json())).resolves.toMatchObject({
      tags: [{ id: 'shared_tag', noteCount: 1 }],
    });

    await db.insert(schema.collaborationGrants).values({
      id: 'future_grant',
      ownerUserId: 'owner',
      granteeUserId: 'collaborator',
      noteId: 'future_note',
      folderId: null,
      role: 'viewer',
      createdByUserId: 'owner',
      createdAt: now,
      updatedAt: now,
    });
    expect((await app.request('/harness/notes/future_note')).status).toBe(404);
    apiKey.sharedAccessMode = 'all';
    expect((await app.request('/harness/notes/future_note')).status).toBe(200);
    const allSearch = (await (await app.request('/harness/notes/search?q=content')).json()) as {
      notes: Array<{ id: string }>;
    };
    expect(allSearch.notes.map((note) => note.id).sort()).toEqual(['future_note', 'shared_note']);
    await expect(
      app.request('/harness/notes/shared_note/links').then((response) => response.json())
    ).resolves.toMatchObject({
      links: [{ id: 'link_to_future', targetNoteId: 'future_note' }],
    });
    await expect(
      app.request('/harness/notes/shared_note/backlinks').then((response) => response.json())
    ).resolves.toMatchObject({
      backlinks: [{ id: 'future_backlink', sourceNoteId: 'future_note', sourceFolderId: null }],
    });
    await expect(app.request('/harness/notes/orphans').then((response) => response.json())).resolves.toMatchObject({
      notes: [],
    });
    const allTags = (await (await app.request('/harness/tags')).json()) as { tags: Array<{ id: string }> };
    expect(allTags.tags.map((tag) => tag.id).sort()).toEqual(['future_tag', 'shared_tag']);
    await db.insert(schema.collaborationGrants).values({
      id: 'folder_editor_grant',
      ownerUserId: 'owner',
      granteeUserId: 'collaborator',
      noteId: null,
      folderId: 'shared_folder',
      role: 'editor',
      createdByUserId: 'owner',
      createdAt: now,
      updatedAt: now,
    });
    await expect(app.request('/harness/folders').then((response) => response.json())).resolves.toMatchObject({
      folders: [
        { id: 'shared_child', parentFolderId: 'shared_folder' },
        { id: 'shared_folder', parentFolderId: null },
      ],
    });
    apiKey.sharedAccessMode = 'specific';
    await expect(app.request('/harness/folders').then((response) => response.json())).resolves.toMatchObject({
      folders: [],
    });
    await db.insert(schema.authorizationCollaborationScopes).values({
      id: 'folder_scope',
      authorizationId: 'authorization',
      userId: 'collaborator',
      collaborationGrantId: 'folder_editor_grant',
      createdAt: now,
    });
    await expect(app.request('/harness/folders').then((response) => response.json())).resolves.toMatchObject({
      folders: [
        { id: 'shared_child', parentFolderId: 'shared_folder' },
        { id: 'shared_folder', parentFolderId: null },
      ],
    });
    apiKey.sharedAccessMode = 'all';
    apiKey.canCreate = true;
    const created = await app.request('/harness/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId: 'shared_folder', title: 'Agent created', content: 'Created by agent' }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { note: { id: string } };
    const [storedCreated] = await db.select().from(schema.notes).where(eq(schema.notes.id, createdBody.note.id));
    expect(storedCreated).toMatchObject({
      userId: 'owner',
      createdByUserId: 'collaborator',
      folderId: 'shared_folder',
      updatedByActorType: 'agent',
      updatedByActorId: 'api_key',
    });
    expect((await app.request(`/harness/notes/${createdBody.note.id}/trash`, { method: 'POST' })).status).toBe(404);
    apiKey.canEdit = true;
    const trashedCreated = await app.request(`/harness/notes/${createdBody.note.id}/trash`, { method: 'POST' });
    expect(trashedCreated.status).toBe(200);
    const [storedTrashedCreated] = await db.select().from(schema.notes).where(eq(schema.notes.id, createdBody.note.id));
    expect(storedTrashedCreated).toMatchObject({ deletedAt: expect.any(Date), updatedByActorId: 'api_key' });
    apiKey.canCreateFolders = true;
    const createdFolder = await app.request('/harness/folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentFolderId: 'shared_folder', title: 'Agent folder' }),
    });
    expect(createdFolder.status).toBe(201);
    const createdFolderBody = (await createdFolder.json()) as { folder: { id: string } };
    const [storedAgentFolder] = await db
      .select()
      .from(schema.folders)
      .where(eq(schema.folders.id, createdFolderBody.folder.id));
    expect(storedAgentFolder).toMatchObject({ userId: 'owner', createdByUserId: 'collaborator' });
    expect(
      (
        await app.request(`/harness/folders/${createdFolderBody.folder.id}/trash`, {
          method: 'POST',
        })
      ).status
    ).toBe(200);
    const createdCanvas = await app.request('/harness/canvases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId: 'shared_folder', title: 'Agent canvas' }),
    });
    expect(createdCanvas.status).toBe(201);
    const createdCanvasBody = (await createdCanvas.json()) as {
      note: { id: string };
      contentHash: string;
    };
    const replacedCanvas = await app.request(`/harness/notes/${createdCanvasBody.note.id}/canvas`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        canvas: { nodes: [{ id: 'node', type: 'text', text: 'Agent canvas edit' }], edges: [] },
        baseHash: createdCanvasBody.contentHash,
      }),
    });
    expect(replacedCanvas.status).toBe(200);
    const replacedCanvasBody = (await replacedCanvas.json()) as { contentHash: string };
    const linkedCanvas = await app.request(`/harness/notes/${createdCanvasBody.note.id}/canvas/nodes/node/link-note`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetNoteId: 'shared_note', baseHash: replacedCanvasBody.contentHash }),
    });
    expect(linkedCanvas.status).toBe(200);
    const linkedCanvasBody = (await linkedCanvas.json()) as { contentHash: string };
    const unlinkedCanvas = await app.request(
      `/harness/notes/${createdCanvasBody.note.id}/canvas/nodes/node/link?baseHash=${linkedCanvasBody.contentHash}`,
      { method: 'DELETE' }
    );
    expect(unlinkedCanvas.status).toBe(200);
    const [storedCanvas] = await db.select().from(schema.notes).where(eq(schema.notes.id, createdCanvasBody.note.id));
    expect(storedCanvas).toMatchObject({ userId: 'owner', updatedByActorId: 'api_key' });
    expect(JSON.parse(storedCanvas.content).nodes[0].minunotes).toBeUndefined();

    apiKey.canRead = false;
    expect((await app.request('/harness/notes/shared_note')).status).toBe(404);
    apiKey.canRead = true;

    await db
      .update(schema.collaborationGrants)
      .set({ role: 'editor' })
      .where(eq(schema.collaborationGrants.id, 'shared_grant'));
    apiKey.canEdit = true;
    const editable = (await (await app.request('/harness/notes/shared_note')).json()) as {
      contentHash: string;
      access: Record<string, unknown>;
    };
    expect(editable.access).toMatchObject({ role: 'editor', source: 'note_grant' });
    const edited = await app.request('/harness/notes/shared_note/edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseHash: editable.contentHash,
        edits: [{ type: 'replace_text', oldText: 'Shared content', newText: 'Agent edit' }],
      }),
    });
    expect(edited.status).toBe(200);
    await expect(edited.json()).resolves.toMatchObject({ note: { folderId: null } });
    const [storedEdit] = await db.select().from(schema.notes).where(eq(schema.notes.id, 'shared_note'));
    expect(storedEdit).toMatchObject({
      userId: 'owner',
      content: 'Agent edit',
      updatedByActorType: 'agent',
      updatedByActorId: 'api_key',
    });
    const tagged = await app.request('/harness/notes/shared_note/tags', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tags: ['agent-shared'] }),
    });
    expect(tagged.status).toBe(200);
    await expect(tagged.json()).resolves.toMatchObject({ tags: [{ name: 'agent-shared' }] });
    const [storedTag] = await db.select().from(schema.tags).where(eq(schema.tags.name, 'agent-shared'));
    expect(storedTag.userId).toBe('owner');
    apiKey.canComment = true;
    const commentRead = (await (await app.request('/harness/notes/shared_note')).json()) as {
      contentHash: string;
      access: Record<string, unknown>;
    };
    const comment = await app.request('/harness/notes/shared_note/comments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        body: 'Agent review',
        anchor: {
          anchorType: 'range',
          from: 0,
          to: 5,
          quote: 'Agent',
          documentHash: commentRead.contentHash,
        },
      }),
    });
    expect(comment.status).toBe(201);
    await expect(comment.json()).resolves.toMatchObject({
      thread: {
        createdBy: { type: 'agent', label: 'Collaborator key', isCurrentUser: true },
        messages: [{ author: { label: 'Collaborator key', isCurrentUser: true } }],
      },
    });

    await db
      .update(schema.collaborationGrants)
      .set({ role: 'commenter' })
      .where(eq(schema.collaborationGrants.id, 'shared_grant'));
    await db
      .update(schema.collaborationGrants)
      .set({ role: 'commenter' })
      .where(eq(schema.collaborationGrants.id, 'folder_editor_grant'));
    const downgradedEdit = await app.request('/harness/notes/shared_note/edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseHash: commentRead.contentHash,
        edits: [{ type: 'append', text: 'blocked by downgrade' }],
      }),
    });
    expect(downgradedEdit.status).toBe(404);
    await db
      .update(schema.collaborationGrants)
      .set({ role: 'editor' })
      .where(eq(schema.collaborationGrants.id, 'shared_grant'));
    await db
      .update(schema.collaborationGrants)
      .set({ role: 'editor' })
      .where(eq(schema.collaborationGrants.id, 'folder_editor_grant'));

    await db.update(schema.folders).set({ isAgentReadOnly: true }).where(eq(schema.folders.id, 'shared_folder'));
    expect(
      (
        await app.request('/harness/notes/shared_note/edit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ edits: [{ type: 'append', text: 'blocked' }] }),
        })
      ).status
    ).toBe(404);
    expect((await app.request('/harness/notes/shared_note')).status).toBe(200);
    await db.update(schema.folders).set({ isAgentReadOnly: false }).where(eq(schema.folders.id, 'shared_folder'));

    await db.update(schema.folders).set({ isPrivate: true }).where(eq(schema.folders.id, 'shared_folder'));
    expect((await app.request('/harness/notes/shared_note')).status).toBe(404);
    await db.update(schema.folders).set({ isPrivate: false }).where(eq(schema.folders.id, 'shared_folder'));

    await db.delete(schema.collaborationGrants).where(eq(schema.collaborationGrants.granteeUserId, 'collaborator'));
    expect((await app.request('/harness/notes/shared_note')).status).toBe(404);
    libsql.close();
  });
});
