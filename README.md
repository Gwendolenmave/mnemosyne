# Mnemosyne

<!-- scan:allow-file private:principal private:principal_alias -->

[简体中文](README.zh-CN.md)

**Long-term memory that helps a personal AI remember the right thing, for the
right reason, at the right moment.**

Mnemosyne is the memory system built for [Delos](https://github.com/Gwendolenmave/delos).
It turns conversation evidence into durable, governed memory, keeps changing
facts in historical order, and recalls each memory only inside its proper
context.

It can remember preferences, relationships, project history, commitments,
ongoing stories, and long-running work while preserving where each memory came
from, who or what authorized it, how it changed, and when it should stay
silent. Mnemosyne is local-first, model-neutral, and usable as an independent
library in other personal AI runtimes.

## What Mnemosyne does

- **Turns evidence into governed memory.** A transcript message begins as
  evidence. Candidate memories keep source pointers and gain recall authority
  through an explicit policy or confirmation path.
- **Remembers change while preserving history.** Revisions, supersession,
  expiry, revocation, and retrieval disablement are separate lifecycle events.
- **Recalls for the present moment.** Scope, project, relationship, AU or
  realm, sensitivity, conflict, expiry, and token budget are checked before
  ranking.
- **Understands more than topics.** Nine Muse lenses describe the kind of
  continuity a moment needs: narrative, history, intimacy, everyday voice,
  repair, vows, embodiment, play, or systems reasoning.
- **Survives failure.** Durable authority is append-only; indexes and current
  views are rebuildable. Backup, restore proof, health checks, and recovery are
  part of the same system.
- **Keeps local data local.** The host owns its databases, providers,
  transcripts, policies, and secrets; Mnemosyne runs entirely inside that
  boundary.

## A memory's journey

Suppose a project meeting moves from Monday to Thursday.

```text
"The meeting is now on Thursday."
        │
        ▼
Transcript evidence keeps the exact source
        │
        ▼
A candidate records the proposed change
        │
        ▼
Owner confirmation or a registered policy authorizes it
        │
        ▼
The Thursday memory supersedes the Monday memory
        │
        ▼
Anamnesis recalls Thursday for the next relevant turn
```

Thursday becomes the current answer. Monday remains in the append-only history
with its source, former validity, and reason for supersession.

That distinction is the heart of Mnemosyne: **memory is evidence plus
authority, lifecycle, context, and recall rules.**

## Meet the nine Muses

Mnemosyne takes her name from the Greek goddess of memory and mother of the
nine Muses. The architecture follows that lineage: Mnemosyne governs the life
of memory, while her nine daughters illuminate the current moment from nine
different directions.

**Musagetes** is an epithet of Apollo meaning *leader of the Muses*—and a
deliberate echo of *Muse agents*. As their conductor, Musagetes composes every
active lens into two structured intentions:

- a `RetrievalIntent`, which tells Anamnesis what kind of memory the present
  turn needs; and
- a `MemoryCandidateIntent`, which tells the governed write path what may be
  worth considering for durable memory.

Several Muses may sing in the same turn. Musagetes writes the score; Mnemosyne
and the governance path retain authority over durable memory.

The names complete the Delian circle: Delos is Apollo's birthplace, so
Musagetes belongs naturally on the island; Mnemosyne and her daughters give
its memory system a family, a chorus, and a history.

| Muse | Her lens | What she protects |
| --- | --- | --- |
| **Calliope** | Narrative and long-form continuity | Story arcs, creative work, worldbuilding, and AU or realm continuity across many turns. |
| **Clio** | History and provenance | What happened, when it changed, which source supports it, and which version is current. |
| **Erato** | Love, desire, and intimacy | Relationship continuity and adult intimate context held inside its authorized scene. |
| **Euterpe** | Everyday voice and rhythm | The conversational cadence, warmth, habits, and ordinary texture that make an AI feel continuous from day to day. |
| **Melpomene** | Distress, conflict, and repair | Difficult moments, ruptures, consequences, and the repair that gives them their full history. |
| **Polyhymnia** | Ritual, vows, and identity authority | Commitments, sacred or constitutional boundaries, recurring rituals, and statements that define who someone or something is. |
| **Terpsichore** | Embodiment and motion | Gesture, position, physical continuity, and how a scene moves through space rather than becoming disconnected snapshots. |
| **Thalia** | Play and humour | Jokes, teasing, absurdity, memes, and the shared comic language that preserves their intended meaning. |
| **Urania** | Systems and abstraction | Technical work, academic reasoning, architecture, models, and the conceptual relationships that hold a complex project together. |

### How the Muses work together

A long-running fictional scene might activate **Calliope** for its narrative
arc, **Terpsichore** for physical continuity, and **Euterpe** for voice. If the
scene turns into playful reconciliation, **Thalia** and **Melpomene** can join
alongside the other lenses.

A technical project discussion may combine **Urania** for system structure,
**Clio** for provenance and version history, and **Polyhymnia** for a binding
design decision. Musagetes gives the moment a lead voice and supporting
harmony.

Muse traces expire as evaluation evidence. Durable memory retains the
user-facing evidence and leaves internal scoring behind.

## How the system fits together

```text
Transcript evidence ───────> Episode Projection (rebuildable)
          │                            │
          │                       episode heads
          │                            │
Current scene ─────────> nine Muses ───┘
                              │
                         Musagetes
                     ┌────────┴─────────┐
                     ▼                  ▼
             RetrievalIntent    MemoryCandidateIntent
                     │                  │
                     ▼                  ▼
                Anamnesis        durable decision queue
                     ▲                  │
                     │                  ▼
                     └─────────── Mnemosyne ─────> Lethe
                                          │
                                          ▼
                          append-only events + rebuildable views
```

- **Mnemosyne** owns durable memory and its lifecycle.
- **Anamnesis** recalls only memories eligible for the present turn.
- **Lethe** quiets obsolete or unauthorized memories while preserving their
  history; physical erasure follows its own authorized operation.
- **Episode Projection** organizes transcript evidence into rebuildable episode
  heads. Mnemosyne alone promotes eligible candidates into durable memory.
- **Musagetes and the Muses** understand the moment and produce intent. They do
  so under the confirmation and lifecycle authority of governance.

See [Architecture](docs/ARCHITECTURE.md) for the normative dependency rules.

## Install

Install directly from the public GitHub repository:

```sh
npm install github:Gwendolenmave/mnemosyne
```

Or install a downloaded release tarball:

```sh
npm install ./delos-mnemosyne-0.1.0-dev.0.tgz
```

Both routes install anonymously through an ordinary npm client and expose the
same ESM entry point and TypeScript declarations. The GitHub form builds from
source during installation; the release tarball already contains the prepared
JavaScript build.

## Try it locally

### Requirements

- Node.js **22.22 or newer**
- npm
- Python 3 only for the publication privacy scanner

From a source checkout:

```sh
npm ci
npm run example:local
```

The example creates a temporary SQLite memory authority, registers a synthetic
owner policy, writes one governed memory, retrieves it through Anamnesis, and
then removes the temporary data.

Expected application output:

```json
{"written":"ok","approval":"policy_activated","retrieved":1,"auditSelected":1}
```

Node 22 may also print its own `node:sqlite` experimental warning.

Run the complete local verification suite with:

```sh
npm run verify
```

## Use Mnemosyne from another runtime

Mnemosyne ships as a memory library. A host supplies its model provider,
transcript evidence, clock, transport, backup destination, audit sink, and
deployment policy through explicit ports.

After building and linking the package in a local workspace:

```ts
import {
  Anamnesis,
  Governance,
  SqliteMnemosyne,
} from "@delos/mnemosyne";

const handle = SqliteMnemosyne.openMnemosyne("./local-state/mnemosyne.db");

const governance = new Governance.MnemosyneGovernanceService({
  store: handle.store,
  backup: (label) => createVerifiedBackup(label),
  audit: (metadata) => writeMetadataOnlyAudit(metadata),
});

const packet = Anamnesis.buildMemoryReadPacket({
  source: handle.store,
  query: "the current project milestone",
  scene: { mode: "ordinary", intimacyActive: false },
  nowIso: new Date().toISOString(),
});
```

The backup and audit functions are deliberately host-owned. The complete
runnable write-and-read example is
[`examples/local-flow.ts`](examples/local-flow.ts). Read the
[integration guide](docs/INTEGRATION.md) before connecting live evidence or a
real transport.

## Memory lifecycle

```text
evidence
  -> candidate
  -> proposed
  -> policy_activated or confirmed
  -> revised / sealed / retrieval-disabled / expiry-set
  -> superseded or revoked
  -> optional separately-authorized physical erasure
```

These states deliberately remain separate:

- `policy_activated` records a standing owner policy as the authority for the
  write; per-memory human confirmation remains a distinct state.
- `sealed` reserves mutation for owner-controlled paths.
- expired, revoked, superseded, and retrieval-disabled memories remain in
  history while disappearing from normal recall.
- sensitivity, scope, provenance, approval, and lifecycle are independent
  axes; their eligibility gates remain authoritative even at high similarity.

## What is included

| Area | Included |
| --- | --- |
| Governed memory | Proposals, policy activation, confirmation, revision, sealing, expiry, revocation, supersession, provenance, and owner control |
| Recall | Eligibility gates, trust ranking, conflict handling, budgets, packet rendering, and metadata-only audit |
| Muses | Musagetes, all nine non-exclusive lenses, scene-aware intent, and trace exclusion |
| Persistence | SQLite append-only event log, atomic migrations, current projections, full-text search, and integrity checks |
| Automation | Durable no-drop decision backlog, evidence reread, idempotency, retry, budgets, and circuit breaking |
| Episodes | Deterministic segmentation, chunking, source hashes, claim validation, and AU or realm separation |
| Operations | Encrypted backup, isolated restore proof, retention, deletion safety, health, reliability, and recovery choices |
| Integration | Provider-neutral ports, deployment principal registry, Telegram governance adapter, and standalone local flow |

The [status matrix](docs/STATUS.md) links each capability to its implementation
and synthetic tests.

## Privacy by design

Runtime memory stays with the person running the host application, inside the
host's own storage and provider boundary.

The tracked repository contains source, public documentation, schemas, and
unmistakably synthetic fixtures. Runtime-only material stays with the host:

- memory databases, transcripts, queues, traces, logs, and backups;
- prompts, persona corpora, provider responses, credentials, and keys;
- principals, accounts, policies, conversation identifiers, and machine paths;
- fixtures derived from private conversations, even after superficial edits.

Provider access enters through host-supplied adapters at the edge of the
memory, episode, governance, and retrieval core. See the [privacy model](docs/PRIVACY-MODEL.md)
and [public extraction manifest](docs/PUBLIC-EXTRACTION-MANIFEST.md).

## Project documentation

| Document | Start here when you want to... |
| --- | --- |
| [Architecture](docs/ARCHITECTURE.md) | understand ownership and dependency boundaries |
| [Integration](docs/INTEGRATION.md) | connect Mnemosyne to a host runtime |
| [Privacy model](docs/PRIVACY-MODEL.md) | inspect repository, runtime, audit, and network boundaries |
| [Status](docs/STATUS.md) | see implementation and test evidence by capability |
| [Public extraction manifest](docs/PUBLIC-EXTRACTION-MANIFEST.md) | audit what was preserved and what private material was excluded |
| [Provenance](docs/PROVENANCE.md) | inspect how the privacy-clean public history was constructed |
| [Independent comparison](docs/INDEPENDENT-COMPARISON.md) | read the post-hoc project-comparison boundary |
| [Publication checklist](docs/PUBLICATION-CHECKLIST.md) | prepare a source release while keeping privacy gates intact |

## Project status

This repository contains Mnemosyne's **complete source implementation**:
TypeScript source, tests, publication tools, documentation, and the full
architecture described above. It can be built locally, installed directly
from GitHub, or distributed as a release tarball.

Every architecture layer described above is present in this edition. See
[Final verification](docs/FINAL-VERIFICATION.md) for the current acceptance
evidence.

## Licence

Mnemosyne is source-available under the
[PolyForm Noncommercial License 1.0.0](LICENSE). Personal use, study,
modification, and noncommercial sharing are permitted under the licence.
Commercial use requires separate permission. PolyForm Noncommercial is a
source-available licence rather than an OSI-approved open-source licence;
[licence notes](LICENSE-NOTES.md) explain the boundary in plain language while
the official terms remain authoritative.

The licensor and maintainer is **Gwendolen** (`@Gwendolenmave` on GitHub). <!-- scan:allow private:principal private:principal_alias -->

The project uses closed maintenance, with substantive external code
contributions currently closed. Bug reports and responsible security reports
remain welcome; see [Contributing](CONTRIBUTING.md) and [Security](SECURITY.md).
