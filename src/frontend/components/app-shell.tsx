import { useQuery } from '@tanstack/react-query';
import { Navigate, Outlet, useRouterState } from '@tanstack/react-router';
import { PanelLeftOpen } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, type SharedFolderNavigationChild } from '../lib/api';
import { authClient } from '../lib/auth-client';
import { buildAppNavigationModel, folderIdFromNavigationPath, noteIdFromNavigationPath } from '../lib/navigation';
import { getStoredSidebarCollapsed, storeSidebarCollapsed } from '../lib/navigation-preferences';
import { isPublicResourcePath } from '../lib/public-routes';
import { applyNoteTheme, getStoredTheme } from '../lib/themes';
import { AppNavigationBar } from './app-navigation-bar';
import { FolderSidebar } from './folder-sidebar';
import { PublicResourcesShell } from './public-resources-shell';
import { SearchDialog } from './search-dialog';

export function AppShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  if (isPublicResourcePath(pathname)) return <PublicResourcesShell />;
  return <AuthenticatedAppShell />;
}

function AuthenticatedAppShell() {
  const location = useRouterState({ select: (state) => state.location });
  const pathname = location.pathname;
  const session = authClient.useSession();
  const isAuthRoute = pathname === '/auth';
  const isInvitationRoute = pathname.startsWith('/invite/');
  const isPublicShareRoute = pathname.startsWith('/share/');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapseToRootsToggle, setCollapseToRootsToggle] = useState(false);
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState(getStoredSidebarCollapsed);
  const contentScrollRef = useRef<HTMLElement>(null);
  const navigationNoteId = noteIdFromNavigationPath(pathname);
  const navigationRouteFolderId = folderIdFromNavigationPath(pathname);
  const navigationEnabled = Boolean(session.data?.user && !isAuthRoute && !isInvitationRoute && !isPublicShareRoute);
  const folders = useQuery({ queryKey: ['folders'], queryFn: api.folders, enabled: navigationEnabled });
  const navigationNote = useQuery({
    queryKey: ['note', navigationNoteId],
    queryFn: () => {
      if (!navigationNoteId) throw new Error('Navigation note ID is required');
      return api.note(navigationNoteId);
    },
    enabled: navigationEnabled && Boolean(navigationNoteId),
    retry: (failureCount, error) => !(error instanceof ApiError && error.status === 404) && failureCount < 3,
  });
  const navigationContextFolderId =
    navigationRouteFolderId ??
    (navigationNote.data?.access?.source === 'folder_grant' ? navigationNote.data.note.folderId : null);
  const navigationFolder = useQuery({
    queryKey: ['folder-detail', navigationContextFolderId],
    queryFn: () => {
      if (!navigationContextFolderId) throw new Error('Navigation folder ID is required');
      return api.folderDetail(navigationContextFolderId);
    },
    enabled: navigationEnabled && Boolean(navigationContextFolderId),
    retry: (failureCount, error) => !(error instanceof ApiError && error.status === 404) && failureCount < 3,
  });
  const navigation = useMemo(
    () =>
      buildAppNavigationModel({
        pathname,
        folders: folders.data?.folders ?? [],
        note: navigationNote.data?.note ?? null,
        noteAccess: navigationNote.data?.access ?? null,
        folderContext: navigationFolder.data ?? null,
      }),
    [pathname, folders.data?.folders, navigationNote.data, navigationFolder.data]
  );
  const activeSharedFolderPath = useMemo<SharedFolderNavigationChild[]>(() => {
    const folderDetail = navigationFolder.data;
    if (navigation.section !== 'shared-with-me' || folderDetail?.access.source !== 'folder_grant') return [];

    const path = [...folderDetail.ancestors, folderDetail.folder];
    return path.map((folder, index) => ({
      id: folder.id,
      title: folder.title,
      parentFolderId: index === 0 ? null : folder.parentFolderId,
      updatedAt: folder.updatedAt,
      isPrivate: folder.isPrivate,
      isAgentReadOnly: folder.isAgentReadOnly,
      hasChildren: index < path.length - 1 || folderDetail.childFolders.length > 0,
    }));
  }, [navigation.section, navigationFolder.data]);

  useEffect(() => {
    applyNoteTheme(getStoredTheme());
  }, []);

  useEffect(() => {
    if (isPublicShareRoute || isInvitationRoute) return;
    const pageTitle =
      pathname === '/auth'
        ? 'Sign in'
        : pathname === '/oauth/authorize'
          ? 'Authorize application'
          : /\/notes\/[^/]+\/activity\/?$/.test(pathname) && navigationNote.data?.note
            ? `${navigationNote.data.note.title} activity`
            : navigation.mobileTitle;
    document.title = `${pageTitle} - MinuNotes`;
  }, [isInvitationRoute, isPublicShareRoute, navigation.mobileTitle, navigationNote.data?.note, pathname]);

  useEffect(() => {
    setSidebarOpen(false);
    contentScrollRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [pathname]);

  useEffect(() => {
    storeSidebarCollapsed(desktopSidebarCollapsed);
  }, [desktopSidebarCollapsed]);

  if (isAuthRoute || isInvitationRoute || isPublicShareRoute) return <Outlet />;
  if (session.isPending)
    return (
      <div className="grid min-h-screen place-items-center bg-[var(--notes-bg)] text-[var(--notes-muted)] text-sm">
        Loading...
      </div>
    );
  if (!session.data?.user) {
    const redirect = `${location.pathname}${location.searchStr}`;
    return <Navigate to="/auth" search={redirect === '/' ? undefined : { redirect }} />;
  }

  return (
    <div className="notes-app-shell flex h-screen min-h-0 overflow-hidden bg-[var(--notes-bg)] text-[var(--notes-text)]">
      <SearchDialog />
      {desktopSidebarCollapsed ? null : (
        <div className="hidden md:block">
          <FolderSidebar
            userEmail={session.data.user.email}
            navigation={navigation}
            activeSharedFolderPath={activeSharedFolderPath}
            collapseToRootsToggle={collapseToRootsToggle}
            onCollapseAllFolderTrees={() => setCollapseToRootsToggle((toggle) => !toggle)}
            onCollapse={() => setDesktopSidebarCollapsed(true)}
          />
        </div>
      )}

      {sidebarOpen ? (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label="Dismiss menu"
            onClick={() => setSidebarOpen(false)}
          />
          <div className="relative h-full w-[min(20rem,86vw)]">
            <FolderSidebar
              userEmail={session.data.user.email}
              navigation={navigation}
              activeSharedFolderPath={activeSharedFolderPath}
              collapseToRootsToggle={collapseToRootsToggle}
              onCollapseAllFolderTrees={() => setCollapseToRootsToggle((toggle) => !toggle)}
              onNavigate={() => setSidebarOpen(false)}
              onClose={() => setSidebarOpen(false)}
            />
          </div>
        </div>
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {desktopSidebarCollapsed ? (
          <button
            className="fixed top-[5px] left-4 z-40 hidden rounded-md border border-[var(--notes-border)] bg-[var(--notes-panel-muted)] p-2 text-[var(--notes-muted)] shadow-sm hover:bg-[var(--notes-hover)] hover:text-[var(--notes-text)] md:block"
            type="button"
            aria-label="Expand sidebar"
            onClick={() => setDesktopSidebarCollapsed(false)}
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
        ) : null}
        <AppNavigationBar
          navigation={navigation}
          onOpenMenu={() => setSidebarOpen(true)}
          sidebarCollapsed={desktopSidebarCollapsed}
        />
        <main
          ref={contentScrollRef}
          className={`min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 sm:px-6 sm:py-6 ${desktopSidebarCollapsed ? 'md:pl-20' : ''}`}
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
