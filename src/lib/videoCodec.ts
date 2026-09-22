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


interface CodecProbeResult {
  ok: boolean;
  reason?: string;
}

const codecProbeCache = new Map<string, Promise<CodecProbeResult>>();
const CODEC_PROBE_TIMEOUT_MS = 8000;

function probeKey(
  codec: VideoCodec,
  container: ContainerId,
  width: number,
  height: number,
  frameRate: number,
): string {
  return [codec, container, width, height, Math.round(frameRate * 1000)].join(":");
}

async function withProbeTimeout<T>(
  promise: Promise<T>,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error("sonde d'encodage expirée"));
    }, CODEC_PROBE_TIMEOUT_MS);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function canPlayGeneratedBlob(blob: Blob): Promise<boolean> {
  const url = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;

  try {
    return await new Promise<boolean>((resolve) => {
      const finish = (value: boolean) => {
        clearTimeout(timer);
        video.removeEventListener("loadeddata", onLoaded);
        video.removeEventListener("error", onError);
        resolve(value);
      };
      const onLoaded = () => finish(video.videoWidth > 0 && video.videoHeight > 0);
      const onError = () => finish(false);
      const timer = setTimeout(() => finish(false), 3500);

      video.addEventListener("loadeddata", onLoaded, { once: true });
      video.addEventListener("error", onError, { once: true });
      video.src = url;
      video.load();
    });
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

/**
 * Sonde réelle : encode une image à la définition demandée, la muxe dans le
 * conteneur final, puis vérifie que le navigateur peut décoder le fichier créé.
 * On ne marque donc plus un codec comme "disponible" sur la seule foi d'une
 * déclaration WebCodecs.
 */
async function probeCodecPipeline(
  codec: VideoCodec,
  container: ContainerId,
  width: number,
  height: number,
  frameRate: number,
): Promise<CodecProbeResult> {
  const key = probeKey(codec, container, width, height, frameRate);
  const cached = codecProbeCache.get(key);
  if (cached) return cached;

  const running = (async (): Promise<CodecProbeResult> => {
    if (!webCodecsAvailable()) {
      return { ok: false, reason: "WebCodecs indisponible" };
    }

    const {
      BufferTarget,
      CanvasSource,
      Mp4OutputFormat,
      Output,
      QUALITY_MEDIUM,
      WebMOutputFormat,
    } = await import("mediabunny");

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx || canvas.width !== width || canvas.height !== height) {
      canvas.width = 1;
      canvas.height = 1;
      return { ok: false, reason: "canvas cible non allouable" };
    }

    // Motif non uniforme pour éviter qu'un encodeur optimise un frame vide
    // d'une manière non représentative.
    ctx.fillStyle = "#101820";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#e8edf5";
    ctx.fillRect(0, 0, Math.max(2, Math.floor(width / 8)), Math.max(2, Math.floor(height / 8)));

    const target = new BufferTarget();
    const format = container === "mp4" ? new Mp4OutputFormat() : new WebMOutputFormat();
    const output = new Output({ format, target });
    const source = new CanvasSource(canvas, {
      codec,
      quality: QUALITY_MEDIUM,
    });

    try {
      output.addVideoTrack(source, { frameRate });
      const work = (async () => {
        await output.start();
        await source.add(0, 1 / Math.max(1, frameRate), { keyFrame: true });
        source.close();
        await output.finalize();
      })();

      await withProbeTimeout(work, () => {
        void output.cancel();
      });

      const buffer = target.buffer;
      if (!buffer || buffer.byteLength === 0) {
        return { ok: false, reason: "aucune donnée muxée" };
      }

      const blob = new Blob([buffer], { type: mimeFor(container) });
      if (!(await canPlayGeneratedBlob(blob))) {
        return { ok: false, reason: "fichier test non décodable par ce navigateur" };
      }

      return { ok: true };
    } catch (reason) {
      try {
        await output.cancel();
      } catch {
        // Rien à faire : l'échec de la sonde suffit.
      }
      return {
        ok: false,
        reason: reason instanceof Error && reason.message ? reason.message : "échec de la sonde réelle",
      };
    } finally {
      canvas.width = 1;
      canvas.height = 1;
    }
  })();

  codecProbeCache.set(key, running);
  return running;
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
  const plans: CodecPlan[] = [];

  for (const codec of preference) {
    if (!encodable.includes(codec)) {
      rejected.push(`${CODEC_LABELS[codec]} : non annoncé comme encodable en ${width}×${height}`);
      continue;
    }

    const container = chooseContainer(codec, supportedContainers);
    if (!container) {
      rejected.push(`${CODEC_LABELS[codec]} : aucun conteneur MP4/WebM compatible dans Mediabunny`);
      continue;
    }

    const probe = await probeCodecPipeline(codec, container, width, height, frameRate);
    if (!probe.ok) {
      rejected.push(`${CODEC_LABELS[codec]} : sonde réelle refusée (${probe.reason ?? "raison inconnue"})`);
      continue;
    }

    plans.push({
      codec,
      container,
      mimeType: mimeFor(container),
      extension: container === "mp4" ? "mp4" : "webm",
      keyFrameInterval: spec.keyFrameInterval,
      quality: spec.quality,
      intent,
      rationale: codecRationale(codec, intent, width, height, frameRate),
      rejected,
    });
  }

  return plans;
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

/** Inventaire complet, validé par encode + mux + décodage local d'un fichier test. */
export async function codecInventory(
  width: number,
  height: number,
  frameRate: number,
): Promise<{ codec: VideoCodec; label: string; container: ContainerId; verified: true }[]> {
  const { getEncodableVideoCodecs, QUALITY_HIGH } = await import("mediabunny");
  const all: VideoCodec[] = ["avc", "hevc", "vp9", "av1", "vp8"];
  const encodable = await getEncodableVideoCodecs(all, {
    width,
    height,
    quality: QUALITY_HIGH,
    frameRate,
  });
  const supportedContainers = await supportedContainerMap();
  const verified: { codec: VideoCodec; label: string; container: ContainerId; verified: true }[] = [];

  for (const codec of all) {
    if (!encodable.includes(codec)) continue;
    const container = chooseContainer(codec, supportedContainers);
    if (!container) continue;

    const probe = await probeCodecPipeline(codec, container, width, height, frameRate);
    if (!probe.ok) continue;

    verified.push({
      codec,
      label: CODEC_LABELS[codec],
      container,
      verified: true,
    });
  }

  return verified;
}
