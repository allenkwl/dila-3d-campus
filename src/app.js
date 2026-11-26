import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const GROUP_COLORS = { '文理學院': '#c0592b', '校園景點': '#4f7d3f', '法鼓山園區': '#7a6a2f', '校門': '#3f6f8f' };
const WALL = new THREE.Color('#e4ddcf');
const GREEN_ROOF = new THREE.Color('#7f9b5c');
const $ = (s) => document.querySelector(s);

// 版本號取自 index.html 的 app.js?v=…，資料檔一起帶上，避免瀏覽器用到舊快取
const V = new URL(import.meta.url).searchParams.get('v') || '';
const withV = (u) => (V ? `${u}?v=${V}` : u);
const getJSON = (u) => fetch(withV(u)).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
// 分段載入：先拿校區核心資料就開始畫；照片、說明、外圍地形與空拍圖都在背景補上
const data = await getJSON('data/campus.json');
let details = {}, photos = {};
getJSON('data/details.json').then((d) => { details = d; });
getJSON('data/photos.json').then((d) => { photos = d; });
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
function loadTex(url, onLoad) {
  new THREE.TextureLoader().load(withV(url), (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    onLoad(t);
  });
}
// 空拍圖載入前先用素色地面，載入後再換上
const photoMat = new THREE.MeshLambertMaterial({ color: '#8c9a7c' });
loadTex('data/ortho.jpg', (t) => { photoMat.map = t; photoMat.color.set('#ffffff'); photoMat.needsUpdate = true; });
const plainMat = new THREE.MeshLambertMaterial({ vertexColors: true });
const terrain = new THREE.Mesh(terrainGeo, photoMat);
terrain.receiveShadow = true;
scene.add(terrain);

// ---------- 外圍地形：低解析度，讓地圖邊緣不入鏡；和內圈重疊的部分挖空（背景載入，見檔尾） ----------
let outerMesh = null;
const OFFSET = { polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 };   // 外圈稍往後推，避免交界閃爍
const outerPhotoMat = new THREE.MeshLambertMaterial({ color: '#8c9a7c', ...OFFSET });
function buildOuterMesh(O) {
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
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(nx * nz * 3), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, outerPhotoMat);
  m.receiveShadow = true;
  return m;
}

