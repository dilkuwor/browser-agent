import {
  createTtsController,
  DEFAULT_TTS_SETTINGS,
  getMacVoiceQuality,
  scoreMacVoice
} from './tts.js';

const $ = (id) => document.getElementById(id);

const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o',
  openrouter: 'anthropic/claude-sonnet-4',
  gemini: 'gemini-2.5-flash',
  ollama: 'qwen2.5-coder:14b',
  custom: 'gpt-4o-mini'
};

const DEFAULT_BASE_URLS = {
  ollama: 'http://ml-server.taila13119.ts.net:11434/v1',
  custom: 'http://localhost:8000/v1'
};

const BUILTIN_SLASH_TEMPLATES = [
  {
    cmd: '/summarize',
    desc: 'Summarize the key points on the current page',
    prompt: 'Observe this page and summarize the key points clearly and concisely.'
  },
  {
    cmd: '/extract-table',
    desc: 'Extract the main table on this page to CSV',
    prompt: 'Extract the main table on this page using extract_table and save it as table.csv.'
  },
  {
    cmd: '/debug',
    desc: 'Inspect console errors and failed network requests',
    prompt: 'Inspect console logs and failed network requests on this tab and summarize any errors.'
  },
  {
    cmd: '/fullshot',
    desc: 'Capture a stitched full-page screenshot and download it',
    prompt: 'Capture a full_page_screenshot of this page and save it to Downloads.'
  },
  {
    cmd: '/fill-login',
    desc: 'Fill the login form using Secrets Vault placeholders',
    prompt: 'Observe this page, find the login form, and fill it using the appropriate Secrets Vault placeholders.'
  },
  {
    cmd: '/links',
    desc: 'List primary navigation links and actions on the page',
    prompt: 'Observe this page and list the main navigation links and primary interactive actions.'
  }
];

const EDITABLE_TOOLS = [
  'navigate', 'open_tab', 'click', 'type', 'select_option', 'fill_form',
  'upload_file', 'drag_and_drop', 'scroll', 'press_key', 'wait', 'wait_for'
];

let state = {
  extensionId: '',
  settings: {},
  schedules: [],
  macros: [],
  chatState: { activeThreadId: null, threads: [] },
  isRecording: false,
  recordedCount: 0,
  lastRunStepsCount: 0,
  attachedTabIds: [],
  tabs: [],
  bridgeStatus: 'disconnected',
  running: false
};
let pendingApprovalId = null;
let pendingHandoffId = null;
let pendingParamMacro = null;
let editMacroDraft = null;
let currentExported = null;
let modalImageUrl = null;
let msgSeq = 0;
let streamMsgEl = null;
let streamBodyEl = null;

