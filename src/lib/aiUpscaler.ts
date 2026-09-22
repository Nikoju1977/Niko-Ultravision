/**
 * Moteur de super-résolution IA — ONNX Runtime Web.
 *
 * Ce module exécute un vrai réseau de neurones open source dans le navigateur.
 * Il est volontairement agnostique du modèle : le nom des entrées/sorties et le
 * facteur d'échelle sont lus sur la session ONNX, pas codés en dur. Tout modèle
 * de super-résolution à une entrée NCHW et une sortie NCHW fonctionne
 * (Swin2SR, Real-ESRGAN, EDSR, SwinIR…).
 *
 * Les pixels ne quittent jamais l'appareil. Seuls les poids du modèle sont
 * téléchargés (une fois), ou fournis en local par un fichier .onnx.
 */

import wasmBinaryUrl from "onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url";

type OrtModule = typeof import("onnxruntime-web/webgpu");
type OrtSession = Awaited<ReturnType<OrtModule["InferenceSession"]["create"]>>;

export interface AiModelInfo {
  /** Facteur d'agrandissement mesuré sur le modèle (2, 3, 4…). */
  scale: number;
  inputName: string;
  outputName: string;
  /** "webgpu" ou "wasm" — backend réellement retenu. */
  provider: string;
  /** Taille des poids téléchargés / chargés, en octets. */
  bytes: number;
  source: string;
}

export type ModelSource =
  | { kind: "url"; url: string; label?: string }
  | { kind: "file"; file: File };

export type AiModelPresetId = "mobile-x2" | "pro-real-x4";

export interface AiModelPreset {
  id: AiModelPresetId;
  label: string;
  url: string;
  expectedScale: number;
  recommendedMaxSourcePixels: number;
}

export const AI_MODEL_PRESETS: Record<AiModelPresetId, AiModelPreset> = {
  "mobile-x2": {
    id: "mobile-x2",
    label: "Swin2SR lightweight x2 · mobile",
    url: "https://huggingface.co/Xenova/swin2SR-lightweight-x2-64/resolve/main/onnx/model.onnx",
    expectedScale: 2,
    recommendedMaxSourcePixels: 8_000_000,
  },
  "pro-real-x4": {
    id: "pro-real-x4",
    label: "Swin2SR Real-World x4 · Pro Max",
    url: "https://huggingface.co/Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr/resolve/main/onnx/model.onnx",
    expectedScale: 4,
    recommendedMaxSourcePixels: 1_500_000,
  },
};

export const DEFAULT_MODEL_URL = AI_MODEL_PRESETS["mobile-x2"].url;
export const DEFAULT_MODEL_LABEL = AI_MODEL_PRESETS["mobile-x2"].label;

export function chooseAiPresetForTarget(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): AiModelPreset {
  const sourcePixels = Math.max(1, sourceWidth * sourceHeight);
  const requestedScale = Math.max(
    targetWidth / Math.max(1, sourceWidth),
    targetHeight / Math.max(1, sourceHeight),
  );
  const pro = AI_MODEL_PRESETS["pro-real-x4"];

  if (
    requestedScale >= 2.6 &&
    sourcePixels <= pro.recommendedMaxSourcePixels
  ) {
    return pro;
  }
  return AI_MODEL_PRESETS["mobile-x2"];
}

/** Au-delà, l'inférence par tuiles devient déraisonnable dans un navigateur. */
export const AI_MAX_SOURCE_PIXELS = 8_000_000;
/** Au-delà, on prévient l'utilisateur du temps de calcul. */
export const AI_WARN_SOURCE_PIXELS = 2_000_000;

const DESKTOP_TILE_CORE = 192;
const MOBILE_TILE_CORE = 128;
const TILE_PAD = 12;

function runtimeTileCore(): number {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const lowMemory = typeof nav.deviceMemory === "number" && nav.deviceMemory <= 4;
  return /Android/i.test(navigator.userAgent) || lowMemory ? MOBILE_TILE_CORE : DESKTOP_TILE_CORE;
}

let ortModule: OrtModule | null = null;
let session: OrtSession | null = null;
let info: AiModelInfo | null = null;

