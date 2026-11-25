# Browser Agent Installation Guide

## Step 1 — Load the Chrome Extension (Once per Browser Profile)
1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** and choose the `browser-agent/` directory
4. Note the 32-character Extension ID shown under **Browser Agent** (also visible in Side Panel → **Settings**).

---

## Step 2 — Run the Automated Coding-Agent Installer

Run the interactive installer (shows guidelines and asks which coding agent(s) to configure):

```bash
node browser-agent/bridge/setup.mjs
```

Or pass flags directly:

```bash
# Install for a specific coding agent
node browser-agent/bridge/setup.mjs --agents agy
node browser-agent/bridge/setup.mjs --agents codex
node browser-agent/bridge/setup.mjs --agents claude

# Install for multiple or all coding agents
node browser-agent/bridge/setup.mjs --agents agy,codex,claude
node browser-agent/bridge/setup.mjs --agents all

# Print guidelines only or preview changes without writing files
node browser-agent/bridge/setup.mjs --guide
node browser-agent/bridge/setup.mjs --agents all --dry-run
```

All updates are **strictly additive**—the script only adds/updates the `browser-agent` entry in each tool's config and leaves all existing MCP servers and settings untouched.

---

## Per-Agent Guidelines (What Gets Configured)

### 1. Antigravity (`agy`)
- **Automated**: `node browser-agent/bridge/setup.mjs --agents agy`
- **Configured files**:
  - Chrome Native Messaging host (`com.browser_agent.bridge`)
  - Local bridge bearer token (`~/.browser-agent/bridge-token`)
  - Global MCP config (`~/.gemini/config/mcp_config.json`):
    ```json
    {
      "mcpServers": {
        "browser-agent": {
          "command": "node",
          "args": ["/abs/path/to/browser-agent/bridge/mcp-server.mjs"]
        }
      }
    }
    ```
  - Optional global skill (`~/.gemini/config/skills/browser-agent/SKILL.md`, skip with `--skip-skill`)

### 2. OpenAI Codex (`codex`)
- **Automated**: `node browser-agent/bridge/setup.mjs --agents codex`
- **Manual CLI equivalent**:
  ```bash
  codex mcp add browser-agent -- node /abs/path/to/browser-agent/bridge/mcp-server.mjs
  ```
- **Configured file**: `~/.codex/config.toml` (`[mcp_servers.browser-agent]`)

### 3. Claude (`claude` — Claude Code & Claude Desktop)
- **Automated**: `node browser-agent/bridge/setup.mjs --agents claude`
- **Manual Claude Code CLI equivalent**:
  ```bash
  claude mcp add --scope user browser-agent -- node /abs/path/to/browser-agent/bridge/mcp-server.mjs
  ```
- **Configured files**:
  - Claude Code (user scope): `~/.claude.json` (`mcpServers["browser-agent"]`)
  - Claude Desktop (auto-updated if installed):
    - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
    - Linux: `~/.config/Claude/claude_desktop_config.json`
    - Windows: `%APPDATA%\Claude\claude_desktop_config.json`

---

## Verify Connection
With Chrome open, verify the bridge is connected:

```bash
node browser-agent/bridge/cli.mjs health
```
