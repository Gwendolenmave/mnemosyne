# Changelog

This project follows a release-facing changelog without pretending that local
construction checkpoints are public releases.

## Unreleased

- Preserve canonical creation evidence and first-class `explicit / observed /
  inferred / imported` source-basis semantics across projection rebuild and
  close/reopen, with provenance contradictions failing closed.
- Harden policy-card governance: governed repair, retrieval-metadata replacement,
  frozen revision preconditions, durable replay receipts, append-only
  supersede/merge, and exact-AU reclassification.
- Add formal curation decision-set validation and sole-governance-writer
  execution for `KEEP / REVISE / REVOKE / RECLASSIFY_AU / SUPERSEDE / MERGE /
  EPISODIC_ONLY`, including durable decision/set receipts and replay safety.
- Add the portable retention authority contract so short-lived and episodic
  evidence is classified before ordinary long-term admission; export it from
  the package root as `Retention`.
- Expose formal curation from the package root through the stable `Curation`
  facade rather than requiring hosts to depend on individual service files.
- Keep event history canonical and projections rebuildable, including projection
  freshness/crash recovery and stale-read guards.
- Apply the PolyForm Noncommercial License 1.0.0, with the same licence text
  and public explanation pattern used by Public Delos.
- Restructure the English README and linked Simplified Chinese translation for
  first-time public readers, with a concrete memory journey and a full
  role-based introduction to Musagetes and all nine Muses.
- Add integration, security, contribution, privacy, and status documentation.
- Prepare an installable npm package surface for direct GitHub and release
  tarball use without claiming that an npm release has been published.

Verification claims in this changelog refer only to public source and public
synthetic/privacy gates. They are not shorthand for current-private parity.

## 0.1.0-dev.0 -- local candidate

- Preserve the Mnemosyne, Anamnesis, Lethe, Musagetes, nine-Muse, and Episode
  Projection architecture in an independent public-safe Git history.
- Include append-only memory events, governance, policy activation, durable
  automatic decision processing, retrieval containment, SQLite projections,
  backup, restore, deletion safety, health, and reliability.
- Replace private principals, policies, evidence, paths, prompts, and fixtures
  with deployment ports and synthetic public data.
- Establish public synthetic and privacy/repository verification gates for the
  extracted candidate.

No public tag or npm publication is claimed for this version.
