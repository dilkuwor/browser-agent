import http from 'node:http';
import { authorizeHttpRequest, getOrCreateBridgeToken } from './auth.mjs';

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export function createBridgeHttpServer({ getHealth, callExtension, getToolsCache }) {
  const expectedToken = getOrCreateBridgeToken();

  return http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');

    const authCheck = authorizeHttpRequest(req, expectedToken);
    if (!authCheck.ok) {
      res.statusCode = authCheck.status;
      res.end(JSON.stringify({ ok: false, error: authCheck.error }));
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      res.end(JSON.stringify(getHealth()));
      return;
    }

    if (req.method === 'GET' && req.url === '/tools') {
      try {
        const health = getHealth();
        const result = health.extensionConnected
          ? await callExtension('list_tools', {}, 5000)
          : { tools: getToolsCache() };
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (err) {
        res.statusCode = 503;
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/tabs') {
      try {
        const result = await callExtension('call_tool', { tool: 'list_tabs', args: {} }, 5000);
        res.end(JSON.stringify(result));
      } catch (err) {
        res.statusCode = 503;
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/macros') {
      try {
        const result = await callExtension('call_tool', { tool: 'list_macros', args: {} }, 5000);
        res.end(JSON.stringify(result));
      } catch (err) {
        res.statusCode = 503;
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/call') {
      try {
        const body = await readJsonBody(req);
        const timeoutMs = (body.tool === 'replay_macro' || body.tool === 'full_page_screenshot')
          ? 90000
          : (body.timeoutMs || 30000);
        const result = await callExtension('call_tool', {
          tool: body.tool,
          args: body.args || {},
          agent: body.agent || 'agy',
          skipSafety: body.skipSafety !== false
        }, timeoutMs);
        res.end(JSON.stringify(result));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/task') {
      try {
        const body = await readJsonBody(req);
        const result = await callExtension('run_task', {
          prompt: body.prompt || '',
          agent: body.agent || 'agy'
        }, 120000);
        res.end(JSON.stringify(result));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/settings') {
      try {
        const body = await readJsonBody(req);
        const result = await callExtension('save_settings', {
          settings: body.settings || body || {}
        });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
  });
}
