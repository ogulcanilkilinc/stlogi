import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { BED, createBed } from './bed.js';
import { loadFile } from './loaders.js';
import {
  worldGeometry, meshStats, paintOverhangs, computeSupports, buildSupportMesh,
  estimate, formatTime, findBestOrientation, splitComponents, MATERIALS,
} from './analysis.js';
import { cutGeometry, drillHole, csgApply } from './cut.js';
import { refreshRates, getRates, toTRY } from './fx.js';
import { build3MF } from './export3mf.js';
import { loadSlots, saveSlots, amsBreakdown } from './ams.js';
import { checkMesh, describeChecks } from './printcheck.js';
import { makePrimitive, makeText, orientToSurface, FONTS } from './shapes.js';
import * as lib from './library.js';
import { packRects } from './pack.js';

// Sahne Z-yukarı (yazıcı koordinatları gibi)
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const $ = (id) => document.getElementById(id);
const viewportEl = $('viewport');
// AMS lite: 4 filament slotu. Her nesne bir slota atanır; rengi slotun rengidir.
let slots = loadSlots();
const SLOT_NAMES = ['1', '2', '3', '4'];

// ---------- Renderer / sahne ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.localClippingEnabled = true;
renderer.setClearColor(0x1b1e23);
viewportEl.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
scene.add(camera);
scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3f48, 1.4));
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(0.4, 0.6, 0);
camera.add(sun);
sun.target.position.set(0, 0, -1);
camera.add(sun.target);

// Çoklu plaka: her plaka kendi 256×256 tablası; sahnede X yönünde yan yana dizilir (arada 40 mm boşluk)
const PLATE_STEP = BED.x + 40;
const beds = [];

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(BED.x / 2, BED.y / 2, 20);
camera.position.set(BED.x / 2 + 260, BED.y / 2 - 330, 300);
controls.update();

const tc = new TransformControls(camera, renderer.domElement);
tc.setSize(0.9);
scene.add(tc.getHelper());

// Katman önizleme için ortak kesit düzlemi (z <= constant görünür)
const clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 1e6);
let clipActive = false;

let needsRender = true;
const requestRender = () => { needsRender = true; };
controls.addEventListener('change', requestRender);
tc.addEventListener('change', requestRender);

function resize() {
  const w = viewportEl.clientWidth, h = viewportEl.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  requestRender();
}
new ResizeObserver(resize).observe(viewportEl);

function loop() {
  requestAnimationFrame(loop);
  if (!needsRender) return;
  needsRender = false;
  syncPaintViz();
  renderer.render(scene, camera);
  updateMeasureLabels();
}

// ---------- Durum ----------
const objects = [];
let selected = new Set();
let mode = 'select';
let supportMeshes = []; // plaka başına bir destek önizleme nesnesi
let supportVolByPlate = []; // plaka başına destek hacmi (mm³)
const statsCache = new WeakMap();

function setStatus(t) { $('statusText').textContent = t; }
let toastTimer;
function toast(msg, err = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), 3500);
}
const nextFrame = () => new Promise((r) => setTimeout(r, 30));

// ---------- Nesne oluşturma ----------
function createMesh(geom, name, slot = 0) {
  if (!geom.boundsTree) geom.computeBoundsTree();
  const color = slots[slot];
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05, clippingPlanes: [clipPlane] });
  const mesh = new THREE.Mesh(geom, mat);
  const capColor = new THREE.Color(color).multiplyScalar(0.55);
  const cap = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color: capColor, side: THREE.BackSide, clippingPlanes: [clipPlane] }));
  cap.raycast = () => {};
  cap.visible = clipActive;
  mesh.add(cap);
  // paint: elle boyanan destek bölgeleri, nesne yerel koordinatlarında [x, y, z, yarıçap(mm)]
  mesh.userData = { name, color, slot, cap, paint: { enf: [], blk: [] } };
  return mesh;
}

/** Nesnenin slotunu değiştirir; rengi slot renginden alır. */
function setSlot(o, slot) {
  o.userData.slot = slot;
  o.userData.color = slots[slot];
  o.userData.cap.material.color.set(slots[slot]).multiplyScalar(0.55);
}

/** Geometriyi kendi merkezine taşır, sahneye ekler (dünya konumu korunur). */
function addObject(geom, name, slot = 0) {
  geom.computeBoundingBox();
  const c = geom.boundingBox.getCenter(new THREE.Vector3());
  geom.translate(-c.x, -c.y, -c.z);
  geom.computeBoundingBox();
  const mesh = createMesh(geom, name, slot);
  mesh.position.copy(c);
  scene.add(mesh);
  objects.push(mesh);
  return mesh;
}

function removeObject(o) {
  if (tc.object === o) tc.detach();
  if (o.userData.viz) { scene.remove(o.userData.viz); o.userData.viz.geometry.dispose(); o.userData.viz = null; }
  scene.remove(o);
  objects.splice(objects.indexOf(o), 1);
  selected.delete(o);
}

const worldBox = (o) => new THREE.Box3().setFromObject(o, true);

function dropToBed(o) {
  o.updateMatrixWorld(true);
  const b = worldBox(o);
  o.position.z -= b.min.z;
  o.updateMatrixWorld(true);
}

/** Bir kutunun hangi plakada olduğu (merkezinin X'ine göre). */
const plateOf = (b) => Math.max(0, Math.floor((b.min.x + b.max.x) / 2 / PLATE_STEP));
const objPlate = (o) => plateOf(worldBox(o));
const plateCount = () => Math.max(1, ...objects.map((o) => objPlate(o) + 1));

function isOutOfBed(b) {
  const t = 0.01;
  const ox = plateOf(b) * PLATE_STEP;
  return b.min.x < ox - t || b.min.y < -t || b.max.x > ox + BED.x + t || b.max.y > BED.y + t || b.max.z > BED.z + t;
}

function plateLabel(n) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = 'bold 40px "Segoe UI", sans-serif'; g.fillStyle = '#98a0ab'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(`Plaka ${n}`, 128, 34);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
  s.scale.set(50, 12.5, 1);
  s.position.set(BED.x / 2, -14, 1);
  s.name = 'plateLabel';
  s.raycast = () => {};
  return s;
}
/** Kullanılan plaka sayısı kadar tabla çizer (birden fazlaysa "Plaka N" etiketi ekler). */
function updateBeds() {
  const n = plateCount();
  while (beds.length < n) { const g = createBed(); g.position.x = beds.length * PLATE_STEP; scene.add(g); beds.push(g); }
  while (beds.length > n) scene.remove(beds.pop());
  beds.forEach((g, i) => {
    g.getObjectByName('plateLabel')?.removeFromParent();
    if (n > 1) g.add(plateLabel(i + 1));
  });
}

/** Yeni nesne için boş yer bulur (önce 1. plaka; dolduysa sıradaki, gerekirse yeni plaka). */
function placeOnFreeSpot(o) {
  dropToBed(o);
  const b = worldBox(o);
  const w = b.max.x - b.min.x, d = b.max.y - b.min.y;
  const others = objects.filter((x) => x !== o).map(worldBox);
  const nPlates = Math.max(1, ...others.map((r) => plateOf(r) + 1));
  const gap = 5;
  for (let k = 0; k <= nPlates; k++) {
    const ox = k * PLATE_STEP;
    let best = null;
    for (let y = gap; y + d <= BED.y - gap; y += 4) {
      for (let x = gap; x + w <= BED.x - gap; x += 4) {
        const hit = others.some((r) => ox + x < r.max.x + gap && ox + x + w > r.min.x - gap && y < r.max.y + gap && y + d > r.min.y - gap);
        if (hit) continue;
        const dist = Math.hypot(x + w / 2 - BED.x / 2, y + d / 2 - BED.y / 2);
        if (!best || dist < best.dist) best = { x, y, dist };
      }
    }
    if (best) {
      o.position.x += ox + best.x - b.min.x;
      o.position.y += best.y - b.min.y;
      if (k > 0) toast(`Plaka ${k} dolu; nesne Plaka ${k + 1}'e yerleştirildi.`);
      return;
    }
  }
  // Tabladan büyük nesne: ilk plakanın ortasına koy (taşma uyarısı verilir)
  o.position.x += BED.x / 2 - w / 2 - b.min.x;
  o.position.y += BED.y / 2 - d / 2 - b.min.y;
}

// ---------- Geçmiş (geri al / yinele) ----------
const undoStack = [], redoStack = [];
const snapshot = () => objects.map((o) => ({
  geom: o.geometry, name: o.userData.name, slot: o.userData.slot,
  paint: { enf: o.userData.paint.enf.slice(), blk: o.userData.paint.blk.slice() },
  p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone(),
}));
function pushHistory() {
  undoStack.push(snapshot());
  if (undoStack.length > 40) undoStack.shift();
  redoStack.length = 0;
}
function restore(snap) {
  tc.detach();
  [...objects].forEach(removeObject);
  for (const s of snap) {
    const m = createMesh(s.geom, s.name, s.slot);
    m.userData.paint = { enf: s.paint.enf.slice(), blk: s.paint.blk.slice() };
    m.position.copy(s.p); m.quaternion.copy(s.q); m.scale.copy(s.s);
    scene.add(m); objects.push(m);
    refreshPaintViz(m);
  }
  selected = new Set();
  onModelChanged({ drop: false });
}
function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); setStatus('Geri alındı.'); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); setStatus('Yinelendi.'); }

// ---------- Görünüm güncellemeleri ----------
function applyMaterial(o) {
  const mat = o.material;
  const ovh = $('ovhOn').checked;
  if (mat.vertexColors !== ovh) { mat.vertexColors = ovh; mat.needsUpdate = true; }
  mat.color.set(ovh ? 0xffffff : o.userData.color);
  o.userData.ovArea = ovh ? paintOverhangs(o, +$('supAngle').value, o.userData.color) : 0;
  const out = isOutOfBed(worldBox(o));
  o.userData.out = out;
  mat.emissive.set(out ? 0x5a0d0d : selected.has(o) ? 0x0e4a24 : 0x000000);
}

