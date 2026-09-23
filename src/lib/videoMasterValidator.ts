export interface VideoMasterValidationReport {
  valid: boolean;
  width: number;
  height: number;
  duration: number;
  bytes: number;
  mimeType: string;
  message: string;
}

export async function validateVideoMaster(
  blob: Blob,
): Promise<VideoMasterValidationReport> {
  if (!blob || blob.size <= 1024) {
    return {
      valid: false,
      width: 0,
      height: 0,
      duration: 0,
      bytes: blob?.size ?? 0,
      mimeType: blob?.type ?? "",
      message: "Master vidéo vide ou anormalement petit.",
    };
  }

  const url = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;

  try {
    const loaded = await new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => finish(false), 7000);
      const finish = (ok: boolean) => {
        window.clearTimeout(timer);
        video.removeEventListener("loadedmetadata", onLoaded);
        video.removeEventListener("error", onError);
        resolve(ok);
      };
      const onLoaded = () =>
        finish(video.videoWidth > 0 && video.videoHeight > 0);
      const onError = () => finish(false);
      video.addEventListener("loadedmetadata", onLoaded, { once: true });
      video.addEventListener("error", onError, { once: true });
      video.src = url;
      video.load();
    });

    const valid =
      loaded &&
      video.videoWidth > 0 &&
      video.videoHeight > 0 &&
      (Number.isFinite(video.duration) || video.duration === Infinity);

    return {
      valid,
      width: video.videoWidth || 0,
      height: video.videoHeight || 0,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      bytes: blob.size,
      mimeType: blob.type,
      message: valid
        ? "Master vidéo décodable, conteneur lisible et dimensions valides."
        : "Le navigateur n'a pas pu relire le master vidéo produit.",
    };
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}
