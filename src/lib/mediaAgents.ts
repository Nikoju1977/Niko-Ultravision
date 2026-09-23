
import { decodeImageFile } from "./imageDecode";
import { assessImageTarget, type EngineId, type ImageFormat } from "./imageEnhancer";
import { calculateOutputSize, megapixels, type Size, type TargetId } from "./geometry";
import { analyzeVideoWithMistral, type MistralVisionResult } from "./mistralVision";
import type { ProfileId } from "./profiles";
import { codecInventory, webCodecsAvailable, type CodecIntent } from "./videoCodec";
import {
  aggregateVisionFrames,
  analyzeVisionCanvas,
  type FrameMetrics,
  type VideoVisionMetrics,
} from "./visionMetrics";

export type AgentKind =
  | "supervisor"
  | "vision"
  | "semantic"
  | "quality"
  | "focus"
  | "upscale"
  | "codec"
  | "memory"
  | "validation";

export type AgentStatus = "ok" | "adjusted" | "warning";

export interface AgentDecision {
  agent: AgentKind;
  label: string;
  status: AgentStatus;
  message: string;
}

export interface VisualMetrics {
  meanLuma: number;
  contrast: number;
  edgeEnergy: number;
  clippedBlack: number;
  clippedWhite: number;
}

export interface AgentContext {
  file: File;
  mode: "image" | "video";
  sourceSize: Size;
  target: TargetId;
  profile: ProfileId;
  engine: EngineId;
  format: ImageFormat;
  intent: CodecIntent;
  aiModelLoaded: boolean;
  /** Le runtime IA local est disponible même si aucun modèle n'est encore chargé. */
  aiAvailable?: boolean;
  webGpu: boolean;
  mistralEnabled?: boolean;
  mistralApiKey?: string;
  mistralModel?: string;
}

export interface AgentPlan {
  target: TargetId;
  profile: ProfileId;
  engine: EngineId;
  format: ImageFormat;
  intent: CodecIntent;
  metrics: VisualMetrics | null;
  videoVisionMetrics: VideoVisionMetrics | null;
  mistralVision: MistralVisionResult | null;
  decisions: AgentDecision[];
}

const IMAGE_TARGET_ORDER: TargetId[] = ["original", "2k", "4k", "8k", "16k"];
const VIDEO_TARGET_ORDER: TargetId[] = ["original", "1080p", "2k", "4k", "8k"];

function d(agent: AgentKind, label: string, status: AgentStatus, message: string): AgentDecision {
  return { agent, label, status, message };
}

type ReadableCanvas = HTMLCanvasElement | OffscreenCanvas;

function measureCanvas(canvas: ReadableCanvas): VisualMetrics {
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error("Canvas 2D indisponible pour l'analyse agentique.");

  const { width, height } = canvas;
  const pixels = ctx.getImageData(0, 0, width, height).data;
  const count = Math.max(1, width * height);
  const luma = new Float32Array(count);

  let sum = 0;
  let black = 0;
  let white = 0;

  for (let i = 0, p = 0; i < pixels.length; i += 4, p += 1) {
    const y = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
    luma[p] = y;
    sum += y;
    if (y < 8) black += 1;
    if (y > 247) white += 1;
  }

  const mean = sum / count;
  let variance = 0;
  let edges = 0;
  let edgeCount = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const delta = luma[i] - mean;
      variance += delta * delta;

      if (x + 1 < width) {
        edges += Math.abs(luma[i] - luma[i + 1]);
        edgeCount += 1;
      }
      if (y + 1 < height) {
        edges += Math.abs(luma[i] - luma[i + width]);
        edgeCount += 1;
      }
    }
  }

  return {
    meanLuma: mean / 255,
    contrast: Math.sqrt(variance / count) / 128,
    edgeEnergy: edgeCount ? edges / edgeCount / 255 : 0,
    clippedBlack: black / count,
    clippedWhite: white / count,
  };
}

