import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';

const GROUP_COLORS = { '文理學院': '#c0592b', '法鼓山園區': '#7a6a2f', '校門': '#3f6f8f' };
const WALL = new THREE.Color('#e4ddcf');
const GREEN_ROOF = new THREE.Color('#7f9b5c');
const $ = (s) => document.querySelector(s);

// 版本號取自 index.html 的 app.js?v=…，資料檔一起帶上，避免瀏覽器用到舊快取
const V = new URL(import.meta.url).searchParams.get('v') || '';
const withV = (u) => (V ? `${u}?v=${V}` : u);
const getJSON = (u) => fetch(withV(u)).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
const [data, details, photos] = await Promise.all([getJSON('data/campus.json'), getJSON('data/details.json'), getJSON('data/photos.json')]);
const canvas = $('#scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const SKY = new THREE.Color('#cdd9e0');
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 2200, 5200);

const camera = new THREE.PerspectiveCamera(40, 1, 2, 8000);
const controls = new MapControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.maxPolarAngle = 1.32;
controls.minDistance = 25;
controls.maxDistance = 1900;
controls.screenSpacePanning = false;

// ---------- 光線 ----------
const hemi = new THREE.HemisphereLight('#eef4ff', '#5d5a45', 1.4);
scene.add(hemi);
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
const orthoTex = await new THREE.TextureLoader().loadAsync(withV('data/ortho.jpg'));
orthoTex.colorSpace = THREE.SRGBColorSpace;
orthoTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
const photoMat = new THREE.MeshLambertMaterial({ map: orthoTex });
const plainMat = new THREE.MeshLambertMaterial({ vertexColors: true });
const terrain = new THREE.Mesh(terrainGeo, photoMat);
terrain.receiveShadow = true;
scene.add(terrain);

// ---------- 外圍地形：低解析度，讓地圖邊緣不入鏡；和內圈重疊的部分挖空 ----------
const outerMesh = await (async () => {
  const O = data.outer;
  if (!O) return null;
  const { nx, nz, step, x0, z0 } = O;
  const pos = new Float32Array(nx * nz * 3), uv = new Float32Array(nx * nz * 2);
  for (let r = 0; r < nz; r++) for (let c = 0; c < nx; c++) {
    const i = r * nx + c, x = x0 + c * step, z = z0 + r * step;
    pos.set([x, O.h[i], z], i * 3);
    uv.set([(x - O.x0) / (O.x1 - O.x0), 1 - (z - O.z0) / (O.z1 - O.z0)], i * 2);
  }
  const ix0 = G.x0 + step, iz0 = G.z0 + step, ix1 = G.x0 + (G.nx - 1) * G.step - step, iz1 = G.z0 + (G.nz - 1) * G.step - step;
  const inside = (c, r) => { const x = x0 + c * step, z = z0 + r * step; return x > ix0 && x < ix1 && z > iz0 && z < iz1; };
  const idx = [];
  for (let r = 0; r < nz - 1; r++) for (let c = 0; c < nx - 1; c++) {
    if (inside(c, r) && inside(c + 1, r) && inside(c, r + 1) && inside(c + 1, r + 1)) continue;
    const a = r * nx + c, b = a + 1, d = a + nx, e = d + 1;
    idx.push(a, d, b, b, d, e);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const tex = await new THREE.TextureLoader().loadAsync(withV('data/ortho_outer.jpg'));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  // polygonOffset 把外圈稍微往後推，避免和內圈交界處閃爍
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: tex, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }));
  m.receiveShadow = true;
  scene.add(m);
  return m;
})();

