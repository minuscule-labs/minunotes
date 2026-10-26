# Phase 2 — compact public-folder navigation and on-demand note bodies

Status: Approved by the user; implemented and locally verified on `feat/public-share-lazy-notes`. The initial delegated review's sole finding is fixed and independently approved by focused re-review. The user authorized committing the remaining work, pushing this branch and opening one combined PR against `main`; merge/deployment approval remains separate.
Baseline: Phase 1 commit `e1571ee446e18ff3c7e5774c8145ad54ba5ccdf5` on `fix/shared-folder-egress`.
Reference: `../plan.md` for Phase 1 requirements, evidence and release restrictions.

## Objective

Stop downloading every body inside a shared subtree when browsing a public folder or refreshing its Board. Fetch only the selected note body, after fresh authorization, without changing existing public links or removing the legacy snapshot API.

Phase 1 was implemented and committed first. The user subsequently chose one combined delivery of both phases from the current feature branch, rather than separate PRs. Neither phase has been merged or deployed. There is no production evidence yet that the remaining subtree snapshots are too large. Phase 2's proposed benefit must be demonstrated with local database-result and browser-request fixtures, not presented as an observed production improvement or connectivity fix.

## Confirmed implementation facts

- `GET /internal/share/folders/:token` returns metadata and all authorized note bodies. Phase 1 scopes those rows in SQL and reuses validated folder metadata within a request.
- `share.folders.$token.tsx` constructs the entire folder tree and selected-note view from that snapshot. Missing-note recovery refetches the snapshot.
- Public `NotesBoard` refresh invalidates the same snapshot before refreshing config/lanes.
- The viewer makes a separate wikilink request; that handler reads the selected source body again. The existing resolver can instead use an already-loaded source and a request-local folder repository. Candidate lookups select metadata, not target bodies.
- Existing renderer/resource-URL helpers already accept folder token and selected note ID. Public Board links already preserve `note`, `folder` and `view=board`.
- Public share operations are partly documented in `src/api/openapi/harness.ts`; Postman is generated from that document. Additive endpoints therefore need contract and generated-artifact coverage too.

## Approved scope and decisions

1. Add two read-only public endpoints: compact navigation and an independently authorized single-note detail read.
2. Move the public folder viewer to those endpoints. Keep the legacy snapshot, standalone note shares, existing wikilink endpoint and attachment URLs unchanged.
3. Return source-bound Markdown wikilink resolutions with the detail response, avoiding a second source-body read in the migrated viewer.
4. Retain no inactive note-body cache. Every note opening, including Back/Forward to a note, performs a fresh detail read. This trades additional small authorized reads for simpler freshness, revocation and bounded body-cache behavior.
5. Keep one complete subtree **metadata** response for now. Do not introduce metadata pagination, lazy folder expansion or partial trees in this phase. Metadata size still grows with subtree size; there is no claim of bounded total navigation bytes. No silent truncation or arbitrary folder/note cap.
6. Extend only the existing explicit public-share measurement helper to the two new operations. No broader harness observability.
7. Implementation uses a feature branch based on the Phase 1 commit. The user's final packaging decision is one combined PR from `feat/public-share-lazy-notes` against `main`, containing both phases. Preserve the local Phase 1 branch and discussion branch/stash; do not create or remove worktrees.

Out of scope: database migrations/upgrades, connectivity fixes, timeout increases, editing/collaboration features, global caching/access frameworks, prefetching note bodies, persistent browser storage, new UI helper text, API-key/MCP tool changes, and production deployment.

## API contracts

### Compact navigation

`GET /internal/share/folders/:token/navigation`

- Response: `{ folder, folders, notes, share }`, matching the legacy metadata shape, but each note contains only `id`, `folderId`, `title`, `documentType`, `updatedAt`.
- `content` must be absent from the SQL projection and JSON response. Do not select it and discard it later. Do not replace it with empty strings or previews.
- Revalidate the active share and hierarchy on each request using the Phase 1 resolver. Reuse its folder rows and subtree IDs, with the same private-folder and descendant semantics.
- Scope note metadata in SQL with explicit owner, active-note/ancestor, `type = note`, and parameterized subtree membership predicates. Preserve database title ordering and existing folder-tree behavior.
- Empty authorized folders return successful empty note lists. Invalid shares/hierarchies return the existing generic public-folder 404 style, with no note-content query.

