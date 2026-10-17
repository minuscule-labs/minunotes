import { describe, expect, it } from 'vitest';
import {
  contentReferences,
  copyBoard,
  copyContent,
  copyMarkdown,
  copySchema,
  copyValues,
} from '../src/api/folders/duplicate-content';
import { parseFolderDuplication } from '../src/shared/folder-duplication';

const ctx = {
  notes: new Map([['note_old', 'note_new']]),
  titles: new Map([
    ['Target', 'note_old'],
    ['Outside', 'note_outside'],
  ]),
  attachments: new Map([['att_old', 'att_new']]),
  origins: ['https://notes.test'],
};
describe('folder duplication formats', () => {
  it('strictly validates the bounded request without accepting owner/content/permission fields', () => {
    const request = { title: '  Project  ', parentFolderId: null, requestId: 'request_123456789' };
    expect(parseFolderDuplication(request)).toEqual({ ...request, title: 'Project' });
    for (const bad of [
      null,
      [],
      { ...request, owner: 'someone' },
      { ...request, title: '' },
      { ...request, title: 'a'.repeat(201) },
      { ...request, title: 'bad\0name' },
      { ...request, parentFolderId: [] },
      { ...request, requestId: 'short' },
      { ...request, previewToken: 'short' },
      { ...request, previewToken: null },
    ])
      expect(() => parseFolderDuplication(bad)).toThrow();
    expect(parseFolderDuplication({ ...request, title: '🌱'.repeat(200) }).title).toHaveLength(400);
  });
  it('remaps independent definitions/options/defaults/Board state without dropping archived or invalid stored values', () => {
    const definitions = [
      {
        id: 'status',
        label: 'Status',
        type: 'select',
        archived: false,
        options: [{ id: 'old', label: 'Retired', archived: true, color: 'red' }],
      },
      { id: 'text', label: 'Text', type: 'text', archived: true, options: [] },
    ];
    const raw = JSON.stringify(definitions),
      schema = copySchema('schema_old', raw);
    expect(schema.schemaId).not.toBe('schema_old');
    expect(schema.definitions[0].id).not.toBe('status');
    expect(schema.definitions[0].options[0]).toMatchObject({ label: 'Retired', archived: true, color: 'red' });
    const values = JSON.parse(
      copyValues(JSON.stringify({ status: 'old', text: 'x'.repeat(1000), unknown: [], bad: 27 }), schema)
    );
    expect(values).toEqual({
      [schema.fields.get('status') ?? '']: schema.options.get('status')?.get('old'),
      [schema.fields.get('text') ?? '']: 'x'.repeat(1000),
      unknown: [],
      bad: 27,
    });
    const board = {
      schemaVersion: 4,
      enabled: false,
      mode: 'read-only',
      grouping: { type: 'select', schemaId: 'schema_old', propertyId: 'status' },
      cardPropertyIds: ['text', 'missing'],
    };
    expect(JSON.parse(copyBoard(JSON.stringify(board), schema))).toMatchObject({
      enabled: false,
      grouping: { schemaId: schema.schemaId, propertyId: schema.fields.get('status') },
      cardPropertyIds: [schema.fields.get('text'), 'missing'],
    });
    const stale = { ...board, grouping: { ...board.grouping, schemaId: 'stale_schema' } };
    expect(JSON.parse(copyBoard(JSON.stringify(stale), schema)).grouping).toEqual(stale.grouping);
    expect(JSON.parse(copyBoard('{"schemaVersion":1,"enabled":true,"includeTags":["x"]}', schema))).toEqual({
      schemaVersion: 1,
      enabled: true,
      includeTags: ['x'],
    });
    expect(JSON.parse(raw)).toEqual(definitions);
    expect(() => copyValues('[]', schema)).toThrow();
    expect(() => copySchema('schema', '{}')).toThrow();
    expect(() => copySchema('schema', JSON.stringify([{ ...definitions[0], type: 'person' }]))).toThrow();
  });
  it('rewrites actual Markdown destinations and resolved wikilinks, never code, foreign URLs, labels or unrelated text', () => {
    const source =
      '[[Target|Go]] [[note_old]] [[Outside]] [[Ambiguous]]\n[x](/notes/note_old?q=1#part)\n![image](https://notes.test/internal/attachments/att_old/content)\nhttps://notes.test/notes/note_old\nhttps://other.test/notes/note_old\n[label /notes/note_old](https://other.test)\n`[[Target]] /notes/note_old`\n```md\n[[Target]]\n![image](/internal/attachments/att_old/content)\n```\nordinary note_old';
    const result = copyMarkdown(source, ctx);
    expect(result).toContain('[[note_new|Go]] [[note_new|note_old]] [[note_outside|Outside]] [[Ambiguous]]');
    expect(result).toContain('[x](/notes/note_new?q=1#part)');
    expect(result).toContain('https://notes.test/internal/attachments/att_new/content');
    expect(result).toContain('https://notes.test/notes/note_new');
    for (const literal of [
      'https://other.test/notes/note_old',
      '[label /notes/note_old](https://other.test)',
      '`[[Target]] /notes/note_old`',
      '```md\n[[Target]]\n![image](/internal/attachments/att_old/content)\n```',
      'ordinary note_old',
    ])
      expect(result).toContain(literal);
    expect(contentReferences(source, 'markdown', ctx.origins)).toEqual({
      attachments: ['att_old'],
      titles: ['Target', 'Outside', 'Ambiguous'],
    });
  });
  it('discovers and remaps angle-bracket destinations while retaining delimiters, labels and code literals', () => {
    const source =
      '![relative](</internal/attachments/att_old/content>)\n![absolute](<https://notes.test/internal/attachments/att_old/content>)\n[note](</notes/note_old?q=1#part>)\n[note](<https://notes.test/notes/note_old>)\n`![code](</internal/attachments/att_old/content>)`\n```md\n[note](</notes/note_old>)\n```';
    expect(contentReferences(source, 'markdown', ctx.origins).attachments).toEqual(['att_old']);
    const result = copyMarkdown(source, ctx);
    expect(result).toContain('![relative](</internal/attachments/att_new/content>)');
    expect(result).toContain('![absolute](<https://notes.test/internal/attachments/att_new/content>)');
    expect(result).toContain('[note](</notes/note_new?q=1#part>)');
    expect(result).toContain('[note](<https://notes.test/notes/note_new>)');
    expect(result).toContain('`![code](</internal/attachments/att_old/content>)`');
    expect(result).toContain('```md\n[note](</notes/note_old>)\n```');
  });
  it('preserves canvas layout, node IDs, external URLs and arbitrary metadata while remapping internal references/images', () => {
    const canvas = {
      nodes: [
        {
          id: 'a',
          type: 'text',
          x: 3,
          y: 8,
          text: '[[Target]]',
          url: 'https://notes.test/notes/note_old',
          minunotes: { link: { type: 'note', id: 'note_old' }, other: 'keep' },
        },
        { id: 'b', type: 'file', file: '/internal/attachments/att_old/content', extra: { noteId: 'note_old' } },
      ],
      edges: [{ id: 'edge', fromNode: 'a', toNode: 'b' }],
      extra: 'keep',
    };
    const result = JSON.parse(copyContent(JSON.stringify(canvas), 'canvas.mindmap', ctx));
    expect(result.nodes[0]).toEqual({
      ...canvas.nodes[0],
      text: '[[note_new|Target]]',
      minunotes: { ...canvas.nodes[0].minunotes, link: { type: 'note', id: 'note_new' } },
    });
    expect(result.nodes[1]).toEqual({ ...canvas.nodes[1], file: '/internal/attachments/att_new/content' });
    expect(result.edges).toEqual(canvas.edges);
    expect(result.extra).toBe('keep');
    expect(contentReferences(JSON.stringify(canvas), 'canvas.mindmap', ctx.origins)).toEqual({
      attachments: ['att_old'],
      titles: ['Target'],
    });
    expect(() => copyContent('{}', 'canvas.default', ctx)).toThrow();
  });
});
