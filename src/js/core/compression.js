// compression.js — Offline Image & PDF compression engine for GazBoard
// Invariant: Modular JavaScript frontend, offline-first; heavy native compute offloaded to Rust/native host.

/**
 * Calculates byte size of a data URL or string.
 * @param {string} dataUrl
 * @returns {number}
 */
export function byteSizeOfDataUrl(dataUrl) {
  if (!dataUrl) return 0;
  if (!dataUrl.startsWith('data:')) return dataUrl.length;
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return 0;
  const b64 = dataUrl.slice(comma + 1);
  return Math.round((b64.length * 3) / 4);
}

/**
 * Formats a byte size into human readable string (e.g. "1.4 MB", "340 KB").
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes <= 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

/**
 * Compresses an image data URL or image source using HTML5 Canvas.
 * Supports downsampling large resolutions and quality re-encoding.
 * @param {string|HTMLImageElement} source
 * @param {object} options
 * @returns {Promise<{ dataUrl: string, originalSize: number, compressedSize: number, width: number, height: number, savingsPercent: number }>}
 */
export async function compressImage(source, options = {}) {
  const maxDim = options.maxDimension || 1920;
  const quality = typeof options.quality === 'number' ? options.quality : 0.82;
  const format = options.format || 'image/jpeg';

  let img;
  let originalSize = 0;

  if (typeof source === 'string') {
    originalSize = byteSizeOfDataUrl(source);
    img = new Image();
    img.src = source;
    await new Promise((resolve, reject) => {
      if (img.complete) return resolve();
      img.onload = resolve;
      img.onerror = () => reject(new Error('Failed to load source image for compression'));
    });
  } else {
    img = source;
    originalSize = (img.naturalWidth || img.width) * (img.naturalHeight || img.height) * 4;
  }

  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;

  // Compute scaled dimensions preserving aspect ratio
  let targetW = iw;
  let targetH = ih;
  if (iw > maxDim || ih > maxDim) {
    if (iw >= ih) {
      targetW = maxDim;
      targetH = Math.round((ih * maxDim) / iw);
    } else {
      targetH = maxDim;
      targetW = Math.round((iw * maxDim) / ih);
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');

  // High quality interpolation
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // If JPEG, fill white background to handle transparency
  if (format === 'image/jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, targetW, targetH);
  }

  ctx.drawImage(img, 0, 0, targetW, targetH);

  const compressedDataUrl = canvas.toDataURL(format, quality);
  const compressedSize = byteSizeOfDataUrl(compressedDataUrl);

  const savings = originalSize > 0 ? Math.max(0, Math.round(((originalSize - compressedSize) / originalSize) * 100)) : 0;

  return {
    dataUrl: compressedDataUrl,
    originalSize,
    compressedSize,
    width: targetW,
    height: targetH,
    savingsPercent: savings
  };
}

/**
 * Compresses and optimizes a PDF document using pdf-lib.
 * Strips unused objects and compresses cross-reference streams.
 * @param {Uint8Array|ArrayBuffer} pdfBytes
 * @returns {Promise<{ pdfBytes: Uint8Array, originalSize: number, compressedSize: number, savingsPercent: number }>}
 */
export async function compressPdfDocument(pdfBytes) {
  // Dynamically load pdf-lib from vendor if in browser
  let PDFLib = typeof window !== 'undefined' ? window.PDFLib : null;
  if (!PDFLib && typeof document !== 'undefined') {
    await new Promise((resolve, reject) => {
      if (window.PDFLib) return resolve(window.PDFLib);
      const s = document.createElement('script');
      s.src = './vendor/pdf-lib.min.js';
      s.onload = () => resolve(window.PDFLib);
      s.onerror = reject;
      document.head.appendChild(s);
    });
    PDFLib = window.PDFLib;
  }

  const origSize = pdfBytes.byteLength || pdfBytes.length;
  if (!PDFLib) {
    return { pdfBytes: new Uint8Array(pdfBytes), originalSize: origSize, compressedSize: origSize, savingsPercent: 0 };
  }

  const pdfDoc = await PDFLib.PDFDocument.load(pdfBytes, { ignoreEncryption: true });

  // Save with optimized object streams enabled
  const compressedBytes = await pdfDoc.save({
    useObjectStreams: true,
    addDefaultPage: false
  });

  const compSize = compressedBytes.byteLength;
  const savings = origSize > 0 ? Math.max(0, Math.round(((origSize - compSize) / origSize) * 100)) : 0;

  return {
    pdfBytes: compressedBytes,
    originalSize: origSize,
    compressedSize: compSize,
    savingsPercent: savings
  };
}
