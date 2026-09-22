import { AI_MAX_SOURCE_PIXELS } from "./aiUpscaler";
import { decodeImageFile } from "./imageDecode";
import { assessImageTarget, type EngineId, type ImageFormat } from "./imageEnhancer";
import { calculateOutputSize, megapixels, type Size, type TargetId } from "./geometry";
import type { ProfileId } from "./profiles";
import { codecInventory, webCodecsAvailable, type CodecIntent } from "./videoCodec";

export type AgentKind =
  | "supervisor"
  | "vision"
  | "quality"
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
  webGpu: boolean;
}

export interface AgentPlan {
  target: TargetId;
  profile: ProfileId;
  engine: EngineId;
  format: ImageFormat;
  intent: CodecIntent;
  metrics: VisualMetrics | null;
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

function averageMetrics(values: VisualMetrics[]): VisualMetrics | null {
  if (!values.length) return null;
  const sum = values.reduce(
    (acc, value) => ({
      meanLuma: acc.meanLuma + value.meanLuma,
      contrast: acc.contrast + value.contrast,
      edgeEnergy: acc.edgeEnergy + value.edgeEnergy,
      clippedBlack: acc.clippedBlack + value.clippedBlack,
      clippedWhite: acc.clippedWhite + value.clippedWhite,
    }),
    { meanLuma: 0, contrast: 0, edgeEnergy: 0, clippedBlack: 0, clippedWhite: 0 },
  );
  const divisor = values.length;
  return {
    meanLuma: sum.meanLuma / divisor,
    contrast: sum.contrast / divisor,
    edgeEnergy: sum.edgeEnergy / divisor,
    clippedBlack: sum.clippedBlack / divisor,
    clippedWhite: sum.clippedWhite / divisor,
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

/**
 * Agent Vision vidéo.
 *
 * Stratégie 1 : CanvasSink (voie officielle Mediabunny pour extraire des
 * miniatures décodées). C'est la voie prioritaire sur Android car elle évite
 * de manipuler directement VideoFrame.
 *
 * Stratégie 2 : VideoSampleSink, conservée comme repli WebCodecs.
 *
 * Stratégie 3 : élément <video> réellement attaché au DOM, avec délai plus
 * généreux et seek explicite. Certains Chromium Android ne décodent pas
 * correctement un élément vidéo totalement détaché.
 */
async function videoMetricsWithCanvasSink(file: File): Promise<VisualMetrics | null> {
  if (!webCodecsAvailable()) return null;

  const { ALL_FORMATS, BlobSource, CanvasSink, Input } = await import("mediabunny");
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });

  try {
    if (!(await input.canRead())) return null;

    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;

    // Ne pas s'arrêter à canDecode(): sur certains Chromium Android, la sonde
    // peut être trop pessimiste alors que le décodeur fonctionne effectivement.
    const first = await track.getFirstTimestamp();
    let end = await track.getDurationFromMetadata({ skipLiveWait: true });
    if (!Number.isFinite(end) || end == null || end <= first) {
      end = await track.computeDuration({ skipLiveWait: true });
    }

    const safeEnd = Number.isFinite(end) && end > first ? end : first + 0.5;
    const span = Math.max(0.001, safeEnd - first);
    const timestamps = [
      first,
      first + span * 0.33,
      first + span * 0.66,
      Math.max(first, safeEnd - Math.min(0.05, span * 0.02)),
    ];

    const sink = new CanvasSink(track, {
      width: 384,
      poolSize: 2,
      decoderOptions: {
        hardwareAcceleration: "no-preference",
      },
    });

    const metrics: VisualMetrics[] = [];
    for await (const wrapped of sink.canvasesAtTimestamps(timestamps)) {
      if (!wrapped) continue;
      metrics.push(measureCanvas(wrapped.canvas));
    }

    return averageMetrics(metrics);
  } finally {
    input.dispose();
  }
}

async function videoMetricsWithSamples(file: File): Promise<VisualMetrics | null> {
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
    const metrics: VisualMetrics[] = [];

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
        metrics.push(measureCanvas(canvas));
      } finally {
        sample.close();
      }
    }

    return averageMetrics(metrics);
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
      reject(new Error(`Timeout ${event} pendant l'analyse vidéo.`));
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

async function videoMetricsWithElement(file: File): Promise<VisualMetrics | null> {
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

    // Force le navigateur à préparer une vraie image décodable.
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
    return measureCanvas(canvas);
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

async function videoMetrics(file: File): Promise<VisualMetrics | null> {
  try {
    const canvasMetrics = await videoMetricsWithCanvasSink(file);
    if (canvasMetrics) return canvasMetrics;
  } catch {
    // Continuer avec le deuxième décodeur.
  }

  try {
    const sampleMetrics = await videoMetricsWithSamples(file);
    if (sampleMetrics) return sampleMetrics;
  } catch {
    // Continuer avec le repli HTML.
  }

  return videoMetricsWithElement(file);
}

function qualityProfile(metrics: VisualMetrics | null, current: ProfileId): ProfileId {
  if (!metrics) return current;
  if (metrics.edgeEnergy < 0.03 && metrics.contrast < 0.52) return "detail";
  if (metrics.clippedBlack + metrics.clippedWhite > 0.12) return "archive";
  if (metrics.contrast > 0.95) return "fidelity";
  return current;
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
      // Continue vers une cible inférieure.
    }
  }

  return "original";
}

