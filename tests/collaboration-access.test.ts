import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
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
  const dir = await mkdtemp(path.join(tmpdir(), 'notes-collaboration-access-'));
  tempDirs.push(dir);
  vi.stubEnv('TURSO_DB_URL', `file:${path.join(dir, 'test.db')}`);

  const [{ db, libsql }, schema, access] = await Promise.all([
    import('../src/api/db/client'),
    import('../src/api/db/schema'),
    import('../src/api/lib/collaboration-access'),
  ]);
  await runMigrations(libsql);

  const now = new Date();
  await db.insert(schema.user).values([
    {
      id: 'owner',
      name: 'Owner',
      email: 'owner@example.com',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'collaborator',
      name: 'Collaborator',
      email: 'collaborator@example.com',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'stranger',
      name: 'Stranger',
      email: 'stranger@example.com',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.insert(schema.folders).values([
    {
      id: 'root',
      userId: 'owner',
      parentFolderId: null,
      title: 'Root',
      isPrivate: false,
      isAgentReadOnly: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'child',
      userId: 'owner',
      parentFolderId: 'root',
      title: 'Child',
      isPrivate: false,
      isAgentReadOnly: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'other',
      userId: 'owner',
      parentFolderId: null,
      title: 'Other',
      isPrivate: false,
      isAgentReadOnly: false,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.insert(schema.notes).values([
    {
      id: 'child_note',
      folderId: 'child',
      userId: 'owner',
      title: 'Child note',
      content: '',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'other_note',
      folderId: 'other',
      userId: 'owner',
      title: 'Other note',
      content: '',
      createdAt: now,
      updatedAt: now,
    },
  ]);

  return { db, libsql, schema, access, now };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('collaboration access resolution', () => {
  it('maps roles to their minimum capabilities', async () => {
    const { libsql, access } = await setup();
    expect(access.collaborationRoleAllows('viewer', 'read')).toBe(true);
    expect(access.collaborationRoleAllows('viewer', 'comment')).toBe(false);
    expect(access.collaborationRoleAllows('commenter', 'comment')).toBe(true);
    expect(access.collaborationRoleAllows('commenter', 'edit')).toBe(false);
    expect(access.collaborationRoleAllows('editor', 'create')).toBe(true);
    expect(access.collaborationRoleAllows('owner', 'edit')).toBe(true);
    libsql.close();
  });

  it('gives owners full access without a grant', async () => {
    const { libsql, access } = await setup();
    const result = await access.resolveNoteCollaborationAccess({ actorUserId: 'owner', noteId: 'child_note' });
    expect(result).toMatchObject({ role: 'owner', source: 'owner', resourceOwnerUserId: 'owner' });
    libsql.close();
  });

  it('inherits a folder grant through descendants but not sibling roots', async () => {
    const { db, libsql, schema, access, now } = await setup();
    await db.insert(schema.collaborationGrants).values({
      id: 'root_grant',
      ownerUserId: 'owner',
      granteeUserId: 'collaborator',
      noteId: null,
      folderId: 'root',
      role: 'commenter',
      createdByUserId: 'owner',
      createdAt: now,
      updatedAt: now,
    });

    const folder = await access.resolveFolderCollaborationAccess({ actorUserId: 'collaborator', folderId: 'child' });
    const note = await access.resolveNoteCollaborationAccess({ actorUserId: 'collaborator', noteId: 'child_note' });
    const sibling = await access.resolveNoteCollaborationAccess({ actorUserId: 'collaborator', noteId: 'other_note' });
    expect(folder).toMatchObject({ role: 'commenter', source: 'folder_grant' });
    expect(note).toMatchObject({ role: 'commenter', source: 'folder_grant' });
    expect(sibling).toBeNull();
    libsql.close();
  });

  it('uses the highest applicable direct or inherited grant', async () => {
    const { db, libsql, schema, access, now } = await setup();
    await db.insert(schema.collaborationGrants).values([
      {
        id: 'root_grant',
        ownerUserId: 'owner',
        granteeUserId: 'collaborator',
        noteId: null,
        folderId: 'root',
        role: 'viewer',
        createdByUserId: 'owner',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'note_grant',
        ownerUserId: 'owner',
        granteeUserId: 'collaborator',
        noteId: 'child_note',
        folderId: null,
        role: 'editor',
        createdByUserId: 'owner',
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const result = await access.resolveNoteCollaborationAccess({
      actorUserId: 'collaborator',
      noteId: 'child_note',
    });
    expect(result).toMatchObject({
      role: 'editor',
      source: 'note_grant',
      applicableGrantIds: expect.arrayContaining(['root_grant', 'note_grant']),
    });
    libsql.close();
  });

  it('intersects integration shared scope, human role, and owner agent-safety policy', async () => {
    const { db, libsql, schema, access, now } = await setup();
    await db.insert(schema.collaborationGrants).values({
      id: 'editor_grant',
      ownerUserId: 'owner',
      granteeUserId: 'collaborator',
      noteId: 'child_note',
      folderId: null,
      role: 'editor',
      createdByUserId: 'owner',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.integrationAuthorizations).values({
      id: 'authorization',
      userId: 'collaborator',
      sharedAccessMode: 'specific',
    });

    const resolve = (sharedAccessMode: 'none' | 'specific' | 'all', capability: 'read' | 'edit' = 'read') =>
      access.resolveIntegrationNoteAccess({
        actorUserId: 'collaborator',
        authorizationId: 'authorization',
        sharedAccessMode,
        noteId: 'child_note',
        capability,
      });
    await expect(resolve('none')).resolves.toBeNull();
    await expect(resolve('specific')).resolves.toBeNull();
    await expect(resolve('all')).resolves.toMatchObject({ role: 'editor', resourceOwnerUserId: 'owner' });

    await db.insert(schema.authorizationCollaborationScopes).values({
      id: 'selected_scope',
      authorizationId: 'authorization',
      userId: 'collaborator',
      collaborationGrantId: 'editor_grant',
    });
    await expect(resolve('specific', 'edit')).resolves.toMatchObject({ role: 'editor' });

    await db.update(schema.folders).set({ isAgentReadOnly: true }).where(eq(schema.folders.id, 'child'));
    await expect(resolve('specific', 'read')).resolves.toMatchObject({ role: 'editor' });
    await expect(resolve('specific', 'edit')).resolves.toBeNull();
    await db.update(schema.folders).set({ isAgentReadOnly: false }).where(eq(schema.folders.id, 'child'));
    await db.update(schema.notes).set({ isApiEditable: false }).where(eq(schema.notes.id, 'child_note'));
    await expect(resolve('specific', 'read')).resolves.toMatchObject({ role: 'editor' });
    await expect(resolve('specific', 'edit')).resolves.toBeNull();
    await db.update(schema.notes).set({ isApiEditable: true }).where(eq(schema.notes.id, 'child_note'));
    await db.update(schema.folders).set({ isPrivate: true }).where(eq(schema.folders.id, 'child'));
    await expect(resolve('specific', 'read')).resolves.toBeNull();

    await db.delete(schema.collaborationGrants).where(eq(schema.collaborationGrants.id, 'editor_grant'));
    await expect(resolve('all')).resolves.toBeNull();
    await expect(db.select().from(schema.authorizationCollaborationScopes)).resolves.toHaveLength(0);
    libsql.close();
  });

  it('calculates specific integration access from selected grants only', async () => {
    const { db, libsql, schema, access, now } = await setup();
    await db.insert(schema.collaborationGrants).values([
      {
        id: 'root_viewer',
        ownerUserId: 'owner',
        granteeUserId: 'collaborator',
        noteId: null,
        folderId: 'root',
        role: 'viewer',
        createdByUserId: 'owner',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'direct_editor',
        ownerUserId: 'owner',
        granteeUserId: 'collaborator',
        noteId: 'child_note',
        folderId: null,
        role: 'editor',
        createdByUserId: 'owner',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'child_editor',
        ownerUserId: 'owner',
        granteeUserId: 'collaborator',
        noteId: null,
        folderId: 'child',
        role: 'editor',
        createdByUserId: 'owner',
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(schema.integrationAuthorizations).values({
      id: 'authorization',
      userId: 'collaborator',
      sharedAccessMode: 'specific',
    });
    await db.insert(schema.authorizationCollaborationScopes).values({
      id: 'selected_scope',
      authorizationId: 'authorization',
      userId: 'collaborator',
      collaborationGrantId: 'root_viewer',
    });

    const noteInput = (capability: 'read' | 'edit') => ({
      actorUserId: 'collaborator',
      authorizationId: 'authorization',
      sharedAccessMode: 'specific' as const,
      noteId: 'child_note',
      capability,
    });
    const folderInput = (capability: 'read' | 'create') => ({
      actorUserId: 'collaborator',
      authorizationId: 'authorization',
      sharedAccessMode: 'specific' as const,
      folderId: 'child',
      capability,
    });

    await expect(access.resolveIntegrationNoteAccess(noteInput('read'))).resolves.toMatchObject({
      role: 'viewer',
      source: 'folder_grant',
      applicableGrantIds: ['root_viewer'],
    });
    await expect(access.resolveIntegrationNoteAccess(noteInput('edit'))).resolves.toBeNull();
    await expect(access.resolveIntegrationFolderAccess(folderInput('read'))).resolves.toMatchObject({
      role: 'viewer',
      applicableGrantIds: ['root_viewer'],
    });
    await expect(access.resolveIntegrationFolderAccess(folderInput('create'))).resolves.toBeNull();

    await db
      .delete(schema.authorizationCollaborationScopes)
      .where(eq(schema.authorizationCollaborationScopes.id, 'selected_scope'));
    await db
      .update(schema.collaborationGrants)
      .set({ role: 'editor' })
      .where(eq(schema.collaborationGrants.id, 'root_viewer'));
    await db
      .update(schema.collaborationGrants)
      .set({ role: 'viewer' })
      .where(eq(schema.collaborationGrants.id, 'direct_editor'));
    await db.insert(schema.authorizationCollaborationScopes).values({
      id: 'selected_direct_scope',
      authorizationId: 'authorization',
      userId: 'collaborator',
      collaborationGrantId: 'direct_editor',
    });

    await expect(access.resolveIntegrationNoteAccess(noteInput('read'))).resolves.toMatchObject({
      role: 'viewer',
      source: 'note_grant',
      applicableGrantIds: ['direct_editor'],
    });
    await expect(access.resolveIntegrationNoteAccess(noteInput('edit'))).resolves.toBeNull();
    await expect(access.resolveIntegrationFolderAccess(folderInput('read'))).resolves.toBeNull();
    libsql.close();
  });

  it('does not expose trashed notes or folders and denies users without grants', async () => {
    const { db, libsql, schema, access, now } = await setup();
    await db.insert(schema.collaborationGrants).values({
      id: 'root_grant',
      ownerUserId: 'owner',
      granteeUserId: 'collaborator',
      noteId: null,
      folderId: 'root',
      role: 'editor',
      createdByUserId: 'owner',
      createdAt: now,
      updatedAt: now,
    });
    await db.update(schema.folders).set({ deletedAt: now }).where(eq(schema.folders.id, 'root'));

    expect(
      await access.resolveNoteCollaborationAccess({ actorUserId: 'collaborator', noteId: 'child_note' })
    ).toBeNull();
    expect(
      await access.resolveFolderCollaborationAccess({ actorUserId: 'collaborator', folderId: 'child' })
    ).toBeNull();
    expect(await access.resolveNoteCollaborationAccess({ actorUserId: 'stranger', noteId: 'other_note' })).toBeNull();
    libsql.close();
  });
});
