export const GEMINI_PREVIEW_LINK = "https://goo.gle/enable-preview-features";

export interface GeminiApiError {
  code?: number;
  message?: string;
  status?: string;
  details?: unknown[];
  [key: string]: unknown;
}

/**
 * 我们触及的 Gemini API 响应的最小表示。
 */
export interface GeminiApiBody {
  response?: unknown;
  error?: GeminiApiError;
  [key: string]: unknown;
}

export interface GeminiErrorEnhancement {
  body?: GeminiApiBody;
  retryAfterMs?: number;
}

/**
 * Gemini 响应暴露的用量元数据。字段是可选的，以反映部分负载。
 */
export interface GeminiUsageMetadata {
  totalTokenCount?: number;
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
}

/**
 * Gemini 接受的思维链配置。
 */
export interface ThinkingConfig {
  thinkingBudget?: number;
  thinkingLevel?: string;
  includeThoughts?: boolean;
}

export interface GoogleRpcErrorInfo {
  "@type"?: string;
  reason?: string;
  domain?: string;
  metadata?: Record<string, string>;
}

export interface GoogleRpcHelp {
  "@type"?: string;
  links?: Array<{
    description?: string;
    url?: string;
  }>;
}

export interface GoogleRpcQuotaFailure {
  "@type"?: string;
  violations?: Array<{
    subject?: string;
    description?: string;
  }>;
}

export interface GoogleRpcRetryInfo {
  "@type"?: string;
  retryDelay?: string | { seconds?: number; nanos?: number };
}

export const CLOUDCODE_DOMAINS = [
  "cloudcode-pa.googleapis.com",
  "staging-cloudcode-pa.googleapis.com",
  "autopush-cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
];
