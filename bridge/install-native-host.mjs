#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HOST_NAME = 'com.browser_agent.bridge';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(__dirname, '..');

export function getBrowserTargets(platform = process.platform) {
  const home = os.homedir();
  if (platform === 'darwin') {
    const appSup = path.join(home, 'Library/Application Support');
    return {
      chrome: { base: path.join(appSup, 'Google/Chrome'), hostsDir: path.join(appSup, 'Google/Chrome/NativeMessagingHosts') },
      chromium: { base: path.join(appSup, 'Chromium'), hostsDir: path.join(appSup, 'Chromium/NativeMessagingHosts') },
      brave: { base: path.join(appSup, 'BraveSoftware/Brave-Browser'), hostsDir: path.join(appSup, 'BraveSoftware/Brave-Browser/NativeMessagingHosts') },
      arc: { base: path.join(appSup, 'Arc/User Data'), hostsDir: path.join(appSup, 'Arc/User Data/NativeMessagingHosts') },
      edge: { base: path.join(appSup, 'Microsoft Edge'), hostsDir: path.join(appSup, 'Microsoft Edge/NativeMessagingHosts') }
    };
  }
  if (platform === 'linux') {
    const cfg = path.join(home, '.config');
    return {
      chrome: { base: path.join(cfg, 'google-chrome'), hostsDir: path.join(cfg, 'google-chrome/NativeMessagingHosts') },
      chromium: { base: path.join(cfg, 'chromium'), hostsDir: path.join(cfg, 'chromium/NativeMessagingHosts') },
      brave: { base: path.join(cfg, 'BraveSoftware/Brave-Browser'), hostsDir: path.join(cfg, 'BraveSoftware/Brave-Browser/NativeMessagingHosts') },
      edge: { base: path.join(cfg, 'microsoft-edge'), hostsDir: path.join(cfg, 'microsoft-edge/NativeMessagingHosts') }
    };
  }
  if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData/Local');
    return {
      chrome: {
        base: path.join(local, 'Google/Chrome/User Data'),
        hostsDir: path.join(home, '.browser-agent/native-hosts/chrome'),
        regKey: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`
      },
      brave: {
        base: path.join(local, 'BraveSoftware/Brave-Browser/User Data'),
        hostsDir: path.join(home, '.browser-agent/native-hosts/brave'),
        regKey: `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${HOST_NAME}`
      },
      edge: {
        base: path.join(local, 'Microsoft/Edge/User Data'),
        hostsDir: path.join(home, '.browser-agent/native-hosts/edge'),
        regKey: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`
      }
    };
  }
  return {};
}

export async function detectIdFromBridge() {
  try {
    const res = await fetch('http://127.0.0.1:19222/health', { signal: AbortSignal.timeout(1500) });
    const data = await res.json();
    return data?.extensionId || null;
  } catch {
    return null;
  }
}

export function detectIdFromBrowserPrefs(baseDir) {
  if (!baseDir) return null;
  try {
    const profiles = fs.readdirSync(baseDir);
    for (const prof of profiles) {
      for (const fname of ['Preferences', 'Secure Preferences']) {
        const p = path.join(baseDir, prof, fname);
        if (!fs.existsSync(p)) continue;
        try {
          const data = JSON.parse(fs.readFileSync(p, 'utf8'));
          const settings = data?.extensions?.settings || {};
          for (const [eid, info] of Object.entries(settings)) {
            if (String(info?.path || '') === extDir || String(info?.path || '').endsWith('/browser-agent') || String(info?.path || '').endsWith('\\browser-agent')) {
              return eid;
            }
          }
        } catch {
          // Ignore unreadable profile files
        }
      }
    }
  } catch {
    // Ignore TCC-protected or missing directory
  }
  return null;
}

export async function detectExtensionId({ id = null, browser = 'chrome' } = {}) {
  if (id) return id;
  const fromBridge = await detectIdFromBridge();
  if (fromBridge) return fromBridge;
  const targets = getBrowserTargets();
  const preferred = targets[browser];
  if (preferred) {
    const hit = detectIdFromBrowserPrefs(preferred.base);
    if (hit) return hit;
  }
  for (const t of Object.values(targets)) {
    const hit = detectIdFromBrowserPrefs(t.base);
    if (hit) return hit;
  }
  return null;
}

export async function installNativeHost({ id = null, browser = 'chrome', dryRun = false } = {}) {
  const cleanBrowser = String(browser || 'chrome').toLowerCase();
  const targets = getBrowserTargets();
  const target = targets[cleanBrowser];
  if (!target) {
    return {
      ok: false,
      error: `Unsupported browser "${cleanBrowser}" for platform "${process.platform}". Supported: ${Object.keys(targets).join(', ')}`
    };
  }

  const extensionId = await detectExtensionId({ id, browser: cleanBrowser });
  if (!extensionId) {
    return {
      ok: false,
      needsExtensionId: true,
      error: `Could not auto-detect Browser Agent extension ID. Pass --id <32-char-extension-id> from chrome://extensions/.`
    };
  }

  const hostScript = path.join(__dirname, 'native-host.mjs');
  const isWin = process.platform === 'win32';
  const launcherPath = path.join(__dirname, isWin ? 'native-host-launcher.bat' : 'native-host-launcher.sh');
  const launcherBody = isWin
    ? `@echo off\r\n"${process.execPath}" "${hostScript}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${hostScript}"\n`;

  const manifestPath = path.join(target.hostsDir, `${HOST_NAME}.json`);
  const manifest = {
    name: HOST_NAME,
    description: 'Browser Agent Native Messaging Bridge',
    path: launcherPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`]
  };

  if (!dryRun) {
    fs.writeFileSync(launcherPath, launcherBody, { mode: 0o755 });
    if (!isWin) fs.chmodSync(launcherPath, 0o755);
    fs.mkdirSync(target.hostsDir, { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    if (isWin && target.regKey) {
      execFileSync('reg', ['add', target.regKey, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { stdio: 'inherit' });
    }
  }

  return {
    ok: true,
    dryRun,
    platform: process.platform,
    browser: cleanBrowser,
    extensionId,
    manifestPath,
    launcherPath
  };
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  let id = null;
  let browser = 'chrome';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--id' && args[i + 1]) {
      id = args[++i].trim();
    } else if (args[i] === '--browser' && args[i + 1]) {
      browser = args[++i].trim().toLowerCase();
    } else if (/^[a-p]{32}$/.test(args[i])) {
      id = args[i];
    }
  }
  return { id, browser };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const opts = parseCliArgs();
  const res = await installNativeHost(opts);
  if (!res.ok) {
    console.error(res.error);
    process.exit(1);
  }
  console.log(JSON.stringify(res, null, 2));
}
