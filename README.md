# OpenCode Antigravity CLI Auth Plugin

An [OpenCode](https://opencode.ai/) authentication plugin that enables seamless interaction with the Antigravity CLI (`agy`) by hooking into its authentication, quota retrieval, and dynamic model fetching layers.

## Features

- **OAuth 2.0 Integration**: Uses Antigravity's OAuth flows for authentication.
- **Dynamic Model Retrieval**: Fetches available models based on user tier and current allocations.
- **Multi-Account Pool & Sticky Rotation**: Automatically switches between multiple accounts if one hits a rate limit or exhausts its quota, keeping your OpenCode session alive.
- **Quota Tracking**: Injects tools into OpenCode to check usage limits directly.
- **Traffic Simulation**: Maintains background heartbeat with `agy` servers.

## Installation

Install the plugin from npm (or directly using local file configurations if developing):

```bash
npm install @anthonyhaussman/opencode-agy-auth
```

## Configuration

Update your OpenCode configuration file (typically `opencode.json` at the root of your project or globally at `~/.config/opencode/opencode.json`) to register the plugin.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@anthonyhaussman/opencode-agy-auth"]
}
```

> **Note regarding `projectId`:**
> Prior versions recommended setting a global `projectId` inside the `google-agy` provider options. With the introduction of the **Multi-Account Pool**, this is no longer recommended. 
> The plugin now automatically captures and isolates the Project ID tied to each individual account you log in with. Removing the global `projectId` prevents premature quota exhaustion on a single project and allows the load to be safely distributed across accounts. Setting a global `projectId` will act as a strict override for all accounts.

### Environment Variables

If you are running OpenCode in environments with specific requirements for Antigravity, you can use the following environment variables:

- `OPENCODE_AGY_PROJECT_ID`: Specify your Google Cloud Project ID manually (global override).
- `OPENCODE_AGY_AUTH_PROXY`: Define a proxy if accessing authentication endpoints behind a corporate firewall.
- `OPENCODE_AGY_ENDPOINT`: Override the default internal `daily-cloudcode-pa.googleapis.com` API endpoint.
- `OPENCODE_AGY_VERBOSE_LOGS`: Set to `"1"` to enable verbose diagnostic logs for API calls and responses.

## Usage

Once installed and configured, OpenCode will automatically authenticate against Antigravity CLI when interacting with eligible models. If no active session exists, you will be prompted to complete an OAuth login.

You can manage your accounts and check your quota using slash commands directly in your OpenCode prompt:

- `/agyswitch` - Manage your multi-account pool. Displays all logged-in accounts, lets you authenticate new ones, toggle specific accounts on/off, or manually switch the active account.
- `/agyquota` - Per-model detail view. Shows remaining tokens, progress bars, and reset timers for every model variant.
- `/agyquotasummary` - High-level grouped view. Shows weekly and 5-hour limits aggregated by model family.

You can also ask naturally:
> "What is my current agy quota?"
> "Show me my quota summary"

### Disk Persistence

The plugin persists account lists and retry-cooldown data to disk so that it survives OpenCode restarts.

- **Persistent Data:**
  - Account lists (`accounts.json`) and cooldown metrics (`retry-cooldowns.json`) are neatly stored under `~/.config/opencode/agy/` (or `%APPDATA%\opencode\agy\` on Windows).
- **Ephemeral Data:**
  - High-frequency tracking files that consume storage over time (like `antigravity-signature-cache.json` and `antigravity-turn-states.json`) are explicitly routed to your OS-level Temporary folder (`/tmp` or `%TEMP%`). They automatically get cleaned up by your OS, preserving your permanent disk space while still allowing sessions to survive short-term CLI restarts.

#### `diskEnabled` Parameter

`TurnStateTracker` accepts a `diskEnabled` constructor parameter (defaults to `true`):

```ts
import { TurnStateTracker } from "@anthonyhaussman/opencode-agy-auth/sdk/request/turn-state-tracker";

// Disk persistence enabled (default)
const tracker = new TurnStateTracker(true);

// Memory-only mode - no filesystem reads or writes
const tracker = new TurnStateTracker(false);
```

When `diskEnabled` is `false`, the tracker operates entirely in memory. All state is lost when the process exits. This is useful in restricted environments (containers, read-only filesystems) where disk access is unavailable or undesirable.

If disk initialization fails at runtime (permission error, corrupt file, etc.), the plugin automatically falls back to memory-only mode and logs a warning. No configuration is needed for normal use - disk persistence works out of the box.

## Local Testing

To test and develop the plugin locally with OpenCode before publishing:

1. **Build the plugin locally**:
   Clone the repository, install dependencies, and build the source code:
   ```bash
   npm install
   npm run build
   ```

2. **Configure OpenCode to use the local build**:
   In the target project where you want to test the plugin, open your `opencode.json` (or `~/.config/opencode/opencode.json` for global testing) and add the absolute local path to the plugin:
   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": ["/absolute/path/to/opencode-agy-auth"]
   }
   ```
   *Note: OpenCode also supports dropping plugin files directly into the `.opencode/plugins/` folder in your project.*

3. **Verify the plugin**:
   Launch OpenCode in your target project. OpenCode will automatically resolve and load your local plugin directory. You can test your changes by running `npm run build` in the plugin directory and restarting your OpenCode session.
