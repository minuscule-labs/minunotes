import { and, eq, isNull, or } from 'drizzle-orm';
import { PropertyError, type PropertySchema } from '../../shared/properties';
import {
  authorizationCollaborationScopes,
  authorizationFolderRules,
  collaborationGrants,
  folderPropertySchemas,
  folders,
  integrationAuthorizations,
} from '../db/schema';
import { collaborationRoleAllows } from '../lib/collaboration-access';
import { isDescendantOrSelf, isFolderEffectivelyAgentReadOnly, isFolderEffectivelyPrivate } from '../lib/folder-access';
import { authorizationAllowsFolderCapability, capabilitiesAllow } from '../lib/integration-authorization';
import { filterActiveFolderHierarchy } from '../trash/policy';
import type { MetadataTx } from './metadata-transaction';
export type MetadataActor = {
  actorUserId: string;
  actorType?: 'user' | 'agent';
  actorId?: string | null;
  authorizationId?: string | null;
  credentialCapabilities?: { canRead: boolean; canEdit: boolean; canCreate?: boolean };
};
/** Resolve current ACLs using the same transaction as the operation. Note grants never authorize create. */
export async function authorizeMetadata(
  tx: MetadataTx,
  actor: MetadataActor,
  folderId: string,
  ownerId: string,
  noteId: string | null,
  capability: 'read' | 'edit' | 'create'
) {
  const rows = filterActiveFolderHierarchy(
    await tx
      .select()
      .from(folders)
      .where(and(eq(folders.userId, ownerId), isNull(folders.deletedAt)))
  );
  const byId = new Map(rows.map((f) => [f.id, f]));
  if (!byId.has(folderId)) throw new PropertyError('Resource not found', 404);
  const owned = actor.actorUserId === ownerId;
  const deny = () => new PropertyError(owned ? 'Forbidden' : 'Resource not found', owned ? 403 : 404);
  let authorization: typeof integrationAuthorizations.$inferSelect | undefined;
  if (actor.actorType === 'agent') {
    const credentialAllowed =
      capability === 'create'
        ? actor.credentialCapabilities?.canCreate
        : capability === 'edit'
          ? actor.credentialCapabilities?.canEdit
          : actor.credentialCapabilities?.canRead;
    if (!actor.authorizationId || !credentialAllowed) throw deny();
    [authorization] = await tx
      .select()
      .from(integrationAuthorizations)
      .where(
        and(
          eq(integrationAuthorizations.id, actor.authorizationId),
          eq(integrationAuthorizations.userId, actor.actorUserId),
          isNull(integrationAuthorizations.revokedAt)
        )
      );
    if (!authorization || !capabilitiesAllow(authorization, capability) || isFolderEffectivelyPrivate(folderId, byId))
      throw deny();
    if (owned) {
      const rules = await tx
        .select()
        .from(authorizationFolderRules)
        .where(
          and(
            eq(authorizationFolderRules.authorizationId, authorization.id),
            eq(authorizationFolderRules.userId, actor.actorUserId)
          )
        );
      if (
        !authorizationAllowsFolderCapability({
          capabilities: authorization,
          accessMode: authorization.accessMode,
          rules,
          folderId,
          byId,
          privateFolderIds: new Set(rows.filter((f) => isFolderEffectivelyPrivate(f.id, byId)).map((f) => f.id)),
          agentReadOnlyFolderIds: new Set(
            rows.filter((f) => isFolderEffectivelyAgentReadOnly(f.id, byId)).map((f) => f.id)
          ),
          capability,
        })
      )
        throw deny();
    } else if (capability !== 'read' && isFolderEffectivelyAgentReadOnly(folderId, byId)) throw deny();
  }
  if (owned) return;
  if (authorization?.sharedAccessMode === 'none') throw new PropertyError('Resource not found', 404);
  let grants = await tx
    .select()
    .from(collaborationGrants)
    .where(
      and(
        eq(collaborationGrants.ownerUserId, ownerId),
        eq(collaborationGrants.granteeUserId, actor.actorUserId),
        or(
          noteId && capability !== 'create' ? eq(collaborationGrants.noteId, noteId) : undefined,
          ...rows
            .filter((f) => isDescendantOrSelf(folderId, f.id, byId))
            .map((f) => eq(collaborationGrants.folderId, f.id))
        )
      )
    );
  if (authorization?.sharedAccessMode === 'specific') {
    const scopes = await tx
      .select()
      .from(authorizationCollaborationScopes)
      .where(
        and(
          eq(authorizationCollaborationScopes.authorizationId, authorization.id),
          eq(authorizationCollaborationScopes.userId, actor.actorUserId)
        )
      );
    const allowed = new Set(scopes.map((s) => s.collaborationGrantId));
    grants = grants.filter((g) => allowed.has(g.id));
  }
  if (!grants.length) throw new PropertyError('Resource not found', 404);
  if (!noteId && capability === 'edit') throw new PropertyError('Only the folder owner can edit definitions', 403);
  if (!grants.some((g) => collaborationRoleAllows(g.role, capability)))
    throw new PropertyError(
      actor.actorType === 'agent' ? 'Resource not found' : 'Forbidden',
      actor.actorType === 'agent' ? 404 : 403
    );
}
export async function metadataSchema(tx: MetadataTx, ownerId: string, folderId: string): Promise<PropertySchema> {
  const [row] = await tx
    .select()
    .from(folderPropertySchemas)
    .where(and(eq(folderPropertySchemas.folderId, folderId), eq(folderPropertySchemas.userId, ownerId)));
  return row
    ? { schemaId: row.schemaId, revision: row.revision, definitions: JSON.parse(row.definitions) }
    : { schemaId: null, revision: 0, definitions: [] };
}
