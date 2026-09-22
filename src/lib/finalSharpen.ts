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
export function applyFinalAdaptiveSharpen(
  canvas: HTMLCanvasElement,
  options: FinalSharpenOptions,
): boolean {
  const amount = clamp(options.amount, 0, 1);
  if (amount <= 0.001) return false;

  const pixels = canvas.width * canvas.height;
  if (pixels > 16_000_000) return false;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return false;

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const src = new Uint8ClampedArray(image.data);
  const dst = image.data;
  const width = canvas.width;
  const height = canvas.height;
  const edgeThreshold = Math.max(0, options.edgeThreshold ?? 5);
  const haloGuard = clamp(options.haloGuard ?? 0.78, 0, 1);
  const maxCorrection = Math.max(1, options.maxCorrection ?? 14);

  const lumas = new Float32Array(width * height);
  for (let i = 0, p = 0; i < src.length; i += 4, p += 1) {
    lumas[p] = luma(src[i], src[i + 1], src[i + 2]);
  }

  for (let y = 1; y < height - 1; y += 1) {
    const row = y * width;
    for (let x = 1; x < width - 1; x += 1) {
      const p = row + x;
      const i = p * 4;

      const centerY = lumas[p];
      const leftY = lumas[p - 1];
      const rightY = lumas[p + 1];
      const upY = lumas[p - width];
      const downY = lumas[p + width];

      const edge =
        (Math.abs(rightY - leftY) + Math.abs(downY - upY)) * 0.5;
      if (edge < edgeThreshold) continue;

      const lapY = centerY * 4 - leftY - rightY - upY - downY;
      const structure = clamp((edge - edgeThreshold) / 42, 0, 1);
      const haloProtection = 1 - clamp(Math.abs(lapY) / 120, 0, 1) * haloGuard;
      const localAmount = amount * (0.18 + structure * 0.82) * clamp(haloProtection, 0.18, 1);

      const left = i - 4;
      const right = i + 4;
      const up = i - width * 4;
      const down = i + width * 4;

      for (let channel = 0; channel < 3; channel += 1) {
        const center = src[i + channel];
        const lap =
          center * 4 -
          src[left + channel] -
          src[right + channel] -
          src[up + channel] -
          src[down + channel];

        const correction = clamp(lap * localAmount * 0.24, -maxCorrection, maxCorrection);
        dst[i + channel] = clamp255(center + correction);
      }
      dst[i + 3] = src[i + 3];
    }
  }

  ctx.putImageData(image, 0, 0);
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
