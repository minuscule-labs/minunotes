import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Hono } from 'hono';

const DEFAULT_SIZES = [25, 100, 500, 1_000];
const DEFAULT_ITERATIONS = 3;
const DEFAULT_CHILD_FOLDERS = 100;
const NESTED_GRANT_DEPTH = 6;
const OWNER_ID = 'user_navigation_benchmark_owner';
const COLLABORATOR_ID = 'user_navigation_benchmark_collaborator';
const SHARED_ROOT_ID = 'folder_navigation_shared_root';
const NOTE_CONTAINER_ID = 'folder_navigation_note_container';
const OWNED_FOLDER_ID = 'folder_navigation_owned_000000';
const NOISE_USER_IDS = Array.from({ length: 9 }, (_, index) => `user_navigation_noise_${index}`);
const TIMESTAMP = 1_735_689_600;

type SqlStatement = string | { sql: string; args?: Array<string | number | null> };
type SqlClient = {
  batch: (statements: Array<{ sql: string; args: Array<string | number | null> }>, mode?: 'write') => Promise<unknown>;
  execute: (statement: SqlStatement) => Promise<{ rows: unknown[] }>;
  executeMultiple: (sql: string) => Promise<unknown>;
};
type Counter = {
  calls: number;
  rows: number;
  databaseMilliseconds: number[];
  queries: Array<{ milliseconds: number; statement: string }>;
};
type Measurement = {
  name: string;
  firstMs: number;
  warmMedianMs: number;
  warmP95Ms: number;
  databaseCalls: number;
  databaseRows: number;
  databaseP95Ms: number;
  slowestDatabaseQueries: Array<{ milliseconds: number; statement: string }>;
  responseBytes: number;
  results: number;
};

function integerArgument(name: string, fallback: number) {
  const prefix = `--${name}=`;
  const raw = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
}

function sizesArgument() {
  const raw = process.argv.find((argument) => argument.startsWith('--sizes='))?.slice('--sizes='.length);
  if (!raw) return DEFAULT_SIZES;
  const sizes = raw.split(',').map((value) => Number.parseInt(value.trim(), 10));
  if (sizes.length === 0 || sizes.some((value) => !Number.isFinite(value) || value < 2))
    throw new Error('--sizes must contain comma-separated integers of at least 2');
  return [...new Set(sizes)].sort((left, right) => left - right);
}

function percentile(values: number[], quantile: number) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

async function applyMigrations(client: SqlClient) {
  const { glob } = await import('node:fs/promises');
  const files = await Array.fromAsync(glob('drizzle/[0-9][0-9][0-9][0-9]_*.sql'));
  for (const file of files.sort()) await client.executeMultiple(await readFile(file, 'utf8'));
}

async function insertInBatches(
  client: SqlClient,
  statements: Array<{ sql: string; args: Array<string | number | null> }>,
  batchSize = 200
) {
  for (let start = 0; start < statements.length; start += batchSize)
    await client.batch(statements.slice(start, start + batchSize), 'write');
}

async function seedPrincipals(client: SqlClient) {
  const noiseUsers = NOISE_USER_IDS.map(
    (id, index) =>
      `('${id}', 'Noise ${index}', 'navigation-noise-${index}@example.com', 1, 1735689600000, 1735689600000)`
  ).join(',\n');
  await client.executeMultiple(`
    INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES
      ('${OWNER_ID}', 'Navigation Owner', 'navigation-owner@example.com', 1, 1735689600000, 1735689600000),
      ('${COLLABORATOR_ID}', 'Navigation Collaborator', 'navigation-collaborator@example.com', 1, 1735689600000, 1735689600000),
      ${noiseUsers};

    INSERT INTO folders (
      id, user_id, parent_folder_id, title, is_private, is_agent_read_only, created_by_user_id, created_at, updated_at
    ) VALUES
      ('${SHARED_ROOT_ID}', '${OWNER_ID}', null, 'Shared root', 0, 0, '${OWNER_ID}', ${TIMESTAMP}, ${TIMESTAMP}),
      ('${NOTE_CONTAINER_ID}', '${OWNER_ID}', null, 'Directly shared notes', 0, 0, '${OWNER_ID}', ${TIMESTAMP}, ${TIMESTAMP}),
      ('${OWNED_FOLDER_ID}', '${COLLABORATOR_ID}', null, 'Owned root', 0, 0, '${COLLABORATOR_ID}', ${TIMESTAMP}, ${TIMESTAMP});

    INSERT INTO collaboration_grants (
      id, owner_user_id, grantee_user_id, folder_id, role, created_by_user_id, created_at, updated_at
    ) VALUES (
      'grant_navigation_shared_root', '${OWNER_ID}', '${COLLABORATOR_ID}', '${SHARED_ROOT_ID}',
      'editor', '${OWNER_ID}', ${TIMESTAMP}, ${TIMESTAMP}
    );
  `);
}

