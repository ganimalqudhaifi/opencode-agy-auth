import { createHash } from "node:crypto";

/**
 * NOTE: 特别设计——流式去重与签名状态自愈
 * Agy/Gemini 官方 API 具有以下非标行为和严格约束，必须在此处进行特殊处理：
 * 1. 【流式去重】：官方 API 在 streaming 阶段返回的数据包中，思维链 (Thinking) 内容是累加输出的。
 *    我们必须对每次返回的 delta 进行哈希比对与剪裁，防止 IDE 接收到重复的文字。
 * 2. 【签名状态自愈】：多轮对话中，如果因为 tool 调用或者客户端状态断裂导致 thoughtSignature 丢失，
 *    官方接口会抛出签名不匹配的错误。此处设计了自动检测机制（如 needsThinkingRecovery），在签名断裂时，
 *    自动在上下文 messages 中回插/对齐兜底的思维链片段与签名，使对话链路能够自愈并继续进行。
 */

// ============================================================================
// 类型与接口定义 (Types & Interfaces)
// ============================================================================

/**
 * 缓存的已签名思维链数据结构
 */
export interface SignedThinking {
  /** 完整的思维链文本内容 */
  text: string;
  /** 对应的服务器签名 */
  signature: string;
}

/**
 * 签名存储管理器的外部契约接口
 */
export interface SignatureStore {
  get(sessionKey: string): SignedThinking | undefined;
  set(sessionKey: string, value: SignedThinking): void;
  has(sessionKey: string): boolean;
  delete(sessionKey: string): void;
}

/**
 * 流式处理阶段的自定义回调函数集合
 */
export interface StreamingCallbacks {
  /** 当缓存到最新的思维链及签名时触发 */
  onCacheSignature?: (sessionKey: string, text: string, signature: string) => void;
  /** 当需要注入调试说明（如配额超限警告）到流中时触发 */
  onInjectDebug?: (response: unknown, debugText: string) => unknown;
  /** 转换自定义思维链部件的方法 */
  transformThinkingParts?: (parts: unknown) => unknown;
}

/**
 * 流式处理阶段的配置参数
 */
export interface StreamingOptions {
  /** 签名会话的唯一标识，用于跨轮次签名恢复 */
  signatureSessionKey?: string;
  /** 需要注入流中的调试文本（可选） */
  debugText?: string;
  /** 是否在此流中缓存最新生成的签名 */
  cacheSignatures?: boolean;
  /** 已经渲染出的思维链哈希集合，用于在工具调用循环中避免重复输出 */
  displayedThinkingHashes?: Set<string>;
}

/**
 * 缓存特定索引或类型的思维链文本缓冲区（应对流式分块累加输出）
 */
export interface ThoughtBuffer {
  get(index: number): string | undefined;
  set(index: number, text: string): void;
  clear(): void;
}

/**
 * 多轮对话运行时智能体与工具交互的状态记录
 */
export interface ConversationState {
  /** 是否处于未完成的工具调用循环中（即上次以 functionResponse 结尾，本轮继续） */
  inToolLoop: boolean;
  /** 当前这一轮对话中，首条模型回复消息的数组索引 */
  turnStartIdx: number;
  /** 当前一轮对话的开始是否包含思维链（thought） */
  turnHasThinking: boolean;
  /** 最后一条模型回复消息的数组索引 */
  lastModelIdx: number;
  /** 最后一条模型消息是否包含思维链 */
  lastModelHasThinking: boolean;
  /** 最后一条模型消息是否包含工具调用（tool_use） */
  lastModelHasToolCalls: boolean;
}

// ============================================================================
// 缓冲区与存储工厂函数 (Stores & Buffers Factories)
// ============================================================================

/**
 * 创建一个基于内存 Map 的签名存储管理器
 */
export function createSignatureStore(): SignatureStore {
  const store = new Map<string, SignedThinking>();

  return {
    get: (key: string) => store.get(key),
    set: (key: string, value: SignedThinking) => {
      store.set(key, value);
    },
    has: (key: string) => store.has(key),
    delete: (key: string) => {
      store.delete(key);
    },
  };
}

/**
 * 创建一个用于暂存流式块的思维链文本累加缓冲区
 */
export function createThoughtBuffer(): ThoughtBuffer {
  const buffer = new Map<number, string>();

  return {
    get: (index: number) => buffer.get(index),
    set: (index: number, text: string) => {
      buffer.set(index, text);
    },
    clear: () => buffer.clear(),
  };
}

