import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Herhangi bir geometriyi sadece position + normal içeren indekssiz hale getirir. */
export function normalizeGeometry(geom) {
  let g = geom.index ? geom.toNonIndexed() : geom.clone();
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position') g.deleteAttribute(name);
  }
  g.clearGroups();
  g.computeVertexNormals();
  return g;
}

/** Bir Object3D ağacındaki tüm meshleri dünya dönüşümüyle birlikte tek geometride birleştirir. */
function groupToGeometry(root) {
  root.updateMatrixWorld(true);
  const parts = [];
  root.traverse((o) => {
    if (o.isMesh && o.geometry) {
      const g = normalizeGeometry(o.geometry);
      g.applyMatrix4(o.matrixWorld);
      parts.push(g);
    }
  });
  if (!parts.length) throw new Error('Dosyada geometri bulunamadı');
  return parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
}

/** File nesnesini okur, BufferGeometry döner. */
export async function loadFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const buf = await file.arrayBuffer();
  if (ext === 'stl') {
    return normalizeGeometry(new STLLoader().parse(buf));
  }
  if (ext === 'obj') {
    const text = new TextDecoder().decode(buf);
    const root = new OBJLoader().parse(text);
    // OBJ genelde Y-yukarı; Z-yukarı sahneye çevir
    root.rotation.x = Math.PI / 2;
    return groupToGeometry(root);
  }
  if (ext === '3mf') {
    const root = new ThreeMFLoader().parse(buf);
    return groupToGeometry(root);
  }
  throw new Error(`Desteklenmeyen dosya türü: .${ext}`);
}
