import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  type SQL,
  type SQLWrapper,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { db, libsql } from '../db/client';
import { authorizationCollaborationScopes, collaborationGrants, folders, notes, user } from '../db/schema';
import { activeFolderPathWhere, filterActiveFolderHierarchy } from '../trash/policy';
import {
  type CollaborationIdentity,
  publicCollaborationAccessKey,
  serializeCollaborationUserIdentity,
} from './collaboration-identity';
import { isDescendantOrSelf, loadFolderAccessTree } from './folder-access';

export type CollaborationRole = 'viewer' | 'commenter' | 'editor';
export type EffectiveCollaborationRole = CollaborationRole | 'owner';
export type CollaborationCapability = 'read' | 'comment' | 'edit' | 'create';
export type CollaborationAccessSource = 'owner' | 'note_grant' | 'folder_grant';
export type SharedAccessMode = 'none' | 'specific' | 'all';

export type CollaborationAccess = {
  actorUserId: string;
  resourceOwnerUserId: string;
  role: EffectiveCollaborationRole;
  source: CollaborationAccessSource;
  applicableGrantIds: string[];
};

export function serializeCollaborationAccess(access: CollaborationAccess) {
  return { role: access.role, source: access.source };
}

const ROLE_RANK: Record<EffectiveCollaborationRole, number> = {
  viewer: 1,
  commenter: 2,
  editor: 3,
  owner: 4,
};

const CAPABILITY_MINIMUM_ROLE: Record<CollaborationCapability, EffectiveCollaborationRole> = {
  read: 'viewer',
  comment: 'commenter',
  edit: 'editor',
  create: 'editor',
};

export function highestCollaborationRole(roles: CollaborationRole[]): CollaborationRole | null {
  let highest: CollaborationRole | null = null;
  for (const role of roles) {
    if (!highest || ROLE_RANK[role] > ROLE_RANK[highest]) highest = role;
  }
  return highest;
}

export function collaborationRoleAllows(role: EffectiveCollaborationRole | null, capability: CollaborationCapability) {
  return role !== null && ROLE_RANK[role] >= ROLE_RANK[CAPABILITY_MINIMUM_ROLE[capability]];
}

function grantRolesForCapability(capability: CollaborationCapability) {
  if (capability === 'read') return sql`('viewer', 'commenter', 'editor')`;
  if (capability === 'comment') return sql`('commenter', 'editor')`;
  return sql`('editor')`;
}

export function hasFolderCollaborationAccessSql(input: {
  actorUserId: string;
  folderId: SQLWrapper;
  ownerUserId: SQLWrapper;
  capability?: CollaborationCapability;
}) {
  const roles = grantRolesForCapability(input.capability ?? 'read');
  return sql<boolean>`(
    ${input.ownerUserId} = ${input.actorUserId}
    or exists (
      with recursive collaboration_folder_path(id, parent_folder_id) as (
        select access_folder.id, access_folder.parent_folder_id
        from ${folders} as access_folder
        where access_folder.id = ${input.folderId}
          and access_folder.user_id = ${input.ownerUserId}
        union
        select access_parent.id, access_parent.parent_folder_id
        from ${folders} as access_parent
        inner join collaboration_folder_path as access_child on access_parent.id = access_child.parent_folder_id
        where access_parent.user_id = ${input.ownerUserId}
      )
      select 1
      from collaboration_folder_path
      inner join ${collaborationGrants} as access_grant on access_grant.folder_id = collaboration_folder_path.id
      where access_grant.owner_user_id = ${input.ownerUserId}
        and access_grant.grantee_user_id = ${input.actorUserId}
        and access_grant.role in ${roles}
    )
  )`;
}

export function integrationAccessibleNoteWhere(
  input: {
    actorUserId: string;
    authorizationId: string;
    sharedAccessMode: SharedAccessMode;
    capability?: CollaborationCapability;
    ownedFolderIds: ReadonlySet<string>;
  },
  ...conditions: Array<SQL | undefined>
) {
  const capability = input.capability ?? 'read';
  const roles = grantRolesForCapability(capability);
  const selectedDirectScope =
    input.sharedAccessMode === 'specific'
      ? sql`and exists (
          select 1 from ${authorizationCollaborationScopes} as direct_scope
          where direct_scope.authorization_id = ${input.authorizationId}
            and direct_scope.user_id = ${input.actorUserId}
            and direct_scope.collaboration_grant_id = integration_note_grant.id
        )`
      : sql``;
  const selectedFolderScope =
    input.sharedAccessMode === 'specific'
      ? sql`and exists (
          select 1 from ${authorizationCollaborationScopes} as folder_scope
          where folder_scope.authorization_id = ${input.authorizationId}
            and folder_scope.user_id = ${input.actorUserId}
            and folder_scope.collaboration_grant_id = integration_folder_grant.id
        )`
      : sql``;
  const ownedFolderIds = [...input.ownedFolderIds];
  const ownedAccess = and(
    eq(notes.userId, input.actorUserId),
    ownedFolderIds.length > 0 ? inArray(notes.folderId, ownedFolderIds) : sql`0`
  );
  const sharedAccess =
    input.sharedAccessMode === 'none'
      ? sql<boolean>`0`
      : sql<boolean>`(
          ${notes.userId} <> ${input.actorUserId}
          and not exists (
            with recursive integration_private_path(id, parent_folder_id, is_private) as (
              select private_folder.id, private_folder.parent_folder_id, private_folder.is_private
              from ${folders} as private_folder
              where private_folder.id = ${notes.folderId} and private_folder.user_id = ${notes.userId}
              union
              select private_parent.id, private_parent.parent_folder_id, private_parent.is_private
              from ${folders} as private_parent
              inner join integration_private_path as private_child
                on private_parent.id = private_child.parent_folder_id
              where private_parent.user_id = ${notes.userId}
            )
            select 1 from integration_private_path where is_private = 1
          )
          and (
            exists (
              select 1 from ${collaborationGrants} as integration_note_grant
              where integration_note_grant.note_id = ${notes.id}
                and integration_note_grant.owner_user_id = ${notes.userId}
                and integration_note_grant.grantee_user_id = ${input.actorUserId}
                and integration_note_grant.role in ${roles}
                ${selectedDirectScope}
            )
            or exists (
              with recursive integration_folder_path(id, parent_folder_id) as (
                select integration_folder.id, integration_folder.parent_folder_id
                from ${folders} as integration_folder
                where integration_folder.id = ${notes.folderId}
                  and integration_folder.user_id = ${notes.userId}
                union
                select integration_parent.id, integration_parent.parent_folder_id
                from ${folders} as integration_parent
                inner join integration_folder_path as integration_child
                  on integration_parent.id = integration_child.parent_folder_id
                where integration_parent.user_id = ${notes.userId}
              )
              select 1
              from integration_folder_path
              inner join ${collaborationGrants} as integration_folder_grant
                on integration_folder_grant.folder_id = integration_folder_path.id
              where integration_folder_grant.owner_user_id = ${notes.userId}
                and integration_folder_grant.grantee_user_id = ${input.actorUserId}
                and integration_folder_grant.role in ${roles}
                ${selectedFolderScope}
            )
          )
        )`;
  return and(
    collaborationAccessibleNoteWhere(input.actorUserId, capability),
    or(ownedAccess, sharedAccess),
    ...conditions
  );
}

