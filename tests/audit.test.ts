import { describe, expect, it } from 'vitest'
import { renderAuditText } from '../src/core/audit'
import { triage } from '../src/core/engine'
import { resolveTriageConfig } from '../src/core/config'
import { buildTranscript, callMsg, resultMsg, userMsg } from './helpers'

function active(): ReturnType<typeof resolveTriageConfig> {
  return resolveTriageConfig({
    reserve: { turns: 0 },
    budget: { minSavingsTokens: 0 },
    screeners: { staleOutput: { turns: 1 } },
  })
}

describe('renderAuditText', () => {
  it('输出包含摘要统计与逐条明细', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'grep', arguments: '{"p":"x"}' }),
      resultMsg(1, 'c1', 'W'.repeat(600)),
      userMsg(2, '最近'),
    )
    const out = triage(t, active())
    const text = renderAuditText(out.audit)
    expect(text).toContain('tokens')
    expect(text).toContain('grep')
    expect(text).toContain('已归档')
  })

  it('空审计也能渲染', () => {
    const t = buildTranscript(userMsg(0, 'hi'))
    const out = triage(t, active())
    expect(renderAuditText(out.audit)).toContain('0')
  })

  it('节省比例非负', () => {
    const t = buildTranscript(userMsg(0, 'hi'))
    const out = triage(t, active())
    expect(out.audit.savedPercent).toBeGreaterThanOrEqual(0)
  })
})