function onModelChanged({ drop = true } = {}) {
  for (const o of objects) {
    if (drop) dropToBed(o);
    applyMaterial(o);
    statsCache.set(o, meshStats(o));
  }
  updateBeds();
  updateList();
  updateXformPanel();
  updateInfo();
  updateCutRange();
  updateLayerInfo();
  scheduleSupports();
  updateEstimate();
  scheduleChecks();
  updateSlotButtons();
  requestRender();
}

function updateList() {
  const ul = $('objList');
  ul.innerHTML = '';
  for (const o of objects) {
    const li = document.createElement('li');
    const b = worldBox(o);
    const s = b.getSize(new THREE.Vector3());
    li.className = (selected.has(o) ? 'sel ' : '') + (o.userData.out ? 'out' : '');
    li.innerHTML = `<span class="sw" style="background:${o.userData.color}"></span><span class="nm" title="${o.userData.name}">${o.userData.name}</span><small>${s.x.toFixed(0)}×${s.y.toFixed(0)}×${s.z.toFixed(0)}</small>`;
    li.onclick = (e) => select(o, e.ctrlKey || e.shiftKey);
    ul.appendChild(li);
  }
}

function single() { return selected.size === 1 ? [...selected][0] : null; }

function updateXformPanel() {
  const o = single();
  $('xformSection').classList.toggle('disabled', !o);
  if (!o) return;
  const set = (id, v) => { if (document.activeElement !== $(id)) $(id).value = +v.toFixed(2); };
  set('posX', o.position.x - objPlate(o) * PLATE_STEP); set('posY', o.position.y);
  set('posZ', worldBox(o).min.z);
  const r = new THREE.Euler().setFromQuaternion(o.quaternion, 'XYZ');
  set('rotX', THREE.MathUtils.radToDeg(r.x)); set('rotY', THREE.MathUtils.radToDeg(r.y)); set('rotZ', THREE.MathUtils.radToDeg(r.z));
  const gs = o.geometry.boundingBox.getSize(new THREE.Vector3());
  set('sizeX', gs.x * Math.abs(o.scale.x)); set('sizeY', gs.y * Math.abs(o.scale.y)); set('sizeZ', gs.z * Math.abs(o.scale.z));
  set('sclX', Math.abs(o.scale.x) * 100); set('sclY', Math.abs(o.scale.y) * 100); set('sclZ', Math.abs(o.scale.z) * 100);
}

function updateInfo() {
  const el = $('modelInfo');
  if (!objects.length) { el.innerHTML = 'Model yok. Dosyayı pencereye sürükleyip bırakın.'; return; }
  const list = selected.size ? [...selected] : objects;
  const box = new THREE.Box3();
  let vol = 0, area = 0, tris = 0, ov = 0, isl = 0, out = false;
  for (const o of list) {
    box.union(worldBox(o));
    const s = statsCache.get(o) || meshStats(o);
    vol += s.volume; area += s.area; tris += s.tris; ov += o.userData.ovArea || 0; isl += o.userData.islands || 0;
    out ||= o.userData.out;
  }
  const sz = box.getSize(new THREE.Vector3());
  const title = list.length === 1 ? list[0].userData.name : `${list.length} nesne`;
  el.innerHTML = `<b>${title}</b><br>
    Boyut: <b>${sz.x.toFixed(1)} × ${sz.y.toFixed(1)} × ${sz.z.toFixed(1)}</b> mm<br>
    Hacim: <b>${(vol / 1000).toFixed(2)}</b> cm³ · Yüzey: <b>${(area / 100).toFixed(1)}</b> cm²<br>
    Üçgen: ${tris.toLocaleString('tr-TR')}
    ${$('ovhOn').checked ? `<br>Destek isteyen alan: <b>${(ov / 100).toFixed(1)}</b> cm²` : ''}
    ${$('ovhOn').checked && isl ? `<br>Havada başlayan uç: <b>${isl}</b> nokta` : ''}
    ${out ? '<br><span class="warn">⚠ Tabla dışına taşıyor (A1: 256×256×256 mm)</span>' : ''}`;
}

// ---------- Baskı ayarları ve tahmin ----------
const PRESETS = {
  decor: { layerH: '0.16', walls: 2, infill: 10, note: 'Görünüm öncelikli. İnce katman daha pürüzsüz yüzey verir; dayanım önemli değil.' },
  standard: { layerH: '0.20', walls: 2, infill: 15, note: 'Bambu varsayılanına yakın. Çoğu ev eşyası için yeterli.' },
  functional: { layerH: '0.20', walls: 4, infill: 40, note: 'Yük taşıyan / vidalanan parçalar. Duvar sayısı dayanımı doluluktan daha çok artırır. Katmanlar kuvvete dik değil paralel gelecek şekilde yatırın — parçalar katman çizgisinden kırılır.' },
  draft: { layerH: '0.28', walls: 2, infill: 8, note: 'Ölçü / prova baskısı: hızlı ve ucuz, yüzey kaba.' },
  fine: { layerH: '0.08', walls: 3, infill: 15, note: 'Minyatür ve ince detay. Süre çok uzar; ağaç destek önerilir.' },
  custom: { note: 'Kendi değerleriniz.' },
};

function readParams() {
  return {
    material: $('material').value,
    layerH: parseFloat($('layerH').value),
    walls: Math.max(1, +$('walls').value || 2),
    infill: Math.min(100, Math.max(0, +$('infill').value)),
    price: toTRY(+$('price').value || 0, $('priceCur').value), // ₺/kg; kur yoksa null
    calib: +$('calib').value || 1,
    gramCalib: +$('gcalib').value || 1,
  };
}

const COLOR_CHANGE_SEC = 40; // AMS lite renk değişimi başına yaklaşık süre
let lastAms = null;

/** Tek bir plakadaki nesnelerin tahmini. */
function estimateFor(list, raw, sv) {
  let volume = 0, area = 0, height = 0, out = false;
  for (const o of list) {
    const s = statsCache.get(o) || meshStats(o);
    volume += s.volume; area += s.area;
    height = Math.max(height, worldBox(o).max.z);
    out ||= o.userData.out;
  }
  const p = readParams();
  if (raw) { p.calib = 1; p.gramCalib = 1; }
  const e = estimate({ volume, area, height, supportVolume: sv, objectCount: list.length }, p);
  const density = MATERIALS[p.material].density;
  const items = list.map((o) => {
    const b = worldBox(o);
    return { slot: o.userData.slot, volume: (statsCache.get(o) || meshStats(o)).volume, zMin: b.min.z, zMax: b.max.z };
  });
  const ams = amsBreakdown(items, slots, { layerH: p.layerH, modelGrams: (e.modelMat / 1000) * density * p.gramCalib, density });
  ams.wasteGrams *= p.gramCalib;
  e.sec += ams.changes * COLOR_CHANGE_SEC * p.calib;
  if (p.price != null) e.cost += (ams.wasteGrams / 1000) * p.price;
  return { e, p, ams, sv, out, density };
}

/**
 * Sahne tahmini: her plaka ayrı hesaplanır (ayrı ayrı basılacakları için), toplam bunların toplamıdır.
 * raw=true: kalibrasyon katsayıları 1 alınır (baskı kaydı için ham tahmin). plates[k]: k. plakanın sonucu (boşsa null).
 */
function sceneEstimate(raw = false) {
  const n = plateCount();
  const groups = Array.from({ length: n }, () => []);
  for (const o of objects) groups[objPlate(o)].push(o);
  const plates = groups.map((l, k) => (l.length ? estimateFor(l, raw, $('supOn').checked ? supportVolByPlate[k] || 0 : 0) : null));
  const used = plates.filter(Boolean);
  const e = { sec: 0, grams: 0, meters: 0, cost: 0, layers: 0, modelMat: 0 };
  const ams = { perSlot: [0, 0, 0, 0], changes: 0, wasteGrams: 0, used: [] };
  let sv = 0, out = false;
  for (const r of used) {
    e.sec += r.e.sec; e.grams += r.e.grams; e.meters += r.e.meters; e.cost += r.e.cost; e.modelMat += r.e.modelMat;
    e.layers = Math.max(e.layers, r.e.layers);
    r.ams.perSlot.forEach((g, i) => (ams.perSlot[i] += g));
    ams.changes += r.ams.changes; ams.wasteGrams += r.ams.wasteGrams;
    r.ams.used.forEach((i) => { if (!ams.used.includes(i)) ams.used.push(i); });
    sv += r.sv; out ||= r.out;
  }
  ams.used.sort();
  return { e, p: used[0].p, ams, sv, out, density: used[0].density, plates };
}

function updateEstimate() {
  const el = $('estimate');
  if (!objects.length) { el.innerHTML = '—'; lastAms = null; updateAmsLabels(null); return; }
  const { e, p, ams, sv, out, density, plates } = sceneEstimate();
  lastAms = ams;
  const multi = ams.used.length > 1;
  const perPlate = plates.length > 1
    ? plates.map((r, k) => (r ? `<span class="k">Plaka ${k + 1}</span><span class="v">${formatTime(r.e.sec)} · ${(r.e.grams + r.ams.wasteGrams).toFixed(0)} g</span>` : '')).join('')
    : '';
  el.innerHTML = `
    <span class="k">Süre${plates.length > 1 ? ' (toplam)' : ''}</span><span class="v big">≈ ${formatTime(e.sec)}</span>
    ${perPlate}
    <span class="k">Filament</span><span class="v">${e.grams.toFixed(1)} g · ${e.meters.toFixed(2)} m</span>
    ${multi ? `<span class="k">Renk atığı</span><span class="v">≈ ${ams.wasteGrams.toFixed(1)} g <small>(${ams.changes} değişim)</small></span>` : ''}
    <span class="k">Maliyet</span><span class="v">${p.price == null ? 'kur alınamadı' : `≈ ${e.cost.toFixed(2)} ₺`}</span>
    <span class="k">Katman</span><span class="v">${e.layers}</span>
    <span class="k">Destek</span><span class="v">${$('supOn').checked ? `${((sv / 1000) * density * p.gramCalib).toFixed(1)} g` : 'kapalı'}</span>
    ${out ? '<span class="k warn">Uyarı</span><span class="v warn">Tabla dışına taşan nesne var</span>' : ''}`;
  updateAmsLabels(ams);
  saveSettings();
  renderChecks();
}

