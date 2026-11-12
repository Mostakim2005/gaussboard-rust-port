// PDF -> page bitmaps, using the bundled pdf.js build.

import * as pdfjsLib from '../../vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdf.worker.min.mjs', import.meta.url).href;

const BASE = new URL('../../vendor/', import.meta.url).href;

async function renderPageTo(page, scale) {
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(vp.width));
  canvas.height = Math.max(1, Math.ceil(vp.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return { canvas, width: vp.width / scale, height: vp.height / scale };
}

/**
 * Open a PDF once and render pages on demand.
 *
 * pdf.js transfers the ArrayBuffer it is handed, so the document has to be
 * opened once and reused - the page picker renders thumbnails and then the
 * chosen pages at full size from this same handle.
 */
export async function openPdf(data) {
  const safeData = data instanceof Uint8Array
    ? data.slice()
    : data instanceof ArrayBuffer
      ? data.slice(0)
      : data;
  const pdf = await pdfjsLib.getDocument({
    data: safeData,
    cMapUrl: BASE + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: BASE + 'standard_fonts/',
    disableAutoFetch: false,
    isEvalSupported: false
  }).promise;

  return {
    numPages: pdf.numPages,

    async pageSize(pageNo) {
      const page = await pdf.getPage(pageNo);
      const vp = page.getViewport({ scale: 1 });
      return { w: vp.width, h: vp.height };
    },

    /** @returns {Promise<{dataUrl,width,height,page}>} */
    async render(pageNo, scale = 2, type, quality) {
      const page = await pdf.getPage(pageNo);
      const { canvas, width, height } = await renderPageTo(page, scale);
      page.cleanup();
      const format = scale <= 1.25 ? 'image/jpeg' : (type || 'image/png');
      const q = scale <= 1.25 ? (quality ?? 0.75) : quality;
      return { dataUrl: canvas.toDataURL(format, q), width, height, page: pageNo };
    },

    /** Small preview for the page picker. */
    async thumb(pageNo, maxEdge = 190) {
      const page = await pdf.getPage(pageNo);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(maxEdge / base.width, maxEdge / base.height, 1.2);
      const { canvas } = await renderPageTo(page, scale);
      page.cleanup();
      return canvas.toDataURL('image/jpeg', 0.72);
    },

    destroy() { return pdf.destroy(); }
  };
}

/**
 * Convenience wrapper: render some or all pages in one go.
 * @param {ArrayBuffer} data
 * @param {{scale?:number, pages?:number[], onProgress?:(i,n)=>void}} opts
 */
export async function pdfToPages(data, opts = {}) {
  const doc = await openPdf(data);
  const list = opts.pages?.length ? opts.pages : Array.from({ length: doc.numPages }, (_, i) => i + 1);
  const out = [];
  try {
    for (let i = 0; i < list.length; i++) {
      opts.onProgress?.(i + 1, list.length);
      out.push(await doc.render(list[i], opts.scale ?? 2));
    }
  } finally {
    await doc.destroy();
  }
  return out;
}
