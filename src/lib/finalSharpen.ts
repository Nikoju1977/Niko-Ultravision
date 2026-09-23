export interface FinalSharpenOptions {
  amount: number;
  edgeThreshold?: number;
  haloGuard?: number;
  maxCorrection?: number;
}

export interface SharpnessMeasure {
  edgeEnergy: number;
  contrast: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clamp255(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function luma(r: number, g: number, b: number): number {
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

/**
 * Mesure de netteté no-reference.
 *
 * Ce score n'est pas une mesure de fidélité absolue : il quantifie l'énergie
 * moyenne des contours sur une miniature normalisée. Il est surtout utile pour
 * comparer avant/après dans le même pipeline.
 */
export function measureCanvasSharpness(
  canvas: HTMLCanvasElement,
  maxSide = 512,
): SharpnessMeasure {
  const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  const width = Math.max(8, Math.round(canvas.width * scale));
  const height = Math.max(8, Math.round(canvas.height * scale));

  const probe = document.createElement("canvas");
  probe.width = width;
  probe.height = height;
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  if (!ctx) return { edgeEnergy: 0, contrast: 0 };

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, width, height);

  const data = ctx.getImageData(0, 0, width, height).data;
  const values = new Float32Array(width * height);
  let sum = 0;

  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const value = luma(data[i], data[i + 1], data[i + 2]);
    values[p] = value;
    sum += value;
  }

  const mean = sum / Math.max(1, values.length);
  let variance = 0;
  let edges = 0;
  let edgeCount = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      const value = values[p];
      const delta = value - mean;
      variance += delta * delta;

      if (x + 1 < width) {
        edges += Math.abs(value - values[p + 1]);
        edgeCount += 1;
      }
      if (y + 1 < height) {
        edges += Math.abs(value - values[p + width]);
        edgeCount += 1;
      }
    }
  }

  probe.width = 1;
  probe.height = 1;

  return {
    edgeEnergy: edgeCount ? edges / edgeCount / 255 : 0,
    contrast: Math.sqrt(variance / Math.max(1, values.length)) / 128,
  };
}

/**
 * Finition adaptative pour les images fixes.
 *
 * - travaille à la résolution finale ;
 * - accentue uniquement les structures déjà présentes ;
 * - réduit la correction sur les transitions extrêmes pour limiter les halos ;
 * - évite les aplats grâce au seuil de contour.
 */
function sharpenRuntimeBudget(width: number): {
  maxPixels: number;
  stripRows: number;
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
      ? 3_500_000
      : 6_000_000
    : memory !== null && memory <= 4
      ? 10_000_000
      : 16_000_000;

  const maxStripBytes = mobile ? 12 * 1024 * 1024 : 30 * 1024 * 1024;
  const stripRows = Math.max(
    24,
    Math.min(
      mobile ? 72 : 160,
      Math.floor(maxStripBytes / Math.max(1, width * 4 * 3)),
    ),
  );
  return { maxPixels, stripRows };
}

export function applyFinalAdaptiveSharpen(
  canvas: HTMLCanvasElement,
  options: FinalSharpenOptions,
): boolean {
  const amount = clamp(options.amount, 0, 1);
  if (amount <= 0.001) return false;

  const width = canvas.width;
  const height = canvas.height;
  const pixels = width * height;
  const budget = sharpenRuntimeBudget(width);
  if (pixels > budget.maxPixels) return false;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return false;

  const edgeThreshold = Math.max(0, options.edgeThreshold ?? 5);
  const haloGuard = clamp(options.haloGuard ?? 0.78, 0, 1);
  const maxCorrection = Math.max(1, options.maxCorrection ?? 14);

  for (
    let startY = 0;
    startY < height;
    startY += budget.stripRows
  ) {
    const writeStart = startY;
    const writeEnd = Math.min(
      height,
      startY + budget.stripRows,
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

    for (
      let y = localWriteStart;
      y < localWriteEnd;
      y += 1
    ) {
      const globalY = readStart + y;
      if (globalY <= 0 || globalY >= height - 1) continue;
      const row = y * width;

      for (let x = 1; x < width - 1; x += 1) {
        const p = row + x;
        const i = p * 4;

        const centerY = luma(
          src[i],
          src[i + 1],
          src[i + 2],
        );

        const li = i - 4;
        const ri = i + 4;
        const ui = i - width * 4;
        const di = i + width * 4;

        const leftY = luma(
          src[li],
          src[li + 1],
          src[li + 2],
        );
        const rightY = luma(
          src[ri],
          src[ri + 1],
          src[ri + 2],
        );
        const upY = luma(
          src[ui],
          src[ui + 1],
          src[ui + 2],
        );
        const downY = luma(
          src[di],
          src[di + 1],
          src[di + 2],
        );

        const edge =
          (
            Math.abs(rightY - leftY) +
            Math.abs(downY - upY)
          ) *
          0.5;
        if (edge < edgeThreshold) continue;

        const lapY =
          centerY * 4 -
          leftY -
          rightY -
          upY -
          downY;
        const structure = clamp(
          (edge - edgeThreshold) / 42,
          0,
          1,
        );
        const haloProtection =
          1 -
          clamp(Math.abs(lapY) / 120, 0, 1) *
            haloGuard;
        const localAmount =
          amount *
          (0.18 + structure * 0.82) *
          clamp(haloProtection, 0.18, 1);

        for (let channel = 0; channel < 3; channel += 1) {
          const center = src[i + channel];
          const lap =
            center * 4 -
            src[li + channel] -
            src[ri + channel] -
            src[ui + channel] -
            src[di + channel];

          const correction = clamp(
            lap * localAmount * 0.24,
            -maxCorrection,
            maxCorrection,
          );
          dst[i + channel] = clamp255(
            center + correction,
          );
        }
        dst[i + 3] = src[i + 3];
      }
    }

    const offset = localWriteStart * width * 4;
    const length =
      (localWriteEnd - localWriteStart) * width * 4;
    if (length > 0) {
      const output = new ImageData(
        new Uint8ClampedArray(
          dst.buffer.slice(offset, offset + length),
        ),
        width,
        localWriteEnd - localWriteStart,
      );
      ctx.putImageData(output, 0, writeStart);
    }
  }

  return true;
}

export function finalSharpenAmountForProfile(
  profile: "fidelity" | "archive" | "cinema" | "detail",
  alreadyRestored: boolean,
  aiUpscaled: boolean,
): number {
  const base =
    profile === "detail"
      ? 0.38
      : profile === "fidelity"
        ? 0.23
        : profile === "cinema"
          ? 0.20
          : 0.13;

  let amount = base;
  if (alreadyRestored) amount *= 0.62;
  if (aiUpscaled) amount *= 0.72;
  return clamp(amount, 0.06, 0.42);
}
