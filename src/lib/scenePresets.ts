import type { DeepFocusSettings } from "./deepFocus";
import type { PrecisionRestoreSettings } from "./precisionRestore";
import type { DepthFocusSettings } from "./depth/depthTypes";

export type ScenePresetId =
  | "balanced"
  | "text-signs"
  | "main-object"
  | "aggressive"
  | "mobile-safe";

export type SceneModeId = "auto" | ScenePresetId;

export interface ScenePreset {
  id: ScenePresetId;
  label: string;
  description: string;
  deepFocus: DeepFocusSettings;
  precisionRestore: PrecisionRestoreSettings;
  depthFocusPrecision: DepthFocusSettings;
}

export const SCENE_PRESETS: Record<ScenePresetId, ScenePreset> = {
  balanced: {
    id: "balanced",
    label: "Équilibré",
    description: "Compromis général entre fidélité, netteté et protection du bruit.",
    deepFocus: { enabled: true, layers: 12, strength: 0.66 },
    precisionRestore: {
      enabled: true,
      strength: 0.64,
      textBias: 0.84,
      edgeBias: 0.74,
      flatProtection: 0.74,
      centralBias: 0.30,
      noiseGate: 0.24,
    },
    depthFocusPrecision: {
      enabled: true,
      mode: "heuristic",
      planes: 12,
      globalStrength: 0.56,
      confidenceGate: 0.30,
      fusionFeather: 0.42,
      centerBias: 0.34,
    },
  },
  "text-signs": {
    id: "text-signs",
    label: "Texte & Enseignes",
    description: "Priorité aux lettres, panneaux, affiches et marquages déjà présents.",
    deepFocus: { enabled: true, layers: 12, strength: 0.62 },
    precisionRestore: {
      enabled: true,
      strength: 0.68,
      textBias: 0.92,
      edgeBias: 0.72,
      flatProtection: 0.74,
      centralBias: 0.22,
      noiseGate: 0.25,
    },
    depthFocusPrecision: {
      enabled: true,
      mode: "heuristic",
      planes: 12,
      globalStrength: 0.54,
      confidenceGate: 0.28,
      fusionFeather: 0.40,
      centerBias: 0.24,
    },
  },
  "main-object": {
    id: "main-object",
    label: "Objet principal",
    description: "Accentue davantage les contours structurés proches du centre de l'image.",
    deepFocus: { enabled: true, layers: 14, strength: 0.68 },
    precisionRestore: {
      enabled: true,
      strength: 0.66,
      textBias: 0.72,
      edgeBias: 0.86,
      flatProtection: 0.77,
      centralBias: 0.78,
      noiseGate: 0.23,
    },
    depthFocusPrecision: {
      enabled: true,
      mode: "heuristic",
      planes: 14,
      globalStrength: 0.62,
      confidenceGate: 0.30,
      fusionFeather: 0.48,
      centerBias: 0.58,
    },
  },
  aggressive: {
    id: "aggressive",
    label: "Agressif",
    description: "Traitement démonstratif, à surveiller dans Quality Lab pour halos et bruit.",
    deepFocus: { enabled: true, layers: 14, strength: 0.72 },
    precisionRestore: {
      enabled: true,
      strength: 0.72,
      textBias: 0.88,
      edgeBias: 0.80,
      flatProtection: 0.70,
      centralBias: 0.48,
      noiseGate: 0.26,
    },
    depthFocusPrecision: {
      enabled: true,
      mode: "heuristic",
      planes: 16,
      globalStrength: 0.68,
      confidenceGate: 0.24,
      fusionFeather: 0.52,
      centerBias: 0.48,
    },
  },
  "mobile-safe": {
    id: "mobile-safe",
    label: "Mobile Safe",
    description: "Réglage prudent pour la mémoire, le bruit et un rendu naturel.",
    deepFocus: { enabled: true, layers: 10, strength: 0.56 },
    precisionRestore: {
      enabled: true,
      strength: 0.50,
      textBias: 0.70,
      edgeBias: 0.62,
      flatProtection: 0.82,
      centralBias: 0.18,
      noiseGate: 0.24,
    },
    depthFocusPrecision: {
      enabled: true,
      mode: "heuristic",
      planes: 10,
      globalStrength: 0.48,
      confidenceGate: 0.34,
      fusionFeather: 0.38,
      centerBias: 0.20,
    },
  },
};

export const DEFAULT_SCENE_MODE: SceneModeId = "auto";

export function getScenePreset(id: ScenePresetId): ScenePreset {
  return SCENE_PRESETS[id];
}
