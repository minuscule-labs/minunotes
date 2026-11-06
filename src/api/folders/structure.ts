import { and, eq, inArray, isNull } from 'drizzle-orm';
import { PropertyError } from '../../shared/properties';
import { authorizationFolderRules, folders, integrationAuthorizations, notes } from '../db/schema';
import {
  type FolderAccessTree,
  isDescendantOrSelf,
  isFolderEffectivelyAgentReadOnly,
  isFolderEffectivelyPrivate,
  loadFolderAccessTree,
  validateFolderMove,
} from '../lib/folder-access';
import { createId } from '../lib/id';
import {
  type AuthorizationCapability,
  authorizationAllowsFolderCapability,
  nearestAuthorizationFolderRule,
} from '../lib/integration-authorization';
import type { MetadataActor } from '../notes/metadata-access';
import { type MetadataTx, metadataTransaction } from '../notes/metadata-transaction';
import { activeNoteWhere } from '../trash/policy';

export type FolderActor = MetadataActor & {
  credentialCapabilities?: NonNullable<MetadataActor['credentialCapabilities']> & { canCreateFolders?: boolean };
};

/** Owner-only policy, evaluated from the operation's authoritative transaction. */
export async function ownedFolderPolicy(tx: MetadataTx, actor: FolderActor) {
  const tree = await loadFolderAccessTree(actor.actorUserId, tx);
  const [authorization] =
    actor.actorType === 'agent' && actor.authorizationId
      ? await tx
          .select()
          .from(integrationAuthorizations)
          .where(
            and(
              eq(integrationAuthorizations.id, actor.authorizationId),
              eq(integrationAuthorizations.userId, actor.actorUserId),
              isNull(integrationAuthorizations.revokedAt)
            )
          )
      : [];
  const rules = authorization
    ? await tx
        .select()
        .from(authorizationFolderRules)
        .where(
          and(
            eq(authorizationFolderRules.authorizationId, authorization.id),
            eq(authorizationFolderRules.userId, actor.actorUserId)
          )
        )
    : [];
  const allowed = (id: string, capability: AuthorizationCapability, state = tree) => {
    if (!state.byId.has(id)) return false;
    if (actor.actorType !== 'agent') return true;
    const credential = actor.credentialCapabilities;
    const ceiling =
      capability === 'read'
        ? credential?.canRead
        : capability === 'edit'
          ? credential?.canEdit
          : capability === 'create'
            ? credential?.canCreate
            : false;
    return Boolean(
      authorization &&
        ceiling &&
        authorizationAllowsFolderCapability({
          capabilities: authorization,
          accessMode: authorization.accessMode,
          rules,
          folderId: id,
          byId: state.byId,
          privateFolderIds: state.privateFolderIds,
          agentReadOnlyFolderIds: state.agentReadOnlyFolderIds,
          capability,
        })
    );
  };
  const check = (id: string, capability: AuthorizationCapability, state = tree) => {
    if (!state.byId.has(id)) throw new PropertyError('Folder not found', 404);
    if (!allowed(id, capability, state)) throw new PropertyError('Folder operation is not authorized', 403);
  };
  const destination = (parentId: string | null, newSubtree = false) => {
    if (parentId) {
      check(parentId, 'read');
      check(parentId, 'create');
    }
    if (actor.actorType !== 'agent') return;
    if (
      !authorization ||
      !actor.credentialCapabilities?.canCreateFolders ||
      !authorization.canCreateFolders ||
      !actor.credentialCapabilities.canRead ||
      !actor.credentialCapabilities.canCreate ||
      !authorization.canRead ||
      !authorization.canCreate
    )
      throw new PropertyError('Folder creation capability is required', 403);
    if (parentId) {
      const nearest = nearestAuthorizationFolderRule({ folderId: parentId, rules, byId: tree.byId });
      if (nearest && !rules.find((rule) => rule.folderId === nearest.folderId)?.canCreateFolders)
        throw new PropertyError('Destination does not permit folder creation', 403);
    } else if (authorization.accessMode !== 'all')
      throw new PropertyError('Root destination requires all-folder scope', 403);
    if (newSubtree) {
      // Never add or copy grants to make generated IDs accessible. They must inherit existing scope.
      const id = createId('folder');
      const state: FolderAccessTree = {
        ...tree,
        byId: new Map(tree.byId),
        privateFolderIds: new Set(tree.privateFolderIds),
        agentReadOnlyFolderIds: new Set(tree.agentReadOnlyFolderIds),
      };
      state.byId.set(id, {
        id,
        userId: actor.actorUserId,
        parentFolderId: parentId,
        title: '',
        isPrivate: false,
        isAgentReadOnly: false,
        deletedAt: null,
        trashBatchId: null,
        createdByUserId: actor.actorUserId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      if (isFolderEffectivelyPrivate(id, state.byId)) state.privateFolderIds.add(id);
      if (isFolderEffectivelyAgentReadOnly(id, state.byId)) state.agentReadOnlyFolderIds.add(id);
      if (!allowed(id, 'read', state) || !allowed(id, 'create', state))
        throw new PropertyError(
          'Copied folders must inherit read/create scope; exact-only destinations are unsupported',
          403
        );
    }
  };
  return { tree, check, allowed, destination };
}

function object(input: unknown, keys: string[]) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !keys.includes(key))
  )
    throw new PropertyError('Invalid folder operation');
  return input as Record<string, unknown>;
}
function parentId(value: unknown) {
  if (value !== null && (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)))
    throw new PropertyError('Invalid parent folder ID');
  return value as string | null;
}

