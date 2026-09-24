import { decodeImageFile } from "./imageDecode";
import { compareImageQuality, type QualityComparison } from "./qualityComparator";
import {
  duelFinalMasters,
  type FinalMasterDuel,
} from "./finalMasterDuel";

const ENDPOINT_KEY = "ultravision.cloud-pro-endpoint";
const TOKEN_KEY = "ultravision.cloud-pro-token";
const MAX_CLOUD_OUTPUT_PIXELS = 8_294_400;
const MAX_CLOUD_EDGE = 3840;
const MIN_CLOUD_OUTPUT_PIXELS = 655_360;
const MAX_UPLOAD_BYTES = 3_200_000;

export interface CloudProRunResult {
  accepted: boolean;
  blob: Blob;
  comparison: QualityComparison;
  localComparison: QualityComparison;
  duel: FinalMasterDuel;
  requestedSize: { width: number; height: number };
  uploadBytes: number;
  elapsedMs: number;
  model: string;
  reason: string;
}

function envEndpoint(): string | null {
  const env = (
    import.meta as ImportMeta & {
      env?: Record<string, string | undefined>;
    }
  ).env;
  const value = env?.VITE_CLOUD_PRO_ENDPOINT?.trim();
  return value || null;
}

export function defaultCloudProEndpoint(): string | null {
  const configured = envEndpoint();
  if (configured) return configured;

  // Un déploiement avec Functions peut utiliser /api/cloud-pro directement.
  // GitHub Pages ne possède pas de runtime serveur : aucun faux endpoint n'est
  // proposé et aucune clé OpenAI n'est jamais demandée au navigateur.
  if (
    typeof location !== "undefined" &&
    !location.hostname.endsWith("github.io")
  ) {
    return "/api/cloud-pro";
  }
  return null;
}

export function getCloudProEndpoint(): string | null {
  try {
    const saved = localStorage.getItem(ENDPOINT_KEY)?.trim();
    return saved || defaultCloudProEndpoint();
  } catch {
    return defaultCloudProEndpoint();
  }
}

export function setCloudProEndpoint(value: string): void {
  const normalized = value.trim().replace(/\/$/, "");
  try {
    if (normalized) localStorage.setItem(ENDPOINT_KEY, normalized);
    else localStorage.removeItem(ENDPOINT_KEY);
  } catch {
    // L'URL n'est pas sensible. Si le stockage est refusé, le mode cloud
    // restera simplement limité à la session courante.
  }
}

export function getCloudProToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setCloudProToken(value: string): void {
  try {
    if (value) sessionStorage.setItem(TOKEN_KEY, value);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Le token d'accès au proxy n'est jamais persisté au-delà de la session.
  }
}

export function cloudProOutputSupported(size: {
  width: number;
  height: number;
}): boolean {
  return (
    size.width > 0 &&
    size.height > 0 &&
    size.width <= MAX_CLOUD_EDGE &&
    size.height <= MAX_CLOUD_EDGE &&
    size.width * size.height <= MAX_CLOUD_OUTPUT_PIXELS
  );
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("Encodage Cloud Pro impossible.")),
      type,
      quality,
    );
  });
}

async function prepareUpload(
  source: Blob,
): Promise<Blob> {
  const decoded = await decodeImageFile(source);
  try {
    let maxSide = 2048;
    let quality = 0.94;

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const scale = Math.min(
        1,
        maxSide / Math.max(decoded.width, decoded.height),
      );
      const width = Math.max(32, Math.round(decoded.width * scale));
      const height = Math.max(32, Math.round(decoded.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas Cloud Pro indisponible.");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(decoded.source, 0, 0, width, height);

      const blob = await canvasToBlob(
        canvas,
        "image/webp",
        quality,
      );
      canvas.width = canvas.height = 1;
      if (blob.size <= MAX_UPLOAD_BYTES) return blob;

      if (quality > 0.76) quality -= 0.08;
      else maxSide = Math.max(1280, Math.round(maxSide * 0.8));
    }

    throw new Error(
      "La photo reste trop lourde pour l'envoi Cloud Pro sécurisé.",
    );
  } finally {
    decoded.close();
  }
}

function cloudSize(
  target: { width: number; height: number },
): { width: number; height: number } {
  if (!cloudProOutputSupported(target)) {
    throw new Error(
      "Cloud Pro est limité aux sorties jusqu'à 4K / 8,29 MP. " +
        "Le master local reste disponible pour les définitions supérieures.",
    );
  }

  const ratio = target.width / target.height;
  let width = Math.max(16, Math.round(target.width / 16) * 16);
  let height = Math.max(16, Math.round(target.height / 16) * 16);

  const pixels = width * height;
  if (pixels > MAX_CLOUD_OUTPUT_PIXELS) {
    const scale = Math.sqrt(MAX_CLOUD_OUTPUT_PIXELS / pixels);
    width = Math.floor((width * scale) / 16) * 16;
    height = Math.floor((height * scale) / 16) * 16;
  }

  if (width * height < MIN_CLOUD_OUTPUT_PIXELS) {
    const scale = Math.sqrt(
      MIN_CLOUD_OUTPUT_PIXELS / Math.max(1, width * height),
    );
    width = Math.ceil((width * scale) / 16) * 16;
    height = Math.ceil((height * scale) / 16) * 16;
  }

  // Corrige les arrondis sans modifier sensiblement le cadrage.
  if (Math.abs(width / height - ratio) > 0.02) {
    if (ratio >= 1) {
      height = Math.max(16, Math.round(width / ratio / 16) * 16);
    } else {
      width = Math.max(16, Math.round(height * ratio / 16) * 16);
    }
  }

  return { width, height };
}

async function normalizeCandidate(
  blob: Blob,
  target: { width: number; height: number },
): Promise<Blob> {
  const decoded = await decodeImageFile(blob);
  try {
    const expectedRatio = target.width / target.height;
    const actualRatio = decoded.width / decoded.height;
    if (
      Math.abs(actualRatio / expectedRatio - 1) > 0.035
    ) {
      throw new Error(
        "Le candidat cloud a modifié le cadrage : résultat refusé.",
      );
    }

    if (
      decoded.width === target.width &&
      decoded.height === target.height
    ) {
      return blob;
    }

    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Normalisation Cloud Pro indisponible.");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
      decoded.source,
      0,
      0,
      decoded.width,
      decoded.height,
      0,
      0,
      target.width,
      target.height,
    );
    const output = await canvasToBlob(canvas, "image/png");
    canvas.width = canvas.height = 1;
    return output;
  } finally {
    decoded.close();
  }
}

