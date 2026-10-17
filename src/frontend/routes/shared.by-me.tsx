import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute, Link } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { FolderShareDialog } from '../components/folder-share-dialog';
import { NoteShareDialog } from '../components/note-share-dialog';
import { type ResourceColumn, ResourceName, ResourceTable } from '../components/resource-table';
import { SharingPageTabs } from '../components/sharing-page-tabs';
import { EmptyState } from '../components/ui/empty-state';
import { api, type CollaborationResourceType, type OwnedSharedResource } from '../lib/api';
import { rootRoute } from './__root';

const PAGE_SIZE = 25;

type ManagedResource = { type: CollaborationResourceType; id: string };

function SharedByMeView() {
  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [managedResource, setManagedResource] = useState<ManagedResource | null>(null);
  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setQuery(searchInput.trim());
  };
  const closeManagement = (open: boolean) => {
    if (open) return;
    setManagedResource(null);
    void queryClient.invalidateQueries({ queryKey: ['shared-by-me'] });
  };

  return (
    <section className="mx-auto w-full max-w-6xl">
      <div className="mb-6">
        <h1 className="font-semibold text-2xl">Shared by me</h1>
        <p className="notes-muted mt-1 text-sm">Manage notes and folders where you configured sharing.</p>
      </div>
      <SharingPageTabs current="by-me" />
      <search>
        <form className="mb-7 flex max-w-xl flex-col gap-2 sm:flex-row" onSubmit={submitSearch}>
          <input
            type="search"
            value={searchInput}
            maxLength={200}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search shared notes and folders"
            aria-label="Search shared by me"
            className="min-w-0 flex-1 rounded-lg border border-[var(--notes-border)] bg-[var(--notes-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--notes-accent)]"
          />
          <button
            type="submit"
            className="rounded-lg bg-[var(--notes-accent)] px-4 py-2 font-medium text-sm text-white hover:opacity-90"
          >
            Search
          </button>
          {query ? (
            <button
              type="button"
              className="rounded-lg border border-[var(--notes-border)] px-4 py-2 text-sm hover:bg-[var(--notes-hover)]"
              onClick={() => {
                setSearchInput('');
                setQuery('');
              }}
            >
              Clear
            </button>
          ) : null}
        </form>
      </search>

      <div className="space-y-8">
        <OwnedResourceTable key={`note:${query}`} type="note" query={query} onManage={setManagedResource} />
        <OwnedResourceTable key={`folder:${query}`} type="folder" query={query} onManage={setManagedResource} />
      </div>

      {managedResource?.type === 'note' ? (
        <NoteShareDialog note={{ id: managedResource.id }} open onOpenChange={closeManagement} />
      ) : null}
      {managedResource?.type === 'folder' ? (
        <FolderShareDialog folder={{ id: managedResource.id }} open onOpenChange={closeManagement} />
      ) : null}
    </section>
  );
}

