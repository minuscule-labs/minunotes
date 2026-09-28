---
name: minunotes-harness
description: Tool-first MinuNotes skill for agents with registered minunotes_* tools. Use to read, search, create, edit, review, tag, inspect links, and work with canvas notes through MinuNotes tools.
---

# MinuNotes Harness Tool Skill

Use this skill when registered MinuNotes tools are available. Prefer tools over shell commands.

## Permission boundary

Global integration capabilities are a maximum ceiling. Folder rules may restrict them but cannot grant more access. For all-folder access, folders without a rule inherit the ceiling; restricted access modes require a matching rule. The nearest exact or subtree rule wins. Private and trashed folders remain unavailable, and agent-read-only folders deny writes.

Authenticated collaboration is a separate scope. Existing and new connections default to `sharedAccessMode: none`; the user must explicitly select active grants with `specific` or accept the current-and-future warning for `all`. Effective shared access is the intersection of the human Viewer/Commenter/Editor role, connection capabilities, selected shared mode, owner safety policy, and note API-editability. Revocation or downgrade applies immediately.

A full note read may include privacy-safe role/source context, but never read a note solely to inspect permissions. A direct-note grant has `folderId: null`; do not infer, search for, or reconstruct its containing folder. Content created in a shared folder belongs to that folder owner and is attributed to the authorizing user. Shared-resource moves, resharing, public links, restore, permanent deletion, and general Trash management remain owner-only. An edit-capable integration may move only eligible resources created by its authorizing user to the owner’s Trash. Report `403`/`404` permission boundaries rather than retrying against unrelated content or treating not found as proof of deletion.

## Tool usage patterns

- Find/create location: `minunotes_list_folders` → `minunotes_create_folder` if needed.
- Discovery first: `minunotes_search_notes` and `minunotes_orphans` return compact metadata only; use `minunotes_read_note`, `minunotes_read_lines`, or outline/section tools to expand a selected note.
- Safe note edit: search or `minunotes_read_note` → capture `contentHash` → `minunotes_edit_note` with `baseHash`.

## Net-new note fast path

When the task is to create a new note without using existing note content:

1. Resolve the requested folder using folder titles and `parentFolderId` relationships.
2. Create the note directly with `minunotes_create_note`.
3. Do not search or read existing notes merely to confirm the folder or inspect permissions.

If note search is independently necessary for folder discovery, use only its compact metadata. If folder pagination is unavailable or discovery remains incomplete, report that limitation or request clarification instead of reading unrelated notes.

## Retrieval workflow

Use the smallest tool result that supports the next decision:

1. **Discover candidates** with `minunotes_search_notes` or `minunotes_orphans`. Treat each result as metadata, not note content.
2. **Find relevant passages** with `minunotes_search_lines` when the query is about note body text or the notes may be large. Matches include the note id, location, matching text, and requested context.
3. **Expand selectively** with `minunotes_read_note` for the complete source, or `minunotes_read_outline` followed by `minunotes_read_section` for one heading. Use `minunotes_read_lines` for a bounded range.
4. **Edit only after reading** the current note and copying its `contentHash` into the edit request.

Discovery tools are cursor-paginated when their registered input exposes `cursor`. When a response has `pageInfo.hasMore: true`, pass `pageInfo.nextCursor` back to the same tool with the same query and filters. If that tool does not accept a cursor, report the discovery limitation rather than inspecting unrelated note bodies. Do not reuse a cursor with another tool or changed search, and do not fetch every page unless the task requires broader coverage.

