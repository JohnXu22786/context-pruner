[简体中文](README.zh.md)

# dsh-context-triage

A session context triage plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) that automatically manages context volume during long sessions: it identifies and handles stale, duplicate, failed, oversized, and low-value message content to save token budget and curb context bloat.

## Features

- **Deterministic, zero model dependency**: all verdicts and rewrites are produced by heuristic rules—no LLM calls, no extra services; behavior is predictable and testable offline.
- **Five Screeners**, each independently switchable:
  | Screener | Verdict rule | Handling action |
  | --- | --- | --- |
  | Stale output `staleOutput` | Tool call pairs more than N turns after the latest user message, with results still complete | Call block rewritten to an archive summary, result block removed |
  | Repeated call `repeatedCall` | Call pairs with the same tool and same arguments (JSON key order irrelevant) | Only the most recent is kept; older call pairs are cut |
  | Failed call `failedCall` | Stale error results (`isError`) | Input arguments replaced with a failure stub (prevents leakage / saves space), error text kept and trimmed |
  | Oversized block `oversizedBlock` | Tool result text exceeds the character cap | Head/tail trimmed, middle annotated with the omitted amount |
  | Stale reasoning `staleReasoning` | Reasoning blocks beyond the retention turns; kept blocks exceeding the length cap | Removed; or trimmed (within the reserve region only trim, never delete) |
- **Reserve area (`reserve`)**: content within the most recent N user turns is never touched, avoiding disruption of context the model is currently using.
- **Exemption list (`exempt`)**: two-dimensional tool-name and file-path glob exemption (protects stateful tools like `task`/`skill`/`todowrite`/`todoread`/`write`/`edit`/`batch` by default).
- **"Worth it" check**: any archive/stub action requires the rewrite to be strictly smaller than the original, ruling out changes that cost more; call-pair-level actions (archive = rewrite + cut) take effect or are abandoned as atomic groups.
- **Audit report**: every triage outputs structured statistics—counts and savings per reason, per-item details, and suggested compression ranges; visible through the tool, the command, and the CLI.
- **Native integration with the dsh compression seam**: implements `ctx.compaction` (`CompactionEngine`); auto-pressure, context overflow, manual, and forced region compression all go through the official harness mechanism. Replacement summary messages use a checkpoint source recognized by any backend-agnostic consumer.

## Installation and mounting

The plugin is distributed as a **bundle**: `dsh.bundle.patch` in `package.json` points to `cordis.patch.yml` (the patch inserts the plugin line; config can be overridden on the line).

### Installing in DSH

```bash
dsh plugin --profile demo add github:JohnXu22786/context-pruner
```

Option 1 (mount from a local directory, recommended):

```bash
dsh plugin --profile web add link:/absolute/path/context-pruner
```

Option 2 (manual patch): merge the entry in `cordis.patch.yml` into the profile's `cordis.patch.yml`, or launch it directly as an overlay:

```bash
dsh web --patch ./cordis.patch.yml
```

Option 3 (git source):

```bash
dsh plugin --profile web add "github:your-repo/context-pruner#main"
```

After mounting, use `dsh --profile web --dump-config` to check whether the plugin line reaches the startup tree.

> Note: `ctx.compaction` allows only one provider per context. If your profile already loads another compression implementation (e.g., the built-in base compression backend), disable one of them via the patch's `disabled: true`—they cannot coexist.

## Interface

### Entry point (manifest)

| Item | Value |
| --- | --- |
| Package name | `dsh-context-triage` (`dsh.bundle.patch` in `package.json` declares the bundle) |
| Main entry | `lib/index.js` (`main`/`exports`; `./core` and `./dsh` subpaths available for embedders) |
| Plugin name | `context-triage` |
| Dependency injection | `tools` (required); the command registry is optionally probed via `ctx.get('commands')`, silently skipped if absent |
| Config | Exports `Config` (Schemastery Schema); defaults in the config table below |

The plugin is a functional plugin: it exports `name` / `inject` / `Config` / `apply(ctx, config)`, called by cordis after validating config and filling defaults.

### Provided extension points

| Extension point | Description |
| --- | --- |
| Service `ctx.compaction` | `TriageCompactionEngine extends CompactionEngine`, implementing `compactIfNeeded` (auto-pressure / overflow), `compactNow` (manual idle compression), `compactRegion` (forced region compression) |
| Tool `triage_history` | Model-visible; parameter `dryRun?: boolean`. Runs one triage and returns the audit report to the model; with `dryRun=false` and a worth-handling region present, applies it directly |
| Command `/triage` | Human command, bypasses the model; outputs the audit report and applies worthwhile handling |

### How a compression transaction lands

