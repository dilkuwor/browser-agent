(() => {
  if (window.__browserAgentInstalled) return;
  window.__browserAgentInstalled = true;

  const IS_TOP = window === window.top;
  const indexedElements = new Map();
  let overlayTimer = null;
  let workingExpireTimer = null;
  let cursorHideTimer = null;
  let isRecording = false;
  let lastCursorPos = {
    x: Math.round(window.innerWidth * 0.5),
    y: Math.round(window.innerHeight * 0.5)
  };
  let isWorking = false;

  const AGENT_THEMES = {
    agy: {
      primary: '#06b6d4',
      secondary: '#4f46e5',
      accent: '#a855f7',
      gradient: 'conic-gradient(from var(--ba-angle), #06b6d4, #3b82f6, #6366f1, #a855f7, #06b6d4)',
      glowA: 'rgba(6, 182, 212, 0.42)',
      glowB: 'rgba(99, 102, 241, 0.35)'
    },
    claude: {
      primary: '#f97316',
      secondary: '#ea580c',
      accent: '#f59e0b',
      gradient: 'conic-gradient(from var(--ba-angle), #f97316, #fb923c, #f59e0b, #ec4899, #f97316)',
      glowA: 'rgba(249, 115, 22, 0.42)',
      glowB: 'rgba(236, 72, 153, 0.30)'
    },
    gemini: {
      primary: '#3b82f6',
      secondary: '#06b6d4',
      accent: '#8b5cf6',
      gradient: 'conic-gradient(from var(--ba-angle), #3b82f6, #06b6d4, #8b5cf6, #3b82f6)',
      glowA: 'rgba(59, 130, 246, 0.42)',
      glowB: 'rgba(6, 182, 212, 0.35)'
    },
    openai: {
      primary: '#10b981',
      secondary: '#06b6d4',
      accent: '#3b82f6',
      gradient: 'conic-gradient(from var(--ba-angle), #10b981, #06b6d4, #3b82f6, #10b981)',
      glowA: 'rgba(16, 185, 129, 0.42)',
      glowB: 'rgba(6, 182, 212, 0.35)'
    },
    openrouter: {
      primary: '#8b5cf6',
      secondary: '#06b6d4',
      accent: '#ec4899',
      gradient: 'conic-gradient(from var(--ba-angle), #8b5cf6, #06b6d4, #ec4899, #8b5cf6)',
      glowA: 'rgba(139, 92, 246, 0.42)',
      glowB: 'rgba(6, 182, 212, 0.35)'
    },
    ollama: {
      primary: '#f8fafc',
      secondary: '#22c55e',
      accent: '#38bdf8',
      gradient: 'conic-gradient(from var(--ba-angle), #22c55e, #38bdf8, #e2e8f0, #22c55e)',
      glowA: 'rgba(34, 197, 94, 0.40)',
      glowB: 'rgba(56, 189, 248, 0.35)'
    },
    custom: {
      primary: '#14b8a6',
      secondary: '#6366f1',
      accent: '#f43f5e',
      gradient: 'conic-gradient(from var(--ba-angle), #14b8a6, #6366f1, #f43f5e, #14b8a6)',
      glowA: 'rgba(20, 184, 166, 0.42)',
      glowB: 'rgba(99, 102, 241, 0.35)'
    }
  };

  function getTheme(agentName) {
    return AGENT_THEMES[String(agentName || 'agy').toLowerCase()] || AGENT_THEMES.agy;
  }

  // Mount UI inside a Shadow DOM attached to <html> so page styles never clash
  // and document.body.innerText extraction never captures agent UI text.
  let uiRefs = null;
  function ensureAgentUi() {
    if (uiRefs && document.documentElement.contains(uiRefs.host)) {
      return uiRefs;
    }
    const host = document.createElement('div');
    host.id = '__ba_agent_ui_host';
    Object.assign(host.style, {
      position: 'fixed',
      inset: '0',
      width: '100vw',
      height: '100vh',
      pointerEvents: 'none',
      zIndex: '2147483647',
      margin: '0',
      padding: '0',
      border: '0',
      background: 'transparent'
    });

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      @property --ba-angle {
        syntax: "<angle>";
        initial-value: 0deg;
        inherits: false;
      }
      @keyframes ba-spin {
        to { --ba-angle: 360deg; }
      }
      @keyframes ba-pulse-dot {
        0%, 100% { transform: scale(1); opacity: 1; }
        50% { transform: scale(1.35); opacity: 0.65; }
      }
      @keyframes ba-ripple {
        0% { transform: translate(-50%, -50%) scale(0.35); opacity: 0.95; }
        100% { transform: translate(-50%, -50%) scale(2.4); opacity: 0; }
      }
      .glow-frame {
        position: fixed;
        inset: 0;
        pointer-events: none;
        opacity: 0;
        transition: opacity 260ms ease;
      }
      .glow-frame.active {
        opacity: 1;
      }
      .glow-border {
        position: absolute;
        inset: 0;
        padding: 4px;
        background: var(--ba-gradient);
        animation: ba-spin 3.2s linear infinite;
        -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
        -webkit-mask-composite: xor;
        mask-composite: exclude;
      }
      .glow-vignette {
        position: absolute;
        inset: 0;
        box-shadow: inset 0 0 28px var(--ba-glow-a), inset 0 0 10px var(--ba-glow-b);
      }
      .status-pill {
        position: absolute;
        bottom: 14px;
        left: 50%;
        transform: translateX(-50%);
        display: inline-flex;
        align-items: center;
        gap: 7px;
        padding: 5px 12px;
        border-radius: 999px;
        background: rgba(15, 23, 42, 0.88);
        color: #f8fafc;
        border: 1px solid var(--ba-primary);
        box-shadow: 0 6px 22px rgba(2, 6, 23, 0.35), 0 0 12px var(--ba-glow-a);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 12px;
        font-weight: 500;
        letter-spacing: 0.01em;
        backdrop-filter: blur(8px);
      }
      .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--ba-primary);
        animation: ba-pulse-dot 1.2s ease-in-out infinite;
      }
      .cursor-wrap {
        position: fixed;
        top: 0;
        left: 0;
        pointer-events: none;
        opacity: 0;
        will-change: transform, opacity;
        transition: transform 260ms cubic-bezier(0.22, 1, 0.36, 1), opacity 220ms ease;
        filter: drop-shadow(0 3px 8px rgba(2, 6, 23, 0.45));
      }
      .cursor-wrap.visible {
        opacity: 1;
      }
      .cursor-wrap.clicking svg {
        transform: scale(0.86);
      }
      .cursor-wrap svg {
        display: block;
        transition: transform 110ms ease;
      }
      .cursor-tag {
        position: absolute;
        left: 18px;
        top: 16px;
        padding: 2px 7px;
        border-radius: 999px;
        background: var(--ba-primary);
        color: #fff;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 11px;
        font-weight: 600;
        white-space: nowrap;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
      }
      .ripple {
        position: fixed;
        width: 22px;
        height: 22px;
        border-radius: 50%;
        border: 2.5px solid var(--ba-primary);
        background: var(--ba-glow-a);
        pointer-events: none;
        animation: ba-ripple 520ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
      }
    `;

    const glowFrame = document.createElement('div');
    glowFrame.className = 'glow-frame';

    const glowBorder = document.createElement('div');
    glowBorder.className = 'glow-border';

    const glowVignette = document.createElement('div');
    glowVignette.className = 'glow-vignette';

    const statusPill = document.createElement('div');
    statusPill.className = 'status-pill';
    const statusDot = document.createElement('span');
    statusDot.className = 'status-dot';
    const statusText = document.createElement('span');
    statusText.textContent = 'agy is working…';
    statusPill.append(statusDot, statusText);

    glowFrame.append(glowBorder, glowVignette, statusPill);

    const cursorWrap = document.createElement('div');
    cursorWrap.className = 'cursor-wrap';
    cursorWrap.style.transform = `translate3d(${lastCursorPos.x}px, ${lastCursorPos.y}px, 0)`;
    cursorWrap.innerHTML = `
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <path d="M4 2.5L20 11.2L12.6 13.4L9.2 20.5L4 2.5Z" fill="var(--ba-primary)" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round"/>
      </svg>
    `;
    const cursorTag = document.createElement('span');
    cursorTag.className = 'cursor-tag';
    cursorTag.textContent = 'agy';
    cursorWrap.appendChild(cursorTag);

    shadow.append(style, glowFrame, cursorWrap);
    document.documentElement.appendChild(host);

    uiRefs = { host, shadow, glowFrame, statusText, cursorWrap, cursorTag };
    applyTheme('agy');
    return uiRefs;
  }

  function applyTheme(agentName) {
    const refs = ensureAgentUi();
    const theme = getTheme(agentName);
    const label = String(agentName || 'agy');
    refs.host.style.setProperty('--ba-primary', theme.primary);
    refs.host.style.setProperty('--ba-secondary', theme.secondary);
    refs.host.style.setProperty('--ba-accent', theme.accent);
    refs.host.style.setProperty('--ba-gradient', theme.gradient);
    refs.host.style.setProperty('--ba-glow-a', theme.glowA);
    refs.host.style.setProperty('--ba-glow-b', theme.glowB);
    refs.statusText.textContent = `${label} is working…`;
    refs.cursorTag.textContent = label;
  }

  function setWorkingState({ working, agentName = 'agy', ttlMs = 0 }) {
    const refs = ensureAgentUi();
    applyTheme(agentName);
    if (workingExpireTimer) {
      clearTimeout(workingExpireTimer);
      workingExpireTimer = null;
    }
    isWorking = Boolean(working);
    refs.glowFrame.classList.toggle('active', isWorking);

    if (isWorking && ttlMs > 0) {
      workingExpireTimer = setTimeout(() => {
        setWorkingState({ working: false, agentName });
      }, ttlMs);
    } else if (!isWorking) {
      refs.cursorWrap.classList.remove('visible');
    }
  }

  function spawnRipple(x, y) {
    const refs = ensureAgentUi();
    const ring = document.createElement('div');
    ring.className = 'ripple';
    ring.style.left = `${x}px`;
    ring.style.top = `${y}px`;
    refs.shadow.appendChild(ring);
    setTimeout(() => ring.remove(), 550);
  }

  function moveCursor({ x, y, action = 'move', agentName = 'agy' }) {
    const refs = ensureAgentUi();
    applyTheme(agentName);
    const tx = Math.max(0, Math.min(window.innerWidth - 6, Math.round(x)));
    const ty = Math.max(0, Math.min(window.innerHeight - 6, Math.round(y)));
    lastCursorPos = { x: tx, y: ty };

    refs.cursorWrap.classList.add('visible');
    // Force layout if just made visible so transform animates smoothly from prior spot
    void refs.cursorWrap.offsetWidth;
    refs.cursorWrap.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;

    if (action === 'click' || action === 'type' || action === 'select_option') {
      setTimeout(() => {
        refs.cursorWrap.classList.add('clicking');
        spawnRipple(tx, ty);
        setTimeout(() => refs.cursorWrap.classList.remove('clicking'), 160);
      }, 170);
    }

    if (cursorHideTimer) clearTimeout(cursorHideTimer);
    cursorHideTimer = setTimeout(() => {
      if (!isWorking) {
        refs.cursorWrap.classList.remove('visible');
      }
    }, 5000);
  }

  const INTERACTIVE_SELECTOR = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'textarea',
    'select',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="combobox"]',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  function collectOpenRoots(root = document, out = [root]) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    while (node) {
      if (node.id !== '__ba_agent_ui_host' && node.shadowRoot) {
        out.push(node.shadowRoot);
        collectOpenRoots(node.shadowRoot, out);
      }
      node = walker.nextNode();
    }
    return out;
  }

  function queryAllDeep(selector, root = document) {
    if (!selector) return [];
    const parts = String(selector).split('>>>').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) {
      let currentRoots = [root];
      for (let i = 0; i < parts.length; i++) {
        const seg = parts[i];
        const nextMatches = [];
        for (const r of currentRoots) {
          for (const sr of collectOpenRoots(r)) {
            nextMatches.push(...sr.querySelectorAll(seg));
          }
        }
        if (i === parts.length - 1) return nextMatches;
        currentRoots = nextMatches.map((el) => el.shadowRoot || el);
      }
      return [];
    }

    const matches = [];
    const seen = new Set();
    for (const r of collectOpenRoots(root)) {
      let found = [];
      try {
        found = r.querySelectorAll(selector);
      } catch {
        return [];
      }
      for (const el of found) {
        if (!seen.has(el)) {
          seen.add(el);
          matches.push(el);
        }
      }
    }
    return matches;
  }

  function queryOneDeep(selector, root = document) {
    return queryAllDeep(selector, root)[0] || null;
  }

  function buildLocalSelector(el, scopeRoot) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const testId = el.getAttribute('data-testid');
    if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
    const tag = el.tagName.toLowerCase();
    const name = el.getAttribute('name');
    if (name) {
      const candidate = `${tag}[name="${CSS.escape(name)}"]`;
      if (scopeRoot.querySelectorAll(candidate).length === 1) return candidate;
    }
    const aria = el.getAttribute('aria-label');
    if (aria && aria.length <= 60) {
      const candidate = `${tag}[aria-label="${CSS.escape(aria)}"]`;
      if (scopeRoot.querySelectorAll(candidate).length === 1) return candidate;
    }
    const path = [];
    let cur = el;
    while (cur && cur.nodeType === Node.ELEMENT_NODE && cur !== scopeRoot) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) {
        path.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      const parent = cur.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
        }
      }
      path.unshift(part);
      cur = parent;
    }
    return path.join(' > ');
  }

  function buildDeepSelector(el) {
    const chain = [];
    let cur = el;
    while (cur) {
      const root = cur.getRootNode();
      const scope = root instanceof ShadowRoot ? root : document;
      chain.unshift(buildLocalSelector(cur, scope));
      cur = root instanceof ShadowRoot ? root.host : null;
    }
    return chain.join(' >>> ');
  }

  function getSameOriginFrameOffset() {
    if (IS_TOP) return { x: 0, y: 0, sameOrigin: true };
    try {
      let ox = 0;
      let oy = 0;
      let win = window;
      while (win !== window.top) {
        const fe = win.frameElement;
        if (!fe) return null;
        const r = fe.getBoundingClientRect();
        ox += Math.round(r.left);
        oy += Math.round(r.top);
        win = win.parent;
      }
      return { x: ox, y: oy, sameOrigin: true };
    } catch {
      return null;
    }
  }

  function isVisible(el) {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) {
      return false;
    }
    return true;
  }

  function isUnoccluded(el, cx, cy) {
    try {
      const root = el.getRootNode() instanceof ShadowRoot ? el.getRootNode() : document;
      const hit = root.elementFromPoint(cx, cy);
      if (!hit) return true;
      if (hit === el || el.contains(hit) || hit.contains(el)) return true;
      return false;
    } catch {
      return true;
    }
  }

  function getLabel(el) {
    const aria = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder');
    if (aria && aria.trim()) return aria.trim().slice(0, 120);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      const root = el.getRootNode();
      const scope = root instanceof ShadowRoot ? root : document;
      if (el.id) {
        const lbl = scope.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl && lbl.innerText.trim()) return lbl.innerText.trim().slice(0, 120);
      }
      const parentLabel = el.closest('label');
      if (parentLabel && parentLabel.innerText.trim()) return parentLabel.innerText.trim().slice(0, 120);
    }
    const text = (el.innerText || el.textContent || el.value || '').replace(/\s+/g, ' ').trim();
    return text.slice(0, 120);
  }

  function collectClickablePointerElements(seen) {
    const extra = [];
    let inspected = 0;
    for (const root of collectOpenRoots(document)) {
      const nodes = root.querySelectorAll('div, span, li, img, svg');
      for (const el of nodes) {
        if (inspected >= 350 || extra.length >= 40) break;
        inspected++;
        if (seen.has(el) || el.id === '__ba_agent_ui_host' || el.id === '__ba_som_host') continue;
        if (el.querySelector(INTERACTIVE_SELECTOR)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 12 || rect.height < 12 || rect.width > 640 || rect.height > 260) continue;
        if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) continue;
        const cs = window.getComputedStyle(el);
        if (cs.cursor !== 'pointer' || cs.display === 'none' || cs.visibility === 'hidden') continue;
        const label = getLabel(el);
        if (!label && el.tagName !== 'IMG' && el.tagName !== 'SVG') continue;
        seen.add(el);
        extra.push(el);
      }
    }
    return extra;
  }

  function indexInteractiveElements(maxElements = 140) {
    indexedElements.clear();
    const primary = queryAllDeep(INTERACTIVE_SELECTOR);
    const seen = new Set(primary);
    const pointerExtras = collectClickablePointerElements(seen);
    const candidates = [...primary, ...pointerExtras];
    const items = [];
    let id = 1;

    for (const el of candidates) {
      if (id > maxElements) break;
      if (!isVisible(el)) continue;

      const rect = el.getBoundingClientRect();
      const cx = Math.round(rect.left + rect.width / 2);
      const cy = Math.round(rect.top + rect.height / 2);
      if (!isUnoccluded(el, cx, cy)) continue;

      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || (pointerExtras.includes(el) ? 'button' : tag);
      const type = el.getAttribute('type') || undefined;
      const href = el.getAttribute('href') || undefined;
      const name = el.getAttribute('name') || undefined;
      const value = (tag === 'input' || tag === 'textarea' || tag === 'select')
        ? (type === 'password' ? '***' : String(el.value || '').slice(0, 80))
        : undefined;
      const label = getLabel(el);
      const inShadow = el.getRootNode() instanceof ShadowRoot;

      indexedElements.set(id, el);
      items.push({
        id,
        tag,
        role,
        type,
        name,
        label,
        value,
        checked: (type === 'checkbox' || type === 'radio') ? Boolean(el.checked) : undefined,
        inShadow: inShadow || undefined,
        href: href ? href.slice(0, 140) : undefined,
        disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
        rect: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          cx,
          cy
        }
      });
      id++;
    }
    return items;
  }

  function clearOverlay() {
    if (overlayTimer) {
      clearTimeout(overlayTimer);
      overlayTimer = null;
    }
    const existing = document.getElementById('__ba_highlight_overlay');
    if (existing) existing.remove();
  }

  function highlightRect(rect, labelText = '') {
    clearOverlay();
    const box = document.createElement('div');
    box.id = '__ba_highlight_overlay';
    Object.assign(box.style, {
      position: 'fixed',
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.w}px`,
      height: `${rect.h}px`,
      border: '2px solid #06b6d4',
      background: 'rgba(6, 182, 212, 0.14)',
      borderRadius: '4px',
      zIndex: '2147483646',
      pointerEvents: 'none',
      boxSizing: 'border-box',
      transition: 'opacity 0.2s ease'
    });
    if (labelText) {
      const badge = document.createElement('span');
      badge.textContent = labelText;
      Object.assign(badge.style, {
        position: 'absolute',
        top: '-20px',
        left: '0',
        background: '#4f46e5',
        color: '#fff',
        fontSize: '11px',
        fontFamily: 'system-ui, sans-serif',
        padding: '1px 6px',
        borderRadius: '3px',
        whiteSpace: 'nowrap'
      });
      box.appendChild(badge);
    }
    document.documentElement.appendChild(box);
    overlayTimer = setTimeout(clearOverlay, 1400);
  }

  function resolveElement({ elementId, selector }) {
    let el = null;
    if (elementId != null && indexedElements.has(Number(elementId))) {
      el = indexedElements.get(Number(elementId));
      if (el && !el.isConnected) el = null;
    }
    if (!el && selector) {
      el = queryOneDeep(selector);
    }
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type') || undefined;
    const meta = {
      tag,
      type,
      checked: (type === 'checkbox' || type === 'radio') ? Boolean(el.checked) : undefined,
      selector: buildDeepSelector(el),
      label: getLabel(el),
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        cx: Math.round(rect.left + rect.width / 2),
        cy: Math.round(rect.top + rect.height / 2)
      }
    };
    highlightRect(meta.rect, elementId ? `#${elementId}` : meta.tag);
    return { el, meta };
  }

  function getReadableText(selector, maxChars = 8000) {
    if (selector) {
      const target = queryOneDeep(selector);
      if (!target) return '';
      return (target.innerText || target.textContent || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxChars);
    }
    if (!document.body) return '';
    const chunks = [(document.body.innerText || document.body.textContent || '').trim()];
    const roots = collectOpenRoots(document.body);
    for (let i = 1; i < roots.length; i++) {
      const sr = roots[i];
      const txt = (sr.textContent || '').replace(/\s+/g, ' ').trim();
      if (txt) chunks.push(txt);
    }
    return chunks.filter(Boolean).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxChars);
  }

  function collectChildIframes() {
    const iframes = queryAllDeep('iframe, frame');
    return iframes.map((el) => {
      const r = el.getBoundingClientRect();
      const cs = window.getComputedStyle(el);
      const bl = parseFloat(cs.borderLeftWidth) || 0;
      const bt = parseFloat(cs.borderTopWidth) || 0;
      const pl = parseFloat(cs.paddingLeft) || 0;
      const pt = parseFloat(cs.paddingTop) || 0;
      return {
        src: el.src || el.getAttribute('src') || '',
        name: el.name || '',
        x: Math.round(r.left + bl + pl),
        y: Math.round(r.top + bt + pt)
      };
    });
  }

  function collectFrameObservation(maxElements = 120, maxTextChars = 6000) {
    const elements = indexInteractiveElements(maxElements);
    const text = getReadableText(null, maxTextChars);
    return {
      ok: true,
      isTop: IS_TOP,
      url: window.location.href,
      title: document.title,
      sameOriginOffset: getSameOriginFrameOffset(),
      childIframes: collectChildIframes(),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
        scrollHeight: document.documentElement?.scrollHeight || 0
      },
      elements,
      text
    };
  }
  window.__baObserveFrame = collectFrameObservation;
  window.__baSetRecording = (active) => { isRecording = Boolean(active); };

  // --- User Action Recorder (for deterministic macro creation) ---
  function isOwnUiEvent(target) {
    return target && (
      target.id === '__ba_agent_ui_host' ||
      target.id === '__ba_som_host' ||
      target.closest?.('#__ba_agent_ui_host, #__ba_som_host')
    );
  }

  function recordStep(step) {
    if (!isRecording) return;
    chrome.runtime.sendMessage({ type: 'BA_RECORDED_STEP', step }).catch(() => {});
  }

  document.addEventListener('click', (e) => {
    const rawTarget = e.composedPath?.()[0] || e.target;
    if (!isRecording || !e.isTrusted || isOwnUiEvent(rawTarget)) return;
    const target = rawTarget?.closest?.(INTERACTIVE_SELECTOR) || rawTarget;
    if (!target || target.nodeType !== Node.ELEMENT_NODE) return;
    const tag = target.tagName.toLowerCase();
    const type = (target.getAttribute('type') || '').toLowerCase();
    // Skip clicks directly on text inputs/selects since change listener captures value
    if ((tag === 'input' && type !== 'checkbox' && type !== 'radio' && type !== 'submit' && type !== 'button') ||
        tag === 'textarea' || tag === 'select' || target.isContentEditable) {
      return;
    }
    recordStep({
      tool: 'click',
      args: { selector: buildDeepSelector(target) },
      label: getLabel(target) || tag,
      url: window.location.href
    });
  }, true);

  document.addEventListener('change', (e) => {
    const target = e.composedPath?.()[0] || e.target;
    if (!isRecording || !e.isTrusted || isOwnUiEvent(target)) return;
    if (!target || target.nodeType !== Node.ELEMENT_NODE) return;
    const tag = target.tagName.toLowerCase();
    const type = (target.getAttribute('type') || '').toLowerCase();
    const selector = buildDeepSelector(target);
    if (tag === 'select') {
      recordStep({ tool: 'select_option', args: { selector, value: target.value }, label: getLabel(target) || 'select', url: window.location.href });
    } else if (tag === 'input' && type === 'file') {
      const files = Array.from(target.files || []).map((f) => f.name);
      if (files.length > 0) {
        recordStep({
          tool: 'upload_file',
          args: { selector, files },
          label: `${getLabel(target) || 'file'} (${files.join(', ')})`,
          url: window.location.href
        });
      }
    } else if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
      // Already handled by click listener
    } else if (tag === 'input' || tag === 'textarea') {
      const isPwd = type === 'password';
      recordStep({
        tool: 'type',
        args: { selector, text: isPwd ? '{{PASSWORD}}' : String(target.value || '') },
        label: isPwd ? `${getLabel(target) || 'password'} (redacted)` : (getLabel(target) || tag),
        url: window.location.href
      });
    }
  }, true);

  document.addEventListener('blur', (e) => {
    const target = e.composedPath?.()[0] || e.target;
    if (!isRecording || !target || target.nodeType !== Node.ELEMENT_NODE || isOwnUiEvent(target)) return;
    if (target.isContentEditable) {
      const txt = (target.innerText || target.textContent || '').trim();
      if (txt) {
        recordStep({
          tool: 'type',
          args: { selector: buildDeepSelector(target), text: txt },
          label: getLabel(target) || 'editor',
          url: window.location.href
        });
      }
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    const target = e.composedPath?.()[0] || e.target;
    if (!isRecording || !e.isTrusted || isOwnUiEvent(target)) return;
    if (e.key === 'Enter' || e.key === 'Escape') {
      recordStep({
        tool: 'press_key',
        args: { key: e.key },
        label: `Key ${e.key}`,
        url: window.location.href
      });
    }
  }, true);

  function csvEscapeCell(val) {
    const str = String(val ?? '').replace(/\s+/g, ' ').trim();
    if (/[",\n\r]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  function findAllTablesDeep(root, acc = []) {
    for (const el of root.querySelectorAll('table, [role="table"], [role="grid"]')) {
      acc.push(el);
    }
    for (const host of root.querySelectorAll('*')) {
      if (host.shadowRoot) findAllTablesDeep(host.shadowRoot, acc);
    }
    return acc;
  }

  function parseTableElement(tableEl, maxRows) {
    const isNative = tableEl.tagName === 'TABLE';
    const rawRows = isNative
      ? Array.from(tableEl.querySelectorAll('tr'))
      : Array.from(tableEl.querySelectorAll('[role="row"]'));

    const matrix = [];
    for (const tr of rawRows) {
      if (isNative && tr.closest('table') !== tableEl) continue;
      const cells = isNative
        ? Array.from(tr.querySelectorAll(':scope > th, :scope > td'))
        : Array.from(tr.querySelectorAll('[role="columnheader"], [role="rowheader"], [role="gridcell"], [role="cell"]'));
      const vals = cells.map((c) => (c.innerText || c.textContent || '').replace(/\s+/g, ' ').trim());
      if (vals.some(Boolean)) {
        matrix.push({
          el: tr,
          isHeaderRow: Boolean(tr.closest('thead')) || cells.every((c) => c.tagName === 'TH' || c.getAttribute('role') === 'columnheader'),
          vals
        });
      }
    }
    if (matrix.length === 0) return null;

    let headers = [];
    let bodyStart = 0;
    if (matrix[0].isHeaderRow || matrix.length > 1) {
      headers = matrix[0].vals.map((h, i) => h || `col_${i + 1}`);
      bodyStart = 1;
    } else {
      headers = matrix[0].vals.map((_, i) => `col_${i + 1}`);
    }

    const colCount = Math.max(headers.length, ...matrix.map((r) => r.vals.length));
    while (headers.length < colCount) headers.push(`col_${headers.length + 1}`);

    const dataRows = matrix.slice(bodyStart, bodyStart + maxRows).map((r) => {
      const padded = [...r.vals];
      while (padded.length < colCount) padded.push('');
      return padded;
    });
    const objects = dataRows.map((row) => {
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = row[i] ?? '';
      });
      return obj;
    });
    const csvLines = [headers.map(csvEscapeCell).join(','), ...dataRows.map((row) => row.map(csvEscapeCell).join(','))];
    return {
      selector: buildDeepSelector(tableEl),
      headers,
      rowCount: dataRows.length,
      rows: dataRows,
      objects,
      csv: csvLines.join('\n')
    };
  }

  function extractStructuredTables(selector, maxRows = 200) {
    let target = null;
    if (selector) {
      const el = queryOneDeep(selector);
      if (!el) return { ok: false, error: `No element found matching selector "${selector}".` };
      target = el.matches('table, [role="table"], [role="grid"]')
        ? el
        : el.querySelector('table, [role="table"], [role="grid"]') || el.closest('table, [role="table"], [role="grid"]');
    } else {
      const candidates = findAllTablesDeep(document).filter((t) => {
        const rect = t.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      candidates.sort((a, b) => b.querySelectorAll('tr, [role="row"]').length - a.querySelectorAll('tr, [role="row"]').length);
      target = candidates[0] || null;
    }
    if (!target) return { ok: false, error: 'No visible HTML table or ARIA grid found on page.' };
    const parsed = parseTableElement(target, Math.max(1, Number(maxRows) || 200));
    if (!parsed) return { ok: false, error: 'Matched table has no extractable rows.' };
    return { ok: true, url: window.location.href, title: document.title, ...parsed };
  }

  function readWebStorage(store, maxKeys = 100) {
    const out = {};
    try {
      const len = Math.min(store.length, maxKeys);
      for (let i = 0; i < len; i++) {
        const k = store.key(i);
        if (k != null) {
          const val = String(store.getItem(k) ?? '');
          out[k] = val.length > 500 ? `${val.slice(0, 500)}...[truncated]` : val;
        }
      }
    } catch (err) {
      return { _error: err?.message || 'Storage access restricted' };
    }
    return out;
  }

  function collectClientStorage({ includeLocalStorage = true, includeSessionStorage = true, maxKeys = 100 } = {}) {
    return {
      ok: true,
      origin: window.location.origin,
      localStorage: includeLocalStorage ? readWebStorage(window.localStorage, maxKeys) : undefined,
      sessionStorage: includeSessionStorage ? readWebStorage(window.sessionStorage, maxKeys) : undefined
    };
  }

  function getScrollRoot() {
    return document.scrollingElement || document.documentElement || document.body;
  }

  function getFullPageMetrics() {
    const root = getScrollRoot();
    const docEl = document.documentElement;
    const body = document.body || document.getElementsByTagName('body')[0];
    const candidates = [
      root ? root.scrollHeight : 0,
      root ? root.offsetHeight : 0,
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0,
      docEl ? docEl.scrollHeight : 0,
      docEl ? docEl.offsetHeight : 0,
      window.innerHeight || 0
    ];
    const totalHeight = Math.ceil(Math.max(...candidates.filter(Boolean)));
    const viewportHeight = Math.ceil((root ? root.clientHeight : 0) || window.innerHeight || 0);
    const viewportWidth = Math.ceil(window.innerWidth || (docEl ? docEl.clientWidth : 0) || 0);
    const scrollY = Math.ceil((root ? root.scrollTop : 0) || window.scrollY || window.pageYOffset || 0);
    const dpr = window.devicePixelRatio || 1;
    return { ok: true, totalHeight, viewportHeight, viewportWidth, scrollY, dpr };
  }

  function scrollToExactY(y) {
    const targetY = Math.max(0, Math.floor(Number(y) || 0));
    const root = getScrollRoot();
    let achieved = 0;
    try {
      if (root && typeof root.scrollTo === 'function') {
        root.scrollTo({ left: 0, top: targetY, behavior: 'instant' });
      } else if (root) {
        root.scrollTop = targetY;
      }
      achieved = root ? (root.scrollTop || 0) : 0;
    } catch {}
    try {
      window.scrollTo({ left: 0, top: targetY, behavior: 'instant' });
      achieved = Math.max(achieved, window.scrollY || window.pageYOffset || 0);
    } catch {
      try {
        window.scrollTo(0, targetY);
        achieved = Math.max(achieved, window.scrollY || window.pageYOffset || 0);
      } catch {}
    }
    if (root && root.offsetHeight) {
      void root.offsetHeight;
    }
    const finalScrollY = Math.ceil((root ? root.scrollTop : 0) || window.scrollY || window.pageYOffset || achieved || 0);
    return { ok: true, scrollY: finalScrollY, requested: targetY };
  }

  function showSomLabels(elements = []) {
    hideSomLabels();
    if (!IS_TOP || !Array.isArray(elements) || elements.length === 0) return;
    const host = document.createElement('div');
    host.id = '__ba_som_host';
    Object.assign(host.style, {
      position: 'fixed',
      inset: '0',
      width: '100vw',
      height: '100vh',
      pointerEvents: 'none',
      zIndex: '2147483645'
    });
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      .som-box {
        position: fixed;
        border: 1.5px dashed rgba(6, 182, 212, 0.85);
        border-radius: 3px;
        box-sizing: border-box;
      }
      .som-tag {
        position: absolute;
        top: -1px;
        left: -1px;
        transform: translateY(-75%);
        background: #0f172a;
        color: #22d3ee;
        border: 1px solid #06b6d4;
        border-radius: 3px;
        padding: 0 4px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 10px;
        font-weight: 700;
        line-height: 14px;
        white-space: nowrap;
      }
    `;
    shadow.appendChild(style);
    for (const item of elements) {
      if (!item?.rect) continue;
      const box = document.createElement('div');
      box.className = 'som-box';
      box.style.left = `${item.rect.x}px`;
      box.style.top = `${item.rect.y}px`;
      box.style.width = `${item.rect.w}px`;
      box.style.height = `${item.rect.h}px`;
      const tag = document.createElement('span');
      tag.className = 'som-tag';
      tag.textContent = `[${item.id}]`;
      box.appendChild(tag);
      shadow.appendChild(box);
    }
    document.documentElement.appendChild(host);
  }

  function hideSomLabels() {
    const existing = document.getElementById('__ba_som_host');
    if (existing) existing.remove();
  }

  function clearElementValue(el) {
    el.focus();
    if ('value' in el) {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (nativeSetter) nativeSetter.call(el, '');
      else el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    } else if (el.isContentEditable) {
      el.innerText = '';
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
    }
  }

  function findScrollableContainer(targetEl = null) {
    if (targetEl) {
      let cur = targetEl;
      while (cur && cur !== document.body && cur !== document.documentElement) {
        const cs = window.getComputedStyle(cur);
        if (/(auto|scroll)/.test(cs.overflowY) && cur.scrollHeight > cur.clientHeight + 4) return cur;
        if (/(auto|scroll)/.test(cs.overflowX) && cur.scrollWidth > cur.clientWidth + 4) return cur;
        cur = cur.parentElement;
      }
    }
    const root = getScrollRoot();
    if (root && root.scrollHeight > root.clientHeight + 4) return null; // use window
    let best = null;
    let bestArea = 0;
    for (const el of document.querySelectorAll('div, main, section, ul, aside')) {
      const cs = window.getComputedStyle(el);
      if (!/(auto|scroll)/.test(cs.overflowY) && !/(auto|scroll)/.test(cs.overflowX)) continue;
      if (el.scrollHeight <= el.clientHeight + 8 && el.scrollWidth <= el.clientWidth + 8) continue;
      const rect = el.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > bestArea) {
        bestArea = area;
        best = el;
      }
    }
    return best;
  }

  function waitForCondition({ selector, text, hidden = false, timeoutMs = 8000 }) {
    const start = Date.now();
    const limit = Math.min(Math.max(Number(timeoutMs) || 8000, 100), 15000);
    const check = () => {
      let matched = true;
      if (selector) {
        const el = queryOneDeep(selector);
        const vis = el ? isVisible(el) : false;
        matched = hidden ? (!el || !vis) : Boolean(el && vis);
      }
      if (matched && text) {
        const bodyTxt = getReadableText(null, 30000);
        const hasText = bodyTxt.includes(String(text));
        matched = hidden ? !hasText : hasText;
      }
      return matched;
    };

    if (check()) {
      return Promise.resolve({ ok: true, waitedMs: 0, matched: true });
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (res) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearInterval(poller);
        clearTimeout(timer);
        resolve(res);
      };
      const tick = () => {
        if (check()) finish({ ok: true, waitedMs: Date.now() - start, matched: true });
      };
      const observer = new MutationObserver(tick);
      if (document.documentElement) {
        observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      }
      const poller = setInterval(tick, 120);
      const timer = setTimeout(() => {
        finish({ ok: false, error: `Timed out after ${limit}ms waiting for ${selector || text || 'condition'}.` });
      }, limit);
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      if (msg.type === 'BA_SET_WORKING') {
        if (!IS_TOP) return false;
        setWorkingState({
          working: msg.working,
          agentName: msg.agentName || 'agy',
          ttlMs: msg.ttlMs ?? 0
        });
        sendResponse({ ok: true });
        return false;
      }

      if (msg.type === 'BA_MOVE_CURSOR') {
        if (!IS_TOP) return false;
        moveCursor({
          x: msg.x,
          y: msg.y,
          action: msg.action || 'move',
          agentName: msg.agentName || 'agy'
        });
        sendResponse({ ok: true });
        return false;
      }

      if (msg.type === 'BA_SET_UI_HIDDEN') {
        if (!IS_TOP) return false;
        if (uiRefs?.host) {
          uiRefs.host.style.display = msg.hidden ? 'none' : 'block';
        }
        sendResponse({ ok: true });
        return false;
      }

      if (msg.type === 'BA_SET_RECORDING') {
        isRecording = Boolean(msg.recording);
        sendResponse({ ok: true, recording: isRecording });
        return false;
      }

      if (msg.type === 'BA_OBSERVE') {
        sendResponse(collectFrameObservation(msg.maxElements || 120, msg.maxTextChars || 6000));
        return false;
      }

      if (msg.type === 'BA_RESOLVE_ELEMENT') {
        const resolved = resolveElement({ elementId: msg.elementId, selector: msg.selector });
        if (!resolved) {
          sendResponse({ ok: false, error: 'Element not found on page' });
          return false;
        }
        sendResponse({ ok: true, meta: resolved.meta });
        return false;
      }

      if (msg.type === 'BA_EXTRACT_TEXT') {
        const text = getReadableText(msg.selector, msg.maxChars || 12000);
        sendResponse({ ok: true, text, url: window.location.href, title: document.title });
        return false;
      }

      if (msg.type === 'BA_SELECT_OPTION') {
        const resolved = resolveElement({ elementId: msg.elementId, selector: msg.selector });
        if (!resolved) {
          sendResponse({ ok: false, error: 'Select element not found' });
          return false;
        }
        const { el } = resolved;
        if (el.tagName !== 'SELECT') {
          sendResponse({ ok: false, error: `Target is <${el.tagName.toLowerCase()}>, not <select>` });
          return false;
        }
        const targetVal = String(msg.value);
        let matched = false;
        for (const opt of el.options) {
          if (opt.value === targetVal || opt.text.trim() === targetVal) {
            el.value = opt.value;
            matched = true;
            break;
          }
        }
        if (!matched) {
          sendResponse({ ok: false, error: `Option "${targetVal}" not found` });
          return false;
        }
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        sendResponse({ ok: true, value: el.value });
        return false;
      }

      if (msg.type === 'BA_CLEAR_ELEMENT') {
        const resolved = resolveElement({ elementId: msg.elementId, selector: msg.selector });
        if (!resolved) {
          sendResponse({ ok: false, error: 'Element not found' });
          return false;
        }
        clearElementValue(resolved.el);
        sendResponse({ ok: true, meta: resolved.meta });
        return false;
      }

      if (msg.type === 'BA_SHOW_SOM') {
        if (IS_TOP) showSomLabels(msg.elements || []);
        sendResponse({ ok: true });
        return false;
      }

      if (msg.type === 'BA_HIDE_SOM') {
        if (IS_TOP) hideSomLabels();
        sendResponse({ ok: true });
        return false;
      }

      if (msg.type === 'BA_WAIT_FOR') {
        waitForCondition(msg).then((res) => sendResponse(res));
        return true;
      }

      if (msg.type === 'BA_EXTRACT_TABLE') {
        sendResponse(extractStructuredTables(msg.selector, msg.maxRows || 200));
        return false;
      }

      if (msg.type === 'BA_GET_STORAGE') {
        sendResponse(collectClientStorage(msg));
        return false;
      }

      if (msg.type === 'BA_GET_PAGE_METRICS') {
        sendResponse(getFullPageMetrics());
        return false;
      }

      if (msg.type === 'BA_SCROLL_TO_Y') {
        sendResponse(scrollToExactY(msg.y));
        return false;
      }

      if (msg.type === 'BA_SCROLL') {
        const amount = Number(msg.amount) || 500;
        const dir = msg.direction || 'down';
        let targetEl = null;
        if (msg.elementId != null || msg.selector) {
          targetEl = resolveElement({ elementId: msg.elementId, selector: msg.selector })?.el || null;
        }
        const container = findScrollableContainer(targetEl);
        if (msg.position === 'top' || msg.position === 'bottom') {
          if (container) {
            container.scrollTop = msg.position === 'top' ? 0 : container.scrollHeight;
            sendResponse({ ok: true, container: buildDeepSelector(container), scrollX: Math.round(container.scrollLeft), scrollY: Math.round(container.scrollTop) });
          } else {
            const root = getScrollRoot();
            window.scrollTo({ top: msg.position === 'top' ? 0 : (root?.scrollHeight || 999999), behavior: 'smooth' });
            sendResponse({ ok: true, scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY) });
          }
          return false;
        }
        let dx = 0;
        let dy = 0;
        if (dir === 'down') dy = amount;
        else if (dir === 'up') dy = -amount;
        else if (dir === 'right') dx = amount;
        else if (dir === 'left') dx = -amount;
        if (container) {
          container.scrollBy({ left: dx, top: dy, behavior: 'smooth' });
          sendResponse({
            ok: true,
            container: buildDeepSelector(container),
            scrollX: Math.round(container.scrollLeft),
            scrollY: Math.round(container.scrollTop)
          });
        } else {
          window.scrollBy({ left: dx, top: dy, behavior: 'smooth' });
          sendResponse({
            ok: true,
            scrollX: Math.round(window.scrollX),
            scrollY: Math.round(window.scrollY)
          });
        }
        return false;
      }
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
    return false;
  });
})();
