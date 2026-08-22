# Public Sync Staging

Status: `MNEMOSYNE_PUBLIC_REFRESH_SOURCE_READY`

This branch is a source-only staging line for refreshing the standalone public Mnemosyne candidate before any publication action.

## Current boundary

- Baseline: `historical/mnemosyne-public-staging-wave1-20260818`.
- Construction branch: `public-sync/mnemosyne-v0.1-refresh-20260821`.
- Public destination repositories remain untouched.
- Private canonical source may be read as implementation evidence but is not a merge target for this branch.
- No live runtime, database, transcript, memory, provider credentials, deployment, or cloud state may be modified from this staging line.

## Phase A scope

Refresh only standalone, public-safe Mnemosyne behavior that has matured since the publication candidate was cut. The selected generic delta is projection crash consistency: authoritative event truth, projection freshness/watermark recovery, fail-closed stale reads, the cross-connection freshness/read TOCTOU boundary, and synthetic regressions covering those guarantees.

Telegram startup gates, private owner UX, persona-specific behavior, private prompts, live configuration, and deployment mechanics are host concerns and are outside this package refresh.

## Implemented source delta

- Projection materializations now carry an event-sequence watermark proving which authoritative event prefix they represent.
- Non-empty databases with missing/stale watermarks recover by refolding from append-only event truth before reads are exposed; brand-new empty databases remain valid without a materialized watermark.
- Derived reads fail closed when event truth outruns the projection watermark.
- Projection rebuild acquires its SQLite write reservation before reading event truth, binding fold input and published watermark to one transaction boundary.
- Runtime derived reads use a short `BEGIN IMMEDIATE` critical section so another connection cannot commit a newer event between freshness proof and the derived-table statement.
- Synthetic regressions cover revoke/approval post-commit crash recovery, same-process stale-read refusal, two-connection TOCTOU exclusion, empty-container semantics, and recovery of an otherwise-valid pre-watermark database.
- The Aug-18 candidate's existing trust-label/source-basis semantics were deliberately preserved; unrelated private-canonical semantic drift was not imported.

A fresh scan of post-candidate private commits found the later Telegram memory-activation/preflight family to be host/runtime work rather than standalone-library work, so it remains excluded.

## Verification receipt

The Phase A implementation reached an exact-head green verification on the private staging review line before this marker was written:

- Verified source head: `80b6da8d9acd0470460d0f18c066fa3c1cec40c9`.
- Construction review: draft PR #85, based on the preserved Aug-18 public candidate; it is review/CI scaffolding only and must not be merged as publication authority.
- Verification environment: isolated shallow checkout on the existing self-hosted Linux x64 runner, Node `22.22.1`, npm `10.9.4`.
- Candidate gate: `npm run verify` passed end-to-end.
- TypeScript typecheck: PASS.
- Synthetic test suite: `353/353` PASS, including the five added projection/recovery regressions.
- Adversarial scanner: PASS.
- Working-tree privacy scan: `files=465`, `bytes=4342084`, `findings=0`.
- Isolated-history privacy scan: `commits=1`, `blobs=141`, `bytes=1581862`, `findings=0`.
- Locked dependency install reported 0 vulnerabilities.

The construction workflow itself is deliberately scoped to this private staging ref and runs on the local self-hosted runner; it is not part of the intended published package surface. The current marker commit must retain the same green exact-head verification before the `SOURCE_READY` designation is treated as final evidence.

## Completion marker

Phase A is `MNEMOSYNE_PUBLIC_REFRESH_SOURCE_READY` once this marker commit itself has the complete exact-head verification above. No known P0/P1 remains in the selected standalone-library scope; synthetic regressions are present and the package/privacy boundary is unchanged or stronger.

Only after that exact-head marker verification may a separate private-repository staging branch be created for Public Delos ↔ Mnemosyne host integration. Publication remains a separate explicit action, and both public destination repositories remain untouched.
