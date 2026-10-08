import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SharedWikilinkContext, SharedWikilinkRepository } from '../src/api/shared/wikilink-resolver';

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

async function setupResolver() {
  vi.resetModules();
  const dir = await mkdtemp(path.join(tmpdir(), 'notes-shared-wikilinks-'));
  tempDirs.push(dir);
  vi.stubEnv('TURSO_DB_URL', `file:${path.join(dir, 'test.db')}`);

  const [{ db, libsql }, schema, resolver] = await Promise.all([
    import('../src/api/db/client'),
    import('../src/api/db/schema'),
    import('../src/api/shared/wikilink-resolver'),
  ]);
  await runMigrations(libsql);

  const now = new Date();
  await db.insert(schema.user).values([
    {
      id: 'user_a',
      name: 'A',
      email: 'a@example.test',
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'user_b',
      name: 'B',
      email: 'b@example.test',
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.insert(schema.folders).values([
    {
      id: 'folder_root',
      userId: 'user_a',
      parentFolderId: null,
      title: 'Root',
      isPrivate: false,
      isAgentReadOnly: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'folder_sub',
      userId: 'user_a',
      parentFolderId: 'folder_root',
      title: 'Sub',
      isPrivate: false,
      isAgentReadOnly: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'folder_other',
      userId: 'user_a',
      parentFolderId: null,
      title: 'Other',
      isPrivate: false,
      isAgentReadOnly: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'folder_b',
      userId: 'user_b',
      parentFolderId: null,
      title: 'B',
      isPrivate: false,
      isAgentReadOnly: false,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  const note = (id: string, userId: string, folderId: string, title: string, content = '') => ({
    id,
    userId,
    folderId,
    title,
    content,
    documentType: 'markdown' as const,
    type: 'note' as const,
    isApiEditable: true,
    updatedByActorType: null,
    updatedByActorId: null,
    createdAt: now,
    updatedAt: now,
  });
  await db
    .insert(schema.notes)
    .values([
      note(
        'note_source',
        'user_a',
        'folder_root',
        'Source Note',
        '[[Source Note]] [[Shared Target]] [[Private Target]] [[Folder Target]] [[Missing]]'
      ),
      note('note_shared', 'user_a', 'folder_other', 'Shared Target'),
      note('note_private', 'user_a', 'folder_other', 'Private Target'),
      note('note_folder', 'user_a', 'folder_root', 'Folder Target'),
      note('note_sub', 'user_a', 'folder_sub', 'Sub Target'),
      note('note_outside', 'user_a', 'folder_other', 'Outside Target'),
      note('note_duplicatea', 'user_a', 'folder_root', 'Duplicate'),
      note('note_duplicateb', 'user_a', 'folder_other', 'Duplicate'),
      note('note_cross_user', 'user_b', 'folder_b', 'Cross User Target'),
    ]);

  async function addNoteShare(input: {
    id: string;
    noteId: string;
    token: string;
    revokedAt?: Date;
    expiresAt?: Date;
  }) {
    await db.insert(schema.noteShareLinks).values({
      id: input.id,
      userId: 'user_a',
      noteId: input.noteId,
      tokenHash: `hash_${input.token}`,
      token: input.token,
      permission: 'read',
      revokedAt: input.revokedAt,
      expiresAt: input.expiresAt,
      createdAt: now,
      updatedAt: now,
    });
  }

  function sourceContext(content?: string): SharedWikilinkContext {
    return {
      kind: 'note',
      token: 'source-token',
      source: {
        id: 'note_source',
        userId: 'user_a',
        title: 'Source Note',
        content: content ?? '[[Source Note]] [[Shared Target]] [[Private Target]] [[Folder Target]] [[Missing]]',
        documentType: 'markdown',
      },
    };
  }

  function folderContext(content: string): SharedWikilinkContext {
    return {
      kind: 'folder',
      token: 'folder-token',
      folderId: 'folder_root',
      source: {
        id: 'note_source',
        userId: 'user_a',
        title: 'Source Note',
        content,
        documentType: 'markdown',
      },
    };
  }

  return { db, schema, resolver, addNoteShare, sourceContext, folderContext };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('source-bound shared wikilink resolution', () => {
  it('resolves only authored self-links and independently shared targets in a note share', async () => {
    const ctx = await setupResolver();
    await ctx.addNoteShare({ id: 'share_target', noteId: 'note_shared', token: 'target-token' });

    const result = await ctx.resolver.resolveSourceWikilinks(
      ctx.sourceContext('[[Source Note]] [[Shared Target]] [[Private Target]]')
    );

    expect(result).toEqual([
      { target: 'Source Note', href: '/share/source-token' },
      { target: 'Shared Target', href: '/share/target-token' },
      { target: 'Private Target', href: null },
    ]);
    expect(result.every((resolution) => Object.keys(resolution).sort().join(',') === 'href,target')).toBe(true);
  });

  it('does not resolve arbitrary targets that are not authored in the source note', async () => {
    const ctx = await setupResolver();
    await ctx.addNoteShare({ id: 'share_target', noteId: 'note_shared', token: 'target-token' });

    await expect(
      ctx.resolver.resolveSourceWikilinks(
        ctx.sourceContext('No links here. `[[Shared Target]]`\n```md\n[[Private Target]]\n```')
      )
    ).resolves.toEqual([]);
  });

  it('does not bridge a note share into an unrelated active folder share', async () => {
    const ctx = await setupResolver();
    await ctx.db.insert(ctx.schema.folderShareLinks).values({
      id: 'folder_share',
      userId: 'user_a',
      folderId: 'folder_root',
      tokenHash: 'folder_hash',
      token: 'folder-token',
      permission: 'read',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(ctx.resolver.resolveSourceWikilinks(ctx.sourceContext('[[Folder Target]]'))).resolves.toEqual([
      { target: 'Folder Target', href: null },
    ]);
  });

  it('ignores revoked and expired target note shares', async () => {
    const ctx = await setupResolver();
    await ctx.addNoteShare({
      id: 'share_revoked',
      noteId: 'note_shared',
      token: 'revoked-token',
      revokedAt: new Date(),
    });
    await ctx.addNoteShare({
      id: 'share_expired',
      noteId: 'note_private',
      token: 'expired-token',
      expiresAt: new Date(Date.now() - 60_000),
    });

    await expect(
      ctx.resolver.resolveSourceWikilinks(ctx.sourceContext('[[Shared Target]] [[Private Target]]'))
    ).resolves.toEqual([
      { target: 'Shared Target', href: null },
      { target: 'Private Target', href: null },
    ]);
  });

  it('keeps ambiguous title links unresolved but resolves stable ID targets', async () => {
    const ctx = await setupResolver();
    await ctx.addNoteShare({ id: 'share_duplicate', noteId: 'note_duplicatea', token: 'duplicate-token' });

    await expect(
      ctx.resolver.resolveSourceWikilinks(ctx.sourceContext('[[Duplicate]] [[note_duplicatea|Stable duplicate]]'))
    ).resolves.toEqual([
      { target: 'Duplicate', href: null },
      { target: 'note_duplicatea', href: '/share/duplicate-token' },
    ]);
  });

  it('uses the current folder share for subtree targets and direct note shares outside it', async () => {
    const ctx = await setupResolver();
    await ctx.addNoteShare({ id: 'share_outside', noteId: 'note_outside', token: 'outside-token' });

    await expect(
      ctx.resolver.resolveSourceWikilinks(
        ctx.folderContext('[[Folder Target]] [[Sub Target]] [[Outside Target]] [[Private Target]]')
      )
    ).resolves.toEqual([
      { target: 'Folder Target', href: '/share/folders/folder-token?note=note_folder' },
      { target: 'Sub Target', href: '/share/folders/folder-token?note=note_sub' },
      { target: 'Outside Target', href: '/share/outside-token' },
      { target: 'Private Target', href: null },
    ]);
  });

  it("does not resolve another user's note with the same authored title", async () => {
    const ctx = await setupResolver();
    await expect(ctx.resolver.resolveSourceWikilinks(ctx.sourceContext('[[Cross User Target]]'))).resolves.toEqual([
      { target: 'Cross User Target', href: null },
    ]);
  });

  it('caps authored links and performs one repository call per batched data set', async () => {
    const targets = Array.from({ length: 150 }, (_, index) => `note_${index}`);
    const calls = { candidates: 0, shares: 0, folders: 0 };
    const repository: SharedWikilinkRepository = {
      async findCandidateNotes(_userId, idTargets) {
        calls.candidates += 1;
        return idTargets.map((id) => ({ id, folderId: 'folder_root', title: id }));
      },
      async findActiveNoteShares() {
        calls.shares += 1;
        return [];
      },
      async listFolders() {
        calls.folders += 1;
        return [{ id: 'folder_root', parentFolderId: null }];
      },
    };
    const context: SharedWikilinkContext = {
      kind: 'folder',
      token: 'folder-token',
      folderId: 'folder_root',
      source: {
        id: 'note_source',
        userId: 'user_a',
        title: 'Source',
        content: targets.map((target) => `[[${target}]]`).join(' '),
        documentType: 'markdown',
      },
    };

    const { resolveSourceWikilinks } = await import('../src/api/shared/wikilink-resolver');
    const result = await resolveSourceWikilinks(context, { repository });
    expect(result).toHaveLength(100);
    expect(calls).toEqual({ candidates: 1, shares: 1, folders: 1 });
  });
});
