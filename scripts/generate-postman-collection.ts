import { mkdir, writeFile } from 'node:fs/promises';
import { harnessOpenApiSpec } from '../src/api/openapi/harness.js';

type OpenApiOperation = {
  tags?: string[];
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: Array<{
    name: string;
    in: 'path' | 'query' | 'header';
    required?: boolean;
    schema?: { type?: string; enum?: string[] };
  }>;
  requestBody?: {
    content?: { 'application/json'?: { schema?: { $ref?: string } } };
  };
};

type PostmanItem = {
  name: string;
  request?: {
    method: string;
    header?: Array<{ key: string; value: string; type: 'text' }>;
    description?: string;
    body?: { mode: 'raw'; raw: string; options: { raw: { language: 'json' } } };
    url: {
      raw: string;
      host: string[];
      path: string[];
      query?: Array<{ key: string; value: string; disabled?: boolean }>;
    };
  };
  event?: Array<{ listen: 'test'; script: { type: 'text/javascript'; exec: string[] } }>;
  item?: PostmanItem[];
};

const collection = {
  info: {
    name: 'MinuNotes Harness API',
    _postman_id: 'minunotes-harness-api',
    description:
      'Generated from the MinuNotes Harness OpenAPI document. Search and list responses are compact metadata; explicitly read a note, line range, or section when content is needed.',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    { key: 'baseUrl', value: 'https://api.notes.minusculelabs.com' },
    { key: 'apiKey', value: '' },
    { key: 'folderId', value: 'folder_xxx' },
    { key: 'noteId', value: 'note_xxx' },
    { key: 'sectionId', value: 'section-id' },
    { key: 'nodeId', value: 'node_a' },
    { key: 'targetNoteId', value: 'note_target' },
    { key: 'baseHash', value: 'hash_from_read' },
    { key: 'shareToken', value: 'share_xxx' },
    { key: 'folderCursor', value: '' },
    { key: 'tagCursor', value: '' },
    { key: 'searchCursor', value: '' },
    { key: 'orphanCursor', value: '' },
    { key: 'lineSearchCursor', value: '' },
  ],
  item: [] as PostmanItem[],
};

const bodyExamples: Record<string, unknown> = {
  CreateFolderRequest: { title: 'Harness evaluation', parentFolderId: '{{folderId}}' },
  CreateNoteRequest: {
    folderId: '{{folderId}}',
    title: 'Harness evaluation note',
    content: '# Harness evaluation note\n\nCreated through the Postman collection.\n',
  },
  MoveNotesRequest: { noteIds: ['{{noteId}}'], targetFolderId: '{{folderId}}' },
  CreateCanvasRequest: { folderId: '{{folderId}}', title: 'Harness canvas', canvas: { nodes: [], edges: [] } },
  CreateCanvasFromSyntaxRequest: {
    folderId: '{{folderId}}',
    title: 'Harness diagram',
    format: 'auto',
    syntax: 'flowchart LR\n  Start --> Finish',
  },
  ReplaceCanvasRequest: { baseHash: '{{baseHash}}', canvas: { nodes: [], edges: [] } },
  ReplaceCanvasFromSyntaxRequest: {
    baseHash: '{{baseHash}}',
    format: 'minu',
    syntax: 'diagram "Harness flow" {\n  Start > Finish\n}',
  },
  LinkCanvasNodeToNoteRequest: { targetNoteId: '{{targetNoteId}}', baseHash: '{{baseHash}}' },
  UpdateTagsRequest: { tags: ['evaluation'] },
  EditNoteRequest: { baseHash: '{{baseHash}}', edits: [{ type: 'append', text: '\n- Checked by harness\n' }] },
};

const pathVariableExamples: Record<string, string> = {
  noteId: '{{noteId}}',
  folderId: '{{folderId}}',
  sectionId: '{{sectionId}}',
  nodeId: '{{nodeId}}',
  token: '{{shareToken}}',
};

function schemaName(ref?: string) {
  return ref?.split('/').pop();
}

function cursorVariable(operationId?: string) {
  if (operationId === 'listFolders') return 'folderCursor';
  if (operationId === 'listTags') return 'tagCursor';
  if (operationId === 'searchNotes') return 'searchCursor';
  if (operationId === 'listOrphanNotes') return 'orphanCursor';
  if (operationId === 'searchNoteLines') return 'lineSearchCursor';
  return 'cursor';
}

function exampleForParameter(parameter: NonNullable<OpenApiOperation['parameters']>[number], operationId?: string) {
  if (parameter.in === 'path') return pathVariableExamples[parameter.name] ?? `{{${parameter.name}}}`;
  if (parameter.name === 'q') return 'project';
  if (parameter.name === 'tag') return 'release-notes';
  if (parameter.name === 'folderId') return '{{folderId}}';
  if (parameter.name === 'context') return '2';
  if (parameter.name === 'limit') return '10';
  if (parameter.name === 'cursor') return `{{${cursorVariable(operationId)}}}`;
  if (parameter.name === 'caseSensitive') return 'false';
  if (parameter.name === 'from') return '1';
  if (parameter.name === 'to') return '80';
  if (parameter.name === 'baseHash') return '{{baseHash}}';
  return parameter.schema?.enum?.[0] ?? '';
}

