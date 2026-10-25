import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { DEMO_FOLDER_ID, DEMO_USERS, seedBoardDemo } from './board-demo-seed';
import { applyMigrationAtomically, type Migration } from './migration-runner';

export const DEMO_API_PORT = 3181;
export const DEMO_WEB_PORT = 5181;
export const DEMO_WEB_URL = `http://127.0.0.1:${DEMO_WEB_PORT}`;
export const DEMO_BOARD_URL = `${DEMO_WEB_URL}/folders/${DEMO_FOLDER_ID}?view=board`;
export const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const markerName = '.board-demo-owned';

export async function assertOwnedDemoDirectory(root: string, marker: string) {
  const stat = await lstat(root);
  if (
    !/^[a-f0-9]{64}$/.test(marker) ||
    !path.basename(root).startsWith('notes-board-demo-') ||
    path.dirname(root) !== (await realpath(tmpdir())) ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await realpath(root)) !== root ||
    (await readFile(path.join(root, markerName), 'utf8')) !== marker
  )
    throw new Error('Demo ownership changed; refusing to use or remove the directory');
}

export function parseDemoArguments(args: string[]) {
  const unknown = args.filter((arg) => !['--large', '--help', '-h', '--'].includes(arg));
  if (unknown.length) throw new Error(`Unsupported demo option: ${unknown.join(' ')}. No custom database targets.`);
  return { large: args.includes('--large'), help: args.includes('--help') || args.includes('-h') };
}

