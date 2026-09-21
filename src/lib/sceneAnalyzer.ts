import { decodeImageFile } from "./imageDecode";
import { buildZoneMasks } from "./qualityZones";
import type { ScenePresetId } from "./scenePresets";

export interface SceneAnalysis {
  recommendedPreset: ScenePresetId;
  confidence: number;
  textScore: number;
  edgeScore: number;
  flatScore: number;
  centralScore: number;
  explanation: string;
}

const MAX_SIDE = 520;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export async function analyzeScene(source: Blob): Promise<SceneAnalysis> {
  const decoded = await decodeImageFile(source);
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(decoded.width, decoded.height));
    const width = Math.max(32, Math.round(decoded.width * scale));
    const height = Math.max(32, Math.round(decoded.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Canvas 2D indisponible pour l'analyse de scène.");

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(decoded.source, 0, 0, width, height);
    const image = ctx.getImageData(0, 0, width, height);
    const masks = buildZoneMasks(image);

    const textScore = clamp(masks.textCoverage / 0.20, 0, 1);
    const edgeScore = clamp(masks.edgeCoverage / 0.28, 0, 1);
    const flatScore = clamp(masks.flatCoverage / 0.80, 0, 1);
    const centralScore = clamp(masks.centralStructure / 0.22, 0, 1);

    let recommendedPreset: ScenePresetId = "balanced";
    let confidence = 0.58;
    let explanation = "Structure de scène mixte : réglage équilibré recommandé.";

    if (textScore >= 0.66 && textScore >= centralScore * 0.88) {
      recommendedPreset = "text-signs";
      confidence = clamp(0.55 + textScore * 0.35, 0, 0.94);
      explanation = "Beaucoup de petites structures contrastées compatibles avec enseignes, affiches ou marquages.";
    } else if (centralScore >= 0.58 && edgeScore >= 0.36) {
      recommendedPreset = "main-object";
      confidence = clamp(0.54 + centralScore * 0.36, 0, 0.93);
      explanation = "Une concentration de contours structurés est détectée près du centre : priorité à l'objet principal.";
    } else if (flatScore >= 0.84 && edgeScore < 0.34) {
      recommendedPreset = "mobile-safe";
      confidence = clamp(0.56 + flatScore * 0.26, 0, 0.90);
      explanation = "La scène contient beaucoup d'aplats et peu de contours forts : restauration prudente recommandée.";
    }

    return {
      recommendedPreset,
      confidence,
      textScore,
      edgeScore,
      flatScore,
      centralScore,
      explanation,
    };
  } finally {
    decoded.close();
  }
}
