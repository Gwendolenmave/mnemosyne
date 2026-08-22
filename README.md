# Mnemosyne

<!-- scan:allow-file private:principal private:principal_alias -->

[简体中文](README.zh-CN.md)

**Long-term memory that helps a personal AI remember the right thing, for the
right reason, at the right moment.**

Mnemosyne is the memory system built for [Delos](https://github.com/Gwendolenmave/delos).
It turns conversation evidence into durable, governed memory, keeps changing
facts in historical order, and recalls each memory only inside its proper
context.

It can remember preferences, relationships, project history, commitments,
going stories, and long-running work while preserving where each memory came
from, who or what authorized it, how it changed, and when it should stay
silent. Mnemosyne is local-first, model-neutral, and usable as an independent
library in other personal AI runtimes.

## A memory's journey

Suppose a project meeting moves from Monday to Thursday.

```text
"The meeting is now on Thursday."
        │
        ▼
Transcript evidence keeps the exact source
        │
        ▼
A candidate records the proposed change
        │
        ▼
Owner confirmation or a registered policy authorizes it
        │
        ▼
The Thursday memory supersedes the Monday memory
        │
        ▼
Anamnesis recalls Thursday for the next relevant turn
```

Thursday becomes the current answer. Monday remains in the append-only history
with its source, former validity, and reason for supersession.

That distinction is the heart of Mnemosyne: **memory is evidence plus
authority, lifecycle, context, and recall rules.**

## Meet the nine Muses

Mnemosyne takes her name from the Greek goddess of memory and mother of the
nine Muses. The architecture follows that lineage: Mnemosyne governs the life
of memory, while her nine daughters illuminate the current moment from nine
different directions.

**Musagetes** is an epithet of Apollo meaning *leader of the Muses*—and a
deliberate echo of *Muse agents*. As their conductor, Musagetes composes every
active lens into two structured intentions:

- a `RetrievalIntent`, which tells Anamnesis what kind of memory the present
  turn needs; and
- a `MemoryCandidateIntent`, which tells the governed write path what may be
  worth considering for durable memory.

Several Muses may sing in the same turn. Musagetes writes the score; Mnemosyne
and the governance path retain authority over durable memory.

The names complete the Delian circle: Delos is Apollo's birthplace, so
Musagetes belongs naturally on the island; Mnemosyne and her daughters give
its memory system a family, a chorus, and a history.

## Install

Install directly from the public GitHub repository:

```sh
npm install github:Gwendolenmave/mnemosyne
```

## Licence

Mnemosyne is source-available under the
[PolyForm Noncommercial License 1.0.0](LICENSE). Personal use, study,
modification, and noncommercial sharing are permitted under the licence.
Commercial use requires separate permission.
