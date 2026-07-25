import { tool } from "@opencode-ai/plugin";
import { AccountManager, detectModelFamily } from "./accounts";
import type { ModelFamily } from "./types";
import { formatRelativeResetTime } from "./quota-utils";

export const AGY_SWITCH_TOOL_NAME = "agy_switch_account";

export function createAgySwitchTool() {
  return tool({
    description:
      "List or switch the active account in the Antigravity multi-account pool.",
    args: {},
    async execute(args?: { accountIndex?: number; family?: string }) {
      const accountMgr = await AccountManager.getInstance();
      const accounts = accountMgr.getAccounts();

      if (accounts.length === 0) {
        return "No accounts currently in the Antigravity pool. Run `opencode auth login` and choose `Google OAuth (Antigravity CLI)` to add your first account.";
      }

      const targetIdx = args?.accountIndex;
      if (typeof targetIdx === "number" && targetIdx > 0) {
        const zeroIdx = targetIdx - 1;
        if (zeroIdx >= accounts.length) {
          return `Invalid account number #${targetIdx}. Total accounts in pool: ${accounts.length}.`;
        }

        const familyInput = args?.family?.toLowerCase();
        let targetFamilies: ModelFamily[] = ["claude", "gemini"];
        if (familyInput === "claude") {
          targetFamilies = ["claude"];
        } else if (familyInput === "gemini") {
          targetFamilies = ["gemini"];
        }

        for (const fam of targetFamilies) {
          accountMgr.setActiveAccount(fam, zeroIdx);
        }

        const selected = accounts[zeroIdx];
        const label = selected?.email ? `${selected.email}` : `Account #${targetIdx}`;
        return `Successfully switched active account for [${targetFamilies.join(", ")}] to ${label} (#${targetIdx}).`;
      }

      // Default: List account pool status
      const currentClaude = accountMgr.getCurrentAccountForFamily("claude");
      const currentGemini = accountMgr.getCurrentAccountForFamily("gemini");

      const lines: string[] = [
        `=== Antigravity Multi-Account Pool (${accounts.length} account${accounts.length > 1 ? "s" : ""}) ===`,
        ""
      ];

      accounts.forEach((acc, idx) => {
        const num = idx + 1;
        const emailLabel = acc.email ? acc.email : `Account #${num}`;
        const isClaudeActive = currentClaude?.index === idx;
        const isGeminiActive = currentGemini?.index === idx;

        const claudeLimit = acc.rateLimitResetTimes.claude;
        const geminiLimit = acc.rateLimitResetTimes.gemini;

        const now = Date.now();
        let claudeStatus = isClaudeActive ? "ACTIVE" : "READY";
        if (claudeLimit && claudeLimit > now) {
          claudeStatus = `COOLDOWN (${formatRelativeResetTime(new Date(claudeLimit).toISOString())})`;
        }

        let geminiStatus = isGeminiActive ? "ACTIVE" : "READY";
        if (geminiLimit && geminiLimit > now) {
          geminiStatus = `COOLDOWN (${formatRelativeResetTime(new Date(geminiLimit).toISOString())})`;
        }

        const activeTag = [];
        if (isClaudeActive) activeTag.push("Claude");
        if (isGeminiActive) activeTag.push("Gemini");
        const activeStr = activeTag.length > 0 ? ` [ACTIVE for ${activeTag.join(" & ")}]` : "";

        lines.push(`[${num}] ${emailLabel}${activeStr}`);
        lines.push(`    • Status: Claude: ${claudeStatus} | Gemini: ${geminiStatus}`);
        lines.push(`    • Enabled: ${acc.enabled ? "Yes" : "No"}`);
      });

      lines.push("");
      lines.push("Usage to switch account: `/agyswitch <accountNumber>` (e.g. `/agyswitch 2`)");

      return lines.join("\n");
    }
  });
}
