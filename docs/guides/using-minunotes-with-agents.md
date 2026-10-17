# Using MinuNotes with Agents

MinuNotes exposes a harness API and hosted MCP endpoint for agents to read, search, create, and edit notes without browser access.

## Choose an adapter

| Adapter | Auth and tools | Skill |
| --- | --- | --- |
| Installed Pi extension | API key; `minunotes_*` | `minunotes-harness` |
| Hosted MCP (`/mcp`) | OAuth; `notes_*` | `minunotes-harness` |
| Local stdio MCP (`notes-mcp`) | API key; `notes_*` | `minunotes-harness` |
| Direct Harness / OpenAPI | API key; `/v1/harness/*` | `minunotes-harness-api`, when API use is authorized |

Use registered tools first. Pi uses `minunotes_search_notes` / `minunotes_read_note`; MCP uses `notes_search` / `notes_get_note`. MCP intentionally omits outgoing-link/backlink/orphan tools available in Pi and Harness. A missing tool is not permission to switch credentials or transports.

## Recommended setup

1. In MinuNotes, create an API key for the agent.
2. Grant only the folder permissions the agent needs.
3. Enable folder creation only if the agent is explicitly allowed to create new folders. Agent-created folders are automatically scoped to that same API key.
4. Store credentials as environment variables or secrets, not in prompts:

```bash
export MINUNOTES_API_URL="https://api.notes.example.com"
export MINUNOTES_API_KEY="ntak_..."
```

5. Give the agent the portable skill:

```txt
docs/skills/minunotes-harness/SKILL.md
```

6. Prompt the agent to use the skill:

```txt
Use the MinuNotes Harness Skill for note reading, searching, creation, and editing.
Prefer registered MinuNotes tools; direct Harness API use requires authorization.
Do not use browser access.
```

## Agent-side flow

A small agent should treat MinuNotes as an optional skill triggered by note-related tasks.

Pseudo-code:

```ts
if (taskMatches("notes|minunotes|save this|search my notes|update note")) {
  loadSkill("minunotes-harness");
  // Prefer registered tools; require configured API secrets only for authorized direct API use.
}
```

Route operations through the registered adapter. Repository skill files are canonical; synchronize installed copies deliberately, preserving safe local preferences. The Pi adapter is user-level, not a repository-distributed package. Source support, installed files, tools registered in the current session and deployed API availability are distinct. Installation does not reload an existing session; reloads and live checks require separate authorization.

For MCP-capable hosted agents, use the hosted Streamable HTTP MCP endpoint instead:

```txt
https://<your-minunotes-host>/mcp
```

Hosted MCP uses OAuth bearer authentication for connected apps. Direct harness API access uses API keys with `/v1/harness/*`. Local MCP clients can still run the `notes-mcp` stdio binary with an owner-managed API key in the local process environment.

## Authorization model

API keys and OAuth connected apps share the same authorization model. Global capabilities are a maximum ceiling; folder rules can only restrict that ceiling. For `all` access, folders without a rule inherit the global capabilities. For `top_level` and `specific` access, a matching rule is required. Rules apply to either one exact folder or a subtree, and the nearest applicable rule wins.

In the API-key UI, restricted `top_level` and `specific` scopes are configured directly through folder rules. The permission row above the selected folders is a bulk control, and the persisted global ceiling is derived from the union of those rules. This keeps the ceiling invariant without requiring users to grant the same permission to every selected folder.

Effective access also applies OAuth scope when present and always enforces folder safety policy. Private and trashed folders are unavailable. Agent-read-only folders normally deny writes. The existing exception is `specific` access with an applicable `exact` folder rule, after other capability and policy checks; it never bypasses the global ceiling.

### Shared folders and notes

Agent access to authenticated collaboration is opt-in and separate from owned-folder scope:

- `none` — default; no shared content.
- `specific` — only user-selected active note/folder collaboration grants.
- `all` — current and future grants after the user accepts an explicit warning.

The connection cannot exceed the collaborator's Viewer, Commenter, or Editor role. Credential capability, OAuth scope, owner safety policy, and note API-editability remain additional ceilings. Downgrades and revocations take effect on the next request.