// ---------- 建物 ----------
// ---------- 立面貼圖（程式產生；一格 = 寬 4 公尺 × 一層樓） ----------
const FACADE_W = 4;
function facadeTexture(kind) {
  const S = 256, cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const rect = (c, x, y, w, h) => { g.fillStyle = c; g.fillRect(x, y, w, h); };
  rect('#ffffff', 0, 0, S, S);
  const GLASS = '#4b545b', DARK = '#3a4146';
  if (kind === 'ribbon') {            // 清水模＋水平帶狀窗（綜合大樓）
    rect('#f3f3f1', 0, 0, S, 34);                 // 樓板
    rect(GLASS, 0, 70, S, 130);                   // 帶狀窗
    for (let x = 0; x < S; x += 64) rect('#d9dcdc', x, 70, 5, 130);
    rect('#c9c9c6', 0, 200, S, 6);
  } else if (kind === 'fins') {       // 直向格柵
    rect(DARK, 0, 40, S, 216);
    for (let x = 4; x < S; x += 32) rect('#f1f1ee', x, 40, 12, 216);
    rect('#f3f3f1', 0, 0, S, 40);
  } else if (kind === 'gridwood') {   // 白牆＋窗格＋木欄杆（禪悅書苑）
    rect(GLASS, 60, 40, 136, 170);
    rect('#8d4b32', 60, 150, 136, 40);            // 木質欄杆
    for (let x = 64; x < 196; x += 14) rect('#a96244', x, 150, 6, 40);
    rect('#e4e2dc', 18, 20, 14, 236); rect('#e4e2dc', 224, 20, 14, 236);  // 直向鰭片
  } else if (kind === 'brick') {      // 磚牆＋方窗（園區）
    for (let y = 0; y < S; y += 16) rect('#ececec', 0, y, S, 2);
    for (const x of [36, 150]) { rect('#f6f6f4', x - 6, 66, 82, 128); rect(DARK, x, 72, 70, 116); rect('#7d8388', x, 126, 70, 4); }
  } else if (kind === 'gym') {        // 上段清水模實牆、下段玻璃（揚生館）
    for (let x = 0; x < S; x += 64) rect('#e9e9e6', x, 0, 3, 200);
    rect('#e9e9e6', 0, 100, S, 3);
    rect(GLASS, 0, 206, S, 50);                   // 一樓玻璃帶
    for (let x = 0; x < S; x += 32) rect('#cfd3d4', x, 206, 3, 50);
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}
const facadeBuckets = new Map();   // kind → {pos, col, uv, owner}
const bucket = (kind) => {
  if (!facadeBuckets.has(kind)) facadeBuckets.set(kind, { pos: [], col: [], uv: [], owner: [] });
  return facadeBuckets.get(kind);
};
/** 立面四邊形：a→b 為牆底邊，y0..y1 高度，u0 為沿牆起點距離，vBase 為樓層起算高度 */
function facadeQuad(kind, id, [x1, z1], [x2, z2], y0, y1, u0, vBase, floorH, c0, c1) {
  const B = bucket(kind), L = Math.hypot(x2 - x1, z2 - z1);
  const ua = u0 / FACADE_W, ub = (u0 + L) / FACADE_W, va = (y0 - vBase) / floorH, vb = (y1 - vBase) / floorH;
  const P = [[x1, y0, z1, ua, va, c0], [x2, y0, z2, ub, va, c0], [x2, y1, z2, ub, vb, c1],
             [x1, y0, z1, ua, va, c0], [x2, y1, z2, ub, vb, c1], [x1, y1, z1, ua, vb, c1]];
  for (const [x, y, z, u, v, c] of P) { B.pos.push(x, y, z); B.uv.push(u, v); B.col.push(c.r, c.g, c.b); }
  B.owner.push(id, id);
  return L;
}

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
  if (b.blocks) { addBlocks(b, id, roofColor, wallColor); return; }
  const g0 = b.top - b.height;      // 樓層起算高度（坡地上取較高的一側）
  let run = 0;
  for (let i = 0; i < n; i++) {
    const [x1, z1] = poly[i], [x2, z2] = poly[(i + 1) % n];
    let L = Math.hypot(x2 - x1, z2 - z1);
    for (const [y0, y1, c0, c1] of bands) {
      if (y1 - y0 < 0.05) continue;
      if (b.facade) { facadeQuad(b.facade, id, [x1, z1], [x2, z2], y0, y1, run, g0, b.floorH, c0, c1); continue; }
      const a = [x1, y0, z1], bb = [x2, y0, z2], cc = [x2, y1, z2], d = [x1, y1, z1];
      for (const [p, col] of [[a, c0], [bb, c0], [cc, c1], [a, c0], [cc, c1], [d, c1]]) {
        wallPos.push(...p); wallCol.push(col.r, col.g, col.b);
      }
      wallOwner.push(id, id);
    }
    run += L;
  }
  // 平頂（斜屋頂建物也鋪一層，補住拆矩形時漏掉的碎角）
  const flatColor = b.parts ? wallColor.clone().multiplyScalar(0.8) : b.roofStyle === 'green' ? GREEN_ROOF : roofColor;
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

/** 分棟量體：每個矩形一棟，帶立面貼圖、平屋頂與女兒牆。 */
function addBlocks(b, id, roofColor, wallColor) {
  b.peak = b.top;
  for (const r of b.blocks) {
    const ca = Math.cos(r.ang), sa = Math.sin(r.ang), hw = r.w / 2, hd = r.d / 2;
    const at = (u, v) => [r.cx + u * ca - v * sa, r.cz + u * sa + v * ca];
    const cs = [at(-hw, -hd), at(hw, -hd), at(hw, hd), at(-hw, hd)];
    let run = 0;
    const foot = wallColor.clone().multiplyScalar(0.8);
    for (let i = 0; i < 4; i++) {
      run += facadeQuad(b.facade || 'plain', id, cs[i], cs[(i + 1) % 4], r.base, r.top, run, r.ground, b.floorH, foot, wallColor);
    }
    const rc = b.roofStyle === 'green' ? GREEN_ROOF : roofColor;
    pushTri(roofPos, roofCol, roofOwner, id, rc, [cs[0][0], r.top, cs[0][1]], [cs[1][0], r.top, cs[1][1]], [cs[2][0], r.top, cs[2][1]]);
    pushTri(roofPos, roofCol, roofOwner, id, rc, [cs[0][0], r.top, cs[0][1]], [cs[2][0], r.top, cs[2][1]], [cs[3][0], r.top, cs[3][1]]);
    // 女兒牆
    for (let i = 0; i < 4; i++) {
      const [x1, z1] = cs[i], [x2, z2] = cs[(i + 1) % 4];
      pushTri(wallPos, wallCol, wallOwner, id, wallColor, [x1, r.top, z1], [x2, r.top, z2], [x2, r.top + 1, z2]);
      pushTri(wallPos, wallCol, wallOwner, id, wallColor, [x1, r.top, z1], [x2, r.top + 1, z2], [x1, r.top + 1, z1]);
    }
    b.peak = Math.max(b.peak, r.top + 1);
  }
  b.top = Math.max(...b.blocks.map((r) => r.top));
}

/** 在矩形 p 上蓋四坡（廡殿）屋頂；p.top 比建物簷口高時先補牆。 */
function addHipRoof(b, p, id, roofColor, wallColor) {
  const ca = Math.cos(p.ang), sa = Math.sin(p.ang);
  const at = (u, v, y) => [p.cx + u * ca - v * sa, y, p.cz + u * sa + v * ca];
  const hw = p.w / 2, hd = p.d / 2, o = b.overhang;
  if (p.top > b.top + 0.1) {
    const cs = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
    // 有柱廊時：牆面往內縮、顏色壓暗（廊下陰影），外圈立一排柱子
    const col = b.colonnade && p.tiers ? new THREE.Color(b.colonnade) : null;
    const inset = col ? 2.2 : 0;
    const band = col ? wallColor.clone().multiplyScalar(0.55) : wallColor;
    const ati = (u, v, y) => at(u - Math.sign(u) * inset, v - Math.sign(v) * inset, y);
    for (let i = 0; i < 4; i++) {
      const [u1, v1] = cs[i], [u2, v2] = cs[(i + 1) % 4];
      pushTri(wallPos, wallCol, wallOwner, id, band, ati(u1, v1, b.top), ati(u2, v2, b.top), ati(u2, v2, p.top));
      pushTri(wallPos, wallCol, wallOwner, id, band, ati(u1, v1, b.top), ati(u2, v2, p.top), ati(u1, v1, p.top));
    }
    if (col) {
      // 廊道地板
      const fl = wallColor.clone().multiplyScalar(0.8);
      pushTri(roofPos, roofCol, roofOwner, id, fl, at(-hw, -hd, b.top), at(hw, -hd, b.top), at(hw, hd, b.top));
      pushTri(roofPos, roofCol, roofOwner, id, fl, at(-hw, -hd, b.top), at(hw, hd, b.top), at(-hw, hd, b.top));
      const r = 0.6;
      const box = (u, v) => {
        const q = [[u - r, v - r], [u + r, v - r], [u + r, v + r], [u - r, v + r]];
        for (let k = 0; k < 4; k++) {
          const [a1, b1] = q[k], [a2, b2] = q[(k + 1) % 4];
          pushTri(wallPos, wallCol, wallOwner, id, col, at(a1, b1, b.top), at(a2, b2, b.top), at(a2, b2, p.top));
          pushTri(wallPos, wallCol, wallOwner, id, col, at(a1, b1, b.top), at(a2, b2, p.top), at(a1, b1, p.top));
        }
      };
      const nu = Math.max(2, Math.round((2 * hw) / 5)), nv = Math.max(2, Math.round((2 * hd) / 5));
      for (let k = 0; k <= nu; k++) { const u = -hw + r + (2 * hw - 2 * r) * k / nu; box(u, -hd + r); box(u, hd - r); }
      for (let k = 1; k < nv; k++) { const v = -hd + r + (2 * hd - 2 * r) * k / nv; box(-hw + r, v); box(hw - r, v); }
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
  } else if (x.type === 'bridge') {
    extraGroup.add(makeBridge(x));
  }
}

/** 大願橋：沿路徑的弧形橋面，兩端窄中間寬、中間拱起，兩側為實牆（箱梁）。 */
function makeBridge(x) {
  const P = x.path;
  const y0 = P[0][1] + 0.6, y1 = P[P.length - 1][1] + 0.6;
  const curve = new THREE.CatmullRomCurve3(P.map(([px, , pz]) => new THREE.Vector3(px, 0, pz)));
  const N = 60, deck = [], wallG = [];
  const L = [], R = [], Ys = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N, c = curve.getPointAt(t), tan = curve.getTangentAt(t);
    const nrm = new THREE.Vector3(-tan.z, 0, tan.x).normalize();
    const w = (x.wEnd + (x.wMid - x.wEnd) * Math.sin(Math.PI * t)) / 2;
    const y = y0 + (y1 - y0) * t + x.arch * Math.sin(Math.PI * t);
    L.push(c.clone().addScaledVector(nrm, w)); R.push(c.clone().addScaledVector(nrm, -w)); Ys.push(y);
  }
  const quad = (arr, a, b, c, d) => arr.push(...a, ...b, ...c, ...a, ...c, ...d);
  const v = (p, y) => [p.x, y, p.z];
  for (let i = 0; i < N; i++) {
    const [ya, yb] = [Ys[i], Ys[i + 1]];
    quad(deck, v(L[i], ya), v(R[i], ya), v(R[i + 1], yb), v(L[i + 1], yb));                 // 橋面
    for (const S of [L, R]) {                                                             // 兩側牆：外、內、頂
      quad(wallG, v(S[i], ya - 1.6), v(S[i + 1], yb - 1.6), v(S[i + 1], yb + x.wall), v(S[i], ya + x.wall));
    }
    quad(wallG, v(L[i], ya - 1.6), v(R[i], ya - 1.6), v(R[i + 1], yb - 1.6), v(L[i + 1], yb - 1.6)); // 底板
  }
  const mk = (pos, color) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return shadowed(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide })));
  };
  const grp = new THREE.Group();
  grp.add(mk(deck, x.deck), mk(wallG, x.color));
  return grp;
}

