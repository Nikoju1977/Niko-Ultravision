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
  autopilot: AutopilotImagePlan;
  duel: FinalMasterDuel | null;
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
    decisions.push(
      decision(
        "memory",
        "Agent Recovery",
        "warning",
        "La chaîne multi-modèles n'a pas terminé : repli automatique vers le moteur déterministe sécurisé.",
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
  onProgress?.(1, "Master final validé");

  return {
    result,
    studio,
    plan,
    validation,
    decisions,
    usedEmergencyFallback,
    autopilot,
    duel,
  };
}
