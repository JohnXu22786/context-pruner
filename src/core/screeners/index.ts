/**
 * 筛查器汇总入口 + 公共判定工具导出。
 */
import type { Transcript } from '../transcript.js'
import type { TriageConfig } from '../config.js'
import type { Finding } from '../verdict.js'
import { screenRepeatedCalls } from './repeated-call.js'
import { screenStaleOutputs } from './stale-output.js'
import { screenFailedCalls } from './failed-call.js'
import { screenOversizedBlocks } from './oversized-block.js'
import { screenStaleReasoning } from './stale-reasoning.js'

export * from './common.js'

/** 按固定顺序运行全部筛查器（顺序即审计原因归属的优先级）。 */
export function runScreeners(transcript: Transcript, config: TriageConfig): Finding[] {
  return [
    ...screenRepeatedCalls(transcript, config),
    ...screenStaleOutputs(transcript, config),
    ...screenFailedCalls(transcript, config),
    ...screenOversizedBlocks(transcript, config),
    ...screenStaleReasoning(transcript, config),
  ]
}
