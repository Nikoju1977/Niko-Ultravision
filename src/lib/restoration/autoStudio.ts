/**
 * Studio Auto — sélection automatique multi-candidats.
 *
 *   Original ─┬─ Lanczos + Unsharp (référence classique)
 *             ├─ modèle IA A (selon le diagnostic)
 *             └─ modèle IA B
 *                   ↓
 *            Quality Controller (zones témoins)
 *                   ↓
 *        le gagnant traite l'image entière
 *
 * Les candidats sont départagés sur deux zones témoins (la plus détaillée et
 * une zone plate) : on obtient la décision en quelques secondes au lieu de
 * faire tourner chaque modèle sur toute l'image.
 */
import { decodeImageFile } from "../imageDecode";
import { calculateOutputSize, type TargetId } from "../geometry";
import type { ProfileId } from "../profiles";
import { loadAiModel, loadedModel, upscaleWithAi, webGpuAvailable } from "../aiUpscaler";
import { enhanceImage, type EnhanceImageOptions, type ImageEnhanceResult, type ImageFormat } from "../imageEnhancer";
import { isCancelledError, throwIfCancelled } from "../cancellation";
import {
  canvas2d,
  gradientEnergy,
  jpegBlockiness,
  lumaOf,
  noiseSigma,
  resample,
  smoothCanvas,
  unsharpMask,
} from "./imageMath";
import { diagnoseImage, planForRoute, type ImageDiagnosis, type RoutePlan } from "./imageDiagnosis";
import {
  QC_RULES,
  scoreCandidate,
  type CandidateScore,
  type EvaluationZone,
  type EvaluationZoneKind,
} from "./qualityController";
import { RESTORATION_MODELS, type RestorationModelId } from "./modelRegistry";

export type CandidateId = "classic" | RestorationModelId;

export interface CandidateReport {
  id: CandidateId;
  label: string;
  status: "ok" | "rejected" | "failed";
  score: CandidateScore | null;
  error: string | null;
  elapsedMs: number;
  scale: number | null;
  /** Nombre pondéré de régions dans lesquelles ce candidat est le meilleur. */
  zoneWinWeight: number;
  /** Désaccord moyen 0..1 avec les autres modèles IA valides. */
  disagreement: number | null;
  zoneScores: Array<{
    label: string;
    score: number;
    rejected: boolean;
  }>;
}

export interface StudioReport {
  diagnosis: ImageDiagnosis;
  plan: RoutePlan;
  candidates: CandidateReport[];
  winner: CandidateId;
  winnerLabel: string;
  decision: string;
  evaluationScale: number;
  qcMode: "fidelity" | "restoration";
  probeCount: number;
  meanSourceConfidence: number;
  meanAiDisagreement: number | null;
  resourceProfile: string;
  regionalEvidence: string[];
}

export interface StudioResult {
  result: ImageEnhanceResult;
  report: StudioReport;
}

const ZONE_SIDE = 128;

interface ResourcePlan {
  label: string;
  probeBudget: number;
  modelBudget: number;
  allowHeavy: boolean;
}

interface ZoneDescriptor {
  x: number;
  y: number;
  kind: EvaluationZoneKind;
  label: string;
  weight: number;
}

function resourcePlan(requestedMaxModels: number): ResourcePlan {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const memory = typeof nav.deviceMemory === "number" ? nav.deviceMemory : null;
  const cores = navigator.hardwareConcurrency || 2;
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const gpu = webGpuAvailable();

  if (mobile || (memory !== null && memory <= 4)) {
    return {
      label: `Mobile prudent · ${memory ?? "RAM ?"} Go · ${cores} cœurs · ${gpu ? "WebGPU" : "WASM"}`,
      probeBudget: 4,
      modelBudget: Math.min(1, requestedMaxModels),
      allowHeavy: false,
    };
  }

  if (gpu && (memory === null || memory >= 8) && cores >= 8) {
    return {
      label: `Performance · ${memory ?? "RAM ?"} Go · ${cores} cœurs · WebGPU`,
      probeBudget: 8,
      modelBudget: Math.min(3, requestedMaxModels),
      allowHeavy: true,
    };
  }

  return {
    label: `Équilibré · ${memory ?? "RAM ?"} Go · ${cores} cœurs · ${gpu ? "WebGPU" : "WASM"}`,
    probeBudget: 6,
    modelBudget: Math.min(2, requestedMaxModels),
    allowHeavy: !mobile && (memory === null || memory >= 6),
  };
}

