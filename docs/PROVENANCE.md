# Provenance

## Construction method

This staging repository follows the evidence discipline proven by Public
Delos: new history, no remote, module-by-module inclusion, explicit provenance,
synthetic fixtures, real directory-walk scanning, adversarial scanner tests,
pristine-export verification, package-manifest inspection, and honest recording
of failed evidence.

The private source repository is read-only. Its dirty working tree is neither
cleaned nor modified. Source mechanisms are inspected as evidence, then
generalized in this independent repository; runtime data and private history are
never imported.

## Baseline

- Private source snapshot identity: recorded in local construction evidence and
  deliberately omitted from the distributable repository.
- Source working tree: dirty before extraction; pre-existing owner work remains
  untouched.
- Public staging history: created from an empty repository.
- Remote: none.
- Publication, tag, release, and push authority: not granted.

## Historical design sources inspected

The construction basis includes the Memory House proposal and M1.1/M1.1a
architecture, M2/M3/M3a implementation reviews, governed proposal paths,
Musagetes v4, the Episode Projection rulings and implementation series, D0
automatic-write restoration and source-complete correction, T05 integrated
backup/health/recovery closure, Public Delos programme orders, scanner incident,
and the corresponding local construction transcript chronology.

Private source references remain local evidence. Public documentation records
mechanisms and conclusions, not private content.

## Phase log

### Phase 0 — architecture and privacy scaffold

Written fresh. Establishes the Greek ontology as normative architecture, the
complete inclusion closure, the privacy boundary, local-only staging status,
and the no-reduction rule before implementation bytes are admitted.

### Phase 1 — architecture-preserving extraction

Mechanically copied an explicit implementation allowlist from the private
working snapshot, verified byte identity before editing, and then generalized
the copied bytes in this repository. The extraction retained the event kernel,
Mnemosyne governance, Anamnesis, durable decision automation, Episode Pass 1
and Pass 2, SQLite projections, backup/restore, deletion safety, health,
reliability, and Telegram governance adapter. It also restored dependency
modules exposed by the imported synthetic tests rather than deleting those
tests or flattening the architecture.

Private principals became deployment bindings over stable `owner`,
`companion`, and `system` roles. Private policy ids, authority digests, paths,
prompt/persona text, and source-derived fixtures were removed. Policy authority
and protected production paths are now deployment-supplied and digest pinned.

### Phase 2 — mythology sockets and synthetic verification

Added the public Principal Registry and normative Musagetes contracts for all
nine Muse lenses. Musagetes composes multiple lenses and emits typed
`RetrievalIntent` and `MemoryCandidateIntent`; Muse traces are structurally
excluded from memory evidence.

Reused and privacy-cleaned the source project's synthetic contract and
adversarial tests. At the recorded checkpoint, 348 tests pass. They cover
retrieval isolation, lifecycle/governance, policy activation, no-drop backlog,
episode segmentation and summarization, SQLite migration/integrity,
backup/restore proof, retention/deletion safety, health, durability, and the
new mythology/principal sockets. The repository scanner and its adversarial
suite pass with the external private-pattern file.

### Phase 3 — fresh export and package verification

Replayed the 341 inherited synthetic tests against a read-only private-source
compilation outside both repositories, then ran the 348-test public suite.
Scanned the working tree and all reachable Git blobs with the external private
pattern set. A pristine `git archive` passed fresh install, tests, scanner
adversarial cases, strict privacy scan, and the local example in a second
location. The actual npm tarball contained no tests, source TypeScript, or
forbidden runtime/private artifacts; its extracted tree, public entry surface,
and packaged local flow passed.

The first package entry smoke command had malformed shell quoting and failed
before importing the package. That failed evidence is retained in
`FINAL-VERIFICATION.md`; corrected entry and end-to-end checks passed.

### Phase 4 — licence and public repository documentation

The owner selected the same PolyForm Noncommercial License 1.0.0 used by
Public Delos. The official `LICENSE` text was copied byte-for-byte from the
local Public Delos candidate; `LICENSE-NOTES.md` follows the same separation
between binding terms and plain-language explanation. Package metadata now
uses the matching SPDX identifier while `private: true` remains to prevent an
unauthorized registry publication.

The construction stub README was replaced with a complete English entry point
and a linked Simplified Chinese translation. Integration, security,
contribution, succession, changelog, and binding publication-checklist files
were added in English.

Mnemosyne's architecture and implementation remain solely derived from Delos's
own requirements, work orders, design history, and private implementation. The
external memory-project comparison was post-hoc validation after the system
existed. No external project code, schema, API design, fixture design,
threshold, prompt, or implementation mechanism was used. Current public
README files were reviewed only to improve navigation and repository-facing
explanation; that boundary is recorded in `INDEPENDENT-COMPARISON.md`.

### Phase 5 — newcomer README and installable package

The README was restructured for a first-time public reader: product value and
a concrete memory journey now precede implementation status, the nine Muses
are introduced through their responsibilities and collaboration, and release
mechanics are deferred to the status section.

The owner then authorized preparation of an installable npm package. The
package metadata and Git build lifecycle were added, and installation from a
release tarball and a Git source dependency became explicit acceptance paths.
The accidental-publication guard remains because registry distribution is not
needed for either route.
