import { calculateOutputSize, type Size, type TargetId } from "./geometry";
import { PROFILES, type ProfileId } from "./profiles";
import { enhanceVideoWithRecorder } from "./videoRecorderFallback";
import {
  negotiateCodecCandidates,
  webCodecsAvailable,
  type CodecIntent,
  type CodecPlan,
} from "./videoCodec";

export type VideoPipeline = "webcodecs" | "recorder";

export interface VideoEnhanceResult {
  blob: Blob;
  size: Size;
  mimeType: string;
  audioPreserved: boolean;
  frameRate: number;
  frameRateDetected: boolean;
  pipeline: VideoPipeline;
  plan: CodecPlan | null;
  /** true quand les paquets ont été recopiés sans réencodage. */
  streamCopied: boolean;
  notes: string[];
}

export interface EnhanceVideoOptions {
  intent?: CodecIntent;
  onProgress?: (value: number, label: string) => void;
}

type Probe = Awaited<ReturnType<typeof inspectWithMediabunny>>;

const VIDEO_FALLBACK_ORDER: TargetId[] = ["original", "1080p", "2k", "4k", "8k"];

/** Lit les dimensions et la cadence directement dans le conteneur, sans lecture temps réel. */
async function inspectWithMediabunny(file: File) {
  const { ALL_FORMATS, BlobSource, Input } = await import("mediabunny");
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });

  if (!(await input.canRead())) {
    throw new Error("Format de conteneur non reconnu par le démultiplexeur local.");
  }

  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("Aucune piste vidéo dans ce fichier.");

  const audioTrack = await input.getPrimaryAudioTrack();

  let frameRate = 0;
  let frameRateDetected = false;
  try {
    const stats = await track.computePacketStats(120);
    if (stats && Number.isFinite(stats.averagePacketRate) && stats.averagePacketRate > 0) {
      frameRate = stats.averagePacketRate;
      frameRateDetected = true;
    }
  } catch {
    frameRate = 0;
  }

  return {
    track,
    hasAudio: Boolean(audioTrack),
    width: track.displayWidth,
    height: track.displayHeight,
    frameRate: frameRateDetected ? frameRate : 30,
    frameRateDetected,
  };
}

function normalizeFrameRate(value: number): number {
  if (!Number.isFinite(value) || value < 8) return 30;
  const standards = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 100, 120];
  const nearest = standards.reduce((best, candidate) =>
    Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best,
  );
  return Math.abs(nearest - value) / value <= 0.02 ? nearest : Math.round(value * 1000) / 1000;
}

function fallbackTargets(requested: TargetId): TargetId[] {
  const index = VIDEO_FALLBACK_ORDER.indexOf(requested);
  if (index < 0) return ["8k", "4k", "2k", "1080p", "original"];
  const result: TargetId[] = [];
  for (let i = index; i >= 0; i -= 1) result.push(VIDEO_FALLBACK_ORDER[i]);
  return result;
}

function sameSize(a: Size, b: Size): boolean {
  return a.width === b.width && a.height === b.height;
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) return reason.message;
  return String(reason || "erreur inconnue");
}

/**
 * Traitement spatial léger et déterministe pour la vidéo.
 *
 * Le traitement est volontairement stable d'une image à l'autre : mêmes
 * paramètres, pas de seuil adaptatif qui pourrait provoquer du pompage.
 * L'accentuation est calculée à une définition de travail plafonnée puis le
 * résultat est rééchantillonné vers la cible avec un filtrage haute qualité.
 */
