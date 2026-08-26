# Integration guide

## Audience and boundary

This guide is for a host runtime integrating Mnemosyne as its governed memory
subsystem. Delos is the reference host, but the contracts do not depend on one
assistant identity, model provider, transport, or surface.

Mnemosyne is not a chat application. The host owns the live transcript source,
model provider, clocks, filesystem layout, credentials, transport security,
and operator policy.

## Public entry surface

The root package exports stable domains and namespaced subsystems:

| Export | Purpose |
| --- | --- |
| `MemoryDomain` / `MnemosyneDomain` | Memory events, lifecycle, provenance, owner policy, and folds |
| `EpisodeDomain` / `EpisodePass1Domain` / `EpisodePass2Domain` | Transcript-derived episode contracts |
| `Anamnesis` | Eligibility, ranking, budgets, read packets, and safe rendering |
| `Governance` | Governed proposal, activation, revision, sealing, revocation, consolidation, and owner actions |
| `Curation` | Hash-bound formal decision sets, replay-aware applicator contracts, and governance-writer adapter |
| `Retention` | Portable retention vocabulary, validation, and pre-admission dispatcher |
| `ContextAssembly` | Context and injection boundary contracts |
| `Backup` / `BackupRuntime` | Retention decisions, encrypted packages, restore proof, and pruning |
| `Deletion` | Authorized deletion and derived-store safety |
| `Reliability` / `HealthRuntime` | Health observations, faults, receipts, and reconstruction choices |
| `ProposalAutomation` / `DecisionBacklog` / `DecisionWorker` | Durable automatic candidate processing |
| `SqliteMnemosyne` | Local append-only event log and rebuildable projections |
| `EpisodeProjection` | SQLite Episode Projection adapter |
| `TelegramGovernance` | Governance-oriented Telegram adapter contracts |
| `MUSE_NAMES`, `MUSE_LENSES`, and Musagetes functions | Normative mythology and intent composition |

The root namespaces are the preferred stable discovery surface. Narrow subpath
exports exist for advanced integrations, but host code should not treat the
current internal service-file layout as a compatibility promise when a root
concept exists.

## Host responsibilities

A real integration must supply and own:

1. **Persistent roots.** Choose explicit locations for the Mnemosyne authority,
   episode projection, evidence archive, backlog, backup packages, and health
   receipts. Do not derive them from an accidental current working directory.
2. **Principals.** Bind deployment identities to stable `owner`, `companion`,
   and `system` roles through the Principal Registry.
3. **Owner policy.** Register a versioned, digest-pinned policy before automatic
   activation is permitted.
4. **Evidence resolution.** Resolve stable transcript or import pointers and
   verify the expected content hash before a decision.
5. **Backup hook.** Provide a verified post-write backup path. A write remains
   truthfully reported as persisted if a later backup fails; the failure must
   be recorded and retried rather than hidden.
6. **Metadata-only audit.** Store ids, categorical reasons, counts, budgets,
   timings, and policy versions without copying memory, transcript, prompt, or
   user-input bodies into audit logs.
7. **Provider adapter.** If model-assisted candidate generation or Episode Pass
   2 is used, inject a provider through the port. Core memory and retrieval do
   not select credentials or open a provider connection.
8. **Retention before admission.** If a host uses the portable retention mode,
   classify evidence through `Retention` before ordinary long-term candidate
   admission. Session-only, episodic, quarantine, and correction destinations
   are not ordinary long-term candidates.
9. **Operational cadence.** Run backup, restore drills, health checks, and
   backlog workers from an explicit host scheduler. Do not depend on a user
   remembering to inspect a dashboard.

## Reference local composition

The complete synthetic example lives in `examples/local-flow.ts`. Its shape is:

```ts
import {
  Anamnesis,
  Governance,
  SqliteMnemosyne,
} from "@delos/mnemosyne";

const handle = SqliteMnemosyne.openMnemosyne(databasePath);

const service = new Governance.MnemosyneGovernanceService({
  store: handle.store,
  backup: verifiedBackupHook,
  audit: metadataOnlyAuditSink,
});

await service.ensureOwnerPolicy(ownerPolicy);
await service.proposeUnderPolicy(candidate);

const packet = Anamnesis.buildMemoryReadPacket({
  source: handle.store,
  query,
  scene,
  nowIso: new Date().toISOString(),
});
```

