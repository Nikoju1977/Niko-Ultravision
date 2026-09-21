export interface PrecisionRestoreSettings {
  enabled: boolean;
  /** Intensité générale 0..1. */
  strength: number;
  /** Priorité aux structures fines ressemblant à du texte 0..1. */
  textBias: number;
  /** Priorité aux contours d'objets 0..1. */
  edgeBias: number;
  /** Protection des aplats et zones peu structurées 0..1. */
  flatProtection: number;
  /** Seuil anti-bruit 0..1. */
  noiseGate: number;
}

export interface PrecisionRestoreReport {
  applied: boolean;
  textCoverage: number;
  edgeCoverage: number;
  flatCoverage: number;
  skippedReason?: string;
}

export const DEFAULT_PRECISION_RESTORE: PrecisionRestoreSettings = {
  enabled: true,
  strength: 0.52,
  textBias: 0.72,
  edgeBias: 0.65,
  flatProtection: 0.78,
  noiseGate: 0.22,
};

export const PRECISION_RESTORE_MAX_PIXELS = 10_000_000;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clamp255(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function sanitize(settings: PrecisionRestoreSettings): PrecisionRestoreSettings {
  return {
    enabled: Boolean(settings.enabled),
    strength: clamp(settings.strength, 0, 1),
    textBias: clamp(settings.textBias, 0, 1),
    edgeBias: clamp(settings.edgeBias, 0, 1),
    flatProtection: clamp(settings.flatProtection, 0, 1),
    noiseGate: clamp(settings.noiseGate, 0, 1),
  };
}

function buildLuma(data: Uint8ClampedArray): Float32Array {
  const pixels = data.length / 4;
  const out = new Float32Array(pixels);
  for (let p = 0; p < pixels; p += 1) {
    const i = p * 4;
    out[p] = data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
  }
  return out;
}

function localGradient(y: Float32Array, width: number, x: number, row: number): number {
  const p = row + x;
  const gx = Math.abs(y[p + 1] - y[p - 1]);
  const gy = Math.abs(y[p + width] - y[p - width]);
  return (gx + gy) * 0.5;
}

function localVariance3x3(y: Float32Array, width: number, x: number, row: number): number {
  const p = row + x;
  const indices = [
    p - width - 1, p - width, p - width + 1,
    p - 1, p, p + 1,
    p + width - 1, p + width, p + width + 1,
  ];

  let sum = 0;
  let sumSq = 0;
  for (const index of indices) {
    const value = y[index];
    sum += value;
    sumSq += value * value;
  }

  const mean = sum / 9;
  return Math.max(0, sumSq / 9 - mean * mean);
}

function textLikelihood(gradient: number, variance: number): number {
  // Le texte et les petits pictogrammes présentent souvent plusieurs ruptures
  // de luminance proches les unes des autres : gradient élevé + variance locale
  // intermédiaire/élevée. Il s'agit d'une heuristique, pas d'un OCR.
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

/**
 * UltraVision Precision Restore.
 *
 * Renforce sélectivement texte probable et contours tout en protégeant les
 * aplats. Le module reste contrast-limited : il accentue des structures déjà
 * présentes mais ne prétend pas recréer fidèlement des détails disparus.
 */
export async function applyPrecisionRestore(
  canvas: HTMLCanvasElement,
  settings: PrecisionRestoreSettings,
  onProgress?: (ratio: number, label: string) => void,
): Promise<PrecisionRestoreReport> {
  const safe = sanitize(settings);
  if (!safe.enabled || safe.strength <= 0) {
    return {
      applied: false,
      textCoverage: 0,
      edgeCoverage: 0,
      flatCoverage: 0,
      skippedReason: "Precision Restore désactivé.",
    };
  }

  const pixelCount = canvas.width * canvas.height;
  if (pixelCount > PRECISION_RESTORE_MAX_PIXELS) {
    return {
      applied: false,
      textCoverage: 0,
      edgeCoverage: 0,
      flatCoverage: 0,
      skippedReason: `Precision Restore ignoré au-delà de ${(PRECISION_RESTORE_MAX_PIXELS / 1_000_000).toFixed(0)} MP pour préserver la mémoire locale.`,
    };
  }

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    return {
      applied: false,
      textCoverage: 0,
      edgeCoverage: 0,
      flatCoverage: 0,
      skippedReason: "Canvas 2D indisponible.",
    };
  }

  onProgress?.(0.03, "Precision Restore · analyse locale");

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const src = new Uint8ClampedArray(image.data);
  const dst = image.data;
  const y = buildLuma(src);
  const width = canvas.width;
  const height = canvas.height;

  let textHits = 0;
  let edgeHits = 0;
  let flatHits = 0;
  let total = 0;

  const maxCorrection = 5 + safe.strength * 17;

  for (let yy = 1; yy < height - 1; yy += 1) {
    const row = yy * width;

    for (let x = 1; x < width - 1; x += 1) {
      total += 1;
      const pixel = row + x;
      const i = pixel * 4;

      const gradient = localGradient(y, width, x, row);
      const variance = localVariance3x3(y, width, x, row);
      const textMask = textLikelihood(gradient, variance);
      const edgeMask = edgeLikelihood(gradient);
      const flatMask = flatLikelihood(gradient, variance);

      if (textMask >= 0.45) textHits += 1;
      if (edgeMask >= 0.45) edgeHits += 1;
      if (flatMask >= 0.55) flatHits += 1;

      const structured = Math.max(textMask * safe.textBias, edgeMask * safe.edgeBias);
      const gateThreshold = safe.noiseGate * 0.55;
      const structureGate = clamp((structured - gateThreshold) / Math.max(0.08, 1 - gateThreshold), 0, 1);
      const protection = 1 - flatMask * safe.flatProtection;
      const amount = safe.strength * structureGate * protection * (0.18 + structured * 0.42);

      if (amount <= 0.001) continue;

      const left = i - 4;
      const right = i + 4;
      const up = i - width * 4;
      const down = i + width * 4;

      for (let channel = 0; channel < 3; channel += 1) {
        const center = src[i + channel];
        const laplacian =
          center * 4 -
          src[left + channel] -
          src[right + channel] -
          src[up + channel] -
          src[down + channel];

        // Les fortes corrections sont plafonnées : c'est le garde-fou anti-halo.
        const correction = clamp(laplacian * amount, -maxCorrection, maxCorrection);
        dst[i + channel] = clamp255(center + correction);
      }
      dst[i + 3] = src[i + 3];
    }

    if (yy % 96 === 0) {
      const ratio = yy / Math.max(1, height - 1);
      onProgress?.(0.06 + ratio * 0.9, `Precision Restore · ${Math.round(ratio * 100)} %`);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  }

  ctx.putImageData(image, 0, 0);
  onProgress?.(1, "Precision Restore · terminé");

  return {
    applied: true,
    textCoverage: total ? textHits / total : 0,
    edgeCoverage: total ? edgeHits / total : 0,
    flatCoverage: total ? flatHits / total : 0,
  };
}
