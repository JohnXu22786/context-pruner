/**
 * 会话投影：把 dsh 的 Session（append-only 日志 + 派生表面）映射为核心引擎的 Transcript。
 * 顺序与模型可见表面一致；同时返回 transcript 索引 → 表面 seq 的映射，
 * 因为个别表面节点（如仅承载 usage 的空内容 assistant 消息）不产生消息，
 * 两个索引空间可能错位。
 */
import { deriveEventMessage, type Session } from '@deepseek-ai/dsh-session'
import { finalizeTranscript, type BlockLike, type RawMessage, type Transcript } from '../core/transcript.js'

export interface ProjectedSession {
  transcript: Transcript
  /** transcript.messages[i] 对应的表面节点 seq（与 transcript 索引一一对应）。 */
  seqs: number[]
}

export function projectSession(session: Session): ProjectedSession {
  const events = session.events
  const raw: RawMessage[] = []
  const seqs: number[] = []
  for (const seq of session.surface.nodes) {
    const event = events[seq]
    if (!event) continue
    const message = deriveEventMessage(event)
    if (!message) continue
    seqs.push(seq)
    raw.push({
      seq,
      role: message.role === 'assistant' ? 'assistant' : 'user',
      origin: event.type === 'tool/result' ? 'tool-result' : event.type === 'user/message' ? 'user' : 'assistant',
      // 结构映射：dsh 的 ContentBlock 与核心 BlockLike 结构一致（不可变对象共享，不做拷贝）
      blocks: message.content as unknown as BlockLike[],
    })
  }
  return { transcript: finalizeTranscript(raw), seqs }
}
