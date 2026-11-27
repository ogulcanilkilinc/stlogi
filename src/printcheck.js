import * as THREE from 'three';

const geomCache = new WeakMap(); // geometri → { openEdges, nonManifold } (dönüşümden bağımsız)

/** Açık kenar (delik) ve 2'den fazla üçgenin paylaştığı kenar (kapalı olmayan model) sayısı. */
function topology(geom) {
  const cached = geomCache.get(geom);
  if (cached) return cached;
  const p = geom.attributes.position.array;
  const vid = new Map();
  const ids = new Uint32Array(p.length / 3);
  const q = 1e4;
  for (let i = 0; i < ids.length; i++) {
    const k = `${Math.round(p[i * 3] * q)},${Math.round(p[i * 3 + 1] * q)},${Math.round(p[i * 3 + 2] * q)}`;
    let v = vid.get(k);
    if (v === undefined) { v = vid.size; vid.set(k, v); }
    ids[i] = v;
  }
  const edges = new Map();
  const dirEdges = []; // [a, b, indeks] yönlü kenarlar
  const add = (a, b) => {
    if (a === b) return;
    const k = a < b ? a * 4294967296 + b : b * 4294967296 + a;
    edges.set(k, (edges.get(k) || 0) + 1);
    dirEdges.push(a, b);
  };
  for (let i = 0; i < ids.length; i += 3) {
    // Boolean işlemleri alanı sıfır olan sliver üçgenler bırakabilir; dilimleyiciler bunları atar, kenar sayımına katma
    const j = i * 3;
    const ux = p[j + 3] - p[j], uy = p[j + 4] - p[j + 1], uz = p[j + 5] - p[j + 2];
    const vx = p[j + 6] - p[j], vy = p[j + 7] - p[j + 1], vz = p[j + 8] - p[j + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * cx + cy * cy + cz * cz < 1e-12) continue; // alan < 5e-7 mm²
    add(ids[i], ids[i + 1]); add(ids[i + 1], ids[i + 2]); add(ids[i + 2], ids[i]);
  }
  let multi = 0;
  for (const n of edges.values()) if (n > 2) multi++;

  // Eşleşmeyen (tek üçgene ait) yönlü kenarlar
  let boundary = [];
  for (let i = 0; i < dirEdges.length; i += 2) {
    const a = dirEdges[i], b = dirEdges[i + 1];
    if (edges.get(a < b ? a * 4294967296 + b : b * 4294967296 + a) === 1) boundary.push([a, b]);
  }
  let open = boundary.length;
  // Boolean işlemlerinin (kesme, delik, yazı) çıktısında uzun bir kenar, karşı tarafta iki kısa kenara bölünmüş olabilir
  // ("T-birleşimi"). Bu geometrik olarak kapalıdır; kenarı üzerindeki köşelerden bölüp tekrar eşleştirerek ayıkla.
  if (open > 0 && open <= 20000) {
    const coords = new Map(); // köşe no → [x,y,z]
    for (let i = 0; i < ids.length; i++) if (!coords.has(ids[i])) coords.set(ids[i], [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]);
    const bverts = [...new Set(boundary.flat())];
    const res = new Map(); // "u>v" → sayı
    const put = (u, v) => res.set(`${u}>${v}`, (res.get(`${u}>${v}`) || 0) + 1);
    const EPS = 2e-3;
    for (const [a, b] of boundary) {
      const A = coords.get(a), B = coords.get(b);
      const d = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
      const L2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
      const on = [];
      if (L2 > 1e-12) {
        for (const c of bverts) {
          if (c === a || c === b) continue;
          const C = coords.get(c);
          const t = ((C[0] - A[0]) * d[0] + (C[1] - A[1]) * d[1] + (C[2] - A[2]) * d[2]) / L2;
          if (t <= 1e-6 || t >= 1 - 1e-6) continue;
          const dx = A[0] + d[0] * t - C[0], dy = A[1] + d[1] * t - C[1], dz = A[2] + d[2] * t - C[2];
          if (dx * dx + dy * dy + dz * dz <= EPS * EPS) on.push([t, c]);
        }
      }
      on.sort((x, y) => x[0] - y[0]);
      let prev = a;
      for (const [, c] of on) { put(prev, c); prev = c; }
      put(prev, b);
    }
    let unmatched = 0;
    for (const [k, n] of res) {
      const [u, v] = k.split('>');
      const back = res.get(`${v}>${u}`) || 0;
      if (n > back) unmatched += n - back;
    }
    open = unmatched;
  }
  const r = { openEdges: open, nonManifold: multi };
  geomCache.set(geom, r);
  return r;
}

/**
 * Bir nesne için baskı öncesi kontroller (dünya koordinatlarında).
 * Dönüş: { openEdges, nonManifold, contact (mm²), height, footprint, thinFrac, thinMin, sampled }
 */
