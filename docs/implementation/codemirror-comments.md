# General Discussion and Anchored Review

**Status:** Repository implementation for active Markdown notes; deployment and installed Pi adapter/skill updates are separate.

## Target contract and compatibility

- General create: `{body, target: 'note'}`, no anchor/hash/body-save dependency; responses have `target: 'note', anchor: null`.
- Review create: `{body, target: 'text', anchor}` or legacy `{body, anchor}`. Current hash and exact range/line rules remain.
- Missing/unknown/mixed targets are rejected. Anchor updates cannot convert note targets.
- Raw human/Harness GET without `includeNoteComments=true` remains anchored-only. Upgraded frontend and hosted/standalone MCP opt into both explicit targets. Do not dereference a nullable anchor without narrowing by target.
- General Discussion is below the note body; a header Discussion button scrolls there and focuses its composer. Review retains the existing drawer/adjacent dialog. Only Review enters MinuEditor mapping/highlights/focus.
- Migration 0045 extends existing `anchor_type` with `note`, makes anchor-only data nullable, and checks mutually exclusive target invariants. No new store or conversion of legacy threads. Whole-note rows never undergo reconciliation or detach due to content changes.

## Rollout and rollback

Inspect migration 0045 and verify populated threads, replies, reactions, IDs, timestamps, indexes and foreign keys using the real runner on a disposable database before any authorized deployment. Deploy schema/backend compatible reads before updated clients can create note targets. Production migration/deployment is not performed by implementation tests.

Once note-target rows exist, do not roll back to code that assumes every thread has an anchor. Disable new general creation if needed while retaining compatible reads and preserving discussion; never fabricate anchors or delete rows to make older code work. Installed/current-session Pi registration is explicitly deferred, not proof of this repository's capability.

Creates/replies/reaction toggles are not automatically retried after uncertain results. Author verification is not independent validation, human acceptance or release approval.

## Product boundary

Review comments are external discussion metadata. Markdown remains canonical and is never changed by comment operations.

```txt
Markdown             canonical note content
Comment threads      general or anchored discussion metadata
MinuEditor           selection, highlights, gutter actions, local anchor mapping
MinuNotes            persistence, actors, authorization, threads, and lifecycle
```

Current routes support the owner, authorized Editors/Commenters, and explicitly scoped API-key/OAuth agents. Public-share visitors cannot access comments. Canvas comments, suggestions, mentions, notifications, and realtime collaboration are deferred.

## Persistence

`note_comment_threads` stores:

- note and owner scope;
- open/resolved state;
- explicit whole-note, range or whole-line target;
- offsets, quote, context and document hash for text targets only (null for note targets);
- detached state for text targets only;
- creator and resolver actor identity; and
- lifecycle timestamps.

`note_comment_messages` stores ordered root messages and replies with actor identity and timestamps. Both tables cascade on permanent note deletion. Soft-deleted notes retain their comments, but active-note authorization hides them until restore.

Actor records retain internal ownership IDs for authorization. API responses use the existing collaboration identity serializer and omit raw user, owner, grant and credential identifiers; direct-note access never reveals folder ancestry.

## Authorization

- Owners, Editors and Commenters can discuss active Markdown notes under the existing collaboration policy; Viewers cannot list comments.
- Integrations need explicit `canComment` plus current note read access and authorized shared scope where applicable; direct-note grants do not imply folder access.
- Review-only integrations do not need note edit permission, and `isApiEditable` controls canonical note edits rather than comments.
- `canEdit` does not imply `canComment`, and `canComment` does not imply `canEdit`.
- Existing and newly created credentials default `canComment` to false until the owner grants **Comment** access.
- Message editing is author-only. Human owners can moderate deletion; human Editors can manage thread status, but do not gain blanket message ownership. Agents retain author-only mutation limits.
- Other thread authors can manage their own threads without changing note workflow properties.
- Templates, canvases, trashed notes, inaccessible folders, and public shares expose no comment surface.

## Anchors

An anchor contains exact source offsets, quoted Markdown, nearby context, a document hash, and optional detached state.

Creation and anchor updates require the current content hash. Stale hashes return `409 Conflict`; attached anchors must exactly match the current Markdown.

MinuEditor maps anchors through local edits. MinuNotes persists those mapped anchors after the corresponding note autosave succeeds. When a note changed elsewhere, reads reattach only when the quote has one unambiguous location, using context to disambiguate. Otherwise the thread is explicitly marked detached and never moved speculatively.

## Application UI

The note header exposes Review as a simple comment icon. The full thread list follows the same responsive Dialog pattern as Backlinks: a right-side drawer on desktop and a bottom drawer on narrow screens.

Editor-originated interactions stay close to their source:

- selecting text or using the line comment icon opens a compact dialog beside that anchor;
- clicking an existing highlight or gutter icon opens the same adjacent thread dialog;
- selecting a thread inside the Review drawer keeps discussion in the drawer and focuses its source text;
- narrow screens place the compact dialog at the bottom of the viewport; and
- detached threads remain available without highlighting unrelated text.

Users can reply, edit each of their own messages through a message-level More menu, resolve or reopen threads, and delete messages or complete threads. Edited messages are labeled. Quick reactions (`👍`, `❤️`, `😂`, `🎉`, `👀`, `🚀`) plus a lazy-loaded searchable Unicode emoji picker group per-message totals and let each owner or authorized integration toggle its own reaction. Standard joined emoji and skin-tone variants are supported; custom uploaded emoji are deferred.

The first submitted comment transitions the existing anchored composer directly into its returned thread by updating the TanStack Query cache. The dialog instance and geometry remain stable; there is no visible refetch or loading flash. Replies, edits, lifecycle actions, deletes, and reactions likewise update targeted cached thread/message state, with reaction rollback on persistence failure.

App-owned Review surfaces use MinuNotes theme tokens. MinuEditor comment accent/background variables and gutter buttons are mapped to neutral theme colors rather than the package's default amber treatment.

MinuEditor receives controlled root comment items with `showPanel: false`; MinuNotes owns the drawer, adjacent dialog, and threaded discussion UI. The host derives dialog coordinates from the existing CodeMirror `EditorView.coordsAtPos()` API, so no MinuEditor package patch is required.

## API surfaces

Owner routes live under:

```txt
/internal/notes/:noteId/comments
```

Scoped integration routes mirror the lifecycle under:

```txt
/v1/harness/notes/:noteId/comments
```

Harness OpenAPI, generated Postman requests, hosted/standalone MCP adapters, and MCP Review tools use the same shared comment domain operations.

## Verification

Coverage includes:

- full thread/message lifecycle;
- owner and API-key attribution;
- cross-user, folder-scope, read-only, editability, Trash, Markdown-only, and authorship boundaries;
- stale and invalid anchors;
- unique reattachment and detached presentation;
- permanent-deletion cascade;
- OpenAPI and MCP adapters; and
- browser creation, replies, status changes, local anchor mapping, and narrow-screen Review UI.
