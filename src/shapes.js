import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { normalizeGeometry } from './loaders.js';

/** Temel şekiller (Z-yukarı). Ölçüler mm. */
export function makePrimitive(kind, size) {
  let g;
  if (kind === 'box') g = new THREE.BoxGeometry(size, size, size);
  else if (kind === 'cylinder') g = new THREE.CylinderGeometry(size / 2, size / 2, size, 64).rotateX(Math.PI / 2);
  else if (kind === 'sphere') g = new THREE.SphereGeometry(size / 2, 48, 32).rotateX(Math.PI / 2);
  else if (kind === 'cone') g = new THREE.CylinderGeometry(0, size / 2, size, 64).rotateX(Math.PI / 2);
  else throw new Error('Bilinmeyen şekil: ' + kind);
  return normalizeGeometry(g);
}

export const FONTS = {
  bold: { label: 'Kalın', css: '900 {px}px "Arial Black", Impact, Arial, sans-serif' },
  normal: { label: 'Normal', css: '{px}px Arial, "Segoe UI", sans-serif' },
  serif: { label: 'Serif', css: 'bold {px}px Georgia, "Times New Roman", serif' },
  mono: { label: 'Daktilo', css: 'bold {px}px "Courier New", monospace' },
  script: { label: 'El yazısı', css: 'italic {px}px "Segoe Script", "Brush Script MT", cursive' },
};

const PPM = 8; // piksel / mm (kenarlar 0,125 mm'lik basamaklarla çıkar)

