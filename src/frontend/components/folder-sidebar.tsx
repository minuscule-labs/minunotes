import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  ChevronDown,
  ChevronRight,
  Folder as FolderIcon,
  House,
  LayoutTemplate,
  ListChevronsDownUp,
  Lock,
  MoreHorizontal,
  PanelLeftClose,
  Plus,
  Search,
  Share2,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Folder, type SharedFolderNavigationChild } from '../lib/api';
import { authClient } from '../lib/auth-client';
import type { AppNavigationModel } from '../lib/navigation';
import { getStoredExpandedFolderIds, storeExpandedFolderIds } from '../lib/navigation-preferences';
import { AccountProfileDialog } from './account-profile-dialog';
import { CreateFolderDialog } from './create-folder-dialog';
import { FolderActionsPopover } from './folder-actions-popover';
import { openSearchDialog, searchShortcutLabel } from './search-dialog';
import { SharedFolderNavigation } from './shared-folder-navigation';
import { ThemeDialog } from './theme-dialog';
import { ActionMenuButton, ActionMenuIconButton } from './ui/action-menu';
import { Avatar } from './ui/avatar';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from './ui/popover';

type FolderNode = Folder & {
  children: FolderNode[];
  depth: number;
  effectivePrivate: boolean;
  effectiveAgentReadOnly: boolean;
};

