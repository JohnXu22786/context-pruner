import { describe, expect, it } from 'vitest'
import { screenStaleOutputs } from '../src/core/screeners/stale-output'
import { resolveTriageConfig } from '../src/core/config'
import { buildTranscript, callMsg, resultMsg, userMsg } from './helpers'

/** 只保留过期输出筛查；关闭保留区让 fixture 规模可控。 */
function cfg(overrides: Record<string, unknown> = {}): ReturnType<typeof resolveTriageConfig> {
  return resolveTriageConfig({
    reserve: { turns: 0 },
    screeners: { repeatedCall: { enabled: false }, failedCall: { enabled: false } },
    ...(overrides as never),
  })
}

/** 足够大的结果文本，保证归档摘要确实更小（"值得"检查通过）。 */
const BIG = 'X'.repeat(800)

describe('screenStaleOutputs', () => {
  it('距最近用户消息超过阈值的完整调用对 → 调用块替换为归档摘要、结果块移除', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'grep', arguments: '{"p":"x"}' }),
      resultMsg(1, 'c1', BIG),
      callMsg(2, { id: 'c2', name: 'grep', arguments: '{"p":"y"}' }),
      resultMsg(3, 'c2', BIG),
      userMsg(4, '最近消息'),
    )
    const findings = screenStaleOutputs(t, cfg({ screeners: { staleOutput: { turns: 1 } } }))
    expect(findings).toHaveLength(4)
    const callFinding = findings.find((f) => f.messageIndex === 0)!
    expect(callFinding.reason).toBe('stale')
    expect(callFinding.replaceBlocks).toHaveLength(1)
    expect(callFinding.replaceBlocks[0]!.index).toBe(0)
    expect(callFinding.replaceBlocks[0]!.blocks[0]!.type).toBe('text')
    const resultFinding = findings.find((f) => f.messageIndex === 1)!
    expect(resultFinding.removeBlockIndices).toContain(0)
  })

  it('阈值内的调用对不标记（turns 以用户轮次计）', () => {
    // 调用对后仅有 1 条用户消息 → userDistance=1 < turns=2 → 保留
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'grep' }),
      resultMsg(1, 'c1', BIG),
      userMsg(2, '最近消息'),
    )
    expect(screenStaleOutputs(t, cfg({ screeners: { staleOutput: { turns: 2 } } }))).toHaveLength(0)
  })

  it('turns 边界：userDistance >= turns 才归档', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'grep' }),
      resultMsg(1, 'c1', BIG),
      userMsg(2, '一'),
      userMsg(3, '二'),
    )
    // userDistance = 2
    expect(screenStaleOutputs(t, cfg({ screeners: { staleOutput: { turns: 1 } } }))).toHaveLength(2)
    expect(screenStaleOutputs(t, cfg({ screeners: { staleOutput: { turns: 3 } } }))).toHaveLength(0)
    expect(screenStaleOutputs(t, cfg({ screeners: { staleOutput: { turns: 2 } } }))).toHaveLength(2)
  })

  it('未配对（无结果）的调用不标记', () => {
    const t = buildTranscript(callMsg(0, { id: 'c1', name: 'grep', arguments: '{"p":"x"}' }), userMsg(1, '最近消息'))
    expect(screenStaleOutputs(t, cfg({ screeners: { staleOutput: { turns: 0 } } }))).toHaveLength(0)
  })

  it('豁免清单内的工具不归档', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'write', arguments: '{"filePath":"a.ts"}' }),
      resultMsg(1, 'c1', BIG),
      userMsg(2, '最近消息'),
    )
    expect(screenStaleOutputs(t, cfg({ screeners: { staleOutput: { turns: 0 } } }))).toHaveLength(0)
  })

  it('filePatterns 命中参数 filePath 的工具调用不归档', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'read_file', arguments: '{"filePath":"/repo/package-lock.json"}' }),
      resultMsg(1, 'c1', BIG),
      userMsg(2, '最近消息'),
    )
    const c = cfg({
      exempt: { filePatterns: ['**/package-lock.json'] },
      screeners: { staleOutput: { turns: 0 } },
    })
    expect(screenStaleOutputs(t, c)).toHaveLength(0)
  })

  it('filePatterns 不匹配时照常归档', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'read_file', arguments: '{"filePath":"/repo/src/main.ts"}' }),
      resultMsg(1, 'c1', BIG),
      userMsg(2, '最近消息'),
    )
    const c = cfg({
      exempt: { filePatterns: ['**/*.lock'] },
      screeners: { staleOutput: { turns: 0 } },
    })
    expect(screenStaleOutputs(t, c)).toHaveLength(2)
  })

  it('pair 级保留区检查：结果在保留区时整对跳过', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'grep', arguments: '{"p":"x"}' }),
      userMsg(1, '中间提问'),
      resultMsg(2, 'c1', BIG),
      userMsg(3, '最近消息'),
    )
    const c = cfg({
      reserve: { turns: 2 },
      screeners: { staleOutput: { turns: 0 } },
    })
    expect(screenStaleOutputs(t, c)).toHaveLength(0)
  })

  it('args 缺失时仍能归档', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'bash' }),
      resultMsg(1, 'c1', BIG),
      userMsg(2, '最近消息'),
    )
    expect(screenStaleOutputs(t, cfg({ screeners: { staleOutput: { turns: 0 } } }))).toHaveLength(2)
  })

  it('"值得"检查：内容太小的调用对不归档（摘要反而更贵）', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'grep', arguments: '{"p":"x"}' }),
      resultMsg(1, 'c1', '短'),
      userMsg(2, '最近消息'),
    )
    expect(screenStaleOutputs(t, cfg({ screeners: { staleOutput: { turns: 0 } } }))).toHaveLength(0)
  })
})
