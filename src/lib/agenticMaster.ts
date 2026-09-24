import { applyNaturalFinish } from "./restoration/naturalFinish";
import { compareImageQuality, type QualityComparison, type ZoneComparison } from "./qualityComparator";
import { decodeImageFile } from "./imageDecode";
import { canvas2d, unsharpMask } from "./restoration/imageMath";
import {
  fuseMasterWithEvidence,
  type EvidenceFusionReport,
} from "./evidenceFusion";
import { aiEngineAvailable, loadedModel, webGpuAvailable } from "./aiUpscaler";
import {
  buildAutopilotImagePlan,
  type AutopilotImagePlan,
} from "./autopilotPolicy";
import {
  duelFinalMasters,
  type FinalMasterDuel,
} from "./finalMasterDuel";
import { isCancelledError, throwIfCancelled } from "./cancellation";
import type { DepthFocusSettings } from "./depth/depthTypes";
import type { DeepFocusSettings } from "./deepFocus";
import { enhanceImage, type ImageEnhanceResult, type ImageFormat } from "./imageEnhancer";
import type { Size, TargetId } from "./geometry";
import {
  orchestrateMediaAgents,
  type AgentDecision,
  type AgentPlan,
} from "./mediaAgents";
import { validateImageMaster, type MasterValidationReport } from "./masterValidator";
import type { PrecisionRestoreSettings } from "./precisionRestore";
import type { ProfileId } from "./profiles";
import {
  runAutoStudio,
  type StudioReport,
} from "./restoration/autoStudio";
import type { CodecIntent } from "./videoCodec";

export interface AgenticImageMasterOptions {
  file: File;
  sourceSize: Size;
  target: TargetId;
  profile: ProfileId;
  format: ImageFormat;
  intent: CodecIntent;
  deepFocus: DeepFocusSettings;
  precisionRestore: PrecisionRestoreSettings;
  depthFocusPrecision: DepthFocusSettings;
  onProgress?: (value: number, label: string) => void;
}

export interface AgenticImageMasterResult {
  result: ImageEnhanceResult;
  studio: StudioReport | null;
  plan: AgentPlan;
  validation: MasterValidationReport;
  decisions: AgentDecision[];
  usedEmergencyFallback: boolean;
  /** Comparaison finale master ↔ original, calculée avant la livraison. */
  comparison: QualityComparison;
  autopilot: AutopilotImagePlan;
  duel: FinalMasterDuel | null;
  evidenceFusion: EvidenceFusionReport | null;
}

function decision(
  agent: AgentDecision["agent"],
  label: string,
  status: AgentDecision["status"],
  message: string,
): AgentDecision {
  return { agent, label, status, message };
}

/**
 * Chaîne autonome image :
 * superviseur → vision/qualité/mémoire → Evidence Gate multi-modèles →
 * Performance Governor → master pleine résolution → validation du fichier.
 *
 * En cas d'échec de tous les moteurs IA, un master déterministe est produit
 * automatiquement puis validé avant d'être rendu à l'interface.
 */
