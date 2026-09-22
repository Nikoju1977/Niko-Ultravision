import { calculateOutputSize, type Size, type TargetId } from "./geometry";
import { PROFILES, type ProfileId } from "./profiles";
import { enhanceVideoWithRecorder } from "./videoRecorderFallback";
import { measureCanvasSharpness } from "./finalSharpen";
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
const OUTPUT_PAGE_SIZE = 4 * 1024 * 1024;
const STALL_TIMEOUT_MS = 30_000;

function isAndroidRuntime(): boolean {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
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

function orderPlansForRuntime(plans: CodecPlan[]): CodecPlan[] {
  if (!isAndroidRuntime()) return plans;
  const weight: Record<string, number> = {
    avc: 0,
    hevc: 1,
    vp9: 2,
    av1: 3,
    vp8: 4,
  };
  return [...plans].sort((a, b) => (weight[a.codec] ?? 99) - (weight[b.codec] ?? 99));
}

/**
 * Évite BufferTarget pour les vidéos : BufferTarget fait grossir un ArrayBuffer
 * contigu et peut tuer l'onglet Android quand le fichier devient volumineux.
 * StreamTarget écrit ici dans des pages fixes de 4 Mio, avec support des
 * réécritures aléatoires nécessaires au MP4 standard.
 */
function createPagedStreamTarget(StreamTargetCtor: new (
  writable: WritableStream<unknown>,
  options?: { chunked?: boolean; chunkSize?: number },
) => unknown) {
  const pages: Uint8Array[] = [];
  let logicalSize = 0;

  const writable = new WritableStream<unknown>({
    write(rawChunk) {
      const chunk = rawChunk as { data: Uint8Array; position: number };
      const data = chunk.data;
      let sourceOffset = 0;
      let position = chunk.position;
      logicalSize = Math.max(logicalSize, position + data.byteLength);

      while (sourceOffset < data.byteLength) {
        const pageIndex = Math.floor(position / OUTPUT_PAGE_SIZE);
        const pageOffset = position % OUTPUT_PAGE_SIZE;
        let page = pages[pageIndex];
        if (!page) {
          page = new Uint8Array(OUTPUT_PAGE_SIZE);
          pages[pageIndex] = page;
        }

        const copyLength = Math.min(
          data.byteLength - sourceOffset,
          OUTPUT_PAGE_SIZE - pageOffset,
        );
        page.set(data.subarray(sourceOffset, sourceOffset + copyLength), pageOffset);
        sourceOffset += copyLength;
        position += copyLength;
      }
    },
  });

  const target = new StreamTargetCtor(writable, {
    chunked: true,
    chunkSize: 1024 * 1024,
  });

  const toBlob = (mimeType: string): Blob => {
    const parts: BlobPart[] = [];
    let remaining = logicalSize;
    for (const page of pages) {
      if (remaining <= 0) break;
      const used = Math.min(remaining, page.byteLength);
      const copy = page.slice(0, used);
      parts.push(copy.buffer);
      remaining -= used;
    }
    return new Blob(parts, { type: mimeType });
  };

  return {
    target,
    toBlob,
    getSize: () => logicalSize,
  };
}

/**
 * Traitement spatial léger et déterministe pour la vidéo.
 *
 * Les paramètres ne changent pas d'une image à l'autre afin d'éviter le
 * pompage temporel. Le travail de micro-contraste est plafonné à 1440 px sur
 * le grand côté, puis rééchantillonné vers la cible.
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
  let measuredFrames = 0;
  let sharpnessBeforeSum = 0;
  let sharpnessAfterSum = 0;

  const process = (sample: {
    displayWidth: number;
    displayHeight: number;
    draw: (
      ctx: CanvasRenderingContext2D,
      x: number,
      y: number,
      w?: number,
      h?: number,
    ) => void;
  }) => {
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

      if (!workCtx || !edgeCtx) {
        throw new Error("Canvas 2D indisponible pour le traitement vidéo.");
      }
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

    const shouldMeasure = measuredFrames < 2;
    const beforeMeasure = shouldMeasure ? measureCanvasSharpness(workCanvas!) : null;

    if (preset.sharpen > 0.01 && workWidth * workHeight <= 2_200_000) {
      const fineAlpha =
        profile === "detail"
          ? 0.16
          : profile === "cinema"
            ? 0.11
            : profile === "fidelity"
              ? 0.09
              : 0.055;
      const coarseAlpha = fineAlpha * 0.42;

      // Passe fine : contours et micro-textures.
      edgeCtx!.save();
      edgeCtx!.globalAlpha = 1;
      edgeCtx!.globalCompositeOperation = "source-over";
      edgeCtx!.filter = "none";
      edgeCtx!.clearRect(0, 0, workWidth, workHeight);
      edgeCtx!.drawImage(workCanvas!, 0, 0);
      edgeCtx!.globalCompositeOperation = "difference";
      edgeCtx!.filter = "blur(0.55px)";
      edgeCtx!.drawImage(workCanvas!, 0, 0);
      edgeCtx!.restore();

      workCtx!.save();
      workCtx!.globalCompositeOperation = "lighter";
      workCtx!.globalAlpha = fineAlpha;
      workCtx!.filter = "none";
      workCtx!.drawImage(edgeCanvas!, 0, 0);
      workCtx!.restore();

      // Passe moyenne : sensation de mise au point sans forcer les très hautes fréquences.
      edgeCtx!.save();
      edgeCtx!.globalAlpha = 1;
      edgeCtx!.globalCompositeOperation = "source-over";
      edgeCtx!.filter = "none";
      edgeCtx!.clearRect(0, 0, workWidth, workHeight);
      edgeCtx!.drawImage(workCanvas!, 0, 0);
      edgeCtx!.globalCompositeOperation = "difference";
      edgeCtx!.filter = "blur(1.25px)";
      edgeCtx!.drawImage(workCanvas!, 0, 0);
      edgeCtx!.restore();

      workCtx!.save();
      workCtx!.globalCompositeOperation = "lighter";
      workCtx!.globalAlpha = coarseAlpha;
      workCtx!.filter = "none";
      workCtx!.drawImage(edgeCanvas!, 0, 0);
      workCtx!.restore();
    }

    outCtx!.save();
    outCtx!.globalAlpha = 1;
    outCtx!.globalCompositeOperation = "source-over";
    outCtx!.filter =
      profile === "detail"
        ? "contrast(1.025)"
        : profile === "cinema"
          ? "contrast(1.015)"
          : profile === "fidelity"
            ? "contrast(1.01)"
            : "none";
    outCtx!.clearRect(0, 0, output.width, output.height);
    outCtx!.imageSmoothingEnabled = true;
    outCtx!.imageSmoothingQuality = "high";
    outCtx!.drawImage(workCanvas!, 0, 0, output.width, output.height);
    outCtx!.restore();

    if (beforeMeasure) {
      const afterMeasure = measureCanvasSharpness(outCanvas!);
      sharpnessBeforeSum += beforeMeasure.edgeEnergy;
      sharpnessAfterSum += afterMeasure.edgeEnergy;
      measuredFrames += 1;
    }

    return outCanvas!;
  };

  return {
    process,
    stats: () => ({
      samples: measuredFrames,
      before: measuredFrames ? sharpnessBeforeSum / measuredFrames : 0,
      after: measuredFrames ? sharpnessAfterSum / measuredFrames : 0,
    }),
  };
}

async function executeWithStallGuard(
  conversion: {
    state: string;
    onProgress?: (value: number, processedTime: number) => unknown;
    execute: () => Promise<void>;
    cancel: () => Promise<void>;
  },
  onProgress: EnhanceVideoOptions["onProgress"],
  label: string,
): Promise<void> {
  let lastActivity = Date.now();
  let stalled = false;

  conversion.onProgress = (value) => {
    lastActivity = Date.now();
    onProgress?.(0.06 + Math.min(0.92, value) * 0.9, label);
  };

  const timer = window.setInterval(() => {
    if (
      conversion.state === "executing" &&
      Date.now() - lastActivity > STALL_TIMEOUT_MS
    ) {
      stalled = true;
      void conversion.cancel();
    }
  }, 1500);

  try {
    onProgress?.(0.05, label);
    await conversion.execute();
  } catch (reason) {
    if (stalled) {
      throw new Error(
        "encodeur bloqué plus de 30 s sans progression ; essai automatique du codec ou de la définition suivante",
      );
    }
    throw reason;
  } finally {
    window.clearInterval(timer);
  }
}

async function executeWebCodecsAttempt(
  file: File,
  probe: Probe,
  outputSize: Size,
  profile: ProfileId,
  plan: CodecPlan,
  onProgress: EnhanceVideoOptions["onProgress"],
  enhanceFrames: boolean,
): Promise<VideoEnhanceResult> {
  const {
    ALL_FORMATS,
    BlobSource,
    Conversion,
    Input,
    Mp4OutputFormat,
    Output,
    QUALITY_HIGH,
    QUALITY_VERY_HIGH,
    StreamTarget,
    WebMOutputFormat,
  } = await import("mediabunny");

  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const paged = createPagedStreamTarget(StreamTarget as unknown as new (
    writable: WritableStream<unknown>,
    options?: { chunked?: boolean; chunkSize?: number },
  ) => unknown);

  const out = new Output({
    format:
      plan.container === "mp4"
        ? new Mp4OutputFormat()
        : new WebMOutputFormat(),
    target: paged.target as never,
  });

  const processor = enhanceFrames ? createFrameProcessor(profile, outputSize) : null;
  const quality = plan.quality === "very-high" ? QUALITY_VERY_HIGH : QUALITY_HIGH;

  const videoOptions = processor
    ? {
        width: outputSize.width,
        height: outputSize.height,
        fit: "fill" as const,
        codec: plan.codec,
        quality,
        keyFrameInterval: plan.keyFrameInterval,
        hardwareAcceleration: isAndroidRuntime() ? ("prefer-hardware" as const) : ("no-preference" as const),
        forceTranscode: true,
        processedWidth: outputSize.width,
        processedHeight: outputSize.height,
        process: processor.process,
      }
    : {
        width: outputSize.width,
        height: outputSize.height,
        fit: "fill" as const,
        codec: plan.codec,
        quality,
        keyFrameInterval: plan.keyFrameInterval,
        hardwareAcceleration: isAndroidRuntime() ? ("prefer-hardware" as const) : ("no-preference" as const),
        forceTranscode: true,
      };

  const conversion = await Conversion.init({
    input,
    output: out,
    showWarnings: false,
    copy: false,
    video: videoOptions,
    audio: {},
  });

  if (!conversion.isValid) {
    const reasons = conversion.discardedTracks
      .map((entry) => `${entry.track.type} : ${entry.reason}`)
      .join(" ; ");
    throw new Error(`conversion invalide${reasons ? ` (${reasons})` : ""}`);
  }

  const modeLabel = processor ? "amélioration" : "compatibilité";
  const label =
    `Encodage ${plan.codec.toUpperCase()} · ${outputSize.width}×${outputSize.height} · ` +
    `${Math.round(normalizeFrameRate(probe.frameRate))} i/s · ${modeLabel}`;

  await executeWithStallGuard(conversion, onProgress, label);

  const mimeType = plan.container === "mp4" ? "video/mp4" : "video/webm";
  if (paged.getSize() <= 0) throw new Error("l'encodeur n'a produit aucune donnée");
  const blob = paged.toBlob(mimeType);

  const audioPreserved = conversion.utilizedTracks.some((track) => track.type === "audio");
  const notes: string[] = [plan.rationale];

  if (processor) {
    const stats = processor.stats();
    notes.push(
      "Netteté Pro v2 active : double échelle de micro-contraste, finition perceptuelle après upscale et traitement temporel stable.",
    );
    if (stats.samples > 0 && stats.before > 0) {
      const gain = ((stats.after - stats.before) / stats.before) * 100;
      notes.push(
        "Validation netteté (échantillon normalisé) : " +
          (stats.before * 100).toFixed(2) + " % → " +
          (stats.after * 100).toFixed(2) + " % (" +
          (gain >= 0 ? "+" : "") + gain.toFixed(1) + " %).",
      );
    }
  } else {
    notes.push(
      "Mode compatibilité vidéo : transcodage et redimensionnement sans filtre Canvas avancé.",
    );
  }

  if (isAndroidRuntime()) {
    notes.push(
      "Mode Android : priorité au H.264/AVC et à l'accélération matérielle quand le navigateur l'expose.",
    );
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
    Conversion,
    Input,
    Mp4OutputFormat,
    Output,
    StreamTarget,
  } = await import("mediabunny");

  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const paged = createPagedStreamTarget(StreamTarget as unknown as new (
    writable: WritableStream<unknown>,
    options?: { chunked?: boolean; chunkSize?: number },
  ) => unknown);

  const out = new Output({
    format: new Mp4OutputFormat(),
    target: paged.target as never,
  });

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

  await executeWithStallGuard(
    conversion,
    onProgress,
    "Remultiplexage sans réencodage",
  );

  if (paged.getSize() <= 0) {
    throw new Error("le remultiplexage n'a produit aucune donnée");
  }

  const audioPreserved = conversion.utilizedTracks.some((track) => track.type === "audio");
  const blob = paged.toBlob("video/mp4");

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

  if (isAndroidRuntime()) {
    notes.push(
      "Sécurité Android active : sortie paginée en mémoire, surveillance des encodeurs bloqués et replis automatiques.",
    );
  }

  if (pureCopy) {
    try {
      const copied = await attemptPureCopy(file, probe, onProgress);
      if (!probe.frameRateDetected) {
        copied.notes.push(
          "Cadence source non lisible : valeur de compatibilité 30 i/s affichée.",
        );
      }
      copied.notes = [...notes, ...copied.notes];
      onProgress?.(1, "Terminé");
      return copied;
    } catch (reason) {
      notes.push(
        `Copie directe impossible : ${errorMessage(reason)}. Réencodage de secours activé.`,
      );
    }
  } else if (wantsCopy) {
    notes.push(
      "Copie directe demandée mais un redimensionnement ou un traitement d'image est actif : réencodage nécessaire.",
    );
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
      plans = orderPlansForRuntime(
        await negotiateCodecCandidates(
          effectiveIntent,
          outputSize.width,
          outputSize.height,
          frameRate,
        ),
      );
    } catch (reason) {
      notes.push(
        `Détection codec ${candidateTarget} impossible : ${errorMessage(reason)}.`,
      );
      continue;
    }

    if (!plans.length) {
      notes.push(
        `Aucun codec WebCodecs encodable/muxable pour ${outputSize.width}×${outputSize.height} à ${Math.round(frameRate)} i/s.`,
      );
      continue;
    }

    for (const plan of plans) {
      const heavyAndroidTarget =
        isAndroidRuntime() && Math.max(outputSize.width, outputSize.height) > 2048;
      // Netteté Pro v2 : même en 4K Android, on tente d'abord le vrai
      // traitement amélioré. Le chemin sans filtre reste uniquement un repli.
      const modes = heavyAndroidTarget ? [true, false] : [true, false];

      for (const enhanceFrames of modes) {
        try {
          const result = await executeWebCodecsAttempt(
            file,
            probe,
            outputSize,
            profile,
            plan,
            onProgress,
            enhanceFrames,
          );

          if (candidateTarget !== target) {
            notes.push(
              `La cible ${target} a été ramenée automatiquement à ${candidateTarget} après échec des encodeurs à la définition supérieure.`,
            );
          }

          if (!enhanceFrames) {
            notes.push(
              "Le filtre avancé a été désactivé pour obtenir une sortie vidéo fiable sur cet appareil.",
            );
          }

          if (!probe.frameRateDetected) {
            notes.push(
              "Cadence source non lisible dans le conteneur : 30 i/s retenus par compatibilité.",
            );
          }

          result.notes = [...notes, ...result.notes, ...plan.rejected];
          onProgress?.(1, "Terminé");
          return result;
        } catch (reason) {
          notes.push(
            `${plan.codec.toUpperCase()} /${plan.container.toUpperCase()} ${outputSize.width}×${outputSize.height} ${enhanceFrames ? "avec filtre" : "sans filtre"} refusé : ${errorMessage(reason)}.`,
          );
        }
      }
    }
  }

  notes.push(
    "Tous les encodeurs WebCodecs ont échoué ou se sont bloqués : tentative finale via MediaRecorder.",
  );
  onProgress?.(0.01, "Repli final MediaRecorder");

  const recorderTarget: TargetId =
    target === "8k" || target === "16k" || (isAndroidRuntime() && target === "4k")
      ? "2k"
      : target;

  try {
    const legacy = await enhanceVideoWithRecorder(
      file,
      recorderTarget,
      profile,
      onProgress,
    );
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
      `Aucun pipeline vidéo local n'a abouti. Dernière erreur : ${errorMessage(reason)}. Essaie une cible 1080p si le navigateur Android manque de mémoire ou refuse l'encodeur.`,
    );
  }
}