async function seedRows(client: SqlClient, from: number, to: number) {
  const folderStatements: Array<{ sql: string; args: Array<string | number | null> }> = [];
  const noteStatements: Array<{ sql: string; args: Array<string | number | null> }> = [];
  const grantStatements: Array<{ sql: string; args: Array<string | number | null> }> = [];

  for (let index = from; index < to; index += 1) {
    const padded = String(index).padStart(6, '0');
    folderStatements.push({
      sql: `INSERT INTO folders (
        id, user_id, parent_folder_id, title, is_private, is_agent_read_only, created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, null, ?, 0, 0, ?, ?, ?)`,
      args: [
        `folder_navigation_owned_item_${padded}`,
        COLLABORATOR_ID,
        `Owned ${padded}`,
        COLLABORATOR_ID,
        TIMESTAMP,
        TIMESTAMP,
      ],
    });
    folderStatements.push({
      sql: `INSERT INTO folders (
        id, user_id, parent_folder_id, title, is_private, is_agent_read_only, created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, null, ?, 0, 0, ?, ?, ?)`,
      args: [`folder_navigation_shared_${padded}`, OWNER_ID, `Shared ${padded}`, OWNER_ID, TIMESTAMP, TIMESTAMP],
    });
    for (const [noiseIndex, noiseUserId] of NOISE_USER_IDS.entries())
      folderStatements.push({
        sql: `INSERT INTO folders (
          id, user_id, parent_folder_id, title, is_private, is_agent_read_only, created_by_user_id, created_at, updated_at
        ) VALUES (?, ?, null, ?, 0, 0, ?, ?, ?)`,
        args: [
          `folder_navigation_noise_${noiseIndex}_${padded}`,
          noiseUserId,
          `Noise ${noiseIndex} ${padded}`,
          noiseUserId,
          TIMESTAMP,
          TIMESTAMP,
        ],
      });
    noteStatements.push({
      sql: `INSERT INTO notes (
        id, folder_id, user_id, title, content, document_type, type, is_api_editable, created_at, updated_at
      ) VALUES (?, ?, ?, ?, '', 'markdown', 'note', 1, ?, ?)`,
      args: [
        `note_navigation_owned_${padded}`,
        OWNED_FOLDER_ID,
        COLLABORATOR_ID,
        `Owned note ${padded}`,
        TIMESTAMP + index,
        TIMESTAMP + index,
      ],
    });
    noteStatements.push({
      sql: `INSERT INTO notes (
        id, folder_id, user_id, title, content, document_type, type, is_api_editable, created_at, updated_at
      ) VALUES (?, ?, ?, ?, '', 'markdown', 'note', 1, ?, ?)`,
      args: [
        `note_navigation_shared_${padded}`,
        NOTE_CONTAINER_ID,
        OWNER_ID,
        `Shared note ${padded}`,
        TIMESTAMP + index,
        TIMESTAMP + index,
      ],
    });
    grantStatements.push({
      sql: `INSERT INTO collaboration_grants (
        id, owner_user_id, grantee_user_id, folder_id, role, created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'editor', ?, ?, ?)`,
      args: [
        `grant_navigation_folder_${padded}`,
        OWNER_ID,
        COLLABORATOR_ID,
        `folder_navigation_shared_${padded}`,
        OWNER_ID,
        TIMESTAMP,
        TIMESTAMP,
      ],
    });
    grantStatements.push({
      sql: `INSERT INTO collaboration_grants (
        id, owner_user_id, grantee_user_id, note_id, role, created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'viewer', ?, ?, ?)`,
      args: [
        `grant_navigation_note_${padded}`,
        OWNER_ID,
        COLLABORATOR_ID,
        `note_navigation_shared_${padded}`,
        OWNER_ID,
        TIMESTAMP,
        TIMESTAMP,
      ],
    });
    for (const [noiseIndex, noiseUserId] of NOISE_USER_IDS.entries()) {
      grantStatements.push({
        sql: `INSERT INTO collaboration_grants (
          id, owner_user_id, grantee_user_id, folder_id, role, created_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'editor', ?, ?, ?)`,
        args: [
          `grant_navigation_noise_folder_${noiseIndex}_${padded}`,
          OWNER_ID,
          noiseUserId,
          `folder_navigation_shared_${padded}`,
          OWNER_ID,
          TIMESTAMP,
          TIMESTAMP,
        ],
      });
      grantStatements.push({
        sql: `INSERT INTO collaboration_grants (
          id, owner_user_id, grantee_user_id, note_id, role, created_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'viewer', ?, ?, ?)`,
        args: [
          `grant_navigation_noise_note_${noiseIndex}_${padded}`,
          OWNER_ID,
          noiseUserId,
          `note_navigation_shared_${padded}`,
          OWNER_ID,
          TIMESTAMP,
          TIMESTAMP,
        ],
      });
    }
  }

  await insertInBatches(client, folderStatements);
  await insertInBatches(client, noteStatements);
  await insertInBatches(client, grantStatements);
}

