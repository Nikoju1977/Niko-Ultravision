export interface RoiBox {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function regionScore(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
): number {
  let sum = 0;
  let sumSq = 0;
  let edges = 0;
  let edgeCount = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  const step = 2;

  for (let y = y0; y < Math.min(height - 1, y0 + h); y += step) {
    for (let x = x0; x < Math.min(width - 1, x0 + w); x += step) {
      const i = (y * width + x) * 4;
      const yv = luma(data[i], data[i + 1], data[i + 2]);
      sum += yv;
      sumSq += yv * yv;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      count += 1;

      const ir = (y * width + x + 1) * 4;
      const id = ((y + 1) * width + x) * 4;
      edges += Math.abs(yv - luma(data[ir], data[ir + 1], data[ir + 2]));
      edges += Math.abs(yv - luma(data[id], data[id + 1], data[id + 2]));
      edgeCount += 2;
    }
  }

  if (!count) return 0;
  const mean = sum / count;
  const variance = Math.max(0, sumSq / count - mean * mean);
  const contrast = Math.sqrt(variance) / 128;
  const edge = edgeCount ? edges / edgeCount / 255 : 0;
  const colorSpread = (Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(1, count * 255);

  const cx = (x0 + w * 0.5) / width;
  const cy = (y0 + h * 0.5) / height;
  const centerPrior = 1 - clamp(Math.abs(cx - 0.55) / 0.55, 0, 1);
  const lowerPrior = 1 - clamp(Math.abs(cy - 0.62) / 0.62, 0, 1);

  return edge * 0.42 + contrast * 0.28 + colorSpread * 0.10 + centerPrior * 0.10 + lowerPrior * 0.10;
}

export function detectSmallSubjectRoi(canvas: HTMLCanvasElement): RoiBox | null {
  const maxSide = 480;
  const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  const probe = document.createElement("canvas");
  probe.width = Math.max(64, Math.round(canvas.width * scale));
  probe.height = Math.max(64, Math.round(canvas.height * scale));
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  ctx.drawImage(canvas, 0, 0, probe.width, probe.height);
  const image = ctx.getImageData(0, 0, probe.width, probe.height);

  const candidates: Array<{ x: number; y: number; w: number; h: number; score: number }> = [];
  for (const ratio of [0.18, 0.24, 0.30]) {
    const w = Math.max(24, Math.round(probe.width * ratio));
    const h = Math.max(24, Math.round(probe.height * ratio));
    const stepX = Math.max(8, Math.round(w * 0.45));
    const stepY = Math.max(8, Math.round(h * 0.45));

    for (let y = Math.round(probe.height * 0.18); y + h < probe.height * 0.94; y += stepY) {
      for (let x = Math.round(probe.width * 0.08); x + w < probe.width * 0.94; x += stepX) {
        candidates.push({
          x,
          y,
          w,
          h,
          score: regionScore(image.data, probe.width, probe.height, x, y, w, h),
        });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || best.score < 0.08) return null;

  const inv = 1 / scale;
  const pad = 0.15;
  const x = Math.max(0, Math.round((best.x - best.w * pad) * inv));
  const y = Math.max(0, Math.round((best.y - best.h * pad) * inv));
  const width = Math.min(canvas.width - x, Math.round(best.w * (1 + pad * 2) * inv));
  const height = Math.min(canvas.height - y, Math.round(best.h * (1 + pad * 2) * inv));

  return {
    x,
    y,
    width,
    height,
    confidence: clamp(best.score / 0.45, 0, 1),
  };
}

export function enhanceRoiLocally(
  canvas: HTMLCanvasElement,
  roi: RoiBox,
  strength = 0.8,
): boolean {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return false;

  const x0 = clamp(Math.floor(roi.x), 0, canvas.width - 1);
  const y0 = clamp(Math.floor(roi.y), 0, canvas.height - 1);
  const width = clamp(Math.floor(roi.width), 2, canvas.width - x0);
  const height = clamp(Math.floor(roi.height), 2, canvas.height - y0);

  const image = ctx.getImageData(x0, y0, width, height);
  const src = new Uint8ClampedArray(image.data);
  const dst = image.data;
  const amount = clamp(strength, 0, 1);

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = (y * width + x) * 4;
      const left = i - 4;
      const right = i + 4;
      const up = i - width * 4;
      const down = i + width * 4;

      const featherX = Math.min(x / Math.max(1, width * 0.12), (width - 1 - x) / Math.max(1, width * 0.12), 1);
      const featherY = Math.min(y / Math.max(1, height * 0.12), (height - 1 - y) / Math.max(1, height * 0.12), 1);
      const feather = clamp(Math.min(featherX, featherY), 0, 1);
      const local = amount * feather;

      for (let c = 0; c < 3; c += 1) {
        const center = src[i + c];
        const lap =
          center * 4 -
          src[left + c] -
          src[right + c] -
          src[up + c] -
          src[down + c];
        const correction = clamp(lap * local * 0.30, -18, 18);
        dst[i + c] = clamp(center + correction, 0, 255);
      }
    }
  }

  ctx.putImageData(image, x0, y0);
  return true;
}
