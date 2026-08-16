import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseSessionJsonl } from '../src/cli/format'
import { resolveTriageConfig } from '../src/core/config'
import { chooseSpan, triage, buildSummary } from '../src/core/engine'
import { renderAuditText } from '../src/core/audit'

const samplePath = resolve(__dirname, '../examples/session.sample.jsonl')
const demoConfig = resolveTriageConfig(JSON.parse(readFileSync(resolve(__dirname, '../examples/demo.config.json'), 'utf8')))

describe('端到端：示例会话回放', () => {
  const transcript = parseSessionJsonl(readFileSync(samplePath, 'utf8'))
  const outcome = triage(transcript, demoConfig)

  it('示例文件可解析且包含预期的消息数', () => {
    expect(transcript.messages.length).toBe(24)
    // 3 条真实用户消息
    expect(transcript.messages.filter((m) => m.origin === 'user').length).toBe(3)
  })

  it('重复调用对被整体切除（t2 与其结果消失，保留 t9）', () => {
    const seqs = outcome.rewritten.messages.map((m) => m.seq)
    expect(seqs).not.toContain(3) // t2 调用
    expect(seqs).not.toContain(4) // t2 结果
    const kept = outcome.rewritten.messages.find((m) => m.seq === 22) // t9 结果
    expect(kept).toBeDefined()
  })

  it('过期输出被归档为摘要而非删除（t1 归档，t3 内容太小不值得归档）', () => {
    const archived = outcome.rewritten.messages.filter((m) => m.blocks.some((b) => b.type === 'text' && b.text.includes('已归档')))
    expect(archived).toHaveLength(1) // 只有 t1（构建日志大）值得归档
    expect(archived[0]!.blocks.some((b) => b.type === 'text' && b.text.includes('bash'))).toBe(true)
    // t3（package.json 读取，内容小）保持原样
    const t3 = outcome.rewritten.messages.find((m) => m.seq === 5)
    expect(t3?.blocks.some((b) => b.type === 'tool-call' && b.name === 'read_file')).toBe(true)
  })

  it('失败调用的参数被清除，错误文本保留', () => {
    const stub = outcome.rewritten.messages.find((m) => m.seq === 9)
    const stubText = stub?.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')
    expect(stubText).toContain('bash')
    expect(stubText).not.toContain('npm test')
    const errMsg = outcome.rewritten.messages.find((m) => m.seq === 10)
    const innerText = errMsg?.blocks.flatMap((b) => (b.type === 'tool-result' ? b.content.map((c) => (c.type === 'text' ? c.text : '')) : []))
    expect(innerText?.join('')).toContain('FAIL src/__tests__/utils.test.ts')
  })

  it('超大结果块被头尾裁剪', () => {
    const clipped = outcome.rewritten.messages.find((m) => m.seq === 12)
    const innerText = clipped?.blocks.flatMap((b) => (b.type === 'tool-result' ? b.content.map((c) => (c.type === 'text' ? c.text : '')) : []))
    expect(innerText?.join('')).toContain('省略')
  })

  it('过期思考块被移除，保留区思考块原样保留', () => {
    const oldReasoning = outcome.rewritten.messages.filter((m) => m.seq < 14 && m.blocks.some((b) => b.type === 'reasoning'))
    expect(oldReasoning).toHaveLength(0)
    const newReasoning = outcome.rewritten.messages.filter((m) => m.seq >= 14 && m.blocks.some((b) => b.type === 'reasoning'))
    expect(newReasoning.length).toBeGreaterThanOrEqual(3)
  })

  it('保留区（最后 1 个用户轮次）内容原样保留', () => {
    const lastUser = outcome.rewritten.messages.find((m) => m.origin === 'user' && m.seq === 14)
    expect(lastUser?.blocks[0]).toEqual({ type: 'text', text: '修好构建，然后给 CLI 加一个 --version 参数' })
    const editResult = outcome.rewritten.messages.find((m) => m.seq === 17)
    expect(editResult).toBeDefined()
    // t8 构建成功输出原样保留
    const t8 = outcome.rewritten.messages.find((m) => m.seq === 19)
    expect(t8?.blocks[0]).toBeDefined()
  })

  it('豁免清单内的 edit 调用不受任何筛查器影响', () => {
    const editCall = outcome.rewritten.messages.find((m) => m.seq === 17)
    expect(editCall?.blocks.some((b) => b.type === 'tool-call' && b.name === 'edit')).toBe(true)
    const editResult = outcome.rewritten.messages.find((m) => m.seq === 18)
    expect(editResult).toBeDefined()
  })

  it('审计报告自洽且节省量大于零', () => {
    expect(outcome.audit.savedTokens).toBeGreaterThan(0)
    expect(outcome.audit.savedPercent).toBeGreaterThan(0)
    const sum = Object.values(outcome.audit.byReason).reduce((a, v) => a + v.savedTokens, 0)
    expect(sum).toBe(outcome.audit.savedTokens)
    expect(renderAuditText(outcome.audit)).toContain('tokens')
  })

  it('chooseSpan 与 buildSummary 可产出压缩范围', () => {
    const span = chooseSpan(outcome, demoConfig)
    expect(span).not.toBeNull()
    const summary = buildSummary(outcome, span!, demoConfig)
    expect(summary.blocks.length).toBeGreaterThan(0)
    expect(summary.shadowedTokens).toBeGreaterThan(summary.summaryTokens)
    expect(summary.blocks.every((b) => b.type === 'text')).toBe(true)
  })
})
