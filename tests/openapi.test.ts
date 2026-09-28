import { describe, expect, it } from 'vitest';
import app from '../src/api/index';

describe('harness OpenAPI spec', () => {
  it('serves the harness OpenAPI document', async () => {
    const response = await app.request('/openapi.json');

    expect(response.status).toBe(200);
    const spec = (await response.json()) as {
      openapi: string;
      info: { description?: string };
      paths: Record<string, unknown>;
      components: {
        securitySchemes: Record<string, unknown>;
        schemas: Record<
          string,
          {
            properties?: Record<
              string,
              { $ref?: string; enum?: string[]; items?: { $ref?: string }; type?: string | string[] }
            >;
          }
        >;
      };
    };

    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.description).toContain('explicitly enabled authenticated collaboration grants');
    expect(spec.info.description).toContain('Trashed content is excluded');
    expect(spec.components.securitySchemes.ApiKeyAuth).toMatchObject({
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
    });
    expect(spec.paths).toHaveProperty('/v1/harness/folders');
    expect(spec.paths).toHaveProperty('/v1/harness/notes/{noteId}/edit');
    expect(spec.paths).toHaveProperty('/v1/harness/notes/orphans');
    expect(spec.components.schemas.CreateCanvasFromSyntaxRequest?.properties?.format?.enum).toEqual([
      'auto',
      'minu',
      'mermaid',
    ]);
    expect(spec.components.schemas.ReplaceCanvasFromSyntaxRequest?.properties?.format?.enum).toEqual([
      'auto',
      'minu',
      'mermaid',
    ]);
    expect(spec.components.schemas.SearchNotesResponse?.properties?.notes).toMatchObject({
      items: { $ref: '#/components/schemas/CompactNote' },
    });
    expect(spec.components.schemas.SearchNotesResponse?.properties?.pageInfo).toMatchObject({
      $ref: '#/components/schemas/PageInfo',
    });
    expect(spec.components.schemas.FoldersResponse?.properties?.pageInfo).toMatchObject({
      $ref: '#/components/schemas/PageInfo',
    });
    expect(spec.components.schemas.AccessSummary?.properties?.role?.enum).toEqual([
      'owner',
      'viewer',
      'commenter',
      'editor',
    ]);
    expect(spec.components.schemas.AccessSummary?.properties?.source?.enum).toEqual([
      'owner',
      'note_grant',
      'folder_grant',
    ]);
    expect(spec.components.schemas.NoteResponse?.properties?.access?.$ref).toBe('#/components/schemas/AccessSummary');
    expect(spec.components.schemas.CompactNote?.properties).not.toHaveProperty('access');
    expect(spec.components.schemas.Folder?.properties).not.toHaveProperty('access');
    expect(spec.components.schemas.Note?.properties?.folderId?.type).toEqual(['string', 'null']);
    expect(spec.components.schemas.Note?.properties).not.toHaveProperty('userId');
    expect(spec.components.schemas.PaginatedTagsResponse?.properties?.pageInfo).toMatchObject({
      $ref: '#/components/schemas/PageInfo',
    });
    expect(spec.paths).toHaveProperty('/v1/harness/notes/{noteId}/links');
    expect(spec.paths).toHaveProperty('/v1/harness/notes/{noteId}/backlinks');
    expect(spec.paths).toHaveProperty('/v1/harness/notes/{noteId}/tags');
    expect(spec.paths).toHaveProperty('/v1/harness/notes/{noteId}/comments');
    expect(spec.paths).toHaveProperty('/v1/harness/notes/{noteId}/comments/{threadId}/replies');
    expect(spec.paths).toHaveProperty('/v1/harness/notes/{noteId}/comments/{threadId}/anchor');
    expect(spec.paths).toHaveProperty('/v1/harness/notes/{noteId}/comments/{threadId}/resolve');
    expect(spec.paths).toHaveProperty('/v1/harness/notes/{noteId}/comments/{threadId}/reopen');
    expect(spec.paths).toHaveProperty('/v1/harness/notes/{noteId}/comments/{threadId}/messages/{messageId}');
    expect(spec.components.schemas).toHaveProperty('CommentThread');
    expect(spec.components.schemas).toHaveProperty('CommentMessage');
    expect(spec.components.schemas.CommentActor?.properties).toHaveProperty('key');
    expect(spec.components.schemas.CommentActor?.properties).toHaveProperty('label');
    expect(spec.components.schemas.CommentActor?.properties).not.toHaveProperty('id');
    expect(spec.components.schemas.CommentActor?.properties).not.toHaveProperty('name');
    expect(spec.components.schemas.CommentActor?.properties).not.toHaveProperty('userId');
    expect(spec.components.schemas.CommentActor?.properties).not.toHaveProperty('actorId');
    expect(spec.components.schemas.NoteEvent?.properties).not.toHaveProperty('userId');
    expect(spec.components.schemas.NoteEvent?.properties).not.toHaveProperty('actorId');
    expect(spec.paths).toHaveProperty('/v1/harness/notes/{noteId}/sections/{sectionId}');
    expect(spec.paths).toHaveProperty('/v1/harness/notes/{noteId}/canvas/nodes/{nodeId}/link-note');
    expect(spec.paths).toHaveProperty('/v1/harness/notes/{noteId}/canvas/nodes/{nodeId}/link');
    expect(spec.components.schemas.NoteLink?.properties?.linkType?.enum).toContain('canvas-note');
    expect(spec.components.schemas.Backlink?.properties?.linkType?.enum).toContain('canvas-note');
    expect(spec.paths).toHaveProperty('/v1/harness/notes/{noteId}/trash');
    expect(spec.paths).toHaveProperty('/v1/harness/folders/{folderId}/trash');
    expect(spec.paths).not.toHaveProperty('/v1/harness/trash');
    expect(Object.keys(spec.paths).some((path) => /restore|permanent-delete/.test(path))).toBe(false);
    expect(spec.paths).not.toHaveProperty('/v1/harness/notes/{noteId}.delete');
    expect(spec.paths).not.toHaveProperty('/v1/harness/folders/{folderId}.delete');
  });

  it('documents source-bound shared wikilink destinations as public read endpoints', async () => {
    const response = await app.request('/openapi.json');
    const spec = (await response.json()) as {
      paths: Record<
        string,
        {
          get?: {
            operationId?: string;
            security?: unknown[];
            responses?: Record<string, { content?: { 'application/json'?: { schema?: { $ref?: string } } } }>;
          };
        }
      >;
      components: { schemas: Record<string, unknown> };
    };

    const sharedNote = spec.paths['/internal/share/{token}']?.get;
    expect(sharedNote?.operationId).toBe('readSharedNote');
    expect(sharedNote?.security).toEqual([]);
    expect(sharedNote?.responses?.['200']?.content?.['application/json']?.schema?.$ref).toBe(
      '#/components/schemas/PublicSharedNoteResponse'
    );

    const sharedAttachment = spec.paths['/internal/share/{token}/attachments/{attachmentId}/content']?.get;
    expect(sharedAttachment?.operationId).toBe('readSharedNoteAttachment');
    expect(sharedAttachment?.security).toEqual([]);

    const sharedFolderAttachment =
      spec.paths['/internal/share/folders/{token}/notes/{noteId}/attachments/{attachmentId}/content']?.get;
    expect(sharedFolderAttachment?.operationId).toBe('readSharedFolderNoteAttachment');
    expect(sharedFolderAttachment?.security).toEqual([]);

    const folderNote = spec.paths['/internal/share/folders/{token}/notes/{noteId}/wikilinks']?.get;
    expect(folderNote?.operationId).toBe('readSharedFolderNoteWikilinks');
    expect(folderNote?.security).toEqual([]);
    expect(folderNote?.responses?.['200']?.content?.['application/json']?.schema?.$ref).toBe(
      '#/components/schemas/SharedWikilinkResolutionsResponse'
    );
    expect(spec.components.schemas).toHaveProperty('SharedWikilinkResolution');
    expect(spec.components.schemas).toHaveProperty('SharedWikilinkResolutionsResponse');
    expect(spec.components.schemas).toHaveProperty('PublicSharedNoteResponse');
  });

  it('also serves the spec under the harness namespace', async () => {
    const response = await app.request('/v1/openapi.json');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ info: { title: 'MinuNotes Harness API' } });
  });
});
