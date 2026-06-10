/**
 * NOTE: 格式/协议转换逻辑虽然通常属于应用层（Plugin），但此处作为特例放在 SDK 内部实现。
 * 原因：
 * 格式转换（OpenAI 格式与 Gemini/Agy 原生格式互转）与 Agy 特有的流式 SSE 数据解析、
 * 思维链去重（Deduplication）及多轮对话的签名自愈（Thinking Recovery / Signature Cache）存在极强的耦合性。
 * 通过在 SDK 内封装此转换过程，可以对 OpenCode 插件应用层完全屏蔽非标 API 交互的复杂细节，
 * 使插件只需简单调用并转发标准 OpenAI 格式的请求和响应流。
 */

interface GeminiFunctionCallPart {
  functionCall?: {
    id?: string;
    name: string;
    args?: Record<string, unknown>;
    [key: string]: unknown;
  };
  thoughtSignature?: string;
  [key: string]: unknown;
}

interface OpenAIToolCall {
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface OpenAIMessage {
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
  [key: string]: unknown;
}

/**
 * 将 OpenAI 的 `tool_calls` 转换为 Gemini 的 `functionCall` 部分。
 */
export function transformOpenAIToolCalls(requestPayload: Record<string, unknown>): void {
  const messages = requestPayload.messages;
  if (!messages || !Array.isArray(messages)) {
    return;
  }

  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }

    const msgObj = message as OpenAIMessage;
    const toolCalls = msgObj.tool_calls;
    if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) {
      continue;
    }

    const parts: GeminiFunctionCallPart[] = [];
    if (typeof msgObj.content === "string" && msgObj.content.length > 0) {
      parts.push({ text: msgObj.content });
    }

    for (const toolCall of toolCalls) {
      if (!toolCall || typeof toolCall !== "object") {
        continue;
      }

      const fn = toolCall.function;
      if (!fn || typeof fn !== "object") {
        continue;
      }

      const name = fn.name;
      const args = parseJsonObject(fn.arguments);
      
      const functionCallPart: NonNullable<GeminiFunctionCallPart['functionCall']> = {
        name: name ?? "",
        args,
      };

      if (typeof toolCall.id === 'string' && toolCall.id.length > 0) {
        functionCallPart.id = toolCall.id;
      }

      parts.push({
        functionCall: functionCallPart,
        thoughtSignature: "skip_thought_signature_validator",
      });
    }

    msgObj.parts = parts;
    delete msgObj.tool_calls;
    delete msgObj.content;
  }
}

/**
 * 向扁平化和包装后的负载中的函数调用（function calls）添加合成的 thoughtSignature 签名。
 */
export function addThoughtSignaturesToFunctionCalls(requestPayload: Record<string, unknown>): void {
  const processContents = (contents: unknown): void => {
    if (!contents || !Array.isArray(contents)) {
      return;
    }

    for (const content of contents) {
      if (!content || typeof content !== "object") {
        continue;
      }

      const parts = (content as Record<string, unknown>).parts;
      if (!parts || !Array.isArray(parts)) {
        continue;
      }

      for (const part of parts) {
        if (!part || typeof part !== "object") {
          continue;
        }
        const partObj = part as Record<string, unknown>;
        if (partObj.functionCall && !partObj.thoughtSignature) {
          partObj.thoughtSignature = "skip_thought_signature_validator";
        }
      }
    }
  };

  processContents(requestPayload.contents);
  if (requestPayload.request && typeof requestPayload.request === "object") {
    processContents((requestPayload.request as Record<string, unknown>).contents);
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}