async function imageMetrics(file: Blob): Promise<VisualMetrics | null> {
  let decoded: Awaited<ReturnType<typeof decodeImageFile>> | null = null;
  try {
    decoded = await decodeImageFile(file);
    const maxSide = 384;
    const scale = Math.min(1, maxSide / Math.max(decoded.width, decoded.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(8, Math.round(decoded.width * scale));
    canvas.height = Math.max(8, Math.round(decoded.height * scale));

    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
    return measureCanvas(canvas);
  } catch {
    return null;
  } finally {
    decoded?.close();
  }
}

function legacyFromVideo(metrics: VideoVisionMetrics | null): VisualMetrics | null {
  if (!metrics) return null;
  return {
    meanLuma: metrics.meanLuma,
    contrast: metrics.contrast,
    edgeEnergy: metrics.detailEnergy,
    clippedBlack: metrics.clippedBlack,
    clippedWhite: metrics.clippedWhite,
  };
}

async function videoMetricsWithCanvasSink(file: File): Promise<VideoVisionMetrics | null> {
  if (!webCodecsAvailable()) return null;

  const { ALL_FORMATS, BlobSource, CanvasSink, Input } = await import("mediabunny");
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });

  try {
    if (!(await input.canRead())) return null;
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;

    const first = await track.getFirstTimestamp();
    let end = await track.getDurationFromMetadata({ skipLiveWait: true });
    if (!Number.isFinite(end) || end == null || end <= first) {
      end = await track.computeDuration({ skipLiveWait: true });
    }

    const safeEnd = Number.isFinite(end) && end > first ? end : first + 0.5;
    const span = Math.max(0.001, safeEnd - first);
    const ratios = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.985];
    const timestamps = ratios.map((ratio) =>
      Math.min(safeEnd - Math.min(0.02, span * 0.005), first + span * ratio),
    );

    const sink = new CanvasSink(track, {
      width: 384,
      poolSize: 2,
      decoderOptions: { hardwareAcceleration: "no-preference" },
    });

    const frames: FrameMetrics[] = [];
    let index = 0;
    for await (const wrapped of sink.canvasesAtTimestamps(timestamps)) {
      if (!wrapped) {
        index += 1;
        continue;
      }
      frames.push(analyzeVisionCanvas(wrapped.canvas, timestamps[index] ?? first));
      index += 1;
    }

    return aggregateVisionFrames(frames);
  } finally {
    input.dispose();
  }
}

async function videoMetricsWithSamples(file: File): Promise<VideoVisionMetrics | null> {
  if (!webCodecsAvailable()) return null;

  const { ALL_FORMATS, BlobSource, Input, VideoSampleSink } = await import("mediabunny");
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });

  try {
    if (!(await input.canRead())) return null;
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;

    const first = await track.getFirstTimestamp();
    let end = await track.getDurationFromMetadata({ skipLiveWait: true });
    if (!Number.isFinite(end) || end == null || end <= first) {
      end = await track.computeDuration({ skipLiveWait: true });
    }

    const safeEnd = Number.isFinite(end) && end > first ? end : first + 0.5;
    const span = Math.max(0.001, safeEnd - first);
    const timestamps = [first, first + span * 0.5, Math.max(first, safeEnd - 0.04)];
    const sink = new VideoSampleSink(track, { hardwareAcceleration: "no-preference" });
    const frames: FrameMetrics[] = [];

    for (const timestamp of timestamps) {
      const sample = await sink.getSample(timestamp);
      if (!sample) continue;

      try {
        const maxSide = 384;
        const scale = Math.min(1, maxSide / Math.max(sample.displayWidth, sample.displayHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(8, Math.round(sample.displayWidth * scale));
        canvas.height = Math.max(8, Math.round(sample.displayHeight * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        sample.draw(ctx, 0, 0, canvas.width, canvas.height);
        frames.push(analyzeVisionCanvas(canvas, timestamp));
      } finally {
        sample.close();
      }
    }

    return aggregateVisionFrames(frames);
  } finally {
    input.dispose();
  }
}

function waitForVideoEvent(
  video: HTMLVideoElement,
  event: "loadedmetadata" | "loadeddata" | "seeked",
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("Timeout " + event + " pendant l'analyse vidéo."));
    }, timeoutMs);

    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Décodage vidéo HTML impossible."));
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener(event, onEvent);
      video.removeEventListener("error", onError);
    };

    video.addEventListener(event, onEvent, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

async function videoMetricsWithElement(file: File): Promise<VideoVisionMetrics | null> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.controls = false;
  video.style.position = "fixed";
  video.style.left = "-10000px";
  video.style.top = "0";
  video.style.width = "2px";
  video.style.height = "2px";
  video.style.opacity = "0";
  video.style.pointerEvents = "none";

  document.body.appendChild(video);

  try {
    video.src = url;
    video.load();

    if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
      await waitForVideoEvent(video, "loadedmetadata", 10_000);
    }
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await waitForVideoEvent(video, "loadeddata", 10_000);
    }

    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    if (duration > 0.2) {
      const targetTime = Math.min(Math.max(0.05, duration * 0.25), Math.max(0.05, duration - 0.05));
      if (Math.abs(video.currentTime - targetTime) > 0.01) {
        video.currentTime = targetTime;
        await waitForVideoEvent(video, "seeked", 10_000);
      }
    }

    const maxSide = 384;
    const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(8, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(8, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return aggregateVisionFrames([analyzeVisionCanvas(canvas, video.currentTime)]);
  } catch {
    return null;
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
  }
}

