/**
 * dsh-context-triage 插件入口。
 *
 * 插件形态：函数式插件（导出 name / inject / Config / apply）。
 * 提供的接口：
 *  - 服务：ctx.compaction（TriageCompactionEngine，压缩能力接缝的提供者）
 *  - 工具：triage_history（模型可见，见 dsh/triage-tool）
 *  - 命令：/triage（人类命令，见 dsh/triage-command）
 *  - 库：core/* 为框架无关的分诊引擎，可独立嵌入。
 */
import type { Context } from '@deepseek-ai/cordis'
import { resolveTriageConfig } from './core/config.js'
import { Config, type Config as ConfigType } from './dsh/config-schema.js'
import { TriageCompactionEngine } from './dsh/engine-host.js'
import { registerTriageTool } from './dsh/triage-tool.js'
import { registerTriageCommand } from './dsh/triage-command.js'

export * from './core/index.js'
export { Config } from './dsh/config-schema.js'

export const name = 'context-triage'

/**
 * tools 必需。commands 不声明为注入（cordis 4 中 false 值与必需等价）：
 * 通过 ctx.get('commands') 可选探测，无命令注册表的环境静默跳过。
 */
export const inject = { tools: true }

export function apply(ctx: Context, config: ConfigType): void {
  const engine = new TriageCompactionEngine(ctx, resolveTriageConfig(config))
  registerTriageTool(ctx, engine)
  registerTriageCommand(ctx, engine)
}
