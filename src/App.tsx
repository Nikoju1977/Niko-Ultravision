import { useEffect, useMemo, useRef, useState } from "react";
import DeepFocusControl, { type DeepFocusSettings } from "./DeepFocusControl";
import ComparisonPanel from "./ComparisonPanel";
import ProExportPanel from "./ProExportPanel";
import type { QualityComparison } from "./lib/qualityComparator";
import PrecisionRestoreControl, { type PrecisionRestoreSettings } from "./PrecisionRestoreControl";
import ScenePrecisionControl from "./ScenePrecisionControl";
import DepthFocusControl, { type DepthFocusSettings } from "./DepthFocusControl";
import { DEFAULT_DEPTH_FOCUS } from "./lib/depth/depthTypes";
import { analyzeScene, type SceneAnalysis } from "./lib/sceneAnalyzer";
import {
  DEFAULT_SCENE_MODE,
  SCENE_PRESETS,
  getScenePreset,
  type SceneModeId,
  type ScenePresetId,
} from "./lib/scenePresets";
import { calculateOutputSize, formatDimensions, megapixels, type Size, type TargetId } from "./lib/geometry";
import { assessImageTarget, enhanceImage, type EngineId, type ImageFormat } from "./lib/imageEnhancer";
import { decodeImageFile } from "./lib/imageDecode";
import { decodeAuraVision, encodeAuraVision } from "./lib/auraVisionCodec";
import { orchestrateMediaAgents, type AgentDecision } from "./lib/mediaAgents";
import { inspectAiRuntime, type AiRuntimeReport } from "./lib/aiRuntime";
import {
  AI_MAX_SOURCE_PIXELS,
  AI_MODEL_PRESETS,
  AI_WARN_SOURCE_PIXELS,
  DEFAULT_MODEL_LABEL,
  DEFAULT_MODEL_URL,
  chooseAiPresetForTarget,
  aiEngineAvailable,
  loadAiModel,
  loadedModel,
  webGpuAvailable,
  type AiModelInfo,
} from "./lib/aiUpscaler";
import { PROFILES, type ProfileId } from "./lib/profiles";
import { beginJob, isCancelled, isCancelledError, requestCancel, throwIfCancelled } from "./lib/cancellation";
import type { StudioReport } from "./lib/restoration/autoStudio";
import { runAgenticImageMaster } from "./lib/agenticMaster";
import { runAgenticVideoMaster } from "./lib/agenticVideoMaster";
import {
  qualifyAllRestorationModels,
  type ModelHealthReport,
} from "./lib/restoration/modelHealth";
import { enhanceVideo } from "./lib/videoEnhancer";
import {
  CODEC_INTENTS,
  codecInventory,
  webCodecsAvailable,
  type CodecIntent,
} from "./lib/videoCodec";

type MediaMode = "image" | "video";

type OutputState = {
  url: string;
  blob: Blob;
  size: Size;
  note: string;
  frameRate?: number;
  frameRateDetected?: boolean;
  engineUsed?: EngineId;
  aiPasses?: number;
  deepFocusApplied?: boolean;
  deepFocusLayers?: number;
  deepFocusConfidence?: number;
  precisionRestoreApplied?: boolean;
  precisionTextCoverage?: number;
  precisionEdgeCoverage?: number;
  precisionFlatCoverage?: number;
  depthFocusApplied?: boolean;
  depthFocusPlanes?: number;
  depthFocusConfidence?: number;
  depthFocusCoverage?: number;
  depthFocusNearCoverage?: number;
  depthFocusMidCoverage?: number;
  depthFocusFarCoverage?: number;
  depthFocusMeanCorrection?: number;
  scenePreset?: ScenePresetId;
  codecLabel?: string;
  notes?: string[];
  roiApplied?: boolean;
  roiConfidence?: number;
  studio?: StudioReport;
  /** Archive AV-1X de la source, produite automatiquement après le master image. */
  avx?: { state: "pending" | "ready" | "failed"; blob?: Blob; detail: string };
  /** Comparaison master ↔ original calculée avant la livraison. */
  comparison?: QualityComparison;
} | null;

const IMAGE_TARGETS: Array<{ id: TargetId; label: string; hint: string }> = [
  { id: "original", label: "Original", hint: "même définition" },
  { id: "2k", label: "2K", hint: "2 048 px côté long" },
  { id: "4k", label: "4K", hint: "3 840 px côté long" },
  { id: "8k", label: "8K", hint: "7 680 px côté long" },
  { id: "16k", label: "16K", hint: "15 360 px · desktop mémoire élevée" },
];

const VIDEO_TARGETS: Array<{ id: TargetId; label: string; hint: string }> = [
  { id: "original", label: "Original", hint: "même définition" },
  { id: "1080p", label: "1080p", hint: "1 920 px côté long" },
  { id: "2k", label: "2K", hint: "2 048 px côté long" },
  { id: "4k", label: "4K", hint: "3 840 px côté long" },
  { id: "8k", label: "8K", hint: "activée seulement après test encode + mux + lecture" },
];

function extensionFor(type: string): string {
  if (type.includes("png")) return "png";
  if (type.includes("jpeg")) return "jpg";
  if (type.includes("webp")) return "webp";
  if (type.includes("mp4")) return "mp4";
  return "webm";
}

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "avif", "gif", "bmp"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);

function fileExtension(file: File): string {
  const match = file.name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] ?? "";
}

function looksLikeImage(file: File): boolean {
  return file.type.startsWith("image/") || IMAGE_EXTENSIONS.has(fileExtension(file));
}

function looksLikeVideo(file: File): boolean {
  return file.type.startsWith("video/") || VIDEO_EXTENSIONS.has(fileExtension(file));
}

/**
 * Android : certains sélecteurs Samsung fournissent un File lisible une seule
 * fois. On en matérialise les OCTETS D'ORIGINE dans un Blob local, sans jamais
 * redessiner ni réencoder les pixels (le réencodage via canvas GPU corrompait
 * certaines photos : bandes verticales, dominante verte/magenta).
 */
