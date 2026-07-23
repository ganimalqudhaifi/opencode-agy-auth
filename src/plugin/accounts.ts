import { formatRefreshParts, parseRefreshParts } from "./auth";
import { loadAccountStorage, saveAccountStorage } from "./storage";
import type { AccountStorageSchema, ManagedAccount, ModelFamily, OAuthAuthDetails } from "./types";

function nowMs(): number {
  return Date.now();
}

function clearExpiredRateLimits(account: ManagedAccount): void {
  const now = nowMs();
  if (account.rateLimitResetTimes.claude && now >= account.rateLimitResetTimes.claude) {
    delete account.rateLimitResetTimes.claude;
  }
  if (account.rateLimitResetTimes.gemini && now >= account.rateLimitResetTimes.gemini) {
    delete account.rateLimitResetTimes.gemini;
  }
}

export function detectModelFamily(modelId?: string): ModelFamily {
  if (!modelId) {
    return "gemini";
  }
  const lower = modelId.toLowerCase();
  if (lower.includes("claude")) {
    return "claude";
  }
  return "gemini";
}

export class AccountManager {
  private accounts: ManagedAccount[] = [];
  private activeIndexByFamily: Record<ModelFamily, number> = {
    claude: 0,
    gemini: 0
  };

  private static instance: AccountManager | null = null;

  public static async getInstance(authFallback?: OAuthAuthDetails): Promise<AccountManager> {
    if (!AccountManager.instance) {
      AccountManager.instance = new AccountManager(authFallback);
    } else if (authFallback) {
      AccountManager.instance.importFallbackAuth(authFallback);
    }
    return AccountManager.instance;
  }

  constructor(authFallback?: OAuthAuthDetails) {
    const stored = loadAccountStorage();
    if (stored && Array.isArray(stored.accounts) && stored.accounts.length > 0) {
      const baseNow = nowMs();
      this.accounts = stored.accounts.map((acc, index): ManagedAccount => {
        const parts = parseRefreshParts(acc.refreshToken);
        return {
          index,
          email: acc.email,
          addedAt: acc.addedAt || baseNow,
          lastUsed: acc.lastUsed || 0,
          parts: {
            refreshToken: parts.refreshToken,
            projectId: acc.projectId || parts.projectId,
            managedProjectId: acc.managedProjectId || parts.managedProjectId
          },
          enabled: acc.enabled !== false,
          rateLimitResetTimes: acc.rateLimitResetTimes ? { ...acc.rateLimitResetTimes } : {}
        };
      });

      this.activeIndexByFamily = {
        claude: stored.activeIndexByFamily?.claude ?? 0,
        gemini: stored.activeIndexByFamily?.gemini ?? 0
      };

      this.clampIndices();
    }

    if (authFallback) {
      this.importFallbackAuth(authFallback);
    }
  }

  public importFallbackAuth(auth: OAuthAuthDetails): ManagedAccount | null {
    return this.addOrUpdateAccount(auth);
  }

  public addOrUpdateAccount(auth: OAuthAuthDetails, email?: string): ManagedAccount | null {
    const parts = parseRefreshParts(auth.refresh);
    if (!parts.refreshToken) {
      return null;
    }

    const existingIdx = this.accounts.findIndex(
      (a) => a.parts.refreshToken === parts.refreshToken
    );

    const now = nowMs();
    if (existingIdx >= 0) {
      const existing = this.accounts[existingIdx]!;
      existing.parts = {
        refreshToken: parts.refreshToken,
        projectId: parts.projectId || existing.parts.projectId,
        managedProjectId: parts.managedProjectId || existing.parts.managedProjectId
      };
      if (auth.access) {
        existing.access = auth.access;
        existing.expires = auth.expires;
      }
      if (email) {
        existing.email = email;
      }
      existing.enabled = true;
      this.saveToDisk();
      return existing;
    }

    const newAccount: ManagedAccount = {
      index: this.accounts.length,
      email,
      addedAt: now,
      lastUsed: 0,
      parts,
      access: auth.access,
      expires: auth.expires,
      enabled: true,
      rateLimitResetTimes: {}
    };

    this.accounts.push(newAccount);
    this.saveToDisk();
    return newAccount;
  }

  public getAccounts(): ManagedAccount[] {
    return [...this.accounts];
  }

  public getEnabledAccounts(): ManagedAccount[] {
    return this.accounts.filter((a) => a.enabled);
  }

  public getCurrentAccountForFamily(family: ModelFamily): ManagedAccount | null {
    if (this.accounts.length === 0) {
      return null;
    }

    const activeIdx = this.activeIndexByFamily[family];
    const candidate = this.accounts[activeIdx];

    if (candidate && candidate.enabled) {
      clearExpiredRateLimits(candidate);
      if (!this.isRateLimited(candidate, family)) {
        return candidate;
      }
    }

    return this.getNextAvailableAccount(family);
  }

