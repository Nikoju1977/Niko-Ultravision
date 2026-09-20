/**
 * Repli historique : Canvas + MediaRecorder.
 * Conservé pour les navigateurs sans WebCodecs (Firefox, Safari ancien).
 * Encodage en temps réel, images potentiellement perdues, aucun contrôle fin
 * de la qualité — limites assumées et signalées dans l'interface.
 */
import { calculateOutputSize, megapixels, type Size, type TargetId } from "./geometry";
import { PROFILES, type ProfileId } from "./profiles";

export interface RecorderResult {
  blob: Blob;
  size: Size;
  mimeType: string;
  audioPreserved: boolean;
  frameRate: number;
  frameRateDetected: boolean;
}

type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    callback: (now: number, metadata: { mediaTime: number }) => void,
  ) => number;
};

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

async function rewindVideo(video: HTMLVideoElement): Promise<void> {
  if (video.currentTime <= 0.001) {
    video.currentTime = 0;
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener("seeked", finish);
      resolve();
    };
    video.addEventListener("seeked", finish, { once: true });
    video.currentTime = 0;
    window.setTimeout(finish, 1200);
  });
}

function chooseMimeType(): string {
  const choices = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4",
  ];
  return choices.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

function videoBitrate(size: Size, frameRate: number): number {
  const mp = megapixels(size);
  const base = mp >= 8 ? 28_000_000 : mp >= 3.5 ? 16_000_000 : 9_000_000;
  return frameRate > 30 ? Math.round(base * 1.5) : base;
}

function normalizeFrameRate(value: number): number {
  if (!Number.isFinite(value) || value < 12) return 30;
  const capped = Math.min(60, value);
  const standards = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
  return standards.reduce((best, candidate) =>
    Math.abs(candidate - capped) < Math.abs(best - capped) ? candidate : best,
  );
}

async function detectFrameRate(video: HTMLVideoElement): Promise<{ value: number; detected: boolean }> {
  const framed = video as FrameVideo;
  if (!framed.requestVideoFrameCallback || !Number.isFinite(video.duration) || video.duration <= 0) {
    return { value: 30, detected: false };
  }

  const sampleSeconds = Math.min(0.8, Math.max(0.35, video.duration * 0.5));
  const originalMuted = video.muted;
  video.muted = true;
  video.currentTime = 0;

  return new Promise((resolve) => {
    let firstMediaTime: number | null = null;
    let lastMediaTime = 0;
    let frames = 0;
    let settled = false;
    let timer = 0;

    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeEventListener("ended", wrappedFinish);
      video.pause();
      video.currentTime = 0;
      video.muted = originalMuted;
      const elapsed = firstMediaTime == null ? 0 : lastMediaTime - firstMediaTime;
      if (frames < 3 || elapsed <= 0) {
        resolve({ value: 30, detected: false });
        return;
      }
      const measured = (frames - 1) / elapsed;
      resolve({ value: normalizeFrameRate(measured), detected: true });
    };

    const onFrame = (_now: number, metadata: { mediaTime: number }) => {
      if (firstMediaTime == null) firstMediaTime = metadata.mediaTime;
      lastMediaTime = metadata.mediaTime;
      frames += 1;
      if (metadata.mediaTime - (firstMediaTime ?? 0) >= sampleSeconds || video.ended) {
        finish();
        return;
      }
      framed.requestVideoFrameCallback?.(onFrame);
    };

    function wrappedFinish() { finish(); }

    timer = window.setTimeout(finish, Math.max(1800, sampleSeconds * 2500));
    video.addEventListener("ended", wrappedFinish, { once: true });
    framed.requestVideoFrameCallback(onFrame);
    void video.play().catch(wrappedFinish);
  });
}

