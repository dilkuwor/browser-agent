// Shared local bearer-token auth and Host/Origin guards for the localhost bridge.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function getTokenFilePath() {
  return process.env.BA_BRIDGE_TOKEN_FILE || path.join(os.homedir(), '.browser-agent', 'bridge-token');
}

export function getOrCreateBridgeToken() {
  if (process.env.BA_BRIDGE_TOKEN) return process.env.BA_BRIDGE_TOKEN;
  const tokenPath = getTokenFilePath();
  try {
    if (fs.existsSync(tokenPath)) {
      const existing = fs.readFileSync(tokenPath, 'utf8').trim();
      if (existing.length >= 16) return existing;
    }
  } catch {
    // Recreate below
  }
  const token = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  return token;
}

export function getBridgeAuthHeaders() {
  if (process.env.BA_BRIDGE_NO_AUTH === '1') return {};
  const token = getOrCreateBridgeToken();
  return { authorization: `Bearer ${token}` };
}

function isLocalhostHost(hostHeader = '') {
  const clean = String(hostHeader).toLowerCase().trim();
  if (!clean) return true;
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(clean);
}

export function isAllowedWebSocketUpgrade(req) {
  if (!isLocalhostHost(req.headers?.host)) {
    return { allowed: false, reason: 'Invalid Host header' };
  }
  const origin = req.headers?.origin;
  if (origin && !String(origin).startsWith('chrome-extension://')) {
    return { allowed: false, reason: 'Untrusted WebSocket Origin' };
  }
  return { allowed: true };
}

export function authorizeHttpRequest(req, expectedToken) {
  if (!isLocalhostHost(req.headers?.host)) {
    return { ok: false, status: 403, error: 'Forbidden host header' };
  }
  const origin = req.headers?.origin;
  if (origin && !String(origin).startsWith('chrome-extension://')) {
    return { ok: false, status: 403, error: 'Browser cross-origin requests to local bridge are blocked' };
  }
  if (req.method === 'GET' && req.url === '/health') {
    return { ok: true };
  }
  if (process.env.BA_BRIDGE_NO_AUTH === '1') {
    return { ok: true };
  }
  const auth = String(req.headers?.authorization || '');
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const alt = String(req.headers?.['x-ba-token'] || '').trim();
  const provided = bearer || alt;
  if (!expectedToken || provided.length !== expectedToken.length) {
    return { ok: false, status: 401, error: 'Unauthorized: missing or invalid bridge bearer token' };
  }
  const match = crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expectedToken));
  if (!match) {
    return { ok: false, status: 401, error: 'Unauthorized: invalid bridge bearer token' };
  }
  return { ok: true };
}
