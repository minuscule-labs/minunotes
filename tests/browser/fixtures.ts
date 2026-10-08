import { expect, type Page } from '@playwright/test';

type BrowserCommentAnchor = {
  anchorType: 'range' | 'line';
  from: number;
  to: number;
  quote: string;
  prefix?: string;
  suffix?: string;
  documentHash: string;
  detached: boolean;
};

type BrowserIdentity = {
  key: string;
  type: 'user' | 'agent' | 'former' | 'system';
  displayName: string | null;
  maskedEmail: string | null;
  label: string;
  isCurrentUser: boolean;
};

type BrowserCommentMessage = {
  id: string;
  threadId: string;
  body: string;
  author: BrowserIdentity;
  createdAt: string;
  updatedAt: string;
  reactions: Array<{ emoji: string; count: number; reactedByCurrentActor: boolean }>;
  authoredByCurrentActor: boolean;
};

type BrowserCommentThread = {
  id: string;
  noteId: string;
  status: 'open' | 'resolved';
  anchor: BrowserCommentAnchor;
  createdBy: BrowserIdentity;
  resolvedBy: BrowserIdentity | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  messages: BrowserCommentMessage[];
  authoredByCurrentActor: boolean;
};

type Note = {
  id: string;
  folderId: string;
  title: string;
  content: string;
  documentType: 'markdown' | 'canvas.default' | 'canvas.mindmap';
  type: 'note' | 'template';
  isApiEditable: boolean;
  updatedByActorType: 'user' | 'agent' | 'system' | null;
  updatedByActorId: string | null;
  createdAt: string;
  updatedAt: string;
};

const now = '2026-07-12T00:00:00.000Z';

export const browserFixture = {
  folder: {
    id: 'folder_browser',
    parentFolderId: null,
    title: 'Browser tests',
    isPrivate: false,
    isAgentReadOnly: false,
    createdAt: now,
    updatedAt: now,
  },
  childFolder: {
    id: 'folder_child_browser',
    parentFolderId: 'folder_browser',
    title: 'Child folder',
    isPrivate: false,
    isAgentReadOnly: false,
    createdAt: now,
    updatedAt: now,
  },
  source: {
    id: 'note_source',
    folderId: 'folder_browser',
    title: 'Source Note',
    content: 'Start here.',
    documentType: 'markdown',
    type: 'note',
    isApiEditable: true,
    updatedByActorType: 'user',
    updatedByActorId: 'user_browser',
    createdAt: now,
    updatedAt: now,
  } satisfies Note,
  linked: {
    id: 'note_linked',
    folderId: 'folder_browser',
    title: 'Linked Note',
    content:
      '**Integration reference:** [[note_target|MinuNotes integration — MinuEditor v0.11.1]]\n\nSee [[Target Note]], [[note_target|Target by ID]], and [[Missing Note]].\n\n```ts\nconst answer: number = 42;\n```\n\n```unknownlang\nfallback code\n```\n\n```\nplain code\n```',
    documentType: 'markdown',
    type: 'note',
    isApiEditable: true,
    updatedByActorType: 'user',
    updatedByActorId: 'user_browser',
    createdAt: now,
    updatedAt: now,
  } satisfies Note,
  canvas: {
    id: 'note_canvas',
    folderId: 'folder_browser',
    title: 'Canvas Note',
    content: '{"nodes":[],"edges":[]}',
    documentType: 'canvas.default',
    type: 'note',
    isApiEditable: true,
    updatedByActorType: 'user',
    updatedByActorId: 'user_browser',
    createdAt: now,
    updatedAt: now,
  } satisfies Note,
  child: {
    id: 'note_child',
    folderId: 'folder_child_browser',
    title: 'Child Note',
    content: 'Child content.',
    documentType: 'markdown',
    type: 'note',
    isApiEditable: true,
    updatedByActorType: 'user',
    updatedByActorId: 'user_browser',
    createdAt: now,
    updatedAt: now,
  } satisfies Note,
  template: {
    id: 'note_template',
    folderId: 'folder_browser',
    title: 'Browser Template',
    content: '# Template',
    documentType: 'markdown',
    type: 'template',
    isApiEditable: true,
    updatedByActorType: 'user',
    updatedByActorId: 'user_browser',
    createdAt: now,
    updatedAt: now,
  } satisfies Note,
  trashedNote: {
    id: 'note_trashed',
    folderId: 'folder_browser',
    title: 'Recoverable Note',
    documentType: 'markdown' as const,
    type: 'note' as const,
    createdAt: now,
    updatedAt: now,
    deletedAt: now,
    originalFolderTitle: 'Browser tests',
    originalFolderAvailable: true,
  },
  trashedTemplate: {
    id: 'note_trashed_template',
    folderId: 'folder_missing',
    title: 'Recoverable Template',
    documentType: 'markdown' as const,
    type: 'template' as const,
    createdAt: now,
    updatedAt: now,
    deletedAt: now,
    originalFolderTitle: null,
    originalFolderAvailable: false,
  },
  trashedFolder: {
    id: 'folder_trashed',
    parentFolderId: 'folder_missing',
    title: 'Recoverable Folder',
    createdAt: now,
    updatedAt: now,
    deletedAt: now,
    originalParentTitle: null,
    originalParentAvailable: false,
    descendantFolderCount: 2,
    noteCount: 3,
  },
  trashedFolderContents: {
    rootFolderId: 'folder_trashed',
    folders: [
      {
        id: 'folder_trashed',
        parentFolderId: 'folder_missing',
        title: 'Recoverable Folder',
        createdAt: now,
        updatedAt: now,
        deletedAt: now,
      },
      {
        id: 'folder_trashed_research',
        parentFolderId: 'folder_trashed',
        title: 'Research',
        createdAt: now,
        updatedAt: now,
        deletedAt: now,
      },
      {
        id: 'folder_trashed_archive',
        parentFolderId: 'folder_trashed_research',
        title: 'Archive',
        createdAt: now,
        updatedAt: now,
        deletedAt: now,
      },
    ],
    notes: [
      {
        id: 'note_trashed_overview',
        folderId: 'folder_trashed',
        title: 'Project overview',
        documentType: 'markdown' as const,
        type: 'note' as const,
        createdAt: now,
        updatedAt: now,
        deletedAt: now,
      },
      {
        id: 'note_trashed_competitors',
        folderId: 'folder_trashed_research',
        title: 'Competitor notes',
        documentType: 'markdown' as const,
        type: 'note' as const,
        createdAt: now,
        updatedAt: now,
        deletedAt: now,
      },
      {
        id: 'note_trashed_canvas',
        folderId: 'folder_trashed_archive',
        title: 'Planning board',
        documentType: 'canvas.default' as const,
        type: 'note' as const,
        createdAt: now,
        updatedAt: now,
        deletedAt: now,
      },
    ],
  },
  target: {
    id: 'note_target',
    folderId: 'folder_browser',
    title: 'Target Note',
    content: 'Target content.',
    documentType: 'markdown',
    type: 'note',
    isApiEditable: true,
    updatedByActorType: 'user',
    updatedByActorId: 'user_browser',
    createdAt: now,
    updatedAt: now,
  } satisfies Note,
};