export function integrationAccessibleFolderWhere(
  input: {
    actorUserId: string;
    authorizationId: string;
    sharedAccessMode: SharedAccessMode;
    capability?: CollaborationCapability;
    ownedFolderIds: ReadonlySet<string>;
  },
  ...conditions: Array<SQL | undefined>
) {
  const roles = grantRolesForCapability(input.capability ?? 'read');
  const selectedScope =
    input.sharedAccessMode === 'specific'
      ? sql`and exists (
          select 1 from ${authorizationCollaborationScopes} as folder_scope
          where folder_scope.authorization_id = ${input.authorizationId}
            and folder_scope.user_id = ${input.actorUserId}
            and folder_scope.collaboration_grant_id = integration_folder_grant.id
        )`
      : sql``;
  const ownedFolderIds = [...input.ownedFolderIds];
  const ownedAccess = and(
    eq(folders.userId, input.actorUserId),
    ownedFolderIds.length > 0 ? inArray(folders.id, ownedFolderIds) : sql`0`
  );
  const sharedAccess =
    input.sharedAccessMode === 'none'
      ? sql<boolean>`0`
      : sql<boolean>`(
          ${folders.userId} <> ${input.actorUserId}
          and not exists (
            with recursive integration_private_path(id, parent_folder_id, is_private) as (
              select private_folder.id, private_folder.parent_folder_id, private_folder.is_private
              from ${folders} as private_folder
              where private_folder.id = ${folders.id} and private_folder.user_id = ${folders.userId}
              union
              select private_parent.id, private_parent.parent_folder_id, private_parent.is_private
              from ${folders} as private_parent
              inner join integration_private_path as private_child
                on private_parent.id = private_child.parent_folder_id
              where private_parent.user_id = ${folders.userId}
            )
            select 1 from integration_private_path where is_private = 1
          )
          and exists (
            with recursive integration_folder_path(id, parent_folder_id) as (
              select integration_folder.id, integration_folder.parent_folder_id
              from ${folders} as integration_folder
              where integration_folder.id = ${folders.id}
                and integration_folder.user_id = ${folders.userId}
              union
              select integration_parent.id, integration_parent.parent_folder_id
              from ${folders} as integration_parent
              inner join integration_folder_path as integration_child
                on integration_parent.id = integration_child.parent_folder_id
              where integration_parent.user_id = ${folders.userId}
            )
            select 1
            from integration_folder_path
            inner join ${collaborationGrants} as integration_folder_grant
              on integration_folder_grant.folder_id = integration_folder_path.id
            where integration_folder_grant.owner_user_id = ${folders.userId}
              and integration_folder_grant.grantee_user_id = ${input.actorUserId}
              and integration_folder_grant.role in ${roles}
              ${selectedScope}
          )
        )`;
  return and(
    isNull(folders.deletedAt),
    sql`exists (
      with recursive active_integration_folder_path(id, parent_folder_id, deleted_at) as (
        select active_folder.id, active_folder.parent_folder_id, active_folder.deleted_at
        from ${folders} as active_folder
        where active_folder.id = ${folders.id} and active_folder.user_id = ${folders.userId}
        union
        select active_parent.id, active_parent.parent_folder_id, active_parent.deleted_at
        from ${folders} as active_parent
        inner join active_integration_folder_path as active_child on active_parent.id = active_child.parent_folder_id
        where active_parent.user_id = ${folders.userId}
      )
      select 1
      where exists (select 1 from active_integration_folder_path where parent_folder_id is null)
        and not exists (select 1 from active_integration_folder_path where deleted_at is not null)
    )`,
    or(ownedAccess, sharedAccess),
    ...conditions
  );
}

