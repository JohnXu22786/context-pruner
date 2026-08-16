[English](README.en.md)

# dsh-context-triage

会话上下文分诊插件，为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）自动管理长会话的上下文体积：识别并处理过期、重复、失败、超大与低价值的消息内容，节约 token 预算，缓解上下文膨胀。

## 特性

- **确定性、零模型依赖**：全部判定与改写由启发式规则完成，不调用 LLM、不需要额外服务，行为可预测、可离线测试。
- **五种筛查器（Screeners）**，各自独立可开关：
  | 筛查器 | 判定规则 | 处理动作 |
  | --- | --- | --- |
  | 过期输出 `staleOutput` | 距最近用户消息超过 N 轮、且结果仍完整的工具调用对 | 调用块改写为归档摘要，结果块移除 |
  | 重复调用 `repeatedCall` | 同工具、同参数（JSON 键序无关）的调用对 | 仅保留最近一次，旧调用对被切除 |
  | 失败调用 `failedCall` | 过期的错误结果（`isError`） | 输入参数替换为失败桩（防泄露/省体积），错误文本保留并裁剪 |
  | 超长块 `oversizedBlock` | 工具结果文本超过字符上限 | 头尾裁剪，中间标注省略量 |
  | 过期思考 `staleReasoning` | 超过保留轮次的 reasoning 块；保留的块超出长度上限 | 移除；或裁剪（保留区内只剪不删） |
- **保留区（reserve）**：最近 N 个用户轮次内的内容一概不动，避免破坏模型正在使用的上下文。
- **豁免清单（exempt）**：工具名与文件路径 glob 双维度豁免（默认保护 `task`/`skill`/`todowrite`/`todoread`/`write`/`edit`/`batch` 等有状态工具）。
- **"值得"检查**：任何归档/桩化动作都要求改写后严格小于原文，杜绝越改越贵；调用对级别的动作（归档 = 改写 + 切除）以原子组方式整体生效或整体放弃。
- **审计报告**：每次分诊输出结构化统计——按原因汇总的条数与节省量、逐条明细、建议压缩区间；通过工具、命令与 CLI 三处可见。
- **原生接入 dsh 压缩接缝**：实现 `ctx.compaction`（`CompactionEngine`），自动压力、上下文溢出、手动与强制区间压缩四条路径全部走 harness 官方机制，替换型摘要消息使用 checkpoint 来源，任何后端无关的消费者都能识别。

## 安装与挂载

