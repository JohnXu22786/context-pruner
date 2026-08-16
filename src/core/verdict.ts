/**
 * 判决模型：筛查器产出「发现」（Finding），引擎合并为逐消息「判决」（Verdict）。
 */
import type { BlockLike } from './transcript.js'

export type ScreeningReason = 'repeated' | 'stale' | 'failed' | 'oversized' | 'stale-reasoning'

export type VerdictKind = 'retain' | 'excise' | 'rewrite'

/** 将原索引处的块替换为一组新块。 */
export interface BlockReplacement {
  index: number
  blocks: BlockLike[]
}

/**
 * 一条筛查发现：对某条消息的一组块级操作。
 * 同一消息可能被多个筛查器命中，引擎负责合并与优先级裁决（删除优先于改写）。
 */
export interface Finding {
  messageIndex: number
  reason: ScreeningReason
  detail: string
  /** 需要移除的块索引（原消息块索引）。 */
  removeBlockIndices: number[]
  /** 需要替换的块（原消息块索引 → 新块）。 */
  replaceBlocks: BlockReplacement[]
  /**
   * 原子组：同一组内的发现必须整组生效或整组放弃（用于调用对级别的动作，
   * 如"归档 = 调用改写 + 结果切除"不可拆分），组净节省 ≤ 0 时整组丢弃。
   */
  atomicKey?: string
  /**
   * 保留区豁免：命中后不受引擎的保留区过滤（保留区内"只剪不删"类动作，
   * 如思考块裁剪——裁剪只缩短内容，不破坏模型的近期工作集）。
   */
  reserveExempt?: boolean
}

/** 一条消息的最终判决。 */
export interface MessageVerdict {
  messageIndex: number
  verdict: VerdictKind
  /** 触发原因（retain 时为 null）。 */
  reason: ScreeningReason | null
  /** rewrite 时的完整新块列表（excise/retain 时为 null）。 */
  blocks: BlockLike[] | null
}

export const REASON_LABELS: Record<ScreeningReason, string> = {
  repeated: '重复调用',
  stale: '过期输出',
  failed: '失败调用',
  oversized: '超长块',
  'stale-reasoning': '过期思考',
}
