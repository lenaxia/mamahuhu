"""Persistent-blob hole detector: threshold sweep + cross-threshold voting.
Usage: python3 holes.py IMAGE [target_count]"""
import sys
import numpy as np
from PIL import Image
from scipy import ndimage

def detect(path, target=None):
    im = Image.open(path).convert("L")
    g = np.asarray(im).astype(float)
    lo, hi = np.percentile(g, 2), np.percentile(g, 98)
    g = np.clip((g - lo) / max(hi - lo, 1) * 255, 0, 255)
    up = 3
    big = np.asarray(Image.fromarray(g.astype(np.uint8)).resize(
        (g.shape[1]*up, g.shape[0]*up), Image.LANCZOS)).astype(float)
    votes = []
    for th in range(40, 210, 10):
        mask = big < th
        mask = ndimage.binary_opening(mask, np.ones((3,3)))
        lab, n = ndimage.label(mask)
        for i in range(1, n+1):
            ys, xs = np.where(lab == i)
            h, w = ys.max()-ys.min()+1, xs.max()-xs.min()+1
            if not (5 <= h <= 45 and 5 <= w <= 45):
                continue
            if not (0.55 <= w/h <= 1.8):
                continue
            area = len(xs)
            if area < 0.25*h*w or area > 1.2*h*w:
                continue
            votes.append((xs.mean(), ys.mean(), th, area))
    # cluster votes by center proximity
    clusters = []
    for x, y, th, area in votes:
        for c in clusters:
            if abs(c["x"]-x) < 12 and abs(c["y"]-y) < 12:
                c["pts"].append((x, y, area)); break
        else:
            clusters.append({"x": x, "y": y, "pts": [(x, y, area)]})
    out = []
    for c in clusters:
        hits = len(c["pts"])
        if hits < 3:
            continue
        xs = [p[0] for p in c["pts"]]; ys = [p[1] for p in c["pts"]]
        out.append((np.median(xs)/up, np.median(ys)/up, hits, np.median([p[2] for p in c["pts"]])/up**2))
    out.sort(key=lambda t: -t[2])
    return out

if __name__ == "__main__":
    path, target = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else None
    holes = detect(path, target)
    print(f"{path}: {len(holes)} persistent holes (x, y, votes, area) [orig px]")
    for x, y, v, a in holes:
        print(f"  ({x:6.1f},{y:6.1f}) votes={v:2d} area={a:5.0f}")
