# Mnemosyne

<!-- scan:allow-file private:principal private:principal_alias -->

[English](README.md)

**给个人 AI 的长期记忆，但“什么可以被记住、什么时候可以被想起”都有明确规则。**

Mnemosyne 解决的是普通 vector store 自己解决不了的那一部分。

找到“和当前消息相似的旧文本”当然有用，但长期记忆还要回答更多问题：这条事实现在还有效吗？它真的被授权成持久记忆了吗？它只属于某个项目、关系或虚构世界吗？当前场景有资格看到它吗？两条记忆冲突时，哪条是当前事实，哪条只是历史？

Mnemosyne 把这些问题拆开，而不是全塞进一个 similarity score 里。

## 从这里开始

| 我想…… | 先看这里 |
| --- | --- |
| 用一分钟理解它为什么存在 | [60 秒模型](#60-秒模型) |
| 在自己电脑上先跑一下 | [本地试跑](#本地试跑) |
| 把它接进另一个 runtime | [Integration](docs/INTEGRATION.md) |
| 看现在到底实现了哪些能力 | [Status](docs/STATUS.md) |
| 看清楚隐私与数据边界 | [Privacy model](docs/PRIVACY-MODEL.md) |
| 修改 Mnemosyne 本身 | **先读 [Architecture](docs/ARCHITECTURE.md)** |

Mnemosyne 最初为 [Delos](https://github.com/Gwendolenmave/delos) 构建，但 package 本身与模型无关，也可以嵌入其他个人 AI runtime。

## 60 秒模型

假设一个项目会议原来在周一，现在改到了周四。

普通 vector store 很可能把两句话都留下来，然后在以后查询时返回“看起来更相似”的那条。Mnemosyne 会把这次变化当成 lifecycle 变化来处理：

```text
“会议在周一。”
        │
        │ 后来
        ▼
“会议现在改到周四。”
        │
        ▼
原始 source evidence 继续保留
        │
        ▼
受治理决策让“周四”成为当前事实
        │
        ▼
“周一”留在历史里；“周四”作为当前 truth 有资格被召回
```

这里不需要假装“周一”从未被说过。真正重要的是：**历史证据和当前记忆不是同一种东西。**

这个例子基本已经包含了整套设计：

- **Evidence 不会自动变成 memory。** Transcript 里出现过，不代表它就是持久事实。
- **先判断有没有资格出现，再谈排序。** Scope、lifecycle、authority、sensitivity、expiry、关系/项目/AU 边界和 retrieval permission 先决定“能不能出现”。
- **旧事实可以被 supersede，而不是直接抹掉。** 当前 truth 会更新，历史仍然可追。
- **Index 是可重建的。** Durable event history 才是 authority；当前 view 和 search projection 都是派生状态。
- **Host 仍然拥有系统。** Mnemosyne 不接管 model provider、persona、transport、UI 或 deployment identity。

## 本地试跑

需要 **Node.js 22.22 或更新版本**。

直接从 GitHub 安装：

```sh
npm install github:Gwendolenmave/mnemosyne
```

如果想先看完整写入 + 召回流程，又不想先接整套助手，可以 clone 仓库后运行：

```sh
npm ci
npm run example:local
```

示例会创建临时 SQLite store，注册一条合成 policy，写入一条受治理 memory，再通过 Anamnesis 召回，最后清掉临时数据。

完整仓库验收：

```sh
npm run verify
```

正常使用 package 只需要 Node 和 npm；完整仓库验收还会使用 Python 3 做隐私检查。

## 把它接进 host runtime

Mnemosyne 刻意**不拥有**你的 provider、transcript transport、clock、backup destination、audit sink 或 deployment policy。这些边界都由 host 提供。

Package 从一个 ESM 入口暴露 storage、governance、recall、decision 与 automation 组件：

```ts
import {
  Anamnesis,
  SqliteMnemosyne,
} from "@delos/mnemosyne";

const handle = SqliteMnemosyne.openMnemosyne("./local-state/mnemosyne.db");

const packet = Anamnesis.buildMemoryReadPacket({
  source: handle.store,
  query: "the current project milestone",
  scene: { mode: "ordinary", intimacyActive: false },
  nowIso: new Date().toISOString(),
});
```

这段只展示 read side 的形状。完整可运行的 governed write + recall 例子在 [`examples/local-flow.ts`](examples/local-flow.ts)。接真实 evidence 或 live transport 前，请先读 [Integration](docs/INTEGRATION.md)。

## 这些名字分别负责什么

希腊神话命名只是职责地图，不是使用 package 前必须背下来的世界观。

| 名字 | 负责什么 |
| --- | --- |
| **Mnemosyne** | durable memory 的 lifecycle 与 governance |
| **Anamnesis** | recall：先过滤 eligibility，再 ranking 和 budget |
| **Lethe** | 正常情况下不该再出现的 material，但不假装历史从未发生 |
| **Musagetes** | 把当前 continuity lens 组合成 retrieval / candidate-writing intent |
| **Muses** | 描述当前时刻需要保护哪一种连续性 |

如果你是在改这些边界，请以 [Architecture](docs/ARCHITECTURE.md) 为准，不要从神话名字反推实现。

## Mnemosyne 做什么，也不做什么

Mnemosyne **会做**：

- 带 provenance、policy / confirmation 边界的 governed memory write；
- revision、expiry、revocation、supersession、retrieval disablement 和授权删除等 lifecycle 操作；
- 先做 eligibility 过滤，再进行 similarity / ranking 的 recall；
- append-only event authority，以及可重建的当前 view / index；
- metadata-only audit，避免诊断日志偷偷变成第二套 memory store。

Mnemosyne **不会做**：

- chatbot UI 或 hosted service；
- model provider 或模型账号；
- persona system；
- 接管你的 transcript 或 deployment identity；
- 自动把任意 model output / transcript text 提升成 durable truth。

## 隐私：真实数据归 host 所有

公开仓库只包含源码、公开文档、schema 和明确的合成 fixture。真实运行时数据应该留在仓库之外，包括 memory database、transcript、queue、log、backup、prompt、provider response、credential、账号标识和机器路径。

网络行为也属于 host 边界：Mnemosyne 是 library，不是云服务。仓库 / runtime / network 的完整划分见 [Privacy model](docs/PRIVACY-MODEL.md)。

## 如果你要改代码

README 是给人看的地图；[Architecture](docs/ARCHITECTURE.md) 才是给施工机和维护者的规范合同。

后续文档刻意保持很少：

- **接入 Mnemosyne：** [Integration](docs/INTEGRATION.md)
- **检查实现覆盖：** [Status](docs/STATUS.md)
- **检查仓库 / runtime / network 边界：** [Privacy model](docs/PRIVACY-MODEL.md)
- **修改 ownership、authority、lifecycle 或 dependency 规则：** [Architecture](docs/ARCHITECTURE.md)

如果实现和 Architecture 对不上，不要猜哪一边“本来应该”是真的；直接检查当前代码和测试。

## 许可证与维护

Mnemosyne 使用 [PolyForm Noncommercial License 1.0.0](LICENSE.md)。依照许可证，可以个人使用、学习、修改和非商业分享；商业使用需要另行许可。

许可人与维护者为 **Gwendolen**（GitHub：`@Gwendolenmave`）。

项目采用封闭维护模式。Bug report 与负责任的安全报告仍然欢迎；见 [Contributing](CONTRIBUTING.md) 和 [Security](SECURITY.md)。