function errorFromResponse(
  status: number,
  body: string,
): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: string | { message?: string };
      message?: string;
    };
    const detail =
      typeof parsed.error === "string"
        ? parsed.error
        : parsed.error?.message ?? parsed.message;
    if (detail) return detail;
  } catch {
    // Réponse non JSON.
  }
  return `Cloud Pro HTTP ${status}`;
}

export async function runCloudProRestoration(options: {
  source: File;
  localMaster: Blob;
  targetSize: { width: number; height: number };
  endpoint: string;
  accessToken: string;
  onProgress?: (value: number, label: string) => void;
}): Promise<CloudProRunResult> {
  const {
    source,
    localMaster,
    targetSize,
    endpoint,
    accessToken,
    onProgress,
  } = options;

  if (!endpoint.trim()) {
    throw new Error("Endpoint Cloud Pro non configuré.");
  }
  if (!accessToken.trim()) {
    throw new Error(
      "Token Cloud Pro manquant. La clé OpenAI reste côté serveur.",
    );
  }

  const requestedSize = cloudSize(targetSize);
  onProgress?.(0.05, "Cloud Pro · préparation de la référence");
  const upload = await prepareUpload(source);

  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    240_000,
  );
  const started = performance.now();

  try {
    onProgress?.(
      0.15,
      "Cloud Pro · restauration GPT Image 2.5 Sunburst",
    );
    const response = await fetch(
      endpoint.trim(),
      {
        method: "POST",
        headers: {
          "Content-Type": upload.type || "image/webp",
          "X-Ultravision-Token": accessToken.trim(),
          "X-Ultravision-Width": String(requestedSize.width),
          "X-Ultravision-Height": String(requestedSize.height),
          "X-Ultravision-Mode": "faithful-photo-restoration",
        },
        body: upload,
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(errorFromResponse(response.status, body));
    }

    const model =
      response.headers.get("X-Ultravision-Model") ??
      "gpt-image-2.5-sunburst";
    const rawCloud = await response.blob();
    if (!rawCloud.size) {
      throw new Error("Cloud Pro a renvoyé une image vide.");
    }

    onProgress?.(0.78, "Cloud Pro · normalisation géométrique");
    const candidate = await normalizeCandidate(
      rawCloud,
      targetSize,
    );

    onProgress?.(
      0.86,
      "Cloud Pro · duel contre le master local",
    );
    const [duel, comparison, localComparison] = await Promise.all([
      duelFinalMasters(source, candidate, localMaster),
      compareImageQuality(source, candidate),
      compareImageQuality(source, localMaster),
    ]);

    const fidelityGate =
      comparison.ssim >= Math.max(0.82, localComparison.ssim - 0.012) &&
      comparison.psnr >= Math.max(23, localComparison.psnr - 1.2) &&
      comparison.meanChromaError <=
        Math.max(7.5, localComparison.meanChromaError + 1.5) &&
      comparison.chromaErrorP95 <=
        Math.max(22, localComparison.chromaErrorP95 + 3) &&
      comparison.edgeGainPercent >=
        localComparison.edgeGainPercent - 4;

    const accepted =
      duel.winner === "primary" && fidelityGate;

    const reason = accepted
      ? `Cloud Pro conservé : avantage mesuré +${duel.margin.toFixed(2)} points, SSIM ${comparison.ssim.toFixed(3)}, dérive couleur ${comparison.meanChromaError.toFixed(1)}.`
      : `Cloud Pro refusé : le master local reste meilleur ou plus fidèle (Δ ${duel.margin.toFixed(2)}, SSIM cloud ${comparison.ssim.toFixed(3)} vs local ${localComparison.ssim.toFixed(3)}).`;

    onProgress?.(1, accepted ? "Cloud Pro validé" : "Cloud Pro refusé");

    return {
      accepted,
      blob: accepted ? candidate : localMaster,
      comparison: accepted ? comparison : localComparison,
      localComparison,
      duel,
      requestedSize,
      uploadBytes: upload.size,
      elapsedMs: performance.now() - started,
      model,
      reason,
    };
  } catch (reason) {
    if (
      reason instanceof DOMException &&
      reason.name === "AbortError"
    ) {
      throw new Error(
        "Cloud Pro a dépassé le délai maximal de 4 minutes.",
      );
    }
    throw reason;
  } finally {
    window.clearTimeout(timeout);
  }
}