Triage results are written to the session log as a standard compression transaction (append-only; history is not rewritten):

1. `compaction/start` (holds the lock until the paired `compaction/end`)
2. `compaction/summary` (summary content, masked regions, masked seq list, and heuristic token cost; `llmStreamCall` absent = non-model summary)
3. `user/message` + `surfaceOp: { op: 'replace', start, end }` + `sourceEventSeqs` (replacement summary message, `source` is the checkpoint source)
4. `compaction/end`

The model-visible history is derived from the session log; after the replacement, `deriveMessages()` naturally yields `[summary message, ...retained content]`—no in-place modification of historical records is needed.

## Configuration

All fields have defaults; only override what you want to adjust. Invalid values (negative turns, out-of-range ratios, etc.) throw at load time. Example:

```yaml
# cordis.patch.yml
- insert:
    id: context-triage
    name: dsh-context-triage
    config:
      budget:
        contextTokens: 200000   # lower for smaller-context models
        softRatio: 0.6
      screeners:
        staleOutput: { turns: 5 }
        staleReasoning: { enabled: false }
      exempt:
        tools: [task, skill, write, edit]
```

| Field | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `reserve.turns` | `3` | Reserve area: content within the most recent N user turns is not processed |
| `budget.contextTokens` | `1000000` | Estimated context window (tokens); determines the pressure ratio |
| `budget.softRatio` | `0.7` | Usage above this ratio → auto-compression triggers (pressure) |
| `budget.hardRatio` | `0.9` | Usage above this ratio → pressure report marked forced (hard) grade |
| `budget.minSavingsTokens` | `2000` | No action when estimated savings are below this |
| `screeners.staleOutput.turns` | `8` | Call pairs more than N turns after the latest user message are archived |
| `screeners.repeatedCall.enabled` | `true` | Repeated calls cut |
| `screeners.failedCall.turns` | `4` | Failed-call handling threshold (turns) |
| `screeners.failedCall.errorKeepChars` | `400` | Error text kept for failed calls (chars) |
| `screeners.oversizedBlock.capChars` | `6000` | Tool result text cap (chars); beyond it, head/tail trimmed |
| `screeners.oversizedBlock.headChars` / `tailChars` | `800` / `400` | Head/tail length kept during trimming |
| `screeners.staleReasoning.keepTurns` | `3` | Keep reasoning blocks within the most recent N user turns |
| `screeners.staleReasoning.maxBlockChars` | `2000` | Length cap for kept reasoning blocks; beyond it, trimmed |
| `exempt.tools` | `[task, skill, todowrite, todoread, write, edit, batch]` | Exempt tool names |
| `exempt.filePatterns` | `[]` | Exempt path globs (match call arguments `filePath`/`path`), e.g. `['**/*.lock']` |
| `summary.capChars` | `20000` | Compression summary char cap |
| `summary.headRatio` | `0.4` | Head retention ratio when trimming the summary |

## Local experience (no dsh required)

`src/core` is a framework-agnostic engine with an offline replay CLI; it runs directly against a JSONL session file:

```bash
npm install
npm run build
node lib/cli/replay.js examples/session.sample.jsonl --config examples/demo.config.json
node lib/cli/replay.js examples/session.sample.jsonl --config examples/demo.config.json --show-transcript
```

Replay format (one JSON event per line; seq determined by line order):

```jsonl
{"type":"user/message","text":"项目构建失败了"}
{"type":"assistant/message","reasoning":"…","calls":[{"id":"c1","name":"bash","arguments":"{\"cmd\":\"npm run build\"}"}]}
{"type":"tool/result","callId":"c1","text":"…","isError":false}
```

Sample output in [examples/report.example.md](examples/report.example.md); tests cover all screeners, merge priorities, atomic groups, audit consistency, and end-to-end replay (`npm test`).

## Design trade-offs

- **Token estimation is heuristic**: CJK ≈ 1 token/char, others ≈ 4 chars/token; used only for pressure verdicts and audit statistics, not for billing. Configure `budget.contextTokens` per your actual model window.
- **Rewrites always yield net savings**: archive summaries, failure stubs, and trimming all compare the sizes before and after the action; unattractive findings are automatically abandoned. Call-pair actions are judged as atomic groups, so there is no half-done state like "summary kept, result split."
- **Prompt caching**: compression changes the message sequence, invalidating the prompt cache prefix after that point. In long sessions, saved tokens usually vastly outweigh cache recomputation cost; for pay-per-request providers (no cache billing) it is pure gain.
- **Never touches user input**: the oversized-block screener only acts on tool results; user messages are never rewritten unless the whole reserve region covers them.

## License

Released under the [MIT License](LICENSE).