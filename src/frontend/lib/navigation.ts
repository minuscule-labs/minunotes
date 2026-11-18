export type NavigationFolder = {
  id: string;
  parentFolderId: string | null;
  title: string;
};

export type NavigationNote = {
  id: string;
  folderId: string | null;
  title: string;
  type: 'note' | 'template';
};

export type NavigationAccess = {
  role: 'owner' | 'viewer' | 'commenter' | 'editor';
  source: 'owner' | 'note_grant' | 'folder_grant';
};

export type NavigationFolderContext = {
  folder: NavigationFolder;
  ancestors: NavigationFolder[];
  access: NavigationAccess;
};

export type NavigationDestination =
  | { kind: 'home' }
  | { kind: 'folder'; folderId: string }
  | { kind: 'note'; noteId: string }
  | { kind: 'templates' }
  | { kind: 'shared' }
  | { kind: 'shared-by-me' }
  | { kind: 'trash' }
  | { kind: 'folder-settings'; folderId: string }
  | { kind: 'folder-template'; folderId: string }
  | { kind: 'integrations' }
  | { kind: 'resources' }
  | { kind: 'resource'; slug: string };

export type NavigationItem = {
  label: string;
  destination: NavigationDestination;
};

export type AppNavigationModel = {
  section:
    | 'home'
    | 'folders'
    | 'templates'
    | 'shared-with-me'
    | 'shared-by-me'
    | 'trash'
    | 'settings'
    | 'resources'
    | 'other';
  activeFolderId: string | null;
  breadcrumbs: NavigationItem[];
  mobileTitle: string;
  parent: NavigationItem | null;
};

function pathMatch(pathname: string, pattern: RegExp): RegExpMatchArray | null {
  return pathname.match(pattern);
}

export function noteIdFromNavigationPath(pathname: string): string | null {
  return pathMatch(pathname, /^\/notes\/([^/]+)(?:\/activity)?\/?$/)?.[1] ?? null;
}

export function folderIdFromNavigationPath(pathname: string): string | null {
  return pathMatch(pathname, /^\/folders\/([^/]+)(?:\/.*)?$/)?.[1] ?? null;
}

function folderPath(folderId: string, folders: NavigationFolder[]): NavigationFolder[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const path: NavigationFolder[] = [];
  const seen = new Set<string>();
  let current = byId.get(folderId);

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parentFolderId ? byId.get(current.parentFolderId) : undefined;
  }

  return path;
}

function folderItems(folderId: string, folders: NavigationFolder[]): NavigationItem[] {
  const path = folderPath(folderId, folders);
  if (path.length === 0) return [{ label: 'Folder', destination: { kind: 'folder', folderId } }];
  return path.map((folder) => ({ label: folder.title, destination: { kind: 'folder', folderId: folder.id } }));
}

function parentOf(items: NavigationItem[]): NavigationItem | null {
  return items.length > 1 ? items[items.length - 2] : null;
}

