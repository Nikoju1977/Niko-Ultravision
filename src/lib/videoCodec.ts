import type { VideoCodec } from "mediabunny";

/**
 * Négociation de codec à l'exécution.
 *
 * La détection combine deux contraintes :
 * 1) le codec doit être réellement encodable par le navigateur à la définition/cadence visée ;
 * 2) le conteneur choisi doit effectivement accepter ce codec.
 *
 * Le pipeline vidéo peut ensuite essayer plusieurs plans, dans l'ordre, si un
 * encodeur annoncé comme disponible échoue au moment de l'encodage réel.
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
    preference: ["avc", "vp9", "vp8"],
    keyFrameInterval: 5,
    quality: "high",
  },
};

/** Conteneurs souhaités pour chaque codec, par ordre de préférence. */
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
  /** Pourquoi ce codec a été retenu par le superviseur. */
  rationale: string;
  /** Codecs écartés, avec la raison — affiché tel quel dans l'interface. */
  rejected: string[];
}

export function webCodecsAvailable(): boolean {
  return typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";
}

function mimeFor(container: ContainerId): string {
  return container === "mp4" ? "video/mp4" : "video/webm";
}

function professionalPreference(
  intent: CodecIntent,
  width: number,
  height: number,
  frameRate: number,
): VideoCodec[] {
  const pixelsPerSecond = width * height * Math.max(1, frameRate);
  const isHeavy = pixelsPerSecond >= 3840 * 2160 * 50;

  if (intent === "mezzanine") {
    return ["hevc", "avc", "av1", "vp9"];
  }

  if (intent === "master") {
    return isHeavy ? ["hevc", "av1", "vp9", "avc"] : ["av1", "hevc", "vp9", "avc"];
  }

  if (intent === "delivery") {
    return ["av1", "hevc", "vp9", "avc", "vp8"];
  }

  if (intent === "compat") {
    return ["avc", "vp9", "vp8"];
  }

  return [];
}

function codecRationale(
  codec: VideoCodec,
  intent: CodecIntent,
  width: number,
  height: number,
  frameRate: number,
): string {
  const target = `${width}×${height} à ${Math.round(frameRate)} i/s`;

  switch (codec) {
    case "av1":
      return `AV1 retenu pour son excellente efficacité de compression en ${target}.`;
    case "hevc":
      return `HEVC retenu pour son bon équilibre qualité, débit et charge d'encodage en ${target}.`;
    case "avc":
      return intent === "mezzanine"
        ? `H.264 intra retenu pour une lecture/montage très compatible en ${target}.`
        : `H.264 retenu comme codec professionnel de compatibilité en ${target}.`;
    case "vp9":
      return `VP9 retenu comme repli haute efficacité en ${target}.`;
    case "vp8":
      return `VP8 retenu comme dernier repli WebM compatible en ${target}.`;
    default:
      return `${CODEC_LABELS[codec]} retenu en ${target}.`;
  }
}

async function supportedContainerMap(): Promise<Record<ContainerId, Set<VideoCodec>>> {
  const { Mp4OutputFormat, WebMOutputFormat } = await import("mediabunny");
  return {
    mp4: new Set(new Mp4OutputFormat().getSupportedVideoCodecs()),
    webm: new Set(new WebMOutputFormat().getSupportedVideoCodecs()),
  };
}

function chooseContainer(
  codec: VideoCodec,
  supported: Record<ContainerId, Set<VideoCodec>>,
): ContainerId | null {
  const candidates = CONTAINERS[codec] ?? [];
  return candidates.find((container) => supported[container].has(codec)) ?? null;
}

/**
 * Retourne tous les plans réellement encodables et muxables, dans l'ordre de
 * préférence. Le premier est le plan nominal ; les suivants sont les replis.
 */
export async function negotiateCodecCandidates(
  intent: CodecIntent,
  width: number,
  height: number,
  frameRate: number,
): Promise<CodecPlan[]> {
  if (intent === "copy") return [];

  const spec = CODEC_INTENTS[intent];
  const preference = professionalPreference(intent, width, height, frameRate);
  const {
    getEncodableVideoCodecs,
    QUALITY_HIGH,
    QUALITY_MEDIUM,
    QUALITY_VERY_HIGH,
  } = await import("mediabunny");

  const quality =
    spec.quality === "very-high"
      ? QUALITY_VERY_HIGH
      : spec.quality === "high"
        ? QUALITY_HIGH
        : QUALITY_MEDIUM;

  const encodable = await getEncodableVideoCodecs(preference, {
    width,
    height,
    quality,
    frameRate,
  });
  const supportedContainers = await supportedContainerMap();

  const rejected: string[] = [];
  for (const codec of preference) {
    if (!encodable.includes(codec)) {
      rejected.push(`${CODEC_LABELS[codec]} : non encodable en ${width}×${height} sur ce navigateur`);
      continue;
    }
    if (!chooseContainer(codec, supportedContainers)) {
      rejected.push(`${CODEC_LABELS[codec]} : aucun conteneur MP4/WebM compatible dans Mediabunny`);
    }
  }

  return preference.flatMap((codec) => {
    if (!encodable.includes(codec)) return [];
    const container = chooseContainer(codec, supportedContainers);
    if (!container) return [];

    return [{
      codec,
      container,
      mimeType: mimeFor(container),
      extension: container === "mp4" ? "mp4" : "webm",
      keyFrameInterval: spec.keyFrameInterval,
      quality: spec.quality,
      intent,
      rationale: codecRationale(codec, intent, width, height, frameRate),
      rejected,
    } satisfies CodecPlan];
  });
}

/** Retourne le premier plan nominal pour les écrans qui n'ont besoin que d'un choix. */
export async function negotiateCodec(
  intent: CodecIntent,
  width: number,
  height: number,
  frameRate: number,
): Promise<CodecPlan | null> {
  const plans = await negotiateCodecCandidates(intent, width, height, frameRate);
  return plans[0] ?? null;
}

/** Inventaire complet, filtré par encodabilité ET compatibilité conteneur. */
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
  const supportedContainers = await supportedContainerMap();

  return encodable.flatMap((codec) => {
    const container = chooseContainer(codec, supportedContainers);
    if (!container) return [];
    return [{ codec, label: CODEC_LABELS[codec], container }];
  });
}