function requestBody(operation: OpenApiOperation) {
  const schema = operation.requestBody?.content?.['application/json']?.schema;
  const example = bodyExamples[schemaName(schema?.$ref) ?? ''];
  if (example === undefined) return undefined;
  return {
    mode: 'raw' as const,
    raw: JSON.stringify(example, null, 2),
    options: { raw: { language: 'json' as const } },
  };
}

function testScript(operationId?: string) {
  const exec = [
    "pm.test('returns a successful response', function () { pm.expect(pm.response.code).to.be.oneOf([200, 201]); });",
  ];
  if (operationId === 'searchNotes') {
    exec.push(
      "const body = pm.response.json(); if (body.notes?.[0]?.id) pm.collectionVariables.set('noteId', body.notes[0].id);"
    );
  }
  if (['listFolders', 'listTags', 'searchNotes', 'listOrphanNotes', 'searchNoteLines'].includes(operationId ?? '')) {
    exec.push(
      `const body = pm.response.json(); pm.collectionVariables.set('${cursorVariable(operationId)}', body.pageInfo?.nextCursor ?? '');`
    );
  }
  if (operationId === 'createFolder') {
    exec.push(
      "const body = pm.response.json(); if (body.folder?.id) pm.collectionVariables.set('folderId', body.folder.id);"
    );
  }
  if (['createNote', 'createCanvas', 'createCanvasFromSyntax', 'getNote'].includes(operationId ?? '')) {
    exec.push(
      "const body = pm.response.json(); if (body.note?.id) pm.collectionVariables.set('noteId', body.note.id);"
    );
  }
  if (operationId === 'getNote') {
    exec.push(
      "const body = pm.response.json(); if (body.contentHash) pm.collectionVariables.set('baseHash', body.contentHash);"
    );
  }
  return [{ listen: 'test' as const, script: { type: 'text/javascript', exec } }];
}

function makeRequest(path: string, method: string, operation: OpenApiOperation): PostmanItem {
  const parameters = operation.parameters ?? [];
  const pathValues = path
    .split('/')
    .filter(Boolean)
    .map((part) =>
      part.startsWith('{') ? (pathVariableExamples[part.slice(1, -1)] ?? `{{${part.slice(1, -1)}}}`) : part
    );
  const query = parameters
    .filter((parameter) => parameter.in === 'query')
    .map((parameter) => ({
      key: parameter.name,
      value: exampleForParameter(parameter, operation.operationId),
      disabled: !parameter.required,
    }));
  const rawPath = path.replace(/\{([^}]+)\}/g, (_, name: string) => pathVariableExamples[name] ?? `{{${name}}}`);
  const raw = `{{baseUrl}}${rawPath}${query.length ? `?${query.map((item) => `${item.key}=${item.value}`).join('&')}` : ''}`;
  return {
    name: operation.summary ?? operation.operationId ?? `${method.toUpperCase()} ${path}`,
    request: {
      method: method.toUpperCase(),
      header: [{ key: 'X-API-Key', value: '{{apiKey}}', type: 'text' }],
      description: operation.description,
      body: requestBody(operation),
      url: { raw, host: ['{{baseUrl}}'], path: pathValues, query: query.length ? query : undefined },
    },
    event: testScript(operation.operationId),
  };
}

for (const [path, pathItem] of Object.entries(harnessOpenApiSpec.paths)) {
  for (const [method, operation] of Object.entries(pathItem as Record<string, OpenApiOperation>)) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
    const tag = operation.tags?.[0] ?? 'Other';
    let folder = collection.item.find((item) => item.name === tag);
    if (!folder) {
      folder = { name: tag, item: [] };
      collection.item.push(folder);
    }
    folder.item?.push(makeRequest(path, method, operation));
  }
}

collection.item.unshift({
  name: 'Smoke flow',
  item: [
    makeRequest('/v1/harness/notes/search', 'get', {
      operationId: 'searchNotes',
      summary: '1. Search notes (compact)',
      description: 'Run this first. The test script stores the first result id in the noteId collection variable.',
      parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }],
    }),
    makeRequest('/v1/harness/notes/{noteId}', 'get', {
      operationId: 'getNote',
      summary: '2. Read selected note',
      description: 'Expands the selected compact search result and stores its contentHash for safe edits.',
      parameters: [{ name: 'noteId', in: 'path', required: true, schema: { type: 'string' } }],
    }),
  ],
});

const output = 'postman/minunotes-harness.postman_collection.json';
await mkdir('postman', { recursive: true });
await writeFile(output, `${JSON.stringify(collection, null, 2)}\n`);
console.log(`Wrote ${output}`);
