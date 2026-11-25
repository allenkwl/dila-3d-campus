import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';

const GROUP_COLORS = { '文理學院': '#c0592b', '法鼓山園區': '#7a6a2f', '校門': '#3f6f8f' };
const WALL = new THREE.Color('#e4ddcf');
const $ = (s) => document.querySelector(s);

const data = await fetch('data/campus.json').then((r) => r.json());
const canvas = $('#scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const SKY = new THREE.Color('#cdd9e0');
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 1800, 4200);

const camera = new THREE.PerspectiveCamera(40, 1, 2, 8000);
const controls = new MapControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.maxPolarAngle = 1.32;
controls.minDistance = 25;
controls.maxDistance = 2600;
controls.screenSpacePanning = false;

// ---------- 光線 ----------
scene.add(new THREE.HemisphereLight('#eef4ff', '#5d5a45', 1.4));
const sun = new THREE.DirectionalLight('#fff3df', 2.2);
sun.position.set(-600, 900, 500);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -1100, right: 1100, top: 1100, bottom: -1100, near: 10, far: 3000 });
sun.shadow.bias = -0.0008;
sun.shadow.normalBias = 0.6;
scene.add(sun, sun.target);

// ---------- 地形 ----------
const G = data.grid;
const hAt = (c, r) => G.h[Math.min(G.nz - 1, Math.max(0, r)) * G.nx + Math.min(G.nx - 1, Math.max(0, c))] / 10;
function groundY(x, z) {
  const u = (x - G.x0) / G.step, v = (z - G.z0) / G.step;
  const c = Math.floor(u), r = Math.floor(v), fu = u - c, fv = v - r;
  return hAt(c, r) * (1 - fu) * (1 - fv) + hAt(c + 1, r) * fu * (1 - fv) + hAt(c, r + 1) * (1 - fu) * fv + hAt(c + 1, r + 1) * fu * fv;
}
const terrainGeo = (() => {
  const { nx, nz, step, x0, z0 } = G;
  const O = data.ortho;
  const pos = new Float32Array(nx * nz * 3), uv = new Float32Array(nx * nz * 2), col = new Float32Array(nx * nz * 3);
  const c1 = new THREE.Color('#7f9a5a'), c2 = new THREE.Color('#566f3d'), tmp = new THREE.Color();
  for (let r = 0; r < nz; r++) for (let c = 0; c < nx; c++) {
    const i = r * nx + c, x = x0 + c * step, z = z0 + r * step, y = hAt(c, r);
    pos.set([x, y, z], i * 3);
    uv.set([(x - O.x0) / (O.x1 - O.x0), 1 - (z - O.z0) / (O.z1 - O.z0)], i * 2);
    const slope = Math.min(1, Math.hypot(hAt(c + 1, r) - hAt(c - 1, r), hAt(c, r + 1) - hAt(c, r - 1)) / (4 * step));
    tmp.copy(c1).lerp(c2, slope);
    col.set([tmp.r, tmp.g, tmp.b], i * 3);
  }
  const idx = [];
  for (let r = 0; r < nz - 1; r++) for (let c = 0; c < nx - 1; c++) {
    const a = r * nx + c, b = a + 1, d = a + nx, e = d + 1;
    idx.push(a, d, b, b, d, e);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
})();
const orthoTex = await new THREE.TextureLoader().loadAsync('data/ortho.jpg');
orthoTex.colorSpace = THREE.SRGBColorSpace;
orthoTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
const photoMat = new THREE.MeshLambertMaterial({ map: orthoTex });
const plainMat = new THREE.MeshLambertMaterial({ vertexColors: true });
const terrain = new THREE.Mesh(terrainGeo, photoMat);
terrain.receiveShadow = true;
scene.add(terrain);

// ---------- 建物 ----------
const buildings = data.buildings;
const placeByOsm = new Map(data.places.filter((p) => p.osm).map((p) => [p.osm, p]));
const wallPos = [], wallCol = [], roofPos = [], roofCol = [], wallOwner = [], roofOwner = [];

function centroid(poly) {
  let x = 0, z = 0;
  for (const [px, pz] of poly) { x += px; z += pz; }
  return [x / poly.length, z / poly.length];
}
function scaled(poly, k, c) {
  return poly.map(([x, z]) => [c[0] + (x - c[0]) * k, c[1] + (z - c[1]) * k]);
}
function pushTri(arr, colArr, owner, id, color, ...pts) {
  for (const p of pts) { arr.push(...p); colArr.push(color.r, color.g, color.b); }
  owner.push(id);
}
buildings.forEach((b, id) => {
  const poly = b.poly, n = poly.length;
  // 屋頂色取自空拍（已含日照），渲染時再受光一次會偏亮，所以略壓暗補償
  const roofColor = new THREE.Color(b.roof).multiplyScalar(b.roofExact ? 1 : 0.78);
  b.peak = b.top;
  const c = centroid(poly);
  const wallTop = b.top;
  const tint = 0.95 + (id % 5) * 0.012;
  const wallColor = (b.wall ? new THREE.Color(b.wall) : WALL.clone()).multiplyScalar(tint);
  // 兩段式牆面：下段基座（如青灰石材），上段牆身
  const baseColor = b.base_ ? new THREE.Color(b.base_).multiplyScalar(tint) : wallColor;
  const baseTop = b.base_ ? Math.min(wallTop, b.top - b.height + b.baseH) : b.base;
  const bands = [[b.base, baseTop, baseColor.clone().multiplyScalar(0.72), baseColor], [baseTop, wallTop, wallColor, wallColor]];
  for (let i = 0; i < n; i++) {
    const [x1, z1] = poly[i], [x2, z2] = poly[(i + 1) % n];
    for (const [y0, y1, c0, c1] of bands) {
      if (y1 - y0 < 0.05) continue;
      const a = [x1, y0, z1], bb = [x2, y0, z2], cc = [x2, y1, z2], d = [x1, y1, z1];
      for (const [p, col] of [[a, c0], [bb, c0], [cc, c1], [a, c0], [cc, c1], [d, c1]]) {
        wallPos.push(...p); wallCol.push(col.r, col.g, col.b);
      }
      wallOwner.push(id, id);
    }
  }
  // 平頂（斜屋頂建物也鋪一層，補住拆矩形時漏掉的碎角）
  const flatColor = b.parts ? wallColor.clone().multiplyScalar(0.8) : roofColor;
  const tris = THREE.ShapeUtils.triangulateShape(poly.map(([x, z]) => new THREE.Vector2(x, z)), []);
  for (const [i, j, k] of tris) pushTri(roofPos, roofCol, roofOwner, id, flatColor,
    [poly[i][0], b.top, poly[i][1]], [poly[j][0], b.top, poly[j][1]], [poly[k][0], b.top, poly[k][1]]);
  if (!b.parts) {
    // 平屋頂女兒牆
    const inner = scaled(poly, 1 - 0.8 / Math.max(...poly.map(([x, z]) => Math.hypot(x - c[0], z - c[1]))), c);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const o1 = [poly[i][0], b.top + 1, poly[i][1]], o2 = [poly[j][0], b.top + 1, poly[j][1]];
      const i1 = [inner[i][0], b.top + 1, inner[i][1]], i2 = [inner[j][0], b.top + 1, inner[j][1]];
      pushTri(wallPos, wallCol, wallOwner, id, wallColor, [poly[i][0], b.top, poly[i][1]], [poly[j][0], b.top, poly[j][1]], o2);
      pushTri(wallPos, wallCol, wallOwner, id, wallColor, [poly[i][0], b.top, poly[i][1]], o2, o1);
      pushTri(wallPos, wallCol, wallOwner, id, wallColor, o1, o2, i2);
      pushTri(wallPos, wallCol, wallOwner, id, wallColor, o1, i2, i1);
    }
    return;
  }
  for (const p of b.parts) addHipRoof(b, p, id, roofColor, wallColor);
});

