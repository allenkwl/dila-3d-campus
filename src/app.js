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
  const roofColor = new THREE.Color(b.roof).offsetHSL(0, -0.05, 0.06);
  const c = centroid(poly);
  const hip = b.roofType === 'hip';
  const roofH = hip ? Math.min(b.height * 0.35, 7) : 0;
  const wallTop = b.top - roofH;
  const wallColor = WALL.clone().multiplyScalar(0.96 + (id % 5) * 0.01);
  for (let i = 0; i < n; i++) {
    const [x1, z1] = poly[i], [x2, z2] = poly[(i + 1) % n];
    const a = [x1, b.base, z1], bb = [x2, b.base, z2], cc = [x2, wallTop, z2], d = [x1, wallTop, z1];
    // 牆腳略暗，模擬環境光遮蔽，讓建物立體一點
    const foot = wallColor.clone().multiplyScalar(0.7);
    for (const [p, col] of [[a, foot], [bb, foot], [cc, wallColor], [a, foot], [cc, wallColor], [d, wallColor]]) {
      wallPos.push(...p); wallCol.push(col.r, col.g, col.b);
    }
    wallOwner.push(id, id);
  }
  if (!hip) {
    const tris = THREE.ShapeUtils.triangulateShape(poly.map(([x, z]) => new THREE.Vector2(x, z)), []);
    for (const [i, j, k] of tris) pushTri(roofPos, roofCol, roofOwner, id, roofColor,
      [poly[i][0], b.top, poly[i][1]], [poly[j][0], b.top, poly[j][1]], [poly[k][0], b.top, poly[k][1]]);
  } else {
    // 簡化的廡殿頂：出簷 + 往中心收的斜面 + 頂部平脊
    const r = Math.max(...poly.map(([x, z]) => Math.hypot(x - c[0], z - c[1])));
    const eave = scaled(poly, 1 + 1.6 / r, c), inner = scaled(poly, 0.42, c);
    const dark = roofColor.clone().multiplyScalar(0.85);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const e1 = [eave[i][0], wallTop - 0.6, eave[i][1]], e2 = [eave[j][0], wallTop - 0.6, eave[j][1]];
      const t1 = [inner[i][0], b.top, inner[i][1]], t2 = [inner[j][0], b.top, inner[j][1]];
      pushTri(roofPos, roofCol, roofOwner, id, i % 2 ? roofColor : dark, e1, e2, t2);
      pushTri(roofPos, roofCol, roofOwner, id, i % 2 ? roofColor : dark, e1, t2, t1);
    }
    const tris = THREE.ShapeUtils.triangulateShape(inner.map(([x, z]) => new THREE.Vector2(x, z)), []);
    for (const [i, j, k] of tris) pushTri(roofPos, roofCol, roofOwner, id, roofColor,
      [inner[i][0], b.top, inner[i][1]], [inner[j][0], b.top, inner[j][1]], [inner[k][0], b.top, inner[k][1]]);
  }
});
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
function showCard(group, name, desc) {
  card.hidden = false;
  card.querySelector('.card-group').textContent = group;
  card.querySelector('h2').textContent = name;
  card.querySelector('.card-desc').textContent = desc;
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
  showCard(current.group, current.name, current.desc + (b ? `\n約 ${Math.round(b.height)} 公尺高（估計）` : ''));
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
  showCard('建物', b.name || '未命名建物', `約 ${Math.round(b.height)} 公尺高（估計）。OSM way ${b.id}`);
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