export function collaborationAccessibleNoteWhere(
  actorUserId: string,
  capability: CollaborationCapability = 'read',
  ...conditions: Array<SQL | undefined>
) {
  const roles = grantRolesForCapability(capability);
  return and(
    isNull(notes.deletedAt),
    sql`exists (
      with recursive active_collaboration_path(id, parent_folder_id, deleted_at) as (
        select active_folder.id, active_folder.parent_folder_id, active_folder.deleted_at
        from ${folders} as active_folder
        where active_folder.id = ${notes.folderId} and active_folder.user_id = ${notes.userId}
        union
        select active_parent.id, active_parent.parent_folder_id, active_parent.deleted_at
        from ${folders} as active_parent
        inner join active_collaboration_path as active_child on active_parent.id = active_child.parent_folder_id
        where active_parent.user_id = ${notes.userId}
      )
      select 1
      where exists (select 1 from active_collaboration_path where parent_folder_id is null)
        and not exists (select 1 from active_collaboration_path where deleted_at is not null)
    )`,
    or(
      eq(notes.userId, actorUserId),
      sql`exists (
        select 1 from ${collaborationGrants} as direct_note_grant
        where direct_note_grant.note_id = ${notes.id}
          and direct_note_grant.owner_user_id = ${notes.userId}
          and direct_note_grant.grantee_user_id = ${actorUserId}
          and direct_note_grant.role in ${roles}
      )`,
      hasFolderCollaborationAccessSql({
        actorUserId,
        folderId: notes.folderId,
        ownerUserId: notes.userId,
        capability,
      })
    ),
    ...conditions
  );
}

function accessFromGrants(input: {
  actorUserId: string;
  resourceOwnerUserId: string;
  grants: Array<{ id: string; role: CollaborationRole; noteId: string | null }>;
}): CollaborationAccess | null {
  const role = highestCollaborationRole(input.grants.map((grant) => grant.role));
  if (!role) return null;
  const highestGrants = input.grants.filter((grant) => grant.role === role);
  return {
    actorUserId: input.actorUserId,
    resourceOwnerUserId: input.resourceOwnerUserId,
    role,
    source: highestGrants.some((grant) => grant.noteId !== null) ? 'note_grant' : 'folder_grant',
    applicableGrantIds: input.grants.map((grant) => grant.id),
  };
}

function ownerAccess(actorUserId: string): CollaborationAccess {
  return {
    actorUserId,
    resourceOwnerUserId: actorUserId,
    role: 'owner',
    source: 'owner',
    applicableGrantIds: [],
  };
}

type FolderPathRow = {
  resource_id: string;
  id: string;
  user_id: string;
  parent_folder_id: string | null;
  deleted_at: number | null;
  is_private: number;
};

async function loadFolderPaths(
  resources: ReadonlyArray<{ id: string; folderId: string; userId: string }>
): Promise<Map<string, FolderPathRow[]>> {
  if (resources.length === 0) return new Map();
  const values = resources.map(() => '(?, ?, ?)').join(', ');
  const result = await libsql.execute({
    sql: `WITH RECURSIVE requested(resource_id, folder_id, user_id) AS (VALUES ${values}),
      folder_path(resource_id, id, user_id, parent_folder_id, deleted_at, is_private) AS (
        SELECT requested.resource_id, target.id, target.user_id, target.parent_folder_id, target.deleted_at, target.is_private
        FROM requested
        INNER JOIN folders AS target ON target.id = requested.folder_id AND target.user_id = requested.user_id
        UNION
        SELECT child.resource_id, parent.id, parent.user_id, parent.parent_folder_id, parent.deleted_at, parent.is_private
        FROM folder_path AS child
        INNER JOIN folders AS parent ON parent.id = child.parent_folder_id AND parent.user_id = child.user_id
      )
      SELECT resource_id, id, user_id, parent_folder_id, deleted_at, is_private FROM folder_path`,
    args: resources.flatMap((resource) => [resource.id, resource.folderId, resource.userId]),
  });
  const rows = result.rows as unknown as FolderPathRow[];
  const rowsByResourceId = new Map<string, FolderPathRow[]>();
  for (const row of rows)
    rowsByResourceId.set(row.resource_id, [...(rowsByResourceId.get(row.resource_id) ?? []), row]);
  return new Map(
    [...rowsByResourceId].filter(
      ([, path]) =>
        path.every((folder) => folder.deleted_at === null) && path.some((folder) => folder.parent_folder_id === null)
    )
  );
}

export async function resolveFolderCollaborationAccess(input: {
  actorUserId: string;
  folderId: string;
  allowedGrantIds?: readonly string[];
}): Promise<CollaborationAccess | null> {
  const [folder] = await db
    .select()
    .from(folders)
    .where(and(eq(folders.id, input.folderId), isNull(folders.deletedAt)))
    .limit(1);
  if (!folder) return null;

  const tree = await loadFolderAccessTree(folder.userId);
  if (!tree.byId.has(folder.id)) return null;
  if (folder.userId === input.actorUserId) return ownerAccess(input.actorUserId);

  const ancestorIds = tree.folders
    .filter((candidate) => isDescendantOrSelf(folder.id, candidate.id, tree.byId))
    .map((candidate) => candidate.id);
  if (ancestorIds.length === 0) return null;

  const grants = await db
    .select({
      id: collaborationGrants.id,
      role: collaborationGrants.role,
      noteId: collaborationGrants.noteId,
    })
    .from(collaborationGrants)
    .where(
      and(
        eq(collaborationGrants.granteeUserId, input.actorUserId),
        eq(collaborationGrants.ownerUserId, folder.userId),
        inArray(collaborationGrants.folderId, ancestorIds),
        input.allowedGrantIds ? inArray(collaborationGrants.id, [...input.allowedGrantIds]) : undefined
      )
    );

  return accessFromGrants({ actorUserId: input.actorUserId, resourceOwnerUserId: folder.userId, grants });
}

