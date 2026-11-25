#!/usr/bin/env node
// Guided installer for Browser Agent: configures bridge token, Native Messaging host,
// and MCP integration for selected coding agents (agy, codex, claude) without modifying
// any unrelated existing MCP server entries.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getOrCreateBridgeToken, getTokenFilePath } from './auth.mjs';
import { installNativeHost } from './install-native-host.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const EXT_DIR = path.resolve(__dirname, '..');
export const MCP_SERVER_PATH = path.join(__dirname, 'mcp-server.mjs');

const VALID_AGENTS = ['agy', 'codex', 'claude'];

export function getAgentConfigPaths(platform = process.platform) {
  const home = os.homedir();
  let claudeDesktopPath;
  if (platform === 'darwin') {
    claudeDesktopPath = path.join(home, 'Library/Application Support/Claude/claude_desktop_config.json');
  } else if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData/Roaming');
    claudeDesktopPath = path.join(appData, 'Claude/claude_desktop_config.json');
  } else {
    claudeDesktopPath = path.join(home, '.config/Claude/claude_desktop_config.json');
  }

  return {
    agyMcp: process.env.BA_AGY_MCP_CONFIG || path.join(home, '.gemini/config/mcp_config.json'),
    agySkill: process.env.BA_AGY_SKILL_PATH || path.join(home, '.gemini/config/skills/browser-agent/SKILL.md'),
    codexConfig: process.env.BA_CODEX_CONFIG || path.join(home, '.codex/config.toml'),
    claudeCodeConfig: process.env.BA_CLAUDE_CODE_CONFIG || path.join(home, '.claude.json'),
    claudeDesktopConfig: process.env.BA_CLAUDE_DESKTOP_CONFIG || claudeDesktopPath
  };
}

export function formatInstallGuidelines(agentFilter = 'all') {
  const nodeBin = process.execPath;
  const mcp = MCP_SERVER_PATH;
  const paths = getAgentConfigPaths();
  const sections = [];

  sections.push(
`=== Browser Agent Installation Guidelines ===

[0] Chrome Extension Prerequisite (one-time per browser profile)
    1. Open chrome://extensions/ and enable "Developer mode"
    2. Click "Load unpacked" and select:
       ${EXT_DIR}
    3. Verify "Browser Agent" appears and note its 32-char Extension ID.`
  );

  if (agentFilter === 'all' || agentFilter === 'agy') {
    sections.push(
`[1] Antigravity (agy)
    - Automated:
        node browser-agent/bridge/setup.mjs --agents agy
    - What it configures:
        * Chrome Native Messaging host (com.browser_agent.bridge)
        * Local bridge auth token (${getTokenFilePath()})
        * Global MCP config: ${paths.agyMcp}
          -> adds mcpServers["browser-agent"] = { command: "${nodeBin}", args: ["${mcp}"] }
        * Optional global skill: ${paths.agySkill}`
    );
  }

  if (agentFilter === 'all' || agentFilter === 'codex') {
    sections.push(
`[2] OpenAI Codex (codex)
    - Automated:
        node browser-agent/bridge/setup.mjs --agents codex
    - Manual CLI equivalent:
        codex mcp add browser-agent -- "${nodeBin}" "${mcp}"
    - Config file updated:
        ${paths.codexConfig} ([mcp_servers.browser-agent])`
    );
  }

  if (agentFilter === 'all' || agentFilter === 'claude') {
    sections.push(
`[3] Claude (Claude Code & Claude Desktop)
    - Automated:
        node browser-agent/bridge/setup.mjs --agents claude
    - Manual Claude Code CLI equivalent:
        claude mcp add --scope user browser-agent -- "${nodeBin}" "${mcp}"
    - Config files updated:
        * Claude Code (user scope): ${paths.claudeCodeConfig}
        * Claude Desktop (if installed): ${paths.claudeDesktopConfig}`
    );
  }

  return sections.join('\n\n');
}

