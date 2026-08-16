import { describe, expect, it } from 'vitest'
import { finalizeTranscript } from '../src/core/transcript'
import { triage, buildSummary } from '../src/core/engine'
import { resolveTriageConfig } from '../src/core/config'
import { callMsg, resultMsg, userMsg } from './helpers'

describe('finalizeTranscript 边界', () => {
  it('结果先于调用（异常输入）时不成对', () => {
    const t = finalizeTranscript([
      resultMsg(0, 'c1', '结果'),
      callMsg(1, { id: 'c1', name: 'grep', arguments: '{}' }),
      userMsg(2, '最近'),
    ])
    expect(t.pairs).toHaveLength(0)
  })

  it('同一 callId 的多个结果只配对第一个', () => {
    const t = finalizeTranscript([
      callMsg(0, { id: 'c1', name: 'grep', arguments: '{}' }),
      resultMsg(1, 'c1', '结果一'),
      resultMsg(2, 'c1', '结果二'),
      userMsg(3, '最近'),
    ])
    expect(t.pairs).toHaveLength(1)
    expect(t.pairs[0]!.resultMessageIndex).toBe(1)
  })

  it('缺 isError 字段的结果按成功处理', () => {
    const t = finalizeTranscript([
      callMsg(0, { id: 'c1', name: 'grep', arguments: '{}' }),
      {
        seq: 1,
        role: 'user',
        origin: 'tool-result',
        blocks: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }],
      },
      userMsg(2, '最近'),
    ])
    expect(t.pairs[0]!.isError).toBe(false)
  })

  it('空输入安全', () => {
    const t = finalizeTranscript([])
    expect(t.messages).toEqual([])
    expect(t.pairs).toEqual([])
  })

  it('无用户消息时全部 userDistance 为 0', () => {
    const t = finalizeTranscript([callMsg(0, { id: 'c1', name: 'grep' }), resultMsg(1, 'c1', 'x')])
    expect(t.messages.every((m) => m.userDistance === 0)).toBe(true)
  })
})

describe('triage 空与极端输入', () => {
  it('空转录安全返回', () => {
    const out = triage(finalizeTranscript([]), resolveTriageConfig({ budget: { minSavingsTokens: 0 } }))
    expect(out.audit.entries).toHaveLength(0)
    expect(out.rewritten.messages).toEqual([])
    expect(out.pressure.ratio).toBe(0)
  })

  it('无用户消息的转录：保留区（默认 3 轮）保护全部内容', () => {
    const t = finalizeTranscript([callMsg(0, { id: 'c1', name: 'grep', arguments: '{}' }), resultMsg(1, 'c1', 'x')])
    const out = triage(t, resolveTriageConfig({ screeners: { staleOutput: { turns: 0 } } }))
    expect(out.audit.entries).toHaveLength(0)
  })

  it('hardRatio 触发路径', () => {
    const t = finalizeTranscript([userMsg(0, '你好')])
    const out = triage(t, resolveTriageConfig({ budget: { contextTokens: 1, softRatio: 0.5, hardRatio: 0.8 } }))
    expect(out.pressure.hard).toBe(true)
  })

  it('buildSummary 的 capChars 裁剪路径不抛错且不超限', () => {
    const t = finalizeTranscript([userMsg(0, 'X'.repeat(5000)), userMsg(1, '最近')])
    const cfg = resolveTriageConfig({
      budget: { minSavingsTokens: 0 },
      summary: { capChars: 200, headRatio: 0.4 },
    })
    const out = triage(t, cfg)
    // 无发现 → span 为 null，直接验证 buildSummary 的强制区间行为
    const summary = buildSummary(out, { startIndex: 0, endIndex: 0 }, cfg)
    expect(summary.blocks[0]!.text.length).toBeLessThanOrEqual(200)
  })
})
