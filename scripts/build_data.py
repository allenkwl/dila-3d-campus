"""把 OSM、地形、正射影像整理成網頁用的 data/campus.json 與 data/ortho.jpg。

座標：以 config.json 的 origin 為原點的公尺座標，x 向東、z 向南、y 向上。
"""
import json, math, os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
cfg = json.load(open(os.path.join(ROOT, 'scripts/config.json')))
osm = json.load(open(os.path.join(ROOT, '.cache/osm.json')))
overrides = json.load(open(os.path.join(ROOT, 'data/overrides.json')))
LAT0, LON0 = cfg['origin']
MX = math.cos(math.radians(LAT0)) * 111320.0  # 每度經度公尺
MZ = 110574.0                                  # 每度緯度公尺


def to_xz(lat, lon):
    return ((lon - LON0) * MX, -(lat - LAT0) * MZ)


def merc(lat, lon, z):
    n = 2 ** z
    return (lon + 180) / 360 * n * 256, (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n * 256


class Raster:
    """以經緯度取樣裁切後的圖磚拼圖。"""
    def __init__(self, img, z):
        self.img, self.z = img, z
        self.px = img.load()
        self.x0, self.y0 = merc(cfg['north'], cfg['west'], z)

    def uv(self, lat, lon):
        x, y = merc(lat, lon, self.z)
        return x - self.x0, y - self.y0

    def sample(self, lat, lon):
        u, v = self.uv(lat, lon)
        W, H = self.img.size
        u = min(max(u, 0), W - 1.001); v = min(max(v, 0), H - 1.001)
        i, j = int(u), int(v); fu, fv = u - i, v - j
        def at(a, b):
            return self.px[min(a, W - 1), min(b, H - 1)]
        a, b, c, d = at(i, j), at(i + 1, j), at(i, j + 1), at(i + 1, j + 1)
        return [a[k] * (1 - fu) * (1 - fv) + b[k] * fu * (1 - fv) + c[k] * (1 - fu) * fv + d[k] * fu * fv
                for k in range(3)]


# ---------- 地形 ----------
terr_img = Image.open(os.path.join(ROOT, '.cache/terrain_z15.png')).convert('RGB')
TW, TH = terr_img.size
tp = terr_img.load()
heights = [[(lambda r, g, b: r * 256 + g + b / 256 - 32768)(*tp[x, y]) for x in range(TW)] for y in range(TH)]
terr = Raster(terr_img, 15)


def elev(lat, lon):
    u, v = terr.uv(lat, lon)
    u = min(max(u, 0), TW - 1.001); v = min(max(v, 0), TH - 1.001)
    i, j = int(u), int(v); fu, fv = u - i, v - j
    h = lambda a, b: heights[min(b, TH - 1)][min(a, TW - 1)]
    return (h(i, j) * (1 - fu) * (1 - fv) + h(i + 1, j) * fu * (1 - fv) +
            h(i, j + 1) * (1 - fu) * fv + h(i + 1, j + 1) * fu * fv)


# 輸出規則網格（每 GRID 公尺一點），網頁直接拿來建平面
GRID = 4.0
x_w, z_n = to_xz(cfg['north'], cfg['west'])
x_e, z_s = to_xz(cfg['south'], cfg['east'])
nx = int((x_e - x_w) / GRID) + 1
nz = int((z_s - z_n) / GRID) + 1
grid = []
for r in range(nz):
    z = z_n + r * GRID
    lat = LAT0 - z / MZ
    for c in range(nx):
        x = x_w + c * GRID
        lon = LON0 + x / MX
        grid.append(round(elev(lat, lon) * 10))

# ---------- 正射影像 ----------
ortho_img = Image.open(os.path.join(ROOT, '.cache/ortho_z18.jpg')).convert('RGB')
ortho = Raster(ortho_img, 18)
# 影像四角對應的公尺座標（網頁貼圖用；麥卡托在 2 公里內近似線性）
os.makedirs(os.path.join(ROOT, 'data'), exist_ok=True)
ortho_img.save(os.path.join(ROOT, 'data/ortho.jpg'), quality=82)


def is_forest(rgb):
    # 地面著色用的林地判定（比撒樹寬鬆：偏綠、不太亮即可）
    r, g, b = rgb
    return g >= r - 3 and g > b and (0.3 * r + 0.59 * g + 0.11 * b) < 125


# 每個地形格點是否為樹林（插畫風格的地面著色用），字串 '0'/'1'
forest = ''.join('1' if is_forest(ortho.sample(LAT0 - (z_n + r * GRID) / MZ, LON0 + (x_w + c * GRID) / MX)) else '0'
                 for r in range(nz) for c in range(nx))


def point_in_poly(x, z, poly):
    inside = False
    for i in range(len(poly)):
        x1, z1 = poly[i]; x2, z2 = poly[i - 1]
        if (z1 > z) != (z2 > z) and x < (x2 - x1) * (z - z1) / (z2 - z1) + x1:
            inside = not inside
    return inside


def area(poly):
    return abs(sum(poly[i - 1][0] * poly[i][1] - poly[i][0] * poly[i - 1][1] for i in range(len(poly)))) / 2


def decompose(poly, snap=1.2, min_side=3.0):
    """把近似直角的建物輪廓拆成矩形，讓每塊都能蓋真正的四坡屋頂。

    先轉到主要牆面方向，用輪廓頂點座標切成格子，再貪婪地取最大的實心矩形。
    回傳 [{cx, cz, w（沿長軸）, d, ang}]，ang 為長軸相對 +x 的弧度。
    """
    # 主方向：以邊長加權的 4θ 圓平均
    sx = sy = 0.0
    for i in range(len(poly)):
        (x1, z1), (x2, z2) = poly[i - 1], poly[i]
        L = math.hypot(x2 - x1, z2 - z1)
        a = math.atan2(z2 - z1, x2 - x1)
        sx += L * math.cos(4 * a); sy += L * math.sin(4 * a)
    th = math.atan2(sy, sx) / 4
    c, s = math.cos(-th), math.sin(-th)
    rp = [(x * c - z * s, x * s + z * c) for x, z in poly]

    def cluster(vals):
        vals = sorted(vals); out = [vals[0]]
        for v in vals[1:]:
            if v - out[-1] > snap:
                out.append(v)
        return out
    us, vs = cluster([p[0] for p in rp]), cluster([p[1] for p in rp])
    nu, nv = len(us) - 1, len(vs) - 1
    if nu < 1 or nv < 1:
        return []
    inside = [[point_in_poly((us[i] + us[i + 1]) / 2, (vs[j] + vs[j + 1]) / 2, rp) for j in range(nv)] for i in range(nu)]
    used = [[False] * nv for _ in range(nu)]
    rects = []
    while True:
        best = None
        for i0 in range(nu):
            for j0 in range(nv):
                if not inside[i0][j0] or used[i0][j0]:
                    continue
                jmax = nv
                for i1 in range(i0, nu):
                    j = j0
                    while j < jmax and inside[i1][j] and not used[i1][j]:
                        j += 1
                    jmax = j
                    if jmax == j0:
                        break
                    area_ = (us[i1 + 1] - us[i0]) * (vs[jmax] - vs[j0])
                    if best is None or area_ > best[0]:
                        best = (area_, i0, i1, j0, jmax)
        if best is None:
            break
        _, i0, i1, j0, j1 = best
        for i in range(i0, i1 + 1):
            for j in range(j0, j1):
                used[i][j] = True
        w, d = us[i1 + 1] - us[i0], vs[j1] - vs[j0]
        if min(w, d) < min_side:
            continue
        cu, cv = (us[i0] + us[i1 + 1]) / 2, (vs[j0] + vs[j1]) / 2
        cx, cz = cu * math.cos(th) - cv * math.sin(th), cu * math.sin(th) + cv * math.cos(th)
        ang = th if w >= d else th + math.pi / 2
        rects.append({'cx': round(cx, 2), 'cz': round(cz, 2), 'w': round(max(w, d), 2), 'd': round(min(w, d), 2),
                      'ang': round(ang, 4)})
    return rects


# 園區範圍：法鼓山世界佛教教育園區＋法鼓文理學院（OSM）；範圍外的建物只當灰色背景
CAMPUS_IDS = (387137553, 1255168300)
campus_polys = [[to_xz(p['lat'], p['lon']) for p in e['geometry']]
                for e in osm['elements'] if e['type'] == 'way' and e['id'] in CAMPUS_IDS]
CONTEXT_WALL, CONTEXT_ROOF = '#c8c8c4', '#a7a8a5'

# ---------- 建物 ----------
buildings = []
for e in osm['elements']:
    t = e.get('tags', {})
    if e['type'] != 'way' or 'building' not in t:
        continue
    g = e['geometry']
    clat = sum(p['lat'] for p in g) / len(g); clon = sum(p['lon'] for p in g) / len(g)
    if not (cfg['south'] < clat < cfg['north'] and cfg['west'] < clon < cfg['east']):
        continue
    ll = [(p['lat'], p['lon']) for p in g]
    if ll[0] == ll[-1]:
        ll = ll[:-1]
    ov = overrides['buildings'].get(str(e['id']), {})
    poly = [to_xz(*p) for p in ll]
    a = area(poly)
    cxz = to_xz(clat, clon)
    context = not ov.get('campus') and not any(point_in_poly(cxz[0], cxz[1], cp) for cp in campus_polys)
    ov = overrides['buildings'].get(str(e['id']), {})
    if ov.get('skip'):
        continue
    if 'height' in ov:
        h = ov['height']
    elif 'building:levels' in t:
        h = float(t['building:levels']) * 3.4
    elif t.get('building') == 'temple':
        h = 16
    elif a > 2500:
        h = 14
    elif a > 800:
        h = 11
    else:
        h = 6.5
    es = [elev(*p) for p in ll] + [elev(clat, clon)]
    # 屋頂顏色：取輪廓內影像像素的中位數（往內縮避免取到牆邊陰影）
    xs = [p[0] for p in poly]; zs = [p[1] for p in poly]
    cols = []
    step = 1.5
    xx = min(xs)
    while xx <= max(xs):
        zz = min(zs)
        while zz <= max(zs):
            if point_in_poly(xx, zz, poly):
                cols.append(ortho.sample(LAT0 - zz / MZ, LON0 + xx / MX))
            zz += step
        xx += step
    if cols:
        roof = [sorted(c[k] for c in cols)[len(cols) // 2] for k in range(3)]
    else:
        roof = [150, 150, 150]
    roof_type = ov.get('roofType', 'hip')
    eave = round(max(es) + h, 2)
    rec = {
        'id': e['id'],
        'name': ov.get('name', t.get('name', '')),
        'poly': [[round(x, 2), round(z, 2)] for x, z in poly],
        'base': round(min(es) - 1.5, 2),
        'top': eave,          # 牆頂（簷口）高度；斜屋頂另加在上面
        'height': h,
        'roof': CONTEXT_ROOF if context else ov.get('roof') or '#%02x%02x%02x' % tuple(int(v) for v in roof),
        'wall': CONTEXT_WALL if context else ov.get('wall'),
        'roofExact': context or bool(ov.get('roof')),
        'context': context,
        'base_': ov.get('base'),      # 基座（下段牆面）顏色
        'baseH': ov.get('baseH', 0),
        'colonnade': ov.get('colonnade'),   # 主體上段柱廊顏色（如大殿的白色列柱）
        'facade': None if context else ov.get('facade'),   # 立面貼圖種類：ribbon / fins / gridwood / brick / gym
        'floorH': ov.get('floorH', 3.6),
        'roofStyle': ov.get('roofStyle'),   # green：植栽屋頂
        'roofType': roof_type,
    }
    if roof_type == 'blocks':
        # 分棟量體：輪廓拆成矩形，每棟依自己的地面高度與樓層數立起來（如禪悅書苑七棟錯落）
        floors = ov.get('floors', [])
        blocks = []
        for k, r in enumerate(decompose(poly)):
            ca, sa = math.cos(r['ang']), math.sin(r['ang'])
            corners = [(r['cx'] + u * ca - v * sa, r['cz'] + u * sa + v * ca)
                       for u, v in ((-r['w'] / 2, -r['d'] / 2), (r['w'] / 2, -r['d'] / 2), (r['w'] / 2, r['d'] / 2), (-r['w'] / 2, r['d'] / 2))]
            ys = [elev(LAT0 - z / MZ, LON0 + x / MX) for x, z in corners]
            fl = floors[k] if k < len(floors) else (floors[-1] if floors else round(h / rec['floorH']))
            r.update({'base': round(min(ys) - 1.5, 2), 'ground': round(max(ys), 2), 'floors': fl,
                      'top': round(max(ys) + fl * rec['floorH'], 2)})
            blocks.append(r)
        rec['blocks'] = blocks
    elif roof_type != 'flat':
        rects = decompose(poly)
        if rects:
            main = max(rects, key=lambda r: r['w'] * r['d'])
            for r in rects:
                r['top'] = round(eave + (ov.get('mainExtra', 0) if r is main else 0), 2)
                if r is main and ov.get('tiers'):
                    r['tiers'] = ov['tiers']
            rec['parts'] = rects
            rec['overhang'] = ov.get('overhang', 1.0)
            rec['pitch'] = ov.get('pitch', 0.38)
    buildings.append(rec)

# ---------- 樹木（依正射影像的深綠色像素撒點） ----------
trees = []
import random
random.seed(7)
building_polys = [b['poly'] for b in buildings]
TS = 7.0
z = z_n + 3
while z < z_s - 3:
    x = x_w + 3
    while x < x_e - 3:
        jx = x + random.uniform(-2.5, 2.5); jz = z + random.uniform(-2.5, 2.5)
        lat = LAT0 - jz / MZ; lon = LON0 + jx / MX
        r, g, b = ortho.sample(lat, lon)
        lum = 0.3 * r + 0.59 * g + 0.11 * b
        if g > r + 4 and g > b + 2 and lum < 95 and not any(point_in_poly(jx, jz, p) for p in building_polys
                                                             if abs(p[0][0] - jx) < 120 and abs(p[0][1] - jz) < 120):
            s = random.uniform(0.75, 1.35) * (1.25 if lum < 55 else 1.0)
            trees.append([round(jx, 1), round(elev(lat, lon), 1), round(jz, 1), round(s, 2),
                          int(r * 0.9), int(g * 0.95), int(b * 0.8)])
        x += TS
    z += TS

# ---------- 特殊造型（圓塔、鐘亭等，overrides.extras） ----------
extras = []
for x in overrides.get('extras', []):
    rec = {k: v for k, v in x.items() if k not in ('latlon', 'path', '_註')}
    if 'path' in x:   # 線狀物（橋）：每點帶地面高
        rec['path'] = [[round(to_xz(*p)[0], 2), round(elev(*p), 2), round(to_xz(*p)[1], 2)] for p in x['path']]
        extras.append(rec)
        continue
    cx, cz = to_xz(*x['latlon'])
    rec.update({'x': round(cx, 2), 'z': round(cz, 2), 'y': round(elev(*x['latlon']), 2)})
    if 'alignTo' in x:
        b = next(b for b in buildings if b['id'] == x['alignTo'])
        if b.get('parts'):
            rec['ang'] = max(b['parts'], key=lambda r: r['w'] * r['d'])['ang']
        else:
            r = decompose(b['poly'])
            rec['ang'] = max(r, key=lambda r: r['w'] * r['d'])['ang'] if r else 0
        rec['y'] = b['top']    # 站在平台上
    extras.append(rec)

# ---------- 外圍地形（低解析度，讓地圖邊緣不入鏡） ----------
OB = cfg['outer']
o_img = Image.open(os.path.join(ROOT, '.cache/outer_terrain_z15.png')).convert('RGB')
o_px = o_img.load()
o_r = Raster(o_img, 15)
o_r.x0, o_r.y0 = merc(OB['north'], OB['west'], 15)
OW, OH = o_img.size


def o_elev(lat, lon):
    u, v = o_r.uv(lat, lon)
    i = min(max(int(u), 0), OW - 1); j = min(max(int(v), 0), OH - 1)
    r, g, b = o_px[i, j]
    return max(r * 256 + g + b / 256 - 32768, -1.0)   # 海底深度壓到海平面


OSTEP = 20.0
ox_w, oz_n = to_xz(OB['north'], OB['west'])
ox_e, oz_s = to_xz(OB['south'], OB['east'])
onx = int((ox_e - ox_w) / OSTEP) + 1
onz = int((oz_s - oz_n) / OSTEP) + 1
ogrid = []
for r in range(onz):
    lat = LAT0 - (oz_n + r * OSTEP) / MZ
    for c in range(onx):
        x = ox_w + c * OSTEP
        # 和內圈重疊處直接取內圈的高度，接縫才會對齊
        if x_w <= x <= x_e and z_n <= oz_n + r * OSTEP <= z_s:
            ogrid.append(round(elev(lat, LON0 + x / MX)))
        else:
            ogrid.append(round(o_elev(lat, LON0 + x / MX)))
# 外圈影像：無資料的深色海面補成海水色
o_ortho = Image.open(os.path.join(ROOT, '.cache/outer_ortho_z16.jpg')).convert('RGB')
op = o_ortho.load()
oo = Raster(o_ortho, 16)
oo.x0, oo.y0 = merc(OB['north'], OB['west'], 16)
# 只在海平面以下（地形 ≤ 0.5 公尺）的位置補海水色，避免把山的陰影誤判成海
sea = Image.new('L', o_img.size)
sp = sea.load()
for y in range(OH):
    for x in range(OW):
        r, g, b = o_px[x, y]
        sp[x, y] = 255 if r * 256 + g + b / 256 - 32768 <= 0.5 else 0
sea = sea.resize(o_ortho.size, Image.NEAREST).load()
for y in range(0, o_ortho.size[1]):
    for x in range(0, o_ortho.size[0]):
        if sea[x, y]:
            r, g, b = op[x, y]
            if r < 60 and g < 80:
                op[x, y] = (40, 104, 122)
o_ortho.save(os.path.join(ROOT, 'data/ortho_outer.jpg'), quality=78)
oforest = []
for r in range(onz):
    for c in range(onx):
        u, v = oo.uv(LAT0 - (oz_n + r * OSTEP) / MZ, LON0 + (ox_w + c * OSTEP) / MX)
        ok = 0 <= u < o_ortho.size[0] and 0 <= v < o_ortho.size[1]
        oforest.append('1' if ok and is_forest(op[int(u), int(v)]) else ('2' if ok and sea[int(u), int(v)] else '0'))
oforest = ''.join(oforest)

# 外圍樹木：內圈外 500 公尺帶狀範圍，間距較大
TS2 = 9.0
z = oz_n
while z < oz_s:
    x = ox_w
    while x < ox_e:
        inside_inner = x_w < x < x_e and z_n < z < z_s
        near = x_w - 500 < x < x_e + 500 and z_n - 500 < z < z_s + 500
        if near and not inside_inner:
            jx = x + random.uniform(-3, 3); jz = z + random.uniform(-3, 3)
            lat = LAT0 - jz / MZ; lon = LON0 + jx / MX
            u, v = oo.uv(lat, lon)
            if 0 <= u < o_ortho.size[0] and 0 <= v < o_ortho.size[1]:
                r, g, b = op[int(u), int(v)]
                lum = 0.3 * r + 0.59 * g + 0.11 * b
                if g > r + 4 and g > b + 2 and lum < 95 and o_elev(lat, lon) > 2:
                    s_ = random.uniform(0.8, 1.4)
                    trees.append([round(jx, 1), round(o_elev(lat, lon), 1), round(jz, 1), round(s_, 2),
                                  int(r * 0.9), int(g * 0.95), int(b * 0.8)])
        x += TS2
    z += TS2

# ---------- 道路與水體（插畫風格用；寫實風格由空拍圖呈現） ----------
ROAD_W = {'tertiary': 7, 'unclassified': 5.5, 'residential': 5, 'service': 4, 'footway': 2, 'path': 1.6,
          'steps': 2, 'track': 3}
roads, waters, streams = [], [], []
inside_inner = lambda x, z: x_w + 2 < x < x_e - 2 and z_n + 2 < z < z_s - 2
for e in osm['elements']:
    t = e.get('tags', {})
    if e['type'] != 'way' or 'geometry' not in e:
        continue
    pts = [to_xz(p['lat'], p['lon']) for p in e['geometry']]
    if t.get('highway') in ROAD_W:
        seg = []
        for x, z in pts:          # 只保留內圈範圍，切成連續段
            if inside_inner(x, z):
                seg.append([round(x, 1), round(z, 1)])
            elif len(seg) > 1:
                roads.append({'w': ROAD_W[t['highway']], 'pts': seg}); seg = []
            else:
                seg = []
        if len(seg) > 1:
            roads.append({'w': ROAD_W[t['highway']], 'pts': seg})
    elif t.get('natural') == 'water' or t.get('landuse') == 'basin':
        if all(inside_inner(x, z) for x, z in pts):
            waters.append([[round(x, 1), round(z, 1)] for x, z in pts])
    elif t.get('waterway') in ('stream', 'river', 'canal'):
        seg = [[round(x, 1), round(z, 1)] for x, z in pts if inside_inner(x, z)]
        if len(seg) > 1:
            streams.append({'w': 4 if t['waterway'] == 'river' else 2.2, 'pts': seg})

# ---------- 地標 ----------
places = []
for p in overrides['places']:
    if 'osm' in p:
        b = next((b for b in buildings if b['id'] == p['osm']), None)
        if b is None:
            print('找不到地標建物', p); continue
        cx = sum(v[0] for v in b['poly']) / len(b['poly']); cz = sum(v[1] for v in b['poly']) / len(b['poly'])
        y = b['top']
    else:
        cx, cz = to_xz(*p['latlon'])
        y = elev(*p['latlon']) + 4
    places.append({**{k: v for k, v in p.items() if k not in ('latlon',)}, 'x': round(cx, 1), 'y': round(y, 1), 'z': round(cz, 1)})

out = {
    'origin': cfg['origin'],
    'grid': {'x0': round(x_w, 2), 'z0': round(z_n, 2), 'step': GRID, 'nx': nx, 'nz': nz, 'h': grid, 'forest': forest},
    'ortho': {'x0': round(x_w, 2), 'z0': round(z_n, 2), 'x1': round(x_e, 2), 'z1': round(z_s, 2)},
    'outer': {'x0': round(ox_w, 2), 'z0': round(oz_n, 2), 'x1': round(ox_e, 2), 'z1': round(oz_s, 2),
              'step': OSTEP, 'nx': onx, 'nz': onz, 'h': ogrid, 'forest': oforest},
    'buildings': buildings,
    'extras': extras,
    'roads': roads, 'waters': waters, 'streams': streams,
    'trees': trees,
    'places': places,
}
json.dump(out, open(os.path.join(ROOT, 'data/campus.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
print(f'grid {nx}x{nz}, buildings {len(buildings)}, trees {len(trees)}, places {len(places)}')