// ---------- 建物 ----------
// ---------- 立面貼圖（程式產生；一格 = 寬 4 公尺 × 一層樓） ----------
const FACADE_W = 4;
const TILE_W = { gym: 12 };   // 揚生館大面積實牆，格柵窗較稀疏
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
  } else if (kind === 'gridwood') {   // 粗白框分格，每格上窗下木板（禪悅書苑，抿石子）
    rect('#5b666d', 40, 30, 176, 104);            // 窗（反射天空，偏亮）
    for (let x = 40; x < 216; x += 44) rect('#a9b1b5', x, 30, 3, 104);
    rect('#9c5b41', 40, 134, 176, 84);            // 木質欄板
    for (let x = 44; x < 216; x += 12) rect('#b06c4d', x, 134, 6, 84);
    rect('#d6d3cb', 34, 230, 188, 4);             // 凹進去的陰影
    rect('#d6d3cb', 222, 26, 4, 208);
  } else if (kind === 'brick') {      // 磚牆＋成排方窗（法印書苑、男寮、圖資館）
    for (let y = 0; y < S; y += 16) rect('#ececec', 0, y, S, 2);
    for (const x of [30, 150]) { rect('#f6f6f4', x - 6, 64, 88, 132); rect(DARK, x, 70, 76, 120); rect('#9aa0a4', x + 36, 70, 4, 120); }
  } else if (kind === 'brickslot') {  // 磚牆＋成對細長直窗（禪堂、第二／第三大樓）
    for (let y = 0; y < S; y += 16) rect('#ececec', 0, y, S, 2);
    for (const x of [56, 84, 160, 188]) { rect('#f4f4f2', x - 3, 46, 22, 172); rect(DARK, x, 50, 16, 164); }
  } else if (kind === 'stone') {      // 粗面花崗石塊（大殿基座）
    let k = 0;
    for (let y = 0; y < S; y += 32, k++) {
      for (let x = (k % 2) * -32; x < S; x += 64) {
        const sh = 226 + ((x * 7 + y * 13) % 29);
        rect(`rgb(${sh},${sh},${sh})`, x + 2, y + 2, 60, 28);
      }
    }
    rect(DARK, 108, 104, 40, 48);                 // 稀疏的小窗
  } else if (kind === 'gym') {        // 清水模牆面＋直向格柵窗（揚生館）
    for (let x = 0; x < S; x += 128) rect('#e2e2df', x, 0, 3, S);
    for (const [x, y] of [[32, 64], [96, 64], [32, 192], [96, 192], [160, 64], [224, 64], [160, 192], [224, 192]])
      rect('#d9d9d6', x - 2, y - 2, 4, 4);         // 模板孔
    rect('#2e3336', 170, 30, 30, 196);
    for (let x = 172; x < 200; x += 7) rect('#e9e9e6', x, 30, 3, 196);
  } else if (kind === 'gymglass') {   // 揚生館一樓玻璃帶
    rect(GLASS, 0, 40, S, 216);
    for (let x = 0; x < S; x += 32) rect('#c9cdce', x, 40, 4, 216);
    rect('#f0f0ed', 0, 0, S, 40);
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
  const B = bucket(kind), L = Math.hypot(x2 - x1, z2 - z1), TW = TILE_W[kind] || FACADE_W;
  const ua = u0 / TW, ub = (u0 + L) / TW, va = (y0 - vBase) / floorH, vb = (y1 - vBase) / floorH;
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
  if (b.hidden) return;
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
      if (b.facade === 'gym') {
        // 一樓（含坡地下方露出的部分）用玻璃帶，以上為清水模牆面
        // 坡地下方露出的部分是清水模基座；入口層（高側地面起一層）是玻璃帶；以上為清水模牆面
        const split = r.ground + b.floorH;
        facadeQuad('gym', id, cs[i], cs[(i + 1) % 4], r.base, r.ground, run, r.ground, b.floorH, foot, wallColor);
        facadeQuad('gymglass', id, cs[i], cs[(i + 1) % 4], r.ground, split, run, r.ground, b.floorH, wallColor, wallColor);
        run += facadeQuad('gym', id, cs[i], cs[(i + 1) % 4], split, r.top, run, r.ground, b.floorH, wallColor, wallColor);
      } else {
        run += facadeQuad(b.facade || 'plain', id, cs[i], cs[(i + 1) % 4], r.base, r.top, run, r.ground, b.floorH, foot, wallColor);
      }
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
  b.height = Math.max(...b.blocks.map((r) => r.top - r.ground));   // 資料卡顯示的高度
  b.peak = b.top;
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
  } else if (x.type === 'tunnel') {
    extraGroup.add(makeTunnel(x));
  } else if (x.type === 'boulder') {
    extraGroup.add(makeBoulder(x));
  } else if (x.type === 'banyans') {
    extraGroup.add(makeBanyans(x));
  } else if (x.type === 'bench') {
    const g = new THREE.Group();
    g.position.set(x.x, x.y, x.z);
    g.rotation.y = x.ang || 0;
    const stone = lam(x.color || '#9c978c');
    const seat = shadowed(new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.22, 0.6), stone));
    seat.position.y = 0.5;
    g.add(seat);
    for (const s of [-0.8, 0.8]) {
      const leg = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.5, 0.5), stone));
      leg.position.set(s, 0.2, 0);
      g.add(leg);
    }
    extraGroup.add(g);
  }
}

