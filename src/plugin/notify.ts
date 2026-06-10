import { classifyQuotaResponse } from "../sdk/retry/quota";
import type { PluginClient } from "./types";

const MODEL_CAPACITY_TOAST_COOLDOWN_MS = 30_000;
const modelCapacityToastCooldownByKey = new Map<string, number>();
const TEST_TOAST_FLAG = "OPENCODE_AGY_TEST_TOAST";
const testToastShownByProject = new Set<string>();

/**
 * 当服务器端 Agy 模型容量耗尽时，向用户弹出 Toast 提示。
 */
export async function maybeShowAgyCapacityToast(
  client: PluginClient,
  response: Response,
  projectId: string,
  requestedModel?: string,
): Promise<void> {
  if (response.status !== 429 || !client.tui?.showToast) {
    return;
  }

  const quotaContext = await classifyQuotaResponse(response);
  if (quotaContext?.reason !== "MODEL_CAPACITY_EXHAUSTED") {
    return;
  }

  const model = requestedModel ?? "the selected model";
  const toastKey = `${projectId}|${model}|MODEL_CAPACITY_EXHAUSTED`;
  const now = Date.now();
  const cooldownUntil = modelCapacityToastCooldownByKey.get(toastKey) ?? 0;
  if (cooldownUntil > now) {
    return;
  }
  modelCapacityToastCooldownByKey.set(toastKey, now + MODEL_CAPACITY_TOAST_COOLDOWN_MS);

  await client.tui.showToast({
    body: {
      title: "Agy Capacity Unavailable",
      message: `Google reports temporary server capacity limits for ${model}. Please retry in a few seconds.`,
      variant: "warning",
      duration: 7000,
    },
  });
}

/**
 * 临时的冒烟测试 Toast，仅当 OPENCODE_AGY_TEST_TOAST=1 时启用。
 */
export async function maybeShowAgyTestToast(
  client: PluginClient,
  projectId: string,
): Promise<void> {
  if (process.env[TEST_TOAST_FLAG]?.trim() !== "1" || !client.tui?.showToast) {
    return;
  }

  const key = projectId || "global";
  if (testToastShownByProject.has(key)) {
    return;
  }
  testToastShownByProject.add(key);

  await client.tui.showToast({
    body: {
      title: "Agy Toast Test",
      message: "Temporary test toast from opencode-agy-auth.",
      variant: "info",
      duration: 5000,
    },
  });
}