export function parseAgentSelection(raw) {
  const tokens = String(raw || '')
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const selected = new Set();
  for (const tok of tokens) {
    if (tok === '4' || tok === 'all') {
      VALID_AGENTS.forEach((a) => selected.add(a));
    } else if (tok === '1' || tok === 'agy' || tok === 'antigravity') {
      selected.add('agy');
    } else if (tok === '2' || tok === 'codex') {
      selected.add('codex');
    } else if (tok === '3' || tok === 'claude' || tok === 'claude-code' || tok === 'claude-desktop') {
      selected.add('claude');
    } else {
      throw new Error(`Unknown coding agent "${tok}". Valid choices: agy, codex, claude, all`);
    }
  }
  return [...selected];
}

export function upsertJsonMcpConfig(filePath, serverEntry, { dryRun = false } = {}) {
  let data = {};
  if (fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (raw) {
      data = JSON.parse(raw);
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`Expected JSON object in ${filePath}`);
  }
  const existingServers = (data.mcpServers && typeof data.mcpServers === 'object' && !Array.isArray(data.mcpServers))
    ? data.mcpServers
    : {};
  const next = {
    ...data,
    mcpServers: {
      ...existingServers,
      'browser-agent': serverEntry
    }
  };
  if (!dryRun) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`);
  }
  return { ok: true, filePath, dryRun };
}

export function upsertTomlMcpSection(tomlText, nodePath, mcpServerPath) {
  const newBlock = [
    '[mcp_servers.browser-agent]',
    `command = ${JSON.stringify(nodePath)}`,
    `args = [${JSON.stringify(mcpServerPath)}]`
  ].join('\n');

  const lines = String(tomlText || '').split(/\r?\n/);
  const out = [];
  let skipping = false;
  let replaced = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const tableMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (tableMatch) {
      const tableName = tableMatch[1].trim();
      if (tableName === 'mcp_servers.browser-agent' || tableName === 'mcp_servers."browser-agent"') {
        skipping = true;
        if (!replaced) {
          out.push(newBlock);
          replaced = true;
        }
        continue;
      }
      if (skipping && !tableName.startsWith('mcp_servers.browser-agent.') && !tableName.startsWith('mcp_servers."browser-agent".')) {
        skipping = false;
      }
    }
    if (!skipping) {
      out.push(line);
    }
  }

  let body = out.join('\n').replace(/\s+$/, '');
  if (!replaced) {
    body = body ? `${body}\n\n${newBlock}\n` : `${newBlock}\n`;
  } else {
    body = `${body}\n`;
  }
  return body;
}

const AGY_SKILL_CONTENT = `---
name: browser-agent
description: >-
  Automate the user's active Chrome browser via the browser-agent MCP server
  (logged-in tabs, element indexing, batch fill_form, wait_for, full_page_screenshot,
  table extraction, and zero-token deterministic macros).
---

# Browser Agent Automation

Use the \`browser-agent\` MCP tools when automating pages in the user's Chrome session:

1. Start by calling \`observe_page\` (with \`includeScreenshot: false\` first for speed/low tokens; enable \`includeScreenshot: true\` when visual layout or Set-of-Marks \`[id]\` labels are needed).
2. Use \`fill_form\` to populate multiple inputs, dropdowns, checkboxes, and submit in one round-trip.
3. Use \`wait_for\` after triggering async UI changes instead of repeated polling.
4. Use \`extract_table\` for HTML/ARIA tables (supports pagination and CSV/JSON download) and \`full_page_screenshot\` for stitched full-page captures.
5. Use \`ask_user\` when encountering 2FA, CAPTCHA, or manual confirmation steps.
6. For repeatable workflows, use \`save_macro\` / \`replay_macro\`.
`;

export function installForAgy({ nodeExecPath = process.execPath, mcpServerPath = MCP_SERVER_PATH, installSkill = true, dryRun = false } = {}) {
  const paths = getAgentConfigPaths();
  const mcpRes = upsertJsonMcpConfig(paths.agyMcp, {
    command: nodeExecPath,
    args: [mcpServerPath]
  }, { dryRun });

  let skillResult = null;
  if (installSkill) {
    if (!dryRun) {
      fs.mkdirSync(path.dirname(paths.agySkill), { recursive: true });
      fs.writeFileSync(paths.agySkill, AGY_SKILL_CONTENT);
    }
    skillResult = { path: paths.agySkill, dryRun };
  }

  return { agent: 'agy', ...mcpRes, skill: skillResult };
}

export function installForCodex({ nodeExecPath = process.execPath, mcpServerPath = MCP_SERVER_PATH, dryRun = false } = {}) {
  const paths = getAgentConfigPaths();
  const existing = fs.existsSync(paths.codexConfig) ? fs.readFileSync(paths.codexConfig, 'utf8') : '';
  const updated = upsertTomlMcpSection(existing, nodeExecPath, mcpServerPath);
  if (!dryRun) {
    fs.mkdirSync(path.dirname(paths.codexConfig), { recursive: true });
    fs.writeFileSync(paths.codexConfig, updated);
  }
  return { agent: 'codex', ok: true, filePath: paths.codexConfig, dryRun };
}

export function installForClaude({ nodeExecPath = process.execPath, mcpServerPath = MCP_SERVER_PATH, includeDesktopIfPresent = true, dryRun = false } = {}) {
  const paths = getAgentConfigPaths();
  const results = [];

  // Claude Code user-scope config (~/.claude.json)
  results.push({
    target: 'claude-code',
    ...upsertJsonMcpConfig(paths.claudeCodeConfig, {
      type: 'stdio',
      command: nodeExecPath,
      args: [mcpServerPath]
    }, { dryRun })
  });

  // Claude Desktop config (only if Claude Desktop directory/file exists or explicitly overridden)
  const desktopDirExists = fs.existsSync(path.dirname(paths.claudeDesktopConfig));
  if (includeDesktopIfPresent && (desktopDirExists || process.env.BA_CLAUDE_DESKTOP_CONFIG)) {
    results.push({
      target: 'claude-desktop',
      ...upsertJsonMcpConfig(paths.claudeDesktopConfig, {
        command: nodeExecPath,
        args: [mcpServerPath]
      }, { dryRun })
    });
  }

  return { agent: 'claude', ok: true, targets: results };
}

export async function runSetup({
  agents = [],
  browser = 'chrome',
  id = null,
  skipNative = false,
  skipSkill = false,
  dryRun = false,
  nodeExecPath = process.execPath,
  mcpServerPath = MCP_SERVER_PATH
} = {}) {
  const selected = Array.isArray(agents) && agents.length > 0 ? agents : [];
  if (selected.length === 0) {
    throw new Error('No coding agents selected.');
  }

  const tokenPath = getTokenFilePath();
  if (!dryRun) {
    getOrCreateBridgeToken();
  }

  let nativeResult = { skipped: true };
  if (!skipNative) {
    nativeResult = await installNativeHost({ id, browser, dryRun });
  }

  const installed = [];
  for (const agent of selected) {
    if (agent === 'agy') {
      installed.push(installForAgy({ nodeExecPath, mcpServerPath, installSkill: !skipSkill, dryRun }));
    } else if (agent === 'codex') {
      installed.push(installForCodex({ nodeExecPath, mcpServerPath, dryRun }));
    } else if (agent === 'claude') {
      installed.push(installForClaude({ nodeExecPath, mcpServerPath, dryRun }));
    }
  }

  return {
    ok: true,
    dryRun,
    tokenPath,
    nativeHost: nativeResult,
    installed
  };
}

function parseCliArgs(argv) {
  let agentsRaw = null;
  let browser = 'chrome';
  let id = null;
  let skipNative = false;
  let skipSkill = false;
  let dryRun = false;
  let showGuide = null;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') help = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--skip-native') skipNative = true;
    else if (a === '--skip-skill') skipSkill = true;
    else if (a === '--guide') {
      const next = argv[i + 1];
      showGuide = (next && !next.startsWith('-')) ? argv[++i].toLowerCase() : 'all';
    } else if ((a === '--agents' || a === '--agent') && argv[i + 1]) {
      agentsRaw = argv[++i];
    } else if (a === '--browser' && argv[i + 1]) {
      browser = argv[++i].toLowerCase();
    } else if (a === '--id' && argv[i + 1]) {
      id = argv[++i].trim();
    }
  }
  return { agentsRaw, browser, id, skipNative, skipSkill, dryRun, showGuide, help };
}

