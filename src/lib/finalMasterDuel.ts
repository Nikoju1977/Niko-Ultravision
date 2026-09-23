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

  return {
    ssimToSource: similarity,
    psnrToSource: signal,
    localErrorP99: localError,
    detailRatio,
    noiseRatio,
    score:
      fidelityScore +
      psnrScore +
      usefulDetail -
      excessDetailPenalty -
      noisePenalty -
      localPenalty,
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
      primaryMetrics.localErrorP99 <= 36
        ? "primary"
        : "classic";

    const rationale =
      winner === "primary"
        ? `Master IA conservé : avantage mesuré +${margin.toFixed(2)} points sur la baseline déterministe.`
        : `Baseline déterministe conservée : avantage IA insuffisant (${margin.toFixed(2)} points) ou fidélité locale trop faible.`;

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
