// Export chosen library boards without opening them or changing the active board.
import { exportable, safeName, readPdfAssetBytes, restoreZipAssets } from './export.js';
import { pdfCache } from './core/pdf-cache.js';
import { t } from './i18n.js';

let zipLibrary;
export async function loadZip() {
  if (window.JSZip) return window.JSZip;
  if (!zipLibrary) zipLibrary = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('../vendor/jszip.min.js', import.meta.url).href;
    script.onload = () => resolve(window.JSZip);
    script.onerror = () => { script.remove(); zipLibrary = null; reject(new Error(t('Could not load the ZIP exporter'))); };
    document.head.appendChild(script);
  });
  return zipLibrary;
}

async function collectBoardAssetEntries(doc) {
  const entries = [];
  const seen = new Set();
  if (Array.isArray(doc?.audioTracks)) {
    for (const tr of doc.audioTracks) {
      if (!tr?.assetId || seen.has(tr.assetId)) continue;
      seen.add(tr.assetId);
      try {
        const audioBuf = await window.board?.recording?.readAsset?.(tr.assetId);
        if (audioBuf && audioBuf.byteLength > 0) {
          entries.push({ name: `assets/${tr.assetId}`, data: new Uint8Array(audioBuf) });
        }
      } catch {}
    }
  }
  const pdfObjects = (doc?.objects || []).filter((o) => o && o.type === 'pdf-page' && o.assetId);
  for (const o of pdfObjects) {
    if (seen.has(o.assetId)) continue;
    seen.add(o.assetId);
    try {
      const rawBytes = await readPdfAssetBytes(o.assetId);
      if (rawBytes && rawBytes.byteLength > 0) {
        entries.push({ name: `assets/${o.assetId}`, data: rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes) });
      }
    } catch {}
  }
  return entries;
}

export async function exportBoards(app, ids) {
  ids = [...new Set(ids)];
  if (!ids.length) return null;
  app.commitTextEdit();
  const files = [];
  const names = new Set();
  for (const id of ids) {
    const source = id === app.store.doc.id ? structuredClone(app.store.toJSON()) : await window.board.boards.load(id);
    if (!source) throw new Error(t('A selected board is no longer available. Refresh My boards and try again.'));
    const doc = await app.resolveAssets(source);
    if (doc.objects?.some((o) => o.type === 'image' && o.missing))
      throw new Error(t('“{name}” has missing images. Restore them before exporting.', { name: doc.name || t('Untitled board') }));
    const base = safeName(doc.name);
    let name = base + '.gaussboard', suffix = 2;
    while (names.has(name.toLowerCase())) name = `${base} (${suffix++}).gaussboard`;
    names.add(name.toLowerCase());
    const cleanDoc = exportable(doc);
    const assetEntries = await collectBoardAssetEntries(cleanDoc);
    files.push({ name, content: JSON.stringify(cleanDoc), assetEntries });
  }
  const multiple = files.length > 1;
  const path = await window.board.saveDialog({
    title: multiple ? t('Export {n} boards', { n: files.length }) : t('Export selected board'),
    defaultPath: multiple ? 'GaussBoard-boards.zip' : files[0].name,
    filters: [{ name: multiple ? t('ZIP archive') : t('GaussBoard file'), extensions: [multiple ? 'zip' : 'gaussboard'] }]
  });
  if (!path) return null;
  let bytes;
  if (multiple) {
    const Zip = await loadZip();
    const zip = new Zip();
    for (const file of files) {
      if (file.assetEntries && file.assetEntries.length > 0) {
        const inner = new Zip();
        inner.file('board.json', file.content);
        for (const entry of file.assetEntries) {
          inner.file(entry.name, entry.data);
          zip.file(entry.name, entry.data);
        }
        const innerBytes = await inner.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 1 } });
        zip.file(file.name, innerBytes);
      } else {
        zip.file(file.name, file.content);
      }
    }
    bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 1 } });
  } else if (files[0].assetEntries && files[0].assetEntries.length > 0) {
    const Zip = await loadZip();
    const zip = new Zip();
    zip.file('board.json', files[0].content);
    for (const entry of files[0].assetEntries) {
      zip.file(entry.name, entry.data);
    }
    bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 1 } });
  } else {
    bytes = new TextEncoder().encode(files[0].content);
  }
  await window.board.writeFile(path, bytes);
  app.toast(multiple ? t('Exported {n} boards', { n: files.length }) : t('Exported {n} board', { n: files.length }), 'check');
  return path;
}

export async function importBoards(app, buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04) {
    const Zip = await loadZip();
    const zip = await Zip.loadAsync(buf);
    await restoreZipAssets(zip);
    const boardEntry = zip.file('board.json');
    if (boardEntry) {
      const data = JSON.parse(await boardEntry.async('text'));
      await app.loadBoard(data, { asCopy: false });
      return [data];
    }
    const imported = [];
    for (const [relPath, fileEntry] of Object.entries(zip.files || {})) {
      if (fileEntry.dir || !/\.(gaussboard|gazboard|json)$/i.test(relPath)) continue;
      const entryBytes = await fileEntry.async('uint8array');
      if (entryBytes[0] === 0x50 && entryBytes[1] === 0x4B) {
        const innerZip = await Zip.loadAsync(entryBytes);
        await restoreZipAssets(innerZip);
        const innerBoard = innerZip.file('board.json');
        if (innerBoard) {
          const data = JSON.parse(await innerBoard.async('text'));
          imported.push(data);
        }
      } else {
        const data = JSON.parse(new TextDecoder().decode(entryBytes));
        imported.push(data);
      }
    }
    return imported;
  }
  const data = JSON.parse(new TextDecoder().decode(bytes));
  await app.loadBoard(data, { asCopy: false });
  return [data];
}
