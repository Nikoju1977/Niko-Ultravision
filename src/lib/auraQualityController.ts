export interface AuraQualityRules {
  ssimMinimum: number;
  psnrTargetDb: number;
  facialEdgeDisplacementPx: number;
  architecturalEdgeDisplacementPx: number;
  straightnessPreservationIndex: number;
  inferenceTimeoutMs: number;
  memoryFootprintLimitMb: number;
}

export interface AuraQualityReport {
  accepted: boolean;
  ssim: number;
  psnrDb: number;
  skinEdgeDisplacementPx: number | null;
  architectureEdgeDisplacementPx: number | null;
  architectureStraightnessIndex: number | null;
  estimatedMemoryMb: number;
  failures: string[];
}

export const DEFAULT_AURA_QUALITY_RULES: AuraQualityRules = {
  ssimMinimum: 0.95,
  psnrTargetDb: 35,
  facialEdgeDisplacementPx: 1.5,
  architecturalEdgeDisplacementPx: 1.5,
  straightnessPreservationIndex: 0.98,
  inferenceTimeoutMs: 150,
  memoryFootprintLimitMb: 512,
};

interface PreparedPair {
  width: number;
  height: number;
  scaleToFull: number;
  base: Float32Array;
  ai: Float32Array;
  semantic: Uint8Array;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function semanticAt(
  x: number,
  y: number,
  width: number,
  height: number,
  semantic: Uint8Array,
  gridW: number,
  gridH: number,
): number {
  const gx = Math.min(gridW - 1, Math.floor(x * gridW / Math.max(1, width)));
  const gy = Math.min(gridH - 1, Math.floor(y * gridH / Math.max(1, height)));
  return semantic[gy * gridW + gx] ?? 0;
}

function preparePair(
  baseCanvas: HTMLCanvasElement,
  aiCanvas: HTMLCanvasElement,
  semantic: Uint8Array,
  gridW: number,
  gridH: number,
  maxSide = 320,
): PreparedPair {
  const fullWidth = baseCanvas.width;
  const fullHeight = baseCanvas.height;
  const scale = Math.min(1, maxSide / Math.max(fullWidth, fullHeight));
  const width = Math.max(32, Math.round(fullWidth * scale));
  const height = Math.max(32, Math.round(fullHeight * scale));
  const baseProbe = document.createElement("canvas");
  const aiProbe = document.createElement("canvas");
  baseProbe.width = aiProbe.width = width;
  baseProbe.height = aiProbe.height = height;

  const bctx = baseProbe.getContext("2d", { willReadFrequently: true });
  const actx = aiProbe.getContext("2d", { willReadFrequently: true });
  if (!bctx || !actx) throw new Error("Canvas métrologique AV-1X indisponible.");

  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = "high";
  actx.imageSmoothingEnabled = true;
  actx.imageSmoothingQuality = "high";
  bctx.drawImage(baseCanvas, 0, 0, width, height);
  actx.drawImage(aiCanvas, 0, 0, width, height);

  const bd = bctx.getImageData(0, 0, width, height).data;
  const ad = actx.getImageData(0, 0, width, height).data;
  const base = new Float32Array(width * height);
  const ai = new Float32Array(width * height);
  const semanticProbe = new Uint8Array(width * height);

  for (let p = 0, i = 0; p < base.length; p += 1, i += 4) {
    base[p] = luma(bd[i], bd[i + 1], bd[i + 2]);
    ai[p] = luma(ad[i], ad[i + 1], ad[i + 2]);
    const x = p % width;
    const y = Math.floor(p / width);
    semanticProbe[p] = semanticAt(x, y, width, height, semantic, gridW, gridH);
  }

  return {
    width,
    height,
    scaleToFull: fullWidth / width,
    base,
    ai,
    semantic: semanticProbe,
  };
}

function globalMetrics(pair: PreparedPair): { ssim: number; psnrDb: number } {
  const { base, ai } = pair;
  const n = Math.max(1, Math.min(base.length, ai.length));
  let meanA = 0;
  let meanB = 0;
  let mse = 0;

  for (let i = 0; i < n; i += 1) {
    meanA += base[i];
    meanB += ai[i];
    const d = base[i] - ai[i];
    mse += d * d;
  }
  meanA /= n;
  meanB /= n;
  mse /= n;

  let varA = 0;
  let varB = 0;
  let covariance = 0;
  for (let i = 0; i < n; i += 1) {
    const da = base[i] - meanA;
    const db = ai[i] - meanB;
    varA += da * da;
    varB += db * db;
    covariance += da * db;
  }
  const denom = Math.max(1, n - 1);
  varA /= denom;
  varB /= denom;
  covariance /= denom;

  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  const ssimNumerator = (2 * meanA * meanB + c1) * (2 * covariance + c2);
  const ssimDenominator = (meanA * meanA + meanB * meanB + c1) * (varA + varB + c2);
  const ssim = ssimDenominator > 0 ? ssimNumerator / ssimDenominator : 1;
  const psnrDb = mse <= 1e-12 ? 99 : 10 * Math.log10((255 * 255) / mse);

  return { ssim: clamp(ssim, -1, 1), psnrDb };
}

function sobel(
  image: Float32Array,
  width: number,
  height: number,
): { magnitude: Float32Array; orientation: Float32Array } {
  const magnitude = new Float32Array(image.length);
  const orientation = new Float32Array(image.length);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const tl = image[i - width - 1];
      const tc = image[i - width];
      const tr = image[i - width + 1];
      const ml = image[i - 1];
      const mr = image[i + 1];
      const bl = image[i + width - 1];
      const bc = image[i + width];
      const br = image[i + width + 1];

      const gx = -tl + tr - 2 * ml + 2 * mr - bl + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      magnitude[i] = Math.hypot(gx, gy);
      orientation[i] = Math.atan2(gy, gx);
    }
  }
  return { magnitude, orientation };
}

