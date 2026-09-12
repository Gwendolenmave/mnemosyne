# Episode recall source validation

`TurnScopedEpisodeRecallSession` treats TypeScript source interfaces as compile-time guidance, not as runtime trust.

Before any search/read result can consume the returned-payload budget or widen same-turn Episode authority, every returned hit must satisfy the public Episode history contract at runtime:

- the Episode id is structurally valid and unique within the result;
- `realm` is recognized, with a non-blank `auId` required only for AU hits and `null` required otherwise;
- `domain`, lifecycle `status`, and `sensitivity` are recognized public enums;
- summary text is non-empty;
- start/end timestamps parse as timestamps and the end is not earlier than the start;
- when the session has an `availableBeforeIso` replay ceiling, the returned Episode must end at or before that ceiling;
- provenance `sourceHash` is exactly `sha256:` plus 64 lowercase hexadecimal characters.

A malformed custom source is therefore treated as `execution_failed`. Its payload is discarded atomically and its Episode ids gain no exact-read or adjacency authorization. The same validation applies to exact reads used to resolve adjacency follow-ups, so a malformed neighbor cannot become a legal next-hop anchor.

Projection adapters remain responsible for stronger publication and storage integrity checks such as current-published payload validation. The model-facing turn session independently re-checks the invariants that are required to keep same-turn capability safe even when a host supplies a custom source: temporal ordering, the session replay ceiling, and canonical provenance shape are not trusted merely because a TypeScript interface was satisfied at build time.

The contract is content-agnostic and public-safe. Tests use only synthetic Episode ids, timestamps, summaries, and provenance hashes.
