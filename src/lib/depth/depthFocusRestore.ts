import type {
  DepthBucket,
  DepthConfidenceMap,
  DepthFocusReport,
  DepthFocusSettings,
  DepthMap,
} from "./depthTypes";
import {
  DEPTH_FOCUS_MAX_PIXELS,
  sanitizeDepthFocusSettings,
} from "./depthTypes";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clamp255(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function lumaAt(data: Uint8ClampedArray, pixel: number): number {
  const i = pixel * 4;
  return data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
}

function sampleMap(
  values: Float32Array,
  width: number,
  height: number,
  nx: number,
  ny: number,
): number {
  const x = clamp(nx, 0, 1) * (width - 1);
  const y = clamp(ny, 0, 1) * (height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;

  const a = values[y0 * width + x0] * (1 - tx) + values[y0 * width + x1] * tx;
  const b = values[y1 * width + x0] * (1 - tx) + values[y1 * width + x1] * tx;
  return a * (1 - ty) + b * ty;
}

function centerWeight(x: number, y: number, width: number, height: number): number {
  const nx = (x + 0.5) / width - 0.5;
  const ny = (y + 0.5) / height - 0.5;
  const distance = Math.sqrt((nx / 0.60) ** 2 + (ny / 0.60) ** 2);
  return clamp(1 - distance, 0, 1);
}

function smoothStep(value: number): number {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function interpolateBucket(
  depth: number,
  buckets: DepthBucket[],
  feather: number,
): DepthBucket {
  const position = clamp(depth, 0, 0.999999) * (buckets.length - 1);
  const lowIndex = Math.floor(position);
  const highIndex = Math.min(buckets.length - 1, lowIndex + 1);
  const fraction = position - lowIndex;
  const low = buckets[lowIndex];
  const high = buckets[highIndex];

  if (lowIndex === highIndex || feather <= 0.001) {
    return fraction < 0.5 ? low : high;
  }

  const halfWindow = Math.max(0.02, feather * 0.5);
  const blend = smoothStep(
    (fraction - (0.5 - halfWindow)) / Math.max(0.04, halfWindow * 2),
  );
  const mix = (a: number, b: number) => a * (1 - blend) + b * blend;

  return {
    id: low.id,
    near: mix(low.near, high.near),
    far: mix(low.far, high.far),
    strength: mix(low.strength, high.strength),
    deblur: mix(low.deblur, high.deblur),
    edgeBoost: mix(low.edgeBoost, high.edgeBoost),
    noiseProtection: mix(low.noiseProtection, high.noiseProtection),
    confidenceBias: mix(low.confidenceBias, high.confidenceBias),
  };
}

export async function applyDepthFocusRestore(
  canvas: HTMLCanvasElement,
  depth: DepthMap,
  confidence: DepthConfidenceMap,
  buckets: DepthBucket[],
  settings: DepthFocusSettings,
  onProgress?: (ratio: number, label: string) => void,
): Promise<DepthFocusReport> {
  const safe = sanitizeDepthFocusSettings(settings);
  if (!safe.enabled || safe.globalStrength <= 0) {
    return {
      applied: false,
      planes: safe.planes,
      meanConfidence: 0,
      processedCoverage: 0,
      nearCoverage: 0,
      midCoverage: 0,
      farCoverage: 0,
      meanCorrection: 0,
      skippedReason: "Depth Focus Precision désactivé.",
    };
  }

  const pixels = canvas.width * canvas.height;
  if (pixels > DEPTH_FOCUS_MAX_PIXELS) {
    return {
      applied: false,
      planes: safe.planes,
      meanConfidence: 0,
      processedCoverage: 0,
      nearCoverage: 0,
      midCoverage: 0,
      farCoverage: 0,
      meanCorrection: 0,
      skippedReason: `Depth Focus Precision ignoré au-delà de ${(DEPTH_FOCUS_MAX_PIXELS / 1_000_000).toFixed(0)} MP pour préserver la mémoire locale.`,
    };
  }

  if (
    depth.width !== confidence.width ||
    depth.height !== confidence.height ||
    buckets.length === 0
  ) {
    throw new Error("Cartes ou plans Depth Focus incompatibles.");
  }

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D indisponible pour Depth Focus Precision.");

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const src = new Uint8ClampedArray(image.data);
  const dst = image.data;
  const width = canvas.width;
  const height = canvas.height;

  let processed = 0;
  let confidenceSum = 0;
  let near = 0;
  let mid = 0;
  let far = 0;
  let correctionSum = 0;

  onProgress?.(0.02, `Depth Focus Precision · ${buckets.length} plans Z`);

  for (let y = 1; y < height - 1; y += 1) {
    const ny = y / Math.max(1, height - 1);

    for (let x = 1; x < width - 1; x += 1) {
      const nx = x / Math.max(1, width - 1);
      const d = sampleMap(depth.values, depth.width, depth.height, nx, ny);
      const c = sampleMap(confidence.values, confidence.width, confidence.height, nx, ny);
      if (c < safe.confidenceGate) continue;

      const p = y * width + x;
      const i = p * 4;
      const leftPixel = p - 1;
      const rightPixel = p + 1;
      const upPixel = p - width;
      const downPixel = p + width;

      const gradient =
        (Math.abs(lumaAt(src, rightPixel) - lumaAt(src, leftPixel)) +
          Math.abs(lumaAt(src, downPixel) - lumaAt(src, upPixel))) *
        0.5;
      const edgeGate = clamp((gradient - 1.5) / 34, 0, 1);

      const bucket = interpolateBucket(d, buckets, safe.fusionFeather);
      const center = centerWeight(x, y, width, height);
      const centerBoost = 1 + center * safe.centerBias * edgeGate * 0.28;
      const structureWeight = 0.20 + edgeGate * bucket.edgeBoost;
      const noiseGuard = 1 - (1 - edgeGate) * bucket.noiseProtection * 0.62;
      const amount =
        bucket.strength *
        c *
        bucket.confidenceBias *
        structureWeight *
        noiseGuard *
        centerBoost *
        (0.82 + bucket.deblur * 0.36);

      if (amount <= 0.002) continue;

      const left = i - 4;
      const right = i + 4;
      const up = i - width * 4;
      const down = i + width * 4;
      const maxCorrection = 6 + safe.globalStrength * 16;
      let pixelCorrection = 0;

      for (let channel = 0; channel < 3; channel += 1) {
        const centerValue = src[i + channel];
        const laplacian =
          centerValue * 4 -
          src[left + channel] -
          src[right + channel] -
          src[up + channel] -
          src[down + channel];

        const correction = clamp(laplacian * amount, -maxCorrection, maxCorrection);
        dst[i + channel] = clamp255(centerValue + correction);
        pixelCorrection += Math.abs(correction);
      }
      dst[i + 3] = src[i + 3];

      processed += 1;
      confidenceSum += c;
      correctionSum += pixelCorrection / 3;
      if (d < 1 / 3) near += 1;
      else if (d < 2 / 3) mid += 1;
      else far += 1;
    }

    if (y % 80 === 0) {
      const ratio = y / Math.max(1, height - 1);
      onProgress?.(0.04 + ratio * 0.92, `Depth Focus · planification Z · ${Math.round(ratio * 100)} %`);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  }

  ctx.putImageData(image, 0, 0);
  onProgress?.(1, "Depth Focus Precision · terminé");

  const usable = Math.max(1, (width - 2) * (height - 2));
  const processedDenom = Math.max(1, processed);

  return {
    applied: processed > 0,
    planes: buckets.length,
    meanConfidence: processed ? confidenceSum / processed : 0,
    processedCoverage: processed / usable,
    nearCoverage: near / processedDenom,
    midCoverage: mid / processedDenom,
    farCoverage: far / processedDenom,
    meanCorrection: processed ? correctionSum / processed : 0,
    skippedReason: processed > 0 ? undefined : "Aucun pixel n'a dépassé le seuil de confiance.",
  };
}
