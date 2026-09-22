/**
 * Moteur de super-résolution IA — ONNX Runtime Web.
 *
 * Architecture :
 *  - l'inférence tourne dans un Web Worker dédié (interface fluide) ;
 *  - multi-thread WASM automatique quand la page est cross-origin isolée
 *    (service worker COI) ;
 *  - replis automatiques : worker multi-thread → worker mono-thread →
 *    thread principal. Chaque étape est réellement testée (session + tuile).
 *
 * Le modèle est agnostique : noms d'entrée/sortie et facteur d'échelle sont
 * lus sur la session. Les pixels ne quittent jamais l'appareil ; seuls les
 * poids sont téléchargés une fois puis servis depuis le cache local.
 */

import { throwIfCancelled } from "./cancellation";
import {
  createSession,
  errorText,
  getOrt,
  hasWebGpu,
  isIsolated,
  probeModel,
  recommendedThreads,
  releaseSession,
  runTile,
  type KeepRect,
  type ModelMeta,
  type OrtSession,
  type TileResult,
} from "./aiEngineCore";
import type { WorkerRequest, WorkerResponse } from "./aiWorker";

export interface AiModelInfo {
  /** Facteur d'agrandissement mesuré sur le modèle (2, 3, 4…). */
  scale: number;
  inputName: string;
  outputName: string;
  /** "webgpu" ou "wasm" — backend réellement retenu. */
  provider: string;
  /** Taille des poids, en octets. */
  bytes: number;
  source: string;
  /** true si les poids viennent du cache local (aucun téléchargement). */
  fromCache: boolean;
  /** Où tourne l'inférence. */
  execution: "worker" | "main";
  /** Threads WASM réellement actifs (1 sans isolation cross-origin). */
  threads: number;
  /** Entrée figée du modèle (null = dynamique). */
  fixedWidth: number | null;
  fixedHeight: number | null;
  inputType: "float32" | "float16";
  inputLayout: "NCHW" | "NHWC";
  outputLayout: "NCHW" | "NHWC";
  /** Le modèle a réellement exécuté une tuile RGBA avant d'être déclaré prêt. */
  qualified: true;
  smokeTestMs: number;
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
  return /Android|iPhone|iPad/i.test(navigator.userAgent) || lowMemory ? MOBILE_TILE_CORE : DESKTOP_TILE_CORE;
}

export function aiEngineAvailable(): boolean {
  return typeof WebAssembly !== "undefined";
}

export function webGpuAvailable(): boolean {
  return hasWebGpu();
}

export function crossOriginIsolatedRuntime(): boolean {
  return isIsolated();
}

/* ------------------------------------------------------------------ */
/* Moteurs d'exécution                                                  */
/* ------------------------------------------------------------------ */

interface LoadResult {
  meta: ModelMeta;
  threads: number;
}

interface Engine {
  readonly execution: "worker" | "main";
  load(weights: ArrayBuffer, tileSide: number, preferGpu: boolean): Promise<LoadResult>;
  tile(rgba: Uint8ClampedArray, width: number, height: number, keep: KeepRect): Promise<TileResult>;
  dispose(): void;
}

type Pending = {
  resolve: (value: WorkerResponse) => void;
  reject: (reason: Error) => void;
};

class WorkerEngine implements Engine {
  readonly execution = "worker" as const;
  private worker: Worker;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private dead: Error | null = null;

  constructor(private readonly threads: number) {
    this.worker = new Worker(new URL("./aiWorker.ts", import.meta.url), {
      type: "module",
      name: "ultravision-ai",
    });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const entry = this.pending.get(event.data.id);
      if (!entry) return;
      this.pending.delete(event.data.id);
      if (event.data.ok) entry.resolve(event.data);
      else entry.reject(new Error(event.data.error));
    };
    const fail = (message: string) => {
      this.dead = new Error(message);
      for (const entry of this.pending.values()) entry.reject(this.dead);
      this.pending.clear();
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      fail("Worker IA arrêté : " + (event.message || "erreur de chargement du module"));
    };
    this.worker.onmessageerror = () => fail("Worker IA : message illisible.");
  }

  private call(request: WorkerRequest, transfer: Transferable[] = []): Promise<WorkerResponse> {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
      this.worker.postMessage(request, transfer);
    });
  }

  async load(weights: ArrayBuffer, tileSide: number, preferGpu: boolean): Promise<LoadResult> {
    // Copie volontaire (pas de transfert) : les poids restent disponibles
    // pour un éventuel repli sur une autre configuration.
    const reply = await this.call({
      id: this.nextId++,
      type: "load",
      weights,
      threads: this.threads,
      tileSide,
      preferGpu,
    });
    if (!reply.ok || reply.type !== "load") throw new Error("Réponse inattendue du worker IA.");
    return { meta: reply.meta, threads: reply.threads };
  }

  async tile(rgba: Uint8ClampedArray, width: number, height: number, keep: KeepRect): Promise<TileResult> {
    const buffer = rgba.buffer as ArrayBuffer;
    const reply = await this.call(
      { id: this.nextId++, type: "tile", rgba: buffer, width, height, keep },
      [buffer],
    );
    if (!reply.ok || reply.type !== "tile") throw new Error("Réponse inattendue du worker IA.");
    return { data: new Uint8ClampedArray(reply.data), width: reply.width, height: reply.height };
  }

  dispose(): void {
    this.dead = this.dead ?? new Error("Moteur IA libéré.");
    for (const entry of this.pending.values()) entry.reject(this.dead);
    this.pending.clear();
    this.worker.terminate();
  }
}

