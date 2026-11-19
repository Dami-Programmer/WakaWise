// State packages stored on the device (IndexedDB), so the map, search and routing work with no data.
//
// Each file is saved in 4 MB pieces as it downloads, so an interrupted download carries on from the
// last saved piece next time (HTTP Range request). A new version of the map downloads next to the
// one in use and only replaces it once it is complete, so a failed update never leaves you with nothing.
//
// Records in the "packs" store:
//   { slug, active: {build, info, savedAt} | null, pending: {build, info, got: {file: bytes}, complete} | null }
// Pieces in the "chunks" store, keyed [slug, build, file, index] -> ArrayBuffer (4 MB each, the last one shorter).
//
// Pieces are stored as plain ArrayBuffers, not Blobs: Safari on iPhone has several bugs with Blobs in
// IndexedDB (pieces read back empty or unreadable). Map tiles are then read a few pieces at a time
// (StoredSource), so a 50 MB map never has to sit in the phone's memory at once.

export const FILES = ['tiles.pmtiles', 'graph.bin', 'graph.json', 'search.json'];
const CHUNK = 4 * 1024 * 1024;
const FORMAT = 2; // storage format; packs saved by older versions are downloaded again
let dbPromise;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('offline-map', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('packs', { keyPath: 'slug' });
      req.result.createObjectStore('chunks');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const done = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

async function tx(stores, mode, fn) {
  const t = (await db()).transaction(stores, mode);
  const result = fn(t);
  await new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage write was cancelled (device storage may be full)'));
  });
  return result instanceof IDBRequest ? result.result : result;
}

const buildId = (info) => info.built || String(info.bytes);
const fileRange = (slug, build, file) => IDBKeyRange.bound([slug, build, file, 0], [slug, build, file, Infinity]);
const buildRange = (slug, build) => IDBKeyRange.bound([slug, build, '', 0], [slug, build, '￿', Infinity]);

/** All stored packs, by slug. */
export async function listPacks() {
  try {
    const all = await tx(['packs'], 'readonly', (t) => t.objectStore('packs').getAll());
    return Object.fromEntries(all.map((p) => [p.slug, p]));
  } catch {
    return {}; // no IndexedDB (private mode in some browsers)
  }
}

export async function getPack(slug) {
  return (await tx(['packs'], 'readonly', (t) => t.objectStore('packs').get(slug))) || { slug, active: null, pending: null };
}

function putPack(t, pack) {
  t.objectStore('packs').put(pack);
}

/**
 * If a finished update is waiting, make it the one in use and delete the old version.
 * Only call this when the old version isn't open (e.g. before opening the state).
 */
export async function applyUpdate(slug) {
  const pack = await getPack(slug);
  if (!pack.pending?.complete) return pack;
  const old = pack.active;
  pack.active = { build: pack.pending.build, info: pack.pending.info, savedAt: Date.now(), format: pack.pending.format };
  pack.pending = null;
  await tx(['packs', 'chunks'], 'readwrite', (t) => {
    putPack(t, pack);
    if (old && old.build !== pack.active.build) t.objectStore('chunks').delete(buildRange(slug, old.build));
  });
  return pack;
}

/**
 * The stored files of the version in use: read(file) gives a whole file as an ArrayBuffer, and
 * source(key) a pmtiles source that reads the tiles straight from storage.
 * Throws if the saved copy is missing pieces or uses an old format (the caller then downloads again).
 */
export async function loadFiles(slug) {
  const pack = await getPack(slug);
  if (!pack.active) return null;
  const { build, info } = pack.active;
  if (pack.active.format !== FORMAT) throw new Error('Saved map uses an old storage format');
  const counts = {};
  await tx(['chunks'], 'readonly', (t) => {
    for (const f of FILES) t.objectStore('chunks').count(fileRange(slug, build, f)).onsuccess = (e) => (counts[f] = e.target.result);
  });
  for (const f of FILES) {
    if (counts[f] !== Math.ceil(info.files[f] / CHUNK)) throw new Error(`Saved map is incomplete (${f})`);
  }
  return {
    info,
    build,
    read: (f) => readFile(slug, build, f, info.files[f]),
    source: (key) => new StoredSource(slug, build, info.files['tiles.pmtiles'], key),
  };
}

async function readFile(slug, build, file, size) {
  const parts = await tx(['chunks'], 'readonly', (t) => t.objectStore('chunks').getAll(fileRange(slug, build, file)));
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    const bytes = new Uint8Array(part);
    if (at + bytes.length > size) break;
    out.set(bytes, at);
    at += bytes.length;
  }
  if (at !== size) throw new Error(`Saved map is damaged (${file})`);
  return out.buffer;
}

/** pmtiles source reading the stored tiles file piece by piece, keeping the last few pieces in memory. */
class StoredSource {
  constructor(slug, build, size, key) {
    Object.assign(this, { slug, build, size, key });
    this.pieces = new Map(); // index -> Promise<Uint8Array>, oldest first
  }

  getKey() {
    return this.key;
  }

  piece(i) {
    let p = this.pieces.get(i);
    if (p) this.pieces.delete(i); // move to the newest end
    else {
      p = tx(['chunks'], 'readonly', (t) => t.objectStore('chunks').get([this.slug, this.build, 'tiles.pmtiles', i])).then((buf) => {
        if (!buf) throw new Error('Saved map is missing a piece');
        return new Uint8Array(buf);
      });
      p.catch(() => this.pieces.delete(i));
    }
    this.pieces.set(i, p);
    while (this.pieces.size > 6) this.pieces.delete(this.pieces.keys().next().value);
    return p;
  }

