/**
 * 离线回放 CLI：不依赖 dsh，直接对一份 JSONL 会话文件运行分诊引擎，
 * 输出审计报告与（可选）改写后的转录。用于本地体验与回归验证。
 *
 * 用法：
 *   node lib/cli/replay.js <会话文件> [--config <配置JSON>] [--show-transcript] [--json]
 */
import { readFileSync } from 'node:fs'
import { parseSessionJsonl, renderTranscriptText } from './format.js'
import { resolveTriageConfig } from '../core/config.js'
import { triage, chooseSpan, buildSummary } from '../core/engine.js'
import { renderAuditText } from '../core/audit.js'

interface CliOptions {
  transcriptFile: string
  configFile?: string
  showTranscript: boolean
  json: boolean
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { transcriptFile: '', showTranscript: false, json: false }
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    switch (arg) {
      case '--config': {
        const value = argv[++i]
        if (value === undefined) {
          console.error('--config 缺少参数值')
          process.exit(2)
        }
        opts.configFile = value
        break
      }
      case '--show-transcript':
        opts.showTranscript = true
        break
      case '--json':
        opts.json = true
        break
      case '--help':
      case '-h':
        printUsage()
        process.exit(0)
      default:
        rest.push(arg)
    }
  }
  if (rest.length !== 1) {
    printUsage()
    process.exit(2)
  }
  opts.transcriptFile = rest[0]!
  return opts
}

function printUsage(): void {
  console.log(`用法：node lib/cli/replay.js <会话.jsonl> [选项]
选项：
  --config <文件>      配置 JSON（结构与 core/config 的 TriageConfig 一致）
  --show-transcript    输出分诊后的转录文本
  --json               输出机器可读的审计 JSON
  --help               显示本帮助`)
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2))
  const transcript = parseSessionJsonl(readFileSync(opts.transcriptFile, 'utf8'))
  const config = resolveTriageConfig(opts.configFile ? (JSON.parse(readFileSync(opts.configFile, 'utf8')) as never) : undefined)
  const outcome = triage(transcript, config)
  const span = chooseSpan(outcome, config)

  if (opts.json) {
    const payload = {
      pressure: outcome.pressure,
      span: span ? { startIndex: span.startIndex, endIndex: span.endIndex } : null,
      audit: outcome.audit,
      summary: span ? buildSummary(outcome, span, config) : null,
    }
    console.log(JSON.stringify(payload, null, 2))
    return
  }

  console.log(renderAuditText(outcome.audit))
  if (span) {
    const summary = buildSummary(outcome, span, config)
    console.log(`\n建议压缩区间：消息 [${span.startIndex}..${span.endIndex}]（原文约 ${summary.shadowedTokens} tokens → 摘要约 ${summary.summaryTokens} tokens）`)
  }
  if (opts.showTranscript) {
    console.log('\n===== 分诊后的转录 =====')
    console.log(renderTranscriptText(outcome.rewritten))
  }
}

main()