function buildFolderTree(folders: Folder[]) {
  const nodes = new Map(
    folders.map((folder) => [
      folder.id,
      {
        ...folder,
        children: [],
        depth: 0,
        effectivePrivate: folder.isPrivate,
        effectiveAgentReadOnly: folder.isAgentReadOnly,
      } as FolderNode,
    ])
  );
  const roots: FolderNode[] = [];

  for (const node of nodes.values()) {
    const parent = node.parentFolderId ? nodes.get(node.parentFolderId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const sortNodes = (items: FolderNode[]) => items.sort((a, b) => a.title.localeCompare(b.title));
  const visit = (node: FolderNode, depth: number, parentPrivate: boolean, parentAgentReadOnly: boolean) => {
    node.depth = depth;
    node.effectivePrivate = parentPrivate || node.isPrivate;
    node.effectiveAgentReadOnly = parentAgentReadOnly || node.isAgentReadOnly;
    sortNodes(node.children);
    for (const child of node.children) visit(child, depth + 1, node.effectivePrivate, node.effectiveAgentReadOnly);
  };
  sortNodes(roots);
  for (const root of roots) visit(root, 0, false, false);
  return roots;
}

function getAncestorIds(folderId: string | null, folders: Folder[]) {
  if (!folderId) return [];
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const ids: string[] = [];
  let current = byId.get(folderId);
  const seen = new Set<string>();

  while (current?.parentFolderId && !seen.has(current.id)) {
    seen.add(current.id);
    ids.push(current.parentFolderId);
    current = byId.get(current.parentFolderId);
  }

  return ids;
}

function SidebarNavLink({
  to,
  label,
  active,
  icon,
  onNavigate,
}: {
  to: '/' | '/shared' | '/templates';
  label: string;
  active: boolean;
  icon: ReactNode;
  onNavigate?: () => void;
}) {
  return (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
      className={`flex min-h-11 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors md:min-h-9 ${
        active
          ? 'bg-[var(--notes-hover)] text-[var(--notes-text)]'
          : 'text-[var(--notes-muted)] hover:bg-[var(--notes-hover)] hover:text-[var(--notes-text)]'
      }`}
      onClick={onNavigate}
    >
      {icon}
      <span>{label}</span>
    </Link>
  );
}

export function FolderSidebar({
  userEmail,
  navigation,
  activeSharedFolderPath,
  collapseToRootsToggle,
  onCollapseAllFolderTrees,
  onNavigate,
  onCollapse,
  onClose,
}: {
  userEmail?: string | null;
  navigation: AppNavigationModel;
  activeSharedFolderPath: SharedFolderNavigationChild[];
  collapseToRootsToggle: boolean;
  onCollapseAllFolderTrees: () => void;
  onNavigate?: () => void;
  onCollapse?: () => void;
  onClose?: () => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['folders'],
    queryFn: api.folders,
  });
  const accountProfile = useQuery({ queryKey: ['account-profile'], queryFn: api.accountProfile });
  const nav = useNavigate();
  const currentFolderId = navigation.activeFolderId;
  const sharedFolderIds = useMemo(
    () =>
      navigation.section === 'shared-with-me'
        ? navigation.breadcrumbs.flatMap((item) =>
            item.destination.kind === 'folder' ? [item.destination.folderId] : []
          )
        : [],
    [navigation.section, navigation.breadcrumbs]
  );
  const activeSharedFolderId = sharedFolderIds.at(-1) ?? null;
  const activeSharedAncestorFolderIds = useMemo(() => sharedFolderIds.slice(0, -1), [sharedFolderIds]);
  const folders = data?.folders ?? [];
  const folderTree = useMemo(() => buildFolderTree(folders), [folders]);
  const [expandedFolderIds, setExpandedFolderIds] = useState(getStoredExpandedFolderIds);
  const previousCollapseToRootsToggle = useRef(collapseToRootsToggle);
  const [foldersSectionExpanded, setFoldersSectionExpanded] = useState(true);
  const [profileOpen, setProfileOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);

  useEffect(() => {
    const ancestorIds = getAncestorIds(currentFolderId, folders);
    if (!ancestorIds.length) return;
    setExpandedFolderIds((current) => new Set([...current, ...ancestorIds]));
  }, [currentFolderId, folders]);

  useEffect(() => {
    if (previousCollapseToRootsToggle.current === collapseToRootsToggle) return;
    previousCollapseToRootsToggle.current = collapseToRootsToggle;
    setExpandedFolderIds(new Set());
  }, [collapseToRootsToggle]);

  useEffect(() => {
    storeExpandedFolderIds(expandedFolderIds);
  }, [expandedFolderIds]);

  const toggleExpanded = (folderId: string) => {
    setExpandedFolderIds((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  };

  const renderFolderList = (nodes: FolderNode[], id?: string): ReactNode => (
    <ul id={id} className="space-y-1">
      {nodes.map((folder) => {
        const hasChildren = folder.children.length > 0;
        const expanded = expandedFolderIds.has(folder.id);
        const isCurrent = currentFolderId === folder.id;
        const childListId = `sidebar-folder-children-${folder.id}`;
        return (
          <li key={folder.id}>
            <div
              className={`group flex items-center gap-1 rounded-md ${isCurrent ? 'bg-[var(--notes-hover)] text-[var(--notes-text)]' : 'hover:bg-[var(--notes-hover)]'}`}
              style={{ paddingLeft: `${folder.depth * 0.75}rem` }}
            >
              {hasChildren ? (
                <button
                  type="button"
                  className="rounded-md p-1 text-[var(--notes-muted)] hover:bg-[var(--notes-hover)] hover:text-[var(--notes-text)]"
                  aria-label={expanded ? `Collapse ${folder.title}` : `Expand ${folder.title}`}
                  aria-expanded={expanded}
                  aria-controls={childListId}
                  onClick={() => toggleExpanded(folder.id)}
                >
                  {expanded ? (
                    <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </button>
              ) : (
                <span className="w-5 shrink-0" aria-hidden="true" />
              )}
              <Link
                to="/folders/$folderId"
                params={{ folderId: folder.id }}
                className={`flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-sm ${isCurrent ? 'font-semibold' : ''}`}
                aria-current={isCurrent ? 'location' : undefined}
                onClick={onNavigate}
              >
                <span className="truncate">{folder.title}</span>
                {folder.effectivePrivate ? (
                  <Lock className="h-3 w-3 shrink-0 text-[var(--notes-muted)]" aria-label="Private folder" />
                ) : null}
                {!folder.effectivePrivate && folder.effectiveAgentReadOnly ? (
                  <span
                    className="shrink-0 rounded border border-amber-500/50 px-1 py-0.5 text-[9px] text-amber-600 uppercase tracking-wide"
                    title="Read-only for agents"
                  >
                    RO
                  </span>
                ) : null}
              </Link>
              <FolderActionsPopover
                folder={folder}
                depth={folder.depth}
                triggerClassName={
                  isCurrent
                    ? 'shrink-0'
                    : 'shrink-0 transition-opacity [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:opacity-100 focus:opacity-100'
                }
              />
            </div>
            {hasChildren && expanded ? renderFolderList(folder.children, childListId) : null}
          </li>
        );
      })}
    </ul>
  );

  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-[var(--notes-border)] border-r bg-[var(--notes-panel-muted)] p-4 md:h-screen md:w-72">
      <div className="mb-4 flex items-center justify-between gap-2 md:-mt-4 md:h-11 md:shrink-0">
        <span className="px-1 py-0.5 font-mono font-semibold">MinuNotes</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="rounded-md p-2 text-[var(--notes-muted)] hover:bg-[var(--notes-hover)] hover:text-[var(--notes-text)]"
            aria-label="Search"
            aria-keyshortcuts="Meta+K Control+K"
            title={`Search (${searchShortcutLabel()})`}
            onClick={openSearchDialog}
          >
            <Search className="h-4 w-4" />
          </button>
          {onCollapse ? (
            <button
              className="rounded-md border border-[var(--notes-border)] p-2 text-[var(--notes-muted)] hover:bg-[var(--notes-hover)] hover:text-[var(--notes-text)]"
              type="button"
              aria-label="Collapse sidebar"
              onClick={onCollapse}
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          ) : onClose ? (
            <button
              className="rounded-md border border-[var(--notes-border)] p-2 text-[var(--notes-muted)] hover:bg-[var(--notes-hover)] hover:text-[var(--notes-text)]"
              type="button"
              aria-label="Close menu"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </div>
      <nav className="flex min-h-0 flex-1 flex-col" aria-label="Primary">
        <div className="mb-2 shrink-0 space-y-1 border-[var(--notes-border)] border-b pb-2">
          <SidebarNavLink
            to="/"
            label="Home"
            active={navigation.section === 'home' || navigation.section === 'folders'}
            icon={<House className="h-5 w-5 shrink-0" />}
            onNavigate={onNavigate}
          />
          <SidebarNavLink
            to="/shared"
            label="Shared"
            active={navigation.section === 'shared-with-me' || navigation.section === 'shared-by-me'}
            icon={<Share2 className="h-5 w-5 shrink-0" />}
            onNavigate={onNavigate}
          />
          <SidebarNavLink
            to="/templates"
            label="Templates"
            active={navigation.section === 'templates'}
            icon={<LayoutTemplate className="h-5 w-5 shrink-0" />}
            onNavigate={onNavigate}
          />
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={`flex min-h-11 w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors md:min-h-9 ${
                  navigation.section === 'resources' ||
                  navigation.section === 'settings' ||
                  navigation.section === 'trash'
                    ? 'bg-[var(--notes-hover)] text-[var(--notes-text)]'
                    : 'text-[var(--notes-muted)] hover:bg-[var(--notes-hover)] hover:text-[var(--notes-text)]'
                }`}
                aria-label="More navigation"
                aria-current={
                  navigation.section === 'resources' ||
                  navigation.section === 'settings' ||
                  navigation.section === 'trash'
                    ? 'page'
                    : undefined
                }
              >
                <MoreHorizontal className="h-5 w-5 shrink-0" />
                <span>More</span>
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" side="right" className="w-52 p-1">
              <PopoverClose asChild>
                <ActionMenuButton
                  onClick={() => {
                    nav({ to: '/resources' });
                    onNavigate?.();
                  }}
                >
                  Resources
                </ActionMenuButton>
              </PopoverClose>
              <PopoverClose asChild>
                <ActionMenuButton
                  onClick={() => {
                    nav({ to: '/integrations' });
                    onNavigate?.();
                  }}
                >
                  Integrations
                </ActionMenuButton>
              </PopoverClose>
              <div className="my-1 border-[var(--notes-border)] border-t pt-1">
                <PopoverClose asChild>
                  <ActionMenuButton
                    aria-current={navigation.section === 'trash' ? 'page' : undefined}
                    onClick={() => {
                      nav({ to: '/trash' });
                      onNavigate?.();
                    }}
                  >
                    <span className="flex items-center gap-2">
                      <Trash2 className="h-4 w-4 text-[var(--notes-muted)]" />
                      Trash
                    </span>
                  </ActionMenuButton>
                </PopoverClose>
              </div>
            </PopoverContent>
          </Popover>
        </div>
        {isLoading ? <p className="text-slate-500 text-sm">Loading...</p> : null}
        {error ? <p className="text-red-600 text-xs">API unavailable. Check VITE_API_URL.</p> : null}
        <div className="notes-sidebar-scroll -mr-4 min-h-0 flex-1 space-y-1 overflow-y-auto pr-4 pb-4">
          <div className="flex items-center justify-between gap-1 pl-2 pb-1">
            <button
              type="button"
              className="flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-md text-left text-[var(--notes-muted)] hover:text-[var(--notes-text)]"
              aria-expanded={foldersSectionExpanded}
              aria-controls="sidebar-owned-folder-tree"
              onClick={() => setFoldersSectionExpanded((value) => !value)}
            >
              {foldersSectionExpanded ? (
                <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              )}
              <FolderIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="font-medium text-xs tracking-wide">Folders</span>
            </button>
            <CreateFolderDialog
              trigger={
                <button
                  type="button"
                  className="rounded-md p-1.5 text-[var(--notes-muted)] hover:bg-[var(--notes-hover)] hover:text-[var(--notes-text)]"
                  aria-label="Create top-level folder"
                >
                  <Plus className="h-4 w-4" />
                </button>
              }
              onCreated={(folder) => {
                void nav({ to: '/folders/$folderId', params: { folderId: folder.id } });
                onNavigate?.();
              }}
            />
            <button
              type="button"
              className="rounded-md p-1.5 text-[var(--notes-muted)] hover:bg-[var(--notes-hover)] hover:text-[var(--notes-text)]"
              aria-label="Collapse all folders to roots"
              title="Collapse all folders to roots"
              onClick={onCollapseAllFolderTrees}
            >
              <ListChevronsDownUp className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          {foldersSectionExpanded ? (
            <div id="sidebar-owned-folder-tree">
              {!isLoading && folderTree.length === 0 ? (
                <p className="px-2 py-3 text-[var(--notes-muted)] text-xs">No folders yet. Use + to create one.</p>
              ) : null}
              {renderFolderList(folderTree)}
            </div>
          ) : null}
          <SharedFolderNavigation
            activeFolderId={activeSharedFolderId}
            activeAncestorFolderIds={activeSharedAncestorFolderIds}
            activeFolderPath={activeSharedFolderPath}
            collapseToRootsToggle={collapseToRootsToggle}
            onNavigate={onNavigate}
          />
        </div>
      </nav>
      <div className="shrink-0 border-[var(--notes-border)] border-t pt-4 pb-[env(safe-area-inset-bottom,0px)]">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 p-1">
            {accountProfile.data?.profile.identity ? (
              <Avatar
                identity={accountProfile.data.profile.identity}
                imageUrl={accountProfile.data.profile.imageUrl}
                size="sm"
                decorative
              />
            ) : (
              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--notes-border)] text-[var(--notes-muted)]">
                <UserRound className="h-4 w-4" aria-hidden="true" />
              </span>
            )}
            <span className="min-w-0">
              {accountProfile.data?.profile.identity.displayName ? (
                <span className="block truncate text-sm">{accountProfile.data.profile.identity.displayName}</span>
              ) : null}
              <span
                className={`block truncate ${accountProfile.data?.profile.identity.displayName ? 'text-[var(--notes-muted)] text-xs' : 'text-sm'}`}
              >
                {accountProfile.data?.profile.email ?? userEmail ?? 'Email unavailable'}
              </span>
            </span>
          </div>
          <Popover>
            <PopoverTrigger asChild>
              <ActionMenuIconButton
                icon="settings"
                aria-label="Open account and settings menu"
                title="Account and settings"
              />
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56 p-1">
              <PopoverClose asChild>
                <ActionMenuButton onClick={() => setProfileOpen(true)}>Profile</ActionMenuButton>
              </PopoverClose>
              <PopoverClose asChild>
                <ActionMenuButton onClick={() => setThemeOpen(true)}>Theme</ActionMenuButton>
              </PopoverClose>
              <ActionMenuButton onClick={() => authClient.signOut()}>Logout</ActionMenuButton>
            </PopoverContent>
          </Popover>
        </div>
        <AccountProfileDialog email={userEmail} open={profileOpen} onOpenChange={setProfileOpen} />
        <ThemeDialog open={themeOpen} onOpenChange={setThemeOpen} />
      </div>
    </aside>
  );
}