/** 在矩形 p 上蓋四坡（廡殿）屋頂；p.top 比建物簷口高時先補牆。 */
function addHipRoof(b, p, id, roofColor, wallColor) {
  const ca = Math.cos(p.ang), sa = Math.sin(p.ang);
  const at = (u, v, y) => [p.cx + u * ca - v * sa, y, p.cz + u * sa + v * ca];
  const hw = p.w / 2, hd = p.d / 2, o = b.overhang;
  if (p.top > b.top + 0.1) {
    const cs = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
    for (let i = 0; i < 4; i++) {
      const [u1, v1] = cs[i], [u2, v2] = cs[(i + 1) % 4];
      pushTri(wallPos, wallCol, wallOwner, id, wallColor, at(u1, v1, b.top), at(u2, v2, b.top), at(u2, v2, p.top));
      pushTri(wallPos, wallCol, wallOwner, id, wallColor, at(u1, v1, b.top), at(u2, v2, p.top), at(u1, v1, p.top));
    }
  }
  const rise = Math.min(b.pitch * (hd + o), 8);
  const ey = p.top - 0.15 * o * b.pitch * 2;   // 出簷略往下垂
  const ry = p.top + rise;
  b.peak = Math.max(b.peak ?? 0, ry);
  const ridge = Math.max(0, hw - hd);
  const E = [at(-hw - o, -hd - o, ey), at(hw + o, -hd - o, ey), at(hw + o, hd + o, ey), at(-hw - o, hd + o, ey)];
  const R1 = at(-ridge, 0, ry), R2 = at(ridge, 0, ry);
  const light = roofColor, shade = roofColor.clone().multiplyScalar(0.82);
  pushTri(roofPos, roofCol, roofOwner, id, light, E[0], E[1], R2);   // 長邊
  pushTri(roofPos, roofCol, roofOwner, id, light, E[0], R2, R1);
  pushTri(roofPos, roofCol, roofOwner, id, light, E[2], E[3], R1);
  pushTri(roofPos, roofCol, roofOwner, id, light, E[2], R1, R2);
  pushTri(roofPos, roofCol, roofOwner, id, shade, E[1], E[2], R2);   // 兩端三角
  pushTri(roofPos, roofCol, roofOwner, id, shade, E[3], E[0], R1);
  // 重簷：在屋頂中段再疊一圈短牆和較小的屋頂
  if (p.tiers > 1) {
    const q = { cx: p.cx, cz: p.cz, ang: p.ang, w: p.w * 0.62, d: p.d * 0.62, top: p.top + rise * 0.45 + 2.2, tiers: p.tiers - 1 };
    const sub = { ...b, top: p.top + rise * 0.45, overhang: o * 0.8 };
    addHipRoof(sub, q, id, roofColor, wallColor);
    b.peak = Math.max(b.peak, sub.peak ?? 0);
  }
  // 簷下底面
  const soffit = wallColor.clone().multiplyScalar(0.55);
  pushTri(roofPos, roofCol, roofOwner, id, soffit, E[0], E[2], E[1]);
  pushTri(roofPos, roofCol, roofOwner, id, soffit, E[0], E[3], E[2]);
}
function meshFrom(pos, col) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  m.castShadow = m.receiveShadow = true;
  scene.add(m);
  return m;
}
// ---------- 特殊造型：圓塔、鐘亭 ----------
const extraGroup = new THREE.Group();
scene.add(extraGroup);
const lam = (c) => new THREE.MeshLambertMaterial({ color: c });
function shadowed(m) { m.castShadow = m.receiveShadow = true; return m; }
for (const x of data.extras || []) {
  if (x.type === 'tower') {
    const base = x.y - 3;
    const body = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(x.r, x.r, x.h + 3, 40), lam(x.color)));
    body.position.set(x.x, base + (x.h + 3) / 2, x.z);
    // 頂部挑簷環＋圓頂
    const ring = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(x.r + 0.9, x.r + 0.9, 0.8, 40), lam(x.color)));
    ring.position.set(x.x, base + x.h + 3, x.z);
    const dome = shadowed(new THREE.Mesh(new THREE.SphereGeometry(x.r * 0.82, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2), lam(x.roof)));
    dome.position.set(x.x, base + x.h + 3.4, x.z);
    extraGroup.add(body, ring, dome);
  } else if (x.type === 'pavilion') {
    // 四面開敞的亭：角柱＋陡的攢尖頂（重簷）
    const g = new THREE.Group();
    g.position.set(x.x, x.y, x.z);
    g.rotation.y = -(x.ang || 0);
    const colMat = lam(x.col);
    for (const sx of [-1, -1 / 3, 1 / 3, 1]) for (const sz of [-1, -1 / 3, 1 / 3, 1]) {
      if (Math.abs(sx) !== 1 && Math.abs(sz) !== 1) continue;
      const col = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.7, x.colH, 0.7), colMat));
      col.position.set(sx * (x.w / 2 - 0.5), x.colH / 2, sz * (x.d / 2 - 0.5));
      g.add(col);
    }
    const bell = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.32, 4.5, 24), lam('#3f4a45')));
    bell.position.set(0, x.colH - 2.6, 0);
    const beam = shadowed(new THREE.Mesh(new THREE.BoxGeometry(x.w, 0.8, x.d), lam(x.col)));
    beam.position.y = x.colH + 0.4;
    g.add(bell, beam);
    const roofMat = lam(x.roof);
    const pyramid = (half, rise, y) => {
      const m = shadowed(new THREE.Mesh(new THREE.ConeGeometry(half * Math.SQRT2, rise, 4, 1), roofMat));
      m.rotation.y = Math.PI / 4;
      m.position.y = y + rise / 2;
      return m;
    };
    g.add(pyramid(x.w / 2 + 2.4, 3.2, x.colH + 0.8));              // 下層簷
    const box = shadowed(new THREE.Mesh(new THREE.BoxGeometry(x.w * 0.6, 1.6, x.d * 0.6), lam(x.col)));
    box.position.y = x.colH + 3.2;
    g.add(box, pyramid(x.w * 0.42 + 1.4, 6.5, x.colH + 3.9));     // 上層攢尖
    extraGroup.add(g);
  }
}