const wallMesh = meshFrom(wallPos, wallCol);
const roofMesh = meshFrom(roofPos, roofCol);
wallMesh.userData.owner = wallOwner;
const facadeMeshes = [];
for (const [kind, B] of facadeBuckets) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(B.pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(B.uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(B.col, 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: facadeTexture(kind), vertexColors: true, side: THREE.DoubleSide }));
  m.castShadow = m.receiveShadow = true;
  m.userData.owner = B.owner;
  scene.add(m);
  facadeMeshes.push(m);
}
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
  // 點標籤：飛過去並打開照片＋詳細介紹視窗
  el.addEventListener('click', (ev) => { ev.stopPropagation(); select(p.id); openModal(p.id); });
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
  card.querySelector('.card-more').hidden = !(current && (details[current.id] || photos[current.id]?.length));
}
card.querySelector('.card-more').addEventListener('click', () => current && openModal(current.id));

// ---------- 地標視窗 ----------
const modal = $('#modal');
let gal = { list: [], i: 0 };
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function showPhoto(i) {
  const n = gal.list.length;
  if (!n) return;
  gal.i = (i + n) % n;
  const ph = gal.list[gal.i];
  const img = modal.querySelector('.gallery-main img');
  img.src = ph.src;
  img.alt = ph.caption || '';
  modal.querySelector('.gallery-count').textContent = `${gal.i + 1} / ${n}`;
  modal.querySelector('figcaption').innerHTML =
    `${ph.caption ? esc(ph.caption) + '　' : ''}照片：<a href="${esc(ph.link)}" target="_blank" rel="noopener">${esc(ph.credit)}</a>`;
  modal.querySelectorAll('.thumbs button').forEach((b, k) => b.classList.toggle('on', k === gal.i));
}
function openModal(id) {
  const p = places.find((x) => x.id === id);
  if (!p) return;
  const d = details[id] || {};
  gal = { list: photos[id] || [], i: 0 };
  modal.querySelector('.modal-group').textContent = p.group;
  modal.querySelector('h2').textContent = p.name;
  const has = gal.list.length > 0;
  modal.querySelector('.gallery').hidden = !has;
  modal.querySelector('.no-photo').hidden = has;
  modal.querySelectorAll('.gallery .nav').forEach((b) => { b.hidden = gal.list.length < 2; });
  modal.querySelector('.thumbs').innerHTML = gal.list.length > 1
    ? gal.list.map((ph, k) => `<button data-k="${k}" aria-label="第 ${k + 1} 張"><img src="${esc(ph.src)}" alt="" loading="lazy"></button>`).join('') : '';
  modal.querySelector('.facts').innerHTML = (d.facts || []).map((f) => `<li>${esc(f)}</li>`).join('');
  modal.querySelector('.detail').innerHTML = (d.detail || p.desc || '').split(/\n\n+/).map((t) => `<p>${esc(t)}</p>`).join('');
  const srcs = d.sources || (p.source ? [p.source] : []);
  modal.querySelector('.sources').innerHTML = srcs.length
    ? '資料來源：' + srcs.map((u) => `<br><a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>`).join('') : '';
  modal.hidden = false;
  modal.querySelector('.modal-body').scrollTop = 0;
  showPhoto(0);
  modal.querySelector('.modal-close').focus();
}
function closeModal() { modal.hidden = true; }
modal.querySelector('.modal-close').addEventListener('click', closeModal);
modal.querySelector('.modal-backdrop').addEventListener('click', closeModal);
modal.querySelector('.prev').addEventListener('click', () => showPhoto(gal.i - 1));
modal.querySelector('.next').addEventListener('click', () => showPhoto(gal.i + 1));
modal.querySelector('.thumbs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-k]');
  if (b) showPhoto(+b.dataset.k);
});
addEventListener('keydown', (e) => {
  if (modal.hidden) return;
  if (e.key === 'Escape') closeModal();
  if (e.key === 'ArrowLeft') showPhoto(gal.i - 1);
  if (e.key === 'ArrowRight') showPhoto(gal.i + 1);
});
// 觸控左右滑換照片
{
  let sx = null;
  const m = modal.querySelector('.gallery-main');
  m.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; }, { passive: true });
  m.addEventListener('touchend', (e) => {
    if (sx === null) return;
    const dx = e.changedTouches[0].clientX - sx;
    if (Math.abs(dx) > 40) showPhoto(gal.i + (dx < 0 ? 1 : -1));
    sx = null;
  });
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
// 起始畫面：從正門上空往北看校本部中庭（揚生館在左、綜合大樓在右、大願橋居中）
const HOME = { target: new THREE.Vector3(-20, groundY(-20, -300), -300), dist: 980, polar: 1.06, azimuth: 0.1 };
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
// ---------- 畫風 ----------
const outerPhotoMat = outerMesh?.material;
const OFFSET = { polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 };
const outerPlainMat = new THREE.MeshLambertMaterial({ vertexColors: true, ...OFFSET });
if (outerMesh) outerMesh.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(outerMesh.geometry.attributes.position.count * 3), 3));

