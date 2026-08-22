# Privacy model

## Repository boundary

Only source code, public documentation, schemas, and synthetic fixtures may be
tracked. The following are forbidden from the tree and from its Git history:

- memory databases and write-ahead logs;
- transcripts, message exports, traces, decision backlogs, receipts, and logs;
- backups, encryption keys, credentials, environment files, and secret values;
- private prompt or persona corpora;
- real principal names, account identifiers, conversation identifiers, host
  names, home paths, policy identifiers, and deployment state;
- fixtures derived from private conversations, even if the text seems harmless.

Normative project documentation is English. `README.zh-CN.md` is the single
Simplified Chinese translation of the English README. Localization is not a
privacy exemption: the translation remains subject to the same secret, private
identity, path, runtime-artifact, history, and manual fixture review gates.

## Runtime boundary

Operational queues store stable pointers, hashes, policy versions, and status,
not raw transcript text. Evidence is resolved by explicit identity and verified
against its content hash before a decision. Missing, changed, oversized, or
ambiguous evidence fails closed for writes.

Retrieval audit records contain identifiers, categorical reasons, counts,
budgets, and timings only. They must not contain memory bodies, prompt bodies,
transcript excerpts, or user input.

## Greek ontology

Mnemosyne, Anamnesis, Lethe, Muse, Musagetes, Calliope, Clio, Erato, Euterpe,
Melpomene, Polyhymnia, Terpsichore, Thalia, Urania, and Delos are public product
and architecture vocabulary. Their presence is never a privacy finding.

## Publication gate

Passing the repository scanner is necessary but insufficient. A publishable
candidate also requires a pristine export scan, Git-history scan, package-file
manifest inspection, secret scan, synthetic fixture review, and a private
compatibility replay performed outside this repository.

The complete sequence is binding in `docs/PUBLICATION-CHECKLIST.md`.
