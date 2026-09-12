# Publication checklist

This checklist is the binding gate for distributing a Mnemosyne source or package candidate. A green unit-test run is necessary but is not, by itself, publication evidence.

## 1. Freeze one exact candidate

- Record the exact public commit SHA being evaluated.
- Start from a clean checkout of `Gwendolenmave/mnemosyne`; do not publish from a mixed private/public working tree.
- Confirm the repository is public and the candidate has no unresolved release-blocking review or issue.
- Do not rewrite public history to make a candidate pass.

## 2. Require exact-head public CI

The `public-mnemosyne-staging-ci` workflow for the exact candidate SHA must complete successfully.

That workflow must provide distinct evidence for:

1. an isolated, shallow exact-head checkout that runs typecheck, synthetic tests, scanner adversarial tests, the working-tree privacy scan, and package-manifest inspection; and
2. a full-history checkout at the same exact SHA that runs `scripts/scan-history.py`.

A history scan from a shallow checkout is invalid evidence. `scripts/scan-history.py` intentionally refuses to run in a shallow repository.

## 3. Run owner-private literal scans outside tracked state

The public scanner can detect generic credential/path/runtime-artifact classes, but only the owner can supply literals that identify private deployments.

From a **full clone** of the exact candidate, use an untracked pattern file stored outside the repository:

```sh
python3 scripts/scan.py . --private-pattern-file /path/outside/repo/private-patterns.txt
python3 scripts/scan-history.py --private-pattern-file /path/outside/repo/private-patterns.txt
```

The pattern file itself must never be committed, copied into an artifact, pasted into CI logs, or uploaded with a bug report.

## 4. Inspect the package surface

Run:

```sh
npm ci --ignore-scripts
npm pack --dry-run --json
```

Review the manifest rather than assuming `.gitignore` or `.npmignore` defines the package. The candidate must include the intended entry point, declarations, license, README, and public docs while excluding tests, runtime databases, logs, backups, receipts, environment files, credentials, and private fixtures.

For a release candidate, also build the actual tarball and scan the pristine extracted package:

```sh
npm pack --json
mkdir -p /tmp/mnemosyne-package-audit
# Extract the produced .tgz into the scratch directory, then scan its package/ root.
python3 scripts/scan.py /tmp/mnemosyne-package-audit/package \
  --private-pattern-file /path/outside/repo/private-patterns.txt
```

Delete the scratch export after review. Never use a real runtime state directory as package input.

## 5. Review synthetic fixtures and examples

- Confirm every tracked transcript, Memory/Episode fixture, identifier, path, and prompt example is synthetic or deliberately public product vocabulary.
- Do not publish fixtures derived from private conversations even when names have been replaced.
- Re-run the local example from the exact candidate and confirm it creates only temporary synthetic state:

```sh
npm run example:local
```

## 6. Run private compatibility replay outside this repository

Before calling a candidate compatible with the private canonical runtime, run the private replay/evaluation procedure from the private environment against the exact public candidate.

This step is evidence only. Do **not** copy private transcripts, corpora, database rows, host paths, provider configuration, identities, scores tied to private content, or generated private fixtures back into this repository or a public CI artifact. Record only a content-free pass/fail receipt suitable for release bookkeeping.

## 7. Check release-facing metadata

- `README.md`, `README.zh-CN.md`, `docs/STATUS.md`, `CHANGELOG.md`, `SECURITY.md`, and licensing notes must describe the candidate truthfully.
- The declared Node engine and the tested Node version must be compatible.
- The package version and release/tag name must describe the maturity level honestly.
- `LICENSE.md` and required notices must be present in every distributed artifact.

### npm registry publication

The current package intentionally has `"private": true` and a development version. That means an npm-registry publication is **not** authorized by the current repository state. Changing `private`, package scope/name, or release version is a deliberate distribution decision, not a mechanical publication step.

A GitHub source release or Git-based installation can be evaluated independently under the rest of this checklist.

## 8. Publish only after every gate is green

For the exact SHA being released, retain content-free evidence of:

- exact-head CI success;
- full public Git-history scan success;
- owner-private literal tree/history scan success;
- package manifest and pristine-export review;
- synthetic fixture/example review;
- private compatibility replay result;
- final documentation/license/version review.

If any gate is missing, stale, run on another SHA, or cannot prove what it claims to prove, the candidate is not publishable yet.
