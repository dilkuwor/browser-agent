// Deterministic converter from recorded/executed Browser Agent steps to Playwright (.spec.ts) or Puppeteer (.mjs).

const SECRET_TOKEN_RE = /\{\{([A-Za-z0-9_.-]+)\}\}/g;

function extractValueExpr(raw, envVars) {
  const str = String(raw ?? '');
  SECRET_TOKEN_RE.lastIndex = 0;
  const matches = [...str.matchAll(SECRET_TOKEN_RE)];
  if (matches.length === 0) return JSON.stringify(str);

  for (const m of matches) envVars.add(m[1]);
  if (matches.length === 1 && matches[0][0] === str) {
    return `(process.env.${matches[0][1]} ?? '')`;
  }
  const tpl = str
    .replace(/[`\\$]/g, (ch) => `\\${ch}`)
    .replace(SECRET_TOKEN_RE, (_m, name) => `\${process.env.${name} ?? ''}`);
  return `\`${tpl}\``;
}

function selectorExpr(sel) {
  return JSON.stringify(String(sel || ''));
}

function renderWait(ms, isPlaywright) {
  const waitMs = Math.max(50, Number(ms) || 1000);
  return isPlaywright
    ? `  await page.waitForTimeout(${waitMs});`
    : `  await new Promise((r) => setTimeout(r, ${waitMs}));`;
}

function renderFillField(field, isPlaywright, envVars) {
  const sel = field.selector;
  if (!sel) return [`  // Skipped fill_form field without selector (${JSON.stringify(field.label || '')})`];
  const valStr = String(field.value ?? '');
  const expr = extractValueExpr(valStr, envVars);
  const lines = [];
  if (isPlaywright) {
    if (valStr === 'true' || valStr === 'false') {
      lines.push(`  await page.locator(${selectorExpr(sel)}).setChecked(${valStr === 'true'});`);
    } else {
      lines.push(`  await page.locator(${selectorExpr(sel)}).fill(${expr});`);
    }
  } else {
    lines.push(`  await page.waitForSelector(${selectorExpr(sel)});`);
    if (field.clearFirst !== false) {
      lines.push(`  await page.$eval(${selectorExpr(sel)}, (el) => { if ('value' in el) el.value = ''; });`);
    }
    lines.push(`  await page.type(${selectorExpr(sel)}, ${expr});`);
  }
  return lines;
}

function renderStep(step, format, envVars) {
  const isPlaywright = format === 'playwright';
  const a = step?.args || {};
  const tool = step?.tool;

  if (tool === 'open_tab' || tool === 'navigate') {
    if (!a.url) return [];
    return isPlaywright
      ? [`  await page.goto(${JSON.stringify(a.url)}, { waitUntil: 'domcontentloaded' });`]
      : [`  await page.goto(${JSON.stringify(a.url)}, { waitUntil: 'domcontentloaded' });`];
  }

  if (tool === 'click') {
    if (a.selector) {
      return isPlaywright
        ? [`  await page.locator(${selectorExpr(a.selector)}).click();`]
        : [`  await page.waitForSelector(${selectorExpr(a.selector)});`, `  await page.click(${selectorExpr(a.selector)});`];
    }
    if (a.x != null && a.y != null) {
      return [`  await page.mouse.click(${Number(a.x)}, ${Number(a.y)});`];
    }
    return [`  // Click step without selector/coordinates`];
  }

  if (tool === 'type') {
    const expr = extractValueExpr(a.text ?? '', envVars);
    const lines = [];
    if (a.selector) {
      if (isPlaywright) {
        lines.push(`  await page.locator(${selectorExpr(a.selector)}).fill(${expr});`);
      } else {
        lines.push(`  await page.waitForSelector(${selectorExpr(a.selector)});`);
        if (a.clearFirst !== false) {
          lines.push(`  await page.$eval(${selectorExpr(a.selector)}, (el) => { if ('value' in el) el.value = ''; });`);
        }
        lines.push(`  await page.type(${selectorExpr(a.selector)}, ${expr});`);
      }
    } else {
      lines.push(`  await page.keyboard.type(${expr});`);
    }
    if (a.pressEnter) lines.push(`  await page.keyboard.press('Enter');`);
    return lines;
  }

  if (tool === 'fill_form') {
    const lines = [];
    for (const f of a.fields || []) {
      lines.push(...renderFillField(f, isPlaywright, envVars));
    }
    if (a.submitSelector) {
      lines.push(
        isPlaywright
          ? `  await page.locator(${selectorExpr(a.submitSelector)}).click();`
          : `  await page.click(${selectorExpr(a.submitSelector)});`
      );
    }
    return lines;
  }

  if (tool === 'select_option') {
    if (!a.selector) return [`  // Select step missing selector`];
    const expr = extractValueExpr(a.value ?? '', envVars);
    return isPlaywright
      ? [`  await page.locator(${selectorExpr(a.selector)}).selectOption(${expr});`]
      : [`  await page.select(${selectorExpr(a.selector)}, ${expr});`];
  }

  if (tool === 'upload_file') {
    const files = JSON.stringify(Array.isArray(a.files) ? a.files : []);
    if (!a.selector) return [`  // Upload step missing selector for files: ${files}`];
    return isPlaywright
      ? [`  await page.locator(${selectorExpr(a.selector)}).setInputFiles(${files});`]
      : [`  await (await page.$(${selectorExpr(a.selector)}))?.uploadFile(...${files});`];
  }

  if (tool === 'drag_and_drop') {
    if (a.fromSelector && a.toSelector && isPlaywright) {
      return [`  await page.locator(${selectorExpr(a.fromSelector)}).dragTo(page.locator(${selectorExpr(a.toSelector)}));`];
    }
    if (a.fromX != null && a.fromY != null && a.toX != null && a.toY != null) {
      return [
        `  await page.mouse.move(${Number(a.fromX)}, ${Number(a.fromY)});`,
        `  await page.mouse.down();`,
        `  await page.mouse.move(${Number(a.toX)}, ${Number(a.toY)}, { steps: 12 });`,
        `  await page.mouse.up();`
      ];
    }
    return [`  // Drag step could not resolve selectors/coordinates cleanly`];
  }

  if (tool === 'press_key') {
    return [`  await page.keyboard.press(${JSON.stringify(a.key || 'Enter')});`];
  }

  if (tool === 'scroll') {
    const amt = Number(a.amount) || 500;
    const dx = a.direction === 'right' ? amt : a.direction === 'left' ? -amt : 0;
    const dy = a.direction === 'up' ? -amt : a.direction === 'down' || !dx ? amt : 0;
    return [`  await page.evaluate(() => window.scrollBy(${dx}, ${dy}));`];
  }

  if (tool === 'wait') {
    return [renderWait(a.ms, isPlaywright)];
  }

  if (tool === 'wait_for') {
    if (a.selector) {
      return isPlaywright
        ? [`  await page.locator(${selectorExpr(a.selector)}).waitFor({ state: ${a.hidden ? "'hidden'" : "'visible'"} });`]
        : [`  await page.waitForSelector(${selectorExpr(a.selector)}${a.hidden ? ', { hidden: true }' : ''});`];
    }
    if (a.text) {
      return isPlaywright
        ? [`  await page.getByText(${JSON.stringify(a.text)}).waitFor();`]
        : [`  await page.waitForFunction((t) => document.body.innerText.includes(t), {}, ${JSON.stringify(a.text)});`];
    }
    if (a.urlIncludes) {
      return isPlaywright
        ? [`  await page.waitForURL((u) => u.href.includes(${JSON.stringify(a.urlIncludes)}));`]
        : [`  await page.waitForFunction((u) => location.href.includes(u), {}, ${JSON.stringify(a.urlIncludes)});`];
    }
  }

  return [`  // Unsupported step: ${tool}`];
}

/**
 * Convert recorded or last-run Browser Agent steps into a reproducible Playwright (.spec.ts) or Puppeteer (.mjs) script.
 */
export function generateAutomationScript(steps = [], { format = 'playwright', name = 'Browser Agent Workflow' } = {}) {
  const cleanFormat = format === 'puppeteer' ? 'puppeteer' : 'playwright';
  const cleanSteps = Array.isArray(steps) ? steps : [];
  const envVars = new Set();
  const bodyLines = cleanSteps.flatMap((step) => renderStep(step, cleanFormat, envVars));

  const safeSlug = String(name || 'workflow')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'workflow';

  const envHeader = envVars.size > 0
    ? `// Required environment variables (from Secrets Vault): ${[...envVars].join(', ')}\n`
    : '';

  if (cleanFormat === 'playwright') {
    const code = [
      `import { test, expect } from '@playwright/test';`,
      envHeader.trimEnd(),
      ``,
      `test(${JSON.stringify(name)}, async ({ page }) => {`,
      ...bodyLines,
      `});`,
      ``
    ].filter((l, i) => i !== 1 || l !== '').join('\n');
    return { ok: true, format: 'playwright', filename: `${safeSlug}.spec.ts`, code, envVars: [...envVars] };
  }

  const code = [
    `import puppeteer from 'puppeteer';`,
    envHeader.trimEnd(),
    ``,
    `async function run() {`,
    `  const browser = await puppeteer.launch({ headless: false });`,
    `  const page = await browser.newPage();`,
    ...bodyLines.map((l) => `  ${l}`),
    `  await browser.close();`,
    `}`,
    ``,
    `run().catch((err) => { console.error(err); process.exit(1); });`,
    ``
  ].filter((l, i) => i !== 1 || l !== '').join('\n');

  return { ok: true, format: 'puppeteer', filename: `${safeSlug}.mjs`, code, envVars: [...envVars] };
}
