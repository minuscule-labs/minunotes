import { describe, expect, it } from 'vitest';
import { groupOAuthApps, oauthAppLastUsed, oauthAppStatus } from '../src/frontend/components/oauth-apps-section';
import type { OAuthAuthorization, OAuthClient } from '../src/frontend/lib/api';

const now = '2026-10-04T00:00:00.000Z';
const client: OAuthClient = {
  id: 'client_owned',
  userId: 'user_a',
  name: 'Owned app',
  description: null,
  redirectUris: '["https://client.example/callback"]',
  clientType: 'public',
  createdAt: now,
  updatedAt: now,
  revokedAt: null,
};
function connection(id: string, app = client, overrides: Partial<OAuthAuthorization> = {}): OAuthAuthorization {
  return {
    id,
    client: app,
    clientId: app.id,
    userId: 'user_a',
    scope: 'notes.read',
    accessMode: 'all',
    sharedAccessMode: 'none',
    collaborationGrantIds: [],
    canRead: true,
    canCreate: false,
    canComment: false,
    canEdit: false,
    canCreateFolders: false,
    permissions: [],
    createdAt: now,
    updatedAt: now,
    revokedAt: null,
    lastUsedAt: null,
    ...overrides,
  };
}

describe('unified OAuth apps', () => {
  it('deduplicates an owned registration and its authorizations by client ID', () => {
    const authorizations = [connection('first'), connection('second', client, { revokedAt: now })];
    const groups = groupOAuthApps([client], authorizations);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({ client, canManageRegistration: true, authorizations });
    expect(oauthAppStatus(groups[0])).toBe('Connected');
    expect(authorizations).toHaveLength(2);
  });

  it('includes external and dynamically registered apps without registration management rights', () => {
    const external = { ...client, id: 'client_external', userId: null, name: 'External app' };
    const groups = groupOAuthApps([client], [connection('external', external)]);
    expect(groups).toHaveLength(2);
    expect(groups[1].canManageRegistration).toBe(false);
    expect(oauthAppStatus(groups[1])).toBe('Connected');
  });

  it('shows registrations without consent as Registered', () => {
    const [group] = groupOAuthApps([client], []);
    expect(oauthAppStatus(group)).toBe('Registered');
    expect(oauthAppLastUsed(group)).toBeNull();
  });

  it('keeps revoked connection history and shows no active connection as Revoked', () => {
    const [group] = groupOAuthApps([], [connection('old', client, { revokedAt: now })]);
    expect(group.authorizations).toHaveLength(1);
    expect(oauthAppStatus(group)).toBe('Revoked');
  });

  it('gives revoked registration status precedence over apparently active connections', () => {
    const revokedClient = { ...client, revokedAt: now };
    const [group] = groupOAuthApps([revokedClient], [connection('stale_active')]);
    expect(oauthAppStatus(group)).toBe('Revoked');
    expect(group.client).toEqual(revokedClient);
  });

  it('uses the latest use time across all connections including revoked history', () => {
    const [group] = groupOAuthApps(
      [client],
      [
        connection('first', client, { lastUsedAt: '2026-10-01T00:00:00.000Z' }),
        connection('latest', client, { revokedAt: now, lastUsedAt: '2026-10-03T00:00:00.000Z' }),
        connection('never'),
      ]
    );
    expect(oauthAppLastUsed(group)).toBe('2026-10-03T00:00:00.000Z');
  });

  it('returns no rows for an empty account', () => {
    expect(groupOAuthApps([], [])).toEqual([]);
  });
});