插件以 **bundle** 形态分发：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`（补丁内容为插入插件行，配置项可整行覆盖）。

### 在 DSH 中安装

```bash
dsh plugin --profile demo add github:JohnXu22786/context-pruner
```

方式一（本地目录挂载，推荐）：

```bash
dsh plugin --profile web add link:/绝对路径/context-pruner
```

方式二（手动补丁）：把 `cordis.patch.yml` 中的条目合并进 profile 的 `cordis.patch.yml`，或直接作为 overlay 启动：

```bash
dsh web --patch ./cordis.patch.yml
```

方式三（git 源）：

```bash
dsh plugin --profile web add "github:你的仓库/context-pruner#main"
```

挂载后可用 `dsh --profile web --dump-config` 检查插件行是否进入启动树。

> 注意：`ctx.compaction` 同一上下文只能有一个提供者。若你的 profile 已加载其他压缩实现（如自带的基础压缩后端），请通过补丁 `disabled: true` 关掉其一，二者不能共存。

## 接口

### 入口（manifest）

| 项 | 值 |
| --- | --- |
| 包名 | `dsh-context-triage`（`package.json` 的 `dsh.bundle.patch` 声明 bundle） |
| 主入口 | `lib/index.js`（`main`/`exports`；另有 `./core` 与 `./dsh` 子路径供嵌入方使用） |
| 插件名 | `context-triage` |
| 依赖注入 | `tools`（必需）；命令注册表通过 `ctx.get('commands')` 可选探测，无则静默跳过 |
| 配置 | 导出 `Config`（Schemastery Schema），默认值见下文配置表 |

插件形态为函数式插件：导出 `name` / `inject` / `Config` / `apply(ctx, config)`，由 cordis 校验配置并填充默认值后调用。

### 提供的扩展点

| 扩展点 | 说明 |
| --- | --- |
| 服务 `ctx.compaction` | `TriageCompactionEngine extends CompactionEngine`，实现 `compactIfNeeded`（自动压力 / 溢出）、`compactNow`（手动空闲压缩）、`compactRegion`（强制区间压缩） |
| 工具 `triage_history` | 模型可见；参数 `dryRun?: boolean`。执行一次分诊并把审计报告返回给模型；`dryRun=false` 且存在值得处理的区间时直接应用 |
| 命令 `/triage` | 人类命令，不经过模型；输出审计报告并应用值得的处理 |

### 压缩事务如何落地

分诊结果以标准压缩事务写入会话日志（append-only，不改写历史）：

1. `compaction/start`（持锁，直到配对的 `compaction/end`）
2. `compaction/summary`（摘要内容、被遮蔽区间、遮蔽 seq 清单与启发式 token 代价；`llmStreamCall` 缺省 = 非模型摘要）
3. `user/message` + `surfaceOp: { op: 'replace', start, end }` + `sourceEventSeqs`（替换型摘要消息，`source` 为 checkpoint 来源）
4. `compaction/end`

模型可见历史由会话日志派生，替换发生后 `deriveMessages()` 自然产出 `[摘要消息, ...保留内容]`——无需任何对历史记录的原地修改。

## 配置

全部字段有默认值，仅需覆盖想调整的部分；非法值（负轮次、比率越界等）在加载期直接抛错。示例：

```yaml
# cordis.patch.yml
- insert:
    id: context-triage
    name: dsh-context-triage
    config:
      budget:
        contextTokens: 200000   # 小上下文模型按需调低
        softRatio: 0.6
      screeners:
        staleOutput: { turns: 5 }
        staleReasoning: { enabled: false }
      exempt:
        tools: [task, skill, write, edit]
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `reserve.turns` | `3` | 保留区：最近 N 个用户轮次内的内容不接受任何处理 |
| `budget.contextTokens` | `1000000` | 预估上下文窗口（token），决定压力比率 |
| `budget.softRatio` | `0.7` | 使用率超过该比例 → 自动压缩触发（pressure） |
| `budget.hardRatio` | `0.9` | 使用率超过该比例 → 压力报告标记为强制（hard）等级 |
| `budget.minSavingsTokens` | `2000` | 预估节省低于该值不做任何动作 |
| `screeners.staleOutput.turns` | `8` | 距最近用户消息超过 N 轮的调用对归档 |
| `screeners.repeatedCall.enabled` | `true` | 重复调用切除 |
| `screeners.failedCall.turns` | `4` | 失败调用处理阈值（轮） |
| `screeners.failedCall.errorKeepChars` | `400` | 失败调用保留的错误文本上限（字符） |
| `screeners.oversizedBlock.capChars` | `6000` | 工具结果文本上限（字符），超出则头尾裁剪 |
| `screeners.oversizedBlock.headChars` / `tailChars` | `800` / `400` | 裁剪保留的头部/尾部长度 |
| `screeners.staleReasoning.keepTurns` | `3` | 保留最近 N 轮用户消息内的思考块 |
| `screeners.staleReasoning.maxBlockChars` | `2000` | 保留思考块的长度上限，超出裁剪 |
| `exempt.tools` | `[task, skill, todowrite, todoread, write, edit, batch]` | 豁免工具名 |
| `exempt.filePatterns` | `[]` | 豁免路径 glob（匹配调用参数 `filePath`/`path`），如 `['**/*.lock']` |
| `summary.capChars` | `20000` | 压缩摘要字符上限 |
| `summary.headRatio` | `0.4` | 摘要裁剪时的头部保留比例 |

## 本地体验（无需 dsh）

`src/core` 是框架无关的引擎，附离线回放 CLI，可直接对一份 JSONL 会话文件运行：

```bash
npm install
npm run build
node lib/cli/replay.js examples/session.sample.jsonl --config examples/demo.config.json
node lib/cli/replay.js examples/session.sample.jsonl --config examples/demo.config.json --show-transcript
```

回放格式（每行一个 JSON 事件，seq 由行序决定）：

```jsonl
{"type":"user/message","text":"项目构建失败了"}
{"type":"assistant/message","reasoning":"…","calls":[{"id":"c1","name":"bash","arguments":"{\"cmd\":\"npm run build\"}"}]}
{"type":"tool/result","callId":"c1","text":"…","isError":false}
```

示例输出见 [examples/report.example.md](examples/report.example.md)；测试覆盖全部筛查器、合并优先级、原子组、审计一致性与端到端回放（`npm test`）。

## 设计取舍

- **token 估算是启发式**：CJK 约 1 token/字、其余约 4 字符/token，仅用于压力判断与审计统计，不参与计费。窗口大小请按实际模型配置 `budget.contextTokens`。
- **改写必有净节省**：归档摘要、失败桩、裁剪三者都在动作前比较改写前后规模，不划算的发现被自动放弃；调用对动作以原子组整体判定，不会出现"摘要留下、结果被拆"的半吊子状态。
- **提示缓存**：压缩会改变消息序列，使该点之后的提示缓存前缀失效。长会话中节省的 token 通常远大于缓存重算成本；对按请求计费的提供商（无缓存计费）则只有收益。
- **不碰用户输入**：超长块筛查只作用于工具结果；用户消息除非被整体保留区覆盖，否则永不被改写。

## 许可

本项目基于 [MIT](LICENSE) 许可开源。
