/**
 * 超长块筛查器：超过 capChars 的工具结果文本块 → 头尾裁剪。
 * 只作用于工具结果（tool-result）的内部文本；用户文本与助手文本不在此列，
 * 避免改写用户直接输入的内容。
 */
import type { BlockLike, Transcript } from '../transcript.js'
import type { TriageConfig } from '../config.js'
import type { Finding } from '../verdict.js'
import { clipText } from '../condense.js'

export function screenOversizedBlocks(transcript: Transcript, config: TriageConfig): Finding[] {
  const { oversizedBlock } = config.screeners
  if (!oversizedBlock.enabled) return []
  const findings: Finding[] = []
  transcript.messages.forEach((msg, messageIndex) => {
    if (msg.origin !== 'tool-result') return
    msg.blocks.forEach((block, blockIndex) => {
      if (block.type !== 'tool-result') return
      let changed = false
      const clippedContent: BlockLike[] = block.content.map((b) => {
        if (b.type === 'text' && b.text.length > oversizedBlock.capChars) {
          changed = true
          return {
            type: 'text' as const,
            text: clipText(b.text, oversizedBlock.capChars, oversizedBlock.headChars, oversizedBlock.tailChars),
          }
        }
        return b
      })
      if (!changed) return
      findings.push({
        messageIndex,
        reason: 'oversized',
        detail: `工具结果超过 ${oversizedBlock.capChars} 字符上限，已头尾裁剪`,
        removeBlockIndices: [],
        replaceBlocks: [
          {
            index: blockIndex,
            blocks: [
              {
                type: 'tool-result',
                toolCallId: block.toolCallId,
                content: clippedContent,
                isError: block.isError,
              },
            ],
          },
        ],
      })
    })
  })
  return findings
}