/** 圓通海印隧道：兩端擋土牆開圓拱洞口（白色拱圈、題字匾），中間半圓筒。path 兩點為兩端洞口。 */
function makeTunnel(x) {
  const [a, b] = x.path;
  const dx = b[0] - a[0], dz = b[2] - a[2], dy = b[1] - a[1];
  const L = Math.hypot(dx, dz), r = x.r, yc = 1.4;     // 拱心高於路面 yc
  const g = new THREE.Group();
  g.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + 0.3, (a[2] + b[2]) / 2);
  g.rotation.order = 'YXZ';
  g.rotation.y = Math.atan2(dx, dz);
  g.rotation.x = -Math.atan2(dy, L);
  const white = lam(x.ring || '#e9e7e1'), wallMat = lam(x.wall || '#aaa69b');
  // 洞身：上半圓筒＋兩側直牆＋路面
  const shell = new THREE.Mesh(new THREE.CylinderGeometry(r, r, L, 32, 1, true, Math.PI / 2, Math.PI), new THREE.MeshLambertMaterial({ color: x.ring || '#e9e7e1', side: THREE.DoubleSide }));
  shell.rotation.x = Math.PI / 2;
  shell.position.y = yc;
  g.add(shell);
  for (const s of [-1, 1]) {
    const side = new THREE.Mesh(new THREE.BoxGeometry(0.3, yc + 0.6, L), white);
    side.position.set(s * r, (yc - 0.6) / 2, 0);
    g.add(side);
  }
  const road = new THREE.Mesh(new THREE.BoxGeometry(r * 2, 0.2, L + 2), lam('#4a4c4e'));
  road.position.y = -0.1;
  g.add(road);
  // 洞口：擋土牆（挖圓拱洞）＋白色拱圈＋匾
  const archPath = (p, rr, bottom) => {
    p.moveTo(-rr, bottom); p.lineTo(-rr, yc); p.absarc(0, yc, rr, Math.PI, 0, true); p.lineTo(rr, bottom); p.lineTo(-rr, bottom);
  };
  const wallShape = new THREE.Shape();
  const top = r + 3;                                  // 截面為梯形：兩側斜坡、頂部窄
  wallShape.moveTo(-x.W / 2, -2); wallShape.lineTo(x.W / 2, -2); wallShape.lineTo(x.W / 2, 0.4); wallShape.lineTo(top, x.H); wallShape.lineTo(-top, x.H); wallShape.lineTo(-x.W / 2, 0.4); wallShape.lineTo(-x.W / 2, -2);
  const hole = new THREE.Path(); archPath(hole, r + 0.9, -1); wallShape.holes.push(hole);
  const ringShape = new THREE.Shape(); archPath(ringShape, r + 0.9, -0.6);
  const ringHole = new THREE.Path(); archPath(ringHole, r, -0.5); ringShape.holes.push(ringHole);
  // 土丘：整段沿洞身擠出，兩端截面是擋土牆（石紋灰），頂與側面是草坡
  const hill = shadowed(new THREE.Mesh(new THREE.ExtrudeGeometry(wallShape, { depth: L, bevelEnabled: false, curveSegments: 24 }),
    [wallMat, lam(x.grass || '#6d7a52')]));
  hill.position.z = -L / 2;
  g.add(hill);
  const ringGeo = new THREE.ExtrudeGeometry(ringShape, { depth: 1.8, bevelEnabled: false, curveSegments: 24 });
  for (const s of [1, -1]) {
    const face = new THREE.Group();
    face.position.z = s * L / 2;
    face.rotation.y = s > 0 ? 0 : Math.PI;
    const ring = shadowed(new THREE.Mesh(ringGeo, white));
    ring.position.z = -0.6;
    const plaque = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.7, 0.15), lam('#f4f2ec'));
    plaque.position.set(0, yc + r + 1.35, 0.1);
    face.add(ring, plaque);
    g.add(face);
  }
  return g;
}

/** 七棵雀榕：粗短樹幹、氣根般分岔的枝幹，上撐寬大的傘狀樹冠（每棵約 16 公尺寬、13 公尺高）。 */
function makeBanyans(x) {
  const g = new THREE.Group();
  const bark = new THREE.MeshLambertMaterial({ color: '#6b5a4a', flatShading: true });
  const leaf = new THREE.MeshLambertMaterial({ color: x.color, flatShading: true });
  const leaf2 = new THREE.MeshLambertMaterial({ color: new THREE.Color(x.color).offsetHSL(0.02, 0.05, 0.06), flatShading: true });
  x.pts.forEach(([px, py, pz, s], i) => {
    const t = new THREE.Group();
    t.position.set(px, py - 0.3, pz);
    t.rotation.y = i * 1.37;
    t.scale.setScalar(s);
    const trunk = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.3, 5.5, 7), bark));
    trunk.position.y = 2.75;
    t.add(trunk);
    for (let k = 0; k < 4; k++) {               // 斜伸的主枝
      const a = k * Math.PI / 2 + 0.4;
      const br = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.45, 4.2, 5), bark));
      br.position.set(Math.cos(a) * 1.3, 6.2, Math.sin(a) * 1.3);
      br.rotation.set(Math.sin(a) * 0.75, 0, -Math.cos(a) * 0.75);
      t.add(br);
    }
    const blobs = [[0, 10, 0, 4.6, 0], [4.2, 9, 1.2, 3.6, 1], [-4, 9.2, -0.8, 3.7, 0], [1, 9, -4, 3.5, 1], [-1.4, 8.8, 4, 3.4, 0], [0.6, 12, 0.4, 3.2, 1]];
    for (const [bx, by, bz, r, alt] of blobs) {
      const m = shadowed(new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), alt ? leaf2 : leaf));
      m.position.set(bx, by, bz);
      m.scale.y = 0.72;                          // 樹冠扁、往兩側撐開
      t.add(m);
    }
    g.add(t);
  });
  return g;
}

