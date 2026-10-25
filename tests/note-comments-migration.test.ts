import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { expect, it } from 'vitest';
import { applyMigrationAtomically } from '../scripts/lib/migration-runner';

it('preserves populated Review data and foreign keys through the real general-comments migration and replay', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'general-comments-migration-'));
  const url = `file:${path.join(dir, 'test.db')}`;
  const client = createClient({ url });
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
    run('0044');
    await client.execute('PRAGMA foreign_keys=ON');
    await client.executeMultiple(`
      insert into user(id,name,email,email_verified,created_at,updated_at) values ('owner','Owner','owner@example.test',1,1,1);
      insert into folders(id,user_id,title) values ('folder','owner','Folder');
      insert into notes(id,user_id,folder_id,title,content) values ('note','owner','folder','Existing','Alpha beta');
    `);
    for (const [index, type, status, detached] of [
      [0, 'range', 'open', 0],
      [1, 'line', 'open', 0],
      [2, 'range', 'resolved', 0],
      [3, 'range', 'open', 1],
    ] as const) {
      await client.execute({
        sql: `insert into note_comment_threads (id,note_id,user_id,status,anchor_type,anchor_from,anchor_to,quote,document_hash,detached,created_by_actor_type,created_by_actor_id,created_at,updated_at) values (?,'note','owner',?,?,0,5,'Alpha','old-hash',?,'user','owner',100,200)`,
        args: [`thread${index}`, status, type, detached],
      });
      for (const root of [0, 1]) {
        const id = `message${index}_${root}`;
        await client.execute({
          sql: `insert into note_comment_messages(id,thread_id,note_id,user_id,actor_type,actor_id,body,is_root,created_at,updated_at) values (?,?,'note','owner','user','owner','Retained',?,100,200)`,
          args: [id, `thread${index}`, root],
        });
        await client.execute({
          sql: `insert into note_comment_message_reactions(id,message_id,thread_id,note_id,user_id,actor_type,actor_id,emoji,created_at) values (?,?,?,'note','owner','user','owner','👍',100)`,
          args: [`reaction${index}_${root}`, id, `thread${index}`],
        });
      }
    }
    const tables = ['note_comment_threads', 'note_comment_messages', 'note_comment_message_reactions'];
    const snapshot = async () =>
      Promise.all(tables.map(async (table) => (await client.execute(`select * from ${table} order by id`)).rows));
    const before = await snapshot();
    const indexes = (
      await client.execute(
        "select name from sqlite_master where type='index' and tbl_name='note_comment_threads' order by name"
      )
    ).rows;
    const sql = await readFile('drizzle/0045_general_note_comments.sql', 'utf8');
    const journalBefore = (await client.execute('select * from __drizzle_migrations')).rows;
    await expect(
      applyMigrationAtomically(
        client,
        {
          idx: 45,
          tag: 'failed',
          when: 999,
          hash: 'failed',
          statements: [...sql.split('--> statement-breakpoint'), 'INSERT INTO nonexistent VALUES (1)'],
        },
        '__drizzle_migrations'
      )
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    expect((await client.execute('select * from __drizzle_migrations')).rows).toEqual(journalBefore);
    run('0045');
    run('0045');
    expect(await snapshot()).toEqual(before);
    expect(
      (
        await client.execute(
          "select name from sqlite_master where type='index' and tbl_name='note_comment_threads' order by name"
        )
      ).rows
    ).toEqual(indexes);
    expect((await client.execute('pragma foreign_key_check')).rows).toEqual([]);
    expect((await client.execute('select count(*) as n from __drizzle_migrations')).rows[0].n).toBe(46);
    await client.execute(
      `insert into note_comment_threads(id,note_id,user_id,anchor_type,created_by_actor_type) values ('general','note','owner','note','user')`
    );
    expect(
      (
        await client.execute(
          "select anchor_from,anchor_to,quote,document_hash,detached from note_comment_threads where id='general'"
        )
      ).rows
    ).toEqual([{ anchor_from: null, anchor_to: null, quote: null, document_hash: null, detached: 0 }]);
    for (const fields of [
      "anchor_type='unknown'",
      'anchor_from=0',
      "quote='fake'",
      "document_hash='fake'",
      'detached=1',
    ]) {
      await expect(client.execute(`update note_comment_threads set ${fields} where id='general'`)).rejects.toThrow();
    }
    await expect(
      client.execute("update note_comment_threads set anchor_from=null where id='thread0'")
    ).rejects.toThrow();
    await expect(
      client.execute("update note_comment_threads set user_id='other' where id='general'")
    ).rejects.toThrow();
    await client.execute("delete from notes where id='note'");
    expect(await snapshot()).toEqual([[], [], []]);
    expect((await client.execute('pragma foreign_key_check')).rows).toEqual([]);
    const old = JSON.parse(await readFile('drizzle/meta/0044_snapshot.json', 'utf8'));
    const next = JSON.parse(await readFile('drizzle/meta/0045_snapshot.json', 'utf8'));
    const { note_comment_threads: _oldThread, ...oldOther } = old.tables;
    const { note_comment_threads: _newThread, ...newOther } = next.tables;
    expect(newOther).toEqual(oldOther);
    expect(next.prevId).toBe(old.id);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
