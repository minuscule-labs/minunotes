const API_URL = (import.meta.env.VITE_API_URL ?? '/internal').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...init?.headers },
  });

  const contentType = res.headers.get('content-type') ?? '';
  const data = contentType.includes('application/json') ? await res.json() : null;

  if (!res.ok) throw new ApiError(data?.error_description ?? data?.error ?? 'Request failed', res.status);
  if (!data) throw new Error('API did not return JSON. Check VITE_API_URL.');

  return data as T;
}

export type Folder = {
  id: string;
  parentFolderId: string | null;
  title: string;
  isPrivate: boolean;
  isAgentReadOnly: boolean;
  canTrash?: boolean;
  createdAt: string;
  updatedAt: string;
};
export type ApiKeyPermission = {
  id: string;
  apiKeyId: string;
  folderId: string;
  canRead: boolean;
  canCreate: boolean;
  canEdit: boolean;
  canComment: boolean;
  appliesTo: 'exact' | 'subtree';
  createdAt: string;
  updatedAt: string;
};
export type ApiKeyAccessMode = 'all' | 'top_level' | 'specific';
export type SharedAccessMode = 'none' | 'specific' | 'all';
export type ApiKey = {
  id: string;
  name: string;
  uid: string;
  canCreateFolders: boolean;
  canRead: boolean;
  canCreate: boolean;
  canEdit: boolean;
  canComment: boolean;
  accessMode: ApiKeyAccessMode;
  sharedAccessMode: SharedAccessMode;
  collaborationGrantIds: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  permissions: ApiKeyPermission[];
};
export type OAuthAuthorizationPermission = {
  id: string;
  authorizationId: string;
  folderId: string;
  canRead: boolean;
  canCreate: boolean;
  canEdit: boolean;
  canComment: boolean;
  appliesTo: 'exact' | 'subtree';
  createdAt: string;
  updatedAt: string;
};
export type OAuthClient = {
  id: string;
  userId: string | null;
  name: string;
  description: string | null;
  redirectUris: string;
  clientType: 'public' | 'confidential';
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
};
export type OAuthAuthorization = {
  id: string;
  userId: string;
  clientId: string;
  scope: string;
  accessMode: ApiKeyAccessMode;
  sharedAccessMode: SharedAccessMode;
  collaborationGrantIds: string[];
  canCreateFolders: boolean;
  canRead: boolean;
  canCreate: boolean;
  canEdit: boolean;
  canComment: boolean;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  client: OAuthClient;
  permissions: OAuthAuthorizationPermission[];
};
export type OAuthAuthorizeRequest = {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  code_challenge: string;
  code_challenge_method: string;
  state?: string;
  scope?: string;
};
export type OAuthAuthorizePreview = {
  client: OAuthClient;
  request: { scope: string; state: string | null; redirectUri: string };
};
export type NoteType = 'note' | 'template';
export type DocumentType = 'markdown' | 'canvas.default' | 'canvas.mindmap';
export type Note = {
  id: string;
  folderId: string;
  title: string;
  content: string;
  documentType: DocumentType;
  type: NoteType;
  isApiEditable: boolean;
  updatedByActorType: 'user' | 'agent' | 'system' | null;
  updatedByActorId: string | null;
  updatedByActorUid?: string | null;
  canTrash?: boolean;
  createdAt: string;
  updatedAt: string;
};
export type NoteListItem = Omit<Note, 'content'>;
export type PageResponse = { page: number; limit: number; hasMore: boolean };
export type CollaborationAccess = {
  role: CollaborationRole | 'owner';
  source: 'owner' | 'note_grant' | 'folder_grant';
  canTrash?: boolean;
};
export type NoteResponse = { note: Note; contentHash: string; access?: CollaborationAccess };
export type MoveNotesResponse = { notes: NoteResponse[] };
export type NoteStatus = { noteId: string; contentHash: string; updatedAt: string };
export type CommentActor = CollaborationIdentity;
export type CommentAnchor = {
  anchorType: 'range' | 'line';
  from: number;
  to: number;
  quote: string;
  prefix?: string;
  suffix?: string;
  documentHash: string;
  detached: boolean;
};
export const QUICK_COMMENT_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '🚀'] as const;
export type CommentReactionEmoji = string;
export type CommentReaction = {
  emoji: CommentReactionEmoji;
  count: number;
  reactedByCurrentActor: boolean;
};
export type CommentMessage = {
  id: string;
  threadId: string;
  body: string;
  author: CommentActor;
  authoredByCurrentActor: boolean;
  createdAt: string;
  updatedAt: string;
  reactions: CommentReaction[];
};
export type CommentThread = {
  id: string;
  noteId: string;
  status: 'open' | 'resolved';
  anchor: CommentAnchor;
  createdBy: CommentActor;
  authoredByCurrentActor: boolean;
  resolvedBy: CommentActor | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  messages: CommentMessage[];
};
export type NoteCommentsResponse = { noteId: string; documentHash: string; threads: CommentThread[] };
export type CommentAnchorInput = Omit<CommentAnchor, 'detached'> & { detached?: boolean };
export type NoteShareLink = {
  id: string;
  noteId: string;
  permission: 'read';
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  url: string | null;
};
export type CollaborationRole = 'viewer' | 'commenter' | 'editor';
export type CollaborationIdentity = {
  key: string;
  type: 'user' | 'agent' | 'former' | 'system';
  displayName: string | null;
  maskedEmail: string | null;
  label: string;
  isCurrentUser: boolean;
};
export type AccountProfile = {
  identity: CollaborationIdentity;
  email: string;
  imageUrl: string | null;
};
export type CollaborationResourceType = 'note' | 'folder';
export type SharedCollaboration =
  | {
      type: 'note';
      grantId: string;
      role: CollaborationRole | 'owner';
      owner: CollaborationIdentity;
      note: { id: string; title: string; documentType: DocumentType; updatedAt: string };
    }
  | {
      type: 'folder';
      grantId: string;
      role: CollaborationRole | 'owner';
      owner: CollaborationIdentity;
      folder: { id: string; title: string; updatedAt: string };
    };
