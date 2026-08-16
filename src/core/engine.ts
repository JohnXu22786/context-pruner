/**
 * 分诊引擎：筛查 → 合并判决（删除优先于改写）→ 产出改写转录与审计。
 * 纯函数、无副作用；压缩范围选择与摘要构建也在此层，供 dsh 适配层复用。
 */
import type { BlockLike, Transcript } from './transcript.js'
import { finalizeTranscript } from './transcript.js'
import type { TriageConfig } from './config.js'
import { type Finding, type MessageVerdict } from './verdict.js'
import { runScreeners, isReserved } from './screeners/index.js'
import { estimateBlockTokens, estimateMessagesTokens, estimateTextTokens } from './tokens.js'
import { clipText, extractSummaryText } from './condense.js'
import { emptyAudit, type AuditReport } from './audit.js'

export interface TriagePlan {
  verdicts: MessageVerdict[]
}

export interface TriagePressure {
  /** 预估使用率 = 转录 tokens / contextTokens。 */
  ratio: number
  soft: boolean
  hard: boolean
}

export interface TriageOutcome {
  /** 原始转录（不可变输入）。 */
  transcript: Transcript
  /** 处理后的转录。 */
  rewritten: Transcript
  plan: TriagePlan
  audit: AuditReport
  pressure: TriagePressure
}

/** 建议压缩的连续消息区间（原始转录索引，含端点）。 */
export interface ShadowSpan {
  startIndex: number
  endIndex: number
}

export function computePressure(transcript: Transcript, config: TriageConfig): TriagePressure {
  const ratio = config.budget.contextTokens > 0 ? estimateMessagesTokens(transcript.messages) / config.budget.contextTokens : 0
  return {
    ratio,
    soft: ratio >= config.budget.softRatio,
    hard: ratio >= config.budget.hardRatio,
  }
}

/** 把一组发现应用到块序列（删除优先于改写）。 */
function applyOps(blocks: readonly BlockLike[], findings: readonly Finding[]): BlockLike[] {
  const remove = new Set<number>()
  const replace = new Map<number, BlockLike[]>()
  for (const f of findings) {
    for (const idx of f.removeBlockIndices) remove.add(idx)
    for (const r of f.replaceBlocks) {
      if (!remove.has(r.index) && !replace.has(r.index)) replace.set(r.index, r.blocks)
    }
  }
  const out: BlockLike[] = []
  blocks.forEach((b, index) => {
    if (remove.has(index)) return
    const replacement = replace.get(index)
    if (replacement) out.push(...replacement)
    else out.push(b)
  })
  return out
}

/**
 * 合并单条消息上的全部发现：删除优先于改写；同一块的多组替换保留先到者。
 * 净节省护栏按「发现」生效：非原子发现独立过护栏（不搭原子组的车）；
 * 原子组成员（组净节省已在 validateAtomicGroups 校验）整组通过。
 * 顺序不变式：生效发现的相对顺序与筛查器产出顺序一致（原因归属与
 * 同块替换的"先到先得"都依赖它——原子组的 stale/failed 排在 plain 的
 * oversized/stale-reasoning 之前，不会被抢占）。
 */
function mergeFindingsForMessage(blocks: readonly BlockLike[], findings: readonly Finding[], atomicMember: boolean): MessageVerdict {
  const plain = findings.filter((f) => !f.atomicKey)
  const plainWorthIt = plain.length === 0 || estimateBlockTokens(applyOps(blocks, plain)) < estimateBlockTokens(blocks)
  // 保持原始顺序过滤：plain 中不划算的整组丢弃，原子发现全部保留
  const effective = plainWorthIt ? findings : findings.filter((f) => f.atomicKey)
  const reason = effective[0]?.reason ?? null
  const newBlocks = applyOps(blocks, effective)
  if (newBlocks.length === 0) {
    return { messageIndex: -1, verdict: 'excise', reason, blocks: null }
  }
  // 原子成员由整组校验把关；纯非原子消息的合并结果再兜底检查一次
  if (!atomicMember && estimateBlockTokens(newBlocks) >= estimateBlockTokens(blocks)) {
    return { messageIndex: -1, verdict: 'retain', reason: null, blocks: null }
  }
  return { messageIndex: -1, verdict: 'rewrite', reason, blocks: newBlocks }
}

