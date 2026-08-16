/**
 * 过期思考块筛查器：思考（reasoning）内容体积大且对后续任务价值低。
 * 超过 keepTurns 轮的思考块直接移除；保留区内的思考块若超出 maxBlockChars 则裁剪。
 * 助手消息中的文本与调用块不受影响。
 */
import type { Transcript } from '../transcript.js'
import type { TriageConfig } from '../config.js'
import type { Finding } from '../verdict.js'
import { clipText } from '../condense.js'

export function screenStaleReasoning(transcript: Transcript, config: TriageConfig): Finding[] {
  const { staleReasoning } = config.screeners
  if (!staleReasoning.enabled) return []
  const findings: Finding[] = []
  transcript.messages.forEach((msg, messageIndex) => {
    if (msg.origin !== 'assistant') return
    const removeBlockIndices: number[] = []
    const replaceBlocks: Finding['replaceBlocks'] = []
    msg.blocks.forEach((block, blockIndex) => {
      if (block.type !== 'reasoning') return
      if (msg.userDistance >= staleReasoning.keepTurns) {
        removeBlockIndices.push(blockIndex)
      } else if (block.text.length > staleReasoning.maxBlockChars) {
        replaceBlocks.push({
          index: blockIndex,
          blocks: [
            {
              type: 'reasoning',
              text: clipText(block.text, staleReasoning.maxBlockChars, staleReasoning.maxBlockChars, Math.floor(staleReasoning.maxBlockChars / 3)),
            },
          ],
        })
      }
    })
    if (removeBlockIndices.length === 0 && replaceBlocks.length === 0) return
    findings.push({
      messageIndex,
      reason: 'stale-reasoning',
      detail:
        removeBlockIndices.length > 0
          ? `早于最近 ${staleReasoning.keepTurns} 轮用户消息的思考块已移除`
          : `保留思考块超出 ${staleReasoning.maxBlockChars} 字符上限，已裁剪`,
      removeBlockIndices,
      replaceBlocks,
      // 裁剪类动作豁免保留区：保留区内只剪不删
      reserveExempt: removeBlockIndices.length === 0,
    })
  })
  return findings
}