const wallMesh = meshFrom(wallPos, wallCol);
const roofMesh = meshFrom(roofPos, roofCol);
wallMesh.userData.owner = wallOwner;
roofMesh.userData.owner = roofOwner;

// ---------- 樹木 ----------
const treeGeo = new THREE.IcosahedronGeometry(1, 0);
const treeMesh = new THREE.InstancedMesh(treeGeo, new THREE.MeshLambertMaterial({ flatShading: true }), data.trees.length);
{
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color(), e = new THREE.Euler();
  data.trees.forEach(([x, y, z, s, r, g, b], i) => {
    e.set(0, (i * 2.399) % 6.283, 0);
    q.setFromEuler(e);
    m.compose(new THREE.Vector3(x, y + 2.6 * s, z), q, new THREE.Vector3(3.6 * s, 3.4 * s, 3.6 * s));
    treeMesh.setMatrixAt(i, m);
    col.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace).offsetHSL(0, 0.05, 0.05);
    treeMesh.setColorAt(i, col);
  });
}
treeMesh.castShadow = true;
treeMesh.receiveShadow = true;
scene.add(treeMesh);

// ---------- 選取外框 ----------
const highlight = new THREE.LineSegments(new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: '#ff8a2a', depthTest: false, transparent: true }));
highlight.renderOrder = 10;
scene.add(highlight);
function setHighlight(b) {
  if (!b) { highlight.visible = false; return; }
  const pts = [], n = b.poly.length;
  for (let i = 0; i < n; i++) {
    const [x1, z1] = b.poly[i], [x2, z2] = b.poly[(i + 1) % n];
    pts.push(x1, b.top, z1, x2, b.top, z2, x1, b.base + 1.5, z1, x2, b.base + 1.5, z2, x1, b.base + 1.5, z1, x1, b.top, z1);
  }
  highlight.geometry.dispose();
  highlight.geometry = new THREE.BufferGeometry();
  highlight.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  highlight.visible = true;
}

