/**
 * dsh 适配层测试：使用真实 @deepseek-ai/dsh-session 的 Session 类验证
 * 压缩事务落地、锁扫描、投影映射与失败清理（P0 回归）。
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { TriageCompactionEngine, isCompactionActive } from '../src/dsh/engine-host'
import { projectSession } from '../src/dsh/projection'
import { resolveTriageConfig } from '../src/core/config'
import { chooseSpan, triage } from '../src/core/engine'

/** 构造一个含"大结果工具调用对"的会话，保证有值得压缩的区间。 */
function buildSession(): Session {
  const session = Session.create(SessionId('adapter-test-1'))
  session.append(
    'user/message',
    { id: MessageId('m-user-1'), role: 'user', content: [{ type: 'text', text: '排查构建失败' }], source: { kind: 'user' } },
    { surfaceOp: 'append' },
  )
  session.append(
    'assistant/message',
    {
      message: {
        id: MessageId('m-call-1'),
        role: 'assistant',
        content: [
          { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"cmd":"npm run build"}' },
        ],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-v4-flash' },
      },
    },
    { surfaceOp: 'append' },
  )
  session.append(
    'tool/result',
    {
      turn: 0,
      step: 1,
      message: {
        id: MessageId('m-res-1'),
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'X'.repeat(2000) }] }],
        source: { kind: 'tool', callId: 'c1' },
      },
    },
    { surfaceOp: 'append' },
  )
  session.append(
    'user/message',
    { id: MessageId('m-user-2'), role: 'user', content: [{ type: 'text', text: '最近消息' }], source: { kind: 'user' } },
    { surfaceOp: 'append' },
  )
  return session
}

function makeEngine(): TriageCompactionEngine {
  const ctx = new Context()
  const config = resolveTriageConfig({
    reserve: { turns: 0 },
    budget: { minSavingsTokens: 0 },
    screeners: {
      repeatedCall: { enabled: false },
      failedCall: { enabled: false },
      oversizedBlock: { enabled: false },
      staleReasoning: { enabled: false },
      staleOutput: { turns: 0 },
    },
  })
  return new TriageCompactionEngine(ctx, config)
}

describe('isCompactionActive', () => {
  it('空会话为 false', () => {
    const session = Session.create(SessionId('adapter-lock-0'))
    expect(isCompactionActive(session)).toBe(false)
  })

  it('start 无配对 end 时为 true', () => {
    const session = Session.create(SessionId('adapter-lock-1'))
    session.append('compaction/start', { compactionId: 'x' as never, turn: null })
    expect(isCompactionActive(session)).toBe(true)
  })

  it('start+end 闭合后为 false', () => {
    const session = Session.create(SessionId('adapter-lock-2'))
    session.append('compaction/start', { compactionId: 'x' as never, turn: null })
    session.append('compaction/end', { compactionId: 'x' as never, turn: null })
    expect(isCompactionActive(session)).toBe(false)
  })

  it('session/end-seed 之前的孤儿 start 不影响判定（resume 场景）', () => {
    const session = Session.create(SessionId('adapter-lock-3'))
    session.append('compaction/start', { compactionId: 'old' as never, turn: null })
    session.append('session/end-seed', {})
    expect(isCompactionActive(session)).toBe(false)
  })
})

