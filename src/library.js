// Model kütüphanesi ve baskı kayıtları.
// Küçük veriler (isim, not, küçük resim, baskı kayıtları) localStorage'da; geometri IndexedDB'de tutulur.

const LIB_KEY = 'stlogi.lib';
const PRINT_KEY = 'stlogi.prints';

function readJSON(key) {
  try { const v = JSON.parse(localStorage.getItem(key)); return Array.isArray(v) ? v : []; } catch { return []; }
}
function writeJSON(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); return true; } catch { return false; }
}

// ---- IndexedDB (geometri) ----
let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const rq = indexedDB.open('stlogi', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('scenes');
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  }
  return dbp;
}
async function idb(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction('scenes', mode);
    const rq = fn(tx.objectStore('scenes'));
    tx.oncomplete = () => res(rq?.result);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
}

// ---- Kütüphane ----
export const listModels = () => readJSON(LIB_KEY).sort((a, b) => b.updated - a.updated);

/** scene: [{ name, slot, p:[3], q:[4], s:[3], positions: Float32Array }] */
export async function saveModel({ id, name, note = '', thumb, dims, scene }) {
  const lib = readJSON(LIB_KEY);
  const now = Date.now();
  let e = id && lib.find((x) => x.id === id);
  if (!e) { e = { id: 'm' + now.toString(36) + Math.random().toString(36).slice(2, 6), created: now, note }; lib.push(e); }
  Object.assign(e, { name, thumb, dims, count: scene.length, updated: now });
  if (note && !e.note) e.note = note;
  await idb('readwrite', (s) => s.put(scene, e.id));
  if (!writeJSON(LIB_KEY, lib)) throw new Error('Tarayıcı depolama alanı dolu');
  return e;
}
export async function loadScene(id) { return idb('readonly', (s) => s.get(id)); }
export function updateModel(id, patch) {
  const lib = readJSON(LIB_KEY);
  const e = lib.find((x) => x.id === id);
  if (e) { Object.assign(e, patch); writeJSON(LIB_KEY, lib); }
}
export async function deleteModel(id) {
  writeJSON(LIB_KEY, readJSON(LIB_KEY).filter((x) => x.id !== id));
  writeJSON(PRINT_KEY, readJSON(PRINT_KEY).map((p) => (p.libId === id ? { ...p, libId: null } : p)));
  await idb('readwrite', (s) => s.delete(id));
}

// ---- Baskı kayıtları ve kalibrasyon ----
export const listPrints = () => readJSON(PRINT_KEY).sort((a, b) => b.date - a.date);
export function addPrint(rec) {
  const all = readJSON(PRINT_KEY);
  const r = { id: 'p' + Date.now().toString(36), date: Date.now(), ...rec };
  all.push(r);
  writeJSON(PRINT_KEY, all);
  return r;
}
export function deletePrint(id) { writeJSON(PRINT_KEY, readJSON(PRINT_KEY).filter((p) => p.id !== id)); }

const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };

/** Başarılı baskılardaki gerçek/tahmin oranlarının medyanı. Kayıt yoksa null. */
export function calibration() {
  const ok = listPrints().filter((p) => p.ok && p.estSec > 0 && p.realSec > 0);
  const okG = listPrints().filter((p) => p.ok && p.estGrams > 0 && p.realGrams > 0);
  return {
    time: median(ok.map((p) => p.realSec / p.estSec)),
    grams: median(okG.map((p) => p.realGrams / p.estGrams)),
    nTime: ok.length,
    nGrams: okG.length,
  };
}

export async function requestPersist() {
  try { await navigator.storage?.persist?.(); } catch { /* yok say */ }
}
