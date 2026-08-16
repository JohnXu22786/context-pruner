/**
 * 分诊配置：框架无关的配置模型 + 默认值 + 校验。
 * dsh 侧的 Schemastery Schema（src/dsh/config-schema.ts）与此模型一一对应。
 */

export interface TriageConfig {
  /** 总开关。 */
  enabled: boolean
  /** 保留区：最近 N 个用户轮次内的内容不接受任何处理。 */
  reserve: {
    turns: number
  }
  /** 上下文预算：决定压力（pressure）与强制（hard）阈值。 */
  budget: {
    /** 预估上下文窗口大小（token），按模型调整。 */
    contextTokens: number
    /** 使用率超过该比例 → 建议压缩。 */
    softRatio: number
    /** 使用率超过该比例 → 强制压缩。 */
    hardRatio: number
    /** 预估节省低于该值时不做任何动作（避免无意义改写）。 */
    minSavingsTokens: number
  }
  screeners: {
    /** 过期输出：距最近用户消息超过 turns 轮的完整调用对 → 归档为摘要。 */
    staleOutput: { enabled: boolean; turns: number }
    /** 重复调用：同工具同参数（键序无关）→ 仅保留最近一次。 */
    repeatedCall: { enabled: boolean }
    /** 失败调用：过期错误结果 → 参数替换为失败桩，错误文本保留并裁剪。 */
    failedCall: { enabled: boolean; turns: number; errorKeepChars: number }
    /** 超长块：超过上限的工具结果文本 → 头尾裁剪。 */
    oversizedBlock: { enabled: boolean; capChars: number; headChars: number; tailChars: number }
    /** 过期思考块：保留最近 keepTurns 轮的思考，其余剔除；保留的超出 maxBlockChars 时裁剪。 */
    staleReasoning: { enabled: boolean; keepTurns: number; maxBlockChars: number }
  }
  /** 豁免：命中清单的工具调用对不参与任何筛查。 */
  exempt: {
    /** 工具名清单（默认覆盖有状态/权威性工具）。 */
    tools: string[]
    /** 参数 filePath/path 命中这些 glob 的工具调用对不参与过期与失败处理。 */
    filePatterns: string[]
  }
  /** 压缩摘要（compaction 落地的用户消息）规模控制。 */
  summary: {
    /** 摘要字符上限，超出后头尾裁剪。 */
    capChars: number
    /** 裁剪时头部保留比例（(0,1)）。 */
    headRatio: number
  }
}

export const DEFAULT_TRIAGE_CONFIG: TriageConfig = {
  enabled: true,
  reserve: { turns: 3 },
  budget: {
    contextTokens: 1_000_000,
    softRatio: 0.7,
    hardRatio: 0.9,
    minSavingsTokens: 2000,
  },
  screeners: {
    staleOutput: { enabled: true, turns: 8 },
    repeatedCall: { enabled: true },
    failedCall: { enabled: true, turns: 4, errorKeepChars: 400 },
    oversizedBlock: { enabled: true, capChars: 6000, headChars: 800, tailChars: 400 },
    staleReasoning: { enabled: true, keepTurns: 3, maxBlockChars: 2000 },
  },
  exempt: {
    tools: ['task', 'skill', 'todowrite', 'todoread', 'write', 'edit', 'batch'],
    filePatterns: [],
  },
  summary: { capChars: 20000, headRatio: 0.4 },
}

