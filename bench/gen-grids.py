#!/usr/bin/env python3
"""Render the 5x5 poem-grid fixtures (owner-provided, meaningful text — unlike
grid-handwriting.jpg whose classical read is hallucinated and unanchorable).

grid-poem-h.png: horizontal rows, read left→right, top→bottom (modern layout)
  月落松風起 / 溪寒夜色深 / 孤舟隨水遠 / 星影入江心 / 夢回故山林
grid-poem-v.png: the SAME layout idea in the OTHER direction — each line is a
  vertical column read top→bottom, columns ordered right→left (traditional)
  春雨洗青石 / 小橋過客稀 / 燕歸簷下語 / 茶暖日初遲 / 花影滿庭衣

Visible cell borders (practice-worksheet style) so the detector sees the same
grid structure as real photos.
Output: bench/fixtures/grid-poem-h.png, bench/fixtures/grid-poem-v.png"""
from PIL import Image, ImageDraw, ImageFont
import os

FONT = "/home/sandbox/.fonts/NotoSansTC-Regular.ttf"
OUT = "/workspace/bench/fixtures"
CELL = 200
N = 5
MARGIN = 60
SIZE = MARGIN * 2 + CELL * N  # 1120

POEM_H = ["月落松風起", "溪寒夜色深", "孤舟隨水遠", "星影入江心", "夢回故山林"]
POEM_V = ["春雨洗青石", "小橋過客稀", "燕歸簷下語", "茶暖日初遲", "花影滿庭衣"]

font = ImageFont.truetype(FONT, 130)


def cell_rect(row, col):
    x = MARGIN + col * CELL
    y = MARGIN + row * CELL
    return x, y, x + CELL, y + CELL


def render(lines, vertical, path):
    img = Image.new("RGB", (SIZE, SIZE), "white")
    d = ImageDraw.Draw(img)
    # worksheet grid: outer border + inner lines
    for i in range(N + 1):
        p = MARGIN + i * CELL
        w = 4 if i in (0, N) else 2
        d.line([(p, MARGIN), (p, SIZE - MARGIN)], fill="#333", width=w)
        d.line([(MARGIN, p), (SIZE - MARGIN, p)], fill="#333", width=w)
    for li, text in enumerate(lines):
        for k, ch in enumerate(text):
            if vertical:
                # line li → column (N-1-li) (rightmost first), char k → row k
                row, col = k, N - 1 - li
            else:
                row, col = li, k
            x1, y1, x2, y2 = cell_rect(row, col)
            cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
            bb = d.textbbox((0, 0), ch, font=font)
            d.text((cx - (bb[2] - bb[0]) / 2 - bb[0], cy - (bb[3] - bb[1]) / 2 - bb[1]), ch, font=font, fill="black")
    img.save(path)
    print(path, img.size)


render(POEM_H, False, os.path.join(OUT, "grid-poem-h.png"))
render(POEM_V, True, os.path.join(OUT, "grid-poem-v.png"))
