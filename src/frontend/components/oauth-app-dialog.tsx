import { useMutation } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, api, type OAuthClient } from '../lib/api';
import { CopyClientIdButton } from './copy-client-id-button';
import { Button } from './ui/button';

type AppMode = 'picker' | 'custom';

export function OAuthAppDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (client: OAuthClient) => void;
}) {
  const [mode, setMode] = useState<AppMode>('picker');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [redirectUris, setRedirectUris] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<OAuthClient | null>(null);

  useEffect(() => {
    if (!open) return;
    setMode('picker');
    setName('');
    setDescription('');
    setRedirectUris('');
    setError(null);
    setCreated(null);
  }, [open]);

  const create = useMutation({
    mutationFn: () =>
      api.createOAuthClient({
        name,
        description: description || null,
        redirectUris: redirectUris
          .split(/\r?\n|,/)
          .map((uri) => uri.trim())
          .filter(Boolean),
      }),
    onSuccess: ({ client }) => {
      setCreated(client);
      onCreated(client);
    },
    onError: (error) => setError(error instanceof ApiError ? error.message : 'Unable to create app'),
  });

  const chooseCustom = (preset?: 'mcp') => {
    setMode('custom');
    if (preset === 'mcp') {
      setName('MCP client');
      setDescription('Hosted MCP client using OAuth');
    }
  };

  if (!open) return null;

  return createPortal(
    <div className="notes-overlay fixed inset-0 z-[100] grid place-items-center p-4">
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-[var(--notes-border)] bg-[var(--notes-panel)] text-[var(--notes-text)] shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-[var(--notes-border)] px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold">Add app</h2>
            <p className="notes-muted mt-1 text-xs">
              Connect a known app or create a custom OAuth app for an integration.
            </p>
          </div>
          <button
            type="button"
            className="rounded-md p-1.5 text-[var(--notes-muted)] hover:bg-[var(--notes-hover)] hover:text-[var(--notes-text)]"
            onClick={() => onOpenChange(false)}
            aria-label="Close add app dialog"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-5">
          {created ? (
            <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-950 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-100">
              <p className="font-semibold">App created</p>
              <p className="mt-2">Client ID:</p>
              <code className="mt-1 block break-all rounded bg-white/70 p-2 text-xs dark:bg-black/20">
                {created.id}
              </code>
              <CopyClientIdButton clientId={created.id} />
              <p className="mt-2 text-xs">
                Use Authorization Code + PKCE. No client secret is issued for public clients.
              </p>
            </div>
          ) : null}

          {!created && mode === 'picker' ? (
            <div className="grid gap-3">
              <button
                type="button"
                className="rounded-xl border border-[var(--notes-border)] bg-[var(--notes-bg)] p-4 text-left hover:bg-[var(--notes-hover)]"
                onClick={() => chooseCustom('mcp')}
              >
                <p className="font-semibold">Hosted MCP client</p>
                <p className="notes-muted mt-1 text-sm">
                  Create an OAuth app for an MCP client that supports bearer auth.
                </p>
              </button>
              <button
                type="button"
                className="rounded-xl border border-[var(--notes-border)] bg-[var(--notes-bg)] p-4 text-left hover:bg-[var(--notes-hover)]"
                onClick={() => chooseCustom()}
              >
                <p className="font-semibold">Custom app</p>
                <p className="notes-muted mt-1 text-sm">
                  Create a custom public PKCE OAuth app with your own redirect URI.
                </p>
              </button>
            </div>
          ) : null}

          {!created && mode === 'custom' ? (
            <>
              <label className="block text-sm font-medium">
                App name
                <input
                  className="mt-1 w-full rounded-md border border-[var(--notes-input-border)] bg-[var(--notes-input-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--notes-ring)]"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="My integration"
                />
              </label>
              <label className="block text-sm font-medium">
                Description
                <input
                  className="mt-1 w-full rounded-md border border-[var(--notes-input-border)] bg-[var(--notes-input-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--notes-ring)]"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Optional"
                />
              </label>
              <label className="block text-sm font-medium">
                Redirect URI
                <textarea
                  className="mt-1 min-h-24 w-full rounded-md border border-[var(--notes-input-border)] bg-[var(--notes-input-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--notes-ring)]"
                  value={redirectUris}
                  onChange={(event) => setRedirectUris(event.target.value)}
                  placeholder="https://example.com/oauth/callback"
                />
                <span className="notes-muted mt-1 block text-xs">
                  One per line, or comma-separated. HTTPS required except localhost.
                </span>
              </label>
              {error ? (
                <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200">
                  {error}
                </p>
              ) : null}
            </>
          ) : null}
        </div>

        <div className="flex justify-between gap-2 border-t border-[var(--notes-border)] px-5 py-4">
          <div>{!created && mode === 'custom' ? <Button onClick={() => setMode('picker')}>Back</Button> : null}</div>
          <div className="flex gap-2">
            <Button onClick={() => onOpenChange(false)}>{created ? 'Done' : 'Cancel'}</Button>
            {!created && mode === 'custom' ? (
              <Button
                variant="base"
                disabled={create.isPending || !name.trim() || !redirectUris.trim()}
                onClick={() => create.mutate()}
              >
                {create.isPending ? 'Creating...' : 'Create app'}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
