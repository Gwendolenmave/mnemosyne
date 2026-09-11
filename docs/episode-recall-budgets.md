# Episode recall turn budgets

`TurnScopedEpisodeRecallSession` is deliberately bounded even though it is a read-only surface.

One logical turn has two independent portable ceilings:

- **Call attempts:** 4 by default across search, deterministic follow-up, and exact read. Malformed and unauthorized calls still consume an attempt.
- **Returned structured payload:** 24,000 Unicode code points by default across successful results from all three operations.

The return budget is measured over the exact JSON representation of the public `EpisodeHistoryHit[]` value. This makes the accounting independent of UTF-16 code units and includes every returned field: ids, temporal and governance metadata, provenance hashes, titles, and summaries.

A result that would cross the cumulative ceiling is discarded as a whole. It does not partially return data and, critically, it does not grant new same-turn authorization for any Episode ids contained in that discarded result. The source remains read-only; no lifecycle or projection state is changed.

Hosts may provide stricter or larger positive safe-integer ceilings when constructing the session. Provider/network timeouts are intentionally not defined here because the current public Episode source interfaces are synchronous; asynchronous host/provider deadline policy belongs at the host boundary rather than being simulated inside this storage-neutral session.
