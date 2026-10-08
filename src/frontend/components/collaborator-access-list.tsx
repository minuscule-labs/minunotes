import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, RefreshCw, UserPlus, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { api, type CollaborationIdentity, type CollaborationResourceType, type CollaborationRole } from '../lib/api';
import { Avatar } from './ui/avatar';

const ROLE_LABELS: Record<CollaborationRole, string> = {
  viewer: 'Viewer',
  commenter: 'Commenter',
  editor: 'Editor',
};

export function CollaboratorAccessList({
  resourceType,
  resourceId,
}: {
  resourceType: CollaborationResourceType;
  resourceId: string;
}) {
  const queryClient = useQueryClient();
  const queryKey = ['collaborators', resourceType, resourceId];
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<CollaborationRole>('viewer');
  const [invitationUrl, setInvitationUrl] = useState<string | null>(null);
  const [invitationCopied, setInvitationCopied] = useState(false);
  const [deliveryMessage, setDeliveryMessage] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => api.resourceCollaborators(resourceType, resourceId),
  });
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey }),
      ...(resourceType === 'folder'
        ? [
            queryClient.invalidateQueries({ queryKey: ['shared-folder-navigation-roots'] }),
            queryClient.invalidateQueries({ queryKey: ['shared-folder-navigation-children'] }),
          ]
        : []),
    ]);
  const add = useMutation({
    mutationFn: () => api.addResourceCollaborator(resourceType, resourceId, { email: email.trim(), role }),
    onSuccess: (result) => {
      setEmail('');
      setInvitationCopied(false);
      setInvitationUrl(result.kind === 'invitation' ? result.invitation.invitationUrl : null);
      setDeliveryMessage(
        result.emailDelivery === 'sent'
          ? 'Email sent.'
          : result.kind === 'invitation'
            ? 'Email delivery is unavailable. Copy and send the invitation link below.'
            : 'Access was granted. Email delivery is unavailable.'
      );
      void refresh();
    },
  });
  const update = useMutation({
    mutationFn: ({ accessKey, nextRole }: { accessKey: string; nextRole: CollaborationRole }) =>
      api.updateResourceCollaborator(resourceType, resourceId, accessKey, nextRole),
    onSuccess: () => void refresh(),
  });
  const remove = useMutation({
    mutationFn: (accessKey: string) => api.removeResourceCollaborator(resourceType, resourceId, accessKey),
    onSuccess: () => void refresh(),
  });
  const resendInvitation = useMutation({
    mutationFn: (invitationId: string) => api.resendCollaborationInvitation(invitationId),
    onSuccess: (result) => {
      setInvitationCopied(false);
      setInvitationUrl(result.invitation.invitationUrl);
      setDeliveryMessage(
        result.emailDelivery === 'sent'
          ? 'A new invitation link was emailed.'
          : 'Email delivery is unavailable. Copy and send the new invitation link below.'
      );
      void refresh();
    },
  });
  const revokeInvitation = useMutation({
    mutationFn: (invitationId: string) => api.revokeCollaborationInvitation(invitationId),
    onSuccess: () => void refresh(),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (email.trim()) add.mutate();
  };
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--notes-muted)]">People with access</h3>
        <p className="notes-muted mt-1 text-xs">Invite people directly. Public link access is managed separately.</p>
      </div>

      <form className="flex flex-col gap-2 sm:flex-row" onSubmit={submit}>
        <input
          className="min-w-0 flex-1 rounded-lg border border-[var(--notes-border)] bg-[var(--notes-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--notes-accent)]"
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="person@example.com"
          aria-label="Collaborator email"
        />
        <select
          className="rounded-lg border border-[var(--notes-border)] bg-[var(--notes-bg)] px-3 py-2 text-sm outline-none"
          value={role}
          onChange={(event) => setRole(event.target.value as CollaborationRole)}
          aria-label="Collaboration role"
        >
          {Object.entries(ROLE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={add.isPending || !email.trim()}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--notes-accent)] px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          <UserPlus className="h-4 w-4" />
          {add.isPending ? 'Inviting…' : 'Invite'}
        </button>
      </form>

      {invitationUrl ? (
        <div className="rounded-lg border border-[var(--notes-border)] bg-[var(--notes-bg)] p-3">
          <p className="text-sm font-medium">Invitation link created</p>
          <p className="notes-muted mt-1 text-xs">
            {deliveryMessage ?? 'Send this link to the invited person.'} It is only shown until another invitation is
            created or this dialog closes.
          </p>
          <button
            type="button"
            className="mt-3 inline-flex items-center gap-2 rounded-md border border-[var(--notes-border)] px-3 py-2 text-sm font-medium hover:bg-[var(--notes-hover)]"
            onClick={async () => {
              await navigator.clipboard.writeText(invitationUrl);
              setInvitationCopied(true);
              window.setTimeout(() => setInvitationCopied(false), 1600);
            }}
          >
            {invitationCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {invitationCopied ? 'Copied' : 'Copy invitation link'}
          </button>
        </div>
      ) : null}

      {!invitationUrl && deliveryMessage ? <p className="notes-muted text-sm">{deliveryMessage}</p> : null}
      {add.isError ? <p className="text-sm text-red-600">{add.error.message}</p> : null}
      {resendInvitation.isError ? <p className="text-sm text-red-600">Unable to resend invitation.</p> : null}
      {error ? <p className="text-sm text-red-600">Unable to load people with access.</p> : null}
      {isLoading ? <p className="notes-muted text-sm">Loading people with access…</p> : null}

      {data ? (
        <div className="space-y-2">
          {data.grants.map((grant) => (
            <AccessRow
              key={grant.key}
              identity={grant.user}
              title={grant.user.label}
              subtitle={grant.user.displayName ? (grant.user.maskedEmail ?? 'Email hidden') : 'Active collaborator'}
              trailing={
                <AccessControls>
                  <StatusBadge status="Active" />
                  <select
                    className="w-full rounded-md border border-[var(--notes-border)] bg-transparent px-2 py-1 text-xs"
                    value={grant.role}
                    disabled={update.isPending || remove.isPending}
                    onChange={(event) =>
                      update.mutate({ accessKey: grant.key, nextRole: event.target.value as CollaborationRole })
                    }
                    aria-label={`Role for ${grant.user.label}`}
                  >
                    {Object.entries(ROLE_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <div className="flex justify-end">
                    <button
                      type="button"
                      className="rounded-md p-1.5 text-[var(--notes-muted)] hover:bg-[var(--notes-hover)] hover:text-red-600"
                      onClick={() => remove.mutate(grant.key)}
                      aria-label={`Remove ${grant.user.label}`}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </AccessControls>
              }
            />
          ))}
          {data.invitations.map((invitation) => {
            const expired = new Date(invitation.expiresAt).getTime() <= Date.now();
            const status = expired ? 'Expired' : 'Pending';
            return (
              <AccessRow
                key={invitation.id}
                title={invitation.email}
                subtitle={`${status} invitation · ${expired ? 'expired' : 'expires'} ${new Date(invitation.expiresAt).toLocaleDateString()}`}
                trailing={
                  <AccessControls>
                    <StatusBadge status={status} />
                    <span className="notes-muted px-2 text-xs">{ROLE_LABELS[invitation.role]}</span>
                    <div className="flex justify-end">
                      <button
                        type="button"
                        className="rounded-md p-1.5 text-[var(--notes-muted)] hover:bg-[var(--notes-hover)] hover:text-[var(--notes-text)] disabled:opacity-50"
                        disabled={resendInvitation.isPending}
                        onClick={() => resendInvitation.mutate(invitation.id)}
                        aria-label={`Resend invitation for ${invitation.email}`}
                      >
                        <RefreshCw className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        className="rounded-md p-1.5 text-[var(--notes-muted)] hover:bg-[var(--notes-hover)] hover:text-red-600"
                        onClick={() => revokeInvitation.mutate(invitation.id)}
                        aria-label={`Revoke invitation for ${invitation.email}`}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </AccessControls>
                }
              />
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function AccessControls({ children }: { children: ReactNode }) {
  return <div className="grid w-full grid-cols-[5rem_minmax(0,1fr)_4.5rem] items-center gap-2 sm:w-72">{children}</div>;
}

function StatusBadge({ status }: { status: 'Active' | 'Pending' | 'Expired' }) {
  const color =
    status === 'Active'
      ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
      : status === 'Pending'
        ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300'
        : 'border-[var(--notes-border)] bg-[var(--notes-panel-muted)] text-[var(--notes-muted)]';
  return <span className={`rounded-full border px-2 py-0.5 text-center font-medium text-xs ${color}`}>{status}</span>;
}

function AccessRow({
  identity,
  title,
  subtitle,
  trailing,
}: {
  identity?: CollaborationIdentity;
  title: string;
  subtitle: string;
  trailing: ReactNode;
}) {
  return (
    <div className="flex flex-col items-stretch gap-3 rounded-lg border border-[var(--notes-border)] bg-[var(--notes-bg)] px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-2">
        {identity ? <Avatar identity={identity} size="sm" decorative /> : null}
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{title}</p>
          <p className="notes-muted truncate text-xs">{subtitle}</p>
        </div>
      </div>
      <div className="w-full shrink-0 text-sm text-[var(--notes-muted)] sm:w-auto">{trailing}</div>
    </div>
  );
}
