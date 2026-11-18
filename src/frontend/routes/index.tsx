import { useQuery } from '@tanstack/react-query';
import { createRoute, Link } from '@tanstack/react-router';
import { ArrowUpRight, FileText, Folder, Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../components/ui/button';
import { EmptyState } from '../components/ui/empty-state';
import { api } from '../lib/api';
import { authClient } from '../lib/auth-client';
import { type PersonalVisit, readPersonalRecents } from '../lib/personal-recents';
import { rootRoute } from './__root';

type HomeItem = PersonalVisit & { title: string; subtitle?: string };

async function loadRecents(userId: string): Promise<HomeItem[]> {
  const resolved = await Promise.allSettled(
    readPersonalRecents(userId).map(async (visit): Promise<HomeItem | null> => {
      if (visit.kind === 'folder') {
        const { folder } = await api.folderDetail(visit.id, true);
        return { ...visit, title: folder.title };
      }
      const { note } = await api.note(visit.id, true);
      return note.type === 'note' ? { ...visit, title: note.title } : null;
    })
  );
  // Never fall back to stored titles or cached details when a check fails.
  return resolved.flatMap((result) => (result.status === 'fulfilled' && result.value ? [result.value] : []));
}

async function searchHome(query: string, signal: AbortSignal): Promise<HomeItem[]> {
  const [notes, owned, shared] = await Promise.all([
    api.searchNotes(query, 'note', 25, undefined, 1, 'all', signal),
    api.folders(),
    (async () => {
      const folders: HomeItem[] = [];
      let cursor: string | null = null;
      do {
        const page = await api.sharedWithMePage('folder', cursor, 50);
        for (const item of page.collaborations) {
          if (item.type === 'folder') folders.push({ kind: 'folder', id: item.folder.id, title: item.folder.title });
        }
        cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor : null;
      } while (cursor && !signal.aborted);
      return folders;
    })(),
  ]);
  const normalized = query.toLowerCase();
  const folders: HomeItem[] = [
    ...owned.folders.map((folder) => ({ kind: 'folder' as const, id: folder.id, title: folder.title })),
    ...shared,
  ];
  const seen = new Set<string>();
  return [
    ...folders.filter((folder) => folder.title.toLowerCase().includes(normalized)),
    ...notes.notes.map((note) => ({
      kind: 'note' as const,
      id: note.id,
      title: note.title,
      subtitle: note.folderTitle ?? undefined,
    })),
  ].filter((item) => {
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function ItemLink({ item, card = false }: { item: HomeItem; card?: boolean }) {
  const Icon = item.kind === 'folder' ? Folder : FileText;
  return (
    <Link
      to={item.kind === 'folder' ? '/folders/$folderId' : '/notes/$noteId'}
      params={item.kind === 'folder' ? { folderId: item.id } : { noteId: item.id }}
      className={`group flex min-w-0 items-center gap-3 rounded-md border border-[var(--notes-border)] bg-[var(--notes-panel)] transition-colors hover:bg-[var(--notes-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 ${card ? 'px-4 py-5' : 'rounded-none border-x-0 border-t-0 px-3 py-4'}`}
    >
      <Icon aria-hidden="true" className="h-5 w-5 shrink-0 text-[var(--notes-muted)]" />
      <span className="min-w-0 flex-1">
        <span title={item.title} className="block truncate font-medium text-sm">
          {item.title}
        </span>
        {item.subtitle ? <span className="notes-muted mt-1 block truncate text-xs">{item.subtitle}</span> : null}
      </span>
      <ArrowUpRight aria-hidden="true" className="notes-muted h-4 w-4 shrink-0 opacity-0 group-hover:opacity-100" />
    </Link>
  );
}

function Index() {
  const session = authClient.useSession();
  const userId = session.data?.user.id;
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const trimmed = query.trim();
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(trimmed), 250);
    return () => window.clearTimeout(timeout);
  }, [trimmed]);
  const recents = useQuery({
    queryKey: ['personal-recents', userId],
    queryFn: () => (userId ? loadRecents(userId) : []),
    enabled: Boolean(userId) && !trimmed,
    gcTime: 0,
    refetchOnMount: 'always',
    staleTime: 0,
  });
  const search = useQuery({
    queryKey: ['home-search', userId, debounced],
    queryFn: ({ signal }) => searchHome(debounced, signal),
    enabled: Boolean(userId) && !!trimmed && trimmed === debounced,
    gcTime: 0,
    refetchOnMount: 'always',
  });
  const recentItems = !recents.isFetching && !recents.isError ? (recents.data ?? []) : [];
  const folders = recentItems.filter((item) => item.kind === 'folder').slice(0, 6);
  const notes = recentItems.filter((item) => item.kind === 'note').slice(0, 12);
  const searching = trimmed !== debounced || search.isFetching || search.isPending;

  return (
    <section className="mx-auto w-full max-w-5xl pb-8" aria-label="Home">
      <h1 className="mb-6 font-semibold text-2xl tracking-tight">Home</h1>
      <div className="relative mb-10">
        <Search
          aria-hidden="true"
          className="notes-muted pointer-events-none absolute top-1/2 left-4 h-5 w-5 -translate-y-1/2"
        />
        <input
          type="search"
          aria-label="Search notes and folders"
          placeholder="Search notes and folders…"
          className="notes-input w-full rounded-lg py-4 pr-14 pl-12 text-base [&::-webkit-search-cancel-button]:hidden"
          value={query}
          maxLength={200}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query ? (
          <Button
            className="absolute top-1/2 right-2 -translate-y-1/2"
            aria-label="Clear search"
            onClick={() => setQuery('')}
          >
            <X className="h-4 w-4" />
          </Button>
        ) : null}
      </div>
      {trimmed ? (
        <section aria-label="Search results" aria-busy={searching}>
          <h2 className="mb-4 font-semibold text-sm">Search results</h2>
          {searching ? (
            <p role="status" className="notes-muted text-sm">
              Searching…
            </p>
          ) : search.isError ? (
            <p role="alert" className="text-sm">
              Search could not be loaded.
            </p>
          ) : search.data?.length ? (
            search.data.map((item) => <ItemLink key={`${item.kind}:${item.id}`} item={item} />)
          ) : (
            <EmptyState>No notes or folders found.</EmptyState>
          )}
        </section>
      ) : (
        <div aria-busy={recents.isFetching}>
          {recents.isFetching ? (
            <p role="status" className="notes-muted mb-4 text-sm">
              Loading recents…
            </p>
          ) : null}
          <section className="mb-10" aria-label="Recent folders">
            <h2 className="mb-4 font-semibold text-sm">Recent folders</h2>
            {folders.length ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {folders.map((item) => (
                  <ItemLink key={item.id} item={item} card />
                ))}
              </div>
            ) : !recents.isFetching ? (
              <EmptyState>No recent folders yet.</EmptyState>
            ) : null}
          </section>
          <section aria-label="Recently opened notes">
            <h2 className="mb-4 font-semibold text-sm">Recently opened notes</h2>
            {notes.length ? (
              notes.map((item) => <ItemLink key={item.id} item={item} />)
            ) : !recents.isFetching ? (
              <EmptyState>No recently opened notes yet.</EmptyState>
            ) : null}
          </section>
        </div>
      )}
    </section>
  );
}

export const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Index });
