import { calculateOutputSize, megapixels, type Size, type TargetId } from "./geometry";
import { PROFILES, type ProfileId } from "./profiles";
import { canAllocateCanvas, canvasLimits } from "./capability";
import { AI_MAX_SOURCE_PIXELS, loadedModel, upscaleWithAi } from "./aiUpscaler";
import { decodeImageFile } from "./imageDecode";
import {
  applyDeepFocus,
  DEFAULT_DEEP_FOCUS,
  type DeepFocusSettings,
} from "./deepFocus";
import {
  applyPrecisionRestore,
  DEFAULT_PRECISION_RESTORE,
  type PrecisionRestoreSettings,
} from "./precisionRestore";
import { buildDepthBuckets } from "./depth/depthBuckets";
import { buildDepthConfidenceMap } from "./depth/depthConfidence";
import { estimateRelativeDepth } from "./depth/depthEstimator";
import { applyDepthFocusRestore } from "./depth/depthFocusRestore";
import {
  DEFAULT_DEPTH_FOCUS,
  type DepthFocusSettings,
} from "./depth/depthTypes";
import {
  applyFinalAdaptiveSharpen,
  finalSharpenAmountForProfile,
  measureCanvasSharpness,
} from "./finalSharpen";
import { detectSmallSubjectRoi, enhanceRoiLocally } from "./roiSubject";

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
  aiPasses: number;
  aiPreparedInput: boolean;
  aiPreparedSourceMegapixels: number;
  aiPreparedWorkingMegapixels: number;
  deepFocusApplied: boolean;
  deepFocusLayers: number;
  deepFocusConfidence: number;
  deepFocusReason?: string;
  precisionRestoreApplied: boolean;
  precisionTextCoverage: number;
  precisionEdgeCoverage: number;
  precisionFlatCoverage: number;
  precisionRestoreReason?: string;
  depthFocusApplied: boolean;
  depthFocusPlanes: number;
  depthFocusConfidence: number;
  depthFocusCoverage: number;
  depthFocusNearCoverage: number;
  depthFocusMidCoverage: number;
  depthFocusFarCoverage: number;
  depthFocusMeanCorrection: number;
  depthFocusReason?: string;
  sharpnessBefore: number;
  sharpnessAfter: number;
  sharpnessGain: number;
  roiApplied: boolean;
  roiConfidence: number;
  roiBox: { x: number; y: number; width: number; height: number } | null;
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
  deepFocus?: DeepFocusSettings;
  precisionRestore?: PrecisionRestoreSettings;
  depthFocusPrecision?: DepthFocusSettings;
  smallSubjectRoi?: { enabled: boolean; strength?: number };
  onProgress?: (value: number, label: string) => void;
}

