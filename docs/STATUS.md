# Status

This page describes the capabilities that are **actually merged in this repository**. Each row separates specification, source, tests, and runnable wiring so that a design document, a passing fixture, and a deployed runtime are never mistaken for the same state.

| Capability | Specification | Merged code | Tests | Synthetic wiring |
| --- | ---: | ---: | ---: | ---: |
| Mythos contracts and nine Muses | yes | yes | yes | contract flow |
| Mnemosyne lifecycle and Lethe | yes | yes | yes | local flow |
| Canonical evidence / provenance / `source_basis` | yes | yes | yes | rebuild + reopen |
| Policy-card repair / revision idempotence / consolidation | yes | yes | yes | governed SQLite flow |
| Formal curation (`KEEP / REVISE / REVOKE / RECLASSIFY_AU / SUPERSEDE / MERGE / EPISODIC_ONLY`) | yes | yes | yes | replay + rebuild/reopen |
| Portable retention authority | yes | yes | yes | pure dispatcher contract |
| Anamnesis retrieval | yes | yes | yes | local flow |
| SQLite event log and rebuildable projections | yes | yes | yes | local flow |
| Durable decision automation | yes | yes | yes | test harness |
| Episode Projection Pass 1 and 2 | yes | yes | yes | deterministic port |
| Backup, restore, deletion, health | yes | yes | yes | end-to-end tests |
| Telegram governance adapter | yes | yes | yes | adapter tests |
| Privacy and release gates | yes | yes | yes | repository gates |

The package root is the preferred stable discovery surface. In particular, `Governance`, `Curation`, and `Retention` expose the current non-embedding memory / governance / retention contracts without requiring a host to depend on service-file layout. Delos consumes Mnemosyne through that package boundary.

Current required verification is `npm run verify`: typecheck, the full synthetic test suite, adversarial scanner tests, working-tree privacy scan, and isolated-history scan. Do not quote a historical test count as a current capability claim; the exact current commit and its verification evidence are the authority.

A GitHub Actions run that fails before receiving a runner or before executing any repository step is infrastructure evidence, not a source-test result. It must not be reported as either a green verification or a code failure; obtain a fresh exact-head run before making a final verification claim.

This page makes no claim beyond the repository state shown here. Specification, source bytes, tests, merge state, package publication, release tags, and live deployment are distinct states.

Embedding / vector / hybrid retrieval is intentionally outside this status slice. Episode Projection remains a rebuildable projection and is not automatically promoted to durable memory.
