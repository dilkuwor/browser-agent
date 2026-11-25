// Deterministic macro storage, parameter substitution, step editing, and zero-LLM replay with self-healing writeback.

const RECORDABLE_TOOLS = new Set([
  'navigate', 'open_tab', 'click', 'type', 'select_option', 'fill_form', 'upload_file', 'drag_and_drop', 'scroll', 'press_key', 'wait', 'wait_for'
]);

const TOKEN_RE = /\{\{([A-Za-z0-9_.-]+)\}\}/g;

export async function getMacros() {
  const stored = await chrome.storage.local.get('macros');
  return stored.macros || [];
}

export async function saveMacro({ name, steps }) {
  const cleanName = String(name || '').trim() || `Macro ${new Date().toLocaleTimeString()}`;
  const cleanSteps = Array.isArray(steps) ? steps.filter((s) => s && s.tool) : [];
  const macros = await getMacros();
  const macro = {
    id: `mac_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: cleanName,
    createdAt: Date.now(),
    steps: cleanSteps
  };
  macros.unshift(macro);
  await chrome.storage.local.set({ macros });
  return macro;
}

export async function updateMacro(macroId, patch = {}) {
  const macros = await getMacros();
  const idx = macros.findIndex((m) => m.id === macroId);
  if (idx < 0) return { ok: false, error: `Macro not found: ${macroId}` };
  const current = macros[idx];
  const next = {
    ...current,
    ...(patch.name != null ? { name: String(patch.name).trim() || current.name } : {}),
    ...(Array.isArray(patch.steps) ? { steps: patch.steps.filter((s) => s && s.tool) } : {}),
    updatedAt: Date.now()
  };
  macros[idx] = next;
  await chrome.storage.local.set({ macros });
  return { ok: true, macro: next, macros };
}

export async function deleteMacro(macroId) {
  const macros = await getMacros();
  const next = macros.filter((m) => m.id !== macroId);
  await chrome.storage.local.set({ macros: next });
  return next;
}

export function extractMacroParams(macro, secretNames = []) {
  const secretSet = new Set((secretNames || []).map((s) => String(s).toUpperCase()));
  const found = new Set();
  const walk = (val) => {
    if (typeof val === 'string') {
      TOKEN_RE.lastIndex = 0;
      for (const m of val.matchAll(TOKEN_RE)) {
        const key = m[1];
        if (!secretSet.has(key.toUpperCase())) found.add(key);
      }
    } else if (Array.isArray(val)) {
      val.forEach(walk);
    } else if (val && typeof val === 'object') {
      Object.values(val).forEach(walk);
    }
  };
  for (const step of macro?.steps || []) {
    walk(step?.args);
  }
  return [...found];
}

export function substituteMacroParams(val, params = {}) {
  if (!params || typeof params !== 'object') return val;
  if (typeof val === 'string') {
    return val.replace(TOKEN_RE, (match, name) => {
      if (Object.prototype.hasOwnProperty.call(params, name) && params[name] !== undefined) {
        return String(params[name]);
      }
      const upper = name.toUpperCase();
      if (Object.prototype.hasOwnProperty.call(params, upper) && params[upper] !== undefined) {
        return String(params[upper]);
      }
      return match;
    });
  }
  if (Array.isArray(val)) {
    return val.map((item) => substituteMacroParams(item, params));
  }
  if (val && typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = substituteMacroParams(v, params);
    }
    return out;
  }
  return val;
}

export function buildRecordableStep(toolName, args = {}, result = {}) {
  if (!RECORDABLE_TOOLS.has(toolName) || result?.ok === false) return null;
  const cleanArgs = { ...args };
  // Prefer stable selector returned by element resolution over transient numeric elementId
  delete cleanArgs.tabId;
  if (result?.selector && cleanArgs.elementId != null) {
    cleanArgs.selector = result.selector;
    delete cleanArgs.elementId;
  }
  if (result?.fromSelector && cleanArgs.fromElementId != null) {
    cleanArgs.fromSelector = result.fromSelector;
    delete cleanArgs.fromElementId;
  }
  if (result?.toSelector && cleanArgs.toElementId != null) {
    cleanArgs.toSelector = result.toSelector;
    delete cleanArgs.toElementId;
  }
  return {
    tool: toolName,
    args: cleanArgs,
    label: result?.element || cleanArgs.url || cleanArgs.selector || toolName
  };
}

export async function replayMacro({
  macroId,
  name,
  tabId = null,
  params = {},
  selfHeal = true,
  skipSafety = false,
  settings,
  agentName,
  attachedTabIds,
  touchedTabIds,
  onEvent,
  onMacroUpdated = null,
  requestApproval,
  requestHandoff = null,
  executeTool,
  runAgentLoop,
  macroHandler,
  signal
}) {
  const macros = await getMacros();
  const macro = macros.find((m) => (macroId ? m.id === macroId : m.name === name));
  if (!macro) {
    return { ok: false, error: `Macro not found: ${macroId || name}` };
  }

  let completedSteps = 0;
  for (let i = 0; i < macro.steps.length; i++) {
    if (signal?.aborted) throw new Error('Stopped by user.');
    const step = macro.steps[i];
    const stepArgs = substituteMacroParams({ ...(step.args || {}) }, params);
    if (tabId != null && step.tool !== 'open_tab') {
      stepArgs.tabId = Number(tabId);
    }

    onEvent?.({ type: 'tool_start', step: i + 1, tool: `macro:${step.tool}`, args: stepArgs });
    let res;
    try {
      res = await executeTool(step.tool, stepArgs, {
        settings,
        agentName,
        attachedTabIds,
        touchedTabIds,
        persistentWorking: true,
        skipSafety,
        requestApproval,
        requestHandoff,
        macroHandler
      });
    } catch (err) {
      res = { ok: false, error: err?.message || String(err) };
    }
    onEvent?.({ type: 'tool_result', step: i + 1, tool: `macro:${step.tool}`, result: res });

    if (res?.ok !== false) {
      completedSteps++;
      if (step.tool === 'open_tab' && res?.tabId) {
        tabId = res.tabId;
      }
      continue;
    }

    // Step failed -> attempt LLM self-healing if enabled & provider configured
    const hasProviderAuth = Boolean(settings?.apiKey) || settings?.provider === 'ollama' || settings?.provider === 'custom';
    if (!selfHeal || !hasProviderAuth) {
      return {
        ok: false,
        macroId: macro.id,
        macroName: macro.name,
        completedSteps,
        totalSteps: macro.steps.length,
        failedStepIndex: i,
        error: res?.error || 'Macro step failed'
      };
    }

    const remaining = macro.steps.slice(i).map((s) => ({
      ...s,
      args: substituteMacroParams(s.args || {}, params)
    }));
    onEvent?.({
      type: 'assistant_text',
      step: i + 1,
      text: `Macro step ${i + 1} (${step.tool}) failed: "${res?.error}". Self-healing remaining ${remaining.length} step(s) with LLM...`
    });

    const healPrompt = [
      `You are self-healing a deterministic browser macro named "${macro.name}".`,
      `Steps 1..${i} succeeded on tabId ${tabId ?? 'active tab'}.`,
      `Step ${i + 1} failed with error: ${res?.error || 'unknown error'}.`,
      `Failed step: ${JSON.stringify(remaining[0] || step)}`,
      `Remaining steps to complete: ${JSON.stringify(remaining)}`,
      `Inspect the page, complete the failed step and all remaining steps with stable CSS selectors, and summarize what happened.`
    ].join('\n');

    const pendingHealArgs = new Map();
    const healedSteps = [];
    const healSummary = await runAgentLoop({
      prompt: healPrompt,
      settings,
      agentName,
      attachedTabIds,
      touchedTabIds,
      signal,
      onEvent: (ev) => {
        if (ev.type === 'tool_start') {
          pendingHealArgs.set(`${ev.step}:${ev.tool}`, ev.args);
        } else if (ev.type === 'tool_result') {
          const a = pendingHealArgs.get(`${ev.step}:${ev.tool}`);
          pendingHealArgs.delete(`${ev.step}:${ev.tool}`);
          const rec = buildRecordableStep(ev.tool, a, ev.result);
          if (rec) healedSteps.push(rec);
        }
        onEvent?.(ev);
      },
      requestApproval,
      requestHandoff,
      macroHandler
    });

    let healedUpdated = false;
    if (healedSteps.length > 0) {
      const updatedSteps = [...macro.steps.slice(0, i), ...healedSteps];
      const upd = await updateMacro(macro.id, { steps: updatedSteps });
      if (upd?.ok) {
        healedUpdated = true;
        onMacroUpdated?.(upd.macros);
      }
    }

    return {
      ok: true,
      macroId: macro.id,
      macroName: macro.name,
      completedSteps,
      totalSteps: macro.steps.length,
      healed: true,
      healedUpdated,
      healSummary
    };
  }

  return {
    ok: true,
    macroId: macro.id,
    macroName: macro.name,
    completedSteps,
    totalSteps: macro.steps.length,
    healed: false
  };
}
