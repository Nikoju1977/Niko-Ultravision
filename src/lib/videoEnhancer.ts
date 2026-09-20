import { calculateOutputSize, type Size, type TargetId } from "./geometry";
import { PROFILES, type ProfileId } from "./profiles";
import { enhanceVideoWithRecorder } from "./videoRecorderFallback";
import {
  negotiateCodec,
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
    input,
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
  // Une cadence exotique assumée (timelapse, 144 i/s) est conservée telle quelle.
  return Math.abs(nearest - value) / value <= 0.02 ? nearest : Math.round(value * 1000) / 1000;
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
  const notes: string[] = [];

  const output = calculateOutputSize(probe.width, probe.height, target);
  const frameRate = normalizeFrameRate(probe.frameRate);
  const resizing = output.width !== probe.width || output.height !== probe.height;
  const filter = PROFILES[profile].filter;
  const filtering = filter !== "none";

  // Copie directe : ni redimensionnement ni filtre, donc aucune raison de réencoder.
  const wantsCopy = intent === "copy";
  if (wantsCopy && (resizing || filtering)) {
    notes.push(
      "Copie directe demandée mais un redimensionnement ou un filtre est actif : réencodage nécessaire.",
    );
  }
  const pureCopy = wantsCopy && !resizing && !filtering;

  let plan: CodecPlan | null = null;
  if (!pureCopy) {
    plan = await negotiateCodec(wantsCopy ? "master" : intent, output.width, output.height, frameRate);
    if (!plan) {
      throw new Error(
        `Aucun codec encodable par ce navigateur en ${output.width}×${output.height}. Réduis la définition cible.`,
      );
    }
    notes.push(plan.rationale);
    notes.push(...plan.rejected);
  }

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

  // L'Input de sondage a servi; on en ouvre un neuf pour la conversion.
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const container = plan?.container ?? "mp4";
  const bufferTarget = new BufferTarget();
  const out = new Output({
    format: container === "mp4" ? new Mp4OutputFormat() : new WebMOutputFormat(),
    target: bufferTarget,
  });

  let workCanvas: HTMLCanvasElement | null = null;
  let workCtx: CanvasRenderingContext2D | null = null;

  const conversion = await Conversion.init({
    input,
    output: out,
    showWarnings: false,
    video: pureCopy
      ? {}
      : {
          width: output.width,
          height: output.height,
          fit: "fill", // le ratio est déjà exact, aucun recadrage n'est introduit
          codec: plan!.codec,
          quality: plan!.quality === "very-high" ? QUALITY_VERY_HIGH : QUALITY_HIGH,
          keyFrameInterval: plan!.keyFrameInterval,
          ...(filtering
            ? {
                processedWidth: output.width,
                processedHeight: output.height,
                process: (sample) => {
                  if (!workCanvas || !workCtx) {
                    workCanvas = document.createElement("canvas");
                    workCanvas.width = output.width;
                    workCanvas.height = output.height;
                    workCtx = workCanvas.getContext("2d");
                    if (!workCtx) throw new Error("Canvas 2D indisponible pour le filtrage.");
                  }
                  workCtx.filter = filter;
                  workCtx.clearRect(0, 0, output.width, output.height);
                  sample.draw(workCtx, 0, 0, output.width, output.height);
                  return workCanvas;
                },
              }
            : {}),
        },
    audio: {},
  });

  if (!conversion.isValid) {
    const reasons = conversion.discardedTracks
      .map((entry) => `${entry.track.type} : ${entry.reason}`)
      .join(" ; ");
    throw new Error(`Conversion impossible (${reasons || "aucune piste exploitable"}).`);
  }

  for (const discarded of conversion.discardedTracks) {
    notes.push(`Piste ${discarded.track.type} écartée : ${discarded.reason}`);
  }

  const label = pureCopy
    ? "Remultiplexage sans réencodage"
    : `Encodage ${plan!.codec.toUpperCase()} · ${output.width}×${output.height} · ${Math.round(frameRate)} i/s`;

  conversion.onProgress = (value) => {
    onProgress?.(0.05 + Math.min(0.94, value) * 0.92, label);
  };

  onProgress?.(0.05, label);
  await conversion.execute();

  const buffer = bufferTarget.buffer;
  if (!buffer || buffer.byteLength === 0) throw new Error("L'encodeur n'a produit aucune donnée.");

  const audioPreserved = conversion.utilizedTracks.some((track) => track.type === "audio");
  const blob = new Blob([buffer], {
    type: container === "mp4" ? "video/mp4" : "video/webm",
  });

  if (!probe.frameRateDetected) {
    notes.push("Cadence source non lisible dans le conteneur : 30 i/s retenus par compatibilité.");
  }
  if (probe.hasAudio && !audioPreserved) {
    notes.push("La piste audio n'a pas pu être conservée dans ce conteneur.");
  }
  if (plan && plan.keyFrameInterval === 0) {
    notes.push("Toutes les images sont des images clés : fichier lourd, mais montage image par image exact.");
  }

  onProgress?.(1, "Terminé");

  return {
    blob,
    size: pureCopy ? { width: probe.width, height: probe.height } : output,
    mimeType: blob.type,
    audioPreserved,
    frameRate,
    frameRateDetected: probe.frameRateDetected,
    pipeline: "webcodecs",
    plan,
    streamCopied: pureCopy,
    notes,
  };
}