function edgeThreshold(magnitude: Float32Array): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < magnitude.length; i += 3) {
    sum += magnitude[i];
    count += 1;
  }
  return Math.max(24, (sum / Math.max(1, count)) * 1.7);
}

function circularOrientationDistance(a: number, b: number): number {
  let d = Math.abs(a - b) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d;
}

function edgeDisplacementForClass(
  pair: PreparedPair,
  semanticClass: number,
): { displacementPx: number | null; straightnessIndex: number | null } {
  const { width, height, base, ai, semantic, scaleToFull } = pair;
  const be = sobel(base, width, height);
  const ae = sobel(ai, width, height);
  const bt = edgeThreshold(be.magnitude);
  const at = edgeThreshold(ae.magnitude);
  const radius = 5;
  let totalDistance = 0;
  let matches = 0;
  let orientationScore = 0;
  let orientationMatches = 0;

  for (let y = radius; y < height - radius; y += 1) {
    for (let x = radius; x < width - radius; x += 1) {
      const i = y * width + x;
      if (semantic[i] !== semanticClass || be.magnitude[i] < bt) continue;

      let bestDistance = Infinity;
      let bestIndex = -1;
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const j = (y + dy) * width + (x + dx);
          if (semantic[j] !== semanticClass || ae.magnitude[j] < at) continue;
          const distance = Math.hypot(dx, dy);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = j;
          }
        }
      }

      if (bestIndex >= 0) {
        totalDistance += bestDistance * scaleToFull;
        matches += 1;
        const angle = circularOrientationDistance(
          be.orientation[i],
          ae.orientation[bestIndex],
        );
        orientationScore += 1 - clamp(angle / (Math.PI / 2), 0, 1);
        orientationMatches += 1;
      }
    }
  }

  return {
    displacementPx: matches ? totalDistance / matches : null,
    straightnessIndex: orientationMatches ? orientationScore / orientationMatches : null,
  };
}

export function estimateAuraMemoryMb(
  width: number,
  height: number,
  canvasCopies = 5,
): number {
  return width * height * 4 * canvasCopies / 1024 / 1024;
}

