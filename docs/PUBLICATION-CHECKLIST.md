# Publication checklist

<!-- scan:allow-file private:principal private:principal_alias -->

## Scope

This is the binding local gate for the first public Mnemosyne source and
installable package release. It follows the release discipline established by
Public Delos and adds install, package-surface, and private-compatibility checks
specific to Mnemosyne.

Passing this checklist proves that a candidate is ready for an owner release
decision. It does not itself authorize a remote, push, tag, deployment, or
announcement.

## 0. Authority and candidate freeze

- [ ] Record the candidate branch and full commit id.
- [ ] Confirm the working tree contains no unrelated owner changes.
- [ ] Confirm the private source repository was read-only throughout the
      candidate construction.
- [ ] Confirm explicit owner authority for the intended action: source remote,
      tag, release artifact, or deployment are separate acts.
- [ ] Freeze the candidate bytes before final evidence collection.

## 1. Licence and public-facing truth

- [ ] `LICENSE` is byte-identical to the official unmodified PolyForm
      Noncommercial License 1.0.0 text used by Public Delos.
- [ ] `package.json` and `package-lock.json` declare
      `PolyForm-Noncommercial-1.0.0`.
- [ ] `README.md`, `README.zh-CN.md`, `LICENSE-NOTES.md`, release notes, and the
      package manifest all say source-available and noncommercial.
- [ ] No document calls the licence OSI-approved or calls the project open
      source without qualification.
- [ ] Commercial use is explicitly stated to require separate permission.
- [ ] Licensor and maintenance policy are named consistently.
- [ ] Third-party dependencies and ideas remain under their own licences.

## 2. Documentation and claim verification

- [ ] Normative project documentation is English. `README.zh-CN.md` is the
      single Simplified Chinese translation and links back to `README.md`.
- [ ] Every README command runs from a clean source checkout.
- [ ] Every linked file and relative anchor exists.
- [ ] Capability claims match `docs/STATUS.md` and executable tests.
- [ ] Specification, implementation, test coverage, synthetic wiring, and live
      deployment are not conflated.
- [ ] Honest limits name every missing release or live-acceptance claim.
- [ ] The independent comparison is labelled as post-hoc validation and does
      not imply external technical lineage, reuse, or architectural derivation.

## 3. Repository and privacy gate

- [ ] Run scanner adversarial cases.
- [ ] Scan the complete working tree with built-in patterns.
- [ ] Re-run the working-tree scan with the owner-supplied, untracked private
      pattern file and require a non-vacuous file and byte count.
- [ ] Scan every blob reachable from every local commit with the same private
      pattern file.
- [ ] Confirm zero tracked databases, WAL files, transcripts, queues, logs,
      backups, receipts, secrets, environment files, private prompts, or
      machine paths.
- [ ] Review all fixtures manually for private-source derivation, not only
      literal matches.
- [ ] Confirm Greek ontology names remain allowed product vocabulary and are
      not added to the private pattern set.
- [ ] Confirm no symlink can lead a scanner or package outside the candidate
      root.

## 4. Functional gate

- [ ] `npm ci` completes in a fresh source checkout.
- [ ] Strict typecheck passes.
- [ ] Complete public synthetic test suite passes with zero skipped failures.
- [ ] Scanner adversarial suite passes.
- [ ] The standalone local SQLite flow writes, retrieves, audits, and cleans up
      synthetic state.
- [ ] Private compatibility replay passes outside both repositories against a
      read-only private-source compilation.
- [ ] No verification command reaches a live provider or reads real runtime
      data.

## 5. Pristine source export

- [ ] Create the source archive from the frozen commit, not from an arbitrary
      dirty working directory.
- [ ] Record archive file count, byte size, and SHA-256.
- [ ] Extract it into a new isolated directory.
- [ ] Run clean install, typecheck, public tests, scanners, and local example in
      that directory.
- [ ] Confirm the exported tree contains no `.git`, local construction
      evidence, runtime state, caches, or build output not intended for release.

## 6. Package-surface gate

The candidate includes an installable npm package surface for direct GitHub and
downloaded release-tarball installation. Neither path needs a publisher account.

- [ ] Run `npm pack --dry-run --json` and inspect the actual manifest.
- [ ] Build an actual tarball for review without publishing it.
- [ ] Confirm `private: true` blocks accidental registry publication without
      blocking either supported installation route.
- [ ] Confirm `prepare` builds a Git dependency from source.
- [ ] Record tarball file count, byte size, and SHA-256.
- [ ] Confirm `LICENSE`, README files, licence notes, documentation, and
      declaration files are present.
- [ ] Confirm compiled tests, source tests, caches, runtime data, private
      artifacts, and unexpected TypeScript sources are absent.
- [ ] Extract and scan the tarball in an isolated directory.
- [ ] Import the package entry and verify Mnemosyne, Anamnesis, Musagetes, all
      nine Muses, the public stage marker, and SQLite Mnemosyne are exposed.
- [ ] Run the packaged synthetic local flow.
- [ ] Install the tarball into an empty consumer project and import it by its
      package name, not by reaching into internal build paths.
- [ ] Install from a local Git URL to exercise the same `prepare` lifecycle used
      by `npm install github:Gwendolenmave/mnemosyne`.

## 7. Git history and remote gate

- [ ] `git log --all` contains only the independent public construction
      history.
- [ ] No private source commit, branch, tag, reflog artifact, remote-tracking
      ref, or copied patch series is reachable.
- [ ] Full history privacy scan passes after all documentation and licence
      commits are included.
- [ ] Confirm the configured remote list matches the authorized release action.
- [ ] Before the first public push, treat local commits as review history that
      may still be revised to remove a leak.
- [ ] After the first public push, treat history as permanent; never rely on a
      later deletion to make exposed data private again.

## 8. Release receipt

- [ ] Record commit id, source archive hash, package hash, file counts, byte
      counts, test counts, scanner pattern counts, and zero-finding results.
- [ ] Record the exact README and licence hashes.
- [ ] Record every failed verification attempt and the corrected rerun; do not
      silently replace failed evidence.
- [ ] Record what was **not** tested, including live provider, live Delos,
      platform-specific, or deployment acceptance.
- [ ] Verify released artifacts byte-for-byte after they reach their final
      release location.

## 9. Stop conditions

Stop publication if any of the following is true:

- a private or secret finding appears in the tree, history, source archive, or
  package;
- the candidate cannot be reproduced from the frozen commit;
- the licence text differs from the authorized official bytes;
- documentation claims a feature, release mode, or live deployment not proven
  by the candidate;
- a compatibility replay or synthetic test fails;
- the intended remote, tag, package, deployment, or announcement lacks explicit
  owner authority.
