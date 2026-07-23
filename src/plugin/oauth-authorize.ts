import { spawn } from 'node:child_process';

import { authorizeAgy, exchangeAgyWithVerifier } from '../sdk/oauth';
import type { AgyTokenExchangeResult } from '../sdk/oauth';
import { resolveProjectContextFromAccessToken } from './project';
import { resolveConfiguredProjectId } from './provider';
import { formatRefreshParts } from './auth';
import type { OAuthAuthDetails, PluginClient } from './types';
import { AccountManager } from './accounts';
import { isTTY, showAccountDetails, showAuthMenu, type AccountInfo } from './ui/auth-menu';


/**
 * Builds the OAuth authorization callback for the plugin authentication method.
 */
export function createOAuthAuthorizeMethod(options?: {
  client?: PluginClient;
  getConfiguredProjectId?: () => Promise<string | undefined> | string | undefined;
  getUserAgentModel?: () => Promise<string | undefined> | string | undefined;
}): () => Promise<{
  url: string;
  instructions: string;
  method: 'code';
  callback: (callbackUrl: string) => Promise<AgyTokenExchangeResult>;
}> {
  return async () => {
    // If TTY terminal is active and pool has existing accounts, display interactive menu first
    if (isTTY()) {
      try {
        const accountMgr = await AccountManager.getInstance();
        const poolAccounts = accountMgr.getAccounts();

        if (poolAccounts.length > 0) {
          const now = Date.now();
          const accountInfos: AccountInfo[] = poolAccounts.map((acc) => {
            const isLimited = Object.values(acc.rateLimitResetTimes).some(
              (resetTime) => typeof resetTime === 'number' && resetTime > now
            );
            return {
              email: acc.email,
              index: acc.index,
              addedAt: acc.addedAt,
              lastUsed: acc.lastUsed,
              status: !acc.enabled ? 'disabled' : isLimited ? 'rate-limited' : 'active',
              enabled: acc.enabled !== false,
              isCurrentAccount: acc.index === 0
            };
          });

          let menuDone = false;
          while (!menuDone) {
            const action = await showAuthMenu(accountInfos);

            if (action.type === 'cancel') {
              menuDone = true;
            } else if (action.type === 'add') {
              menuDone = true; // Proceed to browser OAuth flow below
            } else if (action.type === 'delete-all') {
              for (const acc of [...accountMgr.getAccounts()]) {
                accountMgr.disableAccount(acc.index);
              }
              accountMgr.saveToDisk();
              console.log('\n✅ All accounts cleared from pool.\n');
              menuDone = true;
            } else if (action.type === 'check') {
              process.stdout.write('\x1b[2J\x1b[1;1H');
              console.log('📊 Account Pool Summary:');
              console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
              for (const acc of accountMgr.getAccounts()) {
                const label = acc.email || `Account #${acc.index + 1}`;
                const disabledStr = acc.enabled ? ' \x1b[32m(Active)\x1b[0m' : ' \x1b[31m(Disabled)\x1b[0m';
                console.log(` • ${label}${disabledStr}`);

                const claudeReset = acc.rateLimitResetTimes.claude;
                const geminiReset = acc.rateLimitResetTimes.gemini;
                const now = Date.now();

                const claudeStatus = claudeReset && claudeReset > now
                  ? `\x1b[33mRate-Limited (resets in ${Math.ceil((claudeReset - now) / 60000)}m)\x1b[0m`
                  : '\x1b[32mReady\x1b[0m';

                const geminiStatus = geminiReset && geminiReset > now
                  ? `\x1b[33mRate-Limited (resets in ${Math.ceil((geminiReset - now) / 60000)}m)\x1b[0m`
                  : '\x1b[32mReady\x1b[0m';

                console.log(`   ├─ Claude status: ${claudeStatus}`);
                console.log(`   └─ Gemini status: ${geminiStatus}`);
              }
              console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
              console.log('\nPress Enter to return to menu...');
              await new Promise<void>((resolve) => {
                const stdin = process.stdin;
                const wasRaw = stdin.isRaw ?? false;
                const onData = () => {
                  try {
                    stdin.removeListener('data', onData);
                    stdin.setRawMode(wasRaw);
                    stdin.pause();
                  } catch {}
                  resolve();
                };
                try {
                  stdin.setRawMode(true);
                  stdin.resume();
                  stdin.once('data', onData);
                } catch {
                  resolve();
                }
              });
            } else if (action.type === 'select-account') {
              const detailsAction = await showAccountDetails(action.account);
              if (detailsAction === 'delete') {
                accountMgr.disableAccount(action.account.index);
                console.log(`\n✅ Account #${action.account.index + 1} disabled/removed.\n`);
              } else if (detailsAction === 'toggle') {
                const newStatus = !action.account.enabled;
                if (newStatus) {
                  const acc = accountMgr.getAccounts()[action.account.index];
                  if (acc) acc.enabled = true;
                  accountMgr.saveToDisk();
                } else {
                  accountMgr.disableAccount(action.account.index);
                }
              } else if (detailsAction === 'refresh') {
                menuDone = true; // Re-authenticate via browser OAuth
              }
            }
          }
        }
      } catch (uiErr) {
        console.warn(`[Agy Auth] TUI menu skipped: ${uiErr instanceof Error ? uiErr.message : String(uiErr)}`);
      }
    }

    const maybeHydrateProjectId = async (
      result: AgyTokenExchangeResult
    ): Promise<AgyTokenExchangeResult> => {
      if (result.type !== 'success' || !result.access) {
        return result;
      }

      const configuredProjectId = resolveConfiguredProjectId({
        configProjectId: await options?.getConfiguredProjectId?.()
      });

      let finalResult: AgyTokenExchangeResult = result;

      try {
        const initialRefresh = formatRefreshParts({
          refreshToken: result.refresh
        });

        const authSnapshot = {
          type: 'oauth',
          refresh: initialRefresh,
          access: result.access,
          expires: result.expires
        } satisfies OAuthAuthDetails;

        const projectContext = await resolveProjectContextFromAccessToken(
          authSnapshot,
          result.access,
          configuredProjectId,
          undefined,
          await options?.getUserAgentModel?.()
        );

        finalResult = projectContext.auth.refresh !== initialRefresh
          ? { ...result, refresh: projectContext.auth.refresh }
          : { ...result, refresh: initialRefresh };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[OAuth] Project resolution skipped: ${message}`);
        if (options?.client?.tui?.showToast) {
          const message = error instanceof Error ? error.message : String(error);
          options.client.tui.showToast({
            body: {
              title: "Failed to bind project context",
              message: `Authorized successfully but failed to bind project, real models will be unavailable: ${message}`,
              variant: "warning",
              duration: 15000
            }
          }).catch(() => {});
        }
        const initialRefresh = formatRefreshParts({
          refreshToken: result.refresh
        });
        finalResult = { ...result, refresh: initialRefresh };
      }

      // Store/append account to multi-account pool
      if (finalResult.type === 'success' && finalResult.access) {
        try {
          const accountMgr = await AccountManager.getInstance();
          const savedAccount = accountMgr.addOrUpdateAccount(
            {
              type: 'oauth',
              refresh: finalResult.refresh,
              access: finalResult.access,
              expires: finalResult.expires
            },
            finalResult.email
          );

          const poolSize = accountMgr.getAccounts().length;
          const accountLabel = savedAccount?.email || `Account #${(savedAccount?.index ?? 0) + 1}`;
          console.warn(
            `[Agy Auth] Account ${accountLabel} successfully saved to pool. Total accounts in pool: ${poolSize}`
          );

          if (options?.client?.tui?.showToast) {
            options.client.tui.showToast({
              body: {
                title: "Account Added to Pool",
                message: `${accountLabel} added successfully! Pool size: ${poolSize} account(s).`,
                variant: "info",
                duration: 5000
              }
            }).catch(() => {});
          }
        } catch (poolErr) {
          console.warn(`[Agy Auth] Failed to save account to pool: ${poolErr instanceof Error ? poolErr.message : String(poolErr)}`);
        }
      }

      return finalResult;
    };

    const isHeadless = !!(
      process.env.SSH_CONNECTION ||
      process.env.SSH_CLIENT ||
      process.env.SSH_TTY ||
      process.env.OPENCODE_HEADLESS
    );

    const authorization = await authorizeAgy();
    if (!isHeadless) {
      openBrowserUrl(authorization.url);
    }

    return {
      url: authorization.url,
      instructions: isHeadless
        ? 'Headless/SSH environment detected. Browser auto-open skipped. Please manually open the following URL in a browser on your local machine to authorize:\n\n' + authorization.url + '\n\nAfter authorization, the page will redirect to https://antigravity.google/oauth-callback?code=... . Copy the full redirect URL from your browser address bar, or just the code parameter value, and paste it into the input box below.\n\nNote: If you are not in a headless environment, unset OPENCODE_HEADLESS or run without SSH to enable browser auto-open.'
        : 'Please complete Google account authorization in your browser. After authorization, the page will redirect to https://antigravity.google/oauth-callback?code=... . Please copy the full redirect URL from your browser address bar, or just the code parameter value, and paste it into the input box below:',
      method: 'code',
      callback: async (callbackUrl: string): Promise<AgyTokenExchangeResult> => {
        try {
          const { code, state } = parseOAuthCallbackInput(callbackUrl);
          if (!code) {
            return { type: 'failed', error: 'Missing authorization code in callback input' };
          }
          if (state && state !== authorization.state) {
            return { type: 'failed', error: 'State mismatch in callback input (possible CSRF attempt)' };
          }
          const exchangeResult = await exchangeAgyWithVerifier(code, authorization.verifier);
          return await maybeHydrateProjectId(exchangeResult);
        } catch (error) {
          return {
            type: 'failed',
            error: error instanceof Error ? error.message : 'Unknown error'
          };
        }
      }
    };
  };
}

function parseOAuthCallbackInput(input: string): { code?: string; state?: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return {};
  }

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return {
        code: url.searchParams.get('code') || undefined,
        state: url.searchParams.get('state') || undefined
      };
    } catch {
      return {};
    }
  }

  const candidate = trimmed.startsWith('?') ? trimmed.slice(1) : trimmed;
  if (candidate.includes('=')) {
    const params = new URLSearchParams(candidate);
    const code = params.get('code') || undefined;
    const state = params.get('state') || undefined;
    if (code || state) {
      return { code, state };
    }
  }

  return { code: trimmed };
}

function openBrowserUrl(url: string): void {
  try {
    const platform = process.platform;
    const command =
      platform === 'darwin' ? 'open' : platform === 'win32' ? 'rundll32' : 'xdg-open';
    const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
    const child = spawn(command, args, {
      stdio: 'ignore',
      detached: true
    });
    child.unref?.();
  } catch {}
}
