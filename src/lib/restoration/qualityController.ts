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
  /** Confiance moyenne dans l'information réellement présente dans la source. */
  meanSourceConfidence: number;
  zoneCount: number;
  score: number;
  rejected: boolean;
  rejectReason: string | null;
}

export type EvaluationZoneKind =
  | "detail"
  | "flat"
  | "edge"
  | "midtone"
  | "shadow"
  | "highlight";

export interface EvaluationZone {
  /** Zone source (résolution native). */
  source: HTMLCanvasElement;
  /** Rôle de la sonde dans l'évaluation multi-régions. */
  label?: string;
  /** Poids relatif de la zone dans les moyennes du Quality Controller. */
  weight?: number;
  /**
   * 0..1 : degré de confiance dans les informations de la source.
   * Une source fiable doit être moins librement modifiée par l'IA.
   */
  sourceConfidence?: number;
  /**
   * Cible de fidélité. En mode restauration, c'est la source débarrassée de
   * son bruit/de ses blocs (lissage binomial) : un candidat qui reproduit
   * fidèlement le bruit ne doit plus être récompensé.
   */
  target?: Luma;
  /** Référence : même zone agrandie par rééchantillonnage simple. */
  reference: HTMLCanvasElement;
  kind: EvaluationZoneKind;
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
  let ssimSum = 0;
  let psnrSum = 0;
  let fidelityWeightSum = 0;
  let localMax = 0;
  let gainSum = 0;
  let ringSum = 0;
  let detailWeightSum = 0;
  let artifactSum = 0;
  let artifactWeightSum = 0;
  let noiseSum = 0;
  let noiseWeightSum = 0;
  let confidenceSum = 0;
  let zoneWeightSum = 0;

  zones.forEach((zone, index) => {
    const output = outputs[index];
    if (!output) return;

    const zoneWeight = Math.max(0.1, zone.weight ?? 1);
    const sourceConfidence = clamp01(zone.sourceConfidence ?? 0.7);
    const fidelityWeight = zoneWeight * (0.65 + 0.35 * sourceConfidence);
    confidenceSum += sourceConfidence * zoneWeight;
    zoneWeightSum += zoneWeight;

    const src = lumaOf(zone.source);
    const back = downTo(output, zone.source.width, zone.source.height);
    const target = mode === "restoration" ? zone.target ?? cleanedTarget(src) : src;
    ssimSum += ssim(target, back) * fidelityWeight;
    psnrSum += psnr(target, back) * fidelityWeight;
    fidelityWeightSum += fidelityWeight;

    // L'hallucination se mesure toujours contre la vraie source : la pire
    // zone reste bloquante, même si les autres régions sont excellentes.
    localMax = Math.max(localMax, localErrorP99(src, back));

    // Artefacts restants : blocs 8×8 et bruit, ramenés à la grille source.
    const sourceBlocks = jpegBlockiness(src);
    if (sourceBlocks > 1.1) {
      artifactSum +=
        (1 - (jpegBlockiness(back) - 1) / (sourceBlocks - 1)) * zoneWeight;
      artifactWeightSum += zoneWeight;
    }

    const candLuma = lumaOf(output);
    const refLuma = lumaOf(zone.reference);
    const structuralProbe =
      zone.kind === "detail" ||
      zone.kind === "edge" ||
      zone.kind === "midtone" ||
      zone.kind === "highlight";

    if (structuralProbe) {
      gainSum +=
        (gradientEnergy(candLuma) /
          Math.max(0.5, gradientEnergy(refLuma)) -
          1) *
        zoneWeight;
      ringSum += ringingRatio(candLuma, refLuma) * zoneWeight;
      detailWeightSum += zoneWeight;
    }

    if (zone.kind === "flat" || zone.kind === "shadow") {
      noiseSum +=
        (noiseSigma(candLuma) /
          Math.max(0.3, noiseSigma(refLuma))) *
        zoneWeight;
      noiseWeightSum += zoneWeight;
    }
  });

  const meanSsim = ssimSum / Math.max(1e-6, fidelityWeightSum);
  const meanPsnr = psnrSum / Math.max(1e-6, fidelityWeightSum);
  const detailGain = detailWeightSum ? gainSum / detailWeightSum : 0;
  const ringing = detailWeightSum ? ringSum / detailWeightSum : 0;
  const noiseRatio = noiseWeightSum ? noiseSum / noiseWeightSum : 1;
  const artifactReduction = artifactWeightSum
    ? Math.max(-1, Math.min(1, artifactSum / artifactWeightSum))
    : 0;
  const meanSourceConfidence =
    confidenceSum / Math.max(1e-6, zoneWeightSum);

  const localLimit = mode === "restoration" ? QC_RULES.maxLocalError * 1.4 : QC_RULES.maxLocalError;
  let rejectReason: string | null = null;
  if (meanSsim < QC_RULES.minSsim) rejectReason = `fidélité insuffisante (SSIM ${meanSsim.toFixed(3)})`;
  else if (localMax > localLimit) rejectReason = `écart local suspect (${localMax.toFixed(1)}) : risque d'hallucination`;
  else if (ringing > QC_RULES.maxRinging) rejectReason = `halos marqués (${(ringing * 100).toFixed(0)} % des contours)`;
  else if (mode === "restoration" && noiseRatio > 1.6) rejectReason = `bruit amplifié ×${noiseRatio.toFixed(2)}`;

  const fidelity = clamp01((meanSsim - QC_RULES.minSsim) / (1 - QC_RULES.minSsim));
  // Plus la source est fiable, plus la fidélité structurelle compte. Sur une
  // source dégradée, on laisse davantage de poids à la restauration mesurée.
  const fidelityWeight = mode === "restoration"
    ? 0.34 + 0.12 * meanSourceConfidence
    : 0.40 + 0.18 * meanSourceConfidence;
  const detailWeight = mode === "restoration"
    ? 0.16 + 0.08 * (1 - meanSourceConfidence)
    : 0.28 + 0.08 * (1 - meanSourceConfidence);
  const detail = Math.max(-1, Math.min(1, detailGain / 0.6));
  const psnrTerm = clamp01((meanPsnr - 26) / 16);
  const noiseTerm =
    mode === "restoration"
      ? -30 * Math.max(0, noiseRatio - 1) + 15 * Math.max(0, Math.min(1, 1 - noiseRatio))
      : -8 * Math.max(0, noiseRatio - 1.15);
  const artifactTerm = mode === "restoration" ? 15 * artifactReduction : 0;

  const score =
    100 * (fidelityWeight * fidelity + detailWeight * detail + 0.1 * psnrTerm) -
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
    meanSourceConfidence,
    zoneCount: zones.length,
    score: Math.round(Math.max(-100, Math.min(100, score)) * 10) / 10,
    rejected: rejectReason !== null,
    rejectReason,
  };
}
