import type { ProfileId } from "./profiles";
import type { VideoVisionMetrics, VisionCanvas } from "./visionMetrics";

export interface MistralVisionConfig {
  apiKey: string;
  model?: string;
  maxFrames?: number;
}

export interface MistralVisionResult {
  model: string;
  scene: string;
  subjects: string[];
  facePriority: number;
  texturePriority: number;
  backgroundPriority: number;
  noiseRisk: number;
  compressionRisk: number;
  recommendedProfile: ProfileId;
  sharpnessStrength: number;
  denoiseStrength: number;
  haloLimit: number;
  depthStrategy: string;
  preserveSkin: boolean;
  confidence: number;
  summary: string;
  framesSent: number;
}

interface MistralChatResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  message?: string;
}

const API_URL = "https://api.mistral.ai/v1/chat/completions";
const DEFAULT_MODEL = "mistral-small-latest";
const REQUEST_TIMEOUT_MS = 25_000;

function clamp01(value: unknown, fallback = 0): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(1, Math.max(0, numeric));
}

function profileId(value: unknown): ProfileId {
  return value === "archive" || value === "cinema" || value === "detail" || value === "fidelity"
    ? value
    : "detail";
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 12);
}

async function canvasToJpegDataUrl(canvas: VisionCanvas): Promise<string> {
  if (typeof HTMLCanvasElement !== "undefined" && canvas instanceof HTMLCanvasElement) {
    return canvas.toDataURL("image/jpeg", 0.74);
  }

  const html = document.createElement("canvas");
  html.width = canvas.width;
  html.height = canvas.height;
  const ctx = html.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D indisponible pour Mistral Vision.");
  ctx.drawImage(canvas as CanvasImageSource, 0, 0);
  return html.toDataURL("image/jpeg", 0.74);
}

async function extractKeyframes(file: File, maxFrames: number): Promise<string[]> {
  const { ALL_FORMATS, BlobSource, CanvasSink, Input } = await import("mediabunny");
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });

  try {
    if (!(await input.canRead())) throw new Error("Conteneur vidéo non lisible.");
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("Aucune piste vidéo.");

    const first = await track.getFirstTimestamp();
    let end = await track.getDurationFromMetadata({ skipLiveWait: true });
    if (!Number.isFinite(end) || end == null || end <= first) {
      end = await track.computeDuration({ skipLiveWait: true });
    }

    const safeEnd = Number.isFinite(end) && end > first ? end : first + 0.5;
    const span = Math.max(0.001, safeEnd - first);
    const count = Math.min(6, Math.max(2, Math.floor(maxFrames)));
    const timestamps = Array.from({ length: count }, (_, index) => {
      if (count === 1) return first;
      const ratio = index / (count - 1);
      const timestamp = first + span * ratio;
      return index === count - 1
        ? Math.max(first, safeEnd - Math.min(0.05, span * 0.02))
        : timestamp;
    });

    const sink = new CanvasSink(track, {
      width: 640,
      poolSize: 2,
      decoderOptions: {
        hardwareAcceleration: "no-preference",
      },
    });

    const frames: string[] = [];
    for await (const wrapped of sink.canvasesAtTimestamps(timestamps)) {
      if (!wrapped) continue;
      frames.push(await canvasToJpegDataUrl(wrapped.canvas));
    }

    if (!frames.length) throw new Error("Aucune keyframe décodable pour Mistral Vision.");
    return frames;
  } finally {
    input.dispose();
  }
}

