import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

type DocumentEdit =
  | { type: 'append'; text: string }
  | { type: 'replace_text'; oldText: string; newText: string }
  | { type: 'replace_range'; from: number; to: number; text: string };

const jsonObjectSchema = z.object({}).passthrough();
const canvasDocumentSchema = z
  .object({
    nodes: z.array(z.unknown()),
    edges: z.array(z.unknown()),
  })
  .passthrough();
const canvasDocumentTypeSchema = z.enum(['canvas.default', 'canvas.mindmap']);
const commentAnchorSchema = z
  .object({
    anchorType: z.enum(['range', 'line']),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    quote: z.string().max(20_000),
    prefix: z.string().optional(),
    suffix: z.string().optional(),
    documentHash: z.string().min(1),
    detached: z.boolean().optional(),
  })
  .strict();

export type CommentAnchor = z.infer<typeof commentAnchorSchema>;
export type CommentCreateInput = { body: string } & (
  | { target: 'note'; anchor?: never }
  | { target?: 'text'; anchor: CommentAnchor }
);

const commentCreateSchema = z
  .object({
    noteId: z.string(),
    body: z.string().min(1).max(10_000),
    target: z.enum(['note', 'text']).optional(),
    anchor: commentAnchorSchema.optional(),
  })
  .strict()
  .refine(
    (value) => (value.target === 'note' ? value.anchor === undefined : value.anchor !== undefined),
    'Use target note without an anchor, or a text target with an anchor'
  );

export type CanvasDocument = {
  nodes: unknown[];
  edges: unknown[];
  [key: string]: unknown;
};

function toolResult(data: unknown) {
  return {
    structuredContent: { result: data },
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

const propertyMutationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('reorder_options'), propertyId: z.string(), optionIds: z.array(z.string()) }).strict(),
  z
    .object({
      type: z.literal('add'),
      label: z.string().min(1).max(80),
      fieldType: z.enum(['text', 'select', 'date']),
      options: z.array(z.string().min(1).max(80)).min(1).max(8).optional(),
    })
    .strict(),
  z.object({ type: z.literal('rename'), propertyId: z.string(), label: z.string().min(1).max(80) }).strict(),
  z.object({ type: z.literal('archive'), propertyId: z.string() }).strict(),
  z.object({ type: z.literal('reorder'), propertyIds: z.array(z.string()) }).strict(),
  z.object({ type: z.literal('add_option'), propertyId: z.string(), label: z.string().min(1).max(80) }).strict(),
  z
    .object({
      type: z.literal('rename_option'),
      propertyId: z.string(),
      optionId: z.string(),
      label: z.string().min(1).max(80),
    })
    .strict(),
  z.object({ type: z.literal('archive_option'), propertyId: z.string(), optionId: z.string() }).strict(),
]);
export type SchemaMutationRequest = { expectedRevision: number; mutation: z.infer<typeof propertyMutationSchema> };
export type PropertyPatch = {
  schemaId: string | null;
  schemaRevision: number;
  expectedRevision: number;
  values: Record<string, string | null>;
};

const templateCreationSchema = z
  .object({
    folderId: z.string().min(1).max(100),
    templateId: z.string().min(1).max(100),
    snapshot: z.string().min(1).max(128),
    schemaId: z.string().max(100).nullable(),
    schemaRevision: z.number().int().nonnegative(),
    title: z.string().min(1).max(1000),
    tags: z.array(z.string().min(1).max(80)).max(50),
    values: z.record(z.string(), z.string().max(1000).nullable()),
    requestId: z.string().min(1).max(128),
    variables: z.object({ date: z.string().max(80), time: z.string().max(80), datetime: z.string().max(80) }).strict(),
  })
  .strict();
export type TemplateCreation = z.infer<typeof templateCreationSchema>;