function routeModelsForResources(
  plan: RoutePlan,
  resources: ResourcePlan,
): RoutePlan {
  const selected = plan.models.filter(
    (id) => resources.allowHeavy || !RESTORATION_MODELS[id].heavy,
  );

  if (plan.models.length && selected.length === 0) {
    selected.push("realesrgan-general-x4v3", "swin2sr-lightweight-x2");
  } else if (!resources.allowHeavy && selected.length < resources.modelBudget) {
    for (const fallback of [
      "realesrgan-general-x4v3",
      "swin2sr-lightweight-x2",
    ] as RestorationModelId[]) {
      if (!selected.includes(fallback)) selected.push(fallback);
    }
  }

  return {
    ...plan,
    models: selected.slice(0, resources.modelBudget),
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function zoneConfidence(canvas: HTMLCanvasElement, kind: EvaluationZoneKind): number {
  const luma = lumaOf(canvas);
  const noise = noiseSigma(luma);
  const blocks = jpegBlockiness(luma);
  const gradient = gradientEnergy(luma);
  const noisePenalty = clamp01(noise / 14);
  const blockPenalty = clamp01(Math.max(0, blocks - 1) / 0.8);
  const structureBonus =
    kind === "detail" || kind === "edge"
      ? 0.10 * clamp01(gradient / 28)
      : 0;
  return Math.max(
    0.12,
    Math.min(0.98, 0.93 - 0.48 * noisePenalty - 0.30 * blockPenalty + structureBonus),
  );
}

/**
 * Studio Auto v2 : échantillonnage multi-régions. On ne juge plus un modèle
 * sur seulement une zone détaillée et une zone plate.
 */
function pickZones(
  source: CanvasImageSource,
  width: number,
  height: number,
  budget: number,
): ZoneDescriptor[] {
  const side = Math.min(ZONE_SIDE, width, height);
  const viewScale = Math.min(1, 320 / Math.max(width, height));
  const view = lumaOf(
    resample(
      source,
      0,
      0,
      width,
      height,
      Math.max(1, Math.round(width * viewScale)),
      Math.max(1, Math.round(height * viewScale)),
    ),
  );
  const block = Math.max(4, Math.round(side * viewScale));
  const blocks: { x: number; y: number; energy: number; mean: number }[] = [];

  for (let by = 0; by + block <= view.height; by += Math.max(2, block >> 1)) {
    for (let bx = 0; bx + block <= view.width; bx += Math.max(2, block >> 1)) {
      const sub = new Float32Array(block * block);
      let mean = 0;
      for (let y = 0; y < block; y += 1) {
        for (let x = 0; x < block; x += 1) {
          const value = view.data[(by + y) * view.width + bx + x];
          sub[y * block + x] = value;
          mean += value;
        }
      }
      blocks.push({
        x: bx,
        y: by,
        energy: gradientEnergy({ data: sub, width: block, height: block }),
        mean: mean / sub.length,
      });
    }
  }

  const align = (value: number, max: number) => {
    const clamped = Math.min(max, Math.max(0, Math.round(value)));
    return clamped - (clamped % 8);
  };
  const toSource = (candidate: { x: number; y: number }) => ({
    x: align(candidate.x / viewScale, Math.max(0, width - side)),
    y: align(candidate.y / viewScale, Math.max(0, height - side)),
  });

  if (!blocks.length) {
    return [{ x: 0, y: 0, kind: "detail", label: "détail principal", weight: 1.25 }];
  }

  const chosen: ZoneDescriptor[] = [];
  const minDistance = side * 0.42;
  const add = (
    candidate: { x: number; y: number } | undefined,
    kind: EvaluationZoneKind,
    label: string,
    weight: number,
  ) => {
    if (!candidate || chosen.length >= budget) return;
    const point = toSource(candidate);
    const distinct = chosen.every(
      (zone) => Math.hypot(zone.x - point.x, zone.y - point.y) >= minDistance,
    );
    if (distinct || chosen.length === 0) {
      chosen.push({ ...point, kind, label, weight });
    }
  };

  const highEnergy = [...blocks].sort((a, b) => b.energy - a.energy);
  const flat = [...blocks]
    .filter((entry) => entry.mean > 30 && entry.mean < 225)
    .sort((a, b) => a.energy - b.energy);
  const midtone = [...blocks].sort(
    (a, b) => Math.abs(a.mean - 128) - Math.abs(b.mean - 128),
  );
  const shadow = [...blocks]
    .filter((entry) => entry.mean >= 18 && entry.mean <= 105)
    .sort((a, b) => b.energy - a.energy);
  const highlight = [...blocks]
    .filter((entry) => entry.mean >= 150 && entry.mean <= 238)
    .sort((a, b) => b.energy - a.energy);

  add(highEnergy[0], "detail", "détail principal", 1.30);
  add(highEnergy.find((entry) => entry !== highEnergy[0]), "edge", "structure / arêtes", 1.20);
  add(flat[0], "flat", "zone plate / bruit", 1.00);
  add(midtone[0], "midtone", "tons moyens", 1.00);
  add(shadow[0], "shadow", "ombres", 0.90);
  add(highlight[0], "highlight", "hautes lumières", 0.90);

  // Machines puissantes : deux témoins supplémentaires pour réduire le risque
  // qu'un sujet important échappe au benchmark.
  if (budget > 6) {
    add(highEnergy[2], "detail", "détail secondaire", 1.10);
    const center = [...blocks].sort((a, b) => {
      const ax = a.x + block / 2 - view.width / 2;
      const ay = a.y + block / 2 - view.height / 2;
      const bx = b.x + block / 2 - view.width / 2;
      const by = b.y + block / 2 - view.height / 2;
      return ax * ax + ay * ay - (bx * bx + by * by);
    })[0];
    add(center, "midtone", "centre image", 1.10);
  }

  // Si la scène est trop uniforme pour fournir toutes les catégories, on
  // complète avec les blocs les plus éloignés spatialement.
  for (const candidate of highEnergy) {
    if (chosen.length >= budget) break;
    add(candidate, "detail", `témoin ${chosen.length + 1}`, 0.85);
  }

  return chosen;
}

function signatureOf(outputs: HTMLCanvasElement[]): Float32Array[] {
  return outputs.map((output) =>
    lumaOf(
      resample(
        output,
        0,
        0,
        output.width,
        output.height,
        32,
        32,
      ),
    ).data,
  );
}

function signatureDisagreement(
  a: Float32Array[],
  b: Float32Array[],
): number {
  let total = 0;
  let samples = 0;
  const zones = Math.min(a.length, b.length);
  for (let zone = 0; zone < zones; zone += 1) {
    const left = a[zone];
    const right = b[zone];
    const count = Math.min(left.length, right.length);
    for (let i = 0; i < count; i += 1) {
      total += Math.abs(left[i] - right[i]) / 255;
      samples += 1;
    }
  }
  return samples ? total / samples : 0;
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : "raison inconnue";
}

export async function runAutoStudio(
  file: File,
  target: TargetId,
  profile: ProfileId,
  format: ImageFormat,
  options: EnhanceImageOptions & { maxModels?: number } = {},
): Promise<StudioResult> {
  const { onProgress, maxModels = 3, ...enhanceOptions } = options;
  onProgress?.(0.02, "Studio Auto · analyse de l'image");

  const decoded = await decodeImageFile(file);
  let diagnosis: ImageDiagnosis;
  let plan: RoutePlan;
  let zones: EvaluationZone[] = [];
  let evaluationScale = 1;
  const resources = resourcePlan(maxModels);
  try {
    const output = calculateOutputSize(decoded.width, decoded.height, target);
    const requestedScale = Math.max(output.width / decoded.width, output.height / decoded.height);
    diagnosis = diagnoseImage(decoded.source, decoded.width, decoded.height, file, requestedScale);
    plan = routeModelsForResources(
      planForRoute(diagnosis, !resources.allowHeavy),
      resources,
    );

    if (plan.models.length && requestedScale >= 1.35) {
      evaluationScale = Math.min(4, Math.max(2, requestedScale));
      zones = pickZones(
        decoded.source,
        decoded.width,
        decoded.height,
        resources.probeBudget,
      ).map((zone) => {
        const side = Math.min(ZONE_SIDE, decoded.width, decoded.height);
        const { canvas, ctx } = canvas2d(side, side);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(decoded.source, zone.x, zone.y, side, side, 0, 0, side, side);
        const reference = resample(
          canvas,
          0,
          0,
          side,
          side,
          Math.round(side * evaluationScale),
          Math.round(side * evaluationScale),
        );
        return {
          source: canvas,
          reference,
          kind: zone.kind,
          label: zone.label,
          weight: zone.weight,
          sourceConfidence: zoneConfidence(canvas, zone.kind),
        };
      });
    }
  } finally {
    decoded.close();
  }

  const candidates: CandidateReport[] = [];
  const signatures = new Map<CandidateId, Float32Array[]>();
  const zoneOutputs = new Map<CandidateId, HTMLCanvasElement[]>();
  const qcMode = plan.route === "noisy" || plan.route === "jpeg" || plan.route === "old-photo" ? "restoration" : "fidelity";
  const outputSide = (zone: EvaluationZone) => zone.reference.width;

  // Candidat classique. Image propre ou floue : Lanczos + unsharp.
  // Image bruitée / JPEG / ancienne : débruitage classique puis Lanczos
  // (accentuer une source bruitée ne ferait qu'amplifier le bruit).
  const classicLabel = qcMode === "restoration" ? "Débruitage + Lanczos" : "Lanczos + Unsharp";
  if (zones.length) {
    const started = performance.now();
    const outputs = zones.map((zone) => {
      if (qcMode === "restoration") {
        const cleaned = smoothCanvas(zone.source, 1);
        return resample(cleaned, 0, 0, cleaned.width, cleaned.height, zone.reference.width, zone.reference.height);
      }
      const copy = resample(zone.reference, 0, 0, zone.reference.width, zone.reference.height, zone.reference.width, zone.reference.height);
      unsharpMask(copy, 0.35 + plan.finishSharpen);
      return copy;
    });
    const score = scoreCandidate(zones, outputs, qcMode);
    signatures.set("classic", signatureOf(outputs));
    zoneOutputs.set("classic", outputs);
    candidates.push({
      id: "classic",
      label: classicLabel,
      status: score.rejected ? "rejected" : "ok",
      score,
      error: null,
      elapsedMs: performance.now() - started,
      scale: 1,
      zoneWinWeight: 0,
      disagreement: null,
      zoneScores: zones.map((zone, index) => {
        const local = scoreCandidate([zone], [outputs[index]], qcMode);
        return {
          label: zone.label ?? zone.kind,
          score: local.score,
          rejected: local.rejected,
        };
      }),
    });
  }

  // Candidats IA, un modèle en mémoire à la fois.
  for (let index = 0; index < plan.models.length && zones.length; index += 1) {
    throwIfCancelled();
    const model = RESTORATION_MODELS[plan.models[index]];
    const base = 0.06 + (index / plan.models.length) * 0.44;
    const started = performance.now();
    try {
      onProgress?.(base, `Studio Auto · chargement ${model.label}`);
      await loadAiModel({ kind: "url", url: model.url, label: model.label }, (ratio, label) =>
        onProgress?.(base + ratio * 0.2 / plan.models.length, `${model.label} · ${label}`),
      );
      const loaded = loadedModel();
      const outputs: HTMLCanvasElement[] = [];
      for (const zone of zones) {
        throwIfCancelled();
        onProgress?.(base + 0.3 / plan.models.length, `Studio Auto · essai ${model.label} (${zone.kind === "detail" ? "zone détaillée" : "zone plate"})`);
        const raw = await upscaleWithAi(zone.source);
        outputs.push(resample(raw, 0, 0, raw.width, raw.height, outputSide(zone), outputSide(zone)));
        raw.width = 1;
        raw.height = 1;
      }
      const score = scoreCandidate(zones, outputs, qcMode);
      signatures.set(model.id, signatureOf(outputs));
      zoneOutputs.set(model.id, outputs);
      candidates.push({
        id: model.id,
        label: model.label,
        status: score.rejected ? "rejected" : "ok",
        score,
        error: null,
        elapsedMs: performance.now() - started,
        scale: loaded?.scale ?? null,
        zoneWinWeight: 0,
        disagreement: null,
        zoneScores: zones.map((zone, zoneIndex) => {
          const local = scoreCandidate([zone], [outputs[zoneIndex]], qcMode);
          return {
            label: zone.label ?? zone.kind,
            score: local.score,
            rejected: local.rejected,
          };
        }),
      });
    } catch (reason) {
      if (isCancelledError(reason)) throw reason;
      candidates.push({
        id: model.id,
        label: model.label,
        status: "failed",
        score: null,
        error: errorText(reason),
        elapsedMs: performance.now() - started,
        scale: null,
        zoneWinWeight: 0,
        disagreement: null,
        zoneScores: [],
      });
    }
  }

  // ---------------- Evidence Gate v2 ----------------
  // 1) chaque région vote pour le candidat valide qui la traite le mieux ;
  // 2) les IA sont pénalisées si elles se contredisent fortement ;
  // 3) l'optimisation ne s'applique qu'après les contraintes de sûreté QC.
  const valid = candidates.filter((candidate) => candidate.status === "ok" && candidate.score);
  const classic = valid.find((candidate) => candidate.id === "classic") ??
    candidates.find((candidate) => candidate.id === "classic");

  let totalZoneWeight = 0;
  const regionalEvidence: string[] = [];
  zones.forEach((zone, zoneIndex) => {
    const eligible = valid
      .filter((candidate) => {
        const local = candidate.zoneScores[zoneIndex];
        return local && !local.rejected;
      })
      .sort(
        (a, b) =>
          b.zoneScores[zoneIndex].score -
          a.zoneScores[zoneIndex].score,
      );
    const localWinner = eligible[0];
    const weight = zone.weight ?? 1;
    totalZoneWeight += weight;
    if (localWinner) {
      localWinner.zoneWinWeight += weight;
      regionalEvidence.push(
        `${zone.label ?? zone.kind} → ${localWinner.label} (${localWinner.zoneScores[zoneIndex].score.toFixed(1)})`,
      );
    }
  });

  const validAi = valid.filter((candidate) => candidate.id !== "classic");
  let disagreementSum = 0;
  let disagreementPairs = 0;
  for (let i = 0; i < validAi.length; i += 1) {
    let localSum = 0;
    let localPairs = 0;
    for (let j = 0; j < validAi.length; j += 1) {
      if (i === j) continue;
      const left = signatures.get(validAi[i].id);
      const right = signatures.get(validAi[j].id);
      if (!left || !right) continue;
      const value = signatureDisagreement(left, right);
      localSum += value;
      localPairs += 1;
      if (j > i) {
        disagreementSum += value;
        disagreementPairs += 1;
      }
    }
    validAi[i].disagreement = localPairs ? localSum / localPairs : 0;
  }

  const meanAiDisagreement =
    disagreementPairs ? disagreementSum / disagreementPairs : null;

  const evidenceScore = (candidate: CandidateReport) => {
    const regionalSupport =
      totalZoneWeight > 0 ? candidate.zoneWinWeight / totalZoneWeight : 0;
    const disagreementPenalty =
      candidate.id === "classic"
        ? 0
        : Math.max(0, (candidate.disagreement ?? 0) - 0.035) * 85;
    return (
      (candidate.score?.score ?? -100) +
      regionalSupport * 8 -
      disagreementPenalty
    );
  };

  const bestAi = [...validAi].sort(
    (a, b) => evidenceScore(b) - evidenceScore(a),
  )[0];

  let winner: CandidateReport | undefined = classic;
  let decision: string;

  if (!zones.length) {
    decision = plan.models.length
      ? "Agrandissement trop faible pour justifier une reconstruction IA : rééchantillonnage haute qualité."
      : "Image propre : rééchantillonnage haute qualité, aucune reconstruction IA nécessaire.";
  } else if (bestAi) {
    const regionalSupport =
      totalZoneWeight > 0 ? bestAi.zoneWinWeight / totalZoneWeight : 0;
    const disagreement = bestAi.disagreement ?? 0;
    const disagreementMargin = Math.max(0, (disagreement - 0.04) * 70);
    const requiredMargin = QC_RULES.aiMargin + disagreementMargin;
    const classicScore =
      classic?.score && classic.status === "ok"
        ? evidenceScore(classic)
        : -Infinity;
    const aiScore = evidenceScore(bestAi);
    const enoughRegionalEvidence =
      regionalSupport >= (zones.length >= 6 ? 0.18 : 0.24);

    if (
      (!Number.isFinite(classicScore) || aiScore >= classicScore + requiredMargin) &&
      enoughRegionalEvidence
    ) {
      winner = bestAi;
      decision =
        `${bestAi.label} retenu par Evidence Gate : score ajusté ${aiScore.toFixed(1)}` +
        `, soutien régional ${Math.round(regionalSupport * 100)} %` +
        (validAi.length > 1
          ? `, désaccord IA ${(disagreement * 100).toFixed(1)} %.`
          : ".");
    } else {
      decision =
        `Référence classique conservée : ${bestAi.label} n'apporte pas assez de preuves convergentes` +
        ` (score ajusté ${aiScore.toFixed(1)}, soutien régional ${Math.round(regionalSupport * 100)} %` +
        (validAi.length > 1
          ? `, désaccord IA ${(disagreement * 100).toFixed(1)} %).`
          : ").");
    }
  } else {
    decision = "Aucun candidat IA valide après les contraintes QC : référence classique conservée.";
  }

  const winnerId: CandidateId = winner?.id ?? "classic";
  throwIfCancelled();

  // Traitement complet avec le seul gagnant.
  let result: ImageEnhanceResult;
  if (winnerId === "classic") {
    onProgress?.(0.55, "Studio Auto · traitement final classique");
    result = await enhanceImage(file, target, profile, format, {
      ...enhanceOptions,
      engine: "canvas",
      onProgress: (value, label) => onProgress?.(0.55 + value * 0.45, label),
    });
  } else {
    const model = RESTORATION_MODELS[winnerId];
    if (loadedModel()?.source !== model.label) {
      onProgress?.(0.52, `Studio Auto · rechargement ${model.label}`);
      await loadAiModel({ kind: "url", url: model.url, label: model.label });
    }
    onProgress?.(0.55, `Studio Auto · traitement final ${model.label}`);
    result = await enhanceImage(file, target, profile, format, {
      ...enhanceOptions,
      engine: "ai",
      onProgress: (value, label) => onProgress?.(0.55 + value * 0.45, label),
    });
  }

  for (const outputs of zoneOutputs.values()) {
    for (const canvas of outputs) {
      canvas.width = 1;
      canvas.height = 1;
    }
  }

  return {
    result,
    report: {
      diagnosis,
      plan,
      candidates,
      winner: winnerId,
      winnerLabel: winner?.label ?? classicLabel,
      decision,
      evaluationScale,
      qcMode,
      probeCount: zones.length,
      meanSourceConfidence:
        zones.length
          ? zones.reduce(
              (sum, zone) => sum + (zone.sourceConfidence ?? 0.7),
              0,
            ) / zones.length
          : 1,
      meanAiDisagreement,
      resourceProfile: resources.label,
      regionalEvidence,
    },
  };
}