// 道路、溪流、水池（插畫風格才顯示；寫實風格由空拍圖呈現）
function ribbon(pts, w, lift) {
  const out = [];
  const dense = [];
  for (let i = 0; i < pts.length - 1; i++) {        // 每 4 公尺取一點，貼著地形走
    const [x1, z1] = pts[i], [x2, z2] = pts[i + 1], L = Math.hypot(x2 - x1, z2 - z1), n = Math.max(1, Math.ceil(L / 4));
    for (let k = 0; k < n; k++) dense.push([x1 + (x2 - x1) * k / n, z1 + (z2 - z1) * k / n]);
  }
  dense.push(pts[pts.length - 1]);
  for (let i = 0; i < dense.length - 1; i++) {
    const [x1, z1] = dense[i], [x2, z2] = dense[i + 1], L = Math.hypot(x2 - x1, z2 - z1) || 1;
    const nx = -(z2 - z1) / L * w / 2, nz = (x2 - x1) / L * w / 2;
    const y1 = groundY(x1, z1) + lift, y2 = groundY(x2, z2) + lift;
    out.push(x1 + nx, y1, z1 + nz, x1 - nx, y1, z1 - nz, x2 - nx, y2, z2 - nz, x1 + nx, y1, z1 + nz, x2 - nx, y2, z2 - nz, x2 + nx, y2, z2 + nz);
  }
  return out;
}
function flatMesh(pos, color) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  m.receiveShadow = true;
  m.visible = false;
  scene.add(m);
  return m;
}
const roadMesh = flatMesh((data.roads || []).flatMap((r) => ribbon(r.pts, r.w, 0.35)), '#d9d2c3');
const roadEdge = flatMesh((data.roads || []).filter((r) => r.w >= 4).flatMap((r) => ribbon(r.pts, r.w + 1.6, 0.25)), '#b9b09d');
const waterPos = [];
for (const poly of data.waters || []) {
  const ring = poly[0][0] === poly[poly.length - 1][0] && poly[0][1] === poly[poly.length - 1][1] ? poly.slice(0, -1) : poly;
  const y = Math.min(...ring.map(([x, z]) => groundY(x, z))) + 0.4;
  for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(ring.map(([x, z]) => new THREE.Vector2(x, z)), []))
    waterPos.push(ring[i][0], y, ring[i][1], ring[j][0], y, ring[j][1], ring[k][0], y, ring[k][1]);
}
for (const st of data.streams || []) waterPos.push(...ribbon(st.pts, st.w, 0.3));
const waterMesh = flatMesh(waterPos, '#7fb0b4');