export async function resolveFolderNavigationAccess(input: { actorUserId: string; folderId: string }) {
  const pathResult = await libsql.execute({
    sql: `WITH RECURSIVE folder_path(id, parent_folder_id, deleted_at, user_id) AS (
      SELECT id, parent_folder_id, deleted_at, user_id FROM folders WHERE id = ?
      UNION
      SELECT parent.id, parent.parent_folder_id, parent.deleted_at, parent.user_id
      FROM folders AS parent
      INNER JOIN folder_path AS child ON parent.id = child.parent_folder_id AND parent.user_id = child.user_id
    )
    SELECT id, parent_folder_id, deleted_at, user_id FROM folder_path`,
    args: [input.folderId],
  });
  const pathRows = pathResult.rows as unknown as Array<{
    id: string;
    parent_folder_id: string | null;
    deleted_at: number | null;
    user_id: string;
  }>;
  const target = pathRows.find((folder) => folder.id === input.folderId);
  if (!target || pathRows.some((folder) => folder.deleted_at !== null)) return null;
  const root = pathRows.find((folder) => folder.parent_folder_id === null);
  if (!root) return null;
  const resourceOwnerUserId = target.user_id;
  if (resourceOwnerUserId === input.actorUserId) return { resourceOwnerUserId, role: 'owner' as const };

  const grants = await db
    .select({ role: collaborationGrants.role })
    .from(collaborationGrants)
    .where(
      and(
        eq(collaborationGrants.granteeUserId, input.actorUserId),
        eq(collaborationGrants.ownerUserId, resourceOwnerUserId),
        inArray(
          collaborationGrants.folderId,
          pathRows.map((folder) => folder.id)
        )
      )
    );
  const role = highestCollaborationRole(grants.map((grant) => grant.role));
  return role ? { resourceOwnerUserId, role } : null;
}

export class InvalidDirectCollaborationCursorError extends Error {}

type DirectCollaborationCursor = { resourceId: string; updatedAt: number };

function decodeDirectCollaborationCursor(value: string): DirectCollaborationCursor {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      resourceId?: unknown;
      updatedAt?: unknown;
    };
    if (
      typeof decoded.resourceId !== 'string' ||
      typeof decoded.updatedAt !== 'number' ||
      !Number.isFinite(decoded.updatedAt)
    )
      throw new InvalidDirectCollaborationCursorError();
    return { resourceId: decoded.resourceId, updatedAt: decoded.updatedAt };
  } catch (error) {
    if (error instanceof InvalidDirectCollaborationCursorError) throw error;
    throw new InvalidDirectCollaborationCursorError();
  }
}

function encodeDirectCollaborationCursor(cursor: DirectCollaborationCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

type DirectCollaborationPageItem =
  | {
      type: 'note';
      grantId: string;
      role: EffectiveCollaborationRole;
      owner: CollaborationIdentity;
      note: {
        id: string;
        title: string;
        documentType: 'markdown' | 'canvas.default' | 'canvas.mindmap';
        updatedAt: Date;
      };
    }
  | {
      type: 'folder';
      grantId: string;
      role: EffectiveCollaborationRole;
      owner: CollaborationIdentity;
      folder: { id: string; title: string; updatedAt: Date };
    };

export async function listDirectCollaborationsPage(input: {
  actorUserId: string;
  type: 'note' | 'folder';
  cursor?: string;
  limit?: number;
}) {
  const limit = Math.min(50, Math.max(1, input.limit ?? 25));
  let scanCursor = input.cursor ? decodeDirectCollaborationCursor(input.cursor) : undefined;
  const candidates: Array<{ item: DirectCollaborationPageItem; cursor: DirectCollaborationCursor }> = [];
  let exhausted = false;

  while (candidates.length <= limit && !exhausted) {
    const batchSize = Math.max(25, limit + 1 - candidates.length);
    if (input.type === 'note') {
      const afterCursor = scanCursor
        ? or(
            lt(notes.updatedAt, new Date(scanCursor.updatedAt)),
            and(eq(notes.updatedAt, new Date(scanCursor.updatedAt)), gt(notes.id, scanCursor.resourceId))
          )
        : undefined;
      const rows = await db
        .select({
          grantId: collaborationGrants.id,
          owner: { id: user.id, name: user.name, email: user.email },
          note: {
            id: notes.id,
            folderId: notes.folderId,
            title: notes.title,
            documentType: notes.documentType,
            updatedAt: notes.updatedAt,
          },
        })
        .from(collaborationGrants)
        .innerJoin(user, eq(collaborationGrants.ownerUserId, user.id))
        .innerJoin(
          notes,
          and(
            eq(collaborationGrants.noteId, notes.id),
            eq(collaborationGrants.ownerUserId, notes.userId),
            isNull(notes.deletedAt),
            activeFolderPathWhere(sql.raw('"notes"."folder_id"'), sql.raw('"notes"."user_id"'))
          )
        )
        .where(
          and(
            eq(collaborationGrants.granteeUserId, input.actorUserId),
            isNotNull(collaborationGrants.noteId),
            afterCursor
          )
        )
        .orderBy(desc(notes.updatedAt), asc(notes.id))
        .limit(batchSize);
      const accessByNoteId = await resolveNoteCollaborationAccessBatch({
        actorUserId: input.actorUserId,
        resources: rows.map((row) => ({ id: row.note.id, folderId: row.note.folderId, userId: row.owner.id })),
      });
      for (const row of rows) {
        const access = accessByNoteId.get(row.note.id);
        if (!access) continue;
        candidates.push({
          cursor: { resourceId: row.note.id, updatedAt: row.note.updatedAt.getTime() },
          item: {
            type: 'note',
            grantId: publicCollaborationAccessKey(row.grantId),
            role: access.role,
            owner: serializeCollaborationUserIdentity({ ...row.owner, currentUserId: input.actorUserId }),
            note: {
              id: row.note.id,
              title: row.note.title,
              documentType: row.note.documentType,
              updatedAt: row.note.updatedAt,
            },
          },
        });
      }
      const lastScanned = rows.at(-1);
      if (lastScanned)
        scanCursor = { resourceId: lastScanned.note.id, updatedAt: lastScanned.note.updatedAt.getTime() };
      exhausted = rows.length < batchSize;
    } else {
      const afterCursor = scanCursor
        ? or(
            lt(folders.updatedAt, new Date(scanCursor.updatedAt)),
            and(eq(folders.updatedAt, new Date(scanCursor.updatedAt)), gt(folders.id, scanCursor.resourceId))
          )
        : undefined;
      const rows = await db
        .select({
          grantId: collaborationGrants.id,
          owner: { id: user.id, name: user.name, email: user.email },
          folder: { id: folders.id, title: folders.title, updatedAt: folders.updatedAt },
        })
        .from(collaborationGrants)
        .innerJoin(user, eq(collaborationGrants.ownerUserId, user.id))
        .innerJoin(
          folders,
          and(
            eq(collaborationGrants.folderId, folders.id),
            eq(collaborationGrants.ownerUserId, folders.userId),
            isNull(folders.deletedAt),
            activeFolderPathWhere(sql.raw('"folders"."id"'), sql.raw('"folders"."user_id"'))
          )
        )
        .where(
          and(
            eq(collaborationGrants.granteeUserId, input.actorUserId),
            isNotNull(collaborationGrants.folderId),
            afterCursor
          )
        )
        .orderBy(desc(folders.updatedAt), asc(folders.id))
        .limit(batchSize);
      const accessByFolderId = await resolveFolderCollaborationAccessBatch({
        actorUserId: input.actorUserId,
        resources: rows.map((row) => ({ id: row.folder.id, userId: row.owner.id })),
      });
      for (const row of rows) {
        const access = accessByFolderId.get(row.folder.id);
        if (!access) continue;
        candidates.push({
          cursor: { resourceId: row.folder.id, updatedAt: row.folder.updatedAt.getTime() },
          item: {
            type: 'folder',
            grantId: publicCollaborationAccessKey(row.grantId),
            role: access.role,
            owner: serializeCollaborationUserIdentity({ ...row.owner, currentUserId: input.actorUserId }),
            folder: { id: row.folder.id, title: row.folder.title, updatedAt: row.folder.updatedAt },
          },
        });
      }
      const lastScanned = rows.at(-1);
      if (lastScanned)
        scanCursor = { resourceId: lastScanned.folder.id, updatedAt: lastScanned.folder.updatedAt.getTime() };
      exhausted = rows.length < batchSize;
    }
  }

  const hasMore = candidates.length > limit;
  const page = candidates.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(({ item }) => item),
    pageInfo: {
      hasMore,
      nextCursor: hasMore && last ? encodeDirectCollaborationCursor(last.cursor) : null,
    },
  };
}

