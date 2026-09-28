export const harnessOpenApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'MinuNotes Harness API',
    version: '0.1.0',
    description:
      'Agent-focused API for scoped active MinuNotes content, including explicitly enabled authenticated collaboration grants. Shared access is bounded by the human role, credential capabilities, selected shared mode, owner safety policy, and note API-editability. Trashed content is excluded. Creator-scoped move-to-Trash operations require edit access; Trash listing, restore, permanent deletion, and sharing administration are not exposed.',
  },
  servers: [{ url: '/' }],
  security: [{ ApiKeyAuth: [] }],
  tags: [
    { name: 'Folders' },
    { name: 'Notes' },
    { name: 'Review' },
    { name: 'Canvases' },
    { name: 'Tags' },
    { name: 'Shared' },
  ],
  paths: {
    '/v1/harness/tags': {
      get: {
        tags: ['Tags'],
        operationId: 'listTags',
        summary: 'List tags',
        description: 'Returns cursor-paginated tags visible in the authorized folder scope.',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Tags',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/PaginatedTagsResponse' } } },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/v1/harness/folders': {
      get: {
        tags: ['Folders'],
        operationId: 'listFolders',
        summary: 'List accessible active folders',
        description:
          'Returns compact owned and explicitly scoped shared-folder metadata. Owner/database and grant identifiers are omitted; inaccessible ancestry and trashed folder subtrees are excluded.',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Folders visible to the API key',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/FoldersResponse' } } },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
      post: {
        tags: ['Folders'],
        operationId: 'createFolder',
        summary: 'Create a folder',
        description:
          'Requires folder-creation permission. Creates an owned folder or a subfolder in an editable explicitly scoped shared folder. Shared resources remain in the owner corpus and are attributed to the authorizing user.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateFolderRequest' } } },
        },
        responses: {
          '201': {
            description: 'Created folder',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/FolderResponse' } } },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },
    '/v1/harness/folders/{folderId}/trash': {
      post: {
        tags: ['Folders'],
        operationId: 'trashFolder',
        summary: 'Move an eligible folder subtree to Trash',
        description:
          'Destructive. Requires edit capability. Shared-folder Editors may move only a subtree created entirely by the authorizing user, excluding shared roots and owner-managed sharing configuration. Trash restore and permanent deletion remain owner-only.',
        parameters: [{ $ref: '#/components/parameters/FolderId' }],
        responses: {
          '200': {
            description: 'Folder moved to Trash',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DeleteResponse' } } },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
          '409': { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    '/v1/harness/notes/search': {
      get: {
        tags: ['Notes'],
        operationId: 'searchNotes',
        summary: 'Search active notes',
        description:
          'Searches active owned and explicitly scoped shared notes. Returns compact metadata with privacy-safe role/source context but without note content. Direct-note grants return null folder context. Use the read-note, lines, or section endpoints to expand a selected note.',
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string', maxLength: 200 } },
          { name: 'tag', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Matching notes',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SearchNotesResponse' } } },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/v1/harness/notes/orphans': {
      get: {
        tags: ['Notes'],
        operationId: 'listOrphanNotes',
        summary: 'List notes with no incoming links',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Compact orphan note metadata without note content',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SearchNotesResponse' } } },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/v1/harness/notes/search-lines': {
      get: {
        tags: ['Notes'],
        operationId: 'searchNoteLines',
        summary: 'Search matching lines across notes',
        description:
          'Returns cursor-paginated matching lines and requested context. Cross-note matches omit repeated hashes and size metadata; use the note read endpoint for full content and the current hash.',
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string', maxLength: 200 } },
          { name: 'folderId', in: 'query', schema: { type: 'string' } },
          { name: 'context', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 5 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
          { name: 'caseSensitive', in: 'query', schema: { type: 'boolean' } },
        ],
        responses: {
          '200': {
            description: 'Line matches',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/LineSearchResponse' } } },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/v1/harness/notes': {
      post: {
        tags: ['Notes'],
        operationId: 'createNote',
        summary: 'Create a note',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateNoteRequest' } } },
        },
        responses: {
          '201': {
            description: 'Created note summary',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/NoteMutationResponse' } } },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },
    '/v1/harness/notes/move': {
      post: {
        tags: ['Notes'],
        operationId: 'moveNotes',
        summary: 'Move notes to a folder',
        description:
          'Moves one or more notes to a target folder. Requires edit access to every source folder and create access to the target folder. The response is compact and does not include note content.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/MoveNotesRequest' } } },
        },
        responses: {
          '200': {
            description: 'Moved note summaries',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MoveNotesResponse' } } },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/v1/harness/canvases': {
      post: {
        tags: ['Canvases'],
        operationId: 'createCanvas',
        summary: 'Create a canvas note from JSON Canvas',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateCanvasRequest' } } },
        },
        responses: {
          '201': {
            description: 'Created canvas note summary',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/NoteMutationResponse' } } },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },
    '/v1/harness/canvases/from-syntax': {
      post: {
        tags: ['Canvases'],
        operationId: 'createCanvasFromSyntax',
        summary: 'Create a canvas note from Minu or Mermaid flowchart syntax',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateCanvasFromSyntaxRequest' } } },
        },
        responses: {
          '201': {
            description: 'Created canvas note summary',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/CanvasSyntaxNoteMutationResponse' } },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },
    '/v1/harness/notes/{noteId}': {
      get: {
        tags: ['Notes'],
        operationId: 'getNote',
        summary: 'Read an active note',
        description:
          'Reads an owned or explicitly scoped shared note when its content is needed and returns privacy-safe role/source context. Do not read solely to inspect permissions. Direct-note grants return null folder context. Owner and grant database identifiers are never returned. Not found can also mean inaccessible, revoked, or trashed.',
        parameters: [{ $ref: '#/components/parameters/NoteId' }],
        responses: {
          '200': {
            description: 'Note',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/NoteResponse' } } },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/v1/harness/notes/{noteId}/comments': {
      get: {
        tags: ['Review'],
        operationId: 'listCommentThreads',
        summary: 'List anchored comment threads',
        description:
          'Lists Review threads on an active markdown note. Explicit Comment permission and read access to the note folder are required.',
        parameters: [{ $ref: '#/components/parameters/NoteId' }],
        responses: {
          '200': {
            description: 'Comment threads and ordered messages',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CommentThreadsResponse' } } },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
      post: {
        tags: ['Review'],
        operationId: 'createCommentThread',
        summary: 'Create an anchored comment thread',
        description:
          'Creates a thread and first message. Explicit Comment permission, read access, a current document hash, and an exact markdown anchor are required. Note edit permission is not required.',
        parameters: [{ $ref: '#/components/parameters/NoteId' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateCommentThreadRequest' } } },
        },
        responses: {
          '201': {
            description: 'Created thread',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CommentThreadResponse' } } },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
          '409': { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    '/v1/harness/notes/{noteId}/comments/{threadId}': {
      delete: {
        tags: ['Review'],
        operationId: 'deleteCommentThread',
        summary: 'Delete a comment thread',
        description: 'The note owner or thread author may delete the complete thread.',
        parameters: [{ $ref: '#/components/parameters/NoteId' }, { $ref: '#/components/parameters/ThreadId' }],
        responses: {
          '200': { $ref: '#/components/responses/Deleted' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/v1/harness/notes/{noteId}/comments/{threadId}/replies': {
      post: {
        tags: ['Review'],
        operationId: 'addCommentReply',
        summary: 'Reply to a comment thread',
        parameters: [{ $ref: '#/components/parameters/NoteId' }, { $ref: '#/components/parameters/ThreadId' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CommentBodyRequest' } } },
        },
        responses: {
          '201': {
            description: 'Created reply',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CommentMessageResponse' } } },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/v1/harness/notes/{noteId}/comments/{threadId}/anchor': {
      patch: {
        tags: ['Review'],
        operationId: 'updateCommentAnchor',
        summary: 'Update a locally mapped comment anchor',
        parameters: [{ $ref: '#/components/parameters/NoteId' }, { $ref: '#/components/parameters/ThreadId' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/UpdateCommentAnchorRequest' } } },
        },
        responses: {
          '200': {
            description: 'Updated thread',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CommentThreadResponse' } } },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
          '409': { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    '/v1/harness/notes/{noteId}/comments/{threadId}/resolve': {
      post: {
        tags: ['Review'],
        operationId: 'resolveCommentThread',
        summary: 'Resolve a comment thread',
        parameters: [{ $ref: '#/components/parameters/NoteId' }, { $ref: '#/components/parameters/ThreadId' }],
        responses: {
          '200': {
            description: 'Resolved thread',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CommentThreadResponse' } } },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/v1/harness/notes/{noteId}/comments/{threadId}/reopen': {
      post: {
        tags: ['Review'],
        operationId: 'reopenCommentThread',
        summary: 'Reopen a resolved comment thread',
        parameters: [{ $ref: '#/components/parameters/NoteId' }, { $ref: '#/components/parameters/ThreadId' }],
        responses: {
          '200': {
            description: 'Reopened thread',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CommentThreadResponse' } } },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/v1/harness/notes/{noteId}/comments/{threadId}/messages/{messageId}': {
      patch: {
        tags: ['Review'],
        operationId: 'updateCommentMessage',
        summary: 'Edit an authored comment message',
        description: 'Only the original message author may edit it.',
        parameters: [
          { $ref: '#/components/parameters/NoteId' },
          { $ref: '#/components/parameters/ThreadId' },
          { $ref: '#/components/parameters/MessageId' },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CommentBodyRequest' } } },
        },
        responses: {
          '200': {
            description: 'Updated message',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CommentMessageResponse' } } },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
      delete: {
        tags: ['Review'],
        operationId: 'deleteCommentMessage',
        summary: 'Delete an authored comment message',
        description: 'Only the original author may delete a message. Deleting the root message deletes its thread.',
        parameters: [
          { $ref: '#/components/parameters/NoteId' },
          { $ref: '#/components/parameters/ThreadId' },
          { $ref: '#/components/parameters/MessageId' },
        ],
        responses: {
          '200': {
            description: 'Deletion result',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DeleteCommentMessageResponse' } } },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/v1/harness/notes/{noteId}/comments/{threadId}/messages/{messageId}/reactions': {
      post: {
        tags: ['Review'],
        operationId: 'toggleCommentReaction',
        summary: 'Toggle a reaction on a comment message',
        description:
          'Adds the selected reaction for the current actor, or removes it when already present. Requires read and explicit Comment permission.',
        parameters: [
          { $ref: '#/components/parameters/NoteId' },
          { $ref: '#/components/parameters/ThreadId' },
          { $ref: '#/components/parameters/MessageId' },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CommentReactionRequest' } } },
        },
        responses: {
          '200': {
            description: 'Current grouped reactions for the message',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CommentReactionsResponse' } } },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/v1/harness/notes/{noteId}/tags': {
      get: {
        tags: ['Tags'],
        operationId: 'listNoteTags',
        summary: 'List note tags',
        parameters: [{ $ref: '#/components/parameters/NoteId' }],
        responses: {
          '200': {
            description: 'Note tags',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/TagsResponse' } } },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
      put: {
        tags: ['Tags'],
        operationId: 'updateNoteTags',
        summary: 'Replace note tags',
        parameters: [{ $ref: '#/components/parameters/NoteId' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/UpdateTagsRequest' } } },
        },
        responses: {
          '200': {
            description: 'Updated note tags',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/TagsResponse' } } },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/v1/harness/notes/{noteId}/events': {
      get: {
        tags: ['Notes'],
        operationId: 'listNoteEvents',
        summary: 'List note events',
        parameters: [
          { $ref: '#/components/parameters/NoteId' },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 } },
        ],
        responses: {
          '200': {
            description: 'Note events',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/NoteEventsResponse' } } },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/v1/harness/notes/{noteId}/links': {
      get: {
        tags: ['Notes'],
        operationId: 'listNoteLinks',
        summary: 'List outgoing note links',
        description: 'Returns links from the note, including unresolved wikilinks where targetNoteId is null.',
        parameters: [{ $ref: '#/components/parameters/NoteId' }],
        responses: {
          '200': {
            description: 'Outgoing links',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/LinksResponse' } } },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/v1/harness/notes/{noteId}/backlinks': {
      get: {
        tags: ['Notes'],
        operationId: 'listNoteBacklinks',
        summary: 'List backlinks to a note',
        description:
          'Returns notes that link to the target note with wikilinks or internal note URLs. Results are filtered to source notes visible to the current API key.',
        parameters: [{ $ref: '#/components/parameters/NoteId' }],
        responses: {
          '200': {
            description: 'Note backlinks',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/BacklinksResponse' } } },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/v1/harness/notes/{noteId}/lines': {
      get: {
        tags: ['Notes'],
        operationId: 'readNoteLines',
        summary: 'Read numbered note lines',
        parameters: [
          { $ref: '#/components/parameters/NoteId' },
          { name: 'from', in: 'query', schema: { type: 'integer', minimum: 1 } },
          { name: 'to', in: 'query', schema: { type: 'integer', minimum: 1 } },
        ],
        responses: {
          '200': {
            description: 'Numbered lines',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/LinesResponse' } } },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/v1/harness/notes/{noteId}/search-lines': {
      get: {
        tags: ['Notes'],
        operationId: 'searchLinesInNote',
        summary: 'Search matching lines in one note',
        parameters: [
          { $ref: '#/components/parameters/NoteId' },
          { name: 'q', in: 'query', required: true, schema: { type: 'string', maxLength: 200 } },
          { name: 'context', in: 'query', schema: { type: 'integer', minimum: 0 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 } },
          { name: 'caseSensitive', in: 'query', schema: { type: 'boolean' } },
        ],
        responses: {
          '200': {
            description: 'Line matches',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/LineSearchResponse' } } },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/v1/harness/notes/{noteId}/outline': {
      get: {
        tags: ['Notes'],
        operationId: 'getNoteOutline',
        summary: 'Get note outline',
        parameters: [{ $ref: '#/components/parameters/NoteId' }],
        responses: {
          '200': {
            description: 'Note outline',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/OutlineResponse' } } },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/v1/harness/notes/{noteId}/sections/{sectionId}': {
      get: {
        tags: ['Notes'],
        operationId: 'readNoteSection',
        summary: 'Read a note section',
        parameters: [
          { $ref: '#/components/parameters/NoteId' },
          { name: 'sectionId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Note section',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SectionResponse' } } },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/v1/harness/notes/{noteId}/canvas': {
      put: {
        tags: ['Canvases'],
        operationId: 'replaceCanvas',
        summary: 'Replace a canvas note with JSON Canvas',
        parameters: [{ $ref: '#/components/parameters/NoteId' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ReplaceCanvasRequest' } } },
        },
        responses: {
          '200': {
            description: 'Updated canvas note summary',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/NoteMutationResponse' } } },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
          '409': { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    '/v1/harness/notes/{noteId}/canvas/nodes/{nodeId}/link-note': {
      post: {
        tags: ['Canvases'],
        operationId: 'linkCanvasNodeToNote',
        summary: 'Link a canvas node to a MinuNotes note',
        description:
          'Adds MinuNotes internal-link metadata to one canvas node while preserving external URLs and other node metadata. Requires edit access to the canvas and read access to the target note.',
        parameters: [
          { $ref: '#/components/parameters/NoteId' },
          { name: 'nodeId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/LinkCanvasNodeToNoteRequest' } } },
        },
        responses: {
          '200': {
            description: 'Updated canvas note summary',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/NoteMutationResponse' } } },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
          '409': { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    '/v1/harness/notes/{noteId}/canvas/nodes/{nodeId}/link': {
      delete: {
        tags: ['Canvases'],
        operationId: 'unlinkCanvasNode',
        summary: 'Remove an internal note link from a canvas node',
        description:
          'Removes only MinuNotes internal-link metadata. External node URLs and other metadata are preserved.',
        parameters: [
          { $ref: '#/components/parameters/NoteId' },
          { name: 'nodeId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'baseHash', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Updated canvas note summary',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/NoteMutationResponse' } } },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
          '409': { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    '/v1/harness/notes/{noteId}/canvas/from-syntax': {
      put: {
        tags: ['Canvases'],
        operationId: 'replaceCanvasFromSyntax',
        summary: 'Replace a canvas note with compiled Minu or Mermaid flowchart syntax',
        parameters: [{ $ref: '#/components/parameters/NoteId' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ReplaceCanvasFromSyntaxRequest' } } },
        },
        responses: {
          '200': {
            description: 'Updated canvas note summary',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/CanvasSyntaxNoteMutationResponse' } },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
          '409': { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    '/v1/harness/notes/{noteId}/trash': {
      post: {
        tags: ['Notes'],
        operationId: 'trashNote',
        summary: 'Move an eligible note to Trash',
        description:
          'Destructive. Requires edit capability and API editability. Shared-folder Editors may move only notes created by the authorizing user. Direct-note grants and resources with owner-managed sharing configuration are denied. Trash restore and permanent deletion remain owner-only.',
        parameters: [{ $ref: '#/components/parameters/NoteId' }],
        responses: {
          '200': {
            description: 'Note moved to Trash',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DeleteResponse' } } },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
          '409': { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    '/v1/harness/notes/{noteId}/edit': {
      post: {
        tags: ['Notes'],
        operationId: 'editNote',
        summary: 'Edit a note',
        parameters: [{ $ref: '#/components/parameters/NoteId' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/EditNoteRequest' } } },
        },
        responses: {
          '200': {
            description: 'Updated note summary',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/NoteMutationResponse' } } },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
          '409': { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    '/internal/share/{token}': {
      get: {
        tags: ['Shared'],
        operationId: 'readSharedNote',
        summary: 'Read a publicly shared note and its authored wikilink destinations',
        security: [],
        parameters: [{ $ref: '#/components/parameters/ShareToken' }],
        responses: {
          '200': {
            description: 'Shared note content and source-bound public wikilink destinations',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/PublicSharedNoteResponse' } } },
          },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/internal/share/{token}/attachments/{attachmentId}/content': {
      get: {
        tags: ['Shared'],
        operationId: 'readSharedNoteAttachment',
        summary: 'Read an attachment owned by a publicly shared note',
        security: [],
        parameters: [{ $ref: '#/components/parameters/ShareToken' }, { $ref: '#/components/parameters/AttachmentId' }],
        responses: {
          '200': {
            description: 'Share-authorized attachment bytes',
            content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
          },
          '404': { $ref: '#/components/responses/NotFound' },
          '429': { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/internal/share/folders/{token}/notes/{noteId}/attachments/{attachmentId}/content': {
      get: {
        tags: ['Shared'],
        operationId: 'readSharedFolderNoteAttachment',
        summary: 'Read an attachment owned by one note in a publicly shared folder',
        security: [],
        parameters: [
          { $ref: '#/components/parameters/ShareToken' },
          { $ref: '#/components/parameters/NoteId' },
          { $ref: '#/components/parameters/AttachmentId' },
        ],
        responses: {
          '200': {
            description: 'Share-authorized attachment bytes',
            content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
          },
          '404': { $ref: '#/components/responses/NotFound' },
          '429': { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/internal/share/folders/{token}/notes/{noteId}/wikilinks': {
      get: {
        tags: ['Shared'],
        operationId: 'readSharedFolderNoteWikilinks',
        summary: 'Read authored wikilink destinations for one note in a publicly shared folder',
        description:
          'The token must be active and the source note must belong to the shared folder subtree. The endpoint accepts no target list and returns no private note metadata.',
        security: [],
        parameters: [{ $ref: '#/components/parameters/ShareToken' }, { $ref: '#/components/parameters/NoteId' }],
        responses: {
          '200': {
            description: 'Source-bound public wikilink destinations',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SharedWikilinkResolutionsResponse' } },
            },
          },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
  },
  components: {
    securitySchemes: { ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' } },
    parameters: {
      NoteId: { name: 'noteId', in: 'path', required: true, schema: { type: 'string' } },
      ThreadId: { name: 'threadId', in: 'path', required: true, schema: { type: 'string' } },
      MessageId: { name: 'messageId', in: 'path', required: true, schema: { type: 'string' } },
      ShareToken: { name: 'token', in: 'path', required: true, schema: { type: 'string' } },
      AttachmentId: { name: 'attachmentId', in: 'path', required: true, schema: { type: 'string' } },
    },
    responses: {
      BadRequest: {
        description: 'Bad request',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      },
      Unauthorized: {
        description: 'Missing or invalid API key',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      },
      Forbidden: {
        description: 'API key lacks required permission',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      },
      NotFound: {
        description: 'Resource not found',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      },
      RateLimited: {
        description: 'Rate limit exceeded',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      },
      Conflict: {
        description: 'Stale base hash or edit conflict',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      },
      Deleted: {
        description: 'Deleted',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/DeleteResponse' } } },
      },
    },
    schemas: {
      ErrorResponse: { type: 'object', required: ['error'], properties: { error: { type: 'string' } } },
      DeleteResponse: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean', const: true } } },
      CommentActor: {
        type: 'object',
        required: ['key', 'type', 'displayName', 'maskedEmail', 'label', 'isCurrentUser'],
        description: 'Safe actor identity. Internal user, API-key, OAuth, and raw email values are not exposed.',
        properties: {
          key: { type: 'string', description: 'Opaque stable presentation key.' },
          type: { type: 'string', enum: ['user', 'agent', 'former', 'system'] },
          displayName: { type: ['string', 'null'] },
          maskedEmail: { type: ['string', 'null'] },
          label: { type: 'string' },
          isCurrentUser: { type: 'boolean' },
        },
      },
      CommentAnchor: {
        type: 'object',
        required: ['anchorType', 'from', 'to', 'quote', 'documentHash', 'detached'],
        properties: {
          anchorType: { type: 'string', enum: ['range', 'line'] },
          from: { type: 'integer', minimum: 0 },
          to: { type: 'integer', minimum: 0 },
          quote: { type: 'string', maxLength: 20000 },
          prefix: { type: 'string' },
          suffix: { type: 'string' },
          documentHash: { type: 'string' },
          detached: { type: 'boolean' },
        },
      },
      CommentReaction: {
        type: 'object',
        required: ['emoji', 'count', 'reactedByCurrentActor'],
        properties: {
          emoji: { type: 'string', maxLength: 64, description: 'One normalized standard Unicode emoji.' },
          count: { type: 'integer', minimum: 1 },
          reactedByCurrentActor: { type: 'boolean' },
        },
      },
      CommentMessage: {
        type: 'object',
        required: ['id', 'threadId', 'body', 'author', 'createdAt', 'updatedAt', 'reactions'],
        properties: {
          id: { type: 'string' },
          threadId: { type: 'string' },
          body: { type: 'string', maxLength: 10000 },
          author: { $ref: '#/components/schemas/CommentActor' },
          createdAt: { type: 'string' },
          updatedAt: { type: 'string' },
          reactions: { type: 'array', items: { $ref: '#/components/schemas/CommentReaction' } },
        },
      },
      CommentThread: {
        type: 'object',
        required: [
          'id',
          'noteId',
          'status',
          'anchor',
          'createdBy',
          'resolvedBy',
          'resolvedAt',
          'createdAt',
          'updatedAt',
          'messages',
        ],
        properties: {
          id: { type: 'string' },
          noteId: { type: 'string' },
          status: { type: 'string', enum: ['open', 'resolved'] },
          anchor: { $ref: '#/components/schemas/CommentAnchor' },
          createdBy: { $ref: '#/components/schemas/CommentActor' },
          resolvedBy: { oneOf: [{ $ref: '#/components/schemas/CommentActor' }, { type: 'null' }] },
          resolvedAt: { type: ['string', 'null'] },
          createdAt: { type: 'string' },
          updatedAt: { type: 'string' },
          messages: { type: 'array', items: { $ref: '#/components/schemas/CommentMessage' } },
        },
      },
      CommentThreadsResponse: {
        type: 'object',
        required: ['noteId', 'documentHash', 'threads'],
        properties: {
          noteId: { type: 'string' },
          documentHash: { type: 'string' },
          threads: { type: 'array', items: { $ref: '#/components/schemas/CommentThread' } },
        },
      },
      CommentThreadResponse: {
        type: 'object',
        required: ['thread'],
        properties: { thread: { $ref: '#/components/schemas/CommentThread' } },
      },
      CommentMessageResponse: {
        type: 'object',
        required: ['message'],
        properties: { message: { $ref: '#/components/schemas/CommentMessage' } },
      },
      CommentAnchorInput: {
        type: 'object',
        required: ['anchorType', 'from', 'to', 'quote', 'documentHash'],
        properties: {
          anchorType: { type: 'string', enum: ['range', 'line'] },
          from: { type: 'integer', minimum: 0 },
          to: { type: 'integer', minimum: 0 },
          quote: { type: 'string', maxLength: 20000 },
          prefix: { type: 'string' },
          suffix: { type: 'string' },
          documentHash: { type: 'string' },
          detached: { type: 'boolean' },
        },
      },
      CreateCommentThreadRequest: {
        type: 'object',
        required: ['body', 'anchor'],
        properties: {
          body: { type: 'string', maxLength: 10000 },
          anchor: { $ref: '#/components/schemas/CommentAnchorInput' },
        },
      },
      UpdateCommentAnchorRequest: {
        type: 'object',
        required: ['anchor'],
        properties: { anchor: { $ref: '#/components/schemas/CommentAnchorInput' } },
      },
      CommentBodyRequest: {
        type: 'object',
        required: ['body'],
        properties: { body: { type: 'string', maxLength: 10000 } },
      },
      CommentReactionRequest: {
        type: 'object',
        required: ['emoji'],
        properties: {
          emoji: { type: 'string', minLength: 1, maxLength: 64, description: 'One standard Unicode emoji.' },
        },
      },
      CommentReactionsResponse: {
        type: 'object',
        required: ['messageId', 'reactions'],
        properties: {
          messageId: { type: 'string' },
          reactions: { type: 'array', items: { $ref: '#/components/schemas/CommentReaction' } },
        },
      },
      DeleteCommentMessageResponse: {
        type: 'object',
        required: ['ok', 'deletedThread'],
        properties: { ok: { type: 'boolean', const: true }, deletedThread: { type: 'boolean' } },
      },
      SharedWikilinkResolution: {
        type: 'object',
        required: ['target', 'href'],
        properties: {
          target: { type: 'string', description: 'An authored wikilink target from the shared source note.' },
          href: {
            type: ['string', 'null'],
            description: 'A safe public /share/ destination when reachable, otherwise null.',
          },
        },
      },
      SharedWikilinkResolutionsResponse: {
        type: 'object',
        required: ['resolutions'],
        properties: {
          resolutions: {
            type: 'array',
            items: { $ref: '#/components/schemas/SharedWikilinkResolution' },
          },
        },
      },
      PublicSharedNote: {
        type: 'object',
        required: ['title', 'content', 'documentType', 'updatedAt'],
        properties: {
          title: { type: 'string' },
          content: { type: 'string' },
          documentType: { type: 'string', enum: ['markdown', 'canvas.default', 'canvas.mindmap'] },
          updatedAt: { type: 'string' },
        },
      },
      PublicShareSummary: {
        type: 'object',
        required: ['id', 'permission', 'createdAt'],
        properties: {
          id: { type: 'string' },
          permission: { type: 'string', enum: ['read'] },
          createdAt: { type: 'string' },
        },
      },
      PublicSharedNoteResponse: {
        type: 'object',
        required: ['note', 'share', 'resolutions'],
        properties: {
          note: { $ref: '#/components/schemas/PublicSharedNote' },
          share: { $ref: '#/components/schemas/PublicShareSummary' },
          resolutions: {
            type: 'array',
            items: { $ref: '#/components/schemas/SharedWikilinkResolution' },
          },
        },
      },
      AccessSummary: {
        type: 'object',
        required: ['role', 'source'],
        description: 'Privacy-safe effective collaboration context. No owner, grant, or authorization ids are exposed.',
        properties: {
          role: { type: 'string', enum: ['owner', 'viewer', 'commenter', 'editor'] },
          source: { type: 'string', enum: ['owner', 'note_grant', 'folder_grant'] },
        },
      },
      Folder: {
        type: 'object',
        required: ['id', 'parentFolderId', 'title', 'isPrivate', 'isAgentReadOnly', 'createdAt', 'updatedAt'],
        properties: {
          id: { type: 'string' },
          parentFolderId: { type: ['string', 'null'] },
          title: { type: 'string' },
          isPrivate: {
            type: 'boolean',
            description: 'Private folders are not accessible to API keys, MCP, or integrations.',
          },
          isAgentReadOnly: {
            type: 'boolean',
            description: 'Broad API key scopes can read but not create or edit in this folder.',
          },
          createdAt: { type: 'string' },
          updatedAt: { type: 'string' },
        },
      },
      PageInfo: {
        type: 'object',
        required: ['hasMore', 'nextCursor'],
        properties: {
          hasMore: { type: 'boolean' },
          nextCursor: { type: ['string', 'null'] },
        },
      },
      FoldersResponse: {
        type: 'object',
        required: ['folders', 'pageInfo'],
        properties: {
          folders: { type: 'array', items: { $ref: '#/components/schemas/Folder' } },
          pageInfo: { $ref: '#/components/schemas/PageInfo' },
        },
      },
      FolderResponse: {
        type: 'object',
        required: ['folder'],
        properties: { folder: { $ref: '#/components/schemas/Folder' } },
      },
      CreateFolderRequest: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string' },
          parentFolderId: {
            type: ['string', 'null'],
            description: 'Optional parent folder. Maximum depth is five folder levels.',
          },
        },
      },
      DocumentType: { type: 'string', enum: ['markdown', 'canvas.default', 'canvas.mindmap'] },
      CanvasDocument: {
        type: 'object',
        required: ['nodes', 'edges'],
        properties: {
          nodes: { type: 'array', items: { type: 'object', additionalProperties: true } },
          edges: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
        additionalProperties: true,
      },
      DiagramDiagnostic: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['warning', 'error'] },
          message: { type: 'string' },
          line: { type: 'integer' },
          column: { type: 'integer' },
          code: { type: 'string' },
          suggestion: { type: 'string' },
        },
      },
      Note: {
        type: 'object',
        required: [
          'id',
          'folderId',
          'title',
          'content',
          'documentType',
          'type',
          'isApiEditable',
          'createdAt',
          'updatedAt',
        ],
        properties: {
          id: { type: 'string' },
          folderId: {
            type: ['string', 'null'],
            description: 'Null for a direct-note grant so inaccessible folder context cannot be inferred.',
          },
          title: { type: 'string' },
          content: {
            type: 'string',
            description: 'Markdown for markdown notes, serialized JSON Canvas for canvas notes.',
          },
          documentType: { $ref: '#/components/schemas/DocumentType' },
          type: { type: 'string', enum: ['note', 'template'] },
          isApiEditable: { type: 'boolean' },
          updatedByActorType: { type: ['string', 'null'] },
          updatedByActorId: { type: ['string', 'null'] },
          createdAt: { type: 'string' },
          updatedAt: { type: 'string' },
          folderTitle: { type: ['string', 'null'] },
        },
      },
      CompactNote: {
        type: 'object',
        required: ['id', 'folderId', 'title', 'documentType', 'type', 'createdAt', 'updatedAt'],
        properties: {
          id: { type: 'string' },
          folderId: {
            type: ['string', 'null'],
            description: 'Null for a direct-note grant so inaccessible folder context cannot be inferred.',
          },
          title: { type: 'string' },
          documentType: { $ref: '#/components/schemas/DocumentType' },
          type: { type: 'string', enum: ['note', 'template'] },
          createdAt: { type: 'string' },
          updatedAt: { type: 'string' },
          folderTitle: { type: ['string', 'null'] },
        },
      },
      NoteResponse: {
        type: 'object',
        required: ['note', 'contentHash', 'access'],
        properties: {
          note: { $ref: '#/components/schemas/Note' },
          contentHash: { type: 'string' },
          access: { $ref: '#/components/schemas/AccessSummary' },
        },
      },
      NoteMutationResponse: {
        type: 'object',
        required: ['note', 'contentHash'],
        description: 'Compact create/update response. Use the read-note endpoint to retrieve full content.',
        properties: {
          note: { $ref: '#/components/schemas/CompactNote' },
          contentHash: { type: 'string' },
        },
      },
      MoveNotesResponse: {
        type: 'object',
        required: ['targetFolderId', 'notes'],
        description: 'Compact batch move response. Use the read-note endpoint to retrieve full content.',
        properties: {
          targetFolderId: { type: 'string' },
          notes: { type: 'array', items: { $ref: '#/components/schemas/CompactNote' } },
        },
      },
      CanvasSyntaxNoteResponse: {
        type: 'object',
        required: ['note', 'contentHash', 'diagnostics'],
        properties: {
          note: { $ref: '#/components/schemas/Note' },
          contentHash: { type: 'string' },
          diagnostics: { type: 'array', items: { $ref: '#/components/schemas/DiagramDiagnostic' } },
        },
      },
      CanvasSyntaxNoteMutationResponse: {
        type: 'object',
        required: ['note', 'contentHash', 'diagnostics'],
        description:
          'Compact create/update response with diagram diagnostics. Use the read-note endpoint to retrieve full content.',
        properties: {
          note: { $ref: '#/components/schemas/CompactNote' },
          contentHash: { type: 'string' },
          diagnostics: { type: 'array', items: { $ref: '#/components/schemas/DiagramDiagnostic' } },
        },
      },
      SearchNotesResponse: {
        type: 'object',
        required: ['notes', 'pageInfo'],
        description:
          'Compact discovery response. Note content is available through the explicit read/lines/section endpoints.',
        properties: {
          notes: { type: 'array', items: { $ref: '#/components/schemas/CompactNote' } },
          pageInfo: { $ref: '#/components/schemas/PageInfo' },
        },
      },
      Tag: {
        type: 'object',
        required: ['id', 'name', 'normalizedName'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          normalizedName: { type: 'string' },
          noteCount: { type: 'integer' },
        },
      },
      TagsResponse: {
        type: 'object',
        required: ['tags'],
        properties: { tags: { type: 'array', items: { $ref: '#/components/schemas/Tag' } } },
      },
      PaginatedTagsResponse: {
        type: 'object',
        required: ['tags', 'pageInfo'],
        properties: {
          tags: { type: 'array', items: { $ref: '#/components/schemas/Tag' } },
          pageInfo: { $ref: '#/components/schemas/PageInfo' },
        },
      },
      UpdateTagsRequest: {
        type: 'object',
        required: ['tags'],
        properties: { tags: { type: 'array', items: { type: 'string' } } },
      },
      CreateNoteRequest: {
        type: 'object',
        required: ['folderId'],
        properties: {
          folderId: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string' },
          documentType: { $ref: '#/components/schemas/DocumentType' },
        },
      },
      MoveNotesRequest: {
        type: 'object',
        required: ['noteIds', 'targetFolderId'],
        properties: {
          noteIds: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } },
          targetFolderId: { type: 'string' },
        },
      },
      CreateCanvasRequest: {
        type: 'object',
        required: ['folderId'],
        properties: {
          folderId: { type: 'string' },
          title: { type: 'string' },
          documentType: { type: 'string', enum: ['canvas.default', 'canvas.mindmap'] },
          canvas: { $ref: '#/components/schemas/CanvasDocument' },
        },
      },
      ReplaceCanvasRequest: {
        type: 'object',
        required: ['canvas'],
        properties: {
          title: { type: 'string' },
          documentType: { type: 'string', enum: ['canvas.default', 'canvas.mindmap'] },
          canvas: { $ref: '#/components/schemas/CanvasDocument' },
          baseHash: { type: 'string' },
        },
      },
      LinkCanvasNodeToNoteRequest: {
        type: 'object',
        required: ['targetNoteId'],
        properties: {
          targetNoteId: { type: 'string' },
          baseHash: { type: 'string' },
        },
      },
      CreateCanvasFromSyntaxRequest: {
        type: 'object',
        required: ['folderId', 'syntax'],
        properties: {
          folderId: { type: 'string' },
          title: { type: 'string' },
          documentType: { type: 'string', enum: ['canvas.default', 'canvas.mindmap'] },
          syntax: {
            type: 'string',
            description:
              'Minu diagram syntax or a supported Mermaid flowchart. Auto-detection recognizes Mermaid `flowchart`/`graph` headers; unsupported Mermaid features fail with diagnostics.',
          },
          format: {
            type: 'string',
            enum: ['auto', 'minu', 'mermaid'],
            description: 'Syntax dialect. Defaults to auto-detection; use minu or mermaid to force a parser.',
          },
        },
      },
      ReplaceCanvasFromSyntaxRequest: {
        type: 'object',
        required: ['syntax'],
        properties: {
          title: { type: 'string' },
          documentType: { type: 'string', enum: ['canvas.default', 'canvas.mindmap'] },
          syntax: {
            type: 'string',
            description:
              'Minu diagram syntax or a supported Mermaid flowchart. Auto-detection recognizes Mermaid `flowchart`/`graph` headers; unsupported Mermaid features fail with diagnostics.',
          },
          format: {
            type: 'string',
            enum: ['auto', 'minu', 'mermaid'],
            description: 'Syntax dialect. Defaults to auto-detection; use minu or mermaid to force a parser.',
          },
          baseHash: { type: 'string' },
        },
      },
      NumberedLine: {
        type: 'object',
        required: ['line', 'text'],
        properties: { line: { type: 'integer' }, text: { type: 'string' } },
      },
      LinesResponse: {
        type: 'object',
        properties: {
          noteId: { type: 'string' },
          contentHash: { type: 'string' },
          from: { type: 'integer' },
          to: { type: 'integer' },
          lineCount: { type: 'integer' },
          lines: { type: 'array', items: { $ref: '#/components/schemas/NumberedLine' } },
        },
      },
      LineSearchMatch: {
        type: 'object',
        properties: {
          noteId: { type: 'string' },
          folderId: { type: ['string', 'null'] },
          title: { type: 'string' },
          line: { type: 'integer' },
          column: { type: 'integer' },
          text: { type: 'string' },
          before: { type: 'array', items: { $ref: '#/components/schemas/NumberedLine' } },
          after: { type: 'array', items: { $ref: '#/components/schemas/NumberedLine' } },
        },
      },
      LineSearchResponse: {
        type: 'object',
        required: ['query', 'matches'],
        properties: {
          query: { type: 'string' },
          pageInfo: { $ref: '#/components/schemas/PageInfo' },
          noteId: { type: 'string', description: 'Present for searches restricted to one note.' },
          title: { type: 'string', description: 'Present for searches restricted to one note.' },
          folderId: { type: 'string', description: 'Present for searches restricted to one note.' },
          contentHash: { type: 'string', description: 'Present for searches restricted to one note.' },
          noteSizeBytes: { type: 'integer', description: 'Present for searches restricted to one note.' },
          lineCount: { type: 'integer', description: 'Present for searches restricted to one note.' },
          matches: { type: 'array', items: { $ref: '#/components/schemas/LineSearchMatch' } },
        },
      },
      NoteEvent: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          noteId: { type: 'string' },
          actor: { $ref: '#/components/schemas/CommentActor' },
          eventType: { type: 'string' },
          summary: { type: 'string' },
          beforeHash: { type: ['string', 'null'] },
          afterHash: { type: ['string', 'null'] },
          createdAt: { type: 'string' },
        },
      },
      NoteEventsResponse: {
        type: 'object',
        required: ['noteId', 'events'],
        properties: {
          noteId: { type: 'string' },
          events: { type: 'array', items: { $ref: '#/components/schemas/NoteEvent' } },
        },
      },
      NoteLink: {
        type: 'object',
        required: ['id', 'sourceNoteId', 'targetNoteId', 'targetTitle', 'label', 'linkType', 'createdAt', 'updatedAt'],
        properties: {
          id: { type: 'string' },
          sourceNoteId: { type: 'string' },
          targetNoteId: { type: ['string', 'null'] },
          targetTitle: { type: 'string' },
          label: { type: ['string', 'null'] },
          linkType: {
            type: 'string',
            enum: ['wikilink', 'internal-url', 'markdown-internal-url', 'canvas-note'],
          },
          createdAt: { type: 'string' },
          updatedAt: { type: 'string' },
        },
      },
      LinksResponse: {
        type: 'object',
        required: ['noteId', 'links'],
        properties: {
          noteId: { type: 'string' },
          links: { type: 'array', items: { $ref: '#/components/schemas/NoteLink' } },
        },
      },
      Backlink: {
        type: 'object',
        required: [
          'id',
          'sourceNoteId',
          'sourceTitle',
          'sourceFolderId',
          'targetTitle',
          'label',
          'linkType',
          'createdAt',
          'updatedAt',
        ],
        properties: {
          id: { type: 'string' },
          sourceNoteId: { type: 'string' },
          sourceTitle: { type: 'string' },
          sourceFolderId: { type: 'string' },
          targetTitle: { type: 'string' },
          label: { type: ['string', 'null'] },
          linkType: {
            type: 'string',
            enum: ['wikilink', 'internal-url', 'markdown-internal-url', 'canvas-note'],
          },
          createdAt: { type: 'string' },
          updatedAt: { type: 'string' },
        },
      },
      BacklinksResponse: {
        type: 'object',
        required: ['noteId', 'backlinks'],
        properties: {
          noteId: { type: 'string' },
          backlinks: { type: 'array', items: { $ref: '#/components/schemas/Backlink' } },
        },
      },
      DocumentSection: {
        type: 'object',
        required: ['id', 'heading', 'level', 'from', 'to', 'contentFrom', 'contentTo'],
        properties: {
          id: { type: 'string' },
          heading: { type: 'string' },
          level: { type: 'integer' },
          from: { type: 'integer' },
          to: { type: 'integer' },
          contentFrom: { type: 'integer' },
          contentTo: { type: 'integer' },
        },
      },
      OutlineResponse: {
        type: 'object',
        required: ['noteId', 'contentHash', 'sections'],
        properties: {
          noteId: { type: 'string' },
          contentHash: { type: 'string' },
          sections: { type: 'array', items: { $ref: '#/components/schemas/DocumentSection' } },
        },
      },
      SectionResponse: {
        type: 'object',
        required: ['noteId', 'contentHash', 'section'],
        properties: {
          noteId: { type: 'string' },
          contentHash: { type: 'string' },
          section: {
            allOf: [
              { $ref: '#/components/schemas/DocumentSection' },
              { type: 'object', properties: { markdown: { type: 'string' }, content: { type: 'string' } } },
            ],
          },
        },
      },
      DocumentEdit: {
        oneOf: [
          {
            type: 'object',
            required: ['type', 'text'],
            properties: { type: { const: 'append' }, text: { type: 'string' } },
          },
          {
            type: 'object',
            required: ['type', 'oldText', 'newText'],
            properties: { type: { const: 'replace_text' }, oldText: { type: 'string' }, newText: { type: 'string' } },
          },
          {
            type: 'object',
            required: ['type', 'from', 'to', 'text'],
            properties: {
              type: { const: 'replace_range' },
              from: { type: 'integer' },
              to: { type: 'integer' },
              text: { type: 'string' },
            },
          },
        ],
      },
      EditNoteRequest: {
        type: 'object',
        required: ['edits'],
        properties: {
          baseHash: { type: 'string' },
          edits: { type: 'array', minItems: 1, items: { $ref: '#/components/schemas/DocumentEdit' } },
        },
      },
    },
  },
} as const;
