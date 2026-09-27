import type { OcrLine } from "./ports";

/** Parses pixel dimensions from a PNG or JPEG buffer (no deps). */
export function parseImageDims(buf: Uint8Array): { w: number; h: number } | null {
  // PNG: IHDR at fixed offset
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const w = (buf[16]! << 24) | (buf[17]! << 16) | (buf[18]! << 8) | buf[19]!;
    const h = (buf[20]! << 24) | (buf[21]! << 16) | (buf[22]! << 8) | buf[23]!;
    return w > 0 && h > 0 ? { w, h } : null;
  }
  // JPEG: walk markers to SOFn
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1]!;
      const len = (buf[i + 2]! << 8) | buf[i + 3]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const h = (buf[i + 5]! << 8) | buf[i + 6]!;
        const w = (buf[i + 7]! << 8) | buf[i + 8]!;
        return w > 0 && h > 0 ? { w, h } : null;
      }
      i += 2 + len;
    }
  }
  return null;
}

/**
 * Heals qwen VL coordinate conventions. Empirically (raw-output dumps): the
 * model emits a 0–1000 NORMALIZED grid for BOTH axes regardless of image
 * size. Rule: when every coordinate fits a 0-1000 grid, scale x×W/1000 and
 * y×H/1000. If any coordinate exceeds 1005 (genuine absolute pixels on a
 * large image), fall back to per-axis heuristics for mixed conventions.
 */
export function normalizeBoxes(lines: OcrLine[], w: number, h: number): OcrLine[] {
  const boxed = lines.filter((l) => l.box);
  if (!boxed.length || w <= 0 || h <= 0) return lines;

  const maxCoord = Math.max(...boxed.flatMap((l) => l.box!));

  if (maxCoord <= 1005) {
    // 0-1000 grid on both axes
    return lines.map((l) => (l.box ? { ...l, box: scaleBox(l.box, w / 1000, h / 1000, w, h) } : l));
  }

  // mixed/absolute heuristics (backstop for other deployments)
  const yBeyond = boxed.some((l) => l.box![3] > h * 1.02);
  const xBeyond = boxed.some((l) => l.box![2] > w * 1.02);
  const yScale = yBeyond ? h / 1000 : 1;
  const xScale = xBeyond ? w / 1000 : 1;
  if (xScale === 1 && yScale === 1) return lines;
  return lines.map((l) => (l.box ? { ...l, box: scaleBox(l.box, xScale, yScale, w, h) } : l));
}

function scaleBox(
  box: [number, number, number, number],
  sx: number,
  sy: number,
  w: number,
  h: number,
): [number, number, number, number] {
  const x1 = Math.min(w - 1, Math.round(box[0] * sx));
  const y1 = Math.min(h - 1, Math.round(box[1] * sy));
  const x2 = Math.min(w, Math.round(box[2] * sx));
  const y2 = Math.min(h, Math.round(box[3] * sy));
  return [Math.max(0, x1), Math.max(0, y1), Math.max(x1 + 1, x2), Math.max(y1 + 1, y2)];
}
