import { createHash } from "node:crypto";
import { accessTokenExpired } from "./auth";
import type { OAuthAuthDetails } from "./types";
import { SignatureCache, createSignatureCache, type SignatureCacheConfig } from "../sdk/cache/signature-cache";

// 内存中缓存已登录账户的授权信息
const authCache = new Map<string, OAuthAuthDetails>();

/**
 * 规整并去除刷新令牌 refresh token 字符串的首尾空格
 */
function normalizeRefreshKey(refresh?: string): string | undefined {
  const key = refresh?.trim();
  return key ? key : undefined;
}

/**
 * 从缓存中提取有效的 OAuthAuthDetails，如果有可用且未过期的 Token 会进行复用，否则优先使用传入的最新值
 */
export function resolveCachedAuth(auth: OAuthAuthDetails): OAuthAuthDetails {
  const key = normalizeRefreshKey(auth.refresh);
  if (!key) {
    return auth;
  }

  const cached = authCache.get(key);
  if (!cached) {
    authCache.set(key, auth);
    return auth;
  }

  if (!accessTokenExpired(auth)) {
    authCache.set(key, auth);
    return auth;
  }

  if (!accessTokenExpired(cached)) {
    return cached;
  }

  authCache.set(key, auth);
  return auth;
}

/**
 * 显式更新或保存已授权的令牌信息到缓存中
 */
export function storeCachedAuth(auth: OAuthAuthDetails): void {
  const key = normalizeRefreshKey(auth.refresh);
  if (!key) {
    return;
  }
  authCache.set(key, auth);
}

/**
 * 清除已缓存的登录授权信息，若不传刷新令牌，则清除全局缓存
 */
export function clearCachedAuth(refresh?: string): void {
  if (!refresh) {
    authCache.clear();
    return;
  }
  const key = normalizeRefreshKey(refresh);
  if (key) {
    authCache.delete(key);
  }
}

// ============================================================================
// 思考签名缓存层 (支持多轮对话中对 Gemini 和 Claude 签名状态对齐的自愈)
// ============================================================================

interface SignatureEntry {
  signature: string;
  timestamp: number;
}

// 内存缓存层: sessionId -> Map<textHash, SignatureEntry>
const signatureCache = new Map<string, Map<string, SignatureEntry>>();

// 缓存有效期设定为 1 小时
const SIGNATURE_CACHE_TTL_MS = 60 * 60 * 1000;

// 每个 session 的最大缓存量，防止长时间不关闭时发生内存泄漏
const MAX_ENTRIES_PER_SESSION = 100;

// 取 sha256 结果前 16 位 16 进制字符作为 textHash 的键宽
const SIGNATURE_TEXT_HASH_HEX_LEN = 16;

// 磁盘级持久化缓存实例
let diskCache: SignatureCache | null = null;

/**
 * 初始化磁盘级别的签名存储管理器
 */
export function initDiskSignatureCache(config: SignatureCacheConfig | undefined): SignatureCache | null {
  diskCache = createSignatureCache(config);
  return diskCache;
}

/**
 * 对思维链内容计算稳定的 sha256 哈希，截取前 16 位作为唯一键
 */
function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, SIGNATURE_TEXT_HASH_HEX_LEN);
}

/**
 * 构建磁盘存储上复合的主键 sessionId:textHash
 */
function makeDiskKey(sessionId: string, textHash: string): string {
  return `${sessionId}:${textHash}`;
}

// 最新签名映射：sessionId -> 最近一次的签名字符串
const latestSignatureMap = new Map<string, string>();

/**
 * 缓存某次思维链片段和其对应的服务签名，同时将其同步存储到磁盘中
 */
export function cacheSignature(sessionId: string, text: string, signature: string): void {
  if (!sessionId || !text || !signature) return;

  const textHash = hashText(text);

  let sessionMemCache = signatureCache.get(sessionId);
  if (!sessionMemCache) {
    sessionMemCache = new Map();
    signatureCache.set(sessionId, sessionMemCache);
  }

  // 超过容量限制时，触发 LRU 清理过期条目
  if (sessionMemCache.size >= MAX_ENTRIES_PER_SESSION) {
    const now = Date.now();
    for (const [key, entry] of sessionMemCache.entries()) {
      if (now - entry.timestamp > SIGNATURE_CACHE_TTL_MS) {
        sessionMemCache.delete(key);
      }
    }
    // 若依然超限，直接丢弃时间戳最老的前 25% 条目
    if (sessionMemCache.size >= MAX_ENTRIES_PER_SESSION) {
      const entries = Array.from(sessionMemCache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toRemove = entries.slice(0, Math.floor(MAX_ENTRIES_PER_SESSION / 4));
      for (const [key] of toRemove) {
        sessionMemCache.delete(key);
      }
    }
  }

  sessionMemCache.set(textHash, { signature, timestamp: Date.now() });
  latestSignatureMap.set(sessionId, signature);

  // 如果启用了磁盘持久化，同步写盘
  if (diskCache) {
    const diskKey = makeDiskKey(sessionId, textHash);
    diskCache.store(diskKey, signature);
    // 同时以 sessionId 直接作为 key 存储最新的签名值，用于应对不需要 textHash 的全局签名恢复
    diskCache.store(sessionId, signature);
  }
}

/**
 * 恢复并获取某会话下最近一次被缓存的签名（支持签名恢复）
 */
export function getLatestSignature(sessionId: string): string | undefined {
  if (!sessionId) return undefined;

  // 优先从内存缓存中获取
  const memValue = latestSignatureMap.get(sessionId);
  if (memValue) return memValue;

  // 内存未命中，退化至磁盘中查询
  if (diskCache) {
    const diskValue = diskCache.retrieve(sessionId);
    if (diskValue) {
      // 读出后自动升入内存 Map，加速后续查询
      latestSignatureMap.set(sessionId, diskValue);
      return diskValue;
    }
  }

  return undefined;
}

export type { SignatureCache } from "../sdk/cache/signature-cache";
export type { SignatureCacheConfig } from "../sdk/cache/signature-cache";
