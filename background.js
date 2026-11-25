import { TOOL_DEFINITIONS, executeTool, clearWorkingState } from './tools.js';
import { runAgentLoop, fetchProviderModels } from './llm.js';
import { getMacros, saveMacro, updateMacro, deleteMacro, buildRecordableStep, replayMacro } from './macros.js';
import { generateAutomationScript } from './exporter.js';
import { createThumbnailDataUrl } from './screenshot.js';
import { detachTab } from './cdp.js';

const NATIVE_HOST_NAME = 'com.browser_agent.bridge';

const DEFAULT_SETTINGS = {
  provider: 'anthropic',
  apiKey: '',
  model: 'claude-sonnet-4-20250514',
  baseUrl: 'http://ml-server.taila13119.ts.net:11434/v1',
  ollamaContextLength: 8192,
  includeVision: true,
  streamResponses: true,
  dualRoutingEnabled: false,
  escalationProvider: 'gemini',
  escalationModel: 'gemini-2.5-flash',
  escalationBaseUrl: '',
  escalationApiKey: '',
  secrets: {},
  slashTemplates: [],
  autoApproveLowRisk: true,
  domainAllowlist: '',
  domainBlocklist: '',
  maxSteps: 20,
  bridgeEnabled: true,
  nativeBridgeEnabled: true,
  bridgeUrl: 'ws://127.0.0.1:19222/ws',
  ttsEngine: 'api',
  ttsServiceUrl: 'http://127.0.0.1:8091',
  ttsVoice: 'af_heart',
  ttsMacVoice: '',
  ttsSpeed: 1.0,
  ttsAutoRead: false
};

let attachedTabIds = new Set();
let activeAbortController = null;
let pendingApproval = null; // { id, resolve }
let pendingHandoff = null; // { id, resolve }
let bridgeWs = null;
let nativePort = null;
let bridgeStatus = 'disconnected'; // disconnected | connecting | connected | connected (native)
let bridgeHeartbeatTimer = null;
let bridgeReconnectTimer = null;

// Macro recording & last-run history (persisted in chrome.storage.session across MV3 SW restarts)
let isRecording = false;
let recordingTabIds = new Set();
let recordedSteps = [];
let lastRunSteps = [];
let sessionHydrated = false;
let sessionHydratePromise = null;

async function persistSessionState() {
  try {
    await chrome.storage.session?.set?.({
      baSession: {
        attachedTabIds: Array.from(attachedTabIds),
        isRecording,
        recordingTabIds: Array.from(recordingTabIds),
        recordedSteps,
        lastRunSteps
      }
    });
  } catch {
    // Ignore if session storage unavailable
  }
}

async function ensureSessionHydrated() {
  if (sessionHydrated) return;
  if (!sessionHydratePromise) {
    sessionHydratePromise = (async () => {
      try {
        const res = await chrome.storage.session?.get?.('baSession');
        const s = res?.baSession;
        if (s) {
          attachedTabIds = new Set(Array.isArray(s.attachedTabIds) ? s.attachedTabIds : []);
          isRecording = Boolean(s.isRecording);
          recordingTabIds = new Set(Array.isArray(s.recordingTabIds) ? s.recordingTabIds : []);
          recordedSteps = Array.isArray(s.recordedSteps) ? s.recordedSteps : [];
          lastRunSteps = Array.isArray(s.lastRunSteps) ? s.lastRunSteps : [];
        }
      } catch {
        // Ignore
      }
      sessionHydrated = true;
    })();
  }
  await sessionHydratePromise;
}

chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

async function saveSettings(partial) {
  const current = await getSettings();
  const next = { ...current, ...partial };
  await chrome.storage.local.set({ settings: next });
  return next;
}

function broadcastToPanel(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function requestApprovalFromPanel(details) {
  return new Promise((resolve) => {
    const id = `appr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    pendingApproval = { id, resolve };
    broadcastToPanel({ type: 'BA_APPROVAL_REQUEST', id, details });
  });
}

function requestHandoffFromPanel(details) {
  return new Promise((resolve) => {
    const id = `hand_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    pendingHandoff = { id, resolve };
    broadcastToPanel({ type: 'BA_HANDOFF_REQUEST', id, details });
  });
}

function defaultAgentName(settings) {
  if (settings.provider === 'anthropic') return 'claude';
  return settings.provider || 'browser-agent';
}

function createEmptyThread(title = 'New Chat') {
  const now = Date.now();
  return {
    id: `thr_${now}_${Math.random().toString(36).slice(2, 6)}`,
    title,
    createdAt: now,
    updatedAt: now,
    totals: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, hasUnknownPricing: false },
    items: []
  };
}

let chatWriteChain = Promise.resolve();

async function readOrInitChatState() {
  const stored = await chrome.storage.local.get('chatState');
  const raw = stored.chatState;
  let threads = Array.isArray(raw?.threads) ? raw.threads.filter((t) => t && t.id) : [];
  let dirty = false;
  if (threads.length === 0) {
    threads = [createEmptyThread()];
    dirty = true;
  }
  const activeId = threads.some((t) => t.id === raw?.activeThreadId) ? raw.activeThreadId : threads[0].id;
  if (activeId !== raw?.activeThreadId) dirty = true;
  const next = { activeThreadId: activeId, threads };
  if (dirty) {
    await chrome.storage.local.set({ chatState: next });
  }
  return next;
}