async function seedNestedGrantedFolders(client: SqlClient) {
  let parentFolderId = SHARED_ROOT_ID;
  const folderStatements: Array<{ sql: string; args: Array<string | number | null> }> = [];
  const grantStatements: Array<{ sql: string; args: Array<string | number | null> }> = [];
  for (let index = 0; index < NESTED_GRANT_DEPTH; index += 1) {
    const padded = String(index).padStart(2, '0');
    const folderId = `folder_navigation_nested_${padded}`;
    folderStatements.push({
      sql: `INSERT INTO folders (
        id, user_id, parent_folder_id, title, is_private, is_agent_read_only, created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?)`,
      args: [folderId, OWNER_ID, parentFolderId, `Nested ${padded}`, OWNER_ID, TIMESTAMP, TIMESTAMP],
    });
    grantStatements.push({
      sql: `INSERT INTO collaboration_grants (
        id, owner_user_id, grantee_user_id, folder_id, role, created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'viewer', ?, ?, ?)`,
      args: [`grant_navigation_nested_${padded}`, OWNER_ID, COLLABORATOR_ID, folderId, OWNER_ID, TIMESTAMP, TIMESTAMP],
    });
    parentFolderId = folderId;
  }
  await insertInBatches(client, folderStatements);
  await insertInBatches(client, grantStatements);
}

async function seedChildFolders(client: SqlClient, count: number) {
  const statements = Array.from({ length: count }, (_, index) => {
    const padded = String(index).padStart(6, '0');
    return {
      sql: `INSERT INTO folders (
        id, user_id, parent_folder_id, title, is_private, is_agent_read_only, created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?)`,
      args: [
        `folder_navigation_child_${padded}`,
        OWNER_ID,
        SHARED_ROOT_ID,
        `Child ${padded}`,
        OWNER_ID,
        TIMESTAMP,
        TIMESTAMP,
      ],
    };
  });
  await insertInBatches(client, statements);
}

function instrumentClient(client: SqlClient, counter: Counter) {
  const mutable = client as SqlClient & Record<string, unknown>;
  const execute = client.execute.bind(client);
  const batch = client.batch.bind(client);
  mutable.execute = (async (...args: Parameters<SqlClient['execute']>) => {
    counter.calls += 1;
    const startedAt = performance.now();
    try {
      const result = await execute(...args);
      counter.rows += result.rows.length;
      return result;
    } finally {
      const milliseconds = performance.now() - startedAt;
      counter.databaseMilliseconds.push(milliseconds);
      counter.queries.push({
        milliseconds,
        statement: typeof args[0] === 'string' ? args[0] : args[0].sql,
      });
    }
  }) as SqlClient['execute'];
  mutable.batch = (async (...args: Parameters<SqlClient['batch']>) => {
    counter.calls += 1;
    const startedAt = performance.now();
    try {
      const result = await batch(...args);
      counter.rows += result.reduce((sum, item) => sum + item.rows.length, 0);
      return result;
    } finally {
      const milliseconds = performance.now() - startedAt;
      counter.databaseMilliseconds.push(milliseconds);
      counter.queries.push({ milliseconds, statement: args[0].map((item) => item.sql).join('; ') });
    }
  }) as SqlClient['batch'];
}

