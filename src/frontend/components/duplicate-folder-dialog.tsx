import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type RefObject, useEffect, useId, useRef, useState } from 'react';
import {
  confirmFolderDuplicationPreview,
  type FolderDuplicationRequest,
  type FolderDuplicationResult,
  parseFolderDuplication,
} from '../../shared/folder-duplication';
import { ApiError, api, type Folder } from '../lib/api';
import { authClient } from '../lib/auth-client';
import { FolderDestinationPicker, type FolderNode } from './folder-destination-picker';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { ModalCloseButton } from './ui/modal-close-button';

function amount(count: number, label: string) {
  return `${count} ${label}${count === 1 ? '' : 's'}`;
}
function subtree(source: string, folders: Folder[]) {
  const ids = new Set([source]);
  let height = 0,
    frontier = [source];
  while (frontier.length) {
    const children = folders.filter((row) => row.parentFolderId && frontier.includes(row.parentFolderId));
    if (!children.length) break;
    if (++height > 4 || children.some((row) => ids.has(row.id))) return { ids, height: Infinity };
    frontier = children.map((row) => row.id);
    for (const id of frontier) ids.add(id);
  }
  return { ids, height };
}
export function DuplicateFolderDialog({
  folder,
  open,
  onOpenChange,
  triggerRef,
}: {
  folder: Folder;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const actor = authClient.useSession().data?.user.id;
  const key = actor ? `minunotes:duplicate-folder:${encodeURIComponent(actor)}:${encodeURIComponent(folder.id)}` : '';
  const currentKey = useRef(key);
  currentKey.current = key;
  const initialized = useRef(''),
    lock = useRef(false),
    mounted = useRef(true);
  const memory = useRef<{ key: string; request: FolderDuplicationRequest } | null>(null);
  const [title, setTitle] = useState(''),
    [parent, setParent] = useState<string | null>(folder.parentFolderId);
  const [frozen, setFrozen] = useState<FolderDuplicationRequest | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [storageWarning, setStorageWarning] = useState(false),
    [blocked, setBlocked] = useState(false),
    [previewRevision, setPreviewRevision] = useState(0),
    [legacyReview, setLegacyReview] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null),
    submitRef = useRef<HTMLButtonElement>(null);
  const qc = useQueryClient(),
    nav = useNavigate(),
    nameId = useId();
  const tree = useQuery({
    queryKey: ['folders', 'duplicate', actor],
    queryFn: api.folders,
    enabled: open && !!actor,
    retry: false,
  });
  const folders = open ? (tree.data?.folders ?? []) : [];
  const source = open ? subtree(folder.id, folders) : { ids: new Set([folder.id]), height: 0 };
  const disabledReason = (node: FolderNode) =>
    source.ids.has(node.id)
      ? 'Choose a destination outside the source folder'
      : node.effectivePrivate
        ? 'Cannot create subfolders under a private folder'
        : node.depth + 1 + source.height > 4
          ? 'Maximum folder depth reached'
          : null;
  function parentReason(id: string | null) {
    if (!id) return source.height > 4 ? 'Maximum folder depth reached' : null;
    const byId = new Map(folders.map((row) => [row.id, row]));
    let row = byId.get(id),
      depth = 0;
    const seen = new Set<string>();
    if (!row) return 'Destination folder is unavailable';
    while (row) {
      if (seen.has(row.id)) return 'Invalid destination hierarchy';
      seen.add(row.id);
      if (source.ids.has(row.id)) return 'Choose a destination outside the source folder';
      if (row.isPrivate) return 'Cannot create subfolders under a private folder';
      if (!row.parentFolderId) break;
      row = byId.get(row.parentFolderId);
      if (!row) return 'Destination folder is unavailable';
      depth++;
    }
    return depth + 1 + source.height > 4 ? 'Maximum folder depth reached' : null;
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!open) {
      initialized.current = '';
      return;
    }
    if (!key || initialized.current === key) return;
    initialized.current = key;
    setError('');
    setBlocked(false);
    setLegacyReview(false);
    setStorageWarning(false);
    setBusy(false);
    lock.current = false;
    let saved: FolderDuplicationRequest | null = memory.current?.key === key ? memory.current.request : null;
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(key);
    } catch {
      setStorageWarning(true);
    }
    if (raw) {
      try {
        const value = JSON.parse(raw);
        if (value.source !== folder.id || value.actor !== actor) throw new Error('Wrong saved scope');
        saved = parseFolderDuplication(value.request);
      } catch {
        if (!saved) {
          setBlocked(true);
          setError(
            'The saved request cannot be read. Check your folders before starting another copy; this attempt has not been discarded.'
          );
        }
      }
    }
    setFrozen(saved);
    setTitle(saved?.title ?? [...`${folder.title} copy`].slice(0, 200).join(''));
    setParent(saved ? saved.parentFolderId : folder.parentFolderId);
    if (saved) {
      memory.current = { key, request: saved };
      setError('A previous attempt could not be confirmed. Retry the same duplication.');
    }
  }, [open, key, folder.id, folder.title, folder.parentFolderId, actor]);
  // Choose Root only for an untouched default; never replace a restored uncertain request's destination.
  const defaultChecked = useRef('');
  useEffect(() => {
    if (!open) {
      defaultChecked.current = '';
      return;
    }
    if (!tree.data || !key || defaultChecked.current === key) return;
    defaultChecked.current = key;
    if (!memory.current && parentReason(folder.parentFolderId)) setParent(null);
  }, [open, tree.data, key, folder.parentFolderId, parentReason]);
  const clearSaved = () => {
    memory.current = null;
    setFrozen(null);
    setLegacyReview(false);
    try {
      sessionStorage.removeItem(key);
    } catch {
      setStorageWarning(true);
    }
  };
  const submit = async () => {
    if (lock.current || !actor || blocked) return;
    if ((!frozen || legacyReview) && !previewReady) return;
    let request: FolderDuplicationRequest;
    try {
      request =
        frozen && !legacyReview
          ? frozen
          : parseFolderDuplication({
              title,
              parentFolderId: parent,
              requestId: frozen?.requestId ?? crypto.randomUUID(),
              previewToken: preview.data?.token,
            });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid duplication');
      return;
    }
    const captured = key;
    lock.current = true;
    setBusy(true);
    setLegacyReview(false);
    setError('');
    setFrozen(request);
    memory.current = { key, request };
    try {
      sessionStorage.setItem(key, JSON.stringify({ actor, source: folder.id, request }));
    } catch {
      setStorageWarning(true);
    }
    let result: FolderDuplicationResult;
    try {
      result = await api.duplicateFolder(folder.id, request);
      if (
        !result?.folder?.id ||
        result.folder.id === folder.id ||
        typeof result.replayed !== 'boolean' ||
        !result.counts
      )
        throw new Error('Duplication was not confirmed');
    } catch (err) {
      if (!mounted.current || currentKey.current !== captured) return;
      if (err instanceof ApiError && err.status === 428 && !request.previewToken) {
        // Explicit legacy handoff: retain its stored payload/ID until the user reviews and confirms.
        setLegacyReview(true);
      } else if (err instanceof ApiError && err.status >= 400 && err.status < 500 && ![408, 429].includes(err.status)) {
        if (frozen) {
          // A failed retry is not proof that the earlier attempt failed. Never discard its ID.
          if ([409, 413, 428].includes(err.status)) setLegacyReview(true);
        } else clearSaved();
        if ([401, 403, 404].includes(err.status)) setBlocked(true);
      }
      // A new query key discards the stale confirmation and makes one read-only check.
      // It never resubmits a copy or changes the saved request before explicit confirmation.
      if (err instanceof ApiError && [409, 413, 428].includes(err.status)) setPreviewRevision((value) => value + 1);
      setError(err instanceof Error ? err.message : 'Duplication could not be confirmed. Retry the unchanged request.');
      setBusy(false);
      lock.current = false;
      return;
    }
    if (!mounted.current || currentKey.current !== captured) return;
    clearSaved();
    setBusy(false);
    lock.current = false;
    onOpenChange(false);
    await Promise.allSettled(
      ['folders', 'notes', 'templates', 'folder-templates', 'tags', 'recent-notes'].map((prefix) =>
        qc.invalidateQueries({ queryKey: [prefix] })
      )
    );
    if (request.parentFolderId) void qc.invalidateQueries({ queryKey: ['folder-detail', request.parentFolderId] });
    if (mounted.current && currentKey.current === captured)
      void nav({ to: '/folders/$folderId', params: { folderId: result.folder.id }, search: {} });
  };
  const close = () => {
    if (!lock.current) onOpenChange(false);
  };
  const invalidParent = parentReason(parent);
  const preview = useQuery({
    queryKey: ['folder-duplicate-preview', actor, folder.id, parent, previewRevision],
    queryFn: async ({ signal }) =>
      confirmFolderDuplicationPreview(await api.previewFolderDuplication(folder.id, parent, signal), folder.id, parent),
    enabled: open && !!actor && !blocked && tree.isSuccess && !invalidParent && (!frozen || legacyReview),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const previewReady =
    !!preview.data &&
    preview.data.sourceFolderId === folder.id &&
    preview.data.parentFolderId === parent &&
    !preview.isFetching &&
    !preview.error &&
    tree.isSuccess &&
    !invalidParent;
  useEffect(() => {
    if (open && frozen && !busy && (!legacyReview || previewReady)) submitRef.current?.focus();
  }, [open, frozen, busy, legacyReview, previewReady]);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className="inset-x-4 top-1/2 max-h-[calc(100dvh-2rem)] -translate-y-1/2 overflow-y-auto rounded-lg p-4 sm:left-1/2 sm:w-[min(30rem,calc(100vw-2rem))] sm:-translate-x-1/2 sm:p-5"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (frozen ? submitRef.current : nameRef.current)?.focus();
        }}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          triggerRef.current?.focus();
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <DialogTitle className="font-semibold text-lg">Duplicate folder</DialogTitle>
          <ModalCloseButton label="Close duplicate folder" disabled={busy} onClick={close} />
        </div>
        <form
          className="mt-4 space-y-4"
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div>
            <label htmlFor={nameId} className="font-medium text-sm">
              Folder name
            </label>
            <input
              autoComplete="off"
              id={nameId}
              ref={nameRef}
              className="notes-input mt-1 w-full rounded-md px-3 py-2"
              value={title}
              disabled={busy || !!frozen}
              maxLength={400}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div>
            <p className="mb-2 font-medium text-sm">Destination</p>
            <fieldset disabled={busy || !!frozen} className="min-w-0">
              <legend className="sr-only">Destination folder</legend>
              <FolderDestinationPicker
                folders={folders}
                currentFolderId={parent}
                onCurrentFolderIdChange={(id) => {
                  setParent(id);
                  setError('');
                }}
                allowTopLevel={source.height <= 4}
                getDisabledReason={disabledReason}
              />
            </fieldset>
          </div>
          {tree.isPending ? <p role="status">Loading folders…</p> : null}
          {tree.error ? (
            <p role="alert">
              Destinations could not be loaded.{' '}
              <Button type="button" onClick={() => tree.refetch()}>
                Retry destinations
              </Button>
            </p>
          ) : null}
          {!frozen && invalidParent ? (
            <p role="status" className="text-[var(--notes-muted)] text-sm">
              {invalidParent}
            </p>
          ) : null}
          <fieldset className="rounded-md border border-[var(--notes-border)] p-3 text-sm">
            <legend className="sr-only">Copy summary</legend>
            <p className="font-medium" aria-hidden="true">
              Copy summary
            </p>
            {frozen && legacyReview ? (
              <p className="mt-2 text-[var(--notes-muted)]">
                The earlier copy may already exist. Reviewing this summary keeps the same request; confirmation resumes
                or finds that copy, never starts a second attempt.
              </p>
            ) : null}
            {frozen && !legacyReview ? (
              <p className="mt-2" role="status">
                Retrying the previously confirmed attempt with its original request.
              </p>
            ) : preview.isFetching || preview.isPending ? (
              <p className="mt-2" role="status">
                Checking copy size…
              </p>
            ) : preview.error ? (
              <p className="mt-2" role="alert">
                {preview.error instanceof Error ? preview.error.message : 'Copy summary could not be loaded.'}
              </p>
            ) : (
              <p className="mt-2" role="status">
                {amount(preview.data.counts.notes, 'note')} · {amount(preview.data.counts.templates, 'template')} ·{' '}
                {amount(preview.data.counts.folders - 1, 'subfolder')}
                <br />
                {amount(preview.data.counts.attachments, 'uploaded image')} ·{' '}
                {(preview.data.imageBytes / (1024 * 1024)).toLocaleString(undefined, { maximumFractionDigits: 2 })} MB
                total
              </p>
            )}
          </fieldset>
          {storageWarning ? (
            <p role="status" className="text-[var(--notes-muted)] text-sm">
              This browser cannot save the pending request. Keep this dialog available until the result is confirmed;
              after a reload, check your folders before starting another copy.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-red-600 text-sm dark:text-red-400">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              ref={submitRef}
              disabled={
                busy ||
                blocked ||
                !actor ||
                ((!frozen || legacyReview) &&
                  (!previewReady ||
                    tree.isPending ||
                    !!tree.error ||
                    !!invalidParent ||
                    !title.trim() ||
                    [...title.trim()].length > 200))
              }
            >
              {busy
                ? 'Duplicating…'
                : legacyReview
                  ? 'Continue same duplication'
                  : frozen
                    ? 'Retry duplication'
                    : 'Duplicate folder'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