/** No caller-supplied target: every invocation owns a newly-created temporary database. */
export async function createDemoSandbox(large = false) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'notes-board-demo-')));
  const marker = randomBytes(32).toString('hex');
  const databasePath = path.join(root, 'demo.db');
  const databaseUrl = `file:${databasePath}`;
  const secret = randomBytes(32).toString('base64url');
  const cookiePrefix = `board-demo-${randomBytes(8).toString('hex')}`;
  const client = createClient({ url: databaseUrl });
  let disposed = false;
  const assertOwned = () => assertOwnedDemoDirectory(root, marker);
  const dispose = async () => {
    if (disposed) return;
    client.close();
    await assertOwned();
    await rm(root, { recursive: true });
    disposed = true;
  };
  try {
    await writeFile(path.join(root, markerName), marker, { mode: 0o600 });
    await client.execute(
      'CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at INTEGER)'
    );
    const journal = JSON.parse(await readFile(path.join(PROJECT_ROOT, 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const entries = journal.entries.filter((entry) => entry.idx <= 45);
    if (entries.at(-1)?.tag !== '0045_general_note_comments')
      throw new Error('Expected general note comments migration 0045');
    for (const entry of entries) {
      const sql = await readFile(path.join(PROJECT_ROOT, `drizzle/${entry.tag}.sql`), 'utf8');
      const migration: Migration = {
        ...entry,
        hash: createHash('sha256').update(sql).digest('hex'),
        statements: sql
          .split('--> statement-breakpoint')
          .map((sql) => sql.trim())
          .filter(Boolean),
      };
      await applyMigrationAtomically(client, migration, '__drizzle_migrations');
    }
    await client.execute('PRAGMA foreign_keys=ON');
    const counts = await seedBoardDemo(client, large);
    if ((await client.execute('PRAGMA foreign_key_check')).rows.length) throw new Error('Invalid demo foreign keys');
    return { root, marker, databasePath, databaseUrl, secret, cookiePrefix, client, counts, assertOwned, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
export type DemoSandbox = Awaited<ReturnType<typeof createDemoSandbox>>;

export function demoEnvironment(sandbox: DemoSandbox, ambient: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TERM'])
    if (ambient[key]) env[key] = ambient[key];
  // Forward only the exact supplied test guard, never arbitrary Node flags/code.
  const guard = /^--require(?:=| )(\/[^\s]+\/no-env\.cjs)$/.exec(ambient.NODE_OPTIONS ?? '')?.[1];
  if (guard) {
    try {
      const resolved = realpathSync(guard);
      if (
        resolved.startsWith(`${realpathSync(tmpdir())}${path.sep}`) &&
        createHash('sha256').update(readFileSync(resolved)).digest('hex') ===
          'b472f2adadd6336bcaa3cba2852828c39e3d025b865792956b238c1f325c6242'
      )
        env.NODE_OPTIONS = `--require=${resolved}`;
    } catch {
      /* An absent/unrecognized guard is not executable input. */
    }
  }
  return {
    ...env,
    NO_COLOR: '1',
    NODE_ENV: 'development',
    ENVIRONMENT: 'local',
    BOARD_DEMO_ROOT: sandbox.root,
    BOARD_DEMO_MARKER: sandbox.marker,
    HOST: '127.0.0.1',
    PORT: String(DEMO_API_PORT),
    TURSO_DB_URL: sandbox.databaseUrl,
    TURSO_AUTH_TOKEN: '',
    LIBSQL_URL: sandbox.databaseUrl,
    LIBSQL_AUTH_TOKEN: '',
    BETTER_AUTH_SECRET: sandbox.secret,
    BETTER_AUTH_URL: `${DEMO_WEB_URL}/internal/auth`,
    FRONTEND_URL: DEMO_WEB_URL,
    API_URL: DEMO_WEB_URL,
    API_ALLOWED_ORIGINS: DEMO_WEB_URL,
    COOKIE_DOMAIN: '',
    COOKIE_PREFIX: sandbox.cookiePrefix,
    ALLOWED_LOGIN_EMAILS: Object.values(DEMO_USERS)
      .map((user) => user.email)
      .join(','),
    SES_FROM_EMAIL: '',
    EMAIL_PROTECTION_MODE: 'off',
    EMAIL_PROTECTION_HASH_SECRET: sandbox.secret,
    ATTACHMENT_STORAGE_DRIVER: 'filesystem',
    ATTACHMENT_STORAGE_PATH: path.join(sandbox.root, 'attachments'),
    VITE_API_URL: '/internal',
    VITE_API_PROXY_TARGET: `http://127.0.0.1:${DEMO_API_PORT}`,
    VITE_LEGACY_ATTACHMENT_ORIGINS: '',
    VITE_INTERNAL_NOTE_ORIGINS: '',
    VITE_ENABLE_OAUTH_APPS: 'false',
  };
}

/** Explicitly limited to this owned demo DB and its synthetic accounts, never production delivery. */
export async function readDemoCodes(sandbox: DemoSandbox, now = Date.now()) {
  await sandbox.assertOwned();
  const identifiers = Object.values(DEMO_USERS).map((user) => `sign-in-otp-${user.email}`);
  const rows = await sandbox.client.execute({
    sql: `SELECT id, identifier, value, expires_at FROM verification WHERE expires_at > ? AND identifier IN (${identifiers.map(() => '?').join(',')})`,
    args: [now, ...identifiers],
  });
  return rows.rows.flatMap((row) => {
    const match = /^(\d{6}):\d+$/.exec(String(row.value));
    return match
      ? [
          {
            id: String(row.id),
            email: String(row.identifier).slice('sign-in-otp-'.length),
            otp: match[1],
            expiresAt: Number(row.expires_at),
          },
        ]
      : [];
  });
}

export type DemoChild = {
  process: ChildProcess;
  ready: Promise<void>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};
export function launchDemoChild(args: string[], env: NodeJS.ProcessEnv, readyPattern: RegExp): DemoChild {
  const child = spawn(process.execPath, args, {
    cwd: PROJECT_ROOT,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('error', () => resolve({ code: 1, signal: null }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const ready = new Promise<void>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Demo server startup timed out')), 30_000);
    const onData = (chunk: Buffer) => {
      output = `${output}${chunk}`.slice(-16_384);
      if (readyPattern.test(output)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on('data', onData);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    void exited.then(({ code, signal }) => {
      clearTimeout(timer);
      reject(new Error(`Demo server exited (${code ?? signal}) before it was stopped`));
    });
  });
  child.stdout?.pipe(process.stdout, { end: false });
  child.stderr?.pipe(process.stderr, { end: false });
  return { process: child, ready, exited };
}
export async function stopDemoChild(child: DemoChild) {
  const pid = child.process.pid;
  if (child.process.exitCode !== null || child.process.signalCode !== null || !pid) return;
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (process.platform === 'win32') child.process.kill(signal);
      else process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  kill('SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const done = await Promise.race([
      child.exited.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 3_000);
      }),
    ]);
    if (!done) {
      kill('SIGKILL');
      await child.exited;
    }
  } finally {
    clearTimeout(timer);
  }
}
