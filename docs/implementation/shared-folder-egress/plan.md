# Public shared-folder egress reduction

Status: Phase 1 approved by the user and implemented locally; verification complete. Production deployment requires separate approval.
Date: 2026-10-26.
Investigation baseline: local HEAD `754fc42`; GitHub main observed at `2057735e`. Existing unrelated note-discussion changes must remain untouched. Reconfirm the implementation base before starting.

## Objective

Stop transferring unrelated note bodies from Turso when reading a public shared folder. Preserve current sharing behavior and measure the reduction without promising to fix all 500s.

### Evidence and limits

- `src/api/routes/share.ts` currently selects all active notes for the share owner, including `content`, then filters to the shared subtree in JavaScript.
- `loadActiveFolderShare` loads the owner's active folder metadata; folder-share handlers load it again in the same request.
- Public Board support (PR #20, merged October 18) reuses the full shared-folder snapshot. Manual Board refresh and missing-note recovery can refetch it.
- This broad note query predates October. New Board usage is a plausible amplifier, not a proven cause of the traffic spike.
- Turso query statistics include this query. Dashboard screenshots show rising outbound traffic and tail latency around October 19–22 and again October 26.
- CloudWatch separately shows 10-second database connection failures and Lambda timeouts. SQL optimization is not proof of a connectivity fix.
- GitHub has no deployment records for this window. Merge dates are not deployment dates; the latest observed release tag is v1.7.1 from October 16.

## Decision: ship the compatible fix first

Phase 1 changes backend query scope and eliminates duplicate folder reads. Keep the existing response contract, URL behavior, note opening, public Boards, and canvas/wikilink behavior.

Do not bundle lazy-loading, global observability, or a database upgrade into this fix.

## Phase 1 requirements

### 1. Restrict content retrieval at the database boundary

For `GET /internal/share/folders/:token`:

1. Validate the token and existing expiry/revocation rules.
2. Load and validate the owner's active folder hierarchy once.
3. Determine the shared root and its reachable active descendants using current semantics.
4. Add subtree membership to the SQL predicate before note rows are returned from Turso.
5. Preserve explicit owner scope, active-note/ancestor checks, `type = note`, selected fields, and title ordering.
6. Preserve canvas target sanitization using the authorized visible-note set.

Never substitute a broad owner query followed by a JavaScript filter, even as an error fallback. An invalid or empty scope fails closed.

Preferred implementation: retain the existing subtree calculation and use a parameterized folder-ID predicate. Check the deployed libSQL bind limit before choosing the bound. If scopes can exceed it, use bounded chunks with the same predicates and a final database-equivalent ordering, or a parameterized membership subquery; select the simplest supported option during implementation. No silent truncation or unbounded placeholder list. Add a boundary test for the chosen approach.

The performance contract is about **rows/content returned from the database**, not a guarantee that SQLite scans zero unrelated index entries.

### 2. Reuse authorization metadata within one request

Extend the existing folder-share resolver's internal result to carry the validated active folder metadata and subtree IDs. Reuse this result in folder snapshot, public Board config/lane, folder attachment, and folder wikilink handlers instead of calling `loadUserFolders` again.

- Keep this local to the public folder-share routes; no new global access framework.
- No cross-request cache, TTL, or shared mutable permission state.
- Invalid, expired, revoked, trashed, orphaned, cyclic, or wrong-owner resources retain existing denial behavior.
- Do not change the meaning of private folders, direct-note shares, or collaboration roles.
- Permission checks inside existing Board readers remain intact. This does not promise one total database query per request.

### 3. Targeted, privacy-safe measurement

Add a small explicit measurement helper around the shared-folder snapshot read, not a global database proxy.

One structured completion event per snapshot request, containing:

- Fixed operation name, generated correlation ID also returned as `X-Request-Id`, status/outcome.
- Total handler duration and note-fetch duration in milliseconds.
- Number of folder-query calls made by this path and number of note-fetch batches.
- Returned note count and UTF-8 note-content bytes returned from the database.
- On failures: bounded, allowlisted cause codes such as `UND_ERR_CONNECT_TIMEOUT`; no raw exception dump from this helper.

Label bytes as `note_content_bytes`, **not Turso network bytes**. They exclude protocol overhead, other columns, and other requests. Do not stringify/copy all note bodies just to measure them. Denied requests must not fetch note content.

Never log tokens, raw paths containing share tokens, query strings, SQL parameters, note content/titles, email addresses, or owner IDs. Use a fixed route label. Add redaction tests, including nested database errors with SQL/parameters in their messages.

The existing global API error logger prints raw paths and error messages. For public-share errors, replace its output with the same sanitized fixed route classification and bounded error codes; preserve a generic 500 response and correlate it with the request ID. This scoped adjustment is required so the new instrumentation does not leave token-bearing failures in logs. Avoid logging the same failure twice.

No new logging vendor, dependency, metric dimension per user/note/token, request-body logging, or infrastructure deployment in Phase 1.

## Compatibility and security acceptance criteria

- Same snapshot response fields and visible note/folder set as before, including descendants.
- No unrelated owner's or same-owner out-of-subtree note body crosses the database client result boundary for the snapshot query.
- Trashed notes/ancestors, templates, expired/revoked tokens, and invalid hierarchy are handled consistently with current policy.
- Canvas links to invisible targets remain sanitized; visible links, Markdown wikilinks, attachments, deep links, and public Board visibility still work.
- Each folder-share handler calls the shared hierarchy loader at most once through the public-share resolver.
- No client/API-key/MCP contract changes and no migration.
- No automatic retries of failed mutations; no timeout increases or weakened authorization checks.

## Proposed file and verification map

| File | Proposed change | Verification |
| --- | --- | --- |
| `src/api/routes/share.ts` | SQL subtree scope, request-local resolver reuse, snapshot measurements | Real libSQL route tests; database result-boundary assertions; existing share regressions |
| `src/api/lib/share-observability.ts` (new) | Small structured event/ID and safe error-code helpers | New helper tests for timing fields, byte accounting, bounded causes and secret exclusion |
| `src/api/index.ts` | Sanitize public-share errors and correlate them without changing other error contracts | Production-app wiring/error tests, not only a standalone Hono sub-app |
| `tests/folder-share-links.test.ts` | Subtree membership and authorization compatibility; extend fixture result to expose client if needed | Root/child/sibling/other-owner/deleted/template/canvas cases; query-boundary capture |
| `tests/public-board-sharing.test.ts` | Resolver reuse and unchanged public Board reads | Config/lane, hidden columns, expired/revoked token cases |
| `tests/share-observability.test.ts` (new) | Metrics and application error-path integration | Successful, denied, database-failure and nested-error redaction cases |
| `tests/shared-folder-egress.test.ts` (new) | Deterministic egress regression fixture | Verify unrelated large bodies are not returned by SQL; scope-size boundary; no duplicate hierarchy fetch |
| `docs/implementation/shared-folder-egress/plan.md` | Record scoped evidence and outcome | Manual evidence review; no production contents |

Reuse existing test setup where practical. No shared test-framework refactor. Existing browser tests should require no changes unless they expose a genuine compatibility gap.

### Deterministic regression fixture

Use a disposable local libSQL database, never production:

- A shared subtree with a few small Markdown/canvas notes.
- Many large notes under a sibling folder owned by the same user.
- Another owner's notes, templates, and notes beneath a trashed ancestor.
- Capture the actual note-select SQL and results while executing against real libSQL; an HTTP-response-only assertion is insufficient because the old implementation already filters the response.
- Assert that adding large unrelated notes does not increase returned note-content bytes or returned note count for the snapshot query.
- Test large subtree scope handling, stable ordering, and empty results.
- Report deterministic byte/row reduction. Avoid timing thresholds on CI machines.

### Verification cadence

1. During implementation: the new tests and `tests/folder-share-links.test.ts`, `tests/public-board-sharing.test.ts`.
2. Before integration: `pnpm exec biome check --write <changed-ts-files>`, `pnpm typecheck`, and `git diff --check`.
3. Affected authorization regression: folder/note share links, shared wikilinks, trash folders/notes/policy, public Board sharing and security headers.
4. Browser boundary: `tests/browser/folder-sharing.spec.ts`, `tests/browser/public-board-sharing.spec.ts`, `tests/browser/shared-wikilinks.spec.ts`, `tests/browser/board-visibility.spec.ts`.
5. Run the normal regression suite and build once at merge-ready integration; heavy benchmark/demo opt-ins stay opt-in. Record failures and limitations, not assumed passes.
6. Production deployment is a separate approval and follows the release skill/gates.

## Rollout and success measurement

Before release, record candidate SHA, fixture results, and a comparable production baseline from existing Turso/CloudWatch statistics. Do not load-test production or deliberately repeat the expensive query to manufacture a baseline.

After approved deployment:

- Perform a small approved smoke check of list, note opening, Board, canvas and revoked-link behavior.
- Confirm snapshot events contain no sensitive data and returned bytes reflect only the shared subtree.
- Compare a full comparable usage window: outbound traffic relative to share request volume, note-content bytes per snapshot, p95/p99 latency and errors/timeouts. Existing logs may not provide a route-volume baseline; label that limitation explicitly.
- Deterministic success is removal of unrelated database-returned content and duplicate hierarchy loads, with compatible behavior. Production traffic reduction depends on how much of the workload uses this endpoint.
- If connectivity errors persist, investigate them separately; do not declare this fix unsuccessful solely because an independent network failure remains.
- Roll back to the prior application build for authorization or compatibility regressions. No schema rollback is needed.

## Phase 1 implementation evidence

- Phase 1 target: the changes recorded with this plan on `fix/shared-folder-egress`, based on refreshed `origin/main` at `2057735e8d1c9a22c054e20a272653662a5b4d9d`. All eight Phase 1 files were transferred byte-for-byte before this evidence update. The original discussion branch remains at `754fc4224698c7ef2a79d9ebabdcbc57fdcda936`; its eight working edits were hash-verified in the discussion-only stash `f6af975bd183ac4df6daff073a1af7a9c6838f8b`. A separate Phase 1 recovery stash is `185bd8b43982d14f9111d831761a3cc846291f09`. Branch isolation did not commit, push or deploy. The user subsequently approved a local Phase 1 commit; publishing and deployment still require separate approval.
- SQL choice: preserve the existing validated subtree calculation and use `folder_id in (select value from json_each(?))`. JSON membership avoids a per-folder bind limit entirely: five total bind parameters regardless of folder count. Existing property/Board queries already require `json_each`; no production bind-limit probe was needed. No owner-wide fallback or truncation was added.
- Resolver metadata and subtree IDs are request-local and reused for snapshots, attachments, wikilinks and both Board reads. Board readers retain their own permission checks.
- Snapshot events use the fixed operation `public_share.folder_snapshot`, a generated `X-Request-Id`, status/outcome, timings, hierarchy-query calls, note-fetch batches, returned rows and UTF-8 `note_content_bytes`. `folder_query_calls` counts hierarchy-loader calls, not the token lookup's folder join. A successful fixture snapshot makes three total SQL calls: token lookup, hierarchy and notes.
- The completion middleware is mounted before production rate limiting and locally on the snapshot route, with duplicate-event protection. Public-share failures use only fixed operation labels and bounded exact cause codes; the global logger no longer prints their raw path, message or stack.
- Deterministic local libSQL fixture: the previous owner-wide query returns **43 notes / 2,621,474 content bytes**; the scoped query returns **3 notes / 34 content bytes**, excluding **2,621,440 bytes (2.5 MiB)** of unrelated sibling bodies. Adding those bodies leaves snapshot database results unchanged. Hierarchy loads fall from two to one.
- The large-scope fixture covers 1,102 authorized folders with one note query and five binds, preserving SQLite title ordering. Negative fixtures cover empty results, templates, deleted notes/ancestors, other owners, expiry/revocation, orphaned/cyclic/wrong-owner hierarchies, and denied requests without note reads. Production-app tests cover all three database failure stages, nested-error redaction, rate limiting, correlation, UTF-8 bytes and measurement before canvas-link sanitization.

### Observed checks

- Integration verification target: the isolated Phase 1 patch on `fix/shared-folder-egress`, base `2057735e`. No application/test edits were needed after branch transfer or review.
- Delegated contextual review: **APPROVE**, no actionable findings. The reviewer independently ran the 32 focused share/measurement tests and 38 sharing/trash/security regressions, plus `pnpm typecheck`, changed-file Biome and `git diff --check`; all passed. Its broader-integration evidence limitation is addressed by the subsequent author-run checks below, not by claiming the reviewer ran them.
- Final isolated-branch normal regression coverage: `pnpm exec vitest run --maxWorkers=2` — **91 files passed, 1 skipped; 761 tests passed, 2 skipped**. Benchmark/demo opt-ins remain opt-in.
- Final isolated-branch browser boundary: `pnpm exec playwright test tests/browser/folder-sharing.spec.ts tests/browser/public-board-sharing.spec.ts tests/browser/shared-wikilinks.spec.ts tests/browser/board-visibility.spec.ts` — **49 passed**. These browser tests use mocked API fixtures; real database-boundary behavior is covered by the libSQL tests.
- Final isolated-branch `pnpm build` passed with a large-chunk warning. The preceding isolated-branch typecheck and changed-file Biome results remain applicable because only this evidence document changed afterward. `git diff --check` passed.
- Historical original-base evidence: the earlier `754fc42` discussion-based target had 770 regression tests passing, 2 skipped, and the same 49 browser tests passing. That larger test count included separate discussion work and is not the current branch's suite count. Its first full run alongside browser/build checks hit six 5-second test timeouts; those did not recur with two workers. A canvas measurement test's invalid fixture note ID was corrected before the final passes. No timeout, authorization or CI gate was weakened.
- Limitations: no production baseline collection, smoke checks, traffic/latency comparison, deployment or connectivity validation was performed. Candidate SHA, comparable production baseline and rollout remain release-time work under separate approval.

## Phase 2 — separate decision after Phase 1 evidence

If snapshots remain large because the shared subtree itself contains many/large notes, propose an additive compact-navigation API and a separately authorized single-note body endpoint. Keep the legacy snapshot until consumers migrate.

The frontend would load metadata for browsing and fetch content only on note selection; Board refresh would not refetch all bodies. Every detail read must revalidate the share and current subtree membership. Canvas target checks, attachment/wikilink access, missing-note recovery, cache invalidation and Back/Forward behavior must be explicitly redesigned and tested. Pagination may also be needed for very large shared subtrees.

Expected follow-up files: `src/api/routes/share.ts`, `src/frontend/lib/api.ts`, `src/frontend/routes/share.folders.$token.tsx`, `src/frontend/components/notes-board.tsx`, and corresponding API/browser tests. This is not approved for implementation by approval of Phase 1.

## Separate reliability follow-up

A broader observability spec can cover harness/MCP operation outcomes (including tool errors in HTTP 200 responses), auth/query timing, Lambda/API Gateway correlation, sanitized application-wide error handling, dashboards, alert thresholds and retention/cost controls. Connection failures and authenticated shared-folder creation are not solved by optimizing the public snapshot route. Do not quietly expand Phase 1 into those systems.

## Implementation checklist

- [x] Approve Phase 1 scope and measurement approach.
- [x] Reconfirm baseline; preserve unrelated working changes.
- [x] Add the deterministic query-boundary regression fixture.
- [x] Restrict note SQL and handle large subtree scope safely.
- [x] Reuse request-local folder-share metadata.
- [x] Add privacy-safe targeted measurements and error handling.
- [x] Run focused, security-boundary and integration checks listed above.
- [x] Record observed evidence and limitations.
- [ ] Obtain separate deployment approval; evaluate production outcome.
