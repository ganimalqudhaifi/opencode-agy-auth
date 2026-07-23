import type { OpencodeClient, Auth } from '@opencode-ai/sdk';
import type { Provider as ProviderV1 } from '@opencode-ai/sdk';
import type { Model as ModelV2 } from '@opencode-ai/sdk/v2';
import type { Hooks, Config as PluginConfig } from '@opencode-ai/plugin';

export type OAuthAuthDetails = Extract<Auth, { type: 'oauth' }>;
export type AuthDetails = Auth;
export type GetAuth = () => Promise<AuthDetails>;

export type Provider = ProviderV1;
export type ProviderModel = ModelV2;

export type Config = PluginConfig;

export interface LoaderResult {
  apiKey: string;
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}

export type PluginClient = OpencodeClient;

export interface PluginContext {
  client: PluginClient;
}

export type PluginResult = Hooks;

export interface RefreshParts {
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
}

export interface ProjectContextResult {
  auth: OAuthAuthDetails;
  effectiveProjectId: string;
}

export type ModelFamily = 'claude' | 'gemini';

export interface ManagedAccount {
  index: number;
  email?: string;
  addedAt: number;
  lastUsed: number;
  parts: RefreshParts;
  access?: string;
  expires?: number;
  enabled: boolean;
  rateLimitResetTimes: Partial<Record<ModelFamily, number>>;
}

export interface AccountStorageSchema {
  version: 1;
  accounts: Array<{
    email?: string;
    refreshToken: string;
    projectId?: string;
    managedProjectId?: string;
    addedAt: number;
    lastUsed: number;
    enabled: boolean;
    rateLimitResetTimes?: Partial<Record<ModelFamily, number>>;
  }>;
  activeIndexByFamily?: Partial<Record<ModelFamily, number>>;
}

// Export V2 types explicitly for use in provider hooks
export type { Provider as ProviderV2, Model as ModelV2 } from '@opencode-ai/sdk/v2';
