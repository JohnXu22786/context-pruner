import { describe, expect, it } from 'vitest'
import { screenFailedCalls } from '../src/core/screeners/failed-call'
import { resolveTriageConfig } from '../src/core/config'
import { buildTranscript, callMsg, resultMsg, userMsg } from './helpers'

function cfg(overrides: Record<string, unknown> = {}): ReturnType<typeof resolveTriageConfig> {
  return resolveTriageConfig({
    reserve: { turns: 0 },
    screeners: { repeatedCall: { enabled: false }, staleOutput: { enabled: false } },
    ...(overrides as never),
  })
}

/** 大体积参数，保证失败桩确实更小（"值得"检查通过）。 */
const BIG_ARGS = `{"cmd":"${'x'.repeat(600)}"}`

function innerTextOf(block: unknown): string {
  const b = block as { type: string; content?: Array<{ type: string; text?: string }> }
  return b.content?.map((c) => c.text ?? '').join('') ?? ''
}

describe('screenFailedCalls', () => {
  it('过期失败调用 → 调用参数替换为失败桩，错误文本保留但被裁剪', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'bash', arguments: BIG_ARGS }),
      resultMsg(1, 'c1', '很长的错误输出：'.repeat(200), true),
      userMsg(2, '最近消息'),
    )
    const findings = screenFailedCalls(t, cfg({ screeners: { failedCall: { turns: 0, errorKeepChars: 60 } } }))
    expect(findings).toHaveLength(2)
    const callFinding = findings.find((f) => f.messageIndex === 0)!
    expect(callFinding.reason).toBe('failed')
    const stub = callFinding.replaceBlocks[0]!.blocks[0]!
    expect(stub.type).toBe('text')
    expect((stub as { text: string }).text).not.toContain('x'.repeat(50))
    const resultFinding = findings.find((f) => f.messageIndex === 1)!
    const clipped = innerTextOf(resultFinding.replaceBlocks[0]!.blocks[0])
    expect(clipped.length).toBeLessThanOrEqual(60 + 40) // 原文 + 省略标记的余量
    expect(clipped).toContain('省略')
  })

  it('新近的失败调用（阈值内）不标记', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'bash', arguments: BIG_ARGS }),
      resultMsg(1, 'c1', '错误', true),
      userMsg(2, '最近消息'),
    )
    expect(screenFailedCalls(t, cfg({ screeners: { failedCall: { turns: 2 } } }))).toHaveLength(0)
  })

  it('成功调用不标记', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'bash', arguments: BIG_ARGS }),
      resultMsg(1, 'c1', '输出', false),
      userMsg(2, '最近消息'),
    )
    expect(screenFailedCalls(t, cfg({ screeners: { failedCall: { turns: 0 } } }))).toHaveLength(0)
  })

  it('豁免工具不标记', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'edit', arguments: '{"filePath":"a.ts"}' }),
      resultMsg(1, 'c1', '错误', true),
      userMsg(2, '最近消息'),
    )
    expect(screenFailedCalls(t, cfg({ screeners: { failedCall: { turns: 0 } } }))).toHaveLength(0)
  })

  it('错误文本较短时不裁剪（保留原样）', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'bash', arguments: BIG_ARGS }),
      resultMsg(1, 'c1', '短错误', true),
      userMsg(2, '最近消息'),
    )
    const findings = screenFailedCalls(t, cfg({ screeners: { failedCall: { turns: 0, errorKeepChars: 400 } } }))
    const resultFinding = findings.find((f) => f.messageIndex === 1)!
    expect(innerTextOf(resultFinding.replaceBlocks[0]!.blocks[0])).toBe('短错误')
  })

  it('pair 级保留区检查：结果在保留区时整对跳过', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'bash', arguments: BIG_ARGS }),
      userMsg(1, '中间提问'),
      resultMsg(2, 'c1', '错误', true),
      userMsg(3, '最近消息'),
    )
    const c = cfg({
      reserve: { turns: 2 },
      screeners: { failedCall: { turns: 0 } },
    })
    expect(screenFailedCalls(t, c)).toHaveLength(0)
  })

  it('"值得"检查：参数与错误都很小时不处理', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' }),
      resultMsg(1, 'c1', '短错误', true),
      userMsg(2, '最近消息'),
    )
    expect(screenFailedCalls(t, cfg({ screeners: { failedCall: { turns: 0 } } }))).toHaveLength(0)
  })
})
