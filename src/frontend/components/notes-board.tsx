import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BoardSchemaToken } from '../../shared/board';
import { EMPTY_NOTE_QUERY, hasNoteQuery, type NoteQuery } from '../../shared/note-filters';
import { DEFAULT_NOTE_SORT, folderReadIdentity, isPropertySort, type NoteSort } from '../../shared/note-sort';
import { ApiError, api, type FolderQueryRequest, type SavedBoard, verifyFolderQueryEcho } from '../lib/api';
import { refreshPublicFolderNavigation } from '../lib/public-folder-share';
import { FolderBoardSettingsDialog } from './folder-board-settings-dialog';
import { Button } from './ui/button';
import { QuickTooltip } from './ui/tooltip';

function unavailable(error: unknown) {
  return error instanceof ApiError && [401, 403, 404, 409].includes(error.status);
}
function retry(failures: number, error: Error) {
  return !unavailable(error) && failures < 2;
}
function BoardLane({
  folderId,
  board,
  lane,
  label,
  generation,
  captured,
  actorId,
  shareToken,
  onUnavailable,
}: {
  folderId: string;
  board: SavedBoard;
  lane: string;
  label: string;
  generation: string;
  captured: FolderQueryRequest;
  actorId: string;
  shareToken?: string;
  onUnavailable: (error: Error) => void;
}) {
  const state = board.groupingState;
  const schema =
    state?.type === 'select' && state.available
      ? { schemaId: state.schemaId, schemaRevision: state.schemaRevision }
      : undefined;
  const query = useInfiniteQuery({
    queryKey: ['board', folderId, 'lane', actorId, generation, lane],
    queryFn: async ({ pageParam, signal }) => {
      const page = await api.boardLane(folderId, lane, board.version, pageParam, schema, captured, signal, shareToken);
      verifyFolderQueryEcho(page, captured);
      if (
        page.configVersion !== board.version ||
        (schema && (page.schemaId !== schema.schemaId || page.schemaRevision !== schema.schemaRevision))
      )
        throw new ApiError('Board snapshot changed. Refresh the board.', 409);
      return page;
    },
    initialPageParam: 1,
    getNextPageParam: (page) => (page.hasMore ? page.page + 1 : undefined),
    retry,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (query.error && unavailable(query.error)) onUnavailable(query.error);
  }, [query.error, onUnavailable]);
  // Offset pages can overlap when another actor changes updated-desc ordering.
  // Count/render each loaded note once; a refresh is still needed for a fresh snapshot.
  const cards = [
    ...new Map((query.data?.pages.flatMap((page) => page.cards) ?? []).map((card) => [card.id, card])).values(),
  ];
  // Do not keep showing stale cards after access revocation, config changes, or failed reads.
  const inaccessible = unavailable(query.error);
  const countDescriptionId = useId();
  const showCount = Boolean(query.data) && !query.error && !inaccessible;
  const countDescription = `${cards.length} ${cards.length === 1 ? 'card' : 'cards'} loaded.${query.hasNextPage ? ' More available.' : ''}`;
  return (
    <section
      aria-label={label}
      className="flex h-full min-h-0 min-w-0 flex-col rounded-md border border-[var(--notes-border)] bg-[var(--notes-panel-muted)] p-3"
    >
      <header className="relative flex min-w-0 shrink-0 items-center gap-1">
        <h3
          aria-describedby={showCount ? countDescriptionId : undefined}
          title={label}
          className="min-w-0 truncate font-medium text-sm"
        >
          {label}
        </h3>
        {showCount ? (
          <>
            <QuickTooltip label={countDescription}>
              {/* A read-only count, not a button or a live announcement. */}
              <span
                role="note"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need the same informational tooltip as mouse users.
                tabIndex={0}
                aria-label={countDescription}
                aria-describedby={countDescriptionId}
                className="shrink-0 whitespace-nowrap rounded-sm text-[var(--notes-muted)] text-xs focus-visible:outline-2 focus-visible:outline-[var(--notes-blue)]"
              >
                · {cards.length}
                {query.hasNextPage ? '+' : ''}
              </span>
            </QuickTooltip>
            <span id={countDescriptionId} className="sr-only">
              {countDescription}
            </span>
          </>
        ) : null}
      </header>
      <section
        aria-label={`${label} cards`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Labelled scroll regions need native keyboard scrolling, even when empty.
        tabIndex={0}
        className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-sm [-ms-overflow-style:none] [scrollbar-width:none] focus-visible:outline-2 focus-visible:outline-[var(--notes-blue)] [&::-webkit-scrollbar]:hidden"
      >
        {query.isFetching ? (
          <p role="status" className="mt-2 text-xs">
            {cards.length ? 'Refreshing…' : 'Loading…'}
          </p>
        ) : null}
        {query.error ? (
          <div role="alert" className="mt-2 text-xs">
            <p>{query.error.message}</p>
            <p>Last read failed; any retained cards may be stale.</p>
            <Button onClick={() => query.refetch()}>Retry lane</Button>
          </div>
        ) : null}
        {!query.isPending && !query.error && !cards.length ? (
          <p className="mt-3 text-[var(--notes-muted)] text-sm">
            {hasNoteQuery(captured.query) ? 'No matching notes in this column.' : 'No notes in this lane.'}
          </p>
        ) : null}
        {!inaccessible ? (
          <ul className="space-y-2">
            {cards.map((card) => (
              <li
                key={card.id}
                className="rounded border border-[var(--notes-border)] bg-[var(--notes-panel)] p-3 text-sm"
              >
                {shareToken ? (
                  <Link
                    to="/share/folders/$token"
                    params={{ token: shareToken }}
                    search={{ note: card.id, folder: folderId, view: 'board' }}
                    className="block font-medium underline-offset-2 [overflow-wrap:anywhere] hover:underline"
                  >
                    {card.title}
                  </Link>
                ) : (
                  <Link
                    to="/notes/$noteId"
                    params={{ noteId: card.id }}
                    className="block font-medium underline-offset-2 [overflow-wrap:anywhere] hover:underline"
                  >
                    {card.title}
                  </Link>
                )}
                <p className="mt-1 text-[var(--notes-muted)] text-xs">
                  {card.documentType.startsWith('canvas.') ? 'Canvas' : 'Note'} ·{' '}
                  {new Date(card.updatedAt).toLocaleString()}
                </p>
                {card.unclassifiedReason ? (
                  <p className="mt-2 text-xs">
                    {
                      {
                        'no-property-value': 'No property value',
                        'unavailable-property-value': 'Archived or unavailable property value',
                      }[card.unclassifiedReason]
                    }
                  </p>
                ) : null}
                {card.properties?.length ? (
                  <dl
                    aria-label="Card properties"
                    className="relative mt-2 min-w-0 space-y-1 text-[var(--notes-muted)] text-xs"
                  >
                    {card.properties.map((property) => (
                      <div
                        key={property.propertyId}
                        className="min-w-0 max-w-full"
                        title={property.type === 'text' ? property.label : `${property.label}: ${property.value}`}
                      >
                        <dt className="sr-only">{property.label}:</dt>
                        <dd
                          className={
                            property.type === 'select'
                              ? 'inline-block max-w-full rounded-sm border border-[color-mix(in_srgb,var(--notes-blue)_20%,transparent)] bg-[color-mix(in_srgb,var(--notes-blue)_10%,transparent)] px-1.5 py-0.5 text-[var(--notes-text)] [overflow-wrap:anywhere]'
                              : property.type === 'date'
                                ? 'py-0.5 tabular-nums'
                                : 'min-w-0'
                          }
                        >
                          <span
                            className={
                              property.type === 'text'
                                ? 'line-clamp-2 [overflow-wrap:anywhere]'
                                : '[overflow-wrap:anywhere]'
                            }
                          >
                            {property.value}
                          </span>
                          {property.type === 'text' && property.truncated ? (
                            <span className="text-[10px]">Truncated preview</span>
                          ) : null}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      {!inaccessible && query.hasNextPage ? (
        <Button className="mt-3 w-full shrink-0" disabled={query.isFetching} onClick={() => query.fetchNextPage()}>
          Load more {label}
        </Button>
      ) : null}
    </section>
  );
}

export function NotesBoard({
  folderId,
  actorId = '',
  shareToken,
  appliedQuery = EMPTY_NOTE_QUERY,
  sort = DEFAULT_NOTE_SORT,
  filterSchema,
  queryError,
  onAccessDenied,
  onRefreshDefinitions,
  toolbarTarget,
}: {
  folderId: string;
  actorId?: string;
  shareToken?: string;
  appliedQuery?: NoteQuery;
  sort?: NoteSort;
  filterSchema?: BoardSchemaToken;
  queryError?: string | null;
  onAccessDenied?: () => void;
  onRefreshDefinitions?: () => void;
  toolbarTarget?: HTMLDivElement | null;
}) {
  const scrollHintId = useId();
  const readerId = shareToken ? `share:${shareToken}` : actorId;
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['board', folderId, 'config', readerId],
    queryFn: () => api.boardConfig(folderId, shareToken),
    retry,
    refetchOnWindowFocus: true,
  });
  useEffect(() => {
    if (query.error instanceof ApiError && [401, 403, 404].includes(query.error.status)) onAccessDenied?.();
  }, [query.error, onAccessDenied]);
  const state = query.data?.board?.groupingState;
  const generation = JSON.stringify([
    readerId,
    folderReadIdentity(appliedQuery, sort),
    filterSchema,
    query.data?.board?.version ?? 0,
    state?.type === 'select' && state.available ? [state.schemaId, state.schemaRevision] : 'unavailable',
  ]);
  const currentGeneration = useRef(generation);
  currentGeneration.current = generation;
  const captured = { query: appliedQuery, schema: filterSchema, sort };
  const schemaMismatch =
    (!!appliedQuery.filters.all.length || isPropertySort(sort)) &&
    state?.type === 'select' &&
    state.available &&
    (filterSchema?.schemaId !== state.schemaId || filterSchema?.schemaRevision !== state.schemaRevision);
  const [blocked, setBlocked] = useState<{ generation: string; error: Error } | null>(null);
  const onUnavailable = useCallback(
    (error: Error) => {
      if (currentGeneration.current !== generation) return;
      setBlocked({ generation, error });
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) onAccessDenied?.();
    },
    [generation, onAccessDenied]
  );
  useEffect(() => {
    if (!query.dataUpdatedAt || query.error) return;
    setBlocked(null);
    // A successful config/schema refresh resets all lane pages together.
    void qc.resetQueries({ queryKey: ['board', folderId, 'lane', readerId] });
  }, [query.dataUpdatedAt, query.error, qc, folderId, readerId]);
  useEffect(() => {
    if (blocked?.generation === generation) qc.removeQueries({ queryKey: ['board', folderId, 'lane', readerId] });
  }, [blocked, generation, qc, folderId, readerId]);
  const refreshBoard = async () => {
    onRefreshDefinitions?.();
    if (shareToken) {
      try {
        await refreshPublicFolderNavigation(qc, shareToken);
      } catch {
        // The public viewer owns navigation errors and root-share denial cleanup.
        return;
      }
    }
    const result = await query.refetch();
    if (result.isError) await qc.invalidateQueries({ queryKey: ['board', folderId, 'lane', readerId] });
  };
  if (query.isPending) return <p role="status">Loading board…</p>;
  if (!query.data || unavailable(query.error))
    return (
      <div role="alert">
        <p>{query.error?.message ?? 'Board could not be loaded.'} Board unavailable; refresh to retry.</p>
        <Button onClick={() => query.refetch()}>Retry board</Button>
      </div>
    );
  const board = query.data.board;
  const generationError = blocked?.generation === generation ? blocked.error : null;
  const revoked = generationError instanceof ApiError && [401, 403, 404].includes(generationError.status);
  const columns = board?.columns ?? [];
  // Keep the controls and settings controller owned here; only their DOM placement changes.
  const actions = (
    <div className="flex shrink-0 items-center gap-2">
      <QuickTooltip label="Refresh board">
        <Button
          type="button"
          aria-label="Refresh board"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center p-0!"
          onClick={refreshBoard}
        >
          <RefreshCw aria-hidden="true" className="h-4 w-4" />
        </Button>
      </QuickTooltip>
      {!shareToken && !revoked && query.data.access?.role === 'owner' ? (
        <FolderBoardSettingsDialog folderId={folderId} board={board} />
      ) : null}
    </div>
  );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
      {query.error ? (
        <div role="alert" className="shrink-0 text-sm">
          Last configuration read failed; displayed data may be stale. Settings drafts have been kept.{' '}
          <Button onClick={() => query.refetch()}>Retry board</Button>
        </div>
      ) : null}
      {toolbarTarget ? createPortal(actions, toolbarTarget) : actions}
      {queryError ? null : schemaMismatch ? (
        <div role="alert">Filter definitions and board snapshot changed. Refresh to review one current snapshot.</div>
      ) : generationError ? (
        <div role="alert">
          <p>{generationError.message} Board unavailable; refresh to load one current snapshot.</p>
          <Button onClick={refreshBoard}>Retry board</Button>
        </div>
      ) : state?.type === 'select' && !state.available ? (
        <div role="alert">{state.reason}</div>
      ) : !board?.config.enabled ? (
        <p className="text-sm">
          Board is not enabled.{' '}
          {query.data.access?.role === 'owner'
            ? 'Use Board settings to configure it.'
            : 'The folder owner can enable it.'}
        </p>
      ) : !query.error && state?.type === 'select' && state.available && board.columns?.length === 0 ? (
        <div className="rounded-md border border-[var(--notes-border)] p-5 text-sm">
          <p role="status">No columns selected</p>
          <p className="notes-muted mt-2">
            {query.data.access?.role === 'owner'
              ? 'Choose visible columns in Board settings to show cards.'
              : 'The folder owner can choose which columns appear.'}
          </p>
        </div>
      ) : (
        <>
          <p id={scrollHintId} className="sr-only">
            Scroll sideways for more statuses. Scroll within a column for more cards.
          </p>
          <section
            className="grid min-h-48 w-full min-w-0 flex-1 auto-cols-[minmax(16rem,24rem)] grid-flow-col grid-rows-[minmax(0,1fr)] items-stretch gap-3 overflow-x-auto overflow-y-hidden overscroll-x-contain rounded-sm p-1 focus-visible:outline-2 focus-visible:outline-[var(--notes-blue)]"
            aria-label="Folder board"
            aria-describedby={scrollHintId}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: This horizontal scroll region needs native arrow-key scrolling.
            tabIndex={0}
          >
            {columns.map((lane) => (
              <BoardLane
                key={`${generation}-${lane.key}`}
                folderId={folderId}
                board={board}
                lane={lane.key}
                label={lane.label}
                generation={generation}
                captured={captured}
                actorId={readerId}
                shareToken={shareToken}
                onUnavailable={onUnavailable}
              />
            ))}
          </section>
        </>
      )}
    </div>
  );
}
