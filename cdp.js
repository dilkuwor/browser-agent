// Chrome DevTools Protocol (chrome.debugger) manager for trusted input,
// console logs, network inspection (with bodies), and accessibility tree extraction.

const attachedTabs = new Set();
const consoleLogsByTab = new Map();
const networkByTab = new Map();

const MAX_CONSOLE = 120;
const MAX_NETWORK = 150;
const MAX_BODY_CHARS = 4096;

function pushBounded(map, tabId, item, max) {
  let list = map.get(tabId);
  if (!list) {
    list = [];
    map.set(tabId, list);
  }
  list.push(item);
  if (list.length > max) list.shift();
}

function shouldCaptureBody(mimeType = '', type = '') {
  const mime = String(mimeType).toLowerCase();
  if (/json|text|xml|javascript|form-urlencoded|graphql/.test(mime)) return true;
  return type === 'XHR' || type === 'Fetch';
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!tabId) return;

  if (method === 'Runtime.consoleAPICalled') {
    const text = (params.args || [])
      .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type))
      .join(' ');
    pushBounded(consoleLogsByTab, tabId, {
      ts: Date.now(),
      level: params.type || 'log',
      text: text.slice(0, 500)
    }, MAX_CONSOLE);
  } else if (method === 'Runtime.exceptionThrown') {
    const ex = params.exceptionDetails || {};
    const msg = ex.exception?.description || ex.text || 'Uncaught exception';
    pushBounded(consoleLogsByTab, tabId, {
      ts: Date.now(),
      level: 'error',
      text: msg.slice(0, 500)
    }, MAX_CONSOLE);
  } else if (method === 'Log.entryAdded') {
    const entry = params.entry || {};
    pushBounded(consoleLogsByTab, tabId, {
      ts: Date.now(),
      level: entry.level || 'info',
      text: `[${entry.source || 'browser'}] ${(entry.text || '').slice(0, 500)}`
    }, MAX_CONSOLE);
  } else if (method === 'Network.requestWillBeSent') {
    pushBounded(networkByTab, tabId, {
      requestId: params.requestId,
      ts: Date.now(),
      url: params.request?.url || '',
      method: params.request?.method || 'GET',
      type: params.type || 'Other',
      postData: params.request?.postData ? String(params.request.postData).slice(0, MAX_BODY_CHARS) : undefined,
      status: null,
      error: null
    }, MAX_NETWORK);
  } else if (method === 'Network.responseReceived') {
    const list = networkByTab.get(tabId) || [];
    const req = list.findLast((r) => r.requestId === params.requestId);
    if (req) {
      req.status = params.response?.status ?? null;
      req.mimeType = params.response?.mimeType || undefined;
    }
  } else if (method === 'Network.loadingFinished') {
    const list = networkByTab.get(tabId) || [];
    const req = list.findLast((r) => r.requestId === params.requestId);
    if (req && shouldCaptureBody(req.mimeType, req.type)) {
      chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', { requestId: params.requestId })
        .then((res) => {
          if (res?.body && !res.base64Encoded) {
            req.responseBody = String(res.body).slice(0, MAX_BODY_CHARS);
            if (res.body.length > MAX_BODY_CHARS) req.bodyTruncated = true;
          }
        })
        .catch(() => {});
    }
  } else if (method === 'Network.loadingFailed') {
    const list = networkByTab.get(tabId) || [];
    const req = list.findLast((r) => r.requestId === params.requestId);
    if (req) {
      req.error = params.errorText || 'Failed';
    }
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    attachedTabs.delete(source.tabId);
  }
});

chrome.tabs?.onRemoved?.addListener((tabId) => {
  attachedTabs.delete(tabId);
  consoleLogsByTab.delete(tabId);
  networkByTab.delete(tabId);
});

export function isAttached(tabId) {
  return attachedTabs.has(tabId);
}

export async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (err) {
    if (!String(err?.message || err).includes('Another debugger is already attached')) {
      throw err;
    }
  }
  attachedTabs.add(tabId);
  await Promise.allSettled([
    chrome.debugger.sendCommand({ tabId }, 'Runtime.enable'),
    chrome.debugger.sendCommand({ tabId }, 'Log.enable'),
    chrome.debugger.sendCommand({ tabId }, 'Network.enable')
  ]);
}

export async function detachTab(tabId) {
  if (!attachedTabs.has(tabId)) {
    return { ok: true, detached: false };
  }
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Already detached
  }
  attachedTabs.delete(tabId);
  return { ok: true, detached: true };
}

export async function sendCdp(tabId, method, params = {}) {
  await ensureAttached(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

export async function clickAt(tabId, x, y, { button = 'left', clickCount = 1 } = {}) {
  await sendCdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y
  });
  for (let i = 1; i <= clickCount; i++) {
    await sendCdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      clickCount: i
    });
    await sendCdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      clickCount: i
    });
  }
}