export function buildAppNavigationModel({
  pathname,
  folders,
  note,
  noteAccess,
  folderContext,
}: {
  pathname: string;
  folders: NavigationFolder[];
  note?: NavigationNote | null;
  noteAccess?: NavigationAccess | null;
  folderContext?: NavigationFolderContext | null;
}): AppNavigationModel {
  const home: NavigationItem = { label: 'Home', destination: { kind: 'home' } };
  const folderId = folderIdFromNavigationPath(pathname);
  const noteId = noteIdFromNavigationPath(pathname);
  const shared: NavigationItem = { label: 'Shared with me', destination: { kind: 'shared' } };

  if (pathname === '/') {
    return { section: 'home', activeFolderId: null, breadcrumbs: [home], mobileTitle: 'Home', parent: null };
  }

  if (folderId) {
    const isSharedFolder = folderContext?.access.role !== 'owner' && folderContext?.access.source === 'folder_grant';
    const availableFolders = isSharedFolder ? [...folderContext.ancestors, folderContext.folder] : folders;
    const foldersForPath = folderItems(folderId, availableFolders);
    const base = isSharedFolder ? [shared, ...foldersForPath] : [home, ...foldersForPath];
    const currentFolder = foldersForPath.at(-1);
    if (/\/settings\/?$/.test(pathname) || /\/templates\/?$/.test(pathname)) {
      const settings: NavigationItem = {
        label: 'Settings',
        destination: { kind: 'folder-settings', folderId },
      };
      return {
        section: isSharedFolder ? 'shared-with-me' : 'folders',
        activeFolderId: isSharedFolder ? null : folderId,
        breadcrumbs: [...base, settings],
        mobileTitle: `${currentFolder?.label ?? 'Folder'} settings`,
        parent: currentFolder ?? (isSharedFolder ? shared : home),
      };
    }
    if (/\/new-from-template\/?$/.test(pathname)) {
      const create: NavigationItem = {
        label: 'New from template',
        destination: { kind: 'folder-template', folderId },
      };
      return {
        section: isSharedFolder ? 'shared-with-me' : 'folders',
        activeFolderId: isSharedFolder ? null : folderId,
        breadcrumbs: [...base, create],
        mobileTitle: 'New from template',
        parent: currentFolder ?? (isSharedFolder ? shared : home),
      };
    }
    return {
      section: isSharedFolder ? 'shared-with-me' : 'folders',
      activeFolderId: isSharedFolder ? null : folderId,
      breadcrumbs: base,
      mobileTitle: currentFolder?.label ?? 'Folder',
      parent: parentOf(base),
    };
  }

  if (noteId) {
    const isTemplate = note?.type === 'template';
    const noteItem: NavigationItem = {
      label: note?.title || 'Note',
      destination: { kind: 'note', noteId },
    };
    const isSharedNote = noteAccess?.role !== 'owner' && noteAccess?.source === 'note_grant';
    const isFolderSharedNote = noteAccess?.role !== 'owner' && noteAccess?.source === 'folder_grant';
    const sharedFolderHierarchy =
      isFolderSharedNote && folderContext
        ? folderItems(folderContext.folder.id, [...folderContext.ancestors, folderContext.folder])
        : [];
    const folderHierarchy = note?.folderId ? folderItems(note.folderId, folders) : [];
    const base = isTemplate
      ? [{ label: 'Templates', destination: { kind: 'templates' } } satisfies NavigationItem, noteItem]
      : isSharedNote
        ? [shared, noteItem]
        : isFolderSharedNote
          ? [shared, ...sharedFolderHierarchy, noteItem]
          : [home, ...folderHierarchy, noteItem];
    const isActivity = /\/activity\/?$/.test(pathname);
    const activity: NavigationItem = { label: 'Activity', destination: { kind: 'note', noteId } };
    return {
      section: isTemplate ? 'templates' : isSharedNote || isFolderSharedNote ? 'shared-with-me' : 'folders',
      activeFolderId: isTemplate || isSharedNote || isFolderSharedNote ? null : (note?.folderId ?? null),
      breadcrumbs: isActivity ? [...base, activity] : base,
      mobileTitle: isActivity ? 'Note activity' : note?.title || 'Note',
      parent: isActivity ? noteItem : (base.at(-2) ?? (isSharedNote || isFolderSharedNote ? shared : home)),
    };
  }

  if (pathname === '/shared') {
    return {
      section: 'shared-with-me',
      activeFolderId: null,
      breadcrumbs: [home, shared],
      mobileTitle: 'Shared with me',
      parent: home,
    };
  }

  if (pathname === '/shared/by-me') {
    const shared: NavigationItem = { label: 'Shared by me', destination: { kind: 'shared-by-me' } };
    return {
      section: 'shared-by-me',
      activeFolderId: null,
      breadcrumbs: [home, shared],
      mobileTitle: 'Shared by me',
      parent: home,
    };
  }

  if (pathname === '/templates') {
    const templates: NavigationItem = { label: 'Templates', destination: { kind: 'templates' } };
    return {
      section: 'templates',
      activeFolderId: null,
      breadcrumbs: [home, templates],
      mobileTitle: 'Templates',
      parent: home,
    };
  }

  if (pathname === '/trash') {
    const trash: NavigationItem = { label: 'Trash', destination: { kind: 'trash' } };
    return {
      section: 'trash',
      activeFolderId: null,
      breadcrumbs: [home, trash],
      mobileTitle: 'Trash',
      parent: home,
    };
  }

  if (pathname === '/integrations') {
    const integrations: NavigationItem = { label: 'Integrations', destination: { kind: 'integrations' } };
    return {
      section: 'settings',
      activeFolderId: null,
      breadcrumbs: [home, integrations],
      mobileTitle: 'Integrations',
      parent: home,
    };
  }

  const resourceMatch = pathMatch(pathname, /^\/resources(?:\/([^/]+))?\/?$/);
  if (resourceMatch) {
    const resources: NavigationItem = { label: 'Resources', destination: { kind: 'resources' } };
    const slug = resourceMatch[1];
    const detail: NavigationItem | null = slug
      ? {
          label: slug.replaceAll('-', ' ').replace(/\b\w/g, (character) => character.toUpperCase()),
          destination: { kind: 'resource', slug },
        }
      : null;
    return {
      section: 'resources',
      activeFolderId: null,
      breadcrumbs: detail ? [home, resources, detail] : [home, resources],
      mobileTitle: detail?.label ?? 'Resources',
      parent: detail ? resources : home,
    };
  }

  return { section: 'other', activeFolderId: null, breadcrumbs: [home], mobileTitle: 'MinuNotes', parent: home };
}
