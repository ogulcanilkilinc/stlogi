import * as THREE from 'three';

// A1 Combo = AMS lite: 4 filament yuvası. Kırmızı/yeşil tonlardan kaçınıldı (sarkma ve destek renkleri).
export const DEFAULT_SLOTS = ['#f2a33a', '#3d9be9', '#e8e8e8', '#555a63'];

export function loadSlots() {
  try {
    const s = JSON.parse(localStorage.getItem('stlogi.ams'));
    if (Array.isArray(s) && s.length === 4) return s;
  } catch { /* yok say */ }
  return DEFAULT_SLOTS.slice();
}
export function saveSlots(slots) {
  try { localStorage.setItem('stlogi.ams', JSON.stringify(slots)); } catch { /* yok say */ }
}

const lum = (c) => { const k = new THREE.Color(c); return 0.2126 * k.r + 0.7152 * k.g + 0.0722 * k.b; };

/**
 * Bambu'nun varsayılan temizleme (flush) hacmi ≈ 280 mm³. Koyudan açığa geçiş daha çok, açıktan koyuya daha az filament ister;
 * buna göre 0.6×–1.9× arasında kaba bir çarpan uygulanır. Gerçek değer Bambu Studio'da renk çiftine göre ayarlanır.
 */
export function flushVolume(fromColor, toColor) {
  const d = lum(toColor) - lum(fromColor);
  return 280 * Math.min(1.9, Math.max(0.6, 1 + d * 1.2));
}

/**
 * items: [{ slot, volume (mm³, nesnenin hacmi), zMin, zMax }]
 * Dönüş: slot başına gram, renk değişim sayısı, temizleme atığı (g), kullanılan slot sayısı.
 */
export function amsBreakdown(items, slots, { layerH, modelGrams, density }) {
  const totalVol = items.reduce((a, b) => a + b.volume, 0) || 1;
  const perSlot = [0, 0, 0, 0];
  for (const it of items) perSlot[it.slot] += (modelGrams * it.volume) / totalVol;
  const used = perSlot.map((g, i) => (items.some((it) => it.slot === i) ? i : -1)).filter((i) => i >= 0);
  if (used.length < 2) return { perSlot, changes: 0, wasteGrams: 0, used };

  let H = 0;
  for (const it of items) H = Math.max(H, it.zMax);
  const layers = Math.max(1, Math.ceil(H / layerH));
  // Her katmanda hangi slotlar basılıyor?
  const present = Array.from({ length: layers }, () => new Set());
  for (const it of items) {
    const a = Math.max(0, Math.floor(it.zMin / layerH + 1e-6));
    const b = Math.min(layers - 1, Math.ceil(it.zMax / layerH - 1e-6) - 1);
    for (let l = a; l <= b; l++) present[l].add(it.slot);
  }
  // Çift yönlü geçişlerin ortalaması (Bambu sırayı değiştirerek değişimi azaltır)
  const avgFlush = new Map();
  const pairFlush = (s) => {
    const key = [...s].sort().join('');
    if (avgFlush.has(key)) return avgFlush.get(key);
    const arr = [...s];
    let sum = 0, n = 0;
    for (const a of arr) for (const b of arr) if (a !== b) { sum += flushVolume(slots[a], slots[b]); n++; }
    const v = n ? sum / n : 0;
    avgFlush.set(key, v);
    return v;
  };
  let changes = 0, flushMm3 = 0;
  for (const s of present) {
    if (s.size < 2) continue;
    changes += s.size - 1;
    flushMm3 += (s.size - 1) * pairFlush(s);
  }
  return { perSlot, changes, wasteGrams: (flushMm3 / 1000) * density, used };
}
