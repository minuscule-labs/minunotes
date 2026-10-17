import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrationAtomically } from '../scripts/lib/migration-runner';
import { cleanupBoardTests, runBoardMigrations, setupBoardTest } from './board-fixtures';

afterEach(cleanupBoardTests);
describe('additive properties migration', () => {
  it('replays the real bounded migration runner safely on a fresh populated scratch database', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'properties-replay-'));
    const url = `file:${path.join(dir, 'test.db')}`,
      client = createClient({ url });
    const run = (through: string) => {
      const result = spawnSync('pnpm', ['exec', 'tsx', 'scripts/migrate.ts', '--through', through], {
        encoding: 'utf8',
        env: {
          ...process.env,
          TURSO_DB_URL: url,
          TURSO_AUTH_TOKEN: '',
          LIBSQL_URL: '',
          LIBSQL_AUTH_TOKEN: '',
          ENVIRONMENT: 'local',
          SES_FROM_EMAIL: '',
        },
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
    };
    try {
      run('0041');
      await client.executeMultiple(
        "insert into user(id,name,email,email_verified,created_at,updated_at) values ('owner','Owner','owner@example.test',1,1,1);insert into folders(id,user_id,title) values ('folder','owner','Folder');insert into notes(id,user_id,folder_id,title,content) values ('note','owner','folder','Legacy','Body');"
      );
      const before = (await client.execute('select * from notes')).rows;
      run('0042');
      run('0042');
      expect((await client.execute('select * from notes')).rows).toEqual(before);
      expect((await client.execute('select count(*) as n from __drizzle_migrations')).rows[0].n).toBe(43);
      expect((await client.execute('pragma foreign_key_check')).rows).toEqual([]);
    } finally {
      client.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
  it('preserves populated 0041 notes and Board Lite; verifies JSON and owner-qualified FKs/cascades', async () => {
    const f = await setupBoardTest();
    await f.addNote('n', 'Legacy', ['work']);
    await f.save();
    const before = (await f.libsql.execute('select * from notes')).rows;
    const board = (await f.libsql.execute('select * from folder_board_views')).rows;
    await runBoardMigrations(f.libsql, 42, 42);
    expect((await f.libsql.execute('select * from notes')).rows).toEqual(before);
    expect((await f.libsql.execute('select * from folder_board_views')).rows).toEqual(board);
    expect((await f.libsql.execute(`select json_extract('{"x":"ok"}', '$.x') as value`)).rows[0].value).toBe('ok');
    await expect(
      f.libsql.execute(`insert into note_property_state values ('n','other-user',1,'{}',1,1)`)
    ).rejects.toThrow();
    await expect(
      f.libsql.execute(`insert into folder_property_schemas values ('board','other-user','s',1,'[]',1,1)`)
    ).rejects.toThrow();
    await expect(f.libsql.execute(`insert into note_property_state values ('n','owner',0,'{}',1,1)`)).rejects.toThrow();
    await expect(f.libsql.execute(`insert into note_property_state values ('n','owner',1,'[]',1,1)`)).rejects.toThrow();
    await f.libsql.execute(`insert into note_property_state values ('n','owner',1,'{}',1,1)`);
    await f.libsql.execute(`insert into folder_property_schemas values ('board','owner','s',1,'[]',1,1)`);
    await f.libsql.execute("delete from folders where id='board'");
    expect((await f.libsql.execute('select * from note_property_state')).rows).toEqual([]);
    expect((await f.libsql.execute('select * from folder_property_schemas')).rows).toEqual([]);
    expect((await f.libsql.execute('pragma foreign_key_check')).rows).toEqual([]);
  });
  it('snapshot changes only the two additive tables', async () => {
    const old = JSON.parse(await readFile('drizzle/meta/0041_snapshot.json', 'utf8'));
    const next = JSON.parse(await readFile('drizzle/meta/0042_snapshot.json', 'utf8'));
    const { folder_property_schemas, note_property_state, ...tables } = next.tables;
    expect(tables).toEqual(old.tables);
    expect(folder_property_schemas).toBeDefined();
    expect(note_property_state).toBeDefined();
    expect(next.prevId).toBe(old.id);
  });
  it('rolls back failed DDL with its migration journal', async () => {
    const f = await setupBoardTest();
    await f.libsql.execute(
      'create table __drizzle_migrations (id integer primary key,hash text not null,created_at numeric)'
    );
    const sql = await readFile('drizzle/0042_note_properties.sql', 'utf8');
    await expect(
      applyMigrationAtomically(
        f.libsql,
        {
          idx: 42,
          tag: '0042_note_properties',
          when: 1,
          statements: [...sql.split('--> statement-breakpoint'), 'INSERT INTO nonexistent VALUES (1);'],
          hash: 'failed',
        },
        '__drizzle_migrations'
      )
    ).rejects.toThrow('nonexistent');
    expect((await f.libsql.execute("select name from sqlite_master where name='note_property_state'")).rows).toEqual(
      []
    );
    expect((await f.libsql.execute('select * from __drizzle_migrations')).rows).toEqual([]);
  });
});
