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
| Writer-free historical retention replay receipt | yes | yes | yes | deterministic replay contract |
| Anamnesis governed memory retrieval | yes | yes | yes | local flow |
| SQLite event log and rebuildable projections | yes | yes | yes | local flow |
| Durable decision automation | yes | yes | yes | test harness |
| Episode Projection Pass 1 and 2 | yes | yes | yes | deterministic ports |
| Episode history lexical search / recent-history fallback | yes | yes | yes | read-only SQLite source |
| Episode exact-id history read | yes | yes | yes | read-only SQLite source |
| Deterministic same-conversation Episode adjacency | yes | yes | yes | core + SQLite source |
| Turn-scoped Episode follow-up authorization | yes | yes | yes | synthetic turn session |
| Turn-scoped Episode recall session | yes | yes | yes | search + read + follow-up |
| Shared recall attempt ledger | yes | yes | yes | four-attempt default |
| Model-facing recall input bounds | yes | yes | yes | 600/120 code-point limits |
| Cumulative recall payload budget | yes | yes | yes | 24,000 code-point default |
| Content-free recall outcome taxonomy | yes | yes | yes | synthetic source failures |
| Content-free Episode recall audit receipts | yes | yes | yes | audit sink wrapper |
| Runtime custom-source recall validation | yes | yes | yes | malformed-source regressions |
| Replay ceilings and chronology compare absolute instants across ISO offsets | yes | yes | yes | mixed-offset regressions |
| Backup, restore, deletion, health | yes | yes | yes | end-to-end tests |
| Telegram governance adapter | yes | yes | yes | adapter tests |
| Privacy and release gates | yes | yes | yes | repository gates |

The package root is the preferred stable discovery surface. It currently exposes the public memory domain and validation/fold surfaces plus `Governance`, `Curation`, `Retention`, `Anamnesis`, `ContextAssembly`, Episode Pass 1/2, Episode history/read/adjacency/follow-up/turn-scoped recall/audit, the corresponding SQLite Episode sources, backup/deletion/reliability surfaces, proposal/decision automation, and the Telegram governance adapter. Hosts should prefer those package exports over depending on internal service-file layout.

The turn-scoped Episode recall surface is intentionally fail-closed. Model-facing search text must be non-blank and is bounded to 600 Unicode code points; an optional lexical time hint is bounded to 120. Search, exact read, and follow-up share one attempt ledger (four attempts by default) and one cumulative result budget (24,000 Unicode code points by default). Episode ids become usable for exact read or adjacency only after they were actually returned in the same session. Audit receipts and outcome codes stay content-free.

Public Episode sources also defend their trust boundaries. Current-published payload/provenance checks remain source responsibilities, while the turn-scoped session independently validates temporal ordering, its replay ceiling, canonical SHA-256 provenance, and other authority-relevant hit fields before a custom source can widen same-turn recall capability. Core and SQLite chronology/replay comparisons use absolute instants rather than ISO text ordering so mixed UTC offsets cannot change eligibility or ordering.

Current required verification is `npm run verify`: typecheck, the full synthetic test suite, adversarial scanner tests, working-tree privacy scan, and isolated-history scan. Do not quote a historical test count as a current capability claim; the exact current commit and its verification evidence are the authority.

A GitHub Actions run that fails before receiving a runner or before executing any repository step is infrastructure evidence, not a source-test result. It must not be reported as either a green verification or a code failure; obtain a fresh exact-head run before making a final verification claim.

This page makes no claim beyond the repository state shown here. Specification, source bytes, tests, merge state, package publication, release tags, and live deployment are distinct states. It also does **not** claim byte-for-byte or current-private parity: host composition, provider wiring, credentials, deployment policy, real corpora/data, and other host-owned integration remain outside the public package boundary.

Embedding / vector / semantic / hybrid Episode retrieval is not currently implemented in this public package. Episode Projection remains a rebuildable projection and is not automatically promoted to durable memory.