async function stabilizeAndroidImage(file: File): Promise<File> {
  if (!/android/i.test(navigator.userAgent)) return file;
  try {
    const buffer = await file.arrayBuffer();
    if (buffer.byteLength === 0) return file;
    return new File([buffer], file.name, {
      type: file.type || "application/octet-stream",
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  }
}

async function inspectImage(file: File): Promise<{ size: Size; file: File }> {
  const decoded = await decodeImageFile(file);
  try {
    const stableFile = await stabilizeAndroidImage(file);
    return {
      size: { width: decoded.width, height: decoded.height },
      file: stableFile,
    };
  } finally {
    decoded.close();
  }
}

async function inspectMedia(file: File): Promise<{ mode: MediaMode; size: Size; file: File }> {
  if (looksLikeImage(file)) {
    const inspected = await inspectImage(file);
    return { mode: "image", size: inspected.size, file: inspected.file };
  }

  if (looksLikeVideo(file)) {
    const url = URL.createObjectURL(file);
    try {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.src = url;
      await new Promise<void>((resolve, reject) => {
        video.addEventListener("loadedmetadata", () => resolve(), { once: true });
        video.addEventListener("error", () => reject(new Error("Vidéo illisible.")), { once: true });
      });
      return {
        mode: "video",
        size: { width: video.videoWidth, height: video.videoHeight },
        file,
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const detail = file.type ? `Type détecté : ${file.type}` : "Type MIME non fourni par Android";
  throw new Error(`Format non pris en charge. ${detail}. Utilise JPG, PNG, WebP, AVIF, MP4 ou WebM.`);
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [sourceSize, setSourceSize] = useState<Size | null>(null);
  const [mode, setMode] = useState<MediaMode>("image");
  const [profile, setProfile] = useState<ProfileId>("fidelity");
  const [target, setTarget] = useState<TargetId>("4k");
  const [format, setFormat] = useState<ImageFormat>("image/png");
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [output, setOutput] = useState<OutputState>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Prêt");
  const [error, setError] = useState<string | null>(null);
  const [engine, setEngine] = useState<EngineId>("canvas");
  /** IA automatique : charge le modèle adapté quand l'agrandissement le justifie. */
  const [autoAi, setAutoAi] = useState(true);
  const [modelUrl, setModelUrl] = useState(DEFAULT_MODEL_URL);
  const [model, setModel] = useState<AiModelInfo | null>(loadedModel());
  const [modelBusy, setModelBusy] = useState(false);
  const [modelStatus, setModelStatus] = useState<string | null>(null);
  const [engineHealthBusy, setEngineHealthBusy] = useState(false);
  const [engineHealth, setEngineHealth] = useState<ModelHealthReport[]>([]);
  const [aiRuntime, setAiRuntime] = useState<AiRuntimeReport | null>(null);
  const [smallSubjectMode, setSmallSubjectMode] = useState(false);
  const [videoNeuralAi, setVideoNeuralAi] = useState(false);
  const [auraBusy, setAuraBusy] = useState(false);
  const [auraStatus, setAuraStatus] = useState<string | null>(null);
  const [auraUpscale, setAuraUpscale] = useState<1 | 2>(1);
  const [auraUseAi, setAuraUseAi] = useState(false);
  const [intent, setIntent] = useState<CodecIntent>("master");
  const [codecs, setCodecs] = useState<string[] | null>(null);
  const [agentDecisions, setAgentDecisions] = useState<AgentDecision[]>([]);
  const [mistralEnabled, setMistralEnabled] = useState(false);
  const [mistralApiKey, setMistralApiKey] = useState("");
  const [mistralModel, setMistralModel] = useState("mistral-small-latest");
  const [deepFocus, setDeepFocus] = useState<DeepFocusSettings>({ enabled: true, layers: 10, strength: 0.58 });
  const [precisionRestore, setPrecisionRestore] = useState<PrecisionRestoreSettings>({
    enabled: true,
    strength: 0.52,
    textBias: 0.72,
    edgeBias: 0.65,
    flatProtection: 0.78,
    centralBias: 0.30,
    noiseGate: 0.22,
  });
  const [depthFocusPrecision, setDepthFocusPrecision] = useState<DepthFocusSettings>({ ...DEFAULT_DEPTH_FOCUS });
  const [sceneMode, setSceneMode] = useState<SceneModeId>(DEFAULT_SCENE_MODE);
  const [sceneAnalysis, setSceneAnalysis] = useState<SceneAnalysis | null>(null);
  const [sceneAnalyzing, setSceneAnalyzing] = useState(false);
  const inspectionId = useRef(0);

  const targets = mode === "image" ? IMAGE_TARGETS : VIDEO_TARGETS;
  const predicted = useMemo(() => {
    if (!sourceSize) return null;
    return calculateOutputSize(sourceSize.width, sourceSize.height, target);
  }, [sourceSize, target]);

  const imageAssessment = useMemo(() => {
    if (mode !== "image" || !sourceSize) return null;
    return assessImageTarget(sourceSize, target);
  }, [mode, sourceSize, target]);

  const sourcePixels = sourceSize ? sourceSize.width * sourceSize.height : 0;
  const aiNeedsPreparation = sourcePixels > AI_MAX_SOURCE_PIXELS;
  const aiSlow = sourcePixels > AI_WARN_SOURCE_PIXELS;
  const mistralCloudActive =
    mode === "video" && mistralEnabled && Boolean(mistralApiKey.trim());

  useEffect(() => {
    if (mode === "video") setEngine("canvas");
  }, [mode]);

  useEffect(() => {
    let alive = true;
    void inspectAiRuntime()
      .then((report) => {
        if (alive) setAiRuntime(report);
      })
      .catch(() => {
        if (alive) {
          setAiRuntime({
            available: false,
            backend: "none",
            webgpu: false,
            wasm: false,
            deviceMemoryGb: null,
            hardwareConcurrency: navigator.hardwareConcurrency || 1,
            recommendedTile: 128,
            reason: "Diagnostic du runtime IA impossible.",
          });
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (mode !== "video" || !predicted || !webCodecsAvailable()) {
      setCodecs(null);
      return;
    }
    let alive = true;
    void codecInventory(predicted.width, predicted.height, 30)
      .then((list) => {
        if (alive) setCodecs(list.map((entry) => `✓ ${entry.label} → ${entry.container.toUpperCase()} · testé`));
      })
      .catch(() => {
        if (alive) setCodecs([]);
      });
    return () => {
      alive = false;
    };
  }, [mode, predicted]);

  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    setSourceUrl(null);

    if (!file) {
      return () => {
        alive = false;
      };
    }

    if (mode === "video") {
      objectUrl = URL.createObjectURL(file);
      setSourceUrl(objectUrl);
      return () => {
        alive = false;
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      };
    }

    void (async () => {
      try {
        const decoded = await decodeImageFile(file);
        try {
          const maxSide = 1280;
          const scale = Math.min(1, maxSide / Math.max(decoded.width, decoded.height));
          const width = Math.max(1, Math.round(decoded.width * scale));
          const height = Math.max(1, Math.round(decoded.height * scale));
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("Canvas 2D indisponible.");
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(decoded.source, 0, 0, width, height);

          const preview = canvas.toDataURL("image/jpeg", 0.9);
          if (!preview.startsWith("data:image/")) {
            throw new Error("Aperçu impossible.");
          }

          if (!alive) return;
          setSourceUrl(preview);
        } finally {
          decoded.close();
        }
      } catch {
        if (!alive) return;
        objectUrl = URL.createObjectURL(file);
        setSourceUrl(objectUrl);
      }
    })();

    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file, mode]);

  useEffect(() => {
    if (mode !== "image" || !file) {
      setSceneAnalysis(null);
      setSceneAnalyzing(false);
      return;
    }

    let alive = true;
    setSceneAnalyzing(true);
    void analyzeScene(file)
      .then((analysis) => {
        if (alive) setSceneAnalysis(analysis);
      })
      .catch(() => {
        if (alive) setSceneAnalysis(null);
      })
      .finally(() => {
        if (alive) setSceneAnalyzing(false);
      });

    return () => {
      alive = false;
    };
  }, [file, mode]);

  useEffect(() => {
    if (mode !== "image" || sceneMode !== "auto" || !sceneAnalysis) return;
    const preset = getScenePreset(sceneAnalysis.recommendedPreset);
    setDeepFocus({ ...preset.deepFocus });
    setPrecisionRestore({ ...preset.precisionRestore });
    setDepthFocusPrecision({ ...preset.depthFocusPrecision });
  }, [mode, sceneMode, sceneAnalysis]);

  // Révoquer l'URL du master uniquement quand elle change réellement : une
  // mise à jour du résultat (archive AV-1X, scores…) garde la même URL.
  const outputUrl = output?.url;
  useEffect(() => {
    return () => {
      if (outputUrl) URL.revokeObjectURL(outputUrl);
    };
  }, [outputUrl]);

  async function handleFile(next: File | null) {
    if (!next) return;
    if (/\.avx$/i.test(next.name) || next.type === "application/x-aura-vision") {
      // Décodage AV-1X automatique, IA locale incluse si l'automatisme est actif.
      await runAuraDecode(next, autoAi);
      return;
    }
    const requestId = ++inspectionId.current;
    setError(null);
    setStatus("Analyse de la source");
    setProgress(0);
    setAgentDecisions([]);
    setFile(null);
    setSourceSize(null);
    setOutput((previous) => {
      if (previous?.url) URL.revokeObjectURL(previous.url);
      return null;
    });
    try {
      const inspected = await inspectMedia(next);
      if (requestId !== inspectionId.current) return;
      setFile(inspected.file);
      setMode(inspected.mode);
      setSourceSize(inspected.size);
      setTarget(inspected.mode === "video" ? "1080p" : "4k");
      setStatus("Source analysée localement");
    } catch (reason) {
      if (requestId !== inspectionId.current) return;
      setStatus("Source invalide");
      setError(reason instanceof Error ? reason.message : "Impossible de lire ce fichier.");
    }
  }

  async function acquireModel(
    source: Parameters<typeof loadAiModel>[0],
    activateImageEngine = true,
  ): Promise<AiModelInfo | null> {
    setModelBusy(true);
    setError(null);
    setModelStatus("Préparation du moteur IA");
    try {
      const runtime = aiRuntime ?? await inspectAiRuntime();
      setAiRuntime(runtime);
      if (!runtime.available) {
        throw new Error(runtime.reason);
      }
      setModelStatus(
        "Runtime " + runtime.backend.toUpperCase() +
          " prêt · tuile conseillée " + runtime.recommendedTile + " px",
      );
      const loaded = await loadAiModel(source, (_ratio, label) => setModelStatus(label));
      setModel(loaded);
      if (activateImageEngine) setEngine("ai");
      setModelStatus(
        `${loaded.source} · x${loaded.scale} · ${loaded.provider.toUpperCase()} · ` +
          `${loaded.execution === "worker" ? `worker${loaded.threads > 1 ? ` ${loaded.threads} threads` : ""}` : "thread principal"} · ` +
          `${loaded.inputLayout}→${loaded.outputLayout} · stress ${Math.round(loaded.stressTestMs)} ms · ` +
          `~${loaded.estimatedTilesPerSecond.toFixed(1)} tuiles/s · ` +
          `${(loaded.bytes / 1024 / 1024).toFixed(1)} Mo${loaded.fromCache ? " · cache local" : ""}`,
      );
      return loaded;
    } catch (reason) {
      setModel(null);
      if (activateImageEngine) setEngine("canvas");
      setModelStatus(null);
      setError(reason instanceof Error ? reason.message : "Chargement du modèle impossible.");
      return null;
    } finally {
      setModelBusy(false);
    }
  }

  async function runAllEngineQualification() {
    if (busy || auraBusy || modelBusy || engineHealthBusy) return;
    beginJob();
    setEngineHealthBusy(true);
    setError(null);
    setEngineHealth([]);
    setProgress(0);
    setStatus("Qualification des moteurs IA");
    try {
      const summary = await qualifyAllRestorationModels(
        (ratio, label, partial) => {
          setProgress(ratio);
          setStatus(label);
          setModelStatus(label);
          setEngineHealth([...partial]);
        },
      );
      setEngineHealth(summary.reports);
      const active = loadedModel();
      if (active) setModel(active);
      setProgress(1);
      if (summary.failed === 0) {
        setStatus(`Tous les moteurs IA sont qualifiés · ${summary.passed}/${summary.reports.length}`);
        setModelStatus(
          `Qualification complète : ${summary.passed}/${summary.reports.length} moteurs ont exécuté une vraie tuile RGBA sur cet appareil.`,
        );
      } else {
        setStatus(
          `Qualification IA : ${summary.passed} OK · ${summary.failed} échec(s)`,
        );
        setModelStatus(
          `Qualification incomplète : ${summary.failed} moteur(s) ne passent pas l'inférence réelle sur cet appareil.`,
        );
      }
    } catch (reason) {
      if (isCancelledError(reason)) {
        setStatus("Qualification des moteurs annulée");
      } else {
        setError(
          reason instanceof Error
            ? reason.message
            : "Qualification des moteurs impossible.",
        );
        setStatus("Erreur qualification IA");
      }
    } finally {
      setEngineHealthBusy(false);
    }
  }

  async function selectLocalAi() {
    if (busy || modelBusy) return;

    if (model) {
      setError(null);
      setEngine("ai");
      setModelStatus(
        `${model.source} · x${model.scale} · ${model.provider.toUpperCase()} · prêt`,
      );
      return;
    }

    const preferred =
      sourceSize && predicted
        ? chooseAiPresetForTarget(
            sourceSize.width,
            sourceSize.height,
            predicted.width,
            predicted.height,
          )
        : AI_MODEL_PRESETS["mobile-x2"];

    const customUrl = modelUrl.trim();
    const useCustomUrl = customUrl && customUrl !== DEFAULT_MODEL_URL;
    const primaryUrl = useCustomUrl ? customUrl : preferred.url;
    const primaryLabel = useCustomUrl ? "Modèle ONNX personnalisé" : preferred.label;

    setModelUrl(primaryUrl);
    setStatus(
      preferred.id === "pro-real-x4"
        ? "IA locale · Pro Max x4"
        : "IA locale · Mobile x2",
    );

    const loaded = await acquireModel({
      kind: "url",
      url: primaryUrl,
      label: primaryLabel,
    });

    if (!loaded && !useCustomUrl && preferred.id === "pro-real-x4") {
      const fallback = AI_MODEL_PRESETS["mobile-x2"];
      setError(null);
      setModelUrl(fallback.url);
      setStatus("Pro Max x4 indisponible · repli Mobile x2");
      await acquireModel({
        kind: "url",
        url: fallback.url,
        label: fallback.label,
      });
    }
  }

  async function toggleVideoNeuralAi() {
    if (busy || modelBusy) return;

    if (videoNeuralAi) {
      setVideoNeuralAi(false);
      setStatus("Neural Video SR désactivé");
      return;
    }

    if (model) {
      setError(null);
      setVideoNeuralAi(true);
      setStatus(
        `Neural Video SR · x${model.scale} · ${model.provider.toUpperCase()}`,
      );
      return;
    }

    const preferred =
      sourceSize && predicted
        ? chooseAiPresetForTarget(
            sourceSize.width,
            sourceSize.height,
            predicted.width,
            predicted.height,
          )
        : AI_MODEL_PRESETS["mobile-x2"];

    setStatus(
      preferred.id === "pro-real-x4"
        ? "Neural Video SR · chargement Pro x4"
        : "Neural Video SR · chargement Mobile x2",
    );
    setModelUrl(preferred.url);

    let loaded = await acquireModel(
      {
        kind: "url",
        url: preferred.url,
        label: preferred.label,
      },
      false,
    );

    if (!loaded && preferred.id === "pro-real-x4") {
      const fallback = AI_MODEL_PRESETS["mobile-x2"];
      setError(null);
      setModelUrl(fallback.url);
      setStatus("Neural x4 indisponible · repli x2");
      loaded = await acquireModel(
        {
          kind: "url",
          url: fallback.url,
          label: fallback.label,
        },
        false,
      );
    }

    setVideoNeuralAi(Boolean(loaded));
    if (loaded) {
      setError(null);
      setStatus(
        `Neural Video SR prêt · x${loaded.scale} · ${loaded.provider.toUpperCase()}`,
      );
    }
  }

  async function toggleAuraLocalAi() {
    if (busy || auraBusy || modelBusy) return;

    if (auraUseAi) {
      setAuraUseAi(false);
      setAuraStatus("AV-1X · traitement déterministe Lanczos3");
      return;
    }

    if (model) {
      setAuraUseAi(true);
      setError(null);
      setAuraStatus(
        `AV-1X · IA locale prête · ${model.provider.toUpperCase()} x${model.scale}`,
      );
      return;
    }

    const preferred = AI_MODEL_PRESETS["mobile-x2"];
    setAuraStatus("AV-1X · chargement IA locale");
    setModelUrl(preferred.url);
    const loaded = await acquireModel(
      {
        kind: "url",
        url: preferred.url,
        label: preferred.label,
      },
      false,
    );

    setAuraUseAi(Boolean(loaded));
    if (loaded) {
      setError(null);
      setAuraStatus(
        `AV-1X · IA locale prête · ${loaded.provider.toUpperCase()} x${loaded.scale}`,
      );
    }
  }

  function applySceneMode(next: SceneModeId) {
    setSceneMode(next);
    if (next === "auto") {
      if (!sceneAnalysis) return;
      const preset = getScenePreset(sceneAnalysis.recommendedPreset);
      setDeepFocus({ ...preset.deepFocus });
      setPrecisionRestore({ ...preset.precisionRestore });
      setDepthFocusPrecision({ ...preset.depthFocusPrecision });
      return;
    }

    const preset = getScenePreset(next);
    setDeepFocus({ ...preset.deepFocus });
    setPrecisionRestore({ ...preset.precisionRestore });
    setDepthFocusPrecision({ ...preset.depthFocusPrecision });
  }

  async function runEnhancement() {
    if (!file || !sourceSize) return;
    beginJob();
    setBusy(true);
    setError(null);
    setProgress(0);
    setOutput((previous) => {
      if (previous?.url) URL.revokeObjectURL(previous.url);
      return null;
    });

    try {
      let activeModel = model;
      const autoNotes: string[] = [];
      if (autoAi && !activeModel && aiEngineAvailable() && mode === "image" && predicted) {
        const sourcePixels = sourceSize.width * sourceSize.height;
        const requestedScale = Math.max(
          predicted.width / Math.max(1, sourceSize.width),
          predicted.height / Math.max(1, sourceSize.height),
        );
        if (requestedScale >= 1.35 && sourcePixels <= AI_MAX_SOURCE_PIXELS) {
          const preset = chooseAiPresetForTarget(
            sourceSize.width,
            sourceSize.height,
            predicted.width,
            predicted.height,
          );
          setStatus(`IA automatique · ${preset.label}`);
          activeModel = await acquireModel({ kind: "url", url: preset.url, label: preset.label }, false);
          if (!activeModel && preset.id === "pro-real-x4") {
            const fallback = AI_MODEL_PRESETS["mobile-x2"];
            setStatus("IA automatique · repli Mobile x2");
            activeModel = await acquireModel({ kind: "url", url: fallback.url, label: fallback.label }, false);
          }
          if (activeModel) {
            autoNotes.push(`IA automatique : ${activeModel.source} chargé (x${activeModel.scale}, ${activeModel.provider.toUpperCase()}).`);
          } else {
            setError(null);
            autoNotes.push("IA automatique indisponible sur cet appareil : rééchantillonnage haute qualité utilisé.");
          }
          throwIfCancelled();
        }
      }
      const aiAllowed = Boolean(activeModel) && (autoAi || engine === "ai");

      setStatus("Agents AutoPilot · analyse");
      const plan = await orchestrateMediaAgents({
        file,
        mode,
        sourceSize,
        target,
        profile,
        engine,
        format,
        intent,
        aiModelLoaded: aiAllowed,
        webGpu: activeModel ? activeModel.provider === "webgpu" : webGpuAvailable(),
        mistralEnabled,
        mistralApiKey,
        mistralModel,
      });

      setAgentDecisions(plan.decisions);
      if (plan.target !== target) setTarget(plan.target);
      if (plan.profile !== profile) setProfile(plan.profile);
      if (plan.engine !== engine) setEngine(plan.engine);
      if (plan.intent !== intent) setIntent(plan.intent);

      const agentNotes = [
        ...autoNotes,
        ...plan.decisions.map((entry) => `${entry.label} : ${entry.message}`),
      ];

      if (mode === "image") {
        const resolvedScenePreset: ScenePresetId =
          sceneMode === "auto"
            ? sceneAnalysis?.recommendedPreset ?? "balanced"
            : sceneMode;
        const result = await enhanceImage(file, plan.target, plan.profile, plan.format, {
          engine: plan.engine,
          deepFocus,
          precisionRestore,
          depthFocusPrecision,
          smallSubjectRoi: {
            enabled: smallSubjectMode,
            strength: plan.profile === "detail" ? 0.92 : 0.82,
          },
          onProgress: (value, label) => {
            setProgress(value);
            setStatus(label);
          },
        });
        const url = URL.createObjectURL(result.blob);
        setOutput({
          url,
          blob: result.blob,
          size: result.size,
          engineUsed: result.engineUsed,
          aiPasses: result.aiPasses,
          deepFocusApplied: result.deepFocusApplied,
          deepFocusLayers: result.deepFocusLayers,
          deepFocusConfidence: result.deepFocusConfidence,
          precisionRestoreApplied: result.precisionRestoreApplied,
          precisionTextCoverage: result.precisionTextCoverage,
          precisionEdgeCoverage: result.precisionEdgeCoverage,
          precisionFlatCoverage: result.precisionFlatCoverage,
          depthFocusApplied: result.depthFocusApplied,
          depthFocusPlanes: result.depthFocusPlanes,
          depthFocusConfidence: result.depthFocusConfidence,
          depthFocusCoverage: result.depthFocusCoverage,
          depthFocusNearCoverage: result.depthFocusNearCoverage,
          depthFocusMidCoverage: result.depthFocusMidCoverage,
          depthFocusFarCoverage: result.depthFocusFarCoverage,
          depthFocusMeanCorrection: result.depthFocusMeanCorrection,
          scenePreset: resolvedScenePreset,
          roiApplied: result.roiApplied,
          roiConfidence: result.roiConfidence,
          note:
            `Scene Precision ${SCENE_PRESETS[resolvedScenePreset].label}${sceneMode === "auto" ? " (Auto)" : ""}. ` +
            (result.deepFocusApplied
              ? `Deep Focus ${result.deepFocusLayers}+ appliqué sur ${result.deepFocusLayers} plans de focalisation. `
              : "") +
            (result.precisionRestoreApplied
              ? "Precision Restore a renforcé sélectivement texte et contours en protégeant les aplats. "
              : "") +
            (result.depthFocusApplied
              ? `Depth Focus Precision a réparti la restauration sur ${result.depthFocusPlanes} plans Z avec ${Math.round(result.depthFocusConfidence * 100)} % de confiance moyenne. `
              : "") +
            (result.aiPasses > 0
              ? `Reconstruction IA ${result.aiPasses} passe(s) · facteur modèle x${result.aiScale ?? "?"}. `
              : "") +
            (result.roiApplied
              ? `Petit sujet ROI renforcé localement (confiance ${Math.round(result.roiConfidence * 100)} %). `
              : "") +
            (result.perceptualCoreApplied
              ? `Perceptual Imaging Core appliqué sur ${Math.round(result.perceptualCoreCoverage * 100)} % des pixels utiles. `
              : "") +
            (result.engineUsed === "ai"
              ? `Super-résolution IA x${result.aiScale} (${result.aiProvider?.toUpperCase()}) puis normalisation géométrique vers la cible.`
              : result.sharpenApplied
                ? "Agrandissement progressif + accentuation locale légère."
                : "Agrandissement progressif haute qualité ; accentuation globale désactivée pour éviter les halos."),
          notes: [
            ...agentNotes,
            `Validation netteté finale : ${(result.sharpnessBefore * 100).toFixed(2)} % → ${(result.sharpnessAfter * 100).toFixed(2)} % (${result.sharpnessGain >= 0 ? "+" : ""}${(result.sharpnessGain * 100).toFixed(1)} %).`,
            ...(result.aiPreparedInput
              ? [
                  `Préparation IA grande source : ${result.aiPreparedSourceMegapixels.toFixed(1)} MP → ${result.aiPreparedWorkingMegapixels.toFixed(1)} MP avant inférence tuilée.`,
                ]
              : []),
            ...(result.roiApplied
              ? [`ROI petit sujet : zone automatique renforcée · confiance ${Math.round(result.roiConfidence * 100)} %.`]
              : smallSubjectMode
                ? ["ROI petit sujet : aucune zone suffisamment fiable détectée."]
                : []),
            ...(result.deepFocusReason ? [`Deep Focus : ${result.deepFocusReason}`] : []),
            ...(result.precisionRestoreReason ? [`Precision Restore : ${result.precisionRestoreReason}`] : []),
            ...(result.depthFocusReason ? [`Depth Focus Precision : ${result.depthFocusReason}`] : []),
            ...(result.perceptualCoreApplied
              ? [
                  `Perceptual Imaging Core : couverture ${Math.round(result.perceptualCoreCoverage * 100)} % · correction moyenne ${result.perceptualCoreMeanCorrection.toFixed(2)} niveaux · contribution détail ${result.perceptualCoreDetailContribution.toFixed(2)} · débruitage ${result.perceptualCoreDenoiseContribution.toFixed(2)}.`,
                ]
              : result.perceptualCoreReason
                ? [`Perceptual Imaging Core : ${result.perceptualCoreReason}`]
                : []),
          ],
        });
      } else {
        const result = await enhanceVideo(file, plan.target, plan.profile, {
          intent: plan.intent,
          neuralAi: videoNeuralAi && Boolean(activeModel),
          onProgress: (value, label) => {
            setProgress(value);
            setStatus(label);
          },
        });
        const url = URL.createObjectURL(result.blob);
        setOutput({
          url,
          blob: result.blob,
          size: result.size,
          codecLabel: result.streamCopied
            ? "Copie directe (aucun réencodage)"
            : result.plan
              ? `${result.plan.codec.toUpperCase()} · ${result.plan.container.toUpperCase()} · ${result.plan.keyFrameInterval === 0 ? "tout intra" : `clé/${result.plan.keyFrameInterval}s`}`
              : "MediaRecorder",
          notes: [...agentNotes, ...result.notes],
          note:
            (result.pipeline === "webcodecs"
              ? "Pipeline WebCodecs hors temps réel avec cadence et timestamps gérés par le conteneur. "
              : "Pipeline MediaRecorder temps réel. ") +
            (result.audioPreserved ? "Piste audio conservée. " : "Sans piste audio. ") +
            (result.frameRateDetected
              ? `Cadence source ${Math.round(result.frameRate)} i/s.`
              : `Cadence de compatibilité ${Math.round(result.frameRate)} i/s.`),
          frameRate: result.frameRate,
          frameRateDetected: result.frameRateDetected,
        });
      }
      setProgress(1);
      setStatus("Master prêt");
    } catch (reason) {
      if (isCancelledError(reason)) {
        setStatus("Traitement annulé");
        setProgress(0);
      } else {
        setError(reason instanceof Error ? reason.message : "Le traitement a échoué.");
        setStatus("Erreur");
      }
    } finally {
      setBusy(false);
    }
  }

  function downloadNamedBlob(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function runStudio() {
    if (!file || !sourceSize || mode !== "image" || busy || auraBusy) return;
    beginJob();
    setBusy(true);
    setError(null);
    setProgress(0);
    setAgentDecisions([]);
    setOutput((previous) => {
      if (previous?.url) URL.revokeObjectURL(previous.url);
      return null;
    });

    try {
      const master = await runAgenticImageMaster({
        file,
        sourceSize,
        target,
        profile,
        format,
        intent,
        deepFocus,
        precisionRestore,
        depthFocusPrecision,
        onProgress: (value, label) => {
          setProgress(value);
          setStatus(label);
        },
      });

      setAgentDecisions(master.decisions);
      if (master.plan.target !== target) setTarget(master.plan.target);
      if (master.plan.profile !== profile) setProfile(master.plan.profile);
      if (master.plan.format !== format) setFormat(master.plan.format);
      if (master.plan.engine !== engine) setEngine(master.plan.engine);
      setSceneMode("auto");
      setSceneAnalysis(master.autopilot.scene);
      setDeepFocus({ ...master.autopilot.scenePreset.deepFocus });
      setPrecisionRestore({ ...master.autopilot.scenePreset.precisionRestore });
      setDepthFocusPrecision({
        ...master.autopilot.scenePreset.depthFocusPrecision,
      });
      const active = loadedModel();
      if (active) setModel(active);

      const result = master.result;
      const report = master.studio;

      // Archive AV-1X produite AVANT la livraison : quand le master s'affiche,
      // tout est terminé.
      let avx: NonNullable<NonNullable<OutputState>["avx"]>;
      if (sourceSize.width * sourceSize.height > 12_000_000) {
        avx = { state: "failed", detail: "Archive AV-1X non créée : source au-delà de 12 MP." };
      } else {
        try {
          setStatus("Archive AV-1X · encodage");
          setProgress(0.995);
          const encoded = await encodeAuraVision(file);
          const ratio = encoded.blob.size > 0 ? file.size / encoded.blob.size : 0;
          avx = {
            state: "ready",
            blob: encoded.blob,
            detail: `${(encoded.blob.size / 1024).toFixed(0)} Ko${ratio > 1 ? ` · ${ratio.toFixed(1)}× plus léger que l'original` : ""}`,
          };
        } catch (reason) {
          avx = {
            state: "failed",
            detail: reason instanceof Error ? `Archive AV-1X non créée : ${reason.message}` : "Archive AV-1X non créée.",
          };
        }
      }
      throwIfCancelled();
      const url = URL.createObjectURL(result.blob);
      const notes: string[] = [
        ...master.autopilot.rationale.map(
          (entry) => `AutoPilot v3 : ${entry}`,
        ),
        ...master.decisions.map(
          (entry) => `${entry.label} : ${entry.message}`,
        ),
        ...(master.duel
          ? [
              `Duel final : ${master.duel.rationale}`,
              `Duel SSIM : IA ${master.duel.primary.ssimToSource.toFixed(4)} · classique ${master.duel.classic.ssimToSource.toFixed(4)} · marge ${master.duel.margin.toFixed(2)}.`,
            ]
          : []),
        ...(master.evidenceFusion
          ? [
              master.evidenceFusion.applied
                ? `Evidence Fusion : ${master.evidenceFusion.qualityGate === "accepted" ? "conservée" : master.evidenceFusion.qualityGate === "reverted" ? "annulée par le duel qualité" : "calculée"} · cycle ${Math.round(master.evidenceFusion.cycleConfidence * 100)} % · poids IA détail ${Math.round(master.evidenceFusion.meanAiDetailWeight * 100)} % · détails IA atténués ${master.evidenceFusion.rejectedDetailPercent.toFixed(1)} % · ${Math.round(master.evidenceFusion.elapsedMs)} ms · pic mémoire estimé ${master.evidenceFusion.estimatedPeakWorkingMb.toFixed(0)} Mo · bandes ${master.evidenceFusion.bandRows}px${master.evidenceFusion.qualityDelta !== null ? ` · Δ qualité ${master.evidenceFusion.qualityDelta >= 0 ? "+" : ""}${master.evidenceFusion.qualityDelta.toFixed(2)}` : ""}.`
                : `Evidence Fusion : ${master.evidenceFusion.skippedReason ?? "non appliquée"} · pic mémoire estimé ${master.evidenceFusion.estimatedPeakWorkingMb.toFixed(0)} Mo${master.evidenceFusion.performanceAbort ? " · watchdog performance déclenché" : ""}.`,
            ]
          : []),
        `Validation finale : ${master.validation.message}`,
        `Master : ${master.validation.width}×${master.validation.height} · ${(master.validation.bytes / 1024 / 1024).toFixed(2)} Mo.`,
      ];

      if (report) {
        const d = report.diagnosis;
        notes.push(
          `Diagnostic : bruit σ ${d.noise.toFixed(1)} · netteté ${d.sharpness.toFixed(0)} · blocs JPEG ${d.blockiness.toFixed(2)} · contraste ${d.contrast} · couleur ${d.colorfulness.toFixed(1)} (variation ${d.colorVariation.toFixed(1)}).`,
          ...d.reasons.map((reason) => `Analyse : ${reason}.`),
          `Evidence Gate : ${report.probeCount} zones témoins · confiance source moyenne ${Math.round(report.meanSourceConfidence * 100)} % · ${report.resourceProfile}.`,
          ...(report.meanAiDisagreement !== null
            ? [`Consensus IA : désaccord moyen ${(report.meanAiDisagreement * 100).toFixed(1)} % entre modèles valides.`]
            : []),
          ...report.regionalEvidence.map((entry) => `Région : ${entry}.`),
          ...report.finalAttempts.map(
            (attempt) =>
              `Master final · ${attempt.label} : ${attempt.status === "ok" ? "OK" : "échec" + (attempt.error ? " · " + attempt.error : "")}.`,
          ),
        );
      }

      notes.push(
        `Validation netteté finale : ${(result.sharpnessBefore * 100).toFixed(2)} % → ${(result.sharpnessAfter * 100).toFixed(2)} %.`,
      );
      if (result.perceptualCoreApplied) {
        notes.push(
          `Perceptual Imaging Core : couverture ${Math.round(result.perceptualCoreCoverage * 100)} % · correction moyenne ${result.perceptualCoreMeanCorrection.toFixed(2)} niveaux · détail ${result.perceptualCoreDetailContribution.toFixed(2)} · débruitage ${result.perceptualCoreDenoiseContribution.toFixed(2)}.`,
        );
      } else if (result.perceptualCoreReason) {
        notes.push(`Perceptual Imaging Core : ${result.perceptualCoreReason}`);
      }

      setOutput({
        url,
        blob: result.blob,
        size: result.size,
        engineUsed: result.engineUsed,
        aiPasses: result.aiPasses,
        studio: report ?? undefined,
        comparison: master.comparison,
        avx,
        note: report
          ? `Master Auto Agentique · ${report.plan.label} → ${report.winnerLabel}. ${report.decision}`
          : `Master Auto Agentique · repli déterministe sécurisé. ${master.validation.message}`,
        notes,
      });

      setProgress(1);
      setStatus(
        master.usedEmergencyFallback
          ? "Master final validé · repli sécurisé"
          : "Master final validé · agents autonomes",
      );

    } catch (reason) {
      if (isCancelledError(reason)) {
        setStatus("Traitement annulé");
        setProgress(0);
      } else {
        setError(
          reason instanceof Error
            ? reason.message
            : "Le master agentique a échoué.",
        );
        setStatus("Erreur");
      }
    } finally {
      setBusy(false);
    }
  }

  async function runVideoAuto() {
    if (!file || !sourceSize || mode !== "video" || busy || auraBusy) return;
    beginJob();
    setBusy(true);
    setError(null);
    setProgress(0);
    setAgentDecisions([]);
    setOutput((previous) => {
      if (previous?.url) URL.revokeObjectURL(previous.url);
      return null;
    });

    try {
      const master = await runAgenticVideoMaster({
        file,
        sourceSize,
        mistralEnabled,
        mistralApiKey,
        mistralModel,
        onProgress: (value, label) => {
          setProgress(value);
          setStatus(label);
        },
      });

      setAgentDecisions(master.decisions);
      if (master.plan.target !== target) setTarget(master.plan.target);
      if (master.plan.profile !== profile) setProfile(master.plan.profile);
      setIntent(master.plan.intent);
      setVideoNeuralAi(master.neuralRequested && master.neuralReady);
      const active = loadedModel();
      if (active) setModel(active);

      const result = master.result;
      const url = URL.createObjectURL(result.blob);
      setOutput({
        url,
        blob: result.blob,
        size: result.size,
        codecLabel: result.streamCopied
          ? "Copie directe (aucun réencodage)"
          : result.plan
            ? `${result.plan.codec.toUpperCase()} · ${result.plan.container.toUpperCase()} · ${result.plan.keyFrameInterval === 0 ? "tout intra" : `clé/${result.plan.keyFrameInterval}s`}`
            : "MediaRecorder",
        notes: [
          ...master.decisions.map(
            (entry) => `${entry.label} : ${entry.message}`,
          ),
          ...result.notes,
          `Validation finale : ${master.validation.message}`,
        ],
        note:
          `Master Auto Agentique vidéo · ${master.plan.target} · ${master.plan.profile}. ` +
          (master.neuralRequested && master.neuralReady
            ? "Neural Video SR autorisé avec replis automatiques."
            : "Temporal/codec automatique avec replis de sécurité."),
        frameRate: result.frameRate,
        frameRateDetected: result.frameRateDetected,
      });
      setProgress(1);
      setStatus("Master vidéo final validé · AutoPilot v3");
    } catch (reason) {
      if (isCancelledError(reason)) {
        setStatus("Traitement annulé");
        setProgress(0);
      } else {
        setError(
          reason instanceof Error
            ? reason.message
            : "Le master vidéo automatique a échoué.",
        );
        setStatus("Erreur");
      }
    } finally {
      setBusy(false);
    }
  }

  function downloadArchive() {
    if (!output?.avx?.blob || !file) return;
    const base = file.name.replace(/\.[^.]+$/, "") || "ultravision";
    downloadNamedBlob(output.avx.blob, `${base}.avx`);
  }

  async function runAuraEncode() {
    if (!file || mode !== "image" || auraBusy || busy) return;
    beginJob();
    setAuraBusy(true);
    setError(null);
    setAuraStatus("Aura-Vision · préparation");
    try {
      const result = await encodeAuraVision(file, (value, label) => {
        setProgress(value);
        setStatus(label);
        setAuraStatus(label);
      });
      const base = file.name.replace(/\.[^.]+$/, "") || "image";
      downloadNamedBlob(result.blob, `${base}.avx`);
      setAuraStatus(
        `AV-1X v${result.manifest.header.version} prêt · ${result.width}×${result.height} · base ${result.baseWidth}×${result.baseHeight} · ` +
          `taille ${(result.blob.size / 1024).toFixed(0)} Ko · flux/RGBA ${(result.ratioVsRgba * 100).toFixed(1)} % · ` +
          `SHA-256 ${result.manifest.dimensional_control.cryptographic_validation.reference_hash_sha256.slice(0, 12)}… · ` +
          result.semanticSummary,
      );
      setProgress(1);
      setStatus("Aura-Vision AV-1X encodé");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Encodage Aura-Vision impossible.";
      setError(message);
      setAuraStatus(message);
      setStatus("Erreur Aura-Vision");
    } finally {
      setAuraBusy(false);
    }
  }

  async function runAuraEncodeAndProcess() {
    if (!file || mode !== "image" || auraBusy || busy) return;

    let encoded: Awaited<ReturnType<typeof encodeAuraVision>> | null = null;
    beginJob();
    setAuraBusy(true);
    setError(null);
    setAuraStatus("AV-1X · encodage puis IA locale");
    try {
      encoded = await encodeAuraVision(file, (value, label) => {
        setProgress(value * 0.42);
        setStatus(label);
        setAuraStatus(label);
      });
      const base = file.name.replace(/\.[^.]+$/, "") || "image";
      downloadNamedBlob(encoded.blob, `${base}.avx`);
      setAuraStatus("AV-1X encodé · démarrage IA locale");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Encodage Aura-Vision impossible.";
      setError(message);
      setAuraStatus(message);
      setStatus("Erreur Aura-Vision");
      encoded = null;
    } finally {
      setAuraBusy(false);
    }

    if (!encoded || isCancelled()) {
      if (isCancelled()) setStatus("Traitement annulé");
      return;
    }
    const base = file.name.replace(/\.[^.]+$/, "") || "image";
    const avxFile = new File([encoded.blob], `${base}.avx`, {
      type: "application/x-aura-vision",
      lastModified: Date.now(),
    });
    await runAuraDecode(avxFile, true, false);
  }

  async function runAuraDecode(picked: File | null, forceAi = false, freshJob = true) {
    if (!picked || auraBusy || busy) return;
    if (freshJob) beginJob();
    setAuraBusy(true);
    setError(null);
    setAuraStatus("Aura-Vision · lecture AV-1X");
    try {
      const requestedAi = forceAi || auraUseAi;
      if (forceAi) setAuraUseAi(true);
      let localModel = model;
      if (requestedAi && !localModel) {
        const preferred = AI_MODEL_PRESETS["mobile-x2"];
        setAuraStatus("AV-1X · préparation IA locale");
        localModel = await acquireModel(
          {
            kind: "url",
            url: preferred.url,
            label: preferred.label,
          },
          false,
        );
      }

      const result = await decodeAuraVision(picked, {
        upscaleFactor: auraUpscale,
        useAi: requestedAi && Boolean(localModel),
        structuralThreshold: 0.95,
        onProgress: (value, label) => {
          setProgress(value);
          setStatus(label);
          setAuraStatus(label);
        },
      });
      const activeModelAfterDecode = loadedModel();
      if (activeModelAfterDecode) setModel(activeModelAfterDecode);
      const url = URL.createObjectURL(result.blob);
      setOutput((previous) => {
        if (previous?.url) URL.revokeObjectURL(previous.url);
        return {
          url,
          blob: result.blob,
          size: { width: result.width, height: result.height },
          engineUsed: result.usedAi ? "ai" : "canvas",
          note:
            `Aura-Vision AV-1X décodé en ${result.width}×${result.height}. ` +
            (result.usedAi
              ? `Reconstruction neuronale validée par garde-fou structurel${result.structuralSsim !== null ? ` (SSIM ${result.structuralSsim.toFixed(4)})` : ""}.`
              : "Reconstruction déterministe structure/texture."),
          notes: [
            `Carte sémantique : ${result.semanticSummary}.`,
            ...(result.manifest
              ? [
                  `AV-1X ${result.manifest.header.version} · ${result.manifest.header.encoding_metadata.authoring_tool} · ${result.manifest.header.encoding_metadata.compression_level}.`,
                  `Intégrité SHA-256 : ${result.manifest.dimensional_control.cryptographic_validation.reference_hash_sha256}.`,
                  `Colorimétrie demandée : Rec.2020 / 10-bit / HLG ; payload actuel : ${result.manifest.geometry_and_display.colorimetry.stored_payload.space} / ${result.manifest.geometry_and_display.colorimetry.stored_payload.bit_depth}-bit / ${result.manifest.geometry_and_display.colorimetry.stored_payload.hdr_profile}.`,
                ]
              : []),
            ...(result.integrityVerified === true
              ? ["Intégrité du payload vérifiée par recalcul SHA-256."]
              : []),
            ...(result.qualityReport
              ? [
                  `Quality Gate AMDEC : ${result.qualityReport.decision === "accept" ? "VALIDÉ" : result.qualityReport.decision === "blend" ? "FUSION RÉDUITE" : "REJETÉ"} · SSIM ${result.qualityReport.ssim.toFixed(4)} · PSNR ${result.qualityReport.psnrDb.toFixed(2)} dB · intensité IA ${Math.round(result.qualityReport.blendStrength * 100)} %.`,
                  `Métrologie locale : peau ${result.qualityReport.skinEdgeDisplacementPx === null ? "n/a" : result.qualityReport.skinEdgeDisplacementPx.toFixed(2) + " px"} · architecture ${result.qualityReport.architectureEdgeDisplacementPx === null ? "n/a" : result.qualityReport.architectureEdgeDisplacementPx.toFixed(2) + " px"} · rectitude ${result.qualityReport.architectureStraightnessIndex === null ? "n/a" : result.qualityReport.architectureStraightnessIndex.toFixed(4)}.`,
                  `Mémoire estimée : ${result.qualityReport.estimatedMemoryMb.toFixed(0)} Mo / limite 512 Mo.`,
                  ...result.qualityReport.warnings.map((warning) => `AMDEC avertissement : ${warning}.`),
                ]
              : result.structuralSsim !== null
                ? [`Contrôle anti-hallucination SSIM : ${result.structuralSsim.toFixed(4)} · seuil 0.9500.`]
                : []),
            ...(result.inferenceTimeMs !== null
              ? [`Inférence locale : ${Math.round(result.inferenceTimeMs)} ms · calcul ${result.actualComputeUnit}${result.modelDowngraded ? " · modèle rétrogradé automatiquement" : ""}.`]
              : []),
            ...(result.usedAi
              ? [`Contribution IA estimée après fusion sémantique : ${result.aiGenerationRatioPercent.toFixed(1)} %.`]
              : []),
            ...(result.fallbackFilter
              ? [`Filtre de repli : ${result.fallbackFilter}.`]
              : []),
            ...(result.manifest?.provenance_and_security?.c2pa_manifest
              ? [
                  `Provenance : assertion ${result.manifest.provenance_and_security.c2pa_manifest.assertion_type} non signée ; ce n'est pas un manifeste C2PA valide cryptographiquement.`,
                ]
              : []),
            ...(result.fallbackReason ? [result.fallbackReason] : []),
          ],
        };
      });
      setMode("image");
      setAuraStatus(
        result.usedAi
          ? `AV-1X IA locale validée · SSIM ${result.structuralSsim?.toFixed(4) ?? "n/a"} · PSNR ${result.qualityReport?.psnrDb.toFixed(1) ?? "n/a"} dB · ${result.actualComputeUnit}`
          : `AV-1X repli sécurisé · ${result.fallbackReason ?? "IA non utilisée"}`,
      );
      setProgress(1);
      setStatus("Aura-Vision décodé");
    } catch (reason) {
      if (isCancelledError(reason)) {
        setAuraStatus("Décodage annulé");
        setStatus("Traitement annulé");
        setProgress(0);
        return;
      }
      const message = reason instanceof Error ? reason.message : "Décodage Aura-Vision impossible.";
      setError(message);
      setAuraStatus(message);
      setStatus("Erreur Aura-Vision");
    } finally {
      setAuraBusy(false);
    }
  }

  // Dépôt n'importe où dans la page : image, vidéo ou .avx (décodé automatiquement).
  const handleFileRef = useRef(handleFile);
  handleFileRef.current = handleFile;
  useEffect(() => {
    const onDragOver = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    const onDrop = (event: DragEvent) => {
      const dropped = event.dataTransfer?.files?.[0];
      if (!dropped) return;
      event.preventDefault();
      void handleFileRef.current(dropped);
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  function downloadOutput() {
    if (!output || !file) return;
    const a = document.createElement("a");
    a.href = output.url;
    const base = file.name.replace(/\.[^.]+$/, "") || "ultravision";
    a.download = `${base}-ultravision.${extensionFor(output.blob.type)}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">NIKO ULTRAVISION</div>
          <h1>Un média. Un bouton. Un master.</h1>
          <p className="subtitle">
            {mistralCloudActive
              ? "AutoPilot choisit le traitement ; Mistral Vision reste optionnel pour la vidéo."
              : "Dépose une image ou une vidéo. AutoPilot choisit automatiquement la qualité, les moteurs et les replis sûrs."}
          </p>
        </div>
        <div className="privacy-badge"><span /> {mistralCloudActive ? "Local + Mistral Vision" : "100 % local"}</div>
      </header>

      <section className="hero-grid">
        <article className="panel source-panel">
          <div className="panel-title-row">
            <div>
              <span className="kicker">01 · MÉDIA</span>
              <h2>Choisir le fichier</h2>
            </div>
            <span className="lock">Fidelity Lock</span>
          </div>

          <label className="dropzone">
            <input
              type="file"
              accept="image/*,video/*,.avx,application/x-aura-vision"
              onChange={(event) => {
                const picked = event.currentTarget.files?.[0] ?? null;
                event.currentTarget.value = "";
                void handleFile(picked);
              }}
              disabled={busy}
            />
            {sourceUrl ? (
              mode === "image" ? <img src={sourceUrl} alt="Source" /> : <video src={sourceUrl} controls playsInline />
            ) : (
              <div className="dropzone-empty">
                <div className="upload-glyph">＋</div>
                <strong>Déposer ou choisir un média</strong>
                <span>Image, vidéo ou fichier AVX · traitement local par défaut</span>
              </div>
            )}
          </label>

          <div className="metrics">
            <div><span>Type</span><strong>{file ? mode.toUpperCase() : "—"}</strong></div>
            <div><span>Source</span><strong>{formatDimensions(sourceSize)}</strong></div>
            <div><span>Cible</span><strong>{formatDimensions(predicted)}</strong></div>
            <div><span>Ratio</span><strong>{sourceSize ? (sourceSize.width / sourceSize.height).toFixed(3) : "—"}</strong></div>
          </div>
        </article>

        <aside className="panel controls-panel">
          <span className="kicker">02 · AUTOPILOT</span>
          <h2>Créer le meilleur master</h2>

          <div className="autopilot-card">
            <div className="autopilot-head">
              <div>
                <strong>Tout automatique</strong>
                <span>
                  {file
                    ? `${mode === "image" ? "Image" : "Vidéo"} prête · AutoPilot choisira cible, qualité, moteur et replis.`
                    : "Importe d’abord un média. Aucun réglage n’est nécessaire."}
                </span>
              </div>
              <span className="badge ok">AUTO</span>
            </div>

            <div className="auto-chips">
              <span>Qualité auto</span>
              <span>Mémoire protégée</span>
              <span>Validation finale</span>
              <span>Local par défaut</span>
            </div>

            <button
              className="run-button primary-master"
              type="button"
              onClick={() =>
                mode === "image"
                  ? void runStudio()
                  : void runVideoAuto()
              }
              disabled={!file || busy || auraBusy}
            >
              {busy
                ? `${status} · ${Math.round(progress * 100)} %`
                : mode === "image"
                  ? "Créer le master automatiquement"
                  : "Créer la vidéo automatiquement"}
            </button>

            {file && (
              <p className="auto-caption">
                La géométrie reste verrouillée. Si une IA échoue ou dépasse le budget mémoire,
                UltraVision passe automatiquement au moteur sûr suivant.
              </p>
            )}
          </div>

          <details className="expert-panel">
            <summary>
              <span>Réglages avancés</span>
              <small>Pour reprendre la main manuellement</small>
            </summary>
            <div className="expert-panel-body">

          <div className="control-block">
            <label>Profil</label>
            <div className="profile-grid">
              {(Object.keys(PROFILES) as ProfileId[]).map((id) => (
                <button
                  key={id}
                  type="button"
                  className={profile === id ? "choice active" : "choice"}
                  onClick={() => setProfile(id)}
                  disabled={busy}
                >
                  <strong>{PROFILES[id].label}</strong>
                  <span>{PROFILES[id].description}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="control-block">
            <label>Définition cible</label>
            <div className="target-grid">
              {targets.map((item) => {
                const availability =
                  mode === "image" && sourceSize ? assessImageTarget(sourceSize, item.id) : null;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={target === item.id ? "target active" : "target"}
                    onClick={() => setTarget(item.id)}
                    disabled={busy || availability?.supported === false}
                    title={availability?.reason}
                  >
                    <strong>{item.label}</strong>
                    <span>{availability?.supported === false ? "indisponible sur cet appareil" : item.hint}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {mode === "image" && (
            <div className="control-block">
              <label htmlFor="format">Format d’export</label>
              <select id="format" value={format} onChange={(event) => setFormat(event.target.value as ImageFormat)} disabled={busy}>
                <option value="image/png">PNG · sans perte</option>
                <option value="image/webp">WebP · haute qualité</option>
                <option value="image/jpeg">JPEG · qualité 96 %</option>
              </select>
            </div>
          )}

          {mode === "image" && (
            <div className="control-block">
              <label>Moteur de traitement</label>
              <div className="engine-grid">
                <button
                  type="button"
                  className={engine === "canvas" && !autoAi ? "choice active" : "choice"}
                  onClick={() => {
                    setEngine("canvas");
                    setAutoAi(false);
                  }}
                  disabled={busy}
                >
                  <strong>Canvas</strong>
                  <span>Rééchantillonnage haute qualité. Rapide, hors ligne, aucun détail inventé.</span>
                </button>
                <button
                  type="button"
                  className={engine === "ai" || autoAi ? "choice active" : "choice"}
                  onClick={() => {
                    setAutoAi(true);
                    void selectLocalAi();
                  }}
                  disabled={busy || modelBusy}
                  title={
                    modelBusy
                      ? "Chargement du moteur IA en cours."
                      : model
                        ? "IA locale prête."
                        : aiNeedsPreparation
                          ? "Grande source : UltraVision préparera automatiquement une surface neuronale sûre."
                          : "Touchez pour charger automatiquement le modèle IA local."
                  }
                >
                  <strong>
                    {modelBusy
                      ? "IA locale · chargement…"
                      : `IA locale${model ? ` · x${model.scale}` : ""}`}
                  </strong>
                  <span>
                    {model
                      ? `Réseau de neurones prêt sur l'appareil (${model.provider.toUpperCase()}).`
                      : modelBusy
                        ? modelStatus ?? "Initialisation du modèle ONNX…"
                        : "Touchez ici : UltraVision charge et active automatiquement le modèle local."}
                  </span>
                </button>
              </div>

              <div className="model-note">
                {autoAi
                  ? "Mode automatique : le modèle IA adapté (x2 mobile ou x4 Pro Max) est chargé tout seul quand l'agrandissement le justifie, puis gardé en cache local."
                  : "Mode fidélité stricte : aucune reconstruction neuronale, seulement du rééchantillonnage."}
              </div>

              {!aiEngineAvailable() && (
                <div className="warning-card">WebAssembly indisponible : le moteur IA ne peut pas démarrer sur ce navigateur.</div>
              )}

              <div className="model-box">
                <div className="model-head">
                  <strong>Modèles IA · Auto Pro</strong>
                  <span className={aiRuntime?.available ? "badge ok" : "badge"}>
                    {aiRuntime
                      ? aiRuntime.available
                        ? aiRuntime.backend.toUpperCase() + " prêt"
                        : "IA indisponible"
                      : "Diagnostic…"}
                  </span>
                </div>

                <p className="model-note">
                  Auto Pro choisit le modèle selon le rapport source/cible : Swin2SR Real-World x4 pour les petites
                  sources demandant une forte reconstruction, sinon {DEFAULT_MODEL_LABEL}. Si le x4 échoue sur le
                  téléphone, UltraVision revient automatiquement au x2. Tes images ne quittent jamais l'appareil.
                </p>

                {aiRuntime && (
                  <div className={aiRuntime.available ? "model-status" : "warning-card"}>
                    Runtime : {aiRuntime.backend.toUpperCase()} · {aiRuntime.hardwareConcurrency} cœur(s)
                    {aiRuntime.deviceMemoryGb ? ` · ~${aiRuntime.deviceMemoryGb} Go RAM déclarée` : ""}
                    {aiRuntime.available ? ` · tuiles ${aiRuntime.recommendedTile} px` : ""}. {aiRuntime.reason}
                  </div>
                )}

                <input
                  type="url"
                  value={modelUrl}
                  spellCheck={false}
                  onChange={(event) => setModelUrl(event.target.value)}
                  disabled={busy || modelBusy}
                  aria-label="URL du modèle ONNX"
                />

                <div className="model-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy || modelBusy || !modelUrl.trim() || !aiEngineAvailable()}
                    onClick={() => void acquireModel({ kind: "url", url: modelUrl.trim(), label: DEFAULT_MODEL_LABEL })}
                  >
                    {modelBusy ? "Chargement…" : "Charger depuis l'URL"}
                  </button>

                  <label className="file-button">
                    Fichier .onnx local
                    <input
                      type="file"
                      accept=".onnx,application/octet-stream"
                      disabled={busy || modelBusy || !aiEngineAvailable()}
                      onChange={(event) => {
                        const picked = event.target.files?.[0];
                        if (picked) void acquireModel({ kind: "file", file: picked });
                        event.target.value = "";
                      }}
                    />
                  </label>
                </div>

                <div className="model-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={
                      busy ||
                      auraBusy ||
                      modelBusy ||
                      engineHealthBusy ||
                      !aiEngineAvailable()
                    }
                    onClick={() => void runAllEngineQualification()}
                  >
                    {engineHealthBusy
                      ? "Qualification des moteurs…"
                      : "Vérifier tous les moteurs IA"}
                  </button>
                </div>

                {engineHealth.length > 0 && (
                  <div className="studio-table-wrap">
                    <table className="studio-table">
                      <thead>
                        <tr>
                          <th>Moteur</th>
                          <th>État</th>
                          <th>Backend</th>
                          <th>Échelle</th>
                          <th>Layout</th>
                          <th>Stress</th>
                          <th>Débit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {engineHealth.map((entry) => (
                          <tr key={entry.id}>
                            <td>{entry.label}</td>
                            <td>{entry.status === "ok" ? "✓ OK" : "✗ échec"}</td>
                            <td>
                              {entry.provider
                                ? `${entry.provider.toUpperCase()} · ${entry.execution}`
                                : "—"}
                            </td>
                            <td>{entry.scale ? `x${entry.scale}` : "—"}</td>
                            <td>
                              {entry.inputLayout && entry.outputLayout
                                ? `${entry.inputLayout}→${entry.outputLayout}`
                                : "—"}
                            </td>
                            <td title={entry.error ?? ""}>
                              {entry.stressTestMs !== null
                                ? `${Math.round(entry.stressTestMs)} ms`
                                : entry.error ?? "—"}
                            </td>
                            <td>
                              {entry.estimatedTilesPerSecond !== null
                                ? `${entry.estimatedTilesPerSecond.toFixed(1)} t/s`
                                : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="model-note">
                      Ce test charge chaque modèle du registre et exécute plusieurs vraies inférences RGBA. Il mesure
                      aussi le débit de tuiles. Le premier passage peut télécharger plus de 200 Mo ; les poids validés
                      sont ensuite conservés dans le cache local.
                    </p>
                  </div>
                )}

                {modelStatus && <div className="model-status">{modelStatus}</div>}
                {aiNeedsPreparation && (
                  <div className="warning-card">
                    Source de {(sourcePixels / 1_000_000).toFixed(1)} MP : le Performance Governor adapte automatiquement
                    la surface d'entrée et borne la surface neuronale intermédiaire selon le modèle, la mémoire et la cible.
                    Le master final conserve la définition demandée.
                  </div>
                )}
                {aiSlow && engine === "ai" && (
                  <div className="warning-card">
                    {(sourcePixels / 1_000_000).toFixed(1)} MP en entrée : l'inférence va durer plusieurs minutes,
                    surtout sans WebGPU.
                  </div>
                )}
              </div>
            </div>
          )}

          {mode === "image" && (
            <div className="control-block">
              <label>Aura-Vision · AV-1X expérimental</label>
              <div className="model-box">
                <div className="model-head">
                  <strong>Codec hybride structure + texture</strong>
                  <span className="badge">V0.1</span>
                </div>
                <p className="model-note">
                  AV-1X v1.0 : basse fréquence Haar/DWT, carte sémantique RLE, descripteurs de texture INT8,
                  manifeste structuré, contrôle SSIM et empreinte SHA-256. La cible Rec.2020 / 10-bit / HLG est inscrite
                  dans le manifeste, mais le payload navigateur reste actuellement 8-bit SDR. Le VAE appris, CABAC et
                  l'encapsulation ISOBMFF ne sont pas encore implémentés : le conteneur .avx reste propriétaire et versionné.
                </p>

                <div className="engine-grid">
                  <button
                    type="button"
                    className={!auraUseAi ? "choice active" : "choice"}
                    onClick={() => {
                      setAuraUseAi(false);
                      setAuraStatus("AV-1X · traitement déterministe Lanczos3");
                    }}
                    disabled={busy || auraBusy || modelBusy}
                  >
                    <strong>Déterministe sécurisé</strong>
                    <span>Flux structurel + Lanczos3, sans reconstruction neuronale.</span>
                  </button>
                  <button
                    type="button"
                    className={auraUseAi ? "choice active" : "choice"}
                    onClick={() => void toggleAuraLocalAi()}
                    disabled={busy || auraBusy || modelBusy || !aiEngineAvailable()}
                  >
                    <strong>
                      {modelBusy
                        ? "IA locale · chargement…"
                        : auraUseAi
                          ? "IA locale AV-1X · active"
                          : "Activer IA locale AV-1X"}
                    </strong>
                    <span>
                      {auraUseAi && model
                        ? `ONNX ${model.provider.toUpperCase()} x${model.scale} · Quality Gate AMDEC actif.`
                        : "Charge localement le modèle ONNX puis valide SSIM, PSNR et géométrie avant d'accepter ses pixels."}
                    </span>
                  </button>
                </div>

                <div className="engine-grid">
                  <button
                    type="button"
                    className={auraUpscale === 1 ? "choice active" : "choice"}
                    onClick={() => setAuraUpscale(1)}
                    disabled={busy || auraBusy}
                  >
                    <strong>Décodage fidèle 1×</strong>
                    <span>Reconstruit la définition d’origine avec garde-fou structurel.</span>
                  </button>
                  <button
                    type="button"
                    className={auraUpscale === 2 ? "choice active" : "choice"}
                    onClick={() => setAuraUpscale(2)}
                    disabled={busy || auraBusy}
                  >
                    <strong>Décodage natif 2×</strong>
                    <span>Double la définition au décodage si le budget mémoire local le permet.</span>
                  </button>
                </div>

                <div className="model-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void runAuraEncode()}
                    disabled={!file || busy || auraBusy}
                  >
                    {auraBusy ? "Traitement AV-1X…" : "Encoder la photo en .avx"}
                  </button>

                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void runAuraEncodeAndProcess()}
                    disabled={!file || busy || auraBusy || modelBusy || !aiEngineAvailable()}
                  >
                    {auraBusy || modelBusy ? "AV-1X + IA locale…" : "Encoder + traiter IA locale"}
                  </button>

                  <label className="file-button">
                    Décoder un .avx
                    <input
                      type="file"
                      accept=".avx,application/x-aura-vision"
                      disabled={busy || auraBusy}
                      onChange={(event) => {
                        const picked = event.currentTarget.files?.[0] ?? null;
                        event.currentTarget.value = "";
                        void runAuraDecode(picked);
                      }}
                    />
                  </label>
                </div>

                <div className={auraUseAi && model ? "model-status" : "warning-card"}>
                  {auraUseAi && model
                    ? `IA locale AV-1X : ${model.source} · x${model.scale} · ${model.provider.toUpperCase()} · AMDEC SSIM ≥ 0,95 · PSNR cible 35 dB · mémoire ≤ 512 Mo.`
                    : auraUseAi
                      ? "IA locale demandée : le modèle sera chargé automatiquement au prochain décodage si nécessaire."
                      : "Mode déterministe actif. Active « IA locale AV-1X » pour autoriser la reconstruction neuronale avec repli Lanczos3."}
                </div>
                {auraStatus && <div className="model-status">{auraStatus}</div>}
              </div>
            </div>
          )}

          {mode === "image" && (
            <div className="control-block">
              <label>Petit sujet / détail lointain</label>
              <div className="engine-grid">
                <button
                  type="button"
                  className={!smallSubjectMode ? "choice active" : "choice"}
                  onClick={() => setSmallSubjectMode(false)}
                  disabled={busy}
                >
                  <strong>Standard</strong>
                  <span>Traitement homogène sur toute l’image.</span>
                </button>
                <button
                  type="button"
                  className={smallSubjectMode ? "choice active" : "choice"}
                  onClick={() => {
                    setSmallSubjectMode(true);
                    setProfile("detail");
                  }}
                  disabled={busy}
                >
                  <strong>Petit sujet ROI</strong>
                  <span>Détecte une petite zone structurée et la renforce davantage à la résolution finale.</span>
                </button>
              </div>
              {smallSubjectMode && (
                <div className="model-note">
                  Recommandé pour animal, véhicule, panneau ou sujet lointain occupant une petite partie de l’image.
                  Le renforcement est local et progressif, avec bords fondus.
                </div>
              )}
            </div>
          )}

          {mode === "image" && (
            <div className="control-block">
              <label>Scene Precision</label>
              <ScenePrecisionControl
                value={sceneMode}
                disabled={busy}
                analysis={sceneAnalysis}
                analyzing={sceneAnalyzing}
                onChange={applySceneMode}
              />
            </div>
          )}

          {mode === "image" && (
            <div className="control-block">
              <label>Profondeur de netteté</label>
              <DeepFocusControl
                file={file}
                disabled={busy}
                value={deepFocus}
                onChange={setDeepFocus}
              />
            </div>
          )}

          {mode === "image" && (
            <div className="control-block">
              <label>Restauration de précision</label>
              <PrecisionRestoreControl
                disabled={busy}
                value={precisionRestore}
                onChange={setPrecisionRestore}
              />
            </div>
          )}

          {mode === "image" && (
            <div className="control-block">
              <label>Profondeur adaptative Z</label>
              <DepthFocusControl
                file={file}
                disabled={busy}
                value={depthFocusPrecision}
                onChange={setDepthFocusPrecision}
              />
            </div>
          )}

          {mode === "video" && (
            <div className="control-block">
              <label>Intention d’encodage</label>
              <div className="profile-grid">
                {(Object.keys(CODEC_INTENTS) as CodecIntent[]).map((id) => (
                  <button
                    key={id}
                    type="button"
                    className={intent === id ? "choice active" : "choice"}
                    onClick={() => setIntent(id)}
                    disabled={busy}
                  >
                    <strong>{CODEC_INTENTS[id].label}</strong>
                    <span>{CODEC_INTENTS[id].description}</span>
                  </button>
                ))}
              </div>

              <div className="model-box">
                <div className="model-head">
                  <strong>Codecs réellement validés ici</strong>
                  <span className={webCodecsAvailable() ? "badge ok" : "badge"}>
                    {webCodecsAvailable() ? "WebCodecs" : "MediaRecorder"}
                  </span>
                </div>
                {webCodecsAvailable() ? (
                  codecs === null ? (
                    <p className="model-note">Sonde réelle encode + mux + lecture en cours…</p>
                  ) : codecs.length > 0 ? (
                    <ul className="codec-list">
                      {codecs.map((entry) => (
                        <li key={entry}>{entry}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="model-note">Aucune chaîne vidéo n’a réussi le test complet à cette définition. UltraVision réduira automatiquement la cible.</p>
                  )
                ) : (
                  <p className="model-note">
                    Ce navigateur n’expose pas WebCodecs. Repli MediaRecorder : encodage en temps réel, images
                    potentiellement perdues, qualité non réglable. Chrome ou Edge donnent un résultat nettement
                    supérieur.
                  </p>
                )}
              </div>

              <div className="model-box">
                <div className="model-head">
                  <strong>Neural Video SR v4 · local</strong>
                  <span className={videoNeuralAi && model ? "badge ok" : "badge"}>
                    {videoNeuralAi && model
                      ? `ONNX x${model.scale}`
                      : modelBusy
                        ? "CHARGEMENT"
                        : "OFF"}
                  </span>
                </div>

                <p className="model-note">
                  Mode qualité maximale : chaque frame passe par un guide de super-résolution ONNX local à définition
                  maîtrisée, puis Temporal Pro stabilise le résultat avant l’encodage. Ce mode est nettement plus lent,
                  surtout sur Android, mais les médias ne quittent pas l’appareil.
                </p>

                <button
                  type="button"
                  className={videoNeuralAi ? "choice active" : "choice"}
                  onClick={() => void toggleVideoNeuralAi()}
                  disabled={busy || modelBusy || !aiEngineAvailable()}
                >
                  <strong>
                    {modelBusy
                      ? "Neural Video SR · chargement…"
                      : videoNeuralAi
                        ? "Désactiver Neural Video SR"
                        : "Activer Neural Video SR"}
                  </strong>
                  <span>
                    {videoNeuralAi && model
                      ? `Modèle ${model.provider.toUpperCase()} x${model.scale} prêt · traitement frame par frame.`
                      : "Charge automatiquement le meilleur modèle compatible, avec repli x2 si nécessaire."}
                  </span>
                </button>

                {modelStatus && videoNeuralAi && (
                  <div className="model-status">{modelStatus}</div>
                )}

                {videoNeuralAi && (
                  <div className="warning-card">
                    Neural Video SR privilégie la qualité à la vitesse. Une vidéo longue peut demander beaucoup de temps
                    sur téléphone ; UltraVision revient automatiquement à Temporal Pro si l’inférence échoue.
                  </div>
                )}
              </div>

              <div className="model-box">
                <div className="model-head">
                  <strong>Mistral Vision · optionnel</strong>
                  <span className={mistralEnabled ? "badge ok" : "badge"}>
                    {mistralEnabled ? "ACTIF" : "LOCAL"}
                  </span>
                </div>

                <p className="model-note">
                  UltraVision reste autonome en local. Si ce mode est activé, 4 keyframes JPEG réduites sont envoyées
                  à Mistral pour comprendre la scène et guider le profil vidéo. La vidéo complète n’est jamais envoyée.
                  La clé reste uniquement dans la mémoire de cette page et n’est pas enregistrée dans GitHub.
                </p>

                <button
                  type="button"
                  className={mistralEnabled ? "choice active" : "choice"}
                  onClick={() => setMistralEnabled((value) => !value)}
                  disabled={busy}
                >
                  <strong>{mistralEnabled ? "Désactiver Mistral Vision" : "Activer Mistral Vision"}</strong>
                  <span>Repli local automatique si quota gratuit, réseau ou API indisponible.</span>
                </button>

                {mistralEnabled && (
                  <>
                    <input
                      type="password"
                      value={mistralApiKey}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="Clé API Mistral · non sauvegardée"
                      onChange={(event) => setMistralApiKey(event.target.value)}
                      disabled={busy}
                      aria-label="Clé API Mistral"
                    />

                    <input
                      type="text"
                      value={mistralModel}
                      spellCheck={false}
                      onChange={(event) => setMistralModel(event.target.value)}
                      disabled={busy}
                      aria-label="Modèle Mistral Vision"
                    />

                    {!mistralApiKey.trim() && (
                      <div className="warning-card">
                        Ajoute ta clé API Mistral gratuite pour activer l’agent cloud. Sans clé, tous les autres agents
                        continuent en local.
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

            <button
              className="secondary-button expert-run"
              type="button"
              onClick={() => void runEnhancement()}
              disabled={!file || busy || auraBusy}
            >
              Lancer avec ces réglages
            </button>
            </div>
          </details>

          <details className="audit-details">
            <summary>
              <span>Décisions AutoPilot</span>
              <small>
                {agentDecisions.length > 0
                  ? `${agentDecisions.length} décision(s) enregistrée(s)`
                  : "Visible après le traitement"}
              </small>
            </summary>
            <div className="agent-box compact">
              <div className="agent-head">
                <div>
                  <strong>Journal des agents</strong>
                  <span>Superviseur, qualité, mémoire, moteurs, Recovery et validation.</span>
                </div>
                <span className="badge ok">ACTIF</span>
              </div>

              {agentDecisions.length > 0 ? (
                <div className="agent-list">
                  {agentDecisions.map((entry, index) => (
                    <div className={`agent-row ${entry.status}`} key={`${entry.agent}-${index}`}>
                      <strong>{entry.label}</strong>
                      <span>{entry.message}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="model-note">Les décisions apparaîtront ici une fois le master lancé.</p>
              )}
            </div>
          </details>

          <div className="safety-line">
            <span>✓ Géométrie verrouillée</span>
            <span>✓ Replis automatiques</span>
            <span>✓ Master validé avant export</span>
          </div>

          {imageAssessment && !imageAssessment.supported && (
            <div className="warning-card">{imageAssessment.reason}</div>
          )}

          {imageAssessment?.supported && predicted && megapixels(predicted) > 70 && (
            <div className="warning-card">
              Cette cible représente {megapixels(predicted).toFixed(1)} MP. Le traitement est autorisé, mais restera exigeant pour la mémoire locale.
            </div>
          )}

          {(busy || auraBusy) && (
            <button
              className="secondary-button cancel-button"
              type="button"
              onClick={() => {
                requestCancel();
                setStatus("Annulation en cours…");
              }}
            >
              Annuler le traitement
            </button>
          )}

          <div className="progress-wrap" aria-live="polite">
            <div className="progress-track"><span style={{ width: `${Math.round(progress * 100)}%` }} /></div>
            <div className="progress-label"><span>{status}</span><strong>{Math.round(progress * 100)} %</strong></div>
          </div>

          {error && <div className="error-card">{error}</div>}
        </aside>
      </section>

      <section className="panel result-panel">
        <div className="panel-title-row">
          <div>
            <span className="kicker">03 · MASTER</span>
            <h2>Résultat final</h2>
          </div>
        </div>

        {output ? (
          <div className="result-grid">
            <div className="preview-frame">
              {mode === "image" ? <img src={output.url} alt="Résultat UltraVision" /> : <video src={output.url} controls playsInline />}
            </div>
            <div className="result-copy">
              <div className="success-mark">✓</div>
              <h3>Master prêt</h3>
              <div className="download-bar">
                <button className="run-button download-primary" type="button" onClick={downloadOutput}>
                  Télécharger le master
                </button>
                {output.avx && (
                  <button
                    className="secondary-button download-archive"
                    type="button"
                    onClick={downloadArchive}
                    disabled={output.avx.state !== "ready"}
                    title={output.avx.detail}
                  >
                    {output.avx.state === "ready"
                      ? "Archive AV-1X (.avx)"
                      : output.avx.state === "pending"
                        ? "Archive AV-1X en cours…"
                        : "Archive AV-1X indisponible"}
                  </button>
                )}
                {output.avx && <small className="download-note">{output.avx.detail}</small>}
              </div>
              {mode === "image" && file && (
                <ProExportPanel
                  key={output.url}
                  master={output.blob}
                  baseName={`${file.name.replace(/\.[^.]+$/, "") || "ultravision"}-ultravision`}
                />
              )}
              <p className="result-verdict">
                {output.studio
                  ? output.studio.winner === "classic"
                    ? `Traitement retenu : ${output.studio.winnerLabel}. Aucune IA n'a fait mieux sans risque d'invention de détails.`
                    : `Traitement retenu : ${output.studio.winnerLabel}, validé par le contrôle qualité.`
                  : output.note}
              </p>

              <div className="result-summary">
                <div>
                  <span>Résolution</span>
                  <strong>{formatDimensions(output.size)}</strong>
                </div>
                <div>
                  <span>Taille</span>
                  <strong>{(output.blob.size / 1024 / 1024).toFixed(1)} Mo</strong>
                </div>
                <div>
                  <span>Traitement</span>
                  <strong>{output.engineUsed === "ai" ? "IA locale" : "Local sécurisé"}</strong>
                </div>
              </div>

              <details className="result-details">
                <summary>
                  <span>Détails techniques</span>
                  <small>Scores, moteurs et journal complet</small>
                </summary>
                <div className="result-details-body">
              {output.studio && <p className="result-full-note">{output.note}</p>}
              {output.studio && output.studio.candidates.length > 0 && (
                <div className="studio-table-wrap">
                  <table className="studio-table">
                    <thead>
                      <tr><th>Candidat</th><th>Score</th><th>SSIM</th><th>Zones</th><th>Désaccord</th><th>Détail</th><th>Bruit</th><th>Artefacts</th><th>Halos</th><th>Statut</th></tr>
                    </thead>
                    <tbody>
                      {output.studio.candidates.map((candidate) => (
                        <tr key={candidate.id} className={candidate.id === output.studio?.winner ? "winner" : undefined}>
                          <td>{candidate.id === output.studio?.winner ? "★ " : ""}{candidate.label}</td>
                          <td>{candidate.score ? candidate.score.score.toFixed(1) : "—"}</td>
                          <td>{candidate.score ? candidate.score.ssim.toFixed(3) : "—"}</td>
                          <td>{candidate.zoneWinWeight > 0 ? candidate.zoneWinWeight.toFixed(1) : "—"}</td>
                          <td>{candidate.disagreement !== null ? `${(candidate.disagreement * 100).toFixed(1)} %` : "—"}</td>
                          <td>{candidate.score ? `${candidate.score.detailGain >= 0 ? "+" : ""}${(candidate.score.detailGain * 100).toFixed(0)} %` : "—"}</td>
                          <td>{candidate.score ? `×${candidate.score.noiseRatio.toFixed(2)}` : "—"}</td>
                          <td>{candidate.score ? `${candidate.score.artifactReduction >= 0 ? "−" : "+"}${Math.abs(candidate.score.artifactReduction * 100).toFixed(0)} %` : "—"}</td>
                          <td>{candidate.score ? `${(candidate.score.ringing * 100).toFixed(1)} %` : "—"}</td>
                          <td title={candidate.error ?? candidate.score?.rejectReason ?? ""}>
                            {candidate.status === "ok" ? "valide" : candidate.status === "rejected" ? "rejeté" : "échec"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {output.studio.candidates
                    .filter((candidate) => candidate.status !== "ok")
                    .map((candidate) => (
                      <p key={candidate.id} className="studio-reason">
                        {candidate.label} : {candidate.error ?? candidate.score?.rejectReason}
                      </p>
                    ))}
                </div>
              )}
              {output.notes && output.notes.length > 0 && (
                <ul className="result-notes">
                  {output.notes.map((entry) => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ul>
              )}
              <dl>
                <div><dt>Résolution</dt><dd>{formatDimensions(output.size)}</dd></div>
                <div><dt>Taille</dt><dd>{(output.blob.size / 1024 / 1024).toFixed(1)} Mo</dd></div>
                <div><dt>Traitement</dt><dd>Local navigateur</dd></div>
                {output.engineUsed && (
                  <div><dt>Moteur</dt><dd>{output.engineUsed === "ai" ? "IA locale (ONNX)" : "Canvas"}</dd></div>
                )}
                {output.engineUsed === "ai" && (
                  <div><dt>Reconstruction IA</dt><dd>{output.aiPasses ?? 1} passe(s)</dd></div>
                )}
                {output.scenePreset && (
                  <div>
                    <dt>Scene Precision</dt>
                    <dd>{SCENE_PRESETS[output.scenePreset].label}</dd>
                  </div>
                )}
                {output.deepFocusApplied && (
                  <div>
                    <dt>Deep Focus</dt>
                    <dd>{output.deepFocusLayers} plans · confiance {Math.round((output.deepFocusConfidence ?? 0) * 100)} %</dd>
                  </div>
                )}
                {output.precisionRestoreApplied && (
                  <div>
                    <dt>Precision Restore</dt>
                    <dd>
                      texte {Math.round((output.precisionTextCoverage ?? 0) * 100)} % · contours {Math.round((output.precisionEdgeCoverage ?? 0) * 100)} %
                    </dd>
                  </div>
                )}
                {output.precisionRestoreApplied && (
                  <div>
                    <dt>Aplats protégés</dt>
                    <dd>{Math.round((output.precisionFlatCoverage ?? 0) * 100)} % détectés</dd>
                  </div>
                )}
                {output.depthFocusApplied && (
                  <div>
                    <dt>Depth Focus Precision</dt>
                    <dd>
                      {output.depthFocusPlanes} plans Z · confiance {Math.round((output.depthFocusConfidence ?? 0) * 100)} % · couverture {Math.round((output.depthFocusCoverage ?? 0) * 100)} %
                    </dd>
                  </div>
                )}
                {output.depthFocusApplied && (
                  <div>
                    <dt>Répartition Z</dt>
                    <dd>
                      proche {Math.round((output.depthFocusNearCoverage ?? 0) * 100)} % · moyen {Math.round((output.depthFocusMidCoverage ?? 0) * 100)} % · lointain {Math.round((output.depthFocusFarCoverage ?? 0) * 100)} %
                    </dd>
                  </div>
                )}
                {output.depthFocusApplied && (
                  <div>
                    <dt>Correction moyenne Z</dt>
                    <dd>{(output.depthFocusMeanCorrection ?? 0).toFixed(2)} niveaux / 255</dd>
                  </div>
                )}
                {output.roiApplied && (
                  <div>
                    <dt>Petit sujet ROI</dt>
                    <dd>renforcé · confiance {Math.round((output.roiConfidence ?? 0) * 100)} %</dd>
                  </div>
                )}
                {output.codecLabel && (
                  <div><dt>Codec</dt><dd>{output.codecLabel}</dd></div>
                )}
                {output.frameRate && (
                  <div><dt>Cadence</dt><dd>{Math.round(output.frameRate)} i/s{output.frameRateDetected ? " détectée" : " compatibilité"}</dd></div>
                )}
              </dl>
                </div>
              </details>
            </div>
          </div>
        ) : (
          <div className="empty-result">
            <strong>Le master apparaîtra ici</strong>
            <span>Importe un média puis touche « Créer le master automatiquement ».</span>
          </div>
        )}
      </section>

      {mode === "image" && file && output && (
        <details className="quality-details">
          <summary>
            <span>Comparer avant / après</span>
            <small>Ouvrir le Quality Lab</small>
          </summary>
          <ComparisonPanel source={file} output={output.blob} report={output.comparison} />
        </details>
      )}

      <details className="truth-panel">
        <summary>
          <span>À propos du traitement</span>
          <small>Transparence technique et limites</small>
        </summary>
        <p>
          Deux moteurs, deux comportements distincts. Le moteur <strong>Canvas</strong> rééchantillonne sans jamais fabriquer
          de détail : c’est de l’agrandissement honnête. Le moteur <strong>IA locale</strong> exécute un vrai modèle de
          super-résolution open source au format ONNX, par tuiles, sur cet appareil — il reconstruit bien de la texture,
          avec le risque d’hallucination propre à ce type de réseau. <strong>Deep Focus 10+</strong> ajoute au minimum
          dix bandes de focalisation adaptatives et une restauration locale contrast-limited : cela peut étendre la
          netteté perceptuelle sur plusieurs zones, sans prétendre recréer une profondeur physique disparue.
          <strong> Precision Restore</strong> détecte ensuite les structures fines probables, privilégie le texte et les
          contours d’objets et protège les aplats pour limiter bruit et halos. <strong>Depth Focus Precision</strong>
          estime ensuite une profondeur relative à faible résolution, calcule une carte de confiance et distribue la
          restauration sur 10 à 16 plans Z avec fusion douce. Cette carte n’est pas une distance physique ni une vraie
          reconstruction 3D. <strong>Aura-Vision AV-1X</strong> ajoute un codec image expérimental réellement encodable :
          un flux structurel basse fréquence issu d'un Haar/DWT, une carte sémantique locale et des descripteurs compacts
          de texture. Au décodage, le modèle ONNX chargé peut guider une reconstruction contrôlée par SSIM ; si le seuil
          structurel n'est pas respecté, le décodeur revient automatiquement à la reconstruction déterministe. Le VAE
          appris et le conteneur ISOBMFF restent des étapes futures. <strong>Scene Precision Auto</strong> choisit un preset à partir d'heuristiques locales
          (texte probable, contours, aplats et concentration centrale) sans prétendre reconnaître sémantiquement les
          objets. Le <strong>Quality Lab</strong> compare
          ensuite source et master à résolution commune : micro-détail, contours,
          contraste, SSIM par blocs, PSNR et carte de différence permettent de vérifier si le traitement a réellement
          modifié le signal. Seuls les poids du modèle transitent par le réseau,
          jamais tes médias. La vidéo passe par <strong>WebCodecs</strong> quand le navigateur l’expose : démultiplexage du fichier source,
          réencodage AV1/HEVC/VP9/H.264 selon ce que la machine sait réellement faire, avec cadence et timestamps gérés
          par le conteneur. Neural Video SR peut ajouter une vraie passe ONNX locale frame par frame avant la stabilisation
          temporelle. Le mode <em>Mezzanine intra</em> force toutes les images en clé, ce qui donne le comportement de
          montage d’un ProRes avec les codecs réellement encodables dans un navigateur. La copie directe remultiplexe
          sans réencoder, donc sans perte de génération. Sans WebCodecs, repli MediaRecorder temps réel, signalé comme
          tel. Le 32K a été retiré : aucun navigateur actuel n’alloue un
          canvas de cette surface. Le 16K n’est proposé que si la dimension maximale mesurée sur cet appareil le permet.
        </p>
      </details>

      <footer>UltraVision Pro · AutoPilot local · Canvas + ONNX Runtime Web</footer>
    </main>
  );
}
