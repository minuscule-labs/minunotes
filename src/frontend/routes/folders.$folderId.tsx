import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute, Link, useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import { ChevronDown, FileText, Folder as FolderIcon, GitBranch, Lock, RefreshCw, Shapes } from 'lucide-react';
import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from 'react';
import { EMPTY_NOTE_QUERY, hasNoteQuery, type NoteQuery } from '../../shared/note-filters';
import {
  DEFAULT_NOTE_SORT,
  folderReadIdentity,
  isPropertySort,
  type NoteSort,
  noteSortSchemaError,
} from '../../shared/note-sort';
import { BoardSubfolderPicker } from '../components/board-subfolder-picker';
import { FolderActionsPopover } from '../components/folder-actions-popover';
import { FolderQueryControls, folderQuerySchemaError } from '../components/folder-query-controls';
import { MoveNotesDialog } from '../components/move-notes-dialog';
import { NoteActionsPopover } from '../components/note-actions-popover';
import { NotesBoard } from '../components/notes-board';
import { PaginationControls } from '../components/pagination-controls';
import { type ResourceColumn, ResourceName, ResourceTable } from '../components/resource-table';
import { TrashNotesDialog } from '../components/trash-notes-dialog';
import { Button } from '../components/ui/button';
import { EmptyState } from '../components/ui/empty-state';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { QuickTooltip } from '../components/ui/tooltip';
import { ApiError, api, type Folder, type NoteListItem, verifyFolderQueryEcho } from '../lib/api';
import { authClient } from '../lib/auth-client';
import { folderQueryHref, folderViewHref, readFolderQuery, validateBoardSearch } from '../lib/board-view';
import { markEmptyDraft } from '../lib/empty-draft';
import {
  folderListHistoryState,
  isFolderListHistoryState,
  resolveFolderEntryView,
  storeFolderViewPreference,
} from '../lib/folder-view-preferences';
import { rootRoute } from './__root';

function folderDepth(folder: Folder, folders: Folder[]) {
  const byId = new Map(folders.map((item) => [item.id, item]));
  let depth = 0;
  let current: Folder | undefined = folder;
  const seen = new Set<string>();

  while (current.parentFolderId) {
    if (seen.has(current.id)) break;
    seen.add(current.id);
    const parent = byId.get(current.parentFolderId);
    if (!parent) break;
    depth += 1;
    current = parent;
  }

  return depth;
}

function isEffectivelyPrivate(folder: Folder, folders: Folder[]) {
  const byId = new Map(folders.map((item) => [item.id, item]));
  let current: Folder | undefined = folder;
  const seen = new Set<string>();

  while (current) {
    if (current.isPrivate) return true;
    if (!current.parentFolderId || seen.has(current.id)) return false;
    seen.add(current.id);
    current = byId.get(current.parentFolderId);
  }

  return false;
}

function isEffectivelyAgentReadOnly(folder: Folder, folders: Folder[]) {
  const byId = new Map(folders.map((item) => [item.id, item]));
  let current: Folder | undefined = folder;
  const seen = new Set<string>();

  while (current) {
    if (current.isAgentReadOnly) return true;
    if (!current.parentFolderId || seen.has(current.id)) return false;
    seen.add(current.id);
    current = byId.get(current.parentFolderId);
  }

  return false;
}

type FolderItem = { kind: 'folder'; folder: Folder };
type NoteItem = { kind: 'note'; note: NoteListItem };
type ContentItem = FolderItem | NoteItem;

function getContentItemUpdatedAt(item: ContentItem) {
  return item.kind === 'folder' ? item.folder.updatedAt : item.note.updatedAt;
}

function getContentItemTitle(item: ContentItem) {
  return item.kind === 'folder' ? item.folder.title : item.note.title;
}

function compareContentItemsByUpdatedDesc(a: ContentItem, b: ContentItem) {
  const updatedDiff = new Date(getContentItemUpdatedAt(b)).getTime() - new Date(getContentItemUpdatedAt(a)).getTime();
  return (
    updatedDiff ||
    getContentItemTitle(a).localeCompare(getContentItemTitle(b)) ||
    (a.kind === 'folder' ? a.folder.id : a.note.id).localeCompare(b.kind === 'folder' ? b.folder.id : b.note.id)
  );
}