/** İkili görüntünün sınır çizgilerini kapalı döngülere çevirir. Dönen noktalar [x,y] piksel köşeleri (y aşağı). */
export function traceLoops(filled, W, H) {
  const px = (x, y) => x >= 0 && y >= 0 && x < W && y < H && filled[y * W + x];
  const edges = []; // {x0,y0,x1,y1,used}
  const out = new Map(); // başlangıç köşesi → kenar indeksleri
  const addEdge = (x0, y0, x1, y1) => {
    const k = y0 * (W + 1) + x0;
    const i = edges.length;
    edges.push({ x0, y0, x1, y1, used: false });
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(i);
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!px(x, y)) continue;
    if (!px(x, y - 1)) addEdge(x, y, x + 1, y);
    if (!px(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
    if (!px(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
    if (!px(x - 1, y)) addEdge(x, y + 1, x, y);
  }
  const loops = [];
  for (let s = 0; s < edges.length; s++) {
    if (edges[s].used) continue;
    const pts = [];
    let e = edges[s];
    for (;;) {
      e.used = true;
      pts.push([e.x0, e.y0]);
      const cand = (out.get(e.y1 * (W + 1) + e.x1) || []).filter((i) => !edges[i].used);
      if (!cand.length) break;
      // Düğüm noktasında sağa dön > düz git > sola dön (aynı lekede kal, birbirine değen lekeleri karıştırma)
      const dx = e.x1 - e.x0, dy = e.y1 - e.y0;
      let best = cand[0], bestScore = -9;
      for (const i of cand) {
        const c = edges[i];
        const cx = c.x1 - c.x0, cy = c.y1 - c.y0;
        const cross = dx * cy - dy * cx; // y aşağı: pozitif = sağa dönüş
        const score = cross > 0 ? 2 : cross === 0 ? 1 : 0;
        if (score > bestScore) { bestScore = score; best = i; }
      }
      e = edges[best];
      if (e === edges[s]) break;
    }
    if (pts.length >= 4) loops.push(pts);
  }
  // Doğrusal ara köşeleri sil
  return loops.map((pts) => {
    const n = pts.length;
    const keep = [];
    for (let i = 0; i < n; i++) {
      const a = pts[(i + n - 1) % n], b = pts[i], c = pts[(i + 1) % n];
      if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) !== 0) keep.push(b);
    }
    return keep;
  });
}

const area = (pts) => { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p.x * q.y - q.x * p.y; } return a / 2; };
function inside(pt, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

/**
 * Düz (XY, kalınlık +Z) bir geometriyi dünyada bir yüzeye oturtur: Z ekseni yüzey normali olur,
 * yazının "yukarısı" dünya yukarısının yüzeye izdüşümü olur (yatay yüzeylerde +Y).
 * XY'de ortalanır; zShift, Z boyunca ek kaydırmadır (yüzeyden içeri/dışarı).
 */
export function orientToSurface(g, point, normal, zShift = 0) {
  const out = g.clone();
  out.computeBoundingBox();
  const c = out.boundingBox.getCenter(new THREE.Vector3());
  out.translate(-c.x, -c.y, zShift);
  const n = normal.clone().normalize();
  const worldUp = Math.abs(n.z) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const x = new THREE.Vector3().crossVectors(worldUp, n).normalize();
  const y = new THREE.Vector3().crossVectors(n, x).normalize();
  const m = new THREE.Matrix4().makeBasis(x, y, n).setPosition(point);
  const hx = (out.boundingBox.max.x - out.boundingBox.min.x) / 2, hy = (out.boundingBox.max.y - out.boundingBox.min.y) / 2;
  out.userData.surface = { matrix: m.clone(), hx, hy, normal: n }; // yüzeye oturma denetimi için
  out.applyMatrix4(m);
  out.computeVertexNormals();
  out.computeBoundingBox();
  return out;
}

/**
 * Yazıyı kabartma geometrisine çevirir (XY düzleminde, Z yönünde kalınlık).
 * opts: { text, font, heightMM (büyük harf yüksekliği), thickness, base (altlık), margin, baseThick }
 */
export function makeText({ text, font = 'bold', heightMM = 10, thickness = 1.6, base = false, margin = 3, baseThick = 1.6 }) {
  const t = (text || '').trim();
  if (!t) throw new Error('Yazı boş');
  const fontPx = Math.round((heightMM * PPM) / 0.72);
  const css = FONTS[font].css.replace('{px}', fontPx);
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.font = css;
  const w = Math.ceil(ctx.measureText(t).width) + 8;
  const h = Math.ceil(fontPx * 1.5);
  c.width = Math.min(w, 8000); c.height = h;
  ctx.font = css;
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(t, 4, Math.round(fontPx * 1.05));
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  const filled = new Uint8Array(c.width * c.height);
  for (let i = 0; i < filled.length; i++) filled[i] = data[i * 4 + 3] > 127 ? 1 : 0;

  const loops = traceLoops(filled, c.width, c.height).map((pts) => pts.map(([x, y]) => new THREE.Vector2(x / PPM, (c.height - y) / PPM)));
  if (!loops.length) throw new Error('Bu yazı için şekil çıkmadı (yazı tipi bulunamadı olabilir)');
  // Y ekseni çevrildiği için dış konturlar negatif alanlı (saat yönü), delikler pozitif çıkar
  const outers = loops.filter((l) => area(l) < 0).map((l) => ({ pts: l, area: -area(l), holes: [] }));
  for (const l of loops.filter((q) => area(q) > 0)) {
    const host = outers.filter((o) => inside(l[0], o.pts)).sort((a, b) => a.area - b.area)[0];
    if (host) host.holes.push(l);
  }
  const shapes = outers.map((o) => {
    const s = new THREE.Shape(o.pts);
    o.holes.forEach((hl) => s.holes.push(new THREE.Path(hl)));
    return s;
  });
  let g = normalizeGeometry(new THREE.ExtrudeGeometry(shapes, { depth: thickness, bevelEnabled: false, curveSegments: 1 }));
  g.computeBoundingBox();
  const bb = g.boundingBox;
  g.translate(-bb.min.x, -bb.min.y, 0);
  g.computeBoundingBox();
  if (base) {
    const bw = bb.max.x - bb.min.x + margin * 2, bh = bb.max.y - bb.min.y + margin * 2;
    const plate = normalizeGeometry(new THREE.BoxGeometry(bw, bh, baseThick));
    plate.translate(bw / 2 - margin, bh / 2 - margin, baseThick / 2);
    g.translate(0, 0, baseThick);
    g = normalizeGeometry(mergeGeometries([plate, g], false));
  }
  g.computeBoundingBox();
  return g;
}
