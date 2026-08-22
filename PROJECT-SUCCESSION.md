# Project succession

This file states what should happen to the canonical repository if the
maintainer becomes unable to maintain it.

It exists because personal memory infrastructure should not disappear without
a written preservation plan.

## What a successor is for

A successor's role is custodial, not editorial:

1. Preserve the canonical repository and its public history.
2. Transfer it to a hosting location that remains reachable.
3. Archive it publicly in a readable state if active hosting ends.

That is the whole mandate.

## What a successor does not inherit

- Development authority or the right to set project direction.
- Authority to relicense the software.
- Authority to accept contributions or speak for the original project.
- Any private deployment, principal data, memory, transcript, prompt,
  credential, policy instance, backup, or construction record.

A successor who wants to develop the software may fork it under the existing
licence and continue under a different project identity. The canonical archive
must not imply that the fork is the same maintainer or project.

## Private material is never part of succession

The maintainer's private Delos instance and every private Mnemosyne authority
are outside this repository. They are not to be published, transferred, or
archived as part of project succession.

## Practical preservation notes

- Preserve the full public commit history rather than only a source snapshot.
- Keep `LICENSE`, `LICENSE-NOTES.md`, `CONTRIBUTING.md`, `SECURITY.md`, and this
  file with the code.
- Preserve release artifacts together with their recorded hashes and source
  commit identities.
- An archived and readable repository is better than active maintenance by
  someone who does not want the responsibility.
