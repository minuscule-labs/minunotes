import { type Context, Hono } from 'hono';
import type { auth } from '../lib/auth';
import {
  InvalidDirectCollaborationCursorError,
  listDirectCollaborations,
  listDirectCollaborationsPage,
  listSharedFolderRoots,
} from '../lib/collaboration-access';
import { sendCollaborationGrantedEmail, sendCollaborationInvitationEmail } from '../lib/collaboration-email';
import { publicCollaborationAccessKey } from '../lib/collaboration-identity';
import {
  acceptCollaborationInvitation,
  addResourceCollaborator,
  type CollaborationTarget,
  isCollaborationRole,
  listResourceCollaborators,
  previewCollaborationInvitation,
  regenerateCollaborationInvitation,
  removeResourceCollaborator,
  revokeCollaborationInvitation,
  updateResourceCollaborator,
} from '../lib/collaboration-invitations';
import { InvalidOwnedSharingCursorError, listOwnedSharedResourcesPage } from '../lib/collaboration-owned';
import { getApiRuntimeConfig } from '../lib/env';

type Variables = {
  user: typeof auth.$Infer.Session.user | null;
  session: typeof auth.$Infer.Session.session | null;
};

type CollaborationContext = Context<{ Variables: Variables }>;

export const collaborationRoutes = new Hono<{ Variables: Variables }>();

function getUser(c: CollaborationContext) {
  return c.get('user');
}

async function listCollaborators(c: CollaborationContext, target: CollaborationTarget) {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const result = await listResourceCollaborators({ ownerUserId: user.id, target });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(result.value);
}

async function addCollaborator(c: CollaborationContext, target: CollaborationTarget) {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const body = (await c.req.json().catch(() => null)) as { email?: string; role?: unknown } | null;
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);
  if (typeof body.email !== 'string') return c.json({ error: 'Email is required' }, 400);
  if (!isCollaborationRole(body.role)) return c.json({ error: 'Role must be viewer, commenter, or editor' }, 400);

  const result = await addResourceCollaborator({
    ownerUserId: user.id,
    target,
    email: body.email,
    role: body.role,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  const resourceType = 'noteId' in target ? ('note' as const) : ('folder' as const);
  if (result.value.kind === 'grant') {
    const resourceId = 'noteId' in target ? target.noteId : target.folderId;
    const resourceUrl = `${getApiRuntimeConfig().frontendUrl}/${resourceType === 'note' ? 'notes' : 'folders'}/${encodeURIComponent(resourceId)}`;
    const emailDelivery = await sendCollaborationGrantedEmail({
      to: result.value.recipientEmail,
      ownerName: user.name,
      resourceType,
      resourceUrl,
      role: result.value.grant.role,
    });
    return c.json(
      {
        kind: 'grant',
        emailDelivery,
        grant: {
          key: publicCollaborationAccessKey(result.value.grant.id),
          role: result.value.grant.role,
          createdAt: result.value.grant.createdAt,
          updatedAt: result.value.grant.updatedAt,
        },
      },
      201
    );
  }
  const emailDelivery = await sendCollaborationInvitationEmail({
    to: result.value.invitation.invitedEmailKey,
    ownerName: user.name,
    resourceType,
    role: result.value.invitation.role,
    invitationUrl: result.value.invitationUrl,
    expiresAt: result.value.invitation.expiresAt,
  });
  return c.json(
    {
      kind: 'invitation',
      emailDelivery,
      invitation: {
        id: result.value.invitation.id,
        email: result.value.invitation.invitedEmailKey,
        role: result.value.invitation.role,
        expiresAt: result.value.invitation.expiresAt,
        invitationUrl: result.value.invitationUrl,
      },
    },
    201
  );
}

async function updateCollaborator(c: CollaborationContext, target: CollaborationTarget) {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const body = (await c.req.json().catch(() => null)) as { role?: unknown } | null;
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);
  if (!isCollaborationRole(body.role)) return c.json({ error: 'Role must be viewer, commenter, or editor' }, 400);
  const accessKey = c.req.param('accessKey');
  if (!accessKey) return c.json({ error: 'Collaborator is required' }, 400);
  const result = await updateResourceCollaborator({
    ownerUserId: user.id,
    target,
    accessKey,
    role: body.role,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({
    grant: {
      key: publicCollaborationAccessKey(result.value.grant.id),
      role: result.value.grant.role,
      createdAt: result.value.grant.createdAt,
      updatedAt: result.value.grant.updatedAt,
    },
  });
}

async function removeCollaborator(c: CollaborationContext, target: CollaborationTarget) {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const accessKey = c.req.param('accessKey');
  if (!accessKey) return c.json({ error: 'Collaborator is required' }, 400);
  const result = await removeResourceCollaborator({
    ownerUserId: user.id,
    target,
    accessKey,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(result.value);
}

collaborationRoutes.get('/collaboration-invitations/:token/preview', async (c) => {
  const token = c.req.param('token');
  if (!token) return c.json({ error: 'Invitation not found' }, 404);
  const result = await previewCollaborationInvitation(token);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(result.value);
});

collaborationRoutes.post('/collaboration-invitations/:token/accept', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const token = c.req.param('token');
  if (!token) return c.json({ error: 'Invitation not found' }, 404);
  const result = await acceptCollaborationInvitation({ token, actorUserId: user.id });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(result.value);
});

collaborationRoutes.post('/collaboration-invitations/:invitationId/resend', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const invitationId = c.req.param('invitationId');
  if (!invitationId) return c.json({ error: 'Invitation not found' }, 404);
  const result = await regenerateCollaborationInvitation({ ownerUserId: user.id, invitationId });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  const emailDelivery = await sendCollaborationInvitationEmail({
    to: result.value.invitation.invitedEmailKey,
    ownerName: user.name,
    resourceType: result.value.invitation.noteId ? 'note' : 'folder',
    role: result.value.invitation.role,
    invitationUrl: result.value.invitationUrl,
    expiresAt: result.value.invitation.expiresAt,
  });
  return c.json({
    emailDelivery,
    invitation: {
      id: result.value.invitation.id,
      email: result.value.invitation.invitedEmailKey,
      role: result.value.invitation.role,
      expiresAt: result.value.invitation.expiresAt,
      invitationUrl: result.value.invitationUrl,
    },
  });
});

collaborationRoutes.delete('/collaboration-invitations/:invitationId', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const invitationId = c.req.param('invitationId');
  if (!invitationId) return c.json({ error: 'Invitation not found' }, 404);
  const result = await revokeCollaborationInvitation({ ownerUserId: user.id, invitationId });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(result.value);
});

collaborationRoutes.get('/collaborations/shared-folder-roots', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const requestedLimit = Number(c.req.query('limit') ?? 50);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100)
    return c.json({ error: 'Limit must be between 1 and 100' }, 400);
  return c.json(await listSharedFolderRoots({ actorUserId: user.id, limit: requestedLimit }));
});