function createFrameProcessor(profile: ProfileId, output: Size) {
  const preset = PROFILES[profile];
  const shouldProcess = preset.filter !== "none" || preset.sharpen >= 0.08;
  if (!shouldProcess) return null;

  let workCanvas: HTMLCanvasElement | null = null;
  let edgeCanvas: HTMLCanvasElement | null = null;
  let outCanvas: HTMLCanvasElement | null = null;
  let workCtx: CanvasRenderingContext2D | null = null;
  let edgeCtx: CanvasRenderingContext2D | null = null;
  let outCtx: CanvasRenderingContext2D | null = null;

  return (sample: { displayWidth: number; displayHeight: number; draw: (ctx: CanvasRenderingContext2D, x: number, y: number, w?: number, h?: number) => void }) => {
    const sourceLong = Math.max(sample.displayWidth, sample.displayHeight);
    const workLong = Math.min(sourceLong, 1440);
    const scale = workLong / Math.max(1, sourceLong);
    const workWidth = Math.max(2, Math.round(sample.displayWidth * scale));
    const workHeight = Math.max(2, Math.round(sample.displayHeight * scale));

    if (!workCanvas || workCanvas.width !== workWidth || workCanvas.height !== workHeight) {
      workCanvas = document.createElement("canvas");
      workCanvas.width = workWidth;
      workCanvas.height = workHeight;
      workCtx = workCanvas.getContext("2d");

      edgeCanvas = document.createElement("canvas");
      edgeCanvas.width = workWidth;
      edgeCanvas.height = workHeight;
      edgeCtx = edgeCanvas.getContext("2d");

      if (!workCtx || !edgeCtx) throw new Error("Canvas 2D indisponible pour le traitement vidéo.");
    }

    if (!outCanvas || outCanvas.width !== output.width || outCanvas.height !== output.height) {
      outCanvas = document.createElement("canvas");
      outCanvas.width = output.width;
      outCanvas.height = output.height;
      outCtx = outCanvas.getContext("2d");
      if (!outCtx) throw new Error("Canvas 2D indisponible pour la sortie vidéo.");
    }

    workCtx!.save();
    workCtx!.globalAlpha = 1;
    workCtx!.globalCompositeOperation = "source-over";
    workCtx!.filter = preset.filter;
    workCtx!.clearRect(0, 0, workWidth, workHeight);
    workCtx!.imageSmoothingEnabled = true;
    workCtx!.imageSmoothingQuality = "high";
    sample.draw(workCtx!, 0, 0, workWidth, workHeight);
    workCtx!.restore();

    if (preset.sharpen > 0.01 && workWidth * workHeight <= 2_200_000) {
      edgeCtx!.save();
      edgeCtx!.globalAlpha = 1;
      edgeCtx!.globalCompositeOperation = "source-over";
      edgeCtx!.filter = "none";
      edgeCtx!.clearRect(0, 0, workWidth, workHeight);
      edgeCtx!.drawImage(workCanvas!, 0, 0);
      edgeCtx!.globalCompositeOperation = "difference";
      edgeCtx!.filter = "blur(0.75px)";
      edgeCtx!.drawImage(workCanvas!, 0, 0);
      edgeCtx!.restore();

      workCtx!.save();
      workCtx!.globalCompositeOperation = "lighter";
      workCtx!.globalAlpha = Math.min(0.1, Math.max(0.02, preset.sharpen * 0.36));
      workCtx!.filter = "none";
      workCtx!.drawImage(edgeCanvas!, 0, 0);
      workCtx!.restore();
    }

    outCtx!.save();
    outCtx!.globalAlpha = 1;
    outCtx!.globalCompositeOperation = "source-over";
    outCtx!.filter = "none";
    outCtx!.clearRect(0, 0, output.width, output.height);
    outCtx!.imageSmoothingEnabled = true;
    outCtx!.imageSmoothingQuality = "high";
    outCtx!.drawImage(workCanvas!, 0, 0, output.width, output.height);
    outCtx!.restore();

    return outCanvas!;
  };
}

