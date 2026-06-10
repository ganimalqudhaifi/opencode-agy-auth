import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";

// =============================================================================
/**
 * NOTE: 特别设计——跨轮次签名磁盘级持久化缓存
 * Google Agy / Gemini 2.5/3 思考模型引入了严苛的“思考签名校验（Thought Signature Validation）”限制：
 * 在多轮对话（特别是包含 Tool 调用的场景）中，下一次请求必须携带与上一次 API 返回值完全一致的上下文签名（thoughtSignature）。
 * 为了避免以下情况导致对话报错崩溃：
 * 1. IDE 侧会话生命周期重建，导致内存中的签名状态丢失。
 * 2. 多轮 Tool 交互产生的并发包打乱了签名的内存缓存。
 * 我们在这里实现了一个后台线程定时批量写盘的磁盘缓存层。以会话 ID（sessionId）和历史思维链的摘要哈希组合作为 Key，
 * 对签名和思维链做持久化，即使 IDE 重启或发生轮次分裂，依然能拉回最新且匹配的签名以完成官方的校验约束。
 */
// 类型与接口定义 (Types & Interfaces)
// =============================================================================

/**
 * 签名缓存配置项
 */
export interface SignatureCacheConfig {
  /** 是否启用缓存 */
  enabled: boolean;
  /** 内存缓存的生存时间（秒） */
  memory_ttl_seconds: number;
  /** 磁盘缓存的生存时间（秒） */
  disk_ttl_seconds: number;
  /** 自动写盘的间隔时间（秒） */
  write_interval_seconds: number;
}

/**
 * 缓存的单条数据条目
 */
interface CacheEntry {
  /** 缓存的值（比如签名） */
  value: string;
  /** 时间戳（毫秒） */
  timestamp: number;
  /** 完整的思维链文本内容（可选，用于压缩后自愈恢复） */
  thinkingText?: string;
  /** 思维链文本的预览（仅用于调试日志） */
  textPreview?: string;
  /** 与此思维链块关联的工具调用 ID 列表 */
  toolIds?: string[];
}

/**
 * 保存到磁盘上的完整缓存结构
 */
interface CacheData {
  /** 版本号 */
  version: "1.0";
  /** 内存 TTL 配置 */
  memory_ttl_seconds: number;
  /** 磁盘 TTL 配置 */
  disk_ttl_seconds: number;
  /** 缓存条目映射表 */
  entries: Record<string, CacheEntry>;
  /** 统计数据 */
  statistics: {
    /** 内存命中次数 */
    memory_hits: number;
    /** 磁盘命中次数 */
    disk_hits: number;
    /** 未命中次数 */
    misses: number;
    /** 写盘次数 */
    writes: number;
    /** 上次写盘时间戳 */
    last_write: number;
  };
}

/**
 * 缓存运行时的状态和统计信息
 */
interface CacheStats {
  /** 内存命中次数 */
  memoryHits: number;
  /** 磁盘命中次数 */
  diskHits: number;
  /** 未命中次数 */
  misses: number;
  /** 写盘次数 */
  writes: number;
  /** 当前保存在内存中的条目总数 */
  memoryEntries: number;
  /** 缓存是否处于脏状态（有未存盘的数据） */
  dirty: boolean;
  /** 磁盘存储是否启用 */
  diskEnabled: boolean;
}

/**
 * 获取完整思维链缓存数据结构
 */
export interface ThinkingCacheData {
  /** 思维链文本 */
  text: string;
  /** 签名 */
  signature: string;
  /** 关联的工具 ID 列表 */
  toolIds?: string[];
}

// =============================================================================
// 文件与目录工具函数 (Path & Storage Utilities)
// =============================================================================

/**
 * 获取插件配置保存目录
 */
function getConfigDir(): string {
  const platform = process.platform;
  if (platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "opencode");
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "opencode");
}

/**
 * 获取缓存文件的保存绝对路径
 */
function getCacheFilePath(): string {
  return join(getConfigDir(), "antigravity-signature-cache.json");
}

/**
 * 同步确保配置文件被加到 .gitignore，避免泄露签名和缓存
 */
function ensureGitignoreSync(configDir: string): void {
  const gitignorePath = join(configDir, ".gitignore");
  const entries = [".gitignore", "antigravity-signature-cache.json"];
  try {
    let content = "";
    if (existsSync(gitignorePath)) {
      content = readFileSync(gitignorePath, "utf-8");
    }
    const existingLines = content.split("\n").map((line) => line.trim());
    const missing = entries.filter((e) => !existingLines.includes(e));
    if (missing.length === 0) return;
    if (content === "") {
      writeFileSync(gitignorePath, missing.join("\n") + "\n", "utf-8");
    } else {
      const suffix = content.endsWith("\n") ? "" : "\n";
      appendFileSync(gitignorePath, suffix + missing.join("\n") + "\n", "utf-8");
    }
  } catch {
    // 忽略异常：防泄露属于非阻塞的次要功能
  }
}

