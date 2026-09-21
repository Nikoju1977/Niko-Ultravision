export interface ZoneMasks {
  text: Float32Array;
  edge: Float32Array;
  flat: Float32Array;
  central: Float32Array;
  width: number;
  height: number;
  textCoverage: number;
  edgeCoverage: number;
  flatCoverage: number;
  centralStructure: number;
  centralCoverage: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function lumaAt(data: Uint8ClampedArray, pixel: number): number {
  const i = pixel * 4;
  return data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
}

function gradientAt(data: Uint8ClampedArray, width: number, x: number, y: number): number {
  const p = y * width + x;
  const gx = Math.abs(lumaAt(data, p + 1) - lumaAt(data, p - 1));
  const gy = Math.abs(lumaAt(data, p + width) - lumaAt(data, p - width));
  return (gx + gy) * 0.5;
}

function localVarianceAt(
  data: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
): number {
  let sum = 0;
  let sumSq = 0;
  for (let yy = -1; yy <= 1; yy += 1) {
    for (let xx = -1; xx <= 1; xx += 1) {
      const value = lumaAt(data, (y + yy) * width + x + xx);
      sum += value;
      sumSq += value * value;
    }
  }
  const mean = sum / 9;
  return Math.max(0, sumSq / 9 - mean * mean);
}

function textLikelihood(gradient: number, variance: number): number {
  // Heuristique de structures fines répétées. Ce n'est pas un OCR.
  const g = clamp((gradient - 4) / 34, 0, 1);
  const v = clamp((variance - 18) / 620, 0, 1);
  return clamp(g * (0.35 + 0.65 * v), 0, 1);
}

function edgeLikelihood(gradient: number): number {
  return clamp((gradient - 2) / 42, 0, 1);
}

function flatLikelihood(gradient: number, variance: number): number {
  const structured = Math.max(
    clamp(gradient / 18, 0, 1),
    clamp(variance / 180, 0, 1),
  );
  return 1 - structured;
}

function centralWeight(x: number, y: number, width: number, height: number): number {
  const nx = (x + 0.5) / width - 0.5;
  const ny = (y + 0.5) / height - 0.5;
  const radius = Math.sqrt((nx / 0.52) ** 2 + (ny / 0.52) ** 2);
  return clamp(1 - radius, 0, 1);
}

export function buildZoneMasks(image: ImageData): ZoneMasks {
  const { width, height, data } = image;
  const size = width * height;
  const text = new Float32Array(size);
  const edge = new Float32Array(size);
  const flat = new Float32Array(size);
  const central = new Float32Array(size);

  let textHits = 0;
  let edgeHits = 0;
  let flatHits = 0;
  let centralStructureSum = 0;
  let centralWeightSum = 0;
  let centralHits = 0;
  let total = 0;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const p = y * width + x;
      const gradient = gradientAt(data, width, x, y);
      const variance = localVarianceAt(data, width, x, y);
      const t = textLikelihood(gradient, variance);
      const e = edgeLikelihood(gradient);
      const f = flatLikelihood(gradient, variance);
      const cWeight = centralWeight(x, y, width, height);
      const c = clamp(e * (0.35 + cWeight * 0.65), 0, 1);

      text[p] = t;
      edge[p] = e;
      flat[p] = f;
      central[p] = c;

      if (c >= 0.35) centralHits += 1;
      if (t >= 0.45) textHits += 1;
      if (e >= 0.45) edgeHits += 1;
      if (f >= 0.55) flatHits += 1;
      centralStructureSum += e * cWeight;
      centralWeightSum += cWeight;
      total += 1;
    }
  }

  return {
    text,
    edge,
    flat,
    central,
    width,
    height,
    textCoverage: total ? textHits / total : 0,
    edgeCoverage: total ? edgeHits / total : 0,
    flatCoverage: total ? flatHits / total : 0,
    centralStructure: centralWeightSum ? centralStructureSum / centralWeightSum : 0,
    centralCoverage: total ? centralHits / total : 0,
  };
}

export function maskHeatmap(
  mask: Float32Array,
  width: number,
  height: number,
  kind: "text" | "edge" | "flat" | "central",
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D indisponible pour la heatmap.");

  const image = ctx.createImageData(width, height);
  const dst = image.data;

  for (let p = 0; p < mask.length; p += 1) {
    const value = clamp(mask[p], 0, 1);
    const i = p * 4;
    const intensity = Math.round(value * 255);

    if (kind === "text") {
      dst[i] = intensity;
      dst[i + 1] = Math.round(intensity * 0.78);
      dst[i + 2] = Math.round(intensity * 0.18);
    } else if (kind === "edge") {
      dst[i] = Math.round(intensity * 0.18);
      dst[i + 1] = Math.round(intensity * 0.78);
      dst[i + 2] = intensity;
    } else if (kind === "central") {
      dst[i] = Math.round(intensity * 0.60);
      dst[i + 1] = intensity;
      dst[i + 2] = Math.round(intensity * 0.45);
    } else {
      dst[i] = Math.round(intensity * 0.34);
      dst[i + 1] = Math.round(intensity * 0.48);
      dst[i + 2] = intensity;
    }
    dst[i + 3] = 255;
  }

  ctx.putImageData(image, 0, 0);
  return canvas;
}
