# Public extraction manifest

## Inclusion rule

This repository is constructed from a new Git history. No file enters because
it was merely lexically clean. Every included file must belong to the complete
functional closure and must have its dependencies, private couplings, tests,
and disposition recorded.

## Complete functional closure

1. Mythos contracts: principals, authority, Musagetes, the nine Muse lenses,
   retrieval intent, memory-candidate intent, scene state, trace exclusion.
2. Mnemosyne: event kernel, validation, fold, governance, policy activation,
   provenance, revisions, sealing, revocation, supersession, expiry, and Lethe.
3. Anamnesis: eligibility, ranking, trust, conflict handling, budgets, packet
   construction, injection containment, and metadata-only audit.
4. Persistence: SQLite event log, migrations, projections, FTS, integrity,
   backups, and seed/import mechanisms over synthetic data.
5. Automation: proposal paths, durable no-drop decision backlog, verified
   evidence reread, retry, idempotency, budgets, circuit breaking, and automatic
   owner-policy activation without false individual confirmation.
6. Episode Projection: Pass 1 segmentation, realm/AU/domain separation,
   continuation, overrides, Pass 2 chunking/assembly, claim validation,
   published/generated payloads, and SQLite projection.
7. Operations: encrypted backup, restore proof, retention, deletion safety,
   health, reliability, and progress arithmetic.
8. Integrations and examples: transport-neutral contracts plus a complete
   synthetic local reference flow. Transport adapters remain adapters.

## Exclusion rule

No private Git history, runtime data, private prompts, private policy instance,
real transcript-derived asset, real trace, real principal, or machine-specific
path is eligible. Excluding private content must not remove the mechanism that
used it; the mechanism receives an equivalent synthetic fixture or a public
configuration port.

## No-reduction rule

“Minimum public path” means the least change needed to retain the complete
system. It does not authorize a Lite, Core-only, Demo-only, CRUD-only, or
architecture-flattened edition.

## Public documentation and release form

Normative repository documentation is English. `README.zh-CN.md` is the
single linked Simplified Chinese translation and remains fully privacy-scanned.

The authorized licence is PolyForm Noncommercial 1.0.0, matching Public Delos.
The candidate includes both complete source and a public installable package
surface. Direct GitHub installation and a downloadable release tarball are the
supported distribution paths; neither requires an npm publisher account.

The release sequence, including working-tree and history privacy scans,
pristine export, package inspection, private compatibility replay, and
artifact hash receipt, is in `docs/PUBLICATION-CHECKLIST.md`.
