import * as THREE from 'three';

const _v = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _n = new THREE.Vector3();
const _m3 = new THREE.Matrix3();

/** Mesh'in geometrisini dünya koordinatlarına taşınmış kopya olarak döner (aynalamada üçgen yönü düzeltilir). */
export function worldGeometry(mesh) {
  mesh.updateMatrixWorld(true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', mesh.geometry.attributes.position.clone());
  g.applyMatrix4(mesh.matrixWorld);
  if (mesh.matrixWorld.determinant() < 0) {
    const p = g.attributes.position.array;
    for (let i = 0; i < p.length; i += 9) {
      for (let k = 0; k < 3; k++) {
        const t = p[i + 3 + k]; p[i + 3 + k] = p[i + 6 + k]; p[i + 6 + k] = t;
      }
    }
  }
  g.computeVertexNormals();
  g.computeBoundingBox();
  return g;
}

/** Hacim (mm³), yüzey alanı (mm²), üçgen sayısı. Dünya ölçeğiyle hesaplanır. */
export function meshStats(mesh) {
  mesh.updateMatrixWorld(true);
  const p = mesh.geometry.attributes.position.array;
  const m = mesh.matrixWorld;
  let vol = 0, area = 0;
  for (let i = 0; i < p.length; i += 9) {
    _a.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(m);
    _b.set(p[i + 3], p[i + 4], p[i + 5]).applyMatrix4(m);
    _c.set(p[i + 6], p[i + 7], p[i + 8]).applyMatrix4(m);
    vol += _a.dot(_v.copy(_b).cross(_c)) / 6;
    _b.sub(_a); _c.sub(_a);
    area += _n.copy(_b).cross(_c).length() / 2;
  }
  return { volume: Math.abs(vol), area, tris: p.length / 9 };
}

/**
 * Sarkan (destek isteyen) yüzeyleri vertex rengiyle boyar.
 * thresholdDeg: yataydan açı; bundan düz olan aşağı bakan yüzeyler kırmızı.
 * Dönen değer: destek gerektiren yüzey alanı (mm²).
 */
export function paintOverhangs(mesh, thresholdDeg, baseColor) {
  mesh.updateMatrixWorld(true);
  const geom = mesh.geometry;
  const p = geom.attributes.position.array;
  let col = geom.attributes.color;
  if (!col || col.count !== geom.attributes.position.count) {
    col = new THREE.BufferAttribute(new Float32Array(p.length), 3);
    geom.setAttribute('color', col);
  }
  const c = col.array;
  const m = mesh.matrixWorld;
  _m3.getNormalMatrix(m);
  const box = new THREE.Box3().setFromObject(mesh);
  const bedZ = box.min.z;
  const cosLimit = Math.cos(THREE.MathUtils.degToRad(thresholdDeg)); // -nz > cosLimit -> sarkma
  const base = new THREE.Color(baseColor);
  const red = new THREE.Color(0xe5484d);
  let ovArea = 0;
  const overTri = new Uint8Array(p.length / 9);
  for (let i = 0; i < p.length; i += 9) {
    _a.set(p[i], p[i + 1], p[i + 2]);
    _b.set(p[i + 3], p[i + 4], p[i + 5]);
    _c.set(p[i + 6], p[i + 7], p[i + 8]);
    _n.copy(_b).sub(_a).cross(_v.copy(_c).sub(_a));
    const localArea = _n.length();
    _n.applyMatrix3(_m3).normalize();
    // en düşük z (tabla teması kontrolü)
    const z0 = _a.applyMatrix4(m).z, z1 = _b.applyMatrix4(m).z, z2 = _c.applyMatrix4(m).z;
    const onBed = Math.max(z0, z1, z2) - bedZ < 0.15;
    const over = !onBed && -_n.z > cosLimit;
    overTri[i / 9] = over ? 1 : 0;
    const cc = over ? red : base;
    for (let k = 0; k < 3; k++) {
      c[i + k * 3] = cc.r; c[i + k * 3 + 1] = cc.g; c[i + k * 3 + 2] = cc.b;
    }
    if (over && localArea > 0) {
      // dünya alanı
      _a.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(m);
      _b.set(p[i + 3], p[i + 4], p[i + 5]).applyMatrix4(m).sub(_a);
      _c.set(p[i + 6], p[i + 7], p[i + 8]).applyMatrix4(m).sub(_a);
      ovArea += _b.cross(_c).length() / 2;
    }
  }
  // Havada başlayan uçlar: çevresindeki yüzler dik olsa bile destek ister
  const isl = findIslands(mesh);
  const vid = isl.vid;
  const nearOver = new Uint8Array(isl.flags.length); // zaten kırmızı sarkma yüzeyine değen köşeler
  for (let t = 0; t < vid.length; t += 3) {
    if (overTri[t / 3]) { nearOver[vid[t]] = 1; nearOver[vid[t + 1]] = 1; nearOver[vid[t + 2]] = 1; }
  }
  let islands = 0;
  for (let u = 0; u < isl.flags.length; u++) if (isl.flags[u] && !nearOver[u]) islands++;
  for (let t = 0; t < vid.length; t += 3) {
    if (!(isl.flags[vid[t]] | isl.flags[vid[t + 1]] | isl.flags[vid[t + 2]])) continue;
    for (let k = 0; k < 3; k++) {
      c[(t + k) * 3] = red.r; c[(t + k) * 3 + 1] = red.g; c[(t + k) * 3 + 2] = red.b;
    }
  }
  mesh.userData.islands = islands;
  col.needsUpdate = true;
  return ovArea;
}

/**
 * Aynı konumdaki köşeleri tek kimlikte toplar (komşuluk için). Geometri başına bir kez hesaplanır.
 * Hızlı olsun diye tamsayı hash tablosu kullanılır.
 */
function vertexTopology(geom) {
  const p = geom.attributes.position.array;
  const nV = p.length / 3;
  if (geom.userData.topo && geom.userData.topo.vid.length === nV) return geom.userData.topo;
  let cap = 1;
  while (cap < nV * 2) cap <<= 1;
  const table = new Int32Array(cap).fill(-1);
  const rep = new Int32Array(nV);
  const vid = new Int32Array(nV);
  const q = (v) => Math.round(v * 1e4);
  let n = 0;
  for (let i = 0; i < nV; i++) {
    const x = q(p[i * 3]), y = q(p[i * 3 + 1]), z = q(p[i * 3 + 2]);
    let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & (cap - 1);
    for (;;) {
      const id = table[h];
      if (id === -1) { table[h] = n; rep[n] = i; vid[i] = n++; break; }
      const r = rep[id] * 3;
      if (q(p[r]) === x && q(p[r + 1]) === y && q(p[r + 2]) === z) { vid[i] = id; break; }
      h = (h + 1) & (cap - 1);
    }
  }
  geom.userData.topo = { vid, rep: rep.slice(0, n), n };
  return geom.userData.topo;
}

/**
 * Havada başlayan uçları bulur: tabladan yukarıda, tüm komşuları kendisinden yüksek
 * ve çevresi aşağı bakan köşeler (örn. aşağı sarkan sivri uç). Dünya koordinatında döner.
 */
export function findIslands(mesh) {
  mesh.updateMatrixWorld(true);
  const topo = vertexTopology(mesh.geometry);
  const p = mesh.geometry.attributes.position.array;
  const e = mesh.matrixWorld.elements;
  const flip = mesh.matrixWorld.determinant() < 0 ? -1 : 1;
  const { n, rep, vid } = topo;
  const wx = new Float32Array(n), wy = new Float32Array(n), wz = new Float32Array(n);
  let minZ = Infinity;
  for (let u = 0; u < n; u++) {
    const i = rep[u] * 3, x = p[i], y = p[i + 1], z = p[i + 2];
    wx[u] = e[0] * x + e[4] * y + e[8] * z + e[12];
    wy[u] = e[1] * x + e[5] * y + e[9] * z + e[13];
    wz[u] = e[2] * x + e[6] * y + e[10] * z + e[14];
    if (wz[u] < minZ) minZ = wz[u];
  }
  const nbMin = new Float32Array(n).fill(Infinity);
  const nzSum = new Float32Array(n);
  for (let t = 0; t < vid.length; t += 3) {
    const a = vid[t], b = vid[t + 1], c = vid[t + 2];
    if (wz[b] < nbMin[a]) nbMin[a] = wz[b]; if (wz[c] < nbMin[a]) nbMin[a] = wz[c];
    if (wz[a] < nbMin[b]) nbMin[b] = wz[a]; if (wz[c] < nbMin[b]) nbMin[b] = wz[c];
    if (wz[a] < nbMin[c]) nbMin[c] = wz[a]; if (wz[b] < nbMin[c]) nbMin[c] = wz[b];
    const nz = ((wx[b] - wx[a]) * (wy[c] - wy[a]) - (wy[b] - wy[a]) * (wx[c] - wx[a])) * flip;
    nzSum[a] += nz; nzSum[b] += nz; nzSum[c] += nz;
  }
  // Hiçbir komşusu kendisinden alçak olmayan köşe = en alt nokta (sivri uç ya da aşağı sarkan kenar çizgisi)
  const flags = new Uint8Array(n);
  const strict = [], edge = [];
  for (let u = 0; u < n; u++) {
    if (wz[u] - minZ > 0.3 && nbMin[u] !== Infinity && nbMin[u] >= wz[u] - 0.001 && nzSum[u] < 0) {
      flags[u] = 1;
      (nbMin[u] > wz[u] + 0.02 ? strict : edge).push(new THREE.Vector3(wx[u], wy[u], wz[u]));
    }
  }
  return { points: strict.concat(edge), flags, vid };
}

/**
 * Yukarıdan aşağı ışın atarak destek sütunlarını hesaplar.
 * meshes: BVH'li meshler. Dönüş: { columns: [{x,y,top,bot}], step, volume }
 */
export function computeSupports(meshes, { thresholdDeg, type, bedOnly, paint }) {
  if (!meshes.length) return { columns: [], step: 2, volume: 0 };
  const box = new THREE.Box3();
  meshes.forEach((m) => box.expandByObject(m));
  const sx = box.max.x - box.min.x, sy = box.max.y - box.min.y;
  // ~6000 ışını aşmayacak adım
  const step = Math.max(1.5, Math.sqrt((sx * sy) / 6000));
  const ray = new THREE.Raycaster();
  ray.firstHitOnly = false;
  const down = new THREE.Vector3(0, 0, -1);
  const origin = new THREE.Vector3();
  const cosLimit = Math.cos(THREE.MathUtils.degToRad(thresholdDeg));
  const normalMats = new Map(meshes.map((m) => [m, new THREE.Matrix3().getNormalMatrix(m.matrixWorld)]));
  const columns = [];
  const nw = new THREE.Vector3();
  // Alt yüzeyler yukarıdan bakınca arka yüzdür; ışının onları da görmesi için geçici olarak çift taraflı yap
  const sides = meshes.map((m) => m.material.side);
  meshes.forEach((m) => (m.material.side = THREE.DoubleSide));

  // Bir ışının yüzeylere çarptığı noktaları yukarıdan aşağı sırayla döner (nz: dünya normalinin z'si)
  const castDown = (x, y, fromZ) => {
    origin.set(x, y, fromZ);
    ray.set(origin, down);
    const out = [];
    for (const h of ray.intersectObjects(meshes, false)) {
      nw.copy(h.face.normal).applyMatrix3(normalMats.get(h.object)).normalize();
      const prev = out[out.length - 1];
      // Aynı kenara çarpan iki üçgen tek sayılır; ama zıt yönlü (giriş/çıkış) iki yakın çarpma ayrı kalır
      if (prev && Math.abs(prev.z - h.point.z) < 0.02 && Math.sign(prev.nz) === Math.sign(nw.z)) continue;
      out.push({ z: h.point.z, nz: nw.z });
    }
    return out;
  };

  // 1) Sarkan yüzeyler: aşağı bakan yüzeyden çıkıp ilk YUKARI bakan yüzeye (ya da tablaya) iner
  for (let x = box.min.x + step / 2; x < box.max.x; x += step) {
    for (let y = box.min.y + step / 2; y < box.max.y; y += step) {
      const hits = castDown(x, y, box.max.z + 5);
      for (let i = 0; i < hits.length; i++) {
        const h = hits[i];
        if (h.nz >= 0 || -h.nz <= cosLimit || h.z < 0.3) continue;
        const below = hits[i + 1];
        if (below && below.nz <= 0) continue; // tutarsız yüzey sırası (bozuk model) — güvenli tarafta kal
        if (bedOnly && below) continue;
        const bot = below ? below.z : 0;
        if (h.z - bot < 0.4) continue;
        columns.push({ x, y, top: h.z, bot });
      }
    }
  }

  // 2) Havada başlayan uçlar
  const cellKey = (x, y) => `${Math.floor(x / step)},${Math.floor(y / step)}`;
  const byCell = new Map();
  for (const c of columns) {
    const k = cellKey(c.x, c.y);
    if (!byCell.has(k)) byCell.set(k, []);
    byCell.get(k).push(c);
  }
  let islandCount = 0;
  for (const m of meshes) {
    for (const p of findIslands(m).points) {
      if (islandCount >= 400) break;
      // yakında zaten bir sarkma desteği varsa ekleme
      const cx = Math.floor(p.x / step), cy = Math.floor(p.y / step);
      let near = false;
      for (let dx = -1; dx <= 1 && !near; dx++) for (let dy = -1; dy <= 1 && !near; dy++) {
        near = (byCell.get(`${cx + dx},${cy + dy}`) || []).some((c) => Math.abs(c.top - p.z) < 1.5);
      }
      if (near) continue;
      const hits = castDown(p.x, p.y, p.z - 0.05);
      const below = hits[0];
      if (below && below.nz <= 0) continue;
      if (bedOnly && below) continue;
      const bot = below ? below.z : 0;
      if (p.z - bot < 0.4) continue;
      const col = { x: p.x, y: p.y, top: p.z, bot, island: true };
      columns.push(col);
      const k = cellKey(p.x, p.y);
      if (!byCell.has(k)) byCell.set(k, []);
      byCell.get(k).push(col); // aynı kenar çizgisindeki komşu noktalar tekrar eklenmesin
      islandCount++;
    }
  }

  // 3) Elle boyama: "destek koy" bölgelerinin altına temas noktası ekle, "destek koyma" bölgelerindekileri sil
  const enf = paint?.enf || [], blk = paint?.blk || [];
  let enforced = 0, blocked = 0;
  for (const d of enf) {
    for (let x = d.x - d.r; x <= d.x + d.r; x += step) {
      for (let y = d.y - d.r; y <= d.y + d.r; y += step) {
        if (Math.hypot(x - d.x, y - d.y) > d.r) continue;
        const hits = castDown(x, y, d.z + d.r);
        // boyalı yüzey: noktaya yakın, aşağı bakan (altı hava olan) ilk yüzey
        const i = hits.findIndex((h) => h.nz < 0 && Math.hypot(x - d.x, y - d.y, h.z - d.z) <= d.r * 1.05);
        if (i < 0) continue;
        const h = hits[i], below = hits[i + 1];
        if (below && below.nz <= 0) continue;
        if (bedOnly && below) continue;
        const bot = below ? below.z : 0;
        if (h.z - bot < 0.4 || h.z < 0.3) continue;
        const k = cellKey(x, y);
        if ((byCell.get(k) || []).some((c) => Math.abs(c.top - h.z) < 1)) continue;
        const col = { x, y, top: h.z, bot, forced: true };
        columns.push(col);
        if (!byCell.has(k)) byCell.set(k, []);
        byCell.get(k).push(col);
        enforced++;
      }
    }
  }
  if (blk.length) {
    const kept = columns.filter((c) => !blk.some((d) => Math.hypot(c.x - d.x, c.y - d.y, c.top - d.z) <= d.r + step * 0.5));
    blocked = columns.length - kept.length;
    columns.length = 0;
    columns.push(...kept);
  }

  // ---- Çarpışma sorguları: ilk çarpmaya bakan ışınlar (DoubleSide açık) ----
  const hitRay = new THREE.Raycaster();
  hitRay.firstHitOnly = true;
  const _o = new THREE.Vector3(), _d = new THREE.Vector3();
  const castBlocked = (ox, oy, oz, ux, uy, uz, len) => {
    _o.set(ox, oy, oz); _d.set(ux, uy, uz);
    hitRay.set(_o, _d);
    hitRay.near = 0.05; hitRay.far = len;
    return hitRay.intersectObjects(meshes, false).length > 0;
  };
  /** (x,y,z) noktasının hemen altındaki yüzeyin yüksekliği (yoksa 0 = tabla). */
  const floorAt = (x, y, z) => {
    _o.set(x, y, z); _d.set(0, 0, -1);
    hitRay.set(_o, _d);
    hitRay.near = 0.05; hitRay.far = Infinity;
    const h = hitRay.intersectObjects(meshes, false)[0];
    return h ? Math.max(0, h.point.z) : 0;
  };
  /** Nokta katının içinde mi? Yukarı giden ışının çarptığı ilk yüzey yukarı bakıyorsa (içeriden kesiyorsa) içeridedir. */
  const insideAt = (x, y, z) => {
    _o.set(x, y, z); _d.set(0, 0, 1);
    hitRay.set(_o, _d);
    hitRay.near = 0.01; hitRay.far = Infinity;
    const h = hitRay.intersectObjects(meshes, false)[0];
    if (!h) return false;
    nw.copy(h.face.normal).applyMatrix3(normalMats.get(h.object)).normalize();
    return nw.z > 0;
  };
  /** a→b ekseninde r yarıçaplı silindir modele değmeden geçebilir mi? Eksen + yan ışınlarla ölçülür. */
  const segClear = (ax, ay, az, bx, by, bz, r) => {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.05) return true;
    const ux = dx / len, uy = dy / len, uz = dz / len;
    let px = uy, py = -ux;
    const pl = Math.hypot(px, py);
    if (pl < 1e-3) { px = 1; py = 0; } else { px /= pl; py /= pl; }
    // ikinci dik yön: u × p
    let qx = -uz * py, qy = uz * px, qz = ux * py - uy * px;
    const ql = Math.hypot(qx, qy, qz) || 1;
    qx /= ql; qy /= ql; qz /= ql;
    const rr = r + 0.15;
    if (castBlocked(ax, ay, az, ux, uy, uz, len)) return false;
    if (castBlocked(ax + px * rr, ay + py * rr, az, ux, uy, uz, len)) return false;
    if (castBlocked(ax - px * rr, ay - py * rr, az, ux, uy, uz, len)) return false;
    if (castBlocked(ax + qx * rr, ay + qy * rr, az + qz * rr, ux, uy, uz, len)) return false;
    if (castBlocked(ax - qx * rr, ay - qy * rr, az - qz * rr, ux, uy, uz, len)) return false;
    // Işınlar katının İÇİNDE başlayan yan noktalardan çarpma göremez (örn. dik bir duvara yapışık dal).
    // Dalın yan noktalarını, yüzeyden ayrıldığı yerde (0.7 mm ileride) içeride mi diye ayrıca denetle.
    const t = Math.min(0.7, len);
    const sx = ax + ux * t, sy = ay + uy * t, sz = az + uz * t;
    if (insideAt(sx + px * rr, sy + py * rr, sz) || insideAt(sx - px * rr, sy - py * rr, sz)) return false;
    if (insideAt(sx + qx * rr, sy + qy * rr, sz + qz * rr) || insideAt(sx - qx * rr, sy - qy * rr, sz - qz * rr)) return false;
    return true;
  };

  // Temas noktası aralığı: sarkma alanına göre 2.5–6 mm
  const overArea = columns.length * step * step;
  const tipSpacing = Math.min(6, Math.max(2.5, Math.sqrt(overArea / 700)));
  const segments = type === 'tree' ? treeSegments(columns, { segClear, floorAt, tipSpacing }) : [];
  meshes.forEach((m, i) => (m.material.side = sides[i]));

  const cell = step * step;
  let volume = 0;
  if (type === 'tree') {
    // Ağaç desteğin gövdesi içi boş/seyrek basılır: dolu silindir hacminin ~%55'i + her temas noktası için arayüz
    for (const s of segments) volume += Math.PI * s.r * s.r * s.a.distanceTo(s.b) * 0.55;
    volume += segments.tips * 2.7;
  } else {
    for (const c of columns) volume += (c.top - c.bot) * cell * 0.15 + cell * 0.4; // gövde + arayüz katmanları
  }
  return { columns, segments, step, volume, islandCount, enforced, blocked };
}

