import { NOTE_QUERY_MAX_BYTES, type NoteQuery, noteQuerySearch, parseNoteQuery } from '../../shared/note-filters';
import { DEFAULT_NOTE_SORT, type NoteSort, noteSortIdentity, parseNoteSort } from '../../shared/note-sort';

/** Native URL values must not be reinterpreted by the router's JSON codec. */
export function readFolderQuery(search: string): {
  query: NoteQuery | null;
  sort: NoteSort;
  sortError: string | null;
  error: string | null;
} {
  const params = new URLSearchParams(search);
  let sort: NoteSort = DEFAULT_NOTE_SORT;
  let sortError: string | null = null;
  try {
    sort = parseNoteSort(params);
  } catch (cause) {
    sortError = (cause as Error).message;
  }
  try {
    if (params.toString().length > NOTE_QUERY_MAX_BYTES)
      throw new Error('Shorten the search or filters (maximum encoded query is 8 KiB).');
    if (params.getAll('q').length > 1 || params.getAll('filters').length > 1)
      throw new Error('Use a single search and filters parameter.');
    return {
      query: parseNoteQuery({ q: params.get('q') ?? undefined, filters: params.get('filters') ?? undefined }),
      sort,
      sortError,
      error: sortError,
    };
  } catch (error) {
    return {
      query: null,
      sort,
      sortError,
      error: error instanceof Error ? error.message : 'Review or clear the folder query.',
    };
  }
}
export function folderQueryHref(
  folderId: string,
  query: NoteQuery,
  view: 'list' | 'board',
  sort: NoteSort = DEFAULT_NOTE_SORT
): string {
  const params = new URLSearchParams(noteQuerySearch(query));
  if (sort !== DEFAULT_NOTE_SORT) params.set('sort', noteSortIdentity(sort));
  return folderViewHref(folderId, params.toString(), view);
}
export function folderViewHref(folderId: string, search: string, view: 'list' | 'board'): string {
  const params = new URLSearchParams(search);
  params.delete('view');
  params.delete('boardTags');
  if (view === 'board') params.set('view', 'board');
  return `/folders/${encodeURIComponent(folderId)}${params.size ? `?${params}` : ''}`;
}
export function validateBoardSearch(search: Record<string, unknown>): {
  view?: 'list' | 'board';
  boardTags?: undefined;
  q?: unknown;
  filters?: unknown;
  sort?: unknown;
} {
  return {
    view: search.view === 'board' || search.view === 'list' ? search.view : undefined,
    boardTags: undefined,
    ...(search.q !== undefined ? { q: search.q } : {}),
    ...(search.filters !== undefined ? { filters: search.filters } : {}),
    ...(search.sort !== undefined ? { sort: search.sort } : {}),
  };
}
