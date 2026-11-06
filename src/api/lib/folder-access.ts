import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { type ApiKey, authorizationFolderRules, type Folder, folders, type OAuthAuthorization } from '../db/schema';
import type { MetadataExecutor } from '../notes/metadata-transaction';
import { activeFolderWhere, filterActiveFolderHierarchy } from '../trash/policy';
import { type AuthorizationCapability, authorizationAllowsFolderCapability } from './integration-authorization';

export type FolderPermissionKind = AuthorizationCapability;

export type FolderAccessTree = {
  folders: Folder[];
  byId: Map<string, Folder>;
  privateFolderIds: Set<string>;
  agentReadOnlyFolderIds: Set<string>;
};

export async function loadFolderAccessTree(userId: string, executor: MetadataExecutor = db): Promise<FolderAccessTree> {
  const selected = await executor.select().from(folders).where(activeFolderWhere(userId));
  const rows = filterActiveFolderHierarchy(selected);
  const byId = new Map(rows.map((folder) => [folder.id, folder]));
  const privateFolderIds = new Set<string>();
  const agentReadOnlyFolderIds = new Set<string>();

  for (const folder of rows) {
    if (isFolderEffectivelyPrivate(folder.id, byId)) privateFolderIds.add(folder.id);
    if (isFolderEffectivelyAgentReadOnly(folder.id, byId)) agentReadOnlyFolderIds.add(folder.id);
  }

  return { folders: rows, byId, privateFolderIds, agentReadOnlyFolderIds };
}

export function getFolderDepth(folderId: string, byId: Map<string, Pick<Folder, 'id' | 'parentFolderId'>>) {
  let depth = 0;
  let current = byId.get(folderId);
  const seen = new Set<string>();

  while (current?.parentFolderId) {
    if (seen.has(current.id)) return Number.POSITIVE_INFINITY;
    seen.add(current.id);
    depth += 1;
    current = byId.get(current.parentFolderId);
  }

  return depth;
}

export function isDescendantOrSelf(
  folderId: string,
  rootFolderId: string,
  byId: Map<string, Pick<Folder, 'id' | 'parentFolderId'>>
) {
  let current: Pick<Folder, 'id' | 'parentFolderId'> | undefined = byId.get(folderId);
  const seen = new Set<string>();

  while (current) {
    if (current.id === rootFolderId) return true;
    if (!current.parentFolderId || seen.has(current.id)) return false;
    seen.add(current.id);
    current = byId.get(current.parentFolderId);
  }

  return false;
}

export function isFolderEffectivelyPrivate(
  folderId: string,
  byId: Map<string, Pick<Folder, 'id' | 'parentFolderId' | 'isPrivate'>>
) {
  let current: Pick<Folder, 'id' | 'parentFolderId' | 'isPrivate'> | undefined = byId.get(folderId);
  const seen = new Set<string>();

  while (current) {
    if (current.isPrivate) return true;
    if (!current.parentFolderId || seen.has(current.id)) return false;
    seen.add(current.id);
    current = byId.get(current.parentFolderId);
  }

  return false;
}

export function isFolderEffectivelyAgentReadOnly(
  folderId: string,
  byId: Map<string, Pick<Folder, 'id' | 'parentFolderId' | 'isAgentReadOnly'>>
) {
  let current: Pick<Folder, 'id' | 'parentFolderId' | 'isAgentReadOnly'> | undefined = byId.get(folderId);
  const seen = new Set<string>();

  while (current) {
    if (current.isAgentReadOnly) return true;
    if (!current.parentFolderId || seen.has(current.id)) return false;
    seen.add(current.id);
    current = byId.get(current.parentFolderId);
  }

  return false;
}

export async function validateFolderParent(input: { userId: string; parentFolderId?: string | null }) {
  if (!input.parentFolderId) return { ok: true as const, parent: null, depth: 0 };

  const tree = await loadFolderAccessTree(input.userId);
  const parent = tree.byId.get(input.parentFolderId);
  if (!parent) return { ok: false as const, status: 404 as const, error: 'Parent folder not found' };
  if (tree.privateFolderIds.has(parent.id))
    return { ok: false as const, status: 403 as const, error: 'Cannot create subfolders under a private folder' };

  const parentDepth = getFolderDepth(parent.id, tree.byId);
  if (!Number.isFinite(parentDepth) || parentDepth >= 4)
    return { ok: false as const, status: 400 as const, error: 'Maximum folder depth reached' };

  return { ok: true as const, parent, depth: parentDepth + 1 };
}

