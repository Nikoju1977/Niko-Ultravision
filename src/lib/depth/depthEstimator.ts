import type { DepthEstimate } from "./depthTypes";

const DEFAULT_ANALYSIS_MAX_SIDE = 768;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function lumaAt(data: Uint8ClampedArray, pixel: number): number {
  const i = pixel * 4;
  return data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
}

function localVariance(
  y: Float32Array,
  width: number,
  x: number,
  row: number,
): number {
  const p = row + x;
  const samples = [
    y[p - width - 1], y[p - width], y[p - width + 1],
    y[p - 1], y[p], y[p + 1],
    y[p + width - 1], y[p + width], y[p + width + 1],
  ];
  let sum = 0;
  let square = 0;
  for (const value of samples) {
    sum += value;
    square += value * value;
  }
  const mean = sum / samples.length;
  return Math.max(0, square / samples.length - mean * mean);
}

function centerWeight(x: number, y: number, width: number, height: number): number {
  const nx = (x + 0.5) / width - 0.5;
  const ny = (y + 0.5) / height - 0.5;
  const distance = Math.sqrt((nx / 0.58) ** 2 + (ny / 0.58) ** 2);
  return clamp(1 - distance, 0, 1);
}

/**
 * Produit une profondeur relative, pas une mesure métrique.
 *
 * v0.1 exploite seulement des indices présents dans l'image (micro-structure,
 * contraste local et légère pondération centrale). Une vraie estimation
 * monoculaire ONNX pourra remplacer ce module sans changer l'API du pipeline.
 */
export async function estimateRelativeDepth(
  source: HTMLCanvasElement,
  centerBias: number,
  analysisMaxSide = DEFAULT_ANALYSIS_MAX_SIDE,
): Promise<DepthEstimate> {
  const scale = Math.min(1, analysisMaxSide / Math.max(source.width, source.height));
  const width = Math.max(32, Math.round(source.width * scale));
  const height = Math.max(32, Math.round(source.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D indisponible pour l'estimation de profondeur.");

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, width, height);

  const image = ctx.getImageData(0, 0, width, height);
  const data = image.data;
  const luma = new Float32Array(width * height);

  for (let p = 0; p < luma.length; p += 1) {
    luma[p] = lumaAt(data, p);
  }

  const depth = new Float32Array(width * height);
  const structure = new Float32Array(width * height);

  for (let y = 1; y < height - 1; y += 1) {
    const row = y * width;
    for (let x = 1; x < width - 1; x += 1) {
      const p = row + x;
      const gx = Math.abs(luma[p + 1] - luma[p - 1]);
      const gy = Math.abs(luma[p + width] - luma[p - width]);
      const gradient = (gx + gy) * 0.5;
      const variance = localVariance(luma, width, x, row);

      const edgeScore = clamp((gradient - 1.5) / 36, 0, 1);
      const textureScore = clamp(Math.sqrt(variance) / 34, 0, 1);
      const structuralScore = clamp(edgeScore * 0.62 + textureScore * 0.38, 0, 1);
      const central = centerWeight(x, y, width, height);

      // Les structures mieux définies reçoivent une profondeur relative plus
      // proche. La pondération centrale est volontairement faible et réglable.
      const nearEvidence = clamp(
        structuralScore * (0.82 - centerBias * 0.16) +
          central * centerBias * 0.34,
        0,
        1,
      );

      structure[p] = structuralScore;
      depth[p] = clamp(1 - nearEvidence, 0, 1);
    }
  }

  // Recopie simple des bords depuis leur voisin intérieur pour éviter des
  // bandes artificielles dans les previews et lors de l'échantillonnage.
  for (let x = 0; x < width; x += 1) {
    depth[x] = depth[width + Math.min(width - 1, x)];
    depth[(height - 1) * width + x] = depth[(height - 2) * width + x];
    structure[x] = structure[width + Math.min(width - 1, x)];
    structure[(height - 1) * width + x] = structure[(height - 2) * width + x];
  }
  for (let y = 0; y < height; y += 1) {
    depth[y * width] = depth[y * width + 1];
    depth[y * width + width - 1] = depth[y * width + width - 2];
    structure[y * width] = structure[y * width + 1];
    structure[y * width + width - 1] = structure[y * width + width - 2];
  }

  return {
    depth: { width, height, values: depth },
    structure: { width, height, values: structure },
  };
}
