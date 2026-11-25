#!/usr/bin/env node
import { getBridgeAuthHeaders } from './auth.mjs';

const BASE = process.env.BA_BRIDGE_HTTP || 'http://127.0.0.1:19222';

async function main() {
  const [cmd, arg1, arg2] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log([
      'Usage:',
      '  node bridge/cli.mjs health',
      '  node bridge/cli.mjs tools',
      '  node bridge/cli.mjs tabs',
      '  node bridge/cli.mjs macros',
      '  node bridge/cli.mjs call <toolName> [jsonArgs]',
      '  node bridge/cli.mjs task "<prompt>"',
      '  node bridge/cli.mjs save-settings \'<jsonSettings>\''
    ].join('\n'));
    process.exit(0);
  }

  const authHeaders = getBridgeAuthHeaders();

  if (cmd === 'health') {
    const res = await fetch(`${BASE}/health`, { headers: authHeaders });
    console.log(await res.text());
    return;
  }

  if (cmd === 'tools' || cmd === 'tabs' || cmd === 'macros') {
    const res = await fetch(`${BASE}/${cmd}`, { headers: authHeaders });
    console.log(await res.text());
    return;
  }

  if (cmd === 'call') {
    if (!arg1) throw new Error('Missing tool name');
    const args = arg2 ? JSON.parse(arg2) : {};
    const res = await fetch(`${BASE}/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders },
      body: JSON.stringify({ tool: arg1, args })
    });
    const text = await res.text();
    console.log(text);
    const parsed = JSON.parse(text);
    if (parsed.ok === false) process.exit(1);
    return;
  }

  if (cmd === 'task') {
    if (!arg1) throw new Error('Missing prompt');
    const res = await fetch(`${BASE}/task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders },
      body: JSON.stringify({ prompt: arg1 })
    });
    console.log(await res.text());
    return;
  }

  if (cmd === 'save-settings') {
    if (!arg1) throw new Error('Missing JSON settings');
    const settings = JSON.parse(arg1);
    const res = await fetch(`${BASE}/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders },
      body: JSON.stringify({ settings })
    });
    console.log(await res.text());
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
