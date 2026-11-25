import * as cdp from './cdp.js';
import { isDomainAllowed, requiresHumanApproval, wrapUntrustedContent } from './safety.js';
import { captureFullPage } from './screenshot.js';

export const TOOL_DEFINITIONS = [
  {
    name: 'observe_page',
    description: 'Inspect the current tab: returns URL, title, viewport scroll info, indexed interactive elements with IDs/coordinates, readable text, and optionally a screenshot or accessibility tree.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', description: 'Target tab ID (defaults to active tab).' },
        includeScreenshot: { type: 'boolean', description: 'Include base64 PNG viewport screenshot.' },
        includeSoM: { type: 'boolean', description: 'Draw numbered [id] Set-of-Marks boxes on screenshot (default true).' },
        includeAxTree: { type: 'boolean', description: 'Include CDP Accessibility tree summary.' }
      }
    }
  },
  {
    name: 'click',
    description: 'Click an interactive element by elementId, CSS selector, or (x, y) viewport coordinates using trusted CDP mouse events.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        elementId: { type: 'integer', description: 'Numeric element ID from observe_page.' },
        selector: { type: 'string', description: 'CSS selector fallback.' },
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        clickCount: { type: 'integer' }
      }
    }
  },
  {
    name: 'hover',
    description: 'Move mouse over an element by elementId, selector, or (x, y).',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        elementId: { type: 'integer' },
        selector: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' }
      }
    }
  },
  {
    name: 'type',
    description: 'Focus an input/textarea by elementId, selector, or (x, y) and type text.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        elementId: { type: 'integer' },
        selector: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        text: { type: 'string' },
        clearFirst: { type: 'boolean', description: 'Clear existing value before typing (default true).' },
        pressEnter: { type: 'boolean', description: 'Press Enter after typing.' }
      },
      required: ['text']
    }
  },
  {
    name: 'press_key',
    description: 'Press a keyboard key or chord (e.g. Enter, Tab, Escape, Control+a, Meta+Enter, Shift+Tab, PageDown).',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        key: { type: 'string' },
        modifiers: { type: 'array', items: { type: 'string' }, description: 'Optional modifier keys: Control, Meta, Alt, Shift.' }
      },
      required: ['key']
    }
  },
  {
    name: 'select_option',
    description: 'Select an option in a <select> dropdown by value or visible text.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        elementId: { type: 'integer' },
        selector: { type: 'string' },
        value: { type: 'string' }
      },
      required: ['value']
    }
  },
  {
    name: 'fill_form',
    description: 'Batch-fill multiple form fields (text inputs, textareas, selects, checkboxes, radios) in a single call, optionally clicking submit at the end.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              elementId: { type: 'integer' },
              selector: { type: 'string' },
              value: { type: 'string', description: 'Text to type (supports {{SECRET_NAME}} Vault placeholders), option value/text for <select>, or "true"/"false" for checkbox/radio.' },
              clearFirst: { type: 'boolean' }
            },
            required: ['value']
          }
        },
        submitElementId: { type: 'integer' },
        submitSelector: { type: 'string' }
      },
      required: ['fields']
    }
  },
  {
    name: 'scroll',
    description: 'Scroll the page or a scrollable container (modal, drawer, sidebar) in a direction or to top/bottom.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        direction: { type: 'string', enum: ['down', 'up', 'left', 'right'] },
        amount: { type: 'integer', description: 'Pixels to scroll (default 500).' },
        elementId: { type: 'integer' },
        selector: { type: 'string' },
        position: { type: 'string', enum: ['top', 'bottom'] }
      }
    }
  },
  {
    name: 'navigate',
    description: 'Navigate a tab to a URL and wait for load completion.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        url: { type: 'string' }
      },
      required: ['url']
    }
  },
  {
    name: 'wait',
    description: 'Wait for a specified duration in milliseconds (max 10000).',
    parameters: {
      type: 'object',
      properties: {
        ms: { type: 'integer' }
      }
    }
  },
  {
    name: 'wait_for',
    description: 'Wait until a CSS selector appears/disappears, page text appears, or URL contains a substring (max 15000ms).',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        selector: { type: 'string' },
        text: { type: 'string' },
        urlIncludes: { type: 'string' },
        hidden: { type: 'boolean', description: 'Wait for selector/text to disappear.' },
        timeoutMs: { type: 'integer' }
      }
    }
  },
  {
    name: 'extract_text',
    description: 'Extract readable text from the page or a specific CSS selector.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        selector: { type: 'string' }
      }
    }
  },
  {
    name: 'screenshot',
    description: 'Capture a PNG screenshot of the visible tab.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        includeAgentOverlay: { type: 'boolean', description: 'Include the working gradient border and virtual cursor in the screenshot (default false).' }
      }
    }
  },
  {
    name: 'full_page_screenshot',
    description: 'Scroll-capture and stitch an entire webpage into a single PNG/JPEG image, optionally saving to Downloads.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        format: { type: 'string', enum: ['png', 'jpeg'] },
        download: { type: 'boolean', description: 'Save stitched screenshot to Downloads folder.' },
        filename: { type: 'string', description: 'Optional filename in Downloads (e.g., full-page.png).' },
        includeAgentOverlay: { type: 'boolean' },
        maxSegments: { type: 'integer', description: 'Max scroll segments to capture (default 25).' }
      }
    }
  },
  {
    name: 'get_console_logs',
    description: 'Get recent console logs and runtime errors from the tab (requires CDP debugger).',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        limit: { type: 'integer' }
      }
    }
  },
  {
    name: 'get_network_requests',
    description: 'Get recent network requests and HTTP/loading errors from the tab.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        limit: { type: 'integer' },
        onlyErrors: { type: 'boolean' }
      }
    }
  },
  {
    name: 'get_network_detail',
    description: 'Get full request postData and response body for a captured network requestId.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        requestId: { type: 'string' }
      },
      required: ['requestId']
    }
  },
  {
    name: 'detach_debugger',
    description: 'Detach the Chrome DevTools debugger from a tab to clear the debugging infobar.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' }
      }
    }
  },
  {
    name: 'ask_user',
    description: 'Pause automation and ask the human user to take over (e.g. 2FA, CAPTCHA, manual confirmation) and click Resume.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        reason: { type: 'string' }
      },
      required: ['question']
    }
  },
  {
    name: 'list_tabs',
    description: 'List open browser tabs (with IDs, titles, URLs, and attached group status).',
    parameters: {
      type: 'object',
      properties: {
        onlyAttached: { type: 'boolean' }
      }
    }
  },
  {
    name: 'open_tab',
    description: 'Open a new tab to a URL and automatically group it under the active agent tab group (e.g., "agy" or "claude").',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        active: { type: 'boolean' },
        group: { type: 'boolean', description: 'Group the new tab under the agent tab group (default true).' },
        groupTitle: { type: 'string', description: 'Optional custom tab group title.' },
        groupColor: { type: 'string', enum: ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'] }
      },
      required: ['url']
    }
  },
  {
    name: 'group_tabs',
    description: 'Group one or more tabs into a named Chrome tab group (defaults to the active agent group, e.g., "agy").',
    parameters: {
      type: 'object',
      properties: {
        tabIds: { type: 'array', items: { type: 'integer' }, description: 'Tab IDs to group (defaults to active tab).' },
        title: { type: 'string', description: 'Tab group title (defaults to active agent name).' },
        color: { type: 'string', enum: ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'] }
      }
    }
  },
  {
    name: 'ungroup_tabs',
    description: 'Remove one or more tabs from their Chrome tab group.',
    parameters: {
      type: 'object',
      properties: {
        tabIds: { type: 'array', items: { type: 'integer' } }
      },
      required: ['tabIds']
    }
  },
  {
    name: 'switch_tab',
    description: 'Activate/focus a specific tab by tabId.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' }
      },
      required: ['tabId']
    }
  },
  {
    name: 'close_tab',
    description: 'Close a tab by tabId.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' }
      },
      required: ['tabId']
    }
  },
  {
    name: 'set_working',
    description: 'Show or clear the animated working gradient border and agent cursor on a tab.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        working: { type: 'boolean' }
      },
      required: ['working']
    }
  },
  {
    name: 'list_macros',
    description: 'List saved deterministic browser macros.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'save_macro',
    description: 'Save a sequence of steps (or the last recorded/executed run) as a reusable zero-LLM deterministic macro.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        steps: { type: 'array', items: { type: 'object' } }
      },
      required: ['name']
    }
  },
  {
    name: 'replay_macro',
    description: 'Replay a saved macro deterministically with zero LLM tokens, optionally self-healing with an LLM if any step breaks.',
    parameters: {
      type: 'object',
      properties: {
        macroId: { type: 'string' },
        name: { type: 'string' },
        tabId: { type: 'integer' },
        selfHeal: { type: 'boolean', description: 'Fallback to LLM self-healing if a step fails (default true).' }
      }
    }
  },
  {
    name: 'delete_macro',
    description: 'Delete a saved macro by macroId.',
    parameters: {
      type: 'object',
      properties: {
        macroId: { type: 'string' }
      },
      required: ['macroId']
    }
  },
  {
    name: 'upload_file',
    description: 'Attach local file(s) to an <input type="file"> element via CDP.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        elementId: { type: 'integer' },
        selector: { type: 'string' },
        files: { type: 'array', items: { type: 'string' }, description: 'Local absolute file paths to attach.' }
      },
      required: ['files']
    }
  },
  {
    name: 'list_downloads',
    description: 'List recent Chrome downloads with filename, URL, state, and size.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer' },
        state: { type: 'string', enum: ['in_progress', 'interrupted', 'complete'] },
        query: { type: 'string' }
      }
    }
  },
  {
    name: 'extract_table',
    description: 'Extract an HTML table or ARIA grid (supporting iframes and pagination) to structured JSON and/or CSV.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        selector: { type: 'string' },
        format: { type: 'string', enum: ['json', 'csv', 'both'] },
        maxRows: { type: 'integer' },
        nextPageSelector: { type: 'string', description: 'Optional Next-Page button selector for multi-page table extraction.' },
        maxPages: { type: 'integer', description: 'Max pages to paginate when nextPageSelector is provided (default 1, max 10).' },
        downloadFilename: { type: 'string', description: 'Optional filename in Downloads (e.g., table.csv or table.json).' }
      }
    }
  },
  {
    name: 'drag_and_drop',
    description: 'Drag from a source element/coordinates to a target element/coordinates.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        fromElementId: { type: 'integer' },
        fromSelector: { type: 'string' },
        fromX: { type: 'number' },
        fromY: { type: 'number' },
        toElementId: { type: 'integer' },
        toSelector: { type: 'string' },
        toX: { type: 'number' },
        toY: { type: 'number' },
        steps: { type: 'integer' }
      }
    }
  },
  {
    name: 'inspect_storage',
    description: 'Inspect page cookies (via CDP) plus localStorage and sessionStorage.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer' },
        includeCookies: { type: 'boolean' },
        includeLocalStorage: { type: 'boolean' },
        includeSessionStorage: { type: 'boolean' }
      }
    }
  },
  {
    name: 'export_script',
    description: 'Convert a saved macro or the last run into a Playwright (.spec.ts) or Puppeteer (.mjs) script.',
    parameters: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['playwright', 'puppeteer'] },
        macroId: { type: 'string' },
        name: { type: 'string' },
        download: { type: 'boolean', description: 'Save exported file to Chrome Downloads folder.' }
      }
    }
  }
];

