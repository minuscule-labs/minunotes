---
name: minunotes-harness-api
description: Curl/API-only MinuNotes harness skill for agents without registered MinuNotes tools. Use to read, search, create, edit, review, and inspect notes through /v1/harness with MINUNOTES_API_URL and MINUNOTES_API_KEY.
---

# MinuNotes Harness API Skill

Use this skill when the user wants an agent to read, search, create, or edit notes in MinuNotes through the harness API and registered MinuNotes tools are not available.

## Requirements

You need these environment variables or equivalent secrets:

- `MINUNOTES_API_URL` — API origin or API base, for example `https://api.notes.minusculelabs.com`.
- `MINUNOTES_API_KEY` — MinuNotes API key with folder permissions.

Normalize `MINUNOTES_API_URL` by removing any trailing slash. Harness routes live under `/v1/harness`.

The legacy `/api/harness` route has been removed from production.

Send the API key on every request:

```http
X-API-Key: <MINUNOTES_API_KEY>
```

Use JSON for request/response bodies.

## Permission model

The API key's global capabilities are a maximum ceiling. Folder-specific rules may reduce those capabilities but never increase them. For keys with `all` access, an unconfigured folder inherits the global ceiling. For `top_level` and `specific` keys, a matching folder rule is required. Rules can apply to an exact folder or a subtree; the nearest applicable rule wins.

Private and trashed folders are unavailable regardless of the key. Agent-read-only folders deny writes even when the key and folder rule otherwise allow editing.

Authenticated collaboration uses a separate `sharedAccessMode`: `none` (the default), `specific` selected active grants, or `all` current and future grants after an explicit user warning. Shared access never exceeds the collaborator's current Viewer/Commenter/Editor role and still intersects API-key capabilities, owner folder safety, and note API-editability. Revocation and downgrade apply immediately.

A full note read may include privacy-safe role/source context, but never read a note solely to inspect permissions. Direct-note grants return `folderId: null`; never infer or probe for the hidden containing folder. Resources created in a shared folder belong to its owner and are attributed to the authorizing user. Agents cannot move shared resources, reshare, administer public links, restore, permanently delete, or generally manage Trash. An edit-capable agent may move only eligible resources created by its authorizing user to the owner’s Trash. Treat `403` and `404` as intentional boundaries and do not retry against unrelated folders, infer resource existence, or attempt permission escalation.

## Rich Markdown

- GitHub-style callouts use `> [!NOTE]`, `TIP`, `IMPORTANT`, `WARNING`, or `CAUTION`.
- Mermaid diagrams use ordinary fenced `mermaid` code blocks.
- Treat both as portable Markdown and preserve their markers and fences during edits.

## Trash boundary

- Harness folder lists, search, direct reads, line reads, tags, links, backlinks, and orphan results include active content only. Folder lists and discovery searches return compact metadata rather than owner fields or full note content.
- A trashed note, template, or folder subtree is unavailable through `/v1/harness/*` and normally returns `404` when addressed by ID.
- The harness API cannot list Trash, restore, or permanently delete content. Focused `POST /notes/:noteId/trash` and `POST /folders/:folderId/trash` operations require human Editor access, credential edit capability, applicable shared scope, creator ownership, and owner policy. Direct-note grants, shared roots, mixed-creator subtrees, and owner-managed sharing configuration are denied.
- Trash operations are destructive. Call them only after the user explicitly requested the deletion or approved the exact destructive change.
- Do not interpret `404` as proof that content was permanently deleted; it may be outside the key's scope or recoverable in the owner's Trash.

## Safety and editing rules