function FolderContentsTable({
  items,
  allFolders,
  queryKey,
  onDeleteNote,
  canManage,
  canCreateSubfolder,
}: {
  items: ContentItem[];
  allFolders: Folder[];
  queryKey: unknown[];
  onDeleteNote: (note: NoteListItem) => unknown | Promise<unknown>;
  canManage: boolean;
  canCreateSubfolder: boolean;
}) {
  const [selectedNoteIds, setSelectedNoteIds] = useState<Set<string>>(new Set());
  const visibleNotes = items.flatMap((item) => (item.kind === 'note' ? [item.note] : []));
  const actionableNotes = visibleNotes.filter((note) => canManage || note.canTrash === true);
  const selectedNotes = actionableNotes.filter((note) => selectedNoteIds.has(note.id));
  const allVisibleNotesSelected =
    actionableNotes.length > 0 && actionableNotes.every((note) => selectedNoteIds.has(note.id));
  const someVisibleNotesSelected = actionableNotes.some((note) => selectedNoteIds.has(note.id));

  const toggleNote = (noteId: string, checked: boolean) => {
    setSelectedNoteIds((current) => {
      const next = new Set(current);
      if (checked) next.add(noteId);
      else next.delete(noteId);
      return next;
    });
  };

  const toggleAllVisibleNotes = (checked: boolean) => {
    setSelectedNoteIds((current) => {
      const next = new Set(current);
      for (const note of actionableNotes) {
        if (checked) next.add(note.id);
        else next.delete(note.id);
      }
      return next;
    });
  };

  const columns: ResourceColumn<ContentItem>[] = [
    {
      id: 'select',
      header: (
        <>
          {actionableNotes.length > 0 ? (
            <input
              type="checkbox"
              aria-label="Select all notes"
              checked={allVisibleNotesSelected}
              ref={(input) => {
                if (input) input.indeterminate = someVisibleNotesSelected && !allVisibleNotesSelected;
              }}
              onChange={(event) => toggleAllVisibleNotes(event.currentTarget.checked)}
            />
          ) : null}
        </>
      ),
      width: '3.5rem',
      cell: (item) => (
        <div>
          {item.kind === 'note' && (canManage || item.note.canTrash) ? (
            <input
              type="checkbox"
              aria-label={`Select ${item.note.title}`}
              checked={selectedNoteIds.has(item.note.id)}
              onChange={(event) => toggleNote(item.note.id, event.currentTarget.checked)}
            />
          ) : null}
        </div>
      ),
    },
    {
      id: 'name',
      header: 'Name',
      cell: (item) => (
        <div>
          {item.kind === 'folder' ? (
            <Link
              to="/folders/$folderId"
              params={{ folderId: item.folder.id }}
              className="flex min-w-0 items-center gap-3 font-medium hover:text-[var(--notes-blue)]"
            >
              <FolderIcon className="h-4 w-4 shrink-0 text-[var(--notes-muted)]" />
              <ResourceName>{item.folder.title}</ResourceName>
              {isEffectivelyPrivate(item.folder, allFolders) ? (
                <Lock className="h-3 w-3 shrink-0 text-[var(--notes-muted)]" aria-label="Private folder" />
              ) : null}
              {!isEffectivelyPrivate(item.folder, allFolders) && isEffectivelyAgentReadOnly(item.folder, allFolders) ? (
                <span className="shrink-0 rounded border border-amber-500/50 px-1 py-0.5 text-[9px] text-amber-600 uppercase tracking-wide">
                  RO
                </span>
              ) : null}
            </Link>
          ) : (
            <Link
              to="/notes/$noteId"
              params={{ noteId: item.note.id }}
              className="flex min-w-0 items-center gap-3 font-medium hover:text-[var(--notes-blue)]"
            >
              {item.note.documentType.startsWith('canvas.') ? (
                <Shapes className="h-4 w-4 shrink-0 text-[var(--notes-muted)]" />
              ) : (
                <FileText className="h-4 w-4 shrink-0 text-[var(--notes-muted)]" />
              )}
              <ResourceName>{item.note.title}</ResourceName>
            </Link>
          )}
        </div>
      ),
    },
    {
      id: 'type',
      header: 'Type',
      width: '6rem',
      cell: (item) => (
        <span className="notes-muted text-xs">
          {item.kind === 'folder'
            ? 'Folder'
            : item.note.documentType === 'canvas.mindmap'
              ? 'Mind map'
              : item.note.documentType.startsWith('canvas.')
                ? 'Canvas'
                : 'Note'}
        </span>
      ),
    },
    {
      id: 'updated',
      header: 'Updated',
      width: '11rem',
      cell: (item) => (
        <span className="notes-muted text-xs">
          {new Date(item.kind === 'folder' ? item.folder.updatedAt : item.note.updatedAt).toLocaleString()}
        </span>
      ),
    },
    {
      id: 'actions',
      header: 'Actions',
      width: '5rem',
      align: 'right',
      cell: (item) => (
        <div>
          <div className="flex justify-end">
            {item.kind === 'folder' && (canManage || canCreateSubfolder || item.folder.canTrash) ? (
              <FolderActionsPopover
                folder={item.folder}
                depth={folderDepth(item.folder, allFolders)}
                icon="more"
                ownerControls={canManage}
                canCreateSubfolder={canCreateSubfolder}
                canTrash={canManage || item.folder.canTrash === true}
              />
            ) : item.kind === 'note' && (canManage || item.note.canTrash) ? (
              <NoteActionsPopover
                note={item.note}
                onDelete={() => onDeleteNote(item.note)}
                ownerControls={canManage}
                canTrash={canManage || item.note.canTrash === true}
              />
            ) : null}
          </div>
        </div>
      ),
    },
  ];

  const bulkActions =
    selectedNotes.length > 0 ? (
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--notes-border)] bg-[var(--notes-panel-muted)] px-3 py-2 text-sm">
        <span className="text-[var(--notes-muted)]">
          {selectedNotes.length} {selectedNotes.length === 1 ? 'note' : 'notes'} selected
        </span>
        <div className="flex items-center gap-2">
          <Button type="button" onClick={() => setSelectedNoteIds(new Set())}>
            Clear
          </Button>
          {canManage ? <MoveNotesDialog notes={selectedNotes} onMoved={() => setSelectedNoteIds(new Set())} /> : null}
          <TrashNotesDialog notes={selectedNotes} queryKey={queryKey} onTrashed={() => setSelectedNoteIds(new Set())} />
        </div>
      </div>
    ) : null;

  return (
    <>
      {bulkActions}
      <ResourceTable
        items={items}
        columns={columns}
        rowId={(item) => (item.kind === 'folder' ? `folder-${item.folder.id}` : `note-${item.note.id}`)}
        mobileRows={items.map((item) =>
          item.kind === 'folder' ? (
            <div
              key={`folder-${item.folder.id}`}
              className="rounded-lg border border-[var(--notes-border)] bg-[var(--notes-panel)] p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <Link
                  to="/folders/$folderId"
                  params={{ folderId: item.folder.id }}
                  className="flex min-w-0 flex-1 items-start gap-3"
                >
                  <span className="rounded-md border border-[var(--notes-border)] bg-[var(--notes-panel-muted)] p-2 text-[var(--notes-muted)]">
                    <FolderIcon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="flex min-w-0 items-center gap-2 font-medium hover:text-[var(--notes-blue)]">
                      <span className="truncate">{item.folder.title}</span>
                      {isEffectivelyPrivate(item.folder, allFolders) ? (
                        <Lock className="h-3 w-3 shrink-0 text-[var(--notes-muted)]" aria-label="Private folder" />
                      ) : null}
                      {!isEffectivelyPrivate(item.folder, allFolders) &&
                      isEffectivelyAgentReadOnly(item.folder, allFolders) ? (
                        <span className="shrink-0 rounded border border-amber-500/50 px-1 py-0.5 text-[9px] text-amber-600 uppercase tracking-wide">
                          RO
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-1 block text-[var(--notes-muted)] text-xs">
                      Folder · Updated {new Date(item.folder.updatedAt).toLocaleString()}
                    </span>
                  </span>
                </Link>
                {canManage || canCreateSubfolder || item.folder.canTrash ? (
                  <FolderActionsPopover
                    folder={item.folder}
                    depth={folderDepth(item.folder, allFolders)}
                    icon="more"
                    ownerControls={canManage}
                    canCreateSubfolder={canCreateSubfolder}
                    canTrash={canManage || item.folder.canTrash === true}
                  />
                ) : null}
              </div>
            </div>
          ) : (
            <div
              key={`note-${item.note.id}`}
              className="rounded-lg border border-[var(--notes-border)] bg-[var(--notes-panel)] p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  {canManage || item.note.canTrash ? (
                    <input
                      type="checkbox"
                      className="mt-3"
                      aria-label={`Select ${item.note.title}`}
                      checked={selectedNoteIds.has(item.note.id)}
                      onChange={(event) => toggleNote(item.note.id, event.currentTarget.checked)}
                    />
                  ) : null}
                  <Link
                    to="/notes/$noteId"
                    params={{ noteId: item.note.id }}
                    className="flex min-w-0 flex-1 items-start gap-3"
                  >
                    <span className="rounded-md border border-[var(--notes-border)] bg-[var(--notes-panel-muted)] p-2 text-[var(--notes-muted)]">
                      {item.note.documentType.startsWith('canvas.') ? (
                        <Shapes className="h-4 w-4" />
                      ) : (
                        <FileText className="h-4 w-4" />
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="flex min-w-0 items-center gap-2 font-medium hover:text-[var(--notes-blue)]">
                        <span className="line-clamp-2 min-w-0 flex-1 [overflow-wrap:anywhere]" title={item.note.title}>
                          {item.note.title}
                        </span>
                      </span>
                      <span className="mt-1 block text-[var(--notes-muted)] text-xs">
                        {item.note.documentType === 'canvas.mindmap'
                          ? 'Mind map'
                          : item.note.documentType.startsWith('canvas.')
                            ? 'Canvas'
                            : 'Note'}{' '}
                        · Updated {new Date(item.note.updatedAt).toLocaleString()}
                      </span>
                    </span>
                  </Link>
                </div>
                {canManage || item.note.canTrash ? (
                  <NoteActionsPopover
                    note={item.note}
                    onDelete={() => onDeleteNote(item.note)}
                    ownerControls={canManage}
                    canTrash={canManage || item.note.canTrash === true}
                  />
                ) : null}
              </div>
            </div>
          )
        )}
      />
    </>
  );
}

type FolderAccessDenial = { userId: string; folderId: string; readAt: number; source: 'folder' | 'notes' };
function FolderView() {
  // Keep observed denial across presentation transitions, including their brief match-coherence boundary.
  const [deniedDetail, setDeniedDetail] = useState<FolderAccessDenial | null>(null);
  const { folderId } = folderRoute.useParams();
  const search = folderRoute.useSearch();
  const { view } = search;
  const router = useRouter();
  const session = authClient.useSession();
  const userId = session.data?.user.id;
  const location = useRouterState({ select: (router) => router.location });
  const match = folderRoute.useMatch();
  const state = location.state;
  // Location advances before route matches during navigation. Never redirect
  // using the previous match's view/params and the next entry's history state.
  const currentEntry =
    location.pathname === match.pathname &&
    router.history.location.pathname === match.pathname &&
    validateBoardSearch(location.search).view === view;
  const resolved = userId ? resolveFolderEntryView(view, userId, folderId, state) : 'list';
  const native = router.history.location;
  const parsed = readFolderQuery(native.search);
  const canonicalHref =
    parsed.query && !parsed.error
      ? folderQueryHref(folderId, parsed.query, resolved, parsed.sort)
      : folderViewHref(folderId, native.search, resolved);
  const normalize =
    !!userId &&
    (view === 'list' ||
      (!view && !isFolderListHistoryState(state, userId, folderId)) ||
      `${native.pathname}${native.search}` !== canonicalHref);
  useEffect(() => {
    if (!userId || !currentEntry || !normalize) return;
    // Native URL values avoid the router JSON codec changing literal title terms or filters.
    router.history.replace(canonicalHref, {
      ...state,
      ...(resolved === 'list' ? folderListHistoryState(userId, folderId) : { minunotesFolderList: undefined }),
    });
  }, [userId, currentEntry, normalize, resolved, canonicalHref, folderId, state, router]);
  if (!userId) return <p className="notes-muted text-sm">Loading folder...</p>;
  if (!currentEntry || normalize) return null;
  return (
    <FolderViewContent
      key={`${userId}:${folderId}`}
      userId={userId}
      deniedDetail={deniedDetail}
      setDeniedDetail={setDeniedDetail}
    />
  );
}

function FolderViewContent({
  userId,
  deniedDetail,
  setDeniedDetail,
}: {
  userId: string;
  deniedDetail: FolderAccessDenial | null;
  setDeniedDetail: Dispatch<SetStateAction<FolderAccessDenial | null>>;
}) {
  const { folderId } = folderRoute.useParams();
  const { view } = folderRoute.useSearch();
  const boardView = view === 'board';
  const router = useRouter();
  const location = useRouterState({ select: (state) => state.location });
  const nativeSearch = router.history.location.search;
  const parsed = readFolderQuery(nativeSearch);
  const applied = parsed.query;
  const sort = parsed.sort;
  const identity = applied && !parsed.error ? folderReadIdentity(applied, sort) : `invalid:${nativeSearch}`;
  const needsSchema = !!applied?.filters.all.length || isPropertySort(sort);
  const schemaRead = useQuery({
    enabled: needsSchema,
    queryKey: ['folder-properties', folderId, userId],
    queryFn: () => api.folderProperties(folderId),
    retry: (count, error) => !(error instanceof ApiError && [401, 403, 404, 409].includes(error.status)) && count < 2,
  });
  const sortIssue = parsed.sortError ?? noteSortSchemaError(sort, schemaRead.error ? undefined : schemaRead.data);
  const queryIssue =
    parsed.error ??
    (needsSchema ? schemaRead.error?.message : null) ??
    (applied ? folderQuerySchemaError(applied, schemaRead.data) : null) ??
    sortIssue;
  const schemaToken =
    needsSchema && schemaRead.data?.schemaId
      ? { schemaId: schemaRead.data.schemaId, schemaRevision: schemaRead.data.revision }
      : undefined;
  const listGeneration = JSON.stringify([userId, folderId, view, identity, schemaToken]);
  const [paging, setPaging] = useState({ generation: listGeneration, page: 1 });
  const page = paging.generation === listGeneration ? paging.page : 1;
  useEffect(
    () =>
      setPaging((current) =>
        current.generation === listGeneration ? current : { generation: listGeneration, page: 1 }
      ),
    [listGeneration]
  );
  const setPage = (next: number) => setPaging({ generation: listGeneration, page: next });
  const applyQuery = useCallback(
    (next: NoteQuery, replace: boolean, nextSort: NoteSort = sort) => {
      if (
        router.history.location.pathname !== `/folders/${encodeURIComponent(folderId)}` ||
        router.history.location.state.__TSR_key !== location.state.__TSR_key
      )
        return;
      router.history[replace ? 'replace' : 'push'](
        folderQueryHref(folderId, next, boardView ? 'board' : 'list', nextSort),
        {
          ...location.state,
          ...(boardView ? { minunotesFolderList: undefined } : folderListHistoryState(userId, folderId)),
        }
      );
    },
    [router, folderId, boardView, userId, location.state, sort]
  );
  const nav = useNavigate();
  const qc = useQueryClient();
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const folderSettingsRef = useRef<HTMLButtonElement>(null);
  const [boardToolbar, setBoardToolbar] = useState<HTMLDivElement | null>(null);
  const sortTriggerRef = useRef<HTMLButtonElement>(null);
  const focusAfterSortReset = useRef(false);
  useEffect(() => {
    if (focusAfterSortReset.current) {
      focusAfterSortReset.current = false;
      sortTriggerRef.current?.focus();
    }
  }, [identity]);
  const { data: foldersData } = useQuery({
    queryKey: ['folders'],
    queryFn: api.folders,
  });
  const {
    data: folderDetail,
    error: folderError,
    isLoading: folderLoading,
    isFetched: folderFetched,
    dataUpdatedAt: folderReadAt,
    failureReason: folderFailure,
    refetch: refetchFolderDetail,
  } = useQuery({
    queryKey: ['folder-detail', folderId],
    queryFn: () => api.folderDetail(folderId),
    retry: (failureCount, error) =>
      !(error instanceof ApiError && (error.status === 404 || (boardView && [401, 403].includes(error.status)))) &&
      failureCount < 3,
  });
  // App-shell observes this SAME query too; its retry policy can defer the final error.
  // Suppress cached navigation on the first denied read, until a fresh successful read authorizes it.
  const accessFailure = [folderError, folderFailure, schemaRead.error].some(
    (failure) => failure instanceof ApiError && [401, 403, 404].includes(failure.status)
  );
  const folderAccessDenied =
    accessFailure ||
    (deniedDetail?.userId === userId &&
      deniedDetail.folderId === folderId &&
      (deniedDetail.source === 'notes' || folderReadAt <= deniedDetail.readAt));
  useEffect(() => {
    if (accessFailure) {
      setDeniedDetail((current) =>
        current?.userId === userId &&
        current.folderId === folderId &&
        (current.source === 'notes' || current.readAt === folderReadAt)
          ? current
          : { userId, folderId, readAt: folderReadAt, source: 'folder' }
      );
    } else if (
      deniedDetail &&
      (deniedDetail.userId !== userId ||
        deniedDetail.folderId !== folderId ||
        (deniedDetail.source === 'folder' && folderReadAt > deniedDetail.readAt))
    ) {
      setDeniedDetail(null);
    }
  }, [accessFailure, folderId, folderReadAt, deniedDetail, userId, setDeniedDetail]);
  const {
    data,
    error,
    isLoading,
    isFetching: notesFetching,
    refetch: refetchNotes,
  } = useQuery({
    queryKey: ['notes', folderId, 'note', userId, identity, schemaToken, page],
    queryFn: async ({ signal }) => {
      if (!applied) throw new ApiError('Review or clear the folder query.', 400);
      const captured = { query: applied, schema: schemaToken, sort };
      const result = await api.notes(folderId, 'note', page, 50, captured, signal);
      verifyFolderQueryEcho(result, captured);
      return result;
    },
    enabled: !boardView && !queryIssue && !folderAccessDenied,
    retry: (count, cause) =>
      !(cause instanceof ApiError && [400, 401, 403, 404, 409].includes(cause.status)) && count < 2,
  });
  const noteAccessDenied = error instanceof ApiError && [401, 403, 404].includes(error.status);
  const onAccessDenied = useCallback(
    () => setDeniedDetail({ userId, folderId, readAt: folderReadAt, source: 'notes' }),
    [userId, folderId, folderReadAt, setDeniedDetail]
  );
  useEffect(() => {
    if (noteAccessDenied) onAccessDenied();
  }, [noteAccessDenied, onAccessDenied]);
  const create = useMutation({
    mutationFn: (documentType: 'markdown' | 'canvas.default' | 'canvas.mindmap' = 'markdown') =>
      api.createNote(folderId, { documentType }),
    onSuccess: ({ note }) => {
      markEmptyDraft(note);
      void nav({ to: '/notes/$noteId', params: { noteId: note.id } });
      void qc.invalidateQueries({ queryKey: ['notes', folderId] });
      void qc.invalidateQueries({ queryKey: ['notes', 'recent'] });
    },
  });
  const remove = useMutation({
    mutationFn: ({ noteId }: { noteId: string }) => api.deleteNote(noteId),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: ['notes', folderId] });
      qc.invalidateQueries({ queryKey: ['notes', 'recent'] });
      qc.removeQueries({ queryKey: ['note', variables.noteId] });
    },
  });

  if (folderLoading && !folderFetched) return <p className="notes-muted text-sm">Loading folder...</p>;
  const activeError = boardView ? folderError : error;
  if (
    (activeError instanceof ApiError && [401, 403, 404].includes(activeError.status)) ||
    folderAccessDenied ||
    noteAccessDenied
  )
    return (
      <section className="grid min-h-[60vh] place-items-center">
        <EmptyState title="Folder not found">
          <p>This folder does not exist or you do not have access to it.</p>
          {boardView ? <p role="alert">Board unavailable; folder access must be checked again.</p> : null}
          <Button
            className="mt-4"
            onClick={() => {
              qc.removeQueries({ queryKey: ['notes', folderId] });
              qc.removeQueries({ queryKey: ['board', folderId] });
              setDeniedDetail(null);
              void refetchFolderDetail();
            }}
          >
            Retry folder access
          </Button>
          <Button className="mt-4" onClick={() => nav({ to: '/' })}>
            Back to notes
          </Button>
        </EmptyState>
      </section>
    );

  const allFolders = [
    ...(foldersData?.folders ?? []),
    ...(folderDetail ? [folderDetail.folder, ...folderDetail.childFolders] : []),
  ].filter((folder, index, items) => items.findIndex((candidate) => candidate.id === folder.id) === index);
  const folder = folderDetail?.folder ?? allFolders.find((item) => item.id === folderId);
  const childFolders =
    boardView || page === 1
      ? (folderDetail?.childFolders ?? allFolders.filter((item) => item.parentFolderId === folderId))
      : [];
  const accessRole = folderDetail?.access.role ?? data?.access.role ?? 'viewer';
  const canCreate = accessRole === 'owner' || accessRole === 'editor';
  const isOwner = accessRole === 'owner';
  const notes = queryIssue || error || boardView ? [] : (data?.notes ?? []);
  const folderItems: FolderItem[] = childFolders
    .map((child) => ({
      kind: 'folder' as const,
      folder: child,
    }))
    .sort(compareContentItemsByUpdatedDesc);
  // Never re-sort a page of notes: the server's global order is authoritative.
  // Retain default folder interleaving; explicit sorts pin subfolder navigation above notes.
  const items: ContentItem[] = sort === DEFAULT_NOTE_SORT ? [] : [...folderItems];
  let folderIndex = 0;
  for (const note of notes) {
    const item: NoteItem = { kind: 'note', note };
    if (sort === DEFAULT_NOTE_SORT) {
      while (folderIndex < folderItems.length && compareContentItemsByUpdatedDesc(folderItems[folderIndex], item) < 0)
        items.push(folderItems[folderIndex++]);
    }
    items.push(item);
  }
  if (sort === DEFAULT_NOTE_SORT) items.push(...folderItems.slice(folderIndex));
  const createMarkdownNote = () => create.mutate('markdown');
  const createCanvasNote = () => {
    setNewMenuOpen(false);
    create.mutate('canvas.default');
  };
  const createMindMapNote = () => {
    setNewMenuOpen(false);
    create.mutate('canvas.mindmap');
  };
  const openTemplatePicker = () => {
    setNewMenuOpen(false);
    void nav({
      to: '/folders/$folderId/new-from-template',
      params: { folderId },
    });
  };

  return (
    <section className={`mx-auto w-full min-w-0 ${boardView ? 'flex h-full min-h-0 flex-col' : 'max-w-5xl'}`}>
      <div
        className={
          boardView
            ? 'mb-6 flex shrink-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'
            : 'mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'
        }
      >
        <div className="min-w-0">
          <h2 className="font-semibold text-xl">{folder?.title ?? 'Folder notes'}</h2>
          {folderDetail?.access.source === 'folder_grant' && folderDetail.sharedBy ? (
            <p className="mt-1 text-[var(--notes-muted)] text-sm">Shared by {folderDetail.sharedBy.label}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {boardView ? (
            folderError ? (
              <div className="flex items-center gap-2 text-sm">
                <span role="status" className="notes-muted">
                  Subfolders unavailable
                </span>
                <Button onClick={() => void refetchFolderDetail()} aria-label="Retry subfolders">
                  Retry
                </Button>
              </div>
            ) : folderDetail?.folder.id === folderId ? (
              <BoardSubfolderPicker
                key={folderId}
                folders={folderDetail.childFolders}
                fallbackFocus={folderSettingsRef}
              />
            ) : null
          ) : null}
          {canCreate ? (
            <div className="inline-flex overflow-hidden rounded-md border border-[var(--notes-button-secondary-border)]">
              <button
                type="button"
                className="border-[var(--notes-button-secondary-border)] border-r bg-[var(--notes-button-secondary-bg)] px-3 py-2 text-[var(--notes-button-secondary-text)] text-sm transition-colors hover:bg-[var(--notes-button-secondary-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={create.isPending}
                onClick={createMarkdownNote}
              >
                New Note
              </button>
              <Popover open={newMenuOpen} onOpenChange={setNewMenuOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="flex items-center bg-[var(--notes-button-secondary-bg)] px-2 text-[var(--notes-button-secondary-text)] text-sm transition-colors hover:bg-[var(--notes-button-secondary-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={create.isPending}
                    aria-label="Open new options"
                  >
                    <ChevronDown className="h-4 w-4" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-48 p-1">
                  {isOwner ? (
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-[var(--notes-hover)]"
                      onClick={openTemplatePicker}
                    >
                      <FileText className="h-4 w-4 text-[var(--notes-muted)]" />
                      <span>From template</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-[var(--notes-hover)]"
                    onClick={createCanvasNote}
                  >
                    <Shapes className="h-4 w-4 text-[var(--notes-muted)]" />
                    <span>Canvas</span>
                  </button>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-[var(--notes-hover)]"
                    onClick={createMindMapNote}
                  >
                    <GitBranch className="h-4 w-4 text-[var(--notes-muted)]" />
                    <span>Mind map</span>
                  </button>
                </PopoverContent>
              </Popover>
            </div>
          ) : (
            <span className="rounded-md border border-[var(--notes-border)] px-2 py-1 text-[var(--notes-muted)] text-xs capitalize">
              {accessRole}
            </span>
          )}
          {folder ? (
            <FolderActionsPopover
              folder={folder}
              depth={folderDepth(folder, allFolders)}
              icon="settings"
              view={boardView ? 'board' : 'list'}
              viewTriggerRef={folderSettingsRef}
              onViewChange={(next) => {
                storeFolderViewPreference(userId, folderId, next);
                router.history.push(folderViewHref(folderId, router.history.location.search, next), {
                  ...location.state,
                  ...(next === 'list' ? folderListHistoryState(userId, folderId) : { minunotesFolderList: undefined }),
                });
              }}
              ownerControls={isOwner}
              canCreateSubfolder={canCreate}
              canTrash={isOwner || folder.canTrash === true}
            />
          ) : null}
        </div>
      </div>

      {applied && !parsed.sortError ? (
        <FolderQueryControls
          key={`${userId}:${folderId}:${view}`}
          query={applied}
          sort={sort}
          sortTriggerRef={sortTriggerRef}
          onSortChange={(nextSort, nextQuery) => applyQuery(nextQuery, false, nextSort)}
          schema={schemaRead.error ? undefined : schemaRead.data}
          schemaLoading={schemaRead.isPending}
          schemaError={schemaRead.error?.message}
          onRefresh={() => void schemaRead.refetch()}
          onChange={applyQuery}
          actionTargetRef={boardView ? setBoardToolbar : undefined}
          actions={
            !boardView ? (
              <QuickTooltip label="Refresh notes">
                <Button
                  type="button"
                  aria-label="Refresh notes"
                  className="inline-flex h-8 w-8 items-center justify-center p-0!"
                  disabled={notesFetching || !!queryIssue}
                  onClick={() => void refetchNotes()}
                >
                  <RefreshCw aria-hidden="true" className="h-4 w-4" />
                </Button>
              </QuickTooltip>
            ) : undefined
          }
        />
      ) : null}
      {queryIssue ? (
        <div role="alert" className="mb-4 text-sm">
          <p>{queryIssue}</p>
          <p>Review or remove the condition; results have not been broadened.</p>
          {sortIssue ? (
            <Button
              onClick={() => {
                const params = new URLSearchParams(nativeSearch);
                params.delete('sort');
                focusAfterSortReset.current = true;
                router.history.push(
                  folderViewHref(folderId, params.toString(), boardView ? 'board' : 'list'),
                  location.state
                );
              }}
            >
              Reset sort
            </Button>
          ) : (
            <Button onClick={() => void schemaRead.refetch()}>Refresh definitions</Button>
          )}
          <Button onClick={() => applyQuery(EMPTY_NOTE_QUERY, false)}>Clear folder query</Button>
        </div>
      ) : null}
      {boardView ? (
        <NotesBoard
          key={`${userId}:${folderId}:${identity}`}
          folderId={folderId}
          actorId={userId}
          appliedQuery={applied ?? undefined}
          sort={sort}
          filterSchema={schemaToken}
          queryError={queryIssue}
          onAccessDenied={onAccessDenied}
          onRefreshDefinitions={() => void schemaRead.refetch()}
          toolbarTarget={boardToolbar}
        />
      ) : items.length ? (
        <FolderContentsTable
          key={listGeneration}
          items={items}
          allFolders={allFolders}
          queryKey={['notes', folderId]}
          onDeleteNote={(note) => remove.mutateAsync({ noteId: note.id })}
          canManage={isOwner}
          canCreateSubfolder={canCreate}
        />
      ) : !queryIssue && !error && !isLoading ? (
        <EmptyState>{applied && hasNoteQuery(applied) ? 'No matching notes.' : 'No folders or notes yet.'}</EmptyState>
      ) : null}
      {!boardView && isLoading ? <p role="status">Loading notes…</p> : null}
      {!boardView && error ? (
        <div role="alert">
          <p>{error.message}</p>
          <Button
            onClick={() => {
              void schemaRead.refetch();
              void qc.invalidateQueries({ queryKey: ['notes', folderId] });
            }}
          >
            Retry notes
          </Button>
        </div>
      ) : null}
      {!boardView &&
      childFolders.length > 0 &&
      !isLoading &&
      !error &&
      !queryIssue &&
      !notes.length &&
      applied &&
      hasNoteQuery(applied) ? (
        <p className="mt-3 text-sm">No matching notes.</p>
      ) : null}
      {!boardView && !queryIssue && !error ? (
        <PaginationControls page={data?.page ?? page} hasMore={data?.hasMore ?? false} onPageChange={setPage} />
      ) : null}
    </section>
  );
}

export const folderRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/folders/$folderId',
  validateSearch: validateBoardSearch,
  component: FolderView,
});