async function getChatState() {
  const stored = await chrome.storage.local.get('chatState');
  const raw = stored.chatState;
  const threads = Array.isArray(raw?.threads) ? raw.threads.filter((t) => t && t.id) : [];
  if (threads.length > 0 && threads.some((t) => t.id === raw?.activeThreadId)) {
    return { activeThreadId: raw.activeThreadId, threads };
  }
  return withChatWrite(() => readOrInitChatState());
}

function withChatWrite(fn) {
  chatWriteChain = chatWriteChain.then(fn, fn);
  return chatWriteChain;
}

function pruneThreadStorage(thread) {
  if (thread.items.length > 120) {
    thread.items = thread.items.slice(-120);
  }
  let thumbCount = 0;
  for (let i = thread.items.length - 1; i >= 0; i--) {
    if (thread.items[i].thumbDataUrl) {
      thumbCount += 1;
      if (thumbCount > 10) {
        delete thread.items[i].thumbDataUrl;
      }
    }
  }
}

async function mutateThread(threadId, mutator) {
  return withChatWrite(async () => {
    const state = await readOrInitChatState();
    let target = state.threads.find((t) => t.id === threadId);
    if (!target) {
      target = state.threads[0];
    }
    mutator(target, state);
    target.updatedAt = Date.now();
    pruneThreadStorage(target);
    state.threads.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (state.threads.length > 20) {
      state.threads = state.threads.slice(0, 20);
    }
    await chrome.storage.local.set({ chatState: state });
    return { state, thread: target };
  });
}

function buildPriorTurns(thread) {
  const turns = [];
  for (const item of thread?.items || []) {
    if (item.kind === 'user' && item.text) {
      turns.push({ role: 'user', text: item.text });
    } else if (item.kind === 'assistant' && item.isFinal && item.text) {
      turns.push({ role: 'assistant', text: item.text });
    }
  }
  return turns.slice(-6);
}

async function handleExportScript(args = {}) {
  await ensureSessionHydrated();
  let steps = null;
  let sourceName = args.name;
  if (args.macroId || (!args.useLastRun && args.macroName)) {
    const macros = await getMacros();
    const macro = macros.find((m) => (args.macroId ? m.id === args.macroId : m.name === args.macroName));
    if (!macro) {
      return { ok: false, error: `Macro not found: ${args.macroId || args.macroName}` };
    }
    steps = macro.steps || [];
    sourceName = sourceName || macro.name;
  } else {
    steps = lastRunSteps;
    sourceName = sourceName || 'Browser Agent Workflow';
  }

  if (!Array.isArray(steps) || steps.length === 0) {
    return { ok: false, error: 'No steps found to export. Run a task or select a saved macro first.' };
  }

  const exported = generateAutomationScript(steps, {
    format: args.format === 'puppeteer' ? 'puppeteer' : 'playwright',
    name: sourceName
  });

  if (args.download) {
    const dataUrl = `data:text/plain;charset=utf-8,${encodeURIComponent(exported.code)}`;
    exported.downloadId = await chrome.downloads.download({
      url: dataUrl,
      filename: exported.filename,
      saveAs: false
    });
  }
  return exported;
}

function createMacroHandler({ settings, agentName, touchedTabIds, signal, skipSafety = false }) {
  return async (toolName, args = {}) => {
    if (toolName === 'list_macros') {
      return { ok: true, macros: await getMacros() };
    }
    if (toolName === 'save_macro') {
      await ensureSessionHydrated();
      const steps = Array.isArray(args.steps) && args.steps.length > 0 ? args.steps : lastRunSteps;
      if (!steps || steps.length === 0) {
        return { ok: false, error: 'No steps provided and no recent run steps recorded.' };
      }
      const macro = await saveMacro({ name: args.name, steps });
      broadcastToPanel({ type: 'BA_MACROS_UPDATED', macros: await getMacros() });
      return { ok: true, macro };
    }
    if (toolName === 'delete_macro') {
      const macros = await deleteMacro(args.macroId);
      broadcastToPanel({ type: 'BA_MACROS_UPDATED', macros });
      return { ok: true, macros };
    }
    if (toolName === 'export_script') {
      return await handleExportScript(args);
    }
    if (toolName === 'replay_macro') {
      return await replayMacro({
        macroId: args.macroId,
        name: args.name,
        tabId: args.tabId ?? null,
        params: args.params || {},
        selfHeal: args.selfHeal !== false,
        skipSafety,
        settings,
        agentName,
        attachedTabIds,
        touchedTabIds,
        signal,
        onEvent: (ev) => broadcastToPanel({ type: 'BA_AGENT_EVENT', event: ev }),
        onMacroUpdated: (macros) => broadcastToPanel({ type: 'BA_MACROS_UPDATED', macros }),
        requestApproval: skipSafety ? null : requestApprovalFromPanel,
        requestHandoff: skipSafety ? null : requestHandoffFromPanel,
        executeTool,
        runAgentLoop,
        macroHandler: createMacroHandler({ settings, agentName, touchedTabIds, signal, skipSafety })
      });
    }
    return { ok: false, error: `Unknown macro tool: ${toolName}` };
  };
}

