# Mnemosyne

<!-- scan:allow-file private:principal private:principal_alias -->

[简体中文](README.zh-CN.md)

**Personal AI memory should be more than “find the old text that looks most similar.” Mnemosyne gives a memory provenance, lifetime, authority, scope, and history.**

If vector search answers “what from the past resembles this query?”, Mnemosyne focuses on a different set of questions: **Does this evidence deserve to become durable memory? Is it still true now? Which context does it belong to? Is it allowed to surface here? If the fact changes later, what happens to the old one?**

Mnemosyne is a local-first, model-neutral governed memory library. It was originally built for [Delos](https://github.com/Gwendolenmave/delos), but it can be embedded in other personal AI runtimes while the host continues to own the provider, persona, transport, UI, and deployment model.

## One end-to-end example is faster than a feature list

Imagine a human user named **Atalanta** and her assistant **Artemis** have been talking for several months.

### 1. A sentence begins as evidence, not memory

In an ordinary conversation, Atalanta says:

> “For long train trips, default to a window seat for me.”

That sentence first becomes transcript evidence. It proves that the sentence was said, but it does not become durable truth merely because it appeared in a conversation.

Retention can identify it as material worth considering for long-term admission. It still passes through a candidate / proposal step and then requires a **registered policy or explicit confirmation**. Only a governed write may create the durable lifecycle event that makes it part of the current memory projection.

### 2. A temporary exception does not silently rewrite a durable preference

A few weeks later, Atalanta says:

> “For this trip with my friend, use an aisle seat just this once.”

This is extremely similar to the original seat preference, but its lifetime is different. It may remain episodic / short-lived evidence without overwriting the durable default merely because an embedding considers the two sentences close.

### 3. A fictional-world fact stays visibly in its own realm

That evening she enters an AU called **Nocturne**:

> “In this world, Atalanta never sits by the window.”

This evidence belongs to another realm. If it is admitted as durable memory, Mnemosyne keeps that realm identity explicit instead of pretending it is an ordinary-world fact. An AU card may still be model-visible outside the active AU; it carries an explicit `[AU:…]` label, and an exact active-AU match is only an advisory ranking signal. Realm and sensitivity metadata do not silently grant or revoke retrieval permission.

That distinction matters when two memories use the same entities and even the same title. Reality and each AU remain separate conflict domains, so an AU fact does not suppress a reality fact merely because their wording overlaps.

### 4. A real long-term change updates current truth without erasing history

Two months later, back in ordinary conversation, Atalanta says:

> “I really changed my mind. From now on, default to an aisle seat.”

The new evidence goes through governance again. A revision / supersession can make “default to aisle” the current fact while the old window preference leaves ordinary recall.

The old fact is not rewritten into “it was never said.” It remains in append-only event history with its provenance, authority, and lifecycle transitions. The current view is only a projection folded from that history.

### 5. Recall asks “may this appear?” before it asks “how similar is it?”

The next week, in an ordinary scene, Artemis receives a request:

> “Which seat should I choose for Atalanta’s next train?”

Anamnesis removes genuinely ineligible material before ranking:

- the old “default to window” preference has been superseded;
- the one-trip aisle choice was a short-lived / episodic exception rather than a durable default;
- a card explicitly disabled for retrieval, revoked, expired, unapproved, or otherwise lifecycle-ineligible does not enter ranking;
- a Nocturne memory may remain visible, but it stays explicitly labelled as AU context rather than masquerading as reality.

The current reality preference is therefore “default to aisle”; if a relevant Nocturne card is also present in the packet, Artemis can see exactly which worldline it belongs to. **A high similarity score still cannot rescue an actually ineligible memory, while scene/realm/sensitivity metadata remain context instead of accidental access-control switches.**

That is the central difference between Mnemosyne and “put the chat log in a vector database.” Mnemosyne is not trying to preserve as much of the past as possible. It maintains **memory state that can change, be audited, and carry explicit context without falsifying history**.

## The actual path from conversation to recall

```text
transcript / structured host evidence
                 │
                 ├──> Episode Projection
                 │     (rebuildable evidence directory; no automatic memory authority)
                 │
                 ▼
        retention + candidate/proposal
                 │
                 ▼
      registered policy / confirmation
                 │
                 ▼
          Mnemosyne governance
                 │
                 ▼
       append-only memory events   <── canonical authority
                 │
                 ├──> current memory projection
                 └──> search / index projections
                      (all rebuildable)

scene + query + retrieval intent
                 │
                 ▼
             Anamnesis
                 │
                 ▼
 hard eligibility gates
 approval / lifecycle / expiry / retrieval permission /
 session lifetime / injection safety / conflict handling
                 │
                 ▼
          ranking + budget
   (realm / AU / sensitivity remain labelled;
    exact active-AU match may affect ranking)
                 │
                 ▼
          MemoryReadPacket
                 └──> metadata-only audit
```

Musagetes / Muses may help produce retrieval or candidate-writing intent, and decision automation may defer candidate processing or retry provider failures. None of them may bypass governance, and “the model thinks this should be remembered” never becomes durable authority by itself.

## Try it locally

Requires **Node.js 22.22 or newer**.

Install directly from GitHub:

```sh
npm install github:Gwendolenmave/mnemosyne
```

To run a complete governed write + recall without wiring a full assistant:

```sh
git clone https://github.com/Gwendolenmave/mnemosyne.git
cd mnemosyne
npm ci
npm run example:local
```

The example creates a temporary SQLite store, registers a synthetic policy, writes one governed memory, recalls it through Anamnesis, and removes the temporary data.

For full repository verification:

```sh
npm run verify
```

Normal package use requires Node and npm. Full repository verification also uses Python 3 for privacy scanning.

## Embed it in your runtime

The package exposes stable concepts from one ESM root entry point. Host integrations should prefer package-root namespaces rather than depending on the internal file layout.

```ts
import {
  Anamnesis,
  Retention,
  SqliteMnemosyne,
} from "@delos/mnemosyne";

const retention = Retention.dispatchPortableRetention({
  schemaVersion: 1,
  evidenceCodes: ["stable_preference"],
  auId: null,
});

const handle = SqliteMnemosyne.openMnemosyne("./local-state/mnemosyne.db");

const packet = Anamnesis.buildMemoryReadPacket({
  source: handle.store,
  query: "the current project milestone",
  scene: { mode: "ordinary", intimacyActive: false },
  nowIso: new Date().toISOString(),
});
```

This only shows the shape of the retention contract and read side. The complete governed write + recall example lives in [`examples/local-flow.ts`](examples/local-flow.ts). Read [Integration](docs/INTEGRATION.md) before connecting real evidence or a live transport.

## What the core pieces own

| Component | Responsibility |
| --- | --- |
| **Mnemosyne** | durable-memory write authority, lifecycle, and governance |
| **Anamnesis** | recall: eligibility first, then ranking / budget |
| **Lethe** | lets expired / revoked / superseded / retrieval-disabled material leave ordinary recall without pretending it never existed |
| **Retention** | distinguishes short-lived, episodic, and long-term-candidate material before ordinary long-term admission |
| **Curation** | formal KEEP / REVISE / REVOKE / RECLASSIFY_AU / SUPERSEDE / MERGE / EPISODIC_ONLY actions |
| **Episode Projection** | organizes evidence into rebuildable structures; summaries do not automatically become Memory Cards |
| **Musagetes / Muses** | describe continuity intent; they may shape intent but do not own durable-memory authority |
| **Memory event history** | canonical durable authority; current views and indexes are projections |

The Greek names are a responsibility map, not required lore. For ownership, dependency direction, and failure semantics, [Architecture](docs/ARCHITECTURE.md) is the normative contract.

## Five design rules that matter most

1. **Evidence ≠ memory.** Being said is not the same as being authorized as durable truth.
2. **History ≠ current truth.** An old fact may leave current memory without being erased from history.
3. **Eligibility comes before ranking.** An ineligible memory cannot recover by having a higher similarity score.
4. **Model proposal ≠ authority.** Automation may propose, queue, and retry; it may not grant durable truth to itself.
5. **Index ≠ authority.** Event history is canonical; projections and indexes must be rebuildable.

## What Mnemosyne deliberately does not own

Mnemosyne is a library / subsystem, not a complete chatbot platform. It does not own:

- the model provider or provider account;
- persona or system-prompt authority;
- transcript transport or UI;
- deployment principals, process supervision, or machine identity;
- backup destination, trusted clock, audit sink, or network policy.

Those belong to the host. Keeping that boundary explicit prevents the memory domain from becoming coupled to one Telegram bot, one machine, or one model account.

## Privacy and implementation status

The repository should contain source code, public documentation, schemas, and explicit synthetic fixtures only. Real memory databases, transcripts, queues, logs, backups, prompts, provider responses, credentials, account identifiers, and machine-specific paths belong outside the repository. See [Privacy model](docs/PRIVACY-MODEL.md) for the complete boundary.

The README explains the model. **For what is actually merged and verified today, use [Status](docs/STATUS.md).** Specification, source, tests, package state, releases, and live deployment are distinct states; the README does not present unmerged design work as available functionality.

## Documentation map

| I want to… | Read this |
| --- | --- |
| integrate Mnemosyne into a host runtime | [Integration](docs/INTEGRATION.md) |
| inspect current implementation coverage | [Status](docs/STATUS.md) |
| understand data and network boundaries | [Privacy model](docs/PRIVACY-MODEL.md) |
| change ownership / lifecycle / authority / dependencies | [Architecture](docs/ARCHITECTURE.md) |
| report a bug or security issue | [Contributing](CONTRIBUTING.md) / [Security](SECURITY.md) |

## Licence and maintenance

Mnemosyne uses the [PolyForm Noncommercial License 1.0.0](LICENSE.md). Personal use, study, modification, and noncommercial sharing are permitted under the licence; commercial use requires separate permission.

The licensor and maintainer is **Gwendolen** (`@Gwendolenmave` on GitHub). The project uses closed maintenance, while bug reports and responsible security reports remain welcome.