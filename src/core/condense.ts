/**
 * 浓缩改写器：全部为确定性、无模型依赖的抽取式处理。
 * 每种动作都有明确标记，模型可以从标记中知道内容被归档/裁剪过。
 */
import type { BlockLike, TextBlockLike, Transcript } from './transcript.js'

/** 裁剪时的省略标记预算（保证输出不超过 capChars）。 */
const ELLIPSIS_BUDGET = 40

/**
 * 头尾裁剪：超过 capChars 的文本保留头部与尾部，中间以省略标记连接。
 * 不变式：输出长度 ≤ capChars（capChars 过小时退化为纯头部截断）。
 */
export function clipText(text: string, capChars: number, headChars: number, tailChars: number): string {
  if (text.length <= capChars) return text
  if (capChars <= 0) return ''
  if (capChars <= ELLIPSIS_BUDGET) {
    // 预算不足以容纳省略标记：纯头部截断 + 单字符省略号，仍保证 ≤ capChars
    const head = Math.max(0, capChars - 1)
    return `${text.slice(0, head)}…`
  }
  const usable = capChars - ELLIPSIS_BUDGET
  const head = Math.min(headChars, Math.floor(usable * 0.6))
  const tail = Math.min(tailChars, usable - head)
  const headText = text.slice(0, head)
  const tailText = text.slice(text.length - tail)
  const omitted = text.length - head - tail
  const marker = `\n……（省略 ${omitted} 字符）……\n`
  // marker 长度随位数增长，硬保证总长不超过 capChars
  const budgetLeft = capChars - headText.length - tailText.length
  const clippedMarker = marker.length <= budgetLeft ? marker : `${marker.slice(0, Math.max(0, budgetLeft - 1))}…`
  return `${headText}${clippedMarker}${tailText}`
}

/** 过期输出归档块：标注工具名、原始规模与结果头部（参数内容刻意不写入）。 */
export function makeStaleDigestBlock(name: string, originalTokens: number, headText: string): TextBlockLike {
  const head = headText.trim()
  const snippet = head.length > 0 ? `\n${head.slice(0, 120)}` : ''
  return {
    type: 'text',
    text: `【已归档】早前的工具调用 ${name}（参数已归档，原文约 ${originalTokens} tokens）的结果摘要：${snippet}`,
  }
}

/** 失败调用桩：只保留工具名，参数内容被刻意排除（可能包含敏感或超大输入）。 */
export function makeFailureStubBlock(name: string): TextBlockLike {
  return {
    type: 'text',
    text: `【调用失败】工具 ${name} 的输入参数已清理，错误信息保留在下方结果中。`,
  }
}

/**
 * 从一组块中抽取摘要文本：文本原样、调用压缩为标记、结果内容保留、思考剔除。
 */
export function extractSummaryText(blocks: readonly BlockLike[]): string[] {
  const out: string[] = []
  for (const b of blocks) {
    switch (b.type) {
      case 'text':
        out.push(b.text)
        break
      case 'tool-call':
        out.push(`【调用 ${b.name}】`)
        break
      case 'tool-result': {
        const inner = b.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n')
        out.push(`【结果${b.isError ? '（错误）' : ''}】\n${inner}`)
        break
      }
      case 'reasoning':
      default:
        break
    }
  }
  return out
}