export function aiEngineAvailable(): boolean {
  return typeof WebAssembly !== "undefined";
}

export function webGpuAvailable(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

export function loadedModel(): AiModelInfo | null {
  return info;
}

export function disposeModel(): void {
  const current = session as (OrtSession & { release?: () => Promise<void> }) | null;
  void current?.release?.().catch(() => undefined);
  session = null;
  info = null;
}

async function getOrt(): Promise<OrtModule> {
  if (ortModule) return ortModule;

  const mod = await import("onnxruntime-web/webgpu");
  // Le binaire WASM est servi depuis nos propres assets : aucun CDN tiers.
  mod.env.wasm.wasmPaths = { wasm: wasmBinaryUrl };
  // Le multi-thread exige l'isolation cross-origin (COOP/COEP). Sans elle,
  // forcer numThreads > 1 fait échouer l'initialisation : on reste mono-thread.
  const isolated = typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
  mod.env.wasm.numThreads = isolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  mod.env.logLevel = "error";

  ortModule = mod;
  return mod;
}

/** Téléchargement XHR (progression réelle, compatible origine null Android). */
function downloadWeights(url: string, onProgress?: (ratio: number) => void): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.responseType = "arraybuffer";

    xhr.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300 && xhr.response) {
        resolve(xhr.response as ArrayBuffer);
      } else {
        reject(new Error(`Téléchargement du modèle impossible (HTTP ${xhr.status}).`));
      }
    };
    xhr.onerror = () =>
      reject(new Error("Téléchargement du modèle impossible : réseau ou CORS bloqué."));
    xhr.ontimeout = () => reject(new Error("Téléchargement du modèle : délai dépassé."));
    xhr.timeout = 180_000;
    xhr.send();
  });
}

function readFileBuffer(file: File): Promise<ArrayBuffer> {
  return file.arrayBuffer();
}

async function createSession(
  ort: OrtModule,
  weights: ArrayBuffer,
): Promise<{ session: OrtSession; provider: string }> {
  const attempts: string[] = webGpuAvailable() ? ["webgpu", "wasm"] : ["wasm"];
  const failures: string[] = [];

  for (const provider of attempts) {
    try {
      const created = await ort.InferenceSession.create(weights, {
        executionProviders: [provider],
        graphOptimizationLevel: "all",
      });
      return { session: created, provider };
    } catch (reason) {
      failures.push(
        provider.toUpperCase() + " : " +
          (reason instanceof Error ? reason.message : "raison inconnue"),
      );
    }
  }

  throw new Error(
    "Le modèle n'a pas pu être initialisé. " + failures.join(" | "),
  );
}

/** Détermine le facteur d'échelle en exécutant réellement une passe 64×64. */
async function probeScale(
  ort: OrtModule,
  active: OrtSession,
  inputName: string,
  outputName: string,
): Promise<number> {
  const side = 64;
  const probe = new ort.Tensor("float32", new Float32Array(3 * side * side).fill(0.5), [
    1,
    3,
    side,
    side,
  ]);

  const result = await active.run({ [inputName]: probe });
  const output = result[outputName];
  if (!output || output.dims.length !== 4) {
    throw new Error("Sortie du modèle inattendue : un tenseur NCHW est requis.");
  }

  const outHeight = Number(output.dims[2]);
  const scale = outHeight / side;
  if (!Number.isFinite(scale) || scale < 1 || scale > 8) {
    throw new Error(`Facteur d'échelle du modèle non exploitable (${scale}).`);
  }
  return Math.round(scale * 100) / 100;
}


async function probeRuntimeTile(
  ort: OrtModule,
  active: OrtSession,
  inputName: string,
  outputName: string,
): Promise<void> {
  const side = runtimeTileCore();
  const probe = new ort.Tensor(
    "float32",
    new Float32Array(3 * side * side).fill(0.5),
    [1, 3, side, side],
  );
  const result = await active.run({ [inputName]: probe });
  const output = result[outputName];
  if (!output || output.dims.length !== 4) {
    throw new Error("Le modèle refuse la taille de tuile réelle du navigateur.");
  }
}

