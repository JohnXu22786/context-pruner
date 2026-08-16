/**
 * 审计报告：每次分诊产生一份，统计处理规模、按原因汇总并逐条列出明细。
 */
import type { Origin } from './transcript.js'
import { REASON_LABELS, type ScreeningReason } from './verdict.js'

export interface AuditEntry {
  seq: number
  origin: Origin
  verdict: 'excise' | 'rewrite'
  reason: ScreeningReason
  detail: string
  /** 真实 token 增量（可能为负：如摘要比被替换的调用块更贵，由整对/整组的节省弥补）。 */
  savedTokens: number
}

export interface AuditReport {
  originalTokens: number
  rewrittenTokens: number
  savedTokens: number
  /** 节省占比（0-100）。 */
  savedPercent: number
  excisedMessages: number
  rewrittenMessages: number
  entries: AuditEntry[]
  byReason: Record<ScreeningReason, { count: number; savedTokens: number }>
}

export function emptyAudit(): AuditReport {
  return {
    originalTokens: 0,
    rewrittenTokens: 0,
    savedTokens: 0,
    savedPercent: 0,
    excisedMessages: 0,
    rewrittenMessages: 0,
    entries: [],
    byReason: {
      repeated: { count: 0, savedTokens: 0 },
      stale: { count: 0, savedTokens: 0 },
      failed: { count: 0, savedTokens: 0 },
      oversized: { count: 0, savedTokens: 0 },
      'stale-reasoning': { count: 0, savedTokens: 0 },
    },
  }
}

/** 渲染为可读文本（CLI、工具与 /triage 命令输出复用）。 */
export function renderAuditText(audit: AuditReport): string {
  const lines: string[] = []
  lines.push('上下文分诊审计')
  lines.push(
    `原始转录约 ${audit.originalTokens} tokens，处理后约 ${audit.rewrittenTokens} tokens，` +
      `节省 ${audit.savedTokens} tokens（${audit.savedPercent.toFixed(1)}%）`,
  )
  lines.push(`切除消息 ${audit.excisedMessages} 条，改写消息 ${audit.rewrittenMessages} 条`)
  lines.push('按原因统计：')
  for (const [reason, stat] of Object.entries(audit.byReason)) {
    lines.push(`  ${REASON_LABELS[reason as ScreeningReason]}: ${stat.count} 条，节省 ${stat.savedTokens} tokens`)
  }
  if (audit.entries.length > 0) {
    lines.push('明细：')
    for (const e of audit.entries) {
      const delta = e.savedTokens >= 0 ? `-${e.savedTokens}` : `+${-e.savedTokens}`
      lines.push(
        `  [seq ${e.seq} | ${e.origin}] ${REASON_LABELS[e.reason]} → ${e.verdict === 'excise' ? '切除' : '改写'}（${delta} tokens）：${e.detail}`,
      )
    }
  }
  return lines.join('\n')
}