/** Repli ultime : même noyau, exécuté dans le thread de l'interface. */
class MainThreadEngine implements Engine {
  readonly execution = "main" as const;
  private session: OrtSession | null = null;
  private meta: ModelMeta | null = null;
  private weights: Uint8Array | null = null;

  async load(weights: ArrayBuffer, tileSide: number, preferGpu: boolean): Promise<LoadResult> {
    const ort = await getOrt(1);
    await releaseSession(this.session);
    this.session = null;
    this.weights = new Uint8Array(weights.slice(0));
    const created = await createSession(ort, this.weights, preferGpu);
    try {
      this.meta = await probeModel(ort, created.session, created.provider, tileSide);
    } catch (reason) {
      await releaseSession(created.session);
      throw reason;
    }
    this.session = created.session;
    return { meta: this.meta, threads: 1 };
  }

  async tile(rgba: Uint8ClampedArray, width: number, height: number, keep: KeepRect): Promise<TileResult> {
    if (!this.session || !this.meta) throw new Error("Aucun modèle IA chargé.");
    const ort = await getOrt(1);
    const result = await runTile(ort, this.session, this.meta, rgba, width, height, keep);
    // Rend la main au navigateur entre deux tuiles.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return result;
  }

  dispose(): void {
    void releaseSession(this.session);
    this.session = null;
    this.meta = null;
    this.weights = null;
  }
}

/* ------------------------------------------------------------------ */
/* Cache persistant des poids                                           */
/* ------------------------------------------------------------------ */

const MODEL_CACHE_NAME = "niko-ultravision-models-v1";

function cacheStorageUsable(): boolean {
  return typeof caches !== "undefined" && globalThis.isSecureContext === true;
}

async function readCachedWeights(url: string): Promise<ArrayBuffer | null> {
  if (!cacheStorageUsable()) return null;
  try {
    const hit = await (await caches.open(MODEL_CACHE_NAME)).match(url);
    if (!hit) return null;
    const buffer = await hit.arrayBuffer();
    return buffer.byteLength > 0 ? buffer : null;
  } catch {
    return null;
  }
}

async function storeCachedWeights(url: string, weights: ArrayBuffer): Promise<void> {
  if (!cacheStorageUsable()) return;
  try {
    const cache = await caches.open(MODEL_CACHE_NAME);
    await cache.put(
      url,
      new Response(weights, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(weights.byteLength),
        },
      }),
    );
    await navigator.storage?.persist?.().catch(() => false);
  } catch {
    /* quota ou cache indisponible : non bloquant */
  }
}

async function removeCachedWeights(url: string): Promise<void> {
  if (!cacheStorageUsable()) return;
  try {
    await (await caches.open(MODEL_CACHE_NAME)).delete(url);
  } catch {
    /* non bloquant */
  }
}

/** Vide le cache des modèles. */
export async function clearModelCache(): Promise<boolean> {
  if (!cacheStorageUsable()) return false;
  try {
    return await caches.delete(MODEL_CACHE_NAME);
  } catch {
    return false;
  }
}

