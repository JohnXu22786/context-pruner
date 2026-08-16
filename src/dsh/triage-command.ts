/**
 * 人类命令 /triage：不经过模型，直接对当前会话执行一次分诊并输出审计报告。
 * 有值得处理的区间时直接应用（与工具共用压缩事务）。
 */
import type { Context } from '@deepseek-ai/cordis'
// 引用 dsh-commands 的类型会同时加载其 Context.commands 类型扩充
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { chooseSpan, triage, buildSummary } from '../core/engine.js'
import { renderAuditText } from '../core/audit.js'
import { projectSession } from './projection.js'
import { isCompactionActive, type TriageCompactionEngine } from './engine-host.js'

export function registerTriageCommand(ctx: Context, engine: TriageCompactionEngine): void {
  // commands 为可选服务：用 ctx.get 探测，无命令注册表的环境（如 headless 精简配置）静默跳过
  const commands = ctx.get('commands')
  if (!commands) return
  const definition: CommandDefinition = {
    name: 'triage',
    description: '对会话历史执行一次上下文分诊，输出审计报告并应用值得的处理',
    handler: async (invocation) => {
      try {
        const session = invocation.agent.session
        const projected = projectSession(session)
        const outcome = triage(projected.transcript, engine.config)
        const span = chooseSpan(outcome, engine.config)
        const summary = span ? buildSummary(outcome, span, engine.config) : null

        const lines = [renderAuditText(outcome.audit)]
        if (span && summary) {
          if (summary.summaryTokens < summary.shadowedTokens) {
            if (isCompactionActive(session)) {
              lines.push('\n已有进行中的压缩事务，本次仅报告。')
            } else {
              engine.commit(session, projected, outcome, span, invocation.agent.options ?? {}, undefined, invocation.signal)
              lines.push('\n已应用分诊处理。')
            }
          } else {
            lines.push('\n[未应用] 压缩区间不划算（摘要不小于原文），保持原样。')
          }
        }
        return { kind: 'success', text: lines.join('\n') }
      } catch (error) {
        return { kind: 'error', text: `分诊失败：${(error as Error).message}` }
      }
    },
  }
  commands.register(definition)
}