async function startAgentTask(prompt, { agentName = null, threadId = null, isScheduled = false } = {}) {
  await ensureSessionHydrated();
  const controller = new AbortController();
  if (!isScheduled) {
    if (activeAbortController) {
      activeAbortController.abort();
    }
    activeAbortController = controller;
  }

  const settings = await getSettings();
  const effectiveAgent = agentName || defaultAgentName(settings);
  const touchedTabIds = new Set();
  if (!isScheduled) {
    lastRunSteps = [];
    await persistSessionState();
  }

  const initialChat = await getChatState();
  const activeThreadId = threadId || initialChat.activeThreadId;
  const activeThread = initialChat.threads.find((t) => t.id === activeThreadId) || initialChat.threads[0];
  const priorTurns = isScheduled ? [] : buildPriorTurns(activeThread);

  await mutateThread(activeThread.id, (t) => {
    if (t.items.length === 0 || t.title === 'New Chat') {
      t.title = String(prompt || 'New Chat').replace(/\s+/g, ' ').trim().slice(0, 48) || 'New Chat';
    }
    t.items.push({ kind: 'user', text: prompt, ts: Date.now() });
  });

  broadcastToPanel({ type: 'BA_RUN_START', prompt, threadId: activeThread.id });
  let eventChain = Promise.resolve();
  let runTotals = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, hasUnknownPricing: false };

  const enqueueEvent = (fn) => {
    eventChain = eventChain.then(fn, fn);
  };

  try {
    const macroHandler = createMacroHandler({
      settings,
      agentName: effectiveAgent,
      touchedTabIds,
      signal: controller.signal
    });
    const finalText = await runAgentLoop({
      prompt,
      settings,
      agentName: effectiveAgent,
      attachedTabIds,
      touchedTabIds,
      priorTurns,
      signal: controller.signal,
      onEvent: (ev) => {
        if (ev.type === 'assistant_delta') {
          broadcastToPanel({ type: 'BA_AGENT_EVENT', threadId: activeThread.id, event: ev });
          return;
        }
        if (ev.type === 'tool_start') {
          pendingStepCapture.set(`${ev.step}:${ev.tool}`, ev.args);
        } else if (ev.type === 'tool_result') {
          const args = pendingStepCapture.get(`${ev.step}:${ev.tool}`);
          pendingStepCapture.delete(`${ev.step}:${ev.tool}`);
          const rec = buildRecordableStep(ev.tool, args, ev.result);
          if (rec && !isScheduled) {
            lastRunSteps.push(rec);
            persistSessionState();
          }
        } else if (ev.type === 'usage') {
          const turnIn = Number(ev.inputTokens) || 0;
          const turnOut = Number(ev.outputTokens) || 0;
          runTotals = ev.totals || runTotals;
          enqueueEvent(async () => {
            const updated = await mutateThread(activeThread.id, (t) => {
              t.totals = t.totals || { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, hasUnknownPricing: false };
              t.totals.inputTokens += turnIn;
              t.totals.outputTokens += turnOut;
              if (ev.estimatedCostUsd === null) {
                t.totals.hasUnknownPricing = true;
              } else {
                t.totals.estimatedCostUsd += Number(ev.estimatedCostUsd) || 0;
              }
            });
            broadcastToPanel({
              type: 'BA_AGENT_EVENT',
              threadId: activeThread.id,
              event: { ...ev, threadTotals: updated.thread.totals }
            });
          });
          return;
        }

        const rawShot = ev.screenshotDataUrl;
        const cleanEv = { ...ev };
        delete cleanEv.screenshotDataUrl;

        enqueueEvent(async () => {
          let thumbDataUrl = null;
          if (rawShot) {
            thumbDataUrl = await createThumbnailDataUrl(rawShot);
          }
          if (thumbDataUrl) cleanEv.thumbDataUrl = thumbDataUrl;

          if (cleanEv.type === 'assistant_text') {
            await mutateThread(activeThread.id, (t) => {
              t.items.push({ kind: 'assistant', text: cleanEv.text, ts: Date.now() });
            });
          } else if (cleanEv.type === 'status') {
            await mutateThread(activeThread.id, (t) => {
              t.items.push({ kind: 'bridge', text: `ℹ ${cleanEv.text}`, ts: Date.now() });
            });
          } else if (cleanEv.type === 'tool_start') {
            await mutateThread(activeThread.id, (t) => {
              t.items.push({
                kind: 'tool',
                text: `▶ Step ${cleanEv.step}: ${cleanEv.tool}(${JSON.stringify(cleanEv.args || {})})`,
                ts: Date.now()
              });
            });
          } else if (cleanEv.type === 'tool_result') {
            const summary = cleanEv.result?.ok === false ? `ERR: ${cleanEv.result.error}` : 'ok';
            await mutateThread(activeThread.id, (t) => {
              t.items.push({
                kind: 'tool',
                text: `✓ ${cleanEv.tool} → ${summary}`,
                ...(thumbDataUrl ? { thumbDataUrl } : {}),
                ts: Date.now()
              });
            });
          }
          broadcastToPanel({ type: 'BA_AGENT_EVENT', threadId: activeThread.id, event: cleanEv });
        });
      },
      requestApproval: isScheduled ? null : requestApprovalFromPanel,
      requestHandoff: isScheduled ? null : requestHandoffFromPanel,
      macroHandler
    });

    await eventChain;
    const saved = await mutateThread(activeThread.id, (t) => {
      t.items.push({ kind: 'assistant', text: finalText, isFinal: true, ts: Date.now() });
    });
    broadcastToPanel({
      type: 'BA_RUN_DONE',
      text: finalText,
      threadId: activeThread.id,
      threadTotals: saved.thread.totals,
      runTotals,
      lastRunStepsCount: lastRunSteps.length
    });
    return { ok: true, text: finalText, totals: runTotals };
  } catch (err) {
    await eventChain;
    const msg = err?.message || String(err);
    await mutateThread(activeThread.id, (t) => {
      t.items.push({ kind: 'error', text: msg, ts: Date.now() });
    });
    broadcastToPanel({ type: 'BA_RUN_ERROR', error: msg, threadId: activeThread.id });
    return { ok: false, error: msg };
  } finally {
    await clearWorkingState(touchedTabIds, effectiveAgent);
    if (!isScheduled && activeAbortController === controller) {
      activeAbortController = null;
    }
    if (!isScheduled && pendingApproval) {
      pendingApproval.resolve(false);
      pendingApproval = null;
    }
    if (!isScheduled && pendingHandoff) {
      pendingHandoff.resolve({ resumed: false });
      pendingHandoff = null;
    }
  }
}
const pendingStepCapture = new Map();