export type SharedCollaborationsPage = {
  collaborations: SharedCollaboration[];
  pageInfo: { hasMore: boolean; nextCursor: string | null };
};
export type OwnedSharedResource = {
  type: CollaborationResourceType;
  resource: { id: string; title: string; updatedAt: string };
  activeCollaboratorCount: number;
  pendingInvitationCount: number;
  expiredInvitationCount: number;
  publicLinkActive: boolean;
};
export type OwnedSharedResourcesPage = {
  resources: OwnedSharedResource[];
  pageInfo: { hasMore: boolean; nextCursor: string | null };
};
export type CollaborationInvitationPreview = {
  resource: { type: 'note' | 'folder'; id: string; title: string };
  owner: { name: string };
  role: CollaborationRole;
  invitedEmail: string;
  expiresAt: string;
  status: 'pending' | 'accepted';
};
export type CollaborationManagementResponse = {
  resource: { id: string; title: string };
  grants: Array<{
    key: string;
    role: CollaborationRole;
    createdAt: string;
    updatedAt: string;
    user: CollaborationIdentity;
  }>;
  invitations: Array<{
    id: string;
    email: string;
    role: CollaborationRole;
    expiresAt: string;
    createdAt: string;
    updatedAt: string;
  }>;
};
export type FolderShareLink = {
  id: string;
  folderId: string;
  permission: 'read';
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  url: string | null;
};
export type SharedNote = { title: string; content: string; documentType: DocumentType; updatedAt: string };
export type SharedWikilinkResolution = { target: string; href: string | null };
export type SharedFolderNote = SharedNote & { id: string; folderId: string };
export type SharedFolder = { id: string; title: string; updatedAt: string };
export type SharedFolderChild = { id: string; parentFolderId: string | null; title: string; updatedAt: string };
export type NoteEvent = {
  id: string;
  noteId: string;
  actor: CollaborationIdentity;
  eventType:
    | 'create'
    | 'update'
    | 'edit_patch'
    | 'move'
    | 'toggle_api_editable'
    | 'restore'
    | 'trash'
    | 'restore_from_trash';
  summary: string;
  beforeHash: string | null;
  afterHash: string | null;
  createdAt: string;
};
export type NoteLinkType = 'wikilink' | 'internal-url' | 'markdown-internal-url' | 'canvas-note';
export type Backlink = {
  id: string;
  sourceNoteId: string;
  sourceTitle: string;
  sourceFolderId: string;
  targetTitle: string;
  label: string | null;
  linkType: NoteLinkType;
  createdAt: string;
  updatedAt: string;
};
export type NoteLink = {
  id: string;
  sourceNoteId: string;
  targetNoteId: string | null;
  targetTitle: string;
  label: string | null;
  linkType: NoteLinkType;
  createdAt: string;
  updatedAt: string;
};
export type BacklinksResponse = { noteId: string; backlinks: Backlink[] };
export type LinksResponse = { noteId: string; links: NoteLink[] };
export type Tag = { id: string; name: string; normalizedName: string; noteCount?: number };
export type Attachment = {
  id: string;
  noteId: string;
  folderId: string | null;
  provider: string;
  filename: string;
  mimeType: string;
  size: number;
  contentHash: string;
  status: 'pending' | 'ready';
  createdAt: string;
  updatedAt: string;
};
export type UploadImageResponse = { attachment: Attachment; markdownUrl: string; markdown: string };
export type SignedImageUpload = UploadImageResponse & {
  signedUrl: string;
  method: 'PUT';
  headers: { 'content-type': string };
};
export type NoteVersionSummary = {
  id: string;
  noteId: string;
  title: string;
  reason: 'create' | 'autosave_checkpoint' | 'before_agent_edit' | 'before_restore' | 'manual';
  actorType: 'user' | 'agent' | 'system';
  actorId: string | null;
  stateHash: string;
  createdAt: string;
};
export type NoteVersion = NoteVersionSummary & {
  content: string;
  documentType: DocumentType;
  folderId: string;
  createdAtValue: string;
  isApiEditable: boolean;
};
export type TrashedNote = Pick<
  Note,
  'id' | 'folderId' | 'title' | 'documentType' | 'type' | 'createdAt' | 'updatedAt'
