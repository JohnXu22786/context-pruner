/**
 * 重复调用筛查器：同工具、同参数（键序无关）的调用对只保留最近一次。
 * 信息不丢失：被移除的旧调用对在更新的一次中仍完整可见。
 */
import type { Transcript } from '../transcript.js'
import type { TriageConfig } from '../config.js'
import type { Finding } from '../verdict.js'
import { canonicalArgs, isExemptFilePath, isExemptTool, isPairReserved } from './common.js'

export function screenRepeatedCalls(transcript: Transcript, config: TriageConfig): Finding[] {
  if (!config.screeners.repeatedCall.enabled) return []
  const groups = new Map<string, { name: string; pairs: { pair: (typeof transcript.pairs)[number]; key: string }[] }>()
  for (const pair of transcript.pairs) {
    if (isExemptTool(pair.name, config)) continue
    const key = `${pair.name}\u0000${canonicalArgs(pair.argsText)}`
    const hit = groups.get(key)
    if (hit) hit.pairs.push({ pair, key })
    else groups.set(key, { name: pair.name, pairs: [{ pair, key }] })
  }

  const findings: Finding[] = []
  for (const group of groups.values()) {
    if (group.pairs.length < 2) continue
    // 保留按日志顺序最后出现的一次
    group.pairs.sort((a, b) => a.pair.callMessageIndex - b.pair.callMessageIndex)
    const kept = group.pairs[group.pairs.length - 1]!
    for (const old of group.pairs.slice(0, -1)) {
      if (isPairReserved(transcript, old.pair, config)) continue
      const detail = `与 ${kept.pair.name} 的重复调用（保留最近一次，seq ${transcript.messages[kept.pair.resultMessageIndex]!.seq}）`
      findings.push({
        messageIndex: old.pair.callMessageIndex,
        reason: 'repeated',
        detail,
        removeBlockIndices: [old.pair.callBlockIndex],
        replaceBlocks: [],
      })
      findings.push({
        messageIndex: old.pair.resultMessageIndex,
        reason: 'repeated',
        detail,
        removeBlockIndices: [old.pair.resultBlockIndex],
        replaceBlocks: [],
      })
    }
  }
  return findings
}
