# MinuNotes Harness Agent Smoke Eval

Optional future instructions for a fresh agent; updating this document does not authorize running a live eval. Choose the tool-first or API-only skill to match the explicitly authorized adapter. No scenario requires browser access, real user data, broad discovery or automatic retries.

## Setup

Before running anything, obtain authorization for the exact deployment, adapter, disposable folder ID and permitted writes. Use synthetic fixtures only; never choose an arbitrary accessible folder or treat key capability as user approval. Folder creation, cleanup, schema mutation and template creation each require explicit scope. Do not inspect credentials, migrate data, reload clients or start/reuse services implicitly.

Required environment for the evaluated agent:

```bash
export MINUNOTES_API_URL="https://api-dev-notes.dpklabs.com"
export MINUNOTES_API_KEY="<api key>"
```

Give the agent the skill at:

```txt
docs/skills/minunotes-harness/SKILL.md      # Registered Pi/MCP tools
# or docs/skills/minunotes-harness-api/SKILL.md for authorized direct API use
```

Source support, installed files, current registration and deployment support must be reported separately. A missing tool is a limitation, not permission to probe another surface.

Do not provide browser access or prior conversation history.

## Agent prompt

```txt
You have access to MinuNotes through the MinuNotes Harness Skill.

Use only the harness API. Do not use browser access.

Task:
1. Read the MinuNotes Harness Skill.
2. List available folders.
3. Use only the explicitly authorized disposable folder ID supplied with this prompt; if none was supplied, stop and ask.
4. Do not create a folder unless the key was explicitly configured for folder creation and the prompt asks you to test it.
5. Create a note titled "Agent Harness Smoke Test".
6. The note content should be markdown and include:
   - an H1 heading matching the title
   - a short sentence explaining this is an agent harness smoke test
   - a checklist of at least 4 capabilities you verified or attempted
7. Read the note back and capture its note ID and content hash.
8. Edit exactly one checklist item from unchecked to checked using the harness edit endpoint with `baseHash`.
9. Read the note back again.
10. Report:
   - folder ID
   - note ID
   - whether the edit succeeded
   - final markdown
   - any API errors encountered

If you cannot complete a step due to permissions or API errors, stop and report the exact endpoint, status, and response body.
```

## Success criteria

The agent succeeds if it:

- Uses only the authorized adapter (direct API uses `X-API-Key`; hosted MCP uses its existing OAuth connection).
- Lists compact folders through the authorized tool or `/v1/harness/folders`, following only needed pages.
- Creates a note through `/v1/harness/notes`.
- Reads the note after creation.
- Uses `baseHash` on edit.
- Makes one targeted edit through `/v1/harness/notes/:noteId/edit`.
- Reads back the final note.
- Reports IDs and final markdown.

## Failure signals to watch

- Uses browser/UI instead of harness API.
- Omits `baseHash` when editing.
- Fabricates IDs or content without reading API responses.
- Edits too broadly or rewrites unrelated markdown.
- Ignores 401/403/409 errors or switches transport after a denial.
- Reads unrelated bodies to find a folder, expands every search result, or silently aggregates all pages.
- Writes outside the exact approved disposable target or generates a new ID/clock after an uncertain create.
- Cannot infer API base normalization (`MINUNOTES_API_URL` without trailing slash).

## Optional bounded parity scenarios

Run only individually authorized scenarios on synthetic fixtures. Report exact selected checks, not a broad suite pass. Do not simulate failures against real user data.

1. **Pagination (read-only):** choose an authorized fixture with more than one small page. Request `limit: 1` from folder/note/tag discovery (or Pi/Harness orphans), verify only one page was fetched, then explicitly request its opaque `nextCursor` with unchanged query/filters. Stop when sufficient metadata is found. Cross-note line search may continue; single-note search must not receive a cursor. If the deployed adapter lacks continuation, report it without fallback.
2. **Property read/patch:** with explicit permission for one disposable note, read its applicable schema/value revisions and patch one existing active property by stable ID. Select uses an option ID; a body hash must never substitute for metadata revisions. Preserve unrelated values/body/tags. Test a stale revision only on this fixture; verify conflict preservation and stop for explicit re-review. Do not invent definitions or mutate schemas unless separately authorized. A direct-note fixture must retain null folder context, with no ancestry probe.
3. **Reviewed template:** with authorization to create one disposable note, list destination assignments and preview one chosen assignment. Review snapshot/body/defaults/schema, then freeze the request ID, complete final tags/values and literal date/time values. Create only after confirmation. An explicitly authorized unchanged retry must replay the same note; never re-preview, alter inputs or regenerate the clock/ID after uncertainty. Stop and preserve intent if access changes. Do not create a real network failure to exercise this path; use mocked transport for fault injection.
4. **Boundary/reporting:** report the actual registered aliases and any unavailable deployed operation. Do not call Board configuration, folder duplication, template-default administration, destructive option deletion or unsupported MCP graph tools; they are outside these agent surfaces. No schema migration, service reload or permission change is part of this eval.

## Optional follow-up eval

Ask the same agent to:

```txt
Find the note titled "Agent Harness Smoke Test", read its outline, fetch its main section, append a "Results" section, and report the note events.
```

Expected endpoints:

- `GET /v1/harness/notes/search?q=Agent%20Harness%20Smoke%20Test`
- `GET /v1/harness/notes/:noteId/outline`
- `GET /v1/harness/notes/:noteId/sections/:sectionId`
- `POST /v1/harness/notes/:noteId/edit`
- `GET /v1/harness/notes/:noteId/events`
