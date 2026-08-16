/**
 * dsh 适配层导出：插件入口（src/index.ts）与嵌入方复用。
 */
export { Config, type Config as DshConfig } from './config-schema.js'
export { projectSession } from './projection.js'
export { TriageCompactionEngine, isCompactionActive } from './engine-host.js'
export { registerTriageTool } from './triage-tool.js'
export { registerTriageCommand } from './triage-command.js'