const childFolders = alias(folders, 'child');

export async function listSharedFolderRoots(input: { actorUserId: string; limit?: number }) {
  const limit = Math.min(100, Math.max(1, input.limit ?? 50));
  const rows = await db
    .select({
      grantId: collaborationGrants.id,
      folder: { id: folders.id, userId: folders.userId, title: folders.title, updatedAt: folders.updatedAt },
      hasChildren: exists(
        db
          .select({ one: sql`1` })
          .from(childFolders)
          .where(
            and(
              eq(childFolders.userId, folders.userId),
              eq(childFolders.parentFolderId, folders.id),
              isNull(childFolders.deletedAt)
            )
          )
      ),
    })
    .from(collaborationGrants)
    .innerJoin(
      folders,
      and(
        eq(collaborationGrants.folderId, folders.id),
        eq(collaborationGrants.ownerUserId, folders.userId),
        isNull(folders.deletedAt),
        activeFolderPathWhere(sql.raw('"folders"."id"'), sql.raw('"folders"."user_id"'))
      )
    )
    .where(
      and(
        eq(collaborationGrants.granteeUserId, input.actorUserId),
        isNotNull(collaborationGrants.folderId),
        sql`not exists (
          with recursive folder_ancestors(id, parent_folder_id) as (
            select parent.id, parent.parent_folder_id
            from ${folders} as parent
            where parent.id = ${sql.raw('"folders"."parent_folder_id"')}
              and parent.user_id = ${sql.raw('"folders"."user_id"')}
            union
            select parent.id, parent.parent_folder_id
            from ${folders} as parent
            inner join folder_ancestors as child on parent.id = child.parent_folder_id
            where parent.user_id = ${sql.raw('"folders"."user_id"')}
          )
          select 1
          from folder_ancestors as ancestor
          inner join ${collaborationGrants} as ancestor_grant on ancestor_grant.folder_id = ancestor.id
          where ancestor_grant.owner_user_id = ${sql.raw('"collaboration_grants"."owner_user_id"')}
            and ancestor_grant.grantee_user_id = ${input.actorUserId}
        )`
      )
    )
    .orderBy(asc(folders.title), asc(folders.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const accessByFolderId = await resolveFolderCollaborationAccessBatch({
    actorUserId: input.actorUserId,
    resources: page.map((row) => ({ id: row.folder.id, userId: row.folder.userId })),
  });
  return {
    folders: page.flatMap((row) => {
      const access = accessByFolderId.get(row.folder.id);
      if (!access || access.applicableGrantIds.some((grantId) => grantId !== row.grantId)) return [];
      return [
        {
          id: row.folder.id,
          title: row.folder.title,
          updatedAt: row.folder.updatedAt,
          role: access.role,
          hasChildren: Boolean(row.hasChildren),
        },
      ];
    }),
    pageInfo: { hasMore },
  };
}

export async function listDirectCollaborations(actorUserId: string): Promise<DirectCollaborationPageItem[]> {
  const rows = await db
    .select({
      grant: collaborationGrants,
      owner: { id: user.id, name: user.name, email: user.email },
      note: {
        id: notes.id,
        folderId: notes.folderId,
        title: notes.title,
        documentType: notes.documentType,
        updatedAt: notes.updatedAt,
        deletedAt: notes.deletedAt,
      },
      folder: { id: folders.id, title: folders.title, updatedAt: folders.updatedAt, deletedAt: folders.deletedAt },
    })
    .from(collaborationGrants)
    .innerJoin(user, eq(collaborationGrants.ownerUserId, user.id))
    .leftJoin(notes, eq(collaborationGrants.noteId, notes.id))
    .leftJoin(folders, eq(collaborationGrants.folderId, folders.id))
    .where(eq(collaborationGrants.granteeUserId, actorUserId))
    .orderBy(user.name, folders.title, notes.title);

  const noteResources = rows.flatMap((row) =>
    row.grant.noteId && row.note && !row.note.deletedAt
      ? [{ id: row.note.id, folderId: row.note.folderId, userId: row.owner.id }]
      : []
  );
  const folderResources = rows.flatMap((row) =>
    row.grant.folderId && row.folder && !row.folder.deletedAt ? [{ id: row.folder.id, userId: row.owner.id }] : []
  );
  const [noteAccessById, folderAccessById] = await Promise.all([
    resolveNoteCollaborationAccessBatch({ actorUserId, resources: noteResources }),
    resolveFolderCollaborationAccessBatch({ actorUserId, resources: folderResources }),
  ]);

  const resolved: DirectCollaborationPageItem[] = [];
  for (const row of rows) {
    const ownerIdentity = serializeCollaborationUserIdentity({ ...row.owner, currentUserId: actorUserId });
    const targetNote = row.note;
    if (row.grant.noteId && targetNote && !targetNote.deletedAt) {
      const access = noteAccessById.get(targetNote.id);
      if (!access) continue;
      resolved.push({
        type: 'note',
        grantId: publicCollaborationAccessKey(row.grant.id),
        role: access.role,
        owner: ownerIdentity,
        note: {
          id: targetNote.id,
          title: targetNote.title,
          documentType: targetNote.documentType,
          updatedAt: targetNote.updatedAt,
        },
      });
      continue;
    }
    const targetFolder = row.folder;
    if (row.grant.folderId && targetFolder && !targetFolder.deletedAt) {
      const access = folderAccessById.get(targetFolder.id);
      if (!access) continue;
      resolved.push({
        type: 'folder',
        grantId: publicCollaborationAccessKey(row.grant.id),
        role: access.role,
        owner: ownerIdentity,
        folder: { id: targetFolder.id, title: targetFolder.title, updatedAt: targetFolder.updatedAt },
      });
    }
  }

  return resolved;
}

async function selectedIntegrationGrantIds(input: { authorizationId: string; actorUserId: string }) {
  const selected = await db
    .select({ grantId: authorizationCollaborationScopes.collaborationGrantId })
    .from(authorizationCollaborationScopes)
    .where(
      and(
        eq(authorizationCollaborationScopes.authorizationId, input.authorizationId),
        eq(authorizationCollaborationScopes.userId, input.actorUserId)
      )
    );
  return selected.map((scope) => scope.grantId);
}

export async function resolveIntegrationNoteAccess(input: {
  actorUserId: string;
  authorizationId: string;
  sharedAccessMode: SharedAccessMode;
  noteId: string;
  capability: CollaborationCapability;
}) {
  const allowedGrantIds =
    input.sharedAccessMode === 'specific'
      ? await selectedIntegrationGrantIds({
          authorizationId: input.authorizationId,
          actorUserId: input.actorUserId,
        })
      : undefined;
  const access = await resolveNoteCollaborationAccess({
    actorUserId: input.actorUserId,
    noteId: input.noteId,
    allowedGrantIds,
  });
  if (!access || !collaborationRoleAllows(access.role, input.capability)) return null;
  if (access.source !== 'owner' && input.sharedAccessMode === 'none') return null;

  const [note] = await db
    .select({ folderId: notes.folderId, isApiEditable: notes.isApiEditable })
    .from(notes)
    .where(and(eq(notes.id, input.noteId), eq(notes.userId, access.resourceOwnerUserId)))
    .limit(1);
  if (!note) return null;
  const tree = await loadFolderAccessTree(access.resourceOwnerUserId);
  if (tree.privateFolderIds.has(note.folderId)) return null;
  if (
    (input.capability === 'edit' || input.capability === 'create') &&
    (tree.agentReadOnlyFolderIds.has(note.folderId) || !note.isApiEditable)
  )
    return null;
  return access;
}

export async function resolveIntegrationFolderAccess(input: {
  actorUserId: string;
  authorizationId: string;
  sharedAccessMode: SharedAccessMode;
  folderId: string;
  capability: CollaborationCapability;
}) {
  const allowedGrantIds =
    input.sharedAccessMode === 'specific'
      ? await selectedIntegrationGrantIds({
          authorizationId: input.authorizationId,
          actorUserId: input.actorUserId,
        })
      : undefined;
  const access = await resolveFolderCollaborationAccess({
    actorUserId: input.actorUserId,
    folderId: input.folderId,
    allowedGrantIds,
  });
  if (!access || !collaborationRoleAllows(access.role, input.capability)) return null;
  if (access.source !== 'owner' && input.sharedAccessMode === 'none') return null;
  const tree = await loadFolderAccessTree(access.resourceOwnerUserId);
  if (tree.privateFolderIds.has(input.folderId)) return null;
  if ((input.capability === 'edit' || input.capability === 'create') && tree.agentReadOnlyFolderIds.has(input.folderId))
    return null;
  return access;
}

export async function resolveFolderCollaborationAccessBatch(input: {
  actorUserId: string;
  resources: ReadonlyArray<{ id: string; userId: string }>;
}) {
  const accessByFolderId = new Map<string, CollaborationAccess>();
  const sharedResources = input.resources.filter((resource) => resource.userId !== input.actorUserId);
  for (const resource of input.resources) {
    if (resource.userId === input.actorUserId) accessByFolderId.set(resource.id, ownerAccess(input.actorUserId));
  }
  if (sharedResources.length === 0) return accessByFolderId;

  const ownerIds = [...new Set(sharedResources.map((resource) => resource.userId))];
  const ancestorIdsByFolderId = new Map<string, string[]>();
  if (sharedResources.length <= 100) {
    const paths = await loadFolderPaths(
      sharedResources.map((resource) => ({ id: resource.id, folderId: resource.id, userId: resource.userId }))
    );
    for (const resource of sharedResources) {
      const path = paths.get(resource.id);
      if (path)
        ancestorIdsByFolderId.set(
          resource.id,
          path.map((folder) => folder.id)
        );
    }
  } else {
    const activeFolderRows = await db
      .select({ id: folders.id, userId: folders.userId, parentFolderId: folders.parentFolderId })
      .from(folders)
      .where(and(inArray(folders.userId, ownerIds), isNull(folders.deletedAt)));
    const folderMapsByOwner = new Map<string, Map<string, (typeof activeFolderRows)[number]>>();
    for (const ownerId of ownerIds) {
      const activeFolders = filterActiveFolderHierarchy(activeFolderRows.filter((folder) => folder.userId === ownerId));
      folderMapsByOwner.set(ownerId, new Map(activeFolders.map((folder) => [folder.id, folder])));
    }
    for (const resource of sharedResources) {
      const byId = folderMapsByOwner.get(resource.userId);
      let current = byId?.get(resource.id);
      if (!byId || !current) continue;
      const ancestorIds: string[] = [];
      while (current) {
        ancestorIds.push(current.id);
        if (!current.parentFolderId) break;
        current = byId.get(current.parentFolderId);
        if (!current) break;
      }
      ancestorIdsByFolderId.set(resource.id, ancestorIds);
    }
  }
  const relevantFolderIds = new Set([...ancestorIdsByFolderId.values()].flat());

  const grantRows =
    relevantFolderIds.size > 0
      ? await db
          .select({
            id: collaborationGrants.id,
            ownerUserId: collaborationGrants.ownerUserId,
            folderId: collaborationGrants.folderId,
            noteId: collaborationGrants.noteId,
            role: collaborationGrants.role,
          })
          .from(collaborationGrants)
          .where(
            and(
              eq(collaborationGrants.granteeUserId, input.actorUserId),
              inArray(collaborationGrants.ownerUserId, ownerIds),
              inArray(collaborationGrants.folderId, [...relevantFolderIds])
            )
          )
      : [];
  const grantsByFolderId = new Map<string, typeof grantRows>();
  for (const grant of grantRows) {
    if (grant.folderId) grantsByFolderId.set(grant.folderId, [...(grantsByFolderId.get(grant.folderId) ?? []), grant]);
  }

  for (const resource of sharedResources) {
    const ancestorIds = ancestorIdsByFolderId.get(resource.id);
    if (!ancestorIds) continue;
    const grants = ancestorIds.flatMap((id) => grantsByFolderId.get(id) ?? []);
    const access = accessFromGrants({
      actorUserId: input.actorUserId,
      resourceOwnerUserId: resource.userId,
      grants,
    });
    if (access) accessByFolderId.set(resource.id, access);
  }

  return accessByFolderId;
}

export async function resolveNoteCollaborationAccessBatch(input: {
  actorUserId: string;
  resources: ReadonlyArray<{ id: string; folderId: string; userId: string }>;
  allowedGrantIds?: readonly string[];
  excludePrivateFolders?: boolean;
}) {
  const accessByNoteId = new Map<string, CollaborationAccess>();
  if (input.resources.length === 0) return accessByNoteId;

  const resourcesRequiringFolders = input.excludePrivateFolders
    ? input.resources
    : input.resources.filter((resource) => resource.userId !== input.actorUserId);
  const ownerIds = [...new Set(resourcesRequiringFolders.map((resource) => resource.userId))];
  if (ownerIds.length === 0) {
    for (const resource of input.resources) accessByNoteId.set(resource.id, ownerAccess(input.actorUserId));
    return accessByNoteId;
  }

  const ancestorIdsByNoteId = new Map<string, string[]>();
  const relevantFolderIds = new Set<string>();
  const relevantNoteIds = new Set<string>();
  if (resourcesRequiringFolders.length <= 100) {
    const paths = await loadFolderPaths(
      resourcesRequiringFolders.map((resource) => ({
        id: resource.id,
        folderId: resource.folderId,
        userId: resource.userId,
      }))
    );
    for (const resource of resourcesRequiringFolders) {
      const path = paths.get(resource.id);
      if (!path || (input.excludePrivateFolders && path.some((folder) => folder.is_private !== 0))) continue;
      const ancestorIds = path.map((folder) => folder.id);
      ancestorIdsByNoteId.set(resource.id, ancestorIds);
      if (resource.userId !== input.actorUserId) relevantNoteIds.add(resource.id);
      for (const id of ancestorIds) relevantFolderIds.add(id);
    }
  } else {
    const activeFolderRows = await db
      .select({
        id: folders.id,
        userId: folders.userId,
        parentFolderId: folders.parentFolderId,
        isPrivate: folders.isPrivate,
      })
      .from(folders)
      .where(and(inArray(folders.userId, ownerIds), isNull(folders.deletedAt)));
    const folderMapsByOwner = new Map<string, Map<string, (typeof activeFolderRows)[number]>>();
    for (const ownerId of ownerIds) {
      const activeFolders = filterActiveFolderHierarchy(activeFolderRows.filter((folder) => folder.userId === ownerId));
      folderMapsByOwner.set(ownerId, new Map(activeFolders.map((folder) => [folder.id, folder])));
    }
    for (const resource of resourcesRequiringFolders) {
      const byId = folderMapsByOwner.get(resource.userId);
      let current = byId?.get(resource.folderId);
      if (!byId || !current) continue;
      const ancestorIds: string[] = [];
      let effectivelyPrivate = false;
      while (current) {
        ancestorIds.push(current.id);
        if (current.isPrivate) effectivelyPrivate = true;
        if (!current.parentFolderId) break;
        current = byId.get(current.parentFolderId);
        if (!current) break;
      }
      if (input.excludePrivateFolders && effectivelyPrivate) continue;
      ancestorIdsByNoteId.set(resource.id, ancestorIds);
      if (resource.userId !== input.actorUserId) relevantNoteIds.add(resource.id);
      for (const id of ancestorIds) relevantFolderIds.add(id);
    }
  }

  const targetConditions = [
    relevantFolderIds.size > 0 ? inArray(collaborationGrants.folderId, [...relevantFolderIds]) : undefined,
    relevantNoteIds.size > 0 ? inArray(collaborationGrants.noteId, [...relevantNoteIds]) : undefined,
  ].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));
  const grantRows =
    targetConditions.length > 0
      ? await db
          .select({
            id: collaborationGrants.id,
            ownerUserId: collaborationGrants.ownerUserId,
            role: collaborationGrants.role,
            noteId: collaborationGrants.noteId,
            folderId: collaborationGrants.folderId,
          })
          .from(collaborationGrants)
          .where(
            and(
              eq(collaborationGrants.granteeUserId, input.actorUserId),
              inArray(collaborationGrants.ownerUserId, ownerIds),
              or(...targetConditions),
              input.allowedGrantIds
                ? input.allowedGrantIds.length > 0
                  ? inArray(collaborationGrants.id, [...input.allowedGrantIds])
                  : sql`0`
                : undefined
            )
          )
      : [];
  const grantsByFolderId = new Map<string, typeof grantRows>();
  const grantsByNoteId = new Map<string, typeof grantRows>();
  for (const grant of grantRows) {
    if (grant.folderId) grantsByFolderId.set(grant.folderId, [...(grantsByFolderId.get(grant.folderId) ?? []), grant]);
    if (grant.noteId) grantsByNoteId.set(grant.noteId, [...(grantsByNoteId.get(grant.noteId) ?? []), grant]);
  }

  for (const resource of input.resources) {
    if (resource.userId === input.actorUserId && !input.excludePrivateFolders) {
      accessByNoteId.set(resource.id, ownerAccess(input.actorUserId));
      continue;
    }
    const ancestorIds = ancestorIdsByNoteId.get(resource.id);
    if (!ancestorIds) continue;
    if (resource.userId === input.actorUserId) {
      accessByNoteId.set(resource.id, ownerAccess(input.actorUserId));
      continue;
    }
    const grants = [
      ...(grantsByNoteId.get(resource.id) ?? []),
      ...ancestorIds.flatMap((id) => grantsByFolderId.get(id) ?? []),
    ];
    const access = accessFromGrants({
      actorUserId: input.actorUserId,
      resourceOwnerUserId: resource.userId,
      grants,
    });
    if (access) accessByNoteId.set(resource.id, access);
  }

  return accessByNoteId;
}