const globalElementIndex = new Map();
const frameOffsetsByTab = new Map();
const lastObservedElementsByTab = new Map();

async function resolveTab(tabId) {
  if (tabId != null) {
    return chrome.tabs.get(Number(tabId));
  }
  const queries = [
    { active: true, lastFocusedWindow: true, windowType: 'normal' },
    { active: true, windowType: 'normal' },
    { active: true, lastFocusedWindow: true }
  ];
  for (const q of queries) {
    const [active] = await chrome.tabs.query(q);
    if (active) return active;
  }
  throw new Error('No active browser tab found');
}

async function sendToContent(tabId, payload, frameId = 0) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload, { frameId });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['content.js'] });
    return await chrome.tabs.sendMessage(tabId, payload, { frameId });
  }
}

async function collectAllFrameObservations(tabId) {
  let frames = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => (window.__baObserveFrame ? window.__baObserveFrame() : null)
  });
  if (frames.some((f) => f.result === null)) {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content.js']
    }).catch(() => {});
    frames = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => (window.__baObserveFrame ? window.__baObserveFrame() : null)
    });
  }
  return frames.filter((f) => f.result && f.result.ok);
}

async function resolveElementAcrossFrames(tabId, { elementId, selector }) {
  const tabMap = globalElementIndex.get(tabId);
  if (elementId != null && tabMap?.has(Number(elementId))) {
    const entry = tabMap.get(Number(elementId));
    const resolved = await sendToContent(tabId, {
      type: 'BA_RESOLVE_ELEMENT',
      elementId: entry.localId,
      selector
    }, entry.frameId);
    if (!resolved?.ok) return resolved || { ok: false, error: 'Element not found' };
    const meta = {
      ...resolved.meta,
      frameId: entry.frameId,
      rect: {
        ...resolved.meta.rect,
        x: resolved.meta.rect.x + entry.offsetX,
        y: resolved.meta.rect.y + entry.offsetY,
        cx: resolved.meta.rect.cx + entry.offsetX,
        cy: resolved.meta.rect.cy + entry.offsetY
      }
    };
    return { ok: true, frameId: entry.frameId, localId: entry.localId, offsetX: entry.offsetX, offsetY: entry.offsetY, meta };
  }

  const candidateFrames = [{ frameId: 0, offsetX: 0, offsetY: 0 }, ...(frameOffsetsByTab.get(tabId) || [])];
  for (const fr of candidateFrames) {
    try {
      const resolved = await sendToContent(tabId, {
        type: 'BA_RESOLVE_ELEMENT',
        elementId: fr.frameId === 0 ? elementId : null,
        selector
      }, fr.frameId);
      if (resolved?.ok) {
        const meta = {
          ...resolved.meta,
          frameId: fr.frameId,
          rect: {
            ...resolved.meta.rect,
            x: resolved.meta.rect.x + fr.offsetX,
            y: resolved.meta.rect.y + fr.offsetY,
            cx: resolved.meta.rect.cx + fr.offsetX,
            cy: resolved.meta.rect.cy + fr.offsetY
          }
        };
        return { ok: true, frameId: fr.frameId, localId: null, offsetX: fr.offsetX, offsetY: fr.offsetY, meta };
      }
    } catch {
      // Frame may not exist anymore
    }
  }
  return { ok: false, error: 'Element not found on page or frames' };
}

