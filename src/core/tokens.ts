/**
 * token 估算：确定性启发式，用于预算压力与审计统计。
 * 规则：CJK 字符约 1 token/字，其余字符约 4 字符/token；调用参数按 JSON 文本估算。
 * 注意：这是估算值，仅用于决策阈值与报告，不参与任何计费。
 */
import type { BlockLike, MessageLike } from './transcript.js'

const CJK_RE = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/

export function estimateTextTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}

export function estimateBlockTokens(blocks: readonly BlockLike[]): number {
  let total = 0
  for (const b of blocks) {
    switch (b.type) {
      case 'text':
      case 'reasoning':
        total += estimateTextTokens(b.text)
        break
      case 'tool-call':
        total += estimateTextTokens(b.arguments) + Math.max(1, Math.ceil(b.name.length / 4))
        break
      case 'tool-result':
        total += estimateBlockTokens(b.content)
        break
      default:
        break // 未知块类型按 0 处理（词表可扩展）
    }
  }
  return total
}

export function estimateMessagesTokens(messages: readonly MessageLike[]): number {
  return messages.reduce((acc, m) => acc + estimateBlockTokens(m.blocks), 0)
}
