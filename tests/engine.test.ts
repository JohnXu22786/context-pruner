import { describe, expect, it } from 'vitest'
import { chooseSpan, triage, buildSummary } from '../src/core/engine'
import { resolveTriageConfig } from '../src/core/config'
import { buildTranscript, callMsg, resultMsg, userMsg } from './helpers'

/** 全开筛查的最小配置（阈值收紧以便触发；minSavings 归零避免样本规模干扰）。 */
function active(): ReturnType<typeof resolveTriageConfig> {
  return resolveTriageConfig({
    reserve: { turns: 1 },
    budget: { minSavingsTokens: 0 },
    screeners: {
      staleOutput: { turns: 1 },
      failedCall: { turns: 0, errorKeepChars: 100 },
      oversizedBlock: { capChars: 300, headChars: 60, tailChars: 30 },
      staleReasoning: { keepTurns: 1, maxBlockChars: 200 },
    },
  })
}

/** 大体积结果，保证过期归档通过"值得"检查。 */
const BIG = 'Y'.repeat(800)

describe('triage', () => {
  it('禁用时原样返回', () => {
    const t = buildTranscript(callMsg(0, { id: 'c1', name: 'grep', arguments: '{"p":"x"}' }), resultMsg(1, 'c1', '输出'), userMsg(2, '最近'))
    const out = triage(t, resolveTriageConfig({ enabled: false }))
    expect(out.audit.entries).toHaveLength(0)
    expect(out.rewritten.messages).toEqual(t.messages)
  })

  it('重复调用对整体移除：旧调用消息与其结果消息都被切除', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'grep', arguments: '{"p":"x"}' }),
      resultMsg(1, 'c1', '旧输出'),
      callMsg(2, { id: 'c2', name: 'grep', arguments: '{"p":"x"}' }),
      resultMsg(3, 'c2', '新输出'),
      userMsg(4, '最近'),
    )
    const out = triage(t, active())
    const seqs = out.rewritten.messages.map((m) => m.seq)
    expect(seqs).not.toContain(0)
    expect(seqs).not.toContain(1)
    expect(seqs).toEqual([2, 3, 4])
    const excised = out.audit.entries.filter((e) => e.verdict === 'excise')
    expect(excised).toHaveLength(2)
  })

  it('过期输出被改写为归档摘要而非删除', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'grep', arguments: '{"p":"x"}', reasoning: '旧思考' }),
      resultMsg(1, 'c1', BIG),
      userMsg(2, '最近'),
    )
    const out = triage(t, active())
    const rewritten = out.rewritten.messages
    expect(rewritten).toHaveLength(2) // 归档消息 + 用户消息
    const archived = rewritten[0]!
    expect(archived.seq).toBe(0)
    expect(archived.blocks.every((b) => b.type === 'text')).toBe(true)
    expect(archived.blocks[0]!.text).toContain('grep')
    expect(archived.blocks[0]!.text).toContain('已归档')
  })

  it('保留区内容不受影响（最近的调用对原样保留）', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'grep', arguments: '{"p":"x"}' }),
      resultMsg(1, 'c1', '输出'),
      callMsg(2, { id: 'c2', name: 'grep', arguments: '{"p":"y"}' }),
      resultMsg(3, 'c2', '输出'),
      userMsg(4, '最近'),
    )
    const out = triage(t, active())
    expect(out.rewritten.messages.map((m) => m.seq)).toEqual([0, 1, 2, 3, 4])
  })

  it('重复与过期同时命中时删除优先于改写', () => {
    // c1 与 c2 参数相同（重复）且 c1 已过期；c1 应被切除而非归档
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'grep', arguments: '{"p":"x"}' }),
      resultMsg(1, 'c1', '旧输出'),
      callMsg(2, { id: 'c2', name: 'grep', arguments: '{"p":"x"}' }),
      resultMsg(3, 'c2', '新输出'),
      userMsg(4, '最近'),
    )
    const out = triage(t, active())
    expect(out.rewritten.messages.map((m) => m.seq)).toEqual([2, 3, 4])
  })

  it('失败调用的参数被清除而错误文本保留', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'bash', arguments: `{"cmd":"${'x'.repeat(300)}"}` }),
      resultMsg(1, 'c1', '错误信息', true),
      userMsg(2, '最近'),
    )
    const out = triage(t, active())
    const callMsgNow = out.rewritten.messages.find((m) => m.seq === 0)!
    expect(callMsgNow.blocks[0]!.text).not.toContain('x'.repeat(50))
    expect(callMsgNow.blocks[0]!.text).toContain('bash')
    const resultMsgNow = out.rewritten.messages.find((m) => m.seq === 1)!
    const inner = resultMsgNow.blocks[0] as { content?: Array<{ text?: string }> }
    expect(inner.content?.[0]?.text).toBe('错误信息')
  })

  it('压力计算正确（soft/hard 阈值）', () => {
    const t = buildTranscript(userMsg(0, '你好'))
    const small = triage(t, active())
    expect(small.pressure.soft).toBe(false)
    expect(small.pressure.hard).toBe(false)
    const tiny = resolveTriageConfig({ budget: { contextTokens: 1, softRatio: 0.5, hardRatio: 0.9 } })
    const big = triage(t, tiny)
    expect(big.pressure.soft).toBe(true)
  })

  it('审计按原因汇总且总数一致', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'grep', arguments: '{"p":"x"}', reasoning: 'R'.repeat(400) }),
      resultMsg(1, 'c1', '旧输出'),
      callMsg(2, { id: 'c2', name: 'grep', arguments: '{"p":"x"}' }),
      resultMsg(3, 'c2', '新输出'),
      userMsg(4, '最近'),
    )
    const out = triage(t, active())
    const total = out.audit.byReason.repeated.count + out.audit.byReason.stale.count + out.audit.byReason['stale-reasoning'].count
    expect(total).toBe(out.audit.entries.length)
    const summed = Object.values(out.audit.byReason).reduce((acc, v) => acc + v.savedTokens, 0)
    expect(summed).toBe(out.audit.savedTokens)
  })

  it('savedPercent 与 savedTokens 自洽', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'grep', arguments: '{"p":"x"}' }),
      resultMsg(1, 'c1', '旧输出'),
      callMsg(2, { id: 'c2', name: 'grep', arguments: '{"p":"x"}' }),
      resultMsg(3, 'c2', '新输出'),
      userMsg(4, '最近'),
    )
    const out = triage(t, active())
    expect(out.audit.savedTokens).toBeGreaterThan(0)
    expect(out.audit.savedPercent).toBeCloseTo((out.audit.savedTokens / out.audit.originalTokens) * 100, 1)
  })

  it('"值得"检查：参数与错误都很小的失败调用整对保留（无负节省）', () => {
    // 失败调用但参数与错误都很小：桩+裁剪反而更大 → 整对保留
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' }),
      resultMsg(1, 'c1', '短错误', true),
      userMsg(2, '最近'),
    )
    const out = triage(t, active())
    expect(out.audit.entries).toHaveLength(0)
    expect(out.rewritten.messages.map((m) => m.seq)).toEqual([0, 1, 2])
  })

  it('同消息多筛查器命中：原因归属与块替换保持筛查器顺序（原子组不被抢占）', () => {
    // 失败调用（原子组）与超长块（非原子）命中同一结果块：
    // failed 先于 oversized，失败桩 + 错误裁剪应生效，审计归属 failed
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'bash', arguments: `{"cmd":"${'x'.repeat(300)}"}` }),
      resultMsg(1, 'c1', '错误'.repeat(300), true),
      userMsg(2, '最近'),
    )
    const out = triage(t, active())
    const resultMsgNow = out.rewritten.messages.find((m) => m.seq === 1)!
    const inner = (resultMsgNow.blocks[0] as { content?: Array<{ text?: string }> }).content
    // 错误文本按 failedCall.errorKeepChars=100 裁剪，而非 oversized 的 capChars=300
    expect(inner![0]!.text!.length).toBeLessThan(150)
    const entry = out.audit.entries.find((e) => e.seq === 1)
    expect(entry?.reason).toBe('failed')
    const callEntry = out.audit.entries.find((e) => e.seq === 0)
    expect(callEntry?.reason).toBe('failed')
  })

  it('保留区内思考块只剪不删（reserveExempt）', () => {
    const cfg = resolveTriageConfig({
      reserve: { turns: 3 },
      budget: { minSavingsTokens: 0 },
      screeners: {
        repeatedCall: { enabled: false },
        staleOutput: { enabled: false },
        failedCall: { enabled: false },
        oversizedBlock: { enabled: false },
        staleReasoning: { keepTurns: 3, maxBlockChars: 50 },
      },
    })
    // 最近的助手消息（userDistance=0，位于保留区）：超大思考块应被裁剪而非保留原样
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'grep', arguments: '{}', reasoning: 'F'.repeat(300) }),
      resultMsg(1, 'c1', '输出'),
      userMsg(2, '最近'),
    )
    const out = triage(t, cfg)
    const kept = out.rewritten.messages.find((m) => m.seq === 0)!
    const reasoning = kept.blocks.find((b) => b.type === 'reasoning') as { text: string }
    expect(reasoning).toBeDefined() // 只剪不删
    expect(reasoning.text.length).toBeLessThanOrEqual(80)
    expect(out.audit.entries.find((e) => e.seq === 0)?.reason).toBe('stale-reasoning')
  })
})