- Use only the harness/API. Do not use browser access unless explicitly asked.
- Never fabricate existing note contents. Read or search only when existing content is required for the task.
- Always read a note and capture `contentHash` before editing.
- Include `baseHash` when editing to avoid overwriting concurrent changes.
- Prefer small, targeted edits.
- Preserve markdown structure, headings, links, wikilinks, tags, and image URLs.
- Check `documentType` before editing. Markdown patch edits only work for `markdown` notes.
- For generated `canvas.default` and `canvas.mindmap` documents, default to Minu diagram syntax instead of manually positioning JSON Canvas nodes. Use JSON Canvas only for exact imports or deterministic preservation of IDs, coordinates, links, and metadata.
- For app-owned images, preserve normal URL markdown such as `/internal/attachments/.../content`.
- Report the folder ID, note ID, and final changed markdown or section summary after edits.
- Use note moves to organize agent-created notes only within folders the API key can edit/create in.
- If an API key lacks permission or a shared grant was revoked/downgraded, report the issue instead of retrying unrelated actions or probing hidden context.

## Shared-note editing protocol

Treat canonical edits and Review comments as different collaboration modes:

- For an explicit, narrow edit request, read the current note, capture a fresh `contentHash`, make only the requested change, and summarize the changed sections afterward. Do not require another approval or pre-edit diff.
- For feedback, review, or suggestion requests—or when the connection can comment but cannot edit—use Review comments rather than changing canonical content.
- Before a broad rewrite, substantial deletion, structural reorganization, or ambiguous change, present a concise plan or proposed diff and request approval.
- When another collaborator's intent is uncertain, prefer an anchored comment or ask the user instead of silently rewriting their work.
- On `409`, do not overwrite or automatically replay the stale patch. Read the latest note, rebase the proposed change, and request approval if the rebased diff is materially different.
- On `403` or `404`, stop after the first denial and report the collaboration boundary without probing other resources.
- Role/source context is descriptive, not a mutation guarantee; credential scope and owner policy remain authoritative.
- After routine edits, provide a concise changed-section summary. Show a full diff when requested or when a broad change required approval.

## Net-new note fast path

When creating a new note that does not depend on existing note content:

1. Resolve the target folder from folder titles and `parentFolderId` relationships, following folder-list pagination as needed.
2. Create the note directly.
3. Do not search or read existing notes merely to confirm the folder or inspect permissions.

If note search is independently necessary for folder discovery, use only compact result metadata. If folder discovery remains incomplete, report the limitation or request clarification instead of reading unrelated note bodies.

## Common commands

Set shell helpers:

```bash
API="${MINUNOTES_API_URL%/}"
KEY="$MINUNOTES_API_KEY"
AUTH=(-H "X-API-Key: $KEY" -H "Content-Type: application/json")
```

List accessible folders:

```bash
curl -s "${AUTH[@]}" "$API/v1/harness/folders?limit=25"
```

Folder, tag, note-search, orphan, and cross-note line-search responses include `pageInfo`. When `hasMore` is true, pass the opaque `nextCursor` to the same endpoint with the same query and filters:

```bash
curl -s "${AUTH[@]}" "$API/v1/harness/folders?limit=25&cursor=$NEXT_CURSOR"
```

Do not inspect or modify cursors, reuse them across endpoints, or continue every page unless the task requires broader coverage.

Create a folder or subfolder:

```bash
curl -s "${AUTH[@]}" \
  -X POST "$API/v1/harness/folders" \
  -d '{"title":"Research","parentFolderId":"folder_xxx"}'
```

Search notes by title/content/folder/tag text:

```bash
curl -s "${AUTH[@]}" "$API/v1/harness/notes/search?q=project&limit=25"
curl -s "${AUTH[@]}" "$API/v1/harness/notes/search?q=project&tag=release-notes&limit=25"
curl -s "${AUTH[@]}" "$API/v1/harness/notes/search?q=project&limit=25&cursor=$NEXT_CURSOR"
```

Search results are compact metadata only: they include identity, folder, title, document type, type, and timestamps, but never full `content`, `userId`, or database folder-owner fields. Orphan results follow the same contract. After choosing a result, expand only what you need:

```bash
curl -s "${AUTH[@]}" "$API/v1/harness/notes/note_xxx"
curl -s "${AUTH[@]}" "$API/v1/harness/notes/note_xxx/outline"
curl -s "${AUTH[@]}" "$API/v1/harness/notes/note_xxx/sections/section-id"
curl -s "${AUTH[@]}" "$API/v1/harness/notes/note_xxx/lines?from=1&to=80"
```