// =============================================================================
// 签名缓存管理器主类 (Signature Cache Manager)
// =============================================================================

export class SignatureCache {
  // 内存缓存映射表
  private cache: Map<string, CacheEntry> = new Map();
  
  // 配置项
  private memoryTtlMs: number;
  private diskTtlMs: number;
  private writeIntervalMs: number;
  private cacheFilePath: string;
  private enabled: boolean;
  
  // 状态变量
  private dirty: boolean = false;
  private writeTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  
  // 统计指标
  private stats = {
    memoryHits: 0,
    diskHits: 0,
    misses: 0,
    writes: 0,
  };

  constructor(config: SignatureCacheConfig) {
    this.enabled = config.enabled;
    this.memoryTtlMs = config.memory_ttl_seconds * 1000;
    this.diskTtlMs = config.disk_ttl_seconds * 1000;
    this.writeIntervalMs = config.write_interval_seconds * 1000;
    this.cacheFilePath = getCacheFilePath();

    if (this.enabled) {
      this.loadFromDisk();
      this.startBackgroundTasks();
    }
  }

  // ===========================================================================
  // 公开的签名缓存 API (Public Signature API)
  // ===========================================================================

  /**
   * 基于会话 ID 和模型 ID 生成唯一的缓存键
   */
  static makeKey(sessionId: string, modelId: string): string {
    return `${sessionId}:${modelId}`;
  }

  /**
   * 将一个签名存入缓存中（标记为脏状态，等待后台写盘）
   */
  store(key: string, signature: string): void {
    if (!this.enabled) return;

    this.cache.set(key, {
      value: signature,
      timestamp: Date.now(),
    });
    this.dirty = true;
  }

  /**
   * 从缓存中检索签名，并更新命中统计
   * 若过期或不存在则返回 null
   */
  retrieve(key: string): string | null {
    if (!this.enabled) return null;

    const entry = this.cache.get(key);
    if (entry) {
      const age = Date.now() - entry.timestamp;
      if (age <= this.memoryTtlMs) {
        this.stats.memoryHits++;
        return entry.value;
      }
      // 已在内存中过期，删除
      this.cache.delete(key);
    }

    this.stats.misses++;
    return null;
  }

  /**
   * 检查某个键在缓存中是否有效且未过期（不影响统计数据）
   */
  has(key: string): boolean {
    if (!this.enabled) return false;

    const entry = this.cache.get(key);
    if (!entry) return false;

    const age = Date.now() - entry.timestamp;
    return age <= this.memoryTtlMs;
  }

  // ===========================================================================
  // 思维链全量缓存 API (Full Thinking Cache API)
  // ===========================================================================

  /**
   * 缓存完整的思维链文本内容及签名
   * 即使后续的上下文遭到压缩，我们也能从中自愈和恢复历史上下文中的 thought block。
   */
  storeThinking(
    key: string,
    thinkingText: string,
    signature: string,
    toolIds?: string[],
  ): void {
    if (!this.enabled || !thinkingText || !signature) return;

    this.cache.set(key, {
      value: signature,
      timestamp: Date.now(),
      thinkingText,
      textPreview: thinkingText.slice(0, 100),
      toolIds,
    });
    this.dirty = true;
  }

  /**
   * 从缓存中提取完整的思维链信息
   */
  retrieveThinking(key: string): ThinkingCacheData | null {
    if (!this.enabled) return null;

    const entry = this.cache.get(key);
    if (!entry || !entry.thinkingText) return null;

    const age = Date.now() - entry.timestamp;
    if (age > this.memoryTtlMs) {
      this.cache.delete(key);
      return null;
    }

    this.stats.memoryHits++;
    return {
      text: entry.thinkingText,
      signature: entry.value,
      toolIds: entry.toolIds,
    };
  }

  /**
   * 检查是否存在某个键的完整思维链内容
   */
  hasThinking(key: string): boolean {
    if (!this.enabled) return false;

    const entry = this.cache.get(key);
    if (!entry || !entry.thinkingText) return false;

    const age = Date.now() - entry.timestamp;
    return age <= this.memoryTtlMs;
  }

  /**
   * 获取当前缓存统计数据与内存占用情况
   */
  getStats(): CacheStats {
    return {
      ...this.stats,
      memoryEntries: this.cache.size,
      dirty: this.dirty,
      diskEnabled: this.enabled,
    };
  }

  /**
   * 手动触发立即保存到磁盘
   */
  async flush(): Promise<boolean> {
    if (!this.enabled) return true;
    return this.saveToDisk();
  }

