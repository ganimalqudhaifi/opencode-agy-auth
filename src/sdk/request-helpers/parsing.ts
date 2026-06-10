import type { GeminiApiBody, GeminiUsageMetadata } from "./types";

/**
 * 解析 Gemini API 响应体；处理 API 有时返回的数组包装响应。
 */
export function parseGeminiApiBody(rawText: string): GeminiApiBody | null {
  try {
    const parsed = JSON.parse(rawText);
    if (Array.isArray(parsed)) {
      const firstObject = parsed.find((item: unknown) => typeof item === "object" && item !== null);
      return firstObject && typeof firstObject === "object"
        ? (firstObject as GeminiApiBody)
        : null;
    }

    return parsed && typeof parsed === "object" ? (parsed as GeminiApiBody) : null;
  } catch {
    return null;
  }
}

/**
 * 从响应对象中提取 usageMetadata，并进行类型安全防护。
 */
export function extractUsageMetadata(body: GeminiApiBody): GeminiUsageMetadata | null {
  const usage = (body.response && typeof body.response === "object"
    ? (body.response as { usageMetadata?: unknown }).usageMetadata
    : undefined) as GeminiUsageMetadata | undefined;

  if (!usage || typeof usage !== "object") {
    return null;
  }

  const asRecord = usage as Record<string, unknown>;
  const toNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

  return {
    totalTokenCount: toNumber(asRecord.totalTokenCount),
    promptTokenCount: toNumber(asRecord.promptTokenCount),
    candidatesTokenCount: toNumber(asRecord.candidatesTokenCount),
    cachedContentTokenCount: toNumber(asRecord.cachedContentTokenCount),
  };
}