function OwnedResourceTable({
  type,
  query,
  onManage,
}: {
  type: CollaborationResourceType;
  query: string;
  onManage: (resource: ManagedResource) => void;
}) {
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const cursor = cursors.at(-1) ?? null;
  const result = useQuery({
    queryKey: ['shared-by-me', type, query, cursor],
    queryFn: () => api.sharedByMePage(type, query, cursor, PAGE_SIZE),
    retry: false,
  });
  const title = type === 'note' ? 'Notes' : 'Folders';
  const resources = result.data?.resources ?? [];
  const columns: ResourceColumn<OwnedSharedResource>[] = [
    { id: 'title', header: 'Title', cell: (item) => <OwnedResourceTitle item={item} /> },
    {
      id: 'active',
      header: 'Active',
      align: 'center',
      width: '5rem',
      cell: (item) => <CountCell count={item.activeCollaboratorCount} label="active collaborators" tone="active" />,
    },
    {
      id: 'pending',
      header: 'Pending',
      align: 'center',
      width: '5.5rem',
      cell: (item) => <CountCell count={item.pendingInvitationCount} label="pending invitations" tone="pending" />,
    },
    {
      id: 'expired',
      header: 'Expired',
      align: 'center',
      width: '5.5rem',
      cell: (item) => <CountCell count={item.expiredInvitationCount} label="expired invitations" tone="expired" />,
    },
    {
      id: 'public',
      header: 'Public link',
      width: '7rem',
      cell: (item) => (
        <>
          {' '}
          <span
            className={`inline-flex rounded-full border px-2 py-0.5 font-medium text-xs ${
              item.publicLinkActive
                ? 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300'
                : 'border-[var(--notes-border)] text-[var(--notes-muted)]'
            }`}
          >
            {item.publicLinkActive ? 'On' : 'Off'}
          </span>
        </>
      ),
    },
    {
      id: 'updated',
      header: 'Updated',
      width: '9rem',
      cell: (item) => <span className="notes-muted">{new Date(item.resource.updatedAt).toLocaleDateString()}</span>,
    },
    {
      id: 'actions',
      header: 'Actions',
      align: 'right',
      width: '7rem',
      cell: (item) => (
        <>
          {' '}
          <button
            type="button"
            className="rounded-md border border-[var(--notes-border)] px-3 py-1.5 font-medium text-xs hover:bg-[var(--notes-hover)]"
            onClick={() => onManage({ type: item.type, id: item.resource.id })}
            aria-label={`Manage sharing for ${item.resource.title}`}
          >
            Manage
          </button>
        </>
      ),
    },
  ];

  return (
    <section aria-labelledby={`shared-by-me-${type}-heading`}>
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h2 id={`shared-by-me-${type}-heading`} className="font-semibold text-lg">
            {title}
          </h2>
          <p className="notes-muted text-xs">
            Showing up to {PAGE_SIZE} directly shared {title.toLowerCase()}.
          </p>
        </div>
        <PaginationControls
          canGoBack={cursors.length > 1}
          canGoForward={Boolean(result.data?.pageInfo.hasMore && result.data.pageInfo.nextCursor)}
          disabled={result.isFetching}
          onBack={() => setCursors((current) => current.slice(0, -1))}
          onForward={() => {
            const nextCursor = result.data?.pageInfo.nextCursor;
            if (nextCursor) setCursors((current) => [...current, nextCursor]);
          }}
        />
      </div>

      {result.isLoading ? <p className="notes-muted text-sm">Loading shared {title.toLowerCase()}…</p> : null}
      {result.error ? (
        <EmptyState title={`Unable to load shared ${title.toLowerCase()}`}>Try refreshing the page.</EmptyState>
      ) : null}
      {!result.isLoading && !result.error ? (
        <ResourceTable
          items={resources}
          columns={columns}
          rowId={(item) => item.resource.id}
          minWidth={900}
          empty={
            query
              ? `No shared ${title.toLowerCase()} match “${query}”.`
              : `No ${title.toLowerCase()} are currently shared.`
          }
        />
      ) : null}
    </section>
  );
}

function OwnedResourceTitle({ item }: { item: OwnedSharedResource }) {
  const destination =
    item.type === 'note' ? (
      <Link
        to="/notes/$noteId"
        params={{ noteId: item.resource.id }}
        className="font-medium text-[var(--notes-blue)] hover:underline"
      >
        <ResourceName>{item.resource.title}</ResourceName>
      </Link>
    ) : (
      <Link
        to="/folders/$folderId"
        params={{ folderId: item.resource.id }}
        className="font-medium text-[var(--notes-blue)] hover:underline"
      >
        <ResourceName>{item.resource.title}</ResourceName>
      </Link>
    );
  return destination;
}

function CountCell({ count, label, tone }: { count: number; label: string; tone: 'active' | 'pending' | 'expired' }) {
  const color =
    count === 0
      ? 'border-[var(--notes-border)] text-[var(--notes-muted)]'
      : tone === 'active'
        ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
        : tone === 'pending'
          ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300'
          : 'border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300';
  return (
    <span className={`inline-flex min-w-7 justify-center rounded-full border px-2 py-0.5 font-medium text-xs ${color}`}>
      <span className="sr-only">{label}: </span>
      {count}
    </span>
  );
}

function PaginationControls({
  canGoBack,
  canGoForward,
  disabled,
  onBack,
  onForward,
}: {
  canGoBack: boolean;
  canGoForward: boolean;
  disabled: boolean;
  onBack: () => void;
  onForward: () => void;
}) {
  const className =
    'rounded-md border border-[var(--notes-border)] px-3 py-1.5 font-medium text-xs hover:bg-[var(--notes-hover)] disabled:cursor-not-allowed disabled:opacity-50';
  return (
    <div className="flex items-center gap-2">
      <button type="button" className={className} disabled={disabled || !canGoBack} onClick={onBack}>
        Previous
      </button>
      <button type="button" className={className} disabled={disabled || !canGoForward} onClick={onForward}>
        Next
      </button>
    </div>
  );
}

export const sharedByMeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/shared/by-me',
  component: SharedByMeView,
});
