import {
  AI_MODEL_PRESETS,
  aiEngineAvailable,
  loadAiModel,
  loadedModel,
  webGpuAvailable,
} from "./aiUpscaler";
import { calculateOutputSize, type Size, type TargetId } from "./geometry";
import {
  orchestrateMediaAgents,
  type AgentDecision,
  type AgentPlan,
} from "./mediaAgents";
import { enhanceVideo, type VideoEnhanceResult } from "./videoEnhancer";
import { validateVideoMaster, type VideoMasterValidationReport } from "./videoMasterValidator";
import type { CodecIntent } from "./videoCodec";

export interface AgenticVideoMasterOptions {
  file: File;
  sourceSize: Size;
  mistralEnabled?: boolean;
  mistralApiKey?: string;
  mistralModel?: string;
  onProgress?: (value: number, label: string) => void;
}

export interface AgenticVideoMasterResult {
  result: VideoEnhanceResult;
  plan: AgentPlan;
  validation: VideoMasterValidationReport;
  decisions: AgentDecision[];
  neuralRequested: boolean;
  neuralReady: boolean;
}

function automaticVideoTarget(source: Size): TargetId {
  const longSide = Math.max(source.width, source.height);
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (longSide >= 3840) return "original";
  if (longSide >= 1900) return mobile ? "2k" : "4k";
  if (longSide >= 1200) return mobile ? "1080p" : "2k";
  return "1080p";
}

function d(
  label: string,
  status: AgentDecision["status"],
  message: string,
): AgentDecision {
  return {
    agent: "supervisor",
    label,
    status,
    message,
  };
}

export async function runAgenticVideoMaster(
  options: AgenticVideoMasterOptions,
): Promise<AgenticVideoMasterResult> {
  const {
    file,
    sourceSize,
    mistralEnabled,
    mistralApiKey,
    mistralModel,
    onProgress,
  } = options;

  const requestedTarget = automaticVideoTarget(sourceSize);
  const intent: CodecIntent = "master";

  onProgress?.(0.02, "AutoPilot v3 vidéo · analyse");
  const plan = await orchestrateMediaAgents({
    file,
    mode: "video",
    sourceSize,
    target: requestedTarget,
    profile: "fidelity",
    engine: "canvas",
    format: "image/png",
    intent,
    aiModelLoaded: Boolean(loadedModel()),
    aiAvailable: aiEngineAvailable(),
    webGpu: loadedModel()?.provider === "webgpu" || webGpuAvailable(),
    mistralEnabled,
    mistralApiKey,
    mistralModel,
  });

  const output = calculateOutputSize(
    sourceSize.width,
    sourceSize.height,
    plan.target,
  );
  const scale = Math.max(
    output.width / sourceSize.width,
    output.height / sourceSize.height,
  );
  const neuralRequested =
    aiEngineAvailable() &&
    scale >= 1.25;

  const decisions: AgentDecision[] = [
    ...plan.decisions,
    d(
      "Agent Directeur Vidéo",
      "ok",
      `Cible automatique ${plan.target} · profil ${plan.profile} · intent master.`,
    ),
  ];

  let neuralReady = Boolean(loadedModel());
  if (neuralRequested && !neuralReady) {
    try {
      onProgress?.(0.14, "Agent Runtime vidéo · IA locale légère");
      const preset = AI_MODEL_PRESETS["mobile-x2"];
      await loadAiModel({
        kind: "url",
        url: preset.url,
        label: preset.label,
      });
      neuralReady = Boolean(loadedModel());
      decisions.push(
        d(
          "Agent Runtime Vidéo",
          neuralReady ? "ok" : "warning",
          neuralReady
            ? "Modèle local x2 qualifié automatiquement pour Neural Video SR."
            : "Modèle local indisponible : Temporal Pro prendra le relais.",
        ),
      );
    } catch (reason) {
      neuralReady = false;
      decisions.push(
        d(
          "Agent Runtime Vidéo",
          "warning",
          "Neural Video SR non disponible : " +
            (reason instanceof Error ? reason.message : "raison inconnue") +
            ". Repli Temporal Pro automatique.",
        ),
      );
    }
  }

  onProgress?.(0.18, "AutoPilot vidéo · création du master");
  const result = await enhanceVideo(
    file,
    plan.target,
    plan.profile,
    {
      intent: plan.intent,
      neuralAi: neuralRequested && neuralReady,
      onProgress: (value, label) =>
        onProgress?.(0.18 + value * 0.76, label),
    },
  );

  onProgress?.(0.96, "Agent Validation vidéo · relecture");
  const validation = await validateVideoMaster(result.blob);
  if (!validation.valid) {
    throw new Error(
      "Le pipeline vidéo a produit un fichier non validable : " +
        validation.message,
    );
  }

  decisions.push(
    d(
      "Agent Validation Vidéo",
      "ok",
      `Master validé : ${validation.width}×${validation.height} · ${(validation.bytes / 1024 / 1024).toFixed(2)} Mo.`,
    ),
  );
  onProgress?.(1, "Master vidéo final validé");

  return {
    result,
    plan,
    validation,
    decisions,
    neuralRequested,
    neuralReady,
  };
}
