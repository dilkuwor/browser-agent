# Browser Agent (Claude-like Chrome Extension)

A Manifest V3 Chrome extension for autonomous browser automation with a persistent Side Panel UI, CDP (`chrome.debugger`) trusted input & DevTools inspection, multi-tab context, scheduled tasks, safety/HITL gates, and a local WebSocket/HTTP/MCP bridge for external agents like **Antigravity (`agy`)**.

## Features
- **Side Panel UI (`chrome.sidePanel`)**: Live **streaming responses**, persistent multi-turn **Chat Threads** (`+ New` / `Clear` / `Del`), step **screenshot thumbnails** (click to zoom/download), **Slash Templates** (`/` + custom `/cmd` commands), **Token & Estimated Cost HUD**, inline HITL approval & **Human Handoff (`ask_user`)** cards, and 1-click **Detach Debugger (`🧹`)**.
- **Full-Page Screenshot & Read Aloud (TTS)**: `full_page_screenshot` scrolling-stitch capture (plus quick **Full Shot** toolbar button), and **🔊 Read** / **Auto-Read** voice playback via local **AIHub Kokoro API** (`http://127.0.0.1:8091`) or **macOS built-in voices**.
- **Developer & Power-User Tools**: Export saved macros or last runs to **Playwright (`.spec.ts`)** or **Puppeteer (`.mjs`)** (`export_script` + Macros UI), local file attachment (`upload_file` incl. iframes), download inspection (`list_downloads`), iframe & paginated HTML/ARIA table extraction to JSON/CSV (`extract_table`), CDP drag-and-drop (`drag_and_drop`), and cookie/localStorage/sessionStorage inspection (`inspect_storage`).
- **Smart Browser Perception & Control**: Viewport & **Set-of-Marks (`[id]`)** annotated screenshots, occlusion-aware interactive element indexing + `cursor: pointer` discovery, open **Shadow DOM** + **`<iframe>`** piercing, `wait_for` (selector/text/URL), container-aware `scroll`, key chords (`Control+a`, `Meta+Enter`), and CDP Accessibility Tree (`Accessibility.getFullAXTree`).
- **Batch `fill_form` & Trusted Input**: Fill multi-field forms (inputs, selects, checkboxes, radios, React controlled inputs) in one turn using CDP trusted events.
- **Deterministic Macros & Self-Healing Replay**: Multi-tab user recording (`click`, `type`, `select_option`, `press_key`, `upload_file`), **parameterized macros (`{{VAR}}`)**, inline **Macro Step Editor**, and automatic **LLM self-healing writeback** back to $0 replay.
- **Zero-Manual-Server Native Messaging**: Install the Chrome/Chromium/Brave/Arc/Edge Native Messaging host across macOS/Linux/Windows (`node browser-agent/bridge/install-native-host.mjs [--browser chrome]`) so Chrome auto-launches the `agy` HTTP/MCP bridge on demand.
- **Visual Agent Feedback**: Animated virtual agent cursor with click ripple + an animated gradient viewport border & status pill (`agy is working…` / `claude is working…`) rendered in an isolated Shadow DOM overlay while the agent operates on a page.
- **CDP Automation & Debugging (`chrome.debugger`)**: Lazy CDP attachment, `detach_debugger`, trusted mouse/keyboard events, console logs, and network tracking with **request `postData` + response body inspection (`get_network_detail`)**.
- **Multi-Tab Workflows & Auto Tab Grouping**: Attach multiple tabs in the Side Panel, or automatically group newly opened tabs into a Chrome tab group named after the active agent (`agy` in cyan when driven by `agy`, `claude` in orange when driven by Anthropic in the Side Panel).
- **Scheduled Tasks (`chrome.alarms`)**: Recurring AI prompt or $0 macro workflows with **Run Now** and last-run status tracking.
- **Safety & Privacy Vault**: Domain allowlist/blocklist + scheme protection (`chrome://`, `javascript:`, `data:`), HITL confirmation for submits/payments/passwords/uploads, `<untrusted_page_content>` prompt-injection delimiters, password redaction during recording, and a local **Secrets Vault (`{{NAME}}`)**.
- **BYOK, Local Ollama & Dual-Model Routing**: Anthropic (Claude), OpenAI (GPT), OpenRouter, Google (Gemini), local/Tailscale **Ollama** (`http://ml-server.taila13119.ts.net:11434/v1` default; configure `OLLAMA_ORIGINS="chrome-extension://*"` or `"*"` on the Ollama server so Chrome extension `Origin` requests aren't rejected with HTTP 403), or custom OpenAI-compatible endpoints with 1-click **Fetch** model discovery, text-only vision auto-fallback, and **Dual-Model Routing** (automatic escalation on consecutive errors, stuck loops, or screenshots).
- **agy Local Bridge & MCP Server**: Token-authenticated + Origin-guarded localhost WebSocket/HTTP/stdio MCP server (`bridge/`) exposing all tools, `run_task`, native MCP `image` blocks for screenshots, and MCP `resources` (`browser://health`, `browser://tabs`, `browser://macros`).

## Load in Chrome
1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** and select `browser-agent/`
4. Click the extension icon to open the Side Panel.

## Automate Chrome from `agy`, `codex`, or `claude` (One-Command Setup)
Run the interactive setup script (includes guidelines and lets you pick `agy`, `codex`, `claude`, or `all`):
```bash
node browser-agent/bridge/setup.mjs
```
Or install directly for a specific agent:
```bash
node browser-agent/bridge/setup.mjs --agents agy
node browser-agent/bridge/setup.mjs --agents codex
node browser-agent/bridge/setup.mjs --agents claude
```
See [INSTALL.md](./INSTALL.md) for full per-agent installation guidelines, or use the standalone CLI/manual bridge:
```bash
node browser-agent/bridge/install-native-host.mjs   # Native Messaging only
node browser-agent/bridge/cli.mjs health
node browser-agent/bridge/cli.mjs call navigate '{"url":"https://example.com"}'
node browser-agent/bridge/cli.mjs call observe_page '{}'
node browser-agent/bridge/cli.mjs call click '{"elementId":1}'
```
Or register `browser-agent/bridge/mcp-server.mjs` as a stdio MCP server.
