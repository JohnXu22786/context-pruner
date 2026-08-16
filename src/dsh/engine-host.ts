/**
 * ctx.compaction 服务提供者：把核心分诊引擎接入 dsh 的压缩能力接缝。
 * 摘要是确定性抽取式的（无模型调用），通过 compaction/start → compaction/summary
 * → 替换型 user/message → compaction/end 事务落地，替换消息使用 checkpoint 来源，
 * 与任何后端无关的消费者都能识别。
 *
 * 事务失败处理：append 失败时尽力补记 compaction/end（带 error）后以
 * ManualCompactionError('commit', …) 重抛，避免孤儿锁。
 */
import {
  CompactionEngine,
  CompactionId,
  ManualCompactionError,
  compactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
  type CompactionAgentContext,
  type CompactionResult,
  type CompactionTrigger,
  type ManualCompactAgentContext,
} from '@deepseek-ai/dsh-compaction'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { TriageConfig } from '../core/config.js'
import { chooseSpan, triage, buildSummary, type ShadowSpan, type TriageOutcome } from '../core/engine.js'
import { projectSession } from './projection.js'

const EMPTY_SUMMARY_FALLBACK: ContentBlock[] = [{ type: 'text', text: '【已归档】该区间内容已被上下文分诊移除。' }]

/**
 * 是否存在未闭合的压缩事务（compaction/start 无配对 compaction/end）。
 * 只扫描本进程接管的日志段（最后一个 session/end-seed 之后），
 * 避免 resume 会话 seed 段里崩溃遗留的孤儿 start 被误判为活跃锁。
 */
export function isCompactionActive(session: Session): boolean {
  let scanFrom = 0
  for (let i = 0; i < session.events.length; i++) {
    if (session.events[i]!.type === 'session/end-seed') scanFrom = i + 1
  }
  let open = false
  for (let i = scanFrom; i < session.events.length; i++) {
    const event = session.events[i]!
    if (event.type === 'compaction/start') open = true
    else if (event.type === 'compaction/end') open = false
  }
  return open
}

/**
 * 压缩事务归属的 turn 编号：仅当最近一个 turn 仍处于打开状态（turn/start
 * 无配对 turn/end）时填编号；turn 间隙的独立事务记 null。
 */
function transactionTurn(session: Session): number | null {
  let latestStart: number | null = null
  for (let i = 0; i < session.events.length; i++) {
    const event = session.events[i]!
    if (event.type === 'turn/start') latestStart = event.data.turn
    else if (event.type === 'turn/end') latestStart = null
  }
  return latestStart
}

export class TriageCompactionEngine extends CompactionEngine {
  constructor(ctx: Context, public readonly config: TriageConfig) {
    super(ctx)
  }

