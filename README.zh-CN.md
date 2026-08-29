# Mnemosyne

[English](README.md)

**个人 AI 的记忆不该只是“搜到最像的一段旧文本”。Mnemosyne 让一条记忆拥有来源、寿命、权限、边界和历史。**

如果 vector search 回答的是“以前有哪些话和现在很像？”，Mnemosyne 更关心另外几个问题：**这句话够不够资格成为长期记忆？它现在还是真的吗？它属于哪个场景？此刻允许被想起吗？如果它后来变了，旧事实应该去哪？**

Mnemosyne 是一个 local-first、model-neutral 的 governed memory library。它最初为 [Delos](https://github.com/Gwendolenmave/delos) 构建，但可以嵌进别的个人 AI runtime；host 继续拥有 provider、persona、transport、UI 和部署方式。

## 一个完整例子，比功能表更快

假设一个叫 **Mira** 的人和她的助手相处了几个月。

### 1. 一句话先是 evidence，不是 memory

Mira 在普通对话里说：

> “以后坐长途火车，我默认选靠窗。”

这句话先进入 transcript evidence。它证明“这句话被说过”，但不会因为出现过就自动变成长期事实。

Retention 可以把它识别为值得长期考虑的稳定偏好；随后它仍然需要经过 candidate / proposal，以及**已注册 policy 或明确 confirmation**。只有通过 governed write path 以后，它才会产生 durable lifecycle event，并进入当前 memory projection。

### 2. 临时例外不会偷偷改写长期偏好

几周后，Mira 又说：

> “这趟和朋友一起，临时坐过道，只这一次。”

这条信息和“座位偏好”非常相似，但它的寿命不同。它可以被保留为 episodic / short-lived evidence，却不应该因为 embedding 很像，就把“默认靠窗”覆盖掉。

### 3. 虚构世界里的事实也不会漏回现实场景

晚上她进入一个叫 **Nocturne** 的 AU：

> “这个世界里的 Mira 从来不坐窗边。”

这条 evidence 属于另一个 realm。即使文本里同样出现了 “Mira”“座位”“窗边”，它也不是 ordinary scene 的候选事实。AU / realm 边界是 eligibility boundary，不是一个可以被高 similarity score 冲掉的小权重。

### 4. 真正的长期变化会更新 current truth，但不抹掉历史

两个月后，Mira 在普通对话里明确说：

> “我真的改了，以后默认坐过道。”

新的 evidence 再次经过治理。一个 revision / supersession 可以让“默认坐过道”成为当前事实，而旧的“默认靠窗”退出现行 recall。

旧事实没有被假装成“从未发生”。它仍然留在 append-only event history 里，连同 provenance、authority 和 lifecycle 变化一起可追溯；当前 view 只是由这些事件折叠出来的 projection。

### 5. 真正召回时，先判断“能不能出现”，再判断“像不像”

下一周，ordinary scene 里有人问：

> “给 Mira 订下一趟火车，座位选哪边？”

Anamnesis 会先把不合格的东西挡在 ranking 之前：

- 旧的“默认靠窗”已经被 supersede；
- “这趟临时坐过道”只是短期 / episodic exception；
- Nocturne AU 的事实不属于当前 scene；
- 只有当前、获准、scope 匹配、未过期、允许 retrieval 的 memory 才进入后续 ranking 和 budget。

最后返回的是当前普通场景有资格使用的“默认坐过道”。**哪怕某条旧句子在语义上更像当前 query，它只要不合格，就连参加排名的资格都没有。**

这就是 Mnemosyne 和“把聊天记录塞进向量库”最根本的差别：它不是尽量多地保存过去，而是维护一套**可以变化、可以追责、可以退出当前语境的记忆状态**。

## 从对话到回忆，真正的数据流

```text
transcript / structured host evidence
                 │
                 ├──> Episode Projection
                 │     （可重建的 evidence 目录，不自动获得 memory authority）
                 │
                 ▼
        retention + candidate/proposal
                 │
                 ▼
      registered policy / confirmation
                 │
                 ▼
          Mnemosyne governance
                 │
                 ▼
       append-only memory events   <── canonical authority
                 │
                 ├──> current memory projection
                 └──> search / index projections
                      （都必须可重建）

scene + query + retrieval intent
                 │
                 ▼
             Anamnesis
                 │
                 ▼
 eligibility gates
 authority / lifecycle / scope / realm /
 sensitivity / expiry / permission / conflict
                 │
                 ▼
          ranking + budget
                 │
                 ▼
          MemoryReadPacket
                 └──> metadata-only audit
```

Musagetes / Muses 可以参与生成 retrieval 或 candidate-writing intent；decision automation 也可以延迟处理 candidate、重试 provider failure。它们都不能绕过 governance，也不会因为“模型觉得这应该记住”就自动获得 durable authority。

## 先跑起来

需要 **Node.js 22.22 或更新版本**。

直接从 GitHub 安装：

```sh
npm install github:Gwendolenmave/mnemosyne
```

如果想先看一个完整的 governed write + recall，而不接整套助手：

```sh
git clone https://github.com/Gwendolenmave/mnemosyne.git
cd mnemosyne
npm ci
npm run example:local
```

这个示例会创建临时 SQLite store、注册合成 policy、写入一条受治理 memory、通过 Anamnesis 召回，然后清理临时数据。

完整仓库验收：

```sh
npm run verify
```

正常使用 package 只需要 Node 和 npm；完整仓库验收还会用 Python 3 做隐私扫描。

## 接进自己的 runtime

Package 通过一个 ESM 根入口暴露稳定概念。Host integration 应优先使用 package-root namespace，而不是依赖内部文件布局。

```ts
import {
  Anamnesis,
  Retention,
  SqliteMnemosyne,
} from "@delos/mnemosyne";

const retention = Retention.dispatchPortableRetention({
  schemaVersion: 1,
  evidenceCodes: ["stable_preference"],
  auId: null,
});

const handle = SqliteMnemosyne.openMnemosyne("./local-state/mnemosyne.db");

const packet = Anamnesis.buildMemoryReadPacket({
  source: handle.store,
  query: "the current project milestone",
  scene: { mode: "ordinary", intimacyActive: false },
  nowIso: new Date().toISOString(),
});
```

这段只展示 retention contract 和 read side 的形状。完整 governed write + recall 在 [`examples/local-flow.ts`](examples/local-flow.ts)；接真实 evidence 或 live transport 前请看 [Integration](docs/INTEGRATION.md)。

## 核心部件在负责什么

| 部件 | 职责 |
| --- | --- |
| **Mnemosyne** | durable memory 的 write authority、lifecycle 与 governance |
| **Anamnesis** | recall：先做 eligibility，再 ranking / budget |
| **Lethe** | 让 expired / revoked / superseded / retrieval-disabled material 退出普通召回，而不是伪造“从未发生” |
| **Retention** | 在进入 ordinary long-term admission 前区分短期、episodic 与可长期候选 material |
| **Curation** | KEEP / REVISE / REVOKE / RECLASSIFY_AU / SUPERSEDE / MERGE / EPISODIC_ONLY 等正式整理动作 |
| **Episode Projection** | 把 evidence 组织成可重建结构；summary 本身不自动升级成 Memory Card |
| **Musagetes / Muses** | 描述当前 continuity intent；它们影响 intent，不拥有 durable memory authority |
| **Memory event history** | canonical durable authority；current view 和 index 都是 projection |

希腊神话命名只是职责地图。真正的 ownership、dependency direction 和 failure semantics 以 [Architecture](docs/ARCHITECTURE.md) 为准。

## 五条最重要的设计原则

1. **Evidence ≠ memory。** 被说过，不等于被授权成长期事实。
2. **History ≠ current truth。** 旧事实可以退出当前记忆，但不必被抹掉。
3. **Eligibility 在 ranking 之前。** 没资格出现的 memory，不靠更高 similarity 翻盘。
4. **Model proposal ≠ authority。** 自动化可以提议、排队、重试，但不能自己授予 durable truth。
5. **Index ≠ authority。** Event history 才是 canonical；projection / index 必须可以重建。

## Mnemosyne 刻意不接管什么

Mnemosyne 是 library / subsystem，不是完整 chatbot 平台。它不拥有：

- model provider 或账号；
- persona / system prompt authority；
- transcript transport 与 UI；
- deployment principal、process supervision 或机器身份；
- backup destination、real clock、audit sink 或网络策略。

这些都属于 host。这样 memory domain 才不会和某个 Telegram bot、某台机器、某个模型账号绑死。

## 隐私与实现状态

仓库里应该只有源码、公开文档、schema 和明确的合成 fixture。真实 memory database、transcript、queue、log、backup、prompt、provider response、credential、账号标识和机器路径都应该留在仓库之外；完整边界见 [Privacy model](docs/PRIVACY-MODEL.md)。

README 只介绍系统怎么思考。**当前到底合并了哪些能力，以 [Status](docs/STATUS.md) 为准。** Spec、source、tests、package、release 和 live deployment 是不同状态；README 不把尚未合并的设计写成已经可用。

## 文档地图

| 你要做什么 | 看这里 |
| --- | --- |
| 接入自己的 host runtime | [Integration](docs/INTEGRATION.md) |
| 查看当前实现覆盖 | [Status](docs/STATUS.md) |
| 理解数据与网络边界 | [Privacy model](docs/PRIVACY-MODEL.md) |
| 修改 ownership / lifecycle / authority / dependency | [Architecture](docs/ARCHITECTURE.md) |
| 提交 bug 或安全报告 | [Contributing](CONTRIBUTING.md) / [Security](SECURITY.md) |

## 许可证与维护

Mnemosyne 使用 [PolyForm Noncommercial License 1.0.0](LICENSE.md)。依照许可证，可以个人使用、学习、修改和非商业分享；商业使用需要另行许可。

许可人与维护者为 **Gwendolen**（GitHub：`@Gwendolenmave`）。项目采用封闭维护模式，但仍欢迎 bug report 与负责任的安全报告。
