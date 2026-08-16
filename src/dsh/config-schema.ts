/**
 * dsh 插件配置 Schema（Schemastery）：与 core/config 的 TriageConfig 一一对应。
 * 约定：同名导出 interface Config + const Config；由 cordis 校验并填充默认值。
 */
import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_TRIAGE_CONFIG, type TriageConfig } from '../core/config.js'

export interface Config extends TriageConfig {}

const screenersDefault = {
  staleOutput: { ...DEFAULT_TRIAGE_CONFIG.screeners.staleOutput },
  repeatedCall: { ...DEFAULT_TRIAGE_CONFIG.screeners.repeatedCall },
  failedCall: { ...DEFAULT_TRIAGE_CONFIG.screeners.failedCall },
  oversizedBlock: { ...DEFAULT_TRIAGE_CONFIG.screeners.oversizedBlock },
  staleReasoning: { ...DEFAULT_TRIAGE_CONFIG.screeners.staleReasoning },
}

export const Config: Schema = Schema.object({
  enabled: Schema.boolean().default(DEFAULT_TRIAGE_CONFIG.enabled),
  reserve: Schema.object({
    turns: Schema.number().default(DEFAULT_TRIAGE_CONFIG.reserve.turns),
  }).default({ ...DEFAULT_TRIAGE_CONFIG.reserve }),
  budget: Schema.object({
    contextTokens: Schema.number().default(DEFAULT_TRIAGE_CONFIG.budget.contextTokens),
    softRatio: Schema.number().default(DEFAULT_TRIAGE_CONFIG.budget.softRatio),
    hardRatio: Schema.number().default(DEFAULT_TRIAGE_CONFIG.budget.hardRatio),
    minSavingsTokens: Schema.number().default(DEFAULT_TRIAGE_CONFIG.budget.minSavingsTokens),
  }).default({ ...DEFAULT_TRIAGE_CONFIG.budget }),
  screeners: Schema.object({
    staleOutput: Schema.object({
      enabled: Schema.boolean().default(DEFAULT_TRIAGE_CONFIG.screeners.staleOutput.enabled),
      turns: Schema.number().default(DEFAULT_TRIAGE_CONFIG.screeners.staleOutput.turns),
    }).default(screenersDefault.staleOutput),
    repeatedCall: Schema.object({
      enabled: Schema.boolean().default(DEFAULT_TRIAGE_CONFIG.screeners.repeatedCall.enabled),
    }).default(screenersDefault.repeatedCall),
    failedCall: Schema.object({
      enabled: Schema.boolean().default(DEFAULT_TRIAGE_CONFIG.screeners.failedCall.enabled),
      turns: Schema.number().default(DEFAULT_TRIAGE_CONFIG.screeners.failedCall.turns),
      errorKeepChars: Schema.number().default(DEFAULT_TRIAGE_CONFIG.screeners.failedCall.errorKeepChars),
    }).default(screenersDefault.failedCall),
    oversizedBlock: Schema.object({
      enabled: Schema.boolean().default(DEFAULT_TRIAGE_CONFIG.screeners.oversizedBlock.enabled),
      capChars: Schema.number().default(DEFAULT_TRIAGE_CONFIG.screeners.oversizedBlock.capChars),
      headChars: Schema.number().default(DEFAULT_TRIAGE_CONFIG.screeners.oversizedBlock.headChars),
      tailChars: Schema.number().default(DEFAULT_TRIAGE_CONFIG.screeners.oversizedBlock.tailChars),
    }).default(screenersDefault.oversizedBlock),
    staleReasoning: Schema.object({
      enabled: Schema.boolean().default(DEFAULT_TRIAGE_CONFIG.screeners.staleReasoning.enabled),
      keepTurns: Schema.number().default(DEFAULT_TRIAGE_CONFIG.screeners.staleReasoning.keepTurns),
      maxBlockChars: Schema.number().default(DEFAULT_TRIAGE_CONFIG.screeners.staleReasoning.maxBlockChars),
    }).default(screenersDefault.staleReasoning),
  }).default(screenersDefault),
  exempt: Schema.object({
    tools: Schema.array(String).default([...DEFAULT_TRIAGE_CONFIG.exempt.tools]),
    filePatterns: Schema.array(String).default([...DEFAULT_TRIAGE_CONFIG.exempt.filePatterns]),
  }).default({
    tools: [...DEFAULT_TRIAGE_CONFIG.exempt.tools],
    filePatterns: [...DEFAULT_TRIAGE_CONFIG.exempt.filePatterns],
  }),
  summary: Schema.object({
    capChars: Schema.number().default(DEFAULT_TRIAGE_CONFIG.summary.capChars),
    headRatio: Schema.number().default(DEFAULT_TRIAGE_CONFIG.summary.headRatio),
  }).default({ ...DEFAULT_TRIAGE_CONFIG.summary }),
})
