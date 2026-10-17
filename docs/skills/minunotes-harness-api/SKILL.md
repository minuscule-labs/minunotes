---
name: minunotes-harness-api
description: Curl/API-only MinuNotes harness skill for agents without registered MinuNotes tools. Use to read, search, create, edit, review, and inspect notes through /v1/harness with MINUNOTES_API_URL and MINUNOTES_API_KEY.
---

# MinuNotes Harness API Skill

Use this skill when registered MinuNotes tools are unavailable and direct API access is authorized. Prefer registered Pi/MCP tools when available. Missing tools, source support or an installed skill do not prove deployed support or authorize another credential/transport, live probes, or a reload.

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

Private and trashed folders are unavailable regardless of the key. Agent-read-only folders normally deny writes. The existing exception is `specific` access with an applicable `exact` folder rule, after all other capability and policy checks pass. It never expands the global ceiling or permits changing safety settings.

Authenticated collaboration uses a separate `sharedAccessMode`: `none` (the default), `specific` selected active grants, or `all` current and future grants after an explicit user warning. Shared access never exceeds the collaborator's current Viewer/Commenter/Editor role and still intersects API-key capabilities, owner folder safety, and note API-editability. Revocation and downgrade apply immediately.

A full note read may include privacy-safe role/source context, but never read a note solely to inspect permissions. Direct-note grants return `folderId: null`; never infer or probe for the hidden containing folder. Resources created in a shared folder belong to its owner and are attributed to the authorizing user. Agents cannot move shared resources, reshare, administer public links, restore, permanently delete, or generally manage Trash. An edit-capable agent may move only eligible resources created by its authorizing user to the owner’s Trash. Treat `403` and `404` as intentional boundaries and do not retry against unrelated folders, infer resource existence, or attempt permission escalation.

## Properties

Prefer defined folder properties for structured labels such as Status and Type. For requested classification, read the authorized schema and use stable property/option IDs, not labels. Ask if no suitable definition exists; do not invent fields, options or tags. Do not mirror Status/Type into tags unless requested. Honor explicit tag requests and reviewed template tags; preserve stored tags even though board cards hide them. This guidance does not remove tag endpoints or change permissions.

Use separate metadata operations; do not edit frontmatter or use a body hash for properties:

- `GET /v1/harness/folders/:folderId/properties`: authorized folder schema read.
- `PATCH /v1/harness/folders/:folderId/properties`: owner-only controlled schema mutation with `expectedRevision` and `mutation` (`add`, `rename`, `reorder`, `archive`, `add_option`, `rename_option`, `archive_option`, `reorder_options`). Types are immutable and IDs server-generated; reorder includes all historical IDs.
- `GET /v1/harness/notes/:noteId/properties`: applicable schema/values and independent revisions, with no hidden owner/folder identities.
- `PATCH /v1/harness/notes/:noteId/properties`: edit permission and applicable API-editability required.

Read properties first, then use the returned identity/revisions and actual property/option IDs:

```json
{
  "schemaId": "property_schema_from_read",
  "schemaRevision": 1,
  "expectedRevision": 0,
  "values": { "text_property_from_read": "Text value", "select_property_from_read": "option_id_from_read" }
}
```

The read returns `schema.schemaId`, `schema.revision` and note-properties `revision`. Missing state is revision 0; missing schema has identity null. Values are optional Text (up to 1,000 characters), Select (one option ID) or real date-only YYYY-MM-DD. `null` clears; empty Text clears. Unknown/foreign/archived IDs cannot be newly assigned. Untouched retained values are preserved. Changed writes emit `properties_update`; no-op writes emit no event. Body bytes/hash/tags/versions stay independent.

Preserve the draft on `409`; read current properties and explicitly review before retrying. Stop on permission denial. Folder schema mutations require ownership plus current agent edit scope and folder policy. Note-only grants do not authorize folder schema reads or enumeration. Public shares omit metadata. Property-only Boards group by the owner's selected Select property on refresh; tags never determine placement. Board v4 displays up to 12 existing Card properties as stacked values-only rows (Select pills, plain Text/Date), not a special Type badge. Display choices add no archive guard. Retired tag configurations need explicit owner recovery in the web UI; reads never migrate settings. Tags remain stored with no frontmatter or tag synchronization. Disable or switch an enabled board before archiving its grouping property. Retained template defaults guard property/option archive even when the template is in Trash.

Board configuration, personal folder filters/sorting, folder duplication, owner template-default administration and destructive Delete option have no Harness/MCP/Pi operations. Do not emulate these web-only actions with tag/body edits. Schema `archive_option` is non-destructive. Existing comments, authorized Trash and ordinary tag operations remain independent.

