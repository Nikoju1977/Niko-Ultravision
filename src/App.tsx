import { useEffect, useMemo, useRef, useState } from "react";
import DeepFocusControl, { type DeepFocusSettings } from "./DeepFocusControl";
import ComparisonPanel from "./ComparisonPanel";
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
import { orchestrateMediaAgents, type AgentDecision } from "./lib/mediaAgents";
import {
  AI_MAX_SOURCE_PIXELS,
  AI_WARN_SOURCE_PIXELS,
  DEFAULT_MODEL_LABEL,
  DEFAULT_MODEL_URL,
  aiEngineAvailable,
  loadAiModel,
  loadedModel,
  webGpuAvailable,
  type AiModelInfo,
} from "./lib/aiUpscaler";
import { PROFILES, type ProfileId } from "./lib/profiles";
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

async function stabilizeAndroidImage(
  file: File,
  source: CanvasImageSource,
  width: number,
  height: number,
): Promise<File> {
  if (!/android/i.test(navigator.userAgent)) return file;

  // Les très grands capteurs peuvent dépasser la mémoire disponible pendant
  // une normalisation PNG. Dans ce cas, le décodeur multi-stratégies garde
  // le fichier original et prendra le relais.
  if (width * height > 40_000_000) return file;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  try {
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(source, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/png");
    });
    if (!blob || blob.size === 0) return file;

    // Le nom d'origine est conservé pour que le nom du master exporté reste
    // celui choisi par l'utilisateur ; seul le contenu interne devient un PNG
    // local stable, décodable autant de fois que nécessaire.
    return new File([blob], file.name, {
      type: "image/png",
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}

async function inspectImage(file: File): Promise<{ size: Size; file: File }> {
  const decoded = await decodeImageFile(file);
  try {
    const stableFile = await stabilizeAndroidImage(file, decoded.source, decoded.width, decoded.height);
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
  const [modelUrl, setModelUrl] = useState(DEFAULT_MODEL_URL);
  const [model, setModel] = useState<AiModelInfo | null>(loadedModel());
  const [modelBusy, setModelBusy] = useState(false);
  const [modelStatus, setModelStatus] = useState<string | null>(null);
  const [intent, setIntent] = useState<CodecIntent>("master");
  const [codecs, setCodecs] = useState<string[] | null>(null);
  const [agentDecisions, setAgentDecisions] = useState<AgentDecision[]>([]);
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
  const aiTooLarge = sourcePixels > AI_MAX_SOURCE_PIXELS;
  const aiSlow = sourcePixels > AI_WARN_SOURCE_PIXELS && !aiTooLarge;

  useEffect(() => {
    if (mode === "video" || aiTooLarge) setEngine("canvas");
  }, [mode, aiTooLarge]);

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

  useEffect(() => {
    return () => {
      if (output?.url) URL.revokeObjectURL(output.url);
    };
  }, [output]);

  async function handleFile(next: File | null) {
    if (!next) return;
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

  async function acquireModel(source: Parameters<typeof loadAiModel>[0]) {
    setModelBusy(true);
    setError(null);
    setModelStatus("Préparation du moteur IA");
    try {
      const loaded = await loadAiModel(source, (_ratio, label) => setModelStatus(label));
      setModel(loaded);
      setEngine("ai");
      setModelStatus(
        `${loaded.source} · x${loaded.scale} · ${loaded.provider.toUpperCase()} · ${(loaded.bytes / 1024 / 1024).toFixed(1)} Mo`,
      );
    } catch (reason) {
      setModel(null);
      setEngine("canvas");
      setModelStatus(null);
      setError(reason instanceof Error ? reason.message : "Chargement du modèle impossible.");
    } finally {
      setModelBusy(false);
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
    setBusy(true);
    setError(null);
    setProgress(0);
    setOutput((previous) => {
      if (previous?.url) URL.revokeObjectURL(previous.url);
      return null;
    });

    try {
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
        aiModelLoaded: Boolean(model),
        webGpu: webGpuAvailable(),
      });

      setAgentDecisions(plan.decisions);
      if (plan.target !== target) setTarget(plan.target);
      if (plan.profile !== profile) setProfile(plan.profile);
      if (plan.engine !== engine) setEngine(plan.engine);
      if (plan.intent !== intent) setIntent(plan.intent);

      const agentNotes = plan.decisions.map((entry) => `${entry.label} : ${entry.message}`);

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
            (result.engineUsed === "ai"
              ? `Super-résolution IA x${result.aiScale} (${result.aiProvider?.toUpperCase()}) puis normalisation géométrique vers la cible.`
              : result.sharpenApplied
                ? "Agrandissement progressif + accentuation locale légère."
                : "Agrandissement progressif haute qualité ; accentuation globale désactivée pour éviter les halos."),
          notes: [
            ...agentNotes,
            ...(result.deepFocusReason ? [`Deep Focus : ${result.deepFocusReason}`] : []),
            ...(result.precisionRestoreReason ? [`Precision Restore : ${result.precisionRestoreReason}`] : []),
            ...(result.depthFocusReason ? [`Depth Focus Precision : ${result.depthFocusReason}`] : []),
          ],
        });
      } else {
        const result = await enhanceVideo(file, plan.target, plan.profile, {
          intent: plan.intent,
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
              ? "Pipeline WebCodecs : aucune image perdue, horodatage exact. "
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
      setError(reason instanceof Error ? reason.message : "Le traitement a échoué.");
      setStatus("Erreur");
    } finally {
      setBusy(false);
    }
  }

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
          <div className="eyebrow">NIKO STUDIO · LOCAL MASTERING</div>
          <h1>Niko UltraVision Pro</h1>
          <p className="subtitle">Amélioration locale d’images et de vidéos. Aucun fichier n’est envoyé vers un service externe.</p>
        </div>
        <div className="privacy-badge"><span /> 100 % local</div>
      </header>

      <section className="hero-grid">
        <article className="panel source-panel">
          <div className="panel-title-row">
            <div>
              <span className="kicker">01 · SOURCE</span>
              <h2>Importer un master</h2>
            </div>
            <span className="lock">Fidelity Lock</span>
          </div>

          <label className="dropzone">
            <input
              type="file"
              accept="image/*,video/*"
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
                <strong>Choisir une image ou une vidéo</strong>
                <span>Traitement effectué sur cet appareil</span>
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
          <span className="kicker">02 · MASTERING</span>
          <h2>Paramètres</h2>

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
                  className={engine === "canvas" ? "choice active" : "choice"}
                  onClick={() => setEngine("canvas")}
                  disabled={busy}
                >
                  <strong>Canvas</strong>
                  <span>Rééchantillonnage haute qualité. Rapide, hors ligne, aucun détail inventé.</span>
                </button>
                <button
                  type="button"
                  className={engine === "ai" ? "choice active" : "choice"}
                  onClick={() => setEngine("ai")}
                  disabled={busy || !model || aiTooLarge}
                  title={
                    !model
                      ? "Charge d'abord un modèle ONNX."
                      : aiTooLarge
                        ? "Source trop grande pour l'inférence locale."
                        : undefined
                  }
                >
                  <strong>IA locale{model ? ` · x${model.scale}` : ""}</strong>
                  <span>
                    {model
                      ? `Réseau de neurones exécuté sur l'appareil (${model.provider.toUpperCase()}).`
                      : "Super-résolution par réseau de neurones. Modèle requis."}
                  </span>
                </button>
              </div>

              {!aiEngineAvailable() && (
                <div className="warning-card">WebAssembly indisponible : le moteur IA ne peut pas démarrer sur ce navigateur.</div>
              )}

              <div className="model-box">
                <div className="model-head">
                  <strong>Modèle open source</strong>
                  <span className={webGpuAvailable() ? "badge ok" : "badge"}>
                    {webGpuAvailable() ? "WebGPU disponible" : "WASM (CPU)"}
                  </span>
                </div>

                <p className="model-note">
                  Par défaut : {DEFAULT_MODEL_LABEL}. Les poids sont téléchargés une fois depuis l'URL ci-dessous, puis
                  mis en cache par le navigateur. Tes images, elles, ne sortent jamais de l'appareil.
                </p>

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

                {modelStatus && <div className="model-status">{modelStatus}</div>}
                {aiTooLarge && (
                  <div className="warning-card">
                    Source de {(sourcePixels / 1_000_000).toFixed(1)} MP : au-delà de{" "}
                    {(AI_MAX_SOURCE_PIXELS / 1_000_000).toFixed(0)} MP l'inférence par tuiles n'est plus tenable dans un
                    navigateur. Moteur Canvas imposé.
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
            </div>
          )}

          <div className="agent-box">
            <div className="agent-head">
              <div>
                <strong>AutoPilot agents Image + Vidéo</strong>
                <span>7 agents locaux supervisent qualité, upscale, mémoire, format et codecs.</span>
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
              <p className="model-note">Les agents analyseront automatiquement le média au lancement du master.</p>
            )}
          </div>

          <div className="fidelity-card">
            <strong>Géométrie verrouillée</strong>
            <span>Pas de crop automatique. Pas d’étirement. Le ratio source est recalculé mathématiquement à chaque cible.</span>
          </div>

          {imageAssessment && !imageAssessment.supported && (
            <div className="warning-card">{imageAssessment.reason}</div>
          )}

          {imageAssessment?.supported && predicted && megapixels(predicted) > 70 && (
            <div className="warning-card">
              Cette cible représente {megapixels(predicted).toFixed(1)} MP. Le traitement est autorisé, mais restera exigeant pour la mémoire locale.
            </div>
          )}

          <button className="run-button" type="button" onClick={() => void runEnhancement()} disabled={!file || busy}>
            {busy ? "Traitement en cours…" : "Créer le master local"}
          </button>

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
            <span className="kicker">03 · RESULTAT</span>
            <h2>Master exportable</h2>
          </div>
          {output && <button className="secondary-button" type="button" onClick={downloadOutput}>Télécharger</button>}
        </div>

        {output ? (
          <div className="result-grid">
            <div className="preview-frame">
              {mode === "image" ? <img src={output.url} alt="Résultat UltraVision" /> : <video src={output.url} controls playsInline />}
            </div>
            <div className="result-copy">
              <div className="success-mark">✓</div>
              <h3>Master terminé</h3>
              <p>{output.note}</p>
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
                {output.codecLabel && (
                  <div><dt>Codec</dt><dd>{output.codecLabel}</dd></div>
                )}
                {output.frameRate && (
                  <div><dt>Cadence</dt><dd>{Math.round(output.frameRate)} i/s{output.frameRateDetected ? " détectée" : " compatibilité"}</dd></div>
                )}
              </dl>
            </div>
          </div>
        ) : (
          <div className="empty-result">
            <strong>Aucun master créé</strong>
            <span>Importe un fichier, choisis une cible puis lance le traitement.</span>
          </div>
        )}
      </section>

      {mode === "image" && file && output && (
        <ComparisonPanel source={file} output={output.blob} />
      )}

      <section className="truth-panel">
        <h2>Ce que fait réellement cette version</h2>
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
          reconstruction 3D. <strong>Scene Precision Auto</strong> choisit un preset à partir d'heuristiques locales
          (texte probable, contours, aplats et concentration centrale) sans prétendre reconnaître sémantiquement les
          objets. Le <strong>Quality Lab</strong> compare
          ensuite source et master à résolution commune : micro-détail, contours,
          contraste, SSIM par blocs, PSNR et carte de différence permettent de vérifier si le traitement a réellement
          modifié le signal. Seuls les poids du modèle transitent par le réseau,
          jamais tes médias. La vidéo passe par <strong>WebCodecs</strong> quand le navigateur l’expose : démultiplexage du fichier source,
          réencodage AV1/HEVC/VP9/H.264 selon ce que la machine sait réellement faire, horodatage exact et aucune image
          perdue. Le mode <em>Mezzanine intra</em> force toutes les images en clé, ce qui donne le comportement de
          montage d’un ProRes avec les codecs réellement encodables dans un navigateur. La copie directe remultiplexe
          sans réencoder, donc sans perte de génération. Sans WebCodecs, repli MediaRecorder temps réel, signalé comme
          tel. Le 32K a été retiré : aucun navigateur actuel n’alloue un
          canvas de cette surface. Le 16K n’est proposé que si la dimension maximale mesurée sur cet appareil le permet.
        </p>
      </section>

      <footer>UltraVision Pro · moteurs locaux Canvas + ONNX Runtime Web · aucune dépendance Higgsfield</footer>
    </main>
  );
}