async function notifyWorking(tabId, context = {}, { working = true } = {}) {
  try {
    if (working && context.touchedTabIds) {
      context.touchedTabIds.add(tabId);
    }
    const ttlMs = working ? (context.persistentWorking ? 0 : 8000) : 0;
    await sendToContent(tabId, {
      type: 'BA_SET_WORKING',
      working,
      agentName: context.agentName || 'agy',
      ttlMs
    });
  } catch {
    // Ignore on pages where scripts cannot run
  }
}

async function moveAgentCursor(tabId, x, y, action, context = {}, glideMs = 220) {
  try {
    await sendToContent(tabId, {
      type: 'BA_MOVE_CURSOR',
      x,
      y,
      action,
      agentName: context.agentName || 'agy'
    }, 0);
    // Allow brief glide time so the cursor visually reaches the target before the CDP action fires
    if (glideMs > 0) {
      await new Promise((r) => setTimeout(r, glideMs));
    }
  } catch {
    // Ignore if overlay fails
  }
}

export async function clearWorkingState(tabIds = [], agentName = 'agy') {
  await Promise.allSettled(
    Array.from(tabIds).map((tabId) =>
      chrome.tabs.sendMessage(tabId, {
        type: 'BA_SET_WORKING',
        working: false,
        agentName,
        ttlMs: 0
      })
    )
  );
}

function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function waitBrieflyForNavigation(tabId) {
  await new Promise((r) => setTimeout(r, 140));
  try {
    const t = await chrome.tabs.get(tabId);
    if (t?.status === 'loading') {
      await waitForTabLoad(tabId, 5000);
    }
  } catch {
    // Tab may have closed
  }
}

function buildSecretLookup(secrets) {
  const map = new Map();
  if (!secrets) return map;
  if (Array.isArray(secrets)) {
    for (const item of secrets) {
      const name = String(item?.name || '').trim();
      if (name && item.value != null) map.set(name, String(item.value));
    }
  } else if (typeof secrets === 'object') {
    for (const [k, v] of Object.entries(secrets)) {
      const name = String(k || '').trim();
      if (name && v != null) map.set(name, String(v));
    }
  }
  return map;
}

/**
 * Resolve {{SECRET_NAME}} placeholders from the local Secrets Vault right before typing.
 * Never returns resolved values in tool outputs or logs.
 */
export function resolveSecretPlaceholders(text, secrets) {
  const raw = String(text ?? '');
  const map = buildSecretLookup(secrets);
  const used = [];
  const missing = [];
  const resolved = raw.replace(/\{\{([A-Za-z0-9_.-]+)\}\}/g, (match, name) => {
    if (map.has(name)) {
      used.push(name);
      return map.get(name);
    }
    const upper = name.toUpperCase();
    if (map.has(upper)) {
      used.push(upper);
      return map.get(upper);
    }
    if (/^[A-Z][A-Z0-9_]{1,}$/.test(name)) {
      missing.push(name);
    }
    return match;
  });
  return { raw, resolved, used: [...new Set(used)], missing: [...new Set(missing)] };
}

const AGENT_GROUP_COLORS = {
  agy: 'cyan',
  claude: 'orange',
  gemini: 'blue',
  openai: 'green',
  openrouter: 'purple',
  ollama: 'green',
  custom: 'teal'
};

function resolveAgentGroup(context = {}, args = {}) {
  const agent = (context.agentName || '').toLowerCase();
  const title = args.groupTitle || args.title || agent || 'browser-agent';
  const color = args.groupColor || args.color || AGENT_GROUP_COLORS[title.toLowerCase()] || 'purple';
  return { title, color };
}

async function addTabsToGroup(tabIds, windowId, { title, color, attachedTabIds }) {
  if (!tabIds.length) return null;
  const existingGroups = await chrome.tabGroups.query({ windowId, title });
  let groupId;
  if (existingGroups.length > 0) {
    groupId = existingGroups[0].id;
    await chrome.tabs.group({ groupId, tabIds });
  } else {
    groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
    await chrome.tabGroups.update(groupId, { title, color });
  }
  if (attachedTabIds) {
    for (const id of tabIds) attachedTabIds.add(id);
  }
  return groupId;
}