// 地面著色：依坡度與雜訊上色（插畫風格）
// pal = [空地, 坡地, 林地, 海]；mask 為每個格點的 '0' 空地 / '1' 林地 / '2' 海
function paintGround(mesh, pal, mask) {
  if (!mesh) return;
  const g = mesh.geometry, n = g.attributes.normal, p = g.attributes.position, c = g.attributes.color;
  const [a, b, f, w] = pal.map((x) => new THREE.Color(x)), t = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const slope = 1 - n.getY(i);
    const noise = (Math.sin(p.getX(i) * 0.05) * Math.cos(p.getZ(i) * 0.043) + 1) / 2;
    const m = mask ? mask[i] : '0';
    if (m === '2') t.copy(w);
    else if (m === '1') t.copy(f).lerp(b, noise * 0.25);
    else t.copy(a).lerp(b, Math.min(1, slope * 2.2 + noise * 0.35));
    c.setXYZ(i, t.r, t.g, t.b);
  }
  c.needsUpdate = true;
}

// 建物色彩：保留原色，依風格調整飽和度與亮度
const colorMeshes = [wallMesh, roofMesh, ...facadeMeshes];
for (const m of colorMeshes) m.userData.baseColors = m.geometry.attributes.color.array.slice();
function tintBuildings(sat, light) {
  const t = new THREE.Color(), hsl = {};
  for (const m of colorMeshes) {
    const src = m.userData.baseColors, dst = m.geometry.attributes.color.array;
    for (let i = 0; i < src.length; i += 3) {
      t.setRGB(src[i], src[i + 1], src[i + 2]).getHSL(hsl);
      t.setHSL(hsl.h, Math.min(1, hsl.s * sat), Math.min(1, hsl.l * light));
      dst[i] = t.r; dst[i + 1] = t.g; dst[i + 2] = t.b;
    }
    m.geometry.attributes.color.needsUpdate = true;
  }
}
const lambertOf = new Map(colorMeshes.map((m) => [m, m.material]));
const toonGrad = (() => {
  const t = new THREE.DataTexture(new Uint8Array([90, 170, 255]), 3, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter; t.needsUpdate = true; return t;
})();
const toonOf = new Map(colorMeshes.map((m) => [m, new THREE.MeshToonMaterial({ map: m.material.map || null, vertexColors: true, side: THREE.DoubleSide, gradientMap: toonGrad })]));

// 樹：風格各自的色盤與外形
const treeBase = data.trees.map(([, , , , r, g, b]) => [r / 255, g / 255, b / 255]);
const treeFacet = treeMesh.geometry, treeRound = new THREE.IcosahedronGeometry(1, 2);
const treeLambert = treeMesh.material, treeToon = new THREE.MeshToonMaterial({ gradientMap: toonGrad });
let treeScaleNow = 1;
function setTreeScale(k) {
  if (k === treeScaleNow) return;
  treeScaleNow = k;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  data.trees.forEach(([x, y, z, s], i) => {
    e.set(0, (i * 2.399) % 6.283, 0);
    q.setFromEuler(e);
    m.compose(new THREE.Vector3(x, y + 2.6 * s * k, z), q, new THREE.Vector3(3.6 * s * k, 3.4 * s * k, 3.6 * s * k));
    treeMesh.setMatrixAt(i, m);
  });
  treeMesh.instanceMatrix.needsUpdate = true;
}
function paintTrees(pal) {
  const c = new THREE.Color();
  treeBase.forEach(([r, g, b], i) => {
    if (!pal) c.setRGB(r, g, b, THREE.SRGBColorSpace).offsetHSL(0, 0.05, 0.05);
    else c.set(pal[i % 7 < 3 ? 0 : i % 7 < 6 ? 1 : 2]).offsetHSL(0, 0, ((i * 7919) % 100) / 1000 - 0.05);
    treeMesh.setColorAt(i, c);
  });
  treeMesh.instanceColor.needsUpdate = true;
}

const STYLES = {
  real:   { name: '寫實', photo: true, sky: '#cdd9e0', fog: [2200, 5200], hemi: 1.4, sun: 2.2, trees: null, round: false, sat: 1, light: 1, toon: false },
  pastel: { name: '清雅', photo: false, ground: ['#b9cf98', '#8fb174', '#4f7a45', '#9cc3c4'], treeScale: 1.45, sky: '#e9ede4', fog: [1800, 4600], hemi: 1.9, sun: 1.6,
            trees: ['#4f7d45', '#5f8f4f', '#79a35e'], round: true, sat: 0.85, light: 1.06, toon: false },
  ink:    { name: '水墨', photo: true, treeScale: 1.25, sky: '#efe9dc', fog: [500, 2600], hemi: 1.6, sun: 1.5,
            trees: ['#6d7a55', '#7f8a62', '#596648'], round: true, sat: 0.55, light: 1.05, toon: false },
  fairy:  { name: '童話', photo: false, ground: ['#b8ea86', '#8fd170', '#47a352', '#6fd0ef'], treeScale: 1.45, sky: '#bfe6ff', fog: [2000, 5000], hemi: 2.0, sun: 2.0,
            trees: ['#3faa55', '#62c45a', '#2f8f63'], round: true, sat: 1.45, light: 1.08, toon: true },
};
let styleKey = 'real';
function applyStyle(key) {
  const st = STYLES[key] || STYLES.real;
  styleKey = STYLES[key] ? key : 'real';
  terrain.material = st.photo ? photoMat : plainMat;
  if (outerMesh) outerMesh.material = st.photo ? outerPhotoMat : outerPlainMat;
  if (!st.photo) { paintGround(terrain, st.ground, data.grid.forest); paintGround(outerMesh, st.ground, data.outer?.forest); }
  setTreeScale(st.treeScale || 1);
  roadMesh.visible = roadEdge.visible = waterMesh.visible = !st.photo;
  roadMesh.material.color.set(key === 'fairy' ? '#f3e2b8' : '#d9d2c3');
  waterMesh.material.color.set(key === 'fairy' ? '#5cc3e6' : '#7fb0b4');
  scene.background = new THREE.Color(st.sky);
  scene.fog.color.set(st.sky); scene.fog.near = st.fog[0]; scene.fog.far = st.fog[1];
  hemi.intensity = st.hemi; sun.intensity = st.sun;
  treeMesh.geometry = st.round ? treeRound : treeFacet;
  treeMesh.material = st.toon ? treeToon : treeLambert;
  paintTrees(st.trees);
  tintBuildings(st.sat, st.light);
  for (const m of colorMeshes) m.material = st.toon ? toonOf.get(m) : lambertOf.get(m);
  $('#app').dataset.style = styleKey;
  document.querySelectorAll('.style-tools button').forEach((b) => b.classList.toggle('on', b.dataset.style === styleKey));
  try { localStorage.setItem('campus3d-style', styleKey); } catch {}
  const url = new URL(location.href);
  if (styleKey === 'real') url.searchParams.delete('style'); else url.searchParams.set('style', styleKey);
  history.replaceState(null, '', url);
}
document.querySelectorAll('.style-tools button').forEach((b) => b.addEventListener('click', () => applyStyle(b.dataset.style)));
{
  let saved = null;
  try { saved = localStorage.getItem('campus3d-style'); } catch {}
  applyStyle(new URLSearchParams(location.search).get('style') || saved || 'real');
}
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
  const hit = ray.intersectObjects([wallMesh, roofMesh, ...facadeMeshes, terrain], false)[0];
  if (!hit || hit.object === terrain) { select(null); return; }
  const b = buildings[hit.object.userData.owner[hit.faceIndex]];
  const p = placeByOsm.get(b.id);
  if (p) { select(p.id); return; }
  select(null);
  setHighlight(b);
  if (b.context) { showCard('園區外', b.name || '鄰近建物', '不屬於法鼓文理學院或法鼓山園區，僅作為周邊背景顯示。'); return; }
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
// 鏡頭中心不能離開校區範圍，使用者無法把校園移出畫面
const BOUND = { x0: G.x0 + 60, x1: G.x0 + (G.nx - 1) * G.step - 60, z0: G.z0 + 60, z1: G.z0 + (G.nz - 1) * G.step - 60 };
function clampView() {
  const t = controls.target;
  const cx = Math.min(BOUND.x1, Math.max(BOUND.x0, t.x)), cz = Math.min(BOUND.z1, Math.max(BOUND.z0, t.z));
  if (cx !== t.x || cz !== t.z) {
    const dx = cx - t.x, dz = cz - t.z;
    t.x = cx; t.z = cz;
    camera.position.x += dx; camera.position.z += dz;
  }
  // 鏡頭也不要鑽到地面下
  const gy = groundY(camera.position.x, camera.position.z);
  if (Number.isFinite(gy) && camera.position.y < gy + 8) camera.position.y = gy + 8;
}
function tick(now) {
  if (anim) {
    const t = Math.min(1, (now - anim.t0) / 1100), k = t * t * (3 - 2 * t);
    camera.position.lerpVectors(anim.fromPos, anim.toPos, k);
    controls.target.lerpVectors(anim.fromTgt, anim.toTgt, k);
    if (t === 1) anim = null;
  }
  controls.update();
  clampView();
  renderer.render(scene, camera);
  updateLabels();
  requestAnimationFrame(tick);
}
controls.addEventListener('start', () => { anim = null; });
$('#loading').remove();
requestAnimationFrame(tick);

const initial = new URLSearchParams(location.search).get('place');
if (initial) select(initial);
window.__campus = { scene, camera, controls, select, places, openModal };