async function runMacroFromPanel({ macroId, params = {}, selfHeal = true }) {
  if (activeAbortController) activeAbortController.abort();
  activeAbortController = new AbortController();
  const settings = await getSettings();
  const effectiveAgent = defaultAgentName(settings);
  const touchedTabIds = new Set();

  broadcastToPanel({ type: 'BA_RUN_START', prompt: `Replay macro ${macroId}` });
  try {
    const macroHandler = createMacroHandler({
      settings,
      agentName: effectiveAgent,
      touchedTabIds,
      signal: activeAbortController.signal
    });
    const res = await replayMacro({
      macroId,
      params,
      selfHeal,
      settings,
      agentName: effectiveAgent,
      attachedTabIds,
      touchedTabIds,
      signal: activeAbortController.signal,
      onEvent: (ev) => broadcastToPanel({ type: 'BA_AGENT_EVENT', event: ev }),
      onMacroUpdated: (macros) => broadcastToPanel({ type: 'BA_MACROS_UPDATED', macros }),
      requestApproval: requestApprovalFromPanel,
      requestHandoff: requestHandoffFromPanel,
      executeTool,
      runAgentLoop,
      macroHandler
    });
    if (res.ok) {
      const msg = res.healed
        ? `Macro "${res.macroName}" completed with LLM self-healing${res.healedUpdated ? ' (selector repaired & saved)' : ''}:\n${res.healSummary}`
        : `Macro "${res.macroName}" replayed (${res.completedSteps}/${res.totalSteps} steps, 0 LLM tokens).`;
      broadcastToPanel({ type: 'BA_RUN_DONE', text: msg });
    } else {
      broadcastToPanel({ type: 'BA_RUN_ERROR', error: res.error || 'Macro failed' });
    }
    return res;
  } catch (err) {
    const msg = err?.message || String(err);
    broadcastToPanel({ type: 'BA_RUN_ERROR', error: msg });
    return { ok: false, error: msg };
  } finally {
    await clearWorkingState(touchedTabIds, effectiveAgent);
    activeAbortController = null;
  }
}

// --- User Action Recording (multi-tab aware) ---
async function setRecordingOnTab(tabId, active) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (rec) => {
        if (window.__baSetRecording) window.__baSetRecording(rec);
      },
      args: [active]
    });
  } catch {
    // Ignore restricted tabs
  }
}

chrome.tabs?.onCreated?.addListener(async (tab) => {
  await ensureSessionHydrated();
  if (!isRecording || !tab?.id) return;
  if (tab.openerTabId && recordingTabIds.has(tab.openerTabId)) {
    recordingTabIds.add(tab.id);
    const url = tab.pendingUrl || tab.url;
    if (url && !url.startsWith('chrome://')) {
      recordedSteps.push({ tool: 'open_tab', args: { url }, label: url });
      broadcastToPanel({ type: 'BA_RECORDING_COUNT', count: recordedSteps.length });
    }
    await persistSessionState();
  }
});

