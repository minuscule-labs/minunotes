import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute, Link, redirect } from '@tanstack/react-router';
import { ApiKeyAccessDialog } from '../components/api-key-access-dialog';
import { IntegrationActionsMenu } from '../components/integration-actions-menu';
import { OAuthAppsSection } from '../components/oauth-apps-section';
import { Button } from '../components/ui/button';
import { api } from '../lib/api';
import { rootRoute } from './__root';

const showOAuthApps = import.meta.env.VITE_ENABLE_OAUTH_APPS === 'true';

function IntegrationsView() {
  const qc = useQueryClient();
  const folders = useQuery({ queryKey: ['folders'], queryFn: api.folders });
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: api.apiKeys });
  const collaborations = useQuery({ queryKey: ['shared-with-me'], queryFn: api.sharedWithMe });
  const revoke = useMutation({
    mutationFn: api.revokeApiKey,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
  });

  return (
    <section className="mx-auto w-full max-w-5xl">
      <div className="mb-6">
        <Link to="/" className="text-xs text-slate-500 hover:text-slate-900 dark:hover:text-slate-100">
          ← Back to notes
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Integrations</h1>
        <p className="mt-1 text-sm text-slate-500">
          Manage connected apps, API keys, MCP access, and trusted automation.
        </p>
      </div>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">API keys</h2>
          <p className="mt-1 text-sm text-[var(--notes-muted)]">
            Manual tokens for local agents, scripts, MCP stdio, and trusted automation.
          </p>
        </div>
        <ApiKeyAccessDialog
          folders={folders.data?.folders ?? []}
          collaborations={collaborations.data?.collaborations ?? []}
          onSaved={() => qc.invalidateQueries({ queryKey: ['api-keys'] })}
          trigger={(open) => <Button onClick={open}>Create key</Button>}
        />
      </div>
      <div className="overflow-hidden rounded-lg border border-[var(--notes-border)] bg-[var(--notes-panel)]">
        <div className="hidden grid-cols-[1.3fr_0.8fr_1fr_1fr_auto] gap-3 border-b border-[var(--notes-border)] bg-[var(--notes-table-header-bg)] px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-[var(--notes-muted)] md:grid">
          <span>Name</span>
          <span>UID</span>
          <span>Created</span>
          <span>Last used</span>
          <span>Actions</span>
        </div>
        {keys.isLoading ? <p className="p-4 text-sm text-slate-500">Loading keys...</p> : null}
        {(keys.data?.keys ?? []).map((key) => (
          <div
            key={key.id}
            className="grid gap-3 border-b border-[var(--notes-table-row-border)] px-4 py-4 text-sm transition-colors last:border-b-0 hover:bg-[var(--notes-table-row-hover)] md:grid-cols-[1.3fr_0.8fr_1fr_1fr_auto] md:items-center md:py-3"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="truncate font-medium">{key.name}</p>
                {key.revokedAt ? (
                  <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-700 text-xs dark:text-amber-400">
                    Revoked
                  </span>
                ) : null}
              </div>
              <p className="notes-muted mt-0.5 text-xs">
                Shared:{' '}
                {key.sharedAccessMode === 'none'
                  ? 'none'
                  : key.sharedAccessMode === 'all'
                    ? 'all current and future shares'
                    : `${key.collaborationGrantIds.length} selected`}
              </p>
            </div>
            <code className="text-xs text-[var(--notes-muted)]">
              <span className="md:hidden">UID </span>
              {key.uid}
            </code>
            <span className="text-xs text-[var(--notes-muted)]">
              <span className="md:hidden">Created </span>
              {new Date(key.createdAt).toLocaleString()}
            </span>
            <span className="text-xs text-[var(--notes-muted)]">
              <span className="md:hidden">Last used </span>
              {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : 'Never'}
            </span>
            <div className="flex flex-wrap gap-2 md:justify-end">
              <IntegrationActionsMenu
                label={`Actions for API key ${key.name}`}
                access={
                  !key.revokedAt
                    ? {
                        folders: folders.data?.folders ?? [],
                        collaborations: collaborations.data?.collaborations ?? [],
                        apiKey: key,
                        onSaved: () => {
                          void qc.invalidateQueries({ queryKey: ['api-keys'] });
                        },
                      }
                    : undefined
                }
                actions={
                  !key.revokedAt
                    ? [
                        {
                          id: 'revoke-key',
                          label: 'API key',
                          heading: 'Revoke API key?',
                          actionLabel: 'Revoke key',
                          warning: 'This API key will immediately lose access to all folders and cannot be restored.',
                          onConfirm: () => revoke.mutateAsync(key.id),
                        },
                      ]
                    : []
                }
                details={
                  <p className="text-[var(--notes-muted)] text-xs">
                    {key.revokedAt ? 'Revoked' : 'Active'} · {key.uid}
                  </p>
                }
              />
            </div>
          </div>
        ))}
        {keys.data?.keys.length === 0 ? <p className="p-4 text-sm text-slate-500">No agent keys yet.</p> : null}
      </div>

      {showOAuthApps ? (
        <OAuthAppsSection
          folders={folders.data?.folders ?? []}
          collaborations={collaborations.data?.collaborations ?? []}
        />
      ) : null}
    </section>
  );
}

export const integrationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/integrations',
  component: IntegrationsView,
});

export const legacyApiAccessRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/api-access',
  beforeLoad: () => {
    throw redirect({ to: '/integrations', replace: true });
  },
});
