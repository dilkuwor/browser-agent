// Safety, domain access control, HITL classification, and prompt-injection isolation.

const SENSITIVE_KEYWORDS = [
  'submit', 'pay', 'purchase', 'buy', 'checkout', 'order', 'confirm',
  'delete', 'remove', 'transfer', 'send', 'publish', 'post', 'sign in', 'log in', 'login'
];

export function isDomainAllowed(url, settings = {}) {
  if (!url) {
    return { allowed: false, reason: 'Invalid URL.' };
  }
  const lower = String(url).toLowerCase();
  if (
    lower.startsWith('chrome://') ||
    lower.startsWith('chrome-extension://') ||
    lower.startsWith('chrome-devtools://') ||
    lower.startsWith('devtools://') ||
    lower.startsWith('edge://') ||
    lower.startsWith('about:') ||
    lower.startsWith('view-source:') ||
    lower.startsWith('javascript:') ||
    lower.startsWith('data:') ||
    lower.startsWith('vbscript:')
  ) {
    // Allow internal navigation checks only if explicitly navigating away; block automation on internal/script URLs
    const preview = String(url).slice(0, 80);
    return {
      allowed: false,
      reason: `Cannot run on internal or script page (${preview}). Switch to a regular webpage tab (http:// or https://) first.`
    };
  }

  let hostname = '';
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return { allowed: false, reason: 'Invalid URL.' };
  }

  const blocklist = parseDomainList(settings.domainBlocklist);
  for (const blocked of blocklist) {
    if (hostname === blocked || hostname.endsWith(`.${blocked}`)) {
      return { allowed: false, reason: `Domain "${hostname}" is in your blocklist.` };
    }
  }

  const allowlist = parseDomainList(settings.domainAllowlist);
  if (allowlist.length > 0) {
    const matched = allowlist.some((d) => hostname === d || hostname.endsWith(`.${d}`));
    if (!matched) {
      return { allowed: false, reason: `Domain "${hostname}" is not in your allowlist.` };
    }
  }

  return { allowed: true };
}

function parseDomainList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[\n,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function requiresHumanApproval(toolName, args = {}, elementMeta = null, settings = {}) {
  // Read-only / observation tools never require approval
  const readOnlyTools = new Set([
    'observe_page', 'extract_text', 'extract_table', 'screenshot', 'full_page_screenshot',
    'get_console_logs', 'get_network_requests', 'get_network_detail', 'inspect_storage',
    'list_tabs', 'list_downloads', 'list_macros', 'export_script', 'wait', 'wait_for', 'detach_debugger', 'ask_user'
  ]);
  if (readOnlyTools.has(toolName)) return { required: false };

  if (settings.autoApproveLowRisk === false) {
    return { required: true, reason: 'Auto-approve is disabled in settings.' };
  }

  if (toolName === 'upload_file') {
    const names = (args.files || []).map((f) => String(f).split(/[/\\]/).pop()).join(', ');
    return { required: true, reason: `Uploading local file(s): ${names || 'file'}.` };
  }

  if (toolName === 'type' && elementMeta?.type === 'password') {
    return { required: true, reason: 'Typing into a password field.' };
  }

  if (toolName === 'click' && elementMeta) {
    const text = `${elementMeta.label || ''} ${elementMeta.type || ''}`.toLowerCase();
    const hit = SENSITIVE_KEYWORDS.find((kw) => text.includes(kw));
    if (hit) {
      return { required: true, reason: `Clicking potentially consequential element ("${elementMeta.label || hit}").` };
    }
  }

  return { required: false };
}

export function wrapUntrustedContent(label, content) {
  const safe = String(content || '').replace(/<\/?untrusted_page_content>/gi, '');
  return `<untrusted_page_content source="${label}">\n${safe}\n</untrusted_page_content>`;
}