export async function loadAiModel(
  source: ModelSource,
  onProgress?: (ratio: number, label: string) => void,
): Promise<AiModelInfo> {
  onProgress?.(0.02, "Initialisation du runtime ONNX");
  const ort = await getOrt();

  onProgress?.(0.08, "Récupération des poids du modèle");
  const weights =
    source.kind === "file"
      ? await readFileBuffer(source.file)
      : await downloadWeights(source.url, (ratio) =>
          onProgress?.(0.08 + ratio * 0.62, `Téléchargement du modèle · ${Math.round(ratio * 100)} %`),
        );

  if (weights.byteLength === 0) throw new Error("Fichier de modèle vide.");

  onProgress?.(0.74, "Initialisation de la session d'inférence");
  disposeModel();
  const created = await createSession(ort, weights);
  session = created.session;

  try {
    const inputName = session.inputNames[0];
    const outputName = session.outputNames[0];
    if (!inputName || !outputName) throw new Error("Modèle ONNX sans entrée/sortie exploitable.");

    onProgress?.(0.88, "Mesure du facteur d'échelle");
    const scale = await probeScale(ort, session, inputName, outputName);
    onProgress?.(0.94, "Validation d'une vraie tuile d'inférence");
    await probeRuntimeTile(ort, session, inputName, outputName);

    info = {
      scale,
      inputName,
      outputName,
      provider: created.provider,
      bytes: weights.byteLength,
      source: source.kind === "file" ? source.file.name : (source.label ?? source.url),
    };

    onProgress?.(1, `Modèle prêt · x${scale} · ${created.provider.toUpperCase()}`);
    return info;
  } catch (reason) {
    const failed = session as (OrtSession & { release?: () => Promise<void> }) | null;
    session = null;
    info = null;
    await failed?.release?.().catch(() => undefined);
    throw reason;
  }
}

/** Les réseaux de la famille SwinIR/Swin2SR exigent des côtés multiples de la fenêtre (8). */
const WINDOW_MULTIPLE = 8;

function roundUpToWindow(value: number): number {
  return Math.ceil(value / WINDOW_MULTIPLE) * WINDOW_MULTIPLE;
}

/**
 * Conversion RGBA → tenseur NCHW normalisé, avec complétion à droite/en bas
 * par réplication de bord jusqu'au multiple de fenêtre. La marge ajoutée est
 * en dehors de la zone conservée : elle n'apparaît jamais dans le résultat.
 */
function tileToTensor(ort: OrtModule, data: Uint8ClampedArray, width: number, height: number) {
  const paddedWidth = roundUpToWindow(width);
  const paddedHeight = roundUpToWindow(height);
  const plane = paddedWidth * paddedHeight;
  const values = new Float32Array(plane * 3);

  for (let y = 0; y < paddedHeight; y += 1) {
    const sourceY = Math.min(y, height - 1);
    for (let x = 0; x < paddedWidth; x += 1) {
      const sourceX = Math.min(x, width - 1);
      const offset = (sourceY * width + sourceX) * 4;
      const index = y * paddedWidth + x;
      values[index] = data[offset] / 255;
      values[plane + index] = data[offset + 1] / 255;
      values[plane * 2 + index] = data[offset + 2] / 255;
    }
  }

  return new ort.Tensor("float32", values, [1, 3, paddedHeight, paddedWidth]);
}

function clamp255(value: number): number {
  if (value <= 0) return 0;
  if (value >= 255) return 255;
  return value;
}

/**
 * Inférence par tuiles avec marge de recouvrement. La marge est calculée puis
 * jetée : chaque pixel final provient du centre d'une tuile, ce qui supprime
 * les coutures visibles aux jonctions.
 */
