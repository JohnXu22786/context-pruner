/**
 * 模型可见工具 triage_history：让模型主动触发一次上下文分诊。
 * dryRun=true 只报告；否则在有值得处理的区间时应用处理（走压缩事务）。
 * 返回值为审计报告文本（canonical JSON 值），渲染为文本块。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { chooseSpan, triage, buildSummary } from '../core/engine.js'
import { renderAuditText } from '../core/audit.js'
import { projectSession } from './projection.js'
import { isCompactionActive, type TriageCompactionEngine } from './engine-host.js'

export function registerTriageTool(ctx: Context, engine: TriageCompactionEngine): void {
  ctx.tools.register(
    defineTool({
      name: 'triage_history',
      description:
        '对会话历史执行一次上下文分诊：筛查过期输出、重复调用、失败调用、超长结果与过期思考块，' +
        '将不划算/无价值的内容归档或移除，并把审计报告返回给你。dryRun=true 时只报告不修改。',
      parameters: {
        dryRun: {
          type: 'boolean',
          description: 'true 时只计算并报告，不实际应用任何处理',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args: { dryRun?: boolean }, exec) {
        const agent = exec.agent
        if (!agent) {
          throw new Error('triage_history 未绑定到任何会话')
        }
        const session = agent.session
        const projected = projectSession(session)
        const outcome = triage(projected.transcript, engine.config)
        const span = chooseSpan(outcome, engine.config)
        const summary = span ? buildSummary(outcome, span, engine.config) : null

        const lines = [renderAuditText(outcome.audit)]
        if (span && summary) {
          lines.push(
            `\n建议压缩区间：消息 [${span.startIndex}..${span.endIndex}]（原文约 ${summary.shadowedTokens} tokens → 摘要约 ${summary.summaryTokens} tokens）`,
          )
        }

        if (!args.dryRun && span && summary && summary.summaryTokens < summary.shadowedTokens) {
          if (isCompactionActive(session)) {
            lines.push('\n[未应用] 已有进行中的压缩事务，本次仅报告')
          } else {
            engine.commit(session, projected, outcome, span, agent.options ?? {}, undefined, exec.signal)
            lines.push('\n已应用分诊处理。')
          }
        } else if (!args.dryRun && span) {
          lines.push('\n[未应用] 压缩区间不划算（摘要不小于原文），保持原样。')
        }
        return lines.join('\n')
      },
    }),
  )
}
