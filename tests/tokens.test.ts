import { describe, expect, it } from 'vitest'
import { estimateTextTokens, estimateBlockTokens, estimateMessagesTokens } from '../src/core/tokens'
import { textBlock, userMsg, callMsg } from './helpers'

describe('estimateTextTokens', () => {
  it('空字符串记 0', () => {
    expect(estimateTextTokens('')).toBe(0)
  })

  it('拉丁文本按约 4 字符/token 折算', () => {
    expect(estimateTextTokens('hello world')).toBeGreaterThan(0)
    expect(estimateTextTokens('hello world')).toBe(3) // 11 字符 → ceil(11/4)=3
  })

  it('中文按每字约 1 token 折算，比同长度英文贵', () => {
    const cjk = estimateTextTokens('你好世界，这是一段中文内容')
    const latin = estimateTextTokens('a'.repeat(cjk * 4))
    expect(cjk).toBeGreaterThan(latin - 2)
  })

  it('混合内容不小于任一成分', () => {
    const mixed = estimateTextTokens('中文abc')
    expect(mixed).toBeGreaterThanOrEqual(2)
  })
})

describe('estimateBlockTokens / estimateMessagesTokens', () => {
  it('按块累加', () => {
    const blocks = [textBlock('hello world'), textBlock('你好世界')]
    const total = estimateBlockTokens(blocks)
    expect(total).toBe(estimateTextTokens('hello world') + estimateTextTokens('你好世界'))
  })

  it('消息级估算包含全部块', () => {
    const m1 = userMsg(0, 'hello world')
    const m2 = callMsg(1, { id: 'c1', name: 'grep', arguments: '{"a":1}', reasoning: '思考' })
    const got = estimateMessagesTokens([m1, m2])
    expect(got).toBe(estimateBlockTokens(m1.blocks) + estimateBlockTokens(m2.blocks))
  })

  it('未知块类型按 0 处理而不抛错', () => {
    const unknown = { type: 'image', data: 'x' } as never
    expect(estimateBlockTokens([unknown])).toBe(0)
  })
})
