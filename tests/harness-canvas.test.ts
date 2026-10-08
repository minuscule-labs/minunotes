import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
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

async function setupHarnessApp() {
  vi.resetModules();
  const dir = await mkdtemp(path.join(tmpdir(), 'notes-harness-canvas-'));
  tempDirs.push(dir);
  vi.stubEnv('TURSO_DB_URL', `file:${path.join(dir, 'test.db')}`);

  const [{ db, libsql }, schema, { harnessRoutes }] = await Promise.all([
    import('../src/api/db/client'),
    import('../src/api/db/schema'),
    import('../src/api/routes/harness'),
  ]);

  await runMigrations(libsql);

  const user = {
    id: 'user_test',
    name: 'Test User',
    email: 'test@example.com',
    emailVerified: true,
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const authorization = {
    id: 'agent_key_test',
    userId: user.id,
    canCreateFolders: true,
    canRead: true,
    canCreate: true,
    canEdit: true,
    accessMode: 'all' as const,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastUsedAt: null,
    revokedAt: null,
  };
  const apiKey = {
    ...authorization,
    authorizationId: authorization.id,
    name: 'Test key',
    uid: 'ABCDEFGH',
    hash: 'hash',
    salt: 'salt',
  };
  const folder = {
    id: 'folder_canvas',
    userId: user.id,
    parentFolderId: null,
    title: 'Canvas',
    isPrivate: false,
    isAgentReadOnly: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await db.insert(schema.user).values(user);
  await db.insert(schema.integrationAuthorizations).values(authorization);
  await db.insert(schema.apiKeys).values(apiKey);
  await db.insert(schema.folders).values(folder);

  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', user);
    c.set('session', null);
    c.set('apiKey', apiKey);
    await next();
  });
  app.route('/api/harness', harnessRoutes);

  return { app, db, schema, folder };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('harness canvas operations', () => {
  it('creates a canvas note from raw JSON', async () => {
    const { app, folder } = await setupHarnessApp();
    const canvas = { nodes: [{ id: 'a', type: 'text', text: 'A', x: 0, y: 0, width: 120, height: 48 }], edges: [] };

    const response = await app.request('/api/harness/canvases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId: folder.id, title: 'Raw canvas', canvas }),
    });

    expect(response.status).toBe(201);
    const { note } = (await response.json()) as {
      note: { id: string; title: string; documentType: string; content?: string };
    };
    expect(note.title).toBe('Raw canvas');
    expect(note.documentType).toBe('canvas.default');
    expect(note.content).toBeUndefined();

    const read = await app.request(`/api/harness/notes/${note.id}`);
    expect(read.status).toBe(200);
    const { note: fullNote } = (await read.json()) as { note: { content: string } };
    expect(JSON.parse(fullNote.content)).toEqual(canvas);
  });

  it('creates a mind map note from diagram syntax', async () => {
    const { app, folder } = await setupHarnessApp();

    const response = await app.request('/api/harness/canvases/from-syntax', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        folderId: folder.id,
        syntax: `diagram "Product plan" {\n  layout mindmap\n  Product\n  Product > Research\n  Product > Build\n}`,
      }),
    });

    expect(response.status).toBe(201);
    const { note, diagnostics } = (await response.json()) as {
      note: { id: string; title: string; documentType: string; content?: string };
      diagnostics: unknown[];
    };
    expect(note.title).toBe('Product plan');
    expect(note.documentType).toBe('canvas.mindmap');
    expect(note.content).toBeUndefined();
    expect(diagnostics).toEqual([]);

    const read = await app.request(`/api/harness/notes/${note.id}`);
    expect(read.status).toBe(200);
    const { note: fullNote } = (await read.json()) as { note: { content: string } };
    const canvas = JSON.parse(fullNote.content) as {
      nodes: Array<{ id: string; text?: string }>;
      edges: Array<{ fromNode: string; toNode: string }>;
    };
    expect(canvas.nodes.map((node) => node.id)).toEqual(expect.arrayContaining(['Product', 'Research', 'Build']));
    expect(canvas.edges).toEqual(
      expect.arrayContaining([expect.objectContaining({ fromNode: 'Product', toNode: 'Research' })])
    );
  });

  it('auto-detects Mermaid flowcharts and persists editable native canvas data', async () => {
    const { app, folder } = await setupHarnessApp();
    const syntax = `flowchart LR
  start["Start"] --> decision{Approved?}
  decision -->|yes| done([Done])
  decision -. retry .-> start`;

    const response = await app.request('/api/harness/canvases/from-syntax', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId: folder.id, title: 'Mermaid flow', syntax }),
    });

    expect(response.status).toBe(201);
    const { note, diagnostics } = (await response.json()) as {
      note: { id: string; title: string; documentType: string };
      diagnostics: unknown[];
    };
    expect(note).toMatchObject({ title: 'Mermaid flow', documentType: 'canvas.default' });
    expect(diagnostics).toEqual([]);

    const read = await app.request(`/api/harness/notes/${note.id}`);
    const { note: fullNote } = (await read.json()) as { note: { content: string } };
    const canvas = JSON.parse(fullNote.content) as {
      nodes: Array<{ id: string; shape?: string; text?: string }>;
      edges: Array<{ fromNode: string; toNode: string; label?: string; style?: { strokeStyle?: string } }>;
    };
    expect(canvas.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'start', shape: 'rectangle', text: 'Start' }),
        expect.objectContaining({ id: 'decision', shape: 'diamond' }),
        expect.objectContaining({ id: 'done', shape: 'pill' }),
      ])
    );
    expect(canvas.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromNode: 'decision', toNode: 'done', label: 'yes' }),
        expect.objectContaining({
          fromNode: 'decision',
          toNode: 'start',
          label: 'retry',
          style: { routing: 'elbow', strokeStyle: 'dotted' },
        }),
      ])
    );
  });

  it('keeps Minu identifiers named graph and flowchart in auto mode', async () => {
    const { app, folder } = await setupHarnessApp();

    for (const identifier of ['graph', 'flowchart']) {
      const response = await app.request('/api/harness/canvases/from-syntax', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folderId: folder.id, syntax: `${identifier} > End` }),
      });

      expect(response.status).toBe(201);
      const { note } = (await response.json()) as { note: { id: string } };
      const read = await app.request(`/api/harness/notes/${note.id}`);
      const { note: fullNote } = (await read.json()) as { note: { content: string } };
      expect(JSON.parse(fullNote.content)).toMatchObject({
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: identifier }),
          expect.objectContaining({ id: 'End' }),
        ]),
        edges: expect.arrayContaining([expect.objectContaining({ fromNode: identifier, toNode: 'End' })]),
      });
    }
  });

  it('honors explicit Minu and Mermaid syntax format overrides', async () => {
    const { app, db, schema, folder } = await setupHarnessApp();
    const cases = [
      { format: 'mermaid', syntax: 'graph > End' },
      { format: 'minu', syntax: 'graph TD\\n  source --> target' },
    ];

    for (const { format, syntax } of cases) {
      const response = await app.request('/api/harness/canvases/from-syntax', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folderId: folder.id, syntax, format }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'Diagram syntax has errors' });
    }

    expect(await db.select().from(schema.notes)).toEqual([]);
  });

  it('replaces a canvas from explicitly selected Mermaid syntax', async () => {
    const { app } = await setupHarnessApp();
    const create = await app.request('/api/harness/canvases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId: 'folder_canvas', title: 'Before', canvas: { nodes: [], edges: [] } }),
    });
    const created = (await create.json()) as { note: { id: string } };

    const replace = await app.request(`/api/harness/notes/${created.note.id}/canvas/from-syntax`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        format: 'mermaid',
        syntax: 'graph TD\n  source --> target',
      }),
    });

    expect(replace.status).toBe(200);
    const read = await app.request(`/api/harness/notes/${created.note.id}`);
    const { note } = (await read.json()) as { note: { content: string } };
    expect(JSON.parse(note.content)).toMatchObject({
      nodes: expect.arrayContaining([
        expect.objectContaining({ id: 'source' }),
        expect.objectContaining({ id: 'target' }),
      ]),
      edges: [expect.objectContaining({ fromNode: 'source', toNode: 'target', toEnd: 'arrow' })],
    });
  });

  it('rejects Mermaid flowcharts requested as mind maps', async () => {
    const { app, db, schema, folder } = await setupHarnessApp();

    const response = await app.request('/api/harness/canvases/from-syntax', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        folderId: folder.id,
        format: 'mermaid',
        documentType: 'canvas.mindmap',
        syntax: 'flowchart LR\n  source --> target',
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { diagnostics: Array<{ code?: string; severity: string }> };
    expect(body.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: 'error', code: 'unsupported_diagram' })])
    );
    expect(await db.select().from(schema.notes)).toEqual([]);
  });

  it('rejects unsupported Mermaid flowchart features without creating a canvas', async () => {
    const { app, db, schema, folder } = await setupHarnessApp();

    const response = await app.request('/api/harness/canvases/from-syntax', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        folderId: folder.id,
        syntax: 'flowchart LR\n  A --> B\n  style A fill:#f00',
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      diagnostics: Array<{ severity: string; code?: string; line?: number; column?: number }>;
    };
    expect(body.error).toBe('Diagram syntax has errors');
    expect(body.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'error', code: 'unsupported_feature', line: 3, column: 3 }),
      ])
    );
    expect(await db.select().from(schema.notes)).toEqual([]);
  });

  it('rejects an unknown syntax format without creating a canvas', async () => {
    const { app, db, schema, folder } = await setupHarnessApp();

    const response = await app.request('/api/harness/canvases/from-syntax', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId: folder.id, syntax: 'diagram { A > B }', format: 'unknown' }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Format must be auto, minu, or mermaid' });
    expect(await db.select().from(schema.notes)).toEqual([]);
  });

  it('rejects an unsupported canvas document type before Mermaid compilation', async () => {
    const { app, db, schema, folder } = await setupHarnessApp();

    const response = await app.request('/api/harness/canvases/from-syntax', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        folderId: folder.id,
        format: 'mermaid',
        documentType: 'unknown',
        syntax: 'flowchart LR\n  source --> target',
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Document type must be canvas.default or canvas.mindmap',
    });
    expect(await db.select().from(schema.notes)).toEqual([]);
  });

  it('rejects malformed syntax with line-specific diagnostics without creating a canvas', async () => {
    const { app, db, schema, folder } = await setupHarnessApp();

    const response = await app.request('/api/harness/canvases/from-syntax', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        folderId: folder.id,
        syntax: `diagram "Feed flow" {
  direction right
  node upload "Bulk feed upload" shape card
  s3 [label: "Load from S3", shape: card]
  upload -> s3
}`,
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      diagnostics: Array<{ severity: string; code?: string; line?: number; message: string }>;
    };
    expect(body.error).toBe('Diagram syntax has errors');
    expect(body.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'error', line: 3, code: 'unsupported_statement' }),
        expect.objectContaining({ severity: 'error', line: 5, code: 'unsupported_operator' }),
      ])
    );
    expect(await db.select().from(schema.notes)).toEqual([]);
  });

  it('compiles valid branching syntax without literal declaration or operator nodes', async () => {
    const { app, folder } = await setupHarnessApp();

    const response = await app.request('/api/harness/canvases/from-syntax', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        folderId: folder.id,
        syntax: `diagram "Feed flow" {
  direction right
  upload [label: "Bulk feed upload", shape: card]
  outcome [label: "Batch succeeded?", shape: diamond]
  upload > outcome
  outcome > success: yes
  outcome > failed: no
}`,
      }),
    });

    expect(response.status).toBe(201);
    const created = (await response.json()) as { note: { id: string } };
    const read = await app.request(`/api/harness/notes/${created.note.id}`);
    const body = (await read.json()) as { note: { content: string } };
    const canvas = JSON.parse(body.note.content) as {
      nodes: Array<{ id: string; x: number; y: number }>;
      edges: Array<{ fromNode: string; toNode: string }>;
    };
    expect(canvas.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining(['upload', 'outcome', 'success', 'failed'])
    );
    expect(canvas.nodes).toHaveLength(4);
    expect(canvas.edges).toHaveLength(3);
    expect(canvas.nodes.find((node) => node.id === 'success')?.y).not.toBe(
      canvas.nodes.find((node) => node.id === 'failed')?.y
    );
  });

  it('does not replace an existing canvas when syntax is malformed', async () => {
    const { app, db, schema, folder } = await setupHarnessApp();
    const original = { nodes: [{ id: 'original', type: 'text', text: 'Original' }], edges: [] };
    const create = await app.request('/api/harness/canvases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId: folder.id, title: 'Original canvas', canvas: original }),
    });
    const created = (await create.json()) as { note: { id: string } };

    const replace = await app.request(`/api/harness/notes/${created.note.id}/canvas/from-syntax`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ syntax: 'original -> replacement' }),
    });

    expect(replace.status).toBe(400);
    const [stored] = await db.select().from(schema.notes).where(eq(schema.notes.id, created.note.id));
    expect(JSON.parse(stored.content)).toEqual(original);
  });

  it('links, changes, and unlinks canvas nodes while preserving external URLs and metadata', async () => {
    const { app, folder } = await setupHarnessApp();
    const createTarget = async (title: string) => {
      const response = await app.request('/api/harness/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folderId: folder.id, title }),
      });
      expect(response.status).toBe(201);
      return (await response.json()) as { note: { id: string } };
    };
    const firstTarget = await createTarget('First target');
    const secondTarget = await createTarget('Second target');

    const canvasCreate = await app.request('/api/harness/canvases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        folderId: folder.id,
        title: 'Linked canvas',
        canvas: {
          nodes: [
            {
              id: 'node_a',
              type: 'text',
              x: 0,
              y: 0,
              width: 160,
              height: 80,
              url: 'https://example.com/source',
              minunotes: { status: 'keep' },
            },
          ],
          edges: [],
        },
      }),
    });
    expect(canvasCreate.status).toBe(201);
    const created = (await canvasCreate.json()) as { note: { id: string }; contentHash: string };

    const link = await app.request(`/api/harness/notes/${created.note.id}/canvas/nodes/node_a/link-note`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetNoteId: firstTarget.note.id, baseHash: created.contentHash }),
    });
    expect(link.status).toBe(200);
    const linked = (await link.json()) as { note: { content?: string }; contentHash: string };
    expect(linked.note.content).toBeUndefined();

    const change = await app.request(`/api/harness/notes/${created.note.id}/canvas/nodes/node_a/link-note`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetNoteId: secondTarget.note.id, baseHash: linked.contentHash }),
    });
    expect(change.status).toBe(200);
    const changed = (await change.json()) as { note: { content?: string }; contentHash: string };
    expect(changed.note.content).toBeUndefined();

    const readLinked = await app.request(`/api/harness/notes/${created.note.id}`);
    const readLinkedBody = (await readLinked.json()) as { note: { content: string } };
    expect(JSON.parse(readLinkedBody.note.content).nodes[0]).toMatchObject({
      text: 'First target',
      url: 'https://example.com/source',
      minunotes: { status: 'keep', link: { type: 'note', id: secondTarget.note.id } },
    });

    const backlinks = await app.request(`/api/harness/notes/${secondTarget.note.id}/backlinks`);
    expect(backlinks.status).toBe(200);
    await expect(backlinks.json()).resolves.toMatchObject({
      backlinks: [expect.objectContaining({ sourceNoteId: created.note.id, linkType: 'canvas-note' })],
    });

    const unlink = await app.request(
      `/api/harness/notes/${created.note.id}/canvas/nodes/node_a/link?baseHash=${encodeURIComponent(changed.contentHash)}`,
      { method: 'DELETE' }
    );
    expect(unlink.status).toBe(200);
    const unlinked = (await unlink.json()) as { note: { content?: string } };
    expect(unlinked.note.content).toBeUndefined();

    const readUnlinked = await app.request(`/api/harness/notes/${created.note.id}`);
    const readUnlinkedBody = (await readUnlinked.json()) as { note: { content: string } };
    expect(JSON.parse(readUnlinkedBody.note.content).nodes[0]).toMatchObject({
      url: 'https://example.com/source',
      minunotes: { status: 'keep' },
    });
    expect(JSON.parse(readUnlinkedBody.note.content).nodes[0].minunotes.link).toBeUndefined();
  });

  it('hides out-of-scope canvas links and prevents mutations from deleting them', async () => {
    const { app, db, schema, folder } = await setupHarnessApp();
    const now = new Date();
    const hiddenFolder = {
      id: 'folder_hidden',
      userId: 'user_test',
      parentFolderId: null,
      title: 'Hidden',
      isPrivate: true,
      isAgentReadOnly: false,
      createdAt: now,
      updatedAt: now,
    };
    const hiddenTarget = {
      id: 'note_hiddentarget',
      userId: 'user_test',
      folderId: hiddenFolder.id,
      title: 'Hidden target',
      content: 'secret',
      documentType: 'markdown' as const,
      type: 'note' as const,
      isApiEditable: true,
      createdAt: now,
      updatedAt: now,
    };
    const rawCanvas = JSON.stringify({
      nodes: [
        {
          id: 'node_hidden',
          type: 'text',
          text: 'Visible node',
          minunotes: { status: 'keep', link: { type: 'note', id: hiddenTarget.id } },
        },
      ],
      edges: [],
    });
    const canvas = {
      id: 'note_canvas_hidden_link',
      userId: 'user_test',
      folderId: folder.id,
      title: 'Canvas with hidden link',
      content: rawCanvas,
      documentType: 'canvas.default' as const,
      type: 'note' as const,
      isApiEditable: true,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(schema.folders).values(hiddenFolder);
    await db.insert(schema.notes).values([hiddenTarget, canvas]);

    const read = await app.request(`/api/harness/notes/${canvas.id}`);
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as { note: { content: string }; contentHash: string };
    expect(readBody).not.toHaveProperty('hiddenCanvasLinkCount');
    expect(readBody).not.toHaveProperty('rawContentHash');
    expect(readBody.note.content).not.toContain(hiddenTarget.id);
    expect(JSON.parse(readBody.note.content).nodes[0]).toMatchObject({ minunotes: { status: 'keep' } });

    const replace = await app.request(`/api/harness/notes/${canvas.id}/canvas`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseHash: readBody.contentHash,
        canvas: { nodes: [{ id: 'replacement', type: 'text', text: 'Replacement' }], edges: [] },
      }),
    });
    expect(replace.status).toBe(403);

    const unlink = await app.request(
      `/api/harness/notes/${canvas.id}/canvas/nodes/node_hidden/link?baseHash=${readBody.contentHash}`,
      { method: 'DELETE' }
    );
    expect(unlink.status).toBe(403);

    const createWithHiddenLink = await app.request('/api/harness/canvases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId: folder.id, canvas: JSON.parse(rawCanvas) }),
    });
    expect(createWithHiddenLink.status).toBe(403);

    const [stored] = await db.select().from(schema.notes).where(eq(schema.notes.id, canvas.id));
    expect(stored.content).toBe(rawCanvas);
  });

  it('validates canvas node link targets, node ids, document types, editability, and content hashes', async () => {
    const { app, db, schema, folder } = await setupHarnessApp();
    const targetResponse = await app.request('/api/harness/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId: folder.id, title: 'Target' }),
    });
    const target = (await targetResponse.json()) as { note: { id: string } };
    const canvasResponse = await app.request('/api/harness/canvases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        folderId: folder.id,
        canvas: { nodes: [{ id: 'node_a', type: 'text', x: 0, y: 0, width: 160, height: 80 }], edges: [] },
      }),
    });
    const canvas = (await canvasResponse.json()) as { note: { id: string } };

    const requestLink = (noteId: string, nodeId: string, targetNoteId: string, baseHash?: string) =>
      app.request(`/api/harness/notes/${noteId}/canvas/nodes/${nodeId}/link-note`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetNoteId, baseHash }),
      });

    expect((await requestLink(canvas.note.id, 'missing', target.note.id)).status).toBe(404);
    expect((await requestLink(canvas.note.id, 'node_a', 'note_missing123')).status).toBe(404);
    expect((await requestLink(canvas.note.id, 'node_a', target.note.id, 'stale-hash')).status).toBe(409);

    const markdownResponse = await app.request('/api/harness/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId: folder.id, title: 'Markdown' }),
    });
    const markdown = (await markdownResponse.json()) as { note: { id: string } };
    expect((await requestLink(markdown.note.id, 'node_a', target.note.id)).status).toBe(400);
    expect((await requestLink(canvas.note.id, 'node_a', canvas.note.id)).status).toBe(400);

    await db.update(schema.notes).set({ isApiEditable: false }).where(eq(schema.notes.id, canvas.note.id));
    expect((await requestLink(canvas.note.id, 'node_a', target.note.id)).status).toBe(403);
  });

  it('does not disclose or link targets outside the API key read scope', async () => {
    const { app, db, schema, folder } = await setupHarnessApp();
    const privateFolder = {
      id: 'folder_private',
      userId: 'user_test',
      parentFolderId: null,
      title: 'Private',
      isPrivate: true,
      isAgentReadOnly: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await db.insert(schema.folders).values(privateFolder);
    await db.insert(schema.notes).values({
      id: 'note_private123',
      userId: 'user_test',
      folderId: privateFolder.id,
      title: 'Secret target title',
      content: 'secret',
      documentType: 'markdown',
      type: 'note',
      isApiEditable: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const canvasResponse = await app.request('/api/harness/canvases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        folderId: folder.id,
        canvas: { nodes: [{ id: 'node_a', type: 'text', x: 0, y: 0, width: 160, height: 80 }], edges: [] },
      }),
    });
    const canvas = (await canvasResponse.json()) as { note: { id: string } };

    const response = await app.request(`/api/harness/notes/${canvas.note.id}/canvas/nodes/node_a/link-note`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetNoteId: 'note_private123' }),
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Target note not found' });

    const replace = await app.request(`/api/harness/notes/${canvas.note.id}/canvas`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        canvas: {
          nodes: [
            {
              id: 'node_a',
              type: 'text',
              text: 'Known label',
              x: 0,
              y: 0,
              width: 160,
              height: 80,
              minunotes: { link: { type: 'note', id: 'note_private123' } },
            },
          ],
          edges: [],
        },
      }),
    });
    expect(replace.status).toBe(403);
    await expect(replace.json()).resolves.toEqual({ error: 'Canvas contains inaccessible note links' });

    const links = await app.request(`/api/harness/notes/${canvas.note.id}/links`);
    expect(links.status).toBe(200);
    await expect(links.json()).resolves.toMatchObject({ links: [] });
  });

  it('replaces a canvas note from diagram syntax and rejects markdown patch edits', async () => {
    const { app, folder } = await setupHarnessApp();
    const create = await app.request('/api/harness/canvases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId: folder.id, title: 'Flow' }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { note: { id: string } };

    const replace = await app.request(`/api/harness/notes/${created.note.id}/canvas/from-syntax`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ syntax: `diagram "Auth flow" {\n  User > Login\n  Login > Dashboard\n}` }),
    });
    expect(replace.status).toBe(200);
    const replaced = (await replace.json()) as { note: { title: string; documentType: string; content?: string } };
    expect(replaced.note.title).toBe('Auth flow');
    expect(replaced.note.documentType).toBe('canvas.default');
    expect(replaced.note.content).toBeUndefined();

    const read = await app.request(`/api/harness/notes/${created.note.id}`);
    expect(read.status).toBe(200);
    const { note: fullNote } = (await read.json()) as { note: { content: string } };
    expect(JSON.parse(fullNote.content).nodes.map((node: { id: string }) => node.id)).toEqual(
      expect.arrayContaining(['User', 'Login', 'Dashboard'])
    );

    const patch = await app.request(`/api/harness/notes/${created.note.id}/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ edits: [{ type: 'append', text: 'nope' }] }),
    });
    expect(patch.status).toBe(400);
  });
});