export async function mockBrowserApi(
  page: Page,
  options: {
    uploadFails?: boolean;
    folderCreateFails?: boolean;
    noteTrashFails?: boolean;
    emptyDraftTrashDelayMs?: number;
    trashLoadFails?: boolean;
    trashMutationFails?: boolean;
    emptyTrash?: boolean;
    noteAccessRole?: 'owner' | 'viewer' | 'commenter' | 'editor';
    noteAccessSource?: 'note_grant' | 'folder_grant';
    folderAccessRole?: 'owner' | 'viewer' | 'commenter' | 'editor';
    creatorTrashAccess?: boolean;
    includeSharedCollaborations?: boolean;
    includeSharedFolderNavigation?: boolean;
    includeSharedByMe?: boolean;
    sharedByMeLoadFails?: boolean;
    sessionEmail?: string | null;
    collaborationInvitation?: {
      status?: 'pending' | 'accepted';
      acceptStatus?: 200 | 403 | 404;
    };
  } = {}
) {
  const folders = [{ ...browserFixture.folder }, { ...browserFixture.childFolder }];
  const notes = new Map<string, Note>([
    [browserFixture.source.id, { ...browserFixture.source }],
    [browserFixture.linked.id, { ...browserFixture.linked }],
    [browserFixture.canvas.id, { ...browserFixture.canvas }],
    [browserFixture.template.id, { ...browserFixture.template }],
    [browserFixture.target.id, { ...browserFixture.target }],
    [browserFixture.child.id, { ...browserFixture.child }],
  ]);
  const browserUserIdentity: BrowserIdentity = {
    key: 'user_browsercurrent',
    type: 'user',
    displayName: 'Browser Test User',
    maskedEmail: 'b•••@e•••.com',
    label: 'You',
    isCurrentUser: true,
  };
  const sharedOwnerIdentity = {
    key: 'user_collaborationowner',
    type: 'user' as const,
    displayName: 'Shared Owner',
    maskedEmail: 's•••@e•••.com',
    label: 'Shared Owner',
    isCurrentUser: false,
  };
  const trashNotes = options.emptyTrash
    ? []
    : [{ ...browserFixture.trashedNote }, { ...browserFixture.trashedTemplate }];
  const trashFolders = options.emptyTrash ? [] : [{ ...browserFixture.trashedFolder }];
  const trashMutationRequests: Array<{ method: string; path: string; body: unknown }> = [];
  const sharedFolderNavigationRequests: string[] = [];
  let createdNoteCount = 0;
  const noteShareTokens = new Map<string, string>([
    [`note_share_${browserFixture.linked.id}`, browserFixture.linked.id],
    [`note_share_${browserFixture.target.id}`, browserFixture.target.id],
  ]);
  const saveRequests: Array<{ noteId: string; body: Record<string, unknown> }> = [];
  const statusRequests: string[] = [];
  const commentThreads = new Map<string, BrowserCommentThread[]>();
  const commentRequests: Array<{ method: string; path: string; body: unknown }> = [];
  let commentId = 0;
  let hashVersion = 1;
  let noteAccessRole: 'owner' | 'viewer' | 'commenter' | 'editor' | null = options.noteAccessRole ?? 'owner';
  let noteShareLink: {
    id: string;
    noteId: string;
    permission: 'read';
    url: string;
    createdAt: string;
    updatedAt: string;
  } | null = options.includeSharedByMe
    ? {
        id: 'note_share_owned',
        noteId: browserFixture.source.id,
        permission: 'read',
        url: 'http://localhost:5173/share/note_share_owned',
        createdAt: now,
        updatedAt: now,
      }
    : null;
  let folderShareLink: {
    id: string;
    folderId: string;
    permission: 'read';
    url: string;
    createdAt: string;
    updatedAt: string;
  } | null = null;

  await page.route('**/internal/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/internal', '');
    const method = request.method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path === '/account/profile' && method === 'GET') {
      const sessionEmail = options.sessionEmail === undefined ? 'browser@example.com' : options.sessionEmail;
      return json({ profile: { identity: browserUserIdentity, email: sessionEmail, imageUrl: null } });
    }

    if (path === '/auth/update-user' && method === 'POST') {
      const body = request.postDataJSON() as { name?: string };
      browserUserIdentity.displayName = body.name?.trim().replace(/\s+/g, ' ') || null;
      return json({ status: true });
    }

    if (path === '/auth/get-session') {
      const sessionEmail = options.sessionEmail === undefined ? 'browser@example.com' : options.sessionEmail;
      if (!sessionEmail) return json(null);
      return json({
        user: {
          id: 'user_browser',
          name: browserUserIdentity.displayName ?? '',
          email: sessionEmail,
          emailVerified: true,
          image: null,
          createdAt: now,
          updatedAt: now,
        },
        session: { id: 'session_browser', userId: 'user_browser', expiresAt: '2099-01-01T00:00:00.000Z' },
      });
    }

    const invitationMatch = path.match(/^\/collaboration-invitations\/([^/]+)\/(preview|accept)$/);
    if (invitationMatch && options.collaborationInvitation) {
      if (invitationMatch[2] === 'preview' && method === 'GET')
        return json({
          resource: { type: 'note', id: browserFixture.source.id, title: browserFixture.source.title },
          owner: { name: 'Shared Owner' },
          role: 'commenter',
          invitedEmail: 'b••••••@example.com',
          expiresAt: '2099-01-01T00:00:00.000Z',
          status: options.collaborationInvitation.status ?? 'pending',
        });
      if (invitationMatch[2] === 'accept' && method === 'POST') {
        const acceptStatus = options.collaborationInvitation.acceptStatus ?? 200;
        if (acceptStatus === 403) return json({ error: 'Invitation email does not match the signed-in account' }, 403);
        if (acceptStatus === 404) return json({ error: 'Invitation not found' }, 404);
        return json({
          grant: { id: 'grant_invitation', role: 'commenter' },
          destination: `/notes/${browserFixture.source.id}`,
        });
      }
    }

    if (path === '/collaborations/shared-folder-roots' && method === 'GET') {
      sharedFolderNavigationRequests.push(path);
      const folders = options.includeSharedFolderNavigation
        ? [
            {
              id: 'folder_shared_nav',
              title: 'Shared project',
              updatedAt: now,
              role: 'viewer',
              hasChildren: true,
            },
          ]
        : [];
      return json({ folders, pageInfo: { hasMore: false } });
    }

    const sharedChildrenMatch = path.match(/^\/folders\/([^/]+)\/children$/);
    if (sharedChildrenMatch && method === 'GET') {
      sharedFolderNavigationRequests.push(path);
      const parentId = sharedChildrenMatch[1];
      if (parentId !== 'folder_shared_nav' && parentId !== 'folder_shared_nav_child')
        return json({ error: 'Folder not found' }, 404);
      const baseChildren = !options.includeSharedFolderNavigation
        ? []
        : parentId === 'folder_shared_nav'
          ? [
              {
                id: 'folder_shared_nav_child',
                title: 'Shared subfolder',
                parentFolderId: parentId,
                updatedAt: now,
                isPrivate: false,
                isAgentReadOnly: false,
                hasChildren: true,
              },
            ]
          : [
              {
                id: 'folder_shared_nav_grandchild',
                title: 'Shared nested folder',
                parentFolderId: parentId,
                updatedAt: now,
                isPrivate: false,
                isAgentReadOnly: false,
                hasChildren: false,
              },
            ];
      const createdChildren = options.includeSharedFolderNavigation
        ? folders
            .filter((folder) => folder.parentFolderId === parentId)
            .map((folder) => ({
              id: folder.id,
              title: folder.title,
              parentFolderId: parentId,
              updatedAt: folder.updatedAt,
              isPrivate: folder.isPrivate,
              isAgentReadOnly: folder.isAgentReadOnly,
              hasChildren: folders.some((child) => child.parentFolderId === folder.id),
            }))
        : [];
      return json({ folders: [...baseChildren, ...createdChildren], pageInfo: { hasMore: false, nextCursor: null } });
    }

    if (path === '/collaborations/shared-with-me' && method === 'GET') {
      const collaborations = options.includeSharedCollaborations
        ? [
            {
              type: 'note' as const,
              grantId: 'access_shared_note',
              role: options.noteAccessRole === 'owner' ? 'viewer' : (options.noteAccessRole ?? 'viewer'),
              owner: sharedOwnerIdentity,
              note: {
                id: browserFixture.source.id,
                title: browserFixture.source.title,
                documentType: browserFixture.source.documentType,
                updatedAt: browserFixture.source.updatedAt,
              },
            },
            {
              type: 'folder' as const,
              grantId: 'access_shared_folder',
              role: 'editor' as const,
              owner: sharedOwnerIdentity,
              folder: {
                id: browserFixture.folder.id,
                title: browserFixture.folder.title,
                updatedAt: browserFixture.folder.updatedAt,
              },
            },
          ]
        : [];
      const type = url.searchParams.get('type');
      return json({
        collaborations: type ? collaborations.filter((item) => item.type === type) : collaborations,
        ...(type ? { pageInfo: { hasMore: false, nextCursor: null } } : {}),
      });
    }

    if (path === '/collaborations/shared-by-me' && method === 'GET') {
      if (options.sharedByMeLoadFails) return json({ error: 'Unable to load owner sharing' }, 500);
      const type = url.searchParams.get('type');
      const query = url.searchParams.get('q')?.toLowerCase() ?? '';
      const cursor = url.searchParams.get('cursor');
      const noteResources = [
        {
          type: 'note' as const,
          resource: {
            id: browserFixture.source.id,
            title: browserFixture.source.title,
            updatedAt: browserFixture.source.updatedAt,
          },
          activeCollaboratorCount: 2,
          pendingInvitationCount: 1,
          expiredInvitationCount: 0,
          publicLinkActive: true,
        },
        {
          type: 'note' as const,
          resource: {
            id: browserFixture.linked.id,
            title: browserFixture.linked.title,
            updatedAt: browserFixture.linked.updatedAt,
          },
          activeCollaboratorCount: 0,
          pendingInvitationCount: 0,
          expiredInvitationCount: 1,
          publicLinkActive: false,
        },
      ];
      const folderResources = [
        {
          type: 'folder' as const,
          resource: {
            id: browserFixture.folder.id,
            title: browserFixture.folder.title,
            updatedAt: browserFixture.folder.updatedAt,
          },
          activeCollaboratorCount: 1,
          pendingInvitationCount: 1,
          expiredInvitationCount: 1,
          publicLinkActive: false,
        },
      ];
      if (!options.includeSharedByMe) return json({ resources: [], pageInfo: { hasMore: false, nextCursor: null } });
      const matching = (type === 'note' ? noteResources : folderResources).filter((item) =>
        item.resource.title.toLowerCase().includes(query)
      );
      if (type === 'note' && !query) {
        const resources = cursor === 'owned-note-page-2' ? matching.slice(1) : matching.slice(0, 1);
        return json({
          resources,
          pageInfo: {
            hasMore: !cursor && matching.length > 1,
            nextCursor: !cursor && matching.length > 1 ? 'owned-note-page-2' : null,
          },
        });
      }
      return json({ resources: matching, pageInfo: { hasMore: false, nextCursor: null } });
    }

    const noteShareLinkMatch = path.match(/^\/notes\/([^/]+)\/share-link$/);
    if (noteShareLinkMatch && method === 'GET') return json({ shareLink: noteShareLink });
    if (noteShareLinkMatch && method === 'POST') {
      noteShareLink = {
        id: 'note_share_owned',
        noteId: noteShareLinkMatch[1],
        permission: 'read',
        url: 'http://localhost:5173/share/note_share_owned',
        createdAt: now,
        updatedAt: now,
      };
      return json({ shareLink: noteShareLink }, 201);
    }
    if (noteShareLinkMatch && method === 'DELETE') {
      noteShareLink = null;
      return json({ ok: true });
    }

    if (/^\/(notes|folders)\/[^/]+\/collaborators$/.test(path) && method === 'POST')
      return json(
        {
          kind: 'grant',
          emailDelivery: 'disabled',
          grant: { key: 'access_added', role: 'viewer' },
        },
        201
      );

    if (/^\/(notes|folders)\/[^/]+\/collaborators$/.test(path) && method === 'GET')
      return json({
        resource: { id: path.split('/')[2], title: 'Shared resource' },
        grants: [
          {
            key: 'access_browseractive',
            role: 'viewer',
            createdAt: now,
            updatedAt: now,
            user: {
              key: 'user_browseractive',
              type: 'user',
              displayName: 'Active Collaborator',
              maskedEmail: 'a•••@e•••.com',
              label: 'Active Collaborator',
              isCurrentUser: false,
            },
          },
        ],
        invitations: [
          {
            id: 'invitation_browser_pending',
            email: 'p•••@e•••.com',
            role: 'commenter',
            expiresAt: '2099-01-01T00:00:00.000Z',
            createdAt: now,
            updatedAt: now,
          },
          {
            id: 'invitation_browser_expired',
            email: 'e•••@e•••.com',
            role: 'editor',
            expiresAt: '2000-01-01T00:00:00.000Z',
            createdAt: now,
            updatedAt: now,
          },
        ],
      });

    if (path === '/trash' && method === 'GET') {
      if (options.trashLoadFails) return json({ error: 'Trash is temporarily unavailable' }, 500);
      return json({ notes: trashNotes, folders: trashFolders });
    }

    if (path === `/trash/folders/${browserFixture.trashedFolder.id}/contents` && method === 'GET')
      return json(browserFixture.trashedFolderContents);

    const restoreTrashNoteMatch = path.match(/^\/trash\/notes\/(note_[a-zA-Z0-9_]+)\/restore$/);
    if (restoreTrashNoteMatch && method === 'POST') {
      const body = request.postDataJSON() as { folderId?: string };
      trashMutationRequests.push({ method, path, body });
      if (options.trashMutationFails) return json({ error: 'Trashed note not found' }, 404);
      const index = trashNotes.findIndex((note) => note.id === restoreTrashNoteMatch[1]);
      if (index < 0) return json({ error: 'Trashed note not found' }, 404);
      const [trashed] = trashNotes.splice(index, 1);
      const folderId = body.folderId ?? trashed.folderId;
      const note: Note = {
        id: trashed.id,
        folderId,
        title: trashed.title,
        content: '# Restored',
        documentType: trashed.documentType,
        type: trashed.type,
        isApiEditable: true,
        updatedByActorType: 'user',
        updatedByActorId: 'user_browser',
        createdAt: trashed.createdAt,
        updatedAt: now,
      };
      notes.set(note.id, note);
      return json({ note, restoredToOriginalFolder: !body.folderId });
    }

    const purgeTrashNoteMatch = path.match(/^\/trash\/notes\/(note_[a-zA-Z0-9_]+)$/);
    if (purgeTrashNoteMatch && method === 'DELETE') {
      trashMutationRequests.push({ method, path, body: null });
      if (options.trashMutationFails) return json({ error: 'Trashed note not found' }, 404);
      const index = trashNotes.findIndex((note) => note.id === purgeTrashNoteMatch[1]);
      if (index < 0) return json({ error: 'Trashed note not found' }, 404);
      trashNotes.splice(index, 1);
      return json({ ok: true, deletedAttachmentCount: 1 });
    }

    const restoreTrashFolderMatch = path.match(/^\/trash\/folders\/(folder_[a-zA-Z0-9_]+)\/restore$/);
    if (restoreTrashFolderMatch && method === 'POST') {
      trashMutationRequests.push({ method, path, body: request.postDataJSON() });
      if (options.trashMutationFails) return json({ error: 'Trashed folder not found' }, 404);
      const index = trashFolders.findIndex((folder) => folder.id === restoreTrashFolderMatch[1]);
      if (index < 0) return json({ error: 'Trashed folder not found' }, 404);
      const [trashed] = trashFolders.splice(index, 1);
      const folder = {
        id: trashed.id,
        parentFolderId: null,
        title: trashed.title,
        isPrivate: false,
        isAgentReadOnly: false,
        createdAt: trashed.createdAt,
        updatedAt: now,
      };
      folders.push(folder);
      return json({ folder, restoredAtTopLevel: true, noteCount: trashed.noteCount });
    }

    const purgeTrashFolderMatch = path.match(/^\/trash\/folders\/(folder_[a-zA-Z0-9_]+)$/);
    if (purgeTrashFolderMatch && method === 'DELETE') {
      trashMutationRequests.push({ method, path, body: null });
      if (options.trashMutationFails) return json({ error: 'Trashed folder not found' }, 404);
      const index = trashFolders.findIndex((folder) => folder.id === purgeTrashFolderMatch[1]);
      if (index < 0) return json({ error: 'Trashed folder not found' }, 404);
      const [trashed] = trashFolders.splice(index, 1);
      return json({
        ok: true,
        deletedFolderCount: trashed.descendantFolderCount + 1,
        deletedNoteCount: trashed.noteCount,
        deletedAttachmentCount: 0,
      });
    }

    if (path === '/folders' && method === 'GET') return json({ folders });

    if (path === '/folders' && method === 'POST') {
      if (options.folderCreateFails) return json({ error: 'Folder creation unavailable' }, 500);
      const body = request.postDataJSON() as { title?: string; parentFolderId?: string | null };
      const folder = {
        ...browserFixture.folder,
        id: `folder_created_${folders.length + 1}`,
        parentFolderId: body.parentFolderId ?? null,
        title: body.title ?? 'Untitled folder',
        canTrash: options.creatorTrashAccess === true,
      };
      folders.push(folder);
      return json({ folder }, 201);
    }

    const folderDetailMatch = path.match(/^\/folders\/(folder_[a-zA-Z0-9_]+)\/detail$/);
    if (folderDetailMatch && method === 'GET') {
      if (options.includeSharedFolderNavigation && folderDetailMatch[1] === 'folder_shared_nav_child') {
        return json({
          folder: {
            id: 'folder_shared_nav_child',
            parentFolderId: 'folder_shared_nav',
            title: 'Shared subfolder',
            isPrivate: false,
            isAgentReadOnly: false,
            createdAt: now,
            updatedAt: now,
          },
          ancestors: [
            {
              id: 'folder_shared_nav',
              parentFolderId: null,
              title: 'Shared project',
              isPrivate: false,
              isAgentReadOnly: false,
              createdAt: now,
              updatedAt: now,
            },
          ],
          childFolders: [],
          access: { role: options.folderAccessRole ?? 'viewer', source: 'folder_grant' },
          sharedBy: sharedOwnerIdentity,
        });
      }
      const folder = folders.find((candidate) => candidate.id === folderDetailMatch[1]);
      if (!folder) return json({ error: 'Folder not found' }, 404);
      const folderAccessRole = options.folderAccessRole ?? 'owner';
      const ancestors = folders.filter((candidate) => candidate.id === folder.parentFolderId);
      return json({
        folder: { ...folder, canTrash: false },
        ancestors,
        childFolders: folders
          .filter((candidate) => candidate.parentFolderId === folder.id)
          .map((candidate) => ({ ...candidate, canTrash: options.creatorTrashAccess === true })),
        access: {
          role: folderAccessRole,
          source: folderAccessRole === 'owner' ? 'owner' : 'folder_grant',
        },
        sharedBy: folderAccessRole === 'owner' ? null : sharedOwnerIdentity,
      });
    }

    const folderMatch = path.match(/^\/folders\/(folder_[a-zA-Z0-9_]+)$/);
    if (folderMatch && method === 'DELETE') {
      const rootId = folderMatch[1];
      const deletedIds = new Set([rootId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const folder of folders) {
          if (folder.parentFolderId && deletedIds.has(folder.parentFolderId) && !deletedIds.has(folder.id)) {
            deletedIds.add(folder.id);
            changed = true;
          }
        }
      }
      const deletedNoteIds = [...notes.values()].filter((note) => deletedIds.has(note.folderId)).map((note) => note.id);
      for (const noteId of deletedNoteIds) notes.delete(noteId);
      for (let index = folders.length - 1; index >= 0; index -= 1) {
        if (deletedIds.has(folders[index].id)) folders.splice(index, 1);
      }
      return json({ ok: true, deletedAt: now, folderCount: deletedIds.size, noteCount: deletedNoteIds.length });
    }

    const folderNotesMatch = path.match(/^\/folders\/(folder_[a-zA-Z0-9_]+)\/notes$/);
    if (folderNotesMatch && method === 'POST') {
      const body = request.postDataJSON() as Partial<Pick<Note, 'title' | 'content' | 'documentType' | 'type'>>;
      const note: Note = {
        ...browserFixture.source,
        id: `note_created_${++createdNoteCount}`,
        folderId: folderNotesMatch[1],
        title: body.title ?? 'Untitled note',
        content: body.content ?? '',
        documentType: body.documentType ?? 'markdown',
        type: body.type ?? 'note',
      };
      notes.set(note.id, note);
      return json({ note }, 201);
    }
    if (folderNotesMatch && method === 'GET') {
      const sharedFolder = options.includeSharedFolderNavigation && folderNotesMatch[1] === 'folder_shared_nav_child';
      if (!sharedFolder && !folders.some((folder) => folder.id === folderNotesMatch[1]))
        return json({ error: 'Folder not found' }, 404);
      const type = url.searchParams.get('type') === 'template' ? 'template' : 'note';
      const folderAccessRole = options.folderAccessRole ?? 'owner';
      return json({
        notes: [...notes.values()]
          .filter((note) => note.folderId === folderNotesMatch[1] && note.type === type)
          .map((note) => ({ ...note, canTrash: options.creatorTrashAccess === true })),
        access: {
          role: folderAccessRole,
          source: folderAccessRole === 'owner' ? 'owner' : 'folder_grant',
        },
      });
    }

    if (path === '/notes/templates' && method === 'GET')
      return json({ templates: [...notes.values()].filter((note) => note.type === 'template') });

    if (path === `/folders/${browserFixture.folder.id}/share-link` && method === 'GET')
      return json({ shareLink: folderShareLink });

    if (path === `/folders/${browserFixture.folder.id}/share-link` && method === 'POST') {
      folderShareLink = {
        id: 'folder_share_browser',
        folderId: browserFixture.folder.id,
        permission: 'read',
        url: 'http://localhost:5173/share/folders/folder_share_token',
        createdAt: now,
        updatedAt: now,
      };
      return json({ shareLink: folderShareLink }, 201);
    }

    if (path === `/folders/${browserFixture.folder.id}/share-link` && method === 'DELETE') {
      folderShareLink = null;
      return json({ ok: true });
    }

    if (path === `/share/folders/folder_share_token` && method === 'GET')
      return json({
        folder: {
          id: browserFixture.folder.id,
          title: browserFixture.folder.title,
          updatedAt: browserFixture.folder.updatedAt,
        },
        folders: [
          {
            id: browserFixture.childFolder.id,
            parentFolderId: browserFixture.childFolder.parentFolderId,
            title: browserFixture.childFolder.title,
            updatedAt: browserFixture.childFolder.updatedAt,
          },
        ],
        notes: [...notes.values()]
          .filter((note) => note.type === 'note')
          .map((note) => ({
            id: note.id,
            folderId: note.folderId,
            title: note.title,
            content: note.content,
            documentType: note.documentType,
            updatedAt: note.updatedAt,
          })),
        share: { id: 'folder_share_browser', permission: 'read', createdAt: now },
      });

    const folderNoteWikilinksMatch = path.match(
      /^\/share\/folders\/folder_share_token\/notes\/(note_[a-zA-Z0-9_]+)\/wikilinks$/
    );
    if (folderNoteWikilinksMatch && method === 'GET') {
      const note = notes.get(folderNoteWikilinksMatch[1]);
      if (!note) return json({ error: 'Shared note not found' }, 404);
      return json({
        resolutions:
          note.id === browserFixture.linked.id
            ? [
                {
                  target: 'Target Note',
                  href: `/share/folders/folder_share_token?note=${browserFixture.target.id}`,
                },
                {
                  target: browserFixture.target.id,
                  href: `/share/folders/folder_share_token?note=${browserFixture.target.id}`,
                },
                { target: 'Missing Note', href: null },
              ]
            : [],
      });
    }

    const sharedNoteMatch = path.match(/^\/share\/(note_share_note_[a-zA-Z0-9_]+)$/);
    if (sharedNoteMatch && method === 'GET') {
      const token = sharedNoteMatch[1];
      const noteId = noteShareTokens.get(token);
      const note = noteId ? notes.get(noteId) : undefined;
      if (!note) return json({ error: 'Shared note not found' }, 404);
      return json({
        note: {
          title: note.title,
          content: note.content,
          documentType: note.documentType,
          updatedAt: note.updatedAt,
        },
        share: { id: `share_${note.id}`, permission: 'read', createdAt: now },
        resolutions:
          note.id === browserFixture.linked.id
            ? [
                { target: 'Target Note', href: `/share/note_share_${browserFixture.target.id}` },
                { target: browserFixture.target.id, href: `/share/note_share_${browserFixture.target.id}` },
                { target: 'Missing Note', href: null },
              ]
            : [],
      });
    }

    if (path === '/notes/recent' && method === 'GET') {
      const scope = url.searchParams.get('scope') ?? 'all';
      return json({
        notes: [...notes.values()]
          .filter((note) => note.type === 'note')
          .map((note) => {
            const shared = options.includeSharedCollaborations && note.id === browserFixture.source.id;
            return {
              ...note,
              ...(shared ? { folderId: null } : {}),
              access: shared ? { role: 'commenter', source: 'note_grant' } : { role: 'owner', source: 'owner' },
              owner: shared ? sharedOwnerIdentity : null,
            };
          })
          .filter(
            (note) =>
              scope === 'all' || (scope === 'shared' ? note.access.role !== 'owner' : note.access.role === 'owner')
          ),
      });
    }

    if (path === '/notes/trash' && method === 'POST') {
      const body = request.postDataJSON() as { noteIds?: string[] };
      const noteIds = body.noteIds ?? [];
      for (const noteId of noteIds) notes.delete(noteId);
      return json({ ok: true, deletedAt: now, noteCount: noteIds.length });
    }

    if (path === '/notes/move' && method === 'POST') {
      const body = request.postDataJSON() as { noteIds?: string[]; targetFolderId?: string };
      const moved = (body.noteIds ?? []).map((noteId) => {
        const note = notes.get(noteId);
        if (!note) return null;
        Object.assign(note, { folderId: body.targetFolderId ?? note.folderId, updatedAt: now });
        return { note, contentHash: `hash_${++hashVersion}` };
      });
      return json({ notes: moved.filter(Boolean) });
    }

    if (path === '/notes/search' && method === 'GET') {
      const query = url.searchParams.get('q')?.toLowerCase() ?? '';
      const scope = url.searchParams.get('scope') ?? 'all';
      return json({
        notes: [...notes.values()]
          .filter((note) => note.title.toLowerCase().includes(query))
          .map((note) => {
            const shared = options.includeSharedCollaborations && note.id === browserFixture.source.id;
            return {
              ...note,
              folderTitle: shared ? null : browserFixture.folder.title,
              ...(shared ? { folderId: null } : {}),
              access: shared ? { role: 'commenter', source: 'note_grant' } : { role: 'owner', source: 'owner' },
              owner: shared ? sharedOwnerIdentity : null,
            };
          })
          .filter(
            (note) =>
              scope === 'all' || (scope === 'shared' ? note.access.role !== 'owner' : note.access.role === 'owner')
          ),
      });
    }

    if (
      (path === '/attachments/att_browser/content' ||
        path === '/share/note_share_note_linked/attachments/att_browser/content' ||
        path ===
          `/share/folders/folder_share_token/notes/${browserFixture.linked.id}/attachments/att_browser/content`) &&
      method === 'GET'
    ) {
      return route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
          'base64'
        ),
      });
    }

    if (path === `/attachments/notes/${browserFixture.source.id}/image-uploads` && method === 'POST')
      return json({ error: 'Signed uploads are not supported by the configured storage driver' }, 400);

    if (path === `/attachments/notes/${browserFixture.source.id}/images` && method === 'POST') {
      if (options.uploadFails) return json({ error: 'Attachment storage unavailable' }, 500);
      return json(
        {
          attachment: { id: 'att_browser', filename: 'browser.png' },
          markdownUrl: '/internal/attachments/att_browser/content',
          markdown: '![browser.png](/internal/attachments/att_browser/content)',
        },
        201
      );
    }

    const commentReactionMatch = path.match(
      /^\/notes\/(note_[a-zA-Z0-9]+)\/comments\/(comment_thread_[a-zA-Z0-9]+)\/messages\/(comment_message_[a-zA-Z0-9]+)\/reactions$/
    );
    if (commentReactionMatch && method === 'POST') {
      const [, noteId, threadId, messageId] = commentReactionMatch;
      const thread = (commentThreads.get(noteId) ?? []).find((candidate) => candidate.id === threadId);
      const message = thread?.messages.find((candidate) => candidate.id === messageId);
      if (!message) return json({ error: 'Comment message not found' }, 404);
      const body = request.postDataJSON() as { emoji: BrowserCommentMessage['reactions'][number]['emoji'] };
      commentRequests.push({ method, path, body });
      const existing = message.reactions.find((reaction) => reaction.emoji === body.emoji);
      message.reactions = existing
        ? existing.reactedByCurrentActor
          ? existing.count === 1
            ? message.reactions.filter((reaction) => reaction.emoji !== body.emoji)
            : message.reactions.map((reaction) =>
                reaction.emoji === body.emoji
                  ? { ...reaction, count: reaction.count - 1, reactedByCurrentActor: false }
                  : reaction
              )
          : message.reactions.map((reaction) =>
              reaction.emoji === body.emoji
                ? { ...reaction, count: reaction.count + 1, reactedByCurrentActor: true }
                : reaction
            )
        : [...message.reactions, { emoji: body.emoji, count: 1, reactedByCurrentActor: true }];
      return json({ messageId, reactions: message.reactions });
    }

    const commentMessagesMatch = path.match(
      /^\/notes\/(note_[a-zA-Z0-9]+)\/comments\/(comment_thread_[a-zA-Z0-9]+)\/messages\/(comment_message_[a-zA-Z0-9]+)$/
    );
    if (commentMessagesMatch) {
      const [, noteId, threadId, messageId] = commentMessagesMatch;
      const thread = (commentThreads.get(noteId) ?? []).find((candidate) => candidate.id === threadId);
      const message = thread?.messages.find((candidate) => candidate.id === messageId);
      if (!thread || !message) return json({ error: 'Comment message not found' }, 404);
      commentRequests.push({ method, path, body: method === 'PATCH' ? request.postDataJSON() : null });
      if (method === 'PATCH') {
        const body = request.postDataJSON() as { body?: string };
        message.body = body.body ?? message.body;
        message.updatedAt = '2026-07-12T00:01:00.000Z';
        thread.updatedAt = now;
        return json({ message });
      }
      if (method === 'DELETE') {
        thread.messages = thread.messages.filter((candidate) => candidate.id !== messageId);
        return json({ ok: true, deletedThread: false });
      }
    }

    const commentActionMatch = path.match(
      /^\/notes\/(note_[a-zA-Z0-9]+)\/comments\/(comment_thread_[a-zA-Z0-9]+)\/(replies|anchor|resolve|reopen)$/
    );
    if (commentActionMatch) {
      const [, noteId, threadId, action] = commentActionMatch;
      const thread = (commentThreads.get(noteId) ?? []).find((candidate) => candidate.id === threadId);
      if (!thread) return json({ error: 'Comment thread not found' }, 404);
      const body = action === 'resolve' || action === 'reopen' ? {} : request.postDataJSON();
      commentRequests.push({ method, path, body });
      if (action === 'replies' && method === 'POST') {
        const message: BrowserCommentMessage = {
          id: `comment_message_${++commentId}`,
          threadId,
          body: (body as { body?: string }).body ?? '',
          author: browserUserIdentity,
          createdAt: now,
          updatedAt: now,
          reactions: [],
          authoredByCurrentActor: true,
        };
        thread.messages.push(message);
        thread.updatedAt = now;
        return json({ message }, 201);
      }
      if (action === 'anchor' && method === 'PATCH') {
        thread.anchor = { ...(body as { anchor: BrowserCommentAnchor }).anchor };
        return json({ thread });
      }
      if (action === 'resolve' || action === 'reopen') {
        thread.status = action === 'resolve' ? 'resolved' : 'open';
        thread.resolvedBy = action === 'resolve' ? browserUserIdentity : null;
        thread.resolvedAt = action === 'resolve' ? now : null;
        return json({ thread });
      }
    }

    const commentThreadMatch = path.match(/^\/notes\/(note_[a-zA-Z0-9]+)\/comments\/(comment_thread_[a-zA-Z0-9]+)$/);
    if (commentThreadMatch && method === 'DELETE') {
      const [, noteId, threadId] = commentThreadMatch;
      commentRequests.push({ method, path, body: null });
      commentThreads.set(
        noteId,
        (commentThreads.get(noteId) ?? []).filter((thread) => thread.id !== threadId)
      );
      return json({ ok: true });
    }

    const commentsMatch = path.match(/^\/notes\/(note_[a-zA-Z0-9]+)\/comments$/);
    if (commentsMatch) {
      const noteId = commentsMatch[1];
      if (!notes.has(noteId)) return json({ error: 'Note not found' }, 404);
      if (method === 'GET')
        return json({ noteId, documentHash: `hash_${hashVersion}`, threads: commentThreads.get(noteId) ?? [] });
      if (method === 'POST') {
        const body = request.postDataJSON() as {
          body: string;
          anchor: Omit<BrowserCommentAnchor, 'detached'> & { detached?: boolean };
        };
        commentRequests.push({ method, path, body });
        const currentHash = `hash_${hashVersion}`;
        if (body.anchor.documentHash !== currentHash)
          return json({ error: 'Document has changed since the comment anchor was created', currentHash }, 409);
        const threadId = `comment_thread_${++commentId}`;
        const thread: BrowserCommentThread = {
          id: threadId,
          noteId,
          status: 'open',
          anchor: { ...body.anchor, detached: body.anchor.detached ?? false },
          createdBy: browserUserIdentity,
          resolvedBy: null,
          resolvedAt: null,
          createdAt: now,
          updatedAt: now,
          authoredByCurrentActor: true,
          messages: [
            {
              id: `comment_message_${++commentId}`,
              threadId,
              body: body.body,
              author: browserUserIdentity,
              createdAt: now,
              updatedAt: now,
              reactions: [],
              authoredByCurrentActor: true,
            },
          ],
        };
        commentThreads.set(noteId, [thread, ...(commentThreads.get(noteId) ?? [])]);
        return json({ thread }, 201);
      }
    }

    const noteEventsMatch = path.match(/^\/notes\/(note_[a-zA-Z0-9]+)\/events$/);
    if (noteEventsMatch && method === 'GET') return json({ noteId: noteEventsMatch[1], events: [] });

    const emptyDraftMatch = path.match(/^\/notes\/(note_[a-zA-Z0-9_]+)\/empty-draft$/);
    if (emptyDraftMatch && method === 'DELETE') {
      if (options.emptyDraftTrashDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.emptyDraftTrashDelayMs));
      }
      const note = notes.get(emptyDraftMatch[1]);
      const body = request.postDataJSON() as { createdAt: string; updatedAt: string };
      trashMutationRequests.push({ method, path, body });
      if (options.noteTrashFails) return json({ error: 'Trash is temporarily unavailable' }, 500);
      if (
        note?.title !== 'Untitled note' ||
        note.content ||
        note.type !== 'note' ||
        note.documentType !== 'markdown' ||
        note.createdAt !== body.createdAt ||
        note.updatedAt !== body.updatedAt
      )
        return json({ error: 'Draft changed' }, 409);
      notes.delete(note.id);
      trashNotes.push({
        ...note,
        deletedAt: now,
        originalFolderTitle: browserFixture.folder.title,
        originalFolderAvailable: true,
      });
      return json({ ok: true, deletedAt: now });
    }

    const noteMatch = path.match(/^\/notes\/(note_[a-zA-Z0-9_]+)$/);
    if (noteMatch) {
      const note = notes.get(noteMatch[1]);
      if (!note) return json({ error: 'Note not found' }, 404);
      if (method === 'GET') {
        if (!noteAccessRole) return json({ error: 'Note not found' }, 404);
        return json({
          note,
          contentHash: `hash_${hashVersion}`,
          access: {
            role: noteAccessRole,
            source: noteAccessRole === 'owner' ? 'owner' : (options.noteAccessSource ?? 'note_grant'),
            canTrash: options.creatorTrashAccess === true,
          },
        });
      }
      if (method === 'DELETE') {
        if (options.noteTrashFails) return json({ error: 'Trash is temporarily unavailable' }, 500);
        notes.delete(note.id);
        return json({ ok: true, deletedAt: now });
      }
      if (method === 'PATCH') {
        const body = request.postDataJSON() as Partial<
          Pick<Note, 'title' | 'content' | 'folderId' | 'isApiEditable' | 'createdAt'>
        > & { baseHash?: string };
        const currentHash = `hash_${hashVersion}`;
        saveRequests.push({ noteId: note.id, body });
        if (body.baseHash && body.baseHash !== currentHash)
          return json({ error: 'Document has changed since it was read', currentHash }, 409);
        const changes = { ...body };
        delete changes.baseHash;
        Object.assign(note, changes, { updatedAt: now });
        hashVersion += 1;
        return json({ note, contentHash: `hash_${hashVersion}` });
      }
    }

    const statusMatch = path.match(/^\/notes\/(note_[a-zA-Z0-9]+)\/status$/);
    if (statusMatch) {
      statusRequests.push(statusMatch[1]);
      return json({ noteId: statusMatch[1], contentHash: `hash_${hashVersion}`, updatedAt: now });
    }

    const backlinksMatch = path.match(/^\/notes\/(note_[a-zA-Z0-9]+)\/backlinks$/);
    if (backlinksMatch) {
      const noteId = backlinksMatch[1];
      return json({
        noteId,
        backlinks:
          noteId === browserFixture.target.id
            ? [
                {
                  id: 'link_browser',
                  sourceNoteId: browserFixture.linked.id,
                  sourceTitle: browserFixture.linked.title,
                  sourceFolderId: browserFixture.linked.folderId,
                  targetTitle: browserFixture.target.title,
                  label: null,
                  linkType: 'wikilink',
                  createdAt: now,
                  updatedAt: now,
                },
              ]
            : [],
      });
    }

    return json({ error: `Unhandled browser fixture request: ${method} ${path}` }, 404);
  });

  return {
    folders,
    notes,
    trashNotes,
    trashFolders,
    trashMutationRequests,
    sharedFolderNavigationRequests,
    saveRequests,
    statusRequests,
    commentThreads,
    commentRequests,
    setNoteAccessRole(role: 'owner' | 'viewer' | 'commenter' | 'editor' | null) {
      noteAccessRole = role;
    },
    externalUpdate(noteId: string, changes: Partial<Pick<Note, 'title' | 'content'>>) {
      const note = notes.get(noteId);
      if (!note) throw new Error(`Note not found: ${noteId}`);
      Object.assign(note, changes, {
        updatedByActorType: 'agent',
        updatedByActorId: 'agent_browser',
        updatedAt: now,
      });
      hashVersion += 1;
      return `hash_${hashVersion}`;
    },
    async expectSavedContent(content: string) {
      await expect.poll(() => saveRequests.at(-1)?.body.content).toBe(content);
    },
  };
}