async function executeWebCodecsAttempt(
  file: File,
  probe: Probe,
  outputSize: Size,
  profile: ProfileId,
  plan: CodecPlan,
  onProgress: EnhanceVideoOptions["onProgress"],
): Promise<VideoEnhanceResult> {
  const {
    ALL_FORMATS,
    BlobSource,
    BufferTarget,
    Conversion,
    Input,
    Mp4OutputFormat,
    Output,
    QUALITY_HIGH,
    QUALITY_VERY_HIGH,
    WebMOutputFormat,
  } = await import("mediabunny");

  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const bufferTarget = new BufferTarget();
  const out = new Output({
    format: plan.container === "mp4" ? new Mp4OutputFormat() : new WebMOutputFormat(),
    target: bufferTarget,
  });

  const processor = createFrameProcessor(profile, outputSize);
  const videoOptions = processor
    ? {
        codec: plan.codec,
        quality: plan.quality === "very-high" ? QUALITY_VERY_HIGH : QUALITY_HIGH,
        keyFrameInterval: plan.keyFrameInterval,
        forceTranscode: true,
        processedWidth: outputSize.width,
        processedHeight: outputSize.height,
        process: processor,
      }
    : {
        width: outputSize.width,
        height: outputSize.height,
        fit: "fill" as const,
        codec: plan.codec,
        quality: plan.quality === "very-high" ? QUALITY_VERY_HIGH : QUALITY_HIGH,
        keyFrameInterval: plan.keyFrameInterval,
        forceTranscode: true,
      };

  const conversion = await Conversion.init({
    input,
    output: out,
    showWarnings: false,
    copy: { mode: "preferred" },
    video: videoOptions,
    audio: {},
  });

  if (!conversion.isValid) {
    const reasons = conversion.discardedTracks
      .map((entry) => `${entry.track.type} : ${entry.reason}`)
      .join(" ; ");
    throw new Error(`conversion invalide${reasons ? ` (${reasons})` : ""}`);
  }

  const label = `Encodage ${plan.codec.toUpperCase()} · ${outputSize.width}×${outputSize.height} · ${Math.round(normalizeFrameRate(probe.frameRate))} i/s`;
  conversion.onProgress = (value) => {
    onProgress?.(0.06 + Math.min(0.92, value) * 0.9, label);
  };

  onProgress?.(0.05, label);
  await conversion.execute();

  const buffer = bufferTarget.buffer;
  if (!buffer || buffer.byteLength === 0) throw new Error("l'encodeur n'a produit aucune donnée");

  const audioPreserved = conversion.utilizedTracks.some((track) => track.type === "audio");
  const blob = new Blob([buffer], {
    type: plan.container === "mp4" ? "video/mp4" : "video/webm",
  });

  const notes: string[] = [plan.rationale];
  if (processor) {
    notes.push("Traitement vidéo image par image actif : micro-contraste stable, accentuation légère et rééchantillonnage haute qualité.");
  } else {
    notes.push("Traitement Fidelity : rééchantillonnage haute qualité sans accentuation artificielle.");
  }
  for (const discarded of conversion.discardedTracks) {
    notes.push(`Piste ${discarded.track.type} écartée : ${discarded.reason}`);
  }
  if (probe.hasAudio && !audioPreserved) {
    notes.push("La piste audio n'a pas pu être conservée dans ce conteneur.");
  }

  return {
    blob,
    size: outputSize,
    mimeType: blob.type,
    audioPreserved,
    frameRate: normalizeFrameRate(probe.frameRate),
    frameRateDetected: probe.frameRateDetected,
    pipeline: "webcodecs",
    plan,
    streamCopied: false,
    notes,
  };
}

async function attemptPureCopy(
  file: File,
  probe: Probe,
  onProgress: EnhanceVideoOptions["onProgress"],
): Promise<VideoEnhanceResult> {
  const {
    ALL_FORMATS,
    BlobSource,
    BufferTarget,
    Conversion,
    Input,
    Mp4OutputFormat,
    Output,
  } = await import("mediabunny");

  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const bufferTarget = new BufferTarget();
  const out = new Output({ format: new Mp4OutputFormat(), target: bufferTarget });

  const conversion = await Conversion.init({
    input,
    output: out,
    showWarnings: false,
    copy: { mode: "forced" },
    video: {},
    audio: {},
  });

  if (!conversion.isValid) {
    throw new Error("remultiplexage direct incompatible avec le conteneur MP4");
  }

  conversion.onProgress = (value) => {
    onProgress?.(0.05 + Math.min(0.94, value) * 0.92, "Remultiplexage sans réencodage");
  };
  await conversion.execute();

  const buffer = bufferTarget.buffer;
  if (!buffer || buffer.byteLength === 0) throw new Error("le remultiplexage n'a produit aucune donnée");

  const audioPreserved = conversion.utilizedTracks.some((track) => track.type === "audio");
  const blob = new Blob([buffer], { type: "video/mp4" });

  return {
    blob,
    size: { width: probe.width, height: probe.height },
    mimeType: blob.type,
    audioPreserved,
    frameRate: normalizeFrameRate(probe.frameRate),
    frameRateDetected: probe.frameRateDetected,
    pipeline: "webcodecs",
    plan: null,
    streamCopied: true,
    notes: ["Copie directe forcée : aucune recompression de la piste vidéo."],
  };
}

