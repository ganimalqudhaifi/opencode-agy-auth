interface GoogleRpcErrorInfo {
  "@type"?: string;
  reason?: string;
  domain?: string;
  metadata?: Record<string, string>;
}

interface GoogleRpcQuotaViolation {
  quotaId?: string;
  description?: string;
}

interface GoogleRpcQuotaFailure {
  "@type"?: string;
  violations?: GoogleRpcQuotaViolation[];
}

interface GoogleRpcRetryInfo {
  "@type"?: string;
  retryDelay?: string | { seconds?: number; nanos?: number };
}

export interface QuotaContext {
  terminal: boolean;
  retryDelayMs?: number;
  reason?: string;
}

const CLOUDCODE_DOMAINS = new Set([
  "cloudcode-pa.googleapis.com",
  "staging-cloudcode-pa.googleapis.com",
  "autopush-cloudcode-pa.googleapis.com",
  "cloudaicompanion.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
]);

/**
 * NOTE: 特别设计——精细化 429 报错分类与重试策略
 * 传统的网络请求重试模块通常将 429 统一视作限流进行重试或报错。
 * 在此处我们做精细化解析：
 * 1. 区分“账号物理配额耗尽”与“模型瞬时容量超载（MODEL_CAPACITY_EXHAUSTED）”。
 * 2. 如果是物理配额耗尽，直接判定为不可重试的终端状态，避免做无意义的网络请求；
 *    如果是谷歌后端模型容量瞬时超载，则判定为可重试，解析响应中的 RetryInfo 延迟并通知上层（通过 TUI Toast 提示用户，并进行退避重试）。
 */
export async function classifyQuotaResponse(response: Response): Promise<QuotaContext | null> {
  const payload = await parseErrorBody(response);
  if (!payload) {
    return null;
  }

  const details = Array.isArray(payload.details) ? payload.details : [];
  const retryInfo = details.find(
    (detail): detail is GoogleRpcRetryInfo =>
      isObject(detail) &&
      detail["@type"] === "type.googleapis.com/google.rpc.RetryInfo",
  );
  const retryDelayMs =
    (retryInfo?.retryDelay ? parseRetryDelayValue(retryInfo.retryDelay) : null) ??
    parseRetryDelayFromMessage(payload.message ?? "") ??
    undefined;

  const errorInfo = details.find(
    (detail): detail is GoogleRpcErrorInfo =>
      isObject(detail) &&
      detail["@type"] === "type.googleapis.com/google.rpc.ErrorInfo",
  );

  if (errorInfo?.domain && !CLOUDCODE_DOMAINS.has(errorInfo.domain)) {
    return null;
  }
  if (errorInfo?.reason === "QUOTA_EXHAUSTED") {
    return { terminal: true, retryDelayMs, reason: errorInfo.reason };
  }
  if (errorInfo?.reason === "RATE_LIMIT_EXCEEDED") {
    return { terminal: false, retryDelayMs: retryDelayMs ?? 10_000, reason: errorInfo.reason };
  }
  if (errorInfo?.reason === "MODEL_CAPACITY_EXHAUSTED") {
    return {
      terminal: retryDelayMs === undefined,
      retryDelayMs,
      reason: errorInfo.reason,
    };
  }

  const quotaFailure = details.find(
    (detail): detail is GoogleRpcQuotaFailure =>
      isObject(detail) &&
      detail["@type"] === "type.googleapis.com/google.rpc.QuotaFailure",
  );
  if (quotaFailure?.violations?.length) {
    const allTexts = quotaFailure.violations
      .flatMap((violation) => [violation.quotaId ?? "", violation.description ?? ""])
      .join(" ")
      .toLowerCase();

    if (allTexts.includes("perday") || allTexts.includes("daily") || allTexts.includes("per day")) {
      return { terminal: true, retryDelayMs, reason: errorInfo?.reason };
    }
    if (allTexts.includes("perminute") || allTexts.includes("per minute")) {
      return { terminal: false, retryDelayMs: retryDelayMs ?? 60_000, reason: errorInfo?.reason };
    }
    return { terminal: false, retryDelayMs, reason: errorInfo?.reason };
  }

  const quotaLimit = errorInfo?.metadata?.quota_limit?.toLowerCase() ?? "";
  if (quotaLimit.includes("perminute") || quotaLimit.includes("per minute")) {
    return { terminal: false, retryDelayMs: retryDelayMs ?? 60_000, reason: errorInfo?.reason };
  }

  return { terminal: false, retryDelayMs, reason: errorInfo?.reason };
}

/**
 * 直接从错误负载中提取 RetryInfo 延迟提示信息。
 */
export async function parseRetryDelayFromBody(response: Response): Promise<number | null> {
  const payload = await parseErrorBody(response);
  if (!payload) {
    return null;
  }

  const details = Array.isArray(payload.details) ? payload.details : [];
  const retryInfo = details.find(
    (detail): detail is GoogleRpcRetryInfo =>
      isObject(detail) &&
      detail["@type"] === "type.googleapis.com/google.rpc.RetryInfo",
  );
  if (retryInfo?.retryDelay) {
    const delayMs = parseRetryDelayValue(retryInfo.retryDelay);
    if (delayMs !== null) {
      return delayMs;
    }
  }

  if (typeof payload.message === "string") {
    return parseRetryDelayFromMessage(payload.message);
  }
  return null;
}

function parseRetryDelayValue(value: string | { seconds?: number; nanos?: number }): number | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    if (trimmed.endsWith("ms")) {
      const milliseconds = Number(trimmed.slice(0, -2));
      return Number.isFinite(milliseconds) && milliseconds > 0 ? Math.round(milliseconds) : null;
    }
    const match = trimmed.match(/^([\d.]+)s$/);
    if (!match?.[1]) {
      return null;
    }
    const seconds = Number(match[1]);
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
  }

  const seconds = typeof value.seconds === "number" ? value.seconds : 0;
  const nanos = typeof value.nanos === "number" ? value.nanos : 0;
  if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) {
    return null;
  }
  const totalMs = Math.round(seconds * 1000 + nanos / 1e6);
  return totalMs > 0 ? totalMs : null;
}

function parseRetryDelayFromMessage(message: string): number | null {
  const retryMatch = message.match(/Please retry in ([0-9.]+(?:ms|s))/i);
  if (retryMatch?.[1]) {
    return parseRetryDelayValue(retryMatch[1]);
  }

  const afterMatch = message.match(/after\s+([0-9.]+(?:ms|s))/i);
  if (afterMatch?.[1]) {
    return parseRetryDelayValue(afterMatch[1]);
  }

  return null;
}

async function parseErrorBody(
  response: Response,
): Promise<{ message?: string; details?: unknown[] } | null> {
  let text = "";
  try {
    text = await response.clone().text();
  } catch {
    return null;
  }
  if (!text) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const normalized = normalizeErrorEnvelope(parsed);
  if (!normalized || !isObject(normalized.error)) {
    return null;
  }

  const error = normalized.error as Record<string, unknown>;
  return {
    message: typeof error.message === "string" ? error.message : undefined,
    details: Array.isArray(error.details) ? error.details : undefined,
  };
}

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object";
}

function normalizeErrorEnvelope(parsed: unknown): Record<string, unknown> | null {
  if (Array.isArray(parsed)) {
    const first = parsed[0];
    return isObject(first) ? first : null;
  }
  return isObject(parsed) ? parsed : null;
}

export const retryInternals = {
  parseRetryDelayValue,
  parseRetryDelayFromMessage,
};