Search lines across notes:

```bash
curl -s "${AUTH[@]}" "$API/v1/harness/notes/search-lines?q=todo&context=2&limit=10"
```

Cross-note line matches retain the matching line and requested context plus note identity and location. They omit repeated hashes, byte sizes, and total line counts; read the selected note explicitly when you need its current `contentHash` before editing.

### Recommended retrieval sequence

1. Search note metadata first; do not expect `content` in search or orphan responses.
2. Use `search-lines` when body text is the deciding signal, especially for long notes.
3. Read only the selected note, line range, or section needed for the task.
4. Before any edit, read the current note and use its returned `contentHash` as `baseHash`.

Do not fetch every search result in full. Choose candidates using title, folder, document type, and matching context, then expand selectively.

Create a note:

```bash
curl -s "${AUTH[@]}" \
  -X POST "$API/v1/harness/notes" \
  -d '{"folderId":"folder_xxx","title":"Agent Harness Smoke Test","content":"# Agent Harness Smoke Test\n\n- [ ] Created by harness\n"}'
```

Create/update responses return compact note metadata plus `contentHash`, not full note content. Read the note explicitly when content is needed.

Move notes to another accessible folder:

```bash
curl -s "${AUTH[@]}" \
  -X POST "$API/v1/harness/notes/move" \
  -d '{"noteIds":["note_xxx","note_yyy"],"targetFolderId":"folder_xxx"}'
```

Moving requires edit access to every source note folder and create access to the target folder. The response is compact and does not include note content.

Read a note:

```bash
curl -s "${AUTH[@]}" "$API/v1/harness/notes/note_xxx"
```

Get a note outline:

```bash
curl -s "${AUTH[@]}" "$API/v1/harness/notes/note_xxx/outline"
```

Read a section:

```bash
curl -s "${AUTH[@]}" "$API/v1/harness/notes/note_xxx/sections/section-id"
```

Read lines:

```bash
curl -s "${AUTH[@]}" "$API/v1/harness/notes/note_xxx/lines?from=1&to=80"
```

Read note events:

```bash
curl -s "${AUTH[@]}" "$API/v1/harness/notes/note_xxx/events?limit=25"
```

Edit a note using exact text replacement:

```bash
curl -s "${AUTH[@]}" \
  -X POST "$API/v1/harness/notes/note_xxx/edit" \
  -d '{
    "baseHash":"hash_from_read",
    "edits":[
      {"type":"replace_text","oldText":"- [ ] Created by harness","newText":"- [x] Created by harness"}
    ]
  }'
```

Append text:

```bash
curl -s "${AUTH[@]}" \
  -X POST "$API/v1/harness/notes/note_xxx/edit" \
  -d '{
    "baseHash":"hash_from_read",
    "edits":[{"type":"append","text":"\n- Added by agent\n"}]
  }'
```

Review comments on Markdown notes (message bodies are plain text, not Markdown):

```bash
# List threads and ordered messages
curl -s "${AUTH[@]}" "$API/v1/harness/notes/note_xxx/comments"

# Create a range thread using zero-based Markdown offsets and the current contentHash
curl -s "${AUTH[@]}" \
  -X POST "$API/v1/harness/notes/note_xxx/comments" \
  -d '{"body":"Please clarify this.","anchor":{"anchorType":"range","from":42,"to":61,"quote":"exact source text","prefix":"nearby text before","suffix":"nearby text after","documentHash":"hash_from_read"}}'

# Reply and resolve
curl -s "${AUTH[@]}" \
  -X POST "$API/v1/harness/notes/note_xxx/comments/comment_thread_xxx/replies" \
  -d '{"body":"Follow-up review."}'

curl -s "${AUTH[@]}" \
  -X POST "$API/v1/harness/notes/note_xxx/comments/comment_thread_xxx/resolve" \
  -d '{}'

# Toggle a reaction on one message (repeat to remove your reaction)
curl -s "${AUTH[@]}" \
  -X POST "$API/v1/harness/notes/note_xxx/comments/comment_thread_xxx/messages/comment_message_xxx/reactions" \
  -d '{"emoji":"🎉"}'
```

