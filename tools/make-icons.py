#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (c) 2026 Hank Wang

"""從同一份幾何定義產生所有 icon 檔（favicon.ico / 各尺寸 PNG）。

為什麼不直接把 assets/favicon.svg 丟給轉檔工具縮圖：
瀏覽器分頁只有 16–32px，而原本那版的提把只有 4 單位粗、底下還有兩隻 4 單位高的箱腳，
縮到 16px 之後提把糊成一團、箱腳變成兩點髒污 —— 看起來就是「解析度很差」。
所以這裡做兩件事：
  1. 造型簡化（提把加粗、拿掉箱腳、扣具放大），小尺寸才讀得出是行李箱
  2. 每個尺寸各自以 8 倍超取樣重畫再 LANCZOS 縮小，而不是同一張圖硬縮

用法：python3 tools/make-icons.py（需要 Pillow）
改造型時記得 assets/favicon.svg 要一起改，兩邊是同一套設計。
"""
from PIL import Image, ImageDraw

BG     = (255, 248, 239, 255)   # --bg
ACCENT = (230, 111, 75, 255)    # --accent
DARK   = (189, 79, 50, 255)     # --accent-dark

SS = 8     # 超取樣倍率
U  = 64    # 設計座標系（與 assets/favicon.svg 同一套）


def draw(size: int) -> Image.Image:
    """在 size*SS 的畫布上畫完再縮回 size，邊緣才不會鋸齒或糊掉。

    配色刻意是「橘底＋白箱」而不是網站的米白底：icon 常常疊在深色分頁列或
    手機桌布上，米底橘箱在 16px 只會變成一坨低對比的糊點。
    """
    px = size * SS
    k = px / U                                   # 設計單位 → 像素

    def s(*v):
        return [x * k for x in v]

    img = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 圓角底（品牌橘）
    d.rounded_rectangle(s(0, 0, U, U), radius=14 * k, fill=ACCENT)

    # 提把：圓角矩形外框，下半截等一下被箱體蓋掉。5 單位粗（原本 4）才撐得住 16px
    d.rounded_rectangle(s(23, 8, 41, 26), radius=8 * k, outline=BG, width=round(5 * k))

    # 箱體：拿掉箱腳，改成箱體本身往下延伸
    d.rounded_rectangle(s(9, 18, 55, 55), radius=8 * k, fill=BG)

    # 中央束帶
    d.rectangle(s(26.5, 18, 37.5, 55), fill=ACCENT)

    # 扣具：16/32px 放不下，硬畫只會糊成一團，所以只在 48px 以上才畫
    if size >= 48:
        d.rounded_rectangle(s(23, 30, 41, 41), radius=5 * k, fill=DARK)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    out = "assets/"
    # ICO 內含多種尺寸，瀏覽器各自挑最合適的一張（每張都是獨立算圖，不是同一張縮放）
    ico_sizes = [16, 32, 48, 64, 128, 256]
    frames = [draw(n) for n in ico_sizes]
    frames[-1].save(out + "favicon.ico", format="ICO",
                    sizes=[(n, n) for n in ico_sizes], append_images=frames[:-1])

    draw(180).save(out + "apple-touch-icon.png")   # iOS「加到主畫面」
    draw(192).save(out + "icon-192.png")           # Android / PWA
    draw(512).save(out + "icon-512.png")           # PWA splash、安裝清單
    print("icons written to", out)


if __name__ == "__main__":
    main()