const tts = createTtsController({
  sendMessage: (msg) => chrome.runtime.sendMessage(msg),
  onStateChange: (ttsState) => {
    $('stopTtsBtn').classList.toggle('hidden', !ttsState.playing);
    document.querySelectorAll('.tts-btn').forEach((btn) => {
      const isMine = ttsState.playing && btn.dataset.ttsId === ttsState.activeId;
      btn.classList.toggle('active', isMine);
      btn.textContent = isMine ? (ttsState.loading ? '⏳ Loading…' : '⏹ Stop') : '🔊 Read';
    });
    if (ttsState.error) {
      appendTimeline('error', `TTS: ${ttsState.error}`);
    }
  }
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function getAllSlashTemplates() {
  const custom = Array.isArray(state.settings?.slashTemplates) ? state.settings.slashTemplates : [];
  return [...BUILTIN_SLASH_TEMPLATES, ...custom];
}

function formatTokenCount(n) {
  const num = Number(n) || 0;
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
  return String(num);
}

function formatCost(totals) {
  const inTok = Number(totals?.inputTokens) || 0;
  const outTok = Number(totals?.outputTokens) || 0;
  const totalTok = inTok + outTok;
  const usd = Number(totals?.estimatedCostUsd) || 0;
  const costText = totals?.hasUnknownPricing && usd === 0
    ? '~$?'
    : `$${usd < 0.01 && usd > 0 ? usd.toFixed(4) : usd.toFixed(2)}`;
  return `${formatTokenCount(totalTok)} tok • ${costText}`;
}

function getActiveThread() {
  const threads = state.chatState?.threads || [];
  return threads.find((t) => t.id === state.chatState?.activeThreadId) || threads[0] || null;
}

function renderUsageBadge(totals = null) {
  const t = totals || getActiveThread()?.totals || { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
  const label = formatCost(t);
  $('usageBadge').textContent = label;
  $('usageBadge').title = `Input: ${t.inputTokens || 0} tokens | Output: ${t.outputTokens || 0} tokens | Est. Cost: $${(t.estimatedCostUsd || 0).toFixed(5)}`;
}

function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabName));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${tabName}`));
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function openImageModal(dataUrl) {
  if (!dataUrl) return;
  modalImageUrl = dataUrl;
  $('imageModalImg').src = dataUrl;
  $('imageModal').classList.remove('hidden');
}

function closeImageModal() {
  $('imageModal').classList.add('hidden');
  $('imageModalImg').removeAttribute('src');
  modalImageUrl = null;
}

$('imageModalCloseBtn').addEventListener('click', closeImageModal);
$('imageModal').addEventListener('click', (e) => {
  if (e.target === $('imageModal')) closeImageModal();
});
$('imageModalDownloadBtn').addEventListener('click', async () => {
  if (!modalImageUrl) return;
  await chrome.runtime.sendMessage({
    type: 'BA_DOWNLOAD_IMAGE',
    dataUrl: modalImageUrl,
    filename: `browser-agent-${Date.now()}.png`
  });
});

function showEmptyState() {
  $('timeline').innerHTML = `
    <div class="empty-state">
      Ask Browser Agent to navigate, fill forms, extract data, or debug console/network errors.<br /><br />
      <strong>Tip:</strong> Type <code>/</code> for quick slash templates, or click <strong>Full Shot</strong> for a stitched full-page capture.
    </div>
  `;
}

function attachTtsButton(el, text) {
  if (!text || !text.trim()) return;
  const id = `tts_${++msgSeq}`;
  const footer = document.createElement('div');
  footer.className = 'msg-footer';
  const readBtn = document.createElement('button');
  readBtn.type = 'button';
  readBtn.className = 'tts-btn';
  readBtn.dataset.ttsId = id;
  readBtn.textContent = '🔊 Read';
  readBtn.addEventListener('click', () => {
    const cur = tts.getState();
    if (cur.playing && cur.activeId === id) {
      tts.stop();
    } else {
      tts.speak(text, state.settings, { id });
    }
  });
  footer.appendChild(readBtn);
  el.appendChild(footer);
}

function appendTimeline(cls, text, { thumbDataUrl = null, allowTts = (cls === 'assistant') } = {}) {
  const empty = $('timeline').querySelector('.empty-state');
  if (empty) empty.remove();

  const el = document.createElement('div');
  el.className = `msg ${cls}`;

  const body = document.createElement('div');
  body.textContent = text;
  el.appendChild(body);

  if (thumbDataUrl) {
    const wrap = document.createElement('div');
    wrap.className = 'thumb-wrap';
    const img = document.createElement('img');
    img.className = 'timeline-thumb';
    img.src = thumbDataUrl;
    img.alt = 'Step screenshot thumbnail';
    img.title = 'Click to view larger or download';
    img.addEventListener('click', () => openImageModal(thumbDataUrl));
    wrap.appendChild(img);
    el.appendChild(wrap);
  }

  if (allowTts) {
    attachTtsButton(el, text);
  }

  $('timeline').appendChild(el);
  $('timeline').scrollTop = $('timeline').scrollHeight;
}

function updateStreamingBubble(text) {
  const empty = $('timeline').querySelector('.empty-state');
  if (empty) empty.remove();
  if (!streamMsgEl) {
    streamMsgEl = document.createElement('div');
    streamMsgEl.className = 'msg assistant streaming';
    streamBodyEl = document.createElement('div');
    streamMsgEl.appendChild(streamBodyEl);
    $('timeline').appendChild(streamMsgEl);
  }
  streamBodyEl.textContent = text || '';
  $('timeline').scrollTop = $('timeline').scrollHeight;
}

function clearStreamingBubble() {
  if (streamMsgEl) {
    streamMsgEl.remove();
    streamMsgEl = null;
    streamBodyEl = null;
  }
}

function finalizeStreamingBubble(finalText, { allowTts = true } = {}) {
  if (!streamMsgEl) return false;
  const el = streamMsgEl;
  const body = streamBodyEl;
  streamMsgEl = null;
  streamBodyEl = null;
  el.classList.remove('streaming');
  const txt = finalText != null ? String(finalText) : body.textContent;
  body.textContent = txt;
  if (allowTts) {
    attachTtsButton(el, txt);
  }
  $('timeline').scrollTop = $('timeline').scrollHeight;
  return true;
}

function renderThreads() {
  clearStreamingBubble();
  const sel = $('threadSelect');
  sel.innerHTML = '';
  const threads = state.chatState?.threads || [];
  for (const t of threads) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = `${t.title || 'New Chat'} (${t.items?.length || 0})`;
    sel.appendChild(opt);
  }
  if (state.chatState?.activeThreadId) {
    sel.value = state.chatState.activeThreadId;
  }

  const active = getActiveThread();
  $('timeline').innerHTML = '';
  if (!active || !active.items || active.items.length === 0) {
    showEmptyState();
  } else {
    for (const item of active.items) {
      appendTimeline(item.kind || 'assistant', item.text || '', {
        thumbDataUrl: item.thumbDataUrl || null,
        allowTts: item.kind === 'assistant'
      });
    }
  }
  renderUsageBadge(active?.totals);
}

function renderBridgeStatus(status) {
  state.bridgeStatus = status;
  const dot = $('bridgeDot');
  const connected = String(status).startsWith('connected');
  dot.className = `dot ${connected ? 'connected' : status}`;
  $('bridgeLabel').textContent = `bridge: ${status}`;
}

function renderTabs() {
  const wrap = $('tabPills');
  wrap.innerHTML = '';
  const attachedSet = new Set(state.attachedTabIds);
  for (const t of state.tabs) {
    const pill = document.createElement('button');
    pill.className = `tab-pill ${attachedSet.has(t.id) ? 'attached' : ''}`;
    pill.textContent = `${attachedSet.has(t.id) ? '✓ ' : ''}${t.title || t.url || `Tab ${t.id}`}`;
    pill.title = `${t.title}\n${t.url}`;
    pill.addEventListener('click', async () => {
      const res = await chrome.runtime.sendMessage({ type: 'BA_TOGGLE_ATTACH_TAB', tabId: t.id });
      if (res?.ok) {
        state.attachedTabIds = res.attachedTabIds;
        renderTabs();
      }
    });
    wrap.appendChild(pill);
  }
}

async function runExport({ macroId = null, useLastRun = false, download = false } = {}) {
  const format = $('exportFormat').value || 'playwright';
  $('exportStatus').classList.remove('error');
  $('exportStatus').textContent = 'Generating script...';
  const res = await chrome.runtime.sendMessage({
    type: 'BA_EXPORT_SCRIPT',
    format,
    macroId,
    useLastRun,
    download
  });
  if (!res?.ok) {
    $('exportStatus').classList.add('error');
    $('exportStatus').textContent = res?.error || 'Export failed.';
    return;
  }
  currentExported = res;
  $('exportFilename').textContent = res.filename;
  $('exportCode').value = res.code;
  $('exportOutputBox').classList.remove('hidden');
  if (Array.isArray(res.envVars) && res.envVars.length > 0) {
    $('exportEnvNote').textContent = `Required env vars (from Vault): ${res.envVars.join(', ')}`;
    $('exportEnvNote').classList.remove('hidden');
  } else {
    $('exportEnvNote').classList.add('hidden');
  }
  $('exportStatus').textContent = download
    ? `Saved ${res.filename} to Downloads.`
    : `Generated ${res.filename}.`;
}

function extractMacroParamsLocal(macro) {
  const secrets = state.settings?.secrets && typeof state.settings.secrets === 'object' ? state.settings.secrets : {};
  const secretSet = new Set(Object.keys(secrets).map((k) => k.toUpperCase()));
  const found = new Set();
  const re = /\{\{([A-Za-z0-9_.-]+)\}\}/g;
  const walk = (v) => {
    if (typeof v === 'string') {
      re.lastIndex = 0;
      for (const m of v.matchAll(re)) {
        if (!secretSet.has(m[1].toUpperCase())) found.add(m[1]);
      }
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === 'object') {
      Object.values(v).forEach(walk);
    }
  };
  for (const s of macro?.steps || []) walk(s?.args);
  return [...found];
}

async function triggerMacroReplay(macro, params = {}) {
  switchTab('agent');
  appendTimeline('user', `Replay macro: ${macro.name}`);
  setRunning(true);
  await chrome.runtime.sendMessage({
    type: 'BA_REPLAY_MACRO',
    macroId: macro.id,
    params,
    selfHeal: $('macroSelfHeal').checked
  });
}

function openMacroParamsPrompt(macro, paramNames) {
  pendingParamMacro = macro;
  $('macroParamsTitle').textContent = `Parameters for "${macro.name}"`;
  const wrap = $('macroParamsFields');
  wrap.innerHTML = '';
  for (const p of paramNames) {
    const lbl = document.createElement('label');
    lbl.textContent = `{{${p}}}`;
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.dataset.param = p;
    inp.placeholder = `Enter value for ${p}`;
    lbl.appendChild(inp);
    wrap.appendChild(lbl);
  }
  $('macroParamsCard').classList.remove('hidden');
}

$('macroParamsCancelBtn').addEventListener('click', () => {
  pendingParamMacro = null;
  $('macroParamsCard').classList.add('hidden');
});

$('macroParamsRunBtn').addEventListener('click', async () => {
  if (!pendingParamMacro) return;
  const params = {};
  $('macroParamsFields').querySelectorAll('input[data-param]').forEach((inp) => {
    params[inp.dataset.param] = inp.value;
  });
  const m = pendingParamMacro;
  pendingParamMacro = null;
  $('macroParamsCard').classList.add('hidden');
  await triggerMacroReplay(m, params);
});

function renderMacroEditorSteps() {
  const wrap = $('editMacroSteps');
  wrap.innerHTML = '';
  if (!editMacroDraft) return;
  editMacroDraft.steps.forEach((step, idx) => {
    const row = document.createElement('div');
    row.className = 'step-edit-row';

    const head = document.createElement('div');
    head.className = 'step-edit-head';

    const num = document.createElement('span');
    num.className = 'badge';
    num.textContent = `#${idx + 1}`;

    const toolSel = document.createElement('select');
    const allTools = EDITABLE_TOOLS.includes(step.tool) ? EDITABLE_TOOLS : [step.tool, ...EDITABLE_TOOLS];
    for (const t of allTools) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      toolSel.appendChild(opt);
    }
    toolSel.value = step.tool;
    toolSel.addEventListener('change', () => {
      editMacroDraft.steps[idx].tool = toolSel.value;
    });

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'mini-btn';
    upBtn.textContent = '↑';
    upBtn.disabled = idx === 0;
    upBtn.onclick = () => {
      const tmp = editMacroDraft.steps[idx - 1];
      editMacroDraft.steps[idx - 1] = editMacroDraft.steps[idx];
      editMacroDraft.steps[idx] = tmp;
      renderMacroEditorSteps();
    };

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'mini-btn';
    downBtn.textContent = '↓';
    downBtn.disabled = idx === editMacroDraft.steps.length - 1;
    downBtn.onclick = () => {
      const tmp = editMacroDraft.steps[idx + 1];
      editMacroDraft.steps[idx + 1] = editMacroDraft.steps[idx];
      editMacroDraft.steps[idx] = tmp;
      renderMacroEditorSteps();
    };

    const rmBtn = document.createElement('button');
    rmBtn.type = 'button';
    rmBtn.className = 'mini-btn';
    rmBtn.textContent = '✕';
    rmBtn.onclick = () => {
      editMacroDraft.steps.splice(idx, 1);
      renderMacroEditorSteps();
    };

    head.append(num, toolSel, upBtn, downBtn, rmBtn);

    const argsInput = document.createElement('textarea');
    argsInput.className = 'step-edit-args';
    argsInput.rows = 2;
    argsInput.value = JSON.stringify(step.args || {});
    argsInput.addEventListener('input', () => {
      step._rawArgs = argsInput.value;
    });

    row.append(head, argsInput);
    wrap.appendChild(row);
  });
}

