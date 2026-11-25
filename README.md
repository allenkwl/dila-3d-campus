# 法鼓 3D 校園（雛形）

法鼓文理學院與法鼓山世界佛教教育園區的互動 3D 導覽，可旋轉、縮放、點選地標，網址帶 `?place=<地標 id>` 可直接開到該地標。

線上版：https://allenkwl.github.io/dila-3d-campus/

## 執行

需要用本機伺服器開（直接開 index.html 讀不到資料檔）：

```bash
cd ~/Documents/DILA/campus-3d && python3 -m http.server 8731
```

再開 http://localhost:8731/ 。整個資料夾是靜態網站，可以直接放到 GitHub Pages 或學校的主機。Three.js 從 jsDelivr CDN 載入。

## 結構

| 檔案 | 內容 |
| --- | --- |
| `index.html`、`src/app.js`、`src/style.css` | 網頁本體（Three.js） |
| `data/overrides.json` | **手動維護**：建物高度、顏色、屋頂型式、特殊造型（圓塔、鐘亭、大願橋）、地標清單與簡短說明 |
| `data/details.json` | **手動維護**：地標視窗的詳細說明、重點條列、資料來源 |
| `data/photo_sources.json` | **手動維護**：各地標照片來源（法鼓山官網、文理學院官網、Wikimedia Commons） |
| `data/photos/`、`data/photos.json` | 由 `scripts/fetch_photos.py` 產生的照片與出處；換成自拍照片時直接替換檔案、改 `photos.json` |
| `data/campus.json`、`data/ortho.jpg` | 由腳本產生，不要手改 |
| `scripts/config.json` | 場景範圍與原點 |
| `scripts/fetch_tiles.py` | 下載地形與正射影像圖磚 |
| `scripts/build_data.py` | 產生 `data/campus.json`、`data/ortho.jpg` |

## 地標視窗

點地圖上的地標標籤（或資料卡的「照片與詳細介紹」）會打開視窗：上方是照片輪播（左右鍵、滑動、縮圖切換，標示照片出處），下方是重點條列、詳細說明與資料來源。

更新照片：

```bash
python3 scripts/fetch_photos.py
```

## 更新資料

改完 `data/overrides.json` 後重建：

```bash
python3 scripts/build_data.py
```

重新抓原始資料（OSM 存在 `.cache/osm.json`）：

```bash
curl -s -A campus3d https://overpass-api.de/api/interpreter --data-urlencode 'data=[out:json][timeout:120];(way(25.2290,121.6060,25.2510,121.6260);relation(25.2290,121.6060,25.2510,121.6260)[type=multipolygon];node(25.2290,121.6060,25.2510,121.6260)[~"."~"."];);out geom;' -o .cache/osm.json
```

```bash
python3 scripts/fetch_tiles.py terrain && python3 scripts/fetch_tiles.py ortho 18
```

## 資料來源與限制

- 建物輪廓：© OpenStreetMap contributors（ODbL）。範圍內 37 棟，部分沒有名稱。
- 地面影像：國土測繪中心 NLSC 正射影像（PHOTO2，2024），政府資料開放授權。
- 地形：AWS Terrain Tiles（Terrarium，zoom 15，約 4 公尺格點）。
- 樹木：依正射影像的深綠色像素自動撒點，不是實際樹木位置。
- **建物高度依官方樓層數推估**（每層約 3.5 公尺，大殿另加高），沒有樓層資料的依面積估計，需要總務處核對。
- 地標說明取自法鼓山官網「園區介紹」與文理學院「校舍介紹」，資料卡附來源連結；曹源書苑、東校門、正門尚待確認。
- 外觀依官方文字與照片：園區為青灰石材基座＋淺咖啡磁磚牆、銅瓦低坡斜屋頂（官網〈建設理念〉：褐、灰、白三色）；文理學院行政教學大樓與揚生館為清水混凝土、禪悅書苑為抿石子，皆為平屋頂（大元建築工場專案說明）。
- 法華鐘樓的鐘亭與教育行政大樓前的白色圓塔是手工建模（`overrides.json` 的 `extras`），位置從正射影像量出。

## 下一步

1. 跟總務處要校園配置圖與各棟樓層數，校正輪廓與高度，補上 OSM 沒有名稱的建物。
2. 地標清單與說明文字（含英文版）。
3. 重點建築（大殿、法華鐘樓、圖資館等）手工建模，取代目前的方塊。
4. 地形可改用內政部 DEM 提高精度。