  async getBytes(offset, length) {
    const end = Math.min(offset + length, this.size);
    const out = new Uint8Array(Math.max(0, end - offset));
    for (let i = Math.floor(offset / CHUNK); i * CHUNK < end; i++) {
      const piece = await this.piece(i);
      const from = Math.max(offset, i * CHUNK);
      const to = Math.min(end, (i + 1) * CHUNK);
      out.set(piece.subarray(from - i * CHUNK, to - i * CHUNK), from - offset);
    }
    return { data: out.buffer };
  }
}

/** Bytes still to download for this state's current version (for "Resume" messages). */
export async function progressOf(slug, info) {
  const pack = await getPack(slug);
  const p = pack.pending;
  if (!p || p.build !== buildId(info)) return 0;
  return FILES.reduce((a, f) => a + (p.got[f] || 0), 0);
}

/**
 * Download (or carry on downloading) a state's package. Calls onProgress(bytesSaved, totalBytes).
 * Resolves with the pack record once every file is saved; the new version is then waiting in
 * `pending` (complete) until applyUpdate() swaps it in.
 */
const running = new Map(); // slug -> promise, so one state never downloads twice at once

export function downloadPack(slug, info, base, opts = {}) {
  if (running.has(slug)) return Promise.reject(new Error('this map is already downloading in the background; please wait a moment'));
  const p = download(slug, info, base, opts).finally(() => running.delete(slug));
  running.set(slug, p);
  return p;
}

async function download(slug, info, base, { onProgress = () => {}, signal } = {}) {
  const build = buildId(info);
  const pack = await getPack(slug);
  if (pack.active?.build === build) return pack;
  if (pack.pending && (pack.pending.build !== build || pack.pending.format !== FORMAT)) {
    // an older half-finished version (or one saved the old way): throw it away rather than mix them
    const stale = pack.pending.build;
    pack.pending = null;
    await tx(['packs', 'chunks'], 'readwrite', (t) => {
      putPack(t, pack);
      t.objectStore('chunks').delete(buildRange(slug, stale));
    });
  }
  pack.pending ??= { build, info, got: {}, complete: false, format: FORMAT };
  const total = FILES.reduce((a, f) => a + info.files[f], 0);
  const saved = () => FILES.reduce((a, f) => a + (pack.pending.got[f] || 0), 0);
  onProgress(saved(), total);

  // small files first so search and routing are ready to test sooner if something goes wrong
  for (const file of [...FILES].sort((a, b) => info.files[a] - info.files[b])) {
    const size = info.files[file];
    let got = pack.pending.got[file] || 0;
    if (got >= size) continue;
    pack.pending.etag ??= {};
    const headers = {};
    if (got) {
      headers.Range = `bytes=${got}-`;
      // If the file changed on the server since we started, it sends the whole new file instead
      if (pack.pending.etag[file]) headers['If-Range'] = pack.pending.etag[file];
    }
    const res = await fetch(base + file, { headers, cache: 'no-store', signal });
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    if (res.status === 200 && got) {
      // the server sent the whole file (no Range support, or it changed): start this file again
      got = 0;
      pack.pending.got[file] = 0;
      await tx(['packs', 'chunks'], 'readwrite', (t) => {
        putPack(t, pack);
        t.objectStore('chunks').delete(fileRange(slug, build, file));
      });
    }
    const etag = res.headers.get('ETag');
    if (etag && !etag.startsWith('W/') && res.status === 200) pack.pending.etag[file] = etag;
    const reader = res.body.getReader();
    let piece = new Uint8Array(CHUNK);
    let buffered = 0; // received but not yet saved
    const save = async (buf) => {
      const index = got / CHUNK;
      got += buf.byteLength;
      pack.pending.got[file] = got;
      await tx(['packs', 'chunks'], 'readwrite', (t) => {
        t.objectStore('chunks').put(buf, [slug, build, file, index]);
        putPack(t, pack);
      });
    };
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      let at = 0;
      while (at < value.length) {
        const n = Math.min(CHUNK - buffered, value.length - at);
        piece.set(value.subarray(at, at + n), buffered);
        buffered += n;
        at += n;
        if (buffered === CHUNK) {
          await save(piece.buffer);
          piece = new Uint8Array(CHUNK);
          buffered = 0;
        }
      }
      onProgress(saved() + buffered, total);
    }
    if (buffered) await save(piece.slice(0, buffered).buffer);
    if (got !== size) {
      // wrong size: the file on the server changed; start it again next time
      pack.pending.got[file] = 0;
      await tx(['packs', 'chunks'], 'readwrite', (t) => {
        putPack(t, pack);
        t.objectStore('chunks').delete(fileRange(slug, build, file));
      });
      throw new Error(`${file} has an unexpected size; please try again`);
    }
    onProgress(saved(), total);
  }
  pack.pending.complete = true;
  await tx(['packs'], 'readwrite', (t) => putPack(t, pack));
  return pack;
}

/** Delete everything stored for a state. */
export async function removePack(slug) {
  await tx(['packs', 'chunks'], 'readwrite', (t) => {
    t.objectStore('packs').delete(slug);
    t.objectStore('chunks').delete(IDBKeyRange.bound([slug, '', '', 0], [slug, '￿', '￿', Infinity]));
  });
}

/** Ask the browser not to clear our storage when space runs low. */
export async function keepStorage() {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

/** Free space the browser will let us use, in bytes (null if unknown). */
export async function freeSpace() {
  try {
    const e = await navigator.storage?.estimate?.();
    return e ? e.quota - e.usage : null;
  } catch {
    return null;
  }
}