Message bodies are plain text and Markdown syntax is not rendered. Messages include grouped reaction counts and `reactedByCurrentActor`. Reactions accept one standard Unicode emoji, including joined and skin-tone emoji; `👍`, `❤️`, `😂`, `🎉`, `👀`, and `🚀` are the human UI's quick defaults. Every comment operation requires explicit Comment permission plus read access. Note edit permission and `isApiEditable` are not required for comments. Existing and new credentials have Comment disabled until the owner grants it. Message edits/deletes are author-only. Use the current document hash for creation and anchor updates; stale anchors return `409`. When a listed thread is `detached`, do not guess a replacement location. Comments are unavailable for canvases, templates, Trash, and public shares.

Create canvases from JSON Canvas, Minu diagram syntax, or the supported Mermaid flowchart subset.

For generated diagrams, use the syntax endpoint. It auto-detects Mermaid `flowchart`/`graph` headers; set `format` to `minu` or `mermaid` to force a parser. Mermaid is compiled into editable native JSON Canvas, not SVG. It supports standard flowchart directions, basic node shapes, labeled directed/undirected/bidirectional/dotted edges, and nested subgraphs; styling, actions, rich labels, and other diagram types fail closed with diagnostics. Server limits are 100,000 source characters, 500 native nodes, 1,000 edges, and 16 subgraph levels. Use Mermaid for supported flowcharts and Minu syntax for mind maps or Minu-specific layout. Keep node labels concise and plain text because canvas nodes do not render Markdown. Put the diagram title in the note or syntax title rather than a detached node. Reserve raw JSON Canvas for exact imports or user-requested IDs, positions, links, groups, styles, and metadata.

```bash
curl -s "${AUTH[@]}" \
  -X POST "$API/v1/harness/canvases" \
  -d '{"folderId":"folder_xxx","title":"Flow","canvas":{"nodes":[],"edges":[]}}'

curl -s "${AUTH[@]}" \
  -X POST "$API/v1/harness/canvases/from-syntax" \
  -d '{"folderId":"folder_xxx","syntax":"diagram \"Product plan\" {\n  layout mindmap\n  Product\n  Product > Research\n}"}'

# Auto-detect Mermaid flowcharts and persist them as editable native canvas data
curl -s "${AUTH[@]}" \
  -X POST "$API/v1/harness/canvases/from-syntax" \
  -d '{"folderId":"folder_xxx","title":"Release flow","format":"auto","syntax":"flowchart LR\n  draft[\"Draft\"] --> review{Approved?}\n  review -->|yes| shipped([Shipped])"}'
```

Replace an existing canvas:

```bash
curl -s "${AUTH[@]}" \
  -X PUT "$API/v1/harness/notes/note_xxx/canvas/from-syntax" \
  -d '{"baseHash":"hash_from_read","syntax":"diagram \"Auth flow\" {\n  User > Login\n  Login > Dashboard\n}"}'
```

Link or unlink one canvas node without replacing the full canvas:

```bash
curl -s "${AUTH[@]}" \
  -X POST "$API/v1/harness/notes/note_canvas/canvas/nodes/node_a/link-note" \
  -d '{"targetNoteId":"note_target","baseHash":"hash_from_read"}'

curl -s "${AUTH[@]}" \
  -X DELETE "$API/v1/harness/notes/note_canvas/canvas/nodes/node_a/link?baseHash=hash_from_read"
```

Internal links are stored as `node.minunotes.link = { "type": "note", "id": "note_…" }`. External links remain in `node.url`; link and unlink operations preserve external URLs and unrelated node metadata. Linking requires edit access to the canvas and read access to the target note.

Tags:

```bash
curl -s "${AUTH[@]}" "$API/v1/harness/tags"
curl -s "${AUTH[@]}" "$API/v1/harness/notes/note_xxx/tags"
curl -s "${AUTH[@]}" \
  -X PUT "$API/v1/harness/notes/note_xxx/tags" \
  -d '{"tags":["project","release-notes"]}'
```

Graph context:

