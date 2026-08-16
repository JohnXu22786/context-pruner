/**
 * 会话转录模型：与 dsh 的消息/块词表对齐的结构化视图，核心引擎只依赖本模型，
 * 不依赖任何框架包（可离线测试）。
 *
 * 块类型词表与 dsh-llm 一致：text / reasoning / image / tool-call / tool-result。
 */

/** 文本块。 */
export interface TextBlockLike {
  type: 'text'
  text: string
}

/** 思考（reasoning / thinking）块。 */
export interface ReasoningBlockLike {
  type: 'reasoning'
  text: string
}

/** 工具调用块（参数为模型原始输出的 JSON 字符串）。 */
export interface ToolCallBlockLike {
  type: 'tool-call'
  id: string
  name: string
  arguments: string
}

/** 工具结果块。 */
export interface ToolResultBlockLike {
  type: 'tool-result'
  toolCallId: string
  content: BlockLike[]
  isError?: boolean
}

export type BlockLike = TextBlockLike | ReasoningBlockLike | ToolCallBlockLike | ToolResultBlockLike

/** 消息来源：真实用户 / 助手 / 工具结果（user 角色消息的两种来源）。 */
export type Origin = 'user' | 'assistant' | 'tool-result'

/** 一条转录消息。 */
export interface MessageLike {
  /** 日志中的单调序号（seq = 位置）。 */
  seq: number
  role: 'user' | 'assistant'
  origin: Origin
  blocks: BlockLike[]
  /**
   * 该消息之后还有多少条「真实用户」消息（0 = 最新一轮）。
   * 由 finalizeTranscript 计算，是全部筛查器共用的"轮次距离"。
   */
  userDistance: number
}

/** 构造输入：不需要（也不应该）提供 userDistance，由 finalizeTranscript 计算。 */
export type RawMessage = Omit<MessageLike, 'userDistance'>

/** 一个完整的工具调用对：调用块 + 结果块。 */
export interface ToolPair {
  callMessageIndex: number
  callBlockIndex: number
  resultMessageIndex: number
  resultBlockIndex: number
  callId: string
  name: string
  /** 模型原始输出的参数 JSON 字符串。 */
  argsText: string
  isError: boolean
}

/** 会话转录：消息序列 + 完整调用对索引。 */
export interface Transcript {
  messages: MessageLike[]
  pairs: ToolPair[]
}

/**
 * 计算 userDistance 并建立调用对索引。
 * 不变的排序约束：调用对的两个端点按日志顺序（callMessageIndex < resultMessageIndex）。
 */
export function finalizeTranscript(messages: readonly RawMessage[]): Transcript {
  const withDistance: MessageLike[] = messages.map((m) => ({ ...m, userDistance: 0 }))
  let count = 0
  for (let i = withDistance.length - 1; i >= 0; i--) {
    withDistance[i]!.userDistance = count
    if (withDistance[i]!.origin === 'user') count++
  }

  const pairs: ToolPair[] = []
  const resultLookup = new Map<string, { resultMessageIndex: number; resultBlockIndex: number }>()
  withDistance.forEach((m, messageIndex) => {
    m.blocks.forEach((b, blockIndex) => {
      if (b.type === 'tool-result') {
        // 同一消息内先出现的结果优先（理论上每条工具结果消息只有一个结果块）
        if (!resultLookup.has(b.toolCallId)) {
          resultLookup.set(b.toolCallId, { resultMessageIndex: messageIndex, resultBlockIndex: blockIndex })
        }
      }
    })
  })
  withDistance.forEach((m, callMessageIndex) => {
    m.blocks.forEach((b, callBlockIndex) => {
      if (b.type !== 'tool-call') return
      const hit = resultLookup.get(b.id)
      if (!hit) return
      // 防御：结果先于调用（异常输入）时不成对，避免反向 pair 扭曲轮次判定
      if (hit.resultMessageIndex <= callMessageIndex) return
      const result = withDistance[hit.resultMessageIndex]!.blocks[hit.resultBlockIndex]
      if (result?.type !== 'tool-result') return
      pairs.push({
        callMessageIndex,
        callBlockIndex,
        resultMessageIndex: hit.resultMessageIndex,
        resultBlockIndex: hit.resultBlockIndex,
        callId: b.id,
        name: b.name,
        argsText: b.arguments,
        isError: result.isError ?? false,
      })
    })
  })

  return { messages: withDistance, pairs }
}