export function checkMesh(mesh) {
  mesh.updateMatrixWorld(true);
  const geom = mesh.geometry;
  const p = geom.attributes.position.array;
  const m = mesh.matrixWorld;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const n = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  const nTri = p.length / 9;
  const tops = topology(geom);

  // Tabla teması: z ≈ 0'da yatay, aşağı bakan üçgenlerin alanı
  let contact = 0;
  const box = new THREE.Box3().setFromObject(mesh, true);
  const flip = m.determinant() < 0 ? -1 : 1;
  for (let i = 0; i < p.length; i += 9) {
    a.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(m);
    b.set(p[i + 3], p[i + 4], p[i + 5]).applyMatrix4(m);
    c.set(p[i + 6], p[i + 7], p[i + 8]).applyMatrix4(m);
    if (a.z > 0.08 || b.z > 0.08 || c.z > 0.08) continue;
    e1.subVectors(b, a); e2.subVectors(c, a);
    n.crossVectors(e1, e2);
    const area = n.length() / 2;
    if (area > 0 && (n.z * flip) / (2 * area) < -0.95) contact += area;
  }

  // İnce duvar: örneklenen üçgenlerin merkezinden içeri (−normal) ışın at, karşı yüzeye mesafe
  const MAXS = 2500;
  const stride = Math.max(1, Math.floor(nTri / MAXS));
  const ray = new THREE.Raycaster();
  ray.firstHitOnly = true;
  const side = mesh.material.side;
  mesh.material.side = THREE.DoubleSide;
  const o = new THREE.Vector3(), d = new THREE.Vector3(), hn = new THREE.Vector3();
  const nmat = new THREE.Matrix3().getNormalMatrix(m);
  let sampled = 0, thin = 0, areaAll = 0, areaThin = 0, thinMin = Infinity; // alan ağırlıklı: sivri uçlardaki minik üçgenler sonucu bozmasın
  for (let t = 0; t < nTri; t += stride) {
    const i = t * 9;
    a.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(m);
    b.set(p[i + 3], p[i + 4], p[i + 5]).applyMatrix4(m);
    c.set(p[i + 6], p[i + 7], p[i + 8]).applyMatrix4(m);
    e1.subVectors(b, a); e2.subVectors(c, a);
    n.crossVectors(e1, e2);
    const len = n.length();
    if (len < 1e-9) continue;
    n.multiplyScalar((flip) / len);
    o.copy(a).add(b).add(c).multiplyScalar(1 / 3).addScaledVector(n, -0.02);
    d.copy(n).negate();
    ray.set(o, d);
    ray.near = 0; ray.far = 2;
    const h = ray.intersectObject(mesh, false)[0];
    sampled++; areaAll += len / 2;
    if (h && h.distance < 0.8) {
      // Karşı yüzey yaklaşık paralelse gerçek ince duvardır; sivri uç / kama (yüzeyler birbirine açılı) sayılmaz
      hn.copy(h.face.normal).applyMatrix3(nmat).normalize().multiplyScalar(flip);
      if (hn.dot(n) < -0.7) {
        thin++; areaThin += len / 2;
        thinMin = Math.min(thinMin, h.distance + 0.02);
      }
    }
  }
  mesh.material.side = side;

  const size = box.getSize(new THREE.Vector3());
  return {
    ...tops,
    csg: !!geom.userData?.csg, // kes / delik / yazı gibi Boolean işlemlerinden çıktı
    contact,
    height: size.z,
    footprint: size.x * size.y,
    minSide: Math.min(size.x, size.y),
    thinFrac: areaAll ? areaThin / areaAll : 0,
    thinMin: isFinite(thinMin) ? thinMin : null,
    sampled,
  };
}

/** Kontrol sonuçlarını kullanıcıya gösterilecek uyarılara çevirir. level: 'bad' | 'warn' | 'ok' */
export function describeChecks(name, r) {
  const out = [];
  if ((r.openEdges || r.nonManifold) && r.csg) {
    // Boolean işlemleri hacmi doğru bırakır ama yüzeyde sliver / T-birleşimi gibi küçük kusurlar üretebilir
    out.push({
      level: 'warn',
      text: `${name}: kesme / delik / yazı işleminden sonra yüzeyde küçük kusurlar var (${r.openEdges} açık, ${r.nonManifold} çakışan kenar). Hacim doğru; genelde sorun çıkarmaz, Bambu Studio dilimlerken onarım uyarısı verebilir.`,
    });
  } else if (r.openEdges || r.nonManifold) {
    out.push({
      level: 'bad',
      text: `${name}: model kapalı değil (${r.openEdges} açık kenar${r.nonManifold ? `, ${r.nonManifold} çakışan kenar` : ''}). Dilimleyici onarım isteyebilir; Bambu Studio'da "Onar" çıkabilir.`,
    });
  }
  if (r.contact < 1) {
    out.push({ level: 'warn', text: `${name}: tablaya değen düz yüzey yok. Tutunması zor; yatırmayı (Yüzeye yatır) ya da destek / brim kullanmayı düşünün.` });
  } else {
    const slender = r.height / Math.sqrt(r.contact);
    if (r.contact < 80 && r.height > 15) {
      out.push({ level: 'warn', text: `${name}: tablaya değen alan küçük (${(r.contact / 100).toFixed(2)} cm²). Baskı sırasında kalkabilir; brim (kenar şeridi) önerilir.` });
    } else if (slender > 6 && r.height > 30) {
      out.push({ level: 'warn', text: `${name}: uzun ve ince (yükseklik ${r.height.toFixed(0)} mm, taban ${(r.contact / 100).toFixed(1)} cm²). Devrilme / titreme riski; brim ya da daha geniş taban önerilir.` });
    }
  }
  if (r.thinFrac > 0.02 && r.thinMin !== null) {
    const pct = (r.thinFrac * 100).toFixed(0);
    if (r.thinMin < 0.4) {
      out.push({ level: 'bad', text: `${name}: yüzeyin ~%${pct}'i çok ince (en ince ≈ ${r.thinMin.toFixed(2)} mm). 0,4 mm nozulla bu kısımlar basılamaz; kalınlaştırın.` });
    } else {
      out.push({ level: 'warn', text: `${name}: yüzeyin ~%${pct}'i ince (en ince ≈ ${r.thinMin.toFixed(2)} mm). 0,8 mm altı duvarlar tek hatla basılır; kırılgan ya da eksik çıkabilir.` });
    }
  }
  return out;
}