  /**
   * 优雅关机：停止所有定时器，并将未写盘的数据保存到磁盘上
   */
  shutdown(): void {
    if (this.writeTimer) {
      clearInterval(this.writeTimer);
      this.writeTimer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    if (this.dirty && this.enabled) {
      this.saveToDisk();
    }
  }

  // ===========================================================================
  // 磁盘数据持久化操作 (Disk Operations)
  // ===========================================================================

  /**
   * 从磁盘中加载签名缓存，并验证 TTL 状态
   */
  private loadFromDisk(): void {
    try {
      if (!existsSync(this.cacheFilePath)) {
        return;
      }

      const content = readFileSync(this.cacheFilePath, "utf-8");
      const data = JSON.parse(content) as CacheData;

      if (data.version !== "1.0") {
        // 版本不匹配时，静默忽略并开始全新的缓存
        return;
      }

      const now = Date.now();
      for (const [key, entry] of Object.entries(data.entries)) {
        const age = now - entry.timestamp;
        if (age <= this.diskTtlMs) {
          this.cache.set(key, {
            value: entry.value,
            timestamp: entry.timestamp,
            thinkingText: entry.thinkingText,
            textPreview: entry.textPreview,
            toolIds: entry.toolIds,
          });
        }
      }
    } catch {
      // 容错处理：磁盘缓存加载失败时，静默开始全新内存缓存
    }
  }

  /**
   * 将内存缓存同步保存到磁盘上（采用先写临时文件后 rename 的原子写入模式）
   * 写入时会与磁盘上原有的未过期数据条目进行合并
   */
  private saveToDisk(): boolean {
    try {
      const dir = dirname(this.cacheFilePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      ensureGitignoreSync(dir);

      const now = Date.now();

      // 步骤 1: 读取现存的磁盘数据条目
      let existingEntries: Record<string, CacheEntry> = {};
      if (existsSync(this.cacheFilePath)) {
        try {
          const content = readFileSync(this.cacheFilePath, "utf-8");
          const data = JSON.parse(content) as CacheData;
          existingEntries = data.entries || {};
        } catch {
          // 容错：如果格式错误或损坏，直接覆盖
        }
      }

      // 步骤 2: 过滤已过期的磁盘条目
      const validDiskEntries: Record<string, CacheEntry> = {};
      for (const [key, entry] of Object.entries(existingEntries)) {
        const age = now - entry.timestamp;
        if (age <= this.diskTtlMs) {
          validDiskEntries[key] = entry;
        }
      }

      // 步骤 3: 内存缓存覆盖或合并到有效磁盘条目中（内存数据最新，优先级最高）
      const mergedEntries: Record<string, CacheEntry> = { ...validDiskEntries };
      for (const [key, entry] of this.cache.entries()) {
        mergedEntries[key] = {
          value: entry.value,
          timestamp: entry.timestamp,
          thinkingText: entry.thinkingText,
          textPreview: entry.textPreview,
          toolIds: entry.toolIds,
        };
      }

      // 步骤 4: 构建需要持久化的结构体
      const cacheData: CacheData = {
        version: "1.0",
        memory_ttl_seconds: this.memoryTtlMs / 1000,
        disk_ttl_seconds: this.diskTtlMs / 1000,
        entries: mergedEntries,
        statistics: {
          memory_hits: this.stats.memoryHits,
          disk_hits: this.stats.diskHits,
          misses: this.stats.misses,
          writes: this.stats.writes + 1,
          last_write: now,
        },
      };

      // 步骤 5: 原子写入（先写临时文件，重命名完成最终持久化，防止损坏现有数据）
      const tmpPath = join(tmpdir(), `antigravity-cache-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
      writeFileSync(tmpPath, JSON.stringify(cacheData, null, 2), "utf-8");

      try {
        renameSync(tmpPath, this.cacheFilePath);
      } catch {
        // 在 Windows 跨卷重命名可能会失败，fallback 到复制 + 删除
        writeFileSync(this.cacheFilePath, readFileSync(tmpPath));
        try {
          unlinkSync(tmpPath);
        } catch {
          // 忽略临时文件删除失败
        }
      }

      this.stats.writes++;
      this.dirty = false;
      return true;
    } catch {
      // 磁盘缓存写盘是非核心流程，静默失败即可
      return false;
    }
  }

  // ===========================================================================
  // 后台自动定时任务 (Background Tasks)
  // ===========================================================================

  /**
   * 启动自动保存和自动清理过期内存条目的定时器
   */
  private startBackgroundTasks(): void {
    // 定期写盘（如果发生过修改）
    this.writeTimer = setInterval(() => {
      if (this.dirty) {
        this.saveToDisk();
      }
    }, this.writeIntervalMs);

    // 每 30 分钟进行一次内存垃圾清理，腾出闲置空间
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired();
    }, 30 * 60 * 1000);
  }

  /**
   * 移除内存中超过生存周期的过期缓存
   */
  private cleanupExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      const age = now - entry.timestamp;
      if (age > this.memoryTtlMs) {
        this.cache.delete(key);
      }
    }
  }
}

// =============================================================================
// 工厂辅助函数 (Factory function)
// =============================================================================

/**
 * 根据配置实例化签名缓存对象。如果配置未启用则返回 null
 */
export function createSignatureCache(config: SignatureCacheConfig | undefined): SignatureCache | null {
  if (!config || !config.enabled) {
    return null;
  }
  return new SignatureCache(config);
}
