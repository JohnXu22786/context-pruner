/**
 * 过期输出筛查器：距最近用户消息超过 turns 轮的完整调用对，
 * 调用块改写为归档摘要（保留工具名/规模/结果头部），结果块移除。
 * 失败调用由 failed-call 筛查器处理，此处跳过。
 */
import type { Transcript } from '../transcript.js'
import type { TriageConfig } from '../config.js'
import type { Finding } from '../verdict.js'
import { estimateBlockTokens } from '../tokens.js'
import { makeStaleDigestBlock } from '../condense.js'
import { isExemptFilePath, isExemptTool, isPairReserved } from './common.js'

export function screenStaleOutputs(transcript: Transcript, config: TriageConfig): Finding[] {
  const { staleOutput } = config.screeners
  if (!staleOutput.enabled) return []
  const findings: Finding[] = []
  for (const pair of transcript.pairs) {
    if (pair.isError) continue
    if (isExemptTool(pair.name, config) || isExemptFilePath(pair, config)) continue
    const callMsg = transcript.messages[pair.callMessageIndex]!
    if (callMsg.userDistance < staleOutput.turns) continue
    if (isPairReserved(transcript, pair, config)) continue

    const callBlock = callMsg.blocks[pair.callBlockIndex]
    const resultMsg = transcript.messages[pair.resultMessageIndex]!
    const resultBlock = resultMsg.blocks[pair.resultBlockIndex]
    const originalTokens = estimateBlockTokens([callBlock!, resultBlock!])
    const headText = (() => {
      if (resultBlock?.type !== 'tool-result') return ''
      return resultBlock.content
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join(' ')
        .trim()
    })()
    const digestBlock = makeStaleDigestBlock(pair.name, originalTokens, headText)

    // 严格"值得"检查：摘要必须比被移除的调用块+结果块更小，否则归档反而浪费 token。
    // 引擎另有原子组校验兜底；此处在 pair 级别保证原子性。
    if (estimateBlockTokens([digestBlock]) >= originalTokens) continue

    const detail = `工具 ${pair.name} 的早前输出已归档（距离最近用户消息 ${callMsg.userDistance} 轮，阈值 ${staleOutput.turns} 轮）`
    const atomicKey = `stale:${pair.callId}`
    findings.push({
      messageIndex: pair.callMessageIndex,
      reason: 'stale',
      detail,
      removeBlockIndices: [],
      replaceBlocks: [
        {
          index: pair.callBlockIndex,
          blocks: [digestBlock],
        },
      ],
      atomicKey,
    })
    findings.push({
      messageIndex: pair.resultMessageIndex,
      reason: 'stale',
      detail,
      removeBlockIndices: [pair.resultBlockIndex],
      replaceBlocks: [],
      atomicKey,
    })
  }
  return findings
}
