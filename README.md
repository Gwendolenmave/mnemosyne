# Mnemosyne

<!-- scan:allow-file private:principal private:principal_alias -->

[简体中文](README.zh-CN.md)

**Long-term memory for personal AI, with rules about what may be remembered and when it may return.**

Mnemosyne is for the part that a vector store does not solve by itself.

Finding similar text is useful. But long-term memory also has to answer harder questions: Is this fact still current? Was it ever authorized as durable memory? Does it belong to this project, relationship, or fictional world? Is it allowed to appear in this scene? If two memories conflict, which one is current truth and which one is history?

Mnemosyne keeps those questions separate instead of hiding them inside one similarity score.

## Start here

| I want to… | Start with |
| --- | --- |
| understand the idea quickly | [The 60-second model](#the-60-second-model) |
| try it on my machine | [Try it locally](#try-it-locally) |
| embed it in another runtime | [Integration](docs/INTEGRATION.md) |
| understand what is implemented today | [Status](docs/STATUS.md) |
| understand the privacy boundary | [Privacy model](docs/PRIVACY-MODEL.md) |
| modify Mnemosyne itself | **read [Architecture](docs/ARCHITECTURE.md) first** |

Mnemosyne was built for [Delos](https://github.com/Gwendolenmave/delos), but the package is model-neutral and can be embedded in another personal AI runtime.

## The 60-second model

Suppose a project meeting used to be on Monday and is now on Thursday.

A simple vector store may keep both sentences and return whichever looks more similar to the current query. Mnemosyne instead treats the change as a lifecycle event:

```text
“Meeting is on Monday.”
        │
        │ later
        ▼
“Meeting is now on Thursday.”
        │
        ▼
source evidence is preserved
        │
        ▼
a governed decision makes Thursday current
        │
        ▼
Monday remains history; Thursday is eligible as current truth
```

Nothing needs to pretend Monday was never said. The important distinction is that **historical evidence and current memory are not the same thing**.

That one example captures most of the design:

- **Evidence is not automatically memory.** Something being present in a transcript does not make it durable truth.
- **Eligibility comes before ranking.** Scope, lifecycle, authority, sensitivity, expiry, relationship/project/AU boundaries, and retrieval permission decide whether a memory may appear at all.
- **Old facts can be superseded instead of erased.** History remains inspectable while current truth changes.
- **Indexes are rebuildable.** Durable event history is authority; current views and search projections are derived state.
- **The host stays in charge.** Mnemosyne does not own your model provider, persona, transport, UI, or deployment identity.

## Try it locally

Requires **Node.js 22.22 or newer**.

Install directly from GitHub:

```sh
npm install github:Gwendolenmave/mnemosyne
```

To see a complete write-and-recall flow without wiring a whole assistant, clone the repository and run:

```sh
npm ci
npm run example:local
```

The example creates a temporary SQLite store, registers a synthetic policy, writes one governed memory, recalls it through Anamnesis, and removes the temporary data again.

For repository verification:

```sh
npm run verify
```

Normal package use requires Node and npm. Full repository verification also uses Python 3 for privacy checks.

## Put it inside a host runtime

Mnemosyne deliberately does **not** own your provider, transcript transport, clock, backup destination, audit sink, or deployment policy. The host supplies those boundaries.

The package exposes the storage, governance, recall, decision, and automation building blocks from one ESM entry point:

```ts
import {
  Anamnesis,
  SqliteMnemosyne,
} from "@delos/mnemosyne";

const handle = SqliteMnemosyne.openMnemosyne("./local-state/mnemosyne.db");

const packet = Anamnesis.buildMemoryReadPacket({
  source: handle.store,
  query: "the current project milestone",
  scene: { mode: "ordinary", intimacyActive: false },
  nowIso: new Date().toISOString(),
});
```

That snippet only shows the shape of the read side. A complete governed write-and-read example lives in [`examples/local-flow.ts`](examples/local-flow.ts). Read [Integration](docs/INTEGRATION.md) before connecting real evidence or a live transport.

## What the names mean

The Greek names are a responsibility map, not something you need to memorize before using the package.

| Name | Responsibility |
| --- | --- |
| **Mnemosyne** | durable memory lifecycle and governance |
| **Anamnesis** | recall: filter for eligibility, then rank and budget |
| **Lethe** | material that should no longer surface normally, without pretending history never happened |
| **Musagetes** | combines active continuity lenses into retrieval and candidate-writing intent |
| **Muses** | describe what kind of continuity the current moment needs |

If you are changing those boundaries, use [Architecture](docs/ARCHITECTURE.md) as the normative contract rather than inferring behavior from the mythology.

## What Mnemosyne does — and does not do

Mnemosyne **does** provide:

- governed memory writes with provenance and policy/confirmation boundaries;
- lifecycle operations such as revision, expiry, revocation, supersession, retrieval disablement, and authorized deletion flow;
- recall that filters for eligibility before similarity/ranking;
- append-only event authority with rebuildable current views and indexes;
- metadata-only audit paths so diagnostics do not become a second hidden memory store.

Mnemosyne **does not** provide:

- a chatbot UI or hosted service;
- a model provider or model account;
- a persona system;
- ownership of your transcripts or deployment identity;
- permission to promote arbitrary model output or transcript text into durable truth.

## Privacy: the host owns the real data

The public repository contains source code, public documentation, schemas, and synthetic fixtures. Real runtime material belongs outside the repository, including memory databases, transcripts, queues, logs, backups, prompts, provider responses, credentials, account identifiers, and machine-specific paths.

Network behavior also belongs to the host boundary: Mnemosyne itself is a library, not a cloud service. See [Privacy model](docs/PRIVACY-MODEL.md) for the repository/runtime/network split.

## If you are changing the code

README is the human map. [Architecture](docs/ARCHITECTURE.md) is the normative contract for agents and maintainers.

The next documents are deliberately few:

- **embed Mnemosyne:** [Integration](docs/INTEGRATION.md)
- **check implementation coverage:** [Status](docs/STATUS.md)
- **check repository/runtime/network boundaries:** [Privacy model](docs/PRIVACY-MODEL.md)
- **change ownership, authority, lifecycle, or dependency rules:** [Architecture](docs/ARCHITECTURE.md)

When implementation and Architecture disagree, inspect the current code and tests instead of guessing which prose was intended.

## Licence and maintenance

Mnemosyne uses the [PolyForm Noncommercial License 1.0.0](LICENSE.md). Personal use, study, modification, and noncommercial sharing are permitted under the licence; commercial use requires separate permission.

The licensor and maintainer is **Gwendolen** (`@Gwendolenmave` on GitHub).

The project uses closed maintenance. Bug reports and responsible security reports remain welcome; see [Contributing](CONTRIBUTING.md) and [Security](SECURITY.md).
