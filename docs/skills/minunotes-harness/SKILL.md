---
name: minunotes-harness
description: Tool-first MinuNotes skill for registered Pi or MCP tools. Use for notes, properties, template management/reviewed creation, comments, tags and canvases.
---

# MinuNotes Harness Tool Skill

Use this skill when registered MinuNotes tools are available. Prefer tools over shell commands. Pi uses `minunotes_*`; hosted/stdio MCP uses `notes_*`. Use the aliases actually registered (MCP search/read are `notes_search` / `notes_get_note`). Missing tools do not authorize a shell/API fallback: use the API-only skill only with permission. Source support, installed files, current-session registration and deployed support are different; never reload or probe another surface automatically.

## Organization defaults

Prefer defined folder properties for structured labels such as Status and Type. When classification is requested, read the authorized schema and use its stable property/option IDs, not label strings. If no suitable definition exists, ask the user; do not invent fields, options or tags. Do not mirror Status/Type into tags unless requested. Honor explicit tag requests and reviewed template tags, and preserve stored tags even though board cards hide them. This is guidance, not a restriction on existing tag tools or permissions.

## Permission boundary

Global integration capabilities are a maximum ceiling. Folder rules may restrict them but cannot grant more access. For all-folder access, folders without a rule inherit the ceiling; restricted access modes require a matching rule. The nearest exact or subtree rule wins. Private and trashed folders remain unavailable. Agent-read-only folders normally deny writes; an existing exception permits a write for `specific` access with an applicable `exact` folder rule, only after all capability and policy checks pass. This does not bypass the capability ceiling or authorize changing permissions.

Authenticated collaboration is a separate scope. Existing and new connections default to `sharedAccessMode: none`; the user must explicitly select active grants with `specific` or accept the current-and-future warning for `all`. Effective shared access is the intersection of the human Viewer/Commenter/Editor role, connection capabilities, selected shared mode, owner safety policy, and note API-editability. Revocation or downgrade applies immediately.

A full note read may include privacy-safe role/source context, but never read a note solely to inspect permissions. A direct-note grant has `folderId: null`; do not infer, search for, or reconstruct its containing folder. Content created in a shared folder belongs to that folder owner and is attributed to the authorizing user. Shared-resource moves, resharing, public links, restore, permanent deletion, and general Trash management remain owner-only. An edit-capable integration may move only eligible resources created by its authorizing user to the owner’s Trash. Report `403`/`404` permission boundaries rather than retrying against unrelated content or treating not found as proof of deletion.

## Tool usage patterns

- Find/create location: `minunotes_list_folders` → `minunotes_create_folder` if needed.
- Discovery first: `minunotes_search_notes` and `minunotes_orphans` return compact metadata only; use `minunotes_read_note`, `minunotes_read_lines`, or outline/section tools to expand a selected note.
- Safe note edit: search or `minunotes_read_note` → capture `contentHash` → `minunotes_edit_note` with `baseHash`.
- Organize/move notes only when a registered move tool exists or direct Harness use is authorized; verify the target is inside granted scope. Updated Pi adapters expose `minunotes_move_notes`; MCP exposes `notes_move_notes`. These move up to 100 owned notes atomically, not folders. Property values are not automatically mapped to the destination schema.

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

Folder, note-search, tag and orphan discovery accepts optional `limit` (1–100, server default 25) and `cursor` where the registered tool exposes them. When `pageInfo.hasMore: true` and more metadata is needed, explicitly call the same tool with `pageInfo.nextCursor` and unchanged query/filters. Cross-note line search also accepts a cursor; single-note (`noteId`) line search does not. Never combine them. If a registered tool lacks continuation, report the limitation or ask for a precise folder URL/ID, not unrelated note bodies. Never edit/reuse a cursor across queries or aggregate every page automatically.