Do not read every search result automatically. Rank candidates by title, folder, document type, and matched context, then expand only the notes needed to answer the task.
- Section edit: `minunotes_read_outline` → `minunotes_read_section` → targeted `replace_text` or `replace_range`.
- Canvas create/update: use `minunotes_create_canvas_from_syntax` for generated diagrams. It auto-detects Mermaid `flowchart`/`graph` headers; optional `format: "minu" | "mermaid"` forces a parser. Mermaid's supported flowchart subset compiles to editable native JSON Canvas (not SVG): standard directions, basic shapes, labeled directed/undirected/bidirectional/dotted edges, and nested subgraphs. Styling, actions, rich labels, and other diagram types fail with diagnostics; imports are limited to 100,000 source characters, 500 native nodes, 1,000 edges, and 16 subgraph levels. Use Minu syntax for mind maps or Minu-specific layout; use raw JSON Canvas for exact imports or when the user explicitly requires specific IDs, coordinates, links, or metadata.
- Canvas replacement: `minunotes_read_note` → use `minunotes_replace_canvas` or `minunotes_replace_canvas_from_syntax` with `baseHash`.

## Canvas generation default

- Use the syntax tool for net-new generated diagrams; it auto-detects Mermaid `flowchart`/`graph` headers and otherwise parses Minu syntax. Do not hand-place nodes with JSON coordinates when the compiler can lay them out.
- Use Mermaid for supported flowcharts. For Minu syntax, use the default flow layout with `direction right` or `direction down` for workflows and directed graphs. Use Minu `layout mindmap` only when the relationships form a true tree.
- Keep node labels short and plain text. Canvas nodes do not render Markdown, so do not add heading markers, emphasis markers, or Markdown-only formatting.
- Put the diagram title in the canvas note title or, for Minu syntax, the `diagram` title instead of creating a detached title node.
- Prefer explicit card shapes and meaningful connections while avoiding repetitive edge labels.
- Use JSON Canvas when importing an existing document or preserving exact IDs, positions, external URLs, internal note links, groups, styles, or host metadata.
- Syntax replacement is whole-document regeneration. Read the latest canvas and obtain approval before replacing a manually arranged or metadata-rich canvas.
- Canvas note link: `minunotes_read_note` → `minunotes_link_canvas_node_to_note` or `minunotes_unlink_canvas_node` with the latest `contentHash` as `baseHash`.
- Tags/links: use tag and backlink/link tools before changing organization or wikilinks.
- Review comments: read the note and current `contentHash` before creating or remapping an anchor. Anchors use zero-based Markdown offsets and an exact quote. Comment message bodies are plain text, not Markdown. List a thread before editing its messages; message edits/deletes are author-only, and reactions are actor-specific toggles.

## Shared-note editing protocol

Treat canonical edits and Review comments as different collaboration modes:

- If the user explicitly requests a narrow edit, read the current note, capture a fresh `contentHash`, make only the requested change, and summarize the changed sections afterward. No additional approval or pre-edit diff is required.
- If the user asks for feedback, review, or suggestions—or the connection can comment but not edit—use Review comments instead of changing canonical content.
- Before a broad rewrite, substantial deletion, structural reorganization, or change whose intent is ambiguous, present a concise plan or proposed diff and request approval.
- Do not resolve another collaborator's ambiguity by silently rewriting their work. Prefer an anchored comment or ask the user when preserving intent is uncertain.
- On a `409` conflict, do not overwrite or automatically replay the old patch. Read the latest note, rebase the proposed change, and request approval if the rebased diff is materially different.
- On `403` or `404`, stop after the first denial and report the collaboration boundary without probing other resources.
- Treat returned role/source as descriptive context, not a guarantee that mutation is allowed; credential scope and owner policy are still enforced by the edit request.
- After a routine edit, provide a concise summary rather than dumping a full diff. Show a full diff when requested or when the change was broad enough to require approval.

## Review workflow

1. Read the active Markdown note and capture `contentHash`.
2. Compute an exact range or whole-line anchor in the returned Markdown.
3. Create a thread with the quote, offsets, context, and current hash.
4. Use plain-text replies for discussion and resolve/reopen for lifecycle state.
5. If the note changes, list comments again and respect `detached: true`; never move an ambiguous anchor speculatively.

Review tools require explicit Comment permission plus read scope for every operation. Note edit permission and API editability are not required. Comments are unavailable on canvases, templates, Trash, and public shares.

## Available tools