async function videoMetrics(file: File): Promise<VideoVisionMetrics | null> {
  try {
    const direct = await videoMetricsWithCanvasSink(file);
    if (direct) return direct;
  } catch {
    // Continuer avec le deuxième décodeur.
  }

  try {
    const samples = await videoMetricsWithSamples(file);
    if (samples) return samples;
  } catch {
    // Continuer avec le repli HTML.
  }

  return videoMetricsWithElement(file);
}

function qualityProfile(
  metrics: VisualMetrics | null,
  videoMetricsValue: VideoVisionMetrics | null,
  mistral: MistralVisionResult | null,
  current: ProfileId,
): ProfileId {
  if (!metrics) return current;

  let recommended: ProfileId = current;

  if (metrics.clippedBlack + metrics.clippedWhite > 0.12) {
    recommended = "archive";
  } else if (videoMetricsValue && videoMetricsValue.noise > 0.12) {
    recommended = "archive";
  } else if (metrics.edgeEnergy < 0.035 && metrics.contrast < 0.58) {
    recommended = "detail";
  } else if (metrics.contrast > 0.95) {
    recommended = "fidelity";
  }

  if (mistral && mistral.confidence >= 0.6) {
    recommended = mistral.recommendedProfile;

    if (videoMetricsValue?.haloRisk && videoMetricsValue.haloRisk > 0.35 && recommended === "detail") {
      recommended = "fidelity";
    }
    if (videoMetricsValue?.noise && videoMetricsValue.noise > 0.14 && recommended === "detail") {
      recommended = "archive";
    }
  }

  return recommended;
}

function safestImageTarget(source: Size, requested: TargetId): TargetId {
  if (assessImageTarget(source, requested).supported) return requested;

  let index = IMAGE_TARGET_ORDER.indexOf(requested);
  if (index < 0) index = IMAGE_TARGET_ORDER.length - 1;

  for (let i = index - 1; i >= 0; i -= 1) {
    if (assessImageTarget(source, IMAGE_TARGET_ORDER[i]).supported) return IMAGE_TARGET_ORDER[i];
  }

  return "original";
}

async function safestVideoTarget(source: Size, requested: TargetId): Promise<TargetId> {
  if (!webCodecsAvailable()) {
    if (requested === "8k") return "4k";
    return requested;
  }

  let index = VIDEO_TARGET_ORDER.indexOf(requested);
  if (index < 0) index = VIDEO_TARGET_ORDER.length - 1;

  for (let i = index; i >= 0; i -= 1) {
    const candidate = VIDEO_TARGET_ORDER[i];
    const size = calculateOutputSize(source.width, source.height, candidate);
    try {
      const codecs = await codecInventory(size.width, size.height, 30);
      if (codecs.length > 0) return candidate;
    } catch {
      // Continuer vers une cible inférieure.
    }
  }

  return "original";
}

function validationDecision(
  decisions: AgentDecision[],
  mode: AgentContext["mode"],
  mistralExpected: boolean,
): AgentDecision {
  const expected: AgentKind[] =
    mode === "video"
      ? ["supervisor", "vision", "quality", "focus", "memory", "codec", "upscale"]
      : ["supervisor", "vision", "quality", "memory", "upscale", "codec"];

  if (mistralExpected) expected.push("semantic");

  const present = new Set(decisions.map((entry) => entry.agent));
  const missing = expected.filter((agent) => !present.has(agent));
  const warnings = decisions.filter((entry) => entry.status === "warning").length;

  if (missing.length) {
    return d(
      "validation",
      "Agent Validation",
      "warning",
      "Audit agentique incomplet : agents manquants " + missing.join(", ") + ".",
    );
  }

  return d(
    "validation",
    "Agent Validation",
    warnings ? "adjusted" : "ok",
    "Audit " + expected.length + "/" + expected.length + " agents requis présent. " +
      (warnings ? warnings + " alerte(s) avec repli actif." : "Aucune anomalie de chaîne détectée."),
  );
}

