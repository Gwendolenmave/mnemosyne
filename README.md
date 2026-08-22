# Mnemosyne

<!-- scan:allow-file private:principal private:principal_alias -->

[简体中文](README.zh-CN.md)

**Long-term memory for personal AI that remembers the right thing, for the right reason, at the right moment.**

Most “AI memory” demos solve one problem: *find something similar to the current message*. Real long-term memory has harder problems.

What if an old fact is no longer true? What if a memory belongs only to one project or fictional universe? What if something was mentioned but never authorized as a durable fact? What if the system remembers the right sentence in the wrong relationship or scene?

Mnemosyne is built around those questions.

| The problem | Mnemosyne's answer | Why it matters |
| --- | --- | --- |
| A vector store keeps old and new facts side by side | **Lifecycle + supersession** | “Monday” can remain historical evidence after “Thursday” becomes current truth |
| Similarity alone recalls things in the wrong context | **Eligibility gates before ranking** | Scope, project, relationship, AU/realm, sensitivity, expiry, and authority decide whether a memory may appear at all |
| “The AI saw it” quietly becomes “the AI decided it is true” | **Governed writes** | Evidence, proposal, policy activation, confirmation, and durable memory remain different states |
| Debugging memory means guessing why something surfaced | **Provenance + metadata-only audit** | A recall can be traced back to source and decision path without turning logs into a second memory store |
| Index corruption turns into memory loss | **Append-only authority + rebuildable projections** | Current views and search indexes can be rebuilt from durable events |
| Memory logic gets welded to one chatbot or model vendor | **Host-owned ports** | Mnemosyne can sit inside Delos or another runtime without owning the provider, transport, persona, or UI |

Mnemosyne was built for [Delos](https://github.com/Gwendolenmave/delos), but it is a model-neutral library and can be embedded in other personal AI runtimes.

## A memory's journey

Suppose a project meeting used to be on Monday and is now on Thursday.

```text
“The meeting is now on Thursday.”
        │
        ▼
Transcript evidence keeps the source
        │
        ▼
A candidate proposes a durable fact
        │
        ▼
A confirmation or registered policy authorizes it
        │
        ▼
Thursday supersedes Monday as current truth
        │
        ▼
Anamnesis recalls Thursday in the next eligible context
```

Monday is not erased. It remains historical evidence with its former validity and the reason it stopped being current.

That is the core idea: **memory is not just text plus similarity; it is evidence plus authority, lifecycle, context, and recall rules.**

## The names are architecture, not decoration

Mnemosyne takes her name from the Greek goddess of memory and mother of the nine Muses. The system uses that family as a map of responsibilities:

- **Mnemosyne** owns durable memory and its lifecycle.
- **Anamnesis** performs recall: it decides which memories are eligible *now* and then ranks them.
- **Lethe** describes memories that should no longer surface normally — expired, revoked, superseded, or retrieval-disabled — without pretending history never happened.
- **Musagetes** combines the active Muse lenses into retrieval and candidate-writing intent.
- **The Muses** describe what kind of continuity the current moment needs: narrative, history, intimacy, everyday voice, repair, vows, embodiment, play, or systems reasoning.

```text
Transcript evidence ───────> Episode Projection
          │                         │
Current scene ─────────> Muses ─────┘
                            │
                       Musagetes
                    ┌───────┴────────┐
                    ▼                ▼
            RetrievalIntent   MemoryCandidateIntent
                    │                │
                    ▼                ▼
               Anamnesis      governed decision path
                    ▲                │
                    └──────── Mnemosyne ─────> Lethe
                                      │
                                      ▼
                         append-only events + views
```

If you are changing implementation boundaries, treat [Architecture](docs/ARCHITECTURE.md) as the normative contract. The README is the map for humans; Architecture is the contract for agents and maintainers.

## Install

Requires **Node.js 22.22 or newer**.

Install directly from GitHub:

```sh
npm install github:Gwendolenmave/mnemosyne
```

Or install a release tarball:

```sh
npm install ./delos-mnemosyne-0.1.0-dev.0.tgz
```

Both expose the same ESM package entry point and TypeScript declarations.

## Try it without wiring a whole assistant

From a source checkout:

```sh
npm ci
npm run example:local
```

The example creates a temporary SQLite store, registers a synthetic owner policy, writes one governed memory, recalls it through Anamnesis, and removes the temporary data again.

Run the full repository verification suite with:

```sh
npm run verify
```

Normal use requires Node and npm. Full repository verification additionally uses Python 3 for privacy checks.

## Embed it in another runtime

Mnemosyne deliberately does **not** own your model provider, transcript transport, clock, backup destination, audit sink, or deployment policy. The host supplies those boundaries.

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

A complete runnable write-and-read example is in [`examples/local-flow.ts`](examples/local-flow.ts). Read [Integration](docs/INTEGRATION.md) before connecting real evidence or a live transport.

## Privacy: the host owns the real data

The public repository contains source code, public documentation, schemas, and synthetic fixtures. Runtime material stays outside the repository, including:

- memory databases, transcripts, queues, traces, logs, and backups;
- prompts, persona corpora, provider responses, credentials, and keys;
- deployment principals, real account identifiers, policies, conversation identifiers, and machine paths;
- fixtures derived from private conversations.

See [Privacy model](docs/PRIVACY-MODEL.md) for repository, runtime, audit, and network boundaries.

## Documentation

| Document | What problem it answers |
| --- | --- |
| [Architecture](docs/ARCHITECTURE.md) | rules for agents/maintainers changing ownership, authority, or dependency boundaries |
| [Integration](docs/INTEGRATION.md) | how a host runtime supplies evidence, storage, policy, and transport boundaries |
| [Privacy model](docs/PRIVACY-MODEL.md) | what stays in the host and what may cross the network |
| [Status](docs/STATUS.md) | which capabilities are implemented and where their tests live |
| [Licensing notes](docs/LICENSING.md) | the licensing boundary in plain language |

## Licence and maintenance

Mnemosyne uses the [PolyForm Noncommercial License 1.0.0](LICENSE.md). Personal use, study, modification, and noncommercial sharing are permitted under the licence; commercial use requires separate permission. [Licensing notes](docs/LICENSING.md) explain the boundary in plain language.

The licensor and maintainer is **Gwendolen** (`@Gwendolenmave` on GitHub).

The project uses closed maintenance. Bug reports and responsible security reports remain welcome; see [Contributing](CONTRIBUTING.md) and [Security](SECURITY.md).