### Selected note detail

`GET /internal/share/folders/:token/notes/:noteId`

- Response: `{ note, resolutions }`. `note` has the legacy selected-note fields: `id`, `folderId`, `title`, `content`, `documentType`, `updatedAt`. Do not return owner IDs or other internal authorization fields.
- Independently revalidate the token, expiry/revocation, active hierarchy and current subtree on **every** read. Navigation metadata, a Board card, prior detail results and client folder IDs are not grants.
- Apply owner, active-note/ancestor, note type, requested note ID and subtree membership in the body query's SQL predicate. At most one body row may cross the database client boundary. Never fetch by ID broadly and authorize membership after reading the body.
- Missing, trashed, templated, foreign-owner or moved-outside-subtree notes return the same generic note 404 style. A failed or empty scope never falls back to the snapshot or owner-wide content retrieval.
- Markdown: pass the already-authorized source to `resolveSourceWikilinks`, overriding its folder repository with the resolver's validated request-local folder metadata. Preserve authored-target limits, duplicate-title handling, same-share hrefs and standalone-share fallback. Never read target bodies.
- Canvas: derive the current authorized visible target-ID set using a metadata-only SQL query with the same active owner/subtree predicates, then reuse the existing sanitizer. Do not fetch target content or trust a cached navigation list. Preserve current canvas presentation and external URL metadata while sanitizing invisible internal note targets; no new canvas interaction feature.
- `resolutions` is empty for canvas documents. Keep the old wikilink endpoint available for existing callers, but the migrated viewer must not call it in addition to detail.

### Shared HTTP behavior

- Both new endpoints are read-only, retain the existing public-share rate limit and security headers, and set `Cache-Control: no-store`, including error responses. No ETags, conditional body cache or CDN cache policy changes.
- Encode token/note path segments in client methods; pass optional `AbortSignal` and `cache: 'no-store'` through the existing request helper.
- Keep the legacy snapshot response and Phase 1 event contract unchanged. No automatic fallback to the legacy API if a new endpoint is unavailable; use the existing error/Retry presentation instead.
- Register and test the new routes without shadowing existing snapshot, attachment, wikilink, Board or standalone-share routes.
- Document the additive contracts and regenerate Postman using the existing generator; no generator/framework redesign.

## Frontend behavior and request-local authority

### Query ownership

- Add a small public-folder query module for navigation/detail query options, token-scoped keys and cancellation/cleanup used by the viewer and Board. Keep it local to these public reads, not a global permission framework.
- Navigation and note keys include the share token; detail additionally includes the note ID. Never share data between tokens or use previous-note placeholder data.
- Detail uses `gcTime: 0`, stale data is not considered proof of access, and mounting a selected note always reads it again. Pass and consume TanStack's abort signal. Disable automatic retries for the new reads; the existing Retry action starts one new attempt.
- Keep only the active selected detail in memory. Do not prefetch bodies, persist them, or put content into navigation, Board config, lane/card or application-wide note caches.
- Cancel obsolete reads when the token/selection changes or the viewer unmounts. Late responses must not replace the selected note, restore denied data or repopulate a purged token cache. Cancel before removing token-scoped queries.

### Opening, recovery and URL history

- List/Board entry loads navigation metadata and existing Board config/lanes as needed: zero note-body reads until a note is selected.
- Selection triggers the detail endpoint directly. A valid note missing from stale navigation or newly added to a Board must still open without first refetching a snapshot.
- A direct `?note=...` link may load navigation and detail concurrently; neither response is an authorization shortcut for the other. Do not render a selected body after navigation reports share denial.
- A selected detail's authorized `folderId` determines its Back destination when no explicit folder is present. Refresh navigation metadata on return to folder browsing and when recovering missing/stale folder metadata; never insert content into that metadata cache.
- Preserve the existing `note`, `folder`, `view` URL meanings, reload behavior, descendant navigation, List/Board switching and Back/Forward history. Same-share wikilinks retain Board presentation; links to other shares are not rewritten.
- Reuse existing loading/error/unavailable/Retry/Back states without adding explanatory UI microcopy. Hide the prior body and its resolutions while switching, revalidating or after an error. Key source-specific viewer/canvas state by token and note ID.
- A successful detail with no navigation entry is not an unavailable note. A detail 404 must not trigger a repeated recovery loop.

