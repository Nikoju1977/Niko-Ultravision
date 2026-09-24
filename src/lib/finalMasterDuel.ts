import { decodeImageFile } from "./imageDecode";
import {
  gradientEnergy,
  localErrorP99,
  lumaOf,
  noiseSigma,
  psnr,
  ssim,
} from "./restoration/imageMath";

export interface FinalMasterMetrics {
  ssimToSource: number;
  psnrToSource: number;
  localErrorP99: number;
  detailRatio: number;
  noiseRatio: number;
  /** Erreur chromatique moyenne YCbCr en niveaux 0..255. */
  chromaError: number;
  score: number;
}

export interface FinalMasterDuel {
  winner: "primary" | "classic";
  primary: FinalMasterMetrics;
  classic: FinalMasterMetrics;
  margin: number;
  rationale: string;
}

function probeSize(
  width: number,
  height: number,
  maxSide = 640,
): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(32, Math.round(width * scale)),
    height: Math.max(32, Math.round(height * scale)),
  };
}

function drawProbe(
  source: CanvasImageSource,
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas de duel final indisponible.");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function meanChromaError(
  sourceCanvas: HTMLCanvasElement,
  candidateCanvas: HTMLCanvasElement,
): number {
  const sourceCtx = sourceCanvas.getContext(
    "2d",
    { willReadFrequently: true },
  );
  const candidateCtx = candidateCanvas.getContext(
    "2d",
    { willReadFrequently: true },
  );
  if (!sourceCtx || !candidateCtx) return 0;

  const a = sourceCtx.getImageData(
    0,
    0,
    sourceCanvas.width,
    sourceCanvas.height,
  ).data;
  const b = candidateCtx.getImageData(
    0,
    0,
    candidateCanvas.width,
    candidateCanvas.height,
  ).data;
  const pixels = Math.max(
    1,
    Math.min(a.length, b.length) / 4,
  );
  let sum = 0;

  for (let p = 0; p < pixels; p += 1) {
    const i = p * 4;
    const aCb =
      128 - 0.114572 * a[i] -
      0.385428 * a[i + 1] +
      0.5 * a[i + 2];
    const aCr =
      128 + 0.5 * a[i] -
      0.454153 * a[i + 1] -
      0.045847 * a[i + 2];
    const bCb =
      128 - 0.114572 * b[i] -
      0.385428 * b[i + 1] +
      0.5 * b[i + 2];
    const bCr =
      128 + 0.5 * b[i] -
      0.454153 * b[i + 1] -
      0.045847 * b[i + 2];
    sum += Math.sqrt(
      ((aCb - bCb) ** 2 + (aCr - bCr) ** 2) / 2,
    );
  }

  return sum / pixels;
}

function metrics(
  sourceCanvas: HTMLCanvasElement,
  candidateCanvas: HTMLCanvasElement,
): FinalMasterMetrics {
  const source = lumaOf(sourceCanvas);
  const candidate = lumaOf(candidateCanvas);
  const sourceGradient = gradientEnergy(source);
  const candidateGradient = gradientEnergy(candidate);
  const sourceNoise = noiseSigma(source);
  const candidateNoise = noiseSigma(candidate);
  const similarity = ssim(source, candidate);
  const signal = psnr(source, candidate);
  const localError = localErrorP99(source, candidate);
  const detailRatio =
    candidateGradient / Math.max(0.5, sourceGradient);
  const noiseRatio =
    candidateNoise / Math.max(0.35, sourceNoise);
  const chromaError = meanChromaError(
    sourceCanvas,
    candidateCanvas,
  );

  // La fidélité reste dominante. Un petit gain de détail est récompensé,
  // mais une sur-accentuation ou une hausse du bruit est pénalisée.
  const fidelityScore =
    clamp01((similarity - 0.82) / 0.18) * 58;
  const psnrScore =
    clamp01((signal - 22) / 20) * 20;
  const usefulDetail =
    detailRatio <= 1
      ? -Math.min(10, (1 - detailRatio) * 18)
      : Math.min(12, (detailRatio - 1) * 22);
  const excessDetailPenalty =
    detailRatio > 1.65
      ? (detailRatio - 1.65) * 28
      : 0;
  const noisePenalty =
    noiseRatio > 1.35
      ? (noiseRatio - 1.35) * 18
      : 0;
  const localPenalty =
    Math.max(0, localError - 24) * 0.8;
  const chromaPenalty =
    Math.max(0, chromaError - 2.5) * 1.6;

  return {
    ssimToSource: similarity,
    psnrToSource: signal,
    localErrorP99: localError,
    detailRatio,
    noiseRatio,
    chromaError,
    score:
      fidelityScore +
      psnrScore +
      usefulDetail -
      excessDetailPenalty -
      noisePenalty -
      localPenalty -
      chromaPenalty,
  };
}

/**
 * Duel final sur une projection commune à la définition source.
 *
 * Il ne s'agit pas d'une vérité terrain : le master haute résolution est
 * reprojeté vers la source afin de vérifier qu'il reste compatible avec
 * l'information réellement observée. Le candidat IA doit battre la baseline
 * déterministe d'une marge mesurable pour être conservé.
 */
export async function duelFinalMasters(
  sourceBlob: Blob,
  primaryBlob: Blob,
  classicBlob: Blob,
): Promise<FinalMasterDuel> {
  const [source, primary, classic] = await Promise.all([
    decodeImageFile(sourceBlob),
    decodeImageFile(primaryBlob),
    decodeImageFile(classicBlob),
  ]);

  try {
    const size = probeSize(source.width, source.height);
    const sourceProbe = drawProbe(
      source.source,
      size.width,
      size.height,
    );
    const primaryProbe = drawProbe(
      primary.source,
      size.width,
      size.height,
    );
    const classicProbe = drawProbe(
      classic.source,
      size.width,
      size.height,
    );

    const primaryMetrics = metrics(sourceProbe, primaryProbe);
    const classicMetrics = metrics(sourceProbe, classicProbe);

    sourceProbe.width = sourceProbe.height = 1;
    primaryProbe.width = primaryProbe.height = 1;
    classicProbe.width = classicProbe.height = 1;

    const margin =
      primaryMetrics.score - classicMetrics.score;

    // L'IA doit réellement améliorer le compromis. En cas d'égalité,
    // la baseline déterministe gagne car elle n'invente aucun détail.
    const winner: "primary" | "classic" =
      margin >= 1.25 &&
      primaryMetrics.ssimToSource >= 0.84 &&
      primaryMetrics.localErrorP99 <= 36 &&
      primaryMetrics.chromaError <= 7.5
        ? "primary"
        : "classic";

    const rationale =
      winner === "primary"
        ? `Master IA conservé : avantage mesuré +${margin.toFixed(2)} points sur la baseline déterministe.`
        : `Baseline déterministe conservée : avantage IA insuffisant (${margin.toFixed(2)} points), fidélité locale ou couleur insuffisante.`;

    return {
      winner,
      primary: primaryMetrics,
      classic: classicMetrics,
      margin,
      rationale,
    };
  } finally {
    source.close();
    primary.close();
    classic.close();
  }
}