export async function validateFolderMove(
  input: { userId: string; folderId: string; parentFolderId: string | null },
  executor: MetadataExecutor = db
) {
  const tree = await loadFolderAccessTree(input.userId, executor);
  const folder = tree.byId.get(input.folderId);
  if (!folder) return { ok: false as const, status: 404 as const, error: 'Folder not found' };

  if (input.parentFolderId === folder.id)
    return { ok: false as const, status: 400 as const, error: 'Cannot move a folder into itself' };

  let newDepth = 0;
  if (input.parentFolderId) {
    const parent = tree.byId.get(input.parentFolderId);
    if (!parent) return { ok: false as const, status: 404 as const, error: 'Parent folder not found' };
    if (isDescendantOrSelf(parent.id, folder.id, tree.byId))
      return { ok: false as const, status: 400 as const, error: 'Cannot move a folder into one of its descendants' };
    if (tree.privateFolderIds.has(parent.id))
      return { ok: false as const, status: 403 as const, error: 'Cannot move folders under a private folder' };
    const parentDepth = getFolderDepth(parent.id, tree.byId);
    if (!Number.isFinite(parentDepth))
      return { ok: false as const, status: 400 as const, error: 'Invalid folder hierarchy' };
    newDepth = parentDepth + 1;
  }

  const subtreeHeight = getFolderSubtreeHeight(folder.id, tree.folders);
  if (newDepth + subtreeHeight > 4)
    return { ok: false as const, status: 400 as const, error: 'Maximum folder depth reached' };

  return { ok: true as const, folder, parentFolderId: input.parentFolderId };
}

function getFolderSubtreeHeight(folderId: string, rows: Pick<Folder, 'id' | 'parentFolderId'>[]) {
  const childrenByParent = new Map<string, Array<Pick<Folder, 'id' | 'parentFolderId'>>>();
  for (const row of rows) {
    if (!row.parentFolderId) continue;
    const children = childrenByParent.get(row.parentFolderId) ?? [];
    children.push(row);
    childrenByParent.set(row.parentFolderId, children);
  }

  const visit = (id: string, seen: Set<string>): number => {
    if (seen.has(id)) return Number.POSITIVE_INFINITY;
    const nextSeen = new Set(seen);
    nextSeen.add(id);
    const children = childrenByParent.get(id) ?? [];
    if (children.length === 0) return 0;
    return Math.max(...children.map((child) => 1 + visit(child.id, nextSeen)));
  };

  return visit(folderId, new Set());
}

async function canScopedActorAccessFolder(input: {
  actor: Pick<ApiKey | OAuthAuthorization, 'id' | 'accessMode' | 'canRead' | 'canCreate' | 'canEdit' | 'canComment'>;
  permissionRows: Array<{
    folderId: string;
    canRead: boolean;
    canCreate: boolean;
    canEdit: boolean;
    canComment: boolean;
    appliesTo: 'exact' | 'subtree';
  }>;
  userId: string;
  folderId: string;
  permission: FolderPermissionKind;
}) {
  const tree = await loadFolderAccessTree(input.userId);
  return authorizationAllowsFolderCapability({
    capabilities: input.actor,
    accessMode: input.actor.accessMode,
    rules: input.permissionRows,
    folderId: input.folderId,
    byId: tree.byId,
    privateFolderIds: tree.privateFolderIds,
    agentReadOnlyFolderIds: tree.agentReadOnlyFolderIds,
    capability: input.permission,
  });
}

async function getScopedActorAccessibleFolderIds(input: {
  actor: Pick<ApiKey | OAuthAuthorization, 'id' | 'accessMode' | 'canRead' | 'canCreate' | 'canEdit' | 'canComment'>;
  permissionRows: Array<{
    folderId: string;
    canRead: boolean;
    canCreate: boolean;
    canEdit: boolean;
    canComment: boolean;
    appliesTo: 'exact' | 'subtree';
  }>;
  userId: string;
  permission: FolderPermissionKind;
}) {
  const tree = await loadFolderAccessTree(input.userId);
  const rules = input.permissionRows;
  return new Set(
    tree.folders
      .filter((folder) =>
        authorizationAllowsFolderCapability({
          capabilities: input.actor,
          accessMode: input.actor.accessMode,
          rules,
          folderId: folder.id,
          byId: tree.byId,
          privateFolderIds: tree.privateFolderIds,
          agentReadOnlyFolderIds: tree.agentReadOnlyFolderIds,
          capability: input.permission,
        })
      )
      .map((folder) => folder.id)
  );
}

async function loadAuthorizationFolderRules(authorizationId: string) {
  return db
    .select({
      folderId: authorizationFolderRules.folderId,
      canRead: authorizationFolderRules.canRead,
      canCreate: authorizationFolderRules.canCreate,
      canEdit: authorizationFolderRules.canEdit,
      canComment: authorizationFolderRules.canComment,
      appliesTo: authorizationFolderRules.appliesTo,
    })
    .from(authorizationFolderRules)
    .where(eq(authorizationFolderRules.authorizationId, authorizationId));
}

