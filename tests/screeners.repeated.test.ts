import { describe, expect, it } from 'vitest'
import { screenRepeatedCalls } from '../src/core/screeners/repeated-call'
import { resolveTriageConfig } from '../src/core/config'
import { buildTranscript, callMsg, resultMsg, userMsg } from './helpers'

/** 只开启重复调用筛查；关闭保留区与其余筛查，保证 fixture 规模不会干扰判定。 */
const base = resolveTriageConfig({
  reserve: { turns: 0 },
  screeners: { staleOutput: { enabled: false }, failedCall: { enabled: false } },
})

describe('screenRepeatedCalls', () => {
  it('同工具同参数（参数顺序无关）的旧调用对被标记移除', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'grep', arguments: '{"pattern":"foo","path":"a"}' }),
      resultMsg(1, 'c1', '旧输出'),
      callMsg(2, { id: 'c2', name: 'grep', arguments: '{"path":"a","pattern":"foo"}' }),
      resultMsg(3, 'c2', '新输出'),
      userMsg(4, '继续'),
    )
    const findings = screenRepeatedCalls(t, base)
    expect(findings).toHaveLength(2)
    expect(findings.map((f) => f.messageIndex).sort()).toEqual([0, 1])
    expect(findings[0]!.reason).toBe('repeated')
  })

  it('参数不同不算重复', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'grep', arguments: '{"pattern":"foo"}' }),
      resultMsg(1, 'c1', '旧输出'),
      callMsg(2, { id: 'c2', name: 'grep', arguments: '{"pattern":"bar"}' }),
      resultMsg(3, 'c2', '新输出'),
      userMsg(4, '继续'),
    )
    expect(screenRepeatedCalls(t, base)).toHaveLength(0)
  })

  it('豁免清单内的工具不判重', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'task', arguments: '{"prompt":"x"}' }),
      resultMsg(1, 'c1', '子代理输出 1'),
      callMsg(2, { id: 'c2', name: 'task', arguments: '{"prompt":"x"}' }),
      resultMsg(3, 'c2', '子代理输出 2'),
      userMsg(4, '继续'),
    )
    expect(screenRepeatedCalls(t, base)).toHaveLength(0)
  })

  it('仅出现一次不标记', () => {
    const t = buildTranscript(callMsg(0, { id: 'c1', name: 'grep' }), resultMsg(1, 'c1', '输出'), userMsg(2, '继续'))
    expect(screenRepeatedCalls(t, base)).toHaveLength(0)
  })

  it('三次相同调用只保留最后一次', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'grep', arguments: '{"p":"x"}' }),
      resultMsg(1, 'c1', '输出 1'),
      callMsg(2, { id: 'c2', name: 'grep', arguments: '{"p":"x"}' }),
      resultMsg(3, 'c2', '输出 2'),
      callMsg(4, { id: 'c3', name: 'grep', arguments: '{"p":"x"}' }),
      resultMsg(5, 'c3', '输出 3'),
      userMsg(6, '继续'),
    )
    const findings = screenRepeatedCalls(t, base)
    expect(findings).toHaveLength(4)
    const flagged = findings.map((f) => f.messageIndex).sort()
    expect(flagged).toEqual([0, 1, 2, 3])
  })

  it('旧调用的结果已缺失（不成对）时不标记', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'grep', arguments: '{"p":"x"}' }),
      callMsg(1, { id: 'c2', name: 'grep', arguments: '{"p":"x"}' }),
      resultMsg(2, 'c2', '输出'),
      userMsg(3, '继续'),
    )
    expect(screenRepeatedCalls(t, base)).toHaveLength(0)
  })

  it('移除操作只针对调用块与结果块，不波及其他块', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'grep', arguments: '{"p":"x"}' }),
      resultMsg(1, 'c1', '旧输出'),
      callMsg(2, { id: 'c2', name: 'grep', arguments: '{"p":"x"}' }),
      resultMsg(3, 'c2', '新输出'),
      userMsg(4, '继续'),
    )
    const callFinding = screenRepeatedCalls(t, base).find((f) => f.messageIndex === 0)!
    expect(callFinding.removeBlockIndices).toEqual([0])
    const resultFinding = screenRepeatedCalls(t, base).find((f) => f.messageIndex === 1)!
    expect(resultFinding.removeBlockIndices).toEqual([0])
  })

  it('pair 级保留区检查：旧调用与其结果均需非保留区', () => {
    const cfg = resolveTriageConfig({
      reserve: { turns: 2 },
      screeners: { staleOutput: { enabled: false }, failedCall: { enabled: false } },
    })
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'grep', arguments: '{"p":"x"}' }),
      userMsg(1, '中间提问'),
      resultMsg(2, 'c1', '迟到的结果'),
      callMsg(3, { id: 'c2', name: 'grep', arguments: '{"p":"x"}' }),
      resultMsg(4, 'c2', '新输出'),
      userMsg(5, '继续'),
    )
    expect(screenRepeatedCalls(t, cfg)).toHaveLength(0)
  })

  it('args 含嵌套数组时仍稳定序列化', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'list', arguments: '{"items":[3,1,2],"k":{"a":1,"b":2}}' }),
      resultMsg(1, 'c1', '旧'),
      callMsg(2, { id: 'c2', name: 'list', arguments: '{"items":[3,1,2],"k":{"b":2,"a":1}}' }),
      resultMsg(3, 'c2', '新'),
      userMsg(4, '继续'),
    )
    expect(screenRepeatedCalls(t, base)).toHaveLength(2)
  })

  it('非 JSON 参数文本按原样比较', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'x', arguments: 'not json' }),
      resultMsg(1, 'c1', '旧'),
      callMsg(2, { id: 'c2', name: 'x', arguments: 'not json' }),
      resultMsg(3, 'c2', '新'),
      userMsg(4, '继续'),
    )
    expect(screenRepeatedCalls(t, base)).toHaveLength(2)
  })

  it('同工具同参数但保留最近一次：最后一次调用本身不被标记', () => {
    const t = buildTranscript(
      callMsg(0, { id: 'c1', name: 'grep', arguments: '{"p":"x"}' }),
      resultMsg(1, 'c1', '旧'),
      callMsg(2, { id: 'c2', name: 'grep', arguments: '{"p":"x"}' }),
      resultMsg(3, 'c2', '新'),
      userMsg(4, '继续'),
    )
    const flagged = screenRepeatedCalls(t, base).map((f) => f.messageIndex)
    expect(flagged).not.toContain(2)
    expect(flagged).not.toContain(3)
  })
})
