import { describe, expect, it } from 'vitest'
import { screenStaleReasoning } from '../src/core/screeners/stale-reasoning'
import { resolveTriageConfig } from '../src/core/config'
import { buildTranscript, callMsg, resultMsg, reasoningBlock, textBlock, userMsg } from './helpers'

function cfg(): ReturnType<typeof resolveTriageConfig> {
  return resolveTriageConfig({
    screeners: {
      repeatedCall: { enabled: false },
      staleOutput: { enabled: false },
      failedCall: { enabled: false },
      staleReasoning: { keepTurns: 1, maxBlockChars: 400 },
    },
  })
}

describe('screenStaleReasoning', () => {
  it('超过保留轮次的思考块被移除，文本与调用块不受影响', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'grep', arguments: '{}', reasoning: '很久以前的思考' }),
      resultMsg(1, 'c1', '输出'),
      userMsg(2, '最近消息'),
    )
    const findings = screenStaleReasoning(t, cfg())
    expect(findings).toHaveLength(1)
    const finding = findings[0]!
    expect(finding.reason).toBe('stale-reasoning')
    expect(finding.removeBlockIndices).toEqual([0]) // 只移除 reasoning 块
  })

  it('保留区内的思考块不标记（keepTurns=2 时距离 1 保留）', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'grep', arguments: '{}', reasoning: '最近的思考' }),
      resultMsg(1, 'c1', '输出'),
      userMsg(2, '最近消息'),
    )
    const c = resolveTriageConfig({
      screeners: {
        repeatedCall: { enabled: false },
        staleOutput: { enabled: false },
        failedCall: { enabled: false },
        staleReasoning: { keepTurns: 2, maxBlockChars: 400 },
      },
    })
    expect(screenStaleReasoning(t, c)).toHaveLength(0)
  })

  it('超过 maxBlockChars 的保留思考块被裁剪而非删除', () => {
    const c = resolveTriageConfig({
      screeners: {
        repeatedCall: { enabled: false },
        staleOutput: { enabled: false },
        failedCall: { enabled: false },
        staleReasoning: { keepTurns: 2, maxBlockChars: 50 },
      },
    })
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'grep', arguments: '{}', reasoning: 'F'.repeat(300) }),
      resultMsg(1, 'c1', '输出'),
      userMsg(2, '最近消息'),
    )
    const findings = screenStaleReasoning(t, c)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.replaceBlocks).toHaveLength(1)
    const kept = findings[0]!.replaceBlocks[0]!.blocks[0]! as { text: string }
    expect(kept.type).toBe('reasoning')
    expect(kept.text.length).toBeLessThanOrEqual(50 + 30) // 裁剪 + 省略标记余量
  })

  it('无思考块的助手消息不标记', () => {
    const t = buildTranscript(
      {
        seq: 0,
        role: 'assistant',
        origin: 'assistant',
        blocks: [textBlock('只有文本')],
      },
      userMsg(1, '最近消息'),
    )
    expect(screenStaleReasoning(t, cfg())).toHaveLength(0)
  })

  it('禁用后不工作', () => {
    const c = resolveTriageConfig({
      screeners: {
        repeatedCall: { enabled: false },
        staleOutput: { enabled: false },
        failedCall: { enabled: false },
        staleReasoning: { enabled: false },
      },
    })
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'grep', arguments: '{}', reasoning: '旧思考' }),
      resultMsg(1, 'c1', '输出'),
      userMsg(2, '最近消息'),
    )
    expect(screenStaleReasoning(t, c)).toHaveLength(0)
  })
})
