# Mnemosyne Public project profile

## Product intent

Build a complete, privacy-clean public Mnemosyne that can run independently or
be called by Delos. Do not reduce features or flatten architectural layers to
make an early release easier.

## Non-negotiable architecture

- Preserve Mnemosyne, Anamnesis, Lethe, Musagetes, and all nine Muse names and
  responsibilities.
- Preserve append-only authority, rebuildable projections, source provenance,
  AU/realm and sensitivity isolation, candidate governance, policy activation,
  durable backlog, Episode Projection, backup, restore, and health.
- Generalize private principals, policy instances, providers, transports, and
  deployment paths through ports and registries.
- Muse traces are never memory or retrieval inputs.

## Privacy

No real memory, transcript, trace, prompt, identity, policy instance, secret,
machine path, or conversation-derived fixture may enter the repository.

## Public documentation and licence

- Normative project documentation is English.
- `README.md` links to the single Simplified Chinese translation,
  `README.zh-CN.md`.
- Use the same official PolyForm Noncommercial License 1.0.0 bytes and the same
  source-available / non-OSI explanation pattern as Public Delos.
- Commercial use requires separate permission from the licensor.
- External memory projects are post-hoc comparison material only. Mnemosyne's
  code, schemas, APIs, fixtures, thresholds, prompts, and implementation
  mechanisms are independently developed and must never be described as
  derived from them.
- Write the README for a first-time internet reader: lead with the user-visible
  value and a concrete example, introduce Greek product vocabulary through
  roles and collaboration, and defer candidate/release mechanics to the end.
- Introduce architecture affirmatively. Replace defensive negation chains in
  newcomer documentation with the established Delian mythology, wordplay,
  responsibilities, and examples.
- Preserve two install paths that do not require the owner to have an npm
  account: GitHub source installation and a tested release tarball. Do not make
  registry publication part of the public-reader story unless the owner later
  requests it.

## Delivery discipline

New Git history, no remote, scoped commits, explicit provenance, synthetic
fixtures, adversarial scans, pristine-export verification, package inspection,
and private differential replay before any release decision.