async function measureRoute(input: {
  app: Hono;
  counter: Counter;
  name: string;
  path: string;
  actorUserId: string;
  iterations: number;
  resultKey: string;
}): Promise<Measurement> {
  const samples: Array<{
    milliseconds: number;
    calls: number;
    rows: number;
    databaseMilliseconds: number;
    queries: Array<{ milliseconds: number; statement: string }>;
    bytes: number;
    results: number;
  }> = [];
  for (let iteration = 0; iteration <= input.iterations; iteration += 1) {
    input.counter.calls = 0;
    input.counter.rows = 0;
    input.counter.databaseMilliseconds = [];
    input.counter.queries = [];
    const startedAt = performance.now();
    const response = await input.app.request(input.path, { headers: { 'x-benchmark-user': input.actorUserId } });
    const body = await response.text();
    const milliseconds = performance.now() - startedAt;
    if (!response.ok) throw new Error(`${input.name} returned ${response.status}: ${body}`);
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const results = Array.isArray(parsed[input.resultKey]) ? parsed[input.resultKey].length : 0;
    samples.push({
      milliseconds,
      calls: input.counter.calls,
      rows: input.counter.rows,
      databaseMilliseconds: input.counter.databaseMilliseconds.reduce((sum, value) => sum + value, 0),
      queries: [...input.counter.queries],
      bytes: Buffer.byteLength(body),
      results,
    });
  }
  const first = samples[0];
  const warm = samples.slice(1);
  return {
    name: input.name,
    firstMs: Number(first.milliseconds.toFixed(2)),
    warmMedianMs: Number(
      percentile(
        warm.map((sample) => sample.milliseconds),
        0.5
      ).toFixed(2)
    ),
    warmP95Ms: Number(
      percentile(
        warm.map((sample) => sample.milliseconds),
        0.95
      ).toFixed(2)
    ),
    databaseCalls: Math.max(...samples.map((sample) => sample.calls)),
    databaseRows: Math.max(...samples.map((sample) => sample.rows)),
    databaseP95Ms: Number(
      percentile(
        warm.map((sample) => sample.databaseMilliseconds),
        0.95
      ).toFixed(2)
    ),
    slowestDatabaseQueries: warm
      .flatMap((sample) => sample.queries)
      .sort((left, right) => right.milliseconds - left.milliseconds)
      .slice(0, 2)
      .map((query) => ({
        milliseconds: Number(query.milliseconds.toFixed(2)),
        statement: query.statement.replace(/\s+/gu, ' ').slice(0, 240),
      })),
    responseBytes: Math.max(...samples.map((sample) => sample.bytes)),
    results: Math.max(...samples.map((sample) => sample.results)),
  };
}