export async function enhanceVideoWithRecorder(
  file: File,
  target: TargetId,
  profile: ProfileId,
  onProgress?: (value: number, label: string) => void,
): Promise<RecorderResult> {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("MediaRecorder n'est pas disponible sur ce navigateur.");
  }

  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.src = url;
  video.preload = "auto";
  video.playsInline = true;

  let stream: MediaStream | null = null;
  let audioContext: AudioContext | null = null;
  let recorder: MediaRecorder | null = null;
  let canvas: HTMLCanvasElement | null = null;

  try {
    await waitForMetadata(video);

    const output = calculateOutputSize(video.videoWidth, video.videoHeight, target);
    if (Math.max(output.width, output.height) > 3840 || output.width * output.height > 9_000_000) {
      throw new Error("Le traitement vidéo local est limité à 4K pour rester fiable dans le navigateur.");
    }

    onProgress?.(0.01, "Analyse du framerate");
    const detectedRate = await detectFrameRate(video);
    const frameRate = detectedRate.value;
    await rewindVideo(video);

    canvas = document.createElement("canvas");
    canvas.width = output.width;
    canvas.height = output.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D indisponible.");

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.filter = PROFILES[profile].filter;

    stream = canvas.captureStream(frameRate);
    let audioPreserved = false;

    try {
      const AudioContextCtor =
        window.AudioContext ??
        (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioContextCtor) {
        audioContext = new AudioContextCtor();
        const source = audioContext.createMediaElementSource(video);
        const destination = audioContext.createMediaStreamDestination();
        source.connect(destination);
        destination.stream.getAudioTracks().forEach((track) => stream?.addTrack(track));
        audioPreserved = destination.stream.getAudioTracks().length > 0;
        await audioContext.resume();
      }
    } catch {
      audioPreserved = false;
      if (audioContext) {
        await audioContext.close().catch(() => undefined);
        audioContext = null;
      }
    }

    const mimeType = chooseMimeType();
    recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: videoBitrate(output, frameRate),
      audioBitsPerSecond: 192_000,
    });

    const chunks: BlobPart[] = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });

    const finished = new Promise<void>((resolve, reject) => {
      recorder?.addEventListener("stop", () => resolve(), { once: true });
      recorder?.addEventListener("error", () => reject(new Error("Erreur d'encodage vidéo.")), { once: true });
      video.addEventListener("error", () => reject(new Error("Erreur de lecture vidéo pendant le traitement.")), { once: true });
    });

    const drawFrame = () => {
      if (video.ended || video.paused) return;
      ctx.drawImage(video, 0, 0, output.width, output.height);
      const progress = video.duration ? Math.min(0.98, video.currentTime / video.duration) : 0;
      onProgress?.(progress, "Traitement vidéo local · " + Math.round(frameRate) + " i/s");
      const framed = video as FrameVideo;
      if (framed.requestVideoFrameCallback) framed.requestVideoFrameCallback(() => drawFrame());
      else requestAnimationFrame(drawFrame);
    };

    video.addEventListener("ended", () => {
      if (recorder?.state !== "inactive") recorder?.stop();
    }, { once: true });

    video.currentTime = 0;
    video.muted = false;
    onProgress?.(0.03, "Préparation · " + Math.round(frameRate) + " i/s");
    recorder.start(1000);
    await video.play();
    drawFrame();
    await finished;

    const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "video/webm" });
    if (blob.size === 0) throw new Error("L'encodeur vidéo a produit un fichier vide.");

    onProgress?.(1, "Terminé");
    return {
      blob,
      size: output,
      mimeType: blob.type,
      audioPreserved,
      frameRate,
      frameRateDetected: detectedRate.detected,
    };
  } finally {
    video.pause();
    if (recorder && recorder.state !== "inactive") {
      try { recorder.stop(); } catch { /* cleanup only */ }
    }
    stream?.getTracks().forEach((track) => track.stop());
    if (audioContext) await audioContext.close().catch(() => undefined);
    if (canvas) { canvas.width = 1; canvas.height = 1; }
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}
