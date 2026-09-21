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

function measureCanvas(canvas: HTMLCanvasElement): VisualMetrics {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
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
    // L'analyse visuelle est facultative : elle ne doit jamais bloquer
    // le mastering si Android refuse une lecture secondaire du fichier.
    return null;
  } finally {
    decoded?.close();
  }
}

async function videoMetrics(file: File): Promise<VisualMetrics | null> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;

  try {
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.addEventListener("loadeddata", () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error("Échantillon vidéo illisible.")), { once: true });
    });

    if (Number.isFinite(video.duration) && video.duration > 0.5) {
      const seek = Math.min(video.duration * 0.2, Math.max(0.1, video.duration - 0.1));
      await Promise.race([
        new Promise<void>((resolve) => {
          video.addEventListener("seeked", () => resolve(), { once: true });
          video.currentTime = seek;
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 800)),
      ]);
    }

    const maxSide = 384;
    const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(8, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(8, Math.round(video.videoHeight * scale));

    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return measureCanvas(canvas);
  } catch {
    return null;
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
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
    // Le fallback MediaRecorder reste volontairement limité : ne pas pousser
    // automatiquement un téléphone vers une cible très lourde.
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
      decisions.push(d("memory", "Agent Performance", "ok", `Cible vidéo ${target} validée sur cet appareil.`));
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
            ? `Encodeurs professionnels disponibles : ${labels}. Le meilleur est choisi selon l'usage et la charge.`
            : "Aucun encodeur WebCodecs disponible à cette définition.",
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
        "Redimensionnement géométrique haute qualité, sans recadrage et avec conservation de la cadence détectée.",
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
