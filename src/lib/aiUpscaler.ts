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
  /** Le modèle a réellement exécuté plusieurs tuiles RGBA avant d'être déclaré prêt. */
  qualified: true;
  smokeTestMs: number;
  stressTestMs: number;
  benchmarkTileMs: number;
  estimatedTilesPerSecond: number;
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

export interface AiPerformanceBudget {
  mobile: boolean;
  deviceMemoryGb: number | null;
  maxInputPixels: number;
  maxOutputPixels: number;
  maxEstimatedWorkingMb: number;
}

export interface UpscaleAiOptions {
  /** Évite de créer une surface IA native plus grande que la cible utile. */
  targetWidth?: number;
  targetHeight?: number;
  /** Limite supplémentaire de la surface intermédiaire IA. */
  maxOutputPixels?: number;
  /** Repli WebGPU → WASM si le device GPU tombe pendant une tuile. */
  allowRuntimeFallback?: boolean;
}

function runtimeDeviceMemory(): number | null {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return typeof nav.deviceMemory === "number" ? nav.deviceMemory : null;
}

function isMobileRuntime(): boolean {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/**
 * Budget de sécurité calculé avant toute grosse allocation.
 * Le but est de préserver le navigateur : les sorties finales restent libres,
 * mais les surfaces neuronales intermédiaires sont bornées.
 */
export function aiPerformanceBudget(
  model: Pick<AiModelInfo, "scale" | "bytes" | "fixedWidth" | "fixedHeight"> | null = loadedModel(),
): AiPerformanceBudget {
  const memory = runtimeDeviceMemory();
  const mobile = isMobileRuntime();
  const lowMemory = memory !== null && memory <= 4;
  const heavyModel = Boolean(model && model.bytes >= 24 * 1024 * 1024);
  const x4 = Boolean(model && model.scale >= 3);

  if (mobile) {
    return {
      mobile,
      deviceMemoryGb: memory,
      maxInputPixels: x4
        ? heavyModel ? 700_000 : 1_050_000
        : lowMemory ? 1_600_000 : 2_500_000,
      maxOutputPixels: lowMemory ? 8_000_000 : 12_000_000,
      maxEstimatedWorkingMb: lowMemory ? 220 : 320,
    };
  }

  return {
    mobile,
    deviceMemoryGb: memory,
    maxInputPixels: x4
      ? heavyModel ? 2_000_000 : 3_000_000
      : lowMemory ? 3_000_000 : 6_000_000,
    maxOutputPixels: lowMemory ? 18_000_000 : 40_000_000,
    maxEstimatedWorkingMb: lowMemory ? 420 : 900,
  };
}

export function recommendedAiInputPixels(model: AiModelInfo | null = loadedModel()): number {
  return aiPerformanceBudget(model).maxInputPixels;
}

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
    // Transfert de propriété : pas de seconde copie de 55–70 Mo dans le
    // thread principal pendant toute la vie du worker.
    const reply = await this.call(
      {
        id: this.nextId++,
        type: "load",
        weights,
        threads: this.threads,
        tileSide,
        preferGpu,
      },
      [weights],
    );
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
    this.weights = new Uint8Array(weights);
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
let activeSource: ModelSource | null = null;
/** Dernière configuration qui a fonctionné : essayée en premier ensuite. */
let preferredPlan: string | null = null;

export function loadedModel(): AiModelInfo | null {
  return info;
}

export function disposeModel(): void {
  engine?.dispose();
  engine = null;
  info = null;
  activeSource = null;
}

function disposeEngineOnly(): void {
  engine?.dispose();
  engine = null;
  info = null;
}

interface EnginePlan {
  key: string;
  label: string;
  make: () => Engine;
}

function makeQualificationPattern(width: number, height: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      rgba[i] = Math.round((x / Math.max(1, width - 1)) * 220 + 20);
      rgba[i + 1] = Math.round((y / Math.max(1, height - 1)) * 210 + 25);
      rgba[i + 2] = ((x >> 2) + (y >> 2)) % 2 ? 210 : 45;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

function validateQualificationResult(
  result: TileResult,
  width: number,
  height: number,
  scale: number,
): void {
  const expectedWidth = Math.max(1, Math.round(width * scale));
  const expectedHeight = Math.max(1, Math.round(height * scale));
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
  const meanChannelDifference = channelDifference / Math.max(1, samples * 2);

  if (!Number.isFinite(mean) || !Number.isFinite(variance)) {
    throw new Error("Auto-test pixels : valeurs de sortie invalides.");
  }
  if (variance < 2 || meanChannelDifference < 0.5) {
    throw new Error(
      "Auto-test pixels : le modèle produit une sortie quasi constante ou sans réponse couleur.",
    );
  }
}

async function qualifyEngine(
  candidate: Engine,
  meta: ModelMeta,
  tileSide: number,
): Promise<{
  smokeTestMs: number;
  stressTestMs: number;
  benchmarkTileMs: number;
  estimatedTilesPerSecond: number;
}> {
  const width = meta.fixedWidth ?? Math.min(96, tileSide);
  const height = meta.fixedHeight ?? Math.min(96, tileSide);
  const iterations = isMobileRuntime() ? 3 : 5;
  const timings: number[] = [];
  const stressStarted = performance.now();

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const rgba = makeQualificationPattern(width, height);
    const started = performance.now();
    const result = await candidate.tile(
      rgba,
      width,
      height,
      { x: 0, y: 0, width, height },
    );
    const elapsed = performance.now() - started;
    validateQualificationResult(result, width, height, meta.scale);
    timings.push(elapsed);
  }

  const ordered = [...timings].sort((a, b) => a - b);
  const benchmarkTileMs = ordered[Math.floor(ordered.length / 2)] ?? timings[0] ?? 0;
  const stressTestMs = performance.now() - stressStarted;
  return {
    smokeTestMs: timings[0] ?? stressTestMs,
    stressTestMs,
    benchmarkTileMs,
    estimatedTilesPerSecond: benchmarkTileMs > 0 ? 1000 / benchmarkTileMs : 0,
  };
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

async function getSourceWeights(
  source: ModelSource,
  onProgress?: (ratio: number, label: string) => void,
): Promise<{ weights: ArrayBuffer; fromCache: boolean }> {
  if (source.kind === "file") {
    const weights = await source.file.arrayBuffer();
    return { weights, fromCache: false };
  }

  const cached = await readCachedWeights(source.url);
  if (cached) {
    onProgress?.(0.60, "Modèle chargé depuis le cache local");
    return { weights: cached, fromCache: true };
  }

  const weights = await downloadWeights(source.url, (ratio) =>
    onProgress?.(
      0.04 + ratio * 0.50,
      `Téléchargement du modèle · ${Math.round(ratio * 100)} %`,
    ),
  );
  // Stockage provisoire avant les essais : les fallbacks peuvent relire les
  // poids depuis Cache Storage sans conserver une deuxième copie JS en RAM.
  await storeCachedWeights(source.url, weights);
  return { weights, fromCache: false };
}

async function loadAiModelInternal(
  source: ModelSource,
  onProgress: ((ratio: number, label: string) => void) | undefined,
  preferGpu: boolean,
): Promise<AiModelInfo> {
  onProgress?.(0.04, "Récupération des poids du modèle");
  disposeEngineOnly();

  const failures: string[] = [];
  const tileSide = runtimeTileCore();
  let modelBytes = 0;
  let initialFromCache = false;

  for (const plan of enginePlans()) {
    onProgress?.(
      0.60,
      `Initialisation IA · ${plan.label} · ${preferGpu ? "WebGPU/WASM" : "WASM sécurisé"}`,
    );
    let candidate: Engine | null = null;
    try {
      const acquired = await getSourceWeights(source, onProgress);
      modelBytes = acquired.weights.byteLength;
      initialFromCache = initialFromCache || acquired.fromCache;
      if (modelBytes === 0) throw new Error("Fichier de modèle vide.");

      candidate = plan.make();
      const loaded = await candidate.load(
        acquired.weights,
        tileSide,
        preferGpu,
      );
      onProgress?.(0.82, `Stress-test pixels · ${plan.label}`);
      const qualified = await qualifyEngine(candidate, loaded.meta, tileSide);

      engine = candidate;
      preferredPlan = plan.key;
      activeSource = source;
      info = {
        ...loaded.meta,
        bytes: modelBytes,
        source:
          source.kind === "file"
            ? source.file.name
            : source.label ?? source.url,
        fromCache: initialFromCache,
        execution: candidate.execution,
        threads: loaded.threads,
        qualified: true,
        ...qualified,
      };
      break;
    } catch (reason) {
      candidate?.dispose();
      failures.push(`${plan.label} : ${errorText(reason)}`);
    }
  }

  if (!engine || !info) {
    if (source.kind === "url") await removeCachedWeights(source.url);
    throw new Error(
      "Le modèle n'a pas pu être initialisé. " + failures.join(" | "),
    );
  }

  const details = [
    `x${info.scale}`,
    info.provider.toUpperCase(),
    info.execution === "worker"
      ? `worker${info.threads > 1 ? ` ${info.threads} threads` : ""}`
      : "thread principal",
    `${info.inputLayout}→${info.outputLayout}`,
    `stress ${Math.round(info.stressTestMs)} ms`,
    `~${info.estimatedTilesPerSecond.toFixed(1)} tuiles/s`,
    ...(info.fromCache ? ["cache local"] : []),
  ];
  onProgress?.(1, "Modèle prêt · " + details.join(" · "));
  return info;
}

export async function loadAiModel(
  source: ModelSource,
  onProgress?: (ratio: number, label: string) => void,
): Promise<AiModelInfo> {
  return loadAiModelInternal(source, onProgress, true);
}

async function recoverActiveModelToWasm(
  onProgress?: (label: string) => void,
): Promise<boolean> {
  const source = activeSource;
  if (!source) return false;
  try {
    onProgress?.("WebGPU interrompu · reconstruction du moteur en WASM");
    await loadAiModelInternal(
      source,
      (_ratio, label) => onProgress?.(label),
      false,
    );
    return Boolean(engine && info);
  } catch {
    return false;
  }
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
  options: UpscaleAiOptions = {},
): Promise<HTMLCanvasElement> {
  let active = engine;
  let model = info;
  if (!active || !model) throw new Error("Aucun modèle IA chargé.");

  const width = source.width;
  const height = source.height;
  const budget = aiPerformanceBudget(model);
  if (width * height > AI_MAX_SOURCE_PIXELS) {
    throw new Error(
      `Source trop grande pour l'inférence locale (${(width * height / 1_000_000).toFixed(1)} MP, limite ${(AI_MAX_SOURCE_PIXELS / 1_000_000).toFixed(0)} MP).`,
    );
  }

  const sourceCtx = source.getContext("2d", { willReadFrequently: true });
  if (!sourceCtx) throw new Error("Canvas 2D indisponible pour l'inférence.");

  const nativeWidth = Math.max(1, Math.round(width * model.scale));
  const nativeHeight = Math.max(1, Math.round(height * model.scale));
  let destinationWidth = nativeWidth;
  let destinationHeight = nativeHeight;

  if (options.targetWidth && options.targetHeight) {
    const targetFactor = Math.min(
      1,
      options.targetWidth / nativeWidth,
      options.targetHeight / nativeHeight,
    );
    destinationWidth = Math.max(1, Math.round(nativeWidth * targetFactor));
    destinationHeight = Math.max(1, Math.round(nativeHeight * targetFactor));
  }

  const outputBudget = Math.min(
    options.maxOutputPixels ?? budget.maxOutputPixels,
    budget.maxOutputPixels,
  );
  const projectedPixels = destinationWidth * destinationHeight;
  if (projectedPixels > outputBudget) {
    const shrink = Math.sqrt(outputBudget / projectedPixels);
    destinationWidth = Math.max(1, Math.round(destinationWidth * shrink));
    destinationHeight = Math.max(1, Math.round(destinationHeight * shrink));
  }

  const destination = document.createElement("canvas");
  destination.width = destinationWidth;
  destination.height = destinationHeight;
  const destinationCtx = destination.getContext("2d");
  if (!destinationCtx) throw new Error("Canvas 2D indisponible pour la sortie IA.");
  destinationCtx.imageSmoothingEnabled = true;
  destinationCtx.imageSmoothingQuality = "high";

  const fixedSide =
    model.fixedWidth && model.fixedHeight
      ? Math.min(model.fixedWidth, model.fixedHeight)
      : null;
  const tilePad = fixedSide
    ? Math.max(4, Math.min(TILE_PAD, Math.floor(fixedSide * 0.08)))
    : TILE_PAD;
  const tileCore = fixedSide
    ? Math.max(16, Math.min(runtimeTileCore(), fixedSide - 2 * tilePad))
    : runtimeTileCore();

  const columns = Math.ceil(width / tileCore);
  const rows = Math.ceil(height / tileCore);
  const total = columns * rows;
  const renderScaleX = destinationWidth / width;
  const renderScaleY = destinationHeight / height;
  const directNativeWrite =
    Math.abs(renderScaleX - model.scale) < 0.001 &&
    Math.abs(renderScaleY - model.scale) < 0.001;
  const patchCanvas = document.createElement("canvas");
  let runtimeRecovered = false;
  let done = 0;

  onProgress?.(
    0,
    `IA · ${total} tuiles · sortie intermédiaire ${destinationWidth}×${destinationHeight} · budget ${(outputBudget / 1_000_000).toFixed(1)} MP`,
  );

  for (let ty = 0; ty < rows; ty += 1) {
    for (let tx = 0; tx < columns; tx += 1) {
      throwIfCancelled();
      const coreX = tx * tileCore;
      const coreY = ty * tileCore;
      const startX = Math.max(0, coreX - tilePad);
      const startY = Math.max(0, coreY - tilePad);
      const endX = Math.min(width, coreX + tileCore + tilePad);
      const endY = Math.min(height, coreY + tileCore + tilePad);
      const tileWidth = endX - startX;
      const tileHeight = endY - startY;
      const keep: KeepRect = {
        x: coreX - startX,
        y: coreY - startY,
        width: Math.min(tileCore, width - coreX),
        height: Math.min(tileCore, height - coreY),
      };

      let patch: TileResult;
      try {
        const tile = sourceCtx.getImageData(
          startX,
          startY,
          tileWidth,
          tileHeight,
        );
        patch = await active.tile(tile.data, tileWidth, tileHeight, keep);
      } catch (reason) {
        const canRecover =
          options.allowRuntimeFallback !== false &&
          !runtimeRecovered &&
          model.provider === "webgpu";

        if (canRecover) {
          runtimeRecovered = await recoverActiveModelToWasm((label) =>
            onProgress?.(done / total, label),
          );
          active = engine;
          model = info;
        }

        if (!runtimeRecovered || !active || !model) {
          const detail = errorText(reason);
          throw new Error(
            done === 0
              ? `Ce modèle a refusé la première tuile (${tileWidth}×${tileHeight}) : ${detail}.`
              : `Inférence interrompue à la tuile ${done + 1}/${total} : ${detail}`,
          );
        }

        const retryTile = sourceCtx.getImageData(
          startX,
          startY,
          tileWidth,
          tileHeight,
        );
        patch = await active.tile(
          retryTile.data,
          tileWidth,
          tileHeight,
          keep,
        );
      }

      if (patch.width > 0 && patch.height > 0) {
        const dx0 = Math.round(coreX * renderScaleX);
        const dy0 = Math.round(coreY * renderScaleY);
        const dx1 = Math.round((coreX + keep.width) * renderScaleX);
        const dy1 = Math.round((coreY + keep.height) * renderScaleY);
        const dw = Math.max(1, dx1 - dx0);
        const dh = Math.max(1, dy1 - dy0);

        if (
          directNativeWrite &&
          dw === patch.width &&
          dh === patch.height
        ) {
          destinationCtx.putImageData(
            new ImageData(
              patch.data as Uint8ClampedArray<ArrayBuffer>,
              patch.width,
              patch.height,
            ),
            dx0,
            dy0,
          );
        } else {
          if (
            patchCanvas.width !== patch.width ||
            patchCanvas.height !== patch.height
          ) {
            patchCanvas.width = patch.width;
            patchCanvas.height = patch.height;
          }
          const patchCtx = patchCanvas.getContext("2d");
          if (!patchCtx) throw new Error("Canvas de tuile IA indisponible.");
          patchCtx.putImageData(
            new ImageData(
              patch.data as Uint8ClampedArray<ArrayBuffer>,
              patch.width,
              patch.height,
            ),
            0,
            0,
          );
          destinationCtx.drawImage(
            patchCanvas,
            0,
            0,
            patch.width,
            patch.height,
            dx0,
            dy0,
            dw,
            dh,
          );
        }
      }

      done += 1;
      const unit = model.execution === "worker" ? "worker" : "main";
      onProgress?.(
        done / total,
        `Inférence IA · tuile ${done}/${total} · ${model.provider.toUpperCase()} · ${unit}${runtimeRecovered ? " · repli runtime" : ""}`,
      );
    }
  }

  patchCanvas.width = 1;
  patchCanvas.height = 1;
  return destination;
}
