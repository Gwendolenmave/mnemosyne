# Contributing

**This project is under closed maintenance.** It is not accepting substantive
external code contributions, and pull requests are not part of the canonical
maintenance workflow.

That is a deliberate position, not an oversight or a temporary backlog.

## Why

Mnemosyne is maintained by one person. Accepting outside code creates review,
copyright, provenance, security, and continuity obligations. Those obligations
are unusually important in a system that governs personal memory and evidence.

Until there is a contribution policy and copyright arrangement worth signing,
accepting patches would mean accepting responsibilities the project cannot
honestly promise to meet.

## What is welcome

- **Bug reports**, especially a case where the system recalls material that
  should be ineligible, attributes a memory to the wrong evidence, reports a
  write that was not durable, or loses an owner action.
- **Security reports**, sent privately according to `SECURITY.md`.
- **Reproducible compatibility reports** for supported Node.js versions and
  local filesystems.
- **Architecture questions and disagreement**, grounded in a concrete contract,
  test, or failure mode.
- **Documentation corrections** that do not include private runtime material.

Do not attach a real memory database, transcript, prompt corpus, decision
queue, credential, backup, or private path to an issue. Build a synthetic
reproduction instead.

## What to do instead of a pull request

Fork the repository. The licence permits noncommercial use and modification,
and the architecture is built for replacement: principals are registry data,
providers are ports, storage is behind contracts, projections are rebuildable,
and transports are adapters.

Keep the PolyForm Noncommercial terms and required notices with any
noncommercial distribution. Commercial use or distribution requires a
separate arrangement with the licensor.

## If this policy changes

If a contribution and copyright policy is established, this file will say so.
Until then, assume substantive patches will not be accepted by the canonical
project.