export async function hoverAt(tabId, x, y) {
  await sendCdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y
  });
}

export async function typeText(tabId, text) {
  await sendCdp(tabId, 'Input.insertText', { text: String(text) });
}

export async function dragAndDrop(tabId, fromX, fromY, toX, toY, { steps = 12, button = 'left' } = {}) {
  const count = Math.max(2, Number(steps) || 12);
  const btnMask = button === 'left' ? 1 : 2;
  await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: fromX, y: fromY });
  await sendCdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: fromX,
    y: fromY,
    button,
    buttons: btnMask,
    clickCount: 1
  });
  for (let i = 1; i <= count; i++) {
    const ratio = i / count;
    const x = Math.round(fromX + (toX - fromX) * ratio);
    const y = Math.round(fromY + (toY - fromY) * ratio);
    await sendCdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button,
      buttons: btnMask
    });
    await new Promise((r) => setTimeout(r, 15));
  }
  await sendCdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: toX,
    y: toY,
    button,
    buttons: 0,
    clickCount: 1
  });
}

/**
 * Populate an <input type="file"> element with local file paths using CDP DOM.setFileInputFiles.
 */
export async function setFileInputFiles(tabId, { selector, files = [], frameId = null }) {
  const fileList = (Array.isArray(files) ? files : [files]).map((f) => String(f)).filter(Boolean);
  if (fileList.length === 0) throw new Error('Provide at least one local file path in files[].');

  await sendCdp(tabId, 'DOM.enable');
  const doc = await sendCdp(tabId, 'DOM.getDocument', { depth: -1, pierce: true });
  let nodeId = 0;

  if (selector) {
    const found = await sendCdp(tabId, 'DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector
    }).catch(() => null);
    nodeId = found?.nodeId || 0;

    if (!nodeId) {
      const evalRes = await sendCdp(tabId, 'Runtime.evaluate', {
        expression: `(() => {
          const sel = ${JSON.stringify(selector)};
          function search(root) {
            const direct = root.querySelector(sel);
            if (direct) return direct;
            for (const el of root.querySelectorAll('*')) {
              if (el.shadowRoot) {
                const hit = search(el.shadowRoot);
                if (hit) return hit;
              }
            }
            return null;
          }
          return search(document);
        })()`,
        returnByValue: false
      });
      if (evalRes?.result?.objectId) {
        const req = await sendCdp(tabId, 'DOM.requestNode', { objectId: evalRes.result.objectId });
        nodeId = req?.nodeId || 0;
      }
    }

    if (!nodeId && frameId) {
      // Search inside child iframe execution context if available
      const tree = await sendCdp(tabId, 'Page.getFrameTree').catch(() => null);
      const findFrame = (node) => {
        if (!node) return [];
        const out = node.frame?.parentId ? [node.frame.id] : [];
        for (const ch of node.childFrames || []) out.push(...findFrame(ch));
        return out;
      };
      for (const cdpFrameId of findFrame(tree?.frameTree)) {
        const world = await sendCdp(tabId, 'Page.createIsolatedWorld', {
          frameId: cdpFrameId,
          grantUniveralAccess: true
        }).catch(() => null);
        if (!world?.executionContextId) continue;
        const evalRes = await sendCdp(tabId, 'Runtime.evaluate', {
          contextId: world.executionContextId,
          expression: `document.querySelector(${JSON.stringify(selector)})`,
          returnByValue: false
        }).catch(() => null);
        if (evalRes?.result?.objectId) {
          const req = await sendCdp(tabId, 'DOM.requestNode', { objectId: evalRes.result.objectId });
          if (req?.nodeId) {
            nodeId = req.nodeId;
            break;
          }
        }
      }
    }
  }

  if (!nodeId) {
    throw new Error(`File input element not found for selector "${selector || ''}".`);
  }
  await sendCdp(tabId, 'DOM.setFileInputFiles', { nodeId, files: fileList });
  return { ok: true, count: fileList.length };
}

export async function getCookies(tabId, urls = null) {
  await ensureAttached(tabId);
  const res = await sendCdp(tabId, 'Network.getCookies', urls ? { urls } : {});
  return res?.cookies || [];
}

const KEY_MAP = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Esc: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  Insert: { key: 'Insert', code: 'Insert', windowsVirtualKeyCode: 45 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 },
  ' ': { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 }
};

for (let n = 1; n <= 12; n++) {
  KEY_MAP[`F${n}`] = { key: `F${n}`, code: `F${n}`, windowsVirtualKeyCode: 111 + n };
}

