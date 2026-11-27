import * as THREE from 'three';
import { Brush, Evaluator, INTERSECTION, SUBTRACTION, ADDITION } from 'three-bvh-csg';

/** Dünya koordinatlı iki geometriyi birleştirir ('add') ya da birinden diğerini çıkarır ('sub'). Sonuç boşsa null. */
export function csgApply(worldGeom, toolGeom, op) {
  const ev = new Evaluator();
  ev.attributes = ['position', 'normal'];
  ev.useGroups = false;
  const a = new Brush(worldGeom), b = new Brush(toolGeom);
  a.updateMatrixWorld(); b.updateMatrixWorld();
  const out = ev.evaluate(a, b, op === 'add' ? ADDITION : SUBTRACTION).geometry;
  if (!out.attributes.position || out.attributes.position.count < 9) return null;
  const clean = out.index ? out.toNonIndexed() : out;
  for (const k of Object.keys(clean.attributes)) if (k !== 'position') clean.deleteAttribute(k);
  clean.computeVertexNormals();
  return clean;
}

/**
 * Yüzeydeki bir noktadan içeri doğru silindirik delik açar.
 * point/normal: tıklanan nokta ve dış yüzey normali (dünya). depth ≤ 0 ise boydan boya.
 */
export function drillHole(worldGeom, point, normal, diameter, depth) {
  const ev = new Evaluator();
  ev.attributes = ['position', 'normal'];
  ev.useGroups = false;
  const target = new Brush(worldGeom);
  target.updateMatrixWorld();
  const bb = worldGeom.boundingBox || (worldGeom.computeBoundingBox(), worldGeom.boundingBox);
  const d = depth > 0 ? depth : bb.getSize(new THREE.Vector3()).length() + 2;
  const len = d + 1; // 1 mm dışarıdan başlar
  const g = new THREE.CylinderGeometry(diameter / 2, diameter / 2, len, 48).toNonIndexed();
  g.deleteAttribute('uv');
  const cutter = new Brush(g);
  const n = normal.clone().normalize();
  cutter.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
  cutter.position.copy(point).addScaledVector(n, 1 - len / 2);
  cutter.updateMatrixWorld();
  const out = ev.evaluate(target, cutter, SUBTRACTION).geometry;
  if (!out.attributes.position || out.attributes.position.count < 9) return null;
  const clean = out.index ? out.toNonIndexed() : out;
  for (const k of Object.keys(clean.attributes)) if (k !== 'position') clean.deleteAttribute(k);
  clean.computeVertexNormals();
  return clean;
}

/**
 * Dünya koordinatlarındaki geometriyi eksene dik bir düzlemle ikiye böler.
 * Dönüş: [altTaraf, üstTaraf] (boş taraf null olabilir).
 */
export function cutGeometry(worldGeom, axis, pos) {
  const ev = new Evaluator();
  ev.attributes = ['position', 'normal'];
  ev.useGroups = false;

  const target = new Brush(worldGeom);
  target.updateMatrixWorld();

  const bb = worldGeom.boundingBox || (worldGeom.computeBoundingBox(), worldGeom.boundingBox);
  const size = bb.getSize(new THREE.Vector3()).length() * 2 + 20;
  const center = bb.getCenter(new THREE.Vector3());
  const boxGeom = new THREE.BoxGeometry(size, size, size).toNonIndexed();
  boxGeom.deleteAttribute('uv');
  const box = new Brush(boxGeom);
  box.position.copy(center);
  box.position[axis] = pos + size / 2; // kutu düzlemin "+" tarafını kaplar
  box.updateMatrixWorld();

  const upper = ev.evaluate(target, box, INTERSECTION).geometry;
  const lower = ev.evaluate(target, box, SUBTRACTION).geometry;
  const clean = (g) => {
    if (!g.attributes.position || g.attributes.position.count < 9) return null;
    const out = g.index ? g.toNonIndexed() : g;
    for (const n of Object.keys(out.attributes)) if (n !== 'position') out.deleteAttribute(n);
    out.computeVertexNormals();
    return out;
  };
  return [clean(lower), clean(upper)];
}