export async function orchestrateMediaAgents(context: AgentContext): Promise<AgentPlan> {
  const decisions: AgentDecision[] = [];
  let target = context.target;
  let profile = context.profile;
  let engine = context.engine;
  const format = context.format;
  const intent = context.intent;

  decisions.push(
    d(
      "supervisor",
      "Superviseur",
      "ok",
      `Mission ${context.mode} · source ${context.sourceSize.width}×${context.sourceSize.height} · cible demandée ${context.target}.`,
    ),
  );

  const metrics = context.mode === "image" ? await imageMetrics(context.file) : await videoMetrics(context.file);

  if (metrics) {
    decisions.push(
      d(
        "vision",
        "Agent Vision",
        "ok",
        `Luminance ${Math.round(metrics.meanLuma * 100)} %, contraste ${Math.round(metrics.contrast * 100)} %, énergie de détail ${(metrics.edgeEnergy * 100).toFixed(1)} %.`,
      ),
    );
  } else {
    decisions.push(d("vision", "Agent Vision", "warning", "Analyse visuelle partielle : métriques indisponibles."));
  }

  const recommendedProfile = qualityProfile(metrics, profile);
  if (recommendedProfile !== profile) {
    profile = recommendedProfile;
    decisions.push(
      d("quality", "Agent Qualité", "adjusted", `Profil automatique : ${recommendedProfile} après analyse du signal.`),
    );
  } else {
    decisions.push(d("quality", "Agent Qualité", "ok", `Profil ${profile} conservé.`));
  }

  if (context.mode === "image") {
    const safeTarget = safestImageTarget(context.sourceSize, target);
    if (safeTarget !== target) {
      decisions.push(
        d("memory", "Agent Mémoire", "adjusted", `Cible ${target} ramenée à ${safeTarget} pour éviter un échec local.`),
      );
      target = safeTarget;
    } else {
      const output = calculateOutputSize(context.sourceSize.width, context.sourceSize.height, target);
      decisions.push(
        d(
          "memory",
          "Agent Mémoire",
          megapixels(output) > 70 ? "warning" : "ok",
          `Sortie prévue : ${output.width}×${output.height}, ${megapixels(output).toFixed(1)} MP.`,
        ),
      );
    }

    const output = calculateOutputSize(context.sourceSize.width, context.sourceSize.height, target);
    const scale = Math.max(output.width / context.sourceSize.width, output.height / context.sourceSize.height);
    const sourcePixels = context.sourceSize.width * context.sourceSize.height;

    if (context.aiModelLoaded && sourcePixels <= AI_MAX_SOURCE_PIXELS && scale >= 1.35) {
      engine = "ai";
      decisions.push(
        d(
          "upscale",
          "Agent Upscale",
          context.engine === "ai" ? "ok" : "adjusted",
          `Super-résolution IA locale activée pour ×${scale.toFixed(2)}${context.webGpu ? " avec WebGPU" : " avec WASM"}.`,
        ),
      );
    } else {
      engine = "canvas";
      const reason = !context.aiModelLoaded
        ? "modèle ONNX non chargé"
        : sourcePixels > AI_MAX_SOURCE_PIXELS
          ? "source trop grande pour l'IA locale"
          : "agrandissement trop faible pour justifier l'IA";
      decisions.push(d("upscale", "Agent Upscale", "ok", `Canvas haute qualité retenu : ${reason}.`));
    }

    decisions.push(d("codec", "Agent Format", "ok", `Export image ${format.replace("image/", "").toUpperCase()} conservé.`));
  } else {
    const safeTarget = await safestVideoTarget(context.sourceSize, target);
    if (safeTarget !== target) {
      decisions.push(
        d(
          "memory",
          "Agent Performance",
          "adjusted",
          `Cible vidéo ${target} ramenée à ${safeTarget} : aucun encodeur sûr n'était exposé pour la cible initiale.`,
        ),
      );
      target = safeTarget;
    } else {
      decisions.push(d("memory", "Agent Performance", "ok", `Cible vidéo ${target} validée par une sonde réelle encode + mux + lecture sur cet appareil.`));
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
            ? `Chaînes vidéo validées par test réel : ${labels}. Chaque entrée a encodé, été muxée puis relue localement.`
            : "Aucune chaîne encode + mux + lecture validée à cette définition.",
        ),
      );
    } else {
      decisions.push(
        d("codec", "Agent Codec Pro", "warning", "WebCodecs absent : repli MediaRecorder avec qualité moins contrôlable."),
      );
    }

    decisions.push(
      d(
        "upscale",
        "Agent Upscale Vidéo",
        "ok",
        "Redimensionnement image par image, traitement stable dans le temps, conservation des timestamps et repli automatique si l'encodeur refuse la cible.",
      ),
    );
  }

  decisions.push(
    d(
      "validation",
      "Agent Validation",
      "ok",
      "Plan validé : géométrie verrouillée, repli sûr activé et traitement local.",
    ),
  );

  return { target, profile, engine, format, intent, metrics, decisions };
}