- `minunotes_list_folders`
- `minunotes_create_folder`
- `minunotes_search_notes`
- `minunotes_search_lines`
- `minunotes_read_note`
- `minunotes_read_lines`
- `minunotes_read_outline`
- `minunotes_read_section`
- `minunotes_read_events`
- `minunotes_create_note`
- `minunotes_edit_note`
- `minunotes_read_tags`
- `minunotes_replace_tags`
- `minunotes_list_tags`
- `minunotes_backlinks`
- `minunotes_links`
- `minunotes_orphans`
- `minunotes_create_canvas`
- `minunotes_create_canvas_from_syntax`
- `minunotes_replace_canvas`
- `minunotes_replace_canvas_from_syntax`
- `minunotes_link_canvas_node_to_note`
- `minunotes_unlink_canvas_node`
- `minunotes_list_comments`
- `minunotes_create_comment`
- `minunotes_reply_to_comment`
- `minunotes_update_comment_anchor`
- `minunotes_set_comment_status`
- `minunotes_edit_comment_message`
- `minunotes_toggle_comment_reaction`
- `minunotes_delete_comment_message`
- `minunotes_delete_comment_thread`

`minunotes_search_lines` retains matching lines and requested context, but cross-note matches omit repeated hashes, byte sizes, and total line counts. A line match is retrieval context, not a replacement for the current note read when editing.

## Rich Markdown

- GitHub-style callouts use `> [!NOTE]`, `TIP`, `IMPORTANT`, `WARNING`, or `CAUTION`.
- Mermaid diagrams use ordinary fenced `mermaid` code blocks.
- Treat both as portable Markdown and preserve their markers and fences during edits.

## Trash boundary

- Folder lists, search, direct reads, line reads, tags, links, backlinks, and orphan results include active content only. Folder, tag, search, line-search, and orphan discovery lists are cursor-paginated; compact folder/note discovery records omit owner fields and full note content.
- A trashed note, template, or folder subtree is unavailable through harness tools and normally returns not found when addressed by ID.
- Harness tools cannot list Trash, restore, or permanently delete content. Focused note/folder Trash commands may move creator-owned content to the owner’s Trash when the authorizing human is an Editor, the credential has edit capability and shared scope, and owner policy permits it. Direct-note grants, shared roots, mixed-creator subtrees, and resources with owner-managed sharing configuration are denied.
- Moving content to Trash is destructive. Proceed only when the user explicitly requested that deletion or approved the exact destructive change; otherwise present the plan and obtain approval first.
- Do not interpret a not-found response as proof that content was permanently deleted; it may be outside the connection's scope or recoverable in the owner's Trash.

## Safety rules

- Read/search before editing.
- Capture `contentHash` before edits and pass it as `baseHash`.
- Use exact, small edits.
- Markdown patch edits only work for `documentType: "markdown"`.
- For generated `canvas.default` documents, use the syntax creation tool; it auto-detects supported Mermaid flowcharts and otherwise parses Minu diagram syntax. Use Mermaid for supported flowcharts and Minu syntax for mind maps. Use JSON Canvas only for exact imports or deterministic preservation of IDs, coordinates, links, and metadata.
- Syntax replacement regenerates the complete canvas and can replace node IDs, layout, links, and metadata. Obtain approval before using it on a manually arranged or metadata-rich canvas.
- Prefer focused canvas link/unlink tools over whole-document replacement when only an internal target changes.
- Internal canvas note links and external URLs are independent. Link/unlink operations must preserve `node.url` and unrelated node metadata.
- Preserve markdown structure, wikilinks, tags, and app-owned image URLs such as `/internal/attachments/.../content`.
- If permission is denied or shared access disappears, report it; do not retry unrelated actions, probe for hidden ancestry, or attempt to expand the connection's scope.
- After edits, report folder ID, note ID, and a concise summary of changes.

## Route note

The deployed harness route base is `/v1/harness`. Legacy `/api/harness` has been removed from production.

If tools are unavailable, use the separate `minunotes-harness-api` skill for direct curl/API usage.