Do not read every search result automatically. Rank candidates by title, folder, document type, and matched context, then expand only the notes needed to answer the task.
- Section edit: `minunotes_read_outline` → `minunotes_read_section` → targeted `replace_text` or `replace_range`.
- Canvas create/update: use `minunotes_create_canvas_from_syntax` for generated diagrams. It auto-detects Mermaid `flowchart`/`graph` headers. Harness and MCP additionally expose optional `format: "auto" | "minu" | "mermaid"`; the Pi syntax tools currently expose auto-detection only, not that override. Mermaid's supported flowchart subset compiles to editable native JSON Canvas (not SVG): standard directions, basic shapes, labeled directed/undirected/bidirectional/dotted edges, and nested subgraphs. Styling, actions, rich labels, and other diagram types fail with diagnostics; imports are limited to 100,000 source characters, 500 native nodes, 1,000 edges, and 16 subgraph levels. Use Minu syntax for mind maps or Minu-specific layout; use raw JSON Canvas for exact imports or when the user explicitly requires specific IDs, coordinates, links, or metadata.
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
- Organization/links: prefer defined properties for structured labels; use tag tools for explicitly requested legacy tags and backlink/link tools for wikilinks.
- Review comments: read the note and current `contentHash` before creating or remapping an anchor. Anchors use zero-based Markdown offsets and an exact quote. Comment message bodies are plain text, not Markdown. List a thread before editing its messages; message edits/deletes are author-only, and reactions are actor-specific toggles.

## Owned template management

Updated Pi (`minunotes_`) and hosted/stdio MCP (`notes_`) expose these tool suffixes: `list_template_library`, `read_template`, `create_template`, `update_template`, `read_template_settings`, `set_template_assignment`, `set_template_tags`, `set_template_property_defaults`. Library discovery is compact, exact-folder and cursor-paginated (25 default/100 maximum); it is separate from destination-assigned templates.

- Creation needs owned source read/create; Markdown only, title 1–1,000 characters and body up to 200,000 characters within the 256-KiB request bound. It does not assign the template or set defaults. No creation receipt: resolve an unknown outcome through library discovery before explicitly creating again.
- Before editing/renaming, read the template; send exact original `expectedTitle`, `contentHash` as `baseHash`, and new `title` and/or `markdown`. Source read/edit and API-editability apply. IDs, assignments, defaults and existing instances stay intact. Preserve drafts and explicitly review conflicts; no automatic retries/rebasing.
- Read settings before changing assignments/tags/defaults. Assign one destination with `assigned` plus settings `membershipSnapshot` as `snapshot`; source and destination owner read/edit are required. Settings include only readable active assignments, never a complete replace-all list. Unassign removes that destination's defaults; unrelated/hidden/trashed assignments stay retained.
- Default tags use the settings tag `revision` as `expectedRevision`. Destination property defaults use that assignment's `id`/`revision` as `assignmentId`/`expectedRevision` plus the current destination folder schema's independent `schemaId`/`schemaRevision`. Submit **complete final** tags/values, preserving unrequested defaults; empty clears only when requested. Stable field/option IDs only, not labels, invented definitions or body hashes. Default tags are not tags on the template note itself.

Shared editor/note grants do not authorize owner administration. Current private/read-only/Trash policies and credential ceilings still apply; no grants, variables or schema inheritance are added. Assigned preview → reviewed ordinary-note creation remains a separate capability with its existing frozen snapshot/request-ID/date-time protocol. Installed/source support does not prove registration or deployment.

## Owned folder structure and reviewed copying

Updated Pi/MCP adapters expose `minunotes_rename_folder` / `notes_rename_folder`, `minunotes_move_folder` / `notes_move_folder`, `minunotes_preview_folder_duplication` / `notes_preview_folder_duplication`, and `minunotes_duplicate_folder` / `notes_duplicate_folder`. These are owner-only; shared editor grants do not authorize structural administration.

If a structure result has `parentContext: "unavailable"` and null `parentFolderId`, the parent is hidden—not necessarily Root. A move has no copy receipt: uncertain move outcomes need fresh location review and explicit approval, never replay of a stale move payload. Copy replay rechecks current source/imported-resource availability and limits as well as result access.

Rename uses exact `expectedTitle`; move uses explicit `parentFolderId` (null for Root), exact `expectedParentFolderId` and `confirm: true`. Get approval for the exact subtree/destination: destination-inherited sharing applies. Moves preserve IDs but require whole-subtree edit/read scope, applicable note/template API-editability and retained inherited protection. Cycles, excess depth and leaving scope are rejected; no automatic grant changes.

