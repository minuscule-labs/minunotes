import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMiddleware } from 'hono/factory';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tempDirs: string[] = [];

async function runMigrations(libsql: { executeMultiple: (sql: string) => Promise<unknown> }) {
  for (let index = 0; index <= 40; index += 1) {
    const [file] = await Array.fromAsync(
      (await import('node:fs/promises')).glob(`drizzle/${String(index).padStart(4, '0')}_*.sql`)
    );
    if (!file) throw new Error(`Missing migration ${index}`);
    await libsql.executeMultiple(await readFile(file, 'utf8'));
  }
}

afterEach(async () => {
  vi.doUnmock('../src/api/middleware/authentication');
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('mounted collaboration rate limits', () => {
  it('limits invitation preview, acceptance, resend, and collaborator creation endpoints', async () => {
    vi.resetModules();
    const dir = await mkdtemp(path.join(tmpdir(), 'notes-collaboration-rate-limits-'));
    tempDirs.push(dir);
    vi.stubEnv('TURSO_DB_URL', `file:${path.join(dir, 'test.db')}`);
    vi.stubEnv('FRONTEND_URL', 'https://notes.example.com');
    vi.stubEnv('ALLOWED_ORIGINS', 'https://notes.example.com');

    const [{ db, libsql }, schema] = await Promise.all([
      import('../src/api/db/client'),
      import('../src/api/db/schema'),
    ]);
    await runMigrations(libsql);

    const now = new Date();
    const owner = {
      id: 'rate_limit_owner',
      name: 'Owner',
      email: 'owner@example.com',
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    };
    const collaborator = {
      ...owner,
      id: 'rate_limit_collaborator',
      name: 'Collaborator',
      email: 'collaborator@example.com',
    };
    const usersById = new Map([
      [owner.id, owner],
      [collaborator.id, collaborator],
    ]);
    await db.insert(schema.user).values([owner, collaborator]);
    await db.insert(schema.folders).values({
      id: 'folder_rate_limit',
      userId: owner.id,
      parentFolderId: null,
      title: 'Rate limits',
      isPrivate: false,
      isAgentReadOnly: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.notes).values({
      id: 'note_rate_limit',
      userId: owner.id,
      folderId: 'folder_rate_limit',
      title: 'Rate limits',
      content: '',
      documentType: 'markdown',
      type: 'note',
      isApiEditable: true,
      createdAt: now,
      updatedAt: now,
    });

    const { addResourceCollaborator } = await import('../src/api/lib/collaboration-invitations');
    const invitationResult = await addResourceCollaborator({
      ownerUserId: owner.id,
      target: { noteId: 'note_rate_limit' },
      email: 'invitee@example.com',
      role: 'viewer',
    });
    if (!invitationResult.ok || invitationResult.value.kind !== 'invitation')
      throw new Error('Expected a pending invitation');
    const invitationId = invitationResult.value.invitation.id;
    const invitationToken = invitationResult.value.invitationUrl.split('/').at(-1) ?? '';
    const grantResult = await addResourceCollaborator({
      ownerUserId: owner.id,
      target: { noteId: 'note_rate_limit' },
      email: collaborator.email,
      role: 'viewer',
    });
    if (!grantResult.ok || grantResult.value.kind !== 'grant') throw new Error('Expected a direct grant');
    const accessKey = grantResult.value.grant.key;

    const sessionAuthentication = createMiddleware(async (c, next) => {
      const user = usersById.get(c.req.header('x-test-user') ?? '') ?? null;
      if (!user) return c.json({ error: 'Authentication required' }, 401);
      c.set('user' as never, user as never);
      c.set('session' as never, null as never);
      c.set('apiKey' as never, null as never);
      c.set('oauthAuthorization' as never, null as never);
      await next();
    });
    const integrationAuthentication = createMiddleware((c) => c.json({ error: 'Authentication required' }, 401));
    vi.doMock('../src/api/middleware/authentication', () => ({
      authenticationMiddleware: sessionAuthentication,
      harnessApiKeyAuthenticationMiddleware: integrationAuthentication,
      mcpOAuthAuthenticationMiddleware: integrationAuthentication,
    }));

    const [{ default: app }, { resetRateLimitStore }] = await Promise.all([
      import('../src/api/index'),
      import('../src/api/middleware/rate-limit'),
    ]);
    const request = (pathname: string, sourceIp: string, init?: RequestInit) =>
      app.fetch(new Request(`https://api.example.com${pathname}`, init), {
        requestContext: { http: { sourceIp } },
      } as never);

    resetRateLimitStore();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await request(`/internal/collaboration-invitations/${invitationToken}/preview`, '203.0.113.10');
      expect(response.status).toBe(200);
    }
    const previewLimited = await request(
      `/internal/collaboration-invitations/${invitationToken}/preview`,
      '203.0.113.10'
    );
    expect(previewLimited.status).toBe(429);
    expect(previewLimited.headers.get('Retry-After')).not.toBeNull();

    resetRateLimitStore();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await request(`/internal/collaboration-invitations/${invitationToken}/accept`, '203.0.113.11', {
        method: 'POST',
        headers: { 'x-test-user': collaborator.id },
      });
      expect(response.status).toBe(403);
    }
    expect(
      (
        await request(`/internal/collaboration-invitations/${invitationToken}/accept`, '203.0.113.11', {
          method: 'POST',
          headers: { 'x-test-user': collaborator.id },
        })
      ).status
    ).toBe(429);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await request(`/internal/collaboration-invitations/${invitationId}/resend`, '203.0.113.11', {
        method: 'POST',
        headers: { 'x-test-user': owner.id },
      });
      expect(response.status).toBe(200);
    }
    expect(
      (
        await request(`/internal/collaboration-invitations/${invitationId}/resend`, '203.0.113.11', {
          method: 'POST',
          headers: { 'x-test-user': owner.id },
        })
      ).status
    ).toBe(429);

    resetRateLimitStore();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await request('/internal/notes/note_rate_limit/collaborators', '203.0.113.13', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-user': owner.id },
        body: JSON.stringify({ email: 'invalid', role: 'viewer' }),
      });
      expect(response.status).toBe(400);
    }
    expect(
      (
        await request('/internal/notes/note_rate_limit/collaborators', '203.0.113.13', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-test-user': owner.id },
          body: JSON.stringify({ email: 'invalid', role: 'viewer' }),
        })
      ).status
    ).toBe(429);

    resetRateLimitStore();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await request(`/internal/notes/note_rate_limit/collaborators/${accessKey}`, '203.0.113.14', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-test-user': owner.id },
        body: JSON.stringify({ role: 'invalid' }),
      });
      expect(response.status).toBe(400);
    }
    expect(
      (
        await request(`/internal/notes/note_rate_limit/collaborators/${accessKey}`, '203.0.113.14', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', 'x-test-user': owner.id },
          body: JSON.stringify({ role: 'invalid' }),
        })
      ).status
    ).toBe(429);

    resetRateLimitStore();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await request('/internal/notes/note_rate_limit/collaborators/access_missing', '203.0.113.15', {
        method: 'DELETE',
        headers: { 'x-test-user': owner.id },
      });
      expect(response.status).toBe(404);
    }
    expect(
      (
        await request('/internal/notes/note_rate_limit/collaborators/access_missing', '203.0.113.15', {
          method: 'DELETE',
          headers: { 'x-test-user': owner.id },
        })
      ).status
    ).toBe(429);

    libsql.close();
  }, 15_000);
});
