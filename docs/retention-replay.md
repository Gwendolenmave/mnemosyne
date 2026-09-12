# Writer-free retention replay

`Retention.replayPortableRetention()` is the public historical-replay boundary for the portable retention classifier.

The replay contract is deliberately narrower than a host runtime. It accepts the same strict structured evidence as `dispatchPortableRetention()`, runs the same deterministic classification, and returns a frozen receipt containing only the normalized request (or `null` for invalid input), the classification decision, and explicit `writerCapabilityPresent: false` / `writePerformed: false` markers.

It does not expose a backlog writer, memory writer, Episode writer, projection writer, transcript writer, provider, filesystem path, or host integration. Invalid input remains fail-closed as `quarantine / invalid_request` and is not copied into the receipt. Valid input is copied into immutable receipt-owned data so later caller mutation cannot rewrite replay evidence.

This makes historical retention audits reproducible without creating a second admission authority. A host that wants to apply a replay result must still go through its normal governed admission or correction writer; the replay receipt itself has no mutation capability.
