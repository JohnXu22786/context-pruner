import { describe, expect, it } from 'vitest'
import { screenOversizedBlocks } from '../src/core/screeners/oversized-block'
import { resolveTriageConfig } from '../src/core/config'
import { buildTranscript, resultMsg, userMsg } from './helpers'

function cfg(): ReturnType<typeof resolveTriageConfig> {
  return resolveTriageConfig({
    screeners: {
      repeatedCall: { enabled: false },
      staleOutput: { enabled: false },
      failedCall: { enabled: false },
      staleReasoning: { enabled: false },
      oversizedBlock: { capChars: 200, headChars: 60, tailChars: 30 },
    },
  })
}

describe('screenOversizedBlocks', () => {
  it('超过上限的工具结果文本被裁剪（保留头部与尾部）', () => {
    const t = buildTranscript(
      resultMsg(0, 'c1', 'A'.repeat(500)),
      userMsg(1, '最近消息'),
    )
    const findings = screenOversizedBlocks(t, cfg())
    expect(findings).toHaveLength(1)
    const finding = findings[0]!
    expect(finding.reason).toBe('oversized')
    const replaced = finding.replaceBlocks[0]!.blocks[0] as { content?: Array<{ text: string }> }
    expect(replaced.type).toBe('tool-result')
    const text = replaced.content![0]!.text
    expect(text.length).toBeLessThan(200)
    expect(text).toContain('A'.repeat(60)) // 头部保留
    expect(text).toContain('A'.repeat(30)) // 尾部保留
    expect(text).toContain('省略')
  })

  it('未超上限的块不动', () => {
    const t = buildTranscript(resultMsg(0, 'c1', '短输出'), userMsg(1, '最近消息'))
    expect(screenOversizedBlocks(t, cfg())).toHaveLength(0)
  })

  it('精确等于上限的块不动', () => {
    const t = buildTranscript(resultMsg(0, 'c1', 'B'.repeat(200)), userMsg(1, '最近消息'))
    expect(screenOversizedBlocks(t, cfg())).toHaveLength(0)
  })

  it('多个超长块分别裁剪（同一结果块内逐一处理）', () => {
    const big1 = { type: 'text', text: 'C'.repeat(300) } as const
    const big2 = { type: 'text', text: 'D'.repeat(300) } as const
    const t = buildTranscript(
      {
        seq: 0,
        role: 'user',
        origin: 'tool-result',
        blocks: [{ type: 'tool-result', toolCallId: 'c1', content: [big1, big2] }],
      },
      userMsg(1, '最近消息'),
    )
    const findings = screenOversizedBlocks(t, cfg())
    expect(findings).toHaveLength(1)
    const replaced = findings[0]!.replaceBlocks[0]!.blocks[0] as { content: Array<{ type: string; text: string }> }
    expect(replaced.type).toBe('tool-result')
    expect(replaced.content).toHaveLength(2)
    expect(replaced.content[0]!.text).toContain('省略')
    expect(replaced.content[1]!.text).toContain('省略')
  })

  it('禁用后不工作', () => {
    const c = resolveTriageConfig({
      screeners: {
        repeatedCall: { enabled: false },
        staleOutput: { enabled: false },
        failedCall: { enabled: false },
        staleReasoning: { enabled: false },
        oversizedBlock: { enabled: false },
      },
    })
    const t = buildTranscript(resultMsg(0, 'c1', 'E'.repeat(500)), userMsg(1, '最近消息'))
    expect(screenOversizedBlocks(t, c)).toHaveLength(0)
  })
})
