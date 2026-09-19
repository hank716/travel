#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (c) 2026 Hank Wang
"""
把一趟行程的地點逐筆解析成座標，產出一份「待人工過目」的清單。

為什麼需要這個：itinerary_items.lat/lng 以前是天氣模組順手寫的行政區質心，
不是景點座標（見 js/weather.js 的註解）。地圖的整天路線會優先吃這個欄位，
所以質心一進去，整條路線就從別的城市出發。欄位分家之後，lat/lng 只能放
真正確認過的 POI 座標 —— 這支工具就是拿來生那份座標的。

刻意**不自動寫回資料庫**：地理編碼會錯得很有自信（實測「屋島山上展望台」
的第一名在愛知縣瀨戶市、「白楽天 今治店」在中國武漢）。工具只負責把候選
攤開來、標出可疑的，最後一關一定是人看過。

用法：
    python3 tools/geocode-items.py --trip WA9NE6 > /tmp/review.json
需要環境變數 SUPABASE_URL 與 SUPABASE_SERVICE_ROLE_KEY（或用 --env 指到 .env）。
"""

import argparse, json, os, re, sys, time, urllib.parse, urllib.request

UA = "trip-planner-geocode/1.0 (personal itinerary tool)"

# 各國的合理經緯度範圍。地理編碼跨國跑掉是最常見也最好抓的錯 ——
# 光這一條就攔下了掉到中國廣州／南寧／武漢的三筆。
# 範圍要涵蓋離島，不是只有本州：日本南到与那国島(lat 24.4, lng 122.9)、
# 東到南鳥島(lng 154)。抓太緊會把沖繩整串判成「跑到國外」。
BBOX = {
    "JP": (20.0, 46.5, 122.0, 154.5),
    "TW": (21.5, 26.5, 118.0, 122.5),
    "KR": (33.0, 39.0, 124.0, 132.0),
}

# 地區後綴會讓地理編碼查無結果：「景勝館 漣亭 鞆の浦」查不到，
# 砍成「景勝館 漣亭」就查得到。跟 js/maps.js 的 stripRegionTail 同一個道理。
REGION_TAIL = re.compile(
    r"[ 　]+(?:[^ 　]{1,8}(?:都|道|府|県|市|區|区|町|村|郡)|[^ 　]{2,6}島)$"
)


def strip_region_tail(q):
    return REGION_TAIL.sub("", q).strip()


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.load(r)


def nominatim(q, limit=3):
    """OSM。POI（神社、公園、道の駅、觀光設施）命中率高，飯店餐廳常常查不到。"""
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
        {"q": q, "format": "json", "limit": str(limit), "accept-language": "ja"}
    )
    try:
        return [
            {"lat": float(r["lat"]), "lng": float(r["lon"]),
             "name": r.get("display_name", ""), "src": "osm"}
            for r in _get(url)
        ]
    except Exception:
        return []


def gsi(q):
    """國土地理院住所検索。專門補 Nominatim 的弱項：純日本地址。"""
    url = "https://msearch.gsi.go.jp/address-search/AddressSearch?" + \
        urllib.parse.urlencode({"q": q})
    try:
        out = []
        for r in _get(url):
            lng, lat = r["geometry"]["coordinates"]
            out.append({"lat": lat, "lng": lng,
                        "name": r["properties"].get("title", ""), "src": "gsi"})
        return out[:3]
    except Exception:
        return []


def in_bbox(c, cc):
    box = BBOX.get(cc)
    if not box:
        return True
    return box[0] <= c["lat"] <= box[1] and box[2] <= c["lng"] <= box[3]


def spread(cands):
    """前幾名散落在不同地區 → 同名歧義，查詢字要再寫清楚一點。"""
    pts = {(round(c["lat"], 1), round(c["lng"], 1)) for c in cands}
    return len(pts) > 1


def classify(item, cands, cc):
    if item.get("map_query") is None and not item.get("location_name"):
        return "skip-transit"     # 純移動段，本來就沒有地點
    if not cands:
        return "miss"             # 查無 → 別硬塞座標，改把 map_query 修成正式店名
    if not in_bbox(cands[0], cc):
        return "out-of-country"   # 跨國跑掉，一定是錯的
    if spread(cands):
        return "ambiguous"        # 同名歧義，人要挑
    return "ok"


def fetch_items(base, key, code):
    def api(path):
        req = urllib.request.Request(
            base.rstrip("/") + "/rest/v1/" + path,
            headers={"apikey": key, "Authorization": "Bearer " + key, "User-Agent": UA},
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)

    trips = api("trips?code=eq." + urllib.parse.quote(code) + "&select=id,title")
    if not trips:
        sys.exit("找不到行程碼 " + code)
    tid = trips[0]["id"]
    return trips[0], api(
        "itinerary_items?trip_id=eq." + tid
        + "&select=*&order=day_date.asc,start_time.asc,sort_order.asc"
    )


def load_env(path):
    try:
        txt = open(path, encoding="utf-8").read()
    except OSError:
        return
    for name in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"):
        m = re.search(name + r'\s*[:=]\s*"([^"]+)"', txt)
        if m and not os.environ.get(name):
            os.environ[name] = m.group(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--trip", required=True, help="行程碼，例如 WA9NE6")
    ap.add_argument("--cc", default="JP", help="預期國家（ISO-3166 alpha-2）")
    ap.add_argument("--env", default=".env")
    ap.add_argument("--sleep", type=float, default=1.1,
                    help="Nominatim 限速 1 req/s，別調低")
    args = ap.parse_args()

    load_env(args.env)
    base = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not (base and key):
        sys.exit("缺 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY")

    trip, items = fetch_items(base, key, args.trip)
    cache, rows = {}, []
    for it in items:
        q = (it.get("map_query") or it.get("location_name") or "").strip()
        row = {"id": it["id"], "day": it["day_date"], "title": it["title"],
               "query": q, "lat": it.get("lat"), "lng": it.get("lng")}
        if not q:
            row["status"] = "skip-transit"
            rows.append(row)
            continue
        if q not in cache:
            cands = nominatim(q)
            time.sleep(args.sleep)
            if not cands:
                stripped = strip_region_tail(q)
                if stripped != q:
                    cands = nominatim(stripped)
                    time.sleep(args.sleep)
            if not cands:
                cands = gsi(q)
                time.sleep(0.3)
            cache[q] = cands
        cands = cache[q]
        row["status"] = classify(it, cands, args.cc)
        row["candidates"] = cands
        rows.append(row)

    counts = {}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    print(json.dumps({"trip": trip, "counts": counts, "items": rows},
                     ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