/**
 * Ağaç destek (yukarıdan aşağıya büyüyen): her temas noktası ince bir dal olarak başlar.
 * Her adımda (STEP mm aşağı) dallar en yakın komşusuna doğru en fazla MAX_ANGLE eğimle kayar,
 * yeterince yaklaşınca birleşir; birleşen gövdenin kalınlığı sqrt(dal sayısı) ile artar.
 * Her hareket, yarıçap payıyla modele çarpıyor mu diye ışınla denenir; çarpıyorsa yarım adım,
 * o da olmazsa düz iner. Alttaki yüzey (tabla ya da modelin üst yüzü) bulununca iner ve biter.
 */
function treeSegments(columns, { segClear, floorAt, tipSpacing }) {
  const STEP = 2.5, MAX_R = 3.2, R0 = 0.35, MAX_N = 40, MERGE_R = 20;
  const SLOPE = Math.tan(THREE.MathUtils.degToRad(40));
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const radiusOf = (n) => Math.min(MAX_R, R0 * Math.sqrt(n) + 0.05);
  const segs = [];
  const add = (ax, ay, az, bx, by, bz, r) => {
    if (Math.hypot(bx - ax, by - ay, bz - az) > 0.01) segs.push({ a: V(ax, ay, az), b: V(bx, by, bz), r });
  };

  // 1) Temas noktalarını seyrelt (havada başlayan uçlar öncelikli)
  const seen = new Set();
  const tips = [];
  for (const c of columns.slice().sort((p, q) => (q.island ? 1 : 0) - (p.island ? 1 : 0))) {
    const k = `${Math.round(c.x / tipSpacing)},${Math.round(c.y / tipSpacing)},${Math.round(c.top / 2)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    tips.push({ x: c.x, y: c.y, z: c.top - 0.2, n: 1, r: R0 + 0.05, floor: 0, done: false });
  }
  segs.tips = tips.length;
  if (!tips.length) return segs;
  tips.sort((p, q) => q.z - p.z);

  const finish = (nd, zEnd) => {
    add(nd.x, nd.y, nd.z, nd.x, nd.y, zEnd, nd.r);
    if (zEnd < 0.5) add(nd.x, nd.y, 0, nd.x, nd.y, 0.8, Math.min(4, nd.r * 1.5 + 0.4)); // tabla ayağı
    nd.done = true;
  };

  let level = tips[0].z, next = 0, active = [];
  for (let iter = 0; iter < 600 && (next < tips.length || active.length); iter++) {
    if (!active.length && next < tips.length) level = Math.max(level, tips[next].z);
    const T = Math.max(level - STEP, 0);
    while (next < tips.length && tips[next].z >= T) active.push(tips[next++]);

    // Komşuluk ızgarası (mevcut konumlar)
    const grid = new Map();
    const gk = (x, y) => `${Math.floor(x / MERGE_R)},${Math.floor(y / MERGE_R)}`;
    for (const nd of active) {
      nd.floor = floorAt(nd.x, nd.y, nd.z);
      const k = gk(nd.x, nd.y);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(nd);
    }
    const moves = new Map();
    for (const nd of active) {
      if (T <= nd.floor + 0.05) continue; // bu adımda inecek
      const cx = Math.floor(nd.x / MERGE_R), cy = Math.floor(nd.y / MERGE_R);
      let best = null, bd = Infinity;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const o of grid.get(`${cx + dx},${cy + dy}`) || []) {
          if (o === nd || nd.n + o.n > MAX_N || Math.abs(o.floor - nd.floor) > 1.5) continue;
          const d = Math.hypot(o.x - nd.x, o.y - nd.y);
          if (d < bd && d < MERGE_R) { bd = d; best = o; }
        }
      }
      if (best) moves.set(nd, { ux: (best.x - nd.x) / bd, uy: (best.y - nd.y) / bd, d: bd });
    }

    // 2) Hareket: komşuya doğru kay, çarpışma varsa yarım adım, o da olmazsa düz in
    for (const nd of active) {
      if (T <= nd.floor + 0.05) { finish(nd, nd.floor); continue; }
      const dz = nd.z - T;
      const mv = moves.get(nd);
      let nx = nd.x, ny = nd.y;
      if (mv && dz > 0.01) {
        const dist = Math.min(mv.d / 2, dz * SLOPE);
        for (const f of [1, 0.5]) {
          const tx = nd.x + mv.ux * dist * f, ty = nd.y + mv.uy * dist * f;
          if (segClear(nd.x, nd.y, nd.z, tx, ty, T, nd.r)) { nx = tx; ny = ty; break; }
        }
      }
      if (nx === nd.x && ny === nd.y && dz > 0.01 && !segClear(nd.x, nd.y, nd.z, nd.x, nd.y, T, nd.r)) {
        // Yarıçap payıyla düz iniş çarpıyor. Tek (ince) dal ise yarıçapını küçülterek dene;
        // sığmıyorsa o dal burada biter (parçanın içine girmektense kısa kalır).
        let fit = 0;
        if (nd.n === 1) for (const rr of [0.25, 0.12]) if (segClear(nd.x, nd.y, nd.z, nd.x, nd.y, T, rr)) { fit = rr; break; }
        if (!fit) { nd.done = true; continue; }
        nd.r = fit;
      }
      add(nd.x, nd.y, nd.z, nx, ny, T, nd.r);
      nd.x = nx; nd.y = ny; nd.z = T;
    }
    active = active.filter((nd) => !nd.done);

    // 3) Birleştirme: dokunacak kadar yakın dallar tek gövde olur
    const cell = 6;
    const g2 = new Map();
    const k2 = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
    for (const nd of active) {
      const key = k2(nd.x, nd.y);
      if (!g2.has(key)) g2.set(key, []);
      g2.get(key).push(nd);
    }
    for (const a of active.slice().sort((p, q) => q.n - p.n)) {
      if (a.done) continue;
      const cx = Math.floor(a.x / cell), cy = Math.floor(a.y / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const b of g2.get(`${cx + dx},${cy + dy}`) || []) {
          if (b === a || b.done || a.done || Math.abs(a.z - b.z) > 0.01) continue;
          if (a.n + b.n > MAX_N || Math.abs(a.floor - b.floor) > 1.5) continue;
          if (Math.hypot(a.x - b.x, a.y - b.y) > a.r + b.r + 0.6) continue;
          const n = a.n + b.n;
          const mx = (a.x * a.n + b.x * b.n) / n, my = (a.y * a.n + b.y * b.n) / n;
          const r = radiusOf(n);
          if (!segClear(a.x, a.y, a.z, mx, my, a.z, r) || !segClear(b.x, b.y, b.z, mx, my, b.z, r)) continue;
          add(a.x, a.y, a.z, mx, my, a.z, a.r);
          add(b.x, b.y, b.z, mx, my, b.z, b.r);
          a.x = mx; a.y = my; a.n = n; a.r = r;
          b.done = true;
        }
      }
    }
    active = active.filter((nd) => !nd.done);
    level = T;
    if (T <= 0) { for (const nd of active) finish(nd, 0); active = []; }
  }
  return segs;
}

/** Destek verisini görsel InstancedMesh'e çevirir (ağaç: silindir dallar, normal: blok sütunlar). */
export function buildSupportMesh(sup, type) {
  const mat = new THREE.MeshStandardMaterial({ color: 0x5fd08a, roughness: 0.85, metalness: 0 });
  const mtx = new THREE.Matrix4();
  let im;
  if (type === 'tree') {
    const segs = sup.segments;
    im = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 8), mat, Math.max(segs.length, 1));
    im.count = segs.length;
    const up = new THREE.Vector3(0, 1, 0), dir = new THREE.Vector3(), mid = new THREE.Vector3();
    const q = new THREE.Quaternion(), s = new THREE.Vector3();
    segs.forEach((g, i) => {
      dir.subVectors(g.b, g.a);
      const len = dir.length();
      q.setFromUnitVectors(up, dir.normalize());
      mid.addVectors(g.a, g.b).multiplyScalar(0.5);
      im.setMatrixAt(i, mtx.compose(mid, q, s.set(g.r, Math.max(len, 0.01), g.r)));
    });
  } else {
    const n = sup.columns.length;
    im = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, Math.max(n, 1));
    im.count = n;
    const w = sup.step * 0.92;
    sup.columns.forEach((c, i) => {
      const h = Math.max(c.top - c.bot - 0.2, 0.1);
      im.setMatrixAt(i, mtx.makeScale(w, w, h).setPosition(c.x, c.y, c.bot + h / 2));
    });
  }
  im.instanceMatrix.needsUpdate = true;
  im.name = 'supports';
  return im;
}

export const MATERIALS = {
  PLA: { density: 1.24, speed: 1.0 },
  PETG: { density: 1.27, speed: 0.7 },
  ABS: { density: 1.04, speed: 0.85 },
  ASA: { density: 1.07, speed: 0.85 },
  TPU: { density: 1.21, speed: 0.3 },
};

/**
 * Filament ve süre tahmini. Basit hacim modeli:
 * kabuk = yüzey alanı × duvar kalınlığı, iç = kalan hacim × doluluk.
 * Hızlar A1 varsayılan profilinden kabaca türetilmiş efektif hacimsel akışlardır.
 */
export function estimate({ volume, area, height, supportVolume, objectCount }, p) {
  const mat = MATERIALS[p.material] || MATERIALS.PLA;
  const lineW = 0.42;
  const shell = Math.min(volume, area * p.walls * lineW);
  const inner = Math.max(0, volume - shell) * (p.infill / 100);
  const modelMat = shell + inner;
  const gc = p.gramCalib || 1; // kendi baskılarından öğrenilen filament katsayısı
  const total = (modelMat + supportVolume) * gc;
  const grams = (total / 1000) * mat.density;
  const meters = total / (Math.PI * 0.875 * 0.875) / 1000;
  const cost = (grams / 1000) * p.price;

  const lf = p.layerH / 0.2; // katman kalınlığı akışı ölçekler
  const k = mat.speed * lf;
  const rateWall = 9 * k, rateInfill = 16 * k, rateSup = 11 * k; // mm³/s
  const layers = Math.ceil(height / p.layerH);
  let sec = shell / rateWall + inner / rateInfill + supportVolume / rateSup;
  sec += layers * (1.6 + 0.6 * Math.max(0, objectCount - 1)); // katman değişimi + nesneler arası geçiş
  sec += 300; // ısıtma, kalibrasyon, tabla tarama
  sec *= p.calib;
  return { grams, meters, cost, sec, layers, modelMat, supportVolume };
}

export function formatTime(sec) {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h} sa ${m} dk` : `${m} dk`;
}

/** Destek ihtiyacı en az olan yönü bulur; nesneye uygulanacak ek quaternion'u döner. */
export function findBestOrientation(mesh, thresholdDeg) {
  mesh.updateMatrixWorld(true);
  const p = mesh.geometry.attributes.position.array;
  const m = mesh.matrixWorld;
  const flip = m.determinant() < 0 ? -1 : 1;
  const nTri = p.length / 9;
  const pts = new Float32Array(p.length);
  const normals = new Float32Array(nTri * 3);
  const areas = new Float32Array(nTri);
  let totalArea = 0;
  for (let t = 0; t < nTri; t++) {
    const i = t * 9;
    _a.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(m);
    _b.set(p[i + 3], p[i + 4], p[i + 5]).applyMatrix4(m);
    _c.set(p[i + 6], p[i + 7], p[i + 8]).applyMatrix4(m);
    pts.set([_a.x, _a.y, _a.z, _b.x, _b.y, _b.z, _c.x, _c.y, _c.z], i);
    _n.copy(_b).sub(_a).cross(_v.copy(_c).sub(_a)).multiplyScalar(flip);
    const ar = _n.length() / 2;
    areas[t] = ar; totalArea += ar;
    if (ar > 0) _n.normalize();
    normals.set([_n.x, _n.y, _n.z], t * 3);
  }
  // Aday yönler: alanca en büyük düz yüzey kümeleri
  const bins = new Map();
  for (let t = 0; t < nTri; t++) {
    const nx = normals[t * 3], ny = normals[t * 3 + 1], nz = normals[t * 3 + 2];
    const key = `${Math.round(nx * 8)},${Math.round(ny * 8)},${Math.round(nz * 8)}`;
    let b = bins.get(key);
    if (!b) bins.set(key, (b = { area: 0, n: new THREE.Vector3() }));
    b.area += areas[t];
    b.n.x += nx * areas[t]; b.n.y += ny * areas[t]; b.n.z += nz * areas[t];
  }
  const cands = [...bins.values()].sort((a, b) => b.area - a.area).slice(0, 16).map((b) => b.n.normalize());
  cands.push(new THREE.Vector3(0, 0, -1));
  for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1]]) cands.push(new THREE.Vector3(...d));

  const cosLimit = Math.cos(THREE.MathUtils.degToRad(thresholdDeg));
  const down = new THREE.Vector3(0, 0, -1);
  const ez = new THREE.Vector3();
  let best = null;
  for (const n of cands) {
    if (n.lengthSq() < 0.5) continue;
    const q = new THREE.Quaternion().setFromUnitVectors(n, down);
    ez.set(0, 0, 1).applyQuaternion(q.clone().invert()); // dönüşten sonra z = ez·v
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < pts.length; i += 3) {
      const z = ez.x * pts[i] + ez.y * pts[i + 1] + ez.z * pts[i + 2];
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    let over = 0, contact = 0;
    for (let t = 0; t < nTri; t++) {
      const nz = ez.x * normals[t * 3] + ez.y * normals[t * 3 + 1] + ez.z * normals[t * 3 + 2];
      if (nz >= 0) continue;
      const i = t * 9;
      const zmax = Math.max(
        ez.x * pts[i] + ez.y * pts[i + 1] + ez.z * pts[i + 2],
        ez.x * pts[i + 3] + ez.y * pts[i + 4] + ez.z * pts[i + 5],
        ez.x * pts[i + 6] + ez.y * pts[i + 7] + ez.z * pts[i + 8]
      );
      if (zmax - minZ < 0.15) { contact += areas[t]; continue; }
      if (-nz > cosLimit) over += areas[t];
    }
    const score = over - 0.5 * contact + 0.02 * (maxZ - minZ) * Math.sqrt(totalArea);
    if (!best || score < best.score) best = { score, q, over, contact };
  }
  return best;
}