const MODIFIER_BITS = {
  alt: 1,
  option: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  super: 4,
  shift: 8
};

export function parseKeyChord(keyInput, explicitModifiers = []) {
  const parts = String(keyInput || 'Enter').split('+').map((s) => s.trim()).filter(Boolean);
  let modMask = 0;
  if (typeof explicitModifiers === 'number') {
    modMask = explicitModifiers;
  } else if (Array.isArray(explicitModifiers)) {
    for (const m of explicitModifiers) {
      modMask |= MODIFIER_BITS[String(m).toLowerCase()] || 0;
    }
  }
  let baseKey = parts[parts.length - 1] || 'Enter';
  for (let i = 0; i < parts.length - 1; i++) {
    const bit = MODIFIER_BITS[parts[i].toLowerCase()];
    if (bit) modMask |= bit;
  }

  const mapped = KEY_MAP[baseKey] || {
    key: baseKey,
    code: /^[a-z]$/i.test(baseKey)
      ? `Key${baseKey.toUpperCase()}`
      : (/^[0-9]$/.test(baseKey) ? `Digit${baseKey}` : baseKey),
    windowsVirtualKeyCode: baseKey.length === 1 ? baseKey.toUpperCase().charCodeAt(0) : 0
  };
  return { mapped, modifiers: modMask };
}

export async function pressKey(tabId, keyName, explicitModifiers = 0) {
  const { mapped, modifiers } = parseKeyChord(keyName, explicitModifiers);
  const isPrintable = mapped.key.length === 1 && (modifiers & (1 | 2 | 4)) === 0;
  await sendCdp(tabId, 'Input.dispatchKeyEvent', {
    type: isPrintable ? 'keyDown' : 'rawKeyDown',
    modifiers,
    ...(isPrintable ? { text: mapped.key } : {}),
    ...mapped
  });
  await sendCdp(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    modifiers,
    ...mapped
  });
}

export async function getAccessibilityTree(tabId, maxNodes = 120) {
  const res = await sendCdp(tabId, 'Accessibility.getFullAXTree');
  const nodes = (res?.nodes || [])
    .filter((n) => !n.ignored && n.role?.value && n.role.value !== 'none' && n.role.value !== 'generic')
    .slice(0, maxNodes)
    .map((n) => ({
      role: n.role?.value,
      name: n.name?.value || '',
      value: n.value?.value
    }));
  return nodes;
}

export async function getFrameBoxes(tabId) {
  await Promise.allSettled([
    sendCdp(tabId, 'Page.enable'),
    sendCdp(tabId, 'DOM.enable')
  ]);
  await sendCdp(tabId, 'DOM.getDocument', { depth: 0 }).catch(() => {});
  const treeRes = await sendCdp(tabId, 'Page.getFrameTree');
  const results = [];

  async function walk(node, parentX, parentY) {
    const f = node?.frame;
    if (!f) return;
    let ox = parentX;
    let oy = parentY;
    if (f.parentId) {
      try {
        const owner = await sendCdp(tabId, 'DOM.getFrameOwner', { frameId: f.id });
        if (owner?.backendNodeId) {
          const box = await sendCdp(tabId, 'DOM.getBoxModel', { backendNodeId: owner.backendNodeId });
          const contentQuad = box?.model?.content;
          if (Array.isArray(contentQuad) && contentQuad.length >= 2) {
            ox = Math.round(contentQuad[0]);
            oy = Math.round(contentQuad[1]);
          }
        }
      } catch {
        // Frame may have navigated or be detached
      }
      results.push({
        cdpFrameId: f.id,
        url: f.url || '',
        name: f.name || '',
        offsetX: ox,
        offsetY: oy
      });
    }
    for (const child of node.childFrames || []) {
      await walk(child, ox, oy);
    }
  }

  await walk(treeRes?.frameTree, 0, 0);
  return results;
}

export function getConsoleLogs(tabId, limit = 50) {
  const list = consoleLogsByTab.get(tabId) || [];
  return list.slice(-limit);
}

export function getNetworkRequests(tabId, { limit = 50, onlyErrors = false } = {}) {
  let list = networkByTab.get(tabId) || [];
  if (onlyErrors) {
    list = list.filter((r) => r.error || (r.status !== null && r.status >= 400));
  }
  return list.slice(-limit).map((r) => ({
    requestId: r.requestId,
    ts: r.ts,
    url: r.url,
    method: r.method,
    type: r.type,
    status: r.status,
    mimeType: r.mimeType,
    error: r.error,
    hasBody: Boolean(r.responseBody || r.postData)
  }));
}

export function getNetworkDetail(tabId, requestId) {
  const list = networkByTab.get(tabId) || [];
  const req = list.find((r) => r.requestId === requestId);
  return req ? { ...req } : null;
}
