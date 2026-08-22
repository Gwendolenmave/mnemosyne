# Mnemosyne

<!-- scan:allow-file private:principal private:principal_alias -->

[简体中文](README.zh-CN.md)

**Long-term memory that helps a personal AI remember the right thing, for the right reason, at the right moment.**

Mnemosyne is the governed long-term memory system built for [Delos](https://github.com/Gwendolenmave/delos). It turns conversation evidence into durable memory, preserves how facts change over time, and recalls each memory only inside the context where it is eligible.

Mnemosyne is local-first, model-neutral, and can also be embedded in other personal AI runtimes.

## What Mnemosyne does

- **Governed memory writes.** Evidence becomes durable memory only through an explicit confirmation or policy path.
- **Historical truth.** Revision, supersession, expiry, revocation, sealing, and retrieval disablement remain distinct lifecycle events instead of overwriting the past.
- **Context-aware recall.** Scope, relationship or project context, AU/realm, sensitivity, conflict, expiry, and token budget are checked before ranking.
- **Durable recovery.** The canonical memory history is append-only; rebuildable views, backups, restore checks, and health checks sit around it.
- **Host-owned privacy.** Databases, transcripts, providers, policies, credentials, and backups remain under the host application's control.

## Architecture

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

Mnemosyne owns durable memory lifecycle. Anamnesis performs eligible recall. Lethe quiets obsolete or unauthorized memories without erasing their history. Musagetes and the nine Muse lenses describe what kind of continuity the current moment needs while governance keeps durable authority.

See [Architecture](docs/ARCHITECTURE.md) for the dependency and ownership rules.

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

## Try it locally

From a source checkout:

```sh
npm ci
npm run example:local
```

The example creates a temporary SQLite store, registers a synthetic owner policy, writes one governed memory, recalls it through Anamnesis, and removes the temporary data.

Run the complete repository verification suite with:

```sh
npm run verify
```

Normal use requires Node and npm. The full repository verification suite additionally uses Python 3 for its privacy checks.

## Use Mnemosyne from another runtime

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

Backup, audit, transport, provider, and deployment policy remain host-owned. A complete runnable write-and-read example is in [`examples/local-flow.ts`](examples/local-flow.ts). Read the [integration guide](docs/INTEGRATION.md) before connecting real evidence or a live transport.

## Privacy

The repository contains source code, public documentation, schemas, and synthetic fixtures. Runtime-only material stays outside the repository, including:

- memory databases, transcripts, queues, traces, logs, and backups;
- prompts, persona corpora, provider responses, credentials, and keys;
- deployment principals, real account identifiers, policies, conversation identifiers, and machine paths;
- fixtures derived from private conversations.

See [Privacy model](docs/PRIVACY-MODEL.md) for the runtime and network boundaries.

## Documentation

| Document | Use it for |
| --- | --- |
| [Architecture](docs/ARCHITECTURE.md) | ownership, authority, and dependency boundaries |
| [Integration](docs/INTEGRATION.md) | connecting Mnemosyne to a host runtime |
| [Privacy model](docs/PRIVACY-MODEL.md) | repository, runtime, audit, and network boundaries |
| [Status](docs/STATUS.md) | implemented capabilities and their test coverage |

## Licence

Mnemosyne is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE). Personal use, study, modification, and noncommercial sharing are permitted under the licence; commercial use requires separate permission. [Licence notes](LICENSE-NOTES.md) explain the boundary in plain language.

The licensor and maintainer is **Gwendolen** (`@Gwendolenmave` on GitHub).

The project uses closed maintenance. Bug reports and responsible security reports remain welcome; see [Contributing](CONTRIBUTING.md) and [Security](SECURITY.md).