```bash
curl -s "${AUTH[@]}" "$API/v1/harness/notes/note_xxx/backlinks"
curl -s "${AUTH[@]}" "$API/v1/harness/notes/note_xxx/links"
curl -s "${AUTH[@]}" "$API/v1/harness/notes/orphans"
```

## Endpoint reference

- `GET /v1/harness/folders?limit=25&cursor=...`
- `POST /v1/harness/folders`
- `POST /v1/harness/folders/:folderId/trash` (destructive; requires explicit user intent)
- `GET /v1/harness/tags?limit=25&cursor=...`
- `GET /v1/harness/notes/search?q=...&tag=...&limit=25&cursor=...`
- `GET /v1/harness/notes/search-lines?q=...&folderId=...&context=2&limit=25&caseSensitive=false&cursor=...`
- `POST /v1/harness/notes`
- `POST /v1/harness/notes/move`
- `POST /v1/harness/canvases`
- `POST /v1/harness/canvases/from-syntax` — accepts `format: auto | minu | mermaid` (default `auto`); Mermaid supports only the documented flowchart subset.
- `GET /v1/harness/notes/orphans?limit=25&cursor=...`
- `GET /v1/harness/notes/:noteId`
- `POST /v1/harness/notes/:noteId/trash` (destructive; requires explicit user intent)
- `GET /v1/harness/notes/:noteId/events?limit=25`
- `GET /v1/harness/notes/:noteId/comments`
- `POST /v1/harness/notes/:noteId/comments`
- `POST /v1/harness/notes/:noteId/comments/:threadId/replies`
- `PATCH /v1/harness/notes/:noteId/comments/:threadId/anchor`
- `POST /v1/harness/notes/:noteId/comments/:threadId/resolve`
- `POST /v1/harness/notes/:noteId/comments/:threadId/reopen`
- `PATCH /v1/harness/notes/:noteId/comments/:threadId/messages/:messageId`
- `DELETE /v1/harness/notes/:noteId/comments/:threadId/messages/:messageId`
- `DELETE /v1/harness/notes/:noteId/comments/:threadId`
- `GET /v1/harness/notes/:noteId/tags`
- `PUT /v1/harness/notes/:noteId/tags`
- `GET /v1/harness/notes/:noteId/backlinks`
- `GET /v1/harness/notes/:noteId/links`
- `GET /v1/harness/notes/:noteId/lines?from=1&to=80`
- `GET /v1/harness/notes/:noteId/search-lines?q=...&context=2&limit=25&caseSensitive=false`
- `GET /v1/harness/notes/:noteId/outline`
- `GET /v1/harness/notes/:noteId/sections/:sectionId`
- `PUT /v1/harness/notes/:noteId/canvas`
- `POST /v1/harness/notes/:noteId/canvas/nodes/:nodeId/link-note`
- `DELETE /v1/harness/notes/:noteId/canvas/nodes/:nodeId/link?baseHash=...`
- `PUT /v1/harness/notes/:noteId/canvas/from-syntax` — accepts the same `format` field and diagnostics.
- `POST /v1/harness/notes/:noteId/edit`

## Edit payload types

```ts
type DocumentEdit =
  | { type: "append"; text: string }
  | { type: "replace_text"; oldText: string; newText: string }
  | { type: "replace_range"; from: number; to: number; text: string };
```

Prefer `replace_text` when the target text is unique. Use `replace_range` only after reading lines/sections and when exact replacement is not practical.

For canvases, default to Minu diagram syntax for generated diagrams and mind maps. Do not hand-place an agent-composed diagram with JSON coordinates when syntax layout applies. Use JSON Canvas for exact imports and replacements that must preserve IDs, positions, links, groups, styles, or metadata. Syntax replacement is whole-document regeneration, so read the latest canvas and obtain approval before replacing a manually arranged or metadata-rich document.

## Error handling

- `401`: missing/invalid API key.
- `403`: API key lacks folder permission.
- `404`: note/folder/section not found.
- `409`: stale note edit or comment-anchor hash; reread the note and retry only after recomputing the edit or anchor.
- `500`: server error; report endpoint and response body.
