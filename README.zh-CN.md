# Mnemosyne

<!-- scan:allow-file private:principal private:principal_alias -->

[English](README.md)

**让个人 AI 在正确的时候，因正确的理由，想起正确的事。**

Mnemosyne 是为 [Delos](https://github.com/Gwendolenmave/delos) 设计的受治理长时记忆系统。它把对话证据转化为持久记忆，保留事实随时间变化的历史，并让每条记忆只在自己有资格出现的上下文中被召回。

Mnemosyne 本地优先、与模型无关，也可以作为独立记忆库接入其他个人 AI runtime。

## Mnemosyne 能做什么

- **受治理的记忆写入。** 证据只有经过明确确认或已注册 policy 的授权路径，才会成为持久记忆。
- **保留历史真相。** 修订、取代、过期、撤销、封存和停止召回是彼此独立的生命周期事件，不会粗暴覆盖过去。
- **按上下文召回。** scope、关系或项目上下文、AU/realm、敏感度、冲突、时效和 token 预算都会在排序前先经过资格检查。
- **可恢复的持久化。** canonical memory history 采用 append-only；当前视图可以重建，并配套备份、恢复证明和健康检查。
- **宿主拥有隐私边界。** 数据库、transcript、模型供应商、policy、credential 与备份都由宿主应用掌握。

## 架构

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
                              append-only 事件 + 视图
```

Mnemosyne 掌管持久记忆生命周期；Anamnesis 负责召回当前有资格出现的记忆；Lethe 让过时或未经授权的记忆安静下来，而不是抹掉历史。Musagetes 与九位 Muse 描述此刻需要保护哪一种连续性，持久写入权仍然留在治理层。

规范性的所有权和依赖方向见[架构](docs/ARCHITECTURE.md)。

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

两种方式暴露相同的 ESM package 入口与 TypeScript 声明。

## 在本地试运行

在源码目录中：

```sh
npm ci
npm run example:local
```

示例会创建临时 SQLite store，注册合成 owner policy，写入一条受治理记忆，再通过 Anamnesis 将它召回，最后删除临时数据。

运行完整仓库验收：

```sh
npm run verify
```

正常使用只需要 Node 与 npm；完整仓库验收另外使用 Python 3 执行隐私检查。

## 从其他 runtime 调用 Mnemosyne

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

备份、audit、transport、模型供应商和部署 policy 都刻意由宿主拥有。完整可运行的写入与召回示例见 [`examples/local-flow.ts`](examples/local-flow.ts)。连接真实证据或 live transport 前，请先读[集成指南](docs/INTEGRATION.md)。

## 隐私

公开仓库只包含源码、公开文档、schema 与明确的合成 fixture。以下运行时材料留在仓库之外：

- 记忆数据库、transcript、队列、trace、日志与备份；
- prompt、persona corpus、供应商响应、credential 与 key；
- 部署 principal、真实账号标识、policy、conversation identifier 与机器路径；
- 来自私人聊天的 fixture。

运行时与网络边界详见[隐私模型](docs/PRIVACY-MODEL.md)。

## 文档

| 文档 | 用途 |
| --- | --- |
| [架构](docs/ARCHITECTURE.md) | 理解所有权、权威与依赖边界 |
| [集成](docs/INTEGRATION.md) | 把 Mnemosyne 接入宿主 runtime |
| [隐私模型](docs/PRIVACY-MODEL.md) | 理解仓库、运行时、audit 与网络边界 |
| [状态](docs/STATUS.md) | 查看已实现能力与对应测试覆盖 |
| [许可证说明](docs/LICENSING.md) | 通俗理解许可证边界 |

## 许可证

Mnemosyne 采用 [PolyForm Noncommercial License 1.0.0](LICENSE.md)，以 source-available、仅限非商业用途的方式发布。依照许可证，可以个人使用、学习、修改和非商业分享；商业使用需要另行许可。[许可证说明](docs/LICENSING.md)提供通俗解释。

许可人与维护者为 **Gwendolen**（GitHub：`@Gwendolenmave`）。

项目采用封闭维护模式。Bug report 与负责任的安全报告仍然欢迎；请阅读[贡献说明](CONTRIBUTING.md)与[安全政策](SECURITY.md)。