export async function runAgenticImageMaster(
  options: AgenticImageMasterOptions,
): Promise<AgenticImageMasterResult> {
  const {
    file,
    sourceSize,
    intent,
    onProgress,
  } = options;

  onProgress?.(0.01, "AutoPilot v3 · politique automatique");
  const autopilot = await buildAutopilotImagePlan(file, sourceSize);
  const deepFocus = autopilot.scenePreset.deepFocus;
  const precisionRestore = autopilot.scenePreset.precisionRestore;
  const depthFocusPrecision =
    autopilot.scenePreset.depthFocusPrecision;

  onProgress?.(0.04, "Agent Superviseur · mission master");
  const plan = await orchestrateMediaAgents({
    file,
    mode: "image",
    sourceSize,
    target: autopilot.target,
    profile: autopilot.profile,
    engine: loadedModel() ? "ai" : "canvas",
    format: autopilot.format,
    intent,
    aiModelLoaded: Boolean(loadedModel()),
    aiAvailable: aiEngineAvailable(),
    webGpu: loadedModel()?.provider === "webgpu" || webGpuAvailable(),
  });
  throwIfCancelled();

  const decisions: AgentDecision[] = [
    ...plan.decisions,
    decision(
      "supervisor",
      "Agent Master",
      "ok",
      "AutoPilot v3 engagé : cible, format et réglages de restauration automatiques, Evidence Gate, traitement pleine résolution, duel final et validation.",
    ),
  ];

  let result: ImageEnhanceResult | null = null;
  let studio: StudioReport | null = null;
  let usedEmergencyFallback = false;
  let duel: FinalMasterDuel | null = null;
  let evidenceFusion: EvidenceFusionReport | null = null;

  try {
    onProgress?.(0.10, "Agents experts · benchmark des moteurs");
    const studioResult = await runAutoStudio(
      file,
      plan.target,
      plan.profile,
      plan.format,
      {
        deepFocus,
        precisionRestore,
        depthFocusPrecision,
        // En mode master autonome, la ROI est toujours autorisée ; son
        // détecteur décide lui-même de ne rien appliquer sans confiance.
        smallSubjectRoi: {
          enabled: true,
          strength: plan.profile === "detail" ? 0.92 : 0.82,
        },
        onProgress: (value, label) =>
          onProgress?.(0.10 + value * 0.78, label),
      },
    );
    result = studioResult.result;
    studio = studioResult.report;
    decisions.push(
      decision(
        "quality",
        "Agent Evidence Gate",
        "ok",
        `${studio.winnerLabel} a produit le master pleine résolution après ${studio.finalAttempts.length} tentative(s) finale(s).`,
      ),
    );

    // Duel final : un gagnant IA n'est conservé que s'il bat réellement une
    // baseline déterministe produite avec les mêmes réglages de restauration.
    if (result.engineUsed === "ai") {
      onProgress?.(0.89, "Agent Vérité · baseline déterministe finale");
      const classic = await enhanceImage(
        file,
        plan.target,
        plan.profile,
        plan.format,
        {
          engine: "canvas",
          deepFocus,
          precisionRestore,
          depthFocusPrecision,
          smallSubjectRoi: {
            enabled: true,
            strength: plan.profile === "detail" ? 0.86 : 0.76,
          },
          onProgress: (value, label) =>
            onProgress?.(0.89 + value * 0.045, label),
        },
      );

      onProgress?.(0.936, "Agent Vérité · duel final");
      duel = await duelFinalMasters(
        file,
        result.blob,
        classic.blob,
      );

      if (duel.winner === "classic") {
        result = classic;
        studio.winner = "classic";
        studio.winnerLabel = "Baseline déterministe";
        studio.decision += " " + duel.rationale;
      } else {
        studio.decision += " " + duel.rationale;
      }

      decisions.push(
        decision(
          "quality",
          "Agent Vérité",
          "ok",
          duel.rationale +
            ` SSIM IA ${duel.primary.ssimToSource.toFixed(4)} vs classique ${duel.classic.ssimToSource.toFixed(4)}.`,
        ),
      );
    }
  } catch (reason) {
    if (isCancelledError(reason)) throw reason;
    usedEmergencyFallback = true;
    const detail = reason instanceof Error ? reason.message : String(reason);
    decisions.push(
      decision(
        "memory",
        "Agent Recovery",
        "warning",
        `La chaîne multi-modèles n'a pas terminé (${detail.slice(0, 220)}) : repli automatique vers le moteur déterministe sécurisé.`,
      ),
    );
    onProgress?.(0.22, "Agent Recovery · master déterministe");
    result = await enhanceImage(
      file,
      plan.target,
      plan.profile,
      plan.format,
      {
        engine: "canvas",
        deepFocus,
        precisionRestore,
        depthFocusPrecision,
        smallSubjectRoi: {
          enabled: true,
          strength: plan.profile === "detail" ? 0.86 : 0.76,
        },
        onProgress: (value, label) =>
          onProgress?.(0.22 + value * 0.66, label),
      },
    );
  }

  // Evidence Fusion : fusion tuilée à trois bandes de fréquences.
  // La basse fréquence et la chrominance restent ancrées sur l'original ;
  // l'IA n'apporte les fréquences moyenne/haute que là où structure,
  // cohérence locale et cycle consistency le justifient.
  if (result.engineUsed === "ai") {
    throwIfCancelled();
    onProgress?.(0.935, "Evidence Fusion · fréquences + cycle consistency");
    try {
      const fused = await fuseMasterWithEvidence(
        file,
        result.blob,
        result.size,
        {
          format: plan.format,
          onProgress: (ratio, label) =>
            onProgress?.(0.935 + ratio * 0.012, label),
        },
      );
      evidenceFusion = fused.report;
      if (fused.report.applied) {
        result = { ...result, blob: fused.blob };
        decisions.push(
          decision(
            "quality",
            "Agent Evidence Fusion",
            "ok",
            `Fusion multi-fréquence validée : poids IA détail moyen ${Math.round(fused.report.meanAiDetailWeight * 100)} % · cycle ${Math.round(fused.report.cycleConfidence * 100)} % · MAE ${fused.report.cycleMeanAbsoluteError.toFixed(2)} · ${fused.report.rejectedDetailPercent.toFixed(1)} % des détails IA fortement atténués.`,
          ),
        );
      } else {
        decisions.push(
          decision(
            "quality",
            "Agent Evidence Fusion",
            "warning",
            fused.report.skippedReason ?? "Evidence Fusion non appliquée.",
          ),
        );
      }
    } catch (reason) {
      decisions.push(
        decision(
          "quality",
          "Agent Evidence Fusion",
          "warning",
          `Evidence Fusion non appliquée : ${reason instanceof Error ? reason.message : "raison inconnue"}.`,
        ),
      );
    }
  }

  throwIfCancelled();
  onProgress?.(0.95, "Agent Validation · contrôle du master final");
  let validation = await validateImageMaster(result.blob, result.size);

  if (!validation.valid && result.engineUsed === "ai") {
    usedEmergencyFallback = true;
    decisions.push(
      decision(
        "validation",
        "Agent Validation",
        "warning",
        `Master IA refusé : ${validation.message}. Reconstruction déterministe automatique.`,
      ),
    );
    const deterministic = await enhanceImage(
      file,
      plan.target,
      plan.profile,
      plan.format,
      {
        engine: "canvas",
        deepFocus,
        precisionRestore,
        depthFocusPrecision,
        smallSubjectRoi: { enabled: true, strength: 0.76 },
        onProgress: (value, label) =>
          onProgress?.(0.95 + value * 0.04, label),
      },
    );
    result = deterministic;
    validation = await validateImageMaster(result.blob, result.size);
  }

  if (!validation.valid) {
    throw new Error(
      "Agent Validation : aucun master conforme n'a pu être produit. " +
        validation.message,
    );
  }

  decisions.push(
    decision(
      "validation",
      "Agent Validation Master",
      "ok",
      `Master validé : ${validation.width}×${validation.height} · ${(validation.bytes / 1024 / 1024).toFixed(2)} Mo · fichier décodable et dimensions conformes.`,
    ),
  );
  // Verrou final ORIGINAL : le master doit être au moins aussi net que la
  // source. Sinon un candidat « Original fidèle » (agrandissement haute
  // qualité seul, sans lissage) est produit et le meilleur des deux gagne.
  throwIfCancelled();
  onProgress?.(0.965, "Verrou final · comparaison avec l'original");
  let comparison = await compareImageQuality(file, result.blob);
  /**
   * Un master n'est livrable que s'il est FIDÈLE et PLUS NET : une netteté
   * globale en hausse ne suffit pas (du bruit injecté dans les aplats la fait
   * monter pendant que texte et contours sont détruits).
   */
  const gateFailures = (c: QualityComparison): string[] => {
    const failures: string[] = [];
    if (c.ssim < 0.8) failures.push(`fidélité SSIM ${c.ssim.toFixed(3)} < 0,80`);
    if (c.psnr < 24) failures.push(`PSNR ${c.psnr.toFixed(1)} dB < 24`);
    if (Math.abs(c.contrastChangePercent) > 20) failures.push(`contraste modifié de ${c.contrastChangePercent.toFixed(0)} %`);
    if (c.sharpnessGainPercent < -2) failures.push(`micro-détail ${c.sharpnessGainPercent.toFixed(1)} %`);
    if (c.edgeGainPercent < -2) failures.push(`contours ${c.edgeGainPercent.toFixed(1)} %`);
    const structured: [string, ZoneComparison][] = [
      ["texte", c.textZone],
      ["contours structurés", c.edgeZone],
      ["structure centrale", c.centralZone],
    ];
    for (const [name, zone] of structured) {
      if (zone.coveragePercent >= 2 && zone.sharpnessGainPercent < -10) {
        failures.push(`${name} ${zone.sharpnessGainPercent.toFixed(0)} %`);
      }
    }
    if (c.flatZone.coveragePercent >= 10 && c.flatZone.sharpnessGainPercent > 200) {
      failures.push(`bruit injecté dans les aplats (+${c.flatZone.sharpnessGainPercent.toFixed(0)} %)`);
    }
    return failures;
  };
  const losesDetail = (c: QualityComparison) => gateFailures(c).length > 0;
  const smallerThanSource =
    result.size.width < sourceSize.width || result.size.height < sourceSize.height;
  if (smallerThanSource || losesDetail(comparison)) {
    onProgress?.(0.975, "Verrou final · candidat Original fidèle");
    const faithful = await faithfulMaster(file, result.size, plan.format);
    const faithfulComparison = await compareImageQuality(file, faithful.blob);
    const score = (c: QualityComparison) => c.sharpnessGainPercent + c.edgeGainPercent;
    const before = comparison;
    const masterFailures = gateFailures(before);
    const faithfulFailures = gateFailures(faithfulComparison);
    // L'Original fidèle gagne dès que le master échoue au verrou et que lui
    // le passe ; sinon, le meilleur score l'emporte.
    if (
      smallerThanSource ||
      (masterFailures.length > 0 && faithfulFailures.length === 0) ||
      score(faithfulComparison) > score(before)
    ) {
      result = { ...result, blob: faithful.blob, size: faithful.size, engineUsed: "canvas", aiPasses: 0 };
      comparison = faithfulComparison;
      if (studio) {
        studio.winner = "classic";
        studio.winnerLabel = "Original fidèle";
      }
      decisions.push(
        decision(
          "quality",
          "Verrou Original",
          "warning",
          `Master refusé (${masterFailures.join(" · ") || "plus petit que la source"}) : ${smallerThanSource ? "plus petit que la source, " : ""}comparé à l'original (micro-détail ${before.sharpnessGainPercent.toFixed(1)} %, contours ${before.edgeGainPercent.toFixed(1)} %). ` +
            `Remplacé par l'Original fidèle (micro-détail ${faithfulComparison.sharpnessGainPercent.toFixed(1)} %, contours ${faithfulComparison.edgeGainPercent.toFixed(1)} %).`,
        ),
      );
    } else {
      decisions.push(
        decision(
          "quality",
          "Verrou Original",
          "warning",
          `Master conservé : l'Original fidèle n'a pas fait mieux (micro-détail ${faithfulComparison.sharpnessGainPercent.toFixed(1)} %).`,
        ),
      );
    }
  } else {
    decisions.push(
      decision(
        "quality",
        "Verrou Original",
        "ok",
        `Master au moins aussi net que l'original : micro-détail ${comparison.sharpnessGainPercent >= 0 ? "+" : ""}${comparison.sharpnessGainPercent.toFixed(1)} %, contours ${comparison.edgeGainPercent >= 0 ? "+" : ""}${comparison.edgeGainPercent.toFixed(1)} %.`,
      ),
    );
  }

  // Finition naturelle (après le verrou, pour que le grain ne fausse pas les
  // mesures) : uniquement sur un master IA, dont la peau et les aplats sont
  // lissés par la super-résolution.
  if (result.engineUsed === "ai") {
    throwIfCancelled();
    onProgress?.(0.98, "Finition naturelle · grain photographique");
    try {
      const beforeNatural = result.blob;
      const finished = await applyNaturalFinish(
        result.blob,
        plan.format,
      );
      const finalCheck = await validateImageMaster(
        finished,
        result.size,
      );
      if (finalCheck.valid) {
        result = { ...result, blob: finished };
        validation = finalCheck;
        decisions.push(
          decision(
            "quality",
            "Finition naturelle",
            "ok",
            "Grain photographique fin réintroduit dans les zones lisses, puis fichier final redécodé et validé.",
          ),
        );
      } else {
        result = { ...result, blob: beforeNatural };
        decisions.push(
          decision(
            "validation",
            "Finition naturelle",
            "warning",
            `Finition refusée par la validation finale : ${finalCheck.message}. Master précédent conservé.`,
          ),
        );
      }
    } catch (reason) {
      decisions.push(
        decision(
          "quality",
          "Finition naturelle",
          "warning",
          `Finition non appliquée : ${reason instanceof Error ? reason.message : "raison inconnue"}.`,
        ),
      );
    }
  }

  onProgress?.(0.99, "Master final validé");

  return {
    comparison,
    result,
    studio,
    plan,
    validation,
    decisions,
    usedEmergencyFallback,
    autopilot,
    duel,
    evidenceFusion,
  };
}


/**
 * Candidat « Original fidèle » : l'original agrandi à la taille du master par
 * le rééchantillonnage haute qualité du navigateur, puis une accentuation
 * légère. Aucun débruitage, aucun lissage : rien ne peut effacer du détail.
 */
async function faithfulMaster(
  file: Blob,
  size: { width: number; height: number },
  format: string,
): Promise<{ blob: Blob; size: { width: number; height: number } }> {
  const decoded = await decodeImageFile(file);
  try {
    const width = Math.max(size.width, decoded.width);
    const height = Math.max(size.height, decoded.height);
    const { canvas, ctx } = canvas2d(width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(decoded.source, 0, 0, width, height);
    const upscale = width / decoded.width;
    if (upscale > 1.05) unsharpMask(canvas, Math.min(0.6, 0.25 + 0.2 * (upscale - 1)));
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error("Encodage de l'Original fidèle impossible."))),
        format === "image/jpeg" || format === "image/webp" ? format : "image/png",
        0.95,
      ),
    );
    canvas.width = 1;
    canvas.height = 1;
    return { blob, size: { width, height } };
  } finally {
    decoded.close();
  }
}
