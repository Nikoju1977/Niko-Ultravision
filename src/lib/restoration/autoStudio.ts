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
import { loadAiModel, loadedModel, upscaleWithAi } from "../aiUpscaler";
import { enhanceImage, type EnhanceImageOptions, type ImageEnhanceResult, type ImageFormat } from "../imageEnhancer";
import { isCancelledError, throwIfCancelled } from "../cancellation";
import { canvas2d, gradientEnergy, lumaOf, resample, smoothCanvas, unsharpMask } from "./imageMath";
import { diagnoseImage, planForRoute, type ImageDiagnosis, type RoutePlan } from "./imageDiagnosis";
import { QC_RULES, scoreCandidate, type CandidateScore, type EvaluationZone } from "./qualityController";
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
}

export interface StudioResult {
  result: ImageEnhanceResult;
  report: StudioReport;
}

const ZONE_SIDE = 128;

function lowMemoryDevice(): boolean {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return (typeof nav.deviceMemory === "number" && nav.deviceMemory <= 4) || /Android|iPhone/i.test(navigator.userAgent);
}

/** Choisit la zone la plus détaillée et une zone plate représentative. */
function pickZones(source: CanvasImageSource, width: number, height: number): { x: number; y: number; kind: "detail" | "flat" }[] {
  const side = Math.min(ZONE_SIDE, width, height);
  const viewScale = Math.min(1, 256 / Math.max(width, height));
  const view = lumaOf(resample(source, 0, 0, width, height, width * viewScale, height * viewScale));
  const block = Math.max(4, Math.round(side * viewScale));
  const blocks: { x: number; y: number; energy: number; mean: number }[] = [];

  for (let by = 0; by + block <= view.height; by += Math.max(2, block >> 1)) {
    for (let bx = 0; bx + block <= view.width; bx += Math.max(2, block >> 1)) {
      const sub = new Float32Array(block * block);
      let mean = 0;
      for (let y = 0; y < block; y += 1) {
        for (let x = 0; x < block; x += 1) {
          const v = view.data[(by + y) * view.width + bx + x];
          sub[y * block + x] = v;
          mean += v;
        }
      }
      blocks.push({ x: bx, y: by, energy: gradientEnergy({ data: sub, width: block, height: block }), mean: mean / sub.length });
    }
  }

  // Alignement sur la grille 8×8 d'origine : indispensable pour mesurer
  // les blocs JPEG au bon endroit.
  const align = (value: number, max: number) => {
    const clamped = Math.min(max, Math.max(0, Math.round(value)));
    return clamped - (clamped % 8);
  };
  const toSource = (b: { x: number; y: number }) => ({
    x: align(b.x / viewScale, width - side),
    y: align(b.y / viewScale, height - side),
  });

  if (!blocks.length) return [{ x: 0, y: 0, kind: "detail" }];
  const byEnergy = [...blocks].sort((a, b) => b.energy - a.energy);
  // Zone plate : faible énergie mais ni noire ni brûlée (sinon le bruit est invisible).
  const flat = [...blocks]
    .filter((b) => b.mean > 30 && b.mean < 225)
    .sort((a, b) => a.energy - b.energy)[0];

  const zones: { x: number; y: number; kind: "detail" | "flat" }[] = [{ ...toSource(byEnergy[0]), kind: "detail" }];
  if (flat) zones.push({ ...toSource(flat), kind: "flat" });
  return zones;
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
  const { onProgress, maxModels = 2, ...enhanceOptions } = options;
  onProgress?.(0.02, "Studio Auto · analyse de l'image");

  const decoded = await decodeImageFile(file);
  let diagnosis: ImageDiagnosis;
  let plan: RoutePlan;
  let zones: EvaluationZone[] = [];
  let evaluationScale = 1;
  try {
    const output = calculateOutputSize(decoded.width, decoded.height, target);
    const requestedScale = Math.max(output.width / decoded.width, output.height / decoded.height);
    diagnosis = diagnoseImage(decoded.source, decoded.width, decoded.height, file, requestedScale);
    plan = planForRoute(diagnosis, lowMemoryDevice());
    plan = { ...plan, models: plan.models.slice(0, maxModels) };

    if (plan.models.length && requestedScale >= 1.35) {
      evaluationScale = Math.min(4, Math.max(2, requestedScale));
      zones = pickZones(decoded.source, decoded.width, decoded.height).map((zone) => {
        const side = Math.min(ZONE_SIDE, decoded.width, decoded.height);
        const { canvas, ctx } = canvas2d(side, side);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(decoded.source, zone.x, zone.y, side, side, 0, 0, side, side);
        const reference = resample(canvas, 0, 0, side, side, side * evaluationScale, side * evaluationScale);
        return { source: canvas, reference, kind: zone.kind };
      });
    }
  } finally {
    decoded.close();
  }

  const candidates: CandidateReport[] = [];
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
    candidates.push({
      id: "classic",
      label: classicLabel,
      status: score.rejected ? "rejected" : "ok",
      score,
      error: null,
      elapsedMs: performance.now() - started,
      scale: 1,
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
      candidates.push({
        id: model.id,
        label: model.label,
        status: score.rejected ? "rejected" : "ok",
        score,
        error: null,
        elapsedMs: performance.now() - started,
        scale: loaded?.scale ?? null,
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
      });
    }
  }

  // Sélection : l'IA doit battre la référence classique avec une marge.
  const classic = candidates.find((c) => c.id === "classic");
  const valid = candidates.filter((c) => c.status === "ok" && c.score);
  const bestAi = valid.filter((c) => c.id !== "classic").sort((a, b) => b.score!.score - a.score!.score)[0];
  let winner: CandidateReport | undefined = classic;
  let decision: string;

  if (!zones.length) {
    decision = plan.models.length
      ? "Agrandissement trop faible pour justifier une reconstruction IA : rééchantillonnage haute qualité."
      : "Image propre : rééchantillonnage haute qualité, aucune reconstruction IA nécessaire.";
  } else if (bestAi && (!classic?.score || classic.status !== "ok" || bestAi.score!.score >= classic.score.score + QC_RULES.aiMargin)) {
    winner = bestAi;
    decision = `${bestAi.label} retenu : score ${bestAi.score!.score} contre ${classic?.score?.score ?? "—"} pour la référence classique.`;
  } else if (bestAi) {
    decision = `Référence classique conservée : ${bestAi.label} (${bestAi.score!.score}) ne la bat pas d'au moins ${QC_RULES.aiMargin} points.`;
  } else {
    decision = "Aucun candidat IA valide : référence classique conservée.";
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
    },
  };
}
