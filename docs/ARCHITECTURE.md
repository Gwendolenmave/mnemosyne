# Mnemosyne architecture contract

This document is written for **agents and maintainers changing Mnemosyne**. It is normative. README files explain the system to people; this file defines ownership, authority, dependency direction, canonical state, and the places where changes belong.

When code and this document disagree, do not guess. Inspect the implementation and tests, then update whichever side is stale as part of the same change.

## 1. The system in one sentence

**Mnemosyne turns evidence into governed durable memory, preserves memory history as append-only authority, and recalls only memories that are eligible for the current context.**

Similarity is never sufficient authority to write or recall a memory.

## 2. Canonical truth

The durable source of truth is the **memory event history**, not a current-row table, search index, vector score, episode summary, Muse trace, or provider transcript cache.

### MUST

- Durable lifecycle changes are represented as events.
- Current cards/views/indexes are projections and must be rebuildable from durable events.
- Provenance, approval, lifecycle, scope, sensitivity, retrieval permission, expiry, and supersession remain distinct dimensions.
- Physical erasure is an explicitly authorized operation separate from normal lifecycle state.

### MUST NOT

- Do not overwrite history merely to make the current view simpler.
- Do not treat search/index state as canonical memory authority.
- Do not promote transcript text, episode summaries, Muse traces, or model output directly into durable memory without the governed write path.

Key implementation areas:

- domain: `core/domain/memory.ts`, `core/domain/mnemosyne.ts`, validation/fold modules;
- event contract: `core/ports/memory-event-log.ts`;
- SQLite event authority: `adapters/memory/sqlite/sqlite-memory-event-log.ts`;
- projections/store: `adapters/memory/sqlite/mnemosyne-store.ts` and related facade/seed modules.

## 3. Ownership map

The names below describe **responsibility**, not decorative branding.

### Mnemosyne

Owns durable memory lifecycle and governance. The main governance service is `core/services/mnemosyne-governance.ts`.

It owns transitions such as proposal, policy activation, confirmation, revision, sealing, expiry, revocation, supersession, retrieval disablement, and authorized deletion flow.

It does **not** own the host's provider, persona, transport, transcript UI, or deployment identity.

### Anamnesis

Owns recall. The core implementation is `core/services/anamnesis.ts`.

It receives query/context inputs, applies eligibility gates, ranks eligible memories, enforces budgets, and returns a structured read packet plus metadata-only audit information.

It does **not** write memory or change lifecycle state.

### Lethe

Represents “this memory should no longer appear in ordinary recall”. Expired, revoked, superseded, and retrieval-disabled material may disappear from normal recall while remaining in durable history.

Lethe is not permission to erase history. Physical deletion uses its own authorized path (`core/services/deletion-core.ts` and related domain rules).

### Musagetes and the Muses

`core/services/musagetes.ts` composes multiple active lenses rather than selecting one exclusive mode.

Muse lenses describe the kind of continuity the current moment needs. Their traces are evaluation/intent evidence, not durable memory authority and not a retrieval source.

Musagetes may emit retrieval/candidate intent. It may not bypass governance.

### Transcript Evidence Archive

Transcript evidence is **evidence**, not memory. Transcript adapters live under `adapters/transcripts/`.

A transcript proves what was said or observed. It does not, by itself, prove that the content is current, authorized, globally scoped, or suitable for recall.

### Episode Projection

Episode code lives across `core/domain/episode*`, `core/services/episode-*`, and `adapters/projections/`.

Episodes organize transcript evidence into rebuildable structures. Episode summaries retain source relationships and validation rules. They do not automatically become durable Memory Cards.

## 4. Dependency direction

Use this direction unless a stricter rule below applies:

```text
host evidence / scene / policy
            │
            ▼
     intent + governance edge
       ┌───────────────┐
       ▼               ▼
  Anamnesis        Mnemosyne
   (read)           (write/lifecycle)
       │               │
       └──────┬────────┘
              ▼
      ports + domain rules
              ▲
              │
      concrete adapters
```

