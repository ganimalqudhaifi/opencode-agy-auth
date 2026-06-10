import { OpencodeClient } from '@opencode-ai/sdk';
import { Hooks } from '@opencode-ai/plugin';

type PluginClient = OpencodeClient;
interface PluginContext {
    client: PluginClient;
}
type PluginResult = Hooks;

/**
 * 为 Opencode 注册 Agy OAuth 提供者。
 */
declare const AgyCLIOAuthPlugin: ({ client }: PluginContext) => Promise<PluginResult>;
declare const GoogleOAuthPlugin: ({ client }: PluginContext) => Promise<PluginResult>;

export { AgyCLIOAuthPlugin, GoogleOAuthPlugin, AgyCLIOAuthPlugin as default };