/** 海印三昧石：不規則的大石（一部分埋入草地）。 */
function makeBoulder(x) {
  const geo = new THREE.IcosahedronGeometry(1, 2);
  const p = geo.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = 1 + 0.12 * Math.sin(v.x * 3.1 + v.y * 1.7) + 0.08 * Math.cos(v.z * 4.3 - v.x * 2.2);
    v.multiplyScalar(n);
    if (v.y < -0.35) v.y = -0.35;                         // 底部平，坐在地上
    p.setXYZ(i, v.x * x.w / 2, v.y * x.h / 1.6, v.z * x.d / 2);
  }
  geo.computeVertexNormals();
  const m = shadowed(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: x.color, flatShading: true })));
  m.position.set(x.x, x.y + 0.35 * x.h / 1.6 - 0.1, x.z);
  m.rotation.y = x.ang || 0.6;
  return m;
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
// ---------- 樹 ----------
// 兩種樹形：闊葉（數團樹冠＋樹幹）、針葉（疊錐＋樹幹）；樹冠下暗上亮。寫實用多面體，插畫風用圓潤版本。
// 面數控制：闊葉約 90 面、針葉約 50 面；外圍用單團簡化版（約 20 面）。圓潤版只換成平滑法線，不加面數。
function treeGeometry(kind, round, lite) {
  const shade = (g, lo, hi, trunk) => {      // 依高度上色：下暗上亮
    g = g.index ? g.toNonIndexed() : g;
    const p = g.attributes.position, c = new Float32Array(p.count * 3);
    let y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < p.count; i++) { y0 = Math.min(y0, p.getY(i)); y1 = Math.max(y1, p.getY(i)); }
    for (let i = 0; i < p.count; i++) {
      const t = (p.getY(i) - y0) / (y1 - y0 || 1), v = lo + (hi - lo) * t;
      if (trunk) c.set([0.42, 0.33, 0.27], i * 3); else c.set([v, v, v], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    g.deleteAttribute('uv');
    return g;
  };
  const parts = [];
  if (kind === 1) {
    const tiers = lite ? [[0.9, 2.6, 0.3]] : [[0.95, 1.5, -0.2], [0.72, 1.3, 0.45], [0.48, 1.1, 1.05]];
    for (const [r, h, y] of tiers) parts.push(new THREE.ConeGeometry(r, h, 7, 1, true).translate(0, y, 0));
  } else {
    const blobs = lite ? [[0.95, 0, 0, 0]] : [[0.85, 0, 0, 0], [0.62, 0.48, -0.18, 0.22], [0.6, -0.45, -0.12, -0.28], [0.52, 0.08, 0.5, -0.05]];
    for (const [r, x, y, z] of blobs) parts.push(new THREE.IcosahedronGeometry(r, 0).translate(x, y, z));
  }
  let canopy = shade(mergeGeometries(parts.map((g) => g.toNonIndexed())), 0.62, 1.12, false);
  if (round) {                                 // 平滑法線：合併相同頂點後重算
    canopy.deleteAttribute('normal');
    canopy = mergeVertices(canopy);
    canopy.computeVertexNormals();
    canopy = canopy.toNonIndexed();
  }
  if (lite) return canopy;
  const trunk = shade(new THREE.CylinderGeometry(0.07, 0.11, 1.4, 5, 1, true).translate(0, -1.15, 0), 0, 0, true);
  return mergeGeometries([canopy, trunk]);
}
const TREE_GEO = {};
for (const kind of [0, 1]) for (const lite of [false, true])
  TREE_GEO[`${kind}${lite ? 'L' : ''}`] = { facet: treeGeometry(kind, false, lite), round: treeGeometry(kind, true, lite) };
const treeLambert = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
const treeSmooth = new THREE.MeshLambertMaterial({ vertexColors: true });
const treeSets = [];
function placeTrees(set, k) {
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const tall = set.kind === 1 ? 1.25 : 1;     // 針葉樹較瘦高
  set.list.forEach(([x, y, z, s], i) => {
    e.set(0, (x * 1.7 + z * 2.3) % 6.283, 0);
    q.setFromEuler(e);
    const sx = 3.4 * s * k * (set.kind === 1 ? 0.8 : 1), sy = 3.4 * s * k * tall;
    m.compose(new THREE.Vector3(x, y + 1.15 * sy + 0.3, z), q, new THREE.Vector3(sx, sy, sx));
    set.mesh.setMatrixAt(i, m);
  });
  set.mesh.instanceMatrix.needsUpdate = true;
  set.scale = k;
}
function addTrees(list, lite = false) {
  if (!list?.length) return;
  for (const kind of [0, 1]) {
    const sub = list.filter((t) => (t[7] || 0) === kind);
    if (!sub.length) continue;
    const key = `${kind}${lite ? 'L' : ''}`;
    const mesh = new THREE.InstancedMesh(TREE_GEO[key].facet, treeLambert, sub.length);
    const set = { mesh, list: sub, kind, key, scale: 0 };
    placeTrees(set, 1);
    mesh.setColorAt(0, new THREE.Color());
    mesh.castShadow = !lite;                   // 外圍遠處的樹不投影，省效能
    mesh.receiveShadow = true;
    mesh.visible = $('#opt-trees')?.checked !== false;
    scene.add(mesh);
    treeSets.push(set);
  }
}
addTrees(data.trees);

// ---------- 選取外框 ----------
const highlight = new THREE.LineSegments(new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: '#ff8a2a', depthTest: false, transparent: true }));
highlight.renderOrder = 10;
scene.add(highlight);
function setHighlight(b) {
  if (!b || b.hidden) { highlight.visible = false; return; }
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
// 起始畫面：從圖書資訊館東側上空往北看校本部中庭（揚生館在左、綜合大樓在右、大願橋居中）
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
const outerPlainMat = new THREE.MeshLambertMaterial({ vertexColors: true, ...OFFSET });

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
// 步道：石板色窄帶，各畫風都顯示（道路在寫實風會隱藏，步道不隱藏）
const trailMesh = flatMesh((data.extras || []).filter((x) => x.type === 'trail').flatMap((x) => ribbon(x.path.map(([px, , pz]) => [px, pz]), x.w, 0.4)), '#cfc3a6');
trailMesh.visible = true;
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
const treeToon = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonGrad });
function setTreeScale(k) { for (const set of treeSets) if (set.scale !== k) placeTrees(set, k); }
function paintTrees(pal) {
  const c = new THREE.Color();
  for (const { mesh, list, kind } of treeSets) {
    list.forEach(([, , , , r, g, b], i) => {
      if (!pal) c.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace).offsetHSL(0, 0.08, 0.06);
      else c.set(pal[i % 7 < 3 ? 0 : i % 7 < 6 ? 1 : 2]).offsetHSL(0, 0, ((i * 7919) % 100) / 1000 - 0.05);
      if (kind === 1) c.offsetHSL(0.04, -0.05, -0.07);   // 針葉樹偏深、偏藍綠
      mesh.setColorAt(i, c);
    });
    mesh.instanceColor.needsUpdate = true;
  }
}

