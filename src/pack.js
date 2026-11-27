/**
 * MaxRects (en kısa kenar uyumu) ile dikdörtgenleri plakalara yerleştirir.
 * items: [{ w, d }] (mm; aralarındaki boşluk için gap eklenerek yerleştirilir)
 * W, H: plaka kullanılabilir alanı. rotate: 90° döndürmeye izin ver.
 * Dönüş: [{ plate, x, y, rot, oversize }] (items ile aynı sırada; x,y plaka içindeki sol alt köşe)
 * Büyükten küçüğe sıralanır; her öğe ilk sığdığı plakaya konur, sığmazsa yeni plaka açılır.
 */
export function packRects(items, W, H, { gap = 6, rotate = true } = {}) {
  const order = items.map((it, i) => ({ ...it, i })).sort((a, b) => b.w * b.d - a.w * a.d || Math.max(b.w, b.d) - Math.max(a.w, a.d));
  const AW = W + gap, AH = H + gap; // boşluğu öğeye ekleyip alanı da o kadar genişletmek kenar boşluğunu sıfırlar
  const bins = [];
  const out = new Array(items.length);
  const fresh = () => ({ free: [{ x: 0, y: 0, w: AW, h: AH }] });

  const findSpot = (bin, w, d) => {
    let best = null;
    for (const f of bin.free) {
      for (const rot of rotate ? [false, true] : [false]) {
        const iw = (rot ? d : w) + gap, id = (rot ? w : d) + gap;
        if (iw > f.w + 1e-9 || id > f.h + 1e-9) continue;
        const short = Math.min(f.w - iw, f.h - id), long = Math.max(f.w - iw, f.h - id);
        if (!best || short < best.short || (short === best.short && long < best.long)) best = { x: f.x, y: f.y, iw, id, rot, short, long };
      }
    }
    return best;
  };
  const place = (bin, s) => {
    const next = [];
    for (const f of bin.free) {
      if (s.x >= f.x + f.w || s.x + s.iw <= f.x || s.y >= f.y + f.h || s.y + s.id <= f.y) { next.push(f); continue; }
      if (s.x > f.x) next.push({ x: f.x, y: f.y, w: s.x - f.x, h: f.h });
      if (s.x + s.iw < f.x + f.w) next.push({ x: s.x + s.iw, y: f.y, w: f.x + f.w - s.x - s.iw, h: f.h });
      if (s.y > f.y) next.push({ x: f.x, y: f.y, w: f.w, h: s.y - f.y });
      if (s.y + s.id < f.y + f.h) next.push({ x: f.x, y: s.y + s.id, w: f.w, h: f.y + f.h - s.y - s.id });
    }
    // aynı olanları tek say, başka bir boş dikdörtgenin içinde kalanları ele
    const seen = new Set();
    const uniq = next.filter((f) => {
      const k = `${f.x.toFixed(5)},${f.y.toFixed(5)},${f.w.toFixed(5)},${f.h.toFixed(5)}`;
      if (f.w < 1e-9 || f.h < 1e-9 || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const inside = (a, b) => a.x >= b.x - 1e-9 && a.y >= b.y - 1e-9 && a.x + a.w <= b.x + b.w + 1e-9 && a.y + a.h <= b.y + b.h + 1e-9;
    bin.free = uniq.filter((a, ia) => !uniq.some((b, ib) => ib !== ia && inside(a, b)));
  };

  for (const it of order) {
    let placed = false;
    for (let k = 0; k < bins.length && !placed; k++) {
      const s = findSpot(bins[k], it.w, it.d);
      if (s) { place(bins[k], s); out[it.i] = { plate: k, x: s.x, y: s.y, rot: s.rot, oversize: false }; placed = true; }
    }
    if (placed) continue;
    const bin = fresh();
    const s = findSpot(bin, it.w, it.d);
    bins.push(bin);
    if (s) { place(bin, s); out[it.i] = { plate: bins.length - 1, x: s.x, y: s.y, rot: s.rot, oversize: false }; }
    else { bin.free = []; out[it.i] = { plate: bins.length - 1, x: 0, y: 0, rot: false, oversize: true }; } // tabladan büyük: kendi plakasında, başkası eklenmez
  }
  return out;
}