function promptFor(metrics: VideoVisionMetrics): string {
  return [
    "Tu es le directeur image et superviseur de restauration vidéo de Niko UltraVision.",
    "Analyse les keyframes fournies. N'invente pas de détails absents.",
    "Utilise aussi les mesures locales objectives ci-dessous.",
    "Retourne uniquement un objet JSON compact avec exactement ces clés :",
    "scene, subjects, facePriority, texturePriority, backgroundPriority, noiseRisk, compressionRisk,",
    "recommendedProfile, sharpnessStrength, denoiseStrength, haloLimit, depthStrategy, preserveSkin, confidence, summary.",
    "recommendedProfile doit être fidelity, archive, cinema ou detail.",
    "Tous les scores numériques doivent être compris entre 0 et 1.",
    "sharpnessStrength et denoiseStrength sont des intensités prudentes entre 0 et 1.",
    "depthStrategy décrit en quelques mots les zones/éléments à privilégier, sans prétendre à une profondeur métrique.",
    "",
    "Mesures locales JSON: " + JSON.stringify({
      frames: metrics.frameCountAnalyzed,
      luminance: Number(metrics.meanLuma.toFixed(4)),
      contrast: Number(metrics.contrast.toFixed(4)),
      detail: Number(metrics.detailEnergy.toFixed(4)),
      noise: Number(metrics.noise.toFixed(4)),
      haloRisk: Number(metrics.haloRisk.toFixed(4)),
      blockiness: Number(metrics.blockiness.toFixed(4)),
      clippedBlack: Number(metrics.clippedBlack.toFixed(4)),
      clippedWhite: Number(metrics.clippedWhite.toFixed(4)),
      weakestZones: metrics.weakestZones,
      strongestZones: metrics.strongestZones,
    }),
  ].join("\n");
}

function extractContent(response: MistralChatResponse): string {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((entry) => (typeof entry.text === "string" ? entry.text : ""))
      .join("")
      .trim();
  }
  throw new Error(response.message || "Réponse Mistral vide.");
}

function sanitize(
  raw: Record<string, unknown>,
  model: string,
  framesSent: number,
): MistralVisionResult {
  return {
    model,
    scene: asString(raw.scene, "scene_non_classee"),
    subjects: asStringArray(raw.subjects),
    facePriority: clamp01(raw.facePriority),
    texturePriority: clamp01(raw.texturePriority, 0.5),
    backgroundPriority: clamp01(raw.backgroundPriority, 0.5),
    noiseRisk: clamp01(raw.noiseRisk),
    compressionRisk: clamp01(raw.compressionRisk),
    recommendedProfile: profileId(raw.recommendedProfile),
    sharpnessStrength: clamp01(raw.sharpnessStrength, 0.18),
    denoiseStrength: clamp01(raw.denoiseStrength, 0.08),
    haloLimit: clamp01(raw.haloLimit, 0.08),
    depthStrategy: asString(raw.depthStrategy, "préserver le sujet principal et les textures utiles"),
    preserveSkin: raw.preserveSkin === true,
    confidence: clamp01(raw.confidence, 0.5),
    summary: asString(raw.summary, "Analyse sémantique Mistral terminée."),
    framesSent,
  };
}

export async function analyzeVideoWithMistral(
  file: File,
  metrics: VideoVisionMetrics,
  config: MistralVisionConfig,
): Promise<MistralVisionResult> {
  const apiKey = config.apiKey.trim();
  if (!apiKey) throw new Error("Clé API Mistral absente.");

  const model = config.model?.trim() || DEFAULT_MODEL;
  const frames = await extractKeyframes(file, config.maxFrames ?? 4);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const content: Array<Record<string, unknown>> = [
      {
        type: "text",
        text: promptFor(metrics),
      },
      ...frames.map((imageUrl) => ({
        type: "image_url",
        image_url: imageUrl,
      })),
    ];

    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content,
          },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: 500,
      }),
      signal: controller.signal,
    });

    const payload = (await response.json().catch(() => ({}))) as MistralChatResponse;
    if (!response.ok) {
      const detail = payload.message ? " · " + payload.message : "";
      if (response.status === 401) throw new Error("Clé Mistral refusée" + detail);
      if (response.status === 429) throw new Error("Quota gratuit Mistral atteint ou débit limité" + detail);
      throw new Error("Mistral HTTP " + response.status + detail);
    }

    const text = extractContent(payload);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return sanitize(parsed, model, frames.length);
  } catch (reason) {
    if (reason instanceof DOMException && reason.name === "AbortError") {
      throw new Error("Mistral Vision n'a pas répondu dans le délai imparti.");
    }
    throw reason;
  } finally {
    window.clearTimeout(timer);
  }
}
