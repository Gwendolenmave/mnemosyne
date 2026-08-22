# Status

| Capability | Specification | Public code | Public tests | Synthetic wiring |
| --- | ---: | ---: | ---: | ---: |
| Mythos contracts and nine Muses | yes | yes | yes | contract flow |
| Mnemosyne lifecycle and Lethe | yes | yes | yes | local flow |
| Anamnesis retrieval | yes | yes | yes | local flow |
| SQLite event log and projections | yes | yes | yes | local flow |
| Durable decision automation | yes | yes | yes | test harness |
| Episode Projection Pass 1 and 2 | yes | yes | yes | deterministic port |
| Backup, restore, deletion, health | yes | yes | yes | end-to-end tests |
| Telegram governance adapter | yes | yes | yes | adapter tests |
| Privacy and release gates | yes | yes | yes | local gates passed |

Current local evidence: 348 public tests and 341 inherited private-compatibility
tests pass; scanner adversarial, working-tree, Git-history, package-manifest,
package-extraction, and pristine-export gates pass. This is not a publication
claim. The owner has selected the same PolyForm Noncommercial 1.0.0 licence as
Public Delos. Creating a remote, pushing, tagging, publishing a package,
deploying, or announcing a release remains a separate authority decision.

This table deliberately separates design, implementation, tests, and wiring.
Synthetic wiring is not reported as a live deployment claim. Episode
Projection remains a rebuildable projection and is not automatically promoted
to memory.