describe('projectSession 索引映射', () => {
  it('空内容 assistant 节点被跳过时，seqs 与 transcript 索引一一对应', () => {
    const session = Session.create(SessionId('adapter-proj-1'))
    session.append(
      'user/message',
      { id: MessageId('a'), role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } },
      { surfaceOp: 'append' },
    )
    // 空内容 assistant 消息（仅承载 usage）不产生模型消息
    session.append(
      'assistant/message',
      {
        message: {
          id: MessageId('b'),
          role: 'assistant',
          content: [],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
      { surfaceOp: 'append' },
    )
    session.append(
      'user/message',
      { id: MessageId('c'), role: 'user', content: [{ type: 'text', text: '再问' }], source: { kind: 'user' } },
      { surfaceOp: 'append' },
    )
    const projected = projectSession(session)
    expect(projected.transcript.messages.map((m) => m.seq)).toEqual([0, 2])
    expect(projected.seqs).toEqual([0, 2])
    expect(projected.seqs).toHaveLength(projected.transcript.messages.length)
  })
})

describe('commit 压缩事务', () => {
  it('完整事务落地：事件顺序、载荷、surface 替换与锁闭合', () => {
    const session = buildSession()
    const engine = makeEngine()
    const projected = projectSession(session)
    const outcome = triage(projected.transcript, engine.config)
    const span = chooseSpan(outcome, engine.config)!
    const result = engine.commit(session, projected, outcome, span, {}, undefined)

    // CompactionResult 字段
    expect(result.shadowedSeqs).toEqual(projected.seqs.slice(span.startIndex, span.endIndex + 1))
    expect(result.shadowedTokenCount).toBeGreaterThan(0)
    expect(result.startSeq).toBeLessThan(result.summarySeq)
    expect(result.summarySeq).toBeLessThan(result.endSeq)

    // 事件序列与载荷
    const types = session.events.map((e) => e.type)
    const startIdx = types.indexOf('compaction/start')
    expect(startIdx).toBeGreaterThanOrEqual(0)
    expect(types[startIdx + 1]).toBe('compaction/summary')
    expect(types[startIdx + 2]).toBe('user/message')
    expect(types[startIdx + 3]).toBe('compaction/end')

    const startEvent = session.events[startIdx]!
    expect(startEvent.data.compactionId).toBe(result.compactionId)
    expect('sourceCommandId' in startEvent.data).toBe(false) // 无条件 undefined 曾被 append 拒绝（P0）

    const summaryEvent = session.events[startIdx + 1]!
    expect(summaryEvent.data.shadowedSeqs).toEqual(result.shadowedSeqs)
    expect(summaryEvent.data.shadowedTokenCount).toBe(result.shadowedTokenCount)

    const replaceEvent = session.events[startIdx + 2]!
    expect(replaceEvent.type).toBe('user/message')
    const surfaceOp = replaceEvent.surfaceOp
    expect(surfaceOp).toMatchObject({ op: 'replace' })
    expect(replaceEvent.sourceEventSeqs).toEqual(result.shadowedSeqs)
    expect(replaceEvent.data.source).toMatchObject({ kind: 'plugin', plugin: 'compact' })
    expect(replaceEvent.data.content.length).toBeGreaterThan(0)

    // 锁已闭合
    expect(isCompactionActive(session)).toBe(false)

    // 表面替换生效：模型可见历史从「首条用户消息 + 摘要 + 最近消息」派生
    const messages = session.deriveMessages()
    expect(messages.length).toBe(3)
    expect(messages[0]!.content[0]).toMatchObject({ type: 'text', text: '排查构建失败' })
    expect(messages[1]!.content[0]!.type).toBe('text')
    expect(messages[1]!.content[0]!.text).toContain('已归档')
    expect(messages[2]!.content[0]).toMatchObject({ type: 'text', text: '最近消息' })
  })

  it('带 sourceCommandId 时写入载荷', () => {
    const session = buildSession()
    const engine = makeEngine()
    const projected = projectSession(session)
    const outcome = triage(projected.transcript, engine.config)
    const span = chooseSpan(outcome, engine.config)!
    engine.commit(session, projected, outcome, span, {}, 'cmd-1' as never)
    const startEvent = session.events.find((e) => e.type === 'compaction/start')!
    expect(startEvent.data.sourceCommandId).toBe('cmd-1')
  })

  it('append 失败时补记 compaction/end(error)，不留下孤儿锁', () => {
    const engine = makeEngine()
    const projected = projectSession(buildSession())
    const outcome = triage(projected.transcript, engine.config)
    const span = chooseSpan(outcome, engine.config)!
    const appends: unknown[] = []
    const fakeSession = {
      events: [] as never[],
      surface: { nodes: [...projected.seqs] },
      append: vi.fn(() => {
        appends.push(1)
        if (appends.length === 3) throw new Error('boom')
        return { seq: appends.length - 1 }
      }),
    }
    expect(() => engine.commit(fakeSession as never, projected, outcome, span, {}, undefined)).toThrow(/boom/)
    // 4 次调用：start / summary / (replace 失败) / 补记 end
    expect(appends).toHaveLength(4)
    const endCall = fakeSession.append.mock.calls[3]!
    expect(endCall[0]).toBe('compaction/end')
    expect((endCall[1] as { error: string }).error).toContain('boom')
  })
})

describe('compactRegion', () => {
  it('压缩活跃时拒绝（busy）', async () => {
    const session = Session.create(SessionId('adapter-region-1'))
    session.append('compaction/start', { compactionId: 'x' as never, turn: null })
    const engine = makeEngine()
    await expect(engine.compactRegion(0, 1, { session, options: {} }, undefined)).rejects.toMatchObject({ code: 'busy' })
  })

  it('非法区间被拒绝（changed）', async () => {
    const session = buildSession()
    const engine = makeEngine()
    await expect(engine.compactRegion(-1, 0, { session, options: {} }, undefined)).rejects.toMatchObject({ code: 'changed' })
  })

  it('区间不划算时拒绝（summary）', async () => {
    const session = buildSession()
    const engine = makeEngine()
    // 区间 [0,0] 只有一条短用户消息，无任何可节省内容
    await expect(engine.compactRegion(0, 0, { session, options: {} }, undefined)).rejects.toMatchObject({ code: 'summary' })
  })
})

describe('commit 与空内容表面节点', () => {
  it('压缩区间内含空内容 assistant 节点时，sourceEventSeqs 覆盖全部表面节点', () => {
    const session = Session.create(SessionId('adapter-empty-1'))
    session.append(
      'user/message',
      { id: MessageId('a'), role: 'user', content: [{ type: 'text', text: '排查' }], source: { kind: 'user' } },
      { surfaceOp: 'append' },
    )
    session.append(
      'assistant/message',
      {
        message: {
          id: MessageId('b'),
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
      { surfaceOp: 'append' },
    )
    // 空内容 assistant 节点（仅承载 usage）——不产生模型消息但占据表面位置
    session.append(
      'assistant/message',
      {
        message: {
          id: MessageId('empty'),
          role: 'assistant',
          content: [],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
      { surfaceOp: 'append' },
    )
    session.append(
      'tool/result',
      {
        turn: 0,
        step: 2,
        message: {
          id: MessageId('d'),
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'Z'.repeat(2000) }] }],
          source: { kind: 'tool', callId: 'c1' },
        },
      },
      { surfaceOp: 'append' },
    )
    session.append(
      'user/message',
      { id: MessageId('e'), role: 'user', content: [{ type: 'text', text: '最近' }], source: { kind: 'user' } },
      { surfaceOp: 'append' },
    )

    const engine = makeEngine()
    const projected = projectSession(session)
    // 空节点被投影跳过：seqs = [0, 1, 3, 4]
    expect(projected.seqs).toEqual([0, 1, 3, 4])
    const outcome = triage(projected.transcript, engine.config)
    const span = chooseSpan(outcome, engine.config)!
    // span 覆盖调用+结果（含中间的表面节点 seq 2）
    expect(span.startIndex).toBeLessThanOrEqual(1)
    const result = engine.commit(session, projected, outcome, span, {}, undefined)
    // sourceEventSeqs 必须包含空内容节点 seq 2
    expect(result.shadowedSeqs).toContain(2)
    const summaryEvent = session.events.find((e) => e.type === 'compaction/summary')!
    expect(summaryEvent.data.shadowedSeqs).toContain(2)
    const replaceEvent = session.events.find((e) => e.type === 'user/message' && e.surfaceOp?.op === 'replace')!
    expect(replaceEvent.sourceEventSeqs).toContain(2)
    // 事务正常闭合
    expect(isCompactionActive(session)).toBe(false)
  })
})
