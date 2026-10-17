import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrationAtomically } from '../scripts/lib/migration-runner';
import { cleanupBoardTests, setupBoardTest } from './board-fixtures';

afterEach(cleanupBoardTests);
async function migration() {
  return {
    idx: 43,
    tag: '0043_template_defaults',
    when: 1,
    hash: 'template-migration',
    statements: (await readFile('drizzle/0043_template_defaults.sql', 'utf8')).split('--> statement-breakpoint'),
  };
}
describe('template migration', () => {
  it('real bounded runner replay advances populated 0042 once and keeps retained assignments', async () => {
    const f = await setupBoardTest(42);
    await f.addNote('t', 'Template', [], { type: 'template' });
    await f.libsql.execute(
      "insert into template_folder_assignments(id,template_id,folder_id,user_id) values ('a','t','board','owner')"
    );
    // Record existing applied hashes using the same runner representation, then apply/replay only 0043.
    const { createHash } = await import('node:crypto');
    const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8'));
    await f.libsql.execute(
      'create table __drizzle_migrations(id integer primary key,hash text not null,created_at integer)'
    );
    for (const e of journal.entries.filter((e: { idx: number }) => e.idx <= 42))
      await f.libsql.execute({
        sql: 'insert into __drizzle_migrations(hash,created_at) values (?,?)',
        args: [
          createHash('sha256')
            .update(await readFile(`drizzle/${e.tag}.sql`, 'utf8'))
            .digest('hex'),
          e.when,
        ],
      });
    const run = () =>
      spawnSync('pnpm', ['exec', 'tsx', 'scripts/migrate.ts', '--through', '0043'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          ENVIRONMENT: 'test',
          TURSO_DB_URL: process.env.TURSO_DB_URL,
          LIBSQL_URL: process.env.TURSO_DB_URL,
          TURSO_AUTH_TOKEN: '',
          LIBSQL_AUTH_TOKEN: '',
          SES_FROM_EMAIL: '',
          EMAIL_VERIFICATION_API_KEY: '',
        },
      });
    const first = run(),
      second = run();
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect((await f.libsql.execute('select * from __drizzle_migrations')).rows).toHaveLength(44);
    expect((await f.libsql.execute('select id,defaults_revision from template_folder_assignments')).rows).toEqual([
      { id: 'a', defaults_revision: 0 },
    ]);
  }, 30000);
  it('preserves populated assignment IDs, empty defaults, qualified FKs and deleted-note receipts', async () => {
    const f = await setupBoardTest(42);
    await f.addNote('t', 'Template', [], { type: 'template' });
    await f.libsql.execute(
      "insert into template_folder_assignments(id,template_id,folder_id,user_id) values ('a','t','board','owner')"
    );
    await f.libsql.execute('create table __drizzle_migrations(id integer primary key, hash text, created_at integer)');
    await applyMigrationAtomically(f.libsql, await migration(), '__drizzle_migrations');
    expect(
      (
        await f.libsql.execute(
          'select id,defaults_revision,schema_id,property_defaults from template_folder_assignments'
        )
      ).rows
    ).toEqual([{ id: 'a', defaults_revision: 0, schema_id: null, property_defaults: '{}' }]);
    await expect(
      f.libsql.execute("insert into template_default_state values ('t','other-user',1,'[]',1,1)")
    ).rejects.toThrow();
    await expect(
      f.libsql.execute(
        "insert into note_creation_requests values ('r','other-user','board','owner','user','owner','request','hash','t',1)"
      )
    ).rejects.toThrow();
    await f.libsql.execute(
      "insert into note_creation_requests values ('r','owner','board','owner','user','owner','request','hash','t',1)"
    );
    await f.libsql.execute("delete from notes where id='t'");
    expect((await f.libsql.execute('select note_id from note_creation_requests')).rows).toEqual([{ note_id: 't' }]);
    expect((await f.libsql.execute('pragma foreign_key_check')).rows).toEqual([]);
  });
  it('legacy duplicates fail atomically with no discarded assignment or partial DDL/journal', async () => {
    const f = await setupBoardTest(42);
    await f.addNote('t', 'Template', [], { type: 'template' });
    await f.libsql.execute(
      "insert into template_folder_assignments(id,template_id,folder_id,user_id) values ('a','t','board','owner'),('b','t','board','owner')"
    );
    await f.libsql.execute('create table __drizzle_migrations(id integer primary key, hash text, created_at integer)');
    await expect(applyMigrationAtomically(f.libsql, await migration(), '__drizzle_migrations')).rejects.toThrow();
    expect((await f.libsql.execute('select id from template_folder_assignments')).rows).toHaveLength(2);
    expect((await f.libsql.execute('select * from __drizzle_migrations')).rows).toEqual([]);
    expect((await f.libsql.execute("select name from sqlite_master where name='note_creation_requests'")).rows).toEqual(
      []
    );
  });
  it('snapshot changes only the three approved additions', async () => {
    const old = JSON.parse(await readFile('drizzle/meta/0042_snapshot.json', 'utf8')),
      next = JSON.parse(await readFile('drizzle/meta/0043_snapshot.json', 'utf8'));
    const { note_creation_requests, template_default_state, template_folder_assignments, ...tables } = next.tables;
    const { template_folder_assignments: previous, ...unchanged } = old.tables;
    expect(tables).toEqual(unchanged);
    for (const [key, value] of Object.entries(previous.columns))
      expect(template_folder_assignments.columns[key]).toEqual(value);
    expect(note_creation_requests).toBeDefined();
    expect(template_default_state).toBeDefined();
    expect(next.prevId).toBe(old.id);
  });
});
