# @minunotes/mcp

MCP server for MinuNotes harness workflows. Local stdio MCP uses the MinuNotes harness API with API-key auth. Hosted MinuNotes MCP uses OAuth bearer auth at `/mcp`.

## Local stdio MCP

Use the local binary for desktop/local MCP clients that spawn a process:

```sh
export NOTES_API_URL="https://api.notes.example.com"
export NOTES_API_KEY="ntak_..."
notes-mcp
```

Example MCP client config:

```json
{
  "mcpServers": {
    "notes": {
      "command": "notes-mcp",
      "env": {
        "NOTES_API_URL": "https://api.notes.example.com",
        "NOTES_API_KEY": "ntak_..."
      }
    }
  }
}
```

## Hosted MCP

MinuNotes also exposes a hosted Streamable HTTP MCP endpoint at:

```txt
POST /mcp
GET /mcp
DELETE /mcp
```

Hosted MCP uses OAuth bearer authentication. Tool calls run through the authorized connected app's scoped permissions.

```http
Authorization: Bearer mnoac_...
Accept: application/json, text/event-stream
Content-Type: application/json
```

Direct harness API access remains API-key based through `/v1/harness/*`. Local stdio MCP uses `NOTES_API_KEY` and calls the harness API from the local process.

Use hosted MCP for cloud agents, ChatGPT-style integrations, Lambda/container agents, or team-managed agent runtimes. Use local stdio MCP when a desktop client expects to launch a local MCP process.

## Tools

Folders and notes:

- `notes_list_folders`
- `notes_create_folder` (supports optional `parentFolderId` for subfolders)
- `notes_trash_folder` (destructive; requires `confirm: true`)
- `notes_search`
- `notes_get_note`
- `notes_create_note`
- `notes_edit_note`
- `notes_trash_note` (destructive; requires `confirm: true`)
- `notes_move_notes` (all-or-nothing, up to 100 notes)

Review comments:

- `notes_list_comments`
- `notes_create_comment`
- `notes_reply_to_comment`
- `notes_update_comment_anchor`
- `notes_set_comment_status`
- `notes_edit_comment_message`
- `notes_toggle_comment_reaction`
- `notes_delete_comment_message`
- `notes_delete_comment_thread`

Structured reads:

- `notes_search_lines`
- `notes_read_lines`
- `notes_search_note_lines`
- `notes_read_outline`
- `notes_read_section`
- `notes_read_events`

Canvas lifecycle and links:

- `notes_create_canvas`
- `notes_create_canvas_from_syntax` (Minu syntax or auto-detected Mermaid; optional `format` override)
- `notes_replace_canvas`
- `notes_replace_canvas_from_syntax` (Minu syntax or auto-detected Mermaid; optional `format` override)
- `notes_set_canvas_node_note_link`
- `notes_remove_canvas_node_note_link`

Tags:

- `notes_list_tags`
- `notes_read_note_tags`
- `notes_replace_note_tags`

## Canvas JSON, Minu syntax, and Mermaid flowcharts

Use JSON Canvas when exact node IDs, positions, external URLs, internal note links, or host metadata must be retained:

```json
{
  "nodes": [
    { "id": "node_a", "type": "text", "text": "Research", "x": 0, "y": 0, "width": 240, "height": 120 }
  ],
  "edges": []
}
```

Use Minu diagram syntax for mind maps or Minu-specific layouts. The syntax tools also auto-detect Mermaid `flowchart`/`graph` headers and compile the supported flowchart subset into editable native JSON Canvas (not SVG): standard directions, basic node shapes, labeled directed/undirected/bidirectional/dotted edges, and nested subgraphs. Styling, actions, rich labels, and other diagram types are rejected with diagnostics. Imports are limited to 100,000 source characters, 500 native nodes, 1,000 edges, and 16 subgraph levels. Set `format: "minu"` or `format: "mermaid"` to force a parser; unsupported Mermaid features return diagnostics without a partial canvas.

Example Minu mind map:

```txt
diagram "Product plan" {
  layout mindmap
  Product [label: "Product plan", shape: card]
  Product > Research
  Product > Build
}
```

Example Mermaid flowchart:

```txt
flowchart LR
  draft[Draft] --> review{Approved?}
  review -->|yes| shipped([Shipped])
```

Declare styled nodes as `id [label: "Label", shape: card]`. Connect nodes with `A > B` or `A --> B`. The forms `node A ...` and `A -> B` are unsupported and return line-specific diagnostics instead of producing literal nodes.

Syntax creation and replacement compile the source into JSON Canvas. Syntax replacement is whole-document generation and can regenerate node IDs, positions, links, and metadata. Use JSON Canvas for deterministic replacement, and use the focused node-link tools after syntax generation when nodes need internal MinuNotes links.

Canvas replacement and node-link mutations require a current `baseHash`. Setting a node note link creates or changes the target while preserving `node.url` and unrelated metadata. Removing the internal link also preserves the external URL.

## Tool boundaries

MCP tools expose owned content plus authenticated collaboration explicitly enabled by the connection owner. Shared access defaults to `none`; `specific` selects active grants and `all` includes current and future grants after an explicit warning. Effective permissions also intersect the collaborator's current role, credential capabilities, OAuth scope, owner safety policy, and note API-editability.

Full note reads return privacy-safe role/source context. Discovery remains compact, and direct-note grants use null folder context. Content created in a shared folder belongs to that folder owner and is attributed to the authorizing user. Shared moves, resharing, public-link administration, restore, permanent deletion, and general Trash management remain owner-only. Edit-capable integrations may move only eligible creator-owned content to the owner’s Trash. Downgrade and revocation apply immediately; not found may mean inaccessible or revoked and must not be used to infer existence.

For net-new content, resolve the target folder from folder metadata and create directly. Do not search or read unrelated notes to verify the folder or inspect permissions.

MCP tools expose active content only. Trashed notes, templates, and folder subtrees are omitted from lists and search and return not found on direct reads. Hosted and local MCP provide destructive, explicitly confirmed tools to move eligible notes and folders to the owner’s Trash. They do not list Trash, restore, or permanently delete content. Owners perform those lifecycle operations through the authenticated MinuNotes web interface.

Review comments are available only on active Markdown notes, and message bodies are plain text rather than rendered Markdown. Every comment operation requires explicit **Comment** permission plus folder read access; note edit permission and API editability are not required. Existing and new credentials have Comment disabled until explicitly granted. Message edits/deletes are author-only, reactions are actor-specific toggles accepting one standard Unicode emoji, and anchor creation or remapping requires the current note content hash.

Tags are available because they already have user-facing Note Details behavior. Broader graph inspection—including outgoing links, backlinks, and orphan discovery—is intentionally not exposed through MCP yet; those product and UI semantics are deferred.

Implementation notes:

- Uses the official `@modelcontextprotocol/sdk`.
- Honors owned-folder modes plus separate `none | specific | all` authenticated-collaboration scope. Private folders are not accessible to MCP.
- Move operations require edit access to every source folder and create access to the target folder.
- Uses stdio transport for local process-spawned MCP clients.
- Uses Streamable HTTP transport for hosted `/mcp` clients.
- Returns both `structuredContent` and text content.
- Adds MCP tool annotations for read-only/destructive/idempotent hints.
- Includes a starter `summarize_note` prompt.