export async function orchestrateMediaAgents(context: AgentContext): Promise<AgentPlan> {
  const decisions: AgentDecision[] = [];
  let target = context.target;
  let profile = context.profile;
  let engine = context.engine;
  const format = context.format;
  const intent = context.intent;
  let videoVisionMetrics: VideoVisionMetrics | null = null;
  let mistralVision: MistralVisionResult | null = null;

  decisions.push(
    d(
      "supervisor",
      "Superviseur",
      "ok",
      "Mission " + context.mode + " · source " + context.sourceSize.width + "×" + context.sourceSize.height +
        " · cible demandée " + context.target + ".",
    ),
  );

  const metrics =
    context.mode === "image"
      ? await imageMetrics(context.file)
      : legacyFromVideo((videoVisionMetrics = await videoMetrics(context.file)));

  if (context.mode === "video" && videoVisionMetrics) {
    decisions.push(
      d(
        "vision",
        "Agent Vision",
        "ok",
        videoVisionMetrics.frameCountAnalyzed + " frames · 10 zones/frame · luminance " +
          Math.round(videoVisionMetrics.meanLuma * 100) + " % · contraste " +
          Math.round(videoVisionMetrics.contrast * 100) + " % · détail " +
          (videoVisionMetrics.detailEnergy * 100).toFixed(1) + " % · bruit " +
          (videoVisionMetrics.noise * 100).toFixed(1) + " % · halos " +
          (videoVisionMetrics.haloRisk * 100).toFixed(1) + " % · compression " +
          (videoVisionMetrics.blockiness * 100).toFixed(1) + " %.",
      ),
    );

    decisions.push(
      d(
        "focus",
        "Agent Focus 10 zones",
        "ok",
        "Zones les plus faibles Z" + videoVisionMetrics.weakestZones.join("/Z") +
          " · zones les plus détaillées Z" + videoVisionMetrics.strongestZones.join("/Z") +
          ". Analyse spatiale, sans prétendre à une profondeur 3D métrique.",
      ),
    );
  } else if (metrics) {
    decisions.push(
      d(
        "vision",
        "Agent Vision",
        "ok",
        "Luminance " + Math.round(metrics.meanLuma * 100) + " %, contraste " +
          Math.round(metrics.contrast * 100) + " %, énergie de détail " +
          (metrics.edgeEnergy * 100).toFixed(1) + " %.",
      ),
    );
  } else {
    decisions.push(
      d("vision", "Agent Vision", "warning", "Analyse visuelle partielle : métriques indisponibles."),
    );
  }

  const mistralRequested =
    context.mode === "video" &&
    Boolean(context.mistralEnabled);

  if (mistralRequested) {
    if (!context.mistralApiKey?.trim()) {
      decisions.push(
        d(
          "semantic",
          "Agent Mistral Vision",
          "warning",
          "Mode Mistral activé mais aucune clé API n'est fournie. Repli 100 % local.",
        ),
      );
    } else if (!videoVisionMetrics) {
      decisions.push(
        d(
          "semantic",
          "Agent Mistral Vision",
          "warning",
          "Analyse locale indisponible : Mistral n'est pas appelé afin d'éviter une décision sans mesures de contrôle.",
        ),
      );
    } else {
      try {
        mistralVision = await analyzeVideoWithMistral(context.file, videoVisionMetrics, {
          apiKey: context.mistralApiKey,
          model: context.mistralModel,
          maxFrames: 4,
        });
        decisions.push(
          d(
            "semantic",
            "Agent Mistral Vision",
            "ok",
            mistralVision.framesSent + " keyframes · scène " + mistralVision.scene +
              " · confiance " + Math.round(mistralVision.confidence * 100) + " % · stratégie : " +
              mistralVision.depthStrategy + ".",
          ),
        );
      } catch (reason) {
        decisions.push(
          d(
            "semantic",
            "Agent Mistral Vision",
            "warning",
            (reason instanceof Error ? reason.message : "Analyse Mistral impossible.") +
              " Repli local automatique.",
          ),
        );
      }
    }
  }

  const recommendedProfile = qualityProfile(metrics, videoVisionMetrics, mistralVision, profile);
  if (recommendedProfile !== profile) {
    const reason = mistralVision
      ? "fusion des métriques locales et de l'analyse Mistral"
      : "analyse locale du signal";
    profile = recommendedProfile;
    decisions.push(
      d("quality", "Agent Qualité", "adjusted", "Profil automatique : " + recommendedProfile + " après " + reason + "."),
    );
  } else {
    decisions.push(d("quality", "Agent Qualité", "ok", "Profil " + profile + " conservé."));
  }

  if (context.mode === "image") {
    const safeTarget = safestImageTarget(context.sourceSize, target);
    if (safeTarget !== target) {
      decisions.push(
        d("memory", "Agent Mémoire", "adjusted", "Cible " + target + " ramenée à " + safeTarget + " pour éviter un échec local."),
      );
      target = safeTarget;
    } else {
      const output = calculateOutputSize(context.sourceSize.width, context.sourceSize.height, target);
      decisions.push(
        d(
          "memory",
          "Agent Mémoire",
          megapixels(output) > 70 ? "warning" : "ok",
          "Sortie prévue : " + output.width + "×" + output.height + ", " + megapixels(output).toFixed(1) + " MP.",
        ),
      );
    }

    const output = calculateOutputSize(context.sourceSize.width, context.sourceSize.height, target);
    const scale = Math.max(output.width / context.sourceSize.width, output.height / context.sourceSize.height);
    if ((context.aiModelLoaded || context.aiAvailable) && scale >= 1.35) {
      engine = "ai";
      decisions.push(
        d(
          "upscale",
          "Agent Upscale",
          context.engine === "ai" ? "ok" : "adjusted",
          "Super-résolution IA locale activée pour ×" + scale.toFixed(2) +
            (context.webGpu ? " avec WebGPU." : " avec WASM."),
        ),
      );
    } else {
      engine = "canvas";
      const reason =
        scale < 1.35
          ? "agrandissement trop faible pour justifier l'IA"
          : "runtime IA local indisponible";
      decisions.push(d("upscale", "Agent Upscale", "ok", "Canvas haute qualité retenu : " + reason + "."));
    }

    decisions.push(
      d("codec", "Agent Format", "ok", "Export image " + format.replace("image/", "").toUpperCase() + " conservé."),
    );
  } else {
    const safeTarget = await safestVideoTarget(context.sourceSize, target);
    if (safeTarget !== target) {
      decisions.push(
        d(
          "memory",
          "Agent Performance",
          "adjusted",
          "Cible vidéo " + target + " ramenée à " + safeTarget +
            " : aucune chaîne encode + mux + lecture sûre à la cible initiale.",
        ),
      );
      target = safeTarget;
    } else {
      decisions.push(
        d(
          "memory",
          "Agent Performance",
          "ok",
          "Cible vidéo " + target + " validée par sonde encode + mux + lecture sur cet appareil.",
        ),
      );
    }

    if (webCodecsAvailable()) {
      const output = calculateOutputSize(context.sourceSize.width, context.sourceSize.height, target);
      const codecs = await codecInventory(output.width, output.height, 30);
      const labels = codecs.slice(0, 4).map((entry) => entry.label).join(", ");
      decisions.push(
        d(
          "codec",
          "Agent Codec Pro",
          codecs.length ? "ok" : "warning",
          codecs.length
            ? "Chaînes vidéo validées : " + labels + "."
            : "Aucune chaîne encode + mux + lecture validée à cette définition.",
        ),
      );
    } else {
      decisions.push(
        d(
          "codec",
          "Agent Codec Pro",
          "warning",
          "WebCodecs absent : repli MediaRecorder avec qualité moins contrôlable.",
        ),
      );
    }

    const tuning = mistralVision
      ? " Profil guidé par Mistral : sharpen " + Math.round(mistralVision.sharpnessStrength * 100) +
        " %, débruitage conseillé " + Math.round(mistralVision.denoiseStrength * 100) + " %."
      : "";

    decisions.push(
      d(
        "upscale",
        "Agent Upscale Vidéo",
        "ok",
        "Redimensionnement image par image, traitement temporel stable, timestamps conservés et replis codec/définition." + tuning,
      ),
    );
  }

  decisions.push(validationDecision(decisions, context.mode, mistralRequested));

  return {
    target,
    profile,
    engine,
    format,
    intent,
    metrics,
    videoVisionMetrics,
    mistralVision,
    decisions,
  };
}
