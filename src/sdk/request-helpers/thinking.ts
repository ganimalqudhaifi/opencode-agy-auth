import type { ThinkingConfig } from "./types";

/**
 * 将 thinkingConfig 别名规范化为标准的 Gemini 字段名。
 */
export function normalizeThinkingConfig(config: unknown): ThinkingConfig | undefined {
  if (!config || typeof config !== "object") {
    return undefined;
  }

  const record = config as Record<string, unknown>;
  const budgetRaw = record.thinkingBudget ?? record.thinking_budget;
  const levelRaw = record.thinkingLevel ?? record.thinking_level;
  const includeRaw = record.includeThoughts ?? record.include_thoughts;

  let thinkingBudget = typeof budgetRaw === "number" && Number.isFinite(budgetRaw) ? budgetRaw : undefined;
  const thinkingLevel =
    typeof levelRaw === "string" && levelRaw.trim().length > 0 ? levelRaw.trim().toUpperCase() : undefined;
  const includeThoughts = typeof includeRaw === "boolean" ? includeRaw : undefined;

  if (thinkingBudget === undefined && thinkingLevel === undefined && includeThoughts === undefined) {
    return undefined;
  }

  // 映射 thinkingLevel 到 thinkingBudget 并过滤，避免上游 v1internal 接口不兼容
  if (thinkingLevel !== undefined && thinkingBudget === undefined) {
    if (thinkingLevel === "HIGH") {
      thinkingBudget = 2048;
    } else if (thinkingLevel === "MEDIUM") {
      thinkingBudget = 1024;
    } else if (thinkingLevel === "LOW") {
      thinkingBudget = 512;
    } else if (thinkingLevel === "MINIMAL") {
      thinkingBudget = 0;
    } else {
      thinkingBudget = 1024;
    }
  }

  const finalIncludeThoughts =
    includeThoughts !== undefined
      ? includeThoughts
      : thinkingBudget !== undefined
        ? thinkingBudget > 0
        : undefined;

  const normalized: ThinkingConfig = {};
  if (thinkingBudget !== undefined) {
    normalized.thinkingBudget = thinkingBudget;
  }
  if (finalIncludeThoughts !== undefined) {
    normalized.includeThoughts = finalIncludeThoughts;
  }

  return normalized;
}
