/**
 * 离线回放使用的简易会话格式：
 * 每行一个 JSON 对象，seq 由行序决定。
 *
 *   {"type":"user/message","text":"..."}
 *   {"type":"assistant/message","text":"...","reasoning":"...","calls":[{"id":"c1","name":"grep","arguments":"{...}"}]}
 *   {"type":"tool/result","callId":"c1","text":"...","isError":true}
 *
 * 该格式仅用于本地演示与回归测试，与 dsh 的持久化存储格式无关。
 */
import { finalizeTranscript } from '../core/transcript.js'
import type { BlockLike, RawMessage, Transcript } from '../core/transcript.js'

export interface CliToolCall {
  id: string
  name: string
  arguments?: string
}

export type CliEvent =
  | { type: 'user/message'; text: string }
  | { type: 'assistant/message'; text?: string; reasoning?: string; calls?: CliToolCall[] }
  | { type: 'tool/result'; callId: string; text: string; isError?: boolean }

export function parseSessionJsonl(input: string): Transcript {
  const messages: RawMessage[] = []
  let seq = 0
  const lines = input.split(/\r?\n/)
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo]!.trim()
    if (!line || line.startsWith('#')) continue
    let event: CliEvent
    try {
      event = JSON.parse(line) as CliEvent
    } catch (error) {
      throw new Error(`第 ${lineNo + 1} 行不是合法 JSON：${(error as Error).message}`)
    }
    switch (event.type) {
      case 'user/message':
        messages.push({ seq: seq++, role: 'user', origin: 'user', blocks: [{ type: 'text', text: event.text ?? '' }] })
        break
      case 'assistant/message': {
        const blocks: BlockLike[] = []
        if (event.reasoning) blocks.push({ type: 'reasoning', text: event.reasoning })
        if (event.text) blocks.push({ type: 'text', text: event.text })
        for (const call of event.calls ?? []) {
          blocks.push({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments ?? '{}' })
        }
        messages.push({ seq: seq++, role: 'assistant', origin: 'assistant', blocks })
        break
      }
      case 'tool/result':
        messages.push({
          seq: seq++,
          role: 'user',
          origin: 'tool-result',
          blocks: [
            {
              type: 'tool-result',
              toolCallId: event.callId,
              content: [{ type: 'text', text: event.text ?? '' }],
              isError: event.isError ?? false,
            },
          ],
        })
        break
      default:
        throw new Error(`第 ${lineNo + 1} 行是未知事件类型：${(event as { type: string }).type}`)
    }
  }
  return finalizeTranscript(messages)
}

/** 把转录渲染为可读文本（用于 CLI 展示与 README 示例）。 */
export function renderTranscriptText(transcript: Transcript): string {
  const lines: string[] = []
  for (const m of transcript.messages) {
    const head = `[seq ${m.seq} | ${m.origin}]`
    for (const block of m.blocks) {
      switch (block.type) {
        case 'text':
          lines.push(`${head} text: ${block.text}`)
          break
        case 'reasoning':
          lines.push(`${head} reasoning: ${block.text.slice(0, 80)}${block.text.length > 80 ? '…' : ''}`)
          break
        case 'tool-call':
          lines.push(`${head} call ${block.name} ${block.arguments.slice(0, 60)}`)
          break
        case 'tool-result': {
          const inner = block.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' ')
          lines.push(`${head} result${block.isError ? ' (错误)' : ''}: ${inner.slice(0, 100)}`)
          break
        }
        default:
          lines.push(`${head} [${(block as { type: string }).type}]`)
      }
    }
  }
  return lines.join('\n')
}