Always close the returned SQLite log handle during host shutdown.

## Write path

```text
candidate source
  -> retention/admission decision at the host boundary
  -> stable evidence pointer + expected hash
  -> durable decision backlog
  -> evidence reread and hash verification
  -> policy and write-site validation
  -> joint append of memory + governance events
  -> projection rebuild/update
  -> verified backup hook
  -> metadata-only receipt
```

The host must not bypass this path by letting a model call the event log or
SQLite adapter directly. A candidate generator proposes; the governance
service decides what operation is admissible under the registered policy.

## Formal curation boundary

`Curation` exposes the reviewed decision-set contract, replay-aware applicator,
and governance-writer adapter as one stable package concept. Curation decisions
are hash- and precondition-bound. Exact replay is a no-op, stale or conflicting
identities fail closed, and semantic changes plus durable receipts still pass
through the single Mnemosyne governance writer. `EPISODIC_ONLY` preserves
historical/evidence value while removing the item from ordinary long-term
retrieval; it is not physical deletion.

## Read path

```text
scene + retrieval intent
  -> principal / scope / AU / sensitivity gates
  -> lifecycle / expiry / revocation / supersession gates
  -> trust and conflict handling
  -> ranking and item/token budgets
  -> structured MemoryReadPacket
  -> containment-aware rendering by the host
```

Do not concatenate raw memory rows into a system prompt. Use the packet and its
rendering boundary so untrusted memory bodies cannot impersonate instructions.

## Musagetes boundary

Musagetes composes any number of Muse lens signals. It emits:

- `RetrievalIntent` for Anamnesis;
- `MemoryCandidateIntent` for the candidate-generation path.

A `MuseTraceEnvelope` is evaluation evidence only. Passing it to a memory or
retrieval source is a contract violation and is rejected by the public helper.

## Episode Projection boundary

Transcript evidence remains append-only source material. Episode Pass 1 and
Pass 2 produce versioned, source-hashed, rebuildable projections. An episode
summary or claim is not automatically a Memory Card.

If the host wants an episode-derived fact to become durable memory, it must
enter the same retention, evidence, candidate, policy, and governance path as
any other automatic proposal.

## Backup, restore, and health

Use `BackupRuntime.runBackup` with explicit source paths and encryption
material supplied by the host. A package is not proven merely because archive
creation returned success; `BackupRuntime.proveRestore` evaluates the complete
restore proof contract.

Use `HealthRuntime.observeHealth` or `HealthRuntime.runHealth` with explicit
paths. The health adapter can inspect derived integrity, queue state, backup
age, process facts, and an explicitly configured provider-egress probe. A probe
does not carry memory content.

Restores and reconstruction tests should target isolated scratch roots before
any production swap. The host owns the atomic cutover and rollback boundary.

## Privacy checklist for integrators

- Keep credentials outside Mnemosyne configuration and event bodies.
- Never place runtime roots inside the source repository.
- Treat backups and evidence archives as sensitive even when encrypted.
- Keep audit bodies metadata-only.
- Enforce principal, AU/realm, project, and sensitivity isolation in every
  adapter, not only in the UI.
- Review every new socket-opening dependency as an egress change.
- Use synthetic fixtures for bug reports and compatibility tests.
- Run the repository and history scanners before distributing a modified copy.

## Delos composition

Delos calls Mnemosyne through the root contracts without making Mnemosyne a
Delos-internal namespace. Delos remains responsible for conversation surfaces,
provider routing, persona content, Current Situation, transcript evidence, and
host-side admission routing. Mnemosyne remains responsible for governed durable
memory, Anamnesis recall, Lethe lifecycle, curation/governance semantics,
portable retention vocabulary, decision durability, and rebuildable
projections.
