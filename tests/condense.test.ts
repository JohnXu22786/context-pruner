import { describe, expect, it } from 'vitest'
import { clipText, extractSummaryText, makeStaleDigestBlock, makeFailureStubBlock } from '../src/core/condense'
import { callMsg, resultMsg, reasoningBlock, textBlock, userMsg } from './helpers'

describe('clipText', () => {
  it('保留头部与尾部并在中间标注省略量', () => {
    const clipped = clipText('H'.repeat(500), 200, 60, 30)
    expect(clipped.length).toBeLessThan(200)
    expect(clipped).toContain('H'.repeat(60))
    expect(clipped).toContain('H'.repeat(30))
    expect(clipped).toMatch(/省略/)
  })

  it('短文本原样返回', () => {
    expect(clipText('abc', 200, 60, 30)).toBe('abc')
  })

  it('头部+尾部超过上限时仍不超限', () => {
    const clipped = clipText('X'.repeat(1000), 100, 80, 80)
    expect(clipped.length).toBeLessThanOrEqual(100 + 40) // 含省略标记
  })

  it('不变式：任意 capChars 下输出不超过 capChars', () => {
    for (const cap of [1, 2, 5, 10, 20, 25, 30, 40, 41, 50, 100]) {
      for (const len of [cap + 1, cap * 3, 500]) {
        const clipped = clipText('Y'.repeat(len), cap, Math.floor(cap * 0.6), Math.floor(cap * 0.3))
        expect(clipped.length).toBeLessThanOrEqual(cap)
      }
    }
  })

  it('极小的 capChars 退化为纯头部截断而非抛错', () => {
    const clipped = clipText('Z'.repeat(100), 2, 1, 1)
    expect(clipped.length).toBeLessThanOrEqual(2)
  })
})

describe('makeStaleDigestBlock / makeFailureStubBlock', () => {
  it('归档摘要包含工具名、原始规模与摘要头部', () => {
    const block = makeStaleDigestBlock('grep', 1200, '第一行结果')
    expect(block.type).toBe('text')
    expect(block.text).toContain('grep')
    expect(block.text).toContain('1200')
    expect(block.text).toContain('第一行结果')
  })

  it('失败桩不泄露参数内容', () => {
    const block = makeFailureStubBlock('bash')
    expect(block.text).toContain('bash')
    expect(block.text).not.toContain('rm -rf')
    expect(block.text).not.toContain('/secret')
  })
})

describe('extractSummaryText', () => {
  it('文本原样、调用块压缩为标记、思考块剔除、结果内容保留', () => {
    const texts = extractSummaryText([
      reasoningBlock('内部思考'),
      callMsg(0, { id: 'c1', name: 'grep', arguments: '{"p":"x"}' }).blocks[0]!,
      resultMsg(1, 'c1', '结果文本').blocks[0]!,
    ])
    const joined = texts.join('\n')
    expect(joined).toContain('结果文本')
    expect(joined).not.toContain('内部思考') // 思考剔除
    expect(joined).not.toContain('{"p":"x"}') // 参数不进入摘要
    expect(joined).toContain('grep') // 调用保留为标记
  })

  it('多块文本消息逐块保留', () => {
    const texts = extractSummaryText([textBlock('甲'), reasoningBlock('乙'), textBlock('丙')])
    expect(texts.join('|')).toBe('甲|丙')
  })
})

