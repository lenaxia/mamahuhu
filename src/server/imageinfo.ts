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
 * Heals the qwen VL coordinate-convention mismatch: some backends emit
 * 0–1000 NORMALIZED boxes instead of absolute pixels. If every coordinate
 * fits inside [0,1000] while the image is larger than 1000px on either axis,
 * treat the boxes as normalized and rescale.
 */
export function normalizeBoxes(lines: OcrLine[], w: number, h: number): OcrLine[] {
  const boxes = lines.flatMap((l) => (l.box ? [l.box] : []));
  if (!boxes.length || (w <= 1005 && h <= 1005)) return lines;
  const maxCoord = Math.max(...boxes.flat());
  if (maxCoord > 1005) return lines; // already absolute pixels
  const sx = w / 1000;
  const sy = h / 1000;
  return lines.map((l) =>
    l.box
      ? {
          ...l,
          box: [
            Math.min(w - 1, Math.round(l.box[0] * sx)),
            Math.min(h - 1, Math.round(l.box[1] * sy)),
            Math.min(w, Math.round(l.box[2] * sx)),
            Math.min(h, Math.round(l.box[3] * sy)),
          ] as [number, number, number, number],
        }
      : l,
  );
}
