上下文分诊审计
原始转录约 1859 tokens，处理后约 815 tokens，节省 1044 tokens（56.2%）
切除消息 3 条，改写消息 6 条
按原因统计：
  重复调用: 2 条，节省 61 tokens
  过期输出: 2 条，节省 183 tokens
  失败调用: 2 条，节省 181 tokens
  超长块: 1 条，节省 569 tokens
  过期思考: 2 条，节省 50 tokens
明细：
  [seq 1 | assistant] 过期输出 → 改写（+31 tokens）：工具 bash 的早前输出已归档（距离最近用户消息 2 轮，阈值 2 轮）
  [seq 2 | tool-result] 过期输出 → 切除（-214 tokens）：工具 bash 的早前输出已归档（距离最近用户消息 2 轮，阈值 2 轮）
  [seq 3 | assistant] 重复调用 → 切除（-41 tokens）：与 grep 的重复调用（保留最近一次，seq 22）
  [seq 4 | tool-result] 重复调用 → 切除（-20 tokens）：与 grep 的重复调用（保留最近一次，seq 22）
  [seq 5 | assistant] 过期思考 → 改写（-23 tokens）：早于最近 1 轮用户消息的思考块已移除
  [seq 9 | assistant] 失败调用 → 改写（-0 tokens）：工具 bash 的失败调用（输入参数已清理，错误文本保留）
  [seq 10 | tool-result] 失败调用 → 改写（-181 tokens）：工具 bash 的失败调用（输入参数已清理，错误文本保留）
  [seq 11 | assistant] 过期思考 → 改写（-27 tokens）：早于最近 1 轮用户消息的思考块已移除
  [seq 12 | tool-result] 超长块 → 改写（-569 tokens）：工具结果超过 400 字符上限，已头尾裁剪

建议压缩区间：消息 [1..12]（原文约 1450 tokens → 摘要约 411 tokens）
