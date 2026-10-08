import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronDown, ChevronRight, ListChevronsDownUp, Lock, Share2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, type SharedFolderNavigationChild, type SharedFolderNavigationRoot } from '../lib/api';
import { getStoredExpandedSharedFolderIds, storeExpandedSharedFolderIds } from '../lib/navigation-preferences';

type SharedFolderItem = SharedFolderNavigationRoot | SharedFolderNavigationChild;

function SharedFolderTreeItem({
  folder,
  activeFolderId,
  depth,
  onNavigate,
  expandedFolderIds,
  onToggleExpanded,
  activeFolderPath,
  inheritedPrivate = false,
  inheritedAgentReadOnly = false,
}: {
  folder: SharedFolderItem;
  activeFolderId: string | null;
  depth: number;
  onNavigate?: () => void;
  expandedFolderIds: Set<string>;
  onToggleExpanded: (folderId: string) => void;
  activeFolderPath: SharedFolderNavigationChild[];
  inheritedPrivate?: boolean;
  inheritedAgentReadOnly?: boolean;
}) {
  const expanded = expandedFolderIds.has(folder.id);
  const current = activeFolderId === folder.id;
  const activeChildFolder = activeFolderPath.find((candidate) => candidate.parentFolderId === folder.id);
  const hasChildren = folder.hasChildren || Boolean(activeChildFolder);
  const children = useInfiniteQuery({
    queryKey: ['shared-folder-navigation-children', folder.id],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.sharedFolderChildren(folder.id, pageParam),
    getNextPageParam: (lastPage) => (lastPage.pageInfo.hasMore ? lastPage.pageInfo.nextCursor : undefined),
    staleTime: 30_000,
    enabled: expanded && hasChildren,
  });
  const childFolders = children.data?.pages.flatMap((page) => page.folders) ?? [];
  const visibleChildFolders =
    activeChildFolder && !childFolders.some((child) => child.id === activeChildFolder.id)
      ? [...childFolders, activeChildFolder].sort(
          (left, right) =>
            left.title.localeCompare(right.title, undefined, { sensitivity: 'base' }) || left.id.localeCompare(right.id)
        )
      : childFolders;
  const isPrivate = inheritedPrivate || ('isPrivate' in folder && folder.isPrivate);
  const isAgentReadOnly = inheritedAgentReadOnly || ('isAgentReadOnly' in folder && folder.isAgentReadOnly);
  const childListId = `sidebar-shared-folder-children-${folder.id}`;

  return (
    <li>
      <div
        className={`group flex items-center gap-1 rounded-md ${current ? 'bg-[var(--notes-hover)] text-[var(--notes-text)]' : 'hover:bg-[var(--notes-hover)]'}`}
        style={{ paddingLeft: `${depth * 0.75}rem` }}
      >
        {hasChildren ? (
          <button
            type="button"
            className="rounded-md p-1 text-[var(--notes-muted)] hover:bg-[var(--notes-hover)] hover:text-[var(--notes-text)]"
            aria-label={expanded ? `Collapse ${folder.title}` : `Expand ${folder.title}`}
            aria-expanded={expanded}
            aria-controls={childListId}
            onClick={() => onToggleExpanded(folder.id)}
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
          className={`flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-sm ${current ? 'font-semibold' : ''}`}
          aria-current={current ? 'location' : undefined}
          onClick={onNavigate}
        >
          <span className="min-w-0 flex-1 truncate">{folder.title}</span>
          {isPrivate ? (
            <Lock className="h-3 w-3 shrink-0 text-[var(--notes-muted)]" aria-label="Private folder" />
          ) : null}
          {!isPrivate && isAgentReadOnly ? (
            <span
              className="shrink-0 rounded border border-amber-500/50 px-1 py-0.5 text-[9px] text-amber-600 uppercase tracking-wide"
              title="Read-only for agents"
            >
              RO
            </span>
          ) : null}
        </Link>
      </div>
      {expanded && hasChildren ? (
        <ul id={childListId} className="space-y-1" aria-label={`Subfolders of ${folder.title}`}>
          {children.isPending ? (
            <li className="px-7 py-2 text-[var(--notes-muted)] text-xs">Loading folders…</li>
          ) : null}
          {children.isError ? <li className="px-7 py-2 text-red-600 text-xs">Couldn’t load subfolders.</li> : null}
          {visibleChildFolders.map((child) => (
            <SharedFolderTreeItem
              key={child.id}
              folder={child}
              activeFolderId={activeFolderId}
              depth={depth + 1}
              onNavigate={onNavigate}
              expandedFolderIds={expandedFolderIds}
              onToggleExpanded={onToggleExpanded}
              activeFolderPath={activeFolderPath}
              inheritedPrivate={isPrivate}
              inheritedAgentReadOnly={isAgentReadOnly}
            />
          ))}
          {children.hasNextPage ? (
            <li style={{ paddingLeft: `${(depth + 1) * 0.75 + 1.5}rem` }}>
              <button
                type="button"
                className="min-h-9 px-2 text-[var(--notes-muted)] text-xs hover:text-[var(--notes-text)]"
                disabled={children.isFetchingNextPage}
                onClick={() => void children.fetchNextPage()}
              >
                {children.isFetchingNextPage ? 'Loading…' : 'Load more folders'}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

export function SharedFolderNavigation({
  activeFolderId,
  activeAncestorFolderIds,
  activeFolderPath,
  collapseToRootsToggle,
  onNavigate,
}: {
  activeFolderId: string | null;
  activeAncestorFolderIds: string[];
  activeFolderPath: SharedFolderNavigationChild[];
  collapseToRootsToggle: boolean;
  onNavigate?: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [expandedFolderIds, setExpandedFolderIds] = useState(getStoredExpandedSharedFolderIds);
  const previousCollapseToRootsToggle = useRef(collapseToRootsToggle);
  const roots = useQuery({
    queryKey: ['shared-folder-navigation-roots'],
    queryFn: api.sharedFolderRoots,
    staleTime: 30_000,
  });

  useEffect(() => {
    setExpandedFolderIds((current) => {
      const missing = activeAncestorFolderIds.filter((folderId) => !current.has(folderId));
      return missing.length ? new Set([...current, ...missing]) : current;
    });
  }, [activeAncestorFolderIds]);

  useEffect(() => {
    if (previousCollapseToRootsToggle.current === collapseToRootsToggle) return;
    previousCollapseToRootsToggle.current = collapseToRootsToggle;
    setExpandedFolderIds(new Set());
  }, [collapseToRootsToggle]);

  useEffect(() => {
    storeExpandedSharedFolderIds(expandedFolderIds);
  }, [expandedFolderIds]);

  const toggleExpandedFolder = (folderId: string) => {
    setExpandedFolderIds((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  };

  if (!roots.data?.folders.length && !activeFolderPath.length && !roots.isError) return null;

  const visibleRoots: SharedFolderItem[] = [...(roots.data?.folders ?? [])];
  const activeRoot = activeFolderPath[0];
  if (activeRoot && !visibleRoots.some((folder) => folder.id === activeRoot.id)) visibleRoots.push(activeRoot);

  return (
    <section className="mt-1">
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 font-medium text-[var(--notes-muted)] text-xs tracking-wide hover:text-[var(--notes-text)]"
          aria-expanded={expanded}
          aria-controls="sidebar-shared-folder-roots"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          <Share2 className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Shared with me</span>
        </button>
        <button
          type="button"
          className="rounded-md p-1.5 text-[var(--notes-muted)] hover:bg-[var(--notes-hover)] hover:text-[var(--notes-text)]"
          aria-label="Collapse shared folders to roots"
          title="Collapse shared folders to roots"
          onClick={() => setExpandedFolderIds(new Set())}
        >
          <ListChevronsDownUp className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      {expanded ? (
        <div id="sidebar-shared-folder-roots" className="mt-1">
          {roots.isError ? <p className="px-2 py-2 text-red-600 text-xs">Couldn’t load shared folders.</p> : null}
          {visibleRoots.length ? (
            <ul className="space-y-1">
              {visibleRoots.map((folder) => (
                <SharedFolderTreeItem
                  key={folder.id}
                  folder={folder}
                  activeFolderId={activeFolderId}
                  depth={0}
                  onNavigate={onNavigate}
                  expandedFolderIds={expandedFolderIds}
                  onToggleExpanded={toggleExpandedFolder}
                  activeFolderPath={activeFolderPath}
                />
              ))}
            </ul>
          ) : null}
          {roots.data?.pageInfo.hasMore ? (
            <Link
              to="/shared"
              className="mt-1 inline-flex min-h-9 items-center px-2 text-[var(--notes-muted)] text-xs hover:text-[var(--notes-text)]"
              onClick={onNavigate}
            >
              See all shared items
            </Link>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