export async function enhanceVideo(
  file: File,
  target: TargetId,
  profile: ProfileId,
  options: EnhanceVideoOptions = {},
): Promise<VideoEnhanceResult> {
  const { intent = "master", onProgress } = options;

  if (!webCodecsAvailable()) {
    onProgress?.(0.01, "WebCodecs indisponible · repli MediaRecorder");
    const legacy = await enhanceVideoWithRecorder(file, target, profile, onProgress);
    return {
      ...legacy,
      pipeline: "recorder",
      plan: null,
      streamCopied: false,
      notes: [
        "WebCodecs absent de ce navigateur : encodage en temps réel via MediaRecorder.",
        "Des images peuvent être perdues si le rendu prend du retard, et la qualité n'est pas réglable finement.",
      ],
    };
  }

  onProgress?.(0.02, "Analyse du conteneur");
  const probe = await inspectWithMediabunny(file);
  const frameRate = normalizeFrameRate(probe.frameRate);
  const requestedSize = calculateOutputSize(probe.width, probe.height, target);
  const sourceSize = { width: probe.width, height: probe.height };
  const preset = PROFILES[profile];
  const filtering = preset.filter !== "none" || preset.sharpen > 0.01;
  const resizing = !sameSize(requestedSize, sourceSize);
  const wantsCopy = intent === "copy";
  const pureCopy = wantsCopy && !resizing && !filtering;
  const notes: string[] = [];

  if (pureCopy) {
    try {
      const copied = await attemptPureCopy(file, probe, onProgress);
      if (!probe.frameRateDetected) copied.notes.push("Cadence source non lisible : valeur de compatibilité 30 i/s affichée.");
      onProgress?.(1, "Terminé");
      return copied;
    } catch (reason) {
      notes.push(`Copie directe impossible : ${errorMessage(reason)}. Réencodage de secours activé.`);
    }
  } else if (wantsCopy) {
    notes.push("Copie directe demandée mais un redimensionnement ou un traitement d'image est actif : réencodage nécessaire.");
  }

  const effectiveIntent: CodecIntent = wantsCopy ? "master" : intent;
  const candidateTargets = fallbackTargets(target);

  for (const candidateTarget of candidateTargets) {
    const outputSize = calculateOutputSize(probe.width, probe.height, candidateTarget);
    onProgress?.(
      0.03,
      candidateTarget === target
        ? `Préparation ${outputSize.width}×${outputSize.height}`
        : `Repli ${candidateTarget} · ${outputSize.width}×${outputSize.height}`,
    );

    let plans: CodecPlan[] = [];
    try {
      plans = await negotiateCodecCandidates(effectiveIntent, outputSize.width, outputSize.height, frameRate);
    } catch (reason) {
      notes.push(`Détection codec ${candidateTarget} impossible : ${errorMessage(reason)}.`);
      continue;
    }

    if (!plans.length) {
      notes.push(`Aucun codec WebCodecs encodable/muxable pour ${outputSize.width}×${outputSize.height} à ${Math.round(frameRate)} i/s.`);
      continue;
    }

    for (const plan of plans) {
      try {
        const result = await executeWebCodecsAttempt(file, probe, outputSize, profile, plan, onProgress);
        if (candidateTarget !== target) {
          notes.push(
            `La cible ${target} a été ramenée automatiquement à ${candidateTarget} après échec des encodeurs à la définition supérieure.`,
          );
        }
        if (!probe.frameRateDetected) {
          notes.push("Cadence source non lisible dans le conteneur : 30 i/s retenus par compatibilité.");
        }
        result.notes = [...notes, ...result.notes, ...plan.rejected];
        onProgress?.(1, "Terminé");
        return result;
      } catch (reason) {
        notes.push(
          `${plan.codec.toUpperCase()} /${plan.container.toUpperCase()} ${outputSize.width}×${outputSize.height} refusé pendant l'encodage : ${errorMessage(reason)}.`,
        );
      }
    }
  }

  notes.push("Tous les encodeurs WebCodecs ont échoué : tentative finale via MediaRecorder.");
  onProgress?.(0.01, "Repli final MediaRecorder");

  const recorderTarget: TargetId = target === "8k" || target === "16k" ? "4k" : target;
  try {
    const legacy = await enhanceVideoWithRecorder(file, recorderTarget, profile, onProgress);
    return {
      ...legacy,
      pipeline: "recorder",
      plan: null,
      streamCopied: false,
      notes: [
        ...notes,
        "Repli MediaRecorder utilisé. Cette voie est moins précise que WebCodecs mais évite un échec total sur les appareils difficiles.",
      ],
    };
  } catch (reason) {
    throw new Error(
      `Aucun pipeline vidéo local n'a abouti. Dernière erreur : ${errorMessage(reason)}. Essaie une cible 1080p ou 2K si la mémoire/encodeur du téléphone est limitant.`,
    );
  }
}