Concrete storage, transcript, platform, Telegram, scheduler, backup, and provider implementations belong under `adapters/`.

Core domain/services may depend on ports and domain types. They must not depend on a concrete SQLite schema, Telegram state shape, machine path, provider account, or deployment-specific credential.

## 5. Read path: recall

Conceptually:

```text
query + scene + retrieval intent
              │
              ▼
     hard eligibility gates
(approval / lifecycle / expiry / retrieval permission /
 session lifetime / injection safety / conflict handling)
              │
              ▼
        ranking + budget
(scene / realm / AU / sensitivity remain model-visible context;
 exact active-AU matches may receive a deterministic ranking boost)
              │
              ▼
       MemoryReadPacket
              │
              └──> metadata-only audit
```

Rules:

1. **Eligibility precedes ranking.** A high similarity score cannot rescue an actually ineligible memory.
2. Unapproved, expired, revoked, superseded, explicitly retrieval-disabled, session-only, injection-unsafe, or unresolved same-realm conflict material must not enter ordinary ranking.
3. **Scene, AU/realm, project/relationship scope labels, and sensitivity are context metadata, not implicit retrieval permissions.** They remain visible in the packet; an exact current-AU match may influence ranking, but a scene mismatch does not silently erase an otherwise governed active card.
4. Reality and each explicit AU are distinct conflict domains. Same-title memories across different realms remain separately labelled rather than suppressing one another as a false conflict.
5. Audit output must remain metadata-only and must not become a second durable memory body store.
6. Recall must not mutate lifecycle state as a side effect.

Primary implementation: `core/services/anamnesis.ts`.

## 6. Write path: evidence to durable memory

Conceptually:

```text
transcript / host evidence
          │
          ▼
  candidate / proposal
          │
          ▼
registered policy OR explicit confirmation
          │
          ▼
    governed lifecycle event
          │
          ▼
 append-only event authority
          │
          ▼
 rebuildable current projections
```

Rules:

1. Evidence is not automatically memory.
2. A model suggestion is not durable authority.
3. Proposal generation and policy/confirmation are separate steps.
4. Durable write authority must be attributable to an explicit confirmation or registered policy path.
5. Repeated processing must be idempotent where the decision/backlog contract requires it.
6. A failed write must not be reported as success.

Relevant implementation areas:

- governance: `core/services/mnemosyne-governance.ts`;
- proposal sink: `core/services/companion-proposal-sink.ts`;
- automation adapters: `adapters/automation/companion-proposals.ts`, `decision-backlog.ts`, `decision-worker.ts`.

## 7. Decision automation

The decision queue exists so candidate processing can survive retries, restarts, and temporary provider failures without silently dropping work or granting chat direct durable-write authority.

Rules:

- Queue/backlog state is operational state, not memory authority.
- Decision models/providers propose decisions; they do not become owner authority.
- Retry, budget, idempotency, and circuit-breaking behavior must remain explicit.
- Evidence must be re-readable or reconstructable from stable references when a delayed decision runs.
- Automation must not silently fall back to an unrelated chat provider/persona if a dedicated decision configuration is required.

See `adapters/automation/` and `core/services/backlog-progress.ts`.

## 8. Episode path

Episode Projection is a rebuildable directory over evidence.

Rules:

- Preserve source hashes/references needed to validate summaries and claims.
- Deterministic segmentation/normalization rules belong in the episode core/services, not in UI adapters.
- Episode summaries do not acquire durable memory authority merely by being useful.
- Scene/AU/realm separation must be preserved through episode construction.

Key areas: `core/domain/episode*.ts`, `core/services/episode-*.ts`, `adapters/projections/`.

## 9. Host-owned boundaries

Mnemosyne is a library/subsystem. The host owns the outside world.

Host-owned concerns include:

- model/provider selection;
- transcript acquisition/transport;
- persona/system authority;
- deployment principals and account identity;
- real clock/trusted-time source;
- backup destination and filesystem policy;
- audit sink;
- UI/surface behavior;
- process supervision and deployment policy.