function saveSettings() {
  const ids = ['preset', 'material', 'layerH', 'walls', 'infill', 'price', 'priceCur', 'calib', 'gcalib', 'supOn', 'supAngle', 'supType', 'supBedOnly', 'ovhOn', 'paintR'];
  const s = {};
  ids.forEach((id) => (s[id] = $(id).type === 'checkbox' ? $(id).checked : $(id).value));
  try { localStorage.setItem('stlogi.settings', JSON.stringify(s)); } catch { /* yok say */ }
}
function loadSettings() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem('stlogi.settings')); } catch { /* yok say */ }
  if (s) for (const [id, v] of Object.entries(s)) {
    if (!$(id)) continue;
    if ($(id).type === 'checkbox') $(id).checked = v; else $(id).value = v;
  }
  $('presetNote').textContent = PRESETS[$('preset').value]?.note || '';
}

$('preset').addEventListener('change', () => {
  const pr = PRESETS[$('preset').value];
  if (pr.layerH) { $('layerH').value = pr.layerH; $('walls').value = pr.walls; $('infill').value = pr.infill; }
  $('presetNote').textContent = pr.note;
  updateEstimate(); updateLayerInfo();
});
for (const id of ['layerH', 'walls', 'infill']) {
  $(id).addEventListener('change', () => { $('preset').value = 'custom'; $('presetNote').textContent = PRESETS.custom.note; updateEstimate(); updateLayerInfo(); });
}
for (const id of ['material', 'price', 'calib', 'gcalib']) $(id).addEventListener('change', updateEstimate);

// ---------- Döviz kuru ----------
function updateFxNote() {
  const r = getRates();
  const cur = $('priceCur').value;
  const fmt = (v) => v.toLocaleString('tr-TR', { maximumFractionDigits: 2 });
  if (!r) {
    $('fxNote').textContent = cur === 'TRY' ? '' : 'Kur alınamadı; internet bağlantısını kontrol edin.';
    return;
  }
  const tl = cur === 'TRY' ? '' : ` → ${fmt(toTRY(+$('price').value || 0, cur))} ₺/kg`;
  $('fxNote').textContent = `1 $ = ${fmt(r.USD)} ₺ · 1 € = ${fmt(r.EUR)} ₺ (${r.date}, ${r.source})${tl}`;
}
async function syncRates(force = false) {
  await refreshRates(force);
  updateFxNote();
  updateEstimate();
}
$('priceCur').addEventListener('change', () => { updateFxNote(); updateEstimate(); syncRates(); });
$('price').addEventListener('change', updateFxNote);

// ---------- Destek önizleme ----------
let supTimer;
function scheduleSupports() {
  clearTimeout(supTimer);
  supTimer = setTimeout(rebuildSupports, 200);
}
async function rebuildSupports() {
  for (const m of supportMeshes) { scene.remove(m); m.geometry.dispose(); }
  supportMeshes = [];
  supportVolByPlate = [];
  if ($('supOn').checked && objects.length) {
    setStatus('Destek hesaplanıyor…');
    await nextFrame();
    const opts = { thresholdDeg: +$('supAngle').value, type: $('supType').value, bedOnly: $('supBedOnly').checked };
    const t0 = performance.now();
    const tot = { cols: 0, isl: 0, enf: 0, blk: 0, paintEnf: 0 };
    const n = plateCount();
    // Her plaka kendi başına hesaplanır (plakalar ayrı baskılar; destek hacmi plaka başına ayrı tutulur)
    for (let k = 0; k < n; k++) {
      const list = objects.filter((o) => objPlate(o) === k);
      if (!list.length) { supportVolByPlate[k] = 0; continue; }
      const paint = worldPaint(list);
      const sup = computeSupports(list, { ...opts, paint });
      supportVolByPlate[k] = sup.volume;
      if (window.STLOgi) window.STLOgi.lastSupports = sup; // test/hata ayıklama
      const mesh = buildSupportMesh(sup, opts.type);
      mesh.material.clippingPlanes = [clipPlane];
      mesh.raycast = () => {};
      scene.add(mesh);
      supportMeshes.push(mesh);
      tot.cols += sup.columns.length; tot.isl += sup.islandCount || 0; tot.enf += sup.enforced || 0; tot.blk += sup.blocked || 0;
      tot.paintEnf += paint.enf.length;
    }
    const islTxt = (tot.isl ? `, ${tot.isl} havada başlayan uç` : '')
      + (tot.enf ? `, ${tot.enf} elle eklenen` : '') + (tot.blk ? `, ${tot.blk} elle engellenen` : '')
      + (tot.paintEnf && !tot.enf ? ' · "Destek koy" boyası altı boş bir yüzeye denk gelmedi (destek yalnızca altında boşluk olan yüzeylere konur)' : '');
    setStatus(`Destek önizlemesi: ${tot.cols} temas noktası${islTxt} (${Math.round(performance.now() - t0)} ms). Gerçek destek şekli Bambu Studio'da farklı olabilir.`);
  }
  updateEstimate();
  requestRender();
}
$('supOn').addEventListener('change', scheduleSupports);
for (const id of ['supType', 'supBedOnly']) $(id).addEventListener('change', scheduleSupports);
for (const id of ['supAngle', 'ovhOn']) $(id).addEventListener('change', () => onModelChanged({ drop: false }));

// ---------- Seçim ----------
function select(o, additive = false) {
  if (!additive) selected = new Set();
  if (o) {
    if (additive && selected.has(o)) selected.delete(o); else selected.add(o);
  }
  attachGizmo();
  objects.forEach(applyMaterialEmissive);
  updateList(); updateXformPanel(); updateInfo(); updateCutRange(); updateSlotButtons();
  requestRender();
}
function applyMaterialEmissive(o) {
  o.material.emissive.set(o.userData.out ? 0x5a0d0d : selected.has(o) ? 0x0e4a24 : 0x000000);
}
function attachGizmo() {
  const o = single();
  if (o && ['translate', 'rotate', 'scale'].includes(mode)) {
    tc.attach(o);
    tc.setMode(mode);
    tc.showZ = mode !== 'translate';
  } else tc.detach();
}

const HINTS = {
  select: 'Nesneye tıklayarak seçin · Ctrl+tık: çoklu seçim',
  translate: 'Okları sürükleyerek taşıyın (nesne tablada kalır)',
  rotate: 'Halkaları sürükleyerek döndürün · Kırmızı alanlar destek ister',
  scale: 'Kutucukları sürükleyerek ölçekleyin',
  layflat: 'Tablaya oturmasını istediğiniz yüzeye tıklayın',
  measure: 'İki noktaya tıklayın · Esc: ölçümleri temizle',
  paint: 'Sol tuşu basılı tutup modelin üstüne boyayın (Destek önizlemesi otomatik açılır) · Boşluğa basarak döndürebilirsiniz',
  hole: 'Delik açmak istediğiniz yüzeye tıklayın · Çap ve derinlik sağdaki "Ekle" bölümünde',
  text: 'Yazının oturacağı yüzeye tıklayın · Esc: vazgeç',
};
function setMode(m) {
  mode = m;
  document.querySelectorAll('#modeGroup button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  $('btnPaintOn').classList.toggle('active', m === 'paint');
  renderer.domElement.style.cursor = ['layflat', 'measure', 'paint', 'hole', 'text'].includes(m) ? 'crosshair' : '';
  $('btnModeText').hidden = m !== 'text';
  if (m !== 'text') pendingText = null;
  $('hud').textContent = HINTS[m];
  if (m === 'paint' && !$('supOn').checked) { $('supOn').checked = true; scheduleSupports(); }
  if (m !== 'measure') clearPending();
  attachGizmo();
  requestRender();
}
document.querySelectorAll('#modeGroup button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

// Gizmo olayları
let liveRaf = 0;
tc.addEventListener('dragging-changed', (e) => (controls.enabled = !e.value));
tc.addEventListener('mouseDown', () => pushHistory());
tc.addEventListener('objectChange', () => {
  if (liveRaf) return;
  liveRaf = requestAnimationFrame(() => {
    liveRaf = 0;
    const o = tc.object;
    if (!o) return;
    if (mode !== 'translate' && $('ovhOn').checked && statsCache.get(o)?.tris < 150000) {
      o.userData.ovArea = paintOverhangs(o, +$('supAngle').value, o.userData.color);
    }
    updateXformPanel();
    requestRender();
  });
});
tc.addEventListener('mouseUp', () => onModelChanged());

// Tıklama ile seçim / yatırma / ölçme
const raycaster = new THREE.Raycaster();
raycaster.firstHitOnly = true;
const ndc = new THREE.Vector2();
function pick(e) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return raycaster.intersectObjects(objects, false)[0];
}
let downPos = null;
const touchIds = new Set(); // aynı anda basılı parmaklar: çok parmaklı harekette (yakınlaştırma) seçim yapma
let multiTouch = false;
renderer.domElement.addEventListener('pointerdown', (e) => {
  touchIds.add(e.pointerId);
  if (touchIds.size > 1) multiTouch = true;
  downPos = e.button === 0 ? [e.clientX, e.clientY] : null;
});
const endTouch = (e) => { touchIds.delete(e.pointerId); if (!touchIds.size) setTimeout(() => { if (!touchIds.size) multiTouch = false; }, 0); };
renderer.domElement.addEventListener('pointercancel', (e) => { endTouch(e); downPos = null; });
renderer.domElement.addEventListener('pointerup', (e) => {
  const wasMulti = multiTouch;
  endTouch(e);
  if (!downPos || wasMulti) { downPos = null; return; }
  const moved = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]);
  downPos = null;
  if (moved > 4 || tc.dragging || (tc.object && tc.axis)) return;
  if (mode === 'paint') return;
  const hit = pick(e);
  if (mode === 'hole') {
    if (hit) makeHole(hit);
  } else if (mode === 'text') {
    if (hit) textOnSurface(hit);
  } else if (mode === 'layflat') {
    if (!hit) return;
    const o = hit.object;
    const n = hit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(o.matrixWorld)).normalize();
    pushHistory();
    o.quaternion.premultiply(new THREE.Quaternion().setFromUnitVectors(n, new THREE.Vector3(0, 0, -1)));
    onModelChanged();
    select(o);
    setStatus('Seçilen yüzey tablaya yatırıldı.');
  } else if (mode === 'measure') {
    if (hit) addMeasurePoint(hit.point);
  } else {
    select(hit ? hit.object : null, e.ctrlKey || e.shiftKey);
  }
});