function openMacroEditor(macro) {
  editMacroDraft = {
    macroId: macro.id,
    name: macro.name,
    steps: JSON.parse(JSON.stringify(macro.steps || []))
  };
  $('editMacroName').value = editMacroDraft.name;
  $('macroEditStatus').textContent = '';
  $('macroEditStatus').classList.remove('error');
  renderMacroEditorSteps();
  $('macroEditorCard').classList.remove('hidden');
}

$('addEditStepBtn').addEventListener('click', () => {
  if (!editMacroDraft) return;
  editMacroDraft.steps.push({ tool: 'wait_for', args: { selector: '#target', timeoutMs: 5000 } });
  renderMacroEditorSteps();
});

$('cancelMacroEditBtn').addEventListener('click', () => {
  editMacroDraft = null;
  $('macroEditorCard').classList.add('hidden');
});

$('saveMacroEditBtn').addEventListener('click', async () => {
  if (!editMacroDraft) return;
  const statusEl = $('macroEditStatus');
  statusEl.classList.remove('error');
  const parsedSteps = [];
  for (let i = 0; i < editMacroDraft.steps.length; i++) {
    const s = editMacroDraft.steps[i];
    let args = s.args || {};
    if (s._rawArgs !== undefined) {
      try {
        args = JSON.parse(s._rawArgs || '{}');
      } catch (err) {
        statusEl.classList.add('error');
        statusEl.textContent = `Step #${i + 1} invalid JSON: ${err.message}`;
        return;
      }
    }
    parsedSteps.push({ tool: s.tool, args, label: s.label || args.selector || args.url || s.tool });
  }
  const res = await chrome.runtime.sendMessage({
    type: 'BA_UPDATE_MACRO',
    macroId: editMacroDraft.macroId,
    name: $('editMacroName').value.trim(),
    steps: parsedSteps
  });
  if (!res?.ok) {
    statusEl.classList.add('error');
    statusEl.textContent = res?.error || 'Failed to save macro.';
    return;
  }
  state.macros = res.macros || state.macros;
  editMacroDraft = null;
  $('macroEditorCard').classList.add('hidden');
  renderMacros();
});

function renderMacros() {
  const list = $('macroList');
  list.innerHTML = '';

  const sel = $('schedMacroId');
  sel.innerHTML = '';
  for (const m of state.macros || []) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = `${m.name} (${m.steps?.length || 0} steps)`;
    sel.appendChild(opt);

    const row = document.createElement('div');
    row.className = 'sched-item';
    const info = document.createElement('div');
    const pCount = extractMacroParamsLocal(m).length;
    const pNote = pCount > 0 ? ` • ${pCount} param(s)` : '';
    info.innerHTML = `<strong>${escapeHtml(m.name)}</strong><div class="sched-meta">${m.steps?.length || 0} steps • deterministic${pNote}</div>`;
    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '4px';
    actions.style.flexWrap = 'wrap';

    const playBtn = document.createElement('button');
    playBtn.className = 'mini-btn';
    playBtn.textContent = 'Replay';
    playBtn.onclick = async () => {
      const pNames = extractMacroParamsLocal(m);
      if (pNames.length > 0) {
        openMacroParamsPrompt(m, pNames);
      } else {
        await triggerMacroReplay(m, {});
      }
    };

    const editBtn = document.createElement('button');
    editBtn.className = 'mini-btn';
    editBtn.textContent = 'Edit';
    editBtn.onclick = () => openMacroEditor(m);

    const expBtn = document.createElement('button');
    expBtn.className = 'mini-btn';
    expBtn.textContent = 'Export';
    expBtn.onclick = () => runExport({ macroId: m.id });

    const delBtn = document.createElement('button');
    delBtn.className = 'mini-btn';
    delBtn.textContent = 'Delete';
    delBtn.onclick = async () => {
      const res = await chrome.runtime.sendMessage({ type: 'BA_DELETE_MACRO', macroId: m.id });
      if (res?.ok) {
        state.macros = res.macros;
        renderMacros();
      }
    };

    actions.append(playBtn, editBtn, expBtn, delBtn);
    row.append(info, actions);
    list.appendChild(row);
  }
}

function renderRecordingUi() {
  $('recStartBtn').classList.toggle('hidden', Boolean(state.isRecording));
  $('recStopBtn').classList.toggle('hidden', !state.isRecording);
  $('recStatus').textContent = state.isRecording
    ? `Recording active (${state.recordedCount || 0} steps captured)...`
    : `Not recording • Last run steps available: ${state.lastRunStepsCount || 0}`;
}

