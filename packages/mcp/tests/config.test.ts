import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient, loadConfig, NotesConfigurationError } from '../src/config';

describe('config', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads API URL and key from env', () => {
    expect(loadConfig({ NOTES_API_URL: 'https://example.com/api', NOTES_API_KEY: 'key' })).toEqual({
      apiUrl: 'https://example.com/api',
      apiKey: 'key',
    });
  });

  it('requires API URL and key', () => {
    expect(() => loadConfig({ NOTES_API_KEY: 'key' })).toThrow(NotesConfigurationError);
    expect(() => loadConfig({ NOTES_API_URL: 'https://example.com/api' })).toThrow(NotesConfigurationError);
  });

  it.each([
    ['https://example.com', 'https://example.com/v1/harness/folders'],
    ['https://example.com/', 'https://example.com/v1/harness/folders'],
    ['https://example.com/api', 'https://example.com/v1/harness/folders'],
    ['https://example.com/v1', 'https://example.com/v1/harness/folders'],
  ])('calls v1 harness endpoints for NOTES_API_URL=%s', async (apiUrl, expectedUrl) => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ folders: [] }), { headers: { 'content-type': 'application/json' } })
    );
    vi.stubGlobal('fetch', fetchMock);

    await createClient({ NOTES_API_URL: apiUrl, NOTES_API_KEY: 'key' }).folders.list();

    expect(fetchMock).toHaveBeenCalledWith(
      expectedUrl,
      expect.objectContaining({ headers: expect.objectContaining({ 'x-api-key': 'key' }) })
    );
  });

  it('forwards cursor pagination query parameters', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({}), { headers: { 'content-type': 'application/json' } })
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = createClient({ NOTES_API_URL: 'https://example.com', NOTES_API_KEY: 'key' });

    await client.folders.list({ limit: 10, cursor: 'folder cursor' });
    await client.notes.search({ query: 'project plan', tag: 'release', limit: 5, cursor: 'search cursor' });
    await client.notes.searchLines({ query: 'todo', cursor: 'line cursor' });
    await client.tags.list({ limit: 20, cursor: 'tag cursor' });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://example.com/v1/harness/folders?limit=10&cursor=folder+cursor',
      'https://example.com/v1/harness/notes/search?q=project+plan&tag=release&limit=5&cursor=search+cursor',
      'https://example.com/v1/harness/notes/search-lines?q=todo&cursor=line+cursor',
      'https://example.com/v1/harness/tags?limit=20&cursor=tag+cursor',
    ]);
  });

  it('calls canvas lifecycle endpoints with matching payloads', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ note: { id: 'canvas-1' } }), { headers: { 'content-type': 'application/json' } })
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = createClient({ NOTES_API_URL: 'https://example.com', NOTES_API_KEY: 'key' });
    const canvas = { nodes: [], edges: [] };

    await client.canvases.create({ folderId: 'folder-1', title: 'Flow', canvas });
    await client.canvases.createFromSyntax({
      folderId: 'folder-1',
      syntax: 'diagram "Flow" { A > B }',
      format: 'auto',
    });
    await client.canvases.replace('canvas/1', { baseHash: 'hash', canvas });
    await client.canvases.replaceFromSyntax('canvas/1', {
      baseHash: 'hash',
      syntax: 'flowchart LR\n  A --> C',
      format: 'mermaid',
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://example.com/v1/harness/canvases',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ folderId: 'folder-1', title: 'Flow', canvas }) })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://example.com/v1/harness/canvases/from-syntax',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ folderId: 'folder-1', syntax: 'diagram "Flow" { A > B }', format: 'auto' }),
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://example.com/v1/harness/notes/canvas%2F1/canvas',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ baseHash: 'hash', canvas }) })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      'https://example.com/v1/harness/notes/canvas%2F1/canvas/from-syntax',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ baseHash: 'hash', syntax: 'flowchart LR\n  A --> C', format: 'mermaid' }),
      })
    );
  });

  it('calls focused canvas note-link endpoints', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ noteId: 'canvas-1' }), { headers: { 'content-type': 'application/json' } })
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = createClient({ NOTES_API_URL: 'https://example.com', NOTES_API_KEY: 'key' });

    await client.canvases.setNoteLink('canvas/1', 'node/1', { targetNoteId: 'note-1', baseHash: 'hash' });
    await client.canvases.removeNoteLink('canvas/1', 'node/1', 'next hash');

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://example.com/v1/harness/notes/canvas%2F1/canvas/nodes/node%2F1/link-note',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ targetNoteId: 'note-1', baseHash: 'hash' }),
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://example.com/v1/harness/notes/canvas%2F1/canvas/nodes/node%2F1/link?baseHash=next+hash',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('calls Review comment lifecycle endpoints', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({}), { headers: { 'content-type': 'application/json' } })
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = createClient({ NOTES_API_URL: 'https://example.com', NOTES_API_KEY: 'key' });
    const anchor = { anchorType: 'range' as const, from: 0, to: 4, quote: 'Body', documentHash: 'hash' };

    await client.comments.list('note/1');
    await client.comments.create('note/1', { body: 'Review', anchor });
    await client.comments.reply('note/1', 'thread/1', 'Reply');
    await client.comments.updateAnchor('note/1', 'thread/1', anchor);
    await client.comments.setStatus('note/1', 'thread/1', 'resolved');
    await client.comments.updateMessage('note/1', 'thread/1', 'message/1', 'Updated');
    await client.comments.deleteMessage('note/1', 'thread/1', 'message/1');
    await client.comments.deleteThread('note/1', 'thread/1');

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://example.com/v1/harness/notes/note%2F1/comments',
      'https://example.com/v1/harness/notes/note%2F1/comments',
      'https://example.com/v1/harness/notes/note%2F1/comments/thread%2F1/replies',
      'https://example.com/v1/harness/notes/note%2F1/comments/thread%2F1/anchor',
      'https://example.com/v1/harness/notes/note%2F1/comments/thread%2F1/resolve',
      'https://example.com/v1/harness/notes/note%2F1/comments/thread%2F1/messages/message%2F1',
      'https://example.com/v1/harness/notes/note%2F1/comments/thread%2F1/messages/message%2F1',
      'https://example.com/v1/harness/notes/note%2F1/comments/thread%2F1',
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://example.com/v1/harness/notes/note%2F1/comments',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ body: 'Review', anchor }) })
    );
  });

  it('calls outline, event, and tag endpoints', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({}), { headers: { 'content-type': 'application/json' } })
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = createClient({ NOTES_API_URL: 'https://example.com', NOTES_API_KEY: 'key' });

    await client.notes.outline('note/1');
    await client.notes.events('note/1', 10);
    await client.tags.list();
    await client.notes.tags('note/1');
    await client.notes.replaceTags('note/1', ['release']);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://example.com/v1/harness/notes/note%2F1/outline',
      'https://example.com/v1/harness/notes/note%2F1/events?limit=10',
      'https://example.com/v1/harness/tags',
      'https://example.com/v1/harness/notes/note%2F1/tags',
      'https://example.com/v1/harness/notes/note%2F1/tags',
    ]);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://example.com/v1/harness/notes/note%2F1/tags',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ tags: ['release'] }) })
    );
  });

  it('moves notes through the v1 harness endpoint', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ targetFolderId: 'folder-2', notes: [] }), {
          headers: { 'content-type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    await createClient({ NOTES_API_URL: 'https://example.com', NOTES_API_KEY: 'key' }).notes.move({
      noteIds: ['note-1'],
      targetFolderId: 'folder-2',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/v1/harness/notes/move',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ noteIds: ['note-1'], targetFolderId: 'folder-2' }),
      })
    );
  });
});