// ---------- Ölçüm ----------
const measures = [];
let pending = null;
const markerGeo = new THREE.SphereGeometry(0.8, 12, 8);
const markerMat = new THREE.MeshBasicMaterial({ color: 0xf2a33a, depthTest: false });
function marker(p) {
  const m = new THREE.Mesh(markerGeo, markerMat);
  m.position.copy(p); m.renderOrder = 10; m.raycast = () => {};
  scene.add(m);
  return m;
}
function addMeasurePoint(p) {
  if (!pending) { pending = { a: p.clone(), m: marker(p) }; requestRender(); return; }
  const b = p.clone();
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([pending.a, b]),
    new THREE.LineBasicMaterial({ color: 0xf2a33a, depthTest: false })
  );
  line.renderOrder = 10;
  scene.add(line);
  const d = b.clone().sub(pending.a);
  const label = document.createElement('div');
  label.className = 'mlabel';
  label.innerHTML = `${d.length().toFixed(2)} mm <small>ΔX ${Math.abs(d.x).toFixed(1)} · ΔY ${Math.abs(d.y).toFixed(1)} · ΔZ ${Math.abs(d.z).toFixed(1)}</small>`;
  $('measureLayer').appendChild(label);
  measures.push({ a: pending.a, b, objs: [pending.m, marker(b), line], label });
  setStatus(`Mesafe: ${d.length().toFixed(2)} mm`);
  pending = null;
  requestRender();
}
function clearPending() { if (pending) { scene.remove(pending.m); pending = null; requestRender(); } }
function clearMeasures() {
  clearPending();
  for (const m of measures) { m.objs.forEach((x) => scene.remove(x)); m.label.remove(); }
  measures.length = 0;
  requestRender();
}
const _p = new THREE.Vector3();
function updateMeasureLabels() {
  const w = viewportEl.clientWidth, h = viewportEl.clientHeight;
  for (const m of measures) {
    _p.copy(m.a).add(m.b).multiplyScalar(0.5).project(camera);
    m.label.style.display = _p.z > 1 ? 'none' : '';
    m.label.style.left = `${((_p.x + 1) / 2) * w}px`;
    m.label.style.top = `${((1 - _p.y) / 2) * h}px`;
  }
}

// ---------- Dönüşüm paneli ----------
function editSelected(fn) {
  const o = single();
  if (!o) return;
  pushHistory();
  fn(o);
  onModelChanged();
}
$('posX').addEventListener('change', (e) => editSelected((o) => (o.position.x = +e.target.value + objPlate(o) * PLATE_STEP)));
$('posY').addEventListener('change', (e) => editSelected((o) => (o.position.y = +e.target.value)));
for (const ax of ['X', 'Y', 'Z']) {
  $('rot' + ax).addEventListener('change', () => editSelected((o) => {
    o.rotation.set(...['X', 'Y', 'Z'].map((a) => THREE.MathUtils.degToRad(+$('rot' + a).value)), 'XYZ');
  }));
  const k = ax.toLowerCase();
  $('size' + ax).addEventListener('change', (e) => editSelected((o) => {
    const cur = o.geometry.boundingBox.getSize(new THREE.Vector3())[k] * Math.abs(o.scale[k]);
    const f = (+e.target.value || cur) / cur;
    if ($('uniform').checked) o.scale.multiplyScalar(f); else o.scale[k] *= f;
  }));
  $('scl' + ax).addEventListener('change', (e) => editSelected((o) => {
    const f = (+e.target.value || 100) / 100 / Math.abs(o.scale[k]);
    if ($('uniform').checked) o.scale.multiplyScalar(f); else o.scale[k] *= f;
  }));
}
const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
document.querySelectorAll('[data-rot]').forEach((b) => (b.onclick = () => editSelected((o) => o.rotateOnWorldAxis(AXES[b.dataset.rot], Math.PI / 2))));
document.querySelectorAll('[data-mirror]').forEach((b) => (b.onclick = () => editSelected((o) => (o.scale[b.dataset.mirror] *= -1))));
$('btnReset').onclick = () => editSelected((o) => { o.quaternion.identity(); o.scale.set(1, 1, 1); });
$('btnCenter').onclick = () => editSelected((o) => {
  const c = worldBox(o).getCenter(new THREE.Vector3());
  o.position.x += objPlate(o) * PLATE_STEP + BED.x / 2 - c.x; o.position.y += BED.y / 2 - c.y;
});
$('btnAutoOrient').onclick = async () => {
  const o = single();
  if (!o) return;
  setStatus('En iyi yön aranıyor…');
  await nextFrame();
  const best = findBestOrientation(o, +$('supAngle').value);
  editSelected((x) => x.quaternion.premultiply(best.q));
  setStatus(`Otomatik yönlendirme: destek isteyen alan ≈ ${(best.over / 100).toFixed(1)} cm², tabla teması ≈ ${(best.contact / 100).toFixed(1)} cm²`);
};

// ---------- AMS slotları ----------
function updateSlotButtons() {
  const box = $('slotBtns');
  if (!box.children.length) {
    for (let i = 0; i < 4; i++) {
      const b = document.createElement('button');
      b.textContent = SLOT_NAMES[i];
      b.title = `AMS slot ${i + 1}`;
      b.onclick = () => {
        if (!selected.size) return;
        pushHistory();
        for (const o of selected) { setSlot(o, i); applyMaterial(o); }
        updateList(); updateSlotButtons(); updateEstimate(); requestRender();
      };
      box.appendChild(b);
    }
  }
  const cur = new Set([...selected].map((o) => o.userData.slot));
  [...box.children].forEach((b, i) => {
    b.style.background = slots[i];
    b.classList.toggle('on', cur.size === 1 && cur.has(i));
  });
  $('slotSection').classList.toggle('disabled', !selected.size);
}

function buildAmsPanel() {
  const box = $('amsSlots');
  box.innerHTML = '';
  slots.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'slot';
    row.innerHTML = `<b>Slot ${i + 1}</b><input type="color" value="${c}" /><small id="slotG${i}"></small>`;
    row.querySelector('input').addEventListener('input', (e) => {
      slots[i] = e.target.value;
      saveSlots(slots);
      for (const o of objects) if (o.userData.slot === i) { setSlot(o, i); applyMaterial(o); }
      updateList(); updateSlotButtons(); requestRender();
    });
    row.querySelector('input').addEventListener('change', updateEstimate);
    box.appendChild(row);
  });
}
function updateAmsLabels(ams) {
  slots.forEach((_, i) => {
    const el = $('slotG' + i);
    if (!el) return;
    const used = ams?.used.includes(i);
    el.textContent = used ? `${ams.perSlot[i].toFixed(1)} g` : '—';
  });
}

// ---------- Nesne işlemleri ----------
function duplicate() {
  if (!selected.size) return;
  pushHistory();
  const news = [];
  for (const o of selected) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', o.geometry.attributes.position.clone());
    g.computeVertexNormals(); g.computeBoundingBox();
    if (o.geometry.userData.csg) g.userData.csg = true;
    const m = createMesh(g, o.userData.name + ' kopya', o.userData.slot);
    m.userData.paint = { enf: o.userData.paint.enf.slice(), blk: o.userData.paint.blk.slice() };
    refreshPaintViz(m);
    m.position.copy(o.position); m.quaternion.copy(o.quaternion); m.scale.copy(o.scale);
    scene.add(m); objects.push(m);
    placeOnFreeSpot(m);
    news.push(m);
  }
  selected = new Set(news);
  attachGizmo();
  onModelChanged();
}
function deleteSelected() {
  if (!selected.size) return;
  pushHistory();
  [...selected].forEach(removeObject);
  selected = new Set();
  onModelChanged();
}
/**
 * Nesneleri dizer: MaxRects ile sıkı yerleştirir, gerekirse nesneyi Z ekseninde 90° çevirir;
 * tek tablaya sığmazsa sonraki plakalara dağıtır.
 */
