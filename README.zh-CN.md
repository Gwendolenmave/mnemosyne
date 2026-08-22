# Mnemosyne

<!-- scan:allow-file private:principal private:principal_alias -->

[English](README.md)

**让个人 AI 在正确的时候，因正确的理由，想起正确的事。**

很多“AI 记忆”方案只解决了一件事：**找一段和当前消息相似的旧文本。** 真正长期使用时，麻烦远不止这些。

旧事实过期了怎么办？一段记忆只属于某个项目或虚构世界怎么办？某句话只是被提到过，并不等于应该成为持久事实，怎么办？一句话本身没错，但如果被召回到错误的关系或场景里，又怎么办？

Mnemosyne 就是围绕这些问题设计的。

| 你遇到的问题 | Mnemosyne 的做法 | 为什么重要 |
| --- | --- | --- |
| 向量库把新旧事实一起留着 | **Lifecycle + supersession** | “周一”可以保留为历史证据，同时“周四”成为当前事实 |
| 相似度高，不代表现在有资格出现 | **先过 eligibility gates，再排序** | scope、项目、关系、AU/realm、敏感度、时效和 authority 先决定“能不能出现” |
| “AI 看见过”悄悄变成“AI 决定这是真的” | **受治理写入** | evidence、proposal、policy activation、confirmation、durable memory 是不同状态 |
| 记忆为什么被召回很难追 | **Provenance + metadata-only audit** | 可以追到来源和决策路径，而不是再造一套隐藏记忆库 |
| 索引坏了就等于记忆没了 | **Append-only authority + 可重建 projection** | 当前视图和搜索索引都可以从 durable event 重建 |
| 记忆系统和某个聊天模型绑死 | **Host-owned ports** | 可以接在 Delos 或其他 runtime 后面，而不接管 provider、transport、persona 或 UI |

Mnemosyne 最初为 [Delos](https://github.com/Gwendolenmave/delos) 构建，但它本身与模型无关，也可以独立接入其他个人 AI runtime。

## 一条记忆到底怎么“成为记忆”

假设一个项目会议原来在周一，现在改到了周四。

```text
“会议现在改到周四。”
        │
        ▼
Transcript evidence 保存原始来源
        │
        ▼
Candidate 提议一条持久事实
        │
        ▼
确认或已注册 policy 为它授权
        │
        ▼
周四取代周一，成为当前事实
        │
        ▼
下一次符合条件时，Anamnesis 召回周四
```

周一不会被粗暴删掉。它仍然作为历史证据存在，并保留“它曾经有效、后来为何不再有效”的信息。

这就是 Mnemosyne 的核心：**记忆不是 text + similarity，而是 evidence + authority + lifecycle + context + recall rules。**

## 这些神话名字不是装饰

Mnemosyne 取名自希腊神话中的记忆女神、九位缪斯的母亲。系统把这组名字当作职责地图：

- **Mnemosyne**：掌管 durable memory 和完整 lifecycle；
- **Anamnesis**：负责 recall，先判断哪些 memory 现在有资格出现，再排序；
- **Lethe**：描述那些正常情况下不该再被召回的 memory——expired、revoked、superseded、retrieval-disabled——但不会假装历史从未发生；
- **Musagetes**：把当前活跃的 Muse lens 组合成 retrieval intent 和 candidate-writing intent；
- **九位 Muse**：描述此刻需要保护哪一种连续性，例如叙事、历史、亲密、日常声音、修复、誓言、身体场景、玩笑或系统思维。

```text
Transcript evidence ───────> Episode Projection
          │                         │
当前 scene ────────────> Muses ─────┘
                            │
                       Musagetes
                    ┌───────┴────────┐
                    ▼                ▼
            RetrievalIntent   MemoryCandidateIntent
                    │                │
                    ▼                ▼
               Anamnesis        受治理决策路径
                    ▲                │
                    └──────── Mnemosyne ─────> Lethe
                                      │
                                      ▼
                              append-only event + views
```

如果你是在修改实现边界，请把 [Architecture](docs/ARCHITECTURE.md) 当作规范合同。README 是给人看的地图，Architecture 是给施工机和维护者看的硬规则。

## 安装

需要 **Node.js 22.22 或更新版本**。

直接从 GitHub 安装：

```sh
npm install github:Gwendolenmave/mnemosyne
```

也可以安装 release tarball：

```sh
npm install ./delos-mnemosyne-0.1.0-dev.0.tgz
```

两种方式暴露相同的 ESM package 入口和 TypeScript 声明。

## 不接整个助手，也可以先试

在源码目录中：

```sh
npm ci
npm run example:local
```

示例会创建一个临时 SQLite store，注册合成 owner policy，写入一条受治理记忆，再通过 Anamnesis 将它召回，最后把临时数据删掉。

完整仓库验收：

```sh
npm run verify
```

正常使用只需要 Node 与 npm；完整仓库验收还会用 Python 3 跑隐私检查。

## 接到其他 runtime

Mnemosyne 刻意**不拥有**你的模型供应商、transcript transport、clock、backup destination、audit sink 或 deployment policy。这些边界由 host 提供。

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

完整可运行的写入与召回例子见 [`examples/local-flow.ts`](examples/local-flow.ts)。接入真实 evidence 或 live transport 前，请先读 [Integration](docs/INTEGRATION.md)。

## 隐私：真实数据归 host 所有

公开仓库只包含源码、公开文档、schema 和明确的合成 fixture。以下运行时材料留在仓库之外：

- memory database、transcript、queue、trace、log 与 backup；
- prompt、persona corpus、provider response、credential 与 key；
- deployment principal、真实账号标识、policy、conversation identifier 与机器路径；
- 来自私人聊天的 fixture。

完整边界见 [Privacy model](docs/PRIVACY-MODEL.md)。

## 文档导航

| 文档 | 解决什么问题 |
| --- | --- |
| [Architecture](docs/ARCHITECTURE.md) | 给施工机/维护者看的 ownership、authority、dependency 硬规则 |
| [Integration](docs/INTEGRATION.md) | host 怎样提供 evidence、storage、policy 和 transport 边界 |
| [Privacy model](docs/PRIVACY-MODEL.md) | 哪些数据留在 host，哪些可能经过网络 |
| [Status](docs/STATUS.md) | 哪些能力已经实现、测试在哪里 |
| [Licensing notes](docs/LICENSING.md) | 通俗理解许可证边界 |

## 许可证与维护

Mnemosyne 使用 [PolyForm Noncommercial License 1.0.0](LICENSE.md)。依照许可证，可以进行个人使用、学习、修改和非商业分享；商业使用需要另行许可。[Licensing notes](docs/LICENSING.md) 提供通俗解释。

许可人与维护者为 **Gwendolen**（GitHub：`@Gwendolenmave`）。

项目采用封闭维护模式。Bug report 与负责任的安全报告仍然欢迎；见 [Contributing](CONTRIBUTING.md) 和 [Security](SECURITY.md)。
