/**
 * Agy/Gemini CLI 会通过其网络记录器在每个请求中附加一个简短的活动 ID。
 * 我们镜像相同的形式，以便后端/调试追踪看起来像 CLI 流量。
 */
export function createAgyActivityRequestId(): string {
  return Math.random().toString(36).substring(7);
}