Mnemosyne exposes ports/contracts for these concerns where needed. Do not pull host-specific identity or network policy into durable memory domain types.

## 10. Stable sockets and concrete adapters

Current examples:

| Concern | Contract / core | Concrete implementation area |
| --- | --- | --- |
| Memory event authority | `core/ports/memory-event-log.ts` | `adapters/memory/sqlite/` |
| Memory store/read projection | `core/ports/memory-store.ts` | `adapters/memory/sqlite/` |
| Model/decision provider edge | `core/ports/model-provider.ts` | host-supplied adapter/config |
| Episode summarization | `core/ports/episode-summarizer.ts` | deterministic/provider-backed implementations |
| Backup/filesystem | backup/filesystem ports | `adapters/platform/`, runtime backup adapters |
| Transcript evidence | transcript-facing contracts/services | `adapters/transcripts/` |
| Governance transport UI | governance service/domain | `adapters/telegram/` is one transport adapter |

A concrete adapter may be replaced. The domain meaning it implements must not silently change with it.

## 11. Package boundary

`index.ts` is the public package entry surface.

Rules:

- Public exports should expose stable concepts, not accidental internal file layout.
- Host integrations should prefer package exports over deep-importing private implementation paths.
- Adding a public export creates compatibility obligations; do it deliberately.
- Removing/renaming a public export requires explicit compatibility handling and tests.

## 12. Failure semantics

Truthfulness is a system property.

### MUST

- Report write/read/backup/recovery success only after the corresponding operation completed.
- Preserve enough durable evidence to distinguish “not attempted”, “refused”, “failed”, and “succeeded”.
- Treat authority/policy/configuration failures as failures, not as permission to widen access.
- Keep backup/restore verification separate from merely creating a file.

### MUST NOT

- Do not fabricate health from process liveness alone.
- Do not silently skip governance because a provider or adapter is unavailable.
- Do not treat projection availability as proof that canonical history is healthy.

## 13. How to make common changes

### Add a storage backend

1. Implement the relevant memory event/store ports.
2. Preserve append-only canonical semantics and projection rebuildability.
3. Keep storage schema details inside the adapter.
4. Add parity tests against lifecycle/recall contracts.
5. Do not change governance semantics just to fit the storage engine.

### Change recall behavior

1. Start in `core/services/anamnesis.ts` and related domain validation/ranking rules.
2. Preserve “eligibility before ranking”.
3. Add tests for both positive recall and forbidden leakage.
4. Do not solve recall bugs by mutating durable history.

### Change write/governance behavior

1. Start in `core/services/mnemosyne-governance.ts` and domain transition rules.
2. Identify the authority source for every new transition.
3. Preserve evidence/proposal/confirmation/policy separation.
4. Add idempotency and refusal-path tests where relevant.

### Add an episode feature

1. Keep transcript evidence as source authority.
2. Put deterministic rules in core/domain/services.
3. Keep persistence/index details in adapters/projections.
4. Do not auto-promote summaries into Memory Cards.

### Add a host integration

1. Use package exports/ports.
2. Keep provider/persona/transport/deployment identity in the host.
3. Define startup readiness and failure behavior explicitly.
4. Verify the host does not accidentally turn recalled memory into system/persona authority.

## 14. Agent acceptance checklist

Before finishing a structural change, answer all of these with evidence:

- Is the append-only memory event history still the durable authority?
- Can current projections/indexes still be rebuilt?
- Did any transcript, episode summary, Muse trace, or model output gain durable authority implicitly?
- Does recall still apply eligibility gates before ranking?
- Are scope/AU/realm/sensitivity labels preserved without silently becoming implicit retrieval permissions?
- Is every durable write attributable to confirmation or registered policy authority?
- Did a host-specific provider, account, machine path, surface, or credential leak into core domain state?
- Are failure/refusal/success states still truthful and distinguishable?
- Did a public package export change? If yes, is compatibility handled?
- Do tests cover forbidden leakage and refusal paths, not only happy paths?
- Did this architecture document change if the actual ownership/dependency rules changed?

If any answer is uncertain, the task is not finished.
