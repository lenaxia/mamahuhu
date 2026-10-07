#!/usr/bin/env python3
"""Render OCR stress fixtures: Chinese text along an arc and an S-curve.
Each char sits on the parametric curve, rotated to the local tangent.
Output: bench/images/curve-arc.png, bench/images/curve-s.png"""
from PIL import Image, ImageDraw, ImageFont
import math, os

FONT = "/home/sandbox/.fonts/NotoSansTC-Regular.ttf"
OUT = "/workspace/bench/images"
os.makedirs(OUT, exist_ok=True)

def bezier(p0, p1, p2, p3, t):
    return ((1-t)**3*p0[0] + 3*(1-t)**2*t*p1[0] + 3*(1-t)*t*t*p2[0] + t**3*p3[0],
            (1-t)**3*p0[1] + 3*(1-t)**2*t*p1[1] + 3*(1-t)*t*t*p2[1] + t**3*p3[1])

def sample_path(fn, n=2000):
    pts = [fn(i/n) for i in range(n+1)]
    seglens = [math.dist(pts[i], pts[i+1]) for i in range(n)]
    total = sum(seglens)
    cum = [0.0]
    for L in seglens:
        cum.append(cum[-1] + L)
    return pts, cum, total

def point_at(pts, cum, total, s):
    s = max(0.0, min(total, s))
    # binary search
    lo, hi = 0, len(cum) - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if cum[mid] < s: lo = mid + 1
        else: hi = mid
    i = max(1, lo)
    t = (s - cum[i-1]) / (cum[i] - cum[i-1] or 1)
    x = pts[i-1][0] + t * (pts[i][0] - pts[i-1][0])
    y = pts[i-1][1] + t * (pts[i][1] - pts[i-1][1])
    # tangent from neighbors
    j = max(0, min(len(pts) - 2, i))
    ang = math.atan2(pts[j+1][1] - pts[j][1], pts[j+1][0] - pts[j][0])
    return x, y, ang

def draw_on_curve(img, text, fn, font_size=64, start_frac=0.06, color=(20, 20, 20)):
    font = ImageFont.truetype(FONT, font_size)
    pts, cum, total = sample_path(fn)
    spacing = font_size * 1.12
    s = total * start_frac
    for ch in text:
        x, y, ang = point_at(pts, cum, total, s)
        glyph = Image.new("RGBA", (font_size * 2, font_size * 2), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glyph)
        gd.text((font_size // 2, font_size // 2), ch, font=font, fill=color + (255,))
        rotated = glyph.rotate(-math.degrees(ang), resample=Image.BICUBIC, center=(font_size, font_size))
        # char center sits on the curve, baseline offset outward along normal
        nx, ny = -math.sin(ang), math.cos(ang)
        cx, cy = x + nx * font_size * 0.36, y + ny * font_size * 0.36
        img.alpha_composite(rotated, (int(cx - font_size), int(cy - font_size)))
        s += spacing

# 1) ARC fixture — 床前明月光，疑是地上霜 along an upward arc
W, H = 1000, 700
img = Image.new("RGBA", (W, H), (255, 255, 255, 255))
cx, cy, r = W / 2, 680, 560  # 90° top arc: a from 135° to 45°
arc = lambda t: (cx + r * math.cos(math.pi * (0.75 - 0.5 * t)), cy - r * math.sin(math.pi * (0.75 - 0.5 * t)))
draw_on_curve(img, "床前明月光，疑是地上霜", arc, font_size=72)
img.convert("RGB").save(f"{OUT}/curve-arc.png")

# 2) S-CURVE fixture — 舉頭望明月，低頭思故鄉 along an S (two beziers mirrored)
W, H = 1000, 900
img = Image.new("RGBA", (W, H), (255, 255, 255, 255))
def s_curve(t):
    # S: two cubic segments, C1 (left top curve), C2 (mirrored)
    if t <= 0.5:
        return bezier((110, 160), (620, 60), (620, 320), (520, 440), t * 2)
    return bezier((520, 440), (420, 560), (420, 820), (900, 760), (t - 0.5) * 2)
draw_on_curve(img, "舉頭望明月，低頭思故鄉", s_curve, font_size=64, start_frac=0.02)
img.convert("RGB").save(f"{OUT}/curve-s.png")
print("wrote", OUT + "/curve-arc.png", OUT + "/curve-s.png")
