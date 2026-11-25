#!/usr/bin/env node
// Chrome Native Messaging host that auto-starts the local HTTP API on 127.0.0.1:19222
// and forwards requests to the extension over stdin/stdout without needing a manual terminal.
import { createBridgeHttpServer } from './http-router.mjs';

const PORT = Number(process.env.BA_BRIDGE_PORT || 19222);
const HOST = '127.0.0.1';

let extTools = [];
let extId = null;
let connected = false;
const pending = new Map();

function writeNativeMessage(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(payload.length, 0);
  process.stdout.write(Buffer.concat([lenBuf, payload]));
}

function callExtension(method, params = {}, timeoutMs = 30000) {
  if (!connected) {
    return Promise.reject(new Error('Native messaging port not connected.'));
  }
  const id = `nat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for extension (${method})`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    writeNativeMessage({ id, method, params });
  });
}

let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const msgLen = buf.readUInt32LE(0);
    if (buf.length < 4 + msgLen) return;
    const raw = buf.subarray(4, 4 + msgLen).toString('utf8');
    buf = buf.subarray(4 + msgLen);

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      continue;
    }

    if (msg.type === 'hello') {
      connected = true;
      extTools = msg.tools || [];
      extId = msg.extensionId || extId;
      continue;
    }
    if (msg.type === 'pong') continue;
    if (msg.id && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error || 'Extension error'));
    }
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});

const heartbeat = setInterval(() => {
  if (connected) {
    writeNativeMessage({ type: 'ping' });
  }
}, 20000);
heartbeat.unref();

const server = createBridgeHttpServer({
  getHealth: () => ({
    ok: true,
    mode: 'native-messaging',
    extensionConnected: connected,
    extensionId: extId,
    toolsCount: extTools.length
  }),
  callExtension,
  getToolsCache: () => extTools
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[native-host] Port ${PORT} already in use; HTTP server skipped.`);
  } else {
    console.error('[native-host] HTTP error:', err.message);
  }
});

server.listen(PORT, HOST);