### Denial, revocation and transient failures

- A detail 401/403/404 hides and clears its retained body/resolutions immediately. Perform at most one fresh **metadata-only** navigation revalidation for that denied selection to distinguish a missing note from an unavailable share.
- If navigation succeeds, show the selected-note-unavailable state and retain access to the folder; do not retry the same missing body automatically. If navigation denies the root share, cancel and clear all navigation/detail and Board data for that token and show the existing shared-folder-unavailable state.
- Apply the same root revalidation rule when public Board reads report access denial. A missing/disabled descendant Board alone must not permanently mark a still-valid root share as revoked. Keep existing Board snapshot/config error handling and owner/editor/viewer behavior intact.
- Transient network/5xx/429 failures show existing retry/error states without displaying a retained body as a successful read. No automatic snapshot fallback, indefinite retry loop or stale-content display.
- Revalidate on the existing focus/refetch lifecycle; a failed revalidation hides retained detail. Revocation is detected on a subsequent authorized request/focus/refresh, not through a new push mechanism. Previously downloaded content cannot be retroactively erased from a recipient.

### Public Board refresh

- Replace full-snapshot invalidation with navigation-metadata invalidation and invalidation/cancellation of token-scoped detail state; then refresh the existing Board config/lane generations.
- Manual refresh, lane pagination, List/Board switching and missing-note recovery must never download all bodies.
- New/edited card selection reads the latest individual body. Hidden Board columns must not narrow the underlying folder share or block an otherwise authorized detail read.
- Keep authenticated Board behavior and the existing lane pagination, ordering, classification and snapshot checks unchanged.

## Privacy-safe measurement

- Extend the current explicit helper with fixed operation labels for navigation and detail; retain `public_share.folder_snapshot` and its existing fields for legacy requests.
- One correlated completion event and generated `X-Request-Id` per new request, including denied/rate-limited/error requests. Keep production-app wiring ahead of rate limiting and avoid duplicate failure logging.
- Preserve duration, hierarchy-query and primary note-fetch counters. For navigation, note count describes returned metadata rows and `note_content_bytes` is zero. For detail, note count is at most one and bytes measure the raw selected content before canvas sanitization. Auxiliary target-ID/resolver metadata reads must not be misrepresented as returned body rows or total database-call coverage.
- Retain exact allowlisted bounded cause codes and fixed route labels. No token, note ID/title/content, owner/email, raw path/query, SQL or parameter logging. Reuse the scoped global public-share error sanitization.
- Treat content bytes as a payload measure, not total Turso network bytes. Metadata queries and additional per-open authorization reads still have overhead; do not promise a latency reduction without measurement.

## Acceptance criteria

- [x] Navigation SQL never selects content, even for large in-subtree notes; database-returned content bytes remain zero as those bodies grow.
- [x] Detail returns only the selected authorized body's bytes, never another source/target body, including while resolving Markdown links or sanitizing canvas.
- [x] Token rotation/expiry/revocation, deletion, move-outside-subtree, invalid hierarchy, templates and tenant boundaries fail closed at the database boundary.
- [x] A body cached before a move/revocation cannot be shown as a successful new selection, Back/Forward entry, refresh or refocus read after denial.
- [x] All migrated List/Board browsing, refresh, lane paging, recovery and detail flows make zero calls to the legacy snapshot endpoint.
- [x] One selected-note attempt makes one detail request, without a duplicate wikilink-source-body request; explicit retry/refocus/reopening are separate attempts.
- [x] Markdown/attachments, canvas sanitization, descendant/URL history, hidden-column access and new-card recovery remain compatible.
- [x] Legacy snapshot, standalone shares and existing attachment/wikilink endpoints retain their contracts; there are no schema, API-key or MCP changes.
- [x] New public operations have privacy-safe, correlated measurements and production-app failure-path tests.

## Proposed file/test map