/** true si les poids de cette URL sont déjà en cache (chargement instantané). */
export async function isModelCached(url: string): Promise<boolean> {
  return (await readCachedWeights(url)) !== null;
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
      if (xhr.status >= 200 && xhr.status < 300 && xhr.response) resolve(xhr.response as ArrayBuffer);
      else reject(new Error(`Téléchargement du modèle impossible (HTTP ${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error("Téléchargement du modèle impossible : réseau ou CORS bloqué."));
    xhr.ontimeout = () => reject(new Error("Téléchargement du modèle : délai dépassé."));
    xhr.timeout = 300_000;
    xhr.send();
  });
}

/* ------------------------------------------------------------------ */
/* Chargement du modèle                                                 */
/* ------------------------------------------------------------------ */

let engine: Engine | null = null;
let info: AiModelInfo | null = null;
/** Dernière configuration qui a fonctionné : essayée en premier ensuite. */
let preferredPlan: string | null = null;

export function loadedModel(): AiModelInfo | null {
  return info;
}

export function disposeModel(): void {
  engine?.dispose();
  engine = null;
  info = null;
}

interface EnginePlan {
  key: string;
  label: string;
  make: () => Engine;
}

function smokeDimension(fixed: number | null): number {
  if (!fixed) return 32;
  return Math.max(4, Math.min(32, fixed));
}

async function qualifyEngine(
  candidate: Engine,
  meta: ModelMeta,
): Promise<number> {
  const width = smokeDimension(meta.fixedWidth);
  const height = smokeDimension(meta.fixedHeight);
  const rgba = new Uint8ClampedArray(width * height * 4);

  // Mire synthétique RGB + luminance : elle vérifie le chemin complet
  // RGBA → tenseur → ONNX → pixels, pas seulement la création de session.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      rgba[i] = Math.round((x / Math.max(1, width - 1)) * 220 + 20);
      rgba[i + 1] = Math.round((y / Math.max(1, height - 1)) * 210 + 25);
      rgba[i + 2] = ((x >> 2) + (y >> 2)) % 2 ? 210 : 45;
      rgba[i + 3] = 255;
    }
  }

  const started = performance.now();
  const result = await candidate.tile(
    rgba,
    width,
    height,
    { x: 0, y: 0, width, height },
  );
  const elapsed = performance.now() - started;

  const expectedWidth = Math.max(1, Math.round(width * meta.scale));
  const expectedHeight = Math.max(1, Math.round(height * meta.scale));
  if (
    Math.abs(result.width - expectedWidth) > 1 ||
    Math.abs(result.height - expectedHeight) > 1
  ) {
    throw new Error(
      `Auto-test pixels : sortie ${result.width}×${result.height}, attendue ~${expectedWidth}×${expectedHeight}.`,
    );
  }
  if (result.data.length !== result.width * result.height * 4) {
    throw new Error("Auto-test pixels : taille du buffer RGBA incohérente.");
  }

  let sum = 0;
  let sumSq = 0;
  let samples = 0;
  let channelDifference = 0;
  for (let i = 0; i < result.data.length; i += 4) {
    const r = result.data[i];
    const g = result.data[i + 1];
    const b = result.data[i + 2];
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += y;
    sumSq += y * y;
    channelDifference += Math.abs(r - g) + Math.abs(g - b);
    samples += 1;
  }
  const mean = sum / Math.max(1, samples);
  const variance = Math.max(0, sumSq / Math.max(1, samples) - mean * mean);
  const meanChannelDifference =
    channelDifference / Math.max(1, samples * 2);

  if (!Number.isFinite(mean) || !Number.isFinite(variance)) {
    throw new Error("Auto-test pixels : valeurs de sortie invalides.");
  }
  if (variance < 2 || meanChannelDifference < 0.5) {
    throw new Error(
      "Auto-test pixels : le modèle produit une sortie quasi constante ou sans réponse couleur.",
    );
  }

  return elapsed;
}

function enginePlans(): EnginePlan[] {
  const plans: EnginePlan[] = [];
  const workers = typeof Worker !== "undefined";
  const threads = recommendedThreads();
  if (workers && threads > 1) {
    plans.push({ key: "worker-mt", label: `worker ${threads} threads`, make: () => new WorkerEngine(threads) });
  }
  if (workers) plans.push({ key: "worker-1", label: "worker", make: () => new WorkerEngine(1) });
  plans.push({ key: "main", label: "thread principal", make: () => new MainThreadEngine() });

  if (preferredPlan) {
    const index = plans.findIndex((plan) => plan.key === preferredPlan);
    if (index > 0) plans.unshift(...plans.splice(index, 1));
  }
  return plans;
}

export async function loadAiModel(
  source: ModelSource,
  onProgress?: (ratio: number, label: string) => void,
): Promise<AiModelInfo> {
  onProgress?.(0.04, "Récupération des poids du modèle");
  let fromCache = false;
  let weights: ArrayBuffer;
  if (source.kind === "file") {
    weights = await source.file.arrayBuffer();
  } else {
    const cached = await readCachedWeights(source.url);
    if (cached) {
      weights = cached;
      fromCache = true;
      onProgress?.(0.6, "Modèle chargé depuis le cache local");
    } else {
      weights = await downloadWeights(source.url, (ratio) =>
        onProgress?.(0.04 + ratio * 0.56, `Téléchargement du modèle · ${Math.round(ratio * 100)} %`),
      );
    }
  }
  if (weights.byteLength === 0) throw new Error("Fichier de modèle vide.");

  disposeModel();
  const failures: string[] = [];
  const tileSide = runtimeTileCore();

  for (const plan of enginePlans()) {
    onProgress?.(0.66, `Initialisation IA · ${plan.label}`);
    let candidate: Engine | null = null;
    try {
      candidate = plan.make();
      const loaded = await candidate.load(weights, tileSide, true);
      onProgress?.(0.86, `Qualification pixels · ${plan.label}`);
      const smokeTestMs = await qualifyEngine(candidate, loaded.meta);
      engine = candidate;
      preferredPlan = plan.key;
      info = {
        ...loaded.meta,
        bytes: weights.byteLength,
        source: source.kind === "file" ? source.file.name : (source.label ?? source.url),
        fromCache,
        execution: candidate.execution,
        threads: loaded.threads,
        qualified: true,
        smokeTestMs,
      };
      break;
    } catch (reason) {
      candidate?.dispose();
      failures.push(`${plan.label} : ${errorText(reason)}`);
    }
  }

  if (!engine || !info) {
    if (fromCache && source.kind === "url") await removeCachedWeights(source.url);
    throw new Error("Le modèle n'a pas pu être initialisé. " + failures.join(" | "));
  }

  // Mise en cache seulement après validation complète.
  if (source.kind === "url" && !fromCache) await storeCachedWeights(source.url, weights);

  const details = [
    `x${info.scale}`,
    info.provider.toUpperCase(),
    info.execution === "worker" ? `worker${info.threads > 1 ? ` ${info.threads} threads` : ""}` : "thread principal",
    `${info.inputLayout}→${info.outputLayout}`,
    `auto-test ${Math.round(info.smokeTestMs)} ms`,
    ...(fromCache ? ["cache local"] : []),
  ];
  onProgress?.(1, "Modèle prêt · " + details.join(" · "));
  return info;
}

/* ------------------------------------------------------------------ */
/* Inférence par tuiles                                                 */
/* ------------------------------------------------------------------ */

/**
 * Inférence par tuiles avec marge de recouvrement : la marge est calculée
 * puis jetée, chaque pixel final vient du centre d'une tuile (pas de couture).
 */
export async function upscaleWithAi(
  source: HTMLCanvasElement,
  onProgress?: (ratio: number, label: string) => void,
): Promise<HTMLCanvasElement> {
  const active = engine;
  const model = info;
  if (!active || !model) throw new Error("Aucun modèle IA chargé.");

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

  // Modèle à entrée fixe : la tuile (cœur + marges) doit tenir dans l'entrée.
  const fixedSide =
    model.fixedWidth && model.fixedHeight ? Math.min(model.fixedWidth, model.fixedHeight) : null;
  const tileCore = fixedSide
    ? Math.max(16, Math.min(runtimeTileCore(), fixedSide - 2 * TILE_PAD))
    : runtimeTileCore();
  const columns = Math.ceil(width / tileCore);
  const rows = Math.ceil(height / tileCore);
  const total = columns * rows;
  const unit = model.execution === "worker" ? "worker" : "main";
  let done = 0;

  for (let ty = 0; ty < rows; ty += 1) {
    for (let tx = 0; tx < columns; tx += 1) {
      throwIfCancelled();
      const coreX = tx * tileCore;
      const coreY = ty * tileCore;
      const startX = Math.max(0, coreX - TILE_PAD);
      const startY = Math.max(0, coreY - TILE_PAD);
      const endX = Math.min(width, coreX + tileCore + TILE_PAD);
      const endY = Math.min(height, coreY + tileCore + TILE_PAD);
      const tileWidth = endX - startX;
      const tileHeight = endY - startY;
      const keep: KeepRect = {
        x: coreX - startX,
        y: coreY - startY,
        width: Math.min(tileCore, width - coreX),
        height: Math.min(tileCore, height - coreY),
      };

      const tile = sourceCtx.getImageData(startX, startY, tileWidth, tileHeight);
      let patch: TileResult;
      try {
        patch = await active.tile(tile.data, tileWidth, tileHeight, keep);
      } catch (reason) {
        const detail = errorText(reason);
        throw new Error(
          done === 0
            ? `Ce modèle a refusé la première tuile (${tileWidth}×${tileHeight}) : ${detail}.`
            : `Inférence interrompue à la tuile ${done + 1}/${total} : ${detail}`,
        );
      }

      if (patch.width > 0 && patch.height > 0) {
        destinationCtx.putImageData(
          new ImageData(patch.data as Uint8ClampedArray<ArrayBuffer>, patch.width, patch.height),
          Math.round(coreX * scale),
          Math.round(coreY * scale),
        );
      }

      done += 1;
      onProgress?.(done / total, `Inférence IA · tuile ${done}/${total} · ${model.provider.toUpperCase()} · ${unit}`);
    }
  }

  return destination;
}
