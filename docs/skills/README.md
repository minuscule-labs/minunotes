# Skills

Portable agent skills for using MinuNotes from other projects or clean agent sessions.

## Available skills

- [MinuNotes Harness Tool Skill](./minunotes-harness/SKILL.md) — lightweight, tool-first guidance for agents with registered `minunotes_*` tools.
- [MinuNotes Harness API Skill](./minunotes-harness-api/SKILL.md) — curl/API-only guidance when tool access is unavailable and direct API use is authorized.
- [MinuNotes Skills Lookup](./minunotes-skills/SKILL.md) — tool-first discovery of one to three relevant `skill`-tagged notes, with an authorized API fallback.

## Canonical sources and installation

These repository files are the canonical portable instructions. Copy the selected skill directories deliberately into your agent's skill directory; preserve safe local presentation preferences when synchronizing. They are not automatically packaged with the Pi adapter.

Pi's local adapter uses `minunotes_*`; hosted/stdio MCP uses `notes_*` (for example, `minunotes_search_notes` maps to `notes_search`, and `minunotes_read_note` to `notes_get_note`). Check the tools actually registered in the current session rather than assuming every alias exists. MCP deliberately omits outgoing-link/backlink/orphan tools, although Harness and Pi support them.

Source support, installed files, current-session registration and deployed API availability are distinct. Installation does not reload an existing session. Reload/new-session actions and live checks require separate authorization; a missing tool is not permission to try another credential or transport. The API-only skill uses `/v1/harness`, never the removed `/api/harness` route.

## Related

- [Using MinuNotes with Agents](../guides/using-minunotes-with-agents.md)
- [MinuNotes Harness Agent Smoke Eval](../evals/minunotes-harness-smoke.md)