function arrange() {
  if (!objects.length) return;
  pushHistory();
  objects.forEach(dropToBed);
  const gap = 6, M = 4;
  const boxes = objects.map((o) => worldBox(o));
  const spots = packRects(
    boxes.map((b) => ({ w: b.max.x - b.min.x, d: b.max.y - b.min.y })),
    BED.x - 2 * M, BED.y - 2 * M, { gap, rotate: true },
  );
  let oversized = 0;
  const placed = []; // { it, plate, x, y }
  objects.forEach((o, i) => {
    const s = spots[i];
    if (s.rot) o.rotateOnWorldAxis(AXES.z, Math.PI / 2);
    if (s.oversize) oversized++;
    placed.push({ it: { o, b: worldBox(o) }, plate: s.plate, x: s.oversize ? 0 : M + s.x, y: s.oversize ? 0 : M + s.y });
  });
  // Her plakanın içeriğini plakanın ortasına al
  const byPlate = new Map();
  for (const p of placed) {
    if (!byPlate.has(p.plate)) byPlate.set(p.plate, []);
    byPlate.get(p.plate).push(p);
  }
  for (const [k, list] of byPlate) {
    const box = new THREE.Box3();
    for (const p of list) {
      const w = p.it.b.max.x - p.it.b.min.x, d = p.it.b.max.y - p.it.b.min.y;
      box.expandByPoint(new THREE.Vector3(p.x, p.y, 0)); box.expandByPoint(new THREE.Vector3(p.x + w, p.y + d, 0));
    }
    const c = box.getCenter(new THREE.Vector3());
    const dx = BED.x / 2 - c.x, dy = BED.y / 2 - c.y;
    for (const p of list) {
      p.it.o.position.x += k * PLATE_STEP + p.x + dx - p.it.b.min.x;
      p.it.o.position.y += p.y + dy - p.it.b.min.y;
    }
  }
  onModelChanged();
  const n = byPlate.size;
  if (oversized) toast(`${oversized} nesne tabladan büyük; ölçekleyin ya da kesip parçalara bölün.`, true);
  else if (n > 1) toast(`Nesneler tek tablaya sığmadı: ${n} plakaya dağıtıldı.`);
  const rotated = spots.filter((s) => s.rot).length;
  setStatus((n > 1 ? `${objects.length} nesne ${n} plakaya dizildi. 3MF Kaydet her plaka için ayrı dosya verir.` : `${objects.length} nesne tablaya dizildi.`)
    + (rotated ? ` Yer kazanmak için ${rotated} nesne Z ekseninde 90° çevrildi (Geri al ile dönebilirsin).` : ''));
}
function merge() {
  if (selected.size < 2) { toast('Birleştirmek için Ctrl ile en az 2 nesne seçin.'); return; }
  pushHistory();
  const list = [...selected];
  const merged = mergeGeometries(list.map(worldGeometry), false);
  const slot = list[0].userData.slot;
  list.forEach(removeObject);
  const m = addObject(merged, 'Birleşik', slot);
  selected = new Set([m]);
  attachGizmo();
  onModelChanged();
  setStatus(`${list.length} nesne tek nesnede birleştirildi.`);
}
async function split() {
  const o = single();
  if (!o) { toast('Parçalamak için bir nesne seçin.'); return; }
  setStatus('Parçalar ayrıştırılıyor…');
  await nextFrame();
  const parts = splitComponents(worldGeometry(o));
  if (parts.length < 2) { toast('Bu nesne tek parça.'); setStatus('Hazır.'); return; }
  if (o.geometry.userData.csg) parts.forEach((g) => (g.userData.csg = true));
  if (parts.length > 100 && !confirm(`${parts.length} parça oluşacak. Devam edilsin mi?`)) return;
  pushHistory();
  removeObject(o);
  const news = parts.map((g, i) => addObject(g, `${o.userData.name} #${i + 1}`, o.userData.slot));
  selected = new Set(news);
  attachGizmo();
  onModelChanged({ drop: false });
  setStatus(`${parts.length} parçaya ayrıldı. Konumları korundu; "Diz" ile tablaya yayabilirsiniz.`);
}
$('btnDup').onclick = duplicate;
$('btnDel').onclick = deleteSelected;
$('btnArrange').onclick = arrange;
$('btnMerge').onclick = merge;
$('btnSplit').onclick = split;
$('btnUndo').onclick = undo;
$('btnRedo').onclick = redo;

// ---------- Kesme ----------
const cutPlaneMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({ color: 0xf2a33a, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false })
);
cutPlaneMesh.visible = false;
cutPlaneMesh.raycast = () => {};
scene.add(cutPlaneMesh);
const cutTarget = () => single() || (objects.length === 1 ? objects[0] : null);
let cutRange = [0, 1];

function updateCutRange() {
  const o = cutTarget();
  if (!o) { cutPlaneMesh.visible = false; return; }
  const ax = $('cutAxis').value;
  const b = worldBox(o);
  cutRange = [b.min[ax], b.max[ax]];
  let pos = parseFloat($('cutPos').value);
  if (!(pos > cutRange[0] && pos < cutRange[1])) pos = (cutRange[0] + cutRange[1]) / 2;
  setCutPos(pos);
}
function setCutPos(pos) {
  $('cutPos').value = pos.toFixed(1);
  $('cutSlider').value = ((pos - cutRange[0]) / (cutRange[1] - cutRange[0] || 1)) * 1000;
  const o = cutTarget();
  if (!o) return;
  const b = worldBox(o);
  const s = b.getSize(new THREE.Vector3()).addScalar(16);
  const c = b.getCenter(new THREE.Vector3());
  const ax = $('cutAxis').value;
  cutPlaneMesh.position.copy(c);
  cutPlaneMesh.position[ax] = pos;
  if (ax === 'z') { cutPlaneMesh.rotation.set(0, 0, 0); cutPlaneMesh.scale.set(s.x, s.y, 1); }
  if (ax === 'x') { cutPlaneMesh.rotation.set(0, Math.PI / 2, 0); cutPlaneMesh.scale.set(s.z, s.y, 1); }
  if (ax === 'y') { cutPlaneMesh.rotation.set(Math.PI / 2, 0, 0); cutPlaneMesh.scale.set(s.x, s.z, 1); }
  requestRender();
}
function showCutPlane() { if (cutTarget()) { cutPlaneMesh.visible = true; requestRender(); } }
$('cutAxis').addEventListener('change', () => { $('cutPos').value = ''; updateCutRange(); showCutPlane(); });
$('cutPos').addEventListener('change', () => { setCutPos(+$('cutPos').value); showCutPlane(); });
$('cutSlider').addEventListener('input', () => {
  setCutPos(cutRange[0] + ((cutRange[1] - cutRange[0]) * $('cutSlider').value) / 1000);
  showCutPlane();
});
$('btnCutPreview').onclick = () => {
  if (!cutTarget()) { toast('Önce bir nesne seçin.'); return; }
  cutPlaneMesh.visible = !cutPlaneMesh.visible;
  requestRender();
};
$('btnCut').onclick = async () => {
  const o = cutTarget();
  if (!o) { toast('Kesmek için bir nesne seçin.'); return; }
  const ax = $('cutAxis').value;
  const pos = +$('cutPos').value;
  if (!(pos > cutRange[0] + 0.05 && pos < cutRange[1] - 0.05)) { toast('Kesme düzlemi nesnenin içinden geçmiyor.', true); return; }
  setStatus('Kesiliyor…');
  await nextFrame();
  let lo, hi;
  try {
    [lo, hi] = cutGeometry(worldGeometry(o), ax, pos);
  } catch (err) {
    console.error(err);
    toast('Kesme başarısız. Model kapalı (su geçirmez) olmayabilir.', true);
    setStatus('Kesme başarısız.');
    return;
  }
  if (!lo || !hi) { toast('Kesme sonucu boş çıktı. Model kapalı olmayabilir.', true); setStatus('Hazır.'); return; }
  lo.userData.csg = true; hi.userData.csg = true;
  pushHistory();
  removeObject(o);
  const a = addObject(lo, o.userData.name + ' (A)', o.userData.slot);
  const b = addObject(hi, o.userData.name + ' (B)', o.userData.slot);
  if (ax === 'z' && $('cutFlip').checked) b.rotateOnWorldAxis(AXES.x, Math.PI);
  dropToBed(a); dropToBed(b);
  // Parçaları birbirinden ayır
  const ba = worldBox(a), bb = worldBox(b);
  const sepAx = ax === 'z' ? 'x' : ax;
  b.position[sepAx] += ba.max[sepAx] + 8 - bb.min[sepAx];
  cutPlaneMesh.visible = false;
  selected = new Set([a, b]);
  attachGizmo();
  onModelChanged();
  setStatus('Kesildi: iki parça oluştu. Kesik yüzler kapatıldı.');
};

// ---------- Katman önizleme ----------
function maxHeight() {
  let h = 0;
  for (const o of objects) h = Math.max(h, worldBox(o).max.z);
  return h;
}
function updateLayerInfo() {
  const v = +$('layerSlider').value;
  const H = maxHeight();
  const lh = parseFloat($('layerH').value);
  clipActive = v < 1000 && H > 0;
  clipPlane.constant = clipActive ? (H * v) / 1000 : 1e6;
  objects.forEach((o) => (o.userData.cap.visible = clipActive));
  $('layerInfo').textContent = clipActive
    ? `Z = ${clipPlane.constant.toFixed(2)} mm · Katman ${Math.max(1, Math.ceil(clipPlane.constant / lh))} / ${Math.ceil(H / lh)}`
    : 'Kaydırıcıyı sola çekerek modeli katman katman kesitte görün.';
  requestRender();
}
$('layerSlider').addEventListener('input', updateLayerInfo);

// ---------- Görünümler ----------
function sceneBox() {
  const b = new THREE.Box3();
  objects.forEach((o) => b.union(worldBox(o)));
  if (b.isEmpty()) b.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(BED.x, BED.y, 30));
  return b;
}
const VIEW_DIRS = {
  iso: new THREE.Vector3(0.8, -1, 0.9),
  top: new THREE.Vector3(0, -0.001, 1),
  front: new THREE.Vector3(0, -1, 0.05),
  right: new THREE.Vector3(1, 0, 0.05),
};
function setView(v) {
  const b = v === 'fit' ? sceneBox() : new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(beds.length * PLATE_STEP - 40, BED.y, 20)).union(sceneBox());
  const c = b.getCenter(new THREE.Vector3());
  const r = Math.max(b.getSize(new THREE.Vector3()).length() / 2, 20);
  const dist = (r / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * 0.95;
  const dir = v === 'fit' ? camera.position.clone().sub(controls.target) : VIEW_DIRS[v].clone();
  camera.position.copy(c).add(dir.normalize().multiplyScalar(dist));
  controls.target.copy(c);
  controls.update();
  requestRender();
}
document.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => setView(b.dataset.view)));

// ---------- Dosya açma / kaydetme ----------
async function openFiles(files) {
  const added = [];
  for (const f of files) {
    setStatus(`Yükleniyor: ${f.name}…`);
    await nextFrame();
    try {
      const t0 = performance.now();
      const geom = await loadFile(f);
      const name = f.name.replace(/\.[^.]+$/, '');
      pushHistory();
      const o = addObject(geom, name);
      placeOnFreeSpot(o);
      added.push(o);
      const s = worldBox(o).getSize(new THREE.Vector3());
      const mx = Math.max(s.x, s.y, s.z);
      if (mx < 5) toast(`${name}: çok küçük (${mx.toFixed(2)} mm). İnç veya metre olabilir — Boyut alanından ölçekleyin.`, true);
      else if (mx > 256) toast(`${name}: A1 tablasından büyük (${mx.toFixed(0)} mm). Ölçekleyin veya kesip parçalara bölün.`, true);
      setStatus(`${f.name} yüklendi (${(geom.attributes.position.count / 3).toLocaleString('tr-TR')} üçgen, ${Math.round(performance.now() - t0)} ms).`);
    } catch (err) {
      console.error(err);
      toast(`${f.name} açılamadı: ${err.message}`, true);
    }
  }
  if (!added.length) return;
  $('dropHint').style.display = 'none';
  selected = new Set([added[added.length - 1]]);
  attachGizmo();
  onModelChanged();
  setView('iso');
}
// Telefonda dosya seçici uzantıya göre süzünce .stl dosyalarını soluk gösterebiliyor: orada süzmeyi kapat
if (matchMedia('(pointer: coarse)').matches) $('fileInput').removeAttribute('accept');
$('btnOpen').onclick = () => $('fileInput').click();
$('fileInput').addEventListener('change', (e) => { openFiles([...e.target.files]); e.target.value = ''; });
window.addEventListener('dragover', (e) => { e.preventDefault(); viewportEl.classList.add('dragover'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) viewportEl.classList.remove('dragover'); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  viewportEl.classList.remove('dragover');
  const files = [...e.dataTransfer.files].filter((f) => /\.(stl|obj|3mf)$/i.test(f.name));
  if (files.length) openFiles(files); else toast('Sadece STL, OBJ ve 3MF dosyaları açılabilir.', true);
});

