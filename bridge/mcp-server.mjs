#!/usr/bin/env node
// Zero-dependency stdio MCP server exposing Browser Agent tools (with native image blocks & run_task) and resources.
import readline from 'node:readline';
import { getBridgeAuthHeaders } from './auth.mjs';

const BASE = process.env.BA_BRIDGE_HTTP || 'http://127.0.0.1:19222';

const EXTRA_MCP_TOOLS = [
  {
    name: 'run_task',
    description: 'Run an autonomous multi-step browser task using Browser Agent\'s configured LLM loop.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Natural language browser task to execute.' },
        agent: { type: 'string', description: 'Agent label for tab groups & overlays (default "agy").' }
      },
      required: ['prompt']
    }
  }
];

const MCP_RESOURCES = [
  { uri: 'browser://health', name: 'Bridge Health', mimeType: 'application/json', description: 'Extension bridge connection status.' },
  { uri: 'browser://tabs', name: 'Open Chrome Tabs', mimeType: 'application/json', description: 'Currently open tabs and attached status.' },
  { uri: 'browser://macros', name: 'Saved Browser Macros', mimeType: 'application/json', description: 'Saved deterministic zero-LLM macros.' }
];

export function formatMcpToolResult(data) {
  if (!data || typeof data !== 'object') {
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      isError: false
    };
  }
  const { screenshotDataUrl, visionDataUrl, ...rest } = data;
  const imgUrl = screenshotDataUrl || visionDataUrl;
  const content = [{ type: 'text', text: JSON.stringify(rest) }];
  if (typeof imgUrl === 'string' && imgUrl.startsWith('data:image/')) {
    const match = imgUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (match) {
      content.push({
        type: 'image',
        mimeType: match[1],
        data: match[2]
      });
    }
  }
  return {
    content,
    isError: data.ok === false
  };
}

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function fetchJson(pathname, opts = {}) {
  const headers = { ...getBridgeAuthHeaders(), ...(opts.headers || {}) };
  const res = await fetch(`${BASE}${pathname}`, { ...opts, headers });
  return res.json();
}

export async function handleMcpRequest(req) {
  const { id, method, params } = req;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'browser-agent-mcp', version: '1.1.0' }
      }
    };
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method === 'tools/list') {
    const data = await fetchJson('/tools');
    const allTools = [...(data.tools || []), ...EXTRA_MCP_TOOLS];
    const tools = allTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters || { type: 'object', properties: {} }
    }));
    return { jsonrpc: '2.0', id, result: { tools } };
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    const data = name === 'run_task'
      ? await fetchJson('/task', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: args.prompt || '', agent: args.agent || 'agy' })
        })
      : await fetchJson('/call', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tool: name, args })
        });
    return { jsonrpc: '2.0', id, result: formatMcpToolResult(data) };
  }

  if (method === 'resources/list') {
    return { jsonrpc: '2.0', id, result: { resources: MCP_RESOURCES } };
  }

  if (method === 'resources/read') {
    const uri = params?.uri;
    const pathMap = {
      'browser://health': '/health',
      'browser://tabs': '/tabs',
      'browser://macros': '/macros'
    };
    const endpoint = pathMap[uri];
    if (!endpoint) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown resource URI: ${uri}` } };
    }
    const data = await fetchJson(endpoint);
    return {
      jsonrpc: '2.0',
      id,
      result: {
        contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }]
      }
    };
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
    if (req.id === undefined) return; // Notification
    try {
      send(await handleMcpRequest(req));
    } catch (err) {
      send({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: err.message } });
    }
  });
}
