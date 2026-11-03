// 门禁阈值。改这里等于改架构判断，不要在别处硬编码。
export const SUPPORT_THRESHOLD = 0.8

// 单个会话的累计注入上限（字符）。到顶后只发缺口提示，不再往上下文里堆记忆。
export const SESSION_BUDGET = 600

// 本会话已经注入过的条目在 Φ / R 上打折：让位置给还没露过面的。
// 不做完全跳过——承诺这类记忆隔几轮再浮上来是有意义的。
export const INJECTED_PENALTY = 0.35
