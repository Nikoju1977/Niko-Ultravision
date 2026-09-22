/**
 * Étape 8 — Contrôle qualité sans vérité terrain.
 *
 * Il n'existe pas d'image « parfaite » de référence : on juge donc chaque
 * candidat sur des critères mesurables et falsifiables.
 *  - Fidélité : le candidat, ramené à la taille source, doit redonner la
 *    source (SSIM, PSNR). Un modèle qui invente du contenu échoue ici.
 *  - Hallucination locale : erreur maximale par blocs (p99) — un visage ou
 *    un texte réinventé à un seul endroit ne se dilue pas dans une moyenne.
 *  - Détail : énergie de gradient par rapport au rééchantillonnage simple.
 *  - Halos : dépassements autour des contours forts (ringing).
 *  - Bruit : amplification du grain dans les zones plates.
 */
import {
  clamp01,
  gradientEnergy,
  jpegBlockiness,
  localErrorP99,
  lumaOf,
  noiseSigma,
  psnr,
  resample,
  ringingRatio,
  ssim,
  type Luma,
} from "./imageMath";

export type QcMode = "fidelity" | "restoration";

export interface CandidateScore {
  /** Réduction (+) ou amplification (−) des artefacts de la source, en %. */
  artifactReduction: number;
  ssim: number;
  psnr: number;
  localError: number;
  detailGain: number;
  ringing: number;
  noiseRatio: number;
  score: number;
  rejected: boolean;
  rejectReason: string | null;
}

export interface EvaluationZone {
  /** Zone source (résolution native). */
  source: HTMLCanvasElement;
  /**
   * Cible de fidélité. En mode restauration, c'est la source débarrassée de
   * son bruit/de ses blocs (lissage binomial) : un candidat qui reproduit
   * fidèlement le bruit ne doit plus être récompensé.
   */
  target?: Luma;
  /** Référence : même zone agrandie par rééchantillonnage simple. */
  reference: HTMLCanvasElement;
  kind: "detail" | "flat";
}

export const QC_RULES = {
  minSsim: 0.86,
  maxLocalError: 28,
  maxRinging: 0.2,
  /** Un candidat IA doit battre la référence classique d'au moins cette marge. */
  aiMargin: 2,
};

function downTo(candidate: HTMLCanvasElement, width: number, height: number): Luma {
  return lumaOf(resample(candidate, 0, 0, candidate.width, candidate.height, width, height));
}

/** Lissage binomial 5×5 (≈ gaussien σ 1) : cible propre pour le mode restauration. */
export function cleanedTarget(source: Luma): Luma {
  const { width, height, data } = source;
  const k = [1, 4, 6, 4, 1];
  const tmp = new Float32Array(data.length);
  const out = new Float32Array(data.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let acc = 0;
      for (let i = -2; i <= 2; i += 1) acc += k[i + 2] * data[y * width + Math.min(width - 1, Math.max(0, x + i))];
      tmp[y * width + x] = acc / 16;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let acc = 0;
      for (let i = -2; i <= 2; i += 1) acc += k[i + 2] * tmp[Math.min(height - 1, Math.max(0, y + i)) * width + x];
      out[y * width + x] = acc / 16;
    }
  }
  return { data: out, width, height };
}

/** Évalue un candidat (déjà à la taille de la référence) sur toutes les zones. */
export function scoreCandidate(
  zones: EvaluationZone[],
  outputs: HTMLCanvasElement[],
  mode: QcMode = "fidelity",
): CandidateScore {
  let ssimSum = 0, psnrSum = 0, localMax = 0, gainSum = 0, ringSum = 0, artifactSum = 0;
  let detailZones = 0, noiseRatio = 1, artifactZones = 0;

  zones.forEach((zone, index) => {
    const output = outputs[index];
    const src = lumaOf(zone.source);
    const back = downTo(output, zone.source.width, zone.source.height);
    const target = mode === "restoration" ? zone.target ?? cleanedTarget(src) : src;
    ssimSum += ssim(target, back);
    psnrSum += psnr(target, back);
    // L'hallucination se mesure toujours contre la vraie source.
    localMax = Math.max(localMax, localErrorP99(src, back));
    // Artefacts restants : blocs 8×8 et bruit, ramenés à la grille source.
    const sourceBlocks = jpegBlockiness(src);
    // Sans blocs dans la source, l'indice n'a pas de sens : neutre.
    if (sourceBlocks > 1.1) {
      artifactSum += 1 - (jpegBlockiness(back) - 1) / (sourceBlocks - 1);
      artifactZones += 1;
    }

    const candLuma = lumaOf(output);
    const refLuma = lumaOf(zone.reference);
    if (zone.kind === "detail") {
      gainSum += gradientEnergy(candLuma) / Math.max(0.5, gradientEnergy(refLuma)) - 1;
      ringSum += ringingRatio(candLuma, refLuma);
      detailZones += 1;
    } else {
      noiseRatio = noiseSigma(candLuma) / Math.max(0.3, noiseSigma(refLuma));
    }
  });

  const n = Math.max(1, zones.length);
  const meanSsim = ssimSum / n;
  const meanPsnr = psnrSum / n;
  const detailGain = detailZones ? gainSum / detailZones : 0;
  const ringing = detailZones ? ringSum / detailZones : 0;
  const artifactReduction = artifactZones ? Math.max(-1, Math.min(1, artifactSum / artifactZones)) : 0;

  const localLimit = mode === "restoration" ? QC_RULES.maxLocalError * 1.4 : QC_RULES.maxLocalError;
  let rejectReason: string | null = null;
  if (meanSsim < QC_RULES.minSsim) rejectReason = `fidélité insuffisante (SSIM ${meanSsim.toFixed(3)})`;
  else if (localMax > localLimit) rejectReason = `écart local suspect (${localMax.toFixed(1)}) : risque d'hallucination`;
  else if (ringing > QC_RULES.maxRinging) rejectReason = `halos marqués (${(ringing * 100).toFixed(0)} % des contours)`;
  else if (mode === "restoration" && noiseRatio > 1.6) rejectReason = `bruit amplifié ×${noiseRatio.toFixed(2)}`;

  const fidelity = clamp01((meanSsim - QC_RULES.minSsim) / (1 - QC_RULES.minSsim));
  // En restauration, le « détail » gagné sur une source bruitée est
  // souvent du bruit accentué : son poids baisse.
  const detailWeight = mode === "restoration" ? 0.2 : 0.35;
  const detail = Math.max(-1, Math.min(1, detailGain / 0.6));
  const psnrTerm = clamp01((meanPsnr - 26) / 16);
  const noiseTerm =
    mode === "restoration"
      ? -30 * Math.max(0, noiseRatio - 1) + 15 * Math.max(0, Math.min(1, 1 - noiseRatio))
      : -8 * Math.max(0, noiseRatio - 1.15);
  const artifactTerm = mode === "restoration" ? 15 * artifactReduction : 0;

  const score =
    100 * (0.4 * fidelity + detailWeight * detail + 0.1 * psnrTerm) -
    100 * 0.5 * ringing +
    noiseTerm +
    artifactTerm;

  return {
    ssim: meanSsim,
    psnr: meanPsnr,
    localError: localMax,
    detailGain,
    ringing,
    noiseRatio,
    artifactReduction,
    score: Math.round(Math.max(-100, Math.min(100, score)) * 10) / 10,
    rejected: rejectReason !== null,
    rejectReason,
  };
}