| File | Planned change | Required verification |
| --- | --- | --- |
| `src/api/routes/share.ts` | Add navigation/detail, SQL predicates, request-local resolver reuse, combined resolutions and canvas-ID reads | Real-libSQL authorization and actual client-result assertions; legacy compatibility |
| `src/api/lib/share-observability.ts` | Extend explicit measurement to the two new fixed operations | Event counts, byte semantics, timing, bounded causes and redaction tests |
| `src/api/index.ts` | Wire new read measurements before rate limiting; retain sanitized errors | Production app success/denial/rate-limit/database-error tests |
| `src/frontend/lib/api.ts` | Add metadata/detail response types and abortable no-store methods; keep legacy methods | Encoded paths, request options, typecheck and browser contracts |
| `src/frontend/lib/public-folder-share.ts` (new) | Local query options/keys, cancellation and token-scoped cache cleanup | `tests/public-folder-share-queries.test.ts` (new): token isolation, selected-note lifecycle, no inactive body cache, cancellation and late-result cleanup |
| `src/frontend/routes/share.folders.$token.tsx` | Build navigation from summaries; render authorized detail/resolutions; replace snapshot-based recovery | List/detail/deep-link/history/loading/error/revocation browser cases |
| `src/frontend/components/notes-board.tsx` | Refresh compact metadata instead of snapshot; connect public denial cleanup | Public refresh/visibility tests plus authenticated Board regressions |
| `src/api/openapi/harness.ts` | Add navigation/detail operations and response schemas | `tests/openapi.test.ts`: public contracts and metadata schema excludes content |
| `postman/minunotes-harness.postman_collection.json` | Regenerate additive public endpoints with existing generator | `pnpm postman:generate`; OpenAPI/Postman consistency tests |
| `tests/folder-share-links.test.ts` | New read contracts and active-share/selected-note authorization matrix; retain legacy assertions | Root/child/private/sibling/foreign/template/deleted/moved/rotated/expired/revoked cases, Markdown and canvas |
| `tests/shared-folder-egress.test.ts` | Extend local fixture with many large notes **inside** the share and captured client results | Zero-body navigation; one-body detail; no resolver/target body reads; large scope/order/empty cases; legacy snapshot still compatible |
| `tests/share-observability.test.ts` | Cover new operations through the production app | One event/ID, denied zero-body reads, raw-versus-sanitized canvas bytes, nested SQL/parameter errors and rate limits |
| `tests/public-board-sharing.test.ts` | Verify selected detail remains accessible independently of hidden columns | New detail read compatibility plus existing config/lane authorization |
| `tests/browser/fixtures.ts` | Mock compact metadata and detail/resolutions without embedding bodies in navigation | Request tracing and all existing public viewer browser consumers |
| `tests/browser/property-board-fixtures.ts` | Coordinate current metadata/detail data and explicit token-denial controls | Do not conflate Board config failure/disabled state with root-share revocation |
| `tests/browser/public-board-sharing.spec.ts` | Replace snapshot-count expectations with navigation/detail/no-snapshot assertions | Refresh/new and changed cards, missing note, transient retry, root revocation, same-share links |
| `tests/browser/folder-sharing.spec.ts` | Retain public List behavior against compact fixtures | Initial metadata-only browsing and descendants |
| `tests/browser/shared-wikilinks.spec.ts` | Cover combined detail resolutions while preserving standalone-share and portable attachment behavior | Same-/other-share links, unresolved targets and selected-note attachment URLs |
| `tests/browser/shared-folder-lazy-loading.spec.ts` (new) | Focused asynchronous selection/cache/history regressions | Direct links, A→B/late A, token A→B, Back/Forward, reopen after move/revoke, focus revalidation, missing-note recovery and zero snapshot calls |
| `docs/implementation/shared-folder-egress/phase-2/plan.md` | Record approved choices, exact implementation revision, checks and limitations | Manual evidence review; no production contents |

Reuse the current disposable-database and browser fixtures. No test-framework refactor. Existing link/resource-URL helpers, Markdown renderer, canvas sanitizer and wikilink resolver should need no application edits; stop and amend this plan if a material compatibility gap requires expanding that scope.

## Implementation checklist and verification cadence

