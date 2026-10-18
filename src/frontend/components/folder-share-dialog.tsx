import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Link2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type FolderShareLink } from '../lib/api';
import { CollaboratorAccessList } from './collaborator-access-list';

export function FolderShareDialog({
  folder,
  view,
  open,
  onOpenChange,
}: {
  folder: { id: string };
  view?: 'list' | 'board';
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const {
    data,
    error: loadError,
    isLoading,
  } = useQuery({
    queryKey: ['folder-share-link', folder.id],
    queryFn: () => api.folderShareLink(folder.id),
    enabled: open,
  });

  const create = useMutation<{ shareLink: FolderShareLink }, Error, boolean>({
    mutationFn: (regenerate) => api.createFolderShareLink(folder.id, regenerate),
    onSuccess: ({ shareLink }) => {
      setCreatedUrl(shareLink.url);
      qc.setQueryData(['folder-share-link', folder.id], { shareLink });
    },
  });

  const revoke = useMutation({
    mutationFn: () => api.revokeFolderShareLink(folder.id),
    onSuccess: () => {
      setCreatedUrl(null);
      qc.setQueryData(['folder-share-link', folder.id], { shareLink: null });
    },
  });

  useEffect(() => {
    if (!open) return;
    setCopied(false);
  }, [open]);

  if (!open) return null;

  const shareLink = data?.shareLink ?? null;
  const url = createdUrl ?? shareLink?.url ?? null;
  const linkSharingOn = Boolean(shareLink);
  const copy = async () => {
    let nextUrl = url;
    if (!nextUrl) {
      const result = await create.mutateAsync(false);
      nextUrl = result.shareLink.url;
    }
    if (!nextUrl) return;
    const publicUrl = new URL(nextUrl);
    if (view === 'board') publicUrl.searchParams.set('view', 'board');
    await navigator.clipboard.writeText(publicUrl.toString());
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return createPortal(
    <div className="notes-overlay fixed inset-0 z-[100] grid place-items-center p-4">
      <div className="w-full max-w-2xl overflow-hidden rounded-2xl border border-[var(--notes-border)] bg-[var(--notes-panel)] text-[var(--notes-text)] shadow-xl">
        <div className="flex items-center justify-between gap-3 border-b border-[var(--notes-border)] px-5 py-4">
          <h2 className="text-lg font-semibold">Share folder</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-md p-1.5 text-[var(--notes-muted)] hover:bg-[var(--notes-hover)] hover:text-[var(--notes-text)]"
              onClick={() => onOpenChange(false)}
              aria-label="Close share dialog"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="notes-modal-scroll max-h-[75vh] space-y-6 overflow-y-auto px-5 py-5">
          <section>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--notes-muted)]">Public link</h3>
            <div className="mt-3 space-y-3">
              <label className="inline-flex items-center gap-2 rounded-lg border border-[var(--notes-border)] bg-[var(--notes-bg)] px-3 py-2 text-sm font-medium">
                <Link2 className="h-4 w-4" />
                <select
                  className="bg-transparent outline-none"
                  value={linkSharingOn ? 'read' : 'none'}
                  disabled={isLoading || create.isPending || revoke.isPending}
                  onChange={(event) => {
                    if (event.target.value === 'read') create.mutate(false);
                    else revoke.mutate();
                  }}
                >
                  <option value="none">No link access</option>
                  <option value="read">Anyone with the link can View</option>
                </select>
              </label>
              <p className="notes-muted text-sm">
                {linkSharingOn
                  ? 'This folder is publicly viewable by anyone with the link. Editing is disabled.'
                  : 'Public link access is off. People invited above can still access the folder.'}
              </p>
              {linkSharingOn ? (
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-lg border border-[var(--notes-border)] px-3 py-2 text-sm font-medium hover:bg-[var(--notes-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={isLoading || create.isPending}
                  onClick={() => void copy()}
                >
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {copied ? 'Copied' : 'Copy public link'}
                </button>
              ) : null}
            </div>
          </section>

          <CollaboratorAccessList resourceType="folder" resourceId={folder.id} />

          <div className="rounded-lg border border-[var(--notes-border)] bg-[var(--notes-bg)] px-3 py-3 text-sm text-[var(--notes-muted)]">
            Folder roles apply to existing and future descendants. Public links are anonymous and always read-only.
          </div>

          {loadError ? <p className="text-sm text-red-600">Unable to load current share settings.</p> : null}
          {create.isError ? <p className="text-sm text-red-600">Unable to create share link.</p> : null}
          {revoke.isError ? <p className="text-sm text-red-600">Unable to turn off link access.</p> : null}
        </div>
      </div>
    </div>,
    document.body
  );
}