describe('chooseSpan / buildSummary', () => {
  it('无有效发现时返回 null', () => {
    const t = buildTranscript(userMsg(0, 'hi'))
    const out = triage(t, active())
    expect(chooseSpan(out, active())).toBeNull()
  })

  it('覆盖所有非保留区发现的连续区间', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'grep', arguments: '{"p":"x"}' }),
      resultMsg(1, 'c1', BIG),
      userMsg(2, '中间'),
      userMsg(3, '最近'),
    )
    const out = triage(t, active())
    const span = chooseSpan(out, active())
    expect(span).not.toBeNull()
    expect(span!.startIndex).toBe(0)
    expect(span!.endIndex).toBe(1)
  })

  it('节省量低于 minSavingsTokens 时不建议压缩', () => {
    const c = resolveTriageConfig({
      budget: { minSavingsTokens: 100000 },
      screeners: { staleOutput: { turns: 0 } },
    })
    const t = buildTranscript(callMsg(0, { id: 'c1', name: 'grep' }), resultMsg(1, 'c1', 'Z'.repeat(400)), userMsg(2, '最近'))
    const out = triage(t, c)
    expect(chooseSpan(out, c)).toBeNull()
  })

  it('buildSummary 产出文本块且规模统计正确', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'grep', arguments: '{"p":"x"}', reasoning: '旧思考' }),
      resultMsg(1, 'c1', BIG),
      userMsg(2, '最近'),
    )
    const out = triage(t, active())
    const span = chooseSpan(out, active())!
    const summary = buildSummary(out, span, active())
    expect(summary.blocks.every((b) => b.type === 'text')).toBe(true)
    expect(summary.shadowedTokens).toBeGreaterThan(0)
    expect(summary.summaryTokens).toBeGreaterThan(0)
    expect(summary.shadowedTokens).toBeGreaterThan(summary.summaryTokens)
  })
})
