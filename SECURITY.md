# Security policy

Mnemosyne handles memory authority, evidence references, backups, and retrieval
boundaries. Security reports deserve a private path and a synthetic
reproduction.

## Supported state

The repository is currently a v0.1 development source candidate. There is no
public package, hosted service, or production support commitment. Security
fixes are evaluated against the current canonical source state.

## Reporting a vulnerability

Use a private GitHub security advisory on the canonical repository when that
facility is available. Otherwise, contact the maintainer through the
`Gwendolenmave` GitHub account and ask for a private reporting channel before <!-- scan:allow private:principal private:principal_alias -->
sending technical details.

Do not open a public issue containing:

- credentials, tokens, provider responses, or environment values;
- a real memory database, transcript, prompt, backup, or decision queue;
- personal names, account identifiers, conversation identifiers, or machine
  paths from a private deployment;
- an exploit that would put an existing deployment at immediate risk.

Send the smallest synthetic reproduction that demonstrates the boundary
failure. Include the affected commit, Node.js version, operating system, steps,
expected result, and observed result.

## High-priority classes

Reports are especially important when they involve:

- retrieval across principal, project, AU/realm, or sensitivity boundaries;
- a model or automated worker bypassing owner policy or a write-site guard;
- a revoked, superseded, expired, or retrieval-disabled item being recalled;
- a backup that includes secrets or cannot prove a safe restore;
- delete or redaction state failing to propagate to derived stores;
- repository scanners missing private material in the tree, Git history, or
  package surface;
- path traversal, unsafe archive extraction, SQL injection, or unexpected
  network egress.

## Disclosure

Please allow time to reproduce, scope, and repair a report before public
disclosure. The project will not ask for real personal data to confirm a bug.
