import type { VideoCodec } from "mediabunny";

/**
 * Négociation de codec à l'exécution.
 *
 * Rien n'est codé en dur : la liste des codecs réellement encodables est
 * demandée au navigateur pour la résolution et la cadence visées, puis filtrée
 * par l'intention de sortie. Si un codec disparaît d'une version de navigateur
 * à l'autre, la chaîne se replie toute seule.
 */

export type CodecIntent = "copy" | "mezzanine" | "master" | "delivery" | "compat";

export type ContainerId = "mp4" | "webm";

export interface CodecIntentSpec {
  id: CodecIntent;
  label: string;
  description: string;
  /** Ordre de préférence, du meilleur au repli. */
  preference: VideoCodec[];
  /** 0 = tout en images clés (intra pur, montage image par image). */
  keyFrameInterval: number;
  quality: "very-high" | "high" | "medium";
}

export const CODEC_INTENTS: Record<CodecIntent, CodecIntentSpec> = {
  copy: {
    id: "copy",
    label: "Copie directe",
    description: "Remultiplexage sans réencodage. Zéro perte de génération.",
    preference: [],
    keyFrameInterval: 0,
    quality: "very-high",
  },
  mezzanine: {
    id: "mezzanine",
    label: "Mezzanine intra",
    description: "Toutes les images en clé, débit élevé. Pour le montage et l'étalonnage.",
    preference: ["hevc", "avc", "av1", "vp9"],
    keyFrameInterval: 0,
    quality: "very-high",
  },
  master: {
    id: "master",
    label: "Master",
    description: "Qualité maximale à taille raisonnable. Pour l'archivage d'un rendu final.",
    preference: ["av1", "hevc", "vp9", "avc"],
    keyFrameInterval: 2,
    quality: "very-high",
  },
  delivery: {
    id: "delivery",
    label: "Diffusion",
    description: "Meilleur rapport qualité/poids pour la mise en ligne.",
    preference: ["av1", "hevc", "vp9", "avc", "vp8"],
    keyFrameInterval: 5,
    quality: "high",
  },
  compat: {
    id: "compat",
    label: "Compatibilité",
    description: "H.264 en MP4. Lisible à peu près partout, y compris sur du matériel ancien.",
    preference: ["avc", "vp8", "vp9"],
    keyFrameInterval: 5,
    quality: "high",
  },
};

/** Conteneurs acceptant chaque codec, par ordre de préférence. */
const CONTAINERS: Record<VideoCodec, ContainerId[]> = {
  avc: ["mp4"],
  hevc: ["mp4"],
  av1: ["mp4", "webm"],
  vp9: ["webm", "mp4"],
  vp8: ["webm"],
  prores: ["mp4"],
};

export const CODEC_LABELS: Record<VideoCodec, string> = {
  av1: "AV1",
  hevc: "HEVC / H.265",
  avc: "H.264 / AVC",
  vp9: "VP9",
  vp8: "VP8",
  prores: "ProRes",
};

export interface CodecPlan {
  codec: VideoCodec;
  container: ContainerId;
  mimeType: string;
  extension: string;
  keyFrameInterval: number;
  quality: "very-high" | "high" | "medium";
  intent: CodecIntent;
  /** Codecs écartés, avec la raison — affiché tel quel dans l'interface. */
  rejected: string[];
}

export function webCodecsAvailable(): boolean {
  return typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";
}

function containerFor(codec: VideoCodec): ContainerId {
  return CONTAINERS[codec][0];
}

function mimeFor(container: ContainerId, codec: VideoCodec): string {
  return container === "mp4" ? `video/mp4; codecs=${codec}` : `video/webm; codecs=${codec}`;
}

/**
 * Interroge réellement le navigateur pour la taille et la cadence visées.
 * Un codec listé ici est un codec que cette machine sait encoder maintenant.
 */
export async function negotiateCodec(
  intent: CodecIntent,
  width: number,
  height: number,
  frameRate: number,
): Promise<CodecPlan | null> {
  if (intent === "copy") return null;

  const spec = CODEC_INTENTS[intent];
  const { getEncodableVideoCodecs, QUALITY_HIGH, QUALITY_MEDIUM, QUALITY_VERY_HIGH } =
    await import("mediabunny");

  const quality =
    spec.quality === "very-high" ? QUALITY_VERY_HIGH : spec.quality === "high" ? QUALITY_HIGH : QUALITY_MEDIUM;

  const encodable = await getEncodableVideoCodecs(spec.preference, {
    width,
    height,
    quality,
    frameRate,
  });

  const rejected = spec.preference
    .filter((codec) => !encodable.includes(codec))
    .map((codec) => `${CODEC_LABELS[codec]} : non encodable en ${width}×${height} sur ce navigateur`);

  const chosen = spec.preference.find((codec) => encodable.includes(codec));
  if (!chosen) return null;

  const container = containerFor(chosen);

  return {
    codec: chosen,
    container,
    mimeType: mimeFor(container, chosen),
    extension: container === "mp4" ? "mp4" : "webm",
    keyFrameInterval: spec.keyFrameInterval,
    quality: spec.quality,
    intent,
    rejected,
  };
}

/** Inventaire complet, pour afficher honnêtement ce que la machine sait faire. */
export async function codecInventory(
  width: number,
  height: number,
  frameRate: number,
): Promise<{ codec: VideoCodec; label: string; container: ContainerId }[]> {
  const { getEncodableVideoCodecs, QUALITY_HIGH } = await import("mediabunny");
  const all: VideoCodec[] = ["av1", "hevc", "vp9", "avc", "vp8"];
  const encodable = await getEncodableVideoCodecs(all, {
    width,
    height,
    quality: QUALITY_HIGH,
    frameRate,
  });

  return encodable.map((codec) => ({
    codec,
    label: CODEC_LABELS[codec],
    container: containerFor(codec),
  }));
}
