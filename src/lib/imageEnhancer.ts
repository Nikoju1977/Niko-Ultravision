import { calculateOutputSize, megapixels, type Size, type TargetId } from "./geometry";
import { PROFILES, type ProfileId } from "./profiles";
import { canAllocateCanvas, canvasLimits } from "./capability";
import { AI_MAX_SOURCE_PIXELS, loadedModel, upscaleWithAi } from "./aiUpscaler";

export type ImageFormat = "image/png" | "image/jpeg" | "image/webp";
export type EngineId = "canvas" | "ai";

export interface ImageEnhanceResult {
  blob: Blob;
  size: Size;
  mimeType: ImageFormat;
  sharpenApplied: boolean;
  /** Moteur réellement utilisé. */
  engineUsed: EngineId;
  aiScale: number | null;
  aiProvider: string | null;
}

export interface ImageTargetAssessment {
  supported: boolean;
  size: Size;
  pixelBudget: number;
  /** true quand le refus vient d'une limite mesurée, false quand c'est une estimation mémoire. */
  measured: boolean;
  reason?: string;
}

function canvasFor(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function devicePixelBudget(): number {
  return canvasLimits().estimatedPixelBudget;
}

export function assessImageTarget(source: Size, target: TargetId): ImageTargetAssessment {
  const size = calculateOutputSize(source.width, source.height, target);
  const limits = canvasLimits();
  const pixels = size.width * size.height;

  if (size.width > limits.maxDimension || size.height > limits.maxDimension) {
    return {
      supported: false,
      size,
      pixelBudget: limits.estimatedPixelBudget,
      measured: limits.measured,
      reason: `Limite navigateur mesurée : ${limits.maxDimension.toLocaleString("fr-FR")} px par côté, ${Math.max(size.width, size.height).toLocaleString("fr-FR")} px demandés.`,
    };
  }

  if (pixels > limits.estimatedPixelBudget) {
    return {
      supported: false,
      size,
      pixelBudget: limits.estimatedPixelBudget,
      measured: false,
      reason: `Budget mémoire estimé dépassé : ${megapixels(size).toFixed(1)} MP demandés pour ${(limits.estimatedPixelBudget / 1_000_000).toFixed(0)} MP jugés sûrs sur cet appareil.`,
    };
  }

  return { supported: true, size, pixelBudget: limits.estimatedPixelBudget, measured: limits.measured };
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

function release(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return;
  canvas.width = 1;
  canvas.height = 1;
}

/** Rééchantillonnage progressif, facteur 2 maximum par passe. */
function resampleTo(
  start: HTMLCanvasElement,
  output: Size,
  filter: string,
  onPass?: (pass: number) => void,
): HTMLCanvasElement {
  let canvas = start;
  let pass = 0;

  while (canvas.width !== output.width || canvas.height !== output.height) {
    pass += 1;
    const ratio = Math.min(2, output.width / canvas.width, output.height / canvas.height);
    const nextWidth = ratio > 1
      ? Math.min(output.width, Math.max(canvas.width + 1, Math.round(canvas.width * ratio)))
      : output.width;
    const nextHeight = ratio > 1
      ? Math.min(output.height, Math.max(canvas.height + 1, Math.round(canvas.height * ratio)))
      : output.height;

    const next = canvasFor(nextWidth, nextHeight);
    const nextCtx = next.getContext("2d");
    if (!nextCtx) throw new Error("Canvas 2D indisponible.");

    nextCtx.imageSmoothingEnabled = true;
    nextCtx.imageSmoothingQuality = "high";
    nextCtx.filter = filter;
    nextCtx.drawImage(canvas, 0, 0, nextWidth, nextHeight);

    release(canvas);
    canvas = next;
    onPass?.(pass);
  }

  return canvas;
}

export interface EnhanceImageOptions {
  engine?: EngineId;
  onProgress?: (value: number, label: string) => void;
}

export async function enhanceImage(
  file: File,
  target: TargetId,
  profile: ProfileId,
  format: ImageFormat,
  options: EnhanceImageOptions = {},
): Promise<ImageEnhanceResult> {
  const { engine = "canvas", onProgress } = options;

  onProgress?.(0.03, "Décodage de l'image");
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });

  let current: HTMLCanvasElement | null = null;

  try {
    const source = { width: bitmap.width, height: bitmap.height };
    const assessment = assessImageTarget(source, target);
    if (!assessment.supported) {
      throw new Error(assessment.reason ?? "Cette définition dépasse les capacités locales sûres de cet appareil.");
    }
    const output = assessment.size;

    // Test d'allocation réel : refus propre plutôt que plantage de l'onglet.
    if (!canAllocateCanvas(output.width, output.height)) {
      throw new Error(
        `Allocation refusée par le navigateur pour ${output.width.toLocaleString("fr-FR")} × ${output.height.toLocaleString("fr-FR")} px. Choisis une cible inférieure.`,
      );
    }

    current = canvasFor(bitmap.width, bitmap.height);
    const ctx = current.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D indisponible.");
    ctx.drawImage(bitmap, 0, 0);

    let engineUsed: EngineId = "canvas";
    let aiScale: number | null = null;
    let aiProvider: string | null = null;

    if (engine === "ai") {
      const model = loadedModel();
      if (!model) throw new Error("Moteur IA sélectionné mais aucun modèle n'est chargé.");
      if (source.width * source.height > AI_MAX_SOURCE_PIXELS) {
        throw new Error(
          `Source de ${megapixels(source).toFixed(1)} MP : au-delà de ${(AI_MAX_SOURCE_PIXELS / 1_000_000).toFixed(0)} MP l'inférence locale n'est plus raisonnable. Utilise le moteur Canvas.`,
        );
      }

      onProgress?.(0.08, "Inférence IA · préparation");
      const inferred = await upscaleWithAi(current, (ratio, label) => {
        onProgress?.(0.08 + ratio * 0.62, label);
      });
      release(current);
      current = inferred;
      engineUsed = "ai";
      aiScale = model.scale;
      aiProvider = model.provider;
    }

    onProgress?.(engineUsed === "ai" ? 0.72 : 0.18, "Normalisation géométrique");
    current = resampleTo(current, output, PROFILES[profile].filter, (pass) => {
      const base = engineUsed === "ai" ? 0.74 : 0.2;
      onProgress?.(Math.min(0.88, base + pass * 0.05), `Rééchantillonnage haute qualité · passe ${pass}`);
    });

    onProgress?.(0.9, "Finition locale");
    // Après une passe IA, l'accentuation Canvas ferait double emploi.
    const sharpenApplied = engineUsed === "ai" ? false : sharpen(current, PROFILES[profile].sharpen);

    onProgress?.(0.95, "Encodage du master");
    const blob = await toBlob(current, format, format === "image/png" ? 1 : 0.96);
    if (blob.size === 0) throw new Error("L'encodeur image a produit un fichier vide.");

    onProgress?.(1, "Terminé");
    return { blob, size: output, mimeType: format, sharpenApplied, engineUsed, aiScale, aiProvider };
  } finally {
    bitmap.close();
    release(current);
  }
}