/**
 * 原子组校验：同组发现（如"归档 = 调用改写 + 结果切除"）整组生效或整组放弃。
 * 组净节省 ≤ 0 时整组丢弃，避免 pair 动作被逐消息护栏拆散。
 */
function validateAtomicGroups(transcript: Transcript, findings: Finding[]): Finding[] {
  const groups = new Map<string, Finding[]>()
  for (const f of findings) {
    if (!f.atomicKey) continue
    const list = groups.get(f.atomicKey)
    if (list) list.push(f)
    else groups.set(f.atomicKey, [f])
  }
  if (groups.size === 0) return findings
  const dropped = new Set<string>()
  for (const [key, group] of groups) {
    const byMessage = new Map<number, Finding[]>()
    for (const f of group) {
      const list = byMessage.get(f.messageIndex)
      if (list) list.push(f)
      else byMessage.set(f.messageIndex, [f])
    }
    let net = 0
    for (const [messageIndex, fs] of byMessage) {
      const msg = transcript.messages[messageIndex]!
      net += estimateBlockTokens(msg.blocks) - estimateBlockTokens(applyOps(msg.blocks, fs))
    }
    if (net <= 0) dropped.add(key)
  }
  return findings.filter((f) => !f.atomicKey || !dropped.has(f.atomicKey))
}

export function triage(transcript: Transcript, config: TriageConfig): TriageOutcome {
  const pressure = computePressure(transcript, config)
  if (!config.enabled) {
    return {
      transcript,
      rewritten: transcript,
      plan: { verdicts: transcript.messages.map((m, messageIndex) => ({ messageIndex, verdict: 'retain', reason: null, blocks: null })) },
      audit: emptyAudit(),
      pressure,
    }
  }

  const findings = runScreeners(transcript, config)
  // 全局保留区过滤（pair 级筛查已各自检查，这里兜底单条消息目标；
  // reserveExempt 的"只剪不删"类动作放行）
  const actionable = findings.filter((f) => f.reserveExempt || !isReserved(transcript.messages[f.messageIndex]!, config))
  // 原子组校验：pair 级动作整组生效或整组放弃
  const survivors = validateAtomicGroups(transcript, actionable)

  // 按消息分组合并（顺序即审计原因归属的优先级）
  const byMessage = new Map<number, Finding[]>()
  for (const f of survivors) {
    const list = byMessage.get(f.messageIndex)
    if (list) list.push(f)
    else byMessage.set(f.messageIndex, [f])
  }
  // 含幸存原子发现的成员消息：由整组校验把关，跳过逐条护栏
  const atomicMessages = new Set<number>()
  for (const f of survivors) {
    if (f.atomicKey) atomicMessages.add(f.messageIndex)
  }

  const verdicts: MessageVerdict[] = []
  transcript.messages.forEach((msg, messageIndex) => {
    const list = byMessage.get(messageIndex)
    if (!list) {
      verdicts.push({ messageIndex, verdict: 'retain', reason: null, blocks: null })
      return
    }
    const verdict = mergeFindingsForMessage(msg.blocks, list, atomicMessages.has(messageIndex))
    verdict.messageIndex = messageIndex
    verdicts.push(verdict)
  })

  // 应用判决 → 改写转录（userDistance 与调用对索引统一重算；
  // 用户消息永远不会被修改，因此轮次距离在改写后保持稳定）
  const kept = transcript.messages
    .map((m, messageIndex) => {
      const v = verdicts[messageIndex]!
      if (v.verdict === 'excise') return null
      if (v.verdict === 'rewrite') return { ...m, blocks: v.blocks! }
      return m
    })
    .filter((m): m is NonNullable<typeof m> => m !== null)
  const rewritten = finalizeTranscript(kept)

  const audit = buildAudit(transcript, rewritten, verdicts, byMessage)

  return { transcript, rewritten, plan: { verdicts }, audit, pressure }
}

