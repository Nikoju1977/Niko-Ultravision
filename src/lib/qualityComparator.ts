import { decodeImageFile } from "./imageDecode";

export interface QualityMetrics {
  /** Variance du Laplacien : énergie de micro-détail, pas une mesure optique absolue. */
  sharpness: number;
  /** Écart-type de luminance normalisé 0..1. */
  contrast: number;
  /** Énergie moyenne des contours normalisée 0..1. */
  edgeEnergy: number;
  /** Luminance moyenne 0..1. */
  meanLuma: number;
}

export interface QualityComparison {
  source: QualityMetrics;
  output: QualityMetrics;
  sharpnessGainPercent: number;
  contrastChangePercent: number;
  edgeGainPercent: number;
  meanAbsoluteError: number;
  psnr: number;
  ssim: number;
  changedPixelsPercent: number;
  width: number;
  height: number;
  sourcePreview: string;
  outputPreview: string;
  differencePreview: string;
}

const PREVIEW_MAX_SIDE = 720;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function relativeChange(before: number, after: number): number {
  if (Math.abs(before) < 1e-9) return after > before ? 100 : 0;
  return ((after - before) / before) * 100;
}

function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

async function drawBlob(
  blob: Blob,
  width: number,
  height: number,
): Promise<HTMLCanvasElement> {
  const decoded = await decodeImageFile(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Canvas 2D indisponible pour la comparaison.");

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(decoded.source, 0, 0, width, height);
    return canvas;
  } finally {
    decoded.close();
  }
}

async function comparisonGeometry(source: Blob): Promise<{ width: number; height: number }> {
  const decoded = await decodeImageFile(source);
  try {
    const scale = Math.min(1, PREVIEW_MAX_SIDE / Math.max(decoded.width, decoded.height));
    return {
      width: Math.max(16, Math.round(decoded.width * scale)),
      height: Math.max(16, Math.round(decoded.height * scale)),
    };
  } finally {
    decoded.close();
  }
}

function extractLuma(image: ImageData): Float32Array {
  const out = new Float32Array(image.width * image.height);
  const data = image.data;
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    out[p] = luma(data[i], data[i + 1], data[i + 2]);
  }
  return out;
}

function qualityMetrics(image: ImageData): QualityMetrics {
  const width = image.width;
  const height = image.height;
  const y = extractLuma(image);
  const count = Math.max(1, y.length);

  let sum = 0;
  for (let i = 0; i < count; i += 1) sum += y[i];
  const mean = sum / count;

  let variance = 0;
  let edgeSum = 0;
  let edgeCount = 0;
  let lapSum = 0;
  let lapSq = 0;
  let lapCount = 0;

  for (let yy = 0; yy < height; yy += 1) {
    for (let xx = 0; xx < width; xx += 1) {
      const i = yy * width + xx;
      const d = y[i] - mean;
      variance += d * d;

      if (xx + 1 < width) {
        edgeSum += Math.abs(y[i + 1] - y[i]);
        edgeCount += 1;
      }
      if (yy + 1 < height) {
        edgeSum += Math.abs(y[i + width] - y[i]);
        edgeCount += 1;
      }

      if (xx > 0 && xx + 1 < width && yy > 0 && yy + 1 < height) {
        const lap = y[i] * 4 - y[i - 1] - y[i + 1] - y[i - width] - y[i + width];
        lapSum += lap;
        lapSq += lap * lap;
        lapCount += 1;
      }
    }
  }

  const lapMean = lapCount ? lapSum / lapCount : 0;
  const lapVariance = lapCount ? Math.max(0, lapSq / lapCount - lapMean * lapMean) : 0;

  return {
    sharpness: lapVariance,
    contrast: Math.sqrt(variance / count) / 255,
    edgeEnergy: edgeCount ? edgeSum / edgeCount / 255 : 0,
    meanLuma: mean / 255,
  };
}

function blockSsim(a: Float32Array, b: Float32Array, width: number, height: number): number {
  const block = 8;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  let total = 0;
  let blocks = 0;

  for (let by = 0; by < height; by += block) {
    for (let bx = 0; bx < width; bx += block) {
      const xEnd = Math.min(width, bx + block);
      const yEnd = Math.min(height, by + block);
      const n = Math.max(1, (xEnd - bx) * (yEnd - by));

      let meanA = 0;
      let meanB = 0;
      for (let y = by; y < yEnd; y += 1) {
        for (let x = bx; x < xEnd; x += 1) {
          const i = y * width + x;
          meanA += a[i];
          meanB += b[i];
        }
      }
      meanA /= n;
      meanB /= n;

      let varA = 0;
      let varB = 0;
      let covariance = 0;
      for (let y = by; y < yEnd; y += 1) {
        for (let x = bx; x < xEnd; x += 1) {
          const i = y * width + x;
          const da = a[i] - meanA;
          const db = b[i] - meanB;
          varA += da * da;
          varB += db * db;
          covariance += da * db;
        }
      }

      const denom = Math.max(1, n - 1);
      varA /= denom;
      varB /= denom;
      covariance /= denom;

      const numerator = (2 * meanA * meanB + c1) * (2 * covariance + c2);
      const denominator = (meanA * meanA + meanB * meanB + c1) * (varA + varB + c2);
      total += denominator > 0 ? numerator / denominator : 1;
      blocks += 1;
    }
  }

  return blocks ? clamp(total / blocks, -1, 1) : 1;
}