  /** 自动触发：压力/溢出时执行一次分诊；没有值得压缩的区间或压力不足时返回 null。 */
  override async compactIfNeeded(agent: CompactionAgentContext, trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult | null> {
    if (signal.aborted) return null
    if (isCompactionActive(agent.session)) return null
    const projected = projectSession(agent.session)
    const outcome = triage(projected.transcript, this.config)
    if (trigger === 'pressure' && !outcome.pressure.soft) return null
    const span = chooseSpan(outcome, this.config)
    if (!span) return null
    const summary = buildSummary(outcome, span, this.config)
    if (summary.summaryTokens >= summary.shadowedTokens) return null
    return this.commit(agent.session, projected, outcome, span, agent.options, undefined, signal)
  }

  /** 手动触发：会话空闲时也执行一次（低于压力阈值也做），无发现时返回 null。 */
  override async compactNow(agent: ManualCompactAgentContext, signal: AbortSignal, sourceCommandId?: CommandId): Promise<CompactionResult | null> {
    if (isCompactionActive(agent.session)) {
      throw new ManualCompactionError('busy', '会话中已有进行中的压缩事务')
    }
    return agent.runMaintenance(async (taskSignal) => {
      if (taskSignal.aborted) {
        throw new ManualCompactionError('cancelled', '压缩请求已取消', taskSignal.reason instanceof Error ? taskSignal.reason : undefined)
      }
      const projected = projectSession(agent.session)
      const outcome = triage(projected.transcript, this.config)
      const span = chooseSpan(outcome, this.config)
      if (!span) return null
      const summary = buildSummary(outcome, span, this.config)
      if (summary.summaryTokens >= summary.shadowedTokens) return null
      return this.commit(agent.session, projected, outcome, span, agent.options, sourceCommandId, taskSignal)
    })
  }

  /** 强制压缩指定表面区间（surface 位置，含端点）：校验配对平衡后整区间替换为摘要。 */
  override async compactRegion(start: number, end: number, agent: CompactionAgentContext, signal?: AbortSignal): Promise<CompactionResult> {
    const session = agent.session
    if (isCompactionActive(session)) {
      throw new ManualCompactionError('busy', '会话中已有进行中的压缩事务')
    }
    const projected = projectSession(session)
    const { transcript, seqs } = projected
    if (start < 0 || end < start || start >= transcript.messages.length || end >= transcript.messages.length) {
      throw new ManualCompactionError('changed', `非法压缩区间 [${start}, ${end}]（当前可见消息数 ${transcript.messages.length}）`)
    }
    if (!toolPairingBalancedBefore(session, seqs[start]!) || !toolPairingBalancedAfter(session, seqs[end]!)) {
      throw new ManualCompactionError('changed', `区间 [${start}, ${end}] 边缘存在未配对的工具调用`)
    }
    const outcome = triage(transcript, this.config)
    const span: ShadowSpan = { startIndex: start, endIndex: end }
    const summary = buildSummary(outcome, span, this.config)
    // 盈利护栏：与 compactIfNeeded/compactNow 一致，区间本地不划算即拒绝
    if (summary.summaryTokens >= summary.shadowedTokens) {
      throw new ManualCompactionError('summary', `区间 [${start}, ${end}] 无任何可节省内容，拒绝无意义压缩`)
    }
    return this.commit(session, projected, outcome, span, agent.options, undefined, signal)
  }

  /** 公共提交入口（工具/命令复用）：把分诊结果按压缩事务落地到会话日志。 */
  commit(
    session: Session,
    projected: ReturnType<typeof projectSession>,
    outcome: TriageOutcome,
    span: ShadowSpan,
    options: { provider?: string; model?: string },
    sourceCommandId: CommandId | undefined,
    signal?: AbortSignal,
  ): CompactionResult {
    if (signal?.aborted) {
      throw new ManualCompactionError('cancelled', '压缩请求已取消')
    }
    const shadowedSeqs = projected.seqs.slice(span.startIndex, span.endIndex + 1)
    if (shadowedSeqs.length === 0) {
      throw new ManualCompactionError('changed', '压缩区间为空')
    }
    const summary = buildSummary(outcome, span, this.config)
    const blocks = summary.blocks.length > 0 ? (summary.blocks as unknown as ContentBlock[]) : EMPTY_SUMMARY_FALLBACK
    const compactionId = CompactionId(`triage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
    const turn = transactionTurn(session)
    const shadowedRange = { start: shadowedSeqs[0]!, end: shadowedSeqs[shadowedSeqs.length - 1]! }
    // surface 折叠要求 sourceEventSeqs 覆盖被遮蔽区间内的**每一个**表面节点
    // （含不产生模型消息的空内容节点，如仅承载 usage 的 max-tokens 步）
    const startPos = session.surface.nodes.indexOf(shadowedRange.start)
    const endPos = session.surface.nodes.indexOf(shadowedRange.end)
    const surfaceShadowed = startPos >= 0 && endPos >= startPos ? session.surface.nodes.slice(startPos, endPos + 1) : shadowedSeqs
    // Session.append 要求 lossless-JSON：可选字段必须条件展开，不能显式 undefined
    const sourceField = sourceCommandId ? { sourceCommandId } : {}

    let startSeq: number
    let summarySeq: number
    let endSeq: number
    try {
      const startEvent = session.append('compaction/start', { compactionId, ...sourceField, turn })
      startSeq = startEvent.seq
      const summaryEvent = session.append('compaction/summary', {
        compactionId,
        ...sourceField,
        summary: blocks,
        shadowedRange,
        shadowedSeqs: surfaceShadowed,
        shadowedTokenCount: summary.shadowedTokens,
        provider: options.provider ?? 'heuristic',
        model: options.model ?? 'extractive',
      })
      summarySeq = summaryEvent.seq
      // 替换型用户消息：源为压缩检查点，sourceEventSeqs 覆盖被遮蔽的全部表面节点
      session.append(
        'user/message',
        {
          id: MessageId(`triage-${compactionId}`),
          role: 'user',
          content: blocks,
          source: compactCheckpointSource(compactionId, sourceCommandId),
        },
      {
        surfaceOp: { op: 'replace', start: shadowedRange.start, end: shadowedRange.end },
        sourceEventSeqs: surfaceShadowed,
      },
      )
      const endEvent = session.append('compaction/end', { compactionId, ...sourceField, turn })
      endSeq = endEvent.seq
    } catch (error) {
      // 尽力补记失败尝试，避免孤儿锁；补记失败则保持原样（锁扫描仍能发现未闭合事务）
      try {
        session.append('compaction/end', { compactionId, ...sourceField, turn, error: (error as Error).message })
      } catch {
        // 忽略补记失败
      }
      throw new ManualCompactionError('commit', `压缩事务写入失败：${(error as Error).message}`, error instanceof Error ? error : undefined)
    }

    return {
      compactionId,
      sourceCommandId,
      startSeq,
      summarySeq,
      endSeq,
      summary: blocks,
      shadowedRange,
      shadowedSeqs: surfaceShadowed,
      shadowedTokenCount: summary.shadowedTokens,
    }
  }
}
