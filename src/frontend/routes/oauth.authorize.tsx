import { useQuery } from '@tanstack/react-query';
import { createRoute, Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { IntegrationAccessForm } from '../components/integration-access-form';
import { Button } from '../components/ui/button';
import { api, type OAuthAuthorizeRequest } from '../lib/api';
import { rootRoute } from './__root';

function getAuthorizeRequest(): OAuthAuthorizeRequest | null {
  const params = new URLSearchParams(window.location.search);
  const clientId = params.get('client_id');
  const redirectUri = params.get('redirect_uri');
  const responseType = params.get('response_type');
  const codeChallenge = params.get('code_challenge');
  const codeChallengeMethod = params.get('code_challenge_method');
  if (!clientId || !redirectUri || !responseType || !codeChallenge || !codeChallengeMethod) return null;
  return {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: responseType,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
    ...(params.get('state') ? { state: params.get('state') ?? '' } : {}),
    ...(params.get('scope') ? { scope: params.get('scope') ?? '' } : {}),
  };
}

function OAuthAuthorizeView() {
  const request = useMemo(() => getAuthorizeRequest(), []);
  const folders = useQuery({ queryKey: ['folders'], queryFn: api.folders });
  const collaborations = useQuery({ queryKey: ['shared-with-me'], queryFn: api.sharedWithMe });
  const preview = useQuery({
    queryKey: ['oauth-authorize-preview', request],
    queryFn: () => {
      if (!request) throw new Error('Invalid OAuth request');
      return api.oauthAuthorizePreview(request);
    },
    enabled: Boolean(request),
  });
  const requestedScopes = new Set((preview.data?.request.scope ?? '').split(/\s+/).filter(Boolean));

  if (!request)
    return (
      <section className="mx-auto max-w-xl rounded-lg border border-[var(--notes-border)] bg-[var(--notes-panel)] p-6">
        <h1 className="font-semibold text-xl">Invalid OAuth request</h1>
        <p className="notes-muted mt-2 text-sm">The authorization request is missing required parameters.</p>
      </section>
    );
  if (preview.isLoading || folders.isLoading || collaborations.isLoading)
    return <p className="notes-muted text-sm">Loading authorization request...</p>;
  const error = preview.error ?? folders.error ?? collaborations.error;
  if (error || !preview.data)
    return (
      <section className="mx-auto max-w-xl rounded-lg border border-[var(--notes-border)] bg-[var(--notes-panel)] p-6">
        <h1 className="font-semibold text-xl">Unable to authorize app</h1>
        <p className="notes-muted mt-2 text-sm">
          {error instanceof Error ? error.message : 'This authorization request could not be loaded.'}
        </p>
      </section>
    );

  return (
    <section className="mx-auto w-full max-w-3xl">
      <Link to="/integrations" className="text-[var(--notes-muted)] text-xs hover:text-[var(--notes-text)]">
        ← Integrations
      </Link>
      <div className="mt-4 rounded-lg border border-[var(--notes-border)] bg-[var(--notes-panel)] p-5">
        <h1 className="font-semibold text-2xl">Authorize {preview.data.client.name}</h1>
        <p className="notes-muted mt-2 text-sm">Choose what this app can access in MinuNotes.</p>
        {preview.data.client.description ? (
          <p className="notes-muted mt-1 text-sm">{preview.data.client.description}</p>
        ) : null}
        <p className="notes-muted mt-3 break-all rounded-lg border border-[var(--notes-border)] bg-[var(--notes-bg)] p-3 text-xs">
          Redirect URI: {preview.data.request.redirectUri}
        </p>
        <IntegrationAccessForm
          folders={folders.data?.folders ?? []}
          collaborations={collaborations.data?.collaborations ?? []}
          allowedPermissions={{
            canRead: requestedScopes.has('notes.read'),
            canCreate: requestedScopes.has('notes.create'),
            canEdit: requestedScopes.has('notes.edit'),
            canComment: requestedScopes.has('comments.write') && requestedScopes.has('notes.read'),
            canCreateFolders: requestedScopes.has('folders.create'),
          }}
          submitLabel="Allow access"
          onSubmit={async (payload) => {
            const { redirectUrl } = await api.approveOAuthAuthorization({ ...request, ...payload });
            window.location.href = redirectUrl;
          }}
          actions={<Button onClick={() => (window.location.href = preview.data.request.redirectUri)}>Cancel</Button>}
        />
      </div>
    </section>
  );
}

export const oauthAuthorizeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/oauth/authorize',
  component: OAuthAuthorizeView,
});
