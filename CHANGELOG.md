# Changelog

This project follows a release-facing changelog without pretending that local
construction checkpoints are public releases.

## Unreleased

- Add a portable deterministic Episode adjacency primitive for bounded
  same-conversation forward traversal, with fail-closed conversation witnesses
  and replay ceilings; export it from the package root as `EpisodeAdjacency`.
- Add a read-only SQLite Episode adjacency adapter over the existing projection
  schema. Conversation identity remains owned by the Episode row while
  `episode_messages` mappings are fail-closed consistency witnesses; export it
  from the package root as `SqliteEpisodeAdjacency`.
- Add a turn-scoped Episode follow-up gate for model-controlled multihop recall:
  only Episode ids already returned in the same logical turn may become
  adjacency anchors, and successful hits become eligible for the next bounded
  hop; export it from the package root as `EpisodeFollowup`.
- Add a bounded read-only Episode history/search surface with lexical FTS
  ranking, explicit replay ceilings, current-published integrity validation,
  and provenance-bearing candidates; export it as `EpisodeHistory` and
  `SqliteEpisodeHistory` without adding semantic/vector retrieval.
- Add a bounded exact-id Episode history read surface for host-controlled
  follow-up/full-summary reads: 1..2 unique ids, strict replay ceilings,
  current-published provenance validation, request-order preservation, and
  all-or-nothing fail-closed behavior; export it as `EpisodeHistoryRead` and
  `SqliteEpisodeHistoryRead`.
- Add a turn-scoped Episode recall session composing search, deterministic
  follow-up and exact read without granting storage-probing authority: only ids
  actually returned in the same session may be read or used as next-hop
  anchors, and authorization disappears with the session; export it as
  `EpisodeRecallSession`.
- Bound the turn-scoped Episode recall session with one shared call-attempt
  ledger across search, follow-up and exact read. The default ceiling is four
  attempts; malformed and unauthorized calls still consume a slot, and once
  exhausted every operation fails closed before touching its source.
- Bound turn-scoped Episode search inputs before projection access using Unicode
  code points: model-facing query text must be non-blank and is capped at 600;
  an optional lexical time hint must be non-blank and is capped at 120. Invalid
  inputs consume their attempt slot but fail closed without invoking the history
  source, while the lower-level host-controlled history primitive remains free
  to support empty-query recent-history browsing.
- Bound cumulative turn-scoped Episode recall output to 24,000 Unicode code
  points by default across search, deterministic follow-up and exact read. A
  result that would cross the remaining budget is discarded atomically and
  grants no new same-turn Episode authorization.
- Add a content-free audit wrapper for turn-scoped Episode recall. Receipts
  contain only sequence, operation and request/result counts; query text,
  Episode ids, summaries, provenance and source details never enter the audit
  event, and a broken audit sink cannot change recall behavior. Export it as
  `EpisodeRecallAudit`.
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
