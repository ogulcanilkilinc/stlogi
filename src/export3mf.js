import * as THREE from 'three';
import { zipSync, strToU8 } from 'three/examples/jsm/libs/fflate.module.js';
import { worldGeometry } from './analysis.js';

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const hex = (c) => '#' + new THREE.Color(c).getHexString().toUpperCase() + 'FF';

/**
 * Elle boyanan destek bölgelerini üçgen bazında okunabilir hale getirir.
 * paint: { enf: [{x,y,z,r}], blk: [...] } dünya koordinatlarında. Dönen fonksiyon: üçgen no → 0 yok, 1 koy, 2 koyma.
 * Üçgenin merkezi bir boya izinin yarıçapı içindeyse boyalı sayılır (üçgenler bölünmez: büyük üçgenler tümüyle boyanır).
 * "Destek koyma" boyası, "destek koy"un üzerine geçer. Bambu/Prusa'nın paint_supports değerleri: 4 = koy, 8 = koyma.
 */
function makePaintLookup(paint, pos) {
  if (!paint || (!paint.enf.length && !paint.blk.length)) return null;
  const cell = Math.max(2, ...[...paint.enf, ...paint.blk].map((d) => d.r + 0.5));
  const grid = new Map();
  const key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (const [kind, list] of [[1, paint.enf], [2, paint.blk]]) {
    for (const d of list) {
      const k = key(d.x, d.y, d.z);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push({ ...d, kind });
    }
  }
  return (tri) => {
    const i = tri * 9;
    const cx = (pos[i] + pos[i + 3] + pos[i + 6]) / 3, cy = (pos[i + 1] + pos[i + 4] + pos[i + 7]) / 3, cz = (pos[i + 2] + pos[i + 5] + pos[i + 8]) / 3;
    const gx = Math.floor(cx / cell), gy = Math.floor(cy / cell), gz = Math.floor(cz / cell);
    let st = 0;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      for (const d of grid.get(`${gx + a},${gy + b},${gz + c}`) || []) {
        if (Math.hypot(cx - d.x, cy - d.y, cz - d.z) <= d.r + 0.5) st = d.kind === 2 ? 2 : Math.max(st, d.kind);
      }
    }
    return st;
  };
}

/**
 * Sahneyi 3MF dosyasına çevirir. Her nesne ayrı bir "object", tablodaki konumu build item dönüşümünde saklanır
 * (Bambu Studio açınca nesneler tablada aynı yerde durur).
 * Renk iki yolla yazılır: standart <basematerials> (renk önizlemesi) ve Bambu'nun
 * Metadata/model_settings.config dosyasındaki "extruder" alanı (AMS slot numarası, 1-4).
 * objs: [{ mesh, name, slot (0-3), color, paint? (dünya koordinatlı boya izleri), offsetX? (çoklu plaka: bu plakanın X kayması) }]
 */
export function build3MF(objs) {
  const colors = [];
  const matIndex = (c) => { const h = hex(c); let i = colors.indexOf(h); if (i < 0) { colors.push(h); i = colors.length - 1; } return i; };
  let resources = '';
  let build = '';
  let settings = '';
  objs.forEach((o, n) => {
    const id = n + 2; // 1 numaralı kaynak basematerials
    const g = worldGeometry(o.mesh);
    g.computeBoundingBox();
    const c = g.boundingBox.getCenter(new THREE.Vector3());
    const pos = g.attributes.position.array;
    const map = new Map();
    const verts = [];
    const tris = [];
    const paintState = makePaintLookup(o.paint, pos);
    const key = (x, y, z) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    for (let i = 0; i < pos.length; i += 9) {
      const t = [];
      for (let k = 0; k < 3; k++) {
        const x = pos[i + k * 3] - c.x, y = pos[i + k * 3 + 1] - c.y, z = pos[i + k * 3 + 2] - c.z;
        const kk = key(x, y, z);
        let v = map.get(kk);
        if (v === undefined) { v = verts.length / 3; map.set(kk, v); verts.push(+x.toFixed(4), +y.toFixed(4), +z.toFixed(4)); }
        t.push(v);
      }
      if (t[0] !== t[1] && t[1] !== t[2] && t[0] !== t[2]) { t.src = i / 9; tris.push(t); }
    }
    let vx = '';
    for (let i = 0; i < verts.length; i += 3) vx += `<vertex x="${verts[i]}" y="${verts[i + 1]}" z="${verts[i + 2]}"/>`;
    let tx = '';
    for (const t of tris) {
      const st = paintState ? paintState(t.src) : 0;
      tx += `<triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"${st ? ` paint_supports="${st === 2 ? '8' : '4'}"` : ''}/>`;
    }
    const pi = matIndex(o.color);
    resources += `<object id="${id}" name="${esc(o.name)}" type="model" pid="1" pindex="${pi}"><mesh><vertices>${vx}</vertices><triangles>${tx}</triangles></mesh></object>`;
    build += `<item objectid="${id}" transform="1 0 0 0 1 0 0 0 1 ${(c.x - (o.offsetX || 0)).toFixed(4)} ${c.y.toFixed(4)} ${c.z.toFixed(4)}"/>`;
    settings += `<object id="${id}"><metadata key="name" value="${esc(o.name)}"/><metadata key="extruder" value="${o.slot + 1}"/></object>`;
  });
  const base = colors.map((c) => `<base name="Renk" displaycolor="${c}"/>`).join('');
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Application">STLOgi</metadata>
<resources><basematerials id="1">${base}</basematerials>${resources}</resources>
<build>${build}</build></model>`;
  const files = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="config" ContentType="text/xml"/></Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`),
    '3D/3dmodel.model': strToU8(model),
    'Metadata/model_settings.config': strToU8(`<?xml version="1.0" encoding="UTF-8"?>\n<config>${settings}</config>`),
  };
  return zipSync(files, { level: 6 });
}
