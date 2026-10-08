import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectPrivacySafeCollaborationDto } from './helpers/collaboration-privacy';

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
  const dir = await mkdtemp(path.join(tmpdir(), 'notes-collaboration-management-'));
  tempDirs.push(dir);
  vi.stubEnv('TURSO_DB_URL', `file:${path.join(dir, 'test.db')}`);
  vi.stubEnv('FRONTEND_URL', 'https://notes.example.com');
  vi.stubEnv('ATTACHMENT_STORAGE_PATH', path.join(dir, 'attachments'));

  const [
    { db, libsql },
    schema,
    { collaborationRoutes },
    { noteRoutes },
    { folderRoutes },
    { attachmentRoutes },
    { getObjectStorage },
  ] = await Promise.all([
    import('../src/api/db/client'),
    import('../src/api/db/schema'),
    import('../src/api/routes/collaboration'),
    import('../src/api/routes/notes'),
    import('../src/api/routes/folders'),
    import('../src/api/routes/attachments'),
    import('../src/api/storage'),
  ]);
  await runMigrations(libsql);

  const owner = {
    id: 'owner',
    name: 'Owner',
    email: 'owner@example.com',
    emailVerified: true,
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const collaborator = {
    id: 'collaborator',
    name: 'Collaborator',
    email: 'collaborator@example.com',
    emailVerified: true,
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const otherOwner = {
    id: 'other_owner',
    name: 'Other Owner',
    email: 'other@example.com',
    emailVerified: true,
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await db.insert(schema.user).values([owner, collaborator, otherOwner]);
  await db.insert(schema.folders).values({
    id: 'folder',
    userId: owner.id,
    parentFolderId: null,
    title: 'Folder',
    isPrivate: false,
    isAgentReadOnly: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(schema.notes).values({
    id: 'note',
    folderId: 'folder',
    userId: owner.id,
    title: 'Note',
    content: '',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const app = new Hono();
  app.use('*', async (c, next) => {
    const actor = c.req.header('x-test-user');
    const sessionUser =
      actor === otherOwner.id
        ? otherOwner
        : actor === collaborator.id
          ? collaborator
          : actor
            ? { ...owner, id: actor }
            : owner;
    c.set('user', sessionUser);
    c.set('session', null);
    await next();
  });
  app.route('/', collaborationRoutes);
  app.route('/notes', noteRoutes);
  app.route('/folders', folderRoutes);
  app.route('/attachments', attachmentRoutes);
  return { app, db, libsql, schema, owner, collaborator, otherOwner, storage: getObjectStorage() };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('collaborator management', () => {
  it('creates, lists, updates, and removes an existing-user note grant', async () => {
    const { app, db, libsql, schema, owner, collaborator, storage } = await setup();
    const created = await app.request('/notes/note/collaborators', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'COLLABORATOR@example.com ', role: 'commenter' }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { grant: { key: string; role: string } };
    expect(createdBody).toMatchObject({
      kind: 'grant',
      grant: { key: expect.stringMatching(/^access_[a-f0-9]{16}$/), role: 'commenter' },
    });
    expect(JSON.stringify(createdBody)).not.toContain(collaborator.id);

    await db.insert(schema.notes).values({
      id: 'note_secret123',
      folderId: 'folder',
      userId: 'owner',
      title: 'Secret sibling',
      content: 'private sibling text',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(schema.tags).values([
      {
        id: 'tag_shared',
        userId: 'owner',
        name: 'Shared tag',
        normalizedName: 'shared tag',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'tag_hidden',
        userId: 'owner',
        name: 'Hidden tag',
        normalizedName: 'hidden tag',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    await db.insert(schema.noteTags).values([
      {
        id: 'note_tag_shared',
        userId: 'owner',
        noteId: 'note',
        tagId: 'tag_shared',
        createdAt: new Date(),
      },
      {
        id: 'note_tag_hidden',
        userId: 'owner',
        noteId: 'note_secret123',
        tagId: 'tag_hidden',
        createdAt: new Date(),
      },
    ]);
    await db.insert(schema.noteLinks).values([
      {
        id: 'link_to_secret',
        userId: 'owner',
        sourceNoteId: 'note',
        targetNoteId: 'note_secret123',
        targetTitle: 'Secret sibling',
        label: null,
        linkType: 'wikilink',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'hidden_backlink',
        userId: 'owner',
        sourceNoteId: 'note_secret123',
        targetNoteId: 'note',
        targetTitle: 'Note',
        label: null,
        linkType: 'wikilink',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const collaboratorRead = await app.request('/notes/note', {
      headers: { 'x-test-user': collaborator.id },
    });
    expect(collaboratorRead.status).toBe(200);
    const collaboratorReadBody = await collaboratorRead.json();
    expect(collaboratorReadBody).toMatchObject({
      note: { id: 'note', folderId: null },
      access: { role: 'commenter', source: 'note_grant' },
    });
    expect(collaboratorReadBody.note).not.toHaveProperty('userId');
    expect(collaboratorReadBody.access).not.toHaveProperty('resourceOwnerUserId');
    expect(collaboratorReadBody.access).not.toHaveProperty('actorUserId');
    expectPrivacySafeCollaborationDto(collaboratorReadBody, {
      forbiddenValues: [owner.id, collaborator.id, owner.email, collaborator.email],
    });

    const search = await app.request('/notes/search?q=Note', {
      headers: { 'x-test-user': collaborator.id },
    });
    expect(search.status).toBe(200);
    const searchBody = await search.json();
    expect(searchBody).toMatchObject({ notes: [{ id: 'note', folderId: null, folderTitle: null }] });
    expectPrivacySafeCollaborationDto(searchBody, {
      forbiddenValues: [owner.id, collaborator.id, owner.email, collaborator.email],
    });
    const hiddenSearch = await app.request('/notes/search?q=private%20sibling', {
      headers: { 'x-test-user': collaborator.id },
    });
    expect(await hiddenSearch.json()).toMatchObject({ notes: [] });
    const recent = await app.request('/notes/recent', { headers: { 'x-test-user': collaborator.id } });
    expect(recent.status).toBe(200);
    const recentBody = await recent.json();
    expect(recentBody).toMatchObject({ notes: [{ id: 'note', folderId: null }] });
    expectPrivacySafeCollaborationDto(recentBody, {
      forbiddenValues: [owner.id, collaborator.id, owner.email, collaborator.email],
    });
    const orphans = await app.request('/notes/orphans', { headers: { 'x-test-user': collaborator.id } });
    expect(orphans.status).toBe(200);
    const orphansBody = await orphans.json();
    expect(orphansBody).toMatchObject({ notes: [{ id: 'note', folderId: null }] });
    expectPrivacySafeCollaborationDto(orphansBody, {
      forbiddenValues: [owner.id, collaborator.id, owner.email, collaborator.email],
    });

    const tags = await app.request('/notes/note/tags', { headers: { 'x-test-user': collaborator.id } });
    expect(tags.status).toBe(200);
    expect(await tags.json()).toMatchObject({ tags: [{ id: 'tag_shared', name: 'Shared tag' }] });
    const accessibleTags = await app.request('/notes/tags', { headers: { 'x-test-user': collaborator.id } });
    expect(accessibleTags.status).toBe(200);
    expect(await accessibleTags.json()).toEqual({
      tags: [{ id: 'tag_shared', name: 'Shared tag', normalizedName: 'shared tag', noteCount: 1 }],
    });

    const links = await app.request('/notes/note/links', { headers: { 'x-test-user': collaborator.id } });
    expect(links.status).toBe(200);
    expect(await links.json()).toMatchObject({ links: [{ id: 'link_to_secret', targetNoteId: null }] });
    const backlinks = await app.request('/notes/note/backlinks', { headers: { 'x-test-user': collaborator.id } });
    expect(backlinks.status).toBe(200);
    expect(await backlinks.json()).toMatchObject({ backlinks: [] });

    await storage.putObject({
      key: 'shared-attachment',
      body: new TextEncoder().encode('shared bytes'),
      contentType: 'image/png',
    });
    await storage.putObject({
      key: 'secret-attachment',
      body: new TextEncoder().encode('secret bytes'),
      contentType: 'image/png',
    });
    await db.insert(schema.attachments).values([
      {
        id: 'shared_attachment',
        userId: 'owner',
        noteId: 'note',
        folderId: 'folder',
        provider: storage.provider,
        filename: 'shared.png',
        mimeType: 'image/png',
        size: 12,
        contentHash: 'shared',
        storageKey: 'shared-attachment',
        status: 'ready',
      },
      {
        id: 'secret_attachment',
        userId: 'owner',
        noteId: 'note_secret123',
        folderId: 'folder',
        provider: storage.provider,
        filename: 'secret.png',
        mimeType: 'image/png',
        size: 12,
        contentHash: 'secret',
        storageKey: 'secret-attachment',
        status: 'ready',
      },
    ]);
    const sharedAttachment = await app.request('/attachments/shared_attachment/content', {
      headers: { 'x-test-user': collaborator.id },
    });
    expect(sharedAttachment.status).toBe(200);
    expect(await sharedAttachment.text()).toBe('shared bytes');
    const hiddenAttachment = await app.request('/attachments/secret_attachment/content', {
      headers: { 'x-test-user': collaborator.id },
    });
    expect(hiddenAttachment.status).toBe(404);

    const sharedWithMe = await app.request('/collaborations/shared-with-me', {
      headers: { 'x-test-user': collaborator.id },
    });
    expect(sharedWithMe.status).toBe(200);
    const sharedWithMeBody = await sharedWithMe.json();
    expect(sharedWithMeBody).toMatchObject({
      collaborations: [
        {
          type: 'note',
          grantId: createdBody.grant.key,
          role: 'commenter',
          owner: {
            key: expect.stringMatching(/^user_[a-f0-9]{16}$/),
            label: owner.name,
            displayName: owner.name,
            maskedEmail: 'o•••@e•••.com',
          },
          note: { id: 'note', title: 'Note' },
        },
      ],
    });
    expect(sharedWithMeBody.collaborations[0].grantId).toMatch(/^access_[a-f0-9]{16}$/);
    const [storedGrant] = await db.select().from(schema.collaborationGrants);
    expectPrivacySafeCollaborationDto(sharedWithMeBody, {
      forbiddenValues: [owner.id, collaborator.id, owner.email, collaborator.email, storedGrant.id],
    });
    expect(JSON.stringify(sharedWithMeBody)).not.toContain('grant_');
    expect(sharedWithMeBody.collaborations[0].owner).not.toHaveProperty('id');

    const listed = await app.request('/notes/note/collaborators');
    expect(listed.status).toBe(200);
    const listedBody = await listed.json();
    expect(listedBody).toMatchObject({
      grants: [
        {
          key: createdBody.grant.key,
          role: 'commenter',
          user: { label: collaborator.name, maskedEmail: 'c•••@e•••.com' },
        },
      ],
      invitations: [],
    });
    expect(listedBody).not.toHaveProperty('owner');
    expectPrivacySafeCollaborationDto(listedBody, {
      forbiddenValues: [owner.id, collaborator.id, owner.email, collaborator.email, storedGrant.id],
    });
    expect(JSON.stringify(listedBody)).not.toContain(collaborator.email);
    expect(JSON.stringify(listedBody)).not.toContain(collaborator.id);

    const commenterEdit = await app.request('/notes/note', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-user': collaborator.id },
      body: JSON.stringify({ title: 'Denied' }),
    });
    expect(commenterEdit.status).toBe(403);
    const commenterTags = await app.request('/notes/note/tags', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-user': collaborator.id },
      body: JSON.stringify({ tags: ['denied'] }),
    });
    expect(commenterTags.status).toBe(403);
    const commenterUpload = await app.request('/attachments/notes/note/images', {
      method: 'POST',
      headers: { 'x-test-user': collaborator.id },
    });
    expect(commenterUpload.status).toBe(403);
    const commenterDelete = await app.request('/attachments/shared_attachment', {
      method: 'DELETE',
      headers: { 'x-test-user': collaborator.id },
    });
    expect(commenterDelete.status).toBe(403);

    const updated = await app.request(`/notes/note/collaborators/${createdBody.grant.key}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'editor' }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ grant: { role: 'editor' } });

    const beforeEdit = await app.request('/notes/note', { headers: { 'x-test-user': collaborator.id } });
    const beforeEditBody = (await beforeEdit.json()) as { contentHash: string };
    const editorEdit = await app.request('/notes/note', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-user': collaborator.id },
      body: JSON.stringify({
        title: 'Collaboratively edited',
        content: 'Edited by collaborator',
        baseHash: beforeEditBody.contentHash,
      }),
    });
    expect(editorEdit.status).toBe(200);
    const editorEditBody = await editorEdit.json();
    expect(editorEditBody).toMatchObject({
      note: {
        id: 'note',
        folderId: null,
        title: 'Collaboratively edited',
        content: 'Edited by collaborator',
        updatedByActorId: null,
      },
    });
    expect(editorEditBody.note).not.toHaveProperty('userId');
    const collaboratorEvents = await db.select().from(schema.noteEvents).where(eq(schema.noteEvents.noteId, 'note'));
    expect(collaboratorEvents).toContainEqual(
      expect.objectContaining({ userId: 'owner', actorType: 'user', actorId: collaborator.id })
    );
    const staleEdit = await app.request('/notes/note', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-user': collaborator.id },
      body: JSON.stringify({ content: 'Stale overwrite', baseHash: beforeEditBody.contentHash }),
    });
    expect(staleEdit.status).toBe(409);
    const forbiddenPolicyEdit = await app.request('/notes/note', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-user': collaborator.id },
      body: JSON.stringify({ isApiEditable: false }),
    });
    expect(forbiddenPolicyEdit.status).toBe(403);

    const editorTags = await app.request('/notes/note/tags', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-user': collaborator.id },
      body: JSON.stringify({ tags: ['collaborative'] }),
    });
    expect(editorTags.status).toBe(200);
    expect(await editorTags.json()).toMatchObject({ tags: [{ name: 'collaborative' }] });
    const [collaborativeTag] = await db.select().from(schema.tags).where(eq(schema.tags.name, 'collaborative'));
    expect(collaborativeTag.userId).toBe('owner');

    const imageBody = new FormData();
    imageBody.set(
      'image',
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'shared.png', {
        type: 'image/png',
      })
    );
    const editorUpload = await app.request('/attachments/notes/note/images', {
      method: 'POST',
      headers: { 'x-test-user': collaborator.id },
      body: imageBody,
    });
    expect(editorUpload.status).toBe(201);
    const editorUploadBody = (await editorUpload.json()) as {
      attachment: { id: string; folderId: string | null };
    };
    expect(editorUploadBody.attachment).toMatchObject({ folderId: null });
    expect(editorUploadBody.attachment).not.toHaveProperty('userId');
    expect(editorUploadBody.attachment).not.toHaveProperty('storageKey');
    const [storedUpload] = await db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.id, editorUploadBody.attachment.id));
    expect(storedUpload).toMatchObject({ userId: 'owner', folderId: 'folder' });
    const uploadedContent = await app.request(`/attachments/${editorUploadBody.attachment.id}/content`, {
      headers: { 'x-test-user': collaborator.id },
    });
    expect(uploadedContent.status).toBe(200);
    const editorDelete = await app.request(`/attachments/${editorUploadBody.attachment.id}`, {
      method: 'DELETE',
      headers: { 'x-test-user': collaborator.id },
    });
    expect(editorDelete.status).toBe(200);
    const deletedContent = await app.request(`/attachments/${editorUploadBody.attachment.id}/content`, {
      headers: { 'x-test-user': collaborator.id },
    });
    expect(deletedContent.status).toBe(404);

    await db
      .update(schema.notes)
      .set({
        documentType: 'canvas.default',
        content: JSON.stringify({
          nodes: [
            {
              id: 'hidden-link-node',
              type: 'text',
              text: 'Private link',
              minunotes: { link: { type: 'note', id: 'note_secret123' } },
            },
          ],
          edges: [],
        }),
      })
      .where(eq(schema.notes.id, 'note'));
    await db.insert(schema.noteLinks).values({
      id: 'canvas_link_to_secret',
      userId: 'owner',
      sourceNoteId: 'note',
      targetNoteId: 'note_secret123',
      targetTitle: 'Secret sibling',
      label: null,
      linkType: 'canvas-note',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const sanitizedCanvas = await app.request('/notes/note', {
      headers: { 'x-test-user': collaborator.id },
    });
    expect(sanitizedCanvas.status).toBe(200);
    const sanitizedCanvasBody = (await sanitizedCanvas.json()) as {
      note: { content: string };
      contentHash: string;
    };
    expect(sanitizedCanvasBody.note.content).not.toContain('note_secret123');
    const hiddenCanvasLinks = await app.request('/notes/note/links', {
      headers: { 'x-test-user': collaborator.id },
    });
    expect(await hiddenCanvasLinks.json()).toMatchObject({
      links: [{ id: 'canvas_link_to_secret', targetNoteId: null, targetTitle: 'Linked note' }],
    });
    const blockedHiddenCanvasEdit = await app.request('/notes/note', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-user': collaborator.id },
      body: JSON.stringify({ content: sanitizedCanvasBody.note.content, baseHash: sanitizedCanvasBody.contentHash }),
    });
    expect(blockedHiddenCanvasEdit.status).toBe(403);
    const allowedCanvasTitleEdit = await app.request('/notes/note', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-user': collaborator.id },
      body: JSON.stringify({ title: 'Safe canvas title', baseHash: sanitizedCanvasBody.contentHash }),
    });
    expect(allowedCanvasTitleEdit.status).toBe(200);
    expect(JSON.stringify(await allowedCanvasTitleEdit.json())).not.toContain('note_secret123');

    await db.insert(schema.integrationAuthorizations).values({
      id: 'auth',
      userId: collaborator.id,
      sharedAccessMode: 'specific',
    });
    const [grant] = await db.select().from(schema.collaborationGrants);
    await db.insert(schema.authorizationCollaborationScopes).values({
      id: 'scope',
      authorizationId: 'auth',
      userId: collaborator.id,
      collaborationGrantId: grant.id,
    });

    const removed = await app.request(`/notes/note/collaborators/${createdBody.grant.key}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(await db.select().from(schema.collaborationGrants)).toHaveLength(0);
    expect(await db.select().from(schema.authorizationCollaborationScopes)).toHaveLength(0);
    libsql.close();
  });

  it('lists notes in an inherited shared folder without exposing templates', async () => {
    const { app, db, libsql, schema, owner, collaborator, otherOwner } = await setup();
    const grant = await app.request('/folders/folder/collaborators', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: collaborator.email, role: 'viewer' }),
    });
    expect(grant.status).toBe(201);
    const grantBody = (await grant.json()) as { grant: { key: string } };

    const listed = await app.request('/folders/folder/notes', {
      headers: { 'x-test-user': collaborator.id },
    });
    expect(listed.status).toBe(200);
    const listedBody = await listed.json();
    expect(listedBody).toMatchObject({
      notes: [{ id: 'note' }],
      access: { role: 'viewer', source: 'folder_grant' },
    });
    expect(listedBody.access).not.toHaveProperty('resourceOwnerUserId');
    const detail = await app.request('/folders/folder/detail', {
      headers: { 'x-test-user': collaborator.id },
    });
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody).toMatchObject({
      folder: { id: 'folder', parentFolderId: null },
      childFolders: [],
      access: { role: 'viewer', source: 'folder_grant' },
      sharedBy: { type: 'user', label: 'Owner', isCurrentUser: false },
    });
    expect(detailBody).toMatchObject({ ancestors: [] });
    expect(detailBody.folder).not.toHaveProperty('userId');

    await db.insert(schema.folders).values({
      id: 'folder_child',
      userId: owner.id,
      parentFolderId: 'folder',
      title: 'Child folder',
      isPrivate: false,
      isAgentReadOnly: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const childDetail = await app.request('/folders/folder_child/detail', {
      headers: { 'x-test-user': collaborator.id },
    });
    expect(childDetail.status).toBe(200);
    expect(await childDetail.json()).toMatchObject({
      folder: { id: 'folder_child', parentFolderId: 'folder' },
      ancestors: [{ id: 'folder', parentFolderId: null }],
      access: { role: 'viewer', source: 'folder_grant' },
    });

    const directChildGrant = await app.request('/folders/folder_child/collaborators', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: otherOwner.email, role: 'viewer' }),
    });
    expect(directChildGrant.status).toBe(201);
    const directChildDetail = await app.request('/folders/folder_child/detail', {
      headers: { 'x-test-user': otherOwner.id },
    });
    expect(directChildDetail.status).toBe(200);
    expect(await directChildDetail.json()).toMatchObject({
      folder: { id: 'folder_child', parentFolderId: null },
      ancestors: [],
      access: { role: 'viewer', source: 'folder_grant' },
    });

    const templates = await app.request('/folders/folder/notes?type=template', {
      headers: { 'x-test-user': collaborator.id },
    });
    expect(templates.status).toBe(404);
    const viewerCreate = await app.request('/folders/folder/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': collaborator.id },
      body: JSON.stringify({ title: 'Denied' }),
    });
    expect(viewerCreate.status).toBe(403);

    const upgraded = await app.request(`/folders/folder/collaborators/${grantBody.grant.key}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'editor' }),
    });
    expect(upgraded.status).toBe(200);
    const created = await app.request('/folders/folder/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': collaborator.id },
      body: JSON.stringify({ title: 'Created by editor', content: 'Shared folder content' }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody).toMatchObject({ note: { folderId: 'folder', updatedByActorId: null } });
    expect(createdBody.note).not.toHaveProperty('userId');
    const createdCanvas = await app.request('/folders/folder/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': collaborator.id },
      body: JSON.stringify({ title: 'Editor canvas', documentType: 'canvas.default' }),
    });
    expect(createdCanvas.status).toBe(201);
    const createdCanvasBody = (await createdCanvas.json()) as {
      note: { id: string; documentType: string; updatedByActorId: null };
    };
    expect(createdCanvasBody).toMatchObject({
      note: { documentType: 'canvas.default', updatedByActorId: null },
    });
    expect(createdCanvasBody.note).not.toHaveProperty('userId');
    const canvasRead = await app.request(`/notes/${createdCanvasBody.note.id}`, {
      headers: { 'x-test-user': collaborator.id },
    });
    const canvasReadBody = (await canvasRead.json()) as { contentHash: string };
    const canvasEdit = await app.request(`/notes/${createdCanvasBody.note.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-user': collaborator.id },
      body: JSON.stringify({
        content: JSON.stringify({ nodes: [{ id: 'node', type: 'text', text: 'Editor' }], edges: [] }),
        baseHash: canvasReadBody.contentHash,
      }),
    });
    expect(canvasEdit.status).toBe(200);
    expect(await canvasEdit.json()).toMatchObject({ note: { updatedByActorId: null } });
    const deniedTemplate = await app.request('/folders/folder/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': collaborator.id },
      body: JSON.stringify({ title: 'No template', type: 'template' }),
    });
    expect(deniedTemplate.status).toBe(403);
    libsql.close();
  });

  it('lists direct roots with the highest effective role across overlapping grants', async () => {
    const { app, collaborator, db, libsql, schema } = await setup();
    await db.insert(schema.notes).values({
      id: 'note_second',
      folderId: 'folder',
      userId: 'owner',
      title: 'Second note',
      content: '',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const grant = (resource: 'folders/folder' | 'notes/note' | 'notes/note_second', role: 'viewer' | 'editor') =>
      app.request(`/${resource}/collaborators`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: collaborator.email, role }),
      });

    expect((await grant('folders/folder', 'editor')).status).toBe(201);
    expect((await grant('notes/note', 'viewer')).status).toBe(201);
    expect((await grant('notes/note_second', 'viewer')).status).toBe(201);
    const response = await app.request('/collaborations/shared-with-me', {
      headers: { 'x-test-user': collaborator.id },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      collaborations: Array<{ type: 'note' | 'folder'; role: string }>;
    };
    expect(body.collaborations).toHaveLength(3);
    const storedGrantIds = (
      await db.select({ id: schema.collaborationGrants.id }).from(schema.collaborationGrants)
    ).map((row) => row.id);
    expectPrivacySafeCollaborationDto(body, { forbiddenValues: storedGrantIds });
    expect(body.collaborations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'folder', role: 'editor' }),
        expect.objectContaining({ type: 'note', role: 'editor' }),
      ])
    );

    const firstPage = await app.request('/collaborations/shared-with-me?type=note&limit=1', {
      headers: { 'x-test-user': collaborator.id },
    });
    expect(firstPage.status).toBe(200);
    const firstPageBody = (await firstPage.json()) as {
      collaborations: Array<{ grantId: string }>;
      pageInfo: { hasMore: boolean; nextCursor: string | null };
    };
    expect(firstPageBody.collaborations).toHaveLength(1);
    expect(firstPageBody.pageInfo).toMatchObject({ hasMore: true, nextCursor: expect.any(String) });
    const decodedCursor = Buffer.from(firstPageBody.pageInfo.nextCursor ?? '', 'base64url').toString('utf8');
    for (const storedGrantId of storedGrantIds) expect(decodedCursor).not.toContain(storedGrantId);
    const insertedAt = new Date(Date.now() + 60_000);
    await db.insert(schema.notes).values({
      id: 'note_newer_than_cursor',
      folderId: 'folder',
      userId: 'owner',
      title: 'Newest note',
      content: '',
      createdAt: insertedAt,
      updatedAt: insertedAt,
    });
    const newerGrant = await app.request('/notes/note_newer_than_cursor/collaborators', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: collaborator.email, role: 'viewer' }),
    });
    expect(newerGrant.status).toBe(201);

    const secondPage = await app.request(
      `/collaborations/shared-with-me?type=note&limit=1&cursor=${encodeURIComponent(firstPageBody.pageInfo.nextCursor ?? '')}`,
      { headers: { 'x-test-user': collaborator.id } }
    );
    expect(secondPage.status).toBe(200);
    const secondPageBody = (await secondPage.json()) as {
      collaborations: Array<{ grantId: string; note?: { id: string } }>;
      pageInfo: { hasMore: boolean; nextCursor: string | null };
    };
    expect(secondPageBody.collaborations).toHaveLength(1);
    expect(secondPageBody.collaborations[0]?.grantId).not.toBe(firstPageBody.collaborations[0]?.grantId);
    expect(secondPageBody.collaborations[0]?.note?.id).not.toBe('note_newer_than_cursor');
    expect(secondPageBody.pageInfo).toEqual({ hasMore: false, nextCursor: null });
    const invalidCursor = await app.request('/collaborations/shared-with-me?type=note&cursor=invalid', {
      headers: { 'x-test-user': collaborator.id },
    });
    expect(invalidCursor.status).toBe(400);
    await expect(invalidCursor.json()).resolves.toEqual({ error: 'Invalid collaboration cursor' });
    libsql.close();
  });

  it('returns bounded shared-folder roots without nested duplicates or inactive paths', async () => {
    const { app, db, libsql, schema, owner, collaborator } = await setup();
    const now = new Date();
    await db.insert(schema.folders).values([
      {
        id: 'folder_shared_nested',
        userId: owner.id,
        parentFolderId: 'folder',
        title: 'Nested shared folder',
        createdByUserId: owner.id,
        isPrivate: false,
        isAgentReadOnly: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'folder_shared_other_root',
        userId: owner.id,
        parentFolderId: null,
        title: 'Other shared root',
        createdByUserId: owner.id,
        isPrivate: false,
        isAgentReadOnly: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'folder_shared_deleted_root',
        userId: owner.id,
        parentFolderId: null,
        title: 'Deleted root',
        createdByUserId: owner.id,
        isPrivate: false,
        isAgentReadOnly: false,
        deletedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'folder_shared_under_deleted',
        userId: owner.id,
        parentFolderId: 'folder_shared_deleted_root',
        title: 'Under deleted root',
        createdByUserId: owner.id,
        isPrivate: false,
        isAgentReadOnly: false,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    for (const [folderId, role] of [
      ['folder', 'viewer'],
      ['folder_shared_nested', 'editor'],
      ['folder_shared_other_root', 'commenter'],
    ] as const) {
      const response = await app.request(`/folders/${folderId}/collaborators`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: collaborator.email, role }),
      });
      expect(response.status).toBe(201);
    }
    await db.insert(schema.collaborationGrants).values({
      id: 'grant_under_deleted_parent',
      ownerUserId: owner.id,
      granteeUserId: collaborator.id,
      noteId: null,
      folderId: 'folder_shared_under_deleted',
      role: 'editor',
      createdByUserId: owner.id,
      createdAt: now,
      updatedAt: now,
    });
    const noteGrant = await app.request('/notes/note/collaborators', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: collaborator.email, role: 'editor' }),
    });
    expect(noteGrant.status).toBe(201);

    const response = await app.request('/collaborations/shared-folder-roots?limit=10', {
      headers: { 'x-test-user': collaborator.id },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      folders: Array<{ id: string; title: string; role: string; hasChildren: boolean }>;
      pageInfo: { hasMore: boolean };
    };
    expect(body.folders.map((folder) => folder.id).sort()).toEqual(['folder', 'folder_shared_other_root']);
    expect(body.folders.find((folder) => folder.id === 'folder')).toMatchObject({ role: 'viewer', hasChildren: true });
    expect(body.pageInfo).toEqual({ hasMore: false });
    expect(JSON.stringify(body)).not.toContain('folder_shared_nested');
    expect(JSON.stringify(body)).not.toContain('folder_shared_under_deleted');
    expect(JSON.stringify(body)).not.toContain(owner.email);
    expect(JSON.stringify(body)).not.toContain(owner.name);
    expect(JSON.stringify(body)).not.toContain(owner.id);
    libsql.close();
  });

  it('loads shared-folder children lazily with bounded pages and authorization checks', async () => {
    const { app, db, libsql, schema, owner, collaborator, otherOwner } = await setup();
    const now = new Date();
    await db.insert(schema.folders).values([
      ...['Alpha child', 'Beta child', 'Deleted child'].map((title, index) => ({
        id: `folder_child_${index}`,
        userId: owner.id,
        parentFolderId: 'folder',
        title,
        createdByUserId: owner.id,
        isPrivate: title === 'Alpha child',
        isAgentReadOnly: false,
        deletedAt: title === 'Deleted child' ? now : null,
        createdAt: now,
        updatedAt: now,
      })),
      {
        id: 'folder_inherited_leaf',
        userId: owner.id,
        parentFolderId: 'folder_child_0',
        title: 'Inherited leaf',
        createdByUserId: owner.id,
        isPrivate: false,
        isAgentReadOnly: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'folder_deleted_parent',
        userId: owner.id,
        parentFolderId: null,
        title: 'Deleted parent',
        createdByUserId: owner.id,
        isPrivate: false,
        isAgentReadOnly: false,
        deletedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'folder_under_deleted_parent',
        userId: owner.id,
        parentFolderId: 'folder_deleted_parent',
        title: 'Under deleted parent',
        createdByUserId: owner.id,
        isPrivate: false,
        isAgentReadOnly: false,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(schema.collaborationGrants).values([
      {
        id: 'grant_deleted_parent_child',
        ownerUserId: owner.id,
        granteeUserId: collaborator.id,
        noteId: null,
        folderId: 'folder_under_deleted_parent',
        role: 'viewer',
        createdByUserId: owner.id,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const grant = await app.request('/folders/folder/collaborators', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: collaborator.email, role: 'viewer' }),
    });
    expect(grant.status).toBe(201);

    const firstPage = await app.request('/folders/folder/children?limit=1', {
      headers: { 'x-test-user': collaborator.id },
    });
    expect(firstPage.status).toBe(200);
    const firstBody = (await firstPage.json()) as {
      folders: Array<{ id: string; title: string; hasChildren: boolean; canTrash?: boolean }>;
      pageInfo: { hasMore: boolean; nextCursor: string | null };
    };
    expect(firstBody.folders).toHaveLength(1);
    expect(firstBody.folders[0]).toMatchObject({
      id: 'folder_child_0',
      title: 'Alpha child',
      isPrivate: true,
      hasChildren: true,
    });
    expect(firstBody.folders[0]).not.toHaveProperty('canTrash');
    expect(firstBody.pageInfo).toMatchObject({ hasMore: true, nextCursor: expect.any(String) });

    const secondPage = await app.request(
      `/folders/folder/children?limit=1&cursor=${encodeURIComponent(firstBody.pageInfo.nextCursor ?? '')}`,
      { headers: { 'x-test-user': collaborator.id } }
    );
    expect(secondPage.status).toBe(200);
    await expect(secondPage.json()).resolves.toMatchObject({
      folders: [{ id: 'folder_child_1', title: 'Beta child' }],
      pageInfo: { hasMore: false, nextCursor: null },
    });

    const ownerAccess = await app.request('/folders/folder/children', {
      headers: { 'x-test-user': owner.id },
    });
    expect(ownerAccess.status).toBe(200);
    const inheritedAccess = await app.request('/folders/folder_child_0/children', {
      headers: { 'x-test-user': collaborator.id },
    });
    expect(inheritedAccess.status).toBe(200);
    await expect(inheritedAccess.json()).resolves.toMatchObject({
      folders: [{ id: 'folder_inherited_leaf', title: 'Inherited leaf' }],
    });
    const deletedAncestorAccess = await app.request('/folders/folder_under_deleted_parent/children', {
      headers: { 'x-test-user': collaborator.id },
    });
    expect(deletedAncestorAccess.status).toBe(404);
    const missingFolderAccess = await app.request('/folders/folder_no_longer_exists/children', {
      headers: { 'x-test-user': collaborator.id },
    });
    expect(missingFolderAccess.status).toBe(404);

    const denied = await app.request('/folders/folder/children', {
      headers: { 'x-test-user': otherOwner.id },
    });
    expect(denied.status).toBe(404);
    const invalidCursor = await app.request('/folders/folder/children?cursor=invalid', {
      headers: { 'x-test-user': collaborator.id },
    });
    expect(invalidCursor.status).toBe(400);
    libsql.close();
  });

  it('scopes note discovery and serializes privacy-safe shared context', async () => {
    const { app, db, libsql, schema, owner, otherOwner } = await setup();
    await db.insert(schema.notes).values({
      id: 'note_scope_owned',
      folderId: 'folder',
      userId: owner.id,
      title: 'Scope owned note',
      content: '',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(schema.folders).values([
      {
        id: 'folder_scope_direct',
        userId: otherOwner.id,
        parentFolderId: null,
        title: 'Direct container',
        isPrivate: false,
        isAgentReadOnly: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'folder_scope_shared',
        userId: otherOwner.id,
        parentFolderId: null,
        title: 'Shared project',
        isPrivate: false,
        isAgentReadOnly: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    await db.insert(schema.notes).values([
      {
        id: 'note_scope_direct',
        folderId: 'folder_scope_direct',
        userId: otherOwner.id,
        title: 'Scope direct note',
        content: '',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'note_scope_folder',
        folderId: 'folder_scope_shared',
        userId: otherOwner.id,
        title: 'Scope folder note',
        content: '',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const grantAsOtherOwner = (resource: string) =>
      app.request(`/${resource}/collaborators`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-user': otherOwner.id },
        body: JSON.stringify({ email: owner.email, role: 'commenter' }),
      });
    expect((await grantAsOtherOwner('notes/note_scope_direct')).status).toBe(201);
    expect((await grantAsOtherOwner('folders/folder_scope_shared')).status).toBe(201);

    const search = async (scope?: string) => {
      const response = await app.request(`/notes/search?q=Scope${scope ? `&scope=${scope}` : ''}`);
      return { response, body: (await response.json()) as { notes: Array<Record<string, unknown>> } };
    };
    const all = await search();
    expect(all.response.status).toBe(200);
    expect(all.body.notes).toHaveLength(3);
    expect(all.body.notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'note_scope_owned',
          access: { role: 'owner', source: 'owner' },
          owner: null,
        }),
        expect.objectContaining({
          id: 'note_scope_direct',
          folderId: null,
          folderTitle: null,
          access: { role: 'commenter', source: 'note_grant' },
          owner: expect.objectContaining({ label: otherOwner.name, maskedEmail: 'o•••@e•••.com' }),
        }),
        expect.objectContaining({
          id: 'note_scope_folder',
          folderId: 'folder_scope_shared',
          folderTitle: 'Shared project',
          access: { role: 'commenter', source: 'folder_grant' },
          owner: expect.objectContaining({ label: otherOwner.name, maskedEmail: 'o•••@e•••.com' }),
        }),
      ])
    );
    expect(JSON.stringify(all.body)).not.toContain(otherOwner.id);
    expect(JSON.stringify(all.body)).not.toContain(otherOwner.email);

    const mine = await search('mine');
    expect(mine.body.notes.map((note) => note.id)).toEqual(['note_scope_owned']);
    const shared = await search('shared');
    expect(shared.body.notes.map((note) => note.id).sort()).toEqual(['note_scope_direct', 'note_scope_folder']);

    const recentShared = await app.request('/notes/recent?scope=shared');
    const recentSharedBody = (await recentShared.json()) as { notes: Array<Record<string, unknown>> };
    expect(recentSharedBody.notes.map((note) => note.id).sort()).toEqual(['note_scope_direct', 'note_scope_folder']);
    expect((await app.request('/notes/search?q=Scope&scope=invalid')).status).toBe(400);
    expect((await app.request('/notes/recent?scope=invalid')).status).toBe(400);

    const directAccessList = await app.request('/notes/note_scope_direct/collaborators', {
      headers: { 'x-test-user': otherOwner.id },
    });
    const directAccessBody = (await directAccessList.json()) as { grants: Array<{ key: string }> };
    expect(
      (
        await app.request(`/notes/note_scope_direct/collaborators/${directAccessBody.grants[0]?.key}`, {
          method: 'DELETE',
          headers: { 'x-test-user': otherOwner.id },
        })
      ).status
    ).toBe(200);
    const afterRevocation = await search('shared');
    expect(afterRevocation.body.notes.map((note) => note.id)).toEqual(['note_scope_folder']);
    libsql.close();
  });

  it('lists owner-managed sharing roots with aggregate statuses, search, pagination, and isolation', async () => {
    const { app, collaborator, db, libsql, schema, otherOwner } = await setup();
    const now = Date.now();
    await db.insert(schema.notes).values([
      {
        id: 'note_public',
        folderId: 'folder',
        userId: 'owner',
        title: 'Public roadmap',
        content: '',
        createdAt: new Date(now - 2_000),
        updatedAt: new Date(now - 2_000),
      },
      {
        id: 'note_inherited_only',
        folderId: 'folder',
        userId: 'owner',
        title: 'Inherited only',
        content: '',
        createdAt: new Date(now - 3_000),
        updatedAt: new Date(now - 3_000),
      },
    ]);

    const add = (resource: string, email: string, role = 'viewer') =>
      app.request(`/${resource}/collaborators`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, role }),
      });
    expect((await add('notes/note', collaborator.email, 'editor')).status).toBe(201);
    expect((await add('notes/note', 'expired@example.com')).status).toBe(201);
    expect((await add('folders/folder', collaborator.email, 'viewer')).status).toBe(201);
    expect((await add('folders/folder', 'pending@example.com')).status).toBe(201);
    await db
      .update(schema.collaborationInvitations)
      .set({ expiresAt: new Date(now - 1_000) })
      .where(eq(schema.collaborationInvitations.invitedEmailKey, 'expired@example.com'));
    expect(
      (
        await app.request('/notes/note_public/share-link', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        })
      ).status
    ).toBe(201);

    await db.insert(schema.folders).values({
      id: 'other_folder',
      userId: otherOwner.id,
      parentFolderId: null,
      title: 'Other owner folder',
      isPrivate: false,
      isAgentReadOnly: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(schema.collaborationInvitations).values({
      id: 'other_invitation',
      ownerUserId: otherOwner.id,
      invitedEmailKey: 'someone@example.com',
      noteId: null,
      folderId: 'other_folder',
      role: 'viewer',
      tokenHash: 'other-token-hash',
      invitedByUserId: otherOwner.id,
      expiresAt: new Date(now + 60_000),
      acceptedAt: null,
      acceptedByUserId: null,
      revokedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const notesResponse = await app.request('/collaborations/shared-by-me?type=note');
    expect(notesResponse.status).toBe(200);
    const notesBody = (await notesResponse.json()) as {
      resources: Array<{
        resource: { id: string };
        activeCollaboratorCount: number;
        pendingInvitationCount: number;
        expiredInvitationCount: number;
        publicLinkActive: boolean;
      }>;
      pageInfo: { hasMore: boolean; nextCursor: string | null };
    };
    expect(notesBody.resources).toHaveLength(2);
    expect(notesBody.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resource: expect.objectContaining({ id: 'note' }),
          activeCollaboratorCount: 1,
          pendingInvitationCount: 0,
          expiredInvitationCount: 1,
          publicLinkActive: false,
        }),
        expect.objectContaining({
          resource: expect.objectContaining({ id: 'note_public' }),
          activeCollaboratorCount: 0,
          pendingInvitationCount: 0,
          expiredInvitationCount: 0,
          publicLinkActive: true,
        }),
      ])
    );
    expect(notesBody.resources.some((item) => item.resource.id === 'note_inherited_only')).toBe(false);

    const foldersResponse = await app.request('/collaborations/shared-by-me?type=folder');
    await expect(foldersResponse.json()).resolves.toMatchObject({
      resources: [
        {
          type: 'folder',
          resource: { id: 'folder' },
          activeCollaboratorCount: 1,
          pendingInvitationCount: 1,
          expiredInvitationCount: 0,
          publicLinkActive: false,
        },
      ],
    });

    const searchResponse = await app.request('/collaborations/shared-by-me?type=note&q=ROAD');
    const searchBody = (await searchResponse.json()) as typeof notesBody;
    expect(searchBody.resources.map((item) => item.resource.id)).toEqual(['note_public']);

    const firstPage = await app.request('/collaborations/shared-by-me?type=note&limit=1');
    const firstPageBody = (await firstPage.json()) as typeof notesBody;
    expect(firstPageBody.resources).toHaveLength(1);
    expect(firstPageBody.pageInfo).toMatchObject({ hasMore: true, nextCursor: expect.any(String) });
    const secondPage = await app.request(
      `/collaborations/shared-by-me?type=note&limit=1&cursor=${encodeURIComponent(firstPageBody.pageInfo.nextCursor ?? '')}`
    );
    const secondPageBody = (await secondPage.json()) as typeof notesBody;
    expect(secondPageBody.resources).toHaveLength(1);
    expect(secondPageBody.resources[0]?.resource.id).not.toBe(firstPageBody.resources[0]?.resource.id);
    expect(secondPageBody.pageInfo).toEqual({ hasMore: false, nextCursor: null });
    expect(
      (
        await app.request(
          `/collaborations/shared-by-me?type=note&q=road&cursor=${encodeURIComponent(firstPageBody.pageInfo.nextCursor ?? '')}`
        )
      ).status
    ).toBe(400);
    const literalWildcard = await app.request('/collaborations/shared-by-me?type=note&q=%25');
    await expect(literalWildcard.json()).resolves.toMatchObject({ resources: [] });

    expect((await app.request('/collaborations/shared-by-me')).status).toBe(400);
    expect((await app.request('/collaborations/shared-by-me?type=note&cursor=invalid')).status).toBe(400);
    expect((await app.request(`/collaborations/shared-by-me?type=note&q=${'a'.repeat(201)}`)).status).toBe(400);
    const isolated = await app.request('/collaborations/shared-by-me?type=folder', {
      headers: { 'x-test-user': collaborator.id },
    });
    await expect(isolated.json()).resolves.toMatchObject({ resources: [] });
    libsql.close();
  });

  it('creates a safe pending invitation for an unknown email and regenerates it', async () => {
    const { app, db, libsql, schema } = await setup();
    const invite = () =>
      app.request('/folders/folder/collaborators', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'new@example.com', role: 'viewer' }),
      });

    const first = await invite();
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody).toMatchObject({
      kind: 'invitation',
      emailDelivery: 'disabled',
      invitation: {
        email: 'new@example.com',
        role: 'viewer',
        invitationUrl: expect.stringMatching(/^https:\/\/notes\.example\.com\/invite\/[A-Za-z0-9_-]+$/),
      },
    });
    expect(JSON.stringify(firstBody)).not.toContain('tokenHash');
    const [before] = await db.select().from(schema.collaborationInvitations);
    const firstToken = (firstBody.invitation as { invitationUrl: string }).invitationUrl.split('/').at(-1) ?? '';
    await db
      .update(schema.collaborationInvitations)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.collaborationInvitations.id, before.id));
    const expiredList = await app.request('/folders/folder/collaborators');
    await expect(expiredList.json()).resolves.toMatchObject({
      invitations: [{ id: before.id, email: 'n•••@e•••.com' }],
    });

    const resent = await app.request(`/collaboration-invitations/${before.id}/resend`, { method: 'POST' });
    expect(resent.status).toBe(200);
    const resentBody = (await resent.json()) as {
      emailDelivery: string;
      invitation: { invitationUrl: string };
    };
    expect(resentBody.emailDelivery).toBe('disabled');
    const resentToken = resentBody.invitation.invitationUrl.split('/').at(-1) ?? '';
    expect(resentToken).not.toBe(firstToken);
    expect((await app.request(`/collaboration-invitations/${firstToken}/preview`)).status).toBe(404);
    expect((await app.request(`/collaboration-invitations/${resentToken}/preview`)).status).toBe(200);

    const second = await invite();
    expect(second.status).toBe(201);
    const invitations = await db.select().from(schema.collaborationInvitations);
    expect(invitations).toHaveLength(1);
    expect(invitations[0]?.tokenHash).not.toBe(before.tokenHash);
    const denied = await app.request(`/collaboration-invitations/${invitations[0]?.id}`, {
      method: 'DELETE',
      headers: { 'x-test-user': 'other_owner' },
    });
    expect(denied.status).toBe(404);
    const revoked = await app.request(`/collaboration-invitations/${invitations[0]?.id}`, { method: 'DELETE' });
    expect(revoked.status).toBe(200);
    const [stored] = await db.select().from(schema.collaborationInvitations);
    expect(stored?.revokedAt).toBeInstanceOf(Date);
    const listed = await app.request('/folders/folder/collaborators');
    await expect(listed.json()).resolves.toMatchObject({ invitations: [] });
    libsql.close();
  });

  it('previews and atomically accepts an invitation with the matching verified account', async () => {
    const { app, db, libsql, schema, owner, collaborator } = await setup();
    const created = await app.request('/notes/note/collaborators', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'invitee@example.com', role: 'viewer' }),
    });
    const createdBody = (await created.json()) as { invitation: { invitationUrl: string } };
    const token = createdBody.invitation.invitationUrl.split('/').at(-1) ?? '';

    const preview = await app.request(`/collaboration-invitations/${token}/preview`);
    expect(preview.status).toBe(200);
    const previewBody = await preview.json();
    expect(previewBody).toMatchObject({
      resource: { type: 'note', id: 'note', title: 'Note' },
      owner: { name: 'Owner' },
      role: 'viewer',
      invitedEmail: 'i•••@e•••.com',
      status: 'pending',
    });
    expect(previewBody.owner).not.toHaveProperty('id');
    expectPrivacySafeCollaborationDto(previewBody, {
      forbiddenValues: [owner.id, collaborator.id, owner.email, collaborator.email, 'invitee@example.com', token],
    });

    const mismatch = await app.request(`/collaboration-invitations/${token}/accept`, {
      method: 'POST',
      headers: { 'x-test-user': collaborator.id },
    });
    expect(mismatch.status).toBe(403);

    await db.insert(schema.user).values({
      id: 'invitee',
      name: 'Invitee',
      email: 'invitee@example.com',
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const accept = () =>
      app.request(`/collaboration-invitations/${token}/accept`, {
        method: 'POST',
        headers: { 'x-test-user': 'invitee' },
      });
    const accepted = await accept();
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ destination: '/notes/note', alreadyAccepted: false });
    const replay = await accept();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ destination: '/notes/note', alreadyAccepted: true });

    const note = await app.request('/notes/note', { headers: { 'x-test-user': 'invitee' } });
    expect(note.status).toBe(200);
    expect(await note.json()).toMatchObject({ access: { role: 'viewer', source: 'note_grant' } });
    libsql.close();
  });

  it('allows Editors to Trash only resources they created under a shared folder', async () => {
    const { app, db, libsql, schema, owner, collaborator, otherOwner } = await setup();
    const now = new Date();
    await db.insert(schema.collaborationGrants).values({
      id: 'grant_editor_folder',
      ownerUserId: owner.id,
      granteeUserId: collaborator.id,
      noteId: null,
      folderId: 'folder',
      role: 'editor',
      createdByUserId: owner.id,
      createdAt: now,
      updatedAt: now,
    });

    const createdNote = await app.request('/folders/folder/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': collaborator.id },
      body: JSON.stringify({ title: 'Collaborator note' }),
    });
    expect(createdNote.status).toBe(201);
    const createdNoteBody = (await createdNote.json()) as { note: { id: string } };
    const [storedCreatedNote] = await db
      .select()
      .from(schema.notes)
      .where(eq(schema.notes.id, createdNoteBody.note.id));
    expect(storedCreatedNote).toMatchObject({ userId: owner.id, createdByUserId: collaborator.id });
    expectPrivacySafeCollaborationDto(createdNoteBody, { forbiddenValues: [owner.id, collaborator.id] });

    const createdFolder = await app.request('/folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': collaborator.id },
      body: JSON.stringify({ title: 'Collaborator folder', parentFolderId: 'folder' }),
    });
    expect(createdFolder.status).toBe(201);
    const createdFolderBody = (await createdFolder.json()) as { folder: { id: string } };
    const [storedCreatedFolder] = await db
      .select()
      .from(schema.folders)
      .where(eq(schema.folders.id, createdFolderBody.folder.id));
    expect(storedCreatedFolder).toMatchObject({ userId: owner.id, createdByUserId: collaborator.id });
    expectPrivacySafeCollaborationDto(createdFolderBody, { forbiddenValues: [owner.id, collaborator.id] });

    const readableCreatedNote = await app.request(`/notes/${createdNoteBody.note.id}`, {
      headers: { 'x-test-user': collaborator.id },
    });
    expect(readableCreatedNote.status).toBe(200);
    const readableCreatedNoteBody = await readableCreatedNote.json();
    expect(readableCreatedNoteBody).toMatchObject({ access: { role: 'editor', canTrash: true } });
    expectPrivacySafeCollaborationDto(readableCreatedNoteBody, { forbiddenValues: [owner.id, collaborator.id] });

    const folderDetail = await app.request('/folders/folder/detail', {
      headers: { 'x-test-user': collaborator.id },
    });
    expect(folderDetail.status).toBe(200);
    const folderDetailBody = (await folderDetail.json()) as {
      folder: { id: string; canTrash: boolean };
      childFolders: Array<{ id: string; canTrash: boolean }>;
    };
    expect(folderDetailBody.folder).toMatchObject({ id: 'folder', canTrash: false });
    expect(folderDetailBody.childFolders).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: createdFolderBody.folder.id, canTrash: true })])
    );
    expectPrivacySafeCollaborationDto(folderDetailBody, { forbiddenValues: [owner.id, collaborator.id] });

    const nestedNote = await app.request(`/folders/${createdFolderBody.folder.id}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': collaborator.id },
      body: JSON.stringify({ title: 'Nested collaborator note' }),
    });
    expect(nestedNote.status).toBe(201);

    await db.insert(schema.folders).values({
      id: 'direct_only_folder',
      userId: owner.id,
      createdByUserId: owner.id,
      parentFolderId: null,
      title: 'Direct only',
      isPrivate: false,
      isAgentReadOnly: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.notes).values({
      id: 'direct_only_note',
      userId: owner.id,
      createdByUserId: collaborator.id,
      folderId: 'direct_only_folder',
      title: 'Direct only note',
      content: '',
      documentType: 'markdown',
      type: 'note',
      isApiEditable: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.collaborationGrants).values({
      id: 'grant_direct_only_note',
      ownerUserId: owner.id,
      granteeUserId: collaborator.id,
      noteId: 'direct_only_note',
      folderId: null,
      role: 'editor',
      createdByUserId: owner.id,
      createdAt: now,
      updatedAt: now,
    });
    const directNoteDenied = await app.request('/notes/direct_only_note', {
      method: 'DELETE',
      headers: { 'x-test-user': collaborator.id },
    });
    expect(directNoteDenied.status).toBe(403);

    const ownerNoteDenied = await app.request('/notes/note', {
      method: 'DELETE',
      headers: { 'x-test-user': collaborator.id },
    });
    expect(ownerNoteDenied.status).toBe(403);
    const sharedRootDenied = await app.request('/folders/folder', {
      method: 'DELETE',
      headers: { 'x-test-user': collaborator.id },
    });
    expect(sharedRootDenied.status).toBe(403);

    const mixedBatch = await app.request('/notes/trash', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': collaborator.id },
      body: JSON.stringify({ noteIds: [createdNoteBody.note.id, 'note'] }),
    });
    expect(mixedBatch.status).toBe(403);
    const [stillActive] = await db
      .select({ deletedAt: schema.notes.deletedAt })
      .from(schema.notes)
      .where(eq(schema.notes.id, createdNoteBody.note.id));
    expect(stillActive.deletedAt).toBeNull();

    await db.insert(schema.collaborationGrants).values({
      id: 'grant_created_note_to_other',
      ownerUserId: owner.id,
      granteeUserId: otherOwner.id,
      noteId: createdNoteBody.note.id,
      folderId: null,
      role: 'viewer',
      createdByUserId: owner.id,
      createdAt: now,
      updatedAt: now,
    });
    const sharingConflict = await app.request(`/notes/${createdNoteBody.note.id}`, {
      method: 'DELETE',
      headers: { 'x-test-user': collaborator.id },
    });
    expect(sharingConflict.status).toBe(409);
    await db.delete(schema.collaborationGrants).where(eq(schema.collaborationGrants.id, 'grant_created_note_to_other'));

    const trashedNote = await app.request(`/notes/${createdNoteBody.note.id}`, {
      method: 'DELETE',
      headers: { 'x-test-user': collaborator.id },
    });
    expect(trashedNote.status).toBe(200);
    const [storedTrashedNote] = await db
      .select()
      .from(schema.notes)
      .where(eq(schema.notes.id, createdNoteBody.note.id));
    expect(storedTrashedNote).toMatchObject({ userId: owner.id, deletedAt: expect.any(Date) });

    await db.insert(schema.collaborationGrants).values({
      id: 'grant_created_folder_to_other',
      ownerUserId: owner.id,
      granteeUserId: otherOwner.id,
      noteId: null,
      folderId: createdFolderBody.folder.id,
      role: 'viewer',
      createdByUserId: owner.id,
      createdAt: now,
      updatedAt: now,
    });
    const conflictDetail = (await (
      await app.request('/folders/folder/detail', { headers: { 'x-test-user': collaborator.id } })
    ).json()) as { childFolders: Array<{ id: string; canTrash: boolean }> };
    expect(conflictDetail.childFolders).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: createdFolderBody.folder.id, canTrash: false })])
    );

    const folderSharingConflict = await app.request(`/folders/${createdFolderBody.folder.id}`, {
      method: 'DELETE',
      headers: { 'x-test-user': collaborator.id },
    });
    expect(folderSharingConflict.status).toBe(409);
    await db
      .delete(schema.collaborationGrants)
      .where(eq(schema.collaborationGrants.id, 'grant_created_folder_to_other'));

    await db.insert(schema.folders).values({
      id: 'owner_child_in_collaborator_folder',
      userId: owner.id,
      createdByUserId: owner.id,
      parentFolderId: createdFolderBody.folder.id,
      title: 'Owner child',
      isPrivate: false,
      isAgentReadOnly: false,
      createdAt: now,
      updatedAt: now,
    });
    const mixedCreatorDetail = (await (
      await app.request('/folders/folder/detail', { headers: { 'x-test-user': collaborator.id } })
    ).json()) as { childFolders: Array<{ id: string; canTrash: boolean }> };
    expect(mixedCreatorDetail.childFolders).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: createdFolderBody.folder.id, canTrash: false })])
    );

    const mixedCreatorFolder = await app.request(`/folders/${createdFolderBody.folder.id}`, {
      method: 'DELETE',
      headers: { 'x-test-user': collaborator.id },
    });
    expect(mixedCreatorFolder.status).toBe(403);
    await db.delete(schema.folders).where(eq(schema.folders.id, 'owner_child_in_collaborator_folder'));

    const trashedFolder = await app.request(`/folders/${createdFolderBody.folder.id}`, {
      method: 'DELETE',
      headers: { 'x-test-user': collaborator.id },
    });
    expect(trashedFolder.status).toBe(200);
    const [storedTrashedFolder] = await db
      .select()
      .from(schema.folders)
      .where(eq(schema.folders.id, createdFolderBody.folder.id));
    expect(storedTrashedFolder).toMatchObject({ userId: owner.id, deletedAt: expect.any(Date) });
    libsql.close();
  });

  it('keeps collaborator management owner-only and validates roles', async () => {
    const { app, libsql, otherOwner } = await setup();
    const forbidden = await app.request('/notes/note/collaborators', {
      headers: { 'x-test-user': otherOwner.id },
    });
    expect(forbidden.status).toBe(404);

    const invalid = await app.request('/notes/note/collaborators', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'collaborator@example.com', role: 'manager' }),
    });
    expect(invalid.status).toBe(400);

    const invalidEmail = await app.request('/notes/note/collaborators', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'person@localhost', role: 'viewer' }),
    });
    expect(invalidEmail.status).toBe(400);
    await expect(invalidEmail.json()).resolves.toEqual({ error: 'Valid email is required' });

    const self = await app.request('/notes/note/collaborators', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', role: 'viewer' }),
    });
    expect(self.status).toBe(400);
    libsql.close();
  });
});
