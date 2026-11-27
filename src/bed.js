import * as THREE from 'three';

// Bambu Lab A1 baskı hacmi (mm)
export const BED = { x: 256, y: 256, z: 256 };

export function createBed() {
  const group = new THREE.Group();
  group.name = 'bed';

  // Plaka (PEI görünümü)
  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(BED.x, BED.y, 2),
    new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.9, metalness: 0.1 })
  );
  plate.position.set(BED.x / 2, BED.y / 2, -1.01);
  plate.receiveShadow = true;
  group.add(plate);

  // Izgara: her 10 mm ince, her 50 mm kalın çizgi
  const minor = [], major = [];
  for (let v = 0; v <= BED.x; v += 10) {
    const arr = v % 50 === 0 ? major : minor;
    arr.push(v, 0, 0, v, BED.y, 0, 0, v, 0, BED.x, v, 0);
  }
  for (const [pts, color] of [[minor, 0x3d424b], [major, 0x59606b]]) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color }));
    l.position.z = 0.02;
    group.add(l);
  }
  // Kenar çerçevesi
  const edge = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(BED.x, BED.y, BED.z)),
    new THREE.LineBasicMaterial({ color: 0x4a515c, transparent: true, opacity: 0.5 })
  );
  edge.position.set(BED.x / 2, BED.y / 2, BED.z / 2);
  group.add(edge);

  // Başlangıç noktası eksenleri (X kırmızı, Y yeşil)
  const axes = new THREE.AxesHelper(20);
  axes.position.z = 0.05;
  group.add(axes);

  return group;
}