/** 分节合并 + 校验；非法值直接抛错，便于 dsh 加载期快速失败。 */
export function resolveTriageConfig(input?: Partial<TriageConfig>): TriageConfig {
  const merged: TriageConfig = {
    ...DEFAULT_TRIAGE_CONFIG,
    ...input,
    reserve: { ...DEFAULT_TRIAGE_CONFIG.reserve, ...input?.reserve },
    budget: { ...DEFAULT_TRIAGE_CONFIG.budget, ...input?.budget },
    screeners: {
      staleOutput: { ...DEFAULT_TRIAGE_CONFIG.screeners.staleOutput, ...input?.screeners?.staleOutput },
      repeatedCall: { ...DEFAULT_TRIAGE_CONFIG.screeners.repeatedCall, ...input?.screeners?.repeatedCall },
      failedCall: { ...DEFAULT_TRIAGE_CONFIG.screeners.failedCall, ...input?.screeners?.failedCall },
      oversizedBlock: { ...DEFAULT_TRIAGE_CONFIG.screeners.oversizedBlock, ...input?.screeners?.oversizedBlock },
      staleReasoning: { ...DEFAULT_TRIAGE_CONFIG.screeners.staleReasoning, ...input?.screeners?.staleReasoning },
    },
    exempt: {
      tools: input?.exempt?.tools ?? DEFAULT_TRIAGE_CONFIG.exempt.tools,
      filePatterns: input?.exempt?.filePatterns ?? DEFAULT_TRIAGE_CONFIG.exempt.filePatterns,
    },
    summary: { ...DEFAULT_TRIAGE_CONFIG.summary, ...input?.summary },
  }
  validateTriageConfig(merged)
  return merged
}

function validateTriageConfig(c: TriageConfig): void {
  const bad = (message: string): never => {
    throw new Error(`[context-triage] 非法配置：${message}`)
  }
  // 数值字段先做类型检查：显式 undefined/字符串等会在比较中静默通过，必须显式拒绝
  const num = (v: unknown, name: string): number => {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    return bad(`${name} 必须是有限数字`)
  }
  if (num(c.reserve.turns, 'reserve.turns') < 0) bad('reserve.turns 不能为负')
  if (num(c.budget.contextTokens, 'budget.contextTokens') <= 0) bad('budget.contextTokens 必须为正数')
  const soft = num(c.budget.softRatio, 'budget.softRatio')
  const hard = num(c.budget.hardRatio, 'budget.hardRatio')
  if (!(soft > 0 && soft < hard && hard <= 1)) bad('budget 需满足 0 < softRatio < hardRatio <= 1')
  if (num(c.budget.minSavingsTokens, 'budget.minSavingsTokens') < 0) bad('budget.minSavingsTokens 不能为负')
  if (num(c.screeners.staleOutput.turns, 'screeners.staleOutput.turns') < 0) bad('screeners.staleOutput.turns 不能为负')
  if (num(c.screeners.failedCall.turns, 'screeners.failedCall.turns') < 0) bad('screeners.failedCall.turns 不能为负')
  if (num(c.screeners.failedCall.errorKeepChars, 'screeners.failedCall.errorKeepChars') <= 0) {
    bad('screeners.failedCall.errorKeepChars 必须为正数')
  }
  const ob = c.screeners.oversizedBlock
  const cap = num(ob.capChars, 'screeners.oversizedBlock.capChars')
  const head = num(ob.headChars, 'screeners.oversizedBlock.headChars')
  const tail = num(ob.tailChars, 'screeners.oversizedBlock.tailChars')
  if (cap <= 0 || head <= 0 || tail <= 0) bad('screeners.oversizedBlock 各字符上限必须为正数')
  if (head + tail >= cap) bad('screeners.oversizedBlock.headChars + tailChars 必须小于 capChars')
  if (num(c.screeners.staleReasoning.keepTurns, 'screeners.staleReasoning.keepTurns') < 0) {
    bad('screeners.staleReasoning.keepTurns 不能为负')
  }
  if (num(c.screeners.staleReasoning.maxBlockChars, 'screeners.staleReasoning.maxBlockChars') <= 0) {
    bad('screeners.staleReasoning.maxBlockChars 必须为正数')
  }
  const s = c.summary
  if (num(s.capChars, 'summary.capChars') <= 0) bad('summary.capChars 必须为正数')
  const ratio = num(s.headRatio, 'summary.headRatio')
  if (!(ratio > 0 && ratio < 1)) bad('summary.headRatio 必须在 (0,1) 内')
}
