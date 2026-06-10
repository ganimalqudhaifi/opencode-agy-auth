/**
 * NOTE: 这里的 request 模块承载了标准 OpenAI 协议与 Agy 原生 Gemini 协议的序列化、反序列化以及流式数据转化。
 * 虽然通常属于应用/适配器层职责，但由于它和 Agy 专属的 SSE 流去重、多轮对话签名缓存具有极高耦合，
 * 为了确保对外接口的简单干净，我们将其打包作为 SDK 的内建能力，为上层屏蔽所有协议转换的内部复杂性。
 */

export { prepareAgyRequest } from "./prepare";
export type { ThinkingConfigDefaults } from "./prepare";
export { transformAgyResponse } from "./response";
export { isGenerativeLanguageRequest, parseGenerativeLanguageRequest } from "./shared";
