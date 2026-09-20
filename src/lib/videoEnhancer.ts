import { calculateOutputSize, megapixels, type Size, type TargetId } from "./geometry";
import { PROFILES, type ProfileId } from "./profiles";

export interface VideoEnhanceResult {
  blob: Blob;
  size: Size;
  mimeType: string;
  audioPreserved: boolean;
}

function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("error", onError);
    };
    const onLoaded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Impossible de lire les métadonnées vidéo."));
    };
    video.addEventListener("loadedmetadata", onLoaded, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

function chooseMimeType(): string {
  const choices = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4",
  ];
  return choices.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

function videoBitrate(size: Size): number {
  const mp = megapixels(size);
  if (mp >= 8) return 24_000_000;
  if (mp >= 3.5) return 14_000_000;
  return 8_000_000;
}

export async function enhanceVideo(
  file: File,
  target: TargetId,
  profile: ProfileId,
  onProgress?: (value: number, label: string) => void,
): Promise<VideoEnhanceResult> {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("MediaRecorder n'est pas disponible sur ce navigateur.");
  }

  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.src = url;
  video.preload = "auto";
  video.playsInline = true;
  await waitForMetadata(video);

  const output = calculateOutputSize(video.videoWidth, video.videoHeight, target);
  if (Math.max(output.width, output.height) > 3840 || output.width * output.height > 9_000_000) {
    URL.revokeObjectURL(url);
    throw new Error("Le traitement vidéo local est limité à 4K pour rester fiable dans le navigateur.");
  }

  const canvas = document.createElement("canvas");
  canvas.width = output.width;
  canvas.height = output.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    URL.revokeObjectURL(url);
    throw new Error("Canvas 2D indisponible.");
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.filter = PROFILES[profile].filter;

  const stream = canvas.captureStream(30);
  let audioContext: AudioContext | null = null;
  let audioPreserved = false;

  try {
    const AudioContextCtor = window.AudioContext;
    if (AudioContextCtor) {
      audioContext = new AudioContextCtor();
      const source = audioContext.createMediaElementSource(video);
      const destination = audioContext.createMediaStreamDestination();
      source.connect(destination);
      destination.stream.getAudioTracks().forEach((track) => stream.addTrack(track));
      audioPreserved = destination.stream.getAudioTracks().length > 0;
      await audioContext.resume();
    }
  } catch {
    audioPreserved = false;
    audioContext = null;
  }

  const mimeType = chooseMimeType();
  const recorder = new MediaRecorder(stream, {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond: videoBitrate(output),
    audioBitsPerSecond: 192_000,
  });
  const chunks: BlobPart[] = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  });

  const finished = new Promise<void>((resolve, reject) => {
    recorder.addEventListener("stop", () => resolve(), { once: true });
    recorder.addEventListener("error", () => reject(new Error("Erreur d'encodage vidéo.")), { once: true });
  });

  const drawFrame = () => {
    if (video.ended || video.paused) return;
    ctx.drawImage(video, 0, 0, output.width, output.height);
    const progress = video.duration ? Math.min(0.98, video.currentTime / video.duration) : 0;
    onProgress?.(progress, "Traitement vidéo local");

    if ("requestVideoFrameCallback" in video) {
      video.requestVideoFrameCallback(() => drawFrame());
    } else {
      requestAnimationFrame(drawFrame);
    }
  };

  video.addEventListener(
    "ended",
    () => {
      if (recorder.state !== "inactive") recorder.stop();
    },
    { once: true },
  );

  onProgress?.(0.01, "Préparation de la vidéo");
  recorder.start(1000);
  await video.play();
  drawFrame();
  await finished;

  const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "video/webm" });
  stream.getTracks().forEach((track) => track.stop());
  if (audioContext) await audioContext.close();
  URL.revokeObjectURL(url);
  onProgress?.(1, "Terminé");

  return {
    blob,
    size: output,
    mimeType: blob.type,
    audioPreserved,
  };
}