export function validateAuraGeneration(
  deterministic: HTMLCanvasElement,
  ai: HTMLCanvasElement,
  semantic: Uint8Array,
  gridW: number,
  gridH: number,
  rules: AuraQualityRules = DEFAULT_AURA_QUALITY_RULES,
): AuraQualityReport {
  const pair = preparePair(deterministic, ai, semantic, gridW, gridH);
  const global = globalMetrics(pair);
  const skin = edgeDisplacementForClass(pair, 2);
  const architecture = edgeDisplacementForClass(pair, 3);
  const estimatedMemoryMb = estimateAuraMemoryMb(ai.width, ai.height);
  const failures: string[] = [];

  if (global.ssim < rules.ssimMinimum) {
    failures.push(
      `SSIM global ${global.ssim.toFixed(4)} < ${rules.ssimMinimum.toFixed(2)}`,
    );
  }
  if (global.psnrDb < rules.psnrTargetDb) {
    failures.push(
      `PSNR ${global.psnrDb.toFixed(2)} dB < cible ${rules.psnrTargetDb.toFixed(1)} dB`,
    );
  }
  if (
    skin.displacementPx !== null &&
    skin.displacementPx > rules.facialEdgeDisplacementPx
  ) {
    failures.push(
      `déplacement des arêtes peau ${skin.displacementPx.toFixed(2)} px > ${rules.facialEdgeDisplacementPx.toFixed(1)} px`,
    );
  }
  if (
    architecture.displacementPx !== null &&
    architecture.displacementPx > rules.architecturalEdgeDisplacementPx
  ) {
    failures.push(
      `déplacement des lignes architecturales ${architecture.displacementPx.toFixed(2)} px > ${rules.architecturalEdgeDisplacementPx.toFixed(1)} px`,
    );
  }
  if (
    architecture.straightnessIndex !== null &&
    architecture.straightnessIndex < rules.straightnessPreservationIndex
  ) {
    failures.push(
      `préservation d'orientation architecturale ${architecture.straightnessIndex.toFixed(4)} < ${rules.straightnessPreservationIndex.toFixed(2)}`,
    );
  }
  if (estimatedMemoryMb > rules.memoryFootprintLimitMb) {
    failures.push(
      `empreinte mémoire estimée ${estimatedMemoryMb.toFixed(0)} Mo > ${rules.memoryFootprintLimitMb} Mo`,
    );
  }

  return {
    accepted: failures.length === 0,
    ssim: global.ssim,
    psnrDb: global.psnrDb,
    skinEdgeDisplacementPx: skin.displacementPx,
    architectureEdgeDisplacementPx: architecture.displacementPx,
    architectureStraightnessIndex: architecture.straightnessIndex,
    estimatedMemoryMb,
    failures,
  };
}

function lanczosKernel(x: number, a = 3): number {
  const ax = Math.abs(x);
  if (ax < 1e-9) return 1;
  if (ax >= a) return 0;
  const pix = Math.PI * x;
  return (Math.sin(pix) / pix) * (Math.sin(pix / a) / (pix / a));
}

export function lanczos3Resample(
  source: HTMLCanvasElement,
  width: number,
  height: number,
): HTMLCanvasElement {
  if (source.width === width && source.height === height) {
    const clone = document.createElement("canvas");
    clone.width = width;
    clone.height = height;
    clone.getContext("2d")?.drawImage(source, 0, 0);
    return clone;
  }

  const srcCtx = source.getContext("2d", { willReadFrequently: true });
  if (!srcCtx) throw new Error("Canvas Lanczos3 source indisponible.");
  const src = srcCtx.getImageData(0, 0, source.width, source.height).data;
  const horizontal = new Float32Array(width * source.height * 4);
  const scaleX = source.width / width;

  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const center = (x + 0.5) * scaleX - 0.5;
      const left = Math.floor(center - 3 + 1);
      const right = Math.ceil(center + 3);
      let sumW = 0;
      const acc = [0, 0, 0, 0];
      for (let sx = left; sx <= right; sx += 1) {
        const clampedX = clamp(sx, 0, source.width - 1);
        const w = lanczosKernel(center - sx);
        if (w === 0) continue;
        const si = (y * source.width + clampedX) * 4;
        for (let c = 0; c < 4; c += 1) acc[c] += src[si + c] * w;
        sumW += w;
      }
      const di = (y * width + x) * 4;
      const norm = Math.abs(sumW) > 1e-9 ? sumW : 1;
      for (let c = 0; c < 4; c += 1) horizontal[di + c] = acc[c] / norm;
    }
  }

  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const outCtx = out.getContext("2d");
  if (!outCtx) throw new Error("Canvas Lanczos3 sortie indisponible.");
  const image = outCtx.createImageData(width, height);
  const scaleY = source.height / height;

  for (let y = 0; y < height; y += 1) {
    const center = (y + 0.5) * scaleY - 0.5;
    const top = Math.floor(center - 3 + 1);
    const bottom = Math.ceil(center + 3);
    for (let x = 0; x < width; x += 1) {
      let sumW = 0;
      const acc = [0, 0, 0, 0];
      for (let sy = top; sy <= bottom; sy += 1) {
        const clampedY = clamp(sy, 0, source.height - 1);
        const w = lanczosKernel(center - sy);
        if (w === 0) continue;
        const si = (clampedY * width + x) * 4;
        for (let c = 0; c < 4; c += 1) acc[c] += horizontal[si + c] * w;
        sumW += w;
      }
      const di = (y * width + x) * 4;
      const norm = Math.abs(sumW) > 1e-9 ? sumW : 1;
      for (let c = 0; c < 4; c += 1) {
        image.data[di + c] = Math.round(clamp(acc[c] / norm, 0, 255));
      }
    }
  }

  outCtx.putImageData(image, 0, 0);
  return out;
}
