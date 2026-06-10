import { AGY_CLI_VERSION } from './agy-cli-version';

const AGY_CLI_UA_NAME = 'GeminiCLI';
const AGY_CLI_DEFAULT_MODEL = 'gemini-code-assist';
const AGY_CLI_DEFAULT_SURFACE = 'terminal';

export function getAgyCliVersion(): string {
  const explicitVersion = process.env.OPENCODE_AGY_CLI_VERSION?.trim();
  if (explicitVersion) {
    return explicitVersion;
  }
  return AGY_CLI_VERSION;
}

export function buildAgyCliUserAgent(model?: string): string {
  return 'antigravity/cli/1.0.3 darwin/amd64';
}

function getAgyCliSurface(): string {
  return (
    process.env.AGY_CLI_SURFACE?.trim() ||
    process.env.SURFACE?.trim() ||
    AGY_CLI_DEFAULT_SURFACE
  );
}

export const userAgentInternals = {
  resetCache() {}
};