async function explainPlans(client: SqlClient) {
  const folders = await client.execute(`EXPLAIN QUERY PLAN
    SELECT * FROM folders
    WHERE user_id = '${COLLABORATOR_ID}' AND deleted_at IS NULL
    ORDER BY title`);
  const recentNotes = await client.execute(`EXPLAIN QUERY PLAN
    SELECT id, folder_id, title, document_type, updated_at
    FROM notes
    WHERE user_id = '${COLLABORATOR_ID}' AND deleted_at IS NULL AND type = 'note'
    ORDER BY updated_at DESC, id
    LIMIT 26`);
  const activeFolderPathSql = `exists (
    with recursive folder_path(id, parent_folder_id, deleted_at) as (
      select path_folder.id, path_folder.parent_folder_id, path_folder.deleted_at
      from folders as path_folder
      where path_folder.id = folders.id and path_folder.user_id = folders.user_id
      union
      select parent.id, parent.parent_folder_id, parent.deleted_at
      from folders as parent
      inner join folder_path as child on parent.id = child.parent_folder_id
      where parent.user_id = folders.user_id
    )
    select 1
    where exists (select 1 from folder_path where parent_folder_id is null)
      and not exists (select 1 from folder_path where deleted_at is not null)
  )`;
  const sharedCollaborations = await client.execute(`EXPLAIN QUERY PLAN
    SELECT collaboration_grants.id, user.name, user.email, folders.id, folders.title, folders.updated_at
    FROM collaboration_grants
    INNER JOIN user ON collaboration_grants.owner_user_id = user.id
    INNER JOIN folders ON collaboration_grants.folder_id = folders.id
      AND collaboration_grants.owner_user_id = folders.user_id
      AND ${activeFolderPathSql}
    WHERE collaboration_grants.grantee_user_id = '${COLLABORATOR_ID}'
      AND collaboration_grants.folder_id IS NOT NULL AND folders.deleted_at IS NULL
    ORDER BY folders.updated_at DESC, collaboration_grants.id ASC
    LIMIT 26`);
  const sharedFolderRoots = await client.execute(`EXPLAIN QUERY PLAN
    SELECT collaboration_grants.id, folders.id, folders.title, user.name,
      exists (select 1 from folders as child where child.user_id = folders.user_id
        and child.parent_folder_id = folders.id and child.deleted_at is null)
    FROM collaboration_grants
    INNER JOIN user ON collaboration_grants.owner_user_id = user.id
    INNER JOIN folders ON collaboration_grants.folder_id = folders.id
      AND collaboration_grants.owner_user_id = folders.user_id
      AND ${activeFolderPathSql}
    WHERE collaboration_grants.grantee_user_id = '${COLLABORATOR_ID}'
      AND collaboration_grants.folder_id IS NOT NULL AND folders.deleted_at IS NULL
      AND NOT EXISTS (
        WITH RECURSIVE folder_ancestors(id, parent_folder_id) AS (
          SELECT parent.id, parent.parent_folder_id FROM folders AS parent
          WHERE parent.id = folders.parent_folder_id AND parent.user_id = folders.user_id
          UNION
          SELECT parent.id, parent.parent_folder_id FROM folders AS parent
          INNER JOIN folder_ancestors AS child ON parent.id = child.parent_folder_id
          WHERE parent.user_id = folders.user_id
        )
        SELECT 1 FROM folder_ancestors AS ancestor
        INNER JOIN collaboration_grants AS ancestor_grant ON ancestor_grant.folder_id = ancestor.id
        WHERE ancestor_grant.owner_user_id = collaboration_grants.owner_user_id
          AND ancestor_grant.grantee_user_id = '${COLLABORATOR_ID}'
      )
    ORDER BY user.name, folders.title, folders.id
    LIMIT 51`);
  const folderNavigationPath = await client.execute(`EXPLAIN QUERY PLAN
    WITH RECURSIVE folder_path(id, parent_folder_id, deleted_at, user_id) AS (
      SELECT id, parent_folder_id, deleted_at, user_id FROM folders WHERE id = '${SHARED_ROOT_ID}'
      UNION
      SELECT parent.id, parent.parent_folder_id, parent.deleted_at, parent.user_id
      FROM folders AS parent
      INNER JOIN folder_path AS child ON parent.id = child.parent_folder_id AND parent.user_id = child.user_id
    )
    SELECT id, parent_folder_id, deleted_at, user_id FROM folder_path`);
  const folderAccessBatchPaths = await client.execute(`EXPLAIN QUERY PLAN
    WITH RECURSIVE requested(resource_id, folder_id, user_id) AS (
      VALUES ('${SHARED_ROOT_ID}', '${SHARED_ROOT_ID}', '${OWNER_ID}')
    ), folder_path(resource_id, id, user_id, parent_folder_id, deleted_at, is_private) AS (
      SELECT requested.resource_id, target.id, target.user_id, target.parent_folder_id, target.deleted_at, target.is_private
      FROM requested
      INNER JOIN folders AS target ON target.id = requested.folder_id AND target.user_id = requested.user_id
      UNION
      SELECT child.resource_id, parent.id, parent.user_id, parent.parent_folder_id, parent.deleted_at, parent.is_private
      FROM folder_path AS child
      INNER JOIN folders AS parent ON parent.id = child.parent_folder_id AND parent.user_id = child.user_id
    )
    SELECT resource_id, id, user_id, parent_folder_id, deleted_at, is_private FROM folder_path`);
  const folderNavigationGrants = await client.execute(`EXPLAIN QUERY PLAN
    SELECT role FROM collaboration_grants
    WHERE grantee_user_id = '${COLLABORATOR_ID}' AND owner_user_id = '${OWNER_ID}'
      AND folder_id IN ('${SHARED_ROOT_ID}')`);
  const sharedChildren = await client.execute(`EXPLAIN QUERY PLAN
    SELECT id, title, parent_folder_id, updated_at, is_private, is_agent_read_only,
      exists (select 1 from folders as child where child.user_id = folders.user_id
        and child.parent_folder_id = folders.id and child.deleted_at is null)
    FROM folders
    WHERE user_id = '${OWNER_ID}' AND parent_folder_id = '${SHARED_ROOT_ID}' AND deleted_at IS NULL
    ORDER BY title, id LIMIT 101`);
  const sharedFolderDetail = await client.execute(`EXPLAIN QUERY PLAN
    SELECT * FROM folders
    WHERE user_id = '${OWNER_ID}' AND parent_folder_id = '${SHARED_ROOT_ID}' AND deleted_at IS NULL`);
  return {
    folders: folders.rows,
    recentNotes: recentNotes.rows,
    sharedCollaborations: sharedCollaborations.rows,
    sharedFolderRoots: sharedFolderRoots.rows,
    folderNavigationPath: folderNavigationPath.rows,
    folderAccessBatchPaths: folderAccessBatchPaths.rows,
    folderNavigationGrants: folderNavigationGrants.rows,
    sharedChildren: sharedChildren.rows,
    sharedFolderDetail: sharedFolderDetail.rows,
  };
}