Full note reads return privacy-safe role/source context. Discovery stays compact, and direct-note grants intentionally use `folderId: null`; clients must not infer or probe for the containing folder. Notes, canvases, and folders created in a shared folder belong to that folder owner and are attributed to the authorizing user. Shared-resource moves, resharing, public links, restore, permanent deletion, and general Trash management remain owner-only. An edit-capable agent may move only resources created by its authorizing user to the owner’s Trash; direct-note grants, shared roots, mixed-creator subtrees, and owner-managed sharing configuration are denied. A `404` can mean inaccessible, revoked, or trashed and does not prove deletion.

Hosted OAuth supports these scopes:

- `notes.read`
- `notes.create`
- `notes.edit`
- `comments.write`
- `folders.create`

OAuth access is the intersection of the token scope, connected-app scope, current global capabilities, nearest folder rule, and folder safety policy. Clients should retry a token request that returns HTTP `503` with OAuth error `temporarily_unavailable`; they should not discard the grant as invalid for that response.

Recommended helper shape:

```ts
type MinuNotesConfig = {
  apiUrl: string;
  apiKey: string;
};

async function minunotesRequest<T>(
  config: MinuNotesConfig,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const apiUrl = config.apiUrl.replace(/\/$/, "");
  const res = await fetch(`${apiUrl}/v1/harness${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      ...init?.headers,
    },
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`MinuNotes ${res.status}: ${JSON.stringify(body)}`);
  }
  return body as T;
}
```

Example wrappers:

```ts
const MinuNotes = {
  folders: (config: MinuNotesConfig, page: { limit?: number; cursor?: string } = {}) => {
    const query = new URLSearchParams();
    if (page.limit !== undefined) query.set("limit", String(page.limit));
    if (page.cursor !== undefined) query.set("cursor", page.cursor);
    return minunotesRequest(config, `/folders?${query}`);
  },

  createFolder: (config: MinuNotesConfig, input: { title: string }) =>
    minunotesRequest(config, "/folders", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  createNote: (config: MinuNotesConfig, input: {
    folderId: string;
    title: string;
    content: string;
  }) =>
    minunotesRequest(config, "/notes", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  readNote: (config: MinuNotesConfig, noteId: string) =>
    minunotesRequest(config, `/notes/${encodeURIComponent(noteId)}`),

  editNote: (config: MinuNotesConfig, noteId: string, input: {
    baseHash: string;
    edits: Array<
      | { type: "append"; text: string }
      | { type: "replace_text"; oldText: string; newText: string }
      | { type: "replace_range"; from: number; to: number; text: string }
    >;
  }) =>
    minunotesRequest(config, `/notes/${encodeURIComponent(noteId)}/edit`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
};
```

## How an agent should use the skill

For any edit task, the agent should:

1. Use a supplied target ID, or discover relevant compact metadata.
2. Use backlinks/outgoing links only when needed and supported by the registered adapter.
3. Read the target note.
4. Save the returned `contentHash`.
5. Make the smallest practical edit.
6. Send `baseHash: contentHash` with the edit request.
7. Read the note again.
8. If a permission response indicates downgrade or revocation, stop and report it without retrying elsewhere.
9. Report the note ID, changed section, and final markdown or summary.

For shared notes, use risk-based collaboration rather than requiring approval for every mutation. An explicit narrow edit can proceed after a fresh read and should end with a concise changed-section summary. Feedback requests should use Review comments. Broad rewrites, substantial deletion, structural reorganization, and ambiguous changes should receive a proposed plan or diff and explicit approval first. On a `409`, re-read and rebase rather than overwriting; request approval if the rebased diff is materially different. Show a full diff when requested or when a broad change required approval.

For structured Status/Type labels, prefer defined folder properties and stable property/option IDs. Ask if definitions are missing; do not invent fields/options/tags or mirror properties into tags. Explicit tag requests and reviewed template tags remain supported and independent.

## Bounded discovery

Folder, note-search, tag and orphan discovery supports `limit` (1–100, default 25) and `cursor` where exposed by the adapter. If `pageInfo.hasMore` is true and another page is needed, explicitly pass `nextCursor` to the same tool with unchanged query/filters. Cross-note line search supports continuation; single-note search does not. Never aggregate every page or read unrelated bodies to find a folder. Search results are compact metadata, not note content. For a net-new note, resolve the authorized folder and create directly; no neighboring-note reads are needed.

## Properties and reviewed templates

Pi exposes `minunotes_read_folder_properties`, `minunotes_mutate_folder_properties`, `minunotes_read_note_properties`, `minunotes_patch_note_properties`, `minunotes_list_assigned_templates`, `minunotes_preview_assigned_template` and `minunotes_create_from_template`. Hosted/stdio MCP uses the same seven suffixes with `notes_`.

Read note properties first. Patch only intended active property IDs using `schema.schemaId` as `schemaId`, `schema.revision` as `schemaRevision`, and independent value `revision` as `expectedRevision`. Select values are stable option IDs; null and empty Text clear. Body `contentHash`/`baseHash` does not apply. Schema mutation is owner-only controlled add/rename/reorder/archive; IDs are server-generated, types immutable. Preserve drafts on conflicts and review explicitly before retrying. Direct-note grants authorize note metadata, never hidden containing-folder discovery.

For template creation, list destination assignments → preview the selected assignment → review its body/defaults/schema → submit the exact snapshot, destination/template IDs, final title, **complete final** tags/values, request ID and frozen literal date/time/datetime values. Empty tags/values clears defaults, so preserve reviewed defaults unless deliberately cleared. No replacement body. Destination read/create scope is required; previews never grant private-library access. An uncertain result may be retried only with the same request ID and exact frozen payload, never a new clock, ID or silently refreshed preview. A definitive stale review requires explicit re-review. No adapter performs automatic write retries.

## Web-only boundaries

Boards group only by an owner-selected Select field. Version 4 Card properties show up to 12 fields as stacked values-only rows (Select pills, plain Text/Date), with no special Type badge. Tags never determine placement. Retired tag settings need explicit owner recovery; reads never migrate them.

Board configuration, personal folder filtering/sorting, folder duplication, template-default administration and destructive Delete option remain web-only on agent surfaces. Schema archive is non-destructive. Do not emulate unsupported actions through body/tag writes; existing comments, ordinary tags and authorized MCP Trash remain independent. Pi provides no move/Trash tools.

## MCP and OpenAPI options

- Use **hosted MCP** (`/mcp`) for MCP-native hosted agents, cloud agents, ChatGPT-style OAuth connected apps, and team-managed runtimes.
- Use **local stdio MCP** (`notes-mcp`) for desktop clients that spawn local MCP processes.
- Use the **harness skill/API** for coding agents that can call HTTPS directly and do not need MCP transport.
- Use **OpenAPI** for REST/OpenAPI-native platforms such as custom actions or tools importers.

OpenAPI documents are available at:

```txt
GET /openapi.json
GET /v1/openapi.json
```

Direct harness API paths live under `/v1/harness/*` and use `X-API-Key` authentication. Hosted MCP uses `/mcp` with OAuth bearer authentication while sharing the same underlying permission model.

Useful graph and organization endpoints include:

- `GET /v1/harness/tags`
- `GET /v1/harness/notes/search?q=...&tag=...`
- `GET /v1/harness/notes/:noteId/tags`
- `PUT /v1/harness/notes/:noteId/tags`
- `GET /v1/harness/notes/:noteId/backlinks`
- `GET /v1/harness/notes/:noteId/links`
- `GET /v1/harness/notes/orphans`

## Trash boundary

Harness, OpenAPI, and MCP operations expose active content only. Trashed notes, templates, and folder subtrees disappear from folder lists, search, direct reads, metadata, graph results, and attachment access. A direct request for a trashed item returns not found.

Agents cannot list Trash, restore content, or permanently delete content. With explicit user approval, an edit-capable agent may move an eligible note or folder it created for the authorizing user to the owner’s Trash. Human role, credential edit capability, selected shared scope, API editability, and owner policy all remain required. Owners use the authenticated MinuNotes web interface for restoration and permanent deletion. A not-found response does not prove permanent deletion because the item may be outside the integration's scope or recoverable in Trash.

## Best practices

- Use one API key per agent/project.
- Use least-privilege folder permissions.
- Keep folder creation disabled unless the agent has explicit permission to create new folders.
- Revoke keys when a project ends.
- Do not paste API keys into chat prompts.
- Store credentials in env vars or a secret store.
- Ask agents to report exact note IDs and final changes.
- For destructive or broad edits, require confirmation before calling the edit endpoint.

## Testing a fresh agent

Use the smoke eval:

```txt
docs/evals/minunotes-harness-smoke.md
```

The eval is optional instructions, not permission to run live checks. It covers basic note editing plus bounded pagination, properties and reviewed templates. Every write needs an explicitly authorized disposable target; never choose an arbitrary accessible folder.