- [x] Approve the API contracts, complete-metadata/no-pagination decision, no-inactive-body-cache policy, and narrow measurement extension.
- [x] Reconfirm Phase 1/main revision and create the separate feature branch; preserve unrelated discussion work.
- [x] Add failing real-database projection/result-boundary tests for large **in-subtree** content and fresh authorization after moves/revocation.
- [x] Implement additive endpoints/measurements and update OpenAPI/generated Postman; run new route tests plus folder-share, public Board, shared-wikilink, observation and OpenAPI tests.
- [x] Add the local query lifecycle and compact frontend methods; run the new query tests, `pnpm typecheck`, and focused browser selection/refresh tests.
- [x] Migrate viewer/recovery/Board refresh; run the asynchronous browser matrix without loosening its unavailable/revocation assertions.
- [x] Run `pnpm exec biome check --write <changed-ts-files>`, `pnpm typecheck`, `git diff --check` and the affected sharing/trash/security/resource-URL regressions.
- [x] At merge-ready integration, run `pnpm exec vitest run --maxWorkers=2`, then `pnpm build`; keep benchmark/demo opt-ins opt-in and do not run the full suite alongside heavy browser work.
- [x] Run browser specs: `folder-sharing`, `public-board-sharing`, `shared-wikilinks`, `shared-folder-lazy-loading`, `board-visibility`, plus `notes-board` and `property-board` for the shared Board component. No timeout increases or weakened gates.
- [x] Record exact results and deterministic database byte/row evidence. Request independent review separately if desired; prior Phase 1 review does not review Phase 2.
- [x] Obtain explicit approval to commit remaining work, push the current branch and open one combined PR against `main`.
- [ ] Obtain explicit merge/release/deployment approval as applicable; production deployment remains separate.

## Observed implementation evidence