// ---------- 地標標籤與列表 ----------
const labelsEl = $('#labels');
const places = data.places.map((p) => {
  const el = document.createElement('div');
  el.className = 'lbl';
  el.textContent = p.name;
  el.style.setProperty('--dot', GROUP_COLORS[p.group] || '#888');
  el.addEventListener('click', (ev) => { ev.stopPropagation(); select(p.id); });
  labelsEl.append(el);
  return { ...p, el, pos: new THREE.Vector3(p.x, p.y + 2, p.z) };
});
const listEl = $('#list');
for (const group of Object.keys(GROUP_COLORS)) {
  const items = places.filter((p) => p.group === group);
  if (!items.length) continue;
  const h = document.createElement('h3');
  h.innerHTML = `<i style="background:${GROUP_COLORS[group]}"></i>${group}`;
  listEl.append(h);
  for (const p of items) {
    const btn = document.createElement('button');
    btn.textContent = p.name;
    btn.addEventListener('click', () => select(p.id));
    p.btn = btn;
    listEl.append(btn);
  }
}

const card = $('#card');
function showCard(group, name, desc, source) {
  card.hidden = false;
  card.querySelector('.card-group').textContent = group;
  card.querySelector('h2').textContent = name;
  card.querySelector('.card-desc').textContent = desc;
  const a = card.querySelector('.card-src');
  a.hidden = !source;
  if (source) a.href = source;
}
$('#card-close').addEventListener('click', () => select(null));

let current = null;
function select(id, { fly = true } = {}) {
  current = places.find((p) => p.id === id) || null;
  for (const p of places) { p.el.classList.toggle('active', p === current); p.btn?.classList.toggle('active', p === current); }
  const url = new URL(location.href);
  if (current) url.searchParams.set('place', current.id); else url.searchParams.delete('place');
  history.replaceState(null, '', url);
  if (!current) { card.hidden = true; setHighlight(null); return; }
  const b = current.osm ? buildings.find((x) => x.id === current.osm) : null;
  setHighlight(b);
  const h = b ? Math.round(b.peak - b.top + b.height) : 0;
  // 平台類（如鐘樓石台）高度沒意義，不顯示
  showCard(current.group, current.name, current.desc + (h >= 3 ? `\n高約 ${h} 公尺（估計）` : ''), current.source);
  current.btn?.scrollIntoView({ block: 'nearest' });
  if (fly) flyTo(new THREE.Vector3(current.x, b ? (b.base + b.top) / 2 : current.y - 4, current.z), b ? 300 : 240, 0.9);
}

