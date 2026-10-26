import { type QueryClient, queryOptions } from '@tanstack/react-query';
import { ApiError, api } from './api';

export const publicFolderKeys = {
  navigation: (token: string) => ['public-folder-share', token, 'navigation'] as const,
  notes: (token: string) => ['public-folder-share', token, 'note'] as const,
  note: (token: string, noteId: string) => ['public-folder-share', token, 'note', noteId] as const,
};

export function publicShareDenied(error: unknown) {
  return error instanceof ApiError && [401, 403, 404].includes(error.status);
}

export function publicFolderNavigationOptions(token: string) {
  return queryOptions({
    queryKey: publicFolderKeys.navigation(token),
    queryFn: ({ signal }) => api.sharedFolderNavigation(token, signal),
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });
}

export function publicFolderNoteOptions(token: string, noteId: string) {
  return queryOptions({
    queryKey: publicFolderKeys.note(token, noteId),
    queryFn: ({ signal }) => api.sharedFolderNote(token, noteId, signal),
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });
}

export function discardFailedPublicFolderNote(qc: QueryClient, token: string, noteId: string) {
  const query = qc.getQueryCache().find({ queryKey: publicFolderKeys.note(token, noteId), exact: true });
  // Discard a retained sensitive payload without resetting its error or starting
  // another read. resetQueries would automatically retry an active denied note.
  if (query?.state.error && query.state.data !== undefined) query.setState({ data: undefined });
}

export async function clearPublicFolderShare(qc: QueryClient, token: string) {
  const filters = {
    predicate: (query: { queryKey: readonly unknown[] }) =>
      (query.queryKey[0] === 'public-folder-share' && query.queryKey[1] === token) ||
      (query.queryKey[0] === 'board' && query.queryKey[3] === `share:${token}`),
  };
  await qc.cancelQueries(filters);
  qc.removeQueries(filters);
}

export async function refreshPublicFolderNavigation(qc: QueryClient, token: string) {
  const notes = { queryKey: publicFolderKeys.notes(token) };
  await qc.cancelQueries(notes);
  qc.removeQueries(notes);
  await qc.invalidateQueries({ queryKey: publicFolderKeys.navigation(token), exact: true }, { throwOnError: true });
}
