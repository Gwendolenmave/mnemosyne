# Episode recall source validation

`TurnScopedEpisodeRecallSession` treats TypeScript source interfaces as compile-time guidance, not as runtime trust.

Before any search/read result can consume the returned-payload budget or widen same-turn Episode authority, every returned hit must satisfy the public Episode history contract at runtime:

- the Episode id is structurally valid and unique within the result;
- `realm` is recognized, with a non-blank `auId` required only for AU hits and `null` required otherwise;
- `domain`, lifecycle `status`, and `sensitivity` are recognized public enums;
- summary text is non-empty;
- start/end timestamps parse as timestamps;
- provenance `sourceHash` is non-blank.

A malformed custom source is therefore treated as `execution_failed`. Its payload is discarded atomically and its Episode ids gain no exact-read or adjacency authorization. The same validation applies to exact reads used to resolve adjacency follow-ups, so a malformed neighbor cannot become a legal next-hop anchor.

This is intentionally a narrow model-facing boundary. Projection adapters remain responsible for their own stronger publication, lifecycle, integrity, and replay-ceiling rules; the turn session simply refuses to trust a host implementation because it happened to satisfy a TypeScript type at build time.

The contract is content-agnostic and public-safe. Tests use only synthetic Episode ids, timestamps, summaries, and provenance hashes.