function exportSTL() {
  const list = selected.size ? [...selected] : objects;
  if (!list.length) { toast('Kaydedilecek nesne yok.'); return; }
  if (new Set(list.map(objPlate)).size > 1) { toast('Seçim birden çok plakaya yayılıyor; tek STL olmaz. 3MF Kaydet plaka başına dosya verir ya da tek plakadaki nesneleri seç.', true); return; }
  const k = objPlate(list[0]);
  const geoms = list.map((o) => { const g = worldGeometry(o); g.translate(-k * PLATE_STEP, 0, 0); return g; });
  const merged = geoms.length > 1 ? mergeGeometries(geoms, false) : geoms[0];
  const data = new STLExporter().parse(new THREE.Mesh(merged), { binary: true });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type: 'model/stl' }));
  a.download = (list.length === 1 ? list[0].userData.name : 'STLOgi_sahne') + '.stl';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  setStatus(`${list.length} nesne STL olarak kaydedildi (döndürme/ölçek uygulanmış halde).`);
}
$('btnExport').onclick = exportSTL;

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- 3MF (Bambu Studio'ya aktarım) ----------
$('btn3mf').onclick = () => {
  if (!objects.length) { toast('Kaydedilecek nesne yok.'); return; }
  const nPlates = plateCount();
  const base = objects.length === 1 ? objects[0].userData.name : 'STLOgi_sahne';
  let files = 0;
  // Her plaka ayrı bir 3MF olur (Bambu'da her biri kendi baskı plakasına açılır)
  for (let k = 0; k < nPlates; k++) {
    const list = objects.filter((o) => objPlate(o) === k);
    if (!list.length) continue;
    const data = build3MF(list.map((o) => ({
      mesh: o, name: o.userData.name, slot: o.userData.slot, color: o.userData.color, paint: worldPaint([o]), offsetX: k * PLATE_STEP,
    })));
    const name = nPlates > 1 ? `${base}_plaka${k + 1}.3mf` : `${base}.3mf`;
    setTimeout(() => download(new Blob([data], { type: 'model/3mf' }), name), files * 500); // tarayıcı çoklu indirmeyi engellemesin diye aralıklı
    files++;
  }
  const n = new Set(objects.map((o) => o.userData.slot)).size;
  const pt = objects.reduce((a, o) => a + o.userData.paint.enf.length + o.userData.paint.blk.length, 0);
  setStatus(`${objects.length} nesne ${files > 1 ? `${files} ayrı 3MF dosyası (plaka başına bir)` : '3MF'} olarak kaydedildi${n > 1 ? ` (${n} AMS slotu)` : ''}${pt ? ', boyanan destek bölgeleri dahil' : ''}. Bambu Studio'da açınca nesnelerin tablodaki yeri korunur.${files > 1 ? ' Tarayıcı çoklu indirme için izin sorarsa izin ver.' : ''}`);
};

// ---------- Elle destek boyama ----------
const dotTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.beginPath(); g.arc(32, 32, 30, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
  return new THREE.CanvasTexture(c);
})();
const CAM_K = 1 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)); // nokta boyutunu dünya mm'sine çevirir
const PAINT_COL = { enf: new THREE.Color(0xff4fd8), blk: new THREE.Color(0x00e5ff) };
const vizMat = new THREE.PointsMaterial({ size: 1, vertexColors: true, map: dotTex, alphaTest: 0.5, sizeAttenuation: true });
vizMat.onBeforeCompile = (sh) => {
  sh.vertexShader = 'attribute float aSize;\n' + sh.vertexShader.replace('gl_PointSize = size;', 'gl_PointSize = size * aSize;');
};
const avgScale = (o) => (Math.abs(o.scale.x) + Math.abs(o.scale.y) + Math.abs(o.scale.z)) / 3;

function refreshPaintViz(o) {
  const P = o.userData.paint;
  if (o.userData.viz) { scene.remove(o.userData.viz); o.userData.viz.geometry.dispose(); o.userData.viz = null; }
  const n = P.enf.length + P.blk.length;
  if (n) {
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), sz = new Float32Array(n);
    const s = avgScale(o);
    let i = 0;
    for (const [list, c] of [[P.enf, PAINT_COL.enf], [P.blk, PAINT_COL.blk]]) {
      for (const d of list) {
        pos[i * 3] = d[0]; pos[i * 3 + 1] = d[1]; pos[i * 3 + 2] = d[2];
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
        sz[i] = d[3] * s * 2 * CAM_K;
        i++;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
    const viz = new THREE.Points(g, vizMat);
    viz.matrixAutoUpdate = false;
    viz.frustumCulled = false;
    viz.raycast = () => {};
    viz.renderOrder = 5;
    scene.add(viz);
    o.userData.viz = viz;
  }
  const total = objects.reduce((a, x) => a + x.userData.paint.enf.length + x.userData.paint.blk.length, 0);
  $('paintInfo').textContent = total ? `${total} fırça izi` : '';
  requestRender();
}
function syncPaintViz() {
  for (const o of objects) {
    const v = o.userData.viz;
    if (!v) continue;
    o.updateMatrixWorld();
    v.matrix.copy(o.matrixWorld);
    v.matrixWorld.copy(o.matrixWorld);
  }
}
/** Tüm nesnelerin boyalarını dünya koordinatlarına çevirir (destek hesabı için). */
function worldPaint(list = objects) {
  const out = { enf: [], blk: [] };
  const v = new THREE.Vector3();
  for (const o of list) {
    o.updateMatrixWorld(true);
    const s = avgScale(o);
    for (const k of ['enf', 'blk']) {
      for (const d of o.userData.paint[k]) {
        v.set(d[0], d[1], d[2]).applyMatrix4(o.matrixWorld);
        out[k].push({ x: v.x, y: v.y, z: v.z, r: d[3] * s });
      }
    }
  }
  return out;
}
const paintState = { active: false, last: null, obj: null };
function paintAt(hit) {
  const o = hit.object;
  const P = o.userData.paint;
  const kind = document.querySelector('input[name=paintKind]:checked').value;
  const R = Math.max(1, +$('paintR').value || 4);
  if (paintState.obj === o && paintState.last && paintState.last.distanceToSquared(hit.point) < (R * 0.5) ** 2) return;
  paintState.last = hit.point.clone();
  paintState.obj = o;
  const n = hit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(o.matrixWorld)).normalize();
  const lp = o.worldToLocal(hit.point.clone().addScaledVector(n, 0.4));
  const s = avgScale(o);
  const other = kind === 'enf' ? 'blk' : 'enf';
  P[other] = P[other].filter((d) => Math.hypot(d[0] - lp.x, d[1] - lp.y, d[2] - lp.z) > (R / s) * 0.8);
  if (P[kind].length < 5000) P[kind].push([lp.x, lp.y, lp.z, R / s]);
  refreshPaintViz(o);
}
// OrbitControls'tan önce yakalamak için capture aşaması: modelin üstündeysek döndürme yerine boyarız
viewportEl.addEventListener('pointerdown', (e) => {
  if (mode !== 'paint' || e.button !== 0) return;
  const hit = pick(e);
  if (!hit) return;
  e.stopPropagation();
  pushHistory();
  controls.enabled = false;
  paintState.active = true; paintState.last = null; paintState.obj = null;
  paintAt(hit);
}, true);
window.addEventListener('pointermove', (e) => {
  if (!paintState.active) return;
  const hit = pick(e);
  if (hit) paintAt(hit);
});
window.addEventListener('pointerup', () => {
  if (!paintState.active) return;
  paintState.active = false;
  controls.enabled = true;
  scheduleSupports();
});
$('btnPaintOn').onclick = () => setMode(mode === 'paint' ? 'select' : 'paint');
$('btnPaintClear').onclick = () => {
  const list = selected.size ? [...selected] : objects;
  if (!list.some((o) => o.userData.paint.enf.length || o.userData.paint.blk.length)) { toast('Temizlenecek boyama yok.'); return; }
  pushHistory();
  for (const o of list) { o.userData.paint = { enf: [], blk: [] }; refreshPaintViz(o); }
  scheduleSupports();
};

// ---------- Delik ----------
async function makeHole(hit) {
  const o = hit.object;
  const d = +$('holeD').value || 4, depth = +$('holeDepth').value || 0;
  const n = hit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(o.matrixWorld)).normalize();
  setStatus('Delik açılıyor…');
  await nextFrame();
  let g = null;
  try { g = drillHole(worldGeometry(o), hit.point.clone(), n, d, depth); } catch (err) { console.error(err); }
  if (!g) { toast('Delik açılamadı. Model kapalı (su geçirmez) olmayabilir.', true); setStatus('Hazır.'); return; }
  g.userData.csg = true;
  pushHistory();
  const { name, slot } = o.userData;
  removeObject(o);
  const m = addObject(g, name, slot);
  selected = new Set([m]);
  attachGizmo();
  onModelChanged({ drop: false });
  setStatus(`${d} mm çapında ${depth > 0 ? depth + ' mm derinliğinde' : 'boydan boya'} delik açıldı.`);
}

