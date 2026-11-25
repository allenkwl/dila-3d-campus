"""依 data/photo_sources.json 下載各地標照片，縮到寬 1280 存進 data/photos/，並寫出 data/photos.json（含出處）。"""
import json, os, re, sys, urllib.parse, urllib.request
from io import BytesIO
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data/photos')
os.makedirs(OUT, exist_ok=True)
UA = {'User-Agent': 'Mozilla/5.0 (campus3d)'}
DDM = 'https://www.ddm.org.tw/default-fagushan/xmdoc/cont?xsmsid=0K359565063711046420&sid='


def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40).read()


def ddm_images(sid, limit):
    html = get(DDM + sid).decode('utf-8', 'ignore')
    title = re.search(r'<title>(.*?)</title>', html, re.S)
    title = re.sub(r'\s+', ' ', title.group(1)).split('-')[0].strip() if title else ''
    urls = [urllib.parse.urljoin('https://www.ddm.org.tw/', u)
            for u in re.findall(r'<img[^>]+src="((?:https://www\.ddm\.org\.tw)?/files/file_pool/[^"]+)"', html)
            if 's__3522770' not in u]
    return [{'img': u, 'credit': '法鼓山世界佛教教育園區', 'link': DDM + sid, 'caption': title} for u in urls[:limit]]


def commons(name):
    q = urllib.parse.urlencode({'action': 'query', 'prop': 'imageinfo', 'iiprop': 'url|extmetadata',
                                'iiurlwidth': 1280, 'format': 'json', 'titles': 'File:' + name})
    p = next(iter(json.loads(get('https://commons.wikimedia.org/w/api.php?' + q))['query']['pages'].values()))
    ii = p['imageinfo'][0]; m = ii['extmetadata']
    txt = lambda k: re.sub('<[^>]+>', '', m.get(k, {}).get('value', '')).strip()
    return {'img': ii['thumburl'], 'credit': f"{txt('Artist')}／{txt('LicenseShortName')}（Wikimedia Commons）",
            'link': ii['descriptionurl'], 'caption': txt('ImageDescription')[:60]}


def main():
    src = json.load(open(os.path.join(ROOT, 'data/photo_sources.json')))
    result = {}
    for pid, items in src.items():
        if pid.startswith('_'):
            continue
        entries = []
        for it in items:
            try:
                if 'ddm' in it:
                    imgs = ddm_images(it['ddm'], 10)
                    entries += [imgs[i] for i in it['pick'] if i < len(imgs)] if 'pick' in it else imgs[:it.get('max', 4)]
                elif 'commons' in it:
                    entries.append(commons(it['commons']))
                else:
                    entries.append({'img': it['url'], 'credit': it['credit'], 'link': it['link'], 'caption': it.get('caption', '')})
            except Exception as ex:
                print('  失敗', pid, it, ex, file=sys.stderr)
        keep = src.get('_adjust', {}).get(pid, {}).get('keep')
        if keep:
            entries = [entries[i - 1] for i in keep if i <= len(entries)]
        photos = []
        for n, e in enumerate(entries[:6], 1):
            fn = f'{pid}-{n}.jpg'
            try:
                im = Image.open(BytesIO(get(e['img']))).convert('RGB')
            except Exception as ex:
                print('  下載失敗', e['img'], ex, file=sys.stderr); continue
            if im.width < 200:
                continue
            if im.width > 1280:
                im = im.resize((1280, round(im.height * 1280 / im.width)), Image.LANCZOS)
            im.save(os.path.join(OUT, fn), quality=80, optimize=True)
            photos.append({'src': f'data/photos/{fn}', 'w': im.width, 'h': im.height,
                           'credit': e['credit'], 'link': e['link'], 'caption': e.get('caption', '')})
        result[pid] = photos
        print(pid, len(photos))
    json.dump(result, open(os.path.join(ROOT, 'data/photos.json'), 'w'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
