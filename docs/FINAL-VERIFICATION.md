# Final local verification

Date: 2026-08-07 (Asia/Shanghai)

This is evidence for a local publication candidate, not a publication.

## Functional evidence

- TypeScript strict typecheck: pass.
- Public synthetic suite: 348 tests passed, 0 failed.
- Private compatibility replay: 341 inherited tests passed, 0 failed. The
  private working snapshot was compiled to an external temporary output and
  remained read-only. The public suite adds seven tests for principals,
  Musagetes, all nine Muses, trace exclusion, and deployment-owned policy
  authority.
- Local reference flow: policy registration, policy-activated write,
  Anamnesis retrieval, and metadata-only audit passed on a temporary SQLite
  authority.

## Privacy and repository evidence

- Scanner adversarial cases: pass.
- Full working-tree walk with the external private-pattern file: pass, with
  non-zero files and bytes.
- All reachable Git blobs with the external private-pattern file: pass.
- All 40 relative Markdown links across the 19 repository Markdown files:
  pass.
- Greek ontology is explicitly allowed; private principals, paths, policy
  instances, authority digests, prompts, traces, transcripts, databases, and
  source-derived personal fixtures are excluded.
- Git remote: none.

## Fresh-location and package evidence

- A `git archive` pristine export was extracted in a second location. Fresh
  dependency installation, 348 tests, scanner adversarial cases, strict
  privacy scan, and the local reference flow all passed there.
- The actual npm tarball contained 251 files, no compiled tests, no TypeScript
  source files other than declarations, and no forbidden runtime/private file
  classes. Its extracted tree passed the strict privacy scan.
- Tarball entry smoke test exposed nine Muses, the public stage marker,
  Anamnesis, and SQLite Mnemosyne. Installation into an otherwise empty
  consumer project and the packaged local reference flow both passed.
- Installation into a second empty consumer project from the frozen local Git
  commit passed, exercising the same source-build lifecycle used by the GitHub
  install command.

## Failed evidence retained

Two acceptance-harness commands failed without changing the product. An early
tarball smoke command lost JavaScript delimiters through shell quoting. A later
consumer check requested a nonexistent function name before being corrected to
the actual public export `composeMuseSignals`. Each corrected check passed,
followed by the packaged end-to-end local flow. Failed harness commands are not
treated as product evidence.

## Licence decision and remaining authority gate

The owner subsequently selected the same PolyForm Noncommercial License 1.0.0
used by Public Delos. `LICENSE`, `LICENSE-NOTES.md`, and package metadata now
record that decision. The two repositories' `LICENSE` files are byte-identical
and have SHA-256
`C0EA4A896D2C8C394B29F9427589996DB826CD501C512279FF0ED3EF48FABBE5`.
The package surface was subsequently authorized for public installation.
`private: true` remains as an accidental-registry-publication guard, while the
`prepare` lifecycle builds Git dependencies from source and the packed release
archive carries its compiled entry points and declarations. Both install paths
work without an npm publisher account.

Creating a remote, pushing, tagging, publishing a package, deploying, or
announcing a release still requires explicit owner authority. Final archive
and package byte counts and hashes are recorded only in the external
owner-held release receipt, because embedding a package's own hash in a
document included in that package would make the value self-invalidating.