> & {
  deletedAt: string;
  originalFolderTitle: string | null;
  originalFolderAvailable: boolean;
};
export type TrashedFolder = Pick<Folder, 'id' | 'parentFolderId' | 'title' | 'createdAt' | 'updatedAt'> & {
  deletedAt: string;
  originalParentTitle: string | null;
  originalParentAvailable: boolean;
  descendantFolderCount: number;
  noteCount: number;
};
export type TrashedFolderContents = {
  rootFolderId: string;
  folders: Array<Pick<Folder, 'id' | 'parentFolderId' | 'title' | 'createdAt' | 'updatedAt'> & { deletedAt: string }>;
  notes: Array<
    Pick<Note, 'id' | 'folderId' | 'title' | 'documentType' | 'type' | 'createdAt' | 'updatedAt'> & {
      deletedAt: string;
    }
  >;
};
export type TrashResponse = PageResponse & { notes: TrashedNote[]; folders: TrashedFolder[] };
export type NoteEventsResponse = { noteId: string; events: NoteEvent[] };
export type NoteVersionsResponse = { noteId: string; versions: NoteVersionSummary[] };
export type DocumentEdit =
  | { type: 'append'; text: string }
  | { type: 'replace_text'; oldText: string; newText: string }
  | { type: 'replace_range'; from: number; to: number; text: string };
export type DocumentSection = {
  id: string;
  heading: string;
  level: number;
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
};
export type SectionResponse = {
  noteId: string;
  contentHash: string;
  section: DocumentSection & { markdown: string; content: string };
};
export type DiscoveryScope = 'all' | 'mine' | 'shared';
export type DiscoveryNote = NoteListItem & {
  access: CollaborationAccess;
  owner: CollaborationIdentity | null;
};
export type SearchNote = DiscoveryNote & { folderTitle: string | null };

async function uploadRequest<T>(path: string, formData: FormData): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { method: 'POST', body: formData, credentials: 'include' });
  const contentType = res.headers.get('content-type') ?? '';
  const data = contentType.includes('application/json') ? await res.json() : null;

  if (!res.ok) throw new ApiError(data?.error_description ?? data?.error ?? 'Request failed', res.status);
  if (!data) throw new Error('API did not return JSON. Check VITE_API_URL.');

  return data as T;
}

function logImageUpload(
  event: string,
  input: { noteId: string; file: File; phase: string; status?: number; message?: string }
) {
  if (!import.meta.env.DEV && import.meta.env.VITE_IMAGE_UPLOAD_DEBUG !== 'true') return;
  console.info(`[MinuNotes image upload] ${event}`, {
    noteId: input.noteId,
    filename: input.file.name,
    mimeType: input.file.type,
    size: input.file.size,
    phase: input.phase,
    status: input.status,
    message: input.message,
  });
}