/**
 * 默认使用的全局内存签名存储
 */
export const defaultSignatureStore = createSignatureStore();

// ============================================================================
// 辅助哈希计算函数 (Hashing Helper)
// ============================================================================

/**
 * 生成一个字符串的快速哈希值（DJB2 算法），用来去重已输出的思维链块
 */
function hashString(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

// ============================================================================
// 思考状态检测与历史自愈辅助逻辑 (Detection & Recovery Helpers)
// ============================================================================

/**
 * 判断某个消息部件是否属于思维链类型
 * 兼容 Gemini（thought 字段）和 Claude（type: "thinking" 等）
 */
function isThinkingPart(part: any): boolean {
  if (!part || typeof part !== "object") return false;
  return (
    part.thought === true ||
    part.type === "thinking" ||
    part.type === "redacted_thinking"
  );
}

/**
 * 判断某个消息部件是否属于工具执行结果响应
 */
function isFunctionResponsePart(part: any): boolean {
  return part && typeof part === "object" && "functionResponse" in part;
}

/**
 * 判断某个消息部件是否属于模型发起的工具调用请求
 */
function isFunctionCallPart(part: any): boolean {
  return part && typeof part === "object" && "functionCall" in part;
}

/**
 * 判断消息是否仅是工具执行返回的返回体（属于 role = user 但全是 functionResponse 的形式）
 */
function isToolResultMessage(msg: any): boolean {
  if (!msg || msg.role !== "user") return false;
  const parts = msg.parts || [];
  return parts.some(isFunctionResponsePart);
}

/**
 * 判断一条消息中是否包含任意思维链段（包括 Gemini 数组格式或 Claude 的 content 格式）
 */
function messageHasThinking(msg: any): boolean {
  if (!msg || typeof msg !== "object") return false;

  if (Array.isArray(msg.parts)) {
    return msg.parts.some(isThinkingPart);
  }

  if (Array.isArray(msg.content)) {
    return msg.content.some(
      (block: any) =>
        block?.type === "thinking" || block?.type === "redacted_thinking",
    );
  }

  return false;
}

/**
 * 判断消息是否包含工具调用（支持 Gemini 与 Claude 的 tool_use）
 */
function messageHasToolCalls(msg: any): boolean {
  if (!msg || typeof msg !== "object") return false;

  if (Array.isArray(msg.parts)) {
    return msg.parts.some(isFunctionCallPart);
  }

  if (Array.isArray(msg.content)) {
    return msg.content.some((block: any) => block?.type === "tool_use");
  }

  return false;
}

/**
 * 分析多轮历史对话数组，提取出当前智能体的交互循环状态、模型消息位置、本轮是否含思维链等上下文指标
 */
export function analyzeConversationState(contents: any[]): ConversationState {
  const state: ConversationState = {
    inToolLoop: false,
    turnStartIdx: -1,
    turnHasThinking: false,
    lastModelIdx: -1,
    lastModelHasThinking: false,
    lastModelHasToolCalls: false,
  };

  if (!Array.isArray(contents) || contents.length === 0) {
    return state;
  }

  // 寻找最后一轮真实的人类用户提问位置
  let lastRealUserIdx = -1;
  for (let i = 0; i < contents.length; i++) {
    const msg = contents[i];
    if (msg?.role === "user" && !isToolResultMessage(msg)) {
      lastRealUserIdx = i;
    }
  }

  // 扫描所有的模型消息，提取最近一轮回复的特征
  for (let i = 0; i < contents.length; i++) {
    const msg = contents[i];
    const role = msg?.role;

    if (role === "model" || role === "assistant") {
      const hasThinking = messageHasThinking(msg);
      const hasToolCalls = messageHasToolCalls(msg);

      // 如果这是在最近一轮用户提问之后的首个模型消息，作为当前 turn 的起点
      if (i > lastRealUserIdx && state.turnStartIdx === -1) {
        state.turnStartIdx = i;
        state.turnHasThinking = hasThinking;
      }

      state.lastModelIdx = i;
      state.lastModelHasToolCalls = hasToolCalls;
      state.lastModelHasThinking = hasThinking;
    }
  }

  // 判断是否处于 incomplete 的工具循环尾部（即用户刚刚返回了工具调用结果，正等待模型下一步处理）
  if (contents.length > 0) {
    const lastMsg = contents[contents.length - 1];
    if (lastMsg?.role === "user" && isToolResultMessage(lastMsg)) {
      state.inToolLoop = true;
    }
  }

  return state;
}

/**
 * 计算尾部未完结的工具响应个数
 */
function countTrailingToolResults(contents: any[]): number {
  let count = 0;

  for (let i = contents.length - 1; i >= 0; i--) {
    const msg = contents[i];

    if (msg?.role === "user") {
      const parts = msg.parts || [];
      const functionResponses = parts.filter(isFunctionResponsePart);

      if (functionResponses.length > 0) {
        count += functionResponses.length;
      } else {
        break;
      }
    } else if (msg?.role === "model" || msg?.role === "assistant") {
      break;
    }
  }

  return count;
}

/**
 * 闭合工具执行循环并注入过渡内容，以便在不提供旧思维链的情况下顺利恢复对话
 */
export function closeToolLoopForThinking(contents: any[]): any[] {
  const strippedContents = contents;
  const toolResultCount = countTrailingToolResults(strippedContents);
  let syntheticModelContent: string;

  if (toolResultCount === 0) {
    syntheticModelContent = "[Processing prev ctx.]";
  } else if (toolResultCount === 1) {
    syntheticModelContent = "[Tool exec completed.]";
  } else {
    syntheticModelContent = `[${toolResultCount} tool executions completed.]`;
  }

  const syntheticModel = {
    role: "model",
    parts: [{ text: syntheticModelContent }],
  };

  const syntheticUser = {
    role: "user",
    parts: [{ text: "[Continue]" }],
  };

  return [...strippedContents, syntheticModel, syntheticUser];
}

/**
 * 检查当前状态是否满足触发历史自愈的条件
 */
export function needsThinkingRecovery(state: ConversationState): boolean {
  return state.inToolLoop && !state.turnHasThinking;
}

/**
 * 判断当前模型回复消息是否被裁剪过思维链（仅有工具调用而丢失了它之前的思维链描述）
 */
export function looksLikeCompactedThinkingTurn(msg: any): boolean {
  if (!msg || typeof msg !== "object") return false;

  const parts = msg.parts || [];
  if (parts.length === 0) return false;

  const hasFunctionCall = parts.some(
    (p: any) => p && typeof p === "object" && p.functionCall,
  );

  if (!hasFunctionCall) return false;

  const hasThinking = parts.some(
    (p: any) =>
      p &&
      typeof p === "object" &&
      (p.thought === true || p.type === "thinking" || p.type === "redacted_thinking"),
  );

  if (hasThinking) return false;

  const hasTextBeforeFunctionCall = parts.some((p: any, idx: number) => {
    if (!p || typeof p !== "object") return false;
    const firstFuncIdx = parts.findIndex(
      (fp: any) => fp && typeof fp === "object" && fp.functionCall,
    );
    if (idx >= firstFuncIdx) return false;
    return (
      "text" in p &&
      typeof p.text === "string" &&
      p.text.trim().length > 0 &&
      !p.thought
    );
  });

  return !hasTextBeforeFunctionCall;
}

/**
 * 深度判断本次 Turn 启动中是否包含可能被系统压缩裁剪了思维链的历史轮次
 */
export function hasPossibleCompactedThinking(
  contents: any[],
  turnStartIdx: number,
): boolean {
  if (!Array.isArray(contents) || turnStartIdx < 0) return false;

  for (let i = turnStartIdx; i < contents.length; i++) {
    const msg = contents[i];
    if (msg?.role === "model" && looksLikeCompactedThinkingTurn(msg)) {
      return true;
    }
  }

  return false;
}

// ============================================================================
// SSE 去重过滤处理器 (Streaming Transformers & Deduplicators)
// ============================================================================

/**
 * 针对流式 SSE 数据包，对重复输出的思维链文本进行计算和局部剥离
 * 同时支持 Gemini 专属的 candidates.content 结构与 Claude 专属的 content[type=thinking] 结构
 */
export function deduplicateThinkingText(
  response: unknown,
  sentBuffer: ThoughtBuffer,
  displayedThinkingHashes?: Set<string>,
): unknown {
  if (!response || typeof response !== "object") return response;

  const resp = response as Record<string, unknown>;

  // 分支 1：处理 Gemini 结构类型 (candidates)
  if (Array.isArray(resp.candidates)) {
    const newCandidates = resp.candidates.map((candidate: unknown, index: number) => {
      const cand = candidate as Record<string, unknown> | null;
      if (!cand?.content) return candidate;

      const content = cand.content as Record<string, unknown>;
      if (!Array.isArray(content.parts)) return candidate;

      const newParts = content.parts.map((part: unknown) => {
        const p = part as Record<string, unknown>;
        
        if (p.thought === true || p.type === "thinking") {
          const fullText = (p.text || p.thinking || "") as string;
          
          // 如果该思维链已经被渲染过，直接阻断其在流中的展示，避免在工具调用分支中发生长段重叠渲染
          if (displayedThinkingHashes) {
            const hash = hashString(fullText);
            if (displayedThinkingHashes.has(hash)) {
              sentBuffer.set(index, fullText);
              return null;
            }
            displayedThinkingHashes.add(hash);
          }

          // 计算增量输出 (Delta)
          const sentText = sentBuffer.get(index) ?? "";

          if (fullText.startsWith(sentText)) {
            const delta = fullText.slice(sentText.length);
            sentBuffer.set(index, fullText);

            if (delta) {
              return { ...p, text: delta, thinking: delta };
            }
            return null;
          }

          sentBuffer.set(index, fullText);
          return part;
        }
        return part;
      });

      const filteredParts = newParts.filter((p) => p !== null);

      return {
        ...cand,
        content: { ...content, parts: filteredParts },
      };
    });

    return { ...resp, candidates: newCandidates };
  }

  // 分支 2：处理 Claude 结构类型 (content 块)，因为 Agy 后端转发时包含了 Claude
  if (Array.isArray(resp.content)) {
    let thinkingIndex = 0;
    const newContent = resp.content.map((block: unknown) => {
      const b = block as Record<string, unknown> | null;
      if (b?.type === "thinking") {
        const fullText = (b.thinking || b.text || "") as string;
        
        if (displayedThinkingHashes) {
          const hash = hashString(fullText);
          if (displayedThinkingHashes.has(hash)) {
            sentBuffer.set(thinkingIndex, fullText);
            thinkingIndex++;
            return null;
          }
          displayedThinkingHashes.add(hash);
        }

        const sentText = sentBuffer.get(thinkingIndex) ?? "";

        if (fullText.startsWith(sentText)) {
          const delta = fullText.slice(sentText.length);
          sentBuffer.set(thinkingIndex, fullText);
          thinkingIndex++;

          if (delta) {
            return { ...b, thinking: delta, text: delta };
          }
          return null;
        }

        sentBuffer.set(thinkingIndex, fullText);
        thinkingIndex++;
        return block;
      }
      return block;
    });

    const filteredContent = newContent.filter((b) => b !== null);
    return { ...resp, content: filteredContent };
  }

  return response;
}

/**
 * 从返回的消息体中缓存思维链内容及其对应的验证签名，供下一轮交互做签名对齐
 * 同样支持 Gemini 签名机制 (candidates[].thoughtSignature) 与 Claude 签名机制 (content[].signature)
 */
export function cacheThinkingSignaturesFromResponse(
  response: unknown,
  signatureSessionKey: string,
  signatureStore: SignatureStore,
  thoughtBuffer: ThoughtBuffer,
  onCacheSignature?: (sessionKey: string, text: string, signature: string) => void,
): void {
  if (!response || typeof response !== "object") return;

  const resp = response as Record<string, unknown>;

  // 分支 1：收集并缓存 Gemini 类型签名
  if (Array.isArray(resp.candidates)) {
    resp.candidates.forEach((candidate: unknown, index: number) => {
      const cand = candidate as Record<string, unknown> | null;
      if (!cand?.content) return;
      const content = cand.content as Record<string, unknown>;
      if (!Array.isArray(content.parts)) return;

      content.parts.forEach((part: unknown) => {
        const p = part as Record<string, unknown>;
        if (p.thought === true || p.type === "thinking") {
          const text = (p.text || p.thinking || "") as string;
          if (text) {
            const current = thoughtBuffer.get(index) ?? "";
            thoughtBuffer.set(index, current + text);
          }
        }

        if (p.thoughtSignature) {
          const fullText = thoughtBuffer.get(index) ?? "";
          if (fullText) {
            const signature = p.thoughtSignature as string;
            onCacheSignature?.(signatureSessionKey, fullText, signature);
            signatureStore.set(signatureSessionKey, { text: fullText, signature });
          }
        }
      });
    });
  }

  // 分支 2：收集并缓存 Claude 类型签名
  if (Array.isArray(resp.content)) {
    const CLAUDE_BUFFER_KEY = 0;
    resp.content.forEach((block: unknown) => {
      const b = block as Record<string, unknown> | null;
      if (b?.type === "thinking") {
        const text = (b.thinking || b.text || "") as string;
        if (text) {
          const current = thoughtBuffer.get(CLAUDE_BUFFER_KEY) ?? "";
          thoughtBuffer.set(CLAUDE_BUFFER_KEY, current + text);
        }
      }
      if (b?.signature) {
        const fullText = thoughtBuffer.get(CLAUDE_BUFFER_KEY) ?? "";
        if (fullText) {
          const signature = b.signature as string;
          onCacheSignature?.(signatureSessionKey, fullText, signature);
          signatureStore.set(signatureSessionKey, { text: fullText, signature });
        }
      }
    });
  }
}

/**
 * 转换单行流式 SSE 返回的数据，在此触发思维链缓存与增量去重
 */
export function transformSseLine(
  line: string,
  signatureStore: SignatureStore,
  thoughtBuffer: ThoughtBuffer,
  sentThinkingBuffer: ThoughtBuffer,
  callbacks: StreamingCallbacks,
  options: StreamingOptions,
  debugState: { injected: boolean },
): string {
  if (!line.startsWith("data:")) {
    return line;
  }
  const json = line.slice(5).trim();
  if (!json) {
    return line;
  }

  try {
    const parsed = JSON.parse(json) as { response?: unknown };
    if (parsed.response !== undefined) {
      // 提取并写入缓存
      if (options.cacheSignatures && options.signatureSessionKey) {
        cacheThinkingSignaturesFromResponse(
          parsed.response,
          options.signatureSessionKey,
          signatureStore,
          thoughtBuffer,
          callbacks.onCacheSignature,
        );
      }

      // 计算去重
      let response: unknown = deduplicateThinkingText(
        parsed.response,
        sentThinkingBuffer,
        options.displayedThinkingHashes
      );

      // 调试文本注入
      if (options.debugText && callbacks.onInjectDebug && !debugState.injected) {
        response = callbacks.onInjectDebug(response, options.debugText);
        debugState.injected = true;
      }

      const transformed = callbacks.transformThinkingParts
        ? callbacks.transformThinkingParts(response)
        : response;
      return `data: ${JSON.stringify(transformed)}`;
    }
  } catch (_) {}
  return line;
}

/**
 * 创建转换流处理器 (TransformStream)，用于对输出流进行切分、去重和重组
 */
export function createStreamingTransformer(
  signatureStore: SignatureStore,
  callbacks: StreamingCallbacks,
  options: StreamingOptions = {},
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const thoughtBuffer = createThoughtBuffer();
  const sentThinkingBuffer = createThoughtBuffer();
  const debugState = { injected: false };
  let hasSeenUsageMetadata = false;

  const displayedThinkingHashes = options.displayedThinkingHashes ?? new Set<string>();
  const mergedOptions = { ...options, displayedThinkingHashes };

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.includes("usageMetadata")) {
          hasSeenUsageMetadata = true;
        }

        const transformedLine = transformSseLine(
          line,
          signatureStore,
          thoughtBuffer,
          sentThinkingBuffer,
          callbacks,
          mergedOptions,
          debugState,
        );
        controller.enqueue(encoder.encode(transformedLine + "\n"));
      }
    },
    flush(controller) {
      buffer += decoder.decode();

      if (buffer) {
        if (buffer.includes("usageMetadata")) {
          hasSeenUsageMetadata = true;
        }
        const transformedLine = transformSseLine(
          buffer,
          signatureStore,
          thoughtBuffer,
          sentThinkingBuffer,
          callbacks,
          mergedOptions,
          debugState,
        );
        controller.enqueue(encoder.encode(transformedLine));
      }

      // 兜底策略：如果最后没有生成任何 token usage 元数据，强制注入一个值为 0 计数的 fallback，确保 VS Code 统计能够兼容通过
      if (!hasSeenUsageMetadata) {
        const syntheticUsage = {
          response: {
            usageMetadata: {
              promptTokenCount: 0,
              candidatesTokenCount: 0,
              totalTokenCount: 0,
            }
          }
        };
        controller.enqueue(encoder.encode(`\ndata: ${JSON.stringify(syntheticUsage)}\n\n`));
      }
    },
  });
}