For copying, preview the exact source/destination first, review token/counts/imageBytes and get explicit approval before confirming with `confirm: true`, literal `title`, `parentFolderId`, `previewToken` and frozen `requestId`. New IDs must inherit existing read/create scope; restricted Root and exact-only destinations are unsupported rather than granted automatically. Source/imported templates/images require read scope, while destination requires read/create and folder-creation permission. Copies preserve native properties/options/boards/templates/defaults/images/links and protection flags, not sharing grants/tokens/history/comments/personal view state. Source API-editability need not permit editing to copy it; copied flags remain unchanged.

On an uncertain result retain the SAME requestId and exact payload; never retry automatically, replace the ID, refresh preview or change the clock. A definitive stale review needs explicit re-review. Execution and receipt replay recheck current authorization; unavailable committed copies are never recreated. MCP copy errors retain status and uncertainty explicitly. New source/tool support does not establish deployment or active session registration.

## Exact-folder notes and renaming

Updated adapters expose `minunotes_list_folder_notes` / `notes_list_folder_notes` with `folderId`, optional `limit` (1–100, default 25) and `cursor`. Results are compact ordinary-note metadata, including canvas formats but not templates or content. Follow only the returned `pageInfo.nextCursor`, unchanged, when another page is needed. A direct-note grant never authorizes folder enumeration.

Use `minunotes_rename_note` / `notes_rename_note` to change an existing ordinary Markdown note name. Supply `noteId`, new `title` (trimmed, nonempty, at most 1,000 characters) and exact `expectedTitle` from current metadata/read. Do not trim or rewrite the precondition. A body hash does not detect a title change and is not used for this operation. Content, properties, IDs and links remain unchanged; shared rename responses hide containing-folder context. Read/edit capabilities, current grants and API-editability are enforced transactionally. On conflicts or uncertain outcomes preserve intent and review; never automatically replay. Canvas renaming remains part of existing canvas replacement, not this Markdown-only tool. Source support is not proof of deployment or registration.

## Properties

Use the registered aliases:

| Operation | Pi | Hosted/stdio MCP |
| --- | --- | --- |
| Read folder schema | `minunotes_read_folder_properties` | `notes_read_folder_properties` |
| Mutate owned definitions | `minunotes_mutate_folder_properties` | `notes_mutate_folder_properties` |
| Read note values/schema | `minunotes_read_note_properties` | `notes_read_note_properties` |
| Patch note values | `minunotes_patch_note_properties` | `notes_patch_note_properties` |
| List destination assignments | `minunotes_list_assigned_templates` | `notes_list_assigned_templates` |
| Review assigned template | `minunotes_preview_assigned_template` | `notes_preview_assigned_template` |
| Create reviewed instance | `minunotes_create_from_template` | `notes_create_from_template` |

If unavailable, report the missing capability; do not substitute frontmatter/body edits or silently switch transports. Authorized direct API use is documented in `minunotes-harness-api`.

Read note properties before patching and pass its `schema.schemaId`, `schema.revision` as `schemaRevision`, and independent `revision` as `expectedRevision`. Patch only intended active property IDs; `null` clears, and empty Text clears. Select values are stable option IDs, not labels. Preserve drafts on `409`, reload and review before retrying; stop on `403`/`404`. The body `contentHash` is unrelated.

Folder schema mutations are owner-only controlled add/rename/reorder/archive operations with `expectedRevision`; IDs are generated by the server and types are immutable. Existing agent scopes, private/read-only-folder policy and note API-editability apply. A direct-note grant never permits reading or reconstructing the folder schema endpoint. Note properties reads project applicable fields/values without owner/folder identities.

Normal Markdown/canvas/mind-map notes support optional Text/Select/Date values. Boards group only by the owner's selected Select property. Card properties display up to 12 existing fields as stacked values-only rows (Select pills, plain Text/Date), not a special Type badge. Empty/unavailable values are hidden; displayed fields add no archive guard. Property writes can regroup cards on refresh. Tags never determine Board placement or synchronize with properties. Retired tag grouping/constraints require explicit owner recovery in the web UI; reads never migrate or widen settings. Disable or switch an enabled board before archiving its grouping field. Public note reads omit property metadata; shared Boards can show owner-selected Card properties. Retained template defaults guard referenced fields/options until explicitly cleared or unassigned.

