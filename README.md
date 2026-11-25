# 法鼓 3D 校園（雛形）

法鼓文理學院與法鼓山世界佛教教育園區的互動 3D 導覽，可旋轉、縮放、點選地標，網址帶 `?place=<地標 id>` 可直接開到該地標。

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
| `data/overrides.json` | **手動維護**：建物高度、屋頂型式、地標清單與說明 |
| `data/campus.json`、`data/ortho.jpg` | 由腳本產生，不要手改 |
| `scripts/config.json` | 場景範圍與原點 |
| `scripts/fetch_tiles.py` | 下載地形與正射影像圖磚 |
| `scripts/build_data.py` | 產生 `data/campus.json`、`data/ortho.jpg` |

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
- **建物高度多為依面積估計**，`overrides.json` 裡的數字也是估計值，需要總務處的樓層資料核對。
- 地標說明目前都是「（說明待補）」。

## 下一步

1. 跟總務處要校園配置圖與各棟樓層數，校正輪廓與高度，補上 OSM 沒有名稱的建物。
2. 地標清單與說明文字（含英文版）。
3. 重點建築（大殿、法華鐘樓、圖資館等）手工建模，取代目前的方塊。
4. 地形可改用內政部 DEM 提高精度。