export async function upscaleWithAi(
  source: HTMLCanvasElement,
  onProgress?: (ratio: number, label: string) => void,
): Promise<HTMLCanvasElement> {
  if (!session || !info) throw new Error("Aucun modèle IA chargé.");
  const ort = await getOrt();
  const active = session;
  const model = info;

  const width = source.width;
  const height = source.height;
  if (width * height > AI_MAX_SOURCE_PIXELS) {
    throw new Error(
      `Source trop grande pour l'inférence locale (${(width * height / 1_000_000).toFixed(1)} MP, limite ${(AI_MAX_SOURCE_PIXELS / 1_000_000).toFixed(0)} MP).`,
    );
  }

  const sourceCtx = source.getContext("2d", { willReadFrequently: true });
  if (!sourceCtx) throw new Error("Canvas 2D indisponible pour l'inférence.");

  const scale = model.scale;
  const destination = document.createElement("canvas");
  destination.width = Math.round(width * scale);
  destination.height = Math.round(height * scale);
  const destinationCtx = destination.getContext("2d");
  if (!destinationCtx) throw new Error("Canvas 2D indisponible pour la sortie IA.");

  const tileCore = runtimeTileCore();
  const columns = Math.ceil(width / tileCore);
  const rows = Math.ceil(height / tileCore);
  const total = columns * rows;
  let done = 0;

  for (let ty = 0; ty < rows; ty += 1) {
    for (let tx = 0; tx < columns; tx += 1) {
      const coreX = tx * tileCore;
      const coreY = ty * tileCore;
      const startX = Math.max(0, coreX - TILE_PAD);
      const startY = Math.max(0, coreY - TILE_PAD);
      const endX = Math.min(width, coreX + tileCore + TILE_PAD);
      const endY = Math.min(height, coreY + tileCore + TILE_PAD);
      const tileWidth = endX - startX;
      const tileHeight = endY - startY;

      const tile = sourceCtx.getImageData(startX, startY, tileWidth, tileHeight);
      const tensor = tileToTensor(ort, tile.data, tileWidth, tileHeight);

      let result: Awaited<ReturnType<typeof active.run>>;
      try {
        result = await active.run({ [model.inputName]: tensor });
      } catch (reason) {
        const detail = reason instanceof Error ? reason.message : "raison inconnue";
        throw new Error(
          done === 0
            ? `Ce modèle a refusé la première tuile (${tileWidth}×${tileHeight}) : ${detail}. Il attend probablement une entrée de taille fixe et n'est pas compatible avec l'inférence par tuiles.`
            : `Inférence interrompue à la tuile ${done + 1}/${total} : ${detail}`,
        );
      }

      const output = result[model.outputName];
      if (!output || output.dims.length !== 4) throw new Error("Sortie IA invalide sur une tuile.");

      const outWidth = Number(output.dims[3]);
      const outHeight = Number(output.dims[2]);
      const values = output.data as Float32Array;
      const plane = outWidth * outHeight;

      const keepX = Math.round((coreX - startX) * scale);
      const keepY = Math.round((coreY - startY) * scale);
      const keepWidth = Math.min(Math.round(Math.min(tileCore, width - coreX) * scale), outWidth - keepX);
      const keepHeight = Math.min(Math.round(Math.min(tileCore, height - coreY) * scale), outHeight - keepY);

      if (keepWidth > 0 && keepHeight > 0) {
        const patch = new ImageData(keepWidth, keepHeight);
        for (let y = 0; y < keepHeight; y += 1) {
          const sourceRow = (keepY + y) * outWidth;
          for (let x = 0; x < keepWidth; x += 1) {
            const sourceIndex = sourceRow + keepX + x;
            const target = (y * keepWidth + x) * 4;
            patch.data[target] = clamp255(Math.round(values[sourceIndex] * 255));
            patch.data[target + 1] = clamp255(Math.round(values[plane + sourceIndex] * 255));
            patch.data[target + 2] = clamp255(Math.round(values[plane * 2 + sourceIndex] * 255));
            patch.data[target + 3] = 255;
          }
        }
        destinationCtx.putImageData(patch, Math.round(coreX * scale), Math.round(coreY * scale));
      }

      done += 1;
      onProgress?.(done / total, `Inférence IA · tuile ${done}/${total} · ${model.provider.toUpperCase()}`);
      // Rend la main au navigateur : la barre de progression reste vivante.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  }

  return destination;
}
