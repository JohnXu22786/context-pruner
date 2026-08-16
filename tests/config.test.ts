import { describe, expect, it } from 'vitest'
import { DEFAULT_TRIAGE_CONFIG, resolveTriageConfig } from '../src/core/config'

describe('resolveTriageConfig', () => {
  it('无输入时返回完整默认值', () => {
    const c = resolveTriageConfig()
    expect(c.enabled).toBe(true)
    expect(c.reserve.turns).toBe(DEFAULT_TRIAGE_CONFIG.reserve.turns)
    expect(c.budget.softRatio).toBeLessThan(c.budget.hardRatio)
    expect(c.screeners.staleOutput.turns).toBeGreaterThan(0)
    expect(c.exempt.tools.length).toBeGreaterThan(0)
  })

  it('部分覆盖时保留其余默认值', () => {
    const c = resolveTriageConfig({ reserve: { turns: 9 } })
    expect(c.reserve.turns).toBe(9)
    expect(c.budget.contextTokens).toBe(DEFAULT_TRIAGE_CONFIG.budget.contextTokens)
  })

  it('校验：保留区轮次不能为负', () => {
    expect(() => resolveTriageConfig({ reserve: { turns: -1 } })).toThrow()
  })

  it('校验：softRatio 必须小于 hardRatio 且在 (0,1]', () => {
    expect(() => resolveTriageConfig({ budget: { softRatio: 0.8, hardRatio: 0.7 } })).toThrow()
    expect(() => resolveTriageConfig({ budget: { softRatio: 0 } })).toThrow()
    expect(() => resolveTriageConfig({ budget: { hardRatio: 1.5 } })).toThrow()
  })

  it('校验：contextTokens 必须为正数', () => {
    expect(() => resolveTriageConfig({ budget: { contextTokens: 0 } })).toThrow()
    expect(() => resolveTriageConfig({ budget: { contextTokens: -100 } })).toThrow()
  })

  it('校验：字符上限必须为正数', () => {
    expect(() => resolveTriageConfig({ screeners: { oversizedBlock: { capChars: 0 } } })).toThrow()
    expect(() => resolveTriageConfig({ screeners: { failedCall: { errorKeepChars: -5 } } })).toThrow()
  })

  it('校验：headChars 与 tailChars 之和必须小于 capChars', () => {
    expect(() =>
      resolveTriageConfig({
        screeners: { oversizedBlock: { capChars: 100, headChars: 80, tailChars: 80 } },
      }),
    ).toThrow()
  })

  it('校验：summary.headRatio 必须在 (0,1)', () => {
    expect(() => resolveTriageConfig({ summary: { headRatio: 0 } })).toThrow()
    expect(() => resolveTriageConfig({ summary: { headRatio: 1 } })).toThrow()
  })

  it('enabled:false 仍返回合法配置', () => {
    expect(resolveTriageConfig({ enabled: false }).enabled).toBe(false)
  })

  it('显式 undefined 数值字段被拒绝（不静默覆盖默认值）', () => {
    expect(() => resolveTriageConfig({ reserve: { turns: undefined } })).toThrow()
    expect(() => resolveTriageConfig({ budget: { softRatio: undefined } })).toThrow()
    expect(() => resolveTriageConfig({ screeners: { staleOutput: { turns: undefined } } })).toThrow()
  })

  it('非数字数值字段被拒绝', () => {
    expect(() => resolveTriageConfig({ reserve: { turns: '3' as never } })).toThrow()
    expect(() => resolveTriageConfig({ budget: { contextTokens: NaN } })).toThrow()
  })
})
