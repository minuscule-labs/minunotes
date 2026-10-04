import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Folder, type OAuthAuthorization, type OAuthClient, type SharedCollaboration } from '../lib/api';
import { CopyClientIdButton } from './copy-client-id-button';
import { IntegrationActionsMenu } from './integration-actions-menu';
import { OAuthAppDialog } from './oauth-app-dialog';
import { Button } from './ui/button';

export type OAuthAppGroup = {
  client: OAuthClient;
  canManageRegistration: boolean;
  authorizations: OAuthAuthorization[];
};

export function groupOAuthApps(clients: OAuthClient[], authorizations: OAuthAuthorization[]): OAuthAppGroup[] {
  const groups = new Map<string, OAuthAppGroup>(
    clients.map((client) => [
      client.id,
      {
        client,
        canManageRegistration: true,
        authorizations: [],
      },
    ])
  );
  for (const authorization of authorizations) {
    let group = groups.get(authorization.clientId);
    if (!group) {
      group = { client: authorization.client, canManageRegistration: false, authorizations: [] };
      groups.set(authorization.clientId, group);
    }
    group.authorizations.push(authorization);
  }
  return [...groups.values()];
}

export function oauthAppStatus(group: OAuthAppGroup): 'Registered' | 'Connected' | 'Revoked' {
  if (group.client.revokedAt) return 'Revoked';
  if (group.authorizations.some((authorization) => !authorization.revokedAt)) return 'Connected';
  return group.authorizations.length > 0 ? 'Revoked' : 'Registered';
}

export function oauthAppLastUsed(group: OAuthAppGroup): string | null {
  return group.authorizations.reduce<string | null>((latest, authorization) => {
    const used = authorization.lastUsedAt;
    return used && (!latest || new Date(used) > new Date(latest)) ? used : latest;
  }, null);
}

function StatusBadge({ status }: { status: 'Registered' | 'Connected' | 'Revoked' }) {
  return (
    <span
      className={`inline-flex shrink-0 rounded px-1.5 py-0.5 font-medium text-xs ${
        status === 'Connected'
          ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
          : status === 'Revoked'
            ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
            : 'bg-slate-500/10 text-[var(--notes-muted)]'
      }`}
    >
      {status}
    </span>
  );
}

function AccessSummary({ authorization }: { authorization: OAuthAuthorization }) {
  const count = authorization.permissions.length;
  const access =
    authorization.accessMode === 'all'
      ? 'All non-private folders'
      : authorization.accessMode === 'top_level'
        ? `${count} project root${count === 1 ? '' : 's'}`
        : `${count} specific folder${count === 1 ? '' : 's'}`;
  const shares = authorization.collaborationGrantIds.length;
  const sharedAccess =
    authorization.sharedAccessMode === 'none'
      ? 'No shared content'
      : authorization.sharedAccessMode === 'all'
        ? 'All current and future shares'
        : `${shares} selected share${shares === 1 ? '' : 's'}`;
  const permissions =
    [
      authorization.canRead ? 'Read' : null,
      authorization.canCreate ? 'Create' : null,
      authorization.canComment ? 'Comment' : null,
      authorization.canEdit ? 'Edit' : null,
      authorization.canCreateFolders ? 'Create folders' : null,
    ]
      .filter(Boolean)
      .join(' · ') || 'No permissions';
  return (
    <div className="text-[var(--notes-muted)] text-xs">
      <p>{access}</p>
      <p>{sharedAccess}</p>
      <p>{permissions}</p>
    </div>
  );
}

function disconnectAction(authorization: OAuthAuthorization, onDisconnect: (id: string) => Promise<unknown>) {
  return {
    id: 'disconnect',
    label: 'connection',
    heading: 'Disconnect app?',
    actionLabel: 'Disconnect',
    requiresTypedConfirmation: false,
    warning:
      'This connection will immediately lose access to MinuNotes. Its existing tokens will stop working; the app registration and other connections are unchanged.',
    onConfirm: () => onDisconnect(authorization.id),
  };
}

