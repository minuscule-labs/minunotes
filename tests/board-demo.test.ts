import { execFile } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDemoSandbox,
  type DemoSandbox,
  demoEnvironment,
  PROJECT_ROOT,
  parseDemoArguments,
  readDemoCodes,
} from '../scripts/lib/board-demo';
import {
  DEMO_CONFIG,
  DEMO_FOLDER_ID,
  DEMO_OTHER_CONFIG,
  DEMO_PROPERTY_DEFINITIONS,
  DEMO_TYPE_DEFINITION,
  DEMO_USERS,
  demoNotes,
  seedBoardDemo,
} from '../scripts/lib/board-demo-seed';
import { validateBoardConfig } from '../src/shared/board';

const sandboxes: DemoSandbox[] = [];
async function setup(large = false) {
  const sandbox = await createDemoSandbox(large);
  sandboxes.push(sandbox);
  return sandbox;
}
afterEach(async () => {
  for (const sandbox of sandboxes.splice(0)) await sandbox.dispose();
});
function visibleNotes(large: boolean) {
  return demoNotes(large).filter((note) => note.folderId === DEMO_FOLDER_ID && note.type === 'note' && !note.deletedAt);
}

describe('disposable Board Lite demo', () => {
  it('accepts only the local demo options, never a target database', () => {
    expect(parseDemoArguments([])).toEqual({ large: false, help: false });
    expect(parseDemoArguments(['--', '--large'])).toEqual({ large: true, help: false });
    expect(parseDemoArguments(['--help']).help).toBe(true);
    for (const args of [['--database', 'file:local.db'], ['--url=libsql://production'], ['--host', '0.0.0.0']])
      expect(() => parseDemoArguments(args)).toThrow('Unsupported');
  });

  it('has deterministic useful small and large fixtures and explicit excluded examples', () => {
    expect(demoNotes()).toEqual(demoNotes());
    expect(new Set(demoNotes(true).map((note) => note.id)).size).toBe(172);
    expect(visibleNotes(false)).toHaveLength(17);
    expect(visibleNotes(true)).toHaveLength(167);
    for (const option of DEMO_PROPERTY_DEFINITIONS[0].options)
      expect(
        visibleNotes(false).filter((note) => note.propertyValues[DEMO_PROPERTY_DEFINITIONS[0].id] === option.id).length
      ).toBeGreaterThanOrEqual(2);
    expect(visibleNotes(false).filter((note) => note.title.startsWith('Unclassified:'))).toHaveLength(2);
    expect(visibleNotes(false).some((note) => note.title.startsWith('Excluded:'))).toBe(true);
    const canvas = visibleNotes(false).find((note) => note.documentType === 'canvas.default');
    expect(JSON.parse(canvas?.content ?? '')).toEqual({ nodes: [], edges: [] });
  });

  it('migrates and seeds only a new owned database, with real grants and valid FKs', async () => {
    const sandbox = await setup();
    expect(sandbox.counts).toEqual({ notes: 22, visibleCards: 17, todoCards: 8 });
    expect(Number((await sandbox.client.execute('SELECT count(*) AS n FROM __drizzle_migrations')).rows[0].n)).toBe(45);
    expect((await sandbox.client.execute('SELECT * FROM folder_duplication_requests')).rows).toEqual([]);
    const receiptIndexes = await sandbox.client.execute('PRAGMA index_list(folder_duplication_requests)');
    expect(receiptIndexes.rows.find((row) => row.name === 'folder_duplication_actor_request_idx')).toMatchObject({
      unique: 1,
    });
    expect(
      (await sandbox.client.execute('PRAGMA index_info(folder_duplication_actor_request_idx)')).rows.map(
        (row) => row.name
      )
    ).toEqual(['actor_user_id', 'request_id']);
    expect((await sandbox.client.execute('PRAGMA foreign_key_check')).rows).toEqual([]);
    expect(
      (await sandbox.client.execute('SELECT role FROM collaboration_grants ORDER BY role')).rows.map((row) => row.role)
    ).toEqual(['commenter', 'editor', 'viewer']);
    const config = await sandbox.client.execute('SELECT folder_id, config, version FROM folder_board_views');
    expect(config.rows).toHaveLength(2);
    for (const row of config.rows) {
      expect(validateBoardConfig(JSON.parse(String(row.config)))).toEqual(
        row.folder_id === DEMO_FOLDER_ID ? DEMO_CONFIG : DEMO_OTHER_CONFIG
      );
      expect(row.version).toBe(1);
    }
    expect((await sandbox.client.execute('SELECT * FROM folder_property_schemas')).rows).toHaveLength(2);
    expect((await sandbox.client.execute('SELECT * FROM template_default_state')).rows).toHaveLength(1);
    expect((await sandbox.client.execute('SELECT * FROM template_folder_assignments')).rows).toHaveLength(3);
    expect((await sandbox.client.execute('SELECT * FROM note_property_state')).rows).toHaveLength(18);
    expect((await sandbox.client.execute('SELECT * FROM session')).rows).toEqual([]);
    expect((await sandbox.client.execute('SELECT * FROM note_events')).rows).toEqual([]);
    await expect(seedBoardDemo(sandbox.client)).rejects.toThrow('fresh, empty');
  });

  it('fresh demo selects Status and optional Type without tag gating and uses explicit retained template values', async () => {
    const sandbox = await setup();
    expect(DEMO_CONFIG).toMatchObject({
      schemaVersion: 4,
      grouping: { propertyId: DEMO_PROPERTY_DEFINITIONS[0].id },
      cardPropertyIds: [DEMO_TYPE_DEFINITION.id],
    });
    const records = demoNotes().filter((n) => n.folderId === DEMO_FOLDER_ID && n.type === 'note' && !n.deletedAt);
    expect(records).toHaveLength(17);
    expect(
      records.filter(
        (n) => n.propertyValues[DEMO_PROPERTY_DEFINITIONS[0].id] === DEMO_PROPERTY_DEFINITIONS[0].options[0].id
      )
    ).toHaveLength(8);
    expect(new Set(records.map((n) => n.propertyValues[DEMO_TYPE_DEFINITION.id]).filter(Boolean)).size).toBe(3);
    for (const note of records) {
      const row = (
        await sandbox.client.execute({
          sql: 'select "values" from note_property_state where note_id=?',
          args: [note.id],
        })
      ).rows[0];
      expect(JSON.parse(String(row.values))).toEqual(note.propertyValues);
    }
    const defaults = (
      await sandbox.client.execute({
        sql: 'select property_defaults from template_folder_assignments where folder_id=? and defaults_revision=1',
        args: [DEMO_FOLDER_ID],
      })
    ).rows[0];
    expect(JSON.parse(String(defaults.property_defaults))[DEMO_TYPE_DEFINITION.id]).toBe(
      DEMO_TYPE_DEFINITION.options[2].id
    );
    expect(
      JSON.parse(String((await sandbox.client.execute('select tags from template_default_state')).rows[0].tags))
    ).toContain('status-todo');
  });
  it('overrides hostile ambient targets, credentials and network/auth settings', async () => {
    const sandbox = await setup();
    const env = demoEnvironment(sandbox, {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TURSO_DB_URL: 'libsql://production',
      TURSO_AUTH_TOKEN: 'production-token',
      LIBSQL_URL: 'file:local.db',
      AWS_ACCESS_KEY_ID: 'real-key',
      NODE_OPTIONS: '--require remote.js',
      BETTER_AUTH_SECRET: 'real-secret',
      COOKIE_DOMAIN: 'minusculelabs.com',
      SES_FROM_EMAIL: 'real@example.com',
      ATTACHMENT_STORAGE_DRIVER: 's3',
      VITE_API_PROXY_TARGET: 'https://production',
    });
    expect(env.TURSO_DB_URL).toBe(sandbox.databaseUrl);
    expect(env.LIBSQL_URL).toBe(sandbox.databaseUrl);
    expect(env.TURSO_AUTH_TOKEN).toBe('');
    expect(env.BETTER_AUTH_SECRET?.length).toBeGreaterThanOrEqual(32);
    expect(env.COOKIE_DOMAIN).toBe('');
    expect(env.COOKIE_PREFIX).toMatch(/^board-demo-/);
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.VITE_API_PROXY_TARGET).toBe('http://127.0.0.1:3181');
    expect(env.SES_FROM_EMAIL).toBe('');
    expect(env.EMAIL_PROTECTION_MODE).toBe('off');
    expect(env.ATTACHMENT_STORAGE_PATH).toBe(path.join(sandbox.root, 'attachments'));
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it.each([
    '=',
    ' ',
  ])('retains only the supplied controlled env-read guard in child processes (%s)', async (separator) => {
    const sandbox = await setup();
    const guard = path.join(sandbox.root, 'no-env.cjs');
    // Exact approved bytes, owned by this test; no invoking-shell/artifact dependency.
    await writeFile(
      guard,
      String.raw`// Test-launch safety only: legacy migration CLIs must never inspect ambient env files.
const fs = require('node:fs');
const path = require('node:path');
const isEnv = p => typeof p === 'string' && /^\.env(?:\.|$)/.test(path.basename(p));
const exists = fs.existsSync, read = fs.readFileSync;
fs.existsSync = p => isEnv(p) ? false : exists(p);
fs.readFileSync = (...args) => { if (isEnv(args[0])) throw new Error('Ambient env-file read prohibited by scoped test launcher'); return read(...args); };
require('node:module').syncBuiltinESMExports();
`
    );
    const options = `--require${separator}${guard}`;
    const env = demoEnvironment(sandbox, { PATH: process.env.PATH, NODE_OPTIONS: options });
    expect(env.NODE_OPTIONS).toBe(`--require=${guard}`);
    await writeFile(path.join(sandbox.root, '.env'), 'synthetic-only');
    await promisify(execFile)(
      process.execPath,
      [
        '-e',
        `
      const fs = require('node:fs');
      if (fs.existsSync(${JSON.stringify(path.join(sandbox.root, '.env'))})) process.exit(1);
      try { fs.readFileSync(${JSON.stringify(path.join(sandbox.root, '.env'))}); process.exit(2); }
      catch (e) { if (!e.message.includes('env-file read prohibited')) process.exit(3); }
    `,
      ],
      { env }
    );
    for (const invalid of [
      `${options} --inspect`,
      `--inspect ${options}`,
      `${options} --require=${guard}`,
      `--require${separator}${path.join(sandbox.root, 'missing', 'no-env.cjs')}`,
      `--require${separator}${path.join(sandbox.root, 'unknown.cjs')}`,
    ])
      expect(demoEnvironment(sandbox, { NODE_OPTIONS: invalid }).NODE_OPTIONS).toBeUndefined();
    expect(demoEnvironment(sandbox, {}).NODE_OPTIONS).toBeUndefined();
    await writeFile(guard, 'throw new Error("hostile code")');
    expect(demoEnvironment(sandbox, { NODE_OPTIONS: options }).NODE_OPTIONS).toBeUndefined();
    const frontend = await readFile(path.join(PROJECT_ROOT, 'scripts/board-demo-web.ts'), 'utf8');
    expect(frontend).toContain('configFile: false');
    expect(frontend).toContain('envFile: false');
    expect(frontend).not.toContain('vite.config.ts');
    await sandbox.dispose();
    await expect(stat(sandbox.root)).rejects.toHaveProperty('code', 'ENOENT');
  });

  it('displays only current sign-in codes belonging to synthetic accounts in its own sandbox', async () => {
    const sandbox = await setup();
    const now = Date.now();
    for (const [id, identifier, value, expires] of [
      ['owner', `sign-in-otp-${DEMO_USERS.owner.email}`, '123456:0', now + 60_000],
      ['expired', `sign-in-otp-${DEMO_USERS.viewer.email}`, '111111:0', now - 1],
      ['other-email', 'sign-in-otp-real@example.com', '222222:0', now + 60_000],
      ['other-purpose', `forget-password-otp-${DEMO_USERS.owner.email}`, '333333:0', now + 60_000],
      ['hashed', `sign-in-otp-${DEMO_USERS.editor.email}`, 'not-plaintext:0', now + 60_000],
    ] as const)
      await sandbox.client.execute({
        sql: 'INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        args: [id, identifier, value, expires, now, now],
      });
    expect(await readDemoCodes(sandbox, now)).toEqual([
      { id: 'owner', email: DEMO_USERS.owner.email, otp: '123456', expiresAt: now + 60_000 },
    ]);
  });

  it('refuses cleanup or OTP reads if the ownership marker was changed', async () => {
    const sandbox = await setup();
    const markerPath = path.join(sandbox.root, '.board-demo-owned');
    const marker = await readFile(markerPath, 'utf8');
    await writeFile(markerPath, 'someone-else');
    await expect(readDemoCodes(sandbox)).rejects.toThrow('ownership');
    await expect(sandbox.dispose()).rejects.toThrow('ownership');
    expect((await stat(sandbox.root)).isDirectory()).toBe(true);
    await writeFile(markerPath, marker);
  });

  it('restart removes only its owned database and creates distinct clean data/auth', async () => {
    const first = await setup();
    await first.client.execute("UPDATE notes SET title = 'manual edit'");
    await first.dispose();
    await expect(stat(first.root)).rejects.toHaveProperty('code', 'ENOENT');
    const second = await setup(true);
    expect(second.root).not.toBe(first.root);
    expect(second.secret).not.toBe(first.secret);
    expect(second.cookiePrefix).not.toBe(first.cookiePrefix);
    expect(second.counts.todoCards).toBe(158);
    expect((await second.client.execute("SELECT id FROM notes WHERE title = 'manual edit'")).rows).toEqual([]);
    expect(second.databaseUrl).toBe(`file:${path.join(second.root, 'demo.db')}`);
    await second.assertOwned();
  });
});