chrome.tabs?.onActivated?.addListener(async (activeInfo) => {
  await ensureSessionHydrated();
  if (!isRecording || !activeInfo?.tabId) return;
  if (recordingTabIds.has(activeInfo.tabId)) {
    await setRecordingOnTab(activeInfo.tabId, true);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  await ensureSessionHydrated();
  if (isRecording && recordingTabIds.has(tabId) && info.status === 'complete') {
    setRecordingOnTab(tabId, true);
  }
  if (isRecording && recordingTabIds.has(tabId) && info.url) {
    const last = recordedSteps[recordedSteps.length - 1];
    if ((!last || (last.tool !== 'navigate' && last.tool !== 'open_tab') || last.args?.url !== info.url) && !info.url.startsWith('chrome://')) {
      recordedSteps.push({ tool: 'navigate', args: { url: info.url }, label: info.url });
      await persistSessionState();
      broadcastToPanel({ type: 'BA_RECORDING_COUNT', count: recordedSteps.length });
    }
  }
});

// --- Scheduled Tasks (chrome.alarms) ---
async function getSchedules() {
  const stored = await chrome.storage.local.get('schedules');
  return stored.schedules || [];
}

async function saveSchedules(schedules) {
  await chrome.storage.local.set({ schedules });
  await chrome.alarms.clearAll();
  chrome.alarms.create('ba_bridge_keepalive', { periodInMinutes: 1 });
  for (const s of schedules) {
    if (s.enabled && s.intervalMinutes >= 1) {
      chrome.alarms.create(`ba_sched_${s.id}`, { periodInMinutes: Number(s.intervalMinutes) });
    }
  }
}

async function executeScheduleItem(item, { isScheduled = true } = {}) {
  let ok = false;
  let error = null;
  try {
    if (item.macroId) {
      const res = await runMacroFromPanel({ macroId: item.macroId, selfHeal: true });
      ok = res?.ok !== false;
      error = res?.error || null;
    } else {
      const res = await startAgentTask(`[Scheduled Task: ${item.name}] ${item.prompt}`, { isScheduled });
      ok = res?.ok !== false;
      error = res?.error || null;
    }
  } catch (err) {
    ok = false;
    error = err?.message || String(err);
  }
  const schedules = await getSchedules();
  const idx = schedules.findIndex((s) => s.id === item.id);
  if (idx >= 0) {
    schedules[idx] = {
      ...schedules[idx],
      lastRunAt: Date.now(),
      lastStatus: ok ? 'ok' : `error: ${error || 'failed'}`
    };
    await chrome.storage.local.set({ schedules });
    broadcastToPanel({ type: 'BA_SCHEDULES_UPDATED', schedules });
  }
  return { ok, error };
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'ba_bridge_keepalive') {
    await connectBridge();
    return;
  }
  if (alarm.name.startsWith('ba_sched_')) {
    const id = alarm.name.replace('ba_sched_', '');
    const schedules = await getSchedules();
    const item = schedules.find((s) => s.id === id);
    if (item && item.enabled) {
      await executeScheduleItem(item, { isScheduled: true });
    }
  }
});

// --- TTS (AIHub Kokoro API) helpers ---
function normalizeTtsUrl(rawUrl) {
  return String(rawUrl || DEFAULT_SETTINGS.ttsServiceUrl).trim().replace(/\/+$/, '') || DEFAULT_SETTINGS.ttsServiceUrl;
}

async function ttsRequest(path, { serviceUrl, method = 'GET', body = null } = {}) {
  const settings = await getSettings();
  const base = normalizeTtsUrl(serviceUrl || settings.ttsServiceUrl);
  const res = await fetch(`${base}${path}`, {
    method,
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const detail = data?.detail || data?.message || text || res.statusText;
    throw new Error(`TTS error (${res.status}): ${detail}`);
  }
  return data;
}

// --- Unified Bridge RPC Dispatcher (shared by WebSocket + Native Messaging) ---
async function handleBridgeRequest(req, sendFn) {
  if (!req || !req.id) return;
  try {
    await ensureSessionHydrated();
    if (req.method === 'list_tools') {
      sendFn({ id: req.id, ok: true, result: { tools: TOOL_DEFINITIONS } });
      return;
    }
    if (req.method === 'call_tool') {
      const curSettings = await getSettings();
      const agentName = req.params?.agent || 'agy';
      const skipSafety = Boolean(req.params?.skipSafety);
      const macroHandler = createMacroHandler({
        settings: curSettings,
        agentName,
        touchedTabIds: new Set(),
        signal: null,
        skipSafety
      });
      const result = await executeTool(req.params?.tool, req.params?.args || {}, {
        settings: curSettings,
        agentName,
        attachedTabIds,
        skipSafety,
        macroHandler
      });
      const rec = buildRecordableStep(req.params?.tool, req.params?.args, result);
      if (rec) {
        lastRunSteps.push(rec);
        await persistSessionState();
      }
      broadcastToPanel({
        type: 'BA_BRIDGE_ACTIVITY',
        tool: req.params?.tool,
        args: req.params?.args,
        ok: result?.ok !== false,
        lastRunStepsCount: lastRunSteps.length
      });
      sendFn({ id: req.id, ok: true, result });
      return;
    }
    if (req.method === 'run_task') {
      const result = await startAgentTask(req.params?.prompt || '', {
        agentName: req.params?.agent || 'agy'
      });
      sendFn({ id: req.id, ok: true, result });
      return;
    }
    if (req.method === 'save_settings') {
      const next = await saveSettings(req.params?.settings || {});
      broadcastToPanel({ type: 'BA_SETTINGS_UPDATED', settings: next });
      sendFn({
        id: req.id,
        ok: true,
        result: {
          ok: true,
          provider: next.provider,
          model: next.model,
          hasApiKey: Boolean(next.apiKey)
        }
      });
      return;
    }
    sendFn({ id: req.id, ok: false, error: `Unknown method: ${req.method}` });
  } catch (err) {
    sendFn({ id: req.id, ok: false, error: err?.message || String(err) });
  }
}

function disconnectNativePort() {
  if (nativePort) {
    try { nativePort.disconnect(); } catch {}
    nativePort = null;
  }
}

function connectNativeBridge() {
  if (nativePort) return;
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    nativePort = port;
    bridgeStatus = 'connected (native)';
    broadcastToPanel({ type: 'BA_BRIDGE_STATUS', status: bridgeStatus });

    port.postMessage({
      type: 'hello',
      extension: 'browser-agent',
      extensionId: chrome.runtime.id,
      tools: TOOL_DEFINITIONS
    });

    port.onMessage.addListener((msg) => {
      if (msg?.type === 'ping') {
        port.postMessage({ type: 'pong' });
        return;
      }
      handleBridgeRequest(msg, (resp) => port.postMessage(resp));
    });

    port.onDisconnect.addListener(() => {
      if (nativePort === port) nativePort = null;
      if (!bridgeWs || bridgeWs.readyState !== WebSocket.OPEN) {
        bridgeStatus = 'disconnected';
        broadcastToPanel({ type: 'BA_BRIDGE_STATUS', status: bridgeStatus });
      }
    });
  } catch {
    nativePort = null;
    bridgeStatus = 'disconnected';
    broadcastToPanel({ type: 'BA_BRIDGE_STATUS', status: bridgeStatus });
  }
}