collaborationRoutes.get('/collaborations/shared-with-me', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const type = c.req.query('type');
  if (!type) return c.json({ collaborations: await listDirectCollaborations(user.id) });
  if (type !== 'note' && type !== 'folder') return c.json({ error: 'Type must be note or folder' }, 400);
  const requestedLimit = Number(c.req.query('limit') ?? 25);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 50)
    return c.json({ error: 'Limit must be between 1 and 50' }, 400);
  try {
    const page = await listDirectCollaborationsPage({
      actorUserId: user.id,
      type,
      limit: requestedLimit,
      cursor: c.req.query('cursor'),
    });
    return c.json({ collaborations: page.items, pageInfo: page.pageInfo });
  } catch (error) {
    if (error instanceof InvalidDirectCollaborationCursorError)
      return c.json({ error: 'Invalid collaboration cursor' }, 400);
    throw error;
  }
});

collaborationRoutes.get('/collaborations/shared-by-me', async (c) => {
  const user = getUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const type = c.req.query('type');
  if (type !== 'note' && type !== 'folder') return c.json({ error: 'Type must be note or folder' }, 400);
  const requestedLimit = Number(c.req.query('limit') ?? 25);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 50)
    return c.json({ error: 'Limit must be between 1 and 50' }, 400);
  const query = c.req.query('q')?.trim() ?? '';
  if (query.length > 200) return c.json({ error: 'Query must be 200 characters or fewer' }, 400);
  try {
    const page = await listOwnedSharedResourcesPage({
      ownerUserId: user.id,
      type,
      query,
      limit: requestedLimit,
      cursor: c.req.query('cursor'),
    });
    return c.json({ resources: page.items, pageInfo: page.pageInfo });
  } catch (error) {
    if (error instanceof InvalidOwnedSharingCursorError) return c.json({ error: 'Invalid collaboration cursor' }, 400);
    throw error;
  }
});

collaborationRoutes.get('/notes/:noteId/collaborators', (c) => listCollaborators(c, { noteId: c.req.param('noteId') }));
collaborationRoutes.post('/notes/:noteId/collaborators', (c) => addCollaborator(c, { noteId: c.req.param('noteId') }));
collaborationRoutes.patch('/notes/:noteId/collaborators/:accessKey', (c) =>
  updateCollaborator(c, { noteId: c.req.param('noteId') })
);
collaborationRoutes.delete('/notes/:noteId/collaborators/:accessKey', (c) =>
  removeCollaborator(c, { noteId: c.req.param('noteId') })
);

collaborationRoutes.get('/folders/:folderId/collaborators', (c) =>
  listCollaborators(c, { folderId: c.req.param('folderId') })
);
collaborationRoutes.post('/folders/:folderId/collaborators', (c) =>
  addCollaborator(c, { folderId: c.req.param('folderId') })
);
collaborationRoutes.patch('/folders/:folderId/collaborators/:accessKey', (c) =>
  updateCollaborator(c, { folderId: c.req.param('folderId') })
);
collaborationRoutes.delete('/folders/:folderId/collaborators/:accessKey', (c) =>
  removeCollaborator(c, { folderId: c.req.param('folderId') })
);