/** Birbirine değmeyen parçaları ayrı geometrilere böler. */
export function splitComponents(geom) {
  const p = geom.attributes.position.array;
  const nV = p.length / 3;
  const idOf = new Map();
  const vid = new Int32Array(nV);
  let next = 0;
  for (let i = 0; i < nV; i++) {
    const key = `${Math.round(p[i * 3] * 1e4)},${Math.round(p[i * 3 + 1] * 1e4)},${Math.round(p[i * 3 + 2] * 1e4)}`;
    let id = idOf.get(key);
    if (id === undefined) { id = next++; idOf.set(key, id); }
    vid[i] = id;
  }
  const parent = new Int32Array(next).map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const unite = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  for (let t = 0; t < nV; t += 3) { unite(vid[t], vid[t + 1]); unite(vid[t], vid[t + 2]); }
  const groups = new Map();
  for (let t = 0; t < nV; t += 3) {
    const r = find(vid[t]);
    let arr = groups.get(r);
    if (!arr) groups.set(r, (arr = []));
    arr.push(t);
  }
  if (groups.size < 2) return [geom];
  return [...groups.values()]
    .sort((a, b) => b.length - a.length)
    .map((tris) => {
      const out = new Float32Array(tris.length * 9);
      tris.forEach((t, k) => out.set(p.subarray(t * 3, t * 3 + 9), k * 9));
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(out, 3));
      g.computeVertexNormals();
      return g;
    });
}