// ---------- Şekil / yazı ekleme ----------
function addGeometry(geom, name) {
  pushHistory();
  const o = addObject(geom, name, 0);
  placeOnFreeSpot(o);
  selected = new Set([o]);
  attachGizmo();
  onModelChanged();
  $('dropHint').style.display = 'none';
  if (isOutOfBed(worldBox(o))) toast('Nesne tablaya sığmıyor.', true);
}
const PRIM_NAMES = { box: 'Küp', cylinder: 'Silindir', sphere: 'Küre', cone: 'Koni' };
document.querySelectorAll('[data-prim]').forEach((b) => (b.onclick = () => {
  addGeometry(makePrimitive(b.dataset.prim, Math.max(1, +$('primSize').value || 20)), PRIM_NAMES[b.dataset.prim]);
}));
for (const [k, f] of Object.entries(FONTS)) $('txtFont').add(new Option(f.label, k));
let pendingText = null; // "Modele kabart/oy" için tıklama bekleyen yazı ayarları
async function textOnSurface(hit) {
  const P = pendingText;
  if (!P) return;
  const o = hit.object;
  const n = hit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(o.matrixWorld)).normalize();
  setStatus(P.kind === 'emboss' ? 'Yazı modele kabartılıyor…' : 'Yazı modele oyuluyor…');
  await nextFrame();
  let g = null, overhang = 0;
  try {
    const margin = 0.6; // kabartmada yüzeyin içine gömülen, oymada dışarı taşan pay (yüzeye tam yapışsın)
    const tg = makeText({ text: P.text, font: P.font, heightMM: P.heightMM, thickness: P.thickness + margin, base: false });
    const tool = orientToSurface(tg, hit.point, n, P.kind === 'emboss' ? -margin : -P.thickness);
    overhang = textOverhang(o, tool.userData.surface);
    g = csgApply(worldGeometry(o), tool, P.kind === 'emboss' ? 'add' : 'sub');
  } catch (err) { console.error(err); }
  if (!g) { toast('Yazı uygulanamadı. Model kapalı (su geçirmez) olmayabilir.', true); setStatus('Hazır.'); return; }
  g.userData.csg = true;
  pushHistory();
  const { name, slot } = o.userData;
  removeObject(o);
  const m = addObject(g, name, slot);
  selected = new Set([m]);
  onModelChanged({ drop: false });
  setMode('select');
  setStatus(`"${P.text}" yazısı modele ${P.kind === 'emboss' ? `${P.thickness} mm kabartıldı` : `${P.thickness} mm derinliğe oyuldu`}.`);
  if (overhang > 0) {
    toast(`Yazının ${overhang} kenar noktası yüzeyin dışında ya da havada kalıyor. ${P.kind === 'emboss' ? 'Kabartma kenarlarda havada durabilir' : 'Oyma yüzeyden taşabilir'}; harf yüksekliğini küçültmeyi ya da daha düz bir yer seçmeyi dene (Geri al mümkün).`, true);
  }
}
/**
 * Yazının tabanındaki 9 örnek noktadan (köşeler, kenar ortaları, merkez) yüzeye ışın atar;
 * yüzeyin yazı düzleminden 1 mm'den fazla uzaktaysa ya da hiç yoksa o nokta "havada" sayılır.
 */
function textOverhang(o, s) {
  const rc = new THREE.Raycaster();
  rc.firstHitOnly = true;
  rc.far = 6;
  const back = s.normal.clone().negate();
  let bad = 0;
  for (const [fx, fy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) {
    const p = new THREE.Vector3(fx * s.hx, fy * s.hy, 0).applyMatrix4(s.matrix);
    rc.set(p.clone().addScaledVector(s.normal, 2), back);
    const h = rc.intersectObject(o, false)[0];
    if (!h || Math.abs(h.distance - 2) > 1) bad++;
  }
  return bad;
}
$('btnText').onclick = async () => {
  const text = $('txtVal').value.trim();
  if (!text) { toast('Önce bir yazı girin.'); return; }
  const target = $('txtTarget').value;
  if (target !== 'obj') {
    if (!objects.length) { toast('Önce yazının işleneceği bir model aç.', true); return; }
    pendingText = { text, font: $('txtFont').value, heightMM: +$('txtH').value || 10, thickness: +$('txtT').value || 1.6, kind: target };
    const p = pendingText;
    setMode('text');
    pendingText = p; // setMode sıfırlar; mod açıldıktan sonra geri koy
    return;
  }
  setStatus('Yazı oluşturuluyor…');
  await nextFrame();
  try {
    const g = makeText({
      text, font: $('txtFont').value, heightMM: +$('txtH').value || 10, thickness: +$('txtT').value || 1.6, base: $('txtBase').checked,
    });
    addGeometry(g, `Yazı: ${text.slice(0, 20)}`);
    setStatus('Yazı eklendi. Başka bir modelin üstüne koymak için Taşı/Boyut araçlarını, tek parça yapmak için Birleştir\'i kullan.');
  } catch (err) {
    console.error(err);
    toast(err.message, true);
    setStatus('Hazır.');
  }
};

// ---------- Baskı kontrolü ----------
let checkTimer, checkResults = [], checking = false;
function scheduleChecks() {
  checking = true;
  clearTimeout(checkTimer);
  checkTimer = setTimeout(runChecks, 500);
  renderChecks();
}
function runChecks() {
  checkResults = [];
  for (const o of objects) {
    const tris = (statsCache.get(o) || meshStats(o)).tris;
    if (tris > 600000) {
      checkResults.push({ level: 'warn', text: `${o.userData.name}: çok büyük model (${tris.toLocaleString('tr-TR')} üçgen); kontrol atlandı.` });
      continue;
    }
    try { checkResults.push(...describeChecks(o.userData.name, checkMesh(o))); } catch (err) { console.error(err); }
  }
  checking = false;
  renderChecks();
}
function renderChecks() {
  const el = $('checks');
  if (!objects.length) { el.textContent = '—'; return; }
  if (checking) { el.textContent = 'Kontrol ediliyor…'; return; }
  const list = checkResults.slice();
  for (const o of objects) if (o.userData.out) list.push({ level: 'bad', text: `${o.userData.name}: tabla dışına taşıyor (A1: 256×256×256 mm).` });
  if (lastAms && lastAms.used.length > 1) {
    const modelG = lastAms.perSlot.reduce((a, b) => a + b, 0);
    if (lastAms.wasteGrams > 10 && lastAms.wasteGrams > modelG * 0.5) {
      list.push({ level: 'warn', text: `Renk değişimi atığı (≈ ${lastAms.wasteGrams.toFixed(0)} g), modelin yarısından fazla. Aynı katmanda aynı rengi tutmak ya da renk sayısını azaltmak tasarrufu artırır.` });
    }
  }
  el.innerHTML = '';
  if (!list.length) list.push({ level: 'ok', text: 'Belirgin bir sorun bulunamadı. (Tablaya oturma, ince duvar, kapalı model, devrilme kontrol edildi.)' });
  for (const c of list) {
    const d = document.createElement('div');
    d.className = 'c ' + c.level;
    d.textContent = (c.level === 'bad' ? '⛔ ' : c.level === 'warn' ? '⚠ ' : '✔ ') + c.text;
    el.appendChild(d);
  }
}

// ---------- Kütüphane ----------
let currentLib = null; // kütüphaneden açılan kaydın bilgisi
const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
function captureThumb() {
  const keepPos = camera.position.clone(), keepTgt = controls.target.clone();
  camera.position.copy(controls.target).add(VIEW_DIRS.iso);
  setView('fit');
  const helper = tc.getHelper();
  const hv = helper.visible;
  helper.visible = false;
  syncPaintViz();
  renderer.render(scene, camera);
  const src = renderer.domElement;
  const c = document.createElement('canvas');
  c.width = 240; c.height = 150;
  const g = c.getContext('2d');
  g.fillStyle = '#1b1e23'; g.fillRect(0, 0, 240, 150);
  const sc = Math.min(240 / src.width, 150 / src.height);
  g.drawImage(src, (240 - src.width * sc) / 2, (150 - src.height * sc) / 2, src.width * sc, src.height * sc);
  const url = c.toDataURL('image/jpeg', 0.75);
  helper.visible = hv;
  camera.position.copy(keepPos);
  controls.target.copy(keepTgt);
  controls.update();
  requestRender();
  return url;
}
async function saveToLibrary() {
  if (!objects.length) { toast('Sahne boş; önce bir model aç.'); return; }
  const def = currentLib?.name || (objects.length === 1 ? objects[0].userData.name : `${objects[0].userData.name} +${objects.length - 1}`);
  const name = prompt('Kütüphanede görünecek ad:', def);
  if (!name) return;
  const sceneData = objects.map((o) => ({
    name: o.userData.name, slot: o.userData.slot,
    p: o.position.toArray(), q: o.quaternion.toArray(), s: o.scale.toArray(),
    csg: !!o.geometry.userData.csg,
    positions: new Float32Array(o.geometry.attributes.position.array),
  }));
  const size = sceneBox().getSize(new THREE.Vector3());
  try {
    const e = await lib.saveModel({
      id: currentLib && currentLib.name === name ? currentLib.id : undefined,
      name, thumb: captureThumb(), dims: [size.x, size.y, size.z].map((v) => +v.toFixed(1)), scene: sceneData,
    });
    currentLib = e;
    lib.requestPersist();
    renderLib();
    toast('Kütüphaneye kaydedildi.');
  } catch (err) {
    console.error(err);
    toast('Kaydedilemedi: ' + err.message, true);
  }
}
async function openFromLibrary(id) {
  const sc = await lib.loadScene(id);
  if (!sc) { toast('Bu kaydın modeli bulunamadı.', true); return; }
  if (objects.length && !confirm('Sahnedeki nesneler kütüphaneden açılanla değiştirilecek (Geri al ile dönebilirsin). Devam edilsin mi?')) return;
  pushHistory();
  [...objects].forEach(removeObject);
  for (const it of sc) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(it.positions), 3));
    g.computeVertexNormals();
    g.computeBoundingBox();
    if (it.csg) g.userData.csg = true;
    const m = createMesh(g, it.name, it.slot);
    m.position.fromArray(it.p); m.quaternion.fromArray(it.q); m.scale.fromArray(it.s);
    scene.add(m); objects.push(m);
  }
  currentLib = lib.listModels().find((x) => x.id === id) || null;
  selected = new Set();
  attachGizmo();
  onModelChanged({ drop: false });
  $('dropHint').style.display = 'none';
  setView('iso');
  $('libModal').hidden = true;
  setStatus(`Kütüphaneden açıldı: ${currentLib?.name || ''}`);
}
function renderLib() {
  const box = $('libList');
  const q = $('libSearch').value.trim().toLowerCase();
  const items = lib.listModels().filter((e) => !q || (e.name + ' ' + (e.note || '')).toLowerCase().includes(q));
  const prints = lib.listPrints();
  if (!items.length) {
    box.innerHTML = `<div class="note">${q ? 'Eşleşen model yok.' : 'Henüz kayıt yok. Bir model açıp “+ Sahneyi kaydet” ile ekle.'}</div>`;
    return;
  }
  box.innerHTML = '';
  for (const e of items) {
    const mine = prints.filter((p) => p.libId === e.id);
    const ok = mine.filter((p) => p.ok).length;
    const card = document.createElement('div');
    card.className = 'libcard';
    card.innerHTML = `
      <img alt="" src="${e.thumb || ''}" />
      <div class="nm" title="${esc(e.name)}">${esc(e.name)}</div>
      <div class="meta">${e.count} nesne · ${e.dims ? e.dims.map((v) => v.toFixed(0)).join('×') + ' mm' : ''} · ${new Date(e.updated).toLocaleDateString('tr-TR')}<br>
        ${mine.length ? `${mine.length} baskı kaydı (${ok} başarılı)${mine[0] ? ` · son: ${Math.round(mine[0].realSec / 60)} dk, ${mine[0].realGrams} g` : ''}` : 'Baskı kaydı yok'}</div>
      <textarea placeholder="Not (ör. PLA'da iyi çıktı, %110 büyüt)"></textarea>
      <div class="row"><button class="primary sm">Aç</button><button class="sm del">Sil</button></div>`;
    const ta = card.querySelector('textarea');
    ta.value = e.note || '';
    ta.addEventListener('change', () => lib.updateModel(e.id, { note: ta.value }));
    card.querySelector('.primary').onclick = () => openFromLibrary(e.id);
    card.querySelector('.del').onclick = async () => {
      if (!confirm(`“${e.name}” kütüphaneden silinsin mi? Bu geri alınamaz.`)) return;
      await lib.deleteModel(e.id);
      if (currentLib?.id === e.id) currentLib = null;
      renderLib(); renderPrints();
    };
    box.appendChild(card);
  }
}
$('btnLib').onclick = () => { renderLib(); $('libModal').hidden = false; };
$('libClose').onclick = () => { $('libModal').hidden = true; };
$('libModal').addEventListener('pointerdown', (e) => { if (e.target === $('libModal')) $('libModal').hidden = true; });
$('libSave').onclick = saveToLibrary;
$('libSearch').addEventListener('input', renderLib);

