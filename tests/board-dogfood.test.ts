import { readFile } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { cleanupPropertyBoardTests, setupPropertyBoardTest } from './property-board-fixtures';

afterEach(cleanupPropertyBoardTests);
// Optional sanitized metadata replay into an owned local fixture, never hosted writes.
it.skipIf(!process.env.BOARD_DOGFOOD_FIXTURE)(
  'replays ordinary tags without using them for board grouping',
  async () => {
    const fixture = JSON.parse(await readFile(process.env.BOARD_DOGFOOD_FIXTURE as string, 'utf8')) as {
      notes: Array<{ id: string; title: string; tags: string[] }>;
    };
    const f = await setupPropertyBoardTest();
    for (const note of fixture.notes) await f.addNote(note.id, note.title, note.tags, { content: '' });
    const before = (await f.libsql.execute('select * from note_tags')).rows;
    expect((await f.saveSelect()).status).toBe(200);
    const seen: string[] = [];
    for (let page = 1; ; page++) {
      const response = await f.request(f.laneUrl('unclassified', 1, 1, `&page=${page}`));
      expect(response.status).toBe(200);
      const result = await response.json();
      seen.push(...result.cards.map((c: { id: string }) => c.id));
      if (!result.hasMore) break;
    }
    expect(seen.sort()).toEqual(fixture.notes.map((n) => n.id).sort());
    expect((await f.libsql.execute('select * from note_tags')).rows).toEqual(before);
    expect((await f.libsql.execute('select * from note_events')).rows).toEqual([]);
  }
);
