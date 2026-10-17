import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrationAtomically } from '../scripts/lib/migration-runner';
import { cleanupBoardTests, setupBoardTest } from './board-fixtures';

afterEach(cleanupBoardTests);
describe('additive board configuration migration', () => {
  it('migrates populated 0040 databases and safely reruns the real migration runner', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'notes-board-migration-'));
    const url = `file:${path.join(dir, 'test.db')}`;
    const run = (through: string) => {
      const result = spawnSync('pnpm', ['exec', 'tsx', 'scripts/migrate.ts', '--through', through], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, TURSO_DB_URL: url, LIBSQL_URL: '', TURSO_AUTH_TOKEN: '', LIBSQL_AUTH_TOKEN: '' },
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
    };
    const client = createClient({ url });
    try {
      run('0040');
      await client.executeMultiple(`
        INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
          VALUES ('owner', 'Owner', 'owner@example.com', 1, 1, 1);
        INSERT INTO folders (id, user_id, title) VALUES ('board', 'owner', 'Board');
        INSERT INTO notes (id, user_id, folder_id, title, content) VALUES ('legacy', 'owner', 'board', 'Legacy', '# Untouched body');
      `);
      const before = await client.execute('SELECT * FROM notes');
      run('0041');
      run('0041');
      expect((await client.execute('SELECT * FROM notes')).rows).toEqual(before.rows);
      expect((await client.execute('SELECT * FROM folder_board_views')).rows).toEqual([]);
      expect((await client.execute('PRAGMA foreign_key_check')).rows).toEqual([]);
      expect((await client.execute('SELECT count(*) AS count FROM __drizzle_migrations')).rows[0].count).toBe(42);
    } finally {
      client.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('enforces the tenant FK, config bounds and cascade deletion', async () => {
    const f = await setupBoardTest();
    expect((await f.save()).status).toBe(200);
    const insert = (userId: string, version: number, config: string) =>
      f.libsql.execute({
        sql: 'INSERT INTO folder_board_views (folder_id,user_id,config,version,created_at,updated_at) VALUES (?,?,?,?,?,?)',
        args: ['other', userId, config, version, 1, 1],
      });
    await expect(insert('other-user', 1, '{}')).rejects.toThrow();
    await expect(insert('owner', 0, '{}')).rejects.toThrow();
    await expect(insert('owner', 1, 'x'.repeat(16385))).rejects.toThrow();
    await f.libsql.execute("DELETE FROM folders WHERE id = 'board'");
    expect((await f.libsql.execute('SELECT * FROM folder_board_views')).rows).toEqual([]);
    expect((await f.libsql.execute('PRAGMA foreign_key_check')).rows).toEqual([]);
  });

  it('rolls back board DDL and its migration record on failure', async () => {
    const f = await setupBoardTest(40);
    await f.addNote('legacy', 'Legacy');
    await f.libsql.execute(
      'CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at INTEGER)'
    );
    const sql = await readFile('drizzle/0041_folder_board_views.sql', 'utf8');
    await expect(
      applyMigrationAtomically(
        f.libsql,
        {
          idx: 41,
          tag: '0041_folder_board_views',
          when: 41,
          hash: 'probe',
          statements: [sql, 'INSERT INTO nonexistent_table VALUES (1)'],
        },
        '__drizzle_migrations'
      )
    ).rejects.toThrow();
    expect((await f.libsql.execute("SELECT name FROM sqlite_master WHERE name = 'folder_board_views'")).rows).toEqual(
      []
    );
    expect((await f.libsql.execute('SELECT * FROM __drizzle_migrations')).rows).toEqual([]);
    expect((await f.libsql.execute('SELECT id FROM notes')).rows[0].id).toBe('legacy');
    expect((await f.libsql.execute('PRAGMA foreign_key_check')).rows).toEqual([]);
  });
});