export type NotesMcpClient = {
  folders: {
    templates: (folderId: string) => Promise<unknown>;
    templatePreview: (folderId: string, templateId: string) => Promise<unknown>;
    list: (input?: { limit?: number; cursor?: string }) => Promise<unknown>;
    create: (input: { title: string; parentFolderId?: string }) => Promise<unknown>;
    trash: (folderId: string) => Promise<unknown>;
    properties: (folderId: string) => Promise<unknown>;
    mutateProperties: (folderId: string, input: SchemaMutationRequest) => Promise<unknown>;
  };
  notes: {
    fromTemplate: (input: TemplateCreation) => Promise<unknown>;
    search: (input: { query: string; tag?: string; limit?: number; cursor?: string }) => Promise<unknown>;
    get: (noteId: string) => Promise<unknown>;
    create: (folderId: string, input: { title?: string; content?: string }) => Promise<unknown>;
    edit: (noteId: string, edits: DocumentEdit[], baseHash?: string) => Promise<unknown>;
    move: (input: { noteIds: string[]; targetFolderId: string }) => Promise<unknown>;
    trash: (noteId: string) => Promise<unknown>;
    searchLines: (input: {
      query: string;
      folderId?: string;
      context?: number;
      limit?: number;
      caseSensitive?: boolean;
      cursor?: string;
    }) => Promise<unknown>;
    lines: (noteId: string, input: { from?: number; to?: number }) => Promise<unknown>;
    searchNoteLines: (
      noteId: string,
      input: { query: string; context?: number; limit?: number; caseSensitive?: boolean }
    ) => Promise<unknown>;
    outline: (noteId: string) => Promise<unknown>;
    section: (noteId: string, sectionId: string) => Promise<unknown>;
    events: (noteId: string, limit?: number) => Promise<unknown>;
    tags: (noteId: string) => Promise<unknown>;
    replaceTags: (noteId: string, tags: string[]) => Promise<unknown>;
    properties: (noteId: string) => Promise<unknown>;
    patchProperties: (noteId: string, input: PropertyPatch) => Promise<unknown>;
  };
  comments: {
    list: (noteId: string) => Promise<unknown>;
    create: (noteId: string, input: CommentCreateInput) => Promise<unknown>;
    reply: (noteId: string, threadId: string, body: string) => Promise<unknown>;
    updateAnchor: (noteId: string, threadId: string, anchor: CommentAnchor) => Promise<unknown>;
    setStatus: (noteId: string, threadId: string, status: 'open' | 'resolved') => Promise<unknown>;
    updateMessage: (noteId: string, threadId: string, messageId: string, body: string) => Promise<unknown>;
    toggleReaction: (noteId: string, threadId: string, messageId: string, emoji: string) => Promise<unknown>;
    deleteMessage: (noteId: string, threadId: string, messageId: string) => Promise<unknown>;
    deleteThread: (noteId: string, threadId: string) => Promise<unknown>;
  };
  canvases: {
    create: (input: {
      folderId: string;
      title?: string;
      canvas: CanvasDocument;
      documentType?: 'canvas.default' | 'canvas.mindmap';
    }) => Promise<unknown>;
    createFromSyntax: (input: {
      folderId: string;
      title?: string;
      syntax: string;
      documentType?: 'canvas.default' | 'canvas.mindmap';
      format?: 'auto' | 'minu' | 'mermaid';
    }) => Promise<unknown>;
    replace: (
      noteId: string,
      input: {
        baseHash: string;
        title?: string;
        canvas: CanvasDocument;
        documentType?: 'canvas.default' | 'canvas.mindmap';
      }
    ) => Promise<unknown>;
    replaceFromSyntax: (
      noteId: string,
      input: {
        baseHash: string;
        title?: string;
        syntax: string;
        documentType?: 'canvas.default' | 'canvas.mindmap';
        format?: 'auto' | 'minu' | 'mermaid';
      }
    ) => Promise<unknown>;
    setNoteLink: (
      noteId: string,
      nodeId: string,
      input: { targetNoteId: string; baseHash: string }
    ) => Promise<unknown>;
    removeNoteLink: (noteId: string, nodeId: string, baseHash: string) => Promise<unknown>;
  };
  tags: {
    list: (input?: { limit?: number; cursor?: string }) => Promise<unknown>;
  };
};