/** 逐消息统计节省量；原因与明细归属该消息第一个生效的发现。 */
function buildAudit(
  original: Transcript,
  rewritten: Transcript,
  verdicts: MessageVerdict[],
  byMessage: Map<number, Finding[]>,
): AuditReport {
  const report = emptyAudit()
  report.originalTokens = estimateMessagesTokens(original.messages)
  report.rewrittenTokens = estimateMessagesTokens(rewritten.messages)

  let savedTotal = 0
  for (const v of verdicts) {
    if (v.verdict === 'retain') continue
    const msg = original.messages[v.messageIndex]!
    const before = estimateBlockTokens(msg.blocks)
    const after = v.verdict === 'excise' ? 0 : estimateBlockTokens(v.blocks!)
    // 真实增量（可能为负：如摘要比被替换的调用块更贵，由整对/整组的节省弥补）
    const delta = before - after
    savedTotal += delta
    const reason = v.reason!
    const first = byMessage.get(v.messageIndex)?.find((f) => f.reason === reason)
    report.entries.push({
      seq: msg.seq,
      origin: msg.origin,
      verdict: v.verdict,
      reason,
      detail: first?.detail ?? reason,
      savedTokens: delta,
    })
    if (v.verdict === 'excise') report.excisedMessages++
    else report.rewrittenMessages++
    report.byReason[reason].count++
    report.byReason[reason].savedTokens += delta
  }
  // 恒等式：savedTokens 恒等于逐条增量之和（原子组内负增量也被如实计入）
  report.savedTokens = savedTotal
  report.savedPercent = report.originalTokens > 0 ? (savedTotal / report.originalTokens) * 100 : 0
  return report
}

/**
 * 选择建议压缩的连续区间：覆盖全部非保留区发现（含端点）。
 * 无发现或节省量低于 minSavingsTokens 时返回 null。
 */
export function chooseSpan(outcome: TriageOutcome, config: TriageConfig): ShadowSpan | null {
  const indices = outcome.plan.verdicts.filter((v) => v.verdict !== 'retain').map((v) => v.messageIndex)
  if (indices.length === 0) return null
  // 低于最小节省阈值或完全没有节省时不建议压缩
  if (outcome.audit.savedTokens < config.budget.minSavingsTokens || outcome.audit.savedTokens <= 0) return null
  return {
    startIndex: Math.min(...indices),
    endIndex: Math.max(...indices),
  }
}

/** 为压缩区间构建摘要文本块（跳过已切除消息），并统计规模。 */
export function buildSummary(
  outcome: TriageOutcome,
  span: ShadowSpan,
  config: TriageConfig,
): { blocks: Extract<BlockLike, { type: 'text' }>[]; shadowedTokens: number; summaryTokens: number } {
  const { transcript, plan } = outcome
  const total = transcript.messages.length
  const start = Math.max(0, span.startIndex)
  const end = Math.min(total - 1, span.endIndex)
  const shadowedTokens = start > end ? 0 : estimateMessagesTokens(transcript.messages.slice(start, end + 1))

  const texts: string[] = []
  for (let i = start; i <= end; i++) {
    const v = plan.verdicts[i]
    if (v?.verdict === 'excise') continue
    const blocks = v?.verdict === 'rewrite' ? v.blocks! : transcript.messages[i]!.blocks
    texts.push(...extractSummaryText(blocks))
  }
  let joined = texts.join('\n')
  if (joined.length > config.summary.capChars) {
    const headChars = Math.floor(config.summary.capChars * config.summary.headRatio)
    const tailChars = Math.floor(config.summary.capChars * config.summary.headRatio * 0.5)
    joined = clipText(joined, config.summary.capChars, headChars, tailChars)
  }
  const blocks = joined.length > 0 ? [{ type: 'text' as const, text: joined }] : []
  return { blocks, shadowedTokens, summaryTokens: estimateTextTokens(joined) }
}
