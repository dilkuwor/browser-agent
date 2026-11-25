import crypto from 'node:crypto';
import { createBridgeHttpServer } from './http-router.mjs';
import { isAllowedWebSocketUpgrade } from './auth.mjs';

const PORT = Number(process.env.BA_BRIDGE_PORT || 19222);
const HOST = '127.0.0.1';

let extSocket = null;
let extTools = [];
let extId = null;
const pending = new Map();

function wsSend(socket, text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function attachWebSocketParser(socket, onMessage, onClose) {
  let buf = Buffer.alloc(0);
  let fragChunks = [];

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (buf.length < 4) return;
        payloadLen = buf.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buf.length < 10) return;
        payloadLen = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      if (buf.length < offset + maskLen + payloadLen) return;

      const maskKey = masked ? buf.subarray(offset, offset + 4) : null;
      offset += maskLen;
      const payload = Buffer.from(buf.subarray(offset, offset + payloadLen));
      buf = buf.subarray(offset + payloadLen);

      if (masked && maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i % 4];
        }
      }

      if (opcode === 0x8) {
        socket.end();
        onClose();
        return;
      }
      if (opcode === 0x9) {
        const pongHead = Buffer.from([0x8a, payload.length]);
        socket.write(Buffer.concat([pongHead, payload]));
        continue;
      }
      if (opcode === 0x1 || opcode === 0x0) {
        fragChunks.push(payload);
        if (fin) {
          const full = Buffer.concat(fragChunks).toString('utf8');
          fragChunks = [];
          onMessage(full);
        }
      }
    }
  });

  socket.on('close', onClose);
  socket.on('error', onClose);
}

function callExtension(method, params = {}, timeoutMs = 30000) {
  if (!extSocket || extSocket.destroyed) {
    return Promise.reject(new Error('Chrome extension is not connected to bridge.'));
  }
  const id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for extension (${method})`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    wsSend(extSocket, JSON.stringify({ id, method, params }));
  });
}

const server = createBridgeHttpServer({
  getHealth: () => ({
    ok: true,
    mode: 'websocket',
    extensionConnected: Boolean(extSocket && !extSocket.destroyed),
    extensionId: extId,
    toolsCount: extTools.length
  }),
  callExtension,
  getToolsCache: () => extTools
});

server.on('upgrade', (req, socket) => {
  const wsGuard = isAllowedWebSocketUpgrade(req);
  if (!wsGuard.allowed) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');

  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    ''
  ].join('\r\n'));

  if (extSocket && extSocket !== socket) {
    extSocket.destroy();
  }
  extSocket = socket;
  console.log('[bridge] Chrome extension connected');

  const heartbeat = setInterval(() => {
    if (extSocket === socket && !socket.destroyed) {
      wsSend(socket, JSON.stringify({ type: 'ping' }));
    }
  }, 20000);

  attachWebSocketParser(
    socket,
    (text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg.type === 'ping') {
        wsSend(socket, JSON.stringify({ type: 'pong' }));
        return;
      }
      if (msg.type === 'pong') return;
      if (msg.type === 'hello') {
        extTools = msg.tools || [];
        extId = msg.extensionId || extId;
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.ok) entry.resolve(msg.result);
        else entry.reject(new Error(msg.error || 'Extension error'));
      }
    },
    () => {
      clearInterval(heartbeat);
      if (extSocket === socket) {
        extSocket = null;
        console.log('[bridge] Chrome extension disconnected');
      }
    }
  );
});

server.listen(PORT, HOST, () => {
  console.log(`[bridge] Listening on http://${HOST}:${PORT} (ws://${HOST}:${PORT}/ws)`);
});