async function main() {
  const sizes = sizesArgument();
  const iterations = integerArgument('iterations', DEFAULT_ITERATIONS);
  const childFolderCount = integerArgument('child-folders', DEFAULT_CHILD_FOLDERS);
  const directory = await mkdtemp(path.join(tmpdir(), 'minunotes-shared-navigation-'));
  process.env.TURSO_DB_URL = `file:${path.join(directory, 'benchmark.db')}`;

  try {
    const [{ libsql }, { collaborationRoutes }, { folderRoutes }, { noteRoutes }] = await Promise.all([
      import('../src/api/db/client'),
      import('../src/api/routes/collaboration'),
      import('../src/api/routes/folders'),
      import('../src/api/routes/notes'),
    ]);
    const client = libsql as unknown as SqlClient;
    await applyMigrations(client);
    await seedPrincipals(client);
    await seedChildFolders(client, childFolderCount);
    await seedNestedGrantedFolders(client);

    const app = new Hono();
    app.use('*', async (context, next) => {
      const id = context.req.header('x-benchmark-user') ?? COLLABORATOR_ID;
      const isOwner = id === OWNER_ID;
      context.set('user', {
        id,
        name: isOwner ? 'Navigation Owner' : 'Navigation Collaborator',
        email: isOwner ? 'navigation-owner@example.com' : 'navigation-collaborator@example.com',
        emailVerified: true,
        image: null,
        createdAt: new Date(1735689600000),
        updatedAt: new Date(1735689600000),
      });
      context.set('session', null);
      await next();
    });
    app.route('/folders', folderRoutes);
    app.route('/notes', noteRoutes);
    app.route('/', collaborationRoutes);

    const counter = {
      calls: 0,
      rows: 0,
      databaseMilliseconds: [] as number[],
      queries: [] as Array<{ milliseconds: number; statement: string }>,
    };
    instrumentClient(client, counter);
    let seeded = 0;
    const reports = [];
    for (const size of sizes) {
      await seedRows(client, seeded, size);
      seeded = size;
      await client.execute('PRAGMA optimize');
      const cases: Measurement[] = [];
      for (const definition of [
        {
          name: 'owned-folders-initial-load',
          path: '/folders',
          resultKey: 'folders',
        },
        {
          name: 'home-recent-notes-page',
          path: '/notes/recent?page=1&limit=25&scope=all',
          resultKey: 'notes',
        },
        {
          name: 'shared-folder-navigation-roots',
          path: '/collaborations/shared-folder-roots?limit=50',
          resultKey: 'folders',
        },
        {
          name: 'shared-with-me-folder-page',
          path: '/collaborations/shared-with-me?type=folder&limit=25',
          resultKey: 'collaborations',
        },
        {
          name: 'shared-folder-expand-children-lazy',
          path: `/folders/${SHARED_ROOT_ID}/children?limit=100`,
          resultKey: 'folders',
        },
        {
          name: 'shared-folder-detail-expansion-legacy',
          path: `/folders/${SHARED_ROOT_ID}/detail`,
          resultKey: 'childFolders',
        },
        {
          name: 'shared-with-me-full-list-settings',
          path: '/collaborations/shared-with-me',
          resultKey: 'collaborations',
        },
      ]) {
        cases.push(
          await measureRoute({
            app,
            counter,
            iterations,
            actorUserId: COLLABORATOR_ID,
            ...definition,
          })
        );
      }
      reports.push({
        directFolderGrants: size + 1 + NESTED_GRANT_DEPTH,
        directNoteGrants: size,
        nestedGrantDepth: NESTED_GRANT_DEPTH,
        unrelatedAccounts: NOISE_USER_IDS.length,
        unrelatedGrants: size * NOISE_USER_IDS.length * 2,
        ownedFolders: size + 1,
        ownedAndSharedNotes: size * 2,
        cases,
      });
    }

    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          environment: 'temporary local libSQL database',
          iterations,
          sharedChildFolders: childFolderCount,
          reports,
          queryPlans: await explainPlans(client),
        },
        null,
        2
      )
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await main();