  public getNextAvailableAccount(family: ModelFamily): ManagedAccount | null {
    const enabledAccounts = this.accounts.filter((a) => a.enabled);
    if (enabledAccounts.length === 0) {
      return null;
    }

    for (const acc of enabledAccounts) {
      clearExpiredRateLimits(acc);
      if (!this.isRateLimited(acc, family)) {
        this.activeIndexByFamily[family] = acc.index;
        this.saveToDisk();
        return acc;
      }
    }

    return null;
  }

  public isRateLimited(account: ManagedAccount, family: ModelFamily): boolean {
    clearExpiredRateLimits(account);
    const resetTime = account.rateLimitResetTimes[family];
    return resetTime !== undefined && nowMs() < resetTime;
  }

  public markRateLimited(
    accountIndex: number,
    family: ModelFamily,
    cooldownMs: number
  ): ManagedAccount | null {
    const account = this.accounts[accountIndex];
    if (!account) {
      return null;
    }

    account.rateLimitResetTimes[family] = nowMs() + cooldownMs;
    console.warn(
      `[Agy Auth] Account #${account.index + 1} (${account.email || "Primary"}) rate-limited for ${family}. Cooldown: ${Math.round(cooldownMs / 1000)}s`
    );

    const next = this.getNextAvailableAccount(family);
    if (next) {
      console.warn(
        `[Agy Auth] Automatically switched ${family} model requests to Account #${next.index + 1} (${next.email || "Account " + (next.index + 1)})`
      );
    } else {
      console.warn(`[Agy Auth] All accounts in pool are currently rate-limited for ${family}.`);
    }

    this.saveToDisk();
    return next;
  }

  public setActiveAccount(family: ModelFamily, accountIndex: number): boolean {
    if (accountIndex < 0 || accountIndex >= this.accounts.length) {
      return false;
    }

    const acc = this.accounts[accountIndex];
    if (!acc || !acc.enabled) {
      return false;
    }

    this.activeIndexByFamily[family] = accountIndex;
    acc.lastUsed = nowMs();
    this.saveToDisk();
    return true;
  }

  public markAccountUsed(accountIndex: number): void {
    const acc = this.accounts[accountIndex];
    if (acc) {
      acc.lastUsed = nowMs();
    }
  }

  public updateAccountAuth(accountIndex: number, updatedAuth: OAuthAuthDetails): void {
    const acc = this.accounts[accountIndex];
    if (!acc) return;

    const parts = parseRefreshParts(updatedAuth.refresh);
    acc.parts = {
      refreshToken: parts.refreshToken || acc.parts.refreshToken,
      projectId: parts.projectId || acc.parts.projectId,
      managedProjectId: parts.managedProjectId || acc.parts.managedProjectId
    };
    acc.access = updatedAuth.access;
    acc.expires = updatedAuth.expires;
    this.saveToDisk();
  }

  public disableAccount(accountIndex: number): boolean {
    const acc = this.accounts[accountIndex];
    if (!acc) return false;
    acc.enabled = false;
    this.saveToDisk();
    return true;
  }

  public toAuthDetails(account: ManagedAccount): OAuthAuthDetails {
    return {
      type: "oauth",
      refresh: formatRefreshParts(account.parts),
      access: account.access ?? "",
      expires: account.expires ?? 0
    };
  }

  private clampIndices(): void {
    const total = this.accounts.length;
    if (total === 0) {
      this.activeIndexByFamily = { claude: 0, gemini: 0 };
      return;
    }
    if (this.activeIndexByFamily.claude < 0 || this.activeIndexByFamily.claude >= total) {
      this.activeIndexByFamily.claude = 0;
    }
    if (this.activeIndexByFamily.gemini < 0 || this.activeIndexByFamily.gemini >= total) {
      this.activeIndexByFamily.gemini = 0;
    }
  }

  public saveToDisk(): boolean {
    this.clampIndices();
    const schema: AccountStorageSchema = {
      version: 1,
      accounts: this.accounts.map((a) => ({
        email: a.email,
        refreshToken: a.parts.refreshToken,
        projectId: a.parts.projectId,
        managedProjectId: a.parts.managedProjectId,
        addedAt: a.addedAt,
        lastUsed: a.lastUsed,
        enabled: a.enabled,
        rateLimitResetTimes: Object.keys(a.rateLimitResetTimes).length > 0 ? a.rateLimitResetTimes : undefined
      })),
      activeIndexByFamily: this.activeIndexByFamily
    };

    return saveAccountStorage(schema);
  }
}