## Reviewed template creation

1. `GET /v1/harness/folders/:folderId/templates` lists assigned ID/title summaries for an eligible creator.
2. `GET /v1/harness/folders/:folderId/templates/:templateId/preview` returns only that assigned Markdown body, tag defaults, destination property defaults/schema and opaque `snapshot`.
3. `POST /v1/harness/notes/from-template` creates the reviewed ordinary note atomically (256 KiB body limit):

```json
{
  "folderId": "destination_from_list",
  "templateId": "assigned_template_id",
  "snapshot": "snapshot_from_preview",
  "schemaId": null,
  "schemaRevision": 0,
  "title": "Reviewed instance",
  "tags": [],
  "values": {},
  "requestId": "one_unique_frozen_request_id",
  "variables": { "date": "reviewed date", "time": "reviewed time", "datetime": "reviewed datetime" }
}
```

Use actual preview schema identity/revision, including null/0 only when absent. Tags/values are **complete final** payloads; empty explicitly clears defaults. The empty example applies only when reviewed defaults are absent or deliberately cleared; otherwise retain the reviewed template tags/values. Stable destination IDs only; unknown/archived IDs, bad dates and empty/duplicate normalized tags are rejected. Tags: at most 50 entries, 80 raw characters each. Title: 1–1,000 characters. Request ID: 1–128. Each variable literal: at most 80. Only the original title/date/time/datetime substitutions are preserved; no replacement body, script or new variables.

Both stored connection and credential ceiling must allow destination create/read. Editor folder collaboration may create, viewer/commenter and note-only grants may not. Assigned preview grants no private-library enumeration or source editing; an effectively agent-private source folder is forbidden. A non-API-editable source may be copied. The destination owns the note; authenticated creator/actor provenance is retained. Defaults are owner-managed separately through the web UI.

Success is 201 (new) or 200 (replayed), with privacy-safe note ID/title/folder, contentHash and replayed flag. Retry uncertain/network/busy results with the SAME request ID and exact frozen payload, never a fresh clock. A changed payload using that actor/destination/key returns 409. Definitive stale snapshot/schema conflicts preserve the draft for explicit review before a new ID. A completed receipt does not require today's defaults, but current access is checked; unavailable/trashed/deleted notes never recreate. One create event/version and all body/tags/properties/reference/receipt writes commit together or roll back. Existing instances and blank creation remain unchanged. On refresh, boards use the owner's selected Select property, never tags. Do not automatically retry, refresh a preview, regenerate IDs/clocks or rewrite a frozen request.

The generated Postman Templates group captures preview tokens/defaults/frozen variables and a new request ID. Review/edit its final payload deliberately; do not re-run preview to retry an uncertain create, because that would replace its frozen request.

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
- Report the note ID, authorized folder ID if returned, and a concise changed-section summary. Never reconstruct a hidden containing folder.
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
curl -s --get "${AUTH[@]}" "$API/v1/harness/folders" \
  --data-urlencode 'limit=25' --data-urlencode "cursor=$NEXT_CURSOR"
```

Discovery page limits are 1–100 (default 25). Do not inspect or modify cursors, reuse them across endpoints/changed queries, or continue every page unless the task requires broader coverage. Cross-note line-search cursors cannot be used with single-note search. Request pages explicitly; never read bodies to compensate for incomplete folder discovery.

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
curl -s --get "${AUTH[@]}" "$API/v1/harness/notes/search" \
  --data-urlencode 'q=project' --data-urlencode 'limit=25' --data-urlencode "cursor=$NEXT_CURSOR"
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
# Optional legacy tags: use only explicitly requested labels, not inferred Status/Type mirrors.
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
- `GET /v1/harness/folders/:folderId/properties`
- `PATCH /v1/harness/folders/:folderId/properties`
- `GET /v1/harness/notes/:noteId/properties`
- `PATCH /v1/harness/notes/:noteId/properties`
- `GET /v1/harness/folders/:folderId/templates`
- `GET /v1/harness/folders/:folderId/templates/:templateId/preview`
- `POST /v1/harness/notes/from-template`
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
- `409`: stale body/anchor hash, metadata revisions, template review or request-intent conflict. Preserve the draft and distinguish a definitive uncommitted stale review from an unknown create outcome; never blindly replay/rebase.
- Transport, busy or server uncertainty after template creation: report it and retain the same request ID and exact frozen payload for an explicitly authorized retry. Never generate a new ID before resolution.
- Other server errors: report endpoint and response body without automatic retries.
