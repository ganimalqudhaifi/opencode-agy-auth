import {
  AGY_CLIENT_ID,
  AGY_CLIENT_SECRET,
  AGY_PROVIDER_ID
} from '../constants';
import { agyFetch } from '../fetch';
import { formatRefreshParts, parseRefreshParts } from './auth';
import { clearCachedAuth, storeCachedAuth } from './cache';
import { invalidateProjectContextCache } from './project';
import {
  DEFAULT_MAX_ATTEMPTS,
  getExponentialDelayWithJitter,
  isRetryableNetworkError,
  isRetryableStatus,
  resolveRetryDelayMs,
  wait
} from '../sdk/retry/helpers';
import type { OAuthAuthDetails, PluginClient, RefreshParts } from './types';

interface OAuthErrorPayload {
  error?:
    | string
    | {
        code?: string;
        status?: string;
        message?: string;
      };
  error_description?: string;
}

/**
 * NOTE: 特别设计——并发刷新锁机制
 * 当 IDE 启动、或者有多个请求同时并发调用 Agy 服务，且检测到当前的 Access Token 已过期时，
 * 会同时触发 Token 刷新流程。如果每个并发请求都独立向 Google 接口发起 refresh_token 刷新，会造成：
 * 1. 网络请求冗余；
 * 2. 产生“竞争条件”（后发起的刷新使先发起的刷新失效，导致其他并发请求报错）。
 * 
 * 此处使用 `refreshInFlight` 映射存储正在进行的刷新 Promise。对于相同的 refresh token，
 * 只发起一次真实的刷新网络请求，其余并发请求通过 Promise 合并挂起等待，直至刷新成功后统一分发，
 * 避免了竞态冲突，大幅提升了插件高并发下的健壮性。
 */
const refreshInFlight = new Map<string, Promise<OAuthAuthDetails | undefined>>();

function parseOAuthErrorPayload(text: string | undefined): { code?: string; description?: string } {
  if (!text) {
    return {};
  }

  try {
    const payload = JSON.parse(text) as OAuthErrorPayload;
    if (!payload || typeof payload !== 'object') {
      return { description: text };
    }

    let code: string | undefined;
    if (typeof payload.error === 'string') {
      code = payload.error;
    } else if (payload.error && typeof payload.error === 'object') {
      code = payload.error.status ?? payload.error.code;
      if (!payload.error_description && payload.error.message) {
        return { code, description: payload.error.message };
      }
    }

    const description = payload.error_description;
    if (description) {
      return { code, description };
    }

    if (payload.error && typeof payload.error === 'object' && payload.error.message) {
      return { code, description: payload.error.message };
    }

    return { code };
  } catch {
    return { description: text };
  }
}

export async function refreshAccessToken(
  auth: OAuthAuthDetails,
  client: PluginClient
): Promise<OAuthAuthDetails | undefined> {
  const parts = parseRefreshParts(auth.refresh);
  if (!parts.refreshToken) {
    return undefined;
  }

  const pending = refreshInFlight.get(parts.refreshToken);
  if (pending) {
    return pending;
  }

  const refreshPromise = refreshAccessTokenInternal(auth, client, parts);
  refreshInFlight.set(parts.refreshToken, refreshPromise);

  try {
    return await refreshPromise;
  } finally {
    refreshInFlight.delete(parts.refreshToken);
  }
}

async function refreshAccessTokenInternal(
  auth: OAuthAuthDetails,
  client: PluginClient,
  parts: RefreshParts
): Promise<OAuthAuthDetails | undefined> {
  try {
    const response = await fetchTokenRefresh(parts.refreshToken);

    if (!response.ok) {
      let errorText: string | undefined;
      try {
        errorText = await response.text();
      } catch {
        errorText = undefined;
      }

      const { code, description } = parseOAuthErrorPayload(errorText);
      const details = [code, description ?? errorText].filter(Boolean).join(': ');
      const baseMessage = `Antigravity token refresh failed (${response.status} ${response.statusText})`;
      console.warn(`[OAuth] ${details ? `${baseMessage} - ${details}` : baseMessage}`);

      if (code === 'invalid_grant') {
        console.warn(
          `[OAuth] Google revoked the stored refresh token. Run \`opencode auth login\` and reauthenticate.`
        );
        clearCachedAuth(auth.refresh);
        invalidateProjectContextCache(auth.refresh);
        try {
          const clearedAuth = {
            type: 'oauth' as const,
            refresh: formatRefreshParts({
              refreshToken: '',
              projectId: parts.projectId,
              managedProjectId: parts.managedProjectId
            }),
            access: '',
            expires: 0
          } as OAuthAuthDetails;
          await client.auth.set({
            path: { id: AGY_PROVIDER_ID },
            body: clearedAuth
          });
        } catch (storeError) {
          const errStr = storeError instanceof Error ? storeError.stack || storeError.message : String(storeError);
          console.warn(`[Agy Auth] Failed to clear stored Antigravity OAuth credentials: ${errStr}`);
        }
      }

      return undefined;
    }

    const payload = (await response.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };

    const refreshedParts: RefreshParts = {
      refreshToken: payload.refresh_token ?? parts.refreshToken,
      projectId: parts.projectId,
      managedProjectId: parts.managedProjectId
    };

    const updatedAuth: OAuthAuthDetails = {
      ...auth,
      access: payload.access_token,
      expires: Date.now() + payload.expires_in * 1000,
      refresh: formatRefreshParts(refreshedParts)
    };

    clearCachedAuth(auth.refresh);
    storeCachedAuth(updatedAuth);
    invalidateProjectContextCache(auth.refresh);

    if (refreshedParts.refreshToken !== parts.refreshToken) {
      try {
        await client.auth.set({
          path: { id: AGY_PROVIDER_ID },
          body: updatedAuth
        });
      } catch (storeError) {
        const errStr = storeError instanceof Error ? storeError.stack || storeError.message : String(storeError);
        console.warn(`[Agy Auth] Failed to persist refreshed Antigravity OAuth credentials: ${errStr}`);
      }
    }

    return updatedAuth;
  } catch (error) {
    const errStr = error instanceof Error ? error.stack || error.message : String(error);
    console.warn(`[Agy Auth] Failed to refresh Antigravity access token due to an unexpected error: ${errStr}`);
    return undefined;
  }
}

async function fetchTokenRefresh(refreshToken: string): Promise<Response> {
  const tokenUrl = 'https://oauth2.googleapis.com/token';
  const clientId = AGY_CLIENT_ID;
  const clientSecret = AGY_CLIENT_SECRET;

  const init: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret
    })
  };

  let attempt = 1;
  while (attempt <= DEFAULT_MAX_ATTEMPTS) {
    try {
      const response = await agyFetch(tokenUrl, init);
      if (!isRetryableStatus(response.status) || attempt >= DEFAULT_MAX_ATTEMPTS) {
        return response;
      }

      const delayMs = await resolveRetryDelayMs(response, attempt);
      if (delayMs > 0) {
        await wait(delayMs);
      }
      attempt += 1;
      continue;
    } catch (error) {
      if (attempt >= DEFAULT_MAX_ATTEMPTS || !isRetryableNetworkError(error)) {
        throw error;
      }
      await wait(getExponentialDelayWithJitter(attempt));
      attempt += 1;
    }
  }

  return agyFetch(tokenUrl, init);
}
