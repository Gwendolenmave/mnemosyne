# Independent comparison

## Boundary first

Mnemosyne's architecture and implementation were developed independently from
Delos's own requirements, work orders, internal design history, and existing
private implementation.

The external-project review happened after Mnemosyne already existed. It was a
post-hoc comparison used to answer two questions:

1. Does Mnemosyne's already-implemented capability surface leave an important
   public memory-governance category unexamined?
2. Can the public repository explain its own completed system as clearly as a
   mature GitHub project explains itself?

The comparison was **not** an implementation source. Mnemosyne did not refer to,
copy, port, translate, paraphrase, or derive from external project code. It did
not take external schemas, API shapes, fixture designs, thresholds, prompts,
algorithms, migrations, or architectural mechanisms.

## What was compared

The post-hoc review covered public material from memory projects including:

- [KiwiMem](https://github.com/LucieEveille/kiwi-mem)
- [Mem0](https://github.com/mem0ai/mem0)
- [Letta / MemGPT](https://github.com/letta-ai/letta)
- [Graphiti](https://github.com/getzep/graphiti)
- [SimpleMem](https://github.com/aiming-lab/SimpleMem)
- [Cognee](https://github.com/topoteretes/cognee)
- [Supermemory](https://github.com/supermemoryai/supermemory)
- [Basic Memory](https://github.com/basicmachines-co/basic-memory)
- [Elroy](https://github.com/elroy-bot/elroy)
- [Khoj](https://github.com/khoj-ai/khoj)

The wider review also looked at other memory, retrieval, and context systems.
The purpose was coverage checking and public explanation, not ranking, copying,
or choosing an upstream implementation.

## Neutral orientation

Different projects draw the memory-system boundary in different places. This
table helps a reader locate Mnemosyne without claiming that any row is its
source.

| Public project emphasis | Mnemosyne's independently existing emphasis |
| --- | --- |
| Gateway or service that inserts memory into model traffic | Provider- and surface-neutral governed memory library |
| Small add/search memory API | Separate evidence, authority, lifecycle, retrieval, and projection contracts |
| Stateful agent platform | Memory subsystem that a host runtime composes through ports |
| Temporal knowledge graph | Append-only memory authority plus a separate rebuildable Episode Projection |
| Consolidation pipeline | Governed candidate path with durable backlog and evidence reread |
| Human-editable file memory | Event-sourced authority with owner-visible revision and lifecycle history |
| Hosted context or memory product | Local-first source distribution with no project-operated service or telemetry |

These are category differences, not statements that one project is better or
worse than another.

## What the README review changed

The public READMEs were reviewed for information architecture only. Mature
repositories commonly make the following easy to find:

- a one-sentence product boundary;
- the problem the project solves;
- a minimal working quick start;
- a small architecture or data-flow explanation;
- a capability table;
- data, network, telemetry, and licence boundaries;
- links to deeper operating, security, and contribution documents;
- an honest statement of what is not included.

Mnemosyne's README was reorganized around those reader needs. No upstream prose,
commands, diagrams, claims, or code examples were copied.

## Why the comparison remains in the public repository

The earlier comprehensive comparison remains relevant to public-repository
preparation. Keeping this short boundary document prevents two opposite
mistakes:

- pretending Mnemosyne was developed without checking the surrounding public
  field after the fact; or
- falsely implying that its architecture or implementation descended from
  another memory project.

The accurate statement is narrower: Mnemosyne was independently developed,
then externally compared, and its public explanation was improved afterward.
