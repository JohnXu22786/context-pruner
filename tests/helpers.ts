/**
 * 测试辅助：构造会话转录（Transcript）的快捷工具。
 * 与生产代码零依赖，仅用于测试与 CLI 示例。
 */
import { finalizeTranscript } from '../src/core/transcript'
import type { BlockLike, MessageLike, Transcript } from '../src/core/transcript'

export interface CallSpec {
  id: string
  name: string
  arguments?: string
  reasoning?: string
}

export function textBlock(text: string): BlockLike {
  return { type: 'text', text }
}

export function reasoningBlock(text: string): BlockLike {
  return { type: 'reasoning', text }
}

export function callBlock(id: string, name: string, args = '{}'): BlockLike {
  return { type: 'tool-call', id, name, arguments: args }
}

export function resultBlock(callId: string, text: string, isError = false): BlockLike {
  return {
    type: 'tool-result',
    toolCallId: callId,
    content: [{ type: 'text', text }],
    isError,
  }
}

export function userMsg(seq: number, text: string): MessageLike {
  return { seq, role: 'user', origin: 'user', blocks: [textBlock(text)] }
}

export function assistantMsg(seq: number, blocks: BlockLike[]): MessageLike {
  return { seq, role: 'assistant', origin: 'assistant', blocks }
}

export function callMsg(seq: number, spec: CallSpec): MessageLike {
  const blocks: BlockLike[] = []
  if (spec.reasoning) blocks.push(reasoningBlock(spec.reasoning))
  blocks.push(callBlock(spec.id, spec.name, spec.arguments ?? '{}'))
  return assistantMsg(seq, blocks)
}

export function resultMsg(seq: number, callId: string, text: string, isError = false): MessageLike {
  return {
    seq,
    role: 'user',
    origin: 'tool-result',
    blocks: [resultBlock(callId, text, isError)],
  }
}

/** 计算每条消息的 userDistance（其后的真实用户消息条数）并配对工具调用。 */
export function finalize(messages: MessageLike[]): Transcript {
  return finalizeTranscript(messages)
}

/** 从消息数组直接构造（已假定 userDistance 为 0 时由调用方自行 finalize）。 */
export function buildTranscript(...messages: MessageLike[]): Transcript {
  return finalize(messages)
}
