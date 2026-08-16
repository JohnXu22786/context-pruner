/**
 * 失败调用筛查器：过期的错误结果保留错误信息，但输入参数替换为失败桩
 * （参数往往体积大且可能敏感），错误文本裁剪到 errorKeepChars 以内。
 */
import type { Transcript } from '../transcript.js'
import type { TriageConfig } from '../config.js'
import type { Finding } from '../verdict.js'
import { clipText, makeFailureStubBlock } from '../condense.js'
import { estimateBlockTokens } from '../tokens.js'
import { isExemptFilePath, isExemptTool, isPairReserved } from './common.js'

export function screenFailedCalls(transcript: Transcript, config: TriageConfig): Finding[] {
  const { failedCall } = config.screeners
  if (!failedCall.enabled) return []
  const findings: Finding[] = []
  for (const pair of transcript.pairs) {
    if (!pair.isError) continue
    if (isExemptTool(pair.name, config) || isExemptFilePath(pair, config)) continue
    const callMsg = transcript.messages[pair.callMessageIndex]!
    if (callMsg.userDistance < failedCall.turns) continue
    if (isPairReserved(transcript, pair, config)) continue

    const resultMsg = transcript.messages[pair.resultMessageIndex]!
    const resultBlock = resultMsg.blocks[pair.resultBlockIndex]
    if (resultBlock?.type !== 'tool-result') continue

    // 错误文本裁剪：头部保留（错误摘要通常在开头）
    const clippedContent = resultBlock.content.map((b) =>
      b.type === 'text'
        ? { type: 'text' as const, text: clipText(b.text, failedCall.errorKeepChars, failedCall.errorKeepChars, Math.floor(failedCall.errorKeepChars / 3)) }
        : b,
    )
    const stubBlock = makeFailureStubBlock(pair.name)
    const clippedResultBlock = { type: 'tool-result' as const, toolCallId: resultBlock.toolCallId, content: clippedContent, isError: true }
    const callBlock = callMsg.blocks[pair.callBlockIndex]

    // 严格"值得"检查：桩+裁剪后的结果必须比原参数+原错误文本更小。
    if (estimateBlockTokens([stubBlock, clippedResultBlock]) >= estimateBlockTokens([callBlock!, resultBlock])) continue

    const detail = `工具 ${pair.name} 的失败调用（输入参数已清理，错误文本保留）`
    const atomicKey = `failed:${pair.callId}`
    findings.push({
      messageIndex: pair.callMessageIndex,
      reason: 'failed',
      detail,
      removeBlockIndices: [],
      replaceBlocks: [{ index: pair.callBlockIndex, blocks: [stubBlock] }],
      atomicKey,
    })
    findings.push({
      messageIndex: pair.resultMessageIndex,
      reason: 'failed',
      detail,
      removeBlockIndices: [],
      replaceBlocks: [
        {
          index: pair.resultBlockIndex,
          blocks: [clippedResultBlock],
        },
      ],
      atomicKey,
    })
  }
  return findings
}
