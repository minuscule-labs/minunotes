import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/frontend/lib/api';
import {
  clearPublicFolderShare,
  discardFailedPublicFolderNote,
  publicFolderKeys,
  publicFolderNavigationOptions,
  publicFolderNoteOptions,
  refreshPublicFolderNavigation,
} from '../src/frontend/lib/public-folder-share';

const clients: QueryClient[] = [];
const detail = {
  note: {
    id: 'note_a',
    folderId: 'folder',
    title: 'A',
    content: 'secret',
    documentType: 'markdown' as const,
    updatedAt: '2026-10-26',
  },
  resolutions: [],
};
const navigation = {
  folder: { id: 'folder', title: 'Folder', updatedAt: '2026-10-26' },
  folders: [],
  notes: [],
  share: { id: 'share', permission: 'read' as const, createdAt: '2026-10-26' },
};
const client = () => {
  const qc = new QueryClient();
  clients.push(qc);
  return qc;
};
afterEach(() => {
  for (const qc of clients.splice(0)) qc.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('encodes compact paths and consumes an abort signal with no-store HTTP requests', async () => {
  const fetch = vi
    .fn()
    .mockImplementation(
      async () => new Response(JSON.stringify(navigation), { headers: { 'content-type': 'application/json' } })
    );
  vi.stubGlobal('fetch', fetch);
  const abort = new AbortController();
  await api.sharedFolderNavigation('a/b', abort.signal);
  await api.sharedFolderNote('a/b', 'note/a', abort.signal);
  expect(fetch.mock.calls[0][0]).toMatch(/\/share\/folders\/a%2Fb\/navigation$/);
  expect(fetch.mock.calls[1][0]).toMatch(/\/share\/folders\/a%2Fb\/notes\/note%2Fa$/);
  for (const call of fetch.mock.calls) expect(call[1]).toMatchObject({ cache: 'no-store', signal: abort.signal });
});

it('collects inactive bodies and fetches freshly on a reopened selection', async () => {
  const qc = client();
  const read = vi.spyOn(api, 'sharedFolderNote').mockResolvedValue(detail);
  const observer = new QueryObserver(qc, publicFolderNoteOptions('token', 'note_a'));
  const stop = observer.subscribe(() => {});
  await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));
  stop();
  await vi.waitFor(() => expect(qc.getQueryData(publicFolderKeys.note('token', 'note_a'))).toBeUndefined());
  const next = new QueryObserver(qc, publicFolderNoteOptions('token', 'note_a'));
  const stopNext = next.subscribe(() => {});
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  stopNext();
});

it('discards a failed revalidation payload without retrying or clearing its denial', async () => {
  const qc = client();
  const denied = new ApiError('Not found', 404);
  const read = vi.spyOn(api, 'sharedFolderNote').mockResolvedValueOnce(detail).mockRejectedValue(denied);
  const options = publicFolderNoteOptions('token', 'note_a');
  await qc.fetchQuery(options);
  await expect(qc.fetchQuery(options)).rejects.toBe(denied);
  discardFailedPublicFolderNote(qc, 'token', 'note_a');
  expect(qc.getQueryState(options.queryKey)).toMatchObject({ data: undefined, error: denied, status: 'error' });
  expect(read).toHaveBeenCalledTimes(2);
});

it('cancels old reads before purging only the denied token, ignoring late results', async () => {
  const qc = client();
  let release!: (value: typeof detail) => void;
  let signal: AbortSignal | undefined;
  vi.spyOn(api, 'sharedFolderNote').mockImplementation((_token, _id, inputSignal) => {
    signal = inputSignal;
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const pending = qc.fetchQuery(publicFolderNoteOptions('token-a', 'note_a')).catch(() => undefined);
  qc.setQueryData(publicFolderKeys.note('token-b', 'note_a'), detail);
  qc.setQueryData(['board', 'folder', 'config', 'share:token-a'], { board: 'old' });
  qc.setQueryData(['board', 'folder', 'config', 'owner'], { board: 'private' });
  await clearPublicFolderShare(qc, 'token-a');
  expect(signal?.aborted).toBe(true);
  release(detail);
  await pending;
  expect(qc.getQueryData(publicFolderKeys.note('token-a', 'note_a'))).toBeUndefined();
  expect(qc.getQueryData(['board', 'folder', 'config', 'share:token-a'])).toBeUndefined();
  expect(qc.getQueryData(publicFolderKeys.note('token-b', 'note_a'))).toEqual(detail);
  expect(qc.getQueryData(['board', 'folder', 'config', 'owner'])).toEqual({ board: 'private' });
});

it('refreshes metadata alone without retrieving a body or the legacy snapshot', async () => {
  const qc = client();
  const metadata = vi.spyOn(api, 'sharedFolderNavigation').mockResolvedValue(navigation);
  const body = vi.spyOn(api, 'sharedFolderNote');
  const legacy = vi.spyOn(api, 'sharedFolder');
  const observer = new QueryObserver(qc, publicFolderNavigationOptions('token'));
  const stop = observer.subscribe(() => {});
  await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));
  qc.setQueryData(publicFolderKeys.note('token', 'note_a'), detail);
  await refreshPublicFolderNavigation(qc, 'token');
  expect(metadata).toHaveBeenCalledTimes(2);
  expect(body).not.toHaveBeenCalled();
  expect(legacy).not.toHaveBeenCalled();
  expect(qc.getQueryData(publicFolderKeys.note('token', 'note_a'))).toBeUndefined();
  stop();
});
