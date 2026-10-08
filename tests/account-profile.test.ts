import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it('returns the current account profile with an opaque collaboration identity', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notes-account-profile-'));
  tempDirs.push(dir);
  vi.stubEnv('TURSO_DB_URL', `file:${path.join(dir, 'test.db')}`);

  const [{ db, libsql }, { user }, { accountRoutes }] = await Promise.all([
    import('../src/api/db/client'),
    import('../src/api/db/schema'),
    import('../src/api/routes/account'),
  ]);
  for (let index = 0; index <= 40; index += 1) {
    const [file] = await Array.fromAsync(
      (await import('node:fs/promises')).glob(`drizzle/${String(index).padStart(4, '0')}_*.sql`)
    );
    if (!file) throw new Error(`Missing migration ${index}`);
    await libsql.executeMultiple(await readFile(file, 'utf8'));
  }

  await db.insert(user).values({
    id: 'internal-user-id',
    name: 'Profile Person',
    email: 'profile@example.com',
    emailVerified: true,
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const app = new Hono<{ Variables: { user: { id: string } } }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: 'internal-user-id' });
    await next();
  });
  app.route('/account', accountRoutes);

  const response = await app.request('/account/profile');
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.profile).toEqual({
    identity: {
      key: expect.stringMatching(/^user_[a-f0-9]{16}$/),
      type: 'user',
      displayName: 'Profile Person',
      maskedEmail: 'p•••@e•••.com',
      label: 'You',
      isCurrentUser: true,
    },
    email: 'profile@example.com',
    imageUrl: null,
  });
  expect(JSON.stringify(body.profile.identity)).not.toContain('internal-user-id');
});
