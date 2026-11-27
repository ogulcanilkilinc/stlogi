import * as THREE from 'three';

/**
 * Test aracı: destek parçalarının model içinden geçip geçmediğini ölçer.
 * Her parça ~1 mm aralıkla örneklenir; eksen noktası ve (varsa) dalın yarıçapının %90'u kadar
 * yandaki 4 nokta için, noktanın katı içinde olup olmadığı yukarı atılan ışının kestiği
 * yüzey sayısının tek olmasıyla bulunur.
 */
export function countSupportsInside(meshes, segments) {
  const ray = new THREE.Raycaster();
  const up = new THREE.Vector3(0, 0, 1);
  const sides = meshes.map((m) => m.material.side);
  meshes.forEach((m) => (m.material.side = THREE.DoubleSide));
  const p = new THREE.Vector3();
  const q = new THREE.Vector3();
  let bad = 0;
  const examples = [];
  // Yukarı giden ışının çarptığı ilk yüzey yukarı bakıyorsa (yani ışın yüzeyi arkadan, içeriden kesiyorsa)
  // nokta katının içindedir. Üst üste binen kabuklu / kapalı olmayan modellerde çarpma sayısına
  // bakmaktan daha güvenilir.
  const nm = new THREE.Matrix3();
  const nw = new THREE.Vector3();
  ray.firstHitOnly = true;
  const insideSolid = (pt) => {
    ray.set(pt, up);
    const h = ray.intersectObjects(meshes, false)[0];
    if (!h) return false;
    nm.getNormalMatrix(h.object.matrixWorld);
    nw.copy(h.face.normal).applyMatrix3(nm).normalize();
    return nw.z > 0 && h.distance > 0.01;
  };
  for (const s of segments) {
    const len = s.a.distanceTo(s.b);
    const r = (s.r ?? 0) * 0.9;
    const offs = r > 0.2 ? [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]] : [[0, 0]];
    let hit = false;
    for (let d = 0.5; d < len - 0.5 && !hit; d += 1) {
      p.copy(s.a).lerp(s.b, d / len);
      for (const [ox, oy] of offs) {
        q.set(p.x + ox, p.y + oy, p.z);
        if (insideSolid(q)) { hit = true; q.d = d; break; }
      }
    }
    if (hit) { bad++; if (examples.length < 5) examples.push(Object.assign(q.clone(), { d: q.d, len })); }
  }
  meshes.forEach((m, i) => (m.material.side = sides[i]));
  return { total: segments.length, inside: bad, examples };
}

/** Eski tip (dikey sütun) destek verisini parça listesine çevirir. */
export function columnsToSegments(columns) {
  return columns.map((c) => ({ a: new THREE.Vector3(c.x, c.y, c.top - 0.2), b: new THREE.Vector3(c.x, c.y, c.bot + 0.05) }));
}