Column visibility is presentation only and is configured by the owner in the web UI. A successful property edit can place a card in a hidden column without changing note access.

Board configuration, personal List/Board filters/sorting and destructive Delete option remain web-only on these agent surfaces. Archive is non-destructive, not Delete option. Do not emulate them with note/tag writes. Existing comments, authorized note moves, note/folder Trash and ordinary tag operations remain available. Updated Pi adapters expose `minunotes_move_notes`, `minunotes_trash_note` and `minunotes_trash_folder`; use them only when registered. Trash requires explicit user approval plus `confirm: true`, not automatic retries. MCP intentionally omits outgoing-link/backlink/orphan tools; use only registered tools, not assumed aliases.

## Reviewed template creation

Use the registered list → preview → create aliases above with the destination folder. These require destination create plus read capability, including credential scope ceilings; they never grant template-library access. Agents cannot use an effectively private source template folder. Source API-editability does not need to permit edits to copy an assigned template; destination creation does not edit the source. Direct-note grants do not enable discovery or creation. Owner management uses the separate scoped template tools.

Review the returned body/defaults/schema and submit destination/template IDs, `snapshot`, `schemaId`, `schemaRevision`, final title, **complete final** tags/values, `requestId` and frozen literal `variables: {date,time,datetime}`. Empty tags/values explicitly clear defaults; retain reviewed template tags unless the user deliberately clears them. Only the original four substitutions (including title) are supported; never send a replacement body. The atomic result is an ordinary destination-owned note with authenticated provenance and one create event.

On uncertain/network/busy results retry the **same request ID and exact frozen payload**. Do not switch inputs or expand the clock before resolution. Same key with different payload returns 409. Definitive stale-review conflicts preserve the draft for explicit review and then a new request ID. A completed retry ignores newer defaults but checks current access; an inaccessible, trashed or deleted note is unavailable and is never recreated. Defaults and snapshot tokens never grant permission. Board classification follows the owner's selected Select property on refresh, never tags. Transport adapters do not automatically retry, refresh previews, generate IDs/clocks or rewrite payloads; an explicitly authorized caller must retain the frozen intent.

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

## Available Pi tools

The updated installed adapter registers these 56 tools when loaded. This inventory is not proof that the current session or deployed API already supports them.

- `minunotes_list_folders`
- `minunotes_create_folder`
- `minunotes_rename_folder`
- `minunotes_move_folder`
- `minunotes_preview_folder_duplication`
- `minunotes_duplicate_folder`
- `minunotes_list_folder_notes`
- `minunotes_trash_folder`
- `minunotes_read_folder_properties`
- `minunotes_mutate_folder_properties`
- `minunotes_read_note_properties`
- `minunotes_patch_note_properties`
- `minunotes_list_template_library`
- `minunotes_read_template`
- `minunotes_create_template`
- `minunotes_update_template`
- `minunotes_read_template_settings`
- `minunotes_set_template_assignment`
- `minunotes_set_template_tags`
- `minunotes_set_template_property_defaults`
- `minunotes_list_assigned_templates`
- `minunotes_preview_assigned_template`
- `minunotes_create_from_template`
- `minunotes_search_notes`
- `minunotes_search_lines`
- `minunotes_read_note`
- `minunotes_read_lines`
- `minunotes_read_outline`
- `minunotes_read_section`
- `minunotes_read_events`
- `minunotes_create_note`
- `minunotes_edit_note`
- `minunotes_rename_note`
- `minunotes_move_notes`
- `minunotes_trash_note`
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
- Moving content to Trash is destructive. Proceed only when the user explicitly requested that deletion or approved the exact destructive change; otherwise present the plan and obtain approval first. Pi/MCP Trash tools require `confirm: true`. Do not automatically retry after errors or uncertain outcomes.
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
- After edits, report the note ID, authorized folder ID if returned, and a concise summary. Never reconstruct a hidden containing folder for reporting.

## Route note

The Harness route base is `/v1/harness`. Legacy `/api/harness` has been removed from production.

If tools are unavailable and direct API use is authorized, use the separate `minunotes-harness-api` skill. Otherwise report the missing capability.
