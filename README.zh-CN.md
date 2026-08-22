# Mnemosyne

<!-- scan:allow-file private:principal private:principal_alias -->

[English](README.md)

**让个人 AI 在正确的时候，因正确的理由，想起正确的事。**

Mnemosyne 是为 [Delos](https://github.com/Gwendolenmave/delos) 设计的记忆系统。
它把对话证据转化为持久、受治理的记忆，按历史顺序保存事实的变化，并让每条记忆只在
合适的上下文中被唤回。

它可以记住偏好、关系、项目历史、承诺、持续展开的故事与长期工作；同时保留每条
记忆从哪里来、由谁或什么规则授权、后来怎样变化，以及什么时候应该保持沉默。
Mnemosyne 是本地优先、与模型无关的，也可以作为独立库接入其他个人 AI runtime。

## Mnemosyne 能做什么

- **把证据变成受治理的记忆。** 聊天中的一句话先以证据身份进入系统。候选记忆保留
  原始来源，并通过明确的 policy 或确认路径取得召回权威。
- **记住变化，也保留过去。** 修订、取代、过期、撤销和停止召回都是彼此独立的
  生命周期事件。
- **只为当下召回合适的记忆。** 系统会先检查 scope、项目、关系、AU 或 realm、
  sensitivity、冲突、时效和 token 预算，再进行排序。
- **理解的不只是关键词。** 九位 Muse 分别理解叙事、历史、亲密、日常声音、冲突修复、
  誓言、身体场景、玩笑和系统思维，让系统知道此刻需要保护哪一种连续性。
- **故障之后还能复原。** 持久真相是 append-only 的；索引和当前视图都能重建。
  备份、恢复证明、健康检查和故障恢复属于同一套系统。
- **让本地数据留在本地。** 数据库、模型供应商、聊天记录、policy 和 secret 全部由
  宿主掌握，Mnemosyne 在这条边界内运行。

## 一条记忆会怎样走完整个旅程

假设一个项目会议从周一改到了周四。

```text
“会议现在改到周四。”
        │
        ▼
Transcript evidence 保存准确来源
        │
        ▼
候选记忆记录这次变化
        │
        ▼
Owner 确认或已注册 policy 为它授权
        │
        ▼
周四的记忆取代周一的旧状态
        │
        ▼
下一次相关对话中，Anamnesis 召回周四
```

周四成为当前答案；周一则连同来源、曾经有效的状态和后来被取代的原因，一起留在
append-only 历史里。

这就是 Mnemosyne 的核心：**记忆由证据、授权、生命周期、上下文和召回规则共同组成。**

## 认识九位 Muse

Mnemosyne 取名自希腊神话中的记忆女神，也是九位缪斯的母亲。架构沿着这份谱系展开：
母亲掌管记忆的一生，九位女儿则从九个方向照亮当下。

**Musagetes** 是 Apollo 的称号，意为“缪斯的引导者”，词形又恰好与
*Muse agents* 隔空押韵。作为她们的指挥者，Musagetes 会把所有活跃视角谱成两种
结构化意图：

- `RetrievalIntent`：告诉 Anamnesis，这一轮需要什么样的记忆；
- `MemoryCandidateIntent`：告诉受治理的写入路径，当前内容是否值得进入候选记忆。

一轮对话可以同时响起多位 Muse 的声音。Musagetes 负责谱曲；持久记忆的权威仍由
Mnemosyne 与治理路径掌握。

这套命名在 Delos 上合成了一个完整的圆：Delos 是 Apollo 的出生地，于是 Musagetes
自然住在这座岛上；Mnemosyne 与她的九位女儿，又为岛上的记忆带来了家族、合唱与历史。

| Muse | 她的视角 | 她保护的连续性 |
| --- | --- | --- |
| **Calliope** | 叙事与长篇连续性 | 故事弧、创作工程、世界观，以及跨越许多轮对话的 AU 或 realm 连续性。 |
| **Clio** | 历史与来源 | 发生过什么、何时改变、由哪份证据支持，以及哪一个版本才是当前状态。 |
| **Erato** | 爱、欲望与亲密 | 关系和成人亲密情境的连续性，让敏感内容始终停留在授权场景内。 |
| **Euterpe** | 日常声音与节奏 | 对话的语气、温度、习惯和日常质感，让 AI 每天醒来仍有熟悉的声音。 |
| **Melpomene** | 痛苦、冲突与修复 | 把困难时刻、关系破裂、后果与后来发生的修复共同留在完整历史中。 |
| **Polyhymnia** | 仪式、誓言与身份权威 | 承诺、高权威边界、反复出现的仪式，以及定义“我们是谁”的内容。 |
| **Terpsichore** | 身体与运动 | 姿态、位置、动作和空间连续性，把每个动作连接成一段完整场景。 |
| **Thalia** | 玩笑与幽默 | 打趣、荒诞、meme 和共同形成的喜剧语言，保存玩笑的语境与本意。 |
| **Urania** | 系统与抽象思维 | 技术工程、学术推理、架构、模型，以及维系复杂项目的概念关系。 |

### Muse 怎样一起工作

一段长期展开的虚构场景可以同时让 **Calliope** 维护故事弧，让
**Terpsichore** 保持身体与动作连续，让 **Euterpe** 保持说话的声音。如果场景后来
进入带着玩笑的和解，**Thalia** 和 **Melpomene** 也会加入这支合唱。

一场技术项目讨论则可能让 **Urania** 理解系统结构，让 **Clio** 管理来源与版本历史，
再由 **Polyhymnia** 标记一项具有约束力的设计决定。Musagetes 会把这些信号谱成一份
有主声部也有和声的意图。

Muse trace 会以临时评估证据的身份自然消退；持久记忆只保留面向使用者的证据，让内部
评分留在幕后。

## 整套系统怎样连接

```text
Transcript evidence ───────> Episode Projection（可重建）
          │                            │
          │                       episode heads
          │                            │
当前 scene ────────────> 九位 Muse ────┘
                              │
                         Musagetes
                     ┌────────┴─────────┐
                     ▼                  ▼
             RetrievalIntent    MemoryCandidateIntent
                     │                  │
                     ▼                  ▼
                Anamnesis          持久决策队列
                     ▲                  │
                     │                  ▼
                     └─────────── Mnemosyne ─────> Lethe
                                          │
                                          ▼
                              append-only 事件 + 可重建视图
```

- **Mnemosyne** 负责持久记忆及其完整生命周期。
- **Anamnesis** 只召回当前这一轮有资格出现的记忆。
- **Lethe** 让过时或未经授权的记忆安静下来，同时保留它们在历史中的位置；物理删除
  走另一条独立授权路径。
- **Episode Projection** 把 transcript evidence 整理成可以重建的 episode heads；
  Mnemosyne 负责把合格候选提升为长时记忆。
- **Musagetes 与九位 Muse** 理解此刻并生成意图，确认权与生命周期权留在治理层。

规范性的依赖方向见[架构文档](docs/ARCHITECTURE.md)。

## 安装

从公开 GitHub 仓库直接安装：

```sh
npm install github:Gwendolenmave/mnemosyne
```

也可以安装 release 附带的压缩包：

```sh
npm install ./delos-mnemosyne-0.1.0-dev.0.tgz
```

两种方式都可由普通 npm 客户端匿名安装，并暴露相同的 ESM 入口和 TypeScript 声明。
GitHub 安装会在安装过程中从源码构建；release tarball 已经携带准备好的 JavaScript
build。

## 在本地试运行

### 环境要求

- Node.js **22.22 或更新版本**
- npm
- Python 3 仅用于发布隐私扫描器

在源码目录中运行：

```sh
npm ci
npm run example:local
```

示例会创建一份临时 SQLite 记忆权威库，注册合成 owner policy，写入一条受治理的
记忆，再通过 Anamnesis 将它召回，最后删除临时数据。

预期的应用输出：

```json
{"written":"ok","approval":"policy_activated","retrieved":1,"auditSelected":1}
```

Node 22 还可能输出自己的 `node:sqlite` experimental warning。

运行完整本地验收：

```sh
npm run verify
```

## 从其他 runtime 调用 Mnemosyne

Mnemosyne 以记忆库的形式交付。宿主通过明确的 port 提供模型供应商、transcript
evidence、时钟、transport、备份位置、audit sink 与部署 policy。

在本地 workspace 中完成构建与链接后：

```ts
import {
  Anamnesis,
  Governance,
  SqliteMnemosyne,
} from "@delos/mnemosyne";

const handle = SqliteMnemosyne.openMnemosyne("./local-state/mnemosyne.db");

const governance = new Governance.MnemosyneGovernanceService({
  store: handle.store,
  backup: (label) => createVerifiedBackup(label),
  audit: (metadata) => writeMetadataOnlyAudit(metadata),
});

const packet = Anamnesis.buildMemoryReadPacket({
  source: handle.store,
  query: "the current project milestone",
  scene: { mode: "ordinary", intimacyActive: false },
  nowIso: new Date().toISOString(),
});
```

备份和 audit 函数刻意由宿主拥有。完整可运行的写入与召回示例见
[`examples/local-flow.ts`](examples/local-flow.ts)。接入真实证据或 transport 前，请先读
[集成指南](docs/INTEGRATION.md)。

## 记忆生命周期

```text
evidence
  -> candidate
  -> proposed
  -> policy_activated 或 confirmed
  -> revised / sealed / retrieval-disabled / expiry-set
  -> superseded 或 revoked
  -> 可选、需要单独授权的物理擦除
```

这些状态各自保存独立语义：

- `policy_activated` 表示一条已登记的 owner policy 授权了写入；逐项人工确认保留为
  另一种独立状态。
- `sealed` 把修改权保留给 owner 控制的路径。
- 过期、撤销、被取代或停止召回的记忆继续留在历史里，由正常召回路径跳过。
- sensitivity、scope、provenance、approval 与 lifecycle 彼此独立；即使相似度很高，
  资格门依然拥有最终约束力。

## 已包含的能力

| 领域 | 已包含 |
| --- | --- |
| 记忆治理 | 候选、policy activation、确认、修订、封存、过期、撤销、取代、provenance 与 owner 控制 |
| 召回 | 资格门、信任排序、冲突处理、预算、packet rendering 与 metadata-only audit |
| Muse 系统 | Musagetes、九种非互斥视角、scene-aware intent 与 trace exclusion |
| 持久化 | SQLite append-only event log、原子 migration、当前视图、全文搜索与完整性检查 |
| 自动化 | 不丢任务的持久决策队列、证据回读、幂等、重试、预算与 circuit breaker |
| Episode | 确定性切分、chunk、source hash、claim validation 与 AU/realm 隔离 |
| 运维 | 加密备份、隔离恢复证明、retention、删除安全、健康检查、可靠性与恢复决策 |
| 集成 | provider-neutral ports、部署 principal registry、Telegram 治理 adapter 与独立本地流程 |

[状态矩阵](docs/STATUS.md)将每项能力链接到对应实现与合成测试。

## 隐私从架构开始

运行时记忆始终属于运行宿主的人，留在宿主自己的存储与供应商边界内。

受跟踪的仓库收录源码、公开文档、schema 和明显是合成数据的 fixture；以下运行时材料
则留在宿主边界内：

- 记忆数据库、transcript、队列、trace、日志与备份；
- prompt、persona corpus、供应商响应、credential 与 key；
- principal、账号、policy、conversation identifier 与机器路径；
- 即使经过表面改写、实际仍来自私人聊天的 fixture。

模型供应商通过宿主提供的 adapter 接入记忆、Episode、治理与召回 core 的边缘。详见
[隐私模型](docs/PRIVACY-MODEL.md)与
[公开提取清单](docs/PUBLIC-EXTRACTION-MANIFEST.md)。

## 项目文档

| 文档 | 当你想要……时从这里开始 |
| --- | --- |
| [架构](docs/ARCHITECTURE.md) | 理解各层的所有权与依赖边界 |
| [集成](docs/INTEGRATION.md) | 把 Mnemosyne 接入宿主 runtime |
| [隐私模型](docs/PRIVACY-MODEL.md) | 检查仓库、运行时、audit 与网络边界 |
| [状态](docs/STATUS.md) | 按能力查看实现和测试证据 |
| [公开提取清单](docs/PUBLIC-EXTRACTION-MANIFEST.md) | 审核保留了什么、排除了哪些私密材料 |
| [来源与构建记录](docs/PROVENANCE.md) | 检查隐私清洁的 public 历史怎样建立 |
| [独立横向比较](docs/INDEPENDENT-COMPARISON.md) | 查看事后项目比较的准确边界 |
| [发布清单](docs/PUBLICATION-CHECKLIST.md) | 在保持隐私门强度的前提下准备源码发布 |

## 项目状态

这个仓库包含 Mnemosyne 的**完整源码实现**：TypeScript 源码、测试、发布工具、文档，
以及上面介绍的完整架构。它可以在本地构建、直接从 GitHub 安装，也可以制作成 release
tarball 分发。

上面介绍的每一层架构都完整包含在这一版中。当前证据见
[最终验收](docs/FINAL-VERIFICATION.md)。

## 许可证

Mnemosyne 采用 [PolyForm Noncommercial License 1.0.0](LICENSE)，以可查看源码、
仅限非商业用途的方式发布。依照许可证，可以个人使用、学习、修改和非商业分享；商业
使用需要另行取得许可。PolyForm Noncommercial 属于 source-available 许可证，与 OSI
认可的开源许可证采用不同边界；[许可证说明](LICENSE-NOTES.md)负责通俗解释，正式条款
始终以许可证原文为准。

许可人与维护者为 **Gwendolen**（GitHub：`@Gwendolenmave`）。<!-- scan:allow private:principal private:principal_alias -->

项目处于封闭维护状态，目前不接受实质性的外部代码贡献。Bug report 与负责任的安全
报告仍然欢迎；请阅读[贡献说明](CONTRIBUTING.md)与[安全政策](SECURITY.md)。
