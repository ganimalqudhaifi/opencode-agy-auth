import { parseRetryDelayFromBody } from "./quota";

export const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_DELAY_MS = 5000;
const DEFAULT_MAX_DELAY_MS = 30000;

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC",
  "ERR_SSL_BAD_RECORD_MAC",
  "EPROTO",
]);

/**
 * 在尝试重试之前，确保请求体是可重放的。
 */
export function canRetryRequest(init: RequestInit | undefined): boolean {
  if (!init?.body) {
    return true;
  }

  const body = init.body;
  if (typeof body === "string") {
    return true;
  }
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    return true;
  }
  if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) {
    return true;
  }
  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(body)) {
    return true;
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return true;
  }

  return false;
}

/**
 * 基于状态码的重试策略，与 Gemini/Agy CLI 保持一致。
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * 处理瞬时网络故障（包含嵌套在 `cause.code` 中的错误码）。
 */
export function isRetryableNetworkError(error: unknown): boolean {
  const code = getNetworkErrorCode(error);
  if (code && RETRYABLE_NETWORK_CODES.has(code)) {
    return true;
  }

  return error instanceof Error && error.message.toLowerCase().includes("fetch failed");
}

/**
 * 优先通过 Retry-After 响应头、响应体中的配额信息或 fallback 指数退避策略来解析重试的延迟毫秒数。
 */
export async function resolveRetryDelayMs(
  response: Response,
  attempt: number,
  quotaDelayMs?: number,
): Promise<number> {
  const retryAfterMsHeader = parseRetryAfterMs(response.headers.get("retry-after-ms"));
  if (retryAfterMsHeader !== null) {
    return clampDelay(retryAfterMsHeader);
  }

  const retryAfterHeader = parseRetryAfter(response.headers.get("retry-after"));
  if (retryAfterHeader !== null) {
    return clampDelay(retryAfterHeader);
  }

  if (quotaDelayMs !== undefined) {
    return clampDelay(quotaDelayMs);
  }

  const bodyDelay = await parseRetryDelayFromBody(response);
  if (bodyDelay !== null) {
    return clampDelay(bodyDelay);
  }

  return getExponentialDelayWithJitter(attempt);
}

export function getExponentialDelayWithJitter(attempt: number): number {
  const base = Math.min(DEFAULT_MAX_DELAY_MS, DEFAULT_INITIAL_DELAY_MS * Math.pow(2, attempt - 1));
  const jitter = base * 0.3 * (Math.random() * 2 - 1);
  return clampDelay(base + jitter);
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getNetworkErrorCode(error: unknown): string | undefined {
  const readCode = (value: unknown): string | undefined => {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    if ("code" in value && typeof (value as { code?: unknown }).code === "string") {
      return (value as { code: string }).code;
    }
    return undefined;
  };

  const direct = readCode(error);
  if (direct) {
    return direct;
  }

  let cursor: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!cursor || typeof cursor !== "object" || !("cause" in cursor)) {
      break;
    }
    cursor = (cursor as { cause?: unknown }).cause;
    const code = readCode(cursor);
    if (code) {
      return code;
    }
  }
  return undefined;
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.round(parsed);
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.round(seconds * 1000));
  }
  const parsedDate = Date.parse(trimmed);
  if (!Number.isNaN(parsedDate)) {
    return Math.max(0, parsedDate - Date.now());
  }
  return null;
}

function clampDelay(delayMs: number): number {
  if (!Number.isFinite(delayMs)) {
    return DEFAULT_MAX_DELAY_MS;
  }
  return Math.min(Math.max(0, Math.round(delayMs)), DEFAULT_MAX_DELAY_MS);
}