// ---------- 鏡頭 ----------
let anim = null;
function flyTo(target, dist, polar = 0.95, azimuth = null) {
  const off = camera.position.clone().sub(controls.target);
  const sph = new THREE.Spherical().setFromVector3(off);
  sph.radius = dist; sph.phi = polar;
  if (azimuth !== null) sph.theta = azimuth;
  const endPos = target.clone().add(new THREE.Vector3().setFromSpherical(sph));
  anim = { t0: performance.now(), fromPos: camera.position.clone(), fromTgt: controls.target.clone(), toPos: endPos, toTgt: target.clone() };
}
const HOME = { target: new THREE.Vector3(-70, groundY(-70, -20), -20), dist: 1450, polar: 0.8, azimuth: 0.45 };
function goHome(instant = false) {
  if (instant) {
    controls.target.copy(HOME.target);
    camera.position.copy(HOME.target).add(new THREE.Vector3().setFromSpherical(new THREE.Spherical(HOME.dist, HOME.polar, HOME.azimuth)));
  } else flyTo(HOME.target, HOME.dist, HOME.polar, HOME.azimuth);
}
goHome(true);
$('#btn-reset').addEventListener('click', () => { select(null, { fly: false }); goHome(); });
$('#btn-panel').addEventListener('click', () => { $('#app').classList.toggle('panel-hidden'); resize(); });
$('#btn-fs').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen(); else $('#app').requestFullscreen?.();
});
$('#opt-photo').addEventListener('change', (e) => { terrain.material = e.target.checked ? photoMat : plainMat; });
$('#opt-trees').addEventListener('change', (e) => { treeMesh.visible = e.target.checked; });
$('#opt-labels').addEventListener('change', (e) => { labelsEl.style.display = e.target.checked ? '' : 'none'; });

// ---------- 點選建物 ----------
const ray = new THREE.Raycaster();
let down = null;
canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
  const r = canvas.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = ray.intersectObjects([wallMesh, roofMesh, terrain], false)[0];
  if (!hit || hit.object === terrain) { select(null); return; }
  const b = buildings[hit.object.userData.owner[hit.faceIndex]];
  const p = placeByOsm.get(b.id);
  if (p) { select(p.id); return; }
  select(null);
  setHighlight(b);
  showCard('建物', b.name || '未命名建物', `高約 ${Math.round(b.peak - b.top + b.height)} 公尺（估計）。OSM way ${b.id}`);
});

// ---------- 迴圈 ----------
function resize() {
  const { clientWidth: w, clientHeight: h } = canvas.parentElement;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas.parentElement);
resize();

const v = new THREE.Vector3();
function updateLabels() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  // 由近到遠擺放（選取中的優先），和已擺好的標籤重疊就先藏起來
  const shown = [];
  const cand = places.map((p) => {
    v.copy(p.pos).project(camera);
    return { p, x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, z: v.z, ok: v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1 };
  }).sort((a, b) => (b.p === current) - (a.p === current) || a.z - b.z);
  for (const c of cand) {
    const bw = c.p.el.offsetWidth || c.p.name.length * 13 + 28, bh = 24;
    const r = { l: c.x - bw / 2, r: c.x + bw / 2, t: c.y - bh - 6, b: c.y - 6 };
    const vis = c.ok && !shown.some((s) => r.l < s.r + 2 && r.r > s.l - 2 && r.t < s.b + 2 && r.b > s.t - 2);
    c.p.el.style.display = vis ? '' : 'none';
    if (!vis) continue;
    shown.push(r);
    c.p.el.style.transform = `translate(${c.x}px, ${c.y}px) translate(-50%, -100%) translateY(-6px)`;
    c.p.el.style.zIndex = String(Math.round((1 - c.z) * 100000));
  }
}
function tick(now) {
  if (anim) {
    const t = Math.min(1, (now - anim.t0) / 1100), k = t * t * (3 - 2 * t);
    camera.position.lerpVectors(anim.fromPos, anim.toPos, k);
    controls.target.lerpVectors(anim.fromTgt, anim.toTgt, k);
    if (t === 1) anim = null;
  }
  controls.update();
  renderer.render(scene, camera);
  updateLabels();
  requestAnimationFrame(tick);
}
controls.addEventListener('start', () => { anim = null; });
$('#loading').remove();
requestAnimationFrame(tick);

const initial = new URLSearchParams(location.search).get('place');
if (initial) select(initial);
window.__campus = { scene, camera, controls, select, places };