const STYLES = {
  real:   { name: '寫實', photo: true, sky: '#cdd9e0', fog: [2200, 5200], hemi: 1.4, sun: 2.2, trees: null, round: false, sat: 1, light: 1, toon: false },
  pastel: { name: '清雅', photo: false, ground: ['#b9cf98', '#8fb174', '#4f7a45', '#9cc3c4'], treeScale: 1.3, sky: '#e9ede4', fog: [1800, 4600], hemi: 1.9, sun: 1.6,
            trees: ['#4f7d45', '#5f8f4f', '#79a35e'], round: true, sat: 0.85, light: 1.06, toon: false },
  ink:    { name: '水墨', photo: true, treeScale: 1.15, sky: '#efe9dc', fog: [500, 2600], hemi: 1.6, sun: 1.5,
            trees: ['#6d7a55', '#7f8a62', '#596648'], round: true, sat: 0.55, light: 1.05, toon: false },
  fairy:  { name: '童話', photo: false, ground: ['#b8ea86', '#8fd170', '#47a352', '#6fd0ef'], treeScale: 1.3, sky: '#bfe6ff', fog: [2000, 5000], hemi: 2.0, sun: 2.0,
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
  for (const { mesh, key } of treeSets) {
    mesh.geometry = TREE_GEO[key][st.round ? 'round' : 'facet'];
    mesh.material = st.toon ? treeToon : st.round ? treeSmooth : treeLambert;
  }
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
$('#opt-trees').addEventListener('change', (e) => { for (const { mesh } of treeSets) mesh.visible = e.target.checked; });

// ---------- 背景載入外圍：地形與樹先到先畫，空拍圖最後補上 ----------
getJSON('data/outer.json').then((od) => {
  if (!od.outer) return;
  data.outer = od.outer;
  outerMesh = buildOuterMesh(od.outer);
  scene.add(outerMesh);
  applyStyle(styleKey);
  loadTex('data/ortho_outer.jpg', (t) => { outerPhotoMat.map = t; outerPhotoMat.color.set('#ffffff'); outerPhotoMat.needsUpdate = true; });
});
$('#opt-labels').addEventListener('change', (e) => { labelsEl.style.display = e.target.checked ? '' : 'none'; });

// ---------- 旋轉與傾斜手勢 ----------
// 滑鼠：左鍵拖曳平移；右鍵、或按住 Shift／Ctrl／⌘ 拖曳旋轉（MapControls 內建）；滾輪縮放
// 觸控板：雙指捏合縮放；雙指左右滑動旋轉、上下滑動調整俯仰
// 手機：單指平移；雙指捏合縮放、雙指旋轉轉向、雙指上下拖曳調整俯仰
function orbit(dAz, dPolar) {
  const off = camera.position.clone().sub(controls.target);
  const sph = new THREE.Spherical().setFromVector3(off);
  sph.theta += dAz;
  sph.phi = Math.min(controls.maxPolarAngle, Math.max(0.12, sph.phi + dPolar));
  camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(sph));
  anim = null;
}
canvas.addEventListener('wheel', (e) => {
  if (e.ctrlKey) return;                       // 觸控板捏合（瀏覽器會帶 ctrlKey）→ 交給 MapControls 縮放
  // 判斷觸控板：有水平分量；或 Chrome／Safari 觸控板的 wheelDeltaY 恰為 deltaY 的 -3 倍；Firefox 則看是否為非整數像素
  const w = e.wheelDeltaY;
  const trackpad = e.deltaX !== 0 || (w !== undefined && e.deltaY !== 0 && w === -3 * e.deltaY)
    || (w === undefined && e.deltaMode === 0 && !Number.isInteger(e.deltaY));
  if (!trackpad) return;                       // 滑鼠滾輪 → 縮放
  e.preventDefault();
  e.stopImmediatePropagation();
  orbit(e.deltaX * 0.004, e.deltaY * 0.003);
}, { capture: true, passive: false });
{
  let lastAng = null;
  const ang = (t) => Math.atan2(t[1].clientY - t[0].clientY, t[1].clientX - t[0].clientX);
  canvas.addEventListener('touchstart', (e) => { lastAng = e.touches.length === 2 ? ang(e.touches) : null; }, { passive: true });
  canvas.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2 || lastAng === null) return;
    const a = ang(e.touches);
    let d = a - lastAng;
    if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI;
    lastAng = a;
    if (Math.abs(d) < 0.3) orbit(d, 0);         // 雙指旋轉：地圖跟著手指轉
  }, { passive: true });
  canvas.addEventListener('touchend', (e) => { if (e.touches.length < 2) lastAng = null; }, { passive: true });
}
// 鍵盤：Q／E 旋轉、R／F 俯仰
addEventListener('keydown', (e) => {
  if (!modal.hidden || e.target.closest?.('input, textarea')) return;
  const k = e.key.toLowerCase();
  if (k === 'q') orbit(0.08, 0); else if (k === 'e') orbit(-0.08, 0);
  else if (k === 'r') orbit(0, -0.06); else if (k === 'f') orbit(0, 0.06);
});
// 指北針：箭頭指向北方，點一下轉回正北
const compass = $('#btn-north');
compass.addEventListener('click', () => {
  const sph = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
  flyTo(controls.target.clone(), sph.radius, sph.phi, 0);
});
function updateCompass() {
  const sph = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
  compass.firstElementChild.style.transform = `rotate(${sph.theta}rad)`;
}
// 操作提示依裝置顯示
$('#panel footer').textContent = matchMedia('(pointer: coarse)').matches
  ? '單指平移・雙指捏合縮放・雙指旋轉轉向・雙指上下滑調整角度'
  : '拖曳平移・右鍵或 Shift 拖曳旋轉・觸控板雙指滑動旋轉／捏合縮放・Q E 旋轉';

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
  updateCompass();
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