export function createNotesMcpServer(client: NotesMcpClient) {
  const server = new McpServer({ name: 'minunotes', version: '0.1.0' });
  server.registerTool(
    'notes_list_assigned_templates',
    {
      title: 'List assigned templates',
      description:
        'List only templates assigned to a destination you can create in. Requires read/create; grants no template library access.',
      inputSchema: { folderId: z.string().min(1).max(100) },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ folderId }) => toolResult(await client.folders.templates(folderId))
  );
  server.registerTool(
    'notes_preview_assigned_template',
    {
      title: 'Preview assigned template',
      description:
        'Review destination-scoped body, tags, properties and schema. Snapshot is a concurrency token, never an access grant. Freeze the existing date/time strings before creation.',
      inputSchema: { folderId: z.string().min(1).max(100), templateId: z.string().min(1).max(100) },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ folderId, templateId }) => toolResult(await client.folders.templatePreview(folderId, templateId))
  );
  server.registerTool(
    'notes_create_from_template',
    {
      title: 'Create from reviewed template',
      description:
        'Atomically create an ordinary note with the reviewed final tags/properties (empty explicitly clears), body and one create event. Honor reviewed template tags; do not clear them because card chips are hidden or invent tags/fields/options. Retry uncertain results with the SAME requestId and exact frozen payload; changed payload needs a new ID only after resolution. Stale review conflicts without writes; deleted receipts never recreate notes.',
      inputSchema: templateCreationSchema,
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => toolResult(await client.notes.fromTemplate(input))
  );

  server.registerTool(
    'notes_list_folders',
    {
      title: 'List folders',
      description:
        'List cursor-paginated owned and explicitly scoped shared folders. Inaccessible ancestry, owner/grant ids, and Trash are excluded. Continue with pageInfo.nextCursor when hasMore is true.',
      inputSchema: {
        limit: z.number().int().positive().max(100).optional(),
        cursor: z.string().min(1).optional(),
      },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ limit, cursor }) => toolResult(await client.folders.list({ limit, cursor }))
  );

  server.registerTool(
    'notes_create_folder',
    {
      title: 'Create folder',
      description:
        'Create an owned folder or a subfolder within an editable shared folder when the connection has folder creation permission. The resource remains in the owner corpus and is attributed to the authorizing user.',
      inputSchema: { title: z.string(), parentFolderId: z.string().optional() },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ title, parentFolderId }) => toolResult(await client.folders.create({ title, parentFolderId }))
  );

  server.registerTool(
    'notes_trash_folder',
    {
      title: 'Move folder to Trash',
      description:
        'Destructive: move a folder and its subtree to the owner’s Trash. A shared-folder Editor may do this only when the authorizing user created the entire subtree and the owner has not attached sharing configuration. Restore and permanent deletion remain owner-only. Use only after explicit user approval for this deletion.',
      inputSchema: { folderId: z.string(), confirm: z.literal(true) },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ folderId }) => toolResult(await client.folders.trash(folderId))
  );

  server.registerTool(
    'notes_search',
    {
      title: 'Search notes',
      description:
        'Search active owned and explicitly scoped shared notes. Results include privacy-safe role/source context without content; direct-note grants have null folder context. Expand selected results only. Continue with pageInfo.nextCursor when hasMore is true.',
      inputSchema: {
        query: z.string(),
        tag: z.string().optional(),
        limit: z.number().int().positive().max(100).optional(),
        cursor: z.string().min(1).optional(),
      },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, tag, limit, cursor }) => toolResult(await client.notes.search({ query, tag, limit, cursor }))
  );

  server.registerTool(
    'notes_trash_note',
    {
      title: 'Move note to Trash',
      description:
        'Destructive: move a note to the owner’s Trash. A shared-folder Editor may do this only when the authorizing user created the note and the owner has not attached sharing configuration. Direct-note grants cannot delete the shared note. Restore and permanent deletion remain owner-only. Use only after explicit user approval for this deletion.',
      inputSchema: { noteId: z.string(), confirm: z.literal(true) },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ noteId }) => toolResult(await client.notes.trash(noteId))
  );

  server.registerTool(
    'notes_get_note',
    {
      title: 'Get note',
      description:
        'Read an active owned or explicitly scoped shared note when its content is needed. Do not read solely to inspect permissions. Direct-note grants have null folder context. Not found may mean inaccessible, revoked, or trashed; do not infer existence.',
      inputSchema: { noteId: z.string() },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ noteId }) => toolResult(await client.notes.get(noteId))
  );

  server.registerTool(
    'notes_list_comments',
    {
      title: 'List note comments',
      description:
        'List general discussion and anchored Review threads with explicit note/text targets and ordered messages for an active Markdown note.',
      inputSchema: { noteId: z.string() },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ noteId }) => toolResult(await client.comments.list(noteId))
  );

  server.registerTool(
    'notes_create_comment',
    {
      title: 'Create note comment',
      description:
        'Create a plain-text discussion thread. Use target note without an anchor for general discussion; no body hash is needed. For text-specific Review, use target text (or legacy omission) with the current contentHash and exact offsets from notes_get_note. Requires explicit Comment permission; never retry automatically.',
      inputSchema: commentCreateSchema,
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ noteId, body, target, anchor }) => {
      const input: CommentCreateInput =
        target === 'note' ? { body, target } : { body, ...(target ? { target } : {}), anchor: anchor as CommentAnchor };
      return toolResult(await client.comments.create(noteId, input));
    }
  );

  server.registerTool(
    'notes_reply_to_comment',
    {
      title: 'Reply to note comment',
      description: 'Add a plain-text message to an existing general discussion or Review thread.',
      inputSchema: { noteId: z.string(), threadId: z.string(), body: z.string().min(1).max(10_000) },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ noteId, threadId, body }) => toolResult(await client.comments.reply(noteId, threadId, body))
  );

  server.registerTool(
    'notes_update_comment_anchor',
    {
      title: 'Update comment anchor',
      description: 'Persist a mapped or detached comment anchor against the current note content hash.',
      inputSchema: { noteId: z.string(), threadId: z.string(), anchor: commentAnchorSchema },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ noteId, threadId, anchor }) => toolResult(await client.comments.updateAnchor(noteId, threadId, anchor))
  );

  server.registerTool(
    'notes_set_comment_status',
    {
      title: 'Resolve or reopen comment',
      description: 'Resolve or reopen a Review thread authored by this connection.',
      inputSchema: { noteId: z.string(), threadId: z.string(), status: z.enum(['open', 'resolved']) },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ noteId, threadId, status }) => toolResult(await client.comments.setStatus(noteId, threadId, status))
  );

  server.registerTool(
    'notes_edit_comment_message',
    {
      title: 'Edit comment message',
      description: 'Edit a plain-text Review message authored by this connection.',
      inputSchema: {
        noteId: z.string(),
        threadId: z.string(),
        messageId: z.string(),
        body: z.string().min(1).max(10_000),
      },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ noteId, threadId, messageId, body }) =>
      toolResult(await client.comments.updateMessage(noteId, threadId, messageId, body))
  );

  server.registerTool(
    'notes_toggle_comment_reaction',
    {
      title: 'Toggle comment reaction',
      description: 'Add or remove your emoji reaction on a Review message.',
      inputSchema: {
        noteId: z.string(),
        threadId: z.string(),
        messageId: z.string(),
        emoji: z.string().min(1).max(64).describe('One standard Unicode emoji'),
      },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ noteId, threadId, messageId, emoji }) =>
      toolResult(await client.comments.toggleReaction(noteId, threadId, messageId, emoji))
  );

  server.registerTool(
    'notes_delete_comment_message',
    {
      title: 'Delete comment message',
      description: 'Delete a Review message authored by this connection. Deleting a root message deletes its thread.',
      inputSchema: { noteId: z.string(), threadId: z.string(), messageId: z.string() },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ noteId, threadId, messageId }) =>
      toolResult(await client.comments.deleteMessage(noteId, threadId, messageId))
  );

  server.registerTool(
    'notes_delete_comment_thread',
    {
      title: 'Delete comment thread',
      description: 'Delete a complete Review thread authored by this connection.',
      inputSchema: { noteId: z.string(), threadId: z.string() },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ noteId, threadId }) => toolResult(await client.comments.deleteThread(noteId, threadId))
  );

  server.registerTool(
    'notes_create_note',
    {
      title: 'Create note',
      description:
        'Create a note in an owned or explicitly scoped shared folder. Content created in a shared folder belongs to that folder owner. For net-new content, resolve the folder from folder metadata and create directly without reading unrelated notes. For requested structured labels, prefer defined properties and stable IDs; ask when missing, do not invent tags or mirror Status/Type into tags unless requested.',
      inputSchema: { folderId: z.string(), title: z.string().optional(), content: z.string().optional() },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ folderId, title, content }) => toolResult(await client.notes.create(folderId, { title, content }))
  );

  server.registerTool(
    'notes_create_canvas',
    {
      title: 'Create canvas',
      description:
        'Create a canvas or mind map from JSON Canvas. Use this for exact node ids, positions, links, and metadata.',
      inputSchema: {
        folderId: z.string(),
        title: z.string().optional(),
        canvas: canvasDocumentSchema,
        documentType: canvasDocumentTypeSchema.optional(),
      },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ folderId, title, canvas, documentType }) =>
      toolResult(await client.canvases.create({ folderId, title, canvas, documentType }))
  );

  server.registerTool(
    'notes_create_canvas_from_syntax',
    {
      title: 'Create canvas from syntax',
      description:
        'Create an editable canvas from Minu diagram syntax or a supported Mermaid flowchart. Syntax defaults to auto-detection (`flowchart`/`graph` headers select Mermaid). Mermaid imports preserve supported flowchart structure as native JSON Canvas, not SVG; unsupported Mermaid syntax returns diagnostics. Use Minu syntax for mind maps.',
      inputSchema: {
        folderId: z.string(),
        title: z.string().optional(),
        syntax: z
          .string()
          .min(1)
          .describe(
            'Minu diagram syntax or a supported Mermaid flowchart. Auto-detection recognizes Mermaid `flowchart`/`graph` headers.'
          ),
        documentType: canvasDocumentTypeSchema.optional(),
        format: z
          .enum(['auto', 'minu', 'mermaid'])
          .optional()
          .describe('Syntax dialect; defaults to auto-detection. Use minu or mermaid to force a parser.'),
      },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ folderId, title, syntax, documentType, format }) =>
      toolResult(
        await client.canvases.createFromSyntax({
          folderId,
          title,
          syntax,
          documentType,
          ...(format === undefined ? {} : { format }),
        })
      )
  );

  server.registerTool(
    'notes_replace_canvas',
    {
      title: 'Replace canvas',
      description:
        'Replace a complete canvas with JSON Canvas using a base hash. Use JSON when exact ids, links, and metadata must be retained.',
      inputSchema: {
        noteId: z.string(),
        baseHash: z.string().min(1),
        title: z.string().optional(),
        canvas: canvasDocumentSchema,
        documentType: canvasDocumentTypeSchema.optional(),
      },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ noteId, baseHash, title, canvas, documentType }) =>
      toolResult(await client.canvases.replace(noteId, { baseHash, title, canvas, documentType }))
  );

  server.registerTool(
    'notes_replace_canvas_from_syntax',
    {
      title: 'Replace canvas from syntax',
      description:
        'Regenerate and replace a complete canvas from Minu diagram syntax or a supported Mermaid flowchart using a base hash. Syntax defaults to auto-detection (`flowchart`/`graph` headers select Mermaid). Mermaid imports become native JSON Canvas, not SVG; unsupported syntax returns diagnostics. Use Minu syntax for mind maps. Replacement can change node ids, layout, links, and metadata.',
      inputSchema: {
        noteId: z.string(),
        baseHash: z.string().min(1),
        title: z.string().optional(),
        syntax: z
          .string()
          .min(1)
          .describe(
            'Minu diagram syntax or a supported Mermaid flowchart. Auto-detection recognizes Mermaid `flowchart`/`graph` headers.'
          ),
        documentType: canvasDocumentTypeSchema.optional(),
        format: z
          .enum(['auto', 'minu', 'mermaid'])
          .optional()
          .describe('Syntax dialect; defaults to auto-detection. Use minu or mermaid to force a parser.'),
      },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ noteId, baseHash, title, syntax, documentType, format }) =>
      toolResult(
        await client.canvases.replaceFromSyntax(noteId, {
          baseHash,
          title,
          syntax,
          documentType,
          ...(format === undefined ? {} : { format }),
        })
      )
  );

  server.registerTool(
    'notes_set_canvas_node_note_link',
    {
      title: 'Set canvas node note link',
      description:
        'Set or change one canvas node internal note link using a base hash. Preserves the node external URL and unrelated metadata.',
      inputSchema: {
        noteId: z.string(),
        nodeId: z.string(),
        targetNoteId: z.string(),
        baseHash: z.string().min(1),
      },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ noteId, nodeId, targetNoteId, baseHash }) =>
      toolResult(await client.canvases.setNoteLink(noteId, nodeId, { targetNoteId, baseHash }))
  );

  server.registerTool(
    'notes_remove_canvas_node_note_link',
    {
      title: 'Remove canvas node note link',
      description:
        'Remove one canvas node internal note link using a base hash. Preserves the node external URL and unrelated metadata.',
      inputSchema: { noteId: z.string(), nodeId: z.string(), baseHash: z.string().min(1) },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ noteId, nodeId, baseHash }) => toolResult(await client.canvases.removeNoteLink(noteId, nodeId, baseHash))
  );

  server.registerTool(
    'notes_edit_note',
    {
      title: 'Edit note',
      description:
        'Patch an authorized note with structured edits. Read the note because its content and current baseHash are required, then apply the smallest relevant edit. Report permission failures without probing.',
      inputSchema: {
        noteId: z.string(),
        baseHash: z.string().optional(),
        edits: z
          .array(
            z.union([
              z.object({ type: z.literal('append'), text: z.string() }),
              z.object({ type: z.literal('replace_text'), oldText: z.string(), newText: z.string() }),
              z.object({ type: z.literal('replace_range'), from: z.number(), to: z.number(), text: z.string() }),
            ])
          )
          .min(1),
      },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ noteId, edits, baseHash }) => toolResult(await client.notes.edit(noteId, edits, baseHash))
  );

  server.registerTool(
    'notes_move_notes',
    {
      title: 'Move notes',
      description:
        'Move up to 100 owned notes atomically. Shared-resource structure is owner-only, so shared notes cannot be moved even when their content is editable.',
      inputSchema: { noteIds: z.array(z.string()).min(1).max(100), targetFolderId: z.string() },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ noteIds, targetFolderId }) => toolResult(await client.notes.move({ noteIds, targetFolderId }))
  );

  server.registerTool(
    'notes_search_lines',
    {
      title: 'Search note lines',
      description:
        'Search cursor-paginated matching lines across owned and explicitly scoped shared notes. Results hide direct-note folder ancestry. Continue with pageInfo.nextCursor when hasMore is true.',
      inputSchema: {
        query: z.string(),
        folderId: z.string().optional(),
        context: z.number().int().min(0).max(5).optional(),
        limit: z.number().int().positive().max(100).optional(),
        caseSensitive: z.boolean().optional(),
        cursor: z.string().min(1).optional(),
      },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, folderId, context, limit, caseSensitive, cursor }) =>
      toolResult(await client.notes.searchLines({ query, folderId, context, limit, caseSensitive, cursor }))
  );

  server.registerTool(
    'notes_read_lines',
    {
      title: 'Read note lines',
      description: 'Read numbered lines from a selected note when that content is needed.',
      inputSchema: { noteId: z.string(), from: z.number().optional(), to: z.number().optional() },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ noteId, from, to }) => toolResult(await client.notes.lines(noteId, { from, to }))
  );

  server.registerTool(
    'notes_search_note_lines',
    {
      title: 'Search lines in note',
      description: 'Search matching lines within one selected note when its content is relevant to the task.',
      inputSchema: {
        noteId: z.string(),
        query: z.string(),
        context: z.number().optional(),
        limit: z.number().optional(),
        caseSensitive: z.boolean().optional(),
      },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ noteId, query, context, limit, caseSensitive }) =>
      toolResult(await client.notes.searchNoteLines(noteId, { query, context, limit, caseSensitive }))
  );

  server.registerTool(
    'notes_read_outline',
    {
      title: 'Read note outline',
      description: 'Read a markdown note heading outline and discover section ids for notes_read_section.',
      inputSchema: { noteId: z.string() },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ noteId }) => toolResult(await client.notes.outline(noteId))
  );

  server.registerTool(
    'notes_read_events',
    {
      title: 'Read note events',
      description: 'Read recent activity events for a note, including actor, operation summary, and content hashes.',
      inputSchema: { noteId: z.string(), limit: z.number().int().positive().max(100).optional() },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ noteId, limit }) => toolResult(await client.notes.events(noteId, limit))
  );

  server.registerTool(
    'notes_read_section',
    {
      title: 'Read note section',
      description: 'Read a section from a note by section id from the note outline.',
      inputSchema: { noteId: z.string(), sectionId: z.string() },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ noteId, sectionId }) => toolResult(await client.notes.section(noteId, sectionId))
  );

  server.registerTool(
    'notes_list_tags',
    {
      title: 'List tags',
      description:
        'List cursor-paginated tags visible to the authorized MinuNotes connection. Continue with pageInfo.nextCursor when hasMore is true.',
      inputSchema: {
        limit: z.number().int().positive().max(100).optional(),
        cursor: z.string().min(1).optional(),
      },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ limit, cursor }) => toolResult(await client.tags.list({ limit, cursor }))
  );

  server.registerTool(
    'notes_read_note_tags',
    {
      title: 'Read note tags',
      description: 'Read all tags assigned to one note.',
      inputSchema: { noteId: z.string() },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ noteId }) => toolResult(await client.notes.tags(noteId))
  );

  server.registerTool(
    'notes_replace_note_tags',
    {
      title: 'Replace note tags',
      description:
        'Replace all tags assigned to one note. Tags omitted from the array are removed. Use only explicit/reviewed tags; preserve stored and reviewed template tags unless removal is requested. Prefer defined properties for Status/Type; do not invent tags or mirror properties into tags unless requested. Hidden board chips do not authorize clearing tags.',
      inputSchema: { noteId: z.string(), tags: z.array(z.string()).max(100) },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ noteId, tags }) => toolResult(await client.notes.replaceTags(noteId, tags))
  );

  server.registerPrompt(
    'summarize_note',
    {
      title: 'Summarize note',
      description: 'Prompt template for summarizing a note after fetching it with notes_get_note.',
      argsSchema: { noteId: z.string() },
    },
    ({ noteId }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Fetch note ${noteId} with notes_get_note, then summarize the note in concise bullet points.`,
          },
        },
      ],
    })
  );

  server.registerTool(
    'notes_read_folder_properties',
    {
      title: 'Read folder property schema',
      description:
        'Read the authorized folder-only Text/Select/Date schema. Prefer defined properties for structured Status/Type labels and use stable property/option IDs. Ask when missing; do not invent fields, options or tags. Note-only grants do not permit folder reads.',
      inputSchema: { folderId: z.string() },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ folderId }) => toolResult(await client.folders.properties(folderId))
  );
  server.registerTool(
    'notes_mutate_folder_properties',
    {
      title: 'Mutate folder property schema',
      description:
        'Owner-only add/rename/reorder/archive operation with expectedRevision. Change definitions only when explicitly requested; ask before inventing fields/options. IDs are server-generated; types immutable. Existing agent edit/private-folder policies apply. Disable/switch an enabled board before archiving its grouping property; retained template defaults guard field/option archive.',
      inputSchema: {
        folderId: z.string(),
        expectedRevision: z.number().int().nonnegative(),
        mutation: propertyMutationSchema,
      },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ folderId, ...input }) => toolResult(await client.folders.mutateProperties(folderId, input))
  );
  server.registerTool(
    'notes_read_note_properties',
    {
      title: 'Read note properties',
      description:
        'Read only applicable definitions/values and independent revisions. No body hash, private owner/folder identities, or template defaults.',
      inputSchema: { noteId: z.string() },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ noteId }) => toolResult(await client.notes.properties(noteId))
  );
  server.registerTool(
    'notes_patch_note_properties',
    {
      title: 'Patch note properties',
      description:
        'Patch supplied active property IDs; null clears. Requires current schemaId, schemaRevision and expectedRevision from a properties read. A conflict preserves stored state. Does not change body/hash/tags. Property-only UI-configured Select boards regroup on refresh; no board writes or tag synchronization. Select values are stable option IDs from the schema, not labels. Prefer defined properties; do not mirror Status/Type into tags unless requested.',
      inputSchema: {
        noteId: z.string(),
        schemaId: z.string().nullable(),
        schemaRevision: z.number().int().nonnegative(),
        expectedRevision: z.number().int().nonnegative(),
        values: z.record(z.string(), z.string().nullable()),
      },
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ noteId, ...input }) => toolResult(await client.notes.patchProperties(noteId, input))
  );
  return server;
}