function ConnectionActions({
  authorization,
  clientRevoked,
  folders,
  collaborations,
  onSaved,
  onDisconnect,
}: {
  authorization: OAuthAuthorization;
  clientRevoked: boolean;
  folders: Folder[];
  collaborations: SharedCollaboration[];
  onSaved: () => void;
  onDisconnect: (id: string) => Promise<unknown>;
}) {
  const active = !authorization.revokedAt && !clientRevoked;
  return (
    <IntegrationActionsMenu
      label={`Actions for connection ${authorization.id}`}
      access={active ? { folders, collaborations, oauthAuthorization: authorization, onSaved } : undefined}
      actions={active ? [disconnectAction(authorization, onDisconnect)] : []}
      details={
        <p className="text-[var(--notes-muted)] text-xs">
          {active ? 'Connected' : 'Revoked'} · {authorization.id}
        </p>
      }
    />
  );
}

export function OAuthAppsSection({
  folders,
  collaborations,
}: {
  folders: Folder[];
  collaborations: SharedCollaboration[];
}) {
  const qc = useQueryClient();
  const [appOpen, setAppOpen] = useState(false);
  const clients = useQuery({ queryKey: ['oauth-clients'], queryFn: api.oauthClients });
  const connections = useQuery({ queryKey: ['oauth-authorizations'], queryFn: api.oauthAuthorizations });
  const invalidateConnections = () => {
    void qc.invalidateQueries({ queryKey: ['oauth-authorizations'] });
  };
  const disconnect = useMutation({ mutationFn: api.revokeOAuthAuthorization, onSuccess: invalidateConnections });
  const revokeClient = useMutation({
    mutationFn: api.revokeOAuthClient,
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['oauth-clients'] }),
        qc.invalidateQueries({ queryKey: ['oauth-authorizations'] }),
      ]);
    },
  });
  const groups = groupOAuthApps(clients.data?.clients ?? [], connections.data?.authorizations ?? []);
  const loading = clients.isLoading || connections.isLoading;
  const error = clients.error ?? connections.error;

  return (
    <>
      <div className="mt-8 mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="font-semibold text-lg">Apps</h2>
          <p className="mt-1 text-[var(--notes-muted)] text-sm">Registered OAuth apps and their access to MinuNotes.</p>
        </div>
        <Button onClick={() => setAppOpen(true)}>Add App</Button>
      </div>
      <div className="overflow-hidden rounded-lg border border-[var(--notes-border)] bg-[var(--notes-panel)]">
        <div className="hidden grid-cols-[1.2fr_1.3fr_0.8fr_3rem] gap-3 border-[var(--notes-border)] border-b bg-[var(--notes-table-header-bg)] px-4 py-2.5 font-medium text-[var(--notes-muted)] text-xs uppercase tracking-wide md:grid">
          <span>App</span>
          <span>Access</span>
          <span>Last used</span>
          <span className="text-right">Actions</span>
        </div>
        {loading ? (
          <p className="p-4 text-[var(--notes-muted)] text-sm">Loading apps...</p>
        ) : error ? (
          <div className="space-y-2 p-4">
            <p role="alert" className="text-red-600 text-sm">
              Unable to load apps. Registration and connection status could not be confirmed.
            </p>
            <Button
              onClick={() => {
                void clients.refetch();
                void connections.refetch();
              }}
            >
              Retry
            </Button>
          </div>
        ) : groups.length === 0 ? (
          <p className="p-4 text-[var(--notes-muted)] text-sm">No apps yet.</p>
        ) : (
          groups.map((group) => {
            const { client, authorizations } = group;
            const status = oauthAppStatus(group);
            const lastUsed = oauthAppLastUsed(group);
            const single = authorizations.length === 1 ? authorizations[0] : undefined;
            const activeCount = authorizations.filter(
              (authorization) => !authorization.revokedAt && !client.revokedAt
            ).length;
            return (
              <div
                key={client.id}
                data-testid="oauth-app-row"
                className="border-[var(--notes-table-row-border)] border-b px-4 py-4 text-sm last:border-b-0 md:py-3"
              >
                <div className="grid gap-3 md:grid-cols-[1.2fr_1.3fr_0.8fr_3rem] md:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="min-w-0 break-words font-medium">{client.name}</p>
                      <StatusBadge status={status} />
                    </div>
                    {client.description ? (
                      <p className="notes-muted mt-0.5 truncate text-xs">{client.description}</p>
                    ) : null}
                    <p className="notes-muted mt-1 text-xs">
                      {single
                        ? `Connected ${new Date(single.createdAt).toLocaleString()}`
                        : `Registered ${new Date(client.createdAt).toLocaleString()}`}
                    </p>
                  </div>
                  <div>
                    {single && status === 'Connected' ? (
                      <AccessSummary authorization={single} />
                    ) : (
                      <p className="text-[var(--notes-muted)] text-xs">
                        {authorizations.length > 1
                          ? `${activeCount} active · ${authorizations.length} total connections`
                          : status === 'Revoked'
                            ? 'No active access'
                            : 'Not connected'}
                      </p>
                    )}
                  </div>
                  <p className="text-[var(--notes-muted)] text-xs">
                    <span className="md:hidden">Last used: </span>
                    {lastUsed ? new Date(lastUsed).toLocaleString() : 'Never'}
                  </p>
                  <div className="flex flex-wrap gap-2 md:justify-end">
                    <IntegrationActionsMenu
                      label={`App details and actions for ${client.name}`}
                      access={
                        single && status === 'Connected'
                          ? {
                              folders,
                              collaborations,
                              oauthAuthorization: single,
                              onSaved: invalidateConnections,
                            }
                          : undefined
                      }
                      actions={[
                        ...(single && status === 'Connected'
                          ? [disconnectAction(single, (id) => disconnect.mutateAsync(id))]
                          : []),
                        ...(group.canManageRegistration && !client.revokedAt
                          ? [
                              {
                                id: 'revoke-app',
                                label: 'app registration',
                                heading: 'Revoke app registration?',
                                actionLabel: 'Revoke app',
                                warning:
                                  'This app registration and all of its connections will be revoked. All existing tokens for this app will stop working.',
                                onConfirm: () => revokeClient.mutateAsync(client.id),
                              },
                            ]
                          : []),
                      ]}
                      details={
                        <>
                          <div className="flex items-center justify-between gap-2">
                            <p className="font-medium text-sm">App registration</p>
                            <StatusBadge status={client.revokedAt ? 'Revoked' : 'Registered'} />
                          </div>
                          <p className="mt-2 text-[var(--notes-muted)] text-xs">Client ID</p>
                          <code className="block break-all text-xs">{client.id}</code>
                          <CopyClientIdButton clientId={client.id} />
                          <p className="mt-2 text-[var(--notes-muted)] text-xs">
                            Created {new Date(client.createdAt).toLocaleString()}
                          </p>
                        </>
                      }
                    />
                  </div>
                </div>
                {authorizations.length > 1 ? (
                  <details className="mt-3 border-[var(--notes-border)] border-t pt-3">
                    <summary className="cursor-pointer text-[var(--notes-muted)] text-xs">
                      {authorizations.length} connections
                    </summary>
                    <div className="mt-2 space-y-3">
                      {authorizations.map((authorization, index) => (
                        <div
                          key={authorization.id}
                          data-testid="oauth-connection-row"
                          className="grid gap-3 rounded-md border border-[var(--notes-border)] p-3 md:grid-cols-[1fr_1fr_auto] md:items-center"
                        >
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="font-medium text-xs">Connection {index + 1}</p>
                              <StatusBadge
                                status={authorization.revokedAt || client.revokedAt ? 'Revoked' : 'Connected'}
                              />
                            </div>
                            <p className="notes-muted mt-1 text-xs">
                              Connected {new Date(authorization.createdAt).toLocaleString()}
                            </p>
                            <p className="notes-muted mt-1 text-xs">
                              Last used:{' '}
                              {authorization.lastUsedAt ? new Date(authorization.lastUsedAt).toLocaleString() : 'Never'}
                            </p>
                          </div>
                          <AccessSummary authorization={authorization} />
                          <div className="flex flex-wrap gap-2 md:justify-end">
                            <ConnectionActions
                              authorization={authorization}
                              clientRevoked={!!client.revokedAt}
                              folders={folders}
                              collaborations={collaborations}
                              onSaved={invalidateConnections}
                              onDisconnect={(id) => disconnect.mutateAsync(id)}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </details>
                ) : null}
              </div>
            );
          })
        )}
      </div>
      <OAuthAppDialog
        open={appOpen}
        onOpenChange={setAppOpen}
        onCreated={() => {
          void qc.invalidateQueries({ queryKey: ['oauth-clients'] });
        }}
      />
    </>
  );
}