// ---------- Baskı kaydı / kalibrasyon ----------
function renderPrints() {
  const c = lib.calibration();
  $('calibInfo').textContent = c.time || c.grams
    ? `Öğrenilen katsayılar: süre ×${(c.time ?? 1).toFixed(2)} (${c.nTime} baskı), filament ×${(c.grams ?? 1).toFixed(2)} (${c.nGrams} baskı).`
    : 'Henüz kayıt yok; tahminler ham değerlerle gösteriliyor.';
  const ul = $('printList');
  ul.innerHTML = '';
  for (const p of lib.listPrints().slice(0, 8)) {
    const li = document.createElement('li');
    if (!p.ok) li.className = 'fail';
    const sp = document.createElement('span');
    sp.textContent = `${new Date(p.date).toLocaleDateString('tr-TR')} · ${p.name} · tahmin ${Math.round(p.estSec / 60)} dk/${p.estGrams.toFixed(0)} g → gerçek ${Math.round(p.realSec / 60)} dk/${p.realGrams} g${p.ok ? '' : ' (başarısız)'}`;
    sp.title = sp.textContent + (p.note ? ' — ' + p.note : '');
    const x = document.createElement('button');
    x.textContent = '✕';
    x.title = 'Kaydı sil';
    x.onclick = () => { lib.deletePrint(p.id); applyCalibration(); renderPrints(); renderLib(); };
    li.append(sp, x);
    ul.appendChild(li);
  }
}
function applyCalibration() {
  const c = lib.calibration();
  $('calib').value = (c.time ?? 1).toFixed(2);
  $('gcalib').value = (c.grams ?? 1).toFixed(2);
  updateEstimate();
}
$('btnPrint').onclick = () => {
  if (!objects.length) { toast('Önce modeli sahneye aç; kayıt, sahnenin tahminiyle eşlenir.', true); return; }
  const realMin = +$('prRealMin').value, realG = +$('prRealG').value;
  if (!(realMin > 0) || !(realG > 0)) { toast('Gerçek süre (dk) ve filament (g) girin.', true); return; }
  const raw = sceneEstimate(true);
  // Birden çok plaka varsa gerçek değer tek plakaya aittir; o plakanın tahminiyle eşle
  let pl = raw.plates.length > 1 ? parseInt(prompt(`Bu kayıt hangi plaka için? (1-${raw.plates.length})`, '1'), 10) - 1 : 0;
  if (!(pl >= 0 && raw.plates[pl])) { if (raw.plates.length > 1) { toast('Geçerli bir plaka numarası girin.', true); return; } pl = 0; }
  const rp = raw.plates[pl];
  const plObjs = objects.filter((o) => objPlate(o) === pl);
  lib.addPrint({
    name: plObjs.length === 1 ? plObjs[0].userData.name : `${plObjs[0].userData.name} +${plObjs.length - 1}`,
    libId: currentLib?.id || null,
    material: raw.p.material, layerH: raw.p.layerH,
    estSec: rp.e.sec, estGrams: rp.e.grams + rp.ams.wasteGrams,
    realSec: realMin * 60, realGrams: realG,
    ok: $('prOk').checked, note: $('prNote').value.trim(),
  });
  $('prRealMin').value = ''; $('prRealG').value = ''; $('prNote').value = '';
  applyCalibration();
  renderPrints();
  toast('Baskı kaydı eklendi; tahmin katsayıları güncellendi.');
};

// ---------- Klavye ----------
window.addEventListener('keydown', (e) => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  const k = e.key.toLowerCase();
  if (e.ctrlKey && k === 'z') { e.preventDefault(); undo(); return; }
  if (e.ctrlKey && k === 'y') { e.preventDefault(); redo(); return; }
  if (e.ctrlKey && k === 'd') { e.preventDefault(); duplicate(); return; }
  if (e.ctrlKey && k === 'o') { e.preventDefault(); $('fileInput').click(); return; }
  if (e.ctrlKey && k === 's') { e.preventDefault(); exportSTL(); return; }
  if (e.ctrlKey && k === 'a') { e.preventDefault(); selected = new Set(objects); select(null, true); return; }
  if (e.ctrlKey) return;
  const map = { w: 'translate', e: 'rotate', r: 'scale', f: 'layflat', m: 'measure', b: 'paint', h: 'hole' };
  if (map[k]) setMode(map[k]);
  else if (k === 'escape') { if (mode === 'measure') clearMeasures(); setMode('select'); }
  else if (k === 'delete') deleteSelected();
  else if (k === 'a') arrange();
  else if (['1', '2', '3', '4', '5'].includes(k)) setView(['iso', 'top', 'front', 'right', 'fit'][+k - 1]);
});

// ---------- Başlat ----------
loadSettings();
updateBeds();
buildAmsPanel();
updateSlotButtons();
renderPrints();
setMode('select');
updateFxNote();
updateEstimate();
syncRates();
setView('iso');
loop();
window.STLOgi = { objects, scene, statsCache }; // hata ayıklama için

// ---------- Masaüstü uygulaması: çift tıklamayla dosya açma ----------
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    if (!params.files?.length) return;
    const files = await Promise.all(params.files.map((h) => h.getFile()));
    openFiles(files);
  });
}
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Service worker kaydedilemedi', err));
}

// ---------- Telefon: yan paneller (çekmece) ve Paylaş → STLOgi ----------
const setDrawer = (side) => {
  document.body.classList.toggle('show-left', side === 'left' && !document.body.classList.contains('show-left'));
  document.body.classList.toggle('show-right', side === 'right' && !document.body.classList.contains('show-right'));
  if (side === 'left') document.body.classList.remove('show-right');
  if (side === 'right') document.body.classList.remove('show-left');
};
$('btnPanelL').onclick = () => setDrawer('left');
$('btnPanelR').onclick = () => setDrawer('right');
viewportEl.addEventListener('pointerdown', () => document.body.classList.remove('show-left', 'show-right'), true);

// Telefonda Dosyalar/İndirilenler → Paylaş → STLOgi: servis çalışanı dosyaları saklayıp ?shared=N ile açar
async function openSharedFiles() {
  const q = new URLSearchParams(location.search);
  if (!q.has('shared')) return;
  history.replaceState(null, '', location.pathname);
  try {
    const c = await caches.open('stlogi-share');
    const keys = await c.keys();
    const files = [];
    for (const k of keys) {
      const res = await c.match(k);
      const name = decodeURIComponent(new URL(k.url).pathname.split('/').pop());
      files.push(new File([await res.blob()], name));
      await c.delete(k);
    }
    if (files.length) openFiles(files);
    else toast('Paylaşılan dosya alınamadı.', true);
  } catch (err) {
    console.error(err);
    toast('Paylaşılan dosya açılamadı: ' + err.message, true);
  }
}
openSharedFiles();
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('btnInstall').hidden = false;
});
$('btnInstall').onclick = async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  installPrompt = null;
  $('btnInstall').hidden = true;
  if (outcome === 'accepted') toast('Yüklendi. Artık STL dosyasına sağ tık → Birlikte aç → STLOgi diyebilirsiniz.');
};
window.addEventListener('appinstalled', () => { $('btnInstall').hidden = true; });
