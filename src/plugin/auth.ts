import type { AuthDetails, OAuthAuthDetails, RefreshParts } from './types';

const ACCESS_TOKEN_EXPIRY_BUFFER_MS = 60 * 1000;

export function isOAuthAuth(auth: AuthDetails): auth is OAuthAuthDetails {
  return auth.type === 'oauth';
}

/**
 * 将打包后的 refresh 字符串拆分为对应的 refresh token 和项目 ID。
 */
export function parseRefreshParts(refresh: string): RefreshParts {
  const [refreshToken = '', projectId = '', managedProjectId = ''] = (refresh ?? '').split('|');
  return {
    refreshToken,
    projectId: projectId || undefined,
    managedProjectId: managedProjectId || undefined
  };
}

/**
 * 将 refresh token 的各个部分序列化为存储的字符串格式。
 */
export function formatRefreshParts(parts: RefreshParts): string {
  if (!parts.refreshToken) {
    return '';
  }

  if (!parts.projectId && !parts.managedProjectId) {
    return parts.refreshToken;
  }

  const projectSegment = parts.projectId ?? '';
  const managedSegment = parts.managedProjectId ?? '';
  return `${parts.refreshToken}|${projectSegment}|${managedSegment}`;
}

/**
 * 判断 access token 是否已过期或缺失，并预留时钟偏差缓冲时间。
 */
export function accessTokenExpired(auth: OAuthAuthDetails): boolean {
  if (!auth.access || typeof auth.expires !== 'number') {
    return true;
  }
  return auth.expires <= Date.now() + ACCESS_TOKEN_EXPIRY_BUFFER_MS;
}