async function connectBridge() {
  const settings = await getSettings();
  if (!settings.bridgeEnabled) {
    if (bridgeWs) {
      bridgeWs.close();
      bridgeWs = null;
    }
    disconnectNativePort();
    bridgeStatus = 'disconnected';
    broadcastToPanel({ type: 'BA_BRIDGE_STATUS', status: bridgeStatus });
    return;
  }

  if (bridgeWs && (bridgeWs.readyState === WebSocket.OPEN || bridgeWs.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (nativePort) {
    bridgeStatus = 'connected (native)';
    broadcastToPanel({ type: 'BA_BRIDGE_STATUS', status: bridgeStatus });
    return;
  }

  bridgeStatus = 'connecting';
  broadcastToPanel({ type: 'BA_BRIDGE_STATUS', status: bridgeStatus });

  try {
    const ws = new WebSocket(settings.bridgeUrl || 'ws://127.0.0.1:19222/ws');
    bridgeWs = ws;
    let opened = false;

    ws.onopen = () => {
      opened = true;
      disconnectNativePort();
      bridgeStatus = 'connected';
      broadcastToPanel({ type: 'BA_BRIDGE_STATUS', status: bridgeStatus });
      ws.send(JSON.stringify({
        type: 'hello',
        extension: 'browser-agent',
        extensionId: chrome.runtime.id,
        tools: TOOL_DEFINITIONS
      }));
      if (bridgeHeartbeatTimer) clearInterval(bridgeHeartbeatTimer);
      bridgeHeartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 20000);
    };

    ws.onmessage = async (event) => {
      let req;
      try {
        req = JSON.parse(event.data);
      } catch {
        return;
      }
      if (req.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      if (req.type === 'pong') return;
      await handleBridgeRequest(req, (resp) => ws.send(JSON.stringify(resp)));
    };

    ws.onclose = async () => {
      if (bridgeHeartbeatTimer) {
        clearInterval(bridgeHeartbeatTimer);
        bridgeHeartbeatTimer = null;
      }
      if (bridgeWs === ws) bridgeWs = null;

      const cur = await getSettings();
      if (!opened && cur.bridgeEnabled && cur.nativeBridgeEnabled !== false) {
        connectNativeBridge();
        return;
      }

      bridgeStatus = 'disconnected';
      broadcastToPanel({ type: 'BA_BRIDGE_STATUS', status: bridgeStatus });
      if (bridgeReconnectTimer) clearTimeout(bridgeReconnectTimer);
      bridgeReconnectTimer = setTimeout(() => {
        connectBridge();
      }, 5000);
    };

    ws.onerror = () => {
      // onclose handles fallback to native messaging
    };
  } catch {
    if (settings.nativeBridgeEnabled !== false) {
      connectNativeBridge();
    } else {
      bridgeStatus = 'disconnected';
      broadcastToPanel({ type: 'BA_BRIDGE_STATUS', status: bridgeStatus });
    }
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create('ba_bridge_keepalive', { periodInMinutes: 1 });
  await connectBridge();
});

chrome.runtime.onStartup.addListener(async () => {
  chrome.alarms.create('ba_bridge_keepalive', { periodInMinutes: 1 });
  await connectBridge();
});

// Side panel & internal messaging
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    await ensureSessionHydrated();

    if (msg.type === 'BA_GET_STATE') {
      const settings = await getSettings();
      const schedules = await getSchedules();
      const macros = await getMacros();
      const chatState = await getChatState();
      const tabs = await chrome.tabs.query({});
      sendResponse({
        ok: true,
        extensionId: chrome.runtime.id,
        settings,
        schedules,
        macros,
        chatState,
        isRecording,
        recordedCount: recordedSteps.length,
        lastRunStepsCount: lastRunSteps.length,
        attachedTabIds: Array.from(attachedTabIds),
        tabs: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active })),
        bridgeStatus,
        running: Boolean(activeAbortController)
      });
      return;
    }

    if (msg.type === 'BA_SAVE_SETTINGS') {
      const next = await saveSettings(msg.settings || {});
      await connectBridge();
      sendResponse({ ok: true, settings: next });
      return;
    }

    if (msg.type === 'BA_FETCH_MODELS') {
      try {
        const res = await fetchProviderModels({
          provider: msg.provider,
          baseUrl: msg.baseUrl,
          apiKey: msg.apiKey
        });
        sendResponse(res);
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err), models: [] });
      }
      return;
    }

    if (msg.type === 'BA_RUN_PROMPT') {
      startAgentTask(msg.prompt, { threadId: msg.threadId || null });
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'BA_STOP_RUN') {
      if (activeAbortController) {
        activeAbortController.abort();
        activeAbortController = null;
      }
      if (pendingApproval) {
        pendingApproval.resolve(false);
        pendingApproval = null;
      }
      if (pendingHandoff) {
        pendingHandoff.resolve({ resumed: false });
        pendingHandoff = null;
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'BA_APPROVAL_RESPONSE') {
      if (pendingApproval && pendingApproval.id === msg.id) {
        pendingApproval.resolve(Boolean(msg.approved));
        pendingApproval = null;
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'BA_HANDOFF_RESPONSE') {
      if (pendingHandoff && pendingHandoff.id === msg.id) {
        pendingHandoff.resolve({
          resumed: Boolean(msg.resumed),
          note: msg.note ? String(msg.note).trim() : ''
        });
        pendingHandoff = null;
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'BA_DETACH_DEBUGGER') {
      try {
        let tid = msg.tabId ? Number(msg.tabId) : null;
        if (tid == null) {
          const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          tid = active?.id;
        }
        const res = tid != null ? await detachTab(tid) : { ok: true, detached: false };
        sendResponse(res);
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
      return;
    }

    if (msg.type === 'BA_TOGGLE_ATTACH_TAB') {
      const id = Number(msg.tabId);
      if (attachedTabIds.has(id)) attachedTabIds.delete(id);
      else attachedTabIds.add(id);
      await persistSessionState();
      sendResponse({ ok: true, attachedTabIds: Array.from(attachedTabIds) });
      return;
    }

    if (msg.type === 'BA_SAVE_SCHEDULES') {
      await saveSchedules(msg.schedules || []);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'BA_RUN_SCHEDULE_NOW') {
      const schedules = await getSchedules();
      const item = schedules.find((s) => s.id === msg.scheduleId);
      if (!item) {
        sendResponse({ ok: false, error: 'Schedule not found.' });
        return;
      }
      executeScheduleItem(item, { isScheduled: false });
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'BA_RECONNECT_BRIDGE') {
      disconnectNativePort();
      await connectBridge();
      sendResponse({ ok: true, bridgeStatus });
      return;
    }

    if (msg.type === 'BA_START_RECORDING') {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!active) {
        sendResponse({ ok: false, error: 'No active tab' });
        return;
      }
      isRecording = true;
      recordingTabIds = new Set([active.id]);
      recordedSteps = [{ tool: 'navigate', args: { url: active.url }, label: active.url }];
      await persistSessionState();
      await setRecordingOnTab(active.id, true);
      sendResponse({ ok: true, count: recordedSteps.length });
      return;
    }

    if (msg.type === 'BA_RECORDED_STEP') {
      if (!isRecording || !msg.step) {
        sendResponse({ ok: false });
        return;
      }
      const last = recordedSteps[recordedSteps.length - 1];
      if (msg.step.tool === 'type' && last?.tool === 'type' && last.args?.selector === msg.step.args?.selector) {
        recordedSteps[recordedSteps.length - 1] = msg.step;
      } else {
        recordedSteps.push(msg.step);
      }
      await persistSessionState();
      broadcastToPanel({ type: 'BA_RECORDING_COUNT', count: recordedSteps.length });
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'BA_STOP_RECORDING') {
      isRecording = false;
      for (const tid of recordingTabIds) {
        await setRecordingOnTab(tid, false);
      }
      let macro = null;
      if (msg.save && recordedSteps.length > 0) {
        macro = await saveMacro({ name: msg.name, steps: recordedSteps });
      }
      recordedSteps = [];
      recordingTabIds = new Set();
      await persistSessionState();
      sendResponse({ ok: true, macro, macros: await getMacros() });
      return;
    }

    if (msg.type === 'BA_SAVE_LAST_RUN_MACRO') {
      if (lastRunSteps.length === 0) {
        sendResponse({ ok: false, error: 'No recent run steps to save.' });
        return;
      }
      const macro = await saveMacro({ name: msg.name, steps: lastRunSteps });
      sendResponse({ ok: true, macro, macros: await getMacros() });
      return;
    }

    if (msg.type === 'BA_UPDATE_MACRO') {
      const res = await updateMacro(msg.macroId, { name: msg.name, steps: msg.steps });
      sendResponse(res);
      return;
    }

    if (msg.type === 'BA_REPLAY_MACRO') {
      runMacroFromPanel({
        macroId: msg.macroId,
        params: msg.params || {},
        selfHeal: msg.selfHeal !== false
      });
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'BA_DELETE_MACRO') {
      const macros = await deleteMacro(msg.macroId);
      sendResponse({ ok: true, macros });
      return;
    }

    if (msg.type === 'BA_EXPORT_SCRIPT') {
      try {
        const res = await handleExportScript({
          format: msg.format,
          macroId: msg.macroId,
          useLastRun: Boolean(msg.useLastRun),
          name: msg.name,
          download: Boolean(msg.download)
        });
        sendResponse(res);
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
      return;
    }

    if (msg.type === 'BA_NEW_THREAD') {
      const chatState = await withChatWrite(async () => {
        const cur = await readOrInitChatState();
        const fresh = createEmptyThread();
        cur.threads.unshift(fresh);
        cur.activeThreadId = fresh.id;
        if (cur.threads.length > 20) cur.threads = cur.threads.slice(0, 20);
        await chrome.storage.local.set({ chatState: cur });
        return cur;
      });
      sendResponse({ ok: true, chatState });
      return;
    }

    if (msg.type === 'BA_SELECT_THREAD') {
      const chatState = await withChatWrite(async () => {
        const cur = await readOrInitChatState();
        if (cur.threads.some((t) => t.id === msg.threadId)) {
          cur.activeThreadId = msg.threadId;
          await chrome.storage.local.set({ chatState: cur });
        }
        return cur;
      });
      sendResponse({ ok: true, chatState });
      return;
    }

    if (msg.type === 'BA_CLEAR_THREAD') {
      const chatState = await withChatWrite(async () => {
        const cur = await readOrInitChatState();
        const target = cur.threads.find((t) => t.id === (msg.threadId || cur.activeThreadId));
        if (target) {
          target.items = [];
          target.title = 'New Chat';
          target.totals = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, hasUnknownPricing: false };
          target.updatedAt = Date.now();
          await chrome.storage.local.set({ chatState: cur });
        }
        return cur;
      });
      sendResponse({ ok: true, chatState });
      return;
    }

    if (msg.type === 'BA_DELETE_THREAD') {
      const chatState = await withChatWrite(async () => {
        const cur = await readOrInitChatState();
        cur.threads = cur.threads.filter((t) => t.id !== msg.threadId);
        if (cur.threads.length === 0) cur.threads = [createEmptyThread()];
        if (!cur.threads.some((t) => t.id === cur.activeThreadId)) {
          cur.activeThreadId = cur.threads[0].id;
        }
        await chrome.storage.local.set({ chatState: cur });
        return cur;
      });
      sendResponse({ ok: true, chatState });
      return;
    }

    if (msg.type === 'BA_DOWNLOAD_IMAGE') {
      try {
        const filename = String(msg.filename || `browser-agent-${Date.now()}.png`).split(/[/\\]/).pop().replace(/[^a-zA-Z0-9._-]/g, '_');
        const downloadId = await chrome.downloads.download({
          url: msg.dataUrl,
          filename,
          saveAs: false
        });
        sendResponse({ ok: true, downloadId, filename });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
      return;
    }

    if (msg.type === 'BA_CAPTURE_FULL_PAGE') {
      try {
        const settings = await getSettings();
        const res = await executeTool('full_page_screenshot', {
          ...(msg.tabId != null ? { tabId: Number(msg.tabId) } : {}),
          download: msg.download !== false,
          format: msg.format || 'png'
        }, { settings, agentName: defaultAgentName(settings), attachedTabIds });
        if (!res?.ok) {
          sendResponse(res || { ok: false, error: 'Full-page capture failed.' });
          return;
        }
        const thumbDataUrl = await createThumbnailDataUrl(res.screenshotDataUrl);
        const chatState = await getChatState();
        const summary = `Captured full-page screenshot (${res.width}×${res.height}px, ${res.segments} segments)${res.savedFilename ? ` → saved ${res.savedFilename}` : ''}.`;
        await mutateThread(chatState.activeThreadId, (t) => {
          t.items.push({ kind: 'tool', text: `📷 ${summary}`, ...(thumbDataUrl ? { thumbDataUrl } : {}), ts: Date.now() });
        });
        sendResponse({ ok: true, width: res.width, height: res.height, segments: res.segments, savedFilename: res.savedFilename, thumbDataUrl, summary });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
      return;
    }

    if (msg.type === 'BA_TTS_SPEAK') {
      try {
        const settings = await getSettings();
        const data = await ttsRequest('/speak', {
          serviceUrl: msg.serviceUrl,
          method: 'POST',
          body: {
            text: String(msg.text || '').trim(),
            voice: msg.voice || settings.ttsVoice || DEFAULT_SETTINGS.ttsVoice,
            speed: Math.min(2.0, Math.max(0.5, Number(msg.speed ?? settings.ttsSpeed) || 1.0)),
            format: 'json'
          }
        });
        if (!data?.audio_base64) throw new Error('TTS service returned no audio.');
        sendResponse({ ok: true, audioBase64: data.audio_base64, sampleRate: data.sample_rate });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
      return;
    }

    if (msg.type === 'BA_TTS_VOICES') {
      try {
        const voices = await ttsRequest('/voices', { serviceUrl: msg.serviceUrl });
        sendResponse({ ok: true, voices });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
      return;
    }

    if (msg.type === 'BA_TTS_HEALTH') {
      try {
        const health = await ttsRequest('/health', { serviceUrl: msg.serviceUrl });
        sendResponse({ ok: true, health });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
      return;
    }
  })();
  return true;
});

connectBridge();