function renderSchedules() {
  const list = $('scheduleList');
  list.innerHTML = '';
  for (const s of state.schedules) {
    const row = document.createElement('div');
    row.className = 'sched-item';
    const info = document.createElement('div');
    const kind = s.macroId ? 'Macro ($0)' : 'Prompt';
    const lastRun = s.lastRunAt ? ` • Last: ${new Date(s.lastRunAt).toLocaleTimeString()} (${s.lastStatus || 'done'})` : '';
    info.innerHTML = `<strong>${escapeHtml(s.name)}</strong><div class="sched-meta">${kind} • Every ${s.intervalMinutes}m • ${s.enabled ? 'Enabled' : 'Paused'}${escapeHtml(lastRun)}</div>`;
    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '6px';

    const runNowBtn = document.createElement('button');
    runNowBtn.className = 'mini-btn';
    runNowBtn.textContent = 'Run';
    runNowBtn.onclick = async () => {
      switchTab('agent');
      setRunning(true);
      await chrome.runtime.sendMessage({ type: 'BA_RUN_SCHEDULE_NOW', scheduleId: s.id });
    };

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'mini-btn';
    toggleBtn.textContent = s.enabled ? 'Pause' : 'Enable';
    toggleBtn.onclick = async () => {
      s.enabled = !s.enabled;
      await chrome.runtime.sendMessage({ type: 'BA_SAVE_SCHEDULES', schedules: state.schedules });
      renderSchedules();
    };

    const delBtn = document.createElement('button');
    delBtn.className = 'mini-btn';
    delBtn.textContent = 'Delete';
    delBtn.onclick = async () => {
      state.schedules = state.schedules.filter((x) => x.id !== s.id);
      await chrome.runtime.sendMessage({ type: 'BA_SAVE_SCHEDULES', schedules: state.schedules });
      renderSchedules();
    };

    actions.append(runNowBtn, toggleBtn, delBtn);
    row.append(info, actions);
    list.appendChild(row);
  }
}

function isLocalUrlProvider(provider) {
  return provider === 'ollama' || provider === 'custom';
}

function syncProviderFields({ providerEl, baseUrlRowEl, baseUrlEl, modelEl, apiKeyEl }) {
  const provider = providerEl.value;
  const local = isLocalUrlProvider(provider);
  baseUrlRowEl.classList.toggle('hidden', !local);
  if (providerEl === $('cfgProvider')) {
    $('cfgContextRow').classList.toggle('hidden', provider !== 'ollama');
  }
  if (local) {
    baseUrlEl.placeholder = DEFAULT_BASE_URLS[provider] || '';
    if (!baseUrlEl.value.trim()) baseUrlEl.value = DEFAULT_BASE_URLS[provider] || '';
  }
  modelEl.placeholder = DEFAULT_MODELS[provider] || '';
  if (apiKeyEl) {
    apiKeyEl.placeholder = local
      ? '(optional for Ollama / local endpoint)'
      : (providerEl === $('cfgEscProvider') ? 'Optional if same provider or local' : 'sk-... / AIza...');
  }
}