export async function resolveIntegrationReadAccessBatch(input: {
  actorUserId: string;
  authorizationId: string;
  sharedAccessMode: SharedAccessMode;
  resources: ReadonlyArray<{ id: string; folderId: string; userId: string }>;
}) {
  const allowedGrantIds =
    input.sharedAccessMode === 'specific'
      ? await selectedIntegrationGrantIds({
          authorizationId: input.authorizationId,
          actorUserId: input.actorUserId,
        })
      : undefined;
  const accessByNoteId = await resolveNoteCollaborationAccessBatch({
    actorUserId: input.actorUserId,
    resources: input.resources,
    allowedGrantIds,
    excludePrivateFolders: true,
  });
  for (const [noteId, access] of accessByNoteId) {
    if (
      !collaborationRoleAllows(access.role, 'read') ||
      (access.source !== 'owner' && input.sharedAccessMode === 'none')
    )
      accessByNoteId.delete(noteId);
  }
  return accessByNoteId;
}

export async function resolveNoteCollaborationAccess(input: {
  actorUserId: string;
  noteId: string;
  allowedGrantIds?: readonly string[];
}): Promise<CollaborationAccess | null> {
  const [note] = await db
    .select()
    .from(notes)
    .where(and(eq(notes.id, input.noteId), isNull(notes.deletedAt)))
    .limit(1);
  if (!note) return null;

  const tree = await loadFolderAccessTree(note.userId);
  if (!tree.byId.has(note.folderId)) return null;
  if (note.userId === input.actorUserId) return ownerAccess(input.actorUserId);

  const ancestorIds = tree.folders
    .filter((candidate) => isDescendantOrSelf(note.folderId, candidate.id, tree.byId))
    .map((candidate) => candidate.id);
  const grants = await db
    .select({
      id: collaborationGrants.id,
      role: collaborationGrants.role,
      noteId: collaborationGrants.noteId,
    })
    .from(collaborationGrants)
    .where(
      and(
        eq(collaborationGrants.granteeUserId, input.actorUserId),
        eq(collaborationGrants.ownerUserId, note.userId),
        or(
          eq(collaborationGrants.noteId, note.id),
          ancestorIds.length > 0 ? inArray(collaborationGrants.folderId, ancestorIds) : undefined
        ),
        input.allowedGrantIds ? inArray(collaborationGrants.id, [...input.allowedGrantIds]) : undefined
      )
    );

  return accessFromGrants({ actorUserId: input.actorUserId, resourceOwnerUserId: note.userId, grants });
}
