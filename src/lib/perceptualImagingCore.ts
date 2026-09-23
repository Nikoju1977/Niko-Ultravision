import { throwIfCancelled } from "./cancellation";

export interface PerceptualImagingSettings {
  /** Renforcement structurel 0..1. */
  detailStrength: number;
  /** Réduction du bruit dans les zones peu structurées 0..1. */
  denoiseStrength: number;
  /** Protection contre les halos 0..1. */
  haloProtection: number;
  /** Correction maximale de luminance par passe. */
  maxCorrection: number;
}

export interface PerceptualImagingReport {
  applied: boolean;
  processedCoverage: number;
  meanAbsCorrection: number;
  denoiseContribution: number;
  detailContribution: number;
  skippedReason?: string;
}

export const PERCEPTUAL_CORE_MAX_PIXELS = 14_000_000;
const DESKTOP_STRIP_ROWS = 160;

function runtimeSafetyBudget(width: number): {
  maxPixels: number;
  stripRows: number;
  label: string;
} {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const memory =
    typeof nav.deviceMemory === "number"
      ? nav.deviceMemory
      : null;
  const mobile = /Android|iPhone|iPad|iPod/i.test(
    navigator.userAgent,
  );

  const maxPixels = mobile
    ? memory !== null && memory <= 4
      ? 3_200_000
      : 5_500_000
    : memory !== null && memory <= 4
      ? 8_000_000
      : PERCEPTUAL_CORE_MAX_PIXELS;

  // Une bande nécessite environ trois buffers RGBA simultanés
  // (ImageData + copie source + zone de sortie). On borne donc la hauteur
  // en fonction de la largeur afin de garder le pic temporaire raisonnable.
  const maxStripBytes = mobile ? 14 * 1024 * 1024 : 36 * 1024 * 1024;
  const memoryBoundRows = Math.max(
    24,
    Math.floor(maxStripBytes / Math.max(1, width * 4 * 3)),
  );
  const stripRows = Math.max(
    24,
    Math.min(
      mobile ? 72 : DESKTOP_STRIP_ROWS,
      memoryBoundRows,
    ),
  );

  return {
    maxPixels,
    stripRows,
    label: mobile
      ? `mobile ${memory ?? "RAM ?"} Go`
      : `desktop ${memory ?? "RAM ?"} Go`,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clamp255(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function luma(
  data: Uint8ClampedArray,
  pixel: number,
): number {
  const i = pixel * 4;
  return (
    data[i] * 0.2126 +
    data[i + 1] * 0.7152 +
    data[i + 2] * 0.0722
  );
}

/**
 * Perceptual Imaging Core.
 *
 * Passe déterministe locale et mémoire bornée :
 * - lisse légèrement les zones réellement plates/bruitées ;
 * - renforce les contours déjà présents ;
 * - protège hautes lumières, ombres et halos ;
 * - applique la correction surtout sur la luminance afin de préserver la
 *   chrominance originale.
 *
 * Ce module n'invente aucun détail et n'est pas un réseau neuronal.
 */
export async function applyPerceptualImagingCore(
  canvas: HTMLCanvasElement,
  settings: PerceptualImagingSettings,
  onProgress?: (ratio: number, label: string) => void,
): Promise<PerceptualImagingReport> {
  const pixels = canvas.width * canvas.height;
  const safety = runtimeSafetyBudget(canvas.width);
  if (pixels > safety.maxPixels) {
    return {
      applied: false,
      processedCoverage: 0,
      meanAbsCorrection: 0,
      denoiseContribution: 0,
      detailContribution: 0,
      skippedReason:
        `Perceptual Imaging Core ignoré à ${(pixels / 1_000_000).toFixed(1)} MP : budget sûr ${(safety.maxPixels / 1_000_000).toFixed(1)} MP (${safety.label}).`,
    };
  }

  const detailStrength = clamp(settings.detailStrength, 0, 1);
  const denoiseStrength = clamp(settings.denoiseStrength, 0, 1);
  const haloProtection = clamp(settings.haloProtection, 0, 1);
  const maxCorrection = clamp(settings.maxCorrection, 2, 24);

  if (detailStrength <= 0 && denoiseStrength <= 0) {
    return {
      applied: false,
      processedCoverage: 0,
      meanAbsCorrection: 0,
      denoiseContribution: 0,
      detailContribution: 0,
      skippedReason: "Perceptual Imaging Core désactivé.",
    };
  }

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    return {
      applied: false,
      processedCoverage: 0,
      meanAbsCorrection: 0,
      denoiseContribution: 0,
      detailContribution: 0,
      skippedReason: "Canvas 2D indisponible.",
    };
  }

  const width = canvas.width;
  const height = canvas.height;
  let changed = 0;
  let sampled = 0;
  let correctionSum = 0;
  let denoiseSum = 0;
  let detailSum = 0;

  onProgress?.(
    0.02,
    `Perceptual Imaging Core · ${safety.label} · bandes ${safety.stripRows}px`,
  );

  for (
    let startY = 0;
    startY < height;
    startY += safety.stripRows
  ) {
    throwIfCancelled();
    const writeStart = startY;
    const writeEnd = Math.min(
      height,
      startY + safety.stripRows,
    );
    const readStart = Math.max(0, writeStart - 1);
    const readEnd = Math.min(height, writeEnd + 1);
    const readHeight = readEnd - readStart;

    const image = ctx.getImageData(
      0,
      readStart,
      width,
      readHeight,
    );
    const src = new Uint8ClampedArray(image.data);
    const dst = image.data;

    const localWriteStart = writeStart - readStart;
    const localWriteEnd = writeEnd - readStart;

    for (let y = localWriteStart; y < localWriteEnd; y += 1) {
      if ((y - localWriteStart) % 24 === 0) {
        throwIfCancelled();
      }
      if (readStart + y <= 0 || readStart + y >= height - 1) {
        continue;
      }

      for (let x = 1; x < width - 1; x += 1) {
        const p = y * width + x;
        const centerY = luma(src, p);
        const leftY = luma(src, p - 1);
        const rightY = luma(src, p + 1);
        const upY = luma(src, p - width);
        const downY = luma(src, p + width);

        const gradient =
          (Math.abs(rightY - leftY) +
            Math.abs(downY - upY)) *
          0.5;

        const neighborMean =
          (leftY + rightY + upY + downY) * 0.25;
        const localVariation =
          (
            Math.abs(leftY - centerY) +
            Math.abs(rightY - centerY) +
            Math.abs(upY - centerY) +
            Math.abs(downY - centerY)
          ) *
          0.25;

        const detailMask = clamp(
          (gradient - 2.5) / 34,
          0,
          1,
        );
        const flatMask = 1 - clamp(
          (gradient * 0.75 + localVariation * 0.65 - 1.5) /
            18,
          0,
          1,
        );

        const tonalProtection = clamp(
          Math.min(centerY, 255 - centerY) / 26,
          0.18,
          1,
        );

        const laplacian =
          centerY * 4 -
          leftY -
          rightY -
          upY -
          downY;

        const haloGuard =
          1 -
          clamp(Math.abs(laplacian) / 105, 0, 1) *
            haloProtection;

        const denoiseDelta =
          (neighborMean - centerY) *
          denoiseStrength *
          flatMask *
          clamp(localVariation / 12, 0.08, 1) *
          tonalProtection *
          0.72;

        const detailDelta =
          laplacian *
          detailStrength *
          detailMask *
          clamp(haloGuard, 0.12, 1) *
          tonalProtection *
          0.16;

        const correction = clamp(
          denoiseDelta + detailDelta,
          -maxCorrection,
          maxCorrection,
        );

        sampled += 1;
        correctionSum += Math.abs(correction);
        denoiseSum += Math.abs(denoiseDelta);
        detailSum += Math.abs(detailDelta);

        if (Math.abs(correction) < 0.35) continue;
        changed += 1;

        const i = p * 4;
        // Correction commune aux trois canaux : la teinte est conservée
        // beaucoup mieux qu'avec trois sharpen indépendants.
        dst[i] = clamp255(src[i] + correction);
        dst[i + 1] = clamp255(src[i + 1] + correction);
        dst[i + 2] = clamp255(src[i + 2] + correction);
        dst[i + 3] = src[i + 3];
      }
    }

    const putOffsetY = localWriteStart;
    const putHeight = localWriteEnd - localWriteStart;
    if (putHeight > 0) {
      const output = new ImageData(
        new Uint8ClampedArray(
          dst.buffer.slice(
            putOffsetY * width * 4,
            (putOffsetY + putHeight) * width * 4,
          ),
        ),
        width,
        putHeight,
      );
      ctx.putImageData(output, 0, writeStart);
    }

    const ratio = writeEnd / Math.max(1, height);
    onProgress?.(
      0.04 + ratio * 0.94,
      `Perceptual Imaging Core · ${Math.round(ratio * 100)} %`,
    );
    await new Promise<void>((resolve) =>
      window.setTimeout(resolve, 0),
    );
  }

  onProgress?.(1, "Perceptual Imaging Core · terminé");

  return {
    applied: sampled > 0 && changed > 0,
    processedCoverage: sampled ? changed / sampled : 0,
    meanAbsCorrection: sampled ? correctionSum / sampled : 0,
    denoiseContribution: sampled ? denoiseSum / sampled : 0,
    detailContribution: sampled ? detailSum / sampled : 0,
  };
}
