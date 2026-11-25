// Full-page scrolling capture, OffscreenCanvas stitching, and lightweight thumbnail generation.

const OVERLAP_RATIO = 0.15;
const SCROLL_DELAY_MS = 520;
const MAX_CANVAS_SIDE = 32767;

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function calculateScrollPositions(totalHeight, viewportHeight, overlapRatio = OVERLAP_RATIO) {
  if (viewportHeight <= 0 || totalHeight <= 0 || totalHeight <= viewportHeight) {
    return [0];
  }
  const step = Math.max(1, Math.floor(viewportHeight * (1 - overlapRatio)));
  const positions = [];
  let y = 0;
  const lastPossibleScroll = Math.max(0, totalHeight - viewportHeight);

  while (true) {
    const clampedY = Math.min(y, lastPossibleScroll);
    if (positions.length === 0 || positions[positions.length - 1] !== clampedY) {
      positions.push(clampedY);
    }
    if (y >= lastPossibleScroll) break;
    y += step;
  }

  if (positions[positions.length - 1] < lastPossibleScroll) {
    positions.push(lastPossibleScroll);
  }
  return positions;
}

export async function blobToDataUrl(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
}

async function dataUrlToBitmap(dataUrl) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return createImageBitmap(blob);
}

export async function createThumbnailDataUrl(dataUrl, { maxWidth = 360, quality = 0.68 } = {}) {
  if (!dataUrl || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
    return null;
  }
  try {
    const bitmap = await dataUrlToBitmap(dataUrl);
    const scale = bitmap.width > maxWidth ? maxWidth / bitmap.width : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
    const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    return await blobToDataUrl(outBlob);
  } catch {
    return null;
  }
}

export async function stitchScreenshotSegments(captures, metrics, { format = 'png', quality = 0.92 } = {}) {
  if (!captures || captures.length === 0) {
    throw new Error('No screenshot segments were captured.');
  }
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
    throw new Error('OffscreenCanvas is unavailable in this environment.');
  }

  const { totalHeight, dpr = 1 } = metrics || {};
  const bitmaps = await Promise.all(captures.map((cap) => dataUrlToBitmap(cap.dataUrl)));

  try {
    const first = bitmaps[0];
    const rawWidth = first.width;
    const rawHeight = Math.max(first.height, Math.round((totalHeight || first.height) * dpr));

    let scale = 1;
    if (rawWidth > MAX_CANVAS_SIDE || rawHeight > MAX_CANVAS_SIDE) {
      scale = Math.min(MAX_CANVAS_SIDE / rawWidth, MAX_CANVAS_SIDE / rawHeight);
    }

    const canvasWidth = Math.max(1, Math.round(rawWidth * scale));
    const canvasHeight = Math.max(1, Math.round(rawHeight * scale));
    const canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
    const ctx = canvas.getContext('2d', { alpha: false });

    for (let i = 0; i < bitmaps.length; i++) {
      const bmp = bitmaps[i];
      const drawY = Math.round(captures[i].scrollY * dpr * scale);
      const drawW = Math.round(bmp.width * scale);
      const drawH = Math.round(bmp.height * scale);
      ctx.drawImage(bmp, 0, drawY, drawW, drawH);
    }

    const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const outBlob = await canvas.convertToBlob(
      format === 'jpeg' ? { type: mime, quality } : { type: mime }
    );
    const dataUrl = await blobToDataUrl(outBlob);
    return {
      dataUrl,
      width: canvasWidth,
      height: canvasHeight,
      scaled: scale < 1
    };
  } finally {
    for (const bmp of bitmaps) {
      bmp?.close?.();
    }
  }
}

async function captureVisibleWithRetry(windowId) {
  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  } catch (err) {
    const msg = String(err?.message || err || '');
    if (/MAX_CAPTURE_VISIBLE_TAB|quota|exceeded/i.test(msg)) {
      await delay(650);
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    }
    throw err;
  }
}

export async function captureFullPage({
  tab,
  sendToContent,
  includeAgentOverlay = false,
  format = 'png',
  maxSegments = 25
}) {
  const tabId = tab.id;
  await chrome.tabs.update(tabId, { active: true });

  if (!includeAgentOverlay) {
    await sendToContent(tabId, { type: 'BA_SET_UI_HIDDEN', hidden: true }, 0).catch(() => {});
  }

  let originalScrollY = 0;
  try {
    const initialMetrics = await sendToContent(tabId, { type: 'BA_GET_PAGE_METRICS' }, 0);
    if (!initialMetrics?.ok || !initialMetrics.totalHeight || !initialMetrics.viewportHeight) {
      throw new Error('Could not measure page dimensions for full-page screenshot.');
    }

    let { totalHeight, viewportHeight, viewportWidth, dpr = 1 } = initialMetrics;
    originalScrollY = initialMetrics.scrollY || 0;

    // Probe bottom so lazy/SPA pages report true document height
    try {
      await sendToContent(tabId, { type: 'BA_SCROLL_TO_Y', y: 9999999 }, 0);
      await delay(220);
      const probed = await sendToContent(tabId, { type: 'BA_GET_PAGE_METRICS' }, 0);
      if (probed?.ok && probed.totalHeight > totalHeight) {
        totalHeight = probed.totalHeight;
        viewportHeight = probed.viewportHeight || viewportHeight;
        viewportWidth = probed.viewportWidth || viewportWidth;
        dpr = probed.dpr || dpr;
      }
      await sendToContent(tabId, { type: 'BA_SCROLL_TO_Y', y: 0 }, 0);
      await delay(180);
    } catch {
      // Non-fatal: continue with initial metrics
    }

    const positions = calculateScrollPositions(totalHeight, viewportHeight).slice(0, Math.max(1, maxSegments));
    const captures = [];

    for (let i = 0; i < positions.length; i++) {
      const y = positions[i];
      const scrollRes = await sendToContent(tabId, { type: 'BA_SCROLL_TO_Y', y }, 0);
      const actualY = typeof scrollRes?.scrollY === 'number' ? scrollRes.scrollY : y;
      await delay(SCROLL_DELAY_MS);
      const dataUrl = await captureVisibleWithRetry(tab.windowId);
      captures.push({ dataUrl, scrollY: actualY, index: i });
    }

    const stitched = await stitchScreenshotSegments(
      captures,
      { totalHeight, viewportHeight, viewportWidth, dpr },
      { format }
    );

    let visionDataUrl;
    if (stitched.width > 3072 || stitched.height > 3072) {
      visionDataUrl = await createThumbnailDataUrl(stitched.dataUrl, { maxWidth: 1280, quality: 0.78 });
    }

    return {
      ok: true,
      tabId,
      screenshotDataUrl: stitched.dataUrl,
      ...(visionDataUrl ? { visionDataUrl } : {}),
      width: stitched.width,
      height: stitched.height,
      scaled: stitched.scaled,
      segments: captures.length,
      totalHeight,
      dpr
    };
  } finally {
    await sendToContent(tabId, { type: 'BA_SCROLL_TO_Y', y: originalScrollY }, 0).catch(() => {});
    if (!includeAgentOverlay) {
      await sendToContent(tabId, { type: 'BA_SET_UI_HIDDEN', hidden: false }, 0).catch(() => {});
    }
  }
}
