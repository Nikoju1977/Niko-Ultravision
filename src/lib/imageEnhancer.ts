import { calculateOutputSize, megapixels, type Size, type TargetId } from "./geometry";
import { PROFILES, type ProfileId } from "./profiles";

export type ImageFormat = "image/png" | "image/jpeg" | "image/webp";

export interface ImageEnhanceResult {
  blob: Blob;
  size: Size;
  mimeType: ImageFormat;
  sharpenApplied: boolean;
}

export interface ImageTargetAssessment {
  supported: boolean;
  size: Size;
  pixelBudget: number;
  reason?: string;
}

function canvasFor(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function devicePixelBudget(): number {
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  if (memory <= 4) return 36_000_000;
  if (memory <= 8) return 70_000_000;
  return 110_000_000;
}

function canvasDimensionLimit(): number {
  const ua = navigator.userAgent.toLowerCase();
  const appleWebKit = /iphone|ipad|ipod|safari/.test(ua) && !/chrome|chromium|crios|android/.test(ua);
  return appleWebKit ? 16_384 : 32_767;
}

export function assessImageTarget(source: Size, target: TargetId): ImageTargetAssessment {
  const size = calculateOutputSize(source.width, source.height, target);
  const pixelBudget = devicePixelBudget();
  const limit = canvasDimensionLimit();
  const pixels = size.width * size.height;

  if (size.width > limit || size.height > limit) {
    return {
      supported: false,
      size,
      pixelBudget,
      reason: `Limite navigateur : un côté dépasse ${limit.toLocaleString("fr-FR")} px.`,
    };
  }

  if (pixels > pixelBudget) {
    return {
      supported: false,
      size,
      pixelBudget,
      reason: `Mémoire locale insuffisante : ${megapixels(size).toFixed(1)} MP demandés pour un budget sûr de ${(pixelBudget / 1_000_000).toFixed(0)} MP.`,
    };
  }

  return { supported: true, size, pixelBudget };
}

function assertPracticalSize(source: Size, target: TargetId): Size {
  const assessment = assessImageTarget(source, target);
  if (!assessment.supported) {
    throw new Error(assessment.reason ?? "Cette définition dépasse les capacités locales sûres de cet appareil.");
  }
  return assessment.size;
}

function sharpen(canvas: HTMLCanvasElement, amount: number): boolean {
  const pixels = canvas.width * canvas.height;
  if (amount <= 0 || pixels > 12_000_000) return false;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return false;
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const src = new Uint8ClampedArray(image.data);
  const dst = image.data;
  const width = canvas.width;
  const height = canvas.height;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = (y * width + x) * 4;
      const left = i - 4;
      const right = i + 4;
      const up = i - width * 4;
      const down = i + width * 4;

      for (let channel = 0; channel < 3; channel += 1) {
        const center = src[i + channel];
        const edge = center * 5 - src[left + channel] - src[right + channel] - src[up + channel] - src[down + channel];
        dst[i + channel] = Math.max(0, Math.min(255, Math.round(center + (edge - center) * amount)));
      }
    }
  }

  ctx.putImageData(image, 0, 0);
  return true;
}

async function toBlob(canvas: HTMLCanvasElement, format: ImageFormat, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Le navigateur n'a pas pu encoder l'image."))),
      format,
      quality,
    );
  });
}

export async function enhanceImage(
  file: File,
  target: TargetId,
  profile: ProfileId,
  format: ImageFormat,
  onProgress?: (value: number, label: string) => void,
): Promise<ImageEnhanceResult> {
  onProgress?.(0.05, "Décodage de l'image");
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });

  let current: HTMLCanvasElement | null = null;

  try {
    const source = { width: bitmap.width, height: bitmap.height };
    const output = assertPracticalSize(source, target);

    current = canvasFor(bitmap.width, bitmap.height);
    let ctx = current.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D indisponible.");
    ctx.drawImage(bitmap, 0, 0);

    let pass = 0;
    while (current.width !== output.width || current.height !== output.height) {
      pass += 1;
      const ratio = Math.min(2, output.width / current.width, output.height / current.height);
      const nextWidth = ratio > 1
        ? Math.min(output.width, Math.max(current.width + 1, Math.round(current.width * ratio)))
        : output.width;
      const nextHeight = ratio > 1
        ? Math.min(output.height, Math.max(current.height + 1, Math.round(current.height * ratio)))
        : output.height;

      const next = canvasFor(nextWidth, nextHeight);
      const nextCtx = next.getContext("2d");
      if (!nextCtx) throw new Error("Canvas 2D indisponible.");

      nextCtx.imageSmoothingEnabled = true;
      nextCtx.imageSmoothingQuality = "high";
      nextCtx.filter = PROFILES[profile].filter;
      nextCtx.drawImage(current, 0, 0, nextWidth, nextHeight);

      current.width = 1;
      current.height = 1;
      current = next;
      ctx = nextCtx;
      onProgress?.(Math.min(0.78, 0.18 + pass * 0.16), `Agrandissement haute qualité · passe ${pass}`);
    }

    onProgress?.(0.82, "Finition locale");
    const sharpenApplied = sharpen(current, PROFILES[profile].sharpen);
    onProgress?.(0.93, "Encodage du master");
    const blob = await toBlob(current, format, format === "image/png" ? 1 : 0.96);
    if (blob.size === 0) throw new Error("L'encodeur image a produit un fichier vide.");

    onProgress?.(1, "Terminé");
    return { blob, size: output, mimeType: format, sharpenApplied };
  } finally {
    bitmap.close();
    if (current) {
      current.width = 1;
      current.height = 1;
    }
  }
}
