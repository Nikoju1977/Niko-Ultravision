import { calculateOutputSize } from "./geometry";
import { assessImageTarget, type ImageFormat } from "./imageEnhancer";
import type { Size, TargetId } from "./geometry";
import type { ProfileId } from "./profiles";
import { analyzeScene, type SceneAnalysis } from "./sceneAnalyzer";
import {
  getScenePreset,
  type ScenePreset,
  type ScenePresetId,
} from "./scenePresets";
import {
  devicePerformanceSummary,
  readDevicePerformanceProfile,
} from "./devicePerformanceProfile";

export interface AutopilotImagePlan {
  target: TargetId;
  profile: ProfileId;
  format: ImageFormat;
  scene: SceneAnalysis;
  scenePresetId: ScenePresetId;
  scenePreset: ScenePreset;
  rationale: string[];
  deviceSummary: string;
}

function memoryGb(): number | null {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return typeof nav.deviceMemory === "number"
    ? nav.deviceMemory
    : null;
}

function targetCandidates(
  source: Size,
  hasStableAi: boolean,
): TargetId[] {
  const longSide = Math.max(source.width, source.height);
  const memory = memoryGb();
  const mobile = /Android|iPhone|iPad|iPod/i.test(
    navigator.userAgent,
  );

  // Une source déjà très définie gagne plus à être restaurée à sa définition
  // native qu'à subir une super-résolution inutile.
  if (longSide >= 3840) return ["original"];

  if (longSide >= 1900) {
    // Entre 1900 et 3840 px, seule la 4K agrandit réellement.
    return ["4k", "original"];
  }

  if (longSide >= 1100) {
    if (!mobile && (memory === null || memory >= 8) && hasStableAi) {
      return ["4k", "2k", "original"];
    }
    return ["2k", "4k", "original"];
  }

  // Les petites images sont les plus susceptibles d'avoir besoin d'IA, mais
  // on reste prudent sur mobile : 2K est préférable à un faux 8K.
  return hasStableAi
    ? ["2k", "4k", "original"]
    : ["2k", "original"];
}

function chooseProfile(scene: SceneAnalysis): ProfileId {
  if (scene.recommendedPreset === "text-signs") return "detail";
  if (scene.recommendedPreset === "main-object") return "detail";
  if (scene.recommendedPreset === "mobile-safe") return "fidelity";
  return "fidelity";
}

export async function buildAutopilotImagePlan(
  file: Blob,
  source: Size,
): Promise<AutopilotImagePlan> {
  const scene = await analyzeScene(file);
  const profileData = readDevicePerformanceProfile();
  const knownModels = Object.values(profileData.models);
  const hasStableAi = knownModels.some(
    (entry) =>
      entry.successCount >= 1 &&
      entry.successCount >= entry.failureCount &&
      entry.lastError === null,
  );

  // Règle absolue : une cible n'est jamais plus petite que la source.
  // (Une source 1080×2400 en « 2K » donnait 922×2048 : une réduction.)
  const sourceLong = Math.max(source.width, source.height);
  const candidates = targetCandidates(source, hasStableAi).filter((candidate) => {
    if (candidate === "original") return true;
    const size = calculateOutputSize(source.width, source.height, candidate);
    return Math.max(size.width, size.height) >= sourceLong * 1.1;
  });
  let target: TargetId = "original";
  for (const candidate of candidates) {
    if (assessImageTarget(source, candidate).supported) {
      target = candidate;
      break;
    }
  }

  const scenePresetId = scene.recommendedPreset;
  const scenePreset = getScenePreset(scenePresetId);
  const profile = chooseProfile(scene);
  const format: ImageFormat = "image/png";
  const longSide = Math.max(source.width, source.height);

  const rationale = [
    `Scène : ${scenePreset.label} · confiance ${Math.round(scene.confidence * 100)} %.`,
    longSide >= 3840
      ? "Source déjà ≥ 4K : définition native conservée pour éviter un upscale sans gain démontré."
      : `Cible automatique ${target.toUpperCase()} selon définition source et budget local.`,
    "Export PNG sans perte retenu pour le master image automatique.",
    `Profil qualité initial : ${profile}; l'Agent Qualité peut encore l'ajuster après analyse du signal.`,
    devicePerformanceSummary(),
  ];

  return {
    target,
    profile,
    format,
    scene,
    scenePresetId,
    scenePreset,
    rationale,
    deviceSummary: devicePerformanceSummary(),
  };
}