- Verified target: the Phase 2 patch on `feat/public-share-lazy-notes`, based on `e1571ee446e18ff3c7e5774c8145ad54ba5ccdf5`. The checks below were performed before committing Phase 2. Phase 1's commit is already included in this branch and remains on its local fix branch; the discussion stash is untouched. The user subsequently authorized one combined PR; no merge or deployment was performed.
- Initial integration/pre-review source/test fingerprint: `893d41ae5e3ae4368eff42c399f349dc9ba83febea0b7a145f7d189e716e015c` — SHA-256 over the 20 changed/new `src/`, `tests/` and `postman/` files, sorted by path, each encoded as path + NUL + file bytes + NUL. This evidence document is excluded.
- Disposable libSQL fixture: 41 in-subtree notes contain **2,621,446 body bytes** in the unchanged legacy snapshot. Navigation selects no content and returns **zero body bytes**; opening the selected UTF-8 source returns **one row / 6 bytes**. Markdown target resolution and canvas target-ID queries do not return target bodies.
- Large-scope coverage uses 1,102 folders. Navigation retains five binds; detail has seven, including the requested ID and bound LIMIT. Both remain constant with scope size and preserve SQLite title ordering. An added test initially expected six detail binds, overlooking LIMIT; correcting the assertion required no application workaround.
- New reads reuse the validated hierarchy per request, keep no-store headers on success/denial/rate-limit/error responses, and emit one fixed-operation event/ID. The legacy snapshot event name and fields remain compatible.
- Client state uses token/note-scoped, abortable queries, `gcTime: 0` for detail, metadata-only recovery/Board refresh, and explicit failure-payload discard without automatic refetch loops. Parent state stores only note summaries, not bodies. Root denial clears token-scoped public/Board data and the retained summary/title; unrelated tokens and authenticated Board data are preserved.
- `pnpm exec vitest run --maxWorkers=2` — **92 files passed, 1 skipped; 793 tests passed, 2 skipped**. This includes API/database boundary, public-share privacy, query lifecycle, legacy sharing, trash/security, resource URLs and OpenAPI/Postman tests. Heavy benchmark/demo opt-ins remain opt-in.
- `pnpm exec playwright test tests/browser/folder-sharing.spec.ts tests/browser/public-board-sharing.spec.ts tests/browser/shared-wikilinks.spec.ts tests/browser/shared-folder-lazy-loading.spec.ts tests/browser/board-visibility.spec.ts tests/browser/notes-board.spec.ts tests/browser/property-board.spec.ts --workers=3` — **177 passed**. These are browser tests with mocked APIs, not production end-to-end evidence. They include no-snapshot/no-extra-wikilink assertions, history, cancellation/late responses, token changes, moves/revocation, failed focus revalidation and authenticated Board regressions.
- `pnpm typecheck` passed. `pnpm exec biome check --write` on all 19 changed TypeScript files and the generated Postman JSON passed with **11 class-order warnings in retained viewer markup**; final run applied no changes. No unsafe fixes were run. Postman was regenerated with `pnpm postman:generate` and normalized using Biome; its diff is limited to the two additive endpoints.
- Initial `pnpm build` passed with a large-chunk warning. `git diff --check` passed. The full-suite/build/177-browser results above precede the focused review fix below.
- Delegated contextual review returned **REQUEST_CHANGES**, with one MEDIUM finding: Back from a failed descendant-note revalidation lost its authorized folder destination. It independently ran 71 focused unit/API tests, 22 browser tests, typecheck and diff checks, and reproduced the missing-folder URL. No other actionable findings were reported.
- Review fix: preserve only the last successfully authorized `folderId` in the selected component's token/note-keyed ref, then use it for loading/error Back navigation. Sensitive detail/resolutions are still discarded on failure; no inactive body cache was added. Both loading and failed-focus descendant regressions reproduced the root-navigation bug before the fix.
- Post-fix `pnpm exec playwright test tests/browser/shared-folder-lazy-loading.spec.ts tests/browser/public-board-sharing.spec.ts tests/browser/shared-wikilinks.spec.ts --workers=2` — **29 passed**, including both new regressions. `pnpm exec vitest run tests/public-folder-share-queries.test.ts` — **5 passed**. `pnpm typecheck`, changed-two-file Biome and `git diff --check` passed, with the same 11 retained class-order warnings and no unsafe fixes.
- Post-fix source/test fingerprint, using the same 20-file algorithm: `a0a7794a4851669de6f1c0afa71fd0b634a2e77df359e87cb03180b4f2d6c164`. Only the selected viewer, its browser regression file and this evidence document changed for the fix. The broader checks were not repeated for this narrow metadata-only Back-handler delta; backend/query behavior is unchanged. A subsequent focused delegated re-review independently verified this fingerprint and returned **APPROVE**, explicitly resolving the sole prior finding, with high confidence for that scoped fix. It ran `VITE_API_PROXY_TARGET=/internal pnpm exec playwright test tests/browser/shared-folder-lazy-loading.spec.ts --workers=2` (**12 passed**), `VITE_API_PROXY_TARGET=/internal pnpm exec vitest run tests/public-folder-share-queries.test.ts` (**5 passed**), `pnpm typecheck` and `git diff --check`; all passed, with no reviewed-file edits.
- Production baseline/smoke/traffic/latency/connectivity verification, metadata pagination, merge and deployment remain outside this local implementation evidence. Publishing was separately authorized after the checks/re-review; no further application changes were made.

## Rollout, rollback and remaining limits

- Deliver both related phases in one combined PR against `main`, per the user's final decision. Publishing this feature branch is approved; merging and deploying it are not.
- Deploy additive backend endpoints before switching production frontend consumers, or use the normal release artifact that guarantees their availability before frontend traffic. No runtime legacy-snapshot fallback masking a partial rollout.
- Before an approved release, record candidate SHA, fixture results and available production comparison data without repeating expensive production queries to manufacture a baseline.
- After approved deployment, smoke-test List, Board, detail, Back/Forward, Markdown/attachments, canvas, hidden-column access and revoked links. Compare operations and note-content bytes by fixed operation label, adjusting for request counts and usage mix. Legacy consumers can still generate snapshot traffic.
- Roll back the frontend to the Phase 1 viewer if compatibility fails; the legacy backend snapshot remains available. A full rollback to the Phase 1 application needs no schema rollback.
- Metadata/hierarchy reads remain proportional to folder/note counts; individual large bodies and canvas target-ID sets may still be large. A separate pagination/lazy-tree decision needs evidence and its own consumer/URL design. No production egress, latency or connectivity improvement is claimed until measured.
