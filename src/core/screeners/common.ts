/**
 * 筛查器共享工具：保留区判定、豁免判定、参数规范化。
 */
import type { MessageLike, Transcript, ToolPair } from '../transcript.js'
import type { TriageConfig } from '../config.js'

/** 保留区判定：userDistance 小于保留轮次的内容不接受任何处理。 */
export function isReserved(message: MessageLike, config: TriageConfig): boolean {
  return message.userDistance < config.reserve.turns
}

/** 工具名豁免。 */
export function isExemptTool(name: string, config: TriageConfig): boolean {
  return config.exempt.tools.includes(name)
}

/** glob 转正则：双星号匹配任意路径，单星号匹配段内任意，问号匹配单字符；双星号加斜杠前缀同时匹配根级。 */
function globToRegExp(pattern: string): RegExp {
  let re = ''
  let i = 0
  // 双星号加斜杠前缀（glob 的 "**/" 形式）同时匹配根级，不要求路径段
  if (pattern.startsWith('**/')) {
    re += '(?:.*/)?'
    i = 3
  }
  for (; i < pattern.length; i++) {
    const ch = pattern[i]!
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*'
        i++
      } else {
        re += '[^/\\\\]*'
      }
    } else if (ch === '?') {
      re += '.'
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`)
}

/** 调用参数中的文件路径（filePath 或 path 字段）是否命中豁免清单。 */
export function isExemptFilePath(pair: ToolPair, config: TriageConfig): boolean {
  if (config.exempt.filePatterns.length === 0) return false
  let path: unknown
  try {
    const args = JSON.parse(pair.argsText) as Record<string, unknown>
    path = args.filePath ?? args.path
  } catch {
    return false
  }
  if (typeof path !== 'string' || path.length === 0) return false
  return config.exempt.filePatterns.some((p) => globToRegExp(p).test(path))
}

/** pair 级保留区检查：调用与结果消息都必须在保留区之外。 */
export function isPairReserved(transcript: Transcript, pair: ToolPair, config: TriageConfig): boolean {
  const callMsg = transcript.messages[pair.callMessageIndex]
  const resultMsg = transcript.messages[pair.resultMessageIndex]
  return isReserved(callMsg!, config) || isReserved(resultMsg!, config)
}

/** 稳定序列化：对象键排序，保证语义相同的参数（书写顺序不同）判为重复。 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** 参数规范化：JSON 可解析则按规范形比较，否则按原文比较。 */
export function canonicalArgs(argsText: string): string {
  try {
    return canonicalJson(JSON.parse(argsText))
  } catch {
    return argsText
  }
}
