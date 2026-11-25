"""下載地形（AWS Terrarium）與正射影像（國土測繪中心 NLSC PHOTO2）圖磚，拼成場景範圍的影像。"""
import json, math, os, sys, time, urllib.request
from io import BytesIO
from PIL import Image
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
cfg = json.load(open(os.path.join(ROOT, 'scripts/config.json')))
CACHE = os.path.join(ROOT, '.cache/tiles'); os.makedirs(CACHE, exist_ok=True)
UA = {'User-Agent': 'campus3d-prototype'}

def tile_xy(lat, lon, z):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return x, y

def get(url, path):
    if not os.path.exists(path):
        for i in range(4):
            try:
                data = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read()
                open(path, 'wb').write(data); break
            except Exception as ex:
                print('retry', url, ex); time.sleep(2 ** i)
    return Image.open(path)

def mosaic(name, z, url_fmt, ext):
    x0, y0 = tile_xy(cfg['north'], cfg['west'], z)
    x1, y1 = tile_xy(cfg['south'], cfg['east'], z)
    tx0, ty0, tx1, ty1 = int(x0), int(y0), int(x1), int(y1)
    W, H = (tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256
    img = Image.new('RGB', (W, H))
    for tx in range(tx0, tx1 + 1):
        for ty in range(ty0, ty1 + 1):
            p = os.path.join(CACHE, f'{name}_{z}_{tx}_{ty}.{ext}')
            img.paste(get(url_fmt.format(z=z, x=tx, y=ty), p).convert('RGB'), ((tx - tx0) * 256, (ty - ty0) * 256))
    # 裁到場景範圍
    box = (round((x0 - tx0) * 256), round((y0 - ty0) * 256), round((x1 - tx0) * 256), round((y1 - ty0) * 256))
    return img.crop(box)

if __name__ == '__main__':
    what = sys.argv[1]
    if what == 'ortho':
        z = int(sys.argv[2]) if len(sys.argv) > 2 else 18
        im = mosaic('nlsc', z, 'https://wmts.nlsc.gov.tw/wmts/PHOTO2/default/GoogleMapsCompatible/{z}/{y}/{x}', 'jpg')
        im.save(os.path.join(ROOT, f'.cache/ortho_z{z}.jpg'), quality=90); print('ortho', im.size)
    elif what == 'terrain':
        z = 15
        im = mosaic('terrarium', z, 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png', 'png')
        im.save(os.path.join(ROOT, '.cache/terrain_z15.png')); print('terrain', im.size)
