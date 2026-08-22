# Architecture

## Normative ontology

The names in this document describe ownership boundaries, not decorative
branding.

### Mnemosyne

Mnemosyne owns durable memory lifecycle. Its canonical truth is an append-only
event stream. Current cards, indexes, and search tables are projections that
must be rebuildable from events. Proposal, activation, confirmation, revision,
sealing, revocation, supersession, expiry, provenance, scope, sensitivity, and
retrieval permission remain orthogonal concepts.

### Anamnesis

Anamnesis executes recall. It receives a scene and a retrieval intent, applies
authority, lifecycle, AU/realm, sensitivity, conflict, expiry, and retrieval
gates, ranks eligible results, enforces budgets, and emits a structured
`MemoryReadPacket` plus metadata-only audit. It does not own lifecycle and does
not write memory.

### Lethe

Lethe is the domain meaning of no longer recalling something. Expiry,
revocation, supersession, and retrieval disablement remove material from recall
without rewriting the append-only history. Physical erasure is a separate,
explicitly authorized operation.

### Musagetes and the Muses

Musagetes composes multiple lenses rather than selecting one exclusive mode.
The canonical lenses are:

| Muse | Lens |
| --- | --- |
| Calliope | narrative, long-form work, AU and mythic continuity |
| Clio | history, provenance, evidence and continuity |
| Erato | love, desire and adult romantic intimacy |
| Euterpe | everyday voice, rhythm, warmth and conversation flow |
| Melpomene | distress, conflict, repair and dark aesthetics |
| Polyhymnia | ritual, sacredness, vows and identity authority |
| Terpsichore | embodiment, scene, gesture and motion |
| Thalia | play, humour, absurdity, teasing and memes |
| Urania | systems, abstraction, technical and academic reasoning |

Musagetes emits `RetrievalIntent` for Anamnesis and
`MemoryCandidateIntent` for Mnemosyne. Muse traces are evaluation evidence and
must never become a retrieval source or memory authority.

### Transcript Evidence Archive and Episode Projection

The Transcript Evidence Archive is append-only evidence, not memory. Episode
Projection is a versioned, rebuildable directory over that evidence. Episode
summaries are projections with source hashes and claim evidence; they do not
become Memory Cards automatically. Session/Scene state is a separate bounded
layer and is not owned by the Muses.

## Dependency direction

```text
Transcript evidence ─┐
Session/Scene state ─┼─> Musagetes + Muse lenses
Episode heads ───────┘          │
                       ┌────────┴────────┐
                       v                 v
              RetrievalIntent   MemoryCandidateIntent
                       │                 │
                       v                 v
                  Anamnesis         Mnemosyne ──> Lethe
                       ^                 │
                       └──── store/projections ───┘
```

## Stable sockets

Principals, authority policy, identity generation, decision models, transcript
evidence, storage, backup sources, clocks, transports, and surfaces are ports or
registries. A provider, account, model, surface, database engine, or identity is
an implementation choice rather than the product itself.

Low coupling does not mean fewer features. It means replacing one implementation
must not require rebuilding the rest of the personal system.