async function fetchAllTemplates() {
  const templates: NoteListItem[] = [];
  let page = 1;
  while (true) {
    const result = await request<PageResponse & { templates: NoteListItem[] }>(
      `/notes/templates?page=${page}&limit=100`
    );
    templates.push(...result.templates);
    if (!result.hasMore) return { templates };
    page += 1;
  }
}

export const api = {
  accountProfile: () => request<{ profile: AccountProfile }>('/account/profile'),
  apiKeys: () => request<{ keys: ApiKey[] }>('/api-keys'),
  oauthClients: () => request<{ clients: OAuthClient[] }>('/oauth/clients'),
  createOAuthClient: (data: { name: string; description?: string | null; redirectUris: string[] }) =>
    request<{ client: OAuthClient }>('/oauth/clients', { method: 'POST', body: JSON.stringify(data) }),
  revokeOAuthClient: (clientId: string) => request<{ ok: true }>(`/oauth/clients/${clientId}`, { method: 'DELETE' }),
  oauthAuthorizations: () => request<{ authorizations: OAuthAuthorization[] }>('/oauth/authorizations'),
  updateOAuthAuthorization: (
    authorizationId: string,
    data: {
      accessMode: ApiKeyAccessMode;
      canCreateFolders: boolean;
      canRead: boolean;
      canCreate: boolean;
      canEdit: boolean;
      canComment: boolean;
      sharedAccessMode: SharedAccessMode;
      collaborationGrantIds: string[];
      permissions: Array<{
        folderId: string;
        canRead?: boolean;
        canCreate?: boolean;
        canEdit?: boolean;
        canComment?: boolean;
        appliesTo?: 'exact' | 'subtree';
      }>;
    }
  ) =>
    request<{ ok: true }>(`/oauth/authorizations/${authorizationId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  revokeOAuthAuthorization: (authorizationId: string) =>
    request<{ ok: true }>(`/oauth/authorizations/${authorizationId}`, { method: 'DELETE' }),
  oauthAuthorizePreview: (params: OAuthAuthorizeRequest) =>
    request<OAuthAuthorizePreview>(`/oauth/authorize/preview?${new URLSearchParams(params).toString()}`),
  approveOAuthAuthorization: (
    data: OAuthAuthorizeRequest & {
      accessMode: ApiKeyAccessMode;
      canRead: boolean;
      canCreate: boolean;
      canEdit: boolean;
      canComment: boolean;
      canCreateFolders: boolean;
      folderIds: string[];
      sharedAccessMode: SharedAccessMode;
      collaborationGrantIds: string[];
    }
  ) =>
    request<{ redirectUrl: string }>('/oauth/authorize/approve', {
      method: 'POST',
      body: JSON.stringify({
        clientId: data.client_id,
        redirectUri: data.redirect_uri,
        responseType: data.response_type,
        codeChallenge: data.code_challenge,
        codeChallengeMethod: data.code_challenge_method,
        state: data.state,
        scope: data.scope,
        accessMode: data.accessMode,
        canRead: data.canRead,
        canCreate: data.canCreate,
        canEdit: data.canEdit,
        canComment: data.canComment,
        canCreateFolders: data.canCreateFolders,
        folderIds: data.folderIds,
        sharedAccessMode: data.sharedAccessMode,
        collaborationGrantIds: data.collaborationGrantIds,
      }),
    }),
  createApiKey: (data: {
    name: string;
    accessMode?: ApiKeyAccessMode;
    canCreateFolders?: boolean;
    canRead?: boolean;
    canCreate?: boolean;
    canEdit?: boolean;
    canComment?: boolean;
    sharedAccessMode?: SharedAccessMode;
    collaborationGrantIds?: string[];
    permissions: Array<{
      folderId: string;
      canRead?: boolean;
      canCreate?: boolean;
      canEdit?: boolean;
      canComment?: boolean;
      appliesTo?: 'exact' | 'subtree';
    }>;
  }) => request<{ key: string; apiKey: ApiKey }>('/api-keys', { method: 'POST', body: JSON.stringify(data) }),
  updateApiKey: (
    keyId: string,
    data: {
      name?: string;
      accessMode?: ApiKeyAccessMode;
      canCreateFolders?: boolean;
      canRead?: boolean;
      canCreate?: boolean;
      canEdit?: boolean;
      canComment?: boolean;
      sharedAccessMode?: SharedAccessMode;
      collaborationGrantIds?: string[];
      permissions?: Array<{
        folderId: string;
        canRead?: boolean;
        canCreate?: boolean;
        canEdit?: boolean;
        canComment?: boolean;
        appliesTo?: 'exact' | 'subtree';
      }>;
    }
  ) => request<{ apiKey: ApiKey }>(`/api-keys/${keyId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  revokeApiKey: (keyId: string) => request<{ ok: true }>(`/api-keys/${keyId}`, { method: 'DELETE' }),
  folders: () => request<{ folders: Folder[] }>('/folders'),
  sharedWithMe: () => request<{ collaborations: SharedCollaboration[] }>('/collaborations/shared-with-me'),
  sharedWithMePage: (type: CollaborationResourceType, cursor?: string | null, limit = 25) => {
    const search = new URLSearchParams({ type, limit: String(limit) });
    if (cursor) search.set('cursor', cursor);
    return request<SharedCollaborationsPage>(`/collaborations/shared-with-me?${search}`);
  },
  sharedByMePage: (type: CollaborationResourceType, query: string, cursor?: string | null, limit = 25) => {
    const search = new URLSearchParams({ type, limit: String(limit) });
    if (query) search.set('q', query);
    if (cursor) search.set('cursor', cursor);
    return request<OwnedSharedResourcesPage>(`/collaborations/shared-by-me?${search}`);
  },
  resourceCollaborators: (resourceType: CollaborationResourceType, resourceId: string) =>
    request<CollaborationManagementResponse>(`/${resourceType}s/${resourceId}/collaborators`),
  addResourceCollaborator: (
    resourceType: CollaborationResourceType,
    resourceId: string,
    data: { email: string; role: CollaborationRole }
  ) =>
    request<
      | {
          kind: 'grant';
          emailDelivery: 'sent' | 'disabled' | 'failed';
          grant: { key: string; role: CollaborationRole };
        }
      | {
          kind: 'invitation';
          emailDelivery: 'sent' | 'disabled' | 'failed';
          invitation: {
            id: string;
            email: string;
            role: CollaborationRole;
            expiresAt: string;
            invitationUrl: string;
          };
        }
    >(`/${resourceType}s/${resourceId}/collaborators`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateResourceCollaborator: (
    resourceType: CollaborationResourceType,
    resourceId: string,
    accessKey: string,
    role: CollaborationRole
  ) =>
    request<{ grant: { key: string; role: CollaborationRole } }>(
      `/${resourceType}s/${resourceId}/collaborators/${accessKey}`,
      { method: 'PATCH', body: JSON.stringify({ role }) }
    ),
  removeResourceCollaborator: (resourceType: CollaborationResourceType, resourceId: string, accessKey: string) =>
    request<{ ok: true }>(`/${resourceType}s/${resourceId}/collaborators/${accessKey}`, { method: 'DELETE' }),
  collaborationInvitationPreview: (token: string) =>
    request<CollaborationInvitationPreview>(`/collaboration-invitations/${encodeURIComponent(token)}/preview`),
  acceptCollaborationInvitation: (token: string) =>
    request<{ destination: string; alreadyAccepted: boolean }>(
      `/collaboration-invitations/${encodeURIComponent(token)}/accept`,
      { method: 'POST', body: JSON.stringify({}) }
    ),
  resendCollaborationInvitation: (invitationId: string) =>
    request<{
      emailDelivery: 'sent' | 'disabled' | 'failed';
      invitation: {
        id: string;
        email: string;
        role: CollaborationRole;
        expiresAt: string;
        invitationUrl: string;
      };
    }>(`/collaboration-invitations/${invitationId}/resend`, { method: 'POST', body: JSON.stringify({}) }),
  revokeCollaborationInvitation: (invitationId: string) =>
    request<{ ok: true }>(`/collaboration-invitations/${invitationId}`, { method: 'DELETE' }),
  folderShareLink: (folderId: string) =>
    request<{ shareLink: FolderShareLink | null }>(`/folders/${folderId}/share-link`),
  createFolderShareLink: (folderId: string, regenerate = false) =>
    request<{ shareLink: FolderShareLink }>(`/folders/${folderId}/share-link`, {
      method: 'POST',
      body: JSON.stringify({ regenerate }),
    }),
  revokeFolderShareLink: (folderId: string) =>
    request<{ ok: true }>(`/folders/${folderId}/share-link`, { method: 'DELETE' }),
  createFolder: (title: string, parentFolderId?: string | null) =>
    request<{ folder: Folder }>('/folders', { method: 'POST', body: JSON.stringify({ title, parentFolderId }) }),
  renameFolder: (folderId: string, title: string) =>
    request<{ folder: Folder }>(`/folders/${folderId}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  updateFolder: (
    folderId: string,
    data: { title?: string; isPrivate?: boolean; isAgentReadOnly?: boolean; parentFolderId?: string | null }
  ) => request<{ folder: Folder }>(`/folders/${folderId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  moveFolder: (folderId: string, parentFolderId: string | null) =>
    request<{ folder: Folder }>(`/folders/${folderId}`, { method: 'PATCH', body: JSON.stringify({ parentFolderId }) }),
  deleteFolder: (folderId: string) =>
    request<{ ok: true; deletedAt: string; folderCount: number; noteCount: number }>(`/folders/${folderId}`, {
      method: 'DELETE',
    }),
  templates: (page = 1, limit = 50) =>
    request<PageResponse & { templates: NoteListItem[] }>(`/notes/templates?page=${page}&limit=${limit}`),
  allTemplates: () => fetchAllTemplates(),
  folderTemplates: (folderId: string) => request<{ templates: NoteListItem[] }>(`/folders/${folderId}/templates`),
  templateFolders: (templateId: string) => request<{ folders: Folder[] }>(`/notes/templates/${templateId}/folders`),
  updateTemplateFolders: (templateId: string, folderIds: string[]) =>
    request<{ ok: true }>(`/notes/templates/${templateId}/folders`, {
      method: 'PUT',
      body: JSON.stringify({ folderIds }),
    }),
  folderDetail: (folderId: string) =>
    request<{ folder: Folder; ancestors: Folder[]; childFolders: Folder[]; access: CollaborationAccess }>(
      `/folders/${folderId}/detail`
    ),
  notes: (folderId: string, type: NoteType = 'note', page = 1, limit = 50) =>
    request<PageResponse & { notes: NoteListItem[]; access: CollaborationAccess }>(
      `/folders/${folderId}/notes?type=${type}&page=${page}&limit=${limit}`
    ),
  recentNotes: (limit = 10, page = 1, scope: DiscoveryScope = 'all') =>
    request<PageResponse & { notes: DiscoveryNote[] }>(
      `/notes/recent?page=${page}&limit=${limit}&scope=${encodeURIComponent(scope)}`
    ),
  createNote: (
    folderId: string,
    data?: { title?: string; content?: string; type?: NoteType; documentType?: DocumentType }
  ) => request<{ note: Note }>(`/folders/${folderId}/notes`, { method: 'POST', body: JSON.stringify(data ?? {}) }),
  note: (noteId: string) => request<NoteResponse>(`/notes/${noteId}`),
  noteStatus: (noteId: string) => request<NoteStatus>(`/notes/${noteId}/status`),
  noteComments: (noteId: string) => request<NoteCommentsResponse>(`/notes/${noteId}/comments`),
  createCommentThread: (noteId: string, data: { body: string; anchor: CommentAnchorInput }) =>
    request<{ thread: CommentThread }>(`/notes/${noteId}/comments`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  addCommentReply: (noteId: string, threadId: string, body: string) =>
    request<{ message: CommentMessage }>(`/notes/${noteId}/comments/${threadId}/replies`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    }),
  updateCommentAnchor: (noteId: string, threadId: string, anchor: CommentAnchorInput) =>
    request<{ thread: CommentThread }>(`/notes/${noteId}/comments/${threadId}/anchor`, {
      method: 'PATCH',
      body: JSON.stringify({ anchor }),
    }),
  resolveCommentThread: (noteId: string, threadId: string) =>
    request<{ thread: CommentThread }>(`/notes/${noteId}/comments/${threadId}/resolve`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  reopenCommentThread: (noteId: string, threadId: string) =>
    request<{ thread: CommentThread }>(`/notes/${noteId}/comments/${threadId}/reopen`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  updateCommentMessage: (noteId: string, threadId: string, messageId: string, body: string) =>
    request<{ message: CommentMessage }>(`/notes/${noteId}/comments/${threadId}/messages/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ body }),
    }),
  toggleCommentReaction: (noteId: string, threadId: string, messageId: string, emoji: CommentReactionEmoji) =>
    request<{ messageId: string; reactions: CommentReaction[] }>(
      `/notes/${noteId}/comments/${threadId}/messages/${messageId}/reactions`,
      { method: 'POST', body: JSON.stringify({ emoji }) }
    ),
  deleteCommentMessage: (noteId: string, threadId: string, messageId: string) =>
    request<{ ok: true; deletedThread: boolean }>(`/notes/${noteId}/comments/${threadId}/messages/${messageId}`, {
      method: 'DELETE',
    }),
  deleteCommentThread: (noteId: string, threadId: string) =>
    request<{ ok: true }>(`/notes/${noteId}/comments/${threadId}`, { method: 'DELETE' }),
  noteShareLink: (noteId: string) => request<{ shareLink: NoteShareLink | null }>(`/notes/${noteId}/share-link`),
  createNoteShareLink: (noteId: string, regenerate = false) =>
    request<{ shareLink: NoteShareLink }>(`/notes/${noteId}/share-link`, {
      method: 'POST',
      body: JSON.stringify({ regenerate }),
    }),
  revokeNoteShareLink: (noteId: string) => request<{ ok: true }>(`/notes/${noteId}/share-link`, { method: 'DELETE' }),
  sharedNote: (token: string) =>
    request<{
      note: SharedNote;
      share: { id: string; permission: 'read'; createdAt: string };
      resolutions: SharedWikilinkResolution[];
    }>(`/share/${encodeURIComponent(token)}`),
  sharedFolder: (token: string) =>
    request<{
      folder: SharedFolder;
      folders: SharedFolderChild[];
      notes: SharedFolderNote[];
      share: { id: string; permission: 'read'; createdAt: string };
    }>(`/share/folders/${encodeURIComponent(token)}`),
  sharedFolderNoteWikilinks: (token: string, noteId: string) =>
    request<{ resolutions: SharedWikilinkResolution[] }>(
      `/share/folders/${encodeURIComponent(token)}/notes/${encodeURIComponent(noteId)}/wikilinks`
    ),
  noteEvents: (noteId: string, limit = 25) => request<NoteEventsResponse>(`/notes/${noteId}/events?limit=${limit}`),
  noteVersions: (noteId: string, limit = 100) =>
    request<NoteVersionsResponse>(`/notes/${noteId}/versions?limit=${limit}`),
  noteVersion: (noteId: string, versionId: string) =>
    request<{ version: NoteVersion }>(`/notes/${noteId}/versions/${versionId}`),
  restoreNoteVersion: (noteId: string, versionId: string) =>
    request<NoteResponse & { version: NoteVersion }>(`/notes/${noteId}/versions/${versionId}/restore`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  tags: () => request<{ tags: Tag[] }>('/notes/tags'),
  noteTags: (noteId: string) => request<{ tags: Tag[] }>(`/notes/${noteId}/tags`),
  updateNoteTags: (noteId: string, tags: string[]) =>
    request<{ tags: Tag[] }>(`/notes/${noteId}/tags`, { method: 'PUT', body: JSON.stringify({ tags }) }),
  links: (noteId: string) => request<LinksResponse>(`/notes/${noteId}/links`),
  backlinks: (noteId: string) => request<BacklinksResponse>(`/notes/${noteId}/backlinks`),
  orphanNotes: (page = 1, limit = 50) =>
    request<
      PageResponse & {
        notes: Array<Pick<NoteListItem, 'id' | 'folderId' | 'title' | 'type' | 'createdAt' | 'updatedAt'>>;
      }
    >(`/notes/orphans?page=${page}&limit=${limit}`),
  noteOutline: (noteId: string) =>
    request<{ noteId: string; contentHash: string; sections: DocumentSection[] }>(`/notes/${noteId}/outline`),
  noteSection: (noteId: string, sectionId: string) =>
    request<SectionResponse>(`/notes/${noteId}/sections/${encodeURIComponent(sectionId)}`),
  editNote: (noteId: string, data: { edits: DocumentEdit[]; baseHash?: string }) =>
    request<NoteResponse>(`/notes/${noteId}/edit`, { method: 'POST', body: JSON.stringify(data) }),
  saveNote: (
    noteId: string,
    data: Partial<Pick<Note, 'title' | 'content' | 'isApiEditable' | 'createdAt'>> & { baseHash?: string }
  ) => request<NoteResponse>(`/notes/${noteId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  moveNote: (noteId: string, folderId: string) =>
    request<NoteResponse>(`/notes/${noteId}`, { method: 'PATCH', body: JSON.stringify({ folderId }) }),
  moveNotes: (noteIds: string[], targetFolderId: string) =>
    request<MoveNotesResponse>('/notes/move', {
      method: 'POST',
      body: JSON.stringify({ noteIds, targetFolderId }),
    }),
  trashNotes: (noteIds: string[]) =>
    request<{ ok: true; deletedAt: string; noteCount: number }>('/notes/trash', {
      method: 'POST',
      body: JSON.stringify({ noteIds }),
    }),
  searchNotes: (
    q: string,
    type: NoteType = 'note',
    limit = 50,
    tag?: string,
    page = 1,
    scope: DiscoveryScope = 'all',
    signal?: AbortSignal
  ) =>
    request<PageResponse & { notes: SearchNote[] }>(
      `/notes/search?q=${encodeURIComponent(q)}&type=${type}&page=${page}&limit=${limit}&scope=${encodeURIComponent(scope)}${tag ? `&tag=${encodeURIComponent(tag)}` : ''}`,
      { signal }
    ),
  uploadNoteImage: async (noteId: string, file: File) => {
    let phase = 'requesting signed upload URL';
    logImageUpload('starting', { noteId, file, phase });
    try {
      const { uploads } = await request<{ uploads: SignedImageUpload[] }>(
        `/attachments/notes/${noteId}/image-uploads`,
        {
          method: 'POST',
          body: JSON.stringify({ files: [{ filename: file.name, mimeType: file.type, size: file.size }] }),
        }
      );
      const upload = uploads[0];
      if (!upload) throw new Error('API did not return an upload URL');

      phase = 'uploading to object storage';
      logImageUpload('signed upload started', { noteId, file, phase });
      const uploadResponse = await fetch(upload.signedUrl, {
        method: upload.method,
        headers: upload.headers,
        body: file,
      });
      if (!uploadResponse.ok) throw new ApiError('Image upload failed', uploadResponse.status);

      phase = 'finalizing attachment';
      logImageUpload('attachment completion started', { noteId, file, phase });
      const completed = await request<UploadImageResponse>(`/attachments/${upload.attachment.id}/complete`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      logImageUpload('completed', { noteId, file, phase });
      return completed;
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 400) {
        logImageUpload('failed', {
          noteId,
          file,
          phase,
          status: error instanceof ApiError ? error.status : undefined,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
        throw error;
      }

      phase = 'uploading through the API fallback';
      logImageUpload('signed upload unavailable; using fallback', { noteId, file, phase, status: error.status });
      try {
        const formData = new FormData();
        formData.set('image', file);
        const completed = await uploadRequest<UploadImageResponse>(`/attachments/notes/${noteId}/images`, formData);
        logImageUpload('fallback completed', { noteId, file, phase });
        return completed;
      } catch (fallbackError) {
        logImageUpload('fallback failed', {
          noteId,
          file,
          phase,
          status: fallbackError instanceof ApiError ? fallbackError.status : undefined,
          message: fallbackError instanceof Error ? fallbackError.message : 'Unknown error',
        });
        throw fallbackError;
      }
    }
  },
  trash: (page = 1, limit = 50) => request<TrashResponse>(`/trash?page=${page}&limit=${limit}`),
  trashedFolderContents: (folderId: string) => request<TrashedFolderContents>(`/trash/folders/${folderId}/contents`),
  restoreTrashedNote: (noteId: string, folderId?: string) =>
    request<{ note: Note; restoredToOriginalFolder: boolean }>(`/trash/notes/${noteId}/restore`, {
      method: 'POST',
      body: JSON.stringify(folderId ? { folderId } : {}),
    }),
  permanentlyDeleteTrashedNote: (noteId: string) =>
    request<{ ok: true; deletedAttachmentCount: number }>(`/trash/notes/${noteId}`, { method: 'DELETE' }),
  restoreTrashedFolder: (folderId: string) =>
    request<{ folder: Folder; restoredAtTopLevel: boolean; noteCount: number }>(`/trash/folders/${folderId}/restore`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  permanentlyDeleteTrashedFolder: (folderId: string) =>
    request<{
      ok: true;
      deletedFolderCount: number;
      deletedNoteCount: number;
      deletedAttachmentCount: number;
    }>(`/trash/folders/${folderId}`, { method: 'DELETE' }),
  deleteNote: (noteId: string) => request<{ ok: true; deletedAt: string }>(`/notes/${noteId}`, { method: 'DELETE' }),
  trashEmptyDraft: (noteId: string, draft: { createdAt: string; updatedAt: string }) =>
    request<{ ok: true; deletedAt: string }>(`/notes/${noteId}/empty-draft`, {
      method: 'DELETE',
      body: JSON.stringify(draft),
    }),
};
