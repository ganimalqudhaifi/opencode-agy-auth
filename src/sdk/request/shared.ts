import { AGY_GENERATIVE_LANGUAGE_ENDPOINT } from "../../constants";

const REQUEST_MODEL_FALLBACKS: Record<string, string> = {
  "gemini-2.5-flash-image": "gemini-2.5-flash",
};
const GENERATIVE_LANGUAGE_HOST = new URL(AGY_GENERATIVE_LANGUAGE_ENDPOINT).host;
const CODE_ASSIST_HOST_SUFFIX = "cloudcode-pa.googleapis.com";
const MODEL_ACTION_PATTERN = /\/models\/[^:]+:\w+/;

/**
 * 返回支持的 RequestInfo 输入的 URL 字符串。
 */
export function toRequestUrlString(value: RequestInfo): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof URL) {
    return value.toString();
  }
  const candidate = (value as Request).url;
  if (candidate) {
    return candidate;
  }
  return value.toString();
}

/**
 * 通过 URL 检测 Gemini/Generative Language API 请求。
 */
export function isGenerativeLanguageRequest(input: RequestInfo): input is string {
  const url = toRequestUrlString(input);
  return (
    url.includes(GENERATIVE_LANGUAGE_HOST) ||
    (url.includes(CODE_ASSIST_HOST_SUFFIX) && MODEL_ACTION_PATTERN.test(url))
  );
}

export function parseGenerativeLanguageRequest(input: RequestInfo):
  | { requestedModel: string; effectiveModel: string; action: string }
  | undefined {
  const match = toRequestUrlString(input).match(/\/models\/([^:]+):(\w+)/);
  if (!match) {
    return undefined;
  }

  const [, requestedModel = "", action = ""] = match;
  return {
    requestedModel,
    effectiveModel: REQUEST_MODEL_FALLBACKS[requestedModel] ?? requestedModel,
    action,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

export function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const str = readString(value);
    if (str) {
      return str;
    }
  }
  return undefined;
}

/**
 * 通过将 traceId 映射到 responseId，为下游客户端保留 Cloud Code 追踪标识。
 */
export function injectResponseIdFromTrace<T extends Record<string, unknown>>(body: T): T {
  const traceId = readString(body.traceId);
  if (!traceId) {
    return body;
  }

  const response = body.response;
  if (!isRecord(response)) {
    return body;
  }

  if (readString(response.responseId)) {
    return body;
  }

  return {
    ...body,
    response: {
      ...response,
      responseId: traceId,
    },
  };
}