function bindProviderPicker({
  providerId, baseUrlRowId, baseUrlId, modelId, apiKeyId,
  fetchBtnId, listId, selectId, statusId
}) {
  const providerEl = $(providerId);
  const baseUrlRowEl = $(baseUrlRowId);
  const baseUrlEl = $(baseUrlId);
  const modelEl = $(modelId);
  const apiKeyEl = $(apiKeyId);
  const selectEl = $(selectId);
  const listEl = $(listId);
  const statusEl = $(statusId);

  providerEl.addEventListener('change', () => {
    const cur = modelEl.value.trim();
    if (!cur || Object.values(DEFAULT_MODELS).includes(cur)) {
      modelEl.value = DEFAULT_MODELS[providerEl.value] || '';
    }
    selectEl.classList.add('hidden');
    statusEl.textContent = '';
    statusEl.classList.remove('error');
    syncProviderFields({ providerEl, baseUrlRowEl, baseUrlEl, modelEl, apiKeyEl });
  });

  selectEl.addEventListener('change', () => {
    if (selectEl.value) modelEl.value = selectEl.value;
  });

  $(fetchBtnId).addEventListener('click', async () => {
    statusEl.classList.remove('error');
    statusEl.textContent = 'Fetching models...';
    const res = await chrome.runtime.sendMessage({
      type: 'BA_FETCH_MODELS',
      provider: providerEl.value,
      baseUrl: baseUrlEl.value.trim(),
      apiKey: apiKeyEl.value.trim()
    });
    if (!res?.ok) {
      statusEl.classList.add('error');
      statusEl.textContent = res?.error || 'Failed to load models.';
      return;
    }
    const models = res.models || [];
    listEl.innerHTML = models.map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');
    if (models.length > 0) {
      selectEl.innerHTML = ['<option value="">-- Pick fetched model --</option>', ...models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`)].join('');
      selectEl.classList.remove('hidden');
      if (models.includes(modelEl.value.trim())) selectEl.value = modelEl.value.trim();
    } else {
      selectEl.classList.add('hidden');
    }
    statusEl.textContent = `Loaded ${models.length} model(s).`;
  });
}

bindProviderPicker({
  providerId: 'cfgProvider',
  baseUrlRowId: 'cfgBaseUrlRow',
  baseUrlId: 'cfgBaseUrl',
  modelId: 'cfgModel',
  apiKeyId: 'cfgApiKey',
  fetchBtnId: 'fetchModelsBtn',
  listId: 'cfgModelsList',
  selectId: 'cfgFetchedModels',
  statusId: 'fetchModelsStatus'
});

bindProviderPicker({
  providerId: 'cfgEscProvider',
  baseUrlRowId: 'cfgEscBaseUrlRow',
  baseUrlId: 'cfgEscBaseUrl',
  modelId: 'cfgEscModel',
  apiKeyId: 'cfgEscApiKey',
  fetchBtnId: 'fetchEscModelsBtn',
  listId: 'cfgEscModelsList',
  selectId: 'cfgEscFetchedModels',
  statusId: 'fetchEscModelsStatus'
});

$('cfgDualRouting').addEventListener('change', () => {
  $('dualRoutingFields').classList.toggle('hidden', !$('cfgDualRouting').checked);
});

// --- TTS Settings Helpers ---
function syncTtsFields() {
  const isMac = $('cfgTtsEngine').value === 'macos';
  $('cfgTtsApiFields').classList.toggle('hidden', isMac);
  $('cfgTtsMacFields').classList.toggle('hidden', !isMac);
}

async function refreshMacVoiceSelect(preferredVoice = null) {
  const voices = await tts.getMacVoices();
  const sel = $('cfgTtsMacVoice');
  const current = preferredVoice ?? sel.value;
  sel.innerHTML = '<option value="">Auto (best available)</option>';
  const sorted = voices.slice().sort((a, b) => scoreMacVoice(b) - scoreMacVoice(a));
  for (const v of sorted) {
    const opt = document.createElement('option');
    opt.value = v.name;
    const q = getMacVoiceQuality(v);
    opt.textContent = `${v.name} (${v.lang})${q !== 'Standard' ? ` · ${q}` : ''}`;
    sel.appendChild(opt);
  }
  if (current && [...sel.options].some((o) => o.value === current)) {
    sel.value = current;
  }
  $('ttsStatus').classList.remove('error');
  $('ttsStatus').textContent = `Found ${voices.length} system voice(s).`;
}

$('cfgTtsEngine').addEventListener('change', async () => {
  syncTtsFields();
  if ($('cfgTtsEngine').value === 'macos') {
    await refreshMacVoiceSelect(state.settings?.ttsMacVoice || '');
  }
});

$('cfgTtsSpeed').addEventListener('input', () => {
  $('cfgTtsSpeedVal').textContent = `${Number($('cfgTtsSpeed').value).toFixed(1)}×`;
});

$('refreshMacVoicesBtn').addEventListener('click', () => refreshMacVoiceSelect());

$('testTtsBtn').addEventListener('click', async () => {
  $('ttsStatus').classList.remove('error');
  $('ttsStatus').textContent = 'Checking TTS service...';
  const res = await chrome.runtime.sendMessage({
    type: 'BA_TTS_HEALTH',
    serviceUrl: $('cfgTtsUrl').value.trim()
  });
  if (res?.ok) {
    const h = res.health || {};
    $('ttsStatus').textContent = `Connected • ${h.model || 'Kokoro'} • ${h.cuda ? 'GPU' : 'CPU'}`;
  } else {
    $('ttsStatus').classList.add('error');
    $('ttsStatus').textContent = res?.error || 'TTS service unreachable.';
  }
});

$('fetchTtsVoicesBtn').addEventListener('click', async () => {
  $('ttsStatus').classList.remove('error');
  $('ttsStatus').textContent = 'Loading Kokoro voices...';
  const res = await chrome.runtime.sendMessage({
    type: 'BA_TTS_VOICES',
    serviceUrl: $('cfgTtsUrl').value.trim()
  });
  if (!res?.ok) {
    $('ttsStatus').classList.add('error');
    $('ttsStatus').textContent = res?.error || 'Failed to fetch voices.';
    return;
  }
  const payload = res.voices?.voices || res.voices || {};
  const names = [];
  if (Array.isArray(payload)) {
    for (const v of payload) names.push(typeof v === 'string' ? v : (v.id || v.name));
  } else if (payload && typeof payload === 'object') {
    for (const list of Object.values(payload)) {
      if (Array.isArray(list)) {
        for (const v of list) names.push(typeof v === 'string' ? v : (v.id || v.name));
      }
    }
  }
  const unique = [...new Set(names.filter(Boolean))];
  $('cfgTtsVoicesList').innerHTML = unique.map((v) => `<option value="${escapeHtml(v)}"></option>`).join('');
  $('ttsStatus').textContent = `Loaded ${unique.length} Kokoro voice(s).`;
});

// --- Custom Slash Templates UI ---
function renderCustomSlashTemplates() {
  const list = $('customSlashList');
  list.innerHTML = '';
  const items = Array.isArray(state.settings?.slashTemplates) ? state.settings.slashTemplates : [];
  if (items.length === 0) {
    list.innerHTML = '<div class="sched-meta">No custom slash commands yet.</div>';
    return;
  }
  items.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'sched-item';
    const info = document.createElement('div');
    info.innerHTML = `<span class="vault-token">${escapeHtml(item.cmd)}</span><div class="sched-meta">${escapeHtml(item.desc || item.prompt)}</div>`;
    const delBtn = document.createElement('button');
    delBtn.className = 'mini-btn';
    delBtn.textContent = 'Delete';
    delBtn.onclick = async () => {
      const next = items.filter((_, i) => i !== idx);
      const res = await chrome.runtime.sendMessage({ type: 'BA_SAVE_SETTINGS', settings: { slashTemplates: next } });
      if (res?.ok) {
        state.settings = res.settings;
        renderCustomSlashTemplates();
      }
    };
    row.append(info, delBtn);
    list.appendChild(row);
  });
}

$('addSlashBtn').addEventListener('click', async () => {
  const statusEl = $('slashStatus');
  statusEl.classList.remove('error');
  let cmd = $('slashCmdInput').value.trim().toLowerCase().replace(/\s+/g, '-');
  if (cmd && !cmd.startsWith('/')) cmd = `/${cmd}`;
  const desc = $('slashDescInput').value.trim();
  const prompt = $('slashPromptInput').value.trim();
  if (!cmd || cmd.length < 2 || !prompt) {
    statusEl.classList.add('error');
    statusEl.textContent = 'Provide both a /command name and prompt (or macro:Name).';
    return;
  }
  const existing = Array.isArray(state.settings?.slashTemplates) ? state.settings.slashTemplates : [];
  const next = [...existing.filter((t) => t.cmd !== cmd), { cmd, desc: desc || prompt.slice(0, 60), prompt }];
  const res = await chrome.runtime.sendMessage({ type: 'BA_SAVE_SETTINGS', settings: { slashTemplates: next } });
  if (res?.ok) {
    state.settings = res.settings;
    $('slashCmdInput').value = '';
    $('slashDescInput').value = '';
    $('slashPromptInput').value = '';
    renderCustomSlashTemplates();
    statusEl.textContent = `Saved ${cmd}.`;
    setTimeout(() => { statusEl.textContent = ''; }, 2500);
  }
});

function renderVaultSecrets() {
  const list = $('vaultList');
  list.innerHTML = '';
  const secrets = state.settings?.secrets && typeof state.settings.secrets === 'object' ? state.settings.secrets : {};
  const entries = Object.keys(secrets);
  if (entries.length === 0) {
    list.innerHTML = '<div class="sched-meta">No secrets configured yet.</div>';
    return;
  }
  for (const name of entries) {
    const row = document.createElement('div');
    row.className = 'sched-item';
    const info = document.createElement('div');
    info.innerHTML = `<span class="vault-token">{{${escapeHtml(name)}}}</span><div class="sched-meta">•••••••• (stored locally)</div>`;
    const delBtn = document.createElement('button');
    delBtn.className = 'mini-btn';
    delBtn.textContent = 'Delete';
    delBtn.onclick = async () => {
      const nextSecrets = { ...(state.settings.secrets || {}) };
      delete nextSecrets[name];
      const res = await chrome.runtime.sendMessage({ type: 'BA_SAVE_SETTINGS', settings: { secrets: nextSecrets } });
      if (res?.ok) {
        state.settings = res.settings;
        renderVaultSecrets();
      }
    };
    row.append(info, delBtn);
    list.appendChild(row);
  }
}

$('addSecretBtn').addEventListener('click', async () => {
  const statusEl = $('vaultStatus');
  statusEl.classList.remove('error');
  const rawName = $('vaultName').value.trim();
  const normalized = rawName.toUpperCase().replace(/[^A-Z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '');
  const val = $('vaultValue').value;
  if (!normalized || !val) {
    statusEl.classList.add('error');
    statusEl.textContent = 'Provide both a secret name and value.';
    return;
  }
  const nextSecrets = { ...(state.settings?.secrets || {}), [normalized]: val };
  const res = await chrome.runtime.sendMessage({ type: 'BA_SAVE_SETTINGS', settings: { secrets: nextSecrets } });
  if (res?.ok) {
    state.settings = res.settings;
    $('vaultName').value = '';
    $('vaultValue').value = '';
    renderVaultSecrets();
    statusEl.textContent = `Saved {{${normalized}}}.`;
    setTimeout(() => { statusEl.textContent = ''; }, 2500);
  }
});

function populateSettings() {
  const s = state.settings;
  $('cfgProvider').value = s.provider || 'anthropic';
  $('cfgBaseUrl').value = s.baseUrl || DEFAULT_BASE_URLS[s.provider] || '';
  $('cfgContextLength').value = s.ollamaContextLength || 8192;
  $('cfgModel').value = s.model || '';
  $('cfgApiKey').value = s.apiKey || '';
  $('cfgIncludeVision').checked = s.includeVision !== false;
  $('cfgStreamResponses').checked = s.streamResponses !== false;
  $('cfgMaxSteps').value = s.maxSteps || 20;

  $('cfgDualRouting').checked = Boolean(s.dualRoutingEnabled);
  $('dualRoutingFields').classList.toggle('hidden', !s.dualRoutingEnabled);
  $('cfgEscProvider').value = s.escalationProvider || 'gemini';
  $('cfgEscBaseUrl').value = s.escalationBaseUrl || DEFAULT_BASE_URLS[s.escalationProvider] || '';
  $('cfgEscModel').value = s.escalationModel || '';
  $('cfgEscApiKey').value = s.escalationApiKey || '';

  $('cfgTtsAutoRead').checked = Boolean(s.ttsAutoRead);
  $('autoReadQuick').checked = Boolean(s.ttsAutoRead);
  $('cfgTtsEngine').value = s.ttsEngine === 'macos' ? 'macos' : 'api';
  $('cfgTtsUrl').value = s.ttsServiceUrl || DEFAULT_TTS_SETTINGS.ttsServiceUrl;
  $('cfgTtsVoice').value = s.ttsVoice || DEFAULT_TTS_SETTINGS.ttsVoice;
  const spd = Number(s.ttsSpeed ?? DEFAULT_TTS_SETTINGS.ttsSpeed) || 1.0;
  $('cfgTtsSpeed').value = spd;
  $('cfgTtsSpeedVal').textContent = `${spd.toFixed(1)}×`;
  syncTtsFields();
  if ($('cfgTtsEngine').value === 'macos') {
    refreshMacVoiceSelect(s.ttsMacVoice || '');
  }

  $('cfgAutoApprove').checked = s.autoApproveLowRisk !== false;
  $('cfgAllowlist').value = s.domainAllowlist || '';
  $('cfgBlocklist').value = s.domainBlocklist || '';
  $('cfgBridgeEnabled').checked = s.bridgeEnabled !== false;
  $('cfgNativeBridgeEnabled').checked = s.nativeBridgeEnabled !== false;
  $('cfgBridgeUrl').value = s.bridgeUrl || 'ws://127.0.0.1:19222/ws';
  $('extIdNote').textContent = state.extensionId
    ? `Extension ID: ${state.extensionId} (install native host once via: node browser-agent/bridge/install-native-host.mjs)`
    : '';
  syncProviderFields({
    providerEl: $('cfgProvider'),
    baseUrlRowEl: $('cfgBaseUrlRow'),
    baseUrlEl: $('cfgBaseUrl'),
    modelEl: $('cfgModel'),
    apiKeyEl: $('cfgApiKey')
  });
  syncProviderFields({
    providerEl: $('cfgEscProvider'),
    baseUrlRowEl: $('cfgEscBaseUrlRow'),
    baseUrlEl: $('cfgEscBaseUrl'),
    modelEl: $('cfgEscModel'),
    apiKeyEl: $('cfgEscApiKey')
  });
  renderCustomSlashTemplates();
  renderVaultSecrets();
}

function setRunning(running) {
  state.running = running;
  $('stopBtn').classList.toggle('hidden', !running);
  $('sendBtn').disabled = running;
  if (!running) $('thinkingIndicator').classList.add('hidden');
}

async function loadState() {
  const res = await chrome.runtime.sendMessage({ type: 'BA_GET_STATE' });
  if (!res?.ok) return;
  state = res;
  renderBridgeStatus(res.bridgeStatus);
  renderTabs();
  renderThreads();
  renderMacros();
  renderRecordingUi();
  renderSchedules();
  populateSettings();
  setRunning(res.running);
}

// --- Slash Command Templates ---
function renderSlashMenu(filterPrefix = '', forceShow = false) {
  const menu = $('slashMenu');
  const query = filterPrefix.toLowerCase();
  const catalog = getAllSlashTemplates();
  const matches = catalog.filter((t) => !query || t.cmd.startsWith(query));
  if (!forceShow && (!query.startsWith('/') || matches.length === 0)) {
    menu.classList.add('hidden');
    return;
  }
  const items = matches.length ? matches : catalog;
  menu.innerHTML = '';
  for (const item of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'slash-item';
    btn.innerHTML = `<span class="slash-cmd">${escapeHtml(item.cmd)}</span><span class="slash-desc">${escapeHtml(item.desc)}</span>`;
    btn.addEventListener('click', () => {
      $('promptInput').value = item.prompt;
      menu.classList.add('hidden');
      $('promptInput').focus();
    });
    menu.appendChild(btn);
  }
  menu.classList.remove('hidden');
}

$('slashBtn').addEventListener('click', () => {
  const menu = $('slashMenu');
  if (menu.classList.contains('hidden')) {
    renderSlashMenu('/', true);
  } else {
    menu.classList.add('hidden');
  }
});

$('promptInput').addEventListener('input', () => {
  const val = $('promptInput').value;
  if (val.startsWith('/') && !val.includes(' ') && !val.includes('\n')) {
    renderSlashMenu(val.trim(), false);
  } else {
    $('slashMenu').classList.add('hidden');
  }
});

$('fullShotBtn').addEventListener('click', async () => {
  if (state.running) return;
  $('fullShotBtn').disabled = true;
  appendTimeline('bridge', '📷 Capturing full-page screenshot...');
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const res = await chrome.runtime.sendMessage({
      type: 'BA_CAPTURE_FULL_PAGE',
      ...(activeTab?.id != null ? { tabId: activeTab.id } : {}),
      download: true
    });
    if (res?.ok) {
      appendTimeline('tool', `📷 ${res.summary}`, { thumbDataUrl: res.thumbDataUrl || null });
    } else {
      appendTimeline('error', res?.error || 'Full-page capture failed.');
    }
  } finally {
    $('fullShotBtn').disabled = false;
  }
});

$('detachDebugBtn').addEventListener('click', async () => {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const res = await chrome.runtime.sendMessage({
    type: 'BA_DETACH_DEBUGGER',
    ...(activeTab?.id != null ? { tabId: activeTab.id } : {})
  });
  appendTimeline('bridge', res?.detached ? '🧹 Detached Chrome debugger from active tab.' : 'ℹ Debugger is not attached to active tab.');
});

$('stopTtsBtn').addEventListener('click', () => tts.stop());

$('autoReadQuick').addEventListener('change', async () => {
  const checked = $('autoReadQuick').checked;
  $('cfgTtsAutoRead').checked = checked;
  const res = await chrome.runtime.sendMessage({ type: 'BA_SAVE_SETTINGS', settings: { ttsAutoRead: checked } });
  if (res?.ok) state.settings = res.settings;
});

// --- Thread Controls ---
$('threadSelect').addEventListener('change', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'BA_SELECT_THREAD', threadId: $('threadSelect').value });
  if (res?.ok) {
    state.chatState = res.chatState;
    renderThreads();
  }
});

$('newThreadBtn').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'BA_NEW_THREAD' });
  if (res?.ok) {
    state.chatState = res.chatState;
    renderThreads();
  }
});

$('clearThreadBtn').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'BA_CLEAR_THREAD', threadId: state.chatState?.activeThreadId });
  if (res?.ok) {
    state.chatState = res.chatState;
    renderThreads();
  }
});

$('delThreadBtn').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'BA_DELETE_THREAD', threadId: state.chatState?.activeThreadId });
  if (res?.ok) {
    state.chatState = res.chatState;
    renderThreads();
  }
});

$('refreshTabsBtn').addEventListener('click', loadState);
$('reconnectBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'BA_RECONNECT_BRIDGE' });
  await loadState();
});

$('promptForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  let prompt = $('promptInput').value.trim();
  if (!prompt || state.running) return;
  const slashMatch = getAllSlashTemplates().find((t) => t.cmd === prompt.toLowerCase());
  if (slashMatch) prompt = slashMatch.prompt;

  $('slashMenu').classList.add('hidden');
  $('promptInput').value = '';

  if (prompt.toLowerCase().startsWith('macro:')) {
    const targetName = prompt.slice(6).trim();
    const macro = (state.macros || []).find((m) => m.name.toLowerCase() === targetName.toLowerCase());
    if (macro) {
      const pNames = extractMacroParamsLocal(macro);
      if (pNames.length > 0) {
        switchTab('macros');
        openMacroParamsPrompt(macro, pNames);
      } else {
        await triggerMacroReplay(macro, {});
      }
      return;
    }
  }

  appendTimeline('user', prompt);
  setRunning(true);
  await chrome.runtime.sendMessage({
    type: 'BA_RUN_PROMPT',
    prompt,
    threadId: state.chatState?.activeThreadId
  });
});

$('promptInput').addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !$('slashMenu').classList.contains('hidden')) {
    const first = $('slashMenu').querySelector('.slash-item');
    if (first) {
      e.preventDefault();
      first.click();
      return;
    }
  }
  if (e.key === 'Escape' && !$('slashMenu').classList.contains('hidden')) {
    $('slashMenu').classList.add('hidden');
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('promptForm').requestSubmit();
  }
});

$('stopBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'BA_STOP_RUN' });
  setRunning(false);
  clearStreamingBubble();
  $('approvalCard').classList.add('hidden');
  $('handoffCard').classList.add('hidden');
});

$('approveBtn').addEventListener('click', async () => {
  if (!pendingApprovalId) return;
  await chrome.runtime.sendMessage({ type: 'BA_APPROVAL_RESPONSE', id: pendingApprovalId, approved: true });
  pendingApprovalId = null;
  $('approvalCard').classList.add('hidden');
});

$('denyBtn').addEventListener('click', async () => {
  if (!pendingApprovalId) return;
  await chrome.runtime.sendMessage({ type: 'BA_APPROVAL_RESPONSE', id: pendingApprovalId, approved: false });
  pendingApprovalId = null;
  $('approvalCard').classList.add('hidden');
});

$('handoffResumeBtn').addEventListener('click', async () => {
  if (!pendingHandoffId) return;
  const note = $('handoffNote').value.trim();
  await chrome.runtime.sendMessage({ type: 'BA_HANDOFF_RESPONSE', id: pendingHandoffId, resumed: true, note });
  pendingHandoffId = null;
  $('handoffNote').value = '';
  $('handoffCard').classList.add('hidden');
});

$('handoffCancelBtn').addEventListener('click', async () => {
  if (!pendingHandoffId) return;
  await chrome.runtime.sendMessage({ type: 'BA_HANDOFF_RESPONSE', id: pendingHandoffId, resumed: false });
  pendingHandoffId = null;
  $('handoffNote').value = '';
  $('handoffCard').classList.add('hidden');
});

$('schedType').addEventListener('change', () => {
  const isMacro = $('schedType').value === 'macro';
  $('schedPromptRow').classList.toggle('hidden', isMacro);
  $('schedMacroRow').classList.toggle('hidden', !isMacro);
});

$('recStartBtn').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'BA_START_RECORDING' });
  if (res?.ok) {
    state.isRecording = true;
    state.recordedCount = res.count || 0;
    renderRecordingUi();
  }
});

$('recStopBtn').addEventListener('click', async () => {
  const name = $('macroName').value.trim();
  const res = await chrome.runtime.sendMessage({ type: 'BA_STOP_RECORDING', save: true, name });
  if (res?.ok) {
    state.isRecording = false;
    state.recordedCount = 0;
    state.macros = res.macros || state.macros;
    $('macroName').value = '';
    renderMacros();
    renderRecordingUi();
  }
});

$('saveLastRunBtn').addEventListener('click', async () => {
  const name = $('macroName').value.trim();
  const res = await chrome.runtime.sendMessage({ type: 'BA_SAVE_LAST_RUN_MACRO', name });
  if (res?.ok) {
    state.macros = res.macros || state.macros;
    $('macroName').value = '';
    renderMacros();
  } else if (res?.error) {
    $('recStatus').textContent = res.error;
  }
});

$('exportLastRunBtn').addEventListener('click', () => runExport({ useLastRun: true }));
$('copyExportBtn').addEventListener('click', async () => {
  if (!currentExported?.code) return;
  await navigator.clipboard.writeText(currentExported.code);
  $('exportStatus').textContent = `Copied ${currentExported.filename} to clipboard.`;
});
$('downloadExportBtn').addEventListener('click', async () => {
  if (!currentExported?.code) return;
  const dataUrl = `data:text/plain;charset=utf-8,${encodeURIComponent(currentExported.code)}`;
  await chrome.runtime.sendMessage({
    type: 'BA_DOWNLOAD_IMAGE',
    dataUrl,
    filename: currentExported.filename
  });
  $('exportStatus').textContent = `Downloaded ${currentExported.filename}.`;
});

$('addSchedBtn').addEventListener('click', async () => {
  const name = $('schedName').value.trim();
  const isMacro = $('schedType').value === 'macro';
  const prompt = $('schedPrompt').value.trim();
  const macroId = $('schedMacroId').value;
  const intervalMinutes = Math.max(1, Number($('schedInterval').value) || 60);
  if (!name || (!isMacro && !prompt) || (isMacro && !macroId)) return;
  state.schedules.push({
    id: String(Date.now()),
    name,
    prompt: isMacro ? '' : prompt,
    macroId: isMacro ? macroId : null,
    intervalMinutes,
    enabled: true
  });
  await chrome.runtime.sendMessage({ type: 'BA_SAVE_SCHEDULES', schedules: state.schedules });
  $('schedName').value = '';
  $('schedPrompt').value = '';
  renderSchedules();
});

$('saveSettingsBtn').addEventListener('click', async () => {
  const settings = {
    provider: $('cfgProvider').value,
    baseUrl: $('cfgBaseUrl').value.trim(),
    ollamaContextLength: Math.max(2048, Number($('cfgContextLength').value) || 8192),
    model: $('cfgModel').value.trim(),
    apiKey: $('cfgApiKey').value.trim(),
    includeVision: $('cfgIncludeVision').checked,
    streamResponses: $('cfgStreamResponses').checked,
    dualRoutingEnabled: $('cfgDualRouting').checked,
    escalationProvider: $('cfgEscProvider').value,
    escalationBaseUrl: $('cfgEscBaseUrl').value.trim(),
    escalationModel: $('cfgEscModel').value.trim(),
    escalationApiKey: $('cfgEscApiKey').value.trim(),
    maxSteps: Number($('cfgMaxSteps').value) || 20,
    ttsAutoRead: $('cfgTtsAutoRead').checked,
    ttsEngine: $('cfgTtsEngine').value,
    ttsServiceUrl: $('cfgTtsUrl').value.trim() || DEFAULT_TTS_SETTINGS.ttsServiceUrl,
    ttsVoice: $('cfgTtsVoice').value.trim() || DEFAULT_TTS_SETTINGS.ttsVoice,
    ttsMacVoice: $('cfgTtsMacVoice').value,
    ttsSpeed: Number($('cfgTtsSpeed').value) || 1.0,
    autoApproveLowRisk: $('cfgAutoApprove').checked,
    domainAllowlist: $('cfgAllowlist').value,
    domainBlocklist: $('cfgBlocklist').value,
    bridgeEnabled: $('cfgBridgeEnabled').checked,
    nativeBridgeEnabled: $('cfgNativeBridgeEnabled').checked,
    bridgeUrl: $('cfgBridgeUrl').value.trim()
  };
  const res = await chrome.runtime.sendMessage({ type: 'BA_SAVE_SETTINGS', settings });
  if (res?.ok) {
    state.settings = res.settings;
    $('autoReadQuick').checked = Boolean(res.settings.ttsAutoRead);
    $('saveStatus').textContent = 'Settings saved!';
    setTimeout(() => { $('saveStatus').textContent = ''; }, 2000);
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'BA_BRIDGE_STATUS') {
    renderBridgeStatus(msg.status);
  } else if (msg.type === 'BA_BRIDGE_ACTIVITY') {
    if (typeof msg.lastRunStepsCount === 'number') {
      state.lastRunStepsCount = msg.lastRunStepsCount;
      renderRecordingUi();
    }
    appendTimeline('bridge', `[agy] ${msg.tool}(${JSON.stringify(msg.args || {})}) → ${msg.ok ? 'ok' : 'error'}`);
  } else if (msg.type === 'BA_SETTINGS_UPDATED') {
    state.settings = msg.settings || state.settings;
    populateSettings();
  } else if (msg.type === 'BA_RECORDING_COUNT') {
    state.recordedCount = msg.count || 0;
    renderRecordingUi();
  } else if (msg.type === 'BA_MACROS_UPDATED') {
    state.macros = msg.macros || [];
    renderMacros();
  } else if (msg.type === 'BA_SCHEDULES_UPDATED') {
    state.schedules = msg.schedules || [];
    renderSchedules();
  } else if (msg.type === 'BA_AGENT_EVENT') {
    if (msg.threadId && state.chatState?.activeThreadId && msg.threadId !== state.chatState.activeThreadId) {
      return;
    }
    const ev = msg.event;
    if (ev.type === 'thinking') {
      $('thinkingIndicator').textContent = `⏳ Step ${ev.step}: thinking (${ev.model || ev.provider})...`;
      $('thinkingIndicator').classList.remove('hidden');
    } else if (ev.type === 'assistant_delta') {
      $('thinkingIndicator').classList.add('hidden');
      updateStreamingBubble(ev.text);
    } else if (ev.type === 'usage') {
      if (ev.threadTotals) renderUsageBadge(ev.threadTotals);
    } else if (ev.type === 'assistant_text') {
      $('thinkingIndicator').classList.add('hidden');
      if (!finalizeStreamingBubble(ev.text, { allowTts: true })) {
        appendTimeline('assistant', ev.text);
      }
    } else if (ev.type === 'status') {
      appendTimeline('bridge', `ℹ ${ev.text}`);
    } else if (ev.type === 'tool_start') {
      clearStreamingBubble();
      $('thinkingIndicator').textContent = `⚙ Step ${ev.step}: running ${ev.tool}...`;
      $('thinkingIndicator').classList.remove('hidden');
      appendTimeline('tool', `▶ Step ${ev.step}: ${ev.tool}(${JSON.stringify(ev.args || {})})`);
    } else if (ev.type === 'tool_result') {
      const summary = ev.result?.ok === false ? `ERR: ${ev.result.error}` : 'ok';
      appendTimeline('tool', `✓ ${ev.tool} → ${summary}`, { thumbDataUrl: ev.thumbDataUrl || null });
    }
  } else if (msg.type === 'BA_RUN_DONE') {
    setRunning(false);
    if (typeof msg.lastRunStepsCount === 'number') {
      state.lastRunStepsCount = msg.lastRunStepsCount;
      renderRecordingUi();
    }
    if (msg.threadTotals) renderUsageBadge(msg.threadTotals);
    if (!msg.threadId || msg.threadId === state.chatState?.activeThreadId) {
      if (!finalizeStreamingBubble(msg.text, { allowTts: true })) {
        appendTimeline('assistant', msg.text);
      }
      if (state.settings?.ttsAutoRead && msg.text) {
        tts.speak(msg.text, state.settings, { id: `auto_${Date.now()}` });
      }
    } else {
      clearStreamingBubble();
    }
  } else if (msg.type === 'BA_RUN_ERROR') {
    setRunning(false);
    clearStreamingBubble();
    if (!msg.threadId || msg.threadId === state.chatState?.activeThreadId) {
      appendTimeline('error', msg.error);
    }
  } else if (msg.type === 'BA_APPROVAL_REQUEST') {
    pendingApprovalId = msg.id;
    $('approvalReason').textContent = msg.details?.reason || 'Confirm action?';
    $('approvalDetails').textContent = `${msg.details?.toolName}(${JSON.stringify(msg.details?.args || {})})`;
    $('approvalCard').classList.remove('hidden');
  } else if (msg.type === 'BA_HANDOFF_REQUEST') {
    pendingHandoffId = msg.id;
    $('handoffReason').textContent = msg.details?.reason || 'Human input requested';
    $('handoffQuestion').textContent = msg.details?.question || 'Complete the action on the page, then click Resume.';
    $('handoffCard').classList.remove('hidden');
  }
});

loadState();