export async function canApiKeyAccessFolder(input: {
  apiKey: ApiKey | null;
  userId: string;
  folderId: string;
  permission: FolderPermissionKind;
}) {
  if (!input.apiKey) return true;
  if (!input.apiKey.authorizationId) return false;
  const rows = await loadAuthorizationFolderRules(input.apiKey.authorizationId);
  return canScopedActorAccessFolder({
    actor: input.apiKey,
    permissionRows: rows,
    userId: input.userId,
    folderId: input.folderId,
    permission: input.permission,
  });
}

export async function getApiKeyAccessibleFolderIds(input: {
  apiKey: ApiKey | null;
  userId: string;
  permission: FolderPermissionKind;
}) {
  if (!input.apiKey) return null;
  if (!input.apiKey.authorizationId) return new Set<string>();
  const rows = await loadAuthorizationFolderRules(input.apiKey.authorizationId);
  return getScopedActorAccessibleFolderIds({
    actor: input.apiKey,
    permissionRows: rows,
    userId: input.userId,
    permission: input.permission,
  });
}

export async function canOAuthAuthorizationAccessFolder(input: {
  authorization: OAuthAuthorization | null;
  userId: string;
  folderId: string;
  permission: FolderPermissionKind;
}) {
  if (!input.authorization) return true;
  if (!input.authorization.integrationAuthorizationId) return false;
  const rows = await loadAuthorizationFolderRules(input.authorization.integrationAuthorizationId);
  return canScopedActorAccessFolder({
    actor: input.authorization,
    permissionRows: rows,
    userId: input.userId,
    folderId: input.folderId,
    permission: input.permission,
  });
}

export async function getOAuthAuthorizationAccessibleFolderIds(input: {
  authorization: OAuthAuthorization | null;
  userId: string;
  permission: FolderPermissionKind;
}) {
  if (!input.authorization) return null;
  if (!input.authorization.integrationAuthorizationId) return new Set<string>();
  const rows = await loadAuthorizationFolderRules(input.authorization.integrationAuthorizationId);
  return getScopedActorAccessibleFolderIds({
    actor: input.authorization,
    permissionRows: rows,
    userId: input.userId,
    permission: input.permission,
  });
}

export async function canIntegrationAccessFolder(input: {
  apiKey: ApiKey | null;
  oauthAuthorization: OAuthAuthorization | null;
  userId: string;
  folderId: string;
  permission: FolderPermissionKind;
}) {
  if (input.apiKey)
    return canApiKeyAccessFolder({
      apiKey: input.apiKey,
      userId: input.userId,
      folderId: input.folderId,
      permission: input.permission,
    });
  if (input.oauthAuthorization)
    return canOAuthAuthorizationAccessFolder({
      authorization: input.oauthAuthorization,
      userId: input.userId,
      folderId: input.folderId,
      permission: input.permission,
    });
  return true;
}

export async function getIntegrationAccessibleFolderIds(input: {
  apiKey: ApiKey | null;
  oauthAuthorization: OAuthAuthorization | null;
  userId: string;
  permission: FolderPermissionKind;
}) {
  if (input.apiKey)
    return getApiKeyAccessibleFolderIds({ apiKey: input.apiKey, userId: input.userId, permission: input.permission });
  if (input.oauthAuthorization)
    return getOAuthAuthorizationAccessibleFolderIds({
      authorization: input.oauthAuthorization,
      userId: input.userId,
      permission: input.permission,
    });
  return null;
}

export async function filterSelectablePermissionRows(input: {
  userId: string;
  accessMode: ApiKey['accessMode'];
  permissions: Array<{
    folderId?: string;
    canRead?: boolean;
    canCreate?: boolean;
    canEdit?: boolean;
    canComment?: boolean;
    appliesTo?: 'exact' | 'subtree';
  }>;
}) {
  const tree = await loadFolderAccessTree(input.userId);
  const seen = new Set<string>();
  return input.permissions.filter((permission) => {
    if (
      !permission.folderId ||
      seen.has(permission.folderId) ||
      !tree.byId.has(permission.folderId) ||
      tree.privateFolderIds.has(permission.folderId)
    )
      return false;
    if (input.accessMode === 'top_level' && tree.byId.get(permission.folderId)?.parentFolderId !== null) return false;
    if (!['all', 'top_level', 'specific'].includes(input.accessMode)) return false;
    seen.add(permission.folderId);
    return true;
  });
}

export async function isFolderAgentReadOnlyForUser(input: { userId: string; folderId: string }) {
  const tree = await loadFolderAccessTree(input.userId);
  return tree.agentReadOnlyFolderIds.has(input.folderId);
}