function comparisonStats(
  sourceImage: ImageData,
  outputImage: ImageData,
): Pick<QualityComparison, "meanAbsoluteError" | "psnr" | "ssim" | "changedPixelsPercent"> {
  const a = extractLuma(sourceImage);
  const b = extractLuma(outputImage);
  const count = Math.max(1, Math.min(a.length, b.length));

  let absolute = 0;
  let square = 0;
  let changed = 0;

  for (let i = 0; i < count; i += 1) {
    const diff = a[i] - b[i];
    const abs = Math.abs(diff);
    absolute += abs;
    square += diff * diff;
    if (abs >= 3) changed += 1;
  }

  const mae = absolute / count;
  const mse = square / count;
  const psnr = mse <= 1e-12 ? 99 : 10 * Math.log10((255 * 255) / mse);

  return {
    meanAbsoluteError: mae,
    psnr,
    ssim: blockSsim(a, b, sourceImage.width, sourceImage.height),
    changedPixelsPercent: (changed / count) * 100,
  };
}

function differenceCanvas(sourceImage: ImageData, outputImage: ImageData): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = sourceImage.width;
  canvas.height = sourceImage.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D indisponible pour la carte de différence.");

  const out = ctx.createImageData(canvas.width, canvas.height);
  const dst = out.data;
  const a = sourceImage.data;
  const b = outputImage.data;

  for (let i = 0; i < dst.length; i += 4) {
    const dr = Math.abs(a[i] - b[i]);
    const dg = Math.abs(a[i + 1] - b[i + 1]);
    const db = Math.abs(a[i + 2] - b[i + 2]);
    const diff = clamp((dr + dg + db) / 3, 0, 255);
    const gain = clamp(diff * 4.5, 0, 255);

    // Fond sombre + chaleur croissante : la carte indique où le master diffère,
    // elle ne prétend pas dire que chaque différence est une amélioration.
    dst[i] = Math.round(gain);
    dst[i + 1] = Math.round(gain * 0.38);
    dst[i + 2] = Math.round(25 + gain * 0.12);
    dst[i + 3] = 255;
  }

  ctx.putImageData(out, 0, 0);
  return canvas;
}

export async function compareImageQuality(
  source: Blob,
  output: Blob,
): Promise<QualityComparison> {
  const geometry = await comparisonGeometry(source);
  const [sourceCanvas, outputCanvas] = await Promise.all([
    drawBlob(source, geometry.width, geometry.height),
    drawBlob(output, geometry.width, geometry.height),
  ]);

  const sourceCtx = sourceCanvas.getContext("2d", { willReadFrequently: true });
  const outputCtx = outputCanvas.getContext("2d", { willReadFrequently: true });
  if (!sourceCtx || !outputCtx) throw new Error("Canvas de comparaison indisponible.");

  const sourceImage = sourceCtx.getImageData(0, 0, geometry.width, geometry.height);
  const outputImage = outputCtx.getImageData(0, 0, geometry.width, geometry.height);
  const sourceMetrics = qualityMetrics(sourceImage);
  const outputMetrics = qualityMetrics(outputImage);
  const stats = comparisonStats(sourceImage, outputImage);
  const diff = differenceCanvas(sourceImage, outputImage);

  return {
    source: sourceMetrics,
    output: outputMetrics,
    sharpnessGainPercent: relativeChange(sourceMetrics.sharpness, outputMetrics.sharpness),
    contrastChangePercent: relativeChange(sourceMetrics.contrast, outputMetrics.contrast),
    edgeGainPercent: relativeChange(sourceMetrics.edgeEnergy, outputMetrics.edgeEnergy),
    ...stats,
    width: geometry.width,
    height: geometry.height,
    sourcePreview: sourceCanvas.toDataURL("image/jpeg", 0.9),
    outputPreview: outputCanvas.toDataURL("image/jpeg", 0.9),
    differencePreview: diff.toDataURL("image/png"),
  };
}