function printHelp() {
  console.log([
    'Browser Agent Unified Setup Script',
    '',
    'Usage:',
    '  node browser-agent/bridge/setup.mjs                          # Interactive guide & setup',
    '  node browser-agent/bridge/setup.mjs --guide [agy|codex|claude|all]',
    '  node browser-agent/bridge/setup.mjs --agents agy|codex|claude|all [options]',
    '',
    'Options:',
    '  --agents <list>    Comma-separated coding agents: agy, codex, claude, all',
    '  --browser <name>   Browser for Native Messaging: chrome, chromium, brave, arc, edge (default: chrome)',
    '  --id <extId>       32-char Chrome Extension ID (auto-detected when omitted)',
    '  --skip-native      Skip Chrome Native Messaging host installation',
    '  --skip-skill       Skip installing global agy SKILL.md helper',
    '  --dry-run          Preview changes without writing files',
    '  --guide [agent]    Print installation guidelines and exit'
  ].join('\n'));
}

async function runInteractive(opts) {
  console.log(formatInstallGuidelines('all'));
  console.log('\n----------------------------------------');
  console.log('Select coding agent(s) to install Browser Agent for:');
  console.log('  1) agy    (Antigravity)');
  console.log('  2) codex  (OpenAI Codex)');
  console.log('  3) claude (Claude Code & Claude Desktop)');
  console.log('  4) all    (agy + codex + claude)\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('Choice (e.g. 1, 1,3, codex, or all) [4]: ')).trim() || '4';
    const selected = parseAgentSelection(answer);

    let skipSkill = opts.skipSkill;
    if (selected.includes('agy') && !opts.skipSkill) {
      const sk = (await rl.question('Install global agy SKILL.md helper? [Y/n]: ')).trim().toLowerCase();
      if (sk === 'n' || sk === 'no') skipSkill = true;
    }

    let browser = opts.browser;
    let id = opts.id;
    let skipNative = opts.skipNative;
    if (!skipNative) {
      const br = (await rl.question(`Browser for Native Messaging [${browser}]: `)).trim().toLowerCase();
      if (br) browser = br;
      const probe = await installNativeHost({ id, browser, dryRun: true });
      if (!probe.ok && probe.needsExtensionId) {
        const pasted = (await rl.question('Extension ID not auto-detected. Paste 32-char ID (or press Enter to skip Native Host for now): ')).trim();
        if (pasted) id = pasted;
        else skipNative = true;
      }
    }

    const result = await runSetup({
      agents: selected,
      browser,
      id,
      skipNative,
      skipSkill,
      dryRun: opts.dryRun
    });
    console.log('\nSetup complete:');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    rl.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const opts = parseCliArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    process.exit(0);
  }
  if (opts.showGuide) {
    console.log(formatInstallGuidelines(opts.showGuide));
    process.exit(0);
  }
  if (opts.agentsRaw) {
    const selected = parseAgentSelection(opts.agentsRaw);
    const result = await runSetup({
      agents: selected,
      browser: opts.browser,
      id: opts.id,
      skipNative: opts.skipNative,
      skipSkill: opts.skipSkill,
      dryRun: opts.dryRun
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.nativeHost && result.nativeHost.ok === false && !result.nativeHost.skipped) {
      console.error(`\n[Notice] Native Messaging host was not installed: ${result.nativeHost.error}`);
      console.error('MCP config was still updated. Re-run with --id <extension-id> after loading Browser Agent in Chrome.');
    }
    process.exit(0);
  }
  if (process.stdin.isTTY) {
    await runInteractive(opts);
  } else {
    printHelp();
    console.log('\n' + formatInstallGuidelines('all'));
  }
}