export async function enhanceImage(
  file: File,
  target: TargetId,
  profile: ProfileId,
  format: ImageFormat,
  options: EnhanceImageOptions = {},
): Promise<ImageEnhanceResult> {
  const {
    engine = "canvas",
    deepFocus = DEFAULT_DEEP_FOCUS,
    precisionRestore = DEFAULT_PRECISION_RESTORE,
    depthFocusPrecision = DEFAULT_DEPTH_FOCUS,
    smallSubjectRoi = { enabled: false, strength: 0.82 },
    onProgress,
  } = options;

  onProgress?.(0.03, "Décodage de l'image");
  const decoded = await decodeImageFile(file);

  let current: HTMLCanvasElement | null = null;

  try {
    const source = { width: decoded.width, height: decoded.height };
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

    current = canvasFor(decoded.width, decoded.height);
    const ctx = current.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D indisponible.");
    ctx.drawImage(decoded.source, 0, 0);

    let deepFocusApplied = false;
    let deepFocusLayers = deepFocus.layers;
    let deepFocusConfidence = 0;
    let deepFocusReason: string | undefined;

    if (deepFocus.enabled) {
      const report = await applyDeepFocus(current, deepFocus, (ratio, label) => {
        onProgress?.(0.06 + ratio * 0.16, label);
      });
      deepFocusApplied = report.applied;
      deepFocusLayers = report.layers;
      deepFocusConfidence = report.confidence;
      deepFocusReason = report.skippedReason;
    }

    let precisionRestoreApplied = false;
    let precisionTextCoverage = 0;
    let precisionEdgeCoverage = 0;
    let precisionFlatCoverage = 0;
    let precisionRestoreReason: string | undefined;

    if (precisionRestore.enabled) {
      const report = await applyPrecisionRestore(current, precisionRestore, (ratio, label) => {
        onProgress?.(0.23 + ratio * 0.13, label);
      });
      precisionRestoreApplied = report.applied;
      precisionTextCoverage = report.textCoverage;
      precisionEdgeCoverage = report.edgeCoverage;
      precisionFlatCoverage = report.flatCoverage;
      precisionRestoreReason = report.skippedReason;
    }

    let depthFocusApplied = false;
    let depthFocusPlanes = depthFocusPrecision.planes;
    let depthFocusConfidence = 0;
    let depthFocusCoverage = 0;
    let depthFocusNearCoverage = 0;
    let depthFocusMidCoverage = 0;
    let depthFocusFarCoverage = 0;
    let depthFocusMeanCorrection = 0;
    let depthFocusReason: string | undefined;

    if (depthFocusPrecision.enabled) {
      onProgress?.(0.37, "Depth Focus Precision · estimation relative");
      const estimate = await estimateRelativeDepth(current, depthFocusPrecision.centerBias);
      const confidence = buildDepthConfidenceMap(estimate.depth, estimate.structure);
      const buckets = buildDepthBuckets(depthFocusPrecision);
      const report = await applyDepthFocusRestore(
        current,
        estimate.depth,
        confidence,
        buckets,
        depthFocusPrecision,
        (ratio, label) => onProgress?.(0.38 + ratio * 0.18, label),
      );

      depthFocusApplied = report.applied;
      depthFocusPlanes = report.planes;
      depthFocusConfidence = report.meanConfidence;
      depthFocusCoverage = report.processedCoverage;
      depthFocusNearCoverage = report.nearCoverage;
      depthFocusMidCoverage = report.midCoverage;
      depthFocusFarCoverage = report.farCoverage;
      depthFocusMeanCorrection = report.meanCorrection;
      depthFocusReason = report.skippedReason;
    }

    let engineUsed: EngineId = "canvas";
    let aiScale: number | null = null;
    let aiProvider: string | null = null;
    let aiPasses = 0;
    let aiPreparedInput = false;
    let aiPreparedSourceMegapixels = source.width * source.height / 1_000_000;
    let aiPreparedWorkingMegapixels = aiPreparedSourceMegapixels;

    if (engine === "ai") {
      const model = loadedModel();
      if (!model) throw new Error("Moteur IA sélectionné mais aucun modèle n'est chargé.");
      // Les grandes photos de smartphone ne sont plus exclues de l'IA.
      // On construit une surface neuronale maîtrisée puis l'inférence reste
      // tuilée dans aiUpscaler. Cela évite de créer directement une sortie
      // x2/x4 de dizaines de mégapixels en RAM sur Android.
      if (source.width * source.height > AI_MAX_SOURCE_PIXELS) {
        const android =
          typeof navigator !== "undefined" &&
          /Android/i.test(navigator.userAgent);
        const deviceSafePixels = android ? 2_200_000 : 4_000_000;
        const targetDrivenPixels = Math.max(
          1_000_000,
          Math.floor(
            output.width * output.height /
            Math.max(1, model.scale * model.scale),
          ),
        );
        const workingPixelBudget = Math.min(
          deviceSafePixels,
          targetDrivenPixels,
        );
        const currentPixels = current.width * current.height;
        const scale = Math.min(
          1,
          Math.sqrt(workingPixelBudget / Math.max(1, currentPixels)),
        );

        if (scale < 0.999) {
          const preparedWidth = Math.max(64, Math.round(current.width * scale));
          const preparedHeight = Math.max(64, Math.round(current.height * scale));
          const prepared = canvasFor(preparedWidth, preparedHeight);
          const preparedCtx = prepared.getContext("2d");
          if (!preparedCtx) {
            throw new Error("Canvas de préparation IA indisponible.");
          }
          preparedCtx.imageSmoothingEnabled = true;
          preparedCtx.imageSmoothingQuality = "high";
          preparedCtx.drawImage(
            current,
            0,
            0,
            current.width,
            current.height,
            0,
            0,
            preparedWidth,
            preparedHeight,
          );
          release(current);
          current = prepared;
          aiPreparedInput = true;
          aiPreparedWorkingMegapixels =
            preparedWidth * preparedHeight / 1_000_000;
          onProgress?.(
            0.56,
            `Préparation IA mobile · ${aiPreparedSourceMegapixels.toFixed(1)} MP → ${aiPreparedWorkingMegapixels.toFixed(1)} MP`,
          );
        }
      }

      // Pro Max : un léger pré-traitement de la ROI avant la super-résolution
      // aide le réseau à consacrer davantage de capacité aux structures du sujet.
      if (smallSubjectRoi.enabled && current.width * current.height <= 4_000_000) {
        const preRoi = detectSmallSubjectRoi(current);
        if (preRoi) {
          enhanceRoiLocally(current, preRoi, Math.min(0.42, (smallSubjectRoi.strength ?? 0.82) * 0.48));
        }
      }

      const aiInputWidth = current.width;
      const aiInputHeight = current.height;
      const requestedScale = Math.max(
        output.width / Math.max(1, aiInputWidth),
        output.height / Math.max(1, aiInputHeight),
      );

      onProgress?.(0.58, "Inférence IA · passe 1");
      let inferred = await upscaleWithAi(current, (ratio, label) => {
        onProgress?.(0.58 + ratio * 0.16, label);
      });
      release(current);
      current = inferred;
      aiPasses = 1;

      // Si le modèle mobile x2 a dû être retenu mais que la cible demande
      // beaucoup plus de définition, une seconde vraie passe IA vaut mieux
      // qu'un grand agrandissement Canvas. On la limite aux sorties sûres.
      const achievedScale = Math.max(
        current.width / Math.max(1, aiInputWidth),
        current.height / Math.max(1, aiInputHeight),
      );
      const projectedPixels =
        Math.round(current.width * model.scale) *
        Math.round(current.height * model.scale);
      const secondPassSafe =
        model.scale <= 2.1 &&
        requestedScale > achievedScale * 1.3 &&
        current.width * current.height <= 2_200_000 &&
        projectedPixels <= 12_000_000;

      if (secondPassSafe) {
        onProgress?.(0.75, "Inférence IA · passe 2");
        inferred = await upscaleWithAi(current, (ratio, label) => {
          onProgress?.(0.75 + ratio * 0.10, label);
        });
        release(current);
        current = inferred;
        aiPasses = 2;
      }

      engineUsed = "ai";
      aiScale = model.scale;
      aiProvider = model.provider;
    }

    onProgress?.(engineUsed === "ai" ? 0.81 : 0.58, "Normalisation géométrique");
    current = resampleTo(current, output, PROFILES[profile].filter, (pass) => {
      const base = engineUsed === "ai" ? 0.83 : 0.62;
      onProgress?.(Math.min(0.9, base + pass * 0.05), `Rééchantillonnage haute qualité · passe ${pass}`);
    });

    onProgress?.(0.91, "Finition locale");
    const sharpnessBeforeMeasure = measureCanvasSharpness(current);

    let roiApplied = false;
    let roiConfidence = 0;
    let roiBox: { x: number; y: number; width: number; height: number } | null = null;

    if (smallSubjectRoi.enabled) {
      onProgress?.(0.915, "Petit sujet · détection ROI");
      const roi = detectSmallSubjectRoi(current);
      if (roi) {
        roiConfidence = roi.confidence;
        roiBox = { x: roi.x, y: roi.y, width: roi.width, height: roi.height };
        roiApplied = enhanceRoiLocally(
          current,
          roi,
          smallSubjectRoi.strength ?? 0.82,
        );
      }
    }

    const restoredBeforeFinal =
      deepFocusApplied || precisionRestoreApplied || depthFocusApplied;

    // Netteté Pro v2 : on ne coupe plus la finition finale quand une
    // restauration amont a travaillé. On réduit simplement son intensité.
    // La passe finale est calculée sur la résolution de sortie afin que le
    // gain reste visible après l'upscale.
    const finalSharpenAmount = finalSharpenAmountForProfile(
      profile,
      restoredBeforeFinal,
      engineUsed === "ai",
    );
    let sharpenApplied = applyFinalAdaptiveSharpen(current, {
      amount: finalSharpenAmount,
      edgeThreshold: profile === "detail" ? 4 : 5,
      haloGuard: profile === "detail" ? 0.82 : 0.78,
      maxCorrection: profile === "detail" ? 16 : 13,
    });

    // Repli vers l'ancien sharpen uniquement si la passe finale a dû être
    // ignorée (très grande image ou contexte 2D indisponible).
    if (!sharpenApplied && !restoredBeforeFinal) {
      sharpenApplied = sharpen(current, PROFILES[profile].sharpen);
    }

    const sharpnessAfterMeasure = measureCanvasSharpness(current);
    const sharpnessBefore = sharpnessBeforeMeasure.edgeEnergy;
    const sharpnessAfter = sharpnessAfterMeasure.edgeEnergy;
    const sharpnessGain =
      sharpnessBefore > 0
        ? (sharpnessAfter - sharpnessBefore) / sharpnessBefore
        : 0;

    onProgress?.(0.96, "Encodage du master");
    const blob = await toBlob(current, format, format === "image/png" ? 1 : 0.96);
    if (blob.size === 0) throw new Error("L'encodeur image a produit un fichier vide.");

    onProgress?.(1, "Terminé");
    return {
      blob,
      size: output,
      mimeType: format,
      sharpenApplied,
      engineUsed,
      aiScale,
      aiProvider,
      aiPasses,
      aiPreparedInput,
      aiPreparedSourceMegapixels,
      aiPreparedWorkingMegapixels,
      deepFocusApplied,
      deepFocusLayers,
      deepFocusConfidence,
      deepFocusReason,
      precisionRestoreApplied,
      precisionTextCoverage,
      precisionEdgeCoverage,
      precisionFlatCoverage,
      precisionRestoreReason,
      depthFocusApplied,
      depthFocusPlanes,
      depthFocusConfidence,
      depthFocusCoverage,
      depthFocusNearCoverage,
      depthFocusMidCoverage,
      depthFocusFarCoverage,
      depthFocusMeanCorrection,
      depthFocusReason,
      sharpnessBefore,
      sharpnessAfter,
      sharpnessGain,
      roiApplied,
      roiConfidence,
      roiBox,
    };
  } finally {
    decoded.close();
    release(current);
  }
}