export async function executeTool(toolName, args = {}, context = {}) {
  const {
    settings = {},
    requestApproval = null,
    requestHandoff = null,
    attachedTabIds = new Set(),
    skipSafety = false,
    macroHandler = null
  } = context;

  if (toolName === 'ask_user') {
    if (!requestHandoff) {
      return { ok: false, error: 'Human handoff UI is unavailable in this execution context.' };
    }
    const resp = await requestHandoff({
      question: String(args.question || 'Please complete this step manually on the page and click Resume.'),
      reason: args.reason ? String(args.reason) : 'Manual user action requested'
    });
    if (!resp || resp.resumed === false) {
      return { ok: false, error: 'Task cancelled during human handoff.' };
    }
    return {
      ok: true,
      resumed: true,
      ...(resp.note ? { userNote: resp.note } : {})
    };
  }

  if (toolName === 'list_macros' || toolName === 'save_macro' || toolName === 'replay_macro' || toolName === 'delete_macro' || toolName === 'export_script') {
    if (!macroHandler) return { ok: false, error: 'Macro handler not available.' };
    return await macroHandler(toolName, args);
  }

  if (toolName === 'list_downloads') {
    const q = {
      limit: Math.max(1, Math.min(50, Number(args.limit) || 20)),
      orderBy: ['-startTime']
    };
    if (args.state) q.state = args.state;
    if (args.query) q.query = [String(args.query)];
    const items = await chrome.downloads.search(q);
    return {
      ok: true,
      downloads: items.map((d) => ({
        id: d.id,
        filename: d.filename,
        url: d.url,
        state: d.state,
        mime: d.mime,
        bytesReceived: d.bytesReceived,
        totalBytes: d.totalBytes,
        startTime: d.startTime,
        exists: d.exists
      }))
    };
  }

  // Tab management tools that don't require a target page domain check first
  if (toolName === 'list_tabs') {
    const tabs = await chrome.tabs.query({});
    const mapped = tabs
      .filter((t) => !args.onlyAttached || attachedTabIds.has(t.id))
      .map((t) => ({
        tabId: t.id,
        title: t.title,
        url: t.url,
        active: t.active,
        groupId: t.groupId,
        attached: attachedTabIds.has(t.id)
      }));
    return { ok: true, tabs: mapped };
  }

  if (toolName === 'open_tab') {
    const check = isDomainAllowed(args.url, settings);
    if (!check.allowed) return { ok: false, error: check.reason };
    const tab = await chrome.tabs.create({ url: args.url, active: args.active !== false });
    let groupId = null;
    let groupTitle = null;
    if (args.group !== false) {
      const grp = resolveAgentGroup(context, args);
      groupTitle = grp.title;
      try {
        groupId = await addTabsToGroup([tab.id], tab.windowId, {
          title: grp.title,
          color: grp.color,
          attachedTabIds
        });
      } catch {
        // Ignore if window type doesn't support tab groups
      }
    }
    await waitForTabLoad(tab.id, 10000);
    await notifyWorking(tab.id, context, { working: true });
    return { ok: true, tabId: tab.id, url: tab.url, title: tab.title, groupId, groupTitle };
  }

  if (toolName === 'group_tabs') {
    let tabIds = (args.tabIds || []).map(Number).filter(Boolean);
    let windowId;
    if (tabIds.length === 0) {
      const active = await resolveTab(null);
      tabIds = [active.id];
      windowId = active.windowId;
    } else {
      const first = await chrome.tabs.get(tabIds[0]);
      windowId = first.windowId;
    }
    const grp = resolveAgentGroup(context, args);
    const groupId = await addTabsToGroup(tabIds, windowId, {
      title: grp.title,
      color: grp.color,
      attachedTabIds
    });
    return { ok: true, groupId, groupTitle: grp.title, tabIds };
  }

  if (toolName === 'ungroup_tabs') {
    const tabIds = (args.tabIds || []).map(Number).filter(Boolean);
    if (tabIds.length === 0) return { ok: false, error: 'No tabIds provided.' };
    await chrome.tabs.ungroup(tabIds);
    return { ok: true, ungroupedTabIds: tabIds };
  }

  if (toolName === 'switch_tab') {
    const tab = await chrome.tabs.update(Number(args.tabId), { active: true });
    return { ok: true, tabId: tab.id, url: tab.url, title: tab.title };
  }

  if (toolName === 'close_tab') {
    await chrome.tabs.remove(Number(args.tabId));
    return { ok: true, closedTabId: Number(args.tabId) };
  }

  if (toolName === 'wait') {
    const ms = Math.min(Math.max(Number(args.ms) || 500, 50), 10000);
    await new Promise((r) => setTimeout(r, ms));
    return { ok: true, waitedMs: ms };
  }

  if (toolName === 'set_working') {
    const targetTab = await resolveTab(args.tabId);
    await notifyWorking(targetTab.id, context, { working: Boolean(args.working) });
    return { ok: true, tabId: targetTab.id, working: Boolean(args.working) };
  }

  const tab = await resolveTab(args.tabId);
  const tabId = tab.id;

  if (toolName === 'navigate') {
    const check = isDomainAllowed(args.url, settings);
    if (!check.allowed) return { ok: false, error: check.reason };
    await chrome.tabs.update(tabId, { url: args.url });
    await waitForTabLoad(tabId, 15000);
    await notifyWorking(tabId, context, { working: true });
    const updated = await chrome.tabs.get(tabId);
    return { ok: true, tabId, url: updated.url, title: updated.title };
  }

  // All remaining tools operate on the current tab URL
  const domainCheck = isDomainAllowed(tab.url, settings);
  if (!domainCheck.allowed) {
    return { ok: false, error: domainCheck.reason };
  }

  if (toolName === 'detach_debugger') {
    const res = await cdp.detachTab(tabId);
    return { ok: true, tabId, ...res };
  }

  if (toolName === 'screenshot') {
    await chrome.tabs.update(tabId, { active: true });
    if (!args.includeAgentOverlay) {
      await sendToContent(tabId, { type: 'BA_SET_UI_HIDDEN', hidden: true }, 0).catch(() => {});
    }
    const somEls = args.includeSoM ? (lastObservedElementsByTab.get(tabId) || []) : [];
    if (somEls.length > 0) {
      await sendToContent(tabId, { type: 'BA_SHOW_SOM', elements: somEls }, 0).catch(() => {});
    }
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      return { ok: true, tabId, screenshotDataUrl: dataUrl, somAnnotated: somEls.length > 0 };
    } finally {
      if (somEls.length > 0) {
        await sendToContent(tabId, { type: 'BA_HIDE_SOM' }, 0).catch(() => {});
      }
      if (!args.includeAgentOverlay) {
        await sendToContent(tabId, { type: 'BA_SET_UI_HIDDEN', hidden: false }, 0).catch(() => {});
      }
    }
  }

  if (toolName === 'full_page_screenshot') {
    const fmt = args.format === 'jpeg' ? 'jpeg' : 'png';
    const captured = await captureFullPage({
      tab,
      sendToContent,
      includeAgentOverlay: Boolean(args.includeAgentOverlay),
      format: fmt,
      maxSegments: Math.max(1, Math.min(50, Number(args.maxSegments) || 25))
    });
    if (args.download || args.filename) {
      const ext = fmt === 'jpeg' ? 'jpg' : 'png';
      const defaultName = `full-page-${Date.now()}.${ext}`;
      const safeName = String(args.filename || defaultName).split(/[/\\]/).pop().replace(/[^a-zA-Z0-9._-]/g, '_') || defaultName;
      captured.downloadId = await chrome.downloads.download({
        url: captured.screenshotDataUrl,
        filename: safeName,
        saveAs: false
      });
      captured.savedFilename = safeName;
    }
    return captured;
  }

  await notifyWorking(tabId, context, { working: true });

  if (toolName === 'get_console_logs') {
    await cdp.ensureAttached(tabId);
    return { ok: true, tabId, logs: cdp.getConsoleLogs(tabId, args.limit || 50) };
  }

  if (toolName === 'get_network_requests') {
    await cdp.ensureAttached(tabId);
    return {
      ok: true,
      tabId,
      requests: cdp.getNetworkRequests(tabId, {
        limit: args.limit || 50,
        onlyErrors: Boolean(args.onlyErrors)
      })
    };
  }

  if (toolName === 'get_network_detail') {
    await cdp.ensureAttached(tabId);
    const detail = cdp.getNetworkDetail(tabId, args.requestId);
    if (!detail) return { ok: false, error: `Network request not found: ${args.requestId}` };
    return { ok: true, tabId, detail };
  }

  if (toolName === 'wait_for') {
    const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 8000, 100), 15000);
    if (args.urlIncludes) {
      const start = Date.now();
      const targetSub = String(args.urlIncludes);
      while (Date.now() - start <= timeoutMs) {
        const cur = await chrome.tabs.get(tabId);
        if (String(cur?.url || '').includes(targetSub)) {
          return { ok: true, tabId, url: cur.url, waitedMs: Date.now() - start };
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      if (!args.selector && !args.text) {
        return { ok: false, error: `Timed out waiting for URL to include "${targetSub}".` };
      }
    }
    if (args.selector || args.text) {
      return await sendToContent(tabId, {
        type: 'BA_WAIT_FOR',
        selector: args.selector,
        text: args.text,
        hidden: Boolean(args.hidden),
        timeoutMs
      });
    }
    return { ok: false, error: 'Provide selector, text, or urlIncludes to wait_for.' };
  }

  if (toolName === 'observe_page') {
    if (args.includeAxTree) {
      await cdp.ensureAttached(tabId);
    }
    const frameResults = await collectAllFrameObservations(tabId);
    const topFrame = frameResults.find((f) => f.frameId === 0)?.result;
    if (!topFrame) return { ok: false, error: 'Failed to observe top frame' };

    const ordered = [...frameResults].sort((a, b) => a.frameId - b.frameId);
    const parentIframeRects = [];
    for (const fr of ordered) {
      for (const ci of fr.result.childIframes || []) {
        parentIframeRects.push({ ...ci, parentFrameId: fr.frameId });
      }
    }

    const needsCdpBoxes = ordered.some(
      (f) => f.frameId !== 0 && !f.result.sameOriginOffset && !parentIframeRects.some((p) => p.src === f.result.url)
    );
    if (needsCdpBoxes) {
      await cdp.ensureAttached(tabId);
    }
    const cdpBoxes = needsCdpBoxes ? await cdp.getFrameBoxes(tabId).catch(() => []) : [];
    const remainingCdpBoxes = [...cdpBoxes];

    const tabIndex = new Map();
    const childFrameOffsets = [];
    const allElements = [];
    const textSections = [topFrame.text];
    let globalId = 1;

    for (const fr of ordered) {
      const obs = fr.result;
      let ox = 0;
      let oy = 0;
      if (fr.frameId !== 0) {
        if (obs.sameOriginOffset) {
          ox = obs.sameOriginOffset.x;
          oy = obs.sameOriginOffset.y;
        } else {
          const domIdx = parentIframeRects.findIndex((p) => p.src && obs.url && p.src === obs.url);
          if (domIdx >= 0) {
            const box = parentIframeRects.splice(domIdx, 1)[0];
            ox = box.x;
            oy = box.y;
          } else {
            const matchIdx = remainingCdpBoxes.findIndex((b) => b.url && obs.url && b.url === obs.url);
            if (matchIdx >= 0) {
              const box = remainingCdpBoxes.splice(matchIdx, 1)[0];
              ox = box.offsetX;
              oy = box.offsetY;
            }
          }
        }
        childFrameOffsets.push({ frameId: fr.frameId, offsetX: ox, offsetY: oy, url: obs.url });
        if (obs.text) {
          textSections.push(`[iframe: ${obs.url}]\n${obs.text}`);
        }
      }

      for (const el of obs.elements || []) {
        if (globalId > 140) break;
        tabIndex.set(globalId, {
          frameId: fr.frameId,
          localId: el.id,
          offsetX: ox,
          offsetY: oy
        });
        allElements.push({
          ...el,
          id: globalId,
          frameId: fr.frameId !== 0 ? fr.frameId : undefined,
          rect: {
            ...el.rect,
            x: el.rect.x + ox,
            y: el.rect.y + oy,
            cx: el.rect.cx + ox,
            cy: el.rect.cy + oy
          }
        });
        globalId++;
      }
    }

    globalElementIndex.set(tabId, tabIndex);
    frameOffsetsByTab.set(tabId, childFrameOffsets);
    lastObservedElementsByTab.set(tabId, allElements);

    const combinedText = textSections.filter(Boolean).join('\n\n');
    const boundedText = combinedText.length > 8000
      ? `${combinedText.slice(0, 8000)}\n...[text truncated; use extract_text for full page text]`
      : combinedText;

    const result = {
      ok: true,
      tabId,
      url: topFrame.url,
      title: topFrame.title,
      viewport: topFrame.viewport,
      framesCount: ordered.length,
      elements: allElements,
      text: wrapUntrustedContent(topFrame.url, boundedText)
    };
    if (args.includeAxTree) {
      result.accessibilityTree = await cdp.getAccessibilityTree(tabId, 60);
    }
    if (args.includeScreenshot) {
      await chrome.tabs.update(tabId, { active: true });
      await sendToContent(tabId, { type: 'BA_SET_UI_HIDDEN', hidden: true }, 0).catch(() => {});
      const useSoM = args.includeSoM !== false && allElements.length > 0;
      if (useSoM) {
        await sendToContent(tabId, { type: 'BA_SHOW_SOM', elements: allElements }, 0).catch(() => {});
      }
      try {
        result.screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        if (useSoM) result.somAnnotated = true;
      } finally {
        if (useSoM) {
          await sendToContent(tabId, { type: 'BA_HIDE_SOM' }, 0).catch(() => {});
        }
        await sendToContent(tabId, { type: 'BA_SET_UI_HIDDEN', hidden: false }, 0).catch(() => {});
      }
    }
    return result;
  }

  if (toolName === 'fill_form') {
    const fields = Array.isArray(args.fields) ? args.fields : [];
    if (fields.length === 0) return { ok: false, error: 'Provide at least one field in fields[].' };

    const resolvedFields = [];
    for (const f of fields) {
      const res = await resolveElementAcrossFrames(tabId, { elementId: f.elementId, selector: f.selector });
      if (!res?.ok) {
        return { ok: false, error: `Field not found (${f.selector || `#${f.elementId}`}): ${res?.error}` };
      }
      resolvedFields.push({ field: f, target: res });
    }

    for (const { field } of resolvedFields) {
      const check = resolveSecretPlaceholders(field.value ?? '', settings.secrets);
      if (check.missing.length > 0) {
        return {
          ok: false,
          error: `Unknown secret placeholder(s): ${check.missing.map((n) => `{{${n}}}`).join(', ')}. Add them in Settings -> Secrets Vault.`
        };
      }
    }

    let submitTarget = null;
    if (args.submitElementId != null || args.submitSelector) {
      const sRes = await resolveElementAcrossFrames(tabId, {
        elementId: args.submitElementId,
        selector: args.submitSelector
      });
      if (!sRes?.ok) return { ok: false, error: `Submit target not found: ${sRes?.error}` };
      submitTarget = sRes;
    }

    if (!skipSafety && requestApproval) {
      const hasPwd = resolvedFields.some(({ target }) => target.meta?.type === 'password');
      if (hasPwd || submitTarget || settings.autoApproveLowRisk === false) {
        const reason = hasPwd
          ? 'Filling form containing password field(s).'
          : submitTarget
            ? `Filling form and clicking "${submitTarget.meta?.label || 'submit'}".`
            : 'Auto-approve is disabled in settings.';
        const approved = await requestApproval({
          toolName: 'fill_form',
          args: { fieldsCount: fields.length, submit: submitTarget?.meta?.label },
          reason
        });
        if (!approved) return { ok: false, error: `Action denied by user: ${reason}` };
      }
    }

    const results = [];
    for (const { field, target } of resolvedFields) {
      const { frameId, localId, meta } = target;
      const cx = meta.rect.cx;
      const cy = meta.rect.cy;
      const secretRes = resolveSecretPlaceholders(field.value ?? '', settings.secrets);
      const valStr = secretRes.resolved;

      if (meta.tag === 'select') {
        await moveAgentCursor(tabId, cx, cy, 'select_option', context, 110);
        const selRes = await sendToContent(tabId, {
          type: 'BA_SELECT_OPTION',
          elementId: localId,
          selector: field.selector || meta.selector,
          value: valStr
        }, frameId);
        if (!selRes?.ok) return { ok: false, error: selRes?.error || 'Failed select_option in fill_form', results };
        results.push({ label: meta.label, tag: meta.tag, ok: true });
      } else if (meta.type === 'checkbox' || meta.type === 'radio') {
        const wantChecked = valStr === 'true' || valStr === '1' || valStr.toLowerCase() === 'on';
        await moveAgentCursor(tabId, cx, cy, 'click', context, 110);
        if (meta.type === 'radio' || Boolean(meta.checked) !== wantChecked) {
          await cdp.clickAt(tabId, cx, cy);
        }
        results.push({ label: meta.label, type: meta.type, checked: wantChecked, ok: true });
      } else {
        await moveAgentCursor(tabId, cx, cy, 'type', context, 110);
        if (field.clearFirst !== false) {
          await sendToContent(tabId, {
            type: 'BA_CLEAR_ELEMENT',
            elementId: localId,
            selector: field.selector || meta.selector
          }, frameId);
        } else {
          await cdp.clickAt(tabId, cx, cy);
        }
        await cdp.typeText(tabId, valStr);
        results.push({
          label: meta.label,
          ...(secretRes.used.length > 0 ? { usedSecrets: secretRes.used, redactedLength: true } : { typedLength: secretRes.raw.length }),
          ok: true
        });
      }
    }

    if (submitTarget) {
      await moveAgentCursor(tabId, submitTarget.meta.rect.cx, submitTarget.meta.rect.cy, 'click', context, 150);
      await cdp.clickAt(tabId, submitTarget.meta.rect.cx, submitTarget.meta.rect.cy);
      await waitBrieflyForNavigation(tabId);
    }

    return { ok: true, tabId, filledCount: results.length, submitted: Boolean(submitTarget), results };
  }

  if (toolName === 'extract_text') {
    const res = await sendToContent(tabId, { type: 'BA_EXTRACT_TEXT', selector: args.selector });
    if (!res?.ok) return res;
    return {
      ok: true,
      tabId,
      url: res.url,
      title: res.title,
      text: wrapUntrustedContent(res.url, res.text)
    };
  }

  if (toolName === 'scroll') {
    let targetSelector = args.selector;
    let targetFrameId = 0;
    let targetLocalId = null;
    if (args.elementId != null) {
      const resolved = await resolveElementAcrossFrames(tabId, { elementId: args.elementId, selector: args.selector });
      if (resolved?.ok) {
        targetFrameId = resolved.frameId;
        targetLocalId = resolved.localId;
        targetSelector = resolved.meta?.selector || targetSelector;
      }
    }
    const scrollRes = await sendToContent(tabId, {
      type: 'BA_SCROLL',
      direction: args.direction || 'down',
      amount: args.amount || 500,
      elementId: targetLocalId,
      selector: targetSelector,
      position: args.position
    }, targetFrameId);
    return scrollRes;
  }

  if (toolName === 'press_key') {
    await cdp.pressKey(tabId, args.key, args.modifiers || 0);
    return { ok: true, tabId, key: args.key, ...(args.modifiers ? { modifiers: args.modifiers } : {}) };
  }

  // Element-targeted tools: click, hover, type, select_option
  let coords = (args.x != null && args.y != null) ? { x: Number(args.x), y: Number(args.y) } : null;
  let elementMeta = null;
  let targetFrameId = 0;
  let targetLocalId = null;

  if (args.elementId != null || args.selector) {
    const resolved = await resolveElementAcrossFrames(tabId, {
      elementId: args.elementId,
      selector: args.selector
    });
    if (!resolved?.ok) return resolved || { ok: false, error: 'Element not found' };
    elementMeta = resolved.meta;
    targetFrameId = resolved.frameId;
    targetLocalId = resolved.localId;
    coords = { x: elementMeta.rect.cx, y: elementMeta.rect.cy };
  }

  if (!skipSafety && requestApproval) {
    const gate = requiresHumanApproval(toolName, args, elementMeta, settings);
    if (gate.required) {
      const approved = await requestApproval({
        toolName,
        args,
        elementMeta,
        reason: gate.reason
      });
      if (!approved) {
        return { ok: false, error: `Action denied by user: ${gate.reason}` };
      }
    }
  }

  if (toolName === 'click') {
    if (!coords) return { ok: false, error: 'Provide elementId, selector, or x/y coordinates.' };
    await moveAgentCursor(tabId, coords.x, coords.y, 'click', context);
    await cdp.clickAt(tabId, coords.x, coords.y, {
      button: args.button || 'left',
      clickCount: args.clickCount || 1
    });
    await waitBrieflyForNavigation(tabId);
    return { ok: true, tabId, clicked: coords, element: elementMeta?.label, selector: elementMeta?.selector };
  }

  if (toolName === 'hover') {
    if (!coords) return { ok: false, error: 'Provide elementId, selector, or x/y coordinates.' };
    await moveAgentCursor(tabId, coords.x, coords.y, 'hover', context);
    await cdp.hoverAt(tabId, coords.x, coords.y);
    return { ok: true, tabId, hovered: coords, selector: elementMeta?.selector };
  }

  if (toolName === 'type') {
    const secretRes = resolveSecretPlaceholders(args.text, settings.secrets);
    if (secretRes.missing.length > 0) {
      return {
        ok: false,
        error: `Unknown secret placeholder(s): ${secretRes.missing.map((n) => `{{${n}}}`).join(', ')}. Add them in Settings -> Secrets Vault.`
      };
    }
    if (coords) {
      await moveAgentCursor(tabId, coords.x, coords.y, 'type', context);
    }
    if (args.clearFirst !== false && (args.elementId != null || args.selector)) {
      await sendToContent(tabId, {
        type: 'BA_CLEAR_ELEMENT',
        elementId: targetLocalId,
        selector: args.selector || elementMeta?.selector
      }, targetFrameId);
    } else if (coords) {
      await cdp.clickAt(tabId, coords.x, coords.y);
    }
    await cdp.typeText(tabId, secretRes.resolved);
    if (args.pressEnter) {
      await cdp.pressKey(tabId, 'Enter');
    }
    return {
      ok: true,
      tabId,
      ...(secretRes.used.length > 0
        ? { usedSecrets: secretRes.used, redactedLength: true }
        : { typedLength: secretRes.raw.length }),
      pressEnter: Boolean(args.pressEnter),
      selector: elementMeta?.selector,
      element: elementMeta?.label
    };
  }

  if (toolName === 'select_option') {
    if (coords) {
      await moveAgentCursor(tabId, coords.x, coords.y, 'select_option', context);
    }
    const selRes = await sendToContent(tabId, {
      type: 'BA_SELECT_OPTION',
      elementId: targetLocalId,
      selector: args.selector || elementMeta?.selector,
      value: args.value
    }, targetFrameId);
    return selRes?.ok ? { ...selRes, selector: elementMeta?.selector } : selRes;
  }

  if (toolName === 'upload_file') {
    const files = Array.isArray(args.files) ? args.files.filter(Boolean) : [];
    if (files.length === 0) return { ok: false, error: 'Provide files[] array of local file paths.' };
    const resolvedSelector = elementMeta?.selector || args.selector;
    if (!resolvedSelector) {
      return { ok: false, error: 'Provide elementId or selector targeting an <input type="file"> element.' };
    }
    if (coords) {
      await moveAgentCursor(tabId, coords.x, coords.y, 'upload_file', context);
    }
    await cdp.setFileInputFiles(tabId, { selector: resolvedSelector, files, frameId: targetFrameId });
    return {
      ok: true,
      tabId,
      selector: resolvedSelector,
      uploadedCount: files.length,
      element: elementMeta?.label
    };
  }

  if (toolName === 'drag_and_drop') {
    let fromCoords = (args.fromX != null && args.fromY != null) ? { x: Number(args.fromX), y: Number(args.fromY) } : null;
    let toCoords = (args.toX != null && args.toY != null) ? { x: Number(args.toX), y: Number(args.toY) } : null;
    let fromSelector = args.fromSelector;
    let toSelector = args.toSelector;

    if (args.fromElementId != null || args.fromSelector) {
      const fRes = await resolveElementAcrossFrames(tabId, { elementId: args.fromElementId, selector: args.fromSelector });
      if (!fRes?.ok) return { ok: false, error: `Drag source not found: ${fRes?.error}` };
      fromCoords = { x: fRes.meta.rect.cx, y: fRes.meta.rect.cy };
      fromSelector = fRes.meta.selector || fromSelector;
    }
    if (args.toElementId != null || args.toSelector) {
      const tRes = await resolveElementAcrossFrames(tabId, { elementId: args.toElementId, selector: args.toSelector });
      if (!tRes?.ok) return { ok: false, error: `Drag target not found: ${tRes?.error}` };
      toCoords = { x: tRes.meta.rect.cx, y: tRes.meta.rect.cy };
      toSelector = tRes.meta.selector || toSelector;
    }
    if (!fromCoords || !toCoords) {
      return { ok: false, error: 'Provide both source (fromElementId/fromSelector/fromX+Y) and target (toElementId/toSelector/toX+Y).' };
    }
    await moveAgentCursor(tabId, fromCoords.x, fromCoords.y, 'drag', context, 140);
    await moveAgentCursor(tabId, toCoords.x, toCoords.y, 'drop', context, 180);
    await cdp.dragAndDrop(tabId, fromCoords.x, fromCoords.y, toCoords.x, toCoords.y, { steps: args.steps || 12 });
    return {
      ok: true,
      tabId,
      from: fromCoords,
      to: toCoords,
      fromSelector,
      toSelector
    };
  }

  if (toolName === 'extract_table') {
    const extractFromFrames = async () => {
      const candidateFrameIds = [0, ...(frameOffsetsByTab.get(tabId) || []).map((f) => f.frameId)];
      let lastErr = null;
      for (const fid of candidateFrameIds) {
        const res = await sendToContent(tabId, {
          type: 'BA_EXTRACT_TABLE',
          selector: args.selector,
          maxRows: args.maxRows || 200
        }, fid).catch(() => null);
        if (res?.ok) return res;
        if (res?.error) lastErr = res;
      }
      return lastErr || { ok: false, error: 'Failed to extract table.' };
    };

    const firstRes = await extractFromFrames();
    if (!firstRes?.ok) return firstRes;

    const allObjects = [...(firstRes.objects || [])];
    const allRows = [...(firstRes.rows || [])];
    const headers = firstRes.headers || [];
    let pagesExtracted = 1;
    const maxPages = args.nextPageSelector ? Math.min(10, Math.max(1, Number(args.maxPages) || 1)) : 1;

    if (maxPages > 1 && args.nextPageSelector) {
      let prevSig = JSON.stringify(firstRes.rows?.[0] || []);
      for (let p = 2; p <= maxPages; p++) {
        const nextBtn = await resolveElementAcrossFrames(tabId, { selector: args.nextPageSelector });
        if (!nextBtn?.ok) break;
        await moveAgentCursor(tabId, nextBtn.meta.rect.cx, nextBtn.meta.rect.cy, 'click', context, 100);
        await cdp.clickAt(tabId, nextBtn.meta.rect.cx, nextBtn.meta.rect.cy);
        await new Promise((r) => setTimeout(r, 650));
        const pageRes = await extractFromFrames();
        if (!pageRes?.ok || !pageRes.rows?.length) break;
        const sig = JSON.stringify(pageRes.rows[0]);
        if (sig === prevSig) break;
        prevSig = sig;
        allRows.push(...pageRes.rows);
        allObjects.push(...(pageRes.objects || []));
        pagesExtracted = p;
      }
    }

    const csvEscape = (v) => {
      const str = String(v ?? '').replace(/\s+/g, ' ').trim();
      return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const combinedCsv = pagesExtracted > 1
      ? [headers.map(csvEscape).join(','), ...allRows.map((row) => row.map(csvEscape).join(','))].join('\n')
      : firstRes.csv;

    const fmt = args.format || 'both';
    let downloadId = null;
    let savedFilename = null;
    if (args.downloadFilename) {
      const safeName = String(args.downloadFilename).split(/[/\\]/).pop().replace(/[^a-zA-Z0-9._-]/g, '_') || 'table.csv';
      const isJson = fmt === 'json' || safeName.toLowerCase().endsWith('.json');
      const content = isJson ? JSON.stringify(allObjects, null, 2) : combinedCsv;
      const mime = isJson ? 'application/json' : 'text/csv';
      const dataUrl = `data:${mime};charset=utf-8,${encodeURIComponent(content)}`;
      downloadId = await chrome.downloads.download({ url: dataUrl, filename: safeName, saveAs: false });
      savedFilename = safeName;
    }

    const out = {
      ok: true,
      tabId,
      url: firstRes.url,
      selector: firstRes.selector,
      headers,
      rowCount: allObjects.length,
      pagesExtracted,
      ...(downloadId != null ? { downloadId, savedFilename } : {})
    };
    if (fmt === 'csv' || fmt === 'both') out.csv = combinedCsv;
    if (fmt === 'json' || fmt === 'both') out.objects = allObjects;
    return out;
  }

  if (toolName === 'inspect_storage') {
    const includeCookies = args.includeCookies !== false;
    const includeLocalStorage = args.includeLocalStorage !== false;
    const includeSessionStorage = args.includeSessionStorage !== false;

    const [cookies, storageRes] = await Promise.all([
      includeCookies ? cdp.getCookies(tabId, tab.url ? [tab.url] : null) : Promise.resolve(undefined),
      (includeLocalStorage || includeSessionStorage)
        ? sendToContent(tabId, { type: 'BA_GET_STORAGE', includeLocalStorage, includeSessionStorage })
        : Promise.resolve({})
    ]);

    return {
      ok: true,
      tabId,
      url: tab.url,
      origin: storageRes?.origin,
      ...(cookies !== undefined ? { cookies: cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite })) } : {}),
      ...(includeLocalStorage ? { localStorage: storageRes?.localStorage || {} } : {}),
      ...(includeSessionStorage ? { sessionStorage: storageRes?.sessionStorage || {} } : {})
    };
  }

  return { ok: false, error: `Unknown tool: ${toolName}` };
}