async function changeFolder(
  actor: FolderActor,
  id: string,
  input: Record<string, unknown>,
  expected?: { title?: string; parent?: string | null }
) {
  const title = input.title === undefined ? undefined : typeof input.title === 'string' ? input.title.trim() : '';
  if (input.title !== undefined && !title) throw new PropertyError('Folder title is required');
  if (
    (input.isPrivate !== undefined && typeof input.isPrivate !== 'boolean') ||
    (input.isAgentReadOnly !== undefined && typeof input.isAgentReadOnly !== 'boolean')
  )
    throw new PropertyError('Invalid folder flags');
  if (!Object.keys(input).length) throw new PropertyError('No folder updates provided');
  const parent = input.parentFolderId === undefined ? undefined : parentId(input.parentFolderId);
  return metadataTransaction(async (tx) => {
    const policy = await ownedFolderPolicy(tx, actor);
    policy.check(id, 'read');
    policy.check(id, 'edit');
    const current = policy.tree.byId.get(id);
    if (!current) throw new PropertyError('Folder not found', 404);
    if (
      (expected?.title !== undefined && current.title !== expected.title) ||
      (expected && Object.hasOwn(expected, 'parent') && current.parentFolderId !== expected.parent)
    )
      throw new PropertyError('Folder changed; review its current name/location before retrying', 409);
    const visible = (folder: typeof current, state = policy.tree) => ({
      ...folder,
      ...(actor.actorType === 'agent' && folder.parentFolderId && !policy.allowed(folder.parentFolderId, 'read', state)
        ? { parentFolderId: null, parentContext: 'unavailable' as const }
        : {}),
    });
    let visibility = policy.tree;
    const moving = parent !== undefined && parent !== current.parentFolderId;
    const subtree = policy.tree.folders.filter((folder) => isDescendantOrSelf(folder.id, id, policy.tree.byId));
    if (moving && actor.actorType === 'agent') {
      policy.destination(parent ?? null);
      for (const folder of subtree) {
        policy.check(folder.id, 'read');
        policy.check(folder.id, 'edit');
      }
      const documents = await tx
        .select({ editable: notes.isApiEditable })
        .from(notes)
        .where(
          activeNoteWhere(
            actor.actorUserId,
            inArray(
              notes.folderId,
              subtree.map((f) => f.id)
            )
          )
        );
      if (documents.some((note) => !note.editable))
        throw new PropertyError('Subtree contains notes/templates not editable through the API', 403);
    }
    // Do not disclose hierarchy/private-destination errors before the agent is authorized to see them.
    if (parent !== undefined) {
      const valid = await validateFolderMove({ userId: actor.actorUserId, folderId: id, parentFolderId: parent }, tx);
      if (!valid.ok) throw new PropertyError(valid.error, valid.status);
    }
    if (actor.actorType === 'agent' && !moving && (title === undefined || title === current.title))
      return visible(current);
    const [folder] = await tx
      .update(folders)
      .set({
        ...(title !== undefined ? { title } : {}),
        ...(parent !== undefined ? { parentFolderId: parent } : {}),
        ...(input.isPrivate !== undefined ? { isPrivate: input.isPrivate as boolean } : {}),
        ...(input.isAgentReadOnly !== undefined ? { isAgentReadOnly: input.isAgentReadOnly as boolean } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(folders.id, id),
          eq(folders.userId, actor.actorUserId),
          eq(folders.title, current.title),
          current.parentFolderId === null
            ? isNull(folders.parentFolderId)
            : eq(folders.parentFolderId, current.parentFolderId),
          isNull(folders.deletedAt)
        )
      )
      .returning();
    if (!folder) throw new PropertyError('Folder changed; review before retrying', 409);
    if (moving && actor.actorType === 'agent') {
      const after = await loadFolderAccessTree(actor.actorUserId, tx);
      visibility = after;
      for (const child of subtree) {
        policy.check(child.id, 'read', after);
        policy.check(child.id, 'edit', after);
        if (policy.tree.agentReadOnlyFolderIds.has(child.id) && !after.agentReadOnlyFolderIds.has(child.id))
          throw new PropertyError('Move would remove inherited agent protection', 403);
      }
    }
    return visible(folder, visibility);
  });
}

export function updateOwnedFolder(userId: string, id: string, input: unknown) {
  return changeFolder(
    { actorUserId: userId },
    id,
    object(input, ['title', 'parentFolderId', 'isPrivate', 'isAgentReadOnly'])
  );
}
export function renameOwnedFolder(actor: FolderActor, id: string, input: unknown) {
  const body = object(input, ['title', 'expectedTitle']);
  if (
    typeof body.title !== 'string' ||
    !body.title.trim() ||
    [...body.title.trim()].length > 200 ||
    typeof body.expectedTitle !== 'string'
  )
    throw new PropertyError('title and exact expectedTitle are required (maximum 200 characters)');
  return changeFolder(actor, id, { title: body.title }, { title: body.expectedTitle });
}
export function moveOwnedFolder(actor: FolderActor, id: string, input: unknown) {
  const body = object(input, ['parentFolderId', 'expectedParentFolderId', 'confirm']);
  if (body.confirm !== true) throw new PropertyError('Explicit confirmation is required to move a folder');
  return changeFolder(
    actor,
    id,
    { parentFolderId: parentId(body.parentFolderId) },
    { parent: parentId(body.expectedParentFolderId) }
  );
}
